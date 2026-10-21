/**
 * 第 51 轮护栏 —— 两件事
 *
 * 需求原文：
 *  1. 「修改『链接创建成功』页：增加对话框和链接 div 标签的宽度，使链接可以一行显示完」；
 *  2. 「多文件 / 文件夹分享：如果多文件和/或文件夹分享，文件分享页以列表形式显示全部
 *      文件和文件夹，可勾选要下载的文件，并分页显示 —— 每页最多 50 个文件/文件夹，
 *      50 个以上则分页」。
 * 用户确认的三条口径：
 *  · 打包：**只勾 1 个文件按原名直传，多选或含文件夹则打包 `.tar.gz`**；
 *  · 次数：**整批算 1 次**（不论勾了几项）；
 *  · 列表：**扁平平铺**（不按层级折叠，每行显示相对路径，50 行 / 页）。
 *
 * ## 断言分五层，缺一层就留一种假绿
 *
 *  ① **纯函数层**（真实 `server/tar.js`）：每个头块校验和自洽、GNU `L` 长名、
 *     base-256 大端长度、`safeName` 抗目录穿越、补零 / 收尾块字节形态。
 *  ② **打包层**（真实 `share-bundle.js` + 真实 gzip + **独立 tar 解析器**）：
 *     解出来的条目名 / 内容逐字节相等；长度与声明不符**两个方向都中止**；
 *     下游停止消费时中止而不是永远挂着。
 *  ③ **快照 / 视图层**（真实 `share-store.js`）：`normalizeItems` 截断到 2000、
 *     历史单文件记录合成一条、`listView` 判据、单文件落盘形态与旧记录一致。
 *  ④ **真发 HTTP 层**（真实 `share-routes.js` / `routes/links.js` + 真实 express）：
 *     `POST /links` 收多路径并快照；`GET /s/:id` 50/51 项分页与 `?page=` 夹取；
 *     `GET /s/:id/dl` 拒非快照 key（400，且不占用次数）、空选择 404、单选直传、
 *     多选打包。
 *  ⑤ **沙箱行为层**（真实 `ops.js` / `share-list.js` + 假 DOM）：弹窗真的挂上了
 *     `link-result-dialog`（宽度来源）、多选时直链单选项真的被禁用且提交体走 `paths`、
 *     勾选真的跨页累计并在提交时补成隐藏字段。
 *
 * ⚠️ 分享页是**服务端渲染**的独立文档：它没有 `index.html` 那套雪碧，也没有任何
 *    构建步骤。列表页的勾选脚本因此必须是一个**同源普通脚本**（CSP 里没有
 *    `unsafe-inline`，`document.currentScript` 在 module 里恒为 null）——由用例 5 钉住。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('s3-r51-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ------------------------------------------------------------------ *
 * 假云端 / 假配置：下载端点必须能走到「直传 / 打包」两条分支。
 *
 * ⚠️ 必须在 require 路由**之前**换掉 `s3.getClient` 与 `requireConfig`：
 *    `share-routes.js` / `routes/links.js` 都是在加载时解构这两个函数。
 * ------------------------------------------------------------------ */
const cloudRef = { client: null };
const s3mod = require(SERVER('s3.js'));
s3mod.getClient = () => cloudRef.client;

const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const statsStore = require(SERVER('stats-store.js'));
const LOGS = [];
statsStore.addLog = (e) => { LOGS.push(e); };

const shared = require(SERVER('routes', '_shared.js'));
shared.requireConfig = () => ({ bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent' });

const tar = require(SERVER('tar.js'));
const { attachmentDisposition } = require(SERVER('attachment-name.js'));
const { streamBundle } = require(SERVER('share-bundle.js'));
const { createTrafficMeter, STATS_FLUSH_MS } = require(SERVER('traffic-meter.js'));
const secureStore = require(SERVER('secure-store.js'));
const shareStore = require(SERVER('share-store.js'));
const shareRoutes = require(SERVER('share-routes.js'));
const linkRoutes = require(SERVER('routes', 'links.js'));

test.after(async () => {
  // links.json / stats 都走异步去抖写：不刷干就在目录删掉之后落地，只留下 ENOENT 噪声
  await cleanupTempDir(tmp.dir, {
    flushers: [
      { name: 'secure-store', flush: () => secureStore.flush() },
      { name: 'stats-store', flush: () => { statsStore.flushStatsSync(); statsStore.flushLogsSync(); } },
    ],
  });
});

/* ================================================================== *
 * 公共工具
 * ================================================================== */

/**
 * **独立的** tar 解析器 —— 只读字节，不引用 `server/tar.js` 的任何函数。
 *
 * 与被测实现同源的话，「一起写错」就会一起通过（例如两边都把 `size` 字段的
 * 偏移记成 124 以外的位置）。这里刻意从零写一遍，并顺带重算每个头的校验和。
 *
 * @returns {Array<{name, type, size, body, checksumOk}>}
 */
function parseTar(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  const isZero = (b) => b.length === tar.BLOCK_SIZE && b.every((x) => x === 0);

  while (off + tar.BLOCK_SIZE <= buf.length) {
    const block = buf.subarray(off, off + tar.BLOCK_SIZE);
    off += tar.BLOCK_SIZE;
    if (isZero(block)) {
      // 收尾是**两个**全零块；单个零块只是块对齐留下的空洞
      if (isZero(buf.subarray(off, off + tar.BLOCK_SIZE))) break;
      continue;
    }
    const readNum = (start, len) => {
      const f = block.subarray(start, start + len);
      if (f[0] & 0x80) { // base-256（首字节最高位为标志）
        let v = BigInt(f[0] & 0x7f);
        for (let i = 1; i < len; i += 1) v = (v << 8n) | BigInt(f[i]);
        return Number(v);
      }
      const s = f.toString('ascii').replace(/\0/g, '').trim();
      return s ? parseInt(s, 8) : 0;
    };
    // 校验和：把 chksum 字段自身按 8 个空格算，其余累加，再与字段比对
    const sum = block.reduce((a, b) => a + b, 0);
    const spaces = block.reduce((a, b, i) => (i >= 148 && i < 156 ? a + 32 : a + b), 0);
    const recorded = readNum(148, 8);
    const checksumOk = recorded === spaces || recorded === sum;
    const magic = block.subarray(257, 263).toString('ascii');
    const size = readNum(124, 12);
    const type = block.subarray(156, 157).toString('ascii');
    const rawName = block.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const body = buf.subarray(off, off + size);
    off += size + ((tar.BLOCK_SIZE - (size % tar.BLOCK_SIZE)) % tar.BLOCK_SIZE);
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    out.push({ name: longName === null ? rawName : longName, type, size, body, checksumOk, magic });
    longName = null;
  }
  return out;
}

/** 收集写入的字节（模拟一个永远消费得动的响应） */
function collectorRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.headers = {};
  res.setTimeout = () => {};
  return { res, chunks, body: () => Buffer.concat(chunks) };
}

/** 从内存取对象流的 openFile（供 streamBundle 直接引用，不经 HTTP） */
function memOpenFile(files) {
  return async (entry) => {
    const data = files[entry.key];
    if (data === undefined) return null; // 模拟「对象已不存在」
    return { stream: Readable.from([Buffer.from(data)]), size: Buffer.byteLength(data), mtime: 0 };
  };
}

/** 用超时守卫一个「不该挂住」的 Promise */
function withTimeout(promise, ms, msg) {
  let timer = null;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** `assert.rejects` 的替身：helpers 导出的 `assert` 是自研断言函数，没有 rejects */
async function assertRejectsWith(fn, re, msg) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err, `${msg} —— 但没有抛出任何错误`);
  if (re) assert(re.test(String(err.message)), `${msg} —— 实际信息：${err.message}`);
}

/**
 * 取一个响应（二进制安全）。
 *
 * ⚠️ 必须带**超时与提前收尾**两条兜底：打包下载是 chunked 的，若响应头被错误地
 * 声明了 `Content-Length`（这正是本轮的一条反向对照要证伪的形状），客户端会**等
 * 一个永远不来的尾巴**，用例就此挂住 —— 反向对照（变异 → 跑测试）会因此卡死，
 * 而不是「干净地失败」。宁可把一个截断的响应当失败，也不要让整轮对照无限等待。
 */
const httpGetBuf = (port, pathStr, headers = {}, timeoutMs = 6000) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const req = http.get({ host: '127.0.0.1', port, path: pathStr, headers, timeout: timeoutMs }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => finish({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    // 声明长度与实际不符时，服务端提前结束 → 客户端只会看到 `close` / `aborted`
    res.on('aborted', () => finish({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), truncated: true }));
    res.on('close', () => finish({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), truncated: true }));
    res.on('error', () => finish({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), truncated: true }));
  });
  req.on('timeout', () => { req.destroy(); finish({ status: 0, headers: {}, buf: Buffer.from('响应超时'), timeout: true }); });
  req.on('error', (e) => finish({ status: 0, headers: {}, buf: Buffer.from(String(e)) }));
});

async function serve(mount, prefix, { auth = null } = {}) {
  const app = express();
  app.use(express.json());
  if (auth) app.use((req, _res, next) => { req.authUser = auth; next(); });
  if (prefix) app.use(prefix, mount); else app.use(mount);
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { server: s, port: s.address().port };
}

/* ================================================================== *
 * ① 纯函数层：server/tar.js
 * ================================================================== */

test('R51-1 · tar：每个头块的校验和自洽，magic/version/uid/gid 按 POSIX ustar 写', () => {
  const cases = [
    { name: 'a.txt', size: 5 },
    { name: 'dir/', size: 0, type: tar.TYPE.dir, mode: 0o755 },
    { name: '长名字'.repeat(10) + '.txt', size: 1e6 },
    { name: 'x', size: 0, mtime: 1700000000 },
  ];
  for (const c of cases) {
    const h = tar.header(c);
    assertEqual(h.length, tar.BLOCK_SIZE, `${c.name} 的头必须恰好 512 字节`);
    // 用**独立**方式重算校验和（chksum 字段按 8 个空格参与）
    const spaces = h.reduce((a, b, i) => (i >= 148 && i < 156 ? a + 32 : a + b), 0);
    const recorded = parseInt(h.subarray(148, 154).toString('ascii'), 8);
    assertEqual(recorded, spaces, `${c.name} 的校验和字段必须等于按空格算法重算的结果`);
    assertEqual(h[154], 0, '校验和字段的规范写法是「6 位八进制 + NUL + 空格」');
    assertEqual(h[155], 32, '校验和字段末位必须是空格');
    assertEqual(h.subarray(257, 263).toString('ascii'), 'ustar\0', 'magic 必须是 POSIX ustar');
    assertEqual(h.subarray(263, 265).toString('ascii'), '00', 'version 必须是 00');
    // uid/gid 恒 0：不泄露运行服务的账号
    assertEqual(h.subarray(108, 116).toString('ascii'), tar.octalField(0, 8), 'uid 必须恒为 0');
    assertEqual(h.subarray(116, 124).toString('ascii'), tar.octalField(0, 8), 'gid 必须恒为 0');
    assertEqual(h.subarray(156, 157).toString('ascii'), c.type || tar.TYPE.file, '类型标志');
  }
});

test('R51-1 · tar：超过 100 字节的名字走 GNU `L` 条目，真名在 L 的载荷里', () => {
  const long = '目录/' + 'x'.repeat(80) + '/中文文件名.txt'; // ≥ 100 字节
  assert(Buffer.byteLength(long) > tar.NAME_MAX, '样本必须真的超限');
  const blocks = tar.longNameBlocks(long);
  assertEqual(blocks.length, 3, '长名条目 = L 头 + 载荷 + 补零');
  assertEqual(blocks[0].length, tar.BLOCK_SIZE, 'L 头是 512 字节');
  assertEqual(blocks[0].subarray(0, 100).toString('ascii').replace(/\0[\s\S]*$/, ''), tar.LONG_NAME_PATH,
    'L 条目的名字必须是 GNU 约定的哨兵名');
  assertEqual(blocks[0][156], 0x4c, "L 条目的 typeflag 必须是 'L'（0x4C）");
  const payload = blocks[1];
  assertEqual(parseInt(blocks[0].subarray(124, 136).toString('ascii'), 8), payload.length,
    'L 头里的 size 必须等于载荷长度');
  assertEqual(payload.subarray(payload.length - 1)[0], 0, '载荷以 NUL 结尾');
  assertEqual(payload.subarray(0, payload.length - 1).toString('utf8'), long, '载荷就是完整名字本身');
  assertEqual(blocks[2].length, tar.BLOCK_SIZE - (payload.length % tar.BLOCK_SIZE),
    '载荷必须补零到 512 对齐');

  // 名字放得下时不得产生 L 条目（否则每个条目白多 1KB）
  assertEqual(tar.longNameBlocks('short.txt').length, 0, '短名不得生成 L 条目');

  // entryBlocks 的顺序：L 三块在前，文件头在后；文件头里的 name 只是可读占位
  const all = Buffer.concat(tar.entryBlocks(long, { size: 3 }));
  const parsed = parseTar(Buffer.concat([all, tar.padding(3), tar.endBlocks()]));
  assertEqual(parsed.length, 1, '应解析出一个条目');
  assertEqual(parsed[0].name, long, '解包方必须拿到完整的长名字');
  assert(parsed[0].checksumOk, '长名条目的头校验和也要自洽');
});

test('R51-1 · tar：size 越过八进制上限时改用 GNU base-256（不是截断）', () => {
  const MAX_OCT = 8 ** 11 - 1; // 8589934591
  assertEqual(tar.numberField(MAX_OCT, 12)[0] & 0x80, 0, '上限之内仍是八进制');
  const big = tar.numberField(MAX_OCT + 1, 12);
  assertEqual(big[0], 0x80, '越过上限必须置 base-256 标志位');
  // 独立解码回来必须逐字节等于原值 —— 截断成低 11 位八进制会得到一个小得多的数
  let v = BigInt(big[0] & 0x7f);
  for (let i = 1; i < 12; i += 1) v = (v << 8n) | BigInt(big[i]);
  assertEqual(Number(v), MAX_OCT + 1, 'base-256 必须能无损表达');

  const h = tar.header({ name: 'huge.bin', size: MAX_OCT + 12345 });
  assertEqual(h[124], 0x80, '头里的 size 字段必须走 base-256');
  let w = BigInt(h[124] & 0x7f);
  for (let i = 125; i < 136; i += 1) w = (w << 8n) | BigInt(h[i]);
  assertEqual(Number(w), MAX_OCT + 12345, '头里声明的长度必须等于真实长度');
});

test('R51-1 · tar：safeName 就地消解 `..`，任何输入都不得逃出解包目录', () => {
  const cases = [
    ['../../etc/passwd', 'etc/passwd'],
    ['/abs/path', 'abs/path'],
    ['a/./b', 'a/b'],
    ['a//b/', 'a/b'],
    ['a/../../b', 'b'],
    ['..', ''],
    ['../..', ''],
    ['', ''],
    [null, ''],
    ['a\\b', 'a/b'],
    ['a\0b', 'ab'],
    ['中文/../名字.txt', '名字.txt'],
  ];
  for (const [raw, want] of cases) {
    assertEqual(tar.safeName(raw), want, `safeName(${JSON.stringify(raw)})`);
  }
  // 落到头里也不能带 `..`
  const blocks = Buffer.concat(tar.entryBlocks('../../evil.sh', { size: 1 }));
  const head = blocks.subarray(blocks.length - tar.BLOCK_SIZE).subarray(0, 100).toString('utf8');
  assert(!head.includes('..'), `归档条目名不得含 '..'（实际 ${JSON.stringify(head)}）`);
});

test('R51-1 · tar：padding / endBlocks 的字节形态（多一个少一个都会让解包错位）', () => {
  assertEqual(tar.padding(0).length, 0, '0 字节内容不需要补零');
  assertEqual(tar.padding(tar.BLOCK_SIZE).length, 0, '整块内容不需要补零');
  assertEqual(tar.padding(1).length, tar.BLOCK_SIZE - 1);
  assertEqual(tar.padding(tar.BLOCK_SIZE + 1).length, tar.BLOCK_SIZE - 1);
  assert(tar.padding(3).every((b) => b === 0), '补零必须是真零');
  const end = tar.endBlocks();
  assertEqual(end.length, tar.BLOCK_SIZE * 2, '收尾是两个全零块');
  assert(end.every((b) => b === 0), '收尾块必须全零');
  assertEqual(tar.entryBlocks('', { size: 1 }).length, 0, '空路径不产生任何块（否则是一个无名条目）');
  // 目录条目自带结尾斜杠、size 恒 0、权限 0755
  const dirBlocks = Buffer.concat(tar.entryBlocks('a/b', { dir: true }));
  const dh = dirBlocks.subarray(dirBlocks.length - tar.BLOCK_SIZE);
  assertEqual(dh.subarray(0, 3).toString('utf8'), 'a/b', '目录名要写进去');
  assertEqual(dh.subarray(3, 4).toString('ascii'), '/', '目录条目名必须以 / 结尾（否则部分工具会解成同名文件）');
  assertEqual(parseInt(dh.subarray(124, 136).toString('ascii'), 8), 0, '目录的 size 恒为 0');
  assertEqual(parseInt(dh.subarray(100, 108).toString('ascii'), 8), 0o755, '目录权限 0755');
});

/* ================================================================== *
 * ② 打包层：share-bundle.js（真 gzip + 独立解析器）
 * ================================================================== */

test('R51-2 · streamBundle：gunzip 后用独立解析器逐条目核对名字与内容', async () => {
  const files = {
    'a.txt': 'hello',
    'dir/b.bin': 'x'.repeat(1000),
    'dir/子目录/中文文件名很长很长很长很长很长很长很长很长.txt': '中文内容',
  };
  const entries = [
    { name: 'a.txt', key: 'a.txt', dir: false },
    { name: 'dir/', key: 'dir/', dir: true },
    { name: 'dir/b.bin', key: 'dir/b.bin', dir: false },
    { name: 'dir/nope.txt', key: 'dir/nope.txt', dir: false }, // 已不存在 → 跳过
    { name: 'dir/子目录/中文文件名很长很长很长很长很长很长很长很长.txt',
      key: 'dir/子目录/中文文件名很长很长很长很长很长很长很长很长.txt', dir: false },
  ];
  const { res, body } = collectorRes();
  const traffic = { bytesDown: 0 };
  const stats = await streamBundle({
    entries, res, openFile: memOpenFile(files), bucket: 'tb',
    archiveName: '我的分享.tar.gz', traffic,
  });

  const gz = body();
  assertEqual(stats.files, 3, '3 个对象成功写入');
  assertEqual(stats.dirs, 2, '一级目录 + dir/ 共 2 行');
  assertEqual(stats.skipped, 1, '取不到的单个对象应跳过而不是整包失败');
  assertEqual(traffic.bytesDown, gz.length, 'traffic 必须等于真正下发的压缩字节数');
  assertEqual(stats.bytes, gz.length, '返回的 bytes 与 traffic 同源');

  const parsed = parseTar(zlib.gunzipSync(gz));
  const names = parsed.map((x) => x.name);
  // 一级目录必须存在（否则解包会把一堆文件倒进用户当前目录）
  assertEqual(names[0], '我的分享/', '归档第一项必须是一级目录');
  assert(names.includes('我的分享/dir/'), '目录行要写进归档');
  assert(!names.includes('我的分享/dir/nope.txt'), '取不到的对象绝不出现在归档里');
  for (const x of parsed) {
    assert(x.checksumOk, `${x.name} 的头校验和不自洽`);
    assert(x.magic === 'ustar\0', `${x.name} 的 magic 不对`);
    assert(x.name === '我的分享/' || x.name.startsWith('我的分享/'), `${x.name} 逃出了一级目录`);
  }
  // 内容逐字节相等（含多字节中文与超过一个块的 1000 字节）
  const contentOf = (n) => parsed.find((x) => x.name === n);
  assertEqual(contentOf('我的分享/a.txt').body.toString('utf8'), files['a.txt'], 'a.txt 内容');
  assertEqual(contentOf('我的分享/dir/b.bin').body.length, 1000, '跨块的 1000 字节长度');
  assert(contentOf('我的分享/dir/b.bin').body.every((b) => b === 0x78), 'b.bin 内容');
  assertEqual(
    contentOf('我的分享/dir/子目录/中文文件名很长很长很长很长很长很长很长很长.txt').body.toString('utf8'),
    '中文内容', '超 100 字节中文路径的内容也要能解出来',
  );
  for (const x of parsed) {
    if (x.type === '0') assertEqual(x.size, x.body.length, `${x.name} 声明长度必须等于实际长度`);
  }
});

test('R51-2 · streamBundle：声明长度与实际字节不符时**两个方向都中止**（绝不产出坏包）', async () => {
  const mk = (declared, actual) => {
    const { res } = collectorRes();
    return streamBundle({
      entries: [{ name: 'a.txt', key: 'a.txt', dir: false }], res,
      openFile: async () => ({
        stream: Readable.from([Buffer.alloc(actual, 0x41)]), size: declared, mtime: 0,
      }),
      bucket: 'tb', archiveName: 'x.tar.gz',
    });
  };
  // 短：解包工具会把「下一个文件头」当内容读走，产出一个能解开但内容是垃圾的包
  await assertRejectsWith(() => withTimeout(mk(15, 5), 3000, '短的应当中止而不是挂住'),
    /打包下载中止/, '实际比声明短必须中止');
  // 长：多出来的字节已经写进流里、无法回退，后面所有条目都会错位
  await assertRejectsWith(() => withTimeout(mk(15, 20), 3000, '长的应当中止而不是挂住'),
    /打包下载中止/, '实际比声明长必须中止');
  // 完全一致：正常返回
  const ok = await withTimeout(mk(15, 15), 3000, '一致时不应挂住');
  assertEqual(ok.files, 1, '长度一致时应正常打包');
});

test('R51-2 · streamBundle：下游停止消费时中止，而不是永远挂在一个 await 上', async () => {
  // ⚠️ 这条护栏要「真的走进等 drain 的那一支」才有效。`writeBlock` 的 dest 是 **gzip**
  //    （不是 res），gzip 的可写缓冲默认只有 16 KiB；喂几 KB 的小负载时 `gzip.write()`
  //    直接返回 true、Promise 当场 resolve，`close` 监听**根本没被注册** —— 用例哪怕
  //    把 `dest.once('close', …)` 整个删掉也照样绿（FACTS §十五记着这个坑）。
  //    所以这里用 1 MiB **不可压缩**数据（xorshift 序列），保证压缩后仍有约 1 MiB 要下发，
  //    叠加下游 highWaterMark=1 的背压，`gzip.write()` 必然返回 false。
  const BIG = 1024 * 1024;
  const big = Buffer.alloc(BIG);
  let seed = 0x2545f491;
  for (let i = 0; i < BIG; i += 1) {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    big[i] = seed & 0xff;
  }

  // highWaterMark=1 且 write 永不回调 ⇒ 第一次 write 就返回 false，之后彻底停住
  let accepted = 0;
  const stall = new Writable({
    highWaterMark: 1,
    write(chunk) { accepted += chunk.length; /* 永不回调：模拟客户端停止读取 */ },
  });
  stall.setHeader = () => {};
  stall.setTimeout = () => {};
  const p = streamBundle({
    entries: [{ name: 'a.txt', key: 'a.txt', dir: false }], res: stall,
    openFile: async () => ({ stream: Readable.from([big]), size: BIG }),
    bucket: 'tb', archiveName: 'x.tar.gz',
  });
  // 客户端取消：响应被销毁，`drain` 永远不会再来
  setTimeout(() => stall.destroy(), 50);
  let err = null;
  try {
    await withTimeout(p, 4000, 'HANG');
  } catch (e) { err = e; }
  assert(err, '响应销毁后必须中止（不能一直挂着）');
  assert(err.message !== 'HANG',
    'writeBlock 必须同时监听 close：只等 drain 的话客户端一取消，这个 await 就永远挂着、请求泄漏');
  // 自证「确实卡在半路」：下游只收下了很小一部分，剩下的都堵在 gzip 的写缓冲里。
  // 若这条不成立，说明本次根本没进背压分支，上面的断言就是空的。
  assert(accepted < BIG,
    `下游应因背压停在中途（实际只收下 ${accepted} / ${BIG} 字节），否则本用例未命中等待分支`);
});

test('R51-2 · streamBundle：2000 条上限的归档能整包走完（分页边界的服务端一侧）', async () => {
  const entries = [{ name: 'big/', key: 'big/', dir: true }];
  const files = {};
  for (let i = 0; i < shareStore.SNAPSHOT_MAX; i += 1) {
    const k = `big/f${String(i).padStart(4, '0')}.txt`;
    files[k] = `#${i}`;
    entries.push({ name: k, key: k, dir: false });
  }
  const { res, body } = collectorRes();
  const stats = await streamBundle({
    entries, res, openFile: memOpenFile(files), bucket: 'tb', archiveName: 'big.tar.gz',
  });
  assertEqual(stats.files, shareStore.SNAPSHOT_MAX, `应打包 ${shareStore.SNAPSHOT_MAX} 个文件`);
  const parsed = parseTar(zlib.gunzipSync(body()));
  assertEqual(parsed.length, shareStore.SNAPSHOT_MAX + 2, '一级目录 + big/ + 每个文件一条');
  assert(parsed.every((x) => x.checksumOk), '每个头的校验和都要自洽');
  assertEqual(parsed[parsed.length - 1].body.toString('utf8'), `#${shareStore.SNAPSHOT_MAX - 1}`,
    '最后一条内容正确（顺序未被截断）');
});

test('R51-2 · streamBundle：选择里一个文件都没有时下发只含一级目录的归档（口径已明确）', async () => {
  /**
   * 这是**有意保留**的行为，不是遗漏：
   *  · 「选择里没有文件」（空文件夹）由调用方在**开流之前**判掉并给 404；
   *  · 而「选择里有文件、但它们创建后都被删了」，只有在逐个 head 之后才知道，
   *    那时响应头已经发出、无法改成 404；为此在开流前多打一遍 head，代价是
   *    最多 2000 次额外云端往返。
   * 故这里把口径钉成「只含一级目录的合法归档」，避免它悄悄漂移成空响应体。
   */
  const { res, body } = collectorRes();
  const stats = await streamBundle({
    entries: [{ name: 'a.txt', key: 'a.txt', dir: false }], res,
    openFile: async () => null, bucket: 'tb', archiveName: 'x.tar.gz',
  });
  assertEqual(stats.files, 0, '一个都没取到');
  assertEqual(stats.skipped, 1, '记进 skipped 由调用方写告警日志');
  const parsed = parseTar(zlib.gunzipSync(body()));
  assertEqual(parsed.length, 1, '归档里只剩一级目录');
  assertEqual(parsed[0].name, 'x/', '一级目录名取自下载文件名');
});

test('R51-2 · streamBundle：响应头（类型 / 附件名 / 禁用缓存），且刻意不声明 Content-Length', async () => {
  const { res } = collectorRes();
  await streamBundle({
    entries: [{ name: 'a.txt', key: 'a.txt', dir: false }], res,
    openFile: memOpenFile({ 'a.txt': 'hi' }), bucket: 'tb', archiveName: '我的 分享.tar.gz',
  });
  assertEqual(res.headers['Content-Type'], 'application/gzip', '打包必须是 gzip 类型');
  assertEqual(res.headers['Cache-Control'], 'no-store', '分享内容不得被中间缓存');
  const cd = res.headers['Content-Disposition'];
  assert(cd.startsWith('attachment; '), '必须是附件下载');
  assert(!/[\r\n]/.test(cd), '附件头里绝不能出现换行（否则可注入另一个响应头）');
  assert(cd.includes('filename*=UTF-8\'\''), '必须给 RFC 5987 的真实文件名');
  const star = decodeURIComponent(/filename\*=UTF-8''([^;]*)$/.exec(cd)[1]);
  assertEqual(star, '我的 分享.tar.gz', 'filename* 必须还原出原始文件名');
  assertEqual(res.headers['Content-Length'], undefined,
    '压缩后长度不可预知，猜一个会让浏览器提前判定下载完成并截断文件');
});

/* ================================================================== *
 * ②-b 附件头的唯一实现点（响应头注入面）
 * ================================================================== */

test('R51-2 · attachmentDisposition：剔除引号 / 反斜杠 / 换行，中文走 filename*', () => {
  const evil = attachmentDisposition('a".txt\r\nX-Evil: 1\\');
  assert(!/[\r\n]/.test(evil), '换行必须被剔除（否则能顶出另一个响应头）');
  const asc = /filename="([^"]*)"/.exec(evil)[1];
  assert(!asc.includes('"'), 'ASCII 名里不得再有裸引号');
  assert(!asc.includes('\\'), '反斜杠也要剔除');
  const cn = attachmentDisposition('中文名.txt');
  assertEqual(decodeURIComponent(/filename\*=UTF-8''([^;]*)$/.exec(cn)[1]), '中文名.txt',
    '中文名必须能在 filename* 里还原');
  assertEqual(/filename="([^"]*)"/.exec(cn)[1], '___.txt', 'ASCII 兜底把每个非可见 ASCII 字符换成 _');
  assertEqual(attachmentDisposition(undefined), attachmentDisposition(''), '空 / 未定义必须同形，不留 undefined');
});

test('R51-2 · 附件头的拼装只有一处实现，两条下发管线都委托它（不得各自内联）', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = ['download-stream.js', 'share-bundle.js', 'attachment-name.js'];
  const literal = (f) => (strip(fs.readFileSync(SERVER(f), 'utf8')).match(/attachment; filename=/g) || []).length;
  const total = files.reduce((a, f) => a + literal(f), 0);
  assertEqual(total, 1, `「attachment; filename=」整仓只应出现 1 次（实际 ${total}）—— 多一处就是一条会漂移的注入面`);
  assertEqual(literal('attachment-name.js'), 1, '唯一实现点应在 attachment-name.js');
  for (const f of ['download-stream.js', 'share-bundle.js']) {
    const src = strip(fs.readFileSync(SERVER(f), 'utf8'));
    assert(/require\('\.\/attachment-name'\)/.test(src), `${f} 必须引用唯一实现点`);
    assert(/attachmentDisposition\(/.test(src), `${f} 必须真的调用它（不能只 import 不用）`);
    assert(!/attachment;/.test(src), `${f} 不得再自己拼附件头（只有唯一实现点能出现这个字面量）`);
  }
});

/* ================================================================== *
 * ②-c 计量环节：两条管线共用一个实现点
 * ================================================================== */

test('R51-2 · traffic-meter：按间隔汇总上报，flush 时清算尾部字节，且与 traffic 逐字节相等', async () => {
  assert(STATS_FLUSH_MS >= 200, '汇总间隔不应过小（过小等于没汇总）');
  const seenSample = [];
  const seenBucket = [];
  const realSample = statsStore.sampleTraffic;
  const realBucket = statsStore.trackBucket;
  statsStore.sampleTraffic = (_req, down) => seenSample.push(down);
  statsStore.trackBucket = (_b, o) => { if (o && o.down) seenBucket.push(o.down); };
  try {
    const traffic = { bytesDown: 0 };
    // 间隔调大：中途不 flush，只在流结束时清算 —— 证明尾部字节不会丢
    const meter = createTrafficMeter({ bucket: 'tb', traffic, intervalMs: 60_000 });
    const chunks = [Buffer.alloc(10), Buffer.alloc(20), Buffer.alloc(30)];
    await new Promise((res, rej) => {
      const out = new Writable({ write(c, _e, cb) { cb(); } });
      out.on('finish', res);
      meter.on('error', rej);
      meter.pipe(out);
      for (const c of chunks) meter.write(c);
      meter.end();
    });
    assertEqual(traffic.bytesDown, 60, 'traffic 必须累计所有经过本环节的字节');
    assertEqual(seenSample.length, 1, '间隔内不得逐 chunk 触碰 statsStore（那是 PERF-06 的成因）');
    assertEqual(seenBucket.length, 1, '按桶归集同样只汇总一次');
    assertEqual(seenSample[0], 60, '上报的字节数必须等于 traffic（逐字节相等）');
    assertEqual(seenBucket[0], 60, '按桶上报的字节数与 traffic 同源');
  } finally {
    statsStore.sampleTraffic = realSample;
    statsStore.trackBucket = realBucket;
  }
});

/* ================================================================== *
 * ③ 快照 / 视图层：share-store.js
 * ================================================================== */

test('R51-3 · normalizeItems：归一化字符串与对象两种入参，并硬截断到 SNAPSHOT_MAX', () => {
  assertEqual(shareStore.SNAPSHOT_MAX, 2000, '上限是落盘与分页的共同前提，不能被顺手改小');
  const mixed = shareStore.normalizeItems(['a.txt', { key: 'dir/', size: 999, dir: true }, { key: 'b.txt', size: 7 }]);
  assertEqual(JSON.stringify(mixed), JSON.stringify([
    { key: 'a.txt', size: 0, dir: false },
    { key: 'dir/', size: 0, dir: true }, // 目录的 size 恒 0（不是 999）
    { key: 'b.txt', size: 7, dir: false },
  ]), '字符串按「以 / 结尾即目录」推断，对象的 dir/size 原样采用');

  // 空 key / 非字符串项一律丢弃（脏数据不该变成列表里的一个空行）
  assertEqual(shareStore.normalizeItems(['', null, undefined, 42, { size: 3 }, 'ok.txt']).length, 1,
    '只有带 key 的项能留下');
  assertEqual(shareStore.normalizeItems(null).length, 0, '非数组入参回空数组');
  assertEqual(shareStore.normalizeItems('a.txt').length, 0, '单个字符串不是数组，同样回空');

  const many = [];
  for (let i = 0; i < shareStore.SNAPSHOT_MAX + 500; i += 1) many.push(`f${i}.txt`);
  const cut = shareStore.normalizeItems(many);
  assertEqual(cut.length, shareStore.SNAPSHOT_MAX, `快照必须硬截断到 ${shareStore.SNAPSHOT_MAX}`);
  assertEqual(cut[cut.length - 1].key, `f${shareStore.SNAPSHOT_MAX - 1}.txt`, '截断保留的是前 N 项');
});

test('R51-3 · itemList：历史单文件记录（只有 key/size）也能合成唯一读取点的输出', () => {
  // R51 之前的记录形态：没有 items
  assertEqual(JSON.stringify(shareStore.itemList({ key: 'a.txt', size: 12 })),
    JSON.stringify([{ key: 'a.txt', size: 12, dir: false }]), '历史记录合成一条普通文件');
  assertEqual(JSON.stringify(shareStore.itemList({ key: 'dir/', size: 0 })),
    JSON.stringify([{ key: 'dir/', size: 0, dir: true }]), '以 / 结尾推成目录');
  // items 存在但全是空 key → 回落到 key（磁盘脏数据不该把链接变成空分享）
  assertEqual(shareStore.itemList({ key: 'fallback.txt', size: 1, items: [{ key: '' }] }).length, 1,
    'items 全是空 key 时应回落到顶层 key');
  assertEqual(shareStore.itemList({ key: 'x', size: 1, items: [{ key: '' }] })[0].key, 'x', '回落的正是顶层 key');
  assertEqual(shareStore.itemList(null).length, 0, '无记录回空');
  assertEqual(shareStore.itemList({ size: 3 }).length, 0, '既无 items 也无 key 时回空');

  // itemName：取最后一段，目录去掉结尾斜杠
  assertEqual(shareStore.itemName('a/b/c.txt'), 'c.txt');
  assertEqual(shareStore.itemName('a/b/'), 'b');
  assertEqual(shareStore.itemName('中文/名字'), '名字');
  assertEqual(shareStore.itemName(''), '');
});

test('R51-3 · displayName：单条用条目名，多条写成「首项名 等 N 项」', () => {
  const one = [{ key: 'a.txt', size: 1, dir: false }];
  assertEqual(shareStore.displayName(one), 'a.txt');
  assertEqual(shareStore.displayName([]), 'file', '空集合给兜底名');
  assertEqual(shareStore.displayName([], 'x.bin'), 'x.bin', '有兜底时用兜底');
  assertEqual(shareStore.displayName([
    { key: 'photos/2024/a.jpg', size: 1, dir: false },
    { key: 'photos/2024/b.jpg', size: 1, dir: false },
    { key: 'photos/2024/c.jpg', size: 1, dir: false },
  ]), 'a.jpg 等 3 项', '多条必须是「首项名 等 N 项」（支付订单标题、审计日志都靠它认人）');
});

test('R51-3 · view：listView 判据在服务端（决定列表页与打包语义，两边必须同一个）', async () => {
  const bucket = 'r51-view';
  // ⚠️ `create()` 返回的是**视图**（不含 items / missingAt），要问记录必须走 `get()`
  const single = (await shareStore.create({ key: 'one.txt', bucket, region: 'gz', size: 10 })).id;
  const vs = shareStore.view(shareStore.get(single));
  assertEqual(vs.listView, false, '单个普通文件不得走列表页');
  assertEqual(vs.itemCount, 1, 'itemCount 为 1');
  assertEqual(vs.dirCount, 0, '没有目录');
  assertEqual(vs.totalSize, 10, '总大小取自记录');
  assertEqual(vs.items, undefined, '默认**不**附带 items（链接管理列表会一次拿回上千条）');
  assert(Array.isArray(shareStore.view(shareStore.get(single), { items: true }).items), '要 items 时才附带');

  // ② 唯一一条是文件夹 → 列表页
  const onlyDir = (await shareStore.create({ items: [{ key: 'dir/', size: 0, dir: true }], bucket, region: 'gz' })).id;
  assertEqual(shareStore.view(shareStore.get(onlyDir)).listView, true, '只有一个文件夹也要走列表页（要能勾选）');

  // ③ 多条目 → 列表页
  const multi = (await shareStore.create({
    items: [
      { key: 'a.txt', size: 10, dir: false },
      { key: 'b.txt', size: 20, dir: false },
      { key: 'd/', size: 0, dir: true },
    ],
    bucket, region: 'gz',
  })).id;
  const recMulti = shareStore.get(multi);
  const vm = shareStore.view(recMulti, { items: true });
  assertEqual(vm.listView, true, '多条目必须走列表页');
  assertEqual(vm.itemCount, 3, 'itemCount 含目录行');
  assertEqual(vm.dirCount, 1, 'dirCount 只数目录');
  assertEqual(vm.totalSize, 30, 'totalSize 只累加文件的 size');
  assertEqual(vm.items.length, 3, '要 items 时应完整给出');
  assertEqual(recMulti.fileName, 'a.txt 等 3 项', '记录的文件名是多条目摘要');
  assertEqual(Number(recMulti.size), 30, '记录 size 是文件总量');
  // 链接管理列表不得携带 items（否则一次请求就是几 MB JSON）
  const listed = shareStore.listFor('admin', '').find((x) => x.id === multi);
  assert(listed && listed.items === undefined, 'listFor 的结果不得带 items');
  assertEqual(listed.itemCount, 3, '但 itemCount 必须带出（列表页用它显示「N 项」）');
});

test('R51-3 · create：单一普通文件落盘形态与 R51 之前的记录**逐字段一致**（不写 items）', async () => {
  const bucket = 'r51-shape';
  const l = await shareStore.create({
    key: 'photos/a.jpg', bucket, region: 'gz', fileName: 'a.jpg', size: 1234,
  });
  const raw = shareStore.get(l.id);
  assertEqual(raw.items, undefined, '单文件不得写 items（否则历史数据与新数据出现两种记录形状）');
  assertEqual(raw.key, 'photos/a.jpg', 'key 必须是完整对象路径');
  assertEqual(raw.fileName, 'a.jpg', 'fileName 记录的是这一条的文件名');
  assertEqual(Number(raw.size), 1234, 'size 是对象大小');
  assertEqual(shareStore.view(raw).listView, false, '仍然是单文件页');

  // 但 key 传空（R51 路由的新形态）时，单个普通文件也要能正确推断
  const l2 = await shareStore.create({ items: [{ key: 'x/y.txt', size: 5, dir: false }], bucket, region: 'gz' });
  const raw2 = shareStore.get(l2.id);
  assertEqual(raw2.items, undefined, '从 items 推出的单个普通文件同样不写 items');
  assertEqual(raw2.key, 'x/y.txt', '此时 key 从快照推出来');
  assertEqual(raw2.fileName, 'y.txt', '单条的文件名取条目名');
});

/* ================================================================== *
 * ④ 真发 HTTP 层
 * ================================================================== */

/**
 * 假云端：一个内存对象表 + 按前缀列举（供 POST /links 的快照用）。
 *
 * ⚠️ `getBucket` 必须**真的按 MaxKeys 分页并如实给 IsTruncated / NextMarker**：
 * 返回「一页 2400 条 + IsTruncated:false」这种假造就等于把分页与截断判据一起架空，
 * 截断用例会静默变成「什么都没测」。
 */
function memCloud(files) {
  return {
    headObject(params, cb) {
      const k = params.Key;
      if (Object.prototype.hasOwnProperty.call(files, k)) {
        cb(null, { headers: { 'content-length': String(Buffer.byteLength(files[k])), 'content-type': 'application/octet-stream', 'last-modified': new Date(0).toUTCString() } });
      } else {
        const e = new Error('NoSuchKey'); e.code = 'NoSuchKey'; e.statusCode = 404;
        cb(e, null);
      }
    },
    getObject(params, cb) {
      const k = params.Key;
      if (!Object.prototype.hasOwnProperty.call(files, k)) {
        const e = new Error('NoSuchKey'); e.code = 'NoSuchKey'; e.statusCode = 404;
        return cb(e, null);
      }
      params.Output.end(Buffer.from(files[k]));
      return cb(null, {});
    },
    getBucket(params, cb) {
      const pre = params.Prefix || '';
      const marker = params.Marker || '';
      const max = Math.min(1000, Math.max(1, Number(params.MaxKeys) || 1000));
      const keys = Object.keys(files)
        .filter((k) => k.startsWith(pre) && (!marker || k > marker))
        .sort();
      const page = keys.slice(0, max);
      const isTruncated = keys.length > page.length;
      cb(null, {
        Contents: page.map((k) => ({ Key: k, Size: Buffer.byteLength(files[k]), LastModified: new Date(0).toUTCString() })),
        IsTruncated: isTruncated ? 'true' : 'false',
        NextMarker: isTruncated ? page[page.length - 1].Key : undefined,
      });
    },
  };
}

/** 直接从快照造链接（跳过路由，供分享页 / 下载端点用例用） */
const makeLink = (items, extra = {}) => shareStore.create(Object.assign({
  items, bucket: 'tb', region: 'ap-guangzhou',
  expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'r51',
}, extra));

test('R51-4 · POST /links：接受多路径（文件 + 文件夹）并冻结快照；旧 `path` 仍可用', async () => {
  cloudRef.client = memCloud({
    'a.txt': 'AAA', 'b.txt': 'BBBB',
    'dir/x.txt': 'X', 'dir/sub/y.txt': 'YY',
  });
  const { server, port } = await serve(linkRoutes, '/api', { auth: { username: 'r51', role: 'admin' } });
  try {
    // ① 文件 + 文件夹混选
    const r = await request(port, 'POST', '/api/links', {
      body: { paths: ['a.txt', 'b.txt', 'dir/'], expiresHours: 24 },
    });
    assertEqual(r.status, 200, `多路径创建应成功，实际 ${r.status} ${r.raw.slice(0, 120)}`);
    assertEqual(r.json.ok, true, '应回 ok');
    const rec = shareStore.get(r.json.id);
    const items = shareStore.itemList(rec);
    assertEqual(items.length, 5, '快照 = 2 个文件 + 1 个目录行 + 2 个后代文件');
    assertEqual(items.filter((x) => x.dir).length, 1, '只列顶层目录那一行（扁平：不按层级折叠）');
    assertEqual(items.find((x) => x.key === 'dir/').dir, true, '目录行必须有 dir 标记');
    assert(items.some((x) => x.key === 'dir/sub/y.txt'), '目录的后代文件（含子目录下的）要进快照');
    assertEqual(rec.fileName, 'a.txt 等 5 项', '多条目记录的展示名');
    assertEqual(shareStore.view(rec).totalSize, 3 + 4 + 1 + 2, '总大小为文件之和');

    // ② 旧入口 `path`（单文件）一字不改仍然可用，且落盘仍是旧形态
    const r2 = await request(port, 'POST', '/api/links', { body: { path: 'a.txt' } });
    assertEqual(r2.status, 200, '旧 path 入口必须保持可用');
    assertEqual(shareStore.get(r2.json.id).items, undefined, '单文件仍按旧形态落盘（不写 items）');
    assertEqual(shareStore.view(shareStore.get(r2.json.id)).listView, false, '仍是单文件页');

    // ③ 去重：同一个 key 传两次只快照一条
    const r3 = await request(port, 'POST', '/api/links', { body: { paths: ['a.txt', 'a.txt'] } });
    assertEqual(shareStore.itemList(shareStore.get(r3.json.id)).length, 1, '重复路径必须去重');

    // ④ 文件不存在 → 整单失败（与单文件时代的报错口径一致，不让用户事后才知道）
    const r4 = await request(port, 'POST', '/api/links', { body: { paths: ['a.txt', 'nope.txt'] } });
    assertEqual(r4.status, 404, '选了不存在的对象应 404');
    assert(r4.json.error.includes('nope.txt'), `报错要点名是哪个对象（实际：${r4.json.error}）`);

    // ⑤ 空 paths → 400
    const r5 = await request(port, 'POST', '/api/links', { body: { paths: [] } });
    assertEqual(r5.status, 400, '没有路径应 400');

    // ⑥ path 两边都传时以 paths 为准（collectPaths 的确定语义）
    const r6 = await request(port, 'POST', '/api/links', { body: { paths: ['a.txt'], path: 'b.txt' } });
    assertEqual(shareStore.itemList(shareStore.get(r6.json.id))[0].key, 'a.txt', 'paths 优先于 path');
  } finally {
    server.close();
  }
});

test('R51-4 · POST /links：目录内容超过 2000 时截断并**如实上报**，不静默丢内容', async () => {
  const files = {};
  for (let i = 0; i < shareStore.SNAPSHOT_MAX + 400; i += 1) files[`big/f${i}.txt`] = 'x';
  cloudRef.client = memCloud(files);
  const { server, port } = await serve(linkRoutes, '/api', { auth: { username: 'r51', role: 'admin' } });
  try {
    const r = await request(port, 'POST', '/api/links', { body: { paths: ['big/'] } });
    assertEqual(r.status, 200, '超限是截断而不是失败（分享一个两万文件的目录是合理需求）');
    assertEqual(r.json.truncated, true, '必须如实告知被截断');
    assertEqual(r.json.snapshotMax, shareStore.SNAPSHOT_MAX, '并给出上限数字');
    const items = shareStore.itemList(shareStore.get(r.json.id));
    assertEqual(items.length, shareStore.SNAPSHOT_MAX, `快照硬上限 ${shareStore.SNAPSHOT_MAX}`);
    assertEqual(items[0].dir, true, '第一条是目录行');
    assert(LOGS.some((l) => /已截断/.test(l.detail || '')), '审计日志要记下这次截断');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id：>50 项分页（50 整不分页），?page= 一律夹取到合法范围', async () => {
  const mk = async (n) => {
    const items = [];
    for (let i = 0; i < n; i += 1) items.push({ key: `f${String(i).padStart(3, '0')}.txt`, size: 1, dir: false });
    return makeLink(items);
  };
  const { server, port } = await serve(shareRoutes, '');
  try {
    // ① 51 项 → 2 页
    const l51 = await mk(51);
    const p1 = await httpGetBuf(port, '/s/' + l51.id);
    assertEqual(p1.status, 200, '列表页应 200');
    const html1 = p1.buf.toString('utf8');
    assert(html1.includes('第 1 / 2 页'), '第 1 页应写明总页数');
    assertEqual((html1.match(/name="k"/g) || []).length, 50, '第 1 页恰好 50 个复选框');
    assert(html1.includes('/s/' + l51.id + '?page=2'), '应给出第 2 页链接');
    assert(html1.includes('下一页'), '应有「下一页」');
    assert(!html1.includes('上一页'), '第 1 页不应有「上一页」');
    assert(html1.includes('id="sl-form"') && html1.includes('/js/share-list.js'),
      '列表页必须给出原生表单与勾选脚本（脚本缺失时表单仍可用）');
    assert(html1.includes('/s/' + l51.id + '/dl'), '应给出「打包下载全部」入口');

    const p2 = await httpGetBuf(port, '/s/' + l51.id + '?page=2');
    const html2 = p2.buf.toString('utf8');
    assert(html2.includes('第 2 / 2 页'), '第 2 页');
    assertEqual((html2.match(/name="k"/g) || []).length, 1, '第 2 页只剩 1 行');
    assert(html2.includes('f050.txt'), '第 2 页是最后一行的那一个');
    assert(html2.includes('上一页'), '第 2 页应有「上一页」');
    assert(!html2.includes('下一页'), '最后一页不应有「下一页」');

    // ② 夹取：越界 / 非法一律回落到合法页，而不是 500 或空页
    for (const [q, want] of [['?page=999', '第 2 / 2 页'], ['?page=0', '第 1 / 2 页'],
      ['?page=-3', '第 1 / 2 页'], ['?page=abc', '第 1 / 2 页'], ['?page=2.7', '第 2 / 2 页']]) {
      const r = await httpGetBuf(port, '/s/' + l51.id + q);
      assertEqual(r.status, 200, `page=${q} 应 200`);
      assert(r.buf.toString('utf8').includes(want), `page=${q} 应落在「${want}」`);
    }

    // ③ 恰好 50 项 → 1 页、无分页条
    const l50 = await mk(50);
    const e50 = await httpGetBuf(port, '/s/' + l50.id);
    const htmlE = e50.buf.toString('utf8');
    assert(htmlE.includes('第 1 / 1 页'), '恰好 50 项只有 1 页');
    assert(!htmlE.includes('上一页') && !htmlE.includes('下一页'), '单页不得出现分页按钮');

    // ④ 文件夹行排在文件之前（与文件管理器一致），且显示的是相对路径
    const ld = await makeLink([
      { key: 'a.txt', size: 1, dir: false },
      { key: 'zdir/', size: 0, dir: true },
    ]);
    const hd = (await httpGetBuf(port, '/s/' + ld.id)).buf.toString('utf8');
    const firstRow = hd.indexOf('class="sl-row"');
    assert(firstRow > 0, '应有列表行');
    assert(hd.slice(firstRow, firstRow + 400).includes('zdir/'),
      '文件夹必须排在文件前面（扁平列表里唯一还保留的顺序信息）');
    assert(hd.includes('a.txt'), '文件行也在');
    assert(/共 2 项（1 个文件夹 \/ 1 个文件）/.test(hd), '摘要要按「文件夹 / 文件」分列');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id：单个普通文件仍是单文件页（不因 R51 变成列表）', async () => {
  cloudRef.client = memCloud({ 'photos/a.jpg': 'x' }); // 对象必须真的在，否则惰性探测会把链接判成「已删除」
  const l = await makeLink([{ key: 'photos/a.jpg', size: 1024, dir: false }]);
  const { server, port } = await serve(shareRoutes, '');
  try {
    const r = await httpGetBuf(port, '/s/' + l.id);
    const html = r.buf.toString('utf8');
    assertEqual(r.status, 200, '单文件页应 200');
    assert(!html.includes('sl-form'), '单文件页不该出现列表表单');
    assert(html.includes('<svg class="file-icon"'), '单文件页仍内联文件类型图标（R50 的能力不能退化）');
    assert(html.includes('a.jpg'), '文件名照常展示');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id：文件夹分享不因「前缀 head 不到」被误判成已删除', async () => {
  /**
   * 惰性探测用 `headObject(key)` 判断对象还在不在。但**目录前缀永远不是一个对象**，
   * head 必然 404 —— 若沿用同一判据，任何文件夹分享都会在第一次访问时被永久判死
   * （410「文件已被删除」）。故 `probeObjectMissing` 必须对列表页形态短路。
   */
  cloudRef.client = memCloud({}); // 桶里干干净净：head 任何 key 都 404
  const l = await makeLink([{ key: 'somewhere/', size: 0, dir: true }]);
  const { server, port } = await serve(shareRoutes, '');
  try {
    const r = await httpGetBuf(port, '/s/' + l.id);
    assertEqual(r.status, 200, '文件夹分享不得因为 head 前缀失败而变成 410');
    assert(!shareStore.get(l.id).missingAt, '不得给列表形态的链接落「已删除」标记');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id/dl：非快照 key 一律 400 且**不占用下载次数**', async () => {
  cloudRef.client = memCloud({ 'a.txt': 'A' });
  const l = await makeLink([
    { key: 'a.txt', size: 1, dir: false },
    { key: 'b.txt', size: 1, dir: false },
  ], { maxDownloads: 3 });
  const { server, port } = await serve(shareRoutes, '');
  try {
    const before = Number(shareStore.get(l.id).downloads);
    for (const evil of ['../../etc/passwd', '/etc/passwd', 'zzz.txt', 'dir/../a.txt', 'a.txt ', 'a.txt\0']) {
      const r = await httpGetBuf(port, '/s/' + l.id + '/dl?k=' + encodeURIComponent(evil));
      assertEqual(r.status, 400, `key=${JSON.stringify(evil)} 必须被拒（不得成为任意对象下载器）`);
      assert(/选择无效/.test(r.buf.toString('utf8')), '应给「选择无效」而不是泛泛的失败');
    }
    // 空 k 不表示「选了非法对象」，而是「什么都没选」—— 口径不同，状态码也不同
    const empty = await httpGetBuf(port, '/s/' + l.id + '/dl?k=');
    assertEqual(empty.status, 404, '空选择应 404（没有可下载的文件），而不是 400');
    assert(/没有可下载的文件/.test(empty.buf.toString('utf8')), '要说明原因');
    // 混入一个合法 key 也不能整体放行
    const mixed = await httpGetBuf(port, '/s/' + l.id + '/dl?k=a.txt&k=../../etc/passwd');
    assertEqual(mixed.status, 400, '只要有一个 key 不在快照里就整批拒绝');
    assertEqual(Number(shareStore.get(l.id).downloads), before,
      '被拒的请求绝不能占用下载次数（否则反复探测就能刷光额度）');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id/dl：单选一个文件按原名直传（保留进度与 Range 续传）', async () => {
  cloudRef.client = memCloud({ 'a.txt': 'AAAA', 'b.txt': 'BB' });
  const l = await makeLink([
    { key: 'a.txt', size: 4, dir: false },
    { key: 'b.txt', size: 2, dir: false },
  ], { maxDownloads: 5 });
  const { server, port } = await serve(shareRoutes, '');
  try {
    // ① 显式勾一个
    const r = await httpGetBuf(port, '/s/' + l.id + '/dl?k=a.txt');
    assertEqual(r.status, 200, `单选直传应 200，实际 ${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
    assertEqual(r.buf.toString('utf8'), 'AAAA', '拿到的应是原文，而不是一个 tar.gz');
    assert(!r.headers['content-type'].includes('gzip'), '单选不得加一层 gzip');
    assertEqual(Number(r.headers['content-length']), 4, '直传要能给出 Content-Length（进度条与续传的前提）');
    const cd = r.headers['content-disposition'];
    assertEqual(/filename="([^"]*)"/.exec(cd)[1], 'a.txt', '文件名应是所选对象的 basename');

    // ② 不带 k（「打包下载全部」按钮 / 老客户端）在单文件链接上等价于选它
    const r2 = await httpGetBuf(port, '/s/' + l.id + '/dl?k=b.txt');
    assertEqual(r2.buf.toString('utf8'), 'BB', '另一个对象的内容');

    // ③ 整批算 1 次：两次请求各消耗 1
    assertEqual(Number(shareStore.get(l.id).downloads), 2, '每次请求消耗 1 次名额');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id/dl：多选或含文件夹 → 打包成 .tar.gz，且整批只记 1 次', async () => {
  const files = { 'a.txt': 'AAA', 'b.txt': 'BB', 'dir/x.txt': 'X', 'dir/sub/y.txt': 'YY' };
  cloudRef.client = memCloud(files);
  const l = await makeLink([
    { key: 'a.txt', size: 3, dir: false },
    { key: 'b.txt', size: 2, dir: false },
    { key: 'dir/', size: 0, dir: true },
    { key: 'dir/x.txt', size: 1, dir: false },
    { key: 'dir/sub/y.txt', size: 2, dir: false },
  ], { maxDownloads: 9 });
  const { server, port } = await serve(shareRoutes, '');
  try {
    // ① 多选两个文件
    const r = await httpGetBuf(port, '/s/' + l.id + '/dl?k=a.txt&k=b.txt');
    assertEqual(r.status, 200, `多选应 200，实际 ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
    assertEqual(r.headers['content-type'], 'application/gzip', '多选必须打包下发');
    assertEqual(r.headers['content-length'], undefined, '打包是 chunked：压缩后长度不可预知');
    const parsed = parseTar(zlib.gunzipSync(r.buf));
    const names = parsed.map((x) => x.name);
    assertEqual(names.filter((n) => n.endsWith('.txt')).length, 2, '只打包勾选的那两个文件');
    assert(names.some((n) => n.endsWith('/a.txt')) && names.some((n) => n.endsWith('/b.txt')), '两个都在');
    assert(!names.some((n) => n.includes('x.txt')), '没勾的目录内容不得混进来');
    assertEqual(Number(shareStore.get(l.id).downloads), 1,
      '整批只记 1 次 —— 勾 3 个和勾 300 个都是「一次下载」');

    // ② 只勾一个目录 → 也要打包（展开它前缀下的全部文件）
    const r2 = await httpGetBuf(port, '/s/' + l.id + '/dl?k=' + encodeURIComponent('dir/'));
    assertEqual(r2.status, 200, '勾目录应 200');
    assertEqual(r2.headers['content-type'], 'application/gzip', '勾了文件夹必须打包');
    const parsed2 = parseTar(zlib.gunzipSync(r2.buf));
    const names2 = parsed2.map((x) => x.name);
    assert(names2.some((n) => n.endsWith('/dir/x.txt')), '目录下的文件要展开进去');
    assert(names2.some((n) => n.endsWith('/dir/sub/y.txt')), '子目录也要展开');
    assert(!names2.some((n) => n.endsWith('/a.txt')), '没勾的文件不得混进来');
    // 解包出来的字节要与对象内容一致
    const xEntry = parsed2.find((n) => n.name.endsWith('/dir/x.txt'));
    assertEqual(xEntry.body.toString('utf8'), 'X', '展开出来的内容必须正确');
    assertEqual(Number(shareStore.get(l.id).downloads), 2, '第二次请求再记 1 次');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id/dl：选择里没有文件（空文件夹）→ 404，且不下发空 tar.gz', async () => {
  cloudRef.client = memCloud({ 'empty/': '' });
  const l = await makeLink([{ key: 'empty/', size: 0, dir: true }], { maxDownloads: 4 });
  const { server, port } = await serve(shareRoutes, '');
  try {
    const r = await httpGetBuf(port, '/s/' + l.id + '/dl?k=' + encodeURIComponent('empty/'));
    assertEqual(r.status, 404, '空文件夹应给 404 而不是一个空的 tar.gz');
    assert(/没有可下载的文件/.test(r.buf.toString('utf8')), '要说明原因');
    assertEqual(Number(shareStore.get(l.id).downloads), 0, '被拒的请求不占用次数');
    // 整个分享页也不该给出下载入口
    const page = await httpGetBuf(port, '/s/' + l.id);
    assert(/没有可下载的文件/.test(page.buf.toString('utf8')), '分享页也要如实说明没有文件可下');
    assert(!page.buf.toString('utf8').includes('id="sl-download"'), '没有文件时不该有「下载选中」按钮');
  } finally {
    server.close();
  }
});

test('R51-4 · GET /s/:id/dl：多条目链接里缺一个对象时跳过它，不让整包失败', async () => {
  // b.txt 在快照里，但云端已经没有了
  cloudRef.client = memCloud({ 'a.txt': 'AAA' });
  const l = await makeLink([
    { key: 'a.txt', size: 3, dir: false },
    { key: 'b.txt', size: 2, dir: false },
  ], { maxDownloads: 4 });
  const { server, port } = await serve(shareRoutes, '');
  try {
    const r = await httpGetBuf(port, '/s/' + l.id + '/dl?k=a.txt&k=b.txt');
    assertEqual(r.status, 200, '一个对象没了不该让整包下不了（一条分享里 2000 个对象）');
    const parsed = parseTar(zlib.gunzipSync(r.buf));
    const names = parsed.map((x) => x.name);
    assert(names.some((n) => n.endsWith('/a.txt')), '拿得到的对象必须在包里');
    assert(!names.some((n) => n.endsWith('/b.txt')), '拿不到的不得出现');
    assert(LOGS.some((x) => /跳过已不存在的对象/.test(x.detail || '')), '要留下告警日志便于排查');
  } finally {
    server.close();
  }
});

/* ================================================================== *
 * ⑤ 沙箱行为层
 * ================================================================== */

function mkTempSandbox(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r51-' + tag + '-'));
}

/**
 * 假的模块图（真实 `ops.js` + 桩依赖）。
 * 与 audit50 同法：一律 copy 真实文件，避免测到测试自己的副本。
 */
async function loadOps({ failQr = false } = {}) {
  const dir = mkTempSandbox('ops');
  fs.copyFileSync(JS('ops.js'), path.join(dir, 'ops.js'));
  // ⚠️ 二维码 SVG 用 JSON.stringify 注入，避免在模板字符串里堆反斜杠（那会真的把文件写坏）
  const qrSvg = '<svg id="qr"><rect/></svg>';
  const qrBody = failQr
    ? "throw new Error('内容过长，无法生成二维码（当前最多支持 213 字节）');"
    : `return { svg: ${JSON.stringify(qrSvg)} };`;
  fs.writeFileSync(path.join(dir, 'api.js'), `
export const API = {
  linkQrcode: async () => { ${qrBody} },
  createLink: async (body) => { globalThis.__r51Body = body; return { ok: true, id: 'L1', fileName: 'a.txt 等 2 项', createdAt: new Date().toISOString(), expiresAt: null, maxDownloads: 0, downloads: 0, hasPassword: false, paid: { required: false } }; },
  presign: async () => ({ url: 'https://x/y' }),
};
`);
  fs.writeFileSync(path.join(dir, 'util.js'), `
export const __toast = (globalThis.__r51Toast = []);
export function isStaffRole(role) { return role === 'admin' || role === 'root'; }
export function roleLabel(role) { return role === 'root' ? '根用户' : (role === 'admin' ? '管理员' : '普通用户'); }
export function toast(m, o) { globalThis.__r51Toast.push([m, o]); }
export function confirmDialog() { return Promise.resolve(true); }
export function promptDialog() { return Promise.resolve('x'); }
export const __modal = (globalThis.__r51Modal = []);
export function openModal(o) { globalThis.__r51Modal.push(o); return { close() {} }; }
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fmtSize(n) { return n + ' B'; }
export function fmtTime(t) { return 'T(' + t + ')'; }
`);
  fs.writeFileSync(path.join(dir, 'main.js'), `
export const App = { state: { prefix: '', bucket: 'demo', config: { bucket: 'demo' }, selection: new Set(), user: { role: 'admin' } } };
`);
  fs.writeFileSync(path.join(dir, 'enc.js'), 'export function openDownload() {}');
  fs.writeFileSync(path.join(dir, 'speedlimit.js'), `
export function parseMbpsInput(v) { return { ok: true, bytes: Number(v) || 0 }; }
export function ceilingText() { return ''; }
export async function fetchCeiling() { return null; }
export function toMBps(n) { return String(n / 1048576); }
`);
  const dom = installOpsDom();
  const m = await import(require('url').pathToFileURL(path.join(dir, 'ops.js')).href);
  return { ops: m.ops, dom, dir };
}

/** 只覆盖 ops.js 真正会碰到的那些 DOM 能力 */
function installOpsDom() {
  const created = [];
  const byId = new Map();
  const mk = (label) => {
    const el = {
      _label: label, innerHTML: '', textContent: '', value: '', checked: false,
      disabled: false, hidden: false, style: {}, _ev: {}, _kids: new Map(), _appended: [],
      parentNode: null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); } },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(t, fn) { this._ev[t] = fn; },
      // 选择器按**字面量**分桶：本用例只依赖 ops.js 里出现的那些选择器
      querySelector(sel) {
        if (sel === 'input[name=lk-type]:checked') {
          return Array.from(this._kids.values()).find((x) => x._radio && x.checked) || null;
        }
        if (!this._kids.has(sel)) {
          const child = mk(label + '>' + sel);
          if (sel === 'input[name=lk-type]') child._radio = true;
          // ops.js 里被当作单选组用的那次查询需要拿到具体值
          if (sel === 'input[name=lk-type]') child.value = 'managed';
          this._kids.set(sel, child);
        }
        return this._kids.get(sel);
      },
      querySelectorAll(sel) {
        if (sel === 'input[name=lk-type]') {
          if (!this._qsaType) {
            const managed = mk('radio:managed'); managed._radio = true; managed.value = 'managed'; managed.checked = true;
            const direct = mk('radio:direct'); direct._radio = true; direct.value = 'direct';
            this._qsaType = [managed, direct];
            this._kids.set('input[name=lk-type]', managed);
          }
          return this._qsaType;
        }
        return [];
      },
      appendChild(n) { n.parentNode = this; this._appended.push(n); return n; },
      removeChild(n) { this._appended = this._appended.filter((x) => x !== n); return n; },
      remove() {}, focus() {}, select() {}, click() {},
    };
    created.push(el);
    return el;
  };
  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mk('#' + id)); return byId.get(id); },
    createElement: (t) => mk('<' + t + '>'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: mk('body'),
    currentScript: null,
  };
  globalThis.navigator = { clipboard: { writeText: async () => true } };
  globalThis.toast = () => {};
  globalThis.location = { origin: 'https://pan.example.com', pathname: '/' };
  return { created, byId, mk };
}

/**
 * 从弹窗 HTML 里取「预签名直链」那个单选项的标签，判它带不带 `disabled`。
 *
 * ⚠️ 必须判**下发出去的 HTML**，而不是某个假 DOM 节点上的 `.disabled` 属性：
 * 假 DOM 不解析 `innerHTML`，属性永远读成 false —— 那是一条永远绿的假判据。
 */
function directRadioTag(html) {
  const m = /<input type="radio" name="lk-type" value="direct"([^>]*)>/.exec(html);
  assert(m, '弹窗里应有预签名直链单选项');
  return m[1];
}

test('R51-5 · ops.copyLinkKeys：多选 / 含文件夹时禁用预签名直链，提交体走 `paths`', async () => {
  const { ops } = await loadOps();
  globalThis.__r51Modal.length = 0;
  globalThis.__r51Body = null;

  // 多选（含一个文件夹，且超过 6 项以覆盖折叠预览）
  const many = ['a.txt', 'b.txt', 'dir/', 'd.txt', 'e.txt', 'f.txt', 'g.txt', 'h.txt'];
  await ops.copyLinkKeys(many);
  assertEqual(globalThis.__r51Modal.length, 1, '应弹出一个创建对话框');
  const wrap = globalThis.__r51Modal[0].body;
  assert(/disabled/.test(directRadioTag(wrap.innerHTML)),
    '多选时预签名直链必须被禁用（一次只能签一个文件）');
  assert(wrap.innerHTML.includes('8 项'), '预览要写明共几项');
  assert(wrap.innerHTML.includes('…还有 2 项'), '超过 6 项时要有「还有 N 项」的折叠');

  // 触发「生成链接」
  const gen = globalThis.__r51Modal[0].foot.find((f) => f.cls === 'primary');
  let closed = false;
  await gen.onClick(null, () => { closed = true; });
  assertEqual(globalThis.__r51Body.paths.length, 8, '提交体必须带完整的 paths 数组');
  assertEqual(globalThis.__r51Body.paths.join(','), many.join(','), '顺序即用户勾选顺序');
  assertEqual(globalThis.__r51Body.path, undefined, '不应再走旧的单 path 字段');
  assertEqual(closed, true, '成功后应关闭对话框');

  // 单选一个普通文件 → 直链可选
  const { ops: ops2 } = await loadOps();
  globalThis.__r51Modal.length = 0;
  await ops2.copyLinkKeys(['one.txt']);
  const h2 = globalThis.__r51Modal[0].body.innerHTML;
  assert(!/disabled/.test(directRadioTag(h2)), '单选一个文件时直链必须可用');

  // 单选一个**文件夹** → 直链仍不可用（文件夹没有预签名直链）
  const { ops: ops3 } = await loadOps();
  globalThis.__r51Modal.length = 0;
  await ops3.copyLinkKeys(['dir/']);
  assert(/disabled/.test(directRadioTag(globalThis.__r51Modal[0].body.innerHTML)),
    '单个文件夹也不能用直链');
});

test('R51-5 · ops.showLinkResult：链接用 div 一行展示、二维码内联、弹窗按内容加宽', async () => {
  const { ops } = await loadOps();
  globalThis.__r51Modal.length = 0;
  const url = 'https://pan.example.com/s/' + 'A'.repeat(22);
  await ops.copyLinkKeys(['one.txt']);
  const foot = globalThis.__r51Modal[0].foot;
  await foot.find((f) => f.cls === 'primary').onClick(null, () => {});
  // 生成的是托管链接 → 走 showLinkResult
  assertEqual(globalThis.__r51Modal.length, 2, '应再弹出「链接创建成功」对话框');
  const modal = globalThis.__r51Modal[1];
  assertEqual(modal.cls, 'link-result-dialog', '弹窗必须带上专属类名 —— 宽度就是由它给的');
  const html = modal.body.innerHTML;
  assert(html.includes('class="lr-url"'), '链接必须用 div 展示（需求原文：使用 div 展示链接）');
  assert(!/<textarea/.test(html), '不应再是只读 textarea');
  assert(html.includes('lr-qr'), '要有二维码容器');
  assert(html.includes('id="lr-copy"'), '要有「复制」按钮');
  for (const label of ['文件名', '链接创建时间', '过期时间', '价格', '允许下载次数']) {
    assert(html.includes(label), `信息区必须列出「${label}」`);
  }
  // 二维码是异步填进去的，等一个微任务
  await new Promise((r) => setTimeout(r, 10));
  const qrBox = modal.body.querySelector('#lr-qr');
  assert(qrBox.innerHTML.includes('<svg'), '二维码 SVG 必须填进容器');

  // 生成不出来时，那个位置要显示说明而不是一块空白（用户对着空白扫码只会怪自己的手机）
  const { ops: opsF } = await loadOps({ failQr: true });
  globalThis.__r51Modal.length = 0;
  await opsF.copyLinkKeys(['one.txt']);
  await globalThis.__r51Modal[0].foot.find((f) => f.cls === 'primary').onClick(null, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const failBox = globalThis.__r51Modal[1].body.querySelector('#lr-qr');
  assert(/无法生成二维码|生成失败/.test(failBox.innerHTML), '生成失败必须如实说明原因');
});

test('R51-5 · 样式：链接容器不折行 + 弹窗宽度按内容给（一行显示完的落脚点）', () => {
  const css = fs.readFileSync(PUBLIC('css', 'style.css'), 'utf8');
  const rule = /\.dialog\.link-result-dialog\s*\{([^}]*)\}/.exec(css);
  assert(rule, '必须有 .dialog.link-result-dialog 规则');
  assert(/width:\s*min\(900px,\s*96vw\)/.test(rule[1]),
    '宽度必须按内容给（900px / 96vw），默认 480px 减去二维码后只剩 ~290px');
  const urlRule = /\.lr-url\s*\{([^}]*)\}/.exec(css);
  assert(urlRule, '必须有 .lr-url 规则');
  assert(/white-space:\s*nowrap/.test(urlRule[1]), '链接必须不折行（需求：一行显示完）');
  assert(/overflow-x:\s*auto/.test(urlRule[1]), '超长地址（预签名直链）退化为横向滚动而不是切成多行');
  assert(!/word-break:\s*break-all/.test(urlRule[1]), '旧的逐字符强断必须移除（它是折行的直接原因）');
  assert(/user-select:\s*text/.test(urlRule[1]), '仍要能手动框选复制');
  // 扫码时拇指不该挡住信息：二维码在左
  assert(/\.lr-wrap\s*\{[^}]*display:\s*flex/.test(css), '左二维码右信息的横排布局');
  // R52：尺寸从 172px 提到 208px —— 见「R52-06 · 链接结果弹窗左右视觉等高」那条用例；
  // 这里只钉「宽度固定、信息区吃剩余空间」这个分工本身，不重复钉具体数值。
  assert(/\.lr-qr\s*\{[^}]*flex:\s*0 0 \d+px/.test(css), '二维码固定宽度，信息区吃剩余空间');
});

/**
 * 勾选脚本的假 DOM —— 只覆盖 `public/js/share-list.js` 会碰到的能力。
 * `boxes` 是当前页的复选框（value = 对象 key）。
 */
function installShareListDom({ linkId = 'LNK1', boxes = [], pathname = '/s/LNK1', storage = null } = {}) {
  const store = storage || new Map();
  const mkInput = (value, extra = {}) => ({
    value, checked: false, type: 'checkbox', name: 'k', parentNode: null, attrs: {},
    _ev: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    closest(sel) { return sel === '.sl-row' ? (extra.row || null) : null; },
    addEventListener(t, fn) { this._ev[t] = fn; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
  });
  const boxEls = boxes.map((k) => {
    const row = { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } } };
    return mkInput(k, { row });
  });
  const extras = [];
  const form = {
    _ev: {},
    querySelectorAll(sel) {
      if (sel === 'input[type=checkbox][name=k]') return boxEls;
      if (sel === 'input[data-sl-extra]') return extras.slice();
      return [];
    },
    addEventListener(t, fn) { this._ev[t] = fn; },
    appendChild(n) { extras.push(n); n.parentNode = form; return n; },
    removeChild(n) { const i = extras.indexOf(n); if (i >= 0) extras.splice(i, 1); return n; },
  };
  const countEl = { textContent: '第 1 / 2 页' };
  const btnAll = { _ev: {}, addEventListener(t, fn) { this._ev[t] = fn; } };
  const btnNone = { _ev: {}, addEventListener(t, fn) { this._ev[t] = fn; } };
  const created = [];
  globalThis.document = {
    currentScript: { getAttribute: (k) => (k === 'data-link-id' ? linkId : null) },
    getElementById(id) {
      if (id === 'sl-form') return form;
      if (id === 'sl-count') return countEl;
      if (id === 'sl-all') return btnAll;
      if (id === 'sl-none') return btnNone;
      return null;
    },
    createElement() {
      const n = mkInput('');
      n.type = 'hidden';
      created.push(n);
      return n;
    },
  };
  globalThis.location = { pathname };
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  return { form, boxes: boxEls, countEl, btnAll, btnNone, store, created, extras };
}

/** 在一个干净的假 DOM 里跑一遍真实的 share-list.js */
function runShareList(opt) {
  const dom = installShareListDom(opt);
  const src = fs.readFileSync(JS('share-list.js'), 'utf8');
  new Function(src)();
  return dom;
}

test('R51-5 · share-list：勾选跨页累计（sessionStorage 按链接隔离），提交时补成隐藏 k 字段', () => {
  /**
   * R52-04 起「首次打开默认全选」（见 audit52 的对应用例），而本用例要测的是
   * **用户动手之后**的跨页累计 —— 故先往存储里放一个"已初始化且一个都没选"的状态
   * （`[]`）。这正是两种初始化语义的分界点：键**在**（哪怕值是空数组）= 用户说了算。
   */
  const store = new Map([['kepler.share.sel.LNK1', '[]']]);
  // 第 1 页：勾 a、b
  const p1 = runShareList({ linkId: 'LNK1', boxes: ['a.txt', 'b.txt', 'c.txt'], pathname: '/s/LNK1', storage: store });
  p1.boxes[0].checked = true;
  p1.boxes[0]._ev.change({ target: p1.boxes[0] });
  p1.boxes[1].checked = true;
  p1.boxes[1]._ev.change({ target: p1.boxes[1] });
  assertEqual(p1.store.get('kepler.share.sel.LNK1'), '["a.txt","b.txt"]', '勾选要落进 sessionStorage');
  assert(/已选 2 项/.test(p1.countEl.textContent), '页上的计数要跟着更新');

  // 第 2 页（同一标签页、同一链接）：已勾的仍在，本页框默认不勾
  const p2 = runShareList({ linkId: 'LNK1', boxes: ['d.txt', 'e.txt'], pathname: '/s/LNK1', storage: p1.store });
  assertEqual(p2.boxes[0].checked, false, '第 2 页的框不应被自动勾上（页面里没有 a/b）');
  assertEqual(p2.store.get('kepler.share.sel.LNK1'), '["a.txt","b.txt"]', '选择必须跨页保留');
  p2.boxes[1].checked = true;
  p2.boxes[1]._ev.change({ target: p2.boxes[1] });

  // 提交：只补「其它页的」勾选
  p2.form._ev.submit();
  const values = p2.extras.map((n) => n.value).sort();
  assertEqual(values.join(','), 'a.txt,b.txt', '其它页已勾的必须补成隐藏字段（本页勾的已有同名复选框）');
  assert(p2.extras.every((n) => n.name === 'k'), '隐藏字段必须叫 k');
  assert(p2.extras.every((n) => n.type === 'hidden'), '必须是隐藏字段');
  // 再次提交不得累积重复项（用户按后退回来再提交的情形）
  p2.form._ev.submit();
  assertEqual(p2.extras.length, 2, '重复提交不得产生重复项');

  // 「全选本页」只加本页；「清空选择」清的是全部（含其它页）
  p2.btnAll._ev.click();
  assertEqual(p2.boxes.every((b) => b.checked), true, '全选本页要勾上本页所有框');
  assertEqual(JSON.parse(p2.store.get('kepler.share.sel.LNK1')).sort().join(','), 'a.txt,b.txt,d.txt,e.txt',
    '全选后已选 = 原有 + 本页');
  p2.btnNone._ev.click();
  assertEqual(JSON.parse(p2.store.get('kepler.share.sel.LNK1')).length, 0,
    '「清空选择」必须清全部，否则用户清完再翻页会发现「怎么还有」');
  assertEqual(p2.countEl.textContent, '第 1 / 2 页', '没有选择时计数回落为页码文本');
});

test('R51-5 · share-list：链接 id 从 data-link-id 取（缺失时回退地址栏），存储不可用要降级而非抛错', () => {
  // ① 缺 data-link-id → 从 /s/<id> 解析（location.pathname 不含查询串）
  const a = runShareList({ linkId: null, boxes: ['x.txt'], pathname: '/s/ABC-123' });
  a.boxes[0].checked = true;
  a.boxes[0]._ev.change({ target: a.boxes[0] });
  assert(a.store.has('kepler.share.sel.ABC-123'), '应从地址栏回退取得链接 id');

  // ② 完全取不到 id → 直接不干活（不抛错、不挂监听、不写存储）
  const b = runShareList({ linkId: null, boxes: ['x.txt'], pathname: '/other' });
  assertEqual(b.store.size, 0, '没有链接 id 时不应写入任何存储');
  assertEqual(typeof b.boxes[0]._ev.change, 'undefined', '没有链接 id 时不该挂上任何监听');
  assertEqual(typeof b.form._ev.submit, 'undefined', '也不该给表单挂提交处理');

  // ③ 存储被禁用（隐私模式）→ 退化成「只有本页勾选」，功能仍可用
  const c = installShareListDom({ linkId: 'LNK9', boxes: ['y.txt'] });
  globalThis.sessionStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  new Function(fs.readFileSync(JS('share-list.js'), 'utf8'))();
  c.boxes[0].checked = true;
  c.boxes[0]._ev.change({ target: c.boxes[0] });
  assertEqual(c.boxes[0].checked, true, '存储不可用时本页勾选仍要正常工作');
  assert(c.form._ev.submit, '提交处理也要挂上（否则无 JS 环境的表单行为都拿不到）');
});

test('R51-5 · 分享页列表脚本必须是同源**普通脚本**（CSP 无 unsafe-inline；module 里 currentScript 为 null）', () => {
  const src = fs.readFileSync(JS('share-list.js'), 'utf8');
  const routes = fs.readFileSync(SERVER('share-routes.js'), 'utf8');
  /**
   * ⚠️ 判据窗口必须**锚在这个 `<script>` 标签自己身上**。
   *
   * 原先写的是 `routes.slice(routes.lastIndexOf('<script', routes.indexOf('share-list.js')), ...)`：
   * 它侥幸能通过，是因为 `share-list.js` 的首次命中落在注释里、而注释之前没有 `<script`，
   * `lastIndexOf` 返回 -1 → 从最后一个字符切到下一个 `</script>` —— 整段模板都在窗口里。
   * 页面上一旦出现**第二个** `<script>` 块（R52 注入 key 清单的那个 JSON 块就在它前面），
   * 窗口立刻收缩成那个块本身，断言随之报红。这正是"选择器取第一次出现会被更靠前的
   * 同名前缀截走"的同一类失效 —— 故改为直接定位本标签的起止，不再依赖任何相对位置。
   */
  const tagStart = routes.indexOf('<script src="/js/share-list.js"');
  assert(tagStart > 0, '列表页必须以 `<script src="/js/share-list.js">` 引入勾选脚本');
  const tag = routes.slice(tagStart, routes.indexOf('>', tagStart) + 1);
  assert(/src="\/js\/share-list\.js"/.test(tag), '必须是同源静态文件（script-src self）');
  assert(/data-link-id=/.test(tag), '必须带 data-link-id（普通脚本据此拿链接 id）');
  assert(!/type="module"/.test(tag),
    '不能是 module：document.currentScript 在 module 里恒为 null，拿不到链接 id');
  // CSP 里没有 unsafe-inline ⇒ 内联脚本会被浏览器直接拒绝执行（本文件没走那条路）
  // ⚠️ 先剥掉行注释再找指令：`SEC-06：移除 script-src 的 'unsafe-inline'。` 这行注释
  //    本身就含字面量，不剥注释会命中注释而得到一条恒假的判据。
  const idx = fs.readFileSync(SERVER('index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const csp = /script-src([^;]*)/.exec(idx);
  assert(csp, 'index.js 里应有 script-src 指令');
  assertEqual(/'self'/.test(csp[1]), true, "script-src 必须仍允许 'self'（否则同源脚本都被拦）");
  assert(!/unsafe-inline/.test(csp[1]),
    'script-src 里不得有 unsafe-inline（若将来加了，本用例的前提失效，须重新评估注入方式）');
  // 勾选脚本不得自己构造下载 URL / 发请求：下载必须走浏览器导航才有进度与「另存为」
  assert(!/\bfetch\s*\(/.test(src), '勾选脚本不得自己发请求');
  assert(!/XMLHttpRequest|location\s*\.\s*href\s*=/.test(src), '也不得自行跳转');
});
