/**
 * 第九十三轮护栏：**付款二维码就地绘制，不再跳转**
 *
 * ## 需求（用户原话）
 *
 *   ① 微信支付需在订单页面直接绘制付款二维码，不进行跳转；
 *   ② 支付配置里支付宝提供「网站应用」与「当面付」**二选一**，推荐当面付；
 *   ③ 其他渠道保持原样；
 *   ④ 选了能扫码的渠道 ⇒ 在「文件分享」卡片下方（原「立即支付」按钮的位置）
 *      直接画出二维码，并隐藏该按钮；选了不能扫码的渠道 ⇒ 按钮照旧。
 *
 * ## 这条改动的真实难点（也是本轮全部测试的由来）
 *
 *  · **「谁支持扫码」只有一份判定**（`paymentGateway.supportsQr()`）。支付宝要看
 *    后台选的 `mode`，前端抄一份名单必然与后台打架 —— 判据必须是**服务端下发**
 *    的那份投影（单选钮上的 `data-qr`）。
 *  · **码必须落库**（`order.qrPayload`）。旧实现里码只活在一次 POST 的响应里：
 *    F5 会重发 POST（同 `out_trade_no` 二次下单，微信 v3 有 `OUT_TRADE_NO_USED`），
 *    而从分享页回来命中的 `payingPage` 一行码都没有。
 *  · **扫码态的金额必须取订单**，不能取链接标价。用了券两者会分叉，于是页面写
 *    ¥10、扫码进去收 ¥7 —— 金额对不上的收银台是这个项目最不能出现的形态。
 *  · **`mode` 字段不能把老配置打成「未配置」**。`required: true` 会让
 *    `isConfigured()` 在老配置上判 false，`availableChannels()` 把支付宝整个移出
 *    可用渠道 ⇒ **已付费链接当场失效**。
 *
 * ## 判据落点
 *
 *  · R93-01/02/03 落在**真实 HTTP 响应**上（三条渲染路径各一条）；
 *  · R93-04 落在**网关调用次数**上（复用已有的码不该再出网）；
 *  · R93-05 落在**页面上的金额字符串**上（不是读订单对象 —— 那证明不了页面写对了）；
 *  · R93-06/07 落在**渲染出的 HTML 属性**与**前端脚本的行为**上；
 *  · R93-08 落在 `payment-providers` 的纯函数上（兼容性只在这一层能单点驱动）。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r93-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 打桩（与 audit83/84/85 同构：真实路由 + 真实 store，只替换外部依赖）
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
  // alipay 在前 ⇒ 付费页默认选中的是支付宝，便于测「默认渠道是否出码」之外的用例
  available: ['alipay', 'wechat'],
});
/** 金额随链接走（R93-05 要用券把「页面价」与「订单价」拆开） */
paymentRules.resolvePaidState = ({ linkPaid }) => {
  const p = linkPaid || {};
  return {
    required: true, effective: true,
    amountFen: Number(p.amountFen) || 100, currency: 'CNY', reason: '',
  };
};

const paymentProviders = require(SERVER('payment-providers.js'));
paymentProviders.isConfigured = () => true;

const statsStore = require(SERVER('stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const couponStore = require(SERVER('coupon-store.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/**
 * 支付宝的 `mode` 由这个变量驱动 —— 走**包装原函数**而不是整体替换：
 * `getPayment()` 还被站点地址、渠道配置等地方读，整体替换会把它们一起打死。
 */
let ALIPAY_MODE = 'face';
const origGetPayment = configStore.getPayment;
configStore.getPayment = () => {
  const c = origGetPayment();
  const alipay = Object.assign({}, (c.platforms || {}).alipay, { mode: ALIPAY_MODE });
  c.platforms = Object.assign({}, c.platforms, { alipay });
  return c;
};

/** 下单桩：记录调用次数（R93-04 要证明「没有第二次出网」） */
const charges = [];
if (!paymentGateway.__r93wrapped) {
  paymentGateway.createCharge = async (platform, cfg, opts) => {
    charges.push({ platform, orderId: opts.order.id });
    return charges.__next;
  };
  paymentGateway.__r93wrapped = true;
}
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
async function makePaidLink(amountFen) {
  seq += 1;
  return shareStore.create({
    key: 'r93/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: Number(amountFen) || 100, currency: 'CNY' },
  });
}

const lastOrder = () => {
  const all = paymentOrders.listAll() || [];
  return all.length ? all[0] : null;
};

/** 一个「能画码」的渠道桩返回：微信 `code_url` / 当面付 `qr_code` 都长这样 */
const QR_CHARGE = (p) => ({ ok: true, kind: 'qrcode', url: '', codeUrl: p, svg: '<svg></svg>', tradeNo: '' });

/* ================================================================== *
 * ① 三条渲染路径
 * ================================================================== */

test('R93-01 · 微信：下单后**留在本页**画码，既没有跳转，也没有「立即支付」', async () => {
  charges.length = 0;
  const codeUrl = 'weixin://wxpay/bizpayurl?pr=R93wechat';
  charges.__next = QR_CHARGE(codeUrl);
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'wechat', coupon: '' } });

    assertEqual(r.status, 200, `应就地渲染（200），实际 ${r.status}`);
    assert(!r.headers.location, '★不得用 3xx 把用户送走（需求①：不进行跳转）');
    assert(!/http-equiv="refresh"/.test(r.raw), '★不得用 meta refresh 跳转（R83 的同一条禁令）');
    assert(/class="qr-box"/.test(r.raw), '页面必须画出二维码容器');
    assert(/<div class="qr-box"[^>]*>\s*<svg/i.test(r.raw), '二维码容器里必须有内联 SVG');
    assert(r.raw.indexOf('立即支付') < 0, '★已经有码时不该再摆「立即支付」按钮（需求④）');
    assert(/id="pay-state"/.test(r.raw), '扫码页必须带 #pay-state —— 否则 pay-poll 不会轮询，付完不放行');

    const o = lastOrder();
    assertEqual(o.qrPayload, codeUrl, '★二维码内容必须落库，F5 / 回访才有码可重绘');
    assert(o.qrAt, '落库时要记时间（对账要知道这张码是什么时候给的）');
  } finally {
    await srv.close();
  }
});

test('R93-02 · 支付宝当面付（mode=face）同样就地出码', async () => {
  charges.length = 0;
  const qr = 'https://qr.alipay.com/bax093r93face';
  charges.__next = QR_CHARGE(qr);
  ALIPAY_MODE = 'face';
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'alipay', coupon: '' } });

    assertEqual(r.status, 200, `应就地渲染（200），实际 ${r.status}`);
    assert(!r.headers.location, '★当面付不该跳转（那是「网站应用」的形态）');
    assert(/class="qr-box"/.test(r.raw), '当面付必须画出二维码');
    assert(r.raw.indexOf('立即支付') < 0, '★已经有码时不该再摆「立即支付」按钮');
    assertEqual(lastOrder().qrPayload, qr, '二维码内容必须落库');
  } finally {
    await srv.close();
  }
});

test('R93-03 · 支付宝网站应用（mode=page）保持原样：有按钮、走同源中转页、不出码', async () => {
  charges.length = 0;
  charges.__next = { ok: true, kind: 'redirect', url: 'https://openapi.alipay.com/gateway.do?x=1', tradeNo: 'T1' };
  ALIPAY_MODE = 'page';
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'alipay', coupon: '' } });

    assertEqual(r.status, 200, `跳转式中转页应是 200，实际 ${r.status}`);
    assert(/正在跳转到/.test(r.raw), '前置：应命中 R83 的同源中转页');
    assert(!/class="qr-box"/.test(r.raw), '★「网站应用」没有码可画，不得凭空画一个');
    assertEqual(lastOrder().qrPayload, '', '★跳转式渠道不该写 qrPayload（那是扫码态的判断依据）');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ② 复用：已经给过的码不再出网
 * ================================================================== */

test('R93-04 · 二次提交（F5 / 再点一次）复用在途二维码，**不再调网关**', async () => {
  charges.length = 0;
  charges.__next = QR_CHARGE('weixin://wxpay/bizpayurl?pr=reuse');
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const first = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'wechat', coupon: '' } });
    assert(/class="qr-box"/.test(first.raw), '前置：第一次应已画出码');
    const after = charges.length;
    assertEqual(after, 1, '前置：第一次提交应恰好调一次网关下单');

    const second = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'wechat', coupon: '' } });
    assertEqual(charges.length, after,
      '★第二次提交必须复用已经拿到的码，不得再用同一个 out_trade_no 打一次下单接口（微信会回 OUT_TRADE_NO_USED）');
    assert(/class="qr-box"/.test(second.raw), '复用路径同样要把码画出来');
    assert(!second.headers.location, '复用路径也不该跳转');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ③ 扫码态的金额来源
 * ================================================================== */

test('R93-05 · 扫码态的金额取**订单**（页面价与扫码进去要付的钱必须一致）', async () => {
  charges.length = 0;
  charges.__next = QR_CHARGE('weixin://wxpay/bizpayurl?pr=coupon');
  const srv = await serve();
  try {
    const l = await makePaidLink(1200); // 链接标价 ¥12.00
    const cp = couponStore.generate({
      count: 1, type: 'any', linkIds: [], userIds: [], amountFen: 500,
      maxUses: 0, perUserOnce: false, startAt: null, expireAt: null,
      note: 'r93', createdBy: 'tester',
    })[0];

    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay',
      { fields: { platform: 'wechat', coupon: cp.code } });
    assert(/class="qr-box"/.test(r.raw), '前置：应命中扫码页');

    const o = lastOrder();
    assertEqual(o.amountFen, 700, '前置：订单金额应是 ¥12 - ¥5 = ¥7');
    assert(/class="pay-amount">¥7\.00/.test(r.raw),
      '★页面上的大金额必须是**这张订单要收的钱**（¥7.00）—— 写链接标价会出现「页面 ¥12、扫码进去 ¥7」');
    assert(/class="pay-orig">¥12\.00/.test(r.raw), '原价要以划线价的形式保留');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ④ 前端联动：data-qr 是服务端那份判定的投影
 * ================================================================== */

test('R93-06 · 付费页单选钮带 data-qr：扫码渠道=1、跳转渠道=0', async () => {
  ALIPAY_MODE = 'face';
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200, `付费页应是 200，实际 ${r.status}`);
    assert(/value="wechat"[^>]*data-qr="1"/.test(r.raw), '微信恒可扫码 ⇒ data-qr="1"');
    assert(/value="alipay"[^>]*data-qr="1"/.test(r.raw), '支付宝当面付 ⇒ data-qr="1"');
    // 还没下单 ⇒ 没有码，按钮必须在（渐进增强：脚本被拦掉也能付）
    assert(/立即支付/.test(r.raw), '★没拿到码之前必须留着「立即支付」按钮');
  } finally {
    await srv.close();
  }

  ALIPAY_MODE = 'page';
  const srv2 = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv2.port, 'GET', '/s/' + l.id);
    assert(/value="alipay"[^>]*data-qr="0"/.test(r.raw),
      '★支付宝网站应用不能扫码 ⇒ data-qr="0"（否则前端会把用户送进一次白提交）');
  } finally {
    await srv2.close();
  }
});

test('R93-07 · 联动脚本：选中 data-qr="1" 才自动提交，且**加载不提交**', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pay-poll.js'), 'utf8');
  assert(/getAttribute\('data-qr'\) !== '1'/.test(src), '必须按 data-qr 判定，不能在前端另抄一份渠道名单');
  assert(/requestSubmit/.test(src), '要有 requestSubmit —— 它才会派发 submit 事件，让看门狗照常生效');
  assert(/addEventListener\('change'/.test(src), '必须挂在 change 上（用户明确换渠道才提交）');

  /**
   * ⚠️ 反向判据：**首次加载不得自动提交**。加载即提交等于「任何一次页面浏览都建一笔
   * 订单」（爬虫、链接预览都算），既是 R14-03 灌单的复现路径，也会白烧网关配额。
   * 现在这段代码里应当**没有** `requestSubmit` 出现在 `change` 监听之外。
   */
  const body = src.slice(src.indexOf("addEventListener('change'"));
  const all = (src.match(/requestSubmit/g) || []).length;
  const inChange = (body.match(/requestSubmit/g) || []).length;
  assertEqual(all, inChange, '★`requestSubmit` 只应出现在 change 处理器里（加载即提交 = 每次浏览都建单）');
});

/* ================================================================== *
 * ⑤ 渠道层：唯一实现点 + 兼容性
 * ================================================================== */

test('R93-08 · supportsQr 是「谁能扫码」的唯一判定（支付宝要看 mode）', () => {
  const gw = require(SERVER('payment-gateway.js'));
  assertEqual(typeof gw.supportsQr, 'function', '必须导出 supportsQr —— 三处共用同一个判据');

  assertEqual(gw.supportsQr('wechat', {}), true, '微信 Native 恒可扫码');
  assertEqual(gw.supportsQr('wechat', undefined), true, '不传配置也要能判（微信不依赖配置）');
  assertEqual(gw.supportsQr('alipay', { mode: 'face' }), true, '当面付可扫码');
  assertEqual(gw.supportsQr('alipay', { mode: 'page' }), false, '网站应用不可扫码');
  assertEqual(gw.supportsQr('alipay', {}), false, '★缺 mode 时按「不可扫码」保守处理（老配置默认就是 page）');
  assertEqual(gw.supportsQr('unionpay', {}), false, '云闪付是跳转式');
  assertEqual(gw.supportsQr('paypal', {}), false, 'PayPal 是跳转式');
  assertEqual(gw.supportsQr('nope', {}), false, '未知渠道一律 false');

  // 唯一实现点：源码里只能有一处 `function supportsQr`
  const src = fs.readFileSync(SERVER('payment-gateway.js'), 'utf8');
  assertEqual((src.match(/function supportsQr\b/g) || []).length, 1,
    'supportsQr 只许有**一份实现** —— 两份实现就是两套口径');
  // 二维码只许有一个渲染点
  const share = fs.readFileSync(SERVER('share-routes.js'), 'utf8');
  assertEqual((share.match(/function qrBoxHtml\b/g) || []).length, 1,
    'qrBoxHtml 只许有**一份实现**（从内容重绘，不存 SVG）');
  assert(share.indexOf('function qrPayPage') < 0,
    '★独立的扫码页必须在 R93 合并进付费页后消失 —— 两份模板必然一边改一边漏');
});

test('R93-09 · mode 字段不能把老配置打成「未配置」（否则已付费链接当场失效）', () => {
  const pp = require(SERVER('payment-providers.js'));
  const crypto = require('crypto');
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  /** 「升级前就已保存好」的支付宝配置：字段齐全、**唯独没有 mode** */
  const oldCfg = {
    appId: '2021004100000000',
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(),
    alipayPublicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }).trim(),
    signType: 'RSA2',
  };
  assertEqual(oldCfg.mode, undefined, '前置：老配置里确实没有 mode 这个键');

  assertEqual(pp.isConfigured('alipay', oldCfg), true,
    '★老配置（无 mode）必须仍算「配置完整」—— 判 false 会让 availableChannels() 把支付宝整个移出，付费链接当场失效');
  assertEqual(pp.validate('alipay', oldCfg).ok, true, '老配置必须仍能通过校验');

  const saved = pp.applySave('alipay', oldCfg, {});
  assertEqual(saved.mode, 'page', '★首次保存要落盘默认值 page（否则这个键永远不存在）');

  const face = pp.applySave('alipay', oldCfg, { mode: 'face' });
  assertEqual(face.mode, 'face', '明确选了 face 就要记 face');

  const view = pp.publicView('alipay', oldCfg);
  assertEqual(view.values.mode, 'page',
    '★界面回显要回填默认值 —— 不回填的话 <select> 一个都不命中 selected，下拉框是空白的');

  const bad = pp.validate('alipay', Object.assign({}, oldCfg, { mode: 'nope' }));
  assertEqual(bad.ok, false, '非法的 mode 必须拒绝');
  const badMsg = (bad.errors || []).filter((e) => e.field === 'mode').map((e) => e.message).join(' ');
  assertEqual(Boolean(badMsg), true, '错误必须定位到 mode 字段');
  assert(/face/.test(badMsg) && /page/.test(badMsg), '报错信息要告诉用户合法取值（face / page）');
});

test('R93-10 · 二维码内容过长时如实报错（本地编码器超限是**静默返回空串**）', async () => {
  charges.length = 0;
  // 实测边界：`qrcode.toSvg()` 在 213 字节以上返回空串且不抛错
  charges.__next = QR_CHARGE('x'.repeat(300));
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await call(srv.port, 'POST', '/s/' + l.id + '/pay', { fields: { platform: 'wechat', coupon: '' } });
    assertEqual(r.status, 200, `应正常渲染页面（不是 500），实际 ${r.status}`);
    assert(/qr-box--empty/.test(r.raw), '★生成不出来时必须给出说明块，不能留一块漂亮的空边框');
    assert(/内容过长/.test(r.raw), '要说明具体原因（用户才知道该换渠道）');
    assert(/重新发起支付/.test(r.raw), '并给出可执行的出路');
    assert(r.raw.indexOf('立即支付') < 0,
      '★此时也不能摆「立即支付」按钮 —— 按下去只会拿到同一个超长码');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * 收尾
 * ================================================================== */
test('R93-99 · 收尾：还原 getPayment 包装', () => {
  configStore.getPayment = origGetPayment;
  assertEqual(typeof configStore.getPayment, 'function', 'getPayment 已还原');
});
