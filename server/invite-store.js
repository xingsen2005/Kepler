/**
 * 邀请码存储 —— data/invites.json（加密 JSON，与其它 store 同源）
 *
 * 每条记录：
 *  {
 *    id, code,                    // id：16 字节 base64url；code：10 位无歧义字符（唯一）
 *    role,                        // 用这枚码注册出来的账户身份（'user' | 'admin'）
 *    maxUses, used,               // 最大使用次数（0 = 不限制）与实际使用次数
 *    expiresAt,                   // ISO 时间；null = 永久有效
 *    disabled,                    // 管理员手动停用（**可逆**，与 expired 区分开）
 *    note,                        // 备注（批次用途 / 领用人）
 *    createdAt, createdBy,        // 生成时间与生成者
 *    usedBy,                      // 最近用过这枚码的用户名（**截断**，见 INVITE_USED_BY_MAX）
 *  }
 *
 * ## 为什么 `used` 与 `disabled` 是两个字段，而不是一个「状态」
 *
 * 「次数用尽」是**可逆**的：管理员在批量设置里把 `maxUses` 调大，那枚码立刻复活。
 * 若把「次数用尽」落成一个状态字段，改配额时就得同时记得把它改回来 —— 漏一处
 * 就是「明明把次数调到 100 了，还是提示已用尽」。这与链接管理里
 * `removeDead()` 刻意不删 `exhausted` 记录（`R37` 那次）是同一个判据：
 * **可逆状态不落字段，读的时候现算。**
 *
 * ## 为什么核销（`consume`）不删记录
 *
 * 删掉记录就没有「这枚码被谁用了、用了几次」可查，而管理员最需要知道的恰恰是
 * 「我发出去的这批码，哪些已经用掉了」。因此 `consume` 只把 `used` 加一，
 * 记录本身留到管理员显式删除。
 *
 * ## 与 `email-code.js` 的分工
 *
 * 那个模块管**短时效、一次性、按邮箱索引**的验证码（内存态、用满即作废）；
 * 本模块管**长期、可多次、按码索引**的邀请码（落盘、可编辑配额）。
 * 两者唯一相似的地方是「核销 + 回滚」这个模式，那是**刻意的形态复用**，
 * 而不是可以合并的实现 —— 前者的过期语义是「签发后 10 分钟」，
 * 后者是「一个管理员指定的绝对时刻」。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const secureStore = require('./secure-store');
const {
  INVITE_CODE_LEN, INVITE_CODE_ALPHABET, INVITE_CODE_RE, INVITE_USED_BY_MAX,
  normalizeInviteCode, normalizeDefaultRole,
} = require('./limits');

// 数据目录：走 data-dir.js 的唯一实现点（`S3_DATA_DIR`）—— 与
// config-store / share-store / enc-store / stats-store 一致的测试隔离开关
const DATA_DIR = require('./data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'invites.json');

/**
 * 核销失败的原因码 → 面向用户的文案（**唯一实现点**）。
 *
 * 与 `EMAIL_CODE_FAIL_TEXT` 同款：文案只在这里写一次，注册接口直接取用，
 * 避免「同一个原因在服务端与前端各写一句、改一处漏一处」。
 */
const INVITE_FAIL_TEXT = {
  not_found: '邀请码无效，请检查后重试',
  expired: '该邀请码已过期，请联系管理员获取新的邀请码',
  used_up: '该邀请码使用次数已用尽，请联系管理员获取新的邀请码',
  disabled: '该邀请码已被停用，请联系管理员',
};

/** 邀请码状态：active | expired | used_up | disabled（顺序即判定优先级） */
const INVITE_STATUS = ['active', 'expired', 'used_up', 'disabled'];

let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 记录归一化 —— **读取的唯一入口**。
 *
 * 非法记录**整条丢弃**（并打出告警），而不是「补个默认值凑合用」：
 * 一枚连 `INVITE_CODE_RE` 都不满足的码永远不可能被 `consume()` 命中
 * （那里按规范形式比对），留在表里只会让管理员看见一行「有效」却怎么都注册不成功。
 *
 * ⚠️ 这与 SEC-09 的「文件损坏不得静默重建」**不冲突**：那条守的是**整个文件**
 * 读不出来时不许拿空表覆盖；这里是文件读出来了、个别记录形状不对 ——
 * 与 `config-store.normalize()` 过滤非法 user 记录是同一层处置。
 */
function normalize(raw) {
  const list = (raw && Array.isArray(raw.invites)) ? raw.invites : [];
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') { dropped += 1; continue; }
    const code = normalizeInviteCode(r.code);
    if (!INVITE_CODE_RE.test(code)) { dropped += 1; continue; }
    // 重复码：只保留第一条。库里出现两个同码记录时，「核销了哪一个」不确定，
    // 而两行的「已用次数」会各自计数 —— 比丢一条更糟。
    if (seen.has(code)) { dropped += 1; continue; }
    seen.add(code);
    const maxUses = Number(r.maxUses);
    const used = Number(r.used);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : newId(),
      code,
      role: normalizeDefaultRole(r.role),
      maxUses: Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 0,
      used: Number.isInteger(used) && used > 0 ? used : 0,
      expiresAt: typeof r.expiresAt === 'string' && r.expiresAt ? r.expiresAt : null,
      disabled: Boolean(r.disabled),
      note: typeof r.note === 'string' ? r.note : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
      usedBy: (Array.isArray(r.usedBy) ? r.usedBy : [])
        .filter((u) => typeof u === 'string' && u)
        .slice(-INVITE_USED_BY_MAX),
    });
  }
  if (dropped > 0) {
    console.warn(`[invite-store] 已丢弃 ${dropped} 条形状不合法的邀请码记录（码缺失 / 含非法字符 / 重复）`);
  }
  return { invites: out };
}

function load() {
  if (cache) return cache;
  try {
    const raw = secureStore.readJson(FILE, null);
    if (raw) {
      cache = normalize(raw);
      return cache;
    }
  } catch (e) {
    // SEC-09：损坏时不静默重建 —— 打出告警；secure-store 已锁定该文件写入，
    // 磁盘上的损坏文件（及其 .corrupt-* 备份）不会被空表覆盖。
    console.error('[invite-store] 邀请码文件损坏，已降级为空列表并锁定写入：', e.message);
  }
  cache = { invites: [] };
  return cache;
}

/**
 * 落盘 —— **同步**写（`secureStore.writeJson`），与 `ip-guard.js` / `enc-store` 的
 * 「设置变更低频且关键」同款，而**刻意不学** `share-store` 的 `writeJsonAsync`。
 *
 * 理由是这里的写操作里有两条是**吊销**语义：
 *
 *  · `disabled`（停用一枚已经泄漏出去的码）；
 *  · `remove()`（整批删除）。
 *
 * 这两条都必须**当调用返回时就已落盘**。异步写在进程重启 / 崩溃时会丢掉队列里
 * 尚未 flush 的那一次 —— 表现是「管理员点了停用、界面显示已停用，重启后那枚码
 * 又活了」。那是一条静默的安全回退，比多花几毫秒严重得多。
 *
 * 次数与频率也支持这个选择：生成 / 批量设置 / 删除都是管理员手工操作，
 * 核销只在**注册**时发生一次（低频），文件规模是「几百条 × 几十字节」这个量级，
 * 一次全量加密 + 原子替换在毫秒以内。异步写省下的那点事件循环时间毫无收益。
 */
function persist() {
  ensureDataDir();
  secureStore.writeJson(FILE, cache);
}

/** 邀请码 ID：16 字节 base64url（22 字符，128 位熵）—— 与 share-store / config-store 同口径 */
function newId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * 生成一枚邀请码 —— `crypto.randomInt` 逐位取值。
 *
 * ⚠️ **不用 `Math.random`**：邀请码是一枚免注册口令，它的不可预测性直接等于
 * 账户安全。`Math.random` 的 V8 实现（xorshift128+）内部状态可由少量输出反推，
 * 一旦被反推，同一进程后续**所有**校验码（含邮箱验证码）都可预测。
 *
 * 逐位取值而不是「取一个随机数再取模」：后者会引入模偏差（modulo bias），
 * 让部分字符出现概率偏高，白白折损熵。
 */
function randomCode() {
  let s = '';
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    s += INVITE_CODE_ALPHABET[crypto.randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return s;
}

/* ------------------------- 视图 / 状态 ------------------------- */

/**
 * 邀请码状态：disabled | expired | used_up | active
 *
 * **停用排在最前**：它是管理员刚做过的显式动作，也是他此刻最需要看到的事实 ——
 * 若排在后面，一枚「已停用且已用尽」的码会显示成「已用尽」，管理员去调大配额
 * 却发现仍然注册不了（因为真正的拦路虎是 `disabled`）。
 */
function status(r, now = Date.now()) {
  if (r.disabled) return 'disabled';
  if (r.expiresAt && new Date(r.expiresAt).getTime() <= now) return 'expired';
  if (Number(r.maxUses) > 0 && Number(r.used) >= Number(r.maxUses)) return 'used_up';
  return 'active';
}

/**
 * 对外视图（唯一实现点）。
 *
 * 这里**原样回传 `code`** —— 本模块的全部消费方都是管理员接口
 * （`routes/invite.js` 每条都挂了 `requireAdmin`），而管理员正是要把码复制出去分发的人，
 * 打码等于让这个页面失去意义。真正要守的是**别的出口**：
 * 导出文件、审计日志、以及任何非管理员可达的响应，都不出现邀请码。
 */
function view(r, now = Date.now()) {
  const maxUses = Number(r.maxUses) || 0;
  const used = Number(r.used) || 0;
  return {
    id: r.id,
    code: r.code,
    role: r.role || 'user',
    maxUses,
    used,
    // 剩余次数：`null` = 不限制（不是 0 —— 0 会被读成「已经用完了」）
    remaining: maxUses > 0 ? Math.max(0, maxUses - used) : null,
    expiresAt: r.expiresAt || null,
    disabled: Boolean(r.disabled),
    note: r.note || '',
    status: status(r, now),
    createdAt: r.createdAt || '',
    createdBy: r.createdBy || '',
    usedBy: Array.isArray(r.usedBy) ? r.usedBy.slice() : [],
  };
}

function list() {
  return load().invites.map((r) => view(r));
}

function get(id) {
  return load().invites.find((r) => r.id === id) || null;
}

/** 按规范形式查表（`consume` 与「同码不可重复生成」共用） */
function findByCode(code) {
  return load().invites.find((r) => r.code === code) || null;
}

/* ------------------------- 增删改 ------------------------- */

/**
 * 批量生成邀请码。
 *
 * @param {object} o
 *  - `count`     生成条数（路由层已用 `parseInviteCountInput` 挡过非法值）
 *  - `role`      用这枚码注册出来的身份
 *  - `maxUses`   最大使用次数（0 = 不限制）
 *  - `expiresAt` ISO 字符串或 null
 *  - `note`      备注
 *  - `createdBy` 生成者用户名
 * @returns {Array<object>} 新生成的记录视图（**按生成顺序**）
 */
function generate({ count, role, maxUses, expiresAt, note, createdBy }) {
  const store = load();
  const taken = new Set(store.invites.map((r) => r.code));
  const n = Number(count) || 0;
  const now = new Date().toISOString();
  const made = [];
  for (let i = 0; i < n; i++) {
    /**
     * 撞码重摇。31^10 ≈ 8.2e14，实际撞上的概率可以忽略 —— 但**必须写这个循环**：
     * 「几乎不可能」不是「不可能」，而一旦真撞上，库里就会出现两枚同码记录，
     * 核销时命中的是哪一条完全取决于数组顺序（`normalize` 会丢走重复的那条，
     * 表现为「刚生成的码凭空少了一个」）。循环同时挡住「已存在的码」与「本批内重复」。
     */
    let code = randomCode();
    let guard = 0;
    while (taken.has(code) && guard < 1000) { code = randomCode(); guard += 1; }
    taken.add(code);
    const rec = {
      id: newId(),
      code,
      role: normalizeDefaultRole(role),
      maxUses: Number.isInteger(Number(maxUses)) && Number(maxUses) > 0 ? Number(maxUses) : 0,
      used: 0,
      expiresAt: expiresAt || null,
      disabled: false,
      note: typeof note === 'string' ? note : '',
      createdAt: now,
      createdBy: createdBy || '',
      usedBy: [],
    };
    store.invites.push(rec);
    made.push(view(rec));
  }
  if (made.length) persist();
  return made;
}

/**
 * 批量设置（**PATCH 语义**：只改传进来的字段）。
 *
 * 与 `Routes` 的分工：路由层负责「哪些字段合法」（非法一律 400），
 * 这里只负责落盘归一 —— 与 `configStore.saveSite()` 同款。
 *
 * ⚠️ 不存在的 id **静默跳过**并计入 `skipped`：列表页可能持有已被别人删掉的
 * 行（两个管理员同时操作），此时整批失败会让「另外 999 个码没设置成功」，
 * 而调用方拿不到任何提示。返回明确计数，由路由层如实回报。
 *
 * @returns {{updated: number, skipped: number}}
 */
function bulkUpdate(ids, patch, now = new Date().toISOString()) {
  const store = load();
  const want = new Set(Array.isArray(ids) ? ids : []);
  let updated = 0;
  let skipped = 0;
  for (const r of store.invites) {
    if (!want.has(r.id)) continue;
    want.delete(r.id);
    updated += 1;
    applyPatch(r, patch, now);
  }
  skipped = want.size;
  if (updated > 0) persist();
  return { updated, skipped };
}

/** 单条更新（管理员在行内改配额 / 停用）；返回视图或 null */
function update(id, patch, now = new Date().toISOString()) {
  const r = get(id);
  if (!r) return null;
  applyPatch(r, patch, now);
  persist();
  return view(r);
}

/**
 * 把一次 PATCH 落到记录上（`update` / `bulkUpdate` 的唯一实现点）。
 *
 * `disabled` 判的是 `!== undefined` 而不是真值 —— `false`（= 重新启用）是合法值，
 * 用真值判断会让「启用」这个动作**静默失效**，而界面会显示成功
 * （与 `updateUser` 里 `patch.email !== undefined` 是同一个坑）。
 */
function applyPatch(r, patch, now) {
  const p = patch || {};
  if (p.role !== undefined) r.role = normalizeDefaultRole(p.role);
  if (p.maxUses !== undefined) {
    const n = Number(p.maxUses);
    r.maxUses = Number.isInteger(n) && n > 0 ? n : 0;
  }
  if (p.expiresAt !== undefined) r.expiresAt = p.expiresAt || null;
  if (p.note !== undefined) r.note = typeof p.note === 'string' ? p.note : '';
  if (p.disabled !== undefined) r.disabled = Boolean(p.disabled);
  /**
   * 重置使用次数（可选的运维动作）。
   *
   * 与「调大 `maxUses`」是两件事：前者是「这批码重新发一轮」，后者是「再放几个名额」。
   * 重置**同时清空 `usedBy`** —— 留着上一轮的人名会让「这枚码最近谁在用」直接失真。
   */
  if (p.resetUsed) { r.used = 0; r.usedBy = []; }
  r.updatedAt = now;
}

/**
 * 批量删除。
 *
 * @param {Array<string>} ids
 * @returns {number} 实际删除的条数
 */
function remove(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  if (!want.size) return 0;
  const store = load();
  const before = store.invites.length;
  store.invites = store.invites.filter((r) => !want.has(r.id));
  const removed = before - store.invites.length;
  if (removed > 0) persist();
  return removed;
}

/* ------------------------- 核销 / 回滚 ------------------------- */

/**
 * 核销一次使用（**同步临界区**）。
 *
 * Node 单线程下 `load → 检查 → 改 used → persist` 全程同步，不会在执行中途被
 * 其它请求切换，故读-改-写天然原子，不会出现 `maxUses` 被突破
 * （与 `share-store.tryAcquire` 同一论证）。
 *
 * ⚠️ **失败原因要区分四档**，不能一律回「无效」：管理员与用户看到的是同一句
 * 提示，而四档对应的**下一步动作完全不同** —— 「已用尽 / 已过期」要去找管理员
 * 要新码，「格式错」是自己抄错了，「已停用」则是管理员主动关掉的。合成一句话
 * 就只能得到一张「说无效但看上去都对」的工单。
 *
 * @param {string} code 已归一（或未归一，这里会再归一一次）的邀请码
 * @param {string} [username] 使用者用户名（记入 `usedBy`，供管理员追溯）
 * @returns {{ok: true, invite: object} | {ok: false, reason: string}}
 */
function consume(code, username) {
  const c = normalizeInviteCode(code);
  if (!c) return { ok: false, reason: 'not_found' };
  const r = findByCode(c);
  if (!r) return { ok: false, reason: 'not_found' };
  const st = status(r);
  if (st !== 'active') return { ok: false, reason: st };
  r.used = Number(r.used) + 1;
  const who = String(username == null ? '' : username).trim();
  if (who) {
    r.usedBy.push(who);
    // 只留最近 INVITE_USED_BY_MAX 条（理由见 limits.js 的常量注释）
    if (r.usedBy.length > INVITE_USED_BY_MAX) r.usedBy = r.usedBy.slice(-INVITE_USED_BY_MAX);
  }
  persist();
  return { ok: true, invite: view(r) };
}

/**
 * 归还一次核销（注册失败时调用）。
 *
 * 为什么需要它：核销发生在 `addUser()` **之前**（否则「用户名已存在」这类失败
 * 会白扣一次配额，而管理员看到的「已用 1 次」其实没有对应的账户）。
 * 于是「核销成功 → 建号失败」这条路径必须把那一笔还回去 —— 与
 * `email-code.rollback` / `share-store.release` 完全同款。
 *
 * ⚠️ 只删**最后一个与本用户名相同**的条目：`addUser()` 内部有 scrypt 的 await，
 * 期间另一个请求可能用同一枚码注册成功并追加了自己的名字。直接 `pop()`
 * 会把别人的记录删掉（而 `used` 计数仍然正确，症状极轻微、几乎无法排查）。
 *
 * @returns {boolean} 是否真的回滚了一笔
 */
function rollback(id, username) {
  const r = get(id);
  if (!r) return false;
  const wasUsed = Number(r.used) || 0;
  if (wasUsed <= 0) return false;
  r.used = wasUsed - 1;
  const who = String(username == null ? '' : username).trim();
  const idx = who ? r.usedBy.lastIndexOf(who) : -1;
  if (idx >= 0) r.usedBy.splice(idx, 1);
  else if (r.usedBy.length) r.usedBy.pop(); // 无名字可对：仍要还一个名额，退掉最近一条
  persist();
  return true;
}

/* ------------------------- 导出 ------------------------- */

/**
 * 导出为纯文本 —— **一行一个**（需求原话）。
 *
 * 三处刻意的取舍：
 *  - **末尾补一个换行**：`a\nb\nc\n` 才是 POSIX 意义上的文本文件。不补的话，
 *    用 `while read` / `xargs` 之类的工具处理时最后一行会被丢掉（读不到行尾），
 *    而那是这类文件最常见的用途（批量核销 / 导入到别的系统）。
 *  - **不含表头、不含注释、不含其它列**：文件会被直接拿去逐行消费，
 *    多一行说明就等于多一枚「无效的码」。这也正是导出**只做 txt**、
 *    不顺手给个 CSV 的理由 —— 需求要的就是这个形状。
 *  - **不带 BOM**：邀请码全是 ASCII，BOM 只会让第一行多出 `\uFEFF` 前缀。
 *
 * 空集返回**空串**而不是单个换行：一个只含 `\n` 的文件看起来像「有一枚空码」。
 *
 * @param {{ids?: Array<string>}} [opts] 给 `ids` 时只导出这些；否则导出全部
 * @returns {string}
 */
function exportText(opts) {
  const ids = (opts && Array.isArray(opts.ids)) ? opts.ids : null;
  const src = load().invites;
  const pick = (ids && ids.length) ? src.filter((r) => ids.includes(r.id)) : src;
  const codes = pick.map((r) => r.code).filter((c) => INVITE_CODE_RE.test(c));
  return codes.length ? codes.join('\n') + '\n' : '';
}

module.exports = {
  list, get, findByCode, generate, update, bulkUpdate, remove,
  consume, rollback, exportText, view, status,
  INVITE_FAIL_TEXT, INVITE_STATUS,
};
