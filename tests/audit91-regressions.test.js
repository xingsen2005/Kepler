/**
 * 第九十一轮护栏：接入云闪付（银联全渠道）+ 前台付费页显示渠道图标
 *
 * 两件事收在一轮里，因为它们共用同一个落点：
 *
 *  ① **云闪付**（不讨论资质，入网材料由使用者准备）。云闪付没有独立的聚合开放平台，
 *     商户侧接的仍是**银联全渠道网关支付**：`frontTransReq.do` + `k=v&` 表单串 +
 *     `signature` 签名。它与既有三家的差别全在细节里，而细节恰恰是最容易写错的地方：
 *       · 待签串剔除的是 `signature`（支付宝是 `sign`），规则一样但**字段名不同**；
 *       · 报文**不是 JSON**，响应是 `respCode=00&…` 的表单串，值还要逐字段 URL 解码；
 *       · 一笔交易由 `merId + orderId + txnTime` 三要素确定，`txnTime` 查询时必须原样回送；
 *       · `orderId` 只许 8~40 位**字母数字**，本系统的记录 id 是 base64url（含 `-` `_`），
 *         直接送过去会被判报文格式错误。
 *  ② **前台付费页的支付方式图标**。此前只有后台「支付设置」有图标，前台是一排纯文字。
 *     现在两处共用 `server/payment-logos.js`（唯一实现点），前台那份由服务端内联渲染。
 *
 * ## 分层（每条判据都落在**实际被执行的那一层**）
 *
 *  · 注册表层：`ORDER` / `list()` / `clientSchema()` 的顺序与「图形不再随配置下发」
 *  · 渲染层：`__payOptionHtml()` —— 图标**在名称左侧**只能靠驱动它来证明
 *  · 网关层：`createCharge('unionpay')` 出的 URL 要素 + 签名可被公钥验过
 *  · 查单层：真 `queryCharge` + fetch 桩，走「验签在业务字段之前」与三档状态
 *  · 通知层：真 express + 真 HTTP，验签不过 403、过了 200
 *  · 关单层：**先只读查单**再回答（R92 起）—— 未付才 `unsupported`，已付必须回 `paid`，
 *    以及「验签口径 / 通知定位」这两处判据本身
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

/** ⚠️ 先设数据目录再 require 任何 store，否则会写到项目真实的 data/ */
const tmp = makeTempDir('r91-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const providers = require(SERVER('payment-providers.js'));
const gateway = require(SERVER('payment-gateway.js'));
const logos = require(SERVER('payment-logos.js'));
const configStore = require(SERVER('config-store.js'));
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 现场生成真实 RSA 密钥对：签名/验签这两条必须真的跑过才算数 */
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const PUB = KEY.publicKey.export({ type: 'spki', format: 'pem' }).trim();

const UP_CFG = {
  merId: '777290058110048',
  privateKey: PRIV,
  unionpayPublicKey: PUB,
  signMethod: '01',
};

/**
 * 订单夹具。
 *
 * 刻意让 `id` 带上 `_` 与 `-`（base64url 的真实形态）——「银联不收这种订单号」这条
 * 纪律只有在夹具真的像真订单时才有意义。
 * `orderNo` 是 36 位纯 base62（13 时间戳 + 9 链接 + 9 用户 + 5 随机），与 `order-no.js` 同构。
 */
const UP_ORDER = {
  id: 'AbC_-dEfGhIjKlMn',
  orderNo: '1700000000000ABCDEFGHIJKLMNOPQR12345',
  createdAt: '2026-10-25T04:00:00.000Z', // 北京时间 2026-10-25 12:00:00
  amountFen: 500,
};

/** 按银联规则对一组参数加签（**测试侧独立实现**，不复用被测函数的签名路径） */
function signUp(params, signMethod) {
  const algo = signMethod === '11' ? 'RSA-SHA256' : 'RSA-SHA1';
  const payload = Object.keys(params)
    .filter((k) => k !== 'signature' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createSign(algo).update(payload, 'utf8').sign(PRIV, 'base64');
}

/** 表单串（值 URL 编码，键序打乱 —— 银联的签名与键序无关） */
function formBody(params) {
  return Object.keys(params).reverse()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
}

/** 起一个只挂分享路由的本地服务（`listen(0)` 拿临时端口，避免并发跑文件时撞端口） */
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

/** 替换全局 fetch 并记录调用（覆盖 `fetchWithTimeout` 的出站） */
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

/* ================================================================== *
 * R91-01 · 位置：云闪付排在微信与 PayPal 之间
 * ================================================================== */

test('R91-01 · 云闪付排在微信支付与 PayPal 之间，且前后台共用同一个顺序', () => {
  assertEqual(providers.ORDER.join(','), 'alipay,wechat,unionpay,paypal',
    '「后台配置里云闪付的位置要在微信支付和 PayPal 之间」是用户明确要求的位置');
  assertEqual(providers.list().map((p) => p.id).join(','), providers.ORDER.join(','),
    'list() 必须按 ORDER 输出 —— 前台付费页与后台标签都靠它排');

  const p = providers.platform('unionpay');
  assert(p && p.name === '云闪付', '平台名应为「云闪付」');
  assert(p.shortName === 'UnionPay', '英文名应为 UnionPay');

  /**
   * 顺序只有一份：前端不得另存一份 ORDER。
   * 上一轮之前 `public/js/payment-logos.js` 里就有一份（`const ORDER = [...]`），
   * 加渠道时漏改它，前台顺序就会和后台不一致 —— 现在那份文件已删除。
   */
  const jsFiles = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'));
  const dup = jsFiles.filter((f) => /const ORDER\s*=\s*\[.*(alipay|unionpay)/.test(readSrc(`public/js/${f}`)));
  assertEqual(dup.join(','), '', `前端不得再存一份渠道顺序：${dup.join(',')}`);
});

/* ================================================================== *
 * R91-02 · 图形：唯一实现点，前后台同源
 * ================================================================== */

test('R91-02 · 渠道图形只有一个实现点，且不再随配置接口下发（R92 改口径）', () => {
  const schema = providers.clientSchema();
  assertEqual(schema.length, 4, '四个渠道都要下发');

  /**
   * ⚠️ R92 改掉了这一条的判据方向。
   *
   * 上一轮断言的是「`clientSchema()` 必须带 `logo`」，理由是同源。但那份 logo 让
   * `GET /api/payment/config` 从 ~9 KB 涨到 ~25 KB，而图形是**代码内常量**、
   * 一个字节都不会变，却跟着「每次打开支付设置」重传。现在图形走
   * `GET /api/payment/logos`（长缓存），这里改成断言**它不许回来**。
   *
   * 同源这件事没有丢：前后台仍然只有 `payment-logos.js` 一个实现点，
   * 后台经那条接口取、前台在服务端渲染时内联，见下面的逐字节断言与 R91-04。
   */
  for (const p of schema) {
    assert(!('logo' in p),
      `${p.id} 不得再随配置接口下发 logo —— 那会让 GET /api/payment/config 重回 ~25 KB（R92）`);
  }

  // 唯一实现点仍然产出合法图形，且尺寸类与后台标签一致
  for (const id of providers.ORDER) {
    const svg = logos.logo(id, { size: 'sm' });
    assert(svg.indexOf('<svg') > 0, `${id} 的图形必须是真的内联 SVG`);
    assert(svg.indexOf('pv-logo--sm') > 0, `${id} 的图形必须带尺寸类（与后台标签一致）`);
  }

  // 云闪付的图形确实来自图标源文件（红色主块 + 底部三色条）
  const upSvg = logos.logoSvg('unionpay');
  assert(upSvg.length > 5000, '云闪付图形应包含完整的路径数据');
  assert(upSvg.indexOf('#FD2821') > 0, '云闪付主色应为 #FD2821');
  assert(upSvg.indexOf('#066B6A') > 0 && upSvg.indexOf('#0A2F69') > 0 && upSvg.indexOf('#E41D21') > 0,
    '云闪付图标底部三色条（#066B6A / #0A2F69 / #E41D21）必须在');

  // 未知渠道降级成空串（调用方据此退回纯文字），不抛错
  assertEqual(logos.logo('stripe'), '', '未知渠道应返回空串而不是抛错');
  assertEqual(logos.has('stripe'), false, 'has() 对未知渠道应为 false');
});

test('R91-03 · 图形只有一个实现点：前端副本已删除且不再被 import', () => {
  assert(!exists('public/js/payment-logos.js'),
    '前端不得再留一份图形数据 —— 两份必然漂移（改一家颜色要改两处）');

  const pay = readSrc('public/js/paysettings.js');
  assert(!/from '\.\/payment-logos\.js'/.test(pay), 'paysettings.js 不得再 import 已删除的模块');
  // R92：图形改为从独立接口取一次并缓存，标签渲染读缓存里的那份
  assert(/API\.paymentLogos\(\)/.test(pay), '必须从 GET /api/payment/logos 取图形（配置接口已不再下发）');
  assert(/logos\[p\.id\]/.test(pay), '后台标签必须渲染取回并缓存的那份图形');
});

/* ================================================================== *
 * R91-04 · 前台付费页：图标在名称**左侧**
 * ================================================================== */

test('R91-04 · 前台付费页的支付方式按钮：图标在名称左侧，且缺失渠道不会打挂整页', () => {
  const share = require(SERVER('share-routes.js'));
  assertEqual(typeof share.__payOptionHtml, 'function', '需要 __payOptionHtml 才能直接驱动这条判据');

  const html = share.__payOptionHtml('unionpay', true);
  const radio = html.indexOf('type="radio"');
  const svg = html.indexOf('<svg');
  const name = html.indexOf('<span>云闪付</span>');

  assert(radio >= 0, '必须仍是一个可点击的单选行');
  assert(svg > 0, '支付方式**必须带图标**（此前的缺陷就是这里只有一个纯文字 <span>）');
  assert(name > 0, '名称必须仍在');
  assert(radio < svg, '顺序应为「单选钮 → 图标 → 名称」');
  assert(svg < name, '图标必须在名称**左侧**（用户明确要求的排布）');
  assert(html.indexOf('checked') > 0, 'checked 应落在被选中的那一项上');

  const plain = share.__payOptionHtml('stripe', false);
  assert(plain.indexOf('<span>stripe</span>') > 0, '未知渠道要退回文字，而不是让整页 500');
  assertEqual(plain.indexOf('<svg'), -1, '未知渠道没有图形，不能凭空造一个空盒子');
});

test('R91-05 · 分享页样式表里 .pv-logo 与后台同名同形（图标不会被挤走）', () => {
  const src = readSrc('server/share-routes.js');
  assert(/\.pv-logo \{[^}]*flex: 0 0 auto/.test(src),
    '.pv-logo 必须 flex:0 0 auto —— 否则长渠道名会把图标压变形');
  assert(/\.pv-logo--sm \{ width: 22px; height: 22px/.test(src), '.pv-logo--sm 尺寸要与后台一致');
  assert(/\.pay-opt \{[^}]*display: flex/.test(src), '.pay-opt 必须是 flex 行，图标与文字才能对左对齐');
});

/* ================================================================== *
 * R91-06 · 下单：URL 要素齐全，签名可被公钥验过
 * ================================================================== */

test('R91-06 · 云闪付下单产出的跳转 URL：要素齐全、签名可验', async () => {
  const r = await gateway.createCharge('unionpay', UP_CFG, {
    order: UP_ORDER,
    returnUrl: 'https://pay.example.com/s/LK1/pay/return',
    notifyUrl: 'https://pay.example.com/pay/notify/unionpay',
  });
  assert(r.ok, `下单必须成功：${r.error || ''}`);
  assertEqual(r.kind, 'redirect', '银联走跳转收银台，不是二维码');

  const sp = new URL(r.url).searchParams;
  assertEqual(new URL(r.url).host, 'gateway.95516.com', '默认网关主机');
  assertEqual(sp.get('version'), '5.1.0');
  assertEqual(sp.get('encoding'), 'UTF-8');
  assertEqual(sp.get('signMethod'), '01');
  assertEqual(sp.get('txnType'), '01', '01 = 消费');
  assertEqual(sp.get('txnSubType'), '01');
  assertEqual(sp.get('bizType'), '000201', '000201 = B2C 网关支付（云闪付就在这个产品下）');
  assertEqual(sp.get('channelType'), '07', '07 = 互联网（PC）');
  assertEqual(sp.get('accessType'), '0', '0 = 商户直连');
  assertEqual(sp.get('merId'), UP_CFG.merId);
  assertEqual(sp.get('currencyCode'), '156');
  assertEqual(sp.get('txnAmt'), '500', '金额以**分**为单位的整数文本上送');
  assertEqual(sp.get('frontUrl'), 'https://pay.example.com/s/LK1/pay/return');
  assertEqual(sp.get('backUrl'), 'https://pay.example.com/pay/notify/unionpay');

  /**
   * 订单号：必须是 `orderNo`，**不是** `order.id`。
   * `order.id` 是 base64url，含 `-` / `_`，银联会判报文格式错误。
   */
  assertEqual(sp.get('orderId'), UP_ORDER.orderNo, '订单号必须用 orderNo（纯字母数字，36 位）');
  assert(!/[-_]/.test(sp.get('orderId')), '银联的 orderId 不能含 - 或 _');

  assertEqual(sp.get('txnTime'), '20261025120000', 'txnTime 由 createdAt 按北京时间确定性推导');
  assertEqual(sp.get('payTimeout'), '20261025123000', 'payTimeout = txnTime + 30 分钟');

  // 签名可被公钥验过（签名口径与银联 SDK 一致：排序列出除 signature 外的非空参数）
  const params = {};
  for (const [k, v] of sp) params[k] = v;
  assert(params.signature, '必须带 signature 字段');
  assertEqual(gateway.unionpayVerify(params, PUB, '01'), true, '自己签的必须能被自己验过');
});

test('R91-07 · 商户订单号不合规时明确拒绝，而不是就地变形', () => {
  // 记录 id（base64url）不是合规的银联订单号
  let msg = '';
  try { gateway.unionpayOrderId({ id: UP_ORDER.id }); } catch (e) { msg = e.message; }
  assert(/8~40/.test(msg), `应说明长度与字符集要求，实际：${msg}`);

  assertEqual(gateway.unionpayOrderId({ orderNo: UP_ORDER.orderNo }), UP_ORDER.orderNo, '合规订单号原样返回');

  /**
   * 畸形的下单请求必须以 `ok:false` 结束 —— `createCharge` 把异常收成错误文案，
   * 页面显示「创建支付订单失败：…」，而不是带着一个必然被拒的请求把用户送出去。
   */
  return gateway.createCharge('unionpay', UP_CFG, { order: { id: UP_ORDER.id, amountFen: 500 } })
    .then((r) => {
      assertEqual(r.ok, false, '缺合规订单号时不得"看似下单成功"');
      assert(/订单号/.test(r.error), `错误文案应指向订单号，实际：${r.error}`);
    });
});

test('R91-08 · 下单前拒绝 SM3 签名方法（本地没有国密实现）', async () => {
  let msg = '';
  try { gateway.unionpaySignMethod('12'); } catch (e) { msg = e.message; }
  assert(/不支持/.test(msg) && /01/.test(msg), `应给出可照做的出路，实际：${msg}`);

  const r = await gateway.createCharge('unionpay', Object.assign({}, UP_CFG, { signMethod: '12' }), {
    order: UP_ORDER,
  });
  assertEqual(r.ok, false, 'SM3 不得进入下单');
  assert(/不支持/.test(r.error), `错误应说明不支持，实际：${r.error}`);
});

/* ================================================================== *
 * R91-09 · 查单：验签在业务字段之前 + 三档状态 + 金额对账
 * ================================================================== */

/** 造一条"银联响应"：params 按银联规则签名后拼成表单串 */
function upResponse(params, signMethod) {
  const signed = Object.assign({}, params);
  signed.signature = signUp(signed, signMethod || '01');
  return formBody(signed);
}

test('R91-09 · 查单响应签名不对 ⇒ 报错；验签在读业务字段之前', async () => {
  const good = upResponse({ respCode: '00', respMsg: '成功', origRespCode: '00', txnAmt: '500', queryId: 'Q1' });
  // 篡改金额但**不重签** —— 业务字段看起来完全合法（origRespCode=00、金额相符）
  const tampered = good.replace('txnAmt=500', 'txnAmt=1');

  const r = await withFetchStub(() => fakeResponse(200, tampered), () =>
    gateway.queryCharge('unionpay', UP_CFG, UP_ORDER));
  assertEqual(r.paid, false, '签名不符时绝不能判成已支付');
  assertEqual(r.state, 'error');
  assert(/签名校验失败/.test(r.failReason), `应指出签名问题，实际：${r.failReason}`);
});

test('R91-10 · 查单三档：已支付 / 未支付 / 金额不符', async () => {
  // ① 已支付（金额相符）
  const paid = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '00', respMsg: '成功', origRespCode: '00', txnAmt: '500', queryId: 'Q2' })),
    () => gateway.queryCharge('unionpay', UP_CFG, UP_ORDER));
  assertEqual(paid.paid, true, 'origRespCode=00 + 金额相符 ⇒ 已支付');
  assertEqual(paid.state, 'paid');
  assertEqual(paid.tradeNo, 'Q2', '查询流水号应被记下');

  // ② 原始交易不存在（用户还没付）⇒ 未支付，不是错误
  const pending = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34', respMsg: '原始交易不存在' })),
    () => gateway.queryCharge('unionpay', UP_CFG, UP_ORDER));
  assertEqual(pending.paid, false);
  assertEqual(pending.state, 'pending', '「还没付」不能报成错误，否则页面上会飘红');

  // ③ 金额不符 ⇒ 中止自动确认（I-5 对账）
  const wrong = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '00', respMsg: '成功', origRespCode: '00', txnAmt: '1' })),
    () => gateway.queryCharge('unionpay', UP_CFG, UP_ORDER));
  assertEqual(wrong.paid, false);
  assertEqual(wrong.state, 'error');
  assert(/不一致/.test(wrong.failReason), `应说明金额不符，实际：${wrong.failReason}`);

  // ④ 查询请求本身用 txnType=00 + 确定性 txnTime（否则银联找不到原始交易）
  const probe = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34' })),
    async (c) => { await gateway.queryCharge('unionpay', UP_CFG, UP_ORDER); return c[0].url; });
  const qs = new URL(probe).searchParams;
  assertEqual(qs.get('txnType'), '00', '查询交易类型');
  assertEqual(qs.get('orderId'), UP_ORDER.orderNo);
  assertEqual(qs.get('txnTime'), '20261025120000', '查询必须回送与下单一致的 txnTime');
});

/* ================================================================== *
 * R91-11 · 关单：unsupported（不谎报 closed）
 * ================================================================== */

test('R91-11 · 云闪付关单：先只读查单 —— 未付才 unsupported，已付必须回 paid', async () => {
  /**
   * R92 改了这条的**判据方向**，因为旧实现有一个真缺陷。
   *
   * 旧版无条件回 `unsupported`（「银联没有关闭未支付订单的接口」是事实），代价是
   * R90 五档里的 `paid` 在云闪付上**永远不可达** —— 而 `paid` 是唯一一个「用户已经
   * 给过钱」的档位，也是调用方唯一会因此**放弃建新单**的档位。于是「旧单其实已经
   * 付掉了」时系统照样建第二笔单 = 双份付款，正是这一轮要消掉的残余风险。
   *
   * 现在的口径：关单前先查一次（只读），答案是
   *  · 未支付 ⇒ `unsupported`（靠 payTimeout 失效）
   *  · 已支付 ⇒ `paid`（绝不建新单）
   *  · 查单本身失败 ⇒ `error`（有疑问就不放行）
   */
  const unpaid = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '34', respMsg: '原始交易不存在' })),
    () => gateway.closeCharge('unionpay', UP_CFG, UP_ORDER),
  );
  assertEqual(unpaid.ok, false, 'unsupported 不得伪装成成功');
  assertEqual(unpaid.state, 'unsupported', 'R90 的「先关后建」靠这一档决定「留痕后继续」');
  assert(/payTimeout|失效/.test(unpaid.error), '必须说清未付订单靠什么失效');

  const paid = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '00', respMsg: '成功', origRespCode: '00', txnAmt: '500', queryId: 'Q9' })),
    () => gateway.closeCharge('unionpay', UP_CFG, UP_ORDER),
  );
  assertEqual(paid.state, 'paid', '旧单已经付掉了 —— 这一档必须能出现，否则会被引导去付第二次');
  assertEqual(paid.ok, false, 'paid 不是「关成功了」，调用方要据此改走交付');

  const broken = await withFetchStub(
    () => fakeResponse(200, upResponse({ respCode: '00', origRespCode: '00', txnAmt: '1', queryId: 'Q8' })),
    () => gateway.closeCharge('unionpay', UP_CFG, UP_ORDER),
  );
  assertEqual(broken.state, 'error', '金额对不上时不能判 paid，也不能判 unsupported（有疑问就不放行）');

  const down = await withFetchStub(
    () => fakeResponse(500, 'boom'),
    () => gateway.closeCharge('unionpay', UP_CFG, UP_ORDER),
  );
  assertEqual(down.state, 'error', '查单没成功时不知道旧单死活 —— 必须 error，不能默默建新单');
});

test('R91-11b · PayPal 关单绝不走会扣款的查单路径', async () => {
  /**
   * `paypalQuery()` 在 `APPROVED` 时会**主动 capture 扣款**。关单若复用它，
   * 「换个支付渠道」就会把旧单的钱收掉 —— 这是抽 `paypalFetchOrder()` 的唯一理由。
   *
   * 判据落在**实际发出去的请求**上：关单只允许有一个 `GET .../orders/{id}`，
   * 绝不能出现 `POST .../capture`。
   */
  const PP_CFG = { clientId: 'cid', clientSecret: 'sec', mode: 'sandbox' };
  const calls = await withFetchStub(
    (url) => {
      if (url.indexOf('/v1/oauth2/token') >= 0) return fakeResponse(200, JSON.stringify({ access_token: 'tok' }));
      if (url.indexOf('/capture') >= 0) return fakeResponse(200, JSON.stringify({ id: 'X', status: 'COMPLETED' }));
      return fakeResponse(200, JSON.stringify({ id: 'ORD-1', status: 'APPROVED' }));
    },
    (c) => gateway.closeCharge('paypal', PP_CFG, { id: 'x', amountFen: 500, tradeNo: 'ORD-1' }).then((r) => ({ r, calls: c })),
  );
  assertEqual(calls.r.state, 'unsupported', 'APPROVED 状态的订单关不掉，如实回 unsupported');
  assert(!calls.calls.some((c) => c.url.indexOf('/capture') >= 0),
    '关单路径**绝不允许**出现 /capture —— 那会把「换个渠道」变成「把钱扣了」');

  // 已经付掉的旧单必须被认出来（否则照样会建第二笔）
  const done = await withFetchStub(
    (url) => {
      if (url.indexOf('/v1/oauth2/token') >= 0) return fakeResponse(200, JSON.stringify({ access_token: 'tok' }));
      return fakeResponse(200, JSON.stringify({
        id: 'ORD-2', status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ amount: { value: '5.00' } }] } }],
      }));
    },
    () => gateway.closeCharge('paypal', PP_CFG, { id: 'x', amountFen: 500, tradeNo: 'ORD-2' }),
  );
  assertEqual(done.state, 'paid', 'PayPal 关不掉单，但「这笔已经付了」是查得到的 —— 必须回 paid');
});

/* ================================================================== *
 * R91-12 · 后台通知：验签不过 403，过了 200
 * ================================================================== */

test('R91-12 · 云闪付后台通知：没签名 403、签名错 403、签名对 200', async () => {
  configStore.savePayment('unionpay', UP_CFG);
  const share = require(SERVER('share-routes.js'));
  const srv = await serve(share);
  try {
    const post = (body) => request(srv.port, 'POST', '/pay/notify/unionpay', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Buffer.from(body),
    });

    const unsigned = await post(formBody({ respCode: '00', orderId: UP_ORDER.orderNo }));
    assertEqual(unsigned.status, 403, '没有 signature 必须被丢弃');

    // 用**另一把**私钥签（模拟伪造者）—— 字段全都合法，只有签名是假的
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forgedParams = { respCode: '00', orderId: UP_ORDER.orderNo, txnAmt: '500' };
    forgedParams.signature = crypto.createSign('RSA-SHA1')
      .update(Object.keys(forgedParams).filter((k) => k !== 'signature').sort()
        .map((k) => `${k}=${forgedParams[k]}`).join('&'), 'utf8')
      .sign(other.privateKey, 'base64');
    const forged = await post(formBody(forgedParams));
    assertEqual(forged.status, 403, '签名不是银联私钥签的，必须被丢弃');

    // 真签名 + 一个查不到的订单号 ⇒ 200（通知只是触发信号，查不到订单不做任何变更）
    const ok = await post(upResponse({ respCode: '00', orderId: 'NOPE000000000', txnAmt: '500' }));
    assertEqual(ok.status, 200, '验签通过的通知必须 200，否则银联会一直重投');
    assertEqual(ok.json && ok.json.code, 'SUCCESS');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * R91-13 · 回调定位：按 orderId（= orderNo）找订单
 * ================================================================== */

test('R91-13 · 通知按 orderId（= orderNo）定位订单，而不是按记录 id', () => {
  const src = readSrc('server/share-routes.js');
  /**
   * ⚠️ R92 修正了这条断言 —— 它上一轮把**错误的口径**固化成了护栏。
   *
   * 旧版断言的是 `paymentOrders.get(no)`（按记录 `id` 精确匹配），而银联回显的
   * `orderId` 是我们送出去的 `order.orderNo`（36 位纯 base62）—— 因为银联只收
   * 8~40 位字母数字、不许含 `-` 与 `_`，而记录主键是 base64url，恰好会含这两个字符。
   * 于是云闪付的异步通知**永远定位不到订单**：验签通过、限流通过、然后静默 404
   * 让银联反复重投，真实付款只能靠页面轮询推进。
   *
   * 护栏写对了形状（「按 orderId 定位」）却写错了实现，比没有护栏更贵：它让后来的人
   * 以为这里被保护着。所以这次把判据落在「用的是哪个函数」上。
   */
  const key = "const no = String(b.orderId || '');";
  const at = src.indexOf(key);
  assert(at > 0, 'resolveNotifiedOrder 必须有云闪付分支');
  const block = src.slice(at, at + 200);
  assert(/paymentOrders\.findByOrderNo\(no\)/.test(block),
    'orderId 就是 orderNo，必须走 findByOrderNo —— 按记录 id 查会恒定查不到');
  assert(!/paymentOrders\.get\(no\)/.test(block),
    '不得再按记录 id 查银联订单（R91 的缺陷：get() 只认 o.id）');

  // 验签分支必须复用网关那一个实现，不得另写一份判据
  const vAt = src.indexOf("if (platform === 'unionpay') {");
  assert(vAt > 0, 'verifyNotified 必须有云闪付分支');
  const vBlock = src.slice(vAt, vAt + 1600);
  assert(/paymentGateway\.unionpayVerify\(b, cfg\.unionpayPublicKey/.test(vBlock),
    '通知验签必须复用 paymentGateway.unionpayVerify —— 两份判据就是两个会漂移的口径');
});
