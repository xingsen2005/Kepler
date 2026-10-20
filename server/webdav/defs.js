/**
 * WebDAV · 定义层：挂载点、端口、方法集、失败锁定，以及错误文案的唯一收口点
 *
 * 为什么单独成一层：这些常量**同时被** app / util / listing / facade 引用，
 * 放在任何一个消费者里都会让别的消费者反向依赖它。
 */
const { LIMITS } = require('../limits');
const security = require('../security');
const { translateError } = require('../s3');

/**
 * R21-14：回给 WebDAV 客户端的错误文案**不得包含上游原始 message**。
 *
 * 管理端刻意只回分类文案、把原始串放进 `err.rawMessage`（仅服务端日志）——
 * 因为 SDK 的 message 里可能带请求 ID、端点、AccessKeyId 片段。WebDAV 侧此前
 * 直接把 `e.message` 发给客户端（R21-14 只收口了 GET/HEAD 与 PUT 两处；
 * R22-03 把 PROPFIND / MKCOL / DELETE / COPY 四处一并改调本函数 —— 该文件内
 * **不得再出现裸 `send(e.message)`**）。
 *
 * 判据不是「哪些文案要翻译」而是「这个错误是不是上游来的」：
 *  - 上游错误（COS SDK / s3-client）带 `statusCode`，或被 `translateError` 包过（带 `rawMessage`）；
 *  - 本进程自己生成的校验错误（如 `Range 格式无效`、`上传数据超过上限…`，由 fs-gateway 抛出、
 *    只带 `status`）不含任何上游信息，原文透出对排查更有价值，保留。
 */
function davErrorMessage(e) {
  const fromUpstream = !!e && (e.statusCode !== undefined || e.rawMessage !== undefined);
  if (!fromUpstream) return String((e && e.message) || '操作失败，请重试');
  return translateError(e).message;
}

/** WebDAV 认证失败锁定：连续 5 次失败锁定 1 分钟起，最长 30 分钟（按用户名） */
const webdavLock = security.createFailLock({ name: 'webdav', maxFails: 5, baseLockMs: 60 * 1000, maxLockMs: 30 * 60 * 1000 });

const MOUNT = '/dav';
const DEFAULT_PORT = Number(process.env.WEBDAV_PORT) || 8443;
const HOST = process.env.HOST || '127.0.0.1';
// FUN-11：上限一律取自 limits.js（旧值在此硬编码 20000，是集中值的 4 倍）。
// 与 PERF-04「列举上限集中定义」保持一致，避免各处数字互不知情。
const PROPFIND_CAP = LIMITS.PROPFIND;

/**
 * R8-17：**实际实现**的 WebDAV 动词，与 OPTIONS 的 `Allow` 头同源。
 * 未列入者一律 405（而不是落到 SPA 兜底的 404）——
 * 尤其 `LOCK`/`UNLOCK`/`PROPPATCH`：本服务不实现 locking，
 * 而资源管理器与 Office 在写入前会先尝试 `LOCK`，需要拿到明确的"不支持"。
 */
const WEBDAV_METHODS = new Set([
  'OPTIONS', 'PROPFIND', 'GET', 'HEAD', 'PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY',
]);

module.exports = {
  MOUNT, DEFAULT_PORT, HOST, PROPFIND_CAP, WEBDAV_METHODS, webdavLock, davErrorMessage,
};
