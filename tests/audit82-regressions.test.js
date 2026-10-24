/**
 * 第八十二轮护栏：三条**用户明确要求的行为变更**
 *
 * ## 用户原话
 *
 *   「1、更换渠道即建立新的订单；
 *     2、SM2在保存时即拒绝；
 *     3、历史在途订单全部标为失败。」
 *
 * 三条都属「改一条既有约定」，因此每条都必须回答两个问题：
 * **新行为是什么**，以及**旧约定是怎么被推翻的、有没有留下别的坑**。
 *
 * ## ① 换渠道即新单（推翻 R21-06 的复用语义）
 *
 * 旧实现只要「该浏览器在这个链接上有一笔在途订单」就复用它，**不看渠道** ——
 * 用户在付费页点的是支付宝，却因为上一次点过微信而拿到微信二维码。
 * R21-06 当年为此写的护栏（「复用时 notifyUrl 必须指向订单原渠道」）是对的，
 * 但它只守住了回调地址的自洽，把**用户的选择**牺牲掉了。
 *
 * 现在复用多一个前提：`order.platform === platform`。换渠道 ⇒ 另建新单 +
 * **把被放弃的那笔收尾**（标失败 + 退券）。
 *
 * ⚠️ 退券不是可选项：`validateForUse()` 对 `perUserOnce` 的券读 `c.identities`
 * 判「是否用过」，而核销是下单时 `couponStore.consume()` 记的。不先
 * `releaseByOrder()`，同一张「每人一次」的券在新单上会被判 `already_used` ——
 * 用户换个支付方式就直接卡在「优惠券不可用」，**钱反而付不出去**。
 * 这是本轮最容易漏的一处，所以 R82-02 专门盯它。
 *
 * ## ② SM2 保存时即拒绝（推翻「保存能过、下单被拒」的分工）
 *
 * 旧契约是刻意的：`payment.test.js` 明确断言 `signType=SM2` 应通过保存校验，
 * 由 `alipaySignType()` 在下单前拒绝。理由是「保存层只做格式校验」。
 * 但用户实际撞到的是：填完整页凭证、保存显示成功，某天点「立即支付」才被告知
 * 不支持 —— 错误被推到了最不该出现的地方。
 *
 * 现在 `options` 里的 `disabled: true` 是唯一标记：`validate()`（服务端保存的唯一入口）
 * 与前端 `<option disabled>` 都读它，两层不可能再分叉。
 *
 * ## ③ 历史在途订单标为失败（一次性迁移）
 *
 * R81 修掉了「网关回了响应头却不吐响应体时请求挂到 300 秒」的缺陷，但此前积下的
 * pending 订单不会自己消失：管理页一直显示「支付中」，`payerState()` 还会把同一个
 * 浏览器当成「有在途订单」。清理必须是**一次性的**（标记落盘），否则每次重启都会
 * 误杀当时真正在途的订单 —— R82-06 的第二段专门盯这一点。
 *
 * ## 判据落点
 *
 *  · ①② 落在**真实 HTTP 响应 + 真实 store 状态**上（下了一次单？下了几笔？旧单什么状态？
 *    券的 `used` 是 1 还是 2？），不给 `payerState` 打桩 —— 打桩就看不到"旧单有没有被收尾"；
 *  · ②的保存侧落在**真实保存端点**（`PUT /api/payment/config/alipay`）的返回体上，
 *    那才是管理员真正会撞到的那一层；
 *  · ③落在**真实 store** 上，并用子进程验「读不出文件时不许落标记」（见 R82-07）。
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
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r82-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();

/* ---------------------------------------------------------------- *
 * 打桩
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
// 两条渠道都可用：R82 的「换渠道」必须有第二条渠道可选
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
const logs = [];
statsStore.addLog = (r) => { logs.push(r); };
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const couponStore = require(SERVER('coupon-store.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/** 下单桩：记录每次下单的渠道 / 回调地址 / 订单号，并让路由走到 302 */
const captured = [];
const origCharge = paymentGateway.createCharge;
paymentGateway.createCharge = async (platform, cfg, opts) => {
  captured.push({ platform, notifyUrl: opts.notifyUrl, orderId: opts.order.id });
  return { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
};

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

/** 表单形态的 POST（浏览器点「立即支付」就是这个样子） */
function postForm(port, urlPath, fields, headers) {
  const body = Object.keys(fields || {})
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: Object.assign({
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }, headers || {}),
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
async function makePaidLink(extra) {
  seq += 1;
  return shareStore.create(Object.assign({
    key: 'r82/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
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

/* ================================================================== *
 * ① 换渠道即新单
 * ================================================================== */

test('R82-01 · 换渠道必须另建新单、并按新渠道下单；被放弃的在途订单要收尾', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const old = newOrder(l, 'alipay');
    const before = captured.length;

    const r = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'wechat' }, { cookie: cookieOf(l, old) });
    assertEqual(r.status, 302, `下单成功应 302 跳收银台，实际 ${r.status}：${r.raw.slice(0, 160)}`);

    const hit = captured.slice(before);
    assertEqual(hit.length, 1, `应发起一次下单，实际 ${hit.length}`);
    assertEqual(hit[0].platform, 'wechat', 'R82：必须按**用户这次选的**渠道下单');
    assert(/\/pay\/notify\/wechat$/.test(hit[0].notifyUrl),
      `R21-06 仍成立：回调地址必须与实际下单渠道同源，实际 ${hit[0].notifyUrl}`);
    assert(hit[0].orderId !== old.id, 'R82：换渠道必须另建新单（旧行为是复用原单）');
    assertEqual(paymentOrders.get(old.id).status, 'failed',
      '被放弃的在途订单必须收尾为失败，否则管理页永远显示「支付中」');
    assert(/更换支付方式/.test(paymentOrders.get(old.id).failReason),
      `失败原因要说清是被替换的，实际：${paymentOrders.get(old.id).failReason}`);
    assert(logs.some((x) => /更换支付渠道/.test(String(x.detail))),
      '换渠道这件事必须留一条审计日志（谁在什么时候把 alipay 换成了 wechat）');
  } finally {
    await srv.close();
  }
});

test('R82-02 · 换渠道时「每人一次」的优惠券不得变成死结（旧单要退券、新单能重新用）', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const coupon = couponStore.generate({
      count: 1, type: 'links', linkIds: [l.id], amountFen: 50, perUserOnce: true,
    })[0];

    // 第一次：按支付宝下单，券被核销
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay', coupon: coupon.code });
    assertEqual(r1.status, 302, `第一次下单应 302，实际 ${r1.status}：${r1.raw.slice(0, 160)}`);
    const first = paymentOrders.get(captured[captured.length - 1].orderId);
    assertEqual(first.amountFen, 50, `用券后应付 50 分，实际 ${first.amountFen}`);
    assertEqual(first.couponId, coupon.id, '订单要快照券 id');

    // 第二次：换微信重下（页面上的 hidden coupon 还在）—— 券必须先被释放再重新核销
    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', {
      platform: 'wechat', coupon: coupon.code,
    }, { cookie: cookieOf(l, first) });
    assertEqual(r2.status, 302,
      `换渠道后必须能继续付款，实际 ${r2.status}：${r2.raw.slice(0, 200)}`
      + '（旧单不退券 ⇒ 同一张「每人一次」的券被判 already_used ⇒ 页面卡在优惠券不可用）');
    assert(!/优惠券不可用|coupon/.test(r2.raw), '不得把用户挡在「优惠券不可用」上');

    const second = paymentOrders.get(captured[captured.length - 1].orderId);
    assertEqual(second.platform, 'wechat', '新单必须是新渠道');
    assertEqual(second.amountFen, 50, `新单仍应享受同一张券，实际 ${second.amountFen}`);
    assertEqual(second.couponId, coupon.id, '新单要接着快照同一张券');
    assertEqual(couponStore.get(coupon.id).used, 1,
      '★账面净额必须是 1：旧单退券 −1、新单核销 +1（不是 2，也不是 0）');
    assertEqual(paymentOrders.get(first.id).status, 'failed', '旧单必须收尾为失败');
  } finally {
    await srv.close();
  }
});

test('R82-03 · 同一渠道再点一次必须复用同一笔订单（网关侧 out_trade_no 幂等）', async () => {
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const before = captured.length;
    const r1 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' });
    assertEqual(r1.status, 302, `第一次应 302，实际 ${r1.status}`);
    const firstId = captured[captured.length - 1].orderId;
    const first = paymentOrders.get(firstId);

    const r2 = await postForm(srv.port, '/s/' + l.id + '/pay', { platform: 'alipay' }, { cookie: cookieOf(l, first) });
    assertEqual(r2.status, 302, `第二次应 302，实际 ${r2.status}`);

    const hit = captured.slice(before);
    assertEqual(hit.length, 2, '两次点击都应走到下单（网关侧按 out_trade_no 幂等）');
    assertEqual(hit[1].orderId, firstId,
      '★同渠道必须复用原订单：另建新单会让网关侧多出一笔商户单号，用户可能付两次');
    assertEqual(paymentOrders.listForLink(l.id).length, 1,
      `同渠道重试不得产生第二笔订单，实际 ${paymentOrders.listForLink(l.id).length} 笔`);
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ② SM2 在保存时即拒绝
 * ================================================================== */

/** 起一个只挂支付设置路由的服务（与管理员实际保存走同一条路） */
async function withPaymentServer(fn) {
  const { statsStore: ctxStats } = require(path.join(ROOT, 'server', 'routes', '_context.js'));
  const origLog = ctxStats.addLog;
  ctxStats.addLog = () => {};
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((req, _res, next) => { req.authUser = { username: 'tester', role: 'admin' }; next(); });
  app.use('/api', require(path.join(ROOT, 'server', 'routes', 'payment.js')));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    return await fn(s.address().port);
  } finally {
    ctxStats.addLog = origLog;
    await new Promise((r) => s.close(r));
  }
}

const ALIPAY_OK = {
  appId: '2021004100000000', privateKey: PKCS8_PEM, alipayPublicKey: SPKI_PEM, signType: 'RSA2',
};

test('R82-04 · signType=SM2 必须在**保存**这一刻被拒绝，且错误定位到字段并给出出路', async () => {
  await withPaymentServer(async (port) => {
    const put = (body) => request(port, 'PUT', '/api/payment/config/alipay', { body });

    // 对照组：RSA2 必须能保存（别把整条签名算法一起挡掉）
    const good = await put(ALIPAY_OK);
    assertEqual(good.status, 200, `RSA2 应保存成功，实际 ${good.status}：${good.raw.slice(0, 200)}`);

    for (const st of ['SM2', 'RSA']) {
      const r = await put(Object.assign({}, ALIPAY_OK, { signType: st }));
      if (st === 'SM2') {
        assertEqual(r.status, 400,
          `★SM2 必须在保存时被拒（400），实际 ${r.status}：${r.raw.slice(0, 200)}`);
        const err = (r.json && r.json.errors || []).find((e) => e.field === 'signType');
        assert(err, `错误必须定位到 signType 字段，实际：${r.raw.slice(0, 240)}`);
        assert(/不支持|无法/.test(err.message), `提示要说明"不支持这个值"，实际："${err.message}"`);
        assert(/RSA2/.test(err.message), `提示必须给出可照做的出路，实际："${err.message}"`);
      } else {
        assertEqual(r.status, 200, `RSA 仍应能保存，实际 ${r.status}`);
      }
    }
  });
});

test('R82-05 · 「不可选」必须由**同一个标记**驱动服务端与前端（两边不可能分叉）', () => {
  // ① 服务端下发的 schema 里，SM2 必须带 disabled + 原因
  const alipay = paymentProviders.clientSchema().find((p) => p.id === 'alipay');
  const signField = alipay.fields.find((f) => f.key === 'signType');
  const sm2 = signField.options.find((o) => o.value === 'SM2');
  assert(sm2, 'SM2 仍应列在选项里（直接删掉会让用户不知道自己的 SM2 为什么"不见了"）');
  assertEqual(sm2.disabled, true, 'SM2 选项必须标记 disabled，前端才知道要置灰');
  assert(/不支持|无法/.test(String(sm2.disabledReason || '')),
    '原因要随 schema 一起下发（标签上直接可见）');

  // ② 前端渲染必须读这个标记，否则用户仍能选中一个保存必失败的值
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'paysettings.js'), 'utf8');
  assert(/o\.disabled \? ' disabled' : ''/.test(js),
    'paysettings.js 必须把 options[].disabled 渲染成 <option disabled>');
  assert(/o\.value === value && !o\.disabled \? ' selected' : ''/.test(js),
    'disabled 的选项不得被渲染成"已选中"（否则页面看起来像是存着 SM2）');
});

/* ================================================================== *
 * ③ 历史在途订单一次性标为失败
 * ================================================================== */

test('R82-06 · 历史 pending 一次性标失败：不动已支付/已退款，且**只跑一次**', async () => {
  const a = newOrderByRaw();
  const b = newOrderByRaw();
  const paid = newOrderByRaw();
  paymentOrders.markPaid(paid.id);
  const refunded = newOrderByRaw();
  paymentOrders.markPaid(refunded.id);
  paymentOrders.markRefunded(refunded.id);

  const r = paymentOrders.sweepStalePending('测试用原因');
  assert(r.swept >= 2, `至少应清掉本次造的两笔在途订单，实际 swept=${r.swept}`);
  assertEqual(paymentOrders.get(a.id).status, 'failed', '在途订单必须标为失败');
  assertEqual(paymentOrders.get(b.id).status, 'failed', '在途订单必须标为失败');
  assert(/测试用原因/.test(paymentOrders.get(a.id).failReason),
    '原因必须写进订单（管理员要能看懂这笔为什么变成失败）');
  assertEqual(paymentOrders.get(paid.id).status, 'paid', '已支付订单不得被改判失败');
  assertEqual(paymentOrders.get(refunded.id).status, 'refunded', '已退款订单不得被改判失败');

  // 只跑一次：新造一笔在途订单再扫，必须一动不动
  const later = newOrderByRaw();
  const r2 = paymentOrders.sweepStalePending();
  assertEqual(r2.swept, 0, `第二次不得再清任何订单，实际 ${r2.swept}`);
  assertEqual(r2.already, true, '第二次应如实回答"已经清理过"');
  assertEqual(paymentOrders.get(later.id).status, 'pending',
    '★第二次调用不得误杀升级后**真正在途**的订单（标记若写成版本号，每次升级都会杀一批）');

  // 标记必须落盘：否则每次重启都会重新扫一遍
  // ⚠️ `flush()` 是**异步**落盘（coalesce 的 writeNow 走 writeJsonAsync），
  //    刷完立刻读会读到上一版 —— 必须等它真的写完。
  paymentOrders.flush();
  const file = path.join(tmp.dir, 'payments.json');
  const secureStore = require(SERVER('secure-store.js'));
  const deadline = Date.now() + 3000;
  let db = null;
  while (Date.now() < deadline) {
    db = secureStore.readJson(file, null);
    if (db && db.staleSwept === 'R82') break;
    // 让出事件循环，等异步写完成
    await new Promise((r) => setTimeout(r, 20));
    paymentOrders.flush();
  }
  assertEqual(db && db.staleSwept, 'R82', '清理标记必须落在 payments.json 顶层，且值是固定标签');
});

/** 直接造一笔在途订单（不带链接，R82-06 只关心状态机） */
function newOrderByRaw() {
  const o = paymentOrders.create({
    linkId: 'L-sweep', platform: 'alipay', amountFen: 100, currency: 'CNY',
    fileName: 'x.txt', fileKey: 'x.txt', bucket: 'b', payerIp: '127.0.0.1',
  });
  return paymentOrders.get(o.id);
}

test('R82-07 · 订单文件读不出来时不得落下「已扫过」标记（否则修好后这批永远清不掉）', () => {
  const bad = makeTempDir('r82-bad-');
  const file = path.join(bad.dir, 'payments.json');
  fs.writeFileSync(file, 'this-is-not-json');

  const script = `
    process.env.S3_DATA_DIR = ${JSON.stringify(bad.dir)};
    const po = require(${JSON.stringify(SERVER('payment-orders'))});
    process.stdout.write(JSON.stringify(po.sweepStalePending()));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const r = JSON.parse(out);
  assertEqual(r.skipped, true, '读不出订单文件时必须整体跳过');
  assertEqual(r.swept, 0, '读不出时不该"清掉 0 笔还写标记"');
  assertEqual(fs.readFileSync(file, 'utf8'), 'this-is-not-json',
    '★不得覆盖损坏的订单文件（那可能是还能人工抢救的唯一副本）');
});

test('R82-08 · 清理必须挂在**服务启动**路径上，且在 listen 之前', () => {
  const src = fs.readFileSync(SERVER('index.js'), 'utf8');
  const call = src.indexOf('paymentOrders.sweepStalePending()');
  const listen = src.indexOf('httpServer.listen(');
  assert(call > 0, 'index.js 必须调用 sweepStalePending()（否则升级后没人执行它）');
  assert(listen > 0, '前提：index.js 里应有 httpServer.listen(');
  assert(call < listen, '★必须在 listen **之前**：先清干净再对外服务，第一个访客看到的就不是脏状态');
});

/* 收尾：把下单桩还原，避免影响同进程内后加载的模块（Node 的 require 缓存会共享） */
test('R82-99 · 收尾：还原下单桩', () => {
  paymentGateway.createCharge = origCharge;
  assert(true, 'ok');
});
