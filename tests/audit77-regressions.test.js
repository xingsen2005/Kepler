/**
 * 审计第 77 轮护栏：**缺 IV/TAG 的历史加密元数据不得静默解密**
 *
 * 外部审计报告 F-E1（中危，附 PoC）：R24-03 给「历史元数据缺 iv/tag」留了
 * 跳过逐段比对的豁免（向后兼容），但该豁免既没有回填迁移关闭、也没有任何护栏覆盖。
 * 于是对这批老对象，能写云端对象者可以重排等长分段 / 拼接另一对象的分段，
 * 逐段 GCM 各自通过，**静默产出被重排的明文**，下载方不报错。
 *
 * 本文件断言的是**后果**，不是「源码里有那行判据」：
 *  - 拒绝解密时**零字节下发**（不能先给半截明文再报错）；
 *  - 正对照（完整元数据）必须照常解密，守卫不得误伤；
 *  - 逃生门打开后确实回到旧行为 —— 并如实记录「此时重排不报错」这一残留风险；
 *  - 写入侧不得再产出缺 iv/tag 的新条目。
 */
const test = require('node:test');
const path = require('node:path');

require('./helpers'); // 兜底 S3_DATA_DIR 到进程级临时目录（先于 enc-store 加载）

const { assert, assertEqual, ROOT } = require('./helpers');

const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const MAGIC_LEN = encStore.CRYPTO_MAGIC.length; // 'COSCENC01' = 9 字节（勿写死 10，会错位一个字节）

function freshCryptoStore() {
  encStore._resetForTest();
  encStore.updateSettings({ mode: 'crypto', password: '' });
}

/** 造两段密文 + 完整元数据（单段对象暴露不了「按位置比对」这条判据） */
function buildTwoSegments() {
  const p1 = Buffer.from('第一段明文：AAA');
  const p2 = Buffer.from('第二段明文：BBB');
  const sess = {
    id: 'r77-legacy', bucket: 'r77-bucket', key: 'multi/legacy.bin',
    size: p1.length + p2.length, chunkSize: p1.length,
    enc: { mode: 'crypto', parts: {} },
    parts: { 1: 'etag-1', 2: 'etag-2' },
  };
  const c1 = encStore.encryptPart(sess, 1, p1);
  const c2 = encStore.encryptPart(sess, 2, p2);
  const meta = encStore.buildFinalMeta(sess);
  assert(meta && meta.crypto && meta.crypto.segments.length === 2,
    '前置：应构造出两段 crypto 元数据');
  return { p1, p2, c1, c2, meta, sess };
}

/**
 * 跑完整个解密流，同时收集「已下发的字节」与错误。
 * 必须在 `end()` 之前挂好监听：错误是通过 `destroy(err)` 异步抛出的。
 */
function decryptAll(bytes, meta) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; resolve({ out: Buffer.concat(chunks), err }); } };
    const t = encStore.decryptTransform(meta);
    t.on('data', (c) => chunks.push(c));
    t.on('end', () => done(null));
    t.on('error', (e) => done(e));
    t.end(bytes);
  });
}

/** 模拟 v1.2.4 之前的元数据形态：分段只有 n / ctLen，没有 iv / tag */
function makeLegacyMeta(meta) {
  const legacy = JSON.parse(JSON.stringify(meta));
  for (const s of legacy.crypto.segments) {
    delete s.iv;
    delete s.tag;
  }
  return legacy;
}

test('R77-01 · 正对照：完整元数据必须照常解密（守卫不得误伤正常对象）', async () => {
  freshCryptoStore();
  const { p1, p2, c1, c2, meta } = buildTwoSegments();
  const r = await decryptAll(Buffer.concat([c1, c2]), meta);
  assertEqual(r.err, null, '完整元数据 + 未篡改密文必须解密成功');
  assertEqual(r.out.toString('utf8'), p1.toString('utf8') + p2.toString('utf8'),
    '两段明文必须完整还原');
});

test('R77-02 · 缺 iv/tag 的历史元数据：拒绝解密，且一个字节都不下发', async () => {
  freshCryptoStore();
  const { c1, c2, meta } = buildTwoSegments();
  const legacy = makeLegacyMeta(meta);

  const r = await decryptAll(Buffer.concat([c1, c2]), legacy);
  assert(r.err, '缺 iv/tag 的历史元数据必须报错 —— 否则重排 / 拼接无法检出（F-E1）');
  assert(/缺少 IV\/TAG/.test(String(r.err.message)),
    `错误文案应明确指向缺失的 IV/TAG，实际：${r.err && r.err.message}`);
  assertEqual(r.out.length, 0, '失败必须发生在任何明文下发之前（不能先给半截明文）');

  // 篡改场景同样必须在这道判据上失败（此时它先于逐段比对生效）
  const reordered = Buffer.concat([c1.slice(0, MAGIC_LEN), c2, c1.slice(MAGIC_LEN)]);
  const r2 = await decryptAll(reordered, legacy);
  assert(r2.err, '历史元数据 + 重排分段必须报错');
  assertEqual(r2.out.length, 0, '重排场景同样不得下发任何字节');
});

test('R77-03 · 逃生门：显式放行时回到旧行为（并记录此时重排确实不报错）', async () => {
  freshCryptoStore();
  const { p1, p2, c1, c2, meta } = buildTwoSegments();
  const legacy = makeLegacyMeta(meta);

  process.env.ALLOW_LEGACY_UNVERIFIED_CRYPTO = '1';
  try {
    // ① 未篡改：必须能取回（这就是逃生门的用途：把老文件救出来再重传）
    const ok = await decryptAll(Buffer.concat([c1, c2]), legacy);
    assertEqual(ok.err, null, '显式放行后，未篡改的历史密文应能解密');
    assertEqual(ok.out.toString('utf8'), p1.toString('utf8') + p2.toString('utf8'),
      '放行路径的明文必须正确');

    // ② 重排：**不报错**，产出被重排的明文 —— 这正是默认必须关的原因。
    //    把这条写成断言而不是注释：将来若有人把默认值改成「开」，它会连同 R77-02 一起红。
    const reordered = Buffer.concat([c1.slice(0, MAGIC_LEN), c2, c1.slice(MAGIC_LEN)]);
    const bad = await decryptAll(reordered, legacy);
    assertEqual(bad.err, null, '放行状态下重排不会被检出（历史元数据的固有缺口）');
    assert(!bad.out.equals(Buffer.from(p1.toString('utf8') + p2.toString('utf8'))),
      '放行状态下重排会产出错误明文 —— 这是默认拒绝的理由，不是可接受的常态');
  } finally {
    delete process.env.ALLOW_LEGACY_UNVERIFIED_CRYPTO;
  }
});

test('R77-04 · 写入侧：buildFinalMeta 拒绝缺 iv/tag 的分片（不再产生历史形态）', async () => {
  freshCryptoStore();
  const { sess } = buildTwoSegments();
  delete sess.enc.parts[2].iv;
  let err = null;
  try {
    encStore.buildFinalMeta(sess);
  } catch (e) { err = e; }
  assert(err, '缺 iv 的分片必须拒绝合并 —— 否则又会落出一条免检的历史元数据');
  assert(/缺少 IV\/TAG/.test(String(err.message)),
    `错误文案应指明缺少 IV/TAG，实际：${err.message}`);

  // 反例：补齐后必须能正常产出（证明判据不是「无条件拒绝」）
  const okSess = {
    id: 'r77-ok', bucket: 'r77-bucket', key: 'multi/ok.bin',
    size: 4, chunkSize: 4,
    enc: { mode: 'crypto', parts: {} },
    parts: { 1: 'etag-1' },
  };
  encStore.encryptPart(okSess, 1, Buffer.from('AAAA'));
  const meta = encStore.buildFinalMeta(okSess);
  assert(meta.crypto.segments[0].iv && meta.crypto.segments[0].tag,
    '正常路径必须同时写出 iv 与 tag');
});
