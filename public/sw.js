/**
 * Service Worker —— PWA 的可安装性与离线外壳（R70）
 *
 * ## 这个文件是**模板**，由 `server/index.js` 的 `GET /sw.js` 现场替换版本号
 *
 * 下面 `VERSION` 常量的初值是一个**占位符**，下发时会被换成 `package.json`
 * 的 `version`，作用是给**缓存命名**：每次发版缓存名都变，`activate` 里就把上一版
 * 的缓存整批删掉。不这么做的话，用户升级后仍会拿到旧的 `main.js`（`Cache-Control:
 * max-age=300` 本来只管 5 分钟，但 SW 缓存没有过期时间），表现是「服务端已经修好了，
 * 用户那边还是老样子」—— 而这个项目对「陈旧前端」的代价特别敏感（改完要说清哪一版）。
 *
 * ⚠️ 因此本文件**不能**原样作为静态资源下发：`GET /sw.js` 的路由刻意注册在
 *    `express.static` **之前**，它才是 `/sw.js` 的唯一提供者。
 *
 * ⚠️ 注释里刻意**不写那个占位符的字面串**。替换是全局的（`split/join`），
 *    凡是出现的地方都会被换掉；早先注释里写了一次、代码里写了一次，
 *    而旧实现用的是只替首处的 `String.replace` —— 于是被替换的是**注释**、
 *    真正的常量一字未动，且响应里"看起来"确实少了一处占位符，探针不深就发现不了。
 *
 * ## 缓存策略（三条，刻意都很短）
 *
 *  | 请求 | 策略 | 理由 |
 *  |---|---|---|
 *  | `/api/*`、`/s/*`、`/dav/*` | **不拦截** | 前两者含会话态与一次性数据（分享页是服务端按链接现场渲染的），放进缓存会造成「换账号看到别人的数据」「链接已过期但离线还能打开」 |
 *  | 导航请求 | **网络优先**，失败退回缓存的 `index.html` | 网络优先 = 升级后第一次打开就是新版本；缓存只为「装成 App 之后断网也能看到壳」 |
 *  | 同源静态资源 | **缓存优先 + 后台回源** | `index.html` 与 33 个 ESM 模块的请求数不小，且它们由版本号改名，不会跨版本混用 |
 *
 * ⚠️ 分享页 `/s/:id` 也是**导航请求**。它若被「导航失败退回 index.html」这条兜住，
 *    离线打开一个分享链接会看到登录页 —— 看起来像「链接被删了」或「要登录」，
 *    属于**用错的界面回答对的问题**。故它整段不拦截（见上面的 BYPASS）。
 */
'use strict';

/**
 * 版本号占位符。被替换成 `1.9.6` 这样的值。
 *
 * 万一本文件被**静态**下发（模板没被替换，比如有人直接访问 `public/sw.js` 的副本），
 * 也要能装得上 —— 只是缓存标签退化成 `dev`，绝不因为一个字符串把安装流程弄崩。
 * 那个判据看的是常量值是否仍以占位符前缀开头，而不是别处的字面串。
 */
const VERSION = '__KEPLER_VERSION__';
const TAG = VERSION.indexOf('__KEPLER') === 0 ? 'dev' : VERSION;

const SHELL_CACHE = 'kepler-shell-' + TAG;
const ASSET_CACHE = 'kepler-assets-' + TAG;
/** 本文件自己的缓存前缀：`activate` 只删这个前缀下**不属于当前版本**的那些 */
const CACHE_PREFIX = 'kepler-';

/**
 * 离线外壳的预缓存清单。
 *
 * 只有四项：入口 HTML、样式、主题脚本（它在 `<head>` 里同步执行，缺了会闪白）、
 * 以及根路径。**刻意不列 33 个 ESM 模块** —— 那份清单必然腐烂（新增模块时没人记得），
 * 而模块请求走「缓存优先 + 后台回源」，第一次打开时自然就都进了缓存。
 */
const SHELL = ['/', '/index.html', '/css/style.css', '/js/theme.js'];

/** 不进缓存的三类路径（见文件头表格）。`/s/` 同时覆盖分享页与其下载端点 */
const BYPASS_RE = /^\/(?:api|s|dav)(?:\/|$)/i;

/** 值得缓存的静态资源扩展名 */
const ASSET_RE = /\.(?:js|mjs|css|svg|png|ico|jpe?g|gif|webp|woff2?|webmanifest)$/i;

/** 是否不拦截（API / 分享 / WebDAV） */
function isBypassed(pathname) {
  return BYPASS_RE.test(String(pathname || ''));
}

/** 是否按「静态资源」缓存 */
function isAsset(pathname) {
  return ASSET_RE.test(String(pathname || ''));
}

/* ------------------------------ 安装 / 激活 ------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个 add 而不是 addAll：addAll 只要有一项失败就**整个安装失败**，
    // 于是某次误删 `css/style.css` 会让 PWA 连装都装不上（且界面上只表现为
    // 「安装按钮点了没反应」）。单项失败只该少一个离线资源。
    // `cache: 'reload'` 绕过 HTTP 缓存：否则刚发版时可能把**旧的** index.html 存进新缓存。
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    // 新 SW 立刻接管：否则用户要关掉所有标签页再重开才生效
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.indexOf(CACHE_PREFIX) === 0 && !keep.has(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ------------------------------ 请求策略 ------------------------------ */

/** 导航请求：网络优先，失败退回离线外壳 */
async function handleNavigation(event) {
  const request = event.request;
  try {
    const fresh = await fetch(request);
    // 只缓存「本站的页面」：SPA 的任意路径都返回同一份 index.html，
    // 统一存在 '/index.html' 这个键上，避免路径无穷多导致缓存条目膨胀。
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match('/index.html') || await cache.match('/');
    if (cached) return cached;
    throw e; // 连壳都没有（首访即断网）：如实失败，别假装成功
  }
}

/** 静态资源：缓存优先 + 后台回源（stale-while-revalidate） */
async function handleAsset(event) {
  const request = event.request;
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    // 只缓存 200 的**基本**响应：跨域重定向 / opaque 响应缓存下来是没法用的
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch((e) => {
    if (cached) return cached;
    throw e;
  });
  // 命中缓存就当次立刻返回，同时让上面那条网络请求继续跑（下次就是新的了）
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // 只处理 GET：POST/PUT/DELETE 一律交给网络（缓存写请求是另一个量级的复杂度）
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  // 跨源请求不拦（本系统没有外部静态依赖，出现即异常，交给网络如实失败）
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (isAsset(url.pathname)) {
    event.respondWith(handleAsset(event));
  }
});