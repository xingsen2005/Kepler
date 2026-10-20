/**
 * 第六十四轮护栏：订单号系统 + 分享页「恢复购买 / 查看历史订单」（R64）
 *
 * 需求原文（用户口述，逐条对应到下面的用例）：
 *  1、付费文件 + 未登录：卡片下方新增「恢复购买」；点它输入订单号，
 *     订单号存在且能与当前链接匹配则允许重新下载而无需再次付费；页面右上角新增「登录」。
 *  2、付费文件 + 已登录：卡片下方新增「查看历史订单」；可看自己全部已购订单并重新下载；
 *     其中也显示免费下载的文件，但只展示第一次；页面右上角新增「退出登录」。
 *  3、完善订单号系统：36 位及以上（13 位毫秒时间戳 + 9 位链接 UID + 9 位用户 UID +
 *     5 位随机串，均区分大小写、非顺序）；不论游客还是已登录用户都展示订单号、
 *     允许复制，并告知「订单号是售后和取回下载权限的唯一凭证」。
 *  前提：所有取回功能只在订单状态为「支付成功」时成立。
 *
 * ## 分层（每条都指向**实际被执行的那一层**）
 *
 *  ① 纯函数层 —— `server/order-no.js`：长度 / 结构 / 区分大小写 / 非顺序 / 确定性派生
 *  ② 存储层   —— `payment-orders`：`orderNo` 落库、`claimForLink` 的四类拒绝、
 *                `id` 仍 ≤32（微信 out_trade_no 上限，36 位订单号不能直接当商户单号）
 *  ③ HTTP 层  —— 真实 `share-routes.js` + 真实 express + 打桩云端：
 *                两张入口位置（卡片下方 / 右上角）、订单号与复制按钮、恢复购买的成功与
 *                四类拒绝、历史订单（含免费下载只记首次）、退出登录真的销毁会话
 *  ④ 存储层   —— `download-log`：同一文件只记首次、不同文件各一条
 */
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

/**
 * ⚠️ 所有 store 都支持 `S3_DATA_DIR`，必须**先设环境变量再 require**，
 * 否则用例会把假订单 / 假下载记录写进项目真实的 data/。
 */
const tmp = makeTempDir('r64-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---- 打桩：云端客户端（callback 风格，与 s3.p 的约定一致） ---- */
let cloud = null;
function okCloud() {
  return {
    headObject(_params, cb) { cb(null, { headers: { 'content-length': '5' } }); },
    getObject(params, cb) {
      // ⚠️ 必须写进 `params.Output`：`streamDownload` 等的是流上的数据，不是返回值
      params.Output.end(Buffer.from('hello'));
      cb(null, {});
    },
  };
}
cloud = okCloud();

const s3 = require(SERVER('s3.js'));
s3.getClient = () => cloud; // 必须在 require share-routes **之前**替换（路由加载时就解构了）

const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});
/**
 * 付费生效的前提链：总开关开 → 至少一个渠道开 → 该渠道凭证完整。
 * 三个条件都从 `configStore.getPayment()` 读，故只桩这一个出口即可
 * （不桩 `paymentRules.resolvePaidState`：那样测的就不是真实判据了）。
 */
configStore.getPayment = () => ({
  enabled: true,
  siteUrl: 'http://127.0.0.1:3000',
  platforms: {
    alipay: {
      enabled: true, appId: '2021000000000000', privateKey: 'K', alipayPublicKey: 'P', signType: 'RSA2',
    },
  },
});

const statsStore = require(SERVER('stats-store.js'));
const logs = [];
statsStore.addLog = (e) => logs.push(e);
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const downloadLog = require(SERVER('download-log.js'));
const authSession = require(SERVER('auth-session.js'));
const security = require(SERVER('security.js'));
const orderNo = require(SERVER('order-no.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/** 起一个只挂分享路由的本地服务 */
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
function makeLink(key, extra = {}) {
  seq += 1;
  return shareStore.create(Object.assign({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  }, extra));
}

/** 付费链接（分享者要求付费） */
const makePaidLink = (key, extra) => makeLink(key, Object.assign({ paid: { required: true, amountFen: 500 } }, extra));

/** 造一笔订单（默认就是「支付成功」——需求前提） */
function makeOrder(l, patch = {}) {
  const o = paymentOrders.create(Object.assign({
    linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  }, patch));
  if (patch.status !== 'pending' && patch.status !== 'failed') paymentOrders.markPaid(o.id);
  return paymentOrders.get(o.id);
}

/** 支付票据 Cookie（与真实下发同名） */
const payCookie = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

const users = [];
function sessionFor(name) {
  const u = { id: 'u-' + name + '-' + Math.random().toString(36).slice(2, 8), username: name, role: 'user' };
  users.push(u);
  return { user: u, cookie: authSession.COOKIE_NAME + '=' + authSession.createSession(u) };
}

const setCookieOf = (r) => [].concat(r.headers['set-cookie'] || []).join('\n');

/* ================================================================== *
 * ① 纯函数层：订单号本身
 * ================================================================== */

test('R64-01 · 订单号为 36 位：13 位毫秒时间戳 + 9 位链接 UID + 9 位用户 UID + 5 位随机串', () => {
  const a = orderNo.compose({ linkId: 'link-A', userId: 'user-A' });
  assertEqual(a.no.length, 36, `订单号应为 36 位，实际 ${a.no.length}`);
  assert(orderNo.isOrderNo(a.no), `订单号应能通过格式校验：${a.no}`);

  const p = orderNo.parse(a.no);
  assert(p.ok, '应能解析');
  assertMatch(a.no.slice(0, 13), /^\d{13}$/, '首段必须是 13 位毫秒时间戳');
  assert(Math.abs(p.ts - Date.now()) < 120000, '时间戳应贴近当前时刻（毫秒级）');
  assertEqual(p.linkUid.length, 9, '链接 UID 应为 9 位');
  assertEqual(p.userUid.length, 9, '用户 UID 应为 9 位');
  assertEqual(p.rand.length, 5, '随机串应为 5 位');

  // 派生关系：链接段与账号段必须能由 id 复算出来（恢复购买靠它回答"这号属于这条链接吗"）
  assertEqual(p.linkUid, orderNo.linkUidOf('link-A'), '链接 UID 必须由 linkId 确定性派生');
  assertEqual(p.userUid, orderNo.userUidOf('user-A'), '用户 UID 必须由 userId 确定性派生');

  // 反例：只断言「生成的号是 36 位」是不够的 —— 判据本身也必须拒绝别的长度与非法字符，
  // 否则「36 位」只是生成侧的一厢情愿，用户抄错一位照样能提交（R64-01a 即撤掉这三条的前提）。
  assert(!orderNo.isOrderNo(a.no.slice(0, 35)), '长度不足 36 位不是订单号');
  assert(!orderNo.isOrderNo(a.no + 'A'), '长度超过 36 位不是订单号');
  assert(!orderNo.isOrderNo(a.no.slice(0, 35) + '-'), '含连字符不是订单号（订单号内不出现分隔符）');
});

test('R64-02 · 订单号区分大小写、非顺序：同链接同账号每次不同，且大小写与数字都出现', () => {
  const seen = new Set();
  let upper = 0;
  let lower = 0;
  let digit = 0;
  for (let i = 0; i < 200; i++) {
    const no = orderNo.compose({ linkId: 'link-B', userId: 'user-B' }).no;
    assert(!seen.has(no), `订单号必须唯一，重复出现：${no}`);
    seen.add(no);
    if (/[A-Z]/.test(no.slice(13))) upper += 1;
    if (/[a-z]/.test(no.slice(13))) lower += 1;
    if (/\d/.test(no.slice(13))) digit += 1;
  }
  assertEqual(seen.size, 200, '200 次生成必须全部唯一');
  assert(upper > 190 && lower > 190 && digit > 190,
    `顺序号或单字符集不满足需求：大写 ${upper}/200、小写 ${lower}/200、数字 ${digit}/200`);

  // 游客（无 userId）的账号段必须按单随机，而不是固定空值
  const g1 = orderNo.compose({ linkId: 'link-B' });
  const g2 = orderNo.compose({ linkId: 'link-B' });
  assertEqual(g1.linkUid, g2.linkUid, '同一链接的链接 UID 恒定');
  assertEqual(g1.userUid.length, 9, '游客也要有 9 位用户 UID');
  assert(g1.userUid !== g2.userUid, '游客两次下单的账号段应随机，而不是同一个空值');

  // 大小写敏感：只改一个字符的大小写就必须是另一个号
  assert(!orderNo.isOrderNo(orderNo.compose({ linkId: 'X' }).no.slice(0, 35)), '长度不足 36 位不是订单号');
});

/* ================================================================== *
 * ② 存储层：落库、取回判定、网关订单号
 * ================================================================== */

test('R64-03 · 内部记录 id 与用户订单号分离，且 id 仍 ≤32（微信 out_trade_no 上限）', async () => {
  const l = await makePaidLink('id-split.txt');
  const o = makeOrder(l);
  assertEqual(o.orderNo.length, 36, '落库的订单号应为 36 位');
  assert(o.orderNo !== o.id, '订单号不能等于内部记录 id');
  /**
   * 这条断言是「为什么不直接把 id 换成长订单号」的护栏：微信支付 v3 的
   * `out_trade_no` 最长 32 位，36 位塞进去会让下单直接失败。
   */
  assert(o.id.length <= 32, `网关侧商户单号必须 ≤32 位，实际 ${o.id.length}`);
  assertEqual(paymentOrders.view(o).orderNo, o.orderNo, '管理端视图必须带出用户可见订单号');
});

test('R64-04 · claimForLink：只有「支付成功」放行；未支付 / 已退款 / 别的链接 / 不存在一律拒绝', async () => {
  const l1 = await makePaidLink('claim-1.txt');
  const l2 = await makePaidLink('claim-2.txt');

  const paid = makeOrder(l1, { userId: 'u-payed' });
  assertEqual(paymentOrders.claimForLink(paid.orderNo, l1.id).ok, true, '已支付订单应可取回');

  const pending = paymentOrders.create({ linkId: l1.id, platform: 'alipay', amountFen: 500, currency: 'CNY' });
  assertEqual(paymentOrders.claimForLink(pending.orderNo, l1.id).reason, 'pending',
    '未支付订单绝不能取回（需求末句：前提是支付成功）');

  const failed = paymentOrders.create({ linkId: l1.id, platform: 'alipay', amountFen: 500, currency: 'CNY' });
  paymentOrders.markFailed(failed.id, '测试用失败');
  assertEqual(paymentOrders.claimForLink(failed.orderNo, l1.id).reason, 'failed', '支付失败订单应被拒绝');

  const refunded = makeOrder(l1);
  paymentOrders.markRefunded(refunded.id);
  assertEqual(paymentOrders.claimForLink(refunded.orderNo, l1.id).reason, 'refunded',
    '已退款订单的凭证必须保持失效');

  // 链接不匹配 与 根本不存在，必须给**同一条** reason（否则订单号存在性成了预言机）
  const other = makeOrder(l2);
  const mismatch = paymentOrders.claimForLink(other.orderNo, l1.id);
  const missing = paymentOrders.claimForLink('1'.repeat(13) + 'a'.repeat(23), l1.id);
  assertEqual(mismatch.reason, 'invalid', '别的链接的订单号应被拒绝');
  assertEqual(missing.reason, 'invalid', '不存在的订单号应被拒绝');
  assertEqual(mismatch.message, missing.message,
    '两种情况必须给同一条文案 —— 否则可被用来探测"某个订单号是否存在"');
});

test('R64-05 · 老订单（只有内部 id）仍能凭原订单号取回，且抄写时的空格 / 连字符被容错', async () => {
  const l = await makePaidLink('legacy.txt');
  const o = makeOrder(l);
  assertEqual(paymentOrders.claimForLink(o.id, l.id).ok, true,
    'R64 之前的订单号就是 id —— 升级后不该认不出来');
  const spaced = o.orderNo.slice(0, 10) + ' ' + o.orderNo.slice(10, 20) + ' ' + o.orderNo.slice(20);
  assertEqual(paymentOrders.claimForLink(spaced, l.id).ok, true, '抄写时插入的空格应被容错');
});

/* ================================================================== *
 * ③ HTTP 层：两张入口、订单号展示、恢复购买、历史订单、退出登录
 * ================================================================== */

test('R64-06 · 未登录 + 付费链接：卡片下方是「恢复购买」，右上角是「登录」', async () => {
  const l = await makePaidLink('entry-guest.txt');
  const srv = await serve();
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200, `付费页应 200，实际 ${r.status}`);
    assertMatch(r.raw, new RegExp('/s/' + l.id + '/restore'), '卡片下方必须有「恢复购买」入口');
    assertMatch(r.raw, /恢复购买/, '入口文案必须是「恢复购买」');
    assertMatch(r.raw, /class="below-card/, '入口必须在卡片**下方**（below-card 槽位），而不是卡片内');
    assert(!new RegExp('/s/' + l.id + '/history').test(r.raw), '未登录不应出现「查看历史订单」');
    // 右上角「登录」：带 next 回到本条分享
    assertMatch(r.raw, /class="topbar"/, '页面右上角必须有账号栏');
    assertMatch(r.raw, /\?next=%2Fs%2F/, '「登录」必须带 next 参数，登录后回到这条分享');
  } finally { await srv.close(); }
});

test('R64-07 · 已登录 + 付费链接：卡片下方是「查看历史订单」，右上角是「退出登录」', async () => {
  const l = await makePaidLink('entry-user.txt');
  const { user, cookie } = sessionFor('alice');
  const srv = await serve();
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: cookie } });
    assertEqual(r.status, 200, `应 200，实际 ${r.status}`);
    assertMatch(r.raw, new RegExp('/s/' + l.id + '/history'), '已登录必须给「查看历史订单」入口');
    assertMatch(r.raw, /查看历史订单/, '入口文案必须是「查看历史订单」');
    assert(!new RegExp('/s/' + l.id + '/restore').test(r.raw),
      '已登录不应再出现「恢复购买」（订单已能按账号归集）');
    assertMatch(r.raw, /退出登录/, '右上角必须有「退出登录」');
    assertMatch(r.raw, new RegExp('action="/s/' + l.id + '/logout"'), '退出登录必须提交到分享侧退出口');
    assertMatch(r.raw, new RegExp(user.username), '右上角应显示当前账号');
  } finally { await srv.close(); }
});

test('R64-08 · 已支付页展示 36 位订单号 + 复制按钮 + 「唯一凭证」提示（游客与登录用户都有）', async () => {
  const l = await makePaidLink('show-no.txt');
  const order = makeOrder(l);
  const srv = await serve();
  try {
    // 游客（只持支付票据 Cookie）
    const guest = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: payCookie(l, order) } });
    assertEqual(guest.status, 200, '已支付页应 200');
    assert(guest.raw.includes(order.orderNo), '已支付页必须展示完整订单号');
    assertMatch(guest.raw, new RegExp(`data-copy-order="${order.orderNo}"`), '必须提供一键复制（携带完整号码）');
    assertMatch(guest.raw, /订单号是售后和取回下载权限的唯一凭证/, '必须告知"订单号是唯一凭证"');
    assertMatch(guest.raw, /\/js\/share-order\.js/, '复制功能由同源脚本提供（CSP 不允许内联脚本）');
    assertMatch(guest.raw, /恢复购买/, '游客的隐藏入口仍是「恢复购买」');

    // 已登录用户：同样看得到订单号
    const { cookie } = sessionFor('bob');
    const mine = makeOrder(l, { userId: 'u-bob' });
    const li = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: payCookie(l, mine) + '; ' + cookie } });
    assert(li.raw.includes(mine.orderNo), '登录用户也必须看到订单号');
  } finally { await srv.close(); }
});

test('R64-09 · 恢复购买成功：签发票据 → 页面转为已支付 → 下载放行', async () => {
  const l = await makePaidLink('restore-ok.txt');
  const order = makeOrder(l); // 别的浏览器买的：本请求没有任何支付票据
  const srv = await serve();
  try {
    const before = await request(srv.port, 'GET', '/s/' + l.id);
    assertMatch(before.raw, /恢复购买/, '前置：此时还没有支付票据');

    const post = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: order.orderNo } });
    assertEqual(post.status, 303, `成功后应 303 回分享页，实际 ${post.status}`);
    const sc = setCookieOf(post);
    assertMatch(sc, new RegExp('sp_' + l.id + '_pay='), '必须下发该链接的支付票据');

    const cookie = 'sp_' + l.id + '_pay=' + (/sp_[^=]+_pay=([^;]+)/.exec(sc) || [])[1];
    const after = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: cookie } });
    assertMatch(after.raw, /支付已完成，可直接下载/, '取回后必须显示为已支付');
    assertMatch(after.raw, /\/s\/.+\/dl/, '取回后必须给出下载入口');

    // HEAD 与 GET 同一判据：取回前 402、取回后 200
    const headBefore = await request(srv.port, 'HEAD', '/s/' + l.id + '/dl');
    assertEqual(headBefore.status, 402, '没有票据时 HEAD 必须 402');
    const headAfter = await request(srv.port, 'HEAD', '/s/' + l.id + '/dl', { headers: { Cookie: cookie } });
    assertEqual(headAfter.status, 200, '取回后 HEAD 应放行');
  } finally { await srv.close(); }
});

test('R64-10 · 恢复购买拒绝：未支付 / 已退款 / 其它链接 / 不存在 —— 一律不签票据', async () => {
  const l = await makePaidLink('restore-no.txt');
  const other = await makePaidLink('restore-other.txt');
  const pending = paymentOrders.create({ linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY' });
  const refunded = makeOrder(l);
  paymentOrders.markRefunded(refunded.id);
  const foreign = makeOrder(other);
  const srv = await serve();
  try {
    const cases = [
      { no: pending.orderNo, why: '未支付订单' },
      { no: refunded.orderNo, why: '已退款订单' },
      { no: foreign.orderNo, why: '别的链接的订单号' },
      { no: '9'.repeat(13) + 'Z'.repeat(23), why: '不存在的订单号' },
    ];
    for (const c of cases) {
      const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: c.no } });
      assertEqual(r.status, 400, `${c.why} 必须被拒绝（400），实际 ${r.status}`);
      assert(!/sp_.*_pay=/.test(setCookieOf(r)), `${c.why} 绝不能签发票据`);
      assertMatch(r.raw, /恢复购买/, `${c.why} 应停留在恢复购买页并给出提示`);
    }
    // 未支付与已退款必须给出**不同**文案（一个"去付款"，一个"凭证失效"）
    const p1 = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: pending.orderNo } });
    const p2 = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: refunded.orderNo } });
    assertMatch(p1.raw, /尚未支付成功/, '未支付应有对应提示');
    assertMatch(p2.raw, /已退款/, '已退款应有对应提示');
  } finally { await srv.close(); }
});

test('R64-11 · 历史订单：未登录返回 401 并指路；已登录只列自己的订单与免费下载（只首次）', async () => {
  const l = await makePaidLink('history.txt');
  const otherLink = await makePaidLink('history-other.txt');
  const freeLink = await makeLink('history-free.txt');
  const alice = sessionFor('carol');
  const bob = sessionFor('dave');

  const mine = makeOrder(l, { userId: alice.user.id, userName: alice.user.username });
  makeOrder(otherLink, { userId: bob.user.id, userName: bob.user.username });

  /**
   * 免费下载两次同一个文件 —— 只应留下一条记录。
   * ⚠️ 这里必须**真的走一遍下载端点**（而不是直接调 `downloadLog.record`）：
   * 需求 2② 的落点在「下载成功之后记一笔」那一行，直接调 store 会绕开接线。
   */
  const dlSrv = await serve();
  try {
    for (let i = 0; i < 2; i++) {
      const dl = await request(dlSrv.port, 'GET', '/s/' + freeLink.id + '/dl', { headers: { Cookie: alice.cookie } });
      assertEqual(dl.status, 200, `免费下载应成功，实际 ${dl.status}`);
    }
  } finally { await dlSrv.close(); }
  assertEqual(downloadLog.listForUser(alice.user.id).length, 1,
    '同一文件下两次必须只留一条记录（download-log 去重）');

  const srv = await serve();
  try {
    const anon = await request(srv.port, 'GET', '/s/' + l.id + '/history');
    assertEqual(anon.status, 401, `未登录应 401，实际 ${anon.status}`);
    assertMatch(anon.raw, /请先登录/, '必须明确提示需要登录');

    const r = await request(srv.port, 'GET', '/s/' + l.id + '/history', { headers: { Cookie: alice.cookie } });
    assertEqual(r.status, 200, `已登录应 200，实际 ${r.status}`);
    assert(r.raw.includes(mine.orderNo), '必须列出自己的订单号（可复制取回）');
    assertMatch(r.raw, /重新下载/, '已购订单必须可重新下载');
    assert(!r.raw.includes('history-other.txt'), '绝不能出现别人的订单');
    assertMatch(r.raw, /免费下载（1/, `免费下载只应记首次（页面显示 1 条），实际：${
      (/免费下载（(\d+)/.exec(r.raw) || [])[1]}`);
    assertMatch(setCookieOf(r), new RegExp('sp_' + l.id + '_pay='),
      '历史订单页必须为该账号的已付链接补发票据，否则「重新下载」点下去会回到付费页');
  } finally { await srv.close(); }
});

test('R64-12 · 退出登录：销毁会话并清 Cookie，之后页面回到「登录」', async () => {
  const l = await makePaidLink('logout.txt');
  const { cookie } = sessionFor('erin');
  const srv = await serve();
  try {
    const before = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: cookie } });
    assertMatch(before.raw, /退出登录/, '前置：已登录');

    const out = await request(srv.port, 'POST', '/s/' + l.id + '/logout', { headers: { Cookie: cookie } });
    assertEqual(out.status, 303, `退出应 303 回分享页，实际 ${out.status}`);
    assertMatch(setCookieOf(out), /s3mgr_session=;/, '必须清空会话 Cookie');

    const after = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: cookie } });
    assertMatch(after.raw, /class="tb-link"[^>]*>登录/, '退出后右上角应回到「登录」');
    // 判据要看**标记**而不是文案：页面样式块里有一句说明性注释也含「退出登录」四个字
    assert(!new RegExp('action="/s/' + l.id + '/logout"').test(after.raw),
      '退出后不应再渲染退出表单');
  } finally { await srv.close(); }
});

test('R64-13 · 免费下载记录：同一文件只记首次、不同文件各一条、游客不记、按用户隔离', async () => {
  const l1 = await makeLink('log-a.txt');
  const l2 = await makeLink('log-b.txt');
  const me = sessionFor('frank');

  assertEqual(downloadLog.record({
    userId: me.user.id, linkId: l1.id, files: [{ key: 'log-a.txt' }],
  }), 1, '首次应记一条');
  assertEqual(downloadLog.record({
    userId: me.user.id, linkId: l1.id, files: [{ key: 'log-a.txt' }],
  }), 0, '重复下载同一文件不应再记（需求 2②）');
  assertEqual(downloadLog.record({
    userId: me.user.id, linkId: l1.id, files: [{ key: 'log-a.txt' }, { key: 'log-c.txt' }],
  }), 1, '同一批里只应新增那个没记过的文件');
  assertEqual(downloadLog.record({
    userId: me.user.id, linkId: l2.id, files: [{ key: 'log-a.txt' }],
  }), 1, '换个链接算另一次下载');
  assertEqual(downloadLog.record({
    userId: '', linkId: l1.id, files: [{ key: 'log-a.txt' }],
  }), 0, '游客没有稳定身份，不记录');

  assertEqual(downloadLog.listForUser(me.user.id).length, 3, '该用户共 3 条');
  assertEqual(downloadLog.listForUser('someone-else').length, 0, '不能串到别人名下');
});

test('R64-14 · 恢复购买入口接线了独立限流器（按 IP，20 次 / 10 分钟）', () => {
  // 行为层：限流器实例本身必须真的会拦（第 21 次起拒绝）
  const key = 'probe-' + Math.random().toString(36).slice(2);
  let allowed = 0;
  for (let i = 0; i < 21; i++) if (security.orderRestoreLimiter(key).ok) allowed += 1;
  assertEqual(allowed, 20, `应按 20 次/10 分钟放行，实际 ${allowed}`);

  // 接线层：路由必须调用**这一个**实例（否则限流器只是摆设）
  const src = require('fs').readFileSync(SERVER('share-routes.js'), 'utf8');
  assertMatch(src, /security\.orderRestoreLimiter\(ip\)/,
    'POST /s/:id/restore 必须按压 IP 限流');
});
