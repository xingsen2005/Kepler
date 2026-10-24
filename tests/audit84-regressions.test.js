/**
 * 第八十四轮护栏：《支付模块检查报告》七条逐一复核后的加固
 *
 * ## 来源
 *
 *   用户：「读取"支付模块检查报告.md"，分析其问题是否存在，存在的进行修复，
 *          不存在的写入 Audit_illusion_report.md」
 *
 * 七条**全部成立**（逐条与真实代码对照过，见下），因此没有一条进「幻觉报告」：
 *
 *  · M-1 支付宝查单响应不验签 —— 网关地址是管理员手填的，`https://evil.example/gateway.do`
 *    能通过保存时的全部校验 ⇒ 「TLS + 主机可信」不再是技术属性。伪造一条
 *    `trade_status=TRADE_SUCCESS` 的响应即可 `markPaid`，**用户不用真付钱**。
 *  · M-2 轮询推进只覆盖微信 —— 「有 return_url」≠「用户会回来」，支付宝/PayPal
 *    付完直接关标签页后，凭 7 天票据重回页面会永远停在「支付中…」。
 *  · M-3 订单账本坏掉时 fail-open —— `loadFailed` 只挡住"别把空表写出去"，
 *    没有任何上游知道订单系统不可用 ⇒ 钱收了、单没了、重启后票据全失效。
 *  · L-1 `fenFromYuan('')` 返回 0（`Number('') === 0`）—— 文案把管理员带向
 *    「是不是少收了钱」，而真相是"读不到金额"。
 *  · L-2 复用在途订单时静默忽略新提交的券 —— 页面显示 ¥5、实际扣 ¥10。
 *  · L-3 双击建双单 —— 两个请求都还没有票据 Cookie，各建一笔，前者成孤儿。
 *  · L-4 PayPal 回调不看 `event_type` —— 任何事件都能白嫖一次带商户密钥的查单。
 *
 * ## 判据落点（按「必须落在实际被执行的那一层」）
 *
 *  · M-1 落在**真跑**：本地起桩返回伪造响应 / 真签名响应 / 「签名按紧凑 JSON 算、
 *    报文却带空格」三种，直接断言 `queryCharge()` 的结论。第三种是关键 ——
 *    它把「必须按原文验签」和「不许重新序列化」这两件事一次钉住（报告给的
 *    「复用 `alipayVerify`」建议恰恰会在这一条上翻车）。
 *  · M-2 / M-3 / L-2 / L-3 落在**真实 HTTP 路由**上（起 express、真 POST 表单），
 *    并用「另一侧的对照」证明断言不是恒真：M-2 附带「已支付订单不该再查单」；
 *    L-3 附带「换渠道不该被合并」。
 *  · M-3 的另一半（`isDegraded()` 真的会在损坏文件上置真）必须**另起进程**：
 *    `load()` 的失败态来自 require 时读文件，同进程里造不出来。
 *  · L-1 / L-4 落在**纯函数**上（`fenFromYuan` / `paypalEventCheck`），
 *    再补一条路由级对照：非白名单事件必须在**出站验签之前**被丢掉。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const { execFileSync } = require('child_process');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r84-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();

/* ---------------------------------------------------------------- *
 * 打桩（与 audit82/83 同构：真实路由 + 真实 store，只替换外部依赖）
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
    paypal: { enabled: true, clientId: 'cid', clientSecret: 'csec', mode: 'sandbox', webhookId: 'WH-1' },
  },
});

const paymentRules = require(SERVER('payment-rules.js'));
paymentRules.snapshot = () => ({
  enabled: true,
  states: { alipay: true, wechat: true, paypal: true },
  configuredMap: { alipay: true, wechat: true, paypal: true },
  available: ['alipay', 'wechat', 'paypal'],
});
paymentRules.resolvePaidState = () => ({
  required: true, effective: true, amountFen: 100, currency: 'CNY', reason: '',
});

const paymentProviders = require(SERVER('payment-providers.js'));
paymentProviders.isConfigured = () => true;

const statsStore = require(SERVER('stats-store.js'));
const logs = [];
statsStore.addLog = (r) => { logs.push(r); };
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const couponStore = require(SERVER('coupon-store.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/** 下单桩：记录每次下单的渠道 / 订单号 */
const charges = [];
paymentGateway.createCharge = async (platform, cfg, opts) => {
  charges.push({ platform, orderId: opts.order.id });
  return { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
};

/** 查单桩：只计数，默认回「还在支付中」 */
const queries = [];
const origQueryCharge = paymentGateway.queryCharge;
const queryStub = async (platform, cfg, order) => {
  queries.push({ platform, orderId: order.id });
  return { paid: false, state: 'pending', tradeNo: order.tradeNo || '', failReason: '' };
};
paymentGateway.queryCharge = queryStub;

/**
 * M-1 的两条用例必须走**真的** `queryCharge`（桩把整条链路都替掉了，
 * 那样验签逻辑根本不会被执行 —— 这正是"判据没落在该判的那一层"）。
 */
async function withRealQuery(fn) {
  paymentGateway.queryCharge = origQueryCharge;
  try {
    return await fn();
  } finally {
    paymentGateway.queryCharge = queryStub;
  }
}

/* ---------------------------------------------------------------- *
 * HTTP 夹具
 * ---------------------------------------------------------------- */
async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', shareRoutes);
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

function call(port, method, urlPath, opts) {
  const o = opts || {};
  const body = o.fields
    ? Object.keys(o.fields).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o.fields[k])).join('&')
    : (o.rawBody || '');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign({
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }, o.headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const postForm = (port, urlPath, fields, headers) => call(port, 'POST', urlPath, { fields, headers });

let seq = 0;
async function makePaidLink(extra) {
  seq += 1;
  return shareStore.create(Object.assign({
    key: 'r84/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 100, currency: 'CNY' },
  }, extra || {}));
}

function newOrder(l, platform, patch) {
  const o = paymentOrders.create(Object.assign({
    linkId: l.id, platform, amountFen: 100, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  }, patch || {}));
  return paymentOrders.get(o.id);
}

const cookieOf = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

/** 起一个本地网关桩（支付宝查单只测出站行为，主机在这里被指到本地） */
async function gatewayStub(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: s.address().port,
    close: () => new Promise((r) => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close(r);
    }),
  };
}

const alipayCfg = (port) => ({
  appId: '2021000000000000', privateKey: PKCS8_PEM, signType: 'RSA2',
  alipayPublicKey: SPKI_PEM,
  gateway: `http://127.0.0.1:${port}/gateway.do`,
});

const sign = (content) => crypto.createSign('RSA-SHA256').update(content, 'utf8')
  .sign(KEY_PAIR.privateKey, 'base64');

/* ================================================================== *
 * M-1 · 查单响应必须验签
 * ================================================================== */
test('R84-01 · M-1 · 伪造的「支付成功」查单响应必须被拒绝（网关说什么不能信什么）', async () => {
  /**
   * 这条响应在旧实现下足以让订单变成「已支付」：`alipayQuery` 只 `JSON.parse` 后读
   * `trade_status`，没有任何人看 `sign`。而网关地址是**管理员手填**的，填成
   * `https://evil.example/gateway.do` 也能保存成功 ⇒ 伪造网关 = 免费拿货。
   */
  const srv = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify({
      alipay_trade_query_response: {
        code: '10000', trade_status: 'TRADE_SUCCESS', total_amount: '5.00', trade_no: 'T-FORGED',
      },
    }));
  });
  try {
    const r = await withRealQuery(() => paymentGateway.queryCharge('alipay', alipayCfg(srv.port), {
      id: 'o-r84-01', amountFen: 500, platform: 'alipay',
    }));
    assertEqual(r.paid, false, `★没有签名（或签名对不上）的响应绝不能判为已支付，实际：${JSON.stringify(r)}`);
    assertEqual(r.state, 'error', '应判为「无法确认」而不是「已支付」或「未支付」');
    assert(/签名/.test(String(r.failReason)),
      `文案要指名「签名校验失败」，否则管理员会去查金额/网络，实际：${r.failReason}`);
  } finally {
    await srv.close();
  }
});

test('R84-02 · M-1 · 真签名必须通过，且只认**原文**字节（重新序列化就会对不上）', async () => {
  const NODE_SPACED = '{ "code": "10000", "trade_status": "TRADE_SUCCESS", "total_amount": "5.00", "trade_no": "T-R84-02" }';
  const NODE_COMPACT = JSON.stringify({
    code: '10000', trade_status: 'TRADE_SUCCESS', total_amount: '5.00', trade_no: 'T-R84-02',
  });
  assert(NODE_SPACED !== NODE_COMPACT, '前置：两种形态必须真的不同（否则这条用例证明不了原文切片）');

  // ① 按原文（带空格）签 ⇒ 应当通过
  const srvOk = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(`{"alipay_trade_query_response":${NODE_SPACED},"sign":"${sign(NODE_SPACED)}"}`);
  });
  try {
    const r = await withRealQuery(() => paymentGateway.queryCharge('alipay', alipayCfg(srvOk.port), {
      id: 'o-r84-02a', amountFen: 500, platform: 'alipay',
    }));
    assertEqual(r.paid, true, `真签名必须通过（否则所有真实付款都会失败），实际：${JSON.stringify(r)}`);
    assertEqual(r.tradeNo, 'T-R84-02', '验签通过后业务字段照常取出（网关单号要带回来）');
  } finally {
    await srvOk.close();
  }

  /**
   * ② 报文用带空格的形态，但签名按**紧凑形态**算 —— 相当于「验签前把响应重新
   *    `JSON.parse` 再 `JSON.stringify`」。必须**验不过**：
   *     · 按原文切片验签的实现 → 对不上（正确）；
   *     · 报告建议的「直接复用 `alipayVerify`（它对 k=v 排序串验签）+ 重新序列化」
   *       → 反而会验过（错误，且等于给自己开了一个"只要 JSON 语义相同就算数"的口子）。
   */
  const srvBad = await gatewayStub((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(`{"alipay_trade_query_response":${NODE_SPACED},"sign":"${sign(NODE_COMPACT)}"}`);
  });
  try {
    const r = await withRealQuery(() => paymentGateway.queryCharge('alipay', alipayCfg(srvBad.port), {
      id: 'o-r84-02b', amountFen: 500, platform: 'alipay',
    }));
    assertEqual(r.paid, false,
      '★签名必须是对**原始字节**的签名：按重新序列化后的内容拼签名不得通过');
    assertEqual(r.state, 'error', '应判为「无法确认」');
  } finally {
    await srvBad.close();
  }

  // ③ 切片本身：只取 `alipay_trade_query_response` 这一段，不把外层 `sign` 包进去
  const raw = `{"alipay_trade_query_response":${NODE_SPACED},"sign":"xx"}`;
  assertEqual(paymentGateway.alipayRawNode(raw, 'alipay_trade_query_response'), NODE_SPACED,
    '原文切片必须逐字节等于报文里的那一段（含空格）');
  assertEqual(paymentGateway.alipayRawNode(raw, 'nope'), '', '取不到时必须是空串（调用方据此 fail-closed）');
});

/* ================================================================== *
 * M-2 · 任何在途订单都要靠轮询推进
 * ================================================================== */
test('R84-03 · M-2 · 支付宝在途订单被轮询时必须真的查单；已支付的不该再查', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const o = newOrder(l, 'alipay');
    const before = queries.length;

    const r1 = await call(srv.port, 'GET', '/s/' + l.id + '/pay/status', { headers: { cookie: cookieOf(l, o) } });
    const hit = queries.slice(before);
    assertEqual(hit.length, 1,
      `★支付宝在途订单轮询必须发一次网关查单（旧实现只对微信查，用户付完关页面就永远停在「支付中」），实际 ${hit.length} 次`);
    assertEqual(hit[0].platform, 'alipay', '要按订单自己的渠道去查');
    assertEqual(hit[0].orderId, o.id, '要查的就是这笔订单');
    assertEqual(r1.json && r1.json.state, 'pending', '查单说未付，回包应如实说「支付中」');

    // 对照：已支付的订单不该再消耗查单预算（否则上面那条"查了一次"可能只是恒真）
    paymentOrders.markPaid(o.id);
    const mid = queries.length;
    await call(srv.port, 'GET', '/s/' + l.id + '/pay/status', { headers: { cookie: cookieOf(l, o) } });
    assertEqual(queries.length, mid, '已支付订单不该再向网关查单');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * M-3 · 账本不可用必须 fail-closed，且管理端看得见
 * ================================================================== */
test('R84-04 · M-3 · 订单账本不可用时必须拒绝收款，并说清为什么不收', async () => {
  const srv = await serve();
  const orig = paymentOrders.isDegraded;
  try {
    const l = await makePaidLink();
    const beforeOrders = paymentOrders.listForLink(l.id).length;
    const beforeCharge = charges.length;

    paymentOrders.isDegraded = () => true;
    const r = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: '' });

    assertEqual(paymentOrders.listForLink(l.id).length, beforeOrders,
      '★账本读不出来时不得再建单 —— 建了也落不了盘，重启就消失');
    assertEqual(charges.length, beforeCharge, '不得向网关下单（否则钱真的会被收走）');
    assert(/暂停收款/.test(r.raw),
      `页面必须明说「已暂停收款」，实际：${r.raw.slice(0, 300)}`);
    assert(!/正在跳转到/.test(r.raw), '不得把用户送去收银台');
    assert(logs.some((x) => x.level === 'error' && /订单存储不可用/.test(String(x.detail))),
      '拒绝收款必须留一条 error 级审计日志（否则事后查不出这段时间为什么没人付成功）');
  } finally {
    paymentOrders.isDegraded = orig;
    await srv.close();
  }
});

test('R84-05 · M-3 · 损坏的 payments.json 必须让 isDegraded() 为真，且原文件不被覆盖', () => {
  const bad = makeTempDir('r84-bad-');
  const file = path.join(bad.dir, 'payments.json');
  fs.writeFileSync(file, 'this-is-not-json');

  /**
   * 必须另起进程：`load()` 的失败态来自 require 后第一次读文件，同进程里造不出来
   * （本文件的 store 早已加载成功）。
   */
  const script = `
    process.env.S3_DATA_DIR = ${JSON.stringify(bad.dir)};
    const po = require(${JSON.stringify(SERVER('payment-orders'))});
    process.stdout.write(JSON.stringify({ degraded: po.isDegraded(), list: po.listAll().length }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const r = JSON.parse(out);
  assertEqual(r.degraded, true, '★读不出账本时 isDegraded() 必须为真 —— 否则上游永远不知道订单系统不可用');
  assertEqual(r.list, 0, '损坏时内存里是空表（这正是"看起来一笔订单都没有"的来源）');
  assertEqual(fs.readFileSync(file, 'utf8'), 'this-is-not-json',
    '不得覆盖损坏的订单文件（那可能是唯一还能人工抢救的副本）');
});

test('R84-06 · M-3 · 订单列表接口必须把 degraded 报给管理端，前端要渲染横幅', () => {
  const dir = makeTempDir('r84-api-');
  process.env.S3_DATA_DIR = dir.dir;
  const shared = require(SERVER('routes', '_shared.js'));
  const origAdmin = shared.requireAdmin;
  shared.requireAdmin = (req, res, next) => { req.authUser = { id: 'u1', username: 'root' }; next(); };

  // 清掉缓存，让 routes/payment.js 拿到打过桩的 requireAdmin
  delete require.cache[require.resolve(SERVER('routes', 'payment.js'))];
  const router = require(SERVER('routes', 'payment.js'));
  assert(typeof origAdmin === 'function', '前置：requireAdmin 必须存在（本用例替换它只为省掉登录态）');

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const s = http.createServer(app);
  return new Promise((resolve, reject) => {
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      const req = http.get({ host: '127.0.0.1', port, path: '/api/payment/orders' }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(b);
            assertEqual(res.statusCode, 200, '接口应正常返回');
            assertEqual(json.degraded, false, '账本正常时 degraded 必须是 false（不然横幅常年亮着）');
            assert(Array.isArray(json.orders), 'orders 数组仍在');

            const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ordermgr.js'), 'utf8');
            assert(/degradedCache = r\.degraded === true/.test(src),
              '★前端必须真的读这个字段（只改服务端等于没人看）');
            assert(/degradedBanner\(degradedCache\)/.test(src), '横幅必须被渲染进订单表容器');
            s.close();
            resolve();
          } catch (e) {
            s.close();
            reject(e);
          }
        });
      });
      req.on('error', (e) => { s.close(); reject(e); });
    });
  });
});

/* ================================================================== *
 * L-1 · 空金额不得被当成 0
 * ================================================================== */
test('R84-07 · L-1 · fenFromYuan：空值必须是 NaN，真实的 0 仍然是 0', async () => {
  const f = paymentGateway.fenFromYuan;
  for (const v of ['', '   ', null, undefined, 'abc', 'NaN']) {
    assert(Number.isNaN(f(v)), `「${String(v)}」应返回 NaN（否则会被读成"实付 0.00"），实际 ${f(v)}`);
  }
  assertEqual(f('0'), 0, '真实的 0 元必须仍是 0（0 元订单是合法的）');
  assertEqual(f(0), 0, '数字 0 同上');
  assertEqual(f('5.00'), 500, '5.00 元 = 500 分');
  assertEqual(f('5.005'), 501, '四舍五入到分');
  assertEqual(f(5), 500, '数字入参同样可用');

  // 文案分叉：读不到金额要说「无法确认」，而不是「金额不一致（实付 0.00）」
  const noAmt = paymentGateway.checkPaidAmount({ amountFen: 500 }, f(''), '');
  assertEqual(noAmt.ok, false, '读不到实付金额时不得放行');
  assert(/无法从网关响应中确认实付金额/.test(noAmt.reason),
    `★文案必须指向"读不到金额"，实际：${noAmt.reason}`);
  assert(!/实付 0\.00/.test(noAmt.reason), '不得把"读不到"渲染成"实付 0.00"');

  // 对照：真的金额不符时仍要说"不一致"（证明上面不是把两句合成一句）
  const mismatch = paymentGateway.checkPaidAmount({ amountFen: 500 }, 300, '3.00');
  assert(/不一致/.test(mismatch.reason), '金额真的不符时文案必须是「不一致」');
});

/* ================================================================== *
 * L-2 · 复用在途订单时换券即新单
 * ================================================================== */
test('R84-08 · L-2 · 在途订单上换一张券必须重开一单，不能按旧价扣款', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(); // 标价 100 分
    const coupon = couponStore.generate({
      count: 1, type: 'links', linkIds: [l.id], amountFen: 50, perUserOnce: true,
    })[0];

    // ① 原价下单
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: '' });
    assert(/正在跳转到/.test(r1.raw), '第一次应正常跳到收银台');
    const first = paymentOrders.get(charges[charges.length - 1].orderId);
    assertEqual(first.amountFen, 100, '第一笔是原价 100 分');

    // ② 回付费页领券后重提 —— 页面显示 50 分，真实扣款也必须是 50 分
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', {
      platform: 'alipay', coupon: coupon.code,
    }, { cookie: cookieOf(l, first) });
    assert(/正在跳转到/.test(r2.raw),
      `换券后必须照常出单（不是报错页），实际：${r2.raw.slice(0, 300)}`);
    assert(!/您已使用过该优惠券|优惠券不可用/.test(r2.raw), '不得把用户挡在「优惠券不可用」上');

    const second = paymentOrders.get(charges[charges.length - 1].orderId);
    assert(second.id !== first.id,
      '★换券必须另建新单（复用在途单就等于按旧价扣款，页面价与实扣价分叉）');
    assertEqual(second.amountFen, 50, `新单应付 50 分，实际 ${second.amountFen}`);
    assertEqual(second.couponId, coupon.id, '新单要快照这张券');
    assertEqual(paymentOrders.get(first.id).status, 'failed', '被放弃的在途单必须收尾为失败');
    assert(/更换优惠券/.test(String(paymentOrders.get(first.id).failReason)),
      `失败原因要说清是换券导致的，实际：${paymentOrders.get(first.id).failReason}`);
    assertEqual(couponStore.get(coupon.id).used, 1,
      '账面净额必须是 1：旧单退券 −1、新单核销 +1');

    // ③ 同券再点一次必须复用（L-2 不得把"同券幂等"一起改坏）
    const r3 = await postForm(srv.port, '/s/' + l.id + '/pay', {
      platform: 'alipay', coupon: coupon.code,
    }, { cookie: cookieOf(l, second) });
    assert(/正在跳转到/.test(r3.raw), '同券同渠道重提应复用同一笔并正常跳转');
    assertEqual(charges[charges.length - 1].orderId, second.id, '同券同渠道必须复用，不得再建第三笔');
    assertEqual(paymentOrders.listForLink(l.id).length, 2, '一共只应有两笔订单');

    /**
     * ④ 换到**另一张**券：旧单那张券必须退回去。
     *
     * 这一步是「三步原子」里最容易漏的一步，而且漏了**完全不报错**：旧单被标失败、
     * 新单照常建、钱照常收，只有 `A 券` 的已用次数永久 +1 —— 用户放弃的那笔订单
     * 把一张券吃掉了，谁也看不见。R84-08b 就是钉这一点的反向对照。
     */
    const couponB = couponStore.generate({
      count: 1, type: 'links', linkIds: [l.id], amountFen: 20, perUserOnce: true,
    })[0];
    const r4 = await postForm(srv.port, '/s/' + l.id + '/pay', {
      platform: 'alipay', coupon: couponB.code,
    }, { cookie: cookieOf(l, second) });
    assert(/正在跳转到/.test(r4.raw), `换到另一张券后仍应正常出单，实际：${r4.raw.slice(0, 300)}`);
    const third = paymentOrders.get(charges[charges.length - 1].orderId);
    assertEqual(third.amountFen, 80, `B 券减 20 分 ⇒ 应付 80 分，实际 ${third.amountFen}`);
    assertEqual(third.couponId, couponB.id, '新单要快照 B 券');
    assertEqual(couponStore.get(couponB.id).used, 1, 'B 券必须被核销一次');
    assertEqual(couponStore.get(coupon.id).used, 0,
      '★A 券必须退回（旧单已作废，它不该再占着这张券的额度）');
    assertEqual(paymentOrders.get(second.id).status, 'failed', '换券后上一笔必须收尾');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * L-3 · 双击不得建双单
 * ================================================================== */
test('R84-09 · L-3 · 5 秒内的重复提交（无票据）必须合并成同一笔订单', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink();

    // 浏览器双击：两个请求**同时**发出，第二个发出时第一个的 Set-Cookie 还没回来
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: '' });
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: '' });
    assert(/正在跳转到/.test(r1.raw) && /正在跳转到/.test(r2.raw), '两次都应给出中转页');

    const list = paymentOrders.listForLink(l.id);
    assertEqual(list.length, 1,
      `★双击只应产生一笔订单（旧实现各建一笔，前一笔成孤儿 pending），实际 ${list.length} 笔`);

    const o = list[0];
    assertEqual(charges[charges.length - 1].orderId, o.id, '第二次也必须复用它');
    assertEqual(charges[charges.length - 2].orderId, o.id, '第一次下的也是它');

    /**
     * 票据要给**两次响应都签**：谁先落地不确定，若只有第一个响应带 Set-Cookie 而
     * 它恰好被浏览器丢弃，用户就会「付了钱但手上没有凭证」。
     */
    const set1 = String(r1.headers['set-cookie'] || '');
    const set2 = String(r2.headers['set-cookie'] || '');
    assert(set1.indexOf('sp_' + l.id + '_pay=') >= 0, '第一次响应要签发票据');
    assert(set2.indexOf('sp_' + l.id + '_pay=') >= 0, '★第二次响应同样要签发票据（不能假定第一个响应一定落地）');
    assert(logs.some((x) => /疑似重复提交/.test(String(x.detail))), '合并这件事必须留痕');

    /**
     * 对照：**换了渠道**的并发提交不该被合并 —— 键里只要少一项，用户的选择权就又没了。
     */
    const l2 = await makePaidLink();
    await postForm(srv.port, '/s/' + l2.id + '/pay', { platform: 'alipay', coupon: '' });
    await postForm(srv.port, '/s/' + l2.id + '/pay', { platform: 'wechat', coupon: '' });
    assertEqual(paymentOrders.listForLink(l2.id).length, 2,
      '不同渠道的并发提交必须各建一笔（合并了就等于无视用户这次的选择）');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * L-4 · PayPal 回调的事件类型 + 时间新鲜度
 * ================================================================== */
test('R84-10 · L-4 · PayPal 回调只处理白名单事件；陈旧时间戳记 warn 但不拦', () => {
  const check = paymentGateway.paypalEventCheck;
  const fresh = new Date().toISOString();

  for (const t of ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED']) {
    const r = check({ event_type: t }, { 'paypal-transmission-time': fresh });
    assertEqual(r.accept, true, `${t} 属于白名单，应处理`);
    assertEqual(r.stale, false, `${t} 的时间戳是新的，不该被判 stale`);
  }

  for (const t of ['BILLING.SUBSCRIPTION.CREATED', 'CUSTOMER.DISPUTE.CREATED', '', undefined]) {
    const r = check(t === undefined ? {} : { event_type: t }, { 'paypal-transmission-time': fresh });
    assertEqual(r.accept, false,
      `★非白名单事件（${String(t)}）必须丢弃 —— 否则任何事件都能白嫖一次带商户密钥的查单`);
    assert(r.reason, '丢弃要给出原因，便于日志定位');
  }

  // 陈旧 / 读不出的时间戳：**不拦**（PayPal 会在我们不可用时重试投递，拦了等于自废重试），但要标 stale
  const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const stale = check({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }, { 'paypal-transmission-time': old });
  assertEqual(stale.accept, true, 'PayPal 的延迟重投必须照常处理');
  assertEqual(stale.stale, true, '超过 5 分钟要标记 stale（调用方据此记 warn）');
  assert(/秒/.test(stale.reason), `原因里要带偏离秒数，实际：${stale.reason}`);

  const noTime = check({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }, {});
  assertEqual(noTime.accept, true, '缺时间戳时不拦');
  assertEqual(noTime.stale, true, '缺时间戳要标 stale');
});

test('R84-11 · L-4 · 非白名单回调必须在**出站验签之前**被丢弃（不消耗商户查单配额）', async () => {
  const srv = await serve();
  const origVerify = paymentGateway.paypalVerifyWebhook;
  let verifyCalls = 0;
  paymentGateway.paypalVerifyWebhook = async () => { verifyCalls += 1; return true; };
  try {
    // ① 非白名单事件：403 且**一次验签都不发**
    const r1 = await call(srv.port, 'POST', '/pay/notify/paypal', {
      rawBody: JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'X' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    assertEqual(r1.status, 403, `非白名单事件应被丢弃（403），实际 ${r1.status}`);
    assertEqual(verifyCalls, 0, '★本地就能判掉的，不该先花两次出站去验签');

    // ② 白名单事件：照常走到验签
    const r2 = await call(srv.port, 'POST', '/pay/notify/paypal', {
      rawBody: JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'Y' } }),
      headers: { 'Content-Type': 'application/json', 'paypal-transmission-time': new Date().toISOString() },
    });
    assertEqual(r2.status, 200, `白名单事件要正常处理，实际 ${r2.status}`);
    assertEqual(verifyCalls, 1, '白名单事件必须真的去验签（否则这道门形同虚设）');
  } finally {
    paymentGateway.paypalVerifyWebhook = origVerify;
    await srv.close();
  }
});

/* ================================================================== *
 * 前端横幅（M-3 的"看得见"那一半）
 * ================================================================== */
test('R84-12 · M-3 · 订单管理页横幅：账本损坏时给可操作提示，正常时不占位', async () => {
  const dir = makeTempDir('r84-fe-');
  const jsDir = path.join(dir.dir, 'js');
  fs.mkdirSync(jsDir);
  fs.copyFileSync(path.join(ROOT, 'public', 'js', 'ordermgr.js'), path.join(jsDir, 'ordermgr.js'));
  fs.writeFileSync(path.join(jsDir, 'package.json'), '{"type":"module"}');
  // `util.js` / `api.js` 只需要被 import 时能解析，函数体在本用例里不会被调到
  fs.writeFileSync(path.join(jsDir, 'util.js'),
    'export const toast=()=>{};export const confirmDialog=()=>true;export const openModal=()=>{};'
    + 'export const escapeHtml=(s)=>String(s==null?"":s);export const fmtTime=(s)=>String(s||"");'
    + 'export const fmtAmount=()=>"";export const copyText=()=>{};export const qs=()=>null;');
  fs.writeFileSync(path.join(jsDir, 'api.js'),
    'export const API={paymentOrders:()=>Promise.resolve({orders:[],degraded:false})};');

  const mod = await import('file://' + path.join(jsDir, 'ordermgr.js').replace(/\\/g, '/'));
  assertEqual(mod.degradedBanner(false), '', '账本正常时不该有横幅');
  const html = mod.degradedBanner(true);
  assert(/payments.json/.test(html), '横幅要点名是哪个文件坏了（否则管理员不知道去修什么）');
  assert(/重启/.test(html), '要说明修复后需重启服务');
  assert(/暂停/.test(html), '要说明这期间新的付费已被暂停（与 POST /pay 的拒绝口径一致）');
  assertEqual((html.match(/role="alert"/g) || []).length, 1, '横幅要带 role=alert（读屏软件能播报）');
});

/* ================================================================== *
 * 收尾：还原桩
 * ================================================================== */
test('R84-99 · 收尾：还原查单桩', () => {
  paymentGateway.queryCharge = origQueryCharge;
  assert(true);
});
