/**
 * 密钥环 —— 信封加密（KEK / DEK 分离）
 *
 * ## 它解决什么
 *
 * 改造前，`data/secret.key` 是一个 32 字节随机密钥，**明文静止**躺在数据目录里。
 * 能读到磁盘 / 快照 / 备份的人，拿到了它就等于拿到了全部云厂商密钥、支付凭证、
 * 以及 `config.enc` 里的登录口令哈希。而且它首次生成后**永不变更** —— 泄露之后
 * 没有任何低成本的止损手段（只能全量重加密，没有标准化流程、没有版本概念）。
 *
 * 本模块把"一个明文密钥"换成"两把钥匙"：
 *
 * ```
 * 主口令 ──scrypt(KDF)──► KEK ──AES-GCM 解包──► DEK ──► 加解密全部敏感文件
 *                          │                      ▲
 *                          └──── 磁盘上只有这层 ───┘
 *                            (salt + wrappedDek)
 * ```
 *
 * - **DEK**（数据加密密钥）：随机 32 字节，仍然是 `config-store.getMasterKey()`
 *   返回的那个值 —— 因此 `secure-store` / `share-store` / `payment-orders`
 *   一行都不用改。
 * - **KEK**（密钥加密密钥）：由管理员主口令经 scrypt 派生，**从不落盘**，
 *   用完即弃（本模块只在调用栈上持有它一个函数的时间）。
 * - **wrappedDek**：DEK 被 KEK 包裹后的密文，与 `salt` / KDF 参数 /
 *   `kekVersion` 一起写进 `data/keyring.json`。
 *
 * 于是磁盘上不再有"直接可用"的密钥：攻击者拿到 `keyring.json` 还得先爆破
 * scrypt（N=2^17）才能还原 DEK。攻击面从"读出即用"变成"需口令 + 需算力"。
 *
 * ## 为什么轮转变便宜了
 *
 * 轮换主口令 = 用新口令派生新 KEK → 用新 KEK **重裹同一个 DEK** →
 * 覆盖 `wrappedDek` 并把 `kekVersion` 加一。`config.enc` 等数据文件
 * **一个字节都不动**，所以能做成前端一键、秒级返回（见 `rewrap()`）。
 *
 * 这与"轮换 DEK"是两件事：后者（怀疑 DEK 本身泄露）才需要重加密全部数据，
 * 由 `key-rotate.js` 里的迁移 / 重加密流程承担。
 *
 * ## 三条不能破的纪律
 *
 * ① **解析失败绝不覆盖**（FUN-04 / R28-04 同源）。`keyring.json` 存在但读不懂时，
 *    说明它可能被篡改、被截断、或来自更新的格式 —— 此时**宁可起不来**，也不能
 *    凭空生成一份新的把它盖掉：那等于把全部历史数据判死刑。旧 `secret.key` 的
 *    `getMasterKey()` 早就是这么做的，这里沿用同一套语义。
 * ② **绝不在校验通过之前动旧 wrappedDek**。`rewrap()` 先解包成功、再计算新包裹、
 *    最后才原子写；任何一步失败都返回错误且磁盘保持原样。
 * ③ **KEK 不缓存**。缓存 DEK 是必要的（每次加解密都要用，且它是内存态的固有
 *    属性）；缓存 KEK 则没有任何收益、只会让"口令改了但进程里还留着旧 KEK"
 *    这种状态有机会存在。所以 `unlock()` 里算出的 KEK 只作为局部变量。
 *
 * ## 解锁状态与"文件身份"
 *
 * 内存里的 DEK 绑定它**是从哪个 keyring 文件解出来的**（`state.path`）。
 * 原因是测试与多实例场景：设了 `S3_DATA_DIR` 换目录后，上一个目录的解锁状态
 * 不能让新目录"看起来已解锁"—— 否则新目录会用旧 DEK 去解密自己的文件，
 * 表现是"文件全部损坏"而不是"尚未解锁"，排查方向会被彻底带偏。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const atomic = require('./atomic-write');
const { dataDir } = require('./data-dir');

/** 文件名（放在数据目录下，与 `secret.key` / `config.enc` 同级） */
const KEYRING_NAME = 'keyring.json';

/**
 * 启动期自动解锁因子的环境变量名。
 *
 * 用途只有无头部署：容器 / systemd 重启后没人能点前端，靠它自动解锁。
 * 显式写在部署文档里，并明确"它等价于主口令，必须按机密管理"。
 */
const ENV_PASSPHRASE = 'KEPLER_MASTER_PASSPHRASE';

/** 信封容器版本（与 `config.enc` 的密文格式版本是两回事，后者见 secure-store 的 `_enc`） */
const FORMAT_VERSION = 1;

/**
 * KDF 成本参数。
 *
 * ⚠️ 数值必须与 `config-store.SCRYPT_PARAMS` **保持一致**，理由不是"省事"而是
 * 用户心智：同一个实例上，"登录口令哈希"与"主口令派生 KEK"的强度不一致时，
 * 弱的那一侧就是整套系统的实际强度下限。两处定义是为了切断循环依赖
 * （`config-store` 要 `require` 本模块），一致性由
 * `tests/keyring.test.js` 的一条断言守住 —— 改一处而忘另一处会当场变红。
 *
 * ⚠️ `maxmem` 必须显式给：N=2^17、r=8 需要 `128*N*r` = 128MB，Node 默认上限
 * 32MB，不给会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
 */
const KDF_PARAMS = { N: 131072, r: 8, p: 1 };
const SCRYPT_MAXMEM = 192 * 1024 * 1024;

const SALT_BYTES = 16;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** iv(12) + tag(16) + 至少 1 字节密文 */
const MIN_SEALED_BYTES = IV_BYTES + TAG_BYTES + 1;

/** 当前进程内的解锁状态（DEK 只在内存） */
const state = { path: '', dek: null };

/**
 * 锁定时要一并清掉的外部状态（由 `config-store` 注册）。
 *
 * 为什么需要它：`config-store` 的 `load()` 有一份 60 秒 TTL 的**解密后配置缓存**。
 * 只把 DEK 抹掉而留着这份缓存，"锁定"就只是名义上的 —— 锁定期内任何一次
 * `load()` 仍会命中缓存，把用户 / 桶 / 云厂商密钥照常吐出来。
 *
 * 用回调而不是让本模块去 `require('./config-store')` 清缓存，是为了守住单向依赖
 * （反向 require 会成环）。注册发生在 `config-store` 的模块加载期，因此任何
 * 一条 `lock()` 调用路径都会先清缓存、再抹密钥，顺序天然正确。
 */
let onLock = null;

function setOnLock(fn) {
  onLock = typeof fn === 'function' ? fn : null;
}

/**
 * 「DEK 状态变了」的清理钩子（R104 / F-01）。
 *
 * `onLock` 只够 `config-store` 一个模块用（它是单槽，且语义是「锁定前清缓存」）。
 * 但 `secure-store` 之上还有 10 个模块各自缓存着**解密后的**数据表
 * （分享链接 / 上传会话 / IP 规则 / 订单 / 券 / 邀请码 / 下载记录 / 取回封禁 /
 * 加密设置与元数据）。它们与 DEK 的关系比 config-store 更弱，却同样必须遵守一条：
 *
 *   **内存里那份表，必须与「当前 DEK 能读到的磁盘内容」同步。**
 *
 * 锁定态的读盘必然失败（`KEYRING_LOCKED`）。若某个模块把这次失败当成「空表」缓存
 * 下来，解锁之后它仍然拿着空表 —— 下一次写入就把整份数据覆盖成空（不可逆）。
 * 所以：解锁 / 加锁 / 新建信封之后，一律丢掉这些缓存，让下一次读重新落到磁盘上。
 *
 * 用注册表而不是再开一个单槽：条数不确定（未来还会加 store），单槽必然被后注册者
 * 覆盖，而那正是「看起来接了钩子、其实只接了一个」的假绿。
 */
const resetHooks = [];

function addResetHook(fn) {
  if (typeof fn === 'function' && resetHooks.indexOf(fn) < 0) resetHooks.push(fn);
}

/** 依次调用清理钩子；任何一条抛错都不影响其余（清理失败不该让解锁失败） */
function runResetHooks() {
  for (const fn of resetHooks) {
    try { fn(); } catch (e) {
      console.error('[keyring] 密钥状态变化后清理缓存失败：', (e && e.message) || e);
    }
  }
}

function keyringPath() {
  return path.join(dataDir(), KEYRING_NAME);
}

function exists() {
  return fs.existsSync(keyringPath());
}

/**
 * 构造"锁定态"错误。
 *
 * 调用方（`config-store.load()`）必须能把它与"配置损坏"区分开：锁定是**正常
 * 运行状态**（重启后尚未解锁），而损坏是**故障**。混为一谈的后果很具体 ——
 * 锁定被当成损坏之后，`persist()` 会拒绝写入并备份 `config.enc`，于是一次
 * 正常的重启会让运维看到一份"配置损坏"的备份文件。
 */
function lockedError(why) {
  const err = new Error(why || '主密钥处于锁定状态：请先提供主口令解锁');
  err.code = 'KEYRING_LOCKED';
  err.status = 503;
  err.locked = true;
  return err;
}

/** 口令错误（与"容器损坏"分开：前者是用户可纠正的，后者要运维介入） */
function badPassphraseError() {
  const err = new Error('主口令不正确');
  err.code = 'KEYRING_BAD_PASSPHRASE';
  err.status = 401;
  return err;
}

/**
 * 容器不可用（格式不认识 / 字段缺失 / 被截断）。
 *
 * 与 `config-store.unwritableError` 同语义：先备份一份再抛，让"不可逆"降级为
 * "可人工恢复"，并**拒绝任何写入**。本模块不能 `require('./config-store')`
 * （那是循环依赖），所以这里自带一份最小实现 —— 语义必须保持一致。
 */
/**
 * 找出「已经是这份 `keyring.json` 当前状态的副本」的备份文件（R101 / F-07）。
 *
 * 判据只有一条：备份的 mtime **不早于** 源文件的 mtime。含义是"这份备份是在源文件
 * 最后一次被改动之后拍的"，因此它就是源文件现在的样子，不必再复制一份。
 * 源文件被替换 / 编辑过 ⇒ 它的 mtime 变新 ⇒ 备份 mtime 更早 ⇒ 不复用、重新留档。
 *
 * 目录读不出来、没有备份、备份比源文件旧 —— 一律返回 ''（调用方照常新建备份）。
 */
function reuseCorruptBackup(file) {
  try {
    const src = fs.statSync(file);
    const dir = path.dirname(file);
    const base = path.basename(file) + '.corrupt-';
    let best = '';
    let bestMs = -1;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (st.mtimeMs > bestMs) { bestMs = st.mtimeMs; best = full; }
    }
    return best && bestMs >= src.mtimeMs ? best : '';
  } catch (e) {
    return '';
  }
}

function corruptError(why) {
  const file = keyringPath();
  let bak = '';
  try {
    if (fs.existsSync(file)) {
      /**
       * R101（F-07）：**同一个损坏文件只备份一次**。
       *
       * 旧实现每次走这里都 `copyFileSync` 出一份 `.corrupt-<ts>`。而 `read()` 的
       * 解析失败会抛本错误，`GET /key/status` 又在 `PUBLIC_API` 里（匿名可达、
       * 没有自己的限流），它每次都经 `keyRotate.status()` → `info()` → `read()`
       * 走到这里 —— 于是**一个匿名请求 = 一个新文件**。容器坏掉正是最需要这份
       * 备份的时刻，却也正好是最容易被灌满磁盘 / inode 的时刻，而每个备份里都
       * 有一份 `wrappedDek`，数量膨胀同时放大了敏感文件的暴露面。
       *
       * 判据用**修改时间**而不是"存在任意备份就复用"：`keyring.json` 一旦被管理员
       * 动过（时间戳变新），说明这是一次**新的**损坏，必须重新留档；没动过则说明
       * 那份备份就是它的当前副本，复制第二份只会多占一块磁盘。
       */
      bak = reuseCorruptBackup(file) || `${file}.corrupt-${Date.now()}`;
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    }
  } catch (e) {
    bak = '';
  }
  const err = new Error(
    `${KEYRING_NAME} ${why}；为防覆盖造成的不可逆数据丢失，`
    + (bak ? `已备份为 ${path.basename(bak)}，` : '（备份失败，请立即手工复制该文件）')
    + '并拒绝写入。请确认该文件来源后手工处理，再重启服务。'
  );
  err.status = 500;
  err.code = 'KEYRING_CORRUPT';
  err.corrupt = true;
  err.file = file;
  return err;
}

function isHex(v, bytes) {
  return typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/i.test(v);
}

/**
 * 读取并校验 `keyring.json`（不做任何解密）。
 *
 * 只校验**结构**是否可理解，不校验内容真伪 —— 后者要靠 `unlock()` 的 GCM 认证。
 */
function read() {
  const file = keyringPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw corruptError('不是合法 JSON（可能被截断或损坏）');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw corruptError('顶层不是对象');
  }
  if (Number(obj.v) !== FORMAT_VERSION) {
    // 不认识的版本绝不能"尽力而为"地解 —— 新版可能换了 KDF 或包裹算法，
    // 硬解只会得到一个错误的 DEK，然后用它去"解密"出一堆垃圾。
    throw corruptError(`版本 ${JSON.stringify(obj.v)} 不受支持（本程序支持 ${FORMAT_VERSION}）`);
  }
  if (obj.kdf !== 'scrypt') {
    throw corruptError(`KDF ${JSON.stringify(obj.kdf)} 不受支持（本程序支持 scrypt）`);
  }
  if (!isHex(obj.salt, SALT_BYTES)) {
    throw corruptError('盐字段缺失或长度不对');
  }
  const kdfParams = obj.kdfParams;
  if (!kdfParams || typeof kdfParams !== 'object'
    || !Number.isFinite(Number(kdfParams.N)) || !Number.isFinite(Number(kdfParams.r))
    || !Number.isFinite(Number(kdfParams.p))) {
    throw corruptError('KDF 参数缺失或不完整');
  }
  if (typeof obj.wrappedDek !== 'string'
    || Buffer.from(obj.wrappedDek, 'base64').length < MIN_SEALED_BYTES) {
    throw corruptError('包裹后的密钥长度不对（可能被截断）');
  }
  return obj;
}

/** 主口令派生 KEK —— 异步 scrypt，绝不使用同步版（会整段占住事件循环） */
function deriveKek(passphrase, saltHex, params) {
  const p = params && Number.isFinite(Number(params.N)) ? params : KDF_PARAMS;
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase), Buffer.from(saltHex, 'hex'), DEK_BYTES, {
      N: Number(p.N), r: Number(p.r), p: Number(p.p), maxmem: SCRYPT_MAXMEM,
    }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

/**
 * 用 KEK 包裹 DEK：`base64( iv(12) | tag(16) | ciphertext )`。
 *
 * 格式与 `config-store.encrypt()` 完全一致是**有意**的 —— 同一个项目里只留一种
 * 密文排布，读代码的人不必记两套。
 */
function sealDek(kek, dek) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/**
 * 用 KEK 解包 DEK。
 *
 * 认证失败（口令错）与结构非法（长度不对）分别抛不同错误：前者是用户敲错了，
 * 后者是文件坏了。对外文案统一（不给爆破者区分口径），但日志与内部调用要能分开。
 */
function unsealDek(kek, b64) {
  const raw = Buffer.from(String(b64 || ''), 'base64');
  if (raw.length < MIN_SEALED_BYTES) throw corruptError('包裹后的密钥长度不对');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = raw.subarray(IV_BYTES + TAG_BYTES);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (e) {
    throw badPassphraseError();
  }
  if (plain.length !== DEK_BYTES) throw corruptError('解出的密钥长度不对');
  return plain;
}

/**
 * 原子写 `keyring.json`（0600）。
 *
 * 先写 `wrappedDek` 与元数据，**一次** `rename` 到位 —— 绝不允许出现
 * "新 salt + 旧 wrappedDek" 这种中间态：那份组合永远解不开，而它只要被写到
 * 磁盘上一次，用户就永久失去了 DEK。
 */
function writeRing(obj) {
  const file = keyringPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomic.writeAtomicSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) { /* 部分平台不支持 */ }
}

/* ============================ 解锁状态 ============================ */

/**
 * 是否已解锁。
 *
 * 判据里有 `state.path === keyringPath()` 这一条：换数据目录之后，旧目录的
 * 解锁状态必须**自动失效**，否则新目录会拿旧 DEK 去解密自己的文件 —— 现象会是
 * "文件全部损坏"，而真相是"还没解锁"。这类错误诊断成本极高，所以在入口挡掉。
 */
function isUnlocked() {
  return Boolean(state.dek) && state.path === keyringPath();
}

/**
 * 取当前 DEK。未解锁时抛 `KEYRING_LOCKED`。
 *
 * ⚠️ 返回的是**模块内部同一份 Buffer**，调用方只读不改。`config-store` 拿它去
 * `createCipheriv` 是只读使用，符合约定；将来若有人想"顺手改一位做派生"，
 * 请另复制一份 —— 改这个 Buffer 等于当场把整个实例的数据锁死。
 */
function dek() {
  if (!isUnlocked()) throw lockedError();
  return state.dek;
}

function lock() {
  // 先清外部缓存（解密后的配置），再抹密钥 —— 顺序不能反：中间若抛错，
  // 也必须是"缓存已清、密钥还在"而不是相反。
  if (onLock) {
    try { onLock(); } catch (e) { /* 清缓存失败不该阻止抹密钥 */ }
  }
  // 尽力把内存里的密钥抹掉（V8 下不保证，但比留着好），再清引用
  if (Buffer.isBuffer(state.dek)) state.dek.fill(0);
  state.dek = null;
  state.path = '';
  /**
   * R104（F-01）：锁定后**内存里不该再留着任何解密过的数据表**。
   *
   * 放在抹密钥**之后**：钩子的语义是「现在是锁定态，缓存一律作废」，而不是
   * 「趁 DEK 还在清一次缓存」。清理失败只能记日志 —— 它不该让一次锁定失败。
   */
  runResetHooks();
}

/**
 * 用主口令解锁。
 *
 * @param {string} passphrase 主口令
 * @returns {Promise<{kekVersion:number, createdAt:string, rotatedAt:string}>} 无敏感字段的元信息
 * @throws KEYRING_BAD_PASSPHRASE 口令错 / KEYRING_CORRUPT 容器坏 / 无 keyring 文件
 */
async function unlock(passphrase) {
  const pw = String(passphrase == null ? '' : passphrase);
  if (!pw) {
    const err = new Error('主口令不能为空');
    err.status = 400;
    throw err;
  }
  const ring = read();
  if (!ring) {
    const err = new Error(`找不到 ${KEYRING_NAME}：该实例尚未启用信封加密`);
    err.status = 404;
    err.code = 'KEYRING_ABSENT';
    throw err;
  }
  const kek = await deriveKek(pw, ring.salt, ring.kdfParams);
  const plain = unsealDek(kek, ring.wrappedDek);
  // 走到这里说明 KEK 正确（GCM 认证通过）。KEK 作为局部变量随函数返回被回收。
  if (Buffer.isBuffer(state.dek)) state.dek.fill(0);
  state.dek = plain;
  state.path = keyringPath();
  /**
   * R104（F-01）：解锁后**必须**让锁定期被读空的缓存重新落回磁盘。
   *
   * 锁定期各 store 的读盘会拿到 `KEYRING_LOCKED`（它们已不再把这次失败缓存成
   * 空表，见 `addResetHook` 的说明）；但「当时代码路径已经把某份旧缓存留在内存里」
   * 的情形只能在这里一次性作废 —— 否则解锁只是「能解密了」，并不会让任何人**去**解密。
   */
  runResetHooks();
  return info(ring);
}

/**
 * 首次建立信封（迁移器调用）。
 *
 * @param {string} passphrase 主口令
 * @param {Buffer} dekBuffer 要包裹的 DEK（迁移时就是旧的 `secret.key`，
 *   也可传空由本函数生成 —— 前者省一次全量重加密，后者是"怀疑 DEK 泄露"的止损路径）
 * @returns {Promise<object>} 写入的容器（无明文）
 */
async function create(passphrase, dekBuffer) {
  const pw = String(passphrase == null ? '' : passphrase);
  if (!pw) {
    const err = new Error('主口令不能为空');
    err.status = 400;
    throw err;
  }
  if (exists()) {
    // 绝不覆盖已有容器：那是现有数据的唯一解密凭据（FUN-04 同源纪律）
    const err = new Error(`${KEYRING_NAME} 已存在，拒绝覆盖（如需重建请先人工处理该文件）`);
    err.status = 409;
    err.code = 'KEYRING_EXISTS';
    throw err;
  }
  const dekBuffer2 = dekBuffer || crypto.randomBytes(DEK_BYTES);
  if (!Buffer.isBuffer(dekBuffer2) || dekBuffer2.length !== DEK_BYTES) {
    throw new Error('DEK 必须是 32 字节 Buffer');
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const kek = await deriveKek(pw, salt, KDF_PARAMS);
  const now = new Date().toISOString();
  const ring = {
    v: FORMAT_VERSION,
    kekVersion: 1,
    kdf: 'scrypt',
    kdfParams: { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p },
    salt,
    wrappedDek: sealDek(kek, dekBuffer2),
    createdAt: now,
    rotatedAt: now,
  };
  writeRing(ring);
  if (Buffer.isBuffer(state.dek)) state.dek.fill(0);
  state.dek = Buffer.from(dekBuffer2); // 存副本：调用方的 Buffer 可能被它自己改
  state.path = keyringPath();
  runResetHooks(); // R104（F-01）：与 unlock() 同一口径（DEK 换了就必须重读）
  return info(ring);
}

/**
 * 轮换主口令：**重裹同一个 DEK**，数据文件一个字节都不动。
 *
 * 顺序（每一步都不能换）：
 *  ① 校验当前口令（解包成功才继续）—— 失败即返回 401，磁盘原样；
 *  ② 用新盐派生新 KEK；
 *  ③ 用新 KEK 包裹**同一个 DEK**；
 *  ④ 原子写 `kekVersion + 1`。
 *
 * 关键点是 ③④ 之间没有任何 await 之外的 IO：不会出现"新盐写下去、旧包裹还在"
 * 的窗口。
 *
 * @returns {Promise<{kekVersion:number, rotatedAt:string}>}
 */
async function rewrap(currentPassphrase, newPassphrase) {
  const cur = String(currentPassphrase == null ? '' : currentPassphrase);
  const next = String(newPassphrase == null ? '' : newPassphrase);
  if (!cur) {
    const err = new Error('当前主口令不能为空');
    err.status = 400;
    throw err;
  }
  if (!next) {
    const err = new Error('新主口令不能为空');
    err.status = 400;
    throw err;
  }
  const ring = read();
  if (!ring) {
    const err = new Error(`找不到 ${KEYRING_NAME}：该实例尚未启用信封加密`);
    err.status = 404;
    err.code = 'KEYRING_ABSENT';
    throw err;
  }
  // ① 当前口令必须能解开现有容器（等价于"当前 KEK 有效"）
  const kekOld = await deriveKek(cur, ring.salt, ring.kdfParams);
  const plain = unsealDek(kekOld, ring.wrappedDek);
  // ②③ 新盐 + 新 KEK，重裹同一份 DEK
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const kekNew = await deriveKek(next, salt, KDF_PARAMS);
  const now = new Date().toISOString();
  const updated = {
    ...ring,
    kekVersion: Number(ring.kekVersion || 1) + 1,
    salt,
    kdfParams: { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p },
    wrappedDek: sealDek(kekNew, plain),
    rotatedAt: now,
  };
  // ④ 原子写
  writeRing(updated);
  if (Buffer.isBuffer(state.dek)) state.dek.fill(0);
  state.dek = plain;
  state.path = keyringPath();
  return info(updated);
}

/** 对外可见的元信息（**绝不含** salt / wrappedDek / 任何明文） */
function info(ring) {
  const r = ring || (exists() ? read() : null);
  if (!r) return null;
  return {
    v: r.v,
    kekVersion: Number(r.kekVersion) || 1,
    kdf: r.kdf,
    kdfParams: { N: Number(r.kdfParams.N), r: Number(r.kdfParams.r), p: Number(r.kdfParams.p) },
    createdAt: r.createdAt || '',
    rotatedAt: r.rotatedAt || '',
    unlocked: isUnlocked(),
  };
}

/**
 * 启动期自动解锁（无头部署）。
 *
 * 只在**尚未解锁**且**存在 keyring** 时尝试；口令来自环境变量。
 * 失败不抛：服务照常起来，处于锁定态等人工解锁 —— 这是刻意的取舍。
 * 若在启动期因为口令写错就直接退出，容器会陷入"起不来 → 看不到日志 → 改不对
 * 环境变量"的循环，而锁定态至少能让管理员看到页面并手工解锁。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function autoUnlockFromEnv() {
  if (isUnlocked()) return { ok: true, reason: 'already' };
  if (!exists()) return { ok: false, reason: 'absent' };
  const pw = String(process.env[ENV_PASSPHRASE] || '');
  if (!pw) return { ok: false, reason: 'no-passphrase' };
  try {
    await unlock(pw);
    return { ok: true, reason: 'env' };
  } catch (e) {
    // 区分"口令错"（多半是部署配置写错）与"容器坏"（要运维介入），日志要能看出来
    return { ok: false, reason: (e && e.code) || 'error' };
  }
}

module.exports = {
  KEYRING_NAME,
  ENV_PASSPHRASE,
  FORMAT_VERSION,
  KDF_PARAMS,
  keyringPath,
  exists,
  read,
  isUnlocked,
  dek,
  lock,
  unlock,
  create,
  rewrap,
  info,
  autoUnlockFromEnv,
  setOnLock,
  // R104（F-01）：DEK 状态变化后的缓存作废钩子（secure-store 之上的 store 自注册）
  addResetHook,
  // 供迁移器 / 测试复用
  deriveKek,
  sealDek,
  unsealDek,
  lockedError,
};
