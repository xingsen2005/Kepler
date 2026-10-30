/**
 * 第九十五轮护栏：《支付系统检查报告》（DeepSeek V4.1 Flash 1017）逐条复核
 *
 * ## 来源
 *
 *   用户：「逐条分析 Payment_audit_report.md 中的漏洞是否真实存在，对于确实存在且有必要
 *          修复的进行修复。对于没必要修复的或不存在漏洞的，写入 Audit_illusion_report.md」
 *
 * 报告只有两条结论，**两条都成立**（第 4 节那条未验证线索见幻觉台账）：
 *
 *  · ①【严重】`placeFormat()` 把格式信息的 (行, 列) 整体写反 —— 15 个比特里
 *    `m[8][8]` 是唯一不动点，其余 14 位全部错位，解码器在标准位置读回来恰好是
 *    「正确串的逐位颠倒」，BCH 把它纠成**另一组** (纠错级别, 掩码)，于是数据区
 *    写得再对也解不出内容。微信 Native / 支付宝当面付 / 分享二维码全部扫不出来。
 *    佐证：`tests/qrcode.test.js` 的旧用例**照抄了实现写错的那套坐标**去回读，
 *    位序内部自洽 ⇒ 行列写反从它眼皮底下通过（典型的「拿实现验实现」）。
 *  · ②【中】复用在途订单的判据只看「渠道 + 券码」，不看金额 —— 分享者改价后，
 *    付费页（`ps.amountFen`，链接当前标价）与交给网关的金额（`order.amountFen`，
 *    订单快照）分叉。页面 ¥10、实扣 ¥5，或页面 ¥5、实扣 ¥10，且没有任何提示。
 *    根因是 R84（L-2）那句推理漏了一项：应付额 = f(标价, 券)，**券码相同只保证
 *    第二个入参没变**。
 *
 * ## 判据落点
 *
 *  · ①落在 **`tests/qrcode.test.js`** 的「独立解码器」一节 —— 那里按规范另写了一份
 *    解码器（功能图案占位 / 格式信息位置 / 反掩码 / 反交织 / RS 校验子 / Byte 模式），
 *    能解回原文才算「扫得出来」。本文件不重复一份。
 *  · ②落在**真实 HTTP 路由**（起 express、真 POST 表单），断言「页面显示的金额」
 *    与「交给网关的金额」相等 —— 这正是报告里那条判据，也正好是旧实现做不到的事。
 *
 * ## 隔离
 *
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r95-');
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
/**
 * ⚠️ 这里**必须**跟着链接的当前标价走（不能像 R84 的夹具那样写死 100 分）：
 * 报告第 2 条说的就是「标价在两次提交之间变了」，夹具写死常量等于把被测场景抹平
 * —— R84 抓不到这条缺陷，一半原因就在这里。
 */
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
    key: 'r95/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen, currency: 'CNY' },
  });
}

const cookieOf = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

/** 付费页上那个大金额（`<div class="pay-amount">¥x.xx</div>`）—— 用户看到的数 */
function pageAmount(html) {
  const m = /<div class="pay-amount">¥([\d.]+)<\/div>/.exec(html);
  return m ? m[1] : '';
}

/* ================================================================== *
 * ② 改价后复用「在途订单」
 * ================================================================== */
test('R95-01 · 标价上涨后再次提交：必须按新价另建新单，页面价 = 实扣价', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500); // ① 建单时 ¥5.00

    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' });
    assert(/正在跳转到/.test(r1.raw), `第一次应正常跳到收银台，实际：${r1.raw.slice(0, 200)}`);
    const first = paymentOrders.get(charges[charges.length - 1].orderId);
    assertEqual(first.amountFen, 500, '第一笔按 ¥5.00 下单');

    // ② 分享者改价 → ¥10.00（在途订单的 2 小时保留窗口内）
    await shareStore.update(l.id, { paid: { required: true, amountFen: 1000, currency: 'CNY' } });

    // ③ 付费页（?restart=1，用户最后一次看到的价格）
    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first) });
    const shown = pageAmount(page.raw);
    assertEqual(shown, '10.00', `付费页应显示当前标价 ¥10.00，实际 ${shown}`);

    // ④ 再点「立即支付」
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' }, { cookie: cookieOf(l, first) });
    assert(/正在跳转到/.test(r2.raw), `改价后应照常出单，实际：${r2.raw.slice(0, 300)}`);

    const last = charges[charges.length - 1];
    const second = paymentOrders.get(last.orderId);
    assertEqual((last.amountFen / 100).toFixed(2), shown,
      `★交给网关的金额必须等于页面上那个数（页面 ¥${shown}，实扣 ¥${last.amountFen / 100}）`);
    assert(second.id !== first.id,
      '★标价变了就不能复用在途单 —— 复用等于按旧价扣款，页面价与实扣价分叉');
    assertEqual(second.amountFen, 1000, `新单应付 ¥10.00，实际 ${second.amountFen} 分`);
    assertEqual(paymentOrders.get(first.id).status, 'failed', '被放弃的在途单必须收尾为失败');
    assert(/标价/.test(String(paymentOrders.get(first.id).failReason)),
      `失败原因要说清是改价导致的，实际：${paymentOrders.get(first.id).failReason}`);
  } finally {
    await srv.close();
  }
});

test('R95-02 · 标价下调后再次提交：不得仍按旧的高价扣款', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(1000); // ① ¥10.00
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' });
    assert(/正在跳转到/.test(r1.raw), '第一次应正常出单');
    const first = paymentOrders.get(charges[charges.length - 1].orderId);
    assertEqual(first.amountFen, 1000, '第一笔按 ¥10.00 下单');

    await shareStore.update(l.id, { paid: { required: true, amountFen: 500, currency: 'CNY' } });
    const page = await get(srv.port, '/s/' + l.id + '?restart=1', { cookie: cookieOf(l, first) });
    assertEqual(pageAmount(page.raw), '5.00', '付费页应显示降价后的 ¥5.00');

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' }, { cookie: cookieOf(l, first) });
    assert(/正在跳转到/.test(r2.raw), `降价后应照常出单，实际：${r2.raw.slice(0, 300)}`);
    const last = charges[charges.length - 1];
    assertEqual(last.amountFen, 500,
      `★降价后绝不能仍按旧单的 ¥10.00 下单（实扣 ${last.amountFen} 分）`);
    assert(last.orderId !== first.id, '降价同样要另建新单');
  } finally {
    await srv.close();
  }
});

test('R95-03 · 标价变了但券后应付没变：应当复用，不该白废一张在途单（判据是应付额不是标价）', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500); // ¥5.00
    const coupon = couponStore.generate({
      count: 1, type: 'links', linkIds: [l.id], amountFen: 1000, perUserOnce: false,
    })[0]; // ¥10.00 券 > 标价 ⇒ 应付封顶到 ¥0.01

    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code });
    assert(/正在跳转到/.test(r1.raw), `带券下单应正常跳转，实际：${r1.raw.slice(0, 300)}`);
    const first = paymentOrders.get(charges[charges.length - 1].orderId);
    assertEqual(first.amountFen, 1, '券面大于标价 ⇒ 应付封顶到 1 分');

    // 标价 ¥5.00 → ¥3.00，券后应付仍是 1 分 ⇒ 没有分叉，不该重建
    await shareStore.update(l.id, { paid: { required: true, amountFen: 300, currency: 'CNY' } });
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code },
      { cookie: cookieOf(l, first) });
    assert(/正在跳转到/.test(r2.raw), '券后应付未变时应照常跳转');

    /**
     * 判据比的是**应付额**而不是标价：这里标价真的变了，但用户实际要付的钱没变，
     * 复用在网关侧已经下过单的那笔才是正确处置（新建只会白白多一笔出网 + 废一张券）。
     */
    assertEqual(charges[charges.length - 1].orderId, first.id,
      '★标价变了但券后应付不变 ⇒ 必须复用（拿标价当判据会误伤）');
    assertEqual(paymentOrders.listForLink(l.id).length, 1, '不该产生第二笔订单');
  } finally {
    await srv.close();
  }
});

test('R95-04 · 对照：标价没变时仍然复用（不得把正常幂等一起改坏）', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink(500);
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' });
    assert(/正在跳转到/.test(r1.raw), '第一次应正常出单');
    const first = paymentOrders.get(charges[charges.length - 1].orderId);

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' }, { cookie: cookieOf(l, first) });
    assert(/正在跳转到/.test(r2.raw), '同渠道同价重提应正常跳转');
    assertEqual(charges[charges.length - 1].orderId, first.id, '同价必须复用，不得新建');
    assertEqual(paymentOrders.listForLink(l.id).length, 1, '一共只应有一笔订单');
  } finally {
    await srv.close();
  }
});
