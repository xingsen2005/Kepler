/**
 * 优惠券设置页（R62，仅管理员）
 *
 * 需求原文：
 *  > 1、用户可单独或批量生成优惠券；
 *  > 2、可设置优惠券类型限制：无门槛、限特定链接（可直接选择/搜索已有的付费链接）、限特定用户；
 *  > 3、可设置优惠券使用限制：次数（总次数、是否为每个用户只能使用一次）、时间（开始和到期时间）。
 *
 * ## 三处刻意的取舍
 *
 * ① **状态判定只有服务端一份**。`coupon-store.view()` 已在每条记录上算好 `status`
 *    并随列表下发，这里只做 `status → 文案 + 徽章样式` 的映射。再抄一份判定，
 *    迟早出现「列表说有效、分享页却说已过期」。
 *
 * ② **「单独生成」与「批量生成」是同一个动作**（`count` 填 1 或 N），
 *    不做两个按钮：两条入口各自读一遍表单，必然出现「单独生成时漏读某个字段」。
 *
 * ③ **链接 / 用户选择用穿梭框**（`buildTransferBox`，与存储桶可见性、IP 规则共用），
 *    而不是塞一个多选 `<select>`：目标可能上百个，多选下拉在搜索与「已选了几个」
 *    这两件事上都不可用。它自带搜索框，正好满足需求里的「可直接选择/搜索」。
 */
import { API } from './api.js';
import {
  toast, confirmDialog, openModal, escapeHtml, fmtTime, matchesQuery, previewMoreState, roleLabel,
} from './util.js';
import { openListDialog, buildTransferBox } from './listdialog.js';

/** 卡片里最多显示多少条（与其余卡片一致：对话框承担逐条查看） */
const COUPON_PREVIEW_LIMIT = 10;

/** 状态 → 文案与徽章样式（**只做映射，不做判定**） */
const STATUS_META = {
  active: { label: '有效', cls: 'ok' },
  not_started: { label: '未开始', cls: 'warn' },
  expired: { label: '已过期', cls: 'bad' },
  used_up: { label: '已用尽', cls: 'warn' },
  disabled: { label: '已停用', cls: 'gone' },
};

const TYPE_LABEL = { any: '无门槛', links: '限特定链接', users: '限特定用户' };

let cache = [];
let linksAll = [];
let usersAll = [];
/** 已勾选的 id（跨刷新保留，但每次刷新剔除已不存在的） */
let selected = new Set();
let dialog = null;
let wired = false;

/* ============================ 工具 ============================ */

function metaOf(st) {
  return STATUS_META[st] || { label: st || '未知', cls: 'gone' };
}

function yuan(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

function fmtUses(c) {
  return `已用 ${Number(c.used) || 0} / ${Number(c.maxUses) > 0 ? Number(c.maxUses) : '∞'}`;
}

/** 有效期：`开始 ~ 到期`；两端都留空时写「永久」 */
function fmtWindow(c) {
  const from = c.startAt ? fmtTime(c.startAt) : '立即';
  const to = c.expireAt ? fmtTime(c.expireAt) : '永久';
  return `${from} ~ ${to}`;
}

/**
 * 适用范围的一句话描述。
 *
 * 只给「几个目标 + 前两个名字」：目标可能有上百个，逐条列出会把表格撑爆；
 * 完整名单在「显示全部」对话框里可以看到（悬停标题里放全量）。
 */
function fmtScope(c) {
  if (c.type === 'any') return '无门槛';
  const ids = c.type === 'links' ? (c.linkIds || []) : (c.userIds || []);
  const map = c.type === 'links'
    ? new Map(linksAll.map((l) => [l.id, l.fileName || l.id]))
    : new Map(usersAll.map((u) => [u.id, u.username || u.id]));
  const names = ids.map((id) => map.get(id) || id);
  const head = names.slice(0, 2).join('、');
  const more = names.length > 2 ? ` 等 ${names.length} 个` : '';
  return `${TYPE_LABEL[c.type] || c.type}：${head}${more}`;
}

/** `datetime-local` 的值 → ISO；空 → null。必须转 ISO：服务器与本机可能不同时区 */
function toIso(localValue) {
  const s = String(localValue || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/* ============================ 选择状态 ============================ */

function updateSelTip() {
  const alive = new Set(cache.map((x) => x.id));
  for (const id of Array.from(selected)) if (!alive.has(id)) selected.delete(id);
  const n = selected.size;
  const tip = document.getElementById('coupon-sel-tip');
  if (tip) tip.textContent = n ? `已选中 ${n} 张优惠券` : '未选中任何优惠券';
  for (const id of ['btn-coupon-disable', 'btn-coupon-enable']) {
    const b = document.getElementById(id);
    if (b) b.disabled = n === 0;
  }
}

/* ============================ 行渲染 ============================ */

function rowOf(c) {
  const sm = metaOf(c.status);
  const checked = selected.has(c.id);
  const dim = c.status === 'disabled' || c.status === 'expired' ? ' class="lk-dim"' : '';
  return `<tr data-id="${escapeHtml(c.id)}"${checked ? ' class="row-checked"' : ''}>
    <td><input type="checkbox" class="cp-ck"${checked ? ' checked' : ''}></td>
    <td><code class="cp-code" title="点击复制">${escapeHtml(c.code)}</code></td>
    <td title="${escapeHtml((c.type === 'links' ? (c.linkIds || []).join('\n') : (c.userIds || []).join('\n')))}">${escapeHtml(fmtScope(c))}</td>
    <td><b style="color:#b45309">${escapeHtml(yuan(c.amountFen))}</b></td>
    <td>${escapeHtml(fmtUses(c))}</td>
    <td>${c.perUserOnce ? '<span class="lk-badge ok">是</span>' : '<span class="lk-dash">—</span>'}</td>
    <td${dim}>${escapeHtml(fmtWindow(c))}</td>
    <td><span class="lk-badge ${sm.cls}">${sm.label}</span></td>
    <td class="lk-acts">
      <button class="mini-btn" data-act="toggle">${c.disabled ? '启用' : '停用'}</button>
      <button class="mini-btn danger" data-act="del">删除</button>
    </td>
  </tr>`;
}

/** 卡片与对话框**共用**同一个表格渲染器（避免两处列不一致） */
function tableHtml(list) {
  return `<table class="lk-table">
    <thead><tr>
      <th style="width:30px"><input type="checkbox" class="cp-all" title="全选当前列出的优惠券"></th>
      <th>券码</th><th>适用范围</th><th>优惠</th><th>使用</th><th>每人一次</th>
      <th>有效期</th><th>状态</th><th style="width:132px">操作</th>
    </tr></thead>
    <tbody>${list.map(rowOf).join('')}</tbody></table>`;
}

/** 行内交互（卡片与对话框共用） */
function bindRows(root, list) {
  root.querySelectorAll('tr[data-id]').forEach((tr) => {
    const c = list.find((x) => x.id === tr.dataset.id);
    if (!c) return;
    const ck = tr.querySelector('.cp-ck');
    if (ck) {
      ck.onchange = () => {
        if (ck.checked) selected.add(c.id); else selected.delete(c.id);
        tr.classList.toggle('row-checked', ck.checked);
        updateSelTip();
      };
    }
    const codeEl = tr.querySelector('.cp-code');
    if (codeEl) {
      codeEl.onclick = async () => {
        try {
          await navigator.clipboard.writeText(c.code);
          toast('券码已复制到剪贴板', { type: 'success' });
        } catch (e) { toast('复制失败，请手动选择券码', { type: 'warn' }); }
      };
    }
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.act === 'toggle') toggleOne(c);
        else if (btn.dataset.act === 'del') removeOne(c);
      };
    });
  });
  const all = root.querySelector('.cp-all');
  if (all) {
    all.onchange = () => {
      for (const tr of root.querySelectorAll('tr[data-id]')) {
        const ck = tr.querySelector('.cp-ck');
        if (!ck) continue;
        ck.checked = all.checked;
        if (all.checked) selected.add(tr.dataset.id); else selected.delete(tr.dataset.id);
        tr.classList.toggle('row-checked', all.checked);
      }
      updateSelTip();
    };
  }
}

/* ============================ 列表 ============================ */

function wire() {
  if (wired) return;
  wired = true;
  const r = document.getElementById('btn-coupons-refresh');
  if (r) r.onclick = () => refresh();
  const g = document.getElementById('btn-coupons-generate');
  if (g) g.onclick = () => openGenerate();
  const d = document.getElementById('btn-coupons-delete');
  if (d) d.onclick = () => removeSelected();
  const dis = document.getElementById('btn-coupon-disable');
  if (dis) dis.onclick = () => setSelectedDisabled(true);
  const en = document.getElementById('btn-coupon-enable');
  if (en) en.onclick = () => setSelectedDisabled(false);
  const clr = document.getElementById('btn-coupon-bulk-clear');
  if (clr) clr.onclick = () => { selected.clear(); render(); };
  const all = document.getElementById('btn-coupon-all');
  if (all) all.onclick = () => openDialog();
}

export function refresh() {
  wire();
  const box = document.getElementById('couponmgr-table');
  if (!box) return;
  /**
   * 链接 / 用户名单用于把 id 显示成人话；两条请求**失败不致命**（可能没链接、
   * 或旧版本没有该接口），失败时退化为直接显示 id —— 不能因为「名字查不到」
   * 就让整个优惠券页加载失败。
   */
  Promise.all([
    API.coupons(),
    API.links().catch(() => ({ links: [] })),
    API.users().catch(() => ({ users: [] })),
  ]).then(([r, lr, ur]) => {
    cache = r.coupons || [];
    linksAll = lr.links || [];
    usersAll = ur.users || [];
    render();
    if (dialog) dialog.repaint();
  }).catch((e) => {
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
}

function render() {
  const box = document.getElementById('couponmgr-table');
  const head = document.getElementById('couponmgr-count');
  if (!box) return;
  if (head) head.textContent = cache.length ? `（共 ${cache.length} 张）` : '';
  if (!cache.length) {
    box.innerHTML = '<div class="lk-empty">还没有优惠券。点「＋ 生成优惠券」创建——数量填 1 就是单独生成，填 N 就是批量生成。</div>';
    updateSelTip();
    updateMore();
    return;
  }
  box.innerHTML = tableHtml(cache.slice(0, COUPON_PREVIEW_LIMIT));
  bindRows(box, cache);
  updateSelTip();
  updateMore();
}

function updateMore() {
  const more = document.getElementById('coupon-more');
  const hint = document.getElementById('coupon-more-hint');
  const { over, hint: hintText } = previewMoreState(cache.length, COUPON_PREVIEW_LIMIT, '张优惠券');
  if (more) more.hidden = !over;
  if (hint) hint.textContent = hintText;
}

function openDialog() {
  if (dialog) { dialog.repaint(); return; }
  dialog = openListDialog({
    idPrefix: 'coupon-all',
    title: `全部优惠券（${cache.length}）`,
    cls: 'coupon-all-dialog',
    placeholder: '搜索券码 / 备注 / 适用范围',
    selects: [{
      id: 'status',
      title: '按状态筛选',
      value: '',
      options: [
        { value: '', text: '全部状态' },
        { value: 'active', text: '有效' },
        { value: 'not_started', text: '未开始' },
        { value: 'expired', text: '已过期' },
        { value: 'used_up', text: '已用尽' },
        { value: 'disabled', text: '已停用' },
      ],
    }],
    items: () => cache,
    filter: (all, state) => all.filter((c) => {
      if (state.filters.status && c.status !== state.filters.status) return false;
      const text = [c.code, c.note, fmtScope(c)].join(' ');
      // R78：参数顺序必须是 `(query, texts)` —— 写反成 `(text, state.query)` 之后，
      // 实际比较的是「用户输入是否包含用户输入」（`x.indexOf(x) === 0`），
      // 于是搜索框对结果**毫无影响**：不输入时全显示，输入了还是全显示。
      return matchesQuery(state.query, text);
    }),
    rowHtml: (list) => tableHtml(list),
    bindRows: (root, list) => bindRows(root, list),
    unit: '张',
    unitShort: '张',
    emptyAll: '还没有优惠券',
    emptyMatch: '没有匹配的优惠券',
    onClose: () => { dialog = null; },
  });
}

/* ============================ 单条 / 批量操作 ============================ */

async function toggleOne(c) {
  const next = !c.disabled;
  try {
    await API.updateCoupon(c.id, { disabled: next });
    toast(next ? '已停用该优惠券' : '已启用该优惠券', { type: 'success' });
    refresh();
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error' });
  }
}

async function removeOne(c) {
  const ok = await confirmDialog({
    title: '删除优惠券',
    message: `确定删除券码 <b>${escapeHtml(c.code)}</b>（${escapeHtml(yuan(c.amountFen))}）吗？<br><br>`
      + '<span style="color:var(--text-2)">删除后该券码<b>立即失效</b>，已支付的订单不受影响；此操作不可恢复。</span>',
    okText: '删除', danger: true, allowHtml: true,
  });
  if (!ok) return;
  try {
    await API.deleteCoupons([c.id]);
    selected.delete(c.id);
    toast('已删除', { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

async function setSelectedDisabled(disabled) {
  const ids = Array.from(selected);
  if (!ids.length) return;
  try {
    const r = await API.bulkUpdateCoupons(ids, { disabled });
    toast(`${disabled ? '已停用' : '已启用'} ${r.updated || 0} 张优惠券`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error' });
  }
}

async function removeSelected() {
  const ids = Array.from(selected);
  if (!ids.length) { toast('请先勾选要删除的优惠券', { type: 'warn' }); return; }
  const ok = await confirmDialog({
    title: '删除选中优惠券',
    message: `确定删除选中的 <b>${ids.length}</b> 张优惠券吗？<br><br>`
      + '<span style="color:var(--text-2)">删除后这些券码<b>立即失效</b>，已支付的订单不受影响；此操作不可恢复。</span>',
    okText: '删除', danger: true, allowHtml: true,
  });
  if (!ok) return;
  try {
    const r = await API.deleteCoupons(ids);
    selected.clear();
    toast(`已删除 ${r.removed || 0} 张优惠券`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 生成 ============================ */

function openGenerate() {
  const p = 'cp-gen';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="enc-warn">优惠券用于<b>付费下载</b>：买家在分享页填写券码后，价格会显示为
      <b>原价划线 + 优惠后价格</b>。数量填 <b>1</b> 就是单独生成，填 <b>N</b> 就是批量生成。</div>
    <div class="form-item">
      <label for="${p}-count">生成数量</label>
      <input type="number" id="${p}-count" class="full" min="1" step="1" value="1" autocomplete="off">
      <div class="hint">一次最多 200 张。</div>
    </div>
    <div class="form-item">
      <label for="${p}-type">适用范围</label>
      <select id="${p}-type" class="full">
        <option value="any">无门槛（所有付费链接）</option>
        <option value="links">限特定链接</option>
        <option value="users">限特定用户</option>
      </select>
    </div>
    <div id="${p}-pick-links" hidden></div>
    <div id="${p}-pick-users" hidden></div>
    <div class="form-item">
      <label for="${p}-amount">优惠金额（元）</label>
      <input type="number" id="${p}-amount" class="full" min="0.01" step="0.01" value="1.00" autocomplete="off">
      <div class="hint">优惠后最低支付 0.01 元；券面额大于文件价格时，实际优惠封顶到「原价 − 0.01 元」。</div>
    </div>
    <div class="form-item">
      <label for="${p}-uses">总使用次数</label>
      <input type="number" id="${p}-uses" class="full" min="0" step="1" value="0" autocomplete="off">
      <div class="hint">0 = 不限制。</div>
    </div>
    <label class="inv-bulk-item" style="display:flex;gap:8px;align-items:center;margin:6px 0 10px">
      <input type="checkbox" id="${p}-once"> 每个用户只能使用一次
    </label>
    <div class="form-item">
      <label for="${p}-start">开始时间</label>
      <input type="datetime-local" id="${p}-start" class="full" step="1">
      <div class="hint">留空 = 立即生效。</div>
    </div>
    <div class="form-item">
      <label for="${p}-end">到期时间</label>
      <input type="datetime-local" id="${p}-end" class="full" step="1">
      <div class="hint">留空 = 永久有效；要立即失效请用「停用」。</div>
    </div>
    <div class="form-item">
      <label for="${p}-note">备注</label>
      <input type="text" id="${p}-note" class="full" maxlength="64" autocomplete="off">
    </div>`;

  const linkBoxWrap = wrap.querySelector(`#${p}-pick-links`);
  const userBoxWrap = wrap.querySelector(`#${p}-pick-users`);
  let linkPicker = null;
  let userPicker = null;

  function ensureLinkPicker() {
    if (linkPicker) return linkPicker;
    linkPicker = buildTransferBox({
      /**
       * 需求原文是「可直接选择/搜索已有的**付费**链接」—— 故这里**只列已开启
       * 「需付费下载」且金额大于 0 的链接**：免费链接上填券没有任何意义，
       * 列出来只会让管理员选到一个「券永远用不上」的目标。
       */
      items: linksAll
        .filter((l) => l.paid && l.paid.required && Number(l.paid.amountFen) > 0)
        .map((l) => ({ id: l.id, label: l.fileName || l.id, sub: `付费 ${yuan(l.paid.amountFen)}` })),
      selectedIds: [],
      leftTitle: '可选链接', rightTitle: '已选链接',
      filterLabels: { all: '全部', left: '未选', right: '已选' },
      hint: '只列出已开启「需付费下载」的分享链接（免费链接上用券没有意义）。',
      countText: (t, s) => `共 ${t} 条付费链接，已选 ${s} 条`,
    });
    linkBoxWrap.appendChild(linkPicker.wrap);
    return linkPicker;
  }
  function ensureUserPicker() {
    if (userPicker) return userPicker;
    userPicker = buildTransferBox({
      items: usersAll.map((u) => ({ id: u.id, label: u.username || u.id, sub: roleLabel(u.role) })),
      selectedIds: [],
      leftTitle: '可选用户', rightTitle: '已选用户',
      filterLabels: { all: '全部', left: '未选', right: '已选' },
      hint: '「限特定用户」的券要求买家登录后才能使用（否则无从确认身份）。',
      countText: (t, s) => `共 ${t} 位用户，已选 ${s} 位`,
    });
    userBoxWrap.appendChild(userPicker.wrap);
    return userPicker;
  }

  const typeSel = wrap.querySelector(`#${p}-type`);
  typeSel.onchange = () => {
    const t = typeSel.value;
    linkBoxWrap.hidden = t !== 'links';
    userBoxWrap.hidden = t !== 'users';
    if (t === 'links') { ensureLinkPicker(); }
    if (t === 'users') { ensureUserPicker(); }
  };

  const modal = openModal({
    title: '生成优惠券',
    cls: 'coupon-dialog',
    body: wrap,
    foot: [
      { text: '取消' },
      { text: '生成', cls: 'primary', onClick: (overlay, close) => submitGenerate(overlay, p, close, linkPicker, userPicker) },
    ],
  });
  return modal;
}

async function submitGenerate(overlay, p, close, linkPicker, userPicker) {
  const count = Number(String(overlay.querySelector(`#${p}-count`).value || '').trim());
  if (!Number.isInteger(count) || count < 1) { toast('生成数量须为不小于 1 的整数', { type: 'warn' }); return; }
  const type = overlay.querySelector(`#${p}-type`).value;
  const amountRaw = String(overlay.querySelector(`#${p}-amount`).value || '').trim();
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0.01) { toast('优惠金额至少 0.01 元', { type: 'warn' }); return; }
  const usesRaw = String(overlay.querySelector(`#${p}-uses`).value || '').trim();
  const maxUses = usesRaw === '' ? 0 : Number(usesRaw);
  if (!Number.isInteger(maxUses) || maxUses < 0) { toast('总使用次数须为不小于 0 的整数（0 = 不限制）', { type: 'warn' }); return; }

  const startAt = toIso(overlay.querySelector(`#${p}-start`).value);
  const expireAt = toIso(overlay.querySelector(`#${p}-end`).value);
  if (startAt && expireAt && Date.parse(startAt) >= Date.parse(expireAt)) {
    toast('开始时间必须早于到期时间', { type: 'warn' }); return;
  }

  const body = {
    count, type, amount, maxUses,
    perUserOnce: Boolean(overlay.querySelector(`#${p}-once`).checked),
    startAt, expireAt,
    note: String(overlay.querySelector(`#${p}-note`).value || '').trim(),
  };
  if (type === 'links') {
    const ids = linkPicker ? linkPicker.getSelected() : [];
    if (!ids.length) { toast('请至少选择 1 个分享链接', { type: 'warn' }); return; }
    body.linkIds = ids;
  }
  if (type === 'users') {
    const ids = userPicker ? userPicker.getSelected() : [];
    if (!ids.length) { toast('请至少选择 1 个用户', { type: 'warn' }); return; }
    body.userIds = ids;
  }

  try {
    const r = await API.generateCoupons(body);
    close(null);
    const made = r.coupons || [];
    // 新生成的那批自动勾选：管理员最常见的下一步是「复制 / 分发」，少点一次
    selected = new Set(made.map((x) => x.id));
    toast(`已生成 ${made.length} 张优惠券`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('生成失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 重置 ============================ */

/** 供 main.js 在登出 / 换账号时清空残留（券码明文属上一个管理员会话的数据） */
export function reset() {
  cache = [];
  linksAll = [];
  usersAll = [];
  selected = new Set();
  dialog = null;
  const box = document.getElementById('couponmgr-table');
  if (box) box.innerHTML = '';
  const head = document.getElementById('couponmgr-count');
  if (head) head.textContent = '';
  const tip = document.getElementById('coupon-sel-tip');
  if (tip) tip.textContent = '未选中任何优惠券';
  const more = document.getElementById('coupon-more');
  if (more) more.hidden = true;
}
