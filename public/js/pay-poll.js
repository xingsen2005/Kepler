/**
 * 分享页「支付」相关的两段行为 —— 独立静态脚本（**非** ES Module，也**非**内联脚本）
 *
 * ① **支付结果轮询**（等待支付页 / 二维码页，靠 `#pay-state` 判定是否启用）
 * ② **付费页「立即支付」的提交反馈**（R80，靠 `form[data-pay-submit]` 判定是否启用）
 *
 * ## 为什么必须是独立文件（R8-07）
 *
 * SEC-06 为了堵住整站 XSS 纵深，从 CSP 里移除了 `script-src 'unsafe-inline'`。
 * 但当时只为「主站那一个内联事件处理器」做了改造，分享页两个支付页里残留的
 * 内联 `<script>` 被漏掉了 —— 而 `shareRoutes` 挂在 `app.use('/', …)` 之后，
 * **同样受该 CSP 约束**，于是这段脚本被浏览器直接拒绝执行：
 * 「支付成功后本页会自动放行，无需其他操作」的承诺失效，用户停在「支付中…」，
 * 只能自己去点兜底按钮。抽成同源静态文件后落在 `script-src 'self'` 之内。
 *
 * ## 为什么是 classic script 而不是 module
 *
 * 参数只能由页面注入（链接 id 是动态的，无法写死在文件里），而
 * `document.currentScript` 在 `type="module"` 脚本中恒为 `null`。
 * 因此这里刻意使用普通脚本 + `data-link-id` 属性。
 *
 * 用法（由 `share-routes.js` 渲染）：
 *   <script src="/js/pay-poll.js" data-link-id="<链接 id>" defer></script>     // 等待页 / 二维码页
 *   <script src="/js/pay-poll.js" data-link-id="<链接 id>" defer></script>     // 付费页（表单带 data-pay-submit）
 *
 * ## 安全
 *  · 链接 id 先经 `encodeURIComponent` 再拼进 URL，不会造成路径注入；
 *  · 只做 `fetch` 轮询与 DOM 状态切换，不读写 localStorage，不引入任何外部资源；
 *  · 状态页是幂等的只读接口（`/pay/status` 内部自带 3 秒查询节流）；
 *  · 两段行为都以「页面上有没有对应元素」为开关，互不干扰，也不改变禁用脚本时的功能。
 */
(function () {
  'use strict';

  const self = document.currentScript;
  let linkId = (self && self.getAttribute('data-link-id')) || '';

  // 兜底：从地址栏取一次（POST 响应渲染的页面，location 仍是 /s/<id>/pay）
  if (!linkId) {
    const m = /^\/s\/([^/]+)\//.exec(location.pathname);
    linkId = m ? decodeURIComponent(m[1]) : '';
  }
  if (!linkId) return;

  /* ================================================================
   * 第一部分：支付结果轮询（等待支付页 / 二维码页）
   * ================================================================ */

  const url = '/s/' + encodeURIComponent(linkId) + '/pay/status';
  const INTERVAL_MS = 3000;
  const MAX_ROUNDS = 200; // 10 分钟：超过就停轮询，避免用户把页面开着过夜时无限打服务端

  let timer = null;
  let rounds = 0;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** 状态文案元素（两处支付页都用 #pay-state） */
  function stateBox() {
    return document.getElementById('pay-state');
  }

  function tick() {
    if (stopped) return;
    if (++rounds > MAX_ROUNDS) { stop(); return; }
    fetch(url, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) return;
        if (d.state === 'paid') {
          const box = stateBox();
          if (box) box.textContent = '已支付';
          stop();
          location.reload();
        } else if (d.state === 'failed') {
          stop();
          location.reload();
        }
      })
      .catch(function () { /* 网络抖动，下一轮再试 */ });
  }

  /**
   * 只有页面上真有「支付状态」元素（等待支付页 / 二维码页）才开轮询。
   *
   * R80：本文件现在**也被付费页（渠道选择页）引用**，用于那里的提交兜底提示。
   * 付费页没有 `#pay-state`，如果照旧无条件轮询，会每 3 秒白打一次
   * `/pay/status`（那时订单还不存在）。
   */
  if (stateBox()) {
    // 页面被切到后台时暂停轮询（省流量也省服务端），回到前台立即补一次
    document.addEventListener('visibilitychange', function () {
      if (stopped) return;
      if (document.hidden) {
        if (timer) { clearInterval(timer); timer = null; }
      } else if (!timer) {
        tick();
        timer = setInterval(tick, INTERVAL_MS);
      }
    });

    timer = setInterval(tick, INTERVAL_MS);
    tick(); // 立刻来一次，别让用户干等 3 秒
  }

  /* ================================================================
   * 第二部分：付费页「立即支付」的提交反馈（R80）
   *
   * 缺陷形态（用户原话：「点击『立即支付』没有任何反应」）：
   *   表单原生提交会让整个页面**毫无变化**地等下去 —— 微信 / PayPal 是真出网，
   *   最长 10 秒（`payment-gateway` 的 TIMEOUT_MS）；按钮既不变灰也没有转圈，
   *   期间连"我点到了"这件事都看不出来。更糟的是浏览器/插件/受限内嵌窗口
   *   （`<iframe sandbox>` 没有 allow-forms）**直接吞掉**提交：一点动静都没有，
   *   服务端日志里连一条请求都没有，用户与管理员都无法判断卡在哪一层。
   *
   * 这里做两件事，都是纯渐进增强（脚本被拦掉时表单照旧可用）：
   *   ① 提交瞬间：按钮禁用 + 文案改「正在创建支付订单…」+ 一行说明，让"点到了"
   *      立刻可见，同时防止连点产生多笔订单；
   *   ② 12 秒兜底：仍在原页 ⇒ 说明这次提交没有拿到响应（网络 / 拦截 / 被沙箱吞），
   *      就地显示可照做的提示与重试入口，而不是让用户对着静止的页面猜。
   * ================================================================ */
  const SUBMIT_TIMEOUT_MS = 12000;

  const form = document.querySelector ? document.querySelector('form[data-pay-submit]') : null;
  if (!form) return;

  const note = document.getElementById('pay-submit-note');
  const btn = form.querySelector('button[type=submit]');
  const btnText = btn ? btn.textContent : '';
  let submitTimer = null;

  function showNote(text, cls) {
    if (!note) return;
    note.textContent = text;
    note.className = cls;
    note.hidden = false;
  }

  function reset() {
    if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
    if (btn) { btn.disabled = false; btn.textContent = btnText; }
    if (note) { note.hidden = true; note.textContent = ''; }
  }

  form.addEventListener('submit', function (ev) {
    if (btn && btn.disabled) {
      // 第二次点击：直接吞掉，不产生第二笔订单（`disabled` 在部分浏览器上不拦回车，这里补一道）
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '正在创建支付订单…'; }
    showNote('正在向支付渠道创建订单，通常 1~2 秒；如需跳转支付平台，最长约 10 秒。请勿关闭本页。', 'sub');
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(function () {
      if (btn) { btn.disabled = false; btn.textContent = btnText; }
      showNote('没有收到服务器的响应：订单可能没有创建成功。'
        + '常见原因是网络中断、浏览器插件拦截了表单提交，或本页在受限的内嵌窗口中打开。'
        + '请重试一次；若反复出现，请把这条提示告诉分享者（服务端可查审计日志）。', 'warn');
    }, SUBMIT_TIMEOUT_MS);
  });

  // 从 bfcache 返回（用户按了「后退」）时，按钮可能仍是禁用状态 —— 复位
  window.addEventListener('pageshow', function () { reset(); });
})();
