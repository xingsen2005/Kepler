/**
 * 第 101 轮护栏 —— 密钥轮转的分叉 / 崩溃窗口 / 并发，与完整性巡检的四个判据缺陷
 * ============================================================================
 *
 * 本文件对应《密钥轮转与完整性巡检审计报告》里**成立且已修**的九条（F-01 ~ F-09）。
 * 每条都要求「撤销修复 ⇒ 本文件变红」，台账见 `scripts/reverse-check.js` 的 `R101-*`。
 *
 * ## 断言口径
 *
 * - **密钥链路**一律用真实文件、真实 scrypt（`keyrotate.test.js` 同款搭台）：
 *   分叉这种缺陷在内存里完全看不出来，只有「重启视角」才现形；
 * - **巡检链路**里 F-04 / F-06 用真实 `enc-store` 读写，F-08 用 `require.cache` 注入
 *   （与 `audit99` 同一手法：真模块 + 只换边界函数）；
 * - **F-05 的护栏在 `audit99-regressions.test.js` 的 R99-11**（那条原本把缺陷写成了
 *   契约，R101 已把它改成「候选集带时间戳才允许省 HEAD」）。
 *
 * ⚠️ 每个用例**独占一个临时数据目录**：`keyring` 的解锁状态是模块级的，共用目录会让
 * 上一个用例的 `keyring.json` 把下一个用例锁在门外（`KEYRING_LOCKED`）——
 * 那种红与缺陷本身无关，纯粹是搭台的错。
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { after } = require('node:test');

const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir } = require('./helpers.js');

/** 占位目录：任何一个用例都会在 require server 模块前换成自己的目录 */
const slot = makeTempDir('r101-slot-');
process.env.S3_DATA_DIR = slot.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全新的 server 模块集合（数据目录是模块级常量，换目录必须清缓存） */
function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'server'))) delete require.cache[k];
  }
  return {
    keyring: require(SERVER('keyring.js')),
    configStore: require(SERVER('config-store.js')),
    keyRotate: require(SERVER('key-rotate.js')),
    encStore: require(SERVER('enc-store.js')),
    integrity: require(SERVER('integrity.js')),
    atomic: require(SERVER('atomic-write.js')),
  };
}

const ROOT_PW = 'RootPass123';
const NEW_PW = 'NewPass456';

/**
 * 起了个「已迁移到信封加密」的实例，跑完自动收拾。
 *
 * 迁移必须真的跑完 —— 直接写 `keyring.json` 会漏掉「迁移校验 + 删除明文密钥」那两步，
 * 而后续每条断言都建立在「根口令确实同时是主口令」之上。
 */
async function withInstance(label, fn) {
  const dir = makeTempDir(`r101-${label}-`);
  const prevDir = process.env.S3_DATA_DIR;
  process.env.S3_DATA_DIR = dir.dir;
  let m = null;
  try {
    m = fresh();
    const user = await m.configStore.addUser({ username: 'root', password: ROOT_PW, role: 'root' });
    m.configStore.flushPending();
    await wait(300);
    m.configStore.getMasterKey();
    m.configStore.save({ site: { siteName: 'R101 哨兵' } });
    m.configStore.flushPending();
    await wait(300);
    await m.keyRotate.migrate(ROOT_PW);
    assert(m.keyring.isUnlocked(), '前置：迁移后应处于已解锁状态');
    return await fn(Object.assign({ user, dir: dir.dir }, m));
  } finally {
    try { if (m) m.configStore.flushPending(); } catch (e) { /* 尽力而为 */ }
    await wait(50);
    process.env.S3_DATA_DIR = prevDir;
    await cleanupTempDir(dir.dir, { label: `r101-${label}-` });
  }
}

after(async () => {
  await cleanupTempDir(slot.dir, { label: 'r101-slot-' });
});

/* ================================================================== *
 * F-01 · 根用户改密会拆开「登录口令」与「KEK 口令」
 * ================================================================== */

test('R101-01 · 根用户改密的闸门：只在「已启用信封 + 目标就是根用户」时拦，其余一律放行', async () => {
  await withInstance('f01', async (m) => {
    const shared = require(SERVER('routes', '_shared.js'));

    // ① 目标是根用户 + 信封已存在 ⇒ 必须拦，且给出可照做的错误码
    const blocked = shared.rootPasswordBlocked({ id: m.user.id, role: 'root' });
    assert(blocked, '根用户改密必须被拦下 —— 否则登录口令与解锁因子当场分叉');
    assertEqual(blocked.code, 'USE_KEY_ROTATION', '错误码要让前端能引导到「轮转登录密钥」');
    assert(/轮转登录密钥/.test(blocked.error), '文案必须指出正确入口，而不是只说"不允许"');

    // ② 非根用户：改自己的登录口令与主口令无关，不能拦
    assertEqual(shared.rootPasswordBlocked({ id: 'u2', role: 'admin' }), null,
      '非根用户改密不影响 KEK，拦它就是纯打扰');
  });

  // ③ 还没启用信封加密：登录口令就只是登录口令
  const plain = makeTempDir('r101-plain-');
  const prevDir = process.env.S3_DATA_DIR;
  process.env.S3_DATA_DIR = plain.dir;
  try {
    const m2 = fresh();
    await m2.configStore.addUser({ username: 'root', password: ROOT_PW, role: 'root' });
    m2.configStore.flushPending();
    const shared2 = require(SERVER('routes', '_shared.js'));
    assertEqual(shared2.rootPasswordBlocked({ id: 'x', role: 'root' }), null,
      '未启用信封时根用户改密是正常操作');
  } finally {
    process.env.S3_DATA_DIR = prevDir;
    await cleanupTempDir(plain.dir, { label: 'r101-plain-' });
  }
});

test('R101-01b · 接线：三个改密入口（自助 / 管理员重置 / 邮箱找回）都过了同一道闸门', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const users = read('server/routes/users.js');
  const auth = read('server/routes/auth.js');
  const picks = (src) => (src.match(/rootPasswordBlocked\(/g) || []).length;
  assertEqual(picks(users), 2, '`PUT /users/me` 与 `PUT /users/:id` 都必须拦（管理员重置同样是"只改哈希"）');
  assertEqual(picks(auth), 1, '`POST /auth/reset` 也拦 —— 而它恰恰是"旧口令已经忘了"的场景，最危险');
});

/* ================================================================== *
 * F-02 · 密码哈希写盘失败被吞掉，轮转仍返回成功
 * ================================================================== */

test('R101-02 · 根口令哈希写盘失败时，轮转必须失败并回滚 KEK（不能"成功了一半"）', async () => {
  await withInstance('f02', async (m) => {
    const realWrite = m.atomic.writeAtomic;
    let failed = 0;

    // 只让 config.enc 这次写失败：keyring.json 走的是 writeAtomicSync，不受影响
    m.atomic.writeAtomic = (file, data, opts) => {
      if (String(file).endsWith('config.enc')) {
        failed += 1;
        return Promise.reject(Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' }));
      }
      return realWrite(file, data, opts);
    };

    let err = null;
    try {
      await m.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: NEW_PW });
    } catch (e) {
      err = e;
    } finally {
      m.atomic.writeAtomic = realWrite;
    }

    assert(err, '写盘失败必须让轮转**失败**，否则界面显示"轮转成功"而磁盘上是旧口令');
    assertEqual(err.code, 'KEYRING_ROTATE_FAILED', '错误码要能区分"轮转失败"与"口令不对"');
    assert(failed > 0, '前置：这次写入确实被注入失败了');

    // 回滚后的状态：KEK 还是旧口令、登录还是旧口令、意图日志已清
    assertEqual(m.keyring.info().kekVersion, 3,
      'KEK 必须回滚到旧口令：`rewrap` 前进一步、回滚再前进一步，版本号 +2 但因子回到原口令');
    m.keyring.lock();
    const info = await m.keyring.unlock(ROOT_PW);
    assertEqual(info.kekVersion, 3, '旧口令必须仍能解开容器');
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, ROOT_PW), true, '登录口令仍是旧口令');
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, NEW_PW), false, '新口令不得生效');
    assertEqual(fs.existsSync(path.join(m.dir, m.keyRotate.INTENT_NAME)), false,
      '回滚成功后意图日志必须清掉（否则重启时会去补一个不该发生的轮转）');
  });
});

/* ================================================================== *
 * F-03 · 「重裹之后、改哈希之前」崩溃的窗口不可修复
 * ================================================================== */

test('R101-03 · 崩溃窗口：KEK 已换而登录口令没换时，reconcile 把登录口令补成新口令', async () => {
  await withInstance('f03', async (m) => {
    const intentFile = path.join(m.dir, m.keyRotate.INTENT_NAME);
    const before = m.keyring.info();

    /**
     * 复现磁盘状态：① rewrap 成功（KEK = 新口令）② 改哈希那一步"死了"（登录仍是旧口令）。
     * 直接调 `keyring.rewrap` 而不是伪造文件 —— 要的就是真实的新容器。
     */
    const cred = await m.configStore.hashPassword(NEW_PW);
    await m.keyring.rewrap(ROOT_PW, NEW_PW);
    const afterKek = m.keyring.info();
    assertEqual(afterKek.kekVersion, before.kekVersion + 1, '前置：KEK 版本已前进');

    fs.writeFileSync(intentFile, JSON.stringify({
      v: 1, userId: m.user.id, fromKekVersion: before.kekVersion,
      toKekVersion: afterKek.kekVersion, cred, startedAt: new Date().toISOString(), actor: 'test',
    }), 'utf8');

    // 前置自证：此刻确实是分裂状态（旧口令能登录 / 新口令不能）
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, ROOT_PW), true);
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, NEW_PW), false);

    const rep = await m.keyRotate.reconcile();
    assertEqual(rep.repaired, true, '必须补完，而不是把用户永久留在分裂状态');
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, NEW_PW), true,
      '登录口令应被补成新口令 —— 与 KEK 对齐');
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, ROOT_PW), false, '旧口令不得继续可用');
    assertEqual(fs.existsSync(intentFile), false, '补完之后意图日志必须清掉');
  });
});

test('R101-03b · 意图日志的三种"不猜"：没做成功就丢弃、版本对不上就保留、锁定态先不动', async () => {
  await withInstance('f03b', async (m) => {
    const intentFile = path.join(m.dir, m.keyRotate.INTENT_NAME);
    const v = m.keyring.info().kekVersion;
    const cred = await m.configStore.hashPassword(NEW_PW);

    // ① 版本还停在 from ⇒ 轮转根本没发生 ⇒ 丢弃意图，不补任何东西
    fs.writeFileSync(intentFile, JSON.stringify({
      v: 1, userId: m.user.id, fromKekVersion: v, toKekVersion: v + 1, cred,
      startedAt: new Date().toISOString(),
    }), 'utf8');
    const r1 = await m.keyRotate.reconcile();
    assertEqual(r1.repaired, false);
    assertEqual(r1.reason, 'not-rotated', '未发生 ⇒ 只有丢弃，不能顺手改口令');
    assertEqual(fs.existsSync(intentFile), false, '这一种要清掉');
    assertEqual(await m.configStore.verifyUserPassword(m.user.id, ROOT_PW), true, '口令必须原样');

    // ② 版本既不是 from 也不是 to ⇒ 判不了 ⇒ **保留**等人工，绝不猜
    fs.writeFileSync(intentFile, JSON.stringify({
      v: 1, userId: m.user.id, fromKekVersion: v + 2, toKekVersion: v + 5, cred,
      startedAt: new Date().toISOString(),
    }), 'utf8');
    const r2 = await m.keyRotate.reconcile();
    assertEqual(r2.repaired, false);
    assertEqual(r2.reason, 'version-mismatch');
    assertEqual(fs.existsSync(intentFile), true, '判不了就必须留下来 —— 删掉等于销毁唯一线索');

    // ③ 锁定态：配置都读不了，先不动（解锁后会再来一次）
    m.keyring.lock();
    const r3 = await m.keyRotate.reconcile();
    assertEqual(r3.reason, 'locked', '锁定态不补写，等解锁');
    assertEqual(fs.existsSync(intentFile), true, '锁定态也不许删');
    await m.keyring.unlock(ROOT_PW);
  });
});

/* ================================================================== *
 * F-09 · 并发轮转没有串行化
 * ================================================================== */

test('R101-04 · 并发轮转：第二个请求得到 409，而不是"两边都成功、KEK 与登录来自不同请求"', async () => {
  await withInstance('f09', async (m) => {
    const p1 = m.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: NEW_PW });
    let second = null;
    try {
      await m.keyRotate.rotateLogin({ currentPassphrase: ROOT_PW, newPassphrase: 'ThirdPass789' });
    } catch (e) {
      second = e;
    }
    const first = await p1;

    assert(second, '第二个并发轮转必须失败 —— 放它过去就是"两个都成功、状态各来自一边"');
    assertEqual(second.status, 409, '并发冲突用 409，不是 500（那是故障，不是冲突）');
    assertEqual(second.code, 'ROTATION_IN_PROGRESS');
    assertEqual(first.kekVersion, 2, '第一个请求应当正常完成');
    assertEqual(m.keyRotate.isRotating(), false, '结束（含失败分支）必须释放锁，否则一次冲突就永久瘫痪');

    // 释放后应当还能正常轮转
    const third = await m.keyRotate.rotateLogin({ currentPassphrase: NEW_PW, newPassphrase: ROOT_PW });
    assertEqual(third.kekVersion, 3, '互斥释放后应能正常轮转');
  });
});

/* ================================================================== *
 * F-07 · 损坏的 keyring.json 在每次匿名 status 请求时复制备份
 * ================================================================== */

test('R101-05 · keyring.json 损坏时，反复取状态只留一份备份（匿名请求不能放大磁盘占用）', async () => {
  await withInstance('f07', async (m) => {
    const ringFile = path.join(m.dir, 'keyring.json');
    const realRing = fs.readFileSync(ringFile, 'utf8');

    fs.writeFileSync(ringFile, '{"v":1, broken', 'utf8');
    for (let i = 0; i < 6; i += 1) {
      try { m.keyRotate.status(); } catch (e) { /* 预期：容器坏 ⇒ 抛错，路由层转 500 */ }
    }
    const rest = fs.readdirSync(m.dir).filter((f) => f.startsWith('keyring.json.corrupt-'));
    assertEqual(rest.length, 1, `同一个损坏文件只该留一份备份（实际 ${rest.length} 份）—— 匿名请求可无限复现`);

    // 文件被换成**另一次**损坏（mtime 变新）⇒ 必须重新留档，不能拿旧备份冒充
    fs.writeFileSync(ringFile, '{"v":1, broken-again', 'utf8');
    const newer = new Date(Date.now() + 5000);
    fs.utimesSync(ringFile, newer, newer);
    try { m.keyRotate.status(); } catch (e) { /* 同上 */ }
    const rest2 = fs.readdirSync(m.dir).filter((f) => f.startsWith('keyring.json.corrupt-'));
    assertEqual(rest2.length, 2, '源文件被改过 ⇒ 这是新的损坏 ⇒ 必须再留一份');

    fs.writeFileSync(ringFile, realRing, 'utf8');
  });
});

/* ================================================================== *
 * F-04 · 复制 / 移动之后被巡检误判为「被改写」
 * ================================================================== */

test('R101-06 · 复制 / 移动会刷新 cloudWrittenAt，巡检不再把正常搬运报成「被改写」', async () => {
  await withInstance('f04', async (m) => {
    const OLD = '2020-01-01T00:00:00.000Z';
    const now = new Date();

    // 一条"很久以前写的"元数据：magic 模式，密文 10 字节
    const base = () => ({ mode: 'magic', origSize: 10, createdAt: OLD, magic: { magicLen: 9 } });
    m.encStore.setMeta('b1', 'orig.bin', base());

    // ① 没动过 ⇒ 云端时间戳远晚于本地写入 ⇒ 仍然必须报「被改写」（修复不能把判据改瞎）
    const r0 = m.integrity.classify({ meta: base(), cloudSize: 10, lastModified: now.toUTCString() });
    assertEqual(r0.verdict, 'modified', '原样搬运之外的情形仍要能抓到篡改');

    // ② 复制之后 ⇒ 目标条目必须带新的时间戳，判 ok
    m.encStore.copyMeta('b1', 'orig.bin', 'copy.bin');
    const copied = m.encStore.getMeta('b1', 'copy.bin');
    assert(copied && copied.cloudWrittenAt, '复制必须刷新 cloudWrittenAt（否则每次复制都制造一条假警报）');
    assertEqual(copied.createdAt, OLD, '`createdAt` 语义不变：它仍是"这份明文第一次被加密"的时间');
    const rc = m.integrity.classify({ meta: copied, cloudSize: 10, lastModified: now.toUTCString() });
    assertEqual(rc.verdict, 'ok', '刚复制出来的对象不该被报成"被改写"');

    /**
     * ③ 上传 / 复制**落库**走的是 `reconcileAfterWrite()`（`fs-gateway` 的复制路径就是它），
     * 与 `copyMeta()` 是两个入口。只改 `copyMeta` 会留下这条更常用的路径。
     */
    m.encStore.reconcileAfterWrite('b1', 'up.bin', base());
    const up = m.encStore.getMeta('b1', 'up.bin');
    assert(up && up.cloudWrittenAt, '上传 / 复制落库（reconcileAfterWrite）同样要刷新 cloudWrittenAt');
    const ru = m.integrity.classify({ meta: up, cloudSize: 10, lastModified: now.toUTCString() });
    assertEqual(ru.verdict, 'ok', '刚上传 / 刚复制落库的对象不该被报成"被改写"');

    // ④ 移动之后同样
    m.encStore.renameMeta('b1', 'orig.bin', 'moved.bin');
    const moved = m.encStore.getMeta('b1', 'moved.bin');
    assert(moved && moved.cloudWrittenAt, '移动（云端是 copy + delete）同样是"新对象"');
    const rm = m.integrity.classify({ meta: moved, cloudSize: 10, lastModified: now.toUTCString() });
    assertEqual(rm.verdict, 'ok', '刚移动出来的对象不该被报成"被改写"');

    // ⑤ 清理
    m.encStore.removeMetaBatch('b1', ['copy.bin', 'moved.bin', 'up.bin']);
  });
});

/* ================================================================== *
 * F-06 · magic 模式下小于魔数长度的文件被误判为「长度不符」
 * ================================================================== */

test('R101-07 · magic 短文件：密文长度 = 魔数长度，不能拿 origSize 去比', async () => {
  await withInstance('f06', async (m) => {
    const M = 9;

    // 纯函数口径：四档边界
    assertEqual(m.integrity.expectedCloudSize({ mode: 'magic', origSize: 0, magic: { magicLen: M } }), M,
      '0 字节 ⇒ 落盘的就是那 9 个字节的魔数');
    assertEqual(m.integrity.expectedCloudSize({ mode: 'magic', origSize: M - 1, magic: { magicLen: M } }), M,
      'M-1 字节 ⇒ 同样是 M 字节密文');
    assertEqual(m.integrity.expectedCloudSize({ mode: 'magic', origSize: M, magic: { magicLen: M } }), M,
      '正好 M 字节 ⇒ 两者相等，不因取大值而偏移');
    assertEqual(m.integrity.expectedCloudSize({ mode: 'magic', origSize: 100, magic: { magicLen: M } }), 100,
      '大文件仍是等长（魔数覆写文件头，不增加长度）');
    assertEqual(m.integrity.expectedCloudSize({ mode: 'magic', origSize: 5 }), 5,
      '缺 magicLen 的历史条目回退到 origSize —— 无法更准，但不引入新判据');

    // 与判据对齐：短文件在云端确实是 M 字节
    const shortMeta = { mode: 'magic', origSize: 5, createdAt: new Date().toISOString(), magic: { magicLen: M } };
    const r = m.integrity.classify({ meta: shortMeta, cloudSize: M, lastModified: new Date().toUTCString() });
    assertEqual(r.verdict, 'ok', `5 字节明文 ⇒ 云端 ${M} 字节密文，必须判 ok（旧实现报"长度不符"）`);
  });
});

/* ================================================================== *
 * F-08 · 同名桶跨厂商时巡检 HEAD 错桶
 * ================================================================== */

test('R101-08 · 同名桶存在歧义时整桶跳过并如实说明，不发任何一次 HEAD', async () => {
  const P = {
    integrity: SERVER('integrity.js'),
    encStore: SERVER('enc-store.js'),
    configStore: SERVER('config-store.js'),
    bucketStats: SERVER('bucket-stats.js'),
    candidates: SERVER('search-candidates.js'),
    s3: SERVER('s3.js'),
    statsStore: SERVER('stats-store.js'),
  };
  const real = {};
  for (const k of Object.keys(P)) real[k] = require(P[k]);

  const calls = { head: [] };
  const fakes = {
    encStore: Object.assign({}, real.encStore, {
      metaBuckets: () => ['dup'],
      metaEntriesFor: () => [
        { key: 'a.bin', meta: { mode: 'magic', origSize: 10, magic: { magicLen: 9 } } },
      ],
      metaIsCorrupt: () => false,
    }),
    // 配置里**两个**同名桶（不同厂商 / 不同凭据）
    configStore: Object.assign({}, real.configStore, {
      isLocked: () => false,
      load: () => ({ buckets: [{ bucket: 'dup', provider: 'cos' }, { bucket: 'dup', provider: 'oss' }] }),
    }),
    bucketStats: Object.assign({}, real.bucketStats, {
      resolveBucketClient: () => ({ cfg: { bucket: 'dup', region: '' }, s3: {} }),
    }),
    candidates: Object.assign({}, real.candidates, { get: () => null }),
    s3: {
      p: async (c, method, params) => {
        calls.head.push(params && params.Key);
        return { headers: { 'content-length': '10' } };
      },
    },
    statsStore: Object.assign({}, real.statsStore, { addLog: () => {} }),
  };

  const saved = {};
  for (const k of Object.keys(fakes)) {
    saved[k] = require.cache[require.resolve(P[k])];
    require.cache[require.resolve(P[k])] = {
      id: P[k], filename: P[k], loaded: true, exports: fakes[k],
    };
  }
  delete require.cache[require.resolve(P.integrity)];

  try {
    const mod = require(P.integrity);
    const st = await mod.runOnce();
    assertEqual(calls.head.length, 0,
      '歧义桶一个 HEAD 都不能发 —— 猜错会给出"看起来非常确定"的错误结论');
    assertEqual(st.bad, 0, '歧义不是"这个对象有问题"，不能计入异常');
    assertEqual(st.skipped, 1, '按"没查清"计，界面上与"丢失"分开');
    assert(st.findings.length === 1 && st.findings[0].verdict === 'ambiguous',
      '必须如实说明"这一桶没法判"，而不是静默少查');
  } finally {
    delete require.cache[require.resolve(P.integrity)];
    for (const k of Object.keys(fakes)) {
      if (saved[k]) require.cache[require.resolve(P[k])] = saved[k];
      else delete require.cache[require.resolve(P[k])];
    }
  }
});
