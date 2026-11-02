/**
 * 原生验证码（无浏览器客户端专用）—— R100
 *
 * ## 它解决什么
 *
 * 服务端开启 Google reCAPTCHA / Cloudflare Turnstile 后，登录页必须渲染**第三方
 * Web 组件**才能拿到 `captchaToken`。纯原生的 Android 客户端没有 WebView 通道，
 * 拿不到 token ⇒ `captcha.verify()` 一律 `captcha_token_missing` ⇒ 客户端**永远
 * 登不进来**（而网页端一切正常，所以这个问题只在真机上暴露）。
 *
 * 本模块给这类客户端一条**自足**的人机验证路径：服务端出一道算术题，客户端用
 * `Text` + `TextField` 就能渲染与作答，不依赖任何外部脚本、图片或 WebView。
 *
 * ## 三条必须同时成立的设计约束
 *
 * ① **它必须比 reCAPTCHA 弱，所以必须显式开启。**
 *    算术题对脚本是透明的（写两行代码就能解），而识别客户端的请求头
 *    （`X-Kepler-Client`）也是可以伪造的 —— 两者叠加意味着：**只要打开这个开关，
 *    任何人带上这个头就能绕过 reCAPTCHA**。因此 `NATIVE_CAPTCHA` **默认关闭**，
 *    由部署者按「我的客户端是真的原生 App，我愿意用弱验证换可用性」显式打开。
 *    这与 `captcha.onError` 默认 `block` 是同一条原则：宁可拦着，也不要
 *    「开了等于没开」。
 *
 * ② **关闭时必须是零行为，而不是"换一种放行"。**
 *    开关关掉、或请求不是客户端、或验证码全局关闭 —— 三种情况都**原样交给**
 *    `captcha.verify()`，不签题、不判题、不产生任何差异。既有网页登录路径
 *    一个字节都不变（`guard()` 是唯一调用点，它把决定权先交回给原实现）。
 *
 * ③ **题目一次性、有期限、有次数上限、内存有天花板。**
 *    每题 TTL 5 分钟、答错累计 3 次作废、签发后**答对即删**（重放拿不到第二次）。
 *    内存表在达到上限时先清过期项、再按插入序淘汰 —— 否则匿名端点就是一条
 *    无界内存增长路径（与 R69 给限流器加 `LIMITERS_MAX_ENTRIES` 同型）。
 *
 * ## 环境变量
 *
 *  - `NATIVE_CAPTCHA`          `on` / `1` / `true` 才启用（默认关闭）
 *  - `NATIVE_CAPTCHA_CLIENTS`  允许的客户端标识前缀，逗号分隔（默认 `kepler-android/`）
 */

const crypto = require('crypto');
const captcha = require('./captcha');

/** 单题有效期：5 分钟。够慢手输，也不给「挂着慢慢试」留窗口 */
const TTL_MS = 5 * 60 * 1000;
/** 同一枚 token 的最大作答次数。超过即作废（换题） */
const MAX_ATTEMPTS = 3;
/** 内存表硬上限（见文件头 ③） */
const MAX_ENTRIES = 5000;
/** 答案长度上限：正常答案 ≤ 3 位，8 位足够容纳手滑输入，又不给超长串留解析成本 */
const MAX_ANSWER_LEN = 8;
/** 默认的客户端标识前缀（Android App 固定发 `X-Kepler-Client: kepler-android/<ver>`） */
const DEFAULT_CLIENT_PREFIX = 'kepler-android/';

/** token → { answer, expiresAt, attempts }。Map 保持插入顺序，淘汰时按它来 */
const store = new Map();

/** 环境变量开关（只有明确的真值才算开 —— 拼错一律当关闭，安全默认） */
function envOn(name) {
  const v = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

/** 原生分支是否启用 */
function enabled() {
  return envOn('NATIVE_CAPTCHA');
}

/**
 * 允许的客户端标识前缀。
 * 未配置 / 配置为空 ⇒ 回落到 `kepler-android/`（唯一在用的客户端）。
 * 刻意**不用通配**（如 `*`）：那等于「任何带头即放行」，而头本身可伪造，
 * 白名单至少能挡住「顺手加个头」的无意识绕过。
 */
function clientPrefixes() {
  const raw = String(process.env.NATIVE_CAPTCHA_CLIENTS == null ? '' : process.env.NATIVE_CAPTCHA_CLIENTS);
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [DEFAULT_CLIENT_PREFIX];
}

/** 取请求头里的客户端标识（统一小写键；Express 已归一，此处再兜一层） */
function clientTag(req) {
  const h = req && req.headers ? req.headers['x-kepler-client'] : '';
  return typeof h === 'string' ? h.trim() : '';
}

/**
 * 这个请求是不是「原生客户端」。
 *
 * ⚠️ 这**不是**鉴权：头可伪造。它只回答「走哪条人机验证分支」，
 * 而能否真正登录仍由口令决定 —— 与 reCAPTCHA 的位置一致（人机验证在口令之前，
 * 只挡脚本撞库，不承担身份判定）。
 */
function isNativeClient(req) {
  const tag = clientTag(req);
  if (!tag || tag.length > 64) return false;
  const low = tag.toLowerCase();
  return clientPrefixes().some((p) => low.startsWith(p.toLowerCase()));
}

/** 闭区间随机整数（crypto 而非 Math.random：题目不该可预测） */
function randInt(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

/**
 * 生成一道算式。
 *
 * 只用加减乘、操作数都控制在两位数内 —— 目标读者是「在手机上输密码的人」，
 * 而不是要做心算比赛。乘法单独限到 2~9，避免 `17 × 13` 这种让人骂人的题。
 */
function makeQuestion() {
  const op = randInt(0, 2);
  if (op === 2) {
    const a = randInt(2, 9);
    const b = randInt(2, 9);
    return { question: `请计算 ${a} × ${b} = ?`, answer: a * b };
  }
  if (op === 1) {
    const a = randInt(5, 19);
    const b = randInt(1, a - 1); // 保持结果为正，避免负数输入与「-」号歧义
    return { question: `请计算 ${a} - ${b} = ?`, answer: a - b };
  }
  const a = randInt(2, 19);
  const b = randInt(2, 19);
  return { question: `请计算 ${a} + ${b} = ?`, answer: a + b };
}

/** 清掉已过期的条目（只在需要腾地方 / 校验时顺带跑，不做定时器） */
function sweep(now) {
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}

/**
 * 签发一道题。
 * @returns {{token:string, question:string, expiresAt:string}} 只回可下发的字段，
 *          `answer` 绝不出本模块（与 secretKey 同一口径）。
 */
function issue(now = Date.now()) {
  if (store.size >= MAX_ENTRIES) sweep(now);
  if (store.size >= MAX_ENTRIES) {
    // 仍然满 ⇒ 按插入顺序淘汰最旧的四分之一（单次淘汰 1 条会在高并发下反复触发）
    const drop = Math.max(1, Math.floor(MAX_ENTRIES / 4));
    let n = 0;
    for (const k of store.keys()) {
      if (n >= drop) break;
      store.delete(k);
      n += 1;
    }
  }
  const { question, answer } = makeQuestion();
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { answer: String(answer), expiresAt: now + TTL_MS, attempts: 0 });
  return { token, question, expiresAt: new Date(now + TTL_MS).toISOString() };
}

/**
 * 答案归一化：去首尾空白、抹掉**全部**空白、全角数字转半角。
 *
 * 手机上输数字很容易带一个尾随空格，或者中文输入法打出全角 `７` ——
 * 这属于输入噪音而不是答错，归一化掉才是对的（reCAPTCHA 那边没有这个问题，
 * 因为它根本不用人打字）。
 */
function normalizeAnswer(v) {
  let s = String(v == null ? '' : v).trim();
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String(c.charCodeAt(0) - 0xFF10));
  s = s.replace(/\s+/g, '');
  return s.length > MAX_ANSWER_LEN ? '' : s;
}

/** 恒定时比较（避免按字节提前返回的时序差异 —— 答案空间很小，但白送信息没有理由） */
function sameAnswer(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * 校验一次作答。
 * @returns {{ok:boolean, reason:string}}
 *   reason：`ok` / `expired`（不存在或已过期）/ `attempts`（次数用尽）/ `wrong` / `invalid`
 */
function verify(token, answer, now = Date.now()) {
  const t = String(token == null ? '' : token).trim();
  if (!t || t.length > 64) return { ok: false, reason: 'invalid' };
  const rec = store.get(t);
  if (!rec) return { ok: false, reason: 'expired' };
  if (rec.expiresAt <= now) { store.delete(t); return { ok: false, reason: 'expired' }; }
  if (rec.attempts >= MAX_ATTEMPTS) { store.delete(t); return { ok: false, reason: 'attempts' }; }

  const got = normalizeAnswer(answer);
  if (got && sameAnswer(got, rec.answer)) {
    store.delete(t); // 一次性：同一枚 token 不可能通过第二次
    return { ok: true, reason: 'ok' };
  }
  rec.attempts += 1;
  if (rec.attempts >= MAX_ATTEMPTS) store.delete(t);
  return { ok: false, reason: got ? 'wrong' : 'invalid' };
}

/** 失败原因 → 可直接显示给用户的文案（客户端把它放进 `captchaError`） */
const FAIL_TEXT = {
  native_wrong: '答案不正确',
  native_expired: '验证码已过期，请重新作答',
  native_attempts: '尝试次数过多，已换一道题',
  native_invalid: '验证码格式不正确，请重新作答',
  native_challenge: '请先完成人机验证',
};

function failText(reason) {
  return FAIL_TEXT[String(reason || '')] || '答案不正确';
}

/**
 * 登录 / 注册的**唯一**人机验证入口。
 *
 * 三条短路全部交回 `captcha.verify()`：
 *   ① 验证码全局关闭（`enabled=false`）—— 两条分支都不该触发；
 *   ② `NATIVE_CAPTCHA` 未开启 —— 这是默认状态，行为与改动前完全一致；
 *   ③ 请求不带客户端标识 / 标识不在白名单 —— 浏览器与未知调用方走原路径。
 *
 * 只有三条都通过才走原生分支，且**不发出任何网络请求**（这正是客户端要的东西：
 * 服务商组件加载不了、回源校验也用不上）。
 *
 * @param {object} args { req, body, remoteip, expectedHosts }
 * @param {object} configStore 配置存储模块（透传给 `captcha`）
 * @returns {Promise<{passed:boolean, reason:string, challenge?:object, retry?:boolean, degraded?:boolean}>}
 */
async function guard({ req, body, remoteip, expectedHosts }, configStore) {
  const b = body || {};
  const web = () => captcha.verify({
    token: b.captchaToken, remoteip, expectedHosts,
  }, configStore);

  let cfg;
  try { cfg = captcha.resolveConfig(configStore); } catch (e) { return web(); }
  if (!cfg || !cfg.enabled) return web();
  if (!enabled()) return web();
  if (!isNativeClient(req)) return web();

  const token = String(b.nativeToken == null ? '' : b.nativeToken).trim();
  const hasAnswer = b.nativeAnswer !== undefined && b.nativeAnswer !== null
    && String(b.nativeAnswer).trim() !== '';

  // 首次 / 只带 token 不带答案：发一道题让对方作答（`retry=false` ⇒ 文案是"请完成"）
  if (!token || !hasAnswer) {
    return { passed: false, reason: 'native_challenge', challenge: issue(), retry: false };
  }

  const r = verify(token, b.nativeAnswer);
  if (!r.ok) {
    // 失败一律换新题：同一枚 token 再试没有意义（已作废或已过期），
    // 而"重发同一道题"会让用户对着一个已经失效的 token 反复输入。
    return { passed: false, reason: 'native_' + r.reason, challenge: issue(), retry: true };
  }
  return { passed: true, reason: 'native_ok' };
}

/** 只读统计（供测试与管理端排查；不含任何答案） */
function state() {
  return { enabled: enabled(), prefixes: clientPrefixes(), pending: store.size };
}

/** 仅供测试：清空内存表 */
function _resetForTest() {
  store.clear();
}

module.exports = {
  TTL_MS, MAX_ATTEMPTS, MAX_ENTRIES, MAX_ANSWER_LEN, DEFAULT_CLIENT_PREFIX,
  enabled, clientPrefixes, clientTag, isNativeClient,
  issue, verify, normalizeAnswer, failText, guard, state, _resetForTest,
  FAIL_TEXT,
};
