/** 应用入口 —— 全局状态、工具栏、状态栏、视图调度 */
import { API, setWriteObserver } from './api.js';
import { toast, fmtSize, openModal, openAgreementDialog, escapeHtml, confirmDialog, showQuotaDialog, banNotice, isStaffRole, roleLabel } from './util.js';
import { explorer } from './explorer.js';
import { filetype } from './filetype.js';
import { ops } from './ops.js';
import { uploadMgr } from './upload.js';
import { dashboard } from './dashboard.js';
import { settings } from './settings.js';
import { help } from './help.js';
import * as linkmgr from './linkmgr.js';
import * as ordermgr from './ordermgr.js';
import * as bucketmgr from './bucketmgr.js';
import * as syssettings from './syssettings.js';
import * as credmgr from './credmgr.js';
import * as ipmgr from './ipmgr.js';
import * as invitemgr from './invitemgr.js';
import * as couponmgr from './couponmgr.js';
import { verifyWindowsHello, webauthnSupported } from './webauthn.js';
import { providerMeta } from './provider-logos.js';
import { openProfileDialog } from './profile.js';
// R70：PWA（Service Worker 注册 / 「安装到桌面」入口）。刻意**不**在此处做任何 I/O ——
// 真正的监听与注册在 init() 里由 initPwa() 一次性挂上，模块加载期无副作用。
import * as pwa from './pwa.js';
// R8-04：加密访问令牌是**凭据**，登出时必须随会话一起丢弃（见 forceLogout）。
import { reset as resetEncSession } from './enc.js';

/* ------------------------------ SVG 图标 ------------------------------ */
const SVG = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M7 12h10M10 19h4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  viewList: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
  viewThumb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  viewLarge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/></svg>',
  viewSmall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="5" rx="1"/><rect x="11" y="5" width="6" height="5" rx="1"/><rect x="19" y="5" width="2" height="5" rx="1"/><rect x="3" y="14" width="6" height="5" rx="1"/><rect x="11" y="14" width="6" height="5" rx="1"/><rect x="19" y="14" width="2" height="5" rx="1"/></svg>',
  viewopt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  newfolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  // R52-03：「复制」（两张叠起来的纸）与「粘贴」（带夹子的剪贴板）
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  bucket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8l2 12a2 2 0 0 0 2 1.7h8A2 2 0 0 0 18 20l2-12"/><path d="M3 8h18"/><path d="M8 8a4 4 0 0 1 8 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/></svg>',
};
window.__SVG = SVG;

/* ------------------------------ 全局状态 ------------------------------ */

const LS_KEY = 's3mgr.prefs.v1';

/**
 * R49：界面偏好与「记住我」的历史存储键。
 *
 * 这两个键旧名是 `cosmgr.*`（COS 管理台时代的命名）。**改名不能只改字符串**：
 * localStorage 里的值是**用户本地状态**，直接换键读取等于把用户已经存好的
 * 偏好 / 用户名**静默丢掉**（表现为「升级后设置全变默认、用户名不再预填」）。
 * 所以留旧键做**兜底别名**，首次读到旧键就**当场搬到新键**再删旧键 —— 只迁一次，
 * 之后旧键不再存在。与 `COS_DATA_DIR` → `S3_DATA_DIR` 的处理口径一致。
 */
const LEGACY_LS_KEY = 'cosmgr.prefs.v1';

/**
 * 读 localStorage：新键优先；新键缺失时用旧键兜底，命中即**迁移**到新键。
 * 这是「新旧键并存」的**唯一实现点** —— 别处不得再拼 `cosmgr.*` 字面量。
 * @param {string} key 现用键
 * @param {string} legacyKey 历史键
 * @returns {string|null}
 */
function readMigrating(key, legacyKey) {
  try {
    const cur = localStorage.getItem(key);
    if (cur !== null) return cur;
    const old = localStorage.getItem(legacyKey);
    if (old === null) return null;
    localStorage.setItem(key, old);
    localStorage.removeItem(legacyKey);
    return old;
  } catch (e) { return null; }
}

function loadPrefs() {
  try { return JSON.parse(readMigrating(LS_KEY, LEGACY_LS_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs(extra) {
  try {
    // 从已存偏好起手再覆盖当前值：保留别处塞进来的未知键（`extra` 之外的字段）
    const p = Object.assign(loadPrefs(), {
      view: App.state.view,
      sort: App.state.sort,
      columns: App.state.columns,
      autoRefresh: App.state.autoRefresh,
      searchCurrentOnly: App.state.searchCurrentOnly,
    });
    localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(p, extra || {})));
  } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}

/**
 * 供 header 排序持久化（R49 从 `explorer.js` 搬来）。
 * 搬家的理由：`LS_KEY` 的**唯一实现点**在本文件，键名散落在两个模块里
 * 正是「改名漏一处」的成因（R49 已在 `LEGACY_ENV` 上踩过一次）。
 */
window.__savePrefs = () => savePrefs();

export const App = {
  state: {
    prefix: '',
    view: 'list',
    sort: { key: 'name', dir: 'asc' },
    columns: ['name', 'size', 'type', 'modified'],
    autoRefresh: 0, // 秒，0=手动
    selection: new Set(),
    history: [],
    historyIndex: -1,
    config: null,      // /api/config 安全视图
    buckets: [],       // 本地存储桶列表（含备注/配额）
    uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false }, // 上传排除设置
    // R48：同时上传 / 加密的文件数（来自 /api/config 的 concurrency.files）。
    // 初值 1（串行）而不是服务端默认的 3 —— 在 `/config` 到达之前，前端**读不到任何
    // 上限**，此时最保守的取值是「一次一个」。反过来（先按大值起跑、拿到配置再收窄）
    // 会让头几个文件真的打满浏览器连接池。
    uploadConcurrency: 1,
    bucket: '',
    bucketDisplay: '', // 外显名称（备注 || 桶名）
    region: '',
    quotaBytes: 0,     // 0 = 无限制
    storageInfo: null,
    searchActive: false,
    // 搜索范围：true = 仅当前目录（服务端 delimiter '/'），false = 递归子树。
    // 存 App.state 而非 window.__filter，是为了让「搜索框回车」与「筛选面板」
    // 两个入口**共用同一个判据** —— 各存一份就会出现"面板里勾了、回车却不生效"。
    searchCurrentOnly: false,
    // R44：「文件类型」侧栏筛选的当前值（'' = 全部）。由 filetype.js 写入、
    // explorer.js 读取（过滤规则只有 visibleItems() 一份）。
    typeFilter: '',
    statsSummary: null,
    enc: { mode: 'none', passwordSet: false }, // 文件加密设置摘要（下载/查看解锁判定用）
    // R47：当前停留的**主区块**（explorer / dashboard / … / credmgr）。与上面的
    // `view` 不是一回事 —— `view` 是文件列表的排版（list / thumbs / …）。
    // 本字段是「地址栏 hash」的内存镜像，唯一权威仍是 `location.hash`。
    mainView: 'explorer',
    user: null,        // 当前登录用户 { id, username, role }，null = 未登录
    authReady: false,  // 登录态探测完成标记
  },
  refresh() { return explorer.refresh(); },
  navigate(prefix, opts) {
    closeSidebar();
    return explorer.navigate(prefix, opts);
  },
  onConfigChanged() {
    loadConfig().then(() => {
      filetype.init();
      explorer.refresh();
    });
  },
  /**
   * R29-02：**只**重新拉取配置并刷新依赖它的界面（侧边栏桶列表 / 状态栏 / 读取 `App.state.config`
   * 的卡片，例如存储桶弹窗里的密钥下拉）。
   *
   * 与 `onConfigChanged()` 的分工：本函数不动文件列表与侧栏「文件类型」筛选 —— 供「只改了展示字段」的写操作
   * 使用（改密钥备注 / 可见性 / 自定义域名）；凡是可能改变**可浏览内容**的写操作（增删密钥、
   * 启停或删除存储桶、清空桶）都必须走 `onConfigChanged()`。
   *
   * 为什么需要它：设置类写操作此前只刷新自己那张卡片，而侧边栏、状态栏与其它卡片读的是
   * `App.state.config` 这份**快照** —— 于是「改完设置要按 F5 才正确」。这类缺口在
   * `credmgr` / `bucketmgr` 上各有若干处，统一收敛到这两个入口，避免再逐处漏。
   */
  reloadConfig() {
    storageCache = null; // 状态栏用量缓存随配置一起失效
    return loadConfig(false);
  },
  /**
   * R47：写操作后的**统一界面同步**（由 `api.js` 的写通知驱动，见 `setWriteObserver`）。
   *
   * 与上面两个入口的分工：`onConfigChanged()` / `reloadConfig()` 是**被各个调用点显式调用**
   * 的收尾刷新，只能覆盖「调用方记得调用」的场合；本入口挂在**唯一收口点**（`api.js` 的
   * `request()`）上，因此跨区块的陈旧数据不必再逐个调用点去补。
   */
  syncUi() { return syncNow(); },
  updateStatusbar: updateStatusbar,
};

/* ------------------------- R47：写操作后的统一同步 ------------------------- */

/** 去抖窗口：一次批量操作（如上传一批文件）会连发多条写请求，合并成一次同步。 */
const SYNC_DEBOUNCE_MS = 200;

let syncTimer = null;
let syncing = false;   // 正在同步
let syncPending = false; // 同步期间又发生了写操作 → 结束后再来一轮

/**
 * `api.js` 的写通知入口：某个写请求**成功**了（失败不会走到这里）。
 *
 * 职责只有一个 —— 把「有变化了」翻译成**一次**界面同步。用 200ms 去抖是因为批量操作
 * （上传 N 个文件 → N 条 `upload/complete`）会连发很多条；该延迟远小于人类对
 * 「立即生效」的感知阈值。
 */
function onServerWrite() {
  if (syncing) { syncPending = true; return; }
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);
}

/**
 * R47：真正执行一次同步 —— 后端配置快照 + 加密摘要 + **当前区块**自己的数据。
 *
 * 为什么是这三样：一次写操作能改变的东西无非三类 ——
 *  ① 后端配置（桶集合 / 配额 / 密钥 / 排除规则 …）。全站读的是 `App.state.config`
 *     这一份**快照**，所以必须重拉，否则侧边栏、状态栏、各卡片的读数是旧的；
 *  ② 加密摘要（下载 / 查看的门控判定）；
 *  ③ 当前区块里的列表。
 * 前两类每次同步；第三类**只刷当前显示的那个区块** —— 不为看不见的区块付请求代价，
 * 更不会跳到一个用户没在看的页面上重建 DOM。
 *
 * `syncing` 标志是**防自激**的关键：同步过程本身也要发请求，这个标志保证「同步期间
 * 发生的任何写请求」只被记录（`syncPending`）、不会被立刻再同步一次。
 */
async function syncNow() {
  if (syncing) { syncPending = true; return; }
  syncing = true;
  try {
    await loadConfig(false);
    loadEncState(); // 非 async：内部两个请求自带 catch，不需要等
    if (App.state.mainView === 'explorer') await explorer.refresh({ silent: true });
    else switchMainView(App.state.mainView, { syncHash: false });
  } catch (e) {
    /* 同步失败不影响业务结果：界面保持原样，用户下一次操作会再同步一次 */
  } finally {
    syncing = false;
    if (syncPending) { syncPending = false; onServerWrite(); }
  }
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  // 偏好恢复
  const prefs = loadPrefs();
  if (prefs.view) App.state.view = prefs.view;
  if (prefs.sort) App.state.sort = prefs.sort;
  if (Array.isArray(prefs.columns) && prefs.columns.length) App.state.columns = prefs.columns;
  if (prefs.autoRefresh !== undefined) App.state.autoRefresh = prefs.autoRefresh;
  // 恢复时不回写（prefs 刚读出来，写回去没有意义，还可能把别的字段覆盖成默认值）
  setSearchScope(!!prefs.searchCurrentOnly, { save: false });

  // 仅做 DOM 绑定，不触发任何需要鉴权的 API 请求
  injectIcons();
  bindToolbar();
  bindAuth();
  bindUserMenu();
  bindKeyboard();
  bindViewHash();
  // R47：写操作成功后自动同步界面（消除「必须刷新才看到生效结果」）
  setWriteObserver(onServerWrite);

  /**
   * R70：PWA。挂 `beforeinstallprompt` / `appinstalled` 监听 + 注册 Service Worker。
   *
   * 刻意**不等**它（无 await）：里面注册 SW 是个网络动作，而下面的主链路是登录态探测 ——
   * 让登录等一个离线缓存，是把增强能力排在核心功能前面。它内部全程 catch，
   * 失败也不会让 init() 连锁中断。
   */
  pwa.initPwa();

  /**
   * R54：站点名称 → 浏览器标题栏。
   *
   * 必须**在鉴权探测之前**拉：未登录时的登录页也要显示站点名称，
   * 而 `/api/site/info` 是公开接口（不需要会话）。失败静默 ——
   * 标题栏退回 `index.html` 里那句静态 `<title>`（与默认站点名同文）。
   */
  try {
    const info = await API.siteInfo();
    syssettings.applySiteName(info && info.siteName);
    // R54②：注册模式也来自这条公开接口 —— 登录页据此决定「注册账户」入口显不显示
    siteRegistration = (info && info.registration) || 'closed';
  } catch (e) { /* 拿不到就用静态标题，不影响登录；注册入口按最保守的"不显示"处理 */ }

  /**
   * R68：协议提示与协议正文（**公开接口**，同样必须在鉴权探测之前拉 —— 未登录的
   * 登录页就要显示它）。失败静默：提示整条不出现，登录流程照常。
   *
   * 刻意**不与 `/site/info` 合并成一次请求**：`/site/info` 的返回值有硬性约束
   * （`audit54` 断言它恰好只有 `ok` / `siteName` / `registration` 三个键 —— 匿名接口
   * 上「能少给就少给」），而协议正文可能有几万字，把两者绑在一起等于让每次启动
   * 都先下载一份协议。
   */
  try {
    agreementInfo = await API.agreementPublic();
  } catch (e) { agreementInfo = null; }

  // 先探测登录态
  const me = await checkAuth();
  App.state.authReady = true;

  if (!me) {
    // 未登录：显示登录遮罩，等待用户登录后再加载主界面
    showAuthOverlay();
    return;
  }

  // 已登录：初始化各模块并加载主界面
  await bootstrapApp();
}

/** 登录成功后加载主界面 */
async function bootstrapApp() {
  // 首次登录时初始化各模块（部分模块在 init 中会立即发 API 请求，必须在登录后执行）；
  // 重复登录（如会话过期后重新登录）不再重复绑定事件，避免监听器重复
  if (!App._bootstrapped) {
    explorer.init();
    filetype.init();
    uploadMgr.init();
    dashboard.init();
    help.init();
    settings.init();
    App._bootstrapped = true;
  }

  // R47：先记下地址栏想去的区块 —— `App.navigate()` 会把 hash 归一化回 explorer，
  // 所以必须在它**之前**读，否则永远恢复不出用户原来停留的页面。
  const startView = viewFromHash();
  await loadConfig(true);
  await App.navigate('', { push: false }); // 文件列表子树先建立（面包屑 / 状态栏都依赖它）
  // 再按地址栏把用户送回原来停留的页面（刷新 / 重开标签页不再一律回到文件浏览）
  if (startView !== 'explorer') switchMainView(startView);
  startAutoRefresh();
  refreshMiniStats();
  startStatsTimer(); // R7-09：内部自带「先停后启」，重新登录不会叠加出第二个定时器
  startSpeedPolling(); // 内部自带「先停后启」，重新登录不会叠加出第二个定时器
  checkBucketAcl(); // 启动时检测桶权限（不阻塞页面）
  loadEncState(); // 加密设置摘要（密码门控判定）
}

/* ------------------------------ 登录态 / 认证遮罩 ------------------------------ */

/**
 * 认证遮罩的四种形态（R54② 从两种扩到四种）：
 *   · `login`    输入用户名 + 密码登录
 *   · `init`     首次使用，创建**根用户**账户（R71 起）
 *   · `register` 注册新账户（仅当站点设置为「公开注册」时才给入口）
 *   · `forgot`   忘记密码 —— 两步：① 填「用户名或邮箱」发码 ② 填验证码 + 新密码
 */
let authMode = 'login';
/** `forgot` 模式当前处在第几步（1 = 要验证码，2 = 提交验证码与新密码） */
let forgotStep = 1;
/** 「忘记密码」第一步提交的标识，第二步原样带回 */
let forgotIdentifier = '';
/** R57：第二步「重新发送验证码」的剩余秒数（0 = 可重发）；离开忘记密码形态即归零 */
let resendLeft = 0;
/** 上面那个倒计时的定时器；同一时刻最多存在一个 */
let resendTimer = null;
/**
 * 站点设置里的注册模式（`open` / `invite` / `closed`），由启动时的公开接口填充。
 * 默认取最保守的 `closed`：拿不到配置时不摆一个点了必然失败的「注册」入口。
 */
let siteRegistration = 'closed';
/**
 * R69：首次初始化是否必须出示「安装令牌」。
 *
 * 由 `/auth/me` 的 `setupTokenRequired` 决定（服务端 = 部署模式且尚无用户）。
 * 默认 `false`：拿不到这个字段时按本机模式处理，不凭空多出一个必填框。
 */
let setupTokenRequired = false;

/**
 * R68：公开接口 `/api/site/agreements` 的返回值（三页提示 + 被引用到的协议正文）。
 *
 * 结构：`{ show: {login,register,share}, notices: {…html}, docs: {terms?,privacy?} }`。
 * 拿不到时保持 `null` —— 此时登录页只是不显示那句提示，其它一切照常
 *（协议提示不是登录的前置条件，更不能因为一个可选请求失败就把人挡在门外）。
 */
let agreementInfo = null;

/**
 * 把提示渲染进登录卡片（R68）。
 *
 * 「哪一页显示哪一句」完全由服务端下发的 `show` 决定，前端**不重新判断**
 * 「开关 + 有没有正文」这两件事 —— 那套判断只在 `server/agreement-view.js` 里有一份。
 * 前端一旦自己再算一遍，就会出现「服务端说不显示、前端却显示了半句」这类分叉。
 *
 * 三种形态下都显式复位：`init`（创建根用户）与 `forgot`（重置密码）不是需求里的
 * 「注册页 / 登录页」，因此一律不显示；只在 login / register 两种形态下按开关决定。
 */
function renderAuthAgreement() {
  const el = document.getElementById('auth-agreement');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  const info = agreementInfo;
  if (!info || !info.show) return;
  const page = authMode === 'login' ? 'login' : (authMode === 'register' ? 'register' : '');
  if (!page || !info.show[page]) return;
  const html = (info.notices && info.notices[page]) || '';
  if (!html) return;
  el.innerHTML = html; // 服务端渲染的可信 HTML（先整体转义再插入自带标签）
  el.hidden = false;
  el.querySelectorAll('a.ag-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      // 不跳锚点：登录页没有 `#ag-login-terms` 这个目标，跳了只会把卡片滚走
      e.preventDefault();
      openAgreementFromLink(a.dataset.doc);
    });
  });
}

/** 打开一份协议（`docKey` = `terms` / `privacy`） */
function openAgreementFromLink(docKey) {
  const key = docKey === 'privacy' ? 'privacy' : 'terms';
  const d = (agreementInfo && agreementInfo.docs && agreementInfo.docs[key]) || null;
  if (!d || !d.html) return; // 正文缺失：链接本来就不会被渲染成可点的（服务端保证）
  openAgreementDialog({
    title: d.title || (key === 'privacy' ? '隐私协议' : '用户协议'),
    html: `<div class="ag-doc">${d.html}</div>`,
  });
}

/**
 * 「记住用户名」的本机痕迹（R69）。
 *
 * ⚠️ 这里**只保存用户名**。R54② 曾把密码一起存进这条记录 —— 用一把同样躺在这条
 * 记录里的随机密钥做异或。异或是对合运算：能读到这条记录的人，用同一份代码一行
 * 就能还原明文，那层"混淆"的实际强度**等于明文存储**。而 localStorage 没有
 * HttpOnly、没有 SameSite、生命周期无限（XSS / 浏览器扩展 / 公用电脑 / 配置备份
 * 都能拿到）。真正让用户免于重复登录的是**服务端会话有效期**（勾选后 30 天），
 * 客户端存密码的边际价值抵不上这个代价，因此这条通道整条撤掉。
 *
 * 旧版本写下的记录里可能还带 `k` / `p`（密钥与密文）：`loadRemember` 读到就
 * **就地重写**成不含它们的形态 —— 升级不是"不再写入"就够，盘上已有的那份也必须消失。
 */
const REMEMBER_LS_KEY = 's3mgr.auth.v1';
/** R49：同上，历史键名做兜底别名（见 `LEGACY_LS_KEY` 的说明） */
const LEGACY_REMEMBER_LS_KEY = 'cosmgr.auth.v1';

/** 「记住用户名」的取值口径（集中在这里，避免散落的布尔判断各写一套语义） */
const REMEMBER_MODE = { NONE: 'none', USERNAME: 'username' };
/** R69：旧版本写进记录的密码模式值 —— 只用于把老记录识别成「记住用户名」 */
const LEGACY_REMEMBER_PASSWORD_MODE = 'password';

/**
 * 从本机痕迹里取回用户名与勾选状态。
 * 任何一步不对都返回空对象（宁可让用户手打，也不能抛错卡住登录页）。
 */
function loadRemember() {
  // R49：老键名（cosmgr.*）做只读迁移，避免升级后勾选状态凭空消失
  try {
    const saved = JSON.parse(readMigrating(REMEMBER_LS_KEY, LEGACY_REMEMBER_LS_KEY)) || {};
    const username = String(saved.username || '');
    const remember = saved.mode === REMEMBER_MODE.USERNAME || saved.mode === LEGACY_REMEMBER_PASSWORD_MODE;
    // R69：老记录（含 k/p）读到时立刻重写，把可还原的凭据从盘上抹掉
    if (saved.k !== undefined || saved.p !== undefined) {
      saveRemember(remember && username ? REMEMBER_MODE.USERNAME : REMEMBER_MODE.NONE, username);
    }
    return { mode: remember && username ? REMEMBER_MODE.USERNAME : REMEMBER_MODE.NONE, username };
  } catch (e) { return {}; }
}

/**
 * 保存 / 清除本机痕迹（**唯一实现点**）。
 * @param {'none'|'username'} mode 见 `REMEMBER_MODE`
 */
function saveRemember(mode, username) {
  try {
    if (mode !== REMEMBER_MODE.USERNAME || !username) { localStorage.removeItem(REMEMBER_LS_KEY); return; }
    localStorage.setItem(REMEMBER_LS_KEY, JSON.stringify({
      mode: REMEMBER_MODE.USERNAME,
      username: String(username || ''),
    }));
  } catch (e) { /* 隐私模式下不可用，忽略 */ }
}

/** 探测登录态，返回 user 对象或 null */
async function checkAuth() {
  try {
    const r = await API.authMe();
    if (r.user) {
      App.state.user = r.user;
      renderUserMenu();
      return r.user;
    }
    App.state.user = null;
    if (r.initialized === false) {
      authMode = 'init';
      // R69：部署模式下首次初始化必须出示「安装令牌」。
      // R72：令牌改为服务端**启动即生成**，且部署完成信息 / `kepler` 菜单都会显示它
      // —— 不再只有启动日志一处。
      setupTokenRequired = r.setupTokenRequired === true;
    } else {
      authMode = 'login';
      setupTokenRequired = false;
    }
    return null;
  } catch (e) {
    // 网络错误等：当作未登录
    App.state.user = null;
    authMode = 'login';
    return null;
  }
}

/** 按 `authMode` 渲染登录遮罩（四种形态的唯一渲染点） */
function showAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;
  overlay.hidden = false;

  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  const confirmItem = document.getElementById('auth-confirm-item');
  const confirmLabel = document.getElementById('auth-confirm-label');
  const codeItem = document.getElementById('auth-code-item');
  // R54③：邀请码输入框（只有「邀请码」注册模式下的注册形态才出现）
  const inviteItem = document.getElementById('auth-invite-item');
  // R69：安装令牌输入框（部署模式下首次初始化才出现）
  const setupItem = document.getElementById('auth-setup-item');
  const setupInput = document.getElementById('auth-setup');
  const submitBtn = document.getElementById('btn-auth-submit');
  const foot = document.getElementById('auth-foot');
  const errEl = document.getElementById('auth-error');
  const userLabel = document.getElementById('auth-username-label');
  const pwLabel = document.getElementById('auth-password-label');
  const userInput = document.getElementById('auth-username');
  const pwInput = document.getElementById('auth-password');
  errEl.hidden = true; errEl.textContent = '';

  const isInit = authMode === 'init';
  const isRegister = authMode === 'register';
  const isForgot = authMode === 'forgot';
  const rememberBox = document.getElementById('auth-remember');
  const rememberItem = document.getElementById('auth-remember-item');

  // 清空输入（密码/验证码始终清空；用户名在勾选过「记住用户名」时回填）
  const saved = loadRemember();
  if (rememberBox) rememberBox.checked = saved.mode === REMEMBER_MODE.USERNAME;
  // 创建根用户与注册时「记住用户名」没有意义（用户名是刚起的），忘记密码也不适用
  if (rememberItem) rememberItem.hidden = isInit || isRegister || isForgot;
  userInput.value = saved.mode === REMEMBER_MODE.USERNAME ? (saved.username || '') : '';
  // R69：密码**从不**回填 —— 本机不再保存任何形式的密码
  pwInput.value = '';
  document.getElementById('auth-confirm').value = '';
  document.getElementById('auth-code').value = '';
  document.getElementById('auth-invite').value = '';
  // 邀请码框默认整条隐藏，只有「注册 + 邀请码模式」那一个分支把它打开
  if (inviteItem) inviteItem.hidden = true;
  // 安装令牌同理：只有「部署模式 + 首次初始化」才要求填写（本机回环不受影响）
  if (setupItem) setupItem.hidden = !(isInit && setupTokenRequired);
  if (setupInput) setupInput.value = '';

  // 三个入口整条换掉，不留"上一个模式"的残影
  document.getElementById('auth-forgot-link').hidden = !(authMode === 'login');
  /**
   * 注册入口在「公开注册」与「邀请码」两种模式下都出现（R54③ 起）——
   * 两种模式**都能注册成功**，只是后者要多填一个邀请码。
   * 只有「关闭注册」时才整条隐藏：摆一个点了必然失败的链接是误导。
   */
  document.getElementById('auth-register-link').hidden =
    !(authMode === 'login' && (siteRegistration === 'open' || siteRegistration === 'invite'));
  document.getElementById('auth-back-login').hidden = authMode === 'login';

  /**
   * R57：标识输入框的**提示词必须与它上面的 label 同步**。
   *
   * `forgot` 形态的 label 是「用户名或邮箱」，而 `index.html` 里的 placeholder 写死成
   * 「请输入用户名」—— 两处语义不一致，用户会以为这里只收用户名，明明绑过邮箱也不敢填。
   * 四种形态里只有 `forgot` 的 label 不同，故只在这一个三元里分叉（一处真相）。
   */
  userInput.placeholder = isForgot ? '请输入用户名或已绑定的邮箱' : '请输入用户名';

  if (isInit) {
    /**
     * R71 起这一页建的是**根用户**，不是管理员 —— 界面必须照实说。
     *
     * 继续把这一页写成「管理员」的后果不是措辞不准，而是**误导用户对权限的预期**：
     * 他会以为自己只是个管理员，随后发现可以删掉别的管理员，或反过来在某个界面上
     * 找不到「为什么我不能改那个人」的解释。角色名是这三层权限唯一的对外口径。
     */
    title.textContent = '创建根用户账户';
    sub.textContent = '首次使用，请创建根用户账户以初始化系统';
    userLabel.textContent = '用户名';
    pwLabel.textContent = '密码';
    confirmLabel.textContent = '确认密码';
    confirmItem.hidden = false;
    codeItem.hidden = true;
    submitBtn.textContent = '创建并登录';
    foot.textContent = '根用户拥有最高权限：可管理包括其他管理员在内的所有账户；管理员仅能管理普通用户';
  } else if (isRegister) {
    // R54③：本站为「邀请码」模式时，注册必须填邀请码 —— 输入框与说明一起切换，
    // 否则用户会填完用户名密码才从服务端那里知道还差一个码
    const needInvite = siteRegistration === 'invite';
    title.textContent = '注册账户';
    sub.textContent = needInvite
      ? '本站在「邀请码」模式下注册，请填写管理员提供的邀请码'
      : '填写用户名与密码即可创建账户；邮箱可在登录后于「编辑资料」中补填';
    userLabel.textContent = '用户名';
    pwLabel.textContent = '密码';
    confirmLabel.textContent = '确认密码';
    confirmItem.hidden = false;
    codeItem.hidden = true;
    if (inviteItem) inviteItem.hidden = !needInvite;
    submitBtn.textContent = '注 册';
    foot.textContent = needInvite
      ? '邀请码上的「注册后的身份」由管理员在生成时设定；账户创建后将直接登录'
      : '账户创建后将直接登录';
  } else if (isForgot) {
    title.textContent = '重置密码';
    userLabel.textContent = '用户名或邮箱';
    if (forgotStep === 1) {
      sub.textContent = '填写账户的用户名或已绑定的邮箱，我们会把验证码发到该邮箱';
      userInput.disabled = false;
      pwLabel.textContent = '密码';
      confirmItem.hidden = true;
      codeItem.hidden = true;
      // 第一步只填标识：密码框藏起来，免得用户以为现在就要改密码
      document.getElementById('auth-password').closest('.form-item').hidden = true;
      document.getElementById('auth-password').value = '';
      submitBtn.textContent = '发送验证码';
      foot.textContent = '收不到邮件时请检查垃圾邮件箱，或联系管理员';
    } else {
      sub.textContent = `验证码已发送（如果该账户已绑定邮箱）。请查收邮件并填写验证码与新密码`;
      // 标识在第一步已确认，第二步只读展示（避免用户改了标识却以为码作废）
      userInput.value = forgotIdentifier;
      userInput.disabled = true;
      document.getElementById('auth-password').closest('.form-item').hidden = false;
      pwLabel.textContent = '新密码';
      confirmLabel.textContent = '确认新密码';
      confirmItem.hidden = false;
      codeItem.hidden = false;
      submitBtn.textContent = '重置密码';
      foot.textContent = '验证码 10 分钟内有效，重置后原有登录状态会全部失效';
    }
  } else {
    title.textContent = '登录';
    sub.textContent = '请输入账户凭据以继续';
    userLabel.textContent = '用户名';
    pwLabel.textContent = '密码';
    confirmLabel.textContent = '确认密码';
    userInput.disabled = false;
    document.getElementById('auth-password').closest('.form-item').hidden = false;
    confirmItem.hidden = true;
    codeItem.hidden = true;
    submitBtn.textContent = '登 录';
    foot.textContent = '';
  }

  // 人机验证：服务端开启时渲染组件并加载对应脚本；关闭时零改动
  setupAuthCaptcha();
  // R57：第二步那颗「重新发送验证码」的文案/可用性由 `resendLeft` 推出来 —— 重绘后必须重新渲染一次，
  // 否则它会被 HTML 的初始文案"复原"，用户就能在冷却期内连点（服务端会拒，界面先骗了他一次）。
  renderResendBtn();
  // R68：协议提示（登录 / 注册两种形态各自受站点设置里的开关控制）
  renderAuthAgreement();

  setTimeout(() => {
    // 忘记密码第二步：焦点落在验证码框（第一步已填的标识不必再点）
    if (isForgot && forgotStep === 2) {
      const code = document.getElementById('auth-code');
      if (code) code.focus();
      return;
    }
    // 用户名已回填（或第二步只读）时直接聚焦密码框，少一次 Tab
    if (userInput && !userInput.disabled && userInput.value) pwInput.focus();
    else if (userInput && !userInput.disabled) userInput.focus();
    else pwInput.focus();
  }, 100);
}

/** 切到另一个认证形态并重绘 */
function setAuthMode(mode) {
  authMode = mode;
  // 离开忘记密码形态时把它的全部临时状态清干净：步号、标识、**以及重发倒计时**
  // （不清的话定时器会在别的形态下继续空转，再进来时按钮上还会挂着上一次的剩余秒数）
  if (mode !== 'forgot') {
    forgotStep = 1;
    forgotIdentifier = '';
    resendLeft = 0;
    stopResendCountdown();
  }
  showAuthOverlay();
}

function hideAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.hidden = true;
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

/* ------------------------------ 登录人机验证（CAPTCHA） ------------------------------ */
/* 服务端开启验证码时才渲染组件并加载脚本；关闭时本区块零行为，登录流程与原逻辑完全一致。 */

const captchaState = { provider: '', widgetId: null, token: '', active: false };

/**
 * 验证码脚本地址 —— 必须与 `server/index.js` 的 CSP `script-src` 严格同源。
 *
 * CSP 的 host-source 是**精确匹配**：`recaptcha.net` 不匹配 `www.recaptcha.net`。
 * 曾因这里写无 www、CSP 写有 www，导致脚本被 CSP 拦截、组件永不 load，
 * 而 `captchaState.active` 已被置真 → 每次点登录都只回「请先完成人机验证」，
 * 全站账号无法登录（R14-02）。`tests/invariants.test.js` 对此做静态护栏。
 */
const CAPTCHA_SCRIPTS = {
  // reCAPTCHA 固定走 www.recaptcha.net（避免 google.com 不可达），显式渲染模式
  recaptcha: 'https://www.recaptcha.net/recaptcha/api.js?onload=__s3CaptchaReady&render=explicit',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__s3CaptchaReady&render=explicit',
};

function captchaMsg(text) {
  const el = document.getElementById('auth-captcha-msg');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = text;
  el.hidden = false;
}

function loadCaptchaScript(provider) {
  return new Promise((resolve, reject) => {
    const id = 'captcha-script-' + provider;
    let s = document.getElementById(id);
    if (s) {
      if (s.dataset.loaded === '1') return resolve();
      s.addEventListener('load', () => resolve(), { once: true });
      s.addEventListener('error', () => reject(new Error('captcha script error')), { once: true });
      return;
    }
    s = document.createElement('script');
    s.id = id;
    s.src = CAPTCHA_SCRIPTS[provider] || CAPTCHA_SCRIPTS.recaptcha;
    s.async = true;
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
    s.addEventListener('error', () => reject(new Error('captcha script error')), { once: true });
    document.head.appendChild(s);
  });
}

// 脚本 onload 挂钩（render=explicit 模式需要；实际渲染在 setupAuthCaptcha 中完成）
window.__s3CaptchaReady = () => {};

/** 拉取验证码配置并渲染组件（登录 / 注册两种形态；未启用时保证零页面改动） */
async function setupAuthCaptcha() {
  const box = document.getElementById('auth-captcha');
  if (!box) return;
  box.hidden = true; box.innerHTML = '';
  captchaMsg('');
  captchaState.active = false; captchaState.token = ''; captchaState.widgetId = null; captchaState.provider = '';
  // 注册与登录是同一道门（服务端两处都回源校验），组件要一起渲染
  if (authMode !== 'login' && authMode !== 'register') return;

  let cfg;
  try { cfg = await API.captchaPublic(); } catch (e) { return; }
  if (!cfg || !cfg.available || !cfg.siteKey) return;

  captchaState.active = true;
  captchaState.provider = cfg.provider;
  box.hidden = false;
  captchaMsg('正在加载人机验证组件…');

  const holder = document.createElement('div');
  holder.className = 'captcha-holder';
  box.appendChild(holder);

  try {
    await loadCaptchaScript(cfg.provider);
    if (cfg.provider === 'turnstile') {
      if (!window.turnstile) throw new Error('turnstile not ready');
      captchaState.widgetId = window.turnstile.render(holder, {
        sitekey: cfg.siteKey,
        callback: (t) => { captchaState.token = t || ''; captchaMsg(''); },
        'expired-callback': () => { captchaState.token = ''; },
        'error-callback': () => { captchaState.token = ''; captchaMsg('人机验证组件出错，请刷新页面重试'); },
      });
    } else {
      if (!window.grecaptcha) throw new Error('grecaptcha not ready');
      await new Promise((resolve) => window.grecaptcha.ready(resolve));
      captchaState.widgetId = window.grecaptcha.render(holder, {
        sitekey: cfg.siteKey,
        callback: (t) => { captchaState.token = t || ''; captchaMsg(''); },
        'expired-callback': () => { captchaState.token = ''; },
      });
    }
    captchaMsg('');
  } catch (e) {
    captchaState.token = '';
    // 不要只说「网络可能受限」：真实成因也可能是验证码配置本身不可用（R14-02），
    // 而管理员此时已经登不进来，提示必须给出**他能在系统设置里执行的出路**。
    captchaMsg('人机验证组件加载失败，暂时无法登录。请让管理员在「系统设置 → 登录人机验证」中关闭验证码或改用其它服务商后重试。');
  }
}

/** 登录失败后重置验证码组件（token 一次性，需重新验证） */
function resetAuthCaptcha() {
  captchaState.token = '';
  if (captchaState.widgetId === null) return;
  try {
    if (captchaState.provider === 'turnstile' && window.turnstile) window.turnstile.reset(captchaState.widgetId);
    else if (window.grecaptcha) window.grecaptcha.reset(captchaState.widgetId);
  } catch (e) { /* ignore */ }
}

function bindAuth() {
  const submit = document.getElementById('btn-auth-submit');
  if (!submit) return;
  submit.onclick = doAuthSubmit;
  // 回车提交（含「忘记密码」第二步的验证码框）
  ['auth-username', 'auth-password', 'auth-confirm', 'auth-code', 'auth-invite'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuthSubmit(); });
  });
  // R54②：三个入口。都直接赋值 onclick（遮罩常驻、只切 hidden，避免监听器叠加）
  const link = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  link('auth-register-link', () => setAuthMode('register'));
  link('auth-back-login', () => setAuthMode('login'));
  link('auth-forgot-link', () => {
    forgotStep = 1; forgotIdentifier = '';
    // R57：重发倒计时也一起归零 —— 这里就是"从头开始一次忘记密码"的入口
    resendLeft = 0; stopResendCountdown();
    setAuthMode('forgot');
  });
  // R57：第二步的「重新发送验证码」（与上面三个入口同款：直接赋 onclick，避免监听器叠加）
  link('btn-auth-resend', resendForgotCode);
}

/** 当前形态下提交按钮的文案（重绘与"请求收尾还原"共用一处，避免两边写岔） */
function authSubmitLabel() {
  if (authMode === 'init') return '创建并登录';
  if (authMode === 'register') return '注 册';
  if (authMode === 'forgot') return forgotStep === 1 ? '发送验证码' : '重置密码';
  return '登 录';
}

/* ------------------ R57：忘记密码第二步的「重新发送验证码」 ------------------ */

/**
 * 那颗按钮的文案与可用性（**唯一渲染点**）。
 *
 * 倒计时每秒调它一次、遮罩每次重绘也调它一次。两处各写一遍是很自然的错误，
 * 而后果不对称：重绘若把按钮"复原"成可点，用户就能在两封信的 60 秒冷却里连点
 * （服务端会拒，但界面先骗了他一次）。
 */
function renderResendBtn() {
  const btn = document.getElementById('btn-auth-resend');
  if (!btn) return;
  const waiting = resendLeft > 0;
  btn.disabled = waiting;
  btn.textContent = waiting ? `${resendLeft} 秒后可重新发送` : '重新发送验证码';
}

/** 停掉倒计时：离开忘记密码形态、以及重新开始倒计时之前都要先叫停 */
function stopResendCountdown() {
  if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
}

/**
 * 开始重发倒计时（秒数由调用点给出，不在这里写死）。
 *
 * 秒数交给调用点是为了让「与哪个窗口对齐」这件事留在调用点上显形 ——
 * 服务端的冷却窗口（`EMAIL_CODE_RESEND_MS` / 429 的 `Retry-After`）将来若变，
 * 改的是调用点，这个函数不必动。
 */
function startResendCountdown(seconds) {
  stopResendCountdown();
  const n = Math.floor(Number(seconds));
  resendLeft = Number.isFinite(n) && n > 0 ? n : 60;
  renderResendBtn();
  resendTimer = setInterval(() => {
    resendLeft -= 1;
    if (resendLeft <= 0) { resendLeft = 0; stopResendCountdown(); }
    renderResendBtn();
  }, 1000);
}

/**
 * 重发验证码：与第一步走**同一条**接口（`/auth/forgot`）。
 *
 * 刻意不复用 `submitForgotAsk()`：那条路径的职责是"推进到第二步"，
 * 而这里已经站在第二步上，再推一次只会把已填的验证码与新密码清空。
 */
async function resendForgotCode() {
  const btn = document.getElementById('btn-auth-resend');
  if (!btn || btn.disabled) return;
  if (!forgotIdentifier) { showAuthError('请先填写用户名或已绑定的邮箱'); return; }
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    await API.forgotPassword({ identifier: forgotIdentifier });
    showAuthError('');
    startResendCountdown(60);
  } catch (e) {
    showAuthError(e.message || '发送失败');
    /**
     * 失败**不进倒计时** —— 否则用户会被自己那次失败的结论锁住 60 秒。
     * 唯一的例外是服务端 429（IP 限流）自带 `Retry-After`：那个窗口是真的，
     * 照它倒计时才不会让用户在倒计时结束后立刻再点、再被拒一次。
     */
    if (e && e.retryAfter) startResendCountdown(e.retryAfter);
    else { resendLeft = 0; stopResendCountdown(); renderResendBtn(); }
  }
}

/** 忘记密码第一步：把验证码发到该账户已绑定的邮箱 */
async function submitForgotAsk(identifier, btn) {
  if (!identifier) { showAuthError('请输入用户名或已绑定的邮箱'); return; }
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    /**
     * 服务端对「账户是否存在」是**恒真响应**（防枚举），因此这里拿到成功
     * 只能说明"请求被受理了"，不能说明"这个账户真的发了信" ——
     * 第二步的文案也就刻意写成"如果该账户已绑定邮箱"。
     */
    await API.forgotPassword({ identifier });
    forgotIdentifier = identifier;
    forgotStep = 2;
    /**
     * R57：进入第二步即开始 60 秒倒计时（与服务端 `EMAIL_CODE_RESEND_MS` 对齐）——
     * 刚发出去的那封信，本来就不该马上再发一封。
     * 必须在 `showAuthOverlay()` **之前**启动：重绘时那颗按钮的文案由 `resendLeft` 推出来。
     */
    startResendCountdown(60);
    showAuthOverlay(); // 重绘到第二步（会清空输入并把焦点放到验证码框）
  } catch (e) {
    showAuthError(e.message || '发送失败');
  } finally {
    btn.disabled = false;
    if (authMode === 'forgot' && forgotStep === 1) btn.textContent = authSubmitLabel();
  }
}

/** 忘记密码第二步：凭验证码设置新密码 */
async function submitForgotReset({ identifier, code, password, confirm }, btn) {
  if (!code) { showAuthError('请输入邮件里的 6 位验证码'); return; }
  if (!password) { showAuthError('请输入新密码'); return; }
  if (password !== confirm) { showAuthError('两次输入的密码不一致'); return; }
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    await API.resetPassword({ identifier, code, password, confirmPassword: confirm });
    /**
     * 本机保存的旧密码此刻已经失效 —— 必须一起清掉，否则下次打开登录页会
     * 自动填上一个**必然错误**的密码，用户只会看到"用户名或密码错误"而无从下手。
     * 必须在 `setAuthMode('login')` **之前**清，否则重绘会先把旧密码填回去。
     */
    saveRemember(REMEMBER_MODE.NONE);
    toast('密码已重置，请使用新密码登录', { type: 'success', duration: 5000 });
    forgotStep = 1;
    setAuthMode('login');
    const u = document.getElementById('auth-username');
    // 用邮箱找回的就别回填到"用户名"框里（会被当成用户名提交）
    if (u) u.value = identifier.includes('@') ? '' : identifier;
    const p = document.getElementById('auth-password');
    if (p) p.focus();
  } catch (e) {
    showAuthError(e.message || '重置失败');
    btn.disabled = false;
    btn.textContent = authSubmitLabel();
  }
}

/**
 * R64：分享页「登录」入口带回的跳转目标。
 *
 * 分享页右上角的「登录」是一条 `/?next=%2Fs%2F<id>` 链接 —— 登录成功后应当
 * 回到那条分享链接，而不是把用户丢进管理端首页（他不一定是管理员，可能只是
 * 想回来看自己买过的东西）。
 *
 * 判据刻意**只放行 `/s/<id>` 这一个形状**：
 *  · 不做「同源相对路径」这种宽口径 —— `?next=` 是 URL 参数，若允许任意路径，
 *    它就是一个可被外部链接利用的开放重定向（钓鱼者发一条 `/?next=/api/...`）；
 *  · 拒绝 `//evil.com`、`/\evil.com`、绝对 URL —— 正则的首字符就钉死了单个 `/`。
 *
 * 非法 / 缺失时返回空串，调用方按原逻辑留在管理端。
 */
function takeShareNext() {
  let raw = '';
  try {
    raw = new URLSearchParams(location.search).get('next') || '';
  } catch (e) { return ''; }
  return /^\/s\/[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : '';
}

async function doAuthSubmit() {
  const submitBtn = document.getElementById('btn-auth-submit');
  const rememberBox = document.getElementById('auth-remember');
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const confirm = document.getElementById('auth-confirm').value;
  const code = document.getElementById('auth-code').value.trim();

  // 「忘记密码」是两步流程，各自只收自己需要的输入
  if (authMode === 'forgot') {
    if (forgotStep === 1) return submitForgotAsk(username, submitBtn);
    return submitForgotReset({ identifier: forgotIdentifier, code, password, confirm }, submitBtn);
  }

  const isRegister = authMode === 'register';
  if (!username) { showAuthError('请输入用户名'); return; }
  if (!password) { showAuthError('请输入密码'); return; }
  if ((authMode === 'init' || isRegister) && password !== confirm) {
    showAuthError('两次输入的密码不一致');
    return;
  }
  /**
   * R54③：邀请码模式的注册必须先填码。
   *
   * 这里只做「非空」这一档（给用户一个即时反馈），**不在前端校验格式** ——
   * 码的格式判据只有服务端 `limits.parseInviteCodeInput` 一份，
   * 前端再抄一遍必然分叉（改了一位长度就会变成「前端放行、服务端拒」）。
   * 反正格式错也是一次往返的事，而多一份判据的代价是永久的。
   */
  const inviteCode = document.getElementById('auth-invite').value.trim();
  if (isRegister && siteRegistration === 'invite' && !inviteCode) {
    showAuthError('请输入邀请码');
    return;
  }
  // R69：部署模式下首次初始化必须填安装令牌（非空只做前端即时反馈，真判据在服务端）
  const setupTokenEl = document.getElementById('auth-setup');
  const setupToken = setupTokenEl ? setupTokenEl.value.trim() : '';
  if (authMode === 'init' && setupTokenRequired && !setupToken) {
    /**
     * R72 起这串令牌不再只能翻启动日志 —— 部署完成的信息里会直接打印，
     * `kepler` 管理菜单顶部也会显示。只写「见启动日志」会让人去翻一个
     * 未必有权限看的地方（Docker / systemd 的日志对不少部署者并不顺手）。
     */
    showAuthError('请输入安装令牌（部署完成信息或 kepler 菜单里有，也可看服务器数据目录下的 setup-token.txt）');
    return;
  }
  // 人机验证：开启时必须已完成校验（token 由组件回调产出，服务端会回源复核）
  if (captchaState.active && !captchaState.token) {
    showAuthError('请先完成人机验证');
    return;
  }

  const remember = Boolean(rememberBox && rememberBox.checked && authMode === 'login');
  submitBtn.disabled = true;
  submitBtn.textContent = authMode === 'init' ? '创建中…' : (isRegister ? '注册中…' : '登录中…');
  try {
    let r;
    if (authMode === 'init') {
      r = await API.initAdmin(Object.assign({ username, password, confirmPassword: confirm },
        setupToken ? { setupToken } : null));
    } else if (isRegister) {
      r = await API.register({
        username, password, confirmPassword: confirm,
        captchaToken: captchaState.token || undefined,
        // 邀请码模式下必填；公开注册时**不传**（服务端在 open 模式下不看这个字段，
        // 但传一个空串会让「谁填过」这件事在日志里变得含糊）
        inviteCode: inviteCode || undefined,
      });
    } else {
      r = await API.login(username, password, captchaState.token, remember);

      // 登录第二步：该账户启用了 Windows Hello，需先通过本机验证才签发会话。
      // 自动唤起 Windows Hello（无需用户再点一次按钮）。
      if (r && r.webauthnRequired) {
        if (!webauthnSupported()) {
          showAuthError('该账户已启用 Windows Hello，但当前浏览器不支持；请改用受支持的浏览器，或联系管理员关闭该验证');
          resetAuthCaptcha();
          return;
        }
        submitBtn.textContent = '等待 Windows Hello…';
        showAuthError(''); // 清空错误提示，准备唤起
        try {
          r = await verifyWindowsHello(API, r);
        } catch (we) {
          showAuthError(we.message || 'Windows Hello 验证失败');
          resetAuthCaptcha(); // 挑战一次性，失败后需重新走第一步
          return;
        }
      }
    }
    if (r && r.user) {
      App.state.user = r.user;
      /**
       * 「记住用户名」的落点只有**登录**这一条路径：注册与初始化时那个复选框是隐藏的，
       * 此刻去写它只会把用户原先记着的用户名清掉（而他并没有表达过这个意思）。
       */
      if (authMode === 'login') {
        saveRemember(remember ? REMEMBER_MODE.USERNAME : REMEMBER_MODE.NONE, username);
      }
      // 登录成功即把主视图重置到 explorer：换账号（尤其管理员→普通用户）时，
      // 上一个会话停留的区块必须作废，不能让新账号看到旧账号渲染的内容。
      resetMainView();
      renderUserMenu();
      hideAuthOverlay();
      /**
       * R64：从分享页的「登录」链接过来时，登录成功即回到那条分享链接。
       * 放在 `bootstrapApp()` **之前** —— 立刻离开，不必先拉一遍管理端数据。
       */
      const back = authMode === 'login' ? takeShareNext() : '';
      if (back) { location.replace(back); return; }
      await bootstrapApp();
      const who = r.user.username;
      // R71：这一支建的是根用户 —— 说成「管理员」会让用户误判自己能管到哪一层
      toast(authMode === 'init' ? '根用户账户创建成功，欢迎使用'
        : (isRegister ? `注册成功，欢迎使用，${who}` : `欢迎回来，${who}`), { type: 'success' });
    }
  } catch (e) {
    // R33：封禁是「凭据正确但无权进入」，与「用户名或密码错误」不是一回事，
    // 提示必须分开 —— 否则被封用户只会看到一句让人反复重试密码的误导信息。
    showAuthError(e && e.banned ? banNotice(e) : (e.message || '登录失败'));
    resetAuthCaptcha(); // token 一次性使用，失败后需重新验证
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authSubmitLabel();
  }
}

/** 强制退出并回到登录界面（全局 401 时调用） */
function forceLogout(reason) {
  App.state.user = null;
  App.state.authReady = false;
  // 停止定时器，防止在未登录状态下继续轮询 API
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  stopSpeedPolling(); // PERF-03：否则登出后仍每 2 秒请求一次 /api/stats/speed（401）
  stopStatsTimer(); // R7-09：否则登出后仍每 60 秒请求一次 /api/stats/summary（401）
  App.state.config = null;
  App.state.bucket = '';
  // 清空跨会话残留的界面状态：主视图回到 explorer、关闭浮层。
  // 否则下一个登录的账号会直接看到上一个账号停留的区块（越权显示）。
  resetMainView();
  // 让各模块丢弃上一账号的渲染缓存，下次进入时强制重新拉取
  syssettings.reset();
  // R8-04：加密访问令牌是凭据（30 分钟有效），不随登出丢弃的话，
  // 同一浏览器里下一个账号点密文文件会被 ensureUnlocked() 直接放行。
  resetEncSession();
  App.state.enc = { mode: 'none', passwordSet: false }; // 下一账号登录时由 loadEncState() 重新拉取
  // R8-18：上传队列含上一账号的完整对象键，且在途 XHR 会带失效会话继续打服务端
  uploadMgr.reset();
  renderUserMenu(); // 隐藏用户菜单
  // 隐藏主视图，避免显示残留内容
  const overlay = document.getElementById('auth-overlay');
  authMode = 'login';
  // R54②：把「忘记密码」的两步状态也一并复位 —— 否则下次被踢下线时
  // 遮罩会停在"已验证码、等着填新密码"的半截状态
  forgotStep = 1;
  forgotIdentifier = '';
  showAuthOverlay();
  if (reason) toast(reason, { type: 'warn', duration: 4000 });
}
App.forceLogout = forceLogout;

/* ------------------------------ 右上角用户菜单 ------------------------------ */

function renderUserMenu() {
  const wrap = document.getElementById('user-menu-wrap');
  const nameEl = document.getElementById('user-name');
  const headEl = document.getElementById('um-head');
  const usersItem = document.getElementById('um-users');
  const sep = document.getElementById('um-sep');
  const menu = document.getElementById('user-menu');
  const user = App.state.user;

  if (!user) {
    if (wrap) wrap.hidden = true;
    if (menu) menu.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  if (nameEl) nameEl.textContent = user.username;
  if (headEl) headEl.textContent = `${user.username}（${roleLabel(user.role)}）`;

  // 「编辑资料」对所有角色可见（普通用户改自己资料的唯一入口）；
  // 「用户管理」仅管理员可见。显式双向赋值，避免上一会话的 hidden 状态残留。
  const isAdmin = isStaffRole(user.role);
  const profileItem = document.getElementById('um-profile');
  if (profileItem) profileItem.hidden = false;
  if (usersItem) usersItem.hidden = !isAdmin;
  if (sep) sep.hidden = !isAdmin;

  /**
   * R70：「安装到桌面」的显隐**在这里统一刷**，与「用户管理」同款理由 ——
   * `beforeinstallprompt` 可能在本函数跑之前就到达（比如二次访问时浏览器更快），
   * 也可能在之后到达（`onInstallStateChange` 会再刷一次）。两处都调同一个
   * `pwa.syncInstallItem()`，保证换账号 / 重新登录后不会残留上一会话的状态。
   */
  pwa.syncInstallItem();

  // SEC-07：操作日志（详情含用户名 / 客户端 IP / 对象键 / 桶名）仅管理员可见。
  // 在**角色权威渲染点**统一赋值，避免仅绑定一次导致换账号后残留。
  const sideLogs = document.getElementById('side-logs');
  if (sideLogs) sideLogs.hidden = !isAdmin;

  // 订单管理接口为管理员专属，普通用户整条入口不展示（与"不发请求"同效）
  const sideOrders = document.getElementById('side-orders');
  if (sideOrders) sideOrders.hidden = !isAdmin;

  // R54③ 邀请码设置：`GET /invites` 会**原样回传邀请码明文**（管理员要复制分发，
  // 打码会让页面失去意义），因此入口与整个页面一律只对管理员可见。
  // 与 ipmgr 同款：页面若已被切到，也在这里按角色关掉，普通用户看不到任何一枚码。
  const sideInvite = document.getElementById('side-invite');
  if (sideInvite) sideInvite.hidden = !isAdmin;
  const invitePage = document.getElementById('invitemgr');
  if (invitePage && !isAdmin) invitePage.hidden = true;

  // R62 优惠券设置：`GET /coupons` 会原样回传券码明文（管理员要复制分发），
  // 且券码能直接抵扣金额 —— 入口与整个页面一律只对管理员可见。
  const sideCoupon = document.getElementById('side-coupon');
  if (sideCoupon) sideCoupon.hidden = !isAdmin;
  const couponPage = document.getElementById('couponmgr');
  if (couponPage && !isAdmin) couponPage.hidden = true;

  // IP 地址管理（含「IP 访问屏蔽」+「IP 地址限速」两张卡）：规则详情含其它用户的
  // 来源 IP，增删改与预检全部为管理员专属 —— 侧栏入口与整个页面一并隐藏。
  // 普通用户既看不到入口，也进不去页面；ipmgr 会据此跳过规则列表请求，避免无谓 403。
  const sideIpmgr = document.getElementById('side-ipmgr');
  if (sideIpmgr) sideIpmgr.hidden = !isAdmin;
  const ipmgrPage = document.getElementById('ipmgr');
  if (ipmgrPage && !isAdmin) ipmgrPage.hidden = true;
  // 卡片自身也按角色赋值：页面一旦被误切到，普通用户仍看不到规则表。
  const ipCard = document.getElementById('ipguard-card');
  if (ipCard) ipCard.hidden = !isAdmin;
  const ipSpeedCard = document.getElementById('ipspeed-card');
  if (ipSpeedCard) ipSpeedCard.hidden = !isAdmin;
  // R65：订单取回封禁（第三张卡片）—— 封禁列表含他人来源 IP，同样仅管理员可见
  const ipRestoreCard = document.getElementById('iprestore-card');
  if (ipRestoreCard) ipRestoreCard.hidden = !isAdmin;

  // 自定义请求域名：保存走 PUT /api/config（管理员专属），且是全局生效的共享设置。
  // 普通用户整卡隐藏；credmgr 据此跳过域名回填。
  const domainCard = document.getElementById('credmgr-domain-card');
  if (domainCard) domainCard.hidden = !isAdmin;

  // 添加存储桶：桶名与地域普通用户无从得知，云端桶列表也不对其开放（SEC-11），
  // 桶集合改由管理员用「存储桶可见性权限」开放 —— 两处入口对普通用户一律隐藏。
  for (const id of ['btn-bucket-add', 'btn-buckets-add']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !isAdmin;
  }

  if (menu) menu.hidden = true;
}

function bindUserMenu() {
  const btn = document.getElementById('btn-user-menu');
  const menu = document.getElementById('user-menu');
  if (!btn || !menu) return;

  let closeTimer = null;

  function openMenu() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    menu.hidden = false;
  }
  function closeMenu() {
    menu.hidden = true;
  }
  function scheduleClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closeMenu, 200);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  btn.addEventListener('mouseenter', openMenu);
  btn.addEventListener('mouseleave', scheduleClose);
  menu.addEventListener('mouseenter', openMenu);
  menu.addEventListener('mouseleave', scheduleClose);

  // 点击外部关闭
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
      closeMenu();
    }
  });

  // 菜单项
  const profileItem = document.getElementById('um-profile');
  if (profileItem) {
    profileItem.onclick = () => {
      closeMenu();
      openProfileDialog();
    };
  }
  const usersItem = document.getElementById('um-users');
  if (usersItem) {
    usersItem.onclick = () => {
      closeMenu();
      switchMainView('systemsettings');
    };
  }
  const logoutItem = document.getElementById('um-logout');
  if (logoutItem) {
    logoutItem.onclick = async () => {
      closeMenu();
      try { await API.logout(); } catch (e) { /* 忽略网络错误，仍强制登出 */ }
      forceLogout('已退出登录');
    };
  }

  /**
   * R70：「安装到桌面」。
   *
   * 点击必须**直接**调 `pwa.promptInstall()`（不要包 `setTimeout` / `.then`）：
   * 浏览器要求 prompt() 处在用户手势的调用栈里，一旦被推迟到微任务之后，
   * Chrome 会静默拒绝，表现就是「点了没反应」。
   *
   * 用户选了「取消」不报错 —— 那是正常结果，不是失败。
   */
  const installItem = document.getElementById('um-install');
  if (installItem) {
    installItem.onclick = async () => {
      closeMenu();
      const result = await pwa.promptInstall();
      if (result === 'accepted') toast('已开始安装，请稍候…');
      // dismissed / unavailable：什么都不说。用户主动取消时再弹一句「已取消」
      // 是在替用户解释他自己的操作，反而打断。
    };
  }

  // 可安装状态变化（beforeinstallprompt / appinstalled / 退出独立窗口）时重刷菜单项
  pwa.onInstallStateChange(() => pwa.syncInstallItem());
}

/** 加密设置摘要（含查看密码是否设置），设置变更事件后刷新 */
function loadEncState() {
  // R8-14：`passwordSet` 对**所有角色**都必须真实 —— 前端 `ensureUnlocked()` 靠它决定
  // 是否弹出「加密访问密码」验证框。旧实现把非管理员硬编码为「未设密码」，
  // 于是普通用户即使在管理员处拿到了查看密码也**无处输入**，点下载必然 401，
  // 而服务端专门给出的 needUnlock 文案被整段丢弃。
  // `/enc/status` 只回 passwordSet（不含 mode / 魔数），任意登录用户可读。
  API.encStatus().then((s) => {
    App.state.enc = { mode: 'none', passwordSet: !!s.passwordSet };
  }).catch(() => { /* 服务不可用时保持默认（不拦截） */ });

  // `mode` 属安全配置（会暴露"用什么算法/魔数"），仅管理员需要，仅管理员可读；
  // 它不参与下载门控，取不到也不影响行为。
  if (!isStaffRole(App.state.user && App.state.user.role)) return;
  API.encSettings().then((s) => {
    App.state.enc = { mode: s.mode, passwordSet: !!s.passwordSet };
  }).catch(() => { /* 保持 encStatus 给出的 passwordSet */ });
}
window.addEventListener('enc-settings-changed', () => loadEncState());

async function loadConfig(first) {
  try {
    const cfg = await API.getConfig();
    App.state.config = cfg;
    App.state.uploadExcludes = cfg.uploadExcludes || { dsStore: false, thumbsDb: false, gitignore: false };
    // R48：读取「线程并发」（同时上传 / 加密的文件数）。随 `/config` 下发 ⇒ 普通用户
    // 也能拿到；保存设置后 R47 的写操作同步会重新拉一次配置，各端会话随即跟上。
    App.state.uploadConcurrency = (cfg.concurrency && cfg.concurrency.files) || 1;
    App.state.quotaBytes = cfg.quotaBytes || 0;
    App.state.buckets = cfg.buckets || [];
    App.state.bucket = cfg.bucket || '';
    App.state.region = cfg.region || '';
    App.state.bucketDisplay = cfg.bucketRemark || cfg.bucket || '';
    if (cfg.corrupted) {
      toast('本地加密配置校验失败（可能被篡改或损坏），请重新配置密钥', { type: 'error', duration: 8000 });
    } else if (first && !cfg.configured) {
      // 仅管理员在首次未配置时引导配置；普通用户提示联系管理员（共享密钥，无需自行绑定）
      const isAdmin = isStaffRole(App.state.user && App.state.user.role);
      if (isAdmin) {
        settings.open();
        toast('欢迎使用对象存储管理系统，请先完成访问密钥配置', { type: 'info', duration: 6000 });
      } else {
        toast('尚未配置访问密钥，请联系管理员配置后重试', { type: 'warn', duration: 8000 });
      }
    }
    renderBucketList();
    updateStatusbar();
    window.dispatchEvent(new CustomEvent('buckets-changed'));
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

/* ------------------------- 存储桶管理（侧边栏） ------------------------- */

function renderBucketList() {
  const ul = document.getElementById('bucket-list');
  const cfg = App.state.config;
  const buckets = App.state.buckets || [];
  const activeId = cfg ? cfg.activeBucketId : '';
  const isAdmin = isStaffRole(App.state.user && App.state.user.role);
  if (!buckets.length) {
    // 普通用户不再自行添加桶：可见桶由管理员开放，一个都没有时只能联系管理员
    const tip = isAdmin
      ? (cfg && cfg.configured ? '尚未添加存储桶，点击此处或上方 + 添加' : '请先在“设置”中配置访问密钥')
      : '管理员尚未为你开放任何存储桶，请联系管理员在「存储桶可见性权限」中开放';
    const canAdd = isAdmin && cfg && cfg.configured;
    ul.innerHTML = `<li class="bucket-empty ${canAdd ? 'clickable' : ''}">${tip}</li>`;
    if (canAdd) ul.querySelector('.bucket-empty').onclick = () => openBucketDialog(null);
    return;
  }
  ul.innerHTML = buckets.map((b) => {
    const display = b.remark || b.bucket;
    const sub = b.remark ? `${b.bucket} · ${b.region}` : b.region;
    return `<li class="bucket-item ${b.id === activeId ? 'active' : ''}" data-id="${escapeHtml(b.id)}" title="${escapeHtml(b.bucket)}（${escapeHtml(b.region)}）">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="bk-ic"><path d="M4 8l2 12a2 2 0 0 0 2 1.7h8A2 2 0 0 0 18 20l2-12"/><path d="M3 8h18"/><path d="M8 8a4 4 0 0 1 8 0"/></svg>
      <span class="bk-text"><b>${escapeHtml(display)}</b><i>${escapeHtml(sub)}</i></span>
      <span class="bk-acts">
        <button class="icon-btn small bk-edit" data-id="${escapeHtml(b.id)}" title="编辑备注 / 配额">${SVG.edit}</button>
        ${isAdmin ? `<button class="icon-btn small bk-del" data-id="${escapeHtml(b.id)}" title="将存储桶从列表中移除">${SVG.close}</button>` : ''}
      </span>
    </li>`;
  }).join('');
  ul.querySelectorAll('.bucket-item').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest('.bk-acts')) return;
      selectBucket(li.dataset.id);
    };
  });
  ul.querySelectorAll('.bk-edit').forEach((btn) => {
    btn.onclick = () => {
      const b = buckets.find((x) => x.id === btn.dataset.id);
      if (b) openBucketDialog(b);
    };
  });
  ul.querySelectorAll('.bk-del').forEach((btn) => {
    btn.onclick = () => removeBucket(btn.dataset.id);
  });
}

async function selectBucket(id) {
  const cfg = App.state.config;
  if (cfg && cfg.activeBucketId === id) return;
  try {
    await API.activateBucket(id);
    const b = (App.state.buckets || []).find((x) => x.id === id);
    storageCache = null;
    await loadConfig(false);
    App.navigate('', { push: false });
    filetype.init();
    toast('已切换到存储桶 ' + (b ? (b.remark || b.bucket) : ''), { type: 'success' });
  } catch (e) {
    toast('切换存储桶失败：' + e.message, { type: 'error' });
  }
}

async function removeBucket(id) {
  const b = (App.state.buckets || []).find((x) => x.id === id);
  const name = b ? (b.remark || b.bucket) : '';
  const ok = await confirmDialog({ allowHtml: true,
    title: '移除存储桶',
    message: `确定将存储桶 <b>${escapeHtml(name)}</b> 从本地列表移除吗？<br><span style="color:var(--text-2)"></span>`,
    okText: '移除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteBucket(id);
    toast('已从本地移除存储桶 ' + name, { type: 'success' });
    storageCache = null;
    await loadConfig(false);
    App.navigate('', { push: false });
    filetype.init();
  } catch (e) {
    toast('移除失败：' + e.message, { type: 'error' });
  }
}

/** 添加 / 编辑存储桶弹窗（管理员添加时可从云端拉取桶列表，须先选择访问密钥） */
function openBucketDialog(existing) {
  const isEdit = Boolean(existing);
  // 管理员专属字段的单一判据。服务端对非管理员走字段白名单，`credentialId` 与
  // `visibleToUsers` 一律丢弃（SEC-01）；而「从云端获取桶列表」用的是
  // POST /config/verify（仅管理员，SEC-11）—— 两件事普通用户都做不了主。
  // 与其留一堆勾了也没用 / 点了就 403 的控件，不如整项不渲染。
  const isAdminUser = isStaffRole(App.state.user && App.state.user.role);
  // 候选密钥：已绑定（本地已存）且未停用；未配置任何密钥时无法拉取云端列表
  const allCreds = (App.state.config && App.state.config.credentials) || [];
  const usableCreds = allCreds.filter((c) => c.enabled !== false);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-msg" id="bk-msg"></div>
    ${isEdit || !isAdminUser ? '' : `<div class="form-item">
      <label>访问密钥<span class="req">*</span></label>
      <select id="bk-cred">
        <option value="">— 选择访问密钥 —</option>
        ${usableCreds.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.remark || c.secretIdMasked || c.id)}（${escapeHtml(c.providerName || '')}）</option>`).join('')}
      </select>
      <div class="hint">选择一个已启用且未停用的密钥，用于从云端拉取桶列表与后续访问。</div>
    </div>`}
    <div class="form-item">
      <label>存储桶名称<span class="req">*</span></label>
      <input type="text" id="bk-name" placeholder="请输入云端已存在的存储桶名称" value="${isEdit ? escapeHtml(existing.bucket) : ''}" ${isEdit ? 'disabled' : ''}>
    </div>
    ${isEdit || !isAdminUser ? '' : `<div class="form-item">
      <button class="mini-btn" id="bk-load-cloud">从云端获取桶列表并选择</button>
      <select id="bk-cloud-pick" style="margin-left:8px;height:28px;width:52%;display:none"></select>
    </div>`}
    <div class="form-row">
      <div class="form-item">
        <label>地域（Region）<span class="req" id="bk-region-req">*</span></label>
        <input type="text" id="bk-region" placeholder="例如 ap-guangzhou" value="${isEdit ? escapeHtml(existing.region) : ''}">
        <div class="hint" id="bk-region-hint"></div>
      </div>
      <div class="form-item">
        <label>备注名（可选）</label>
        <input type="text" id="bk-remark" placeholder="填写后外显为备注名" value="${isEdit ? escapeHtml(existing.remark || '') : ''}">
      </div>
    </div>
    ${isAdminUser ? `<div class="form-item">
      <label>容量配额（GB）</label>
      <input type="number" id="bk-quota" min="0" step="1" value="${isEdit ? ((existing.quotaBytes || 0) / 1024 ** 3) : 0}">
      <div class="hint"><b> · 容量配额功能仅用于防止存储量过高，填 0 则无限制。为安全起见，修改回源设置、跨域设置、修改访问权限等操作需前往服务商控制台，本程序不提供此类功能</b>。</div>
    </div>` : `<div class="form-item">
      <label>容量配额</label>
      <div class="hint">当前上限：${isEdit && existing.quotaBytes ? fmtSize(existing.quotaBytes) : '无限制'}（<b>仅管理员可修改</b> —— 它是服务端强制的写入上限）</div>
    </div>`}
    ${isAdminUser ? `<div class="form-item">
      <label class="check-line"><input type="checkbox" id="bk-visible" ${isEdit ? (existing.visibleToUsers === false ? '' : 'checked') : 'checked'}>   对普通用户可见</label>
      <div class="hint">取消勾选后，该存储桶仅管理员可见；普通用户登录后不会看到此桶。</div>
    </div>` : ''}`;

  const msg = (text, cls) => {
    const m = wrap.querySelector('#bk-msg');
    m.textContent = text;
    m.className = 'form-msg show ' + cls;
  };

  // 密钥切换：地域提示与占位符随所选密钥的服务商变化
  const credSel = wrap.querySelector('#bk-cred');
  const regionHint = wrap.querySelector('#bk-region-hint');
  const regionReq = wrap.querySelector('#bk-region-req');
  /**
   * 当前应当生效的服务商 id。
   *
   * 取值顺序与存储桶**服务端**的绑定解析一致（`addBucket` 的 SEC-01 判据）：
   * 编辑时以该桶自身声明的 provider 为准 → 表单里选中的密钥所属厂商
   * → 全局当前活跃服务商 → 默认厂商。
   * 区域栏的「必填」判据与提示文案都以此为准，否则会出现
   * 「界面按腾讯云要求必填、服务端按 MinIO 允许留空」的口径分叉。
   */
  function effectiveProviderId() {
    if (existing && existing.provider) return existing.provider;
    const picked = credSel ? usableCreds.find((c) => c.id === credSel.value) : null;
    return (picked && picked.provider)
      || (App.state.config && App.state.config.provider)
      || 'tencent';
  }
  const regionInputEl = wrap.querySelector('#bk-region');
  function syncCredentialHints() {
    const prov = providerMeta(effectiveProviderId());
    // 地域是否必填由厂商元数据决定（又拍云 / GCS / R2 / MinIO 允许留空，
    // 服务端会补上厂商默认地域）。这里同步星号与文案，避免「留空就一定拦」。
    if (regionReq) regionReq.hidden = prov.regionRequired === false;
    if (regionHint) regionHint.textContent = prov.regionHint || '';
    if (regionInputEl) regionInputEl.placeholder = prov.regionPlaceholder || '请输入地域';
  }
  if (credSel) credSel.onchange = syncCredentialHints;
  syncCredentialHints();

  const loadBtn = wrap.querySelector('#bk-load-cloud');
  if (loadBtn) {
    loadBtn.onclick = async () => {
      if (!usableCreds.length) {
        return msg('暂无可用密钥，请先在「密钥管理」中添加并启用', 'bad');
      }
      const credId = credSel ? credSel.value : '';
      if (!credId) return msg('请先选择访问密钥', 'bad');
      try {
        msg('正在从云端获取…', 'info');
        const r = await API.verifyConfig({ credentialId: credId });
        if (!r.ok) return msg(r.error, 'bad');
        const sel = wrap.querySelector('#bk-cloud-pick');
        sel.style.display = '';
        sel.innerHTML = '<option value="">— 选择存储桶 —</option>' + (r.buckets || []).map((x) => `<option value="${escapeHtml(x.name)}|${escapeHtml(x.region)}">${escapeHtml(x.name)}（${escapeHtml(x.region)}）</option>`).join('');
        sel.onchange = () => {
          const [n, rg] = sel.value.split('|');
          if (n) { wrap.querySelector('#bk-name').value = n; wrap.querySelector('#bk-region').value = rg; }
        };
        msg(`获取成功，共 ${(r.buckets || []).length} 个存储桶`, 'ok');
      } catch (e) {
        msg(e.message, 'bad');
      }
    };
  }

  openModal({
    title: isEdit ? '编辑存储桶' : '添加存储桶', body: wrap,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      {
        text: isEdit ? '保存' : '添加', cls: 'primary', onClick: async (o, close) => {
          const region = wrap.querySelector('#bk-region').value.trim();
          const remark = wrap.querySelector('#bk-remark').value.trim();
          /**
           * R28-02：配额输入框只对管理员渲染（它现在是服务端**强制**的写入上限，
           * 允许被约束者自行调大等于自带解除按钮）。非管理员这里取不到元素，
           * 因此必须判空，且**不把 `quotaBytes` 放进提交体**（服务端也会丢弃该字段）。
           */
          const quotaEl = wrap.querySelector('#bk-quota');
          const quotaGB = quotaEl ? (Number(quotaEl.value) || 0) : 0;
          const quotaPatch = quotaEl ? { quotaBytes: Math.round(quotaGB * 1024 ** 3) } : {};
          // 非管理员没有渲染该项（服务端也会丢弃该字段），提交时按「可见」处理
          const visibleEl = wrap.querySelector('#bk-visible');
          const visibleToUsers = visibleEl ? visibleEl.checked : true;
          if (quotaEl && quotaGB < 0) return msg('配额不能为负数，0 表示无限制', 'bad');
          try {
            if (isEdit) {
              await API.updateBucket(existing.id, Object.assign({ region, remark, visibleToUsers }, quotaPatch));
            } else {
              const bucket = wrap.querySelector('#bk-name').value.trim();
              if (!bucket) return msg('请填写存储桶名称', 'bad');
              // 地域是否必填按**服务商**判定（又拍云 / GCS / R2 / MinIO 允许留空，
              // 服务端会补厂商默认地域）；与服务端 POST /buckets/local 的闸门同源。
              const needRegion = providerMeta(effectiveProviderId()).regionRequired !== false;
              if (needRegion && !region) return msg('请填写地域（Region）', 'bad');
              // 绑定用户选择的密钥（未选择时留空，回退为使用当前密钥）
              const credId = credSel ? credSel.value : '';
              await API.addBucket({ bucket, region, remark, quotaBytes: Math.round(quotaGB * 1024 ** 3), visibleToUsers, credentialId: credId || undefined });
            }
            close();
            toast(isEdit ? '存储桶信息已更新' : '存储桶已添加', { type: 'success' });
            storageCache = null;
            await loadConfig(false);
            if (!isEdit) {
              App.navigate('', { push: false });
              filetype.init();
              checkBucketAcl(); // 新增桶后立即检测其权限状态
            }
          } catch (e) {
            // R25：超出 API Key 配额 → 弹专用对话框（含已用 / 上限 / 待写明细）；
            // 其余错误仍就地显示在表单里（配额提示的措辞与出路与上传路径完全一致）
            if (!showQuotaDialog(e)) msg(e.message, 'bad');
          }
        },
      },
    ],
  });
}
App.openBucketDialog = openBucketDialog;

/* ------------------------- 存储桶权限安全提醒 ------------------------- */

const ACL_LABEL = { 'public-read': '公有读私有写', 'public-read-write': '公有读写' };

/** 检查本地绑定桶的 ACL，发现公开访问时弹警告（用户已选"不再提醒"则跳过） */
async function checkBucketAcl() {
  // SEC-07：该接口为管理员专属（会遍历全部桶并返回桶名/地域/备注）。
  // 普通用户直接不发请求 —— 避免"必然 403"的无用调用与信息面暴露。
  if (!isStaffRole(App.state.user && App.state.user.role)) return;
  try {
    const r = await API.aclCheck();
    if (r.disabled) return;
    const pubs = r.publicBuckets || [];
    if (!pubs.length) return; // 空桶列表 / 全部私有 / 仅查询失败：不打扰
    openAclWarning(pubs, (r.buckets || []).filter((b) => b.acl === 'unknown'));
  } catch (e) { /* 检查整体失败时静默，不影响页面使用 */ }
}

function openAclWarning(publics, unknowns) {
  const wrap = document.createElement('div');
  const hasWrite = publics.some((b) => b.acl === 'public-read-write');
  wrap.innerHTML = `
    <div class="acl-warn-text">检测到 <b>${publics.length}</b> 个存储桶处于<b>公开访问</b>状态。</div>
    <table class="acl-warn-table">
      <thead><tr><th>存储桶</th><th>地域</th><th>当前权限</th></tr></thead>
      <tbody>${publics.map((b) => `<tr>
        <td title="${escapeHtml(b.bucket)}">${escapeHtml(b.remark || b.bucket)}${b.remark ? `<i class="bk-sub">（${escapeHtml(b.bucket)}）</i>` : ''}</td>
        <td>${escapeHtml(b.region)}</td>
        <td><span class="lk-badge bad">${ACL_LABEL[b.acl] || b.acl}</span></td>
      </tr>`).join('')}</tbody>
    </table>
    ${unknowns && unknowns.length ? `<div class="hint" style="margin-top:10px">另有 ${unknowns.length} 个存储桶权限查询失败（${escapeHtml(unknowns.map((u) => u.remark || u.bucket).join('、'))}），未能确认其权限状态，请前往控制台自行核实。</div>` : ''}
    <div class="hint" style="margin-top:10px">点击「不再提醒」将永久关闭本提醒。</div>`;
  openModal({
    title: '⚠️ 存储桶权限安全警告', body: wrap,
    foot: [
      { text: '不再提醒', onClick: async (o, close) => {
        try {
          await API.setAclReminder(true);
          toast('已永久关闭存储桶权限安全提醒', { type: 'success' });
        } catch (e) {
          toast('关闭提醒失败：' + e.message, { type: 'error' });
          return;
        }
        close();
      } },
      { text: '关闭', cls: 'primary' },
    ],
  });
}

/* ------------------------------ 工具栏 ------------------------------ */

function injectIcons() {
  const set = (id, svg, label) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = svg + (label ? `<span>${label}</span>` : '');
  };
  set('btn-back', SVG.back); set('btn-fwd', SVG.fwd); set('btn-up', SVG.up);
  set('btn-refresh', SVG.refresh); set('btn-menu', SVG.menu);
  set('search-icon', SVG.search); set('btn-filter', SVG.filter); set('btn-search-clear', SVG.close);
  set('btn-viewopt', SVG.viewopt);
  set('btn-syssettings', SVG.gear, '系统设置');
  set('btn-bucket-add', SVG.plus, '');
  set('btn-bucket-refresh', SVG.refresh);
  set('btn-drawer-close', SVG.close);
  // 操作按钮
  set('op-newfolder', SVG.newfolder); set('op-upload', SVG.upload); set('op-download', SVG.download);
  set('op-rename', SVG.rename); set('op-move', SVG.move); set('op-copylink', SVG.link); set('op-delete', SVG.del);
  set('op-copy', SVG.copy); set('op-paste', SVG.paste);
  // 视图切换
  const vs = { list: SVG.viewList, thumbs: SVG.viewThumb, large: SVG.viewLarge, small: SVG.viewSmall };
  document.querySelectorAll('#view-switch button').forEach((b) => { b.innerHTML = vs[b.dataset.view] || ''; b.classList.toggle('active', b.dataset.view === App.state.view); });
  // 上传按钮下拉（文件/文件夹）
  const upBtn = document.getElementById('op-upload');
  upBtn.onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showDropdownMenu(r.left, r.bottom + 4, [
      { text: '上传文件', onClick: () => document.getElementById('file-input').click() },
      { text: '上传文件夹', onClick: () => document.getElementById('folder-input').click() },
    ]);
  };
}

function showDropdownMenu(x, y, items) {
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.map((it, i) => `<div class="mi" data-i="${i}">${it.text}</div>`).join('');
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, innerHeight - items.length * 36 - 12) + 'px';
  menu.querySelectorAll('.mi').forEach((el) => {
    el.onclick = () => { menu.hidden = true; items[Number(el.dataset.i)].onClick(); };
  });
  setTimeout(() => document.addEventListener('mousedown', hideMenuOnce), 0);
  function hideMenuOnce(e) {
    if (!menu.contains(e.target)) menu.hidden = true;
    document.removeEventListener('mousedown', hideMenuOnce);
  }
}
window.__dropdown = showDropdownMenu;

function bindToolbar() {
  const $ = (id) => document.getElementById(id);
  $('btn-back').onclick = () => explorer.historyGo(-1);
  $('btn-fwd').onclick = () => explorer.historyGo(1);
  $('btn-up').onclick = () => {
    const p = App.state.prefix;
    if (!p) return;
    const parent = p.slice(0, -1).includes('/') ? p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1) : '';
    App.navigate(parent);
  };
  $('btn-refresh').onclick = () => { explorer.refresh(); loadConfig(false); };
  $('btn-menu').onclick = () => toggleSidebar();
  $('sidebar-mask').onclick = () => closeSidebar();

  // 面包屑点击（在 explorer 中渲染）
  // 视图切换
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.onclick = () => {
      App.state.view = b.dataset.view;
      document.querySelectorAll('#view-switch button').forEach((x) => x.classList.toggle('active', x === b));
      savePrefs();
      explorer.render();
    };
  });
  $('btn-viewopt').onclick = () => openViewOptions();
  $('btn-syssettings').onclick = () => switchMainView('systemsettings');
  $('side-buckets').onclick = () => { switchMainView('bucketmgr'); closeSidebar(); };
  $('side-links').onclick = () => { switchMainView('linkmgr'); closeSidebar(); };
  $('side-orders').onclick = () => { switchMainView('ordermgr'); closeSidebar(); };
  $('side-ipmgr').onclick = () => { switchMainView('ipmgr'); closeSidebar(); };
  $('side-dashboard').onclick = () => { switchMainView('dashboard'); closeSidebar(); };
  $('side-logs').onclick = () => { switchMainView('dashboard'); dashboard.showLogs(); closeSidebar(); };
  // R54③：邀请码设置（管理员专属；入口在 renderUserMenu() 里按角色隐藏）
  $('side-invite').onclick = () => { switchMainView('invitemgr'); closeSidebar(); };
  // R62：优惠券设置（管理员专属；入口在 renderUserMenu() 里按角色隐藏）
  $('side-coupon').onclick = () => { switchMainView('couponmgr'); closeSidebar(); };
  $('side-settings').onclick = () => { switchMainView('credmgr'); closeSidebar(); };
  $('side-help').onclick = () => { help.open(); closeSidebar(); };

  // 搜索
  const searchInput = $('search-input');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) explorer.search();
    if (e.key === 'Escape') explorer.exitSearch();
  });
  $('btn-filter').onclick = () => openFilterPanel();
  $('btn-search-clear').onclick = () => explorer.exitSearch();
  $('btn-exit-search').onclick = () => explorer.exitSearch();
  $('search-input').oninput = function () {
    $('btn-search-clear').hidden = !this.value;
  };

  // 操作按钮
  $('op-newfolder').onclick = () => ops.newFolder();
  $('op-download').onclick = () => ops.downloadSelected();
  $('op-rename').onclick = () => ops.renameSelected();
  $('op-move').onclick = () => ops.moveSelected();
  $('op-copy').onclick = () => ops.copySelected();
  $('op-paste').onclick = () => ops.paste();
  $('op-copylink').onclick = () => ops.copyLinkSelected();
  $('op-delete').onclick = () => ops.deleteSelected();
  $('op-selectall').onclick = () => explorer.selectAll();
  $('btn-bucket-add').onclick = () => {
    if (!App.state.config || !App.state.config.configured) {
      const isAdmin = isStaffRole(App.state.user && App.state.user.role);
      if (isAdmin) {
        toast('请先在“密钥管理”中配置访问密钥', { type: 'warn' });
        settings.open();
      } else {
        toast('尚未配置访问密钥，请联系管理员配置', { type: 'warn' });
      }
      return;
    }
    openBucketDialog(null);
  };
  $('btn-bucket-refresh').onclick = () => loadConfig(false);

  // 上传抽屉
  $('status-uploads').onclick = () => toggleUploadDrawer();
  $('btn-drawer-close').onclick = () => toggleUploadDrawer(false);
  $('btn-clear-finished').onclick = () => uploadMgr.clearFinished();
  $('file-input').onchange = function () { uploadMgr.enqueue(this.files, App.state.prefix); this.value = ''; };
  $('folder-input').onchange = function () { uploadMgr.enqueue(this.files, App.state.prefix, true); this.value = ''; };

  updateNavButtons();
}

function toggleSidebar(force) {
  const sb = document.getElementById('sidebar');
  const mask = document.getElementById('sidebar-mask');
  const open = force !== undefined ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  mask.hidden = !open;
}
function closeSidebar() { toggleSidebar(false); }

const MAIN_VIEWS = ['explorer', 'dashboard', 'linkmgr', 'ordermgr', 'ipmgr', 'bucketmgr', 'systemsettings', 'invitemgr', 'couponmgr', 'credmgr'];

/**
 * 侧栏 / 工具栏里每个区块的**入口元素**。`null` = 无专门入口（explorer 是默认落点）。
 *
 * 用它做角色判定，是为了让「地址栏能不能进某个区块」由**唯一权威渲染点**决定：
 * `renderUserMenu()` 负责写 `entry.hidden`（管理员专属的 `side-orders` / `side-ipmgr`
 * 等在普通用户下为 hidden），这里只读它的结果。若在此另写一份角色名单，
 * 「地址栏仍能进管理页」这类越权缺口就会悄悄出现。
 */
const VIEW_ENTRY = {
  explorer: null,
  dashboard: 'side-dashboard',
  linkmgr: 'side-links',
  ordermgr: 'side-orders',
  ipmgr: 'side-ipmgr',
  bucketmgr: 'side-buckets',
  systemsettings: 'btn-syssettings',
  // R54③：邀请码设置的管理员专属入口 —— 登记在册才能被门控挡下（`viewFromHash()` 读它的 hidden）
  invitemgr: 'side-invite',
  // R62：优惠券设置 —— 同样是管理员专属，登记在册才能被门控挡下
  couponmgr: 'side-coupon',
  credmgr: 'side-settings',
};

/**
 * R47：把当前区块写回地址栏（`#dashboard` 之类），刷新页面即可回到同一页。
 *
 * 用 `history.replaceState` 而**不是** `location.hash = ...`，两个理由：
 *  ① 不产生历史记录 —— 否则浏览器「后退」会在区块间跳，而本项目的 ← → 已用于
 *     **文件浏览**的前进后退（`explorer.historyGo`），两套历史会互相打架；
 *  ② 不派发 `hashchange` —— 否则自己写一次 hash 又绕回 `switchMainView()`，
 *     变成一次多余的重复刷新。
 * 默认落点 `explorer` 对应**无 hash** 的干净地址，避免地址栏里挂一个 `#explorer`。
 */
function writeViewHash(v) {
  if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
  const target = v === 'explorer' ? location.pathname + location.search : '#' + v;
  try { window.history.replaceState(null, '', target); } catch (e) { /* 特殊协议下可能抛错，忽略 */ }
}

/**
 * 从地址栏 hash 解析出**当前角色确实可以进入**的主区块；不可信的一律回落到 `explorer`。
 *
 * 两层判定：① 必须在 `MAIN_VIEWS` 白名单内（hash 是用户可任意编辑的输入，不能当 id 用）；
 * ② 该区块的入口元素必须存在且未被隐藏 —— 即 `renderUserMenu()`（角色权威点）放行了它。
 * 这样即便地址栏被手工改成 `#ordermgr`，普通用户也只会落到文件浏览，不会看到越权界面。
 */
function viewFromHash() {
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  if (!raw || !MAIN_VIEWS.includes(raw)) return 'explorer';
  const entryId = VIEW_ENTRY[raw];
  if (entryId) {
    const el = document.getElementById(entryId);
    if (!el || el.hidden) return 'explorer';
  }
  return raw;
}

function switchMainView(v, { syncHash = true } = {}) {
  App.state.mainView = v; // R47：内存镜像，供 App.syncUi() 判断该刷新哪个区块
  for (const id of MAIN_VIEWS) {
    const el = document.getElementById(id);
    if (el) el.hidden = v !== id;
  }
  if (v === 'dashboard') dashboard.refresh();
  else if (v === 'linkmgr') linkmgr.refresh();
  else if (v === 'ordermgr') ordermgr.refresh();
  else if (v === 'ipmgr') ipmgr.refresh();
  else if (v === 'bucketmgr') bucketmgr.refresh();
  else if (v === 'systemsettings') syssettings.refresh();
  else if (v === 'invitemgr') invitemgr.refresh();
  else if (v === 'couponmgr') couponmgr.refresh();
  else if (v === 'credmgr') credmgr.refresh();
  else updateStatusbar();
  if (v !== 'bucketmgr') bucketmgr.stop(); // 离开管理页时停止统计轮询
  if (syncHash) writeViewHash(v);
}
App.switchMainView = switchMainView;
App.backToExplorer = () => switchMainView('explorer');

/**
 * R47：地址栏是「当前区块」的唯一权威 —— 手工改 hash 也能落到对应区块。
 * 自己的写入走 `replaceState`，不会触发本监听（见 `writeViewHash`），故不成环。
 */
function bindViewHash() {
  window.addEventListener('hashchange', () => {
    // 登录遮罩期与「各区块尚未建立」的启动早期一律不响应：前者没有会话，
    // 后者会对着还不存在的视图切换 —— 启动时的落点由 bootstrapApp() 显式恢复。
    if (!App._bootstrapped || !App.state.user) return;
    const want = viewFromHash();
    if (want !== App.state.mainView) switchMainView(want, { syncHash: false });
  });
}

/**
 * 重置主视图到文件浏览（explorer）。
 *
 * **必须在登出与登录成功两个时点调用。** 否则上一个会话停留的非 explorer 区块
 * （如 #systemsettings）会保持可见：`App.navigate()` 只重写 explorer 子树，不会隐藏
 * 其它 section，于是换账号后用户直接看到上一个会话渲染的界面 —— 管理员登出、
 * 普通用户登录时会因此看到完整的用户列表与「添加用户」按钮（越权显示）。
 */
function resetMainView() {
  for (const id of MAIN_VIEWS) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== 'explorer';
  }
  // R47：地址栏里记住的区块**同样必须作废** —— 否则登出后地址栏仍挂着 `#ordermgr`，
  // 下一个账号（或刷新后）会照着重放上一个会话的管理页，与上面那条越权原因同源。
  App.state.mainView = 'explorer';
  writeViewHash('explorer');
  // 订单列表属于上一个账号的对账数据，换账号必须丢弃
  ordermgr.reset();
  // IP 规则详情含其它用户的来源 IP，跨会话同样必须丢弃
  ipmgr.reset();
  // R54③：邀请码列表（含明文口令）属上一个管理员会话的数据，跨账号必须丢弃
  invitemgr.reset();
  // R62：优惠券列表（含券码明文）同样属上一个管理员会话的数据，跨账号必须丢弃
  couponmgr.reset();
  // R44：上个账号的「文件类型」筛选值不跨会话保留（否则新账号一进来就看到被滤空的目录）
  App.state.typeFilter = '';
  closeSidebar();
  // 关闭可能残留的浮层，避免跨会话泄漏上一账号的上下文
  const drawer = document.getElementById('upload-drawer');
  if (drawer) drawer.hidden = true;
  const cm = document.getElementById('ctx-menu');
  if (cm) cm.hidden = true;
}
App.resetMainView = resetMainView;

function toggleUploadDrawer(force) {
  const d = document.getElementById('upload-drawer');
  const open = force !== undefined ? force : d.hidden;
  d.hidden = !open;
  if (open) uploadMgr.render();
}

/* ------------------------------ 视图选项 ------------------------------ */

const COLUMN_DEFS = [
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'type', label: '类型' },
  { id: 'modified', label: '修改时间' },
];

function openViewOptions() {
  const s = App.state;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:6px">列表视图显示列</div>
    <div id="vo-cols"></div>
    <div class="hr"></div>
    <div class="form-item"><label>排序方式</label>
      <div class="seg-col" id="vo-sort">
        <button class="chip" data-v="name">名称</button>
        <button class="chip" data-v="size">大小</button>
        <button class="chip" data-v="type">类型</button>
        <button class="chip" data-v="modified">修改时间</button>
      </div>
    </div>
    <div class="form-item"><label>排序方向</label>
      <div class="seg-col" id="vo-dir">
        <button class="chip" data-v="asc">升序</button><button class="chip" data-v="desc">降序</button>
      </div>
    </div>
    <div class="hr"></div>
    <div class="form-item"><label>自动刷新频率（浏览目录时）</label>
      <div class="seg-col" id="vo-refresh">
        <button class="chip" data-v="0">手动</button><button class="chip" data-v="5">5 秒</button>
        <button class="chip" data-v="15">15 秒</button><button class="chip" data-v="30">30 秒</button>
        <button class="chip" data-v="60">60 秒</button>
      </div>
    </div>`;
  const colsEl = wrap.querySelector('#vo-cols');
  COLUMN_DEFS.forEach((c) => {
    const line = document.createElement('div');
    line.className = 'check-line';
    const checked = s.columns.includes(c.id) ? 'checked' : '';
    line.innerHTML = `<input type="checkbox" id="col-${c.id}" ${checked}><label for="col-${c.id}" style="margin:0">${c.label}</label>`;
    colsEl.appendChild(line);
  });
  function chipSelect(elSel, val) {
    wrap.querySelectorAll(elSel + ' .chip').forEach((b) => b.classList.toggle('active', b.dataset.v === String(val)));
  }
  chipSelect('#vo-sort', s.sort.key);
  chipSelect('#vo-dir', s.sort.dir);
  chipSelect('#vo-refresh', s.autoRefresh);
  [['#vo-sort', 'sort.key'], ['#vo-dir', 'sort.dir'], ['#vo-refresh', 'autoRefresh']].forEach(([sel]) => {
    wrap.querySelectorAll(sel + ' .chip').forEach((b) => {
      b.onclick = () => { b.parentElement.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); b.classList.add('active'); };
    });
  });
  wrap.querySelector('#vo-sort').dataset.role = 'sortkey';
  const m = openModal({
    title: '视图选项', body: wrap, foot: [
      { text: '取消' },
      {
        text: '应用', cls: 'primary', onClick: (o, close) => {
          try {
            s.columns = COLUMN_DEFS.filter((c) => o.querySelector('#col-' + c.id).checked).map((c) => c.id);
            if (!s.columns.includes('name')) s.columns.unshift('name');
            const act = (sel, fallback) => {
              const el = o.querySelector(sel + ' .active');
              return el ? el.dataset.v : fallback;
            };
            s.sort.key = act('#vo-sort', s.sort.key);
            s.sort.dir = act('#vo-dir', s.sort.dir);
            s.autoRefresh = Number(act('#vo-refresh', s.autoRefresh));
            savePrefs(); startAutoRefresh();
            explorer.render();
            close();
            toast('视图选项已应用', { type: 'success' });
          } catch (e) {
            toast('应用视图选项失败：' + e.message, { type: 'error' });
            close();
          }
        },
      },
    ],
  });
}

/* ------------------------------ 筛选面板（搜索多条件） ------------------------------ */

function openFilterPanel() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item"><label>类型</label>
      <select id="ft-type">
        <option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option>
        <option value="audio">音频</option><option value="doc">文档</option><option value="archive">压缩包</option>
        <option value="exec">可执行文件</option><option value="other">其他文件</option><option value="folder">文件夹</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-item"><label>修改日期从</label><input type="date" id="ft-from"></div>
      <div class="form-item"><label>修改日期至</label><input type="date" id="ft-to"></div>
    </div>
    <div class="form-row">
      <div class="form-item"><label>最小大小 (MB)</label><input type="number" id="ft-min" min="0" placeholder="0"></div>
      <div class="form-item"><label>最大大小 (MB)</label><input type="number" id="ft-max" min="0" placeholder="不限"></div>
    </div>
    <div class="check-line" style="margin-top:6px">
      <input type="checkbox" id="ft-current" ${App.state.searchCurrentOnly ? 'checked' : ''}>
      <label for="ft-current" style="margin:0">仅当前目录（不递归子目录）</label>
    </div>
    <div class="hint">点击工具栏“搜索”或在搜索框回车后，将按名称关键字 + 以上条件搜索。
      勾选「仅当前目录」时只扫当前这一层 —— 云端列举从“所有子目录的页数”降到 1 页，
      在大桶里是数量级的差别；该选项会被记住。</div>`;
  const m = openModal({
    title: '筛选条件', body: wrap, foot: [
      { text: '清除条件', onClick: (o, close) => { window.__filter = null; close(); explorer.exitSearch(); } },
      {
        text: '应用并搜索', cls: 'primary', onClick: (o, close) => {
          const f = {
            type: o.querySelector('#ft-type').value,
            from: o.querySelector('#ft-from').value,
            to: o.querySelector('#ft-to').value,
            minMB: Number(o.querySelector('#ft-min').value) || 0,
            maxMB: o.querySelector('#ft-max').value ? Number(o.querySelector('#ft-max').value) : null,
          };
          window.__filter = (f.type || f.from || f.to || f.minMB || f.maxMB) ? f : null;
          // 搜索范围不入 __filter：它是 App.state 上的单一判据（回车与面板共用），
          // 塞进 filter 会让「只勾范围、不填条件」时 filter 被判为空而整次搜索被跳过。
          setSearchScope(o.querySelector('#ft-current').checked);
          close();
          explorer.search();
        },
      },
    ],
  });
}

/**
 * 设置搜索范围（仅当前目录 / 递归子树），并同步搜索框的占位提示。
 *
 * 单一判据：搜索框回车与筛选面板都读 App.state.searchCurrentOnly，
 * 不会出现「面板里勾了、回车却不生效」这种两处状态不一致。
 */
function setSearchScope(on, { save = true } = {}) {
  App.state.searchCurrentOnly = !!on;
  const input = document.getElementById('search-input');
  if (input) {
    input.placeholder = App.state.searchCurrentOnly
      ? '搜索当前目录（回车）'
      : '搜索当前目录及子目录（回车）';
  }
  if (save) savePrefs();
}

/* ------------------------------ 状态栏 ------------------------------ */

let storageCache = null;

export async function updateStatusbar() {
  const $ = (id) => document.getElementById(id);
  const cfg = App.state.config;
  const conn = $('status-conn');
  if (!cfg) { conn.querySelector('em').textContent = '未连接'; conn.querySelector('.dot').className = 'dot'; }
  else if (cfg.corrupted) { conn.querySelector('em').textContent = '配置已损坏'; conn.querySelector('.dot').className = 'dot bad'; }
  else if (cfg.configured) { conn.querySelector('em').textContent = '已就绪（HTTPS）'; conn.querySelector('.dot').className = 'dot ok'; }
  else { conn.querySelector('em').textContent = '未配置密钥'; conn.querySelector('.dot').className = 'dot'; }

  $('status-bucket').textContent = App.state.bucket ? `🪣 ${App.state.bucketDisplay || App.state.bucket}（${App.state.region}）` : '';
  $('status-bucket').title = App.state.bucket || '';

  // 存储用量（quotaBytes 为 0 表示无限制）
  if (cfg && cfg.configured && App.state.bucket) {
    try {
      // R7-10：失败态**不得**被缓存。旧实现把 rejected 的 Promise 存进 storageCache
      // 且永不失效 —— 一次 428（未配置）或网络抖动之后，后续每次 updateStatusbar
      // 都复用同一个失败 Promise，状态栏长期显示「用量获取失败」，只有切桶/增删桶才恢复。
      if (!storageCache) {
        storageCache = API.storage().catch((e) => { storageCache = null; throw e; });
      }
      const st = await storageCache;
      App.state.storageInfo = st;
      const used = st.usedBytes || 0;
      const total = App.state.quotaBytes || 0;
      const pct = total ? Math.min(100, (used / total) * 100) : 0;
      const bar = document.querySelector('#status-quota .quota-bar');
      bar.querySelector('i').style.width = total ? pct.toFixed(1) + '%' : '100%';
      bar.classList.toggle('hot', total > 0 && pct >= 85);
      bar.classList.toggle('unlimited', total === 0);
      $('quota-text').textContent = total ? `${fmtSize(used)} / ${fmtSize(total)}（${pct.toFixed(1)}%）` : `${fmtSize(used)} / 无限制`;
    } catch (e) { $('quota-text').textContent = '用量获取失败'; }
  } else {
    document.querySelector('#status-quota .quota-bar i').style.width = '0';
    $('quota-text').textContent = '—';
  }
}

/**
 * 今日累计流量（低频，写入悬停提示；状态栏正文显示实时速度）
 *
 * R7-09：驱动它的 60 秒定时器此前**建了就再没人管**（全库唯一一处没有 clearInterval 的
 * setInterval）—— 登出 / 会话过期后仍每 60 秒请求一次 `/api/stats/summary`（401）。
 * 这里与 `startSpeedPolling` 同一套约定：句柄保存 + 可停止 + 状态栏元素不在时自停。
 */
export async function refreshMiniStats() {
  // 已登出（状态栏不在）→ 立刻停止轮询，而不是"请求照发、只在渲染时 return"
  if (!document.getElementById('status-traffic')) { stopStatsTimer(); return; }
  // R94（审核 M13-07）：`/api/stats/summary` 管理员专属（全实例聚合，非个人用量）
  if (!isStaffRole(App.state.user && App.state.user.role)) { stopStatsTimer(); return; }
  try {
    const s = await API.summary();
    App.state.statsSummary = s;
    const t = s.traffic;
    document.getElementById('status-traffic').title =
      `今日流量 ↑${fmtSize(t.todayUp)} ↓${fmtSize(t.todayDown)}（正文为实时速度，近 10 秒平均）`;
    updateStatusbar();
  } catch (e) {
    // 401/403 说明会话已失效，继续轮询没有意义
    if (e && (e.status === 401 || e.status === 403)) stopStatsTimer();
  }
}

/** R7-09：统计摘要定时器 —— 句柄保存 + 先停后启，登出时由 forceLogout 停止 */
function startStatsTimer() {
  stopStatsTimer();
  /**
   * R94（审核 M13-07）：`/api/stats/summary` 已改为管理员专属（它报的是**全实例**
   * 的 7 天流量，不是"自己那一部分"）。普通用户连定时器都不建，避免每分钟一次
   * 注定 403 的请求 —— 请求频率本身也是一种噪音与日志污染。
   */
  if (!isStaffRole(App.state.user && App.state.user.role)) return;
  App._statsTimer = setInterval(refreshMiniStats, 60000);
}
function stopStatsTimer() {
  if (App._statsTimer) { clearInterval(App._statsTimer); App._statsTimer = null; }
}

/**
 * 实时上传/下载速度（近 10 秒平均，2 秒轮询）
 *
 * PERF-03：句柄必须保存并可停止。旧实现 `setInterval(tick, 2000)` 的结果被丢弃，
 * 于是登出后、登录页上仍在持续请求 `/api/stats/speed`（返回 401）——
 * 约 1800 次/小时/标签页，多标签页叠加，且全部是无效请求。
 * 同时在元素不存在（未登录 / 已登出）时**停止轮询**，而不是"请求照发、只在渲染时 return"。
 */
let speedTimer = null;
function startSpeedPolling() {
  stopSpeedPolling();
  const el = () => document.getElementById('status-traffic');
  /**
   * R94（审核 M13-07）：只给管理员轮询，普通用户连那一格都隐藏。
   *
   * `/api/stats/speed` 报的是**全实例**近 10 秒吞吐（`sampleTraffic()` 不带用户维度），
   * 对单个用户没有意义，且与「普通用户仅见自己可见资源」的约定相悖 —— 于是接口加了
   * `requireAdmin`。前端若照旧每 2 秒打一次，普通用户会立刻撞 403（下面的 catch 会
   * 停掉轮询，但开局那一次仍是白挨），状态栏还会留着一个永远「↑— ↓—」的格子。
   */
  const staff = isStaffRole(App.state.user && App.state.user.role);
  const node = el();
  if (node) node.hidden = !staff;
  if (!staff) return;
  async function tick() {
    if (!el()) { stopSpeedPolling(); return; } // 状态栏不在 → 已登出，立即停
    try {
      const s = await API.speed();
      if (!el()) { stopSpeedPolling(); return; }
      el().textContent = `↑${fmtSize(s.up || 0)}/s ↓${fmtSize(s.down || 0)}/s`;
    } catch (e) {
      // 401（未登录）说明会话已失效，继续轮询没有意义
      if (e && (e.status === 401 || e.status === 403)) stopSpeedPolling();
    }
  }
  tick();
  speedTimer = setInterval(tick, 2000);
}

function stopSpeedPolling() {
  if (speedTimer) { clearInterval(speedTimer); speedTimer = null; }
}
App.stopSpeedPolling = stopSpeedPolling;

/** 强制刷新存储用量（上传/删除等改变容量的操作后调用） */
export function refreshStorage() {
  storageCache = null;
  updateStatusbar();
}
App.refreshStorage = refreshStorage;

function updateNavButtons() {
  const s = App.state;
  document.getElementById('btn-back').disabled = s.historyIndex <= 0;
  document.getElementById('btn-fwd').disabled = s.historyIndex >= s.history.length - 1;
}
App.updateNavButtons = updateNavButtons;

/* ------------------------------ 自动刷新 ------------------------------ */

let refreshTimer = null;
function startAutoRefresh() {
  clearInterval(refreshTimer);
  if (App.state.autoRefresh > 0) {
    refreshTimer = setInterval(() => {
      if (document.getElementById('explorer').hidden) return; // 仪表盘打开时不刷新文件列表
      if (uploadMgr.hasActive()) return; // 有上传任务时暂停自动刷新，避免干扰
      explorer.refresh({ silent: true });
      refreshMiniStats();
    }, App.state.autoRefresh * 1000);
  }
}

/* ------------------------------ 键盘快捷键 ------------------------------ */

/**
 * 绑定键盘快捷键。
 *
 * R47：**这里不再拦截浏览器刷新键**。旧实现在本函数的键盘分支里对该键调用
 * `preventDefault()` 后只重取文件列表，于是用户按刷新键「没有作用」——真正生效的只有
 * 浏览器工具栏那颗刷新按钮；而整页重载又会把人丢回文件浏览首页。
 *
 * 现在刷新键交还浏览器：由浏览器执行**整页重载**（新代码即刻生效，不再有跨区块的
 * 陈旧数据），并由 `viewFromHash()` 按地址栏把用户送回原来停留的页面。
 * 本函数只保留不与浏览器冲突的快捷键（Delete / F2 / Ctrl+A / Enter / Backspace）。
 */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (document.querySelector('#modal-root .overlay')) return;
    const s = App.state;
    if (e.key === 'Delete' && s.selection.size) { ops.deleteSelected(); }
    else if (e.key === 'F2' && s.selection.size === 1) { ops.renameSelected(); }
    // R52-03：Ctrl+C / Ctrl+V 走**应用内**剪贴板（`ops` 的复制 / 粘贴），
    // 与系统的「复制/粘贴文件」无关 —— 这里必须 preventDefault，否则会连着
    // 触发浏览器对页面文字的选择复制，用户看到两个剪贴板各行其是。
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && s.selection.size) {
      e.preventDefault(); ops.copySelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault(); ops.paste();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); explorer.selectAll();
    } else if (e.key === 'Enter' && s.selection.size === 1) { explorer.openItem([...s.selection][0]); }
    else if (e.key === 'Backspace') { document.getElementById('btn-up').click(); }
  });

  // 全局 401 → 强制回到登录页（防止会话过期后仍停留在界面）
  window.addEventListener('auth-required', () => {
    if (App.state.user) {
      forceLogout('登录已过期，请重新登录');
    }
  });
}

/* roundRect 兼容 */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

init();
