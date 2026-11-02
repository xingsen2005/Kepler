/**
 * 测试：原生验证码（R100）
 *
 * 这条能力的存在理由是「**没有浏览器 / WebView 的客户端也要能登录**」，所以本文件
 * 的判据全部围绕一件事：**它只在应当生效的场合生效，而且只放行答对的人**。
 *
 * 刻意覆盖的几条反向边界（每一条都对应一种「看起来修好了」的错法）：
 *  - 开关**默认关闭**：不设 `NATIVE_CAPTCHA` 时，客户端请求必须原样走网页分支
 *    （否则等于默认给所有人开了一条绕过 reCAPTCHA 的路）；
 *  - 验证码**全局关闭**时，两条分支都不该触发（客户端也不该被要求答题）；
 *  - 非客户端请求即使开着原生开关也必须走网页分支；
 *  - 题目**一次性**（答对即删）、有 **TTL**、有**次数上限**；
 *  - 答案归一化（全角数字 / 空格）只影响输入噪音，不放宽判据。
 */
const test = require('node:test');

const { assert, assertEqual, assertMatch, ROOT } = require('./helpers');
const path = require('node:path');

const MOD = path.join(ROOT, 'server', 'captcha-native.js');
const captchaNative = require(MOD);

/** 一个只提供 `load()` 的最小 configStore（`captcha.resolveConfig` 只用这一个方法） */
function fakeStore(captchaCfg) {
  return { load: () => ({ captcha: captchaCfg || {} }) };
}

/** 浏览器味道的请求（不带客户端标识） */
function browserReq() {
  return { headers: { host: 'example.com' } };
}

/** 客户端味道的请求 */
function nativeReq(tag = 'kepler-android/1.0') {
  return { headers: { host: 'example.com', 'x-kepler-client': tag } };
}

/** 从题面反解答案（题面格式由 `makeQuestion()` 决定，是本模块自有的契约） */
function solve(question) {
  const m = /请计算 (\d+) ([+\-×]) (\d+)/.exec(question);
  assert(m, `题面格式不符：${question}`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (m[2] === '+') return String(a + b);
  if (m[2] === '-') return String(a - b);
  return String(a * b);
}

/** 起一份干净的运行环境：预定环境变量，结束后还原 */
function withEnv(t, patch) {
  const keys = Object.keys(patch);
  const old = {};
  for (const k of keys) {
    old[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  captchaNative._resetForTest();
  t.after(() => {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    captchaNative._resetForTest();
  });
}

const ON = { NATIVE_CAPTCHA: 'on', NATIVE_CAPTCHA_CLIENTS: undefined };
const OFF = { NATIVE_CAPTCHA: undefined, NATIVE_CAPTCHA_CLIENTS: undefined };

/* ============================ 开关与分支选择 ============================ */

test('R100-模块：默认关闭 —— 不设 NATIVE_CAPTCHA 时客户端也走网页分支（不签题）', async (t) => {
  withEnv(t, OFF);
  assertEqual(captchaNative.enabled(), false, '未设置环境变量时必须视为关闭（安全默认）');

  const r = await captchaNative.guard({
    req: nativeReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, fakeStore({ enabled: true, siteKey: 'sk', secretKey: 'ss' }));

  // 网页分支走到 `captcha.verify` ⇒ 没有 token ⇒ token_missing（而不是签一道题出来）
  assertEqual(r.passed, false);
  assertEqual(r.reason, 'captcha_token_missing', '默认关闭时必须仍是原来那条「请先完成人机验证」');
  assertEqual(r.challenge, undefined, '默认关闭时不得签发任何题目');
});

test('R100-模块：验证码全局关闭时，客户端也不被要求答题', async (t) => {
  withEnv(t, ON);
  const r = await captchaNative.guard({
    req: nativeReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, fakeStore({ enabled: false }));
  assertEqual(r.passed, true, '验证码关闭 = 两条分支都不触发，客户端应直接放行');
  assertEqual(r.reason, 'disabled');
  assertEqual(r.challenge, undefined);
});

test('R100-模块：开关打开但不带客户端标识 —— 仍然走网页分支', async (t) => {
  withEnv(t, ON);
  const r = await captchaNative.guard({
    req: browserReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, fakeStore({ enabled: true, siteKey: 'sk', secretKey: 'ss' }));
  assertEqual(r.reason, 'captcha_token_missing', '浏览器必须继续被 reCAPTCHA 拦着');
  assertEqual(r.challenge, undefined, '浏览器不该收到算术题');
});

/* ============================ 答题闭环 ============================ */

test('R100-模块：客户端首次提交不发题就不放行 —— 返回题面且 retry=false', async (t) => {
  withEnv(t, ON);
  const r = await captchaNative.guard({
    req: nativeReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, fakeStore({ enabled: true, siteKey: 'sk', secretKey: 'ss' }));

  assertEqual(r.passed, false);
  assertEqual(r.reason, 'native_challenge');
  assertEqual(r.retry, false, '第一次是「请完成」，不是「验证失败」');
  assert(r.challenge && r.challenge.token, '必须带 token');
  assertMatch(r.challenge.question, /^请计算 \d+ [+\-×] \d+ = \?$/, '题面必须是一句可读的算式');
  assert(r.challenge.expiresAt, '必须带过期时间供客户端提示');
});

test('R100-模块：答对即通过，且同一枚 token 不可能通过第二次（一次性）', async (t) => {
  withEnv(t, ON);
  const store = fakeStore({ enabled: true, siteKey: 'sk', secretKey: 'ss' });
  const first = await captchaNative.guard({
    req: nativeReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, store);
  const { token, question } = first.challenge;
  const answer = solve(question);

  const ok = await captchaNative.guard({
    req: nativeReq(), body: { nativeToken: token, nativeAnswer: answer }, remoteip: '1.1.1.1', expectedHosts: [],
  }, store);
  assertEqual(ok.passed, true, `答案 ${answer} 应通过（题面：${question}）`);
  assertEqual(ok.reason, 'native_ok');

  const replay = await captchaNative.guard({
    req: nativeReq(), body: { nativeToken: token, nativeAnswer: answer }, remoteip: '1.1.1.1', expectedHosts: [],
  }, store);
  assertEqual(replay.passed, false, '重放必须失败 —— token 是用一次就作废的');
  assertEqual(replay.reason, 'native_expired', '已消费的 token 与过期同形（不区分「用过了」与「没见过」，少一条探测面）');
  assert(replay.challenge && replay.challenge.token !== token, '重放时要发一道**新**题');
});

test('R100-模块：答错要换题并给出 captchaError 的文案来源（retry=true）', async (t) => {
  withEnv(t, ON);
  const store = fakeStore({ enabled: true, siteKey: 'sk', secretKey: 'ss' });
  const first = await captchaNative.guard({
    req: nativeReq(), body: {}, remoteip: '1.1.1.1', expectedHosts: [],
  }, store);
  const { token, question } = first.challenge;
  const wrong = String(Number(solve(question)) + 1);

  const bad = await captchaNative.guard({
    req: nativeReq(), body: { nativeToken: token, nativeAnswer: wrong }, remoteip: '1.1.1.1', expectedHosts: [],
  }, store);
  assertEqual(bad.passed, false);
  assertEqual(bad.reason, 'native_wrong');
  assertEqual(bad.retry, true, '答错要显示「验证失败」而不是「请完成」');
  assert(bad.challenge && bad.challenge.token !== token, '答错必须换一道新题');
  assertEqual(captchaNative.failText(bad.reason), '答案不正确');
});

test('R100-模块：TTL 到期后作废（不靠定时器，按 now 判定）', () => {
  captchaNative._resetForTest();
  const c = captchaNative.issue(0);
  const answer = solve(c.question);
  const late = captchaNative.TTL_MS + 1;

  assertEqual(captchaNative.verify(c.token, answer, late).reason, 'expired', '过期后即使答案正确也必须失败');
  // 自证：同一枚 token 在有效期内是能过的（否则上一条的"过期"可能只是"根本不认"）
  const c2 = captchaNative.issue(0);
  assertEqual(captchaNative.verify(c2.token, solve(c2.question), 1).ok, true);
});

test('R100-模块：同一枚 token 答错满 3 次即作废（次数上限）', () => {
  captchaNative._resetForTest();
  const c = captchaNative.issue();
  const wrong = String(Number(solve(c.question)) + 1);
  assertEqual(captchaNative.verify(c.token, wrong).reason, 'wrong');
  assertEqual(captchaNative.verify(c.token, wrong).reason, 'wrong');
  assertEqual(captchaNative.verify(c.token, wrong).reason, 'wrong');
  // 第 3 次之后记录已删除 ⇒ 第 4 次是 expired（而不是继续无限试）
  assertEqual(captchaNative.verify(c.token, wrong).reason, 'expired');
  // 自证：即使此时答对也进不去
  assertEqual(captchaNative.verify(c.token, solve(c.question)).ok, false);
});

/* ============================ 输入归一化 ============================ */

test('R100-模块：全角数字与空白属输入噪音，归一化后照常通过', () => {
  captchaNative._resetForTest();
  const c = captchaNative.issue();
  const answer = solve(c.question);
  const full = String(answer).replace(/[0-9]/g, (d) => String.fromCharCode(0xFF10 + Number(d)));
  assertEqual(captchaNative.verify(c.token, ` ${full} `).ok, true, '中文输入法打出的全角数字 + 前后空格不该算答错');
});

test('R100-模块：超长答案不受理（不给超长串留解析成本）', () => {
  captchaNative._resetForTest();
  const c = captchaNative.issue();
  const long = '9'.repeat(captchaNative.MAX_ANSWER_LEN + 1);
  assertEqual(captchaNative.verify(c.token, long).reason, 'invalid');
  assertEqual(captchaNative.normalizeAnswer(long), '', '超长输入归一为空 —— 与"没填"同形');
});

/* ============================ 客户端白名单 ============================ */

test('R100-模块：客户端标识按前缀白名单判定，且不认通配', (t) => {
  withEnv(t, ON);
  assertEqual(captchaNative.isNativeClient(nativeReq('kepler-android/1.0')), true);
  assertEqual(captchaNative.isNativeClient(nativeReq('Kepler-Android/2.3')), true, '前缀比较应忽略大小写');
  assertEqual(captchaNative.isNativeClient(nativeReq('kepler-ios/1.0')), false, '不在白名单的客户端不该被放进来');
  assertEqual(captchaNative.isNativeClient(nativeReq('*')), false, '通配符不是前缀，必须不被接受');
  assertEqual(captchaNative.isNativeClient(browserReq()), false);

  process.env.NATIVE_CAPTCHA_CLIENTS = 'kepler-ios/, kepler-android/';
  assertEqual(captchaNative.isNativeClient(nativeReq('kepler-ios/1.0')), true, '白名单可扩展（逗号分隔）');
  assertEqual(captchaNative.clientPrefixes().length, 2);
  assertEqual(captchaNative.isNativeClient(nativeReq('x'.repeat(65))), false, '超长标识直接拒绝（不做前缀比对）');
});

/* ============================ 内存边界 ============================ */

test('R100-模块：签发不会让内存表无界增长（过期项先清、满则按插入序淘汰）', (t) => {
  withEnv(t, ON);
  // 塞满到上限：每条 TTL 都已过期 ⇒ 下一次签发应先把它们清干净，而不是继续长
  for (let i = 0; i < captchaNative.MAX_ENTRIES; i += 1) captchaNative.issue(0);
  assertEqual(captchaNative.state().pending, captchaNative.MAX_ENTRIES, '自证：表确实被塞满了');
  captchaNative.issue(Date.now());
  assertEqual(captchaNative.state().pending, 1, '过期项必须在腾地方时被清掉（否则匿名端点就是一条内存增长路径）');

  // 未过期时灌三倍上限：容量必须始终受控，且**只淘汰掉一批**（不是每次清空）
  for (let i = 0; i < captchaNative.MAX_ENTRIES * 3; i += 1) captchaNative.issue();
  const after = captchaNative.state().pending;
  assert(after <= captchaNative.MAX_ENTRIES, `表容量必须恒 ≤ ${captchaNative.MAX_ENTRIES}（实际 ${after}）`);
  assert(after > Math.floor(captchaNative.MAX_ENTRIES / 2),
    `淘汰后应仍保留大部分有效题目（实际 ${after}）—— 每次清空会让正常用户手里的题莫名失效`);
});
