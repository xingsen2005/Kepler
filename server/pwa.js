/**
 * PWA（渐进式网页应用）支持 —— R70
 *
 * ## 这个模块只做一件事：把**站点名称**变成 manifest 的 `name`
 *
 * 需求原文：「使网站可被安装为独立浏览器应用并创建桌面快捷方式运行」，并追加
 * 「生成的快捷方式的名称以用户在『站点名称』中填写的为准」。
 *
 * 快捷方式的名称**不是**前端能决定的：Windows / macOS / Android 在安装那一刻
 * 读的是 manifest 里的 `name`（退化到 `short_name`），装完之后就固化在系统里，
 * 网页再怎么改 `document.title` 都不会动它。所以 manifest **必须是动态生成的** ——
 * 静态文件只能写死一个名字，那就违背了这条需求。
 *
 * 因此：manifest 不能放成 `public/manifest.webmanifest`（静态），而要走这条路由，
 * 每次按 `cfg.site.siteName` 现场生成。这也是它**不设强缓存**的原因：
 * 管理员改完站点名称，下一步点「安装」就该拿到新名字，而不是 5 分钟后才变。
 *
 * ## 为什么单开一个模块而不塞进 `routes/site.js`
 *
 * 路由挂在 `/api` 下要过鉴权与 CSRF 头，而 manifest 是**浏览器自己去取**的
 * （`<link rel="manifest">`，不带自定义请求头、也不带会话 Cookie 的保证），
 * 所以它必须在 `/api` 之外、且匿名可达。同时它与「站点设置」是两个不同的关注点，
 * 一旦哪天要加 `shortcuts` / `screenshots`，改这里就够了。
 *
 * 暴露的信息量刻意与 `GET /api/site/info` 同级：站点名称、图标、主题色。
 * 图标路径是公开静态资源，没有任何凭据。
 */
const configStore = require('./config-store');

/** manifest 的公开路径 —— `index.html` 的 `<link rel="manifest">` 必须逐字用它 */
const MANIFEST_PATH = '/manifest.webmanifest';

/** 主题色与背景色：与 `public/css/style.css` 的 `--accent` / `--bg` 同值 */
const THEME_COLOR = '#0067c0';
const BACKGROUND_COLOR = '#f3f3f3';

/**
 * 图标清单。
 *
 * - `icon.svg` / `icon-192.png` / `icon-512.png`：白底圆角正方形的标准图标
 *   （`purpose: "any"`）。圆角烤进 SVG / PNG 本身，而不是交给系统裁 ——
 *   Windows 的快捷方式与任务栏对 SVG 圆角的支持不一致，烤进去才到处一致。
 * - `icon-maskable-512.png`：`purpose: "maskable"`，**满版白底、不烤圆角**，
 *   图形收敛到 80% 安全区内，交给 Android 按自己的形状（圆 / 方 / 水滴）裁切。
 *   少了这一条，Android 启动器上会出现「图标被切掉一角」的方形贴图。
 */
const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/**
 * 生成 manifest（**纯函数**：入参只有站点名称与版本，便于单测覆盖）。
 *
 * @param {{ siteName?: string, version?: string, description?: string }} src
 * @returns {object} 可直接 `JSON.stringify` 的 manifest 对象
 */
function buildManifest(src) {
  const site = src || {};
  /**
   * 站点名称就是**快捷方式的名称**，两条字段都原样给同一串字。
   *
   * 为什么不把 `short_name` 截短：Chrome / Edge 在创建桌面快捷方式时优先取
   * `short_name`（启动器里放不下才截断）。一旦我们在这里自作主张截成 12 个字符，
   * 「名称以站点名称为准」这条需求就只对了一部分 —— 而用户看到的是被截断的那个。
   * 名称超长时的截断交给系统（它会自己加省略号），不由我们猜。
   */
  const name = String(site.siteName || '').trim();
  const displayName = name || 'Kepler 对象存储管理系统';
  const version = String(site.version || '');
  return {
    /**
     * `id` 决定「同一个应用」的身份。缺省时浏览器用 `start_url` 推导，
     * 显式写上可避免将来改 `start_url`（比如加个查询串）被当成另一个应用、
     * 在系统里并存出两个快捷方式。
     */
    id: '/',
    name: displayName,
    short_name: displayName,
    description: String(site.description || '基于对象存储的云存储管理系统'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // 独立窗口里的方向不做限制：本系统是文件管理器，横竖屏都有意义
    orientation: 'any',
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    lang: 'zh-CN',
    dir: 'ltr',
    // 明确「不优先推荐原生应用」：本系统没有配套 App，留空会让某些启动器去商店找
    prefer_related_applications: false,
    icons: ICONS.map((i) => ({ ...i })),
    // 版本只进自定义字段（不进 name）：装机后要排查「装的是哪一版」靠它
    ...(version ? { kepler_version: version } : {}),
  };
}

/** 从当前配置取出站点名称（唯一真值来源仍是 `config-store`） */
function currentSiteName() {
  try {
    const s = configStore.siteView(configStore.load());
    return s && s.siteName ? s.siteName : '';
  } catch (e) {
    // 配置损坏时退回默认名：manifest 拿不到不该让页面 500（登录页也要能装）
    return '';
  }
}

/** 当前版本号（与「关于」卡片同源：`package.json`） */
function currentVersion() {
  try {
    return require('../package.json').version;
  } catch (e) {
    return '';
  }
}

/**
 * Service Worker 模板的路径。
 *
 * `public/sw.js` 是**模板**，由 `serveServiceWorker()` 现场替换版本号 ——
 * 它不能作为静态资源原样下发（`index.js` 把它挂在 `express.static` 之前）。
 */
const SW_TEMPLATE = require('path').join(__dirname, '..', 'public', 'sw.js');

/** 模板里的版本号占位符 */
const SW_VERSION_PLACEHOLDER = '__KEPLER_VERSION__';

/**
 * 把模板渲染成可下发的 SW 源码（**纯函数**，便于单测）。
 *
 * ⚠️ 替换必须**全局**（`split/join` 或 `replaceAll`），不能用 `String.replace(str, v)`。
 *
 * 历史上这条踩过一次真实的坑：模板里占位符出现在**两处**（文件头注释里解释它是什么，
 * 以及 `const VERSION` 那一行），而 `String.replace` 只替首处 —— 于是被替换的是**注释**，
 * 真正的常量一字未动，而响应里"看起来"确实少了一处占位符，探针不深查就发现不了。
 * 后果是缓存标签恒为 `dev`，**所有版本共用一个缓存**，发版后用户永远拿旧前端。
 *
 * 现在模板注释里已刻意不再写这个字面串（护栏 `R70-06` 会盯着），但函数本身仍然
 * 用全局替换 —— 双保险，且让「注释里写一次」这种无害的编辑不会变成线上事故。
 *
 * @param {string} template 模板源码
 * @param {string} version  版本号
 * @returns {string}
 */
function renderServiceWorker(template, version) {
  return String(template || '').split(SW_VERSION_PLACEHOLDER).join(String(version || '0.0.0'));
}

/**
 * 生成当前应下发的 SW 源码（读盘 + 替换）。
 *
 * @returns {Promise<string>}
 */
function serviceWorkerSource() {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    fs.readFile(SW_TEMPLATE, 'utf8', (err, src) => {
      if (err) return reject(err);
      resolve(renderServiceWorker(src, currentVersion() || '0.0.0'));
    });
  });
}

/** 下发 SW 时应带的响应头（抽出来是为了让测试能断言，而不用真跑 HTTP） */
const SW_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  /**
   * 浏览器只接受 `max-age` 不超过 86400 的 SW 脚本缓存，而 `no-cache`（可存、
   * 每次回源校验）才是「改了 SW 立刻生效」可预期的写法。
   */
  'Cache-Control': 'no-cache',
  /**
   * SW 默认作用域是脚本所在目录；本文件挂在根，显式声明一次让人一眼看出是 `/`。
   * 与前端 `register('/sw.js', { scope: '/' })` 呼应 —— 少了它，前端那句 scope
   * 会被浏览器拒绝（脚本在根时其实含义相同，但显式写不花钱）。
   */
  'Service-Worker-Allowed': '/',
};

/**
 * Express 处理器：下发注入了版本号的 SW。
 *
 * 与 `manifestHandler` 对称 —— 两个 PWA 端点都由本模块负责，`index.js` 只负责挂载。
 * 这样护栏可以直接调这里，而不是在测试里重写一份路由（重写的那份一旦与生产实现
 * 分叉，变异就再也打不到真正被执行的那一层）。
 */
function serviceWorkerHandler(req, res, next) {
  serviceWorkerSource().then((src) => {
    for (const [k, v] of Object.entries(SW_HEADERS)) res.setHeader(k, v);
    res.send(src);
  }).catch((err) => (next ? next(err) : res.status(500).end()));
}

/** 现场生成一份 manifest 对象 */
function manifest() {
  return buildManifest({
    siteName: currentSiteName(),
    version: currentVersion(),
    description: '基于对象存储的云存储管理系统',
  });
}

/**
 * Express 处理器。
 *
 * `Cache-Control: no-cache` = 「可以存，但每次用前必须回源校验」。
 * 配合 express 默认的 ETag，改过站点名称就立刻 200 新内容、没改则 304，
 * 既不会让用户装出一个旧名字的快捷方式，也不会每次启动都白传一份 JSON。
 */
function manifestHandler(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.send(JSON.stringify(manifest()));
}

module.exports = {
  MANIFEST_PATH,
  ICONS,
  THEME_COLOR,
  BACKGROUND_COLOR,
  buildManifest,
  manifest,
  manifestHandler,
  // `/sw.js` 的模板渲染与下发（与 manifest 对称：两个 PWA 端点都由本模块负责）
  SW_TEMPLATE,
  SW_VERSION_PLACEHOLDER,
  SW_HEADERS,
  renderServiceWorker,
  serviceWorkerSource,
  serviceWorkerHandler,
  // 版本号与站点名称：manifest 与 sw.js 同源（都是 package.json / config-store）
  currentVersion,
  currentSiteName,
};