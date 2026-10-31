/**
 * 测试：主密钥信封（R97）—— 内核与「锁定 ≠ 损坏」纪律
 *
 * 这一层只用真实密码学（scrypt / AES-256-GCM），不打桩：包裏 / 解开全是
 * 几行就写错、且错了很难在别处暴露的地方（盐没换、认证标签没用上、
 * 锁定态退回去读旧密钥……）。打桩测这些等于测自己的桩。
 *
 * 每个用例自带一个独立临时数据目录 —— `config-store` 的 `DATA_DIR` 是模块级常量，
 * 所以换目录必须连 `require` 缓存一起清（`fresh()` 做这件事）。
 */
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('crypto');

const { assert, assertEqual, ROOT, assertReject } = require('./helpers');

/** 清掉 server 目录下的模块缓存（数据目录是模块级常量，不清理就会沿用上一个目录） */
function clearServer() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'server'))) delete require.cache[k];
  }
}

/** 在指定目录下加载一套全新的 server 模块 */
function fresh(dir) {
  process.env.S3_DATA_DIR = dir;
  clearServer();
  return {
    keyring: require(path.join(ROOT, 'server', 'keyring.js')),
    configStore: require(path.join(ROOT, 'server', 'config-store.js')),
    keyRotate: require(path.join(ROOT, 'server', 'key-rotate.js')),
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-keyring-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
}

/* ================================================================== *
 * 1 · KDF 与包裹的密码学契约
 * ================================================================== */

test('R97-01 · KDF 参数与 config-store.SCRYPT_PARAMS 同值（两处定义不得漂移）', () => {
  const dir = tmp();
  try {
    const { keyring, configStore } = fresh(dir);
    /**
     * 为什么必须同值：`keyring` 不能 `require('./config-store')`（那是循环依赖），
     * 所以 KDF 参数在本模块另写了一份。两份定义唯一的护栏就是这条断言 ——
     * 强度不一致时，弱的那一侧就是整套系统的实际强度下限。
     */
    assertEqual(keyring.KDF_PARAMS.N, configStore.SCRYPT_PARAMS.N, 'N 必须一致');
    assertEqual(keyring.KDF_PARAMS.r, configStore.SCRYPT_PARAMS.r, 'r 必须一致');
    assertEqual(keyring.KDF_PARAMS.p, configStore.SCRYPT_PARAMS.p, 'p 必须一致');
    assertEqual(keyring.KDF_PARAMS.N, 131072, 'N 不得低于 OWASP 下限 2^17');
  } finally { cleanup(dir); }
});

test('R97-02 · 同口令同盐派生同一 KEK，换盐即换 KEK（派生是确定的、盐是有效的）', async () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const saltA = crypto.randomBytes(16).toString('hex');
    const saltB = crypto.randomBytes(16).toString('hex');
    const k1 = await keyring.deriveKek('same-passphrase', saltA, keyring.KDF_PARAMS);
    const k2 = await keyring.deriveKek('same-passphrase', saltA, keyring.KDF_PARAMS);
    const k3 = await keyring.deriveKek('same-passphrase', saltB, keyring.KDF_PARAMS);
    assert(k1.equals(k2), '同口令同盐必须得到同一个 KEK（否则重启后解不开）');
    assert(!k1.equals(k3), '换盐必须换 KEK（否则盐形同虚设）');
    assertEqual(k1.length, 32, 'KEK 必须是 32 字节（AES-256）');
  } finally { cleanup(dir); }
});

test('R97-03 · 包裹往返：解出的 DEK 与原文逐字节相同，且包裹结果不含明文', () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const kek = crypto.randomBytes(32);
    const dek = crypto.randomBytes(32);
    const sealed = keyring.sealDek(kek, dek);
    assert(!sealed.includes(dek.toString('hex')), '包裹结果不得含 DEK 的 hex');
    assert(!sealed.includes(dek.toString('base64')), '包裹结果不得含 DEK 的 base64');
    const back = keyring.unsealDek(kek, sealed);
    assert(back.equals(dek), '解包必须还原出同一把 DEK');
    // 同一把 KEK、同一个 DEK，两次包裹必须不同（IV 随机）—— 否则相同明文得出相同密文
    assert(keyring.sealDek(kek, dek) !== sealed, '两次包裹结果必须不同（IV 必须随机）');
  } finally { cleanup(dir); }
});

test('R97-04 · 用错误的 KEK 解包必须失败（GCM 认证标签生效，不是"解出一堆乱码"）', () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const sealed = keyring.sealDek(crypto.randomBytes(32), crypto.randomBytes(32));
    let err = null;
    try { keyring.unsealDek(crypto.randomBytes(32), sealed); } catch (e) { err = e; }
    assert(err, '错误的 KEK 必须解包失败');
    assertEqual(err.code, 'KEYRING_BAD_PASSPHRASE', '失败要能识别为"口令不对"而不是"文件坏了"');
  } finally { cleanup(dir); }
});

/* ================================================================== *
 * 2 · 容器生命周期
 * ================================================================== */

test('R97-05 · create → lock → unlock → rewrap：秘钥不变、版本递增、旧口令立即失效', async () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const dek0 = crypto.randomBytes(32);
    const info1 = await keyring.create('first-passphrase', dek0);
    assertEqual(info1.kekVersion, 1, '首次创建 kekVersion=1');

    const ring1 = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'));
    assertEqual(ring1.v, keyring.FORMAT_VERSION, '容器带格式版本号');
    assert(ring1.wrappedDek && ring1.salt, '容器含 wrappedDek 与 salt');
    assertEqual(ring1.kdf, 'scrypt', 'KDF 名字要落盘（否则将来换算法就解不开旧容器）');

    keyring.lock();
    assertEqual(keyring.isUnlocked(), false, 'lock 后回到锁定态');
    let e = null;
    try { keyring.dek(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_LOCKED', '锁定态取 DEK 抛 KEYRING_LOCKED');

    await assertReject(() => keyring.unlock('wrong-passphrase'), '错误口令必须拒绝');
    assertEqual(keyring.isUnlocked(), false, '口令错误后仍是锁定态');

    await keyring.unlock('first-passphrase');
    assert(keyring.dek().equals(dek0), '解锁后拿回同一把 DEK');

    const info2 = await keyring.rewrap('first-passphrase', 'second-passphrase');
    assertEqual(info2.kekVersion, 2, '轮转后 kekVersion 递增');
    assert(keyring.dek().equals(dek0), '轮转只重裹，DEK 必须不变');

    const ring2 = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'));
    assert(ring2.salt !== ring1.salt, '轮转必须换新盐');
    assert(ring2.wrappedDek !== ring1.wrappedDek, '轮转必须换新包裹');

    keyring.lock();
    await assertReject(() => keyring.unlock('first-passphrase'), '轮转后旧口令必须失效');
    await keyring.unlock('second-passphrase');
    assert(keyring.dek().equals(dek0), '新口令解锁得到同一把 DEK');
  } finally { cleanup(dir); }
});

test('R97-06 · create 拒绝覆盖已有容器（那是现有数据的唯一解密凭据）', async () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    await keyring.create('pass-a', crypto.randomBytes(32));
    let e = null;
    try { await keyring.create('pass-b', crypto.randomBytes(32)); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_EXISTS', '重复 create 必须被拒绝而不是覆盖');
  } finally { cleanup(dir); }
});

test('R97-07 · 容器无法解析时：报错、备份、且**绝不覆盖**（FUN-04 同源）', () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const file = path.join(dir, 'keyring.json');
    fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
    let e = null;
    try { keyring.read(); } catch (x) { e = x; }
    assert(e, '坏容器必须抛错');
    assertEqual(e.code, 'KEYRING_CORRUPT', '错误要能识别为容器损坏');
    assertEqual(fs.readFileSync(file, 'utf8'), '{ 这不是合法 JSON', '原文件必须原样保留');
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assertEqual(backups.length, 1, '必须留有 .corrupt-* 备份供人工恢复');
  } finally { cleanup(dir); }
});

test('R97-08 · 版本号不认识时拒绝解析（不"尽力而为"地解出错误密钥）', () => {
  const dir = tmp();
  try {
    const { keyring } = fresh(dir);
    const file = path.join(dir, 'keyring.json');
    fs.writeFileSync(file, JSON.stringify({
      v: 99, kekVersion: 1, kdf: 'scrypt',
      kdfParams: { N: 131072, r: 8, p: 1 },
      salt: '00'.repeat(16), wrappedDek: Buffer.alloc(64).toString('base64'),
      createdAt: '', rotatedAt: '',
    }), 'utf8');
    let e = null;
    try { keyring.read(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_CORRUPT', '未知版本必须拒绝');
    assert(/99/.test(e.message), '错误信息要带上那个不认识的版本号');
  } finally { cleanup(dir); }
});

/* ================================================================== *
 * 3 · 「锁定 ≠ 损坏」（本改造最容易写错的一处）
 * ================================================================== */

test('R97-09 · 锁定态：取主密钥抛 LOCKED，且**不会**退回生成 secret.key', async () => {
  const dir = tmp();
  try {
    const { keyring, configStore } = fresh(dir);
    await keyring.create('pass-x', crypto.randomBytes(32));
    keyring.lock();

    let e = null;
    try { configStore.getMasterKey(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_LOCKED', '锁定态必须抛 KEYRING_LOCKED');

    /**
     * 这一条是本轮最贵的护栏：`getMasterKey()` 的旧逻辑在"密钥文件不存在"时会
     * **生成一把新密钥并落盘**。若锁定态被误判成"没有密钥"，就会在这里凭空造出
     * 一份 `secret.key` —— 而它会成为下一次"解密失败 → 判损坏"的起点。
     */
    assertEqual(fs.existsSync(path.join(dir, 'secret.key')), false,
      '锁定态绝不允许生成新的明文密钥文件');
  } finally { cleanup(dir); }
});

test('R97-10 · 锁定态：load() 抛 LOCKED 且不得被判为"配置损坏"', async () => {
  const dir = tmp();
  try {
    const { keyring, configStore } = fresh(dir);
    const dek = crypto.randomBytes(32);
    await keyring.create('pass-y', dek);
    configStore.getMasterKey();
    configStore.save({ site: { name: '锁定期测试站' } });
    configStore.flushPending();
    await new Promise((r) => setTimeout(r, 400));
    assert(fs.existsSync(path.join(dir, 'config.enc')), '前置：已写出 config.enc');

    keyring.lock();
    let e = null;
    try { configStore.load(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_LOCKED', '锁定态 load() 必须抛 KEYRING_LOCKED（抛而不是返回 null）');
    assertEqual(Boolean(e.locked), true, '错误要带 locked 标记供中间件识别');
    assertEqual(configStore.isCorrupted(), false, '锁定态**不得**被判为损坏');

    // 关键：不能因为一次锁定就冒出 .corrupt-* 备份（那会把人引向"恢复数据"的错误方向）
    const backup = fs.readdirSync(dir).filter((f) => f.includes('config.enc.corrupt-'));
    assertEqual(backup.length, 0, '锁定态不得产生 config.enc 的损坏备份');
  } finally { cleanup(dir); }
});

test('R97-11 · 解锁后一切恢复，且锁定时清掉了"解密后的配置缓存"', async () => {
  const dir = tmp();
  try {
    const { keyring, configStore } = fresh(dir);
    await keyring.create('pass-z', crypto.randomBytes(32));
    configStore.getMasterKey();
    // 注意：写 `site.name` 会被 schema 归一化掉（字段名是 `siteName`）——
    // 那样"配置读回来了"就退化成读取永远成功的默认值，断言等于没断言。
    configStore.save({ site: { siteName: '缓存清理测试' } });
    configStore.flushPending();
    await new Promise((r) => setTimeout(r, 400));

    const before = configStore.load();
    assert(before && before.site && before.site.siteName === '缓存清理测试', '前置：解锁态可读配置');

    keyring.lock();
    /**
     * 只抹 DEK 而留着 60 秒 TTL 的解密缓存，"锁定"就只是名义上的 ——
     * 锁定期内任何一次 load() 仍会命中缓存把敏感内容交出去。
     * `setOnLock` 回调就是为这一条存在的。
     */
    let e = null;
    try { configStore.load(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_LOCKED', '锁定后 load() 不得再命中缓存');

    await keyring.unlock('pass-z');
    const after = configStore.load();
    assert(after && after.site && after.site.siteName === '缓存清理测试', '解锁后配置恢复可读');
  } finally { cleanup(dir); }
});

test('R97-12 · 换数据目录后解锁状态自动失效（旧 DEK 不得被带到新目录）', async () => {
  const dirA = tmp();
  const dirB = tmp();
  try {
    const a = fresh(dirA);
    await a.keyring.create('pass-dir', crypto.randomBytes(32));
    assertEqual(a.keyring.exists(), true, 'A 目录有容器');

    const b = fresh(dirB);
    assertEqual(b.keyring.isUnlocked(), false, '换目录后必须视为未解锁');
    assertEqual(b.keyring.exists(), false, 'B 目录没有容器');
  } finally { cleanup(dirA); cleanup(dirB); }
});

test('R97-13 · 锁定态读加密文件：报 LOCKED，且**不得**把它钉成"损坏、只读"', async () => {
  const dir = tmp();
  try {
    const { keyring, configStore } = fresh(dir);
    const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
    configStore.save({ site: { siteName: '文件存储哨兵' } });
    configStore.flushPending();
    await new Promise((r) => setTimeout(r, 400));
    await keyring.create('pass-s', Buffer.from(configStore.getMasterKey()));

    const file = path.join(dir, 'enc-meta.json');
    secureStore.writeJson(file, { a: 1 });

    keyring.lock();
    let e = null;
    try { secureStore.readJson(file, null); } catch (x) { e = x; }
    /**
     * `corruptError()` 做的是两件**不可逆**的事：把文件备份成 `.corrupt-<ts>`，
     * 并把它加进 `corruptFiles` —— 后者意味着**本进程内永久拒绝写入**。
     * 对 `enc-meta.json` 来说那就是「新密文的元数据写不进去 ⇒ 那些密文不可解」。
     * 一次普通的重启（重启后必然处于锁定态）就会触发它，解锁也救不回来。
     */
    assertEqual(e && e.code, 'KEYRING_LOCKED', '锁定态读加密文件必须报 LOCKED 而不是"损坏"');

    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assertEqual(backups.length, 0, '锁定态不得产生 .corrupt-* 备份');
    assertEqual(secureStore.corruptList().indexOf(file), -1, '锁定态不得把文件拉进"永久拒写"名单');

    await keyring.unlock('pass-s');
    const back = secureStore.readJson(file, null);
    assertEqual(back && back.a, 1, '解锁后必须能正常读回');
  } finally { cleanup(dir); }
});
