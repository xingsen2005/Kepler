/**
 * 测试：加密与存储基础设施
 *  — enc-store：分段 GCM 往返、魔数模式往返、XOR 字对齐优化等价性
 *  — atomic-write：原子写入与追加（O_APPEND）语义
 *  — ip-guard：CIDR 匹配与规则求值
 *  — instance-lock：单实例锁（脏锁接管 / 释放 / 活跃锁拒绝）
 *
 * 注：这些模块直接读写**运行时数据目录**，测试中通过「备份→操作→还原」保证不污染真实配置。
 */
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

require('./helpers'); // 兜底 S3_DATA_DIR 到进程级临时目录（下一行的 require 命中同一份缓存，顺序即保证）

const { assert, assertEqual, ROOT } = require('./helpers');

/**
 * 运行时数据目录 —— **必须**跟随 `S3_DATA_DIR`，不能写死 `ROOT/data`。
 *
 * R66 修正：这里原本是 `path.join(ROOT, 'data')`。而 `helpers.js` 已在顶层把
 * `S3_DATA_DIR` 兜底到临时目录，于是 `enc-store` / `atomic-write` 写的全是
 * **临时目录**里的文件，而 `protectData()` 备份 / 还原的却是仓库里那份 `data/`
 * —— 它保护的正好是**本进程根本不会去写**的目录。这层「保险」既没有覆盖到真被
 * 改动的文件，又让人以为隔离已经做过了。
 *
 * 现在两边同源：`DATA` 就是 store 真正会落的那个目录，`protectData()` 这才名实相符。
 * 仍然保留「备份→还原」而不是改用独立临时目录：`enc.key` 是**数据目录级**的密钥
 * （同目录下 `enc-meta.json` 的密文全靠它），换目录就等于换了一份密钥，
 * 也就测不到「同一份密钥反复读写」这条真实路径了。
 */
const DATA = process.env.S3_DATA_DIR || path.join(ROOT, 'data');

/* ============================ 数据目录保护 ============================ */

/**
 * 备份 data/ 下的敏感文件，返回还原函数。
 *  — enc-store / atomic-write 会写入 data/enc-meta.json、data/enc.key 等；
 *    测试后必须逐字节还原，否则会污染用户真实配置。
 */
function protectData(files) {
  const backup = new Map();
  const existed = new Set();
  for (const f of files) {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) {
      backup.set(f, fs.readFileSync(p));
      existed.add(f);
    }
  }
  return function restore() {
    for (const f of files) {
      const p = path.join(DATA, f);
      if (existed.has(f)) {
        fs.writeFileSync(p, backup.get(f));
      } else if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
  };
}

test('R66-03 · 每条新元数据都盖上 keyId（密钥轮换的预留位）；老记录按 1 解释', async () => {
  const restore = protectData(['enc-meta.json', 'enc-settings.json', 'enc.key']);
  const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
  try {
    encStore._resetForTest();
    encStore.updateSettings({ mode: 'crypto', password: '' });

    // ① crypto 分支：新建的元数据必须带 keyId=1，且**落盘再读回**也是 1
    //    （只在内存对象上加、忘了随 setMeta 落盘，是这条最可能的漏法）
    const plain = Buffer.from('keyId 探针：这一段没有任何字段会随密文一起走');
    const enc = encStore.encryptBuffer('kid-bucket', 'dir/crypto.bin', plain);
    assertEqual(enc.meta.keyId, 1, 'crypto 分支的元数据必须盖 keyId=1');
    encStore.setMeta('kid-bucket', 'dir/crypto.bin', enc.meta);
    const readBack = encStore.getMeta('kid-bucket', 'dir/crypto.bin');
    assertEqual(readBack.keyId, 1, 'keyId 必须真的落进 enc-meta.json（读回来还在）');

    // ② magic 分支：4 个元数据生产点里最容易漏的就是它（另一条路径、另一段代码）
    encStore.updateSettings({ mode: 'magic', magic: 'COSCENC01FF', password: '' });
    const enc2 = encStore.encryptBuffer('kid-bucket', 'dir/magic.bin', Buffer.from('0123456789abcdef'));
    assertEqual(enc2.meta.keyId, 1, 'magic 分支同样要盖章 —— 漏一个分支就等于这条密文将来没有密钥归属');

    // ③ 向后兼容：R66 之前落盘的条目没有这个字段，必须仍按 1 号密钥解释
    assertEqual(encStore.keyIdOf({ mode: 'crypto', origSize: 3 }), 1,
      '老记录（无 keyId）必须回落到 1 —— 这批密文确实是用 1 号密钥加的');
    assertEqual(encStore.keyIdOf({ keyId: 0 }), 1, '非法值（0）也回落，不静默当成「第 0 把密钥」');
    assertEqual(encStore.keyIdOf({ keyId: '2' }), 2, '合法值原样读出（将来轮换时靠它区分新旧密文）');
    assertEqual(encStore.CURRENT_KEY_ID, 1, '当前只有一把密钥');
  } finally {
    restore();
    encStore._resetForTest && encStore._resetForTest();
  }
});

/* ============================ enc-store ============================ */

test('enc-store crypto 模式：加密后可完整解密还原', async () => {
  const restore = protectData(['enc-meta.json', 'enc-settings.json', 'enc.key']);
  try {
    const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
    encStore._resetForTest && encStore._resetForTest();
    encStore.updateSettings({ mode: 'crypto', password: '' });

    const plain = Buffer.from('这是一段需要加密的内容 with ASCII and 中文 🎉');
    const enc = encStore.encryptBuffer('test-bucket', 'dir/file.txt', plain);
    assert(enc && enc.data, '应返回密文');
    assert(!enc.data.equals(plain), '密文应与明文不同');
    assert(enc.data.length > plain.length, '密文应包含 IV/TAG 开销');

    const meta = encStore.getMeta('test-bucket', 'dir/file.txt') || enc.meta;
    const back = encStore.decryptBuffer ? encStore.decryptBuffer(enc.data, meta) : null;
    if (back) assertEqual(back.toString('utf8'), plain.toString('utf8'), '解密应还原原文');
  } finally {
    restore();
  }
});

test('R24-03 · 密文分段被重排 / 拼接必须报错（IV 与 TAG 逐段比对本地元数据）', async () => {
  const restore = protectData(['enc-meta.json', 'enc-settings.json', 'enc.key']);
  try {
    const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
    encStore._resetForTest && encStore._resetForTest();
    encStore.updateSettings({ mode: 'crypto', password: '' });

    // 必须造**两段**密文：单段对象无法暴露「按位置比对」这条判据
    const p1 = Buffer.from('第一段明文：AAA');
    const p2 = Buffer.from('第二段明文：BBB');
    const sess = {
      id: 'r24-03', bucket: 'test-bucket', key: 'multi/seg.bin',
      size: p1.length + p2.length, chunkSize: p1.length,
      enc: { mode: 'crypto', parts: {} },
      parts: { 1: 'etag-1', 2: 'etag-2' },
    };
    const c1 = encStore.encryptPart(sess, 1, p1); // 首段：magic + IV|CT|TAG
    const c2 = encStore.encryptPart(sess, 2, p2); // 后续段：IV|CT|TAG
    const meta = encStore.buildFinalMeta(sess);
    assert(meta && meta.crypto && meta.crypto.segments.length === 2,
      '前置：应构造出两段 crypto 元数据');

    const decryptAll = (bytes, m) => new Promise((resolve, reject) => {
      const chunks = [];
      const t = encStore.decryptTransform(m);
      t.on('data', (c) => chunks.push(c));
      t.on('end', () => resolve(Buffer.concat(chunks)));
      t.on('error', reject);
      t.end(bytes);
    });
    const expectReject = async (bytes, m, re, msg) => {
      let err = null;
      try { await decryptAll(bytes, m); } catch (e) { err = e; }
      if (!err) throw new Error('断言失败：' + msg + '（实际未报错）');
      if (!re.test(String(err.message))) {
        throw new Error('断言失败：' + msg + `（错误文案不符：${err.message}）`);
      }
    };

    // ① 正对照：未篡改的两段密文必须完整还原 —— 新判据不得误伤正常数据
    const ok = await decryptAll(Buffer.concat([c1, c2]), meta);
    assertEqual(ok.toString('utf8'), p1.toString('utf8') + p2.toString('utf8'),
      '正对照：合法两段密文必须完整解出（按位置比对不得误伤）');

    // ② 重排分段：保持魔数头在最前，交换两段密文本体 —— 云端可写者最容易做的一步。
    //    旧实现下每段 IV|CT|TAG 自洽、GCM 认证各自通过 → 静默产出被重排的明文。
    const MAGIC_LEN = 10; // 'COSCENC01'
    const reordered = Buffer.concat([c1.slice(0, MAGIC_LEN), c2, c1.slice(MAGIC_LEN)]);
    await expectReject(reordered, meta, /IV 与本地元数据不一致/,
      '重排等长分段必须被检出（这是 R24-03 的核心现场：逐段自洽但整体被重排）');

    // ③ 段序与元数据不一致（等价于「第 i 段读到了邻段的 IV」这一检出条件）
    const swapped = JSON.parse(JSON.stringify(meta));
    swapped.crypto.segments.reverse();
    await expectReject(Buffer.concat([c1, c2]), swapped,
      /IV 与本地元数据不一致|认证标签与本地元数据不一致/,
      '段序与元数据不一致时必须报错');
  } finally {
    restore();
  }
});

test('XOR 字对齐优化与逐字节异或结果完全等价', () => {
  // 复刻 enc-store 的 xor 实现，对多种长度/offset 做等价性验证
  function xorBytewise(buf, ks) {
    for (let i = 0; i < buf.length; i++) buf[i] ^= ks[i];
    return buf;
  }
  function xorWordAligned(buf, ks) {
    const n = buf.length;
    const words = n >>> 2;
    for (let i = 0; i < words; i++) {
      const p = i << 2;
      buf.writeUInt32BE((buf.readUInt32BE(p) ^ ks.readUInt32BE(p)) >>> 0, p);
    }
    for (let i = words << 2; i < n; i++) buf[i] ^= ks[i];
    return buf;
  }

  const lengths = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 1000, 4097];
  let checked = 0;
  for (const len of lengths) {
    for (const seed of [1, 42, 999]) {
      const a = crypto.createHash('sha256').update('data' + len + seed).digest().subarray(0, Math.max(len, 1)).subarray(0, len);
      if (len === 0) continue; // 空缓冲无字节可异或
      const src = Buffer.alloc(len);
      for (let i = 0; i < len; i++) src[i] = (i * 37 + seed) & 0xff;
      const ks = Buffer.alloc(len);
      for (let i = 0; i < len; i++) ks[i] = (i * 91 + seed) & 0xff;

      const r1 = xorBytewise(Buffer.from(src), Buffer.from(ks));
      const r2 = xorWordAligned(Buffer.from(src), Buffer.from(ks));
      assert(r1.equals(r2), `长度 ${len} seed ${seed} 时两种异或结果不一致`);
      checked++;
      void a;
    }
  }
  assert(checked >= 30, '应完成足够多的组合验证');
});

/* ============================ atomic-write ============================ */

test('atomic-write：写入为原子替换，且追加不重写整个文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aw-'));
  const file = path.join(tmpDir, 'log.txt');
  try {
    const aw = require(path.join(ROOT, 'server', 'atomic-write.js'));
    // writeAtomic 首次写入
    await aw.writeAtomic(file, 'line1\n');
    assertEqual(fs.readFileSync(file, 'utf8'), 'line1\n', '首次写入内容正确');

    // appendAtomic 追加（O_APPEND，不整体重写）
    await aw.appendAtomic(file, 'line2\n');
    assertEqual(fs.readFileSync(file, 'utf8'), 'line1\nline2\n', '追加后内容正确');

    // 大文件上追加应「不整体重写」—— 用**文件对象同一性**判定，不用耗时阈值。
    //
    // RE-04：这里原本断言「1MB 追加 < 20ms」。实测（全量第 1 次）该项在负载下走到
    // 30.15ms 而变红，隔离重跑 3/3 通过 —— 纯墙钟阈值会偶发红，而偶发红会侵蚀
    // 「全绿」这个信号本身（一次假红之后，人就学会忽略红灯了）。
    //
    // 说明为什么连"相对耗时"也不能用：本机实测追加 5 字节到 8MB 文件耗时
    // 3~8ms、整体重写 8MB 耗时 5~7ms，比值在 0.7x ~ 2.1x 之间抖动 ——
    // Windows 上小追加的瓶颈是 open/close 系统调用而非数据量，任何时间比值都不稳定。
    //
    // 改为确定性的探针：早期 appendAtomic 的实现是「读全文 + 拼接 + writeAtomic 整体
    // 原子替换」，那会让文件被替换成新对象（ino 变化）；真正的 O_APPEND 追加只改内容，
    // 文件对象不变。这与耗时无关，因而不会 flaky。
    const big = path.join(tmpDir, 'big.txt');
    const BIG = 8 * 1024 * 1024;
    fs.writeFileSync(big, Buffer.alloc(BIG, 0x41));
    const stBefore = fs.statSync(big);
    assert(stBefore.ino !== 0,
      'ino 为探针的必要条件；若该平台/文件系统不提供 inode，请改用别的同一性探针，' +
      '不要把它退化成一条恒真的空断言');

    await aw.appendAtomic(big, 'tail\n');
    const stAfter = fs.statSync(big);
    assertEqual(stAfter.size, BIG + 5, '追加后大小应为原大小 + 5');
    assertEqual(stAfter.ino, stBefore.ino,
      '追加不得把文件整体替换掉（旧实现「读全文 + 整体重写 + rename」，' +
      '每次追加都是 O(n) 写放大，且文件对象会换新）');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('atomic-write：tmp 名带随机量，同毫秒多次生成不重名（防并发截断）', () => {
  const aw = require(path.join(ROOT, 'server', 'atomic-write.js'));
  const file = path.join(ROOT, 'data', 'config.enc');
  const names = new Set();
  // 紧循环 200 次：历史实现用 Date.now() 做唯一来源，同毫秒必然大量重名，
  // 重名会让后一次 writeFile 截断前一次的 tmp，导致 rename 搬走 0 字节文件。
  for (let i = 0; i < 200; i++) names.add(aw.tmpPath(file));
  assertEqual(names.size, 200, '200 次 tmpPath 应全部互不相同');
  for (const n of names) {
    assert(/\.\d+\.[0-9a-f]{16}\.tmp$/i.test(n), `tmp 命名应形如 <file>.<pid>.<rand16>.tmp，实际 ${n}`);
  }
});

test('atomic-write：sweepOrphanTmp 只清理死进程的旧 tmp，活跃/新鲜 tmp 保留', async () => {
  const aw = require(path.join(ROOT, 'server', 'atomic-write.js'));
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sweep-'));
  const old = new Date(Date.now() - 60 * 60 * 1000); // 1 小时前
  // 不存在的 pid：0 在 POSIX 是进程组、Windows 会抛错，统一用不可能存在的 999999
  const DEAD_PID = 999999;
  const mk = (name, mtime) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, '');
    if (mtime) fs.utimesSync(p, mtime, mtime);
    return p;
  };
  try {
    const orphan = mk(`config.enc.${DEAD_PID}.aaaa1111bbbb2222.tmp`, old);
    const freshOrphan = mk(`config.enc.${DEAD_PID}.cccc3333dddd4444.tmp`); // mtime=now
    const liveTmp = mk(`config.enc.${process.pid}.eeee5555ffff6666.tmp`, old);
    const notTmp = mk('config.enc', old); // 不含 .pid.rand.tmp 后缀，必须保留

    const r = await aw.sweepOrphanTmp(tmpDir, { minAgeMs: 10 * 60 * 1000 });
    assertEqual(r.scanned, 3, '仅 3 个文件匹配 tmp 命名规则（config.enc 自身不计入）');
    assertEqual(r.removed.length, 1, '应只删除 1 个孤儿');
    assertEqual(r.removed[0], path.basename(orphan), '被删的应是死进程 + 超龄的那个');
    assert(!fs.existsSync(orphan), '孤儿 tmp 应被删除');
    assert(fs.existsSync(freshOrphan), 'mtime 过新的 tmp 应保留（可能正在写）');
    assert(fs.existsSync(liveTmp), '活进程的 tmp 应保留');
    assert(fs.existsSync(notTmp), '非 tmp 命名的文件应保留');

    // dryRun 不得产生副作用
    fs.writeFileSync(orphan, '');
    fs.utimesSync(orphan, old, old);
    const dry = await aw.sweepOrphanTmp(tmpDir, { minAgeMs: 0, dryRun: true });
    assert(dry.removed.length >= 1, 'dryRun 应报告命中项');
    assert(fs.existsSync(orphan), 'dryRun 不得真正删除文件');

    // minAgeMs=0 时新鲜孤儿也可被清（供启动清扫之外的运维场景显式调用）
    const all = await aw.sweepOrphanTmp(tmpDir, { minAgeMs: 0 });
    assert(all.removed.length >= 1, '放宽时间窗后应能清掉更多孤儿');
    assert(fs.existsSync(liveTmp), '无论如何都不得删除活进程的 tmp');

    // 目录不存在时应静默返回，不抛错
    const missing = await aw.sweepOrphanTmp(path.join(tmpDir, 'no-such-dir'));
    assertEqual(missing.removed.length, 0, '目录不存在时返回空结果');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('atomic-write：活进程判定不得把 EPERM 误判为死亡（Windows 服务进程保护）', async () => {
  const aw = require(path.join(ROOT, 'server', 'atomic-write.js'));
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sweep-perm-'));
  try {
    // 自身 pid：process.kill 成功，且 isPidAlive 有 `pid === process.pid` 短路，必然为"活"
    const selfTmp = path.join(tmpDir, `config.enc.${process.pid}.aaaa0000bbbb1111.tmp`);
    fs.writeFileSync(selfTmp, '');
    const r1 = await aw.sweepOrphanTmp(tmpDir, { minAgeMs: 0 });
    assertEqual(r1.removed.length, 0, '自身进程的 tmp 必须保留');
    assert(fs.existsSync(selfTmp), '自身进程的 tmp 文件应仍在');

    // 系统服务型 pid（Windows 下 process.kill 返回 EPERM）：
    // 若实现把 EPERM 当作死亡，就会误删。这里用一个几乎必然属于系统服务的低 PID 验证。
    // 该 PID 在所有平台上要么存活（EPERM/permission），要么明确不存在（跳过本断言）。
    const SYS_PID = 4;
    let alive = false;
    try { process.kill(SYS_PID, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) {
      const sysTmp = path.join(tmpDir, `config.enc.${SYS_PID}.cccc2222dddd3333.tmp`);
      fs.writeFileSync(sysTmp, '');
      const r2 = await aw.sweepOrphanTmp(tmpDir, { minAgeMs: 0 });
      assert(fs.existsSync(sysTmp),
        `PID ${SYS_PID} 报 EPERM（进程存在但无权探测）时不得被当作孤儿删除`);
      assertEqual(r2.removed.includes(path.basename(sysTmp)), false, '不得出现在 removed 列表中');
      fs.unlinkSync(sysTmp);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/* ============================ instance-lock ============================ */

test('instance-lock：活跃锁拒绝、脏锁接管、释放后可用', async (t) => {
  const instanceLock = require(path.join(ROOT, 'server', 'instance-lock.js'));
  const LOCK = instanceLock.LOCK_FILE;
  const backup = fs.existsSync(LOCK) ? fs.readFileSync(LOCK) : null;

  // 若本机已有真实实例在运行，则不应抢夺它的锁 —— 直接跳过，避免干扰用户进程
  const pre = await new Promise((resolve) => {
    if (!fs.existsSync(LOCK)) return resolve({ ok: true });
    try {
      const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      let alive = false;
      try { process.kill(j.pid, 0); alive = true; } catch (e) { alive = (e.code === 'EPERM'); }
      resolve({ ok: !alive, pid: j.pid, alive });
    } catch (e) { resolve({ ok: true }); }
  });
  if (!pre.ok && pre.alive) {
    t.diagnostic(`检测到运行中的实例（PID ${pre.pid}），跳过 instance-lock 写入测试以免干扰`);
    return;
  }

  try {
    // 1) 首次获取应成功（此处已确认无活跃锁）
    const r1 = instanceLock.acquire();
    assert(r1.ok, '无活跃锁时获取锁应成功');

    // 2) 写入一个不存在的 PID，模拟崩溃残留的脏锁 → 应被自动接管
    instanceLock.release();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    const r2 = instanceLock.acquire();
    assert(r2.ok, '死进程的脏锁应被自动接管');

    // 3) 写入当前进程 PID（活跃），应被拒绝
    instanceLock.release();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const r3 = instanceLock.acquire();
    assertEqual(r3.ok, false, '活跃进程持有的锁应拒绝获取');
    assertEqual(r3.pid, process.pid, '应返回占用者 PID');

    // 4) release 后锁文件消失（须由持有者本人释放）
    //    注意：此处先清掉步骤 3 留下的「本进程 PID」脏锁，让 acquire 真正拿到锁，
    //    否则 acquire 会被自己上一步写入的锁拒绝、held 保持 false，release 自然不删文件
    //    （那是正确行为：不该误删非本人持有的锁）。
    try { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); } catch (e) { /* ignore */ }
    const held = instanceLock.acquire();
    assert(held.ok, '清理后应能获取锁');
    assert(fs.existsSync(LOCK), '获取锁后锁文件应存在');
    instanceLock.release();
    assert(!fs.existsSync(LOCK), 'release 后锁文件应被删除');

    // 5) 非持有者 release 不应误删他人锁
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    instanceLock.release(); // held 已是 false，应直接返回
    assert(fs.existsSync(LOCK), '非持有者释放锁时不应删除锁文件');
  } finally {
    try { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); } catch (e) { /* ignore */ }
    if (backup) fs.writeFileSync(LOCK, backup);
  }
});

/* ============================ ip-guard CIDR ============================ */

test('ip-guard：IP 求值对命中/未命中给出正确判定', () => {
  const restore = protectData(['ipguard.json']);
  try {
    const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
    // 全局规则：屏蔽 203.0.113.0/24 的 GET
    const rule = ipGuard.addRule({ target: '203.0.113.0/24', remark: '测试网段', methods: ['GET'] });
    assert(rule && rule.id, '应成功创建规则');

    const hit = ipGuard.evaluate('203.0.113.45', 'GET', null);
    assertEqual(hit.ok, false, '网段内 IP 的 GET 应被屏蔽');

    const missMethod = ipGuard.evaluate('203.0.113.45', 'POST', null);
    assertEqual(missMethod.ok, true, '未在规则方法内的 POST 应放行');

    const missIp = ipGuard.evaluate('198.51.100.7', 'GET', null);
    assertEqual(missIp.ok, true, '网段外 IP 应放行');

    // 回环口永远放行
    const loop = ipGuard.evaluate('127.0.0.1', 'GET', null);
    assertEqual(loop.ok, true, '回环地址永远放行');

    ipGuard.removeRule(rule.id);
  } finally {
    restore();
  }
});
