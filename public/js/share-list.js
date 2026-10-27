/**
 * 分享页「文件列表勾选」—— 独立静态脚本（**非** ES Module，也**非**内联脚本）
 *
 * ## 为什么是独立文件
 *
 * 与 `pay-poll.js` 同因：SEC-06 从 CSP 里移除了 `script-src 'unsafe-inline'`，
 * 分享页（`shareRoutes` 挂在 `app.use('/', …)` 之后）同样受该 CSP 约束，
 * 内联 `<script>` 会被浏览器直接拒绝执行。同源静态文件落在 `script-src 'self'` 之内。
 *
 * ## 为什么是 classic script 而不是 module
 *
 * 链接 id 由页面注入，而 `document.currentScript` 在 `type="module"` 中恒为 `null`。
 * 因此用普通脚本 + `data-link-id` 属性（与 `pay-poll.js` 同一形态）。
 *
 * ## 它做什么、不做什么
 *
 * 做：把**当前页**的勾选状态记进 `sessionStorage`，翻页回来还在；R52 起**首次打开默认
 * 全选**（需求：多条目分享页应默认选中全部）；提供「全选本页」与「清空选择」；提交时
 * 把**其它页**已勾/已取消的项补成隐藏字段，于是「勾选跨页累计」这件事对服务端而言
 * 仍是一次普通的带 `k` / `mode` 参数的 GET（表示形式见下方 `form.addEventListener('submit')`）。
 *
 * 不做：**不构造下载 URL、不自己发请求**。下载一定走页面里那个原生
 * `<form method="POST">`（R94 / 审核 M08-02 从 GET 改成 POST：勾选项塞进查询串时
 * Node 的 16KB 请求行上限会让"勾一半"这种中间区间直接 431，连服务端都进不来），
 * 因为下载响应是 `Content-Disposition: attachment`，
 * 交给浏览器导航才能拿到进度、取消与"另存为"，用 fetch 反而要把整个包读进内存。
 * 这也意味着**脚本没加载时页面仍然可用**（服务端已把本页渲染成全选，只能勾本页），
 * 是渐进增强而非硬依赖。
 *
 * ## 为什么用 sessionStorage 而不是 localStorage
 *
 * 分享页常常是"别人发给你的一条链接"。用 localStorage 会让同一台机器上不同链接的
 * 选择互相串味，而且关上浏览器后还留着。sessionStorage 随标签页结束而清空，
 * 更贴合"我这次想下这几个"的语义。链接 id 进 key，天然按链接隔离。
 */
(function () {
  'use strict';

  const self = document.currentScript;
  let linkId = (self && self.getAttribute('data-link-id')) || '';
  if (!linkId) {
    // 兜底：从地址栏取（本页恒为 /s/<id>）
    const m = /^\/s\/([^/]+)/.exec(location.pathname);
    linkId = m ? decodeURIComponent(m[1]) : '';
  }
  if (!linkId) return;

  const form = document.getElementById('sl-form');
  if (!form) return;

  const STORE_KEY = 'kepler.share.sel.' + linkId;
  const boxes = [].slice.call(form.querySelectorAll('input[type=checkbox][name=k]'));
  const countEl = document.getElementById('sl-count');
  const pageText = countEl ? countEl.textContent : '';

  /**
   * R52-04：**整份快照**的 key 清单（服务端以 `<script type="application/json"
   * id="sl-keys">` 注入，见 share-routes 的 `listPage`）。
   *
   * 默认全选是**跨页**语义：没有这份清单就只能知道本页这 50 个，"默认全选"会退化成
   * "默认全选本页"，第 2 页及以后的文件在用户什么都不做时反而不会被下载。
   * `complete` 表示**这份清单可信地覆盖了整份快照**（而不是退化成"本页这些框"）——
   * 它决定提交时能不能用 `mode=all` / `mode=exclude` 这两种紧凑表示：那两个形态的
   * 语义是"服务端按快照取全部/取补集"，客户端手里的清单不完整时用它，
   * 会把**用户从没看见过的条目**也算进去。
   */
  const snapshot = readAllKeys();
  const allKeys = snapshot.keys;

  /** 已选集合（跨页累计）。元素是对象 key 原样字符串。 */
  const stored = read();
  /**
   * R52-04：**从未初始化过 ⇒ 默认全选**；存储里有值（哪怕是空数组）⇒ 用用户的。
   *
   * ⚠️ 「用户清空后刷新」与「第一次打开」必须能区分开，否则用户清空选择、翻一页回来
   * 发现又全勾上了。判据是存储里**有没有这个键**，所以 `read()` 在缺失时返回 `null`
   * 而不是空集合；下面这次 `save()` 一写，它同时就成了"已初始化"的标记。
   */
  const selected = stored || new Set(allKeys);
  if (!stored) save();

  function readAllKeys() {
    const el = document.getElementById('sl-keys');
    if (el && el.textContent) {
      try {
        const arr = JSON.parse(el.textContent);
        if (Array.isArray(arr)) {
          const keys = arr.filter(function (x) { return typeof x === 'string' && x; });
          if (keys.length) return { keys: keys, complete: true };
        }
      } catch (e) { /* 注入了坏 JSON → 退化为本页 */ }
    }
    const out = [];
    for (let i = 0; i < boxes.length; i++) out.push(boxes[i].value);
    // complete:false ⇒ 只能按「本页这些框」理解，提交时不得使用 all / exclude
    return { keys: out, complete: false };
  }

  function read() {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (raw === null) return null; // R52：从未初始化（与"用户清空了"是两回事）
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : []);
    } catch (e) {
      // 隐私模式 / 存储被禁用：退化成"只有本页勾选"，功能仍然可用。
      // 同样返回 null：存储用不了就没有"已初始化"可记，否则刷新一次选择就丢了
      return null;
    }
  }

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(selected)));
    } catch (e) { /* 存不下就算了，不影响本次下载 */ }
  }

  function refresh() {
    for (let i = 0; i < boxes.length; i++) {
      const on = selected.has(boxes[i].value);
      boxes[i].checked = on;
      const row = boxes[i].closest ? boxes[i].closest('.sl-row') : null;
      if (row) row.classList.toggle('on', on);
    }
    if (countEl) {
      countEl.textContent = selected.size
        ? '已选 ' + selected.size + ' 项 · ' + pageText
        : pageText;
    }
  }

  for (let i = 0; i < boxes.length; i++) {
    boxes[i].addEventListener('change', function (e) {
      const k = e.target.value;
      if (e.target.checked) selected.add(k); else selected.delete(k);
      save();
      refresh();
    });
  }

  const allBtn = document.getElementById('sl-all');
  if (allBtn) {
    allBtn.addEventListener('click', function () {
      for (let j = 0; j < boxes.length; j++) selected.add(boxes[j].value);
      save();
      refresh();
    });
  }
  const noneBtn = document.getElementById('sl-none');
  if (noneBtn) {
    noneBtn.addEventListener('click', function () {
      // 「清空选择」清的是**全部**（含其它页），否则用户清完再翻页会发现"怎么还有"
      selected.clear();
      save();
      refresh();
    });
  }

  /**
   * 提交时补齐其它页的勾选，并给服务端一个**最短的选择表示**。
   *
   * R52-04：既然默认全选，"选中"往往就是整份快照（几千个 key）—— 全塞进 `?k=` 会把
   * 请求行撑爆（Node / nginx 都在几 KB 量级就拒），表现是点「下载选中」毫无反应。
   * 故按**最短**表示提交（三种形态的语义见 `share-routes.parseSelection` 的 `mode` 表）：
   *
   *  · 整份快照都被选中 → `mode=all`，一个 key 都不用补
   *  · 只取消掉少数几项 → `mode=exclude` + `x` = 那些**取消掉的** key
   *  · 只勾了少数几项   → 保持 R51 的形态：`k` = 勾中的那些（不带 `mode`）
   *
   * （「一个都没勾」时也要走 `mode=exclude` —— 见下方 `kFormCount === 0` 那段。）
   *
   * ⚠️ **排除集必须走 `x` 这个名字，不能也塞进 `k`**。表单里本页那些**已勾选**的
   * 复选框会自动提交成 `k`，而 `mode=exclude` 下 `k` 的语义是"要排除的" —— 两者
   * 混在一起，服务端会把用户**正要下载**的本页文件当成"取消掉"的排除掉，效果是
   * 「用户没动过的文件反而下不到了」。用一个独立字段名，服务端就能明确地
   * 「`mode` 出现时只认它自己那套参数」，本页的 `k` 自动失效、不必去动 DOM。
   *
   * ⚠️ 后两种紧凑形态**只在手里握着完整快照时**才可用（`snapshot.complete`）：
   * 它们的语义是"服务端按快照取全部 / 取补集"，清单不完整时用它会把用户从没见过的
   * 条目也算进去。退化情形（页面没注入清单）一律走 R51 的 `k` = 勾中的那些。
   *
   * ⚠️ 补齐项里**不含本页已勾选**的框（它们自己就是 `k`），但**必须含本页未勾选**的
   * （浏览器不提交未勾选的复选框，见上面 `offDeselected` 那段说明）。
   */
  form.addEventListener('submit', function () {
    // 先清掉上一次提交补进去的（用户按后退回来再提交时不会累积重复项）
    const old = form.querySelectorAll('input[data-sl-extra]');
    for (let d = 0; d < old.length; d++) old[d].parentNode.removeChild(old[d]);
    const onPage = new Set();
    let onPageChecked = 0;
    for (let j = 0; j < boxes.length; j++) {
      onPage.add(boxes[j].value);
      if (boxes[j].checked) onPageChecked += 1;
    }

    const offSelected = [];
    const offDeselected = [];
    selected.forEach(function (k) { if (!onPage.has(k)) offSelected.push(k); });
    for (let p = 0; p < allKeys.length; p++) {
      const k = allKeys[p];
      /**
       * ⚠️ `offDeselected` 必须**含本页**没勾的那些，不能像 `offSelected` 那样把本页剔掉。
       *
       * 两者的区别在于「表单会替我们提交什么」：`offSelected` 补的是**在别的页上勾了**
       * 的项，本页那些勾中的框会随表单自己提交，补一遍就重复了。而 `offDeselected` 是
       * 「**没勾**」的那些 —— 浏览器**不会**提交未勾选的复选框，所以本页没勾的项如果不
       * 在这里补出来，服务端在 `mode=exclude`（排除集）下根本收不到它，
       * 补集里就会把它算进来：用户明明取消勾了一个文件，下载包**仍然包含它**。
       * —— 这个洞在只有一页、且用户只在本页取消勾选时必然复现，是最常见的那条路径。
       */
      if (!selected.has(k)) offDeselected.push(k);
    }

    /**
     * 「最短表示」按**真正会发出去的 `k` 个数**比较，而不是拿两个互补集合的长度直接比。
     *
     * 朴素写法（`offDeselected.length < offSelected.length`）是拿苹果比橘子：
     * `k` 形态下本页**已勾**的框也会被表单提交，那部分没被算进 `offSelected`。
     * 于是 5 项里有 4 项选中、本页占 2 项时，「排除 1 项」其实比「列 3 项 k」更短，
     * 旧的比较却会选后者 —— 白丢一次收敛的机会，请求串还更长。
     */
    let mode = '';
    let extra = offSelected;
    let extraName = 'k';
    /** `k` 形态实际会发出去的 `k` 个数：本页勾中的框（表单自己提交）+ 其它页勾中的。 */
    const kFormCount = offSelected.length + onPageChecked;
    const allChosen = snapshot.complete && selected.size === allKeys.length
      && allKeys.every(function (k) { return selected.has(k); });
    if (allChosen) {
      mode = 'all';
      extra = [];
    } else if (snapshot.complete && (kFormCount === 0 || offDeselected.length < kFormCount)) {
      /**
       * ⚠️ `kFormCount === 0`（用户点了「清空选择」）**必须**走排除集，不能落到 `k` 形态。
       *
       * 一个都不勾时 `k` 形态会**一个 `k` 也不发**，而服务端把「既没有 `k` 也没有
       * `mode`」读成"整条分享"（那正是没有 JS 的列表页提交的形态，也是「打包下载全部」
       * 的形态）。于是用户清空后点「下载选中」会**把整条分享都拿下来** —— 与他刚做的
       * 操作正好相反，而且毫无提示。空选择唯一无歧义的写法是"排除掉全部"，
       * 服务端据此给 404「没有可下载的文件」，比默默下发全部诚实。
       */
      mode = 'exclude';
      extra = offDeselected;
      extraName = 'x'; // ⚠️ 见上：排除集必须与表单自动提交的 `k` 分开
    }

    for (let n = 0; n < extra.length; n++) {
      const hid = document.createElement('input');
      hid.type = 'hidden';
      hid.name = extraName;
      hid.value = extra[n];
      hid.setAttribute('data-sl-extra', '1');
      form.appendChild(hid);
    }
    if (mode) {
      const modeEl = document.createElement('input');
      modeEl.type = 'hidden';
      modeEl.name = 'mode';
      modeEl.value = mode;
      modeEl.setAttribute('data-sl-extra', '1');
      form.appendChild(modeEl);
    }
    if (!boxes.length && !extra.length) return; // 本页无复选框：交给「打包下载全部」那条链接
  });

  refresh();
})();
