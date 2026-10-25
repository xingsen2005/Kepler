/**
 * 第八十八轮护栏：优惠券「满 xx 减 xx」（R88）
 *
 * 需求原文：
 *  > 为优惠券系统新增：满xx减xx
 *
 * ## 为什么是「加一个门槛字段」而不是「加一种券类型」
 *
 * `type` 回答的是**适用范围**（谁能用、在哪些链接上用），门槛回答的是**这一单够不够格**。
 * 把「满减」做成第四种 `type` 会立刻与 `links` / `users` 互斥 ——「只在某个链接上满 50 减 10」
 * 就表达不出来了，而那正是 R62 刻意避开的错误（见 `coupon-store.js` 文件头 ③）。
 * 故 `minSpendFen` 与 `type` 正交，`0` 即直减券，存量券缺这个字段行为不变。
 *
 * ## 断言分层（每条都指向**实际执行的那一层**）
 *
 *  ① 判据层 —— `limits.parseCouponMinSpendInput()`：0/空 = 无门槛、负数与超上限拒绝、
 *     **小于 1 分不许静默归 0**（静默归一 = 一张「我明明填了门槛」的无门槛券）。
 *  ② 存储层 —— `minSpendFen` 真的落进记录（不只是视图）、归一化可降级、上限 clamp。
 *  ③ 金额层 —— 原价 < 门槛必须拒绝且文案**写明门槛金额**；等于门槛可用；封顶逻辑不变。
 *  ④ 优先级 —— 免费链接必须报「无需付费」而不是「未满 xx 元」。
 *  ⑤ 接线层 —— 真发 HTTP：生成 / 单条改 / 批量改都能写门槛，且 `minSpend: 0`
 *     能把满减券改回无门槛（PATCH 语义陷阱：用真值判断会让这个动作静默失效）。
 *  ⑥ 前端层 —— 「满 X 减 Y」真进了表格单元格、生成请求真带上了 `minSpend`
 *     （取函数体再数，避免「文件里出现过这个词」式假绿）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r88-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);

const limits = require(SERVER('limits.js'));
const couponStore = require(SERVER('coupon-store.js'));

const LINK = (amountFen, id = 'L1') => ({ id, paid: { required: true, amountFen } });

/** 造一张券（直接走 store；路由的入参判据单独测） */
let seq = 0;
function makeCoupon(patch) {
  seq += 1;
  const made = couponStore.generate(Object.assign({
    count: 1, type: 'any', linkIds: [], userIds: [],
    amountFen: 500, maxUses: 0, perUserOnce: false,
    startAt: null, expireAt: null, note: `t${seq}`, createdBy: 'tester',
  }, patch || {}));
  return made[0];
}

/** 用一张券验证「原价 X」这一单 */
function use(c, amountFen, extra) {
  return couponStore.validateForUse(Object.assign({
    code: c.code, link: LINK(amountFen), identity: 'a:test', userId: '',
  }, extra || {}));
}

/* ================================================================== *
 * ① 判据层
 * ================================================================== */

test('R88-01 · 门槛解析：空 / 0 = 无门槛；负数与超上限拒绝；小于 1 分不得静默变 0', () => {
  assertEqual(limits.parseCouponMinSpendInput(undefined).value, 0, '不传 = 无门槛（存量券与直减券的语义）');
  assertEqual(limits.parseCouponMinSpendInput('').value, 0, '留空 = 无门槛');
  assertEqual(limits.parseCouponMinSpendInput(0).value, 0, '显式填 0 必须合法 —— 「改成无门槛」是一个必须能做到的动作');
  assertEqual(limits.parseCouponMinSpendInput('50').value, 5000, '元 → 分');
  assertEqual(limits.parseCouponMinSpendInput(49.99).value, 4999);
  assertEqual(limits.parseCouponMinSpendInput(0.01).value, 1, '最小合法门槛是 1 分');

  assertEqual(limits.parseCouponMinSpendInput(-1).ok, false, '负数必须拒绝');
  assertEqual(limits.parseCouponMinSpendInput('abc').ok, false, '非数字必须拒绝');

  /**
   * 这条是本节的重点：`Math.round(0.004 * 100) = 0`。若不显式拦，
   * 管理员填了「门槛 0.004」，存下来的是一张**无门槛券**，而界面显示「已保存」。
   */
  assertEqual(limits.parseCouponMinSpendInput(0.004).ok, false,
    '大于 0 但不足 1 分必须报错，不能四舍五入成「无门槛」');

  assertEqual(limits.parseCouponMinSpendInput(limits.COUPON_MIN_SPEND_MAX_FEN / 100).ok, true, '上限本身合法');
  assertEqual(limits.parseCouponMinSpendInput(limits.COUPON_MIN_SPEND_MAX_FEN / 100 + 1).ok, false, '超上限必须拒绝');
});

/* ================================================================== *
 * ② 存储层
 * ================================================================== */

test('R88-02 · 满减券落盘：字段真的写进记录（不只是视图），非法值可降级、超上限 clamp', () => {
  const c = makeCoupon({ amountFen: 1000, minSpendFen: 5000 });
  assertEqual(c.minSpendFen, 5000, '视图里要有');
  assertEqual(couponStore.get(c.id).minSpendFen, 5000, '记录里也必须有 —— 只改视图等于每次刷新都忘掉');

  /** 存量券：R88 之前生成的记录没有这个字段，必须视为无门槛（而不是 undefined 参与比较） */
  const legacy = makeCoupon({ amountFen: 500 });
  assertEqual(legacy.minSpendFen, 0, '缺字段 ⇒ 无门槛，存量券行为不变');
  assertEqual(use(legacy, 100).ok, true, '存量券在低价链接上仍然可用');

  /**
   * 归一化必须**降级**而不是丢记录：门槛坏了的券还能当直减券用，
   * 丢掉它等于因为一个可选字段把一张已经发出去的券作废。
   */
  const bad = makeCoupon({ amountFen: 500, minSpendFen: -3 });
  assertEqual(bad.minSpendFen, 0, '负数归一为 0，且记录仍在');
  assertEqual(couponStore.get(bad.id) !== null, true, '不得因为门槛非法丢掉整张券');

  const cap = makeCoupon({ amountFen: 500, minSpendFen: 99999999 });
  assertEqual(cap.minSpendFen, limits.COUPON_MIN_SPEND_MAX_FEN, '超上限 clamp 到上限');
});

/* ================================================================== *
 * ③ 金额层（本功能的核心）
 * ================================================================== */

test('R88-03 · 原价不足门槛必须拒绝且文案写明门槛；正好够 / 超过都能用，封顶逻辑不变', () => {
  const c = makeCoupon({ amountFen: 500, minSpendFen: 2000, note: '满20减5' });

  // 1200 < 2000
  let r = use(c, 1200);
  assertEqual(r.ok, false, '原价低于门槛必须不可用');
  assertEqual(r.reason, 'below_threshold');
  assertMatch(r.message, /¥20\.00/, '文案必须带上门槛金额 —— 只说「未达门槛」等于让买家自己猜差多少');
  assertEqual(r.discountFen, undefined, '不可用时不得回传优惠金额（调用方会拿去建单）');

  // 正好等于门槛：满 20 减 5，原价 20 → 应付 15
  r = use(c, 2000);
  assertEqual(r.ok, true, '原价恰好等于门槛必须可用（「满」含等于）');
  assertEqual(r.originalFen, 2000);
  assertEqual(r.discountFen, 500);
  assertEqual(r.payableFen, 1500);

  // 超过门槛
  r = use(c, 5000);
  assertEqual(r.ok, true);
  assertEqual(r.payableFen, 4500, '门槛不改变优惠额，只决定「能不能用」');

  /**
   * 门槛低于面额（满 20 减 50）是**允许**的配置：优惠仍封顶到「原价 − 1 分」。
   * 门槛不参与封顶 —— 若让门槛也去缩减免金额，这里会算出 payable = 0，网关拒收。
   */
  const over = makeCoupon({ amountFen: 5000, minSpendFen: 2000 });
  r = use(over, 2000);
  assertEqual(r.ok, true);
  assertEqual(r.discountFen, 1999, '满 20 减 50 在原价 20 上：优惠封顶到 19.99');
  assertEqual(r.payableFen, 1, '应付永不为 0');
});

test('R88-04 · 免费链接优先报「无需付费」；门槛与适用范围正交（限链接 + 满减同时生效）', () => {
  const c = makeCoupon({ amountFen: 500, minSpendFen: 5000 });

  /**
   * ⚠️ 顺序判据：门槛判定必须排在 `no_price` **后面**。
   * 免费链接上答「未满 50 元」是错的 —— 它暗示「多买点就能用」，而这里没有可买的东西。
   */
  const free = couponStore.validateForUse({
    code: c.code, link: { id: 'L1', paid: { required: false, amountFen: 0 } }, identity: 'a:t', userId: '',
  });
  assertEqual(free.ok, false);
  assertEqual(free.reason, 'no_price', '免费链接必须报 no_price，不能报 below_threshold');

  // 正交：限链接 + 满减可以同时存在（这正是「加一种 type」做不到的组合）
  const scoped = makeCoupon({ type: 'links', linkIds: ['L9'], amountFen: 500, minSpendFen: 2000 });
  assertEqual(use(scoped, 99999, { link: LINK(99999, 'L1') }).reason, 'wrong_link', '不适用的链接仍先报不适用');
  const hit = couponStore.validateForUse({ code: scoped.code, link: LINK(2000, 'L9'), identity: 'a:t', userId: '' });
  assertEqual(hit.ok, true, '链接对了、金额也够了 ⇒ 两个条件同时满足才可用');
  assertEqual(hit.payableFen, 1500);

  // 限用户 + 满减：匿名访客先被身份挡住（而不是先抱怨金额不足）
  const forUser = makeCoupon({ type: 'users', userIds: ['U1'], amountFen: 500, minSpendFen: 2000 });
  assertEqual(use(forUser, 100).reason, 'wrong_user', '身份门槛优先于金额门槛');
});

/* ================================================================== *
 * ⑤ 接线层（真发 HTTP）
 * ================================================================== */

const express = require(path.join(ROOT, 'node_modules', 'express'));

async function serve() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { username: 'admin', role: 'admin' }; next(); });
  app.use('/api', require(SERVER('routes', 'coupon.js')));
  // 与 index.js 同形：不读 err.status 的话，本模块抛的 400 会被吞成 500
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
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

test('R88-05 · 路由：生成 / 单条改 / 批量改都能写门槛，且 `minSpend: 0` 能把满减券改回无门槛', async () => {
  const s = await serve();
  try {
    // 生成：元 → 分
    let r = await request(s.port, 'POST', '/api/coupons', { body: { count: 1, type: 'any', amount: 10, minSpend: 50 } });
    assertEqual(r.status, 200);
    const c = r.json.coupons[0];
    assertEqual(c.minSpendFen, 5000, '生成时门槛落盘为分');
    assertEqual(c.amountFen, 1000);

    // 生成：小于 1 分 → 400（不能静默变成无门槛券）
    r = await request(s.port, 'POST', '/api/coupons', { body: { count: 1, type: 'any', amount: 1, minSpend: 0.004 } });
    assertEqual(r.status, 400, '0.004 元必须被拒，而不是静默存成无门槛');

    // 生成：不传门槛 = 直减券
    r = await request(s.port, 'POST', '/api/coupons', { body: { count: 1, type: 'any', amount: 1 } });
    assertEqual(r.json.coupons[0].minSpendFen, 0);

    /**
     * ⚠️ PATCH 语义陷阱：`buildPatch` 里若用真值判断（`if (b.minSpend)`），
     * `minSpend: 0` 会被丢掉 —— 界面上「去掉门槛」点了保存、返回成功，门槛却还在。
     */
    r = await request(s.port, 'PUT', `/api/coupons/${c.id}`, { body: { minSpend: 0 } });
    assertEqual(r.status, 200);
    assertEqual(r.json.coupon.minSpendFen, 0, 'minSpend: 0 必须真的把门槛改回无门槛');

    // 单条改：0 → 30
    r = await request(s.port, 'PUT', `/api/coupons/${c.id}`, { body: { minSpend: 30 } });
    assertEqual(r.json.coupon.minSpendFen, 3000);

    // 批量改
    r = await request(s.port, 'POST', '/api/coupons/bulk', { body: { ids: [c.id], minSpend: 12.5 } });
    assertEqual(r.status, 200);
    assertEqual(r.json.updated, 1);
    assertEqual(couponStore.get(c.id).minSpendFen, 1250, '批量改也必须落到记录里');

    // 列表里带出门槛（前端要靠它渲染「满 X 减 Y」）
    r = await request(s.port, 'GET', '/api/coupons');
    assertEqual(r.json.coupons.find((x) => x.id === c.id).minSpendFen, 1250);
  } finally {
    s.close();
  }
});

/* ================================================================== *
 * ⑥ 前端层
 * ================================================================== */

/** 取 `function name(` 的函数体（到下一个独占一行的 `}` 为止） */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `未找到函数 ${name}()`);
  const end = src.indexOf('\n}', start);
  assert(end > start, `${name}() 的函数体未能解析`);
  return src.slice(start, end + 2);
}

test('R88-06 · 前端：「满 X 减 Y」真进了「优惠」单元格，生成请求真带上 minSpend', () => {
  const src = fs.readFileSync(JS('couponmgr.js'), 'utf8');

  const fmt = fnBody(src, 'fmtDiscount');
  assertMatch(fmt, /minSpendFen/, 'fmtDiscount 必须读门槛字段');
  assertMatch(fmt, /满 .*减/, '有门槛时必须渲染成「满 X 减 Y」，只显示面额看不出两张券的差别');

  // 单元格必须调 fmtDiscount，而不是退回裸面额（退回 = 满减与直减在列表里长得一样）
  const row = fnBody(src, 'rowOf');
  assertMatch(row, /fmtDiscount\(c\)/, '「优惠」单元格必须走 fmtDiscount');
  assertEqual(/yuan\(c\.amountFen\)/.test(row), false, '单元格不得再用裸面额');

  // 生成请求真的带上了 minSpend（读的是真实提交体，不是表单里那个 input）
  const submit = fnBody(src, 'submitGenerate');
  assertMatch(submit, /minSpend/, 'submitGenerate 必须读出门槛输入框');
  assertMatch(submit, /count, type, amount, minSpend, maxUses/, 'minSpend 必须进 submitGenerate 的提交体');

  // 表单里必须有这个输入框（否则「读出门槛」读到的是 null）
  assertMatch(src, /id="\$\{p\}-minspend"/, '生成表单必须有门槛输入框');
});
