/**
 * WebDAV · 认证层：HTTP Basic + 按用户名的连续失败锁定
 *
 * 与站点登录**不共用会话**：WebDAV 是独立端口上的独立 Express 实例，
 * 但它复用同一份 `security.createFailLock` 与同一份 `ipGuard` 规则 ——
 * 隔离的是会话，不是策略。
 */
const configStore = require('../config-store');
const security = require('../security');
const { webdavLock } = require('./defs');

/* ------------------------------ 认证与 HTTPS 守卫 ------------------------------ */

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV", charset="UTF-8"');
  res.status(401).type('text/plain').send('401 Unauthorized：WebDAV 需要账户认证');
}

async function authMiddleware(req, res, next) {
  // 双保险：该服务本就只在 HTTPS 上监听；任何明文请求一律拒绝
  if (!req.socket || !req.socket.encrypted) {
    return res.status(403).type('text/plain').send('403 Forbidden：WebDAV 强制使用 HTTPS，拒绝明文 HTTP 连接');
  }
  const w = configStore.getWebdav();
  if (!w.enabled) return res.status(503).type('text/plain').send('503 Service Unavailable：WebDAV 未启用');

  const h = req.headers.authorization || '';
  if (!/^Basic\s+/i.test(h)) return unauthorized(res);
  let user = '', pass = '';
  try {
    const decoded = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    user = i < 0 ? decoded : decoded.slice(0, i);
    pass = i < 0 ? '' : decoded.slice(i + 1);
  } catch (e) { return unauthorized(res); }

  const ip = security.clientIp(req) || 'unknown';

  // 防爆破：连续失败按用户名锁定（Claude issue #3）
  const lockKey = `${ip}|${user}`;
  const lockedLeft = webdavLock.locked(lockKey);
  if (lockedLeft > 0) {
    res.setHeader('Retry-After', String(lockedLeft));
    return res.status(429).type('text/plain')
      .send(`429 Too Many Requests：认证失败次数过多，请 ${lockedLeft} 秒后重试`);
  }

  /**
   * SEC-05 + R8-05：**认证失败**时统一记账并回答。
   *
   * SEC-05 的本意是「防匿名爆破」—— 那个攻击是**失败**驱动的。旧实现把
   * `webdavAuthLimiter(ip)` 放在凭据校验**之前**，于是它退化成全局 QPS 闸门：
   * 第三方客户端一次目录刷新就发几十个 `PROPFIND`/`GET`，第 31 个起全部
   * 429 + `Retry-After: 60`，而且 `createLimiter` 只自增、认证成功**也不会重置**，
   * 于是「复制中断、目录刷不出来、反复重连」。正常挂载被硬性封顶在 30 请求/分钟。
   *
   * 现在两层限流都只在失败路径上计数：成功的请求永远不消耗任何配额。
   *
   * @returns {boolean} 是否已由本函数回答（true = 调用方不要再回答）
   */
  const rejectAuthFailure = () => {
    const rl = security.webdavAuthLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      res.status(429).type('text/plain')
        .send(`429 Too Many Requests：该 IP 认证失败次数过多，请 ${rl.retryAfter} 秒后重试`);
      return true;
    }
    const left = webdavLock.fail(lockKey);
    if (left > 0) {
      res.setHeader('Retry-After', String(left));
      res.status(429).type('text/plain')
        .send(`429 Too Many Requests：认证失败次数过多，请 ${left} 秒后重试`);
      return true;
    }
    return false;
  };

  let r;
  try {
    r = await configStore.authenticateWebdav(user, pass); // SEC-05：异步 scrypt，不阻塞事件循环
  } catch (e) {
    if (rejectAuthFailure()) return undefined;
    return unauthorized(res);
  }
  if (!r.ok) {
    if (rejectAuthFailure()) return undefined;
    return unauthorized(res);
  }
  webdavLock.reset(lockKey);
  req.webdavUser = r.account;
  next();
}

module.exports = { unauthorized, authMiddleware };
