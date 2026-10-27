/**
 * 邀请码设置页（R54 第 ③ 步，仅管理员）
 *
 * 需求原文：
 *  > 4、在左侧栏（side-foot）新增“邀请码设置”；
 *  > 4.1、管理员可批量生成、删除邀请码，并单独、批量设置邀请码的使用次数、
 *  >      过期时间、注册后的身份。
 *  >（用户追加）管理员可批量导出邀请码，文件格式为 txt，一行一个。
 *
 * ## 三处刻意的设计取舍
 *
 * ① **状态判定不做第二份**。同一类列表（`linkmgr.js`）有一条 `share-status.js`
 *    做前端判定，那是因为分享页与链接管理页都要用；而邀请码的「有效 / 已过期 /
 *    已用尽 / 已停用」**只有本页需要**，服务端 `invite-store.view()` 已经在每条记录上
 *    算好并随列表下发（`status` 字段）。再抄一份判定出来，唯一的收益是省下一个字段，
 *    代价是两处判据迟早分叉 —— 表现是「列表说有效、注册却提示已过期」。
 *    故这里只做 `status → 文案 + 徽章样式` 的**映射**，不做判定。
 *
 * ② **导出走 `request()` 拿文本再自己造 Blob，不能用 `<a href>` 直链**。
 *    服务端的导出端点是 POST（响应体是明文邀请码集合，GET 会把它写进浏览器历史与
 *    反向代理的 access log），而 `<a href>` 只能发 GET，且发不出 CSRF 的
 *    `X-Requested-With` 头。
 *
 * ③ **「全选」选的是当前容器里列出的行**，不是整个数据集。卡片只显示前
 *    `INVITE_PREVIEW_LIMIT` 条、对话框显示全部（可能还带搜索）—— 若「全选」恒为
 *    「全选数据集」，用户在筛选状态下点全选，会把看不到的行也一并导出 / 删掉。
 *    这与另外四张卡片「卡片与对话框共用同一个 rowHtml + bindRows」的形态一致。
 */
import { API } from './api.js';
import {
  toast, confirmDialog, openModal, escapeHtml, fmtTime, matchesQuery, previewMoreState, roleLabel,
} from './util.js';
import { openListDialog } from './listdialog.js';
// R71：只有根用户能发放「管理员」身份的邀请码 —— 界面按当前登录者的角色决定是否给出这一档
import { App } from './main.js';

/**
 * 卡片里最多显示多少条。
 *
 * 取 10（与「用户管理」「访问密钥」「存储桶管理」一致）：邀请码列表可能几百条，
 * 卡片本身只承担「这批码大概什么状态」的概览职责，逐条查看交给「显示全部」对话框
 * （带搜索 + 状态筛选）。分享链接卡片用 100，是因为链接是「一次性产物」、
 * 卡片就是它的主视图；邀请码不是。
 */
const INVITE_PREVIEW_LIMIT = 10;

/** 状态 → 展示文案与徽章样式（**只做映射，不做判定**，理由见文件头 ①） */
const STATUS_META = {
  active: { label: '有效', cls: 'ok' },
  expired: { label: '已过期', cls: 'bad' },
  used_up: { label: '已用尽', cls: 'warn' },
  disabled: { label: '已停用', cls: 'gone' },
};

let cache = [];
/** 已勾选的邀请码 id（**跨刷新保留**，但每次刷新会剔除已经不存在的 id） */
let selected = new Set();
let dialog = null;
let wired = false;

/* ============================ 工具 ============================ */

/** 邀请码状态映射（未知状态按「有效」以外最保守的展示处理：不显示为"有效"） */
function metaOf(st) {
  return STATUS_META[st] || { label: st || '未知', cls: 'gone' };
}

/**
 * 使用次数单元格：`已用 3 / 10`；不限制时写成 `已用 3 / ∞`。
 *
 * 与服务端 `view().remaining` 的语义对齐 —— `null` 表示不限制，**不是 0**。
 */
function fmtUses(l) {
  return `已用 ${Number(l.used) || 0} / ${Number(l.maxUses) > 0 ? Number(l.maxUses) : '∞'}`;
}

function fmtExpiry(l) {
  return l.expiresAt ? fmtTime(l.expiresAt) : '永久';
}

/**
 * ISO 时间 → `datetime-local` 的值（**本地时区**，且**带秒**）。
 *
 * 带秒不是为了好看：`<input type="datetime-local">` 缺省精度到分钟，来回一趟会把
 * 原有的秒截掉。若那枚码的到期时刻恰好落在「截断后已过去」的那一分钟里
 * （例如原始 10:00:30、截成 10:00），用户只是打开编辑框再保存，就会拿到一句
 * 「过期时间须晚于当前时间」—— 而他什么都没改。配上 `step="1"` 即可无损往返。
 */
function toLocalInput(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 下载纯文本文件。
 *
 * 这是本项目第三处「Blob + a.download」（另两处在 `backupcfg.js` 与 `enc.js`）——
 * 刻意各留一份：三处的**周边逻辑**并不相同（一个要带 MIME 的 JSON、一个是从 fetch
 * 拿到的 blob、这里是纯文本），而那 8 行本身是把浏览器既有 API 串起来，
 * 不存在「改一处漏一处」的判据成分。真正必须唯一实现的是**内容与文件名从哪来**，
 * 那是各调用方自己的事。
 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出文件名：`Kepler-invites-2026-10-16.txt`（ASCII，避免不同系统的编码差异） */
function exportFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Kepler-invites-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.txt`;
}

/* ============================ 页脚提示 / 选择状态 ============================ */

function selTipEl() {
  return document.getElementById('invite-sel-tip');
}

/** 刷新「已选 N 个」提示与批量设置栏的可用性（唯一的显示状态写入点） */
function updateSelTip() {
  // 剔除已被别人删掉的 id：否则「已选 5 个」里可能有 3 个早已不存在，
  // 点「应用到选中」会拿到一句"已跳过 3 个"而用户不知道说的是哪三个。
  const alive = new Set(cache.map((x) => x.id));
  for (const id of Array.from(selected)) if (!alive.has(id)) selected.delete(id);
  const el = selTipEl();
  if (el) el.textContent = selected.size ? `已选 ${selected.size} 个邀请码` : '未选中任何邀请码';
  const bulk = document.getElementById('btn-invite-bulk');
  if (bulk) bulk.disabled = selected.size === 0;
  const del = document.getElementById('btn-invites-delete');
  if (del) del.disabled = selected.size === 0;
}

/* ============================ 渲染 ============================ */

export function refresh() {
  wire();
  const box = document.getElementById('invitemgr-table');
  if (!box) return;
  API.invites().then((r) => {
    cache = r.invites || [];
    render();
  }).catch((e) => {
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
}

/** 换账号时清空（`main.js` 的 `resetMainView()` 调用）—— 邀请码是管理员侧数据，不跨会话保留 */
export function reset() {
  cache = [];
  selected = new Set();
  dialog = null;
  updateSelTip();
}

function render() {
  const box = document.getElementById('invitemgr-table');
  const head = document.getElementById('invitemgr-count');
  if (!box) return;
  if (head) head.textContent = cache.length ? `（共 ${cache.length} 个）` : '';
  if (!cache.length) {
    box.innerHTML = '<div class="lk-empty">还没有邀请码。点右上角「＋ 生成邀请码」批量生成。</div>';
    updateMore(0);
    repaintAll();
    updateSelTip();
    return;
  }
  const shown = cache.slice(0, INVITE_PREVIEW_LIMIT);
  box.innerHTML = inviteTableHtml(shown, selected);
  bindInviteRowActions(box, shown);
  updateMore(cache.length);
  repaintAll();   // 对话框开着时同步刷新：删掉一条后两边必须一致
  updateSelTip();
}

/**
 * 邀请码表格 HTML —— 卡片列表与「全部邀请码」对话框的**唯一渲染器**。
 *
 * 9 列的宽表格尤其不能抄两份：新增一列（比如以后加「生成者」）只会改到一处，
 * 另一处静默少一列，而表头与数据错位的表格在视觉上很难被立刻发现。
 */
function inviteTableHtml(list, checked) {
  const sel = checked || new Set();
  return `<table class="lk-table inv-table">
    <thead><tr>
      <th class="inv-check"><input type="checkbox" data-act="all" title="全选本列表"></th>
      <th>邀请码</th><th>身份</th><th>状态</th><th>使用情况</th><th>过期时间</th>
      <th>备注</th><th>创建时间</th><th style="width:210px">操作</th>
    </tr></thead>
    <tbody>
      ${list.map((l) => {
        const m = metaOf(l.status);
        // 已失效（过期 / 用尽 / 停用）的行灰化数据列 —— 与链接管理的 .lk-dim 同一形态，
        // 状态列与操作列保持可读（管理员正是要对着这两列决定改配额还是删掉）
        const dead = l.status !== 'active';
        const dim = dead ? ' class="lk-dim"' : '';
        return `<tr data-id="${escapeHtml(l.id)}">
          <td class="inv-check"><input type="checkbox" data-act="pick"
            data-id="${escapeHtml(l.id)}"${sel.has(l.id) ? ' checked' : ''}></td>
          <td class="inv-code"><code title="${escapeHtml(l.code)}">${escapeHtml(l.code)}</code></td>
          <td${dim}>${escapeHtml(roleLabel(l.role))}</td>
          <td><span class="lk-badge ${m.cls}">${escapeHtml(m.label)}</span></td>
          <td${dim}>${escapeHtml(fmtUses(l))}</td>
          <td${dim}>${escapeHtml(fmtExpiry(l))}</td>
          <td${dim}>${l.note ? escapeHtml(l.note) : '<span class="lk-dash">—</span>'}</td>
          <td${dim}>${escapeHtml(fmtTime(l.createdAt))}</td>
          <td class="lk-acts">
            <button class="mini-btn" data-act="copy" data-id="${escapeHtml(l.id)}">复制</button>
            <button class="mini-btn" data-act="edit" data-id="${escapeHtml(l.id)}">编辑</button>
            <button class="mini-btn" data-act="toggle" data-id="${escapeHtml(l.id)}">${l.disabled ? '启用' : '停用'}</button>
            <button class="mini-btn danger" data-act="del" data-id="${escapeHtml(l.id)}">删除</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
}

/**
 * 行内控件绑定 —— 卡片与对话框共用，否则对话框里的按钮会「看得见、点不动」。
 *
 * 「全选」的语义见文件头 ③：**只作用于传入的 `list`**（= 当前容器的数据集）。
 */
function bindInviteRowActions(root, list) {
  const all = root.querySelector('[data-act="all"]');
  if (all) {
    all.checked = list.length > 0 && list.every((l) => selected.has(l.id));
    all.onclick = () => {
      if (all.checked) list.forEach((l) => selected.add(l.id));
      else list.forEach((l) => selected.delete(l.id));
      // 就地更新可见的勾选框，避免整表重绘（重绘会让对话框滚动位置跳回顶部）
      root.querySelectorAll('[data-act="pick"]').forEach((cb) => {
        cb.checked = selected.has(cb.getAttribute('data-id'));
      });
      updateSelTip();
    };
  }
  root.querySelectorAll('[data-act="pick"]').forEach((cb) => {
    cb.onclick = () => {
      const id = cb.getAttribute('data-id');
      if (cb.checked) selected.add(id); else selected.delete(id);
      updateSelTip();
    };
  });
  root.querySelectorAll('button[data-act]').forEach((btn) => {
    const act = btn.getAttribute('data-act');
    const l = list.find((x) => x.id === btn.getAttribute('data-id'));
    if (!l) return;
    btn.onclick = () => {
      if (act === 'copy') copyCode(l);
      else if (act === 'edit') openEditDialog(l);
      else if (act === 'toggle') toggleDisabled(l);
      else if (act === 'del') removeOne(l);
    };
  });
}

function updateMore(total) {
  const more = document.getElementById('invite-more');
  const hint = document.getElementById('invite-more-hint');
  const { over, hint: hintText } = previewMoreState(total, INVITE_PREVIEW_LIMIT, '个邀请码');
  if (more) more.hidden = !over;
  if (hint) hint.textContent = hintText;
}

/** 重绘「全部邀请码」（对话框没开时是空操作） */
function repaintAll() {
  if (dialog) dialog.repaint();
}

/* ============================ 筛选 / 对话框 ============================ */

/**
 * 关键词匹配「邀请码」「备注」两个字段。
 *
 * 邀请码本身是最常用的定位方式（有人报"我这枚码用不了"，管理员直接把码粘进搜索框），
 * 备注是第二常用（"发给市场部那批"）。两者不会互相包含，合成一个框不会产生歧义。
 */
function filterInvites(list, query, status) {
  const want = String(status == null ? '' : status).trim();
  return (Array.isArray(list) ? list : []).filter((l) => (!want || String((l && l.status) || '') === want)
    && matchesQuery(query, [(l && l.code) || '', (l && l.note) || '']));
}

function showAllInvites() {
  if (dialog) return; // 连点两次不得叠出第二层遮罩（句柄在 onClose 里复位）
  dialog = openListDialog({
    idPrefix: 'invite-all',
    title: `全部邀请码（共 ${cache.length} 个）`,
    placeholder: '搜索邀请码或备注（不区分大小写）',
    cls: 'invite-all-dialog', // 9 列表格要的宽度（见 style.css）
    unit: '个邀请码',
    unitShort: '个',
    emptyAll: '还没有邀请码',
    emptyMatch: '没有匹配的邀请码',
    selects: [{
      id: 'status',
      title: '按状态筛选',
      value: '',
      options: [
        { value: '', text: '全部状态' },
        { value: 'active', text: STATUS_META.active.label },
        { value: 'expired', text: STATUS_META.expired.label },
        { value: 'used_up', text: STATUS_META.used_up.label },
        { value: 'disabled', text: STATUS_META.disabled.label },
      ],
    }],
    items: () => cache,
    filter: (list, st) => filterInvites(list, st.query, st.filters.status),
    rowHtml: (shown) => inviteTableHtml(shown, selected),
    bindRows: (list, shown) => bindInviteRowActions(list, shown),
    onClose: () => { dialog = null; },
  });
}

/* ============================ 表单（生成 / 编辑共用） ============================ */

/**
 * 「注册后的身份 / 使用次数上限 / 过期时间 / 备注」四个字段的 HTML。
 *
 * 生成与编辑共用一份：这两处的字段语义必须逐字一致，各写一份必然分叉
 * （加上一个字段只加到一边，症状是「批量能设、生成时设不了」）。
 *
 * @param {string} p 元素 id 前缀（同一时刻页面上只会有一个对话框，故不必带序号）
 * @param {object} [v] 回填值（编辑时有；生成时为空）
 */
function inviteFieldsHtml(p, v) {
  const val = v || {};
  const role = val.role === 'admin' ? 'admin' : 'user';
  /**
   * R71：**「管理员」这一档只对根用户渲染**。
   *
   * 服务端 `POST /invites` 会以 403 拦下管理员发 admin 码（那等于「添加管理员」）。
   * 界面上仍要隐藏它：留一个必然失败的选项，用户会以为是网络或后端出错，
   * 而不是「这件事不归我管」。
   */
  const canGrantAdmin = Boolean(App.state.user && App.state.user.role === 'root');
  /**
   * R94（审核 M02-03）：编辑一枚**根用户发放的 admin 码**时，非根管理员的下拉里没有
   * admin 档 ⇒ `readInviteFields()` 读到恒为 `'user'`，保存时随 `maxUses` / `expiresAt`
   * 一起提交；而服务端 `assertCanGrantRole` 只拦「改成 admin」，改回 user 一律放行 ——
   * 于是这枚码被**静默降权**，界面上没有任何提示（同一次操作，根用户做毫无问题）。
   *
   * 现在的处理：把该下拉置为 `disabled` **如实显示**当前身份，并让 `readInviteFields()`
   * 在禁用时**不提交 role 字段**（服务端 `buildPatch` 见不到 role ⇒ 保持原值）。
   */
  const lockedRole = !canGrantAdmin && role === 'admin';
  const hasExp = Boolean(val.expiresAt);
  const uses = Number(val.maxUses) > 0 ? Number(val.maxUses) : 0;
  return `
    <div class="form-row">
      <div class="form-item">
        <label>注册后的身份</label>
        <select id="${p}-role" class="full"${lockedRole ? ' disabled' : ''}>
          <option value="user"${role === 'user' ? ' selected' : ''}>普通用户</option>
          ${canGrantAdmin
            ? `<option value="admin"${role === 'admin' ? ' selected' : ''}>管理员</option>`
            : ''}
        </select>
        <div class="hint">用这枚邀请码注册出来的账户<b>直接获得</b>该身份。${canGrantAdmin
          ? '「管理员」仅根用户可发放。'
          : lockedRole
            ? '这枚码由根用户发放，其身份不可由你改动（只能改次数与有效期）。'
            : '「管理员」身份只有根用户可发放，如需管理员账户请联系根用户。'}</div>
      </div>
      <div class="form-item">
        <label>使用次数上限</label>
        <input type="number" id="${p}-uses" class="full" min="0" step="1" value="${uses}" autocomplete="off">
        <div class="hint"><b>0 表示不限制</b>。</div>
      </div>
    </div>
    <div class="form-row">
      <div class="form-item">
        <label>过期时间</label>
        <select id="${p}-exp-mode" class="full">
          <option value="never"${hasExp ? '' : ' selected'}>永久有效</option>
          <option value="at"${hasExp ? ' selected' : ''}>指定时间</option>
        </select>
      </div>
      <div class="form-item" id="${p}-exp-at-item"${hasExp ? '' : ' hidden'}>
        <label>到期时刻</label>
        <input type="datetime-local" id="${p}-exp-at" class="full" step="1"
          value="${hasExp ? escapeHtml(toLocalInput(val.expiresAt)) : ''}">
      </div>
    </div>
    <div class="form-item">
      <label>备注（可选）</label>
      <input type="text" id="${p}-note" class="full" maxlength="64" autocomplete="off"
        placeholder="批次用途 / 领用人" value="${escapeHtml(val.note || '')}">
    </div>`;
}

/** 让「过期时间」下拉切换「到期时刻」输入框的显隐（生成与编辑共用） */
function bindExpiryToggle(root, p) {
  const mode = root.querySelector(`#${p}-exp-mode`);
  const item = root.querySelector(`#${p}-exp-at-item`);
  if (mode && item) mode.onchange = () => { item.hidden = mode.value !== 'at'; };
}

/**
 * 读取并校验四个字段 → 可直接提交给接口的对象。
 *
 * ⚠️ 校验规则与**服务端 `limits.js` 同语义**，但**不是**同实现：前端这一层只为
 * 「少一次往返 + 更早给出提示」，服务端那一层才是判据（谁能保证请求一定来自本页面？）。
 * 两边对「0 = 不限制」这个反直觉取值的措辞刻意写得一字不差，免得用户在两处
 * 看到两种说法。
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function readInviteFields(root, p) {
  const out = {};
  /**
   * R94（审核 M02-03）：**禁用的下拉不参与提交**。
   *
   * 编辑一枚根用户发放的 admin 码时，非根管理员看到的下拉是 disabled 的「管理员」——
   * 若照旧读 `.value` 并提交，就等于把"我读到的值"当成"用户想改成的值"，
   * 服务端只拦「改成 admin」，于是这枚码会被静默降权。
   */
  const roleSel = root.querySelector(`#${p}-role`);
  if (roleSel && !roleSel.disabled) out.role = roleSel.value;
  const usesRaw = String(root.querySelector(`#${p}-uses`).value || '').trim();
  const uses = Number(usesRaw === '' ? 0 : usesRaw);
  if (!Number.isInteger(uses) || uses < 0) return { ok: false, error: '使用次数上限须为不小于 0 的整数（0 表示不限制）' };
  out.maxUses = uses;

  const mode = root.querySelector(`#${p}-exp-mode`).value;
  if (mode === 'at') {
    const raw = String(root.querySelector(`#${p}-exp-at`).value || '').trim();
    if (!raw) return { ok: false, error: '请选择到期时刻，或把「过期时间」改为永久有效' };
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) return { ok: false, error: '到期时刻格式不正确' };
    if (ms <= Date.now()) return { ok: false, error: '到期时刻须晚于当前时间；若要立即失效请使用「停用」' };
    out.expiresAt = new Date(ms).toISOString();
  } else {
    // `null` = 永久有效。**必须显式传**（服务端判据是「该字段是否出现」）——
    // 省略它会让「把一枚已设过期的码改回永久」静默失效。
    out.expiresAt = null;
  }
  out.note = String(root.querySelector(`#${p}-note`).value || '').trim();
  return { ok: true, value: out };
}

/* ============================ 生成 ============================ */

function openGenerateDialog() {
  const p = 'inv-gen';
  const modal = openModal({
    title: '生成邀请码',
    cls: 'invite-dialog',
    body: `
      <div class="enc-warn">邀请码相当于<b>免注册口令</b>：拿到它的人可以直接开设账户
        （身份由下面的设置决定）。请通过可信渠道分发，并优先用<b>过期时间</b>而不是无限次数来控制风险。</div>
      <div class="form-item">
        <label>生成数量</label>
        <input type="number" id="${p}-count" class="full" min="1" step="1" value="10" autocomplete="off">
        <div class="hint">一次最多 500 个。</div>
      </div>
      ${inviteFieldsHtml(p)}`,
    foot: [
      { text: '取消' },
      { text: '生成', cls: 'primary', onClick: (overlay, close) => submitGenerate(overlay, p, close) },
    ],
  });
  bindExpiryToggle(modal.overlay, p);
  return modal;
}

async function submitGenerate(overlay, p, close) {
  const countRaw = String(overlay.querySelector(`#${p}-count`).value || '').trim();
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 1) { toast('生成数量须为不小于 1 的整数', { type: 'warn' }); return; }
  const f = readInviteFields(overlay, p);
  if (!f.ok) { toast(f.error, { type: 'warn' }); return; }
  try {
    const r = await API.generateInvites(Object.assign({ count }, f.value));
    close(null);
    const n = (r.invites || []).length;
    toast(`已生成 ${n} 个邀请码`, { type: 'success' });
    /**
     * 生成之后**自动导出一次**？不做。原因：导出会把明文口令落到用户的下载目录，
     * 而「生成」与「分发」是两个独立动作（可能要先核对数量）。
     * 但把新生成的那批**自动勾选**上，用户点一次「导出 txt」就能拿到 —— 这是
     * 最常见的下一步，且不会替用户落下任何文件。
     */
    selected = new Set((r.invites || []).map((x) => x.id));
    refresh();
  } catch (e) {
    toast('生成失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 编辑（单条） ============================ */

function openEditDialog(l) {
  const p = 'inv-edit';
  const modal = openModal({
    title: '编辑邀请码',
    cls: 'invite-dialog',
    body: `
      <div class="enc-warn">邀请码：<code>${escapeHtml(l.code)}</code>
        （<b>码本身不可修改</b> —— 它已经发出去了；要作废请用「停用」或删除）</div>
      ${inviteFieldsHtml(p, l)}`,
    foot: [
      { text: '取消' },
      { text: '保存', cls: 'primary', onClick: (overlay, close) => submitEdit(overlay, p, l, close) },
    ],
  });
  bindExpiryToggle(modal.overlay, p);
  return modal;
}

async function submitEdit(overlay, p, l, close) {
  const f = readInviteFields(overlay, p);
  if (!f.ok) { toast(f.error, { type: 'warn' }); return; }
  try {
    await API.updateInvite(l.id, f.value);
    close(null);
    toast('已保存', { type: 'success' });
    refresh();
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 批量设置 ============================ */

/**
 * 把批量设置栏的三个控件拼成一个 PATCH 请求体。
 *
 * ⚠️ 「不修改」与「改成 0 / 改成永久」是**两件不同的事**，因此每个控件都有
 * 一个「不动它」的取值（次数框留空、过期下拉选「不修改」）：
 * 用「空即默认」的写法，「把次数改成 0（不限制）」这个合法意图会被读成「不修改」，
 * 而界面上不会有任何提示。
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function readBulkFields() {
  const out = {};
  const usesRaw = String((document.getElementById('inv-bulk-uses') || {}).value || '').trim();
  if (usesRaw !== '') {
    const n = Number(usesRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: '使用次数上限须为不小于 0 的整数（0 表示不限制）' };
    out.maxUses = n;
  }
  const mode = (document.getElementById('inv-bulk-exp-mode') || {}).value || 'keep';
  if (mode === 'never') out.expiresAt = null;
  else if (mode === 'at') {
    const raw = String((document.getElementById('inv-bulk-exp-at') || {}).value || '').trim();
    if (!raw) return { ok: false, error: '请选择到期时刻，或把「过期时间」改为「不修改」' };
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) return { ok: false, error: '到期时刻格式不正确' };
    if (ms <= Date.now()) return { ok: false, error: '到期时刻须晚于当前时间；若要立即失效请使用「停用」' };
    out.expiresAt = new Date(ms).toISOString();
  }
  const role = (document.getElementById('inv-bulk-role') || {}).value || '';
  if (role) out.role = role;
  if (!Object.keys(out).length) return { ok: false, error: '请先填写要修改的项（留空表示不修改）' };
  return { ok: true, value: out };
}

async function applyBulk() {
  if (!selected.size) { toast('请先勾选要设置的邀请码', { type: 'warn' }); return; }
  const f = readBulkFields();
  if (!f.ok) { toast(f.error, { type: 'warn' }); return; }
  const ids = Array.from(selected);
  try {
    const r = await API.bulkUpdateInvites(ids, f.value);
    toast(r.skipped
      ? `已设置 ${r.updated} 个，跳过 ${r.skipped} 个（已被删除）`
      : `已设置 ${r.updated} 个邀请码`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('设置失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 删除 ============================ */

async function removeOne(l) {
  const ok = await confirmDialog({
    allowHtml: true,
    title: '删除邀请码',
    message: `确定删除邀请码 <b>${escapeHtml(l.code)}</b> 吗？<br>`
      + '<span style="color:var(--text-2)">删除后该码<b>立即失效</b>，已用这枚码注册的账户不受影响。</span>',
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteInvites([l.id]);
    selected.delete(l.id);
    toast('已删除', { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

async function removeSelected() {
  if (!selected.size) { toast('请先勾选要删除的邀请码', { type: 'warn' }); return; }
  const n = selected.size;
  const ok = await confirmDialog({
    title: '批量删除邀请码',
    message: `确定删除选中的 ${n} 个邀请码吗？删除后它们立即失效，且不可恢复。`
      + '已用这些码注册的账户不受影响。',
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    const r = await API.deleteInvites(Array.from(selected));
    selected = new Set();
    toast(`已删除 ${r.removed} 个邀请码`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

/** 停用 / 启用（**可逆**，故不需要二次确认 —— 它与「删除」是两件事） */
async function toggleDisabled(l) {
  try {
    const r = await API.updateInvite(l.id, { disabled: !l.disabled });
    toast(r.invite && r.invite.disabled ? '已停用（该码立即无法注册）' : '已启用', { type: 'success' });
    refresh();
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 复制 / 导出 ============================ */

async function copyCode(l) {
  try {
    await navigator.clipboard.writeText(l.code);
    toast('邀请码已复制到剪贴板', { type: 'success' });
  } catch (e) {
    // 剪贴板 API 在非安全上下文 / 未授权时会拒绝 —— 退化成只读文本框让用户手抄
    openModal({
      title: '邀请码',
      body: `<textarea readonly style="width:100%;height:52px;border:1px solid var(--border-strong);border-radius:6px;padding:8px;font-size:13px;resize:none">${escapeHtml(l.code)}</textarea>`,
      foot: [{ text: '关闭' }],
    });
  }
}

/**
 * 导出为 txt（一行一个）。
 *
 * 勾了就用勾选的，没勾就导出**全部**（此时先确认一次 —— 全量导出等于把所有
 * 口令落到一个文件里，值得让管理员意识到这一点）。
 */
async function exportInvites() {
  const ids = Array.from(selected);
  if (!ids.length) {
    if (!cache.length) { toast('还没有邀请码可导出', { type: 'warn' }); return; }
    const ok = await confirmDialog({
      title: '导出全部邀请码',
      message: `未勾选任何邀请码，将导出全部 ${cache.length} 个。`
        + '导出的是明文口令，请妥善保管该文件。',
      okText: '导出',
    });
    if (!ok) return;
  }
  try {
    const text = await API.exportInvites(ids);
    if (!text) { toast('没有可导出的邀请码', { type: 'warn' }); return; }
    downloadText(exportFilename(), text);
    toast(`已导出 ${text.split('\n').filter(Boolean).length} 个邀请码`, { type: 'success' });
  } catch (e) {
    toast('导出失败：' + e.message, { type: 'error' });
  }
}

/* ============================ 接线 ============================ */

function wire() {
  if (wired) return;
  wired = true;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('btn-invites-refresh', () => refresh());
  on('btn-invites-generate', () => openGenerateDialog());
  on('btn-invites-export', () => exportInvites());
  on('btn-invites-delete', () => removeSelected());
  on('btn-invite-all', () => showAllInvites());
  on('btn-invite-bulk', () => applyBulk());
  on('btn-invite-bulk-clear', () => { selected = new Set(); refresh(); });
  const mode = document.getElementById('inv-bulk-exp-mode');
  const item = document.getElementById('inv-bulk-exp-at-item');
  if (mode && item) mode.onchange = () => { item.hidden = mode.value !== 'at'; };
}
