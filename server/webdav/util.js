/**
 * WebDAV · 纯工具层：响应里的 XML 转义、路径⇄对象 Key 的双向换算
 *
 * 刻意**不引入任何 I/O**（不 require s3 / config-store）：这样路径归一化的
 * 「幽灵对象」判据可以被测试直接驱动，不必起 HTTPS 服务。
 */
const { normalizeKey } = require('../s3');
const { MOUNT } = require('./defs');

/* ------------------------------ XML / 路径工具 ------------------------------ */

/**
 * XML 文本转义。
 *
 * ⚠️ R94（审核 M11-02）：**必须先剥掉 XML 1.0 非法控制字符**，只转义 `& < > " '`
 * 是不够的。XML 1.0 的字符集是 `#x9 | #xA | #xD | [#x20-#xD7FF] | …` ——
 * 一个 U+0001 出现在文件名里（对象键是完全由用户决定的内容）就会让整个
 * `<D:multistatus>` **非良构**：客户端解析失败，**整个目录列举**变成 400/500，
 * 而不是「那一个文件名显示异常」。这类字符也不允许写成数字实体引用，只能丢弃。
 */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    // XML 1.0 不允许的 C0 控制字符（保留制表符 / 换行 / 回车）与 U+FFFE / U+FFFF
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hrefFor(key) {
  // key 以 / 结尾表示目录
  const enc = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return MOUNT + '/' + enc;
}

/**
 * 请求路径是否落在 WebDAV 挂载点上（R34）
 *
 * 判据此前**手写在 9 处**（`req.path.startsWith(MOUNT)` / `destPath.startsWith(MOUNT + '/')`），
 * 而根路径 `/` 在其中的**大部分**地方被落在门外 —— 只有挂载点边界中间件显式放行了它。
 * 于是同一个路径上的两个回答互相矛盾：
 *   - `app.options()` 的路径参数是**正则**（匹配任意路径），`/` 命中 → **200 + `DAV: 1`**，
 *     客户端据此判定「这里是 WebDAV」；
 *   - `app.propfind('*')` 里的前缀判据把 `/` 挡掉 → 落到 Express 默认兜底，
 *     回一页 **HTML 404 `Cannot PROPFIND /`**。
 *
 * 这正是用户报告的那条链：`OPTIONS /` 的 200 让客户端愿意弹凭据框 → 401 挑战 → 密码输对 →
 * 列目录撞 404 → 客户端无法确认这是个集合 → 「输入的文件夹似乎无效，请选择另一个」。
 * 密码框先弹、报错在其后，顺序完全对上。
 *
 * 根路径上那个 301（`app.get('/')`）救不了它：**WebDAV 客户端从不用 GET 打开集合**，
 * 第一步就是 PROPFIND，重定向对它们等于不存在。
 *
 * 因此把 `/` 与 `/dav` 一样当作挂载点本身：`reqPathToKey` 对两者都得到空 key（根集合）。
 * ⚠️ 只特判**正好等于** `/` 的根路径 —— 不能把整个根命名空间都算作挂载点，
 * 那会撤销 FUN-06 划下的边界（「挂载点之外不可读、不可写」）。
 */
function inMount(reqPath) {
  return reqPath === '/' || reqPath === MOUNT || reqPath.indexOf(MOUNT + '/') === 0;
}

/**
 * 请求路径 -> 对象 Key（去掉挂载前缀；目录保留尾部 /）
 *
 * SEC-12：与 `s3.js` 共用 `normalizeKey()`，不再手写剥离。
 * 旧实现不禁 `..`（`PUT /dav/..%2f..%2fx` 会写出含 `..` 的 key），
 * 而管理端 `normalizeKey` 拒绝 `..` —— 于是这些对象在界面**既看不到也删不掉**，
 * 成为持续计费的幽灵对象。畸形百分号编码还会让 `decodeURIComponent` 抛 URIError → 500。
 */
function reqPathToKey(reqPath) {
  let pth;
  try {
    pth = decodeURIComponent(reqPath.split('?')[0]);
  } catch (e) {
    const err = new Error('路径编码非法（百分号转义格式错误）');
    err.status = 400;
    throw err;
  }
  // R34：前缀剥离必须按**路径段**匹配。手写 `startsWith(MOUNT)` 会把 `/davx` 的前缀也剥掉，
  // 得到 key `x` —— 一个「管理界面看不到、WebDAV 却能读」的幽灵命名空间
  // （与 SEC-12 修掉的 `..` 幽灵对象同型）。`inMount` 已经把这类路径挡在挂载点之外，
  // 这里再独立成立一次，避免它成为后续调用者的陷阱。
  if (pth === MOUNT || pth.indexOf(MOUNT + '/') === 0) pth = pth.slice(MOUNT.length);
  return normalizeKey(pth); // 禁 '..'、反斜杠归一、剥前导斜杠；空串表示根
}

function rfcDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toUTCString();
}

function guessContentType(key) {
  const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
  const map = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/plain',
    css: 'text/css', js: 'application/javascript', json: 'application/json', xml: 'application/xml',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
    mp4: 'video/mp4', mp3: 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * R14-06：能被浏览器**内联渲染并执行脚本**的 MIME 类型（对比时忽略 `;charset=…` 后缀）。
 *
 * 这些类型在 GET 响应里被强制改成 `Content-Disposition: attachment`：
 * WebDAV 的定位是文件存取，内联渲染带来的只有风险（见 `buildApp` 里的安全头说明）。
 */
const RENDERABLE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml']);


module.exports = {
  xmlEsc, hrefFor, inMount, reqPathToKey, rfcDate, guessContentType, RENDERABLE_TYPES,
};
