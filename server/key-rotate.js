/**
 * 密钥生命周期编排 —— 迁移 / 轮转 / 审计
 *
 * `keyring.js` 只管"包裹与解开"这一层纯密码学；本模块负责**流程**：
 * 什么时候迁移、迁移怎么验证才算成功、轮转后要连带做什么（改根口令、踢会话、写审计）。
 *
 * ## 核心决策：迁移只"重裹"，不重加密
 *
 * 直觉上"上信封加密"应该顺带换一把新 DEK、把全部数据重加密一遍。但那样一来，
 * 迁移就不再是原子的了：`keyring.json` 与 `config.enc` / `enc-meta.json` /
 * `links.json` / `payments.json` 是**多个文件**，没有任何跨文件事务能让它们
 * 同时切换。无论先写哪一边，中间崩一次就会留下"新密钥 + 旧密文"或
 * "旧密钥 + 新密文"，而这两种状态的表现都是**数据永久不可解**。
 *
 * 所以这里采用文档 4.3 那条"最低成本路径"：**用主口令包裹现有 DEK，数据一个
 * 字节都不动**。整个迁移只写一个 `keyring.json`，`writeAtomicSync` 一次
 * rename 就位 —— 天然原子，没有中间态。
 *
 * 代价是"旧 DEK 本身可能已泄露"这件事没有被治愈（想治它得重加密全部数据，
 * 见文档 6 的「DEK 轮换」，属另一类操作）。但迁移要解决的痛点是**明文密钥
 * 躺在磁盘上**，这一点它解决得很彻底：迁移成功后会删掉 `secret.key`。
 *
 * ## 主口令 = 根用户登录口令
 *
 * 文档 10.2 的结论是"轮转登录密钥等价于改根口令"。这里把它落成**同一个口令**，
 * 而不是再造一个"主口令"：
 *
 *  - 用户只需要记一个口令；
 *  - 迁移时用 `verifyUserPassword()` 校验，顺带证明操作者**确实是根用户**；
 *  - 轮转时一次原子地同时更新"KEK 的包裹"与"根口令的 scrypt 哈希"，
 *    不会出现"KEK 用新口令、登录还是旧口令"这种两边不一致的状态。
 *
 * ## 失败一律回滚到旧路径
 *
 * 迁移的每一步都可能失败（口令敲错、磁盘满、文件被占用）。任何一步失败都
 * **删掉刚写的 `keyring.json`** 并回到"只有 secret.key"的状态 —— 那个状态是
 * 迁移前就成立、且一定可用的。这比"留下一个半成品容器"安全得多：半成品会让
 * `getMasterKey()` 优先走容器分支，而容器里的 DEK 若是错的，全部数据当场不可解。
 */
const fs = require('fs');
const path = require('path');
const atomic = require('./atomic-write');
const configStore = require('./config-store');
const keyring = require('./keyring');
const roles = require('./roles');
const authSession = require('./auth-session');
const statsStore = require('./stats-store');
const { dataDir } = require('./data-dir');

/** 旧明文密钥文件名（历史契约，不改名 —— 改了老实例的迁移就找不到它） */
const LEGACY_KEY_NAME = 'secret.key';
/** 保留旧密钥的逃生阀：给"先观察一段时间再删"的运维用 */
const ENV_KEEP_LEGACY = 'KEPLER_KEEP_LEGACY_KEY';

function legacyKeyPath() {
  return path.join(dataDir(), LEGACY_KEY_NAME);
}

function legacyKeyExists() {
  return fs.existsSync(legacyKeyPath());
}

/** 找出根用户（roles 是角色语义的唯一事实源，这里不写字面量比较） */
function rootUserOf(cfg) {
  const users = (cfg && cfg.users) || [];
  return users.find((u) => roles.isRoot(u.role)) || null;
}

/**
 * 当前密钥状态（供前端与运维判断该显示什么）。
 *
 * 只返回**不含机密**的字段：版本号、时间、以及"有没有旧密钥文件"这种布尔值。
 */
function status() {
  const ring = keyring.exists() ? keyring.info() : null;
  const envelope = Boolean(ring);
  return {
    envelope,
    unlocked: keyring.isUnlocked(),
    locked: envelope && !keyring.isUnlocked(),
    kekVersion: ring ? ring.kekVersion : 0,
    createdAt: ring ? ring.createdAt : '',
    rotatedAt: ring ? ring.rotatedAt : '',
    kdf: ring ? ring.kdf : '',
    kdfParams: ring ? ring.kdfParams : null,
    // 旧明文密钥是否还在盘上：迁移后应当为 false，为 true 说明"迁移过但没删"，
    // 那等于落盘风险没解决，前端要能把这个事实显式说出来
    legacyKeyPresent: legacyKeyExists(),
    needsMigration: !envelope && legacyKeyExists(),
  };
}

/* ====================== 轮转意图日志（两阶段提交） ====================== */

/**
 * R101（F-03）：轮转是**跨两个文件**的操作 —— `keyring.json`（KEK）与 `config.enc`
 * （根口令哈希）。`rewrap()` 是同步原子写，改哈希是异步写队列，两者之间没有任何
 * 跨文件事务：
 *
 * ```
 *   ① rewrap → 磁盘：新 KEK ✔        ② 改哈希 → 磁盘：旧登录口令 ✘（还没写）
 *                    ↑ 进程在这里死掉，就永久停在这个状态
 * ```
 *
 * 停在这个状态意味着：**旧口令能通过 step-up 但解不开容器，新口令能解锁但过不了
 * step-up** —— 两条公开的轮转路径都返回 401，界面没有任何修复入口。
 *
 * 解法是把这个窗口变成**可恢复**的：动手之前先把"我要做什么"写进一份意图文件
 * （含新口令**已经算好的** scrypt 凭据），成功后再删掉它。重启 / 解锁时若发现
 * 意图还在，按 `kekVersion` 判"做到哪一步了"并补完。
 *
 * ⚠️ 意图文件里那份 scrypt 凭据是**明文**落盘的，这看起来像新增暴露面，其实不是：
 * 同一个目录下的 `keyring.json` 本身就含**同一个口令**派生出的 salt 与 `wrappedDek`
 * （KDF 参数也相同），能离线爆破意图文件的人，同样能离线爆破 `keyring.json`，
 * 成本一模一样。真正的机密（DEK、明文口令）一个都没有多写。
 */
const INTENT_NAME = 'keyring.rotate-intent.json';
const INTENT_VERSION = 1;

function intentPath() {
  return path.join(dataDir(), INTENT_NAME);
}

function clearIntent() {
  try { fs.unlinkSync(intentPath()); } catch (e) { /* 已经不存在 */ }
}

/** 读意图文件；不存在返回 null，读不懂返回 `{bad:true}`（绝不删 —— 留给人工判断） */
function readIntent() {
  const file = intentPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { bad: true };
  }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Number(obj.v) !== INTENT_VERSION) return { bad: true };
    if (!obj.cred || !obj.cred.salt || !obj.cred.hash) return { bad: true };
    if (!Number.isFinite(Number(obj.fromKekVersion)) || !Number.isFinite(Number(obj.toKekVersion))) {
      return { bad: true };
    }
    return obj;
  } catch (e) {
    return { bad: true };
  }
}

function writeIntent(obj) {
  const file = intentPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomic.writeAtomicSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/**
 * 补完一次没做完的轮转（启动时 / 解锁后 / 下次轮转之前都会调）。
 *
 * 三种结论，只做**确定**的那一种：
 *  - `kekVersion === toKekVersion`：KEK 已经是新口令 ⇒ 说明 ① 成功了、② 没落盘，
 *    **把意图里那份凭据补写进配置**（此时手上只有哈希，没有明文口令，所以必须用
 *    `setPasswordCredential`），然后删意图；
 *  - `kekVersion === fromKekVersion`：① 根本没发生 ⇒ 删意图，什么都没变；
 *  - 其它（版本对不上 / 用户没了 / 配置读不出来）：**保留意图**并告警，让人去看。
 *
 * R104（F-06）：**必须与轮转互斥**。
 *
 * 最危险的一行是 `v === from ⇒ clearIntent()`：它删掉的是「下一次崩溃之后唯一能
 * 补完轮转的凭据」。而轮转 A 在 `writeIntent()` 之后、`keyring.rewrap()` 之内
 * （`kekVersion` 还是旧值、`config.enc` 还没写）的亚秒窗口里，任何一次持**当前旧口令**
 * 的成功解锁（`POST /api/key/unlock` 匿名可达）都会调到这里：看见「还没轮转」⇒ 删意图；
 * 若 A 随后在写 `config.enc` 前崩溃，就回到「新 KEK + 旧登录口令」的死局，
 * **而且没有意图日志可供下次补完**。
 *
 * 写法：先在**第一个 `await` 之前**判 `rotating`（与 `withRotationLock()` 同一条纪律），
 * 判过之后整段跑在互斥里 —— 中途启动的新轮转只会拿到 409，不会插进来写意图。
 *
 * @returns {Promise<{repaired:boolean, reason:string, kekVersion?:number}>}
 */
async function reconcile() {
  if (rotating) return { repaired: false, reason: 'rotating' };
  return withRotationLock(() => reconcileInner());
}

async function reconcileInner() {
  const it = readIntent();
  if (!it) return { repaired: false, reason: 'no-intent' };
  if (it.bad) {
    audit('key.rotate', 'error',
      `${INTENT_NAME} 无法解析：可能来自更新的版本或已损坏。已保留该文件，请人工确认后再删除`);
    return { repaired: false, reason: 'bad-intent' };
  }
  if (!keyring.exists()) {
    // 容器都没了，这份意图失去意义（且绝不在这里凭空造一个）
    clearIntent();
    return { repaired: false, reason: 'no-keyring' };
  }
  // 锁定态下配置解不开，补写无从谈起 —— 留着意图，等解锁后再来
  if (!keyring.isUnlocked()) return { repaired: false, reason: 'locked' };

  let ring;
  try {
    ring = keyring.info();
  } catch (e) {
    return { repaired: false, reason: 'keyring-unreadable' };
  }
  const v = Number(ring && ring.kekVersion) || 1;
  const from = Number(it.fromKekVersion);
  const to = Number(it.toKekVersion);

  if (v === from) {
    clearIntent();
    return { repaired: false, reason: 'not-rotated' };
  }
  if (v !== to) {
    audit('key.rotate', 'error',
      `发现未完成的轮转意图（期望 kekVersion ${from} → ${to}，实际 ${v}）：无法判断该补还是该退，`
      + `已保留 ${INTENT_NAME}，请人工核对后处理`);
    return { repaired: false, reason: 'version-mismatch' };
  }

  const raw = configStore.findUserRawById(it.userId);
  if (!raw) {
    audit('key.rotate', 'error',
      `未完成的轮转意图指向的用户已不存在（${it.userId}）：已保留 ${INTENT_NAME}，请人工核对`);
    return { repaired: false, reason: 'no-user' };
  }
  const same = String(raw.passwordHash || '') === String(it.cred.hash)
    && String(raw.passwordSalt || '') === String(it.cred.salt);
  if (!same) {
    configStore.setPasswordCredential(it.userId, it.cred);
    const before = configStore.getLastWriteError();
    try {
      await configStore.flushPending();
    } catch (e) { /* 队列本身不 reject，失败通过 getLastWriteError 体现 */ }
    const after = configStore.getLastWriteError();
    if (after && after !== before) {
      audit('key.rotate', 'error',
        `补完未完成的轮转时配置写盘失败（${(after && after.message) || after}）：`
        + `${INTENT_NAME} 已保留，下次解锁会再试一次`);
      return { repaired: false, reason: 'write-failed' };
    }
  }
  clearIntent();
  audit('key.rotate', 'warn',
    `补完一次未完成的密钥轮转（kekVersion=${to}）：KEK 已是新口令、登录口令哈希已同步`);
  return { repaired: true, reason: 'completed', kekVersion: to };
}

/**
 * 轮转互斥（F-09）。
 *
 * 两个根会话同时提交轮转时，两边都能通过 step-up、都能基于**同一份旧 ring**
 * 完成 `rewrap()`，最后 KEK 的"最后写入者"与登录哈希的"最后写入者"是两条独立队列，
 * 完全可能来自不同请求 —— 结果与崩溃窗口一模一样（KEK 与登录口令分叉）。
 *
 * 用进程内标记而不是排队：第二个请求**明确失败**（409）比"静默覆盖前一个"安全得多，
 * 而且轮转本来就是个位数秒级的操作，让管理员重试一次没有任何成本。
 */
let rotating = false;

/** 仅供测试 / 排障：当前是否有轮转在进行 */
function isRotating() { return rotating; }

/**
 * 轮转 / 迁移的**唯一**串行化入口（R101 / F-09）。
 *
 * 判据在第一个 `await` 之前完成（`async` 函数体在首个 await 前是同步执行的），
 * 因此两个并发请求不会同时越过这道门 —— 这正是"看起来有锁、其实没有"的常见写法
 * （先 await 再置标记）必须避免的地方。
 */
async function withRotationLock(fn) {
  if (rotating) {
    const err = new Error('已有一次密钥轮转正在进行，请稍后重试');
    err.status = 409;
    err.code = 'ROTATION_IN_PROGRESS';
    throw err;
  }
  rotating = true;
  try {
    return await fn();
  } finally {
    rotating = false;
  }
}

/** 审计日志。失败不阻断主流程 —— 审计写得下更好，写不下不能因此让轮转失败。 */
function audit(action, level, detail) {
  try {
    statsStore.addLog({ action, level, detail });
  } catch (e) {
    console.error('[key-rotate] 审计日志写入失败：', (e && e.message) || e);
  }
}

/**
 * 迁移到信封加密。
 *
 * @param {string} passphrase 根用户当前登录口令（迁移后同时成为 KEK 的解锁因子）
 * @param {{keepLegacyKey?: boolean}} [opts] `keepLegacyKey` 保留 `secret.key` 不删
 * @returns {Promise<{migrated:boolean, reason?:string, kekVersion?:number, legacyKeyRemoved?:boolean}>}
 * @throws 401 口令错 / 400 尚无根用户 / KEYRING_LOCKED 等
 */
async function migrate(passphrase, opts) {
  return withRotationLock(() => migrateInner(passphrase, opts));
}

async function migrateInner(passphrase, opts) {
  const keep = Boolean(opts && opts.keepLegacyKey)
    || String(process.env[ENV_KEEP_LEGACY] || '') === '1';

  // 幂等：已经迁移过就直接返回，绝不重复包裹（重复包裹会覆盖容器 = 灾难）
  if (keyring.exists()) {
    return { migrated: false, reason: 'already-envelope' };
  }

  const cfg = configStore.load();
  const root = rootUserOf(cfg);
  if (!root) {
    const err = new Error('尚未创建根用户，无法建立密钥信封');
    err.status = 400;
    throw err;
  }

  /**
   * ① 口令必须是根用户的**当前登录口令**。
   *
   * 这一步同时办了两件事：证明操作者能登录（迁移是敏感操作），以及保证
   * "KEK 的解锁因子 = 用户已经记住的那个口令"，不必再记第二个。
   */
  const okPw = await configStore.verifyUserPassword(root.id, passphrase);
  if (!okPw) {
    const err = new Error('口令不正确');
    err.status = 401;
    throw err;
  }

  // ② 取现有 DEK（此时容器还不存在，`getMasterKey()` 走的是老的 secret.key 路径）
  const oldDek = Buffer.from(configStore.getMasterKey());

  // ③ 包裹 —— 只写 keyring.json，数据文件不动
  const info = await keyring.create(passphrase, oldDek);

  /**
   * ④ 验证：锁 → 解锁 → DEK 必须与旧的一致 → 配置必须还能读回来。
   *
   * 这不是形式主义。`create()` 内部的"包裹 → 写入 → 读回"如果因为磁盘问题
   * 悄悄失败（比如写了个截断文件），下一秒就会删除 `secret.key` —— 那一步之后
   * 就再也没有第二份凭据了。所以删除之前必须真的走一遍"重启视角"的读路径。
   */
  let verifyError = null;
  try {
    keyring.lock();
    await keyring.unlock(passphrase);
    if (!keyring.dek().equals(oldDek)) {
      throw new Error('解包得到的密钥与原密钥不一致');
    }
    configStore.resetMasterKeyCache();
    // 只有配置文件确实存在时才要求读回（全新实例可能还没有 config.enc）
    if (fs.existsSync(path.join(dataDir(), 'config.enc')) && configStore.load() === null) {
      throw new Error('配置无法用新密钥读回');
    }
  } catch (e) {
    verifyError = e;
  }

  if (verifyError) {
    // 回滚：删掉容器，回到"只有 secret.key"的旧状态（那个状态一定可用）
    try { fs.unlinkSync(keyring.keyringPath()); } catch (e2) { /* 已不存在 */ }
    keyring.lock();
    configStore.resetMasterKeyCache();
    const err = new Error(
      '迁移验证失败，已回滚到原状态（旧密钥未改动）：' + ((verifyError && verifyError.message) || verifyError)
    );
    err.status = 500;
    err.code = 'KEYRING_MIGRATE_FAILED';
    err.cause = verifyError;
    throw err;
  }

  /**
   * ⑤ 删除明文密钥。
   *
   * 这是"去落盘"真正生效的那一步 —— 留着 `secret.key` 就等于留着一份能直接
   * 解密全部数据的明文，改造本身失去意义。删除发生在④验证通过**之后**，
   * 且可被 `keepLegacyKey` / `KEPLER_KEEP_LEGACY_KEY=1` 拦住。
   */
  let removed = false;
  if (!keep) {
    try {
      fs.unlinkSync(legacyKeyPath());
      removed = true;
    } catch (e) {
      // 删不掉不是致命错误（容器已可用），但必须让运维知道：
      // 此时"落盘风险"依然存在，且用户以为已经解决了
      audit('key.migrate', 'warn',
        `密钥信封已建立，但旧明文密钥 ${LEGACY_KEY_NAME} 删除失败（${(e && e.message) || e}）：`
        + '请手工删除该文件，否则"密钥不落盘"并未真正生效');
    }
  }

  audit('key.migrate', 'warn',
    `根用户 ${root.username} 建立密钥信封（kekVersion=${info.kekVersion}）：`
    + `主口令经 scrypt(N=${keyring.KDF_PARAMS.N}) 派生 KEK 包裹现有 DEK，数据文件未重加密；`
    + (removed ? `旧明文密钥 ${LEGACY_KEY_NAME} 已删除` : `旧明文密钥 ${LEGACY_KEY_NAME} 仍保留`));

  return {
    migrated: true,
    kekVersion: info.kekVersion,
    legacyKeyRemoved: removed,
  };
}

/**
 * 轮转主口令（= 轮转登录密钥）。
 *
 * 顺序上有一处**必须**注意：先重裹 DEK，再改根口令哈希。
 *
 * 反过来的话（先改哈希），一旦重裹失败，用户的新口令能登录、却解不开数据 ——
 * 那是比"轮转没成功"严重得多的状态。按现在的顺序，最坏情况是"重裹成功、
 * 改哈希失败"：此时 KEK 已用新口令，而登录还是旧口令。为此在改哈希失败时
 * **回滚 KEK**（用旧口令再裹回去），保证两边始终一致。
 *
 * @param {object} p
 * @param {string} p.currentPassphrase 当前根口令
 * @param {string} p.newPassphrase 新根口令（强度由路由层先行校验）
 * @param {string} [p.actor] 操作人（审计用）
 * @returns {Promise<{kekVersion:number, rotatedAt:string, sessionsKilled:number}>}
 */
async function rotateLogin(opts) {
  return withRotationLock(() => rotateLoginInner(opts));
}

async function rotateLoginInner({ currentPassphrase, newPassphrase, actor }) {
  if (!keyring.exists()) {
    const err = new Error('该实例尚未启用密钥信封，请先完成迁移');
    err.status = 409;
    err.code = 'KEYRING_ABSENT';
    throw err;
  }
  // 未解锁时先解锁：`rewrap()` 需要一个"当前容器能解开"的前提，
  // 而锁定态下连根用户是谁都读不出来（config.enc 解不开）
  if (!keyring.isUnlocked()) {
    const err = new Error('服务处于锁定状态，请先解锁后再轮转');
    err.status = 503;
    err.code = 'KEYRING_LOCKED';
    throw err;
  }

  /**
   * ⓪ R101（F-03）：先补完上一次没做完的轮转。
   *
   * 不做这一步的话，「上次崩在改哈希之前」留下的分裂状态会让本次的 step-up 必然失败
   * （登录口令还是旧的、容器已经是新口令），而管理员从界面上看不出原因。
   * `reconcile()` 只认三种确定的情形（见其注释），判不了就原样保留意图并告警。
   */
  await reconcile();

  const cfg = configStore.load();
  const root = rootUserOf(cfg);
  if (!root) {
    const err = new Error('尚未创建根用户，无法轮转密钥');
    err.status = 400;
    throw err;
  }

  // ① step-up：当前口令必须仍是根口令（防会话劫持后被人直接改掉解锁因子）
  const okOld = await configStore.verifyUserPassword(root.id, currentPassphrase);
  if (!okOld) {
    const err = new Error('当前口令不正确');
    err.status = 401;
    err.code = 'BAD_CURRENT_PASSPHRASE';
    throw err;
  }

  /**
   * ② 新口令的强度**必须在重裹之前**校验。
   *
   * 放在后面（等 `updateUser` 自己报错）在功能上也对 —— 那条路径会回滚 KEK。
   * 但代价是：先跑一次 scrypt 派生新 KEK、再跑一次 scrypt 校验哈希，然后才发现
   * "口令只有 5 位"并回滚。每次手抖都要多付两百毫秒 CPU，而这段时间里 `keyring.json`
   * 已经被改写过一次（虽然随即回滚）—— 没有任何理由去承担这个窗口。
   */
  configStore.assertPasswordPolicy(String(newPassphrase));

  /**
   * ③ **两阶段提交的第一阶段**：先把新口令的 scrypt 凭据算出来，落进意图日志。
   *
   * 顺序不能反：意图里必须写明"要做的事"，否则崩溃后没人知道该把登录口令改成什么。
   * 凭据只算这一次 —— 第二阶段（以及重启后的补写）直接用这份结果，不再重跑 scrypt。
   */
  const cred = await configStore.hashPassword(String(newPassphrase));
  const ringBefore = keyring.info();
  const fromKekVersion = Number(ringBefore && ringBefore.kekVersion) || 1;
  const toKekVersion = fromKekVersion + 1;
  writeIntent({
    v: INTENT_VERSION,
    userId: root.id,
    fromKekVersion,
    toKekVersion,
    cred,
    startedAt: new Date().toISOString(),
    actor: actor ? String(actor) : '',
  });

  // ④ 用新口令重裹同一个 DEK（数据不动）
  const info = await keyring.rewrap(currentPassphrase, newPassphrase);

  /**
   * ⑤ 同步根口令哈希 —— **必须确认它真的落盘了**（R101 / F-02）。
   *
   * 旧实现只调用 `flushPending()` 而不 `await`，且 `writeNow()` 的 `.catch()` 把
   * 写盘失败吸收成了一个**已解决**的 Promise ⇒ 磁盘满时接口照样回 `ok:true`，
   * 而磁盘上留下的是「新 KEK + 旧登录口令」：管理员以为轮转完了，旧口令其实还能登录。
   * 现在三条一起做：显式 `await`、比对 `getLastWriteError()` 的前后值（它可能是
   * 更早一次失败留下的，不能只看"有没有值"）、失败就回滚 KEK。
   */
  try {
    configStore.setPasswordCredential(root.id, cred);
    const beforeErr = configStore.getLastWriteError();
    await configStore.flushPending();
    const afterErr = configStore.getLastWriteError();
    if (afterErr && afterErr !== beforeErr) {
      const err = new Error('根口令哈希写入磁盘失败：' + ((afterErr && afterErr.message) || afterErr));
      err.writeError = afterErr;
      throw err;
    }
  } catch (e) {
    let rolledBack = false;
    try {
      await keyring.rewrap(newPassphrase, currentPassphrase);
      rolledBack = true;
    } catch (e2) {
      // 回滚也失败：此时 KEK 已是新口令、登录还是旧口令。必须显式告警，
      // 让运维知道"用旧口令登录、但解锁要用新口令"这个临时矛盾状态。
      audit('key.rotate', 'error',
        `轮转时更新根口令失败且 KEK 回滚失败：KEK 已是新口令、登录口令仍是旧的。`
        + `请立即用新口令解锁并重新设置登录口令（${(e2 && e2.message) || e2}）`);
      /**
       * R101（F-03）：回滚失败意味着"往前的路"才是正确的 —— KEK 就是新口令。
       * 把意图里的目标版本改成**当前实际版本**，让下次解锁时的 `reconcile()` 能把
       * 登录口令补成新口令。不改的话意图还指着旧的目标版本，永远对不上，
       * 只能人工改数据文件。
       */
      try {
        const now = Number(keyring.info().kekVersion) || 0;
        if (now > 0) {
          writeIntent({
            v: INTENT_VERSION, userId: root.id, fromKekVersion,
            toKekVersion: now, cred, startedAt: new Date().toISOString(),
            actor: actor ? String(actor) : '',
          });
        }
      } catch (e3) { /* 意图写不下就只能靠审计日志里那句告警 */ }
    }
    // 回滚成功 = 状态回到轮转之前，意图失去意义；回滚失败 = 意图要留着让 reconcile 补完
    if (rolledBack) clearIntent();
    const err = new Error(
      (rolledBack ? '更新根口令失败，已回滚密钥轮转：' : '更新根口令失败，且回滚未成功：')
      + ((e && e.message) || e)
    );
    err.status = 500;
    err.code = 'KEYRING_ROTATE_FAILED';
    err.cause = e;
    throw err;
  }

  // 两阶段提交完成：意图日志使命结束
  clearIntent();

  /**
   * ⑤ 全部会话失效。
   *
   * 解锁因子变了，旧会话里那份"已通过认证"的状态就不该继续被信任 ——
   * 尤其考虑到轮转的典型触发场景是"怀疑口令泄露"，此时让对方继续用着现成
   * 会话等于没轮转。这里清**所有**用户而不只是根用户：主口令轮转是全局事件。
   */
  let killed = 0;
  try {
    const users = (configStore.load() && configStore.load().users) || [];
    for (const u of users) killed += authSession.destroyUserSessions(u.id);
  } catch (e) {
    killed = 0;
  }

  audit('key.rotate', 'warn',
    `${actor ? '根用户 ' + actor : '根用户'} 轮转登录密钥：kekVersion=${info.kekVersion}，`
    + `数据文件未重加密，已强制 ${killed} 个会话失效`);

  return { kekVersion: info.kekVersion, rotatedAt: info.rotatedAt, sessionsKilled: killed };
}

module.exports = {
  LEGACY_KEY_NAME,
  ENV_KEEP_LEGACY,
  // R101：轮转的两阶段意图日志（`reconcile()` 是补完入口，启动 / 解锁后都会调）
  INTENT_NAME,
  reconcile,
  isRotating,
  // R104（F-06）：轮转互斥原语。导出是为了让护栏能**在互斥内部**调用 `reconcile()`，
  // 直接证明「轮转进行中不删意图日志」—— 否则只能靠时序碰运气（那样的护栏会假绿）。
  withRotationLock,
  legacyKeyPath,
  legacyKeyExists,
  status,
  migrate,
  rotateLogin,
};
