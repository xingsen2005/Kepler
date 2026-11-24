/** 监控仪表盘 —— 存储用量 / 流量趋势 / 请求统计 / 操作日志 */
import { API } from './api.js';
import { fmtSize, fmtTime, escapeHtml, drawDonut, drawGroupedBars, drawStackedBars, drawHBars, isStaffRole } from './util.js';
import { App } from './main.js';

/** 操作日志为管理员专属（日志详情含用户名 / 客户端 IP / 对象键 / 桶名）—— SEC-07 */
function isAdmin() {
  return isStaffRole(App.state.user && App.state.user.role);
}

let timer = null;

export const dashboard = {
  init() {
    const btn = document.getElementById('btn-logs-refresh');
    const sel = document.getElementById('logs-level');
    if (btn) btn.onclick = () => loadLogs();
    if (sel) sel.onchange = () => loadLogs();
    /**
     * 这里原本自己挂了一个 `visibilitychange` 来停/起本模块的定时器。
     *
     * R111 收口到 `main.js` 的全局门（`App.state.pageHidden` + `resumeAllPolling`）：
     * 「什么时候算后台」全站只能有一份判据 —— 各模块各判一次，就会出现
     * 「仪表盘停了、速度轮询还在打」这种半停状态，而且很难发现（两个模块的判定
     * 都"看起来对"）。本模块只保留 tick 里的读门与数据未变不重绘。
     */
  },

  async refresh() {
    // 日志卡片按角色显隐：普通用户整卡隐藏且**不发起请求**（避免必然 403）
    const logsCard = document.getElementById('dash-logs-card');
    if (logsCard) logsCard.hidden = !isAdmin();
    startTimer();
    const jobs = [loadStorage(), loadSummary()];
    if (isAdmin()) jobs.push(loadLogs());
    await Promise.all(jobs);
  },

  showLogs() {
    // 从侧边栏“操作日志”进入：滚到日志卡片（普通用户该卡片已被隐藏）
    if (!isAdmin()) return;
    setTimeout(() => {
      const el = document.getElementById('logs-table');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  },
};

function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    // 后台标签页：不发请求（判据全站唯一，见 main.js 的 bindVisibilityGate）
    if (App.state.pageHidden) return;
    if (document.getElementById('dashboard').hidden) return;
    loadStorage(); loadSummary();
  }, 30000);
}

/* PERF-04：请求序号 —— 自动刷新（30s）与手动刷新会并发，慢的旧响应后到
   会把新结果覆盖掉。每次发起前自增，await 之后若自己不再是最新一次就丢弃。 */
let storageSeq = 0;
let summarySeq = 0;

/**
 * 上一次**画进图里**的数据签名（R111）。
 *
 * 30 秒一次的自动刷新里，绝大多数轮次拿到的数字与上一轮**完全一样**
 * （没人传没人删）。旧实现照样把环图重画一遍、把 4 行图例的 `innerHTML`
 * 整块重写 —— 画一次环图要走一遍 canvas 的尺寸/清屏/圆弧路径，图例则是把
 * 4 个 `<div>` 连同里面的 `<span>`/`<i>`/`<b>` 全部重建。而这段时间里画面
 * 一个像素都不会变。
 *
 * 判据取「参与绘制的那几个值」而不是整个响应：响应里含 `statTime`（每次请求
 * 都不同），拿它入签名等于永不命中。
 *
 * ⚠️ 「更新时间」那行**仍然每次都写** —— 它表达的是「这份数据是什么时候取的」，
 * 数据没变时更需要它保持新鲜；否则用户看到的是半小时前的时间戳，会以为页面挂了。
 * 这一行只有几十个字符，与环图重绘不是一个量级。
 */
let storageSig = null;

async function loadStorage() {
  const seq = ++storageSeq;
  try {
    const st = await API.storage();
    if (seq !== storageSeq) return; // 已有更新的刷新：丢弃本次响应
    App.state.storageInfo = st;
    const quota = App.state.quotaBytes || 0;
    const used = st.usedBytes || 0;
    const sig = `${used}|${quota}|${st.objectCount ?? '—'}|${st.estimated ? 1 : 0}`;
    if (sig !== storageSig) {
      drawDonut(document.getElementById('chart-donut'), used, quota);
      const pct = quota ? (used / quota * 100) : 0;
      document.getElementById('storage-legend').innerHTML = `
      <div class="lg-row"><span><i class="dot" style="background:#4f8ef7"></i>已用容量</span><b>${fmtSize(used)}${quota ? `（${pct.toFixed(1)}%）` : ''}</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#e6ebf2"></i>剩余容量</span><b>${quota ? fmtSize(Math.max(0, quota - used)) : '无限制'}</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#39b97b"></i>对象数量</span><b>${st.objectCount ?? '—'} 个</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#d97706"></i>配额上限</span><b>${quota ? fmtSize(quota) : '无限制'}</b></div>`;
      // 只在**成功画完**之后才记签名：中途抛错时保持旧签名，下一轮会重试
      storageSig = sig;
    }
    document.getElementById('storage-note').innerHTML =
      `数据来源：实时列举统计${st.estimated ? '（对象数超过单次扫描上限，此处为下界估算）' : ''} · 更新时间 ${escapeHtml(fmtTime(st.statTime))}<br>配额用于百分比展示，可点击左侧桶列表的编辑按钮按桶调整。`;
  } catch (e) {
    if (seq !== storageSeq) return;
    setDashError('存储用量加载失败：' + e.message);
  }
}

/** 同上的签名机制，用在流量 / 请求 / 类型三张图上（见 loadStorage 的说明） */
let summarySig = null;

async function loadSummary() {
  const seq = ++summarySeq;
  try {
    const s = await API.summary();
    if (seq !== summarySeq) return;
    App.state.statsSummary = s;
    /**
     * 指纹取**整份响应**：这三张图的每个入参（今日流量、今日成败、7 天序列、
     * 按类型聚合）都在里面，逐一列举只会漏掉将来新增的那个字段；而 7 天序列
     * 不过几十个数字，`JSON.stringify` 的开销远小于重画三张图。
     *
     * 将来若服务端往 summary 里加了**每次都变**的字段（例如时间戳），这里的
     * 指纹会恒不命中 —— 后果只是**退回旧行为**（每轮都重绘），不是画出错数据。
     * 这个偏向是刻意选的：宁可白画，也不能拿着过期数据当新鲜数据画。
     */
    const sig = JSON.stringify(s);
    if (sig === summarySig) return;
    const t = s.traffic;
    document.getElementById('today-up').textContent = fmtSize(t.todayUp);
    document.getElementById('today-down').textContent = fmtSize(t.todayDown);
    const rq = s.requests;
    document.getElementById('today-ok').textContent = rq.today.ok;
    document.getElementById('today-fail').textContent = rq.today.fail;
    const total = rq.today.ok + rq.today.fail;
    document.getElementById('today-rate').textContent = total ? ((rq.today.ok / total) * 100).toFixed(1) + '%' : '—';
    // 状态栏（正文为实时速度，今日累计放入悬停提示）
    document.getElementById('status-traffic').title =
      `今日流量 ↑${fmtSize(t.todayUp)} ↓${fmtSize(t.todayDown)}（正文为实时速度，近 10 秒平均）`;

    const labels = rq.days.map((d) => d.date.slice(5)); // MM-DD
    drawGroupedBars(document.getElementById('chart-traffic'), labels, [
      { name: '上传', color: '#4f8ef7', values: t.days.map((d) => d.up) },
      { name: '下载', color: '#39b97b', values: t.days.map((d) => d.down) },
    ]);
    drawStackedBars(document.getElementById('chart-requests'), labels, [
      { name: '成功', color: '#4f8ef7', values: rq.days.map((d) => d.ok) },
      { name: '失败', color: '#e5484d', values: rq.days.map((d) => d.fail) },
    ]);
    drawHBars(document.getElementById('chart-types'), rq.byType.map((x) => ({ type: x.type, ok: x.ok, fail: x.fail })));
    summarySig = sig; // 同上：三张图都画成功了才记签名
  } catch (e) {
    if (seq !== summarySeq) return;
    setDashError('统计数据加载失败：' + e.message);
  }
}

async function loadLogs() {
  const box = document.getElementById('logs-table');
  try {
    const level = document.getElementById('logs-level').value;
    const r = await API.logs({ limit: 200, level });
    if (!r.logs.length) {
      box.innerHTML = '<div style="color:#aaa;padding:16px;text-align:center">暂无日志</div>';
      return;
    }
    box.innerHTML = `<table><thead><tr><th style="width:150px">时间</th><th style="width:70px">级别</th><th style="width:110px">操作</th><th>详情</th></tr></thead>
      <tbody>${r.logs.map((l) => `<tr>
        <td>${escapeHtml(fmtTime(l.t))}</td>
        <td><span class="lv ${escapeHtml(l.level)}">${escapeHtml(l.level)}</span></td>
        <td>${escapeHtml(l.action)}</td>
        <td class="det">${escapeHtml(l.detail)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger);padding:10px">日志加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function setDashError(msg) {
  let el = document.querySelector('.dash-err');
  if (!el) {
    el = document.createElement('div');
    el.className = 'dash-err';
    document.getElementById('dashboard').prepend(el);
  }
  el.textContent = msg + '（若未配置密钥请先完成设置）';
}
