/**
 * 路由：优惠券设置（R62）
 *
 * 五条接口，**全部仅管理员** —— 券码是「能直接抵扣金额」的凭据，
 * 可见面与「邀请码设置」同级。
 *
 * ⚠️ 模块内顺序有语义：`/coupons/bulk`、`/coupons/delete` 两条**字面量**路径
 * 必须排在 `PUT /coupons/:id` 之前。虽然方法不同（POST vs PUT）当前不会撞，
 * 但本项目在 `/links/dead` 与 `/links/:id` 上踩过同一个坑，规矩要提前立。
 *
 * ## 为什么没有「导出」
 *
 * 邀请码导出的是「免注册口令」，管理员要把它逐行发给不同的人；优惠券的使用方
 * 是**买家**，分发方式通常是「贴一条公告 / 发给某个客户」，不需要批量 txt。
 * 需求也没有提，故不做 —— 少一个出口就少一处「明文凭据进文件」的泄漏面。
 */
const { express, statsStore, couponStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
const {
  COUPON_TYPES, normalizeCouponType,
  parseCouponCountInput, parseCouponAmountInput, parseCouponMaxUsesInput,
  parseCouponMinSpendInput,
  parseCouponTimeInput, parseCouponIdsInput, parseCouponNoteInput,
} = require('../limits');

const router = express.Router();

const TYPE_LABEL = { any: '无门槛', links: '限特定链接', users: '限特定用户' };

/** 一批 id（批量设置 / 删除共用）。不存在由 store 计 `skipped`，此处只判形状。 */
function parseIds(v) {
  if (!Array.isArray(v)) throw Object.assign(new Error('ids 须为数组'), { status: 400 });
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x) throw Object.assign(new Error('ids 里含有非法的条目'), { status: 400 });
    out.push(x);
  }
  return out;
}

/**
 * 把请求体翻译成 store 的 PATCH 对象（`update` / `bulkUpdate` 共用，**唯一实现点**）。
 *
 * 每个字段都判 `!== undefined` 而非真值：`disabled: false`（重新启用）、
 * `maxUses: 0`（改为不限制）、`expireAt: null`（改为永久）都是合法值，
 * 用真值判断会让这三个动作静默失效，而界面显示「保存成功」。
 */
function buildPatch(b, partial) {
  const patch = {};
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== 'boolean') throw Object.assign(new Error('停用状态须为布尔值'), { status: 400 });
    patch.disabled = b.disabled;
  }
  if (b.maxUses !== undefined) {
    const r = parseCouponMaxUsesInput(b.maxUses);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.maxUses = r.value;
  }
  if (b.amount !== undefined) {
    const r = parseCouponAmountInput(b.amount);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.amountFen = r.value;
  }
  /**
   * R88：「满 xx 减 xx」的门槛。**允许显式改成 0**（无门槛）—— 故这里用
   * `!== undefined` 而不是真值判断：`minSpend: 0` 是一个必须能生效的动作
   * （与 `disabled: false`、`maxUses: 0` 同一类陷阱）。
   */
  if (b.minSpend !== undefined) {
    const r = parseCouponMinSpendInput(b.minSpend);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.minSpendFen = r.value;
  }
  if (b.startAt !== undefined) {
    const r = parseCouponTimeInput(b.startAt, '开始时间');
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.startAt = r.value;
  }
  if (b.expireAt !== undefined) {
    const r = parseCouponTimeInput(b.expireAt, '到期时间');
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.expireAt = r.value;
  }
  if (b.note !== undefined) {
    const r = parseCouponNoteInput(b.note);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.note = r.value;
  }
  if (!partial && !Object.keys(patch).length) {
    throw Object.assign(new Error('没有需要修改的字段'), { status: 400 });
  }
  return patch;
}

/** 列表（仅管理员） */
router.get('/coupons', requireAdmin, apiHandler(async (req, res) => {
  res.json({ ok: true, coupons: couponStore.list() });
}));

/**
 * 生成（仅管理员）—— 需求 1「可单独或批量生成」：`count` 就是那一处差异，
 * 1 张即「单独生成」，N 张即「批量生成」。
 *
 * 适用范围（需求 2）按 `type` 三选一：`any` / `links` / `users`。
 * `links` / `users` 必须给出非空目标集合 —— 一个「限特定链接」却没有任何链接的券，
 * 唯一效果是让买家拿到一句「不适用于当前链接」，而管理员看不出是自己漏选了。
 */
router.post('/coupons', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};

  const cnt = parseCouponCountInput(b.count === undefined ? 1 : b.count);
  if (!cnt.ok) throw Object.assign(new Error(cnt.error), { status: 400 });

  const type = normalizeCouponType(b.type);
  if (COUPON_TYPES.indexOf(type) < 0) throw Object.assign(new Error('优惠券类型不合法'), { status: 400 });

  let linkIds = [];
  let userIds = [];
  if (type === 'links') {
    const r = parseCouponIdsInput(b.linkIds, '分享链接');
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    linkIds = r.value;
  }
  if (type === 'users') {
    const r = parseCouponIdsInput(b.userIds, '用户');
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    userIds = r.value;
  }

  const amt = parseCouponAmountInput(b.amount);
  if (!amt.ok) throw Object.assign(new Error(amt.error), { status: 400 });

  // R88：「满 xx 减 xx」的门槛（留空 = 无门槛的直减券）
  const minSpend = parseCouponMinSpendInput(b.minSpend);
  if (!minSpend.ok) throw Object.assign(new Error(minSpend.error), { status: 400 });

  const mu = parseCouponMaxUsesInput(b.maxUses === undefined ? 0 : b.maxUses);
  if (!mu.ok) throw Object.assign(new Error(mu.error), { status: 400 });

  const st = parseCouponTimeInput(b.startAt, '开始时间');
  if (!st.ok) throw Object.assign(new Error(st.error), { status: 400 });
  const ex = parseCouponTimeInput(b.expireAt, '到期时间');
  if (!ex.ok) throw Object.assign(new Error(ex.error), { status: 400 });
  // 起止顺序：两个都给时必须「开始 < 到期」，否则一张永远不可能有效的券
  if (st.value && ex.value && Date.parse(st.value) >= Date.parse(ex.value)) {
    throw Object.assign(new Error('开始时间必须早于到期时间'), { status: 400 });
  }

  let note = '';
  if (b.note !== undefined) {
    const r = parseCouponNoteInput(b.note);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    note = r.value;
  }

  if (b.perUserOnce !== undefined && typeof b.perUserOnce !== 'boolean') {
    throw Object.assign(new Error('「每个用户只能使用一次」须为布尔值'), { status: 400 });
  }

  const made = couponStore.generate({
    count: cnt.value,
    type,
    linkIds,
    userIds,
    amountFen: amt.value,
    minSpendFen: minSpend.value,
    maxUses: mu.value,
    perUserOnce: Boolean(b.perUserOnce),
    startAt: st.value,
    expireAt: ex.value,
    note,
    createdBy: req.authUser.username,
  });

  statsStore.addLog({
    action: 'coupon.generate', level: 'info',
    // 日志只记数量与配置，不记券码本身（与邀请码同：审计日志是明文 JSONL）
    detail: `管理员「${req.authUser.username}」生成 ${made.length} 张优惠券`
      + `（${TYPE_LABEL[type] || type}；`
      + (minSpend.value > 0
        ? `满 ¥${(minSpend.value / 100).toFixed(2)} 减 ¥${(amt.value / 100).toFixed(2)}`
        : `优惠 ¥${(amt.value / 100).toFixed(2)}`)
      + `；次数=${mu.value || '不限'}；每人一次=${b.perUserOnce ? '是' : '否'}`
      + `；有效期=${st.value || '立即'} ~ ${ex.value || '永久'}`
      + `${type === 'links' ? `；链接 ${linkIds.length} 个` : ''}`
      + `${type === 'users' ? `；用户 ${userIds.length} 个` : ''}）`,
  });
  res.json({ ok: true, coupons: made });
}));

/** 批量设置（仅管理员）：停用 / 启用、次数上限、金额、起止时间、备注 */
router.post('/coupons/bulk', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const ids = parseIds(b.ids);
  if (!ids.length) throw Object.assign(new Error('请先选择要设置的优惠券'), { status: 400 });
  const patch = buildPatch(b, false);
  const r = couponStore.bulkUpdate(ids, patch);
  statsStore.addLog({
    action: 'coupon.update', level: 'info',
    detail: `管理员「${req.authUser.username}」批量设置 ${r.updated} 张优惠券`
      + `（字段：${Object.keys(patch).join(' / ')}${r.skipped ? `；${r.skipped} 张已不存在被跳过` : ''}）`,
  });
  res.json({ ok: true, updated: r.updated, skipped: r.skipped });
}));

/** 批量删除（仅管理员） */
router.post('/coupons/delete', requireAdmin, apiHandler(async (req, res) => {
  const ids = parseIds((req.body || {}).ids);
  if (!ids.length) throw Object.assign(new Error('请先选择要删除的优惠券'), { status: 400 });
  const r = couponStore.remove(ids);
  statsStore.addLog({
    action: 'coupon.delete', level: 'info',
    detail: `管理员「${req.authUser.username}」删除 ${r.removed} 张优惠券`,
  });
  res.json({ ok: true, removed: r.removed, skipped: r.skipped });
}));

/** 单条修改（仅管理员）—— 必须排在两条字面量路径之后（见文件头） */
router.put('/coupons/:id', requireAdmin, apiHandler(async (req, res) => {
  const patch = buildPatch(req.body || {}, false);
  const v = couponStore.update(req.params.id, patch);
  if (!v) throw Object.assign(new Error('优惠券不存在或已被删除'), { status: 404 });
  statsStore.addLog({
    action: 'coupon.update', level: 'info',
    detail: `管理员「${req.authUser.username}」修改优惠券 ${v.id}`
      + `（字段：${Object.keys(patch).join(' / ')}；当前状态：${v.status}）`,
  });
  res.json({ ok: true, coupon: v });
}));

module.exports = router;
