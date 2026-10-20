/**
 * WebDAV · 对象列举层：把 S3 的一层 / 递归列举折算成 WebDAV 需要的条目形态
 *
 * 这一层是 WebDAV 与对象存储之间**唯一的**接触面（通信由 R22-03 / R52 的
 * `s3` 客户端承担），HTTP 层的 app.js 不再直接调 S3 SDK。
 */
const configStore = require('../config-store');
const statsStore = require('../stats-store');
const { getClient, p } = require('../s3');
const providers = require('../providers');
const gateway = require('../fs-gateway');
const { PROPFIND_CAP } = require('./defs');

/* ------------------------------ 对象列举 ------------------------------ */

async function requireS3() {
  const cfg = configStore.get();
  // 地域仅在厂商要求时才必填（如又拍云 S3 兼容接口无需地域）
  const prov = providers.get(cfg && cfg.provider) || providers.resolve(cfg && cfg.provider);
  const needRegion = prov.regionRequired !== false;
  if (!cfg || !cfg.secretId || !cfg.secretKey || !cfg.bucket || (needRegion && !cfg.region)) {
    const e = new Error('尚未完成对象存储密钥与存储桶配置，WebDAV 无法提供服务');
    e.status = 503;
    throw e;
  }
  return { cfg, s3: getClient(cfg) };
}

/**
 * 列举一层（Delimiter=/）：返回文件数组、子目录前缀数组与截断标志。
 *
 * R8-22：必须**翻页到底**。旧实现只取一页（`MaxKeys: 1000`）且完全不读
 * `IsTruncated` / `NextMarker` —— 子项超过 1000 的目录在资源管理器 / Finder /
 * rclone 里就「只有 1000 个」，既不完整、也无任何提示，用户看到的是
 * 「一个看起来正常但少了东西的目录」。总量由 `PROPFIND_CAP` 兜底。
 *
 * @returns {Promise<{files: object[], dirs: object[], truncated: boolean}>}
 *   `truncated` 为真表示**结果仍不完整**（已达 PROPFIND_CAP 或云端不再给游标），
 *   调用方必须把它显式告出去，不能默默丢弃。
 */
async function listLevel(s3, cfg, prefix) {
  const files = [];
  const dirs = [];
  let marker = '';
  let truncated = false;
  let more = true;
  while (more) {
    const data = await p(s3, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region,
      Prefix: prefix, Delimiter: '/', Marker: marker, MaxKeys: 1000,
    }, { noStat: true });
    const contents = data.Contents || [];
    let capped = false;
    for (const c of contents) {
      if (c.Key === prefix) continue; // 目录标记对象本身不算「文件」
      if (files.length + dirs.length >= PROPFIND_CAP) { capped = true; break; }
      files.push({ key: c.Key, size: Number(c.Size) || 0, lm: c.LastModified, dir: false });
    }
    if (!capped) {
      for (const x of data.CommonPrefixes || []) {
        if (files.length + dirs.length >= PROPFIND_CAP) { capped = true; break; }
        dirs.push({ key: x.Prefix, size: 0, lm: '', dir: true });
      }
    }
    // 游标优先取云端给的 NextMarker；未给则回退到本页最后一个 Key
    // （与 listAll/listPage 的既有约定一致，避免不同厂商返回口径不一致导致死循环）
    marker = data.NextMarker || (contents.length ? contents[contents.length - 1].Key : '');
    const isTrunc = String(data.IsTruncated) === 'true';
    if (capped) { truncated = true; more = false; }
    else if (!isTrunc) { more = false; }
    else if (!marker) { truncated = true; more = false; } // 云端说"还有"但不给游标 → 只能停
  }
  return { files, dirs, truncated };
}

/**
 * WebDAV `Overwrite: F` 的唯一判据：目标是否已存在。
 *
 * ## R10-11：此前有两套实现，且各自漏判一种形态
 *
 * | 位置 | 旧判据 | 漏判形态 |
 * |------|--------|----------|
 * | 文件分支（`!srcKey.endsWith('/')`） | `headObject(dstKey)` | ——（这个是对的） |
 * | 目录 MOVE | `listLevel(dst + '/')` 只看一层 | ① 目标是**已存在的文件**：`listLevel('plain.txt/')` 命不中 → 不报 412，随后把源目录整个写进 `plain.txt/` 前缀；② 目标是**空目录**：只有 `dir/` 一个占位对象，而 `listLevel` 里 `if (c.Key === prefix) continue` 会把它跳过 → 也不报 412 |
 * | 目录 COPY | 循环内**逐对象** `headObject(target)` | 要在复制掉一部分对象之后才发现冲突（RFC 4918 §9.8.4 要求整体拒绝）；且只查"源里也有的 rel key"，目标多出来的对象查不到 |
 *
 * 三处收敛到本函数，判据按「先精确、后列举」的顺序覆盖四种存在形态：
 *
 *   1. 目标路径本身是一个已存在的**文件**（含"把目录写到某个已存在文件之下"）；
 *   2. 目标是一个**目录占位对象**（空目录只有 `dir/` 这一个 0 字节标记对象）；
 *   3. 目标目录下有**任意一层子项**（文件或子目录前缀）—— 判定"非空"只需第一层，
 *      刻意不递归（超大目标上递归全量列举纯属浪费）。
 *
 * 探测本身失败（网络抖动 / 403）时**按不存在返回**：`Overwrite: F` 的目标是
 * "不要覆盖我没见过的东西"，探测失败意味着服务端没能确认目标存在，此时放行由
 * 云端自己的条件写来兜 —— 反之若按"存在"返回，一次抖动就会让所有同步静默失败。
 *
 * @param {object} s3 客户端
 * @param {object} cfg 桶配置
 * @param {string} dstKey 目标对象键（可带尾斜杠）
 * @param {boolean} srcIsDir 源是否为目录（决定要不要查 2/3 两种目录形态）
 * @returns {Promise<boolean>}
 */
async function destinationExists(s3, cfg, dstKey, srcIsDir) {
  const bare = String(dstKey || '').replace(/\/+$/, '');
  const head = async (Key) => {
    try {
      await p(s3, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key }, { noStat: true });
      return true;
    } catch (e) { return false; }
  };
  const prefix = bare + '/';
  // ① 目标路径本身是一个已存在的文件
  if (bare && await head(bare)) return true;
  if (!srcIsDir) {
    /**
     * R11-09：文件源也要排除「目标是一个已存在的**目录**」。
     *
     * R10-11 把目录源的 4 种目标形态收敛齐了，文件源却在 `return false` 里漏掉
     * 目录形态 —— 于是 `COPY a.txt → dirB/（Overwrite: F）` 回 **201**，
     * 下一次覆盖还会把目录占位对象 `dirB/` 写成文件内容（目录凭空消失）。
     * RFC 4918 §9.8.4 要求此时的结果是 409/412。
     */
    if (await head(prefix)) return true; // ② 目录占位对象
    try {
      const lvl = await listLevel(s3, cfg, prefix); // ③ 目录下任意一层子项
      return Boolean((lvl.files && lvl.files.length) || (lvl.dirs && lvl.dirs.length));
    } catch (e) { return false; }
  }
  // ② 目录占位对象（空目录）
  if (await head(prefix)) return true;
  // ③ 目录下任意一层子项
  try {
    const lvl = await listLevel(s3, cfg, prefix);
    return Boolean((lvl.files && lvl.files.length) || (lvl.dirs && lvl.dirs.length));
  } catch (e) { return false; }
}

/**
 * R27-16：条件请求求值（RFC 7232 §3.1 `If-Match` / §3.2 `If-None-Match`）。
 *
 * 为什么必须做：本服务在 HEAD / GET 上**宣告了 `ETag`**（`:648` / `:696`），而
 * 「宣告 ETag」在 HTTP 语义里就是承诺「客户端可以用它做条件写」。全库此前
 * `grep -i "if-match|if-none-match"` **零命中** —— 于是同步工具 / Office 在覆盖前发的
 * `PUT If-Match: "<etag>"`（或建新文件用的 `If-None-Match: *`）被**无条件执行**：
 * 客户端以为"我的版本没被别人改过"，服务端却直接覆盖，两边各自的修改静默丢一份。
 * 这类丢失没有任何报错，也是 WebDAV 客户端最难排查的一类问题。
 *
 * 只对**带了条件头**的请求多花一次 `headObject`（普通读写零开销）。
 * `If-Match` 用强比较（去掉 `W/` 与引号后逐字比）；`*` 表示"只要存在"。
 * 求值失败返回 `{ status, message }`，调用方据此回 412。
 *
 * @returns {Promise<null | {status:number, message:string}>} null = 条件满足，放行
 */
async function checkPreconditions(req, cfg, key) {
  const ifMatch = String(req.headers['if-match'] || '').trim();
  const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();
  if (!ifMatch && !ifNoneMatch) return null;

  let etag = '';
  try {
    const st = await gateway.headObject(cfg.bucket, key);
    etag = String((st && st.etag) || '');
  } catch (e) {
    etag = ''; // 不存在 / 探测失败 → 按「无当前实体」处理
  }
  const strip = (v) => String(v).replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
  const listOf = (v) => v.split(',').map(strip).filter(Boolean);
  const current = strip(etag);

  if (ifMatch) {
    if (ifMatch === '*') {
      if (!current) return { status: 412, message: '412 Precondition Failed：If-Match: * 但目标不存在' };
    } else if (!current || !listOf(ifMatch).includes(current)) {
      return {
        status: 412,
        message: `412 Precondition Failed：If-Match 与当前 ETag 不一致（服务端为 ${current || '（不存在）'}）—— `
          + '目标已被其它客户端修改，请先取回最新版本再重试',
      };
    }
  }
  if (ifNoneMatch) {
    if (ifNoneMatch === '*') {
      if (current) return { status: 412, message: '412 Precondition Failed：If-None-Match: * 但目标已存在' };
    } else if (current && listOf(ifNoneMatch).includes(current)) {
      return { status: 412, message: '412 Precondition Failed：If-None-Match 命中当前 ETag' };
    }
  }
  return null;
}

/**
 * 逐页遍历某前缀下的全部对象（**不截断**），每页回调一次。
 *
 * R8-16：`listRecursive()` 会在 `PROPFIND_CAP` 处静默截断并直接 return。这对
 * 「宁可截断也不能无界增长」的 PROPFIND 尚可（配合显式告警），但对 **COPY** 是
 * 灾难：源目录 6000 个对象时只复制前 5000 个，客户端拿到 201 后按协议删除源目录
 * → 永久丢失 1000 个对象。凡是"列举 → 复制/删除"的路径都必须逐页处理。
 *
 * @param {(items: object[], page: {isTruncated: boolean, nextMarker: string}) => any} onPage
 *   返回 `false` 表示调用方要求提前停止翻页。
 */
async function forEachPrefixPage(s3, cfg, prefix, onPage) {
  let marker = '';
  let more = true;
  while (more) {
    const data = await p(s3, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region,
      Prefix: prefix, Delimiter: '', Marker: marker, MaxKeys: 1000,
    }, { noStat: true });
    const items = [];
    for (const c of data.Contents || []) {
      if (c.Key === prefix) continue;
      items.push({ key: c.Key, size: Number(c.Size) || 0, lm: c.LastModified, dir: false });
    }
    const isTruncated = String(data.IsTruncated) === 'true';
    marker = data.NextMarker || (items.length ? items[items.length - 1].key : '');
    if (await onPage(items, { isTruncated, nextMarker: marker }) === false) return;
    more = isTruncated && !!marker;
  }
}

/**
 * 递归列举前缀下全部对象（Depth: infinity）—— **有上限**。
 *
 * PROPFIND 的响应体是整体驻留内存后一次发出的（`multistatus()`），因此这里刻意
 * 保留 `PROPFIND_CAP` 截断；但**必须把截断事实告诉调用方**（旧实现在函数中间
 * `return out`，调用方无从得知，用户只会觉得"目录少了东西"）。
 *
 * @returns {Promise<{items: object[], truncated: boolean}>}
 */
async function listRecursive(s3, cfg, prefix) {
  const out = [];
  let truncated = false;
  await forEachPrefixPage(s3, cfg, prefix, (items) => {
    for (const it of items) {
      if (out.length >= PROPFIND_CAP) { truncated = true; return false; }
      out.push(it);
    }
    return true;
  });
  return { items: out, truncated };
}

/**
 * R8-16 / R8-22：把「这次列举没列完」的事实显式告出去。
 *
 * RFC 4918 没有为 PROPFIND 定义截断语义（207 只是"多状态"），而 WebDAV 客户端
 * 也不读自定义响应头。刻意**不**往 207 体里塞伪 `<D:response>` —— 那会被资源管理器
 * 当成一个真实条目渲染成幽灵文件，比不提示更糟。因此用两条不干扰协议的通道：
 *  ① 响应头 `X-WebDAV-Truncated`（脚本化客户端 / 抓包排查时可见）；
 *  ② 审计日志 `level: 'warn'`（管理端「操作日志」里能查到具体路径与条数）。
 */
function noteTruncation(res, where, count, path) {
  res.setHeader('X-WebDAV-Truncated', String(count));
  res.setHeader('X-WebDAV-Truncated-Reason', 'PROPFIND_CAP');
  statsStore.addLog({
    action: 'webdav.propfind', level: 'warn',
    detail: `WebDAV 列举被截断：${where}「${path}」仅返回前 ${count} 项（上限 PROPFIND_CAP=${PROPFIND_CAP}），`
      + '客户端看到的目录不完整；请分目录访问或改用 Web 界面',
  });
}

module.exports = {
  requireS3, listLevel, destinationExists, checkPreconditions, forEachPrefixPage,
  listRecursive, noteTruncation,
};
