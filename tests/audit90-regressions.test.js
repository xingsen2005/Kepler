/**
 * 第九十轮护栏：四个历史待办（PAY-F1 / FS-S1 / 改用户名 / ops.js）
 *
 * 本轮不是「审计报告逐条复核」，而是把 §三·待办里挂着的四件事一次性收口：
 *
 *  ① **PAY-F1**（钱）—— 换渠道 / 换券时只把旧单在本地标失败，**网关侧那笔仍可付**，
 *     用户在旧收银台上再扫一次就是双份付款。现在必须先向网关关单，再决定要不要建新单。
 *  ② **FS-S1**（内存）—— 上传走 `express.raw({limit:'64mb'})`，body 在进入 handler
 *     **之前**就已整个进内存；N 个并发就是 N × 64MB，进程被 OOM 杀掉时症状是整站 502。
 *     现在在读 body **之前**就按「并发数 + 在途字节」双限额拦下。
 *  ③ **改用户名不校验当前密码**（账户接管）—— 用户名是登录凭据的另一半，改掉它
 *     真实所有者连登录都进不去。现在与改密 / 改邮箱同口径，要求当前密码。
 *  ④ **`ops.js` 调未定义的 `currentItems()`**（最高优先级）—— **复核结论：该缺陷已不存在**
 *     （R27-01 就修掉了，改走 `explorer.itemOf()`）。按 R87 的教训「报告的第一个
 *     待验证项是它自己的前提」，这里不假装修复，而是①把「不存在」钉成护栏，
 *     ②修掉同一函数里**真实存在**的另一个缺陷：`renameOne()` 连调两次
 *     `explorerRefresh()`，一次重命名会打两轮 `/fs/list`。
 *
 * ## 分层（每条判据都落在**实际被执行的那一层**）
 *
 *  · 计数层：`upload-gate` 的 `tryAcquire` / `release` / `snapshot`
 *  · 中间件层：真 express + 真 HTTP，超限时 **handler 从未被调用**（证明拦在解析之前）
 *  · 网关层：`paymentGateway.closeCharge` 对支付宝 / 微信各自的状态码语义
 *  · 路由层：换渠道时「先关单、后改本地状态」，关不掉就**不建新单**
 *  · 前端层：`profile.js` 的改名分支必须带 `currentPassword`
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

/** ⚠️ 先设数据目录再 require 任何 store，否则会写到项目真实的 data/ */
const tmp = makeTempDir('r90-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const express = require(path.join(ROOT, 'node_modules', 'express'));

/** 起一个只挂指定路由的本地服务（`listen(0)` 拿临时端口，避免并发跑文件时撞端口） */
async function serve(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** 假 res：只实现本模块用到的那几个方法（够用即可，不引 sinon） */
function fakeRes() {
  const res = {
    headers: {}, statusCode: 200, body: null, listeners: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    emit(ev) { (this.listeners[ev] || []).forEach((f) => f()); },
  };
  return res;
}

/**
 * 临时改环境变量并保证复原（闸门**每次调用**时读环境，故可逐条用例改）。
 *
 * ⚠️ 必须是 async 并 `await fn()`：同步版会在 `request()` 刚返回 Promise、
 * 请求还没到服务端时就把环境变量还原 —— 于是「1MB 上限拦截 2MB 请求」永远测不出来。
 */
async function withEnv(pairs, fn) {
  const old = {};
  for (const k of Object.keys(pairs)) { old[k] = process.env[k]; process.env[k] = String(pairs[k]); }
  try { return await fn(); } finally {
    for (const k of Object.keys(pairs)) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  }
}

/* ================================================================== *
 * ① FS-S1：上传闸门的计数语义
 * ================================================================== */

test('R90-01 · FS-S1 · 并发数与在途字节双限额，且释放幂等（名额不能泄漏）', () => {
  const gate = require(SERVER('upload-gate.js'));
  gate.reset();

  withEnv({ UPLOAD_MAX_CONCURRENT: 2, UPLOAD_MAX_INFLIGHT_MB: 8 }, () => {
    /* ---- 并发上限：第 3 个必须被拒 ---- */
    const a = gate.tryAcquire(1024);
    const b = gate.tryAcquire(1024);
    assertEqual(a.ok, true, '前两个应放行');
    assertEqual(b.ok, true, '前两个应放行');
    const c = gate.tryAcquire(1024);
    assertEqual(c.ok, false, `★超过并发上限必须拒绝，实际 ${JSON.stringify(c)}`);
    assertMatch(c.reason, /同时进行的上传任务过多/, '文案要说清是并发数打满（不是文件太大）');
    assertEqual(c.retryAfter > 0, true, '要给出可执行的 Retry-After');

    gate.release(a.ticket);
    gate.release(b.ticket);
    assertEqual(gate.snapshot().count, 0, '释放后计数必须归零');
  });

  /* ---- 在途字节上限：并发没满也可能被拒 ---- */
  gate.reset();
  withEnv({ UPLOAD_MAX_CONCURRENT: 100, UPLOAD_MAX_INFLIGHT_MB: 8 }, () => {
    const MB = 1024 * 1024;
    assertEqual(gate.tryAcquire(5 * MB).ok, true, '第一笔 5MB 应放行');
    const over = gate.tryAcquire(5 * MB);
    assertEqual(over.ok, false, `★5+5 > 8MB 必须拒绝（只限并发挡不住超大文件），实际 ${JSON.stringify(over)}`);
    assertMatch(over.reason, /待处理上传数据过多/, '文案要区分「字节打满」与「并发打满」');
  });

  /* ---- 释放必须幂等：重复释放不得把计数减成负数 ---- */
  gate.reset();
  withEnv({ UPLOAD_MAX_CONCURRENT: 4, UPLOAD_MAX_INFLIGHT_MB: 8 }, () => {
    const t = gate.tryAcquire(1024);
    gate.release(t.ticket);
    gate.release(t.ticket);
    gate.release(t.ticket);
    const s = gate.snapshot();
    assertEqual(s.count, 0, '重复释放不得让在途数变成负数（负数会让闸门永久失效）');
    assertEqual(s.bytes, 0, '重复释放不得让在途字节变成负数');
  });
  gate.reset();
});

test('R90-02 · FS-S1 · 闸门返回 503 + Retry-After，且在响应结束时释放名额', () => {
  const gateModule = require(SERVER('upload-gate.js'));
  gateModule.reset();

  withEnv({ UPLOAD_MAX_CONCURRENT: 1, UPLOAD_MAX_INFLIGHT_MB: 8 }, () => {
    const mw = gateModule.gate();
    /* 先占满 */
    const held = gateModule.tryAcquire(1024);
    assertEqual(held.ok, true, '前置：先占掉唯一的名额');

    let called = false;
    const res = fakeRes();
    mw({ headers: { 'content-length': '10' } }, res, () => { called = true; });
    assertEqual(called, false, '超限时绝不能放行到下一层（handler 里再判就晚了，body 已在内存里）');
    assertEqual(res.statusCode, 503, `★超限必须回 503（不是 400/429），实际 ${res.statusCode}`);
    assertEqual(res.headers['retry-after'], '2', '必须带 Retry-After，前端据此提示"稍后重试"');
    assertEqual(res.body && res.body.code, 'UPLOAD_BUSY', '错误码供前端区分"忙"与"参数错"');
    gateModule.release(held.ticket);
  });

  /* ---- 放行路径：`res` 关闭时自动释放（abort 与正常结束都走这里） ---- */
  gateModule.reset();
  withEnv({ UPLOAD_MAX_CONCURRENT: 1, UPLOAD_MAX_INFLIGHT_MB: 8 }, () => {
    const mw = gateModule.gate();
    const res = fakeRes();
    let called = false;
    mw({ headers: { 'content-length': '1024' } }, res, () => { called = true; });
    assertEqual(called, true, '有名额时必须放行');
    assertEqual(gateModule.snapshot().count, 1, '放行后应记一笔在途');
    res.emit('close'); // 正常结束 / 客户端断开都会触发
    assertEqual(gateModule.snapshot().count, 0, '★响应结束必须归还名额，否则名额只减不增（最终整站不能上传）');
    res.emit('close');
    assertEqual(gateModule.snapshot().count, 0, '重复 close 不得把计数减成负数');
  });

  /* ---- 无 Content-Length 时按**单请求上限**记账（宁多算不少算） ---- */
  gateModule.reset();
  withEnv({ UPLOAD_REQUEST_MAX_MB: 7 }, () => {
    assertEqual(gateModule.declaredBytes({ headers: {} }), null, '缺 Content-Length 应返回 null（由调用方兜底）');
    const mw = gateModule.gate();
    const res = fakeRes();
    let called = false;
    mw({ headers: {} }, res, () => { called = true; });
    assertEqual(called, true, '单请求上限内应放行');
    assertEqual(gateModule.snapshot().bytes, 7 * 1024 * 1024,
      `无 Content-Length 时必须按单请求上限记账，实际 ${gateModule.snapshot().bytes}`);
    res.emit('close');
  });
  gateModule.reset();
});

test('R90-03 · FS-S1 · 闸门必须排在 express.raw 之前（否则挡的是处理，不是内存）', () => {
  /**
   * 结构判据：两条上传路由里 `uploadGate.gate()` 必须**先于** `express.raw(`。
   * 只断言「两者都存在」是没有意义的 —— 顺序反了就是本轮要修的那个 bug 原样复现。
   */
  const src = readSrc('server/routes/fs.js');
  const lines = src.split('\n').filter((l) => l.includes('express.raw(') && l.includes("'/fs/upload/"));
  assertEqual(lines.length, 2, `应恰好两条上传路由（simple / chunk），实际 ${lines.length}`);
  for (const line of lines) {
    const gateAt = line.indexOf('uploadGate.gate()');
    const rawAt = line.indexOf('express.raw(');
    assert(gateAt >= 0, `上传路由必须挂闸门：${line.trim()}`);
    assert(gateAt < rawAt,
      `★闸门必须排在 express.raw 之前（否则请求体已进内存，闸门形同虚设）：${line.trim()}`);
  }
});

test('R90-04 · FS-S1 · 真 HTTP：超限请求的 handler 从未被调用（证明拦在解析之前）', async () => {
  const gateModule = require(SERVER('upload-gate.js'));
  gateModule.reset();
  const app = express();
  let handlerCalls = 0;
  /** 与生产同序：闸门 → raw → handler */
  const route = (req, res) => { handlerCalls += 1; res.json({ ok: true, bytes: req.body.length }); };
  app.put('/up/simple', gateModule.gate(), express.raw({ type: () => true, limit: '64mb' }), route);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const r = await withEnv({ UPLOAD_MAX_INFLIGHT_MB: 1, UPLOAD_MAX_CONCURRENT: 8 },
      () => request(port, 'PUT', '/up/simple', { body: Buffer.alloc(2 * 1024 * 1024) }));
    assertEqual(r.status, 503, `2MB > 1MB 上限必须被拒，实际 ${r.status}`);
    assertEqual(r.json && r.json.code, 'UPLOAD_BUSY', '回包要能被前端认出来');
    assertEqual(handlerCalls, 0, '★handler 绝不能被执行到（执行了就说明 body 已经进内存）');
    /* 正向对照：放宽上限后同一请求必须成功，证明闸门不是「一律拒绝」 */
    await withEnv({ UPLOAD_MAX_INFLIGHT_MB: 64, UPLOAD_MAX_CONCURRENT: 8 }, async () => {
      const ok = await request(port, 'PUT', '/up/simple', { body: Buffer.alloc(2 * 1024 * 1024) });
      assertEqual(ok.status, 200, `上限内必须放行，实际 ${ok.status} ${ok.raw}`);
      assertEqual(ok.json.bytes, 2 * 1024 * 1024, 'body 应原样到达 handler');
    });
    assertEqual(handlerCalls, 1, '只有放行的那一次进了 handler');
  } finally {
    gateModule.reset();
    await new Promise((r) => server.close(r));
  }
});

/* ================================================================== *
 * ② 改用户名必须校验当前密码
 * ================================================================== */

test('R90-05 · 前端：改名分支必须带 currentPassword（空则当场拦下，不裸奔到服务端）', () => {
  const src = readSrc('public/js/profile.js');
  // R98：资料编辑由弹窗改为页面后，save() 不再接对话框的 overlay/close
  const start = src.indexOf('async function save() {');
  assert(start >= 0, 'profile.js 里应存在 save()（取不到 = 本条检查已失效）');
  const end = src.indexOf('const r = await API.updateMyProfile(body);', start);
  assert(end > start, 'save() 里应存在提交动作（取不到 = 本条检查已失效）');
  const body = src.slice(start, end);

  assert(/username\.trim\(\)\s*!==\s*String\(me\.username/.test(body),
    '★必须**比较之后**才判「改没改」：表单每次都会把原用户名原样带上来，不比就要求密码等于每次保存都要输密码');
  assert(/修改用户名前请先输入当前密码/.test(body),
    '缺当前密码时要在前端就地拦下并说清原因');
  const assigns = (body.match(/body\.currentPassword\s*=\s*currentPw/g) || []).length;
  assert(assigns >= 2,
    `body.currentPassword 至少应出现在「改名」与「改密/改邮箱」两条路径上，实际 ${assigns} 处`);

  /**
   * ⚠️ 只数总数是不够的：本文件里还有「改密」「改邮箱」两处同样的赋值，撤掉改名那一处
   * 总数仍是 2 —— 判据会被另外两处**满足**（R90-06a 反向变异实测 fail=0 抓到过）。
   * 因此必须切出**改名分支本身**再断言。
   */
  const nameAt = body.indexOf('if (username.trim() !== String(me.username');
  const passAt = body.indexOf('if (password) {');
  assert(nameAt >= 0 && passAt > nameAt, '应能切出改名分支（取不到 = 本条检查已失效）');
  const nameBlock = body.slice(nameAt, passAt);
  assert(/body\.currentPassword\s*=\s*currentPw/.test(nameBlock),
    '★改名分支内部必须自己带上 currentPassword —— 上面那个总数会被改密/改邮箱两处满足');
});

test('R90-06 · 服务端：改用户名与改密走同一道闸门（needsCurrent 必须被置位）', () => {
  const src = readSrc('server/routes/users.js');
  const marker = "if (b.username !== undefined) {";
  const at = src.indexOf(marker);
  assert(at >= 0, 'users.js 里应存在只改用户名的分支（取不到 = 本条检查已失效）');
  const branch = src.slice(at, at + 400);
  assert(/needsCurrent\s*=\s*true/.test(branch),
    '★改用户名必须置 needsCurrent（否则服务端不校验当前密码，前端拦截只是装饰）');
  assert(/String\(b\.username\)\s*!==\s*String\(me\.username\)/.test(branch),
    '要与**当前**用户名比较：同值提交（表单原样带回）不能算改动');
});

/* ================================================================== *
 * ③ PAY-F1：网关侧关单
 * ================================================================== */

const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const signContent = (content) => crypto.createSign('RSA-SHA256').update(content, 'utf8')
  .sign(KEY_PAIR.privateKey, 'base64');

/**
 * 把**全局 `fetch`** 换成一次性桩。
 *
 * 网关出站只有一个实现（`fetchWithTimeout` 里那句 `fetch(...)`），因此桩全局 fetch
 * 就能同时覆盖支付宝（URL 里带签名）与微信（走 Authorization 头）两条关单路径，
 * 而且完全不产生真实网络请求。
 */
async function withFetchStub(impl, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}
/** 造一个"够用"的 Response（fetchWithTimeout 只用到 ok/status/text()/body.cancel） */
const fakeResponse = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  body: { cancel: async () => {} },
  text: async () => text,
});

const alipayCfg = () => ({
  appId: '2021000000000000', privateKey: PKCS8_PEM, alipayPublicKey: SPKI_PEM, signType: 'RSA2',
  gateway: 'https://openapi.alipay.com/gateway.do',
});

test('R90-07 · PAY-F1 · 支付宝关单：真签名才算关掉，假签名一律 error', async () => {
  const gw = require(SERVER('payment-gateway.js'));
  const order = { id: 'o-r90-07', amountFen: 500, platform: 'alipay' };
  const node = '{"code":"10000","msg":"Success"}';

  /* ---- ① 真签名 ⇒ closed ---- */
  await withFetchStub(() => fakeResponse(200,
    `{"alipay_trade_close_response":${node},"sign":"${signContent(node)}"}`), async (calls) => {
    const r = await gw.closeCharge('alipay', alipayCfg(), order);
    assertEqual(r.ok, true, `真签名应判为已关闭，实际 ${JSON.stringify(r)}`);
    assertEqual(r.state, 'closed', `state 应为 closed，实际 ${r.state}`);
    assert(/method=alipay\.trade\.close/.test(calls[0].url),
      `必须调用关单接口（不是查单），实际 ${calls[0].url}`);
    assert(/out_trade_no/.test(decodeURIComponent(calls[0].url)), '商户订单号要带进 biz_content');
  });

  /* ---- ② 签名对不上 ⇒ 绝不能当已关闭（否则等于相信了伪造的网关） ---- */
  await withFetchStub(() => fakeResponse(200,
    `{"alipay_trade_close_response":${node},"sign":"AAAA"}`), async () => {
    const r = await gw.closeCharge('alipay', alipayCfg(), order);
    assertEqual(r.ok, false, '★签名不对的关单响应绝不能当成功');
    assertEqual(r.state, 'error', `应为 error，实际 ${r.state}`);
    assertMatch(r.error, /签名/, '文案要指名签名校验失败（否则管理员去查网络）');
  });

  /* ---- ③ 交易不存在 ⇒ not_found（用户没跳到收银台，等价于已关） ---- */
  const nf = '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST"}';
  await withFetchStub(() => fakeResponse(200,
    `{"alipay_trade_close_response":${nf},"sign":"${signContent(nf)}"}`), async () => {
    const r = await gw.closeCharge('alipay', alipayCfg(), order);
    assertEqual(r.ok, true, `交易不存在应视为「没有可付的单」，实际 ${JSON.stringify(r)}`);
    assertEqual(r.state, 'not_found', `state 应为 not_found，实际 ${r.state}`);
  });
});

test('R90-08 · PAY-F1 · 微信关单：204=已关、不存在=已关、ORDERPAID=已支付（必须单独一档）', async () => {
  const gw = require(SERVER('payment-gateway.js'));
  const cfg = { mchId: 'm1', appId: 'a1', privateKey: PKCS8_PEM, certSerialNo: 'S1' };
  const order = { id: 'o-r90-08', amountFen: 500, platform: 'wechat' };

  /* ⚠️ 断言必须在 closeCharge **之后**跑：桩回调进入时请求还没发出，calls 还是空的 */
  const closed = await withFetchStub(() => fakeResponse(204, ''), async (calls) => {
    const r = await gw.closeCharge('wechat', cfg, order);
    return { r, calls };
  });
  assertMatch(closed.calls[0].url, /\/v3\/pay\/transactions\/out-trade-no\/o-r90-08\/close$/,
    `必须打 close 端点，实际 ${closed.calls[0].url}`);
  assertEqual(closed.r.ok, true, `204 应判为已关闭，实际 ${JSON.stringify(closed.r)}`);
  assertEqual(closed.r.state, 'closed', `state 应为 closed，实际 ${closed.r.state}`);

  const nf = await withFetchStub(() => fakeResponse(404, '{"code":"ORDER_NOT_EXIST","message":"不存在"}'),
    () => gw.closeCharge('wechat', cfg, order));
  assertEqual(nf.ok, true, '订单不存在 ⇒ 网关侧没有可付的单，等价已关闭');
  assertEqual(nf.state, 'not_found', `state 应为 not_found，实际 ${nf.state}`);

  const paid = await withFetchStub(() => fakeResponse(400, '{"code":"ORDERPAID","message":"订单已支付"}'),
    () => gw.closeCharge('wechat', cfg, order));
  assertEqual(paid.ok, false, '已支付的单当然关不掉');
  assertEqual(paid.state, 'paid',
    `★ORDERPAID 必须单独成档：它意味着「用户已经给过钱」，与「关不掉、不知道」是两回事，实际 ${paid.state}`);

  const boom = await withFetchStub(() => fakeResponse(500, '{"message":"系统繁忙"}'),
    () => gw.closeCharge('wechat', cfg, order));
  assertEqual(boom.ok, false, '网关故障不得当作已关闭');
  assertEqual(boom.state, 'error', `应为 error，实际 ${boom.state}`);
  assertMatch(boom.error, /系统繁忙/, '错误信息要带回来，供管理端对账');
});

/* ================================================================== *
 * ④ 路由层：换渠道 / 换券时先关单，再决定建不建新单
 * ================================================================== */

const s3 = require(SERVER('s3.js'));
s3.getClient = () => ({
  headObject(_p, cb) { cb(null, { headers: { 'content-length': '5' } }); },
  getObject(params, cb) { params.Output.end(Buffer.from('hello')); cb(null, {}); },
});
const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});
configStore.getPayment = () => ({
  enabled: true,
  siteUrl: 'http://127.0.0.1:3000',
  platforms: { alipay: { enabled: true, appId: 'a', privateKey: 'K' }, wechat: { enabled: true, mchId: 'm' } },
});
const statsStore = require(SERVER('stats-store.js'));
const logs = [];
statsStore.addLog = (e) => logs.push(e);
statsStore.trackBucket = () => {};
statsStore.track = () => {};
const paymentRules = require(SERVER('payment-rules.js'));
paymentRules.snapshot = () => ({
  enabled: true, states: { alipay: true, wechat: true }, configuredMap: { alipay: true, wechat: true },
  available: ['alipay', 'wechat'],
});
paymentRules.resolvePaidState = () => ({
  required: true, effective: true, amountFen: 100, currency: 'CNY', reason: '',
});
const paymentProviders = require(SERVER('payment-providers.js'));
paymentProviders.isConfigured = () => true;

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

let seq = 0;
async function makePaidLink() {
  seq += 1;
  return shareStore.create({
    key: 'r90-' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'r90-' + seq + '.txt', size: 5, expiresHours: 0, maxDownloads: 0,
    password: null, paid: { required: true, amountFen: 100 }, createdBy: 'tester',
  });
}
function makePending(link, platform) {
  return paymentOrders.create({
    linkId: link.id, platform, amountFen: 100, currency: 'CNY',
    fileName: link.fileName, fileKey: link.key, bucket: link.bucket, payerIp: '127.0.0.1',
  });
}
const cookieOf = (link, id) => 'sp_' + link.id + '_pay='
  + encodeURIComponent(paymentOrders.orderToken(paymentOrders.get(id)));

/** 把网关的两个出站动作都打桩：关单结果可控，下单绝不真出网 */
function stubGateway({ close, query }) {
  const origClose = paymentGateway.closeCharge;
  const origCreate = paymentGateway.createCharge;
  const origQuery = paymentGateway.queryCharge;
  const created = [];
  paymentGateway.closeCharge = async (platform, cfg, order) => {
    close.calls.push({ platform, orderId: order.id });
    return typeof close.result === 'function' ? close.result(platform, order) : close.result;
  };
  paymentGateway.createCharge = async (platform, cfg, opts) => {
    created.push({ platform, orderId: opts.order.id });
    return { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
  };
  paymentGateway.queryCharge = async () => query.result;
  return {
    created,
    restore() {
      paymentGateway.closeCharge = origClose;
      paymentGateway.createCharge = origCreate;
      paymentGateway.queryCharge = origQuery;
    },
  };
}

test('R90-09 · PAY-F1 · 换渠道：先关旧单，关掉之后才建新单（旧单状态=failed，且留下 closeState）', async () => {
  const link = await makePaidLink();
  const old = makePending(link, 'alipay');
  const close = { calls: [], result: { ok: true, state: 'closed' } };
  const stub = stubGateway({ close, query: { result: { paid: false, state: 'pending' } } });
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'POST', '/s/' + link.id + '/pay', {
      body: { platform: 'wechat' }, headers: { cookie: cookieOf(link, old.id) },
    });
    /* R83：下单成功是**同源中转页**（200 + meta refresh），不是 3xx —— 表单 POST 后跨域 3xx 会被 CSP 拦掉 */
    assertEqual(r.status, 200, `换渠道后应给出中转页，实际 ${r.status} ${r.raw.slice(0, 200)}`);
    assertMatch(r.raw, /example\.invalid\/pay/, '中转页要带上收银台地址（否则用户没处可付）');
    assertEqual(close.calls.length, 1,
      `★换渠道必须**先在网关侧关单**，实际调用了 ${close.calls.length} 次`);
    assertEqual(close.calls[0].orderId, old.id, '关的必须是那笔被放弃的旧单');
    assertEqual(stub.created.length, 1, '关单成功后应照常建新单');
    assert(stub.created[0].orderId !== old.id, '新单必须是另一笔');
    const after = paymentOrders.get(old.id);
    assertEqual(after.status, 'failed', '旧单在本系统里同样要收尾');
    assertEqual(after.closeState, 'closed', `closeState 要落库（对账用），实际 ${after.closeState}`);
    assert(/更换支付方式/.test(after.failReason), `失败原因要说清是被替换的，实际 ${after.failReason}`);
  } finally {
    stub.restore();
    await srv.close();
  }
});

test('R90-10 · PAY-F1 · 关单失败 ⇒ 不建新单（钱的安全优先于这次便利），旧单保持可付', async () => {
  const link = await makePaidLink();
  const old = makePending(link, 'alipay');
  const close = { calls: [], result: { ok: false, state: 'error', error: '网关连接超时' } };
  const stub = stubGateway({ close, query: { result: { paid: false, state: 'pending' } } });
  const srv = await serve('/', shareRoutes);
  try {
    const before = paymentOrders.listForLink(link.id).length;
    const r = await request(srv.port, 'POST', '/s/' + link.id + '/pay', {
      body: { platform: 'wechat' }, headers: { cookie: cookieOf(link, old.id) },
    });
    assertEqual(r.status, 400, `关不掉时应留在付费页给出说明（payPage 的错误态回 400），实际 ${r.status}`);
    assertMatch(r.raw, /避免同一件商品被付两次/, '文案要说清为什么这次没有建单');
    assertEqual(stub.created.length, 0,
      '★关单失败时绝不能建新单：否则两笔都能付，想回滚也回不掉');
    assertEqual(paymentOrders.listForLink(link.id).length, before, '订单数不得变化');
    assertEqual(paymentOrders.get(old.id).status, 'pending',
      '旧单必须保持 pending —— 它可能仍能付，标失败会让「付了钱却查不到订单」');
    assertEqual(paymentOrders.get(old.id).closeState, 'error', 'closeState 要落成 error，供人工对账');
    assert(logs.some((l) => l.level === 'error' && /未能关闭在途订单/.test(l.detail)),
      '必须留一条 error 日志（事后查对账的唯一线索）');
  } finally {
    stub.restore();
    await srv.close();
  }
});

test('R90-11 · PAY-F1 · 旧单其实已支付 ⇒ 交付那一笔，绝不建第二单', async () => {
  const link = await makePaidLink();
  const old = makePending(link, 'wechat');
  const close = { calls: [], result: { ok: false, state: 'paid', error: '该订单已完成支付' } };
  const stub = stubGateway({ close, query: { result: { paid: true, state: 'paid' } } });
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'POST', '/s/' + link.id + '/pay', {
      body: { platform: 'alipay' }, headers: { cookie: cookieOf(link, old.id) },
    });
    assertEqual(r.status, 303, `应把用户送回分享页去交付已付款的那笔，实际 ${r.status}`);
    assert(/e=paid/.test(String(r.headers.location || '')), `重定向要带 paid 标记，实际 ${r.headers.location}`);
    assertEqual(stub.created.length, 0, '★已经付过钱的人绝不能再被建一笔新单');
    assertEqual(paymentOrders.get(old.id).status, 'paid',
      '★确认已支付必须落到订单状态上（否则页面说"已付"、库里还是"支付中"）');
  } finally {
    stub.restore();
    await srv.close();
  }
});

test('R90-12 · PAY-F1 · 渠道不支持关单（PayPal）⇒ 留痕后继续，不阻塞用户', async () => {
  const link = await makePaidLink();
  const old = makePending(link, 'paypal');
  const close = {
    calls: [], result: { ok: false, state: 'unsupported', error: 'PayPal 订单不支持主动关闭' },
  };
  const stub = stubGateway({ close, query: { result: { paid: false, state: 'pending' } } });
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'POST', '/s/' + link.id + '/pay', {
      body: { platform: 'alipay' }, headers: { cookie: cookieOf(link, old.id) },
    });
    assertEqual(r.status, 200, `不支持关单的渠道不应阻塞用户，实际 ${r.status} ${r.raw.slice(0, 200)}`);
    assertEqual(stub.created.length, 1, '照常建新单');
    assertEqual(paymentOrders.get(old.id).closeState, 'unsupported',
      '要把「这个渠道关不掉」记在订单上（对账时才知道去哪找可能重复付的那笔）');
    assert(logs.some((l) => l.level === 'warn' && /无法在网关侧关闭/.test(l.detail)),
      '必须留一条 warn 日志说明残余风险');
  } finally {
    stub.restore();
    await srv.close();
  }
});

/* ================================================================== *
 * ⑤ ops.js（最高优先级项的复核）
 * ================================================================== */

test('R90-13 · ops.js：`currentItems` 已不存在，且重命名只刷新一次列表', () => {
  const raw = readSrc('public/js/ops.js');
  /** 剥掉注释再判 —— 注释里正是在讲这个历史事故，按原文搜会「命中注释」而假绿 */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert(!/\bcurrentItems\s*\(/.test(code),
    '★ops.js 里不得再出现 currentItems() 调用（该标识符全库从未定义，会抛 ReferenceError）');
  assert(/explorer\.itemOf\(key\)/.test(code), '列表项的唯一归属地是 explorer，应经 itemOf 取用');

  const at = code.indexOf('async renameOne(key) {');
  assert(at >= 0, '应存在 renameOne()（取不到 = 本条检查已失效）');
  const end = code.indexOf('deleteSelected()', at);
  assert(end > at, 'renameOne() 之后应有 deleteSelected()（取不到 = 本条检查已失效）');
  const fn = code.slice(at, end);
  const refreshes = (fn.match(/explorerRefresh\(\)/g) || []).length;
  assertEqual(refreshes, 1,
    `★重命名只该刷新一次列表（原本连着调两次，一次重命名打两轮 /fs/list），实际 ${refreshes} 次`);
});
