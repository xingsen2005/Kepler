/**
 * WebDAV · PROPFIND 的 207 响应构造（含 Windows 资源管理器要的那几个伪属性）
 */
const { xmlEsc, rfcDate, guessContentType } = require('./util');

/* ------------------------------ XML 响应构造 ------------------------------ */

function propResponse(href, item) {
  const lm = item && item.lm ? rfcDate(item.lm) : null;
  let props;
  if (item && item.dir) {
    /**
     * R11-16：`<D:displayname>` 必须取**原始 key** 的末段，不能取 href 的末段。
     *
     * href 是百分号编码后的 URL 片段 —— `my dir/` 会显示成 `my%20dir`、
     * 中文目录显示成 `%E6%88%91…`（文件分支取的就是原始 key，两者此前不一致）。
     * 编码只应出现在 `<D:href>`，不应泄漏进显示名。
     */
    const dirName = String(item.key || '').replace(/\/+$/, '').split('/').pop() || '';
    props = `<D:resourcetype><D:collection/></D:resourcetype>` +
      `<D:displayname>${xmlEsc(dirName)}</D:displayname>` +
      (lm ? `<D:getlastmodified>${xmlEsc(lm)}</D:getlastmodified>` : '');
  } else if (item) {
    props = `<D:resourcetype/>` +
      `<D:displayname>${xmlEsc(item.key.split('/').pop())}</D:displayname>` +
      `<D:getcontentlength>${item.size}</D:getcontentlength>` +
      `<D:getcontenttype>${xmlEsc(guessContentType(item.key))}</D:getcontenttype>` +
      (lm ? `<D:getlastmodified>${xmlEsc(lm)}</D:getlastmodified>` : '');
  } else {
    props = `<D:resourcetype/>`;
  }
  return `<D:response><D:href>${xmlEsc(href)}</D:href>` +
    `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

module.exports = { propResponse, multistatus };
