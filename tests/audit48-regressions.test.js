/**
 * 第四十八轮护栏：多线程加密 + 多文件并发上传 + 「线程并发」卡片 + 「收入统计」卡片。
 *
 * ## 本轮改动的三件事与它们的判据落在哪一层
 *
 * 1. **多线程**（`server/enc-pool.js` / `enc-xor.js`）：magic 的密钥流原先是纯 JS、
 *    在主线程同步跑（~15MB/s，5MB 要占住事件循环约 330ms）。现在交给 `worker_threads`。
 *    判据**不能**只断言「有个 worker 文件」—— 那对「算了但结果不对」毫无覆盖。
 *    这里真的把任务丢进池、拿回结果，与主线程同步实现**逐字节比对**（A1/A5/A6），
 *    并用「入参未被就地改写」证明这次计算确实发生在**另一个线程**上（同线程实现是
 *    就地改写的）——否则「池其实没生效、悄悄走了同步兜底」也会一路绿。
 *
 * 2. **多文件并发**（`public/js/upload.js` + `util.js` 的 `uploadPlan()`）：
 *    `MAX_FILE_CONCURRENCY = 2` 是个硬编码常量，「同时传几个文件」没法调。现在由
 *    「线程并发」配置驱动，并按浏览器 **6 条连接**的硬顶反推单文件分片并发。
 *    判据分两层：`uploadPlan()` 是纯函数（B1~B4 穷举表格 + 不变量），
 *    再**真的跑一遍 `upload.js`** 数「同时在途的请求数」（B6）——
 *    只断言常量表等于某个数，是证明不了「界面设了就真的并发起来的」。
 *
 * 3. **收入统计**：`computeRevenue()` 是纯函数，逐项钉住口径（只算 `paid`、
 *    按对象键归集、改价显示区间、桶名快照优先）。这一块最容易被写成
 *    「看起来对、算起来错」，而界面照样渲染得很好看。
 */
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('node:url');

// 必须最先 require：它把 S3_DATA_DIR 兜底到临时目录（否则会写生产 data/）
const { assert, assertEqual, ROOT } = require('./helpers');

const JSDIR = path.join(ROOT, 'public', 'js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJs = (f) => fs.readFileSync(path.join(JSDIR, f), 'utf8');

/**
 * 把注释抹成**等长空白**（与 `invariants.test.js` 同一纪律）。
 *
 * 为什么本文件必须有它：`server/fs-gateway.js` 的块注释里就原样写着
 * `` `encStore.encryptBuffer()` **再产出一份密文副本** `` —— 那是「说明历史行为」的
 * 反例文字，不是调用。不剥注释的话，A7 的负向断言会被**自己的注释**判红；
 * 反过来，正向断言（`encStore.encryptBufferAsync(`）也会被一句注释悄悄满足，
 * 变成「改了没生效也全绿」的假绿。两个方向都踩过，所以正向负向一律先剥。
 *
 * 只用朴素实现即可：本文件比对的是几行调用，不涉及正则字面量里的 `//`。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p) => p + _m.slice(p.length).replace(/[^\n]/g, ' '));
}

/** 取 `function <name>(…) { … }` 的函数体（按大括号配对），用于把判据钉在**函数体内部** */
function bodyOf(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/* ================================================================== *
 * A · 多线程：worker 线程池
 * ================================================================== */

const encXor = require(path.join(ROOT, 'server', 'enc-xor.js'));
const encPool = require(path.join(ROOT, 'server', 'enc-pool.js'));
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));

const KEY = crypto.randomBytes(32);
const SALT = crypto.randomBytes(16);

/** 主线程同步参考实现（直接用池内任务所依赖的同一个原语） */
function refXor(buf, offset, salt) {
  return encXor.xorBufWithKey(KEY, Buffer.from(buf), offset, salt);
}

test('R48-A1 · 线程池的异或结果必须与主线程同步实现逐字节一致，且确实跑在另一个线程上', async () => {
  const n = encPool.configure(3);
  assert(n >= 1, `线程池应可用（configure(3) 返回 ${n}）—— 若环境强制 ENCODER_WORKERS=0，本条会失去意义`);
  assert(encPool.enabled(), '池应处于可用状态');

  // 覆盖：小负载（走同步兜底）、恰好阈值、阈值以上的多段长度与非对齐偏移
  const cases = [
    [1, 0], [37, 5], [1024, 32], [encPool.MIN_WORKER_BYTES + 3, 12345],
    [2 * 1024 * 1024 + 7, 999999],
  ];
  for (const [len, off] of cases) {
    // 用固定随机源保证每次运行都一样（也便于定位）
    const plain = Buffer.alloc(len);
    for (let i = 0; i < len; i++) plain[i] = (i * 31 + 7) & 0xff;
    const expect = refXor(plain, off, SALT);

    const input = Buffer.from(plain);
    const got = await encPool.xor(input, off, SALT, KEY);

    assertEqual(Buffer.compare(got, expect), 0,
      `len=${len} offset=${off}：线程池结果与主线程不一致 —— 两条执行路径已经分叉`);
    if (len >= encPool.MIN_WORKER_BYTES) {
      // 同步实现是**就地**异或；线程路径操作的是克隆，因此入参必须原封不动。
      // 这一条同时证明了「本次计算真的没在主线程上跑」。
      assertEqual(Buffer.compare(input, plain), 0,
        `len=${len}：入参被就地改写了 —— 说明这次并没有走工作线程（悄悄退回了主线程兜底）`);
    }
  }
  assert(encPool.stats().workers >= 1, '应当已经真的起了工作线程（而不是一路走同步兜底）');
});

test('R48-A2 · ENCODER_WORKERS=0 时必须退回主线程，且结果仍然一致', async () => {
  const len = encPool.MIN_WORKER_BYTES + 11;
  const plain = crypto.randomBytes(len);
  const expect = refXor(plain, 3, SALT);
  process.env.ENCODER_WORKERS = '0';
  try {
    assert(encPool.disabled(), '环境变量应被读到（每次调用都读，而不是模块加载时读一次）');
    assertEqual(encPool.enabled(), false, '关闭时池不应报告可用');
    const got = await encPool.xor(Buffer.from(plain), 3, SALT, KEY);
    assertEqual(Buffer.compare(got, expect), 0, '关闭多线程后结果必须与同步实现一致（兜底不得改变行为）');
  } finally {
    delete process.env.ENCODER_WORKERS;
  }
});

test('R48-A3 · 池被停机时必须把在途任务就地算完，绝不丢任务', async () => {
  encPool._resetForTest();
  assert(encPool.configure(2) >= 1, '池应可配置');

  const len = encPool.MIN_WORKER_BYTES + 1024;
  const plain = crypto.randomBytes(len);
  const expect = refXor(plain, 17, SALT);

  // 同一个 tick 内提交后立刻停机 —— 此时任务只可能在「正忙的线程」或「队列」里，
  // 两者都必须被 drainLocally() 就地算完（任务全是确定性的，重算结果相同）。
  const p = encPool.xor(Buffer.from(plain), 17, SALT, KEY);
  encPool.shutdown();
  const got = await p;
  assertEqual(Buffer.compare(got, expect), 0,
    '停机丢弃在途任务会让上传拿到错误/缺失的密文 —— 必须就地算完');
  assertEqual(encPool.stats().workers, 0, '停机后不应残留工作线程');
  encPool._resetForTest();
});

test('R48-A4 · 线程数必须收敛到 [1, min(8, 核数-1)]', () => {
  const cpus = Math.max(1, (os.cpus() || []).length);
  const expect = Math.min(encPool.HARD_MAX_WORKERS, Math.max(1, cpus - 1));
  encPool._resetForTest();
  assertEqual(encPool.configure(1000), expect, `填 1000 应被收到 ${expect}（硬顶 HARD_MAX_WORKERS=${encPool.HARD_MAX_WORKERS}）`);
  assertEqual(encPool.configure(1), 1, '填 1 就是 1（最小并发）');
  assertEqual(encPool.configure(0), 1, '填 0 应归一到 1，而不是「关掉」或「无限」');
  encPool._resetForTest();
});

/* ================================================================== *
 * A5~A6 · 加密入口的两条路径必须等价
 * ================================================================== */

/** 固定 randomBytes：magic 的盐与 crypto 的 IV 都来自它，固定后才可做逐字节差分 */
function withFixedRandom(fn) {
  const real = crypto.randomBytes;
  crypto.randomBytes = (n) => Buffer.alloc(n, 0x5a);
  return Promise.resolve()
    .then(fn)
    .finally(() => { crypto.randomBytes = real; });
}

test('R48-A5 · encryptBufferAsync 与 encryptBuffer 必须逐字节一致（magic 与 crypto 两种模式）', async () => {
  await withFixedRandom(async () => {
    const plain = crypto.randomBytes(encPool.MIN_WORKER_BYTES + 4096);
    for (const mode of ['magic', 'crypto']) {
      await encStore.updateSettings({ mode, magic: '0x0a0b0c0d' });
      const sync = encStore.encryptBuffer('bkt', 'k', plain);
      const mt = await encStore.encryptBufferAsync('bkt', 'k', plain);
      assertEqual(Buffer.compare(sync.data, mt.data), 0,
        `${mode}：多线程加密的密文与同步版不一致 —— 同一份明文被加了两次得到不同结果，属不可逆的数据事故`);
      // createdAt 是时间戳，两次调用必然不同，比对时排除
      assertEqual(JSON.stringify(Object.assign({}, mt.meta, { createdAt: 0 })),
        JSON.stringify(Object.assign({}, sync.meta, { createdAt: 0 })),
        `${mode}：解密凭据（元数据）必须完全一致，否则用线程加密的文件会解不开`);
    }
    await encStore.updateSettings({ mode: 'none' });
  });
});

test('R48-A6 · encryptPartAsync 与 encryptPart 必须逐字节一致，且会话加密状态一致', async () => {
  await withFixedRandom(async () => {
    const chunk = 300 * 1024;
    const plain = crypto.randomBytes(chunk * 3 + 17);
    for (const mode of ['magic', 'crypto']) {
      await encStore.updateSettings({ mode, magic: '0x0a0b0c0d' });
      const size = plain.length;
      const total = Math.ceil(size / chunk);
      const sSync = { chunkSize: chunk, size, enc: null };
      const sMt = { chunkSize: chunk, size, enc: null };
      for (let p = 1; p <= total; p++) {
        const part = plain.subarray((p - 1) * chunk, Math.min(p * chunk, size));
        const a = encStore.encryptPart(sSync, p, Buffer.from(part));
        const b = await encStore.encryptPartAsync(sMt, p, Buffer.from(part));
        assertEqual(Buffer.compare(a, b), 0, `${mode} 第 ${p} 片：密文不一致`);
      }
      assertEqual(JSON.stringify(sMt.enc), JSON.stringify(sSync.enc),
        `${mode}：分片加密累积在会话上的状态（盐 / 摘要 / IV / TAG）必须一致，否则断点续传与完整性校验会错`);
    }
    await encStore.updateSettings({ mode: 'none' });
  });
});

test('R48-A7 · 上传与 WebDAV 写入这两条路径必须走多线程入口（同步名不得出现在调用点）', () => {
  for (const file of ['server/routes/fs.js', 'server/fs-gateway.js']) {
    // 先剥注释：fs-gateway.js 的注释里写着 `encStore.encryptBuffer()`（那是历史说明，
    // 不是调用）—— 不剥注释，负向断言会被注释判红，正向断言又会被注释满足（假绿）。
    const src = stripComments(read(file));
    assert(/encStore\.encryptBufferAsync\(/.test(src),
      `${file}：整文件加密必须走 encryptBufferAsync（多线程入口）—— 只写在注释里不算`);
    assert(!/encStore\.encryptBuffer\(/.test(src),
      `${file}：不得再直接调用同步的 encryptBuffer —— 那会在主线程同步阻塞（这正是本轮要修的问题）`);
  }
  const fsSrc = stripComments(read('server/routes/fs.js'));
  assert(/encStore\.encryptPartAsync\(/.test(fsSrc), '分片加密必须走 encryptPartAsync');
  assert(!/encStore\.encryptPart\(/.test(fsSrc), '不得再直接调用同步的 encryptPart');
  // 反面：池里那两个「同步名」必须仍然存在（否则本条只是证明了「函数被删了」）
  const store = stripComments(read('server/enc-store.js'));
  assert(/function\s+encryptBuffer\s*\(/.test(store) && /function\s+encryptPart\s*\(/.test(store),
    '同步实现必须保留 —— 它是工作线程不可用时的兜底，也是上面两条负向断言的对照物');
});

test('R48-A8 · 工作线程只允许依赖纯原语模块（不得把 config-store 之类带副作用的东西拉进线程）', () => {
  const src = read('server/enc-pool.js');
  const rel = [...src.matchAll(/require\(\s*['"]\.\/([\w.-]+)['"]\s*\)/g)].map((m) => m[1]);
  assertEqual(rel.join(','), 'enc-xor',
    '工作线程入口就是本文件：它 require 的每个相对模块都会在**线程里**被求值一次。'
    + '只允许 pure 的 enc-xor（并发加载 config-store 会与主线程争写同一份配置）');
  // 算法本体只能有一份：两个模块都从 enc-xor 取
  assert(/require\('\.\/enc-xor'\)/.test(read('server/enc-store.js')),
    'enc-store 必须复用 enc-xor 的原语（而不是自己再留一份实现）');
});

/* ================================================================== *
 * B · 多文件并发：连接预算式调度
 * ================================================================== */

/** 直接取真实 util.js（无依赖的叶子模块）里的调度函数 */
async function loadUploadPlan() {
  const m = await import(pathToFileURL(path.join(JSDIR, 'util.js')).href);
  return m;
}

test('R48-B1 · 调度表：同时传几个文件 → 每文件几片（乘积不得超过浏览器 6 条连接）', async () => {
  const { uploadPlan, CONNECTION_BUDGET } = await loadUploadPlan();
  const table = [
    [1, 1, 3], [2, 2, 3], [3, 3, 2], [4, 4, 1], [5, 5, 1], [6, 6, 1], [10, 10, 1], [16, 16, 1],
  ];
  for (const [files, expFiles, expChunks] of table) {
    const p = uploadPlan(files);
    assertEqual(`${p.fileConcurrency}x${p.chunkConcurrency}`, `${expFiles}x${expChunks}`,
      `files=${files} 的调度应为 ${expFiles} 文件 × ${expChunks} 分片`);
    if (files <= CONNECTION_BUDGET) {
      assert(p.fileConcurrency * p.chunkConcurrency <= CONNECTION_BUDGET,
        `files=${files}：乘积 ${p.fileConcurrency * p.chunkConcurrency} 超过浏览器 ${CONNECTION_BUDGET} 条连接上限`);
      // 还能不能再上调分片？能就说明预算没用满（少用了连接 = 白等）
      const up = uploadPlan(files);
      const canRaise = (up.chunkConcurrency + 1) * up.fileConcurrency <= CONNECTION_BUDGET;
      assert(!canRaise || up.chunkConcurrency >= 3,
        `files=${files}：预算还有富余却没有用上（${up.chunkConcurrency} 片）`);
    } else {
      assertEqual(p.chunkConcurrency, 1, `files=${files} 超过预算，分片必须降到 1`);
    }
  }
});

test('R48-B2 · 拿不到配置或配置非法时必须退回串行（绝不按「大值」起跑）', async () => {
  const { uploadPlan } = await loadUploadPlan();
  for (const bad of [undefined, null, '', 'abc', 0, -3, NaN, {}]) {
    const p = uploadPlan(bad);
    assertEqual(`${p.fileConcurrency}x${p.chunkConcurrency}`, '1x3',
      `非法输入 ${JSON.stringify(bad)} 应退回串行（1 文件 × 3 分片），而不是并发`);
  }
});

test('R48-B3 · 预览文案必须与调度同源（文案里的两个数就是真实调度参数）', async () => {
  const { uploadPlan, uploadPlanNotice } = await loadUploadPlan();
  for (const files of [1, 2, 3, 4, 6, 16]) {
    const p = uploadPlan(files);
    const text = uploadPlanNotice(files);
    assert(text.includes(`同时上传 ${p.fileConcurrency} 个文件`),
      `files=${files} 的预览应写明「同时上传 ${p.fileConcurrency} 个文件」，实际：${text}`);
    assert(text.includes(`同时传 ${p.chunkConcurrency} 个分片`),
      `files=${files} 的预览应写明「同时传 ${p.chunkConcurrency} 个分片」，实际：${text}`);
  }
});

test('R48-B4 · upload.js 必须按配置派生并发（硬编码常量不得复活）', () => {
  const src = readJs('upload.js');
  assert(!/MAX_FILE_CONCURRENCY|MAX_CHUNK_CONCURRENCY/.test(src),
    'upload.js 不得再出现硬编码的并发常量 —— 那正是「界面设了却不起作用」的成因');
  assert(/uploadPlan\s*\}\s*from\s*'\.\/util\.js'/.test(src), 'upload.js 应从 util.js 具名导入 uploadPlan');
  assert(/const\s*\{\s*fileConcurrency\s*\}\s*=\s*currentPlan\(\)/.test(src),
    'pump() 必须用 currentPlan() 派生的文件并发数决定同时起几个任务');
  assert(/currentPlan\(\)\.chunkConcurrency/.test(src),
    '分片并发数同样必须来自 currentPlan()（两个数只有一个来源）');
  const util = readJs('util.js');
  assert(/export\s+function\s+uploadPlan\s*\(/.test(util), 'uploadPlan 的唯一实现在 util.js');
  assert(!/function\s+uploadPlan\s*\(/.test(readJs('syssettings.js')),
    '系统设置不得自己再实现一份调度推导（预览必须与调度同源）');
});

/* ------------------- B5：真的跑一遍 upload.js，数在途请求 ------------------- */

/** 搭一套「真实 upload.js + 桩依赖」的模块图；util 桩只把 uploadPlan 接到真实实现上 */
function makeUploadSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r48-upload-'));
  const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  const utilAbs = pathToFileURL(path.join(JSDIR, 'util.js')).href;
  w('util.js', `
export { uploadPlan } from '${utilAbs}';
export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';
export const BUCKET_QUOTA_EXCEEDED_CODE = 'BUCKET_QUOTA_EXCEEDED';
export const fmtSize = (n) => String(n);
// R71：根用户与管理员同级 —— 桩必须提供真实实现（否则 ESM 链接期就整片变红）
export function isStaffRole(role) { return role === 'admin' || role === 'root'; }
export function isRootRole(role) { return role === 'root'; }
export function roleLabel(role) { return role === 'root' ? '根用户' : (role === 'admin' ? '管理员' : '普通用户'); }
// R98：展示名（昵称优先）—— main.js / profile.js 会具名导入，桩缺一个导出就会在 ESM 链接期整片变红
export function displayName(u) { return (u && (String(u.nickname || '').trim() || u.username)) || ''; }
export const toast = () => {};
export const escapeHtml = (s) => String(s);
export const showQuotaDialog = () => true;
`);
  w('gitignore.js', `export const createMatcher = () => ({ isIgnored: () => false });`);
  w('main.js', `
export const App = {
  state: { prefix: '', uploadExcludes: {}, uploadConcurrency: 1 },
  refreshStorage: () => {},
};
`);
  w('explorer.js', `export const explorer = { refresh: () => {} };`);
  // 桩 api.js：记录「同时在途的 xhrPut 数」的峰值
  w('api.js', `
const st = globalThis.__upstats;
export function xhrPut(url, blob, onProgress) {
  st.inflight += 1;
  st.started += 1;
  if (st.inflight > st.peak) st.peak = st.inflight;
  if (onProgress) onProgress(blob.size, blob.size);
  const p = new Promise((resolve) => {
    setTimeout(() => { st.inflight -= 1; st.finished += 1; resolve({ ok: true }); }, 15);
  });
  p.xhr = { abort() {} };
  return p;
}
export const API = {
  uploadInit: async () => ({ mode: 'simple' }),
  uploadComplete: async () => ({ ok: true }),
  uploadAbort: async () => ({ ok: true }),
};
`);
  fs.copyFileSync(path.join(JSDIR, 'upload.js'), path.join(dir, 'upload.js'));
  return dir;
}

const FAKE_DOM = new Map();
function fakeEl(id) {
  if (!FAKE_DOM.has(id)) {
    FAKE_DOM.set(id, {
      id, hidden: false, innerHTML: '', textContent: '', style: {},
      querySelectorAll: () => [], querySelector: () => null,
      classList: { add() {}, remove() {}, toggle() {} },
    });
  }
  return FAKE_DOM.get(id);
}
globalThis.window = globalThis;
globalThis.window.__SVG = { pause: 'p', play: 'r', cancel: 'c' };
globalThis.document = {
  getElementById: fakeEl, createElement: () => fakeEl('tmp'),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { appendChild() {} },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一次「N 个文件、并发上限 M」的上传，返回在途请求峰值 */
async function runConcurrencyProbe(files, limit) {
  const dir = makeUploadSandbox();
  globalThis.__upstats = { inflight: 0, peak: 0, started: 0, finished: 0 };
  const mod = await import(pathToFileURL(path.join(dir, 'upload.js')).href + '?v=' + Math.random());
  mod.uploadMgr.render = () => {}; // 渲染与调度无关，避免假 DOM 干扰
  globalThis.__appStateHolder = null;
  const list = Array.from({ length: files }, (_, i) => ({ name: `f${i}.bin`, size: 10, lastModified: Date.now() }));
  // 通过真实 App.state 注入并发上限（与 main.js 的 loadConfig 写的是同一个字段）
  const main = await import(pathToFileURL(path.join(dir, 'main.js')).href);
  main.App.state.uploadConcurrency = limit;
  mod.uploadMgr.relPathOf = (f) => f.name;
  await mod.uploadMgr.enqueue(list, '', false);
  const deadline = Date.now() + 4000;
  while (globalThis.__upstats.finished < files && Date.now() < deadline) await sleep(10);
  return { ...globalThis.__upstats };
}

test('R48-B5 · 真的跑一遍 upload.js：「线程并发」设为几，同时在途的上传就是几个', async () => {
  const one = await runConcurrencyProbe(6, 1);
  assertEqual(one.started, 6, '6 个文件都应被派发（串行只是不同时进行）');
  assertEqual(one.peak, 1, `上限为 1 时同时在途必须恰好是 1，实际峰值 ${one.peak}`);

  const two = await runConcurrencyProbe(6, 2);
  assertEqual(two.peak, 2, `上限为 2 时同时在途应为 2，实际峰值 ${two.peak}`);

  const five = await runConcurrencyProbe(6, 5);
  assertEqual(five.peak, 5, `上限为 5 时同时在途应为 5，实际峰值 ${five.peak}`);
});

/* ================================================================== *
 * C · 收入统计
 * ================================================================== */

async function loadOrdermgr() {
  return import(pathToFileURL(path.join(JSDIR, 'ordermgr.js')).href);
}

test('R48-C1 · 只把「已支付」算作收入，退款单独列出', async () => {
  const { computeRevenue } = await loadOrdermgr();
  const r = computeRevenue([
    { status: 'paid', amountFen: 1000, fileKey: 'a.txt', fileName: 'a.txt', bucket: 'b1' },
    { status: 'paid', amountFen: 500, fileKey: 'a.txt', fileName: 'a.txt', bucket: 'b1' },
    { status: 'refunded', amountFen: 800, fileKey: 'a.txt', fileName: 'a.txt' },
    { status: 'pending', amountFen: 900, fileKey: 'a.txt', fileName: 'a.txt' },
    { status: 'failed', amountFen: 700, fileKey: 'a.txt', fileName: 'a.txt' },
  ]);
  assertEqual(r.totalFen, 1500, '总计收入只累计已支付');
  assertEqual(r.refundedFen, 800, '已退款金额应单独列出（供对账），但不计入收入');
  assertEqual(r.soldCount, 2, '累计售出次数 = 已支付订单笔数');
  assertEqual(r.fileCount, 1, '同一个对象键的多笔必须归到同一个文件');
  assertEqual(r.files[0].count, 2, '单文件累计售出次数');
  assertEqual(r.files[0].revenueFen, 1500, '单文件累计收入');
  assertEqual(r.files[0].bucket, 'b1', '单文件应带出来源存储桶');
});

test('R48-C2 · 单价取最近一次成交价；改过价时标出区间而不是只报一个数', async () => {
  const { computeRevenue } = await loadOrdermgr();
  const r = computeRevenue([
    { status: 'paid', amountFen: 1000, fileKey: 'x', paidAt: '2026-01-01T00:00:00.000Z' },
    { status: 'paid', amountFen: 2000, fileKey: 'x', paidAt: '2026-03-01T00:00:00.000Z' },
  ]);
  const f = r.files[0];
  assertEqual(f.unitFen, 2000, '单价应为最近一次成交价（2026-03 那笔）');
  assertEqual(f.priceVaries, true, '成交价变过 → 必须标出「已调价」');
  assertEqual(f.minFen, 1000, '区间下界');
  assertEqual(f.maxFen, 2000, '区间上界');

  const same = computeRevenue([
    { status: 'paid', amountFen: 1000, fileKey: 'y', paidAt: '2026-01-01T00:00:00.000Z' },
    { status: 'paid', amountFen: 1000, fileKey: 'y', paidAt: '2026-02-01T00:00:00.000Z' },
  ]);
  assertEqual(same.files[0].priceVaries, false, '价格没变过就不该标「已调价」');
  assertEqual(same.files[0].unitFen, 1000, '单价');
});

test('R48-C3 · 按收入降序、桶名取第一个非空快照、空入参不崩', async () => {
  const { computeRevenue } = await loadOrdermgr();
  const r = computeRevenue([
    { status: 'paid', amountFen: 100, fileKey: 'small', fileName: 'small.bin' },
    { status: 'paid', amountFen: 900, fileKey: 'big', fileName: 'big.bin', bucket: 'bucket-b' },
    { status: 'paid', amountFen: 100, fileKey: 'big', fileName: 'big.bin', bucket: 'bucket-c' },
  ]);
  assertEqual(r.files[0].fileKey, 'big', '收入高的文件应排在前');
  assertEqual(r.files[0].bucket, 'bucket-b', '桶名取第一个非空快照（同一文件的订单应来自同一个桶）');
  assertEqual(computeRevenue([]).totalFen, 0, '空列表应返回 0');
  assertEqual(computeRevenue(null).fileCount, 0, '非数组入参不得崩溃');
  assertEqual(computeRevenue(undefined).soldCount, 0, 'undefined 入参不得崩溃');
});

test('R48-C4 · 没有对象键的历史订单退化为按文件名归集，且不与同名对象键混淆', async () => {
  const { computeRevenue } = await loadOrdermgr();
  const r = computeRevenue([
    { status: 'paid', amountFen: 100, fileName: 'a/b.txt' },
    { status: 'paid', amountFen: 100, fileName: 'a/b.txt' },
    { status: 'paid', amountFen: 100, fileKey: 'a/b.txt', fileName: 'a/b.txt' },
  ]);
  assertEqual(r.fileCount, 2,
    '「无对象键、按文件名归集」与「有对象键」是两类，不得被并成一行（否则两种口径会互相污染）');
  const byName = r.files.find((f) => !f.fileKey);
  assertEqual(byName.count, 2, '两条无名订单应并成一行');
});

test('R48-C5 · 订单必须快照存储桶，且来源桶的判据只有一个实现点', () => {
  const orders = require(path.join(ROOT, 'server', 'payment-orders.js'));
  const o = orders.create({
    linkId: 'lk1', platform: 'wechat', amountFen: 1234, currency: 'CNY',
    payerIp: '', fileName: 'f.bin', fileKey: 'dir/f.bin', bucket: 'my-bucket',
  });
  assertEqual(orders.get(o.id).bucket, 'my-bucket',
    '创建订单时必须快照存储桶 —— 分享链接删掉之后就再也查不到「这笔钱来自哪个桶」了');

  // 快照优先 / 回退现存链接 / 都拿不到则留空（绝不猜）
  assertEqual(orders.bucketOf({ bucket: 'snap' }, { bucket: 'link' }), 'snap', '订单快照优先于链接');
  assertEqual(orders.bucketOf({ bucket: '' }, { bucket: 'link' }), 'link', '快照为空时回退到现存链接');
  assertEqual(orders.bucketOf({}, null), '', '订单与链接都拿不到时必须是空串（界面显示「未知」）');
  assertEqual(orders.bucketOf(null, { bucket: 'link' }), 'link', '订单为空也不得抛错');

  assert(/paymentOrders\.bucketOf\(/.test(read('server/routes/payment.js')),
    '订单列表接口必须用 bucketOf() 带出桶名，而不是在路由里另写一份回退逻辑');
});

/* ================================================================== *
 * D · 卡片位置与显隐
 * ================================================================== */

test('R48-D1 · 「线程并发」卡片必须位于「用户管理」与「负载均衡」之间，且仅管理员可见', () => {
  const html = read('public/index.html');
  const iUser = html.indexOf('id="sysset-user-card"');
  const iConc = html.indexOf('id="sysset-concurrency-card"');
  const iLb = html.indexOf('id="sysset-lb-card"');
  assert(iUser > 0 && iConc > 0 && iLb > 0, '三张卡片都应存在');
  assert(iUser < iConc && iConc < iLb,
    `卡片顺序应为 用户管理 → 线程并发 → 负载均衡（实际索引 ${iUser} / ${iConc} / ${iLb}）`);
  assert(/ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-concurrency-card'[^\]]*\]/.test(readJs('syssettings.js')),
    '「线程并发」必须登记进 ADMIN_ONLY_CARDS —— 否则普通用户也会看到并尝试修改系统级配置');
  assert(/id="conc-files"/.test(html) && /min="1"/.test(html.slice(iConc, iLb)),
    '卡片必须有一个最小值为 1 的文件数输入框（需求：最小为 1）');
});

test('R48-D2 · 「收入统计」卡片必须在订单管理页内，且与付费订单同源渲染', () => {
  const html = read('public/index.html');
  const a = html.indexOf('id="ordermgr"');
  const b = html.indexOf('</section>', a);
  const section = html.slice(a, b);
  assert(/id="revenue-table"/.test(section), '收入统计表格必须位于订单管理区块内');
  assert(/id="revenue-summary"/.test(section), '收入统计应有一个总计标题位');
  const js = stripComments(readJs('ordermgr.js'));
  // ① 调用点层：render() 必须用**同一份** ordersCache 喂收入统计
  assert(/renderRevenue\(ordersCache\)/.test(js),
    '收入统计必须由同一份 ordersCache 渲染 —— 各拉一份数据就会出现「上面统计与下面流水对不上」');
  // ② 渲染函数内部必须委托给 computeRevenue（唯一口径），不得自己再算一遍。
  //    判据落在 renderRevenue 的**函数体**里：只断言「文件里出现过 computeRevenue」
  //    会被它自己的定义行、甚至一句注释满足（都是假绿）。
  const body = bodyOf(js, 'renderRevenue');
  assert(body !== null, '应当存在 renderRevenue() —— 收入统计必须有一个渲染入口');
  assert(/computeRevenue\(/.test(body),
    '收入统计的渲染必须走 computeRevenue()（唯一口径），不得在渲染函数里另写一份算法');
  assert(!/status\s*===\s*['"]paid['"]/.test(body),
    'renderRevenue() 里不得再筛一次 paid —— 那就是第二套口径（与 computeTotals 各算各的经典症状）');
  // ③ 全前端只允许一份收入口径
  const impls = [];
  for (const f of fs.readdirSync(JSDIR)) {
    if (!f.endsWith('.js')) continue;
    if (/function\s+computeRevenue\s*\(/.test(stripComments(readJs(f)))) impls.push(f);
  }
  assertEqual(impls.join(','), 'ordermgr.js',
    'computeRevenue() 必须只有一个实现点 —— 多份实现早晚会在「退款算不算」「改价怎么显示」上分叉');
});

/* ================================================================== *
 * E · 配置的读写与入参校验
 * ================================================================== */

test('R48-E1 · 并发配置的三种输入必须分开处置（「缺失」绝不能当成「非法」）', () => {
  const cfgStore = require(path.join(ROOT, 'server', 'config-store.js'));
  assertEqual(cfgStore.DEFAULT_CONCURRENCY_FILES, 3,
    '新默认值是 3 —— 3 个文件 × 2 个分片 = 6，正好填满浏览器连接预算，同时比原来的 2 更快');

  assertEqual(cfgStore.setConcurrency({ files: 5 }).files, 5, '合法值原样保存');
  assertEqual(cfgStore.setConcurrency({ files: 2.9 }).files, 2, '合法值向下取整');
  assertEqual(cfgStore.setConcurrency({ files: '4' }).files, 4, '表单来的字符串数字应被接受');
  assertEqual(cfgStore.setConcurrency({ files: 0 }).files, 1, '0 是脏值 ⇒ 退到最保守的 1');
  assertEqual(cfgStore.setConcurrency({ files: -3 }).files, 1, '负数同理');
  assertEqual(cfgStore.setConcurrency({ files: 'abc' }).files, 1, '非数字同理');
  assertEqual(cfgStore.setConcurrency({ files: 999 }).files, 16, '超过上界夹到 16');

  /**
   * ⭐ 本条最关键的一句：历史配置里**根本没有 concurrency 这一段**（`undefined`），
   * 它必须落到**新默认值 3**，而不是被当成脏值降到 1。
   *
   * 曾经的写法把「缺失」与「非法」合并，后果是：所有老配置在升级后并发静默降到 1，
   * 用户看到的是「升级之后上传变慢了」，而配置页显示的就是 1 —— 看起来像是自己设的，
   * 极难排查。三种输入必须三条分支。
   */
  assertEqual(cfgStore.setConcurrency({ files: undefined }).files, 3,
    '「缺失」必须与「非法」分开：老配置升级后应拿到新默认值 3，而不是被降到 1（曾踩过）');
  assertEqual(cfgStore.setConcurrency({ files: null }).files, 3, 'null 同「缺失」');
  assertEqual(cfgStore.setConcurrency({ files: '' }).files, 3, '空串同「缺失」（表单未填）');

  // 读：并发上限必须下发给**全部登录用户**（普通用户也要上传，前端调度要用它）
  const view = cfgStore.safeView();
  assert(view && view.concurrency && typeof view.concurrency.files === 'number',
    'safeView() 必须把并发上限下发给所有角色 —— 否则普通用户的前端拿不到上限，只能按串行走');

  assertEqual(cfgStore.setConcurrency({ files: 5 }).files, 5, '改回一个常规值，避免影响同进程内的其它用例');
});

test('R48-E2 · 接口入参非法必须显式拒绝，而不是静默改写成 1', () => {
  const limits = require(path.join(ROOT, 'server', 'limits.js'));
  assertEqual(limits.CONCURRENCY_FILES_MIN, 1, '下界是 1（需求：最小为 1）');
  for (const bad of [0, -1, -3, 'abc', NaN, undefined, null, '', 17, 999]) {
    const r = limits.parseConcurrencyInput(bad);
    assertEqual(r.ok, false,
      `入参 ${JSON.stringify(bad)} 应被显式拒绝（400）—— 静默改写成 1 会让用户以为自己设成功了`);
    assert(typeof r.error === 'string' && r.error.length > 0, '拒绝时必须带上可读的错误原因');
  }
  assertEqual(limits.parseConcurrencyInput(1).value, 1, '最小值 1 合法');
  assertEqual(limits.parseConcurrencyInput('4').value, 4, '字符串数字应被接受（表单序列化的常态）');
  assertEqual(limits.parseConcurrencyInput(limits.CONCURRENCY_FILES_MAX).value, 16, '上界本身合法');
  assertEqual(limits.parseConcurrencyInput(2.9).value, 2, '向下取整');

  // 路由必须**用**这个校验：把入参直接交给 configStore 的归一化函数就等于静默改写
  const src = stripComments(read('server/routes/enc.js'));
  assert(/parseConcurrencyInput\(/.test(src),
    'PUT /concurrency 必须走 parseConcurrencyInput() 校验，不得把原始入参直接交给归一化');
  assert(/router\.put\('\/concurrency',\s*requireAdmin,/.test(src),
    '写入并发数是管理员专属 —— 它决定服务端同时起多少加密线程，属系统级配置');
});
