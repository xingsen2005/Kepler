/**
 * `Content-Disposition: attachment` 的唯一实现点。
 *
 * 单文件下载（`download-stream.js`）与分享打包下载（`share-bundle.js`）都要下发
 * 这个头，而它**同时是**一处响应头注入面：文件名里出现裸的 `"`、`\` 或换行，
 * 就能把后续内容顶到下一行去变成**另一个响应头**（Claude issue #2）。
 * 两处各写一份必然有一处先漂移，故收敛到这里。
 *
 * 两个字段都要给：
 *  · `filename=` 用 ASCII 兜底（中文名会被换成 `_`），老浏览器与 curl 只看这个；
 *  · `filename*=UTF-8''…`（RFC 5987）才是真实的、带中文的名字。
 */
function attachmentDisposition(fileName) {
  const safe = String(fileName === undefined || fileName === null ? '' : fileName)
    .replace(/[\\"\r\n]/g, '');            // 引号、反斜杠、换行一律剔除
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_'); // 非可见 ASCII 用 _ 占位
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

module.exports = { attachmentDisposition };
