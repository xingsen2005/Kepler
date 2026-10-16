/**
 * 分享包（`.tar.gz`）的流式下发 —— 需求「多文件 / 文件夹分享，可勾选要下载的文件」
 * 的落地实现。
 *
 * ## 为什么是"流式"而不是"先打包到临时文件"
 *
 * 分享的内容可以很大（一个文件夹快照上限 2000 个对象）。先落盘再发送需要一次完整的
 * 磁盘往返、两倍空间、并且在打包完成前用户看不到任何进度；而 Node 的流天然支持
 * 「读一个对象 → 写进归档 → 再读下一个」，内存占用只与单个 chunk 有关。
 *
 * ## 管线（从左到右）
 *
 * ```
 *   getObject/解密  →  tar 字节  →  gzip  →  [限速]  →  计量  →  res
 * ```
 *
 * ⚠️ **计量环节的位置与单文件下载刻意不同**，且这一差异是有意的：
 *  · `download-stream.js` 里计量在**限速之后、解密之后**，数的是**明文字节**
 *    （用户看到的「已下载 xx MB」与令牌桶是同一口径）；
 *  · 这里是打包下载，用户拿到的是**压缩后的字节流**，明文总量既不可见也无意义
 *    （一个 2000 文件的小文本夹，明文能到几百 MB 而实际下发只有几 MB）。
 *    因此计量放在 gzip **之后**，与 `Content-Length` 缺失（chunked）时的实际下发量一致。
 *
 * ## 三处"宁可中止也不产出坏包"的取舍
 *
 * 1. **归档头必须声明真实长度，且必须与后续写入的字节数一致**。tar 的条目长度写在
 *    头里，一旦实际内容比声明短，解包工具会把**下一个文件的头**当成内容读走，
 *    产出一个"能解开但内容是垃圾"的包；比声明长则会连带破坏后面所有条目。
 *    故这里逐条目核对写入字节数，**两个方向都直接中止**（见下方 `written !== size`）。
 *    一开始我按"短了就补零"处理，探针立刻暴露出它的问题：补零要 `Buffer.alloc(gap)`，
 *    而 gap 的上界就是对象大小 —— head 之后对象被换成小对象，就会为一次失败的下发
 *    申请几个 GB 的内存；即便侥幸分配成功，用户拿到的也是一个"长度对、尾巴是零"的
 *    坏文件，而且它**能通过解包**、不会报任何错。中止是唯一诚实的处理。
 * 2. **长度在打开流之前重新 head 一次**，不用创建时的快照值 —— 对象被覆盖过之后，
 *    快照大小只是一个历史事实，拿它当 tar 头的 `size` 必然错位。
 * 3. **单个对象不存在时跳过它**（记进 `skipped` 并由调用方写日志），而不是让整包失败：
 *    一条分享里 2000 个对象，其中一个被删掉就整包下不了，对用户是净损失。
 *
 * ## 与调用方的分工（「空选择」为什么是 404、「全都没了」为什么不是）
 *
 *  · **选择里一个文件都没有**（空文件夹、或快照里本就没有文件）由调用方在**开流之前**
 *    判掉并给 404 —— 那种情形连一级目录都不该下发。
 *  · 而「选择里有文件、但它们创建后都被删了」只有在逐个 head 之后才知道，那时响应头
 *    已经发出、无法改成 404；为此在开流前多打一遍 head，代价是最多 2000 次额外云端
 *    往返。故那种情形下发一个**只含一级目录**的合法归档，并由调用方写 warn 日志
 *    （口径由 `tests/audit51-regressions.test.js` 的用例钉住，避免它悄悄漂移成空响应体）。
 *  · 本模块不做任何 HTTP 状态决策，也不碰 `statsStore` 之外的全局状态。
 */
const zlib = require('zlib');
const { pipeline } = require('stream');
const tar = require('./tar');
const { createTrafficMeter } = require('./traffic-meter');
const { attachmentDisposition } = require('./attachment-name');

/** 无数据活动时的超时：10 分钟（与单文件下载同一口径） */
const BUNDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 往目标流写一块，必要时等待 drain（背压）。
 *
 * ⚠️ 不能只写 `dest.write(buf)` 就返回：`res` 的缓冲满了以后 write 返回 false，
 * 继续写会把整包堆在内存里 —— 大文件夹正是最容易触发的情形。
 * 同时必须同时监听 `close`，否则客户端中途取消时这个 await 会永远挂着
 * （`res` 已销毁、`drain` 永远不会来），请求就此泄漏。
 */
function writeBlock(dest, buf) {
  return new Promise((resolve, reject) => {
    if (!buf || !buf.length) return resolve();
    if (dest.destroyed) return reject(new Error('response destroyed'));
    if (dest.write(buf)) return resolve();
    const cleanup = () => {
      dest.removeListener('drain', onDrain);
      dest.removeListener('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('response closed')); };
    dest.once('drain', onDrain);
    dest.once('close', onClose);
  });
}

/** 秒级时间戳（tar 的 mtime 字段） */
function toEpochSeconds(v) {
  if (!v) return 0;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.floor(t / 1000)) : 0;
}

/**
 * @param {object} o
 *  - entries: [{ name, key, dir }]  归档内相对路径（不含 base 前缀）+ 对象 key
 *  - res: Express 响应
 *  - openFile: `async (entry) => ({ stream, size, mtime }) | null`
 *      调用方负责 headObject / 解密 / 加密元数据；返回 null 表示这个对象取不到（跳过）
 *  - bucket: 统计归集用
 *  - archiveName: 下载文件名（含 `.tar.gz` 由调用方决定，这里原样使用）
 *  - [archiveBase]: 归档内的一级目录名（括号里的这层能防止解包时把一堆文件
 *      直接倒进用户当前目录）；默认取 archiveName 去掉扩展名
 *  - [throttle]: 限速 Transform（可选，由调用方解析出生效限速后传入）
 *  - [traffic]: `{ bytesDown }` 计数对象
 *  - [timeoutMs]
 * @returns {Promise<{files:number, dirs:number, skipped:number, bytes:number}>}
 */
async function streamBundle({
  entries, res, openFile, bucket, archiveName, archiveBase,
  throttle = null, traffic = null, timeoutMs = BUNDLE_TIMEOUT_MS,
}) {
  const list = Array.isArray(entries) ? entries : [];
  const zipName = String(archiveName || 'share.tar.gz');
  const base = tar.safeName(archiveBase === undefined
    ? zipName.replace(/\.tar\.gz$/i, '')
    : archiveBase);

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', attachmentDisposition(zipName));
  // 长度未知（chunked）：刻意**不**声明 Content-Length。压缩后的字节数无法预知，
  // 猜一个会让浏览器提前判定下载完成并截断文件。
  res.setHeader('Cache-Control', 'no-store');
  if (res.setTimeout) res.setTimeout(timeoutMs, () => { try { res.destroy(); } catch (e) { /* ignore */ } });

  const gzip = zlib.createGzip();
  const meter = createTrafficMeter({ bucket, traffic });
  const stages = throttle ? [gzip, throttle, meter, res] : [gzip, meter, res];

  let pipelineErr = null;
  const finished = new Promise((resolve) => {
    pipeline(...stages, (err) => { pipelineErr = err || null; resolve(); });
  });

  const stats = { files: 0, dirs: 0, skipped: 0, bytes: 0 };
  const t0 = Math.floor(Date.now() / 1000);
  const fail = new Error('打包下载中止');

  try {
    if (base) {
      await writeBlock(gzip, Buffer.concat(tar.entryBlocks(base, { dir: true, mtime: t0 })));
      stats.dirs += 1;
    }

    for (const e of list) {
      const rel = String(e && e.name ? e.name : '');
      const inArchive = base ? base + '/' + rel : rel;

      if (e && e.dir) {
        await writeBlock(gzip, Buffer.concat(tar.entryBlocks(inArchive, { dir: true, mtime: t0 })));
        stats.dirs += 1;
        continue;
      }

      const opened = await openFile(e);
      if (!opened || !opened.stream) { stats.skipped += 1; continue; }
      const size = Number(opened.size) || 0;
      const mtime = toEpochSeconds(opened.mtime) || t0;

      await writeBlock(gzip, Buffer.concat(tar.entryBlocks(inArchive, { size, mtime })));
      let written = 0;
      for await (const chunk of opened.stream) {
        written += chunk.length;
        await writeBlock(gzip, chunk);
      }
      // 声明长度与实际下发字节必须相等。两个方向都中止：
      //  · 少了 → 解包工具会把下一个文件头当内容读，产出一个"能解开但内容是垃圾"的包；
      //  · 多了 → 多出来的字节已经写进流里，无法回退，后面所有条目都会错位。
      // 不用补零"救"前者：那会申请 size 量级的内存，且用户拿到的是能通过解包的坏文件。
      if (written !== size) throw fail;
      await writeBlock(gzip, tar.padding(size));
      stats.files += 1;
    }

    await writeBlock(gzip, tar.endBlocks());
    gzip.end();
    await finished;
  } catch (err) {
    try { gzip.destroy(); } catch (e) { /* ignore */ }
    if (throttle) { try { throttle.destroy(); } catch (e) { /* ignore */ } }
    try { res.destroy(); } catch (e) { /* ignore */ }
    // 管线自身的错误（客户端取消 / 网络断开）优先于我们抛出的中止信号：
    // 前者是常态，不该被当成服务端故障上报。
    throw pipelineErr || err;
  }

  if (pipelineErr) throw pipelineErr;
  stats.bytes = traffic ? traffic.bytesDown : 0;
  return stats;
}

module.exports = { streamBundle, BUNDLE_TIMEOUT_MS };
