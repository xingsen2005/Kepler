/**
 * 邮箱验证码（R54 第 ② 步）
 * ============================================================================
 *
 * 本模块是「邮箱验证码」的**唯一实现点**：负责生成、暂存、核销验证码，
 * 并把「发一封带验证码的邮件」这件事收口成一个调用（`sendCode()`）。
 *
 * ## 为什么验证码只活在内存里
 *
 * 它有三个性质：**短命**（10 分钟）、**一次性**、**丢了可以再要一封**。
 * 落盘换不来任何东西，却会引入两个真问题：① `data/` 里的明文验证码文件
 * （本项目所有落盘都要加密，多一个密文文件就多一份要备份 / 迁移的东西）；
 * ② 「进程重启后验证码还在」这个**没人需要**的性质。而本项目是单实例部署
 * （见 `instance-lock.js`），内存态不会被第二个进程读到 —— 前提成立。
 *
 * ## 为什么存的是哈希而不是明文
 *
 * 验证码本身是**凭据**（拿着它 + 用户名就能改密码）。进程内存里留明文，
 * 等于让「一次 core dump / 一段调试输出」变成一次账户接管。哈希是 sha256，
 * 成本可以忽略；核销时对提交值同样取哈希再比对。
 *
 * ## 三条不可省的闸门
 *
 * ① **重发冷却**（`EMAIL_CODE_RESEND_MS`）：否则本站就成了一个「给任意邮箱发信」
 *    的工具，而 SMTP 服务器的发信配额会被一次点击风暴刷光；
 * ② **尝试次数上限**（`EMAIL_CODE_MAX_ATTEMPTS`）：6 位码有 10^6 种可能，
 *    不限次就能被穷举；⚠️ 用满即**作废**而不是「锁定」—— 后者等于把
 *    「故意错 5 次」变成一个**锁死别人重置入口**的攻击手法；
 * ③ **过期即删**（`EMAIL_CODE_TTL_MS`）：惰性清扫 + 硬上限，内存有界。
 */
const crypto = require('crypto');
const configStore = require('./config-store');
const smtp = require('./smtp');
const {
  EMAIL_CODE_LEN, EMAIL_CODE_TTL_MS, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_MS,
} = require('./limits');

/**
 * 验证码的用途。
 *
 * 两个用途**必须分开存**，不能只按邮箱存一份：否则用户点「修改邮箱」拿到一个码，
 * 转头把它填进「忘记密码」也成立 —— 而这两件事的信任前提完全不同
 * （前者是「已登录的人在证明自己拥有新邮箱」，后者是「没登录的人在要回账户」）。
 */
const CODE_PURPOSES = ['verify', 'reset'];

/** 键 = `${purpose}|${email}` */
const codes = new Map();

/**
 * 内存硬上限。
 *
 * 键的空间是「用途 × 邮箱」，而邮箱来自匿名可达的接口 —— 不设上限的话，
 * 攻击者可以用 10 万个不同邮箱把进程内存撑爆（每条记录约 100 字节 +
 * Map 开销）。到顶后按**最早过期**淘汰：那批本来也快失效了。
 */
const MAX_ENTRIES = 1000;

/**
 * 验证码的存储键。
 *
 * ⚠️ 名字**刻意不叫 `keyOf`**：`tests/invariants.test.js` 用 `keyOf(` 这个字面量
 * 扫描全库，断言「凡是构造列表缓存键的地方，首参必须是 `bucketCacheKey(cfg)`」
 * （R47 的桶隔离判据）。那是一条对本模块毫无关系、但被名字误伤的护栏 ——
 * 改护栏去放行等于给它开一个洞，所以这里换个名字，护栏一个字不动。
 */
function codeKey(purpose, email) {
  return `${purpose}|${email}`;
}

/** 验证码的存储形态：sha256 十六进制（绝不落明文） */
function hashOf(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * 定长十六进制串的常数时间比较。
 *
 * 用 `crypto.timingSafeEqual` 而不是 `===`：两者都是 64 字符的 hex，
 * 长度恒等，所以 timingSafeEqual 不会抛「长度不一致」。用 `===` 的话，
 * 比较会在第一个不同的字符处提前返回 —— 虽然实践上无法据此还原 sha256，
 * 但这是本项目处理凭据比对的既有纪律（见 `config-store.constTimeEquals`）。
 */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * 生成 `EMAIL_CODE_LEN` 位十进制验证码。
 *
 * 用 `crypto.randomInt` 而不是 `Math.random`：后者是可预测的伪随机数
 * （V8 的 xorshift128+，观察到若干输出即可反推内部状态），而验证码就是凭据。
 */
function generateCode() {
  let out = '';
  for (let i = 0; i < EMAIL_CODE_LEN; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

/** 惰性清扫：删掉已过期的条目（每次读写前调用，保证 Map 不会只增不减） */
function sweep(t) {
  const now = t || Date.now();
  for (const [k, v] of codes) {
    if (v.expiresAt <= now) codes.delete(k);
  }
}

/** 到顶时淘汰「最早过期」的那一条（它本来就是最快失效的） */
function evictIfNeeded() {
  if (codes.size < MAX_ENTRIES) return;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [k, v] of codes) {
    if (v.expiresAt < oldestAt) { oldestAt = v.expiresAt; oldestKey = k; }
  }
  if (oldestKey) codes.delete(oldestKey);
}

/**
 * 签发一个验证码。
 *
 * @returns {{ok:true, code:string}|{ok:false, retryAfter:number}}
 *   `retryAfter` 只在重发冷却未过时出现（单位秒，供路由写 `Retry-After`）。
 *
 * ⚠️ 返回值里带 `code` 是**刻意的**：调用方（路由）要把明文放进邮件正文。
 * 明文只在这一次调用里存在，存进 Map 的只有哈希 —— 所以「读过一次日志 / 转储」
 * 拿不到任何还活着的验证码。
 */
function issue({ purpose, email }) {
  if (!CODE_PURPOSES.includes(purpose)) throw new Error(`未知的验证码用途：${purpose}`);
  const key = codeKey(purpose, email);
  const now = Date.now();
  sweep(now);

  const prev = codes.get(key);
  if (prev) {
    const left = EMAIL_CODE_RESEND_MS - (now - prev.sentAt);
    if (left > 0) return { ok: false, retryAfter: Math.ceil(left / 1000) };
  }

  const code = generateCode();
  evictIfNeeded();
  codes.set(key, {
    hash: hashOf(code),
    expiresAt: now + EMAIL_CODE_TTL_MS,
    attempts: 0,
    sentAt: now,
  });
  return { ok: true, code };
}

/**
 * 核销一个验证码（**不改动任何持久状态** —— 改密码 / 改邮箱由调用方在成功的分支里做）。
 *
 * @returns {{ok:true}|{ok:false, reason:string}}
 *   reason ∈ `not_found`（从未签发 / 已过期 / 已用掉）| `too_many`（尝试次数用尽）| `mismatch`
 */
function check({ purpose, email, code }) {
  const key = codeKey(purpose, email);
  const now = Date.now();
  sweep(now);

  const rec = codes.get(key);
  if (!rec) return { ok: false, reason: 'not_found' };

  /**
   * 尝试次数用尽 ⇒ **作废**。
   *
   * ⚠️ 刻意**不删记录**（只在 TTL 清扫时自然消失），两个理由：
   *  ① 删掉就等于连 `sentAt` 一起抹掉，重发冷却随之失效 —— 攻击者每试错 5 次
   *     就能立刻要一封新码，把"冷却"这道闸门整个绕过；
   *  ② 记录留着才能把三种失败区分开：`not_found` = 从未签发 / 已过期 / 已核销，
   *     `too_many` = 签发过但已被试错用尽。
   *
   * 只作废、不"锁定"是另一件事：做成"锁定 x 分钟"会让「故意错 5 次」变成一种
   * **拒绝服务**手段（把本该能重置密码的人挡在门外）。作废只是让**这一轮**作废。
   */
  if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many' };
  }

  if (!sameHash(rec.hash, hashOf(code))) {
    rec.attempts += 1;
    if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'too_many' };
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

/** 用掉（成功后调用）：让验证码一次性 —— 同一个码不能改两次密码 / 绑两次邮箱 */
function consume({ purpose, email }) {
  codes.delete(codeKey(purpose, email));
}

/** 发送失败时回滚：把条目彻底删掉，连重发冷却一起 —— 用户没收到信，不该被冷却挡住 */
function rollback({ purpose, email }) {
  codes.delete(codeKey(purpose, email));
}

/** 供测试 / 运维观察内存是否有界 */
function size() { return codes.size; }

/** 供测试使用 */
function clear() { codes.clear(); }

/**
 * 面向用户的文案（唯一实现点）。
 *
 * 三种失败原因对**用户**只说一句「验证码不正确或已过期」：区分它们只会告诉
 * 攻击者「这个邮箱上确实签发过验证码」（`not_found` 与 `mismatch` 的差异就是
 * 一个邮箱是否绑定过的 oracle）。差异只进服务端日志。
 */
const CODE_FAIL_TEXT = '验证码不正确或已过期，请重新获取';

/** 发一封带验证码的邮件（**唯一实现点**：SMTP 配置、站点名称、文案都只在这里拼一次） */
async function sendCodeMail({ purpose, email, username, code }) {
  /**
   * ⚠️ 取配置必须用 `smtpSendConfig()`（含明文口令的内部读），**不能**用「对外视图」——
   * 视图为了保密把口令裁成 `hasPassword` 布尔值，拿它发信 ⇒ 口令恒为空 ⇒
   * `smtp.validateForSend()` 判 400「已填写登录用户名但密码为空」，于是
   * **只要管理员填了登录用户名（真实 SMTP 几乎都要认证），系统邮件一封也发不出去**；
   * 而管理员手点的「发送测试邮件」走内部读、照样成功 —— 两者表现相反。
   */
  const cfg = configStore.smtpSendConfig();
  if (!cfg.configured) {
    throw Object.assign(new Error(
      '系统尚未配置发信（SMTP），无法发送邮件。请联系管理员在「系统设置 → 发信设置」中完成配置。',
    ), { status: 503 });
  }
  /**
   * 「发信设置」卡片上的启用开关（R55 追加）。
   *
   * 停用 = **系统自动发信一律不发** —— 验证码 / 重置密码这类信是服务端自己触发的，
   * 管理员关掉开关要停的正是它们。闸门放在这里而不是 `smtpConfigured()`：
   *
   *  · `smtpConfigured()` 还管着「界面显示已配置 / 未配置」与 `routes/smtp.js` 的
   *    管理员测试邮件，而 R53 已定**测试邮件不受开关限制**（它是管理员手动触发的
   *    一次性动作；若受限制就关掉了「先配好、再验证」的窗口）；
   *  · 把 `enabled` 折进那个判据会让卡片在停用后显示成「未配置」—— 配置明明还在。
   *
   * 两处调用方的表现刻意不同（与既有口径一致）：`/auth/forgot` 的 catch 只记日志、
   * 响应**恒真**（它是匿名可达的，回不同的体就等于一条账户存在性 oracle）；
   * `/auth/email/code` 需登录、且用户提交的是自己的新地址，故**如实回 503**。
   */
  if (!cfg.enabled) {
    throw Object.assign(new Error(
      '系统发信已由管理员停用（系统设置 → 发信设置 → 启用发信功能），暂时无法发送邮件。',
    ), { status: 503 });
  }
  const siteName = configStore.siteView(configStore.load()).siteName;
  const title = purpose === 'reset' ? '重置密码' : '验证邮箱';
  const subject = `${siteName} ${title}验证码`;
  const who = username ? `账户「${username}」` : '您的账户';
  const text = [
    `您正在为${who}${title}。`,
    '',
    `验证码：${code}`,
    '',
    `有效期 ${Math.round(EMAIL_CODE_TTL_MS / 60000)} 分钟，请勿转告他人。`,
    '如果这不是您本人的操作，请忽略本邮件（您的账户不会因此受到影响）。',
    '',
    `—— ${siteName}`,
    '',
  ].join('\n');
  await smtp.sendMail({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    user: cfg.user, password: cfg.password,
    from: cfg.from,
    fromName: cfg.fromName || siteName, // R54①：SMTP 卡片优先，留空才退回站点名称
    to: email,
    subject,
    text,
  });
}

/**
 * 一步到位：签发 + 发信（**路由层唯一需要调用的入口**）。
 *
 * ⚠️ 顺序是「先签发、后发信、失败即回滚」。反过来（先发信再落码）需要一个
 * 只在邮件里存在的明文码被回传，反而更绕；而回滚保证了「发信失败 ⇒ 该邮箱
 * 上没有任何半活着状态」—— 否则用户重试会被自己的冷却挡住，只能干等 60 秒。
 *
 * @returns {Promise<{ok:true, to:string}|{ok:false, retryAfter:number}>}
 */
async function sendCode({ purpose, email, username }) {
  const r = issue({ purpose, email });
  if (!r.ok) return r;
  try {
    await sendCodeMail({ purpose, email, username, code: r.code });
  } catch (e) {
    rollback({ purpose, email });
    throw e;
  }
  return { ok: true, to: email };
}

module.exports = {
  CODE_PURPOSES, CODE_FAIL_TEXT, EMAIL_CODE_LEN,
  generateCode, issue, check, consume, rollback,
  sendCode, sendCodeMail,
  size, clear,
};
