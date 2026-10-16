/**
 * 加密 worker 线程池（R48「多线程」）。
 *
 * ## 解决的是什么
 *
 * 本项目的加密有三种模式（见 `enc-store.js`）：`none` / `crypto`(AES-256-GCM) /
 * `magic`(文件头魔数 + 异或密钥流)。其中 **magic 的密钥流是纯 JS 实现**，每 32 字节
 * 做一次 SHA-256，实测吞吐仅 ~15MB/s，且 `encryptBuffer` / `encryptPart` 都是**同步**
 * 函数、直接在请求处理里调用 —— 一个 5MB 分片就要占住事件循环约 330ms，10MB 约 848ms。
 * 期间该进程上**所有**其它请求（别人的下载、WebDAV、健康检查）一起冻结。
 * 多路并发上传时这些阻塞还会叠加。
 *
 * 本模块把这部分 CPU 计算搬到 `worker_threads`：主线程只做 I/O 编排，加密在多个
 * 工作线程上真正并行到多核。这是可行性报告 §四「方案 C」的落地，而**不是** cluster
 * —— 报告 §三已论证 cluster 与本项目「单实例 + 进程内会话/锁/缓存」的架构根本冲突。
 *
 * ## 三条设计约定（都为了「不改变既有行为」）
 *
 * 1. **同一个实现，两个执行位置。** 任务函数 `runJob()` 在主线程与 worker 线程里是
 *    **同一段代码**（都 require `./enc-xor`）。没有「worker 版算法」这种东西 ——
 *    否则两条路径迟早分叉，而分叉的表现是「加密结果不一致」，属于不可逆的数据损坏。
 * 2. **永远有同步兜底。** 池未配置 / 被环境变量关闭 / 队列已满 / 线程异常，任何一条
 *    成立都退回主线程同步执行（`execLocal`）。两条路径的输出**逐字节相同**，
 *    且 AES 的 IV、magic 的盐都由调用方传入 ⇒ 任务是**确定性**的，重算安全。
 * 3. **小负载不走线程。** 低于 `MIN_WORKER_BYTES` 的负载，线程往返 + 两次结构化克隆
 *    的开销超过它省下的阻塞时间（64KB 的 magic 只需 ~4ms），直接在主线程算。
 *
 * ## 环境变量
 *
 * `ENCODER_WORKERS=0` 关闭多线程（强制主线程同步执行）。测试沙箱、单核机器或
 * 排障时可用；读取发生在**每次调用**，不是模块加载时 —— 否则进程内改不了。
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort } = require('worker_threads');

/** 线程数硬上限：再多也不会更快（magic 是内存带宽 + SHA-256 混合负载），只会加内存 */
const HARD_MAX_WORKERS = 8;
/** 低于此长度的负载在主线程直接算（省掉线程往返与两次克隆） */
const MIN_WORKER_BYTES = 512 * 1024;
/** worker 入口就是本文件（`!isMainThread` 时走下面的 worker 分支） */
const WORKER_FILE = path.join(__dirname, 'enc-pool.js');

/* ============================ 任务实现（两条路径共用） ============================ */

/**
 * 执行一个加密任务。**不看自己在哪个线程里** —— 主线程与 worker 都调它。
 *
 * @param {object} job
 *   - `op:'xor'`      `{ keyHex, saltHex, offset, buf }` → `{ buf }`
 *   - `op:'aes-seal'` `{ keyHex, ivHex, buf }`           → `{ ct, tag }`
 * @returns {object} 结果（内含 Buffer）
 */
function runJob(job) {
  const XOR = require('./enc-xor');
  const key = Buffer.from(job.keyHex, 'hex');
  const buf = bufOf(job.buf);
  if (job.op === 'xor') {
    const salt = job.saltHex ? Buffer.from(job.saltHex, 'hex') : null;
    // 不再拷一份：worker 路径拿到的本来就是克隆、改它不影响调用方；本地兜底路径
    // 就地修改与同步版 `xorBuf` 的行为一致（调用方一律使用返回值）。
    return { buf: XOR.xorBufWithKey(key, buf, job.offset || 0, salt) };
  }
  if (job.op === 'aes-seal') {
    const iv = Buffer.from(job.ivHex, 'hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    return { ct, tag: cipher.getAuthTag() };
  }
  throw new Error('未知的加密任务类型：' + job.op);
}

/** 把结构化克隆回来的 Uint8Array 视作 Buffer（不复制：只建视图） */
function bufOf(u8) {
  if (Buffer.isBuffer(u8)) return u8;
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/* ============================ worker 侧 ============================ */

if (!isMainThread) {
  parentPort.on('message', (job) => {
    try {
      const result = runJob(job);
      parentPort.postMessage({ id: job.id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id: job.id, ok: false, error: String((e && e.message) || e) });
    }
  });
}

/* ============================ 主线程侧：池 ============================ */

/** 是否被环境变量强制关闭（**每次调用都读**，便于测试与排障时切换） */
function disabled() { return process.env.ENCODER_WORKERS === '0'; }

/** 可用的 CPU 预算：留一个核给主线程 I/O 编排 */
function cpuBudget() {
  const n = (os.cpus() || []).length;
  return Math.max(1, n - 1);
}

/** 把用户填的并发数收敛到 [1, min(HARD_MAX_WORKERS, CPU 预算)] */
function normalizeSize(n) {
  const v = Math.max(1, Math.floor(Number(n) || 1));
  return Math.min(v, HARD_MAX_WORKERS, cpuBudget());
}

let slots = [];       // [{ w, current }] —— current 非空表示该线程正忙
let queue = [];       // 等待空闲线程的任务
let targetN = 0;      // 目标线程数（configure 决定）；0 = 尚未配置 ⇒ 走同步
let degraded = false; // 线程出过错 ⇒ 整体退回主线程（fail-safe，不再重试）
let seq = 0;

/** 当前目标线程数 */
function size() { return targetN; }

/** 池当前是否可用（可用 ≠ 一定走线程：还要看负载大小与队列） */
function enabled() { return !disabled() && !degraded && targetN >= 1; }

/**
 * 按「同时加密的处理单元数」配置池大小（幂等）。
 *
 * 由调用方在每次发起加密前带着**当前配置值**调用：值没变就什么都不做，
 * 变了才重建线程（重建时在途任务会同步重算，见 `drainLocally`）。
 *
 * @param {number} n 期望并发数（= 系统设置「线程并发」卡片里的值）
 * @returns {number} 实际生效的线程数（0 = 关闭）
 */
function configure(n) {
  if (disabled() || degraded) return 0;
  const want = normalizeSize(n);
  if (want === targetN) return targetN;
  drainLocally();       // 重建前先把在途/排队任务在主线程算完，绝不丢任务
  closeAll();
  targetN = want;
  return targetN;
}

/** 关闭全部线程（不处理在途任务 —— 调用方负责先 drainLocally） */
function closeAll() {
  for (const s of slots) {
    // 必须先摘监听器：`terminate()` 会让 worker 以非 0 码退出，若不摘，
    // `exit` 处理器会把这次**主动关闭**误判成线程崩溃，进而 degrade 掉整个池。
    try { s.w.removeAllListeners(); } catch (e) { /* 老版本没有该方法 */ }
    try { s.w.terminate(); } catch (e) { /* 已退出 */ }
  }
  slots = [];
}

/** 整体退回主线程：在途与排队任务全部就地算完，之后不再新建线程 */
function degrade(err) {
  if (!degraded) {
    degraded = true;
    targetN = 0;
    // 这里的日志不能走 statsStore（本模块要被 worker 线程加载，不引入多余依赖）
    console.error('[enc-pool] 加密工作线程不可用，已退回主线程同步加密：', (err && err.message) || err);
  }
  drainLocally();
  closeAll();
}

/**
 * 把在途与排队任务在主线程算完。
 *
 * 之所以能这样做：任务全是**确定性**的（key / salt / iv 都由调用方给定），
 * 重算得到的字节与线程里算出来的完全一致 —— 不会出现「换了个人算结果不同」。
 */
function drainLocally() {
  const pending = [];
  for (const s of slots) {
    if (s.current) { pending.push(s.current); s.current = null; }
  }
  pending.push(...queue.splice(0, queue.length));
  for (const item of pending) {
    try { item.resolve(execLocal(item.job)); }
    catch (e) { item.reject(e); }
  }
}

/** 主线程同步执行（与 worker 里跑的是同一个 `runJob`） */
function execLocal(job) { return runJob(job); }

function maxQueue() { return Math.max(4, size() * 4); }

function freeSlot() { return slots.find((s) => !s.current) || null; }

function spawnSlot() {
  const w = new Worker(WORKER_FILE, { workerData: { role: 'enc-worker' } });
  const slot = { w, current: null };
  w.on('message', (m) => onReply(slot, m));
  w.on('error', (e) => degrade(e));
  w.on('exit', (code) => { if (code !== 0 && !degraded) degrade(new Error('加密工作线程异常退出（code ' + code + '）')); });
  slots.push(slot);
  // 池不应阻止进程退出（有空闲线程时 unref；有活干时由 syncRef() 重新 ref）
  try { w.unref(); } catch (e) { /* 老版本无该方法 */ }
  return slot;
}

function runOn(slot, job) {
  return new Promise((resolve, reject) => {
    job.id = ++seq;
    slot.current = { job, resolve, reject };
    try {
      slot.w.postMessage(job);
    } catch (e) {
      // 送不出去（线程正在退出等）：主线程算一遍，结果同样正确
      slot.current = null;
      try { resolve(execLocal(job)); } catch (e2) { reject(e2); }
    }
    syncRef();
  });
}

/**
 * 维持「有活干就 ref、空闲就 unref」。
 *
 * `unref()` 是必须的：一个被 ref 的工作线程会让**任何**加载了本模块的进程无法退出
 * （脚本、测试、一次性命令都会挂住）。但只 unref 又是错的 —— 线程一旦 unref，
 * 事件循环就不再看它，`await pool.xorBuf(...)` 会**在任务完成前**让进程悄悄退出
 * （退出码 0，什么错都不报，只是结果丢了）。故按「是否有在途/排队任务」动态切换。
 */
function syncRef() {
  const busy = queue.length > 0 || slots.some((s) => s.current);
  for (const s of slots) {
    const fn = busy ? s.w.ref : s.w.unref;
    try { if (typeof fn === 'function') fn.call(s.w); } catch (e) { /* 已退出 */ }
  }
}

function onReply(slot, m) {
  const cur = slot.current;
  if (!cur || !m || m.id !== cur.job.id) return; // 陈旧/重复回包：忽略
  slot.current = null;
  if (m.ok) cur.resolve(m.result);
  else cur.reject(new Error(m.error || '加密工作线程执行失败'));
  pumpQueue();
  syncRef();
}

function pumpQueue() {
  while (queue.length) {
    const slot = freeSlot();
    if (!slot) return;
    const item = queue.shift();
    runOn(slot, item.job).then(item.resolve, item.reject);
  }
}

/**
 * 提交任务。
 *
 * @returns {Promise<object>|null} `null` = **本次不走多线程**，调用方须自行在主线程
 *   同步执行（池未配置/已关闭、负载太小、队列已满）。返回 null 而不是「排在队里
 *   无限等」，是为了给出明确的内存上界：队列满时宁可当场算完，也不让一堆
 *   64MB 的密文副本排着队等。
 */
function submit(job) {
  if (!enabled()) return null;
  if (!job.buf || job.buf.length < MIN_WORKER_BYTES) return null;
  let slot = freeSlot();
  if (!slot && slots.length < targetN) slot = spawnSlot();
  if (slot) return runOn(slot, job);
  if (queue.length >= maxQueue()) return null;
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); });
}

async function viaPoolOrLocal(job, shape) {
  const p = submit(job);
  if (!p) return shape(execLocal(job));
  try {
    return shape(await p);
  } catch (e) {
    // 单次任务失败也必须能出结果（否则一次线程抖动就会毁掉一次上传）
    degrade(e);
    return shape(execLocal(job));
  }
}

/* ============================ 对外接口 ============================ */

/**
 * 异或密钥流（magic）。与 `enc-xor.xorBufWithKey` 同结果，只是可能跑在工作线程上。
 *
 * 注意参数顺序与 `enc-xor.xorBufWithKey(key, buf, offset, salt)` 不同：这里
 * `key` 放最后，因为执行器的接口签名是「先数据后凭据」（见 `enc-store` 的执行器约定）。
 *
 * ⚠️ 与同步版的一处**契约差异**：同步版就地修改并返回入参 Buffer；本函数返回
 * 一个**新的** Buffer，入参不被改动（worker 拿到的是克隆）。调用方必须使用返回值。
 *
 * @returns {Promise<Buffer>}
 */
function xor(buf, offset, salt, key) {
  return viaPoolOrLocal(
    { op: 'xor', keyHex: key.toString('hex'), saltHex: salt ? salt.toString('hex') : '', offset, buf },
    (r) => bufOf(r.buf),
  );
}

/**
 * AES-256-GCM 封装（crypto 模式）。IV 由调用方生成后传入 —— 这样两个执行位置
 * 得到的是同一份结果，差分护栏才有确定的比较基准。
 *
 * @returns {Promise<{ct: Buffer, tag: Buffer}>}
 */
function aesSeal(key, iv, buf) {
  return viaPoolOrLocal(
    { op: 'aes-seal', keyHex: key.toString('hex'), ivHex: iv.toString('hex'), buf },
    (r) => ({ ct: bufOf(r.ct), tag: bufOf(r.tag) }),
  );
}

/** 进程退出路径：结束全部线程（在途任务就地算完后返回） */
function shutdown() {
  drainLocally();
  closeAll();
  targetN = 0;
}

/** 诊断信息（护栏与排障用；不含任何密钥材料） */
function stats() {
  return {
    enabled: enabled(), size: size(), workers: slots.length,
    busy: slots.filter((s) => s.current).length, queued: queue.length,
    degraded, cpuBudget: cpuBudget(), minBytes: MIN_WORKER_BYTES,
  };
}

/** 仅供测试：把模块恢复到「刚加载」的状态（不触碰环境变量） */
function _resetForTest() {
  drainLocally();
  closeAll();
  targetN = 0;
  degraded = false;
  seq = 0;
}

module.exports = {
  HARD_MAX_WORKERS, MIN_WORKER_BYTES,
  configure, size, enabled, disabled,
  xor, aesSeal, shutdown, stats,
  _resetForTest,
};
