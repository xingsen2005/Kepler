/**
 * 统一下载流转发 —— /fs/download 与分享下载共用
 * 封装响应头设置、对象存储流管道、解密、流量统计、超时与背压。
 * 调用方负责：鉴权、令牌校验、日志、错误响应。
 */
const { PassThrough, pipeline } = require('stream');
const encStore = require('./enc-store');
const { p } = require('./s3');
// R51：计量环节抽成唯一实现点 —— 分享打包下载（share-bundle.js）是另一条独立的下发
// 管线，两边必须给出同一个「今天下了多少字节」的口径，各自内联一份必然分叉。
const { createTrafficMeter } = require('./traffic-meter');
const { attachmentDisposition } = require('./attachment-name');

/** 下载类响应超时（无数据活动时）：10 分钟（P7） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 将对象存储对象流式转发到 HTTP 响应（可选透明解密、可选限速），含流量统计/背压/超时。
 * @param {object} params
 *  - s3: 对象存储客户端
 *  - bucket, region, key
 *  - fileName: 用于 Content-Disposition 的文件名
 *  - encMeta: 可选加密元数据（null 表示明文）
 *  - req, res: Express 请求/响应
 *  - traffic: { bytesDown } 统计对象
 *  - [throttle]: R37 限速 Transform（`throttle.createThrottleTransform()` 的产物；
 *                `null` = 不限速）。**必须由调用方先解析出生效限速**（见 `throttle.resolveLimit`），
 *                本函数不做任何限速判定 —— 判定只有一处，就在这里挂载。
 *  - [timeoutMs]: 默认 10 分钟
 */
async function streamDownload({ s3, bucket, region, key, fileName, encMeta, req, res, traffic, throttle, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const head = await p(s3, 'headObject', { Bucket: bucket, Region: region, Key: key });
  const size = Number(head.headers['content-length']) || 0;
  const contentType = head.headers['content-type'] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', encMeta ? encMeta.origSize : size);
  // R51：头的拼装（含防响应头注入的转义）收敛到唯一实现点，与打包下载共用
  res.setHeader('Content-Disposition', attachmentDisposition(fileName));

  const out = encMeta ? encStore.decryptTransform(encMeta) : new PassThrough();

  /* ---- 流量计量 Transform（同时修复 PERF-06 与 PERF-09） ----
   *
   * 旧实现在 PassThrough 上挂 `data` 监听做统计，随后又用 `pipeline(out, res)`
   * 注册第二个消费者 —— 两条消费路径并存，`out.on('error')`、`pipeline` 回调、
   * `res.on('close')` 三处都在销毁流，既有重复销毁风险，也让背压行为难以推理。
   *
   * 改为显式 Transform：统计与转发统一在一条管线中，销毁也收敛为单点。
   * R51：这个 Transform 的**实现**已抽到 `server/traffic-meter.js`（唯一实现点），
   * 分享打包下载与之共用 —— 本文件只负责把它接在哪一格。
   */
  const meter = createTrafficMeter({ bucket, traffic });

  // 统一销毁：管道任一环节结束/出错都走到这里，且 destroy 本身幂等
  const teardown = (() => {
    let done = false;
    return (err) => {
      if (done) return;
      done = true;
      try { out.destroy(); } catch (e) { /* ignore */ }
      // R37：限速环节同样要销毁，否则它内部的节拍定时器会一直留着（见 throttle.js）
      if (throttle) { try { throttle.destroy(); } catch (e) { /* ignore */ } }
      if (err) { try { res.destroy(); } catch (e) { /* ignore */ } }
    };
  })();

  /**
   * R37：限速环节插在**解密之后、统计之前**。
   *
   * - 放在 `out`（解密流）之后 ⇒ 令牌桶数的是**明文字节**，与用户看到的
   *   「已下载 xx MB / 限速 xx MB/s」同一口径。若放在解密之前，加密对象的
   *   （略大的）密文字节会被计费，用户算不平 —— 这是要求④明确选定的口径。
   * - 放在 `meter` 之前 ⇒ `traffic.bytesDown` 与 `statsStore` 的计数口径与限速**无关**，
   *   加不加限速都得到同一个总量（限速只改变到达时间，不改变字节数）。
   * - 三者同在**一条** `pipeline` 里：背压沿 `res ← meter ← throttle ← out` 逐级向上
   *   传导，不另挂 `data` 监听（要求②）。
   */
  const stages = throttle ? [out, throttle, meter, res] : [out, meter, res];
  pipeline(...stages, (err) => teardown(err));
  res.on('close', () => teardown(null));
  out.on('error', () => teardown(null));

  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs, () => teardown(null));

  /**
   * R94（审核 M06-03）：这里原先是回调式直接调 `s3.getObject(...)`，绕过了
   * `s3.p()` —— 而 `p()` 挂着两件事：`assertScoped()`（R89 的越权兜底判据）与
   * 按桶请求计数。下载是**最敏感的数据通路**，恰恰成了唯一没有第二道防线的出口；
   * 下载产生的 `getObject` 也从不计入按桶统计。同文件顶部已经用 `p()` 做 HEAD，
   * 正文却绕开它，属于「同类调用两种写法」。
   *
   * `p()` 是把 `params` 原样交给 `s3[method]` 的，`Output` 流照传，语义不变。
   */
  await p(s3, 'getObject', { Bucket: bucket, Region: region, Key: key, Output: out });
}

module.exports = { streamDownload, DOWNLOAD_TIMEOUT_MS };
