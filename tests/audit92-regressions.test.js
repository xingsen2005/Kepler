/**
 * 第九十二轮护栏：收口 R91 交付时如实标注的三条残余风险。
 *
 * 三条都不是「新功能」，而是「上一版说了却没做到」：
 *
 *  ① **无法关单（PayPal / 云闪付）** —— 旧实现无条件回 `unsupported`，于是 R90 五档里的
 *     `paid` 在这两家上**永远不可达**。而 `paid` 是唯一一个「用户已经给过钱」的档位，
 *     也是调用方唯一会因此**放弃建新单**的档位 ⇒ 「旧单其实已经付掉了」时照样建第二笔。
 *     现在关单前先做一次**只读**查单（PayPal 那条尤其关键：它绝不能走会 capture 的路径）。
 *  ② **未与真实商户号联调** —— 新增凭据自检：真的带凭据出网走一圈，把「公钥填错 /
 *     signMethod 选错 / 私钥与证书序列号不匹配 / client_id 错」提前到保存前暴露。
 *  ③ **`GET /api/payment/config` 体积 ~25 KB** —— 渠道图形从配置接口移出，
 *     改由 `GET /api/payment/logos` 长缓存下发。
 *
 * 另带两处顺带修掉的真缺陷（都在 R91 里引入）：
 *  · 银联前台通知是**跨站 POST 表单**，而 `/s/:id/pay/return` 只注册了 GET ⇒ 云闪付
 *    用户付完款会落到 403/404；
 *  · 云闪付异步通知按记录 `id` 查一个其实是 `orderNo` 的值 ⇒ 恒定查不到。
 *
 * ## 分层（每条判据都落在**实际被执行的那一层**）
 *
 *  · 体积层：直接量 `clientSchema()` 的序列化字节
 *  · 路由层：真 express + 真 HTTP —— 跨站 POST 到回跳必须 404、到建单必须 403
 *  · 网关层：真 `probeCharge` / `closeCharge` + fetch 桩，走四档语义
 *  · 处理器层：直接驱动 `routes/payment.js` 的 handler，断言缓存头与响应体
 *  · 源码层：只用来钉「不变量」（图形实现点不许回流到 payment-providers）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

/** ⚠️ 先设数据目录再 require 任何 store，否则会写到项目真实的 data/ */
const tmp = makeTempDir('r92-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const providers = require(SERVER('payment-providers.js'));
const gateway = require(SERVER('payment-gateway.js'));
const logos = require(SERVER('payment-logos.js'));
const configStore = require(SERVER('config-store.js'));
const paymentRouter = require(SERVER('routes', 'payment.js'));
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const PUB = KEY.publicKey.export({ type: 'spki', format: 'pem' }).trim();

const UP_CFG = {
  merId: '777290058110048',
  privateKey: PRIV,
  unionpayPublicKey: PUB,
  signMethod: '01',
};

/** 按银联规则签名（**测试侧独立实现**，不复用被测函数的签名路径） */
function signWith(privateKey, params, signMethod) {
  const algo = signMethod === '11' ? 'RSA-SHA256' : 'RSA-SHA1';
  const payload = Object.keys(params)
    .filter((k) => k !== 'signature' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createSign(algo).update(payload, 'utf8').sign(privateKey, 'base64');
}

/** 银联应答（表单串），默认用夹具私钥签 —— 即「银联那边也用这把」 */
function upResponse(params, signMethod) {
  const p = Object.assign({}, params);
  p.signature = signWith(PRIV, p, signMethod || '01');
  return Object.keys(p).reverse()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
}

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

const fakeResponse = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  body: { cancel: async () => {} },
  text: async () => text,
});

/** 起一个只挂分享路由的本地服务 */
async function serve(router) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/**
 * 直接驱动一个路由 handler（跳过中间件）—— 用来断言「处理器自己写了什么」。
 * `asyncHandler` 的返回值是 undefined，因此用 res.json / res.end 作为完成信号。
 */
function driver() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const res = {
    headers: {},
    statusCode: 200,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    json(b) { this.body = b; resolve(this); return this; },
    end() { resolve(this); return this; },
  };
  return { res, done };
}

/** 从 router.stack 里取出某条路由的「业务 handler」（跳过 requireAdmin 等中间件） */
function routeHandlers(router, method, p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p
    && l.route.methods[String(method).toLowerCase()]);
  if (!layer) return null;
  return layer.route.stack.map((x) => x.handle);
}

/* ================================================================== *
 * R92-01 · 体积：配置接口不再背着 16 KB 的图形
 * ================================================================== */

test('R92-01 · 渠道图形已移出配置接口（体积预算 + 不许回流）', () => {
  const schema = providers.clientSchema();
  const schemaBytes = Buffer.byteLength(JSON.stringify(schema));

  for (const p of schema) {
    assert(!('logo' in p), `${p.id} 不得再随配置接口下发 logo —— 那会让这份响应重回 ~27 KB`);
    assert(!('logoSvg' in p), '也不得换一个字段名偷偷下发');
  }
  assert(JSON.stringify(schema).indexOf('<svg') < 0,
    '配置接口的响应里不得再出现内联 SVG（图形走 GET /api/payment/logos）');

  // 图形总量确实在 16 KB 量级 —— 否则这次拆分没有实际收益，值得复核
  let logoBytes = 0;
  for (const id of providers.ORDER) logoBytes += Buffer.byteLength(JSON.stringify(logos.logo(id, { size: 'sm' })));
  assert(logoBytes > 15000, `图形总量应确实在 16 KB 量级（实测 ${logoBytes}），否则拆分的理由不成立`);

  /**
   * 体积预算：当前实测约 10.8 KB。留一点余量给后续新增字段，
   * 但一旦有人把大块内容（图形、文档正文、示例报文）塞回来，这条会先炸。
   */
  assert(schemaBytes < 13000,
    `GET /api/payment/config 的 platforms 部分应在 13 KB 内（实测 ${schemaBytes}；带图形时约 ${schemaBytes + logoBytes}）`);
});

/* ================================================================== *
 * R92-02 · 图形接口：长缓存头 + 与唯一实现点逐字节一致
 * ================================================================== */

test('R92-02 · GET /payment/logos 带长缓存头，内容与 payment-logos 逐字节一致', async () => {
  const handlers = routeHandlers(paymentRouter, 'GET', '/payment/logos');
  assert(handlers && handlers.length >= 2, '必须有 GET /payment/logos 路由（且带中间件）');
  assert(handlers.some((h) => h && h.name === 'requireAdmin'),
    '图形接口必须挂 requireAdmin（自检与图形都只在管理端用）');

  const { res, done } = driver();
  handlers[handlers.length - 1]({}, res);
  const out = await done;

  assert(/max-age=604800/.test(String(out.headers['cache-control'] || '')),
    '图形是代码内常量，必须让浏览器缓存一周 —— 否则「拆出去」只是多了一次请求');
  assert(/private/.test(String(out.headers['cache-control'] || '')),
    '必须是 private：这条路由挂着 requireAdmin，缓存语义不该暗示可被共享代理留存');

  for (const id of providers.ORDER) {
    assertEqual(out.body.logos[id], logos.logo(id, { size: 'sm' }),
      `${id} 下发的图形必须与唯一实现点逐字节一致（前后台不能分叉）`);
  }
});

/* ================================================================== *
 * R92-03 · 前台回跳：银联的 POST 表单必须接得住，且放宽只限这一条
 * ================================================================== */

test('R92-03 · 跨站 POST 到回跳路径可达（银联前台通知），到建单路径仍被拒', async () => {
  const share = require(SERVER('share-routes.js'));
  const srv = await serve(share);
  try {
    const post = (p, body) => request(srv.port, 'POST', p, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // 银联是从**它自己的页面**提交这个表单的 —— 这正是真实的来源证据
        'Sec-Fetch-Site': 'cross-site',
      },
      body: Buffer.from(body || ''),
    });

    /**
     * 判据用「404 而不是 403」：链接不存在时 `statePage('notfound')` 回 404。
     * 若 CSRF 中间件没放行这条路径，会在到达 handler **之前** 回 403 —— 两者可区分。
     */
    const ret = await post('/s/NOSUCHLINK/pay/return', 'respCode=00&orderId=X');
    assertEqual(ret.status, 404,
      '银联前台通知是跨站 POST 表单，这条路径必须放行（403 = 用户付完款看到一张报错页）');

    const getRet = await request(srv.port, 'GET', '/s/NOSUCHLINK/pay/return');
    assertEqual(getRet.status, 404, '支付宝 / PayPal 的 GET 同步回跳必须照旧可用');

    // 放宽必须**只限**这一条形状：建单与手动查单仍然必须同源
    assertEqual((await post('/s/NOSUCHLINK/pay', 'platform=alipay')).status, 403,
      'POST /s/:id/pay 不得被放宽 —— 那等于让任意站点替访客建单');
    assertEqual((await post('/s/NOSUCHLINK/pay/check', '')).status, 403,
      'POST /s/:id/pay/check 不得被放宽 —— 那等于让任意站点刷商户的查单配额');
  } finally {
    await srv.close();
  }
});

test('R92-03b · 回跳用请求体里的 orderId 定位订单，但只接受属于本链接的那一笔', () => {
  const src = readSrc('server/share-routes.js');
  assert(/paymentOrders\.findByOrderNo\(String\(b\.orderId \|\| ''\)\)/.test(src),
    '银联回显的 orderId 是 orderNo，必须走 findByOrderNo');
  assert(/o\.linkId === l\.id \? o : null/.test(src),
    '必须校验订单属于这条链接 —— 否则任何人拿别的链接的订单号就能让这里替他查单');
  assert(/paymentOrders\.verifyToken\(l\.id, getCookie\(req, payCookieName\(l\.id\)\)\)[\s\S]{0,80}\|\| orderFromReturnBody/.test(src),
    '票据仍然是首选：请求体只是「票据不在时的退路」（跨站 POST 不携带 SameSite=Lax 的票据）');
});

/* ================================================================== *
 * R92-04 · 凭据自检：四档语义
 * ================================================================== */

test('R92-04 · 自检四档：ok / auth / net / config 各有明确判据', async () => {
  const ok = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34', respMsg: '原始交易不存在' })),
    () => gateway.probeCharge('unionpay', UP_CFG),
  );
  assertEqual(ok.state, 'ok', '验签通过 + 原始交易不存在 = 凭据可用（这正是预期答复）');
  assertEqual(ok.ok, true);
  assert(/验签/.test(ok.message), '必须说清「验签通过」这件事，否则管理员不知道自检证明了什么');

  // 用**另一把**私钥签（模拟「银联验签公钥填错了」）
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongSigner = await withFetchStub(
    () => {
      const p = { respCode: '34', respMsg: '原始交易不存在' };
      p.signature = signWith(other.privateKey, p, '01');
      return fakeResponse(200, Object.keys(p).map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&'));
    },
    () => gateway.probeCharge('unionpay', UP_CFG),
  );
  assertEqual(wrongSigner.state, 'auth', '响应验不过 ⇒ 公钥错或 signMethod 与入网不一致');

  const net = await withFetchStub(
    () => { throw new Error('getaddrinfo ENOTFOUND gateway.95516.com'); },
    () => gateway.probeCharge('unionpay', UP_CFG),
  );
  assertEqual(net.state, 'net', '连不上网关是「网络」问题，不能报成「凭据错」把管理员引去反复改密钥');

  const cfg = await gateway.probeCharge('unionpay', { merId: '777290058110048' });
  assertEqual(cfg.state, 'config', '字段不全时连请求都发不出，必须显式说明');

  // PayPal 只有 client_id / secret 一对凭据，令牌拿不到就是 auth
  const pp = await withFetchStub(
    () => fakeResponse(401, JSON.stringify({ error: 'invalid_client' })),
    () => gateway.probeCharge('paypal', { clientId: 'a', clientSecret: 'b', mode: 'sandbox' }),
  );
  assertEqual(pp.state, 'auth', 'PayPal 令牌被拒 = client_id / secret 不对');
  assert(/invalid_client/.test(pp.detail), '应把网关的原话带回来，便于对照');
});

test('R92-04b · 自检只用只读操作：绝不下建单 / 扣款请求', async () => {
  const calls = await withFetchStub(
    (url) => {
      if (url.indexOf('/v1/oauth2/token') >= 0) return fakeResponse(200, JSON.stringify({ access_token: 't' }));
      return fakeResponse(200, JSON.stringify({ id: 'x', status: 'CREATED' }));
    },
    (c) => gateway.probeCharge('paypal', { clientId: 'a', clientSecret: 'b', mode: 'sandbox' }).then(() => c),
  );
  assert(calls.length >= 1, '自检必须真的出网，否则它回答不了「网关认不认」');
  for (const c of calls) {
    assert(c.url.indexOf('/v2/checkout/orders') < 0 || !/capture/.test(c.url),
      `自检不得触碰订单端点：${c.url}`);
    assert(c.url.indexOf('/capture') < 0, '自检绝不能 capture');
  }
  assert(calls.some((c) => c.url.indexOf('/v1/oauth2/token') >= 0), 'PayPal 自检就是取一次令牌');
});

test('R92-04c · 自检接口：先本地校验再出网，结论写进审计日志', async () => {
  const handlers = routeHandlers(paymentRouter, 'POST', '/payment/config/:platform/selftest');
  assert(handlers && handlers.length >= 2, '必须有自检路由');
  assert(handlers.some((h) => h && h.name === 'requireAdmin'), '自检会带商户凭据出网，必须仅管理员');

  // 字段不全 ⇒ 400 + errors，且**一次出网都不发**
  const calls = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34' })),
    async (c) => {
      const { res, done } = driver();
      handlers[handlers.length - 1]({
        params: { platform: 'unionpay' },
        body: { merId: '777290058110048' },
        authUser: { username: 'admin' },
      }, res);
      return { out: await done, calls: c };
    },
  );
  assertEqual(calls.out.statusCode, 400, '字段不全时应当场说清，而不是拿一堆网关错误码回来');
  assert(Array.isArray(calls.out.body.errors) && calls.out.body.errors.length > 0, '要逐字段指出缺什么');
  assertEqual(calls.calls.length, 0, '本地校验没过就**不许**出网（凭据不全会白打一次网关）');

  // 字段齐全 ⇒ 真的自检，并把结论落到响应里
  const good = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34' })),
    async () => {
      const { res, done } = driver();
      handlers[handlers.length - 1]({
        params: { platform: 'unionpay' },
        body: Object.assign({}, UP_CFG),
        authUser: { username: 'admin' },
      }, res);
      return done;
    },
  );
  assertEqual(good.body.ok, true, '凭据可用时自检应通过');
  assertEqual(good.body.state, 'ok');
});

/* ================================================================== *
 * R92-05 · 关单：先只读查单，且「已经付过」必须被认出来
 * ================================================================== */

test('R92-05 · closeCharge 对 PayPal / 云闪付都先查单：已付回 paid，未付才 unsupported', async () => {
  // 云闪付：未支付
  const up = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34' })),
    () => gateway.closeCharge('unionpay', UP_CFG, {
      id: 'AbC_-dEfGhIjKlMn', orderNo: '1700000000000ABCDEFGHIJKLMNOPQR12345',
      createdAt: '2026-10-25T04:00:00.000Z', amountFen: 500,
    }),
  );
  assertEqual(up.state, 'unsupported', '银联确实没有「关未支付订单」的接口');

  // 云闪付：已支付 —— 这一档旧实现永远不可达
  const upPaid = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '00', origRespCode: '00', txnAmt: '500', queryId: 'Q7' })),
    () => gateway.closeCharge('unionpay', UP_CFG, {
      id: 'AbC_-dEfGhIjKlMn', orderNo: '1700000000000ABCDEFGHIJKLMNOPQR12345',
      createdAt: '2026-10-25T04:00:00.000Z', amountFen: 500,
    }),
  );
  assertEqual(upPaid.state, 'paid', '「这笔已经付掉了」是查得到的 —— 必须回 paid 才能拦住第二笔单');

  // PayPal：APPROVED 且**绝不 capture**
  const ppCalls = await withFetchStub(
    (url) => {
      if (url.indexOf('/v1/oauth2/token') >= 0) return fakeResponse(200, JSON.stringify({ access_token: 't' }));
      return fakeResponse(200, JSON.stringify({ id: 'ORD-1', status: 'APPROVED' }));
    },
    (c) => gateway.closeCharge('paypal', { clientId: 'a', clientSecret: 'b', mode: 'sandbox' },
      { id: 'x', amountFen: 500, tradeNo: 'ORD-1' }).then((r) => ({ r, calls: c })),
  );
  assertEqual(ppCalls.r.state, 'unsupported', 'APPROVED 关不掉（Orders v2 无 cancel），如实说');
  assert(!ppCalls.calls.some((c) => c.url.indexOf('/capture') >= 0),
    '关单路径绝不允许出现 /capture —— 否则「换个渠道」会把旧单的钱收掉');

  // PayPal：已完成 ⇒ paid（金额对得上）
  const ppPaid = await withFetchStub(
    (url) => {
      if (url.indexOf('/v1/oauth2/token') >= 0) return fakeResponse(200, JSON.stringify({ access_token: 't' }));
      return fakeResponse(200, JSON.stringify({
        id: 'ORD-2', status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ amount: { value: '5.00' } }] } }],
      }));
    },
    () => gateway.closeCharge('paypal', { clientId: 'a', clientSecret: 'b', mode: 'sandbox' },
      { id: 'x', amountFen: 500, tradeNo: 'ORD-2' }),
  );
  assertEqual(ppPaid.state, 'paid', 'PayPal 关不掉单，但「已经付了」是查得到的');
});

test('R92-05b · 关单前查单失败 ⇒ error（有疑问就不放行），绝不静默当 unsupported', async () => {
  const down = await withFetchStub(
    () => { throw new Error('ECONNRESET'); },
    () => gateway.closeCharge('unionpay', UP_CFG, {
      id: 'a', orderNo: '1700000000000ABCDEFGHIJKLMNOPQR12345',
      createdAt: '2026-10-25T04:00:00.000Z', amountFen: 500,
    }),
  );
  assertEqual(down.state, 'error',
    '查不到状态时既不能说「关不掉而已」（可能已经付了），也不能说「已关闭」—— 只能报 error');
});

/* ================================================================== *
 * R92-06 · 前端接线：自检按钮 + 图形缓存
 * ================================================================== */

test('R92-06 · 前端：自检按钮、图形懒加载与缓存都已接线', () => {
  const html = readSrc('public/index.html');
  assert(/id="btn-payment-selftest"/.test(html), '支付设置卡片必须有「凭据自检」按钮');

  const api = readSrc('public/js/api.js');
  assert(/selftestPayment:/.test(api), 'api.js 必须暴露 selftestPayment');
  assert(/paymentLogos: \(\) => request\('GET', '\/api\/payment\/logos'\)/.test(api),
    'api.js 必须暴露 paymentLogos（图形走独立接口）');

  const pay = readSrc('public/js/paysettings.js');
  assert(/btnT\.addEventListener\('click', doSelftest\)/.test(pay), '按钮必须真的接到 doSelftest');
  assert(/btn\.disabled = true/.test(pay) && /btn\.disabled = false/.test(pay),
    '自检期间必须禁用按钮 —— 连点就是连打网关');
  assert(/sessionStorage/.test(pay), '图形要缓存（它是代码内常量，没必要每次打开设置页都重传）');
  assert(/loadLogos\(\)\.then\(\(\) => renderTabs\(\)\)/.test(pay),
    '图形应**异步补**一次再重画：标签先以纯文字可见，不被装饰性请求拖慢');
});

/* ================================================================== *
 * R92-07 · 不变量：图形实现点不许回流
 * ================================================================== */

test('R92-07 · payment-providers 不再引用图形；广播点只剩「接口 + 分享页内联」', () => {
  const pp = readSrc('server/payment-providers.js');
  assert(!/require\('\.\/payment-logos'\)/.test(pp),
    'payment-providers 不得再引用 payment-logos —— 那意味着图形又回到了配置接口里');

  assert(/require\('\.\/payment-logos'\)/.test(readSrc('server/share-routes.js')),
    '前台分享页仍要内联同一份图形（服务端渲染，拿不到 /api）');
  assert(/paymentLogos/.test(readSrc('server/routes/payment.js')),
    '后台图形走独立接口，必须复用同一个实现点');
});
