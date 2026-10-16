/** API 客户端 —— 与本地服务端通信 */

/**
 * @param {object} [opt]
 * @param {AbortSignal} [opt.signal]
 * @param {boolean} [opt.noAuthRedirect] 401 时**不**派发全局 `auth-required`。
 *   R8-12：只有在「本来就没有有效会话」的调用（登录、初始化管理员、登录第二步
 *   Windows Hello 断言）上才需要它 —— 这些请求失败时弹「登录已过期，请重新登录」
 *   既误导用户、又会把正在填写的表单整块重置掉。
 */
async function request(method, path, body, { signal, noAuthRedirect } = {}) {
  // X-Requested-With：同源自定义头，浏览器跨域表单无法伪造，用于服务端 CSRF 校验
  const opt = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (signal) opt.signal = signal;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    // 主动取消（AbortController）不是故障：原样抛出，交给调用方静默丢弃。
    // 否则会被当成"无法连接本地服务"弹一个完全误导的错误提示。
    if (e && e.name === 'AbortError') throw e;
    const err = new Error('无法连接本地服务，请确认服务已启动');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    /**
     * R25：配额类错误带**机器可读码 + 结构化明细**（`code` / `quota`）。
     * 必须挂回错误对象 —— 只留文案的话，调用方无法把「超出 API Key 配额」与其它
     * 403（如上传排除命中）区分开，只能对所有 403 弹同一条提示。
     */
    if (data && data.code) err.code = data.code;
    if (data && data.quota) err.quota = data.quota;
    /**
     * R33：账户封禁同样带**结构化字段**（`banned` / `reason` / `until`）。
     * 只留那句「该账户已被封禁」的文案，登录页就无从显示"为什么被封、什么时候解封"，
     * 而这正是需求明确要求给被封用户看的两项信息（服务端已在校验密码后才下发）。
     */
    if (data && data.banned) {
      err.banned = true;
      err.reason = data.reason || '';
      err.until = data.until || '';
    }
    /**
     * R54②：限流类错误带上 `Retry-After`。界面（「发送验证码」按钮）要拿它做倒计时 ——
     * 不给的话前端只能写死一个猜的秒数，与服务端真实的窗口对不上，
     * 用户会在倒计时结束后立刻再点、再被拒一次。
     */
    const retryAfter = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
    // 401 未登录 → 派发全局事件，由 main.js 统一跳回登录界面。
    // R8-12：服务端的 401 只有两种含义，这里都必须**真是**「没有有效会话」。
    // 「当前密码不正确」（webauthn 注册/关闭）已改为 403；登录类请求用 noAuthRedirect 排除。
    if (res.status === 401 && !noAuthRedirect && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth-required'));
    }
    throw err;
  }
  // R47：写请求**成功**后通知界面同步。这是全站唯一的收口点 —— 所有 API 调用都要
  // 经过本函数，因此不必（也不可能）依赖每个调用方「记得刷新」。
  notifyWrite(method, path);
  return data;
}

/**
 * 只取**纯文本**响应体的请求（R54③ 邀请码导出）。
 *
 * ## 为什么不能复用 `request()`
 *
 * 它**无条件** `await res.json()`（见第 31 行）。导出端点的响应体就是纯文本本身
 * （不包 JSON，因为它会被直接另存为 `.txt`），`res.json()` 抛错后被那句
 * 「非 JSON 响应」的 catch 吞掉、`data` 留在 `null`，而 `res.ok` 为真 ⇒
 * **成功请求也返回 `null`**。症状极其难查：点了「导出」没有任何反应，也没有报错。
 *
 * ## 刻意不做的两件事
 *
 *  - **不派发 `notifyWrite`**：导出不改变任何服务端状态，它只是 POST（因为响应体是
 *    明文口令集合，不能进 URL / 日志）。把它当写操作广播，会让界面在每次导出后
 *    白白重刷一遍。
 *  - **不合并进 `request()` 加一个 `text: true` 开关**：那会给「唯一收口点」
 *    引入一个分支，而这个分支只在导出这一处用到。两个函数各自线性、各自可读。
 *
 * ⚠️ 失败路径**必须自己解析出 `{ error }`**：服务端的错误响应统一由 `apiHandler`
 *    落地为 JSON，用纯文本路径拿到它就成了一串 JSON 原文，直接抛给用户看
 *    （`{"error":"仅管理员可执行该操作"}`）显然不行。
 */
async function requestText(method, path, body) {
  const opt = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const err = new Error('无法连接本地服务，请确认服务已启动');
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = '';
    try { msg = (JSON.parse(text) || {}).error || ''; } catch (e) { /* 非 JSON（如网关错误页） */ }
    const err = new Error(msg || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    // 401 未登录 → 与 `request()` 同款：派发全局事件跳回登录界面。
    // 导出接口没有 `noAuthRedirect` 那三种例外场景（它必须登录后才可能被调用），故恒派发。
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth-required'));
    }
    throw err;
  }
  return text;
}

/* ---------------------- R47：写操作 → 界面同步 ---------------------- */

/**
 * 写操作观察者（由 `main.js` 在启动时注入）。
 *
 * 此前每个写操作各自管自己的收尾刷新，而**跨区块**的陈旧数据没人管：保存一条分享链接
 * 不会更新仪表盘统计，改一个用户不会更新侧栏桶列表的可见性 —— 表现为用户所说的
 * 「执行操作后必须刷新页面才看到正式生效的结果」。本模块只负责**在正确的时机发出信号**，
 * 「该刷新什么」属于界面逻辑，留在 `main.js`。
 */
let writeObserver = null;

/** 注入观察者；传非函数即注销（测试与登出场景用）。 */
export function setWriteObserver(fn) {
  writeObserver = typeof fn === 'function' ? fn : null;
}

/**
 * 不触发界面同步的写请求白名单 —— **每一条都必须写清理由**。
 *
 * 判据是「**语义上不是一次会让界面变旧的配置/数据变更**」，而不是「调用方自己已经刷新了」：
 * 后者会把 R47 想消除的脆弱性（依赖每个调用点记得刷新）原样搬回来。因此只列三类：
 *  ① **探针**：只校验凭据可用性，不改任何状态；
 *  ② **会话生命周期**：登录/登出/初始化本身就会重建整个界面，且登出后再同步会打到失效会话上；
 *  ③ **解锁/挑战**：一次性凭据校验或随机数生成，不落配置。
 * 路径匹配有两种写法，二选一：
 *  - `{ path }`      精确相等；
 *  - `{ path, suffix }`：`path` 前缀 **且** `suffix` 结尾 —— 用于「同一前缀下只有某个子路径
 *    是探针」的情形（如 `/api/payment/config/<平台>/validate` 是探针，而
 *    `PUT /api/payment/config/<平台>` 是**真正的保存**，绝不能一起豁免）。
 * 未登记的一律同步。
 */
const WRITE_EXEMPT = [
  { path: '/api/config/verify', why: '① 连接测试探针：只校验凭据能不能连通，不写任何配置' },
  { path: '/api/payment/config', suffix: '/validate', why: '① 支付渠道「验证」探针（同前缀的 PUT 是保存，不在此列）' },
  { path: '/api/auth/login', why: '② 登录第一步：成功后由登录流程整体重建界面（重复同步无意义）' },
  { path: '/api/auth/login/webauthn', why: '② 登录第二步断言：同上' },
  { path: '/api/auth/init', why: '② 初始化管理员：成功后进入登录流程，此时尚无会话可同步' },
  { path: '/api/auth/logout', why: '② 登出：会话已销毁，再发同步请求只会拿到 401 并触发重定向' },
  /**
   * R57：注册 / 忘记密码 / 重置密码 —— 三条都是**登录之前**用的匿名端点。
   *
   * 漏登记的后果实测过：`POST /api/auth/forgot` 成功后触发一次界面同步，而同步的第一件事
   * 就是 `GET /api/config`（需要会话）⇒ 401 ⇒ `loadConfig()` 的 catch 把服务端那句
   * 401 文案 `toast` 出来。用户点「发送验证码」明明成功了，却先看到
   * 「未登录或会话已过期，请重新登录」—— 而且**紧接着仍然进了重置密码窗口**，
   * 两件事叠在一起，看起来就像"发送失败却放行了"。
   * 这三条本来就无界面状态可同步（此刻连会话都没有）。
   */
  { path: '/api/auth/register', why: '② 登录前动作：此刻本无会话，同步界面必然 401' },
  { path: '/api/auth/forgot', why: '② 同上（忘记密码第一步，匿名可达）' },
  { path: '/api/auth/reset', why: '② 同上（重置密码，匿名可达）' },
  { path: '/api/enc/unlock', why: '③ 加密访问密码校验：只是会话内的解锁动作，不改任何设置' },
  { path: '/api/webauthn/register/options', why: '③ 生成 WebAuthn 挑战：随机数，不落库（随后的 verify 才是真写）' },
];

function isWriteExempt(method, path) {
  if (method === 'GET') return true; // 读请求永远不触发同步
  return WRITE_EXEMPT.some((e) => (e.suffix
    ? path.startsWith(e.path + '/') && path.endsWith(e.suffix)
    : path === e.path));
}

function notifyWrite(method, path) {
  if (!writeObserver) return;
  if (isWriteExempt(method, path)) return;
  try {
    writeObserver(path);
  } catch (e) {
    /* 观察者异常绝不能影响请求结果本身：同步是"锦上添花"，不是业务的一部分 */
  }
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  return p.toString();
}

/**
 * R29-01：上传的**停滞**判定阈值（区分两个阶段，理由见 `xhrPut`）。
 *  - `UPLOAD_IDLE_MS`：还在发字节时的静默容忍 —— 60 秒一个字节都没发出去，基本可判链路已断；
 *  - `UPLOAD_SERVER_WAIT_MS`：请求体已发完、等服务端确认 —— 服务端还要加密 / 上云 / 写元数据，
 *    大文件上云本身就可能几分钟，故给足 10 分钟。
 *
 * 两个值都**不是**「上传总时长」上限（那会误杀慢链路）：只有**完全没有进展**才会触发。
 */
const UPLOAD_IDLE_MS = 60 * 1000;
const UPLOAD_SERVER_WAIT_MS = 10 * 60 * 1000;

/**
 * XHR 上传（支持进度回调；返回的 Promise 附加 .xhr 引用用于中止）
 *
 * R29-01：这里补上了**停滞看门狗**。此前没有任何超时保护：只要服务端（或其背后的对象存储）
 * 迟迟不返回，`xhr.onload` 就永远不触发，上传任务会**无限期停在「上传中」**——用户看到的是
 * 「大文件卡住」，而文件可能早已落云（于是又表现为「刷新一下就有了」）。
 * 现在按阶段看门狗：
 *  - 发送阶段 60 秒无任何上传进度 → 判定链路停滞，abort 并给出可重试的错误；
 *  - 请求体发完后的等待阶段给到 10 分钟 → 超时同样 abort（错误里说明是服务端未确认）。
 * 停滞错误**不设 `aborted`**，因此 `uploadWithRetry` 会按既有策略重试两次，而不是直接失败。
 */
export function xhrPut(url, blob, onProgress) {
  const xhr = new XMLHttpRequest();
  const p = new Promise((resolve, reject) => {
    let settled = false;
    let stalled = false;
    let bodySent = false;
    let watchdog = null;
    const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    const armWatchdog = () => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        stalled = true;
        // 触发 onabort → 下面的分支给出「停滞」错误（而不是「已中止」）
        try { xhr.abort(); } catch (e) { /* ignore */ }
      }, bodySent ? UPLOAD_SERVER_WAIT_MS : UPLOAD_IDLE_MS);
    };
    const settle = (fn, arg) => { if (settled) return; settled = true; clearWatchdog(); fn(arg); };

    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e && e.total && e.loaded >= e.total) bodySent = true;
      armWatchdog();
      if (onProgress) onProgress(e.loaded, e.total);
    };
    /**
     * R29-01：`upload.onload` 是「请求体**已全部交给网络栈**」的权威信号 —— 小文件上
     * `onprogress` 可能一次都不触发（浏览器会合并甚至省略），只靠它就会让进度条一直停在 0%
     * 直到响应到达。这里补一次"已发完"的回调：既让界面切到「服务器处理中」，也让看门狗
     * 从 60 秒档切到 10 分钟档（此后的等待属于服务端处理，不是链路停滞）。
     */
    xhr.upload.onload = () => {
      bodySent = true;
      armWatchdog();
      const total = Number(blob && blob.size) || 0;
      if (onProgress) onProgress(total, total);
    };
    xhr.onload = () => {
      clearWatchdog();
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) return settle(resolve, d);
      const err = new Error(d.error || `上传失败（HTTP ${xhr.status}）`);
      err.status = xhr.status;
      // R25：与 request() 同源 —— 直传（XHR）路径同样要能识别配额超限
      if (d && d.code) err.code = d.code;
      if (d && d.quota) err.quota = d.quota;
      settle(reject, err);
    };
    xhr.onerror = () => settle(reject, new Error('网络错误，上传中断'));
    xhr.onabort = () => {
      if (stalled) {
        const err = new Error(bodySent
          ? '上传停滞：数据已发完但服务器长时间未确认（加密 / 上云可能耗时过长，或链路中断）'
          : '上传停滞：持续 60 秒没有数据发出（链路中断或服务端未响应）');
        err.stalled = true; // 不设 aborted：让上层按既有的重试策略再试
        return settle(reject, err);
      }
      const err = new Error('已中止');
      err.aborted = true;
      settle(reject, err);
    };
    armWatchdog();
    xhr.send(blob);
  });
  p.xhr = xhr;
  return p;
}

export const API = {
  health: () => request('GET', '/api/health'),
  // R34：「关于」卡片的「检查更新」——服务端去 GitHub 取最新版本号后与本机比较。
  // 服务端代理（而不是浏览器直连 api.github.com）的两个理由：不受浏览器跨域/离线影响，
  // 且「当前版本」只有服务端能拿到权威值（package.json），前端那个 Build 号是静态文本。
  checkUpdate: () => request('GET', '/api/update/check'),
  getConfig: () => request('GET', '/api/config'),
  saveConfig: (b) => request('PUT', '/api/config', b),
  verifyConfig: (b) => request('POST', '/api/config/verify', b),

  // 登录认证 / 用户管理
  authMe: () => request('GET', '/api/auth/me'),
  // 登录三兄弟（login / loginWebauthn / initAdmin）失败时**不**派发 auth-required：
  // 此刻本来就没有会话，401 意味着「凭据不对」，不是「会话过期」。
  login: (username, password, captchaToken, remember) => request('POST', '/api/auth/login', Object.assign(
    { username, password, remember: !!remember }, captchaToken ? { captchaToken } : null),
    { noAuthRedirect: true }),
  // 登录第二步：Windows Hello 断言校验（仅在第一步返回 webauthnRequired 时调用）
  loginWebauthn: (b) => request('POST', '/api/auth/login/webauthn', b, { noAuthRedirect: true }),
  logout: () => request('POST', '/api/auth/logout'),
  initAdmin: (b) => request('POST', '/api/auth/init', b, { noAuthRedirect: true }),
  /**
   * R54②：注册 / 忘记密码 / 重置密码 —— 三条都是**登录之前**用的，
   * 因此与「登录三兄弟」同样带 `noAuthRedirect`：此刻本来就没有会话，
   * 401 / 403 意味着"这个动作不被允许"，而不是"会话过期"（不必再派发一次全局跳转）。
   */
  register: (b) => request('POST', '/api/auth/register', b, { noAuthRedirect: true }),
  forgotPassword: (b) => request('POST', '/api/auth/forgot', b, { noAuthRedirect: true }),
  resetPassword: (b) => request('POST', '/api/auth/reset', b, { noAuthRedirect: true }),
  /**
   * R54②：邮箱验证码（**已登录** —— 给自己绑定 / 更换邮箱的第一步）。
   * 第二步（提交验证码 + 当前密码）走 `PUT /users/me`，与用户名 / 密码同一个保存入口。
   */
  emailCode: (email) => request('POST', '/api/auth/email/code', { email }),
  users: () => request('GET', '/api/users'),
  addUser: (b) => request('POST', '/api/users', b),
  updateUser: (id, b) => request('PUT', `/api/users/${encodeURIComponent(id)}`, b),
  deleteUser: (id) => request('DELETE', `/api/users/${encodeURIComponent(id)}`),
  // R33：账户封禁 / 解封（仅管理员）。`until` 由 datetime-local 换算成 epoch 毫秒后提交，
  // 留空即永久封禁 —— 服务端按绝对时刻存储，跨时区不会错位。
  banUser: (id, b) => request('POST', `/api/users/${encodeURIComponent(id)}/ban`, b),
  unbanUser: (id) => request('POST', `/api/users/${encodeURIComponent(id)}/unban`),
  // 自助资料（普通用户亦可调用；仅允许改用户名与密码）
  myProfile: () => request('GET', '/api/users/me'),
  updateMyProfile: (b) => request('PUT', '/api/users/me', b),

  // Windows Hello（WebAuthn）：注册 / 关闭
  webauthnRegisterOptions: (password) => request('POST', '/api/webauthn/register/options', { password }),
  webauthnRegisterVerify: (b) => request('POST', '/api/webauthn/register/verify', b),
  webauthnDisable: (password) => request('POST', '/api/webauthn/disable', { password }),
  adminDisableWebauthn: (id) => request('POST', `/api/users/${encodeURIComponent(id)}/webauthn/disable`),

  // 登录人机验证（验证码）
  captchaPublic: () => request('GET', '/api/captcha/public'),
  captchaConfig: () => request('GET', '/api/captcha/config'),
  saveCaptchaConfig: (b) => request('PUT', '/api/captcha/config', b),

  // 发信设置（SMTP，仅管理员；R53）
  smtpConfig: () => request('GET', '/api/smtp/config'),
  saveSmtpConfig: (b) => request('PUT', '/api/smtp/config', b),
  sendSmtpTest: (b) => request('POST', '/api/smtp/test', b),

  // 站点设置（R54）。`siteInfo` 是**公开**接口 —— 登录页在拿到会话之前
  // 就要用站点名称设置浏览器标题栏（见 main.js 的 applySiteName）。
  siteInfo: () => request('GET', '/api/site/info'),
  siteConfig: () => request('GET', '/api/site/config'),
  saveSiteConfig: (b) => request('PUT', '/api/site/config', b),

  // 邀请码设置（R54③，**全部仅管理员**）。
  // ⚠️ `exportInvites` 走 `requestText` 而不是 `request`：响应体是纯文本本身
  //（见 `requestText` 的注释）。也**刻意是 POST**：那里是明文邀请码集合，
  // 用 GET 会把整批口令写进浏览器历史与反向代理的 access log。
  invites: () => request('GET', '/api/invites'),
  generateInvites: (b) => request('POST', '/api/invites', b),
  updateInvite: (id, b) => request('PUT', `/api/invites/${encodeURIComponent(id)}`, b),
  bulkUpdateInvites: (ids, b) => request('POST', '/api/invites/bulk', Object.assign({ ids }, b)),
  deleteInvites: (ids) => request('POST', '/api/invites/delete', { ids }),
  exportInvites: (ids) => requestText('POST', '/api/invites/export', { ids: ids || [] }),

  // 访问密钥管理
  listCredentials: () => request('GET', '/api/credentials'),
  addCredential: (b) => request('POST', '/api/credentials', b),
  activateCredential: (id) => request('PUT', `/api/credentials/${encodeURIComponent(id)}/active`),
  updateCredential: (id, b) => request('PUT', `/api/credentials/${encodeURIComponent(id)}`, b),
  deleteCredential: (id) => request('DELETE', `/api/credentials/${encodeURIComponent(id)}`),
  // 批量设置密钥对普通用户的可见性（仅管理员）
  saveCredentialVisibility: (visibleIds) => request('PUT', '/api/credentials/visibility', { visibleIds }),
  // 负载均衡：按 API Key 的配额用量（仅管理员）
  quotaUsage: () => request('GET', '/api/credentials/quota-usage'),
  setCredentialQuota: (id, quotaBytes) => request('PUT', `/api/credentials/${encodeURIComponent(id)}`, { quotaBytes }),

  // 本地存储桶管理
  localBuckets: () => request('GET', '/api/buckets/local'),
  addBucket: (b) => request('POST', '/api/buckets/local', b),
  updateBucket: (id, b) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}`, b),
  toggleBucketEnabled: (id, enabled) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/enabled`, { enabled }),
  setBucketBlockOverseas: (id, enabled) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/block-overseas`, { enabled }),
  activateBucket: (id) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/active`),
  deleteBucket: (id) => request('DELETE', `/api/buckets/local/${encodeURIComponent(id)}`),
  // 批量设置桶对普通用户的可见性（仅管理员）
  saveBucketVisibility: (visibleIds) => request('PUT', '/api/buckets/visibility', { visibleIds }),

  // 存储桶管理页
  bucketStats: () => request('GET', '/api/buckets/stats'),
  clearBucket: (id, nameConfirm) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/clear`, { nameConfirm }),
  bucketFragments: (id) => request('GET', `/api/buckets/local/${encodeURIComponent(id)}/fragments`),
  clearFragments: (id) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/fragments/clear`),
  destroyCheck: (id) => request('GET', `/api/buckets/local/${encodeURIComponent(id)}/destroy-check`),
  destroyBucket: (id, nameConfirm) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/destroy`, { nameConfirm }),

  // 桶 ACL 安全检查
  aclCheck: () => request('GET', '/api/acl-check'),
  setAclReminder: (disabled) => request('PUT', '/api/acl-check/disabled', { disabled }),

  // 文件加密（系统设置）
  encSettings: () => request('GET', '/api/enc/settings'),
  // R8-14：任意登录用户可读的最小摘要（仅 passwordSet，不含 mode / 魔数）
  encStatus: () => request('GET', '/api/enc/status'),
  updateEncSettings: (b) => request('PUT', '/api/enc/settings', b),
  encUnlock: (password) => request('POST', '/api/enc/unlock', { password }),

  // IP 访问屏蔽
  ipGuard: () => request('GET', '/api/ipguard'),
  addIpRule: (b) => request('POST', '/api/ipguard/rules', b),
  updateIpRule: (id, b) => request('PUT', `/api/ipguard/rules/${encodeURIComponent(id)}`, b),
  toggleIpRule: (id, enabled) => request('PUT', `/api/ipguard/rules/${encodeURIComponent(id)}/enabled`, { enabled }),
  deleteIpRule: (id) => request('DELETE', `/api/ipguard/rules/${encodeURIComponent(id)}`),
  testIpRule: (ip, method, bucketId) => request('GET', '/api/ipguard/test?' + qs({ ip, method, bucketId })),

  // R37：下载限速的「上层下限」查询（`{ scope, id }` 或 `{ scope:'link', bucket }`）。
  // 设置限速本身走各实体既有的 PUT（见 speedlimit.js 的 SAVE_BY_SCOPE），不另开写接口。
  throttleCeiling: (p) => request('GET', '/api/throttle/ceiling?' + qs(p)),

  // R38：配置备份（四条接口全部仅管理员 —— 实时码含 API Key / 支付凭证 / WebDAV 口令明文）
  backupStatus: () => request('GET', '/api/backup/status'),
  backupCode: () => request('GET', '/api/backup/code'),
  // 导出要**两把**密码：账户口令（权限验证）+ 独立的备份密码（保护导出码）
  backupExport: (password, backupPassword) => request('POST', '/api/backup/export', { password, backupPassword }),
  backupImport: (code, backupPassword) => request('POST', '/api/backup/import', { code, backupPassword }),

  list: (p) => request('GET', '/api/fs/list?' + qs(p)),
  // opt.signal：供调用方取消在途搜索（服务端据此停止后续翻页，不再白扫）
  search: (p, opt) => request('GET', '/api/fs/search?' + qs(p), undefined, opt),
  tree: (prefix) => request('GET', '/api/fs/tree?' + qs({ prefix })),
  mkdir: (path) => request('POST', '/api/fs/mkdir', { path }),
  rename: (path, newName, size) => request('POST', '/api/fs/rename', { path, newName, size }),
  move: (paths, targetPrefix) => request('POST', '/api/fs/move', { paths, targetPrefix }),
  // R52-03：复制 / 粘贴。`decisions` 只在**第二次**请求里带 —— 第一次故意不带，
  // 服务端据此回 `needsDecision` 让我们先问用户，见 server/routes/fs.js 的协议说明。
  copy: (paths, targetPrefix, decisions) => request('POST', '/api/fs/copy', { paths, targetPrefix, decisions }),
  del: (paths) => request('POST', '/api/fs/delete', { paths }),
  presign: (path, expires) => request('GET', '/api/fs/presign?' + qs({ path, expires })),
  stat: (path) => request('GET', '/api/fs/stat?' + qs({ path })),

  // 分享链接管理
  links: () => request('GET', '/api/links'),
  createLink: (b) => request('POST', '/api/links', b),
  updateLink: (id, b) => request('PUT', `/api/links/${encodeURIComponent(id)}`, b),
  deleteLink: (id) => request('DELETE', `/api/links/${encodeURIComponent(id)}`),
  // R32-02：删除全部失效链接（文件已删除 / 已过期）；「已关闭」不算失效，不受影响
  deleteDeadLinks: () => request('DELETE', '/api/links/dead'),
  // R50：分享链接的二维码（服务端用零依赖的 qrcode.js 渲染成 SVG 回传）。
  // 必须走 request() —— /api 的 CSRF 校验要自定义头，`<img src>` 发不出来。
  linkQrcode: (text) => request('GET', '/api/links/qrcode?' + qs({ text })),

  uploadInit: (key, size, mtime, extra) => request('POST', '/api/fs/upload/init', Object.assign({ key, size, mtime }, extra || {})),
  uploadComplete: (sessionId) => request('POST', '/api/fs/upload/complete', { sessionId }),
  uploadAbort: (sessionId) => request('POST', '/api/fs/upload/abort', { sessionId }),
  sessions: () => request('GET', '/api/fs/sessions'),

  // 上传排除设置
  uploadExcludes: () => request('GET', '/api/upload-excludes'),
  saveUploadExcludes: (b) => request('PUT', '/api/upload-excludes', b),

  // R48：线程并发（同时上传 / 加密的文件数，最小 1）。
  // 读走 `getConfig()` 的 `concurrency`（对所有登录用户下发），这里只有写。
  saveConcurrency: (files) => request('PUT', '/api/concurrency', { files }),

  // 支付平台凭证（系统设置，仅管理员）
  paymentConfig: () => request('GET', '/api/payment/config'),
  paymentOrders: () => request('GET', '/api/payment/orders'),
  // 退款：本系统不代持资金，这只是把订单标记为「已退款」的人工记账动作
  refundOrder: (id) => request('POST', `/api/payment/orders/${encodeURIComponent(id)}/refund`),
  // R32-01：删除全部「支付失败」的订单（已支付 / 已退款 / 支付中一律不受影响）
  deleteFailedOrders: () => request('DELETE', '/api/payment/orders/failed'),
  setPaymentSiteUrl: (siteUrl) => request('PUT', '/api/payment/site-url', { siteUrl }),
  setPaymentEnabled: (enabled) => request('PUT', '/api/payment/enabled', { enabled }),
  setPaymentChannelEnabled: (platform, enabled) => request('PUT', `/api/payment/config/${encodeURIComponent(platform)}/enabled`, { enabled }),
  validatePayment: (platform, b) => request('POST', `/api/payment/config/${encodeURIComponent(platform)}/validate`, b),
  savePayment: (platform, b) => request('PUT', `/api/payment/config/${encodeURIComponent(platform)}`, b),
  clearPayment: (platform) => request('DELETE', `/api/payment/config/${encodeURIComponent(platform)}`),

  // WebDAV 服务（系统设置）
  webdav: () => request('GET', '/api/webdav'),
  setWebdavEnabled: (enabled) => request('PUT', '/api/webdav/enabled', { enabled }),
  addWebdavAccount: (b) => request('POST', '/api/webdav/accounts', b),
  updateWebdavAccount: (id, b) => request('PUT', `/api/webdav/accounts/${encodeURIComponent(id)}`, b),
  deleteWebdavAccount: (id) => request('DELETE', `/api/webdav/accounts/${encodeURIComponent(id)}`),
  revealWebdavPassword: (id) => request('GET', `/api/webdav/accounts/${encodeURIComponent(id)}/password`),

  storage: () => request('GET', '/api/stats/storage'),
  summary: () => request('GET', '/api/stats/summary'),
  speed: () => request('GET', '/api/stats/speed'),
  logs: (p) => request('GET', '/api/stats/logs?' + qs(p)),

  thumbUrl: (path) => '/api/fs/thumb?path=' + encodeURIComponent(path),
  downloadUrl: (path) => '/api/fs/download?path=' + encodeURIComponent(path),
};
