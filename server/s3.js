/**
 * 存储客户端封装 —— 按服务商创建客户端，统一错误翻译与请求统计埋点
 *
 *  **全部厂商都走 S3 兼容协议**（见 s3-client.js），Azure Blob 因其鉴权协议
 *  （Shared Key + Block Blob 语义）独立实现（见 azure-client.js）。
 *
 * R49：腾讯云原先走 `cos-nodejs-sdk-v5`（COS 原生协议），该分支与其依赖已整体移除 ——
 * 腾讯云与其他厂商共用**同一条** S3 代码路径。这样做换来的是：只剩一套复制 / 分片 /
 * 元数据 / 错误翻译实现（此前 COS 与 S3 各有一套，任何一处修复都要写两遍，漏一处
 * 就表现为「腾讯云上正常、别的厂商上不对」或反过来，且这类分叉在界面上看不出来）。
 *
 * 该 SDK 的调用形态（`(params, cb)` 回调 + `Deleted`/`Error` 响应形状）已由
 * `s3-client.js` 完整复刻，因此**上层业务代码一行都没改** —— 只依赖本模块导出的统一接口。
 */
const configStore = require('./config-store');
const statsStore = require('./stats-store');
const providers = require('./providers');
const { S3Client } = require('./s3-client');
const { AzureBlobClient } = require('./azure-client');
const { assertSafeEndpoint } = require('./endpoint-guard');
const { LIMITS, resolveCap } = require('./limits');
const listCache = require('./list-cache');
// R89：存储空间作用域的**兜底判据**（见 `assertScoped`）
const requestContext = require('./request-context');
const userSpace = require('./user-space');

const clients = new Map(); // 签名 -> 客户端实例缓存
let clientsKey = '';

/** 从配置中解析出服务商 id（缺省视为腾讯云，兼容历史配置） */
function providerOf(cfg) {
  return String((cfg && cfg.provider) || providers.DEFAULT_PROVIDER_ID);
}

/**
 * 创建存储客户端
 * @param {object} cfg { provider, secretId, secretKey, endpoint, region, bucket }
 */
function createClient(cfg) {
  const pid = providerOf(cfg);
  const meta = providers.resolve(pid);
  if (meta.kind === 'planned') {
    const err = new Error(`${meta.name} 暂未开放接入，请先选择其他服务商`);
    err.status = 400;
    throw err;
  }
  /**
   * 端点来源（按优先级）：
   *  ① 用户在密钥里显式填写的端点（走安全校验）；
   *  ② 按地域推导的厂商默认端点（阿里云 / 华为云 / AWS / B2 …）；
   *  ③ R30：由**账户名**推导（Azure —— 账户名进主机名，与「地域进主机名中段」是两回事，
   *     见 providers.endpointForAccount）。`secretId` 就是账户名，因此不需要用户填两遍。
   */
  const endpoint = String(cfg.endpoint || '').trim() ||
    providers.endpointFor(pid, providers.regionFor(pid, cfg.region)) ||
    providers.endpointForAccount(pid, cfg.secretId);
  // SEC-03：自定义端点必须先过安全校验（禁云元数据/回环/私网，非回环强制 https），
  // 否则可被用来让服务端替请求方访问内网或云实例元数据端点（盲 SSRF）。
  // ⚠️ 由账户名推导出来的端点**天然只可能是合法主机**（账户名字符集在
  // `endpointForAccount` 里收敛到 `^[a-z0-9]{3,24}$` + 固定域名后缀），故不必再校验。
  if (cfg.endpoint) assertSafeEndpoint(cfg.endpoint);
  if (meta.kind === 'azure') {
    /**
     * R30：Azure Blob —— 独立鉴权协议（Shared Key）+ Block Blob 语义，见 azure-client.js。
     * `secretId` 即存储账户名、`secretKey` 即账户密钥；端点缺省由账户名推导。
     * 地域（`defaultRegion: 'auto'`）不参与寻址与签名，仅为满足上层「地域非空」的既有约定。
     */
    return new AzureBlobClient({
      accountName: cfg.secretId,
      accountKey: cfg.secretKey,
      endpoint, // 已按需推导过；用户显式填写时会被 azure-client 原样使用
      bucket: cfg.bucket,
    });
  }
  if (!endpoint) {
    // 缺端点时的文案要按**该厂商实际要求填什么**来说（R2 要账户 ID、MinIO 要访问地址…），
    // 否则用户拿到一句「请在密钥中补充 Endpoint」却找不到那个输入栏 —— 表单里
    // 那一栏的标签就是厂商元数据里的 endpointLabel。
    const need = meta.endpointLabel
      ? `请在密钥中填写「${meta.endpointLabel}」`
      : '请在密钥中补充服务端点';
    const err = new Error(`${meta.name} 缺少服务端点：${need}`);
    err.status = 400;
    throw err;
  }
  return new S3Client({
    accessKeyId: cfg.secretId,
    secretAccessKey: cfg.secretKey,
    endpoint,
    // 地域经 regionFor 解析：R2 / GCS 允许留空，由厂商默认值（auto）补齐；
    // 自建 MinIO 未填时落到 us-east-1。SigV4 的签名串必须带地域，空串会让
    // 客户端各自兜底成不同值（客户端 us-east-1、服务端却按端点推导），签名对不上。
    region: providers.regionFor(pid, cfg.region),
    bucket: cfg.bucket,
    // 自建对象存储（MinIO）默认虚拟主机风格会拼出 `bucket.<host>` 而无法解析，
    // 必须按厂商元数据切到路径风格（见 s3-client._virtualHosted）。
    forcePathStyle: providers.forcePathStyle(pid),
    // R42：华为云 OBS 的 V4 只接受 UNSIGNED-PAYLOAD（发真实载荷哈希必得 403），
    // 这条差异同样由注册表下发（见 providers.unsignedPayload）。
    unsignedPayload: providers.unsignedPayload(pid),
    // R43：华为云 OBS 的 ListBuckets 不回桶地域，需逐个补查 GetBucketLocation ——
    // 否则界面会拿到客户端自己的 region 并把它当成桶的地域（见 providers.queryBucketLocation）。
    queryBucketLocation: providers.queryBucketLocation(pid),
    // R45：UCloud US3 只接受**定长**分片（8MB），分块复制同理 —— 由注册表下发，
    // 漏传的后果是「大文件分片上传 / 分块复制必然 400，小文件却正常」
    // （见 providers.fixedPartBytes 与 S3Client#sliceCopyFile）。
    fixedPartBytes: providers.fixedPartBytes(pid),
  });
}

function getClient(cfg) {
  const c = cfg || configStore.get();
  if (!c || !c.secretId || !c.secretKey) {
    const err = new Error('尚未配置对象存储访问密钥，请先在“设置”中完成配置');
    err.status = 428; // Precondition Required
    throw err;
  }
  const pid = providerOf(c);
  const key = [pid, c.secretId, c.secretKey, c.endpoint || '', c.region || ''].join('|');
  if (clientsKey !== key) {
    clients.clear();
    clientsKey = key;
  }
  if (!clients.has(key)) {
    clients.set(key, createClient(c));
  }
  return clients.get(key);
}

/**
 * 将 SDK 回调风格转为 Promise
 * @param {object} opts { noStat } noStat=true 时不计入按桶请求统计（内部轮询类调用）
 */
/**
 * R89：从 `CopySource` 里取出对象 key。
 *
 * 有两种形态（见 `copySource()`）：S3 兼容厂商的 `/bucket/key`，Azure 的
 * 绝对 URL。key 部分是**百分号编码**过的，比对前必须解码，否则 `u/alice/a b.txt`
 * 会与 `u/alice/a%20b.txt` 判成两个不同的东西（前者必然越界 → 合法复制被误拒）。
 */
function copySourceKeyOf(src) {
  const s = String(src == null ? '' : src);
  if (!s) return '';
  let raw = '';
  if (/^https?:\/\//i.test(s)) {
    try { raw = new URL(s).pathname.replace(/^\/+/, ''); } catch (e) { return ''; }
    // 绝对 URL 的第一段是账户 / 容器名，不是 key
    const i = raw.indexOf('/');
    raw = i < 0 ? '' : raw.slice(i + 1);
  } else {
    const body = s.replace(/^\/+/, '');
    const i = body.indexOf('/');
    raw = i < 0 ? '' : body.slice(i + 1);
  }
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

/**
 * R89：从一次 S3 调用的参数里收集「所有起 key 作用的字符串」。
 *
 * ⚠️ **新增 S3 方法若带 key 类参数，必须在这里登记**，否则兜底判据对它失效。
 * 这是本函数唯一的维护负担，也是它存在的理由 —— 逐条路由加判据会漏，
 * 而漏一处就是「普通用户能删别人的文件」。
 */
function scopedKeys(params) {
  const q = params || {};
  const out = [];
  const push = (v) => {
    if (typeof v !== 'string' || !v) return;
    out.push(v);
  };
  push(q.Key);
  push(q.Prefix);
  push(q.Marker);          // 分页游标是绝对 key（首屏为空串）
  if (typeof q.CopySource === 'string') push(copySourceKeyOf(q.CopySource));
  const del = q.Delete;
  if (del && Array.isArray(del.Objects)) {
    for (const o of del.Objects) if (o && typeof o.Key === 'string') push(o.Key);
  }
  return out;
}

/**
 * R89：存储空间兜底判据（fail-closed）。
 *
 * 为什么需要它：路由层已经用 `userSpace.toAbs()` 把客户端 key 转成绝对 key，
 * 但只要将来**新增一个端点忘了转**，那就是静默越权。这里在**全部 S3 调用的
 * 唯一入口** `p()` 上再判一次：普通会话上下文里的任何 key 只要不在本人空间内，
 * 一律 404（不区分「不存在」与「不属于你」，避免变成存在性预言机）。
 *
 * 白名单是「没有作用域」本身：管理员、内部任务（清理 / 统计 / 自检）与
 * 分享下载（走 `effectiveForBucket()`，key 是绝对语义）都拿不到 `spaceRoot`。
 */
function assertScoped(params) {
  const root = requestContext.spaceRoot(); // 角色是 user 却无 userId 时这里抛 500（fail-closed）
  if (!root) return;
  for (const k of scopedKeys(params)) {
    if (userSpace.isInside(root, k)) continue;
    const e = new Error('对象不存在或无权访问');
    e.status = 404;
    e.code = 'SpaceDenied';
    e.spaceDenied = true;
    throw e;
  }
}

function p(s3, method, params, opts) {
  assertScoped(params);
  return new Promise((resolve, reject) => {
    s3[method](params, (err, data) => {
      // 按桶请求计数（跳过 request 原始调用：那是本系统自己的统计轮询）
      if (!opts || !opts.noStat) {
        const bk = params && params.Bucket;
        if (bk && method !== 'request') statsStore.trackBucket(bk, { req: 1 });
      }
      // 列举缓存失效的唯一挂载点：写操作一律失效该桶缓存。
      // 放在成功与失败**两条分支**上 —— 失败的写也可能已经部分生效，
      // 少失效一次就可能让用户看到「刚删掉的文件还在」。
      listCache.noteCall(method, params);
      if (err) reject(err); else resolve(data);
    });
  });
}

/** SDK 错误 -> 面向用户的中文错误信息 */
/**
 * 将存储服务返回的错误翻译为面向用户的分类化提示（S9）
 *  - 用户只看到分类文案，不含请求 ID、内部路径、区域等内部信息
 *  - 原始错误消息保留在 err.rawMessage，仅供服务端日志排查使用
 */
function translateError(e) {
  const raw = (e && e.message) || '未知错误';
  const status = e && (e.statusCode || e.status) || 0;
  const code = (e && (e.code || e.errorCode)) || '';
  let msg;
  // SDK 本地参数校验失败（如凭据缺失）不带 statusCode，按参数错误处理而非 500
  if (/missing param/i.test(raw)) msg = '请求参数错误：缺少 ' + raw.replace(/missing param\s*/i, '');
  else if (status === 400 || code === 'InvalidArgument') msg = '请求参数错误，请检查后重试';
  else if (status === 401) msg = '签名错误：请检查 AccessKey / SecretKey 是否正确';
  else if (status === 403 || code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') msg = '签名错误：请检查 AccessKey / SecretKey 是否正确';
  else if (status === 404 || code === 'NoSuchBucket' || code === 'NoSuchKey') msg = '资源不存在：对象或存储桶不存在';
  else if (status === 409) msg = '资源冲突：请刷新后重试';
  else if (code === 'NoSuchUpload') msg = '分片上传会话已失效，请重新上传';
  else if (code === 'NotImplemented') msg = '当前服务商不支持该操作';
  else if (code === 'TimeoutError' || /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) msg = '网络连接异常，请检查网络后重试';
  else if (status >= 500) msg = '对象存储服务暂时不可用，请稍后重试';
  else msg = '操作失败，请重试';
  const err = new Error(msg);
  /**
   * R11-04：上游存储返回的 **401 不得原样透传**。
   *
   * 项目的硬约定是「401 = 没有有效会话」：前端 `api.js` 一见 401 就派发
   * `auth-required` → `forceLogout('登录已过期，请重新登录')`（还会清掉未提交的编辑）。
   * 而对象存储用 401 表达的是**密钥被拒绝**（SignatureDoesNotMatch / 密钥轮换或吊销），
   * 两者是同一种状态码下的两件事 —— 透传的结果是：用户被踢出 → 重新登录 →
   * 第一个请求再 401 → 再被踢出，管理端进入不可用死循环，且错误文案把
   * 「密钥无效」误导成「会话过期」。
   *
   * 上游的 401 映射为 502（"上游说不行"，属服务端故障而非会话问题）；
   * 本地会话语义的 401 由路由层自己抛，不经本函数，因此不受影响。
   */
  err.status = status === 401 ? 502 : (status >= 400 && status < 600 ? status : 500);
  /**
   * R87：本函数产出的 message 是**固定文案**（不含端点、密钥、路径），
   * 因此对 5xx 也允许回显 —— 全局错误处理器凭 `expose` 区分「能给的」与
   * 「可能带运行环境细节的原始 message」。
   */
  err.expose = true;
  err.s3Code = code;
  err.rawMessage = raw; // 仅服务端日志使用
  return err;
}

/**
 * 执行一次面向用户的存储操作并记录请求统计
 * @param {string} type 请求类型 list/upload/download/delete/mkdir/rename/move/stat/search/other
 * @param {Function} fn async 操作体
 * @param {object} traffic {bytesUp, bytesDown} 在操作体内更新并回填
 */
async function tracked(type, fn, traffic) {
  const t0 = Date.now();
  const bytes = traffic || {};
  try {
    const result = await fn();
    statsStore.track({ type, ok: true, bytesUp: bytes.bytesUp || 0, bytesDown: bytes.bytesDown || 0, ms: Date.now() - t0 });
    return result;
  } catch (e) {
    statsStore.track({ type, ok: false, bytesUp: bytes.bytesUp || 0, bytesDown: bytes.bytesDown || 0, ms: Date.now() - t0 });
    throw e instanceof Error && e.status ? e : translateError(e);
  }
}

/**
 * 递归列出前缀下全部对象（统一实现：routes 与 fs-gateway 共用，禁止各自再写一份）
 *
 * PERF-04：cap 默认不再是无约束的 20 万。`listAll` 串行翻页并把结果全量累积到
 * 内存数组，单次上限过大时会同时造成「200+ 次串行云端往返」与「整体序列化」的
 * 双重长任务。默认上限改为 {@link LIMITS.HARD_MAX}（5 万），各调用方应按业务语义
 * 显式传入更小的值。
 *
 * @param {object} s3  存储客户端
 * @param {object} cfg  { bucket, region }
 * @param {string} prefix
 * @param {object} [opts]
 *  - cap: 最多返回条数（受 HARD_MAX 硬约束）。**注意**：达到上限即停，
 *    结果可能是部分集合；需要区分「已列完」与「被截断」请用 {@link listAllInfo}。
 *  - noStat: true 时不计入按桶请求统计（内部维护类调用）
 *  - skipPrefixSelf: true 时跳过与 prefix 完全相等的对象（目录标记自身）
 * @returns {Promise<Array<{ key: string, size: number, lastModified: string }>>}
 *          lastModified 为服务端返回的 ISO 时间串（/fs/search 日期区间过滤依赖该字段）
 */
async function listAll(s3, cfg, prefix, opts = {}) {
  return (await listAllInfo(s3, cfg, prefix, opts)).items;
}

/**
 * 列出**一页**对象 —— 全项目唯一的「翻一页 + 推导下一页游标」实现。
 *
 * 为什么要抽出来：此前「下一页游标」的推导（`NextMarker` 缺失时回退到本页最后
 * 一个 key）只写在 `listAllInfo` 里，任何需要**游标透传**的新调用方（如
 * `/fs/search` 的续扫）都不得不复制一遍；按本项目反复验证的规律，复制即分叉。
 * 现在 `listAllInfo` 与搜索续扫都建立在这一份实现之上。
 *
 * 游标语义：返回的 `nextMarker` 恒为「可直接塞回 `Marker` 的不透明游标」
 * （S3 下由 `s3-client` 适配为 continuation-token，见该文件顶部说明）。
 *
 * @param {object} s3
 * @param {object} cfg  { bucket, region }
 * @param {string} prefix
 * @param {object} [opts]
 *  - marker: 起始游标，首轮传 ''
 *  - maxKeys: 单页条数（对象存储服务端上限 1000）
 *  - delimiter: 传 '/' 时按下级目录聚合（返回 CommonPrefixes）；默认 '' 为递归列举
 *  - noStat: true 时不计入按桶请求统计
 *  - skipPrefixSelf: true 时跳过与 prefix 完全相等的对象（目录标记自身）
 * @returns {Promise<{items: Array<{key,size,lastModified}>, prefixes: string[],
 *                    nextMarker: string, isTruncated: boolean}>}
 *          `nextMarker` 为空串即表示已列举完（调用方必须以此为准，不要靠条数反推）
 */
async function listPage(s3, cfg, prefix, { marker = '', maxKeys = 1000, delimiter = '', noStat = false, skipPrefixSelf = false } = {}) {
  const data = await p(s3, 'getBucket', {
    Bucket: cfg.bucket,
    Region: cfg.region,
    Prefix: prefix,
    Delimiter: delimiter,
    Marker: marker,
    MaxKeys: Math.min(1000, Math.max(1, Number(maxKeys) || 1000)),
  }, noStat ? { noStat: true } : undefined);

  const items = [];
  for (const c of data.Contents || []) {
    if (skipPrefixSelf && c.Key === prefix) continue;
    items.push({ key: c.Key, size: Number(c.Size) || 0, lastModified: c.LastModified || '' });
  }
  const prefixes = (data.CommonPrefixes || []).map((x) => x.Prefix).filter(Boolean);
  const isTruncated = String(data.IsTruncated) === 'true';
  // 只回退到**本页**最后一个 key：若本页为空且服务端未给 NextMarker，
  // 必须得到空串并结束循环（回退到上一页的 key 会原地打转成死循环）。
  //
  // delimiter='/' 时本页可能**只有 CommonPrefixes 而没有 Contents**（子目录数超过
  // MaxKeys 的极端目录）：这时若仍只按 items 取回退值就会得到空串，循环被判为
  // "已列举完"，而桶里明明还有下一页 —— 是一次静默截断。CommonPrefixes 本身就是
  // 合法的 marker（语义为"返回大于它的 key"），故一并纳入回退。
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1].key : '');
  const nextMarker = isTruncated
    ? (data.NextMarker || lastOf(items) || (prefixes.length ? prefixes[prefixes.length - 1] : ''))
    : '';
  return { items, prefixes, nextMarker, isTruncated };
}

/**
 * 与 {@link listAll} 相同，但额外返回 `truncated`：指示结果是否因达到 cap 而被截断。
 *
 * 这是 FUN-04 的关键前提 —— 旧调用方用「拿到的条数 == cap」来反推是否截断，
 * 一旦上游发生多余忍拳就误判为「已列完」，进而在对象未删干净时就去清元数据。
 *
 * @returns {Promise<{items: Array, truncated: boolean, cap: number}>}
 */
async function listAllInfo(s3, cfg, prefix, { cap, noStat = false, skipPrefixSelf = false } = {}) {
  const limit = resolveCap(cap, LIMITS.HARD_MAX);
  const all = [];
  let marker = '';
  let truncated = true;
  while (truncated && all.length < limit) {
    const page = await listPage(s3, cfg, prefix, { marker, noStat, skipPrefixSelf });
    for (const it of page.items) {
      all.push(it);
      if (all.length >= limit) break;
    }
    truncated = page.isTruncated;
    marker = page.nextMarker;
    if (!marker) break;
  }
  if (all.length > limit) all.length = limit;
  return { items: all, truncated, cap: limit };
}

/**
 * 列举**必须完整**的对象集合：一旦因达到 cap 被截断就抛错，绝不返回部分集合。
 *
 * 用于「列举 → 复制 → 删源」这类场景（重命名 / 移动目录）。旧调用方用
 * `listAll(cap)` 拿部分集合继续走流程，而随后的删除按**整个前缀**执行 ——
 * 超出 cap 的那部分对象被删却没复制，数据不可逆丢失（FUN-02）。
 *
 * 全项目只有这一处「完整列举」判定，routes/fs.js 与 fs-gateway.js 共用，
 * 避免各处自己写一遍 `if (info.truncated)` 而漏掉某个分支。
 *
 * @param {object} s3
 * @param {object} cfg
 * @param {string} prefix
 * @param {object} [opts]  同 {@link listAllInfo}
 * @param {string} [what]  用于错误文案的操作名，如「移动」
 * @returns {Promise<Array<{key:string,size:number,lastModified:string}>>}
 */
async function listAllExact(s3, cfg, prefix, opts = {}, what = '处理') {
  const info = await listAllInfo(s3, cfg, prefix, opts);
  if (info.truncated) {
    const e = new Error(
      `「${prefix}」下对象数超过单次要${what}的上限（${info.cap}）。`
      + `为避免只复制一部分就删除源数据，已中止且未做任何改动；请分批${what}其中的子目录。`
    );
    e.status = 400;
    e.truncated = true;
    e.cap = info.cap;
    throw e;
  }
  return info.items;
}

/**
 * 绕道 `module.exports` 调用 {@link p}。
 *
 * 测试用 `s3.p = 桩` 替换的是**导出对象上的属性**；本文件内的其它函数若直接调
 * 模块作用域的 `p`，桩就打不到它们。对本函数而言后果很具体：桩失效 → 真实 `p` 去
 * 调假客户端上不存在的 `deleteMultipleObject` → 整批失败 → 什么也测不到，护栏只能
 * 退化成"直接桩掉本函数"（那就等于没测判据本身）。
 *
 * 绕一次导出对象即可让既有 `s3.p` 桩继续生效；生产环境下与直接调 `p` 完全等价。
 */
function callP(...args) {
  return module.exports.p(...args);
}

/**
 * 批量删除，并返回「云端**明确确认**已删除」的 key（R9-02 / R10-03 的唯一判据）。
 *
 * 为什么必须有它：S3 的 `DeleteObjects` 对整批回 **200**，单个对象的失败（对象锁、
 * 合规保留、桶策略 `Deny s3:DeleteObject`、对象不存在……）只写在响应体的 `<Error>`
 * 里。调用方若把「整批返回成功」当成「全部删掉了」，就会对**仍然存在**的对象执行
 * 两个本项目自定为**不可逆**的动作：
 *   ① `removeMetaBatch` 清掉活密文的 IV / TAG / 盐 → 文件永久不可解；
 *   ② `markMissingByKeys` 把指向它的分享链接标成已删除 → 已分发的 URL 永久失效。
 *
 * 判据必须是**白名单**（只认明确出现在 `Deleted` 里的 key），而不是「不在 `Error`
 * 里就算成功」的黑名单 —— 后者在厂商响应体既无 `<Deleted>` 也无 `<Error>`
 * （协议外行为 / 解析退化）时会把未确认的删除当成成功。
 *
 * 集中在此处的理由：`/fs/delete`、`/fs/move` 的目录分支、清空桶、WebDAV 删目录
 * **四处**都要同一套判据。上一轮只改了其中一处，另三处漏网（R10-03）——
 * 这正是「同一状态多个入口，改一处漏一处」，故下沉为共用函数。
 *
 * @param {object} s3   客户端
 * @param {object} cfg   桶配置（bucket / region）
 * @param {string[]} keys 待删除的 key
 * @returns {Promise<{okKeys: string[], errors: Array<{key:string, message:string}>}>
 *   `okKeys` = 云端确认已删除的 key（**只**用它做元数据清理 / 分享链接标记）
 */
async function deleteMultipleConfirmed(s3, cfg, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
  if (!list.length) return { okKeys: [], errors: [] };

  const byKey = new Map(list.map((k, i) => [k, i]));
  const okSet = new Set();      // key -> 云端明确确认已删除
  const errMap = new Map();     // key -> 人可读原因

  try {
    const r = await callP(s3, 'deleteMultipleObject', {
      Bucket: cfg.bucket, Region: cfg.region,
      Objects: list.map((k) => ({ Key: k })),
    });
    for (const d of (Array.isArray(r && r.Deleted) ? r.Deleted : [])) {
      if (!d || d.Key === undefined) continue;
      if (byKey.has(d.Key)) okSet.add(d.Key);
    }
    const errs = Array.isArray(r && r.Error) ? r.Error : (r && r.Error ? [r.Error] : []);
    for (const err of errs) {
      if (!err || err.Key === undefined) continue;
      if (byKey.has(err.Key)) errMap.set(err.Key, err.Message || err.Code || '云端拒绝删除该对象');
    }
  } catch (e) {
    // 整批失败：全部标记失败 —— 调用方据此**不做任何**元数据清理
    for (const k of list) errMap.set(k, e && e.message ? e.message : '批量删除失败');
  }

  // 既不在 Deleted 也不在 Error → 云端没有确认 → 保守地视为未删除
  for (const k of list) {
    if (!okSet.has(k) && !errMap.has(k)) {
      errMap.set(k, '云端未确认该对象的删除结果（响应中既无 Deleted 也无 Error），已按未删除处理');
    }
  }

  const okKeys = list.filter((k) => okSet.has(k));
  const errors = list.filter((k) => errMap.has(k)).map((k) => ({ key: k, message: errMap.get(k) }));
  return { okKeys, errors };
}

/** 校验并规范化对象 Key（禁止越权路径） */
function normalizeKey(key) {
  if (typeof key !== 'string') throw badRequest('Key 必须为字符串');
  let k = key.replace(/\\/g, '/').replace(/^\/+/, '');
  /**
   * R94（审核 M07-08）：**剥掉 Unicode 双向控制字符**。
   *
   * 这些字符不可见，却会**重排其后文本的显示顺序**。`escapeHtml()` 不改变它们，
   * 浏览器按 bidi 算法渲染，于是 `合同\u202Etxt.exe` 在文件列表里显示成
   * `合同exe.txt` —— 扩展名看起来被反转了；下载时 `Content-Disposition` 用的
   * 还是同一个文件名，系统保存对话框里同样被骗（CWE-1007）。
   *
   * 处理方式选「剥掉」而不是「拒绝」：key 由本地文件名拼出，用户对自己文件里有没有
   * 这些不可见字符毫无概念，400 只会变成一句无法执行的报错；而剥掉是幂等的，剥完
   * 的 key 不含任何方向控制字符，欺骗性随之消失。
   * 覆盖：U+200E/U+200F（LRM/RLM）、U+202A–U+202E（嵌入/覆盖）、U+2066–U+2069（隔离）。
   */
  // eslint-disable-next-line no-control-regex
  k = k.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  /**
   * R87①：**空字符必须拒绝**。
   *
   * `list-cache` / `search-candidates` 在把 key 拼成缓存键时会把 `\u0000` 剥掉，
   * 于是 `a\0b` 与 `ab` 落进**同一个**缓存条目 —— 一个桶里存在这类 key 时，
   * 目录内容会短暂「串味」（把 A 的列举结果给 B 看）。合法的对象 key 里没有 NUL，
   * 在唯一入口拒掉，比在每条派生链路上各剥一次更可靠。
   */
  if (k.indexOf('\u0000') >= 0) throw badRequest('Key 不能包含空字符（\\u0000）');
  /**
   * R87②：`..` 必须按**路径段**判定，不能按子串。
   *
   * 旧写法 `k.includes('..')` 把合法文件名一并拒掉：`a..b.txt`、`report..final.pdf`
   * 这类很常见的命名在上传 / 重命名时直接 400，且文案「Key 不能包含 ..」让人
   * 完全看不出问题出在「连续两个点」而不是「上级目录」。
   * 真正的穿越风险只来自**恰好等于 `..` 的整段**。
   */
  if (k.split('/').some((seg) => seg === '..')) throw badRequest('Key 不能包含 ..');
  return k;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/**
 * 对象元数据里记录「上传者 / 创建者」的**唯一实现点**（R36）。
 *
 * 各家的自定义元数据头在上层统一用 `x-s3-meta-*` 命名，由各适配器翻译成厂商自己的
 * 前缀（`s3-client` → `x-amz-meta-*`、`azure-client` → `x-ms-meta-*`），读取时再统一
 * 映射回 `x-s3-meta-*` —— 于是这里只需写一个名字、读一个名字，不必按厂商分叉。
 *
 * R49 改名说明（**不影响已存的对象**）：这几个前缀都只是**协议侧的写法**，云端真正
 * 存下来的是去掉前缀的那一段（`uploader`）。腾讯云用 COS 原生 SDK 写的是
 * `x-cos-meta-uploader`、用 S3 协议读回来是 `x-amz-meta-uploader`（腾讯云官方文档给出
 * 的正是这张对照表），两边落到同一个存储键上 —— 所以把上层命名从 `x-cos-meta-*` 改成
 * `x-s3-meta-*`、把腾讯云的读写切到 S3 客户端，**历史对象的上传者照旧读得出来**。
 *
 * ⚠️ 必须写在**建对象的那一刻**（直传 / 分片 init / 建文件夹 / WebDAV 写），
 * 而不是上传完成后补写：S3 系的对象元数据只能在创建时指定
 * （`CompleteMultipartUpload` 不接受元数据头）。Azure 是唯一例外 ——
 * 它的块列表提交（Put Block List）仍接受 `x-ms-meta-*`，故 complete 也会带上，
 * 对 S3 而言多传的那一个头是被忽略的，不会覆盖创建时写入的值。
 *
 * 历史对象没有这个头 → 属性面板显示「—」，**不做任何猜测**（不拿「当前登录用户」
 * 或「最后一个操作者」冒充上传者 —— 那是在编造数据）。
 */
const UPLOADER_META = 'x-s3-meta-uploader';

/** 生成「记录上传者」的请求头；用户名为空时返回空对象（不写空值元数据） */
function uploaderMeta(username) {
  const u = String(username == null ? '' : username).trim();
  return u ? { [UPLOADER_META]: u } : {};
}

/**
 * 从对象响应头里读出上传者（没有则空串）—— `uploaderMeta()` 的**读取端**。
 *
 * 与写入端成对放在这里，是为了让「元数据的名字」只出现在本文件：
 * 上游若各自拼 `headers['x-s3-meta-uploader']`，改名字时必然漏掉一处，
 * 而漏掉的表现在界面上只是「某一处显示 — 」，几乎不可能被 review 发现。
 */
function readUploader(headers) {
  const h = headers || {};
  return String(h[UPLOADER_META] || '').trim();
}

/** CopySource 的 Key 需逐段百分号编码（保留 '/' 作分隔符） */
function encodeCopyPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/**
 * 构造对象复制的 CopySource（**全项目唯一实现**，routes.js 与 fs-gateway.js 共用）。
 *
 * - S3 兼容厂商（**R49 起包含腾讯云**）：`/bucket/key`（键需百分号编码）
 * - R30 Azure Blob：同样用 `/容器/键` 形式，由 `azure-client` 自己**拼成绝对 URL**
 *   （Azure 的 Copy Source 必须是一个 URL，且只有客户端知道自己的账户名 / 端点）。
 *   这里刻意不返回 URL：`copySource()` 的入参里没有端点与账户名，硬拼只能拼出
 *   `https://<容器>.blob.core.windows.net/…` 这种**语法合法但不存在**的主机名。
 *
 * 历史上本函数**曾有一个腾讯云分支**，返回 COS 外链域名形式
 * （`<bucket>.cos.<region>.myqcloud.com/<key>`）—— 那是 COS 原生 SDK 的口味。
 * R49 腾讯云改走 S3 协议后该分支已删除：它对 S3 客户端是**错的**（S3 的
 * `CopySource` 只接受 `/<bucket>/<key>`），留着就会让腾讯云的复制请求 400。
 * 同一形态的错误在历史上也发生过一次（fs-gateway.js 内硬编码该外链域名，导致经
 * 网关触发的复制在 S3 厂商上格式错误），故统一到这一处、并且不再按厂商分叉。
 */
function copySource(provider, bucket, region, key) {
  /**
   * R49：**全厂商同一个形态，不再按厂商分叉。**
   *
   * 判据已不含任何厂商差异（原先的 `bucket.cos.<region>.myqcloud.com/key`
   * 外链分支随 COS 原生协议一起删除）。
   *
   * ⚠️ 但**形参表必须保持四个**，两个不用的入参各有原因：
   *  - `provider`：三处调用点（`routes/fs.js` 的 `copyOne`、`fs-gateway.js` 的
   *    `copyObject` 与目录 MOVE）都按这个位置传；
   *  - `region`：**不能删**。收口时若把它从形参表里去掉，而某个调用点仍按老位置
   *    传四个实参，`key` 就会落到 `region` 的位置上 —— 拼出 `/<桶>/<地域>`
   *    这种**语法合法但指向不存在对象**的 CopySource，复制静默失败。
   *    本轮实测正是如此：参数一改，`tests/azure-client.test.js` 的 R30 用例
   *    立刻变红（护栏按「实际被执行的那一层」判，才抓得住这种错位）。
   */
  return `/${bucket}/${encodeCopyPath(key)}`;
}

module.exports = {
  getClient, createClient, providerOf, p, tracked, translateError,
  listAll, listAllInfo, listAllExact, listPage, LIMITS, normalizeKey, badRequest,
  copySource, encodeCopyPath, deleteMultipleConfirmed,
  UPLOADER_META, uploaderMeta, readUploader,
};
