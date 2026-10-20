/**
 * 订单取回护栏 —— 连续输错订单号的封禁（R65）
 *
 * ## 它守的是一件很窄的事
 *
 * 「凭订单号取回下载权限」是**匿名可达**的端点，而订单号本身是一串可枚举的字符串
 * （36 位很难猜，但 8~64 位的形状判据仍然接受用户随手输入的任意长度串）。没有
 * 失败计数的话，一个脚本可以持续试探；有了计数也不能「一封了之」—— 封禁的代价
 * 必须**只落在这一件事上**：
 *
 *   ✅ 拦：`GET/POST /s/:id/restore`（尝试取回下载权限本身）
 *   ❌ 不拦：分享页浏览、付费下载、`/dl`、登录、其它任何接口
 *
 * 因此本模块**不挂在全局中间件上**，只由 `share-routes.js` 的取回端点显式调用。
 * 这与 `ip-guard.js` 的黑名单规则是两件不同的东西：那张表是管理员手工维护的
 * **访问**规则（命中即 403），而这里是**自动**产生、24 小时后自动过期、
 * 只作用于一条路径的临时限制。
 *
 * ## 为什么封禁要落盘、计数器不落盘
 *
 * - **封禁**必须落盘：管理员在「IP 地址管理」里能看到它、能解封；进程重启就忘掉
 *   一个仍在 24 小时内的封禁，等于「重启即解封」，是绕过它的最省事办法。
 * - **连击计数**只在内存里：它的语义是「**连续**输错」，而一次重启本身就打断了这个
 *   连续性；把它落盘反而会让「重启前的两次手误」继续算在新一轮头上。
 *   另有 `IDLE_MS`（24 小时无新失败）自动归零，避免长期使用中零散手误攒成封禁。
 *
 * ## 与限流器的分工
 *
 * `security.orderRestoreLimiter` 管的是「**频率**」（10 分钟 20 次，防刷），
 * 本模块管的是「**正确率**」（连续错 N 次，防猜）。两者互不替代：
 * 一个人可能在限额内错满 N 次（被这里封），也可能一直错但很慢（不触发这里，
 * 却最终触发限流）。
 */
const fs = require('fs');
const path = require('path');
const secureStore = require('./secure-store');
const coalesce = require('./coalesce');
const { RESTORE_BAN_MS, RESTORE_FAIL_IDLE_MS } = require('./limits');

const DATA_DIR = require('./data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'restore-bans.json');

/** 落盘去抖：封禁是低频事件，但仍走与其它 store 同一套合并写 */
const WRITE_DEBOUNCE_MS = 300;
/** 表上限：自动封禁只会来自「连续输错」，正常站点远达不到；超出按最早到期先丢 */
const MAX_BANS = 2000;

let cache = null;
let loadFailed = false;

/**
 * 连击计数（内存）：`ip → { fails, lastAt }`。
 *
 * ⚠️ 它在**进程内**有界：只保留 `COUNTER_MAX` 个 IP，超出按最久未活动丢弃 ——
 * 否则这又是一个「条目只增不减」的无界 Map（FUN-12 家族）。
 */
const COUNTER_MAX = 5000;
const counters = new Map();

function load() {
  if (cache) return cache;
  if (loadFailed) return { bans: [] };
  try {
    if (!fs.existsSync(FILE)) { cache = { bans: [] }; return cache; }
    const raw = secureStore.readJson(FILE, null);
    if (raw && Array.isArray(raw.bans)) {
      cache = { bans: raw.bans.filter(isBan) };
      return cache;
    }
    throw new Error('内容结构不是预期的 { bans: [] }');
  } catch (e) {
    loadFailed = true;
    console.error('[restore-guard] 读取订单取回封禁失败，已锁定写入：', (e && e.stack) || e);
  }
  cache = { bans: [] };
  return cache;
}

function isBan(b) {
  return Boolean(b && typeof b === 'object'
    && typeof b.ip === 'string' && b.ip
    && typeof b.until === 'string' && b.until);
}

const writer = coalesce.debouncedPersist(
  FILE,
  () => (loadFailed || !cache ? null : cache),
  { debounceMs: WRITE_DEBOUNCE_MS, dataDir: DATA_DIR },
);

function persist() {
  if (loadFailed) return;
  writer.schedule();
}

function flush() { writer.flush(); }

/**
 * 归一化 IP（只做 trim + 小写：IPv6 十六进制大小写不该产生两个身份）
 *
 * R69：空 IP 一律折算成固定键 `unknown`，**不再短路**。旧实现在 `isBanned` / `noteFail`
 * 里对空 key 直接返回「未封禁 / 不计数」，而空 IP 恰恰是请求方可制造的：
 * `TRUST_PROXY=1` 下发一个畸形 `X-Forwarded-For` 就能让 `clientIp` 返回空串 ——
 * 于是「连续输错就封 24 小时」这道门对所有这类请求整体失效。折算成固定键后，
 * 它们共用同一个封禁桶（代价是这类请求会一起被封，但那是它们自找的）。
 */
function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  return s || 'unknown';
}

/** 丢掉已到期的封禁（读路径上就地清理，免得列表里挂着一堆过期项） */
function prune(nowMs) {
  const g = load();
  const before = g.bans.length;
  g.bans = g.bans.filter((b) => {
    const t = Date.parse(b.until);
    return Number.isFinite(t) && t > nowMs;
  });
  if (g.bans.length !== before) persist();
  return g.bans;
}

/**
 * 这个 IP 现在是否被封（**只用于取回端点**）。
 *
 * @returns {{banned: boolean, until: string, retryAfter: number, fails: number}}
 *   `retryAfter` 为秒（向上取整，直接可塞进 `Retry-After`）
 */
function isBanned(ip, nowMs) {
  const key = ipKey(ip);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!key) return { banned: false, until: '', retryAfter: 0, fails: 0 };
  const hit = prune(now).find((b) => ipKey(b.ip) === key);
  if (!hit) return { banned: false, until: '', retryAfter: 0, fails: 0 };
  const t = Date.parse(hit.until);
  return {
    banned: true,
    until: hit.until,
    retryAfter: Math.max(1, Math.ceil((t - now) / 1000)),
    fails: Math.max(0, Number(hit.fails) || 0),
  };
}

/**
 * 记一次「输错」并判断是否要封。
 *
 * 计数语义是**连续**：成功一次（`noteSuccess`）或 24 小时无新失败都会归零。
 * `maxFails` 来自系统设置（「错误尝试次数上限」），判据在这里 —— 调用方不得
 * 自己维护一份计数（两份计数必然在边界上分叉）。
 *
 * @returns {{banned: boolean, justBanned: boolean, fails: number, until: string, retryAfter: number}}
 */
function noteFail(ip, maxFails, nowMs) {
  const key = ipKey(ip);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!key) return { banned: false, justBanned: false, fails: 0, until: '', retryAfter: 0 };
  const limit = Math.max(1, Math.floor(Number(maxFails) || 1));

  const st = counters.get(key);
  const fails = (st && now - st.lastAt <= RESTORE_FAIL_IDLE_MS) ? st.fails + 1 : 1;
  // 审计 I-17：**先删再写**，让 Map 的插入序真正等于「最近活动序」。
  // 只 `set` 已存在的键不会移动它的位置，于是下面那段「按最久未活动丢弃」实际退化成
  // 「按首次插入丢弃」—— 注释与实现不符，被淘汰的可能是刚刚还在用的 IP。
  counters.delete(key);
  counters.set(key, { fails, lastAt: now });
  if (counters.size > COUNTER_MAX) {
    // 按最久未活动丢弃（先删再写之后，Map 的插入顺序就是最近活动顺序）
    for (const k of counters.keys()) {
      if (counters.size <= COUNTER_MAX) break;
      counters.delete(k);
    }
  }

  if (fails < limit) {
    return { banned: false, justBanned: false, fails, until: '', retryAfter: 0 };
  }

  const until = new Date(now + RESTORE_BAN_MS).toISOString();
  const g = load();
  const prev = g.bans.find((b) => ipKey(b.ip) === key);
  if (prev) {
    prev.until = until;
    prev.fails = fails;
    prev.at = new Date(now).toISOString();
  } else {
    g.bans.push({ ip: key, until, fails, at: new Date(now).toISOString(), reason: 'restore-fail' });
  }
  if (g.bans.length > MAX_BANS) {
    g.bans.sort((a, b) => String(a.until).localeCompare(String(b.until)));
    g.bans.splice(0, g.bans.length - MAX_BANS);
  }
  counters.delete(key); // 已封禁：连击计数没有意义了，解封后从零开始
  persist();
  return { banned: true, justBanned: true, fails, until, retryAfter: Math.ceil(RESTORE_BAN_MS / 1000) };
}

/** 成功取回一次 —— 连击计数归零（封禁不受影响：被封的人根本走不到这里） */
function noteSuccess(ip) {
  const key = ipKey(ip);
  if (key) counters.delete(key);
}

/** 当前生效中的封禁列表（管理端「IP 地址管理」用；已过期的不会出现） */
function listBans(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return prune(now)
    .map((b) => ({
      ip: b.ip,
      until: b.until,
      fails: Math.max(0, Number(b.fails) || 0),
      at: b.at || '',
      retryAfter: Math.max(0, Math.floor((Date.parse(b.until) - now) / 1000)),
    }))
    .sort((a, b) => String(a.until).localeCompare(String(b.until)));
}

/**
 * 解封（管理端手工）。返回是否真的删掉了一条 —— `false` 表示「本来就没封」，
 * 界面据此给不同的提示（而不是一律弹「已解封」）。
 */
function unban(ip) {
  const key = ipKey(ip);
  if (!key) return false;
  const g = load();
  const before = g.bans.length;
  g.bans = g.bans.filter((b) => ipKey(b.ip) !== key);
  counters.delete(key); // 解封即清零：否则下一次手误立刻又被封
  if (g.bans.length === before) return false;
  persist();
  return true;
}

module.exports = {
  BAN_MS: RESTORE_BAN_MS,
  IDLE_MS: RESTORE_FAIL_IDLE_MS,
  MAX_BANS,
  isBanned, noteFail, noteSuccess, listBans, unban, flush,
};
