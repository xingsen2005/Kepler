/**
 * 测试：迁移与轮转编排（R97）—— 「只重裹不重加密」这件事本身要被守住
 *
 * `keyring.test.js` 守的是**密码学契约**（包裹/解开对不对）；
 * 本文件守的是**流程契约**：迁移是不是原子的、验证失败会不会回滚、
 * 轮转之后登录口令与 KEK 是否仍然一致。
 *
 * 这里所有断言都落在**真实文件与真实 scrypt** 上，不打桩。理由与 keyring 那份相同：
 * 这几条错了的表现是"迁移看起来成功了、重启后数据打不开"—— 除了一次真重启，
 * 没有别的地方会暴露它。
 */
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assert, assertEqual, assertReject, ROOT } = require('./helpers');

function clearServer() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'server'))) delete require.cache[k];
  }
}

/** 在指定目录下加载一套全新的 server 模块（数据目录是模块级常量） */
function fresh(dir) {
  process.env.S3_DATA_DIR = dir;
  clearServer();
  return {
    keyring: require(path.join(ROOT, 'server', 'keyring.js')),
    configStore: require(path.join(ROOT, 'server', 'config-store.js')),
    keyRotate: require(path.join(ROOT, 'server', 'key-rotate.js')),
    authSession: require(path.join(ROOT, 'server', 'auth-session.js')),
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-keyrotate-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_PW = 'RootPass123';

/**
 * 造一个「迁移前」的实例：根用户 + 明文 `secret.key` + 一份读得回来的配置。
 *
 * `secret.key` 必须**真实存在**才算迁移前状态 —— 迁移的整个意义就是把这个文件
 * 干掉，而"它本来就不在"的实现会让任何删除断言恒真。
 */
async function legacyInstance(dir, opts) {
  const mods = fresh(dir);
  const { configStore, keyRotate, keyring, authSession } = mods;
  const user = await configStore.addUser({
    username: 'root', password: ROOT_PW, role: 'root',
  });
  configStore.flushPending();
  await wait(250);

  configStore.getMasterKey(); // 生成/读取明文密钥
  configStore.save({ site: { siteName: (opts && opts.sentinel) || '迁移哨兵' } });
  configStore.flushPending();
  await wait(250);

  assert(fs.existsSync(path.join(dir, 'secret.key')), '前置：迁移前应有明文 secret.key');
  assert(fs.existsSync(path.join(dir, 'config.enc')), '前置：迁移前应有 config.enc');
  return Object.assign({ dir, user, dek: Buffer.from(configStore.getMasterKey()) }, mods);
}

/* ================================================================== *
 * 1 · 迁移
 * ================================================================== */

test('R97-13 · 迁移：只写 keyring.json，DEK 不变、明文密钥被删、数据仍可读', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir);
    const configEncBefore = fs.readFileSync(path.join(dir, 'config.enc'));

    const r = await ctx.keyRotate.migrate(ROOT_PW);
    assertEqual(r.migrated, true, '迁移应成功');
    assertEqual(r.kekVersion, 1, '首次迁移 kekVersion=1');
    assertEqual(r.legacyKeyRemoved, true, '迁移后必须删掉明文密钥');

    /**
     * **核心判据**：`config.enc` 逐字节不变。
     *
     * 「只重裹、不重加密」不是实现细节，它是原子性的来源。一旦有人改成
     * "顺手换一把 DEK 把数据重加密一遍"，多个数据文件就没有任何跨文件事务能让
     * 它们同时切换 —— 中间崩一次就是永久不可解。这条断言把那个改法当场钉死。
     */
    assert(configEncBefore.equals(fs.readFileSync(path.join(dir, 'config.enc'))),
      '迁移不得改动 config.enc（重加密就没有原子性了）');

    assertEqual(fs.existsSync(path.join(dir, 'secret.key')), false, '明文密钥必须已删除');
    assert(ctx.keyring.dek().equals(ctx.dek), '包裹的必须是原来那把 DEK');

    // 用「容器里的 DEK」解密配置，读回来的还是原来那份
    ctx.keyring.lock();
    await ctx.keyring.unlock(ROOT_PW);
    const cfg = ctx.configStore.load();
    assertEqual(cfg && cfg.site && cfg.site.siteName, '迁移哨兵', '迁移后配置必须仍可读');
  } finally { cleanup(dir); }
});

test('R97-14 · 迁移后重启一次：容器能解锁、数据能读回（这才是"落盘"的定义）', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir, { sentinel: '重启哨兵' });
    await ctx.keyRotate.migrate(ROOT_PW);

    // 「重启」= 清掉全部模块缓存后重新加载（真实进程重启的等价物）
    const after = fresh(dir);
    assertEqual(after.keyring.exists(), true, '重启后容器仍在');
    assertEqual(after.keyring.isUnlocked(), false, '重启后必须是锁定态（DEK 只在内存里）');

    let e = null;
    try { after.configStore.load(); } catch (x) { e = x; }
    assertEqual(e && e.code, 'KEYRING_LOCKED', '重启后未解锁时读配置必须报 LOCKED');

    await after.keyring.unlock(ROOT_PW);
    const cfg = after.configStore.load();
    assertEqual(cfg && cfg.site && cfg.site.siteName, '重启哨兵', '解锁后数据必须读得回来');

    // 环境变量口令启动即自动解锁（无头部署的必需路径）
    after.keyring.lock();
    process.env.KEPLER_MASTER_PASSPHRASE = ROOT_PW;
    try {
      const r = await after.keyring.autoUnlockFromEnv();
      assertEqual(r && r.ok, true, '环境变量口令应能自动解锁（reason=' + (r && r.reason) + '）');
      assertEqual(after.keyring.isUnlocked(), true, '自动解锁后应处于解锁态');
    } finally { delete process.env.KEPLER_MASTER_PASSPHRASE; }
  } finally { cleanup(dir); }
});

test('R97-15 · 迁移幂等：重复调用不重复包裹，容器逐字节不变', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir);
    await ctx.keyRotate.migrate(ROOT_PW);
    const snap = fs.readFileSync(path.join(dir, 'keyring.json'));

    const again = await ctx.keyRotate.migrate(ROOT_PW);
    assertEqual(again.migrated, false, '重复迁移必须直接返回');
    assertEqual(again.reason, 'already-envelope', '原因要写明"已经是信封态"');
    /**
     * 幂等不是"返回 false 就完事"：若实现先 `create()` 再发现已存在，
     * 容器已被覆盖（换成包裹**另一把随机 DEK** 的新容器）—— 那是当场全库不可解。
     */
    assert(snap.equals(fs.readFileSync(path.join(dir, 'keyring.json'))),
      '重复迁移不得改写容器');
    assert(ctx.keyring.dek().equals(ctx.dek), 'DEK 仍是原来那把');
  } finally { cleanup(dir); }
});

test('R97-16 · 迁移时口令错：401、不建容器、明文密钥原样保留', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir);
    let e = null;
    try { await ctx.keyRotate.migrate('WrongPass123'); } catch (x) { e = x; }
    assertEqual(e && e.status, 401, '口令错必须是 401');
    assertEqual(fs.existsSync(path.join(dir, 'keyring.json')), false, '失败不得留下半成品容器');
    assertEqual(fs.existsSync(path.join(dir, 'secret.key')), true, '失败不得删掉唯一的明文凭据');
    assert(ctx.keyring.isUnlocked() === false, '失败后不应留下解锁态');
  } finally { cleanup(dir); }
});

test('R97-17 · keepLegacyKey：保留明文密钥，且状态如实报告"落盘风险仍在"', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir);
    const r = await ctx.keyRotate.migrate(ROOT_PW, { keepLegacyKey: true });
    assertEqual(r.migrated, true, '迁移本身成功');
    assertEqual(r.legacyKeyRemoved, false, '按请求保留明文密钥');
    assertEqual(fs.existsSync(path.join(dir, 'secret.key')), true, '明文密钥应保留');

    const st = ctx.keyRotate.status();
    assertEqual(st.envelope, true, '已是信封态');
    assertEqual(st.legacyKeyPresent, true, '状态必须如实报告明文密钥还在');
    assertEqual(st.needsMigration, false, '已有容器就不该再提示"需要迁移"');
  } finally { cleanup(dir); }
});

/* ================================================================== *
 * 2 · 轮转（登录口令 = 主口令）
 * ================================================================== */

async function envelopeInstance(dir) {
  const ctx = await legacyInstance(dir, { sentinel: '轮转哨兵' });
  await ctx.keyRotate.migrate(ROOT_PW);
  return ctx;
}

test('R97-18 · 轮转：KEK 用新口令重裹、登录口令同步换掉、DEK 与数据都不动', async () => {
  const dir = tmp();
  try {
    const ctx = await envelopeInstance(dir);
    const configEncBefore = fs.readFileSync(path.join(dir, 'config.enc'));

    const r = await ctx.keyRotate.rotateLogin({
      currentPassphrase: ROOT_PW, newPassphrase: 'NewRootPass456', actor: 'root',
    });
    assertEqual(r.kekVersion, 2, '轮转后 kekVersion 递增');
    assert(ctx.keyring.dek().equals(ctx.dek), '轮转只重裹，DEK 不变');
    assert(configEncBefore.equals(fs.readFileSync(path.join(dir, 'config.enc'))),
      '轮转不得改动任何数据文件');

    /**
     * 「登录口令 = 主口令」这件事的判据是**两边同时生效**：
     * 只改一边就会出现"能登录但解不开"或"解不开但能登录"。
     */
    const okNew = await ctx.configStore.verifyUserPassword(ctx.user.id, 'NewRootPass456');
    const okOld = await ctx.configStore.verifyUserPassword(ctx.user.id, ROOT_PW);
    assertEqual(okNew, true, '新口令应能登录');
    assertEqual(okOld, false, '旧口令必须已失效');

    ctx.keyring.lock();
    await assertReject(() => ctx.keyring.unlock(ROOT_PW), '旧口令不得再解开容器');
    await ctx.keyring.unlock('NewRootPass456');
    const cfg = ctx.configStore.load();
    assertEqual(cfg && cfg.site && cfg.site.siteName, '轮转哨兵', '轮转后数据仍可读');
  } finally { cleanup(dir); }
});

test('R97-19 · 轮转：当前口令错 → 401，容器不动（不重裹）', async () => {
  const dir = tmp();
  try {
    const ctx = await envelopeInstance(dir);
    const snap = fs.readFileSync(path.join(dir, 'keyring.json'));
    let e = null;
    try {
      await ctx.keyRotate.rotateLogin({
        currentPassphrase: 'NotTheCurrentOne', newPassphrase: 'NewRootPass456',
      });
    } catch (x) { e = x; }
    assertEqual(e && e.status, 401, '当前口令错必须是 401');
    assertEqual(e && e.code, 'BAD_CURRENT_PASSPHRASE', '错误码要能区分"当前口令错"');
    assert(snap.equals(fs.readFileSync(path.join(dir, 'keyring.json'))), '失败不得改写容器');
    const stillOk = await ctx.configStore.verifyUserPassword(ctx.user.id, ROOT_PW);
    assertEqual(stillOk, true, '失败后旧口令必须仍然有效');
  } finally { cleanup(dir); }
});

test('R97-20 · 轮转：新口令不合策略时在**重裹之前**拒绝（容器字节不变）', async () => {
  const dir = tmp();
  try {
    const ctx = await envelopeInstance(dir);
    const snap = fs.readFileSync(path.join(dir, 'keyring.json'));
    let e = null;
    try {
      await ctx.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: 'short' });
    } catch (x) { e = x; }
    assert(e, '过短的新口令必须被拒');
    /**
     * 判据必须落在**容器有没有被改写**上，而不是"抛没抛错"：
     * 先重裹再被 `updateUser` 拒掉的写法则会抛同样的错，但它已经把
     * `keyring.json` 改写成"新口令的包裹"再回滚 —— 中间那段时间里容器与
     * 登录口令是不一致的。字节不变才说明校验确实在重裹之前。
     */
    assert(snap.equals(fs.readFileSync(path.join(dir, 'keyring.json'))),
      '策略校验必须在重裹之前，容器不得被改写');
    assert(ctx.keyring.dek().equals(ctx.dek), 'DEK 不变');
    const stillOk = await ctx.configStore.verifyUserPassword(ctx.user.id, ROOT_PW);
    assertEqual(stillOk, true, '旧口令仍然有效');
  } finally { cleanup(dir); }
});

test('R97-21 · 轮转后全部会话失效（解锁因子变了，旧会话不该继续被信任）', async () => {
  const dir = tmp();
  try {
    const ctx = await envelopeInstance(dir);
    const u = ctx.user;
    const t1 = ctx.authSession.createSession({ id: u.id, username: u.username, role: u.role });
    const t2 = ctx.authSession.createSession({ id: u.id, username: u.username, role: u.role });
    assert(ctx.authSession.getSession(t1) && ctx.authSession.getSession(t2), '前置：两个有效会话');

    const r = await ctx.keyRotate.rotateLogin({
      currentPassphrase: ROOT_PW, newPassphrase: 'NewRootPass456',
    });
    assert(r.sessionsKilled >= 2, `应至少清掉 2 个会话，实际 ${r.sessionsKilled}`);
    assertEqual(Boolean(ctx.authSession.getSession(t1)), false, '旧会话 1 必须失效');
    assertEqual(Boolean(ctx.authSession.getSession(t2)), false, '旧会话 2 必须失效');
  } finally { cleanup(dir); }
});

test('R97-22 · 轮转的前置态：未启用信封 409、锁定态 503（不许盲轮转）', async () => {
  const dir = tmp();
  try {
    const ctx = await legacyInstance(dir);
    let e = null;
    try {
      await ctx.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: 'NewRootPass456' });
    } catch (x) { e = x; }
    assertEqual(e && e.status, 409, '未启用信封时轮转应是 409');
    assertEqual(e && e.code, 'KEYRING_ABSENT', '错误码要写明"容器不存在"');

    await ctx.keyRotate.migrate(ROOT_PW);
    ctx.keyring.lock();
    e = null;
    try {
      await ctx.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: 'NewRootPass456' });
    } catch (x) { e = x; }
    assertEqual(e && e.status, 503, '锁定态轮转应是 503');
    assertEqual(e && e.code, 'KEYRING_LOCKED', '错误码要写明"锁定"');
  } finally { cleanup(dir); }
});
