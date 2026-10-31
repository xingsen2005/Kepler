/**
 * 路由：登录认证（登录 / 登出 / 会话探测 / 系统初始化）
 *  — 唯一允许匿名访问的路由组（见 index.js 的 PUBLIC_API 白名单）
 *
 * 登录采用**两步式**设计，以便在密码正确之后、签发会话之前插入 Windows Hello 校验：
 *
 *   第一步 POST /auth/login       { username, password, captchaToken }
 *        · 人机验证（reCAPTCHA / Turnstile，开启时）
 *        · 密码校验
 *        · 若该用户启用了 Windows Hello → 返回 { ok:false, webauthnRequired:true, challenge }
 *          （此时**尚未签发会话**，服务端仅记录一个待校验挑战）
 *        · 未启用 → 直接签发会话（原有行为 100% 不变）
 *
 *   第二步 POST /auth/login/webauthn { username, challenge, clientDataJSON, authenticatorData, signature, rawId }
 *        · 校验 ES256 签名（Node 内置 crypto，零依赖）
 *        · 通过后才签发会话
 *
 * 与验证码共存：验证码属第一步、Windows Hello 属第二步，串联而非互斥，同时开启均生效。
 */
const { express, security, configStore, statsStore, authSession, captcha, webauthn, emailCode, inviteStore } = require('./_context');
const { sessionCookie, clearCookie, webauthnContext } = require('./_shared');
// R54②：邮箱的归一化 / 入参判据（`normalizeEmail` 也是 `config-store` 落盘兜底用的同一个）
// 重发冷却同时要回给前端（据它做倒计时），所以常量也一并取过来，避免两处各写一个数
const { normalizeEmail, parseEmailInput, EMAIL_CODE_RESEND_MS } = require('../limits');
// R54③：邀请码的入参判据（**只判格式**，核销由 `inviteStore.consume` 负责）
const { parseInviteCodeInput } = require('../limits');
// R71：角色标签的唯一映射点（初始化 / 注册的审计日志里要写「根用户」而不是 `root`）
const roles = require('../roles');
// R69：首次初始化的「安装令牌」需要落盘（0600）与恒定时比较
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/**
 * R98：注销申请的冷静期。登录成功是"撤销注销"的**唯一自动入口**，
 * 因此这里必须能拿到"真正删除一个账户"的实现（到期未清扫时由登录路径执行）。
 * 政策（15 天）与清理动作都在 `account-deletion.js`，本模块不自己算日期。
 */
const accountDeletion = require('../account-deletion');

const router = express.Router();

/**
 * R94（审核 M03-04）：本站允许的域名集合 —— 供人机验证核对服务商应答里的 `hostname`。
 *
 * 取两处并集：本次请求的 `Host`（用户实际访问的域名）与 `SITE_DOMAIN`（部署脚本写入的
 * 对外域名）。两者都属 `security.isOwnSiteHost()` 认的「本站」，故任一命中即放行；
 * 而一枚在**别的域名**上解出的 token 两处都不匹配 —— 那正是要拦下的情况
 * （同一枚 sitekey 被多个站点共用是服务商官方支持的常见做法）。
 */
function captchaHosts(req) {
  const out = [];
  const add = (v) => {
    const s = security.normalizeHost(v);
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  add(req && req.headers && req.headers.host);
  add(security.SITE_DOMAIN);
  return out;
}

/**
 * 登录失败锁定的键（SEC-02 / R27-08）
 *
 * 旧实现**只按用户名**锁定：任何人只要知道管理员的用户名，连着输错 5 次密码
 * 就能把管理员本人锁在外面最长 30 分钟 —— 锁定被反向用作 DoS 工具，
 * 而且攻击者自己只受"每 IP 每分钟 10 次"的限流约束，成本极低。
 *
 * 锁定键必须带上**攻击者控制不了**的维度（来源 IP）：这样失败计数只对
 * 「这个 IP 试探这个账户」累积，管理员从自己的机器照常登录。
 * 分布式暴破由 loginLimiter（按 IP 限流）负责 —— 限流键才是纯 IP。
 *
 * R27-08：用户名必须**规范化后再入键**。`config-store.authenticateUser()` 是按
 * `toLowerCase()` 匹配的（大小写不敏感），而这里原样拼提交值、`completeLogin()`
 * 却用库里的规范名去清零 —— 两个后果：① 攻击者轮换大小写（`admin`/`Admin`/`ADMIN`…）
 * 就能让每个拼写各拿 5 次预算与独立的指数锁定，账户锁定形同虚设（只剩按 IP 的
 * 每秒级限流）；② 以不同大小写成功登录永远清不掉那个键的计数，它会一路升级到上限。
 */
function loginLockKey(ip, username) {
  return `${ip}|${String(username == null ? '' : username).trim().toLowerCase()}`;
}

/** 两步登录共用的前置检查：限流 + 账户锁定 + 跨 IP 低速。返回 null 表示可继续 */
async function precheckLogin(req, res, username) {
  const ip = security.clientIp(req);
  const rl = security.loginLimiter(ip);
  if (!rl.ok) {
    statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录过于频繁已限流（IP：${ip}）` });
    res.setHeader('Retry-After', String(rl.retryAfter));
    res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
    return null;
  }
  const lockKey = loginLockKey(ip, username);
  const lockedLeft = security.loginLock.locked(lockKey);
  if (lockedLeft > 0) {
    statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `账户「${username}」在该来源已被临时锁定（IP：${ip}，剩余 ${lockedLeft} 秒）` });
    res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${lockedLeft} 秒后重试` });
    return null;
  }
  /**
   * R69：跨 IP 的账户维度减速（见 `security.accountFailDelayMs`）。
   * 分布式暴破每个 IP 各拿一份预算，只有"按用户名"的维度能看见它；
   * 这里只拖慢、不封禁，所以受害者最多多等 1.5 秒，不会被人锁在门外。
   */
  const delay = security.accountFailDelayMs(username);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return { ip, lockKey };
}

/**
 * 登录成功：签发会话并回写 Cookie
 * @param {boolean} [remember] 勾选「记住登录状态」→ 会话有效期 30 天（否则 24 小时）
 * @param {string} [ip] 来源 IP；用于清除**该来源**的失败计数（SEC-02）
 */
function completeLogin(res, user, remember, ip) {
  security.loginLock.reset(loginLockKey(ip || '', user.username));
  security.resetAccountFail(user.username); // R69：成功一次即清掉跨 IP 累计
  /**
   * R98：注销冷静期的**唯一自动撤销点**。
   *
   * 产品口径是「提交申请后 15 天自动删除，期间再次登录即可立即撤销」。放在这里而不是
   * 放在登录页 / 前端，是因为"登录成功"是一个**服务端事实**：不论走密码、走 Windows
   * Hello、还是将来多一种二次验证，只要真正通过了，就必须撤销 —— 否则同一次登录
   * 在两条路径上会有两种结果（一条撤销、一条不撤销），而用户完全看不出来。
   *
   * 两种分支：
   *  ① **未到期** ⇒ 撤销申请，并在响应里带 `deletionCancelled`，让界面如实告知
   *     （"你的注销申请已撤销"必须被说出来，否则用户会以为账户仍将被删除）；
   *  ② **已到期** ⇒ 不再撤销，**当场执行删除**。清扫器每小时才跑一次，若这里放行，
   *     就会出现"过了 15 天还能靠登录续命"的窗口 —— 那与承诺的"自动删除"不符。
   *     删除失败（例如库里只剩这一个管理员）时不签发会话：账户已处于"应删"状态，
   *     让它继续可用比拒绝登录更危险。
   */
  let deletionCancelled = false;
  let view = user;
  if (user && user.deletion) {
    if (Date.parse(user.deletion.deleteAt) <= Date.now()) {
      try {
        accountDeletion.purgeUser(user.id, '注销申请到期，已自动删除');
        statsStore.addLog({
          action: 'users.delete', level: 'warn',
          detail: `账户「${user.username}」的注销申请已到期，登录时执行删除（清扫器尚未跑到）`,
        });
        return res.status(403).json({ error: '该账户已注销', deleted: true });
      } catch (e) {
        statsStore.addLog({
          action: 'users.delete', level: 'error',
          detail: `账户「${user.username}」到期注销失败：${e.message}`,
        });
        return res.status(403).json({ error: '该账户已申请注销，且注销未能完成，请联系管理员' });
      }
    }
    deletionCancelled = configStore.cancelAccountDeletion(user.id);
    if (deletionCancelled) {
      const raw = configStore.findUserRawById(user.id);
      view = raw ? configStore.userView(raw) : user;
      statsStore.addLog({
        action: 'users.deletion.cancel', level: 'warn',
        detail: `用户「${user.username}」登录成功，注销申请已自动撤销`,
      });
    }
  }
  const token = authSession.createSession(user, { remember: !!remember });
  res.setHeader('Set-Cookie', sessionCookie(token));
  statsStore.addLog({
    action: 'auth.login',
    detail: `用户「${user.username}」登录成功${remember ? '（已勾选记住登录状态，有效期 30 天）' : ''}`,
  });
  return res.json({ ok: true, user: view, deletionCancelled });
}

// 登录第一步：校验人机验证与密码；启用 Windows Hello 时返回挑战而不签发会话
router.post('/auth/login', async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');

    const pre = await precheckLogin(req, res, username);
    if (!pre) return;

    // 人机验证（服务端回源校验；关闭时直接放行，不引入任何额外校验/依赖）
    // token 从 body.captchaToken 取（前端由 reCAPTCHA/Turnstile 组件产出），不信任前端自带的结果。
    // R94（审核 M03-04）：带上「本站允许的域名」，让 captcha.verify 核对服务商应答里的
    // `hostname` —— 否则同一枚 sitekey 在别的域名上解出的 token 也能过本站的人机验证。
    const cap = await captcha.verify({
      token: b.captchaToken, remoteip: pre.ip, expectedHosts: captchaHosts(req),
    }, configStore);
    if (!cap.passed) {
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录被人机验证拦截（原因：${cap.reason}，用户名：${username || '(空)'}）` });
      return res.status(403).json({ error: captcha.publicReason(cap.reason) });
    }
    if (cap.degraded) {
      statsStore.addLog({ action: 'auth.captcha.degraded', level: 'warn', detail: `人机验证服务异常已按降级策略放行（原因：${cap.reason}，用户名：${username}）` });
    }

    const user = await configStore.authenticateUser(username, password);
    if (!user) {
      const left = security.loginLock.fail(pre.lockKey);
      security.noteAccountFail(username); // R69：跨 IP 的账户维度计数（只减速，见 precheckLogin）
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录失败（用户名：${username || '(空)'}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    /**
     * R33：账户封禁。
     *
     * 位置很关键 —— 必须**在密码校验通过之后**：若在校验之前按用户名判封禁，
     * 登录接口的响应差异本身就成了**用户名枚举**通道（"存在且被封"与"不存在"
     * 报文不同），而这一步之前的失败分支（`401 用户名或密码错误` + 空转哈希）
     * 正是为了抹平这种差异而存在的。
     *
     * 顺序：先验密码 → 再看封禁 → 最后才决定走 Windows Hello 还是直接签发会话。
     * 若把封禁判定放到 Hello 分支之后，被封者会被先要求做一次本机验证才被告知
     * 「你已被封禁」，既多余又容易被误解为"验证失败"。
     *
     * 响应刻意带上 `reason` / `until`，供登录页显示封禁原因与解封时间（需求 5）。
     * 用 403（凭据没错，但无权进入）而非 401，并且**不**计入失败锁定 ——
     * 凭据正确却因封禁被拒不该把账户推向锁定，否则管理员刚解封又进不来。
     */
    const raw = configStore.findUserRawById(user.id);
    const ban = configStore.banInfo(raw);
    if (ban.active) {
      statsStore.addLog({
        action: 'auth.fail', level: 'warn',
        detail: `被封禁的账户尝试登录（用户名：${user.username}；解封时间：${ban.until || '永久'}）`,
      });
      return res.status(403).json({
        error: '该账户已被封禁',
        banned: true,
        reason: ban.reason,
        until: ban.until,
      });
    }

    // 密码正确：若该用户启用了 Windows Hello，先不签发会话，要求第二步验签
    //
    // ⚠️ 必须用**原始用户记录**判断，不能用 authenticateUser 的返回值：
    //    后者是 userView（安全视图），不含 webauthn 字段，用它判断会恒为「未启用」，
    //    从而静默绕过整个 Windows Hello 二次验证 —— 这是一个高危的失效开放（fail-open）。
    if (configStore.isWebauthnEnabled(raw)) {
      const ctx = webauthnContext(req);
      /**
       * R94（审核 M01-05）：「记住登录状态」必须**由服务端记住**。
       *
       * 旧实现把它随响应回给前端、第二步再让前端原样回传 —— 服务端对这个用户可见的
       * 安全选项没有任何约束力，脚本可以静默把会话续到 30 天。现在随挑战一起存进
       * 服务端（挑战一次性、5 分钟过期、带归属用户），第二步只认这一份。
       */
      const challenge = webauthn.issueChallenge('login', { userId: user.id, username: user.username, remember: Boolean(b.remember) });
      statsStore.addLog({ action: 'auth.login.webauthn', detail: `用户「${user.username}」密码校验通过，等待 Windows Hello 验证` });
      return res.json({
        ok: false,
        webauthnRequired: true,
        challenge,
        rpId: ctx.rpId,
        timeout: webauthn.CHALLENGE_TTL_MS,
        username: user.username,
        // 第二步是独立请求，需把「记住登录状态」带给前端，由它原样回传
        remember: Boolean(b.remember),
        // 提示前端只允许该账户登记过的凭据（浏览器仍按 allowCredentials 过滤）
        credentialId: configStore.getWebauthn(raw).credentialId,
      });
    }

    // 未启用二次验证：直接签发会话（remember 取本请求提交的值）
    return completeLogin(res, user, Boolean(b.remember), pre.ip);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 登录第二步：校验 Windows Hello 断言，通过后签发会话
router.post('/auth/login/webauthn', async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();

    const pre = await precheckLogin(req, res, username);
    if (!pre) return;

    /**
     * R24-02：**在与用户名无关的位置先判宿主机是否可信**。
     *
     * 若把这个判断放到 `findUserRaw` / `isWebauthnEnabled` 之后，「用户存在**且**启用了
     * Windows Hello」会回 403、其余用户名回 401 —— 等于给这个匿名可达的端点又开一个
     * 用户名 oracle（R21-05 / R22-01 刚把三条分支收敛成同形，不能从旁边再漏一条）。
     * 因此在这里一次性拦下，三支的 401 同形语义保持不变。
     */
    let ctx;
    try {
      ctx = webauthnContext(req);
    } catch (e) {
      statsStore.addLog({
        action: 'auth.fail', level: 'warn',
        detail: `Windows Hello 拒绝：${e.message}（Host 不属本站，已按 fail-closed 处理）`,
      });
      return res.status(e.status || 403).json({ error: e.message });
    }

    /**
     * R21-05：三条「进不去」的分支必须**完全同形**（同状态码 + 同文案 + 同计数）。
     *
     * 旧实现里「用户不存在」回 `401 Windows Hello 验证失败，请重试`，而
     * 「用户存在但未启用 Windows Hello」回 `400 该账户未启用 Windows Hello，请使用密码登录`
     * —— 状态码与文案都不同，于是本端点（在 `PUBLIC_API` 白名单内，匿名可达）成了一个
     * **不需要密码的用户名 oracle**：先用它枚举出有效用户名，再拿这些用户名去撞库 / 社工。
     *
     * 登录第一步 `/auth/login` 在这点上是正确的（用户不存在与密码错误返回同一条 401 文案），
     * 这里向它对齐。`precheckLogin` 的 IP 级限流与 `ip|username` 冻结照常生效，
     * 枚举速率与撞库速率完全相同（本端点的限流此前对「未启用」分支是**不计数**的，
     * 等于给枚举留了一条不限速的支路）。
     */
    const authFail = (detail) => {
      const left = security.loginLock.fail(pre.lockKey);
      security.noteAccountFail(username); // R69：跨 IP 的账户维度计数（只减速，见 precheckLogin）
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `Windows Hello 登录失败：${detail}（用户名：${username || '(空)'}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: 'Windows Hello 验证失败，请重试' });
    };

    const raw = configStore.findUserRaw(username);
    if (!raw) return authFail('用户不存在');
    if (!configStore.isWebauthnEnabled(raw)) return authFail('该账户未启用 Windows Hello');

    /**
     * R33：封禁判定在这一支必须**与上面两支完全同形**（都走 `authFail`），
     * 绝不能回一条带封禁原因的 403 —— 本端点在 `PUBLIC_API` 白名单内、匿名可达，
     * 那样等于重新开一个「该用户名存在**且**被封禁」的 oracle，把 R21-05 / R22-01
     * 刚刚收敛掉的三支同形又漏掉一条。
     *
     * 走到这里意味着挑战是在**封禁之前**签发的（否则第一步已经 403 并附上原因），
     * 属于极窄的时序窗口；被封者想看原因，回第一步即可。
     */
    if (configStore.banInfo(raw).active) return authFail('该账户已被封禁');

    const cred = configStore.getWebauthn(raw);
    // R24-02：`ctx` 已在入口处解析（那时与用户名无关），此处直接复用 —— 不要再解析一次

    const r = webauthn.verifyAuthentication({
      clientDataJSON: b.clientDataJSON,
      authenticatorData: b.authenticatorData,
      signature: b.signature,
      rawId: b.rawId,
      expectedChallenge: String(b.challenge || ''),
      expectedUserId: raw.id, // SEC-11：挑战必须是为该账户签发的
      expectedOrigin: ctx.origin,
      rpId: ctx.rpId,
      publicKey: cred.publicKey,
      storedCredentialId: cred.credentialId,
      storedSignCount: cred.signCount,
    });

    if (!r.ok) {
      /**
       * R22-01：这一支**必须与前两支同形** —— 它是 R21-05 收敛时唯一漏掉的一支。
       *
       * 旧实现回 `401 { error: webauthn.publicReason(r.reason), reason: r.reason }`：
       * 多了一个 `reason` 键、文案也换成了「挑战缺失 / 挑战已过期 / 签名校验失败 …」
       * 这类**细节文案**，与 `authFail()` 的固定 `401 { error: 'Windows Hello 验证失败，请重试' }`
       * 在**状态码之外的文案与键集两处都不同形**。
       *
       * 而这一支的**可达前提**恰好是「用户名存在 **且** 已启用 Windows Hello」——
       * 攻击者提交 `{ username }` 单字段（`b.challenge` 为空串即可）就能命中
       * `challenge_missing` 走完这一支，于是它成了一个「用户名是否存在且启用了二次验证」
       * 的匿名 oracle（通常指管理员账户），比 R21-05 修的「是否启用」更精确。
       *
       * `r.reason` 只进服务端日志（排查要它），**绝不进响应体** —— 同 R21-05 的纪律：
       * 「进不去」的所有分支对匿名者必须完全不可区分。
       */
      return authFail(`验签失败（${r.reason}）`);
    }

    // 验签通过：更新签名计数（单调递增，供克隆检测）并签发会话
    const user = configStore.touchWebauthn(raw.id, r.signCount);
    statsStore.addLog({ action: 'auth.login.webauthn.ok', detail: `用户「${username}」Windows Hello 验证通过` });
    // R94（审核 M01-05）：用**挑战里记下的** remember，不再采信第二步请求体里的值
    return completeLogin(res, user, Boolean(r.remember), pre.ip);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 登出：销毁会话并清除 Cookie
router.post('/auth/logout', (req, res) => {
  const token = authSession.parseToken(req);
  const name = (req.authUser && req.authUser.username) || '';
  authSession.destroySession(token);
  res.setHeader('Set-Cookie', clearCookie());
  statsStore.addLog({ action: 'auth.logout', detail: `用户「${name}」登出` });
  res.json({ ok: true });
});

// 强制登出当前用户在所有设备上的会话（S11）
router.post('/auth/logout-all', (req, res) => {
  const u = req.authUser;
  const n = u ? authSession.destroyUserSessions(u.id) : 0;
  authSession.destroySession(authSession.parseToken(req));
  res.setHeader('Set-Cookie', clearCookie());
  statsStore.addLog({ action: 'auth.logout', level: 'warn', detail: `用户「${(u && u.username) || ''}」强制登出全部设备（${n} 个会话）` });
  res.json({ ok: true, sessions: n });
});

// 当前登录用户信息（匿名可访问：用于前端探测登录态与初始化状态）
//  - 已登录  -> { ok: true, user }
//  - 未初始化 -> { ok: true, user: null, initialized: false }（引导创建管理员）
//  - 未登录   -> { ok: true, user: null, initialized: true }
router.get('/auth/me', (req, res) => {
  const token = authSession.parseToken(req);
  const session = token ? authSession.getSession(token) : null;
  if (session) {
    // SEC-13：`session.user` 是**登录那一刻的快照**（含 role）。
    // 管理员把某人降权 / 删除后，旧快照会让前端继续按旧角色渲染到下次登录为止。
    // 接口层的鉴权早就用实时记录（所以不会真越权），这里让 UI 与真实权限对齐。
    // 用户已被删除则视为未登录 —— 会话必须立即失效。
    //
    // ⚠️ 用户 id 在 `session.user.id` 上，**没有** `session.userId` 这个字段。
    //    早期这里写成 `session.userId`，取值恒为 undefined → findUserRawById 返回 null
    //    → 判定"用户已不存在"→ 每次调用都销毁会话。表现为：登录后一刷新页面就掉线
    //    （刷新才会重新走 /auth/me）。已加测试护栏（tests/auth-session.test.js）。
    const raw = configStore.findUserRawById(session.user && session.user.id);
    if (!raw) {
      authSession.destroySession(token);
      const initialized = configStore.listUsers().length > 0;
      return res.json({ ok: true, user: null, initialized });
    }
    return res.json({ ok: true, user: configStore.userView(raw) });
  }
  const initialized = configStore.listUsers().length > 0;
  if (!initialized) {
    // R69：部署模式下首次初始化需要安装令牌 —— 顺手在这里生成并打印（前端此刻正好在等这个响应）
    return res.json({
      ok: true, user: null, initialized,
      setupTokenRequired: setupTokenRequired(),
      setupHint: setupTokenHint(),
    });
  }
  res.json({ ok: true, user: null, initialized });
});

// 初始化首个管理员（仅当系统尚无任何用户时允许；之后一律拒绝）
//
// SEC-13：必须加**进程内互斥**。旧实现只检查 `listUsers().length > 0`，
// 而检查与写入之间隔着一次异步/较慢的 scrypt，两个并发请求可能同时通过检查、
// 各自创建一个管理员（新建实例的抢先初始化窗口）。另加 IP 限流，
// 避免被用来反复触发代价较高的口令哈希计算（SEC-05 同类风险）。
let initInFlight = false;

/* ==================== R69：首次初始化的「安装令牌」 ==================== */

/**
 * 部署模式下「第一个管理员」为什么必须出示令牌。
 *
 * `/auth/init` 是匿名可达的（它在 `PUBLIC_API` 白名单里，否则全新实例无法起步），
 * 而它的唯一门禁曾经只是「还没有任何用户」+ 10 次/10 分钟的 IP 限流。按项目自己的
 * 部署路径（Docker `HOST=0.0.0.0` + Nginx + 域名），实例从进程启动到所有者第一次
 * 打开页面之间就存在一个**任何人都能创建管理员**的窗口；被抢先后所有者被永久挡在
 * 门外（只能删 `data/` 重来），而攻击者拿到的是完整管理员权限。
 *
 * 本机模式（`HOST` 为回环，`IS_DEPLOY=false`）不要求令牌：那个形态下能访问
 * `/auth/init` 的本来就是本机进程，加一档只会让「解压即用」变成「先翻日志」。
 *
 * 令牌在**第一次真正需要它的时候**生成（前端探活 / 首次初始化请求），这样
 * 全新实例一打开页面，启动日志里就已经有它了；随后每轮启动只在首次初始化请求时
 * 复读文件，不再重复打印。
 */
let setupTokenCache = '';
let setupTokenPrinted = false;

function setupTokenFile() {
  // 与 `config-store` / `enc-store` 同一个数据目录（`data/` 已在 .gitignore 里）
  return path.join(require('../data-dir').dataDir(), 'setup-token.txt');
}

function setupTokenRequired() {
  return Boolean(security.IS_DEPLOY);
}

/** 生成（或复用）安装令牌；落盘 0600，并在控制台打印一次 */
function ensureSetupToken() {
  if (setupTokenCache) return setupTokenCache;
  const file = setupTokenFile();
  try {
    setupTokenCache = String(fs.readFileSync(file, 'utf8') || '').trim();
  } catch (e) { setupTokenCache = ''; }
  if (!setupTokenCache) {
    setupTokenCache = crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, setupTokenCache + '\n', { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 上 chmod 语义有限，忽略 */ }
    } catch (e) { /* 落盘失败：仍用内存值，至少本次进程能完成初始化 */ }
  }
  if (!setupTokenPrinted) {
    setupTokenPrinted = true;
    // 只打印到服务端控制台/容器日志，**绝不**进任何 HTTP 响应或审计日志
    console.log(`[kepler] 首次初始化令牌（安装令牌）：${setupTokenCache}`);
    console.log('[kepler] 部署模式下的 /auth/init 需要它；已完成初始化后本文件可删除。');
  }
  return setupTokenCache;
}

/** 前端提示里要显示的位置（不泄露令牌本身） */
function setupTokenHint() {
  return setupTokenRequired()
    ? '部署模式首次初始化需要安装令牌：见服务端启动日志，或服务器上的 data/setup-token.txt'
    : '';
}

/**
 * 启动时**主动**生成安装令牌（R72）。
 *
 * ## 为什么不继续等「第一次需要它」
 *
 * 令牌原本是懒生成的：有人打开页面（`GET /auth/me`）或直接打 `/auth/init` 时才落盘。
 * 这让**部署脚本**处在尴尬位置 —— 它在服务刚起来时就把「部署完成」的信息打印完了，
 * 那一刻文件还不存在，于是收尾信息里只能写「去翻启动日志」。而用户真正需要它的时刻
 * 恰恰是「还没打开页面」：登录页要填的那一栏就是它。
 *
 * 现在改成「进程启动、且确实还没初始化」就生成并落盘，于是：
 *  - 部署脚本可以直接读文件，把令牌印在收尾信息与管理菜单里；
 *  - 用户打开页面前，令牌已经在 `data/setup-token.txt`，不再有「先有鸡还是先有蛋」。
 *
 * ## 边界（任何一个不满足都**不**生成）
 *
 *  - 非部署模式（`HOST` 回环）：本机形态本来就不需要令牌，凭空造一个只会让人多填一栏；
 *  - 已经有账户：令牌只在「首次初始化」有意义，已初始化的实例不该再有一枚可用的令牌；
 *  - 读用户列表失败（配置损坏等）：宁可不生成，也不要在异常状态下写一个来历不明的凭据。
 *
 * 幂等：文件已存在时 `ensureSetupToken()` 直接复读，不会换掉用户已经抄走的那一枚。
 */
function primeSetupToken() {
  if (!setupTokenRequired()) return '';
  let initialized = false;
  try {
    initialized = configStore.listUsers().length > 0;
  } catch (e) {
    return '';
  }
  if (initialized) return '';
  return ensureSetupToken();
}

/**
 * **只读地**取当前安装令牌：**绝不生成、绝不打印**。
 *
 * R94（审核 M01-02）：`setupTokenMatches()` 原先直接调 `ensureSetupToken()`，
 * 而后者在「缓存空 + 文件读不到」时会**重新生成一枚并落盘 + 打印**。于是初始化
 * 完成之后，任何匿名请求打一次 `POST /auth/init`（不带令牌）就会让
 * `data/setup-token.txt` 复活、并在容器日志里再打一遍「首次初始化令牌」——
 * 与「它的全部生命周期就是第一次初始化之前」的口径直接矛盾，也与
 * `primeSetupToken()`（已初始化则**不**生成）相反。
 *
 * 比对只该读：读不到就是「没有令牌」，按不匹配处理。
 */
function readSetupToken() {
  if (setupTokenCache) return setupTokenCache;
  try {
    return String(fs.readFileSync(setupTokenFile(), 'utf8') || '').trim();
  } catch (e) {
    return '';
  }
}

function setupTokenMatches(given) {
  const want = readSetupToken();
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (!a.length || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

router.post('/auth/init', async (req, res) => {
  try {
    const ip = security.clientIp(req) || 'unknown';
    const limited = security.initLimiter(ip);
    if (!limited.ok) {
      return res.status(429).json({ error: `初始化尝试过于频繁，请 ${limited.retryAfter} 秒后重试` });
    }
    /**
     * R69：部署模式下先验安装令牌 —— 位置在限流之后、任何查库/哈希之前：
     * 令牌不对的请求连「系统有没有用户」都不该问出来。
     */
    if (setupTokenRequired()) {
      const given = String((req.body && req.body.setupToken) || req.get('x-setup-token') || '').trim();
      if (!setupTokenMatches(given)) {
        statsStore.addLog({ action: 'auth.init', level: 'warn', detail: `初始化被拒绝（安装令牌不正确，来源 IP：${ip}）` });
        return res.status(403).json({ error: '安装令牌不正确。令牌在服务端启动日志中（data/setup-token.txt）' });
      }
    }
    if (configStore.listUsers().length > 0) {
      return res.status(409).json({ error: '系统已初始化，请使用已有账户登录' });
    }
    if (initInFlight) {
      return res.status(409).json({ error: '系统正在初始化，请稍后重试' });
    }
    initInFlight = true;
    try {
      // 进入临界区后再检查一次：消除「检查 → 写入」之间的竞态窗口
      if (configStore.listUsers().length > 0) {
        return res.status(409).json({ error: '系统已初始化，请使用已有账户登录' });
      }
      const b = req.body || {};
      if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
        return res.status(400).json({ error: '两次输入的密码不一致' });
      }
      /**
       * R71：**第一个账户就是根用户**。
       *
       * 这里刻意把 `role` 写成 `root`（而不是继续写 `admin`）—— 存储层的
       * `resolveNewUserRole()` 在空库时本来也会强制成 root，但两处都写明才算
       * 「意图可读」：读这段代码的人不该靠翻 `config-store` 才知道初始化建的是谁。
       * 若真有并发把库先填上（下面的二次检查已挡，属兜底），它会以 403 失败 ——
       * fail-closed，而不是静默造出第二个根用户。
       */
      const user = await configStore.addUser({ username: b.username, password: b.password, role: roles.ROOT, permissions: {} });
      // R69：初始化完成即抹掉安装令牌文件 —— 它的全部生命周期就是「第一次初始化之前」
      if (setupTokenRequired()) {
        try { fs.unlinkSync(setupTokenFile()); } catch (e) { /* 文件不在也无所谓 */ }
        setupTokenCache = '';
        setupTokenPrinted = false; // 若日后用户被清空需要重新初始化，新令牌要能再打印一次
      }
      const token = authSession.createSession(user);
      res.setHeader('Set-Cookie', sessionCookie(token));
      statsStore.addLog({ action: 'auth.init', detail: `系统初始化，创建${roles.roleLabel(user.role)}「${user.username}」` });
      res.json({ ok: true, user });
    } finally {
      initInFlight = false;
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ==================== R54②：注册 / 找回密码 / 邮箱验证码 ==================== */

/**
 * 重置密码的锁定键（R54②）。
 *
 * 格式化规则与 `loginLockKey` 逐字相同（`IP|规范化标识`），但**刻意各写一份**：
 * 两条路径锁的是**不同的实例**（`resetLock` / `loginLock`），而「键里放什么」
 * 将来可能因业务而分叉（重置允许用邮箱当标识、登录只认用户名）—— 共用一个函数，
 * 分叉时就会把其中一条的取舍带到另一条上。
 */
function resetLockKey(ip, identifier) {
  return `${ip}|${String(identifier == null ? '' : identifier).trim().toLowerCase()}`;
}

/**
 * 注册模式的拒绝文案（唯一实现点：接口报错与前端提示同源）。
 *
 * ⚠️ R54③ 起这里**只剩 `closed` 一条**：`invite` 模式已真正落地（不再拒绝），
 * 它的失败文案改由 `inviteStore.INVITE_FAIL_TEXT` 按四种原因分别给出。
 * 只留 `closed` 还带来一个好处 —— 下面那句 `REGISTER_DENY_TEXT[mode]` 的
 * 兜底不可能命中一个「其实不该被拒绝」的模式（真命中了会退到 `closed` 的文案，
 * 而那与「不开放注册」是同一件事，不会误导）。
 */
const REGISTER_DENY_TEXT = {
  closed: '当前未开放注册，请联系管理员添加账户',
};

/**
 * 注册新用户（**匿名可达**，需求 2 / 2.1 / 3 / 4）。
 *
 * 与注册有关的四条口径全部落在本函数：
 *  ① **身份不由请求体决定**：`open` 模式取站点设置的 `defaultRole`，
 *     `invite` 模式取**邀请码上快照的身份**（需求 4.1 的「注册后的身份」）。
 *     请求体里的 `role` / `permissions` 一律忽略 —— 否则任何人注册时带上
 *     `role: 'admin'` 就能自封管理员；
 *  ② **只收用户名与密码**（需求 2 的已确认口径）：邮箱在「编辑资料」里补填（需求 2.3 / 2.4），
 *     或由管理员设置（需求 2.6）；
 *  ③ **注册模式**决定放行与否：`open` / `invite` 放行（后者需核销邀请码），
 *     `closed` 明确拒绝并说明原因；
 *  ④ **邀请码的核销必须"要么全成、要么全不成"**：核销在 `addUser` 之前，
 *     `addUser` 失败要把那一笔还回去（否则「用户名已存在」会白扣一次配额，
 *     而管理员看到「已用 1 次」却没有对应的账户）。
 *
 * ## 三步的先后顺序是刻意的（顺序本身带安全性质）
 *
 *   限流 → 注册模式 → **邀请码格式** → 两次密码一致 → 人机验证 → **核销邀请码** → 建号
 *
 *  · 注册模式先于一切入参校验：反过来会让「模式已关闭」也白走一遍 scrypt，
 *    这个匿名端点就成了不需要任何前提的 CPU 消耗入口（同 SEC-05 的推理）。
 *  · **邀请码的格式校验在前、核销在后**：格式错（抄错一位）当场 400 说清楚；
 *    而「这枚码是否存在 / 是否已经用尽」要等人机验证过了才回答 ——
 *    否则这个限流 10 次 / 10 分钟的匿名端点会变成一条**邀请码存在性 oracle**
 *    （拿一批码来试，响应能区分「格式对但不存在」与「存在」）。
 *    这与 R21-05 / R22-01 收敛登录分支、`/auth/forgot` 响应恒真是同一个判据。
 *  · 核销紧挨着 `addUser`：核销之后到建号之间只剩这一步，失败窗口最小。
 */
router.post('/auth/register', async (req, res) => {
  try {
    const ip = security.clientIp(req) || 'unknown';
    const rl = security.registerLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }

    // ① 注册模式（**先于任何入参校验**，理由见函数头注释）
    const site = configStore.siteView(configStore.load());
    const mode = site.registration;
    if (mode !== 'open' && mode !== 'invite') {
      statsStore.addLog({
        action: 'auth.register', level: 'warn',
        detail: `注册被拒绝（注册模式：${mode}；用户名：`
          + `${String((req.body && req.body.username) || '').trim() || '(空)'}；来源 IP：${ip}）`,
      });
      return res.status(403).json({ error: REGISTER_DENY_TEXT[mode] || REGISTER_DENY_TEXT.closed });
    }

    const b = req.body || {};

    // ② 邀请码**格式**（不查库 —— 查库放在人机验证之后）
    let inviteCode = '';
    if (mode === 'invite') {
      const r = parseInviteCodeInput(b.inviteCode);
      if (!r.ok) return res.status(400).json({ error: r.error });
      inviteCode = r.value;
    }

    if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    // ③ 人机验证：与登录同源。开启时注册同样是脚本撞的第一道门 —— 而且它比登录更"贵"：
    // 每一次成功注册都要落一个账户并算一次 scrypt。
    const cap = await captcha.verify({
      token: b.captchaToken, remoteip: ip, expectedHosts: captchaHosts(req),
    }, configStore);
    if (!cap.passed) {
      statsStore.addLog({ action: 'auth.register', level: 'warn', detail: `注册被人机验证拦截（原因：${cap.reason}；IP：${ip}）` });
      return res.status(403).json({ error: captcha.publicReason(cap.reason) });
    }
    if (cap.degraded) {
      statsStore.addLog({ action: 'auth.captcha.degraded', level: 'warn', detail: `人机验证服务异常已按降级策略放行（原因：${cap.reason}；场景：注册）` });
    }

    // ④ 核销邀请码 —— 四种失败原因分别给文案（见 `INVITE_FAIL_TEXT` 的注释：
    //    四档对应的下一步动作完全不同，合成一句「邀请码无效」只会制造工单）
    const username = String(b.username == null ? '' : b.username).trim();
    let granted = null;
    if (mode === 'invite') {
      const r = inviteStore.consume(inviteCode, username);
      if (!r.ok) {
        // ⚠️ 日志里**不记邀请码本身**（审计日志是明文 JSONL），只记失败原因与码的 id
        statsStore.addLog({
          action: 'auth.register', level: 'warn',
          detail: `邀请码核销失败（原因：${r.reason}；用户名：${username || '(空)'}；来源 IP：${ip}）`,
        });
        return res.status(403).json({
          error: inviteStore.INVITE_FAIL_TEXT[r.reason] || inviteStore.INVITE_FAIL_TEXT.not_found,
        });
      }
      granted = r.invite;
    }

    let user;
    try {
      user = await configStore.addUser({
        username: b.username,
        password: b.password,
        // 邀请码模式下**以码上的身份为准**（需求 4.1）；公开注册才落到站点默认身份
        role: granted ? granted.role : site.defaultRole,
        permissions: {},
        email: '', // 注册不收邮箱
      });
    } catch (e) {
      // 建号失败 ⇒ 归还刚核销掉的那一次（用户名重复、密码不合规等都会走到这里）
      if (granted) inviteStore.rollback(granted.id, username);
      /**
       * R69 / L-4：**「用户名已存在」这条答案要走全站共享预算**。
       *
       * 公开注册下这条反馈无法取消（否则没人能注册），但它同时是一条用户名枚举
       * oracle：429 之外的 409 / 200 差异，足以让人批量确认哪些账号真实存在。
       * 按 IP 限流挡不住代理池，所以这里对「冲突答案」本身计数 —— 额度耗尽后
       * 冲突一律回 429 且文案与限流完全一致，不再泄露「是否存在」。
       * **注册成功的路径不经过这里**，正常用户不受影响。
       */
      if (e && e.status === 409 && /用户名已存在/.test(String(e.message || ''))) {
        const budget = security.registerConflictLimiter(security.REGISTER_CONFLICT_KEY);
        statsStore.addLog({
          action: 'auth.register', level: 'warn',
          detail: `用户名冲突（用户名：${username || '(空)'}；来源 IP：${ip}；`
            + `本轮冲突预算：${budget.ok ? '未用尽' : '已用尽'}）`,
        });
        if (!budget.ok) {
          res.setHeader('Retry-After', String(budget.retryAfter));
          return res.status(429).json({ error: `尝试过于频繁，请 ${budget.retryAfter} 秒后重试` });
        }
      }
      throw e;
    }

    statsStore.addLog({
      action: 'auth.register',
      detail: `新用户「${user.username}」注册成功（身份：${roles.roleLabel(user.role)}`
        + `；方式：${granted ? '邀请码' : '公开注册'}；来源 IP：${ip}）`,
    });
    // 注册即登录：刚设的密码就在手上，再让他手打一遍只是仪式感
    return completeLogin(res, user, false, ip);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 忘记密码 —— 第一步：按「用户名或邮箱」定位账户，往它**已绑定的邮箱**发重置验证码。
 *
 * ## 判据的分界：**站点级状态如实回，标识级差异一律静默**
 *
 * 本端点在 `PUBLIC_API` 白名单里。若按「有没有这个账户 / 它的邮箱是否为空」回不同的
 * 报文，它就成了一条**账户存在性 oracle** —— 而 R21-05 / R22-01 收敛登录三条分支
 * 同形，堵的正是同一个洞。因此：**标识是否命中，响应逐字节相同**。
 *
 * 但「站点级」的三件事不是秘密，也不构成 oracle（拿任意标识去问，得到的都是同一句
 * 回答）：**发信配没配 / 开关开没开 / 连得上吗**。R57 起这三项由
 * `emailCode.probeMailer()` 统一回答、**如实回 503**，且它在**读取标识之前**对任意
 * 标识都执行 —— 用户于是能立刻看到「系统发信当前不可用：…」，而不是收到一句
 * 「验证码已发送」再等一封永远不会来的邮件（这正是本轮修掉的两份工单的病灶：
 * 一次是口令被对外视图裁空，一次是启用开关没打开，两次都表现为「配置全对却发不出去」）。
 *
 * 由此带出两处**刻意保留**的静默，写在这里以免后来者当成漏改：
 *  ① **命中账户之后的发信失败（对方服务器拒收 / 地址不存在）只记日志、响应照旧恒真**
 *     —— 那一步的成败与「这个标识是否存在」相关，如实报错就是一条 oracle；
 *  ② **重发冷却（60 秒）不体现在响应里** —— 命中时冷却会拦下第二次发送，若那时回 429、
 *     未命中时回 200，同样是一条 oracle。前端因此自带 60 秒倒计时（与
 *     `EMAIL_CODE_RESEND_MS` 对齐）。
 *
 * 残余的**时序**差异此处不假装已消除，但 R57 起被显著收窄：探测那条路径对命中与
 * 未命中**都要连一次 SMTP 服务器**，两者不再只是「多一次往返」的对比。
 * 何况它被 10 次 / 10 分钟的 IP 限流压在很低的枚举速率下。
 */
router.post('/auth/forgot', async (req, res) => {
  try {
    const ip = security.clientIp(req) || 'unknown';
    const rl = security.forgotLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `请求过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }

    /**
     * 站点级闸门：未配置 / 已停用 / 连不上（含认证被拒）⇒ **统一**回 503 并说明原因。
     *
     * ⚠️ 顺序是**判据本身的一部分**：它必须在**读取标识之前**、且**对任意标识都执行**。
     * 挪到 `if (raw && email)` 里面（"只有真要发信时才探"）的话，响应就随标识而变，
     * 这条匿名端点立刻变回一条账户存在性 oracle。
     */
    const gate = await emailCode.probeMailer();
    if (!gate.ok) {
      // R94（审核 M03-02）：匿名端点只回**类别**（`publicError`），不回 `error` 里的
      // 主机:端口 / TLS 结果 / 服务端原文 —— 详情版只留在服务端日志与管理员接口。
      return res.status(gate.status || 503).json({ error: gate.publicError || gate.error });
    }

    const b = req.body || {};
    const identifier = String(b.identifier == null ? '' : b.identifier).trim();
    const raw = identifier ? configStore.findUserByIdentifier(identifier) : null;
    const email = raw ? normalizeEmail(raw.email) : '';

    if (raw && email) {
      try {
        const r = await emailCode.sendCode({ purpose: 'reset', email, username: raw.username });
        if (r.ok) {
          statsStore.addLog({ action: 'auth.forgot', detail: `已向账户「${raw.username}」的邮箱发送重置验证码` });
        } else {
          // ① 冷却中：静默跳过（响应恒真），只留日志
          statsStore.addLog({
            action: 'auth.forgot', level: 'warn',
            detail: `重置验证码在重发冷却内被跳过（账户：${raw.username}，还需 ${r.retryAfter} 秒）`,
          });
        }
      } catch (e) {
        // ② 发信失败：同样静默，只留日志
        statsStore.addLog({ action: 'auth.forgot', level: 'warn', detail: `重置验证码发送失败（账户：${raw.username}）：${e.message}` });
      }
    } else {
      statsStore.addLog({
        action: 'auth.forgot', level: 'warn',
        detail: `重置请求未命中已绑定邮箱的账户（标识：${identifier || '(空)'}；IP：${ip}）`,
      });
    }

    return res.json({ ok: true, message: '如果该账户已绑定邮箱，重置验证码已发送，请查收邮件（含垃圾邮件箱）' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 忘记密码 —— 第二步：凭验证码设置新密码（需求 2.2）。
 *
 * 全部失败分支（标识不存在 / 该账户没绑邮箱 / 未提交验证码 / 验证码错 / 已过期 / 尝试用尽）
 * 都回**同一个** `400 + CODE_FAIL_TEXT`，锁定也共用同一个预算 —— 否则「这个标识存在
 * 且绑了邮箱」又会从状态码或文案的缝隙里漏出去。
 *
 * 顺序是「核验验证码 → 改密码 → **成功后才核销**」：
 * 把核销放在改密码之前的话，用户若因密码太短被拒（`assertPasswordPolicy` 抛 400），
 * 那个验证码已经作废了，他得重新收一封信 —— 而这一轮里没有任何东西需要作废。
 * 反向的"改密成功却漏核销"窗口只有一个同步语句宽（`consume` 紧跟在 `await` 之后），
 * 且此时攻击者早已持有那个码，不构成新增风险。
 */
router.post('/auth/reset', async (req, res) => {
  try {
    const ip = security.clientIp(req) || 'unknown';
    const rl = security.resetLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }

    const b = req.body || {};
    const identifier = String(b.identifier == null ? '' : b.identifier).trim();
    const code = String(b.code == null ? '' : b.code).trim();
    const lockKey = resetLockKey(ip, identifier);

    const lockedLeft = security.resetLock.locked(lockKey);
    if (lockedLeft > 0) {
      return res.status(429).json({ error: `失败次数过多，已临时锁定，请 ${lockedLeft} 秒后重试` });
    }

    /**
     * 两次密码是否一致属于**离线可判**的错误，先判、且与验证码无关：
     * 用户不必为了改一个手滑打错的新密码去重新收一封信。
     */
    if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    if (String(b.password == null ? '' : b.password) === '') {
      return res.status(400).json({ error: '请输入新密码' });
    }

    const raw = identifier ? configStore.findUserByIdentifier(identifier) : null;
    const email = raw ? normalizeEmail(raw.email) : '';

    /** 所有「验证不过」的统一出口：同一状态码 + 同一文案 + 同一份锁定预算 */
    const authFail = (detail) => {
      const left = security.resetLock.fail(lockKey);
      statsStore.addLog({
        action: 'auth.reset', level: 'warn',
        detail: `重置密码失败：${detail}（标识：${identifier || '(空)'}；IP：${ip}）`,
      });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，已临时锁定，请 ${left} 秒后重试` });
      return res.status(400).json({ error: emailCode.CODE_FAIL_TEXT });
    };

    if (!raw || !email) return authFail('标识不存在或该账户未绑定邮箱');
    if (!code) return authFail('未提交验证码');

    const r = emailCode.check({ purpose: 'reset', email, code });
    if (!r.ok) return authFail(`验证码不通过（${r.reason}）`);

    // 密码策略由 `updateUser` 内的唯一判据负责（这里不另写一份）；它抛错时验证码仍未核销
    const user = await configStore.updateUser(raw.id, { password: b.password });
    emailCode.consume({ purpose: 'reset', email });
    security.resetLock.reset(lockKey);

    /**
     * 重置密码是**应急响应动作**：全部会话必须立即失效（与管理员重置密码同一处置，SEC-02）。
     * 不撤销的话，「密码已经改了但攻击者的旧会话还能用」就等于这次重置白做。
     */
    const n = authSession.destroyUserSessions(raw.id);
    statsStore.addLog({
      action: 'auth.reset', level: 'warn',
      detail: `账户「${user.username}」通过邮箱验证码重置了密码，其 ${n} 个会话已失效`,
    });
    return res.json({ ok: true, user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 请求「邮箱验证码」（**需登录**，需求 2.3 / 2.4 的前半步）。
 *
 * 用途是给**自己**的账户绑定 / 更换邮箱：验证码发往**用户提交的那个新地址**，
 * 用于证明「这个地址确实归我」，防止手滑写错成别人的地址（那会把重置密码的
 * 收件渠道让给陌生人）。真正落库在 `PUT /users/me`（那里还要求当前密码，见其注释）。
 *
 * ⚠️ 这里**先做唯一性判定**并如实回 409，是一个自觉的取舍：
 *  - 不先判的话，我们就会**代任何一个登录用户**往「某个陌生人的邮箱」发一封信
 *    （对方邮箱恰好属于本站另一个用户时），既是骚扰也让攻击者能探测；
 *  - 代价是「某个邮箱是否已被占用」对**已登录用户**可见。该信息需要先有账户、
 *    且受 `emailCodeLimiter` 限流，属于可接受的取舍。
 */
router.post('/auth/email/code', async (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });

    const ip = security.clientIp(req) || 'unknown';
    const rl = security.emailCodeLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `请求过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    /**
     * R94（审核 M03-06）：按 IP 那一层挡不住「换一批地址」——`email-code.js` 的
     * 冷却按 `purpose|邮箱` 记，换个地址就是新配额。再按**用户**计一条日配额，
     * 否则本站会用管理员的 SMTP 账号往任意第三方地址发信（骚扰 + 烧发信配额）。
     */
    const url = security.emailCodeUserLimiter('u:' + me.id);
    if (!url.ok) {
      res.setHeader('Retry-After', String(url.retryAfter));
      return res.status(429).json({
        error: `该账户近期请求的邮箱验证码过多，请 ${url.retryAfter} 秒后重试`,
      });
    }

    const b = req.body || {};
    const p = parseEmailInput(b.email);
    if (!p.ok) return res.status(400).json({ error: p.error });

    // 已经是自己的邮箱 ⇒ 无需验证码；直接说清楚，省掉一封必然用不上的信
    //
    // ⚠️ 必须从**实时记录**取当前邮箱：`req.authUser` 只有 `{ id, username, role, permissions }`
    //    四个字段（见 index.js 的鉴权中间件），**没有** `email` —— 写成 `me.email` 恒为
    //    `undefined`，这个分支就永远不会命中（而在界面上表现为"点了却没反应"）。
    const rawMe = configStore.findUserRawById(me.id);
    if (p.value === normalizeEmail(rawMe && rawMe.email)) {
      return res.json({ ok: true, alreadyBound: true, message: '该邮箱已是当前账户的邮箱，无需重复验证' });
    }

    const cfg = configStore.load();
    try {
      configStore.assertEmailFree(cfg, p.value, me.id);
    } catch (e) {
      statsStore.addLog({
        action: 'auth.email-code', level: 'warn',
        detail: `用户「${me.username}」尝试绑定已被占用的邮箱（${p.value}）`,
      });
      return res.status(e.status || 409).json({ error: e.message });
    }

    /**
     * 重发冷却在这里**如实回 429**（与 `/auth/forgot` 刻意不同）：
     * 本接口需登录、且用户提交的是自己的新地址，不存在账户存在性 oracle 的问题；
     * 用户点快了就该被告知还要等几秒，而不是"假装发了"。
     */
    const r = await emailCode.sendCode({ purpose: 'verify', email: p.value, username: me.username });
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: `请求过于频繁，请 ${r.retryAfter} 秒后重试` });
    }
    statsStore.addLog({ action: 'auth.email-code', detail: `已向「${p.value}」发送邮箱验证码（用户：${me.username}）` });
    // 回显用户自己刚提交的地址：不是新信息，前端要靠它做 60 秒倒计时
    res.json({ ok: true, to: p.value, resendAfter: Math.round(EMAIL_CODE_RESEND_MS / 1000) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
// SEC-02：暴露锁定键构造函数，供护栏测试直接断言「不同 IP 互不影响」
module.exports.loginLockKey = loginLockKey;
// R54②：同上，暴露重置路径的锁定键（两条路径的锁定实例互相独立）
module.exports.resetLockKey = resetLockKey;
// R72：启动时预生成安装令牌（`server/index.js` 在监听前调用），供部署脚本读取后打印
module.exports.primeSetupToken = primeSetupToken;
