/** 订单管理页 —— 付费下载订单的流水与对账（视觉风格与「链接管理」保持一致） */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtTime } from './util.js';

let ordersCache = [];
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  const btn = document.getElementById('btn-orders-refresh');
  if (btn) btn.onclick = () => refresh();
  const clean = document.getElementById('btn-orders-clean');
  if (clean) clean.onclick = () => removeFailedOrders();
}

const STATUS_META = {
  pending: { label: '支付中', cls: 'warn' },
  paid: { label: '已支付', cls: 'ok' },
  failed: { label: '支付失败', cls: 'bad' },
  refunded: { label: '已退款', cls: 'refund' },
};

/** 退款的二次确认文案：本系统不代持资金，这一步只是记账 */
const REFUND_NOTICE = '由于本系统不代持资金，将此订单设置为已退款则代表已在其它渠道退还钱款给下载者，本系统仅作记账和标记。';

function fmtAmount(o) {
  return `¥${(Number(o.amountFen || 0) / 100).toFixed(2)}`;
}

/** 时间列：没有值时显示占位符，避免整列参差 */
function fmtTimeOrDash(v) {
  return v ? escapeHtml(fmtTime(v)) : '<span class="ord-dash">—</span>';
}

function fmtLink(o) {
  if (!o.linkExists) return '<span class="ord-dash" title="分享链接已被删除">已删除</span>';
  return `<button class="mini-btn" data-act="copy" title="${escapeHtml(o.linkUrl)}">复制链接</button>`;
}

function fmtDownloaded(o) {
  if (o.downloadedAt) {
    return `<span class="ord-yes" title="${escapeHtml(fmtTime(o.downloadedAt))}">已下载</span>`;
  }
  if (o.status === 'paid') return '<span class="ord-no">未下载</span>';
  return '<span class="ord-dash">—</span>';
}

/**
 * 汇总统计（抽成纯函数以便直接驱动测试）。
 *
 * **「已收」只统计「已支付」** —— 退款过的钱已经退回去了，账面上不能再算作收入，
 * 这是退款动作两个可见后果之一（另一个是支付凭证失效）。退款金额单独列出，
 * 否则管理员只会看到总额变少，却看不出是被自己退掉的那一笔。
 *
 * @param {Array<{status:string, amountFen:number}>} orders
 * @returns {{count:number, receivedFen:number, refundedFen:number}}
 */
export function computeTotals(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const sum = (st) => list
    .filter((o) => o.status === st)
    .reduce((s, o) => s + (Number(o.amountFen) || 0), 0);
  return { count: list.length, receivedFen: sum('paid'), refundedFen: sum('refunded') };
}

/** 已退款的行整行置灰 + 数据列划线（.row-refunded 与「文件已删除」的 .row-gone 同机制） */
export function rowClassOf(o) {
  return o && o.status === 'refunded' ? 'row-refunded' : '';
}

/**
 * 操作列：只有「已支付」的订单能退款。
 *
 * 其余状态给占位符而不是禁用按钮 —— 禁用按钮虽然列宽一致，但会让用户以为
 * 「再点几下就能解锁」；占位符明确传达"这一行没有可执行的操作"。
 */
export function fmtActions(o) {
  if (!o || o.status !== 'paid') return '<span class="lk-dash">—</span>';
  return '<button class="mini-btn danger" data-act="refund" title="标记为已退款（本系统不代持资金，仅作记账）">退款</button>';
}

export function refresh() {
  wire();
  const box = document.getElementById('ordermgr-table');
  if (!box) return;
  API.paymentOrders().then((r) => {
    ordersCache = r.orders || [];
    render();
  }).catch((e) => {
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
}

/**
 * 收入统计（R48）：总计收入 / 按文件的累计收入 / 累计售出次数 / 单价 / 来源存储桶。
 *
 * 抽成**纯函数**（与 `computeTotals` 同款）以便直接驱动测试 —— 这一块最容易被
 * 写成「看起来对、算起来错」：金额有没有扣退款、同一文件的多笔有没有并到一行、
 * 单价在改过价的情况下显示哪一个，每一处错了界面都照样渲染。
 *
 * 口径（与「付费订单」卡片的「已收」**同源**）：
 *  - 只有 `paid` 计入收入。`refunded` 的钱已经退回去了，再算作收入是虚增；它单独
 *    汇总成 `refundedFen` 供对照，否则管理员只会看到总额变少、看不出是被谁退掉的。
 *  - 归集的维度是**文件**（`fileKey`），不是链接：同一个文件可能被多条分享链接卖过，
 *    各条链接的单价还可能不同。「累计售出次数」= 该文件下 `paid` 订单的笔数。
 *  - 单价取**最近一次成交价**（`unitFen`），同时保留 `minFen`/`maxFen`：历史上改过价
 *    时界面显示区间而不是只报一个数 —— 只报最近价会让「累计收入 ÷ 次数」对不上单价，
 *    管理员会以为账算错了。
 *  - 桶名取该文件订单里第一个非空快照；全部为空则如实留空（界面显示「未知」），
 *    不猜（猜错等于把收入记到别的桶头上）。
 *
 * @param {Array<object>} orders `/payment/orders` 的行
 * @returns {{totalFen:number, refundedFen:number, soldCount:number, fileCount:number,
 *            files:Array<{key:string, fileName:string, fileKey:string, bucket:string,
 *                         count:number, revenueFen:number, unitFen:number,
 *                         minFen:number, maxFen:number, priceVaries:boolean, lastAt:string}>}}
 */
export function computeRevenue(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const paid = list.filter((o) => o && o.status === 'paid');
  const refundedFen = list
    .filter((o) => o && o.status === 'refunded')
    .reduce((s, o) => s + (Number(o.amountFen) || 0), 0);

  const byFile = new Map();
  for (const o of paid) {
    const fileKey = String(o.fileKey || '');
    const fileName = String(o.fileName || '');
    // 没有对象键的历史订单退化为按文件名归集；两类之间用前缀区分，
    // 避免一个名为 "a/b.txt" 的文件与某个同名对象键被并成一行。
    const key = fileKey ? `k:${fileKey}` : `n:${fileName}`;
    let it = byFile.get(key);
    if (!it) {
      it = {
        key, fileName, fileKey, bucket: String(o.bucket || ''),
        count: 0, revenueFen: 0,
        minFen: Number.POSITIVE_INFINITY, maxFen: Number.NEGATIVE_INFINITY,
        unitFen: 0, lastAt: '', priceVaries: false,
      };
      byFile.set(key, it);
    }
    const amt = Number(o.amountFen) || 0;
    it.count += 1;
    it.revenueFen += amt;
    it.minFen = Math.min(it.minFen, amt);
    it.maxFen = Math.max(it.maxFen, amt);
    // 最近一次成交（用于「单价」）：付款时间缺失时退回创建时间，两者都缺则保持原值
    const at = String(o.paidAt || o.createdAt || '');
    if (at >= it.lastAt) { it.lastAt = at; it.unitFen = amt; }
    if (!it.bucket && o.bucket) it.bucket = String(o.bucket);
  }

  const files = [...byFile.values()].map((it) => ({
    ...it,
    priceVaries: it.minFen !== it.maxFen,
    minFen: Number.isFinite(it.minFen) ? it.minFen : 0,
    maxFen: Number.isFinite(it.maxFen) ? it.maxFen : 0,
  })).sort((a, b) => b.revenueFen - a.revenueFen || String(a.fileName).localeCompare(String(b.fileName)));

  return {
    totalFen: paid.reduce((s, o) => s + (Number(o.amountFen) || 0), 0),
    refundedFen,
    soldCount: paid.length,
    fileCount: files.length,
    files,
  };
}

/** 金额（分 → ¥x.xx）。与 `fmtAmount` 同格式，但入参是「分」而不是整条订单。 */
function yuan(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

/** 单价的展示：改过价显示区间，否则一个数 */
function unitText(f) {
  return f.priceVaries ? `${yuan(f.minFen)} ~ ${yuan(f.maxFen)}` : yuan(f.unitFen);
}

function renderRevenue(orders) {
  const box = document.getElementById('revenue-table');
  const head = document.getElementById('revenue-summary');
  if (!box) return;
  const r = computeRevenue(orders);
  if (head) {
    head.textContent = `（总计 ${yuan(r.totalFen)} · 售出 ${r.soldCount} 次 · ${r.fileCount} 个文件`
      + (r.refundedFen ? ` · 已退款 ${yuan(r.refundedFen)} 不计入` : '') + '）';
  }
  if (!r.files.length) {
    box.innerHTML = '<div class="lk-empty">还没有已完成的付费订单，暂无收入。</div>';
    return;
  }
  box.innerHTML = `<table class="lk-table">
    <thead><tr>
      <th>文件</th><th>存储桶</th><th>单价</th><th>累计收入</th><th>累计售出次数</th>
    </tr></thead>
    <tbody>
      ${r.files.map((f) => `<tr>
        <td class="lk-file" title="${escapeHtml(f.fileKey || f.fileName)}">${escapeHtml(f.fileName || '(未记录文件名)')}</td>
        <td>${f.bucket ? `<code>${escapeHtml(f.bucket)}</code>` : '<span class="ord-dash" title="历史订单未记录存储桶，且对应分享链接已被删除">未知</span>'}</td>
        <td title="${f.priceVaries ? `历史成交价从 ${yuan(f.minFen)} 到 ${yuan(f.maxFen)}` : '最近一次成交价'}">${unitText(f)}${f.priceVaries ? ' <span class="ord-dash">(已调价)</span>' : ''}</td>
        <td><b style="color:#b45309">${yuan(f.revenueFen)}</b></td>
        <td>${f.count}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function render() {
  const box = document.getElementById('ordermgr-table');
  const head = document.getElementById('ordermgr-count');
  if (!box) return;

  const { count, receivedFen, refundedFen } = computeTotals(ordersCache);
  if (head) {
    head.textContent = count
      ? `（共 ${count} 笔 · 已收 ¥${(receivedFen / 100).toFixed(2)}`
        + (refundedFen ? ` · 已退款 ¥${(refundedFen / 100).toFixed(2)}` : '') + '）'
      : '';
  }

  // R48：收入统计卡片与订单表同源（同一份 ordersCache），因此不会出现
  // 「上面统计说收了多少、下面流水加起来对不上」这种两套口径的经典症状。
  renderRevenue(ordersCache);

  if (!ordersCache.length) {
    box.innerHTML = `<div class="lk-empty">还没有付费订单。为分享链接开启「需付费下载」后，下载者支付成功即会在此留下一笔记录。</div>`;
    return;
  }

  box.innerHTML = `<table class="lk-table">
    <thead><tr>
      <th>文件</th><th>文件链接</th><th>订单号</th>
      <th title="优惠前的链接标价">原价</th><th title="优惠后应支付的金额">应付</th>
      <th title="这张订单上实际减掉的金额">优惠</th><th title="实际收到的金额（未支付时为空）">实付</th>
      <th title="本笔订单使用的优惠券">优惠券</th>
      <th>支付方式</th>
      <th>创建时间</th><th>付款时间</th><th>支付状态</th><th>是否已下载</th><th style="width:90px">操作</th>
    </tr></thead>
    <tbody>
      ${ordersCache.map((o) => {
        const sm = STATUS_META[o.status] || { label: o.status || '未知', cls: '' };
        // 已退款：整行灰化 + 数据列划线，明确「这笔钱不算数了」；
        // 但状态列（徽章）与操作列保持可读 —— 与「文件已删除的分享链接」同一视觉语言。
        const dim = o.status === 'refunded' ? ' class="lk-dim"' : '';
        // 已带 class 的列只能追加类名（重复 class 属性会被 HTML 解析器丢弃）
        const dimExtra = o.status === 'refunded' ? ' lk-dim' : '';
        const refundTitle = o.refundedAt ? `退款时间：${escapeHtml(fmtTime(o.refundedAt))}` : '';
        /**
         * R62：原价 / 优惠 / 应付 / 实付 四列的口径（需求 7）。
         *  - 原价：链接当时的标价（订单快照，历史订单缺失时回退为实付）
         *  - 应付：原价 − 优惠（= 订单金额 amountFen，二者必须恒等）
         *  - 优惠：这张订单上**真的**减掉的钱（券面额超价时已封顶）
         *  - 实付：只有「已支付 / 已退款」才有值；未付时给占位符而不是 ¥0.00 ——
         *    「还没付」与「付了 0 元」是两件事。
         */
        const orig = Number(o.originalFen) > 0 ? Number(o.originalFen) : (Number(o.amountFen) || 0);
        const disc = Math.max(0, Number(o.discountFen) || 0);
        const payable = Math.max(0, orig - disc);
        const actuallyPaid = (o.status === 'paid' || o.status === 'refunded')
          ? (Number(o.amountFen) || 0) : null;
        return `<tr data-id="${escapeHtml(o.id)}"${rowClassOf(o) ? ` class="${rowClassOf(o)}"` : ''}>
          <td class="lk-file${dimExtra}" title="${escapeHtml(o.fileKey || o.fileName)}">${escapeHtml(o.fileName || '(未记录文件名)')}</td>
          <td>${fmtLink(o)}</td>
          <td class="ord-no-wrap${dimExtra}" title="${escapeHtml(o.tradeNo || '')}">${escapeHtml(o.orderNo || o.id)}</td>
          <td${dim}>${disc ? escapeHtml(yuan(orig)) : '<span class="ord-dash">' + escapeHtml(yuan(orig)) + '</span>'}</td>
          <td${dim}><b style="color:#b45309">${escapeHtml(yuan(payable))}</b></td>
          <td${dim}>${disc ? `<span style="color:#047857">−${escapeHtml(yuan(disc))}</span>` : '<span class="ord-dash">—</span>'}</td>
          <td${dim}>${actuallyPaid === null ? '<span class="ord-dash">—</span>' : `<b>${escapeHtml(yuan(actuallyPaid))}</b>`}</td>
          <td${dim}>${o.couponCode ? `<code title="${escapeHtml(o.couponId || '')}">${escapeHtml(o.couponCode)}</code>` : '<span class="ord-dash">—</span>'}</td>
          <td${dim}>${escapeHtml(o.platformName || o.platform || '—')}</td>
          <td${dim}>${escapeHtml(fmtTime(o.createdAt))}</td>
          <td${dim}>${fmtTimeOrDash(o.paidAt)}</td>
          <td><span class="lk-badge ${sm.cls}"${refundTitle ? ` title="${refundTitle}"` : ''}>${sm.label}</span></td>
          <td${dim}>${fmtDownloaded(o)}</td>
          <td class="lk-acts">${fmtActions(o)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const o = ordersCache.find((x) => x.id === tr.dataset.id);
    if (!o) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.act === 'copy') copyUrl(o);
        else if (btn.dataset.act === 'refund') refund(o);
      };
    });
  });
}

async function copyUrl(o) {
  const url = location.origin + o.linkUrl;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制到剪贴板', { type: 'success' });
  } catch (e) {
    openModal({
      title: '分享链接', body: `<textarea readonly style="width:100%;height:72px;border:1px solid var(--border-strong);border-radius:6px;padding:8px;font-size:12px;resize:none">${escapeHtml(url)}</textarea>`,
      foot: [{ text: '关闭' }],
    });
  }
}

/**
 * 标记订单为已退款。
 *
 * 这一步**不调用任何支付网关** —— 钱从未经过本系统服务器，退款是在渠道后台
 * 手动完成的。所以文案必须先说清楚这一点，避免管理员误以为点了就退钱到账。
 */
async function refund(o) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '标记为已退款',
    message: `确定将 <b>${escapeHtml(o.fileName || '(未记录文件名)')}</b> 的这笔 `
      + `<b style="color:#b45309">${escapeHtml(fmtAmount(o))}</b> 订单标记为已退款吗？<br><br>`
      + `<span style="color:var(--danger)">${escapeHtml(REFUND_NOTICE)}</span><br><br>`
      + '<span style="color:var(--text-2)">标记后该订单的支付凭证立即失效（下载者需重新支付），'
      + '且这笔金额不再计入「已收」。</span>',
    okText: '标记为已退款', danger: true,
  });
  if (!ok) return;
  try {
    await API.refundOrder(o.id);
    toast('已标记为退款：支付凭证已失效，该笔金额不再计入已收', { type: 'success', duration: 5000 });
    refresh();
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error' });
  }
}

/**
 * 删除全部「支付失败」的订单。
 *
 * 二次确认里带上**当前列表里待删的条数**，并且条数为 0 时也照常询问 ——
 * 按钮的可见后果必须可预期。不做「点一下什么都不发生」的静默分支：
 * 那会让管理员分不清是「确实没有可删的」还是「按钮坏了 / 请求没发出去」。
 *
 * 待删条数只是**展示用**的估算（基于本地缓存），真正的删改由服务端按
 * `paymentOrders.removeFailed()` 的判据执行，回包里的 `removed` 才是实际删除数。
 */
async function removeFailedOrders() {
  const n = ordersCache.filter((o) => o.status === 'failed').length;
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除失效订单',
    message: `确定删除全部处于 <b>支付失败</b> 状态的订单吗？<br><br>`
      + `<span style="color:var(--text-2)">当前列表中共 <b>${n}</b> 笔；仅删除本地订单记录，`
      + `「已支付」「已退款」以及仍在支付中的订单不受影响。</span>`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    const r = await API.deleteFailedOrders();
    const removed = (r && Number(r.removed)) || 0;
    toast(removed ? `已删除 ${removed} 笔失效订单` : '没有需要删除的失效订单', { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

/** 供 main.js 在登出 / 换账号时清空残留 */
export function reset() {
  ordersCache = [];
  const box = document.getElementById('ordermgr-table');
  if (box) box.innerHTML = '';
  const head = document.getElementById('ordermgr-count');
  if (head) head.textContent = '';
  // R48：收入统计同样按账号隔离 —— 订单是管理员可见的资产信息，换账号不得残留
  const rev = document.getElementById('revenue-table');
  if (rev) rev.innerHTML = '';
  const revHead = document.getElementById('revenue-summary');
  if (revHead) revHead.textContent = '';
}
