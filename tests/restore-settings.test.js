/**
 * 第六十五轮护栏：系统设置 →「订单取回」（R65）
 *
 * 需求原文（用户口述，逐条对应到下面的用例）：
 *  1、取回次数限制：可设置通过订单号取回下载权限的次数限制；
 *  2、错误尝试次数上限：连续输错多少次，该 IP 就需要 24 小时后再试；
 *  3、这里的封禁**只影响「尝试取回下载权限」**，管理员可在「IP 地址管理」中解封；
 *  4、该卡片不需要开关，默认持久化。
 *
 * 经用户确认的两条口径：
 *  · 「取回次数」按**每个订单号**计（不是按 IP）—— 防的是订单号被转发共用，
 *    而一个用户在多台设备上各取回一次不该被卡住；
 *  · 「输错次数」是**连续**语义 —— 中间成功一次即清零，24 小时没有新失败也清零。
 *
 * ## 分层（每条都指向**实际被执行的那一层**）
 *
 *  ① 配置层 —— `config-store`：缺段补默认、越界收敛、保存是 PATCH、归一化幂等
 *  ② 路由层 —— 真实 `routes/restore.js` + 真实 `requireAdmin`：非法入参 400、非管理员 403
 *  ③ 判定层 —— `payment-orders.claimForLink()` 的配额、`restore-guard` 的连击与封禁
 *  ④ HTTP 层 —— 真实 `share-routes.js`：第 N+1 次不签票据、被封后连表单都不给
 *  ⑤ 隔离层 —— **封禁只拦取回**：同一 IP 的分享页与已付费下载照常（需求 3 的核心）
 *  ⑥ 管理端 —— `GET /ipguard` 带 restoreBans、解封立即生效且仅管理员
 *  ⑦ 前端   —— 卡片位置（站点与用户之间）、无开关、进 ADMIN_ONLY_CARDS、解封按钮存在
 */
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

/**
 * ⚠️ 所有 store 都支持 `S3_DATA_DIR`，必须**先设环境变量再 require**，
 * 否则用例会把配置 / 订单 / 封禁写进项目真实的 data/。
 */
const tmp = makeTempDir('r65-');
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
const restoreGuard = require(SERVER('restore-guard.js'));
const security = require(SERVER('security.js'));
const shareRoutes = require(SERVER('share-routes.js'));
const restoreRoutes = require(SERVER('routes/restore.js'));
const ipguardRoutes = require(SERVER('routes/ipguard.js'));
const { RESTORE_BAN_MS } = require(SERVER('limits.js'));
const fs = require('fs');

/** 起一个本地服务：分享路由 + 两条管理端路由（用 `x-role` 头驱动真实的 requireAdmin） */
async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  // 只有测试会这么干：把「当前用户」从请求头造出来，之后仍走真实的 requireAdmin
  app.use((req, _res, next) => {
    req.authUser = { id: 'u-test', username: 'tester', role: String(req.headers['x-role'] || 'admin') };
    next();
  });
  app.use('/', restoreRoutes);
  app.use('/', ipguardRoutes);
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
async function makePaidLink(key) {
  seq += 1;
  return shareStore.create({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null,
    paid: { required: true, amountFen: 500 }, createdBy: 'tester',
  });
}

/** 造一笔「支付成功」的订单 */
function makeOrder(l) {
  const o = paymentOrders.create({
    linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  });
  paymentOrders.markPaid(o.id);
  return paymentOrders.get(o.id);
}

const setCookieOf = (r) => [].concat(r.headers['set-cookie'] || []).join('\n');
/** 本机在 HTTP 用例里的来源 IP（`security.clientIp` 对 127.0.0.1 的返回值） */
const LOCAL = '127.0.0.1';

/** 每个 HTTP 用例开始前先解封本机，避免上一条用例的封禁串进来 */
function resetLocal() {
  restoreGuard.unban(LOCAL);
  restoreGuard.unban('::1');
  restoreGuard.unban('::ffff:127.0.0.1');
}

/** 设置两个上限（走真实 config-store，落在临时数据目录） */
function setLimits(maxUses, maxFails) {
  return configStore.saveRestore({ maxUses, maxFails });
}

/* ================================================================== *
 * ① 配置层
 * ================================================================== */

test('R65-01 · 配置默认值与归一化：缺段补 3/5、越界收敛、归一化幂等', () => {
  // 直接调归一化（历史配置没有 restore 段的情形）
  const def = configStore.getRestore();
  assertEqual(def.maxUses, 3, '缺失时应补默认「取回 3 次」');
  assertEqual(def.maxFails, 5, '缺失时应补默认「连续输错 5 次」');

  setLimits(0, 0); // 越界：两个下限都是 1
  let v = configStore.getRestore();
  assertEqual(v.maxUses, 1, 'maxUses=0 必须收敛到下限 1（否则所有订单号一秒都用不了）');
  assertEqual(v.maxFails, 1, 'maxFails=0 必须收敛到下限 1（否则第一次手误就封整个出口 IP）');

  setLimits(9999, 9999); // 越界：上限 100 / 50
  v = configStore.getRestore();
  assertEqual(v.maxUses, 100, 'maxUses 上限应为 100');
  assertEqual(v.maxFails, 50, 'maxFails 上限应为 50');

  // 幂等：重复归一化不得改写结果（否则每次读盘都会把 updatedAt 改成新时间）
  const a = configStore.restoreView(configStore.load());
  const b = configStore.restoreView(configStore.load());
  assertEqual(JSON.stringify(a), JSON.stringify(b), '归一化必须是幂等的');
});

test('R65-02 · 保存是严格 PATCH：只给一项时另一项保持原值', () => {
  setLimits(7, 9);
  const afterUses = configStore.saveRestore({ maxUses: 12 });
  assertEqual(afterUses.maxUses, 12, '给出的字段应更新');
  assertEqual(afterUses.maxFails, 9, '未给出的字段必须保持原值');
  const afterFails = configStore.saveRestore({ maxFails: 2 });
  assertEqual(afterFails.maxUses, 12, '未给出的 maxUses 不应被重置');
  assertEqual(afterFails.maxFails, 2, '给出的 maxFails 应更新');
});

/* ================================================================== *
 * ② 路由层：入参校验与权限
 * ================================================================== */

test('R65-03 · 接口：非法入参一律 400（不静默改写），非管理员 403', async () => {
  const srv = await serve();
  try {
    const bad = [
      { body: { maxUses: 0 }, why: 'maxUses=0' },
      { body: { maxUses: 101 }, why: 'maxUses=101' },
      { body: { maxUses: 'abc' }, why: 'maxUses 非数字' },
      { body: { maxFails: 0 }, why: 'maxFails=0' },
      { body: { maxFails: 51 }, why: 'maxFails=51' },
      { body: { maxFails: '' }, why: 'maxFails 空串' },
    ];
    for (const c of bad) {
      const r = await request(srv.port, 'PUT', '/restore/config', { body: c.body });
      assertEqual(r.status, 400, `${c.why} 必须被拒绝（400），实际 ${r.status}`);
      assert(r.json && r.json.error, `${c.why} 应给出可读原因`);
    }

    // 合法值：保存成功并回视图
    const ok = await request(srv.port, 'PUT', '/restore/config', { body: { maxUses: 4, maxFails: 6 } });
    assertEqual(ok.status, 200, '合法入参应 200');
    assertEqual(ok.json.maxUses, 4, '返回视图应带新的 maxUses');
    assertEqual(ok.json.maxFails, 6, '返回视图应带新的 maxFails');
    const got = await request(srv.port, 'GET', '/restore/config');
    assertEqual(got.json.maxUses, 4, 'GET 应读回刚保存的值');

    // 权限：普通用户读 / 写都 403（含 GET —— 它暴露的是站点的防护强度）
    for (const m of ['GET', 'PUT']) {
      const r = await request(srv.port, m, '/restore/config', {
        headers: { 'x-role': 'user' }, body: m === 'PUT' ? { maxUses: 9 } : null,
      });
      assertEqual(r.status, 403, `普通用户 ${m} /restore/config 必须 403，实际 ${r.status}`);
    }
    assertEqual(configStore.getRestore().maxUses, 4, '被拒的写入不得改动配置');
  } finally { await srv.close(); }
});

/* ================================================================== *
 * ③ 判定层：配额与连击（纯函数，不经过 HTTP）
 * ================================================================== */

test('R65-04 · 取回次数上限按**订单号**计：第 N+1 次拒绝且不计入新订单', async () => {
  setLimits(2, 50);
  const l = await makePaidLink('quota.txt');
  const other = await makePaidLink('quota-other.txt');
  const o = makeOrder(l);
  const o2 = makeOrder(other);

  const c1 = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2 });
  assertEqual(c1.ok, true, '第 1 次应放行');
  const c2 = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2 });
  assertEqual(c2.ok, true, '第 2 次应放行');
  const c3 = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 2 });
  assertEqual(c3.ok, false, '第 3 次必须被拒');
  assertEqual(c3.reason, 'used_up', `拒绝原因应为 used_up，实际 ${c3.reason}`);
  assertMatch(c3.message, /取回次数上限（2 次）/, '文案应写明上限，便于售后解释');

  // 计数落在订单上（供订单详情 / 排障核对），且只对**这一笔**生效
  assertEqual(paymentOrders.get(o.id).restoreCount, 2, '成功两次后 restoreCount 应为 2');
  assertEqual(paymentOrders.get(o2.id).restoreCount, 0, '别的订单不应受影响');
  const c4 = paymentOrders.claimForLink(o2.orderNo, other.id, { maxUses: 2 });
  assertEqual(c4.ok, true, '另一笔订单的第 1 次应放行');

  // 上限为「不限制」时（maxUses 非正数）不做配额判定 —— 调用方不会这么传，
  // 但判据本身必须是显式的一条，而不是靠「0 恰好让 used >= 0 成立」的巧合
  const noLimit = paymentOrders.claimForLink(o.orderNo, l.id, { maxUses: 0 });
  assertEqual(noLimit.ok, true, 'maxUses=0 表示不限制（内部口径），不应因配额被拒');
});

test('R65-05 · 连续输错达上限即封 24 小时；封禁自动过期，且解封可提前', () => {
  const ip = '203.0.113.9';
  restoreGuard.unban(ip);
  const t0 = Date.parse('2026-10-20T00:00:00.000Z');
  // 上限 3：前两次只计数，第 3 次触发封禁
  assertEqual(restoreGuard.noteFail(ip, 3, t0).banned, false, '第 1 次不应封');
  assertEqual(restoreGuard.noteFail(ip, 3, t0 + 1000).banned, false, '第 2 次不应封');
  const third = restoreGuard.noteFail(ip, 3, t0 + 2000);
  assertEqual(third.banned, true, '第 3 次应触发封禁');
  assertEqual(third.justBanned, true, '应标记为「本次刚封」以便写审计日志');

  const ban = restoreGuard.isBanned(ip, t0 + 3000);
  assertEqual(ban.banned, true, '封禁期内应判定为受限');
  assert(ban.retryAfter > RESTORE_BAN_MS / 1000 - 10 && ban.retryAfter <= RESTORE_BAN_MS / 1000,
    `Retry-After 应约等于 24 小时，实际 ${ban.retryAfter}`);
  assertEqual(restoreGuard.listBans(t0 + 3000).length, 1, '管理端列表应能看到它');
  assertEqual(ban.until, new Date(t0 + 2000 + RESTORE_BAN_MS).toISOString(), '到期时间应为触发时刻 + 24 小时');

  // 23 小时后仍在封禁期内
  assertEqual(restoreGuard.isBanned(ip, t0 + 23 * 3600 * 1000).banned, true, '23 小时后仍在封禁期内');
  // 24 小时后自动解除（且列表里也不该再出现）
  assertEqual(restoreGuard.isBanned(ip, t0 + RESTORE_BAN_MS + 5000).banned, false, '24 小时后应自动解除');
  assertEqual(restoreGuard.listBans(t0 + RESTORE_BAN_MS + 5000).length, 0, '过期项应从列表里消失');

  // 手工解封立即生效
  restoreGuard.noteFail(ip, 1, t0 + 10);
  assertEqual(restoreGuard.isBanned(ip, t0 + 20).banned, true, '前置：已封');
  assertEqual(restoreGuard.unban(ip), true, '解封应返回 true');
  assertEqual(restoreGuard.isBanned(ip, t0 + 30).banned, false, '解封后应立即放行');
  assertEqual(restoreGuard.unban(ip), false, '再次解封应返回 false（本来就没封）');
});

test('R65-06 · 「连续」语义：成功一次即清零；24 小时无新失败也清零', () => {
  const ip = '203.0.113.10';
  restoreGuard.unban(ip);
  const t0 = Date.parse('2026-10-21T00:00:00.000Z');
  restoreGuard.noteFail(ip, 3, t0);
  restoreGuard.noteFail(ip, 3, t0 + 1000);
  restoreGuard.noteSuccess(ip); // 中间成功一次
  assertEqual(restoreGuard.noteFail(ip, 3, t0 + 2000).banned, false, '清零后第 1 次不应封');
  assertEqual(restoreGuard.noteFail(ip, 3, t0 + 3000).banned, false, '清零后第 2 次不应封');

  // 空闲窗口：隔了 24 小时以上的两次手误不该累计
  const ip2 = '203.0.113.11';
  restoreGuard.unban(ip2);
  restoreGuard.noteFail(ip2, 2, t0);
  const later = restoreGuard.noteFail(ip2, 2, t0 + 25 * 3600 * 1000);
  assertEqual(later.banned, false, '间隔超过 24 小时应重新计数（否则零散手误迟早攒成封禁）');
  assertEqual(later.fails, 1, '重新计数后应回到 1');
  restoreGuard.unban(ip2);
});

/* ================================================================== *
 * ④ HTTP 层：配额与封禁真的落在取回端点上
 * ================================================================== */

test('R65-07 · 取回端点上：第 N+1 次拒绝且不签票据；被封后连表单都不给', async () => {
  setLimits(1, 3);
  resetLocal();
  const l = await makePaidLink('dl-quota.txt');
  const o = makeOrder(l);
  const srv = await serve();
  try {
    const first = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(first.status, 303, `第 1 次应成功（303），实际 ${first.status}`);
    assertMatch(setCookieOf(first), new RegExp('sp_' + l.id + '_pay='), '第 1 次应签发票据');

    const second = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(second.status, 400, `第 2 次应被拒（400），实际 ${second.status}`);
    assert(!new RegExp('sp_' + l.id + '_pay=').test(setCookieOf(second)), '被拒时绝不能签发票据');
    assertMatch(second.raw, /取回次数上限（1 次）/, '页面要说明是次数用尽而不是订单号错了');

    // 连续输错 3 次（上限 3）→ 封禁；此后连 GET 页面都不再给表单
    for (let i = 0; i < 3; i++) {
      const r = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: 'A'.repeat(40) } });
      assertEqual(r.status, 400, '形状不对的订单号也应计入连续输错');
    }
    const blockedGet = await request(srv.port, 'GET', '/s/' + l.id + '/restore');
    assertEqual(blockedGet.status, 429, `被封后 GET 取回页应 429，实际 ${blockedGet.status}`);
    assertMatch(blockedGet.raw, /尝试次数过多/, '应说明被限制的原因');
    assert(!/name="orderNo"/.test(blockedGet.raw), '被封时不应再渲染输入表单（否则只会一直重试）');

    const blockedPost = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(blockedPost.status, 429, '被封后即便提交**正确**的订单号也不得放行');
    assert(!new RegExp('sp_' + l.id + '_pay=').test(setCookieOf(blockedPost)), '被封时不得签发票据');
  } finally { await srv.close(); resetLocal(); }
});

/* ================================================================== *
 * ⑤ 隔离层：封禁只拦「取回」（需求 3 的核心）
 * ================================================================== */

test('R65-08 · 封禁只影响「取回」：同一 IP 的分享页浏览与已付费下载照常', async () => {
  setLimits(5, 2);
  resetLocal();
  const l = await makePaidLink('dl-ok.txt');
  const o = makeOrder(l);
  const srv = await serve();
  try {
    // 先正常取回拿到票据（这一步也验证了「不受影响的正常路径」）
    const ok = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(ok.status, 303, '前置：应能取回');
    const cookie = 'sp_' + l.id + '_pay=' + (/sp_[^=]+_pay=([^;]+)/.exec(setCookieOf(ok)) || [])[1];

    // 连续输错 2 次（上限 2）→ 本机被封
    for (let i = 0; i < 2; i++) {
      await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: 'B'.repeat(40) } });
    }
    assertEqual(restoreGuard.isBanned(LOCAL).banned, true, '前置：本机应已被限制取回');

    // 但分享页、已付费页面、下载探测都必须照常 —— 封禁只拦「尝试取回」这一件事
    const page = await request(srv.port, 'GET', '/s/' + l.id, { headers: { Cookie: cookie } });
    assertEqual(page.status, 200, '被封期间分享页仍应 200');
    assertMatch(page.raw, /支付已完成，可直接下载/, '已付费页面不应受封禁影响');

    const head = await request(srv.port, 'HEAD', '/s/' + l.id + '/dl', { headers: { Cookie: cookie } });
    assertEqual(head.status, 200, '被封期间已付费的下载探测仍应 200');

    const dl = await request(srv.port, 'GET', '/s/' + l.id + '/dl', { headers: { Cookie: cookie } });
    assertEqual(dl.status, 200, `被封期间已付费下载仍应 200，实际 ${dl.status}`);
    assertEqual(dl.raw, 'hello', '下载内容应正常（不是错误页）');

    // 而取回端点本身仍拒绝
    const again = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(again.status, 429, '取回端点仍应保持拒绝');
  } finally { await srv.close(); resetLocal(); }
});

/* ================================================================== *
 * ⑥ 管理端：IP 地址管理里的解封
 * ================================================================== */

test('R65-09 · IP 地址管理：GET /ipguard 带封禁列表；解封立即生效且仅管理员可用', async () => {
  setLimits(5, 1);
  resetLocal();
  const l = await makePaidLink('dl-unban.txt');
  const o = makeOrder(l);
  const srv = await serve();
  try {
    await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: 'C'.repeat(40) } });
    assertEqual(restoreGuard.isBanned(LOCAL).banned, true, '前置：应已封禁');

    const v = await request(srv.port, 'GET', '/ipguard');
    assertEqual(v.status, 200, '管理员应能读规则视图');
    assert(Array.isArray(v.json.restoreBans), '视图应带 restoreBans 数组（管理端要展示与解封）');
    assertEqual(v.json.restoreBans.length, 1, `应有 1 条封禁，实际 ${v.json.restoreBans.length}`);
    assertEqual(v.json.restoreBans[0].fails, 1, '应记录连续输错次数');
    assert(v.json.restoreBans[0].until, '应给出自动解封时间');

    // 普通用户既看不到、也不能解封
    const asUser = await request(srv.port, 'GET', '/ipguard', { headers: { 'x-role': 'user' } });
    assertEqual(asUser.status, 403, '普通用户不得读取封禁列表');
    const unbanAsUser = await request(srv.port, 'POST', '/ipguard/restore-bans/unban', {
      headers: { 'x-role': 'user' }, body: { ip: LOCAL },
    });
    assertEqual(unbanAsUser.status, 403, '普通用户不得解封');

    // 管理员解封：立即生效，取回恢复可用
    const un = await request(srv.port, 'POST', '/ipguard/restore-bans/unban', { body: { ip: LOCAL } });
    assertEqual(un.status, 200, '管理员解封应 200');
    assertEqual(un.json.removed, true, '应报告「确实删掉了一条」');
    assertEqual(un.json.restoreBans.length, 0, '解封后列表应为空');
    assertEqual(restoreGuard.isBanned(LOCAL).banned, false, '解封后应立即放行');

    const retry = await request(srv.port, 'POST', '/s/' + l.id + '/restore', { body: { orderNo: o.orderNo } });
    assertEqual(retry.status, 303, `解封后应能正常取回，实际 ${retry.status}`);

    // 再解一次：没人被封时应如实回 removed:false（界面据此提示「当前未被限制」）
    const again = await request(srv.port, 'POST', '/ipguard/restore-bans/unban', { body: { ip: '198.51.100.7' } });
    assertEqual(again.json.removed, false, '未被封的地址应回 removed:false');
    // 缺 ip 的入参当场 400
    const noIp = await request(srv.port, 'POST', '/ipguard/restore-bans/unban', { body: {} });
    assertEqual(noIp.status, 400, '缺 ip 应 400');
  } finally { await srv.close(); resetLocal(); }
});

/* ================================================================== *
 * ⑦ 前端与静态：卡片位置、无开关、管理员专属、解封入口
 * ================================================================== */

test('R65-10 · 前端：卡片位于「站点设置」与「用户管理」之间、无开关、进管理员清单', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const site = html.indexOf('id="sysset-site-card"');
  const restore = html.indexOf('id="sysset-restore-card"');
  const user = html.indexOf('id="sysset-user-card"');
  assert(site > 0 && restore > 0 && user > 0, '三张卡片都应存在');
  assert(site < restore && restore < user,
    '「订单取回」必须排在「站点设置」与「用户管理」之间（需求原文：在两者之间新增）');

  // 需求 4：没有开关 —— 卡片内不得出现开关控件（ip-switch / checkbox / "启用"按钮）
  const block = html.slice(restore, user);
  assert(!/ip-switch/.test(block), '该卡片不应有启用开关');
  assert(!/<input[^>]+type="checkbox"/.test(block), '该卡片不应有勾选框（需求：不需要开关）');
  assert(/id="restore-max-uses"/.test(block), '缺少「取回次数限制」输入框');
  assert(/id="restore-max-fails"/.test(block), '缺少「错误尝试次数上限」输入框');
  assertMatch(block, /24 小时/, '界面要写明封禁时长');
  assertMatch(block, /IP 地址管理/, '界面要告诉用户去哪儿解封');

  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'syssettings.js'), 'utf8');
  assertMatch(js, /'sysset-restore-card'/, '卡片必须登记进 ADMIN_ONLY_CARDS（普通用户整卡隐藏）');
  assertMatch(js, /btn-restore-save/, '保存按钮必须接线');
  // 没有开关 = 没有「启用 / 停用」这条写路径；配置里也不该出现 enabled 字段
  assertMatch(js, /saveRestoreConfig\(\{ maxUses: uses\.value, maxFails: fails\.value \}\)/,
    '保存体只应含两个上限，不得夹带 enabled');

  // IP 地址管理：第三张卡片 + 解封按钮
  assert(/id="iprestore-card"/.test(html), 'IP 地址管理应新增「订单取回封禁」卡片');
  assert(/id="iprestore-table"/.test(html), '应提供封禁列表容器');
  const ipjs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ipmgr.js'), 'utf8');
  assertMatch(ipjs, /unbanRestore/, '解封按钮必须真的调用接口');
  assertMatch(ipjs, /d\.restoreBans/, '列表数据应来自 GET /ipguard 的 restoreBans');
});
