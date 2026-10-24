/**
 * 第八十一轮护栏：「支付时提示『没有收到服务器的响应』，后台订单显示『支付中』」
 *
 * ## 缺陷（用户原话）
 *
 *   「支付时提示"没有收到服务器的响应：订单可能没有创建成功"。后台支付订单显示
 *     "支付中"。检查这是应用ID、私钥、公钥、网关地址等信息的问题还是系统本身的问题」
 *
 * 与凭证**无关**：凭证错会在本地签名阶段就报错（R79 的 `1E08010C`），
 * 而 302 到支付宝收银台是纯本地拼串、**一次出站都没有**。真正成立的两条都在系统侧：
 *
 *   A. **出站超时只覆盖了响应头**（`payment-gateway.js` 的 `fetchWithTimeout`）。
 *      计时器在 `finally` 里 `clearTimeout`，而 `fetch()` 一拿到响应头就 resolve ⇒
 *      计时器当场被清，后面的 `await res.text() / res.json()` **完全不受 signal 约束**，
 *      只剩 undici 默认的 `bodyTimeout`（**300 秒**）兜底。网关回了头却一直不吐体时
 *      （出口代理吞包、中间设备半开连接、对方 hang 住），`createCharge` 挂到 5 分钟。
 *      而订单在 `await createCharge()` **之前**就已同步落库为 pending ⇒
 *      后端「支付中」、前端 12 秒就看门狗收工，两边说法永远对不上。
 *   B. **看门狗的结论是猜的**（`public/js/pay-poll.js`）。12 秒没动静就断言
 *      「订单可能没有创建成功」—— 而更常见的实情是订单**已经建成**，卡住的是
 *      「从本页跳去支付平台」这一段（该域名被代理/防火墙拦、插件拦截跳转）。
 *      用户与管理员会被这句话带向完全错误的排查方向。
 *
 * ## 判据落点
 *
 *  · A 落在**真跑**：本地起一个「写响应头 + 半截响应体后停住」的服务器，让
 *    `queryCharge('alipay', …)` 真连过去，断言它在 `TIMEOUT_MS` 量级内失败、
 *    且文案点名「响应体」。旧实现这里会挂 300 秒（本用例会超时）。
 *  · A 的另一半（PayPal 两次串行出站共用一个 9 秒截止时刻）只能落在源码结构上：
 *    出站主机是**硬编码常量**（R21-12 的安全设计，不许为了可测而放开），
 *    无法在测试里把 `paypalHost()` 指到本地。因此按函数体切片后做**精确调用点**断言
 *    —— 只要漏传一处，`deadline` 就不在调用点上了。
 *  · B 落在 `vm` 里**真跑** `public/js/pay-poll.js`：喂不同状态的探针响应，
 *    断言四种结论各不相同、且都不再出现旧的那句错误断言。
 *  · `?probe=1` 的「只读」用**双侧**证明：探针请求时网关桩零调用，同一订单
 *    不带 probe 时必须被调用一次（否则「零调用」是假的）。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r81-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();

/* ---------------------------------------------------------------- *
 * 打桩（只为让路由能挂起来；R81 不测存储）
 * ---------------------------------------------------------------- */
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
  platforms: {
    alipay: {
      enabled: true, appId: '2021000000000000', privateKey: PKCS8_PEM,
      alipayPublicKey: SPKI_PEM, signType: 'RSA2',
      gateway: 'https://openapi.alipay.com/gateway.do',
    },
  },
});

const statsStore = require(SERVER('stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/* ================================================================== *
 * A. 出站超时必须覆盖「响应体」
 * ================================================================== */

/** 起一个本地网关桩：`handler(req,res)` 自己决定怎么回 */
async function gatewayStub(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: s.address().port,
    close: () => new Promise((r) => {
      // 被 abort 的连接不会自己走完，必须强拆，否则 close() 会等 300 秒
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close(r);
    }),
  };
}

const alipayCfg = (port) => ({
  appId: '2021000000000000', privateKey: PKCS8_PEM, signType: 'RSA2',
  gateway: `http://127.0.0.1:${port}/gateway.do`,
});

test('R81-01 · 网关回了响应头却迟迟不吐响应体：查单必须在超时后失败，不得被"读体"拖住', async () => {
  /**
   * 桩的时序是这条用例的核心：
   *   0s  —— 响应头 + 半截 JSON（模拟出口代理吞包 / 对方 hang 住）
   *   14s —— 才把剩下的字节补完并 end()
   *
   * 于是两种实现给出**可区分**的两种结局：
   *   · 正确实现（计时器管到读体）：~10 秒时 abort，判「读取超时」；
   *   · 旧实现（拿到头就 clearTimeout）：读体会一直等到 14 秒拿到完整 JSON，
   *     然后**判成已支付** —— 前端 12 秒已经宣布失败，后台却悄悄成功了。
   * 这也是为什么桩必须"最终会结束"：不能让用例真的挂 300 秒去等 undici 兜底。
   */
  const srv = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"alipay_trade_query_response":{"code":"100');
    const t = setTimeout(() => {
      try {
        res.write('00","trade_status":"TRADE_SUCCESS","total_amount":"5.00","trade_no":"T-LATE"}');
        res.end();
      } catch (e) { /* 连接已被 abort，忽略 */ }
    }, 14000);
    t.unref();
    res.on('close', () => clearTimeout(t));
  });

  const t0 = Date.now();
  let r;
  try {
    r = await paymentGateway.queryCharge('alipay', alipayCfg(srv.port), {
      id: 'o-r81-01', amountFen: 500, platform: 'alipay',
    });
  } finally {
    await srv.close();
  }
  const ms = Date.now() - t0;

  assert(ms <= paymentGateway.TIMEOUT_MS + 3500,
    `★必须在 ${paymentGateway.TIMEOUT_MS}ms 超时后立刻放弃，实际耗时 ${ms}ms`
    + `（旧实现会等到响应体读完 —— 默认上限 300 秒，前端 12 秒早已宣布失败）`);
  assert(ms >= paymentGateway.TIMEOUT_MS - 1000,
    `不该比超时更早放弃（说明是别的错误，不是超时），实际耗时 ${ms}ms`);
  assertEqual(r.paid, false, '读不到完整响应体时绝不能判为已支付（fail-closed）');
  assertEqual(r.state, 'error', '应判为「未能确认」');
  assert(/超时/.test(String(r.failReason)), `文案要点明是超时，实际：${r.failReason}`);
  assert(/响应体|读取/.test(String(r.failReason)),
    `★要说明卡在「读响应体」这一阶段（与「连不上」区分开），实际：${r.failReason}`);
});

test('R81-02 · 正常响应仍必须解析出结果（这次改造不得把成功路径弄坏）', async () => {
  const srv = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify({
      alipay_trade_query_response: {
        code: '10000', trade_status: 'TRADE_SUCCESS', total_amount: '5.00', trade_no: 'T-R81-02',
      },
    }));
  });
  try {
    const r = await paymentGateway.queryCharge('alipay', alipayCfg(srv.port), {
      id: 'o-r81-02', amountFen: 500, platform: 'alipay',
    });
    assertEqual(r.paid, true, `正常报文必须判为已支付，实际：${JSON.stringify(r)}`);
    assertEqual(r.tradeNo, 'T-R81-02', '网关单号要带回来');
  } finally {
    await srv.close();
  }
});

test('R81-03 · 响应体不是 JSON 时不得抛异常、也不得判已支付', async () => {
  const srv = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  });
  try {
    // 旧实现的 `alipayQuery` 是裸 `await res.json()` —— 非 JSON 会抛，落到 queryCharge 的
    // catch 里，`failReason` 是一句英文 JSON 解析错误。现在应走「内容无法识别」这条。
    const r = await paymentGateway.queryCharge('alipay', alipayCfg(srv.port), {
      id: 'o-r81-03', amountFen: 500, platform: 'alipay',
    });
    assertEqual(r.paid, false, '非 JSON 响应绝不能判为已支付');
    assertEqual(r.state, 'error', '应判为「未能确认」');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * A（之二）. 下单总预算：PayPal 的两次串行出站必须共用一个截止时刻
 *
 * 为什么是源码判据：`paypalHost()` 只认 `cfg.mode` 的两档官方域名，出站主机是
 * 硬编码常量（R21-12 的防 SSRF 设计）—— 测试无法把它指到本地，也就无法真跑。
 * 这里按**函数体切片 + 精确调用点**断言，漏传任何一处都会红。
 * ================================================================== */

/** 按大括号配对取出顶层函数体（`async function name(` 起） */
function bodyOf(src, name) {
  const head = src.indexOf('async function ' + name + '(');
  if (head < 0) return '';
  const start = src.indexOf('{', src.indexOf(')', head));
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return '';
}

test('R81-04 · 下单总预算 9 秒：PayPal 的「取 token + 建单」必须共用同一截止时刻', () => {
  const src = fs.readFileSync(SERVER('payment-gateway.js'), 'utf8');

  const cc = bodyOf(src, 'createCharge');
  assert(cc, '必须能取到 createCharge 的函数体');
  assert(/CHARGE_TIMEOUT_MS/.test(cc),
    '下单必须有自己的总预算（单次出站 10 秒 × 2 次串行 = 20 秒 > 前端 12 秒看门狗）');
  assert(/const deadline = \{ t: Date.now\(\) \+ CHARGE_TIMEOUT_MS \}/.test(cc),
    '截止时刻必须是**一个**绝对值，逐次重新计时等于没有总预算');
  assert(/run\(cfg, opts, deadline\)/.test(cc), 'deadline 必须交给各渠道的下单实现');

  const pc = bodyOf(src, 'paypalCreate');
  assert(pc, '必须能取到 paypalCreate 的函数体');
  assert(/paypalToken\(cfg, deadline\)/.test(pc),
    '★PayPal 取 token 必须共用 deadline（否则「取 token 10 秒 + 建单 10 秒」= 20 秒）');
  assert(/'json', deadline\)/.test(pc), '★PayPal 建单请求必须共用 deadline');

  const wc = bodyOf(src, 'wechatCreate');
  assert(wc, '必须能取到 wechatCreate 的函数体');
  assert(/wechatRequest\('POST', '\/v3\/pay\/transactions\/native', cfg, payload, deadline\)/.test(wc),
    '★微信下单请求必须共用 deadline');

  // 反面对照：查单**不**设总预算（它在 3 秒轮询里跑，没人盯着，不该因慢而放弃确认）
  const qc = bodyOf(src, 'queryCharge');
  assert(qc, '必须能取到 queryCharge 的函数体');
  assert(!/deadline/.test(qc), '查单不该套下单的总预算：它需要更长的时间去确认结果');
});

test('R81-05 · 出站超时的文案必须区分「连不上」与「响应体读不完」', () => {
  const src = fs.readFileSync(SERVER('payment-gateway.js'), 'utf8');
  const f = bodyOf(src, 'fetchWithTimeout');
  assert(f, '必须能取到 fetchWithTimeout 的函数体');
  assert(/phase = 'body'/.test(f), '拿到响应头之后必须切到「读体」阶段');
  const turn = f.indexOf("phase = 'body'");
  const read = f.indexOf('res.text()');
  assert(turn > 0 && read > turn, '★阶段切换必须发生在读体之前（否则永远只会报「连不上」）');
  assert(/网关连接超时/.test(f), '必须有「没收到响应头」的文案');
  assert(/网关读取超时/.test(f), '★必须有「收到头但没读完体」的文案');
  // 计时器必须在读体之后才清 —— 这是本条缺陷的正中心
  const clear = f.indexOf('clearTimeout(timer)');
  assert(clear > read, '★clearTimeout 必须在读体之后（放在 fetch 之后就是旧 bug）');
});

/* ================================================================== *
 * B. 看门狗：结论必须来自服务端，而不是"没动静"这件事本身
 * ================================================================== */

/**
 * 在假 DOM 里**真跑**一遍 `public/js/pay-poll.js`。
 * @param {{status?: string, fail?: boolean}} opts 探针接口的回答
 */
function runPayPoll(opts) {
  const o = opts || {};
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pay-poll.js'), 'utf8');

  const listeners = {};
  const note = { textContent: '', className: '', hidden: true };
  const btn = { textContent: '立即支付', disabled: false };
  const form = {
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector() { return btn; },
  };
  const doc = {
    currentScript: { getAttribute: () => 'link-abc' },
    hidden: false,
    getElementById(id) { return id === 'pay-submit-note' ? note : null; },
    querySelector(sel) { return sel === 'form[data-pay-submit]' ? form : null; },
    addEventListener() {},
  };
  const timers = [];
  const fetched = [];
  const json = () => Promise.resolve(o.status ? { state: o.status } : {});
  const ctx = {
    document: doc,
    window: { addEventListener() {} },
    location: { pathname: '/s/link-abc', reload() { ctx.reloaded = true; } },
    fetch: (u) => {
      fetched.push(u);
      if (o.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json });
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    encodeURIComponent,
    decodeURIComponent,
  };
  vm.runInNewContext(src, ctx, { filename: 'pay-poll.js' });
  return { listeners, note, btn, timers, fetched, ctx };
}

/** 走完 12 秒计时器，并把探针的 promise 链跑干净 */
async function submitAndTimeout(opts) {
  const box = runPayPoll(opts);
  box.listeners.submit({ preventDefault() {} });
  const t = box.timers[box.timers.length - 1];
  t.fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return box;
}

test('R81-06 · 超时后必须去问服务端，而不是断言「订单可能没有创建成功」', async () => {
  const box = await submitAndTimeout({ status: 'pending' });
  const txt = box.note.textContent;

  assert(box.fetched.some((u) => /\/pay\/status\?probe=1$/.test(u)),
    `超时后必须先做一次只读探测，实际请求：${box.fetched.join(', ') || '（一次都没有）'}`);
  assert(!/订单可能没有创建成功/.test(txt),
    `★旧文案是错的：订单常常已经建成，卡住的是跳转。实际：${txt}`);
  assert(/已经创建成功/.test(txt), `探针说 pending 时就必须如实说"订单已建"，实际：${txt}`);
  assert(/支付中/.test(txt), '要引用后端看到的真实状态，让用户/管理员能对上号');
  assert(/不会重复扣款/.test(txt),
    `要说明重试是安全的（复用在途订单），否则用户不敢再点。实际：${txt}`);
  assertEqual(box.btn.disabled, false, '超时后按钮必须恢复可点');
  assertEqual(box.ctx.reloaded, undefined, '还没付款，不能刷新');
});

test('R81-07 · 探针说「查不到订单」时才可以说是提交没到达', async () => {
  const box = await submitAndTimeout({ status: 'none' });
  const txt = box.note.textContent;
  assert(/没有到达服务端/.test(txt), `探针说 none 时必须指出"提交没到达"，实际：${txt}`);
  assert(/插件|内嵌窗口/.test(txt), '要列出最可能的成因（拦截 / 受限内嵌窗口），否则用户只能猜');
  assert(!/已经创建成功/.test(txt), '不能把两种处境混成一种');
});

test('R81-08 · 探针说「下单失败」/已支付 / 拿不到答案时，三种结论必须各不相同', async () => {
  const failed = await submitAndTimeout({ status: 'failed' });
  assert(/下单失败/.test(failed.note.textContent),
    `failed 要说清"订单建了但渠道下单失败"，实际：${failed.note.textContent}`);

  const paid = await submitAndTimeout({ status: 'paid' });
  assertEqual(paid.ctx.reloaded, true, '探针说 paid 时必须刷新页面放行（否则用户以为没付成功）');

  const unknown = await submitAndTimeout({ fail: true });
  const txt = unknown.note.textContent;
  assert(/无法向服务端确认/.test(txt), `断网时必须如实说"无法确认"，实际：${txt}`);
  assert(!/已经创建成功|没有到达服务端/.test(txt), '★拿不到答案时两种结论都不许说');
  assert(/刷新/.test(txt), '要给一个总能做、且不会重复扣款的动作');
  assertEqual(unknown.btn.disabled, false, '任何情况下按钮都要恢复可点');
});

/* ================================================================== *
 * C. `?probe=1` 必须是只读的（不烧网关查单配额）
 * ================================================================== */

async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', shareRoutes);
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

let seq = 0;
async function makePaidLink(key) {
  seq += 1;
  return shareStore.create({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 500 },
  });
}

test('R81-09 · 探针只读：`?probe=1` 不得触发网关查单，不带 probe 时必须查', async () => {
  const srv = await serve();
  const l = await makePaidLink('a/probe.txt');
  const o = paymentOrders.create({
    linkId: l.id, platform: 'wechat', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  });
  const order = paymentOrders.get(o.id);
  const cookie = 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

  const orig = paymentGateway.queryCharge;
  let calls = 0;
  paymentGateway.queryCharge = async () => {
    calls += 1;
    return { paid: false, state: 'pending', tradeNo: '', failReason: '' };
  };
  try {
    const p = await request(srv.port, 'GET', '/s/' + l.id + '/pay/status?probe=1', { headers: { cookie } });
    assertEqual(p.status, 200, '探针应正常回答');
    assertEqual(p.json.state, 'pending', `必须回答本地账本里的真实状态，实际：${p.raw.slice(0, 120)}`);
    assertEqual(p.json.platform, 'wechat', '要带上渠道，方便用户/管理员对上"是哪条渠道"');
    assertEqual(calls, 0,
      '★探针不得触发网关查单：它是"问一句"，不是"推一次状态"（否则卡住期间反而加压网关）');

    // 正面：同一订单不带 probe ⇒ 必须真的查一次单，否则上面的 0 是假的
    const q = await request(srv.port, 'GET', '/s/' + l.id + '/pay/status', { headers: { cookie } });
    assertEqual(q.status, 200, '常规轮询应正常回答');
    assertEqual(q.json.state, 'pending', '状态字段不许变');
    assertEqual(calls, 1, '★不带 probe 时必须查单（证明 0 是探针造成的，不是查单根本没通）');

    // 侧证：探针回答里不该出现"probe 之外"的额外字段，避免被当成常规轮询的替代
    assertEqual(p.json.probe, true, '探针回答要自报家门（便于日志里区分）');
  } finally {
    paymentGateway.queryCharge = orig;
    await srv.close();
  }
});
