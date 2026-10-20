/**
 * WebDAV 服务 —— 将当前激活的对象存储桶通过 WebDAV 协议暴露
 *
 * 安全约束：
 *  - 仅监听独立的 HTTPS 端口（**必须提供运维自备证书**，见 `docs/ADR/0003-no-self-signed-tls.md`），
 *    强制加密传输，拒绝明文 HTTP；没有证书时服务**不启动**并把原因带给界面
 *  - HTTP Basic 认证（账户在「系统设置 → WebDAV」中管理，密码字段级加密存储）
 *  - 连续认证失败按用户名锁定，防暴力枚举（复用 security.createFailLock）
 *  - 未启用或无有效账户时服务不监听端口
 *
 * 协议：OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY
 * 路径挂载点：/dav/（/dav/ 之后即对象存储 Key）
 */

/**
 * R67：这个文件只保留**服务生命周期**（加载证书 → 起 HTTPS 服务器 → 停止）与对外 API。
 * 协议实现按原本的分节标记搬进了 `server/webdav/`：
 *
 * | 目录文件 | 原分节 | 职责 |
 * | --- | --- | --- |
 * | `defs.js` | 常量与错误文案 | 挂载点 / 端口 / 方法集 / 失败锁定 / 错误文案唯一收口点 |
 * | `util.js` | XML / 路径工具 | 响应转义、路径⇄Key 换算（无 I/O，可被测试直接驱动） |
 * | `listing.js` | 对象列举 | 列举、探测与结果折算，是与 S3 唯一的接触面 |
 * | `auth.js` | 认证与 HTTPS 守卫 | Basic 认证 + 连续失败锁定 |
 * | `xml.js` | XML 响应构造 | PROPFIND 的 207 响应体 |
 * | `app.js` | Express 应用 | 九个动词的处理器（最大的一段） |
 *
 * ⚠️ **测试里凡是读「整个 WebDAV 源码」的静态断言，必须读整包**（见 `tests/helpers.js`
 * 的 `packageSource()`）：只读本文件会让那些断言在不知不觉中失去覆盖范围。
 */
const https = require('https');
const configStore = require('./config-store');
const { loadTlsCert, hintText } = require('./tls-cert');
const { MOUNT, DEFAULT_PORT, HOST, PROPFIND_CAP, davErrorMessage } = require('./webdav/defs');
const { inMount, reqPathToKey } = require('./webdav/util');
const { buildApp } = require('./webdav/app');

let server = null;
let starting = null;
/**
 * R49：上一次 `apply()` 判定「不能启动」的原因（空串 = 没有这个问题）。
 * 只放在内存里、由界面读走 —— 否则用户看到的是「已启用，服务正在启动…」永远转圈，
 * 完全看不出根因是没有自备证书。文案由 `loadTlsCert()` 统一产出。
 */
let tlsError = '';
function getTlsError() { return tlsError; }

/* ------------------------------ 生命周期 ------------------------------ */

/** 是否位于可信反向代理之后（与 security.js 同一判据：仅显式 TRUST_PROXY=1 才信转发头） */
function trustProxy() {
  return String(process.env.TRUST_PROXY || '') === '1';
}

/** 用户访问面板用的主机名[:端口]；反代后 Nginx 已按 server_name 覆写 Host，故它就是域名本身 */
function reqHost(req) {
  if (!req) return '';
  const h = (typeof req.get === 'function' ? req.get('host') : '') || (req.headers && req.headers.host) || '';
  return String(h).trim();
}

/**
 * 本次请求是否确实经过了可信反代。
 * 只看 `TRUST_PROXY=1` 不够：部署脚本把它写进了 `.env`，而管理员完全可能绕过 Nginx
 * 直连应用端口（`http://IP:3000`）——那种情况下按「反代入口」拼出来的地址是错的。
 * 因此还要求请求里真的带 Nginx 注入的转发头。
 */
function viaTrustedProxy(req) {
  if (!trustProxy() || !req || !req.headers) return false;
  return Boolean(req.headers['x-forwarded-proto'] || req.headers['x-forwarded-for']);
}

/** Nginx 注入的协议（只有 TRUST_PROXY=1 时才可信，否则可被请求方伪造） */
function reqProto(req) {
  if (trustProxy() && req && req.headers) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'http' || xfp === 'https') return xfp;
  }
  return 'https'; // WebDAV 只跑 HTTPS，外网一律按 https 呈现
}

/**
 * 浏览器实际连接的端口（非默认端口时才需要写进地址）。
 *
 * 为什么不能只看 Host：Nginx 的 `$host` 已经把端口剥掉了，所以站点跑在 8443 时
 * 反代传来的 Host 依然是 `pan.example.com` —— 照它拼出来的是 `https://pan.example.com/dav/`，
 * 少了端口就指向 443，客户端照样连不上。判据取两处，取到即用：
 *   ① 请求头里带端口的 Host（自建反代可能原样透传）；
 *   ② `X-Forwarded-Port`（部署脚本写的 Nginx 会注入 `$server_port`）。
 * 与协议默认端口一致时返回空串，保证 443/https、80/http 的地址保持干净。
 */
function reqExtPort(req) {
  if (!req || !req.headers) return '';
  const raw = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
  if (!/^\d{1,5}$/.test(raw)) return '';
  return raw;
}

/**
 * 对外访问地址 —— 挂载到资源管理器 / Finder 时填的就是这一条。
 *
 * 旧实现只拼「监听地址 + 端口」：部署时 `.env` 里是 `HOST=0.0.0.0`，
 * 于是界面**恒显示 `https://localhost:8443/dav/`**。那是**服务器自己**的回环地址，
 * 客户端照着填必然连不上（而且 8443 是自签证书，多数客户端会直接拒绝），
 * 表现就是「WebDAV 配置好了但用不了」。
 *
 * 地址必须反映「用户从哪儿访问」，按确定性从高到低取：
 *   ① `WEBDAV_PUBLIC_URL` —— 部署脚本写入的对外基地址（Nginx `/dav/` 反代入口，含非默认端口）；
 *   ② 面板域名 —— 请求经可信反代时，用管理员此刻访问的域名 + 实际端口（见 reqExtPort）；
 *   ③ 直连回退 —— 未经反代时，用面板主机名 + WebDAV 自己的端口（本机/内网自测）。
 */
function serverUrl(req) {
  const base = String(process.env.WEBDAV_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (base) return base + MOUNT + '/';

  const host = reqHost(req);
  if (host && viaTrustedProxy(req)) {
    const proto = reqProto(req);
    // Nginx 的 $host 不含端口；Host 自带的端口优先，其次看 X-Forwarded-Port
    const m = /:(\d{1,5})$/.exec(host);
    const hostOnly = m ? host.slice(0, -(m[1].length + 1)) : host;
    const port = m ? m[1] : reqExtPort(req);
    const defPort = proto === 'https' ? '443' : '80';
    const shown = port && port !== defPort ? `:${port}` : '';
    return `${proto}://${hostOnly}${shown}${MOUNT}/`;
  }
  if (host) return `https://${host.replace(/:\d+$/, '')}:${DEFAULT_PORT}${MOUNT}/`;
  return `https://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${DEFAULT_PORT}${MOUNT}/`;
}

/** 读取配置，按开关状态启动或停止 HTTPS WebDAV 服务 */
async function apply() {
  const w = configStore.getWebdav();
  const shouldRun = w.enabled && Array.isArray(w.accounts) && w.accounts.length > 0;
  if (shouldRun && !server && !starting) {
    starting = (async () => {
      try {
        /**
         * R49：WebDAV 是**强制 HTTPS** 的（Basic 认证凭据只是 base64，走明文等同明文发送
         * 口令），因此没有自备证书时**不能降级为 HTTP**，只能不启动。旧的「生成一张自签名
         * 证书顶上」已经移除 —— 那种证书在浏览器/资源管理器里同样被判为不可信，
         * 客户端多数会直接拒绝挂载，等于没解决问题。
         *
         * 失败原因记进 `tlsError`，由路由层带回界面：否则用户只会看到「已启用，服务正在
         * 启动…」永远转圈，看不出是缺证书。
         */
        const tls = loadTlsCert();
        if (!tls.ok) {
          tlsError = `${tls.reason}；WebDAV 强制 HTTPS，因此不会启动。${hintText(tls)}。`;
          console.error('[Storage Manager] WebDAV 未启动：' + tlsError);
          return;
        }
        tlsError = '';
        const srv = https.createServer({ key: tls.key, cert: tls.cert }, buildApp());
        srv.on('error', (e) => {
          if (e.code === 'EADDRINUSE') {
            console.error(`[Storage Manager] WebDAV 启动失败：端口 ${DEFAULT_PORT} 已被占用，请设置环境变量 WEBDAV_PORT=<其他端口> 后重启。`);
          } else {
            console.error('[Storage Manager] WebDAV 服务错误：', e.message);
          }
        });
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(DEFAULT_PORT, HOST, resolve);
        });
        server = srv;
        console.log(`[Storage Manager] WebDAV : ${serverUrl()}（HTTPS，强制加密）`);
      } catch (e) {
        console.error('[Storage Manager] WebDAV 启动失败：', e.message);
      } finally {
        starting = null;
      }
    })();
    await starting;
  } else if (!shouldRun && server) {
    const srv = server;
    server = null;
    await new Promise((resolve) => {
      try {
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        srv.close(() => resolve());
      } catch (e) { resolve(); }
    });
    console.log('[Storage Manager] WebDAV 服务已停止');
  }
}

function start() { return apply(); }

function isRunning() { return Boolean(server); }

function close() {
  const srv = server;
  if (!srv) return Promise.resolve();
  server = null;
  return new Promise((resolve) => {
    try {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      srv.close(() => resolve());
    } catch (e) { resolve(); }
  });
}

module.exports = {
  start, apply, close, isRunning, serverUrl, MOUNT, DEFAULT_PORT,
  // R49：界面需要知道「WebDAV 为何没起来」——缺证书与正在启动必须能区分
  getTlsError,
  // 仅供测试：SEC-12 路径→Key 的归一化必须可被直接驱动（幽灵对象的根源在它）
  __reqPathToKey: reqPathToKey,
  // 仅供测试：R34「挂载点判据唯一实现点」必须可被直接驱动（9 处手写正是根路径漏判的成因）
  __inMount: inMount,
  __PROPFIND_CAP: PROPFIND_CAP,
  // 仅供测试：R21-14「错误响应不得回显上游原始 message」必须可被直接驱动
  __davErrorMessage: davErrorMessage,
};
