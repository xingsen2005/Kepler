/**
 * 第四十五轮护栏（R45）—— 用 S3 兼容协议接入 UCloud（US3）
 *
 * 需求（原文）：
 *  1. 使用 S3 兼容协议支持 UCloud，**注意 UCloud 可能存在「超过 1GB 必须分块上传」的限制**；
 *  2. 在厂商选择器中，UCloud 需要排在**七牛云与又拍云之间**；
 *  3. 给定的 UCloud SVG 图标「做和其他厂商一样的处理」。
 *
 * ## 三轮核实的结果：官方的硬限制是**三条**，不是一条
 *
 * UCloud《AWS S3 协议支持说明》的「Please note」逐字给出了三条（本轮实测抓取原文）：
 *   · PutObject currently only supports **1GB** file size（用户点名的那条）
 *   · CopyObject currently only supports a maximum file copy of **100MB**
 *   · UploadPart currently only supports **8MB fixed-length** part size
 *     （末片可小于 8MB；「dynamic part」需联系技术支持开通）
 * 另外该页明确 **UploadPartCopy 处于内测阶段**，且 **Only Support Signature V4**。
 *
 * ## 三条限制在**本项目里**各自的真实后果（这才是护栏要钉的东西）
 *
 * ① **1GB / PutObject**：项目自身的直传阈值是 8MB，WebDAV PUT 又整段缓冲在 128MB 内
 *    —— 结构上本来就够不着 1GB。所以它是**已经被满足**的那条。但「巧合满足」不算
 *    保证，本轮把厂商上限写进了**唯一的分直传/分片判据**（`simpleLimit`），
 *    让它成为可断言的结论：T11 钉住这一处取值。
 *
 * ② **8MB 定长分片**：**这条才是真正会炸的**。项目的分片算式
 *    `min(48MB, max(8MB, ceil(size/10000/MB) MB))` 对 1GB 的文件**恰好**算出 8MB
 *    （撞对），而 30GB 算出 9MB、480GB 算出 48MB —— 一律被 US3 以 400 拒绝。
 *    症状是「小文件正常、大文件必失败」，几乎必然被误判成网络问题。
 *    ⇒ 分片**钉死**为厂商值（T11），magic 模式的 5MB 性能上限也不得低于它（T10）。
 *
 * ③ **100MB / CopyObject**：**最容易踩、且原先代码确实在违反**的一条。原先
 *    「超过 5GB 且是 COS 才分块，否则一律 putObjectCopy」，其依据是「S3 兼容厂商的
 *    服务端复制不受单请求大小限制」—— 对 US3 不成立。于是「重命名 / 移动一个
 *    100MB~5GB 的对象」在别家正常、在 US3 必失败，而错误来自上游、只讲复制失败。
 *    ⇒ 判据收口到 `providers.copyNeedsSlice()`，三处复制路径共用（T7 / T12）。
 *
 * 附带（由 ② 推出）：S3 的 10000 片上限 × 8MB 定长 ⇒ **单文件上限 ≈ 78GB**，
 * 超过即无法通过 S3 协议上传（UCloud 官方 FAQ 对同一现象给了同号说明并建议改用
 * us3cli）。故 `upload/init` 当场拒绝并说明，而不是让用户传完 78GB 再收 400（T6 / T11）。
 *
 * ## 为什么 UCloud 必须走**路径风格**（否则整个厂商不可用）
 * UCloud 同时支持 Path Style 与 Virtual Host Style，但同一页明确：「Currently North
 * China 1, Hong Kong, …, and Washington regions already support https protocol, other
 * regions can support **path style https**, and **virtual host style https will be
 * supported in the future**」。本项目一律走 `https://`，而大多数用户会在**未列出的
 * 地域**建桶 ⇒ 虚拟主机风格会静默连不上（与 R26-05 的 MinIO 同型）。T8 钉住这一点。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R45-*` 条目。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers.js');

process.env.S3_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 's3-audit45-'));

const providers = require(path.join(ROOT, 'server', 'providers.js'));
const s3 = require(path.join(ROOT, 'server', 's3.js'));
const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MB = 1024 * 1024;
const GB = 1024 * MB;

/* ================================================================== *
 * ① 注册表：登记位置、元数据、以及「不继承别家的开关」
 * ================================================================== */

test('R45-01a · UCloud 必须登记在**七牛云与又拍云之间**，且元数据齐备', () => {
  const ids = providers.list().map((p) => p.id);
  const i = ids.indexOf('ucloud');
  assert(i >= 0, 'R45-01a：注册表里必须新增 ucloud');
  assertEqual(ids[i - 1], 'qiniu', 'R45-01a：UCloud 的前一家必须是七牛云（需求点名了顺序）');
  assertEqual(ids[i + 1], 'upyun', 'R45-01a：UCloud 的后一家必须又拍云（需求点名了顺序）');

  const p = providers.get('ucloud');
  assertEqual(p.kind, 's3', 'R45-01a：必须走 S3 兼容协议');
  assertEqual(p.shortName, 'US3', 'R45-01a：对象存储产品名为 US3');
  assertEqual(p.regionRequired, true, 'R45-01a：US3 的端点是地域相关的，地域必填');
  assertEqual(providers.isS3('ucloud'), true, 'R45-01a：isS3 必须为真（否则会走错客户端）');
  // R49：`isCos` 已整体删除（腾讯云并入 S3 后没有任何厂商走 COS 原生协议）——
  // 这里改为断言「这个概念不存在」：谁把它加回来，本行立刻变红。
  assertEqual(providers.isCos, undefined, 'R45-01a：`isCos` 必须已删除（否则它恒等于 isS3，厂商差异会静默扩散）');
  assertEqual(providers.isAzure('ucloud'), false, 'R45-01a：不得被当成 Azure');

  // 端点：官方为 protocol://s3-<region_code>.<custom_domain>，本例域名为 ufileos.com
  assertEqual(providers.endpointFor('ucloud', 'cn-bj'), 'https://s3-cn-bj.ufileos.com',
    'R45-01a：地域必须填进主机名中段（与阿里云/七牛/AWS 同型）');
  assertEqual(providers.endpointFor('ucloud', 'hk'), 'https://s3-hk.ufileos.com',
    'R45-01a：中国香港地域同理');
  assertEqual(providers.endpointFor('ucloud', ''), 'https://s3-cn-bj.ufileos.com',
    'R45-01a：未填地域时回落到华北-北京（regionRequired 已保证界面会拦下空值）');

  // 凭据：官方口径是 API 公钥 / 私钥（或 US3 令牌公私钥），不是账号密码
  assertEqual(p.credentialLabel.id, 'API 公钥', 'R45-01a：字段名必须用 UCloud 自己的叫法');
  assertEqual(p.credentialLabel.key, 'API 私钥', 'R45-01a：同上');
});

test('R45-01b · UCloud 不得顺手继承别家的厂商特权（三处开关都必须是 false）', () => {
  assertEqual(providers.unsignedPayload('ucloud'), false,
    'R45-01b：UNSIGNED-PAYLOAD 只给华为云开 —— US3 未声明该限制，跟着开毫无收益');
  assertEqual(providers.queryBucketLocation('ucloud'), false,
    'R45-01b：GetBucketLocation 补查只给华为云开 —— 每家多一次请求，不能顺手开');
  assertEqual(providers.PROVIDERS.filter((p) => p.unsignedPayload).length, 1,
    'R45-01b：全表仍只允许一家声明 unsignedPayload');
  assertEqual(providers.PROVIDERS.filter((p) => p.queryBucketLocation).length, 1,
    'R45-01b：全表仍只允许一家声明 queryBucketLocation');

  // UCloud 官方支持两种 URL 风格，但 https 下虚拟主机风格**多数地域尚未支持** ——
  // 混淆端点风格会让整个厂商静默不可用，故这里是 hard true，不是「可选项」。
  assertEqual(providers.forcePathStyle('ucloud'), true,
    'R45-01b：必须走路径风格（官方：其余地域的 virtual host style https「will be supported in the future」）');
});

/* ================================================================== *
 * ② 三条容量判据（真实 providers.js）
 * ================================================================== */

test('R45-02a · putObjectMaxBytes：只有声明了单请求上限的厂商才不是 Infinity', () => {
  assertEqual(providers.putObjectMaxBytes('ucloud'), 1 * GB,
    'R45-02a：US3 的 PutObject 上限是 1GB（官方原文：only supports 1GB file size）');
  assertEqual(providers.putObjectMaxBytes('aws'), Infinity, 'R45-02a：未声明 = 无更严约束');
  assertEqual(providers.putObjectMaxBytes('tencent'), Infinity, 'R45-02a：COS 同理');
  assertEqual(providers.putObjectMaxBytes('不存在的厂商'), Infinity,
    'R45-02a：未知厂商回退到默认厂商后同样不得凭空给出上限');

  // 非法值一律当「未声明」，绝不返回 NaN（NaN 参与比较恒 false，会让判据静默失效）
  const bad = [
    { id: 'x1', putObjectMaxBytes: 0 }, { id: 'x2', putObjectMaxBytes: -5 },
    { id: 'x3', putObjectMaxBytes: 'abc' }, { id: 'x4', putObjectMaxBytes: null },
  ];
  for (const b of bad) {
    providers.PROVIDERS.push(b);
    const v = providers.putObjectMaxBytes(b.id);
    providers.PROVIDERS.pop();
    assertEqual(v, Infinity, `R45-02a：非法声明 ${JSON.stringify(b.putObjectMaxBytes)} 必须归为「未声明」`);
  }
});

test('R45-02b · fixedPartBytes：0 表示「无定长要求」，且只有 UCloud 声明 8MB', () => {
  assertEqual(providers.fixedPartBytes('ucloud'), 8 * MB,
    'R45-02b：US3 只接受 8MB 定长分片（官方原文：8MB fixed-length part size）');
  assertEqual(providers.fixedPartBytes('upyun'), 0, 'R45-02b：未声明 = 无此要求');
  assertEqual(providers.fixedPartBytes('aws'), 0, 'R45-02b：AWS 只要求 ≥5MB，不是定长');
  assertEqual(providers.PROVIDERS.filter((p) => p.fixedPartBytes > 0).map((p) => p.id).join(','),
    'ucloud',
    'R45-02b：定长分片是厂商差异 —— 不能顺手给别家也钉上（那会把大文件分片压小、成倍增加请求数）');
});

test('R45-02c · multipartMaxBytes：定长分片 × 10000 片 = 单文件上限 ≈ 78GB', () => {
  const cap = providers.multipartMaxBytes('ucloud');
  assertEqual(cap, 10000 * 8 * MB,
    'R45-02c：天花板必须是「分片数上限 × 定长分片」');
  assertEqual(Math.floor(cap / GB), 78,
    'R45-02c：换算成 GB 应约为 78（与 UCloud 官方 FAQ 的「超过 78G 报 400」同号）');
  assert(cap > 78 * GB && cap < 79 * GB, 'R45-02c：应在 78~79 GB 之间（78.125GiB）');

  assertEqual(providers.multipartMaxBytes('aws'), Infinity,
    'R45-02c：不声明定长分片的厂商不受此限（分片会随体积增长，10000 片覆盖到 5TB）');
  assertEqual(providers.multipartMaxBytes('b2'), Infinity, 'R45-02c：同上');
});

test('R45-02d · copyNeedsSlice：三家判定都对，且**未声明上限的厂商行为不变**', () => {
  // UCloud：100MB 是边界 —— 正好 100MB 仍可单请求，超过就必须分块
  assertEqual(providers.copyNeedsSlice('ucloud', 100 * MB), false,
    'R45-02d：正好等于上限仍可走单请求复制');
  assertEqual(providers.copyNeedsSlice('ucloud', 100 * MB + 1), true,
    'R45-02d：超过 100MB 必须分块（官方原文：CopyObject only supports a maximum of 100MB）');
  assertEqual(providers.copyNeedsSlice('ucloud', 6 * GB), true, 'R45-02d：6GB 当然也超');
  assertEqual(providers.copyNeedsSlice('ucloud', 50 * MB), false, 'R45-02d：50MB 走单请求');

  // COS：上限仍是项目默认的 5GB（本轮不得被改动）
  assertEqual(providers.copyNeedsSlice('tencent', 6 * GB), true, 'R45-02d：COS 超过 5GB 走分块复制');
  assertEqual(providers.copyNeedsSlice('tencent', 3 * GB), false, 'R45-02d：COS 3GB 仍走单请求');

  /**
   * ⭐ 反向对照：**未声明 `copyObjectMaxBytes` 的 S3 兼容厂商行为必须原样保留**。
   *
   * 这条不是「顺手漏了」，而是本轮刻意的取舍：改掉它会同时改写 7 家厂商的复制路径，
   * 而 `S3Client.sliceCopyFile` 此前从未被任何路径实际走到（R49 之前，S3 侧的分块复制
   * 只在 `isCos` 为真时才被调用，而那是腾讯云的 COS SDK 路径）—— 贸然切过去等于把
   * 「装不上 UCloud」的修复扩大成一次无人验证的复制重写。若将来要修 AWS 自己的 5GB
   * 上限，给它的注册表条目加一个 `copyObjectMaxBytes` 即可（判据不必再动）。
   */
  for (const id of ['aws', 'aliyun', 'huawei', 'qiniu', 'upyun', 'gcs', 'b2', 'minio', 'r2']) {
    assertEqual(providers.copyNeedsSlice(id, 6 * GB), false,
      `R45-02d：${id} 未声明 CopyObject 上限 —— 超过 5GB 时**仍**交给 putObjectCopy（历史行为）`);
  }

  // 尺寸未知（0 / NaN / 缺省）一律**按最保守走单请求**，不得因为「算不出大小」就分块
  assertEqual(providers.copyNeedsSlice('ucloud', 0), false, 'R45-02d：0 字节按不可知处理');
  assertEqual(providers.copyNeedsSlice('ucloud', undefined), false, 'R45-02d：未给大小同理');
  assertEqual(providers.copyNeedsSlice('ucloud', 'abc'), false, 'R45-02d：非法值同理');
});

/* ================================================================== *
 * ③ 客户端工厂 + 真实分块复制（行为层）
 * ================================================================== */

test('R45-03a · s3.createClient：路径风格 + 定长分片都必须真的下发到客户端', () => {
  const client = s3.createClient({
    provider: 'ucloud', secretId: 'pub', secretKey: 'priv',
    region: 'cn-bj', bucket: 'demo-bucket', endpoint: '',
  });

  assertEqual(client.endpoint, 'https://s3-cn-bj.ufileos.com',
    'R45-03a：端点必须按地域拼出（漏了这一步会打到 AWS 默认端点）');
  assertEqual(client._virtualHosted(), false,
    'R45-03a：必须走路径风格 —— 漏传 forcePathStyle 会让每个请求都解析不到主机');

  const url = client.getObjectUrl({ Bucket: 'demo-bucket', Key: 'dir/a b.txt', Sign: true }).Url;
  assert(/^https:\/\/s3-cn-bj\.ufileos\.com\/demo-bucket\/dir\/a%20b\.txt\?/.test(url),
    `R45-03a：桶名必须落在**路径**上（实际 ${url.split('?')[0]}）`);

  /**
   * ⭐ 第三个可被独立摘掉的地方：**工厂漏传 `fixedPartBytes`**。
   *
   * 只钉住 providers 与 s3-client 两处的话，`s3.js` 里少传一个字段照旧全绿，
   * 而线上表现是「UCloud 的分块复制发 64MB 分片、被 400 拒绝」。
   * 与 R26-05 对 `forcePathStyle` 的用法同型。
   */
  assertEqual(client.fixedPartBytes, 8 * MB,
    'R45-03a：s3.createClient 必须把厂商的定长分片传给 S3Client（漏传 = 分块复制必 400）');

  const aws = s3.createClient({
    provider: 'aws', secretId: 'AKIAEXAMPLE', secretKey: 'sk',
    region: 'us-east-1', bucket: 'b', endpoint: '',
  });
  assertEqual(aws.fixedPartBytes, 0,
    'R45-03a：未声明定长分片的厂商必须是 0（证明上面不是「一律 8MB」）');

  // 构造器缺省（例如别处直接 new）也不得凭空得到 8MB
  const bare = new S3Client({ accessKeyId: 'k', secretAccessKey: 's', endpoint: 'https://s3-cn-bj.ufileos.com', bucket: 'b' });
  assertEqual(bare.fixedPartBytes, 0, 'R45-03a：S3Client 的缺省值必须是 0');
});

/* ---- 出站拦截：把网络层换掉，观察真实发出的请求 ---- */

const realFetch = global.fetch;
let captured = [];

function headersOf(init) {
  const h = {};
  const hd = (init && init.headers) || {};
  if (typeof hd.forEach === 'function') hd.forEach((v, k) => { h[k.toLowerCase()] = v; });
  else for (const [k, v] of Object.entries(hd)) h[k.toLowerCase()] = v;
  return h;
}

/** 只回答分块复制需要的那几个请求（HEAD / init / part copy / complete） */
function installFetch(totalBytes) {
  captured = [];
  global.fetch = (url, init) => {
    const u = new URL(String(url));
    const method = String((init && init.method) || 'GET').toUpperCase();
    captured.push({ url: String(url), method, headers: headersOf(init), params: u.searchParams, host: u.host, pathname: u.pathname });

    if (method === 'HEAD') {
      return Promise.resolve(new Response('', { status: 200, headers: { 'content-length': String(totalBytes) } }));
    }
    if (method === 'POST' && u.searchParams.get('uploads') === '') {
      return Promise.resolve(new Response(
        '<InitiateMultipartUploadResult><Bucket>demo-bucket</Bucket><Key>big.bin</Key><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>',
        { status: 200, headers: { 'content-type': 'application/xml' } }));
    }
    if (method === 'PUT' && u.searchParams.get('partNumber')) {
      const n = u.searchParams.get('partNumber');
      return Promise.resolve(new Response(
        `<CopyPartResult><ETag>"etag-${n}"</ETag></CopyPartResult>`,
        { status: 200, headers: { 'content-type': 'application/xml' } }));
    }
    // multipartComplete
    return Promise.resolve(new Response(
      '<CompleteMultipartUploadResult><Location>l</Location><Bucket>demo-bucket</Bucket><Key>big.bin</Key><ETag>"e"</ETag></CompleteMultipartUploadResult>',
      { status: 200, headers: { 'content-type': 'application/xml' } }));
  };
}
process.on('exit', () => { global.fetch = realFetch; });

const partRanges = () => captured
  .filter((c) => c.method === 'PUT' && c.params.get('partNumber'))
  .map((c) => c.headers['x-amz-copy-source-range']);

test('R45-03b · sliceCopyFile 真的按 8MB 切片；同尺寸在未声明的厂商上仍是 64MB（反向对照）', async () => {
  const TOTAL = 20 * MB; // 8MB + 8MB + 4MB —— 末片 <8MB 是官方允许的
  const call = async (id) => {
    installFetch(TOTAL);
    const client = s3.createClient({
      provider: id, secretId: 'pub', secretKey: 'priv',
      region: id === 'ucloud' ? 'cn-bj' : 'us-east-1', bucket: 'demo-bucket', endpoint: '',
    });
    await client.sliceCopyFile({ Bucket: 'demo-bucket', Key: 'copy.bin', CopySource: '/demo-bucket/big.bin' });
    return partRanges();
  };

  // ① 源对象 HEAD 打的是**源桶**，且走路径风格（桶名在路径上）
  const ucloudRanges = await call('ucloud');
  assertEqual(captured.length, 1 + 1 + 3 + 1,
    `R45-03b：UCloud 应发出 HEAD + init + 3 片 + complete = 6 个请求，实际 ${captured.length}`);
  assertEqual(captured[0].method, 'HEAD', 'R45-03b：第一个请求应是探测源对象大小的 HEAD');
  assertEqual(captured[0].host, 's3-cn-bj.ufileos.com', 'R45-03b：HEAD 也必须打厂商端点');
  assertEqual(captured[0].pathname, '/demo-bucket/big.bin',
    'R45-03b：路径风格 —— 桶名在路径上而不是主机名前缀');

  assertEqual(ucloudRanges.join(' '), 'bytes=0-8388607 bytes=8388608-16777215 bytes=16777216-20971519',
    'R45-03b：US3 的分块复制必须发出 **8MB 定长**分片（末片 4MB）');

  // ② 反向对照：同一份代码、同一个尺寸，在未声明定长分片的厂商上仍是 64MB 单片
  const awsRanges = await call('aws');
  assertEqual(awsRanges.join(' '), 'bytes=0-20971519',
    'R45-03b：AWS 未声明定长分片 —— 20MB 应合成**单片** 64MB 以内的复制（证明下发值真的在起作用）');

  // ③ 显式入参优先于厂商值（回归保护：将来有人把顺序写反，这条会红）
  installFetch(TOTAL);
  const explicit = s3.createClient({
    provider: 'ucloud', secretId: 'pub', secretKey: 'priv', region: 'cn-bj', bucket: 'demo-bucket', endpoint: '',
  });
  await explicit.sliceCopyFile({ Bucket: 'demo-bucket', Key: 'copy.bin', CopySource: '/demo-bucket/big.bin', PartSize: 16 * MB });
  assertEqual(partRanges().join(' '), 'bytes=0-16777215 bytes=16777216-20971519',
    'R45-03b：显式 PartSize 必须优先（仍不得低于协议下限 8MB）');
});

/* ================================================================== *
 * ④ 落点收口：同一判断不得在多处各写一遍
 * ================================================================== */

test('R45-04a · magic 分片上限：magicChunkCap 是唯一实现点，三处调用点同源', () => {
  const src = readSrc('server', 'routes', 'fs.js');

  assert(/function magicChunkCap\(provider\) \{\s*\n\s*return Math\.max\(MAGIC_CHUNK_MAX, providers\.fixedPartBytes\(provider\)\);/.test(src),
    'R45-04a：magicChunkCap 必须是「性能上限与厂商定长要求取大」—— 取小会算出对 US3 非法的 5MB');

  /**
   * 三个调用点各自都要在场。**这里用带上下文的整串**而不是裸 `magicChunkCap(sess.provider)`：
   * 后者在同一文件里有 4 处（其中一处是解释本条的注释本身），裸串断言既会数进注释、
   * 也无法区分「哪一处被摘掉」。
   */
  const sites = [
    ['upload/init 的会话创建', 'Math.min(plainChunkFinal, magicChunkCap(cfg.provider))'],
    ['断点续传的拒绝判据', 'sess.chunkSize > magicChunkCap(sess.provider)'],
    ['拒绝文案里的上限值', '`${magicChunkCap(sess.provider)} 字节；加密方式在上传过程中刚切换到 magic，`'],
    ['chunk 路由的兜底上限', '? magicChunkCap(sess.provider) : UPLOAD_CHUNK_MAX'],
  ];
  for (const [where, needle] of sites) {
    assertEqual(src.split(needle).length - 1, 1,
      `R45-04a：${where} 必须调用 magicChunkCap（且只出现一次）—— 摘掉它会让该路径退回非法的 5MB`);
  }
});

test('R45-04b · upload/init：直传分界受厂商上限约束、分片被钉死、超天花板当场拒绝', () => {
  const src = readSrc('server', 'routes', 'fs.js');

  assert(src.includes('providers.putObjectMaxBytes(cfg.provider)'),
    'R45-04b：simpleLimit 必须与厂商的单请求上限取小 —— 否则「超过厂商上限一定走分片」只是巧合');
  assertEqual(src.split('providers.putObjectMaxBytes(cfg.provider)').length - 1, 1,
    'R45-04b：分直传/分片的判据只允许一处');

  assert(src.includes('const fixedPart = providers.fixedPartBytes(cfg.provider);'),
    'R45-04b：必须读取厂商的定长分片值');
  assert(src.includes('const plainChunkFinal = fixedPart > 0 ? fixedPart : plainChunk;'),
    'R45-04b：声明了定长分片的厂商必须**钉死**分片尺寸（不是当作下限）');

  assert(src.includes('const maxMultipart = providers.multipartMaxBytes(cfg.provider);'),
    'R45-04b：必须读取厂商的分片上传天花板');
  assert(/if \(size > maxMultipart\) \{/.test(src),
    'R45-04b：超过天花板必须**在 init 当场拒绝**，而不是让用户传完 78GB 再收 400');
  assert(/e\.status = 400;/.test(src.slice(src.indexOf('if (size > maxMultipart)'), src.indexOf('if (size > maxMultipart)') + 700)),
    'R45-04b：该拒绝必须是 400（配置/参数类错误，而非 500）');
  assert(src.includes('providers.nameOf(cfg.provider)') && src.includes('10000 片上限'),
    'R45-04b：文案要说清是「哪家 + 为什么」—— 只说「分片大小不对」等于没说');
});

test('R45-04c · 三处复制路径都只经 providers.copyNeedsSlice，旧常量已彻底移除', () => {
  const fsSrc = readSrc('server', 'routes', 'fs.js');
  const gwSrc = readSrc('server', 'fs-gateway.js');
  const provSrc = readSrc('server', 'providers.js');

  // 三处调用点（各自只一次）—— 少任何一处都会让某条路径退回「超过 100MB 也走 putObjectCopy」
  const sites = [
    [fsSrc, 'routes/fs.js 的 copyOne（管理界面重命名 / 移动）', 'providers.copyNeedsSlice(cfg.provider, n)'],
    [gwSrc, 'fs-gateway.js 的 copyObject（WebDAV COPY）', 'providers.copyNeedsSlice(cfg.provider, given)'],
    [gwSrc, 'fs-gateway.js 的 copyObject 探测分支', 'providers.copyNeedsSlice(cfg.provider, srcSize)'],
    [gwSrc, 'fs-gateway.js 的目录 MOVE 复制循环', 'providers.copyNeedsSlice(cfg.provider, it.size)'],
  ];
  for (const [src, where, needle] of sites) {
    assertEqual(src.split(needle).length - 1, 1,
      `R45-04c：${where} 必须经唯一判据 ${needle}`);
  }

  /**
   * ⭐ 旧的两份 5GB 常量必须**彻底消失**。
   *
   * `COPY_SIMPLE_LIMIT` 原先在 `routes/fs.js` 与 `fs-gateway.js` 各持一份（「同一类
   * 常量多份实现」的典型）。本轮把判据收进 `providers.js` 之后，只要这两处**还在
   * 引用**它，就意味着有人把旧写法复活了一半 —— 而那一半会静默漏掉 UCloud。
   * `limits.js` 里的定义本身保留（那是权威来源，由 `providers.js` 消费）。
   */
  assertEqual(fsSrc.split('COPY_SIMPLE_LIMIT').length - 1, 0,
    'R45-04c：routes/fs.js 不得再引用 5GB 常量（判据已收口到 providers.copyNeedsSlice）');
  assertEqual(gwSrc.split('COPY_SIMPLE_LIMIT').length - 1, 0,
    'R45-04c：fs-gateway.js 同上');
  assertEqual(provSrc.split('LIMITS.COPY_SIMPLE_LIMIT').length - 1, 2,
    'R45-04c：providers.js 里应恰好两处（一处说明 + 腾讯云条目上的一处声明）。'
    + 'R49 起判据只认「厂商声明的上限」，不再有 `isCos && >5GB` 的第二段'
    + '（多出来说明判据被写重复了）');

  // 两条路径原先都带 `isCos` 分支 —— 已并入唯一判据；该函数 R49 起整体删除，更不得残留
  assertEqual(gwSrc.split('providers.isCos(cfg.provider)').length - 1, 0,
    'R45-04c：fs-gateway.js 不得再按厂商分叉（残留 isCos 分支 = 漏掉 UCloud）');
});

/* ================================================================== *
 * ⑤ 前端：图标与顺序（与注册表同源）
 * ================================================================== */

test('R45-05a · 前端厂商标识：UCloud 图形、展示顺序、表单文案三处都到位', async () => {
  const mod = await import(require('url').pathToFileURL(path.join(ROOT, 'public', 'js', 'provider-logos.js')).href);

  const ids = mod.providerList().map((p) => p.id);
  const i = ids.indexOf('ucloud');
  assert(i >= 0, 'R45-05a：前端选择器必须出现 UCloud');
  assertEqual(ids[i - 1], 'qiniu', 'R45-05a：需求点名「UCloud 需要在七牛云和又拍云之间」');
  assertEqual(ids[i + 1], 'upyun', 'R45-05a：同上');
  assertEqual(ids.join(','), providers.list().map((p) => p.id).join(','),
    'R45-05a：前端 ORDER 必须与服务端注册表顺序逐字一致（audit26 的跨端护栏同源）');

  const meta = mod.providerMeta('ucloud');
  assertEqual(meta.name, 'UCloud', 'R45-05a：显示名');
  assertEqual(meta.shortName, 'US3', 'R45-05a：产品名');
  assertEqual(meta.kind, 's3', 'R45-05a：协议类型');
  assertEqual(meta.idLabel, providers.get('ucloud').credentialLabel.id,
    'R45-05a：前端字段名与服务端 credentialLabel 必须同值（否则表单提示与实际取值两套叫法）');
  assertEqual(meta.keyLabel, providers.get('ucloud').credentialLabel.key, 'R45-05a：同上');

  /**
   * 图形：与其余厂商**逐字同款的处理** —— 只保留 `viewBox` + `fill` + `d`，
   * 剥掉 `p-id` / `class` / `t` / `width` / `height` 这些图标站的生成期噪声。
   * 渲染出来必须是**单个 path**（多出来的属性/标签都是处理没做干净）。
   */
  const svg = mod.providerLogoSvg('ucloud');
  assert(svg.length > 100, 'R45-05a：必须能生成图形');
  assert(/^<svg viewBox="0 0 1024 1024" preserveAspectRatio="xMidYMid meet" aria-hidden="true">/.test(svg),
    'R45-05a：容器属性必须与其余厂商同款（等比缩放居中）');
  assertEqual(svg.split('<path').length - 1, 1, 'R45-05a：UCloud 图形应为单条 path');
  assert(svg.includes('fill="#385FF5"'), 'R45-05a：品牌蓝必须保留（丢了会渲染成默认黑色）');
  assert(/d="M945\.883 66\.706/.test(svg), 'R45-05a：路径数据必须是原始 SVG 的那一条');
  assert(!/p-id|class=|width="200"/.test(svg), 'R45-05a：生成期噪声属性必须剥掉');

  // 每个登记厂商都必须有图 —— 缺图会在选择器里留一块空白（静默、不报错）
  const missing = ids.filter((id) => mod.providerLogoSvg(id) === '');
  assertEqual(missing.join(','), '', `R45-05a：这些厂商没有图形：${missing.join(',')}`);
});
