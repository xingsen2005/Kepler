/**
 * 第八十六轮护栏：订单号取回新增「账号归属」限制（R86）
 *
 * 需求原文：
 *  「目前可以使用已支付完成的订单号来取回下载权限。加入一个限制：如果检测到
 *   这个订单号是已登录账号的情况下完成的，则必须登录原有账号才能取回下载权限；
 *   未登录的情况下完成购买的订单则在任何情况下都可以使用订单号取回下载权限。」
 *
 * 拆成两条可判定的规则（判据都住在 `paymentOrders.claimForLink()`，不另写一份）：
 *   ① 订单带 `userId`（登录态成交）⇒ 只有 `viewerId === userId` 才放行；
 *   ② 订单不带 `userId`（游客成交）⇒ 任何请求者都放行 —— 它没有「原账号」可依，
 *      加限制等于直接作废这张凭证。
 *
 * ## 分层（每条都指向**实际被执行的那一层**）
 *
 *  ① 判定层 —— `claimForLink()`：need_login / wrong_user、闸门**先于**取回额度、
 *              失败**不消耗**额度、拒绝时不回传订单快照（不泄露归属者）
 *  ② HTTP 层 —— 真实 `share-routes.js`：400 + 「去登录 / 切换账号」入口、不签票据、
 *              原账号 303 签票据、**游客订单行为完全不变**
 *  ③ 计数层 —— 归属不符**不计入**连续输错（挡的应该是猜号者，不是忘了登录的买主）
 */
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

/**
 * ⚠️ 所有 store 都支持 `S3_DATA_DIR`，必须**先设环境变量再 require**，
 * 否则用例会把假订单写进项目真实的 data/。
 */
const tmp = makeTempDir('r86-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---- 打桩：云端客户端（callback 风格，与 s3.p 的约定一致） ---- */
const s3 = require(SERVER('s3.js'));
s3.getClient = () => ({
  headObject(_params, cb) { cb(null, { headers: { 'content-length': '5' } }); },
  getObject(params, cb) {
    // ⚠️ 必须写进 `params.Output`：`streamDownload` 等的是流上的数据，不是返回值
    params.Output.end(Buffer.from('hello'));
    cb(null, {});
  },
});

const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});
/**
 * 付费生效的前提链：总开关开 → 至少一个渠道开 → 该渠道凭证完整。
 * 三个条件都从 `configStore.getPayment()` 读，故只桩这一个出口即可。
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
const authSession = require(SERVER('auth-session.js'));
const restoreGuard = require(SERVER('restore-guard.js'));
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
async function makeLink(key, extra = {}) {
  seq += 1;
  /**
   * ⚠️ `shareStore.create()` 只接受**一个**对象 —— 把 `extra` 当成第二个参数传进去
   * 会被静默忽略（付费配置丢失 ⇒ 链接不是付费链接 ⇒ 恢复购买页 404）。
   */
  return shareStore.create(Object.assign({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  }, extra));
}
const makePaidLink = (key, extra) =>
  makeLink(key, Object.assign({ paid: { required: true, amountFen: 500 } }, extra));

/** 造一笔「支付成功」的订单；`userId` 不传 = 游客单（`create` 会落成空串） */
function makeOrder(l, patch = {}) {
  const o = paymentOrders.create(Object.assign({
    linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  }, patch));
  paymentOrders.markPaid(o.id);
  return paymentOrders.get(o.id);
}

/** 真会话：拿到的是 `authSession.createSession()` 的真实 cookie，中间件据此填 `shareUser` */
function sessionFor(name) {
  const u = { id: 'u-' + name + '-' + Math.random().toString(36).slice(2, 8), username: name, role: 'user' };
  return { user: u, cookie: authSession.COOKIE_NAME + '=' + authSession.createSession(u) };
}

const setCookieOf = (r) => [].concat(r.headers['set-cookie'] || []).join('\n');

/** 每个 HTTP 用例开始前先解封本机，避免上一条用例的封禁串进来 */
function resetLocal() {
  restoreGuard.unban('127.0.0.1');
  restoreGuard.unban('::1');
  restoreGuard.unban('::ffff:127.0.0.1');
}

const countOf = (o) => Number(paymentOrders.get(o.id).restoreCount || 0);

/* ================================================================== *
 * ① 判定层：规则本身
 * ================================================================== */

test('R86-01 · 游客订单（userId 为空）任何情况下都能取回 —— 本次限制不收紧它', async () => {
  const l = await makePaidLink('r86-guest.txt');
  const o = makeOrder(l);
  assertEqual(o.userId, '', '前置：游客订单的 userId 必须是空串');

  assertEqual(paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 3 }).ok, true,
    '未登录提交游客订单必须放行（需求原文：任何情况下都可以）');
  assertEqual(paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 3, viewerId: '' }).ok, true,
    '显式传空串（= 未登录）同样放行');
  /**
   * 这条是「不要顺手把游客单也上锁」的护栏：游客单没有归属者，
   * 若按「登录者必须等于 userId」去判，空串会与任何登录用户都不等 ⇒ 全被拒。
   */
  assertEqual(paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 3, viewerId: 'u-anyone' }).ok, true,
    '游客订单即使请求者已登录也必须放行');
});

test('R86-02 · 登录态订单 + 未登录 ⇒ need_login，且不消耗取回额度', async () => {
  const l = await makePaidLink('r86-needlogin.txt');
  const owner = sessionFor('owner');
  const o = makeOrder(l, { userId: owner.user.id });

  const r = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2 });
  assertEqual(r.ok, false, '未登录绝不能取回登录态订单');
  assertEqual(r.reason, 'need_login', `reason 应为 need_login，实际 ${r.reason}`);
  assertMatch(r.message, /登录/, '文案必须引导去登录');
  assertMatch(r.message, /购买时使用的账号/, '文案必须点明「购买时使用的账号」');
  /**
   * 拒绝时**不回传订单快照**：`order` 里有 `userId` / `userName` / `payerIp`，
   * 一旦上层误渲染就是「这单是谁买的、从哪个 IP 付的」。
   */
  assertEqual(r.order, null, '拒绝时不得回传订单快照（避免泄露归属者与付款 IP）');
  assertEqual(countOf(o), 0, '未登录被拦不得消耗原主的取回额度');
});

test('R86-03 · 登录态订单 + 换了账号 ⇒ wrong_user，且不回显归属者', async () => {
  const l = await makePaidLink('r86-wronguser.txt');
  const owner = sessionFor('realbuyer');
  const mallory = sessionFor('someoneelse');
  const o = makeOrder(l, { userId: owner.user.id, userName: 'realbuyer' });

  const r = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2, viewerId: mallory.user.id });
  assertEqual(r.ok, false, '别的账号绝不能取回');
  assertEqual(r.reason, 'wrong_user', `reason 应为 wrong_user，实际 ${r.reason}`);
  assertMatch(r.message, /另一个账号/, '文案必须说明是「另一个账号」完成的订单');
  assertEqual(r.order, null, '拒绝时不得回传订单快照');
  /**
   * 文案只回答「你登的不是买它的那个号」，**不回答「买它的是谁」** ——
   * 把 id / 用户名回显给一个陌生人，等于把订单归属也一起泄了。
   */
  assert(!r.message.includes(owner.user.id), '文案不得包含归属账号的 id');
  assert(!r.message.includes('realbuyer'), '文案不得包含归属账号的用户名');
  assertEqual(countOf(o), 0, '归属不符不得消耗原主的取回额度');
});

test('R86-04 · 登录态订单 + 原账号 ⇒ 放行，并照常返回订单', async () => {
  const l = await makePaidLink('r86-owner-ok.txt');
  const owner = sessionFor('ownergood');
  const o = makeOrder(l, { userId: owner.user.id });

  const r = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2, viewerId: owner.user.id });
  assertEqual(r.ok, true, `原账号必须放行，实际 reason=${r.reason}`);
  assertEqual(r.order.orderNo, o.orderNo, '放行时必须回传该订单');
  assertEqual(countOf(o), 1, '放行一次应记一次额度（maxUses>0 时）');
});

test('R86-05 · 归属闸门**先于**取回额度：额度用完 + 错账号 ⇒ wrong_user，不是 used_up', async () => {
  const l = await makePaidLink('r86-order.txt');
  const owner = sessionFor('ownerorder');
  const mallory = sessionFor('malloryorder');
  const o = makeOrder(l, { userId: owner.user.id });

  // 先用原账号把唯一一次额度用掉
  assertEqual(paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 1, viewerId: owner.user.id }).ok, true,
    '前置：原账号首次取回应成功');
  assertEqual(countOf(o), 1, '前置：额度已用尽');

  const wrong = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 1, viewerId: mallory.user.id });
  assertEqual(wrong.reason, 'wrong_user',
    `顺序错了：应先判归属再判额度，实际 ${wrong.reason}（若为 used_up 等于把「这单存在且有主」泄露给陌生人）`);

  const again = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 1, viewerId: owner.user.id });
  assertEqual(again.reason, 'used_up', '原账号额度确实用尽时应报 used_up');
});

test('R86-06 · 归属不符反复尝试不会吃掉额度：错账号试 3 次后原账号仍可正常取回', async () => {
  const l = await makePaidLink('r86-noconsume.txt');
  const owner = sessionFor('ownernc');
  const mallory = sessionFor('mallorync');
  const o = makeOrder(l, { userId: owner.user.id });

  for (let i = 0; i < 3; i++) {
    assertEqual(
      paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 1, viewerId: mallory.user.id }).reason,
      'wrong_user',
      `第 ${i + 1} 次错账号请求应被归属闸门拦下`,
    );
  }
  assertEqual(countOf(o), 0, '三次失败的归属校验绝不能递增 restoreCount');

  const ok = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 1, viewerId: owner.user.id });
  assertEqual(ok.ok, true, '原主的一次机会必须还在（否则陌生人拿号就能替他把凭证作废）');
});

test('R86-07 · 归属闸门只对「支付成功」生效：未支付 / 已退款的判定顺序不变', async () => {
  const l = await makePaidLink('r86-order2.txt');
  const owner = sessionFor('ownerprec');
  const pending = paymentOrders.create({ linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY' });
  const refunded = makeOrder(l, { userId: owner.user.id });
  paymentOrders.markRefunded(refunded.id);

  /**
   * 这两条防的是「闸门插错位置」：若把归属判定提到 `paid` 分支之外，
   * 未支付 / 已退款就会先撞上 need_login，用户拿到的提示从「去付款」变成「去登录」，
   * 白跑一趟。
   */
  assertEqual(paymentOrders.claimForLink(pending.orderNo, l.id, { maxUses: 3, viewerId: owner.user.id }).reason,
    'pending', '未支付仍应先报 pending');
  assertEqual(paymentOrders.claimForLink(refunded.orderNo, l.id, { maxUses: 3, viewerId: owner.user.id }).reason,
    'refunded', '已退款仍应先报 refunded（凭证失效与登录无关）');
});

/* ================================================================== *
 * ② HTTP 层：真实路由上的表现
 * ================================================================== */

test('R86-08 · HTTP 未登录提交登录态订单 ⇒ 400 + 「去登录」入口，且不签票据', async () => {
  resetLocal();
  const l = await makePaidLink('http-needlogin.txt');
  const owner = sessionFor('httowner');
  const o = makeOrder(l, { userId: owner.user.id });
  const srv = await serve();
  try {
    const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(r.status, 400, `应停在恢复页（400），实际 ${r.status}`);
    assert(!/sp_.*_pay=/.test(setCookieOf(r)), '绝不能签发支付票据');
    /**
     * ⚠️ 判据必须钉在**按钮本身**，不能只查词：
     *  · `/先去?登录/` 会被提示文案「请**先登录**购买时使用的账号」满足；
     *  · `/\?next=%2Fs%2F/` 会被页头那颗「登录」链接（`.tb-link`）满足。
     * 两者单独用都是假绿 —— 实测「不给按钮」的变异下它们照样全过（fail=0）。
     * 故这里要求 class + href + 文本三者同形。
     */
    assertMatch(r.raw, /<a class="btn primary" href="[^"]*\?next=[^"]*"[^>]*>去登录<\/a>/,
      '必须给出「去登录」**按钮**（class=btn primary 且带 next）');
    assertMatch(r.raw, /恢复购买/, '应停留在恢复购买页');
    assertEqual(countOf(o), 0, 'HTTP 层同样不得消耗额度');
  } finally { await srv.close(); }
});

test('R86-09 · HTTP 换账号提交登录态订单 ⇒ 400 + 「切换账号」入口，且不签票据', async () => {
  resetLocal();
  const l = await makePaidLink('http-wronguser.txt');
  const owner = sessionFor('httbuyer');
  const other = sessionFor('httother');
  const o = makeOrder(l, { userId: owner.user.id });
  const srv = await serve();
  try {
    const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', {
      headers: { Cookie: other.cookie }, body: { orderNo: o.orderNo },
    });
    assertEqual(r.status, 400, `应停在恢复页（400），实际 ${r.status}`);
    assert(!/sp_.*_pay=/.test(setCookieOf(r)), '绝不能签发支付票据');
    /** 同样只认按钮形态：「切换账号」这四个字在提示文案里也出现过 */
    assertMatch(r.raw, /<a class="btn primary" href="[^"]*\?next=[^"]*"[^>]*>切换账号<\/a>/,
      '必须给出「切换账号」**按钮**（class=btn primary 且带 next）');
  } finally { await srv.close(); }
});

test('R86-10 · HTTP 原账号提交登录态订单 ⇒ 303 并签发该链接的支付票据', async () => {
  resetLocal();
  const l = await makePaidLink('http-owner.txt');
  const owner = sessionFor('httreal');
  const o = makeOrder(l, { userId: owner.user.id });
  const srv = await serve();
  try {
    const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', {
      headers: { Cookie: owner.cookie }, body: { orderNo: o.orderNo },
    });
    assertEqual(r.status, 303, `原账号应 303 回分享页，实际 ${r.status}`);
    assertMatch(setCookieOf(r), new RegExp('sp_' + l.id + '_pay='), '必须下发该链接的支付票据');
  } finally { await srv.close(); }
});

test('R86-11 · HTTP 游客订单行为不变：未登录照样 303 签票据（回归保护）', async () => {
  resetLocal();
  const l = await makePaidLink('http-guest.txt');
  const o = makeOrder(l);
  const srv = await serve();
  try {
    const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(r.status, 303, `游客订单必须照旧放行（303），实际 ${r.status}`);
    assertMatch(setCookieOf(r), new RegExp('sp_' + l.id + '_pay='), '必须下发支付票据');
  } finally { await srv.close(); }
});

/* ================================================================== *
 * ③ 计数层 + 页面指引
 * ================================================================== */

test('R86-12 · 归属不符不记「连续输错」：连试超过 maxFails 也不会被封 24 小时', async () => {
  resetLocal();
  await configStore.saveRestore({ maxUses: 3, maxFails: 2 });
  const l = await makePaidLink('http-noban.txt');
  const owner = sessionFor('nobanowner');
  const other = sessionFor('nobanother');
  const o = makeOrder(l, { userId: owner.user.id });
  const srv = await serve();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', {
        headers: { Cookie: other.cookie }, body: { orderNo: o.orderNo },
      });
      assertEqual(r.status, 400,
        `第 ${i + 1} 次归属不符应停在 400（不计连击）；实际 ${r.status} —— 429 说明买主换设备就会被自己锁死`);
    }
    const page = await request(srv.port, 'GET', '/s/' + l.id + '/restore');
    assertEqual(page.status, 200, '连试 3 次（上限 2）后仍不应被封禁');
    assert(!/尝试次数过多/.test(page.raw), '不应出现封禁页');
    /**
     * 反证：计数器没有被整体废掉 —— 真正「不属于本链接」的号仍然记账。
     * 否则 R86-12 会因为「谁都封不了」而假绿。
     */
    const before = restoreGuard.isBanned('127.0.0.1').banned;
    assertEqual(before, false, '前置：此时本机尚未被封');
    for (let i = 0; i < 2; i++) {
      await request(srv.port, 'POST', '/s/' + l.id + '/restore', {
        headers: { Cookie: other.cookie }, body: { orderNo: 'Z'.repeat(13) + 'q'.repeat(23) },
      });
    }
    assertEqual(restoreGuard.isBanned('127.0.0.1').banned, true,
      '不存在的订单号仍必须计入连击并触发封禁（证明计数没有被一并关掉）');
  } finally {
    resetLocal();
    await configStore.saveRestore({ maxUses: 3, maxFails: 5 });
    await srv.close();
  }
});

test('R86-13 · 恢复页一开始就告知新规则：登录态成交的订单须用同一账号取回', async () => {
  resetLocal();
  const l = await makePaidLink('http-copy.txt');
  const srv = await serve();
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id + '/restore');
    assertEqual(r.status, 200, `恢复页应 200，实际 ${r.status}`);
    assertMatch(r.raw, /登录状态/, '页面必须提前说明「登录状态下完成的订单」这一前提');
    assertMatch(r.raw, /同一个账号/, '页面必须说明须用购买时的同一个账号取回');
  } finally { await srv.close(); }
});
