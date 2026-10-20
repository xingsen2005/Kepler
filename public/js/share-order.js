/**
 * 分享页「复制订单号」—— 独立静态脚本（**非** ES Module，也**非**内联脚本）
 *
 * ## 为什么是独立文件
 *
 * 分享页由 `share-routes.js` 服务端渲染，而 SEC-06 之后 CSP 里没有
 * `script-src 'unsafe-inline'` —— 内联 `<script>` 会被浏览器直接拒绝执行。
 * 同源静态文件落在 `script-src 'self'` 之内，是这里唯一可用的形态
 * （与 `pay-poll.js` / `share-list.js` 同一约定）。
 *
 * ## 为什么是 classic script 而不是 module
 *
 * 无需参数注入，但保持一致：本文件只做事件委托，不依赖任何构建期注入。
 *
 * ## 复制策略
 *
 * ① 优先 `navigator.clipboard.writeText`（需要安全上下文：HTTPS 或 localhost）；
 * ② 不可用（明文 HTTP 的局域网地址是最常见的场景）时回退到
 *    「临时 textarea + `document.execCommand('copy')`」；
 * ③ 再失败就把焦点落到订单号本身并全选，让用户按 Ctrl+C —— 复制按钮失效时
 *    至少不能让用户无从下手：订单号是取回下载权限的唯一凭证。
 *
 * 订单号的真值来自按钮的 `data-copy-order`（服务端渲染时写入），
 * 本脚本不重新拼接、也不做任何"格式化"，避免与页面显示的号码出现差异。
 */
(function () {
  'use strict';

  const FEEDBACK_MS = 1600;

  /** 回退方案：临时 textarea + execCommand（明文 HTTP 下 clipboard API 不可用） */
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /** 全选页面上的订单号文本（最后一道兜底） */
  function selectOrderNo() {
    const el = document.getElementById('order-no');
    if (!el || !window.getSelection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function flash(btn, ok) {
    const old = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', old);
    btn.textContent = ok ? '已复制' : '请手动复制';
    setTimeout(function () { btn.textContent = old; }, FEEDBACK_MS);
  }

  function copy(text, btn) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash(btn, true);
      }).catch(function () {
        const ok = legacyCopy(text);
        flash(btn, ok);
        if (!ok) selectOrderNo();
      });
      return;
    }
    const ok = legacyCopy(text);
    flash(btn, ok);
    if (!ok) selectOrderNo();
  }

  document.addEventListener('click', function (e) {
    let el = e.target;
    // 事件委托：`closest` 在部分老浏览器上没有，这里手动向上找，避免为一个按钮引 polyfill
    while (el && el !== document.body && !(el.getAttribute && el.getAttribute('data-copy-order'))) {
      el = el.parentNode;
    }
    if (!el || !el.getAttribute) return;
    const value = el.getAttribute('data-copy-order');
    if (!value) return;
    e.preventDefault();
    copy(value, el);
  });
})();
