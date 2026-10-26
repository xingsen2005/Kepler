/**
 * 分享页「支付」相关的三段行为 —— 独立静态脚本（**非** ES Module，也**非**内联脚本）
 *
 * ① **支付结果轮询**（等待支付页 / 扫码页，靠 `#pay-state` 判定是否启用）
 * ② **选中扫码渠道即出码**（R93，靠单选钮上的 `data-qr="1"` 判定是否启用）
 * ③ **付费页「立即支付」的提交反馈**（R80，靠 `form[data-pay-submit]` 判定是否启用）
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
 *   <script src="/js/pay-poll.js" data-link-id="<链接 id>" defer></script>     // 等待页 / 扫码页
 *   <script src="/js/pay-poll.js" data-link-id="<链接 id>" defer></script>     // 付费页（表单带 data-pay-submit）
 *
 * ## 安全
 *  · 链接 id 先经 `encodeURIComponent` 再拼进 URL，不会造成路径注入；
 *  · 只做 `fetch` 轮询与 DOM 状态切换，不读写 localStorage，不引入任何外部资源；
 *  · 状态页是幂等的只读接口（`/pay/status` 内部自带 3 秒查询节流）；
 *  · 三段行为都以「页面上有没有对应元素」为开关，互不干扰，也不改变禁用脚本时的功能。
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
   * 第二部分：付费页「立即支付」的提交反馈（R80，R81 修正结论文案）
   *
   * 缺陷形态（用户原话：「点击『立即支付』没有任何反应」）：
   *   表单原生提交会让整个页面**毫无变化**地等下去 —— 微信 / PayPal 是真出网，
   *   最长 9 秒（`payment-gateway` 的 CHARGE_TIMEOUT_MS）；按钮既不变灰也没有转圈，
   *   期间连"我点到了"这件事都看不出来。更糟的是浏览器/插件/受限内嵌窗口
   *   （`<iframe sandbox>` 没有 allow-forms）**直接吞掉**提交：一点动静都没有，
   *   服务端日志里连一条请求都没有，用户与管理员都无法判断卡在哪一层。
   *
   * 这里做三件事，都是纯渐进增强（脚本被拦掉时表单照旧可用）：
   *   ① 提交瞬间：按钮禁用 + 文案改「正在创建支付订单…」+ 一行说明，让"点到了"
   *      立刻可见，同时防止连点产生多笔订单；
   *   ② 12 秒兜底：仍在原页 ⇒ 先**问服务端**这笔订单到底建了没有（`?probe=1`），
   *      再按答案说话，而不是凭"没动静"猜；
   *   ③ 按探测结果给出不同、且都能照做的提示。
   *
   * ## R81：为什么不能再写「订单可能没有创建成功」
   *
   * 那句话把两种完全不同的处境混成了一种，而且多半是错的：
   *
   *  · 处境 A（旧文案断言的那种）：POST 没到服务端。此时库里**没有**订单。
   *  · 处境 B（实际更常见）：订单**建好了**（后台可见「支付中」），服务端也已
   *    发出 302，但**浏览器跳去支付平台**这一步卡住了（到支付平台的域名被代理/
   *    防火墙拦、插件拦截跳转、支付平台很慢）。文档还停在原页 ⇒ 看门狗照响。
   *    这时让用户"重试一次"其实无害（复用在途订单、不会重复扣款），但"订单可能
   *    没有创建成功"会让用户/管理员一起去查错方向 —— 用户以为要重新下单，
   *    管理员去查"为什么没建单"，而真正的问题在跳转链路上。
   *
   * 探测接口是只读的（`?probe=1` 不触发网关查单），拿不到就如实说"无法确认"。
   * ================================================================ */
  const SUBMIT_TIMEOUT_MS = 12000;

  /**
   * ⚠️ 这里**不再提前 return**（R93）：第三部分（选中扫码渠道即出码）只用到 `form`，
   * 与下面的看门狗彼此独立。保持「没有表单就整段退出」会让那一段永远跑不到。
   */
  const form = document.querySelector ? document.querySelector('form[data-pay-submit]') : null;

  const note = document.getElementById('pay-submit-note');
  const btn = form ? form.querySelector('button[type=submit]') : null;
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

  /** 只读探针：问服务端「这笔订单现在是什么状态」，绝不触发网关查单 */
  function probeStatus(done) {
    const u = '/s/' + encodeURIComponent(linkId) + '/pay/status?probe=1';
    fetch(u, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { done((d && d.state) || 'unknown'); })
      .catch(function () { done('unknown'); });
  }

  /** 12 秒后仍在原页 —— 按服务端给出的真实状态说话 */
  function afterTimeout() {
    if (btn) { btn.disabled = false; btn.textContent = btnText; }
    showNote('已超过 12 秒仍未离开本页，正在向服务端确认订单是否已创建…', 'sub');
    probeStatus(function (state) {
      if (state === 'paid') {
        showNote('订单已支付，正在刷新本页…', 'sub');
        location.reload();
        return;
      }
      if (state === 'pending') {
        showNote('订单已经创建成功（后台状态：支付中），卡住的是「从本页跳转到支付平台」这一步，'
          + '不是下单失败。常见原因：到支付平台的网络被代理或防火墙拦截、浏览器插件拦截了跳转、'
          + '或支付平台响应很慢。'
          + '再点一次「立即支付」不会重复扣款（会复用这同一笔订单），可以放心重试；'
          + '若反复卡在这一步，请把这条提示告诉分享者 —— 服务端日志里能看到该订单的渠道与时间。', 'warn');
        return;
      }
      if (state === 'failed') {
        showNote('订单已创建，但向支付渠道下单失败了。请点「立即支付」重新发起；'
          + '若反复失败，请把这条提示告诉分享者（服务端日志里有渠道返回的具体原因）。', 'warn');
        return;
      }
      if (state === 'none') {
        showNote('服务端查不到这次提交对应的订单：说明提交**没有到达服务端**。'
          + '常见原因是网络中断、浏览器插件拦截了表单提交，或本页在受限的内嵌窗口中打开'
          + '（缺少 allow-forms）。请重试一次；若反复出现，请把这条提示告诉分享者。', 'warn');
        return;
      }
      showNote('已超过 12 秒仍未离开本页，且暂时无法向服务端确认订单状态。'
        + '本页可能处于断网、或用受限的内嵌窗口打开。请先刷新本页：'
        + '若订单已创建，刷新后会直接进入支付流程，不会重复扣款。', 'warn');
    });
  }

  if (form) form.addEventListener('submit', function (ev) {
    if (btn && btn.disabled) {
      // 第二次点击：直接吞掉，不产生第二笔订单（`disabled` 在部分浏览器上不拦回车，这里补一道）
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '正在创建支付订单…'; }
    showNote('正在向支付渠道创建订单，通常 1~2 秒；如需跳转支付平台，最长约 10 秒。请勿关闭本页。', 'sub');
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(afterTimeout, SUBMIT_TIMEOUT_MS);
  });

  // 从 bfcache 返回（用户按了「后退」）时，按钮可能仍是禁用状态 —— 复位
  window.addEventListener('pageshow', function () { reset(); });

  /* ================================================================
   * 第三部分：选中「能画二维码」的渠道 ⇒ 立刻出码（R93）
   *
   * 需求是「选了微信 / 支付宝当面付，就在本页画出付款二维码，并且不再显示
   * 『立即支付』」。难点在于**这一页是服务端渲染的**（CSP 不允许内联脚本，也引不了
   * 第三方二维码库），浏览器这边凭空画不出码 —— 码只能由服务端在**建单之后**给出。
   * 所以「切换渠道」这个动作必须变成一次提交；本段就是省掉那次点击的粘合剂：
   * 它提交的正是「立即支付」那张表单，**语义完全相同**，只是不需要用户再点一下。
   *
   * ## 为什么首次加载不自动提交
   *
   * 服务端会把第一个可用渠道预选中。若加载即提交，就等于**任何一次页面浏览都会
   * 建一笔订单** —— 爬虫、链接预览、用户单纯点开看看，全都会建单；而每笔订单还要
   * 真出网调一次网关下单接口（微信 Native / 支付宝当面付都是 POST 出网）。这既是
   * R14-03「灌单挤出在途订单」（`MAX_ORDERS_PER_LINK = 50`，超窗的 pending 会被裁掉）
   * 的复现路径，也会白烧网关配额。
   *
   * 所以只在 `change` 上挂：**用户明确换了渠道**才提交。没换渠道时页面上那个
   * 「立即支付」按钮照旧可用，与改造前完全一致。
   *
   * ## 为什么用 `data-qr` 而不是在前端写一份渠道名单
   *
   * 「谁能扫码」的唯一判定在服务端（`paymentGateway.supportsQr()`：微信恒为真，
   * 支付宝还要看后台选的 `mode`）。前端再抄一份名单，一旦后台改了模式就会两边打架 ——
   * 页面按旧名单提交，回来发现没有码。`data-qr` 是服务端那份判定的投影，不会漂。
   * ================================================================ */
  if (!form) return;

  form.addEventListener('change', function (ev) {
    const t = ev && ev.target;
    if (!t || t.name !== 'platform' || !t.checked) return;
    if (t.getAttribute('data-qr') !== '1') return;
    /**
     * 提交中（按钮已被上面的看门狗禁用）就不再触发：一次提交对应一笔订单，
     * 连着切换会连着建单、连着关旧单（R90 的三步原子要整圈重跑），没有必要。
     */
    if (btn && btn.disabled) return;
    // `requestSubmit()` 会真的派发 submit 事件 ⇒ 上面的看门狗照常生效。
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit(); // 极老的浏览器：不派发事件，但至少能提交
  });
})();
