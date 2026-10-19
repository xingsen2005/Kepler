/**
 * 第六十二轮护栏：优惠券（R62）
 *
 * 需求原文（六条，其中 1~3 属「设置」，4~8 属「使用」）：
 *  1、用户可单独或批量生成优惠券；
 *  2、可设置优惠券类型限制：无门槛、限特定链接、限特定用户；
 *  3、可设置优惠券使用限制：次数（总次数、是否为每个用户只能使用一次）、时间（开始和到期时间）；
 *  4、付费链接分享页应添加优惠券码填写处；
 *  5、使用优惠券后价格显示为「原价划线变灰 + 优惠价突出」；
 *  6、优惠券无效则弹出相应提示；
 *  7、订单管理的付费订单页添加原价、应付、优惠、实付、使用的优惠券；
 *  8、退款时若优惠券不是无门槛，则设为「对该用户可重新使用」。
 *
 * 分层与落点（每条都指向**实际执行的那一层**）：
 *  ① 判据层 —— `limits.js` 的解析器（非法输入必须 400，不静默归一）
 *  ② 存储层 —— 生成 / 状态优先级 / 适用范围 / 次数 / 时间 / 价格封顶 / 核销与回退
 *  ③ 关系层 —— 订单快照（原价 · 优惠 · 券码），历史订单的回退口径
 *  ④ 接线层 —— 路由（全部管理员）、退款回退、分享页渲染与下单快照
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r62-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readServer = (n) => fs.readFileSync(SERVER(n), 'utf8');

const limits = require(SERVER('limits.js'));
const couponStore = require(SERVER('coupon-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));

const BASE_LINK = { id: 'L1', paid: { required: true, amountFen: 1200 } };

/** 造一张券（直接走 store，绕开路由；路由的入参判据单独测） */
let seq = 0;
function makeCoupon(patch) {
  seq += 1;
  const made = couponStore.generate(Object.assign({
    count: 1,
    type: 'any',
    linkIds: [],
    userIds: [],
    amountFen: 500,
    maxUses: 0,
    perUserOnce: false,
    startAt: null,
    expireAt: null,
    note: `t${seq}`,
    createdBy: 'tester',
  }, patch || {}));
  return made[0];
}

/* ================================================================== *
 * ① 判据层
 * ================================================================== */

test('R62-1 · 券码归一化与入参判据（非法一律报错，不静默归一）', () => {
  assertEqual(limits.normalizeCouponCode(' ab cd ef gh jk '), 'ABCDEFGHJK');
  assertEqual(limits.parseCouponCodeInput('ab cd ef gh jk').value, 'ABCDEFGHJK', '空白应被去掉并转大写');
  assertEqual(limits.parseCouponCodeInput('AB\nCD').ok, false, '含换行必须显式拒绝（粘贴脏数据不能变成一次查询）');
  assertEqual(limits.parseCouponCodeInput('ABC').ok, false, '长度不足必须拒绝');

  assertEqual(limits.parseCouponCountInput(1).value, 1, '1 = 单独生成');
  assertEqual(limits.parseCouponCountInput(200).ok, true);
  assertEqual(limits.parseCouponCountInput(201).ok, false, '超过批量上限必须报错');
  assertEqual(limits.parseCouponCountInput(0).ok, false);

  assertEqual(limits.parseCouponAmountInput('1.23').value, 123, '元 → 分必须四舍五入成整数');
  assertEqual(limits.parseCouponAmountInput(0).ok, false, '0 元券不允许（网关不接受 0 元订单）');
  assertEqual(limits.parseCouponAmountInput('abc').ok, false);

  assertEqual(limits.parseCouponMaxUsesInput(0).value, 0, '0 = 不限制');
  assertEqual(limits.parseCouponMaxUsesInput(-1).ok, false, '负数必须拒绝 —— 落盘会把 -1 归成 0（放开限制）');

  assertEqual(limits.parseCouponTimeInput('', '到期时间').value, null, '留空 = 永久有效');
  assertEqual(limits.parseCouponTimeInput(Date.now() - 1000, '到期时间').ok, false,
    '到期时间在当前之前必须拒绝（否则是一张出生即失效的券）');
  assertEqual(limits.parseCouponTimeInput(Date.now() - 1000, '开始时间').ok, true,
    '开始时间允许是过去（「立即生效」的正常写法）');

  assertEqual(limits.parseCouponIdsInput([], '分享链接').ok, false, '限链接却没有链接必须拒绝');
  assertEqual(limits.parseCouponIdsInput(['a', 'a', 'b'], '分享链接').value.join(','), 'a,b', '必须去重');
});

/* ================================================================== *
 * ② 存储层
 * ================================================================== */

test('R62-2 · 生成：单独 / 批量、类型与目标集合', () => {
  const one = couponStore.generate({
    count: 1, type: 'links', linkIds: ['L1', 'L2'], amountFen: 300,
    maxUses: 2, perUserOnce: true, note: 'single', createdBy: 'admin',
  });
  assertEqual(one.length, 1, 'count=1 即「单独生成」');
  assertEqual(one[0].type, 'links');
  assertEqual(one[0].linkIds.join(','), 'L1,L2');
  assertEqual(one[0].userIds.length, 0, '限链接时不得残留用户目标');
  assertEqual(one[0].amountFen, 300);
  assertEqual(one[0].maxUses, 2);
  assertEqual(one[0].perUserOnce, true);
  assertEqual(one[0].status, 'active');

  const many = couponStore.generate({
    count: 5, type: 'any', amountFen: 100, createdBy: 'admin',
  });
  assertEqual(many.length, 5, 'count=N 即「批量生成」');
  const codes = new Set(many.map((c) => c.code));
  assertEqual(codes.size, 5, '同一批内券码不得重复');
  assertMatch(many[0].code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/, '券码必须是 10 位无歧义字符');
});

test('R62-3 · 状态优先级：停用 > 未开始 > 已过期 > 已用尽 > 有效', () => {
  const now = Date.now();
  const c = makeCoupon({ maxUses: 1 });
  assertEqual(couponStore.status(couponStore.get(c.id)), 'active');

  // 已用尽
  couponStore.consume({ couponId: c.id, identity: 'u:x', orderId: 'O-' + c.id });
  assertEqual(couponStore.status(couponStore.get(c.id)), 'used_up');

  // 停用：即使已用尽，也必须显示「已停用」（管理员刚做的动作最需要被看到）
  const off = couponStore.update(c.id, { disabled: true });
  assertEqual(off.status, 'disabled');

  // 未开始 > 已过期：脏配置（开始在未来、到期也已过）应报「未开始」
  const dirty = makeCoupon({ startAt: new Date(now + 3600e3).toISOString(), expireAt: new Date(now - 3600e3).toISOString() });
  assertEqual(couponStore.status(couponStore.get(dirty.id)), 'not_started');

  const expired = makeCoupon({ expireAt: new Date(now - 1000).toISOString() });
  assertEqual(couponStore.status(couponStore.get(expired.id)), 'expired');
});

test('R62-4 · 适用范围：无门槛 / 限特定链接 / 限特定用户', () => {
  const any = makeCoupon({ type: 'any' });
  assertEqual(couponStore.validateForUse({ code: any.code, link: BASE_LINK, identity: 'a:1', userId: '' }).ok, true,
    '无门槛券对任何链接、任何身份都可用');

  const links = makeCoupon({ type: 'links', linkIds: ['L1'] });
  assertEqual(couponStore.validateForUse({ code: links.code, link: BASE_LINK, identity: 'a:1', userId: '' }).ok, true);
  const wrongLink = couponStore.validateForUse({ code: links.code, link: { id: 'L9', paid: { required: true, amountFen: 1200 } }, identity: 'a:1', userId: '' });
  assertEqual(wrongLink.ok, false);
  assertEqual(wrongLink.reason, 'wrong_link');

  const users = makeCoupon({ type: 'users', userIds: ['u1'] });
  assertEqual(couponStore.validateForUse({ code: users.code, link: BASE_LINK, identity: 'a:1', userId: '' }).reason,
    'wrong_user', '未登录访客不能使用「限特定用户」的券（无从确认身份）');
  assertEqual(couponStore.validateForUse({ code: users.code, link: BASE_LINK, identity: 'u:u2', userId: 'u2' }).reason,
    'wrong_user', '不在名单里的账号同样不可用');
  assertEqual(couponStore.validateForUse({ code: users.code, link: BASE_LINK, identity: 'u:u1', userId: 'u1' }).ok, true);
});

test('R62-5 · 总次数与「每个用户只能使用一次」', () => {
  const total = makeCoupon({ maxUses: 1 });
  assertEqual(couponStore.validateForUse({ code: total.code, link: BASE_LINK, identity: 'u:a', userId: 'a' }).ok, true);
  couponStore.consume({ couponId: total.id, identity: 'u:a', orderId: 'O-total' });
  assertEqual(couponStore.validateForUse({ code: total.code, link: BASE_LINK, identity: 'u:b', userId: 'b' }).reason,
    'used_up', '总次数用尽后任何人都不能用（不只是用过的那个人）');

  const once = makeCoupon({ perUserOnce: true, maxUses: 0 });
  assertEqual(couponStore.validateForUse({ code: once.code, link: BASE_LINK, identity: 'u:a', userId: 'a' }).ok, true);
  couponStore.consume({ couponId: once.id, identity: 'u:a', orderId: 'O-once' });
  assertEqual(couponStore.validateForUse({ code: once.code, link: BASE_LINK, identity: 'u:a', userId: 'a' }).reason,
    'already_used', '同一用户第二次必须被拒');
  assertEqual(couponStore.validateForUse({ code: once.code, link: BASE_LINK, identity: 'u:b', userId: 'b' }).ok, true,
    '「每人一次」不影响别的用户');
});

test('R62-6 · 时间窗口：未开始 / 已过期各给对应原因', () => {
  const now = Date.now();
  const future = makeCoupon({ startAt: new Date(now + 3600e3).toISOString() });
  assertEqual(couponStore.validateForUse({ code: future.code, link: BASE_LINK, identity: 'a:1', userId: '' }).reason,
    'not_started');
  const past = makeCoupon({ startAt: new Date(now - 7200e3).toISOString(), expireAt: new Date(now - 3600e3).toISOString() });
  assertEqual(couponStore.validateForUse({ code: past.code, link: BASE_LINK, identity: 'a:1', userId: '' }).reason,
    'expired');
});

test('R62-7 · 价格计算：优惠封顶到「原价 − 1 分」，应付永不为 0', () => {
  assertEqual(couponStore.computePayable(1200, 500).payableFen, 700, '12 元 − 5 元 = 7 元');
  assertEqual(couponStore.computePayable(300, 500).payableFen, 1,
    '券面额大于原价时必须封顶（网关不接受 0 元订单）');
  assertEqual(couponStore.computePayable(300, 500).discountFen, 299,
    '「优惠」列显示的是这笔订单上真的减掉的钱，不是券面额');
  const r = couponStore.validateForUse({ code: makeCoupon({ amountFen: 5000 }).code, link: BASE_LINK, identity: 'a:1', userId: '' });
  assertEqual(r.payableFen, 1);
  assertEqual(r.discountFen, 1199);
  assertEqual(r.originalFen, 1200);
});

test('R62-8 · 核销按订单幂等；按订单回退后该用户可重新使用', () => {
  const c = makeCoupon({ perUserOnce: true, maxUses: 0 });
  couponStore.consume({ couponId: c.id, identity: 'u:a', orderId: 'O1' });
  couponStore.consume({ couponId: c.id, identity: 'u:a', orderId: 'O1' });
  assertEqual(couponStore.get(c.id).used, 1, '同一订单重复核销不得重复计数');
  assertEqual(couponStore.validateForUse({ code: c.code, link: BASE_LINK, identity: 'u:a', userId: 'a' }).reason,
    'already_used');

  const rel = couponStore.releaseByOrder('O1');
  assertEqual(rel.couponId, c.id);
  assertEqual(couponStore.get(c.id).used, 0);
  assertEqual(couponStore.validateForUse({ code: c.code, link: BASE_LINK, identity: 'u:a', userId: 'a' }).ok, true,
    '回退后同一用户可重新使用');
  assertEqual(couponStore.releaseByOrder('O1'), null, '回退必须幂等（找不到就返回 null）');
});

test('R62-9 · 身份：登录用户按账号，匿名按 IP+UA 近似且稳定', () => {
  assertEqual(couponStore.identityFrom({ userId: 'u1' }), 'u:u1');
  const a1 = couponStore.identityFrom({ ip: '1.2.3.4', userAgent: 'UA' });
  const a2 = couponStore.identityFrom({ ip: '1.2.3.4', userAgent: 'UA' });
  const b = couponStore.identityFrom({ ip: '1.2.3.5', userAgent: 'UA' });
  assertMatch(a1, /^a:[0-9a-f]{32}$/);
  assertEqual(a1, a2, '同一 IP+UA 必须得到同一身份（否则「每人一次」形同虚设）');
  assert(a1 !== b, '换出口 IP 视为不同身份（这是刻意的近似，已在界面上说明）');
});

/* ================================================================== *
 * ③ 关系层：订单快照
 * ================================================================== */

test('R62-10 · 订单快照：原价 / 优惠 / 实付 / 券码，历史订单回退口径正确', () => {
  const o = paymentOrders.create({
    linkId: 'L1', platform: 'alipay', amountFen: 700, originalFen: 1200, discountFen: 500,
    couponCode: 'ABCDEFGHJK', couponId: 'cid', couponType: 'links',
    fileName: 'a.txt', fileKey: 'k', bucket: 'b',
  });
  const v = paymentOrders.view(o);
  assertEqual(v.originalFen, 1200);
  assertEqual(v.discountFen, 500);
  assertEqual(v.amountFen, 700);
  assertEqual(v.originalFen - v.discountFen, v.amountFen, '原价 − 优惠 必须等于应付');
  assertEqual(v.couponCode, 'ABCDEFGHJK');
  assertEqual(v.couponType, 'links');

  const legacy = { id: 'old', linkId: 'L1', platform: '', amountFen: 900, currency: 'CNY', status: 'paid' };
  const lv = paymentOrders.view(legacy);
  assertEqual(lv.originalFen, 900, '历史订单没有 originalFen ⇒ 回退为实付金额');
  assertEqual(lv.discountFen, 0);
  assertEqual(lv.couponCode, '');
});

/* ================================================================== *
 * ④ 接线层：路由 / 退款回退 / 分享页
 * ================================================================== */

const express = require(path.join(ROOT, 'node_modules', 'express'));

async function serve(routes, auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.authUser = auth; next(); });
  app.use('/api', require(SERVER('routes', routes)));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: s.address().port,
    close: () => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    },
  };
}

const ADMIN = { username: 'admin', role: 'admin' };
const USER = { username: 'u', role: 'user' };

test('R62-11 · 路由：五条接口全部仅管理员', async () => {
  for (const auth of [null, USER]) {
    const s = await serve('coupon.js', auth);
    try {
      for (const [m, p, body] of [
        ['GET', '/api/coupons', null],
        ['POST', '/api/coupons', { count: 1, amount: 1 }],
        ['POST', '/api/coupons/bulk', { ids: ['x'], disabled: true }],
        ['POST', '/api/coupons/delete', { ids: ['x'] }],
        ['PUT', '/api/coupons/x', { disabled: true }],
      ]) {
        const r = await request(s.port, m, p, body ? { body } : {});
        assertEqual(r.status, 403, `${m} ${p} 未授权必须 403（实际 ${r.status}）`);
      }
    } finally {
      s.close();
    }
  }
});

test('R62-12 · 路由：生成校验与成功路径', async () => {
  const s = await serve('coupon.js', ADMIN);
  try {
    // 限链接却没给链接 → 400（不能生成一张「谁都不可用」的券）
    let r = await request(s.port, 'POST', '/api/coupons', { body: { count: 1, type: 'links', amount: 1 } });
    assertEqual(r.status, 400);
    assertMatch(r.json.error, /分享链接/);

    // 金额 0 → 400
    r = await request(s.port, 'POST', '/api/coupons', { body: { count: 1, type: 'any', amount: 0 } });
    assertEqual(r.status, 400);

    // 到期时间在过去 → 400
    r = await request(s.port, 'POST', '/api/coupons', {
      body: { count: 1, type: 'any', amount: 1, expireAt: new Date(Date.now() - 1000).toISOString() },
    });
    assertEqual(r.status, 400);
    assertMatch(r.json.error, /晚于当前时间/);

    // 开始 >= 到期 → 400
    r = await request(s.port, 'POST', '/api/coupons', {
      body: {
        count: 1, type: 'any', amount: 1,
        startAt: new Date(Date.now() + 7200e3).toISOString(),
        expireAt: new Date(Date.now() + 3600e3).toISOString(),
      },
    });
    assertEqual(r.status, 400);
    assertMatch(r.json.error, /早于到期时间/);

    // 成功：单独生成 1 张
    r = await request(s.port, 'POST', '/api/coupons', {
      body: { count: 1, type: 'any', amount: 2.5, maxUses: 3, perUserOnce: true, note: '工单' },
    });
    assertEqual(r.status, 200);
    assertEqual((r.json.coupons || []).length, 1);
    assertEqual(r.json.coupons[0].amountFen, 250);
    assertEqual(r.json.coupons[0].perUserOnce, true);

    // 列表能读到（明文券码，管理员要分发）
    const list = await request(s.port, 'GET', '/api/coupons');
    assertEqual(list.status, 200);
    assert((list.json.coupons || []).length >= 1);
  } finally {
    s.close();
  }
});

test('R62-13 · 路由：批量停用 / 启用 / 删除（PATCH 语义）', async () => {
  const s = await serve('coupon.js', ADMIN);
  try {
    const gen = await request(s.port, 'POST', '/api/coupons', { body: { count: 2, type: 'any', amount: 1 } });
    const ids = gen.json.coupons.map((c) => c.id);

    let r = await request(s.port, 'POST', '/api/coupons/bulk', { body: { ids, disabled: true } });
    assertEqual(r.status, 200);
    assertEqual(r.json.updated, 2);
    assert(ids.every((id) => couponStore.get(id).disabled === true));

    // disabled:false 是合法值（重新启用）—— 不能因为「假值」被跳过
    r = await request(s.port, 'POST', '/api/coupons/bulk', { body: { ids, disabled: false } });
    assertEqual(r.json.updated, 2);
    assert(ids.every((id) => couponStore.get(id).disabled === false));

    r = await request(s.port, 'POST', '/api/coupons/delete', { body: { ids } });
    assertEqual(r.status, 200);
    assertEqual(r.json.removed, 2);
    assert(ids.every((id) => couponStore.get(id) === null));
  } finally {
    s.close();
  }
});

test('R62-14 · 退款：只有「非无门槛」的券才恢复该用户可重新使用（需求 8）', async () => {
  const s = await serve('payment.js', ADMIN);
  try {
    const link = couponStore.generate({
      count: 1, type: 'links', linkIds: ['L-refund'], amountFen: 200, perUserOnce: true, createdBy: 'admin',
    })[0];
    const any = couponStore.generate({
      count: 1, type: 'any', amountFen: 200, perUserOnce: true, createdBy: 'admin',
    })[0];

    const order1 = paymentOrders.create({
      linkId: 'L-refund', platform: 'alipay', amountFen: 1000, originalFen: 1200, discountFen: 200,
      couponCode: link.code, couponId: link.id, couponType: 'links', fileName: 'a', fileKey: 'k', bucket: 'b',
    });
    couponStore.consume({ couponId: link.id, identity: 'u:buyer', orderId: order1.id });
    paymentOrders.markPaid(order1.id);

    const order2 = paymentOrders.create({
      linkId: 'L-refund', platform: 'alipay', amountFen: 1000, originalFen: 1200, discountFen: 200,
      couponCode: any.code, couponId: any.id, couponType: 'any', fileName: 'a', fileKey: 'k', bucket: 'b',
    });
    couponStore.consume({ couponId: any.id, identity: 'u:buyer', orderId: order2.id });
    paymentOrders.markPaid(order2.id);

    const before = couponStore.validateForUse({ code: link.code, link: { id: 'L-refund', paid: { amountFen: 1200 } }, identity: 'u:buyer', userId: 'buyer' });
    assertEqual(before.reason, 'already_used');

    const r = await request(s.port, 'POST', `/api/payment/orders/${order1.id}/refund`, { body: {} });
    assertEqual(r.status, 200);

    assertEqual(couponStore.validateForUse({ code: link.code, link: { id: 'L-refund', paid: { amountFen: 1200 } }, identity: 'u:buyer', userId: 'buyer' }).ok,
      true, '「限链接」券退款后，该用户必须可以重新使用');

    // 无门槛券：按需求原文不回退（它面向所有人，一次核销不随某个人的退款返还）
    await request(s.port, 'POST', `/api/payment/orders/${order2.id}/refund`, { body: {} });
    assertEqual(couponStore.validateForUse({ code: any.code, link: { id: 'L-refund', paid: { amountFen: 1200 } }, identity: 'u:buyer', userId: 'buyer' }).reason,
      'already_used', '无门槛券不回退 —— 这是需求 8 的明确口径');
  } finally {
    s.close();
  }
});

test('R62-15 · 分享页接线：券码入口 + 原价划线 + 下单带优惠快照（静态判据）', () => {
  const src = readServer('share-routes.js');

  // 需求 4：付费页必须有券码填写处（独立表单，不能嵌进支付表单）
  assertMatch(src, /action="\/s\/\$\{esc\(l\.id\)\}\/coupon"/, '分享页必须有提交券码的表单');
  assertMatch(src, /class="coupon-form"/, '券码表单必须独立于支付表单（HTML 不允许嵌套 form）');

  // 需求 5：原价划线 + 优惠价突出
  assertMatch(src, /\.pay-orig \{[^}]*text-decoration: line-through/, '原价必须划线');
  assertMatch(src, /\.pay-orig \{[^}]*color: #9aa1ab/, '原价必须变灰');
  assertMatch(src, /priceHtml[\s\S]{0,400}pay-orig[\s\S]{0,200}pay-amount/, '优惠价必须紧跟原价展示');

  // 需求 6：无效券回页提示（把 store 给出的原因原样渲染）
  assertMatch(src, /优惠券无效|couponWarn/, '无效券必须给出提示');
  assertMatch(src, /validateForUse/, '券的可用性判定必须委托 coupon-store（唯一实现点）');

  // 需求 7：下单时把原价 / 优惠 / 券快照进订单
  assertMatch(src, /originalFen: ps\.amountFen/, '订单必须快照原价');
  assertMatch(src, /discountFen: applied \? applied\.discountFen : 0/, '订单必须快照优惠金额');
  assertMatch(src, /couponCode: applied \? applied\.coupon\.code : ''/, '订单必须快照券码');
  assertMatch(src, /couponStore\.consume\(/, '建单成功后必须核销');

  // 未成交要还券：否则「试两次就提示已用尽」
  assertMatch(src, /releaseCouponForOrder\(order\)/, '下单失败必须回退券');

  // 分享页身份：限特定用户要靠登录身份
  assertMatch(src, /authSession\.parseToken/, '分享页必须能从会话识别登录用户');
});
