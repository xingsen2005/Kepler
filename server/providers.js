/**
 * 服务商注册表 —— 统一描述各对象存储厂商的连接参数与能力差异
 *
 *  - kind: 's3'    → 使用 AWS Signature V4 + S3 兼容 REST 协议（自研 s3-client）
 *          'azure' → Azure Blob 独立协议（Shared Key + Block Blob，见 azure-client.js）
 *          'planned' → 已在界面列出但暂未开放接入
 *  ⚠️ R49：腾讯云原先的 'cos' 这一 kind 已删除 —— 它现在也是 's3'，与其余厂商共用同一条
 *  代码路径（此前 COS 与 S3 两套实现并存，任何修复都要写两遍、漏一处就出现「某个厂商上不对」）。
 *  - endpoint: S3 兼容厂商的默认服务端点（可被密钥记录中的自定义 endpoint 覆盖）
 *  - regionRequired: 是否必须填写地域
 *  - defaultRegion: 厂商要求「填了等价于没填」的固定地域值（如 R2 / GCS 的 auto）。
 *      仅作**界面提示**，不参与任何判定 —— 真正的地域解析在 {@link regionFor}。
 *  - forcePathStyle: 是否强制路径风格（`https://host/bucket/key`）。
 *      自建对象存储（MinIO 等）多以 IP / 无 DNS 泛解析的域名暴露，
 *      默认的虚拟主机风格会拼出 `bucket.<host>` 而无法解析 —— 必须走路径风格。
 *  - endpointMode: 服务端点这一栏在密钥表单里的**输入形态**，同时也是
 *      {@link composeEndpoint} 的分支依据：
 *        'derived' —— 由地域自动推导，无需用户填写（无此字段时不渲染该栏）；
 *        'required' —— 用户必须直接填写完整端点（自建部署，如 MinIO）；
 *        'template' —— 用户填写的是**端点前缀**，与本厂商的 endpointTemplate
 *                      一起拼成完整端点（如 Cloudflare R2 的账户 ID）。
 *  - endpointLabel / endpointPlaceholder / endpointHint: 端点输入栏的文案
 *  - credentialLabel: 密钥字段在各厂商控制台中的习惯叫法
 *  - secretIdPrefix（R49）：该厂商对**访问密钥 ID** 的前缀约定（目前只有腾讯云 `AKID`）。
 *      它是「这一家控制台怎么发密钥」，不是「某种协议的性质」—— 因此走注册表字段，
 *      而**不是**再写一个 `isCos()` 之类的协议分支（见 {@link secretIdPrefix} 的说明）。
 *  - putObjectMaxBytes / fixedPartBytes / copyObjectMaxBytes（R45）：**厂商侧的容量
 *      硬限制**，均为「可选的更严约束」，未声明即沿用项目自身的阈值。
 *      访问器分别是 {@link putObjectMaxBytes} / {@link fixedPartBytes} /
 *      {@link copyNeedsSlice} 与 {@link multipartMaxBytes} —— 取值为 Infinity 或 0
 *      时表示该厂商没有这条限制，调用方**不得**自行写 `||` 兜底数字。
 *
 * 未在此登记或 kind 为 'planned' 的厂商，仅用于界面展示与文案统一，
 * 服务端会在建立连接时给出明确的不支持提示。
 */

const { LIMITS } = require('./limits');

/**
 * 单次分片上传允许的**分片数上限**（S3 协议规定 10000 片）。
 *
 * 它是所有厂商共用的协议常量，本身与厂商无关；但与「定长分片」结合后会变成
 * **单文件上限**（见 {@link multipartMaxBytes}）—— UCloud 的 8MB 定长 × 10000 片
 * ≈ 78GB，超过即无解（UCloud 官方 FAQ 对同一现象给了同号说明）。放在这里而不是
 * `limits.js`：它是 S3 协议的组成部分，`limits.js` 收的是本项目自己的运行期上限。
 */
const PART_COUNT_MAX = 10000;

const PROVIDERS = [
  {
    id: 'tencent',
    name: '腾讯云',
    shortName: 'COS',
    /**
     * R49：腾讯云由 **COS 原生协议**并入 **S3 兼容协议**。
     *
     * 此前它走 `cos-nodejs-sdk-v5`（一套独立实现：自己的对象形状、自己的分页器、
     * 自己的复制语义、自己的错误码），于是「COS 与 S3 两套实现并存，任何修复都要
     * 写两遍」—— 漏一处就是「某个厂商上不对，别的都好好的」。现在与其余厂商共用
     * `s3-client` 一条路径，`kind` 也从 `'cos'` 并成 `'s3'`（`isCos()` 随之删除）。
     *
     * ## 端点
     * COS 的 S3 兼容域名是 `cos.<region>.myqcloud.com`（虚拟主机风格为
     * `<桶>.cos.<region>.myqcloud.com`）。注册表里给了**含地域的静态默认端点**，
     * 于是「地域留空时端点回退到 ap-guangzhou、签名地域也必须反推成 ap-guangzhou」
     * —— 这是 R46 那条纪律（端点里烘焙的地域必须与签名地域同源），
     * 因此 `s3-client.js` 的域名清单里必须有 `myqcloud.com`，
     * 且 `tests/audit42-regressions.test.js` 的 CONFORMANCE 必须登记腾讯云。
     *
     * ap-guangzhou 是**默认值不是唯一值**：`regionRequired: true` 已保证界面会拦下
     * 空地域，这个静态端点只服务于「凭据校验」这类拿不到地域的路径
     * （旧版 COS SDK 的 `Region` 缺省同样是 ap-guangzhou，行为未变）。
     *
     * ## 桶容量
     * COS 原生的 `GET /?stats` 接口随 SDK 一并移除 —— S3 协议**没有**「读桶容量」
     * 这个操作。腾讯云因此与其余厂商一样回退到分页列举估算（见 `bucket-stats.js`），
     * 代价是对象数超过 5000 时只能给下界。
     */
    kind: 's3',
    endpoint: 'https://cos.ap-guangzhou.myqcloud.com',
    endpointTemplate: 'https://cos.{region}.myqcloud.com',
    regionRequired: true,
    regionPlaceholder: '例如 ap-guangzhou',
    regionHint: '腾讯云对象存储所在地域，如 ap-guangzhou（广州）、ap-shanghai（上海）',
    credentialLabel: { id: 'SecretId', key: 'SecretKey', idPlaceholder: 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    /**
     * 腾讯云的 SecretId 一律以 `AKID` 开头（全厂商里**唯一**有前缀约定的一家）。
     *
     * R49 之前这条规则写在 `routes/_shared.js` 里、以 `isCos(pid)` 为分支 —— 而
     * `isCos` 现在等价于 `isS3`，照搬会让**阿里云 / 华为云 / 七牛……的密钥全部被拒**。
     * 因此把这条厂商知识搬回注册表：它从来不是「COS 协议的性质」，
     * 而是「腾讯云这一家的凭据格式」。
     */
    secretIdPrefix: 'AKID',
    /**
     * COS 单次 `PUT Copy`（`CopyObject`）的上限是 **5GB**，超过必须走
     * `UploadPartCopy`（`S3Client#sliceCopyFile`）。
     *
     * 由**注册表声明**而不是在 `copyNeedsSlice()` 里写一个 `isCos(id)` 分支：
     * 那样一来「腾讯云的复制要分块」就只可能来自这一处判据，
     * 而其余 8 家厂商的 `copyObjectMaxBytes` 一律为未声明 —— 语义统一。
     * 取值直接复用 `LIMITS.COPY_SIMPLE_LIMIT`：S3 协议族的分界线本就是同一个 5GB，
     * 两处各写一个 5GB 才是真正的隐患（改一处漏一处）。
     */
    copyObjectMaxBytes: LIMITS.COPY_SIMPLE_LIMIT,
  },
  {
    id: 'aliyun',
    name: '阿里云',
    shortName: 'OSS',
    kind: 's3',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    endpointTemplate: 'https://oss-{region}.aliyuncs.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-hangzhou',
    regionHint: '阿里云对象存储所在地域，如 cn-hangzhou（杭州）、cn-beijing（北京）',
    credentialLabel: { id: 'AccessKey ID', key: 'AccessKey Secret', idPlaceholder: 'LTAIxxxxxxxxxxxxxxxx' },
  },
  {
    id: 'huawei',
    name: '华为云',
    shortName: 'OBS',
    kind: 's3',
    endpoint: 'https://obs.cn-north-4.myhuaweicloud.com',
    endpointTemplate: 'https://obs.{region}.myhuaweicloud.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-north-4',
    regionHint: '华为云对象存储所在地域，如 cn-north-4（北京四）、cn-east-3（华东三）',
    credentialLabel: { id: 'Access Key ID', key: 'Secret Access Key', idPlaceholder: '请输入 Access Key ID' },
    /**
     * R42：华为云 OBS 的 V4 签名**只接受** `UNSIGNED-PAYLOAD`（以及流式分块的
     * `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`）两种载荷哈希，**不接受**「真实请求体
     * 的 SHA-256」。见华为云官方 FAQ《如何使用 V4 签名访问 OBS》的「约束与限制」：
     * 「V4 仅支持 UNSIGNED-PAYLOAD、STREAMING-AWS4-HMAC-SHA256-PAYLOAD 2 种模式」。
     *
     * 为什么这条必须由注册表下发：默认实现（AWS 规范）对**带体请求**发的是真实
     * SHA-256 —— 在 AWS / 阿里云 / 七牛 / MinIO 上都合法，唯独 OBS 会以
     * `403 SignatureDoesNotMatch` 拒绝，而报文里**不带任何线索**，界面只会显示
     * 「签名错误：请检查 AccessKey / SecretKey 是否正确」，把运维引向轮换一把
     * 完全有效的密钥（正是本轮用户报的「正确的 key 也无法绑定」）。
     * 这也解释了为何「用 aws-cli / boto3 能传、自研客户端不能」：boto3 与 aws-cli
     * 在 HTTPS 下默认就发 UNSIGNED-PAYLOAD（`payload_signing_enabled` 默认关闭），
     * 真实载荷哈希根本不会出现在请求里。
     *
     * ⚠️ **只给华为云开**：七牛云 Kodo 的 S3 文档明确要求「每个请求必带
     * x-amz-content-sha256（payload 的 sha256）」，对它发 UNSIGNED-PAYLOAD 反而
     * 会被拒。因此这是一条**厂商差异**，不是「全局更安全的写法」。
     */
    unsignedPayload: true,
    /**
     * R43：华为云 OBS 的 ListBuckets（`GET /`）**默认不回桶的地域**。
     *
     * 官方 SDK 的 `listBuckets(queryLocation)` 写得明确 ——「`queryLocation` 默认
     * false；设为 true 后才在列举桶时查询桶的区域位置」（Java / PHP / Python SDK
     * 文档口径一致），而公有云 REST 版 ListBuckets 的 URI 参数表是**空**的：
     * 想拿到某个桶的地域，只能对该桶单独调 `GetBucketLocation`
     * （`GET /<bucket>?location`，见 {@link S3Client#_bucketLocation}）。
     *
     * ⚠️ **不补这一项的后果是「密钥正确、桶也确实存在，却报资源不存在」**：
     * ListBuckets 只回 `<Name>` / `<CreationDate>`，客户端便会拿**自己的 region**
     * 冒充桶的地域返回给界面（`|| this.region`），界面据此回填表单；添加桶时再访问
     * `<bucket>.obs.<那个假地域>.myhuaweicloud.com`。而 OBS 对「域名里的地域与桶
     * 实际所在地域不一致」的响应是 **HTTP 404 NoSuchBucket**（官方《Accessing OBS》：
     * 「If the endpoint in the request is not consistent with the endpoint of the
     * requested region, an error message is returned indicating that the bucket
     * does not exist」——**不重定向、也不提示地域不对**）⇒ 用户看到的是
     * 「资源不存在：对象或存储桶不存在。请检查桶名、地域与所选密钥是否正确」，
     * 于是去怀疑一把完全有效的密钥。
     *
     * 为什么「列举桶能成功、添加桶必失败」这种分裂表现是必然的：ListBuckets 与
     * GetBucketLocation 正是官方点名的**两个不受 endpoint 地域限制**的接口
     * （「You can use the endpoint of any region in the API requests for listing
     * buckets and for obtaining a bucket's region information, because these two
     * APIs search for buckets from all regions」）——所以事先不知道地域也能问出
     * 真实地域；而其余所有携带桶名的接口都必须用对地域。
     */
    queryBucketLocation: true,
  },
  {
    id: 'qiniu',
    name: '七牛云',
    shortName: 'Kodo',
    kind: 's3',
    endpoint: 'https://s3.cn-east-1.qiniucs.com',
    endpointTemplate: 'https://s3.{region}.qiniucs.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-east-1',
    regionHint: '七牛云 Kodo 的 S3 兼容地域，如 cn-east-1（华东-浙江）、cn-north-1（华北-河北）、cn-south-1（华南-广东）',
    credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },
  },
  {
    /**
     * R45：**UCloud 对象存储 US3**（S3 兼容，正式支持）。
     *
     * ## 端点与凭据
     * 端点为 `https://s3-<region_code>.ufileos.com`（如 `s3-cn-bj.ufileos.com`），
     * 地域代码见官方《地域和域名》表（cn-bj / cn-wlcb / cn-sh2 / cn-gd / hk / us-ca /
     * sg / idn-jakarta / tw-tp / jpn-tky …）。
     *
     * 凭据就是 UCloud 的 **API 公钥 / API 私钥**（也可用 US3 令牌的公钥 / 私钥）——
     * 官方《AWS S3 协议支持说明》原文：「The AccessKeyID (or AccessKey) and
     * SecretAccessKey (or SecretKey) of S3 correspond to the public and private keys
     * of the UCloud API」，并附有约束「The account that created the bucket must match
     * the owner of the API key」。字段名照厂商口径写：写成「AccessKey」会让用户去翻
     * 控制台账号密码（两套凭据，填错必得签名错误 —— 与 R43 又拍云同型）。
     *
     * ## 为什么必须走**路径风格**
     * UCloud 同时支持 Path Style 与 Virtual Host Style，但官方在同一页里明确：
     * 「Currently North China 1, Hong Kong, Ho Chi Minh, Seoul, Sao Paulo, Los Angeles,
     * and Washington regions already support https protocol, other regions can support
     * **path style https**, and **virtual host style https will be supported in the
     * future**」。
     *
     * 本项目一律使用 `https://`，而绝大多数用户会在**未列出的地域**（上海 / 广州 /
     * 乌兰察布等）建桶 —— 在那里虚拟主机风格（`bucket.s3-<region>.ufileos.com`）的
     * https **尚未支持**。沿用默认的虚拟主机风格，表现会是「配置全对、每个请求都
     * 失败」，与 R26-05 的 MinIO 同型（连不上的原因完全看不出）。因此这里显式走
     * 路径风格 —— 官方文档给出的 Java SDK 示例同样是
     * `clientOptions.setPathStyleAccess(true)`。
     *
     * ## ⭐ 地域：`endpoint` 里烘焙的地域必须与**签名地域**一致（R46）
     * 本条目给了静态默认端点 `endpoint: 'https://s3-cn-bj.ufileos.com'`（含 cn-bj），
     * 却**没有**声明 `defaultRegion`（与阿里云 / 华为云 / 七牛 / B2 同款写法）。
     * 于是地域留空时，端点回退到这条静态端点，而**签名地域**要靠
     * `S3Client` 的 `deriveRegionFromHost()` 从同一台主机反推 —— 两者本该是同源信息。
     *
     * 用户报告的「绑定成功但列出 0 个存储桶」正出在这里：`deriveRegionFromHost` 的
     * 域名清单里**当时没有 `ufileos.com`**，反推失败便退到兜底的 `us-east-1`，请求打到
     * cn-bj 的主机上、凭证作用域却写着 us-east-1，云端返回**合法但为空**的列表。
     * 修法是把 `ufileos` 补进那份清单（**唯一实现点**，见 `s3-client.js`），并在
     * `tests/audit42-regressions.test.js` 的 `R46-01` 里对**全部** S3 厂商逐个断言
     * 「空地域下的签名地域 == 默认端点里烘焙的地域」。
     * ⚠️ 将来给本厂商换成别的默认端点时，那份域名清单必须跟着能认出新域名。
     *
     * ## ⚠️ 为什么**刻意不**开 `queryBucketLocation`（与华为云正相反）
     * R43 给华为云 OBS 开了 `queryBucketLocation`（`GET /<bucket>?location` 反查真实地域），
     * 因为 OBS 的 ListBuckets **不回**桶地域。UCloud 的 `GetBucketLocation` 确实**存在**
     * （官方支持列表编号 3），但同一页对它的措辞是「Returns the name of the region where
     * you are located, **it is not recommended to rely on this API**」—— 厂商自己声明
     * 「不建议依赖」，其语义不作稳定契约。既然没有证据表明 `ListBuckets` 一定不回地域，
     * 就不该照搬 R43 的做法去多打一跳（那会让每个桶都多一次请求，还可能填进不可靠的值）。
     * 因此这里保持默认关闭；`getService()` 在列表里拿不到地域时，退回本次连接的
     * `region`（现在确定是 cn-bj，不再是 us-east-1）—— 与历史行为一致。
     * ⚠️ 若日后确认 UCloud 的 ListBuckets 普遍不回地域，再按 R43 的方式开，
     * 并补一条与 `R43-*` 同型的护栏；**不要**只凭「华为云开了所以它也开」。
     */
    id: 'ucloud',
    name: 'UCloud',
    shortName: 'US3',
    kind: 's3',
    endpoint: 'https://s3-cn-bj.ufileos.com',
    endpointTemplate: 'https://s3-{region}.ufileos.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-bj',
    regionHint: 'UCloud US3 的 S3 兼容地域，如 cn-bj（华北-北京）、cn-sh2（上海）、cn-gd（广州）、hk（中国香港）',
    forcePathStyle: true,
    credentialLabel: {
      id: 'API 公钥',
      key: 'API 私钥',
      idPlaceholder: '请输入 UCloud API 公钥（或 US3 令牌公钥）',
    },
    /**
     * 单次 `PutObject` 的文件上限 1GB —— 官方原文：「PutObject currently only supports
     * 1GB file size, if you need to upload files larger than 1GB, please use the
     * multipart upload API」。
     *
     * 这是**用户本轮点名的限制**。项目自身的直传阈值是 8MB，远小于它，所以表面上
     * 「本来就没事」；但把厂商上限写进那条判据，才能让「超过 1GB 一定走分片」成为
     * **可断言的结论**而不是巧合（见 `routes/fs.js` 的 `simpleLimit`）。
     */
    putObjectMaxBytes: 1024 * 1024 * 1024,
    /**
     * **定长**分片 8MB —— 官方原文：「UploadPart currently only supports 8MB
     * fixed-length part size (the last part is allowed to be less than 8MB). If there is
     * a requirement for variable-length parts, please contact technical support」；
     * 同页《S3 Part Size Description》亦写明「8M size parts are supported by default」
     * 且「dynamic part」需联系技术支持开通。
     *
     * ⚠️ 本项目默认的分片算式是 `min(48MB, max(8MB, ceil(size/10000/MB) MB))`：
     * 1GB 的文件恰好算成 8MB（**撞对**），而 30GB 算成 9MB、480GB 算成 48MB ——
     * 也就是说「小文件上传正常、大文件一律 400」，最容易被误判成网络问题。
     * 因此这条必须把分片**钉死**为 8MB，而不是当作「下限」。
     */
    fixedPartBytes: 8 * 1024 * 1024,
    /**
     * 单次 `CopyObject` 的上限 100MB —— 官方原文：「CopyObject currently only supports
     * a maximum file copy of 100MB」。
     *
     * ⚠️ 这条比 1GB 的 PutObject 上限**更容易踩**：项目原先认为「未声明上限的 S3
     * 兼容厂商其服务端复制不受单请求大小限制」，于是 100MB~5GB 的对象一律走
     * 单请求复制。在别家正常，在 US3 上必然失败 —— 而失败的是**重命名 / 移动**
     * 这类看起来与「大小」无关的操作，错误又来自上游，用户很难联想到 100MB。
     */
    copyObjectMaxBytes: 100 * 1024 * 1024,
  },
  {
    id: 'upyun',
    name: '又拍云',
    shortName: 'USS',
    kind: 's3',
    endpoint: 'https://s3.api.upyun.com',
    regionRequired: false,
    regionPlaceholder: '例如 us-east-1（可留空）',
    regionHint: '又拍云 S3 兼容接口统一使用 us-east-1，通常无需修改',
    /**
     * R43：又拍云的 **S3 兼容接口**用的是 AccessKey / SecretAccessKey，
     * 不是控制台账号的「操作员 / 操作员密码」—— 两者是两套凭据。
     *
     * 用户报告：「又拍云不能使用操作员和密码绑定 API Key，因为又拍云使用 S3 兼容协议，
     * 也同样需要 AccessKey、SecretAccessKey」。旧标签把用户引向组织账号的操作员密码，
     * 填进去只会得到签名错误 —— 而字段名恰恰是「填什么」的唯一提示，写错等于让用户
     * 拿一把根本不对的凭据去试。
     *
     * AccessKey / SecretAccessKey 在又拍云控制台「存储 → 操作员 → S3 兼容配置」
     * （云存储 → API 密钥 / S3 密钥）处生成。
     */
    credentialLabel: {
      id: 'AccessKey',
      key: 'SecretAccessKey',
      idPlaceholder: '请输入又拍云 S3 AccessKey',
    },
  },
  {
    /**
     * R30：**Microsoft Azure Blob Storage**（正式支持）。
     *
     * 与其它厂商的三处结构性差异，都体现在本条目里：
     *  ① `kind: 'azure'` —— 用独立鉴权协议（Shared Key）与独立 REST 接口，
     *     客户端由 `s3.js` 分派到 `azure-client.js`；
     *  ② 端点由**存储账户名**决定（`https://<账户名>.blob.core.windows.net`），
     *     与 R2 的「账户 ID 进主机名」同型，但账户名同时是**鉴权身份**（即 `secretId`），
     *     因此不再让用户重复填一遍端点 —— 组装见 {@link endpointForAccount}；
     *  ③ 没有「地域」概念（端点里不含地域），故 `regionRequired: false` +
     *     `defaultRegion: 'auto'`：与 GCS / R2 同样是「填了等价于没填」，
     *     界面上可留空、服务端补 auto，避免空串流到需要地域的地方。
     *
     * `endpointMode: 'optional'`：常规情况端点由账户名推导，**但**主权云
     * （Azure 中国 `blob.core.chinacloudapi.cn`、US Gov）与本地模拟器（Azurite）
     * 的域名不同，必须允许用户显式覆盖 —— 该栏可选填，填了就走端点守卫校验。
     */
    id: 'azure',
    name: 'Microsoft Azure',
    shortName: 'Blob',
    kind: 'azure',
    endpoint: '',
    accountEndpointTemplate: 'https://{account}.blob.core.windows.net',
    accountPattern: '^[a-z0-9]{3,24}$',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '固定 auto（可留空）',
    regionHint: 'Azure Blob 不按地域寻址（端点由存储账户名决定），固定使用 auto，通常无需修改',
    endpointMode: 'optional',
    endpointLabel: '服务端点（可选）',
    endpointPlaceholder: '留空即用 https://<存储账户名>.blob.core.windows.net',
    endpointHint: '仅在使用主权云（如 Azure 中国）或本地模拟器（Azurite）时才需要填写；'
      + '常规情况留空即可，系统会按存储账户名推导端点。',
    credentialLabel: {
      id: '存储账户名称',
      key: '存储账户密钥',
      idPlaceholder: '例如 myaccount（仅小写字母与数字，3–24 位）',
    },
  },
  {
    id: 'aws',
    name: 'AWS S3',
    shortName: 'S3',
    kind: 's3',
    endpoint: 'https://s3.amazonaws.com',
    endpointTemplate: 'https://s3.{region}.amazonaws.com',
    regionRequired: true,
    regionPlaceholder: '例如 us-east-1',
    regionHint: 'AWS 区域代码，如 us-east-1、ap-southeast-1',
    credentialLabel: { id: 'Access Key ID', key: 'Secret Access Key', idPlaceholder: 'AKIAxxxxxxxxxxxxxxxx' },
  },
  {
    id: 'gcs',
    name: 'Google Cloud',
    shortName: 'GCS',
    kind: 's3',
    // 地域固定为 auto（Google 的 S3 互操作层要求一个地域值，但它不参与寻址），
    // 因此端点不需要地域模板。
    endpoint: 'https://storage.googleapis.com',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '例如 auto（可留空）',
    regionHint: 'Google Cloud Storage 的 S3 互操作接口固定使用 auto，通常无需修改',
    credentialLabel: {
      id: 'Access Key ID（HMAC）',
      key: 'Secret（HMAC）',
      idPlaceholder: 'GOOGxxxxxxxxxxxxxxxx',
    },
    // 使用 S3 互操作层需要先创建 **HMAC 密钥**（Cloud Storage → 设置 → 互操作性），
    // 与常规的「服务账号 JSON」不是一回事；且 Cloud Storage 的桶名**全球唯一**。
  },
  {
    id: 'r2',
    name: 'Cloudflare',
    shortName: 'R2',
    kind: 's3',
    // R2 的端点形如 https://<账户 ID>.r2.cloudflarestorage.com —— 唯一带**变量前缀**
    // 的一家。这里把已确定的域名部分写进 endpointTemplate，占位符保留在主机名最前，
    // 由 composeEndpoint() 把用户填写的账户 ID 拼进去（见该函数说明）。
    endpointTemplate: '{region}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '例如 auto（可留空）',
    regionHint: 'Cloudflare R2 不区分地域，固定使用 auto，通常无需修改',
    endpointMode: 'template',
    endpointLabel: '账户 ID（Account ID）',
    endpointPlaceholder: '例如 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    endpointHint: '在 Cloudflare 控制台右侧栏可看到账户 ID；系统会据此拼出 https://<账户 ID>.r2.cloudflarestorage.com',
    credentialLabel: {
      id: 'Access Key ID',
      key: 'Secret Access Key',
      idPlaceholder: '请输入 R2 的 Access Key ID',
    },
  },
  {
    id: 'minio',
    name: 'MinIO',
    shortName: 'MinIO',
    kind: 's3',
    // 自建部署没有可推导的默认端点，必须由用户填写。
    endpoint: '',
    regionRequired: false,
    defaultRegion: 'us-east-1',
    regionPlaceholder: '例如 us-east-1（默认）',
    regionHint: 'MinIO 默认地域为 us-east-1；若服务端未另行配置，保持默认即可',
    forcePathStyle: true,
    endpointMode: 'required',
    endpointLabel: '服务端点',
    endpointPlaceholder: '例如 https://minio.example.com:9000',
    endpointHint: 'MinIO 为自建部署，请填写其访问地址（含端口）；'
      + '内网 / 回环地址与明文 http 默认被安全策略拦截，确需使用请在服务端设置 ALLOW_PRIVATE_ENDPOINT=1 / ALLOW_LOOPBACK_ENDPOINT=1',
    credentialLabel: {
      id: 'Access Key',
      key: 'Secret Key',
      idPlaceholder: '请输入 Access Key（默认 minioadmin）',
    },
  },
  {
    id: 'b2',
    name: 'Backblaze',
    shortName: 'B2',
    kind: 's3',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    endpointTemplate: 'https://s3.{region}.backblazeb2.com',
    regionRequired: true,
    regionPlaceholder: '例如 us-west-004',
    regionHint: 'Backblaze B2 的 S3 端点地域段，如 us-west-004（在桶详情页的 Endpoint 中可见）',
    credentialLabel: {
      id: 'keyID',
      key: 'applicationKey',
      idPlaceholder: '请输入 application key ID',
    },
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

/** 兼容早期版本：未记录 provider 的密钥一律视为腾讯云 */
const DEFAULT_PROVIDER_ID = 'tencent';

/** 返回全部厂商元数据（浅拷贝，避免调用方误改常量） */
function list() {
  return PROVIDERS.map((p) => Object.assign({}, p));
}

/** 按 id 查厂商；未知 id 返回 null */
function get(id) {
  return byId.get(String(id || '')) || null;
}

/** 解析厂商 id，未知或缺失时回退到默认厂商 */
function resolve(id) {
  return byId.get(String(id || '')) || byId.get(DEFAULT_PROVIDER_ID);
}

/** 该厂商当前是否已实现连接能力 */
function isSupported(id) {
  const p = get(id);
  return !!p && p.kind !== 'planned';
}

/** 厂商显示名（用于错误提示与界面文案） */
function nameOf(id) {
  return resolve(id).name;
}

/**
 * R49：`isCos()` 已删除。
 *
 * 它问的是「这家厂商是否走**腾讯云 COS 原生协议**」，而 R49 之后**没有任何一家**走
 * 那条路径（腾讯云自己并入了 S3）。留着它只有两种下场：要么恒为 false 变成死代码，
 * 要么被顺手写成 `kind === 's3'` —— 那就与 `isS3()` 完全等价，而
 * `routes/_shared.js` 里那句「`isCos` 才校验 AKID 前缀」会**静默变成对全部 S3 厂商
 * 生效**（阿里云的 `LTAI…`、华为云的 AK/SK 全被拒），`bucket-stats.js` 同型。
 * 厂商差异一律改成**注册表字段**（如 {@link secretIdPrefix} / `copyObjectMaxBytes`）。
 */

/** 该厂商是否为 S3 兼容协议 */
function isS3(id) {
  return resolve(id).kind === 's3';
}

/**
 * 该厂商对访问密钥 ID 的**前缀约定**（未登记即无约定，返回空串）。
 *
 * 目前只有腾讯云（`AKID`）。它的作用是在**保存密钥时当场**给出可执行的报错，
 * 而不是等到连接存储时才收到一句「签名错误：请检查 AccessKey / SecretKey 是否正确」
 * —— 那会把用户引向轮换一把完全有效的密钥。
 *
 * 为什么是注册表字段：这从来不是「某种协议的性质」，而是「这一家控制台怎么发密钥」。
 * R49 之前它挂在 `isCos()` 上，而 `isCos` 一旦等价于 `isS3`，规则就会扩散到
 * 阿里云 / 华为云 / 七牛 / UCloud……—— 那些家的密钥会被全数拒绝。
 */
function secretIdPrefix(id) {
  return resolve(id).secretIdPrefix || '';
}

/** 该厂商是否为 Azure Blob（独立鉴权协议 + Block Blob 语义） */
function isAzure(id) {
  return resolve(id).kind === 'azure';
}

/**
 * R30：该厂商的端点是否由**账户名**推导（Azure）。
 *
 * 与 S3 那套「地域进主机名中段」的推导是两件不同的事：这里的账户名既进主机名
 * 又是鉴权身份（`secretId`），因此不能复用 `endpointFor()`（它只吃 region）。
 */
function accountEndpointTemplate(id) {
  return resolve(id).accountEndpointTemplate || '';
}

/** 账户名是否合法（规则由厂商元数据给出；未登记规则的厂商恒为 false） */
function isValidAccount(id, account) {
  const pattern = resolve(id).accountPattern;
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(String(account == null ? '' : account).trim().toLowerCase());
  } catch (e) {
    return false;
  }
}

/**
 * 由账户名推导端点（唯一实现点）。
 *
 * 为什么必须在这里校验账户名：它会**直接拼进主机名**，是不折不扣的不可信输入。
 * 放行 `evil.com/x` 这类值就等于把出站请求引向任意主机（盲 SSRF）。因此字符集
 * 收敛到厂商登记的 `accountPattern`（Azure 为 `^[a-z0-9]{3,24}$`），拼出来的端点
 * 天然只可能是 `https://<合法账户名>.blob.core.windows.net`。
 *
 * @param {string} id 厂商 id
 * @param {string} account 账户名（未登记的厂商返回空串）
 * @returns {string} 形如 https://myaccount.blob.core.windows.net；不适用时为空串
 * @throws {Error} status=400 账户名缺失或非法
 */
function endpointForAccount(id, account) {
  const tpl = accountEndpointTemplate(id);
  if (!tpl) return '';
  const raw = String(account == null ? '' : account).trim();
  if (!raw) {
    const err = new Error('缺少存储账户名称，无法确定服务端点');
    err.status = 400;
    throw err;
  }
  if (!isValidAccount(id, raw)) {
    const err = new Error(`存储账户名称格式不正确（应为 3–24 位小写字母或数字）：${raw}`);
    err.status = 400;
    throw err;
  }
  return tpl.replace('{account}', raw.toLowerCase());
}

/**
 * 该厂商是否强制**路径风格**寻址（`https://host/bucket/key`）。
 *
 * 默认的虚拟主机风格会拼出 `bucket.<host>`；自建对象存储（MinIO 等）常以 IP
 * 或未配置 DNS 泛解析的域名暴露，`bucket.<host>` 根本无法解析 —— 表现为
 * 「配置看起来全对，但每个请求都失败」。因此这条必须由厂商元数据驱动，
 * 而不是让用户去猜一个寻址开关。
 */
function forcePathStyle(id) {
  return resolve(id).forcePathStyle === true;
}

/**
 * R42：该厂商是否只接受 `UNSIGNED-PAYLOAD` 作为载荷哈希（华为云 OBS）。
 *
 * true 时客户端**所有**请求（含 GET/HEAD 这类空体请求）都发 `UNSIGNED-PAYLOAD`，
 * 绝不发真实请求体的 SHA-256。判据由厂商元数据驱动，理由见 `PROVIDERS` 里
 * 华为云条目的注释（OBS 的 V4 只支持两种载荷模式；发真实哈希必得
 * `403 SignatureDoesNotMatch`，且报文不带线索）。
 */
function unsignedPayload(id) {
  return resolve(id).unsignedPayload === true;
}

/**
 * R43：该厂商的 ListBuckets 是否**不回桶的地域**，需要逐个补查 `GetBucketLocation`。
 *
 * true 时 `s3-client.getService` 会在某个桶没有地域信息时，单独对该桶发一次
 * `GET /<bucket>?location` 把真实地域取回来；取不到才退回客户端自身的 region。
 * 判据由厂商元数据驱动，理由见 `PROVIDERS` 里华为云条目的注释（OBS 的 ListBuckets
 * 默认不查地域，而「域名地域与桶地域不一致」会被回 **404 NoSuchBucket**，
 * 表现为「列举桶能成功、添加桶必失败」）。
 *
 * ⚠️ 这条**不是**「顺手给所有厂商打开更保险」：它意味着每个缺地域的桶多一次请求，
 * 只有确实不回地域的厂商才该打开。
 */
function queryBucketLocation(id) {
  return resolve(id).queryBucketLocation === true;
}

/**
 * R45：该厂商**单次 `PutObject`（一个请求）能放多大**；未声明返回 `Infinity`。
 *
 * 各厂商差异极大：AWS 规范是 5GB，而 UCloud US3 的 S3 兼容实现只到 **1GB**
 * （原文见 `PROVIDERS` 里 UCloud 条目的注释）。未声明的厂商返回 `Infinity` ——
 * 即「本厂商没有比项目阈值更严的限制」，由调用方自己的阈值兜底。
 *
 * ⚠️ 这是**硬上限**而非性能调优：越界时上游会直接拒绝整个文件（不是截断），
 * 而客户端往往在**传完之后**才拿到错误 —— 用户白等一场，且报文通常只讲
 * 「请求过大」，不会说清是厂商的限制。
 */
function putObjectMaxBytes(id) {
  const v = Number(resolve(id).putObjectMaxBytes);
  return Number.isFinite(v) && v > 0 ? v : Infinity;
}

/**
 * R45：该厂商是否要求**定长分片** —— 返回分片字节数，`0` 表示无此要求。
 *
 * UCloud US3 的 S3 兼容实现只接受 **8MB 定长**分片（末片可小于 8MB），原文与
 * 「大文件必失败、小文件却正常」的成因见 `PROVIDERS` 里 UCloud 条目的注释。
 *
 * 取值语义是**钉死的尺寸**而不是「下限」：项目默认算式会把 30GB 的文件算成 9MB
 * 分片，恰好越过任何「≥8MB」的下限判断，却仍被 US3 以 400 拒绝。
 */
function fixedPartBytes(id) {
  const v = Number(resolve(id).fixedPartBytes);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * R45：**分片上传的字节天花板** —— 「分片数上限 × 定长分片」；无定长要求时返回
 * `Infinity`。
 *
 * S3 协议把单次分片上传限制在 10000 片（{@link PART_COUNT_MAX}）。对**要求定长
 * 分片**的厂商而言，这个协议上限会直接变成**单文件上限**：8MB × 10000 ≈ **78GB**。
 *
 * UCloud 官方 FAQ 对同一现象给了同号说明与后果 ——「上传文件超过 78G，报错 400…
 * s3 分片数限制为 1 万条，设置分片为 8M 时，只能满足 78G 左右以下文件的上传，
 * 如果文件大小超过 78G，会自动调整分片大小…目前 us3 后端 s3 协议只支持 8M 的分片，
 * 如果分片大小不对，会返回 400 错误」，并建议改用 us3 协议工具（us3cli）。
 *
 * 也就是说：超过这个尺寸的文件**根本无法**通过 S3 兼容协议传上去。与其让用户把
 * 78GB 传完再收到一个 400，不如在 `upload/init` 当场给出可执行的提示。
 * 不声明定长分片的厂商不受此限 —— 它们的分片会随体积增长，10000 片足以覆盖 5TB。
 */
function multipartMaxBytes(id) {
  const part = fixedPartBytes(id);
  return part > 0 ? PART_COUNT_MAX * part : Infinity;
}

/**
 * R45：一次复制**是否必须**改走分块复制（`sliceCopyFile`）—— 三条复制路径
 * （`routes/fs.js` 的 `copyOne`、`fs-gateway.js` 的 `copyObject` 与目录 MOVE）
 * 共用的**唯一判据**。写成三份就会重演「改一处、漏两处」。
 *
 * 判据只有一条：**该厂商声明了 `CopyObject` 上限、且对象超过了它**。
 * 声明值来自注册表 —— UCloud US3 是 100MB（官方原文「CopyObject only supports a
 * maximum of 100MB」），腾讯云 COS 是 5GB（PUT Copy 上限）。
 *
 * ## R49 之前这里有个 `isCos(id)` 分支
 * 旧实现是「① 厂商声明上限 ② 腾讯云且 >5GB」两段 —— 因为那时腾讯云走 COS 原生 SDK，
 * 它的 `sliceCopyFile` 是 SDK 自带能力、与 S3 那份实现无关。腾讯云并入 S3 之后
 * 「是不是腾讯云」不再对应任何代码路径，那个分支如果照原样保留，就会因为
 * `isCos` 与 `isS3` 等价而**对所有 S3 厂商生效**（AWS / 阿里云 >5GB 的复制会被
 * 一并改道，而 R45 明确决定不动它们）。改法是把「5GB」变成腾讯云条目上的
 * `copyObjectMaxBytes` 声明：判据回到单一规则，各厂商的差异全部落在注册表里。
 *
 * ⚠️ **未声明上限的 S3 兼容厂商刻意不在此列**：它们在超过 5GB 时仍交给
 * `putObjectCopy`（R11-01 起的历史行为 —— 认为服务端复制不受单请求大小限制，
 * 注释亦写在 `routes/fs.js` 的 `copyOne` 里）。R45 只**收口判据 + 补上 UCloud**，
 * 不顺手把其余厂商的复制路径一起改写。若将来要修 AWS 自己的 5GB 上限，
 * 给它的条目加一个 `copyObjectMaxBytes` 即可 —— 判据不必再动。
 */
function copyNeedsSlice(id, size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return false;
  /**
   * ⚠️ 用 `get()` 而不是 `resolve()`，两者对**未知 id** 的差别正好落在语义上：
   * `resolve()` 会把未知 id 兜到默认厂商（现为腾讯云），于是「配置里存着一个
   * 已下线的厂商 id」会**凭空获得腾讯云的 5GB 上限**，把大于 5GB 的复制改道成分片。
   * 旧实现（`isCos(id) && …`）对未知 id 是 `false`，这里必须保持一致 ——
   * 「未声明上限就不分片」是本函数唯一的规则，解析失败同样算「未声明」。
   */
  const prov = get(id);
  if (!prov) return false;
  const declared = Number(prov.copyObjectMaxBytes);
  return Number.isFinite(declared) && declared > 0 ? n > declared : false;
}

/**
 * 该厂商是否要求用户提供「服务端点」这一栏。
 *
 * 两种形态都算「要用户填」：`'required'`（MinIO，填完整访问地址）与
 * `'template'`（R2，填账户 ID）。之所以合并成一个判据，是因为对**调用方**而言
 * 两者是同一件事 —— 「这条密钥没有用户提供的端点就不完整」，而具体填什么由
 * `endpointLabel` / `endpointPlaceholder` 描述。若只认 `'required'`，
 * R2 的记录会被判为「端点可选」，从而允许一条**永远连不上**的密钥落库。
 *
 * R30 新增的 `'optional'`（Azure）**不算**「要用户填」：它的端点默认由账户名推导
 * （见 {@link endpointForAccount}），端点栏只是为「主权云 / 本地模拟器」留的覆盖口。
 * 因此这里刻意**不**把它计入 —— 计入会让一条完全正确的 Azure 密钥被判为不完整。
 */
function endpointRequired(id) {
  const m = resolve(id).endpointMode;
  return m === 'required' || m === 'template';
}

/**
 * 解析一次连接应当使用的**地域**。
 *
 * 优先级：用户填写 → 厂商默认值（`defaultRegion`）→ 空串。
 * 「厂商默认值」解决的是 R2 / GCS 这类**要求填地域但填什么都一样**的厂商：
 * 界面允许留空，这里补上 auto / us-east-1，避免把空串当作地域送给签名。
 *
 * ⚠️ 返回值**必须**经过 {@link safeRegion} —— 它会**抛错**（因此本函数也会抛）。
 * 原因：地域会被直接拼进端点模板，入参来自用户/历史配置，属于**不可信输入**。
 * 在唯一的读取点校验，胜过在每个调用点各判一次。
 */
function regionFor(id, region) {
  const p = resolve(id);
  const raw = String(region || '').trim() || String(p.defaultRegion || '').trim();
  return raw ? safeRegion(raw) : '';
}

/**
 * 按地域推导服务端点：厂商提供模板时按模板填充，否则用默认端点
 *
 * ⚠️ 只适用于「占位符在主机名**中段**」的厂商（阿里云 / 华为云 / 七牛 / AWS / B2）：
 * `s3.{region}.amazonaws.com` 这类模板里，地域恰好在它该在的位置上。
 * R2 的占位符在主机名**最前**（`{region}.r2.cloudflarestorage.com`），且那里要填的是
 * **账户 ID 而不是地域** —— 绝不能让它落到这条推导路径上：`regionFor('r2', '')` 会给
 * 出 `auto`，于是端点被拼成 `auto.r2.cloudflarestorage.com`。这是个**语法合法**的域名，
 * 不会报错，只会让每一次请求都解析失败（用户看到的是一句「网络连接异常」）。
 * 因此这里对 `endpointMode: 'template'` 的厂商直接返回空串 —— 交由调用方报
 * 「缺少服务端点」，把问题停在配置阶段。R2 的组装见 {@link composeEndpoint}。
 */
function endpointFor(id, region) {
  const p = resolve(id);
  if (p.endpointMode === 'template') return '';
  if (p.endpointTemplate && region) {
    return p.endpointTemplate.replace('{region}', safeRegion(region));
  }
  return p.endpoint || '';
}

/**
 * 把用户在「服务端点」栏里填写的内容，按厂商的 `endpointMode` 组装成完整端点。
 *
 * 这是**唯一实现点**：写入端（`config-store.addCredential/updateCredential`）
 * 与预览端（`routes/config.js` 的连接验证）都必须经过它，否则会出现
 * 「保存时看着正常、真正连接时端点缺失 / 拼错」这类只在某一条路径上暴露的分叉。
 *
 * 三种形态：
 *  - `'template'`（Cloudflare R2）：用户填的是账户 ID。这里用**非贪婪**的
 *    `{region}` 替换，把模板 `{region}.r2.cloudflarestorage.com` 拼成
 *    `https://<账户 ID>.r2.cloudflarestorage.com`。
 *      为什么不能复用 `endpointFor()`：那是**贪婪**替换（`s3.{region}.amazonaws.com`
 *      必须如此，否则会把地域后的这一段也吃掉），而 R2 的模板必须以 `.` 收尾才能
 *      正确地在最前的占位符处停下 —— 两种替换规则相反，不能共用。
 *      本分支**必须幂等**：表单回填的是库里**已组装好的完整端点**，用户不动它直接
 *      保存时若再拼一次，就会得到
 *      `https://<id>.r2.cloudflarestorage.com.r2.cloudflarestorage.com` ——
 *      而这是一个**语法完全合法**的域名，不会报错，只会在连接时静默失败。
 *  - `'required'`（MinIO）：用户填的就是完整端点，原样透传（仍是**未校验**的，
 *    由调用方紧接着送 `assertSafeEndpoint()`）。
 *  - 其余厂商（含未声明 `endpointMode` 的历史厂商）：透传。**关键**：用户在
 *    自定义端点栏里填了什么就是什么，绝不做拼接 —— 这条路径必须与历史行为逐字
 *    一致，否则存量配置会被改写。
 *
 * @param {string} id    厂商 id
 * @param {string} input 用户输入（空串表示未填写）
 * @returns {string} 可直接交由 `assertSafeEndpoint()` 校验的端点；未填写时为空串
 */
function composeEndpoint(id, input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return '';
  const p = resolve(id);
  if (p.endpointMode === 'template' && p.endpointTemplate) {
    // 幂等保护（见上）：带协议的、或已含本模板固定域名后缀的，一律视为已组装完毕
    if (/^https?:\/\//i.test(raw)) return raw;
    const suffix = p.endpointTemplate.replace('{region}', '');
    if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase())) return 'https://' + raw;
    return 'https://' + p.endpointTemplate.replace('{region}', raw);
  }
  return raw;
}

/**
 * R21-12：`region` 会被**直接拼进端点模板**（`s3.{region}.amazonaws.com`），
 * 因此它的字符集必须是「不可能改变主机或路径」的那种。
 *
 * 旧实现只做 `String(region).trim()`。而厂商默认端点这条路**不过**
 * `assertSafeEndpoint` —— `s3.js` 里只有用户自定义的 `cfg.endpoint` 走校验
 * （且 `assertSafeEndpoint('')` 是 no-op）。于是 `region` 里带 `/`、`?`、`#`
 * 就能改写模板端点的主机 / 路径，把出站请求引向别处。收敛字符集比事后解析更可靠：
 * 合法地域名只含字母、数字、`.`、`-`、`_`。
 */
const REGION_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeRegion(region) {
  const r = String(region).trim();
  if (!REGION_SAFE_RE.test(r)) {
    const err = new Error('存储地域（region）含有非法字符，请检查配置');
    err.status = 400;
    throw err;
  }
  return r;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER_ID,
  // R49：`isCos` 已删除（腾讯云并入 S3 后没有任何厂商走 COS 原生协议，见其说明）
  list, get, resolve, isSupported, nameOf, isS3, isAzure, endpointFor,
  forcePathStyle, endpointRequired, regionFor, composeEndpoint,
  // R49：厂商对访问密钥 ID 的前缀约定（腾讯云 AKID）—— 注册表下发，唯一读取点在 routes/_shared
  secretIdPrefix,
  // R42：只接受 UNSIGNED-PAYLOAD 的厂商（华为云 OBS）—— 注册表下发，客户端唯一读取点
  unsignedPayload,
  // R43：ListBuckets 不回桶地域、需逐个补查 GetBucketLocation 的厂商（华为云 OBS）
  queryBucketLocation,
  // R45：厂商侧的容量硬限制（未声明即沿用项目阈值）—— 各自唯一实现点
  putObjectMaxBytes,   // 单请求 PutObject 上限（UCloud 1GB）
  fixedPartBytes,      // 定长分片尺寸（UCloud 8MB；0 = 无要求）
  multipartMaxBytes,   // 分片上传天花板 = 分片数上限 × 定长分片（UCloud ≈ 78GB）
  copyNeedsSlice,      // 复制是否必须改走 sliceCopyFile（三处复制路径共用）
  // R30：由账户名推导端点（Azure）—— 唯一实现点，含账户名字符集校验
  accountEndpointTemplate, isValidAccount, endpointForAccount,
};
