/**
 * 文件类型图标（服务端）—— 给**服务端渲染**的页面用的**内联** SVG。
 *
 * ## 为什么需要这个模块
 *
 * R44 定下的规矩是：文件类型图标只有一份真相 —— `public/index.html` 里
 * `#icon-sprite` 的那些 `<symbol id="fic-*">`，每个符号自带一枚 1024 的圆角底色
 * `<rect>` 加一层白色图形。文件列表通过 `<use href="#fic-image">` 引用它。
 *
 * 但**分享页 `/s/:id` 是一份独立的、由服务端渲染出来的 HTML 文档**
 * （见 `share-routes.js` 的 `renderPage()`），它既没有加载 `index.html`、也就
 * 没有那套雪碧。在那里写 `<use href="#fic-image">` 会**画出一片空白**：
 * 浏览器对「引用了不存在的符号」既不报错也不警告，控制台干干净净。
 * 所以服务端必须把符号的**内容**直接内联进页面。
 *
 * ## 为什么不在这里复制一份图形
 *
 * 复制就等于「图形有两个落点」，改了 `index.html` 忘了这里，两边迟早分叉
 * （R44 已经因为「底色写 CSS、图形写 symbol」这个形态吃过一次亏，故刻意把底色
 * 烘进符号里）。本模块**不存任何图形**：它在首次使用时读 `index.html`、
 * 用正则把 `<symbol>` 拆成 `id → { viewBox, inner }`，之后只用缓存。
 *
 * ## 图标 id 的选取规则（必须与前端 `util.js` 的 `iconIdOf()` 等价）
 *
 * 前端那份是「类型 → `TYPE_ICON` 表；`exec` 再按扩展名细分到 `EXEC_ICON` 表」。
 * 这里刻意**不抄那两张表**，改成**由雪碧本身驱动**：
 *
 *   1. 目录（key 以 `/` 结尾）→ `fic-folder`；
 *   2. 其余先取类型 `fic-<type>`（`image` / `video` / `audio` / `doc` /
 *      `archive` / `other` 恰好都同名存在）；
 *   3. 类型是 `exec` 时取 `fic-<扩展名>`（`exe` / `apk` / `ipa` / `hpkg`）；
 *      取不到则回退 `fic-exe` —— 这正是前端 `EXEC_ICON` 里
 *      `msi` / `com` 映射到 Windows 同款图标的那条规则。
 *
 * 于是「加一枚新图标」只需要动 `index.html` 一处。代价是这条规则必须**等价于**
 * 前端那张表，否则同一个文件在文件列表里与分享页上会显示不同的图标 ——
 * `tests/audit50-regressions.test.js` 用一张文件名样本表把两者**逐项比对**钉住。
 *
 * ## 类型分类仍取自服务端唯一的一份
 *
 * 「什么后缀算哪一类」的真相是 `server/routes/_shared.js` 的 `TYPE_EXT`
 * （搜索接口的 `type` 条件也用它）。这里只调用它的 `typeOf()`，不另立一份表。
 */
const fs = require('fs');
const path = require('path');
// 分类表的唯一实现点（R44）。`share-routes.js` 本就 require 了同一模块的 asyncHandler，
// 故这里不引入任何新的加载代价；依赖方向是 file-icons → _shared，不存在环。
const { typeOf } = require('./routes/_shared');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

/** 雪碧不可用时的兜底图标 id（`fic-other` 是中性「其他文件」图标） */
const FALLBACK_ID = 'fic-other';

/**
 * 读取雪碧源码。
 *
 * 抽成一层可替换的取数函数，是为了让护栏能在**不破坏工作区文件**的前提下
 * 模拟「雪碧缺失 / 缺某个符号」这类故障 —— 与 `update-check.js` 的
 * `__setFetcher()` 是同一个做法。
 */
let readSource = () => fs.readFileSync(INDEX_HTML, 'utf8');

let cache = null;

/**
 * 解析雪碧 → `Map<id, { viewBox, inner }>`。
 *
 * 解析失败（文件缺失 / 读不动）**不抛错**：分享页是一张公开页面，
 * 不能因为一个图标而整页 500。此时返回空表，`inlineSvg()` 会回退到
 * 调用方给的降级分支（`infoPage` 会退回原来的 emoji 图标）。
 */
function sprite() {
  if (cache) return cache;
  const map = new Map();
  let html = '';
  try {
    html = String(readSource() || '');
  } catch (e) {
    cache = map;
    return cache;
  }
  const re = /<symbol\s+id="(fic-[a-z0-9-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g;
  let m;
  while ((m = re.exec(html))) {
    const vb = /viewBox="([^"]*)"/.exec(m[2] || '');
    map.set(m[1], { viewBox: vb ? vb[1] : '0 0 1024 1024', inner: m[3] });
  }
  cache = map;
  return cache;
}

/** key 的扩展名（小写、无点）。目录与无扩展名都给空串 —— 与 `typeOf()` 同口径 */
function extOf(key) {
  const s = String(key || '');
  return s.includes('.') ? s.split('.').pop().toLowerCase() : '';
}

/**
 * 取某个文件应显示的雪碧符号 id。
 * @param {string} name 对象 key 或文件名（可带目录前缀）
 * @returns {string} `fic-*`；雪碧整体不可用时返回空串
 */
function iconIdFor(name) {
  const key = String(name || '');
  const sp = sprite();
  if (!sp.size) return '';
  if (key.endsWith('/')) return sp.has('fic-folder') ? 'fic-folder' : '';
  const type = typeOf(key);
  const byType = 'fic-' + type;
  if (sp.has(byType)) return byType;
  if (type === 'exec') {
    const byExt = 'fic-' + extOf(key);
    if (sp.has(byExt)) return byExt;
    // msi / com 等没有专属图标 → 与前端 EXEC_ICON 一致，落到 Windows 同款
    if (sp.has('fic-exe')) return 'fic-exe';
  }
  // 专属图与 fallback 都缺 → 回空串（调用方降级），绝不回一个不存在的 id
  return sp.has(FALLBACK_ID) ? FALLBACK_ID : '';
}

/**
 * 把某个文件对应的图标**内联**成一段 `<svg>` 字符串。
 *
 * ⚠️ 这里刻意**不用** `<use>`：分享页没有雪碧可引用（见文件头注释）。
 * 内容是直接嵌进来的，故返回的字符串必须**原样**插进页面，不能再转义一遍。
 *
 * @param {string} name 对象 key / 文件名
 * @param {{size?: number, cls?: string}} [opts] `size` 为像素边长（默认 56）
 * @returns {string} 内联 SVG；图标不可用时返回**空串**（调用方自行降级）
 */
function inlineSvg(name, opts) {
  const o = opts || {};
  const sp = sprite();
  const id = iconIdFor(name);
  const sym = (id && sp.get(id)) || sp.get(FALLBACK_ID);
  if (!sym) return '';
  const size = Number(o.size) > 0 ? Number(o.size) : 56;
  const cls = o.cls ? ` class="${String(o.cls)}"` : '';
  return `<svg${cls} viewBox="${sym.viewBox}" width="${size}" height="${size}"`
    + ' aria-hidden="true" focusable="false">' + sym.inner + '</svg>';
}

/** 护栏专用的取数开关（传 null 恢复读真实文件）；同时清掉缓存 */
function __setSource(fn) {
  readSource = fn || (() => fs.readFileSync(INDEX_HTML, 'utf8'));
  cache = null;
}

/** 雪碧里登记的全部符号 id（护栏用：确保没有引用了不存在的图标） */
function symbolIds() {
  return Array.from(sprite().keys()).sort();
}

module.exports = { iconIdFor, inlineSvg, symbolIds, __setSource, FALLBACK_ID, extOf };
