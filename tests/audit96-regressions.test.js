/**
 * 第九十六轮护栏：《支付系统支付链路复检》（DeepSeek V4.1 Flash 1017，`1.md`）
 *
 * ## 来源
 *
 *   复检报告确认 R95 的两条修复成立，同时给出**一条同源分叉**：
 *   「改价后页面价 ≠ 实扣价」只修好了**无券**那条路径；一旦在途订单上挂过券，
 *   付费页仍然会按原价渲染，而下单侧照旧按券后价复用/新建 —— 两个数又分叉了。
 *
 * ## 缺陷形态（报告第 4 节，逐条复现如下）
 *
 *   `couponStateFor()` 用 `couponStore.validateForUse()` 判断「这张券还能不能用」，
 *   而券是在**建单那一刻**核销的：只要那张在途单还在，同一张券对同一身份就必然是
 *   `already_used`（`perUserOnce`）/ `disabled` / `expired`。于是付费页拿到 `ok:false`，
 *   按**原价**渲染、且不渲染 hidden `coupon`；而 `POST /s/:id/pay` 的 `submittedCode`
 *   会回落到券 Cookie ⇒ `couponChanged=false` ⇒ 命中「复用在途订单」或「旧单占着同一
 *   张券 ⇒ 先退券再重验」的例外 ⇒ 按券后价出单。
 *
 *   方向是「页面比实扣贵」（用户不会多付），但订单台账与页面承诺的金额不一致，
 *   对账/客诉时这是唯一线索 —— 与 R62 整轮在消灭的那类分叉同源。
 *
 * ## 判据
 *
 *   全部落在**真实 HTTP 路由**上，断言「付费页上那个数」与「交给网关的金额」相等，
 *   并且复用/新建的结果与页面显示一致。夹具里券的三种「已不可用」形态分别覆盖
 *   `already_used` / `disabled` / `expired` 三个 reason。
 */
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r96-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 打桩：真实路由 + 真实 store，只替换外部依赖
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
      enabled: true, appId: '2021000000000000', privateKey: 'x', signType: 'RSA2',
      alipayPublicKey: 'y', gateway: 'https://openapi.alipay.com/gateway.do',
    },
    wechat: {
      enabled: true, mchId: '1900000001', appId: 'wx0000000000000001',
      apiV3Key: 'k'.repeat(32), serialNo: 'SERIAL', privateKey: 'x',
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
/** 与链接当前标价同步（改价场景必须真的改到这一层，否则等于把被测场景抹平） */
paymentRules.resolvePaidState = ({ linkPaid }) => ({
  required: true, effective: true,
  amountFen: Number(linkPaid && linkPaid.amountFen) || 0,
  currency: 'CNY', reason: '',
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

paymentGateway.closeCharge = async () => ({ ok: true, state: 'closed' });

/** 下单桩：记下「交给网关的金额」—— 这就是买家真正会被扣的钱 */
const charges = [];
paymentGateway.createCharge = async (platform, cfg, opts) => {
  charges.push({ platform, orderId: opts.order.id, amountFen: opts.order.amountFen });
  return { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
};
paymentGateway.queryCharge = async () => ({ paid: false, state: 'pending', tradeNo: '', failReason: '' });

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
    : '';
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (port, p, headers) => call(port, 'GET', p, { headers });
const postForm = (port, p, fields, headers) => call(port, 'POST', p, { fields, headers });

let seq = 0;
async function makePaidLink(amountFen) {
  seq += 1;
  return shareStore.create({
    key: 'r96/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen, currency: 'CNY' },
  });
}

/** 一张只对这条链接生效的券 */
function makeCoupon(l, amountFen, perUserOnce) {
  return couponStore.generate({
    count: 1, type: 'links', linkIds: [l.id], amountFen, perUserOnce,
  })[0];
}

/**
 * 买家浏览器的 Cookie：**订单票据 + 券**。
 *
 * 券 Cookie 是 `POST /s/:id/coupon` 落的（这里直接构造，等价于「本页渲染时选中的
 * 那张券」）。下单侧 `submittedCode` 会回落到它 —— 这正是缺陷成立的通道。
 */
const cookieOf = (l, order, coupon) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order))
  + (coupon ? '; sp_' + l.id + '_coupon=' + encodeURIComponent(coupon) : '');

/** 付费页上那个大金额（`<div class="pay-amount">¥x.xx</div>`）—— 用户看到的数 */
function pageAmount(html) {
  const m = /<div class="pay-amount">¥([\d.]+)<\/div>/.exec(html);
  return m ? m[1] : '';
}
const fenText = (fen) => (fen / 100).toFixed(2);

/** 建一笔带券的在途单（券在这一刻被核销） */
async function firstOrderWithCoupon(port, l, coupon, priceFen) {
  const r = await postForm(port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code });
  assert(/正在跳转到/.test(r.raw), `带券下单应正常跳转，实际：${r.raw.slice(0, 300)}`);
  const order = paymentOrders.get(charges[charges.length - 1].orderId);
  assertEqual(order.amountFen, priceFen, '首单应按券后价下单');
  assertEqual(order.couponCode, coupon.code, '首单应挂上这张券');
  return order;
}

/* ================================================================== *
 * 券路径：页面价 = 实扣价
 * ================================================================== */
test('R96-01 · 券被自己的在途单占着（perUserOnce）：付费页必须显示实扣价，而不是原价', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500); // ¥5.00
    const coupon = makeCoupon(l, 100, true); // 减 ¥1.00 ⇒ 应付 ¥4.00，且每人只能用一次
    const first = await firstOrderWithCoupon(srv.port, l, coupon, 400);

    /**
     * 用户从「支付中」页点「重新发起支付」回到付费页。此刻券已被首单核销，
     * `validateForUse()` 必然返回 `already_used` —— 但钱其实还是按 ¥4.00 收。
     */
    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first, coupon.code) });
    const shown = pageAmount(page.raw);
    assertEqual(shown, '4.00', `付费页应显示实扣价 ¥4.00（券被在途单占用不是「不可用」），实际 ${shown}`);
    assert(/<input type="hidden" name="coupon" value="/.test(page.raw),
      '页面必须继续回传这张券 —— 否则「立即支付」等于把券丢掉，按原价新建一笔');

    // 照页面点「立即支付」—— 页面此时会带 hidden coupon；即使不带，Cookie 也还挂着它
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code },
      { cookie: cookieOf(l, first, coupon.code) });
    assert(/正在跳转到/.test(r2.raw), `应照常出单，实际：${r2.raw.slice(0, 300)}`);

    const last = charges[charges.length - 1];
    assertEqual(fenText(last.amountFen), shown,
      `★交给网关的金额必须等于页面上那个数（页面 ¥${shown}，实扣 ¥${fenText(last.amountFen)}）`);
    assertEqual(last.orderId, first.id, '同渠道同券同价 ⇒ 复用在途单（不得白废一张已核销的券）');
  } finally {
    await srv.close();
  }
});

test('R96-02 · 券被在途单占着 + 分享者改价：页面价必须等于按新标价复算的实扣价', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500);
    const coupon = makeCoupon(l, 100, true);
    const first = await firstOrderWithCoupon(srv.port, l, coupon, 400);

    // 标价 ¥5.00 → ¥3.00（券后 ¥2.00）⇒ 旧单不能复用
    await shareStore.update(l.id, { paid: { required: true, amountFen: 300, currency: 'CNY' } });

    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first, coupon.code) });
    const shown = pageAmount(page.raw);
    assertEqual(shown, '2.00', `付费页应按「新标价 − 券」显示 ¥2.00，实际 ${shown}`);

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code },
      { cookie: cookieOf(l, first, coupon.code) });
    assert(/正在跳转到/.test(r2.raw), `应照常出单，实际：${r2.raw.slice(0, 300)}`);

    const last = charges[charges.length - 1];
    assertEqual(fenText(last.amountFen), shown,
      `★页面 ¥${shown} ≠ 实扣 ¥${fenText(last.amountFen)}（旧单作废后新单仍挂同一张券）`);
    assert(last.orderId !== first.id, '标价变了 ⇒ 必须另建新单');
    assertEqual(paymentOrders.get(first.id).status, 'failed', '被放弃的在途单必须收尾为失败');
  } finally {
    await srv.close();
  }
});

test('R96-03 · 券在途单建好后被停用：复用在途单就是实扣价，页面不得改回原价', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500);
    const coupon = makeCoupon(l, 100, false);
    const first = await firstOrderWithCoupon(srv.port, l, coupon, 400);

    couponStore.update(coupon.id, { disabled: true });

    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first, coupon.code) });
    const shown = pageAmount(page.raw);
    assertEqual(shown, '4.00', `在途单已按券后价挂在网关侧 ⇒ 页面必须显示 ¥4.00，实际 ${shown}`);

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code },
      { cookie: cookieOf(l, first, coupon.code) });
    assert(/正在跳转到/.test(r2.raw), `应照常出单，实际：${r2.raw.slice(0, 300)}`);
    const last = charges[charges.length - 1];
    assertEqual(fenText(last.amountFen), shown,
      `★页面 ¥${shown} ≠ 实扣 ¥${fenText(last.amountFen)}（券停用不影响已在途的订单快照）`);
    assertEqual(last.orderId, first.id, '同价 ⇒ 复用');
  } finally {
    await srv.close();
  }
});

test('R96-04 · 券在途单建好后过期：同样不得把页面价改回原价', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500);
    const coupon = makeCoupon(l, 100, false);
    const first = await firstOrderWithCoupon(srv.port, l, coupon, 400);

    couponStore.update(coupon.id, { expireAt: new Date(Date.now() - 60000).toISOString() });

    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first, coupon.code) });
    const shown = pageAmount(page.raw);
    assertEqual(shown, '4.00', `页面必须显示 ¥4.00，实际 ${shown}`);

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code },
      { cookie: cookieOf(l, first, coupon.code) });
    assert(/正在跳转到/.test(r2.raw), `应照常出单，实际：${r2.raw.slice(0, 300)}`);
    assertEqual(fenText(charges[charges.length - 1].amountFen), shown, '页面价必须等于实扣价');
  } finally {
    await srv.close();
  }
});

test('R96-05 · 扫码页：金额取订单、且不得把刚核销的券说成「您已使用过」', async () => {
  const srv = await serve();
  const realCreate = paymentGateway.createCharge;
  try {
    /**
     * 扫码渠道（微信 Native / 支付宝当面付）走的是**同一个** `payPage()`，券状态也来自
     * `couponStateFor()`。建单时券刚被核销 ⇒ 旧实现在这一页会画出「您已使用过该优惠券」
     * 的告警 —— 而钱明明就是按这张券算的。金额那一侧由 R93 兜住（取订单快照）。
     */
    paymentGateway.createCharge = async (platform, cfg, opts) => {
      charges.push({ platform, orderId: opts.order.id, amountFen: opts.order.amountFen });
      return { ok: true, kind: 'qrcode', codeUrl: 'weixin://wxpay/bizpayurl?pr=r96abcdef' };
    };
    const l = await makePaidLink(500);
    const coupon = makeCoupon(l, 100, true);
    /**
     * ⚠️ 券 Cookie 必须一起带上：`payPage()` 的券状态取自 `couponStateFor()`（读 Cookie），
     * 而不是本次表单里的 hidden `coupon`。真实流程里 `POST /s/:id/coupon` 会落这张 Cookie，
     * 不带它这条用例就**测不到**那句告警（判据会被「没选券」这条更早的短路满足）。
     */
    const r = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'wechat', coupon: coupon.code },
      { cookie: 'sp_' + l.id + '_coupon=' + encodeURIComponent(coupon.code) });
    assert(/<div class="pay-amount">/.test(r.raw), `应就地画出二维码页，实际：${r.raw.slice(0, 300)}`);
    assertEqual(pageAmount(r.raw), '4.00', '扫码页金额取订单快照（券后 ¥4.00）');
    assert(!/已使用过该优惠券/.test(r.raw),
      '刚用这张券建的单，不能反过来告诉用户「您已使用过该优惠券」');
  } finally {
    paymentGateway.createCharge = realCreate;
    await srv.close();
  }
});

test('R96-06 · 对照：券仍可重复使用 / 完全无券时，页面价与实扣价照旧一致', async () => {
  const srv = await serve();
  try {
    // ① 券可重复用 ⇒ 页面本来就按券后价渲染，不该被本次修复改坏
    const l1 = await makePaidLink(500);
    const c1 = makeCoupon(l1, 100, false);
    const o1 = await firstOrderWithCoupon(srv.port, l1, c1, 400);
    const p1 = await get(srv.port, '/s/' + l1.id + '?restart=1', { cookie: cookieOf(l1, o1, c1.code) });
    assertEqual(pageAmount(p1.raw), '4.00', '可重复使用的券：页面 ¥4.00');
    await postForm(srv.port, '/s/' + l1.id + '/pay', { platform: 'alipay', coupon: c1.code },
      { cookie: cookieOf(l1, o1, c1.code) });
    assertEqual(fenText(charges[charges.length - 1].amountFen), '4.00', '可重复使用的券：实扣 ¥4.00');

    // ② 完全无券 ⇒ 原价，且不能被「在途单」逻辑污染
    const l2 = await makePaidLink(500);
    const r = await postForm(srv.port, '/s/' + l2.id + '/pay', { platform: 'alipay' });
    assert(/正在跳转到/.test(r.raw), '无券下单应正常跳转');
    const o2 = paymentOrders.get(charges[charges.length - 1].orderId);
    const p2 = await get(srv.port, '/s/' + l2.id + '?restart=1', { cookie: cookieOf(l2, o2) });
    assertEqual(pageAmount(p2.raw), '5.00', '无券：页面 ¥5.00');
  } finally {
    await srv.close();
  }
});
