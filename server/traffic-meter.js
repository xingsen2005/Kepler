/**
 * 下发字节的统计计量环节 —— **唯一实现点**。
 *
 * 为什么单独成一个模块：R37 起，主站下载（`download-stream.js`）与分享打包下载
 * （`share-bundle.js`）是两条**独立的**下发管线，但它们必须给出**同一个**口径的
 * 「今天下载了多少字节」—— 若各自内联一份 Transform，两边迟早分叉（一边按明文计、
 * 一边按压缩后计，或一边逐 chunk 上报、一边汇总上报），而统计页上的数字不会自己解释。
 *
 * 语义（PERF-06 定下、两条管线共用）：
 *
 *  · **按固定时间间隔汇总上报**，而不是逐 chunk 触碰 `statsStore`。
 *    旧实现每个 chunk 都调 `sampleTraffic()` + `trackBucket()`，后者内部会 `persist()`
 *    （把整个 stats 对象 JSON 序列化并原子写盘）。以 64KB chunk、10MB/s 计算约为
 *    **每秒 160 次「改内存 + 标记脏」**，大文件下载累计成千上万次 ——
 *    高带宽时段 CPU 明显被统计逻辑吃掉，写盘次数与实际数据量严重不成比例。
 *    现在 chunk 级只在**局部**累加（一次整数加法），仅在时间间隔到达或流结束时
 *    才真正触碰 `statsStore`。
 *
 *  · `traffic.bytesDown` **精确定义为「经过本环节的字节数」**，且与上报给
 *    `statsStore` 的数字**逐字节相等**（有护栏钉住）。调用方在管线里把它放在哪一格，
 *    就决定这个数是明文还是压缩后的 —— 这是刻意的：限速环节与它的相对位置由调用方
 *    决定并各自有注释说明（见 `download-stream.js` 的 `stages` 与
 *    `share-bundle.js` 的管线注释）。
 *
 * ⚠️ 必须用**属性访问**调用 `statsStore.sampleTraffic` / `trackBucket`：护栏会就地
 * 替换这两个方法（`tests/audit-regressions.test.js` 的 PERF-06 用例），解构赋值会让
 * 替换失效、并让那条用例静默变成「什么都没测」。
 */
const { Transform } = require('stream');
const statsStore = require('./stats-store');

/** 统计汇总间隔（毫秒）。1 秒足够平滑，且把写盘次数压到与数据量无关的量级。 */
const STATS_FLUSH_MS = 1000;

/**
 * 构造计量 Transform。
 * @param {object} params
 *  - bucket: 用于按桶归集（`statsStore.trackBucket`）
 *  - [traffic]: 调用方的计数对象，本环节会把字节数累加进它的 `bytesDown`
 *  - [intervalMs]: 汇总间隔，默认 {@link STATS_FLUSH_MS}（测试可调小以观察行为）
 * @returns {Transform}
 */
function createTrafficMeter({ bucket, traffic, intervalMs = STATS_FLUSH_MS } = {}) {
  let pendingBytes = 0;
  let lastFlushAt = Date.now();

  function flushTraffic(n) {
    if (!n) return;
    statsStore.sampleTraffic(0, n);
    statsStore.trackBucket(bucket, { down: n });
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      pendingBytes += chunk.length;
      if (traffic) traffic.bytesDown += chunk.length; // 供调用方在结束后读取总数
      const now = Date.now();
      if (now - lastFlushAt >= intervalMs) {
        lastFlushAt = now;
        flushTraffic(pendingBytes);
        pendingBytes = 0;
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      flushTraffic(pendingBytes); // 收尾：清算残余计数，避免尾部字节丢失
      pendingBytes = 0;
      cb();
    },
  });
}

module.exports = { createTrafficMeter, STATS_FLUSH_MS };
