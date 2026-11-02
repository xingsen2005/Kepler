/**
 * 第 100 轮护栏 —— 原生验证码（让没有浏览器的客户端也能登录）
 *
 * ## 原始问题
 *
 * 服务端开启 reCAPTCHA / Turnstile 后，登录页必须渲染**第三方 Web 组件**才有
 * `captchaToken`。纯原生的 Android 客户端加载不了那个组件 ⇒ 永远 `token_missing`
 * ⇒ **永远登不进来**（网页端一切正常，所以只在真机上暴露）。
 *
 * ## 断言分四层，缺一层就留一种假绿
 *
 *  ① **模块层**（`tests/captcha-native.test.js`）：签题 / 判题 / 一次性 / TTL /
 *     次数上限 / 归一化 / 白名单 / 内存天花板；
 *  ② **接线层（真 HTTP）**：登录与注册**真的**因为「带客户端标识」而改走算术题，
 *     答对后**能越过人机验证这一关**（用一个不存在的账户取 401 作证 —— 401
 *     意味着"已经问到口令了"，403 才是被人机验证挡住）；
 *  ③ **开关层**：默认关闭 / 显式开启 / 验证码全局关闭 —— 三种状态下的行为必须
 *     各自正确，尤其**默认关闭时不允许有任何行为变化**；
 *  ④ **静态接线**：匿名白名单、路由登记、两个调用点都在。
 *
 * ⚠️ `config.enc` 会真实落盘 ⇒ 必须在 require 之前把 `S3_DATA_DIR` 指到临时目录。
 * ⚠️ 限流键取自 `security.clientIp()` ⇒ 显式开 `TRUST_PROXY=1` 并逐请求换 XFF，
 *    否则登录限流（10 次/分钟）会被跨用例互相消耗，出现「单跑绿、一起跑红」。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('r100-');
process.env.S3_DATA_DIR = tmp.dir;
process.env.TRUST_PROXY = '1';

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

const express = require(path.join(ROOT, 'node_modules', 'express'));
const configStore = require(SERVER('config-store.js'));
const secureStore = require(SERVER('secure-store.js'));
const captchaNative = require(SERVER('captcha-native.js'));

const authRoutes = require(SERVER('routes', 'auth.js'));
const captchaRoutes = require(SERVER('routes', 'captcha.js'));

const CLIENT = 'kepler-android/1.0';
let ipSeq = 0;
/** 每条请求一个来源 IP：隔离登录限流预算（见文件头） */
function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}

let server = null;
let port = 0;

async function api(method, urlPath, { headers, body, ip } = {}) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api', captchaRoutes);
    app.use('/api', authRoutes);
    server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }
  const h = Object.assign({ 'X-Forwarded-For': ip || nextIp() }, headers || {});
  return request(port, method, urlPath, { headers: h, body: body === undefined ? null : body });
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir, {
    label: 'r100-',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});

/* ================================================================== *
 * 环境与工具
 * ================================================================== */

/** 本题集只关心「人机验证这一关」，口令一律给一个必然不存在的账户 */
const GHOST = 'no-such-user-r100';
const PASSWORD = 'Unit!2026abc';

/**
 * 收口：所有用例开始前把验证码「开启」，结束时恢复默认。
 * 只改内存里的配置，不碰 siteKey/secretKey —— 原生分支**不依赖**服务商凭证，
 * 这也是它能救客户端的原因（服务商的组件和校验都用不上）。
 */
function setCaptchaEnabled(v) {
  configStore.saveCaptcha({ enabled: v });
}

function envPatch(patch) {
  const old = {};
  for (const k of Object.keys(patch)) {
    old[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return () => {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
}

function solve(question) {
  const m = /请计算 (\d+) ([+\-×]) (\d+)/.exec(String(question || ''));
  assert(m, `题面格式不符：${question}`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (m[2] === '+') return String(a + b);
  if (m[2] === '-') return String(a - b);
  return String(a * b);
}

/** 一次「客户端登录」，只回状态与 JSON */
function loginAs(setup) {
  const s = setup || {};
  return api('POST', '/api/auth/login', {
    headers: s.client === false ? {} : { 'X-Kepler-Client': CLIENT },
    body: Object.assign({ username: GHOST, password: PASSWORD }, s.body || {}),
  });
}

/* ================================================================== *
 * 第 2 / 3 层 · 真 HTTP：开关的三态
 * ================================================================== */

test('R100-01 · 默认关闭：客户端登录的行为与改动前**完全一致**（403 且没有 needCaptcha）', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: undefined });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    assertEqual(captchaNative.enabled(), false, '自证：不设环境变量时开关必须是关的');
    const r = await loginAs();
    assertEqual(r.status, 403, '没开原生分支 + 没带 captchaToken ⇒ 仍被默认的「请先完成人机验证」挡住');
    assertEqual(r.json && r.json.needCaptcha, undefined,
      '默认状态下响应体里不得出现 needCaptcha —— 那会让网页端走进客户端的答题界面');
    assert(typeof (r.json && r.json.error) === 'string' && r.json.error.length > 0, '必须仍有一句可读的 error');
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});

test('R100-02 · 验证码全局关闭：客户端不需要答题（两条分支都不该触发）', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(false);
  try {
    const r = await loginAs();
    assertEqual(r.status, 401, `应直接走到口令校验（401 用户名或密码错误），实际 ${r.status}`);
    assertEqual(r.json && r.json.needCaptcha, undefined, '验证码关着就不该发题');
  } finally {
    restoreEnv();
  }
});

test('R100-03 · 开启后：客户端拿到题目（needCaptcha + captcha.token/question）', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    const r = await loginAs();
    assertEqual(r.status, 403);
    assertEqual(r.json.needCaptcha, true, '客户端必须被明确告知「需要答题」');
    assert(r.json.captcha && r.json.captcha.token, '必须下发 token');
    assert(/^请计算 \d+ [+\-×] \d+ = \?$/.test(r.json.captcha.question),
      `题面必须是一句可读的算式，实际：${r.json.captcha.question}`);
    assertEqual(r.json.captchaError, undefined, '第一次不是"答错"，不该带错误文案');
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});

test('R100-04 · 答对即越过人机验证这一关（用 401「用户名或密码错误」作证）', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    const first = await loginAs();
    const { token, question } = first.json.captcha;
    const r = await loginAs({ body: { nativeToken: token, nativeAnswer: solve(question) } });
    /**
     * ⭐ 判据是 401 而不是 200：本用例用的是**必然不存在**的账户。
     *   403 = 还卡在人机验证；401 = 人机验证已过、进入口令校验并如实失败。
     *   若拿 200 当判据，就必须真的建一个账户，那会把这个用例变成
     *   「注册 + 登录」的复合测试，失败时分不清是哪一段坏了。
     */
    assertEqual(r.status, 401, `答对后应走到口令校验（401），实际 ${r.status} ${JSON.stringify(r.json)}`);
    assertEqual(r.json.needCaptcha, undefined, '过了就不该再要题');
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});

test('R100-05 · 答错：换一道**新**题并给出 captchaError', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    const first = await loginAs();
    const { token, question } = first.json.captcha;
    const wrong = String(Number(solve(question)) + 1);
    const r = await loginAs({ body: { nativeToken: token, nativeAnswer: wrong } });

    assertEqual(r.status, 403);
    assertEqual(r.json.needCaptcha, true);
    assert(r.json.captchaError, '必须告诉客户端「上一次为什么没过」');
    assert(r.json.captcha.token !== token, '答错必须换一枚新 token（旧的那枚已作废）');
    assert(r.json.captcha.question, '新题必须有题面');
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});

test('R100-06 · 浏览器不受影响：不带客户端标识仍走 reCAPTCHA 分支', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    const r = await loginAs({ client: false });
    assertEqual(r.status, 403);
    assertEqual(r.json.needCaptcha, undefined, '网页端不该收到 needCaptcha（它没有答题界面）');
    assertEqual(r.json.captcha, undefined, '网页端不该收到算术题');
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});

test('R100-07 · 开关关掉后，同一条客户端请求又回到 reCAPTCHA 分支（不是「永久放行」）', async () => {
  const on = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  let first;
  try {
    first = await loginAs();
    assertEqual(first.json.needCaptcha, true, '自证：开着的时候确实发了题');
  } finally {
    on();
  }

  const off = envPatch({ NATIVE_CAPTCHA: undefined });
  try {
    const again = await loginAs();
    assertEqual(again.status, 403);
    assertEqual(again.json.needCaptcha, undefined,
      '关掉开关后必须立刻失效 —— 否则「关掉」只是不再发新题，已发的题仍能过');
    // 而且**旧的题也不能再用来过关**（否则关开关之后还留着一扇没关的门）
    const r2 = await loginAs({ body: { nativeToken: first.json.captcha.token, nativeAnswer: solve(first.json.captcha.question) } });
    assertEqual(r2.json.needCaptcha, undefined, '旧 token 在开关关闭后不得被原生分支消费');
  } finally {
    off();
    setCaptchaEnabled(false);
    captchaNative._resetForTest();
  }
});

/* ================================================================== *
 * 第 2 层 · 签发端点
 * ================================================================== */

test('R100-08 · GET /api/captcha/native：开启时发题，关闭时 404（不暴露「本机支持弱验证」）', async () => {
  const on = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  try {
    const r = await api('GET', '/api/captcha/native');
    assertEqual(r.status, 200);
    assertEqual(r.json.ok, true);
    assert(r.json.token && r.json.question, '必须回 token 与题面');
    // 拿它去答题必须真的能过（端点与登录读的是同一张表）
    const ok = await loginAs({ body: { nativeToken: r.json.token, nativeAnswer: solve(r.json.question) } });
    assertEqual(ok.status, 401, `端点签出的题必须能用于登录，实际 ${ok.status} ${JSON.stringify(ok.json)}`);
  } finally {
    on();
  }

  const off = envPatch({ NATIVE_CAPTCHA: undefined });
  try {
    const r = await api('GET', '/api/captcha/native');
    assertEqual(r.status, 404, '未启用时回 404：既不发题，也不对外宣称这个能力存在');
  } finally {
    off();
    captchaNative._resetForTest();
  }
});

/* ================================================================== *
 * 第 4 层 · 静态接线
 * ================================================================== */

test('R100-09 · 接线：两个调用点都换成 guard，匿名白名单含签发端点，路由真的注册了', () => {
  const auth = readCode('server/routes/auth.js');
  const guardCalls = (auth.match(/captchaNative\.guard\(/g) || []).length;
  assertEqual(guardCalls, 2, `登录与注册都必须走 guard（实际 ${guardCalls} 处）`);
  assert(auth.indexOf("router.post('/auth/login'") < auth.indexOf('captchaNative.guard('),
    'guard 必须挂在登录处理函数里');

  /**
   * ⚠️ 这里**不能**用 `readCode()`（"先剥块注释、再剥行注释"）。
   * `server/index.js` 第 202 行是一句行注释，正文里写着形如 `/api/` + 两个星号的
   * 通配写法 —— 那个「斜杠 + 星号」会被块注释正则当成**注释开头**，一路吃到下一条
   * 注释的收尾标记，把中间的 `const PUBLIC_API = new Set([...])` **整段吞掉**。
   * 于是断言永远为假：白名单明明加了，测试却说没加。
   * 改为**只截取数组字面量本身**，再丢掉其中整行行注释后逐个取字符串 ——
   * 既不会误吞，也不会被注释满足（注释里写一个 '/captcha/native' 不算数）。
   */
  const raw = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const m = /const PUBLIC_API = new Set\(\[([\s\S]*?)\]\);/.exec(raw);
  assert(m, '自证：必须能取到 PUBLIC_API 的数组字面量（取不到时本断言无从判定）');
  const entries = [...m[1].replace(/^[ \t]*\/\/[^\n]*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert(entries.length > 5, `自证：白名单应有若干条目（实际解析到 ${entries.length} 条）`);
  assert(entries.includes('/captcha/native'), "PUBLIC_API 必须包含 '/captcha/native'（客户端在登录之前就要拿题）");

  const capRoute = readCode('server/routes/captcha.js');
  assert(capRoute.includes("'/captcha/native'"), 'routes/captcha.js 必须注册 /captcha/native');
  assert(capRoute.includes('security.nativeCaptchaLimiter'), '签发端点必须按 IP 限流（匿名端点，防内存灌入）');
});

test('R100-10 · 注册同样可用：客户端带着题能越过人机验证（走 400 入参校验，不再是 403）', async () => {
  const restoreEnv = envPatch({ NATIVE_CAPTCHA: 'on' });
  captchaNative._resetForTest();
  setCaptchaEnabled(true);
  try {
    // 先把注册模式打开（默认可能是 closed）
    const site = configStore.siteView(configStore.load());
    const prevMode = site.registration;
    configStore.save({ site: Object.assign({}, configStore.load().site, { registration: 'open' }) });

    try {
      /**
       * ⚠️ 探针必须选在**人机验证之后**才执行的那一步。
       * 注册的处理顺序是：注册模式 → 邀请码格式 → 两次口令一致 → **人机验证**
       * → 核销 → `addUser()`。所以「两次口令不一致」在 captcha **之前**就返回了，
       * 拿它当判据会让两条请求都是 400，什么也证明不了。
       * 口令强度校验在 `addUser()` 里 ⇒ 用 3 位口令当探针，它能走到 captcha 之后。
       */
      const first = await api('POST', '/api/auth/register', {
        headers: { 'X-Kepler-Client': CLIENT },
        body: { username: 'r100reg', password: '123', confirmPassword: '123' },
      });
      assertEqual(first.status, 403, '没答题时应被挡在人机验证');
      assertEqual(first.json.needCaptcha, true);

      const second = await api('POST', '/api/auth/register', {
        headers: { 'X-Kepler-Client': CLIENT },
        body: {
          username: 'r100reg',
          password: '123',
          confirmPassword: '123',
          nativeToken: first.json.captcha.token,
          nativeAnswer: solve(first.json.captcha.question),
        },
      });
      /**
       * ⭐ 要的是 **400「密码长度至少 8 位」**：它证明人机验证已过（否则是 403
       *   needCaptcha），且请求确实进到了 `addUser()`。用弱口令而不是真建账户，
       *   用例之间不残留任何用户。
       */
      assertEqual(second.status, 400, `答对后应进到建号校验（400），实际 ${second.status} ${JSON.stringify(second.json)}`);
      assertEqual(second.json.error, '密码长度至少 8 位');
    } finally {
      configStore.save({ site: Object.assign({}, configStore.load().site, { registration: prevMode }) });
    }
  } finally {
    restoreEnv();
    setCaptchaEnabled(false);
  }
});
