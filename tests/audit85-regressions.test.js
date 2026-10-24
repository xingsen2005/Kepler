/**
 * 第八十五轮护栏：**两个订单号必须在界面上并列可见**
 *
 * ## 用户报告
 *
 *   「现在已经可以正常打开支付宝支付页面，但支付宝支付页面显示的订单号与实际订单号
 *     不符 —— 之前修改过一次订单号系统（改成了更长的），现在支付宝支付页面显示的
 *     订单号还是以前的那个短的。」
 *
 * ## 判定：不是残留，是设计；但**可见性**确实缺了
 *
 * 下单时传给网关的商户单号（`out_trade_no`）一直是**内部 `id`（16 位 base64url）**，
 * 从来不是 36 位的 `orderNo`：
 *
 *  · `payment-gateway.js` 三处都是 `out_trade_no: order.id`；
 *  · 原因写在 `payment-orders.js` 头部：微信支付 v3 的 `out_trade_no` **最长 32 位**，
 *    而需求要求订单号 36 位 —— 把长号塞进去，微信渠道会整条不可用，且通知里的
 *    `out_trade_no` 再也无法精确定位订单。两个标识各司其职：网关只认短的，用户只认长的。
 *
 * 所以用户在支付宝收银台上看到的短号是**当前每一笔订单都一样的**正常现象，不是旧系统残留。
 *
 * 真正的缺陷在另一半：**那个短号界面上任何地方都看不到**（订单管理页只显示 36 位
 * `orderNo`）⇒ 管理员拿大号去支付宝/微信/PayPal 商家后台检索永远搜不到，对账时
 * 「钱到了但对不上是哪一笔」。买家来问「我在支付宝看到的是 xxxx」也无从核对。
 *
 * ## 本轮改法（支付链路一行未动）
 *
 *  · 分享侧 `orderNoBox(order)`：大号（36 位）+ 一行小字「收银台上的『商户订单号』
 *    显示为 xxxx」，两号不同才提示（历史订单两值相等，多写一句只会让人困惑）；
 *  · 订单管理页新增「商户单号」列（`gatewayNoCell()`，带复制按钮 —— 这一列的唯一
 *    用途就是粘到商家后台的搜索框里）；
 *  · 卡片说明与文档同步口径。
 *
 * ## 判据落点
 *
 *  · R85-01/02/03 落在**真实 HTTP 响应**上：跳转型 / 二维码型 / 等待页三条渲染路径
 *    都必须同时出现两个号，且短号**等于下单桩收到的 `order.id`** —— 这条把「页面上
 *    写的短号」与「真正发给网关的商户单号」钉成同一个值，是本轮全部改动的根；
 *  · R85-03 另加源码**计数**断言：4 个渲染点都必须把**订单对象**传进去
 *    （传字符串就会丢掉短号），只改一处不算修好；
 *  · R85-04 落在前端纯函数上（表格是 `render()` 里拼的字符串，只有纯函数能单点驱动）。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r85-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 打桩（与 audit83/84 同构：真实路由 + 真实 store，只替换外部依赖）
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

const paymentRules = require(SERVER('payment-rules.js'));
paymentRules.snapshot = () => ({
  enabled: true,
  states: { alipay: true, wechat: true },
  configuredMap: { alipay: true, wechat: true },
  available: ['alipay', 'wechat'],
});
paymentRules.resolvePaidState = () => ({
  required: true, effective: true, amountFen: 100, currency: 'CNY', reason: '',
});

const paymentProviders = require(SERVER('payment-providers.js'));
paymentProviders.isConfigured = () => true;

const statsStore = require(SERVER('stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/** 下单桩：记录「真正发给网关的商户单号」—— 页面上的短号必须与它相等 */
const charges = [];
if (!paymentGateway.__r85wrapped) {
  paymentGateway.createCharge = async (platform, cfg, opts) => {
    charges.push({ platform, orderId: opts.order.id, orderNo: opts.order.orderNo });
    return charges.__next;
  };
  paymentGateway.__r85wrapped = true;
}
const origQuery = paymentGateway.queryCharge;
paymentGateway.queryCharge = async (platform, cfg, order) => ({
  paid: false, state: 'pending', tradeNo: order.tradeNo || '', failReason: '',
});

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
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let seq = 0;
async function makePaidLink() {
  seq += 1;
  return shareStore.create({
    key: 'r85/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 100, currency: 'CNY' },
  });
}

const lastOrder = () => {
  const all = paymentOrders.listAll() || [];
  return all.length ? all[0] : null;
};
const cookieOf = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

/**
 * 三条渲染路径共用的断言：**两个号都要在页面上，且短号就是发给网关的那个**。
 *
 * @param {string} raw 响应体
 * @param {object} gateways `{ id, orderNo }`（从下单桩里读回来）
 */
function assertBothNumbers(raw, gateways, where) {
  assert(gateways.id, where + '：下单桩必须记录到商户单号');
  assert(gateways.orderNo, where + '：下单桩必须记录到用户订单号');
  assert(gateways.id !== gateways.orderNo,
    '前置：两个号必须真的不同（否则这条断言区分不出"显示对了"与"两个都显示同一个"）');

  // 大号：用户订单号（36 位）
  assert(raw.indexOf(gateways.orderNo) >= 0,
    `${where}：页面上必须能看到 36 位订单号 ${gateways.orderNo}`);
  // 短号：网关商户单号（16 位）
  assert(raw.indexOf(gateways.id) >= 0,
    `★${where}：页面上必须能看到**收银台显示的那个商户单号** ${gateways.id}`
    + `（看不到 ⇒ 买家说"支付宝上是 xxxx"时无法核对，管理员也无法在商家后台检索）`);
  // 而且要**说清它是什么**，不能只是把一串字符丢在角落
  assert(/商户订单号/.test(raw),
    `${where}：短号必须带「商户订单号」这个说法，否则没人知道它是干什么的`);
  // 整页只出现一次 —— 与 R83 的「支付方式出现两行」同款：不报错、只是变丑的静默回归
  assertEqual((raw.match(/商户订单号/g) || []).length, 1,
    `${where}：「商户订单号」这一段只应出现一次`);
}

/* ================================================================== *
 * ① 跳转型（支付宝 / PayPal）的中转页
 * ================================================================== */
test('R85-01 · 跳转页必须并列显示「订单号（36 位）」与「商户单号（16 位）」', async () => {
  charges.length = 0;
  charges.__next = { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'alipay', coupon: '' } });
    assertEqual(r.status, 200, `应是同源中转页，实际 ${r.status}`);
    assert(/正在跳转到/.test(r.raw), '前置：应命中中转页');

    const o = lastOrder();
    assertBothNumbers(r.raw, { id: o.id, orderNo: o.orderNo }, '中转页');
    // 页面上的短号必须等于**真的发给网关**的那个
    assertEqual(charges[charges.length - 1].orderId, o.id,
      '★页面上的「商户单号」必须就是传给网关的 out_trade_no（同一个值，不是另算一个）');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ② 二维码型（微信 Native）的扫码页
 * ================================================================== */
test('R85-02 · 二维码页同样要并列显示两个号（不能让微信渠道掉队）', async () => {
  charges.length = 0;
  charges.__next = { ok: true, kind: 'qrcode', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', codeUrl: 'weixin://wxpay/x' };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'wechat', coupon: '' } });
    assertEqual(r.status, 200, `应是二维码页，实际 ${r.status}`);
    assert(/<svg/.test(r.raw), '前置：应命中二维码页');

    const o = lastOrder();
    assertBothNumbers(r.raw, { id: o.id, orderNo: o.orderNo }, '二维码页');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ③ 买家最常盯着看的「支付中」等待页
 * ================================================================== */
test('R85-03 · 等待页也要并列显示；且 4 个渲染点都必须传**订单对象**（传字符串就丢短号）', async () => {
  charges.length = 0;
  charges.__next = { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'alipay', coupon: '' } });
    const o = lastOrder();

    // 带票据再访问分享页 ⇒ 命中「支付中」等待页
    const r = await call(srv.port, 'GET', '/s/' + l.id, { headers: { cookie: cookieOf(l, o) } });
    assertEqual(r.status, 200, `等待页应是 200，实际 ${r.status}`);
    assert(/支付中|等待支付/.test(r.raw), '前置：应命中支付中等待页');
    assertBothNumbers(r.raw, { id: o.id, orderNo: o.orderNo }, '等待页');
  } finally {
    await srv.close();
  }

  /**
   * 计数断言：4 处渲染（中转页 / 等待页 / 二维码页 / 状态页）都必须传**订单对象**。
   *
   * 这是「只改一处」的护栏 —— 传字符串（`orderNo || id`）时短号就没了，而**页面
   * 看起来完全正常**（大号还在），只有点开支付宝才会发现对不上。
   */
  const src = fs.readFileSync(SERVER('share-routes.js'), 'utf8');
  // ⚠️ 不能只数 `orderNoBox(order)` —— 函数**定义**那一行也长这样（本轮实际踩到：
  // 期望 3、实际 4）。用模板插值的完整形态 `${orderNoBox(order)}` 才是调用点。
  assertEqual((src.match(/\$\{orderNoBox\(order\)\}/g) || []).length, 3,
    '应有 3 处 `orderNoBox(order)` 调用（等待页 / 二维码页 / 中转页）');
  // 状态页的两处调用都嵌在三目里（`${opts.order ? orderNoBox(opts.order) + … : ''}`），
  // 所以不能匹配 `${orderNoBox(...)}` 那种完整插值形态；而 `orderNoBox(opts.order)`
  // 这个片段**不可能**被函数定义（`function orderNoBox(order)`）满足，直接数它就够。
  assertEqual((src.match(/orderNoBox\(opts\.order\)/g) || []).length, 2,
    '应有 2 处 `orderNoBox(opts.order)` 调用（状态页两条分支）');
  assert(!/orderNoBox\(\s*\w[\w.]*\.orderNo/.test(src),
    '★不得再出现 `orderNoBox(xx.orderNo || xx.id)` 这种传字符串的写法 —— 那样短号必然丢失');
});

/* ================================================================== *
 * ④ 订单管理页的「商户单号」列
 * ================================================================== */
test('R85-04 · 管理页的商户单号单元格：给的是 id（不是长号）+ 可复制', async () => {
  const dir = makeTempDir('r85-fe-');
  const jsDir = path.join(dir.dir, 'js');
  fs.mkdirSync(jsDir);
  fs.copyFileSync(path.join(ROOT, 'public', 'js', 'ordermgr.js'), path.join(jsDir, 'ordermgr.js'));
  fs.writeFileSync(path.join(jsDir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(jsDir, 'util.js'),
    'export const toast=()=>{};export const confirmDialog=()=>true;export const openModal=()=>{};'
    + 'export const escapeHtml=(s)=>String(s==null?"":s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));'
    + 'export const fmtTime=(s)=>String(s||"");export const fmtAmount=()=>"";export const copyText=()=>{};');
  fs.writeFileSync(path.join(jsDir, 'api.js'),
    'export const API={paymentOrders:()=>Promise.resolve({orders:[],degraded:false})};');

  const mod = await import('file://' + path.join(jsDir, 'ordermgr.js').replace(/\\/g, '/'));
  const row = { id: 'AbCdEfGh12345678', orderNo: '1750000000000linkUser12345abcde' };

  const html = mod.gatewayNoCell(row);
  assert(html.indexOf(row.id) >= 0, '单元格必须显示商户单号（内部 id）');
  assert(html.indexOf(row.orderNo) < 0,
    '★不得显示 36 位订单号 —— 那一列已经有了，两列显示同一个号等于没加这一列');
  assert(/data-act="copy-gw"/.test(html), '必须带复制按钮（这一列的唯一用途就是粘到商家后台的搜索框）');
  assert(/out_trade_no/.test(html), 'title 里要说明它是 out_trade_no，否则没人知道去哪用它');

  assertEqual(mod.gatewayNoCell(null), '<span class="ord-dash">—</span>', '没有订单时给占位符，不要报错');
  assertEqual(mod.gatewayNoCell({}), '<span class="ord-dash">—</span>', '缺 id 时同样给占位符');
  // 转义：id 是 base64url，正常不会有尖括号，但拼接进 HTML 时仍必须走 escapeHtml
  assert(mod.gatewayNoCell({ id: 'a<b>' }).indexOf('<b>') < 0, 'id 进 HTML 前必须转义');

  /**
   * 源码结构断言：纯函数再对，**没接到表格上**也白搭。
   *
   * 这是最容易漏的一层 —— `gatewayNoCell()` 单测全绿，而 `render()` 里的表头 /
   * 单元格 / 点击分支任意一处没写，界面就少一列或点了没反应，纯函数断言毫无察觉。
   */
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ordermgr.js'), 'utf8');
  assertEqual((src.match(/<th[^>]*>商户单号<\/th>/g) || []).length, 1,
    '表头必须有一列「商户单号」');
  assertEqual((src.match(/\$\{gatewayNoCell\(o\)\}/g) || []).length, 1,
    '表格行里必须渲染 `gatewayNoCell(o)` 单元格');
  assert(/btn\.dataset\.act === 'copy-gw'\)\s*copyGatewayNo\(o\)/.test(src),
    '复制按钮必须接上 `copyGatewayNo(o)`，否则点了没反应');
});

/* ================================================================== *
 * 收尾
 * ================================================================== */
test('R85-99 · 收尾：还原查单桩', () => {
  paymentGateway.queryCharge = origQuery;
  assert(true);
});
