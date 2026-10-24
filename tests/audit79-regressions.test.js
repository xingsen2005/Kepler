/**
 * 第七十九轮护栏：支付密钥的**真实结构判定** + 等待支付页「点了没反应」
 *
 * ## 两个缺陷（用户报告）
 *
 * **① `创建支付订单失败：error:1E08010C:DECODER routines::unsupported`**
 *
 *   支付宝给的应用私钥是 **PKCS#1**，而 `MIIE` 这个前缀**分不出 PKCS#1 与 PKCS#8**
 *   （PKCS#8 是 `MIIE…IBADANBgkq`，PKCS#1 是 `MIIE…IBAAKCgQEA`）。旧实现按前缀猜结构、
 *   一律补 `-----BEGIN PRIVATE KEY-----`（PKCS#8 头），PKCS#1 体被套错头 ⇒ OpenSSL 在
 *   **解码阶段**就失败，请求根本没出网。同时保存侧的校验器「只看头尾标记 / 只看字符集与
 *   长度」，四类真实错填（公钥贴进私钥框、`'A'×240`、带口令私钥、截断的 PEM）全部放行
 *   并落盘 —— 缺陷要到签名那一刻才暴露。
 *
 *   L1 = `payment-gateway.js` 的归一化改为**先解析再归一化**（解不出来不臆断）；
 *   L2 = `payment-providers.js` 的保存校验器改为**真的解析**并要求 RSA。
 *   两者共用 `server/pem-key.js`（ADR-0006：共用判据必须住在能被共用的地方）。
 *
 * **② 「我已完成支付，立即查询」点了没有任何反应**
 *
 *   按钮 → `POST /s/:id/pay/check` → 命中「同一订单 3 秒一次」节流 ⇒ 一个网关请求都
 *   没发 → 无条件 303 回 `/s/:id` → 那里 `pending` 又渲染**同一个等待页** ⇒ 页面
 *   一字未变。页面每 3 秒自动轮询一次，人工点击几乎必然落在节流窗口内。
 *   等待页同时**没有任何重新发起支付的入口**（只有二维码页有，而那条链接是死路：
 *   `href="/s/ID"` 在 `pending` 时返回的还是等待页）。
 *
 * ## 判据落点（这一节决定护栏是否真的有效）
 *
 *  · 密钥类判据全部落在「**真的能签名 / 真的被拒绝**」上，不看源码里有没有某个词；
 *  · L2 落在**真实 HTTP 保存端点**（`PUT /api/payment/config/:platform`）的返回体上，
 *    因为那才是管理员实际会撞到的层；
 *  · 按钮类判据落在**真实 HTTP 响应**上：303 的 `Location`、以及跟随该 Location 之后
 *    页面里到底出现了什么字。只断言「路由存在」等于什么都没测。
 *
 * ## 隔离
 * 所有 store 都支持 `S3_DATA_DIR`，必须**先设环境变量再 require**，否则假订单会写进
 * 项目真实的 `data/`。网关查单被替换成可控桩函数（真网关需要真凭证 + 公网）。
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r79-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 密钥素材：现场生成，保证「合法」与「非法」两侧都有对照物
 * ---------------------------------------------------------------- */
const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const PKCS1_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs1', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();
/** 支付宝「复制密钥」给出的裸体：只有 Base64，没有 PEM 头 */
const PKCS1_BARE = PKCS1_PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');

/* ---------------------------------------------------------------- *
 * 打桩：云端 / 配置 / 统计 / 网关查单
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
/** 付费生效的三段前提：总开关 → 渠道开关 → 凭证完整（只桩出口，不桩判据） */
configStore.getPayment = () => ({
  enabled: true,
  siteUrl: 'http://127.0.0.1:3000',
  platforms: {
    alipay: {
      enabled: true, appId: '2021000000000000', privateKey: PKCS8_PEM, alipayPublicKey: SPKI_PEM, signType: 'RSA2',
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
const paymentProviders = require(SERVER('payment-providers.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/**
 * 网关查单的可控桩：默认「还没付」。
 * 每个用例自己设 `gatewayReply`，用完由 `resetGateway()` 复位。
 */
let gatewayReply = () => ({ paid: false, state: 'pending', tradeNo: '', failReason: '' });
let gatewayCalls = 0;
paymentGateway.queryCharge = async (platform, cfg, order) => {
  gatewayCalls += 1;
  return gatewayReply(platform, cfg, order);
};
function resetGateway() {
  gatewayReply = () => ({ paid: false, state: 'pending', tradeNo: '', failReason: '' });
  gatewayCalls = 0;
}

/* ---------------------------------------------------------------- *
 * HTTP 夹具：一个只挂分享路由的本地服务
 * ---------------------------------------------------------------- */
async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', shareRoutes);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

let seq = 0;
function makePaidLink(key) {
  seq += 1;
  return shareStore.create({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 500 },
  });
}

/** 造一笔**在途**订单（pending） */
function makePendingOrder(l) {
  const o = paymentOrders.create({
    linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  });
  return paymentOrders.get(o.id);
}

const payCookie = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

/** 页面里是否只有「等待支付」而没有重新支付入口 —— 旧缺陷的形态 */
const WAIT_MARK = '我已完成支付，立即查询';
const CHOOSE_MARK = '立即支付';
const RESTART_MARK = '重新发起支付';

/* ================================================================== *
 * ① L1：签名侧的归一化必须「先解析、再归一化」
 * ================================================================== */

test('R79-01 · 裸 PKCS#1 私钥体必须能签出可验签的收银台 URL（1E08010C 的成因）', async () => {
  // 前提：两种裸体的前缀完全一样，靠前缀不可能分开 —— 否则本用例不成立
  const bare8 = PKCS8_PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  assertEqual(PKCS1_BARE.slice(0, 4), 'MIIE', 'PKCS#1 裸体应以 MIIE 开头');
  assertEqual(bare8.slice(0, 4), 'MIIE', 'PKCS#8 裸体同样以 MIIE 开头');

  const charge = await paymentGateway.createCharge('alipay', {
    appId: '2021000000000000', privateKey: PKCS1_BARE, signType: 'RSA2',
    gateway: 'https://openapi.alipay.com/gateway.do',
  }, {
    order: { id: 'o-r79-01', amountFen: 500 },
    subject: '测试文件',
    returnUrl: 'https://example.com/s/x/pay/return',
    notifyUrl: 'https://example.com/pay/notify/alipay',
  });

  assertEqual(charge.ok, true, `下单必须成功，实际：${JSON.stringify(charge).slice(0, 200)}`);
  assert(/^https:\/\/openapi\.alipay\.com\/gateway\.do\?/.test(String(charge.url)), '应产出收银台跳转地址');

  // 判据落在**密码学有效**上：把 sign 解出来用公钥真验一遍。
  // 「URL 里有 sign 参数」不算数 —— 补错头的情况下 createSign 直接抛错，
  // 而"能拼出一个带 sign 的字符串"同样与密钥对不对无关。
  const u = new URL(charge.url);
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  const sign = params.sign;
  assert(sign, 'URL 必须带 sign 参数');
  delete params.sign;
  const payload = paymentGateway.alipaySignPayload(params);
  const verified = crypto.createVerify('RSA-SHA256').update(payload, 'utf8')
    .verify(SPKI_PEM, sign, 'base64');
  assertEqual(verified, true, '签名必须能被配对的公钥验证通过（这才是「签名真的成功了」）');

  // 反面：同一入口喂垃圾密钥必须失败，而不是拼出一个看似正常的 URL
  const bad = await paymentGateway.createCharge('alipay', {
    appId: '2021000000000000', privateKey: 'A'.repeat(240), signType: 'RSA2',
    gateway: 'https://openapi.alipay.com/gateway.do',
  }, {
    order: { id: 'o-r79-01b', amountFen: 500 },
    subject: 'x', returnUrl: 'https://example.com/r', notifyUrl: 'https://example.com/n',
  });
  assertEqual(bad.ok, false, '无法解析的"密钥"必须 fail-closed，不得产出收银台地址');
});

/* ================================================================== *
 * ② L2：保存校验落在真实 HTTP 端点上
 * ================================================================== */

/** 起一个只挂支付路由的最小服务（管理员身份由测试头注入） */
async function withPaymentServer(fn) {
  const { statsStore: ctxStats } = require(path.join(ROOT, 'server', 'routes', '_context.js'));
  const origLog = ctxStats.addLog;
  ctxStats.addLog = () => {};

  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((req, _res, next) => { req.authUser = { username: 'tester', role: 'admin' }; next(); });
  app.use('/api', require(path.join(ROOT, 'server', 'routes', 'payment.js')));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    ctxStats.addLog = origLog;
    await new Promise((r) => server.close(r));
  }
}

const ALIPAY_OK = {
  appId: '2021004100000000',
  privateKey: PKCS8_PEM,
  alipayPublicKey: SPKI_PEM,
  signType: 'RSA2',
};

test('R79-02 · 保存端点必须拒绝「解不开的私钥」，而不是先落盘再在签名时报错', async () => {
  await withPaymentServer(async (port) => {
    const put = (body) => request(port, 'PUT', '/api/payment/config/alipay', { body });

    // 对照组：真密钥必须能保存成功
    const good = await put(ALIPAY_OK);
    assertEqual(good.status, 200, `合法密钥应保存成功，实际 ${good.status}`);
    assertEqual(good.json && good.json.ok, true, `合法密钥应被接受：${good.raw.slice(0, 200)}`);

    /**
     * 四类真实错填，旧判据**全部放行并落盘**：
     *  ① 公钥贴进私钥框（头尾标记成对）
     *  ② 够长的垃圾 Base64（字符集合法、解码长度也像样）
     *  ③ 带口令的私钥（无口令必解不开）
     *  ④ 只粘了头尾、中间被截断的 PEM
     * 每一条都在**保存这一刻**被拦下，错误里必须点名 privateKey 字段。
     */
    const encrypted = KEY_PAIR.privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'p' }).trim();
    const cases = [
      ['公钥贴进私钥框', SPKI_PEM, /公钥|选错/],
      ['够长的垃圾 Base64', 'A'.repeat(240), /无法解析|截断/],
      ['带口令的私钥', encrypted, /口令/],
      ['截断的 PEM', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', /无法解析|不完整/],
    ];
    for (const [why, privateKey, re] of cases) {
      const r = await put(Object.assign({}, ALIPAY_OK, { privateKey }));
      assert(r.status >= 400 || (r.json && r.json.ok === false),
        `${why} 必须在保存时被拒，实际 ${r.status} ${r.raw.slice(0, 160)}`);
      const errs = (r.json && r.json.errors) || [];
      const hit = errs.find((e) => e.field === 'privateKey');
      assert(hit, `${why} 的错误必须定位到 privateKey 字段：${r.raw.slice(0, 200)}`);
      assert(re.test(hit.message), `${why} 的提示应说清真实原因（期望匹配 ${re}），实际：${hit.message}`);
    }

    // 恢复一份合法配置，避免影响后续用例读到"上一次被拒"的中间态
    const reset = await put(ALIPAY_OK);
    assertEqual(reset.json && reset.json.ok, true, '合法密钥应能重新保存成功');
  });
});

test('R79-03 · 私钥 / 公钥校验器不接受「贴错框」与「非 RSA」', () => {
  const V = paymentProviders.VALIDATORS;
  // 裸 PKCS#1（支付宝控制台最常见的形态）必须通过 —— 这是本次要修的主场景
  assertEqual(V.privateKey(PKCS1_BARE), true, '裸 PKCS#1 密钥体应通过私钥校验');
  assertEqual(V.privateKey(PKCS1_PEM), true, 'PKCS#1 PEM 应通过私钥校验');
  assertEqual(V.publicKey(SPKI_PEM), true, 'SPKI 公钥应通过公钥校验');
  // 贴错框：两个方向都必须被认出来
  assert(/公钥/.test(V.privateKey(SPKI_PEM)), '私钥框收到公钥时应指出"这是一把公钥"');
  assert(/私钥/.test(V.publicKey(PKCS8_PEM)), '公钥框收到私钥时应指出"这是一把私钥"');
  // 非 RSA：ec 密钥结构合法，但两家网关都不接受
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPriv = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert(/ec/.test(V.privateKey(ecPriv)), 'EC 私钥的提示应点名类型是 ec（而不是含混的"无法解析"）');
});

/* ================================================================== *
 * ③ 按钮：点击必须有明确结果，且给出下一步
 * ================================================================== */

/** 跟随一次 303，把落地页拿回来 */
async function follow(port, res, cookie) {
  const loc = res.headers.location;
  assert(loc, '响应必须带 Location');
  return Object.assign({ location: loc }, await request(port, 'GET', loc, { headers: { cookie } }));
}

test('R79-04 · 「我已完成支付」真的去查了网关，并且如实回报「还没到账」', async () => {
  const srv = await serve();
  resetGateway();
  try {
    const l = await makePaidLink('a/wait.txt');
    const order = makePendingOrder(l);
    const cookie = payCookie(l, order);

    // 第一次点击：距上次查单已超过 3 秒（本进程内该订单从未查过）⇒ 必须真的出网
    const r1 = await request(srv.port, 'POST', '/s/' + l.id + '/pay/check', { headers: { cookie } });
    assertEqual(r1.status, 303, '按钮应 303 回分享页（PRG，刷新不重复提交）');
    assert(/checked=pending/.test(String(r1.headers.location)),
      `查过但未到账时应带回 checked=pending，实际 Location：${r1.headers.location}`);
    assertEqual(gatewayCalls, 1, '这一轮必须真的向网关发出一次查单（旧实现节流命中时是 0 次）');

    const page = await follow(srv.port, r1, cookie);
    assertEqual(page.status, 200, '落地页应正常渲染');
    assert(page.raw.includes('已向支付网关查询'), '页面必须明确告诉用户"查过了、还没到账"');
    assert(page.raw.includes(WAIT_MARK), '等待页仍应保留查询按钮');
    assert(page.raw.includes(RESTART_MARK), '等待页必须给出「重新发起支付」入口（此前只有二维码页有）');
  } finally {
    await srv.close();
    resetGateway();
  }
});

test('R79-05 · 节流窗口内再点：不得谎称查过，且必须说清上次是几秒前', async () => {
  const srv = await serve();
  resetGateway();
  try {
    const l = await makePaidLink('a/gap.txt');
    const order = makePendingOrder(l);
    const cookie = payCookie(l, order);

    const first = await request(srv.port, 'POST', '/s/' + l.id + '/pay/check', { headers: { cookie } });
    assert(/checked=pending/.test(String(first.headers.location)), '第一次应真的查单');
    const callsAfterFirst = gatewayCalls;

    // 立刻再点一次：3 秒节流必然命中，这一轮**一个网关请求都不该发**
    const second = await request(srv.port, 'POST', '/s/' + l.id + '/pay/check', { headers: { cookie } });
    assertEqual(second.status, 303, '第二次点击同样要回答（不能什么都不做）');
    assert(/checked=recent/.test(String(second.headers.location)),
      `节流命中时应带回 checked=recent，实际：${second.headers.location}`);
    assertEqual(gatewayCalls, callsAfterFirst, '节流命中时不应再打网关（R8-20 的约束必须保持）');

    const page = await follow(srv.port, second, cookie);
    assert(page.raw.includes('上一次查询在'), '页面必须说清"上一次查询在 N 秒前"，而不是重复那句一字不差的提示');
    assert(!page.raw.includes('已向支付网关查询'), '没有真的查单就不得声称"已向网关查询"（不得编造事实）');
    assert(/上一次查询在 \d+ 秒前/.test(page.raw), '应给出具体的秒数');
    assert(page.raw.includes(RESTART_MARK), '节流时同样要给出重新发起支付的入口');
  } finally {
    await srv.close();
    resetGateway();
  }
});

test('R79-06 · 网关确认到账：按钮直接把人送到下载页，不再停在等待页', async () => {
  const srv = await serve();
  resetGateway();
  try {
    const l = await makePaidLink('a/ok.txt');
    const order = makePendingOrder(l);
    const cookie = payCookie(l, order);

    gatewayReply = () => ({ paid: true, state: 'paid', tradeNo: 'T-1', failReason: '' });
    const r = await request(srv.port, 'POST', '/s/' + l.id + '/pay/check', { headers: { cookie } });
    assertEqual(r.status, 303, '应 303 回分享页');
    assert(!/checked=/.test(String(r.headers.location)),
      '已到账时不必带结果码 —— 落地页本身就是下载页，不需要再解释');

    const page = await follow(srv.port, r, cookie);
    assertEqual(page.status, 200, '付费用户应能正常打开分享页');
    assert(page.raw.includes('支付已完成'), '必须落到「已支付」页，而不是又一张等待页');
    assert(!page.raw.includes(WAIT_MARK), '已到账不应再显示「我已完成支付」按钮');
    assertEqual(paymentOrders.verifyToken(l.id, paymentOrders.orderToken(paymentOrders.get(order.id))).status, 'paid',
      '订单状态必须真的落库为 paid');
  } finally {
    await srv.close();
    resetGateway();
  }
});

test('R79-07 · ?restart=1 才能落到渠道选择页：等待页 / 失败页的「重新支付」不再是死路', async () => {
  const srv = await serve();
  resetGateway();
  try {
    const l = await makePaidLink('a/restart.txt');
    const order = makePendingOrder(l);
    const cookie = payCookie(l, order);

    // 默认：等待页（没有渠道选择）
    const waiting = await request(srv.port, 'GET', '/s/' + l.id, { headers: { cookie } });
    assertEqual(waiting.status, 200);
    assert(waiting.raw.includes(WAIT_MARK), '默认应渲染等待支付页');
    assert(!waiting.raw.includes(CHOOSE_MARK), '等待页不应出现「立即支付」按钮');

    // 带 restart：必须是渠道选择页 —— 那条链接才真的能重新拉起支付
    const choose = await request(srv.port, 'GET', '/s/' + l.id + '?restart=1', { headers: { cookie } });
    assertEqual(choose.status, 200, 'restart 不应报错');
    assert(choose.raw.includes(CHOOSE_MARK), 'restart=1 应渲染渠道选择页（含「立即支付」）');
    assert(choose.raw.includes('/s/' + l.id + '/pay'), '渠道选择页的支付表单应指向 /pay');
    assert(!choose.raw.includes(WAIT_MARK), 'restart=1 不应又回到等待页（那正是旧实现的死路）');

    // 失败订单的「重新支付」同理：先落到失败页（402），再点必须能到渠道选择页
    paymentOrders.markFailed(order.id, '用户取消');
    const failed = await request(srv.port, 'GET', '/s/' + l.id, { headers: { cookie } });
    assertEqual(failed.status, 402, '失败订单应渲染失败页');
    assert(failed.raw.includes('?restart=1'), '失败页的「重新支付」必须带上 restart=1');
    const after = await request(srv.port, 'GET', '/s/' + l.id + '?restart=1', { headers: { cookie } });
    assert(after.raw.includes(CHOOSE_MARK), '失败页点「重新支付」后必须真的到渠道选择页');
    assertEqual(after.status, 200, '此时不应再是 402');

    /**
     * 反向守卫：已支付的人**不能**被 restart 诱导再付一次。
     * 这是 restart 这类"绕过状态判断的开关"最容易引入的回归。
     */
    paymentOrders.markPaid(order.id);
    const paid = await request(srv.port, 'GET', '/s/' + l.id + '?restart=1', { headers: { cookie } });
    assert(paid.raw.includes('支付已完成') && !paid.raw.includes(CHOOSE_MARK),
      '已支付订单即使带 restart=1 也必须停在「已支付」页，不得出现支付入口');
  } finally {
    await srv.close();
    resetGateway();
  }
});

/* 兜底回收临时目录 */
process.on('exit', () => tmp.cleanup());
