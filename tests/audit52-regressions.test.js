/**
 * 第 52 轮护栏 —— 文件管理的三处可用性缺口 + 分享页两处（R52-01 ~ R52-06）
 *
 * 需求原文：
 *  1. 「当前已有文件夹分享，但并未实现多文件和文件夹的分享（即：既可以选择多文件，
 *      也可以同时选择文件和文件夹）」；
 *  2. 「当前的『移动』功能：多文件移动时，前端报告移动成功，但实际未成功」；
 *  3. 「当前已有单文件、文件夹的『移动』功能，但没有『复制粘贴』的功能」；
 *  4. 「文件分享页：如果有多个文件/文件夹，应默认选中全部」；
 *  5. 「文件分享页：如果分享了子文件夹，则文件名中还是会显示上一级文件夹的名称，
 *      这可能会暴露隐私，修复它」。
 *
 * 用户确认的四条口径：
 *  · R52-1 入口：**多选右键菜单补「复制链接（N 项）」**（与工具栏一致）；
 *  · R52-2 移动：**默认不预选当前目录 + 结果如实汇总**（成功 / 跳过 / 失败分开数）；
 *  · R52-3 冲突：**与 Windows 资源管理器一致 —— 逐个询问是否覆盖，可选「全是」**；
 *  · R52-5 脱敏：**隐藏「分享根之上」的祖先**（保留被分享的那层文件夹名）。
 *
 * ## 断言分四层，缺一层就留一种假绿
 *
 *  ① **纯函数层**（真实 `server/share-store.js`）：`maskPrefix` / `itemPaths` 的
 *     公共祖先算法（含「公共祖先本身是被选中的目录」这个特例、无公共祖先、单条、中文）。
 *  ② **真发 HTTP 层**（真实 express + 真实路由 + 打桩云端）：
 *     · `POST /fs/move` —— 目标与源相同时如实回报 `skipped`；
 *     · `POST /fs/copy` —— 冲突先问后写、`decisions` 的覆盖 / 跳过、目录递归、
 *       失败回滚只删本次新建、配额按净增计；
 *     · `GET /s/:id` / `/s/:id/dl` —— 展示路径脱敏、默认全选、`mode=all` / `mode=exclude`。
 *  ③ **沙箱行为层**（真实 `share-list.js` / `explorer.js` / `ops.js` + 假 DOM）：
 *     首次打开真的默认全选、用户清空后刷新仍是空、提交真的走最短表示；
 *     多选右键菜单真的生成了「复制链接（N 项）」并真的调用了 `copyLinkSelected`；
 *     移动弹窗真的**不预选**、结果真的按三类分开汇总。
 *  ④ **静态不变量**：`openFolderPicker` 不得再把 `App.state.prefix` 当默认目标；
 *     链接结果弹窗的左右两列视觉等高（R52-06）。
 *
 * ⚠️ 判据必须落在**实际被执行的那一层**：R52-02 的修复点在 `openFolderPicker` 生成的
 *    HTML 与它那个「确定」按钮的**行为**上，只对着源码找 `= null` 字样是拦不住
 *    「函数里写了、走的却是另一条分支」这类假修复的 —— 故这里既断言生成的 HTML，
 *    也真的点一次「确定」看它到底调没调 `onPick`。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R52-*` 条目。
 * ⚠️ 端口一律 `listen(0)`（临时端口），与相邻轮次并发跑文件时不会 EADDRINUSE。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('s3-r52-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ================================================================== *
 * 假云端：两个互相独立的桩云
 *   · `fsClient`    —— 一个 Map，给 `/fs/move`、`/fs/copy` 用
 *   · `shareClient` —— 一份 key → 内容 的映射，给分享页 / 下载用
 * 二者按 `p()` 收到的 `client` 分派，因此可以共存在同一个 `p` 桩里。
 *
 * ⚠️ 桩**不是**替掉 `s3.p`，而是替掉**客户端**（`getClient` 的返回值），
 *    让真实的 `p()` 去驱动它们 —— 它与 `s3.js` 的契约是**回调式**
 *    （`p(s3, method, params)` → `s3[method](params, cb)`），且 `getObject`
 *    是「把内容写进 `params.Output`」而不是「返回一个 Body 流」。
 *    直接桩 `s3.p` 返回 `{ Body: Readable }` 会让 `streamBundle` 里
 *    `await p(s3,'getObject',{…, Output: stream})` 永远等不到数据 —— 表现是
 *    整个测试文件挂死（而不是报错），排查成本极高。
 * ================================================================== */

/** @type {Map<string, number>} key -> size（fs 侧只关心大小与存在性） */
const FsObjects = new Map();
const FsFailOn = new Set(); // 桩注入：复制到这些目标键时失败
const FsCopyKeys = []; // 记录 putObjectCopy 的目标键

const fsClient = { __kind: 'fs' };
const shareClient = { __kind: 'share' };
const cloudRef = { client: fsClient };

const s3mod = require(SERVER('s3.js'));

function fsList(params) {
  const pre = params.Prefix || '';
  const marker = params.Marker || '';
  const max = Math.min(1000, Math.max(1, Number(params.MaxKeys) || 1000));
  const keys = [...FsObjects.keys()].filter((k) => k.startsWith(pre) && (!marker || k > marker)).sort();
  const page = keys.slice(0, max);
  const isTruncated = keys.length > page.length;
  return {
    Contents: page.map((k) => ({ Key: k, Size: FsObjects.get(k), LastModified: new Date(0).toUTCString() })),
    CommonPrefixes: [],
    IsTruncated: isTruncated ? 'true' : 'false',
    NextMarker: isTruncated ? page[page.length - 1] : undefined,
  };
}

Object.assign(fsClient, {
  headObject(params, cb) {
    if (!FsObjects.has(params.Key)) { const e = new Error('NoSuchKey'); e.code = 'NoSuchKey'; e.statusCode = 404; return cb(e, null); }
    cb(null, { headers: { 'content-length': String(FsObjects.get(params.Key)), 'last-modified': new Date(0).toUTCString() } });
  },
  getBucket(params, cb) { cb(null, fsList(params)); },
  putObjectCopy(params, cb) {
    if (FsFailOn.has(params.Key)) return cb(new Error('桩注入的复制失败：' + params.Key), null);
    const src = String(params.CopySource);
    const from = src.slice(src.indexOf('/', 1) + 1); // CopySource 恒为 '/bucket/key'
    if (!FsObjects.has(from)) { const e = new Error('NoSuchKey: ' + from); e.code = 'NoSuchKey'; e.statusCode = 404; return cb(e, null); }
    FsObjects.set(params.Key, FsObjects.get(from));
    FsCopyKeys.push(params.Key);
    cb(null, {});
  },
  deleteObject(params, cb) { FsObjects.delete(params.Key); cb(null, {}); },  deleteMultipleObject(params, cb) {
    const del = [];
    for (const o of (params.Objects || [])) { FsObjects.delete(o.Key); del.push({ Key: o.Key }); }
    cb(null, { Deleted: del, Error: [] });
  },
});

/* ----------------------------- 分享侧桩云 ----------------------------- */

const SHARE = new Map(); // key -> Buffer

Object.assign(shareClient, {
  headObject(params, cb) {
    if (!SHARE.has(params.Key)) { const e = new Error('NoSuchKey'); e.code = 'NoSuchKey'; e.statusCode = 404; return cb(e, null); }
    cb(null, { headers: { 'content-length': String(SHARE.get(params.Key).length), 'last-modified': new Date(0).toUTCString() } });
  },
  getObject(params, cb) {
    if (!SHARE.has(params.Key)) { const e = new Error('NoSuchKey'); e.code = 'NoSuchKey'; e.statusCode = 404; return cb(e, null); }
    params.Output.end(Buffer.from(SHARE.get(params.Key))); // ⚠️ 必须写进 Output（见上方契约说明）
    return cb(null, {});
  },
  getBucket(params, cb) {
    const pre = params.Prefix || '';
    const keys = [...SHARE.keys()].filter((k) => k.startsWith(pre)).sort();
    cb(null, {
      Contents: keys.map((k) => ({ Key: k, Size: SHARE.get(k).length, LastModified: new Date(0).toUTCString() })),
      CommonPrefixes: [], IsTruncated: 'false',
    });
  },
});

s3mod.getClient = () => cloudRef.client;

/* ----------------------------- 假配置 / 假日志 ----------------------------- */

const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const statsStore = require(SERVER('stats-store.js'));
const LOGS = [];
statsStore.addLog = (e) => { LOGS.push(e); };

const bucketStats = require(SERVER('bucket-stats.js'));
const encStore = require(SERVER('enc-store.js'));
const secureStore = require(SERVER('secure-store.js'));
const shareStore = require(SERVER('share-store.js'));
const fsRoutes = require(SERVER('routes', 'fs.js'));
const shareRoutes = require(SERVER('share-routes.js'));

test.after(async () => {
  // share-store / stats 都是异步去抖写盘：不刷干就在目录删掉之后落地，只留 ENOENT 噪声
  await cleanupTempDir(tmp.dir, {
    flushers: [
      { name: 'secure-store', flush: () => secureStore.flush() },
      { name: 'stats-store', flush: () => { statsStore.flushStatsSync(); statsStore.flushLogsSync(); } },
    ],
  });
});

/* ================================================================== *
 * 通用：起服务 / 发请求
 * ================================================================== */

function serve(mount, router) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'u1', role: 'admin' }; next(); });
  app.use(mount, router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 取原始响应体（分享页与打包下载都不是 JSON） */
function httpGetBuf(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 给 fs 侧一份可用的（未超额的）配置。
 * ⚠️ 同时把云桩切回 `fsClient` —— 分享侧用例（R52-04/05）会用 `cloudRef.client = shareClient`
 *    顶掉它，忘了切回来的话后面所有 fs 用例都会以「s3[method] is not a function」告终，
 *    而错误信息完全指不到"桩被换掉了"这个事实上。
 */
function seedConfig(extra) {
  cloudRef.client = fsClient;
  configStore.save(Object.assign({
    credentials: [{
      id: 'credP', provider: 'tencent', secretId: 'AKIDp', secretKey: 'k',
      quotaBytes: 0, enabled: true, visibleToUsers: true, remark: 'p',
    }],
    activeCredentialId: 'credP',
    activeBucketId: 'p1',
    buckets: [{ id: 'p1', provider: 'tencent', bucket: 'r52', region: 'ap-guangzhou', credentialId: 'credP', enabled: true }],
  }, extra || {}));
  bucketStats.bucketSizeCache.clear();
}

const fsSend = (port, body) => request(port, 'POST', '/api/fs/copy', { body });

/* ================================================================== *
 * ① 纯函数层：R52-05 隐私脱敏
 * ================================================================== */

test('R52-05 · itemPaths：抹掉「分享根之上」的祖先，保留被分享的那层文件夹名', () => {
  const P = (items) => {
    const m = shareStore.itemPaths(items);
    return [...m.entries()].map(([k, v]) => k + '=>' + v).join(',');
  };
  const it = (key) => ({ key, size: 1, dir: key.endsWith('/') });

  // 分享 photos/2024/ ⇒ 只保留「2024/…」，photos 不再出现
  assertEqual(P([it('photos/2024/'), it('photos/2024/a.jpg'), it('photos/2024/sub/b.txt')]),
    'photos/2024/=>2024/,photos/2024/a.jpg=>2024/a.jpg,photos/2024/sub/b.txt=>2024/sub/b.txt',
    'R52-05：被分享的那层文件夹名保留，更上一层的 photos/ 必须消失');

  // 只分享一个子目录：同理
  assertEqual(P([it('photos/2024/')]), 'photos/2024/=>2024/', 'R52-05：单条目录分享同样脱敏');

  // 公共祖先本身就是**被选中的目录** ⇒ 只抹它之上，不能连它一起抹
  assertEqual(P([it('dir/'), it('dir/sub/')]), 'dir/=>dir/,dir/sub/=>dir/sub/',
    'R52-05：公共祖先是被显式选中的目录时，它的名字要保留（否则会得到空路径）');

  // 无公共祖先 / 同级多文件 ⇒ 一个字符都不动（脱敏不能把路径抹成空）
  assertEqual(P([it('photos/a.jpg'), it('music/c.mp3')]),
    'photos/a.jpg=>photos/a.jpg,music/c.mp3=>music/c.mp3', 'R52-05：无公共祖先时原样展示');
  assertEqual(P([it('a.txt'), it('b.txt')]), 'a.txt=>a.txt,b.txt=>b.txt',
    'R52-05：根目录下的多个文件没有可抹的祖先');
  assertEqual(P([it('zdir/')]), 'zdir/=>zdir/', 'R52-05：单条顶层目录不变');
  assertEqual(P([it('a.txt'), it('dir/')]), 'a.txt=>a.txt,dir/=>dir/',
    'R52-05：混合选择但无公共祖先时原样展示');

  // 同目录下的多个文件：抹掉那一层，只留文件名
  assertEqual(P([it('photos/a.jpg'), it('photos/b.txt')]), 'photos/a.jpg=>a.jpg,photos/b.txt=>b.txt',
    'R52-05：同一目录下的多个文件只显示文件名');

  // 「文件与它同名的同名目录」这种边界：抹前缀必须按「c + '/'」判，不能按普通 startsWith
  assertEqual(P([it('photos'), it('photos/a.txt')]), 'photos=>photos,photos/a.txt=>a.txt',
    'R52-05：名叫 photos 的**文件**不能被当作 photos/ 前缀一起抹掉');

  // 中文与多级
  assertEqual(P([it('A/B/C/'), it('A/B/C/文件.txt')]), 'A/B/C/=>C/,A/B/C/文件.txt=>C/文件.txt',
    'R52-05：多级 / 中文同样处理');
});

test('R52-05 · 展示路径是**唯一实现点**：列表行与归档条目名都取它', () => {
  const src = read('server/share-routes.js');
  // 列表行：行内显示用展示名，复选框 value 与 data-key 仍是**原始 key**
  const row = /function listRow\(item, shown\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert(row, 'share-routes.js 应有 listRow(item, shown)');
  assert(/esc\(shown \|\| item\.key\)/.test(row[1]), 'R52-05：行内名字必须走展示路径');
  assert(/name="k" value="\$\{esc\(item\.key\)\}"/.test(row[1]),
    'R52-05：复选框 value 必须仍是**原始 key**（否则 parseSelection / 归档都取不到对象）');
  assert(/data-key="\$\{esc\(item\.key\)\}"/.test(row[1]), 'R52-05：data-key 同样保持原始 key');
  // 归档条目名
  assert(/shownPaths\s*=\s*shareStore\.itemPaths\(v\.items\)/.test(src),
    'R52-05：打包时的条目名必须来自同一份 itemPaths()');
  assert(!/entries\.push\(\{ name: d, key: d, dir: true \}\)/.test(src),
    'R52-05：归档条目名不得再用原始 key（那会把完整路径写进压缩包）');
});

/* ================================================================== *
 * ② 真发 HTTP 层：分享页
 * ================================================================== */

/** 造一条多条目分享（绕过表单，直接进 share-store。`create` 是 async 的） */
function makeShare(items, extra) {
  return shareStore.create(Object.assign({
    items, bucket: 'tb', region: 'ap-guangzhou', maxDownloads: 0, paid: { required: false },
  }, extra || {}));
}

test('R52-05 · 分享页列表行与归档条目名都脱敏，原始 key 只出现在表单值里', async () => {
  SHARE.clear();
  SHARE.set('photos/2024/a.jpg', Buffer.from('A'));
  SHARE.set('photos/2024/sub/b.txt', Buffer.from('B'));
  const l = await makeShare([
    { key: 'photos/2024/', size: 0, dir: true },
    { key: 'photos/2024/a.jpg', size: 1, dir: false },
    { key: 'photos/2024/sub/b.txt', size: 1, dir: false },
    { key: 'photos/2024/sub/', size: 0, dir: true },
  ]);
  cloudRef.client = shareClient;
  const { port, close } = await serve('/', shareRoutes);
  try {
    const page = await httpGetBuf(port, '/s/' + l.id);
    const html = page.buf.toString('utf8');
    assertEqual(page.status, 200, '分享页应 200');
    // 行内名字：不能再出现 photos/
    const names = [...html.matchAll(/<span class="sl-name[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert(names.length >= 4, '应有 4 行，实际 ' + names.length);
    assert(!names.some((n) => n.includes('photos')),
      'R52-05：行内名字不得再出现被分享根之上的祖先，实际：' + JSON.stringify(names));
    assert(names.includes('2024/'), 'R52-05：被分享的那层文件夹名要保留，实际：' + JSON.stringify(names));
    assert(names.includes('2024/a.jpg'), 'R52-05：子文件的展示路径应为 2024/a.jpg，实际：' + JSON.stringify(names));
    // 勾选值仍是原始 key（否则下载拿不到对象）
    assert(html.includes('value="photos/2024/a.jpg"'), 'R52-05：复选框 value 必须仍是原始 key');
    // 打包：条目名同样脱敏
    const dl = await httpGetBuf(port, '/s/' + l.id + '/dl?mode=all');
    assertEqual(dl.status, 200, 'mode=all 应 200，实际 ' + dl.status + ' ' + dl.buf.toString('utf8').slice(0, 200));
    assertEqual(dl.headers['content-type'], 'application/gzip', '多条目必须打包');
    const tar = require(SERVER('tar.js'));
    const names2 = [];
    {
      const buf = zlib.gunzipSync(dl.buf);
      let off = 0;
      while (off + tar.BLOCK_SIZE <= buf.length) {
        const head = buf.subarray(off, off + tar.BLOCK_SIZE);
        if (head.every((x) => x === 0)) break;
        const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
        names2.push(name);
        off += tar.BLOCK_SIZE + Math.ceil(size / tar.BLOCK_SIZE) * tar.BLOCK_SIZE;
      }
    }
    assert(!names2.some((n) => n.includes('photos')),
      'R52-05：归档里的条目名不得包含被分享根之上的祖先，实际：' + JSON.stringify(names2));
    assert(names2.some((n) => n.endsWith('/2024/a.jpg') || n.endsWith('2024/a.jpg')),
      'R52-05：归档条目应为 2024/a.jpg 形态，实际：' + JSON.stringify(names2));
  } finally {
    await close();
  }
});

test('R52-04 · 分享页默认全选：服务端渲染 every row checked，并注入整份快照清单', async () => {
  SHARE.clear();
  SHARE.set('a.txt', Buffer.from('A'));
  SHARE.set('b.txt', Buffer.from('B'));
  const l = await makeShare([
    { key: 'a.txt', size: 1, dir: false },
    { key: 'b.txt', size: 1, dir: false },
  ]);
  cloudRef.client = shareClient;
  const { port, close } = await serve('/', shareRoutes);
  try {
    const html = (await httpGetBuf(port, '/s/' + l.id)).buf.toString('utf8');
    const boxes = [...html.matchAll(/<input type="checkbox" name="k" value="[^"]*"([^>]*)>/g)].map((m) => m[1]);
    assertEqual(boxes.length, 2, '应有 2 个复选框');
    assert(boxes.every((b) => /\bchecked\b/.test(b)),
      'R52-04：服务端必须把每一行渲染成 checked —— 脚本没加载时也要默认全选');
    // 整份快照的 key 清单（供脚本判「整份都选中了 ⇒ mode=all」）
    const snap = /<script type="application\/json" id="sl-keys">([\s\S]*?)<\/script>/.exec(html);
    assert(snap, 'R52-04：必须注入 id=sl-keys 的 JSON 快照清单');
    assertEqual(JSON.parse(snap[1]).join(','), 'a.txt,b.txt', 'R52-04：清单内容应为整份快照的 key');
    assert(!snap[1].includes('<'), 'R52-04：注入 JSON 必须转义 <（否则 </script> 能提前闭合脚本块）');
  } finally {
    await close();
  }
});

test('R52-04 · 下载端点的三种选择表示：不带 k / mode=all / mode=exclude', async () => {
  SHARE.clear();
  SHARE.set('a.txt', Buffer.from('AAA'));
  SHARE.set('b.txt', Buffer.from('BBB'));
  SHARE.set('c.txt', Buffer.from('CCC'));
  cloudRef.client = shareClient;
  const { port, close } = await serve('/', shareRoutes);
  const tar = require(SERVER('tar.js'));
  const namesOf = (buf) => {
    const out = [];
    const g = zlib.gunzipSync(buf);
    let off = 0;
    while (off + tar.BLOCK_SIZE <= g.length) {
      const head = g.subarray(off, off + tar.BLOCK_SIZE);
      if (head.every((x) => x === 0)) break;
      const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
      out.push(name);
      off += tar.BLOCK_SIZE + Math.ceil(size / tar.BLOCK_SIZE) * tar.BLOCK_SIZE;
    }
    // 只数**文件**条目：包的最外层还有一个「文件名 等 N 项/」的归档根目录条目
    return out.filter((n) => n.endsWith('.txt'));
  };
  const items = [
    { key: 'a.txt', size: 3, dir: false },
    { key: 'b.txt', size: 3, dir: false },
    { key: 'c.txt', size: 3, dir: false },
  ];
  try {
    // ① 完全不带选择参数 ⇒ 整份快照（这是「默认全选」在**没有 JS** 时的落点）
    const l1 = await makeShare(items, { maxDownloads: 9 });
    const r1 = await httpGetBuf(port, '/s/' + l1.id + '/dl');
    assertEqual(r1.status, 200, '不带 k 应 200');
    const n1 = namesOf(r1.buf);
    assertEqual(n1.length, 3, 'R52-04：不带 k 时必须=全部，实际 ' + JSON.stringify(n1));

    // ② mode=all
    const l2 = await makeShare(items, { maxDownloads: 9 });
    const r2 = await httpGetBuf(port, '/s/' + l2.id + '/dl?mode=all');
    assertEqual(r2.status, 200, 'mode=all 应 200');
    assertEqual(namesOf(r2.buf).length, 3, 'R52-04：mode=all ⇒ 全部');

    // ③ mode=exclude + 被取消掉的那些
    const l3 = await makeShare(items, { maxDownloads: 9 });
    const r3 = await httpGetBuf(port, '/s/' + l3.id + '/dl?mode=exclude&x=b.txt');
    assertEqual(r3.status, 200, 'mode=exclude 应 200');
    const n3 = namesOf(r3.buf);
    assertEqual(n3.length, 2, 'R52-04：排除 1 项后应剩 2 项，实际 ' + JSON.stringify(n3));
    assert(!n3.some((x) => x.endsWith('/b.txt')), 'R52-04：被排除的 b.txt 不得出现在包里');

    // ④ mode=exclude 排除到空 ⇒ 与「一个都没选」同款处理（404 + 说明原因）
    const l4 = await makeShare(items, { maxDownloads: 9 });
    const r4 = await httpGetBuf(port, '/s/' + l4.id + '/dl?mode=exclude&x=a.txt&x=b.txt&x=c.txt');
    assertEqual(r4.status, 404, 'R52-04：全排除 ⇒ 404 而不是空的 tar.gz，实际 ' + r4.status);

    // ⑤ 反向对照：mode=exclude 指了一个不存在的 key ⇒ 必须 400（不得静默当成空补集）
    const l5 = await makeShare(items, { maxDownloads: 9 });
    const r5 = await httpGetBuf(port, '/s/' + l5.id + '/dl?mode=exclude&x=nope.txt');
    assertEqual(r5.status, 400, 'R52-04：排除一个不在快照里的 key 必须报错，实际 ' + r5.status
      + ' ' + r5.buf.toString('utf8').slice(0, 160));
    assertEqual(Number(shareStore.get(l5.id).downloads), 0, 'R52-04：被拒的请求不占用下载次数');

    // ⑥ 反向对照：R51 的普通 k 列表仍然照常工作（不得被新协议挤掉）
    const l6 = await makeShare(items, { maxDownloads: 9 });
    const r6 = await httpGetBuf(port, '/s/' + l6.id + '/dl?k=a.txt&k=c.txt');
    assertEqual(r6.status, 200, 'R51 的 k 列表形态必须仍然可用');
    const n6 = namesOf(r6.buf);
    assertEqual(n6.length, 2, 'R51：勾 2 项就只下 2 项');
    assert(!n6.some((x) => x.endsWith('/b.txt')), 'R51：没勾的不得混进来');
  } finally {
    await close();
  }
});

/* ================================================================== *
 * ③ 沙箱行为层
 * ================================================================== */

function mkSandbox(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'r52-' + tag + '-')); }
const { pathToFileURL } = require('url');

/* ------------------------- share-list.js ------------------------- */

/**
 * 勾选脚本的假 DOM（与 audit51 同款，外加 R52 新增的 `#sl-keys` JSON 块）。
 * `snapshotKeys` 传数组即等价于服务端注入了整份快照清单。
 */
function installShareListDom({ linkId = 'LNK1', boxes = [], pathname = '/s/LNK1', storage = null, snapshotKeys = null } = {}) {
  const store = storage || new Map();
  const mkInput = (value, extra = {}) => ({
    value, checked: false, type: 'checkbox', name: 'k', parentNode: null, attrs: {},
    _ev: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
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
  globalThis.document = {
    currentScript: { getAttribute: (k) => (k === 'data-link-id' ? linkId : null) },
    getElementById(id) {
      if (id === 'sl-form') return form;
      if (id === 'sl-count') return countEl;
      if (id === 'sl-all') return btnAll;
      if (id === 'sl-none') return btnNone;
      if (id === 'sl-keys') return snapshotKeys ? { textContent: JSON.stringify(snapshotKeys) } : null;
      return null;
    },
    createElement() { const n = mkInput(''); n.type = 'hidden'; return n; },
  };
  globalThis.location = { pathname };
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  return { form, boxes: boxEls, countEl, btnAll, btnNone, store, extras };
}

function runShareList(opt) {
  const dom = installShareListDom(opt);
  new Function(fs.readFileSync(JS('share-list.js'), 'utf8'))();
  return dom;
}

test('R52-04 · share-list：首次打开默认全选；用户清空后刷新仍是空；提交走最短表示', () => {
  const ALL = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
  const PAGE1 = ALL.slice(0, 3);

  // ① 从没打开过（存储里没有这个键）⇒ 本页框全勾上、全部 key 都进选择集合
  const p1 = runShareList({ linkId: 'LNK1', boxes: PAGE1, snapshotKeys: ALL });
  assertEqual(p1.boxes.every((b) => b.checked), true,
    'R52-04：首次打开必须默认全选（本页的框都要是勾上的）');
  assertEqual(JSON.parse(p1.store.get('kepler.share.sel.LNK1')).length, 5,
    'R52-04：默认全选是**跨页**语义 —— 选择集合要覆盖整份快照（5 项），不是本页的 3 项');
  assert(/已选 5 项/.test(p1.countEl.textContent), 'R52-04：计数要显示整份快照的选中数');

  // ② 一个都不动直接提交 ⇒ mode=all（不往请求里塞 2000 个 key）
  p1.form._ev.submit();
  const modeEl = p1.extras.find((n) => n.name === 'mode');
  assert(modeEl, 'R52-04：整份快照都被选中时应提交 mode=all');
  assertEqual(modeEl.value, 'all', 'R52-04：mode 的取值应为 all');
  assertEqual(p1.extras.filter((n) => n.name === 'k').length, 0,
    'R52-04：mode=all 时不必再补任何 k（补了只会把请求行撑长）');

  // ③ 在第 2 页取消勾 1 项（其它一概不动）⇒ mode=exclude + 那个 key。
  //    ⚠️ 这一条正是「本页未勾选的项不会随表单提交」那个洞的判据：若不把它补成隐藏
  //       字段，服务端在补集模式下收不到它，用户取消掉的文件**照样会被下载**。
  const p3 = runShareList({ linkId: 'LNK1', boxes: ['d.txt', 'e.txt'], snapshotKeys: ALL, storage: p1.store });
  assertEqual(p3.boxes[0].checked, true, '第 2 页的 d 应仍在选中集合里');
  p3.boxes[1].checked = false;
  p3.boxes[1]._ev.change({ target: p3.boxes[1] });
  p3.form._ev.submit();
  const m3 = p3.extras.find((n) => n.name === 'mode');
  assertEqual(m3 && m3.value, 'exclude', 'R52-04：只取消少数几项时用 mode=exclude（补的是**没选**的那些）');
  assertEqual(p3.extras.filter((n) => n.name === 'x').map((n) => n.value).join(','), 'e.txt',
    'R52-04：exclude 形态补出去的必须包含**本页取消勾选**的那个 key（否则取消无效）');
  assertEqual(p3.extras.filter((n) => n.name === 'k').length, 0,
    'R52-04：exclude 形态**不得**再补 k —— 本页已勾的复选框会自己提交 k，'
    + '一旦混进排除集，用户正要下载的文件反而会被排除掉');

  // ③b 再叠一次：第 1 页取消 a、第 2 页取消 e ⇒ 两个都要补出去
  const p3b = runShareList({ linkId: 'LNK1', boxes: PAGE1, snapshotKeys: ALL, storage: p3.store });
  p3b.boxes[0].checked = false;
  p3b.boxes[0]._ev.change({ target: p3b.boxes[0] });
  p3b.form._ev.submit();
  const m3b = p3b.extras.find((n) => n.name === 'mode');
  assertEqual(m3b && m3b.value, 'exclude', 'R52-04：跨页取消两项仍应用 exclude');
  assertEqual(p3b.extras.filter((n) => n.name === 'x').map((n) => n.value).sort().join(','), 'a.txt,e.txt',
    'R52-04：跨页取消的每一项都要补出去');

  // ④ 「清空选择」之后刷新 ⇒ 不能又变成全选（这正是「首次打开」与「用户清空」的分界）
  const p4 = runShareList({ linkId: 'LNK1', boxes: PAGE1, snapshotKeys: ALL, storage: p3.store });
  p4.btnNone._ev.click();
  assertEqual(JSON.parse(p4.store.get('kepler.share.sel.LNK1')).length, 0, '清空后存储里应是空数组');
  const p5 = runShareList({ linkId: 'LNK1', boxes: PAGE1, snapshotKeys: ALL, storage: p4.store });
  assertEqual(p5.boxes.some((b) => b.checked), false,
    'R52-04：用户清空过之后再刷新，不得又默认全选（缺键才默认全选，值为 [] 表示用户说了算）');
  p5.form._ev.submit();
  const p5extras = p5.extras;
  assertEqual(p5extras.filter((n) => n.name === 'k').length, 0, 'R52-04：k 形态一个 k 都发不出去');
  assertEqual(
    (p5extras.find((n) => n.name === 'mode') || {}).value, 'exclude',
    'R52-04：⚠️ 清空后提交**不得**落到「既没有 k 也没有 mode」—— 服务端把那读成'
    + '「整条分享」，用户清空后点下载反而拿到全部（与他刚做的操作相反），实际 ' + JSON.stringify(p5extras));
  assertEqual(p5extras.filter((n) => n.name === 'x').map((n) => n.value).sort().join(','), ALL.slice().sort().join(','),
    'R52-04：空选择的唯一无歧义写法是「排除掉整份快照」');

  // ⑤ 页面没注入快照清单（脚本降级）⇒ 只能用本页这 3 个，且**不得**用 all / exclude
  const p6 = runShareList({ linkId: 'LNK1', boxes: PAGE1 });
  assertEqual(p6.boxes.every((b) => b.checked), true, '没有清单时至少本页默认全选');
  p6.form._ev.submit();
  assertEqual(p6.extras.filter((n) => n.name === 'mode').length, 0,
    'R52-04：手里没有完整快照时不得提交 mode —— 那会把用户从没见过的条目也算进来');
});

/* ------------------------- explorer.js（右键菜单） ------------------------- */

/**
 * `showContextMenu` 是模块私有函数，用 `explorer.__test__` 暴露（与 `fs-gateway.js`
 * 的 `__test__` 同一手法）。⚠️ 这里追求的是**真正跑一遍菜单构造函数**，
 * 而不是对着源码找「复制链接（」字样 —— 后者拦不住「加了但加错了分支」。
 */
async function loadExplorer(opts = {}) {
  const dir = mkSandbox('exp');
  fs.copyFileSync(JS('explorer.js'), path.join(dir, 'explorer.js'));
  fs.writeFileSync(path.join(dir, 'api.js'), 'export const API = {};\n');
  fs.writeFileSync(path.join(dir, 'util.js'), `
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fmtSize(n) { return n + ' B'; }
export function fmtTime() { return 'T'; }
export function isStaffRole(role) { return role === 'admin' || role === 'root'; }
export function isRootRole(role) { return role === 'root'; }
export function roleLabel(role) { return role === 'root' ? '根用户' : (role === 'admin' ? '管理员' : '普通用户'); }
// R98：展示名（昵称优先）—— main.js / profile.js 会具名导入，桩缺一个导出就会在 ESM 链接期整片变红
export function displayName(u) { return (u && (String(u.nickname || '').trim() || u.username)) || ''; }
export function toast() {}
export function confirmDialog() { return Promise.resolve(true); }
export function openModal() { return { close() {}, bodyEl: {}, overlay: {} }; }
export function iconHtml() { return ''; }
export function propertyBodyHtml() { return ''; }
export const TYPE_LABEL = {}; export const FILE_TYPES = [];
`);
  fs.writeFileSync(path.join(dir, 'main.js'), `
export const App = { state: { prefix: '', selection: new Set(${JSON.stringify(opts.selection || [])}), user: { role: 'admin' }, config: {} } };
`);
  fs.writeFileSync(path.join(dir, 'upload.js'), 'export const uploadMgr = {};\n');
  fs.writeFileSync(path.join(dir, 'ops.js'), `
export const ops = new Proxy({}, { get: (t, k) => (...a) => { (globalThis.__r52Ops = globalThis.__r52Ops || {})[k] = a; return k === 'clipboardCount' ? 0 : undefined; } });
`);
  fs.writeFileSync(path.join(dir, 'enc.js'), 'export function openDownload() {}\n');
  // 假 DOM：`getElementById` 一律凭空造一个元素（右键菜单就是按 id 取的）
  const byId = new Map();
  const mk = (label) => {
    const el = {
      _label: label, _html: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    /**
     * ⚠️ 右键菜单的**点击接线**就落在 `menu.querySelectorAll('.mi')` 上
     * （`showContextMenu` 靠它给每一项挂 `onclick`）。这里若不把 `.mi` 解析出来，
     * 「点了『复制链接』到底调没调 ops」这条判据就永远测不到 —— 只能退化成
     * 对着源码找字样，而那拦不住「加了但接错线」。
     * 于是按菜单 HTML 里的 `data-i` 造出对应数量的桩，并把片段文本带过去。
     */
    querySelectorAll(sel) {
      if (sel === '.mi') {
        // ⚠️ 必须**按当前 HTML 缓存**同一批桩对象：`showContextMenu` 先
        //    `menu.querySelectorAll('.mi').forEach(el => el.onclick = …)` 挂接线，
        //    测试随后要拿到**同一批**对象才点得到。每次都新建一批的话，
        //    `onclick` 挂在上一批上，`items[idx].onclick` 就是 undefined。
        if (this._miKey !== this._html) {
          const frags = String(this._html).split(/(?=<div class="mi )/).filter((x) => x.startsWith('<div class="mi'));
          this._miKey = this._html;
          this._miCache = frags.map((frag) => {
            const n = mk('.mi');
            const m = /data-i="(\d+)"/.exec(frag);
            n.dataset = { i: m ? m[1] : '0' };
            n.innerHTML = frag;
            n.hidden = false;
            n.onclick = null;
            return n;
          });
        }
        return this._miCache;
      }
      return [];
    },
    querySelector() { return null; },
    addEventListener() {}, appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
  };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v); },
    });
    return el;
  };
  globalThis.document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mk('#' + id)); return byId.get(id); },
    createElement: (t) => mk('<' + t + '>'),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: mk('body'), currentScript: null,
  };
  globalThis.window = globalThis;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  globalThis.setTimeout = setTimeout;
  const m = await import(pathToFileURL(path.join(dir, 'explorer.js')).href);
  // ⚠️ 返回 `byId` 而不是当场取 `#ctx-menu`：菜单元素是 `showContextMenu` 第一次被调用
  //    时才经 `getElementById` 造出来的，提前取会拿到另一个空对象。
  return { explorer: m.explorer, byId };
}

test('R52-01 · 多选右键菜单补上「复制链接（N 项）」并沿用整份选择（混合文件 + 文件夹）', async () => {
  const sel = ['a.txt', 'dir/', 'b.txt'];
  const { explorer, byId } = await loadExplorer({ selection: sel });
  globalThis.__r52Ops = {};
  explorer.__test__.showContextMenu(10, 10, 'a.txt');
  const menu = byId.get('ctx-menu'); // ⚠️ key 是原始 id，不是选择器写法

  const html = menu.innerHTML;
  assert(/复制链接（3 项）/.test(html),
    'R52-01：多选分支必须有「复制链接（N 项）」入口，实际菜单：' + html);
  assert(/复制（3 项）/.test(html), 'R52-03：多选分支还要有「复制（N 项）」');
  assert(/移动到…（3 项）/.test(html), 'R52-01：原有的「移动到…」不得丢失');
  assert(/下载（3 项）/.test(html), 'R52-01：原有的「下载」不得丢失');
  assert(!/打开/.test(html), '多选时不该出现只对单项有意义的「打开」');

  // 真的点一下那一项 → 必须把**整份选择**（含文件夹）交给 copyLinkSelected
  const items = menu.querySelectorAll('.mi');
  const idx = items.findIndex((el) => /复制链接（3 项）/.test(el.innerHTML));
  assert(idx >= 0, '「复制链接（3 项）」必须是菜单里一个可点击的项');
  items[idx].onclick();
  assert(globalThis.__r52Ops.copyLinkSelected, 'R52-01：点击必须调用 ops.copyLinkSelected');
  assertEqual(menu.hidden, true, '点击后菜单应收起');

  // 单项分支保持原样（回归）：仍是「复制链接」（不带数量后缀）与「复制」
  const src = read('public/js/explorer.js');
  assert(/\{ text: '复制链接', onClick: \(\) => ops\.copyLinkKeys\(\[key\]\) \}/.test(src),
    'R52-01：单项分支的「复制链接」必须原样保留');
  assert(/\{ text: '复制', k: 'Ctrl\+C', onClick: \(\) => ops\.copyKeys\(\[key\]\) \}/.test(src),
    'R52-03：单项分支要有「复制」');
  assert(/copyLinkSelected\(\) \{ this\.copyLinkKeys\(\[\.\.\.App\.state\.selection\]\); \}/.test(read('public/js/ops.js')),
    'R52-01：copyLinkSelected 必须把整份选择（含文件夹）交给 copyLinkKeys（R51 的多条目契约）');
});

/* ------------------------- ops.js（移动 / 复制） ------------------------- */

async function loadOps() {
  const dir = mkSandbox('ops');
  fs.copyFileSync(JS('ops.js'), path.join(dir, 'ops.js'));
  // ⚠️ 桩里的 `rec` 必须**每次调用时**从 globalThis 取：模块加载那一刻捕获的引用，
  //    在用例随后 `globalThis.__r52Api = {...}` 重置之后就成了另一个对象，
  //    于是"用例设的返回值"永远读不到 —— 表现为功能看起来正常、断言却全错。
  fs.writeFileSync(path.join(dir, 'api.js'), `
function rec() { const r = (globalThis.__r52Api = globalThis.__r52Api || { calls: [] }); if (!r.calls) r.calls = []; return r; }
export const API = {
  async move(paths, targetPrefix) { const r = rec(); r.calls.push(['move', paths, targetPrefix]); return (r.moveResult || { ok: true, results: [] }); },
  async copy(paths, targetPrefix, decisions) { const r = rec(); r.calls.push(['copy', paths, targetPrefix, decisions]); return (r.copyResult || { ok: true, results: [] }); },
  async tree() { return { folders: [] }; },
  async linkQrcode() { return { svg: '<svg/>' }; },
  async createLink() { return { ok: true, id: 'L', fileName: 'x', createdAt: 'T', expiresAt: null, maxDownloads: 0, hasPassword: false, paid: { required: false } }; },
};
`);
  fs.writeFileSync(path.join(dir, 'util.js'), `
export const __toast = (globalThis.__r52Toast = []);
export function isStaffRole(role) { return role === 'admin' || role === 'root'; }
export function isRootRole(role) { return role === 'root'; }
export function roleLabel(role) { return role === 'root' ? '根用户' : (role === 'admin' ? '管理员' : '普通用户'); }
// R98：展示名（昵称优先）—— main.js / profile.js 会具名导入，桩缺一个导出就会在 ESM 链接期整片变红
export function displayName(u) { return (u && (String(u.nickname || '').trim() || u.username)) || ''; }
export function toast(m, o) { globalThis.__r52Toast.push([m, o]); }
export function confirmDialog() { return Promise.resolve(true); }
export function promptDialog() { return Promise.resolve('x'); }
export const __modal = (globalThis.__r52Modal = []);
/**
 * ⚠️ 这个桩必须与真实 openModal（public/js/util.js）**同形**，两处都要像：
 *
 *  ① close() 会调用 onClose —— 真实实现里 close() 的末尾就是 if (onClose) onClose(result)。
 *     少了这一句，「先 close 再 finish」那类顺序缺陷**测不出来**（conflictPrompt 的
 *     onClose 兜的是 ESC / ✕ / 点遮罩，一律按「取消整个复制」处理；若 close() 先跑，
 *     先被 resolve 的会是「取消」，用户点的按钮白点）—— R52-03e 的反向对照就是这么第一次
 *     报 fail=0 的：变异明明生效，桩却把危害整个吞掉了。
 *  ② 按钮的 onClick 收到的是**它自己的** close（真实实现：f.onClick(overlay, close)）。
 *     桩只把弹窗对象推进数组、让调用方自己传一个 close 的话，「关没关弹窗」这类断言
 *     只能读到调用方自己的回调，等于恒真。
 *
 * ⚠️ 本段整体处于一个模板字符串里，注释里**不能出现反引号**（会提前结束模板串）。
 */
export function openModal(o) {
  const overlay = { remove() {} };
  const self = { close() { globalThis.__r52ModalClosed = true; if (typeof o.onClose === 'function') o.onClose(null); } };
  for (const f of (o.foot || [])) {
    if (typeof f.onClick === 'function') { const raw = f.onClick; f.onClick = () => raw(overlay, self.close); }
  }
  globalThis.__r52Modal.push(o);
  return self;
}
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fmtSize(n) { return n + ' B'; }
export function fmtTime(t) { return 'T(' + t + ')'; }
`);
  fs.writeFileSync(path.join(dir, 'main.js'), `
export const App = { state: { prefix: 'cur/', bucket: 'demo', config: { configured: true, bucket: 'demo' }, selection: new Set(), user: { role: 'admin' } } };
`);
  fs.writeFileSync(path.join(dir, 'explorer.js'), 'export const explorer = { refresh() {}, updateOpsButtons() {} };\n');
  fs.writeFileSync(path.join(dir, 'enc.js'), 'export function openDownload() {}\n');
  fs.writeFileSync(path.join(dir, 'speedlimit.js'), `
export function parseMbpsInput(v) { return { ok: true, bytes: Number(v) || 0 }; }
export function ceilingText() { return ''; }
export async function fetchCeiling() { return null; }
export function toMBps(n) { return String(n / 1048576); }
`);
  installOpsDom();
  const m = await import(pathToFileURL(path.join(dir, 'ops.js')).href);
  // 一并把 `main` 放出来：有的用例需要改 `App.state.prefix` 再跑一遍同一条路径
  const main = await import(pathToFileURL(path.join(dir, 'main.js')).href);
  return { ops: m.ops, App: main.App };
}

/** ops.js 会碰到的那些 DOM 能力（不解析 innerHTML 的极简桩） */
function installOpsDom() {
  const byId = new Map();
  const mk = (label) => {
    const el = {
      _label: label, _html: '', _childHtml: '', textContent: '', value: '', checked: false,
      disabled: false, hidden: false, style: {}, _ev: {}, _kids: new Map(),
      parentNode: null,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(t, fn) { this._ev[t] = fn; },
      querySelector(sel) {
        if (!this._kids.has(sel)) this._kids.set(sel, mk(label + '>' + sel));
        return this._kids.get(sel);
      },
      querySelectorAll() { return []; },
      /**
       * ⚠️ `firstElementChild` 必须让**它的 innerHTML 等于父容器的 innerHTML**。
       *
       * `openFolderPicker` 的写法是「先 `container.innerHTML = rowHtml(...)`，再取
       * `container.firstElementChild` 当那一行」—— 真 DOM 会把它解析成子元素；
       * 这里没有解析器，于是把父容器的 HTML 直接继承过去，语义上等价
       * （容器里此刻确实只有这一行）。不这么做的话 `row.querySelector('.tw')`
       * 会在 undefined 上取属性，整个弹窗构造函数直接抛错。
       */
      get firstElementChild() {
        if (!this._fec) this._fec = mk(label + '>first');
        // 每次访问都同步一次父容器的 HTML —— 语义上「容器里此刻只有这一行」，
        // 而 ops.js 的写法是「先写 innerHTML、再取 firstElementChild」。
        this._fec._html = this._html;
        return this._fec;
      },
      // 子元素挂进来时把它那段 HTML 累到 `_childHtml` 上 —— 假 DOM 里这就是「页面结构」
      appendChild(n) { this._childHtml += String(n.innerHTML || ''); n.parentNode = this; return n; },
      removeChild(n) { return n; },
      remove() {}, focus() {}, select() {}, click() {},
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v); },
    });
    return el;
  };
  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mk('#' + id)); return byId.get(id); },
    createElement: (t) => mk('<' + t + '>'),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: mk('body'), currentScript: null,
  };
  globalThis.navigator = { clipboard: { writeText: async () => true } };
  globalThis.location = { origin: 'https://pan.example.com', pathname: '/' };
  return { byId, mk };
}

test('R52-02 · 移动目标选择器不再预选当前目录；未选时「确定」不生效', async () => {
  const { ops, App } = await loadOps();
  ops.moveKeysTo(['a/1.txt', 'a/2.txt']);
  assertEqual(globalThis.__r52Modal.length, 1, '应弹出目标选择器');
  const wrap = globalThis.__r52Modal[0].body;
  const treeEl = wrap.querySelector('#fp-tree');
  // 提示语与树的**实际内容**分开看：树里的行是 appendChild 进去的
  const hint = wrap.innerHTML;
  const rows = treeEl._childHtml;

  assert(!/class="tree-row active"/.test(rows),
    'R52-02：打开弹窗时**不得**有任何一行处于 active（旧实现把当前目录预选上了，' +
    '于是「一路默认确认」等于把文件移到它们自己所在目录 —— 报告成功、原地不动）。实际：' + rows);
  assert(!hint.includes('已选定'), 'R52-02：没有 fixedTarget 时不该显示「已选定」');
  assert(/点选/.test(hint), 'R52-02：提示语要明确要求用户**点选**一个目标，实际：' + hint);
  assert(/data-prefix=""/.test(rows), 'R52-02：树里应先渲染根目录行，实际：' + rows);
  // 当前目录不是根（'cur/'）时，根行**不是**「当前位置」；把当前目录改成根再来一次，
  // 角标才该出现 —— 用同一条真实路径跑两遍，比对着字符串猜更靠谱
  App.state.prefix = '';
  globalThis.__r52Modal.length = 0;
  ops.moveKeysTo(['a/1.txt']);
  const rows2 = globalThis.__r52Modal[0].body.querySelector('#fp-tree')._childHtml;
  assert(/fp-cur/.test(rows2), 'R52-02：当前所在目录要挂「当前位置」角标（只是提示，不是已选目标），实际：' + rows2);
  assert(!/class="tree-row active"/.test(rows2), 'R52-02：挂了角标也**不能**变成 active（那才是"已预选"）');
  App.state.prefix = 'cur/';

  // 点「确定」：不关弹窗、不调后端（注意取**最后一个**弹窗 —— 上面已经开过两个）
  globalThis.__r52Toast.length = 0;
  globalThis.__r52Api = { calls: [] };
  const confirmBtn = globalThis.__r52Modal[globalThis.__r52Modal.length - 1].foot[1];
  globalThis.__r52ModalClosed = false;
  await confirmBtn.onClick();
  // ⚠️ 这里判的是**桩自己记下的**「弹窗被关了吗」，而不是测试自己传进去的回调 ——
  //    桩与真实 `openModal` 同形（按钮的 onClick 收到的是**它**的 `close`），测试再传一个
  //    自己的回调根本不会被调用，断言就成了恒真的摆设（「关没关」永远读到 false）。
  assertEqual(globalThis.__r52ModalClosed, false, 'R52-02：没选目标时「确定」不得关闭弹窗（否则用户以为生效了）');
  assertEqual(globalThis.__r52Api.calls.length, 0, 'R52-02：没选目标时不得发出任何移动请求');
  assert(/点选一个目标文件夹/.test(globalThis.__r52Toast.map((x) => x[0]).join('|')),
    'R52-02：要当场说明原因，实际提示：' + JSON.stringify(globalThis.__r52Toast));
});

test('R52-02 · 移动结果如实汇总：成功 / 跳过 / 失败分开数，跳过不算成功', async () => {
  const { ops } = await loadOps();

  // ① 全部被服务端跳过（本就在目标里）⇒ 绝不能报「移动完成」
  globalThis.__r52Api = { calls: [], moveResult: { ok: true, results: [{ path: 'a', ok: true, skipped: true }, { path: 'b', ok: true, skipped: true }] } };
  globalThis.__r52Toast.length = 0;
  globalThis.__r52Modal.length = 0;
  ops.moveKeysTo(['a/1.txt', 'a/2.txt'], 'dst/');
  await globalThis.__r52Modal[0].foot[1].onClick(null, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const t1 = globalThis.__r52Toast.map((x) => x[0]).join('|');
  assert(/未移动任何项目/.test(t1), 'R52-02：全被跳过时必须如实说「未移动任何项目」，实际：' + t1);
  assert(!/移动完成/.test(t1), 'R52-02：跳过不得被算成「移动完成」—— 这正是原始 bug 的症状');

  // ② 混合：1 成功 + 1 跳过
  globalThis.__r52Api = { calls: [], moveResult: { ok: true, results: [{ path: 'a', ok: true }, { path: 'b', ok: true, skipped: true }] } };
  globalThis.__r52Toast.length = 0;
  globalThis.__r52Modal.length = 0;
  ops.moveKeysTo(['a/1.txt', 'a/2.txt'], 'dst/');
  await globalThis.__r52Modal[0].foot[1].onClick(null, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const t2 = globalThis.__r52Toast.map((x) => x[0]).join('|');
  assert(/已移动 1 项/.test(t2) && /1 项本就在该文件夹中已跳过/.test(t2),
    'R52-02：混合结果要分开报，实际：' + t2);

  // ③ 有失败：三类都要出现，且带首个错误
  globalThis.__r52Api = {
    calls: [],
    moveResult: { ok: false, results: [{ path: 'a', ok: true }, { path: 'b', ok: true, skipped: true }, { path: 'c', ok: false, error: '撞名了' }] },
  };
  globalThis.__r52Toast.length = 0;
  globalThis.__r52Modal.length = 0;
  ops.moveKeysTo(['a/1.txt', 'b/1.txt', 'c/1.txt'], 'dst/');
  await globalThis.__r52Modal[0].foot[1].onClick(null, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const t3 = globalThis.__r52Toast.map((x) => x[0]).join('|');
  assert(/成功 1 项、跳过 1 项、失败 1 项/.test(t3), 'R52-02：失败时要给出三类明细，实际：' + t3);
  assert(/撞名了/.test(t3), 'R52-02：要带上首个错误原因');

  // ④ 拖拽落到文件夹行（fixedTarget 路径）仍应直接可用，且目标与源全同时当场拦住
  globalThis.__r52Api = { calls: [], moveResult: { ok: true, results: [{ path: 'dst/1.txt', ok: true, skipped: true }] } };
  globalThis.__r52Toast.length = 0;
  globalThis.__r52Modal.length = 0;
  ops.moveKeysTo(['dst/1.txt'], 'dst/');
  await globalThis.__r52Modal[0].foot[1].onClick(null, () => {});
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(globalThis.__r52Api.calls.length, 0,
    'R52-02：目标与源完全相同（本就在目标目录里）应**当场拦住**，一次请求都不该发');
  assert(/已经在该文件夹中，无需移动/.test(globalThis.__r52Toast.map((x) => x[0]).join('|')),
    'R52-02：当场拦住时要说清原因，实际：' + JSON.stringify(globalThis.__r52Toast));
});

test('R52-03 · ops 复制 / 粘贴：冲突时逐项询问，带 decisions 重发', async () => {
  const { ops } = await loadOps();
  globalThis.sessionStorage = (() => {
    const s = new Map();
    return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) };
  })();

  // 剪贴板为空 → 提示而不是静默失败
  globalThis.__r52Toast.length = 0;
  await ops.paste();
  assert(/剪贴板为空/.test(globalThis.__r52Toast.map((x) => x[0]).join('|')), 'R52-03：空剪贴板要明确提示');

  // 复制两项（含文件夹）
  globalThis.__r52Toast.length = 0;
  ops.copyKeys(['a.txt', 'dir/']);
  assertEqual(ops.clipboardCount(), 2, 'R52-03：剪贴板要记住两项');

  // 第二次请求真的带上了 decisions
  globalThis.__r52Api = {
    calls: [],
    copyResult: { ok: true, results: [{ path: 'a.txt', ok: true }, { path: 'dir/', ok: true, skipped: true }] },
  };
  globalThis.__r52Modal.length = 0;
  globalThis.__r52Toast.length = 0;
  const p = ops.pasteTo('dst/');
  // 第一轮返回 needsDecision → 弹一个冲突询问
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(globalThis.__r52Api.calls.length, 1, 'R52-03：第一轮必须先问（不带 decisions）');
  assertEqual(globalThis.__r52Api.calls[0][3], undefined, 'R52-03：第一轮不得带 decisions');
  await p;
});

test('R52-03 · ops：needsDecision 之后一问一答，带 decisions 重发（覆盖 + 跳过）', async () => {
  const { ops } = await loadOps();
  globalThis.sessionStorage = (() => {
    const s = new Map();
    return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) };
  })();
  ops.copyKeys(['a.txt', 'dir/']);

  const asked = [];
  globalThis.__r52Modal.length = 0;
  const rounds = [
    { ok: false, needsDecision: true, conflicts: [{ path: 'a.txt', target: 'dst/a.txt', kind: 'file', count: 1 }, { path: 'dir/', target: 'dst/dir/', kind: 'folder', count: null }] },
    // 第二轮的形状必须与**服务端真实回的一致**：用户选了「跳过」的那一项回来是
    // `{ ok: true, skipped: true, reason: '用户选择跳过同名项' }`（见 routes/fs.js），
    // 不是 `{ ok: true }` 一个光秃秃的成功 —— 后者会让「跳过不算成功」这条判据失效。
    { ok: true, results: [{ path: 'a.txt', ok: true }, { path: 'dir/', ok: true, skipped: true, reason: '用户选择跳过同名项' }] },
  ];
  globalThis.__r52Api = {
    calls: [],
    copyResult: null,
  };
  // 用第一轮返回 needsDecision、第二轮返回成功来驱动「问 → 重发」
  const api = globalThis.__r52Api;
  let n = 0;
  // 通过 getter 驱动：api.copyResult 在每次调用前被读取，这里改成逐次返回值
  Object.defineProperty(api, 'copyResult', { get() { return rounds[Math.min(n++, rounds.length - 1)]; }, configurable: true });

  globalThis.__r52Toast.length = 0;
  const p = ops.pasteTo('dst/');
  // 等冲突询问弹窗出现，逐个作答（两个都点「覆盖」）
  await new Promise((r) => setTimeout(r, 0));
  for (let guard = 0; guard < 5 && globalThis.__r52Modal.length === 0; guard++) await new Promise((r) => setTimeout(r, 5));
  assertEqual(globalThis.__r52Modal.length, 1, 'R52-03：回 needsDecision 后必须先弹询问框');
  assert(/目标位置已存在同名文件/.test(globalThis.__r52Modal[0].body.innerHTML), 'R52-03：询问框要说明冲突对象');
  asked.push(globalThis.__r52Modal.shift());
  await asked[0].foot[2].onClick(null, () => {}); // 「覆盖」
  for (let guard = 0; guard < 5 && globalThis.__r52Modal.length === 0; guard++) await new Promise((r) => setTimeout(r, 5));
  assertEqual(globalThis.__r52Modal.length, 1, 'R52-03：第二个冲突要**再问一次**');
  assert(/文件夹/.test(globalThis.__r52Modal[0].body.innerHTML), 'R52-03：文件夹冲突的措辞要与文件区分');
  asked.push(globalThis.__r52Modal.shift());
  // ⚠️ 这里必须点**第二个**弹窗（`asked[1]`）。写成 `asked[0]` 的话点的是已经 resolve 过的
  //    第一个询问（`done` 已置位 ⇒ onClick 空转），第二个冲突永远不被作答，
  //    `resolveCopyConflicts` 卡在 i=1、`await p` 永不落定 —— 症状不是某条断言变红，
  //    而是事件循环被抽干、**本文件后续用例全部 cancelled**（非常难查）。
  await asked[1].foot[1].onClick(null, () => {}); // 「跳过」
  await p;

  const calls = globalThis.__r52Api.calls;
  assertEqual(calls.length, 2, 'R52-03：应当恰好两轮（先问、后写），实际 ' + calls.length);
  const decisions = calls[1][3];
  assert(decisions, 'R52-03：第二轮必须带 decisions');
  assertEqual(decisions['a.txt'], 'overwrite', 'R52-03：第一项的选择应如实带上');
  assertEqual(decisions['dir/'], 'skip', 'R52-03：第二项的选择应如实带上');
  const t = globalThis.__r52Toast.map((x) => x[0]).join('|');
  assert(/已复制 1 项/.test(t) && /1 项已跳过/.test(t), 'R52-03：结果要分开报，实际：' + t);
});

/**
 * R52-03 的「全是」（用户确认的口径：「可选『全是』」）。
 *
 * ⚠️ 单独成用例的理由：上一条用例的**标题**里写着「含『全是』」，正文却只走了一问一答 ——
 *    于是「勾了『对后续全部冲突执行相同选择』之后不再逐个弹窗」这条**从没被跑过**。
 *    护栏只写在名字里、没写进断言，与没写差别不大。
 *
 * 这里刻意**分步驱动**而不是 `await p` 完事：变异（把 `carry` 那行废掉）会让第二个冲突
 * 再弹一次窗、且**没人作答**，`await p` 于是永远不落定，症状会变成「事件循环被抽干、
 * 整份文件后续用例全部 cancelled」—— TAP 里 fail=0，反向对照脚本据此只会报「没抓到」。
 * 所以：先把残留的询问**兜底答完**，再断言「到底弹了几次」——失败必须是干净的一条红。
 */
test('R52-03 · ops：冲突询问勾了「全是」之后不再逐项弹窗，且决策全覆盖', async () => {
  const { ops } = await loadOps();
  globalThis.sessionStorage = (() => {
    const s = new Map();
    return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) };
  })();
  ops.copyKeys(['a.txt', 'b.txt', 'c.txt']);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const rounds = [
    {
      ok: false, needsDecision: true,
      conflicts: [
        { path: 'a.txt', target: 'dst/a.txt', kind: 'file', count: 1 },
        { path: 'b.txt', target: 'dst/b.txt', kind: 'file', count: 1 },
        { path: 'c.txt', target: 'dst/c.txt', kind: 'file', count: 1 },
      ],
    },
    { ok: true, results: [{ path: 'a.txt', ok: true }, { path: 'b.txt', ok: true }, { path: 'c.txt', ok: true }] },
  ];
  globalThis.__r52Api = { calls: [] };
  const api = globalThis.__r52Api;
  let n = 0;
  Object.defineProperty(api, 'copyResult', { get() { return rounds[Math.min(n++, rounds.length - 1)]; }, configurable: true });
  globalThis.__r52Modal.length = 0;
  globalThis.__r52Toast.length = 0;

  const p = ops.pasteTo('dst/');
  await tick();
  assertEqual(globalThis.__r52Modal.length, 1, 'R52-03：第一个冲突必须先问');
  // 勾上「对后续全部冲突执行相同选择」，再点「覆盖」
  globalThis.__r52Modal[0].body.querySelector('#cp-all').checked = true;
  await globalThis.__r52Modal.shift().foot[2].onClick(null, () => {});
  await tick();

  const extra = globalThis.__r52Modal.length;
  // 兜底： 不管弹了几次，全部答完，避免 `await p` 悬住（失败必须是干净的一条红）
  for (let guard = 0; guard < 10 && globalThis.__r52Modal.length; guard++) {
    await globalThis.__r52Modal.shift().foot[2].onClick(null, () => {});
    await tick();
  }
  await p;
  assertEqual(extra, 0, 'R52-03：勾了「全是」之后，后续冲突不得再弹窗（实际又弹了 ' + extra + ' 个）');

  const calls = globalThis.__r52Api.calls;
  assertEqual(calls.length, 2, 'R52-03：勾「全是」也应恰好两轮，实际 ' + calls.length);
  const decisions = calls[1][3];
  assertEqual(JSON.stringify(decisions), JSON.stringify({ 'a.txt': 'overwrite', 'b.txt': 'overwrite', 'c.txt': 'overwrite' }),
    'R52-03：「全是」必须把同一个选择落实到**每一个**冲突项上');
});

/* ================================================================== *
 * ② 真发 HTTP 层：文件系统写入（移动 / 复制）
 * ================================================================== */

test('R52-02 · POST /fs/move：目标与源相同时如实回报 skipped（文件夹也不例外）', async () => {
  seedConfig();
  FsObjects.clear();
  FsObjects.set('src/', 0);
  FsObjects.set('src/a.txt', 1);
  FsObjects.set('dst/', 0);
  FsObjects.set('x.txt', 5);
  const { port, close } = await serve('/api', fsRoutes);
  try {
    // ① 文件夹移到自己所在目录 ⇒ skipped（旧实现被「自身内部」分支抢先命中，报一个
    //    根本没发生的错误；见 routes/fs.js 里那段顺序说明）
    let r = await request(port, 'POST', '/api/fs/move', { body: { paths: ['src/'], targetPrefix: '' } });
    assertEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.raw);
    assertEqual(r.json.results[0].ok, true, 'R52-02：应如实回报成功');
    assertEqual(r.json.results[0].skipped, true, 'R52-02：目标与源相同时必须标记 skipped');
    assert(FsObjects.has('src/a.txt'), 'R52-02：原地移动不得删掉任何对象');

    // ② 真正移进自己的子目录 ⇒ 仍然必须拒绝（递归自指）
    r = await request(port, 'POST', '/api/fs/move', { body: { paths: ['src/'], targetPrefix: 'src/inner/' } });
    assert(/自身内部/.test(r.json.results[0].error || ''),
      'R52-02：移进自身内部必须拒绝，实际 ' + JSON.stringify(r.json.results[0]));
    assertEqual(FsObjects.size, 4, 'R52-02：被拒时不得动任何对象');

    // ③ 反向对照：正常移动照旧工作（顺带确认「跳过」不是靠「一律不动」骗来的）
    r = await request(port, 'POST', '/api/fs/move', { body: { paths: ['x.txt'], targetPrefix: 'dst/' } });
    assertEqual(r.json.results[0].ok, true, 'R52-02：正常移动应成功');
    assertEqual(r.json.results[0].skipped, undefined, '正常移动不该被标成 skipped');
    assert(FsObjects.has('dst/x.txt') && !FsObjects.has('x.txt'), 'R52-02：移动必须真的删源');
  } finally {
    await close();
  }
});

test('R52-03 · POST /fs/copy：冲突先问后写、decisions 覆盖 / 跳过、目录递归、源保留', async () => {
  seedConfig();
  FsObjects.clear(); FsCopyKeys.length = 0; FsFailOn.clear();
  FsObjects.set('a.txt', 10);
  FsObjects.set('dest/', 0);
  const { port, close } = await serve('/api', fsRoutes);
  try {
    // ① 无冲突：直接复制，源与目标并存（复制不是移动）
    let r = await fsSend(port, { paths: ['a.txt'], targetPrefix: 'dest/' });
    assertEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.raw);
    assertEqual(r.json.results[0].ok, true, '复制应成功');
    assert(FsObjects.has('a.txt') && FsObjects.has('dest/a.txt'), 'R52-03：源必须保留');
    assertEqual(FsCopyKeys.join(','), 'dest/a.txt', '复制的是第 1 项的目标键');

    // ② 目标同名 → needsDecision，且**一个字节都不写**
    FsObjects.set('dest/a.txt', 99);
    FsCopyKeys.length = 0;
    r = await fsSend(port, { paths: ['a.txt'], targetPrefix: 'dest/' });
    assertEqual(r.status, 200, 'needsDecision 仍是 200（前端据此弹询问框）');
    assertEqual(r.json.needsDecision, true, 'R52-03：存在冲突时必须先回 needsDecision');
    assertEqual(r.json.conflicts.length, 1, 'R52-03：冲突按**选中项**聚合成一条');
    assertEqual(r.json.conflicts[0].path, 'a.txt', '冲突条目要带回源路径（前端据此映射决策）');
    assertEqual(r.json.conflicts[0].target, 'dest/a.txt', '冲突条目要给出目标键');
    assertEqual(FsCopyKeys.length, 0, 'R52-03：询问阶段不得发生任何复制');
    assertEqual(FsObjects.get('dest/a.txt'), 99, 'R52-03：询问阶段目标内容不得被改写');

    // ③ skip：目标原样保留
    r = await fsSend(port, { paths: ['a.txt'], targetPrefix: 'dest/', decisions: { 'a.txt': 'skip' } });
    assertEqual(r.json.results[0].skipped, true, 'R52-03：记为跳过');
    assertEqual(FsObjects.get('dest/a.txt'), 99, 'R52-03：跳过时目标内容不得变');

    // ④ overwrite：目标真的被覆盖
    r = await fsSend(port, { paths: ['a.txt'], targetPrefix: 'dest/', decisions: { 'a.txt': 'overwrite' } });
    assertEqual(r.json.results[0].ok, true, 'R52-03：应成功');
    assertEqual(r.json.results[0].skipped, undefined, 'R52-03：覆盖不是跳过');
    assertEqual(FsObjects.get('dest/a.txt'), 10, 'R52-03：目标内容必须被覆盖成源内容');

    // ⑤ 目录递归（含目录标记对象）、源整份保留
    FsObjects.clear(); FsCopyKeys.length = 0;
    FsObjects.set('src/', 0);
    FsObjects.set('src/x.txt', 11);
    FsObjects.set('src/sub/', 0);
    FsObjects.set('src/sub/y.txt', 22);
    r = await fsSend(port, { paths: ['src/'], targetPrefix: 'bak/' });
    assertEqual(r.json.results[0].ok, true, '目录复制应成功：' + r.raw);
    assertEqual(r.json.results[0].count, 4, 'R52-03：含两个目录标记对象，共 4 个任务');
    for (const k of ['src/', 'src/x.txt', 'src/sub/', 'src/sub/y.txt']) {
      assert(FsObjects.has(k), 'R52-03：源必须保留 ' + k);
    }
    for (const k of ['bak/src/', 'bak/src/x.txt', 'bak/src/sub/', 'bak/src/sub/y.txt']) {
      assert(FsObjects.has(k), 'R52-03：目标必须有 ' + k);
    }

    // ⑥ 复制到自身内部 ⇒ 拒绝（否则边复制边枚举自己）
    FsObjects.clear();
    FsObjects.set('p/', 0);
    FsObjects.set('p/q.txt', 1);
    r = await fsSend(port, { paths: ['p/'], targetPrefix: 'p/inner/' });
    assert(/自身内部/.test(r.json.results[0].error || ''), 'R52-03：必须拒绝，实际 ' + JSON.stringify(r.json.results[0]));

    // ⑦ 目标与源同一位置 ⇒ 如实跳过（与 move 同一口径）
    FsObjects.clear();
    FsObjects.set('same/', 0);
    FsObjects.set('same/z.txt', 1);
    r = await fsSend(port, { paths: ['same/z.txt'], targetPrefix: 'same/' });
    assertEqual(r.json.results[0].skipped, true, 'R52-03：同位置复制应如实跳过');
    assert(/同一位置/.test(r.json.results[0].reason || ''), 'R52-03：要说清原因');

    // ⑧ 入参边界
    r = await fsSend(port, { paths: [], targetPrefix: 'dest/' });
    assertEqual(r.status, 400, 'R52-03：空 paths 应 400');
    r = await fsSend(port, { paths: ['a.txt'], targetPrefix: '../out/' });
    assertEqual(r.status, 400, 'R52-03：目标含 .. 应 400');
  } finally {
    await close();
  }
});

test('R52-03 · POST /fs/copy：失败回滚只删本次新建，目标侧既有对象必须留下', async () => {
  seedConfig();
  const { port, close } = await serve('/api', fsRoutes);
  try {
    // ① 一个成功、一个失败；目标侧另有一个与本次无关的既有对象
    FsObjects.clear(); FsFailOn.clear();
    FsObjects.set('ok1.txt', 1);
    FsObjects.set('boom.txt', 2);
    FsObjects.set('dest/keep.txt', 7);
    FsObjects.set('dest/boom.txt', 8); // 已存在 ⇒ 用户选「覆盖」
    FsFailOn.add('dest/boom.txt');
    let r = await fsSend(port, {
      paths: ['ok1.txt', 'boom.txt'], targetPrefix: 'dest/',
      decisions: { 'boom.txt': 'overwrite' },
    });
    assert(r.status >= 400, '整批失败必须报错，实际 ' + r.status + ' ' + r.raw.slice(0, 200));
    assert(!FsObjects.has('dest/ok1.txt'), 'R52-03：本次新建的副本必须被回滚');
    assert(FsObjects.has('dest/keep.txt'), 'R52-03：与本次无关的目标侧对象必须留下');
    assert(FsObjects.has('dest/boom.txt'),
      '★ R52-03：被「覆盖写入」的目标侧既有对象**不得**被回滚删掉 —— '
      + 'copyBatch 的内部回滚会连带删它（它把 copied 全删），故本条路径必须传 rollback:false');
    assert(FsObjects.has('ok1.txt') && FsObjects.has('boom.txt'), 'R52-03：源数据不受影响');
    assert(!/目标位置可能残留半成品副本/.test(r.json.error || ''),
      'R52-03：错误文案不得与「已回滚」自相矛盾，实际：' + r.json.error);
    assert(/已回滚本次新建的 1 个副本/.test(r.json.error || ''),
      'R52-03：要如实告知回滚了几个，实际：' + r.json.error);

    // ② 前置目录已复制成功、后续文件失败 ⇒ 前面的目录副本同样要回滚
    FsObjects.clear(); FsFailOn.clear();
    FsObjects.set('d1/', 0);
    FsObjects.set('d1/f.txt', 3);
    FsObjects.set('bad.txt', 4);
    FsObjects.set('out/keep.txt', 5);
    FsFailOn.add('out/bad.txt');
    r = await fsSend(port, { paths: ['d1/', 'bad.txt'], targetPrefix: 'out/' });
    assert(r.status >= 400, '应报错，实际 ' + r.status);
    assert(!FsObjects.has('out/d1/') && !FsObjects.has('out/d1/f.txt'),
      '★ R52-03：请求层要统一收口回滚 —— 前一个目录批次已成功的副本也得撤掉');
    assert(FsObjects.has('out/keep.txt'), 'R52-03：目标侧既有对象保留');
    assert(FsObjects.has('d1/') && FsObjects.has('d1/f.txt'), 'R52-03：源目录不受影响');
    FsFailOn.clear();

    /**
     * ③ ★ 让「内部回滚会毁掉目标侧既有对象」真正可复现的那一步。
     *
     * ①②都**不够**：它们里被覆盖的目标侧对象（`dest/boom.txt`）恰好就是**失败**的那一项，
     * 于是它从没进过 `copyBatch` 的 `copied` 台账 —— 即便内部回滚没关（`rollback:true`），
     * 那条台账里也只有本次新建的键，结果碰巧是对的。护栏于是"比名字弱"：
     * 断言写着「覆盖写入的目标侧既有对象不得被回滚删掉」，实际根本没构造出那个场景。
     *
     * 这里让**覆盖成功**的项与**失败**的项落在**同一批**里（`copyBatch` 一次调用）：
     *  · `keep.txt` → `dest/keep.txt`（目标侧既有、用户选覆盖）⇒ 复制**成功**；
     *  · `ok2.txt`  → `dest/ok2.txt`（本次新建）                ⇒ 复制**成功**；
     *  · `boom.txt` → `dest/boom.txt`（桩注入失败）             ⇒ 触发整批回滚。
     * 内部回滚会把 `dest/keep.txt` 一起删掉（它只认 `copied`）；请求层回滚只删
     * `createdKeys`，而 `protectedKeys` 里的 `dest/keep.txt` 不在其中。
     */
    FsObjects.clear(); FsFailOn.clear();
    FsObjects.set('keep.txt', 7);
    FsObjects.set('ok2.txt', 1);
    FsObjects.set('boom.txt', 2);
    FsObjects.set('dest/keep.txt', 8); // 目标侧既有对象（内容属于别人）
    FsFailOn.add('dest/boom.txt');
    r = await fsSend(port, {
      paths: ['keep.txt', 'ok2.txt', 'boom.txt'], targetPrefix: 'dest/',
      decisions: { 'keep.txt': 'overwrite' },
    });
    assert(r.status >= 400, '整批失败必须报错，实际 ' + r.status);
    assert(!FsObjects.has('dest/ok2.txt'), 'R52-03：本次新建的副本必须被回滚');
    assertEqual(FsObjects.get('dest/keep.txt'), 7,
      '★ R52-03：**覆盖成功**的目标侧既有对象不得被回滚删掉（值应为源内容的 7；'
      + '若为 undefined 说明被删了、若为 8 说明压根没覆盖成功）');
    FsFailOn.clear();
  } finally {
    await close();
  }
});

test('R52-03 · POST /fs/copy：复制是净增占用，配额按真实总字节计', async () => {
  // 上限 100 字节，要复制的对象 5000 字节 ⇒ 必须被闸门拦下
  seedConfig({
    credentials: [{
      id: 'credP', provider: 'tencent', secretId: 'AKIDp', secretKey: 'k',
      quotaBytes: 100, enabled: true, visibleToUsers: true, remark: 'p',
    }],
  });
  FsObjects.clear();
  FsObjects.set('big.txt', 5000);
  const { port, close } = await serve('/api', fsRoutes);
  try {
    const r = await fsSend(port, { paths: ['big.txt'], targetPrefix: 'dest/' });
    assertEqual(r.status, 403, 'R52-03：净增 5000 > 上限 100 ⇒ 403，实际 ' + r.status + ' ' + r.raw.slice(0, 200));
    assertEqual(r.json && r.json.code, 'CREDENTIAL_QUOTA_EXCEEDED', 'R52-03：必须带机器可读码');
    assert(!FsObjects.has('dest/big.txt'), 'R52-03：被拒时不得写入目标');

    // 反向对照：放开上限后同一个请求必须成功 —— 否则上面只证明了「恒 403」
    seedConfig();
    const r2 = await fsSend(port, { paths: ['big.txt'], targetPrefix: 'dest/' });
    assertEqual(r2.status, 200, 'R52-03：放开上限后必须放行，实际 ' + r2.status + ' ' + r2.raw.slice(0, 200));
    assertEqual(FsObjects.get('dest/big.txt'), 5000, '目标对象大小应与源一致');
  } finally {
    await close();
  }
});

/* ================================================================== *
 * ④ 静态不变量
 * ================================================================== */

test('R52-02 · 静态：openFolderPicker 不得再把 App.state.prefix 当默认目标', () => {
  const src = read('public/js/ops.js');
  assert(!/let selected = fixedTarget \|\| App\.state\.prefix/.test(src),
    'R52-02：旧写法（fixedTarget 缺省就落到当前目录）必须消失 —— 它是「报成功、实际没动」的根因');
  assert(/let selected = preselected \? fixedTarget : null/.test(src),
    'R52-02：未指定目标时必须停在 null（「什么都没选」与「选了根目录」是两回事）');
  assert(/if \(selected === null\)/.test(src),
    'R52-02：确定按钮必须显式拦一次「还没选」');
  // 三条汇总口径都要在（成功 / 跳过 / 失败），且不得再出现「跳过也算成功」的老写法
  assert(/x\.ok && !x\.skipped/.test(src), 'R52-02：成功数要排除 skipped');
  assert(/x\.ok && x\.skipped/.test(src), 'R52-02：跳过数要单独统计');
  assert(!/const failed = \(r\.results \|\| \[\]\)\.filter\(\(x\) => !x\.ok\);\s*\n\s*if \(failed\.length\) toast\(`移动完成/.test(src),
    'R52-02：不得再用「只有 failed 才报错、否则一律移动完成」的老口径');
});

test('R52-06 · 链接结果弹窗左右视觉等高：二维码随六行信息区一起长高', () => {
  const css = read('public/css/style.css');
  const wrap = /\.lr-wrap\s*\{([^}]*)\}/.exec(css);
  assert(wrap, '必须有 .lr-wrap 规则');
  assert(/align-items:\s*stretch/.test(wrap[1]),
    'R52-06：两列必须 stretch 等高（旧的默认 flex-start 会让左侧二维码比右侧信息区矮一截）');
  const qr = /\.lr-qr\s*\{([^}]*)\}/.exec(css);
  assert(qr, '必须有 .lr-qr 规则');
  const qrSvg = /\.lr-qr\s+svg\s*\{([^}]*)\}/.exec(css);
  assert(qrSvg, '必须有 .lr-qr svg 规则');
  const num = (s) => { const m = /(\d+)px/.exec(s); return m ? Number(m[1]) : NaN; };
  const box = num(qr[1]);
  const svg = num(qrSvg[1]);
  assert(Number.isFinite(box) && Number.isFinite(svg), '尺寸必须是 px 数值');
  assertEqual(box, svg, 'R52-06：二维码容器与二维码本身的尺寸必须一致（否则又矮一截）');
  assert(box >= 208, 'R52-06：六行信息区 ≈208px，二维码须至少这个高度才能视觉等高（实际 ' + box + 'px）');
  // 六行都在位（R37 的两行不得再被注释掉换取等高）
  const ops = read('public/js/ops.js');
  for (const label of ['文件名', '链接创建时间', '过期时间', '价格', '允许下载次数', '下载限速']) {
    assert(new RegExp('\\[\\s*\'' + label + '\'').test(ops), `R52-06：信息区第「${label}」行必须在位`);
  }
  // 那条「增删任何一行都要同步改 CSS」的说明必须留在**代码旁**（否则下一个人只会把行注掉）
  assert(/\.lr-qr/.test(ops) && /style\.css/.test(ops),
    'R52-06：ops.js 的这六行旁要留一句「尺寸是一对约束、请改 CSS 而不是注释掉行」的说明');
});

test('R52-03 · 静态：前端确实接上了复制 / 粘贴的三个入口与 Ctrl+C / Ctrl+V', () => {
  const idx = read('public/index.html');
  assert(/id="op-copy"/.test(idx), 'R52-03：工具栏要有「复制」按钮');
  assert(/id="op-paste"/.test(idx), 'R52-03：工具栏要有「粘贴」按钮');
  const main = read('public/js/main.js');
  assert(/set\('op-copy', SVG\.copy\)/.test(main) && /set\('op-paste', SVG\.paste\)/.test(main),
    'R52-03：两个新按钮必须挂上图标（main.js 的 SVG 映射）');
  assert(/copy: '<svg/.test(main) && /paste: '<svg/.test(main), 'R52-03：SVG 图标要有定义');
  assert(/\$\('op-copy'\)\.onclick = \(\) => ops\.copySelected\(\)/.test(main), 'R52-03：复制按钮要接到 ops.copySelected');
  assert(/\$\('op-paste'\)\.onclick = \(\) => ops\.paste\(\)/.test(main), 'R52-03：粘贴按钮要接到 ops.paste');
  assert(/e\.key\.toLowerCase\(\) === 'c'[\s\S]{0,80}ops\.copySelected\(\)/.test(main), 'R52-03：Ctrl+C 要接到复制');
  assert(/e\.key\.toLowerCase\(\) === 'v'[\s\S]{0,80}ops\.paste\(\)/.test(main), 'R52-03：Ctrl+V 要接到粘贴');
  const exp = read('public/js/explorer.js');
  assert(/set\('op-copy', n === 0\)/.test(exp), 'R52-03：复制按钮要随选择自动启用 / 禁用');
  const api = read('public/js/api.js');
  assert(/copy: \(paths, targetPrefix, decisions\) => request\('POST', '\/api\/fs\/copy'/.test(api),
    'R52-03：api.js 要有 copy 封装并带上 decisions');
});
