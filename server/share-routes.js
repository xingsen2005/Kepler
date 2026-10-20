/**
 * 公开分享页路由 —— 挂载于根路径（/s/:id）
 *
 *  - GET  /s/:id      链接信息页：过期 / 次数用尽 / 密码表单 / 下载页
 *                     （R51：多文件 / 文件夹分享渲染成**分页列表 + 勾选**，
 *                      见下方「列表页」一节的 `?page=N`）
 *  - POST /s/:id      提交访问密码（表单），通过后种 Cookie 并回跳
 *  - GET  /s/:id/dl   执行下载：校验全部限制 -> 占用名额 -> 流式转发对象存储对象
 *                     （R51：带 `?k=<key>` 时只下发勾选的那些；单选直传、
 *                      多选或含文件夹则打包成 .tar.gz，见 `share-bundle.js`）
 *
 * 三种限制（有效期 / 次数 / 密码）由 share-store 统一判定，可任意组合。
 * 第四种限制「付费下载」见下方 —— 未支付 / 支付中 / 支付失败一律禁止下载。
 *
 * ## R64：取回下载权限的三条入口
 *
 * 付费链接一旦丢了「支付凭证 Cookie」（换设备、清缓存、Cookie 过期七天），
 * 付过钱的人就再也进不去下载页 —— 旧版本只能重新付款。本轮补上两条路：
 *
 *  - `GET|POST /s/:id/restore`  **恢复购买**：输入订单号取回（游客的主路径，
 *    因为他没有账号可以归集订单）；
 *  - `GET /s/:id/history`       **查看历史订单**：已登录用户看自己的全部已购订单，
 *    外加免费下载过的文件（只记首次，见 `download-log.js`），逐条可重新下载。
 *
 * 另有 `POST /s/:id/logout`：右上角「退出登录」。分享页是服务端渲染的普通文档，
 * 发不了带 `X-Requested-With` 头的请求（`/api/auth/logout` 的 CSRF 要求），
 * 因此这里给分享侧开一条**同源表单**可提交的退出口 —— 它仍受本文件顶部那道
 * 「非安全方法必须同源」的校验保护。
 */
const express = require('express');
const { PassThrough } = require('stream');
const shareStore = require('./share-store');
const configStore = require('./config-store');
const statsStore = require('./stats-store');
const encStore = require('./enc-store');
const security = require('./security');
const paymentProviders = require('./payment-providers');
const paymentRules = require('./payment-rules');
const paymentOrders = require('./payment-orders');
const paymentGateway = require('./payment-gateway');
// R62：优惠券 —— 校验 / 核销 / 退款回退的唯一实现点在 coupon-store
const couponStore = require('./coupon-store');
// R62：分享页也要能认出「已登录的人」—— 只有这样「限特定用户」与「每人一次」才成立
const authSession = require('./auth-session');
// R64：订单号编解码（36 位「时间戳 + 链接 UID + 用户 UID + 随机串」的唯一实现点）
const orderNo = require('./order-no');
// R64：免费下载记录 —— 「查看历史订单」里「免费下载的文件」的唯一来源（只记首次）
const downloadLog = require('./download-log');
// R65：订单取回的连续输错封禁（只作用于取回端点，见该模块文件头）
const restoreGuard = require('./restore-guard');
const { getClient, p, tracked } = require('./s3');
const { streamDownload } = require('./download-stream');
// R51：勾选多个（或含文件夹）时的打包下发 —— 零依赖 tar.gz，见该模块文件头
const { streamBundle } = require('./share-bundle');
// R37：下载限速的唯一入口（与 /fs/download、WebDAV 共用同一份判定）
const { makeThrottle } = require('./throttle');
const { classifyDownloadSource } = require('./share-origin');
// R50：分享页的文件类型图标。图形只在 public/index.html 的 #icon-sprite 里定义一份，
// 本模块只负责把对应符号**内联**进服务端渲染的页面（分享页没有那套雪碧）。
const fileIcons = require('./file-icons');
const { singleFlight } = require('./coalesce'); // R14-10：并发合并读（唯一实现点）
const { asyncHandler } = require('./routes/_shared'); // R17-04：async 抛错交回统一错误中间件

const router = express.Router();
router.use(express.urlencoded({ extended: false }));
// 异步通知是 JSON（微信 / PayPal），支付宝则是表单；两者都要能解析
router.use(express.json({ limit: '256kb' }));

/**
 * SEC-04：`/s/*` 的非安全方法同源校验。
 *
 * `csrfGuard`（要求自定义头 `X-Requested-With`）只挂在 `/api` 上，于是
 * `POST /s/:id`（提交访问密码）、`POST /s/:id/pay`（创建订单）、
 * `POST /s/:id/pay/check`（手动查单）可以被任意第三方页面的自动提交表单触发。
 * 危害有限（不会真的扣款），但会污染订单列表并消耗网关下单配额。
 *
 * 排除 `/pay/notify/*`：那是**支付网关**主动回调，天然跨站，且另有验签 + 限流（SEC-03）。
 *
 * 判定只在**有确凿跨站证据**时拒绝（Sec-Fetch-Site / Origin / Referer 三者任一
 * 表明来自别的站）。无来源提示的请求按直连客户端放行 —— 那不是 CSRF 场景，
 * 拒绝只会误伤脚本化使用。
 */
const SAFE_METHOD_SET = new Set(security.SAFE_METHODS || ['GET', 'HEAD', 'OPTIONS']);
router.use((req, res, next) => {
  if (SAFE_METHOD_SET.has(req.method)) return next();
  if (String(req.path || '').indexOf('/pay/notify/') === 0) return next();

  const origin = String(req.headers.origin || '').trim();
  //
  // `Origin: null`（**字符串** "null"，不透明来源）必须落到下面那套判定，不能在这里硬拒：
  // 沙箱 iframe（`<iframe sandbox>`、各类内置预览面板）、`file://` 页面、
  // https→http 降级，浏览器都会发这个字面量。它是「拿不到来源」，不是「来自别的站」——
  // 而 `new URL('null')` 会抛异常 → `ok=false` → 直接 403，于是密码页 / 支付页的
  // 表单一律提交失败（页面上只看到一句「请求来源校验失败」）。
  //
  // 安全上并不因此放松：真正的跨站证据（`Sec-Fetch-Site: cross-site`、
  // 跨站 Referer、可解析的跨站 Origin）仍由下面的 `classifyDownloadSource` 拦掉；
  // 攻击者用沙箱 iframe 造出 `Origin: null` 时，浏览器同样会带 `Sec-Fetch-Site: cross-site`。
  if (origin && origin !== 'null') {
    let ok = false;
    try {
      const u = new URL(origin);
      /**
       * R27-03：协议判据必须走 `security.requestIsSecure()`。
       *
       * 旧实现用裸 `req.secure` —— 反代 TLS 终结下它恒为 `false`（本服务从不
       * `app.set('trust proxy', …)`），而 HTTPS 页面发出的 `Origin` 是 `https://host`，
       * 于是**同源请求被判成跨站**：`POST /s/:id`（访问密码）、`POST /s/:id/unlock`
       * （查看密码）、`POST /s/:id/pay`、`POST /s/:id/pay/check` 在默认部署下
       * 一律 403「请求来源校验失败」。页面显示的是安全提示，实际是自己的防护
       * 把正常用户挡在外面（fail-closed，故不是绕过，但功能整体不可用）。
       */
      const proto = security.requestIsSecure(req) ? 'https:' : 'http:';
      ok = u.protocol === proto && u.host === String(req.headers.host || '');
    } catch (e) { ok = false; }
    if (!ok) {
      statsStore.addLog({ action: 'share.csrf', level: 'warn', detail: `跨站 ${req.method} ${req.path} 已拒绝（Origin：${origin}）` });
      return res.status(403).json({ error: '请求来源校验失败，已拒绝（CSRF 防护）' });
    }
    return next(); // Origin 明确同源，直接放行
  }

  const v = classifyDownloadSource({
    secFetchSite: req.headers['sec-fetch-site'],
    referer: req.headers.referer || req.headers.referrer,
    host: req.headers.host,
    secure: security.requestIsSecure(req), // R27-03：与上面同一判据（Referer 回退分支同病）
    hasTicket: false,
  });
  if (!v.allow) {
    statsStore.addLog({ action: 'share.csrf', level: 'warn', detail: `跨站 ${req.method} ${req.path} 已拒绝（${v.reason}）` });
    return res.status(403).json({ error: '请求来源校验失败，已拒绝（CSRF 防护）' });
  }
  return next();
});

const COOKIE_MAX_AGE = 7 * 24 * 3600 * 1000; // 密码通过后的 Cookie 有效期 7 天
const cookieName = (id) => 'sp_' + id;
/** 已支付订单票据（与密码票据分开存放，互不干扰） */
const payCookieName = (id) => 'sp_' + id + '_pay';

/**
 * R62：这个浏览器在这条链接上选中的优惠券码。
 *
 * ⚠️ 与 `payCookieName` **刻意分开**：那张是**订单凭证**（HMAC 票据，决定能不能下载），
 * 这张只是用户的一次输入（随时可换、可清空）。混在一起会让「换券」把支付凭证顶掉。
 */
const couponCookieName = (id) => 'sp_' + id + '_coupon';
/**
 * R21-01：加密访问令牌在**分享侧**的存放位置。
 *
 * 分享页是服务端渲染的（下载入口就是一条普通 `<a href="/s/:id/dl">` 导航），
 * 没法像管理端那样给 `fetch` 挂 `X-Enc-Token` 请求头 —— 而服务端**只有**
 * `GET /s/:id/dl` 与 `HEAD /s/:id/dl` 会解密下发。因此分享侧另发一枚
 * HttpOnly Cookie，作用域限定 `path: '/s/'`：
 *   · 它不会出现在 URL / 浏览器历史 / Referer / 访问日志里（与 S5 同一条理由）；
 *   · 它**不会被任何 `/api/**` 请求携带** —— 管理端仍只认请求头，两套互不干扰。
 * 令牌本身与管理端同一枚（`encStore.issueToken()`：30 分钟、与查看密码哈希绑定，
 * 改密即全部失效）。
 */
const ENC_COOKIE = 'ke_enc';

/**
 * R64：把「当前访问者是谁」与「当前是哪条分享链接」贴到 `res.locals` 上。
 *
 * 为什么走中间件而不是给每个页面函数加参数：分享页有十来处渲染入口
 * （信息页 / 列表页 / 支付页 / 二维码页 / 密码页 / 错误页…），而右上角的
 * 「登录 / 退出登录」在**每一张页面**上都要出现。逐个传参意味着每加一个页面
 * 都要记得补一次 —— 漏一处就是"某些页面右上角没有退出入口"，而这种漏
 * 只有截图才发现。`renderPage()` 读 `res.locals` 一处即可全覆盖。
 *
 * ⚠️ 只做一次会话解析（内存 Map 查询），不触网、不读写磁盘，对演示页的开销可忽略。
 */
router.use((req, res, next) => {
  let user = null;
  try {
    const token = authSession.parseToken(req);
    const s = token ? authSession.getSession(token) : null;
    user = s && s.user ? { id: String(s.user.id || ''), username: String(s.user.username || '') } : null;
  } catch (e) { user = null; }
  res.locals.shareUser = user;
  // 路径形如 /s/<id>、/s/<id>/dl、/s/<id>/history…；取第一段
  const m = /^\/s\/([^/]+)/.exec(String(req.path || ''));
  res.locals.shareLinkId = m ? m[1] : '';
  next();
});

/** 当前请求的登录用户（无会话时返回 null）—— 「已登录」的唯一判据 */
function shareUser(req) {
  return (req && req.res && req.res.locals && req.res.locals.shareUser) || null;
}

/** 轮询查单的最小间隔（毫秒）—— 与页面轮询间隔一致，避免被刷成网关压力 */
const STATUS_QUERY_MIN_GAP_MS = 3000;
const statusQueryAt = new Map(); // orderId -> 上次查单时间戳

/**
 * FUN-12：节流表必须自己收敛。
 *
 * 旧实现每个微信订单永久留一条 —— 订单只增不减，这张表就是一条单调上升的内存曲线。
 * 节流窗口只有 3 秒，超过 RETAIN 的条目再也不会被读到，留着毫无意义。
 */
const STATUS_QUERY_RETAIN_MS = 60 * 60 * 1000; // 保留 1 小时，足够覆盖最长支付会话
const STATUS_QUERY_MAX = 5000;
function noteStatusQuery(orderId) {
  const now = Date.now();
  statusQueryAt.set(orderId, now);
  if (statusQueryAt.size < 64) return; // 小规模时不做清扫，避免每次轮询都全表遍历
  for (const [k, t] of statusQueryAt) {
    if (now - t > STATUS_QUERY_RETAIN_MS) statusQueryAt.delete(k);
  }
  while (statusQueryAt.size > STATUS_QUERY_MAX) {
    const oldest = statusQueryAt.keys().next();
    if (oldest.done) break;
    statusQueryAt.delete(oldest.value);
  }
}

/* ---------------------- 付费状态判定 ---------------------- */

/**
 * 当前支付能力快照：总开关 / 渠道开关 / 凭证完整 / 可用渠道。
 * 任何异常都降级为「不可用」—— 支付读不出来时宁可让链接免费，也不要把下载者卡死。
 */
function paySnapshot() {
  try {
    const stored = configStore.getPayment();
    return Object.assign({ enabled: stored.enabled }, paymentRules.snapshot(
      stored.platforms, paymentProviders.ORDER,
      (id) => paymentProviders.isConfigured(id, stored.platforms[id]),
    ));
  } catch (e) {
    return { enabled: false, states: {}, configuredMap: {}, available: [] };
  }
}

/** 该链接「当前是否真的要付费」（全局开关与链接配置的唯一联动点） */
function paidStateFor(l) {
  const snap = paySnapshot();
  return paymentRules.resolvePaidState({
    globalEnabled: snap.enabled,
    channelStates: snap.states,
    configuredMap: snap.configuredMap,
    linkPaid: l.paid,
  });
}

/**
 * R62：订单**未成交**时把券还回去。
 *
 * 券是在建单时核销的（那一刻就要占住次数，否则同一张「每人一次」的券能被
 * 并发下出多笔订单）。因此下单失败 / 网关拒绝时**必须**回退，否则用户一次
 * 都没付成，券却被扣掉一次 —— 表现是「试了两次就提示已用尽」。
 *
 * 与退款回退（`routes/payment.js`）共用 store 的同一个 `releaseByOrder()`：
 * 按**订单号**定位，天然幂等（找不到就返回 null）。
 */
function releaseCouponForOrder(order) {
  if (!order || !order.couponId) return null;
  return couponStore.releaseByOrder(order.id);
}

/** 访问者对该链接的支付状态 */
function payerStateFor(l, req) {
  return paymentOrders.payerState(l.id, getCookie(req, payCookieName(l.id)));
}

/**
 * R62：分享页访客身份。
 *
 * 分享页是**匿名可达**的，但 `限特定用户` 与「每用户只能使用一次」都必须认人。
 * 判据分两层，且**只有这一处**：
 *  · 有有效会话 → 用账号 id（这是唯一可信的身份）；
 *  · 没有会话 → 交给 `couponStore.identityFrom()` 用「出口 IP + UA」近似。
 *    ⚠️ 这只够支撑「每用户一次」，**不能**支撑「限特定用户」—— 那种券在
 *    `validateForUse()` 里要求 `userId` 非空且命中名单，匿名访客必然被判 `wrong_user`。
 */
function visitorIdentity(req) {
  // R64：会话解析收敛到 `shareUser()`（挂在 `res.locals` 上的那一次），不再各解析一遍
  const me = shareUser(req);
  const userId = me ? me.id : '';
  return {
    userId,
    identity: couponStore.identityFrom({
      userId,
      ip: security.clientIp(req),
      userAgent: req.headers['user-agent'],
    }),
  };
}

/**
 * R62：读取并校验「当前浏览器选中的券」。
 *
 * @returns {null | {code:string, ok:boolean, message:string,
 *                   originalFen?:number, discountFen?:number, payableFen?:number, coupon?:object}}
 *   `null` = 这个浏览器没选券；`ok:false` 的返回**不会**被写进 Cookie（见 `POST /s/:id/coupon`）。
 */
function couponStateFor(l, req) {
  const code = getCookie(req, couponCookieName(l.id));
  if (!code) return null;
  const who = visitorIdentity(req);
  const r = couponStore.validateForUse({
    code, link: l, identity: who.identity, userId: who.userId,
  });
  if (!r.ok) return { code, ok: false, message: r.message };
  return {
    code,
    ok: true,
    message: '',
    originalFen: r.originalFen,
    discountFen: r.discountFen,
    payableFen: r.payableFen,
    coupon: r.coupon,
  };
}

/** 手动解析请求头中的 Cookie（避免引入 cookie-parser 依赖） */
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------- R64：取回下载权限的入口 ---------------------- */

/**
 * 卡片下方的入口链接 —— **付费链接才有**（需求 1 / 2）。
 *
 * 两条分支的判据只有一个：当前请求有没有登录会话。
 *  · 未登录 → 「恢复购买」：凭订单号取回（游客没有账号可归集订单，只能靠号码）；
 *  · 已登录 → 「查看历史订单」：自己的全部已购订单 + 免费下载记录。
 *
 * ⚠️ 位置是「卡片下方」而不是卡片内的某一处：两张入口在**所有**支付相关页面
 * 上都要出现（含「未支付」的付费页）—— 因为丢凭证的人看到的正是**未支付**页，
 * 而那时他最需要的恰恰是「恢复购买」。
 */
function paidBelowHtml(l, res) {
  const id = esc(l.id);
  const acct = res && res.locals ? res.locals.shareUser : null;
  if (acct) {
    return `<a class="tag-link" href="/s/${id}/history">查看历史订单</a>`;
  }
  return `<a class="tag-link" href="/s/${id}/restore">恢复购买</a>`;
}

/**
 * 订单号展示块（需求 3②）—— 展示 + 一键复制 + 唯一凭证提示。
 *
 * 复制走 `public/js/share-order.js`（同源普通脚本，CSP 不允许内联脚本）；
 * 脚本不可用时订单号本身就是可选中的文本，仍能手工抄下来。
 */
function orderNoBox(no) {
  const v = String(no || '');
  if (!v) return '';
  return `
      <div class="orderno-box">
        <div class="orderno-label">订单号</div>
        <div class="orderno-row">
          <code class="orderno" id="order-no">${esc(v)}</code>
          <button class="copybtn" type="button" data-copy-order="${esc(v)}">复制</button>
        </div>
        <div class="orderno-tip">请妥善保存：订单号是售后和取回下载权限的唯一凭证。</div>
      </div>`;
}

/** 订单号展示块 + 复制脚本（两处都要用，合并成一个片段避免漏挂脚本） */
function orderNoScript() {
  return '<script src="/js/share-order.js" defer></script>';
}

/* ---------------------- R21-01：加密访问门禁 ---------------------- */

/**
 * 本次访问是否必须**先过「加密访问密码」**。
 *
 * 判据与 `.routes/fs.js` 的 `/fs/download`、`/fs/head` 完全一致
 * （`encMeta && encStore.passwordSet()`）—— 全库只有这一份实现，分享侧直接复用，
 * 避免同一件事出现第二种口径。
 *
 * 背景：README「查看密码」一节写的是「设置后**查看 / 下载**加密文件前须验证」，
 * 而分享下载路径此前**完全没有这道门禁**：任何登录用户（无需管理员、无需知道
 * 加密访问密码）对自己看得见的密文对象建一条分享链接，访问 `/s/:id/dl` 即可
 * 拿到**解密后的明文**；匿名访客拿到这样一条链接同样能下载。服务端「加密」的
 * 唯一访问控制在分享路径上被整体绕过。
 */
function encGateNeeded(l) {
  if (!l) return false;
  if (!encStore.passwordSet()) return false; // 未设访问密码 → 加密只是静态保护，不拦下载
  return !!encStore.getMeta(l.bucket, l.key); // 只有密文对象才需要解密权限
}

/** 分享侧加密令牌：优先请求头（脚本 / curl），其次本页作用域的 Cookie */
function encTokenOf(req) {
  const h = String(req.get('x-enc-token') || '');
  return h || getCookie(req, ENC_COOKIE);
}

function encUnlocked(req) {
  return encStore.verifyToken(encTokenOf(req));
}

/** 加密访问令牌 Cookie 的选项（与分享密码 Cookie 同样：HttpOnly + 部署模式 Secure） */
function encCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!security.IS_DEPLOY,
    maxAge: encStore.TOKEN_TTL_MS,
    path: '/s/', // 只发给分享路由，绝不进入 /api/**
  };
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------ 页面模板 ------------------------------ */

function renderPage(res, status, { title, head, body, wide, below }) {
  /**
   * R13-07：状态码白名单。全部调用方都传本地字面量（含 401 = 分享密码错误页，属本地语义），
   * 白名单把这份「本地性」变成机器可查的凭据 —— 上游状态若意外渗入（例如把云端错误码
   * 直接当页面状态）会被收敛成 500，而不会占用本地 401/403 语义。
   */
  const code = [200, 400, 401, 402, 403, 404, 410, 429, 503].indexOf(status) >= 0 ? status : 500;
  const acct = (res.locals && res.locals.shareUser) || null;
  const linkId = (res.locals && res.locals.shareLinkId) || '';
  const accountBar = acct
    ? `<span class="tb-user" title="${esc(acct.username)}">${esc(acct.username)}</span>
      <form method="POST" action="/s/${esc(linkId)}/logout" class="tb-form"><button class="tb-link" type="submit">退出登录</button></form>`
    : `<a class="tb-link" href="/${linkId ? `?next=${encodeURIComponent('/s/' + linkId)}` : ''}">登录</a>`;
  res.status(code).type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)} - 文件分享</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    background: #f2f5f9; color: #1b1b1b; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 8px 32px rgba(15,35,70,.08);
    width: 100%; max-width: 460px; padding: 34px 34px 28px; }
  /* R51：列表页要放下「路径 + 大小 + 图标」三列，460px 会把长路径压成两三行。
     只有列表页加这个类，其余页面（密码 / 支付 / 状态）保持窄卡片。 */
  .card.wide { max-width: 860px; }
  .brand { display: flex; align-items: center; gap: 8px; color: #0067c0;
    font-weight: 600; font-size: 13px; margin-bottom: 22px; }
  .brand .logo { width: 22px; height: 22px; border-radius: 6px; background: #0067c0;
    display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; }
  h1 { font-size: 19px; margin-bottom: 6px; }
  .sub { color: #8a8f98; font-size: 13px; line-height: 1.7; }
  .meta { margin: 18px 0; border-top: 1px solid #eef1f5; }
  .meta div { display: flex; justify-content: space-between; padding: 10px 0;
    border-bottom: 1px solid #eef1f5; font-size: 13px; }
  .meta span { color: #8a8f98; }
  .meta b { font-weight: 500; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { display: block; width: 100%; border: 0; border-radius: 8px; cursor: pointer;
    padding: 12px; font-size: 15px; margin-top: 20px; }
  .btn.primary { background: #0067c0; color: #fff; }
  .btn.primary:hover { background: #005da8; }
  .warn { background: #fff7ed; color: #b45309; border: 1px solid #fed7aa;
    border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
  .ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0;
    border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
  input[type=password] { width: 100%; border: 1px solid #d5dbe3; border-radius: 8px;
    padding: 11px 12px; font-size: 15px; outline: none; }
  input[type=password]:focus { border-color: #0067c0; box-shadow: 0 0 0 3px rgba(0,103,192,.12); }
  /* R64：订单号输入框（恢复购买）。与密码框同一形态，等宽字体便于核对号码 */
  input[type=text] { width: 100%; border: 1px solid #d5dbe3; border-radius: 8px;
    padding: 11px 12px; font-size: 14px; outline: none;
    font-family: Consolas, "Courier New", monospace; letter-spacing: .02em; }
  input[type=text]:focus { border-color: #0067c0; box-shadow: 0 0 0 3px rgba(0,103,192,.12); }
  .foot { margin-top: 22px; text-align: center; color: #b3b9c2; font-size: 11px; }
  .icon-big { width: 46px; height: 46px; border-radius: 12px; margin-bottom: 16px;
    display: flex; align-items: center; justify-content: center; }
  /* 卡片内的标题块统一居中：金额（.pay-amount）与二维码（.qr-box）本就是居中的，
     若标题块左对齐，同一张卡片里会出现「左标题 + 居中金额」的排版错位。
     .icon-big 是定宽 flex，text-align 管不到它，必须靠 margin 居中。 */
  .center-head { text-align: center; }
  .center-head .icon-big { margin-left: auto; margin-right: auto; }
  /* R50：文件类型图标（内联 SVG，见 server/file-icons.js）。符号自带 1024 圆角底色，
     故这里**不**再给任何背景 —— 与文件列表里的图标逐像素同源。
     它和 .icon-big 一样是定宽块，text-align 管不到，必须靠 margin 居中。 */
  .center-head .file-icon { display: block; margin: 0 auto 14px; }
  .pay-amount { font-size: 27px; font-weight: 600; color: #b45309; text-align: center; margin: 4px 0 2px; }
  /* R62：用券后的「原价」—— 划线 + 变灰，与下方突出的优惠价形成对比（需求 5） */
  .pay-orig { text-align: center; color: #9aa1ab; font-size: 14px; text-decoration: line-through;
    text-decoration-thickness: 1px; margin-top: 6px; }
  .pay-cap { text-align: center; color: #8a8f98; font-size: 12px; }
  /* R62：优惠券折叠块 —— 默认收起，点「使用优惠券」展开。
     用原生 <details>/<summary>：分享页是服务端渲染、且 CSP 不允许内联脚本，
     原生折叠是这里唯一「零脚本且一定能用」的形态。 */
  .coupon-box { margin-top: 14px; border: 1px solid #d5dbe3; border-radius: 8px; padding: 0 12px; }
  .coupon-box summary { cursor: pointer; padding: 11px 0; font-size: 13px; color: #0067c0;
    list-style: none; outline: none; user-select: none; }
  .coupon-box summary::-webkit-details-marker { display: none; }
  .coupon-box summary::before { content: '＋ '; }
  .coupon-box[open] summary::before { content: '－ '; }
  .coupon-form { display: flex; gap: 8px; align-items: center; padding: 0 0 12px; margin: 0; }
  .coupon-form input[type=text] { flex: 1 1 auto; min-width: 0; width: auto;
    border: 1px solid #d5dbe3; border-radius: 8px; padding: 9px 11px; font-size: 13px;
    outline: none; letter-spacing: .06em; }
  .coupon-form input[type=text]:focus { border-color: #0067c0; box-shadow: 0 0 0 3px rgba(0,103,192,.12); }
  /* ⚠️ .btn 的基础样式是 display:block; width:100% —— 放进 flex 行会把输入框挤成一条
     （实测截图里就是一个几十像素的空盒子）。这里必须显式改成「按内容自适应、不收缩」。 */
  .coupon-form .btn { flex: 0 0 auto; width: auto; margin: 0; padding: 9px 14px;
    font-size: 13px; white-space: nowrap; }
  .pay-opts { margin: 16px 0 2px; }
  .pay-opt { display: flex; align-items: center; gap: 9px; padding: 11px 12px;
    border: 1px solid #d5dbe3; border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 14px; }
  .pay-opt:hover { border-color: #0067c0; background: #f6faff; }
  .pay-note { background: #fff7ed; color: #b45309; border: 1px solid #fed7aa;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; margin-top: 14px; line-height: 1.7; }
  .row2 { display: flex; gap: 10px; }
  .row2 .btn { margin-top: 12px; }
  .btn.ghost { background: #fff; color: #616161; border: 1px solid #d5dbe3; }
  .btn.ghost:hover { background: #f6f8fb; }
  .qr-box { display: flex; justify-content: center; margin: 16px 0 4px; }
  .qr-box svg { width: 208px; height: 208px; border: 1px solid #e5e8ec; border-radius: 10px; padding: 6px; background: #fff; }
  /* ---------- R51：多文件 / 文件夹分享的列表页 ---------- */
  .sl-bar { display: flex; align-items: center; gap: 10px; margin: 16px 0 8px; flex-wrap: wrap; }
  .sl-bar .btn { display: inline-block; width: auto; margin: 0; padding: 7px 12px; font-size: 13px; border-radius: 7px; }
  .sl-count { color: #8a8f98; font-size: 12px; margin-left: auto; }
  .sl-list { border: 1px solid #e5e8ec; border-radius: 10px; overflow: hidden; }
  .sl-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: 13px;
    border-bottom: 1px solid #f2f4f7; cursor: pointer; }
  .sl-row:last-child { border-bottom: 0; }
  .sl-row:hover { background: #f6faff; }
  .sl-row.on { background: #eef6ff; }
  .sl-row input[type=checkbox] { width: 15px; height: 15px; flex: none; margin: 0; cursor: pointer; }
  .sl-ico { flex: none; display: flex; width: 20px; height: 20px; }
  .sl-name { flex: 1; min-width: 0; word-break: break-all; line-height: 1.6; }
  .sl-name.dir { color: #0067c0; font-weight: 500; }
  .sl-size { flex: none; color: #8a8f98; font-size: 12px; font-variant-numeric: tabular-nums; }
  .sl-empty { padding: 26px 10px; text-align: center; color: #8a8f98; font-size: 13px; }
  .sl-pager { display: flex; align-items: center; justify-content: center; gap: 6px;
    margin: 14px 0 2px; flex-wrap: wrap; font-size: 13px; }
  .sl-pager a, .sl-pager span.cur, .sl-pager span.gap { padding: 5px 10px; border-radius: 6px;
    border: 1px solid #e5e8ec; text-decoration: none; color: #444; }
  .sl-pager span.cur { background: #0067c0; border-color: #0067c0; color: #fff; }
  .sl-pager span.gap { border: 0; color: #b3b9c2; }
  .sl-pager a:hover { border-color: #0067c0; color: #0067c0; }
  .sl-tip { color: #8a8f98; font-size: 12px; line-height: 1.7; margin: 10px 0 0; }
  /* R51：中文档名很长时，文件名那一列不能被图标与大小挤没（min-width:0 + break-all） */
  .sl-row .sl-name { overflow-wrap: anywhere; }
  /* ---------- R64：右上角「登录 / 退出登录」 + 卡片下方的「取回下载权限」入口 ---------- */
  /* 固定在视口右上角（需求：在整个页面的右上角）。用 fixed 而不是绝对定位在卡片里：
     卡片宽度随 wide 变化，贴卡片右上角会让不同页面的位置漂移。 */
  .topbar { position: fixed; top: 0; right: 0; z-index: 10; display: flex;
    align-items: center; gap: 8px; padding: 14px 18px; font-size: 13px; line-height: 1.4; }
  .topbar .tb-user { color: #8a8f98; max-width: 150px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .tb-form { display: inline; margin: 0; }
  .tb-link { color: #0067c0; text-decoration: none; background: none; border: 0;
    font: inherit; cursor: pointer; padding: 3px 6px; border-radius: 6px; }
  .tb-link:hover { background: #e8f1fb; }
  /* 卡片与它下方的链接同处一列：body 是 flex 居中，故外面套一层纵向容器 */
  .page { width: 100%; display: flex; flex-direction: column; align-items: center; }
  .below-card { width: 100%; max-width: 460px; margin-top: 14px; text-align: center; font-size: 13px; }
  .below-card.wide { max-width: 860px; }
  .tag-link { color: #0067c0; text-decoration: none; border-bottom: 1px dashed #9dc4e8; padding-bottom: 1px; }
  .tag-link:hover { border-bottom-style: solid; }
  /* 订单号：等宽字体 + 可换行（36 位在窄屏上必然折行，不许被 ellipsis 吃掉半个号码） */
  .orderno-box { margin-top: 18px; border: 1px solid #dbe6f1; background: #f7fbff;
    border-radius: 10px; padding: 12px 13px; }
  .orderno-label { color: #5b6472; font-size: 12px; margin-bottom: 8px; }
  .orderno-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .orderno { font-family: Consolas, "Courier New", monospace; font-size: 13px;
    letter-spacing: .02em; color: #1b1b1b; word-break: break-all; flex: 1 1 190px; min-width: 0; }
  .copybtn { flex: 0 0 auto; border: 1px solid #b9d4ea; background: #fff; color: #0067c0;
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .copybtn:hover { background: #e8f1fb; }
  .orderno-tip { color: #b45309; font-size: 12px; line-height: 1.7; margin-top: 8px; }
  /* 历史订单 / 恢复购买的列表行 */
  .hs-sec { margin-top: 18px; }
  .hs-title { font-size: 13px; color: #5b6472; margin-bottom: 8px; }
  .hs-list { border: 1px solid #e5e8ec; border-radius: 10px; overflow: hidden; }
  .hs-row { display: flex; align-items: flex-start; gap: 10px; padding: 11px 12px;
    border-bottom: 1px solid #f2f4f7; font-size: 13px; }
  .hs-row:last-child { border-bottom: 0; }
  .hs-main { flex: 1; min-width: 0; }
  .hs-name { word-break: break-all; line-height: 1.6; }
  .hs-meta { color: #8a8f98; font-size: 12px; margin-top: 3px; }
  .hs-no { margin-top: 5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .hs-no code { font-family: Consolas, "Courier New", monospace; font-size: 12px;
    color: #5b6472; word-break: break-all; }
  .hs-act { flex: 0 0 auto; color: #0067c0; text-decoration: none; font-size: 13px;
    padding: 2px 0; white-space: nowrap; }
  .hs-act:hover { text-decoration: underline; }
  .hs-off { flex: 0 0 auto; color: #b3b9c2; font-size: 12px; white-space: nowrap; }
  .hs-empty { padding: 22px 12px; text-align: center; color: #8a8f98; font-size: 13px; }
  @media (max-width: 520px) {
    .topbar { padding: 10px 12px; }
    .topbar .tb-user { max-width: 96px; }
  }
</style>
</head>
<body>
  <div class="topbar">${accountBar}</div>
  <div class="page">
    <div class="card${wide ? ' wide' : ''}">
      <div class="brand">文件分享</div>
      ${head || ''}
      ${body || ''}
      <div class="foot">注意：该链接由分享者的存储管理系统生成，任何下载行为都会被记录。</div>
    </div>
    ${below ? `<div class="below-card${wide ? ' wide' : ''}">${below}</div>` : ''}
  </div>
</body>
</html>`);
}

/**
 * 状态页。
 * @param {string} state notfound | deleted | expired | exhausted | limited | crosssite
 * @param {object} l 链接视图（用于文案变量）
 * @param {string} [customMsg] 覆盖默认副标题（如限流/跨站拦截提示）
 */
function statePage(res, state, l, customMsg) {
  const map = {
    notfound: { code: 404, title: '链接不存在', sub: '该分享链接不存在或已被分享者删除。', icon: '?', bg: '#eef1f5', fg: '#8a8f98' },
    deleted: { code: 410, title: '文件已被删除', sub: '该分享链接指向的文件已被分享者删除，无法继续下载。', icon: '🗑', bg: '#f3f4f6', fg: '#6b7280' },
    expired: { code: 410, title: '链接已过期', sub: `该分享链接已于 ${l ? fmtDate(l.expiresAt) : '—'} 到期，已自动失效。`, icon: '⏱', bg: '#fff7ed', fg: '#b45309' },
    exhausted: { code: 410, title: '链接已关闭', sub: `该分享链接的下载次数已达上限（${l ? l.maxDownloads : 0} 次），已停止提供下载。`, icon: '✕', bg: '#fef2f2', fg: '#b91c1c' },
    limited: { code: 429, title: '请求过于频繁', sub: '下载请求过于频繁，请稍后重试。本次请求未占用下载次数。', icon: '⏳', bg: '#fff7ed', fg: '#b45309' },
    crosssite: { code: 403, title: '请求来源不受信任', sub: '该下载请求来自其它站点，已被拒绝。请在分享页面内点击下载。', icon: '⛔', bg: '#fef2f2', fg: '#b91c1c' },
  };
  const s = map[state] || map.notfound;
  const sub = (typeof customMsg === 'string' && customMsg) ? customMsg : s.sub;
  renderPage(res, s.code, {
    title: s.title,
    body: `
      <div class="center-head">
      <div class="icon-big" style="background:${s.bg};color:${s.fg};font-size:22px">${s.icon}</div>
      <h1>${s.title}</h1>
      <p class="sub">${esc(sub)}如有疑问，请联系分享者重新获取链接。</p>
      </div>`,
  });
}

/* ------------------------------ 信息页 ------------------------------ */

/**
 * 信息页（含下载按钮）。
 * @param {object} opts {extraRows: [[label, html]], note: string, noteKind: 'ok'|'warn',
 *                       order: object, below: string}
 *   `order` —— R64：已支付的订单，用于展示订单号（唯一凭证）；未支付时为空。
 *   `below` —— R64：卡片下方的「恢复购买 / 查看历史订单」入口，由 `paidBelowHtml()` 生成。
 */
function infoPage(res, l, opts = {}) {
  const v = shareStore.view(l, { items: true });
  // R51：多条目 / 文件夹分享走列表页（分页 + 勾选 + 打包下载）。
  // 判据 `listView` 来自 share-store，与下载端点使用的是**同一个**字段 ——
  // 否则会出现「页面是列表、下载却只认第一个文件」这种半吊子状态。
  if (v.listView) return listPage(res, l, v, opts);
  const remain = v.maxDownloads > 0 ? `剩余 ${Math.max(0, v.maxDownloads - v.downloads)} 次` : '不限次数';
  const extra = (opts.extraRows || []).map((r) => `<div><span>${esc(r[0])}</span><b>${r[1]}</b></div>`).join('');
  const note = opts.note ? `<div class="${opts.noteKind === 'ok' ? 'ok' : 'warn'}">${esc(opts.note)}</div>` : '';
  /**
   * R50：原来这里是一枚写死的 `📄` emoji —— 无论分享的是什么文件都长一个样，
   * 访问者看不出这是图片、视频还是压缩包。现在换成该文件**实际类型**的图标，
   * 与文件列表里看到的是同一套图形。
   *
   * ⚠️ 必须是**内联** SVG：分享页是服务端渲染的独立文档，没有 `index.html` 那套
   * 雪碧，`<use href="#fic-image">` 在这里只会画出一片空白（且不报错）。
   * 图形真相仍只有 `index.html` 一份，见 `server/file-icons.js` 的文件头注释。
   *
   * 降级：雪碧读不到（文件缺失/损坏）时 `inlineSvg()` 回空串，此处退回原来的
   * emoji —— 一枚图标不值得把一张公开页面打挂。
   */
  const fileIcon = fileIcons.inlineSvg(v.fileName, { size: 56, cls: 'file-icon' })
    || '<div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">📄</div>';
  renderPage(res, 200, {
    title: v.fileName,
    head: `<div class="center-head">
      ${fileIcon}
      <h1 style="word-break:break-all">${esc(v.fileName)}</h1>
      </div>`,
    body: `
      ${note}
      <div class="meta">
        <div><span>文件大小</span><b>${fmtSize(v.size)}</b></div>
        ${v.expiresAt ? `<div><span>有效期至</span><b>${fmtDate(v.expiresAt)}</b></div>` : '<div><span>有效期</span><b>永久有效</b></div>'}
        <div><span>允许被下载的次数</span><b>${remain}</b></div>
        ${v.hasPassword ? '<div><span>密码保护</span><b>已启用</b></div>' : ''}
        ${extra}
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}/dl" style="text-align:center;text-decoration:none">下载文件</a>
      ${opts.order ? orderNoBox(opts.order.orderNo || opts.order.id) + orderNoScript() : ''}`,
    below: opts.below,
  });
}

/** 付费页：展示金额与可选渠道，提交后创建订单 */

function payPage(res, l, ps, available, err, note = '', coupon = null) {
  const opts = available.map((id, i) => {
    const p = paymentProviders.platform(id);
    return `<label class="pay-opt"><input type="radio" name="platform" value="${esc(id)}"${i === 0 ? ' checked' : ''}> <span>${esc(p.name)}</span></label>`;
  }).join('');
  const c = coupon || null;
  const applied = Boolean(c && c.ok);
  /**
   * R62 需求 5：用了券就「原价划线变灰 + 优惠后价格突出」。
   * 没用券时保持原样（只有一个大金额）—— 凭空显示一个「原价」划线价会让
   * 免费/未用券的用户误以为自己错过了折扣。
   */
  const priceHtml = applied
    ? `<div class="pay-orig">¥${paymentRules.formatAmount(c.originalFen)}</div>
      <div class="pay-amount">¥${paymentRules.formatAmount(c.payableFen)}</div>
      <div class="pay-cap">已使用优惠券 <code>${esc(c.code)}</code>，优惠 ¥${paymentRules.formatAmount(c.discountFen)}</div>`
    : `<div class="pay-amount">¥${paymentRules.formatAmount(ps.amountFen)}</div>
      <div class="pay-cap">人民币（CNY）</div>`;
  // R62 需求 6：券无效时就地给出对应提示（未开始 / 已过期 / 已用尽 / 不适用 / 已用过…）
  const couponWarn = c && !c.ok ? `<div class="warn">${esc(c.message || '优惠券无效')}</div>` : '';
  /**
   * R62（UI 修正）：券码区放在「立即支付」**下方**，且**默认折叠**成一行「使用优惠券」。
   *
   * 三个理由：
   *  · 未用券的用户占多数，一整行输入框 + 按钮摆在价格与支付方式之间，会把
   *    「选支付方式 → 立即支付」这条主路径打断；
   *  · 折叠用原生 `<details>`，**不需要任何脚本**（分享页 CSP 不允许内联脚本）；
   *  · 只有「已选券」或「券无效」时才默认展开 —— 那两种情况用户必须看到输入框。
   *
   * ⚠️ 它必须**独立于支付表单**（HTML 不允许嵌套 `<form>`），且排在支付表单之后。
   */
  const couponBox = `
      <details class="coupon-box"${c ? ' open' : ''}>
        <summary>${applied ? '已使用优惠券（点击更换或取消）' : '使用优惠券'}</summary>
        ${couponWarn}
        <form method="POST" action="/s/${esc(l.id)}/coupon" class="coupon-form">
          <input type="text" name="code" value="${c && c.code ? esc(c.code) : ''}" placeholder="请输入优惠券码" maxlength="32" autocomplete="off" spellcheck="false">
          <button class="btn" type="submit">${applied ? '更换' : '应用'}</button>
          ${applied ? '<button class="btn ghost" type="submit" name="clear" value="1">不使用</button>' : ''}
        </form>
      </details>`;
  renderPage(res, err ? 400 : 200, {
    title: '付费下载',
    head: `<div class="center-head">
    
      <h1>${note ? '订单已退款，需重新支付' : '分享者要求该文件必须付费才可下载'}</h1>
      <p class="sub">${note ? '退款后的订单不再作为下载凭证，重新支付即可继续下载。' : '完成支付后即可下载，支付结果仅对该链接与当前浏览器有效。'}</p>
      </div>`,
    body: `
      ${err ? `<div class="warn">${esc(err)}</div>` : ''}
      ${note ? `<div class="warn">${esc(note)}</div>` : ''}
      ${priceHtml}
      <form method="POST" action="/s/${esc(l.id)}/pay">
        ${applied ? `<input type="hidden" name="coupon" value="${esc(c.code)}">` : ''}
        <div class="pay-opts">${opts}</div>
        <button class="btn primary" type="submit">立即支付</button>
      </form>
      ${couponBox}`,
    below: paidBelowHtml(l, res),
  });
}

/**
 * 已退款订单的统一提示文案（面向下载者）。
 *
 * 刻意不提"退款已到账"——本系统不知道钱是否真的退回去了，只知道管理员做了标记。
 */
function refundNote() {
  return '该笔订单已被分享者标记为已退款，原支付凭证已失效。请重新支付后再下载。';
}

/** 订单摘要（支付中 / 二维码两页共用） */
function orderMetaRows(order, extra) {
  const p = paymentProviders.platform(order.platform);
  return `
      <div><span>支付金额</span><b>¥${paymentRules.formatAmount(order.amountFen)}</b></div>
      <div><span>支付方式</span><b>${esc(p ? p.name : order.platform)}</b></div>
      <div><span>订单号</span><b>${esc(order.orderNo || order.id)}</b></div>
      ${extra || ''}`;
}

/**
 * 支付中：等待支付结果。
 *
 * 页面每 3 秒轮询一次 `/s/:id/pay/status`；服务端在轮询时**主动向网关查单**
 * （见 payment-gateway 的设计说明），确认到账后置为已支付，页面随即自动放行。
 * 轮询只解决"能不能自动刷新"，**不参与支付结果的判定**。
 */
function payingPage(res, l, order) {
  const p = paymentProviders.platform(order.platform);
  renderPage(res, 200, {
    title: '等待支付结果',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">⏳</div>
      <h1>等待支付结果</h1>
      <p class="sub">订单已创建，请在<b>${esc(p ? p.name : order.platform)}</b>完成支付后返回本页。</p>
      </div>`,
    body: `
      <div class="meta">
        ${orderMetaRows(order, '<div><span>支付状态</span><b id="pay-state">支付中…</b></div>')}
      </div>
      <div class="pay-note">请在<b>${esc(p ? p.name : order.platform)}</b>完成支付。支付成功后本页会自动放行，无需其他操作。</div>
      <form method="POST" action="/s/${esc(l.id)}/pay/check">
        <button class="btn primary" type="submit">我已完成支付，立即查询</button>
      </form>
      ${orderNoBox(order.orderNo || order.id)}
      <script src="/js/pay-poll.js" data-link-id="${esc(l.id)}" defer></script>
      ${orderNoScript()}`,
    below: paidBelowHtml(l, res),
  });
}

/** 微信支付 Native：展示二维码并轮询支付结果 */
function qrPayPage(res, l, order, charge) {
  const p = paymentProviders.platform(order.platform);
  renderPage(res, 200, {
    title: '扫码支付',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">⏳</div>
      <h1>请使用${esc(p ? p.name : '微信')}扫码支付</h1>
      <p class="sub">支付完成后本页会自动放行，无需刷新。</p>
      </div>`,
    body: `
      <div class="pay-amount">¥${paymentRules.formatAmount(order.amountFen)}</div>
      <div class="pay-cap">人民币（CNY）</div>
      <div class="qr-box">${charge.svg || ''}</div>
      <div class="meta">
        ${orderMetaRows(order, '<div><span>支付状态</span><b id="pay-state">等待扫码…</b></div>')}
      </div>
      <div class="pay-note">二维码由本服务本地生成，有效期以${esc(p ? p.name : '微信支付')}为准；若二维码过期，请返回上一步重新发起支付。</div>
      <a class="btn ghost" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">放弃并重新发起</a>
      ${orderNoBox(order.orderNo || order.id)}
      <script src="/js/pay-poll.js" data-link-id="${esc(l.id)}" defer></script>
      ${orderNoScript()}`,
    below: paidBelowHtml(l, res),
  });
}

/** 支付失败：给出原因并允许重新发起 */
function payFailedPage(res, l, order) {
  renderPage(res, 402, {
    title: '支付未完成',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#fef2f2;color:#b91c1c;font-size:20px">✕</div>
      <h1>上一次支付未完成</h1>
      <p class="sub">${esc(order.failReason || '支付未完成或被取消')}。请重新发起支付。</p>
      </div>`,
    body: `
      <div class="meta">
        <div><span>需付金额</span><b>¥${paymentRules.formatAmount(order.amountFen)}</b></div>
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">重新支付</a>`,
    below: paidBelowHtml(l, res),
  });
}

/**
 * R64：把一次**免费**下载记进 `download-log`（「查看历史订单」里那一栏的来源）。
 *
 * 三条判据都在这里，调用方不再各自判断：
 *  · 已登录 —— 游客没有稳定身份，记了也无从归集（且匿名记录的归属只能靠 IP，
 *    那会把同一出口后的不同人混成一个人）；
 *  · 本次确实没付费 —— 付过钱的下载属于订单，不该同时出现在"免费下载"里；
 *  · 同一文件只记首次 —— 由 `download-log.record()` 去重（需求 2②）。
 *
 * 位置在**传输成功之后**（与 `markDownloaded` 同一时机）：传输中途失败的文件
 * 不该出现在"我下载过什么"里。
 */
function noteFreeDownloads(req, l, files) {
  const me = shareUser(req);
  if (!me || !Array.isArray(files) || !files.length) return 0;
  try {
    return downloadLog.record({ userId: me.id, linkId: l.id, files });
  } catch (e) {
    return 0; // 记录失败不该影响下载本身（文件已经在传了）
  }
}

/**
 * 下载被拦截（未支付 / 支付中 / 支付失败） */

function payBlockedPage(res, l, ps, payer) {
  const map = {
    none: { code: 402, icon: '💰', bg: '#fdf6ec', fg: '#b45309', title: '需要付费后才能下载', sub: `该文件需支付 ¥${paymentRules.formatAmount(ps.amountFen)} 后方可下载。` },
    pending: { code: 402, icon: '⏳', bg: '#e8f1fb', fg: '#0067c0', title: '支付尚未完成', sub: '我们尚未收到支付成功的通知，请完成支付后再试。' },
    failed: { code: 402, icon: '✕', bg: '#fef2f2', fg: '#b91c1c', title: '支付未完成', sub: `上一次支付未成功：${payer.order && payer.order.failReason ? payer.order.failReason : '支付失败或被取消'}。` },
    refunded: { code: 402, icon: '↩', bg: '#f1f2f4', fg: '#616a75', title: '订单已退款', sub: refundNote() },
  };
  const s = map[payer.state] || map.none;
  renderPage(res, s.code, {
    title: s.title,
    body: `
      <div class="center-head">
      <div class="icon-big" style="background:${s.bg};color:${s.fg};font-size:22px">${s.icon}</div>
      <h1>${s.title}</h1>
      <p class="sub">${esc(s.sub)}${payer.state === 'none' ? '' : ''}</p>
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">${payer.state === 'pending' ? '查看支付状态' : '前往支付'}</a>`,
    below: paidBelowHtml(l, res),
  });
}

/* --------------------- 云端对象存在性探测 --------------------- */

/**
 * 只有「云端明确回答 404」才认定对象已被删除。
 *
 * 网络抖动 / 密钥失效 / 桶不存在都会走进同一个 catch，但那**不代表文件被删** ——
 * 一律按「文件仍然存在」处理（fail-open）：最坏的结果无非是页面照常显示、点击下载时才报错。
 * 反过来误标成已删除，会让一条本来好用的链接被永久判死，代价大得多。
 */
function isNotFound(e) {
  const status = Number(e && (e.statusCode || e.status));
  if (status === 404) return true;
  const code = String((e && (e.code || e.Code)) || '');
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject';
}

const EXISTS_TTL_MS = 60 * 1000;
/**
 * R14-10：**探测失败**时的短 TTL。
 *
 * 失败（凭据失效 / 桶被删 / 端点不可达 / 超时）此前既不留痕、也不与成功区分，
 * 于是同一链接的每个并发请求都各打一次云端、各挂最长 120 秒（COS SDK 的
 * `Timeout`），云端调用数与费用被 N 倍放大（匿名可达、无需任何凭据）。
 *
 * 两条同时成立才算解决：① 失败也要留下**短期**缓存，把重试频率压到有界；
 * ② 窗口必须远短于成功的 60 秒 —— 一次瞬时抖动不该让整分钟的访客都看到
 * 「已删除」。5 秒既挡住了洪泛，也让故障恢复后最多 5 秒就自动重探。
 */
const EXISTS_FAIL_TTL_MS = 5 * 1000;
const EXISTS_MAX = 2000;
const existsProbe = new Map(); // linkId -> {at, ttl, missing}

/** 节流表必须自己收敛（与 statusQueryAt 同样的纪律：有 TTL 就要有清扫 + 硬上限） */
function noteExistsProbe(id, missing, now, ttl) {
  const life = Number.isFinite(ttl) && ttl > 0 ? ttl : EXISTS_TTL_MS;
  existsProbe.set(id, { at: now, ttl: life, missing });
  if (existsProbe.size <= 64) return; // 小规模不扫全表
  for (const [k, v] of existsProbe) {
    if (now - v.at > (Number.isFinite(v.ttl) && v.ttl > 0 ? v.ttl : EXISTS_TTL_MS)) existsProbe.delete(k);
  }
  while (existsProbe.size > EXISTS_MAX) {
    const it = existsProbe.keys().next();
    if (it.done) break;
    existsProbe.delete(it.value);
  }
}

/** 取命中的探测结果；每条自带 TTL（成功 60 秒 / 失败 5 秒），过期或不存在都返回 null */
function existsHit(id, now) {
  const e = existsProbe.get(id);
  if (!e) return null;
  const life = Number.isFinite(e.ttl) && e.ttl > 0 ? e.ttl : EXISTS_TTL_MS;
  return now - e.at < life ? e : null;
}

/**
 * 惰性探测：链接指向的云端对象是否还在。
 *
 * 站内删除（`/fs/delete` 等）会**当场**把链接标成 missingAt，那条路径零额外调用；
 * 这里补的是**站外删除**（控制台、生命周期规则、别的工具）—— 否则分享页照样
 * 显示下载按钮，访客点了才被告知文件没了。
 *
 * 探测结果缓存 60 秒（`EXISTS_TTL_MS`），因此每个链接对云端的探测上限是 1 次/分钟。
 *
 * R8-06：**已标记 missing 的链接同样要探测**。旧实现第一行就是
 * `if (l.missingAt) return true`，于是下面 `else if (l.missingAt) clearMissing()`
 * 永远不可达 —— `deleted` 成了不可逆的假终态：把同名文件重新上传回同一个 key，
 * 分享页恒为 410、管理页恒显示「文件已删除」，而管理页那条「若把同名文件重新上传
 * 到同一位置，链接会自动恢复」的承诺与实现完全相反。已分发的 URL 只能删链接重建。
 *
 * R14-10：再加两层 ——
 *  ① **并发去重**：旧实现把结果写进缓存的动作在 `await` **之后**，于是同一链接的
 *     一批并发请求各自发起一次 `headObject`（缓存只在探测**完成之后**才生效）。
 *     现在整段探测包在 `singleFlight` 里，并发请求共享同一次云端往返；
 *  ② **失败留痕**：非 404 的异常（凭据失效 / 桶被删 / 网络不可达）此前被外层
 *     的 `catch (e) { /* 探测失败按「文件还在」继续 *\/ }` **完全吞掉、零日志**，
 *     真实的凭据/桶故障对运维不可见。现在补一条 `share.probe` warn 日志，
 *     并写一条 5 秒的失败缓存（见 {@link EXISTS_FAIL_TTL_MS}）。
 *
 * 「非 404 一律 fail-open」的取舍**保持不变**：只有明确的 404 才算文件没了，
 * 其余按现状维持可用（同一个链接被重新上传回来时才能自动恢复）。
 *
 * ## R51：只对**单一普通文件**的链接探测
 *
 * `headObject` 只能回答"这一个 key 在不在"。多文件 / 文件夹分享里：
 *
 *  · 文件夹链接的 `key` 是**前缀**（`dir/`），对前缀做 head 必然 404 ⇒
 *    若照旧探测，每一条文件夹分享上线后都会被判成「文件已被删除」，永久 410。
 *  · 多条目链接有最多 2000 个对象，逐个探测就是 2000 次云端往返（本端点还是
 *    匿名可达的），而"其中某一个被删了"也不足以判定整条分享失效。
 *
 * 因此 `listView` 的链接**不探测、不改判**：它们的 `missingAt` 只来自明确信号
 * （整个桶被删 → `markMissingByBucket`）。缺的那几个文件在**下载时**逐个 head
 * 时会被跳过并记日志（见 `/s/:id/dl` 的 `openFile`）。
 */
async function probeObjectMissing(l) {
  if (shareStore.view(l).listView) return Boolean(l.missingAt); // R51：见上方注释

  const hit = existsHit(l.id, Date.now());
  if (hit) return hit.missing;

  return singleFlight(`share-exists:${l.id}`, async () => {
    // 排队期间可能已有结果（去重窗口内到达的请求不必再探一次）
    const again = existsHit(l.id, Date.now());
    if (again) return again.missing;

    let cfg = null;
    try { cfg = configStore.effectiveForBucket(l.bucket, l.region); } catch (e) { cfg = null; }
    // 配置不可用（密钥被解绑 / 桶被删除）时**不探测、也不改判**：
    // 若在这里把 missing 当作 false 回传并走 clearMissing，一次临时故障就会把
    // 已确认缺失的链接误恢复成「有效」。fail-open 只适用于「不确定」，
    // 不适用于「连探都没探成」—— 后者按现状维持原判。
    if (!cfg || !cfg.secretId) return Boolean(l.missingAt);

    let missing = false;
    let failed = null;
    try {
      const s3 = getClient(cfg);
      await p(s3, 'headObject', { Bucket: l.bucket, Region: cfg.region || l.region, Key: l.key });
    } catch (e) {
      if (isNotFound(e)) missing = true;
      else failed = e; // 非 404：网络 / 鉴权 / 超时 —— 不改判，但必须留痕
    }
    noteExistsProbe(l.id, missing, Date.now(), failed ? EXISTS_FAIL_TTL_MS : EXISTS_TTL_MS);
    if (failed) {
      statsStore.addLog({
        action: 'share.probe', level: 'warn',
        detail: `分享链接存在性探测失败（链接 ${l.id}，桶 ${l.bucket}）：`
          + `${(failed && (failed.message || failed.code || failed.name)) || failed}`,
      });
    }
    if (missing) shareStore.markMissing(l.id);
    else if (l.missingAt) shareStore.clearMissing(l.id); // 对象被重新传回来了
    return missing;
  });
}

router.get('/s/:id', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  /**
   * R14-10①：本端点此前**没有任何限流器**（全文件的 limiter 调用点都不含它）。
   *
   * 它是分享页的唯一入口：渲染 + 一次惰性 `headObject` 存在性探测。匿名访客
   * 只要并发请求同一个 URL 就能把云端调用数与费用放大 N 倍，慢桶场景下还会
   * 各持一条连接最长挂满 SDK 的 120 秒超时（主站与 WebDAV 共用同一进程）。
   * 按 IP 限流（300 次/10 分钟），命中时给出与其他限流路径一致的 429 页面。
   */
  const viewRl = security.shareViewLimiter(security.clientIp(req));
  if (!viewRl.ok) {
    res.setHeader('Retry-After', String(viewRl.retryAfter));
    return statePage(res, 'limited', shareStore.view(l),
      `请求过于频繁，请 ${viewRl.retryAfter} 秒后重试。`);
  }
  let st = shareStore.status(l);
  // 只有「有效」与「已标记删除」两种状态需要探测：过期 / 次数用尽的链接
  // 本来就不提供下载，没必要为此多打一次云端；而标记过的要再探一次，
  // 因为对象可能被重新上传到同一个 key（那时应恢复为有效）。
  if (st === 'active' || st === 'deleted') {
    // 探测只是锦上添花，任何意外都不能把公开页面打挂（Express 4 不接 async 抛错）
    try {
      await probeObjectMissing(l);
      st = shareStore.status(l); // 探测可能已改写 missingAt
    } catch (e) { /* 探测失败按「文件还在」继续 */ }
  }
  if (st !== 'active') return statePage(res, st, shareStore.view(l));

  // 密码保护：校验 Cookie
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return passwordPage(res, l, req.query.e === '1');
  } else {
    // SEC-08：无密码链接也要下发访问票据。
    //
    // 下载端点是「有副作用的 GET」，`/s/*` 不经过 CSRF 校验。若从不下发票据，
    // 任何第三方页面的 `<img src="/s/ID/dl">` 都能静默消耗下载额度。
    // 下发后 `/s/:id/dl` 可要求"先访问过分享页"—— 而票据 Cookie 是
    // `SameSite=Lax`，**跨站子资源请求不会携带**，于是 img/prefetch 天然被挡。
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) {
      res.cookie(cookieName(l.id), shareStore.accessToken(l), shareCookieOptions(l.id));
    }
  }

  /* R21-01：密文对象 + 已设「加密访问密码」→ 与 `/api/fs/download` **同一道门禁**。
   *
   * 位置与分享密码同层、且**早于**付费与下载入口：本页会给出一条 `/s/:id/dl` 链接，
   * 如果先渲染下载按钮再在下载时拦，用户看到的仍是一个"能点"的按钮。 */
  if (encGateNeeded(l) && !encUnlocked(req)) return encUnlockPage(res, l, false);

  // ---- 付费下载（第四种限制）----
  const ps = paidStateFor(l);
  if (ps.effective) {
    const payer = payerStateFor(l, req);
    if (payer.state === 'paid') {
      const paidRows = [['付费下载', `<b>已支付 ¥${paymentRules.formatAmount(payer.order.amountFen)}</b>`]];
      if (payer.order.discountFen > 0) {
        paidRows.push(['优惠', `−¥${paymentRules.formatAmount(payer.order.discountFen)}`
          + (payer.order.couponCode ? `（优惠券 ${esc(payer.order.couponCode)}）` : '')]);
      }
      return infoPage(res, l, {
        // R51：分页页码来自 `?page=N`（列表页的翻页链接就带它）；
        // 非法值由 listPage 收敛到 1，单文件页忽略它。
        page: req.query.page,
        extraRows: paidRows,
        note: '支付已完成，可直接下载。',
        noteKind: 'ok',
        // R64：订单号是取回下载权限的唯一凭证 —— 已支付页必须给出完整号码
        order: payer.order,
        // R64：卡片下方的「查看历史订单 / 恢复购买」
        below: paidBelowHtml(l, res),
      });
    }
    if (payer.state === 'pending') return payingPage(res, l, payer.order);
    if (payer.state === 'failed') return payFailedPage(res, l, payer.order);
    // 已退款：票据仍然有效（能认出这个人），但不再放行下载 —— 复用付费页让他重新支付
    if (payer.state === 'refunded') {
      return payPage(res, l, ps, paySnapshot().available, '', refundNote(), couponStateFor(l, req));
    }
    const snap = paySnapshot();
    return payPage(res, l, ps, snap.available, '', '', couponStateFor(l, req));
  }

  // 配置了付费但当前不生效（支付停用 / 无可用渠道）：明确告知当前免费，配置仍在
  if (ps.required) {
    return infoPage(res, l, {
      page: req.query.page,
      note: paymentRules.REASON_TEXT[ps.reason] || '该文件当前可免费下载。',
    });
  }

  return infoPage(res, l, { page: req.query.page });
});

/* ------------------------------ R51：列表页 ------------------------------ */

/**
 * 每页最多展示多少个条目。
 *
 * 需求指定的 50。它同时决定了三种成本：① 单页 HTML 的体积（每行一枚内联图标，
 * 50 行约 30KB）；② 用户在一页里能一眼看完的量；③ 分页链接的页数
 * （快照上限 2000 ⇒ 最多 40 页）。
 */
const LIST_PAGE_SIZE = 50;

/**
 * R64：历史订单页每类最多渲染多少行。
 *
 * 这个页面**不做分页**（它不在需求里，而分页会再拉一套 `?page=` 语义与测试）：
 * 一个账号的已购订单通常个位数，免费下载记录也就几十条。上限的作用只是防止
 * 「有人用脚本刷免费下载记录」把页面撑成几 MB —— 超出部分不渲染，
 * 真实数据仍在 `download-log` 里（`MAX_RECORDS` 才是容量约束）。
 */
const HISTORY_MAX_ROWS = 100;

/** 列表页的一行（复选框 + 类型图标 + 相对路径 + 大小） */
function listRow(item, shown) {
  // 图标：目录走 fic-folder，文件按类型内联（见 file-icons.js）。
  // 传入的是**目录要带结尾斜杠**的原始 key —— 那是 iconIdFor 判定「这是目录」的依据。
  const icon = fileIcons.inlineSvg(item.key, { size: 20 })
    || '<span style="display:inline-block;width:16px;height:16px"></span>';
  const size = item.dir ? '' : fmtSize(item.size);
  /**
   * R52-05：**显示**的是抹掉「分享根之上」祖先的展示名（`shown`），而复选框的
   * `value` 仍是**完整对象 key** —— 后者是 `/s/:id/dl` 校验「你勾的是不是这条分享里
   * 的东西」的输入，绝不能跟着展示名一起变短（快照里存的就是完整的 key）。
   *
   * R52-04：**默认勾上**（需求：多条目分享页应默认选中全部）。
   *
   * 这里让服务端直接渲染 `checked`，而不是只靠脚本在加载后勾上：
   *  · 脚本不可用（CSP 之外的拦截、脚本被拦、老浏览器）时，本页仍是「默认全选」；
   *  · 脚本可用时它会用会话里存的选择覆盖这里的状态（用户清空后刷新不能又变回全选）。
   * 两处不冲突：渲染的是"初始状态"，脚本写的是"当前状态"。
   */
  return `<label class="sl-row" data-key="${esc(item.key)}">
        <input type="checkbox" name="k" value="${esc(item.key)}" checked>
        <span class="sl-ico">${icon}</span>
        <span class="sl-name${item.dir ? ' dir' : ''}">${esc(shown || item.key)}</span>
        <span class="sl-size">${esc(size)}</span>
      </label>`;
}

/**
 * 分页条。
 *
 * 只渲染「首 / 上一页 / 当前附近 / 下一页 / 末页」这一小段 —— 一个 40 页的分享
 * 若把 40 个页码全铺出来，在手机上会占掉半屏。
 *
 * ⚠️ 页码是**链接**而不是按钮，且只带 `?page=`：整页服务端渲染，无需 JS 即可翻页
 * （勾选状态由 `/js/share-list.js` 单独负责，脚本不可用时本页仍可用 ——
 * 只是勾选不能跨页）。
 */
function pagerHtml(l, page, pages) {
  if (pages <= 1) return '';
  const at = (n) => `/s/${encodeURIComponent(l.id)}?page=${n}`;
  const parts = [];
  const push = (n, label, cur) => {
    parts.push(cur ? `<span class="cur">${label}</span>` : `<a href="${at(n)}">${label}</a>`);
  };
  if (page > 1) parts.push(`<a href="${at(page - 1)}">上一页</a>`);
  const window = new Set([1, pages, page, page - 1, page + 1, page - 2, page + 2]);
  const nums = Array.from(window).filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  let prev = 0;
  for (const n of nums) {
    if (prev && n > prev + 1) parts.push('<span class="gap">…</span>');
    push(n, String(n), n === page);
    prev = n;
  }
  if (page < pages) parts.push(`<a href="${at(page + 1)}">下一页</a>`);
  return `<div class="sl-pager">${parts.join('')}</div>`;
}

/**
 * 列表页 —— 多文件 / 文件夹分享的呈现方式（R51）。
 *
 * 形态（需求原文：以列表形式显示全部文件和文件夹，可勾选要下载的文件，并分页显示）：
 *
 *  · **扁平平铺**：所有条目（顶层的文件夹行 + 其下的每一个文件）按
 *    「先文件夹、再文件，各自按路径排序」排成一列，每行显示**展示路径**——
 *    即从被分享的那一层开始算的相对路径（`photos/2024/` 的分享显示 `2024/a.jpg`，
 *    R52-05：`photos/` 这一层不该出现在别人拿到的链接里）。刻意不按层级折叠：
 *    层级折叠需要面包屑与「进入 / 返回」，而这既是需求没要求的交互，也会让
 *    「分页 50 个」的口径变得难以解释（每层的 50 个，还是全部的 50 个）。
 *  · **服务端分页**：`?page=N` 一次性只渲染 50 行。理由同上 —— 2000 行的 DOM
 *    对手机不友好，而服务端分页天然可后退、可分享、无需 JS。
 *  · **勾选是渐进增强**：无 JS 时复选框就是一个普通的 `<form method=GET>`，
 *    勾本页的、点「下载选中」即可（等价于选中当前页的子集）；
 *    有 JS 时 `/js/share-list.js` 把选择存进 sessionStorage，于是能跨页累计。
 *  · **勾选项必须能被服务端校验**：`/s/:id/dl` 只接受**快照里存在的 key**，
 *    否则 400（见 `parseSelection`）。清单来自创建时的快照，不信任客户端提交的路径。
 */
function listPage(res, l, v, opts = {}) {
  const ordered = v.items.slice().sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;   // 文件夹在前（与文件管理器一致）
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });
  const pages = Math.max(1, Math.ceil(ordered.length / LIST_PAGE_SIZE));
  const asked = Number(opts.page);
  const page = Math.min(pages, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 1));
  const slice = ordered.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  // R52-05：展示名按**整份快照**算一次（共同祖先跨全部条目），再逐行取用 ——
  // 只按本页 50 条算，会让同一份分享的不同页抹掉不同长度的前缀。
  const shown = shareStore.itemPaths(v.items);

  const fileCount = v.itemCount - v.dirCount;
  const remain = v.maxDownloads > 0 ? `剩余 ${Math.max(0, v.maxDownloads - v.downloads)} 次` : '不限次数';
  const extra = (opts.extraRows || []).map((r) => `<div><span>${esc(r[0])}</span><b>${r[1]}</b></div>`).join('');
  const note = opts.note ? `<div class="${opts.noteKind === 'ok' ? 'ok' : 'warn'}">${esc(opts.note)}</div>` : '';
  const summary = v.itemCount === 1
    ? '1 个文件夹'
    : `共 ${v.itemCount} 项（${v.dirCount} 个文件夹 / ${fileCount} 个文件），合计 ${fmtSize(v.totalSize)}`;

  /**
   * 有可下载的文件才给下载入口。空文件夹、或快照里一个文件都没有时，
   * 给一个「打包下载全部」按钮只会让用户点出一个空归档 —— 那是最糟的反馈。
   */
  const actions = fileCount === 0
    ? '<p class="sl-tip">该分享里没有可下载的文件。</p>'
    : `<div class="row2">
        <button class="btn primary" type="submit" id="sl-download">下载选中</button>
        <a class="btn ghost" href="/s/${esc(l.id)}/dl" style="text-align:center;text-decoration:none">打包下载全部</a>
      </div>
      <p class="sl-tip">默认已全选；取消掉不想下的再点「下载选中」：只勾一个文件时按原名直接下载，勾多个或勾了文件夹则打包成 <b>.tar.gz</b> 一次下载。</p>`;

  /**
   * R52-04：把**整份快照的 key 清单**交给勾选脚本（`application/json`，不执行，
   * 因此不受 CSP 的 `script-src` 约束）。
   *
   * 为什么必须给全量而不是"本页 50 个"：默认全选是**跨页**的语义 —— 一个 120 项的
   * 分享在第 1 页点「下载选中」，应当拿到 120 项而不是 50 项；而脚本要算出「其它页
   * 还有哪些被选中/被取消」，就得知道全部 key。
   *
   * 代价与取舍：这份 JSON 会随每个分页请求下发（2000 项、键长约 30 字符时约 60KB，
   * 压缩后十几 KB）。它只是**一个文本节点**，不建 DOM —— 分页要解决的"2000 行 DOM
   * 拖垮手机"这个理由（见 LIST_PAGE_SIZE）不受影响；而它换来的是"默认全选"这件事
   * 在服务端分页的前提下仍然成立。链接持有者本来就能逐页看到全部条目，故不构成新增泄露。
   */
  const keysJson = `<script type="application/json" id="sl-keys">${
    JSON.stringify(v.items.map((it) => it.key)).replace(/</g, '\\u003c')
  }</script>`;

  renderPage(res, 200, {
    wide: true,
    title: v.fileName,
    head: `<div class="center-head">
      <h1 style="word-break:break-all">${esc(v.fileName)}</h1>
      <p class="sub">${esc(summary)}</p>
      </div>`,
    body: `
      ${note}
      <div class="meta">
        ${v.expiresAt ? `<div><span>有效期至</span><b>${fmtDate(v.expiresAt)}</b></div>` : '<div><span>有效期</span><b>永久有效</b></div>'}
        <div><span>允许被下载的次数</span><b>${remain}</b></div>
        ${v.hasPassword ? '<div><span>密码保护</span><b>已启用</b></div>' : ''}
        ${extra}
      </div>
      <form method="GET" action="/s/${esc(l.id)}/dl" id="sl-form">
        <div class="sl-bar">
          <button class="btn ghost" type="button" id="sl-all">全选本页</button>
          <button class="btn ghost" type="button" id="sl-none">清空选择</button>
          <span class="sl-count" id="sl-count">第 ${page} / ${pages} 页</span>
        </div>
        <div class="sl-list">${slice.map((it) => listRow(it, shown.get(it.key))).join('') || '<div class="sl-empty">本页没有内容</div>'}</div>
        ${pagerHtml(l, page, pages)}
        ${actions}
      </form>
      ${opts.order ? orderNoBox(opts.order.orderNo || opts.order.id) : ''}
      ${keysJson}
      <script src="/js/share-list.js" data-link-id="${esc(l.id)}" defer></script>
      ${opts.order ? orderNoScript() : ''}`,
    below: opts.below,
  });
}

/* ------------------------------ 支付 ------------------------------ */
/**
 * 站点对外地址 —— 支付网关回调（notify_url）与支付完成回跳（return_url）的目标。
 *
 * 优先取管理员在支付设置里填的「站点对外地址」（配置值也必须属本站，R17-03）。
 * **未配置时不再信任任意请求 `Host`**（R24-01）：改为按「请求 Host 属本站 → 配置的
 * 主 / 备域名 → 本机 `HOST`（非通配）」的**可信**阶梯取值，全部落空则返回空串，
 * 由调用方拒绝下单并提示去配置站点地址。
 * 本机 `127.0.0.1` 收不到公网回调，因此生产环境**必须**显式配置，
 * 否则支付网关无法通知我们（页面轮询仍可用，但关掉浏览器的支付就会挂起）。
 */
function siteUrlFor(req) {
  let base = '';
  try { base = String((configStore.getPayment().siteUrl || '')).trim(); } catch (e) { base = ''; }
  // R17-03：`PUT /payment/site-url` 已校验「必须属本站」，但配置可能是旧版本写入、
  // 或管理员直接改写了配置文件。这里再兜一次：地址不属本站时退回可信来源。
  if (base && !security.isOwnSiteHost(base, [])) base = '';
  if (base) return base.replace(/\/+$/, '');

  const proto = security.requestIsSecure(req) ? 'https' : 'http'; // R27-03：唯一判据
  const host = String(req.headers.host || '');
  /**
   * R24-01：**兜底路径不得信任任意请求 Host**。
   *
   * 旧实现在未配置站点地址时直接 `base = proto + '://' + req.headers.host`，于是
   * 任意持有付费链接的人都能用自定义 `Host` 让 `notify_url` / `return_url` 指向
   * 自己的域 —— 支付宝的**异步通知**（带签名与订单信息）会被引到攻击者那里。
   *
   * 判据顺序与 HTTPS 跳转（`httpsRedirectHost`）**刻意不同**：那里优先本机 `HOST`
   * （为了在本机也能跳转），而回调地址必须优先**配置的站点域名**（公网可达），
   * 本机 `HOST` 只作本地自测的兜底。
   *
   * 阶梯（每一级都是**请求方无法左右**的可信来源）：
   *   ① 请求 Host 属本站（域名直连 / 本机访问）→ 用它；
   *   ② 配置的主 / 备站点域名 → 用它；
   *   ③ 本机 `HOST`（非通配绑定）→ 用它（本地自测；公网回调本就不可达）；
   *   ④ 都没有 → 返回空串，由调用方**拒绝下单**并提示去配置站点地址。
   */
  if (host && security.isOwnSiteHost(host, [])) return (proto + '://' + host).replace(/\/+$/, '');
  const dom = security.configuredSiteHost();
  if (dom) return (proto + '://' + dom).replace(/\/+$/, '');
  const local = security.DEPLOY_HOST;
  if (local && !security.isBindAllHost(local)) {
    // R24-01：本机 `HOST` 只有主机名，本地自测（http）必须补回监听端口，
    // 否则回调地址会缺 `:3000` 而不可达。https 时（部署模式经反代）对外端口由反代
    // 决定、与应用监听端口无关，因此不加。
    const p = proto === 'http' ? (Number(process.env.PORT) || 3000) : 0;
    return (proto + '://' + local + (p ? ':' + p : '')).replace(/\/+$/, '');
  }
  return '';
}

/** 订单标题（各网关对长度有要求，统一截断） */
function chargeSubject(l) {
  return `付费下载：${l.fileName || '文件'}`.slice(0, 100);
}

/** 发起支付：创建 pending 订单 → 调网关下单 → 跳转收银台或展示二维码 */
/**
 * R62：应用 / 更换 / 取消优惠券。
 *
 * 为什么单独一条路由、而不是把券码直接塞进 `POST /s/:id/pay`：
 *  · 需求 5 要求「使用优惠券后**页面上的价格**变成原价划线 + 优惠价」——
 *    这必须是一次**重新渲染**（服务端渲染的页面），而不是等到付款时才生效；
 *  · 券可能因为「刚被用尽 / 刚过期 / 不适用于本链接」而失效，用户需要**当场**
 *    看到原因（需求 6），而不是点了「立即支付」才被退回。
 *
 * 券码只写进 Cookie、不进 URL：它是可抵扣金额的凭据，GET 会把 URL 写进
 * 浏览器历史与反向代理日志（与 `POST /invites/export` 同一条理由）。
 */
router.post('/s/:id/coupon', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id);
  }
  const ps = paidStateFor(l);
  if (!ps.effective) return res.redirect(303, '/s/' + l.id); // 已转免费，券无意义

  const ip = security.clientIp(req);
  const rl = security.couponLimiter(`${ip}:${l.id}`);
  if (!rl.ok) {
    return payPage(res, l, ps, paySnapshot().available,
      `尝试次数过多，请 ${rl.retryAfter} 秒后重试`, '',
      { code: String((req.body && req.body.code) || ''), ok: false, message: '尝试次数过多，请稍后再试' });
  }

  const raw = String((req.body && req.body.code) || '').trim();
  const clear = String((req.body && req.body.clear) || '') === '1' || !raw;
  if (clear) {
    res.clearCookie(couponCookieName(l.id), { path: '/' });
    return res.redirect(303, '/s/' + l.id);
  }

  const who = visitorIdentity(req);
  const r = couponStore.validateForUse({
    code: raw, link: l, identity: who.identity, userId: who.userId,
  });
  if (!r.ok) {
    /**
     * 无效券**不写进 Cookie**，并顺手清掉旧值：否则用户换了一张坏券之后，
     * 页面会一边显示「新券无效」一边按**旧券**算钱 —— 两种事实同时出现在一屏。
     */
    res.clearCookie(couponCookieName(l.id), { path: '/' });
    return payPage(res, l, ps, paySnapshot().available, '', '',
      { code: raw, ok: false, message: r.message });
  }

  res.cookie(couponCookieName(l.id), r.coupon.code, shareCookieOptions(l.id));
  // 日志只记券 id 与优惠额，**不记券码本身**（与邀请码同：审计日志是明文 JSONL）
  statsStore.addLog({
    action: 'share.coupon', detail: `分享链接 ${l.id} 应用优惠券 ${r.coupon.id}`
      + `（优惠 ¥${paymentRules.formatAmount(r.discountFen)}，应付 ¥${paymentRules.formatAmount(r.payableFen)}，IP：${ip}）`,
  });
  return res.redirect(303, '/s/' + l.id);
}));

router.post('/s/:id/pay', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id);
  }

  const ps = paidStateFor(l);
  if (!ps.effective) return res.redirect(303, '/s/' + l.id); // 已转免费，无需支付

  // 限流：同一 IP 对同一链接的支付发起（防止刷订单）
  const ip = security.clientIp(req);
  const rl = security.shareLimiter(`${ip}:${l.id}`);
  if (!rl.ok) return payPage(res, l, ps, paySnapshot().available, `操作过于频繁，请 ${rl.retryAfter} 秒后重试`, '', couponStateFor(l, req));

  const platform = String((req.body && req.body.platform) || '');
  const available = paySnapshot().available;
  if (!available.includes(platform)) {
    return payPage(res, l, ps, available, '请选择一个可用的支付方式', '', couponStateFor(l, req));
  }

  // R14-05：动单之前先问「这个人现在是什么支付态」—— 与 `GET /s/:id`（:571）和
  // `/s/:id/dl`（:1052）同源。此前唯独发起支付不查，属「同一状态多个入口」的漏网：
  //   ① 已付用户再点一次付费 → 新 pending 的票据**覆盖**已付票据，支付态由 paid 退回
  //      pending；而 paid 订单永不裁，于是管理页显示「已支付」、用户手上却没有任何
  //      可用凭证 —— 状态与凭证永久脱节，只能人工介入；
  //   ② 每次点击都新建订单，是 R14-03「灌单挤出在途订单」的直接推手。
  const payer = payerStateFor(l, req);
  if (payer.state === 'paid') {
    // 已付即放行：不再建单，也不动票据
    return res.redirect(303, '/s/' + l.id);
  }

  let order;
  /**
   * R62：券只作用于**新建订单**。复用在途订单时不能改价 —— 那笔订单已经按原金额
   * 在网关侧下过单（商户单号就是 order.id），改价会让「订单金额」与「网关收款额」分叉。
   */
  let applied = null;
  if (payer.state === 'pending' && payer.order) {
    // 复用在途订单。网关侧商户单号就是 order.id（payment-gateway 用 out_trade_no: order.id），
    // 因此重复下单是幂等的，不会在网关侧产生第二笔。
    order = payer.order;
  } else {
    /**
     * R62：券在**下单这一刻**再校验一次，而不是直接信任页面上的结果 ——
     * 页面可能停留很久（券在此期间被别人用完 / 过期），Cookie 也可能被伪造。
     * 表单里的 hidden `coupon` 优先于 Cookie：它来自本页渲染时的那张券，更接近用户意图。
     */
    const code = String((req.body && req.body.coupon) || '').trim()
      || getCookie(req, couponCookieName(l.id));
    if (code) {
      const who = visitorIdentity(req);
      const r = couponStore.validateForUse({
        code, link: l, identity: who.identity, userId: who.userId,
      });
      if (!r.ok) {
        res.clearCookie(couponCookieName(l.id), { path: '/' });
        return payPage(res, l, ps, available, '', '', { code, ok: false, message: r.message });
      }
      applied = r;
    }
    const amountFen = applied ? applied.payableFen : ps.amountFen;
    // 文件名 / 对象键 / 存储桶一并快照进订单：链接删除后订单管理页仍要能回答
    // "付的什么、来自哪个桶"（R48 的「收入统计」按桶与文件归集）
    const buyer = shareUser(req); // R64：已登录才有账号可归集；游客为空
    order = paymentOrders.create({
      linkId: l.id, platform, amountFen,
      // R64：下单人身份 —— 「查看历史订单」按 userId 归集，userName 只是快照
      userId: buyer ? buyer.id : '',
      userName: buyer ? buyer.username : '',
      // R62：原价 / 优惠 / 券信息一并快照 —— 券被删掉或改配置后，历史订单仍要
      // 能回答「这笔原价多少、优惠了多少、用的是哪张券」。
      originalFen: ps.amountFen,
      discountFen: applied ? applied.discountFen : 0,
      couponCode: applied ? applied.coupon.code : '',
      couponId: applied ? applied.coupon.id : '',
      couponType: applied ? applied.coupon.type : '',
      currency: ps.currency, payerIp: ip,
      fileName: l.fileName, fileKey: l.key, bucket: l.bucket,
    });
    /**
     * 核销与建单在**同一个同步片段**里（中间没有 await）⇒ 不存在「券在这两步之间
     * 被别人用掉」的窗口。按 orderId 幂等，重复调用不会重复计数。
     */
    if (applied) {
      couponStore.consume({
        couponId: applied.coupon.id,
        identity: visitorIdentity(req).identity,
        orderId: order.id,
      });
    }
    res.cookie(payCookieName(l.id), paymentOrders.orderToken(order), shareCookieOptions(l.id));
    statsStore.addLog({
      action: 'share.pay',
      detail: `分享链接 ${l.id} 创建支付订单 ${order.id}（${platform}，¥${paymentRules.formatAmount(order.amountFen)}`
        + `${applied ? `，原价 ¥${paymentRules.formatAmount(order.originalFen)}，优惠券 ${order.couponId}` : ''}，IP：${ip}）`,
    });
  }

  // 在途订单沿用其**原始**支付渠道：换渠道属于新单（走上面的 else 分支），
  // 否则商户单号对应的网关与本次请求的渠道会对不上。
  const chargePlatform = order.platform;
  if (!available.includes(chargePlatform)) {
    return payPage(res, l, ps, available, '原支付方式已停用，请重新发起支付', '', couponStateFor(l, req));
  }

  const cfg = (configStore.getPayment().platforms || {})[chargePlatform] || {};
  const base = siteUrlFor(req);
  /**
   * R24-01：拿不到**可信**的对外地址时拒绝下单 —— 既不能用任意 Host 拼回调地址
   * （回调劫持），也不该拿一个网关不可达的地址去下单（用户付了钱却收不到通知，
   * 只能靠页面轮询推进）。这里如实标记失败并给出可执行的出路。
   */
  if (!base) {
    paymentOrders.markFailed(order.id, '站点对外地址未配置且当前访问地址不可信');
    releaseCouponForOrder(order); // R62：没成交就不该消耗一次券
    statsStore.addLog({
      action: 'share.pay', level: 'warn',
      detail: `分享链接 ${l.id} 订单 ${order.id} 拒绝下单：站点对外地址未配置、且请求 Host 不属本站（R24-01）`,
    });
    return payPage(res, l, ps, available,
      '无法确定本站对外地址：请管理员在「系统设置 → 支付设置」中填写站点对外地址后再试', '', couponStateFor(l, req));
  }
  const charge = await paymentGateway.createCharge(chargePlatform, cfg, {
    order,
    subject: chargeSubject(l),
    returnUrl: `${base}/s/${encodeURIComponent(l.id)}/pay/return`,
    // R21-06：回调地址必须与**实际下单渠道**同源。旧实现取的是请求体里的 `platform`，
    // 而命中「复用在途 pending 订单」分支时下单走的是 `order.platform` —— 客户端提交
    // 另一条渠道（两者都能通过 available 校验）就会「下单走 A、回调地址写 B」，真实
    // 异步通知被 B 的验签拒绝而丢弃，只能靠页面轮询推进（关掉浏览器支付即挂起）。
    notifyUrl: `${base}/pay/notify/${encodeURIComponent(chargePlatform)}`,
    cancelUrl: `${base}/s/${encodeURIComponent(l.id)}`,
  });

  if (!charge.ok) {
    paymentOrders.markFailed(order.id, charge.error || '下单失败');
    releaseCouponForOrder(order); // R62：没成交就不该消耗一次券
    statsStore.addLog({
      action: 'share.pay', level: 'error',
      detail: `分享链接 ${l.id} 订单 ${order.id} 下单失败（${chargePlatform}）：${charge.error || '未知原因'}`,
    });
    return payPage(res, l, ps, available, `创建支付订单失败：${charge.error || '未知原因'}`, '', couponStateFor(l, req));
  }
  if (charge.tradeNo) paymentOrders.setTradeNo(order.id, charge.tradeNo);

  if (charge.kind === 'qrcode') return qrPayPage(res, l, order, charge);
  if (charge.kind === 'redirect' && charge.url) return res.redirect(302, charge.url);
  return payingPage(res, l, order);
}));

/**
 * 向网关查单并落地订单状态 —— **支付结果判定的唯一入口**。
 *
 * 无论是异步通知、支付完成回跳、还是页面轮询，最终都汇到这里。
 * 判定依据是网关返回的真实状态，不是任何来自客户端的说法。
 */
async function finalizeOrder(l, order) {
  // 退款同样是终态：网关查单仍会回答"已支付"，放行就等于把钱退了还能下载
  if (!order || order.status === 'paid' || order.status === 'refunded') return order;
  const cfg = (configStore.getPayment().platforms || {})[order.platform] || {};
  const r = await paymentGateway.queryCharge(order.platform, cfg, order);
  if (r.tradeNo) paymentOrders.setTradeNo(order.id, r.tradeNo);
  if (r.paid) {
    paymentOrders.markPaid(order.id);
    statsStore.addLog({
      action: 'share.pay',
      detail: `分享链接 ${l.id} 订单 ${order.id} 支付成功（${order.platform}，¥${paymentRules.formatAmount(order.amountFen)}${r.tradeNo ? '，网关单号 ' + r.tradeNo : ''}）`,
    });
  } else if (r.state === 'failed') {
    paymentOrders.markFailed(order.id, r.failReason || '支付失败或被取消');
    statsStore.addLog({
      action: 'share.pay', level: 'warn',
      detail: `分享链接 ${l.id} 订单 ${order.id} 支付失败（${order.platform}）：${r.failReason || '未知原因'}`,
    });
  }
  return paymentOrders.get(order.id);
}

/**
 * 带上「同一订单最快 3 秒查一次」节流的查单（`/pay/status` 原本就有的机制）。
 *
 * R8-20：`/pay/check`（「我已完成支付」按钮）与 `/pay/return`（网关回跳）
 * 原本**没有任何节流**，而 `finalizeOrder` 对 `pending`/`failed` 订单每次都真的
 * 去打网关。持票据者只要循环重放这两个端点，就能拿商户凭据把网关的查单配额
 * 刷光（PayPal 一次 = 取 token + 查订单两步），进而把真实支付的确认挤掉。
 * 这与 `/pay/notify` 处已写明的推理是同一件事 —— 那里补了限流，这里漏了。
 *
 * @returns {Promise<boolean>} 本轮是否真的发起了查单（节流命中则为 false）
 */
async function finalizeOrderThrottled(l, order) {
  if (!statusQueryDue(order)) return false;
  noteStatusQuery(order.id);
  await finalizeOrder(l, order);
  return true;
}

/**
 * R10-09：本轮**是否真的会**向网关发起查单（订单级节流未命中）。
 *
 * 抽出来是为了让调用方能先问一次再决定要不要消耗「按 IP 的查单预算」——
 * 被订单级节流拦下的轮询一次网关请求都不会发出，不该计入预算。
 */
function statusQueryDue(order) {
  return Date.now() - (statusQueryAt.get(order.id) || 0) >= STATUS_QUERY_MIN_GAP_MS;
}

/**
 * 手动查单类端点的统一前置守卫：按 IP 限流（R8-20）。
 * @returns {boolean} true = 已限流并回答，调用方应立即 return
 */
function payCheckRateLimited(req, res, l) {
  const ip = security.clientIp(req);
  const rl = security.payCheckLimiter(ip);
  if (rl.ok) return false;
  res.setHeader('Retry-After', String(rl.retryAfter));
  statsStore.addLog({
    action: 'share.pay', level: 'warn',
    detail: `手动查单被限流（链接 ${l ? l.id : '-'}，IP：${ip}）`,
  });
  statePage(res, 'limited', l ? shareStore.view(l) : null,
    `查询过于频繁，请 ${rl.retryAfter} 秒后重试。`);
  return true;
}

/** 支付完成后的回跳（支付宝 return_url / PayPal return_url） */
router.get('/s/:id/pay/return', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.redirect(303, '/s/' + l.id);
  if (payCheckRateLimited(req, res, l)) return undefined; // R8-20
  await finalizeOrderThrottled(l, order);
  return res.redirect(303, '/s/' + l.id);
}));

/** 手动触发一次查单（「我已完成支付」按钮） */
router.post('/s/:id/pay/check', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.redirect(303, '/s/' + l.id);
  if (payCheckRateLimited(req, res, l)) return undefined; // R8-20
  await finalizeOrderThrottled(l, order);
  return res.redirect(303, '/s/' + l.id);
}));

/**
 * 轮询支付状态（供支付中 / 二维码页面使用）。
 *
 * 微信 Native 没有回跳，只能靠这里推进：每次被轮询时主动向网关查单。
 * 为避免被刷成网关压力，同一订单最快 3 秒查一次网关（页面轮询间隔同为 3 秒）。
 */
router.get('/s/:id/pay/status', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return res.status(404).json({ error: '链接不存在' });
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.json({ state: 'none', paid: false });

  if (order.status === 'pending' && order.platform === 'wechat') {
    // R8-20：节流逻辑与 /pay/check、/pay/return 收敛到同一处（原先三处各写一份，
    // 结果只有这里带了节流）。节流命中时静默返回当前状态，页面下一轮再问。
    //
    // R9-05：上述节流的键是**订单**（3 秒一次），没有按 IP 的总量上限 ——
    // 持票据者可造多个订单再逐个轮询，把网关查单预算放大到约 66 倍。这里补一道
    // **按 IP 的查单预算**（见 security.payStatusLimiter）：超限时
    // 同样静默返回当前状态，既不打断正常轮询的 UX，也把多订单并行的放大倍数压住。
    //
    // R10-09：只有「本轮真的会查单」才消耗该预算。旧写法无条件按压限流器，
    // 于是被订单级节流拦下的轮询（一次网关请求都没发）也照样扣 —— 页面每 3 秒
    // 轮询一次时，200 次预算恰好在 10 分钟窗口内被"什么都没做的轮询"用光
    // （零余量），多人共用出口 IP 时更早触发，之后页面再也无法主动推进状态。
    // 预算的语义是"网关查单次数"，就该只在真的要查单时扣。
    const ip = security.clientIp(req);
    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {
      await finalizeOrderThrottled(l, order);
    }
  }
  const o = paymentOrders.get(order.id) || order;
  res.json({ state: o.status, paid: o.status === 'paid' });
}));

/**
 * 网关异步通知（仅作**触发信号**，不采信其内容判定结果）。
 *
 * 放在 `/pay/*` 而不是 `/api/*`：后者对非安全方法强制同源头与登录态，
 * 网关回调两样都没有，放过去必然 403。
 */
router.post('/pay/notify/:platform', asyncHandler(async (req, res) => {
  const platform = String(req.params.platform || '');
  if (!paymentProviders.isKnown(platform)) return res.status(404).end();

  // 各网关的响应要求不同：支付宝要看到 success 字样，微信与 PayPal 只要 2xx
  const done = () => (platform === 'alipay' ? res.type('text/plain').send('success') : res.status(200).json({ code: 'SUCCESS' }));

  // SEC-03 ①：限流必须**先于**任何凭据使用。通知会触发带真实商户密钥的网关查单，
  // 匿名可达的端点若不限流，等于把商户查单配额暴露给任何人。
  const ip = security.clientIp(req);
  const rl = security.payNotifyLimiter(ip);
  if (!rl.ok) {
    statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `支付回调被限流（平台：${platform}，IP：${ip}）` });
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).end();
  }

  // SEC-03 ②：验签。通知只被当作"该去查一次单"的信号，伪造通知**本身**造不出
  // 已支付状态（判定仍来自服务端主动查单）；但它能白嫖商户的查单配额并污染日志，
  // 所以能验的平台一律验，验不过直接丢掉。
  const sig = verifyNotified(platform, req);
  if (!sig.ok) {
    statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `支付回调验签未通过已丢弃（平台：${platform}，IP：${ip}，原因：${sig.reason}）` });
    return res.status(403).end();
  }

  const order = await resolveNotifiedOrder(platform, req);
  if (order) {
    const l = shareStore.get(order.linkId);
    if (l) await finalizeOrder(l, order);
  }
  return done();
}));

/**
 * 异步通知的真实性校验（SEC-03）
 *
 * 各平台能力不同，逐一看待：
 *  - 支付宝：RSA2 / RSA 验签（公钥本地校验，离线可完成）—— 验不过即拒绝；
 *  - 微信：通知体是 APIv3 密钥下的 AES-256-GCM 密文，**解不出来就说明对方没有
 *    密钥**，解密成功本身即是认证（GCM 带认证标签）。因此这里要求 apiV3Key 已配置，
 *    解密失败由 resolveNotifiedOrder 一并判定；
 *  - PayPal：官方仅提供「回调验签 API」，本地无法离线验签（需一次网络往返）。
 *    这里不做伪验签（那只会给出虚假的安全感），交由上面的限流兜底。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyNotified(platform, req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const cfg = (configStore.getPayment().platforms || {})[platform] || {};
  if (platform === 'alipay') {
    if (!cfg.alipayPublicKey) return { ok: false, reason: '未配置支付宝公钥' };
    if (!b.sign) return { ok: false, reason: '通知缺少签名字段' };
    if (paymentGateway.alipayVerify(b, cfg.alipayPublicKey, cfg.signType || b.sign_type)) return { ok: true };
    return { ok: false, reason: '签名校验失败' };
  }
  if (platform === 'wechat') {
    if (!cfg.apiV3Key) return { ok: false, reason: '未配置 APIv3 密钥' };
    if (!b.resource || !b.resource.ciphertext) return { ok: false, reason: '通知缺少加密资源' };
    return { ok: true };
  }
  return { ok: true }; // PayPal：本地不可验签，依赖限流
}

/**
 * 从异步通知里定位订单。
 *  - 支付宝：表单字段 out_trade_no
 *  - PayPal：JSON 的 resource.id（即创建订单时拿到的网关订单号）
 *  - 微信：resource 经 APIv3 密钥解密后取 out_trade_no
 * 定位不到就直接返回 null —— 通知只是提醒，查不到订单不做任何状态变更。
 */
async function resolveNotifiedOrder(platform, req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (platform === 'alipay') {
    const no = String(b.out_trade_no || '');
    return no ? paymentOrders.get(no) : null;
  }
  if (platform === 'paypal') {
    const id = String((b.resource && b.resource.id) || b.id || '');
    return id ? paymentOrders.findByTradeNo(id) : null;
  }
  if (platform === 'wechat') {
    const resource = b.resource;
    if (!resource || !resource.ciphertext) return null;
    const cfg = (configStore.getPayment().platforms || {}).wechat || {};
    let plain = '';
    try {
      plain = paymentGateway.wechatDecryptResource(cfg.apiV3Key, resource);
    } catch (e) {
      statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `微信支付通知解密失败：${e.message}` });
      return null;
    }
    try {
      const obj = JSON.parse(plain);
      return obj.out_trade_no ? paymentOrders.get(obj.out_trade_no) : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** 密码输入页；wrong 为提示文案（true 用默认文案，字符串为自定义文案，如限流/冻结提示） */
function passwordPage(res, l, wrong, customMsg) {
  const msg = typeof customMsg === 'string' && customMsg
    ? esc(customMsg)
    : (wrong ? '密码不正确，请重试。' : '');
  renderPage(res, wrong ? 401 : 200, {
    title: '密码保护',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#fdf6ec;color:#b45309;font-size:20px">🔒</div>
      <h1>此链接受密码保护</h1>
      <p class="sub">请输入分享者提供的访问密码。</p>
      </div>`,
    body: `
      <form method="POST" action="/s/${esc(l.id)}" style="margin-top:16px">
        ${msg ? `<div class="warn">${msg}</div>` : ''}
        <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="off" required>
        <button class="btn primary" type="submit">验证并查看文件</button>
      </form>`,
  });
}

/**
 * R21-01：加密访问密码输入页。
 *
 * 与 `passwordPage`（分享链接自身密码）刻意分成两个页面、两条表单：两者是**独立**
 * 的访问控制（一个是分享者设的链接密码，一个是管理员设的全站加密访问密码），
 * 混在一张表单里会让人以为「输一次就够了」。
 */
function encUnlockPage(res, l, wrong, customMsg) {
  const msg = typeof customMsg === 'string' && customMsg
    ? esc(customMsg)
    : (wrong ? '密码不正确，请重试。' : '');
  renderPage(res, wrong ? 401 : 200, {
    title: '加密文件访问验证',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">🔐</div>
      <h1>该文件已加密存储</h1>
      <p class="sub">请输入系统设置的「加密访问密码」，验证通过后才能下载明文。</p>
      </div>`,
    body: `
      <form method="POST" action="/s/${esc(l.id)}/unlock" style="margin-top:16px">
        ${msg ? `<div class="warn">${msg}</div>` : ''}
        <input type="password" name="password" placeholder="加密访问密码" autofocus autocomplete="off" required>
        <button class="btn primary" type="submit">验证并继续下载</button>
      </form>`,
  });
}

/** 分享密码 Cookie 的统一选项（SEC-10：部署模式下必须带 Secure，与主会话一致） */
function shareCookieOptions(id) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!security.IS_DEPLOY, // 部署模式（非回环）下强制仅经 HTTPS 传输
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  };
}

/**
 * R21-01：分享侧的「加密访问密码」验证 → 签发分享作用域的加密令牌。
 *
 * 校验与限流复用管理端 `POST /api/enc/unlock` 的**同一批实现**
 * （`encStore.checkPassword` 异步 scrypt + `security.encUnlockLimiter` /
 * `encUnlockLock` 的 IP 级限流与指数退避冻结），差别只在令牌的**携带方式**：
 * 分享页是服务端渲染的普通导航，挂不了自定义请求头，故走 `path: '/s/'` 的
 * HttpOnly Cookie。
 */
router.post('/s/:id/unlock', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  /**
   * R27-23：**分享密码必须先通过**，才能进入「加密访问密码」的验证。
   *
   * 兄弟路由全都做了这一步（`GET /s/:id`、`POST /s/:id/pay`、`GET /s/:id/dl` 都校验
   * `shareStore.verifyToken`），唯独这里漏了。而本端点成功时签发的是
   * `encStore.issueToken()` —— 一枚**与链接、对象无关**的全局令牌（只绑过期时间与
   * 系统级「加密访问密码」的哈希），它同时被分享下载门禁与管理端 `/fs/download` 接受。
   * 于是一个「既设了分享密码、又是密文对象」的链接，会给不知道分享密码的匿名访客
   * 提供一个**不限速**的系统级密码猜测接口（只有 10 次/分/IP + IP 冻结），
   * 猜中后拿到的令牌还能作用于其它密文对象。这不是直接的下载绕过（下载仍受分享密码拦），
   * 但把「两把锁」降级成了一把。
   */
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id); // 与其它入口同款：先回分享页（那里有密码表单）
  }
  if (!encGateNeeded(l)) return res.redirect(303, '/s/' + l.id); // 无需验证（未设密码 / 明文对象）

  const ip = security.clientIp(req);
  const rl = security.encUnlockLimiter(ip);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return encUnlockPage(res, l, true, `尝试过于频繁，请 ${rl.retryAfter} 秒后重试`);
  }
  const lockedLeft = security.encUnlockLock.locked(ip);
  if (lockedLeft > 0) return encUnlockPage(res, l, true, `失败次数过多，请 ${lockedLeft} 秒后重试`);

  const pw = String((req.body && req.body.password) || '');
  if (!(await encStore.checkPassword(pw))) {
    const left = security.encUnlockLock.fail(ip);
    statsStore.addLog({ action: 'enc.unlock', level: 'warn', detail: `分享页加密访问密码验证失败（链接 ${l.id}，IP：${ip}）` });
    if (left > 0) return encUnlockPage(res, l, true, `失败次数过多，请 ${left} 秒后重试`);
    return encUnlockPage(res, l, true);
  }
  security.encUnlockLock.reset(ip);
  const t = encStore.issueToken();
  res.cookie(ENC_COOKIE, t.token, encCookieOptions());
  statsStore.addLog({ action: 'enc.unlock', detail: `分享页加密访问密码验证通过（链接 ${l.id}，IP：${ip}，签发 30 分钟令牌）` });
  return res.redirect(303, '/s/' + l.id);
}));

router.post('/s/:id', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (!l.passwordHash) return res.redirect(303, '/s/' + l.id);

  // 限流（按 IP + 链接）+ 连续失败冻结，防匿名暴力破解（S2）
  //
  // FUN-04：冻结键必须是 **IP + 链接**，与限流器同维度。
  // 曾经只以 linkId 为键 —— 链接 ID 本身就在传播，任何拿到链接的人连错 5 次
  // 就能让该链接对**所有**合法访问者冻结 30 分钟，换 IP 还能持续触发，
  // 等于一条随手可用的针对性 DoS。
  const ip = security.clientIp(req);
  const scope = `${ip}:${l.id}`;
  const rl = security.shareLimiter(scope);
  if (!rl.ok) return passwordPage(res, l, true, `尝试过于频繁，请 ${rl.retryAfter} 秒后重试`);
  const frozenLeft = security.shareLock.locked(scope);
  if (frozenLeft > 0) return passwordPage(res, l, true, `密码错误次数过多，请 ${frozenLeft} 秒后重试`);

  const pw = String((req.body && req.body.password) || '');
  // SEC-05：口令校验为异步（旧 scryptSync 会被用于阻塞事件循环）
  if (await shareStore.checkPassword(l, pw)) {
    security.shareLock.reset(scope);
    res.cookie(cookieName(l.id), shareStore.accessToken(l), shareCookieOptions(l.id));
    return res.redirect(303, '/s/' + l.id);
  }
  const left = security.shareLock.fail(scope);
  statsStore.addLog({ action: 'share.auth', detail: `分享链接 ${l.id} 密码验证失败（IP：${ip}）`, level: 'warn' });
  if (left > 0) return passwordPage(res, l, true, `密码错误次数过多，该链接已临时冻结，请 ${left} 秒后重试`);
  return passwordPage(res, l, true);
}));

/* ------------------- R64：恢复购买 / 历史订单 / 退出登录 ------------------- */

/** 「恢复购买」输入页（游客的主路径：他没有账号可归集订单，只能凭号码取回） */
function restorePage(res, l, opts = {}) {
  /**
   * R65：被「连续输错」封禁时**不渲染表单**。
   *
   * 渲染一个必然失败的输入框会让人一直重试（既有 24 小时的等待，又有 400 的错误页），
   * 而这里真正需要告诉他的是三件事：为什么被拦、什么时候能再试、管理员从哪儿解封。
   */
  if (opts.blocked && opts.blocked.banned) {
    const until = opts.blocked.until ? fmtDate(opts.blocked.until) : '';
    return renderPage(res, 429, {
      title: '暂时无法取回',
      head: `<div class="center-head">
      <h1>尝试次数过多</h1>
      <p class="sub">该网络地址因<b>连续多次输错订单号</b>，已被限制使用「恢复购买」。</p>
      </div>`,
      body: `
      <div class="warn">限制将在 <b>${esc(until || '24 小时后')}</b> 自动解除（受限期间分享页浏览与付费下载都不受影响）。
        如果这是误判，请联系站点管理员在「IP 地址管理」中解封。</div>
      <a class="btn ghost" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">返回文件页</a>`,
    });
  }
  const err = opts.error ? `<div class="warn">${esc(opts.error)}</div>` : '';
  renderPage(res, opts.error ? 400 : 200, {
    title: '恢复购买',
    head: `<div class="center-head">
      
      <h1>恢复购买</h1>
      <p class="sub">输入付款时拿到的订单号，即可取回这条分享的下载权限，<b>无需再次付费</b>。</p>
      </div>`,
    body: `
      ${err}
      <form method="POST" action="/s/${esc(l.id)}/restore" style="margin-top:16px">
        <input type="text" name="orderNo" placeholder="请输入订单号" autofocus autocomplete="off"
          spellcheck="false" maxlength="64">
        <button class="btn primary" type="submit">取回下载权限</button>
      </form>
      <div class="pay-note">订单号是 36 位字母数字组合（区分大小写），可在支付成功页、
        历史订单页看到，也可在付款后留意保存。只有<b>支付成功</b>的订单才能取回下载权限。</div>
      <a class="btn ghost" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">返回文件页</a>`,
  });
}

/** 订单行（历史订单页）—— 已支付的可直接重新下载，已退款的只如实标注 */
function historyOrderRow(order, link) {
  const p = paymentProviders.platform(order.platform);
  const money = `¥${paymentRules.formatAmount(order.amountFen)}`;
  const refunded = order.status === 'refunded';
  const meta = [
    money,
    p ? p.name : order.platform,
    fmtDate(order.paidAt || order.createdAt),
    refunded ? '已退款' : '',
  ].filter(Boolean).join(' · ');
  const act = refunded
    ? '<span class="hs-off">凭证已失效</span>'
    : (link
      ? `<a class="hs-act" href="/s/${esc(order.linkId)}/dl">重新下载</a>`
      : '<span class="hs-off">分享已删除</span>');
  return `<div class="hs-row">
        <div class="hs-main">
          <div class="hs-name">${esc(order.fileName || '（未知文件）')}</div>
          <div class="hs-meta">${esc(meta)}</div>
          <div class="hs-no"><code>${esc(order.orderNo || order.id)}</code>
            <button class="copybtn" type="button" data-copy-order="${esc(order.orderNo || order.id)}">复制</button></div>
        </div>
        ${act}
      </div>`;
}

/** 免费下载行（同一份文件只出现一次 —— 由 `download-log.record()` 保证） */
function historyFreeRow(rec, link) {
  const act = link
    ? `<a class="hs-act" href="/s/${esc(rec.linkId)}">查看分享</a>`
    : '<span class="hs-off">分享已删除</span>';
  return `<div class="hs-row">
        <div class="hs-main">
          <div class="hs-name">${esc(rec.fileName || rec.fileKey)}</div>
          <div class="hs-meta">免费下载 · ${esc(fmtDate(rec.at))}</div>
        </div>
        ${act}
      </div>`;
}

/** 历史订单页（仅已登录用户） */
function historyPage(res, l, { user, orders, free }) {
  const orderRows = orders.map((o) => historyOrderRow(o, shareStore.get(o.linkId))).join('');
  const freeRows = free.map((r) => historyFreeRow(r, shareStore.get(r.linkId))).join('');
  renderPage(res, 200, {
    wide: true,
    title: '历史订单',
    head: `<div class="center-head">
      <h1>历史订单</h1>
      <p class="sub">账号 <b>${esc(user.username)}</b> 名下的已购订单与免费下载记录。</p>
      </div>`,
    body: `
      <div class="hs-sec">
        <div class="hs-title">已购订单（${orders.length}）</div>
        <div class="hs-list">${orderRows || '<div class="hs-empty">还没有已支付的订单</div>'}</div>
      </div>
      <div class="hs-sec">
        <div class="hs-title">免费下载（${free.length}，同一文件只记首次）</div>
        <div class="hs-list">${freeRows || '<div class="hs-empty">还没有免费下载记录</div>'}</div>
      </div>
      <a class="btn ghost" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">返回文件页</a>
      <script src="/js/share-order.js" defer></script>`,
  });
}

/**
 * 分享页「退出登录」—— 与 `/api/auth/logout` 同一个语义，只是换一种携带方式。
 *
 * 为什么不能直接复用 `/api/auth/logout`：它挂在 `/api` 下，`csrfGuard` 要求
 * 请求带 `X-Requested-With` 头，而分享页是一个**服务端渲染的普通文档**，
 * 里面只能放原生 `<form>`（CSP 不允许内联脚本，也没有 fetch 的余地）。
 * 这里改为依赖本文件顶部那道「非安全方法必须同源」的校验（Origin /
 * Sec-Fetch-Site / Referer 三者任一即可判定），语义上等价。
 *
 * 只销毁**当前这一个**会话（与「退出登录」的字面含义一致）；「登出全部设备」
 * 仍是管理端账号页的能力，不在分享页提供。
 */
router.post('/s/:id/logout', (req, res) => {
  const l = shareStore.get(req.params.id);
  const token = authSession.parseToken(req);
  const s = token ? authSession.getSession(token) : null;
  if (token) authSession.destroySession(token);
  if (s && s.user) {
    statsStore.addLog({ action: 'auth.logout', detail: `用户「${s.user.username}」在分享页退出登录` });
  }
  // 清除属性必须与下发时一致（Path / HttpOnly / SameSite / Secure），否则浏览器不覆盖
  res.clearCookie(authSession.COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !!security.IS_DEPLOY,
  });
  return res.redirect(303, l ? '/s/' + encodeURIComponent(l.id) : '/');
});

/** 恢复购买（输入页） */
router.get('/s/:id/restore', (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  // 与非付费路由同款：先过访问密码，否则这个页面会变成"这条链接存在"的探测口
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id);
  }
  // R65：被「连续输错」封禁时直接告知，不去渲染一个必然失败的表单
  const ban = restoreGuard.isBanned(security.clientIp(req));
  if (ban.banned) {
    res.setHeader('Retry-After', String(ban.retryAfter));
    return restorePage(res, l, { blocked: ban });
  }
  return restorePage(res, l);
});

/**
 * 恢复购买（提交订单号）—— 需求 1① 的唯一落点。
 *
 * 判定全部收口在 `paymentOrders.claimForLink()`：订单号存在、属于本链接、
 * **且状态是「支付成功」** 才会返回订单（需求末句「所有功能的前提是该订单号
 * 状态为支付成功」，在这里兑现）。通过后签发的就是**正常的已支付票据**
 * —— 与真正付完款时下发的那枚一模一样，因此后续所有下载路径（页面、`/dl`、
 * `HEAD /dl`）都不需要为本功能加任何分支。
 */
router.post('/s/:id/restore', asyncHandler(async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id);
  }

  const ip = security.clientIp(req);
  /**
   * R65：先看是不是已被「连续输错」封禁。
   *
   * 顺序刻意排在限流器**之前**：限流器给的是「10 分钟后重试」，而封禁是 24 小时 ——
   * 先报短的那个会让人以为等 10 分钟就好了，白等。
   */
  const ban = restoreGuard.isBanned(ip);
  if (ban.banned) {
    res.setHeader('Retry-After', String(ban.retryAfter));
    return restorePage(res, l, { blocked: ban });
  }
  const rl = security.orderRestoreLimiter(ip);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return restorePage(res, l, { error: `尝试次数过多，请 ${rl.retryAfter} 秒后重试。` });
  }

  const cfg = configStore.getRestore();
  const raw = String((req.body && req.body.orderNo) || '');
  const no = orderNo.normalize(raw);
  /**
   * 形状判据只用于**快速拒绝明显不是订单号的输入**，不作为取回条件：
   * R64 之前的老订单没有 36 位订单号，它们当年的「订单号」是 24 位记录 id，
   * 用户手里留着的就是那个值 —— 因此把长度放宽到 8~64、只限字母数字，
   * 真正的有效性一律交给 `claimForLink()`（查表 + 链接归属 + 支付状态）。
   *
   * ⚠️ R65：形状错误**也计入连续输错次数**。否则「乱敲一串」就成了零成本的探测方式，
   * 而攻击者只要每次都发不合形状的串，就永远不会触发上一档的失败计数。
   */
  if (!/^[0-9A-Za-z_-]{8,64}$/.test(no)) {
    const g = restoreGuard.noteFail(ip, cfg.maxFails);
    if (g.justBanned) {
      statsStore.addLog({
        action: 'share.restore-block', level: 'warn',
        detail: `IP ${ip} 连续输错订单号达 ${cfg.maxFails} 次，已限制「恢复购买」24 小时（链接 ${l.id}）`,
      });
    }
    return restorePage(res, l, { error: '订单号格式不正确，请核对后重新输入。' });
  }

  const r = paymentOrders.claimForLink(no, l.id, { maxUses: cfg.maxUses });
  if (!r.ok) {
    /**
     * 「取回次数已用完」**不算输错**：那是一笔真实存在、确实付过款的订单，
     * 只是额度用尽。把它计入失败次数会让「反复用自己的订单号重试」的人被封，
     * 而封禁要针对的是猜号，不是额度。
     */
    if (r.reason !== 'used_up') {
      const g = restoreGuard.noteFail(ip, cfg.maxFails);
      if (g.justBanned) {
        statsStore.addLog({
          action: 'share.restore-block', level: 'warn',
          detail: `IP ${ip} 连续输错订单号达 ${cfg.maxFails} 次，已限制「恢复购买」24 小时（链接 ${l.id}）`,
        });
      }
    }
    statsStore.addLog({
      action: 'share.restore', level: 'warn',
      detail: `分享页恢复购买失败（链接 ${l.id}，原因：${r.reason}，IP：${ip}）`,
    });
    return restorePage(res, l, { error: r.message });
  }

  // 成功：连击计数归零（失败次数是「连续」语义，成功一次就从头算）
  restoreGuard.noteSuccess(ip);

  // 与正常支付流程下发**同一枚**票据：后续所有下载判定因此无需新增任何分支
  res.cookie(payCookieName(l.id), paymentOrders.orderToken(r.order), shareCookieOptions(l.id));
  statsStore.addLog({
    action: 'share.restore',
    detail: `分享页凭订单号恢复下载权限（链接 ${l.id}，订单 ${r.order.orderNo || r.order.id}，IP：${ip}）`,
  });
  return res.redirect(303, '/s/' + l.id);
}));

/**
 * 查看历史订单（仅已登录用户）—— 需求 2①②。
 *
 * 两条数据源刻意分开：
 *  · 已购订单 → `paymentOrders.listForUser()`（只有付费才产生订单）；
 *  · 免费下载 → `download-log.listForUser()`（同一文件只记首次，见该模块）。
 *
 * 顺带为每一笔「已支付且链接仍存在」的订单**补发该链接的支付票据**：
 * 用户在这个页面上看到「重新下载」就应该真的能下，而不是点下去被弹回付费页
 * （票据是按链接存的 Cookie，而他可能换过设备）。退款订单**不补**——它的
 * 凭证必须保持失效，否则「退款后仍能下载」。
 */
router.get('/s/:id/history', (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));

  const me = shareUser(req);
  if (!me) {
    // 不静默跳登录页：明确告诉用户"这里需要登录"，并给出带 next 的入口
    return renderPage(res, 401, {
      title: '请先登录',
      body: `
        <div class="center-head">
          <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:22px">👤</div>
          <h1>请先登录</h1>
          <p class="sub">「查看历史订单」需要登录账号：订单是按账号归集的。</p>
        </div>
        <a class="btn primary" href="/?next=${encodeURIComponent('/s/' + l.id)}" style="text-align:center;text-decoration:none">去登录</a>
        <a class="btn ghost" href="/s/${esc(l.id)}/restore" style="text-align:center;text-decoration:none">改用订单号恢复购买</a>`,
    });
  }

  const all = paymentOrders.listForUser(me.id);
  const orders = all.filter((o) => o.status === 'paid' || o.status === 'refunded').slice(0, HISTORY_MAX_ROWS);
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    if (!shareStore.get(o.linkId)) continue; // 链接已删除 → 票据无意义
    res.cookie(payCookieName(o.linkId), paymentOrders.orderToken(o), shareCookieOptions(o.linkId));
  }
  const free = downloadLog.listForUser(me.id).slice(0, HISTORY_MAX_ROWS);
  return historyPage(res, l, { user: me, orders, free });
});

/* ------------------------------ 下载 ------------------------------ */

/**
 * HEAD `/s/:id/dl` —— 只回答「能不能下、有多大」，**不产生任何副作用**。
 *
 * 必须显式注册：Express 在没有 HEAD 路由时会把 HEAD 请求**交给 GET handler 处理**
 * （只丢弃响应体）。而 GET handler 是「有副作用的 GET」—— 它会占用一次下载名额、
 * 向云端发起完整 getObject。于是下载器先发一个 HEAD 做探测（Range 支持、文件大小）
 * 就会：① 白扣一次额度；② 白跑一遍全量流量。浏览器预取、断点续传客户端同理。
 *
 * 这里刻意只做**廉价检查**（读链接记录 + 状态判定），不触云端、不计数、不解密：
 * 探测就该是探测。也因此它不复用 GET 的流程 —— 复用即等于把副作用带回来。
 * 状态码与 GET 的状态页保持一致（404 / 410）。
 */
router.head('/s/:id/dl', (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) { res.status(404).end(); return; }
  const st = shareStore.status(l);
  if (st !== 'active') {
    // 与 statePage 的映射保持一致：deleted / expired / exhausted 一律 410
    res.status(410).end();
    return;
  }

  /* R8-23 ①：HEAD 必须复用 GET 的门禁判定（密码票据 / 付费状态）。
   *
   * 旧实现只做 `status()` 判定，于是**未持密码票据**者发一个 HEAD 就能以
   * 200/404/410 三态确认链接是否有效，并直接读到 `Content-Length`（精确文件大小）——
   * 而对同一 URL 发 GET 只会 303 回密码页。探测与真实下载必须看到同一结果。
   * 仍然保持「无副作用」：不占用下载名额、不触云端、不解密。 */
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return res.redirect(303, '/s/' + l.id); // 与 GET 一致
  }
  /* R21-01：密文对象的加密门禁同样要在这里判定，理由与上一条完全相同 ——
   * 探测（HEAD）与真实下载必须看到同一结果，否则 HEAD 会以 200 + Content-Length
   * 告诉你「这个密文文件多大」，而 GET 只把你送回分享页。 */
  if (encGateNeeded(l) && !encUnlocked(req)) return res.redirect(303, '/s/' + l.id);
  const ps = paidStateFor(l);
  if (ps.effective && payerStateFor(l, req).state !== 'paid') {
    return res.status(402).end(); // 与 payBlockedPage 的状态码一致
  }

  /* R8-23 ②：**不**宣告 `Accept-Ranges`。
   *
   * `GET /s/:id/dl` 走 `streamDownload`，恒为完整 200 + 完整 body，从不读
   * `req.headers.range`。广播一个未实现的能力会让续传客户端把 200 的整段内容
   * 拼到已下载的分片之后，产出**损坏的文件**。诚实的做法是什么都不声明。 */
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(Number(l.size) || 0));
  res.status(200).end();
});

/**
 * R51：把 `?k=` 的选择解析成**实际要下发的文件清单**。
 *
 * ⚠️ **这是本轮最重要的安全判据**：客户端提交的是**对象 key**（列表行的复选框 value），
 * 而 key 直接决定从桶里取哪个对象。若原样信任，任何人都能在一张分享页上把
 * `?k=` 改成桶内**任意**对象的路径 —— 用一条只分享了一个小文件的链接去抓别的文件
 * （`normalizeKey` 只挡 `..`，挡不住"换一个同级 key"）。因此这里只认
 * **创建时冻结的快照**里的 key，一个都不许例外；不在快照里的一律进 `unknown`，
 * 由调用方**整单拒绝**（含"部分合法部分非法"的情形 —— 静默忽略非法项会让
 * 攻击者只看到"少了几个文件"，而我们要让这件事在日志和响应里都留下痕迹）。
 *
 * 语义：
 *  · 不带 `k`（`undefined`）⇒ 整条分享（「打包下载全部」按钮走这条）
 *  · 勾了文件夹 ⇒ 展开成快照里它**前缀之下**的全部文件（空文件夹则只保留目录行，
 *    于是打包结果里仍能看到那个空目录）
 *  · 去重保序，顺序即归档内的书写顺序
 *
 * ## R52：`mode` —— 让「默认全选」活得过 GET 的长度限制
 *
 * 分享页默认全选之后，`?k=` 必须能表达三种状态，而**不能**把整份快照塞进查询串
 * （2000 项的快照展开成 1950 个 `k=` 就是 60KB+，请求行会被 Node / nginx 直接拒掉，
 * 表现为点「下载选中」毫无反应或一个 414）：
 *
 *  | 选择状态 | 提交体 | 说明 |
 *  | --- | --- | --- |
 *  | 快照全部 | `mode=all`（不带 `k`） | 与「不带 `k`」等价，6 字节 |
 *  | 只剩少数没勾 | `mode=exclude` + `x=<没勾的那些>` | 服务端取快照内的补集 |
 *  | 只勾了少数 | `k=<勾了的那些>`（不带 `mode`） | 与 R51 完全一致 |
 *
 * ⚠️ **排除集走 `x` 而不是复用 `k`**。这是本条协议里唯一一处反直觉的地方，理由很具体：
 * `mode=exclude` 下 `k` 的语义会从「要选的」翻转成「要排除的」，而页面上那些**已勾选**
 * 的复选框**一定会**随表单提交成 `k`（浏览器行为，前端不动 DOM 就改不掉）——
 * 于是同一个 `k` 会同时意味着「本页选中」与「全局排除」，服务端按哪边理解都是错的：
 * 把它当排除集，用户**正要下载**的文件反而被排除掉。用一个独立字段名，
 * 「`mode` 出现时只认它自己那套参数」这条规则才成立，`k` 也就自动失效、无需任何 DOM 操作。
 * （`mode=all` 同理忽略 `k`。）
 *
 * 前端永远挑**最短**的那种（见 `public/js/share-list.js` 的提交处理）。
 *
 * @param {object} query `req.query` / `req.body` 的合并结果（含 `mode` / `k` / `x`）
 * @param {object} v `shareStore.view(l, { items: true })` 的结果
 * @returns {{files: string[], dirs: string[], unknown: string[], all: boolean}}
 */
function parseSelection(query, v) {
  const dirsOfSnap = v.items.filter((i) => i.dir).map((i) => i.key);
  const filesOfSnap = v.items.filter((i) => !i.dir).map((i) => i.key);
  const dirSet = new Set(dirsOfSnap);
  const fileSet = new Set(filesOfSnap);

  const mode = query ? String(query.mode || '') : '';
  const raw = query ? query.k : undefined;
  const exRaw = query ? query.x : undefined;
  /**
   * 全选（三个入口，语义等价）：
   *  · `mode=all` —— 客户端把"整份快照"这个意图写明了；
   *  · 不带 `k` 的普通形态 —— 列表页在**没有 JS** 时提交的就是它（「打包下载全部」同理）；
   *  · `mode=exclude` 但排除集为空 —— 快照减去空集 = 快照。
   * 三者都返回整份快照，并且**忽略随行的 `k`**（页面上已勾选的复选框一定会提交它，
   * 见函数头那段说明）。
   */
  if (mode === 'all'
    || (mode === 'exclude' && exRaw === undefined)
    || (mode !== 'exclude' && raw === undefined)) {
    return { files: filesOfSnap.slice(), dirs: dirsOfSnap.slice(), unknown: [], all: true };
  }
  const asked = Array.isArray(raw) ? raw : [raw];
  const files = [];
  const dirs = [];
  const unknown = [];

  /**
   * 补集模式：`x` 是**没勾的**那些，选中集 = 快照 − 它们。
   * 排除一个目录 = 排除它前缀之下的全部条目（与勾选时「展开后代」对称）——
   * 否则「取消勾一个文件夹」会只去掉目录行本身，里面的文件照下，用户看到的是
   * 「我明明取消了这个文件夹，包里却还有它的内容」。
   */
  if (mode === 'exclude') {
    /**
     * ⚠️ 排除集只认 `x`：`k` 在这个模式下**必须被忽略**（见函数头的说明）。
     * 页面上已勾选的复选框会自动提交 `k`，若把 `k` 也算进来，用户正要下载的文件
     * 就会被当成"取消掉"的排除出去 —— 一个「没碰过任何东西却下不到文件」的怪现象。
     */
    const exAsked = Array.isArray(exRaw) ? exRaw : [exRaw];
    const exFiles = new Set();
    const exDirs = [];
    for (const item of exAsked) {
      const k = typeof item === 'string' ? item : '';
      if (!k) continue;
      if (dirSet.has(k)) { if (!exDirs.includes(k)) exDirs.push(k); } else if (fileSet.has(k)) exFiles.add(k);
      else unknown.push(k);
    }
    if (unknown.length) return { files: [], dirs: [], unknown, all: false };
    const underExDir = (key) => exDirs.some((d) => key.startsWith(d));
    return {
      files: filesOfSnap.filter((k) => !exFiles.has(k) && !underExDir(k)),
      dirs: dirsOfSnap.filter((k) => !exDirs.includes(k) && !underExDir(k)),
      unknown: [],
      all: false,
    };
  }

  for (const item of asked) {
    const k = typeof item === 'string' ? item : '';
    if (!k) continue;
    if (dirSet.has(k)) {
      if (!dirs.includes(k)) dirs.push(k);
      // 展开该目录在快照内的后代文件（前缀匹配 + 快照成员判定，不会越过快照边界）
      for (const key of filesOfSnap) {
        if (key.startsWith(k) && !files.includes(key)) files.push(key);
      }
    } else if (fileSet.has(k)) {
      if (!files.includes(k)) files.push(k);
    } else {
      unknown.push(k);
    }
  }
  return { files, dirs, unknown, all: false };
}

router.get('/s/:id/dl', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return res.redirect(303, '/s/' + l.id);
  }

  /* R21-01：加密门禁必须**早于** tryAcquire（占用下载名额）。
   *
   * 与付费拦截同一条纪律：没通过访问控制的人一字节都拿不到，就不该消耗额度 ——
   * 否则反复探测密文链接既能刷光 maxDownloads，也让「剩余次数」变成可观测的
   * 侧信道。判据与 `/api/fs/download` / `/api/fs/head` 共用 {@link encGateNeeded}。 */
  if (encGateNeeded(l) && !encUnlocked(req)) return res.redirect(303, '/s/' + l.id);

  // ---- 付费下载拦截 ----
  // 必须**早于** tryAcquire：未支付的请求不应消耗下载次数，
  // 否则反复尝试支付失败就能把额度刷光。
  const ps = paidStateFor(l);
  let paidOrder = null; // 本次下载所依据的已支付订单（用于事后标记「已下载」）
  if (ps.effective) {
    const payer = payerStateFor(l, req);
    if (payer.state !== 'paid') {
      statsStore.addLog({
        action: 'share.download', level: 'warn',
        detail: `已拦截未完成的付费下载（链接 ${l.id}，状态：${payer.state}）`,
      });
      return payBlockedPage(res, l, ps, payer);
    }
    paidOrder = payer.order;
  }

  /* ---- R51：解析勾选（必须命中快照） ----
   * 位置在付费/加密门禁**之后**、限流与计数**之前**：门禁先过（不给未授权者任何
   * 关于内容的信息），而选择非法时直接拒绝、**不占用下载次数**。 */
  const v = shareStore.view(l, { items: true });
  /**
   * R52：`k` / `mode` 可能来自查询串（分页链接、手写 URL、`<form method=GET>`）或
   * 表单体。两者合并后交给同一个 `parseSelection` —— 服务端只有一条解析路径，
   * 「勾选项必须命中快照」这条安全判据也就不会因为传输方式而分叉。
   * 表单体优先：POST 下来的东西是用户**这一次**的明确意图，查询串可能是页面地址。
   */
  const sel = parseSelection(Object.assign({}, req.query, req.body || {}), v);
  if (sel.unknown.length) {
    statsStore.addLog({
      action: 'share.download', level: 'warn',
      detail: `已拒绝不属于该分享的下载选项（链接 ${l.id}，${sel.unknown.length} 项，例如 ${String(sel.unknown[0]).slice(0, 120)}）`,
    });
    return renderPage(res, 400, {
      title: '选择无效',
      body: '<h1>选择无效</h1><p class="sub">你勾选的内容不属于这条分享，请返回分享页重新勾选。本次访问不占用下载次数。</p>',
    });
  }
  if (!sel.files.length) {
    // 空文件夹、或快照里本就没有文件：给 404 而不是下发一个空 tar.gz
    return renderPage(res, 404, {
      title: '没有可下载的文件',
      body: '<h1>没有可下载的文件</h1><p class="sub">这条分享里没有文件可下载（可能是个空文件夹）。本次访问不占用下载次数。</p>',
    });
  }
  /**
   * 单选一个**文件**时按原名直传，其余情形（多选、或选中了文件夹）打包成 `.tar.gz`。
   *
   * 直传保留了两个只有它才有的能力：浏览器能显示进度、并向云端发 Range 续传。
   * 只勾一个文件却套一层 tar.gz，用户拿到手还得先解压 —— 那是纯粹的负担。
   */
  const useBundle = sel.files.length > 1 || sel.dirs.length > 0;
  const singleKey = sel.files[0];

  // SEC-08：本端点是「有副作用的 GET」（访问即占用一次下载名额），
  // 而 `/s/*` 不在 `/api` 之下、不经过 CSRF 校验。任何外部页面的
  // `<img src="https://host/s/ID/dl">` 或链接预取都能静默消耗额度。
  // 这里补两层防护：
  //  ① 按 IP + 链接限流，限制被刷爆的速度；
  //  ② 校验 Sec-Fetch-Site —— 跨站发起的子资源/预取请求一律拒绝，
  //     同时显式禁止直接导航（Sec-Fetch-Mode: navigate 的顶层跳转仍允许）。
  const ip = security.clientIp(req);
  const dlRl = security.shareDownloadLimiter(`${ip}:${l.id}`);
  if (!dlRl.ok) {
    res.setHeader('Retry-After', String(dlRl.retryAfter));
    return statePage(res, 'limited', shareStore.view(l),
      `请求过于频繁，请 ${dlRl.retryAfter} 秒后重试（本次未占用下载次数）。`);
  }
  /* ---- SEC-08：来源判定（纯函数，见 server/share-origin.js） ----
   *
   * 该端点是"有副作用的 GET"，命中即扣减下载次数。第三方的 `<img src=.../dl>`
   * 能让任何访客默默刷掉额度，因此必须分层判定来源。
   * 判定逻辑集中在 share-origin.js，既便于行为测试，也避免把安全策略埋在路由里。
   */
  const hasValidTicket = shareStore.verifyToken(l, getCookie(req, cookieName(l.id)));
  const src = classifyDownloadSource({
    secFetchSite: req.headers['sec-fetch-site'],
    referer: req.headers.referer || req.headers.referrer,
    host: req.headers.host,
    secure: security.requestIsSecure(req), // R27-03：唯一判据（原本是这份正确写法的第三处副本）
    hasTicket: hasValidTicket,
  });
  if (!src.allow) {
    statsStore.addLog({
      action: 'share.download', level: 'warn',
      detail: `已拦截来源不受信任的分享下载（链接 ${l.id}，IP：${ip}，原因：${src.reason}，referer=${String(req.headers.referer || '').slice(0, 120)}）`,
    });
    return statePage(res, 'crosssite', shareStore.view(l),
      '该下载请求来自其它站点，已被拒绝。请在分享页面内点击下载。');
  }
  if (src.reason === 'no-source-hint') {
    // 直连客户端（curl / wget）：保留可用性，但落审计便于追溯
    statsStore.addLog({
      action: 'share.download', level: 'warn',
      detail: `分享下载缺少来源标识（链接 ${l.id}，IP：${ip}）—— 疑似脚本直连，已放行但仅依赖限流保护`,
    });
  }

  // 占用下载名额（先计数后传输，保证并发不超限）
  const acq = shareStore.tryAcquire(l.id);
  if (!acq.ok) return statePage(res, acq.reason, shareStore.view(acq.link || l));

  try {
    const cfg = configStore.effectiveForBucket(l.bucket, l.region);
    if (!cfg || !cfg.secretId) {
      // R8-09：配置失效 = 用户一字节都没拿到，与 catch 分支的服务端错误同性质，
      // 必须回滚刚占用的名额。旧实现直接 return，于是「管理员解绑桶/删密钥」期间
      // 访客每点一次下载就白扣一次：maxDownloads=3 的链接点 3 次即转 exhausted
      // **终态**，重新绑定桶后仍 410，只能靠人工「重置下载计数」救回。
      shareStore.release(l.id);
      return renderPage(res, 503, {
        title: '服务暂不可用',
        body: '<h1>服务暂不可用</h1><p class="sub">分享者尚未配置有效的访问密钥，无法下载。请联系分享者。本次访问不占用下载次数。</p>',
      });
    }
    const s3 = getClient(cfg);
    const region = cfg.region || l.region;
    const traffic = { bytesDown: 0 };
    /**
     * R37：下载限速。匿名访客没有系统账户，**用户层按分享创建者判**：
     * 限额挂在资源/归属人身上，于是「分享者自己设的限额」对匿名下载同样成立
     * （否则任何人都能靠拿一条分享链接绕开自己那层的限额）。
     * 链接层用 `l.id`，与链接管理列表里改的是同一条记录（「文件分享 = 链接管理」）。
     */
    const throttle = makeThrottle({
      ip: security.clientIp(req),
      method: req.method,
      credentialId: cfg.credentialId,
      bucketId: cfg.bucketId,
      userName: l.createdBy, // 链接只快照了用户名，没有 id
      linkId: l.id,
    });

    if (useBundle) {
      /* R51：多选 / 含文件夹 ⇒ 打包下发。
       * 打开单个对象的职责在这里（head 取真实长度、密文对象套解密流、404 跳过），
       * 打包本身在 share-bundle.js —— 那部分不依赖对象存储，可以脱离 HTTP 单独验。 */
      const entries = [];
      /**
       * R52-05：归档内的条目名与列表页**同一份展示名**（`itemPaths` 同时供两边使用）。
       * 此前直接用对象 key，于是"分享 `photos/2024/`"会把 `photos/` 这一层写进包内路径；
       * 解包出来就是分享者的目录组织方式 —— 列表页脱敏而归档不脱敏，等于没做。
       */
      const shownPaths = shareStore.itemPaths(v.items);
      for (const d of sel.dirs) entries.push({ name: shownPaths.get(d) || d, key: d, dir: true });
      for (const k of sel.files) entries.push({ name: shownPaths.get(k) || k, key: k, dir: false });
      // 归档内一级目录名与下载文件名同源：解包时不会把一堆文件倒进用户当前目录
      const archiveName = `${v.fileName}.tar.gz`;
      const openFile = async (entry) => {
        const key = entry.key;
        const encMeta = encStore.getMeta(l.bucket, key); // 密文对象：解密后进归档
        let head;
        try {
          head = await p(s3, 'headObject', { Bucket: l.bucket, Region: region, Key: key });
        } catch (e) {
          // 单个对象取不到（已被删 / 无权）⇒ 跳过它，不让整包失败：
          // 一条分享里 2000 个对象，一个被删就整包下不了，对用户是净损失。
          if (isNotFound(e)) {
            statsStore.addLog({
              action: 'share.download', level: 'warn',
              detail: `打包下载跳过已不存在的对象 ${key}（链接 ${l.id}）`,
            });
            return null;
          }
          throw e;
        }
        // 长度在**打开流之前**重新取：创建时的快照只是历史事实，对象被覆盖过就不对了，
        // 而 tar 头里写错长度会产出一个"能解开、内容是垃圾"的包。
        const size = encMeta ? Number(encMeta.origSize) || 0 : (Number(head.headers['content-length']) || 0);
        const stream = encMeta ? encStore.decryptTransform(encMeta) : new PassThrough();
        await p(s3, 'getObject', { Bucket: l.bucket, Region: region, Key: key, Output: stream });
        return { stream, size, mtime: head.headers['last-modified'] };
      };
      const bundleStats = await tracked('download', async () => streamBundle({
        entries, res, openFile, bucket: l.bucket, archiveName, throttle, traffic,
      }), traffic);
      if (paidOrder) paymentOrders.markDownloaded(paidOrder.id);
      // R64：免费下载记进「历史订单」的免费一栏（已登录才记；同一文件只记首次）
      else {
        noteFreeDownloads(req, l, sel.files.map((k) => ({ key: k, name: shownPaths.get(k) || k })));
      }
      statsStore.addLog({
        action: 'share.download',
        detail: `分享打包下载 ${l.id}：${bundleStats.files} 个文件`
          + `${bundleStats.dirs ? ` / ${bundleStats.dirs} 个目录` : ''}`
          + `${bundleStats.skipped ? `，跳过 ${bundleStats.skipped} 个已不存在的对象` : ''}`
          + `（${traffic.bytesDown} 字节）`,
        level: bundleStats.skipped ? 'warn' : 'info',
      });
    } else {
      const encMeta = encStore.getMeta(l.bucket, singleKey); // 密文对象：解密后下发（分享密码即为权限验证）
      await tracked('download', async () => {
        await streamDownload({
          s3,
          bucket: l.bucket,
          region,
          key: singleKey,
          // 文件名取所选对象自己的 basename（多条目链接的 `l.fileName` 是「xxx 等 N 项」，
          // 那是列表页的标题，不能拿去当下载文件名）
          fileName: shareStore.itemName(singleKey),
          encMeta, req, res, traffic, throttle,
        });
      }, traffic);
      // 传输**结束后**才标记已下载：传输中途失败若提前标记，
      // 管理页会显示"已下载"而用户其实没拿到文件，对账就失真了。
      if (paidOrder) paymentOrders.markDownloaded(paidOrder.id);
      // R64：免费下载 → 「历史订单」的免费一栏（同一文件只记首次）
      else noteFreeDownloads(req, l, [{ key: singleKey, name: shareStore.itemName(singleKey) }]);
      statsStore.addLog({ action: 'share.download', detail: `分享下载 ${singleKey}（${traffic.bytesDown} 字节，链接 ${l.id}${encMeta ? '，已解密' : ''}）` });
    }
  } catch (e) {
    statsStore.addLog({ action: 'share.download', detail: `分享下载失败 ${l.id}（${useBundle ? '打包' : singleKey}）: ${e.message}`, level: 'error' });
    // 云端明确回答"没有这个对象" → 顺手把链接标成已删除，
    // 让下一次访问（以及管理页）直接给出确定答案，不用再白跑一趟。
    // R51：只有**单一普通文件**的链接才这么判 —— 多条目链接里少一个对象不足以
    // 判定整条失效（判据与 probeObjectMissing 同源，见那里的事故注释）。
    if (isNotFound(e) && !v.listView) shareStore.markMissing(l.id);
    if (!res.headersSent) {
      shareStore.release(l.id); // 启动前失败：回滚计数
      return renderPage(res, 404, {
        title: '文件不存在',
        body: '<h1>文件不存在或已被删除</h1><p class="sub">云端未找到该文件，可能已被分享者删除。本次失败的下载不占用次数额度。</p>',
      });
    }
    // SEC-06：响应已发出后才失败 —— 区分是谁的锅。
    //  · 客户端主动中断（用户取消 / 网络断开）：文件已经（至少部分）发出，
    //    扣减一次是合理的，"先计数后传输"本就是为防并发超限而设计的取舍；
    //  · **服务端错误**（云端中断、解密失败、配置失效）：用户一字节都没拿到，
    //    这时必须回滚，否则"还剩 3 次"会因为服务端自己的故障凭空变成 2 次。
    //    旧实现两种情况都不回滚，属于被注释承认、却始终没做的补偿。
    const clientGone = req.aborted || (req.socket && req.socket.destroyed)
      || res.writableEnded || res.destroyed;
    if (!clientGone) {
      shareStore.release(l.id);
      statsStore.addLog({
        action: 'share.download', level: 'warn',
        detail: `分享下载 ${l.key}（链接 ${l.id}）在传输中因服务端错误中断，已回滚本次下载次数`,
      });
    }
    res.destroy();
  }
});

module.exports = router;
// 测试钩子（R24-01）：站点对外地址的选取阶梯是纯函数，导出以便在不起服务的前提下
// 断言「未配置站点地址时不得信任任意请求 Host」这条纪律（与 buckets 的 __probeBucket 同例）。
module.exports.__siteUrlFor = siteUrlFor;
