/**
 * 第七十轮 · PWA（可安装 / 桌面快捷方式）—— R70
 *
 * ## 需求原文与它拆出来的四条可断言事实
 *
 *  ① 「添加完整的 PWA 支持，使网站可被安装为独立浏览器应用」——
 *     manifest 齐备（name / start_url / scope / display:standalone / 192+512 图标）
 *     + Service Worker 注册 + 页面声明 manifest link；
 *  ② 「创建桌面快捷方式运行」—— 浏览器判定可安装后才有入口；
 *  ③ 「**快捷方式的名称以用户在『站点名称』中填写的为准**」——
 *     manifest 的 `name` / `short_name` 必须**随配置动态变化**；
 *  ④ 「SVG 图标加白底和圆角正方形」—— 图标四角透明（圆角外）、中心为图形主色、
 *     maskable 版满版白底（不烤圆角，交系统裁切）。
 *
 * ## 本文件守的四个「改坏了也不报错」的点
 *
 *  - **manifest 退回静态文件**：界面照常，只是快捷方式永远叫一个写死的名字（违背③）；
 *  - **`short_name` 被截短**：Chrome/Edge 建快捷方式优先取 `short_name`，
 *    于是「名称以站点名称为准」只对了一半，而用户看到的是被截断的那个；
 *  - **SW 不替换版本号**：缓存名恒定 ⇒ 发版后用户永远拿旧前端。
 *    ⚠️ 这个坑本文件要专门守：占位符在注释与代码里都出现过，而 `String.replace`
 *    只替首处 —— 于是被替换的是注释、常量没动。故判据必须落在**代码行**上，
 *    而不是「响应里还有没有这个字符串」。
 *  - **SW 把 `/api` `/s` `/dav` 也缓存**：换账号看到别人的数据、过期链接离线仍能打开。
 *
 * ⚠️ 数据目录在 require 之前指向临时目录（`config-store` 加载时解析路径）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { test } = require('node:test');
const {
  assert, assertEqual, assertMatch, makeTempDir, request,
} = require('./helpers.js');

const tmp = makeTempDir('s3-pwa-');
process.env.S3_DATA_DIR = tmp.dir;

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const express = require(path.join(ROOT, 'node_modules', 'express'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const pwa = require(path.join(ROOT, 'server', 'pwa.js'));
const pkg = JSON.parse(read('package.json'));

const INDEX_HTML = read('public/index.html');
const SW_TEMPLATE = read('public/sw.js');
const PWA_JS = read('public/js/pwa.js');
const SERVER_INDEX = read('server/index.js');

/**
 * 起一个只挂 PWA 两条路由的本地服务。
 *
 * ⚠️ 必须挂**生产的那两个 handler**（`pwa.manifestHandler` / `pwa.serviceWorkerHandler`），
 * 不能在测试里重写一份等价路由：重写的那份一旦与生产实现分叉，针对生产的反向变异
 * 就再也打不到这里实际跑的代码（**判据没落在被执行的那一层**，`fail=0` 假绿）。
 */
async function serve() {
  const app = express();
  app.get(pwa.MANIFEST_PATH, pwa.manifestHandler);
  app.get('/sw.js', pwa.serviceWorkerHandler);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: (err && err.message) || 'ERR' });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/* ==================================================================
 * ① manifest 的结构与动态命名（需求③：快捷方式名称）
 * ================================================================== */

test('R70-01 · manifest 名称跟随站点设置（快捷方式名称的唯一来源）', () => {
  // 纯函数层：同一个入参只决定一件事 —— 名字
  const m1 = pwa.buildManifest({ siteName: '市场部文件库' });
  assertEqual(m1.name, '市场部文件库', 'name 必须原样取站点名称');

  /**
   * ⭐ `short_name` 的判据必须用**足够长**的站点名称。
   *
   * Chrome/Edge 建桌面快捷方式时优先取 `short_name`（启动器里放不下才截断）。
   * 一旦实现里自作主张截短，「名称以站点名称为准」就只对了一半，而用户看到的是
   * 被截断的那个。这里刻意用一个远超常见截断长度（12 / 15 / 20）的中文名：
   * 早先本用例拿「市场部文件库」（6 字）去断言，`slice(0,12)` 根本截不到它，
   * 于是反向变异 `R70-01b` 跑出 fail=0 —— 护栏看着覆盖了，实际一点没抓到。
   */
  const longName = '公司内部资料共享与归档管理系统';
  const mLong = pwa.buildManifest({ siteName: longName });
  assertEqual(mLong.short_name, longName,
    `short_name 必须与 name 同值、**不得截短**（实际 ${JSON.stringify(mLong.short_name)}）—— `
    + '一旦截短，「名称以站点名称为准」就只对了一半，而用户看到的是被截断的那个');
  assertEqual(mLong.name, longName, '长名的 name 同样要原样保留');
  assertEqual(mLong.short_name.length, mLong.name.length,
    'short_name 与 name 必须等长（截短即违背需求）');

  // 空 / 未设置时退回默认名，不能是空串（空 name 会让 manifest 直接不可安装）
  const m2 = pwa.buildManifest({ siteName: '' });
  assertMatch(m2.name, /\S/, '站点名称为空时应退回默认名，而不是空串');
  const m3 = pwa.buildManifest({});
  assertMatch(m3.name, /\S/, '入参缺失时同样要有默认名');
  // 首尾空白必须剔掉：Windows 快捷方式名里带尾随空格会显示异常
  assertEqual(pwa.buildManifest({ siteName: '  带空格  ' }).name, '带空格', '站点名称首尾空白应剔除');
});

test('R70-02 · manifest 满足可安装性的硬性字段', () => {
  const m = pwa.buildManifest({ siteName: 'X' });
  assertEqual(m.start_url, '/', 'start_url 应为根');
  assertEqual(m.scope, '/', 'scope 应为根（覆盖整站，否则分享页不算应用内）');
  assertEqual(m.display, 'standalone', 'display 必须 standalone，否则装出来仍是浏览器标签页');
  assertEqual(m.id, '/', 'id 应显式给出，避免改 start_url 后系统里并存两个快捷方式');
  assertEqual(m.prefer_related_applications, false, '本系统没有配套原生应用，不得推荐商店');

  // 图标：192 与 512 是两个硬性尺寸门槛（Chrome 的可安装性判据）
  const sizes = m.icons.map((i) => i.sizes);
  assert(sizes.includes('192x192'), `图标须含 192x192（实际 ${sizes.join(',')}）`);
  assert(sizes.includes('512x512'), `图标须含 512x512（实际 ${sizes.join(',')}）`);
  const maskable = m.icons.filter((i) => i.purpose === 'maskable');
  assert(maskable.length >= 1,
    '必须有一张 purpose=maskable：缺它时 Android 启动器会把标准图标当满版贴图，切掉一角');
  assert(maskable.every((i) => i.sizes === '512x512'), 'maskable 应为 512x512');
  for (const i of m.icons) {
    assert(i.src.startsWith('/'), `图标路径应为绝对路径（实际 ${i.src}）`);
    assertEqual(i.type, 'image/png', `${i.src} 的 type 应为 image/png`);
    // 图标文件必须真的存在，否则浏览器静默降级为「不可安装」
    const f = path.join(ROOT, 'public', i.src);
    assert(fs.existsSync(f), `manifest 声明的图标在磁盘上不存在：${i.src}`);
    assert(fs.statSync(f).size > 0, `图标文件为空：${i.src}`);
  }
});

test('R70-03 · manifest 是**动态路由**，不是静态文件', async () => {
  // 反例护栏：public/ 下不得出现静态 manifest（存在即说明有人把它写死了）
  for (const name of ['manifest.webmanifest', 'manifest.json', 'site.webmanifest']) {
    const p = path.join(ROOT, 'public', name);
    assert(!fs.existsSync(p),
      `public/${name} 不该存在 —— manifest 必须按站点名称现场生成，`
      + '静态文件只能写死一个名字，那正好违背「快捷方式名称以站点名称为准」');
  }
  // 路由必须注册在 express.static **之前**，否则静态中间件会先返回 404/旧文件
  const iStatic = SERVER_INDEX.indexOf('express.static(PUBLIC_DIR');
  const iManifest = SERVER_INDEX.indexOf('app.get(pwa.MANIFEST_PATH');
  assert(iManifest > 0, 'index.js 应注册 pwa.MANIFEST_PATH 路由');
  assert(iStatic > 0, 'index.js 应有 express.static(PUBLIC_DIR)');
  assert(iManifest < iStatic, 'manifest 路由必须注册在 express.static 之前');
});

test('R70-04 · GET /manifest.webmanifest 匿名可达且名称随配置变化（真起服务）', async () => {
  const srv = await serve();
  try {
    // 匿名：不带任何 Cookie / 自定义头
    const before = await request(srv.port, 'GET', pwa.MANIFEST_PATH);
    assertEqual(before.status, 200, 'manifest 必须匿名可达（浏览器自己来取，不带会话）');
    assertMatch(before.headers['content-type'], /application\/manifest\+json/,
      `content-type 应为 application/manifest+json（实际 ${before.headers['content-type']}）`);
    // 不能强缓存：改完站点名称，下一步点「安装」就该是新名字
    assertMatch(before.headers['cache-control'], /no-cache/,
      'manifest 应 no-cache（可存但每次回源校验），否则改名后要等缓存过期才生效');

    // 真的改一次站点名称，再取一次
    configStore.saveSite({ siteName: '研发部资料库' });
    const after = await request(srv.port, 'GET', pwa.MANIFEST_PATH);
    assertEqual(after.status, 200);
    assertEqual(after.json.name, '研发部资料库', '改站点名称后 manifest 的 name 必须立刻跟着变');
    assertEqual(after.json.short_name, '研发部资料库', 'short_name 同样要跟着变');
    assertEqual(after.json.kepler_version, pkg.version, 'manifest 应带当前版本（装机后排查用）');
  } finally { await srv.close(); }
});

/* ==================================================================
 * ② Service Worker：版本号真被替换 / 不拦敏感路径
 * ================================================================== */

test('R70-05 · GET /sw.js 的**代码行**里版本号真被替换（不是只换了注释）', async () => {
  const srv = await serve();
  try {
    const r = await request(srv.port, 'GET', '/sw.js');
    assertEqual(r.status, 200);
    assertMatch(r.headers['content-type'], /javascript/,
      `sw.js 的 content-type 应为 javascript（实际 ${r.headers['content-type']}）`);
    assertEqual(r.headers['service-worker-allowed'], '/', '应声明 Service-Worker-Allowed: /');

    // ⭐ 核心判据：取**代码行**，断言它已经是具体版本号
    const line = (r.raw.match(/^const VERSION = .*$/m) || [])[0];
    assert(line, 'sw.js 里应有 `const VERSION = …` 一行');
    assert(line.includes(`'${pkg.version}'`),
      `const VERSION 必须被替换成 package.json 的版本（实际：${line}）—— `
      + '只替掉注释里的占位符会让缓存名恒定，发版后用户永远拿旧前端');
    // 占位符不该有任何残留（替换是全局的）
    assert(!r.raw.includes('__KEPLER_VERSION__'),
      '响应里不应残留占位符：模板注释里也不该再写这个字面串（替换是全局 split/join）');
  } finally { await srv.close(); }
});

test('R70-06 · 模板里的占位符**只出现在代码行**（防「注释先命中」）', () => {
  const lines = SW_TEMPLATE.split('\n');
  const hits = [];
  lines.forEach((l, i) => { if (l.includes('__KEPLER_VERSION__')) hits.push({ n: i + 1, text: l.trim() }); });
  assertEqual(hits.length, 1,
    `占位符应恰好出现 1 次，实际 ${hits.length} 次：\n  `
    + hits.map((h) => `第 ${h.n} 行 ${h.text}`).join('\n  '));
  assert(/^const VERSION = '__KEPLER_VERSION__';$/.test(hits[0].text),
    `唯一那处必须是 const VERSION 的初值（实际：${hits[0].text}）`);
});

test('R70-07 · SW 不拦截 /api /s /dav（会话态与一次性数据不得进缓存）', () => {
  // 判据落在**真正的拦截函数**上：BYPASS_RE 的正则体 + isBypassed 的调用位置
  const bypass = (SW_TEMPLATE.match(/const BYPASS_RE = (\/.*\/i);/) || [])[1];
  assert(bypass, 'sw.js 应定义 BYPASS_RE');
  /**
   * 从源码里取出的字面量形如 `/^\/(?:api|s|dav)(?:\/|$)/i`，去掉首尾的 `/` 与 `i`
   * 后用 `new RegExp` 重建 —— **不用 eval**（不执行源码里的任意文本）。
   * 重建的必须是**同一条正则**，否则这条用例测的就不是生产里的判据。
   */
  const body = bypass.slice(1, bypass.lastIndexOf('/'));
  const flags = bypass.slice(bypass.lastIndexOf('/') + 1);
  assertEqual(flags, 'i', `BYPASS_RE 应带 i 标志（实际 ${flags}）—— 路径大小写不该影响判定`);
  const re = new RegExp(body, flags);
  for (const p of ['/api/config', '/api/fs/list', '/s/abc123', '/s/abc123/download', '/dav/', '/dav/x.txt']) {
    assert(re.test(p), `${p} 必须被 BYPASS_RE 命中（不得进缓存）`);
  }
  for (const p of ['/', '/index.html', '/js/main.js', '/css/style.css', '/icons/icon-192.png']) {
    assert(!re.test(p), `${p} 不该被 BYPASS_RE 命中（它要正常缓存）`);
  }
  // fetch 里必须先判 bypass 再分流，否则导航/资源分支会把它们吃掉
  const fetchBody = SW_TEMPLATE.slice(SW_TEMPLATE.indexOf("addEventListener('fetch'"));
  const iBypass = fetchBody.indexOf('isBypassed(');
  const iNav = fetchBody.indexOf("request.mode === 'navigate'");
  const iAsset = fetchBody.indexOf('isAsset(');
  assert(iBypass > 0, 'fetch 处理器里必须调用 isBypassed()');
  assert(iBypass < iNav, 'bypass 判定必须早于导航分支');
  assert(iBypass < iAsset, 'bypass 判定必须早于静态资源分支');
  // 只处理 GET：写请求进缓存是另一个量级的复杂度
  assert(/request\.method !== 'GET'/.test(fetchBody), 'fetch 应只处理 GET');
});

test('R70-08 · SW 的缓存名带版本号，且 activate 会清掉旧版本', () => {
  assertMatch(SW_TEMPLATE, /const SHELL_CACHE = 'kepler-shell-' \+ TAG;/,
    '外壳缓存名应带版本标签 TAG');
  assertMatch(SW_TEMPLATE, /const ASSET_CACHE = 'kepler-assets-' \+ TAG;/,
    '资源缓存名应带版本标签 TAG');
  // activate 里必须真的删：只改名不删 = 旧缓存永久堆积（用户磁盘被悄悄占满）
  const activate = SW_TEMPLATE.slice(
    SW_TEMPLATE.indexOf("addEventListener('activate'"),
    SW_TEMPLATE.indexOf("addEventListener('fetch'"),
  );
  assert(/caches\.key[s]?\(\)/.test(activate), 'activate 应列出已有缓存');
  assert(/caches\.delete\(/.test(activate), 'activate 应删除不属于当前版本的缓存');
  assert(/CACHE_PREFIX/.test(activate), 'activate 应只删自己的前缀（别删别站的缓存）');
  assert(/clients\.claim\(\)/.test(activate), 'activate 应 claim 已开标签页，否则要重开才生效');
  assert(/skipWaiting\(\)/.test(SW_TEMPLATE), 'install 应 skipWaiting，否则新 SW 要等所有标签页关闭');
});

test('R70-09 · SW 不用 addAll 预缓存（一项失败不该让整个安装失败）', () => {
  const install = SW_TEMPLATE.slice(
    SW_TEMPLATE.indexOf("addEventListener('install'"),
    SW_TEMPLATE.indexOf("addEventListener('activate'"),
  );
  assert(!/cache\.addAll\(/.test(install),
    'install 不得用 addAll：它只要一项失败就整个安装失败，'
    + '而界面上的表现只是「安装按钮点了没反应」，无从排查');
  assert(/cache\.add\(/.test(install), 'install 应逐个 add，单项失败只少一个离线资源');
  assert(/\.catch\(\(\) => \{\}\)/.test(install), '每个 add 都要 catch，失败不能冒泡成安装失败');
  // cache: 'reload' 绕过 HTTP 缓存，否则刚发版时可能把旧 index.html 存进新缓存
  assert(/cache: 'reload'/.test(install), '预缓存应带 cache: reload，避免把旧页面存进新缓存');
});

/* ==================================================================
 * ③ 页面接线：manifest / theme-color / apple-touch-icon / 安装入口
 * ================================================================== */

test('R70-10 · index.html 声明 manifest / theme-color / apple-touch-icon', () => {
  assertMatch(INDEX_HTML, /<link rel="manifest" href="\/manifest\.webmanifest">/,
    'index.html 应声明 <link rel="manifest">（路径须与服务端 MANIFEST_PATH 逐字一致）');
  assertEqual(pwa.MANIFEST_PATH, '/manifest.webmanifest',
    'MANIFEST_PATH 与 index.html 里写的路径必须一致');

  // theme-color 必须与 manifest 的 theme_color 同值，否则 Android 地址栏与图标底色不一致
  const meta = (INDEX_HTML.match(/<meta name="theme-color" content="([^"]+)">/) || [])[1];
  assertEqual(meta, pwa.THEME_COLOR,
    `index.html 的 theme-color（${meta}）应与 manifest 的 theme_color（${pwa.THEME_COLOR}）同值`);

  // iOS 的「添加到主屏幕」不读 manifest 图标，只认 apple-touch-icon
  assertMatch(INDEX_HTML, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/,
    '应声明 apple-touch-icon（iOS 不读 manifest 的图标）');
  assert(fs.existsSync(path.join(ROOT, 'public', 'icons', 'apple-touch-icon.png')),
    'apple-touch-icon.png 必须真的存在');
});

test('R70-10b · CSP 显式放行 Service Worker（被拦时页面完全不报错）', () => {
  /**
   * SW 脚本抓取走**独立的取指令**（worker-src → child-src → script-src → default-src）。
   * `default-src 'self'` 多数情况下能兜住，但一旦被拦，控制台只有一条 violation，
   * 界面上表现为「安装入口永远不出现」—— 属于最该被静态守住的静默失效。
   *
   * ⚠️ 判据必须落在**指令字面量**上，且要剥掉注释：本仓库的注释里写过
   * `worker-src 'self'; child-src 'self'` 来解释这件事，对全文做正则会「被注释满足」
   * （R68 踩过一次：注释里提 `ip-switch` 就把判据判红了）。故先按 CSP 头的
   * 起止字面量切出那段字符串拼接、再剥注释。
   */
  const start = SERVER_INDEX.indexOf("res.setHeader('Content-Security-Policy',");
  assert(start >= 0, '应能在 index.js 里定位 CSP 头');
  const end = SERVER_INDEX.indexOf("frame-ancestors 'none'\")", start);
  assert(end > start, '应能找到 CSP 的结尾指令（frame-ancestors none）');
  const block = SERVER_INDEX.slice(start, end + 30).replace(/\/\/[^\n]*/g, '');
  assertMatch(block, /worker-src 'self'/, 'CSP 必须放行 worker-src self（否则 SW 注册被静默拦掉）');
  assertMatch(block, /child-src 'self'/, 'CSP 还应放行 child-src self（worker-src 普及前的旧名，覆盖老 WebView）');
});

test('R70-11 · 安装入口默认隐藏，只有真的可安装时才放出', () => {
  // 菜单项存在且默认 hidden：摆一个点了没反应的菜单项比不摆更让人困惑
  assertMatch(INDEX_HTML, /<div class="um-item" id="um-install" hidden>安装到桌面<\/div>/,
    'index.html 应有默认 hidden 的 #um-install');

  // 显隐必须由 canInstall() 决定（凭据 + 非独立窗口），不能只看能力探测
  assert(/export function canInstall\(\)/.test(PWA_JS), 'pwa.js 应导出 canInstall()');
  const canBody = PWA_JS.slice(PWA_JS.indexOf('export function canInstall()'), PWA_JS.indexOf('/* ------------------------------ 安装流程'));
  assert(/deferredPrompt/.test(canBody), 'canInstall 必须要求真的收到过 beforeinstallprompt');
  assert(/isStandalone\(\)/.test(canBody), 'canInstall 必须排除「已装成 App」的独立窗口');

  // syncInstallItem 是唯一的显隐落点，且分隔线跟着一起显隐
  const syncBody = PWA_JS.slice(PWA_JS.indexOf('export function syncInstallItem()'),
    PWA_JS.indexOf('/* ------------------------------ SW 注册'));
  assert(/hidden = !show|hidden = !canInstall/.test(syncBody), 'syncInstallItem 应据此赋值 hidden');
  assert(/um-install-sep/.test(syncBody), '两条分隔线要跟着显隐，否则菜单里留悬空横线');
});

test('R70-12 · beforeinstallprompt 只保存凭据，真 prompt() 挂在用户点击上', () => {
  // 事件里直接 prompt() 会让 Chrome 记成「已提示」，之后菜单永远调不出安装框
  const evBody = PWA_JS.slice(PWA_JS.indexOf("addEventListener('beforeinstallprompt'"),
    PWA_JS.indexOf("addEventListener('appinstalled'"));
  assert(/preventDefault\(\)/.test(evBody), '必须先 preventDefault，否则浏览器自己弹提示');
  assert(/deferredPrompt = e/.test(evBody), '应保存事件凭据');
  assert(!/\.prompt\(\)/.test(evBody),
    '⚠️ beforeinstallprompt 回调里**不得**调用 prompt()：它每页只发一次，'
    + '在事件里用掉等于永久失去安装入口');

  // promptInstall 里才调 prompt()，且会清空凭据（只能用一次）
  const pBody = PWA_JS.slice(PWA_JS.indexOf('export async function promptInstall()'),
    PWA_JS.indexOf('/** 通知所有订阅者'));
  assert(/event\.prompt\(\)/.test(pBody), 'promptInstall 应调用 prompt()');
  assert(/deferredPrompt = null/.test(pBody), '用完必须清空凭据，否则 canInstall 装完仍为真');
  assert(/userChoice/.test(pBody), '应等 userChoice 才知道用户选了接受还是取消');
});

test('R70-13 · SW 注册与失败静默（增强能力不得拖垮主流程）', () => {
  const regBody = PWA_JS.slice(PWA_JS.indexOf('export function registerServiceWorker()'),
    PWA_JS.indexOf('/* ------------------------------ 初始化'));
  assert(/serviceWorker' in navigator/.test(regBody), '应先判能力');
  assert(/register\('\/sw\.js'/.test(regBody), '应注册 /sw.js');
  assert(/scope: '\/'/.test(regBody), '应显式 scope: /（与 Service-Worker-Allowed 呼应）');
  assert(/\.catch\(/.test(regBody),
    '注册失败必须 catch：明文 HTTP / 隐私模式被拒是正常情况，不该让 init() 连锁失败');

  // main.js 必须真的接上：init 里调 initPwa()（且不 await）
  const MAIN = read('public/js/main.js');
  assert(/import \* as pwa from '\.\/pwa\.js'/.test(MAIN), 'main.js 应导入 pwa 模块');
  assert(/pwa\.initPwa\(\)/.test(MAIN), 'main.js 的 init() 应调用 pwa.initPwa()');
  assert(/pwa\.syncInstallItem\(\)/.test(MAIN), 'renderUserMenu 里应重刷安装项（换账号不残留）');
  assert(/pwa\.onInstallStateChange\(/.test(MAIN), '应订阅状态变化（事件可能在渲染之后才到）');
  // 点击必须直接调 promptInstall（推迟到微任务会丢失用户手势）
  const clickBody = MAIN.slice(MAIN.indexOf("installItem.onclick"), MAIN.indexOf('pwa.onInstallStateChange('));
  assert(/await pwa\.promptInstall\(\)/.test(clickBody), '菜单项点击应直接调 promptInstall');
  assert(!/setTimeout/.test(clickBody), '点击处理里不得 setTimeout：会丢失用户手势，prompt 被静默拒绝');
});

/* ==================================================================
 * ④ 图标：白底 + 圆角正方形（需求原文），且 PNG 真的对
 * ================================================================== */

/** 极简 PNG 解码：读 IHDR + 反转 filter，返回 { w, h, at(x,y) => [r,g,b,a] } */
function decodePng(buf) {
  const zlib = require('zlib');
  let pos = 8; // 跳过签名
  let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  assertEqual(bitDepth, 8, '图标 PNG 应为 8 位深度');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert(channels, `不支持的 PNG colorType=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[rowStart - stride + x] : 0;
      const ul = (x >= bpp && y > 0) ? out[rowStart - stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + left;
      else if (filter === 2) v = cur + up;
      else if (filter === 3) v = cur + ((left + up) >> 1);
      else { // Paeth
        const p = left + up - ul;
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - ul);
        v = cur + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : ul));
      }
      out[rowStart + x] = v & 0xFF;
    }
    rp += stride;
  }
  const at = (x, y) => {
    const o = y * stride + x * bpp;
    if (channels === 4) return [out[o], out[o + 1], out[o + 2], out[o + 3]];
    if (channels === 3) return [out[o], out[o + 1], out[o + 2], 255];
    return [out[o], out[o], out[o], 255];
  };
  return { w, h, at };
}

test('R70-14 · 图标 PNG 真的是「白底 + 圆角正方形」（解码像素核对）', () => {
  const icon = decodePng(fs.readFileSync(path.join(ROOT, 'public', 'icons', 'icon-512.png')));
  assertEqual(icon.w, 512, '应为 512×512');
  assertEqual(icon.h, 512);

  // 四角必须**透明**：这就是「圆角」—— 圆角之外是空的，不是白的
  for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) {
    const px = icon.at(x, y);
    assertEqual(px[3], 0, `图标四角 (${x},${y}) 必须透明（alpha=0），实际 ${JSON.stringify(px)} —— `
      + '不透明就说明圆角没生效，快捷方式会显示成一个方块');
  }
  // 中心：白色底上应当是图形主色（#FFE777 书脊色块 或 #377DFF 主体），总之不能是透明
  const c = icon.at(256, 256);
  assert(c[3] > 0, '中心必须不透明');

  // 圆角半径内的「边上中点」应为白色（白底在，且没被裁掉）
  const edgeMid = icon.at(256, 4);
  assert(edgeMid[3] > 0 && edgeMid[0] > 240 && edgeMid[1] > 240 && edgeMid[2] > 240,
    `上边中点应是不透明白底，实际 ${JSON.stringify(edgeMid)} —— 「白底」是需求的一半`);

  // 白色占比要够（白底是背景，不是描边）：抽样统计
  let white = 0; let opaque = 0; let total = 0;
  for (let y = 0; y < 512; y += 8) {
    for (let x = 0; x < 512; x += 8) {
      const p = icon.at(x, y); total++;
      if (p[3] > 200) { opaque++; if (p[0] > 240 && p[1] > 240 && p[2] > 240) white++; }
    }
  }
  const whiteRatio = white / opaque;
  assert(whiteRatio > 0.4,
    `不透明区域内白色占比应 > 40%（实际 ${(whiteRatio * 100).toFixed(1)}%）—— `
    + '占比过低说明图形把白底盖掉了，不是「图形 + 白底」');
});

test('R70-15 · maskable 图标满版白底（不烤圆角，交系统裁切）', () => {
  const m = decodePng(fs.readFileSync(path.join(ROOT, 'public', 'icons', 'icon-maskable-512.png')));
  assertEqual(m.w, 512);

  // 满版：四角必须**不透明**（与标准图标正好相反）——
  // 系统会按自己的形状（圆 / 方 / 水滴）裁，图形若没铺满会被切出缺口
  for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) {
    const px = m.at(x, y);
    assertEqual(px[3], 255, `maskable 四角 (${x},${y}) 必须不透明（alpha=255），实际 ${JSON.stringify(px)}`);
    assert(px[0] > 240 && px[1] > 240 && px[2] > 240,
      `maskable 四角应为白色，实际 ${JSON.stringify(px)}`);
  }
  // 整图不应有透明像素（满版）
  let transparent = 0;
  for (let y = 0; y < 512; y += 8) {
    for (let x = 0; x < 512; x += 8) {
      if (m.at(x, y)[3] < 255) transparent++;
    }
  }
  assertEqual(transparent, 0, `maskable 图标不应有任何半透明/透明像素（实际 ${transparent} 个采样点）`);
});

test('R70-16 · 图标源文件（SVG）带白底圆角，且图形用需求给的两色', () => {
  const svg = read('public/icons/icon.svg');
  // 白底圆角矩形：需求原文「该图标需要加白底和圆角正方形」
  assertMatch(svg, /<rect width="1024" height="1024" rx="\d+" fill="#FFFFFF"\/>/,
    'icon.svg 应有满版白底 + rx 圆角矩形');
  const rx = Number((svg.match(/<rect width="1024" height="1024" rx="(\d+)"/) || [])[1]);
  assert(rx > 100 && rx < 400,
    `圆角半径应在合理区间（实际 ${rx}）—— 太小像方块、太大会变成圆形`);
  // 图形本体必须保留需求给的那两种颜色（不是我们自己调过的）
  assert(/#FFE777/i.test(svg), 'icon.svg 应保留 #FFE777（书脊/封面色块）');
  assert(/#377DFF/i.test(svg), 'icon.svg 应保留 #377DFF（主体 + 圆点 + 底条）');
  // maskable 版：满版白底（rx 应为 0），因为圆角交给系统裁
  const ms = read('public/icons/icon-maskable.svg');
  assertMatch(ms, /<rect width="1024" height="1024" fill="#FFFFFF"\/>|<rect width="1024" height="1024" rx="0"/,
    'maskable 版应是满版白底（不烤圆角）');
});