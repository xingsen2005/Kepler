/**
 * PWA 前端接线 —— R70
 *
 * ## 这个模块只做两件事
 *
 *  ① 注册 Service Worker（`/sw.js`，服务端现场替换版本号）；
 *  ② 接住 `beforeinstallprompt`，把「可安装」这个**一次性的浏览器许可**存下来，
 *     等用户点菜单里的「安装到桌面」时再用掉。
 *
 * ## 为什么必须把事件存起来，而不是当场弹窗
 *
 * `beforeinstallprompt` 是浏览器给的「你随时可以调 prompt()」的一次性凭据，而且
 * **每页只发一次**。如果在事件里直接 `prompt()`（很多示例代码那么写），
 * 用户看到的是一个莫名其妙的弹窗；更糟的是 Chrome 会因此把它记成「已提示」，
 * 之后再点我们的菜单就永远调不出安装框了（`prompt()` 第二次返回空）。
 *
 * 所以正确顺序是：**事件只负责保存** `event.preventDefault()` + 存引用，
 * 真正的 `prompt()` 挂在用户主动点击上。
 *
 * ## 快捷方式的名称从哪来
 *
 * 不在这里。它来自 manifest 的 `name` / `short_name`，由 `server/pwa.js` 按
 * 「站点名称」现场生成 —— 前端拿不到、也改不了那个值（装完就固化在系统里）。
 * 本模块与名称唯一的关系是：**装完的记录**。见 `wasInstalled()`。
 *
 * ## 失败一律静默
 *
 * SW 注册失败、`caches` 不可用（隐私模式）、浏览器不支持 —— 全都不该影响主流程。
 * 最坏情况就是「没有离线外壳、没有安装入口」，而登录、上传、下载照常。
 * 反过来，若在这里 `throw`，会让 `main.js` 的 `init()` 连锁失败，那是拿核心功能
 * 去换一个增强功能。
 */

/** `beforeinstallprompt` 的未用凭据（null = 当前不可安装 / 已用掉） */
let deferredPrompt = null;

/** 已安装事件的回调集合（`appinstalled` 之后菜单项要立刻消失） */
const installListeners = new Set();

/** 菜单项元素 id（与 `index.html` 的 `#um-install` 逐字对应） */
const INSTALL_ITEM_ID = 'um-install';

/* ------------------------------ 环境判定 ------------------------------ */

/**
 * 是否已经跑在「装好的 App」里（独立窗口）。
 *
 * 两个判据都要，因为各平台实现不同：
 *  - `display-mode: standalone` —— Android Chrome / 桌面 Chrome、Edge 的 PWA 窗口；
 *  - `navigator.standalone === true` —— iOS Safari 的「添加到主屏幕」（它不实现
 *    `display-mode` 媒体查询，是历史遗留的私有属性）。
 *
 * 在独立窗口里不该再显示「安装到桌面」—— 已经装过了。
 */
export function isStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) { /* 老浏览器没有 matchMedia：退到下一条判据 */ }
  return window.navigator.standalone === true;
}

/**
 * 浏览器是否支持「由网页触发安装」。
 *
 * 只是能力探测，不代表现在真的能装（能不能装由 `canInstall()` 决定）。
 * Safari / Firefox 都不支持 `beforeinstallprompt`，它们各自有「添加到主屏幕」菜单，
 * 我们无法从页面触发，也不该假装可以。
 */
export function installSupported() {
  return typeof window !== 'undefined' && 'onbeforeinstallprompt' in window;
}

/**
 * 当前是否可以点「安装到桌面」。
 *
 * 三个条件缺一不可：
 *  ① 浏览器支持网页触发安装；
 *  ② 我们**确实收到过** `beforeinstallprompt`（拿到了凭据）；
 *  ③ 当前不在独立窗口里（没装过）。
 *
 * ⚠️ ② 才是真判据。`installSupported()` 为真时浏览器仍可能因为「已安装」「不满足
 * 可安装性（缺 SW / 缺图标 / 非安全上下文）」而不发事件 —— 那时点按钮只会静默失败。
 */
export function canInstall() {
  return Boolean(deferredPrompt) && !isStandalone();
}

/* ------------------------------ 安装流程 ------------------------------ */

/**
 * 触发安装。**必须由用户点击直接调用**（浏览器要求有用户手势）。
 *
 * @returns {Promise<'accepted'|'dismissed'|'unavailable'>}
 *   - `accepted`：用户确认，系统开始安装；
 *   - `dismissed`：用户点了取消（这是正常结果，不该报错）；
 *   - `unavailable`：没有可用凭据（已被用掉 / 环境不支持）。
 */
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const event = deferredPrompt;
  // 先清空：prompt() 只能用一次，留着会让 canInstall() 在装完后仍为真
  deferredPrompt = null;
  notifyInstallState();
  try {
    event.prompt();
    const choice = await event.userChoice;
    // `userChoice` 在部分实现里可能是 undefined（旧版 Edge），按未接受处理
    return (choice && choice.outcome) === 'accepted' ? 'accepted' : 'dismissed';
  } catch (e) {
    return 'dismissed';
  }
}

/** 通知所有订阅者「可安装状态可能变了」（菜单项据此显隐） */
function notifyInstallState() {
  for (const fn of installListeners) {
    try { fn(); } catch (e) { /* 单个回调抛错不影响其它订阅者 */ }
  }
}

/**
 * 订阅可安装状态变化。返回取消订阅函数。
 *
 * `main.js` 用它把「菜单项显隐」挂上来 —— 模块本身**不直接操作 DOM**，
 * 这样沙箱测试可以不建 DOM 就跑完整个安装流程。
 */
export function onInstallStateChange(fn) {
  if (typeof fn !== 'function') return () => {};
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/**
 * 把可安装状态刷到菜单项上（`#um-install` 的 hidden）。
 *
 * 单独抽出来是因为它有**三个触发时机**：`beforeinstallprompt` 到达、
 * `appinstalled` 到达、以及每次 `renderUserMenu()`（换账号 / 重新登录后要重刷，
 * 否则上一会话的显隐状态会残留）。
 */
export function syncInstallItem() {
  const show = canInstall();
  const el = document.getElementById(INSTALL_ITEM_ID);
  if (el) el.hidden = !show;
  // 两条分隔线跟随显隐：只在「安装到桌面」出现时才画，否则菜单里会留下悬空的横线
  for (const id of ['um-install-sep-top', 'um-install-sep']) {
    const sep = document.getElementById(id);
    if (sep) sep.hidden = !show;
  }
}

/* ------------------------------ SW 注册 ------------------------------ */

/**
 * 注册 Service Worker。
 *
 * 只在**安全上下文**（HTTPS 或 localhost）下有意义 —— 浏览器在明文 HTTP 上
 * 直接拒绝注册，而且这不算错误：本机 127.0.0.1 是安全上下文，局域网明文地址不是。
 * 因此失败一律吞掉，只在控制台留一条 debug 级信息。
 *
 * `scope: '/'` 与 `Service-Worker-Allowed: /` 呼应：SW 挂在根，才能拦到所有站内请求。
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // load 之后注册：不与首屏资源争带宽（SW 首装要下载脚本 + 后台填预缓存）
  const start = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* 明文 HTTP / 隐私模式 / 被策略禁用：没有离线外壳，但功能一切照常 */
    });
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/* ------------------------------ 初始化 ------------------------------ */

/**
 * 挂上全局事件监听并注册 SW。由 `main.js` 的 `init()` 调用**一次**。
 *
 * ⚠️ 刻意不 `await`：PWA 是增强能力，不该让 `init()` 的主链路（登录态探测、
 * 站点信息、协议提示）等它。
 */
export function initPwa() {
  // 收到凭据：只保存 + 通知，绝不在这里 prompt()（见文件头）
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notifyInstallState();
  });

  // 装好了：凭据作废，菜单项消失
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notifyInstallState();
  });

  // 同一文档生命周期内退出独立窗口（少见，但桌面端可以从窗口菜单切回标签页）
  try {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => notifyInstallState();
    if (mq && mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq && mq.addListener) mq.addListener(onChange); // Safari < 14
  } catch (e) { /* 没有 matchMedia：不影响主流程 */ }

  registerServiceWorker();
}