/**
 * magic（文件头魔数 / 异或密钥流）的**纯计算原语**。
 *
 * ## 为什么单独成一个模块
 *
 * R48 要把 magic 的密钥流计算搬到 `worker_threads`（多线程）。worker 需要一个
 * 可以被安全加载的入口 —— 而 `enc-store.js` 的加载链会拉进 `config-store`
 * （读盘、建密钥文件、排队落盘）与 `atomic-write`，在 worker 线程里重复加载它们
 * 既无必要、又有与主线程争写同一份配置的风险。
 *
 * 因此把「只依赖 `crypto`、无任何副作用、无其它 require」的纯函数下沉到这里：
 *  · 主线程的 `enc-store.js` 直接 require 它（**唯一实现点**，不复制一份算法）；
 *  · worker 线程同样 require 它，于是两条执行路径跑的是同一段代码。
 *
 * ## 与 `enc-store.js` 的分工
 *
 * 本模块**不认识**主密钥：`key` 一律由调用方显式传入。`enc-store.js` 保留一层
 * 「取主密钥再调用」的薄包装（`xorBuf` / `fillKeystream`），其对外契约与历史完全一致
 * ——`tests/audit-regressions.test.js` 的 PERF-03 差分用例仍按旧签名直接驱动它们。
 */

const crypto = require('crypto');

/**
 * 生成从 `startBlock` 起的 `blocks` 个密钥流块（每块 32 字节）。
 *
 * 块 i = SHA256(主密钥 ‖ 盐 ‖ u32be(i)) —— 是**位置函数**，不依赖任何会话状态，
 * 因此分片上传的任意一片都能独立算出自己那一段密钥流。
 */
function fillKeystream(key, saltBuf, startBlock, blocks) {
  const out = Buffer.alloc(blocks * 32);
  const w = Buffer.alloc(4);
  for (let i = 0; i < blocks; i++) {
    const b = startBlock + i;
    w[0] = (b >>> 24) & 0xff; w[1] = (b >>> 16) & 0xff; w[2] = (b >>> 8) & 0xff; w[3] = b & 0xff;
    crypto.createHash('sha256').update(key).update(saltBuf).update(w).digest()
      .copy(out, i * 32);
  }
  return out;
}

/**
 * 生成覆盖原文偏移 `[offset, offset+length)` 的密钥流（长度 = length）。
 *
 * 与 `xorBuf` 的区别：本函数一次性产出整段密钥流，适合长度已知且不大的场景；
 * `xorBuf` 走 64KB 窗口、就地消耗，峰值内存恒定（PERF-03）。
 */
function xorKeystream(key, offset, length, salt) {
  const out = Buffer.alloc(length);
  if (!length) return out;
  const startBlock = Math.floor(offset / 32);
  const endBlock = Math.floor((offset + length - 1) / 32);
  const stream = Buffer.alloc((endBlock - startBlock + 1) * 32);
  for (let b = startBlock; b <= endBlock; b++) {
    const h = crypto.createHash('sha256')
      .update(key)
      .update(salt || Buffer.alloc(0))
      .update(Buffer.from([(b >>> 24) & 0xff, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff]))
      .digest();
    h.copy(stream, (b - startBlock) * 32);
  }
  stream.copy(out, 0, offset - startBlock * 32, offset - startBlock * 32 + length);
  return out;
}

/**
 * 异或（原地 + 返回同一 Buffer）。`offset` 是这段数据在**整个原文件**中的偏移。
 *
 * 性能要点（PERF-03，与历史实现逐字节兼容）：
 *  1. 按 32 位（4 字节）字循环而非逐字节 —— 循环次数降为 1/4，且
 *     `readUInt32BE`/`writeUInt32BE` 为原生实现；
 *  2. 密钥流**逐块生成、就地消耗**，不一次性分配与明文等长的缓冲；
 *  3. 窗口大小按需取小：固定 2048 块（64KB）时，一个 4 字节的调用也要算
 *     2048 次 SHA-256（实测 3.4ms/次），小缓冲场景会被放大成数十秒级退化。
 *
 * 尾部不足 4 字节的部分按字节处理，保证任意长度正确。
 */
function xorBufWithKey(key, buf, offset, salt) {
  const n = buf.length;
  if (!n) return buf;
  const saltBuf = salt || Buffer.alloc(0);

  const WINDOW_MAX_BLOCKS = 2048; // 上限：64KB 窗口，限制峰值内存
  let block = Math.floor(offset / 32);
  // +2：① 一个 4 字节字可能跨越块边界（pos%32 ∈ [29,31]）需读到下一块；
  //     ② offset 非 32 对齐时首块只用到一部分，尾块同理。
  const needBlocks = Math.ceil(n / 32) + 2;
  const winBlocks = Math.min(WINDOW_MAX_BLOCKS, needBlocks);
  let windowStart = block;
  let stream = fillKeystream(key, saltBuf, windowStart, winBlocks);

  const ensureBlock = (b) => {
    if (b >= windowStart && b + 1 < windowStart + winBlocks) return;
    windowStart = b;
    stream = fillKeystream(key, saltBuf, windowStart, winBlocks);
  };

  const words = n >>> 2; // 完整的 4 字节字数
  for (let i = 0; i < words; i++) {
    const p = i << 2;
    const pos = offset + p;
    const b = Math.floor(pos / 32);
    ensureBlock(b);
    const sOff = (b - windowStart) * 32 + (pos - b * 32);
    buf.writeUInt32BE((buf.readUInt32BE(p) ^ stream.readUInt32BE(sOff)) >>> 0, p);
  }
  for (let i = words << 2; i < n; i++) {
    const pos = offset + i;
    const b = Math.floor(pos / 32);
    ensureBlock(b);
    buf[i] ^= stream[(b - windowStart) * 32 + (pos - b * 32)];
  }
  return buf;
}

module.exports = { fillKeystream, xorKeystream, xorBufWithKey };
