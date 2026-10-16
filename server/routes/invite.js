/**
 * 路由：邀请码设置（R54 第 ③ 步）
 *
 * 六条接口，**全部仅管理员** —— 邀请码是「免注册口令」，拿到即能开户
 * （身份还可能是管理员），可见面必须与「用户管理」同级。
 *
 * ## 为什么导出是 POST，而不是 GET
 *
 * 直觉上「下载一个 txt」应该用 GET，但这里刻意用 POST + 请求体传 `ids`：
 *
 *  · **凭据不该进 URL**。响应体里是**明文邀请码**，而 GET 的完整 URL 会进
 *    浏览器历史、`Referer`（同源策略下不跨站，但仍有）、反向代理的 access log、
 *    以及任何路过的基础设施日志。一个「导出全部邀请码」的 GET 请求，
 *    等于把整批口令写进了至少三处日志。
 *  · POST 天然要求 `X-Requested-With`（`security.csrfGuard` 对非安全方法强制），
 *    于是它不能被一个跨站表单触发。
 *  · 顺带解决「勾选导出」：`ids` 可能几百个，塞进查询串会撞 URL 长度上限。
 *
 * ⚠️ 相应的**代价**：前端不能靠 `<a href>` 下载（发不出 CSRF 头），
 * 必须走 `request()` 拿到文本再自己造 Blob —— 见 `public/js/invitemgr.js`。
 *
 * ## 为什么批量删除走 `/invites/delete` 而不是逐条 `DELETE /invites/:id`
 *
 * 这个页面最主要的动作就是「把这一批没用完的码删掉」，逐条发请求在 500 条时
 * 是 500 次往返。用请求体传 `ids` 是**一处判据、一次落盘**，也不会出现
 * 「删到第 300 条时中断，剩下的还在」这种半截状态。
 */
const { express, configStore, statsStore, inviteStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
// 入参合法性的唯一判据（与 `invite-store` 的落盘归一化共用同一组来源）
const {
  DEFAULT_ROLES, normalizeDefaultRole, parseInviteCountInput,
  parseInviteMaxUsesInput, parseInviteExpiresInput, parseInviteNoteInput,
} = require('../limits');

const router = express.Router();

/**
 * 校验一批 ids（生成以外的一切「按 id 批量操作」共用）。
 *
 * 刻意**不**在这里判「id 是否存在」：那是 store 的职责（它才持有当前记录），
 * 而「有一半 id 已经不存在」是正常并发场景（两个管理员同时清列表），
 * 该由 store 回 `skipped` 计数、路由如实回报，而不是整批 404。
 */
function parseIds(v) {
  if (v === undefined) return null; // 未给 = 「全部」（仅导出使用）
  if (!Array.isArray(v)) throw Object.assign(new Error('ids 须为数组'), { status: 400 });
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x) throw Object.assign(new Error('ids 里含有非法的条目'), { status: 400 });
    out.push(x);
  }
  return out;
}

/**
 * 把一次请求体翻译成 store 的 PATCH 对象（**唯一实现点**）。
 *
 * `update` / `bulkUpdate` 共用：两条路径的字段语义必须逐字一致，
 * 各写一份必然分叉（改了一处漏另一处，而症状是「单个能改、批量改了没反应」）。
 *
 * ⚠️ 每个字段都判 `!== undefined`，**不判真值** —— `disabled: false`
 * （= 重新启用）、`maxUses: 0`（= 改为不限制）、`expiresAt: null`（= 改为永久）
 * 全是合法值，用真值判断会让这三个动作静默失效而界面显示成功。
 *
 * @param {object} b 请求体
 * @param {boolean} [partial] `true` 时允许「一个字段都没给」（批量设置里的空 patch）
 * @returns {object} patch
 */
function buildPatch(b, partial) {
  const patch = {};
  if (b.role !== undefined) {
    if (typeof b.role !== 'string' || !DEFAULT_ROLES.includes(b.role)) {
      throw Object.assign(new Error(`注册后的身份须为 ${DEFAULT_ROLES.join(' / ')} 之一`), { status: 400 });
    }
    patch.role = normalizeDefaultRole(b.role);
  }
  if (b.maxUses !== undefined) {
    const r = parseInviteMaxUsesInput(b.maxUses);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.maxUses = r.value;
  }
  if (b.expiresAt !== undefined) {
    const r = parseInviteExpiresInput(b.expiresAt);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.expiresAt = r.value;
  }
  if (b.note !== undefined) {
    const r = parseInviteNoteInput(b.note);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.note = r.value;
  }
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== 'boolean') {
      throw Object.assign(new Error('停用状态须为布尔值'), { status: 400 });
    }
    patch.disabled = b.disabled;
  }
  if (b.resetUsed !== undefined) {
    if (typeof b.resetUsed !== 'boolean') {
      throw Object.assign(new Error('重置使用次数须为布尔值'), { status: 400 });
    }
    patch.resetUsed = b.resetUsed;
  }
  if (!partial && !Object.keys(patch).length) {
    throw Object.assign(new Error('没有需要修改的字段'), { status: 400 });
  }
  return patch;
}

// 邀请码列表（仅管理员）
router.get('/invites', requireAdmin, apiHandler(async (req, res) => {
  res.json({ ok: true, invites: inviteStore.list() });
}));

/**
 * 批量生成（仅管理员）。
 *
 * `role` 缺省时取**站点设置里的「新用户身份」**（`site.defaultRole`）——
 * 与「公开注册」模式下注册得到的身份是同一个来源，管理员不必在
 * 「站点设置」和「邀请码设置」两处各记一遍同一个默认值。
 *
 * ⚠️ 身份是**生成时快照**进记录里的，不是注册时现取：管理员看到列表里写着
 * 「管理员」，用这枚码注册出来就一定是管理员。若改成注册时现取，
 * 事后调一次站点设置就会让**已经发出去的码**改变含义 —— 那是不可接受的。
 * 要批量改已发出的码的身份，用 `/invites/bulk`（列表上勾选后改）。
 */
router.post('/invites', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const cnt = parseInviteCountInput(b.count);
  if (!cnt.ok) throw Object.assign(new Error(cnt.error), { status: 400 });

  const patch = buildPatch(b, true); // 复用同一组判据；未给的字段取默认值
  const site = configStore.getSite();
  const made = inviteStore.generate({
    count: cnt.value,
    role: patch.role !== undefined ? patch.role : site.defaultRole,
    maxUses: patch.maxUses !== undefined ? patch.maxUses : 0,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : null,
    note: patch.note !== undefined ? patch.note : '',
    createdBy: req.authUser.username,
  });

  statsStore.addLog({
    action: 'invite.generate', level: 'info',
    // ⚠️ 日志里**只记数量与配置**，绝不记邀请码本身：审计日志是明文 JSONL，
    // 把码写进去等于把口令摊在日志里（与 backup.js 的实时码同类的泄漏面）。
    detail: `管理员「${req.authUser.username}」生成 ${made.length} 个邀请码`
      + `（身份=${made.length ? (made[0].role === 'admin' ? '管理员' : '普通用户') : '-'}`
      + `，次数上限=${made.length ? (made[0].maxUses || '不限') : '-'}`
      + `，过期时间=${made.length && made[0].expiresAt ? made[0].expiresAt : '永久'}`
      + `，备注=${(made.length && made[0].note) || '无'}）`,
  });
  res.json({ ok: true, invites: made });
}));

/**
 * 批量设置（仅管理员）：勾选若干条 → 一次性改「使用次数 / 过期时间 / 身份 / 停用 / 备注」。
 *
 * PATCH 语义：只改请求体里**出现过**的字段；没出现的保持原值。
 * 这正是「不动的字段不会被我顺手改成默认值」的保证 —— 打算改成
 * 「整个对象替换」会让批量改身份同时把过期时间清成永久。
 */
router.post('/invites/bulk', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const ids = parseIds(b.ids);
  if (!ids || !ids.length) throw Object.assign(new Error('请先选择要设置的邀请码'), { status: 400 });
  const patch = buildPatch(b, false);
  const r = inviteStore.bulkUpdate(ids, patch);
  statsStore.addLog({
    action: 'invite.update', level: 'info',
    detail: `管理员「${req.authUser.username}」批量设置 ${r.updated} 个邀请码`
      + `（字段：${Object.keys(patch).join(' / ')}${r.skipped ? `；${r.skipped} 个已不存在被跳过` : ''}）`,
  });
  res.json({ ok: true, updated: r.updated, skipped: r.skipped });
}));

// 批量删除（仅管理员）
router.post('/invites/delete', requireAdmin, apiHandler(async (req, res) => {
  const ids = parseIds((req.body || {}).ids);
  if (!ids || !ids.length) throw Object.assign(new Error('请先选择要删除的邀请码'), { status: 400 });
  const removed = inviteStore.remove(ids);
  statsStore.addLog({
    action: 'invite.delete', level: 'info',
    detail: `管理员「${req.authUser.username}」删除 ${removed} 个邀请码`,
  });
  res.json({ ok: true, removed });
}));

/**
 * 导出为纯文本（仅管理员）—— **一行一个**（需求原话）。
 *
 * 给 `ids` 时只导出选中的，否则导出全部。响应就是**纯文本本身**，
 * 不做 JSON 包装：这个端点的产物会被直接另存为 `.txt`，包一层 JSON
 * 就等于给出一个「打开是乱码」的文件。
 *
 * ⚠️ 响应体是**明文口令集合**，与 `GET /backup/code`（实时备份码含密钥明文）
 * 同级。因此三条约束缺一不可：仅管理员、POST（不把码写进任何 URL / 日志）、
 * 日志里只记条数。
 */
router.post('/invites/export', requireAdmin, apiHandler(async (req, res) => {
  const ids = parseIds((req.body || {}).ids);
  const text = inviteStore.exportText({ ids });
  const lines = text ? text.split('\n').length - 1 : 0;
  statsStore.addLog({
    action: 'invite.export', level: 'info',
    detail: `管理员「${req.authUser.username}」导出 ${lines} 个邀请码${ids && ids.length ? '（仅选中项）' : '（全部）'}`,
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // 文件名由前端决定（`a.download`），服务端只负责内容 —— 一处来源，不会两边不一致
  res.send(text);
}));

/**
 * 单条修改（仅管理员）。
 *
 * ⚠️ 注册在 `/invites/bulk` / `/invites/delete` / `/invites/export` **之后**：
 * 那三条是字面量路径，本条带 `:id`。若本条在前，`PUT /invites/bulk` 会被
 * 当成 id=`bulk` 的更新（本项目在 `/links/dead` 与 `/links/:id` 上踩过同一个坑）。
 * 这里方法不同（PUT vs POST）恰好不会撞，但**顺序仍然按这个规矩排**：
 * 将来有人把批量接口改成 PUT 时，顺序已经是安全的。
 */
router.put('/invites/:id', requireAdmin, apiHandler(async (req, res) => {
  const patch = buildPatch(req.body || {}, false);
  const v = inviteStore.update(req.params.id, patch);
  if (!v) throw Object.assign(new Error('邀请码不存在或已被删除'), { status: 404 });
  statsStore.addLog({
    action: 'invite.update', level: 'info',
    detail: `管理员「${req.authUser.username}」修改邀请码 ${v.id}`
      + `（字段：${Object.keys(patch).join(' / ')}；当前状态：${v.status}）`,
  });
  res.json({ ok: true, invite: v });
}));

module.exports = router;
