# 开发文档

**前言**

为同时管理多家云服务厂商的对象存储系统，并同时有多用户管理、加密、分享、付费、流量监控管理、WebDAV 等需求（**同时也是为了展现本人技术力**），特此研发本系统。

以上。

1. **适用版本**：v1.9.27（取自 `package.json` 的 `version`，由 `tests/docs-sync.test.js` 护栏校验）  
2. **渲染前提与目录兜底**：本文标题为手写 HTML（`<h1 id="develop_document-sectionN">`），目录依赖这些 `id`。若目标渲染器清洗原始 HTML 并剥离 `id`，**目录链接会失效，但目录本身仍然可用**，请按下述方式定位：
   - 目录条目本身是一份完整的章节清单，条目文字与正文标题严格一致（由 `docs-sync` 双向断言保证），按标题文字在页面内搜索即可跳到对应章节；
   - 章节编号 `develop_document-sectionN` 从 1 起**连续递增**（同样由护栏断言），因此「第 N 章」的表述在标题被剥离后仍可换算；
   - 若渲染器连标签一起剥离（标题退化为纯文本），改用保留原始 HTML 的渲染器——GitHub / GitLab / VS Code 预览均保留。
   >
   > **为什么不「在构建期生成锚点」**：本项目**没有构建步骤**（前端是原生 ESM，`public/js/*.js` 直接由浏览器加载；文档是纯 Markdown，不经过任何生成器）。为一个不存在的构建期设计兜底方案没有意义，故此处给的是「失效后如何阅读」而非「如何让它不失效」。

3. **本页面仅适用于开发者，记录设计取舍及具体技术解析等内容。无二次开发或了解技术实现等需求、开箱即用则请直接忽略本文，只需阅读 [README.md](./README.md) 即可。**

4. 由于本系统功能庞杂，且已历经数十个版本迭代、审计和测试，因此必须将所有设计理念、设计意图、测试须知、二开示例等内容全部展开详细讲解才能防止对二开造成困扰，文档内容之巨可能远超阁下的想象。请只选择自己需要的章节进行阅读，当前该文档已超 21 万字，阅读整个开发文档是不理智的行为。

5. 整体项目和文档的编写、修改仅由作者一人完成，难免有不足、错误和疏漏之处。若读者发现错漏之处，或有其它建议，请致函 <xingsen2005@sjtu.edu.cn> 指正，在此对所有提出修改建议的朋友表示感谢。

**目录**

- [一、项目概括](#develop_document-section1)
  - [1. 目录结构](#develop_document-section2)
  - [2. 环境变量](#develop_document-section3)
  - [3. 多云架构](#develop_document-section4)
- [二、技术说明](#develop_document-section5)
  - [1. 设计背景与刻意取舍](#develop_document-section6)
    - [1.1 多云协议的历史原因](#develop_document-section7)
    - [1.2 用户 / IP 管理界面按角色物理分离](#develop_document-section8)
    - [1.3 支付系统设计取向](#develop_document-section9)
    - [1.4 支付结果仅限服务端查单返回](#develop_document-section10)
    - [1.5 订单冗余字段用于对账](#develop_document-section11)
    - [1.6 WebDAV 口令为可恢复加密](#develop_document-section12)
    - [1.7 为何不引入 SM4 作为文件加密算法](#develop_document-section13)
    - [1.8 为何不使用对象存储自带的服务端加密](#develop_document-section14)
    - [1.9 传递长尾依赖](#develop_document-section15)
  - [2. 技术限制与已知局限](#develop_document-section16)
  - [3. 威胁模型与不设防边界](#develop_document-section17)
  - [4. 审计后的行为变更](#develop_document-section18)
  - [5. 安全说明](#develop_document-section19)
  - [6. REST API 模块化组织](#develop_document-section20)
  - [7. HTTP API](#develop_document-section21)
    - [7.1 认证与用户](#develop_document-section22)
    - [7.2 配置、密钥与存储桶](#develop_document-section23)
    - [7.3 文件与上传](#develop_document-section24)
    - [7.4 分享、加密、IP、WebDAV、统计](#develop_document-section25)
  - [8. 支付设置](#develop_document-section26)
    - [8.1 主要校验规则](#develop_document-section27)
    - [8.2 开关层级](#develop_document-section28)
    - [8.3 接口](#develop_document-section29)
    - [8.4 支付状态机](#develop_document-section30)
    - [8.5 各状态切换的字段变化、校验与异常处理](#develop_document-section31)
    - [8.6 已支付凭证](#develop_document-section32)
    - [8.7 订单退款（人工记账）](#develop_document-section33)
    - [8.8 真实支付网关](#develop_document-section34)
    - [8.9 支付结果确认（服务端查单）](#develop_document-section35)
  - [9. 搜索](#develop_document-section36)
  - [10. 性能与可靠性](#develop_document-section37)
- [三、核心模块实现](#develop_document-section38)
  - [1. 文件加密与元数据](#develop_document-section39)
    - [1.1 三种方式与密文结构](#develop_document-section40)
    - [1.2 元数据是解密的唯一凭据](#develop_document-section41)
    - [1.3 分片路径与完整性校验](#develop_document-section42)
    - [1.4 查看密码与访问令牌](#develop_document-section43)
    - [1.5 孤儿元数据巡检](#develop_document-section44)
  - [2. 统一文件网关](#develop_document-section45)
    - [2.1 收口的理由](#develop_document-section46)
    - [2.2 读取路径：信号量与范围请求](#develop_document-section47)
    - [2.3 删除、复制与移动的截断契约](#develop_document-section48)
  - [3. 分片上传与断点续传](#develop_document-section49)
  - [4. 分享链接生命周期](#develop_document-section50)
    - [4.1 标识与快照字段](#develop_document-section51)
    - [4.2 状态判定顺序](#develop_document-section52)
    - [4.3 下载配额与来源判定](#develop_document-section53)
  - [5. 请求上下文与会话鉴权](#develop_document-section54)
  - [6. IP 访问守卫](#develop_document-section55)
  - [7. 速率限制与失败锁定](#develop_document-section56)
  - [8. 列举上限与目录缓存](#develop_document-section57)
  - [9. 统计与操作日志](#develop_document-section58)
  - [10. WebDAV 服务](#develop_document-section59)
  - [11. 服务端点守卫](#develop_document-section60)
  - [12. 上传过滤匹配器](#develop_document-section61)
  - [13. 持久化、启动与关闭](#develop_document-section62)
  - [14. 前端模块与渲染约定](#develop_document-section63)
- [四、测试](#develop_document-section64)
  - [1. 测试与 CI](#develop_document-section65)
  - [2. 测试护栏编写约定](#develop_document-section66)
- [五、开始二次开发](#develop_document-section67)
  - [1. 高层架构总览](#develop_document-section68)
    - [1.1 分层视图与请求链路](#develop_document-section69)
    - [1.2 状态存放与启动顺序](#develop_document-section70)
  - [2. 本地启动与调试](#develop_document-section71)
    - [2.1 启动方式与端口](#develop_document-section72)
    - [2.2 服务端调试](#develop_document-section73)
    - [2.3 前端调试](#develop_document-section74)
  - [3. 最小示例 A：新增一个只读接口](#develop_document-section75)
    - [3.1 第一步：写路由](#develop_document-section76)
    - [3.2 第二步：挂载与依赖注入](#develop_document-section77)
    - [3.3 第三步：补护栏并验证](#develop_document-section78)
  - [4. 最小示例 B：新增一个前端卡片](#develop_document-section79)
  - [5. 二次开发检查清单](#develop_document-section80)
- [六、审计发现台账（合并存档）](#develop_document-section81)

---

<h1 id="develop_document-section1">一、项目概括</h1>

<h2 id="develop_document-section2">1. 目录结构</h2>

```
main/
├── server/
│   ├── index.js            # 入口：HTTP + HTTPS、安全头、鉴权、静态资源、优雅关闭
│   ├── routes.js           # REST API 聚合器（按序挂载 routes/ 子模块）
│   ├── routes/             # 各领域 REST API 子模块 + _context.js / _shared.js
│   ├── providers.js        # 【多云】厂商注册表（唯一元数据来源）
│   ├── payment-providers.js# 【支付】平台凭证字段定义 + 校验引擎（可扩展为真实校验）
│   ├── payment-rules.js    # 【支付】业务规则纯函数：金额 / 渠道开关约束 / 付费是否生效
│   ├── payment-orders.js   # 【支付】付费订单状态机与已支付票据（pending→paid|failed）
│   ├── order-no.js         # 【R64】订单号编解码**唯一实现点**：36 位「13 位毫秒时间戳 + 9 位链接 UID + 9 位用户 UID + 5 位随机串」，base62、区分大小写；两个 UID 由 `sha256('kepler:link:'+id)` / `sha256('kepler:user:'+id)` **确定性派生**（同一链接 / 同一账号恒定），随机串用 `crypto.randomInt` 取（不用 `randomBytes % 62`，避免分布偏斜）。⚠️ 它**不是**网关商户单号：`order.id`（16 位 base64url）仍是 `out_trade_no`，因为微信支付 v3 对 `out_trade_no` 有 **≤ 32 位**硬限制
│   ├── payment-gateway.js  # 【支付】真实支付网关：支付宝 RSA2 / 微信 APIv3 / 云闪付（银联全渠道）/ PayPal Orders v2（查单确认，零依赖）
│   ├── payment-logos.js    # 【R91】渠道品牌图形的**唯一实现点**（内联 SVG + `SHAPES` 表 + `logoSvg()` / `logo()`）。后台「支付设置」的标签由 `clientSchema()` 经接口下发它、前台分享页由 `share-routes.js` 直接内联 —— 两处渲染的是**同一份字节**。⚠️ 不要在前端另存一份图形数据：两份必然漂移（原先的 `public/js/payment-logos.js` 已删除）
│   ├── pem-key.js          # 【R79】PEM / DER 密钥结构判定**唯一实现点**（ADR-0006）：**真解析**而不猜前缀 —— 裸体依次试 PKCS#8 / PKCS#1 / SEC1（公钥试 SPKI / PKCS#1），`classify()` 区分「公钥解得开」与「确实是公钥」（OpenSSL 能从私钥导出公钥，顺序反了会把每把私钥都判成公钥），`explain()` 按真实出错频率给出可照做的中文诊断（贴错框 / 有口令 / 粘贴不全 / 非 RSA）；保存校验器与签名归一化共用，解不出来时返回 `''` 由调用方决定报什么
│   ├── qrcode.js           # 【支付】自研二维码生成（输出 SVG，零依赖）
│   ├── s3.js              # 【多云】客户端工厂：按 provider 分派 S3Client / AzureBlobClient + 错误翻译（R49 起全厂商同一路径）
│   ├── s3-client.js        # 【多云】S3 兼容客户端（手写 SigV4，零新增依赖）
│   ├── azure-client.js     # 【多云】Microsoft Azure Blob 客户端（手写 Shared Key + Blob REST + Block Blob，零新增依赖）
│   ├── fs-gateway.js       # 统一文件网关：透明加解密 + 元数据联动 + 审计
│   ├── download-stream.js  # 统一下载流：响应头/管道/背压/超时/流量统计（可选挂限速环节）
│   ├── traffic-meter.js    # 【R51】下发字节的计量 Transform（唯一实现点）：按 1s 间隔汇总上报，避免逐 chunk 触碰 `statsStore` 写盘；主站下载与分享打包下载共用同一口径
│   ├── attachment-name.js  # 【R51】`Content-Disposition: attachment` 的唯一实现点：剔除引号/反斜杠/换行（响应头注入面）+ ASCII 兜底 + RFC 5987 `filename*`；两条下发管线共用
│   ├── throttle.js         # 【R37】下载限速唯一实现点：五层取最小值 + 按节拍切片投放的共享字节桶
│   ├── backup.js           # 【R38】「备份配置」唯一实现点：采集 10 个配置分区 → 长代码 / AES-256-GCM 密封（独立备份密码）→ 导入整批覆盖（R55 追加发信设置 / 站点设置、R68 追加协议设置）
│   ├── config-store.js     # 配置 v3（多云+多密钥+多桶+用户）AES-256-GCM 加密存储与迁移。⚠️ `cfg.agreements`（两份协议正文）与 `cfg.site.notices`（三页提示的开关 + 文案）虽是同一个文件里的两段，归属刻意分开：前者归「协议设置」，后者归「站点设置」
│   ├── agreement-text.js   # 【R68】协议文案渲染**唯一实现点**：**先把原文整段 HTML 转义、再插入本文件生成的固定标签**（不是黑名单过滤——`<img onerror>` / `<svg onload>` / `javascript:` 漏一个就是存储型 XSS），提示文案只认 `<a>`、正文只认一个极小的 Markdown 子集，不支持的写法原样显示不丢内容
│   ├── agreement-view.js   # 【R68】协议提示的**页面级视图唯一实现点**：`noticeForPage()`（分享页服务端渲染直调）与 `publicPayload()`（`GET /api/site/agreements`）共用同一段判断——开没开、有没有正文、哪几个链接能点。⭐ 两份正文**都空 ⇒ 整条提示不显示**（否则点开是空对话框）；只填一份 ⇒ 另一份的 `<a>` 退化成纯文字
│   ├── bucket-stats.js     # 【配额】桶用量统计缓存 + API Key 空间配额（根级模块：打破 routes→_context→WebDAV→网关 的循环依赖）
│   ├── secure-store.js     # 其他敏感 JSON 的加密落盘（自动升级历史明文）
│   ├── atomic-write.js     # 临时文件 + rename 原子写入 + 启动孤儿 tmp 清扫
│   ├── coalesce.js         # 异步原语：去抖合并写 + 并发合并读（退出收口只注册一个处理器）
│   ├── enc-store.js        # 文件加密核心（三种方式 / 解密流 / 查看令牌 / 元数据迁移）
│   ├── enc-xor.js          # 【R48】纯 `crypto` 原语：magic 的密钥流生成与异或（无副作用，可安全被工作线程 require）
│   ├── enc-pool.js         # 【R48】`worker_threads` 加密线程池（入口即本文件；小负载走本地、停机就地算完、出错永久降级）
│   ├── upload-gate.js      # 【R90·FS-S1】上传数据面的**内存闸门**：按「并发数 + 在途字节」双限额，⚠️ 必须挂在 `express.raw(...)` **之前**（raw 是中间件，handler 里再判「太大」时请求体早已进内存）。无 `Content-Length` 时按单请求上限记账（宁多算不少算）；名额在 `res` 的 `close` 事件归还（正常结束与客户端 abort 都走这里，漏释放 = 名额只减不增、整站不能上传）
│   ├── upload-sessions.js  # 分片上传会话持久化与碎片清理
│   ├── user-space.js       # 【R89】用户存储空间的**唯一实现点**：桶内前缀命名空间 `u/<userId>/`（尾斜杠是判据的一部分 —— `startsWith('u/abc')` 会把 `u/abcd/` 一并放行）、加根 / 剥根 / 越界判定 / 存量区 `legacy/` 标注。只做纯字符串运算、不碰 I/O，故可被测试直接驱动
│   ├── share-store.js      # 分享链接存储
│   ├── download-log.js     # 【R64】免费下载台账：登录账号**首次**下载某链接某文件的记录（`(userId, linkId, fileKey)` 去重），供「查看历史订单」展示；游客不记（无稳定身份），溢出按最旧优先丢弃（`DOWNLOAD_LOG_MAX`，默认 2000）
│   ├── invite-store.js     # 【R54③】邀请码存储：生成 / 核销 / 回滚 / 批量设置 / 删除 / 导出为纯文本（一行一个）的**唯一实现点**；落盘走**同步** `secureStore.writeJson` —— `disabled` 与 `remove()` 是**吊销**语义，异步写会在进程重启时丢掉尚未 flush 的那一次（表现：点了停用、重启后那枚码又活了）
│   ├── coupon-store.js     # 【R62】优惠券存储：生成 / 状态判定 / 适用范围校验 / 核销台账 / 按订单回退的**唯一实现点**；金额一律整数「分」，优惠封顶到「原价 − 1 分」；【R88】`minSpendFen` 使用门槛（「满 xx 减 xx」）—— 与 `type` **正交**的独立字段，`0` 即直减券，存量券缺该字段行为不变
│   ├── share-routes.js     # 公开分享页与下载（/s/:id）；R51 起多条目走**分页列表 + 勾选**，单文件直传、多选/含文件夹打包
│   ├── share-bundle.js     # 【R51】分享打包下载：把选中的对象流式写成 `.tar.gz` 下发（读完一个再读下一个，内存只与单个 chunk 有关）；长度与声明不符**两个方向都中止**
│   ├── tar.js              # 【R51】极简 tar 写出（零依赖）：POSIX ustar 头 + 校验和规范写法 + GNU `L` 长名条目 + base-256 大端长度 + `safeName` 抗目录穿越。只做字节，不碰流与响应
│   ├── file-icons.js       # 【R50】服务端文件类型图标：从 `public/index.html` 的 `#icon-sprite` 解析 `<symbol>`，供**服务端渲染**的分享页**内联**（那里没有雪碧，`<use>` 只会画出空白且不报错）。不复制图形，按需内联
│   ├── stats-store.js      # 流量/请求按天聚合 + 操作日志（JSONL）
│   ├── ip-guard.js         # IP 屏蔽（黑名单/海外屏蔽）与 IP 限速（CIDR），全局+桶级
│   ├── china-ips.txt       # 国内 IPv4 段数据（二分查找）
│   ├── auth-session.js     # 内存登录会话（并发上限/强制登出/过期清理）
│   ├── captcha.js          # 登录验证码（reCAPTCHA / Cloudflare **两套凭证各自独立保存**，`provider` 只决定登录页用哪一套）
│   ├── webauthn.js         # Windows Hello 校验（零依赖 ES256 + CBOR/COSE 解析 + 挑战池）
│   ├── security.js         # 部署判定/CSRF/失败锁定等公共安全工具
│   ├── endpoint-guard.js   # 服务端点守卫：拦截元数据服务/私网/回环/明文 http（防 SSRF）
│   ├── limits.js           # 列举与扫描上限集中定义
│   ├── list-cache.js       # 目录列举短缓存（进程内，写操作即失效整个桶）
│   ├── search-candidates.js# 搜索候选集缓存（带 TTL，订阅 list-cache 的失效通知，超限自动退化）
│   ├── request-context.js  # 请求上下文（会话 token / 角色 / 当前桶）
│   ├── roles.js            # 【R71】角色语义的**唯一事实源**：`root` / `admin` / `user` 三层、「谁管谁」（`canManageUser`）、「谁能授予角色」（`canAssignRole`）、角色中文标签（审计日志与界面同源）。⚠️ 所有调用点只准引用它，不得再手写 `role === 'admin'` 字面量
│   ├── share-origin.js     # 分享下载「来源判定」纯函数（Sec-Fetch-Site + Referer 分层校验）
│   ├── gzip.js             # 响应 gzip（/api JSON + 静态文本资源，流式接口自动跳过）
│   ├── gitignore.js        # .gitignore 规则解析与过滤
│   ├── tls-cert.js         # 【R49】TLS 证书加载：只加载运维自备的真实证书（不生成、不签发、不改写）
│   ├── data-dir.js         # 【R49】运行时数据目录唯一实现点（`S3_DATA_DIR`，兼容旧名 `COS_DATA_DIR`）
│   ├── instance-lock.js    # 单实例锁（防止两个进程同时写 data/ 覆盖配置）
│   ├── update-check.js     # 【R34】检查更新：当前版本取 package.json，最新版本按 GitHub 发布页 → 标签 → 默认分支 package.json 三级回退（版本比较的唯一实现点，结果缓存 10 分钟）
│   ├── smtp.js             # 【R53】零依赖 SMTP 发信客户端：手写 EHLO / STARTTLS / AUTH(PLAIN·LOGIN) / MAIL / RCPT / DATA，仅用 `node:net` + `node:tls`
│   ├── restore-guard.js    # 【R65】「用订单号取回下载权限」的连击封禁**唯一实现点**：连续输错达上限即把该 IP 封 24 小时（落盘 `data/restore-bans.json`），成功一次即清零。⚠️ 只被分享页的两条取回端点显式调用，**不挂全局中间件** —— 挂上去就会顺手拦掉浏览、下载与后台
│   ├── pwa.js              # 【R70】PWA 的两个端点**唯一实现点**：`GET /manifest.webmanifest`（按「站点名称」**现场生成** —— 桌面快捷方式的名称由系统在安装那一刻读 manifest 的 `name`/`short_name`，装完即固化，静态文件只能写死一个名字）与 `GET /sw.js`（读 `public/sw.js` 模板并**全局**替换版本号占位符 ⇒ 缓存名带版本 ⇒ 发版即淘汰旧缓存）。⚠️ 版本号替换必须全局（`split/join`）：模板里注释与代码各写一次时，`String.replace` 只替首处会先命中注释、常量一字未动
│   ├── webdav-server.js    # 【R67】WebDAV 的**入口**：只做生命周期（加载证书 → 起 HTTPS → 停止）与对外 API（`start` / `apply` / `close` / `serverUrl` / `getTlsError`）；协议实现在同名的 `webdav/` 包目录里
│   └── webdav/             # 【R67】WebDAV 协议实现（按原文件的六条分节标记逐字搬运，未改一行逻辑）
│   │   ├── defs.js        # 定义层：`MOUNT` / `DEFAULT_PORT` / `PROPFIND_CAP` / 方法集 / 按用户名的失败锁定 / **错误文案唯一收口点** `davErrorMessage()`
│   │   ├── util.js        # 纯工具层（无 I/O）：XML 转义、`hrefFor()`、`inMount()`（挂载点判据唯一实现点）、`reqPathToKey()`（路径⇄Key 归一化的唯一实现点）、`rfcDate()` / `guessContentType()`
│   │   ├── listing.js     # 对象列举层：`requireS3()` / `listLevel()` / `destinationExists()` / `checkPreconditions()` / 递归列举 / 截断留痕 —— WebDAV 与 S3 **唯一的接触面**
│   │   ├── auth.js        # 认证层：HTTP Basic + `webdavLock`（连续失败锁定，复用 `security.createFailLock`）
│   │   ├── xml.js         # PROPFIND 的 207 响应体构造（`propResponse()` / `multistatus()`）
│   │   └── app.js         # Express 应用（最大的一段）：九个动词的处理器 + 安全响应头 + IP 守卫 + 配额闸门 + 限速接线
├── public/
│   ├── index.html
│   ├── sw.js               # 【R70】Service Worker **模板**（不是普通静态文件）：`__KEPLER_VERSION__` 由 `GET /sw.js` 现场替换。缓存策略三条：`/api` `/s` `/dav` **完全不拦截**（会话态与一次性数据不得进缓存）、导航**网络优先**、同源静态资源**缓存优先 + 后台回源**。`install` 逐项 `cache.add` 而**非** `addAll`（一项失败不该让整个安装失败 —— 界面上只表现为「安装按钮点了没反应」）
│   ├── icons/              # 【R70】PWA 图标：`icon.svg` / `icon-192.png` / `icon-512.png`（**白底 + 圆角正方形**，圆角烤进图标本身）、`icon-maskable.svg` / `icon-maskable-512.png`（满版白底、不烤圆角，交系统按形状裁切）、`apple-touch-icon.png`（iOS 的「添加到主屏幕」不读 manifest）
│   ├── css/style.css
│   └── js/
│       ├── main.js           # 应用骨架、状态、桶/设置弹窗
│       ├── provider-logos.js # 【多云】7 家厂商元数据与 LOGO（内联 SVG）
│       ├── paysettings.js    # 【支付】支付设置卡片（表单渲染 / 校验 / 保存，规则全部取自服务端）
│       ├── ordermgr.js       # 【支付】订单管理页（订单流水与对账）
│       ├── credmgr.js        # 访问密钥卡片（厂商选择器 + 服务商列）
│       ├── bucketmgr.js      # 存储桶管理页
│       ├── ipmgr.js          # 【R37】「IP 地址管理」页（IP 访问屏蔽 + IP 地址限速两张卡共用一份规则表；规则渲染 / 弹窗 / 预检全部在此，**R37 从 bucketmgr.js 整体迁出**）
│       ├── invitemgr.js      # 【R54③】「邀请码设置」页（批量生成 / 批量删除 / 批量导出 txt / 单独与批量设置使用次数·过期时间·身份·停用·备注）；**状态判定不做第二份** —— `active|expired|used_up|disabled` 全部取自服务端下发的 `status`，前端只做文案映射
│       ├── couponmgr.js      # 【R62】「优惠券设置」页（单独/批量生成、无门槛/限链接/限用户、次数与时间限制、停用/启用/删除；【R88】使用门槛「满 xx 减 xx」输入与「满 X 减 Y」列显示）；状态只做服务端 `status` 的文案映射
│       ├── explorer.js · upload.js · ops.js · linkmgr.js
│       ├── filetype.js       # 【R44】侧栏「文件类型」筛选（7 项：全部 / 图片 / 视频 / 音频 / 文档 / 压缩包 / 可执行文件）；**取代**与前缀地址栏功能重复的「文件夹导航」树（原 `tree.js` 已删除）。只负责渲染 + 把点击翻译成 `App.state.typeFilter`，**过滤规则只有 `explorer.visibleItems()` 一份实现**；选中具体类型时文件夹不显示（文件夹不属于任何文件类型）
│       ├── dashboard.js      # 监控仪表盘
│       ├── settings.js · syssettings.js · enc.js
│       ├── profile.js        # 「编辑资料」自助弹窗（所有角色可用，与用户管理分离）
│       ├── webauthn.js       # Windows Hello 前端（注册 / 断言 / 就绪判定与错误分类）
│       ├── gitignore.js · help.js
│       ├── theme.js          # 【R40】日间 / 暗黑模式切换（**普通脚本，非 ESM**：必须同步在 `<head>` 里执行，否则暗色用户每次加载都会先闪一帧亮色；内联不可行 —— CSP 的 `script-src` 没有 `'unsafe-inline'`）；状态落在 `<html data-theme="dark|light">` 这一个落点上，`localStorage` 键 `kepler-theme`
│       ├── api.js · util.js
│       ├── listdialog.js     # 【R36】四张列表卡片共用的「显示全部」对话框骨架（openListDialog + 服务商/存储桶下拉选项推导）；**独立成模块**是为了让测试沙箱把它原样拷入、用桩化的弹窗原语驱动真实逻辑
│       ├── speedlimit.js     # 【R37】下载限速对话框 + MB/s ↔ 字节/秒换算（`parseMbpsInput` 是前端唯一判据，与服务端 `limits.parseSpeedLimitInput` 同语义）；四张列表卡片与文件分享对话框共用
│       ├── backupcfg.js      # 【R38】设置页「备份配置」卡片：实时备份码（只读）+ 导出为复制 / JSON（账户口令 + 独立备份密码）+ 导入（仅首次初始化可用）；三种码的语义差异写在文件头注释里
│       ├── share-status.js  # 分享链接状态判定（与服务端 status() 同序，无 DOM 依赖）
│       ├── pay-poll.js      # 【分享页】支付结果轮询（**普通脚本，非 ESM**：需 document.currentScript 取 data-link-id）
│       ├── share-list.js    # 【R51 分享页】列表勾选（**普通脚本，非 ESM**，同因）：选中状态按链接存 `sessionStorage` 实现**跨页累计**，提交时把其它页的勾选补成隐藏 `k` 字段；不构造下载 URL、不发请求 —— 下载走页面里的原生 `<form method=GET>`，浏览器才会给进度与「另存为」
│       ├── share-order.js   # 【R64】分享页「订单号」一键复制（**普通脚本，非 ESM**，同因）：事件委托监听 `[data-copy-order]`，优先 `navigator.clipboard.writeText`，回退 `textarea + execCommand`，两者都不行时全选 `#order-no` 让用户自己按 Ctrl+C（复制失败也要有出路，不能静默）
│       ├── pwa.js           # 【R70】PWA 接线：注册 Service Worker（失败静默 —— 明文 HTTP / 隐私模式被拒是正常情况，不该打断 `init()`）+ 接住 `beforeinstallprompt`（**只保存凭据**，`prompt()` 挂在用户点击上：该事件每页只发一次，在事件回调里用掉就等于永久失去安装入口）+ 独立窗口判定（`display-mode: standalone` / iOS 的 `navigator.standalone`）。菜单项默认 `hidden`，只有 `canInstall()` 为真才放出
│       ├── anchornav.js     # 【R73】系统设置页**卡片锚点导航栏**：从真实 DOM 现生成锚点（读 `.sysset-card` 并跳过 hidden），点击平滑滚动且**减掉 sticky 栏高**。⚠️ 独立成模块是为了能被单独加载**真实执行**验证（塞在 `syssettings.js` 里会牵动 `main.js` 顶层 `init()`）；⚠️ 刻意**不**维护第二份卡片清单 —— 手写清单在「新增 / 移动 / 按角色隐藏卡片」时会静默失配
├── tests/                  # 零依赖测试（node:test + 自研断言）
│   ├── helpers.js          # 断言、临时目录、HTTP 请求、端口等待、ESM 语法校验
│   ├── routes-surface.test.js  # 路由表面积护栏
│   ├── payment.test.js     # 支付凭证 / 开关约束 / 金额 / 付费生效判定 / 订单状态机 / 路由鉴权
│   ├── payment-gateway.test.js # 真实网关：签名构造 / 域名选择 / 查单失败即关闭
│   ├── qrcode.test.js      # 自研二维码（对照 ISO 18004）
│   ├── auth-session.test.js     # 登录会话行为
│   ├── s3-client.test.js
│   ├── crypto-storage.test.js
│   ├── frontend.test.js
│   ├── webauthn.test.js    # CBOR / ES256 / authData / 挑战池 / 注册与认证全流程
│   ├── gzip.test.js
│   ├── search-cursor.test.js # 搜索续扫游标与「仅当前目录」单级列举
│   ├── list-cache.test.js   # 目录列举短缓存：失效范围 / TTL / 条目上限
│   ├── search-candidates.test.js # 搜索候选集：TTL / 超限退化 / 等价性（与纯扫描逐字段相同）
│   ├── share-deleted.test.js # 分享链接「对象已删除」标记与惰性探测
│   ├── config-verify-permission.test.js # POST /config/verify 的权限边界
│   ├── docs-sync.test.js   # 文档清单同步护栏（目录结构 / 模块数 / 环境变量表）
│   ├── agreement-settings.test.js # 【R68】协议设置护栏（25 条）：默认值与归一口径（`"false"` 不算开、逐页逐字段合并、严格 PATCH）/ Markdown 子集的每一种语法 / **XSS 判据落在「整段转义后再插标签」上**（`<img onerror>` 必须变成 `&lt;img`）、`javascript:` 拒链而**不丢字** / 提示文案里 `<a>` 的分类（`data-doc` 优先，否则按出现顺序）/ 空正文不做链接 / 两份全空则整条提示不显示 / HTTP 往返与 400 / 权限（匿名读公开视图 200、管理接口 403）/ 预览不落盘 / 分享页用 CSS `:target` 弹窗且**页面里不得出现任何 `<script>`** / 错误页不显示提示 / 关掉后无痕迹 / 备份往返（`SCOPES` 第 10 分区）/ 卡片位置与 `ADMIN_ONLY_CARDS` / 编辑框固定高度带竖滚动 / 登录页渲染点 / 对话框关闭入口
│   ├── deploy-script.test.js # 部署脚本护栏：状态持久化 / 全局 kepler 命令 / 菜单编号与分支对应、改初始管理员凭据的内联脚本（vm 内跑真实 config-store）、改密取值必须原样落盘、Nginx 站点目录探测（Debian modules-enabled 陷阱）、nginx 装不上时的兜底可达性（含被 `exclude=nginx` 过滤时给出 `--disableexcludes=all`）、域名带端口校验、重装前对安装目录脚本的完整性预检（shebang + bash -n 双检）、git 不得当硬依赖（装不上只降级不中断）、RHEL 系装包失败的 modular filtering 诊断（module reset/enable）、Node 装不上时先点出「机器上已有 nodejs 与新版互斥」（cannot install both / 不得拿 is already installed 当判据）、ACME 多 CA（CA 注册表与 EAB 必要性、acme.sh 账户目录按 `ca/<host>/<path>/` 逐段推导、EAB HMAC 不得回显与落盘、非 LE 必须走 acme.sh 且带 `--server`/EAB/`--install-cert`、LiteSSL 缺 EAB 当场失败并给出取凭据地址与可复制命令）、HSTS 只对 ACME 签发的证书发长期值（`--tls file` 的自备证书发 `max-age=0` 清旧记录；判据只认 `ACME_CERT_DIR`，否则浏览器锁死无「继续访问」入口）、acme.sh 安装必须「先落盘校验再安装 + 国内镜像优先」（首选 gitee 上作者 neilpang 的镜像，官方 raw.githubusercontent.com 降为兜底；落盘后 shebang + `VER=` + bash -n 三重校验，且不得用 `curl … | sh`）、CA 速率限制（`ratelimited`/`Le_OrderFinalize`/`429`）必须命中专属分支且排在「连接失败」之前（429 恰证明网络可达，按「注册域名/公共后缀」7 天限发的配额应提示换 CA 或等 retry-after，而非报「连不上」或让用户误以为「已存在的账户坏了」）、默认 CA 用 `zerossl`（LE 按公共后缀共享配额极易限流；旧状态残留 `letsencrypt` 且未显式指定时提醒换 CA）、acme 证书落盘后不得因 reload 失败误判「安装失败」（宝塔/自编译 nginx 非 systemd native service，`systemctl reload` 报 is not active；`acme_install_cert` 以 key/fullchain 是否落盘为判据，reload 交由 `nginx_apply` 兜底）、重装不得把正式证书降级（两半：① acme.sh 的退出码 2 是 `RENEW_SKIP`＝「证书未到续期时间」的**成功**语义，`--issue` 必须走 `run_allow_rc 2` + `acme_issue_skipped`（退出码与措辞双证据），被允许的退出码不得打 `[错误] 命令执行失败` 块；② 证书已装好且仍在有效期内时 `setup_tls` 必须**跳过申请**——判据 `tls_cert_reusable` 走 `openssl x509 -checkend`（不解析 notAfter 文本，避开 BSD/GNU `date` 差异），阈值 `CERT_REUSE_MIN_DAYS=30` 必须落在 acme.sh 的 60 天续期窗口内，逃生门 `--force-cert`，且可复用来源只认 `ACME_CERT_DIR`——把自备证书目录 `TLS_DIR` 也算进去会让「正式证书掉了」永远修不回来）、装包失败必须**先自己修好**而不是只打印提示（`pkg_failure_kind` 是失败分类的唯一实现点，`on_pkg_failure` 的诊断分支与 `pkg_auto_repair` 共用它，避免「诊断说 A、修复去修 B」；判据须认 `modulefailsafe`/`module_hotfixes` 措辞；修复按**代价从小到大**逐档试：① `dnf install -y --setopt='*.module_hotfixes=true' <包>` —— 仓库按**包级**视图求解、本次事务绕过模块过滤，**零持久副作用**，且这是**纯净系统**上唯一对症的一档（那种机器模块流本来就一致，reset/enable 全是空转）；② 才轮到 `module reset -y <模块>` → 按报错里期望的流 `module enable -y <模块>:<流>` → `clean all`/`makecache`（**全局**改机器模块状态，故排后）；③ 最后 `--nobest`；每一步都**重试安装**，且必需 `pkg_install` 与可选 `pkg_install_opt`（**git 走的正是后者**）两个通道都要接上；模块名须由包名逐层剥后缀推导后经 `module list` **验证存在**再 reset —— `perl-libs` 不是模块名，硬 reset 它只会多刷一行错，流号由版本前两段收敛（`5.26.3` → `5.26`）；解析不出被过滤的包时**一个 module 操作都不做**（但零副作用的绕过过滤允许试一次）；**绝不用 `--skip-broken`**（它让「装不上」返回 0，`pkg_install` 误判成功而 `have git` 仍为假，是本项目最忌讳的一种假成功）；`--setopt` 的通配符**引号必须留**（不引会被 shell 展开成文件名，dnf 收到垃圾参数）；诊断里第 1 条手工命令也必须是绕过过滤、`module reset` 不得回到首位；`Invalid configuration value: failovermethod=…` 是旧版 yum 的选项、dnf 不支持，属**无害警告**，必须主动说明，否则用户会顺着最显眼的那几行把排查方向搞错）、**证书必须「内容可用」才算签发成功**（`cert_file_ok` 为唯一实现点：要求能解析出 subject/issuer 且**都有实值**、且证书公钥与私钥**配对** —— 只判 `[[ -s ]]`（文件非空）的实现会把「subject/issuer 全空白」的证书当成签发成功，而 `openssl req -x509 -subj "/"` 实测就会产出这种证书（`openssl x509 -noout -subject` 输出就是 `subject=`），且 `nginx -t` 照样通过；用户看到的就是「提示签发成功、浏览器里证书字段全空白、显示不安全」；**三处调用点缺一不可**：签发安装 `acme_install_cert`、复用判断 `tls_cert_reusable`（复用判据漏掉 → 坏证书被**每次重装永久复用**，怎么重装都修不回来）、自备证书校验 `use_provided_cert`）、以及**收尾必须核对「实际对外提供的是哪份证书」**（`tls_probe_served`：`nginx -t` 只证明我们写的配置能被解析，证明不了浏览器看到的就是这份 —— 带 `-servername` 取本机 HTTPS 端口的实际证书、按 SHA-256 指纹与本地文件比对，不一致时点名 443 上还有别人的 default_server 并给出排查顺序））、**R39：部署脚本与应用的版本对齐**（`handoff_needed()` 的四态判据 —— 内容相同则**不**交接、不同则必须交接、`KEPLER_SELF_HANDOFF` 防环、自证不了版本时交给安装目录里那份；交接必须真的 `exec`，并把单实例锁 / 防环标记 / 已解析域名 / 原始命令行一起带过去，缺哪一样都在用例里有独立断言；另有位置断言钉住「交接排在 `install_app` 之后、`gen_env_file` 之前」与「源码目录即安装目录时不自我同步」）、**R59：部署脚本安装环节的两处国内化修复**（CentOS EOL 致 Node 装不上 → 阿里云 Vault 归档源三步 + 迁移建议；GitHub 拉不通 → 自动改用 Gitee 镜像重试 + 手动重跑提示）、**R60：SSL 证书环节的 acme.sh 下载改为「国内镜像优先」**（上一版官方源优先 ⇒ 国内服务器每次部署先白等一次 `connect-timeout`；现改为 Gitee 镜像首选、GitHub 官方源兜底，并新增 `VER=` 内容校验））；**R72 起还覆盖安装令牌的可视性**（部署收尾信息里打印一次、`kepler` 菜单顶部显示且每次重读、脚本不得自行生成令牌、服务端启动即生成 32 位 hex 且幂等/初始化后不再生成）
│   ├── audit-regressions.test.js  # 回归护栏
│   ├── audit3-regressions.test.js # 第三轮审计护栏
│   ├── audit5-regressions.test.js # 第五轮审计护栏
│   ├── audit6-regressions.test.js # 第六轮审计护栏
│   ├── audit7-regressions.test.js # 第七轮审计护栏
│   ├── audit8-regressions.test.js # 第八轮审计护栏
│   ├── audit9-regressions.test.js  # 第九轮审计护栏（修复验收 + 新发现）
│   ├── audit10-regressions.test.js # 第十轮审计护栏（对第九轮修复的对抗式验收）
│   ├── audit11-regressions.test.js # 第十一轮审计护栏（第 11 轮修复的行为护栏）
│   ├── audit12-regressions.test.js # 第十二轮审计护栏（数据隔离 / 覆盖冲突 / 复制回滚 / 并发回滚）
│   ├── audit13-regressions.test.js # 第十三轮审计护栏（默认安全隔离 / fresh 回滚 / 快照时序 / Overwrite:F / 删源回滚）
│   ├── audit14-regressions.test.js # 第十四轮审计护栏（支付窗口内 pending 不得被裁 / 裁剪必须留日志）
│   ├── audit14-perf.test.js # 第十四轮性能护栏（去抖合并写 / 并发合并读 / 探测去重 / stat 短缓存）
│   ├── audit16-regressions.test.js # 第十六轮审计护栏（WebDAV 对外地址与 /dav 反代默认开启）
│   ├── audit17-regressions.test.js # 第十七轮审计护栏（反代取 IP / 支付地址校验 / async 兜底）
│   ├── audit21-regressions.test.js # 第二十一轮审计护栏（分享下载加密闸门 / 用户名预言机 / 缓存键消毒 / SSRF 跳转 / 跳转目标 / WebDAV 报错回显）
│   ├── audit22-regressions.test.js # 第二十二轮修复护栏（Hello 第三支同形 / 转发头取值可信 / WebDAV 全出口报错收口 / 加密门禁归属口径 / 跳转目标注释同序）
│   ├── audit25-regressions.test.js # 第二十五轮功能护栏（API Key 空间配额：用量归集归属 / 严格大于判据 / 待定增量台账 / 写入出口闸门 / 桶创建闸门 / WebDAV 闸门 / 前端卡片）
│   ├── audit26-regressions.test.js # 第二十六轮功能护栏（四家 S3 兼容服务商：端点组装三形态与幂等 / R2 不得走地域推导 / 地域补默认值与字符集 / MinIO 路径风格 / 重存不得改写厂商端点 / 建桶地域闸门按厂商 / 前端端点栏驱动）
│   ├── audit27-regressions.test.js # 第二十七轮审计护栏（独立报告 26 条：HTTPS 判据唯一实现点 / XFF 字面量可解析且规范化 + IP 守卫 fail-closed / 规则目标尾斜杠 / 畸形编码不再 500 / GCM 先认证后下发 / 分片字节核对与缺号拒绝 / 密钥创建即 0600 + fsync / S3 点段规范化 / 二维码位填充 / 端点守卫尾点 / gzip 判据）
│   ├── audit28-regressions.test.js # 第二轮审计护栏（IPv6 屏蔽规则落盘往返仍命中 / 单桶配额在全部写入出口生效且不可自调 / 真实 Range 请求的 206 不得 gzip / 存量密钥权限与弱签名证书自愈 / 陈旧锁接管期间的锁文件不得缺席 / 拒绝文案的单一实现点）
│   ├── audit29-regressions.test.js # 第二十九轮护栏（用户报告的运行期问题：上传停滞看门狗与「服务器处理中」相位 / 上传成功后界面刷新异常不得改判为失败 / 设置写操作后的全局刷新）
│   ├── audit31-regressions.test.js # 第三十一轮护栏（用户报告：批量删除缺 Content-MD5 被云端拒绝；「登录验证」「支付设置」保存成功后自动启用状态，且必须「本次新填了信息」才触发、绝不覆盖手动停用）
│   ├── audit32-regressions.test.js # 第三十二轮护栏（「删除失效订单」只删支付失败、保留对账凭据与在途订单；「删除失效链接」只删文件已删除/已过期、保留可逆的「已关闭」，且作用域按创建者隔离）
│   ├── audit33-regressions.test.js # 第三十三轮护栏（用户管理「封禁」：判据四态与脏数据 fail-closed / 原因必填与到期时间必须晚于当前 / 写入即落盘 / requireAdmin 与自封禁拦截 / 封禁立即吊销会话 / 登录判定必须在密码校验之后且第二步与其它失败分支同形 / 前端按钮接线 + datetime-local 必须换算成绝对时刻 + 登录页文案）
│   ├── audit34-regressions.test.js # 第三十四轮护栏（WebDAV 根路径挂载失败：挂载点判据唯一实现点 `inMount` 且 `/` 与 `/dav` 同等 / OPTIONS 宣告 DAV 的入口 PROPFIND 必须 207 且任何路径都不得回 text/html / `OPTIONS *` 服务级探测 / FUN-06 边界不得被放宽撤销 / 根路径的破坏性动词仍须被拒 / `GET /` 301 与子项 href 前缀不变）
│   ├── audit34-update.test.js # 第三十四轮护栏之二（「关于」卡片「检查更新」：版本比较按数值且无法解析返回 null / 普通用户也能调用 / 三级来源回退 / 全失败回 502 且逐级说明原因 / 结果缓存 10 分钟 / 两句文案逐字一致 / 按钮接线 / 前端沙箱的 util 桩必须覆盖 syssettings.js 的具名导入集）
│   ├── audit35-regressions.test.js # 第三十五轮护栏（「用户管理」列表 10 条预览 + 「显示全部」对话框：≤10 隐藏按钮（正好 10 位也不显示）/ >10 时卡片只渲染 10 行且提示写明总数 / 对话框含搜索框、滚动容器与全部用户 / 搜索大小写不敏感、空态不残留旧行、关键词跨刷新保持 / 卡片里看不见的第 11+ 位用户仍能在对话框里编辑封禁删除 / 删除后卡片与对话框同步刷新 / 关闭后可再开、登出不残留 / 两个视图都过 escapeHtml / 用户表格只允许一份渲染器 / flex 容器上的 hidden 必须显式声明 / 反向对照脚本必须拒绝位置参数——行为断言，不用源码字样）
│   ├── audit36-regressions.test.js # 第三十六轮护栏（四张列表卡片的预览与筛选：①「全部用户」对话框按角色筛选；② 属性面板文件夹显示「创建者」、文件显示「上传者」，取自对象元数据且历史对象显示「—」而非猜测；③ 访问密钥/存储桶 10 条预览、分享链接 100 条预览；④ 服务商下拉只列数据集里真实出现过的厂商；⑤ 存储桶**只有一个搜索框**同时搜桶名与备注；⑥ 全量数据才用于「仅剩一个启用桶不得停用」的判定（筛过的子集不得被当成全域）；⑦ 卡片与对话框共用唯一渲染器与行按钮绑定；⑧ 上传者元数据的写入/读取唯一实现点）
│   ├── audit37-regressions.test.js # 第三十七轮护栏（下载限速：五层优先级「取各层最小值」且同率时高层胜 / 0 与非法值不得被当成「有限速」/ 解析器是唯一判据（-1 与 abc 必须拒绝，绝不静默归零）/ 节拍器真实计时：实测耗时落在速率允许区间、写出间隔恒 ≤ 100ms、并发共享同一份带宽 / 限速表有界（TTL 清扫 + 硬上限）/ IP 地址限速与 IP 访问屏蔽互斥（屏蔽匹配跳过 speed 规则、限速只认 kind=speed 且速率 > 0 且启用的规则）/ 单个 IP 取最严 / 非法 IP fail-open 返回 null（与 evaluate 的 fail-closed 刻意相反）/ speedLimitFor 只接受原始 IP 字符串、传包装对象必须返回 null / config.enc 与 links.json 的 speedLimit 往返且「未传即保持」/ `GET /throttle/ceiling` 四作用域语义（credential 不限、bucket 取其绑定密钥、user 刻意不猜、link 加上分享创建者）且 layers 不带 id 不泄露归属 / 三个下载出口都接线（/fs/download、/s/:id/dl 与 WebDAV GET 这条**独立路径**）/ 限速插在解密之后、计量表之前（stages 三元形态）/ teardown 一并销毁节拍器 / download-stream 不得自己 require 限速（否则绕过统一闸门）/ WebDAV 出口如实带 ip 与 credentialId 但无 userId（记录「WebDAV 无用户管理层」这条真实限制）/ presign 直链是**旁路**（签名 URL 直连云端，本站限速管不到）如实记录 / 四张卡片的「限速」按钮各自用本层 scope / IP 地址管理页从存储桶页迁出且导航序为 订单管理 → IP 地址管理 → 监控仪表盘 / 文件分享对话框提交 speedLimit 且「已在 … 中设置限速为」这句话全前端只此一份）
│   ├── audit38-regressions.test.js # 第三十八轮护栏（① Windows Hello「不是本站域名」根因：部署模式下 HOST=0.0.0.0 是通配绑定地址、永远不出现在 Host 头里，真实域名只进了 nginx 的 server_name，故 isOwnSiteHost 白名单实际为空 → 用真实域名访问被 fail-closed 判成外站；修法是新增 SITE_DOMAIN 作为「本站对外域名」的唯一权威来源，白名单同时剔除通配绑定地址、httpsRedirectHost 也随之指向真实域名；真实域名必须放行、4 个外站必须拒绝；deploy.sh 必须写入 SITE_DOMAIN；② 「备份配置」：备份范围恰为 10 个可见项 ↔ 9 个存储分区（负载均衡与 API Key 管理是同一份 credentials 记录）、用户/分享链接/订单/**邀请码**（条数可能过多）/密钥文件/自定义域名一律排除，R55 又在末尾追加「发信设置」（含**明文** SMTP 口令）/「站点设置」两段、实时码是「配置内容」的纯函数（改设置必须变、不改必须不变）、编解码往返、密封码往返（错密码/篡改/换头一律拒绝）、口令长度上下界、WebDAV 口令导出为明文并在导入时按本实例重新密封（绝不复用 passwordSealed）、isEmptyData 逐项枚举（用户列表不参与判据）、导入是整批覆盖语义、导入后 WebDAV 认证通过、IP 规则导入后真的生效且 id/enabled 原样保留、active id 不得悬空、4 条路由全部 requireAdmin、导出必须校验账户口令、已配置实例导入必须 409、卡片位于「关于」之上、三点界面提示逐条在场、**导入不得动用户表**（万一被清空即「零管理员 → 永久锁死」，即便载荷里塞了一张用户表也不得采纳））
│   ├── audit40-regressions.test.js # 第四十轮护栏（① EL8 装 Node 的版本互斥：`node_pm_extra_args()` 只在 `dnf` 下给出 `--allowerasing`（旧 `yum` 不认），RPM 分支不再单独装 `npm`（`npm` 随 `nodejs` 一起装，单独装会把 AppStream 模块包又拖回来）；② 「用户管理」里管理员**不能编辑自己**（自己那一行不渲染「编辑」按钮，且 `userTableHtml` 是唯一渲染点）；③ 日间 / 暗黑切换：`theme.js` 是 `<head>` 里的**普通脚本**（不得 `type="module"` / `defer` / `async`）、按钮在 `#user-menu-wrap` **左侧**、`title`/`aria-pressed` 与 `<html data-theme>` 三处同步、`localStorage` 抛错时仍能切换、暗色变量块在 `:root` 之后）
│   ├── audit41-regressions.test.js # 第四十一轮护栏（① reCAPTCHA 卡在「正在加载人机验证组件…」：`www.recaptcha.net` 只下发**引导脚本**，它再注入实现脚本 `recaptcha/releases/<版本>/recaptcha__*.js`，该实现在中国大陆取自 `www.gstatic.cn`、境外取自 `www.gstatic.com`，而 CSP 的 host-source 是**精确匹配**，漏一个就整片被拦 ⇒ `grecaptcha` 永不 ready；判据按 **CSP 语义**把 script-src 拆成 host 集合再要求两个来源都在，并附取法自证 + 负向对照；② 两种验证码的配置**各自独立**：`captcha.providers[provider] = { siteKey, secretKey }`，`provider` 只决定登录页用哪一套 —— 写一家不得动另一家、切换只换生效那一套、留空表示保持原密钥而 `null` 才是清除、环境变量 `CAPTCHA_PROVIDER` 必须先定服务商再取密钥（逆序会取错那一套）、旧的扁平配置读盘后被迁进 `providers[provider]` 且扁平键一律抹掉（`normalize()` 与 `save()` 共用同一归一实现点）、路由 GET/PUT 只回 `hasSecret` 布尔且明文密钥绝不出服务端、备份两套一起走一起回、空判据覆盖两套）
│   ├── audit42-regressions.test.js # 第四十二轮护栏（用户报告：华为云/七牛云/又拍云/Backblaze 的**正确密钥也绑不上**：① `/config/verify` 的**跨厂商继承**陷阱 —— 入参缺省的 `region`/`bucket`/`endpoint` 会无条件回退成「当前激活桶」的值，而激活桶属于**别家**厂商 ⇒ 地域被拼进端点（华为云打成不存在的 `obs.ap-guangzhou.myhuaweicloud.com` ⇒ DNS 失败，只说「网络连接异常」）、或端点看着全对而**签名地域**错（又拍云固定端点 + `us-east-1`，被写成别家地域 ⇒ `403 SignatureDoesNotMatch`）、或拿别家桶名去 headBucket、或阿里云恒非空的固定端点把请求引到别家域名；修法是回退**只在同一厂商内**发生，且未带厂商的历史调用方行为逐字不变。② 华为云 OBS 的 V4 **只接受 `UNSIGNED-PAYLOAD`**，发真实载荷哈希必得 403 且报文无线索；修法是在厂商注册表声明并由客户端在最前统一判定（**含空体 GET/HEAD**），且**只给华为云开**（七牛云明确要求真实载荷哈希，开了就挂）。③ 八家 S3 兼容厂商（腾讯云/阿里云/华为云/七牛云/又拍云/AWS/GCS/B2）逐一的 host、桶寻址、签名地域与 scope（签名由一份**独立于 `s3-client` 重算**的校验器复核，避免自己验自己）；Azure 走 `SharedKey` + `x-ms-*`、绝不出现 SigV4）
│   ├── audit43-regressions.test.js # 第四十三轮护栏（用户报告的三件事：① 华为云**绑得上密钥、列得出桶、却加不了桶**，报「资源不存在：对象或存储桶不存在」—— 根因是华为云 OBS 的 `ListBuckets` **默认不回桶的地域**（官方 SDK `listBuckets(queryLocation)` 默认 false），客户端便拿**自己的 region** 冒充桶的地域返回给界面，界面回填进「添加存储桶」表单后请求打到 `<bucket>.obs.<假地域>.myhuaweicloud.com`，而 OBS 对「域名地域 ≠ 桶地域」的响应是 **404 NoSuchBucket**（官方《Accessing OBS》，不重定向也不提示地域不对）⇒ 文案把用户引向「密钥不对」；修法是注册表声明 `queryBucketLocation` 并由 `getService` 逐个补查 `GetBucketLocation`（`GET /<bucket>?location`，该接口与 ListBuckets 同属官方点名的「不受 endpoint 地域限制」的两个接口，故不必先知道地域）；② 又拍云凭据是 S3 的 `AccessKey / SecretAccessKey`，不是控制台账号的「操作员 / 操作员密码」；③ 「备份配置」卡片的实时码编辑框默认整串显示明文（含访问密钥、WebDAV 口令）→ 改为**部分掩码**（抬头 + 首尾可见，中间定宽掩码），完整码只能由「复制备份码…」「导出为 JSON…」两个显式动作取得 —— 判据落在**调用点层**（`refresh()` 之后 DOM 里不得出现完整码），不只落在 `maskCode()` 助手函数上）
│   ├── audit44-regressions.test.js # 第四十四轮护栏（用户要求：① 移除与前缀地址栏功能重复的「文件夹导航」；② 换为「文件类型」筛选——全部 / 图片 / 视频 / 音频 / 文档 / 压缩包 / 可执行文件，后缀规则与 SVG 图标取自用户提供的 `ico.txt`，直接替换文件夹的 icon，各类型按规定底色绘制、图标缩放到**视觉一致**）。护栏分四层：**纯函数层**（真实 `util.js` 的 `FILE_TYPES` 顺序与文案、`iconIdOf` 的类型与按扩展名细分的四套系统图标 exe/msi/com、apk、ipa、hpkg 与 `other` 回退、`iconHtml` 的 `<use href="#…">` 形态）；**服务端分类表**（真实 `_shared.js` 的 `TYPE_EXT.exec` 六项、`apk` 必须从 `archive` **搬走**而非两处都列——`typeOf()` 按键序返回首个命中，两处都列会让 apk 永远判成压缩包而界面看不出、`svg` 不得被顺手删减否则丢掉缩略图与预览，判据落在 `typeOf()` 的真实返回值上）；**精灵图双向覆盖**（JS 引用的每个 `fic-*` 必须有对应 `<symbol>`，每个 `<symbol>` 也必须真被引用——`<use href="#不存在">` 在浏览器里**静默渲染成空白**、不报错不警告；逐个钉死 ico.txt 规定的底色值、1024 画布、以及按视觉包围盒算出的 `translate/scale` 归一化变换）；**过滤行为层**（沙箱拷入**真实** `explorer.js` + 真实 `util.js`、桩化 api/main/upload/ops/enc，真跑 `setTypeFilter` → `render` → `renderList`：`visibleItems()` 在「全部」下保留文件夹、在具体类型下排除文件夹；渲染行数等于可见集；滤空时给的是「没有『音频』类型的文件 + 显示全部文件」而不是「此文件夹为空」；`selectAll` 与切筛选都不得把**看不见的项**留在选中集里），另有 `tree.js` 已删除且无残留引用的结构断言）
│   ├── audit45-regressions.test.js # 第四十五轮护栏（用户要求：用 S3 兼容协议接入 UCloud，注意其「超过 1GB 必须分块上传」的限制；厂商选择器中排在七牛云与又拍云之间；给定 SVG 做与其他厂商一样的处理）。三轮核实后发现官方并列的硬限制有**三条**：`PutObject` 仅 1GB、**`CopyObject` 仅 100MB**、**`UploadPart` 必须 8MB 定长**（且 `UploadPartCopy` 处于内测、只支持 SigV4）。护栏分五层：**注册表层**（登记位置必须在 qiniu 与 upyun 之间、`kind`/`shortName`/`credentialLabel`（API 公钥·私钥）/`regionRequired`/端点模板、且**不得**顺手继承别家的 `unsignedPayload` 与 `queryBucketLocation`——全表仍各只准一家声明）；**三条容量判据层**（`putObjectMaxBytes` 1GB 与非法值归 Infinity、`fixedPartBytes` 仅 UCloud 声明 8MB、`multipartMaxBytes` = 10000 片 × 8MB ≈ 78GB、`copyNeedsSlice` 的 100MB 边界与「未声明厂商超过 5GB 仍走 `putObjectCopy`」的**行为保留**反向对照）；**客户端行为层**（`s3.createClient` 必须真的下发路径风格与定长分片；**真跑 `sliceCopyFile`** 拦截出站请求，断言 US3 发出 `bytes=0-8388607 / 8388608-16777215 / 16777216-20971519` 三片而**同尺寸的 AWS 仍是单片 64MB**——证明下发值真的在起作用）；**落点收口层**（`magicChunkCap` 唯一实现点且四处调用点同源、`upload/init` 的直传分界受厂商上限约束 + 分片钉死 + 超天花板当场 400、三处复制路径都只经 `providers.copyNeedsSlice` 且旧的两份 `COPY_SIMPLE_LIMIT` 常量已彻底移除）；**前端标识层**（`providerList()` 顺序与服务端注册表逐字一致、图形为单条 path 且剥净 `p-id`/`class` 等生成期噪声、`idLabel`/`keyLabel` 与 `credentialLabel` 同值、每个登记厂商都有图））
│   ├── audit47-regressions.test.js # 第四十七轮护栏（用户报告的三条界面体验缺陷：①「执行某些操作后必须刷新才能看到正式生效的结果」②「刷新页面不会回到原来的页面」③「只能点浏览器刷新按钮，按 F5 刷新没有作用」。根因是 ③：键盘处理把浏览器刷新键抢走了，于是用户口中的「刷新」按下去毫无反应，唯一能真正重载的只剩工具栏那颗按钮，而整页重载又没有地址记忆（②），重载前那些**跨区块**的陈旧数据也只能靠用户自己发现（①）。护栏分四层：**源码层**（刷新键不再被拦截、不得再出现「preventDefault + 只刷文件列表」的组合、右键菜单不再宣称该键、登出与换账号时记忆作废、回写用 `history.replaceState` 而非 `location.hash` 赋值、启动时**先读 hash 再 navigate** 的先后顺序）；**角色门控行为层**（把真实的 `viewFromHash()` 连同 `MAIN_VIEWS` / `VIEW_ENTRY` 抽出来，用假 `location` / `document` **真跑**：入口被隐藏或根本不存在时必须回落到文件浏览 —— 不能只做源码断言，`!el.hidden` 那样的取反同样含 `el.hidden` 子串）；**api.js 行为层**（装假 `fetch` **真调用**请求出口：写成功必通知 / 读与非变更类写（探针、登录登出、解锁、挑战生成）不通知 / 失败绝不通知 / 观察者抛错不得影响请求结果 / 豁免必须精确到「那条探针」而不能顺手把同前缀的真实保存一起豁免）；**端到端层**（把 main.js 里真实的「通知 → 去抖 → 同步」抽出来挂到**真实**的 api.js 上，用假 fetch 驱动写请求，断言配置重拉 + 加密摘要 + **当前区块**刷新真的被触发；批量写请求合并成一次；同步进行中的写请求必须串行且不丢）；另有**接线层**（观察者在启动时确实注册、依赖方向单向）。配套 17 条反向对照（`R47-01a`~`R47-05`，其中 `R47-03c` / `R47-04e` 为**两步变异**；R57 追加 `R57-03a` —— 登录前三条匿名写端点若失去「不触发界面同步」的豁免，点「发送验证码」就会 toast 一句假的「会话已过期」）。
│   ├── audit48-regressions.test.js # 第四十八轮护栏（用户提出的三项：① 按 `FEASIBILITY-单线程改造.md` 改造为多线程 + 多文件同时上传，并在系统设置「用户管理」与「负载均衡」之间新增「线程并发」卡片（最小 1）；② 订单管理新增「收入统计」卡片（总计收入 / 单文件累计收入 / 累计售出次数 / 单价 / 来源存储桶）；③ 版本推进至 1.7.0。护栏分五层：**线程池行为层**（真把任务丢进池并与主线程同步实现**逐字节比对**（两种模式 × 多种长度与非对齐偏移）、用「入参未被就地改写」证明这次计算确实发生在**另一个线程**上、`ENCODER_WORKERS=0` 必须退回主线程且结果一致、停机时在途任务**就地算完绝不丢**、线程数收敛到 `[1, min(8, 核数-1)]`、异步入口与同步入口的密文与元数据逐字节一致、两条写入路径必须走异步入口（判据**先剥注释**——`fs-gateway.js` 的注释里就写着同步名，不剥会让负向断言被自己的注释判红、正向断言被注释满足）、工作线程只允许依赖纯原语模块）；**调度层**（`uploadPlan()` 穷举表格 + 「文件数 × 分片数 ≤ 6 条连接」不变量 + 残留预算必须用满、拿不到配置或值非法一律退回**串行**、预览文案与调度同源、`upload.js` 不得复活硬编码常量）；**调度行为层**（沙箱拷入**真实** `upload.js`，数「同时在途的 `xhrPut` 峰值」：设为 1/2/5 时峰值必须恰好是 1/2/5 —— 只断言常量表等于某个数是证明不了「界面设了就真的并发起来的」）；**收入口径层**（只算 `paid`、退款单列、按对象键归集且不与同名文件混淆、单价取最近成交价并可标区间、桶名取第一个非空快照且绝不猜）；**接线与卡片层**（卡片顺序、`ADMIN_ONLY_CARDS`、`min="1"`、收入卡片在订单管理区块内且与订单表**同源**渲染、`computeRevenue()` 全前端只有一个实现点、并发配置「缺失 ≠ 非法」三分支、入参非法必须显式 400）。
│   ├── audit49-regressions.test.js # 第四十九轮护栏（用户提出的两项：① 自签名证书「会被浏览器判为不安全、也换不来安全上下文功能」故移除 `selfsigned` 依赖与自签名相关功能，改为只加载运维自备的真实证书（`TLS_CERT_FILE` / `TLS_KEY_FILE`，缺省 `data/tls/`），没有证书时**只跑 HTTP**（内置 HTTPS 与 WebDAV 均不启动）；② 移除 COS 原生 API、腾讯云改走 S3 兼容协议，并把相关代码与文件名中的 `cos` 统一改为 `s3`。护栏 9 条：未配置证书判「不可用」并点名缺哪个文件、坏证书与「证书私钥不配对」判不可用（带**正向对照**，否则「一律拒绝」也能全绿）、加载过程**绝不写盘**（目录快照 + 静态写盘 API 双判据）、无证书时明文请求必须照常服务（不得 301 到没人监听的端口）、反代场景的 301 目标是**对外**端口（`PUBLIC_HTTPS_PORT`，缺省 443）、提供证书时内置 HTTPS 必须**真的监听**、WebDAV 缺证书不得启动且原因能传到界面（`getTlsError()` → `webdavView().tlsError`）、部署脚本不得再生成自签名证书（`--tls selfsigned` 显式拒绝、ACME 失败不再回退）、依赖与源码里不得再有 `selfsigned`。其中三条走**真实子进程 + 真实 HTTP/HTTPS 请求**——判的是「启动顺序与监听结果」，只有把进程真起起来才看得见。
│   ├── audit50-regressions.test.js # 第五十轮护栏（用户提出的四项中的三项：① 分享页的文件图标改用**对应类型**的图标（图形真相仍只在 `index.html` 的 `#icon-sprite`，服务端 `file-icons.js` 按需**内联** —— 分享页是服务端渲染的独立文档，没有雪碧，`<use>` 在那里只会画出一片空白且**不报错**）；② 文件列表支持**左键框选多选**（列表 / 宫格两种视图共用同一段矩形相交判据，4px 阈值、Ctrl 叠加、Esc 撤回、滚动条与表头不触发）；④ 「链接创建成功」弹窗改版（`div` 展示链接 + 复制按钮（无 `navigator.clipboard` 时回退 `execCommand`）+ 文件名 / 创建时间 / 过期时间 / 价格 / 允许下载次数 + 二维码，左码右信息；二维码走新增的 `GET /links/qrcode`，复用零依赖的 `server/qrcode.js`）。17 条护栏分四层：纯函数（内联而非引用、缺符号逐级降级、不返回不存在的 id）、**跨端等值**（服务端 `iconIdFor` 与前端 `util.js` 的 `iconIdOf` 对 22 个样本逐项相同 —— 否则同一个文件在两处显示不同图标而两边的单测都是绿的）、真发 HTTP（`GET /s/:id` 吐出的 HTML 里内联的是**该类型符号的图形内容**且不再出现 `📄`；雪碧读不到时降级回 emoji 且仍 200）、**沙箱真跑**（真实 `explorer.js` / `ops.js` + 假 DOM：框选真的选中被框住的行、Esc 撤回、点行 / 表头 / 滚动条都不劫持；弹窗真的渲染出链接与五项信息、二维码真的取回来、直链分支不误报「永久有效」）。第 3 项「多文件 / 文件夹分享」按用户确认挪到下一轮，故分享的数据模型本轮**一字未动**。
│   ├── audit51-regressions.test.js # 第五十一轮护栏（用户提出的两项中的前一项 + R50 挪过来的第 3 项：① 「链接创建成功」弹窗与链接 `div` 加宽，使链接**一行显示完**；② **多文件 / 文件夹分享** —— 分享页以**列表**形式平铺全部条目、可勾选要下载的、每页最多 50 个（50 以上分页）。三条口径经用户确认：**只勾 1 个文件按原名直传、多选或含文件夹则打包 `.tar.gz`**；**整批算 1 次下载**；列表**扁平平铺**（不按层级折叠，每行显示相对路径）。**35 条护栏分五层**：① **纯函数层** `server/tar.js`（每个头块的校验和按独立算法重算自洽、magic/version/uid/gid 按 POSIX ustar 写、超 100 字节走 GNU `L` 条目且真名在载荷里、`size` 越过 `8**11-1` 时改用 base-256 且能无损解回、`safeName` 就地消解 `..` 使任何输入都逃不出解包目录、`padding`/`endBlocks` 的字节形态）；② **打包层**（真实 `share-bundle.js` + 真实 `gzip` + 一份**独立写的 tar 解析器**：逐条目核对名字与内容逐字节相等（含跨块 1000 字节与超 100 字节的中文路径）、声明长度与实发字节**短/长两个方向都中止**（旧的「短了补零」会为一次失败下发申请 GB 级内存并交给用户一个能解开却是零尾巴的坏文件）、下游停止消费时**中止而不是永远挂着**、2000 条上限整包走完、响应头齐全且**刻意不声明 Content-Length**）；③ **快照 / 视图层** `share-store.js`（`normalizeItems` 硬截断到 2000、`itemList` 为历史单文件记录合成唯一读取点的输出、`listView` 判据在服务端 —— 它就是「要不要列表页」与「下载是直传还是打包」的**同一个**判据、`view` 默认**不**附带 `items`（否则链接管理一次请求几 MB JSON）、单一普通文件落盘形态与 R51 之前的记录**逐字段一致**）；④ **真发 HTTP 层**（真实 `share-routes.js` / `routes/links.js`：`POST /links` 收多路径（文件 + 文件夹）并冻结快照、旧 `path` 仍可用、重复路径去重、选中对象不存在时**整单 404**（与单文件时代口径一致）、目录内容超 2000 **截断并如实上报** `truncated`/`snapshotMax`；`GET /s/:id` 在 51 项时分 2 页而恰好 50 项不分页、`?page=` 越界/负数/非数字一律**夹取**到合法页、文件夹行排在文件之前、单个普通文件**仍是单文件页**（不因本轮变成列表，R50 的内联图标也不退化）；`GET /s/:id/dl` 拒任何**不在快照里**的 key（400 且**不占用下载次数**，否则反复探测就能刷光额度）、空选择 404、单选直传（带 `Content-Length`，保留进度与 Range 续传）、多选/含文件夹打包且**整批只记 1 次**、缺一个对象时**跳过它不让整包失败**、文件夹分享**不因「前缀 head 不到」被误判成已删除**）；⑤ **沙箱行为层**（真实 `ops.js` / `share-list.js` + 假 DOM：多选/含文件夹时预签名直链单选项在**下发出去的 HTML** 上就带 `disabled`（判假 DOM 的属性会是恒绿的假判据）、提交体走 `paths` 而非旧 `path`、弹窗真的挂上 `link-result-dialog`（宽度来源）且二维码异步填进容器、样式里链接 `white-space: nowrap` 且**不再**逐字符强断、勾选跨页累计并在提交时补成隐藏 `k` 字段且重复提交不累积、存储被禁用时降级而非抛错、脚本必须是同源**普通脚本**且 CSP 里确无 `unsafe-inline`）。**配套 42 条反向对照**（`R51-1a`~`6b`，逐条实跑并核对失败名单，台账 538 → **580**）。⚠️ 本轮**三处**自证过的判据塌陷：其一，CSP 断言最初用 `/script-src([^;]*)/` 直接扫 `server/index.js`，**先命中**了那句注释「SEC-06：移除 `script-src` 的 `'unsafe-inline'`」—— 必须**先剥行注释**再找指令；其二，`share-list.js` 与 `ops.js` 的断言若只判假 DOM 节点上的 `.disabled` / `checked` 属性，则永远为绿（假 DOM 不解析 `innerHTML`），故一律改判**下发的 HTML 字符串**；其三，把 `download-stream.js` 内联的统计 Transform 收敛到唯一实现点 `server/traffic-meter.js` 之后，PERF-09 的旧判据 `/new Transform\(/` **落在了已经没有该实现的文件上** —— 内联实现被搬走、行为**逐字等价**，套件却报 `tests/audit-regressions.test.js` 一条红。判据必须**分两层**：调用点层断言「必须委托 `createTrafficMeter(`」（并仍不得用 `out.on('data')` 做统计）、实现点层断言「显式 `new Transform(` 且不用 `.on('data')` 做统计」；两层各配一条反向对照 —— `R51-6a`（调用点把旧实现整段内联回来：与唯一实现点**行为等价**，故红的只有「必须委托」那一层）、`R51-6b`（实现点把间隔判据改成 `>= 0` 逐 chunk 上报：字节数**仍然精确**，红的只有「统计写次数应被汇总（≤2）」）。
│   ├── audit52-regressions.test.js # 第五十二轮护栏（用户提出的五项，口径均经确认后实施：① **多选分享入口** —— 右键菜单的多选分支补上「复制链接（N 项）」，与工具栏一致；② **「移动」报成功、实际没动** —— 目标选择器**不再预选当前目录**（不选就点「确定」不生效并说明原因）、目标与源全同时**当场拦住**、结果按**成功 / 跳过 / 失败**三类如实汇总（`skipped` 不再算成功）；③ 新增**复制 / 粘贴**，冲突处理与 Windows 资源管理器一致（逐项询问「覆盖 / 跳过 / 取消」，可勾「对后续全部冲突执行相同选择」⇒ 与「全是」同义）；④ 分享页**默认全选**（**跨页**语义：服务端直接渲染 `checked`，使无 JS 时也成立；同时注入整份快照清单，提交时挑**最短且无歧义**的表示 —— `mode=all` / `mode=exclude` + `x=<没勾的那些>` / 普通 `k`）；⑤ 分享页展示路径**脱敏**（抹掉「分享根之上」的祖先目录名，列表行与归档条目名**同源**）。**19 条护栏分四层**：① 纯函数层 `share-store` 的 `maskPrefix` / `maskedPath` / `itemPaths`（公共祖先本身是被选中的目录、无公共祖先、单条、中文、以及「恰好与祖先同名的**文件**不能被当成目录前缀抹掉」这个边界）；② 真发 HTTP 层（真实 express + 打桩云端：`POST /fs/move` 的**守卫顺序**（`newKey === key` 必须先于「自身内部」）与原地跳过、`POST /fs/copy` 的「先问后写」（询问阶段**一个字节都不写**）、`decisions` 的覆盖 / 跳过、目录递归与源保留、失败回滚**只删本次新建**（被覆盖的目标侧既有对象必须留下 —— 故必须传 `rollback:false`）、配额按**净增**计；分享页 `GET /s/:id` 的默认全选与脱敏行、`/s/:id/dl` 的三种选择表示与「排除集必须命中快照」）；③ 沙箱行为层（真实 `share-list.js` / `explorer.js` / `ops.js` + 假 DOM：首次打开真的默认全选、用户清空后刷新**仍是空**、提交真的走最短表示；多选右键菜单真的生成「复制链接（N 项）」并真的调用 `copyLinkSelected`；移动弹窗真的**不预选**、结果真的按三类分开汇总；冲突询问真的逐项弹窗、勾「全是」之后真的不再弹）；④ 静态不变量（`openFolderPicker` 不得再把 `App.state.prefix` 当默认目标；链接结果弹窗左右两列视觉等高）。**配套 22 条反向对照**（`R52-01`~`R52-06b`，逐条实跑核对失败名单）。⚠️ 本轮两处判据塌陷值得记下来：其一，桩化的 `openModal` **必须与真实实现同形** —— `close()` 要调 `onClose`、按钮的 `onClick` 要收到**它自己的** `close`；缺了这两点，「先 close 再 finish」这类顺序缺陷与「关没关弹窗」这类断言会双双变成恒真（`R52-03e` 第一次实跑就是 `fail=0`，而变异明明生效）。其二，把 `POST /fs/copy` 改用 `apiHandler`（R23-04 棘轮只许减不许增）之后，**错误体里的 `code` / `quota` 被静默丢掉**了 —— 而前端靠它区分「超出 API Key 空间上限」与「超出存储桶配额」，只能对所有 403 弹同一条提示；故把 `apiHandler` 的落地改走**唯一**的错误体序列化点 `errorBody()`（它是 `{ error }` 的超集，无这两个字段时输出与旧写法逐字一致）。
│   ├── audit53-regressions.test.js # 第五十三轮护栏（用户提出的一项：在「用户管理」与「线程并发」之间新增「**发信设置**」卡片，允许管理员配置 SMTP，且**不新增任何依赖**）。**49 条护栏分十三层**：① **纯函数层**（`limits.js` 的端口归一化与入参判据）；② **信头注入层**（地址 / 文本一律拒绝 CR / LF —— SMTP 是行式协议，命令与信头都是手工拼进一行的，一个换行就是一次注入）；③ **配置层**（口令三态、落盘归一、加密方式跟随端口）；④ **视图层**（`safeView()` 两处返回都带 smtp、且两处都不含口令明文）；⑤ **信件构造层**（RFC 2047 编码字、76 字符折行、DATA 点填充）；⑥ **协议行为层**（真实 `server/smtp.js` + 进程内假 SMTP 服务器，真的走完 EHLO → MAIL → RCPT → DATA → 正文 → `CRLF.CRLF` → QUIT，含 STARTTLS 与 AUTH PLAIN / LOGIN，用 **TLS-PSK** 免证书）；⑦ **接线层**（真 HTTP 端到端：三条接口全部仅管理员、响应体不含明文、地址含换行 400、端口非法 400、保存后真发一封）；⑧ **前端卡片层**（卡片下标夹在两张卡之间、登记进 `ADMIN_ONLY_CARDS`、口令框永不回填）；⑨ **取用层**（R55 追加 4 条：**系统自己发的信**也必须带上落盘口令 —— 落盘一份口令后真连一个**要求认证**的假 SMTP，断言它收到的 `AUTH PLAIN` 载荷就是那份口令、且验证码真的进了 DATA 正文；再走一次匿名 `POST /auth/forgot` 把「路由 → `email-code.js` → `smtp.js`」整条链路串起来）；⑩ **启用开关层**（R55 追加 5 条：**停用 = 系统自动发信一律不发** —— 停用后系统发信直接 503 且假服务器**一行命令都收不到**、**正向对照**（同一份配置启用即照常发）、停用**不影响**管理员手点的测试邮件、停用时匿名 `/auth/forgot` 命中与未命中的响应**逐字节相同**、需登录的 `/auth/email/code` 如实 503）；⑪ **站点级探针层**（R57 追加 4 条：`probeMailer()` → `smtp.verify()` **真的连一次并完成登录、且不投递任何邮件**；认证被拒 / 连不上 / 未配置 / 已停用**四类失败各自给出可执行提示**；探针必须在**读取标识之前**执行（`R57-03` 钉顺序）—— 挪到后面响应就又随标识而变；端到端：配置齐全但服务器认证被拒时，匿名 `POST /auth/forgot` **如实 503** 而非回「已发送」）；⑫ **建连截止层**（R58 追加 3 条：对端**丢包**（非拒绝）时必须按**硬截止**报错、绝不永久挂住、且超时后套接字被销毁（`R57-09`）；`AggregateError`（多地址全不可达、`message` 为空串）必须**拆出逐地址原因 + 可执行提示**、不得只剩一句 `AggregateError`（`R57-10`）；**正向对照**：调大超时后真实会话仍成功 —— 缺了它「一律立刻拒绝」也能让前两条全绿（`R57-11`））；⑬ **用户文案层**（R61 追加 1 条：走**真实 HTTP** 向 `127.0.0.1:1` 发测试邮件（必然 `ECONNREFUSED`），断言响应体点名「连的是谁、什么错误码」、且**不含**「网络连接异常」—— `apiHandler` 会把**没有 `status`** 的错误送进**对象存储**的翻译层，R58 拼好的逐地址诊断就会被一句「网络连接异常，请检查网络后重试」覆盖）。**配套 28 条反向对照**（`R53-01a`~`R53-11b` + `R57-01a` / `R57-02a` + `R57-09a` / `R57-10a`，逐条实跑并核对**失败名单**，其中 `R53-10a`~`d`、`R53-11a`~`b` 为 R55 追加；R57 另把 `R53-10a` / `R53-11a` 的锚点**迁到新形状** —— 取配置收口进 `mailerState()`、闸门改成返回 `{status, error}`）；版本 `1.7.5` → `1.7.6`，R58 修 `smtp.js` 建连截止后升 `1.8.4` | **① 零依赖是本轮的硬约束，也是唯一可行的形态**：需求原文「尽量不要新增任何依赖项」 ⇒ 不引 `nodemailer`，直接用 `node:net` / `node:tls` 手写 SMTP 会话。**② 两处「看似吹毛求疵、其实是安全属性」的判据**：其一，**口令只在加密连接上发出** —— 明文连接上一律拒发（否则一次抓包就是一次凭据泄漏，而界面上会显示「测试成功」）；其二，**换行必须在 trim 之前判** —— 早先写成先 `v.trim()` 再判 `[\r\n]`，于是 `a@b.com\r\n` 被裁成合法地址放行，「能不能注入」变成依赖「trim 恰好把恶意内容删干净」的性质（中间的换行删不掉，两种输入两种答案）。这两条是本轮**唯二**由自写护栏首跑抓出的真缺陷。**③ 三处归一化调用点（纵深防御）**：`normalize()`（读盘）、`save()`（写盘，`save()` 是顶层键替换）、`getSmtp()`（取用）各归一一次 —— 故对应反向对照**必须三步一起撤**才变红，只撤一处 `normalize()`（台账里已注明这是纵深防御的正常形态，与 `R28-03` 同型）。**④ 加密方式缺省跟随端口**（465⇒隐式 TLS，其它⇒STARTTLS）：若固定 `secure: true`，587 端口会去握隐式 TLS 而必然超时；若缺省 `secure: false`，465 又会在明文里发口令而被自己的保密闸门挡下 —— 两个方向的**默认组合**都必须是「这一行的常用用法」。**⑤ 测试邮件提交的是表单当前值且不受 `enabled` 开关限制**：管理员手动触发的一次性动作，若受开关限制就关掉了「先配好、再验证」的窗口。
│   ├── audit54-regressions.test.js # 第五十四轮护栏（用户提出的四项中的第一项，非审计轮：在「用户管理」**之上**新增「**站点设置**」卡片 —— ① **站点名称**（浏览器标题栏 + 邮件发件人显示名的兜底，默认「Kepler 对象存储管理系统」）；② **公开注册**（`open` 可随意注册 / `invite` 必须填邀请码 / `closed` 不开放，默认 `closed`）；③ **新用户身份**（注册后直接赋予的角色，默认「普通用户」）。该卡片**没有启用开关** —— 需求明确「该功能默认开启」。**22 条护栏分七层**：① **判据层**（`parseSiteNameInput` 复用 `parseSmtpTextInput` 的两条判据：**先判 CR/LF 再 trim**（否则 `名字\r\n` 被裁成合法文本放行 ⇒ 信头注入面）与 128 字符夹长度，空串合法 = 恢复默认；两个枚举的归一化一律回到最保守的那一档）；② **配置层**（历史配置没有 `site` 段时补齐默认值、`saveSite` 的 PATCH 语义、空站点名**落盘时**回退默认、半截对象读回来也是完整结构、归一化**只补结构不拒非法值** —— 入参非法由路由层显式 400，落盘路径遇脏值静默补齐）；③ **视图层**（`safeView()` 的**两处**返回都带 `site`，`siteView()` 对任何输入都给完整结构而不是 `undefined`）；④ **路由层**（真起 HTTP：`/site/info` **匿名与普通用户都能读**且**只回 `ok` + `siteName` 两个字段**（匿名可达的接口多回一个字段就是把配置面暴露出去）、`/site/config` 的 GET / PUT 在未登录与普通用户下**均 403**、管理员读写回环、非法入参 400 **且不改动已存配置**、`'/site/info'` 必须登记进 `index.js` 的匿名白名单 `PUBLIC_API`）；⑤ **发信兜底层**（真起假 SMTP 服务器，断言收到的 `From:` **显示名**与 `Subject:` 就是站点名称；并反向验证「SMTP 卡片里填了显示名就以它为准、站点名称不得覆盖」）；⑥ **前端卡片层**（卡片位置在「用户管理」之上且不破坏 R53 的「用户管理 → 发信设置 → 线程并发」顺序、**卡片内不得出现启用开关**、登记进 `ADMIN_ONLY_CARDS` 且排在最前）；⑦ **标题栏接线层**（`applySiteName` 是**唯一**写 `document.title` 的点；`main.js` 必须**在 `checkAuth()` 之前**拉 `/site/info` —— 放到后面则未登录的登录页永远拿不到站点名称，而界面上只表现为「标题栏一直是那串硬编码」）。**配套 13 条反向对照**（`R54-01a`~`R54-07b`，逐条实跑并核对**失败名单**）；版本 `1.7.6` → `1.7.7` | 五条口径差异值得记下来。**① 权限刻意分两级**：`GET /site/info` **公开** —— 登录页在拿到会话之前就要设标题栏，没有它标题栏只能一直是 `index.html` 里那句静态 `<title>`；而 `GET/PUT /site/config` **仅管理员**。这个分法让 `PUBLIC_API` 这个匿名白名单第一次为「页面外观」而不是「认证流程」开口子，故两条反向对照分别钉住「公开的那条万一被挂上 `requireAdmin`」与「忘记登记进白名单」。**② 默认注册模式必须是 `closed`**：本版本之前系统**没有注册入口**，默认成 `open` / `invite` 等于升级即悄悄开放了一个谁都能进来的注册通道 —— 这是本卡片唯一一个「默认值本身就是安全属性」的字段。**③ 站点名称的默认值与 `public/index.html` 的 `<title>` 必须同文**：`applySiteName` 拿不到接口（网络失败 / 服务未起）时**不写**标题，此时显示的就是静态 `<title>`；两者一旦不同文，用户会看到「刚打开是一个名字、登录后又变一个」，而全程没有任何报错。**④ 站点名称与 SMTP 发件人显示名是两个不同功能的字段**，故 `limits.js` 里 `SITE_NAME_MAX` 与 `SMTP_NAME_MAX` 同为 128 但**刻意各留一份常量**：共用一个常量时，哪天给其中一个放宽就会让另一个跟着动，而那种连动没有任何理由。**⑤ 本轮最容易顺手改坏别处的是「纯位置声明」**：`ADMIN_ONLY_CARDS` 插入新成员与 `safeView()` 插入 `site:` 行这两处，**同时打坏了 4 条既有反向对照的 anchor**（`R41-02k` / `R48-04a` / `R53-04a` / `R53-09a`）—— `invariants.test.js` 一跑就报「命中失效 anchor」，这正是那条兜网存在的意义；顺手还纠正了 `R41-02k` 一处 R53 遗留的**判据错位**（anchor 顺着往后挪了一行，于是它判的已经不是它声称要判的那一行）。
│   ├── audit54b-regressions.test.js # 第五十四轮**第②步**护栏（非审计轮，续 `audit54-regressions.test.js`：登录页新增**注册** / **记住密码** / **忘记密码**，并把「邮箱」变成一条**可自助维护**的凭据 —— 覆盖需求 2.1~2.6）。**33 条护栏分八层**：① **判据层**（`limits.js` 的 `parseEmailInput` / `normalizeEmail`：长度 / 唯一 `@` / 本地部分字符集（RFC 5322 `atext` + 点号）/ 点号位置 / 域名须含点且 TLD ≥ 2 / **含 CR/LF 一律视为「没有邮箱」**（`normalizeEmail` 对脏数据返回空串而不是把换行带下去 —— 邮箱会原样进 SMTP 的 `To:`，而 `validateForSend` 只判非空，不夹字符集时 `a@b.com,c@d.com` 能过「有且仅有一个 `@`」并把同一封信发给第二个地址）；`checkEmailCode` 的 TTL / 尝试次数上限 / **用满即作废但记录不删**（删记录会连 `sentAt` 一起抹掉 ⇒ 重发冷却失效 ⇒ 攻击者每错 5 次就能立刻要新码））；② **数据层**（`config-store`：`userView` 带上 `email` 且**非空即视为已验证**（无 `emailVerified` 字段）、`assertEmailFree` 对空串不参与查重、`updateUser({email})` 落库前查重、`findUserByIdentifier` **先用户名再邮箱**）；③ **验证码层**（`server/email-code.js`：`issue` / `check` / `consume` 三态、**只存 sha256 哈希不存明文**（静态层断言源码里不得出现 `rec.code` 这类明文落点）、`timingSafeEqual` 比较、`MAX_ENTRIES` 驱逐、`rollback` 只在发信失败时归还、`sweep` 按 TTL 清理）；④ **注册路由层**（真起 HTTP：`registration: 'closed'` 时注册**明确拒绝并提示**（用户确认口径：诚实、不假装生效）、`open` 时可注册且**注册即登录**（`completeLogin`）、身份取 `site.defaultRole`、要过 captcha、**先判注册模式再校验入参**（否则白走 scrypt））；⑤ **找回路由层**（真发信 + `/auth/forgot` 响应**恒真**（未注册的账号与已注册的账号回**逐字节相同**的响应体 —— 它是匿名可达的，回不同的体就等于一个账号枚举器）、端到端取码改密、旧会话必须失效）；⑥ **自助 / 管理邮箱层**（改邮箱要**两道证明**：验证码证明「这个地址归我」+ 当前密码证明「是我」；解绑免验证码但要当前密码；管理员可改任何人邮箱且**不撤销会话**）；⑦ **前端接线层**（`main.js` 的 `authMode` 四态、`rememberPassword` 的 `xorBytes` 对合性、`api.js` 三个 `noAuthRedirect` 出口、`profile.js` / `syssettings.js` 的邮箱接线，以及 `api.js` 是否把限流响应的 `Retry-After` **真的挂到 `err.retryAfter`** 上 —— 这一条装一个带响应头的假 `fetch` **真跑一次请求**，因为原先只断言「源码里出现过 `retryAfter` 这个词」的静态判据正是**假绿**的标本：变异成 `NaN` 之后那个词仍在源码里、断言照样绿，而真到响应那一步会先撞上「假 `fetch` 桩没有 `headers`」的 TypeError，连 `err.status` 都拿不到，详见 `R54b-08c`）；⑧ **找回密码界面层**（R57 追加 3 条：标识输入框的提示词必须与「用户名或邮箱」的 label **同源**（那个输入框在 `login` / `init` / `register` / `forgot` 四形态里是**同一个元素**，`placeholder` 不能写死在 HTML 上）、发送失败**不得推进步号**（`forgotStep` 只能在 `try` 的成功分支里置位）、重置窗口的「重新发送验证码」存在 + **带 60 秒倒计时** + **重绘不会把它复原成可点**）。**配套 27 条反向对照**（`R54b-01a`~`R54b-08c` + `R57-04a`~`R57-08a`，逐条实跑并核对**失败名单**）；版本 `1.7.7` → `1.7.8` | 五条口径值得记下来。**① `/auth/forgot` 必须「恒真」**：它在匿名白名单里，回「该账号不存在」就等于把注册用户的枚举接口白送出去，故**发信失败与冷却命中都只记日志**、响应一字不变；代价是前端得自己写 60 秒倒计时（服务端不能回 `Retry-After`，一回就等于告诉攻击者「这个地址存在」）。而 `/auth/email/code` **需登录**，故它**如实回 429 + `Retry-After`**，`api.js` 把这个值透传到 `err.retryAfter` 供界面倒计时。**② 改邮箱为什么要两道证明**：验证码证明「这个地址归我」（缺了它，手滑绑错地址 = 把密码重置渠道白送给别人），当前密码证明「是我」（缺了它，会话被劫持时攻击者能永久接管账号 —— 收件箱在攻击者手上，验证码帮不上任何忙）。**③ `req.authUser` 没有 `email`**：它只有 `{id, username, role, permissions}`（见 `index.js` 鉴权中间件），取当前邮箱必须走 `configStore.findUserRawById(me.id)` —— 本轮真 HTTP 护栏抓到的**生产 bug**：`/auth/email/code` 的 `alreadyBound` 分支写 `normalizeEmail(me.email)` 恒 `undefined`，该分支永不命中。**④ 管理员设置 / 修改的邮箱视为「已验证」**（用户确认口径）：管理员本来就能重置任何人的密码，标记未验证只会形成死锁（收不到信的人无法自助改密）。**⑤ 验证码只存哈希**：库里落的是 `sha256(code)`，比对走 `timingSafeEqual`；`email-code.js` 刻意不含任何 require（`limits.js` 是「零 require 叶子模块」，它的循环依赖破除职责不能被破坏），键构造函数也因此叫 `codeKey` 而不是 `keyOf` —— `invariants.test.js` 的缓存键护栏用 `/\bkeyOf\s*\(/g` 字面量扫全库、会误伤任何同名的函数，改护栏去放行等于给它开一个洞。
│   ├── audit54c-regressions.test.js # 第五十四轮**第③步**护栏（非审计轮，续 `audit54b-regressions.test.js`：`side-foot` 新增「**邀请码设置**」+ 批量生成 / 删除 / **导出 txt（一行一个）** + 单独与批量设置**使用次数 / 过期时间 / 注册后的身份**，并把注册接口的 `invite` 模式从 R54② 的「功能尚未开放」临时口径改成**真核销**）。**24 条护栏分五层**：① **判据层**（`limits.js` 的 `normalizeInviteCode` / `parseInviteCodeInput` / `parseInviteCountInput` / `parseInviteMaxUsesInput` / `parseInviteExpiresInput` / `parseInviteNoteInput`：去全部空白 + 转大写、10 位无歧义字符集（去掉 0/O/1/I/L）、**先判 CR/LF 再归一**、数量 1~500、次数上限 `0` = 不限制且**负数必须 400**（落盘归一会把 `-1` 归成 `0` ⇒ 限制被彻底放开）、过期时间**必须晚于 now**（要立即失效有「停用」）、备注复用 `parseSmtpTextInput`）；② **存储层**（`invite-store.js`：批内与全局撞码重摇、核销四档失败**可区分**（`not_found` / `expired` / `used_up` / `disabled`）、`remaining` 为 `null` 表示不限制、回滚只删**最后一个与本用户名相同**的条目、PATCH 语义 + `disabled:false` / `maxUses:0` / `expiresAt:null` 三个假值都是**有效指令**、导出 `n` 行 + **末尾换行** + 无 BOM、脏记录（非法码 / 重复码 / null）**整条丢弃**且不静默重建）；③ **路由层**（真 HTTP：六条接口全部仅管理员 —— 未登录 401 / 普通用户 403、生成→列表→批量→删除回环、入参非法一律 400 且**不留副作用**、导出响应是**纯文本本身**（不是 JSON，也不是 JSON 包装））；④ **注册接入层**（真 HTTP：`closed` 明确拒绝且不看码、`invite` 模式「不填码 400 / 格式错 400 / 码无效 403 / 码有效成功」四档、身份取**码上的 role** 而不是站点默认、建号失败**必须回滚**、`open` 模式忽略请求体 role、以及**三步顺序**的静态断言 —— 核销必须晚于人机验证，否则成一条邀请码存在性 oracle）；⑤ **前端层**（`index.html` 侧栏入口与整页 `card-view`、`main.js` 的 `MAIN_VIEWS` / `VIEW_ENTRY` / 五个接线点与**真跑 `viewFromHash()` 的角色门控**（含对照组）、`api.js` 六个方法 + `requestText`、`invitemgr.js` 的导出形态与「状态判定不做第二份」、登录页邀请码框只在「注册 + 邀请码模式」出现）
│   ├── azure-client.test.js # 【多云】Azure Blob 客户端护栏（起一个**自己验签**的假 Azure：Shared Key 规范串 / 列举与翻页 / 单传与 HEAD 小写头 / Range 与流式 Output / 块分片与断点续传（含「块列表响应带游标」的反例） / 异步复制轮询 / 批量删除白名单 / ACL 映射 / SAS 预签名直链 / 错误形状）
│   ├── coupon.test.js # 【R62】优惠券护栏：判据层（券码 / 数量 / 金额 / 次数 / 时间 / 目标）/ 存储层（状态优先级、三类适用范围、总次数与每人一次、价格封顶、核销幂等与按订单回退、匿名身份）/ 关系层（订单原价·优惠·券码快照）/ 接线层（五条接口仅管理员、退款只回退非无门槛券、分享页券码入口与原价划线）
│   ├── coupon-threshold.test.js # 【R88】「满 xx 减 xx」门槛护栏（6 条）：判据层（`parseCouponMinSpendInput`，空 / 0 = 无门槛、负数与非数字拒绝、**0.004 元必须报错而不是四舍五入成无门槛**、上限）；存储层（`minSpendFen` 真的落进**记录**而不只是视图、存量券缺字段视为无门槛、非法值降级不丢券、超上限 clamp）；金额层（原价 < 门槛必须拒绝且文案**写明门槛金额**、等于门槛可用、**门槛不参与封顶**——满 20 减 50 在原价 20 上仍是优惠 19.99 / 应付 0.01）；优先级（免费链接必须报 `no_price` 而不是「未满 xx 元」、门槛与 `type` 正交、身份门槛优先于金额门槛）；接线层（真 HTTP：生成 / 单条改 / 批量改都能写门槛，且 `minSpend: 0` 能把满减券改回无门槛——PATCH 语义陷阱）；前端层（「满 X 减 Y」真进「优惠」单元格、生成请求真带 `minSpend`，取函数体再数）
│   ├── restore-settings.test.js # 【R65】「订单取回」设置卡片的护栏（10 条）：配置层（默认 3 / 5、越界 clamp、反复归一化幂等）/ `saveRestore` 的 PATCH 语义 / 接口层（两条均 403 给非管理员、非法入参 400 不静默改写）/ **按订单号**的取回配额（同号第 N+1 次拒绝且文案给出口径）/ 连击封禁（达上限即封、24 小时自动过期、成功一次即清零）/ HTTP 层（第 N+1 次真的拒签票据、封后不再渲染表单）/ **封禁只拦取回**（同一 IP 在封禁期内分享页、`HEAD /dl`、`GET /dl` 全部照常）/ 管理端解封与 403 / 前端卡片位置（**在站点设置与用户设置之间**）+ 无任何开关控件 + 解封按钮接线
│   ├── repo-hygiene.test.js # 【R66/R67】仓库级卫生护栏（7 条）：R66 的四条（CI 真的会执行 / 目录树登记了 CI 与 `jsconfig.json` / 测试不得把数据目录写死 / `/health` 两个字段按角色分档）+ R67 的**三条拆包不变量**（`server/webdav/` 内不得有孤儿文件 / 下层模块不得反向 require `./app`（成环）/ 入口文件不得再注册任何路由）；R66 部分详述：CI 工作流真的会执行（先剥 `#` 注释行再断言 `npm ci` / `lint` / 逐文件 `node --test "$f"`，并核对平台与 Node 版本矩阵、禁止 `continue-on-error`）/ 文档目录树登记了 CI 与 `jsconfig.json` / **测试不得把数据目录写死成仓库 `data/`**（逐行扫描，`process.env.S3_DATA_DIR || path.join(ROOT,'data')` 这种合法兜底放行）/ `/health` 的 `bucketCount` 与 `lastWriteAt` **真发两次 HTTP** 验证只给管理员
│   ├── share-orders.test.js # 【R64】分享页取回下载权限的护栏（14 条）：订单号结构（36 位 / 13+9+9+5 分段 / UID 确定性派生）/ 唯一性与字符分布（200 次不撞号、大小写与数字都出现、游客 userUid 每次随机）/ `orderNo` 与 `id` 并存且 `id` ≤ 32 位（微信硬限制）/ `claimForLink` 四类拒绝且**同一条文案**（防订单号存在性预言机）/ 老订单凭 `id` 取回（含空格容错）/ 未登录「恢复购买」与已登录「查看历史订单」两条入口 + 右上角登录·退出登录 / 已支付页的 36 位订单号与复制按钮 / 恢复购买**签发的就是同一枚票据 Cookie**（故 `/dl` 与 `HEAD /dl` 零改动）/ 历史订单只列自己、免费下载只记首次、逐笔补发票据 / 退出登录销毁会话 / `download-log` 去重与隔离 / `orderRestoreLimiter` 第 21 次拒绝
│   ├── audit69-regressions.test.js # 【R69】《安全漏洞分析报告》（2026-10-20，基准 v1.9.4）修复护栏（26 条）：H-1 前端不再保存密码（无 `xorBytes`/`rememberPassword`、登录遮罩必须清空密码框）/ H-2 部署模式 `/auth/init` 必须安装令牌（无令牌与错令牌都 403 且不留账户、正确令牌一次性用后即删）/ M-2 用户名拒绝 `@` 与「含 `@` 走邮箱」的标识判据 / M-3 scrypt `N=131072` 且参数真的进算法、旧参数哈希仍验得过 / L-5 口令 8 位下限 + 弱口令 + 纯重复字符 / L-7 非空 `permissions` 一律 400 / L-4 注册冲突的全站预算（30 次封顶）/ L-6 跨 IP 账户级减速（20 次后递增、上限 1.5s）/ M-4 XFF 按跳数剥取且末尾非法时不退回首段 / L-8 限流 hits 表硬上限 / I-5 查单金额对账（付 1 分不能确认 1 元的单）/ M-1 未配置 `webhookId` 时 PayPal 验签必失败 / L-1 台账截断后「每人一次」仍生效 / L-12 `isNotFoundError` **切出函数原文执行**（403/5xx/网络都必须判「不是不存在」）/ I-4 通知端点 256KB 解析器早于全局 2MB 且真的被调用 / L-11 Node 包校验先于解压 / I-17 淘汰顺序真为「最久未活动」/ L-2 分享页两个入口共用限流且早于查表
│   ├── audit70-pwa.test.js # 【R70】PWA 护栏（17 条）：manifest 名称**跟随站点设置**（含**长名不得截短** `short_name` —— 它才是建快捷方式时的取值）/ 可安装性硬字段（`display:standalone`、192+512、maskable、图标文件真实存在）/ manifest 是**动态路由**而非静态文件且注册在 `express.static` 之前 / `GET /manifest.webmanifest` 匿名可达 + `no-cache` + 改站点名后名称真变 / `GET /sw.js` 的**代码行**里版本号真被替换（不是只换了注释）/ 模板里占位符**只出现一次且落在 `const VERSION` 行** / `BYPASS_RE` 逐路径验 `/api` `/s` `/dav` 不被缓存且判据早于分支 / 缓存名带版本 + `activate` 真删旧缓存 + `skipWaiting`/`claim` / `install` 不用 `addAll` 且带 `cache: reload` / index.html 三处声明（manifest、theme-color 与 manifest 同值、apple-touch-icon）/ 安装项默认 hidden 且显隐由 `canInstall()` 决定 / `beforeinstallprompt` 只存凭据、`prompt()` 只在点击里 / SW 注册失败静默 + main.js 接线 / CSP 显式放行 `worker-src` `child-src`（被拦时页面完全不报错，只能静态守）/ 图标 PNG **解码像素**核对（四角透明 = 圆角、maskable 四角不透明白 = 满版）
│   ├── root-role.test.js    # 【R71】根用户与管理员越权边界护栏（24 条）：判据层（`isRoot`/`isStaff`/`canManageUser`/`canAssignRole` 矩阵）/ 存储层（空库第一个账户**强制**成 root、已有账户后请求 root 403、root 不可撤销、最后一个 root 不可删、**升级迁移**按 `createdAt` 补 root、读盘归一不得把 root 降级）/ 路由层（管理员删/编/封禁/强踢管理员或 root 一律 403 且**目标一字节未改 + 会话未吊销 + 留 `users.denied` 审计日志**；管理员建 admin 或提权 403；根用户可管管理员；任何人不能授予或撤销 root；管理员删普通用户仍成功；**另外两条「授予管理员」的通道（邀请码 / 站点「新用户身份」）对管理员一律 403**）/ 前端层（`isStaffRole` 判据、根用户徽章、他人 admin/root 行按钮 `disabled` 且带说明、角色下拉只对根用户、邀请码 admin 档只对根用户）
│   ├── settings-ux.test.js  # 【R73】设置页四项界面改进护栏（18 条）：卡片顺序（站点→用户→取回→发信，且 ADMIN_ONLY_CARDS 同序）/ 锚点导航栏**真跑**（轻量 DOM 桩加载真实 `anchornav.js`：锚点数==可见卡片数、跳过 hidden、只剩一张时收起、标题不含徽章·计数·按钮、滚动**减掉锚点栏高度**、高亮唯一）/ 锚点栏结构（在 #systemsettings 内且排在栅格之前、sticky、`[hidden]` 显式 display:none、窄屏横向滚动）/ 备份文件（`isBackupJsonFile` 扩展名门禁、`parseBackupFile` 三种失败**各不相同的提示**、`pickBackupFile` 真跑且非 .json **连内容都不读**、`backupFileName` 补 .json 与清洗非法字符）/ 首个用户口径（初始化页说「根用户」、安装令牌指引不再只指向启动日志、用户管理说明写清三层权限）
│   ├── audit74-regressions.test.js # 【R74】《Kepler 漏洞评估报告》复核轮护栏（4 条）：报告列了 9 条（F-01~F-09），复核后**只有 F-04 需要动代码**，其余或事实不成立（F-07 / F-08 的事实链 3 / F-09 的表述 / F-02 的可达性）、或属报告自己已承认的设计约束（F-03 / F-05），逐条判定见 `Audit_illusion_report.md`。F-04 拆成两面：**静态面**在 `invariants.test.js`「SEC-05：全库不得出现同步 scrypt」（`espree` AST，含违规样例自检），**行为面**在本文件 —— R74-01 `setTimeout(0)` 必须能在 `seal()` 完成**之前**插进来（语义判据，不用墙钟阈值；同步实现下定时器只能等 KDF 算完一起饿醒）/ R74-02 旧 KDF 参数（硬编 `N=16384` 的历史事实，不读 `SCRYPT_LEGACY`）封出的导出码仍解得开（异步化的两级回退不能只剩一级）/ R74-03 结构损坏（能解开但不是备份）**不得**报成「密码错误」——两级回退会把 `decodeCode()` 的异常一起吞掉，而这两种失败对应完全不同的可执行动作 / R74-04 路由必须 `await` `seal`/`open`（漏了会把 Promise 序列化成 `{}` 仍返回 200）。⚠️ R74-04 最初写成带 lookbehind 的正则，**被目标文件第 18 行的文档注释 `backup.open()` 判红**（真实调用在 L91/L117 都带 `await`）⇒ 改为 `espree` AST 判定「`CallExpression` 是否为 `AwaitExpression` 的操作数」，并带四条扫描器自检（裸调用必被抓、`await` 不得假红、注释不算调用）
│   ├── audit77-regressions.test.js # 【R77】外部加密模块审计 F-E1 的修复护栏（4 条）：历史元数据（crypto 分段缺 iv/tag）**不得静默解密** —— 判据落在「拒绝时**零字节下发**」这一后果上（不是「源码里有那行」）/ 正对照（完整元数据 + 未篡改密文必须照常解密，守卫不得误伤）/ 逃生门 `ALLOW_LEGACY_UNVERIFIED_CRYPTO=1` 确实回到旧行为，并**如实断言此时重排不会报错**（这正是默认必须关的理由，写成断言后谁把默认值改开都会当场变红）/ 写入侧 `buildFinalMeta` 拒绝缺 iv/tag 的分片（旧版本会话续传不得再落出免检条目）。配套反向对照 `R77-01a`~`R77-03a`
│   ├── audit78-regressions.test.js # 【R78】外部《模块安全审计报告》中**成立且值得修**的 12 条逐条护栏：① **H-1 分享加密门禁按「整份快照」判定**（旧判据只看 `l.key`，而多条目/文件夹分享的 `l.key` 恒等于快照第一项（目录 key 或首个明文文件）⇒ 列表页 / HEAD / 下载三处一起失效，匿名访客拿到解密后的明文）；② **H-2 `/fs/copy` 真实净增 + 记账**（单文件复制的任务大小原本恒为 0 ⇒ 闸门在「新增 0 字节」下判定；成功后也不喂 `adjustStorageCache` ⇒ 15 分钟缓存窗口内可无限超额）；③ **H-3 优惠券筛选参数顺序**（写反后是一条恒真判据 —— 实测症状是「搜索恒不生效、全部显示」，不是报告说的「对话框恒空」）；④ **IP-F05 IPv4-mapped 折算**（`::ffff:1.2.3.4` 必须按 v4 判定，否则照着界面看到的地址加的规则永不命中）；⑤ **IP-F03 命中计数落盘**（`flushHits()` 写盘失败只返回 false，绝不抛错 —— 在 `setInterval` 里抛错 = `uncaughtException` = 崩溃循环；降级态经 `view().rulesLoadDegraded` / `rulesPersistDegraded` 暴露）；⑥ **S3-F1 流式下载超时语义**（请求级定时器不再覆盖整个 body，改为「空闲看门狗」：总时长超限但数据在流动必须照常完成，连续无数据才以 `IdleTimeout` 中断）；⑦ **WebDAV-W5 / 文件-F07 回滚清元数据**（`rollbackCopies` 只对「云端确认已删」的键清 enc-meta，删除失败的**不能**清 —— 那才是真正的数据丢失）；⑧ **WebDAV-W1 username 唯一**；⑨ **SMTP 信头 CRLF 兜底**（收敛点 `normalizeOptions` 而不是拼装点）；⑩ **认证-发现1 代关 Windows Hello**（`denyIfCannotManage` 下沉到 `routes/_shared.js`，`users` 与 `webauthn` 两个路由族共用一份判据，并配**真发 HTTP** 的路由层用例 —— 判据写好了却没接上照样全绿）。配套反向对照 `R78-01a`~`R78-11a`（11 条，逐条实跑 `fail=1`）
│   ├── audit79-regressions.test.js # 【R79】用户报告的两个缺陷逐条护栏（7 条）：① **L1 签名侧归一化**（裸 PKCS#1 密钥体以 `MIIE` 开头、与 PKCS#8 同前缀 ⇒ 旧实现一律补 PKCS#8 头，OpenSSL 在**解码阶段**即失败：`error:1E08010C:DECODER routines::unsupported`，请求根本没出网）——判据落在「产出的 `sign` 能否被配对公钥**真验签**」，不是「URL 里有 sign 参数」；② **L2 保存校验器**（旧判据「头尾标记成对」||「字符集合法且够长」，四类真实错填全部放行并落盘：公钥贴进私钥框 / `A×240` / 带口令私钥 / 截断的 PEM）——判据落在**真实 `PUT /api/payment/config/:platform`** 的返回体上，错误必须定位到 `privateKey` 字段且提示点名真实原因；③ **「我已完成支付，立即查询」点了没反应**（命中 3 秒查单节流时 `finalizeOrderThrottled` 静默返回、无条件 303 回同一个等待页 ⇒ 页面一字未变）—— 现在把结果码 `?checked=pending|recent` 带回去如实回报，**没查就不得说成查了**（`recent` 文案给出具体秒数），并补上「重新发起支付」入口；④ **`?restart=1`**（等待页 / 失败页 / 二维码页的「重新支付」原本是 `href="/s/ID"` 的死路，GET 回来仍旧命中 pending/failed 分支）—— 反向守卫：已支付订单即使带 `restart=1` 也不得出现支付入口。配套反向对照 `R79-01a`~`R79-07a`（7 条，逐条实跑并核对「红的是哪几条」）
│   ├── audit80-regressions.test.js # 【R80】用户报告「点击『立即支付』没有任何反应」的 11 条护栏：① `POST /s/:id/pay` 的三条**静默 303**（付费刚停用 / 密码票据失效 / 订单已支付 —— 页面原样重画，一个字都不解释）改为 `?e=pay-off` / 直接渲染密码页 / `?e=paid`，并各记一条审计日志；② 跨站拒绝的**呈现形态跟着调用方走**（表单导航拿 HTML 页面，`fetch` 拿 JSON —— 旧实现一律裸 JSON，与历史上记档的「提交无反应」同源）；③ 支付宝 `sign_type=SM2` 不再静默降级成 RSA-SHA256（本地只有 RSA 实现，产出的必然是废票 ⇒ 下单前直接拒绝并指出改哪里）；④ 网关地址里的 `#` 会被剥掉（否则 `?app_id=…&sign=…` 整串落进**片段**，浏览器不发给网关 ⇒ 一片空白）；⑤ 渠道说「成功」却没给收银台地址时**当场报错**，不得降级到「等待支付」页（那里永远查不到东西）；⑥ 付费页的提交反馈（按钮禁用 +「正在创建支付订单…」+ 12 秒兜底提示）：`pay-poll.js` 在假 DOM 里**真跑**验证，以 `form[data-pay-submit]` / `#pay-state` 两个 DOM 挂点分别启用「提交看门狗」与「结果轮询」，互不干扰。配套反向对照 `R80-01a`~`R80-10a`（10 条，逐条实跑并核对「红的是哪一条」）
│   ├── audit81-regressions.test.js # 【R81】用户报告「支付时提示『没有收到服务器的响应：订单可能没有创建成功』，后台订单显示『支付中』」的 9 条护栏：① **出站超时只覆盖了响应头** —— `fetchWithTimeout` 把 `AbortController` 的计时器放在 `finally` 里清，而 `fetch()` 一拿到响应头就 resolve ⇒ 剩下的 `await res.text()/json()` 不再受 signal 约束，只剩 undici 默认的 `bodyTimeout`（**300 秒**）兜底；网关回了头却一直不吐体时 `createCharge` 挂到 5 分钟，而订单在 `await createCharge()` **之前**就已同步落库为 pending ⇒ 后端「支付中」、前端 12 秒就看门狗收工；判据落在**真跑**（本地起一个「写了响应头 + 半截体、14 秒才补齐」的网关桩，旧实现会在 14 秒拿到完整 JSON 并**判成已支付**，正确实现 10 秒即判「读取超时」，两种结局可区分且用例不会真挂 5 分钟）；② 下单新增**总预算** `CHARGE_TIMEOUT_MS = 9000`（PayPal 的「取 token + 建单」是两次串行出站，各 10 秒 = 20 秒，必然长过前端看门狗）—— 出站主机是硬编码常量（R21-12 的防 SSRF 设计，不为可测而放开），故判据落在**函数体切片后的精确调用点**上；③ `pay-poll.js` 的提交看门狗不再断言「订单可能没有创建成功」，改为先问 `/pay/status?probe=1` 再按**真实状态**说话（已建单 / 查不到 / 下单失败 / 已支付 / 无法确认，五条文案各不相同）；④ `?probe=1` 是**只读**的（不触发网关查单），用**双侧**证明：探针时网关桩零调用、同一订单不带 probe 时必须被调用一次。配套反向对照 `R81-01a`~`R81-09a`（8 条，逐条实跑并核对「红的是哪一条」）
│   ├── audit82-regressions.test.js # 【R82】用户要求的三条行为变更（9 条护栏）：① **换渠道即另建新单** —— 复用在途订单多一个前提 `pendingOrder.platform === platform`；换渠道时另建新单 + 把被放弃的那笔 `markFailed` + **退券**（不退券的话同一张「每人一次」的券在新单上会被判 `already_used`，用户换个支付方式就卡在「优惠券不可用」—— R82-02 专门盯这个，断言券的 `used` 净额仍是 1）；R21-06 当年「复用时回调地址必须指向原渠道」的护栏就此换了落点（`chargePlatform` 与 `platform` 恒等，旧变异不可观测），条目保留但改成「回调地址不得用别的渠道拼」；② **SM2 在保存时即拒绝** —— `payment-providers` 的选项带 `disabled: true` + `disabledReason`，`validate()`（保存的唯一入口）与前端 `<option disabled>` 读**同一个标记**，两层不可能分叉；真实 `PUT /api/payment/config/alipay` 返回 400 且错误定位到 `signType` 字段、给出「改 RSA2」的出路；③ **历史在途订单一次性标失败** —— `payment-orders.sweepStalePending()` 把 pending 统一改判 failed（记录保留、可被网关通知推回 paid），标记 `staleSwept: 'R82'` 落在 `payments.json` 顶层且**永不改值**（写成版本号会让每次升级都误杀真在途订单）；`loadFailed` 判据读 `load()` **之后**的状态（文件损坏时不得误报「清理成功」）；调用点挂在 `server/index.js` 的 `listen` 之前。配套反向对照 `R82-01a`~`R82-08a`（8 条，逐条实跑并核对「红的是哪一条」）
│   ├── audit83-regressions.test.js # 【R83】表单 POST 之后不得再跨域 3xx —— Chrome / Safari 会按 CSP 的 `form-action 'self'` 把「表单提交后的重定向目标」一并拦掉（Firefox 只查初始 action，所以同一个站点「Firefox 能付、Chrome 点了没反应」，而服务端日志一切正常：订单建好、302 也回了 —— 极易被误判成网络/代理问题）；`POST /s/:id/pay` 成功后不再 `res.redirect(302, charge.url)`，改为渲染同源「正在跳转」中转页（`jumpPage()`：meta refresh 自动跳 + 可点按钮兜底，零脚本），由页面自身发起导航（页面发起的导航不受 `form-action` 约束）；收银台地址先过 `safePayUrl()` —— 只接受 http(s)、拒绝控制字符（`javascript:` / `data:` 进 `<a href>` 或 meta refresh 等于在本站源里执行脚本），非 http(s) 视同「没给收银台」并标失败；两条防走回头路的判据：源码层「处理器不得把 `charge.url` 交给 `res.redirect`」、CSP 层「`form-action` 必须仍是 `'self'`、不得塞进支付域名」（不许靠放宽 CSP 修 bug）
│   ├── audit84-regressions.test.js # 【R84】《支付模块检查报告》七条逐一复核（**全部成立**，无一条进 Audit_illusion_report.md）：M-1 支付宝查单响应**验签**（`alipayVerifySync()` 按**原始字节**验 —— 同步响应签的是 JSON 原文切片，重新序列化会把 `5.00` 变 `5`，照报告「复用 `alipayVerify`」会让所有真实付款失败；网关地址管理员手填，伪造网关回 `TRADE_SUCCESS` 即可白拿）/ M-2 轮询推进放宽到**任何 pending 订单**（「有 return_url」≠「用户会回来」，付完关页面后永远停在「支付中」）/ M-3 账本读不出来时 `isDegraded()` fail-closed（拒绝建单 + 页面明示 + `error` 日志 + 管理页红色横幅 + 接口 `degraded` 字段）/ L-1 `fenFromYuan('')` 不得是 0（`Number('') === 0` ⇒ 把「读不到金额」渲染成「实付 0.00」）/ L-2 换券即新单（三步原子，且旧单占着同一张券时**先退再验**）/ L-3 5 秒内同 IP·渠道·券·价的重复提交合并成一笔（两次响应都签票据）/ L-4 PayPal 回调按事件类型白名单过滤，判定放在出站验签**之前**
│   ├── audit85-regressions.test.js # 【R85】「支付宝支付页显示的订单号与实际订单号不符」的定性与可见性修复（5 条）：根因**不是**残留旧订单号系统 —— `out_trade_no` 自始至终是内部 16 位 `id`，36 位 `orderNo` 受微信 v3 的 32 位上限约束，**从未也永远不能**发给网关；缺陷是「网关侧那个短号在买家可视范围里根本不存在」⇒ 买家在收银台看到的号在站点上无处核对、管理员也无法按它去商家后台检索。修法只补**可见性**、支付链路一行不改：`orderNoBox()` 改收**订单对象**（收字符串就会丢掉短号），四处渲染（中转页 / 等待页 / 二维码页 / 状态页）并列出「订单号（36 位）」与「商户单号（16 位，即 `out_trade_no`）」，订单管理页新增「商户单号」列（`gatewayNoCell()` + 可复制）；配套反向对照 `R85-01a`~`R85-04a`
│   ├── audit86-regressions.test.js # 【R86】订单号取回新增「账号归属」限制（13 条）：**登录态成交**的订单（订单快照带 `userId`）只能由**同一个账号**取回，**游客成交**的订单（`userId` 为空）任何情况下都能取回。判据全部住在 `paymentOrders.claimForLink({ viewerId })` 一处：归属闸门**排在取回额度之前**（陌生人不能靠反复提交把原主的额度试光）、失败**不消耗额度**、拒绝时**不回传订单快照**（`order: null`，避免泄露归属者与付款 IP）、文案只回答「你登的不是买它的那个号」而不回显归属账号名；路由层给 `need_login` / `wrong_user` 分别渲染「去登录」/「切换账号」**按钮**（连带带 `next` 回分享页），且这两类**不计入**「连续输错」（计了就会让换设备忘登录的买主自己锁死 24 小时）；配套反向对照 `R86-01a`~`R86-07a`
│   ├── audit87-regressions.test.js # 【R87】《全模块安全与功能审查报告》（2026-10-25，GLM-5.3）17 条护栏：可信代理对端判据 / 分享侧 Cookie Secure 口径 / Azure 空闲看门狗 / normalizeRule 归一 methods / 口令校验限流与自助改密验当前密码 / 备份导入端点校验 / 5xx 不回显原始 message / 目录 rename 按快照删源 / sliceCopyFile 分片上限预检 / 限速并发计数懒登记 / 上传流提前关闭结算 / normalizeKey 的 .. 与 NUL 判据 / 三处前端转义 / health 只下发 basename
│   ├── audit89-regressions.test.js # 【R89】存储空间隔离护栏（10 条）：纯函数层（根必须带尾斜杠、`u/abc/` 不放行 `u/abcd/`、加根不叠第二层、他人的绝对前缀被当作相对路径收进自己空间、剥根越界返回 `null` 而非空串、非法用户标识直接 500）；上下文层（`spaceRoot()` 在「角色是 user 却没有 userId」时**抛错**而不是回退成看全部，admin/root/无上下文为无作用域）；咽喉层（真实 `s3.p()` + 假客户端：Key / Prefix / CopySource / 批量 `Delete.Objects[].Key` 四个入口越界一律 404 且**一个字节都不发往上游**，文案与「对象不存在」同一句）；路由层（真 HTTP：`/fs/list` 空 prefix 加根为 `u/<id>/`、响应剥根且**缓存命中分支同样剥根**、管理层不加不剥；`/fs/tree` 这条独立的第二条列举入口同样加根；`/fs/delete` 与 `/fs/stat` 的空 path 必须 400 而不是「整个空间」）；分享层（`POST /links` 的**快照**落绝对 key —— 分享是无会话的，存相对 key 会让链接建得出来、点开恒 404）；WebDAV 层（真实 `authMiddleware`：绑定用户的账户认证后上下文真的带根、未绑定为管理账户、绑定关系可改可解绑、写错 id 当场 400）；生命周期层（删用户连带吊销其 WebDAV 账户，否则「删人 = 给凭据提权」）。配套 14 条反向对照（`R89-01a`~`R89-11b`，台账 903 → **917**）
│   ├── audit90-regressions.test.js # 【R90】四个历史待办的护栏（13 条）：① FS-S1 上传闸门的计数语义（并发 / 字节双限额、释放幂等）、503 + Retry-After、**闸门必须排在 `express.raw` 之前**（真 HTTP：超限时 handler 从未被调用）；② 改用户名要当前密码（前端改名分支自带 `currentPassword`、服务端置 `needsCurrent`）；③ PAY-F1 网关侧关单：支付宝按**原文切片**验签、微信 204 / `ORDER_NOT_EXIST` / `ORDERPAID` 三档、路由层「先关单再建新单 / 关不掉就不建 / 已支付则去交付那一笔 / 渠道不支持关单留痕后继续」；④ `ops.js` 的 `currentItems()` **复核为不存在**（R27-01 已修），同时钉住重命名只刷新一次列表。配套 13 条反向对照（`R90-01a`~`R90-13a`，台账 917 → **930**）
│   ├── audit91-regressions.test.js # 【R91】云闪付（银联全渠道）+ 前台支付方式图标（14 条）：① `ORDER` 把云闪付插在微信与 PayPal **之间**，且前端不得另存一份顺序；② 渠道图形**不随配置接口下发**（R92 改判据方向：从「必须带 `logo`」改为「不许带回来」，配置接口因此从 ~27 KB 回到 ~11 KB）；③ 图形只有 `server/payment-logos.js` 一处实现（前端副本已删，改为走独立接口取一次并缓存）；④ 付费页按钮是「单选钮 → 图标 → 名称」的顺序（图标在左）；⑤ 分享页 `.pv-logo` 与后台同名同形；⑥ 下单 URL 的十项要素 + 签名可被公钥验过；⑦ 商户订单号必须用 36 位 `orderNo`（记录 id 是 base64url，含 `-` `_`，银联判报文格式错误）；⑧ SM3 在下单前即拒绝；⑨ 查单「验签在读业务字段之前」；⑩ 查单三档 + 金额对账；⑪ 关单**先只读查单**（未付 `unsupported` / 已付 `paid` / 查单失败 `error`），且 PayPal 关单路径**绝不出现 `/capture`**；⑫ 通知没签名 403 / 签名错 403 / 签名对 200（真 HTTP）；⑬ 通知按 `orderId`（= orderNo）用 `findByOrderNo` 定位 —— **R92 修正**：上一轮把 `get()`（按记录 id）这个错的实现固化成了护栏；⑭ 关单前查单失败必须 `error`（有疑问就不放行）。配套反向对照 9 条（`R91-01a` / `R91-03a`~`R91-07a` / `R91-09a`~`R91-11a`；`R91-02a` 与 `R91-08a` 随对应代码退役，已重建为 `R92-01a` / `R92-05a`）
│   ├── audit92-regressions.test.js # 【R92】收口 R91 如实标注的三条残余风险（11 条）：① 渠道图形已移出配置接口（体积预算 + 不许改名回流）；② `GET /payment/logos` 带 `private, max-age=604800` 且与唯一实现点逐字节一致；③ 跨站 POST 到 `/s/:id/pay/return` 必须可达（银联前台通知是 **POST 表单**）而到 `/pay`、`/pay/check` 仍 403 —— 放宽只限这一条形状；③b 回跳用请求体的 `orderId` 定位但只接受属于本链接的那笔（票据仍是首选，跨站 POST 不携带 `SameSite=Lax` 票据）；④ 凭据自检四档 `ok`/`auth`/`net`/`config` 各有判据；④b 自检只用只读操作（绝不下建单 / `capture`）；④c 自检接口先本地校验再出网（字段不齐全时**一次请求都不发**）；⑤ `closeCharge` 对 PayPal / 云闪付都先只读查单（已付回 `paid`，未付才 `unsupported`，APPROVED 绝不 capture）；⑤b 查单失败 ⇒ `error`；⑥ 前端自检按钮 / 图形懒加载与 `sessionStorage` 缓存已接线；⑦ 图形实现点不许回流到 `payment-providers`。配套 8 条反向对照（`R92-01a`~`R92-08a`）
│   └── invariants.test.js        # 跨模块不变量的静态护栏（退出路径 / 删除判据 / 缓存键 …）
├── scripts/lint.js         # ESLint 包装器（未安装时降级）
├── .github/workflows/ci.yml # 【R66】持续集成：ubuntu + windows（均 Node 24.22.1，矩阵随 engines 收敛），`npm ci` → `npm run lint` → **逐文件**跑测试（与本地 `run-suite` 同口径；全集 glob 会卡死，逐文件写法不依赖 `--test` 的 glob 支持）
├── jsconfig.json           # 【R66】编辑器用的类型提示配置（零依赖、零构建）：`checkJs` 刻意关闭，需要类型检查的文件在**文件头**单独写 `// @ts-check` 逐文件推进
├── docs/ADR/               # 【R67】架构决策记录：**只写「为什么这样做」**（现状说明在本文与 README）。判断标准是「十年后有人问当时为什么选这条，答案能不能在这里找到」，故每条都强制含「背景 / 决定 / 理由 / 备选方案（已否决）/ 后果与约束」五节
│   ├── index.md           # 索引表（`docs-sync` 双向断言：↔ 实际文件一致、编号连续且与文件名前缀一致、每条五个小节都在）
│   ├── 0001-no-database.md # 不使用数据库：全部状态落 `data/`（量小、读多写少；迁移 = 复制目录，这点是本项目最好的运维属性之一）
│   ├── 0002-no-sm4.md      # 文件加密维持 AES-256-GCM、不引入国密 SM4（本机实测：Node 无 `sm4-gcm` AEAD；`sm4-ctr` 120 MB/s vs `aes-256-gcm` 2037 MB/s）
│   ├── 0003-no-self-signed-tls.md # 移除自签名证书：它换不来安全上下文、还给出假的安全感；没有真实证书就只跑 HTTP
│   ├── 0004-zero-build-frontend.md # 前端零构建：原生 ESM、无打包器、无框架（`jsconfig.json` 只补类型提示，不动形态）
│   ├── 0005-at-rest-encryption-and-keyid.md # 双主密钥（`secret.key` 管配置 / `enc.key` 管文件）+ `enc-meta` 每条盖 `keyId` 为将来的轮换留选择权
│   ├── 0006-guardrails-and-reverse-ledger.md # 每条修复都要行为护栏 + 反向对照台账（撤销必须变红；「源码里有这段」≠「跑起来执行这段」）
│   └── 0007-no-card-payments.md # 不引入 MasterCard / Visa：PCI-DSS 范围、3DS 挑战与本项目的交付模型三者都不相容
├── README.md · Develop_Document.md · CHANGELOG.md  # 使用说明 / 开发文档 / 变更记录（据审计台账事后重建，无发布日期）
├── Dockerfile · .dockerignore
├── eslint.config.js · .editorconfig
└── data/                   # 运行时数据（自动创建，勿提交 git）
    ├── secret.key          # 配置主密钥（32 字节随机，本机生成）
    ├── config.enc          # 系统配置（含密钥/桶/用户），AES-256-GCM
    ├── enc.key             # 文件加密主密钥（启用加密后生成，务必备份）
    ├── enc-settings.json   # 加密方式与查看密码（加密落盘）
    ├── enc-meta.json       # 密文对象解密参数，按 bucket|key 索引（加密落盘，务必备份）
    ├── links.json          # 分享链接（加密落盘）
    ├── invites.json        # 邀请码（加密落盘；R54③ 起）
    ├── coupons.json        # 优惠券与核销台账（加密落盘；R62 起）
    ├── ipguard.json        # IP 屏蔽规则（加密落盘）
    ├── upload-sessions.json# 分片上传会话（加密落盘）
    ├── payments.json       # 支付订单与已支付票据（加密落盘；退款记录永不裁剪）
    ├── downloads.json      # 免费下载台账（加密落盘；R64 起）—— 只记**首次**：同一账号对同一链接同一文件重复下载不新增条目
    ├── restore-bans.json   # 【R65】「用订单号取回下载权限」连续输错的封禁表（加密落盘）—— 只装被封 IP 与到期时间，**只拦取回一件事**
    ├── stats.json          # 流量与请求统计
    ├── logs.jsonl          # 操作审计日志
    └── .instance.lock      # 单实例锁（含持有者 pid；崩溃残留的脏锁会被自动接管）
```

> **另有 `setup-token.txt`（R72）**：部署模式首次初始化用的一次性安装令牌，由服务端启动时生成（0600）、初始化成功后自动删除，**不需要备份**；部署完成信息与 `kepler` 管理菜单顶部都会显示它。

**`data/` 备份清单**（运维最需要的一页：丢了会怎样、能不能重建）

| 文件 | 丢失后果 | 可从云端重建 | 备份优先级 |
| --- | --- | --- | --- |
| `secret.key` | 配置主密钥丢失 → `config.enc` 与全部敏感 JSON 永久不可读 | 否 | **最高** |
| `enc.key` | 已上云的 crypto 密文永久不可解 | 否 | **最高** |
| `enc-meta.json` | 同上：即使 `enc.key` 仍在，缺 IV / TAG / 盐 依然解不开 | 否 | **最高** |
| `config.enc` | 访问密钥、桶、用户、支付凭证全部丢失 | 否 | 高 |
| `enc-settings.json` | 加密模式与查看密码丢失（查看密码可重置，模式需重设） | 否 | 高 |
| `links.json` | 全部分享链接失效 | 否 | 中 |
| `payments.json` | 订单流水与已支付 / 已退款凭证丢失 —— 退款订单「永不裁剪」本是为了日后可举证，丢了就无从证明 | 否 | 中 |
| `ipguard.json` | 屏蔽规则丢失（可重建） | 否 | 中 |
| `downloads.json` | 「查看历史订单」里的免费下载记录丢失（付费订单不受影响） | 否 | 低 |
| `restore-bans.json` | 「取回下载权限」的连击封禁表丢失 —— 表现是**已封禁的 IP 提前解封**（这不是功能损失，而是一道限速闸门被放开，故重新部署后不会自行恢复） | 否 | 低 |
| `upload-sessions.json` | 未完成的续传会话作废，需重新上传并产生新的分片计费 | 否 | 低 |
| `stats.json` | 历史流量 / 请求统计丢失，不影响功能 | — | 低 |
| `logs.jsonl` | 审计日志丢失（见「技术限制与已知局限」） | — | 低 |
| `data/tls/`（自备证书） | 证书缺失时应用只提供 HTTP（内置 HTTPS 与 WebDAV 均不启动）；证书本身可向 CA 重新签发，**但只要私钥是自签自管的就应一并备份** | 可向 CA 重签 | 中 |

三点必须同时成立才算备份成功：**① `secret.key` + `enc.key` + `enc-meta.json` 三者一起备份**——只备份其中一个等于没备份；② 备份时服务处于停止或空闲状态，避免复制到写了一半的文件；③ 备份点与本机的威胁模型一致（`secret.key` 与 `config.enc` 同目录，能读 `data/` 的人同时拿到二者即可解出全部密钥）。


**换机迁移 / 恢复步骤**（答案是「复制 `data/`」——状态全在该目录，没有数据库）：

1. **停服务**再复制（避免复制到写了一半的文件；所有落盘都走「临时文件 + rename」，但复制过程本身仍可能跨过 rename 时刻）。
2. **整目录复制，必须含 `secret.key` 与 `enc.key`**——只复制 `config.enc` 是不够的，见下。
3. 目标机启动前**删掉 `.instance.lock`**：崩溃残留的脏锁会被自动接管，但跨机复制过来的 pid 在目标机上毫无意义，留着只会多一次无谓的接管判断。
4. 启动后打 `GET /api/health`，确认 `configured: true` 且 `corrupted` 为假；再用 `GET /api/config` 的 `selfTest` 确认密钥材料可用。
5. 若界面能列出桶与对象、但加密文件无法打开——先怀疑 `enc-meta.json` 或 `enc.key` 没跟上，而不是「文件坏了」。

**密钥对应关系**（谁加密了谁，决定了「丢一把密钥到底损失什么」）：

```
secret.key ─┬─派生─→ config.enc            （访问密钥 / 桶 / 用户 / 支付凭证）
            └─派生─→ enc-settings.json · enc-meta.json · links.json
                     ipguard.json · upload-sessions.json · payments.json · downloads.json
enc.key    ───直接─→ 云端对象里的 crypto / magic 密文（文件数据本身）
```

- 丢 `secret.key` → 上面**八个**文件全部读不出，而不只是 `config.enc`；
- 丢 `enc.key` → 云端密文不可解，但 `config.enc` 等**不受影响**（两条链彼此独立）；
- **只复制 `config.enc` 而漏了 `secret.key`**：服务会**新生成一把主密钥**，随后 `config.enc` 解密失败被判为「损坏」→ 备份为 `.corrupt-<时间戳>` 并拒绝写入，服务起不来。**不会**静默清空配置（这是刻意的保护，见「审计后的行为变更」）。此时把 `secret.key` 补回去、把 `.corrupt-*` 改回原名重启即可。

**`enc-meta.json` 的重建边界**（丢了还能不能救）：

| 模式 | 解密参数存在哪 | 缺元数据时可否重建 |
| --- | --- | --- |
| crypto | IV / TAG **同时**写在密文段结构里（`[魔数][IV‖密文‖TAG]…`），元数据里只是**冗余**存了一份 | 参数**冗余存在于云端密文**，理论上可解析重建——但**项目不提供任何重建入口**，手工解析还需知道分片边界（`ctLen`）。**不要依赖它做恢复方案** |
| magic | 异或盐与**被魔数覆写的原始文件头**只存在于元数据 | **不可重建**：盐随机生成且从不写进密文，原始文件头在云端已被覆写 |
| none | — | 不涉及 |

结论不变：`enc-meta.json` 与 `enc.key` 必须**同等备份**，二者缺其一，crypto 密文在操作层面即永久不可解。反向的顾虑（元数据膨胀）由「孤儿元数据巡检」处理，它会列出候选但**不自动删除**（见「核心模块实现 → 孤儿元数据巡检」）。

**密钥轮换：当前版本不可轮换（设计层面的硬约束）**

`secret.key` 与 `enc.key` 都是「文件不存在就新生成一把」，代码里**没有任何 rekey 路径**。由此产生两条必须写进运维手册的后果：

- **不能靠「删掉密钥文件让它重新生成」来轮换**——那等于丢弃旧密钥，旧密文与旧配置立即永久不可读。
- **`secret.key` 泄露**：只能在各厂商控制台吊销并重建子账号访问密钥、重设 WebDAV 口令、重设用户密码（`config.enc` 里的口令哈希随之整体作废）。
- **`enc.key` 泄露**：只能走「全量下载 → 用新密钥重加密 → 重新上传」。顺序是 ① 备份现有 `enc.key` + `enc-meta.json`；② 逐个下载解密出明文（**这一步依赖老元数据，先动密钥就再也解不开**）；③ 停服、移除 `enc.key`（下次启动生成新密钥）；④ 重新上传，由服务端用新密钥加密并写入新元数据。**全程服务不可用，且产生双倍流量与存储费用**。

> 引入密钥版本（`keyId`）+ 平滑轮换需要给每个密文对象与每个敏感 JSON 加版本标记并保留多代密钥，改动面覆盖 `config-store` / `enc-store` / `enc-meta` 索引，风险显著——目前**没有计划**，请按「不可轮换」来做容量与应急预案。

<h2 id="develop_document-section3">2. 环境变量</h2>

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 即进入部署模式（HTTP 强制跳转 HTTPS） |
| `SITE_DOMAIN` | 未设置 | 【R38】**本站对外域名**（如 `s3.example.com`，不带协议与端口），由部署脚本按 `--domain` 写入。应用据此回答「这个请求是不是访问本站」—— 它是 Windows Hello 的 `rpId` 白名单（`isOwnSiteHost`）与 HTTPS 跳转目标（`httpsRedirectHost`）的权威来源。**为什么必须单独设一个**：`HOST` 是**监听地址**，部署时必须写 `0.0.0.0` 才能被外部访问，而 `0.0.0.0` 是通配绑定地址、**永远不可能出现在请求的 `Host` 头里**；真实域名此前只被写进 nginx 的 `server_name`，应用完全不知道「自己叫什么」，于是白名单实际为空，用真实域名访问会被判成「访问了外站」而拒绝（R38-01）。它与「密钥管理页的自定义请求域名（`cfg.domains`）」**语义不同、不可合并**：后者只为分享链接地址服务。未设置时回落到旧行为（只认 `HOST` 与非通配的 `cfg.domains`） |
| `PORT` | `3000` | 本机 HTTP 端口 |
| `HTTPS_PORT` | `3443` | 【R49 语义变更】**内置** HTTPS 监听端口，**只在提供了证书时才监听**；没有证书就只跑 HTTP。不再有「自签名证书兜底」 |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 未设置 | 【R49】**自备证书**的两个路径（证书链 + 私钥）；未设置时回退 `data/tls/fullchain.pem` 与 `data/tls/privkey.pem`。应用只加载、**不生成也不改写**（旧 `local-cert.js` 会在读取路径上就地重签并写回私钥）；文件缺失 / 解析失败 / 带口令 / 与私钥不配对时一律按「没有证书」处理 —— 只提供 HTTP，内置 HTTPS 与 WebDAV 都不启动，并在日志与 WebDAV 卡片上写明缺哪个文件 |
| `PUBLIC_HTTPS_PORT` | 有自备证书时取 `HTTPS_PORT`，否则 `443` | 【R49】明文 HTTP 被 301 跳转到的**对外** HTTPS 端口（部署脚本按 `--https-port` 写入，默认 443）。它是**对外**端口，与内置监听的 `HTTPS_PORT` **不是一回事**：旧实现把跳转目标写死成内置的 3443，等于把访客送给一张浏览器不认的自签名证书 |
| `WEBDAV_PORT` | `8443` | WebDAV 端口（仅 HTTPS）。部署脚本以它作为唯一事实来源，同时写入 `.env` 与 Nginx `/dav` 反代的上游；改端口只需 `WEBDAV_PORT=<端口> bash deploy.sh` |
| `WEBDAV_PUBLIC_URL` | 未设置 | WebDAV **对外基地址**（不含 `/dav/`），界面「服务器地址」按它显示。部署脚本配了 Nginx 反代时会写入 `https://<域名>[:端口]`（**R49 起 `--tls none` 时留空**：WebDAV 强制 HTTPS、没有证书不会启动，写一个 `http://` 地址等于给出永远不通的假地址）；未设置时按「当前请求的域名（经可信反代）/ 面板主机名 + WebDAV 端口」逐级推断 |
| `TRUST_PROXY_HOPS` | 未设置（=0） | 仅与 `TRUST_PROXY=1` 配合：`X-Forwarded-For` **按跳数从右往左剥取**（`1` = 只有一层反代取最后一段，`2` = CDN + 反代）。默认 `0` 取首段，只在「前置代理**重写**该头」时成立；若反代用 `$proxy_add_x_forwarded_for` 追加（或前面还有 CDN），首段完全由请求方决定 ⇒ 每个请求换一个合法 IP 就能轮换掉全部按 IP 的限流与封禁。取到的值仍须是合法 IP 字面量，否则退回空串（**不**退回首段）。**R69 新增** |
| `TRUST_PROXY` | 未设置 | 置于 Nginx / CDN 之后时设为 `1`，信任 `X-Forwarded-*`（识别真实 IP / 协议）；**Windows Hello 场景下若通过反向代理暴露，也必须设置此项**，否则服务端推导的 `origin` 会是内网 `http://` 而拒绝验签。**反向风险**：直连暴露时**严禁**设置——任何人都能用 `X-Forwarded-For` 伪造来源 IP，IP 屏蔽与全部限流会同时失效 |
| `TRUST_PROXY_FROM` | 回环 + 私网（RFC1918 / IPv6 ULA / 链路本地） | **R87 新增**：可信代理的**对端**允许集（逗号分隔的 IPv4 CIDR，或 `any`）。只有「这一次连接确实来自我们信任的反代」时才采信 `X-Forwarded-For` —— 默认允许本机回环（`deploy.sh` 生成的反代 `proxy_pass` 到 `127.0.0.1`）与私网（容器化部署里反代在 docker 网段）。公网直连应用端口时一律不采信转发头，退回 socket 对端地址，与「没开 `TRUST_PROXY`」同待遇。需要更严时写死具体跳（如 `10.1.2.0/24`）；`any` 恢复历史行为（等于把身份交给请求方，不推荐） |
| `S3_TIMEOUT_MS` | `120000` | S3 兼容客户端请求超时 |
| `AZURE_TIMEOUT_MS` | `120000` | Microsoft Azure Blob 客户端请求超时（R30） |
| `ALLOW_LOOPBACK_ENDPOINT` | 未设置 | 设为 `1` 允许自定义端点指向回环地址（本地 MinIO 等调试场景）；默认拒绝 |
| `ALLOW_PRIVATE_ENDPOINT` | 未设置 | 设为 `1` 允许自定义端点使用私网 / 链路本地 / 保留 IP 字面量（内网对象存储）；默认拒绝 |
| `LIST_SCAN_CAP` | `5000` | 搜索与用量估算的扫描上限 |
| `LIST_STAT_CAP` | `20000` | 文件夹属性（对象计数）的列举上限 |
| `LIST_DELETE_CAP` | `5000` | 删除 / 清空时单次列举上限（循环调用，内存恒定） |
| `LIST_PROPFIND_CAP` | `5000` | WebDAV `Depth: infinity` 的列举上限 |
| `LIST_CACHE_TTL_MS` | `3000` | 目录列举缓存的存活时间；`0` 表示整体关闭 |
| `SEARCH_CANDIDATES_TTL_MS` | `10000` | 搜索候选集缓存的存活时间（从首次物化算起，命中不续期）；`0` 表示整体关闭 |
| `SEARCH_CANDIDATES_MAX_ITEMS` | `10000` | 搜索候选集单条目的最大键数；超限即整条丢弃并退回逐页列举 |
| `FRAGMENT_CACHE_TTL_MS` | `30000` | 分片列表缓存的存活时间；`0` 表示整体关闭 |
| `CONFIG_WRITE_DEBOUNCE_MS` | `250` | 配置落盘的去抖窗口（毫秒） |
| `PAYMENT_WRITE_DEBOUNCE_MS` | `300` | 支付订单落盘的去抖窗口（毫秒）；`0` 表示关闭去抖、每次变更立即落盘（排查落盘问题时用）。窗口内连续变更只写最后一次的状态 |
| `PAYMENT_MAX_ORDERS_TOTAL` | `20000` | 订单文件的**跨链接**总量上限（`paid` / `refunded` 永不裁）；配置它主要为受控压测与回归护栏提供一个可驱动的小上限 |
| `PAYMENT_PENDING_KEEP_MS` | `7200000`（2 小时） | **支付窗口**：`pending` 订单未超此时长即受裁剪保护（裁掉 = 异步通知查无此单 = 钱付了拿不到文件）；`paid` / `refunded` 无条件永不裁。回归护栏把它压到极小值以驱动裁剪路径 |
| `NO_RESTART_ON_UNCAUGHT` | 未设置 | 设为 `1` 时，发生未捕获异常后不自动退出（调试用）；默认记录后触发优雅关闭 |
| `ENCODER_WORKERS` | 未设置 | 【R48】设为 `0` 时**强制关闭加密线程池**，退回主线程同步执行（沙箱、单核机器或排障时用）。**判据发生在每一次调用**、不是模块加载时读一次，因此进程内即可切换；关闭时行为与改造前**逐字节相同**。注意这里只影响「加密算在哪条线程上」，与系统设置里的「线程并发」（同时上传的文件数，落盘在配置里）是两件事 |
| `ALLOW_LEGACY_UNVERIFIED_CRYPTO` | 未设置 | 【R77】设为 `1` 时**按旧行为**解密「缺少 IV/TAG 的历史加密元数据」（v1.2.4 之前加密的对象）。默认**关**：这类元数据无法校验分段顺序，重排 / 拼接只能靠 GCM 逐段认证（每段各自自洽）⇒ 默认拒绝解密并给出可执行提示。逃生门只用于「把老文件取回后重新上传」（重传即生成完整 iv/tag），放行时每次进程只告警一次。**判据在调用时读取**，改完重启即生效 |
| `S3_DATA_DIR` | 未设置 | 运行时数据目录；未设置时落到项目 `data/`，测试进程可指向临时目录做数据隔离。**唯一实现点**在 `server/data-dir.js`（R49 起十个 store 不再各写一份三元表达式） |
| `COS_DATA_DIR` | 未设置 | 【R49】**旧名，仍兼容**（命中时打印一次弃用提醒）。它被 `deploy.sh` 写进 `.env`、是**部署契约**：静默忽略会让数据目录回退到项目 `data/`，用户看到的是「配置全没了」，而真实数据其实还在原目录。新部署请用 `S3_DATA_DIR` |
| `CAPTCHA_ENABLED` · `CAPTCHA_PROVIDER` · `CAPTCHA_SITE_KEY` · `CAPTCHA_SECRET_KEY` | 未设置 | 登录验证码的预设值；**仅当环境变量真实存在时**才写入配置，用于无界面部署时预设，不会用空值覆盖已保存的配置。`CAPTCHA_PROVIDER` 决定用哪一套，`CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET_KEY` **只作用在被选中的那一套**上（两套凭证各自独立保存，见 §7.1 的 `/captcha/config`） |
| `DOWNLOAD_LOG_MAX` | `2000` | 【R64】免费下载台账（`data/downloads.json`）的条目上限，超出按 `at` **最旧优先**丢弃。它只影响「查看历史订单」里免费下载那一段能回溯多远，不影响计费与取回付费下载权限（后者只认订单） |

> 列举上限另有一个 50000 的硬性天花板（`server/limits.js` 的 `HARD_MAX`），任何调用方都不得越过。上述上限本身也受它约束。

<h2 id="develop_document-section4">3. 多云架构</h2>

系统通过一层**存储抽象**屏蔽各厂商差异，上层业务（路由 / 文件网关 / WebDAV）只有一套写法：

```
业务层   routes/*.js · fs-gateway.js · webdav/app.js（【R67】起协议实现在包里；入口 webdav-server.js 只管生命周期）
              │  统一调用界面：getBucket / headObject / putObject / multipart* ...
抽象层   s3.js（客户端工厂 + 错误翻译 + 调用埋点）
       ┌──────┴───────────────────────────┐
   kind: 's3'                        kind: 'azure'
s3-client.js（内置）              azure-client.js（内置）
· AWS Signature V4（HMAC-SHA256 派生链）   · Shared Key + Blob REST
· Node 原生 fetch / Readable，无新增依赖   · Block Blob（无 UploadId 握手）
· 轻量正则 XML 解析                        · Copy Blob 异步，须轮询到终态
· 路径风格寻址、UNSIGNED-PAYLOAD 流式上传   · 批量删除受控并发逐删
· CopySource 自动兼容 /bucket/key
  ↑ R49：腾讯云已并入这一列（COS 原生 SDK `cos-nodejs-sdk-v5` 整体移除）
元数据   providers.js（厂商注册表：id / 名称 / kind / Endpoint 模板 /
                      地域是否必填 / 地域默认值 / 是否强制路径风格 /
                      端点输入形态与文案 / 字段标签与界面提示，唯一真相来源）
```

> 已接入：**十一家 S3 兼容厂商** —— 腾讯云 COS（R49 由原生 SDK 并入本类）、阿里云 OSS、
> 华为云 OBS、七牛云 Kodo、UCloud US3、又拍云 USS、AWS S3、Google Cloud Storage、
> Cloudflare R2、MinIO、Backblaze B2（`kind: 's3'`，共用 `s3-client.js`），以及
> **Microsoft Azure Blob**
> （`kind: 'azure'`，独立 Shared Key 鉴权 + Blob REST + Block Blob 语义，
> 见 `server/azure-client.js`）。所有登记厂商均为**可连接**状态。

- **配置结构 v3**：`credentials[]` 与 `buckets[]` 每条记录都带 `provider` 与 `endpoint`；v1（扁平结构）加载时自动迁移，v2（无 provider 字段）统一兜底为腾讯云。
- **Endpoint 解析**：密钥上的端点优先，其次按厂商 `endpointTemplate` 用地域填充，再次按**账户名**推导（`accountEndpointTemplate`），最后回落厂商的固定端点。**「服务端点」这一栏对不同厂商含义不同**，由注册表的 `endpointMode` 描述，组装是 `providers.composeEndpoint()` 这**一个**实现点：
  - `derived`（未声明，多数厂商）：端点由地域推导，界面不渲染该栏；
  - `required`（MinIO）：用户填**完整访问地址**（含端口），原样透传；
  - `template`（Cloudflare R2）：用户填的是**账户 ID**，由系统拼成 `https://<账户 ID>.r2.cloudflarestorage.com`；
  - `optional`（Microsoft Azure，R30）：端点默认由**存储账户名**推导（`providers.endpointForAccount()`），该栏只是主权云 / 本地模拟器的**覆盖口**，留空合法、因此**不加必填星号**，也不计入 `endpointRequired()`。

  组装**必须幂等**：表单回填的是库里已组装好的端点，再拼一次会得到一个**语法完全合法**的域名（`…cloudflarestorage.com.r2.cloudflarestorage.com`）——不报错、只在连接时静默失败。同理，`endpointFor()`（地域填主机名**中段**）对 `template` 厂商直接返回空串：R2 的占位符在主机名**最前**且要填的不是地域，走那条路会拼出 `auto.r2.…` 这种合法假域名。Azure 的账户名同理不能走 `endpointFor()`（那里只有地域），但它**必须**经受 `^[a-z0-9]{3,24}$` 校验后才拼进主机名 —— 账户名是请求方可控输入，放行 `evil.com/x` 就等于盲 SSRF（`endpointForAccount` 是唯一实现点，非法即 400）。
- **地域解析**：`providers.regionFor()` 是唯一读取点 —— 用户留空时补厂商默认值（GCS / R2 / **Azure** 为 `auto`、MinIO 为 `us-east-1`），并**强制字符集**（地域会被直接拼进端点模板，而厂商默认端点这条路不过 `assertSafeEndpoint`，见 R21-12）；「地域是否必填」由 `regionRequired` 决定，建桶路由与三处运行期判定同源。Azure 的 `auto` 只为满足上层「地域非空」的既有约定，**不参与寻址与签名**（端点由账户名决定）。
- **寻址风格**：`forcePathStyle` 由厂商元数据下发（MinIO 等自建部署必须走 `https://host/bucket/key`，否则拼出的 `bucket.<host>` 无法解析），客户端工厂把它传给 `S3Client`，寻址判据收敛在 `S3Client._virtualHosted()` 一处。Azure 无此开关：容器恒在路径里。
- **能力差异**：**厂商侧的**硬限制（`PutObject` / `CopyObject` 的大小上限、是否要求定长分片）一律由注册表声明、由 `providers.js` 的访问器下发，**不得**在客户端或路由里按厂商名分支 —— R49 之前这里有一句「仅腾讯云支持的操作按 `provider` 判定（如官方容量统计 `?stats`）」，那套按协议分叉的写法随 COS 原生 SDK 一起删除：现在**没有任何**厂商具备「读桶容量」这种非 S3 操作，桶容量一律回退到分页列举估算。Azure 的四处协议差异各自有等价实现，**都在 `azure-client.js` 内部消化**，上层（`s3.js` 的 `p()` / `listPage` / `deleteMultipleConfirmed`）不需要分支：
  - **分片上传**是 Block Blob（`Put Block` + `Put Block List`），没有 UploadId 握手 ⇒ `multipartInit` 只签发一个**会话令牌**（不发请求），块名由分片号定宽编码（Azure 要求同一 block list 内块名等长），`multipartListPart` 由块名反解分片号，因此断点续传跨进程重启仍成立；`multipartAbort` 无对应接口（未提交块 7 天后由云端回收），如实返回空结果；
  - **复制**（`Copy Blob`）对大对象是**异步**的（返回 `x-ms-copy-status: pending`）⇒ 客户端必须**轮询到终态才 resolve**，否则「复制成功后删源」的移动/重命名会在源被删时副本还没写完；同时 `copySource()` 对 Azure 返回 `/容器/键` 形式，由客户端拼成带账户名的绝对 URL（复制源必须是 URL，且只有客户端知道账户与端点）；
  - **批量删除**没有对应接口 ⇒ 客户端受控并发逐删，并按「**只把云端明确确认删除的 key 放进 `Deleted`**」合成结果（这份白名单驱动清加密元数据与标记分享链接失效，多报一个是数据事故；不存在的对象按幂等算已删，与 S3 `DeleteObjects` 口径一致）；
  - **`?stats` 容量统计**不存在 ⇒ `request()` 显式抛 `NotImplemented`（501），上层回退到列举统计（>5001 对象时为下界，R28-05 起该情形不再清空待定增量）。**R49 起这条路对全部厂商生效**（腾讯云原先的 COS 原生 `?stats` 也一并删除）；**未完成分片的容器级枚举**同样不存在 ⇒ 碎片列表对 Azure 恒为空（未提交块由云端自动回收，不持续计费）；
  - 另外 `getService`（列容器）必须回**非空 Region**：`POST /config/verify` 在指定桶名且地域留空时用它兜底，返回空串会让一次完全正确的验证报「未找到存储桶」。
- **新增一家云厂商的步骤**：① 在 `providers.js` 注册表追加条目 —— 这是厂商元数据的唯一真相来源。至少给出 `id` / 名称 / `kind`；端点不由地域推导时**必须**再给出 `endpointTemplate`（地域进主机名中段）、`accountEndpointTemplate`（**账户名**进主机名，如 Azure）或 `endpointMode`（`'required'` 用户直接填完整地址、`'template'` 用户填的是模板里那个占位符的值、`'optional'` 端点默认自动推导而该栏只是覆盖口）；按需补 `regionRequired` / `defaultRegion` / `forcePathStyle` / 端点栏文案。② 走 S3 兼容协议时填 `kind: 's3'` 即可，`s3.js` 自动分派到 `s3-client.js`，无需改动客户端工厂；**只有鉴权 / 寻址协议与 S3 都不同**时才新开一个 `kind` 与一个客户端文件（`kind: 'azure'` → `azure-client.js` 即此例），并且必须复刻 `s3-client.js` 的**方法名与返回形状**（上层 `s3.js` 只按方法名分派、只认那套既有的字段名 —— 它们源自当年的 COS SDK，属于内部约定，与走哪家厂商无关），同时保证 `list-cache` 的读写方法名单与 `multipart*` 前缀约定不变，否则缓存失效与碎片清理会静默失灵。③ 厂商侧的硬限制（`putObjectMaxBytes` / `copyObjectMaxBytes` / `fixedPartBytes`）写成注册表字段，判据各自只有一个读取点；新厂商未声明即沿用项目阈值。④ 前端在 `public/js/provider-logos.js` 追加内联 SVG，并在 `ORDER` 与 `PROVIDER_META` 里补上同序同值的条目（**该文件不得自行拼装端点** —— 组装只在服务端发生）；界面顺序即 `ORDER` 顺序。⑤ 补两条护栏：`tests/audit26-regressions.test.js` 的写法是按**厂商差异点**逐条钉（而非「表里有没有这个 id」），新增厂商时应在其中补上该家的差异点；若新开了一个 `kind`，再按 `tests/azure-client.test.js` 的写法补一个「**自己验签的假服务**」—— 协议实现光读代码无法确认拼装正确。全程不引入新依赖。

---

<h1 id="develop_document-section5">二、技术说明</h1>

<h2 id="develop_document-section6">1. 设计背景与刻意取舍</h2>

<h3 id="develop_document-section7">1.1 多云协议的历史原因</h3>

初始版本仅面向腾讯云 COS，因此原生支持腾讯云对象存储 SDK（`cos-nodejs-sdk-v5`）；其它云服务商为后续添加，走 S3 兼容协议（SigV4）。

**R49 收口了这个历史包袱**：两套实现并存意味着任何修复都要写两遍、漏一处就出现「某个厂商上不对而别的都好」的僵尸缺陷，因此腾讯云也并入 S3 兼容协议，COS 原生 SDK 与 `kind: 'cos'` 一并删除（运行时依赖由 2 个降为 1 个）。代价如实记录在案：腾讯云的桶容量从「一次 `?stats` 拿到精确值」退化为**分页列举估算**（S3 协议里没有读桶容量的操作），对象数超过 5000 时只能给出下界并在界面标注。

<h3 id="develop_document-section8">1.2 用户 / IP 管理界面按角色物理分离</h3>

> **R71 起角色是三层**：`root`（根用户）› `admin`（管理员）› `user`（普通用户）。根用户**只能且默认**属于「系统部署完成后创建的第一个账户」（空库时由 `config-store.resolveNewUserRole()` 强制落成，升级场景由 `ensureRootUser()` 按 `createdAt` 把最早创建的账户补上），**不可通过界面授予，也不可撤销**；管理员则**只能管理普通用户** —— 对管理员与根用户的编辑 / 删除 / 封禁 / 强制登出一律 403，也不能创建管理员、不能调整角色（改角色 = 授予角色）、不能用邀请码或「新用户身份」批量发管理员。判据只有两处：服务端 `server/roles.js` 的 `canManageUser()` / `canAssignRole()`，与前端 `util.js` 的 `isStaffRole()`（只决定渲不渲染按钮）。下方各条「管理员」在功能可见性上的含义自本轮起一律指**管理层**（含根用户）。


早期版本使同一张卡片同时服务两种角色（在「用户管理」与「我的资料」两种形态间切换），若任意一条分支被忽略，则切换账号时会残留上一角色的 DOM —— 这会导致「管理员登出后普通用户仍能看到全部用户与添加按钮」。

现行设计将两种用途**物理分离**，角色切换只剩「显示 / 隐藏一个整块」，不存在需要还原的中间状态，从结构上消除了这类缺陷。配套实现约定：

- `syssettings.js` 的 `ADMIN_ONLY_CARDS` 含 `sysset-user-card` 与 `sysset-lb-card`（负载均衡，R25），`loadUsers()` / `loadLoadBalance()` 在非管理员时直接返回，不发起用户列表或配额汇总请求；
- `renderUserMenu()` 中 `ipguard-card.hidden = !isAdmin`，`refreshIpGuard()` 在卡片隐藏时直接返回，同时切断规则列表请求；
- `renderUserMenu()` 中 `credmgr-domain-card.hidden = !isAdmin`（自定义请求域名：保存走 `PUT /api/config`，且是全局共享设置），`credmgr.refresh()` 在卡片隐藏时既不回填输入框、也不再拉取 `/api/config`；
- `openBucketDialog()` 的管理员专属项按 `isAdminUser` **整项条件渲染**：「访问密钥」与「从云端获取桶列表」（`POST /config/verify` 仅管理员）、「对普通用户可见」（服务端对非管理员丢弃 `credentialId` / `visibleToUsers`，留着只是无效开关）；提交时元素不存在即按「不指定密钥 / 可见」处理；
- **桶集合由管理员维护，普通用户只读**：`POST /buckets/local` 挂 `requireAdmin`，`renderUserMenu()` 隐藏两处「添加存储桶」入口（侧栏 `btn-bucket-add` 与管理页 `btn-buckets-add`）；`bucketmgr` 对普通用户不渲染「操作」列（解绑走 `DELETE /buckets/local/:id`，同样是管理员专属）。可见桶由 `GET /buckets/stats` 按角色过滤后直接列出，空列表时提示「联系管理员开放」而不是引导其自行添加；
- 登出与登录成功两个时点均调用 `resetMainView()` 将主视图切回文件浏览（纵深防御）。

<h3 id="develop_document-section9">1.3 支付系统设计取向</h3>

| 取向 | 说明 |
| --- | --- |
| **不强行统一字段名** | 三家平台各自沿用官方文档命名：支付宝 `app_id` / `private_key` / `alipay_public_key` / `sign_type`；微信支付 `mchid` / `appid` / `api_v3_key` / `serial_no` / `private_key`；PayPal `client_id` / `client_secret` / `mode`。界面在每个字段旁标注官方字段名，可直接对照其控制台填写 |
| **校验规则集中** | 全部 `pattern` 与专用校验器（PEM 私钥 / 公钥、https URL）都写在 `server/payment-providers.js` 一处；前端拿到的是同一份规则的可序列化副本，用于即时提示，**最终裁定永远在服务端** |
| **可扩展为真实校验** | 提供 `registerValidator(platformId, fn)` 扩展点。接入 SDK 后登记联机校验即可将「本地格式校验」升级为「凭证有效性校验」，路由与前端无需改动 |
| **敏感字段不外泄** | 密钥 / 证书 / Secret 任何接口都不回传明文，只返回「是否已配置」；保存时留空 = 保持现有值不变，避免界面保存误清空 |
| **校验不通过不落盘** | `PUT` 先校验再写入，失败时返回逐字段错误，界面在对应输入框下方标红 |
| **站点地址唯一来源** | 卡片顶部的「站点地址」用于拼装**同步回跳地址**与**异步回调地址**。留空时按**可信阶梯**取值（请求 `Host` 属本站 → 配置的主 / 备域名 → 本机 `HOST` 非通配；R24-01），全部落空即**拒绝下单**并提示配置 —— 绝不拿任意请求 `Host` 拼回调（否则伪造 `Host` 即可把带签名的支付通知引向攻击者的域）。生产环境务必显式填写（反向代理后浏览器看到的 Host 与网关回跳的并不一致）；值会被去掉末尾斜杠后保存 |

<h3 id="develop_document-section10">1.4 支付结果仅限服务端查单返回</h3>

这是支付模块最重要的设计约束：

```
下单（pending）→ 下载者付款 → 回跳 / 轮询 / 异步通知 任一到达
                                    └─→ 服务端主动向平台查单
                                            ├─ 明确成功   → markPaid（唯一入口）
                                            ├─ 明确失败   → markFailed
                                            └─ 未找到/异常 → 保持 pending（失败即关闭）
```

- **异步通知只当触发器，不作证据**：`POST /pay/notify/:platform` 收到后只解析出商户单号进行查验，只接受返回结果更改状态；通知内容（金额、签名、状态字段）一概不用于判定成功。
- **失败即关闭（fail-closed）**：查询超时、网络异常、返回不可解析一律视为**未支付**，绝不放行下载。返回失败仅需要求下载者重新刷新页面，而放行未支付下载的代价是文件被免费获取。
- 全库**只有一处**调用 `markPaid`（`share-routes.js` 的 `finalizeOrder`），已支付订单不允许被后续失败回调改判。
- 开发期用过的模拟支付端点与开关（`PAYMENT_MOCK` / `/s/:id/pay/confirm`）已**彻底删除**，不允许复活。
- **付费拦截发生在扣减下载次数之前**：否则反复支付失败即可耗尽下载次数额度。完整的放行判定顺序见「分享链接生命周期 → 下载配额与来源判定」（唯一权威定义）。

**没有引入 MasterCard 和 Visa 支付的原因**：

> 🧭 **决策元数据（被否决的替代方案、以及「如果将来要做，第一步是什么」）见 `docs/ADR/0007-no-card-payments.md`**。本节给的是此刻的事实形态。

直接收集、传输或存储卡号（PAN）、有效期、CVV 属于 **PCI-DSS 的合规范围**（不是「接个 SDK 就自动合规」，而是整套网络分段、日志脱敏与年度评估）。当前架构偏向轻量级，若在服务端或前端明文处理卡信息，将直接面临法律合规风险与数据泄露隐患。

欧美及多数地区强制要求强客户身份验证。这需要前端集成动态挑战流程（iframe / 重定向），后端维护验证会话状态。当前 `payment-gateway.js` 的 `createCharge` 只回一个收银台跳转链接或二维码（`{ ok, payUrl | qrCode }`），没有处理 3DS 挑战所需的异步状态机。

项目本身方面，当前 `payment-rules.js` 的计费与交付逻辑未设计「预授权冻结」「部分捕获」「长周期状态轮询」等机制，强行接入会导致「发货后资金未实际结算」或「退款状态不同步」。系统强依赖公网可达的 `notify_url`。信用卡支付网关会推送数十种事件类型（成功、失败、部分退款、争议发起、仲裁结果）。若当前回调路由未实现严格的幂等性校验、事件签名验签、多状态并发处理，极易引发重复发货、对账错乱或安全漏洞。Visa / Mastercard 仅对持牌金融机构或大型商户开放直连，通常必须通过聚合网关（Stripe、Adyen、PayPal Advanced、Checkout.com）间接接入。当前 `payment-providers.js` 只定义了四家现有平台（支付宝 / 微信支付 / 云闪付 / PayPal）**直连**所需的凭据字段（如 `appId` / `privateKey` / `mchId` / `apiV3Key` / `clientId` / `clientSecret` / `merchantId`），并未设计「SDK 托管模式」或「前端 Token 化」接口，需重构网关层以适配聚合网关的 PaymentIntent、Customer、Source 等现代支付对象模型。

综上，不论从哪种角度来讲，引入 MasterCard 和 Visa 支付都不值得，也做不到。

<h3 id="develop_document-section11">1.5 订单冗余字段用于对账</h3>

订单记录冗余保存了文件名与对象 key，目的是使订单管理在**分享链接被删除后依然可对账**——否则历史收款记录会随链接一起消失。

<h3 id="develop_document-section12">1.6 WebDAV 口令为可恢复加密</h3>

第三方 WebDAV 客户端只支持 Basic 认证，服务端必须能还原出口令原文，因此无法只保存 scrypt 哈希。该口令经主密钥加密落盘，与登录口令隔离。使用约束：**请勿复用登录密码作为 WebDAV 口令**，且 WebDAV 仅应监听本机回环地址。

<h3 id="develop_document-section13">1.7 为何不引入 SM4 作为文件加密算法</h3>

> **结论**：评估后**不引入**。不是否定国密，而是 Node 侧的 SM4 在当前形态下同时踩中两个硬伤——**没有 AEAD 模式**、**吞吐比 AES-NI 慢一个数量级**，而本项目的整条加密链路正是围绕「有 AEAD + 足够快」这两点搭起来的。以下数据均为本机实测（脚本可复现），不是引用第三方结论。
>
> 🧭 **决策元数据（为什么、何时可重评）见 `docs/ADR/0002-no-sm4.md`** —— 那一篇只在 Swift 提供原生 `sm4-gcm` 且吞吐进入同一量级时才需要被重评。

**测量环境**：Node v22.22.2 / Windows x64 / AMD Ryzen 5 5600 / OpenSSL 3.5.5；样本为 32MB 随机缓冲区，取 3 次运行的最优值。

| 观测项 | 实测结果 | 对方案的影响 |
| --- | --- | --- |
| Node 提供的 SM4 模式 | `sm4`、`sm4-cbc`、`sm4-cfb`、`sm4-ctr`、`sm4-ecb`、`sm4-ofb` | **`sm4-gcm` / `sm4-ccm` 不存在**（`crypto.getCiphers()` 中查无此二项）→ 无法照搬 GCM 语义 |
| `aes-256-gcm` 吞吐 | **2037 MB/s**（AES-NI） | 这是现有加密「可以放在请求处理器里同步做」的唯一前提 |
| `sm4-ctr` 吞吐 | **120 MB/s** | 比 AES-GCM 慢 **17 倍**——最大的约束 |
| `sm4-cbc` 吞吐 | 114 MB/s | 与 CTR 同量级，换分组模式救不了 |
| HMAC-SHA256 | 2025 MB/s | MAC 成本可忽略 |
| HMAC-SM3 | **239 MB/s** | 比 SHA-256 慢约 8.5 倍 → 「SM4 + SM3」这条路会再叠加一层慢速 MAC |
| SM4 的 IV 长度 | **只接受 16 字节**（传 12 字节直接抛 `Invalid initialization vector`） | 现有 IV 约定是 12 字节（AES-GCM 接受 12/16）→ 必须参数化 |
| 块大小 | 16 字节（与 AES 一致：CBC 下 1 字节明文 → 16 字节密文） | 分片与块对齐逻辑**不用改** |
| Dockerfile 基础镜像 | `node:24.22.1-alpine`（OpenSSL 3；24.22.1 为 CVE-2026-111497 最低修复版，R76 起钉精确版） | 部署侧 SM4 可用，无需换镜像 |

**阻断理由一：没有 AEAD，得自己拼，而拼错的代价不可回滚**

现有 AES-256-GCM 的三样东西（逐段 `authTag` 校验、每段独立 IV、可 seek 解密）都是 `crypto` 模块给的，本仓库不实现它们。换成 SM4 就只能自己搭 **CTR + HMAC 的 encrypt-then-MAC**：

- SM3 确实存在，但实测只有 239 MB/s——用它会让「加密 + 认证」的总耗时进一步恶化；改用 HMAC-SHA256 则成了「SM4 加密 + SHA-256 认证」的混搭，届时它也**不构成实质上的国密方案**；
- AEAD 的认证覆盖范围、nonce 复用判定、常量时间比较都要自己写对。**这类错误没有任何运行期症状**：写错不会报错，只会让密文在某次读取时解不开，最坏情况下允许伪造篡改而不被发现。参照本仓库对「SM4 元数据改错即永久不可解」的判断，这是不能接受的风险面。

**阻断理由二：17 倍会把「可接受」变成「必须重构」**

本项目**已经有过一次同型教训**：`magic` 模式的密钥流是无硬件加速的纯位置函数，结果 48MB 分片会在单线程里同步阻塞约 3 秒、全站失去响应，最后只能把单片上限压到 5MB 来兜住（见「技术限制与已知局限」）。

也就是说，**「没有硬件加速的同步加密」这条路本项目走过一次，代价是把性能上限写死成了功能限制**。SM4 正是同一形态：若照现有链路接入，分片上传的同步加密会从毫秒级跳到百毫秒级，直传与 WebDAV PUT 的整文件加密直接踩进秒级阻塞。唯一的正确解法是把整条加密链路**重写为流式**（边加密边上传），而这条链当前是同步的、且被 Range 请求、回溯校验、断点续传等多处依赖——**这才是工作量的主体**，与「换一个算法名」不是一个量级。

**阻断理由三：现有格式没有预留算法位**

引入第二种算法，前提是密文自己能说清「我用的哪个算法、IV 多长、TAG 多长」。现在这三点全是隐含约定：

| 现状 | 位置 | 为什么它是障碍 |
| --- | --- | --- |
| 加密元数据**没有算法字段**（全 server 侧唯一的 `alg` 属于 WebAuthn 的 COSE 算法标识，与文件加密无关） | `enc-store.js` 元数据写入 | 新旧密文无法按算法区分，只能靠 IV 长度反推——这是最不可靠的一种推断方式 |
| IV / TAG 长度约定存在**至少两份独立实现**：`enc-store.js` 的 `IV_LEN = 12` / `TAG_LEN = 16`（文件内 10 处引用），以及 `config-store.js` 里写死的 `12` / `28` / `29` 字面量（附带布局注释） | 两处 | 改一处必漏另一处。这正是本项目反复验证过的失效模式——「同一约定多份实现，必有改一半」 |
| `enc-meta.json` 出错的代价是**永久不可解** | 元数据存储 | 上面两项叠加后，一次改错的后果不可回滚 |

**还有两笔必须一并付出的成本**

- **IV 长度参数化**：SM4-CTR 的 nonce 固定 16 字节（实测传 12 字节直接报错），现有 12 字节约定必须参数化；偏移量算错一位就是整段密文错位。
- **主密钥跨算法复用**：把 32 字节主密钥截断成 16 字节给 SM4 是最容易犯的错——不同算法之间**绝不能共用同一份密钥材料**，正确做法是 HKDF 派生出两个独立子密钥。这一步一旦省掉，两个算法的安全性会互相牵连。

**什么情况下会重新考虑**

| 触发条件 | 说明 |
| --- | --- |
| Node 提供 `sm4-gcm` 或等价 AEAD | 阻断理由一消失，不必自己拼认证加密 |
| 出现 AES-NI 级别、或明显接近的 SM4 实现 | 阻断理由二缓解，不必先重构为流式 |
| 有明确的合规要求，且愿意同时承担「流式重构 + 17 倍吞吐 + 格式迁移」三项成本 | 此时它是需求驱动而非技术驱动；迁移必须保留旧路径，存量密文仍按原算法解密 |

> 在此之前，文件加密维持 `AES-256-GCM`（crypto 模式）与文件头魔数（magic 模式）两种，**不使用国密算法**。「威胁模型与不设防边界」的合规一行也登记了同一结论，那里只给结论，判定细节以本节为准。

<h3 id="develop_document-section14">1.8 为何不使用对象存储自带的服务端加密</h3>

云厂商的对象存储普遍提供**服务端加密**（SSE）：开通后云端在写入时自动加密、读取时自动解密，原生支持 AES-256 与国密 SM4，客户端无需任何改造——它看上去正好绕开了 1.7 里讨论的全部性能与实现成本。本系统**刻意不使用**，因为两者的目标根本不同：

| 维度 | 对象存储服务端加密（SSE） | 本系统的加密（客户端加密） |
| --- | --- | --- |
| 密钥在哪 | 厂商托管，或由其 KMS 管理 | **全程留在本机**，密钥与元数据缺一则密文不可解 |
| 厂商能否读到明文 | **能**——控制台里看到的就是明文对象 | 不能，落到云端的是密文 |
| 控制台可见性 | 对象可被正常浏览、下载与预览 | 密文文件头已被覆写，直接打开不可用 |
| 保护的场景 | 介质层面：磁盘失窃、退役介质残留 | 数据主权：服务商可接触数据但无法解读 |

加密模块的设计意图是「**控制台不可见、服务商无法审核**」。把密钥交给云厂商托管，等于把这个目标从根上放弃——**托管加密保护的是「厂商的磁盘」，而这里要防的是「厂商自己」**。

因此本系统坚持**先在本地加密、再上传**：密钥与元数据全程留在本机，厂商侧（含其 IDC 与控制台）看到的恒为密文。代价是密文格式演进、性能与密钥保管的责任全部落在自己身上——**这正是为这个目标专门写一套加密模块的理由**，而不是复用云厂商现成的能力。

厂商 SDK 虽另有客户端加密可让服务商只见密文，但它绑定单一厂商 SDK，与本系统「多云统一抽象、零新增依赖」的架构冲突，也无法支撑本系统所需的分片密文结构（断点续传、Range 切片、WebDAV 透明加解密、查看密码令牌）与魔数混淆模式。

故本系统自研加密：密钥完全掌握在用户手中，云厂商侧只能看到密文。其代价是 enc.key 与 enc-meta.json 必须与 secret.key 同等备份、缺一即密文永久不可解。

<h3 id="develop_document-section15">1.9 传递长尾依赖</h3>

本项目在 `dependencies` 中只声明了 `express@4.22.3` 一个依赖，但 `express` 自身具有**运行时闭包 68 个、开发时闭包 92 个**——「只有一个依赖」说的是 `package.json` 里的那一行，不是 `node_modules` 的实际规模。

继续减少长尾依赖的**收益已经为零**，已做满的局部修剪清单：

- `urlencoded` 用 `extended: false`；
- `query parser` 用 `simple`；
- 不设 `trust proxy`；
- 不用 `accepts` / `format` / `vary` / `render` / `engine` / `param`；
- cookie 由自己手写解析，不引 `cookie-parser`；
- gzip / tar / qrcode / SMTP / PNG 全部自写，零依赖。

由于 `eager require` 结构的原因，保留 `express` 等于运行时闭包**恒为 ~68 条**。要继续降低，只有换掉 `express` 这一条路。

<h4>① 运行时闭包</h4>

<h5>A. Express 框架本体</h5>

| 包 | 作用 |
| --- | --- |
| `express@4.22.3` | Web 框架核心：应用 / 路由 / 中间件调度 |
| `merge-descriptors@1.0.3` | 将 Router 方法合并到 app 对象（`app.get` 等代理） |
| `utils-merge@1.0.1` | 浅合并配置对象（app settings 初始化） |
| `path-to-regexp@0.1.13` | 路径字符串 → 正则（`/user/:id` 路由匹配） |
| `array-flatten@1.1.1` | 展平路由注册参数（`app.get('/a', mw1, mw2)`） |
| `methods@1.1.2` | HTTP 方法名清单（`router.get/post/...` 动态生成） |

<h5>B. HTTP 报文基础工具</h5>

| 包 | 作用 |
| --- | --- |
| `http-errors@2.0.1` | 构造带 status / expose 的 HTTP 错误对象 |
| `statuses@2.0.2` | 状态码 ↔ 消息文本映射 |
| `vary@1.1.2` | 追加 / 合并 `Vary` 响应头（缓存正确性） |
| `range-parser@1.2.1` | 解析 `Range: bytes=0-99` 头（断点续传） |
| `fresh@0.5.2` | 对比 ETag / Last-Modified 判断缓存是否仍新鲜（304） |
| `etag@1.8.1` | 生成强 / 弱 ETag |
| `encodeurl@2.0.0` | URL 编码用于 Location / Set-Cookie 头 |
| `escape-html@1.0.3` | 错误页 HTML 转义（防 XSS） |
| `ms@2.0.0` | 时间字符串 ↔ 毫秒（`maxAge: '1d'`）；`send` 因版本冲突嵌套了 `ms@2.1.3` |
| `parseurl@1.3.3` | 带缓存的 `req.url` 解析（避免重复 parse） |
| `media-typer@0.3.0` | 解析 `type/subtype+suffix` 结构（type-is 的底层） |

<h5>C. 请求体解析管线（body-parser 家族）</h5>

| 包 | 作用 |
| --- | --- |
| `body-parser@1.20.8` | JSON / urlencoded / raw / text 四种解析器 |
| `raw-body@2.5.3` | 读取原始请求流为 Buffer（带长度限制） |
| `bytes@3.1.2` | `'5mb'` → 字节数（limit 配置解析） |
| `content-type@1.0.5` | 解析 / 序列化 `Content-Type`（含参数 charset） |
| `content-disposition@0.5.4` | `Content-Disposition` 头（附件下载文件名） |
| `type-is@1.6.18` | 判断请求体 MIME 是否匹配（`is('json')`） |
| `iconv-lite@0.4.24` | 非 UTF-8 编码解码（GBK 等 charset 支持） |
| `qs@6.16.1` | 嵌套查询串 / 表单解析（`a[b][c]=1`） |
| `unpipe@1.0.0` | 请求流未消费时安全卸载（防挂起） |

<h5>D. Cookie 体系</h5>

| 包 | 作用 |
| --- | --- |
| `cookie@0.7.2` | Cookie 解析（`parse`）与序列化（`serialize`） |
| `cookie-signature@1.0.7` | HMAC-SHA256 签名 / 验签（`s:` 前缀签名 Cookie） |

<h5>E. 内容协商（Accept 家族）</h5>

| 包 | 作用 |
| --- | --- |
| `accepts@1.3.8` | `req.accepts()` / `acceptsLanguages` 高层协商 |
| `negotiator@0.6.3` | Accept / Accept-Language / Accept-Encoding 协商算法 |
| `mime-types@2.1.35` | 扩展名 ↔ MIME 类型查找 |
| `mime-db@1.52.0` | IANA MIME 完整数据库（mime-types 的数据源） |
| `mime@1.6.0` | 独立的扩展名推断（send 用它从文件名猜 Content-Type） |

<h5>F. 静态文件服务</h5>

| 包 | 作用 |
| --- | --- |
| `serve-static@1.16.3` | `express.static()` 中间件 |
| `send@0.19.2` | 文件流式响应：Range、条件请求、目录索引 |

<h5>G. 网络地址与信任代理</h5>

| 包 | 作用 |
| --- | --- |
| `proxy-addr@2.0.8` | 根据 `trust proxy` 设置确定客户端真实 IP |
| `ipaddr.js@1.9.1` | IPv4 / IPv6 解析与 CIDR 匹配（`10.0.0.0/8`） |
| `forwarded@0.2.0` | 解析 `X-Forwarded-For` 链 |

<h5>H. 请求 / 响应生命周期与可观测性</h5>

| 包 | 作用 |
| --- | --- |
| `finalhandler@1.3.2` | 中间件链末端：404 响应与最终错误输出 |
| `on-finished@2.4.1` | 请求 / 响应完成时回调（访问日志、流清理） |
| `ee-first@1.1.1` | 多事件「先到先得」监听（on-finished 的实现基础） |
| `debug@2.6.9` | 条件调试日志（`DEBUG=express:*`） |
| `depd@2.0.0` | 废弃 API 警告（deprecate） |
| `destroy@1.2.0` | 强制销毁流 / socket（错误后释放资源） |
| `object-inspect@1.13.4` | 对象字符串化（http-errors / finalhandler 调试输出） |
| `toidentifier@1.0.1` | `'Not Found'` → `'notFound'`（错误类事件名转换） |
| `setprototypeof@1.2.0` | `Object.setPrototypeOf` 的兼容封装 |

<h5>I. 继承与 Buffer 安全</h5>

| 包 | 作用 |
| --- | --- |
| `inherits@2.0.4` | 经典原型继承（http-errors 各错误类） |
| `safe-buffer@5.2.1` | 无抛错的 Buffer API |
| `safer-buffer@2.1.2` | iconv-lite 使用的 Buffer 安全层 |

<h5>J. ECMAScript 规范垫片（intrinsic 抽象层，15 个）</h5>

> 这组不实现业务功能，而是按 ECMA-262 规范安全访问 JS 内建能力，兼容老引擎并防原型污染。

| 包 | 作用 |
| --- | --- |
| `get-intrinsic@1.3.0` | 按规范名获取原始内建（`%Object.prototype%`） |
| `call-bind@1.0.4` | 安全 `Function.prototype.call/bind`（拒绝原始值 this） |
| `call-bind-apply-helpers@1.0.2` | call / apply / bind 的分实现 |
| `call-bound@1.0.4` | `callBind(intrinsic)` 的简写（绑定好的方法） |
| `function-bind@1.1.2` | `Function.prototype.bind` 实现 |
| `es-define-property@1.0.1` | 规范语义的 `[[DefineOwnProperty]]` |
| `es-object-atoms@1.1.2` | `ToObject` / `RequireObjectCoercible` 原语 |
| `es-errors@1.3.0` | 规范错误类型构造器 |
| `es-set-prototypeof@1.2.0` | 规范语义的 `[[SetPrototypeOf]]` |
| `get-proto@1.0.1` | 获取 `[[Prototype]]`（含跨 realm） |
| `dunder-proto@1.0.1` | 通过 `__proto__` 访问器读原型 |
| `gopd@1.2.0` | `Object.getOwnPropertyDescriptor` 兜底 |
| `has-symbols@1.1.0` | Symbol 支持检测 |
| `hasown@2.0.4` | 规范语义的 `Object.prototype.hasOwnProperty.call` |
| `math-intrinsics@1.1.0` | `Math.floor/max` 等的安全引用 |

<h5>K. 侧信道存储（防原型污染，4 个）</h5>

> qs、call-bind 等用 WeakMap / Symbol 存储「私有」状态，而不是写对象属性，防御原型污染攻击。

- `side-channel@1.1.1`（统一入口）
- `side-channel-list@1.0.1`（无 Symbol 环境的列表实现）
- `side-channel-map@1.0.1`（Map 实现）
- `side-channel-weakmap@1.0.2`（WeakMap 实现）

<h4>② 开发时闭包</h4>

<h5>A. ESLint 核心引擎</h5>

| 包 | 作用 |
| --- | --- |
| `eslint@9.39.5` | Linter 主体：规则调度、文件遍历、报告 |
| `eslint-scope@8.4.0` | 作用域分析（变量声明 / 引用追踪） |
| `eslint-visitor-keys@4.2.1` | AST 节点子键表（遍历器 keys） |
| `espree@10.4.0` | 默认解析器 |
| `esquery@1.7.0` | AST 选择器（`esquery`，用于规则匹配节点） |
| `esrecurse@4.3.0` | AST 递归遍历（esquery 依赖） |
| `estraverse@5.3.0` | AST 遍历控制器 |
| `esutils@2.0.3` | AST / 关键字工具（regex 判断等） |
| `acorn@8.18.0` | JS 解析器内核 |
| `acorn-jsx@5.3.2` | acorn 的 JSX 插件 |
| `@types/estree@1.0.9` | ESTree AST 类型定义 |

<h5>B. ESLint 配置系统（Flat Config 生态）</h5>

| 包 | 作用 |
| --- | --- |
| `@eslint/config-array@0.21.2` | flat config 数组抽象（层叠合并） |
| `@eslint/config-helpers@0.4.2` | 配置辅助函数 |
| `@eslint/core@0.17.0` | 共享类型 / 工具 |
| `@eslint/eslintrc@3.3.7` | 旧式 `.eslintrc` 兼容层 |
| `@eslint/js@9.39.5` | 官方推荐规则集 |
| `@eslint/object-schema@2.1.7` | 配置对象 schema 校验 |
| `@eslint/plugin-kit@0.4.1` | 插件开发工具 |
| **@eslint-community 系列工具** | |
| `@eslint-community/eslint-utils@4.10.1` | 规则编写工具（getStaticValue 等） |
| `@eslint-community/regexpp@4.12.2` | 正则表达式 AST 解析（no-control-regex 等规则） |
| `globals@14.0.0` | 各环境全局变量清单（browser / node / es2024） |

<h5>C. 配置文件发现与解析</h5>

| 包 | 作用 |
| --- | --- |
| `js-yaml@4.3.2` | 解析 YAML 配置（`.eslintrc.yml`） |
| `json-stable-stringify-without-jsonify@1.0.1` | 稳定 JSON 序列化（缓存 key） |
| `strip-json-comments@3.1.1` | 剥离 JSON 注释 |
| `import-fresh@3.3.1` | 绕过 require 缓存重新加载配置 |
| `parent-module@1.0.1` | 获取调用方模块（import-fresh 依赖） |
| `callsites@3.1.0` | 调用栈信息（parent-module 依赖） |
| `resolve-from@4.0.0` | 从指定目录 resolve 模块（插件解析） |
| `cross-spawn@7.0.6` | 跨平台子进程（`--init` 等） |
| `shebang-command@2.0.0` / `shebang-regex@3.0.0` | 解析 `#!` 行（Windows 下换 shell） |
| `path-key@3.1.1` | PATH 环境变量键名（Windows 是 `Path`） |

<h5>D. 文件匹配与忽略</h5>

| 包 | 作用 |
| --- | --- |
| `ignore@5.3.2` | `.eslintignore` 规则引擎 |
| `minimatch@3.1.5` | glob 匹配（`**/*.js`） |
| `brace-expansion@1.1.21` | `{a,b}` 花括号展开 |
| `balanced-match@1.0.2` / `concat-map@0.0.1` | minimatch 的底层工具 |
| `glob-parent@6.0.2` | 取 glob 的静态父目录（用于 watch / ignore） |
| `is-glob@4.0.3` / `is-extglob@2.1.1` | 判断字符串是否含 glob 语法 |
| `natural-compare@1.4.0` | 自然排序（`file2` < `file10`，结果排序确定性） |

<h5>E. 缓存系统</h5>

| 包 | 作用 |
| --- | --- |
| `file-entry-cache@8.0.0` | 按文件 mtime 缓存 lint 结果（增量加速） |
| `flat-cache@4.0.1` | 磁盘键值缓存 |
| `flatted@3.4.4` | 支持循环引用的 JSON 序列化 |
| `keyv@4.5.4` | 统一 KV 存储接口 |
| `json-buffer@3.0.1` | Buffer 的 JSON 编解码（keyv） |
| `imurmurhash@0.1.4` | 增量哈希（缓存一致性校验） |
| `fast-deep-equal@3.1.3` | 深比较（配置变化检测） |
| `fast-json-stable-stringify@2.1.0` | 稳定序列化（缓存 key 生成） |
| `fast-levenshtein@2.0.6` | 编辑距离 |

<h5>F. 命令行与终端 UI</h5>

| 包 | 作用 |
| --- | --- |
| `chalk@4.1.2` | 终端着色（错误红色等） |
| `ansi-styles@4.3.0` | ANSI 转义码定义 |
| `supports-color@7.2.0` | 终端颜色能力检测 |
| `has-flag@4.0.0` | 命令行 flag 检测 |
| `optionator@0.9.4` | CLI 参数解析（`--fix` 等） |
| `prelude-ls@1.2.1` | 函数式工具（optionator 依赖） |
| `type-check@0.4.0` | 类型断言（optionator 参数校验） |
| `levn@0.4.1` | 类 JSON DSL 解析（optionator） |
| `deep-is@0.1.4` | 深比较（levn / optionator） |
| `word-wrap@1.2.5` | 消息折行（`--format` 输出对齐） |
| `argparse@2.0.1` | 参数解析（js-yaml 依赖） |

<h5>G. Node 通用工具杂项</h5>

| 包 | 作用 |
| --- | --- |
| `which@2.0.2` | PATH 中查找可执行文件 |
| `isexe@2.0.0` | 可执行权限判断（which 依赖） |
| `lodash.merge@4.6.2` | 深合并（规则配置合并） |
| `punycode@2.3.1` | 域名编码（uri-js 依赖） |
| `uri-js@4.4.1` | URI 解析（ajv 的 format 校验） |
| `@humanwhocodes/module-importer@1.0.1` | ESM / CJS 双态导入 |
| `@humanwhocodes/retry@0.4.3` | 重试工具（网络缓存写入） |
| `@humanfs/*`（core / node / types） | 虚拟文件系统抽象（eslint 9 的 fs 层） |
| `yocto-queue@0.1.0` | 微型队列（p-limit 依赖） |

<h5>H. 嵌套副本（16 条）——npm 版本冲突仲裁记录</h5>

| 位置 | 原因 |
| --- | --- |
| `debug@4.4.3` ×3 + `ms@2.1.3` ×3 | 根目录 debug 锁在 2.x（Express 要求），eslint / config-array / eslintrc 需要 4.x → 各自内嵌 |
| `ajv@6.15.0` ×2 + `json-schema-traverse@0.4.1` ×2 | eslint / eslintrc 需要 ajv@6，根或其他依赖占用 ajv@8 → 内嵌 |
| `find-up@5`、`locate-path@6`、`p-limit@3`、`p-locate@5`、`path-exists@4` | eslint 需要 find-up@5 一族，与外部版本冲突 → 整链内嵌 |
| `eslint-visitor-keys@3.4.3` | eslint-utils 需要 v3，根已升级 v4 → 内嵌 |

<h2 id="develop_document-section16">2. 技术限制与已知局限</h2>

- 本项目为个人项目，未经企业级安全审计，请勿直接用于企业生产环境。
- WebDAV 的 **PUT 写入**为全量缓冲（整份文件进内存后才加密上传），属设计权衡，暂不优化；**读取侧支持 HTTP Range 断点续传**，二者不冲突——前者是写入路径，后者是读取路径。
- **`magic` 加密模式有硬性性能上限**：它的密钥流是纯位置函数（每 32 字节做一次 SHA-256），生成成本与数据量线性相关，且**在单线程里同步生成**。48MB 的分片会把事件循环阻塞约 3 秒，期间全站（含 WebDAV 与所有下载）失去响应。因此分片上传在 `magic` 模式下把单片上限压到 **5MB**（`MAGIC_CHUNK_MAX`），代价是同样的文件产生更多分片与更多请求。**这个值不能继续下调**：AWS S3 要求「除最后一片外」每片 ≥ 5MB，再小会在合并时报 `EntityTooSmall`（腾讯云 COS 允许 1MB、阿里云 OSS / 华为云 OBS 允许 100KB，但必须取各厂商中最严的那个）。**该上限同时约束三条入口**：分片上传的 `chunkSize`、直传（`/fs/upload/simple`，`express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后一次性加密）——后两者由加密入口 `encryptBuffer` 自身按模式拒绝，不再依赖调用方各自计算；此外「会话创建时为非 magic、上传中途管理员切到 magic」的续传路径会被**如实拒绝**（409），因为分片偏移由 `chunkSize` 决定，中途改小会与已传分片边界错位（涉及已落盘数据语义的参数不可中途变更）。彻底解决需要把密钥流换成可并行 / 可预计算的构造，那会改动密文格式并影响存量数据，**当前不做**。启用 `magic` 前请评估单文件大小与并发上传数；对性能敏感的场景请用 `crypto`（AES-256-GCM 走原生实现，无此问题）。
- **加密对象的 HTTP Range 有 32MB 分界**：读取侧对加密对象是「完整下载 → 内存解密 → 切片」，因此**明文超过 `MAX_RANGE_BUFFER`（32MB）时会退化为全量流式解密并忽略 Range**，返回 200 + 全量长度。此时 WebDAV 的 HEAD **也不会宣告 206 + `Content-Range`**（R10-07）——否则续传客户端会按区间建多个连接、每个却收到整份内容，拼装出损坏文件。
- **WebDAV 挂载写入不支持分片上传**：资源管理器里往挂载盘写大文件时走的是 PUT（全量缓冲），没有分片通道。因此在 `magic` 模式下写入超过 5MB 的文件会被明确拒绝（413），提示中会给出可执行出路（改用 `AES-256-GCM` 加密模式，或改用管理界面的文件上传——那里会自动按上限切分）。这不是 bug，而是「写入路径没有分片」这一设计事实的外显。
- 会话令牌滚动续期涉及底层改动，暂不实现。
- 子用户规模通常较小，不考虑多实例 / 集群部署。
- CSRF Origin 校验目前以同源自定义头实现，更严格的 Origin 白名单校验计划在正式版提供。
- **attestation 不做完整性链校验**：仅覆盖 ES256 签名算法，不处理 `packed` / `tpm` 等 attestation 格式的证书链验证（本系统信任首次注册的凭据，不做认证器厂商背书）。
- 为安全起见，修改回源设置、跨域设置、修改访问权限等操作需前往服务商控制台，本程序不提供此类功能。
- **审计日志不是取证级证据**：`data/logs.jsonl` 为**明文**、上限 5000 条且会轮转重写（高负载下可能只覆盖很短的时间窗），本机有权限的用户可随意编辑。它能回答「刚才发生了什么、谁在什么时候做了什么」，但**不具备抗篡改能力，不能用于抗抵赖**。需要长期留存请把日志外发到独立的日志系统。
- **密钥不可轮换**：`secret.key` 与 `enc.key` 都没有 rekey 路径，两者的语义都是「文件不存在就新生成一把」。因此**删掉密钥文件再重启不是轮换，是销毁**——旧密文与旧配置立即永久不可读。`enc.key` 一旦泄露，处置只有「全量下载 → 用新密钥重加密 → 重新上传」，且必须**先保住老的 `enc-meta.json`**（否则连第一步的解密都做不了）。完整步骤见「目录结构 → 密钥轮换：当前版本不可轮换」。

**关于 Windows Hello 的技术约束**：

- 仅支持 **ES256（ECDSA P-256 + SHA-256）**，与 Windows Hello 平台认证器默认算法一致；注册时只声明该算法，避免浏览器协商出服务端无法验证的算法。验签遵循标准 `ecdsa-with-SHA256` 语义——对**原始被签名数据**（`authData || SHA-256(clientDataJSON)`）做一次 SHA-256；签名同时兼容 DER 与裸 `r||s`（64 字节）两种编码；
- WebAuthn 要求**安全上下文**：`https://` 或 `localhost` / `127.0.0.1`（浏览器视回环地址为安全），因此通过**局域网 IP + 明文 HTTP** 访问时该功能不可用；
- **本地优先使用** **`localhost`**：`rpId` 必须是**有效域名**，IP 字面量不合法（部分浏览器直接抛 `SecurityError`，与是否 HTTPS 无关）。前端 `webauthnReadiness()` 将不可用原因分类（浏览器不支持 / 非安全上下文 / 使用了 IP 地址 / 正常），并给出可执行的修复动作；
- 服务端校验 `challenge`（一次性、5 分钟时效）、`origin`、`rpIdHash`、凭据 ID 一致性，并**强制要求 UP 与 UV 两个标志位**（任一项未置位即拒绝，Windows Hello 的生物识别 / PIN 一定满足）；另维护 `signCount` 递增以检测凭据克隆——**但该检查仅在认证器上报非零计数时生效**：Windows Hello 等平台认证器普遍恒为 0，实现中 `prev > 0 && next > 0` 两个条件都成立才比对，即该场景下**不提供克隆检测**（硬要比对反而会让这部分用户永远登不进来）；
- 公钥与凭据 ID **不下发前端**，前端只拿到 `webauthnEnabled` 布尔值与随机挑战。


<h2 id="develop_document-section17">3. 威胁模型与不设防边界</h2>

**设防（设计上明确抵御）**

| 威胁方 | 抵御手段 |
| --- | --- |
| 云厂商 / 对象存储侧 | 启用加密后云端只有密文（crypto 为 AES-256-GCM，magic 为混淆级）；只拿到云端数据无法读出内容 |
| 网络中间人 | 非回环部署强制 HTTPS 并 301 跳转，会话 Cookie 自动附加 `Secure`；自定义端点必须 https 且通过端点守卫 |
| 未授权访客 | `/api/**` 一律需会话；分享链接为 128 位熵 ID，可叠加密码 / 有效期 / 次数；写操作必须携带同源头 |
| 暴力破解与撞库 | 登录、查看密码、分享密码、WebDAV 认证均有 IP 级与用户名级限流及指数退避锁定；登录口令以 scrypt 派生 |
| 凭据被滥用 | 建议使用各厂商子账号并最小化授权；密钥不明文回传、界面只显示掩码；对象存储错误统一脱敏 |
| 第三方页面越权调用 | 有副作用的 GET 校验 `Sec-Fetch-Site` / `Referer`；支付票据 Cookie 为 `SameSite=Lax`，跨站子资源请求不会携带 |

**不设防（明确不在防护范围内）**

| 场景 | 后果 |
| --- | --- |
| 本机被攻陷（管理员 / root，或任何能读 `data/` 的账号） | `secret.key` 与 `config.enc` 同目录存放，同时拿到二者即可解出全部访问密钥与 WebDAV 口令。本系统不提供任何本机越权防护 |
| 浏览器侧被控（恶意扩展、XSS） | 会话可被冒用。CSP 与「默认纯文本渲染」只降低概率，不声称可防 |
| 平台认证器被伪造 / 设备丢失 | 见上文 Windows Hello：`signCount` 在平台认证器上通常恒为 0，克隆检测在该场景不生效 |
| 云端密文被删除或截断 | 完整性校验只能「检出」，不能「恢复」。答案在备份，见「目录结构」的备份清单 |
| 内网对象存储的域名被 DNS 劫持 | 端点守卫刻意**不做** DNS 解析（见「服务端点守卫」），只拦截 IP 字面量与元数据地址 |
| 合规 / 国密 / 等保要求 | 未做算法合规性评估。支付宝的 SM2 仅为其平台侧的签名算法选项，本系统的文件加密不使用国密。SM4 未引入的**实测依据与三条阻断理由**见「1.7 为何不引入 SM4 作为文件加密算法」（唯一权威定义） |

**magic 模式的明确定位**：它是**混淆级**保护，用于对抗「有人顺手打开云盘控制台、看到一堆文件就想点开看看」这类弱动机窥探（密文文件头被魔数覆写，直接双击无法打开）。它**不**用于对抗有动机的攻击者：异或密钥流不具备语义安全——同一主密钥 + 同一盐下相同明文必产生相同密文，且只要知道任意一段明文就能反推出该段的密钥流，进而还原对象其余部分。需要真正的保密性请使用 crypto 模式。

<h2 id="develop_document-section18">4. 审计后的行为变更</h2>

| 变更 | 影响 |
| --- | --- |
| 权限判定改为**实时读取**用户记录 | 管理员改名 / 降权 / 删户 / 改密后，该用户的**已有会话立即失效**（旧行为：最长 24 小时仍有效） |
| 操作日志 / ACL 检查 / 上传会话列表改为管理员专属 | 普通用户不再能看到日志与全部上传会话，侧边栏入口同步隐藏 |
| 桶配置写入改为**字段白名单** | 普通用户只能修改 `remark`，对于 `quotaBytes` / `provider` / `region` / `enabled` / `credentialId` 一律忽略。**R28-02 起 `quotaBytes` 移出白名单**：单桶配额在该轮补上了服务端闸门（它此前只是界面展示值），一旦成为被强制执行的限额，允许被约束者自行调大就等于闸门自带解除按钮 |
| 服务端点强制校验 | 自定义 endpoint 必须是 https，且不得指向云平台元数据服务、私网与回环地址（调试可设为 `ALLOW_LOOPBACK_ENDPOINT=1`） |
| 列举上限集中治理 | `listAll` 默认上限由 20 万降至 5 万；达到上限时**显式返回** **`truncated`**，调用方必须检查，不再静默截断 |
| magic 加密增加完整性校验 | 新增的 magic 密文会在解密时校验 SHA-256，被篡改即报错（历史无摘要文件仍可正常解密，向后兼容） |
| 敏感数据文件损坏时**拒绝写入** | `enc-meta.json` 等文件解析失败会重命名为 `.corrupt-<时间戳>` 备份并拒绝覆盖，需人工恢复后重启 |
| CSP 移除 `script-src 'unsafe-inline'` | 前端不再使用内联事件处理器（缩略图 `onload` 等已改为事件委托） |
| 「当前桶」改为**会话级** | 普通用户切换当前桶**只影响自己的会话**，不再改变全局默认桶；全局值的语义降级为「系统默认桶」，仅由管理员切换，供 WebDAV / 分享链接 / 无会话场景回退。界面读端（`listBucketsFor` / `safeView`）与操作读端（`get` / `effective` → `requireConfig()`）**必须同源**，普通用户不会被回退到对其不可见的桶 |
| 分享下载校验请求来源 | 无票据且 `Sec-Fetch-Site` 缺失时，回退校验 `Referer`：跨源即拒绝。curl / wget 等直连客户端仍可用，但会落审计日志 |
| 重命名 / 移动统一做目标冲突检查 | 目标已存在时直接报错，不再静默覆盖（此前仅目录移动分支有检查） |
| 删除目录改为**循环删除 + 截断守卫** | 超过一轮上限或列举被截断时如实报错，且加密元数据只清理**已确认删除**的 key，杜绝残留密文永久不可解 |
| 分享链接的「文件已删除」不再是终态 | 对象被重新上传回**同一个 key** 后链接自动恢复有效（此前一旦标记就不再探测，`deleted` 成了不可逆的假终态，与界面上「重新上传同名文件即可恢复」的承诺相反） |
| 覆盖写入后必须对账加密元数据 | 明文覆盖写入会清掉旧密文元数据。残留条目会让 magic 密文**静默解出错误内容**、crypto 密文下载中途死亡 —— 两者都比直接报错更糟 |
| WebDAV 降为声明 **DAV level 1** | 不再宣称支持 locking；未实现的动词（`LOCK` / `UNLOCK` / `PROPPATCH`）改回 405 加 `Allow` 头，而不是落到 SPA 兜底的 404；目录列举被截断时经 `X-WebDAV-Truncated` 响应头与审计日志如实告知 |
| 批量删除 / 移动改为**批量接口 + 受控并发** | `POST /fs/delete` 的文件分支改走 `deleteMultipleObject`（每批 ≤1000）加 8 路并发探测；`/fs/move` 的文件分支 4 路并发。旧实现是逐对象**串行**往返（200 个文件约 400 次串行云端调用，浏览器早已超时） |
| 服务端故障不再吞掉用户的下载配额 | `/s/:id/dl` 在「配置失效 / 传输前失败」时回滚已占用的名额，只有客户端主动中断才计入。旧实现每点一次白扣一次，`maxDownloads=3` 的链接点三次即转**终态** exhausted |
| 加密查看密码的状态对所有角色可读 | 新增 `GET /enc/status`（只回 `passwordSet`，不含加密模式与魔数）。此前普通用户路径下 `ensureUnlocked()` 恒真，密码验证框永不出现，加密文件实际无法下载 |
| 登出同时复位加密令牌与上传队列 | 会话态的模块级缓存（查看令牌、上传任务列表）在登出点统一清空；否则下一个账号可**免密解密下载**，并看到上一个账号的完整对象键与进度 |
| 当前密码不正确返回 403 而不是 401 | 前端把任意 401 统一当成「会话过期」并强制登出。用户只是手误打错一次密码，却被踢回登录页、弹窗内容丢失、提示文案还是错的 |
| 批量删除以**白名单**判定成败 | 只把「明确出现在云端 `Deleted` 里」的对象算作删除成功；云端未确认的（协议外行为 / 解析退化）一律按**未删除**处理。旧实现硬编码 `Error: []` 丢弃厂商的 `<Error>`，并把「不在 Error 里就算成功」当判据 → 对**仍然存在**的对象清掉解密凭据（永久不可解）并标记分享链接（已分发链接永久失效），两件都不可逆 |
| 复制覆盖写入同样要对账加密元数据 | 复制是一次「覆盖写入」，语义与上传完全相同。旧实现只搬元数据、源无元数据时不清目标 → 目标残留陈旧密文记录（magic 分支会静默解出错误内容）。现与上传路径统一走 `reconcileAfterWrite` |
| WebDAV 目录 COPY / MOVE 拒绝自嵌套 | 复制到自身子目录会形成无界递归复制（请求永不返回 + 持续计费）；目录 MOVE 同时补齐 `Overwrite: F` → 412，不再静默覆盖目标已有对象 |
| WebDAV 的 Range 响应与 HEAD 两端一致 | 带 `Range` 的 GET 如实回 206 + 区间长度 + `Content-Range`（越界回 416）；旧实现宣告全量长度却只发区间字节 → 大文件续传报「传输被提前关闭」/ 下载损坏 |
| 支付轮询补按 IP 的查单预算 | `/s/:id/pay/status` 原本只有订单级节流（3 秒一次）而无按 IP 总量上限，持票据者可造多个订单把网关查单预算放大到约 66 倍。现叠加 200/10 分钟的按 IP 预算，超限时静默返回当前状态（不打断正常 3 秒轮询） |
| `magic` 上限下沉到加密入口 | 上限不再只在分片路径生效：直传与 WebDAV PUT 两条「整文件一次加密」入口由 `encryptBuffer` 自身按模式拒绝（超限 413）；「中途切到 magic 的续传会话」如实拒绝并要求重建任务，避免单个大分片同步阻塞数秒 |

<h2 id="develop_document-section19">5. 安全说明</h2>

- **密钥加密存储**：配置写入 `data/config.enc`，AES-256-GCM（随机 IV + 认证标签）；主密钥为本机随机生成的 `data/secret.key`；访问密钥不回传浏览器，界面仅显示掩码。
- **账号口令存储**：登录口令以 **scrypt** 派生后只存盐与摘要——16 字节随机盐（32 位十六进制）、32 字节输出、代价参数取 Node 默认（N=16384 / r=8 / p=1）；校验用 `timingSafeEqual` 做定长比较，避免时序侧信道。必须使用**异步** scrypt（理由见「文件加密与元数据」）：同步版本会占满单线程事件循环，几十个并发请求就能让全站（含正在进行的下载与 WebDAV）一起卡死。WebDAV 口令因协议限制只能可恢复加密，与登录口令完全隔离（见「设计背景与刻意取舍」）。
- **文件加密**：加解密只在本机服务内发生，云端为密文；crypto 主密钥存于 `data/enc.key`、解密参数（IV / TAG / 盐 / 原始文件头）存于 `data/enc-meta.json`——**二者缺其一即永久不可解，必须同等备份**（完整清单见「目录结构」中的备份表）；查看密码以 scrypt 哈希存储、与加密密钥独立；加密对象禁止预签名直链，防止绕过查看密码。
- **部署强制 HTTPS**：`HOST` 非回环时明文 HTTP 一律 301 跳转 HTTPS，会话 Cookie 自动附加 `Secure`；WebDAV 仅提供 HTTPS。
- **暴力破解防护**：登录、加密查看密码、分享密码、WebDAV 认证均有 IP / 用户名级速率限制，连续失败触发指数退避锁定（上限 30 分钟）。
- **CSRF 与安全头**：非安全方法必须携带同源自定义头 `X-Requested-With`；统一下发 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`frame-ancestors` 等响应头。
- **敏感数据加密落盘**：`enc-settings.json`、`enc-meta.json`、`links.json`、`ipguard.json`、`upload-sessions.json` 均经 `secret.key` 派生密钥加密（自动兼容并升级历史明文文件）；`enc.key` 写入后收紧为仅当前用户可读。
- **原子写入**：所有持久化文件采用「临时文件 + rename」，避免进程被强制结束时截断；临时文件名带随机量（防同毫秒重名覆盖），启动时自动清扫历史遗留的孤儿临时文件（仅清理进程已不存在的）。
- **单实例保护**：启动时获取 `data/.instance.lock` 独占锁，检测到另一个活跃实例即拒绝启动，避免两个进程交替整体覆盖 `config.enc`；崩溃残留的脏锁自动接管。
- **错误消息脱敏**：对象存储错误被翻译为分类化中文提示（如「签名错误：请检查 AccessKey / SecretKey 是否正确」「网络连接异常」），SDK 原始信息仅写入服务端日志。
- **会话治理**：每用户最多 10 个并发会话（超出淘汰最早），支持强制登出全部设备与管理员强制登出指定用户；默认有效期 24 小时，勾选「记住登录状态」为 30 天，Cookie `Max-Age` 始终与服务端剩余有效期一致；权限判定**实时读取用户记录**（改密 / 降权 / 删户后旧会话立即失效）。
- **反向代理**：限流与 IP 屏蔽依赖真实客户端 IP，置于 Nginx / CDN 之后须设置 `TRUST_PROXY=1`，否则默认使用 TCP 对端地址（防伪造 `X-Forwarded-For` 绕过）。**反向风险同样要紧**：直连暴露时**严禁**设置，否则任何人都能伪造 `X-Forwarded-For`，IP 屏蔽与全部限流同时失效。该开关的语义是「信任请求头里的全部跳数」，在 CDN → Nginx 这类链路上，请确保最外层代理会**重写**而非追加该头。
- **最小权限建议**：请在各厂商控制台创建**子用户 / 子账号**（腾讯云 CAM、阿里云 RAM、华为云 IAM 等），仅授予所需桶的对象存储读写权限，勿使用主账号密钥。
- **操作审计**：上传 / 下载 / 删除 / 重命名 / 移动 / 配置变更等关键操作记录于 `data/logs.jsonl`，界面内可筛选查看。
- **支付结果只认服务端查单**：规则见「设计背景与刻意取舍 → 支付结果仅限服务端查单返回」（权威定义，此处不重复）。已支付票据为 `订单ID.HMAC(linkId:orderId)` 的签名 Cookie（`httpOnly` + `SameSite=Lax`），签名输入同时绑定链接与订单，无法跨链接复用。

<h2 id="develop_document-section20">6. REST API 模块化组织</h2>

`server/routes.js` 是一个轻量**聚合器**，按业务领域将路由分散到 `server/routes/` 下的子模块，各子模块互不依赖：

```
server/routes/
├── _context.js   # 依赖汇聚：统一 re-export 全部 server 模块（单一 DI 点）
├── _shared.js    # 共享工具与中间件：requireAdmin / requireConfig / 桶解析与统计缓存 / 错误响应
├── auth.js       # 登录 / 登出 / 当前用户 / 初始化（匿名白名单，最先挂载）
├── users.js      # 用户 CRUD（全部管理员）
├── captcha.js    # 验证码与验证码配置
├── config.js     # 系统配置 / 访问密钥 / 连通性验证
├── buckets.js    # 本地桶增删改启停 + ACL 检查 + 容量统计 / 碎片 / 彻底删除（云端桶列表走 config.js 的 /config/verify）
├── ipguard.js    # IP 屏蔽规则 + IP 地址限速规则（全部管理员）
├── throttle.js   # 【R37】下载限速「上层下限」查询（`GET /throttle/ceiling`，不挂 requireAdmin）
├── backup.js     # 【R38】配置备份：实时码 / 导出（账户口令 + 独立备份密码）/ 导入（仅首次初始化且未配置过时允许），四条全部 requireAdmin —— 实时码含 API Key / 支付凭证 / WebDAV 口令明文
├── enc.js        # 加密设置 / 解锁 / 上传排除规则
├── smtp.js       # 【R53】发信设置（SMTP）：读取 / 保存 / 测试邮件，三条全部 requireAdmin；口令明文永不下发前端
├── site.js       # 【R54】站点设置：公共的 `GET /site/info`（匿名，登录页要用站点名称设浏览器标题栏）+ 仅管理员的 `GET/PUT /site/config`（站点名称 / 公开注册 / 新用户身份 / **R68 追加的三页协议提示** `notices{login,register,share}{enabled,text}`）
├── agreements.js # 【R68】协议设置（**只保存两份协议正文**，不含「哪几页显示提示」——那项按需求归属站点设置）：`GET/PUT /agreements/config`（均仅管理员，PUT 是**严格 PATCH**，只写给出的那一份）+ `POST /agreements/preview`（草稿渲染，**不落盘**）+ 公开的 `GET /site/agreements`。三条管理接口全部 requireAdmin
├── invite.js     # 【R54③】邀请码设置（六条**全部** requireAdmin）：`GET /invites`、`POST /invites`（批量生成）、`POST /invites/bulk`（批量 PATCH）、`POST /invites/delete`、`POST /invites/export`（导出 txt，**刻意 POST** —— 响应体是明文口令集合，GET 会把它写进浏览器历史与 access log）、`PUT /invites/:id`（**排在三条字面量路径之后**）
├── restore.js    # 【R65】订单取回设置（两条**均** requireAdmin）：`GET/PUT /restore/config`。只有两个数：`maxUses`（每个订单号可取回几次）与 `maxFails`（同一 IP 连续输错几次封 24 小时）。**没有启用开关**，默认持久化生效
├── coupon.js     # 【R62】优惠券设置（五条**全部** requireAdmin）：`GET /coupons`、`POST /coupons`（生成）、`POST /coupons/bulk`（批量 PATCH）、`POST /coupons/delete`、`PUT /coupons/:id`
├── payment.js    # 支付平台凭证配置（仅基础配置与合法性校验，全部管理员）
├── webdav.js     # WebDAV 账户与服务控制（含明文密码接口，全部管理员）
├── links.js      # 分享链接（按创建者隔离）
├── fs.js         # 文件列表 / 搜索 / 上传 / 下载 / 重命名 / 移动 / 删除 / 目录树
└── stats.js      # 测速 / 容量 / 概览 / 审计日志 / 健康检查
```

约定：

- **新增路由落在对应领域子模块**；新增领域则建 `routes/<name>.js` 并在 `routes.js` 追加一行 `router.use()`。
- **挂载顺序有语义**：`auth` 必须最先（匿名白名单依赖它先命中）；`/credentials/visibility` 必须注册在 `/credentials/:id` 之前，否则会被参数路由吞掉。改动顺序前先运行 `npm test`。
- **路由表面积受测试保护**：`tests/routes-surface.test.js` 维护期望路由基线，增删路由必须同步更新，避免误删或意外遮蔽。

<h2 id="develop_document-section21">7. HTTP API</h2>

除登录 / 初始化 / 验证码与公开分享页外，`/api/**` 均需登录会话，非安全方法须携带同源头 `X-Requested-With`。

**通用约定**（下列各表均适用）：

- **会话**：Cookie 名 `s3mgr_session`（`HttpOnly`，非回环部署自动附加 `Secure`，`SameSite=Lax`）。除 `/auth/init`、`/auth/login`、验证码与 `/s/*` 公开页外，其余接口无有效会话即 401。
- **写操作同源头校验**：`POST` / `PUT` / `DELETE` 必须携带 `X-Requested-With`，缺失一律拒绝——这是 CSRF 防线，不是可选的装饰。
- **响应封装**：成功直接返回业务对象；失败统一为 `{ error: string }`，文案已脱敏并可直接展示给用户。
- **请求体规范**：本章对**有请求体的接口**给出「字段 / 类型 / 必填 / 约束 / 缺省」子表。缺省值一律以路由的校验代码为准（`server/routes/*.js`）——改动 `parseLinkParams`、`upload/init` 这类校验逻辑时必须同步本表。未列出的字段会被忽略（不做透传）。
- **状态码**：`400` 参数或业务校验失败 · `401` 未登录 / 会话失效 · `403` 权限不足 · `404` 对象或资源不存在 · `405` 方法不允许 · `409` 资源或状态冲突 · `410` 分享链接已删除 / 已过期 / 次数用尽 · `429` 触发限流（响应含重试等待秒数）· `402` 需付费后下载 · `500` 服务端异常。
  > **`409` 与「目标已存在」不是一回事**：`409` 用于**资源或状态**级冲突——系统已初始化（`POST /auth/init`）、用户名 / 应用账户 / IP 屏蔽规则重复、分片参数与会话声明不一致、WebDAV 目录移动遇同名对象。**重命名 / 移动到已存在的对象 key 是 `400`**（管理端 `assertNoConflict` 走 `badRequest`），WebDAV 侧的同型冲突才是 `409`（目录）或 `412`（`Overwrite: F`）。早期文档把两者都写成「409 目标已存在」，此处已按代码更正。
- **分页与游标**：`/fs/list` 用 `marker` 续页，`/fs/search` 用 `cursor` 续扫（原样回传即可）。两者都返回 `truncated`——为真即表示**结果不完整**（已达列举上限或被截断），调用方必须检查，不得当作「全部」。
- **幂等与并发**：创建类接口不幂等（重复提交会产生新记录）；重命名 / 移动先做目标冲突检查，已存在即报错而非覆盖；下载计数「先计数后传输」，传输启动前失败则回滚。

**错误判定口径**（写客户端前必读）：

失败响应体**只有 `{ error: string }` 一个字段，没有机器可判定的错误码**。因此：

- **分支请按 HTTP 状态码判**，不要匹配 `error` 文案——文案是给人看的，措辞随时会调整，匹配文案的客户端会在某次更新后静默失效。
- 同一个状态码会覆盖多种成因，需要区分时只能靠**调用上下文** 而不是响应本身：

| 状态码 | 常见成因（按接口上下文区分） |
| --- | --- |
| `400` | 参数缺失 / 类型不合法；业务规则不满足（如「已开启需付费下载但未填金额」）；目标冲突（重命名 / 移动到已存在的 key） |
| `401` | 未登录或会话失效；用户名或密码错误 |
| `403` | 权限不足（非管理员）；缺 `X-Requested-With`（CSRF）；上传会话不属于当前用户（SEC-10） |
| `404` | 对象不存在或无权访问；链接 / 订单 / 用户不存在 |
| `410` | 分享链接已删除 / 已过期 / 次数用尽（三者不细分） |
| `428` | 尚未完成配置（`configured: false`），例如未配访问密钥或未选择当前桶 |
| `429` | 触发限流或失败锁定 |

> 若确实需要稳定的机器可读码（如 `INVALID_PARAM` / `QUOTA_EXCEEDED`），需要改造 `server/routes/_shared.js` 的 `sendError()` 与各 `badRequest()` 调用点，属 API 契约变更——**当前版本未提供**，请勿依赖。

**客户端集成建议**（在「没有错误码」这个前提下怎么把集成写稳）：

| 客户端要做的判断 | 依据 |
| --- | --- |
| 是否需要重新登录 | **只看 401**。403 不要当成会话过期——前端正是靠 401 触发强制登出，把 403 也算进去会让用户手误打错一次密码就被踢回登录页 |
| 能否重试 | `429` 按响应里的等待秒数重试；`5xx` 可退避重试；**其余 4xx 一律不重试**（输入不变则结果不变，重试只是放大限流计数） |
| 是否已到终态不必再轮询 | `410` 是分享链接终态（删除 / 过期 / 用尽三者不细分），`409` 在 `/auth/init` 上是终态 |
| 「没配置好」与「没权限」 | `428` = 配置未完成（`configured: false`）；`403` = 权限不足或同源头校验失败。二者处理路径完全不同 |
| 该展示什么给用户 | `error` 文案已脱敏，**可直接原样展示**，无需自己再映射一份文案表 |

`400` 的细分只能靠**调用上下文**（响应本身不提供）：

| 端点族 | `400` 的常见成因 | 客户端可做的事前自校 |
| --- | --- | --- |
| 写接口的参数校验（`/fs/upload/init`、`/config/verify`、支付设置） | 缺字段 / 类型不合法 / 越界 | 提交前按本章「请求体规范」子表自校，不要等 400 |
| 业务规则（创建分享链接、开关付费下载） | 规则组合不满足（如「已开启需付费下载但未填金额」） | 先 `GET` 当前配置再反推哪条规则没满足，比解析文案可靠 |
| 重命名 / 移动 | 目标 key 已存在（`assertNoConflict`） | 先做一次存在性探测，或直接提示用户改名 |

> 这套做法的代价是**客户端必须理解业务语义**，无法靠响应体自洽。这是已知的取舍：给 `error` 加机器可读码要改 `sendError()` 与全部 `badRequest()` 调用点（约几十处），属于破坏性契约变更，当前版本不做。若你确实需要它，改造入口就在上一段引用的那两个符号。

<h3 id="develop_document-section22">7.1 认证与用户</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（是否已完成配置） |
| GET | `/update/check` | 【R34】「关于」卡片的「检查更新」：与服务端版本（`package.json`）比较 GitHub 上的最新版本；**不挂 `requireAdmin`**（「关于」是设置页里唯一对普通用户可见的卡片），只读、无参数、结果缓存 10 分钟 |
| POST | `/auth/init` | 首次启动初始化管理员 |
| POST | `/auth/login` · `/auth/logout` · `/auth/logout-all` | 登录 / 登出 / 登出全部设备 |
| GET | `/auth/me` | 当前会话用户 |
| POST | `/auth/login` | 登录第一步：人机验证 + 密码；若已启用 Windows Hello 则返回 `webauthnRequired` + 一次性挑战（**不签发会话**） |
| POST | `/auth/login/webauthn` | 登录第二步：校验 Windows Hello 断言，通过后签发会话 |
| GET/PUT | `/users/me` | 当前用户资料（**所有登录用户可用**；PUT 仅接受用户名 / 密码，显式拒绝 role / permissions） |
| GET | `/users` | 用户列表：管理层（管理员或根用户）返回全部（`scope:'all'`），普通用户仅返回自己（`scope:'self'`）。普通用户前端不显示用户管理卡片、也不调用此接口 |
| POST | `/users` · `PUT/DELETE /users/:id` | 增删改用户（管理层）。**授权只按 `role` 判定**：`permissions` 字段目前仅原样存储与回传，不参与任何鉴权判定。⚠️ **R71 的越权边界**：管理员只能操作**普通用户**（目标为 `admin` / `root` 时 403，且判定在写操作之前 —— 目标记录与其会话都不受影响）；`role: 'root'` 任何角色都 403（不可授予、不可撤销，`root` 账户的 `PUT { role }` 也是 400）；只有根用户能创建管理员、调整角色 |
| POST | `/users/:id/logout` | 管理层强制登出指定用户。R71：管理员只能踢普通用户的会话（否则等于给了一个「让根用户随时掉线」的骚扰通道） |
| POST | `/users/:id/ban` | 管理层**封禁**指定用户：请求体 `{ reason, until }`（`reason` 必填 ≤ 200 字；`until` 为 epoch 毫秒，留空 = 永久封禁）。写入后**立即吊销该用户全部会话**；不能封禁当前登录账户。R71：封禁是**软删除**，故与删除同口径 —— 管理员不能封禁管理员 / 根用户 |
| POST | `/users/:id/unban` | 管理层**解除**指定用户的封禁，立即恢复登录；从未封禁过时返回 400（不做「永远成功」的空操作）。R71：与封禁同口径（管理员只能解普通用户） |
| POST | `/webauthn/register/options` · `/webauthn/register/verify` | 注册 Windows Hello（**需当前密码**）：下发挑战+注册选项 / 校验 attestation 并保存公钥 |
| POST | `/webauthn/disable` | 关闭自己的 Windows Hello（**需当前密码**） |
| POST | `/users/:id/webauthn/disable` | 管理员清除指定用户的 Windows Hello 凭据（救济通道） |
| GET/PUT | `/captcha/config` · `GET /captcha/public` | 验证码开关与下发；`GET` 回 `providers.{recaptcha,turnstile}.{siteKey,hasSecret}` 两套视图（**明文 `secretKey` 任何情况下都不出服务端**，与公开视图一致），`PUT` 接受 `providers` 一次提交两套、未提交的那一套原样保留。`secretKey` 留空 = 保持原密钥不变，`null` = 显式清除 |

**请求样例**（登录；`-i` 可以看到服务端下发的 `Set-Cookie`，`-c` 把 Cookie 存进文件供后续请求复用）：

```bash
curl -i -c cookie.txt -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"username":"admin","password":"你的密码"}'
```

**响应样例 · 密码正确且未启用 Windows Hello**（直接签发会话）：

```json
{
  "ok": true,
  "user": {
    "id": "u_8f21c0",
    "username": "admin",
    "role": "admin",
    "permissions": {},
    "webauthnEnabled": false,
    "webauthnCreatedAt": null,
    "createdAt": "2026-09-01T02:11:30.000Z",
    "updatedAt": "2026-09-12T08:24:05.000Z"
  }
}
```

**响应样例 · 已启用 Windows Hello**：同一个请求**不签发会话**（密码通过只是第一步），改为下发一次性挑战，客户端验签通过后再调 `POST /api/auth/login/webauthn`：

```json
{
  "ok": false,
  "webauthnRequired": true,
  "challenge": "vJ8dQ2lRbXk...（base64url，服务端一次性）",
  "rpId": "storage.example.com",
  "timeout": 60000,
  "username": "admin",
  "remember": false,
  "credentialId": "AQIDBAUGBwg..."
}
```

**请求 / 响应样例**（读取当前会话用户；未登录时**不报错**，返回 `user: null`）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/auth/me
```

```json
{ "ok": true, "user": { "id": "u_8f21c0", "username": "admin", "role": "admin", "permissions": {}, "webauthnEnabled": false, "webauthnCreatedAt": null, "createdAt": "2026-09-01T02:11:30.000Z", "updatedAt": "2026-09-12T08:24:05.000Z" } }
```

```json
{ "ok": true, "user": null, "initialized": true }
```

**失败响应**统一为 `{ "error": "..." }`，文案已脱敏、可直接展示给用户：

- `401` 密码错误 → `{ "error": "用户名或密码错误" }`
- `429` 连续失败触发锁定 → `{ "error": "失败次数过多，账户已临时锁定，请 27 秒后重试" }`
- `403` 写操作缺 `X-Requested-With` → `{ "error": "请求缺少同源校验头，已拒绝（CSRF 防护）" }`
- `401` 无会话访问受保护接口 → `{ "error": "未登录或会话已过期，请重新登录" }`


<h3 id="develop_document-section23">7.2 配置、密钥与存储桶</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/config` | 读取（掩码）/ 保存配置 |
| POST | `/config/verify` | 测试连接（**仅管理员**）。可携带未保存的 provider/密钥/地域，也可引用已保存密钥的 `credentialId`；自定义 Endpoint 一律经 `assertSafeEndpoint` 校验。**理由两条**：① 请求方可控的 endpoint / 凭据会带来盲 SSRF（SEC-03）；② 本接口会回传该密钥可见的**全部云端桶名**，属账号资产（SEC-11，与 `GET /buckets` 同一口径）。普通用户添加存储桶时请手填桶名与地域，服务端会做存在性探测 |
| GET/POST | `/credentials` · `PUT/DELETE /credentials/:id` | 密钥列表（掩码）/ 新增 / 改备注 / 删除 |
| PUT | `/credentials/:id/active` · `/credentials/visibility` | 设为当前密钥 / 调整可见性 |
| GET | `/credentials/quota-usage` | 按 API Key 汇总空间用量与上限（**仅管理员**，系统设置页「负载均衡」卡片的数据源）。用量按「实际生效的密钥」归集（`credentialIdForBucket`），并叠加尚未回传官方统计的待定增量 |
| GET/POST | `/buckets/local` · `PUT/DELETE /buckets/local/:id` | 本地桶列表 / **添加（仅管理员）** / 编辑（普通用户仅备注与配额） / 本地删除（仅管理员）。普通用户看到的是管理员开放的桶，只读 |
| PUT | `/buckets/local/:id/active` · `/buckets/local/:id/enabled` · `/buckets/visibility` | 切换当前桶 / 启停 / 可见性 |
| GET | `/buckets/stats` | 每桶容量、累计流量、请求数、碎片统计 |
| POST | `/buckets/local/:id/clear` | 清空桶（`nameConfirm` 须与桶名完全一致） |
| GET/POST | `/buckets/local/:id/fragments` · `/buckets/local/:id/fragments/clear` | 碎片列表 / 中止未完成分片 |
| GET/POST | `/buckets/local/:id/destroy-check` · `/destroy` | 彻底删桶条件检查 / 删除（三重校验） |
| GET | `/acl-check` · `PUT /acl-check/disabled` | 桶 ACL 公有读告警 / 关闭提醒 |

> **API Key 空间配额（R25「负载均衡」）**：凭据记录上的 `quotaBytes` 是**该密钥名下所有桶的合计上限**（`0` = 无限制），与存储桶记录上的同名字段（单桶上限）是**两个层级**，不要混用。判定为**服务端权威**：以该密钥新建桶、或它名下任一桶再写入（`/fs` 的 `mkdir` / `rename` / `move` / `upload`，以及 WebDAV 的 PUT / MKCOL / COPY / MOVE）超出即 `403`（响应体带 `code = CREDENTIAL_QUOTA_EXCEEDED`）。因为官方 `?stats` 的桶用量有 **15 分钟缓存**，判定用「缓存值 + 尚未取样的待定增量」（`bucketPendingDelta`）——只读缓存会让 TTL 窗口变成无限制超额窗口。另注意「桶归属哪个密钥」由 `credentialIdForBucket` 决定（内部走 `activeCredential`，与真正写入时选中的密钥同源），**不是**直接读 `bucket.credentialId` 字段。
>
> **R28-02 补充（两个层级现在都强制）**：桶记录上的 `quotaBytes` 此前**只在界面展示** —— `CHANGELOG` 里那句「单桶限额」当时并不成立，本轮补上了与凭据级同口径的闸门 `assertBucketQuota()`，挂在同样的 9 个写入出口（`/fs` 5 处 + WebDAV 4 处），超限回 `403 + code = BUCKET_QUOTA_EXCEEDED`。连带一条权限收口：该字段**移出**普通用户的可改白名单（只留 `remark`）—— 被约束者若能自行调大上限，闸门等于自带解除按钮。两个层级的比较口径完全一致：`已用（缓存值 + 待定增量）+ 本次待写 > 上限` 才拒（**严格大于**），`0` = 无限制。

**请求 / 响应样例**（读取配置；密钥一律掩码，任何接口都不回传 `secretKey`）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/config
```

```json
{
  "selfTest": true,
  "configured": true,
  "corrupted": false,
  "provider": "tencent",
  "providerName": "腾讯云",
  "secretIdMasked": "AKID****************************Wxyz",
  "hasSecret": true,
  "bucket": "my-bucket-1250000000",
  "region": "ap-guangzhou",
  "bucketRemark": "生产",
  "quotaBytes": 0,
  "domains": { "primary": "", "backup": "" },
  "uploadExcludes": [],
  "credentials": [ … ],
  "activeCredentialId": "c_7a1f",
  "buckets": [ … ],
  "activeBucketId": "b_2e9c",
  "updatedAt": "2026-09-12T08:24:05.000Z"
}
```

> `credentials` / `buckets` 的元素结构分别见 `GET /api/credentials` 与 `GET /api/buckets/local`；两者都按角色过滤——普通用户只能看到「对其可见且已启用」的条目。

**请求 / 响应样例**（写操作必须带 `X-Requested-With`，否则 403）：

```bash
curl -s -b cookie.txt -X PUT http://127.0.0.1:3000/api/config \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"provider":"tencent","region":"ap-guangzhou"}'
```

- 成功 → `{ "ok": true }`
- `400` 服务商不支持 → `{ "error": "当前版本暂不支持该服务商，请选择其他服务商" }`
- `403` 非管理员 → `{ "error": "仅管理员可执行该操作" }`（前端隐藏入口只是第一层，接口层一律强制校验）

<h3 id="develop_document-section24">7.3 文件与上传</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/fs/list` · `/fs/tree` · `/fs/stat` · `/fs/search` | 分页列表 / 目录树 / 属性 / 搜索（默认递归整个子树，`scope=current` 时单级列举；逐页扫描并按游标续扫，客户端断开即停止翻页） |
| POST | `/fs/mkdir` · `/fs/rename` · `/fs/move` · `/fs/delete` | 新建 / 重命名 / 移动 / 删除（递归） |
| POST | `/fs/copy` | 复制（递归，**R52**）：保留源、目标侧新增占用。目标存在同名项时不静默覆盖，而是先回 `needsDecision` + `conflicts`，由前端逐项询问「覆盖 / 跳过」后带 `decisions` 重发 |
| PUT | `/fs/upload/simple` | 小文件直传（≤ 8MB） |
| POST | `/fs/upload/init` | 分片上传初始化（返回 `mode` / `sessionId` / `chunkSize` / 已传分片；**载荷见下方请求体表**） |
| PUT | `/fs/upload/chunk` | 上传单个分片（query 传 `session` / `part`，请求体为原始字节） |
| POST | `/fs/upload/complete` · `POST /fs/upload/abort` | 合并 / 取消（请求体 `{ sessionId }`） |
| GET | `/fs/sessions` | 进行中的上传会话（断点续传） |
| GET | `/fs/download` · `/fs/thumb` · `/fs/presign` | 下载（密文校验令牌后解密）/ 缩略图 / 预签名链接 |

**请求 / 响应样例**（目录列举；`contents` 是对象、`prefixes` 是子目录，**两个数组分开返回**）：

```bash
curl -s -b cookie.txt 'http://127.0.0.1:3000/api/fs/list?prefix=photos/&maxKeys=100'
```

```json
{
  "prefix": "photos/",
  "contents": [
    {
      "key": "photos/2026/shanghai.jpg",
      "name": "shanghai.jpg",
      "size": 248192,
      "lastModified": "2026-09-10T03:21:44.000Z",
      "etag": "3b6a1f0c9d2e4a7b8c5d6e7f8a9b0c1d",
      "storageClass": "STANDARD",
      "isFolder": false,
      "type": "image",
      "encrypted": true
    }
  ],
  "prefixes": [
    { "prefix": "photos/2025/", "name": "2025", "isFolder": true, "type": "folder", "size": 0, "lastModified": "" }
  ],
  "isTruncated": true,
  "nextMarker": "photos/2026/shanghai.jpg"
}
```

> `isTruncated` 为真表示**结果不完整**，下一页把 `nextMarker` 原样作为 `marker` 传回。`encrypted: true` 表示云端存的是密文，下载 / 查看时由本地解密。

**请求 / 响应样例**（搜索；`cursor` 原样回传即可续扫）：

```bash
curl -s -b cookie.txt 'http://127.0.0.1:3000/api/fs/search?prefix=photos/&q=shanghai&type=image'
```

```json
{
  "matches": [
    { "key": "photos/2026/shanghai.jpg", "name": "shanghai.jpg", "size": 248192, "isFolder": false, "type": "image", "lastModified": "2026-09-10" }
  ],
  "scanned": 137,
  "limit": 200,
  "cursor": "photos/2026/shanghai.jpg",
  "truncated": true,
  "hint": "该目录下还有未扫描的对象（本轮已扫描 137 个），可继续搜索。"
}
```

**请求 / 响应样例**（小文件直传：请求体是**原始字节**，不是 JSON；`path` 放在 query 上）：

```bash
curl -s -b cookie.txt -X PUT 'http://127.0.0.1:3000/api/fs/upload/simple?path=notes/a.txt' \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Requested-With: XMLHttpRequest' \
  --data-binary @a.txt
```

```json
{ "ok": true, "key": "notes/a.txt", "encrypted": true }
```

> 超过 8MB 请走分片路径（`/fs/upload/init` → `/fs/upload/chunk` → `/fs/upload/complete`）。**上传排除规则的校验在服务端**，直传与分片两条路径都必须带 `gitignore` / `gitignoreRel` 参数，缺一就会绕过排除规则。

**查询参数 · `PUT /api/fs/upload/simple`**（请求体是**原始字节**，不是 JSON）：

| 参数 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `path` | string | ✔ | 目标对象 key，服务端 `normalizeKey()` 规范化 |
| `gitignore` | string | ✔ | 排除规则文本；**不传不报错，但等于放弃服务端兜底**（FUN-09），无规则时显式传空串 |
| `gitignoreRel` | string | ✔ | 规则文件的相对目录；同上 |
| `mtime` | string | ✘ | 原文件修改时间，写入云端 `x-s3-meta-file-mtime` |

**请求体 · `POST /api/fs/upload/init`**：

| 字段 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `key` | string | ✔ | 目标对象 key |
| `size` | number | ✔ | 文件总字节数，须为有限数且 ≥ 0 |
| `gitignore` | string | ✔ | 同直传：服务端兜底校验排除规则 |
| `gitignoreRel` | string | ✔ | 同上 |

```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/fs/upload/init \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"key":"videos/trip.mp4","size":2147483648,"gitignore":"","gitignoreRel":""}'
```

响应的 `mode` 决定后面走哪条路，**客户端必须按它分支**，不能自己拿 8MB 去猜：

| `mode` | 含义 | 响应字段 |
| --- | --- | --- |
| `simple` | `size` ≤ 直传上限（见下），**服务端不创建会话** | `{ mode, key }` —— 请改调 `/fs/upload/simple` |
| `multipart` | 走分片 | `{ mode, sessionId, chunkSize, uploadedParts, key }` |

- **直传上限是随加密模式变化的（R10-05）**：未开启加密 / `AES-256-GCM` 模式为 **8MB**；「文件头魔数（magic）」模式为 **5MB**（`LIMITS.MAGIC_SYNC_MAX`）。magic 模式的同步加密有 5MB 上限，若 `init` 仍按 8MB 分界，`(5MB, 8MB]` 的文件会被判为 `simple` → 直传必然 413，而前端拿到 `simple` 又不会改走分片 —— 是一条死路。客户端**不要自己写死 8MB**，一律按响应的 `mode` 分支。
- `chunkSize` 由服务端计算：`min(48MB, max(8MB, ceil(size/10000/1MB)·1MB))`，magic 模式再压一道 `min(·, 5MB)`（R8-02：单片同步阻塞上限；同时它是 AWS S3「除末片外每片 ≥ 5MB」的协议下限，两者在此重合，不可再往下调）。
- `uploadedParts` 非空即**命中断点续传**：按「Key + Size + 创建者 + 目标桶」匹配到未完成会话且远端 `uploadId` 仍有效，客户端应跳过这些分片。
- 会话 `provider` 随会话落盘（R7-01），后续 `chunk` / `complete` / `abort` 都按**会话自身**的厂商与桶解析凭据——上传中途切桶不会让已传分片作废。

**其余两个接口的入参**：`PUT /api/fs/upload/chunk` 走 query（`session`、`part`，从 1 开始，请求体为原始分片字节）；`POST /api/fs/upload/complete` 与 `/abort` 走请求体 `{ sessionId }`。三者都会校验会话归属（SEC-10：仅创建者本人或管理员可操作）。

- `chunk` 会校验分片大小 ≤ 会话的 `chunkSize`，超限返回 **400**（R10-08）：分片偏移已由 `chunkSize` 确定，超大的分片既无法正确合并，也会让 magic 的同步 XOR 独占事件循环数秒。

<h3 id="develop_document-section25">7.4 分享、加密、IP、WebDAV、统计</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/links` | 分享链接列表（管理员全部，普通用户仅自己创建的） |
| POST | `/links` | 创建链接：对目标对象做 `headObject` 校验并快照文件名 / 大小；**载荷见下方请求体表** |
| PUT | `/links/:id` | 改有效期 / 次数 / 密码 / 付费 / 重置计数；普通用户仅限自己创建的 |
| DELETE | `/links/:id` | 删除本地分享记录（**不影响云端对象**）；普通用户仅限自己创建的 |
| DELETE | `/links/dead` | **批量删除失效链接**（仅「文件已删除」与「已过期」；**不含可逆的「已关闭」**）；普通用户仅限自己创建的 |
| GET | `/links/qrcode` | **分享链接的二维码**（R50）：收 `text` 参数，回 `{ svg }` —— 复用零依赖的 `server/qrcode.js`。<br>⚠️ 内容超过版本 10 的容量（约 213 字节）时回 400 并说明原因（预签名直链必然超限）。不挂 `requireAdmin`：普通用户也要创建分享链接 |
| GET/POST | `/s/:id` · `GET /s/:id/dl` | 公开分享页 / 密码提交 / 下载（匿名，挂在根路径） |
| POST | `/s/:id/pay` | 发起支付（选渠道 → 返回跳转 URL 或二维码） |
| GET | `/s/:id/pay/return` | 支付平台同步回跳（触发一次查单后回到分享页） |
| POST | `/s/:id/pay/check` · `GET /s/:id/pay/status` | 主动查单 / 状态轮询（最小间隔 3 秒，防刷） |
| POST | `/pay/notify/:platform` | 异步通知（**仅作触发器**，结果以服务端查单为准） |
| GET/POST | `/s/:id/restore` | 【R64】**恢复购买**（匿名 + 已登录都可用）：填订单号取回下载权限。判定收敛到唯一实现点 `paymentOrders.claimForLink(no, linkId)` —— 订单**存在且属于本链接且状态为 `paid`** 才放行；成功时签发的是与真实支付**完全相同的**票据 Cookie `sp_<linkId>_pay`，因此页面判定、`GET /s/:id/dl`、`HEAD /s/:id/dl` 三处**一行都不用改**。<br>⚠️ 「订单号不存在」与「订单号不属于本链接」共用**同一条文案**（否则这个端点就成了订单号存在性预言机）；单独限流 `orderRestoreLimiter`（10 分钟 20 次） |
| GET | `/s/:id/history` | 【R64】**查看历史订单**（需登录）：列出本账号在该链接下的付费订单（含已退款，如实标注）与**免费下载记录**（`data/downloads.json`，只记**首次**、重复下载不新增条目）。渲染时为每笔 `paid` 且链接仍存在的订单**补发**对应票据 Cookie，因此点「重新下载」不会再被送回付费墙。<br>⚠️ 只按订单上的 `userId` 快照归集，**绝不按 IP 归集**（同一出口 IP 背后可能是一整个办公室） |
| POST | `/s/:id/logout` | 【R64】分享页右上角「退出登录」：销毁当前会话 + 清 `kepler_sid` Cookie 后 303 回原分享页。刻意是 **POST**（GET 会让任何一张 `<img src>` 都能替访客退出登录） |
| GET | `/api/payment/orders` | 订单列表（管理员） |
| POST | `/api/payment/orders/:id/refund` | 标记订单为已退款（管理员；仅作记账，不发起网关退款） |
| DELETE | `/api/payment/orders/failed` | **批量删除失效订单**（仅「支付失败」；管理员；「已支付」「已退款」与支付中的订单不受影响） |
| GET | `/api/payment/logos` | 【R92】渠道品牌图形（内联 SVG，按平台 id 索引）——**与配置接口分开下发**：图形是代码内常量，跟着「每次打开支付设置都要拉」的配置一起传会让那份响应从 ~9 KB 涨到 ~25 KB。带 `Cache-Control: private, max-age=604800`，Express 默认 ETag 让过期重访走 304。管理员专属 |
| POST | `/api/payment/config/:platform/selftest` | 【R92】**凭据自检**：拿（表单当前值 + 已保存值的合并结果）真的向网关发一次**只读**请求（支付宝 / 银联 `txnType=00` 查单、微信 `GET /v3/pay/transactions/out-trade-no/{假单号}`、PayPal 取令牌），回 `{ ok, state, message, detail }`。<br>`state` 四档：`ok`（网关接受了我们的签名 / 令牌，答复「订单不存在」）/ `auth`（凭据被拒）/ `net`（没拿到可用答复）/ `config`（字段不全，连请求都发不出）。⚠️ 与 `validate` 的区别：那个**不出网**、只看格式；这个才回答「网关认不认」。**只读、不建单、不扣款**；管理员专属 |
| PUT | `/api/payment/site-url` | 站点地址（管理员，回跳 / 回调基准） |
| GET/PUT | `/enc/settings` | 加密设置（管理员）：读当前模式 / 改模式与查看密码 |
| GET | `/enc/status` | 加密状态（**所有角色可用**）：只回 `{ passwordSet }`，前端据此决定要不要弹查看密码框 |
| PUT | `/concurrency` | 【R48】「线程并发」：同时上传 / 加密的文件数（**仅管理员**，`1`~`16`，入参非法一律 400 而不是静默归一化）。**刻意只有写接口**：读走 `GET /config` —— 并发上限要对**所有登录用户**下发（普通用户也要上传，前端调度必须知道上限），而 `safeView()` 已经把 `concurrency` 下发给每一个角色；此处再开一个 GET 就出现了第二个读取口径 |
| POST | `/enc/unlock` | 查看密码验证换取 30 分钟令牌（仅经 `x-enc-token` 头传递） |
| GET | `/ipguard` · `GET /ipguard/test` | 规则列表 / 预检某个 IP 是否会被拦 |
| POST | `/ipguard/rules` | 新增规则 |
| PUT | `/ipguard/rules/:id` · `PUT /ipguard/rules/:id/enabled` | 修改规则 / **单独切换启用状态**（与整条修改分开的接口） |
| DELETE | `/ipguard/rules/:id` | 删除规则 |
| POST | `/ipguard/restore-bans/unban` | 【R65】解封「取回下载权限」的连击封禁（**仅管理员**，请求体 `{ ip }`，回 `{ ok, ip, removed, restoreBans }`）。⚠️ 与上面的**规则表**是两张独立的表：规则是管理员自己配的拦截规则，而「取回封禁」由 `server/restore-guard.js` 在取回端点输错达上限时自动落盘（`data/restore-bans.json`），**只拦「用订单号取回下载权限」这一件事** —— 分享页浏览、`GET /s/:id/dl` 下载、上传、后台全部不受影响。到期（24 小时）自动解除，此接口用于管理员提前解封 |
| GET | `/throttle/ceiling` | 查「上层已设的下载限速」（R37）：参数 `scope` + `id`/`bucket`，回 `{ limit, source, sourceLabel, layers }`。**不挂管理员守卫**——普通用户新建分享链接时也要能看到自己被上层限到多少 |
| GET | `/backup/status` · `/backup/code` | 【R38】备份状态（是否允许导入 + 已配置项数 / 备份范围）与当前**实时备份码**（是「当前配置内容」的纯函数：改了设置才变，没改就不变）。两条**均仅管理员**——实时码里含 API Key / 支付凭证 / WebDAV 口令的**明文** |
| POST | `/backup/export` | 【R38】导出配置：请求体 `{ password, backupPassword }`。`password` 是**当前账户口令**（权限验证，走 scrypt 校验 + 独立的导出限流器），`backupPassword` 是导出时**当场设置的独立备份密码**（用它把备份码密封，导入时必须原样输入）。回 `{ code, fingerprint, sections }`；账户口令错误回 403 |
| POST | `/backup/import` | 【R38】导入配置：请求体 `{ code, backupPassword }`。**仅当实例仍处于「首次初始化、尚未配置过任何可备份项」时才允许**，否则回 409。这条闸门**在解密之前**判定——在已配置实例上先解密再看结果，会把「备份密码对不对」从响应差异里泄成一条口令预言机。导入是**整批覆盖**语义（原有设置全部丢失） |
| PUT | `/buckets/local/:id/block-overseas` | 按桶开关海外 IP 屏蔽 |
| GET | `/smtp/config` · `PUT /smtp/config` | 【R53】发信设置（SMTP）读取 / 保存（**均仅管理员**）。读取回的是**安全视图**：`{ enabled, host, port, secure, user, from, fromName, hasPassword, configured, updatedAt }` —— **口令明文永不出服务端**，界面只能看到 `hasPassword` 布尔值。保存是 **PATCH 语义**：缺省字段保持原值；口令三态（`null` = 清除 / `''` 或省略 = 保持不变 / 其它 = 覆盖）。入参非法一律 **400 显式报错**，不静默改写。⚠️ `enabled` 是**系统自动发信**（验证码 / 重置密码）的总闸门：停用后这类邮件一律不发（`server/email-code.js` 的 `sendCodeMail()` 抛 503，文案写明是「**已停用**」而不是「未配置」）。它与 `configured` 回答的是**两个不同的问题** —— `configured` = 「配没配」，`enabled` = 「开没开」；停用**不会**让 `configured` 变假（否则卡片会显示成「未配置」，而配置其实还在） |
| POST | `/smtp/test` | 【R53】发送测试邮件（**仅管理员**）。请求体可带**尚未保存**的字段（按 PATCH 语义覆盖已保存配置后发信），`to` 留空 = 发给发件人自己。⚠️ **不受 `enabled` 开关限制** —— 它是管理员手动触发的一次性动作；若加以限制，管理员就必须「先开启、才能验证」，而开启之后配置若有误，所有依赖发信的功能都会一起受影响 |
| GET | `/site/info` | 【R54】公开的站点名称（**匿名可达**，已登记进 `index.js` 的匿名白名单 `PUBLIC_API`）：**只回** `{ ok, siteName }` 两个字段。登录页在**拿到会话之前**就要用它设置浏览器标题栏，故不能挂管理员守卫，也刻意不多回任何一个字段 |
| GET · PUT | `/site/config` | 【R54】站点设置读取 / 保存（**均仅管理员**）：`{ siteName, registration, defaultRole, notices, updatedAt }`。`registration` 为 `open`（可随意注册）/ `invite`（注册时必须填写邀请码）/ `closed`（不开放注册，需管理员添加用户），`defaultRole` 是新注册用户直接赋予的身份。保存是 **PATCH 语义**（缺省字段保持原值），`siteName` **留空即恢复默认站点名**；入参非法一律 **400 显式报错**，不静默改写。⚠️ **没有启用开关** —— 该功能默认开启。<br>【R68】`notices` 是**三页协议提示**（`login` / `register` / `share`，每页 `{ enabled, text }`）：`enabled` 只认布尔真值（字符串 `"false"` **不算开**）；`text` 是**单行**文案（含 `<a>` 也合法，**含换行即 400**，≤300 字），留空表示用内置的默认句。保存时**逐页逐字段合并** —— 只提交 `register` 一页不会把另外两页清掉；不认识的页名一律 400（否则拼错的 `loging` 会静默存进去、页面上什么也不会发生） |
| GET | `/site/agreements` | 【R68】公开的协议提示与正文（**匿名可达**，已登记进 `index.js` 的 `PUBLIC_API`）：回 `{ ok, show, notices, docs }`。`show[page]` 是**实际会不会显示**（开关打开 **且** 至少有一份正文写了，两件事都成立），不是开关本身 —— 前端拿它决定显隐，不必自己再算一遍；`notices[page]` 是渲染好的 HTML（不显示时为空串）；`docs` **只含这段文案真正引用到的**协议（三页全关时是空对象，一条正文都不跟着发出去）。⚠️ 与 `/site/info` 同一条纪律：匿名接口能少给就少给 |
| GET · PUT | `/agreements/config` | 【R68】协议设置读取 / 保存（**均仅管理员**）：`{ terms, privacy, updatedAt }`，两份协议正文的**源文本**（Markdown，各 ≤20000 字，**允许换行**，`\r\n` 一律归一成 `\n`）。保存是**严格 PATCH**：只写给出的那一份（`terms` / `privacy` 都不给即 400「请至少提交一份协议正文」），空串合法并**就是「清空这一份」的语义**（此时所有指向它的链接退化成纯文字）。⚠️ 长度判据落在**路由层**（非法一律 400）而不是落盘时静默截断 —— 截断会让管理员以为保存成功、实际只存进前半份 |
| POST | `/agreements/preview` | 【R68】把**尚未保存**的草稿渲染成 HTML（**仅管理员**），请求体 `{ terms?, privacy? }`，回 `{ ok, docs }`（与保存后完全同源，设置页只负责把 `docs.<key>.html` 塞进对话框）。⚠️ **不落盘**：预览过一次不会在 `config.enc` 里留下任何痕迹。⚠️ 刻意用 **POST** 而不是 GET：请求体是整份协议的草稿，塞进 URL 会被浏览器历史与反向代理的 access log 各记一份 |
| GET · PUT | `/restore/config` | 【R65】订单取回设置读取 / 保存（**均仅管理员**）：`{ maxUses, maxFails, updatedAt }`。`maxUses` = **每个订单号**最多可成功取回几次（1~100，默认 3）；`maxFails` = 同一 IP **连续**输错几次即封禁 24 小时（1~50，默认 5）。保存是 **PATCH 语义**（缺省字段保持原值），入参非法一律 **400 显式报错**，不静默改写。⚠️ **没有启用开关** —— 该功能默认持久化生效，与站点设置同理。<br>⚠️ 两个计数落在**不同对象**上：取回次数落在**订单**（`order.restoreCount`，在 `claimForLink()` 内自增，避免并发双花；订单号不存在 / 不属于本链接 / 未支付 / 已用尽一律**不消耗**配额）；输错次数落在**IP**，成功一次即清零（「连续」语义）。封禁只由分享页的两条取回端点显式判定，**不挂全局中间件** |
| GET | `/invites` | 【R54③】邀请码列表（**仅管理员**）。**原样回传邀请码明文** —— 管理员正是要把它复制分发的人，打码会让这个页面失去意义；代价是这条接口的守卫强度必须与「用户管理」同级（少挂一个 `requireAdmin` 就等于给任何登录用户一条批量读取免注册口令的通道） |
| POST | `/invites` | 【R54③】批量生成邀请码（**仅管理员**，一次最多 500 枚）。请求体 `{ count, role?, maxUses?, expiresAt?, note? }`：`role` 缺省取站点设置的「新用户身份」，`maxUses` 为 `0` 表示不限制，`expiresAt` 为 `null` 表示永久有效。⚠️ 身份是**生成时快照**进记录的 —— 事后改站点设置不会改变已经发出去的码（要做到那一点请用 `/invites/bulk` 批量改身份） |
| PUT · POST | `/invites/:id` · `/invites/bulk` | 【R54③】修改单个邀请码 / **批量设置**（**均仅管理员**；`/invites/bulk` 用请求体 `{ ids, role?, maxUses?, expiresAt?, note?, disabled?, resetUsed? }`）。两者共用同一套字段判据、都是 **PATCH 语义**（只改出现过的字段）。⚠️ `disabled: false`（重新启用）/ `maxUses: 0`（改为不限制）/ `expiresAt: null`（改为永久）**全是合法值**，故判据一律是「该字段是否出现」而不是真值 —— 用真值判断会让这三个动作**静默失效**而界面显示成功 |
| POST | `/invites/delete` | 【R54③】**批量删除**（**仅管理员**，请求体 `{ ids }`）。走请求体而不是逐条 `DELETE /invites/:id`：这个页面最主要的动作就是「把这一批没用完的码删掉」，逐条发请求在 500 条时是 500 次往返，且中途失败会留下半截状态 |
| POST | `/invites/export` | 【R54③】**导出为纯文本（一行一个）**（**仅管理员**，请求体 `{ ids? }`，不给 `ids` 即全部）。响应体就是纯文本本身（不包 JSON）、**末尾带换行**（否则 `while read` 一类的逐行消费会丢掉最后一行）、无 BOM。⚠️ **刻意是 POST 而不是 GET**：响应里是明文邀请码集合，GET 会把整批口令写进浏览器历史与反向代理的 access log；POST 还天然要求 `X-Requested-With`（CSRF 校验）。代价是前端不能靠 `<a href>` 下载，必须拿到文本再自己造 Blob |
| GET | `/coupons` | 【R62】优惠券列表（**仅管理员**）。**原样回传券码明文** —— 管理员要把它复制分发。每条附带服务端算好的 `status`（`active` / `not_started` / `expired` / `used_up` / `disabled`）与核销台账。 |
| POST | `/coupons` | 【R62】生成优惠券（**仅管理员**，一次最多 200 张；`count` 填 1 即「单独生成」）。请求体 `{ count, type, linkIds?, userIds?, amount, minSpend?, maxUses?, perUserOnce?, startAt?, expireAt?, note? }`：`type` ∈ `any`（无门槛）/ `links`（限特定链接）/ `users`（限特定用户），后两者必须给出非空目标集合；`amount` 以**元**为单位，落盘转整数「分」；`maxUses` 的 `0` = 不限制。【R88】`minSpend`（元）是**使用门槛**（「满 xx 减 xx」的 xx），留空或填 `0` = 无门槛的直减券；它与 `type` **正交**（可同时限制适用范围与门槛），比较的是分享链接的**原价**，不足时该券对本单不可用。 |
| PUT · POST | `/coupons/:id` · `/coupons/bulk` | 【R62】修改单张 / **批量设置**（**均仅管理员**；`/coupons/bulk` 用请求体 `{ ids, disabled?, maxUses?, amount?, minSpend?, startAt?, expireAt?, note? }`）。**PATCH 语义**：`disabled: false`（重新启用）、`maxUses: 0`（改为不限制）、`expireAt: null`（改为永久）都是合法值，故判据是「字段是否出现」而不是真值。【R88】`minSpend: 0` 同属这一类 —— 它是「把满减券改回无门槛」这个动作，用真值判断会让它静默失效。 |
| POST | `/coupons/delete` | 【R62】**批量删除**（**仅管理员**，请求体 `{ ids }`）。删除后券码立即失效；已支付订单不受影响（订单里快照了券码与优惠金额）。 |
| GET | `/webdav` · `PUT /webdav/enabled` | 服务状态 / 总开关 |
| POST | `/webdav/accounts` | 新增账户 |
| PUT | `/webdav/accounts/:id` · `DELETE /webdav/accounts/:id` | 修改 / 删除账户 |
| GET | `/webdav/accounts/:id/password` | **回传明文口令**（管理员）。Basic 认证要求服务端能还原原文，口令只能可恢复加密存储——这是设计取舍而非疏漏，见「设计背景与刻意取舍 → WebDAV 口令为可恢复加密」 |
| GET/PUT | `/upload-excludes` | 上传排除规则 |
| GET | `/stats/storage` · `/stats/summary` · `/stats/speed` · `/stats/logs` | 用量 / 汇总 / 速度 / 操作日志 |

**关于退款功能的详解**：

本系统不代持资金，因此无法真正通过本系统退款。此处的退款功能仅作标记之用，真实退款操作仍需用户在支付平台真正为其返还钱款，然后再在本系统标记为“退款”。退款完毕后，下载者将失去下载权限。

该功能仅对支付状态为“已支付”的订单生效。

1. 服务端（`payment-orders.js`）的 refunded 终态与 `markRefunded()`（仅 paid 可转、幂等），记录 `refundedAt`，已使用三条硬约束：

① 不可逆：`markPaid` / `markFailed` / `finalizeOrder()` 三处都显式拒绝改写 —— 付款记录确实存在，网关查单仍会应答"已支付"，若只阻挡一处则会被异步通知复活，导致退款仍可下载；

② 凭证失效：`payerState` 返回 `refunded`（仍可查单得知该用户已付款），下载放行恒为白名单判定 === 'paid'；

③ 永不裁剪：退款订单纳入 `prune` 的保留集合，否则日后无法证明该订单是否确实有成功付款记录。

2. 路由 `POST /api/payment/orders/:id/refund`（`requireAdmin` + 审计）。不发起任何网关退款调用 —— 本系统不代持资金，退款在渠道后台完成，只作记账。
3. 前端（`ordermgr.js`）：确认后订单整行划线失效、状态徽章显示「已退款」、该笔金额从「已收」扣除并单列「已退款」。统计与列渲染抽成 `computeTotals / fmtActions / rowClassOf` 三个纯函数，测试可直接驱动。

**请求 / 响应样例**（分享链接列表；普通用户只返回自己创建的）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/links
```

```json
{
  "links": [
    {
      "id": "s_9c1e4b7a",
      "key": "photos/2026/shanghai.jpg",
      "bucket": "my-bucket-1250000000",
      "region": "ap-guangzhou",
      "fileName": "shanghai.jpg",
      "size": 248192,
      "createdAt": "2026-09-12T08:24:05.000Z",
      "createdBy": "admin",
      "expiresAt": "2026-09-19T08:24:05.000Z",
      "maxDownloads": 0,
      "downloads": 3,
      "lastDownloadAt": "2026-09-13T01:02:03.000Z",
      "hasPassword": false,
      "missingAt": null,
      "missing": false,
      "paid": { "required": true, "amountFen": 500, "currency": "CNY" }
    }
  ]
}
```

**请求体 · `POST /api/links`**（`PUT /api/links/:id` 复用同一套校验，另多一个 `resetCount`）：

| 字段 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `path` | string | ✔ | **字段名是 `path`，不是 `key`**。必须指向文件——以 `/` 结尾（目录）一律 400「不支持分享文件夹」 |
| `expiresHours` | number / null | ✘ | 缺省 **168**（7 天）。`0` / `null` / `''` 表示**永久有效**；否则须为正数，上限 `24 × 3650`（10 年） |
| `maxDownloads` | integer | ✘ | 缺省 `0` = 不限制。须为 ≥ 0 的整数，上限 1e9 |
| `password` | string / null | ✘ | 缺省 `null`。长度 1–64 字符；传 `null` / `''` 表示不启用或**清除**已有密码 |
| `paid` | object / null | ✘ | `null` = 关闭付费下载。否则为 `{ required, amount }`——**`amount` 单位是「元」**，与响应里的 `amountFen`（分）不同。`required: true` 而金额 ≤ 0 → 400；`required: false` 时金额**仍会保留**，便于下次直接打开开关 |
| `resetCount` | boolean | ✘ | 仅 `PUT` 有效：是否把已下载次数清零。非布尔值 → 400 |


```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/links \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"path":"photos/2026/shanghai.jpg","expiresHours":72,"maxDownloads":5,"password":"s3cret","paid":{"required":true,"amount":5}}'
```

```json
{ "ok": true, "id": "s_9c1e4b7a", "key": "photos/2026/shanghai.jpg", "fileName": "shanghai.jpg", "size": 248192,
  "expiresAt": "2026-09-15T12:00:00.000Z", "maxDownloads": 5, "downloads": 0, "hasPassword": true,
  "paid": { "required": true, "amountFen": 500, "currency": "CNY" }, "warn": "" }
```

- `bucket` / `region` / `createdBy` **不来自请求体**：服务端按当前会话的桶上下文与用户名快照，客户端无法指定。
- 目标对象不存在或无权访问 → `404`（创建前会先 `headObject`）。
- `warn` 是**提示不是错误**：支付功能停用、或没有可用渠道时，付费配置依然保存，只是该链接暂时按免费下载处理——付费开关是系统状态，分享者意图不应被它冲掉。

**请求 / 响应样例**（订单列表，管理员）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/payment/orders
```

```json
{
  "orders": [
    {
      "id": "po_1d3f5a",
      "linkId": "s_9c1e4b7a",
      "platform": "alipay",
      "amountFen": 500,
      "currency": "CNY",
      "status": "paid",
      "createdAt": "2026-09-13T01:00:00.000Z",
      "paidAt": "2026-09-13T01:01:12.000Z",
      "refundedAt": null,
      "downloadedAt": null,
      "fileName": "shanghai.jpg",
      "tradeNo": "2026091322001...",
      "failReason": "",
      "fileKey": "photos/2026/shanghai.jpg",
      "linkExists": true,
      "linkUrl": "/s/s_9c1e4b7a",
      "platformName": "支付宝"
    }
  ]
}
```

**请求 / 响应样例**（标记退款；仅 `status: "paid"` 可转，其余状态 400）：

```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/payment/orders/po_1d3f5a/refund \
  -H 'X-Requested-With: XMLHttpRequest'
```

```json
{
  "ok": true,
  "order": {
    "id": "po_1d3f5a", "linkId": "s_9c1e4b7a", "platform": "alipay",
    "amountFen": 500, "currency": "CNY", "status": "refunded",
    "createdAt": "2026-09-13T01:00:00.000Z", "paidAt": "2026-09-13T01:01:12.000Z",
    "refundedAt": "2026-09-14T09:30:00.000Z", "downloadedAt": null,
    "fileName": "shanghai.jpg", "tradeNo": "2026091322001...", "failReason": ""
  }
}
```

- `404` 订单不存在 → `{ "error": "订单不存在" }`
- `400` 重复退款 → `{ "error": "该订单已标记为已退款" }`
- `400` 未支付成功 → `{ "error": "该订单未支付成功，无需退款" }`
- `400` 尚未支付 → `{ "error": "该订单尚未完成支付，无法退款" }`

<h2 id="develop_document-section26">8. 支付设置</h2>

系统设置页内的「支付设置」卡片用于登记各支付平台的 API 凭证与站点地址。凭证部分只做**必填与格式校验**（不代持资金、不做联机验证）；下单与查单由 `server/payment-gateway.js` 直连各平台官方接口完成。

<h3 id="develop_document-section27">8.1 主要校验规则</h3>

| 平台 | 字段 | 规则 |
| --- | --- | --- |
| 支付宝 | 应用 ID `app_id` | 16 ~ 32 位纯数字 |
| 支付宝 | 应用私钥 / 支付宝公钥 `private_key` · `alipay_public_key` | PEM（`-----BEGIN … PRIVATE/PUBLIC KEY-----` 成对）或足够长的 Base64 密钥体 |
| 支付宝 | 签名算法 `sign_type` | `RSA2` / `RSA`（**SM2 在保存时即被拒绝**：本系统只有 RSA 签名实现，选 SM2 产不出可用签名。该选项仍列在下拉里并置灰，附原因 —— 用户要求 1.9.17 起不再「保存能过、点『立即支付』才失败」） |
| 支付宝 | 网关 `gateway` | 必须 `https://`（默认生产网关，沙箱可换 `openapi-sandbox.dl.alipaydev.com`） |
| 支付宝 | 证书序列号 `app_cert_sn` · `alipay_root_cert_sn` | 选填，仅「公钥证书」加签模式需要 |
| 微信支付 | 商户号 `mchid` | 10 位纯数字 |
| 微信支付 | 应用 ID `appid` | `wx` 前缀 + 16 位字母数字，需已绑定至该商户号 |
| 微信支付 | APIv3 密钥 `api_v3_key` | 32 位字母数字；用于解密平台回调资源与下载平台证书 |
| 微信支付 | 商户证书序列号 `serial_no` | 40 位十六进制；仅用于让平台定位验签用的公钥 |
| 微信支付 | 商户 API 私钥 `private_key` | PKCS#8 PEM（`apiclient_key.pem` 的内容）。**必填**：APIv3 下单的 `Authorization` 为 `WECHATPAY2-SHA256-RSA2048`，必须用该私钥做 SHA256-RSA 签名；`api_v3_key` 只负责解密，**不能代替它** |
| 微信支付 | 子商户号 / 子应用 ID `sub_mchid` · `sub_appid` | 选填，仅服务商 / 渠道商模式需要 |
| 云闪付 | 商户号 `merId` | 15 位纯数字（与订单号、订单发送时间一起唯一确定一笔银联交易） |
| 云闪付 | 商户签名私钥 | PEM（必须**真的能解析成 RSA 私钥**）。入网下发的是 `.pfx` / `.p12`，需先 `openssl pkcs12 -in acp.pfx -nocerts -nodes` 导出成 PEM —— 本系统全链路只认 PEM，与另外三家共用同一套签名实现 |
| 云闪付 | 银联验签公钥 | PEM（RSA），用于校验**查单响应与后台通知**的签名。填错（例如填成自己的公钥）会让每一次查单都被判「签名校验失败」 |
| 云闪付 | 证书 ID `certId` | 选填，签名私钥证书的 Serial Number；部分入网协议要求在请求报文里上送，不确定就留空 |
| 云闪付 | 签名方法 `signMethod` | `01`（RSA + SHA1，缺省）/ `11`（RSA + SHA256）。⚠️ 不是「随便选一个都行」：必须与入网约定一致，否则银联验签必失败。SM3 不在本系统的实现范围内 |
| 云闪付 | 网关 `gateway` | 必须 `https://`（默认 `https://gateway.95516.com/gateway/api/frontTransReq.do`，联调可换银联给的测试网关） |
| PayPal | Client ID / Client Secret | 20 ~ 128 位，可含 `-` `_` |
| PayPal | 运行环境 `mode` | `sandbox` / `live` |

<h3 id="develop_document-section28">8.2 开关层级</h3>

| 层级 | 字段 | 说明 |
| --- | --- | --- |
| 总开关 | `config.payment.enabled` | 卡片右上角「启用 / 停用」。**停用后所有付费链接自动转为免费下载** |
| 渠道开关 | `config.payment.platforms[id].enabled` | 每家平台独立开关，可任意组合 |
| 约束 | — | 总开关为**启用**时，至少保留一个渠道开启；关闭最后一个会被拒绝（400）并提示先停用支付功能 |

三态区分（界面与接口均体现）：`enabled`（开关打开）→ `configured`（凭证填完）→ `available`（= 两者皆真，下载者才可选它付款）。渠道开启但凭证未填完时状态为**待补全**，不参与可收款渠道列表。

<h3 id="develop_document-section29">8.3 接口</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/payment/config` | 总开关 + 三家平台表单定义 + 已保存配置 + 可用渠道（敏感字段仅回传是否已配置） |
| `PUT` | `/api/payment/enabled` | 总开关；无任何渠道开启时拒绝启用 |
| `PUT` | `/api/payment/site-url` | 站点地址（回跳 / 回调基准），必须以 `http(s)://` 开头 |
| `GET` | `/api/payment/orders` | 订单列表（含文件名、链接、商户单号、付款时间、是否已下载） |
| `PUT` | `/api/payment/config/:platform/enabled` | 渠道开关；关闭最后一个时拒绝 |
| `POST` | `/api/payment/config/:platform/validate` | 仅校验不落盘；敏感字段留空时沿用已保存值参与校验 |
| `PUT` | `/api/payment/config/:platform` | 校验通过才保存（首次填写默认开启该渠道）；全空提交 = 清空 |
| `DELETE` | `/api/payment/config/:platform` | 清除该平台凭证（连带关闭渠道，同样受约束校验） |
| `POST` | `/api/payment/orders/:id/refund` | 将订单标记为**已退款**（仅「已支付」订单可操作；本系统不代持资金，不发起任何网关退款调用） |
| `DELETE` | `/api/payment/orders/failed` | **批量删除「支付失败」的订单**（对应卡片上的「删除失效订单」按钮）；只清失败流水 —— 「已支付」「已退款」是钱流动过的对账凭据，「支付中」的订单也不删 |

> 十条接口全部挂载 `requireAdmin`；该卡片列入 `ADMIN_ONLY_CARDS`，普通用户整卡不可见且不发请求。凭证随系统配置一同以 AES-256-GCM 加密保存于 `data/config.enc`。

<h3 id="develop_document-section30">8.4 支付状态机</h3>

```
（访问链接）→ 未支付 ──选渠道发起──→ 支付中 ──成功──→ 已支付 ──管理员标记退款──→ 已退款（凭证失效）
                                       └──失败──→ 支付失败 ─┘（可重新发起）
```

| 状态 | 下载 | 下载者看到的提示 |
| --- | --- | --- |
| 未支付 | ❌ 402 | 需要付费后才能下载（展示金额与可选渠道） |
| 支付中 | ❌ 402 | 支付尚未完成，请完成支付后再试 |
| 支付失败 | ❌ 402 | 上一次支付未成功：具体原因（可重新发起） |
| 已支付 | ✅ | 信息页显示已支付，直接下载 |
| 已退款 | ❌ 402 | 订单已退款，原支付凭证已失效（可重新支付） |

> 下载放行是**白名单判定**（`payerState(...) === 'paid'` 才放行），而不是"只要不是未支付就放行"的黑名单 —— 后者在新增状态时会被默认放行，退款后仍能下载等于下载者可免费获取文件。

<h3 id="develop_document-section31">8.5 各状态切换的字段变化、校验与异常处理</h3>

| 切换 | 字段变化 | 校验规则 | 异常场景 |
| --- | --- | --- | --- |
| 设置付费（创建 / 编辑链接） | `link.paid = { required, amountFen, currency }`，金额以**分**为整数存储 | 勾选即要求金额 ≥ 0.01 元；上限 100000 元；浮点金额一律四舍五入到分；**币种恒为 `CNY`** | 未填金额 → 400；金额低于 0.01 → 400；支付停用或无可用渠道时**仍允许保存**，返回 `warn` 由界面提示「配置已保存，但暂时按免费处理」 |
| 取消勾选付费 | `required=false`，**金额原样保留** | — | 重新勾选时金额仍在，无需重填 |
| 停用总开关 | 只改 `payment.enabled`，**不动任何链接** | 停用永远允许 | 付费链接自动转免费；下载页展示「分享者已停用支付功能，当前可免费下载」 |
| 重新启用总开关 | 只改 `payment.enabled` | 至少一个渠道开启，否则 400 | 付费逻辑按原配置恢复，金额与停用前一致（读取时计算，无需数据迁移） |
| 关闭某渠道 | 只改该渠道 `enabled` | 总开关启用时不允许关闭最后一个 | 若因此没有可用渠道，付费链接转免费并提示「尚未配置可用支付渠道」 |
| 发起支付 | 新建订单 `status=pending`，金额**快照**进订单 | 渠道必须在可用列表内；同 IP 同链接限流 | 渠道非法 → 回付费页并提示重新选择；操作过频 → 提示等待 |
| 支付成功 | `status=paid` + `paidAt` | — | 已支付订单**不允许**被后续失败回调改判 |
| 支付失败 | `status=failed` + `failReason` | — | 可发起新订单重试；旧失败订单不再作为凭证 |
| 标记为已退款 | `status=refunded` + `refundedAt` | 仅「已支付」订单可标记；管理员操作，走二次确认 | 不可逆：`markPaid` / `markFailed` 一律拒绝改写；重复标记保持幂等（第二次返回 400） |
| 分享者改价 | 只改 `link.paid.amountFen` | 同上金额规则 | **已支付订单仍有效**（按支付时的金额快照）；新订单按新价 |

> **币种语义**：`currency` 恒为 `CNY`——它是 `payment-rules.js` 中的常量，写入分享链接时由 `normalisePaid` 强制归一，接口不接受其他取值。PayPal 本身支持多币种，但本系统不开放：各币种的最小单位并不相同（JPY 无小数位、KWD 为三位小数），「以分为整数」这一金额语义只对人民币成立，放开币种等于引入一整类舍入错误。

<h3 id="develop_document-section32">8.6 已支付凭证</h3>

支付成功后下发 Cookie 票据 `订单ID.HMAC(linkId:orderId)`，`httpOnly` + `SameSite=Lax`。签名输入同时绑定链接与订单，因此票据**无法跨链接复用**、也无法伪造；下载端只认 `status === 'paid'` 的订单。

标记为已退款后，票据依然能被识别（`payerState` 返回 `refunded` 而非 `none`）——这让下载者看到「这笔已退款，请重新支付」而不是「请付费下载」，但**不产生任何放行效果**；退款订单同样纳入「永不裁剪」集合，否则日后无从证明这笔钱退过。

<h3 id="develop_document-section33">8.7 订单退款（人工记账）</h3>

**本系统不代持资金**——下载者付的钱从未经过这台服务器，退款是在支付宝 / 微信支付 / PayPal 的商户后台手动完成的。因此退款功能**不发起、也不可能有**任何网关退款调用，它只做三件事：

1. 把订单状态置为 `refunded` 并记下 `refundedAt`；
2. 让该订单的支付凭证立即失效（下载者需重新支付才能下载）；
3. 让这笔金额从管理页的「已收」小计中扣除，并单列进「已退款」。

| 约束 | 说明 |
| --- | --- |
| 仅管理员 | 接口挂 `requireAdmin`（普通用户 403），不依赖前端隐藏按钮 |
| 仅「已支付」订单 | 支付中 / 失败 / 已退款一律返回 400 并给出可读原因（未收款谈不上退款） |
| 二次确认 | 界面弹出危险确认框，明确「因本系统不代持资金，标记退款仅代表已在其它渠道退还钱款，本系统仅作记账和标记」 |
| 不可逆 | `markPaid` / `markFailed` 都显式拒绝改写已退款订单；网关查单仍会回答「已支付」，照它办理等于把钱退了还能下载 |
| 幂等 | 重复标记不改变状态（接口层在第二次返回 400，storage 层保持 `refunded`） |

> **为什么不做真退款**：真退款需要商户私钥去调用网关的退款接口，并要求处理异步退款通知、部分退款、退款失败重试与手续费退还。本系统的定位是「托管下载 + 记账」，引入这些等于引入一条全新的资金流链路和相应的一致性责任；相比之下，人工在商户后台退款 + 在此处打标记，语义更诚实：系统不会假装自己经手了钱。

<h3 id="develop_document-section34">8.8 真实支付网关</h3>

`server/payment-gateway.js` 直连四家平台的官方接口，**零新增依赖**（RSA-SHA256 签名、AES-256-GCM 解密、HTTP 调用全部基于 Node 内置模块）：

| 平台 | 下单方式 | 下载者体验 | 结果确认 |
| --- | --- | --- | --- |
| 支付宝 | `alipay.trade.page.pay`（RSA2 签名后跳转收银台） | 跳转到支付宝页面付款，付完自动回跳 | `alipay.trade.query` |
| 微信支付 | Native 下单（APIv3，`Authorization` 五段式签名） | 页面展示二维码，用微信扫码付款 | 按 `out_trade_no` 查单 |
| PayPal | Orders v2 创建订单后跳转 `approve` 链接 | 跳转 PayPal 审批页，付完自动回跳 | 查询订单，`APPROVED` 时补一次 capture |

微信 Native 的二维码由 `server/qrcode.js` 自行生成（字节模式、纠错等级 M、版本 1–10、按 ISO/IEC 18004 计算纠错码字与掩码惩罚分，输出内联 SVG），不引入二维码库；`tests/qrcode.test.js` 按标准逐项校验。

<h3 id="develop_document-section35">8.9 支付结果确认（服务端查单）</h3>

规则同「设计背景与刻意取舍 → [支付结果仅限服务端查单返回](#develop_document-section10)」（**权威定义，此处不重复**）。支付侧的两个具体落点：

- **三个触发点**：同步回跳 `/s/:id/pay/return`、前端轮询 `/s/:id/pay/check`、异步通知 `POST /pay/notify/:platform`。三者都只负责**触发一次查单**，成功与否一律以查单结果为准。
- **两处限流**：轮询最小间隔 3 秒，且查单接口本身挂限流器。该端点匿名可达，且会携带真实商户凭据向平台查单——缺少限流时任何人扫到回调地址即可反复触发查单、刷光平台的查单配额。

**新增一家支付平台的步骤**：① 在 `server/payment-providers.js` 定义 `fields`（含 `official` 官方字段名、`pattern` / `validator` / `secret` 标记、`maxLength`）；② 需要联机校验时用 `registerValidator(platformId, fn)` 登记，路由与前端无需改动；③ 在 `server/payment-gateway.js` 实现 `createCharge` / `queryCharge`——**查单必须 fail-closed**（异常即视为未支付，不放行）；④ 前端 `paysettings.js` 的表单由服务端下发的同一份字段定义渲染，通常无需改动，只需在 `server/payment-logos.js` 的 `SHAPES` 表追加图形（前台与后台同时生效 —— 前端不再持有图形副本）。

<h2 id="develop_document-section36">9. 搜索</h2>

搜索的**正确性**已经完整（逐页扫描 + 游标续扫、不重不漏、客户端断开即停止翻页），本节只讨论**性能**：还有哪些社区建议没有采纳，以及为什么。

先纠正一个流传的误解。曾有一种说法是「搜索慢是因为本项目有 15 个写入口，任何一个没登记就会永久不一致」，据此认为「强一致的本地元数据索引」不可行。**这个前提与代码事实不符**：

- 云端调用早已收口到 `s3.js` 里的唯一出口 `p()` —— 全库所有对象的读 / 写 / 列举 / 分片 / 复制都要经过它。因此「新增一个写入口就要在旁边补一次缓存失效」这种**登记成本在结构上并不存在**：按「最终发出**写**方法的 `p()` 调用点」实测为 **26 处、分布在 7 个文件**（连同只读调用一起算则是 57 处 / 12 个文件）。
- 判据与代码同源、不需要人来维护：`list-cache.js` 用**只读白名单**判定，只读方法之外的**未知方法一律按写处理**（宁可多失效），所以新增任何云端调用都自动进失效链，无需回来登记。
- `p()` 在**成功与失败两条分支**上都会把该次调用播报给 `list-cache.js`，后者对外只有一个通知点；候选集缓存只订阅这一个点，接线**仅 1 处**，且不必逐个接口登记。

据此，本项目把原先设想的「强一致本地索引」**降级为带 TTL 的候选集缓存**（`server/search-candidates.js`：默认 TTL 10 秒、单条上限 1 万键，越限即整条丢弃并退回逐页列举）。它只回答「这些键上次确实存在」，**允许过期、靠 TTL 自愈**，任何时候都不充当「桶里有什么」的判据。一旦接受最终一致，「漏一处写入口即永久不一致」这个否决理由就自动失效 —— 这正是采纳它的原因。

仍未优化 / 未实现的内容如下：

| 社区建议方案 | 未实现原因 |
| --- | --- |
| **前端结果缓存** | 浏览器无法感知他人（或 WebDAV、分享页）的写入，会比服务端缓存多出一个不一致面。而服务端缓存已覆盖同一场景。 |
| **并行/预取分页** | 对象存储列举只能顺序翻页，服务端仍是串行，提前预取下一页只能省下每页约几毫秒的本地过滤时间。 |
| **关键词下推为** **`Prefix`** | 语义不等价： `Prefix` 只能做前缀匹配，导致结果不完全/不可信。 |
| **调大单页上限** | 已是 S3 API 硬上限 1000。 |

候选集缓存也**消除不掉**的两条物理限制如下。它们不是「还没做」，而是做不掉：

- **站外写入不可感知**：别人绕过本系统（直接在控制台操作、或经其他工具写桶）时，本进程收不到任何信号，只能等 TTL 到期。这与「缓存多久」无关，是分布式系统的固有代价 —— 影响范围只是「最多陈旧一个 TTL」。
- **首轮必须真扫一遍**：候选集只能让**后续**搜索免费；第一次搜索（或 TTL 过期后）仍要按页翻完整个前缀。若单桶对象数到 10 万量级，首扫延迟会变得显眼 —— 此时正确的做法是**后台扫描作业**（定时物化候选集），而不是继续加长 TTL。

<h2 id="develop_document-section37">10. 性能与可靠性</h2>

- **异步 I/O**：日志内存缓冲（50 条或 2 秒）批量落盘；配置、加密元数据、分享链接、上传会话、统计均异步 / 串行写入，避免阻塞事件循环。
- **缓存与并发**：解密配置 60 秒 TTL 缓存；多桶统计并发上限 3，腾讯云优先调用官方 `?stats`、失败回退对象列举（S3 厂商直接走列举估算），容量结果缓存 15 分钟。
- **高效匹配**：国内 IP 段（6000+）预排序 + 二分查找；搜索无筛选条件时降低扫描量，结果超限给出提示。
- **传输优化**：`/api` JSON 响应与静态文本资源（`.html/.js/.css/.svg/.json/.webmanifest` 等）启用 gzip——实测 `main.js` 体积降约 71%、`style.css` 降约 77%（**测量口径**：`zlib.gzipSync` 默认压缩级别，样本为当时的仓库产物；压缩比随文件内容浮动，请按「量级」而非绝对值理解，复现时以你手上的文件为准）；流式下载 / 缩略图 / 测速接口与已压缩二进制（`.png/.woff2/.mp4` 等）自动跳过，避免大文件缓冲进内存；JS / CSS 静态资源 5 分钟强缓存（HTML no-cache）；下载以 `stream.pipeline` 传递背压并设无活动超时；WebDAV **读取**支持 HTTP Range 断点续传（写入侧为全量缓冲，见「技术限制与已知局限」）。

---

<h1 id="develop_document-section38">三、核心模块实现</h1>

<h2 id="develop_document-section39">1. 文件加密与元数据</h2>


<h3 id="develop_document-section40">1.1 三种方式与密文结构</h3>

`server/enc-store.js` 提供三种模式，密文结构互不相同：

| 模式 | 密文结构 | 与原文长度关系 |
| --- | --- | --- |
| crypto | `[魔数 COSCENC01(10B)][段1: IV(12B) ‖ 密文 ‖ TAG(16B)][段2 …]` | 大于原文 |
| magic | `[用户魔数(M B)][异或(原文[M:])]`（被覆写的原始文件头存入本地元数据） | 与原文等长 |
| none | 不加密 | — |

- crypto 的段与分片一一对应：直传即单段，分片上传则每个分片一个独立段，因此断点续传与进程重启后继续都不必重建加密上下文。
- magic 的密钥流是**纯位置函数**：块 i = `SHA256(主密钥 ‖ 盐 ‖ u32be(i))`，不依赖会话状态，任意偏移均可独立解密。实现上按 32 位字批量异或，并逐块生成、就地消耗，避免一次性分配与明文等长的缓冲。
- 魔数输入支持十六进制（`0x` 前缀）与 UTF-8 文本，长度 1–64 字节；随机盐恒开。

> 魔数模式属于混淆级保护，非强加密，建议仅用于防止 IDC 服务商审核。若涉及隐私或敏感数据请务必选择 crypto 模式。

<h3 id="develop_document-section41">1.2 元数据是解密的唯一凭据</h3>

解密参数（IV / TAG / 盐 / 原始文件头 / 原始大小）保存在 `data/enc-meta.json`，按 `<bucket>|<key>` 索引。该文件是 crypto 与 magic 两种模式解密的**唯一**凭据来源，因此围绕它有一组硬性约束：

- 读取失败时以空表继续运行以保证服务可用，同时置「损坏」标记并**拒绝写入**，磁盘原件另存为 `.corrupt-<时间戳>` 备份等待人工恢复——绝不用空表覆盖。
- 密文一旦安全落云，立即把解密凭据同步落盘，将「云端已有密文、本地尚无元数据」的窗口压到零；上传完成等关键节点与进程退出钩子各兜一次。
- 重命名 / 移动 / 复制时同步迁移元数据；只有**云端确认删除成功**的对象才清理其元数据。按前缀无条件清空的接口已从代码中移除：它与「列举被截断」组合时会只删掉前 N 个对象却清空整个前缀的元数据，残留密文永久不可解。

<h3 id="develop_document-section42">1.3 分片路径与完整性校验</h3>

分片加密状态随上传会话持久化，magic 模式的盐与原始文件头在首次加密时即固定，进程重启后续传仍保持一致。

magic 属混淆级保护，本身没有认证标签：密文一旦被篡改或损毁，旧实现会静默产出看似正常但内容错误的明文。现改为在元数据中记录明文摘要、并在解密流末尾校验：

- 直传记录整文 SHA-256；分片路径在分片**连续且按序**到齐时给出逐片摘要，解密时在确定性边界上逐段校验；任一分片缺失则不声称可校验（回退旧行为）。
- 摘要按**还原后的完整明文**分段，而密文体偏移不含被魔数覆写的头部，故解密侧需维护独立的明文游标；跨分段边界的缓冲区必须按边界切分后分别累加，否则正常文件会被误判为篡改。
- crypto 模式为**每段独立**的 GCM 认证：段内任何字节被篡改，都会在该段 `decipher.final()` 处报错；密文被**截断**时，末尾的分段状态机走不完，`flush` 直接判为「数据不完整」——也就是说「尾部少一段 / 少几个字节」是可以检出的。
- 但**逐段 GCM 只认证单段**：AAD 为空，段序号与对象身份都没有被绑定进认证。因此把两个**等长**段的 `IV ‖ 密文 ‖ TAG` 整块互换、或把同一密钥下另一个对象的段拼进来，每段自身依然能通过认证——解出的是顺序错误或来源错误的明文，且无从察觉。这是**已知局限**：补 AAD 需要版本号与迁移路径（老密文没有 AAD，直接改会让历史对象全部解不开），因此暂未引入。

<h3 id="develop_document-section43">1.4 查看密码与访问令牌</h3>

查看密码是可选的访问控制层，与加密密钥相互独立（以 scrypt 哈希存储，忘记可重置）。校验通过后签发 30 分钟有效的 HMAC 令牌：**管理端 `/api/**` 只从 `x-enc-token` 请求头读取**（不进入 URL、浏览器历史、Referer 与访问日志），**分享页 `/s/…` 另发一枚 `HttpOnly`、`path=/s/` 的 Cookie** 供解锁后复用（该 Cookie 不进入 `/api/**`）。

R22-04：本库「解密下发」共三个出口 —— 管理端 `/api/fs/download`、分享页 `/s/:id/dl`、WebDAV 挂载 `/dav`。**查看密码只覆盖前两个**；**WebDAV 出口不叠加这道门禁**，它由独立的 Basic 认证与 IP 守卫把关，凭据须由管理员在配置中授予（非自助注册）。该归属此前未在文档中声明，是「同一控制在不同出口结论不同」的根因，现予明确。

口令校验入口一律使用异步 scrypt：该类入口攻击者可达，同步版本会占满单线程事件循环，数十个并发请求即可让全站失去响应。

<h3 id="develop_document-section44">1.5 孤儿元数据巡检</h3>

对象被本系统之外的工具删除，或云端操作成功而本地元数据写入失败，都会留下指向已不存在对象的元数据。孤儿记录本身只造成无谓膨胀，但元数据丢失意味着密文永久不可解，二者方向相反、不可简单取舍。因此提供巡检接口：列出某桶下「本地有元数据、云端已无对应对象」的候选，**交由调用方决定是否清理**，巡检过程本身不删除任何记录。

<h2 id="develop_document-section45">2. 统一文件网关</h2>

<h3 id="develop_document-section46">2.1 收口的理由</h3>

`server/fs-gateway.js` 是全部对象读写删操作的唯一入口，管理端路由与 WebDAV 共用。收口之前 WebDAV 直连 SDK，会产生四类问题：写入未加密、读取直接下发密文（用户编辑回写即永久损坏）、删除 / 复制 / 移动不联动元数据、全链路无审计日志。

网关行为随加密模式自动切换：不加密时走直通路径，行为与未启用加密完全一致；加密时写操作自动加密后上传，读操作挂载解密流透明还原，删除与复制移动同步联动元数据并记录审计。

<h3 id="develop_document-section47">2.2 读取路径：信号量与范围请求</h3>

- 加密读取受信号量限流（并发上限 3），避免多路大文件同时解密造成内存线性增长。释放器必须幂等且带下界保护：可销毁流在带错误销毁时会先 `error` 后 `close`，若两个回调各递减一次，计数将漂移为负，此后并发上限永久失效。
- 加密对象的范围请求需完整下载解密后在内存中切片；明文超过上限即退化为全量流式解密（忽略 Range），避免单请求占用与明文等量的内存。非加密对象的 Range 由对象存储原生处理。

<h3 id="develop_document-section48">2.3 删除、复制与移动的截断契约</h3>

前缀删除（目录删除）必须遵守同一套契约，且全项目只允许一份实现：

1. 显式判定列举是否被截断，循环执行「列举一页 → 删除一页」直至清空或达到轮次上限；
2. **仅当云端删除确实成功后**才按批清理元数据，绝不先清元数据再删对象；
3. 目录标记对象在全部子对象删除成功后再删，截断时不删；
4. 仍被截断时如实返回截断标记，由调用方告警——绝不返回成功。

复制同样存在大小阈值：服务端单次复制有上限，超出必须先探测对象大小再决定是否分块复制，否则会出现「同一操作在管理界面成功、在 WebDAV 必然失败」的行为分裂。`CopySource` 的格式由客户端工厂统一生成（S3 厂商为 `/bucket/key`，腾讯云为外链形式），不再本地硬编码。

<h2 id="develop_document-section49">3. 分片上传与断点续传</h2>

- 会话持久化在 `data/upload-sessions.json`，记录 uploadId、已上传分片 ETag 与**分片加密参数**；加密参数同样受敏感数据保护。
- 恢复上传按「Key + Size + 创建者 + 目标桶」匹配。仅按 Key + Size 匹配会命中其他用户或其他桶的会话：前者泄露他人会话标识与分片进度（存在性侧信道），后者会让续传落到错误的桶上。
- 启动时的过期清理会尽力中止远端分片（避免持续计费）且不等待其完成；会话总数设上限，超出时按更新时间淘汰最旧的记录。
- 落盘采用去抖合并，但**去抖窗口内进程被强制终止会丢失分片加密参数**——已上传的分片将无法解密，表现为「上传成功但文件无法打开」，重新上传还会产生新的计费分片。因此优雅停机必须强制落盘；退出钩子的兜底必须使用同步写，异步写在 `exit` 处理器返回后永远不会被调度。
- 会话列表按创建者过滤，管理员可见全部。

<h2 id="develop_document-section50">4. 分享链接生命周期</h2>

<h3 id="develop_document-section51">4.1 标识与快照字段</h3>

链接 ID 为 16 字节 base64url（22 字符，128 位熵）——它会暴露在公开 URL 中，故不能过短；历史 8 / 12 字符 ID 仍可正常访问。链接在创建时快照目标对象、所属桶、展示用文件名与大小；分享者的收费意图同样原样保留在链接上。

快照只表达意图，是否真的收费由付费规则在**读取时**计算：停用支付功能后链接自动转为免费，重新启用又自然恢复，全程无需改动链接数据。

**管理页的列**：除文件与状态外，还展示**分享者**（`createdBy`）与**存储桶**（`bucket`），两者同样取自创建时的快照 —— 管理员看到一条陌生链接时，先要知道它是谁建的、指向哪个桶，才能决定是联系创建者还是直接处理。早于「按创建者隔离」那次改造创建的链接没有 `createdBy`，界面显示占位符而不是把空白当成某个用户。

<h3 id="develop_document-section52">4.2 状态判定顺序</h3>

状态序为 `已删除 > 已过期 > 次数用尽 > 有效`。「对象已不存在」排在最前：它是最根本的事实，否则管理页仍显示「有效」，管理员会去调整有效期或次数，改完照样无法下载。前端判定独立成模块并与服务端同序，避免出现「管理页显示有效、访客打开却提示文件已删除」。

对象缺失有两个判定来源：系统内删除对象时，按**已确认删除的 key 集合**批量标记（不接受前缀，理由同元数据清理）；系统外删除则依靠分享页的惰性探测补齐，且只有云端明确返回「不存在」才予标记，其余一律按「仍存在」处理——误标会让一条正常的链接被永久判死。

<h3 id="develop_document-section53">4.3 下载配额与来源判定</h3>

**放行判定顺序**（唯一权威定义；改动此处请同步「设计背景与刻意取舍 → 支付结果仅限服务端查单返回」）：

1. **来源判定**——有副作用的 GET 若无来源校验，第三方页面用一行 `<img src>` 就能刷掉额度；
2. **分享密码**——未通过即到此为止，不触碰任何计数；
3. **付费校验**——必须排在扣减配额**之前**，否则反复支付失败即可耗尽下载次数；
4. **扣减下载配额**——先计数后传输，读-改-写在单线程下全程同步，并发不会突破上限；
5. **对象存在性**——启动前失败（对象已不存在等）则**回滚**第 4 步的计数；
6. **传输**。

判定细节与其余要点：

- 来源判定分层：持有有效票据 → 放行（票据为 `SameSite=Lax`，跨站子资源请求不会携带，天然阻断预取）；浏览器显式声明跨站 → 拒绝；缺失来源头 → 回退校验 `Referer`，有 `Referer` 但不同源即拒绝，无 `Referer` 视为直连客户端，放行但记录审计。
- 密码通过后签发的令牌与**当前密码哈希**绑定，而非仅与链接 ID 绑定：修改或清除密码后旧令牌立即失效。否则「修改分享密码」这一动作无法撤回已获授权的访问者。

<h2 id="develop_document-section54">5. 请求上下文与会话鉴权</h2>

- 「当前桶」是会话级状态；全局默认桶的语义降级为**系统默认桶**，仅在无会话场景（WebDAV、分享链接、启动自检）与首次登录时作为回退。
- 上下文基于 `AsyncLocalStorage`，在鉴权中间件里建立一次，后续任意深度的异步调用都可取到，路由层无需逐个传参——避免为几十个调用点补参数时的漏改。切换当前桶可直接更新上下文，无需重新登录。
- 权限判定一律以**实时用户记录**为准，不使用登录时写入会话的角色快照；用户在配置中已不存在时直接销毁会话。
- 会话 Cookie 的 `Max-Age` 由服务端剩余有效期推导；勾选「记住登录状态」时有效期由 24 小时延长至 30 天。浏览器本地只保存用户名——真正免于重复登录的是会话有效期，而非本地存储的凭据。
- 未捕获异常不因已打印而继续服务：本服务持有「加密元数据」与「配置」两类一旦写坏即不可逆的状态，继续接受请求会让故障在用户数据上放大，因此记录后触发优雅关闭。

<h2 id="develop_document-section55">6. IP 访问守卫</h2>

- 规则模型：目标（单 IP 或 CIDR）、作用范围（空 = 全局，否则为桶集合）、方法（空 = 全部方法）、启用状态与命中计数。历史单桶字段在加载时迁移为数组。
- 判定优先级：**回环放行 → 桶级规则（仅作用于目标桶的请求）→ 全局规则 → 按桶屏蔽海外 IP**，任一级别命中即屏蔽；桶级与全局规则互不覆盖，各自独立生效。
- 目标桶必须按会话解析。若直接读取全局默认桶，用户切换当前桶后「对 A 桶生效的封禁」会在切到 B 桶时失效，反之 A 桶的合法请求可能撞上 B 桶的封禁。
- 「屏蔽海外 IP」按桶生效：仅当请求能解析出目标桶且该桶开启开关时才参与判定，避免误伤管理界面导致自身被拒。
- **IP 段数据须自行维护**：`china-ips.txt` 的正确性完全依赖这份数据，而 IP 段会持续分配与回收——请自行确认其数据来源、许可证与更新周期，并定期替换（替换后重启服务生效）。加载时折叠为「互不相交且升序」的闭区间这一不变量，由 `tests/audit-regressions.test.js` 断言保护：不变量一旦被破坏，二分定位会**静默漏判**（既不报错也不命中）。
- 中间件必须挂在鉴权之前（否则被屏蔽的请求会先执行一遍业务逻辑），因此需自行解析一次会话 token。WebDAV 服务复用同一套判定——它监听独立端口，此前完全不受约束，等于为屏蔽规则开了一道旁门。
- 命中提示页会回显客户端 IP；该值在启用 `TRUST_PROXY` 后来自请求方可控的请求头，必须转义。

<h2 id="develop_document-section56">7. 速率限制与失败锁定</h2>

- 限流采用滑动计数窗口，按 IP（可拼接业务键）统计，超限返回 429 并给出重试等待秒数。
- 失败锁定在「同一窗口内连续失败达阈值」后触发，冻结时长随失败次数指数增长（有上限）。计数必须按窗口衰减：终身累计会让隔数日手误一次的正常用户在第 N 次被锁在门外。**但锁定期内不得重置**——否则等到窗口滑过再失败一次即可清零，等于为锁定留了后门。
- 条目回收条件需覆盖「从未被锁定」的条目，且在记录失败的路径上同样执行回收，不能只依赖查询路径顺带触发。
- 跟踪表设有键数硬上限，达上限时优先淘汰未锁定的条目；该上限只承担内存安全职责，不作为安全边界——各入口自身的限流器才是边界。
- 预置实例覆盖登录、加密查看密码、分享密码、系统初始化、口令校验类管理动作、WebDAV 认证、分享下载与支付异步通知。其中支付通知端点匿名可达，且会携带真实商户凭据向网关查单：缺少限流时，任何人扫到回调地址即可反复触发查单、刷光查单配额。

<h2 id="develop_document-section57">8. 列举上限与目录缓存</h2>

- 所有列举上限集中在 `server/limits.js`：搜索与用量估算 5000、文件夹属性计数 20000、删除与清空 5000、WebDAV `Depth: infinity` 5000，另设 50000 的硬性天花板。此前这些数字散落在四个文件中，取值从 2 万到 20 万不等且互不知情。全部可用环境变量覆盖，便于受控压测。
- 目录缓存定位为「加速重复刷新」，**绝不作为真值来源**：TTL 仅 3 秒（`LIST_CACHE_TTL_MS=0` 可整体关闭），且任何写操作立即失效整个桶的缓存。
- 失效挂在全项目唯一的云端调用咽喉点上，按「方法是否为写」判定：只读方法用白名单，**未知方法一律按写处理**（宁可多失效）。这样新增任何云端调用都不必回来登记。其他需要「云端一写即失效」的模块在此订阅，咽喉点仍然只有一处。
- 缓存不做持久化：一旦落盘就要同时面对一致性、跨用户可见性与敏感 key 存储三件事，进程内缓存重启即空，天然没有这些问题。

**搜索候选集缓存**（`server/search-candidates.js`）是在同一个咽喉点上订阅的第二个消费者：

- 它是一份**明确可能过期的对象键清单**，只用于省掉「重复搜索时重新翻页」，**任何时候都不充当「桶里有什么」的判据**。与之相对，「本地元数据索引」意味着可信真值，那才要求每一处写入口同步维护、且漏一处即永久静默不一致 —— 本项目刻意不做那一层。
- 因为失效通知来自唯一的咽喉点，**新增写入口的登记成本在结构上是 0**，接线只有 1 处（订阅 `list-cache.js` 的写操作通知，而后者由 `s3.p()` 在成功与失败两条分支上喂入）。
- 代价是必须接受**最终一致**：站外写入（别人直接在控制台操作、生命周期规则、其他工具）本进程收不到任何信号，只能等 TTL 到期。所以 TTL 取保守的 10 秒（`SEARCH_CANDIDATES_TTL_MS`），且**从首次物化算起、命中不续期** —— 否则热条目永不失效，站外写入造成的陈旧窗口可以被无限延长。
- 容量上单条目上限 1 万键（`SEARCH_CANDIDATES_MAX_ITEMS`）：**越限即整条丢弃**并记一条 `warn` 日志，该子树退回「逐页列举 + 秒级页缓存」的既有行为。丢弃之后**不允许从当前页重新积累** —— 那样物化出来的是一段「中间窗口」而非从头开始的连续前缀，续扫时会静默漏掉窗口之前的对象。大桶不适合物化候选集，正确的做法是上后台扫描作业。
- 对象存储的列举游标是**独占**语义（返回**大于** `Marker` 的键），故候选集内的二分切片必须用严格大于：用「大于等于」会让续扫把刚处理过的对象再发一次。

<h2 id="develop_document-section58">9. 统计与操作日志</h2>

- 统计按天聚合（保留最近 30 天），另有按桶累计的上传 / 下载字节数与请求数；实时速率为内存采样，不持久化。
- 操作日志写入 `data/logs.jsonl`，上限 5000 条：内存缓冲合并写入，避免每次请求同步追加阻塞事件循环；字段经清洗去除控制字符并截断长度，避免污染 JSONL 结构。
- 轮转由定时器在空闲时执行：先刷出缓冲再轮转（否则两者几乎必然相撞、轮转长期得不到执行），且只在确实超出上限时做异步流式重写，不再无条件全量重写整个文件。
- 统计文件的损坏降级语义与敏感数据不同：统计并非核心数据，不因它拒绝启动，但**读降级为空表、写永久锁定**，磁盘原件备份为 `.corrupt-<时间戳>` 等待人工恢复。

<h2 id="develop_document-section59">10. WebDAV 服务</h2>

- 独立 HTTPS 端口（**复用应用自备的那份证书**：`TLS_CERT_FILE` / `TLS_KEY_FILE`），Basic 认证；未启用、无有效账户、**或没有可用证书**时都不监听（R49：WebDAV 强制 HTTPS，不会降级为明文；缺证书时界面会直接显示原因）。
- **对外地址必须由服务端推导，不能把监听地址当对外地址**：界面「服务器地址」按确定性从高到低取 ①`WEBDAV_PUBLIC_URL`（部署脚本写入的对外基地址）②请求域名（**仅当 `TRUST_PROXY=1` 且请求里确有 `X-Forwarded-Proto` / `-For`**，否则等于把地址交给请求方决定）③直连回退（面板主机名 + WebDAV 端口，只服务启动日志）。旧实现只拼「监听地址 + 端口」，而部署时 `.env` 写的是 `HOST=0.0.0.0`，于是界面**恒显示 `https://localhost:8443/dav/`** —— 那是**服务器自己**的回环地址，用户复制到资源管理器 / Finder 必然连不上，且界面上看不出任何异常（地址有、状态还是绿色「服务运行中」）。另有一条容易漏的：**Nginx 的 `$host` 已剥掉端口**，站点跑在非 443 端口时反代传来的 Host 仍是不带端口的域名，照它拼出来的地址会指向 443；故部署脚本注入 `X-Forwarded-Port $server_port`，应用侧优先取 Host 自带端口、其次该头。
- **`/dav` 反代由部署脚本默认开启**（`location ^~ /dav` → `https://127.0.0.1:${WEBDAV_PORT}`，`proxy_ssl_verify off`）。它**不能**留成「可选、请自行取消注释」的模板：界面会把 `https://<域名>/dav/` 当作服务器地址给出去，而留注释等于没有任何人转发 `/dav/`，用户只会撞上 404 且完全看不出差在哪一步。上游端口与 `.env` 共用同一个 `WEBDAV_PORT` 事实来源（两边各写一份 8443 迟早漂移成「界面有地址、反代连不上」）；走反代时**不需要**把 `WEBDAV_PORT` 暴露到公网。
- **能力声明必须与实际实现一致**：`OPTIONS` 返回 `DAV: 1`，**不是 `1, 2`**。`2` 在 RFC 4918 里意味着支持 locking，而本服务不实现 `LOCK` / `UNLOCK` / `PROPPATCH`；声明了却拿不到实现，资源管理器与 Office 在写入前先试 `LOCK`，会退化成「能浏览但写不了」。未实现的动词一律回 `405` 加 `Allow` 头（而不是落到 SPA 兜底的 `404`：`404` 会让客户端以为「这个 URL 不存在」而放弃重试，`405` 才表达「资源在、但这个动词不支持」）。`Allow` 头与适配动词集合取自同一处定义。
- **HEAD 不读对象体**：必须在使用文件网关的 `readObject` **之前**分流到 `headObject`。`readObject` 在返回前就已经发出了 `getObject` 请求，拿到返回再 `destroy()` 的写法会让每个 HEAD 都真拉一次对象体（对大文件等于整份下载）。
- 挂载点边界由**前置统一中间件**保证：除根重定向与健康探测外，任何不在挂载点之下的路径一律 404。此前逐方法判断，漏掉的 PUT 会在桶中创建只能通过挂载点以外路径写入的幽灵对象。
- 路径到对象 Key 的归一化与管理端共用同一函数，禁止 `..`，并对畸形百分号编码做容错——否则会写出界面既看不到也删不掉、却持续计费的对象。
- 认证限流分两层：按 IP 的全局限流（仅按用户名锁定时，攻击者更换用户名即可绕开并持续触发口令哈希），叠加按用户名的失败锁定。**两层都只统计认证失败**：成功请求也计数会把正常使用顶到上限——客户端挂载一次目录动辄几十个 `PROPFIND`，限流很快就会被自己的合法流量打满，表现为「挂载用一会儿就再也连不上」。
- 读写删改一律经文件网关：自动加解密、联动元数据、记录审计。删除目录未删完时如实报错，绝不返回 204；`MOVE` / `COPY` 的目标必须位于本服务挂载点之下且主机一致，失败原因如实透传 4xx，不折叠成 500。
- `COPY` 目录必须**逐页复制到底**，而不是只复制第一页；`Overwrite: F` 时目标已存在的对象要逐个判 `412` 并汇总，不能整目录静默放行。
- **不得把目录 COPY / MOVE 到自身或其子目录**。此前只对文件分支做了 `srcKey === dstKey` 判断，目录分支一旦指向自身内部（如 `/a/` → `/a/b/`），复制出的对象又会落入待复制集合，形成**无界递归复制**：请求永不返回、存储持续膨胀并计费。判定必须在进入复制循环**之前**完成（与目标是否已存在无关）。
- **目录 `MOVE` 也要认 `Overwrite: F`**（RFC 4918 §9.9.4）。此前该判定只用在了文件分支与目录 `COPY` 分支，目录 `MOVE` 直接合并覆盖——带「不覆盖」策略的同步工具会在自己以为安全的前提下静默覆盖目标已有对象。判定只需列举目标**一层**（`Delimiter: '/'`）即可确认「非空」，不必递归。
- **Range 响应两端必须自洽**：读取侧支持断点续传，因此带 `Range` 的 `GET` 必须回 **206 + 区间长度 + `Content-Range`**，`HEAD` 也须给出同一套事实。此前 `GET` 把 `Range` 交给云端（只拿回区间字节）却宣告**全量** `Content-Length`，客户端按宣告长度继续等剩余字节，最终报「传输被提前关闭」——大文件表现为下载损坏 / 播放失败（VLC、PDF 阅读器、Office、多线程下载器的续传都走这条路径）。越界范围回 `416`（并带 `Content-Range: bytes */total`），不得折叠成 500，否则客户端会当成服务端故障而无限重试。
- 列举上限同样取自集中定义，不再在本模块硬编码。**截断必须显式告出**：`Depth: 1` 的 `PROPFIND` 取满上限时返回 `X-WebDAV-Truncated` / `X-WebDAV-Truncated-Reason` 响应头并写一条 `warn` 审计日志（含具体路径与条数）。刻意**不**往 207 体里塞伪 `<D:response>`——那会被资源管理器当成真实条目渲染成幽灵文件，比不提示更糟。

<h2 id="develop_document-section60">11. 服务端点守卫</h2>

自定义 `endpoint` 决定服务端把凭据发往何处，因此校验策略默认从严：

- 仅接受 http / https 协议；非回环地址一律要求 https，否则访问密钥将以明文暴露在链路上；
- 回环地址与私网 / 链路本地 / 保留 IP 字面量默认拒绝，可用 `ALLOW_LOOPBACK_ENDPOINT=1`、`ALLOW_PRIVATE_ENDPOINT=1` 显式放开内网对象存储场景；
- 云平台实例元数据地址永远拒绝，不受上述开关影响；
- **不对域名做 DNS 解析后再判定**：解析会引入新的解析面与 TOCTOU 问题，且内网对象存储常以内部域名暴露。只判定 IP 字面量与元数据主机名，是在不破坏既有内网部署前提下的务实边界。

<h2 id="develop_document-section61">12. 上传过滤匹配器</h2>

`.gitignore` 语法解析遵循 git 官方规范：注释、`!` 取反、尾随 `/`（仅匹配目录）、`**` 前导 / 中间 / 尾随、`* ? [..]` 通配、反斜杠转义；含 `/` 的规则锚定在 `.gitignore` 所在目录，否则可匹配任意层级；同一路径按规则顺序「最后命中者生效」。

实现必须是**线性匹配器**（模式编译为 token 序列后以动态规划推进），绝不可编译为正则：`.gitignore` 文本来自客户端，多条通配符相邻会形成嵌套量词，`**/**/**/…` 或大量 `*a*a*a…` 会让 V8 正则进入灾难性回溯，单线程事件循环被占满，全站（含 WebDAV 与所有下载）失去响应。服务端与浏览器端各有一份实现，逻辑必须保持一致。

解析设有结构性上限，超出时**截断并在匹配器上标记**，由调用方决定是否告警——静默丢弃会让「本该被忽略的文件却被上传」难以排查。

<h2 id="develop_document-section62">13. 持久化、启动与关闭</h2>

- 全部持久化文件采用「临时文件 + rename」的原子写入。直接写目标文件会先清空再写入，进程在两步之间退出即留下 0 字节文件。临时文件名必须包含随机量：仅用毫秒时间戳会在同一毫秒内重名，后一次写入以 `w` 模式打开同一临时文件并先行截断，两次写入将共用一份数据。
- 启动时清扫孤儿临时文件，三重条件缺一不可：文件名匹配本模块规则、文件名中的 pid 已不存活、修改时间早于阈值。Windows 上 `process.kill(pid, 0)` 对系统服务返回 `EPERM`，需再核对一次进程列表，避免将系统服务误判为孤儿。PID 复用会导致漏删，清扫属尽力而为，宁可漏删不可误删。
- 日志类追加改用 `appendFile` 而非「读全文件 + 整体替换」，消除 O(n) 写放大；代价是崩溃时可能只损坏最后一行，对日志场景可以接受。配置类文件仍走原子写入。
- 敏感 JSON 统一以 AES-256-GCM 加密落盘，主密钥复用配置主密钥；兼容历史明文文件，读取时自动识别、写入时自动升级。写入按文件维度串行化，避免并发交错导致文件损坏。
- 单实例锁基于独占创建的锁文件，锁内记录 pid；持有者进程已不存在时自动接管。其目的在于避免两个进程各自持有配置缓存并交替整体覆盖 `config.enc`。
- 优雅关闭顺序：停止接收新请求 → 刷出日志缓冲 → 等待敏感数据异步写完成 → 配置落盘 → 停止 WebDAV → 退出，并设置兜底超时。

<h2 id="develop_document-section63">14. 前端模块与渲染约定</h2>

- 前端为原生 ES Module，无构建步骤；模块按职责划分，管理端能力按角色物理分离（动机见「设计背景与刻意取舍」）。
- **唯一的非 ESM 例外是 `pay-poll.js`**：它服务于服务端渲染的分享页，需要从 `<script data-link-id>` 属性上取参数，而 `document.currentScript` 在 `type="module"` 脚本里恒为 `null`，因此写成普通脚本。它曾经是页面里的内联 `<script>`——CSP 移除 `script-src 'unsafe-inline'` 后那段脚本被浏览器静默拒绝执行，「支付成功后自动放行」的承诺随之失效；抽成同源静态文件即落回 `script-src 'self'` 之内。**分享页与主站共用同一套 CSP**，因此分享页模板里同样不允许出现内联脚本或内联事件处理器。
- **请求序号**：文件区所有异步加载共用一个计数器，发起前自增，响应到达时若自身已不是最新一次则丢弃结果。在途时直接返回会把用户的后续操作静默丢弃，比不互斥更糟。自增必须落在「确认会发起请求」之后——早退分支同样自增会把在途请求判为过期而无人收尾，加载态将永久卡住。
- 序号只解决「旧结果不该覆盖新结果」，解决不了「服务端那一轮仍在空转扫描」，因此另配 `AbortController`：发起新一轮前取消上一轮，服务端检测到连接断开即停止翻页。主动取消必须原样抛出，不可被改写成「无法连接本地服务」这类误导性提示。
- 渲染必须幂等。登出与登录成功两个时点都要重置主视图并清空各模块的渲染缓存，否则下一个账号会看到上一个账号停留的区块。
- 富文本渲染默认按纯文本转义：弹窗与 Toast 默认纯文本，需要富文本必须显式声明并自行转义插值，使「未转义即渲染」从沉默的默认行为变为显眼的、可被评审发现的声明。
- 定时器句柄一律保存，并在登出或目标元素不存在时停止，否则会出现登出后仍持续轮询接口的无效请求。

---

<h1 id="develop_document-section64">四、测试</h1>


<h2 id="develop_document-section65">1. 测试与 CI</h2>

项目使用 Node 内置的 `node:test` runner，不引入任何测试依赖：

| 测试文件 | 覆盖范围 |
| --- | --- |
| `tests/routes-surface.test.js` | 路由表面积护栏：总数基线、无丢失/无重复、敏感接口 `requireAdmin` 覆盖、路由优先级 |
| `tests/s3-client.test.js` | S3 客户端：缓冲/流式/Range/404、分页双游标语义、SigV4 签名 host 一致性 |
| `tests/crypto-storage.test.js` | 加密往返、XOR 等价性、原子写入、追加不整体替换（文件对象同一性探针，非墙钟阈值）、孤儿 tmp 清扫、单实例锁、IP 段判定 |
| `tests/frontend.test.js` | 34 个前端模块 ESM 语法、import 路径存在性、转义工具复用、Windows Hello 就绪判定与错误分类、权限门控约定、角色界面分离（含「IP 地址管理」「邀请码设置」整页对普通用户隐藏）、会话切换的主视图重置、请求序号自增不得早于早退校验（结构不变量分析器，自带样例自测）、搜索的请求取消三要素（AbortController / signal 透传 / limit 与范围）、主动取消不被误报为「无法连接本地服务」（真实 ESM + fetch 打桩） |
| `tests/webauthn.test.js` | WebAuthn 零依赖实现：CBOR 解码、`coseToSpki` 一致性、ES256 验签（反双重哈希护栏与裸 `r\|\|s` 兼容）、authData 解析、挑战一次性、注册与认证全流程及负数路径 |
| `tests/gzip.test.js` | 压缩判定与端到端 `Content-Encoding` 还原 |
| `tests/payment.test.js` | 支付凭证与付费下载：字段官方命名、必填/格式/枚举校验、PEM 与 https 校验器、敏感字段不回传明文、「留空保持不变」合并语义、`registerValidator` 扩展点、开关约束与渠道三态、金额最低 0.01 元、付费生效判定、订单状态机与票据防跨链接复用、支付路由全部挂载 `requireAdmin` |
| `tests/payment-gateway.test.js` | 真实支付网关：支付宝待签名串排序与空值剔除、RSA2 签名结构、微信 Authorization 五段式与 GCM 解密、PayPal 沙箱/生产域名选择、`createCharge` / `queryCharge` 的失败即关闭语义 |
| `tests/qrcode.test.js` | 自研二维码：按 ISO/IEC 18004 校验版本 1–10 字节模式容量、格式信息位、GF(256) 乘法、掩码惩罚分与模块矩阵可解码性 |
| `tests/auth-session.test.js` | 登录会话（起真实 express 应用请求）：连续调用 `/auth/me` 不销毁会话、用户被删/降权立即生效、记住登录 TTL 与 Cookie `Max-Age` 同源 |
| `tests/audit-regressions.test.js` | 审计回归护栏：越权写桶、会话实时鉴权、SSRF、ReDoS、损坏文件不静默回落、信号量幂等、列举上限集中治理、magic 完整性校验、分享令牌绑密码、会话级当前桶（四读端同源）、删除目录截断守卫、分享下载来源判定、重命名/移动冲突检查等（均经反向对照验证） |
| `tests/audit3-regressions.test.js` | 第三轮审计护栏：订单落盘字段、`markDownloaded` 仅在下载成功后调用、模拟支付端点不存在、支付结果只能由查单确认 |
| `tests/search-cursor.test.js` | 搜索续扫：`limit` 触顶与扫满上限时游标落在最后处理的 key、空页 + IsTruncated 不死循环、续扫不重不漏；「仅当前目录」的单级列举（子目录与文件混排不重不漏、页边界游标、目录占位对象过滤、缓存键含 delimiter）、客户端断开后服务端停止翻页 |
| `tests/list-cache.test.js` | 目录列举短缓存：按桶失效不误伤、写操作失效 / 读操作不失效、未知方法按写处理、TTL 过期与开关、条目上限、路由级命中不访云端 |
| `tests/search-candidates.test.js` | 搜索候选集（`search-candidates.js` 与 `/fs/search` 的接入）：游标切片必须是**严格大于**（与对象存储 `Marker` 同语义，用 `>=` 会让续扫重发刚处理过的对象）、TTL 命中不续期、超限整条丢弃且**不再重新物化**（从当前页重新积累会得到「中间窗口」，续扫静默漏对象）、`keyOf` 四个区分维度、`TTL=0` 安全阀、**等价性**（候选集开关/命中与否，同一请求的结果必须逐字段相同）、**候选集的增量**（关掉 `list-cache` 后重复搜索仍不打云端 —— 只测「重复搜索免费」会被页缓存兜住，抓不到「路由根本没接候选集」）、写操作与写失败都立即失效、scope 分离、客户端断开不得被缓存绕过 |
| `tests/audit5-regressions.test.js` | 第五轮审计护栏：IP 屏蔽中间件 HTML 分支不再 500、提示页含客户端 IP 且已转义、回环放行 |
| `tests/audit6-regressions.test.js` | 第六轮审计护栏：stats.json 损坏拒绝落盘、IP 守卫按会话桶解析、新增桶存在性探测（含路由短路）、文件夹重命名的父目录前缀、rename 先迁元数据再删源、复制回滚孤儿副本留痕、`/s/*` 跨站拒绝与支付回调豁免、日志轮转不再被缓冲饿死、配置写去抖合并、分片列举缓存与按桶失效；复核新增「失败计数按窗口衰减 + 条目可回收 + 键数硬上限」（虚拟时钟驱动）与「退出兜底必须同步写」（真实子进程验证）两项 |
| `tests/config-verify-permission.test.js` | `POST /api/config/verify` 的权限边界：必须挂载 `requireAdmin`（云端桶名的唯一入口），非管理员一律 403，且**即便持「可见且已启用」的密钥也不得拿到云端桶列表**（防盲 SSRF + 防账号资产枚举） |
| `tests/share-deleted.test.js` | 分享链接「对象已删除」：状态序、批量标记按桶隔离且幂等、分享页 410、惰性探测落标与二次访问零调用、下载侧补标、前端判定与服务端同序 |
| `tests/docs-sync.test.js` | 文档清单同步护栏：目录结构列出的测试文件 / 前端模块 / 服务端模块与实际一致，文档声明的模块数与测试文件数与实际一致，环境变量表收录了代码中实际读取的全部变量，文档头部声明的适用版本与 `package.json` 一致，**目录（TOC）条目与正文标题一一对应且锚点编号连续**（增删章节忘了同步目录会立刻变红） |
| `tests/audit7-regressions.test.js` | 第七轮审计护栏：分片上传会话必须记录 `provider`（否则会拿**另一家厂商的客户端**去打当前桶的端点，>8MB 上传必然失败；R49 前这条表现为「退化成 COS SDK」，COS SDK 移除后仍是同一条纪律：会话与桶的 provider 必须一致）、加密元数据必须在云端写入**成功之后**才落盘（写入失败时旧凭据不得被覆盖），均起真实 express + 打桩云端客户端做行为断言 |
| `tests/audit8-regressions.test.js` | 第八轮审计护栏：`magic` 分片上限既要压小同步阻塞又不得低于厂商 5MB 下限、覆盖写入后的元数据对账（明文覆盖必须清旧密文元数据）、`list-cache` 键的调用方命名空间、当前密码错误回 403（回 401 会被前端当成会话过期）、分片列举缓存的容量上限、整桶标记与按 key 标记对历史链接同口径、跨链接订单上限（`paid` / `refunded` 永不裁） |
| `tests/audit9-regressions.test.js` | 第九轮审计护栏（修复验收 + 新发现）：批量删除解析厂商 `<Error>` 且调用方按**白名单**判成败（未确认即视为失败，不得误清元数据 / 误标分享链接）、覆盖复制的元数据对账（源无元数据必须清目标）、WebDAV 目录 COPY/MOVE 自嵌套守卫与 `Overwrite: F` → 412、WebDAV Range 返回 206 + `Content-Range`（含越界 416）与 HEAD 两端一致、`/s/:id/pay/status` 按 IP 预算闸门（不得复用 60/10 分钟的查单限流）、`magic` 同步上限下沉到加密入口（超限 413）、测试临时目录不被退出钩子重建，均起真实 express / 真实 WebDAV HTTPS 做行为断言 |
| `tests/audit11-regressions.test.js` | 第十一轮审计护栏：**「整批 0 成功即停下」必须落在外层循环**（`break` 只跳内层 `for` 时一次失败被放大成上千次云端往返，三处 `deletePrefix` 同构 —— R23-03 已把三份收敛为 `gateway.deletePrefixAll()` 一份，判据与断言不变，只是锚点随实现迁移）、目录 MOVE 的元数据迁移必须**早于删源**（中断时目标密文不得挂在已删源 key 的凭据上）、回滚只撤**本次新建**的目标对象（不得删掉目标侧既有对象）、对象存储的 401 必须映射为 502（不得占用本地「会话过期」语义，否则前端强制登出死循环）、`HEAD /api/fs/download` 不得触发对象下载（express 会让 HEAD 退化成 GET）、文件 MOVE 到自身必须 403（自复制 + 删源 = 静默数据丢失）、退出路径只写不建（`enc-store` 同款纪律）、分片上限在**缺 `chunkSize`** 与**模式切换后放大**两条绕行上都要生效（最内层 `encryptPart` 兜底）、文件 COPY 到已存在的目录必须 412、`Accept-Ranges` 与 GET 同源、同名桶在不同厂商/密钥下不得共用列举缓存、分片序号必须是 1–10000 的整数、目录 `displayname` 不得带百分号编码 |
| `tests/audit12-regressions.test.js` | 第十二轮审计护栏：`config-store` 的落盘必须跟随 `S3_DATA_DIR` **且不得改写生产 `data/config.enc`**（第 12 轮实际发生过的数据事故）、目录 MOVE 遇目标同名对象必须**动手前整体拒绝 409**（覆盖不可撤销，回滚删不掉）、退出路径的判据必须走**唯一实现点**（打桩 canonical 后必须真的不写 / 判据为真时真的写 —— 双向）、WebDAV 目录 COPY 中途失败必须回滚到「源在目标不在」、magic 缺 `chunkSize` 时 `encryptPart` **自身**拒绝（`NaN` 偏移会让任务永久卡死）、目标目录过大给专属文案且零改动、元数据迁移后必须已同步落盘、`bucketOfIdent` 取倒数第 2 段（加维度不失效）、并发回滚后目标侧**零残留**且失败后不再启动新任务 |
| `tests/audit13-regressions.test.js` | 第十三轮审计护栏：**测试进程必须默认拿到临时数据目录**（在不设 `S3_DATA_DIR` 的子进程里只 require `helpers.js`，必须已被兜底到临时目录且不是生产 `data/` —— 第 12 轮的隔离靠"每个用例自觉"，实测全量测试仍在写生产数据）、目录 COPY 失败回滚**不得删「复制前就存在的目标对象」**（fresh 过滤；删掉即是不可逆的用户数据丢失）、并发失败必须**先等 worker 落地再取快照**（`stopped` + `allSettled`，目标侧零孤儿，且回滚日志不得谎报 `X/Y`）、`Overwrite: F` 必须整体拒绝（容器级判据覆盖"目标非空但无同名对象"这一**只有它能挡**的形态，键级比对作探测 fail-open 时的兜底）、`moveObject` 删源失败必须回滚本次新建的目标（目标原本已存在时 fail-closed 不删，避免毁掉用户既有数据） |
| `tests/audit14-regressions.test.js` | 第十四轮审计护栏：**支付窗口内的 `pending` 订单不得被裁剪**（裁掉 = 异步通知查无此单 = 钱付了拿不到文件）、裁剪动作必须写 `warn` 日志、超出窗口的 `failed` 仍可裁（证明上限机制没有因保护而失效）。本文件**故意使用默认的 2 小时支付窗口**，与 `audit8` 把窗口压到 1ms 的做法语义相反，常量在模块加载时读取，故必须独立进程 |
| `tests/audit14-perf.test.js` | 第十四轮审计四条性能项（R14-08 / R14-09 / R14-10 / R14-12）与它们共用的两个原语：**去抖合并写**（窗口内多次 `schedule()` 只落盘一次、快照取「真正落盘那一刻」的值、返回 `null` 即本次不写、`debounceMs: 0` 是逃生阀）、**并发合并读**（同一 key 的并发调用只执行一次，失败**不缓存**）、退出兜底必须**同步**写且「只写不建」；以及四条修复各自的**可观测后果**：`secure-store` 落盘时序列化已移出调用栈（断言 `writeJsonAsync` 返回时 `encrypt` 调用次数为 0）且文件不再带缩进换行、`payment-orders` 一次支付流程的 4 次状态变更在去抖窗口内 **0 次**落盘、窗口过后**恰 1 次**且内容是最新快照、分享页惰性探测 5 并发只打 **1 次** `headObject` 且失败要留 `warn` 痕迹并短窗口缓存、`/fs/stat` 文件夹计数命中短缓存且写操作即失效。**假云端客户端必须注入延迟**（`headDelay` / `listDelay`）——不注入就观测不到「请求仍在飞」，撤掉并发合并也照样只打一次（反向对照会假绿） |
| `tests/audit16-regressions.test.js` | 第十六轮审计护栏：**WebDAV「服务器地址」在服务器端部署后必须反映用户访问的域名**（现场故障：界面恒显示 `https://localhost:8443/dav/`，客户端填了连不上）。三条互相咬合的契约：① `serverUrl(req)` 按「`WEBDAV_PUBLIC_URL` → 请求域名（仅 `TRUST_PROXY=1` **且确有转发头**时）→ 直连回退」逐级取值，经反代时**不得**出现 `localhost` / `127.0.0.1`；不设 `TRUST_PROXY` 时伪造的 `X-Forwarded-*` 必须被忽略（否则等于把对外地址交给请求方决定）；`Host` 自带端口优先、其次 `X-Forwarded-Port`，非 443 部署要补出端口。② 路由层 5 处 `webdavView` 调用**必须传 `req`**（不传就静默退化成监听地址 —— 界面照常显示地址、服务照常「运行中」，静态读代码看不出问题）。③ Nginx 模板**默认**就把 `/dav` 反代到 `WEBDAV_PORT`（不再是「可选、请自行取消注释」；留注释的结果是界面给出的 `https://<域名>/dav/` 撞 404），且上游端口与 `.env` 共用同一个 `WEBDAV_PORT` 事实来源，`WEBDAV_PUBLIC_URL` 在 `--skip-nginx` 时必须留空（自建反代写死一个本站点没配反代的地址反而指向 404），**R49 起在 `--tls none` 时同样留空**（WebDAV 强制 HTTPS，没有证书时它不会启动，旧断言要求的 `http://<域名>:<端口>` 是一个永远不通的假地址，已随 R49 更正）。全部 shell 断言在**同一个** bash 子进程里一次渲染 8 段产物 —— 脚本 3300 余行，Git Bash 每次进程启动约 8 秒，逐个 spawn 会把测试时间拉成分钟级；前端断言先剥整行注释再比对（注释会引用旧写法做反例，不剥就把反例当成真的坏写法） |
| `tests/audit17-regressions.test.js` | 第十七轮审计护栏：① **反向代理部署下取 IP 必须认 `X-Forwarded-For`**（现场故障：默认部署 = Nginx 反代 + `TRUST_PROXY=1`，守卫只读 `socket.remoteAddress` 便恒见 `127.0.0.1`，命中 `evaluate()` 首条「本机永远放行」短路 → 黑名单 / 国内白名单 / 按桶屏蔽海外 IP / WebDAV 全部失效）。契约三条：`security.clientIpInfo` 是**唯一实现点**（`ip-guard` 与 `webdav-server` 不得各自读 `socket.remoteAddress`）；`X-Forwarded-For` 首段优先，但**来自转发头时不得再享回环豁免**（否则 `X-Forwarded-For: 127.0.0.1` 一个请求头就把整条修复抵消）；不设 `TRUST_PROXY` 时伪造的转发头一律忽略，且**正常本机直连仍放行**（与 `R7-04` / `FUN-01` 成对）。② **支付侧地址校验**：支付宝 `gateway` 字段必须过 `assertSafeEndpoint()`（原 `httpsUrl` 只查协议不查主机 → 开放重定向 + 服务端 SSRF），5 种恶意形态（回环 / 内网 / http / `169.254.169.254` / `metadata.google.internal`）在 `validate('alipay', …)` 字段路径上被拒，官方域名与沙箱放行；`PUT /payment/site-url` 与 `siteUrlFor()` 都必须过 `security.isOwnSiteHost()`（仅查形状 `/^https?:\/\/[^\s]+$/i` 时，外站地址可经支付网关背书成开放重定向）。③ **async 路由兜底**：`asyncHandler` 必须 `wrapped.length === 3`（否则 Express 不认签名）、抛错走 `next(err)` 而非吞掉（Express 4 不捕获 async rejection → 请求永久挂起），8 处注册语句按精确锚点断言且总数有下界自检。全部走真实 express（R17-03 起最小应用挂 `ROUTES_PAYMENT` 注入 admin；R17-04 的 `jsonCall` 带超时，变异成「挂起」时 fail-fast 而不是挂死进程） |
| `tests/audit21-regressions.test.js` | 第二十一轮审计护栏（行为断言为主，起真实 express / 打桩云端客户端）：**分享下载路径必须与网盘侧同口径地受「查看密码」闸门约束**（`GET /s/:id` / `HEAD /s/:id/dl` / `GET /s/:id/dl` 三处，未解锁时不得流出密文，解锁走 `/s/:id/unlock` 且令牌可经 Cookie 复用；设了查看密码而闸门被撤掉即变红）、WebDAV 写入必须受**独立**的并发流上限约束（`MAX_WRITE_STREAMS`，读上限管不到写）、Windows Hello 登录失败的两条分支（用户不存在 / 未启用）必须回**同一**状态码与文案（不得成为用户名预言机，但仍各自写 `auth.fail` 日志）、回调地址必须指向**实际下单渠道**（1.9.17 起「换渠道即另建新单」，同一渠道才复用 —— 见 `audit82-regressions.test.js`）、自助改密必须先验当前密码、实例锁的**新鲜空锁**不得被当陈锁接管（有宽限期）、列举缓存 / 搜索候选集的缓存键必须**消毒分隔符**（含 `\u0000` 的参数不得拼出同键 → 跨调用串味）、S3 客户端与支付网关遇 3xx 必须拒绝跟随（防盲 SSRF / 带凭据请求被打到 `Location`）、`HOST=0.0.0.0` 时 HTTPS 跳转目标优先取站点域名（不得 301 到不可解析的通配地址）、WebDAV 错误响应不得回显上游原始 `message`（本地校验文案保留）、`SCAN-SKIPLIST.md` 的版本号与文档引用必须与仓库一致 |
| `tests/audit22-regressions.test.js` | 第二十二轮修复护栏（**对第二十一轮修复的补完**；`audit22` 与 `audit21` 的对应项刻意成对，把上一轮漏掉的那一半独立钉住）：**Windows Hello 登录的第三支**（用户存在 **且** 已启用 Hello —— `audit21` 把 `isWebauthnEnabled` 恒打桩为 `false`，这一支**物理上不可达**）必须与另两支回**同一**状态码与逐字相同的文案，且响应里不得再出现 `reason` 键或「挑战 / 签名」这类细节文案（旧实现回 `publicReason(r.reason)` + `reason`，而这一支的可达前提恰好就是「用户名存在且启用了二次验证」→ 一个更精确的 oracle）；**转发头取值必须可信** —— 轮换 5 个不同的非法 `X-Forwarded-For` 必须收敛为同一来源标识（旧实现原样回显，限流键 `ip` 与锁定键 `ip\|username` 随请求头轮换 → 限流与账户锁定被整条绕过），且「头在但值不可用」不得落回 socket 分支而冒充本机（否则反代部署下 `127.0.0.1` 让 R17-01 的修复换形式复活），同时 `deploy.sh` 生成的反代片段必须用 `$remote_addr` **重写**而非 `$proxy_add_x_forwarded_for` **追加**；**WebDAV 的每一个错误出口都不得裸发上游 `message`** —— 改为**调用点层**的静态不变量（`webdav-server.js` 内不得出现 `send(… e.message …)`，覆盖 `.send(e.message)` 与 `.send(cond ? '404 Not Found' : e.message)` 两种同型写法；R21-14 的函数级护栏对 PROPFIND / MKCOL / DELETE / COPY 四处撤不撤都不变红），且 `davErrorMessage(e)` 的调用点有下界自检；**「解密下发」三出口的加密门禁归属**必须在 README 与开发文档里有同一口径（`WebDAV 出口不叠加`）**且与代码事实双向一致**（将来给 WebDAV 接上门禁，文档那句会立刻变红）；**加密令牌的两条通道**（管理端 `x-enc-token` 请求头 / 分享页 `HttpOnly` + `path=/s/` 的 Cookie）必须在 README 里各自限定作用域，不得再写「仅通过请求头传递」；`httpsRedirectHost()` 的**注释顺序必须与实现顺序逐项同序**（请求 Host → 本机 HOST（非通配）→ 站点域名 → 通配回退），且不得再出现被本轮纠正掉的旧顺序 |
| `tests/audit25-regressions.test.js` | 第二十五轮功能护栏（**负载均衡 / API Key 空间配额**，打桩云端 `?stats` 客户端）：**用量必须按「实际生效的密钥」归集**（桶到密钥的归属走 `credentialIdForBucket`，与真正写入时选中的密钥同源 —— 直接读 `b.credentialId` 在「桶未钉密钥、随当前密钥漂移」时会归错账）、**超限判据必须是严格大于**（已用 1000 / 上限 1000 时写入 0 字节不得被拦，写入 1 字节才拦；用 `>=` 会让「正好用满」被误判为超限）、**官方统计的 15 分钟缓存不得成为超限窗口**（`?stats` 的 `sizeBytes` 是陈旧值，判定必须叠加「本次写入的待定增量」台账 `bucketPendingDelta`，且**只有拿到新鲜样本时才清零** —— 否则连续上传会在 TTL 窗口内任意超额），以及 `/fs` 的 **5 个写入出口逐个独立**受闸门约束（`/fs/mkdir`、`/fs/rename`、`/fs/move` 走「已超限即拒」的 0 字节增量；`/fs/upload/init` 用「目标大小 − 已传分片」的净增量；`/fs/upload/simple` 用请求体长度），**新建桶**（`POST /buckets/local` 且为全新桶）同样受闸门约束，WebDAV 的 PUT（目录 / 文件）、MKCOL、COPY/MOVE 四处走静态不变量钉住（`webdav-server.js` 内每个写入分支都必须出现 `assertCredentialQuota` 调用，PUT 文件分支还必须按 `Content-Length` 计入增量），前端系统设置卡片的位置（用户管理 ↔ 文件加密之间）/ 管理员专属（`ADMIN_ONLY_CARDS`）/ 错误码 `CREDENTIAL_QUOTA_EXCEEDED` 与前端判据字面量一致。**每条闸门都配正向对照**（未超限时请求照常 200），防「一律 403」这种把功能改死的假修复 |
| `tests/audit26-regressions.test.js` | 第二十六轮功能护栏（**新增四家 S3 兼容服务商**：Google Cloud Storage / Cloudflare R2 / MinIO / Backblaze B2）：**前后端各有一份厂商清单，必须同序同值**（`provider-logos.js` 的 `ORDER` 与 `PROVIDER_META` 对 `server/providers.js` 的注册表逐项比对，含 `kind` / `regionRequired` / `endpointMode` / `endpointLabel` —— 这些字段是「界面承诺 vs 服务端闸门」的同一件事，任一处漂移都是一次口径分叉）；**商标图形必须确实来自指定的源**（用 viewBox 尺寸 + 路径条数 + 品牌主色三者交叉，单看条数或单看颜色都可能被别的图标蒙对）；**端点组装的三形态与幂等** —— R2 的「账户 ID」要拼成 `https://<id>.r2.cloudflarestorage.com`，而**表单回填的是库里已组装好的端点**，再拼一次会得到 `https://<id>.r2.…com.r2.…com`（一个**语法完全合法**的域名，不报错、只在连接时静默失败），故组装必须幂等，且「复制来的不带协议端点」与「显式给完整 URL」各有独立断言落点；**R2 不得走「地域填主机名中段」的推导路径**（`regionFor('r2','')` 给出 `auto`，会让端点被拼成 `auto.r2.cloudflarestorage.com` —— 同样是合法假域名，只表现为「网络连接异常」），`createClient` 必须在**建客户端这一步**就报「缺少账户 ID」；**地域字符集受限**（它会被直接拼进端点模板，而厂商默认端点这条路不过 `assertSafeEndpoint`）+ **允许留空的厂商要补默认地域**（`auto` / `us-east-1`）；**MinIO 必须走路径风格寻址**，且这条差异由**三处**协同实现、每处单独钉：厂商元数据 `forcePathStyle` → 客户端工厂 `s3.createClient` 真的把它传下去 → `s3-client._virtualHosted()` 是**唯一**判据（静态不变量：`this.basePath === ''` 不得出现在该函数之外 —— 同一判据曾在 4 处各写一遍，任何一次「只改一处」都造成「列举能跑、下载 404」）；**「只改备注」的一次保存不得改写密钥的厂商与端点**（旧实现无条件写入，一次保存就把 R2 密钥回落成腾讯云并按别家规则重算端点），且组装必须按「这条记录**最终生效**的厂商」而非入参厂商（否则重新保存时不带 `provider` 的调用方会被 `assertSafeEndpoint` 以「服务端点格式不正确」**拒掉整次保存**）；**建桶路由的地域闸门按厂商**（旧实现在推导出厂商**之前**就无条件 `if (!region) return 400`，界面上写着「可留空」提交却被拦下，用户只能胡乱填一个会真的进入签名串的值）、留空时必须补默认地域而非落空串；**前端**：密钥表单的「服务端点」栏由 `endpointMode` 驱动显隐（恒显会让别家看到无意义的输入框）、保存与「测试连接」都必须提交端点（收了值发不出去 = 静默丢弃）、建桶表单的地域星号按厂商隐显。全部零依赖，HTTP 用例一律 `listen(0)` 取临时端口，避免与相邻轮次并发跑文件时 EADDRINUSE |
| `tests/invariants.test.js` | **跨模块不变量的静态护栏**（第 11 轮报告 §9.4「类别登记表」里可机器化的那些行）：`process.on('exit')` 钩子内不得建目录、生产侧不得裸调 `deleteMultipleObject`（唯一实现点 `s3.deleteMultipleConfirmed`）、`Accept-Ranges` 必须受 `rangeServable` 约束、`listCache.keyOf` 首参必须是 `bucketCacheKey(cfg)`、上游状态回填必须先把 401 映射掉、`router.head` 必须注册在同名 `router.get` 之前、`scripts/reverse-check.js` 的每条 anchor 必须在各自的 `file` 内**唯一**命中（`String.replace` 只替换**首处**，anchor 重复时会打到无关分支 → 变异不生效 → `fail=0` 假绿，R14-05 / R10-11 各中招一次），且**纯注释 anchor 判为违规**；**变异还必须真的等价于旧实现** —— 把某个调用点搬到它自己的 `const` 定义之前，会先撞 TDZ（`Cannot access before initialization`）让子进程因**未捕获异常**退出（状态码同样是 1）、一个字节都没写，于是行为断言的 `status===1` 与「未写 data/upload-sessions.json」**双双被巧合满足**（R7-07 实测 `fail=0`；正确改法是自包含地复现旧实现的可观测后果，而不是搬源码）（锚点校验跑在 `stripComments()` 之上，纯注释剥完只剩空白 → 「命中」恒真、唯一性得到荒谬计数，实测 R9-06 报「67 次」）。第 13 轮又补了四层：**判"私有副本"与"取 canonical 函数体"必须同源**（枚举 `decl` / `expr` / `arrow` / `method` 四种定义形态 —— 旧实现取体只认 `function name(`，把 canonical 重构成箭头函数即可让判据校验静默跳过）、**唯一实现点的接线按登记入口逐文件点名**（取代 `minCalls` 计数代理：删一处真接线再补一处空调用无法绕过）、**每条检查都带扫描范围下界自检**（命中归零时同样全绿，是既有护栏的通病）、`tests/` 侧也纳入数据目录硬编码扫描。注释剥离改为引号/正则感知的扫描器 —— 旧正则把 `'/dav/*'`、`server/routes/*.js` 这类 glob 当成块注释起点，实测吞掉 `ip-guard.js` 1137 字符、文档 27693 字符（全部检查共用的地基缺陷，表现为静默失明）。每条检查都是纯函数且**自带正/反样例自测**，失败信息带 `文件:行号`。第 14 轮再补 5 类静态不变量（`rename` 的 `newKey` 必须过 `normalizeKey`、异步写不得在 `await` 之前取 store、发起支付必须先查支付态、WebDAV 独立实例必须带安全响应头且可渲染类型转 `attachment`、WebDAV 认证三条失败路径都要跑 `dummyHash`）与一条跨文件检查（`public/js/main.js` 声明的验证码脚本源必须被 `server/index.js` 的 CSP `script-src` 允许）。同时把「反向变异 anchor 必须命中」改为**变异期豁免**：`reverse-check.js` 跑单条对照时会**故意删掉**该条 anchor，那条自检会凭空变红，掩盖「真实不变量到底抓没抓到」这一唯一要看的信息，故由脚本注入 `REVERSE_CHECK_MUTATING=1` 使其跳过；并新增「退役项必须写明 `retiredReason` 且总数 ≤ 5」的元护栏，防止用 `retired` 把跑不红的对照项悄悄藏起来。第 15 轮又堵住两个"假绿"来源：①**剥注释不得吞掉代码** —— `stripComments()` 原先把 shell 的 `/*` 当成 JS 块注释开头，`[[ "$INSTALL_DIR" == /* ]]`（deploy.sh 862 行）会一路吞到文件里下一个闭合符，862..1188 行共约 330 行代码整体消失，`#  include …/modules-enabled/*.conf;`（1396 行）与 `"$INSTALL_DIR"/*`（2711 行）再各吞 16 / 85 行；落在这三段的**反向变异 anchor 永远"未命中"**、静态不变量也看不见那段代码（台账全绿而实为假绿）。判据抽成 `isShellPatternAt()`（同行有 `[[`／行首是 `case`/`in`/`#`／`/*` 紧跟 `=` `!`），并以「**deploy.sh 里每个函数定义剥完注释后都必须还在**」（下界 80，实测 95 个）作为结构性护栏；②**依赖清单必须与锁文件同步** —— `package.json` 加了 `devDependencies.eslint` 而 `package-lock.json` 未更新时，`npm ci` 在任何机器上都必然 EUSAGE 失败（部署脚本第一枪打的就是它，只能靠兜底 `npm install` 侥幸装上）；护栏照 `npm ci` 的校验逐字比对根条目 spec + `node_modules/<name>` 实体条目，并核对 `engines` / `license` |
| `tests/audit10-regressions.test.js` | 第十轮审计护栏（**对第九轮修复的对抗式验收**）：移动文件夹必须保留目录层级（`dest/b/x.txt` 不得退化成 `dest/bx.txt`）、三处 `deletePrefix` 共用白名单判据（云端未确认删除 → 元数据与分享链接都不动；R23-03 后三份已收敛为 `gateway.deletePrefixAll()` 一份，断言不变）、目录 MOVE 是 merge 语义（不得清目标侧已有元数据）、`init` 的 simple/multipart 分界必须感知加密模式（消除 5–8MB 死路）、分片大小必须与会话声明一致（超限 400）、WebDAV MOVE 删源必须标记分享链接、加密大对象 HEAD 不得宣告 206、分片完成的用量缓存修正必须命中（缓存键须含 `secretId`）、`Overwrite: F` 判据统一（覆盖「目标是文件」/「目标是空目录」两种漏判，且 COPY 必须在动手之前整体拒绝）、HEAD 不得被 `app.get` 吞掉（一次都不许下载对象）。全部走真实路由 / 真实 WebDAV HTTPS 服务；R10-01 的异步落盘护栏在 `audit9-regressions.test.js`（与退出路径成对断言） |

> 文件名中的轮次编号（1 / 3 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 16 / 17 / 21 / 22 / 25 / 26 / 27 / 28 / 29 / 31 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 40 / 41 / 42 / 43 / 44 / 45 / 47 / 48 / 49 / 50 / 51 / 52 / 53 / 54 / 89）沿用审计当时的命名：若干轮次（第 2、4、15、18～20、23、24、30、39、46 轮）没有各自的独立护栏文件，其结论已并入相邻轮次或既有护栏文件，因此编号不连续——**这并不表示存在护栏缺口**。`invariants.test.js` 不属于任何一轮，它是跨轮次不变量的常驻护栏。同一轮可以有两个文件（第 14 轮即 `audit14-regressions` 管正确性、`audit14-perf` 管性能与新增原语；第 54 轮按用户确认的**三步走**拆分，第①步 `audit54-regressions` 管「站点设置」卡片、第②步 `audit54b-regressions` 管登录页注册 / 记住密码 / 忘记密码与邮箱验证码体系）。各轮护栏也不按版本切分：任何一次部署都应让全部护栏通过，不存在「某个版本只需跑其中几条」。

> 共 **92 个测试文件、1548 条用例**（计数口径：第 37 轮新增 `audit37-regressions.test.js` **26 条**、第 38 轮新增 `audit38-regressions.test.js` **31 条**；第 39 轮**没有**新的护栏文件，5 条版本对齐护栏落在既有的 `deploy-script.test.js` 内；第 40 轮新增 `audit40-regressions.test.js` **7 条**，另有 3 条「不能编辑自己」护栏并入既有的 `audit35-regressions.test.js`；第 41 轮新增 `audit41-regressions.test.js` **14 条**，前端侧另有 3 条「两套配置各自独立」护栏并入既有的 `audit31-regressions.test.js`；第 42 轮新增 `audit42-regressions.test.js` **9 条**；第 43 轮新增 `audit43-regressions.test.js` **8 条**；第 44 轮新增 `audit44-regressions.test.js` **14 条**；第 45 轮新增 `audit45-regressions.test.js` **12 条**；第 46 轮是小型修复、**未新增**护栏文件（1 条护栏并入既有的 `audit42-regressions.test.js`）；第 47 轮新增 `audit47-regressions.test.js` **20 条**；第 48 轮新增 `audit48-regressions.test.js` **22 条**；第 49 轮新增 `audit49-regressions.test.js` **9 条**（移除自签名证书 + 移除 COS 原生 API，配套 10 条反向对照）；第 50 轮新增 `audit50-regressions.test.js` **17 条**（分享页文件类型图标 / 左键框选多选 / 「链接创建成功」弹窗改版，配套 18 条反向对照）；第 51 轮新增 `audit51-regressions.test.js` **34 条**（「链接创建成功」弹窗加宽、链接一行显示完；多文件 / 文件夹分享的列表 + 勾选 + 50/页分页 + 打包 `.tar.gz`，配套 40 条反向对照）；第 52 轮新增 `audit52-regressions.test.js` **19 条**（多选（文件+文件夹）分享入口 /「移动」报成功实际没动 / 复制粘贴与冲突逐项询问 / 分享页默认全选与展示路径脱敏 / 链接结果弹窗左右等高，配套 22 条反向对照）；第 53 轮新增 `audit53-regressions.test.js` **32 条**（「发信设置」卡片与零依赖 SMTP 客户端，配套 17 条反向对照）；第 54 轮新增 `audit54-regressions.test.js` **22 条**（第①步「站点设置」卡片：站点名称 / 公开注册 / 新用户身份，配套 13 条反向对照）与 `audit54b-regressions.test.js` **30 条**（第②步：登录页注册 / 记住密码 / 忘记密码 + 邮箱验证码体系，配套 22 条反向对照）、`audit54c-regressions.test.js` **24 条**（第③步：邀请码系统 —— `side-foot`「邀请码设置」+ 批量生成 / 删除 / 导出 txt + 单独与批量设置使用次数 / 过期时间 / 身份，并把注册的 `invite` 模式改成真核销，配套 33 条反向对照）、第 68 轮新增 `agreement-settings.test.js` **25 条**、第 69 轮新增 `audit69-regressions.test.js` **26 条**（《安全漏洞分析报告》的 2 高 / 5 中 / 12 低逐条修复，配套 17 条反向对照）（三页协议提示 + 两份协议正文：渲染口径 / XSS / 权限 / 预览不落盘 / 备份往返 / 分享页零脚本 `:target` 弹窗）、第 77 轮新增 `audit77-regressions.test.js` **4 条**（外部加密审计 F-E1：缺 IV/TAG 的历史元数据 fail-closed，配套 3 条反向对照）；第 79 轮新增 `audit79-regressions.test.js` **7 条**（L1/L2 支付密钥真实解析 + 等待页「点了没反应」，配套 7 条反向对照）；第 80 轮新增 `audit80-regressions.test.js` **11 条**（「点击立即支付没有任何反应」的六条成因：静默 303 / 表单收到裸 JSON / SM2 静默降级 / 网关地址片段 / 无收银台静默降级 / 提交无反馈，配套 10 条反向对照）；第 81 轮新增 `audit81-regressions.test.js` **9 条**（出站超时只管到响应头 ⇒ 读响应体可挂到 undici 的 300 秒兜底；提交看门狗把「没跳去支付平台」误报成「订单没建成」，配套 8 条反向对照）；第 82 轮新增 `audit82-regressions.test.js` **9 条**（三条用户要求的行为变更：换渠道即新单 + 退券 / SM2 保存时即拒绝 / 历史在途订单一次性标失败，配套 8 条反向对照 + R21-06 重述）；第 83 轮新增 `audit83-regressions.test.js` **7 条**（表单 POST 之后不许再跨域 3xx —— Chrome/Safari 会把 CSP 的 `form-action` 施加到「表单提交后的重定向目标」上，跨域 302 被整条拦掉，页面一动不动而订单已建好；改用同源「正在跳转」中转页由页面自身发起导航，配 meta refresh + 可点链接双通道，收银台地址另加 http(s) 协议白名单，配套 6 条反向对照）；第 84 轮新增 `audit84-regressions.test.js` **13 条**（《支付模块检查报告》七条逐条复核、**全部成立**：支付宝查单响应验签（按 JSON 原文切片验，重新序列化即失效）/ 轮询推进放宽到任何 pending 订单 / 账本读不出来时 fail-closed（拒收 + 管理端横幅 + 接口 `degraded`）/ `fenFromYuan('')` 不得是 0 / 换券即新单（含「旧券必须退回」）/ 5 秒内同参数重复提交合并 / PayPal 回调事件类型白名单，配套 13 条反向对照，另重锚 4 条 R82 对照）；第 85 轮新增 `audit85-regressions.test.js` **5 条**（「支付宝页面上显示的订单号与实际订单号不符」—— 结论是**订单系统没有残留旧号**：`out_trade_no` 一直是内部 16 位 `id`，36 位 `orderNo` 从未也**不能**发给网关（微信 v3 上限 32 位），真正的缺陷是**短号在界面上完全不可见**；故本轮只补可见性、不动支付链路：中转页 / 等待页 / 二维码页 / 状态页四处并列出「订单号」与「商户单号」+ 订单管理页新增「商户单号」列（可复制），配套 4 条反向对照）；第 86 轮新增 `audit86-regressions.test.js` **13 条**（订单号取回新增「账号归属」限制：**登录态成交**的订单只能由购买时的同一个账号取回，**游客成交**的订单任何情况下都能取回；闸门排在取回额度之前、失败不消耗额度、拒绝时不回传订单快照，路由给「去登录 / 切换账号」按钮且这两类不计入连续输错，配套 7 条反向对照）；第 88 轮新增 `coupon-threshold.test.js` **6 条**（优惠券「满 xx 减 xx」门槛，配套 6 条反向对照）；第 89 轮新增 `audit89-regressions.test.js` **10 条**（存储空间隔离：桶内 `u/<userId>/` 前缀命名空间 + 两个收口点 + `/fs` 全部端点收支方向 + 分享快照绝对 key + WebDAV 账户绑定用户 + 删用户连带吊销账户，配套 14 条反向对照）；**确切条数与通过情况请以 `npm test` 结尾的汇总行为准**）。环境性红/跳过一并说明，避免被误读成回归：`RE-03` / `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY）；`audit16-regressions` 有 4 条要靠 `bash` 驱动 `deploy.sh` 的 Nginx 模板断言，无 `bash` 的机器上会以「bash 不可用（ENOENT）」失败；`SCAN-SKIPLIST.md` 不在工作区时另有一条清单一致性用例按设计跳过。全部零依赖，可直接 `npm test` 运行。修改路由、前端模块或 WebAuthn 相关代码后请先运行。文件数由 `docs-sync` 护栏校验；**用例总数没有护栏**——静态统计（`grep -rhE '^\s*test\(' tests/*.test.js | wc -l`）与 runner 实际计数口径不同（后者含 `t.test()` 子测试），无法用静态方式锁定，故此处给的是**本版发布时的实测值**（以 CI 与本地全量运行结尾的汇总行为准），它随每次改动而变，请勿当作长期基线。
>
> **本节是全文唯一的用例计数口径**：其他章节提到用例条数时一律写「见「四、测试 → 1. 测试与 CI」」而**不得另写数字**——曾经「测试与 CI」写 480+、「服务端调试」写 300+，两处都是手抄数字，没有护栏，于是静静地漂移了若干个版本。散落的数字必然失同步，收敛成一个入口才不会。

**当前仓库不提供 CI 工作流**（无 `.github/` 目录）：下方描述的多平台矩阵**尚未落地为自动化**，提交前请在本机执行 `npm test` 与 `npm run lint`。

> **R23-05：这一处曾经是文档漂移的标本。** 本节旧版声称「CI（`.github/workflows/ci.yml`）在 Linux（Node 18/20/22）与 Windows（Node 22）上运行测试，并额外构建 Docker 镜像做容器健康检查冒烟」，目录结构树里也列着该文件 —— 而仓库里根本没有 `.github` 目录。既有 `docs-sync` 校验了模块清单、TOC、环境变量表，**唯独不校验「文档提到的仓库文件是否存在」**，所以这条声明可以长期漂移而不报红。同一类问题比「缺少 CI」本身更伤信任：读者会按文档去等一个永远不会出现的红灯。
>
> 现在两侧都已闭合：① 树里的条目已删除、本段改为如实描述；② `tests/docs-sync.test.js` 新增「目录结构代码块里列出的仓库文件必须真实存在」断言（`data/` 运行期子树与显式豁免项除外），此后**任何**在树里登记一个不存在文件的改动都会立刻变红。CI 本身仍是待办（见「六、审计发现台账」R23 行）。

<h2 id="develop_document-section66">2. 测试护栏编写约定</h2>

- **护栏优先写成行为断言**：早期有两条只检查「源码里能否 grep 到某个词」，退回旧实现后照样全部通过（形同虚设），已改写为行为断言。**确需读源码时（如「全库仅一处调用 `markPaid`」这类结构性承诺），断言的扫描范围必须与承诺范围一致**——只扫一个文件的话，在别的文件里调用一次就能同时骗过文档与护栏；这类断言应遍历全部源码文件，并在失败信息里列出命中位置。


- **写回归断言要枚举「同一状态的所有读取入口」，而不是只测改动的那一处**：某次回归断言只覆盖了「全局不变 / 会话记住 / `listBucketsFor`」即告通过，遗漏 `get()`，导致界面显示新桶、实际操作仍打全局桶。现行护栏一次性校验 `listBucketsFor` / `safeView` / `get` / `effective` 四者**必须同源**。
- **禁止墙钟阈值断言**（`assert(ms < 20)` 之类）：负载下一红一绿，而「偶发红」会让所有人学会忽略红灯，等于毁掉「全绿」这个信号本身。改用**与耗时无关的确定性探针**：
  - 判断「文件是否被整体替换」→ 比较追加前后的 `fs.stat().ino`（win32 亦可用；tmp+rename 必变）；
  - 判断时间窗口/锁定/去抖语义 → **虚拟时钟**（临时替换 `Date.now`，基准取真实当前时间再小幅推进，避免跨天影响按日期分桶的模块），比真实 `sleep` 更快且完全确定；
  - 判断「退出阶段能否落盘」→ 起**真实子进程**（`spawnSync` + `S3_DATA_DIR` 指向临时目录），父进程读回文件比对。
- **静态分析器（读源码的护栏）必须自带样例自测**，且判定窗口要由**结构**决定，不能用魔数长度：有分析器曾用 400 字符的固定窗口，而目标函数的守卫前导约 480 字符 → 退回旧实现后照样全绿。同理，抽取方法体要**配平花括号**（先跳过参数括号），不能截到下一个 `},`——search 内部有 try/catch/finally 嵌套，按缩进截会让断言范围缩水；样例自身也要花括号配平，否则解析提前收尾、自测先假红。
- **测「连接断开后停止工作」这类时序行为，用挂起的假依赖而不是 sleep**：让假 `getBucket` 把回调存起来，测试端先 `destroy()`、再手动放行首页，之后是否发起第 2 次调用就完全由被测代码的判断决定，与机器快慢无关（放行后仍需一个宽限期让事件循环推进，但那是等待而非断言）。
- 所有审计回归护栏均经**反向对照**验证检出能力：退回旧实现必须 FAIL。变异脚本要**先断言锚点命中**（静默变异失败会伪装成「护栏没抓住」），并做到崩溃安全（登记 + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 强制还原 + `data/` 快照）。

<h1 id="develop_document-section67">五、开始二次开发</h1>

本章面向**第一次接触本仓库的开发者**：读完 `1. 高层架构总览` 就知道代码分几层，照着 `2. 本地启动与调试` 能在几分钟内把服务跑起来并看到界面，`3` / `4` 是两个可照抄的最小改动示例，`5` 是提交前必须过一遍的自检清单。

> 本章只讲「路怎么走」，不重复前四章的结论。凡本章与前文冲突，**以前文为准**并请顺手修正本章。

<h2 id="develop_document-section68">1. 高层架构总览</h2>

<h3 id="develop_document-section69">1.1 分层视图与请求链路</h3>

整个系统是**一个单体 Node 进程**：没有消息队列、没有数据库、没有前端构建产物（前端是浏览器直接加载的原生 ESM）。状态全部落在 `data/` 的 JSON 文件里。分层只有四层，且**依赖方向严格自上而下**——领域层模块不知道 HTTP 的存在，因此可以脱离 express 单独测试。

```
浏览器（原生 ESM：无打包 / 无转译 / 无框架）
│  public/index.html · public/css/style.css · public/js/*.js
│  main.js 负责主视图切换，api.js 统一封装 fetch，其余模块各管一块业务
│
│  fetch('/api/**')
│    · Cookie: s3mgr_session（HttpOnly，由服务端签发）
│    · X-Requested-With（POST / PUT / DELETE 必带 —— CSRF 防线，不是装饰）
▼
[ 入口层 ]  server/index.js
│  挂载：/ 静态资源 · /api/** 业务接口 · /s/:id 公开分享页（匿名）
│        /pay/notify/:platform 支付异步通知 · /webdav WebDAV 服务
│  端口：PORT=3000（HTTP）· HTTPS_PORT=3443（内置 HTTPS，仅当自备证书就绪时监听）
│  中间件链（顺序有语义）：请求日志 → 会话解析 → CSRF 校验
│                        → IP 守卫 → 限流 / 失败锁定 → 路由分发
▼
[ 路由层 ]  server/routes.js（只负责挂载）→ server/routes/*.js（13 个领域子模块）
│  _context.js 依赖汇聚（唯一 DI 点）· _shared.js 中间件与工具
│  每个子模块导出一个 express.Router，子模块之间互不 require
▼
[ 领域服务层 ]  server/*.js（纯逻辑，不感知 HTTP）
│  fs-gateway 统一读写网关 · s3.js 客户端工厂 + 错误翻译 · s3-client.js 自研 SigV4
│  providers.js 厂商注册表 · endpoint-guard.js 防盲 SSRF · limits.js 列举上限唯一来源
│  config-store（配置与用户，加密落盘）· enc-store · share-store · list-cache
│  payment-orders / payment-rules / payment-gateway / payment-providers
│  auth-session · webauthn · security（限流 / 失败锁定）· ip-guard · webdav-server
▼
[ 持久化层 ]  data/
│  data/config.enc（含密钥、桶、用户）· data/secret.key · data/enc.key
│  data/enc-settings.json · data/enc-meta.json · data/links.json · data/invites.json
│  · data/coupons.json
│  data/ipguard.json · data/upload-sessions.json · data/payments.json · data/downloads.json · data/restore-bans.json · data/stats.json · data/logs.jsonl
│  data/tls/（自备证书，R49 起不再自动生成）· data/.instance.lock
│  全部经 atomic-write.js 落盘（tmp + rename），不存在「写了一半」的中间态
▼
[ 外部依赖 ]
   全部厂商（含腾讯云）· 自建 SigV4（s3-client.js）
   支付宝 / 微信支付 / PayPal（下单与查单直连官方接口）
```

各层的职责边界，以及「想改点什么时该先看哪里」：

| 层 | 代码位置 | 职责 | 改动前先读 |
| --- | --- | --- | --- |
| 入口 | `server/index.js` | 静态资源、中间件链顺序、端口与 HTTPS、优雅停机 | 二.5 安全说明、二.6 REST API 模块化组织 |
| 路由 | `server/routes/*.js` | 参数校验、权限判定、组装响应 | 二.7 HTTP API |
| 领域 | `server/*.js` | 业务规则、与云端 / 支付网关的交互 | 三、核心模块实现 |
| 持久化 | `server/atomic-write.js` + `data/` | 原子落盘、损坏检测与拒绝写入 | 三.13 持久化、启动与关闭 |

**一次 `GET /api/fs/list` 的完整链路**——照着这条线读一遍代码，是最快的入门路径：

1. 前端 `explorer.js` 调 `API.list(prefix, marker)` → `api.js` 带上 Cookie 与 `X-Requested-With` 发请求；
2. `index.js` 的会话中间件解析 `s3mgr_session`，并**用实时用户记录**（不是登录时的快照）判定角色；随后 IP 守卫、限流依次放行；
3. `routes.js` 命中 `routes/fs.js` 注册的 `GET /fs/list`；
4. 路由先用 `requireConfig()` 确认已配置密钥与桶，再由 `s3.js` 的 `getClient()` 取得客户端；
5. `listCache` 命中就直接返回（同目录重复刷新不访云端）；未命中才调云端 `getBucket`，并用 `encStore.encryptedSetFor()` 标出哪些对象是密文；
6. 组装 `{ prefix, contents, prefixes, isTruncated, nextMarker }` 返回，前端按 `isTruncated` 决定是否显示「加载更多」。

<h3 id="develop_document-section70">1.2 状态存放与启动顺序</h3>

**状态全在 `data/`**，没有数据库。因此「备份」= 复制 `data/` 目录；「迁移」= 复制目录 + 保证目标机器上有同样的 `data/*.key`。写测试时优先用 `S3_DATA_DIR` 指向临时目录做隔离（多数存储模块支持；`config-store` 不支持，涉及它的用例要另想办法）。

启动顺序（`server/index.js` 末尾自上而下，顺序本身有含义）：

1. 注册 `SIGINT` / `SIGTERM`（Windows 还有 `SIGBREAK`）→ 优雅停机，`flush` 后关端口；
2. **单实例锁**：两个进程同时操作同一份 `data/` 会交替整体覆盖加密配置，因此检测到活跃实例直接拒绝启动（崩溃残留的脏锁会被自动接管，真卡住时删 `data/.instance.lock`）；
3. 清扫 atomic-write 留下的孤儿 `*.tmp`（条件：pid 已死 + mtime 超 10 分钟）；
4. 起 HTTP（`PORT`，默认 3000）；**再按自备证书（`TLS_CERT_FILE` / `TLS_KEY_FILE`）决定是否起 HTTPS**（`HTTPS_PORT`，默认 3443）—— 没有证书就只提供 HTTP，并向日志打印缺哪个文件（R49 起不再生成自签名证书；WebDAV 同样因此不会启动）；
5. 把历史遗留的明文数据文件升级为加密存储；
6. 配置损坏（`isCorrupted()`）时打印警告——**不静默回落**；
7. 按已保存配置启动 WebDAV；
8. 注册 `uncaughtException`：记录后优雅退出（认为进程已进入未定义状态，继续服务会把故障放大到用户数据上）。调试时可用 `NO_RESTART_ON_UNCAUGHT=1` 关闭该行为。

<h2 id="develop_document-section71">2. 本地启动与调试</h2>

<h3 id="develop_document-section72">2.1 启动方式与端口</h3>

```bash
npm install            # 只有 1 个运行时依赖（express；R49 起 cos-nodejs-sdk-v5 已移除）
npm start              # node server/index.js
npm run dev            # node --watch server/index.js —— 改服务端代码自动重启
npm test               # node --test "tests/**/*.test.js"
npm run lint           # node scripts/lint.js（ESLint 包装器：未装 eslint 时给安装指引并以 0 退出）
```

> **容器化部署不在本节**：Docker 镜像构建、卷挂载（`data/` 必须持久化，否则重启即丢密钥）与端口映射见 `README.md`「3.4 Docker 部署」。本节只覆盖本机源码启动与调试。

启动后访问 `http://127.0.0.1:3000`：

- 首次启动页面会引导创建管理员（`POST /api/auth/init`，仅当系统尚无任何用户时可用）；
- `http://127.0.0.1:3000/api/health` 是最省事的探活端点，返回 `{ ok, time, configured, corrupted }`——`configured: false` 表示还没配密钥，界面会停在引导页；
- **HTTPS 不会再自己「跑起来」**：R49 起内置 HTTPS（`3443`）只在配了自备证书（`TLS_CERT_FILE` / `TLS_KEY_FILE`，或 `data/tls/fullchain.pem` + `data/tls/privkey.pem`）时才监听，没有证书就只有 `http://127.0.0.1:3000` 可用（启动日志会写明缺哪个文件）。

常用环境变量（完整清单见 `2. 环境变量`）：

| 变量 | 用途 |
| --- | --- |
| `PORT` / `HTTPS_PORT` / `HOST` | 监听端口与绑定地址（默认 3000 / 3443 / 127.0.0.1；`HTTPS_PORT` 仅在自备证书就绪时监听） |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 自备证书与私钥路径（未设时回退 `data/tls/fullchain.pem` + `data/tls/privkey.pem`） |
| `S3_DATA_DIR` | 把状态目录指向别处（写测试、并行跑实例时用） |
| `TRUST_PROXY` | 仅在可信反向代理后设为 `1`，否则不信任 `X-Forwarded-For` |
| `TRUST_PROXY_HOPS` | 可信代理跳数（配合 `TRUST_PROXY=1`；追加式反代 / CDN 链路必须设，否则取到的是请求方可控的首段） |
| `NO_RESTART_ON_UNCAUGHT` | 设为 `1` 时未捕获异常不触发退出，便于现场调试 |

> 调试时**不要直接对着真实 `data/` 反复折腾**：起第二个实例会被单实例锁拒绝，而误改配置可能导致加密数据损坏。优先 `S3_DATA_DIR` 指向一个临时目录。

<h3 id="develop_document-section73">2.2 服务端调试</h3>

- **断点**：`node --inspect-brk server/index.js`，再用 Chrome 打开 `chrome://inspect`（或 VS Code 的 attach 配置）。前端代码直接在浏览器 DevTools 里断点即可。
- **看日志**：操作审计落在 `data/logs.jsonl`（滚动保留，不追求长期明细），管理员可 `GET /api/stats/logs` 拉取；启动期与异常直接打在控制台。
- **看状态**：改完配置想确认是否落盘成功，直接看 `data/config.enc`（加密）与 `GET /api/config` 的 `selfTest`（自研加密自检，失败说明密钥材料有问题）。
- **接口试探**：按 `7. HTTP API` 里的 curl 样例来。写操作记得带 `-H 'X-Requested-With: XMLHttpRequest'`，否则 403——这是最常见的「登录了却被拒」的原因。
- **测改动**：`npm test` 跑全量；用例条数的量级见「四、测试 → 1. 测试与 CI」（此处**故意不写数字**，避免第二处计数再次漂移）。只想跑其中一个文件用 `node --test tests/<file>.test.js`。**`npm test` 的 glob 必须带引号**，否则某些 shell 会先展开路径。
- **本机跑不起来的两条**：`RE-03` 与 `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY），属**环境性失败而非回归**；判定方法是看这两条之外的用例是否全绿。

<h3 id="develop_document-section74">2.3 前端调试</h3>

前端是原生 ESM、无构建步骤：**改完 `public/js/*.js` 刷新页面即可**（浏览器对 ESM 有缓存，必要时硬刷新）。

- 主视图是一个个 `<section id="...">`，由 `main.js` 的 `MAIN_VIEWS` + `switchMainView()` 统一显隐。**新增视图必须登记进 `MAIN_VIEWS`**，否则登出 / 登录切换时不会被 `resetMainView()` 复位，会残留上一个会话的 DOM。
- 仅管理员可见的内容要**整块隐藏并且不发请求**（见 `syssettings.js` 的 `ADMIN_ONLY_CARDS`），不要只靠服务端 403 兜底。
- 异步列表渲染一律走「请求序号」机制，避免旧响应覆盖新结果；渲染函数要幂等（同一份数据渲染两次结果一致）。
- 冒烟可用无头 Chrome：`chrome --headless=new --dump-dom http://127.0.0.1:3000`（Windows 下用绝对路径调用 `chrome.exe`）。

<h2 id="develop_document-section75">3. 最小示例 A：新增一个只读接口</h2>

**需求**：加一个 `GET /api/demo/ping`，返回当前登录用户名与服务器时间，仅管理员可访问。这个例子覆盖了新增后端能力要动的**全部三个地方**：路由文件、`routes.js` 挂载、路由表面积护栏。

<h3 id="develop_document-section76">3.1 第一步：写路由</h3>

新建 `server/routes/demo.js`。约定：从 `_context.js` 取依赖（唯一 DI 点）、从 `_shared.js` 取中间件，文件末尾导出一个 `express.Router`：

```js
/**
 * 路由：二次开发示例（可整文件删除，不影响其它功能）
 */
const { express } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

// 判权限一律用 requireAdmin 中间件；不要自己比较 req.authUser.role。
// 会话里的 user 是登录那一刻的快照，管理员降权后旧快照仍会带着原 role。
router.get('/demo/ping', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    user: (req.authUser && req.authUser.username) || '',
    time: new Date().toISOString(),
  });
});

module.exports = router;
```

<h3 id="develop_document-section77">3.2 第二步：挂载与依赖注入</h3>

在 `server/routes.js` 里加一行。**挂载顺序有语义**（`auth` 必须最先；`/credentials/visibility` 必须早于 `/credentials/:id`，否则会被参数路由吞掉），新模块一般追加在末尾即可：

```js
router.use(require('./routes/stats'));
router.use(require('./routes/demo'));   // 新增
```

需要用到其它 server 模块时，**先加到 `server/routes/_context.js`** 再从 `_context` 解构，不要在自己的文件里直接 `require('../config-store')`——否则测试无法对单一模块做依赖替换。

<h3 id="develop_document-section78">3.3 第三步：补护栏并验证</h3>

`tests/routes-surface.test.js` 维护着路由表面积基线：**新增路由不登记，测试会红**。这一步是刻意的设计——它保证「删了一个路由」这种事不会被静默放过。

```js
// tests/routes-surface.test.js —— EXPECTED 数组追加一行
'GET /demo/ping',

// mustBeAdmin 数组也追加一行（本接口挂了 requireAdmin）
'GET /demo/ping',
```

然后验证：

```bash
node --test tests/routes-surface.test.js   # 表面积护栏
npm test                                   # 全量
curl -s -b cookie.txt http://127.0.0.1:3000/api/demo/ping
```

如果只想验证「接口真的挂上了 `requireAdmin`」，可以照 `tests/config-verify-permission.test.js` 的写法：起一个真实 express 应用，用普通用户与管理员的会话各打一次，断言 403 / 200。**不要写「源码里 grep 到 `requireAdmin` 这四个字」这类断言**——它抓不到「挂错了路由」和「条件写反了」。

最后把新接口补进 `7. HTTP API` 的表格（否则文档与代码分叉，`docs-sync` 不会发现这一点）。

<h2 id="develop_document-section79">4. 最小示例 B：新增一个前端卡片</h2>

**需求**：加一个「示例卡片」主视图，进入时拉取上面那个 `/api/demo/ping` 并显示结果。三个改动点：

1. **`public/index.html`**：在主视图同级加一个区块，默认 `hidden`：
   ```html
   <section id="democard" class="card-view" hidden>
     <div class="card">
       <div class="card-head"><h3>示例卡片</h3></div>
       <div id="democard-body" class="card-body">加载中…</div>
     </div>
   </section>
   ```
   容器样式由类驱动（`.card-view`），**不要给它写 ID 白名单样式**——ID 白名单每加一个视图就要改一次 CSS，是回归的温床。
2. **`public/js/democard.js`**：导出 `refresh()` / `reset()`，请求统一走 `api.js`：
   ```js
   import { API } from './api.js';
   import { toast } from './util.js';

   export function refresh() {
     API.ping()
       .then((r) => { document.getElementById('democard-body').textContent = `${r.user} @ ${r.time}`; })
       .catch((e) => { toast(String((e && e.message) || e), { type: 'error' }); });
   }
   export function reset() { document.getElementById('democard-body').textContent = '加载中…'; }
   ```
   `public/js/api.js` 里补一个 `ping: () => request('GET', '/api/demo/ping')`。
3. **`public/js/main.js`**：登记视图 + 接上入口按钮：
   ```js
   const MAIN_VIEWS = ['explorer', /* … */, 'democard'];            // ① 必须登记，否则 resetMainView 复位不到
   else if (v === 'democard') democard.refresh();                    // ② switchMainView 分支
   $('side-demo').onclick = () => { switchMainView('democard'); closeSidebar(); };
   ```
   若这块内容仅管理员可见：把它加进 `syssettings.js` 的 `ADMIN_ONLY_CARDS` 一类机制——**整卡隐藏 + `refresh()` 在隐藏时提前 return**，避免「看得见拒绝操作」。

前端改动执行 `npm test` 也会覆盖一部分：`tests/frontend.test.js` 会校验所有前端模块的 ESM 语法、`import` 路径是否存在、主视图列表与 DOM 是否一致。改动后应将 `1. 目录结构` 里的模块清单补上（`docs-sync` 会进行检查）。

<h2 id="develop_document-section80">5. 二次开发检查清单</h2>

- [1] **落盘使用 `atomic-write`**？直接 `writeFile` 会先截断，进程中断就留下 0 字节文件。
- [2] **权限判定用的是实时用户记录**（`findUserRawById()`）而不是会话快照？降权 / 删户 / 改密后是否主动销毁了对方会话？
- [3] **服务端点经过 `endpoint-guard`**？任何来自用户输入的 URL 都可能是一次盲 SSRF。
- [4] **新增路由登记进 `tests/routes-surface.test.js`**，敏感接口进 `mustBeAdmin`。
- [5] **新增文件 / 环境变量 / 模块补进 `1. 目录结构` 与 `2. 环境变量`**——`tests/docs-sync.test.js` 会校验文件清单与环境变量表，漏了直接红。
- [6] **文档同步**：`7. HTTP API` 表格、以及涉及的章节；若插 / 删了一节，记得目录锚点会整体位移（改完用 `docs-sync` 里的目录护栏确认目录与标题仍然一一对应）。
- [7] **护栏是行为断言而不是源码 grep**：写完把实现退回旧版，确认测试真的会 FAIL。
- [8] **改动触及某个审计编号时**（代码里的 `SEC-*` / `FUN-*` / `PERF-*` / `LOW-*` / `S*` / `P*` 注释），先查本文件「六、审计发现台账」：它登记每个编号的含义与闭合依据，并由 `docs-sync` 护栏保证不遗漏。**注意编号不是全局唯一的**：已确证 11 个编号存在同号异义，且 `S4` 与 `SEC-04`、`P3` 与 `PERF-03` 是两套独立系列——因此**新引用必须带轮次或日期限定**（如 `audit6/PERF-01`、`SEC-04（2026-09-14）`）；需要无歧义指代时请用 `6.5` 的限定别名（如 `FUN-12@unbounded-map`）。
- [9] **同一事实只在一处展开细节**：凡文档标注「唯一权威定义」的内容（如「下载放行判定顺序」在 `4.3 下载配额与来源判定`），**其余引用处只写「结论 + 指向」，不复述步骤、顺序或阈值**。复述一次就多一处同步负担，而这类内容恰恰是最容易只改一半的（改了顺序却漏改复述处，读者按旧顺序实现就是错的）。当前两处「唯一权威定义」已按此纪律收口；新增同类内容时请沿用。

> 完整测试跑法与护栏编写约定见 `四、测试`。

---

<h1 id="develop_document-section81">六、审计发现台账（合并存档）</h1>

> 本节把原先散落在仓库根目录的多份审计文档（`AUDIT_FINDINGS.md`、`ANALYSIS-ROUND7.md`～`ANALYSIS-ROUND13.md`、`fix-record.md`）**缩减、合并**成下述两张表，并作为其唯一正本。这些单文件已删除。审计编号的「含义与闭合依据」登记在此，由 `tests/docs-sync.test.js` 护栏保证不遗漏（引用 ⊆ 登记、登记 ⊆ 引用，双向闭合）。

## 6.1 编号台账主表（含义与闭合依据）

> 编号空间**不是全局唯一**的：同一编号在不同轮次被复用，已确证 11 个同号异义（见 6.2）。因此**新引用必须带轮次或日期限定**（如 `audit6/PERF-01`、`SEC-04（2026-09-14）`）；需要无歧义指代时用 6.5 的限定别名。本节所有编号一律用反引号包裹（护栏据此识别登记项）。

**「验证依据」列的可信度分级**（把「有护栏兜着」与「靠反推」区分开，不要一律当既成事实读）：

| 标记 | 含义 | 读者应如何使用 |
| --- | --- | --- |
| 无标记 | 有回归测试直接断言，或源码可当场核对 | 可当作事实 |
| `[推断]` | 原始报告已遗失，由代码注释与回归护栏**反推**得出；结论方向可信，但**严重度与时间是估计值** | 可用于定位，勿当作验收证据 |
| `[未确证]` | 仅见于间接引用，含义无法从残卷或代码复原 | 只知道「曾有此编号」，其余不可考 |

| 编号 | 严重度 | 问题 | 状态 | 验证依据 |
| --- | --- | --- | --- | --- |
| `SEC-01` | 🔴 严重 | 存储桶写接口缺管理员鉴权 | ✅ 已修复 | 路由白名单 + `updateBucket()` 不接受 provider |
| `SEC-02` | 🔴 严重 | 权限变更后会话不失效 | ✅ 已修复 | `index.js` 实时 `findUserRawById()`，用户不存在即销毁会话 |
| `SEC-03` | 🟠 高 | `/config/verify` 盲 SSRF | ✅ 已修复 | `requireAdmin` + `endpoint-guard`；实测 7 类攻击端点全拒 |
| `SEC-04` | 🟠 高 | `.gitignore` 灾难性回溯 | ✅ 已修复 | 重写为线性 DP；实测最坏 7.6ms/次（**测量口径**：当时的本机一次性实测，Windows / Node 22 / x64 单线程同步执行。它**不是护栏断言**——护栏用确定性探针而非墙钟阈值（见「四、测试 → 2. 测试护栏编写约定」），换机器会有量级差异，请按「不再随输入规模爆炸」理解） |
| `SEC-05` | 🟠 高 | 同步 scrypt + 无限流 | ✅ 已修复 | 账户口令 / 分享口令 / 查看口令路径均无 `scryptSync`。**导出码 KDF 曾漏网**：R38 引入 `backup.js` 时用的是同步 `scryptSync`，而本栏原文写「全库无 `scryptSync`」——判据与代码相反，且 `tests/` 里没有任何机器在验证它；R74 已改为异步 `crypto.scrypt`。现有两道机器判据：`tests/invariants.test.js`「SEC-05：全库不得出现同步 scrypt」（`espree` AST 判定，含违规样例自检）+ `tests/audit74-regressions.test.js` R74-01（`setTimeout(0)` 必须能插进 `seal()` 完成之前）、R74-04（路由必须 `await` `seal`/`open`）。WebDAV 按 IP、Hello 注册、/auth/init 均有限流 |
| `SEC-06` | 🟡 中 | CSP 含 `unsafe-inline` | ✅ 已修复 | 已移除并补 `object-src`/`base-uri`/`form-action`；前端无内联处理器 |
| `SEC-07` | 🟡 中 | 日志/ACL/会话接口越权 | ✅ 已修复 | `/stats/logs`、`/acl-check` 挂 `requireAdmin`；`/fs/sessions` 按 `createdBy` 过滤 |
| `SEC-08` | 🟡 中 | 分享下载是副作用 GET | ✅ 已修复 | 限流 + `share-origin.js` 纯函数分层判定；行为测试覆盖 7 种组合 |
| `SEC-09` | 🟡 中 | 元数据被空表覆盖 | ✅ 已修复 | 行为测试：损坏必抛错、拒绝写入、留 `.corrupt-*` 备份 |
| `SEC-10` | 🟡 中 | 分享令牌不绑密码 | ✅ 已修复 | 行为测试：改密码/清密码/跨链接均失效 |
| `SEC-11` | 🔵 低 | WebAuthn 挑战不绑用户 | ✅ 已修复 | 行为测试：`challenge_user_mismatch` |
| `SEC-12` | 🔵 低 | WebDAV 口令可逆存储 | ✅ 已修复 | 该风险已在 `1.6 WebDAV 口令为可恢复加密` 与 `3. 威胁模型与不设防边界` 显式文档化。残卷原文写作「README 威胁模型章节标注 SEC-12」，与实际不符：README 无该章节，全库亦无 `SEC-12` 字样标注 |
| `SEC-13` | 🔵 低 | `/auth/init` 无保护 | ✅ 已修复 | `initLimiter` + 进程内互斥 + 临界区内二次检查 |
| `SEC-14` | 🔵 低 | 规则 ID 用 `Math.random` | ✅ 已修复 | 源码检查：无 `Math.random`，用 `crypto.randomBytes` |
| `FUN-01` | 🟠 高 | 上传 `.json` 必然失败 | ✅ 已修复 | raw 解析先于 `express.json`；实测 `isBuffer: true` |
| `FUN-02` | 🟠 高 | 信号量双重释放 | ✅ 已修复 | 行为测试：重复释放不漂负、达上限必排队 |
| `FUN-03` | 🟠 高 | 分片 complete/abort 用错凭据 | ✅ 已修复 | 两处均改 `getClientForSession(sess)` |
| `FUN-04` | 🟡 中 | 前缀删除截断 + 元数据先清 | ✅ 已修复 | `fs.js`/`buckets.js`/`fs-gateway.js` 三处均循环删除 + 截断时保留元数据（R23-03 起三份实现收敛为 `gateway.deletePrefixAll()` 一份） |
| `FUN-04b` | 🟡 中 | WebDAV 删目录同型残留 | ✅ 已修复 | `fs-gateway.deletePrefix` 收敛为同一契约；`removeMetaPrefix` 已从全库彻底删除（护栏全库扫描） |
| `FUN-05` | 🟡 中 | 批量复制无回滚 | ✅ 已修复 | `aborted` 标志 + `rollback` + `partial` 明细 |
| `FUN-06` | 🟡 中 | WebDAV 未校验挂载前缀 | ✅ 已修复 | 统一前置中间件 + `Destination` 校验主机与前缀。注意同号异义（见 6.2） |
| `FUN-07` | 🟡 中 | WebDAV 复制不支持大于 5GB | ✅ 已修复 | 网关 `copyObject` 引入 `COPY_SIMPLE_LIMIT` + `sliceCopyFile` |
| `FUN-08` | 🟡 中 | 白名单回溯 8 条漏判 | ✅ 已修复 | 区间归一化；5000+ 探测点穷举对照零差异 |
| `FUN-09` | 🟡 中 | 跨厂商密钥串访 | ✅ 已修复 | 真实逻辑修复：已知厂商无同厂商密钥即 `return null`。注意同号异义（见 6.2） |
| `FUN-10` | 🟡 中 | HEAD 定时器泄漏 | ✅ 已修复 | 抽出 `_head()`，响应到达即 `clearTimeout` |
| `FUN-11` | 🟡 中 | magic 无完整性校验 | ✅ 已修复 | 行为测试：篡改密文必报错，历史文件向后兼容 |
| `FUN-12` | 🔵 低 | `/users/me` 原始记录回退 | ✅ 已修复 | 删除 `\|\| fresh` 分支，未找到即 404。注意同号异义（见 6.2） |
| `FUN-13` | 🔵 低 | `safeView` 口径不一致 | ✅ 已修复 | 复用 `listBucketsFor()`。注意同号异义（见 6.2） |
| `FUN-14` | 🔵 低 | 移动/重命名可能静默覆盖 | ✅ 已修复 | 抽出 `assertNoConflict()`，rename 与 move 的文件/目录全分支覆盖，断言先于写入 |
| `FUN-15` | 🔵 低 | `activeBucketId` 全局污染 | ✅ 已修复 | 隔离已达成（普通用户切桶只写会话、不污染全局）；原缺口已闭合：`effective()` 改走 `resolveEffectiveBucket()`（`config-store.js`），`get()` 委托 `effective()`，`requireConfig()` 与全部 `/api/fs/*` 操作读端同源；`tests/audit-regressions.test.js` 校验 `listBucketsFor` / `safeView` / `get` / `effective` 四读端同源 |
| `PERF-01` | 🟡 中 | 碎片列举短缓存：命中即免云端调用，分片写操作立即失效 | ✅ 已修复 | `[推断]` 见 `6.3 不再完整立档的遗失项` 反推 |
| `PERF-02` | 🟡 中 | 配置落盘去抖合并：连续变更合并为一次写，关闭去抖后恢复逐次写 | ✅ 已修复 | `tests/audit6-regressions.test.js` |
| `PERF-03` | 🟡 中 | 分片加密 5 份缓冲 | ✅ 已修复 | 窗口化密钥流；14210 组穷举差分零差异。注意同号异义（见 6.2） |
| `PERF-04` | 🟡 中 | 列举上限过大 | ✅ 已修复 | `limits.js` 集中化，`HARD_MAX=50000`、`DELETE=5000`。注意同号异义（见 6.2） |
| `PERF-05` | 🟡 中 | 统计缓存单槽 | ✅ 已修复 | 改为按 `bucketCacheKey` 的 Map + LRU。注意同号异义（见 6.2） |
| `PERF-06` | 🟡 中 | 统计写放大 | ✅ 已修复 | 行为测试：1000 chunk 仅 ≤2 次写统计，字节数仍精确。注意同号异义（见 6.2） |
| `PERF-07` | 🔵 低 | 日志全量同步读写 | ✅ 已修复 | 异步化 + 未超限不碰磁盘 |
| `PERF-08` | 🔵 低 | gzip 无背压 | ✅ 已修复 | 超限即透传 + 无条件 `Vary` |
| `PERF-09` | 🔵 低 | 下载流双消费者 | ✅ 已修复 | 改用显式 `Transform` |
| `PERF-16` | 🔵 低 | 加密 Range 缓冲区上限收敛（峰值 384MB → 96MB） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `LOW-21` | 🔵 低 | 凭据视图不再回传 SecretId 尾号（减少密钥标识外泄） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `LOW-26` | 🔵 低 | 未捕获异常不能只打印就继续服务 | ✅ 已修复 | `server/index.js` |
| `LOW-28` | 🔵 低 | `/fs/list` 单页上限取自 `limits.js`（旧实现硬编码 1000） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `S1` | 🟠 高 | 明文链路防护：HTTPS 强制与 HSTS | ✅ 已修复 | `[推断]` `server/index.js`（含义自代码反推，报告已遗失） |
| `S2` | 🟡 中 | 匿名暴力破解防护：认证失败冻结 | ✅ 已修复 | `server/share-routes.js` |
| `S4` | 🟡 中 | 敏感 JSON 统一加密落盘（兼容历史明文、读取时自动升级）；`enc.key` 落盘后收紧为 0600；复用同一主密钥 | ✅ 已修复 | `secure-store.js`、`enc-store.js`、`ip-guard.js`、`share-store.js`、`upload-sessions.js`、`config-store.js` |
| `S5` | 🔵 低 | 令牌仅经请求头传递（避免出现在历史、Referer 与访问日志） | ✅ 已修复 | `server/routes/fs.js`、`public/js/enc.js` |
| `S6` | 🟡 中 | 基础安全响应头（API 与静态资源全覆盖；`frame-ancestors` 替代 `X-Frame-Options`） | ✅ 已修复 | `server/index.js` |
| `S7` | 🟡 中 | 恒定时间字符串比较（各自取 SHA-256 再比） | ✅ 已修复 | `server/config-store.js` |
| `S8` | 🔵 低 | 同源校验头：非简单请求要求 `X-Requested-With` | ✅ 已修复 | `server/index.js` |
| `S9` | 🔵 低 | 私钥文件权限收紧（`local-cert.js`；**R49 随自签名证书一并移除** —— 改为「只加载自备证书、不生成也不改写」，那条写入路径本身就不存在了）／错误信息分类化、不外泄内部字段（`s3.js`）。同号异义 | ✅ 已修复 | `server/tls-cert.js`、`server/s3.js` |
| `S10` | 🟡 中 | IPv6 私有/保留地址判定（回环、ULA、链路本地等） | ✅ 已修复 | `server/ip-guard.js` |
| `S11` | 🟡 中 | 会话数上限与强制登出（超出即淘汰最早；支持登出某用户全部设备） | ✅ 已修复 | `auth-session.js`、`routes/auth.js`、`routes/users.js` |
| `S12` | 🟡 中 | 日志详情清洗：防止污染 JSONL 文件 | ✅ 已修复 | `server/stats-store.js` |
| `P1` | 🟡 中 | 落盘异步化：加密密钥、安全存储与统计写入不阻塞事件循环（原子写） | ✅ 已修复 | `enc-store.js`、`secure-store.js`、`stats-store.js` |
| `P2` | 🔵 低 | 含义未确证：仅见于「日志缓冲合并写入」等间接引用，应与日志/统计落盘相关 | ✅ 已修复 | `[未确证]` `server/stats-store.js`（据此推定，无直接证据） |
| `P3` | 🟡 中 | 多桶统计并行（带并发上限）+ 优先官方 `?stats` 接口 | ✅ 已修复 | `server/routes/_shared.js` |
| `P5` | 🟡 中 | 国内 IP 段按起始地址升序 + 二分查找 | ✅ 已修复 | `server/ip-guard.js` |
| `P6` | 🟡 中 | 网络异常时请求不永久挂起（默认 120s） | ✅ 已修复 | `server/s3-client.js`、`server/azure-client.js`（R49 前唯一落点是 COS SDK 的 `Timeout`，随 SDK 移除后落到两个自研客户端） |
| `P7` | 🔵 低 | 下载类响应超时（无数据活动时 10 分钟） | ✅ 已修复 | `server/download-stream.js` |
| `P8` | 🟡 中 | 密文流背压 + WebDAV PUT 全量缓冲上限收敛（512MB → 128MB） | ✅ 已修复 | `enc-store.js`、`fs-gateway.js` |
| `P10` | 🔵 低 | 静态 JS/CSS 允许 5 分钟强缓存（配合 ETag） | ✅ 已修复 | `server/index.js` |
| `P11` | 🔵 低 | 会话落盘「加密 + 按文件维度串行原子写」 | ✅ 已修复 | `server/upload-sessions.js` |
| `P12` | 🔵 低 | gzip 压缩必须早于路由与静态中间件注册 | ✅ 已修复 | `server/index.js`、`server/gzip.js` |
| `P13` | 🔵 低 | 配置解密缓存带 60 秒 TTL | ✅ 已修复 | `server/config-store.js` |

> **编号缺口**（两条性质不同，不再混为一谈）：
>
> - **S 系列缺第 3 号 —— 刻意避开，可核实**：S3 是对象存储协议名（S3 兼容协议 / AWS S3），全库出现数百处。把它登记成编号会让「S3」这个 token 在文档与代码里彻底歧义；护栏 `docs-sync` 里的噪声集 `AUDIT_ID_NOISE` 正是为此把 S3 排除在编号识别之外。**判据可当场验证**：把 S3 从噪声集移除，「台账登记的编号都能在代码中找到引用」会立刻报红。
> - **P 系列缺第 4、9 号 —— 原因不可考，不声称是设计**：残卷未收录这两号的任何描述，代码中也没有引用痕迹。此处据实标注为「不可考」，而不是含糊地归为「刻意设计」——**无法核实的设计意图与遗失没有区别**，写成前者只会让读者以为有据可查。

## 6.2 同号异义登记（已在 6.5 建立别名层）

同一个编号被用于互不相关的发现。这也是 6.1 要求新引用带轮次/日期限定、不能只靠一张 ID 表解析编号的原因。

| 编号 | 主表登记的发现 | 代码里另作他用的地方 |
| --- | --- | --- |
| `FUN-01` | 上传 `.json` 必然失败（请求体解析顺序） | IP 守卫 HTML 提示页分支恒抛 `ReferenceError` 被吞成 500（`ip-guard.js`）；订单读取失败标志（`payment-orders.js`） |
| `FUN-06` | WebDAV 未校验挂载前缀 | 不再顺手改写全局当前密钥/当前桶（`config-store.js`）；统计文件损坏护栏（`stats-store.js`）；新增桶不再自动设为当前桶（`routes/buckets.js`、`routes/config.js`） |
| `FUN-09` | 跨厂商密钥串访 | `gitignore` 参数缺失导致上传排除失效（`routes/fs.js`）；前端同名引用（`explorer.js`、`upload.js`） |
| `FUN-12` | `/users/me` 原始记录回退 | **7 处**指「无界 Map / 条目只增不减」：`ip-guard.js`、`list-cache.js`、`security.js`、`routes/_shared.js`、`share-routes.js` |
| `FUN-13` | `safeView` 口径不一致 | 写盘失败必须让内存缓存失效（`config-store.js`）；日志轮转被缓冲饿死、`logs.jsonl` 无界增长（`stats-store.js`） |
| `SEC-04` | `.gitignore` 灾难性回溯（该处带日期限定） | `/s/*` 非安全方法同源校验（`share-routes.js`，无日期限定） |
| `S9` | 私钥文件权限收紧 | 存储服务错误信息的分类化提示（`s3.js`） |
| `PERF-03` | 分片加密 5 份缓冲（密钥流窗口化） | 轮询定时器句柄必须保存并可停止（`public/js/main.js`） |
| `PERF-04` | 列举上限过大 | 前端请求序号（`public/js/bucketmgr.js`、`dashboard.js`） |
| `PERF-05` | 统计缓存单槽 | 单次渲染的 DOM 条数上限（`public/js/explorer.js`） |
| `PERF-06` | 统计写放大 | 上传会话去抖窗口内进程被强杀会丢元数据（`upload-sessions.js`、`index.js`） |

> **未穷举**：上表覆盖已机械扫描并人工确认的冲突；若某编号的引用文件跨越了互不相关的模块，值得按同样方法复核。

## 6.3 系列清单与不再完整立档的遗失项

**系列清单**：

| 系列 | 形态 | 来源 | 备注 |
| --- | --- | --- | --- |
| `SEC-nn` | 带连字符 | 自审 + 社区 | 安全类 |
| `FUN-nn`（含 `FUN-04b`） | 带连字符 | 自审 | 功能/正确性类 |
| `PERF-nn` | 带连字符 | 自审 + 社区 | 性能类 |
| `LOW-nn` | 带连字符 | 某一轮审计 | 低危类；残卷未收录 |
| `P-nn` | 裸编号 | 另一轮审计 | 性能系列 `P1`–`P13`，**与 `PERF-nn` 是两套独立编号**：`P3` 指多桶统计并行，`PERF-03` 指分片加密缓冲 |
| `S-nn` | 裸编号 | 另一轮审计 | 安全加固系列 `S1`–`S12`，**与 `SEC-nn` 是两套独立编号**：`S4` 指敏感数据加密落盘，`SEC-04` 指 `.gitignore` 灾难性回溯；S3 是协议名非编号 |

**原始台账已遗失**：早期审计报告不再可得，`AUDIT_FINDINGS.md` 本由一份留存残卷（`fix-record.md`）重建并逐条与代码核对，其中 §4（`PERF-01/02/16`、`LOW-21/26/28` 与裸编号 `S*`/`P*` 系列）残卷未收录、仅靠代码注释与回归护栏反推——**只保留结论，严重度与时间均为推断**。其含义已并入 6.1，此处不再单列「严重度半可信」的独立表。

## 6.4 历轮审计汇总（第 7–25 轮）

> 每轮都以「**对抗式验收上一轮修复 + 扫描新缺陷**」为主轴。第 7–13 轮的独立报告（`ANALYSIS-ROUND7~13.md`）已删除，本表只保留每轮的**范围/基线/发现数/核心结论/闭合**，细节不再立档。第 1–6 轮的独立护栏已并入 `audit-regressions` / `audit3` / `audit5` / `audit6`。**第 15、18–20 轮没有另立报告文件**，细节记在各自的护栏表格行（第 15 轮 → `invariants.test.js` 与 `deploy-script.test.js`；第 18 轮 → `deploy-script.test.js` 第 29–33 条；第 19 轮 → 第 34–38 条；第 20 轮 → 第 39 条）；另立护栏文件的轮次是第 16（`audit16-regressions.test.js`）、17（`audit17-regressions.test.js`）、21（`audit21-regressions.test.js`，原始报告 `ANALYSIS-ROUND21.md`）、22（`audit22-regressions.test.js`，原始报告 `ANALYSIS-ROUND22.md` + 复核报告 `ANALYSIS-ROUND22-VERIFY.md`）、25（`audit25-regressions.test.js`，功能新增而非审计）、26（`audit26-regressions.test.js`，功能新增而非审计）轮。下表的「发现数」一列在第 15、18–20 轮给的是 `scripts/reverse-check.js` 的**反向对照台账条目数**（D1/D2/D3 批次）与本轮报告条目数，第 16 / 17 / 21 / 22 轮给的是该轮报告条目数；**第 23 轮为外部独立评审**（不另立报告文件，两条修复的行为护栏并入 `s3-client.test.js` 与 `audit14-perf.test.js`）。

| 轮 | 定位 | 发现数 | 本轮最重要结论 |
| --- | --- | --- | --- |
| R7 | 首次对抗式扫描 | 15（R7-01~15）+ 4 文档漂移 D1~D4 | 分片会话漏记 provider、加密元数据先于云端写入被覆盖（二者都致密文不可解） |
| R8 | 深挖 + 验收 | 27 | 27 条中 10 条是「修一半」；微信签名参数错位、magic 大文件同步阻塞 3s、覆盖写残留元数据 |
| R9 | 验收到第 8 轮 | 10 | 7 条是「修复不完整」的产物；WebDAV 目录 COPY 自嵌套无界递归、S3 `<Error>` 被丢弃 |
| R10 | 验收到第 9 轮 | 11 + 1 | 4 条高危中 2 条是上一轮修复引入的；异步落盘被未声明变量打死、目录 MOVE 少一个尾斜杠 |
| R11 | 验收到第 10 轮 | 19 | 「整批 0 成功即停」的 `break` 只跳内层循环（一次失败放大成上千次云端往返） |
| R12 | 验收到第 11 轮 | 13 + 自审 4 | 首起真实数据事故：`npm test` 改写生产 `config.enc`；首次落地「纪律落到唯一实现点」 |
| R13 | 验收到第 12 轮 | 7 | 否掉 R12「可停止开新轮次」：测试仍写生产数据、「唯一实现点」护栏可被箭头函数绕过 |
| R14 | 验收到第 13 轮 | 24（高 3 / 中 11 / 低 10） | 护栏与**生产调用方脱节**：流式判据写成 `typeof === 'function'` 而生产四处传 `PassThrough`（测试与实现对齐、与需求脱节）；CSP 脚本源漏 `challenges.cloudflare.com` → 启用验证码即锁死全站登录；支付窗口内的 `pending` 被裁 → 钱付了拿不到文件。**截至 v1.1.7 已修 12（高 3 / 中 9）、余 12（中 2 / 低 10）**：P2 四条性能项按「一次收敛」抽成 `server/coalesce.js` 的去抖合并写 / 并发合并读两个原语，不再四处内联；同时补齐 R14-04 / R14-06 缺失的反向对照，并把「anchor 必须**唯一**命中」「纯注释 anchor 判违规」两条升为机器护栏（详见 `ANALYSIS-ROUND14.md` 第 4 节） |
| R15 | 部署脚本审计（D1 批次） | 23（台账 `D1-01`~`D1-23`） | 两个「台账全绿而实为假绿」的地基缺陷：① 共用的 `stripComments()` 把 shell 的 `/*`（`[[ x == /* ]]`、`modules-enabled/*.conf`）当成 JS 块注释起点，一路吞掉 330 / 16 / 85 行代码 → 落在那几段的反向对照 anchor 永远「未命中」、静态不变量也看不见那段代码；② `package.json` 加了 `devDependencies.eslint` 而锁文件未更新 → 任何机器 `npm ci` 必 EUSAGE 失败（部署第一枪打的就是它）。分别以「`deploy.sh` 里每个函数定义剥完注释后必须还在」与「照 `npm ci` 的校验逐字比对根条目 spec + 实体条目」两条结构性护栏钉住 |
| R16 | 验收 R15 + WebDAV 对外地址（D2 批次） | 5（台账 `D2-01`~`D2-05`） | 现场故障：反代部署下界面恒显示 `https://localhost:8443/dav/`，客户端照填连不上。三条咬合契约：`serverUrl(req)` 按「`WEBDAV_PUBLIC_URL` → 请求域名（仅 `TRUST_PROXY=1` **且确有转发头**）→ 直连回退」逐级取值，经反代时不得出现 `localhost`；路由层 5 处 `webdavView` 调用**必须传 `req`**（不传就静默退化成监听地址）；Nginx 模板**默认**就把 `/dav` 反代到 `WEBDAV_PORT`（留成注释 = 界面给出的地址撞 404）。`/dav` 反代走的是回环，故 IP 白名单无需改动（回环永远放行） |
| R17 | 反代取 IP / 支付地址校验 / async 兜底 | 4（高 1 / 中 1 / 低 2） | 默认部署（Nginx 反代 + `TRUST_PROXY=1`）下 IP 守卫只读 `socket.remoteAddress`、恒见 `127.0.0.1` → 命中 `evaluate()` 首条「本机永远放行」短路，**黑名单 / 国内白名单 / 按桶屏蔽海外 IP / WebDAV 全部静默失效**（取 IP 收敛为唯一实现点，且转发头来的地址不再享回环豁免）；支付宝 `gateway` 未过 `assertSafeEndpoint()` → 开放重定向 + 服务端 SSRF（唯一一处漏过 `endpoint-guard` 的对外地址）；「站点对外地址」只查形状 → 经支付网关背书的开放重定向；8 处 async 处理器抛错即**请求永久挂起**（Express 4 不接 async rejection）→ 统一 `asyncHandler`。四条均已修复并登记反向对照 |
| R18 | 重装把正式证书降级为自签名（D3 批次） | 5（台账 `D3-01`~`D3-05`） | 现场故障：选「重新安装」后日志先打「已存在 ZeroSSL 的 ACME 账户，跳过注册」，紧接着 `[错误] 命令执行失败（退出码 2）`，**SSL 退回服务器自签名**。根因是两件本该互相独立的事被混在一条路径上：① acme.sh 的 `RENEW_SKIP=2`（证书未到续期时间）是**成功语义**，旧 `issue_acme_sh` 用裸 `run` 判「非零即失败」；② 证书已装好且仍在有效期内时，重装根本不该再跑一遍申请——它可能失败（配额/网络/EAB），一失败就接 `gen_self_signed`。修法：`run_allow_rc 2` + `acme_issue_skipped`（退出码与措辞双证据）、`tls_cert_reusable`（`openssl x509 -checkend`，阈值 `CERT_REUSE_MIN_DAYS=30` 落在 acme.sh 的 60 天续期窗口内）、逃生门 `--force-cert`，且可复用来源只认 `ACME_CERT_DIR` |
| R19 | 自动安装 git 失败（RHEL 8 module failsafe，D3 批次续） | 9（台账 `D3-06`~`D3-14`） | 用户原话：「脚本自动安装 git 失败。**这种最基础的操作不应该出问题。**」报错是 `git → perl-Git → perl-libs` 被静默屏蔽（`none of the providers can be installed` / `filtered out by modular filtering`）。两条被推翻的假设值得单独记：① 旧实现**已经能识别**这是模块流问题，却只把 `dnf module reset perl` 打印给用户去敲，而 git 走**可选**通道、装不上只降级不中断——重装时 `prepare_source` 才发现没有 git，整个部署卡在拉源码那一步；② 第一版修复把它当成「模块流状态与仓库期望不一致」，于是只做 `module reset` + `module enable`。但用户补了一句**「即使是全新安装的纯净系统也出现这种情况」**——干净机器上模块流本来就是一致的，`reset`/`enable` 全是**空转**。真正的机制是 RHEL 8 的 module failsafe：按模块的包级过滤清单屏蔽 `perl-libs`，与机器上的模块流状态无关。定案：把「识别原因」与「动手修」收敛到同一个判据（`pkg_failure_kind` 为唯一实现点，并认 `modulefailsafe`/`module_hotfixes` 措辞），然后按**代价从小到大**逐档试——① `dnf install -y --setopt='*.module_hotfixes=true'`（仓库按包级视图求解，**只影响本次事务、零持久副作用**，且对纯净系统是唯一对症的一档）② 才轮到 `module reset`/`module enable`（**全局**改机器模块状态，副作用大）③ 最后 `--nobest`；必需/可选两个通道都接上。边界：只对能确定原因的失败动手，解析不出被过滤的包时**一个 module 操作都不做**（但零副作用的绕过过滤允许试一次）；`--skip-broken` 一律禁用（它让「装不上」返回 0，把错误吞进返回码）。两处易被"顺手简化"的细节已上护栏：那个 `*` 的**引号**（不引会被 shell 当通配符展开成文件名）、以及 `module reset` 不得再回到诊断的第 1 条。附带把最显眼的 `Invalid configuration value: failovermethod=…` 明确标注为**无害警告**（旧版 yum 选项，dnf 不支持，与失败无关） |
| R20 | SSL 证书「签发成功但浏览器不安全」（证书字段全空白） | 2（台账 `D3-15`~`D3-16`） | 现场：脚本报「ZeroSSL 证书签发成功」，浏览器却判**不安全**、点开证书信息**所有字段都是空白**。先钉住一个实测事实：`openssl req -x509 -subj "/"` 会产出一份**合法但 subject 与 issuer 全为空**的证书 —— `openssl x509 -noout -subject` 的输出就是 `subject=`（等号后为空），而 `nginx -t` 照样通过。旧实现的成功判据只有 `[[ -s ]]`（文件非空），于是这种「浏览器根本用不了」的证书被一路当成**签发成功**送到用户面前。修复分两半，正对应「坏在哪」的两种可能：① **内容关**（`cert_file_ok`，唯一实现点）—— 必须能解析出 subject 与 issuer 且**都有实值**，且证书公钥与私钥**配对**；签发安装 / 复用判断（`tls_cert_reusable`）/ 自签名生成**三处都要过这一关**，少一处坏证书就从那条路径漏过去（复用处漏掉的后果最重：坏证书会被**每次重装永久复用**，怎么重装都修不回来）。② **生效关**（`tls_probe_served`，挂在 `setup_tls` 收尾）—— `nginx -t` 只证明**我们写的配置能被解析**，证明不了**浏览器连上来看到的就是这份证书**：SNI 不匹配（用 `www.` 访问却只写了主域）会退回 443 上的 default_server，而面板/旧站点常在那里放一份字段全空白的自签证书；前面挂了 CDN 时浏览器看到的更是 CDN 侧那份。故收尾必须带 `-servername` 取本机 HTTPS 端口**实际提供**的证书、按 SHA-256 指纹与本地文件比对，并在**不一致时点名**「443 上还有别人的 default_server」、给出三条排查顺序 —— 把「脚本说成功、浏览器说不安全」这种不可见的错配变成一行可读的事实。 |
| R21 | 分享链路的加密闸门 / 认证口径 / 缓存键 / SSRF 跳转 / 部署跳转目标（第 20 轮后的全量扫描 + 逐条复核） | 15（中高危 1 / 中 2 / 低 10 / 信息 2） | 最重要的一条：**「查看密码」闸门只挂在网盘侧（`/fs/download`、`/fs/head`），分享下载路径 `/s/:id/dl` 完全没有这道关** —— 任何人拿到分享链接（无需知道查看密码）都能取走密文对象，而 README 承诺「设置查看密码后查看 / 下载加密文件前须验证」。修法是给分享链路补一层与网盘侧同口径的闸门（`GET /s/:id` / `HEAD /s/:id/dl` / `GET /s/:id/dl` 三处；解锁走 `POST /s/:id/unlock`，令牌经 Cookie 复用，仍受 `encStore` 的 30 分钟 TTL 与登录端口径一致的限流 / 锁定约束），而不是在下载端点里再写一份判据。其余 14 条按「确认→修 / 前提修正 / 登记缺口 / 遗留待办」四类处理：**修 10**（`share-routes` 复用订单回调地址误用请求体渠道、WebDAV 写入无独立并发上限 `MAX_WRITE_STREAMS`、Windows Hello 登录失败两分支可区分 → 用户名预言机、自助改密不校验当前密码、实例锁 TOCTOU 把新鲜空锁当陈锁、列举缓存 / 搜索候选集键未消毒 `\u0000` 分隔符而可串味、S3 客户端与支付网关跟随 3xx 重定向 → 盲 SSRF / 带凭据请求被引导、`HOST=0.0.0.0` 时 HTTPS 跳转 301 到 `https://0.0.0.0:3443`、WebDAV 错误响应回显上游原始 `message`、`SCAN-SKIPLIST.md` 版本号与文档引用漂移）；**前提修正 1**（`permissions` 字段「死字段」之说已被 `Develop_Document.md`（第 676 行）明文披露「仅原样存储与回传、不参与鉴权」，故非隐蔽缺陷，不改代码）；**登记缺口 1**（`npm audit` 依赖漏洞快照 —— 离线不可复核，记入 `SCAN-SKIPLIST.md` 的 SK-19）；**遗留待办 2**（支付宝 / 微信查单响应未验签、PayPal webhook 无法本地验签 —— 二者都需真实网关证书 / 官方验签 API，本轮先记入待办）。R21-13 顺带把「明文 → HTTPS 跳转目标」收敛为 `security.httpsRedirectHost()` 唯一实现点，并据此更新了 R17-03 的结构化断言（判据仍同源，只是调用点从 `index.js` 移到 `security.js`） |
| R22 | 对第 21 轮修复的对抗式复核 + 补完 | 6（中高 2 / 中 2 / 低 2；独立复核 6/6 成立） | 三条是「上一轮只修了一半」：① Windows Hello 登录的**第三支**（用户存在 **且** 已启用 Hello）仍回 `publicReason(r.reason)` + `reason` 键 —— R21-05 只收敛了 3 支中的 2 支，而这一支的可达前提恰好是「用户名存在且启用了二次验证」（通常=管理员），比 R21-05 修的「是否启用」更精确 → 并入 `authFail`，`reason` 只进服务端日志；② `webdav-server.js` 同型六处错误出口只接了 2 处，PROPFIND / MKCOL / DELETE / COPY 仍裸发上游 `message`（R21-14 的护栏只驱动**纯函数** → 撤掉那 4 处不变红）→ 四处一并收口，并把护栏改到**调用点层**（静态不变量覆盖 `.send(e.message)` 与 `.send(cond ? '404 Not Found' : e.message)` 两种同型写法 + 四个出口各一条反向对照）；③ `X-Forwarded-For` 虽已收口到 `security.clientIpInfo`，但取值**取首段且不校验格式**，而 `deploy.sh` 生成的反代片段用 `$proxy_add_x_forwarded_for` **追加**（首段 = 请求方原样送入的值）→ 一个内网或不可解析地址即可让黑名单 / 海外屏蔽 / 全部按 IP 限流按伪造值判定；本轮把部署侧改为 `$remote_addr` **重写**，并在取值处加 IP 字面量校验（非法值判为「未知且不享回环豁免」—— 否则轮换非法串就能重置限流 / 锁定预算）。另三条是口径类：WebDAV 出口「不叠加查看密码」这一归属此前**未在文档声明**（三个解密下发出口口径不一致）→ README 与开发文档写明同一口径，并与代码事实**双向绑定**；README 的「令牌仅经 `x-enc-token` 请求头传递」与 R21-01 新增的分享页 Cookie 通道相矛盾 → 两条通道各自限定作用域；`httpsRedirectHost()` 的注释与实现顺序相反 → 改注释与实现逐项同序。收尾另处置：`SCAN-SKIPLIST.md` 已不在工作区（该清单未纳入 git），其版本漂移护栏改为「文件缺失即跳过」，并把对应反向对照条目**退役留痕**（否则会连带把 `invariants.test.js` 的 anchor 自检拖红，把真实失效藏在环境噪音里） |
| R23 | 外部独立评审（四路并行专项审查 + 交叉复核） | 2（高 2）+ 3 项结构性 / 文档性整改（R23-03~05） | 两个高危**都落在测试盲区**，恰好又一次复现本节末的元规律（"全绿"不等于没有缺陷）：① `multipartUpload` 只从响应**体**解析 ETag，而 S3 的 `UploadPart` 成功响应**体为空**、ETag 只在 `ETag` 响应头 → 空串被存进会话、`multipartComplete` 提交 `<ETag></ETag>` → 云端 `InvalidPart`，**五家 S3 兼容厂商（阿里云 OSS / 华为云 OBS / 七牛 / 又拍云 / AWS S3）所有 >8MB 文件在最后一步必失败**；腾讯云走原生 SDK、不经此处，故"只测腾讯云"时从不暴露，且 `tests/s3-client.test.js` 对 multipart 零覆盖、桩一律返回带 body 的响应（`putObject` 同病：ETag 恒空、`headers` 恒为 `{}`）。修法见 `R23-01`（ETag 改为**响应头优先、响应体兜底**，`putObject` 一并回传真实响应头）。② `coalesce.writeNow` 用**同步** try/catch 包**异步**写，且 `dirty` 在调用前已清零 —— 写失败既进不了 catch，默认写入器 `writeJsonAsync` 又自带 `.catch` 吞错（Promise **从不拒绝**）→ 变更被静默丢弃，且后续 `flush()` 与退出同步落盘都因 `!dirty` 直接跳过（支付订单的 `paid` 退回 `pending`）；同族更重的一处是 `enc-store` 的 `metaSavedSeq` 在失败时照样推进序号，而 `enc-meta.json` 是**解密的唯一凭据**、`flushMeta()` 会因此跳过同步落盘。修法见 `R23-02`（`writeJsonAsync` 改为 `Promise<boolean>` 交出可判定失败信号、失败置回 `dirty` 并留痕、`enc-store` 只在 `ok !== false` 时推进序号）；两条修复的行为护栏分别并入 `s3-client.test.js` 与 `audit14-perf.test.js`，不另立文件。另附带 1 处**护栏静默失效**（工具缺陷，非产品缺陷）：`scripts/reverse-check.js` 的失败数解析只认 TAP 的 `# fail N`，而 Node ≥ 22 起默认 reporter 输出 `ℹ fail N` → 本机 Node 24 下**每条**反向对照都被判成 `fail=-1`（既有条目 `R14-08` 同样如此，与变异正确性无关），已改为两种格式都认——否则「撤掉修复必须变红」这条纪律会整体失去效力；③ **R23-03**：`deletePrefix` 曾有**三份同构实现**（`routes/fs.js` 一份、`routes/buckets.js` 的 `trackedDeletePrefix`、`fs-gateway.js` 一份）—— 这正是 R10-03（白名单判据）与 R11-01（整批 0 成功即停）各自「修三遍」的病灶；现收敛为唯一实现点 `gateway.deletePrefixAll()`，三条入口共用，同时删掉 `adjustStorageCache` 的两份懒加载包装（唯一实现留在 `routes/stats.js`），并把该实现点登记进 `invariants.test.js` 的 CANONICAL_IMPLS（无第二份定义 + 逐入口接线 + `stalled` 判据不许退化）；反向对照随之迁移：R11-01 的锚点改指 `fs-gateway.js`（判据不变），R7-03 的锚点随回调形态更新（缩进由 8 空格变 4 空格、参数名由 `res.okKeys` 变 `keys`，同一条纪律）；④ **R23-05**：文档与目录树曾声称存在 `.github/workflows/ci.yml` 并描述其 Linux/Windows 多平台矩阵，而仓库里根本没有 `.github` 目录 —— 已从树中删除该条目、正文改为如实说明「当前不提供 CI，提交前请本机执行 `npm test` / `npm run lint`」，并给 `docs-sync` 新增「**目录结构里列出的仓库文件必须真实存在**」断言（附 `TREE_EXEMPT` 豁免机制与「解析到的文件数不得少于 30」的下界自检），此后同类漂移必然报红。**CI 本身仍是待办**（本轮按维护者要求暂不新增 `.github/`，故只做文档闭合，不做虚假声明）；⑤ **R23-04**：路由层「async 处理器 + 标准错误响应」收敛为唯一实现点 `_shared.apiHandler` —— `asyncHandler` 只解决「抛错不让请求永久挂起」，它把错误交给全局错误中间件，而那里**不跑** `translateError()`：用户会看到 SDK 英文原文，且**上游 401 会被透传**（前端见 401 即强制登出 → 「重新登录→再被踢」死循环，违反 R11-04）。`apiHandler` 把「翻译 + 上游 401→502 + 落地响应」收进一处，历史 catch 里的日志副作用经 `onError` 保留（不许因收敛丢掉任何一条审计）。**迁移是渐进的**：本轮先落地唯一实现点并转换 `routes/fs.js` 的 `/fs/list`、`/fs/search` 两处，其余仍为自有 `try/catch` 的历史形态；同时新增静态护栏「**路由处理器不得裸奔**」——`server/routes/*.js` 中任何既无 `apiHandler`/`asyncHandler` 包装、又无自带 `try/catch` 的 async 处理器一律报红（Express 4 不捕获 async rejection，抛错即请求永久挂起），带扫描范围下界自检（≥50 个路由注册）与反向对照 `R23-04`（退回裸 async 必须变红），覆盖面含 `server/*-routes.js`（如 `share-routes.js`）。**全量迁移仍登记为待办**，不在本轮假装完成；并补一条**棘轮**护栏（`invariants.test.js` 的 `INLINE_ERROR_COPY_MAX` 冻结内联副本总数、只许减不许增，带判据正/反样例自测与反向对照 `R23-04（棘轮）`）—— 防止新代码再复制第 N+1 份两行 catch（本项目「同一逻辑多份实现必然改一半」的病灶） |
| R24 | P2 安全加固批次（外部评审的中危项落地；维护者指定） | 4（中 4）+ 2 项待办（M4 / M5） | ① **R24-01**：`siteUrlFor` 的回退路径**直接信任请求 Host** → 付费链接的任意访问者带自定义 `Host` 即可让 `notify_url` / `return_url` 指向自己的域（支付宝异步通知含签名与订单信息，等于把回调劫持走）。改为四级**可信**阶梯：**请求 Host 属本站 → 配置的主 / 备域名 → 本机 HOST（非通配，`http` 下补回监听端口以免回调地址缺 `:3000`）→ 返回空串由调用方拒绝下单**；判据复用 `isOwnSiteHost`，且优先级与 HTTPS 跳转**刻意相反**（回调地址要公网可达，故配置域名优先于本机 HOST）。② **R24-02**：WebAuthn 的 rpId / origin **无条件按请求 Host 推导** → 把域名解析到同一 IP 的钓鱼站可用 `attacker.com` 作为 rpId 完整代理「注册 + 登录」两步，WebAuthn「凭据绑定固定 RP」的防钓鱼属性被抵消。改为部署模式下 rpId 必须属本站（**回环单独放行**：远端攻击者无法把受害者浏览器的 Host 写成回环地址），不可信即 **fail-closed 抛错**；`POST /auth/login/webauthn` 的判定刻意放在**与用户名无关**的位置，避免给这个匿名可达端点新增用户名 oracle。③ **R24-03**：AES-256-GCM 分段解密**只读密文流里的 IV / TAG，从不与本地元数据比对** → 能写云端对象者可重排等长分段（multipart 分片常态即等长）或拼接另一对象的分段，逐段认证**全部通过**、静默产出被重排的「合法」明文 —— 与本函数「任何篡改都会报错」的承诺直接矛盾。改为**按位置逐段比对元数据 IV 与 TAG**（同时钉住顺序与内容；历史元数据缺 iv/tag 时跳过比对，保持向后兼容）。④ **R24-06**：CSRF 原判据是**单点**（只认 `X-Requested-With`），依赖「浏览器不让跨站请求伪造自定义头」这一事实 —— 一旦引入 CORS 或反代补头就**静默失效**且无症状。补一层**同源校验**：请求带 `Origin`（其次 `Referer`）时，其主机必须与本次请求的 `Host` 一致（`Origin: null` 直接拒绝；两者皆缺时放行 —— curl / wget 这类直连客户端不在浏览器跨站的威胁面内）。四项均带行为护栏与反向对照（`R24-01` / `R24-02` / `R24-03` / `R24-06` 全部验证「退回旧实现即变红」）。**待办 2 项**：M4（`endpoint-guard` 不做 DNS 解析 → DNS rebinding，需显式开关）、M5（三处 scrypt 仍用默认参数，提升需兼顾存量哈希兼容） |
| R25 | 功能新增：负载均衡 / API Key 空间配额（维护者指定；非审计轮） | 8 条行为护栏（`R25-01`~`R25-08`）+ 15 条反向对照 | 在系统设置的「用户管理」与「文件加密」两卡片之间新增**仅管理员可见**的「负载均衡」卡片：列出全部 API Key（凭据），逐个设置其**最多可用空间**（`quotaBytes`，0 = 无限制），并以**风箱（折叠）样式**列出该 Key 下每个存储桶的用量（按大小降序、带进度条）。核心不在 UI，而在**判据落在哪一层**：① 「超出」必须**服务端权威**且在**所有写入出口**生效 —— 前端弹窗只是告知，真正的拒绝是 `403 + code=CREDENTIAL_QUOTA_EXCEEDED`，落点为 `/fs` 的 5 个写入口（`mkdir` / `rename` / `move` 用 0 增量判「已超限」、`upload/init` 用「目标大小 − 已传分片」的**净**增量、`upload/simple` 用请求体长度）、**新建桶**（`POST /buckets/local` 且为全新桶时）与 WebDAV 的 PUT / MKCOL / COPY / MOVE 四处（PUT 文件按 `Content-Length` 计入增量）；② 归属必须与**真正写入时选中的密钥同源**（`config-store.credentialIdForBucket` 内部走 `activeCredential`，而**不是**直接读 `b.credentialId` —— 桶未钉密钥时会随当前密钥漂移，读钉死字段会归错账）；③ **官方用量统计有 15 分钟缓存**（`?stats` 的 `sizeBytes`），若判定直接读缓存，用户可在 TTL 窗口内任意超额 → 引入「**待定增量台账**」`bucketPendingDelta`：写入时记增量、判定用「缓存值 + 待定增量」、**只在拿到新鲜样本时才清零**；为避免与桶统计缓存重复记账，增量只从**写入/删除的收口点**（`routes/stats.js` 的 `adjustStorageCache`）与 WebDAV PUT 处喂入，官方 `?stats` 回包本身**不再叠加**。跨模块复用与循环依赖的取舍：容量统计与配额判定从 `routes/*` 抽出为**根级** `server/bucket-stats.js`（`routes/* → routes/_context.js → webdav-server.js → fs-gateway.js → s3.js` 是单向链，WebDAV 不能 require `routes/_shared`，否则成环）。判据细节：`quotaBytes = 0` 即无限制（`normalizeQuotaBytes` 把非正 / 非有限统一归 0）、比较用**严格大于**（`used + add > quota`，用 `>=` 会让「正好用满」被误判）。护栏 `tests/audit25-regressions.test.js`（8 条）+ `reverse-check` 15 条 `R25-*`（全 `fail>=1`），且**每条闸门都配正向对照**（未超限照常放行），防「一律 403」这类把功能改死的假修复 |
| R26 | 功能新增：四家 S3 兼容服务商（维护者指定；非审计轮） | 9 条行为护栏（`R26-01`~`R26-08`）+ 19 条反向对照 | 以 S3 兼容协议接入 **Google Cloud Storage / Cloudflare R2 / MinIO / Backblaze B2**，并把「不同服务商要求不同参数」这件事**收敛到注册表**：注册表新增 `defaultRegion`（填了等价于没填的固定地域，如 GCS / R2 的 `auto`）、`forcePathStyle`（自建部署必须路径风格寻址）、`endpointMode`（`'required'` = 用户填完整地址 / `'template'` = 用户填模板里那个占位符的值）与端点栏文案。核心取舍有三处：① **参数承载复用 `endpoint` 字段**（不新增 schema 列），因此既有的 `assertSafeEndpoint` / `safeRegion` / 配置加密结构与 `safeView` 全部照旧生效；但**组装必须先于校验**，否则 R2 的账户 ID 会被端点守卫当成非法 URL 拒掉；② **组装只能有一个实现点** `providers.composeEndpoint()`，写入端（`config-store`）、预览端（`POST /config/verify`）与老接口（`PUT /config`）共用它；且必须**幂等** —— 表单回填的是库里已组装好的端点，再拼一次会得到 `…cloudflarestorage.com.r2.cloudflarestorage.com`：**语法完全合法**、不报错、只在连接时静默失败；③ **R2 的占位符在主机名最前**，与「地域填主机名中段」的常规推导方向相反 —— `endpointFor()` 对 `template` 厂商直接返回空串，否则 `regionFor('r2','')` 给出的 `auto` 会被拼成 `auto.r2.cloudflarestorage.com`（同样是合法假域名，只表现为「网络连接异常」，指不到真正的成因）。实现过程中由护栏抓出两条真实缺陷：**重新保存一条不带 `provider` 的 R2 密钥时按默认厂商组装**（账户 ID 送校验被拒 → 一次完全正确的保存失败）、以及**更新密钥时先落值后校验**（被拒绝的更新已在内存里把端点改坏）。另有两处「界面承诺 vs 服务端闸门」的口径分叉一并收口：建桶路由旧代码在**推导出厂商之前**就无条件要求地域（与界面上的「可留空」矛盾，用户只能胡乱填一个会真的进入签名串的值）、升级更新路径的 `POST /credentials`（旧实现无条件改写 `provider` / `endpoint`，一次「只改备注」的保存就把 R2 密钥回落成腾讯云并按别家规则重算端点）。**MinIO 的路径风格由三处协同**（元数据 → 客户端工厂 → `_virtualHosted()` 唯一判据），每处单独登记反向对照 —— 只钉住其中一处时，另外两处被摘掉照旧全绿。护栏 `tests/audit26-regressions.test.js`（9 条）+ `reverse-check` 19 条 `R26-*`（全 `fail>=1`）；其中 2 条在实现过程中先**变红**，对应上面两条真实缺陷 |
| R27 | 独立审计报告的 26 条修复（`审计报告-安全与功能缺陷.md` 的 `K-01`~`K-26`；本轮为**修复轮**，台账代号 `R27-01`~`R27-26` 与报告的 `K-*` **按序一一对应**） | 26 条（高 4 / 中 12 / 低 10）+ 13 条行为护栏 + 1 条反向对照改锚 + **13 条反向对照补登** | 这一轮的入口是一份**外部独立审计**。它比历轮更尖锐的地方在于：**26 条里没有一条落在新功能面上，全部落在既有的、已被 26 轮护栏覆盖过的路径上** —— 且两条最重的（R27-04 / R27-05）恰好砸在本项目最新、最被强调的承诺「负载均衡 / API Key 空间配额」上。三条主线值得单独记： **① 配额的两处漏（高）**。R25 文档写的是「判定在**所有写入出口**生效 …… 不会因统计缓存（15 分钟）而在窗口内偷偷超额」，但分片路径实际只做到「init 时按**客户端声明**的 size 过闸门」：`chunk` / `complete` 既不核对也不记账，`complete` 最后还用 `sess.size` 记用量 —— 于是 `init(size=8MB+1, chunkSize=8MB)` + 传满 10000 片（约 78GB）能穿过闸门、且账面只涨 8MB（**R27-04**）。修法是把「实际字节」变成服务端自己算的事实：`setPart()` 多记一个**明文**字节数（云端 `ListParts` 给的是密文长度，不能当明文用）、`complete` 汇总核对（超出声明即 `400 + UPLOAD_SIZE_MISMATCH`）、记账改用实际值。第二处更隐蔽：非腾讯云厂商的桶容量只能走「分页列举兜底」，而该分支在**对象数 > 5001** 时返回的是**被截断的下界**，旧实现却无条件 `noteFreshSample()` 把「待定增量」一并清零 —— 那不是"数字略偏"，而是**每 15 分钟把唯一的补偿机制删一次**，管理员以为配了额度、实际没有（**R27-05**，改为 `estimated === true` 时保留增量，方向偏保守）。**② 「同一判据多份实现」的又一次复现（高）**。「本次请求在浏览器眼里是不是 HTTPS」在库里有 **4 份**写法：`siteUrlFor`、分享下载来源判定、WebAuthn origin 三处用了「`req.secure` 或（部署模式且 `TRUST_PROXY`）」这一表达式，唯独分享页的 `/s/*` 同源校验用了**裸 `req.secure`** —— 而 `deploy.sh` 装的就是 TLS 终结的 Nginx（`HOST=0.0.0.0` + `TRUST_PROXY=1` + `proxy_pass http://127.0.0.1`），本服务从不 `app.set('trust proxy', …)` ⇒ `req.secure` 恒 false，而 HTTPS 页面发出的 `Origin` 是 `https://host` ⇒ **同源请求被判成跨站**：`POST /s/:id`（访问密码）、`/s/:id/unlock`、`/s/:id/pay`、`/s/:id/pay/check` 在默认生产部署下**全部 403**。它是 fail-closed（不是绕过），但功能整体不可用；本地 `http://127.0.0.1:3000` 恰好匹配，所以开发与测试都照不出它（**R27-03**）。已收敛为 `security.requestIsSecure()` 唯一实现点。**③ 两条「一个字符 / 一个标识符」级别的失效**。前端的「重命名」在三个入口（工具栏 / F2 / 右键）上**完全无反应**：`ops.js` 调用的 `currentItems()` **全库从未定义**，抛错点又落在 `try` 之外、`renameSelected()` 不 await 也不 catch，于是整体退化成一个 rejected promise —— 不弹框、不提示（**R27-01**，修法是给 `explorer` 加一个只读访问口 `itemOf(key)`，列表项的唯一归属地仍是它私有的 `state.items`）。同时 `ops.js` 里那两处 `explorer.updateOpsButtons && …` 之所以"看着没事"，只是 `index.html` 恰好有 `<section id="explorer">`、靠 HTML Window 的**命名访问**把自由标识符解析成了 DOM 元素（`element.updateOpsButtons === undefined` → 静默 no-op）—— 它与 `currentItems` 属同一类隐式依赖，护栏对两者一并钉住；且它并非无用：`explorer.render()` 在「列表为空」与「面板隐藏」两条分支上会提前 return、不调用 `updateOpsButtons()`，此时只有它能把按钮置灰（**R27-02** 顺带把 `eslint` 缺的 25 个全局声明补齐，`npm run lint` 由「恒红 30 errors」变为 **0 errors** —— 门禁恒红正是这类缺陷长期无人发现的原因）。IP 侧同型：`parseTarget('1.2.3.4/')` 里 `Number('') === 0`，一个**多打的尾斜杠**把规则变成 `1.2.3.4/0`（匹配全部 IPv4），而规则由全局中间件执行 ⇒ 除回环外全网 403（**R27-09**）。其余逐条闭合，其中值得点名的还有：**XFF 校验放行结构非法的 IPv6**（`1::2::3` / `:::::` 能过 `isIpLiteral`，而 IP 守卫当时是 `if (info) {…}` —— 解析失败就**跳过全部规则**，等于一个请求头绕过所有屏蔽）→ 判据升级为「真的能解析」并**规范化**（`::ffff:0102:0304` 与 `::ffff:1.2.3.4` 必须归到同一个限流键；`01.2.3.4` 一类前导零写法一并拒掉，它曾把限流预算放大 81 倍），守卫改 fail-closed 并新增 `unparsable` 拒绝原因与专属文案（**R27-07**）；**AES-GCM 明文在标签校验之前就已 push 给下游**（而 `Content-Length` 早按明文长度声明）→ 能改写云端对象者翻转一位即可下发**等长**错误明文、再以优雅 FIN 收尾 ⇒ 改为「整段攒着、`final()` 通过后才 push」，实测篡改时下发字节由 300000 降为 0（**R27-11**）；**S3 签名路径与 `fetch` 实际发出的请求行不一致**（`fetch` 会删点段，`docs/./x.txt` 签一份发另一份）⇒ 必然 `SignatureDoesNotMatch`，而 `s3.js` 把它译成「请检查 AccessKey / SecretKey」，把运维引向轮换一把有效的密钥（**R27-15**，`_request` 与 `getObjectUrl` 共用 `normalizeDotSegments`）；**自签证书是 SHA-1 签名**（`selfsigned` 未传 `algorithm` 时的默认值，实测 `sha1WithRSAEncryption`，**R27-19**）；**二维码数据位填充偏离 ISO/IEC 18004**（只挪局部列号不挪循环变量 ⇒ 第 4 列写两次、第 0 列永远拿不到数据，实测每个 RS 块多出 3~8 个错误码字、靠纠错硬修，**R27-20**，护栏改用「源码注入计数器」直接断言每个数据模块恰好写一次、第 0 列必须参与）；**WebDAV 宣告 `ETag` 却完全不处理条件请求**（全库 `if-match` 零命中 ⇒ 依赖 `If-Match` 的同步工具静默丢更新）→ 新增 `checkPreconditions()` 并在 PUT / DELETE 上求值（**R27-16**）；**gzip 的 `SKIP_PATH` 大小写敏感**（Express 路由不敏感，`/api/fs/DOWNLOAD` 能绕过「绝不缓冲流式下载」的护栏）且对 `206` 也压缩（`Content-Range` 与 `Content-Encoding` 打架，续传客户端拼出损坏文件）（**R27-26**）；**请求体解析器挂在鉴权与 IP 守卫之前**（`limit: '64mb'`，匿名即可让服务端按请求缓冲 64MB）→ 下移到鉴权之后、路由之前，并保持「raw 早于全局 json」这条 FUN-01 约束不被破坏（**R27-22**，实测未认证请求不再进入 raw 解析、已认证的 `.json` 上传仍是 `isBuffer: true`）。**方法上的两点自省**：其一，本轮**不重复历轮的「先信后验」**—— 所有报告条目都先回源码复核再改，其中一条（报告称 `ops.js` 的删除 / 移动会弹「失败」提示）经复核**不成立**（命名访问让它静默 no-op、且后续 `explorerRefresh()` 会重渲染并更新按钮），故只修真实存在的那一半，并在报告侧记录了更正；其二，**测试污染的口子被顺手收掉**：`crypto-storage` 与 `ip-guard` 的用例此前会直接改写生产 `data/ipguard.json`，本轮给它们补上 `S3_DATA_DIR` 隔离，使「跑测试 = 不动生产数据」这条纪律不再依赖"每个用例自觉"。护栏 `tests/audit27-regressions.test.js`（13 条，全部配**正向对照**：合法 IP 仍要接受、普通 API 仍要压缩、未篡改仍要完整还原、普通键不得被路径规范化改写、显式 `/0` 仍要生效），`reverse-check` 的 `R10-10` 条目因记账改用 `actualBytes` 而**改锚**（锚点是 `String.replace` 首处命中，改了实现却不改锚点会让它静默失效 —— 这正是 R14-05 / R10-11 各中招一次的老坑）。**未闭合 3 项**（如实登记，见本节说明）：R27-08（登录锁定键规范化）与 R27-14（原子写 fsync）只有静态护栏、缺行为护栏；R27-24（WebAuthn 注册挑战绑定用户）的端到端用例需要真实认证器，当前只覆盖到 `verifyRegistration()` 的归属分支 |
| R28 | 第二轮独立审计的 6 条修复（`审计报告-第二轮.md` 的 `A-01`~`A-06`；本轮以「**对抗式复核上一轮修复 + 扫描新缺陷**」为主轴，台账代号 `R28-01`~`R28-06` 与报告条目**按序一一对应**） | 6 条（高 1 / 中 2 / 低 3）+ 10 条行为护栏 + 4 条反向对照改锚 + **7 条反向对照补登** | 这一轮的价值集中在**「上一轮的修复真的生效了吗」**上 —— 6 条里有 3 条是**上一轮修了一半**、1 条是**上一轮把测试写假了**。逐条：**① A-01（高）IPv6 屏蔽规则在进程重启后静默失效（fail-open）**。`ip-guard` 把 `parseTarget()` 的**派生缓存** `_parsed` 连同规则一起加密落盘，而 IPv6 的 `bytes` 是 `Buffer` —— JSON 往返后退化成 `{type:'Buffer',data:[…]}`；`load()` 的复用判据只看 `text` 字段（它一字不差）⇒ 坏缓存被原样带进判定，`cidrContainsV6()` 逐字节比较时 `cidr.bytes[i]` 恒为 `undefined`，规则**永不命中且不报错**（规则列表里显示「已启用」、命中计数恒为 0）。实测：写一条 `2001:db8::/32` → 落盘 → 重新加载 → 该网段请求直接被放行（IPv4 规则不受影响，这也是历轮没扫到的原因）。**测试盲区一并钉住**：全库 37 个测试文件里凡是 `addRule()` 的用例目标**全是 IPv4**，且**没有任何「落盘 → 重载 → 再判定」的往返用例**。修法两条腿：`persistView()` 从源头**不写**派生缓存（`listRules()`/`view()` 同样剥掉，顺带不再把 16 字节数组回显给前端），`load()` 补一条类型校验把**已经**带坏缓存的历史文件纠正过来。**② A-02（中）单桶容量配额零拦截**。文档写的是「桶配额仍是**单桶上限**」、`CHANGELOG` 称其「**单桶**限额」、界面还会把超限桶标成「超额」并把进度条染红 —— 但服务端**没有任何一处**拿它拦过写入（全库 `quotaBytes` 的消费者只有「存取/归一化」与「展示」两类）。修法按「额度」的本义补上闸门：新增 `assertBucketQuota(client, cfg, {addBytes})`，与凭据级共用同一套口径（严格大于才拒 / 0 = 无限制 / 缓存值 + 待定增量），并挂在 `/fs` 的 5 个写入口与 WebDAV 的 4 个写入口（**与凭据级并列**，形如「凭据级一行、桶级一行」）。**连带收口一个自绕过洞**：`quotaBytes` 原本允许普通用户修改（SEC-01 的白名单里与 `remark` 并列）—— 在它只是展示值时无害，一旦成为**被强制执行的限额**，「被约束者能自己调大」就等于闸门自带解除按钮，故移出白名单（改为管理员专属，前端同步把该输入框改为只读展示）。**③ A-03（中）206 判据是死代码 + 护栏假绿**。R27-26 写的 `if (res.statusCode === 206) return false` 位于 `shouldCompress()` —— 而它在**路由之前**执行，此刻 `res.statusCode` 还是默认的 200，于是这一行在生产路径上**永远不成立**；对应的护栏又用**合成的 `{statusCode:206}`** 去调纯函数，形成「缺陷仍在 + 护栏全绿」。实测真实 Range 请求仍回 `206 CE=gzip CL=29 CR=bytes 0-1023/5000`。修法：判据改看**请求头 `Range`**（这是路由之前就已知的信息，且顺带免掉缓冲），并在 `end()` 阶段按**真实状态码 / `Content-Range`** 再兜一层；护栏改成**发真实 HTTP 请求断言响应头**。**④ A-04（低）上一轮两处修复只覆盖「新建」路径**。R27-13（密钥 0600）与 R27-19（证书 SHA-256）都只改了**创建**分支：存量 `secret.key`（正常运行时永不重建）权限一直是 0644 也没人纠正，存量 SHA-1 证书因为「未过期就返回缓存」还能再用约 2 年 3 个月。修法是在**读取路径**上做一次幂等自愈（`ensurePrivateModeSync()`；Windows 上 POSIX 位无意义故直接跳过）+ 缓存证书签名算法校验（弱签名即重签）。**⑤ A-05（低）实例锁仍留一条 TOCTOU 窗口**。R27-21 用 `rename` 挪走锁文件来串行化接管，但「挪走 → 放回」之间 `LOCK_FILE` **不存在**，第三个实例会在这段时间里 `wx` 创建成功，而原持有者仍自认持锁（`held` 是内存标志）⇒ 双持锁。修法：接管期间**绝不让锁文件消失** —— 先用独立标记 `O_EXCL` 抢「接管权」，抢到者才**就地覆写**锁文件，写完释放标记；标记自身带 pid，持有者已死则自愈清理。**⑥ A-06（低）文案分叉**。R27-07 新增的 `unparsable` 拒绝原因只更新了 HTML 分支，`/api` 下仍回「IP 已被屏蔽」—— 而规则列表里根本没有那条规则，排查会被引向错误方向；文案收敛到唯一实现点 `ipGuard.blockTip()`（WebDAV 的文本 403 同样取它）。**方法上的两条自省**：其一，本轮**先复核再动手**，报告里的每条都回源码/探针确认过（含上一轮那条「删除/移动会弹失败」的更正）；其二，**反向对照的 anchor 与本轮新增的闸门行互相干扰**（注释在扫描前被抹成等长空白，夹在锚点中间的行内注释会让锚点失配）—— 4 条 `R25-*` 对照因此改锚为**纯代码行**，并把「两行闸门之间不留注释」写进注释，避免下一个人再踩。**⑦（收尾复核时发现的「假修复」）R28-04 的弱签名判据在受支持的 Node 上恒为 `false`**。`local-cert.js` 的 `isWeakSignature()` 用 `new crypto.X509Certificate(pem).signatureAlgorithm` 判签名算法，而 **Node 18 / 20 / 22 都没有这个属性**（`toLegacyObject()` 里也没有）—— 取到 `undefined`、`String(undefined \|\| '')` 得到 `''`、`/sha1/i.test('')` 恒 `false`：于是**任何**能解析的证书都被判成「强签名」，「缓存证书是 SHA-1 → 重新签发」这条分支永远不可达，A-04 实际只修了权限那一半。而护栏用**同一个不存在的属性**做前置断言，必然抛错 —— 这条护栏从写下起就是红的、从未被执行过。**修法**：改为**自己读 DER**（不引新依赖）—— 按 `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm SEQUENCE { OID, … }, signatureValue }` 的结构取外层 `signatureAlgorithm` 的算法 OID，命中 SHA-1 / MD5 家族（`1.2.840.113549.1.1.{2,3,4,5}`、`1.2.840.10040.4.3`、`1.2.840.10045.4.1`、`1.3.14.3.2.{26,29}`）即判弱，解析不了仍按弱处理。**护栏补强两处**：① 静态不变量「本文件内不得出现 `.signatureAlgorithm`」（这条若早存在，当初就写不进假修复）；② **新增调用点层用例** —— 原用例只驱动判据函数，把 `getSelfSignedCert()` 里的 `!isWeakSignature(c.cert)` 摘掉仍全绿（正是 R21-14 那类「护栏只落在助手函数上」的老毛病），新用例落到「缓存 SHA-1 → 必须真的重签出 SHA-256」并带「强签名未过期必须原样复用」的正向对照。同时把 **R27 / R28 两轮的 20 条反向对照补登进 `reverse-check` 台账**（此前只写了行为护栏、没登记变异，`CASES` 停在 213 条）；补登过程又逼出两处「护栏测不到修复」——R28-05 的第三实例被「有活锁」预检挡下、根本没走到接管标记（已补一行把锁记录写回陈旧值，判据才落在标记上），R28-03 的两层防御各自都不可独立证伪（按多步变异登记，并在条目里注明这是纵深防御的正常形态）。台账 **213 → 233 条** |
| R30 | 功能新增（非审计轮）：**Microsoft Azure Blob Storage 正式接入** —— 厂商选择器移到「又拍云」与「AWS S3」之间、移除「即将支持」文案、版本号推进到 `1.2.7` | 20 条协议护栏（`tests/azure-client.test.js`，含缺陷检测后补的 6 条）+ 端到端探针验证 + 收尾复核抓出并修掉的 1 条潜在缺陷（分片块列表重复累加）+ **同轮缺陷检测抓出并修掉的 7 条**（`AZ-01`~`AZ-07`，报告见仓库根 `ANALYSIS-ROUND30.md`）+ **15 条反向对照补登**（台账 233 → 248） | 这一轮是**新协议适配**，与 R26「四家 S3 兼容厂商」有本质区别：那四家共用既有 `s3-client.js`（改注册表即可），而 Azure Blob 的 REST 接口虽然长得像 S3，**鉴权、寻址、分片、复制、预签名五处都不同**，因此按「同一种协议一个实现」的既有原则新建 `server/azure-client.js`（对比：腾讯云 COS 也是独立实现）。五处差异与各自的处理：① **鉴权 = Shared Key**（HMAC-SHA256 over 一段**字段顺序固定**的规范串 + `CanonicalizedHeaders` + `CanonicalizedResource`），而不是 SigV4；其中「`Content-Length` 为 0 时必须留空」「用了 `x-ms-date` 后 Date 一行必须留空」「`CanonicalizedResource` 的账户名取**凭据**而非主机名（自定义域名 / 回环调试端点下主机名里根本没有账户名）」三条是只在真实签名时才会暴露的坑。② **寻址**：容器恒在路径里，端点由**存储账户名**决定（`https://<账户名>.blob.core.windows.net`）—— 与 R2「账户 ID 进主机名」同型，但 Azure 的账户名**同时是鉴权身份**（即 `secretId`），因此新增 `providers.endpointForAccount()` 作为唯一实现点（含 `^[a-z0-9]{3,24}$` 字符集校验：账户名是请求方可控输入且会被直接拼进主机名，放行即盲 SSRF），并新增 `endpointMode: 'optional'` 表达「端点默认自动推导、该栏只是主权云 / Azurite 的覆盖口」（`endpointRequired()` 不计入它，否则一条完全正确的 Azure 密钥会被判为不完整）。③ **分片 = Block Blob**：没有 UploadId 握手（`multipartInit` 只签发会话令牌，不发请求）、Put Block 不返回可用 ETag（回**块名**作合成 ETag，且块名由分片号定宽编码 —— Azure 要求同一 block list 内块名等长）、`multipartListPart` 由块名反解分片号使**跨进程重启的断点续传**仍成立、`multipartAbort` 无对应接口（未提交块 7 天后云端回收，如实返回空）。④ **复制是异步的**：大对象 `Copy Blob` 返回 `x-ms-copy-status: pending`，而本项目的「移动 / 重命名」是「复制成功 → 迁元数据 → 删源」三步，**提前 resolve 就会在副本还没写完时删掉源**（不可逆）——故客户端轮询到终态才返回，超时即报错而不假装成功；`copySource()` 对 Azure 只给 `/容器/键`，绝对 URL 由客户端拼（只有它知道账户与端点，硬拼会得到合法但不存在的 `https://<容器>.blob.core.windows.net/…`）。⑤ **预签名 = SAS**：按 2020-12-06 的 16 段规范串签服务 SAS（少一段即 403）。另有四处能力缺口按下述口径消化：`?stats` 不存在 → `request()` 显式抛 `NotImplemented`(501) 让上层回退列举统计；容器级「未提交块」枚举不存在 → 碎片列表恒为空（未提交块由云端回收、不持续计费，且 Azure 删容器不要求清空未提交块）；无批量删除 API → 受控并发逐删，并严格按「**只把云端明确确认删除的 key 放进 `Deleted`**」合成（这份白名单驱动清加密元数据与标记分享链接失效，多报一个就是数据事故；不存在按幂等算已删，与 S3 口径一致）；`getService` 必须回**非空 Region**（`POST /config/verify` 在指定桶名且地域留空时用它兜底，回空串会让一次正确的验证报「未找到存储桶」）。**验证方式**：`tests/azure-client.test.js` 起一个**自己验签**的假 Azure 服务 —— 它按规范**独立重算**每个请求的签名与 `Authorization` 逐字比对，并独立校验 SAS 直链；写这个客户端的意义就在于此：规范串拼装光读代码无法确认，签名错一位只会得到 403 `AuthenticationFailed`，报文里不带任何线索。另有一次性端到端探针（真实 `server/index.js` + 假 Azure）跑通「加密钥 → 绑容器 → 直传 1MB → 分片 9MB（2 块）→ 列举 → 下载（流式）→ SAS 直链（服务端验签通过）→ 重命名（服务端复制）→ ACL 检查（`container` 级别 → public-read）→ 用量统计（列举回退）→ 碎片（空）」全部 11 步。排查中被护栏抓出的两条真实缺陷：`_path()` 把「账户级请求」（列容器）误回退成默认容器（表现为 `getService` 打到 `/容器?comp=list` 而 Azure 回 404），以及测试自身把「回调已返回」当成「传输已结束」（Azure 与 S3 同语义：回调在响应头到达时就返回，消费者自己读流）—— 后者已在护栏注释里写明判据。**收尾复核（同一轮内）又抓出第三处**：`multipartListPart()` 写了一个 `marker` 翻页循环，而那个变量**从未进入请求**（`if (marker) query['blocklisttype'] = 'uncommitted'` 是空操作，该值本来就是它）—— 只要服务端回一个 `NextMarker`，第二圈就会原样重取第一页、把同一批分片**再累加一次**（实测 `[1,2,1,2]`，且多打一次请求）。方向是 **fail-open**：`routes/fs.js` 的续传闸门拿 `Σ size` 当「已落云、不必再计入配额」的字节数，重复项会把它翻倍、`netAdd` 被低估（可低到 0）而**放松配额判定**。真实 Azure 的 `Get Block List` 既没有翻页参数、响应也没有 `NextMarker`，所以这是**潜在**缺陷而非线上故障 —— 但也正因为「不可达」它才没被任何用例照到：原护栏的假服务从不返回游标。修法是按服务端真实契约**只发一次请求**（并顺手去掉同处那个不属于该接口的 `maxresults` 参数），另按分片号去重兜底；同时给假服务加一个 `blockListCursor` 开关并补一条**双向对照**用例（无游标 → `1,2` 且只发 1 次；带游标 → 仍须是 `1,2` 且只发 1 次）。**（同一轮内接着做缺陷检测与修复，7 条）① AZ-01（高）SAS 规范资源缺 `/blob` 服务名且未 URL 解码**：`getObjectUrl()` 拼的是 `/<账户><已编码路径>`，而 2015-02-21 起**必须**带服务名（`/blob/<账户>/<容器>[/<Blob>]`）且字段**必须 URL 解码**；错一位只得到 403 `AuthenticationFailed`、报文不带任何线索，故「缩略图 / 直链」在真实 Azure 上整体失效。**更值得记的是它为什么一直没被发现**：`tests/azure-client.test.js` 的假服务在 SAS 一处**照抄了客户端的错误规范资源**（同样缺 `/blob`）—— 两侧共享同一假设时，验签只能证明**自洽**，于是 20 条用例全绿而真实 Azure 必 403。修法两半：客户端按规范拼；假服务改为**按官方规范写死期望值**（`specSasResource()`，注释里写明「第一版护栏就是这么写错的」），并补一条「键含字面 `%XX` 与空格」的用例 —— 它同时压住解码口径。**② AZ-02（中）`x-ms-copy-source` 硬编码公有云主机名**（`https://<账户>.blob.core.windows.net`）⇒ **主权云（Azure 中国）/ Azurite 下复制 / 移动 / 重命名必然失败**，而端点覆盖（`endpointMode: 'optional'`）存在的理由正是这两类场景。改为跟随自己的 `protocol//host/basePath`，并让假服务**拒绝主机名不是它自己**的复制源 —— 否则这条永远测不出来。**③ AZ-03（低-中）单删与批删两套口径**：`deleteObject` 对「本就不存在」抛 404，而同文件 `deleteMultipleObject` 把 404 算作已删（与 S3 `DeleteObject` 的幂等语义一致）⇒ 同一次删除「走 `/fs/delete` 成功、走 WebDAV 失败」，客户端重试一次就从成功变报错。收敛到唯一判据 `_isGone()`（单删 / 批删两个调用点共用）。**④ AZ-04（低）`canonicalizedQuery` 对原始查询值再解码一次** ⇒ 键名含字面 `%XX` 时签名与实发不符（列举 / 搜索 403）。**⑤ AZ-05（低，硬化）块名只由分片号决定**（`block-00001`）⇒ 断点续传**原则上**可能采信另一次会话遗留的同一个块，而 `multipartAbort` 在 Azure 上又是空操作（无对应接口），方向是静默数据错误。块名改为**内嵌会话令牌**（`blockTokenOf(uploadId)`），列举时按令牌过滤。**⑥ AZ-06（必须修）`CHANGELOG.md` 被误删**（工作区 −218 行）⇒ `docs-sync` 的 R23-05「树里列出的文件必须存在」变红，且 1.2.7 少一处版本落点 → 恢复并补 `[1.2.7]` 节。**⑦ AZ-07（流程）R29 / R30 共 5 条修复在 `CASES` 台账里 0 条**（台账停在 233）→ 连同 `AZ-*` 一并补登 **15 条**（`R30-01` / `R30-02` / `AZ-01`~`AZ-05` / `R29-01a`~`e` / `R29-02a`~`c`），台账 **233 → 248 条**，逐条实跑确认 `fail>=1`。**补登反过来又逼出台账与护栏自身的五处问题**，都记在这里备后人：其一，`AZ-03` 的变异**留下一个悬空的 `}`**，整个 `azure-client.test.js` 变成语法错误，以 `not ok 1 - tests\azure-client.test.js`（**文件级**）计入 fail —— 计数同样是 1，`fail>=1` 被**巧合满足**，而一条行为断言都没跑到（与 R7-07 同型：变异把源码弄成了另一件事，判据是看红的是**用例名**还是文件本身）；其二、其三，`R30-02` 与 `AZ-05` 的期望失败数各写高了一档（实测分别只有「带游标」那条与 `AZ-05` 专属那条能观测 —— 两层防御里的另一层在单页 / 同会话场景下无从触发）；其四，`R29-02b` 实测 **`fail=0`**，追下去发现是**护栏本身**的缺陷：`audit29-regressions.test.js` 用 `src.slice(i, i + 900).includes('App.onConfigChanged(')` 判「启停存储桶后必须全局刷新」，而 `toggleBucketEnabled` 上方那段说明注释**恰好含同样字样**，真调用被摘掉后注释照旧满足断言 ⇒ 变异明明生效、台账却报「护栏没抓到」；其五，`R29-01e` 同样实测 **`fail=0`**，根因是**护栏空转**：`runUploadScenario()` 用 `main.js?v=<随机>` 单独导入 main.js，而 `upload.js` 内部的 `import './main.js'` 解析到的是**无查询串**那个模块记录 ⇒ 测试覆盖的是**另一个实例**的 `App`，对 `upload.js` 毫无影响，用例无论实现怎么写都绿（三个沙箱用例里只有这一条依赖 `App` 的**对象同一性**）。其四、其五的修法：前者判据改为**只看代码行**（该文件新增 `codeLines()`，行级过滤 `//` / `/*` / `*` 起头的行），后者去掉 `?v=` 并把覆盖动作移到 `import upload.js` 之前；两条改后对应的变异都正常变红。**这两条是同一件事的两种形态 —— 判据没有落在它声称要守的那段代码上（一次落在注释上，一次落在另一个模块实例上）**，也说明「这条护栏绿了」与「它真的守住了那段代码」是两件事，只有反向变异能把两者分开 |
| R29 | 用户报告的两个**运行期**问题（非审计轮）：① 上传小文件时进度条假死（文件其实已上传成功，需刷新才看到）；② 设置改完要刷新页面才显示正确状态 | 2 条（`R29-01` / `R29-02`）+ 7 条行为护栏 + 8 条反向对照（`R29-01a`~`e` / `R29-02a`~`c`，第 30 轮补登；其中 `R29-01e` / `R29-02b` 首次实跑 `fail=0`，暴露了护栏自身的两处判据缺陷 —— 一处落在注释上、一处落在另一个模块实例上，已一并修掉） | 这一轮的入口是**用户在实际使用里看到的现象**，因此第一步是**证伪/证实**，而不是直接改代码。**① R29-01（上传）**：先证「客户端逻辑」与「服务端路径」各自无恙 —— 把 `upload.js` 的依赖整体换成桩、在 Node 里驱动真实 `uploadMgr`（直传 / 分片 / 续传三条路径都正确收尾并触发列表刷新）；再搭一个最小 fake S3（路径风格 + SigV4）+ 起真实 `server/index.js`，用「浏览器会发的同款请求」跑完 1MB 直传与 20MB 分片（init 7ms、三片各 38~59ms、complete 15ms、随后 `list` 立刻能看到两个对象）。**结论：健康端点下服务端既不慢也不卡**，于是把范围收到「等待期没有反馈」与「没有任何停滞保护」这两个**可证**的缺口上：旧实现的进度条直接等于「已发送 / 总大小」，请求体一发完就显示 **100%**，而服务端还要加密 / 上云 / 写元数据（大文件上云可能数十秒到数分钟）——这段时间进度条定格 100%、状态仍写「上传中」，用户看到的就是"假死"；同时 `xhrPut` **没有任何超时或停滞判定**，服务端（或其背后的对象存储）不回应就永远停在「上传中」——这就是"卡住"，而文件可能早已落云，于是又表现为"刷新一下就有了"。修法三条：发送阶段进度条**封顶 99%**、字节全部交出后状态改显示「服务器处理中…」（`upload.onload` 是比 `onprogress` 更可靠的「已发完」信号，小文件上后者可能一次都不触发）；给 `xhrPut` 加**分阶段停滞看门狗**（发送阶段 60 秒无任何进展 → abort；请求体发完后的等待档放宽到 10 分钟，因为加密/上云本身可能很慢），且停滞错误**不标 `aborted`** —— 这样既有的 `uploadWithRetry` 会真的重试两次（标错会退化成一次性失败）；上传成功后的界面刷新（`render` / `refreshStorage` / 列表刷新）全部**吞掉异常**——旧实现里它们任一抛错都会被 `pump()` 的 catch 接住并把任务改判成「失败」，属"业务成功、界面谎报失败"。**② R29-02（设置刷新）**：用小脚本把 `public/js` 里每一处设置类写操作及其后续 10 行扫了一遍，再**逐个人工复核**（扫描器有假阴性：`refreshIpGuard()` / `renderCaptcha()` / `afterBucketMutated()` 这类名字它不认）。最终确认的缺口是三处「只刷新自己那张卡片」：`credmgr` 的增删/启停密钥（`App.state.config` 快照不更新 → 侧边栏仍写「请先在设置中配置访问密钥」、状态栏与存储桶弹窗的密钥下拉全是旧的）、`bucketmgr` 的**启停存储桶**（它只 `dispatchEvent('buckets-changed')` 且注释声称"同步侧边栏"，而该事件的监听者只有 credmgr/bucketmgr 自己 —— **侧边栏由 main.js 渲染、读的是配置快照，没人重新取数**）、以及**清空存储桶**（只刷用量，被删掉的文件仍留在文件列表里）。修法是补一个「配置级刷新」入口 `App.reloadConfig()`（只重取配置，供"只改了展示字段"用）与既有的 `App.onConfigChanged()`（配置 + 目录树 + 文件列表，供"可浏览内容变了"用）分工，然后把上面三处接上；`afterBucketMutated` 一并改为走全局刷新。护栏 `tests/audit29-regressions.test.js`（7 条）：用**假 XHR + 手动定时器**直接驱动 `api.js` 的看门狗（断言 60 秒档 / 10 分钟档、`stalled` 而非 `aborted`），用**桩模块图**驱动真实 `uploadMgr`（断言「服务器处理中」与进度 <100%、以及界面刷新抛错时任务仍是「已完成」），再加两组静态断言钉住设置写操作的刷新接线 |
| R31 | 用户报告的三件事（非审计轮）：① 网页界面删除文件失败，提示 `MissingArgument: Missing Some Required Arguments.`；② 「支付设置」「登录验证」填好信息保存成功后，功能仍停在**停用**；③ 推进版本号 | 3 条修复（`R31-01` 删文件 / `R31-02` 登录验证 / `R31-03` 支付设置）+ 12 条行为护栏（`tests/audit31-regressions.test.js` 11 条 + `s3-client.test.js` 1 条）+ 8 条反向对照（`R31-01a`/`b`、`R31-02a`~`c`、`R31-03a`~`c`，台账 248 → 256）；版本 `1.2.7` → `1.2.8` | 三条都由用户在实际使用中报出，故第一步仍是**先复现再修**。**① R31-01（批量删除）**：报错文案形如 `Name: Message.`，而项目内四个错误整形点（`s3.translateError` / `davErrorMessage` / `deleteMultipleConfirmed` / `routes/fs.js`）输出的**全是中文**、全库与 `node_modules` 检索该串**零命中** ⇒ 这句原文只可能来自云端。据此反推出厂商回的是 `<Code>MissingArgument</Code><Message>Missing Some Required Arguments.</Message>`，并据「多对象删除要求 `Content-MD5`」定位到根因：AWS S3 的 API 参考写明该头「required for all Multi-Object Delete requests」，阿里云 OSS 的 `DeleteMultipleObjects` 请求头表把 Content-MD5 标为**必选**，而同型报错在现实世界亦有记录（lobe-chat#6746，同样是「阿里云 OSS + 批量删除」，结论同样是补该头）。本项目的 `deleteMultipleObject()` 自接入以来只发 `content-type`，因此**任何**文件（含刚上传成功的）都删不掉，而同桶列举 / 上传 / 下载 / 重命名全部正常 —— 这一半正常极易把排查引向「权限不足」或「服务商不支持批量删除」，进而去轮换一把完全有效的密钥（上游报文既不说是哪个参数，也从不出现 Content-MD5 字样）。修法：按规范补 `Content-MD5`（请求体字节的 base64(MD5)，**与实际发出的 Buffer 同源**，避免「量的字节」与「发的字节」不一致）；`multipartComplete()` 的 `?uploadId` POST **不需要**该头（OSS 的 `CompleteMultipartUpload` 请求头表里没有它），故未一并加，避免「顺手一起加」式的过度修复。护栏用**按规范写死**的假服务（自己重算 base64(MD5) 并比对），并带一条「缺头必须被拒」的自检 —— 否则伪服务形同虚设（第 30 轮 SAS 假绿即「期望值与实现同源」）。**② R31-02 / R31-03（保存后自动启用）**：管理员把凭证填好并保存成功时，旧行为只是把「停用」原样再存一遍，管理员以为「保存即生效」，实际登录页仍无验证、付费链接仍是免费下载，得再回来手动拨一次开关。触发条件收敛为**三条闸门同时成立**：保存前就是停用状态 / 本次**真的新填了**信息（与已保存值不同）/ 填写的信息**符合规则**（必填项完整）。中间那条是关键：没有它就会「关掉开关 → 点保存 → 又被自动打开」，等于该开关**再也关不掉**。两条边界：支付卡片只自动开**总开关**、不动渠道开关（那是管理员对该平台的独立选择）；总开关能否打开由服务端 `paymentRules.checkGlobalToggle` 裁定，前端**不复刻**该规则（复刻即同一判据的第二个实现点）——典型拒绝是「一个渠道都没开」，此时如实展示服务端原话并保留「凭证已保存」这一事实（既不静默失败、也不谎报已启用）。★ 这里有一处**用户决策改变了实现路径**：首轮询问时用户选了「仅支付总开关」，但服务端硬约束是「没有任何渠道开启时不许开总开关」（`payment-rules.js`，且 `savePayment()` 只存凭证、从不改渠道开关），两者相冲；追问后用户明确「**填写的信息必须符合规则，才能触发自动打开**」，故实现为「照常尝试 → 服务端裁定 → 被拒如实报错」，而不是在前端补一份规则副本或悄悄替用户打开渠道。护栏落在**真实调用链**上：用桩模块图在 Node 里 import 真实的 `syssettings.js` / `paysettings.js`，用假 DOM 触发真实的保存点击，断言「实际提交给服务端的 payload」（`captchaSave()` 连续两次复用同一模块实例，从而覆盖「已启用 → 手动取消勾选 → 再保存」这一关键场景）；支付侧还钉住「渠道开关不得被顺手改掉」与「总开关已开着时不得重复切换」。8 条反向对照逐条实跑，红的一律是**用例名**（不是文件级语法错误）。**③ 收尾**：版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / `Develop_Document.md` 适用版本 / `CHANGELOG.md`），测试文件数 41 → 42、用例 687 → 699 |
| R32 | 用户提出的两个新功能（非审计轮）：① 订单管理「付费订单」卡片新增「删除失效订单」按钮，删掉全部处于**支付失败**状态的订单；② 链接管理「分享链接管理」卡片新增「删除失效链接」按钮，删掉全部处于**文件已删除**与**已过期**状态的链接；③ 推进版本号 | 2 条功能（`R32-01` 删失效订单 / `R32-02` 删失效链接）+ 14 条行为护栏（`tests/audit32-regressions.test.js`）+ 9 条反向对照（`R32-01a`~`d`、`R32-02a`~`e`，台账 256 → 265）；版本 `1.2.8` → `1.2.9` | 两个按钮的实现都是「一行 filter」，真正的风险全在**边界**上，故这一轮的重点是**先把边界写成判据、再落代码**。**① R32-01（删失效订单）**：订单表里本来就有一把现成的尺子 `isProtected()`（`prune` / `pruneGlobal` 共用），顺手写成「删掉所有可裁流水」极其自然 —— 但它的候选集里包含**超出支付窗口的 `pending`**，那是 R14-03 刻意留下的灰色地带（付款者此刻可能正站在收银台上，删掉 = 钱付了、订单查无此单、文件永远拿不到），由自动裁剪按容量兜住即可，不该被一次人工点击静默清掉。故判据收窄为 `status === 'failed'`，并**仍然走一遍 `isProtected()`**（冗余但刻意：将来若给 `failed` 加上保护条件，这里会自动跟上，不会长成第二个各判一套的实现点、也不会成为「可裁」与「本按钮该删」混同的起点）。「已支付」「已退款」是钱流动过的对账凭据，永远不进候选集。**② R32-02（删失效链接）**：失效 = `deleted`（云端对象真没了）+ `expired`（时间已过），**刻意不含 `exhausted`（已关闭）** —— 次数用尽是**可逆**状态，在「编辑」里调大「可下载次数」即可让链接复活，一并删掉会让「先收紧配额、之后再放开」这个正常运维动作变成不可逆。作用域这一条与订单侧**必须不同**：订单卡片是管理员专属（`ADMIN_ONLY_CARDS`），而链接管理页普通用户也能进、链接按 `createdBy` 隔离，故 `removeDead()` 内部用 `canManage()` 限定（与 `listFor()` 同一把尺子），路由**不挂** `requireAdmin` —— 挂上会让普通用户的按钮一点就 403，越权由函数内的作用域判定兜住。**③ 一个只在运行时才暴露的坑**：`DELETE /links/dead` 与既有的参数路由 `DELETE /links/:id` 同前缀，若注册在它之后，路径里的 `dead` 会被 `:id` 当成链接 id 吞掉 —— 此时路由表里两条路径**都还在**，「路由总数」「无路由丢失」照样全绿，只有真发请求才看到「链接不存在」。故除台账登记外另补一条**顺序断言**，并用**两步变异**（先摘掉、再追加到文件末尾）真实还原该错序，而不是用「改个错路径」糊弄过去（后者红的是「路径丢失」，证明不了顺序断言本身有效）。**④ 护栏刻意分三层**：存储层（真实模块 `removeFailed()` / `removeDead()` 的行为）、路由层（真实 express 路由 + 真发 HTTP，钉住鉴权与作用域）、前端层（沙箱里 import 真实的 `ordermgr.js` / `linkmgr.js` + 假 DOM，真点按钮）—— 只驱动纯函数挡不住「守卫漏挂」「按钮没接线」，只断言源码字样挡不住「判据写反」。9 条反向对照逐条实跑，红的一律是**用例名**（不是文件级语法错误）；其中 `R32-02c` 报 `fail=2`，多出来的那条是既有的文档路径断言，按「名单减去基线红」的口径核对后确认增量恰好是目标用例。**⑤ 收尾**：版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / `Develop_Document.md` 适用版本 / `CHANGELOG.md`），测试文件数 42 → 43、用例 699 → 714；两条新路由同步进 `EXPECTED` 与 `mustBeAdmin` 两份台账，并逐条写进本文件（`routes-surface` 那条「防家族记法漏列」的断言要求的正是这个）。另：`tests/payment.test.js` 里有一条「应有 N 条支付路由」的硬计数，加路由时**必须同步**——它本轮实跑报红一次，正是它该起的作用 |
| R33 | 用户提出的新功能（非审计轮）：用户管理新增**「封禁」** —— ① 仅管理员可执行；② 时间选择器选择封禁到期时间；③ 「解封」按钮可立即解除；④ 「封禁原因」编辑框；⑤ 被封禁用户登录时能看到封禁原因与解封时间；⑥ 推进版本号 | 1 条功能（`R33` 封禁 / 解封）+ 25 条行为护栏（`tests/audit33-regressions.test.js`）+ 17 条反向对照（`R33-01a`~`e`、`R33-02a`~`d`、`R33-03a`~`c`、`R33-04a`~`e`，台账 265 → 282）；版本 `1.2.9` → `1.3.0` | 这是本项目**第一个「以账户为单位、可撤销、带到期时间」的准入控制**：在此之前让某个用户进不来只有删账户（不可逆，连带其创建的资源与审计线索一起消失）或改密码（本人能改回来）两条路。六条需求里有四条是**边界**问题，故先把边界写成判据再落代码。**① 判据只有一个实现点**：`config-store.banInfo()` 同时管住「登录放不放行」与「界面显示什么状态」，返回 `state: none / active / expired`。到期时间缺失**或解析不出时间**一律按**永久封禁**处理（fail-closed）—— 与 WebAuthn「凭据不完整即视为未启用」（fail-open，防用户被永久锁死在登录页）方向**相反**：误判为封禁可由管理员一键解除，而封禁标记因数据瑕疵被静默忽略是安全缺陷。前端**刻意不再比一次时间**（只做枚举→文案映射），否则浏览器时钟偏差/时区差异会让两处判据分叉，表现为「列表显示已解封、登录仍被拒」。**② 时间存绝对时刻**：`datetime-local` 产出的值**不带时区**（`2026-10-11T12:00`），故由前端按浏览器本地时区换算成 epoch 毫秒再提交、服务端存 ISO 8601 —— 直接把裸字符串发出去，在「浏览器时区 ≠ 服务器时区」的部署下必然错位若干小时。`setUserBan()` 还拒绝**已过去**的到期时间：那种封禁一落库就已失效，接口却回 `ok:true`、界面还弹「已封禁」，是典型的假成功。**③ 封禁必须立即生效**：写入标记的同时吊销该用户全部会话（与改密/降权/删除同一处置，复用同一撤销入口）—— 只写标记的话，被封者手上的会话仍能继续读写对象存储，最长可持续到会话自然过期（勾选「记住登录状态」时是 30 天）。**④ 登录判定的位置就是安全属性本身**：封禁判定必须在**密码校验通过之后**。若提前到按用户名判断，登录接口的响应差异（「存在且被封」带原因与解封时间 vs「不存在」回 401）本身就是一条**用户名枚举**通道 —— 而这一步之前的所有失败分支（`401 用户名或密码错误` + 不存在用户也空转一次哈希）正是为了抹平这种差异。同理，第二步 `/auth/login/webauthn`（`PUBLIC_API` 白名单内、匿名可达）里的封禁判定**必须与前两支完全同形**（都走 `authFail`），绝不能回一条带 `banned` 的 403，否则会把 R21-05 / R22-01 刚收敛掉的三支同形重新漏开一条。**⑤ 为什么不需要「至少保留一个管理员」的保护**（删除/降级那两处有）：封禁不允许作用于**自己**，发起者本人必然是未被封禁的管理员，故封谁都不会让系统失去全部可用管理员 —— 边界条件想清楚之后，少一个保护也少一处可能写错的判据。**⑥ 护栏刻意分三层**：存储层（判据四态 / 脏数据 fail-closed / 三形态入参归一 / 真落盘）、路由层（真实 express + 真发 HTTP：403 鉴权、自封禁 400、会话吊销、**密码错误时不得泄露封禁**、到期自动放行、第二步同形）、前端层（沙箱里 import 真实的 `syssettings.js` / `util.js` / `api.js` + 假 DOM：真点按钮、真弹窗、真断言提交的 payload）。为此给假 DOM 补了一项 audit32 没有的能力：**解析 innerHTML** —— 封禁/解封按钮是渲染进 `table.innerHTML` 的（不像 `btn-orders-clean` 写死在 index.html 里），不解析就等于把「按钮没接线」整类缺陷放过。**⑦ 两处「无护栏的代码不留」的取舍**：`normalize()` 的每用户兜底循环里**没有**加 `u.ban = normalizeBan(u.ban)` —— 它的唯一读取入口 `banInfo()` 已经无条件归一化，再兜一次不产生任何调用方能观察到的差异，那就是一行**删掉也没测试变红**的代码；宁可不要并把这个判断写进注释。同理，「到期时间必须晚于当前时间」的规则**只**在 `setUserBan()` 实现（前端那个 format 检查只是提前反馈），不写第二份。**⑧ 收尾**：版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md`），测试文件数 43 → 44、用例 714 → 739；两条新路由同步进 `routes-surface.test.js` 的 `EXPECTED` 与 `mustBeAdmin` 两份台账，并在本文件 7.1 的接口表里**逐条写出完整路径**（`routes-surface` 那条「防家族记法漏列」的断言要求的正是这个）。17 条反向对照逐条实跑，红的一律是**用例名**；其中 `R33-03b` 用**两步变异**真实还原「把封禁判定挪到密码校验之前」，而不是改个错条件糊弄过去。另：`tests/payment.test.js` 那条「应有 N 条支付路由」的硬计数本轮**不受影响**（只动了 users 模块），但它是上一轮踩过的坑，新增路由时请一并检查各模块有没有同类硬计数 |
| R34 | 用户报告的两件事（非审计轮）：① **WebDAV 能正常弹出用户名/密码框，登录之后却提示「输入的文件夹似乎无效，请选择另一个」**；② 「关于」卡片新增**「检查更新」**按钮，通过 GitHub 发布页检测当前版本是否为最新版 | 2 个修复（`R34-01` WebDAV 根路径挂载 / `R34-02` 检查更新）+ 18 条行为护栏（`tests/audit34-regressions.test.js` **9 条** + `tests/audit34-update.test.js` **9 条**）+ 16 条反向对照（`R34-01a`~`h`、`R34-02a`~`h`，台账 282 → 298）；版本 `1.3.0` → `1.4.0` | **① R34-01（WebDAV 根路径）**：症状的位置很反常 —— 凭据框**先**弹出（说明客户端判定「这里是 WebDAV」），报错在**其后**（说明「列目录」这一步失败了）。据此把客户端的请求序列逐条打出来（`OPTIONS /` → 401 挑战 → `PROPFIND /`），实测得到一对**自相矛盾**的回答：`OPTIONS /` 回 `200 + DAV: 1`，而 `PROPFIND /` 回一页 **`text/html` 的 Express 默认 404**（`Cannot PROPFIND /`）。根因是「路径是否在挂载点内」这一判据**手写在 9 处**（`req.path.startsWith(MOUNT)`），而**根路径 `/` 在其中的大部分地方被落在门外** —— 只有 `app.options()` 因为它的路径参数是**正则**（匹配任意路径）而侥幸命中 `/`。于是同一个路径上「能力声明」与「数据请求」给出相反结论，客户端无法确认这是个集合，就报「文件夹似乎无效」。修法是把判据收敛成**唯一实现点** `inMount()`，并**只特判正好等于 `/` 的根路径**（`/` 与 `/dav` 同等 —— 二者 `reqPathToKey` 都得到空 key，即根集合），**刻意不**把整个根命名空间算作挂载点：那会撤销 FUN-06 划下的「挂载点之外不可读、不可写」。三处连带处置：其一，`OPTIONS *`（RFC 4918 §9.1 的**服务级**能力探测，不指向任何资源，因此没有「在不在挂载点之下」可言）必须放行，否则会被边界答成 404，而规范要求 `DAV` 头**必须**出现在对 `*` 的 OPTIONS 响应上；其二，`/` 被当作挂载点之后**破坏性动词会跟着被放进来**，逐个确认各自的既有处置仍然成立（`PUT /`→409、`MKCOL /`→409、`DELETE /`→403、`LOCK /`→405），唯 `Destination: /` 由 403 变 400（`inMount` 现在放行它，再由紧随其后的 `!dstKey` 拒掉）—— 判据分工更清，属**刻意**的状态码变更；其三，`reqPathToKey` 的前缀剥离改为**按路径段**匹配（手写 `startsWith(MOUNT)` 会把 `/davx` 的前缀也剥掉，得到 key `x` —— 一个「管理界面看不到、WebDAV 却能读」的幽灵命名空间，与 SEC-12 修掉的 `..` 幽灵对象同型）。**方法论上值得记的两点**：其一，本轮**没有**按 RFC 推演，而是先用探针把真实请求序列与响应逐条量出来；三条听起来很合理的假设（`DAV: 1` 缺 class 2 / XML 请求体 + 连接复用 / chunked 缺 `Content-Length`）都被实测**否掉**（`DAV: 1` 是真话，本服务确实没实现 LOCK/UNLOCK；同一条连接上连发 4 个带 XML 体的 PROPFIND 全部 207）。其二，**修复同时会「老化」既有护栏**：改这两行会让 `R10-12` 的 anchor（`app.head`/`app.get` 包装里的 `startsWith(MOUNT)`）静默失效 —— 脚本只在跑到那一条时才报「锚点未命中」，而没人跑就等于没登记；已连同 anchor 一起迁移，并复跑确认它仍能变红。**② R34-02（检查更新）**：判据与缓存全部下沉到 `server/update-check.js`（版本比较的**唯一实现点**），路由 `/update/check` 只做「调用 + 回包」。四件事想清楚才落代码：其一，**当前版本只认 `package.json`** —— 页脚那句 `Build x.y.z` 与它是同一个号，但那是**渲染进 HTML 的静态文本**，服务端去读它等于读一份可能已过期的副本；其二，**最新版本三级回退**：GitHub 发布页 `releases/latest` 的 `tag_name` → 仓库标签 `/tags` 首项 → 默认分支 `package.json`（本仓库当前既无 Release 也无 tag，**只有第三级能取出号来**，没有它这个按钮会一直报错）；某一级「取不到」或「号不可解析」都换下一级，**三级全失败才回 502 且错误文案里逐级说明原因**（否则用户只看到「检查更新失败」，无从判断是断网、被墙还是仓库改名）；其三，**`null` 与 `0` 必须严格区分**：无法解析返回 `null`（表示「这次比较不成立」，调用方换下一级），若返回 `0`（相等），一个不合规的 tag 就会被当成「已是最新」—— 功能看着正常、用户却永远收不到升级提示，是典型的**静默失效**；其四，**结果缓存 10 分钟**：GitHub 未认证 API 只有 **60 次/小时/IP**，而这是个会被反复点的按钮。**「关于」卡片是设置页里唯一保留给普通用户的卡片**（见 `syssettings.js` 的 `ADMIN_ONLY_CARDS`），故该路由**刻意不挂 `requireAdmin`**，并已在 `routes-surface.test.js` 的 `selfServe` 清单里反向钉住（误挂守卫会让普通用户一点就 403）；护栏用例也**刻意以 `role: 'user'` 发请求**，把这条约束钉在行为上而不是只写一句注释。上游取数走 `__setFetcher()` 注入的假实现（**不发真实网络请求**），否则 CI 断网就会让整个文件变红、而红的原因与代码对错无关。两句给用户看的文案放在 `public/js/util.js`（纯函数才能被真实断言；只断言源码字样挡不住「两个版本号写反位」），并按需求**逐字**钉住。**③ 收尾**：版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md`），测试文件数 44 → 46（本轮新增两个护栏文件）、静态 `test(` 计数 694 → 712；**两处「修复连带的既有护栏老化」已一并处置**：① `R10-12` 的 anchor（`app.head` / `app.get` 包装里的 `startsWith(MOUNT)`）随判据收敛**同步迁移**并复跑确认仍能变红（脚本只在跑到那一条时才报「锚点未命中」，没人跑就等于没登记）；② `syssettings.js` 新增 `updateNotice` 具名导入后，audit31 / 32 / 33 三个前端沙箱各自的 `util.js` 桩**必须补上同名导出** —— ESM 具名导入在**链接期**校验，桩里少一个名字会让那三个文件里**所有**用例整片变红（本轮实测 9 条无关用例因此失败，红的原因与它们各自要守的东西毫无关系），故除补桩外另加一条静态护栏「桩的导出集 ⊇ syssettings 的导入集」，让下一次新增导入在第一处就报错；新路由同步进 `routes-surface.test.js` 的 `EXPECTED` 与 `selfServe` 两份台账，并在本文件 7.1 的接口表里写出完整路径（`routes-surface` 那条「防家族记法漏列」的断言要求的正是这个）。16 条反向对照逐条实跑，红的一律是**用例名**。另：`tests/payment.test.js` 那条支付路由硬计数本轮不受影响（未动 payment 模块） |
| R35 | 用户报告的一项界面优化（非审计轮）：**「用户管理」卡片里的列表最多展示 10 个用户**；≤10 个时直接展示全部并**隐藏**「显示全部」按钮；>10 个时展示该按钮，点击打开一个对话框展示全部用户，对话框内要有**滚动条与搜索框**便于管理，且尺寸要合适 | 1 项功能（`R35-01` 用户列表 10 条预览 + 「显示全部」对话框）+ 15 条行为护栏（`tests/audit35-regressions.test.js`）+ 18 条反向对照（`R35-01a`~`r`，台账 298 → 316）；版本 `1.4.0` → `1.5.0` | 这一轮没有**缺陷**，只有**产品需求**，因此护栏的落点与前几轮不同：不是「证明修好了」，而是**把需求的边界逐条钉死**。逐条：**① 截断与按钮显隐**（需求 1 / 2 / 3）。卡片渲染 `users.slice(0, USER_PREVIEW_LIMIT)`；按钮判据是 `total > USER_PREVIEW_LIMIT` —— 用**严格大于**，因为正好 10 位时卡片已经完整展示了全部用户，此时再摆一个「显示全部」，点开只能看到与卡片一字不差的一份副本（这正是 `>=` 与 `>` 之别，已单独登记反向对照 `R35-01b`）。上限 10 这个数落在 `util.js` 的 `USER_PREVIEW_LIMIT`，**卡片截断与提示文案共用它** —— 两处各写一个字面量 10，改一处就会出现「卡片显示 10 条、提示却写 20 条」这种自相矛盾的界面（`R35-01a` 撤掉截断即变红）。**② 对话框本身**（需求 3 / 4）。宽版弹窗 + 专属尺寸类 `user-all-dialog`（`width: min(980px, 94vw)`，7 列表格比通用 720px 宽版更宽；用 `min()` 兼顾窄屏）；`openModal` 为此**新增了 `cls` 参数**，而不是在调用后 `querySelector('.dialog').classList.add(...)` —— 让「这个弹窗长什么样」与「它装了什么东西」在同一处声明，且能在测试里被断言。顶部是**固定**的搜索框与计数「匹配 x / 共 N 位」，下方 `.user-all-body` 自带 `overflow:auto` + `max-height: min(54vh, 460px)`，表头 `position: sticky` 吸顶（长列表滚到中间仍知道每列是什么）。**③ 三个最容易做错的地方，各自有专门用例**。其一，**对话框里的每一行都必须带完整操作按钮**（编辑 / 封禁 / 解封 / 删除）：把对话框做成「只读清单」是最省事也最致命的写法 —— 「列表里看不见的用户 = 管不了的用户」，50 个用户时后 40 个将永远无法编辑/封禁/删除。用例的前置断言刻意先证明「第 12 位不在卡片里」，再在对话框里把它删掉（`R35-01h` 撤掉行内按钮的绑定即变红）。其二，**卡片与对话框共用同一个渲染器** `userTableHtml()` 与同一套行内绑定 `bindUserRowActions(root, users)`：两处各抄一份表格必然逐渐分叉，出现「卡片里能封禁、对话框里却不能」这种只能翻代码才解释得通的现象；`bindUserRowActions` 的 `root` 参数限定查询范围，不限定就会把**另一个容器**里的按钮一并绑上（两个列表的 DOM 顺序并不保证一致）。这条用静态断言钉死：`<th>用户名</th>` 在 `syssettings.js` 里只允许出现一次，`userTableHtml(` / `bindUserRowActions(` 各恰为「1 处定义 + 2 处调用」（`R35-01n` 在对话框里另抄一份表头即变红）。其三，**所有变更共用一个刷新收口点**：删除/编辑/封禁之后仍走 `loadUsers() → renderUsers()`，对话框的重绘挂在 `renderUsers()` 末尾（`repaintAllUsers()`），而不是在每个操作里各写一遍刷新 —— 那样迟早漏一个，表现为「在对话框里删掉了人、对话框里却还留着」（`R35-01i` 即变红）。**④ 状态放在模块级而不是弹窗闭包里**，两处后果都有用例：搜索关键词必须**跨刷新保持**（用户搜到一半、后台刷新一次就把过滤条件清掉，列表会在他毫无操作的情况下突然变回全部）；关闭弹窗时必须在 `onClose` 里复位（`allUsersOpen` 不复位 → 第二次点「显示全部」永远打不开，`R35-01k` 即变红）；登出 / 切到非管理员时由 `clearUserDom()` 与卡片列表**一并**抹掉对话框内容（用户名、角色、封禁原因都不得留在 DOM 里，`R35-01j` 即变红）—— 原先「清空用户卡片」的逻辑散在 `reset()` 与 `setAdminCardVisible()` 两处各写一遍，本轮顺手收敛成这一个函数。**⑤ 搜索规则收敛为纯函数** `util.filterUsersByName()`（唯一实现点）：**大小写不敏感的用户名子串**匹配，空关键词返回**副本**（把 `usersState` 本体交出去，调用方任何一次 sort/splice 都会就地改掉模块状态，而"过滤"这个动作看上去是无害的）、脏数据不抛错、不改入参；因为数据本来就在内存里，所以**既不防抖也不发请求**。`R35-01f`（改成大小写敏感）与 `R35-01g`（空关键词返回空数组 → 搜索框一清空整个列表就白屏）各自让两条用例变红。**⑥ 本轮唯一一处"看着写了、其实一直露着"的样式坑**：「显示全部」的容器是 `display:flex`，而 `hidden` 属性在 flex 容器上**完全无效** —— 必须显式声明 `.user-more[hidden] { display: none; }`，否则 10 位以内也会一直露着这个按钮。这类问题行为护栏看不见（假 DOM 里 `hidden` 只是个属性，赋值就"生效"），只有静态断言能拦住（`R35-01l` 删掉该规则即变红）。**⑦ 假 DOM 的能力与边界**：沙箱的假 DOM 沿用 audit33 那套**能解析 `innerHTML`** 的实现（用户行是渲染进 `innerHTML` 的，不能从片段里抽出 `data-act` / `data-id` 就抓不到"按钮没接线"），并**刻意把 `#user-all-search` / `#user-all-body` 的存在性断言打在 `modal.body.innerHTML` 上** —— 假 DOM 的 `getElementById` 对任何 id 都会**凭空造一个**元素出来，直接 `assert(dom.get('x'))` 永远为真，是标准的假绿。`util.js` 桩这一轮改为**只替换依赖 DOM 的 `toast` / `confirmDialog` / `openModal`，其余（`escapeHtml` / `filterUsersByName` / `USER_PREVIEW_LIMIT` / `fmtTime`）直接再导出真实实现**：否则"被测的纯函数"与"被测的转义"都成了测试自己写的副本，只能证明自洽（第 30 轮假 Azure 的 SAS 就是这么栽的）。`openModal` 的桩还必须与真实实现**同形**（关窗时调用 `onClose`），否则「关窗后状态没复位」这条永远测不出来。**⑧ 一处口径说明**：卡片展示的是服务端顺序的**前 10 位**（`listUsers()` 按插入顺序返回，即最早创建的在前），而不是"最近 10 位" —— 这样卡片列表与对话框（同样按服务端顺序）呈**一致的前缀**，不会出现「卡片显示第 41~50 位、对话框却从第 1 位开始」的分裂感；超出部分由「显示全部」+ 搜索兜住，因此新增用户后需要点一次「显示全部」才能看到（提示文案已写明"卡片仅显示前 10 位，共 N 位用户"）。15 条护栏全部实跑，18 条反向对照逐条确认**红的是用例名**而不是文件级语法错误。**⑨ 本轮在「审计工具自身」上踩了两个坑，都值得留下**。其一，**位置参数被静默忽略**：脚本的过滤只认 `--only=<片段>`，而 `node scripts/reverse-check.js R35-01`（本意"只跑这一轮"）里的位置参数被无声丢弃 ⇒ 变成跑满**全量 315 条**台账，其中 36 条以 `deploy-script.test.js` 为对象（该文件单跑约 2.5 分钟）⇒ 数小时。实测在 10 分钟、14 条之后才察觉，只能强杀；而**强杀会留下一个正处于变异态的源文件**（这次是 `deploy.sh`，靠目录里那份 `*.reversebak` 才认出来，`cmp` 一比即知该还原哪一个）。故把参数解析抽成可测的纯函数 `parseArgs()` 并在主流程里**见到位置参数直接 exit 2**。其二，**目标文件就是台账自身时，单行 anchor 会命中两次**：`R35-01r` 检查的是 `scripts/reverse-check.js`，而 anchor 的字面量也写在同一个文件的 `CASES` 里（**行号更靠前**），`String.replace` 只替首处 ⇒ 变异打在台账的字符串上、被测代码毫发无伤，实跑得到 `fail=0`「护栏没抓到」的假象。修法是 anchor 必须**跨行**（字面量里写 `\n` 转义而非真换行，于是副本不再等于 anchor）。连带还发现**那条护栏本身不可证伪**：最初用「源码里有没有 `process.argv.slice(2).filter(` 这段字样」来断言，而这段字样**就存在被检查的文件里**（作为 anchor 字面量）⇒ 断言永远为真、`fail=0`。这正是本仓库反复记录的"判据没落在它声称要守的东西上"，改法与前几轮同型：**把判据从"源码长什么样"改成"行为是什么"**（驱动 `parseArgs()` 并断言返回值）。因此脚本里那三行 `console.error` 是**测试直接驱动**的，不再是靠 grep 认字 |
| R36 | 用户报告的四项界面优化（非审计轮）：① **「全部用户」对话框新增角色下拉**用于筛选；② **文件 / 文件夹的「属性」**：文件夹显示「创建者：」、文件显示「上传者：」；③ 「访问密钥管理」「存储桶管理」两卡片**对齐「用户管理」**——列表只显示 10 个 + 「显示全部」对话框 + 服务商下拉 + 搜索备注，其中**存储桶还要能搜桶名、且只允许一个搜索框同时搜两者**；④ 「分享链接管理」上限 **100** + 「显示全部」+ 存储桶下拉 + 搜文件名与分享者 | 4 项需求（`R36-01` 四卡片「显示全部」共框架 / `R36-02` 属性面板创建者·上传者 / `R36-03` 上传者元数据 / `R36-04` 角色筛选）+ 30 条行为护栏（`tests/audit36-regressions.test.js`）+ 28 条反向对照（`R36-01a`~`R36-08e`，台账 316 → **344**）；版本 `1.5.0` → `1.5.1` | 本轮与 R35 同型（**需求，不是缺陷**），但要把 R35 只落在「用户管理」一张卡片上的交互**复制到另外三张**，因此工作的重心从「实现一遍」变成「**收敛成一个唯一实现点，再让四张卡片都走它**」。**① 三个共享判据**：其一，`util.previewMoreState(total, limit, unit)` —— 「显示全部」的显隐判据与提示文案。**严格大于**（口径已与用户确认）：正好等于上限时卡片已经完整展示了全部条目，再摆一个「显示全部」，点开只能看到与卡片一字不差的一份副本。四张卡片的上限各不同（密钥 / 桶 10、链接 100），但判据只有这一处 —— 写四份的必然结果是「其中一张被改成 `>=`」而另外三张还是 `>`。其二，`util.matchesQuery(query, texts)` —— 关键词规则：**多字段任一命中**、大小写不敏感、空串恒真、脏数据不抛错。`texts` 传数组是关键：③④ 两条需求都要求「一个框搜多个字段」（密钥搜备注 + 访问密钥 ID、桶搜桶名 + 备注、链接搜文件名 + 分享者），若只比第一个字段，第二个字段就永远搜不到 —— 而界面上看起来「搜索框是好的」。其三，`public/js/listdialog.js` 的 `openListDialog(o)` —— 对话框**骨架与状态**（工具条 + 搜索框 + 下拉 + 计数 + 滚动容器 + 两种空态 + 行绑定）。**它必须是一个独立文件，而不能写进 `util.js`**：测试沙箱会用桩替换 `util.js` 里直接操作真实 DOM 的 `openModal`，再把 `listdialog.js` **原样**拷进沙箱 —— 于是**真实**的对话框逻辑跑在桩化的弹窗原语上；若它住在 `util.js` 里，沙箱只能连它一起换成桩，测到的就是「测试自己写的一份副本」，只能证明自洽（第 30 轮假 Azure 的照抄 SAS 规范资源就是这么栽的）。**② 两处最容易被做错的语义**：其一，「一个搜索框同时搜两者」（需求 2④）**不是**「放两个搜索框」，也不是「搜完再搜」—— 它是 `filterBuckets` 收到**一个** query 后同时比 `bucket` 与 `remark`，对话框里只渲染**一个** `<input type="search">`。其二，存储桶的「仅剩最后一个启用桶时禁止停用」（`disBlocked`）必须在**未经过滤的全量数据**上判定 —— 对话框里按服务商筛过之后 `rows` 只是子集，在子集里数启用桶会得出「这个厂商只剩一个启用桶了」的错觉，把本该可停用的按钮锁死。故渲染器签名是 `bucketTableHtml(rows, all)`：**第一参渲染、第二参判据**，`rowHtml: (shown) => bucketTableHtml(shown, cache)` 传的正是全量 `cache`；这一条同时被专门用例钉住（`R36-04b` 把第二参改成 `shown` 即变红）。**③ 行按钮绑定的统一**：R35 的 `bindUserRowActions` 用的是扁平 `root.querySelectorAll('[data-act]')` + `btn.getAttribute('data-id')`（按钮自带 `data-id`）。本轮把三张新卡片的绑定**改成同一形态**，好处不只是「四张卡片一致」——它让**一套**假 DOM 就能驱动全部四张卡片的行内操作（这正是本轮多条用例得以写出来的原因）；代价是三张卡片的 HTML 里每个操作按钮都得补上 `data-id`，属真实改动。**④ 「上传者」元数据（需求 1 的数据源）**：属性面板要显示上传者，数据来自**对象自身的元数据**而不是任何一张本地表 —— 本地表在「云端被别的工具改过」时就会开始说谎。三条硬约束：其一，**S3 / COS 的对象元数据只能在建对象时写**（`putObject` / `multipartInit`），创建之后再改要另发一次 copy 请求，故四个写入出口（`/fs/mkdir`、`/fs/upload/simple`、`/fs/upload/init`、WebDAV PUT / MKCOL）在建对象时就把 `x-s3-meta-uploader` 一并写进去；**Azure 是例外**：它的 Put Block List **也**接受 `x-ms-meta-*`，所以分片 complete 那一步同样带上（对 S3 / COS 是空操作）。其二，**键名只允许在 `s3.js` 出现一次**（`uploaderMeta()` 写端 / `readUploader()` 读端成对放在那里）：上游若各自拼 `headers['x-s3-meta-uploader']`，将来改名字必然漏掉一处，而漏掉的表现在界面上只是「某一处显示 — 」，几乎不可能被 review 发现；适配器负责翻译（`s3-client` → `x-amz-meta-*`、`azure-client` → `x-ms-meta-*`，两个适配器各有一份 `_metaHeaders()`，单传与分片两条路径共用同一映射）。其三，**历史对象如实显示「—」并带 `title` 解释原因，绝不拿「当前登录用户」或「最后操作者」顶替** —— 那是在编造一个看起来合理的事实，而属性面板的全部价值就在于它说的是真的。**「重命名 / 移动不会改变它」**是刻意的（服务端复制默认保留元数据），唯一需要特判的是 `movePrefix` 重建**空目录标记**那一步：它新建了一个对象，若不把原标记的上传者读出来带上，一次移动就把文件夹的「创建者」抹成「—」（而文件的上传者反而因复制保留元数据而幸存，形成「文件的还在、文件夹的没了」的诡异现象）。**⑤ 属性面板的渲染器收敛**：`util.ownerText()`（展示值：转义、空白裁剪、空值→「—」）与 `util.propertyBodyHtml(st, type)`（正文）是**唯一实现点**；「标签随对象类型变」这条规则只允许出现一次（`st.isFolder ? '创建者' : '上传者'`）。若照旧在两个 `if` 分支里各写一行 `row(...)`，将来给文件多加一行（比如「加密」）时只改一处、另一处静默落后，就会出现「文件夹属性里有的项，文件属性里没有」—— 而两处看起来都「写了」。`explorer.js` 因此瘦成「取数 + 把结果塞进弹窗」，并且不得再出现「创建者 / 上传者」字面量（静态断言数次数）。**⑥ 本轮把 R34 留下的家族护栏推广了**：R34 有一条「桩的导出集 ⊇ 被沙箱化模块的具名导入集」的静态护栏，但它当时**只遍历 `syssettings.js` 与三个文件**。本轮 `linkmgr.js` 新增了 `matchesQuery` 具名导入，那条护栏**没有响**，而 audit32 里 import linkmgr 的用例因为 ESM **链接期**校验整片变红（桩少一个导出 → 文件里所有用例一起红）。修法不是补一处桩，而是把护栏**改成按每个测试文件实际沙箱化的模块自动推导**（解析该文件的 `makeXxxSandbox([...])` 与 `copyFileSync(JS('...'))`，再要求它的 `util` 桩导出那些模块从 `./util.js` 导入的每一个符号），并加一条下界自检（`checkedPairs >= 6`）防「一个都没扫到」的假绿。**⑦ 重构会「老化」既有护栏，本轮连中两处**：其一，`syssettings.js` 的用户对话框改走 `openListDialog` 后，R35 登记的 **11 条 anchor 静默失效**（判据下沉到 `util.js`、搜索接线与行绑定下沉到 `listdialog.js`、`onClose`/`clearUserDom` 改了写法）—— anchor 随重构一起迁移，`invariants` 那条「每条 anchor 必须在各自的 file 内唯一命中」的自检正是为此存在的（脚本只会在跑到该条时才报「锚点未命中」，没人跑就等于没登记）；其二，`fs-gateway.writeObject` 多了第 7 个参数 `uploader`、`Headers` 由字面量改成 `Object.assign(...)`，`R7-06` 的 anchor 也随之迁移，且**变异只改「走不走 `p()`」这一件事**（Headers 保持与现实现逐字相同），否则红的原因就不唯一。**⑧ 假 DOM 的能力边界**（沿用 audit33/35 那套**能解析 `innerHTML`** 的实现）：本轮又补三处 —— `globalThis.addEventListener`（`syssettings.js` 在模块里注册了全局监听）、`globalThis.localStorage`（bucketmgr **在模块加载时**就读它）、`querySelector('#id')`（credmgr 的 `renderAddForm`/`syncProviderLabels` 走 `wrap.querySelector('#cred-sid-label')`）；另外 `getElementById` **对任何 id 都凭空造一个元素**，所以「对话框里有没有某个控件」这类断言一律打在 `modal.body.innerHTML` 上，直接 `assert(dom.get('x'))` 永远是假绿。**⑨ 一处「看着写了、其实一直露着」的样式坑**：「显示全部」的容器是 `display:flex`，`hidden` 属性在 flex 容器上**完全无效** —— 必须显式写 `.list-more[hidden] { display: none; }`（R35 只写了 `.user-more[hidden]`，本轮推广成 `.list-more`）。假 DOM 里 `hidden` 只是个属性、赋值就「生效」，因此这条只有静态断言拦得住。**⑩ 边界口径与计数**：上限用**严格大于**（已与用户确认「与用户管理一致」）；卡片展示的是服务端顺序的**前 N 位**，与对话框（同序）呈一致前缀，超出部分由「显示全部」+ 搜索兜住。30 条护栏全部实跑，28 条反向对照逐条确认**红的是用例名**而不是文件级语法错误 |
| R37 | 用户提出的功能需求（非审计轮）：① 在 **API Key 管理 / 存储桶管理 / 用户管理 / 文件分享 / 链接管理** 五处新增「**下载限速**」，优先级从高到低为 **API Key → 存储桶 → 用户 → 文件分享 = 链接管理**，下层设置时要提示「已在 XX 管理中设置限速为 xx MB/S」；② 在**订单管理与监控仪表盘之间新增「IP 地址管理」页**，实现「**IP 地址限速**」（与「IP 访问屏蔽」一样支持 CIDR），并把存储桶管理里的「**IP 访问屏蔽**」整体**迁移**过去 | 1 个新模块（`server/throttle.js`）+ 1 个新路由（`GET /throttle/ceiling`）+ 1 个新页面（`public/js/ipmgr.js`）+ 1 个新前端模块（`public/js/speedlimit.js`）+ **26 条行为护栏**（`tests/audit37-regressions.test.js`）+ **14 条反向对照**（`R37-01a`~`R37-07a`，台账 344 → **358**）+ 1 条**新的家族护栏**（沙箱缺文件的链接期失败，`audit34-update.test.js`）；版本 `1.5.1` → `1.6.0` | 本轮最核心的一条语义是**「取各层最小值」**（已与用户确认）：下层只能更严，不能更松。它带来三个必须想清楚的设计点。**① 限速环节必须与既有的单条 pipeline 串联，而不是另接一个 `data` 监听。** 下载下发的三个阶段是 `out`（解密）→ `meter`（计量）→ `res`，本轮把节拍器插在 `out` 与 `meter` 之间：放在解密**之后**是因为限速要按**明文字节**计（用户看到的是明文，按密文计会让「限速 5 MB/s」在大文件上莫名变慢）；放在计量**之前**是因为这样 `traffic.bytesDown` / `statsStore` 记的字节数与**是否限速无关**（否则一开限速，两个出口记的账就对不上）。节拍器**自带背压**（在 `transform()` 里不调 `cb()` 就把上游顶住），所以绝不能给它挂一个独立的 `data` 监听 —— 那会绕过背压，`res` 的内存随下载大小无界增长。**② 「限速」与「10 分钟无活动超时」的相互作用是本轮最难的题，靠构造解决而不是靠调参。** `DOWNLOAD_TIMEOUT_MS = 10min` 是**无活动**超时；若照朴素做法「等 `chunkLen / rate` 再整块放行」，1 KB/s + 64 KB 分块就有 64 秒静默期，一个完全健康的下载会被判死。因此节拍器按 **100ms 节拍**释放 `max(1, floor(rate × SLICE_MS / 1000))` 字节，写间隔**恒 ≤ SLICE_MS**，与速率、分块大小都无关（实测最大间隔 111~112ms）。另一处刻意的取舍：**不给突发额度**（credit 上限也是一个节拍），否则会出现「我设了 5 MB/s，怎么一点下载就瞬间下了 5 MB」这种用户一眼就看出来的怪事；代价是低于 10 B/s 时 1 字节下限会抬高有效速率，而界面单位是 MB/s、步长 0.1，够不到那里。**③ 并发公平。** 首次实测发现同一存储桶的两条并发下载能压住**总量**却分配不均（一条全速、一条一半）—— 修法是让桶记录 `active` 连接数，每拍取 `min(可用额度, floor(额度 / active), 待发字节)`；修后两条各 ≈ 1 MB/s（200 KB 各耗时 1978 / 2064ms）。**④ IP 层的形状坑（本轮唯一靠端到端冒烟才发现、而不是靠 `node --check` 或读代码发现的缺陷）**：`ipGuard.evaluate(ip, …)` 收的是**原始 IP 字符串**，而 `security.clientIpInfo(req)` 返回的是 `{ip, fromForwarded}` 包装 —— `speedLimitFor` 一开始按包装对象写，于是 `cidrMatch` 读到 `undefined`、**恒不命中**：限速配好了、保存成功、界面显示生效，实际全速下载，而所有静态检查与单测全绿。修法是把 `speedLimitFor(ip, method, bucketId)` 收敛成与 `evaluate` **同形状**（内部自己 `parseIpInfo`），三个调用点（`routes/fs.js`、`share-routes.js`、`webdav-server.js`）统一改传 `security.clientIp(req)`，并把这条形状约定写进函数注释。**⑤ 「屏蔽」与「限速」共用一张规则表，靠 `kind` 分栏、靠两个互斥判据求值。** `matchRules()` 跳过 `kind === 'speed'`，`speedLimitFor()` 只认 `kind === 'speed' && speedLimit > 0`（且必须 `enabled`）—— 否则会出现「设了限速反而被 403」或「点了禁用仍在限速」；`addRule` 一律 `enabled: true`（与屏蔽规则一致），故新规则要靠「禁用」按钮停用。不可解析的 IP 返回 `null`（**fail-open**：限速是资源管理、不是安全边界，不该因为一个畸形地址把所有人限住），与 `evaluate` 的 fail-closed 刻意相反。**⑥ 唯一实现点与「不猜」。** `server/throttle.js` 是唯一的节拍器与层聚合实现；`server/limits.js` 收纳 `MB` / `normalizeSpeedLimit` / `toMBps` / `parseSpeedLimitInput`（无依赖叶子，破环）；前端 `public/js/speedlimit.js` 收纳单位换算、输入判据（`parseMbpsInput`，与服务端同语义：非法**必须报错**，绝不静默归零 —— 与 `quotaBytes` 同型）、上层提示文案（`ceilingText`，需求原文句式只此一处）。写入**刻意复用各实体既有的 `PUT`**（`speedLimit` 只是又一个普通字段），而不是新开「设置限速」接口 —— 同一字段两条写路径必然出现校验 / 审计 / 权限各写一份。读则必须单独一个接口（`GET /throttle/ceiling`）：跨层聚合需要「这个桶归哪把密钥」，而那个判据在服务端（`config-store.activeCredential`），前端拼就等于在浏览器里重写一份归属推导。`scope=user` 之上**刻意返回「不限」**：同一用户可访问多个桶 / 多把密钥，随便挑一个都会给出一个看似有理、实际错误的数字。该接口**不挂 `requireAdmin`**（普通用户新建分享时要用），返回的 `layers` 也**不带任何 id**，免得把桶→密钥的归属顺带泄露出去。**⑦ 迁移是「搬」而不是「复制」。** 「IP 访问屏蔽」整卡从 `#bucketmgr` 移入新的 `#ipmgr`，`bucketmgr.js` 从 932 行瘦到 582 行；跨页复用的「穿梭框」`buildTransferBox()` 随之从 `bucketmgr.js` **移入 `listdialog.js`**（否则新页面要反向 import 一个页面模块）；两张卡片共用**一次** `API.ipGuard()` 请求（同一份数据分两栏展示 —— 两个接口就是同一状态的两条读路径）。`main.js` 里登记 `MAIN_VIEWS` / `switchMainView` / `ipmgr.reset()`，并按角色隐藏入口、整页与两张卡片（规则详情含其它用户的来源 IP）。**⑧ 两处如实记录的局限**：其一，`GET /fs/presign` 签出的直链由客户端**直接连对象存储**下载，本进程拦不到任何字节 —— 这是**无法在进程内修好**的旁路（只能「取消直链」或「全部走代理」），已在 `routes/fs.js` 与界面文案里写明；其二，**WebDAV 只有 IP / API Key / 存储桶三层，没有「用户管理」层** —— `req.webdavUser` 是 `cfg.webdav.accounts` 里的应用凭据，与系统用户表没有可靠对应关系，按同名去匹配会是一次静默的错误归因，故刻意**不猜**并写进注释与文档。**⑨ 重构再次「老化」既有护栏，而且这次是 4 个文件**：`syssettings.js` / `linkmgr.js` 新增 `./speedlimit.js` 具名导入后，audit31 / 32 / 33 / 35 四个沙箱因缺文件在**链接期**整片变红（与 R36 的 `listdialog.js` 同型）。补文件只是一半 —— 另一半是把「沙箱必须为被拷入模块的每个本地依赖提供桩或副本」登记成**家族护栏**（`audit34-update.test.js`，按每个测试文件实际沙箱化的模块自动推导依赖闭包，并区分「拷真文件」与「换桩」两种提供方式：桩整体替换了真模块，对桩递归会去读真实 `main.js` 的十几个页面级依赖，报出一串纯属虚构的缺失）。**⑩ 一条自身的教训**：本轮先写护栏再登记台账，结果 **26 条里有 8 条首跑就红**，全是**护栏自己**写错了 —— 把 `evaluate` 的返回值记成 `{blocked}`（实际是 `{ok, reason}`）、忘了 `create` 是 `async`、把 `request()` 的 `json` 写成 `body`、用 `addRule({enabled:false})` 去试「已禁用」（实际恒为 `true`）、以及两处**测试场景自相矛盾**（屏蔽段与限速段重叠、被禁用的规则落在另一条 /24 覆盖范围内）。真正可靠的不是「写了很多断言」，而是**先跑一遍再登记**：14 条反向对照逐条实跑确认红的是**用例名**，`fail` 分别为 1~4 条且全部落在预期用例上 |
| R38 | 用户提出的两件事（非审计轮）：① **修复**：部署后启用 Windows Hello 时提示「当前访问地址不是本站域名，Windows Hello 仅能在本站域名下使用；请改用配置的站点域名访问，或用密码登录」（用户要求分析根本原因，**重点排查域名校验逻辑与站点域名配置的匹配关系**）；② **新增**：设置页「关于」卡片**上方**新增「**备份配置**」卡片，展示一串代表配置备份的长代码 —— 支持导出（复制 / 导出为 JSON）、用户改设置后随时更新、仅在「首次启动并创建用户后」允许导入（可恢复 API Key / 存储桶 / recaptcha 等）、导出需密码验证且须**当场另设一个独立备份密码**（导入时输入）、备份范围仅 **8 项**（API Key 管理 / 负载均衡 / 上传排除 / 登陆验证 / WebDAV 服务 / 支付设置 / 存储桶管理 / IP 地址管理）（**R55 起扩至 10 项** —— 末尾追加「发信设置」「站点设置」，见下方 **R56** 行）、**所有用户都不在备份范围内（含管理员）**，界面并说明三点（① 分享链接与订单属运行时数据、全量备份会触及 `express.json` 的 2MB 上限，故不在范围内；② 文件与用户相关的密钥文件无法备份也绝不能备份，故「备份文件加密选项」与「用户列表」没有意义；③ 导入后原有设置项被直接覆盖、全部丢失） | 1 个修复（`R38-01` 本站域名判据）+ 1 项功能（`R38-02` 备份配置）+ 1 个新模块（`server/backup.js`）+ 1 个新路由模块（`server/routes/backup.js`，4 条接口）+ 1 个新前端模块（`public/js/backupcfg.js`）+ 1 个新环境变量（`SITE_DOMAIN`）+ **31 条行为护栏**（`tests/audit38-regressions.test.js`）+ **17 条反向对照**（`R38-01a`~`R38-02x`，台账 358 → **375**）；版本 `1.6.0` → `1.6.1` | **① 根因不在「域名校验逻辑写错了」，而在「站点域名根本没被送达应用」。** 顺着提示语往下追：`routes/_shared.js` 的 `webauthnContext()` 要求 `rpId` 落在「本站域名」允许集内 —— 这是 R24-02 为防仿冒域骗取签名而刻意设的 **fail-closed** 判据，**不该放宽**；允许集的来源只有两处：`DEPLOY_HOST = process.env.HOST` 与 `cfg.domains.{primary,backup}`。而部署脚本生成的 `.env` 写的是 **`HOST=0.0.0.0`** —— **通配绑定地址，永远不可能出现在请求的 `Host` 头里**；真实域名只被写进 nginx 的 `server_name`。全库 grep `process.env.*` 确认当时**没有任何**途径能让应用知道「自己叫什么」。于是允许集**实际为空**（`0.0.0.0` ＋两个默认空串），用真实域名访问本站反而被判成「访问了外站」。另一处同源症状：`httpsRedirectHost()` 的回退分支把「无域名可用」误判成「有域名可用」，HTTP 跳转目标变成 `https://0.0.0.0:3443/…` —— 一个必然打不开的地址。**② 修法是补上缺失的事实来源，而不是放宽判据。** 新增环境变量 `SITE_DOMAIN`：`security.js` 把它读作「本站对外域名」的权威来源并纳入允许集，`deploy.sh` 写 `SITE_DOMAIN=${DOMAIN}`；同时**把通配绑定地址从允许集里剔除**（`isBindAllHost`）—— 它留着不会误放行，却会让「无域名可用」这件事看起来像「有域名可用」。刻意**没碰** R24-02 那条 fail-closed 判据：4 个外部域名仍一律拒绝（`R38-01b` 就是「顺手把判据放宽成恒真」的反向对照）。**③ 「本站叫什么」与「分享链接用哪个域名」是两件事，不可合并。** `cfg.domains` 由「密钥管理页 → 自定义请求域名（可选）」写入，其自带提示写的就是「分享地址」；拿一个**展示偏好**去当 WebAuthn 的 `rpId` 白名单或 HTTPS 跳转目标，等于让一个分享用 CDN 域名决定安全判据。故另立 `SITE_DOMAIN` 并在两处注释里写明语义差异。**④ 备份范围的第一个坑：需求列的 8 项在数据模型里只有 7 处。** 「负载均衡」展示与编辑的就是每个 API Key 的**空间上限**（`credentials[].quotaBytes`），与「API Key 管理」在 `config.enc` 里**本就是同一条记录**。刻意不另存一份，而是用 `SCOPES`（8 项，给人看）→ `SECTIONS`（7 项，实际落盘）的映射并断言两者关系 —— 另立一份必然在导入时出现「谁覆盖谁全凭顺序」。**⑤ 第二个坑：WebDAV 账户口令不能原样搬家。** 它在 `config.enc` 里是**字段级密封**（`passwordSealed`，绑定本实例的 `data/secret.key`），搬到另一台实例只是一段永远解不开的密文，症状是「导入成功、WebDAV 却登录不上」。故导出走 `revealWebdavPassword()` 取**明文**、导入走 `addWebdavAccount()` 按**目标实例**重新密封，并由一条用例在导入后真的对当前实例发一次 WebDAV Basic 认证来证明。**⑥ 第三个坑：`ip-guard` 的规则不能循环 `addRule()` 还原。** 那样会丢掉 `id` 与 `enabled`，于是「备份时停用的屏蔽规则，还原后悄悄启用」—— 用户只会觉得「导入把配置弄坏了」。为此把规则归一化抽成**唯一实现点** `normalizeRule()`（读盘与导入共用），并新增整批替换 `replaceAllRules()`（`R38-02o` 即把这两件事同时改坏）。**⑦ 加密选型与「先认证后使用」。** 导出码用 **AES-256-GCM** 而非 CBC：密码错与被篡改在服务端成为**同一种不可区分的失败**，更关键的是 GCM **先认证、后使用** —— 半截配置的导入是**破坏性**的（覆盖语义），绝不能出现「认证没过却已经写了一部分」（与 R27-11 的教训同型）。备份口令用 scrypt（`N=16384, r=8, p=1`），长度 8~128，与 WebDAV 账户口令同一上限。**⑧ 实时码为何刻意不含时间戳。** 需求要的是「修改设置后随时更新」，而不是「每次请求都不一样」；带上时间戳会让码每刷新一次就变，用户根本分不清「我改了设置」与「它自己又变了」。故 `payloadOf()` 是配置内容的**纯函数**，并用用例钉住「同一份配置必须得到同一串码」。**⑨ 导入闸门的位置本身就是安全属性。** 「仅首次初始化可导入」的判据 `canImport()`（＝ 备份范围内的每一项**都还是默认值**，而不是某个一次性标记：标记要在导入后重置、要在配置损坏时兜底，任何一环漏掉就是「第二次导入把线上配置全冲掉」；而「还没配过任何东西」是**可从当前状态直接算出**的事实，不需要维护。它**不检查用户表** —— 全新实例上已经有第一个管理员，否则你也打不开这个页面，这正是需求说的「首次启动并创建用户后」那个窗口）**必须在解密之前**判定，否则「在已配置实例上反复试备份密码」就是一条口令爆破信道（响应差异可区分密码对不对）。`status` 接口**不缓存**该判据，否则会出现「刚配好密钥却仍显示可导入」的按钮，而那一次点击是不可撤销的。**⑩ 一个「看着能用、其实到不了客户端」的字段被自己拦下。** 导入接口最初在 409 的错误对象上挂了 `backupImportClosed: true`，而 `apiHandler` 只下发 `{ error: err.message }` —— 挂在错误对象上的自定义字段**到不了客户端**，属不可观测代码。改为前端只看**状态码 409**，并把这条理由写进注释与用例。**⑪ 反向对照首跑 15/16，漏的那条连错两次。** `R38-02t` 前两次都把变异打在 `backup.canImport()` 的**本体**上（加 module 级缓存），而护栏在 `R38-02l` 里已经先调过一次该函数、之后实例一直是「已配置」状态，缓存值恰好等于期望值 → `fail=0`。教训是「护栏说『不缓存』，变异就必须打在**这条用例实际读的那个值**上」：最终改成把接口返回值写成定值才命中（并把这段弯路记进 `CASES` 的注释）。**⑫ 顺手补了一处静默漂移。** R37 新增的 `server/routes/throttle.js` 当时没被登记进文档的路由树，而**没有任何护栏管 `routes/` 的清单**（`docs-sync` 只校验 `server/` 根目录），于是静默漂移了一整轮；本轮补上它并一并登记 `routes/backup.js`。**⑬ 最危险的一条失效模式补了专门护栏。** 需求把用户表排除在备份之外，因此 `apply()` **只覆盖备份范围里的顶层键**。这条性质一旦破掉（图省事的 `configStore.save(payload)` 会连带把 `users` 一起写掉），后果不是「某个设置没还原」，而是把系统导成**零管理员**：管理页面打不开、也没有任何自助恢复通道。`R38-02x` 就是钉住它 —— 即便载荷里被塞了一张用户表，导入也不得据此顶替或清空本机用户（`R38-02x` 把这一步写成 `configStore.save({ users: … })` 即变红）。 |
| R39 | 用户报告：**1.6.1 改完之后故障依然复现** —— 原话「问题依然存在：『当前访问地址不是本站域名，Windows Hello 仅能在本站域名下使用；请改用配置的站点域名访问（docker / systemd 部署请确认 SITE_DOMAIN 或 HOST 与浏览器地址栏完全一致），或用密码登录』」，并补充「该问题是重置服务器、并使用原有域名重新部署后出现的」；追问确认：部署方式为**一键脚本**（`curl -fLo /tmp/kepler-deploy.sh https://raw.githubusercontent.com/…/main/deploy.sh && sudo bash /tmp/kepler-deploy.sh`），浏览器里用的地址与部署时填写的域名**逐字一致** | 1 个修复（`R39-01` 部署脚本与应用的**版本对齐**）+ 4 个新函数（`deploy.sh` 的 `handoff_to_installed_script()` / `handoff_needed()` / `script_content_hash()` / `script_is_sane()`）+ `install_app()` 的「源码目录即安装目录」短路 + `reinstall_now()` 的完整性预检收敛到唯一实现点 + **5 条行为护栏**（`tests/deploy-script.test.js` 的 `R39-01a`~`e`，其中 2 条是真跑 bash 的探针）+ **11 条反向对照**（`R39-01a`~`k`，台账 **375 → 386**）+ 顺带修掉 R38 台账行前多出的空行（那一行此前**渲染不成表格行**）；版本 `1.6.1` → `1.6.2` | **① 症状是「新文案 + 旧环境变量」，它把排查方向整个带偏了。** 用户贴出的报错里已经带着 1.6.1 新加的括号文案（「docker / systemd 部署请确认 SITE_DOMAIN 或 HOST…」），说明**应用确实是新代码**；全库 grep 这条提示语**只有一处抛出点**（`routes/_shared.js` 的 `webauthnContext()`），也说明不存在第二处判据。于是问题只剩「`SITE_DOMAIN` 为什么没生效」。先用真实函数体做探针（把 `gen_env_file()` 原样抽出、喂 `DOMAIN=s3.example.com` 真跑一遍）证明**生成的 `.env` 完全正确**（`SITE_DOMAIN=s3.example.com` 独占一行、无 CR、无多余空白），再确认 `server/` 下**没有任何 dotenv 加载或批量改写 `process.env`** 的代码；nginx 那条路也不可能造成这个 403（`proxy_set_header Host $host` 要么原样传域名、要么退回回环地址，**两种都被允许**）。结论只能是：**跑着的脚本，不是生成这份 `.env` 的那一份**。**② 根因：部署脚本会把「正在执行的自己」换成新版本。** `install_app()` 用 `tar` 把源码树整体同步进 `INSTALL_DIR`，而**`deploy.sh` 自己就在源码树里**；更巧的是最常用的维护入口执行的就是安装目录里那一份 —— `kepler` → 菜单 1「重新安装」→ `reinstall_now()` → `exec bash ${INSTALL_DIR}/deploy.sh --reinstall`（`/usr/local/bin/kepler` 本身只是个转发到该路径的壳）。bash 是边读边执行、**函数定义在解析时就已固化**，文件在运行中被覆盖**不会**重建已解析的定义：`install_app` 之后每一步都还在跑上一版逻辑，旧 `gen_env_file()` 当然不认识 1.6.1 才引入的 `SITE_DOMAIN`。**③ 它完全静默，而且症状自相矛盾。** 旧逻辑写出的 `.env` 与磁盘上已有的那份**逐字节相同**（两份都不含 `SITE_DOMAIN`），`write_file()` 于是判定「配置未变化，跳过写入」—— 部署一路报绿、日志里连一条告警都没有，健康检查与 Nginx 也都正常，站点照常打得开。最终形态正是最难查的那一类：**报错文案是新的（应用是新代码），失败原因却是旧的（环境变量是旧脚本写的）**，于是「顺着提示查应用侧」「重设环境变量」「重装应用」「重置服务器再部署」全部无效 —— 只要走的仍是安装目录里那份旧脚本，重装多少次都一样。**④ 修法是「版本对齐」，不是「再多写一个环境变量」。** 同步完源码后把控制权交回 `${INSTALL_DIR}/deploy.sh`（`handoff_to_installed_script()`）—— 它此刻与刚同步进去的应用**同源同版本**，从它往下跑即可保证「环境变量 / 守护单元 / Nginx 配置」与「应用代码」始终同一版本。判据是两处脚本的**内容指纹**（`script_content_hash()`：sha256 优先、md5 兜底、结果只保留十六进制）：内容相同**不**交接（正常部署不会白跑第二趟）、不同则交接；`KEPLER_SELF_HANDOFF=1` 兜底防环；脚本来自管道、无法自证版本时交给安装目录里那一份。位置刻意排在 `npm_install_deps` **之前**：第二趟以安装目录自身为源码目录，依赖只装一次，不产生重复工作。**⑤ 交接必须「带齐行李」，少一样就是一个新故障。** ① `trap - EXIT` + `KEPLER_LOCK_HELD`：`exec` 不触发 `EXIT` trap，不显式交接锁，新进程一启动就撞上自己留下的锁文件、直接判「另一个部署进程正在运行」（`R39-01f` / `R39-01h` 是同后果的两条实现路径）；② `DOMAIN`：不带就会在终端里**再问一次**域名，非交互场景（管道 / CI）直接判失败（`R39-01g`）；③ 原始命令行用启动时存下的 `ORIGINAL_ARGV` 原样转发（参数解析用了 `shift`，此刻的 `$@` 已经不是原始 argv），否则 `--skip-nginx` 这类开关在第二趟静默失效；④ 先过 `script_is_sane()`（shebang + `bash -n`）再 `exec`，否则会把被污染的文件（把下载到的 `404: Not Found` 响应体存成的「脚本」）当脚本执行（`R39-01i`）。`R39-01b` 的探针会**真的 `exec`** 一个假脚本、并回读它收到的环境变量，逐项证明「行李」确实到了。**⑥ 第二趟会「对自己做 tar 自解压」，必须短路。** 交接后 `prepare_source` 发现脚本就在 `INSTALL_DIR` 里，会把它当成「本地源码目录」，于是 `SRC_DIR == INSTALL_DIR`；此时原来的 `tar -cf - . | tar -xf - -C 同一个目录` 是**一边读一边覆盖自己**（徒劳无功，且理论上可能截断正在读的文件）。故给 `install_app()` 加上真实路径比较（`readlink -f`）的短路，`R39-01j` 撤掉即变红。**⑦ 一个跨轮次的教训：静态文本断言挡不住版本错配。** R38 为此登记的对照 `R38-01f` 断言的是 `deploy.sh` **源码里那一行** `SITE_DOMAIN=${DOMAIN}` 存在 —— 这条断言**本轮照样是绿的**，可用户侧依然复现。也就是说：**「源码里有这一段」不等于「跑起来会执行这一段」**；凡属「某个版本的脚本必须做某件事」的性质，判据都必须落在**实际被执行的那一层**（本轮因此改用内容指纹 + 真跑 bash 的探针，而不只是 grep 源码）。**⑧ 顺手实证掉一个 coreutils 陷阱。** `script_content_hash()` 最初直接用 `awk '{print $1}'` 取 `sha256sum` 的输出，在 git-bash 下拿到的是 `\e8b2…`：coreutils 遇到**文件名里含反斜杠**会给整行加一个转义前缀，而 git-bash 的 `mktemp -d` 返回的正是 `C:/Users/…` 这种路径。后果是同一份内容仅因路径写法不同就得出两个指纹，把「无需交接」误判成「需要交接」。故指纹一律剥掉非十六进制字符（指纹本就只可能是十六进制）。**⑨ 还发现并修掉一处 R38 遗留的文档缺陷。** R38 台账行前面多了一个空行，而 Markdown 里空行即表格结束 —— 那一行**根本不渲染成表格行**（看起来像一段正文）。本轮删掉空行，R37 / R38 / R39 三行重新连成同一张表。**⑩ 用户侧行动项**：重新执行一次部署（`kepler` → 1，或重跑一键命令）即可 —— 环境变量会由与应用同版本的脚本重新生成，`SITE_DOMAIN` 随之补上，**无需手工编辑 `.env`**；若想立刻恢复（不希望再跑一次部署），也可以给 `/opt/kepler/.env` 追加 `SITE_DOMAIN=<你的域名>` 后 `systemctl restart kepler`（docker 方式：改 `.env` 后 `docker compose up -d`，compose 会因 `env_file` 变化而重建容器）。 |
| R40 | 用户提出的三项（非审计轮）：① 原话「现在的 deploy.sh，安装 node 可能出错：因为系统可能是 RockyLinux 8 / CentOS Stream 8 / EL8，系统自带 module 模块仓库里预装了 nodejs 16，和 nodesource 源的 nodejs20 包冲突。EL8 的 AppStream 模块自带多版本 nodejs 模块，旧模块包 nodejs-full-i18n 绑定旧版本 node，直接 dnf install 会版本互斥。综上，直接将 node 安装命令替换为：`dnf install -y nodejs --allowerasing`」；② 「管理员不能在『用户管理』中编辑自己（隐藏自己那一列的『编辑』按钮）」；③ 「在顶部『账户菜单』的左侧新增一个按钮（点击即可切换的太阳/月亮图标），用于快捷切换日间、暗黑模式」；④ 推进版本号至 1.6.3 | 1 个修复（`R40-01` EL8 装 Node 的模块互斥）+ 1 处权限收敛（`R40-02` 不能编辑自己）+ 1 个新前端模块（`public/js/theme.js`）+ 1 层新主题变量（`style.css` 新增 19 个语义槽位、**100 处颜色字面量换成变量**、末尾的 `[data-theme="dark"]` 暗色块）+ **10 条行为护栏**（`tests/audit40-regressions.test.js` **7 条** + `tests/audit35-regressions.test.js` **3 条**）+ **14 条反向对照**（`R40-01a`~`f`、`R40-02a`~`b`、`R40-03a`~`f`，台账 386 → **400**）；版本 `1.6.2` → `1.6.3` | 三条需求性质不同，护栏落点也不同 —— 一条是**环境相关的部署失败**（只能靠真跑 bash 取证），一条是**权限收敛**（假 DOM 行为断言），一条是**新功能 + 架构变更**（静态位置断言 + `vm` 跑真实脚本 + CSS 一致性检查）。**① R40-01（EL8 装 Node）**：用户给的是**结论 + 机制**，直接照做即可，但要先想清楚「为什么是 `--allowerasing`、为什么只在 dnf 下给」。机制是 EL8 的 AppStream **模块流**自带 `nodejs:16`，模块包（`nodejs-full-i18n` / `nodejs-libs` / `nodejs-devel`）把版本钉死在 16，与 NodeSource 的 `nodejs20` **直接互斥** —— dnf 回 `cannot install both nodejs-2:20.… and nodejs-1:16.…`，**事务连第一步都进不去**，于是 node 永远停在 16、部署因版本过低中止。`--allowerasing` 是 dnf 官方给出的解法（允许它**替换掉**冲突的旧包来完成本次事务）。修法落在**唯一实现点** `node_pm_extra_args()`，两处安装点（发行版源 / NodeSource）都改成 `install -y nodejs $(node_pm_extra_args)` —— **刻意不加引号**（空串要展开成「没有参数」，加引号会变成一个空字符串参数）；且**只在 `PM == "dnf"` 时给出**：走到 `yum` 说明本机没有 dnf（EL7 一类的旧 yum 不认这个选项，传进去直接报未知选项），Debian / Alpine / openSUSE 分支一律不受影响。另一处同样重要：**RPM 分支不再显式安装 `npm` 这个独立包名** —— `npm` 由 `nodejs` 包自带，而单独 `install npm` 会把 AppStream 的 `nodejs-npm` 等模块包整串拉回来，正好又撞上同一个互斥（用户原话给的命令里也没有 `npm`）。装不上时的诊断指引同步重排：第 1 条就是 `dnf install -y nodejs --allowerasing`，「先 `module reset`」被移到其后（那动的是**全局**模块状态，副作用大且不对症）。**② 判据必须落在行为层 —— 这个词到处都是。** `--allowerasing` 同时出现在：本轮新加的注释里、`node_manual_hints()` 的用户提示里、`node_conflict_hints()` 的指引里，以及 dnf 报错原文里。任何「源码里有没有这个词」的断言都会**假绿**（本轮真实踩到：`install_node` 的负向断言「不得再写 `install -y nodejs npm`」差点被注释里那句「这条原本是 `install -y nodejs npm`」满足，故断言前先剥掉整行注释）。因此 7 条护栏分三层：**行为层**（`source ./deploy.sh` 后真跑 `node_pm_extra_args`，依次取 `dnf` / `yum` / `apt` / `apk` / `zypper` / `PM` 未设六种结果；另一条真跑 `node_conflict_hints` 并回读 `HINTS`），**结构层**（从 `install_node` 的函数体里数「两处安装点都带 `$(node_pm_extra_args)`」恰为 2，并断言 apt 分支**不得**沾上 RPM 的参数），**负向层**（不出现 `install -y nodejs npm`）。**③ 一条自己的教训，值得记下来。** `--allowerasing` 在 `node_conflict_hints` 的 `dnf` 分支里出现**两次**（第 1 条与第 4 条），所以「只把第 1 条改回 `module reset`」的变异**不会**让护栏变红 —— 输出里仍有这个词，`fail=0`（实测）。正确写法是**整段替换**。这与本仓库反复记录的「护栏看似覆盖了、其实没打在那条路径上」同源：**凡断言某段输出里有没有某个词，就要先数清那段里它出现了几次。** **④ R40-02（不能编辑自己）**：需求只有一句，但实现要挑形态。**刻意「不渲染」而不是 `disabled`** —— 留一个永远点不动的按钮，用户只会以为是坏了（对比：「删除」按钮本来就是「渲染但禁用 + `title="不能删除当前登录账户"`」，因为「删除自己」是个**能理解但被禁止**的动作；「编辑自己」则是**入口就不该存在**的事）。**能力不缺失**：自己的用户名 / 密码 / Windows Hello 仍可在账户菜单的「编辑资料」（`profile.js`）里改，那张卡片管的是「别的账户」。判据是 `isSelf`，与「封禁」同一形态（`banBtn` 也是自己那行不给），「删除」保持原样。护栏放在 `audit35-regressions.test.js` 而不是新建文件：**那张卡片的假 DOM 与用户夹具只在那里**（`bootUserCard()` 把 `globalThis.__me` 设成 `admin`/`me`），另抄一份等于把「同一份实现两处各写一遍」这个老毛病搬进测试里。三条护栏分别钉「卡片里自己那行没有编辑按钮」「『显示全部』对话框里同样没有」「`userTableHtml` 是唯一渲染点且以 `isSelf` 为条件」—— 第三条一开始写成「全文件里 `data-act="edit"` 只能出现一次」，实测**期望 1 / 实际 2**：同一文件里 WebDAV 账户列表另有一处 `data-act="edit"`。改为**先按大括号配对取出 `userTableHtml` 的函数体**再在那个范围内计数，并补一条 `${editBtn}` 插值断言（否则「按钮算出来了但没插进行模板」这类漏改照样全绿）。**⑤ R40-03（日间 / 暗黑）**：一条界面需求，但底下有三个**不可让步**的约束，缺一个就会变成用户能立刻看见的毛病。其一，**主题脚本必须是 `<head>` 里的普通脚本**：它要赶在首屏绘制之前把 `data-theme` 写到 `<html>` 上；写成 `type="module"` 是天然 defer（等 HTML 解析完才执行），暗色用户**每次刷新都会先看到一帧亮色**（「闪白」）；内联也走不通，因为 CSP 的 `script-src` **没有** `'unsafe-inline'`（SEC-06 刻意移除）。于是只剩「`<head>` 里的外部普通脚本」这一条路，代价是它不能用 `import`，故刻意不依赖任何其它模块。其二，**状态只有一个落点** `<html data-theme="dark\|light">`：属性缺失即日间（`:root` 的默认值就是亮色），所以不必额外分支；持久化用 `localStorage`（键 `kepler-theme`），读不到 / 被禁用 / 值非法一律**退回日间** —— 主题读不出来最多是不好看，绝不该把整个应用拦在启动前（隐私模式下**访问 `localStorage` 这个属性本身**就会抛，故连取属性都要包 try）。其三，**「当前是哪个主题」以 DOM 属性为准，不是 storage**：否则存储不可用时每次读到的都是日间，第一次点击之后就再也切不回亮色（单向切换）—— 这一条有专门用例（storage 恒抛时点两下，必须来回）。图标是**声明式**的：太阳与月亮**两颗都写在 HTML 里**，露哪一颗由 CSS 按 `data-theme` 决定，JS 只切属性 + 存值 + 更新 `title` / `aria-pressed`，因此既没有 `innerHTML` 写入，也不会出现「图标已经换了、页面还是旧主题」的中间态；按钮文案说的是**点下去会变成什么**（日间显示月亮 + 「切换到暗黑模式」）。**⑥ 暗色不是「逐条覆写选择器」，而是「字面量 → 语义变量」。** 后者在将来新增组件时会自动继承主题，前者必然漏掉（而漏掉的表现是暗色界面里冒出一块**刺眼的白**，往往是输入框 / 对话框 / 提示块）。故给 `:root` 补了 19 个语义槽位（`--ctrl-bg` / `--surface-2/3` / `--field-bg` / `--row-hover` / `--hover-2/3/4` / `--line-soft` / `--muted` / `--icon` / `--tint-ok/bad/warn/warn-2/info/enc`），把界面里**写死的 100 处颜色字面量**替换成它们（含两处刻意归并：`#333`/`#444`→`--text`，`#888`/`#aaa`/`#6b7280`/`#999`→`--muted`；两处近似色 `#fafbfd`→`--surface-2`、`#f1f2f4`→`--surface-3`），日间模式的取值**一字未改**；再由末尾一块 `[data-theme="dark"]` 统一接管这 31 个颜色槽位，并补一层选择器兜底（近黑按钮字色、中性 hover、进度条 / 开关、代码块、各类状态标签、登录卡片组）。**日间渲染逐像素未变**由无头 Chrome 实拍对照确认（亮 / 暗各一套整页与局部截图）。**⑦ 主题最容易犯的错，各有一条用例。** ① **明暗两套变量必须一一对应**：漏掉一个槽位，那个面在暗色下仍是亮色（护栏直接比对两份变量集，几何量 `--radius` / `--tb-h` / `--sb-h` / `--font` 显式豁免）；② **同值即漏改**：暗色块里与 `:root` 取值完全相同的槽位，几乎一定是复制粘贴没改（单独一条断言）；③ **暗色块必须排在 `:root` 之后**：两者特异度同为 (0,1,0)，靠先后顺序决胜（写反了整块主题静默失效）；④ 必须声明 `color-scheme: dark`，否则原生下拉 / 复选框 / 滚动条 / 日期选择器仍是亮色。**⑧ 测试侧踩到三个「判据被别的东西满足」的坑，都记在前面。** ① **CSP 断言被注释满足**：`server/index.js` 里那句注释「SEC-06：移除 `script-src` 的 `'unsafe-inline'`」**同时含** `script-src` 与 `unsafe-inline`，对全文做正则会假绿 —— 改为「只认同一行里同时出现双引号与 `script-src` 的那一行」（注释行没有双引号），并要求**恰为 1 行**，另加**前置自证**（同一套取法必须能取到确有 `unsafe-inline` 的 `style-src`，否则「没有」二字毫无意义）。② **`innerHTML` 断言被自己的文档注释满足**：`theme.js` 的文件头注释正好解释「为什么**不写** `innerHTML`」，于是断言永远为真 —— 改成先剥掉块注释再断言。③ **`[data-theme="dark"]` 的第一次出现不是暗色块**：`.theme-btn` 那几条规则里也有这个选择器，且位置更靠前；判据必须带上 ` {`（写成 `[data-theme="dark"] {`）才不会切到别处（顺序断言与取值断言两处都因此踩过一次）。**⑨ 沙箱与文档同步。** 新增前端模块与测试文件后，`docs-sync` 的**双向**校验要求「文档目录树里写的必须真实存在」且「实际有的必须列全」，故补 `public/js/theme.js`（并写明「普通脚本、非 ESM」的原因）与 `tests/audit40-regressions.test.js`；同时把「28 个前端模块」改成 29、「共 50 个测试文件」改成 51（`README.md` 同口径）。借这轮顺手修掉两处上一版留下的漂移：文档里「文件名中的轮次编号」那份清单**停在 33**（34~38 早已存在却不在清单里），以及「第 2、4 轮没有各自的独立护栏文件」这句**残缺**（实际还有第 15、18~20、23、24、30、39 轮同样没有独立文件，其结论并入了相邻轮次或既有护栏文件）。**⑩ 一条纪律重申**：14 条反向对照**逐条实跑**（`--only=R40-`），confirmed 红的一律是**用例名**而不是文件级语法错误；运行前后各自确认工作区无 `*.reversebak` 残留（脚本被强杀会留下**正处于变异态**的源文件）。另：所有 anchor 都做了**原始文本上的出现次数**复核（必须恰为 1），其中 `dnf\|yum` 那条最初按 6 空格缩进写、实测未命中（真实缩进是 4 空格），由 `invariants.test.js` 的 anchor 命中自检当场报出。 |
| R41 | 用户报告的两件事（非审计轮）：① 「Google reCAPTCHA 卡在『正在加载人机验证组件…』，不论 reCAPTCHA 选择的是 V2 还是 V3（确认 Google reCAPTCHA 的 API 使用的是 recaptcha.net？）」；② 「Google reCAPTCHA 和 Cloudflare Turnstile 应该是两个独立的配置项：应该让用户可以同时保存两种验证码配置，然后选择使用其中一项」 | 1 个修复（`R41-01` CSP 放行 reCAPTCHA 的**实现脚本**来源）+ 1 项结构变更（`R41-02` 两套凭证各自独立保存）+ `captcha` 配置由扁平改为 `providers[provider]`（含旧配置自动迁移）+ 前端卡片拆成两组输入框 + **14 条行为护栏**（`tests/audit41-regressions.test.js`）+ **3 条前端护栏**并入 `tests/audit31-regressions.test.js` + **15 条反向对照**（`R41-01a`~`b`、`R41-02a`~`m`，台账 400 → **415**）；版本 `1.6.3` → `1.6.4` | **① 症状是「组件一直在加载」，而「加载器」和「实现脚本」是两份不同的东西。** 用户已经自己想到了一个方向（「确认 API 用的是 recaptcha.net？」），而答案是：**它用的就是 `recaptcha.net`，这里没错** —— `https://www.recaptcha.net/recaptcha/api.js` 是本项目有意选定的入口（服务端回源校验也走同一域下的 `…/recaptcha/api/siteverify`，同样刻意绕开 `google.com`）。真正的坑在下一跳：那份 1040 字节的响应只是**引导脚本**，它自己再去注入真正的实现 `recaptcha/releases/<版本>/recaptcha__*.js`；该实现在中国大陆被解析到 **`https://www.gstatic.cn`**（境外 `https://www.gstatic.com`，同一份内容、两边都是 HTTP 200 且同为 858138 字节）。而 CSP 的 `host-source` 是**精确匹配**，本站 `script-src` 里只列了 `www.gstatic.com` ⇒ 实现脚本被浏览器拦下 ⇒ `grecaptcha` 永不 ready ⇒ 加载提示再也不会消失（也因此与 V2 / V3 无关：两者共用同一份实现脚本，挂在同一处）。**② 取证方式本身就是一条教训。** 要观察的是**加载之后**才发生的事件（`securitypolicyviolation` 与 `ready` 回调），而 `chrome --dump-dom` 在 **`load` 事件**就转储 —— 实测永远只看到 `PENDING`（假阴性，第一次探针就是这么被骗过去的）。改用 DevTools 协议（`--remote-debugging-port` + WebSocket + `Runtime.evaluate` 轮询）后，A/B 对照一目了然：**当前 CSP** → `SCRIPT_LOAD` → `VIOLATION script-src-elem :: …www.gstatic.cn…/recaptcha__zh_cn.js` → `RESULT_POLL_EXHAUSTED elapsed=20280ms`（正是用户看到的现场）；**补上 `www.gstatic.cn` 后** → `SCRIPT_LOAD / ONLOAD_CALLBACK / READY after 676ms / RESULT_READY`。另有两个环境坑一并记下：`--proxy-server` 会把 `127.0.0.1` 也代理掉（连不上本地探针服务，去掉该 flag 反而正常）；Bash 工具里用 `cmd &` 起的后台服务**不会存活**，必须用工具的 background 模式。**③ 最小修法经实测确认。** 只需要给 `script-src` 补一个域名 —— `frame-src` / `connect-src` / `img-src` **都不必跟着加**（专门跑了一个「只改 script-src」的变体来验证，同样 676ms 到达 ready）。两个域名**都留**：境内取 `.cn`、境外取 `.com`，只留一个必然有一半地区不可用；刻意**没有**按站点域名去猜该用哪一个（那会让 `SITE_DOMAIN` 反过来决定 CSP，而 `0.0.0.0` 必须继续被接受为合法的 `SITE_DOMAIN`，一猜就出兼容性问题）。**④ 既有护栏为什么没拦住 —— 判据没落在被执行的那一层。** 第十四轮那条「验证码脚本源必须被 CSP 允许」（R14-02）比的是 `public/js/main.js` 里那几个**引导脚本**的来源，而实现脚本的域名由 Google 的加载器在**运行期**决定，源码里搜不到 ⇒ 这条检查在结构上不可能发现本缺陷。本轮新增的判据改成**按 CSP 语义**处理：先把 `script-src` 段（在剥注释后的源码上取出，避免被注释里那句 `script-src` 抢先命中）按空白拆成 **host 集合**，再要求集合里**同时**含 `www.gstatic.com` 与 `www.gstatic.cn`；并配一条**取法自证**（同一套取法必须还能取到 `www.recaptcha.net` 与 `challenges.cloudflare.com`，否则「提取不到」与「合规」在结果上无从区分）与一条**负向对照**（把 `www.gstatic.cn` 删掉后集合里必须不再有它）。`R41-01b` 专门打「少写一个 `www`」这种**看起来已经修好**的错法：`https://gstatic.cn` 不匹配 `https://www.gstatic.cn`，源码里肉眼像加了、浏览器里照样拦。**⑤ R41-02（两套独立配置）不是「多加一个字段」，而是把「唯一一套」这个前提整个换掉。** 旧结构 `{ provider, siteKey, secretKey }` 是**扁平**的：换服务商就等于把上一家的密钥覆盖掉，想切回来得重新申请一遍。新结构 `providers[provider] = { siteKey, secretKey }`，顶层 `provider` 只表示「登录页实际使用哪一套」，于是「两套同时保存、任选其一」在数据模型上就是自然成立的。**⑥ 归一化必须有唯一实现点，且读与写都要走它。** 历史配置（1.6.3 及更早）落盘的是扁平键，故升级后第一次读盘时要把它们搬进 `providers[provider]`（即**它当时选中的那一家**）再把扁平键抹掉。只做读盘这一次是不够的：`configStore.save(partial)` 是**顶层键替换**，一次带扁平 `siteKey` 的部分写入会留下「扁平键 + providers」并存的两个真相，而读取侧只认 `providers` ⇒ **写入静默失效**（接口回 `ok`、界面显示已保存，登录页却拿不到 siteKey）。故把 `normalizeCaptchaInto()` 抽成唯一实现点，`normalize()`（读盘）与 `save()`（部分写入）都调它，并各配一条反向对照。**⑦ 环境变量的解析顺序本身就是一个坑。** `CAPTCHA_PROVIDER` **必须**先决定「用哪一家」，`CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET_KEY` **再**覆盖那一家的值。旧写法是「先 `Object.assign` 出一份合并结果，再取 `siteKey`」—— 环境变量把生效方切到 Turnstile 之后，取到的仍是 reCAPTCHA 那一套的密钥：前端会拿着 reCAPTCHA 的 siteKey 去渲染 Turnstile 组件（渲染失败），服务端也会拿错密钥回源校验。`R41-02c` 就是把这个顺序倒回来的变异。**⑧「留空 = 保持原密钥」是这套配置的地基。** 界面上的密码框**永远不回填明文**（服务端从不下发 `secretKey`，只回 `hasSecret` 布尔），因此每次保存提交的都是空串。若把空串当成「清除」，管理员**只改一下超时时间就会把两套密钥清空**，登录立刻被 `captcha_not_configured` 拦死 —— 这一条在存储层（`R41-02e`）与路由层（`R41-02m`）各有一条反向对照，`null` 才是显式清除。**⑨ 前端那一半同样落在了行为层。** 卡片拆成两组输入框（`#captcha-sitekey-recaptcha` / `-turnstile` 等，元素 id 由同一份 `CAPTCHA_PROVIDERS` 清单拼出，增删服务商只改一处），提交时**两组一起读、一起提交**（只提交选中那一组 = 一换服务商就把另一套清空，正是需求点名的毛病）；回填时两组各回各的框（串台会让管理员在 A 家看到 B 家的密钥）。测试上有一处需要专门说明：`installFakeDom()` 的 `querySelector` 默认恒返回 `null`，于是 `chipValue()` 恒为空、`provider` 永远回落 reCAPTCHA —— **那样「切到另一家」这类行为根本测不到**（测试以为在测 Turnstile，实际测的还是 reCAPTCHA）。故新增一个按 id 分派的 `setChips()`，只对显式声明的 chip 返回激活值。另有一处**桩的错**值得记下：`saveCaptchaConfig` 桩最初按 `!!cfg.secretKey` 现算 `hasSecret`，第二次保存（密码框本来就留空）就得到 `false`，界面随即把「（已设置）」误显示成「（未设置）」—— 那是桩没模拟服务端那条「空串 = 保持」的契约，会让护栏指向错误的方向；改成带闭包状态的桩后消失。**⑩ 备份与「已配置」判据同步覆盖两套。** 导出/导入以 `providers` 整批进行（`captchaProviders()` 是导出与导入共用的唯一归一入口，绝不各写一份合并规则）；`isEmptyData()` 也必须认两套 —— 只配了 Turnstile 同样算「已配置」，否则导入会被误判成「全新实例」而静默覆盖掉它（旧载荷的扁平键同样算数，故两条都保留）。**⑪ 收尾。** 15 条反向对照**逐条实跑**（`--only=R41-`，另补跑 `--only=R41-01` / `R41-02a`~`d` 复核前几条），红的一律是**用例名**而不是文件级语法错误；运行前后确认工作区无 `*.reversebak` 残留。所有 anchor 都用 Node 在**原始源码**上数过出现次数（必须恰为 1），并按护栏口径（`stripComments()` 之后）复核过。这一步是必需的：`backup.js` 的导出与导入两处**逐字相同**地写着 `providers: captchaProviders(cap),` 与同一条 `timeoutMs:` 行，若直接拿它们当 anchor，`String.replace` 只替首处、变异会打到无关的那一处（`fail=0` 假绿），故改锚在**只在目标函数里出现**的代码片段上（本轮为此专门锚了 `captchaProviders()` 的函数体）。版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md`），测试文件数 51 → 52、`README` 计数同步 52。 |
| R42 | 用户报告的两件事（非审计轮）：① 「华为云、七牛云、又拍云、Backblaze 不可用：即使是正确的 key 也无法正常绑定密钥」；② 「AWS S3、Microsoft Azure、Google Cloud 和 MinIO 未经测试」 | 2 个修复（`R42-01` `/config/verify` 的回退改为**只在同一厂商内**发生；`R42-02` 华为云 OBS 改发 `UNSIGNED-PAYLOAD`）+ 厂商注册表新增 `unsignedPayload` 标志位（含唯一判据 `providers.unsignedPayload()`）+ 客户端执行层新分支 + **9 条行为护栏**（`tests/audit42-regressions.test.js`）+ **8 条反向对照**（`R42-01a`~`d`、`R42-02a`~`d`，台账 415 → **423**）；版本 `1.6.4` → `1.6.5` | **① 症状是「密钥正确却绑不上」，而缺陷既不在签名也不在厂商地址，在「验证接口的参数回退」。** 用户报的四家（华为云 / 七牛云 / 又拍云 / Backblaze）都走 S3 兼容协议、共用 `s3-client.js`，所以「四家一起坏」本身就排除了「某家的签名写错了」——**同一份代码在同一处坏掉**。真正的分叉点是：`POST /api/config/verify` 在入参缺省时会用 `configStore.get()`（= **当前生效配置**的扁平形态，走 `effective()`）去补 `region` / `bucket` / `endpoint`，而这三个值属于**当前激活的那个桶**（及其密钥）；可「访问密钥」表单里**根本没有地域栏**（地域记在**桶**上），于是前端（`credmgr.js` 的「测试连接」）只提交 `provider / secretId / secretKey` —— 回退必然发生，且**必然把别家厂商的地域塞进本次验证**。用户可见症状「**谁先配好谁正常**」正是这条机制的直接指纹：先配的那家不会撞上「自己以外的 region」。**② 一条回退污染三条通道，且三条的症状完全不同 —— 所以它看起来像三个 bug。** 其一，**地域 → 端点推导**：地域会被厂商的端点模板拼进主机名，用华为云密钥却建出 `https://obs.ap-guangzhou.myhuaweicloud.com/`（华为云**没有** `ap-guangzhou` 这个地域）⇒ DNS 解析失败 ⇒ 界面只说「网络连接异常」，与密钥毫无关系（这是最容易被误判成「网络问题」的一条）；其二，**签名地域**：又拍云最隐蔽 —— 它的端点是**固定**的 `s3.api.upyun.com`（从 URL 上看全对），错的是参与签名的地域（应为 `us-east-1`，被写成了别家的 `ap-guangzhou`）⇒ 云端回 `403 SignatureDoesNotMatch` ⇒ 界面归因「请检查 AccessKey / SecretKey」，把运维引向轮换一把**完全有效**的密钥；其三，**桶名与端点**：激活桶的名字会被当成本次「顺带要探测的桶」去 `headBucket`（别家的桶名在本厂商必然不存在），而阿里云等「有固定端点」的厂商 `effective().endpoint` **恒非空** ⇒ 请求被直接发到它的域名上。**③ 定位方式是「先证伪自己的第一直觉」。** 最初怀疑「我们的 SigV4 对四家都算错了」，但独立探针（直接构造客户端打官方端点）显示 **10 家 S3 兼容厂商全部签名正确、主机名正确**，Azure 那几行「❌」是探针自己的正则只认 V4 而不认 `SharedKey` —— 第一直觉被证据推翻后，才把注意力从「签名实现」移到「验证接口的取参路径」，并用一个独立探针把污染复现出来（打印出 `region = "ap-guangzhou" ← 来自腾讯云的激活桶` 与「→ 建出的客户端 endpoint」）。**④ 修法的形状是「加一道判定」而不是「补一个字段」。** 把回退改成 `sameProvider = !请求厂商 || 请求厂商 === 激活配置的厂商`，跨厂商时 `inherit()` 一律返回空串，交由厂商元数据推导出**该厂商自己**的默认地域与端点。两条边界必须同时成立：请求**未带**厂商时（历史调用方只传 `secretId` / `secretKey`）行为与历史**逐字一致**（那时 `provider` 也取自激活配置，本来就是同一家）——这条有专门的反向对照 `R42-01b` 的**正向用例**守着，防止有人把修复做成「一律不继承」的过度矫正；请求**带了**厂商且与激活桶相同的时候，继承必须照旧（同厂商换桶是正常操作）。四条反向对照按「整个判据」(a)、「只放开 region」(b)、「只放开 bucket」(c)、「只放开 endpoint」(d) 逐通道单点拆开，保证**任一通道单独退化都能被抓住**（实测 a 红 4 条、b/c/d 各红 3 条）。**⑤ 第二处缺陷是「密钥没错、签名串也没算错，但载荷哈希这一项本身不被接受」。** 华为云 OBS 的 V4 签名**只接受 `UNSIGNED-PAYLOAD`**（与流式分块的 `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`），发真实载荷的 SHA-256 会被拒（官方 FAQ《如何使用 V4 签名访问 OBS》「约束与限制」明确列出）。而本项目为遵守 AWS SigV4 规范，对带体请求一律发送真实载荷哈希 ⇒ 华为云必得 `403 SignatureDoesNotMatch`，**且响应体不带任何线索**，界面只能显示「请检查 AccessKey / SecretKey 是否正确」——这正是「同一把 key 在 `aws-cli` / `boto3` 下正常、在本项目里失败」的原因：boto3 / aws-cli 走 HTTPS 时**默认**就用 `UNSIGNED-PAYLOAD`。修法是在**厂商注册表**声明 `unsignedPayload: true`，由 `s3-client` 在载荷哈希判定链的**最前面**统一处理，且对该厂商的**所有**请求生效（**含空体 GET / HEAD** —— 约束是对该厂商全部请求生效，不是只对带体的）。**⑥ 这个开关必须只给一家开，并用用例把「只给一家开」钉住。** 直觉上「多开几家更保险」是错的：七牛云 Kodo 的 S3 文档**明确要求**每个请求带 payload 的 `sha256`，顺手给别家开成 `UNSIGNED-PAYLOAD` 会把七牛打挂。故除了 `R42-02a`（华为云开、别家不开，两个方向都断言）之外，另加 `R42-02b` 断言「注册表里声明该标志的厂商**恰为 1 家**」，并配一条**变异**：拿七牛条目的唯一特征串作锚点、把标志追加到七牛上（`R42-02d`）—— 这条变异不红就说明「只给一家」这句话没有被任何东西守着。**⑦ 「注册表改对了、执行层没执行」是本项目反复踩过的形态，单独一条反向对照。** `R42-02c` 专门作用于 `s3-client.js` 的那一行判定（`if (false && this.unsignedPayload)`），它让注册表保持完全正确、只让执行层失效 —— 若把两者合并成一条对照，就分不清「标志没下发」与「下发了但没用」。`R42-03a` 另外要求 8 家厂商逐一的 host / 桶寻址 / 签名地域与 scope，并**用一份独立于 `s3-client` 重算的校验器**复核签名（不复用被测代码，避开「自己验自己」——R30 的 AZ-01 就是这么被漏掉的：假服务照抄了客户端的错误规范串，两侧共享同一假设时验签只能证明**自洽**）；`R42-03b` 单列 Azure：走 `SharedKey` + `x-ms-*` 头，**绝不出现 SigV4 字样**。**⑧ 覆盖缺口本身就是用户第二句话的答案。** 统计 `tests/` 里各厂商的出现次数：`tencent` 79 次、`huawei` **0 次**、`upyun` **0 次**、`qiniu` 2 次 —— 与用户报告的「那四家不可用」完全对应。第二十六轮只覆盖了「新增的四家」（GCP / R2 / MinIO / B2）的**建桶与端点组装**，从未有一个用例真的**带着别家激活桶**去跑 `/config/verify`；「未经测试」不是一句客套话，它是可以被计数验证的事实。**⑨ 收尾。** 8 条反向对照逐条实跑（`--only=R42-`，另补跑 `--only=R42-01` 复核被 `tail` 截掉的前三条），红的一律是**用例名**而不是文件级语法错误；运行前后各自确认工作区无 `*.reversebak` 残留。所有 anchor 都用 Node 在**原始源码**上数过出现次数（必须恰为 1），并按护栏口径（`stripComments()` 之后）复核 —— 这一步在本轮同样必要：`server/providers.js` 里 `unsignedPayload: true,` 这种单行 anchor 极容易在追加别家条目时变成两处（`String.replace` 只替首处 → 变异打到别家 → `fail=0` 假绿），故 `R42-02d` 刻意锚在**七牛条目独有的** `credentialLabel` 行上而不是标志行本身。版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md` 新增 `[1.6.5]` 节），测试文件数 52 → 53、`README` 计数同步 53。 |
| R43 | 用户报告的三件事（非审计轮）：① 「华为云可以正常绑定 API Key，可以从云端获取存储桶列表，但无法添加存储桶，提示『无法访问该存储桶：Error: 资源不存在：对象或存储桶不存在』」；② 「又拍云不能使用操作员和密码绑定 API Key，因为又拍云使用 S3 兼容协议，也同样需要 AccessKey、SecretAccessKey」；③ 「『备份设置』中，编辑框默认会完全显示备份码，应改为部分掩码，仅复制和导出才能得到完整备份码」 | 2 个修复（`R43-01` 桶地域被客户端 region 冒充；`R43-02` 又拍云字段名）+ 1 处前端收敛（`R43-03` 实时码掩码）+ 厂商注册表新增 `queryBucketLocation` 标志位（含唯一判据 `providers.queryBucketLocation()`）+ 客户端新增 `_bucketLocation()`（`GetBucketLocation` 唯一实现点）+ **8 条行为护栏**（`tests/audit43-regressions.test.js`，含前端沙箱的调用点层断言）+ **9 条反向对照**（`R43-01a`~`f`、`R43-02a`~`c`，台账 423 → **432**）；版本 `1.6.5` → `1.6.6` | **① 「列得出桶、却加不了桶」是一个必然的分裂，不是偶发。** 用户已经自己把范围缩到很小（密钥能绑、桶列得出、只是**添加**失败），这恰好排除了「密钥/权限」与「网络」两类常见解释：一个能 `ListBuckets` 的凭据，没有任何理由加不了自己的桶。真正的线索在那句**文案**上 —— 「资源不存在：对象或存储桶不存在」是 404 的翻译，说明服务端确实回答了「这个桶不存在」，而不是拒绝或超时。**② 根因：华为云 OBS 的 `ListBuckets` 默认不回桶的地域，而客户端拿自己的 region 冒充它。** 官方 SDK 的 `listBuckets(queryLocation)` 写得明确：「`queryLocation` 默认 false；设为 true 后才在列举桶时查询桶的区域位置」（Java / PHP / Python 三份文档口径一致），而公有云 REST 版 ListBuckets 的 URI 参数表是**空**的。于是服务端只回 `<Name>` / `<CreationDate>`，而 `getService` 里那句 `normalizeBucketRegion(raw) || this.region` 就把**客户端自己的地域**当成桶的地域返回了 —— 界面据此回填「添加存储桶」表单，添加时去访问 `<bucket>.obs.<那个假地域>.myhuaweicloud.com`。**③ 为什么症状是 404 而不是「重定向」或「地域不对」。** 华为云官方《Accessing OBS》给了决定性的一句：「If the endpoint in the request is not consistent with the endpoint of the requested region, an error message is returned indicating that the bucket does not exist」—— 地域不一致直接报**桶不存在**（并且举了 `mybucket.obs.cn-south-1.…` 访问 `eu-west-101` 的桶得到 HTTP 404 NoSuchBucket 的例子）。用户看到的正是这条。**④ 而「列举桶能成功」也是官方设计的一部分。** 同一份文档点名 `ListBuckets` 与 `GetBucketLocation` 是仅有的两个「不受 endpoint 地域限制」的接口（「these two APIs search for buckets from all regions」）—— 这既解释了分裂表现，也给出了**修法**：不必事先知道地域，直接问就能问出真实地域。**⑤ 修法：让「不知道」这件事显式化，并把补查交给出数据的那个函数。** 注册表给华为云声明 `queryBucketLocation: true`，`getService` 在某个桶没有地域信息时**逐个补查** `GET /<bucket>?location`（`_bucketLocation()` 是唯一实现点，返回值仍走与列表同一条 `normalizeBucketRegion` 归一），取不到才退回 `this.region`。三条边界各自有用例钉住：已有地域时**不得**多打一轮（`R43-01b`：否则账号桶一多即成倍放大请求）、未声明该能力的厂商行为与历史**逐字一致**（`R43-01c`）、注册表里**恰有一家**声明它（`R43-01d`，配 `R43-01c` 的变异——「一律 true 更保险」的直觉错法会把 AWS / MinIO 也拖下水）。反向对照按「整条撤掉」(a)、「注册表撤声明」(b)、「判据一律 true」(c)、「工厂不下发」(d)、「发了但解析不出」(e)、「缺前置条件」(f) 六个独立落点拆开 —— 其中 (d) 与 (e) 是「配置层对了、执行层没执行」的两个变体，本项目反复踩过，必须各有一条。**⑥ 又拍云的字段名不是文案问题，是「拿哪把钥匙」的问题。** 用户报的是「操作员和密码绑不上」。又拍云的 **S3 兼容接口**用的是 `AccessKey / SecretAccessKey`（控制台另有一处生成），与组织账号的操作员密码是两套凭据；而字段名是「该填什么」的**唯一提示**，写着「操作员 / 操作员密码」等于让用户拿一把根本不对的凭据去试，失败后再被告知「签名错误」。前后端各有一份厂商元数据（`server/providers.js` 的 `credentialLabel` 与 `public/js/provider-logos.js` 的 `idLabel` / `keyLabel`），两处一并改并用用例比对同值。**⑦ 实时码是「明文里包着密钥」，可它偏偏最常在投屏时被打开。** 用户报的第③条正是这个：编辑框默认整串显示。修法是 `maskCode()` —— 抬头与第一个 `.` 原样（它是肉眼分辨「实时码 vs 加密导出码」的唯一凭据），载荷保留首 6 / 末 6，中间定宽掩码；载荷过短时整体掩掉（避免「可见部分比掩码还长」的自相矛盾）。**判据刻意落在调用点层**：`R43-03b` 在前端沙箱里跑 `refresh()`，断言 DOM 里的串既不是完整码、也不含完整码的明文段，同时内存里仍保留完整码 —— 因为 `R21-14` / `R40-03` 的教训正是「助手函数写对了、真接线处没用它」，只测 `maskCode()` 会让「调用点写回明文」这种变异照样全绿（`R43-02c` 就是那条变异）。顺带把卡片上那两句说明改准确：原来写「代码立刻跟着变」，而掩码后**可见部分基本不变**，所以改成以「指纹 / 长度 / 各项计数」那一行是否变化为准。**⑧ 收尾。** 9 条反向对照逐条实跑确认变红（`--only=R43-`），红的一律是**用例名**而不是文件级语法错误；运行前后各自确认工作区无 `*.reversebak` 残留。全部 anchor 都用 Node 在**原始源码**上数过出现次数（9/9 恰为 1）；其中 `R43-01a` 与 `R43-01f` 刻意锚在同一行的不同片段上（前者整行、后者只到 `if (!region && this.queryBucketLocation)`），两者各自唯一且意义不同（一个是「整条撤掉」、一个是「去掉前置条件」）。版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md` 新增 `[1.6.6]` 节），测试文件数 53 → 54、`README` 计数同步 54。 |
| R44 | 用户提出的两项（非审计轮）：① 「移除『文件夹导航』，因为这个功能与顶部的地址栏重复」；② 「将『文件夹导航』替换为『文件类型』功能：可筛选当前存储桶中的文件，分为全部、图片、视频、音频、文档、压缩包、可执行文件。后缀名处理规则和 SVG 图标文件为 `ico.txt`，直接替换文件夹的 icon，处理各个后缀名的图标：① 各个类型的文件都有给出规定的背景色，按要求绘制背景色；② 在背景色上绘制给出的 SVG 图标；③ SVG 图标要缩放到合适大小，使其视觉一致」；澄清后确定：筛选作用于**当前目录列表**（即时、不发请求），选中具体类型时**文件夹不显示** | 1 处功能移除（「文件夹导航」树，`public/js/tree.js` **删除**，含 `ops.js` 的 4 处 `refreshTree()` 冗余调用与 `explorer.js` 的 `renderTreeActive()`）+ 1 个新前端模块（`public/js/filetype.js`）+ 12 枚雪碧符号（`index.html` 的 `#icon-sprite`：文件夹 + 6 个类型 + 4 套系统可执行文件图标 + 中性「其他」+ 「全部」四宫格）+ 服务端分类表新增 `exec` 一类（`apk` 从 `archive` **搬家**）+ **14 条行为护栏**（`tests/audit44-regressions.test.js`）+ **15 条反向对照**（`R44-01a`~`R44-14a`，台账 432 → **447**）；版本 `1.6.6` → `1.6.7` | **① 「重复」是用户给出的判据，而它是对的 —— 两套导航在争同一个位置。** 侧栏的文件夹树与顶部前缀地址栏做的是同一件事：在目录之间跳转。重复的入口不只是浪费侧栏宽度，它还会**分裂状态**：树上的高亮、面包屑上的 `current`、以及实际 `prefix` 是三处需要同步的东西（原实现里 `navigate()` 每次都要额外调一次 `renderTreeActive(prefix)` 才不至于显示错）。把这个位置让给「按类型筛掉不相关文件」——那是地址栏给不了的能力——是一次纯增益的替换。**② 分类表只能有一份，且必须留在服务端。** 服务端 `server/routes/_shared.js` 的 `TYPE_EXT` 早已在给每个列表项打 `type`（搜索接口的 `type` 条件也用它），前端若再存一份后缀表，两边必然漂移成「侧栏数得到 3 个图片、搜索却说 0 个」。故本轮**只往服务端加与搬**：新增 `exec: ['exe','msi','com','apk','ipa','hpkg']`，并把 `apk` 从 `archive` **移走**——`typeOf()` 是按 `Object.entries` **键序**返回第一个命中的类，两处都列会让 apk 永远判成压缩包、侧栏「可执行文件」永远少数几个，而界面完全看不出问题（`R44-01a`）。另有一条容易犯的错：把 `svg` 从 `image` 里「顺手清理」掉会让它掉进 `other`，**丢掉缩略图与图片预览**，故分类表只允许新增与搬家、不允许删减（`R44-01b`）。**③ 过滤只有一份实现，且判据必须包含「不是文件夹」。** 状态落在 `App.state.typeFilter`（空串 = 全部），侧栏只负责把点击翻译成这个值（`filetype.js` 里连一次 `filter(` 都不写），真正的过滤只有 `explorer.visibleItems()`：`if (!t) return state.items; return state.items.filter((i) => !i.isFolder && i.type === t);`。前一半（`!i.isFolder`）看着多余——文件夹的 `type` 就是 `'folder'`，光看后半句也不会混进来——但它是**口径的显式落点**：文件夹不属于任何文件类型，本轮澄清的就是这一条。渲染、shift 连选、拖拽落点、**全选**全部只看 `state.visible`：否则「算出来了、列表没跟着变」（`R44-03a`）、「全选把看不见的文件夹也选上，随后的删除作用到隐藏对象上」（`R44-04a`）、「切筛选后旧选中残留」（`R44-05a`）三种形态会各自独立地出现。**④ 底色烘进雪碧符号里，而不是写成 CSS。** 需求要的是「底色 + 图形」两层，若底色写成 `.fic-image { background: … }`、图形写在 `<symbol>` 里，那这两层就有了两个落点，改一处忘一处。故每个 `<symbol>` 自带一枚 1024 圆角底色 `<rect>`，图形 `<g>` 叠在其上——`iconHtml()` 吐出的永远是同一串 `<svg class="fic"><use href="#fic-x"/></svg>`，尺寸由 CSS 的 `.f-ic .fic` / `.thumb .fic` / `.view-* .thumb .fic` 决定。顺带删掉了旧的按后缀文字角标（`extShort` / `EXT_COLOR` / 六条 `.badge.t-*` 配色规则）——新旧两套图标同时存在会比没有图标更混乱。**⑤ 「视觉一致」不是调出来的，是按视觉包围盒算出来的。** `ico.txt` 给的 10 个图形各自画布不同（1024 与 512 混用），直接塞进同一个 `viewBox` 会明显大小不一；更麻烦的是**几何包围盒 ≠ 视觉包围盒**（`hpkg` 的圆形镜头、图标的圆角与描边留白都会让外接矩形虚大）。做法是离线用一套完整的 SVG 路径解析器（含 `M/L/H/V/C/S/Q/T/A/Z` 与隐式重复、相对坐标，椭圆弧转中心参数化后按 720 样本追点）算出每个图形的真实视觉外接框，再解出 `translate(tx ty) scale(s)` 把它居中铺进 1024 画布中央的 720×720 方框（`s = 720 / max(w,h)`）；文件夹的 `translate(33.231 33.231) scale(0.935)` 就是这么来的。结果用无头 Chrome 在 88 / 44 / 20 px、亮暗两套主题下实拍确认。`fic-all` 是本轮自绘的中性四宫格（`ico.txt` 里没有「全部」这个类型），它的四个方块刻意收在同一个 `[152, 872]` 视框内，与其它类型同框——这条也有断言。**⑥ 这一轮最隐蔽的风险是「引用了不存在的图标」。** 浏览器对 `<use href="#不存在">` **既不报错也不警告**，只是画一片空白，控制台干干净净。故护栏做**双向覆盖**：JS 里出现的每个 `fic-*` 必须在 `<symbol id="…">` 里存在，每个 `<symbol>` 也必须真的被引用（防拼错，也防死图标）。写这条断言的过程本身就抓到一个真问题：我先生成 mock 页面时手写了 `#fic-exec`，而真实代码用的是 `fic-exe`——mock 里那一行就是这么空掉的。**⑦ 行为护栏当场抓出本轮唯一一个真 bug。** `setTypeFilter()` 里写成了裸 `render()`。`render` 是 `explorer` 对象的方法，模块作用域里**没有**这个自由标识符（ESM 不会像非模块脚本那样把 HTML 元素的 `id` 挂成全局），于是每次点击类型都抛 `ReferenceError`——用户侧只看到「点了完全没反应」，静态看代码毫无异常。这与 R27-01 的裸 `currentItems()` / 裸 `explorer` 完全同类，故除修复外另加一条**按调用点形态**的断言（不得出现 `render();`，必须是 `explorer.render();`）。沙箱拷入的是**真实** `explorer.js` + 真实 `util.js`（只桩化 api/main/upload/ops/enc 与 DOM），所以这条不是「测试自己写了一份副本」的自我印证——这也是本轮把过滤行为做成真跑沙箱、而不是只做源码字符串断言的原因。**⑧ 移除侧栏树时要分清「同名的两套东西」。** `tree.js` 删掉后，`ops.js` 里「移动到…」的文件夹选择器**仍在**用 `.tree-row` / `.tree-kids` 类名（它渲染的是自己拼的 HTML，与 `tree.js` 无关），故 CSS 里 `tree.js` 对应的 `.tree-node` / `.tree-row` / `.tree-kids` 规则**必须保留**，只把 `.tree` 容器规则换成 `.filetype` / `.ft-row` 那一组。护栏里专门有一条「`.tree-row` / `.tree-kids` 不得被顺手删掉」。同理 `ops.js` 里那 4 处 `refreshTree()` 调用是多余的（其后紧跟 `explorerRefresh()`），随 `tree.js` 一起删除，但不影响选择器。**⑨ 一处「空结果」的文案必须分岔。** 目录里**有**东西、只是被类型筛空时，提示语若是原来的「此文件夹为空」，用户会以为文件丢了（他只选了一个类型，文件夹被有意隐藏了）。故新增一条分支：「当前目录下没有『音频』类型的文件」+ 一个「显示全部文件」按钮（点了直接把筛选清空），与原「该存储桶是空的 / 此文件夹为空」严格分开，两条各有一份断言。**⑩ 收尾。** 15 条反向对照逐条实跑（`--only=R44-`，另补跑 `--only=R44-01` / `R44-02` 复核被 `tail` 截掉的前三条），红的一律是**用例名**而不是文件级语法错误；运行前后各自确认工作区无 `*.reversebak` 残留。全部 anchor 都用 Node 在**原始源码**上数过出现次数（15/15 恰为 1），并按护栏口径（`stripComments()` 之后）复核过——这一轮特别需要：`explorer.js` 里 `state.visible.map(` 出现 4 次、`state.visible[` 也出现 4 次，若把「计数」当成唯一判据就会把 `const rows = ` 这种更长、只在 `renderList` 里出现的片段当作锚点（实际也正是这么选的）。版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md` 新增 `[1.6.7]` 节），前端模块数保持 **29**（删 `tree.js`、加 `filetype.js`），测试文件数 54 → 55、`README` 计数同步 55。 |
| R45 | 用户提出的三项（非审计轮）：① 「使用 S3 兼容协议支持 UCloud，注意 UCloud 可能存在『超过 1GB 必须分块上传』的限制」；② 「在厂商选择器中，UCloud 需要在七牛云和又拍云之间」；③ 「以下是 UCloud 的 SVG 图标代码，将其做和其他厂商一样的处理」 | 1 家新厂商（`server/providers.js` 注册 `ucloud`）+ 3 个厂商侧容量字段与 4 个唯一判据（`putObjectMaxBytes` / `fixedPartBytes` / `multipartMaxBytes` / `copyNeedsSlice`）+ 1 处上传分片改造（`routes/fs.js` 的直传分界、分片钉死、magic 上限、超天花板拒绝）+ 3 处复制路径收口（`routes/fs.js` 的 `copyOne`、`fs-gateway.js` 的 `copyObject` 与目录 MOVE）+ 1 个前端图形与元数据（`public/js/provider-logos.js`）+ **12 条行为护栏**（`tests/audit45-regressions.test.js`）+ **13 条反向对照**（`R45-01a`~`R45-04d`，台账 447 → **460**）；版本 `1.6.7` → `1.6.8` | **① 用户点名的是一条限制，官方并列的其实是三条 —— 而另外两条比它更危险。** 逐字抓取 UCloud《AWS S3 协议支持说明》的「Please note」，得到三条：`PutObject` 仅 **1GB**（用户说的那条）、`CopyObject` 仅 **100MB**、`UploadPart` 必须 **8MB 定长**（末片可小于 8MB，「dynamic part」需联系技术支持开通）；同页另写明 **`UploadPartCopy` 处于内测阶段**、**只支持 Signature V4**。按「在**本项目里**各自的真实后果」重新排过之后，结论与直觉相反：**1GB 那条反而是已经被满足的**（项目直传阈值 8MB、WebDAV PUT 又整段缓冲在 128MB 内，结构上够不着 1GB），真正会炸的是另外两条。**② 8MB 定长分片：「小文件正常、大文件必失败」的形态。** 项目的分片算式是 `min(48MB, max(8MB, ceil(size/10000/MB) MB))` —— 1GB 的文件**恰好**算出 8MB（撞对），30GB 却算出 9MB、480GB 算出 48MB，一律被 US3 以 400 拒绝。这种「量小的能传、量大的不能」几乎必然被误判成网络问题，故分片**钉死**为厂商值（不再是「下限」）。连带两处必须一起想：其一，magic 模式的分片上限原先是裸的 `MAGIC_CHUNK_MAX`（5MB，既是性能上限也是 AWS 的协议下限），对 US3 而言 5MB 是**非法值** ⇒ 新增唯一实现点 `magicChunkCap(provider) = max(5MB, 厂商定长)`，四处调用点（会话创建 / 续传拒绝判据 / 拒绝文案 / chunk 路由兜底）同源，否则会出现「开了 magic 之后 US3 的大文件传不动、关掉就正常」；其二，S3 的 **10000 片上限**乘上 8MB 定长 ⇒ **单文件上限 ≈ 78GB**，超过即无法通过 S3 协议上传（UCloud 官方 FAQ 对同一现象给了同号说明并建议改用 us3cli），故在 `upload/init` **当场拒绝**并说明原因 —— 否则用户要把 78GB 传完才在第 10001 片收到 400。**③ `CopyObject` 的 100MB 才是原先代码真正在违反的那条。** 原实现是「超过 5GB 且是 COS 才分块，否则一律 `putObjectCopy`」，依据是「S3 兼容厂商的服务端复制不受单请求大小限制」—— 该假设对 US3 不成立。于是「重命名 / 移动一个 100MB~5GB 的对象」在别家正常、在 US3 必失败，而失败的是**看起来与大小无关**的操作、错误又来自上游，用户很难联想到 100MB。修法是把「要不要分块」收口成唯一判据 `providers.copyNeedsSlice()`，三条复制路径（管理端 `copyOne`、WebDAV `copyObject`、目录 MOVE）共用，并**刻意保留**「未声明上限的厂商超过 5GB 仍交给 `putObjectCopy`」这一历史行为：改掉它会同时改写 7 家厂商的复制路径，而 `S3Client.sliceCopyFile` 此前从未被任何路径实际走到（S3 侧的分块复制只在 `isCos` 为真时才被调用）—— 贸然切过去等于把「装不上 UCloud」的修复扩大成一次无人验证的复制重写。这条保留有专门的反向对照 `R45-02d` 守着。**④ 为什么必须强制路径风格 —— 一个会静默连不上的坑。** UCloud 同时支持 Path Style 与 Virtual Host Style，但同页明确：「Currently North China 1, Hong Kong, …, and Washington regions already support https protocol, other regions can support **path style https**, and **virtual host style https will be supported in the future**」。本项目一律走 `https://`，而大多数用户会在**未列出的地域**（上海 / 广州 / 乌兰察布等）建桶 ⇒ 虚拟主机风格会给出「配置全对、每个请求都失败」，与 R26-05 的 MinIO 完全同型。故 `forcePathStyle: true`，并由 `R45-01c` 钉住。**⑤ 定长分片这条差异不能「顺手给别家也开」。** 它意味着分片尺寸被固定在 8MB、请求数随体积线性放大（10000 片封顶 78GB），而 AWS 等厂商的分片本就该随体积增长（10000 片足够覆盖 5TB）。故除 `R45-02b` 断言「全表恰有一家声明」外，还有反向对照 —— 「一律 true 更保险」的直觉错法会把别家的大文件分片一起压小。同理 UCloud **不得**继承华为云的 `unsignedPayload` 与 `queryBucketLocation`：前者的开关是「该家 V4 只收 UNSIGNED-PAYLOAD」的厂商差异（七牛明确要求真实载荷哈希），后者意味着每个缺地域的桶多一次请求，都不是「开着更保险」的东西。**⑥ 图标的处理与其余厂商逐字同款。** 剥掉 `p-id` / `class` / `t` / `width` / `height` 等图标站的生成期噪声与冗余命名空间，只保留 `viewBox` + 单条 `<path d fill="#385FF5">`，容器仍是 `preserveAspectRatio="xMidYMid meet"`（等比缩放居中），显示顺序 `ORDER` 与服务端注册表**逐字一致**（这条跨端一致性由 audit26 的既有护栏与本轮 `R45-05a` 双重把守）。另有一条容易漏的检查：**每个登记厂商都必须有图形** —— 缺图在选择器里留一块空白，同样不报错。**⑦ 三条最重要的护栏都是「真跑一次」而不是「断言字段存在」。** 其一，`s3.js` 漏传 `fixedPartBytes` 与 `s3-client` 取值顺序写反（先默认值、后厂商值）都会让分块复制发 64MB 分片，而**只看字段是否存在是抓不到的** ⇒ 用一个拦截出站请求的假 fetch 真跑 `sliceCopyFile`，断言 US3 发出的 `x-amz-copy-source-range` 恰为 `bytes=0-8388607 / 8388608-16777215 / 16777216-20971519`（20MB → 8+8+4），并配一条**反向对照**：同一份代码、同一个尺寸在 AWS 上仍是单片 64MB（`bytes=0-20971519`），证明下发值真的在起作用而不是「一律 8MB」。其二，`upload/init` 的三处改造（分界取小 / 分片钉死 / 天花板拒绝）落在同一段无独立入口的 handler 里，故按项目既有惯例用**源码级不变量**钉住，且断言用**带上下文的整串**而非裸标识符 —— `magicChunkCap(sess.provider)` 在同一文件里出现 4 次，其中一次是解释本条的注释本身，裸串断言既会数进注释、也无法区分「哪一处被摘掉」。其三，两条既有常量的移除也要钉：`COPY_SIMPLE_LIMIT` 原先在 `routes/fs.js` 与 `fs-gateway.js` 各持一份（「同一类常量多份实现」的典型），本轮断言这两处**引用数归 0**、而 `providers.js` 里恰为 2 处（一处说明 + 一处判据）—— 只要有一处旧写法被复活一半，那一半就会静默漏掉 UCloud。**⑧ 既有用例的同步扩展。** `audit42` 的 S3 兼容一致性矩阵由「八家」扩为「九家」（UCloud 走路径风格，故矩阵新增 `pathStyle` 标记，把「桶名落在路径还是主机名」表述成数据而不是 `c.id === 'minio'` 的硬编码特例）；`audit26` 的「前端 ORDER == 服务端注册表顺序」随之自动覆盖新厂商。**⑨ 一处自证真 bug 的即时修复。** `providers.js` 首次 import `limits.js` 时写成了 `const LIMITS = require('./limits')`（拿到模块对象而非解构出的 `LIMITS`），于是 `LIMITS.COPY_SIMPLE_LIMIT` 实为 `undefined`、`n > undefined` 恒 false ⇒ COS 超过 5GB 也不分块了。冒烟探针当场把它打出来（`copyNeedsSlice('tencent', 6GB) === false`），改为 `const { LIMITS } = require('./limits')` 后正常 —— 这类「判据静默失效」正是每轮都要先跑一遍探针的原因。**⑩ 收尾。** 13 条反向对照逐条实跑（`--only=R45-`，另补跑 `--only=R45-01` 复核被 `tail` 截掉的前三条），红的一律是**用例名**而不是文件级语法错误（`R45-01b` 让厂商 id 拼错，连带 9 条一起红，属预期：厂商整个消失）；运行前后各自确认工作区无 `*.reversebak` 残留。全部 anchor 都用 Node 在**原始源码**上数过出现次数（13/13 恰为 1）。版本落点全量同步（`package.json` / `package-lock.json` 两处 / `public/index.html` 页脚 / 本文件适用版本 / `CHANGELOG.md` 新增 `[1.6.8]` 节），测试文件数 55 → 56、`README` 计数同步 56，前端模块数保持 **29**（未新增前端模块）；`README.md` 的服务商表、`Develop_Document.md` 的已接入清单与 `public/js/help.js` 的支持列表同步补入 UCloud。 |
| R46 | 用户报告的 1 项（非审计轮，**小型修复，明确不推进版本号**）：① 原话「UCloud可以正常绑定API Key，但无法列出存储桶（获取成功，共 0 个存储桶）。不论是账号SecretID和SecretKey还是对象存储令牌的公钥和私钥，都无法列出。此次修复为小型修复，无需推进版本号。」 | 1 个修复（`R46-01`：地域留空时「端点」与「签名地域」分叉）+ **1 条行为护栏**（`tests/audit42-regressions.test.js` 新增 `R46-01`，给 `CONFORMANCE` 加 `blankRegion` 列并逐个厂商断言）+ **1 条反向对照**（`R46-01a`，台账 460 → **461**）；版本**保持 `1.6.8`**（用户明确「无需推进版本号」），故不新增测试文件、不动 5 处版本落点 | 根因**不是权限**，而是两处本该同源的信息分叉：注册表把默认地域**烘进了 `endpoint`**（`https://s3-cn-bj.ufileos.com`）却没有声明 `defaultRegion`，于是地域留空时 ①端点回退到这条**静态默认端点**（能解析、能连通 ⇒ 界面显示「绑定成功」），而 ②**签名地域**要靠 `deriveRegionFromHost()` 从**同一台主机**反推 —— 而它的域名清单里**没有 `ufileos.com`**，于是悄悄退到兜底的 `us-east-1`：请求打到 `cn-bj` 的主机、SigV4 凭证作用域却写着 `us-east-1`，云端据此返回一个**合法但为空**的桶列表（HTTP 200）⇒「获取成功，共 0 个存储桶」。UCloud 曾是注册表里**唯一**中招的厂商（阿里云 / 华为云 / 七牛 / B2 的域名都在清单里，AWS 则本就以 `us-east-1` 为默认地域、兜底恰好正确）—— 这也解释了「换 API 密钥还是 US3 令牌都一样」：**与权限无关**。判据落在**实际发出去的 `Authorization` 头的凭证作用域**上（而非读 `client.region`），顺带把「签名串是否与实际请求一致」纳入同一次断言；另加一条**覆盖闸**：凡「地域留空时仍有默认端点可回退」的 S3 厂商都必须在 `CONFORMANCE` 里登记期望值，新增厂商会当场点名。**刻意的不改**：UCloud 官方对 `GetBucketLocation` 的措辞是「返回所在地域名，**不建议依赖该 API**」，故**不给它开** `queryBucketLocation`（与 R43 华为云「必须反查」的处置相反），理由写在 `providers.js` 的注册表注释里。 |
| R47 | 用户报告的三条界面体验缺陷（非审计轮）：① 「当前用户执行某些操作后，必须刷新才能看到正式生效的结果。尝试不论用户执行了什么操作，立即强制刷新，或者使用更好的方案」；② 「用户刷新页面，不会回到原来的页面」；③ 「用户只能使用浏览器的刷新按钮，按 F5 刷新没有作用」 | 3 处根因修复：③ 删掉键盘处理里的刷新键拦截分支（`public/js/main.js` 的 `bindKeyboard`）；② 新增「主区块 ↔ 地址栏 hash」记忆（`App.state.mainView`、`VIEW_ENTRY` 角色门控表、`viewFromHash()`、`writeViewHash()` 走 `history.replaceState`、`bindViewHash()` 的 `hashchange`、`resetMainView()` 作废记忆、`bootstrapApp()` 先读 hash 再 `navigate`）；① 在 `public/js/api.js` 的 **唯一请求出口** `request()` 上新增「写成功 → 通知」收口点（`setWriteObserver` / `WRITE_EXEMPT` 逐条写明理由 / `isWriteExempt` 支持「精确」与「前缀+后缀」两种匹配），由 `main.js` 的 `onServerWrite` → `syncNow()` 统一做「配置快照 + 加密摘要 + **当前区块**」三项同步（200ms 去抖 + 重入串行）｜**20 条行为护栏**（`tests/audit47-regressions.test.js`，分源码层 / **角色门控行为层**（真跑 `viewFromHash()`）/ `api.js` 行为层（假 fetch 真调 `request()`）/ **端到端层**（真 api.js + 从 main.js 抽出的真 `onServerWrite`/`syncNow`）/ 接线层）｜**16 条反向对照**（`R47-01a`~`R47-05`，其中 `R47-03c` / `R47-04e` 为**两步变异**；台账 461 → **477**）；版本 `1.6.8` → `1.6.9` | 三条缺陷是**一个根因加两个后果**，且根因是用户列在最后的第 ③ 条。旧实现在键盘处理里对刷新键 `preventDefault()` 后只调一次 `explorer.refresh()`（取文件列表），于是：**用户口中的「刷新」= 按那个键**，按下去只重取一个区块、**别的区块一律不变**（改完设置后侧边栏 / 状态栏 / 仪表盘统计仍是旧值 —— 也就是 ① 的真实形态，用户只能靠**真正**的重载去拿新数据）；而唯一能真正重载的只剩浏览器工具栏那颗按钮，那条路径又因为**全站没有任何地址记忆**（`bootstrapApp()` 无条件 `App.navigate('')`）必定回到文件浏览首页（②）。**① 的正确解法不是「立即强制刷新」**（那正是 R29-02 已经否掉的形态：整页重载会丢地址与滚动位置、打断正在填写的表单）。做法是把同步从「每个调用点各自负责」挪到**唯一收口点**：全站 62 个 API 调用点里绝大多数自带收尾刷新（`refreshIpGuard()` / `renderX()` / `loadX()` / 直接改 DOM），**逐一补刷是假需求** —— 真正没人管的是**跨区块**那部分（保存一条分享链接不会更新仪表盘统计），而那部分**只有收口点能覆盖**。四条设计约束：其一，只刷**当前显示的那个区块**（不为看不见的页面付请求代价，也不重建用户没在看的 DOM）；其二，连续写请求按 200ms **去抖合并**（上传一批文件会连发几十条 `upload/complete`，逐条整轮刷新不可接受）；其三，**防自激** —— 同步过程自身发出的请求不再触发同步，同步期间到来的写请求被记为 `syncPending` 并在本轮结束后补做一轮（两处守卫缺任一都会退化成并发或丢失，故反面用**两步变异**钉住）；其四，豁免表判据是「**这次请求语义上是不是一次会让界面变旧的变更**」而不是「调用方自己已经刷新了」，只列探针（`/api/config/verify`、`…/config/<平台>/validate`）、会话生命周期（登录 / 登录第二步 / 初始化 / 登出；登出后再同步会打到已销毁的会话上）、解锁与挑战生成（`/api/enc/unlock`、`…/webauthn/register/options`）三类共 8 条。⚠️ 豁免**必须精确到那一条探针**：支付渠道的「验证」是 `…/config/<平台>/validate`，而同前缀的 `PUT …/config/<平台>` 是**真正的保存** —— 用前缀匹配把两者一起豁免会让「验证能过、保存却不生效」且表面「配置都对」，**本轮第一版实现正好踩了这个坑**（登记前实跑 16 条反面时才发现），现已由两步变异 `R47-03c` 守死。**② 的地址栏方案**：回写用 `history.replaceState` 而非 `location.hash = …`，因为后者会产生历史记录（与 `←` `→` 的**文件浏览**历史打架）并派发 `hashchange` 把自己绕回来（多一次重复刷新）；**地址栏是用户可任意编辑的输入**，故恢复必须过白名单 + **角色可见性门控**（后者只读 `renderUserMenu()` 这个角色权威点写下的 `hidden`，不在别处另写一份角色名单 —— 否则「改 hash 即可进管理员页」）；登出与换账号时记忆作废，与 `resetMainView()` 头部那条越权原因同源。**一处自查出的探针缺陷**：`R47-03c` 第二步变异第一版写成了 `path.startsWith(e.path))`（`startsWith(` 多了一个开括号却只补了两个闭括号）⇒ 变异体**语法错误**、整个 `api.js` 加载失败 ⇒ 该文件全部 10 条用例一起变红，`fail=10` 表面上「通过」而红的却不是这条用例的判据 —— 正是本项目反复强调的「`fail>=minFail` 不说明红的是哪条」，靠**逐条实跑并核对失败名单**抓出，修正后该条精确红 1 条。另有一条自证过的假绿陷阱：`R47-05` 的反面若把 `setWriteObserver(onServerWrite);` 换成**注释**，护栏（按 `includes` 查函数名）会被注释满足 ⇒ `fail=0`，故反面直接换成一句空语句 `void 0;`。 |
| R48 | 用户提出的三项（非审计轮）：① 按 `FEASIBILITY-单线程改造.md` 改造该项目使其支持**多线程**与**多文件同时上传**，并在系统设置的「用户管理」与「负载均衡」之间新增「**线程并发**」卡片（可设置最多可以有多少个文件同时上传、加密，**最小为 1**）；② 在「订单管理」中新增「**收入统计**」卡片（已分享的付费文件的**总计收入**、**单文件累计收入**、**累计售出次数**，单文件还要显示**单价**与**来自哪个存储桶**）；③ 推进版本号至 **1.7.0** 并推送 GitHub | 三条一起做，代码落点：**多线程** —— 新增 `server/enc-xor.js`（纯 `crypto` 原语：密钥流生成与异或，无副作用）、`server/enc-pool.js`（`worker_threads` 池，**入口即本文件**，`if (!isMainThread)` 走 worker 分支）、`server/enc-store.js` 把 `encryptBuffer` / `encryptPart` 拆成「**唯一实现 + 执行器**」（`ex === null` ⇒ 主线程同步，逐字节等价于历史行为；非 null ⇒ 交给池）并新增 `encryptBufferAsync` / `encryptPartAsync`，两条写入路径（`server/routes/fs.js` 的直传与分片、`server/fs-gateway.js` 的 WebDAV PUT）改走异步入口，`server/index.js` 在退出路径上 `encPool.shutdown()`；**多文件并发** —— `public/js/util.js` 新增 `uploadPlan()` / `uploadPlanNotice()`（**唯一推导点**，按浏览器 6 条连接反推单文件分片并发）、`public/js/upload.js` 删掉硬编码的 `MAX_FILE_CONCURRENCY` / `MAX_CHUNK_CONCURRENCY` 改由配置驱动、`public/js/main.js` 从 `/config` 读入；**配置与卡片** —— `server/config-store.js` 新增 `normalizeConcurrencyFiles()` / `getConcurrency()` / `setConcurrency()`（默认 3，`safeView()` 对**所有角色**下发 `concurrency`）+ `server/limits.js` 的 `parseConcurrencyInput()`（`CONCURRENCY_FILES_MIN/MAX` = 1/16）+ `server/routes/enc.js` 的 `PUT /concurrency`（仅管理员，非法入参 400）+ `public/js/syssettings.js` 的「线程并发」卡片（登记进 `ADMIN_ONLY_CARDS`，实时预览与调度**同源**）；**收入统计** —— `server/payment-orders.js` 创建订单时**快照** `bucket` 并新增唯一判据 `bucketOf()`、`server/share-routes.js` 传入桶名、`server/routes/payment.js` 订单行带出桶名、`public/js/ordermgr.js` 新增 `computeRevenue()` / `renderRevenue()`、`public/index.html` 在订单管理页内新增收入统计卡片。版本 `1.6.9` → `1.7.0` | 三条里最重的是 ①，而报告给出的**不是 `cluster`**：本项目是单实例进程，登录会话 / 单实例锁 / 限速桶 / 各类缓存全在**进程内存**里，`cluster` 会把这些状态复制成 N 份（会话在 A 进程建立、请求落到 B 进程即表现为「随机掉线」），报告 §三 已明确否掉；被采用的是 §四/§五 的**方案 C**（`worker_threads` 加密池）。可量化的事实是：`magic` 的密钥流原先是**纯 JS**、每 32 字节一次 SHA-256（约 15MB/s），5MB 要占住事件循环约 330ms、48MB 分片约 3.0s，而 AES-256-GCM 走 OpenSSL 是约 1590MB/s（约 100×）——用户「上传时整个服务卡住」的观感全部来自这一个纯 JS 循环。四条设计约束：其一，**小负载不走线程**（低于 512KB 时「线程往返 + 两次结构化克隆」比直接算还慢）；其二，**任何一次线程抖动都必须能出结果**（`degrade()` 永久退回主线程 + 在途任务就地重算 —— 任务全由调用方给定密钥 / 盐 / IV，是**确定性**的，重算结果相同）；其三，**`ref` / `unref` 必须随「有没有活干」切换**（空闲时不 `unref` 会让任何加载了本模块的进程无法退出；有活时不 `ref` 会让 `await pool.xor(...)` 把控制权直接交回、进程以 **exit code 0** 安静退出而结果**静默丢失** —— 本轮第一版正是这个形态：探针跑完小负载就结束，不报任何错）；其四，`terminate()` 会派发非零 `exit`，故 `closeAll()` 必须**先** `removeAllListeners()`，否则「主动停机」会被自己的 `exit` 处理器误判成崩溃并触发 `degrade()`。**「同时上传几个文件」为什么不能直接开大**：真正在飞的请求数 = 文件数 × 单文件分片数，而浏览器对同一 origin 的 HTTP/1.1 并发硬顶是 **6**（网页端改不了、服务端也改不了）——旧实现把「2 文件」「3 分片」各写一个常量（2×3 = 6 正好顶满），于是这个数**没法单独放大**，一放大第 3 个文件的分片只能在浏览器里排队（外观上就是「卡住」）。改成只暴露「同时几个文件」、分片并发由预算反推（1~2 文件→3 片；3 文件→2 片；4~6 文件→1 片；>6→1 片），取不到配置或值非法一律退回**串行**（「先按大值起跑、拿到配置再收窄」会让头几个文件真的打满连接池）。护栏分两层：`uploadPlan()` 是纯函数（穷举表格 + 「乘积 ≤ 6」不变量 + 残留预算必须用满），**再真的跑一遍真实 `upload.js`**、数「同时在途的 `xhrPut` 峰值」（设为 1/2/5 时峰值必须恰好是 1/2/5）——只断言常量表等于某个数是证明不了「界面设了就真的并发起来的」。**配置归一化的三分支**：「缺失」（历史配置里根本没有这一段）必须落**新默认值 3**，「非法」（`0` / 负数 / `NaN`）才退到最保守的 **1** —— 本轮第一版把两者合并，后果是所有老配置升级后并发被**静默降到 1**，用户看到的是「升级之后上传变慢了」而配置页显示的正好是 1（看起来像是自己设的），极难排查；接口入参则由 `parseConcurrencyInput()` **显式**判定、非法一律 400，不交给归一化函数静默改写。**② 收入统计**的口径全部落在 `computeRevenue()` 一个纯函数上（只算 `paid`、退款单列、按**对象键**归集（`k:` 前缀，与「无对象键的历史订单」的 `n:` 家族分开，避免名为 `a/b.txt` 的文件与同名对象键被并成一行）、单价取**最近一次成交价**且改过价时显示**区间**而不是只报一个数、桶名取该文件订单里**第一个非空快照**且绝不猜）；为此订单必须在创建时**快照** `bucket`（历史订单靠 `bucketOf()` 回退到现存分享链接，链接也删了就如实显示「未知」——猜错等于把一笔收入记到别的桶头上，比留空难查得多）；渲染与订单表**同源**（同一份 `ordersCache`、且 `computeRevenue()` 全前端只有一个实现点），否则就会出现「上面统计说收了多少、下面流水加起来对不上」这种两套口径的经典症状。配套 **22 条行为护栏**（`tests/audit48-regressions.test.js`，分线程池行为层 / 调度纯函数层 / **调度行为层**（真跑真实 `upload.js` 数在途峰值）/ 收入口径层 / 接线与卡片层）与 **16 条反向对照**（`R48-01a`~`R48-05b`，逐条实跑并核对**失败名单**而非只看 `fail>=minFail`；台账 477 → **493**）。⚠️ 两处自证过的护栏缺陷：其一，A7 的判据若不先**剥注释**，会被 `fs-gateway.js` 里那句**说明历史行为的注释**（原样写着同步入口名）判红，而正向断言又会被注释满足（假绿）——两个方向都踩过；其二，`R7-02` 的 anchor 原先锚在 crypto 分支的 `return finish(...)` 上，R48 之后那条 `return` **只覆盖同步路径**（写入路径已改走异步入口、走的是池内计算），实测 `fail` 从 2 掉到 **1**，反向对照**悄悄变弱**，遂改锚到**两条路径共用的 `finish` 闭包**里（改完重跑确认恢复为 2 条）。 |
| R49 | 用户提出的两项（非审计轮）：① 原话「自签名证书会被浏览器报告不安全，且无法使用某些功能，因此自签名证书没有意义」，并要求「移除 `selfsigned` 依赖和自签名证书相关功能」；② 「将 COS API 移除，让腾讯云也使用 S3 兼容协议，并将所有与此有关的代码、代码文件的文件名『cos』都更换为『s3』」（用户另指定参照 `.workbuddy/memory/2026-10-13.md`） | ① 证书：**删除** `server/local-cert.js`、**新增** `server/tls-cert.js`（`loadTlsCert()` 是唯一判据点，**只读、绝不写盘**）；`server/index.js`（内置 HTTPS 是否监听 + 301 目标端口）、`server/webdav-server.js`（是否监听 + `getTlsError()` 经 `webdavView().tlsError` 上界面）与 `public/js/syssettings.js`（「已启用，但无法启动：原因」）三处消费**同一个**结果；新增 `TLS_CERT_FILE` / `TLS_KEY_FILE` / `PUBLIC_HTTPS_PORT` 三个环境变量（缺省 `data/tls/fullchain.pem` + `privkey.pem`）；`Dockerfile` 去掉 `HTTPS_PORT` 的硬编码 `ENV`；`deploy.sh` 的 `--tls` 改为 `auto\|acme\|file\|none`（`selfsigned\|self` **显式拒绝**、ACME 失败由「回退自签名」改为**致命**并给出两条出路、`gen_self_signed` → `use_provided_cert`（只校验并认领）、`SELF_SIGNED_DIR` → `TLS_DIR`、HSTS 长期值**只对 ACME 签发的证书**下发）；`selfsigned` 及其连带的 `node-forge` / `@types/node-forge` 从 `package.json` 与 `package-lock.json` 移除（运行时依赖 **3 → 2**）；证书夹具以 base64 常量存于 `tests/fixtures/test-tls.js`（不落 `.pem` 进仓库）；② COS→S3（本轮第二部分，版本 `1.7.1` → `1.7.2`）：**删除** `server/cos.js`（`git mv` 为 `server/s3.js`，COS 分支整体消失）、**移除** `cos-nodejs-sdk-v5` 及其在锁文件里的**整棵 68 包依赖子树**（`conf` / `fast-xml-parser` / 已废弃的 `request@2.88.2` …；运行时依赖 **2 → 1**，只剩 `express`）；`server/providers.js` 腾讯云条目 `kind: 'cos'` → `'s3'` 并补 `endpoint` / `endpointTemplate`（`https://cos.{region}.myqcloud.com`）；`isCos()` **删除**（机械改名会让它恒等于 `isS3()`，把两条只有腾讯云适用的规则静默外溢到全体 S3 厂商），厂商差异改由注册表字段承载 —— 新增 `secretIdPrefix: 'AKID'`（唯一读取点是 `routes/_shared.js` 的 `validateCredentialFormat`）与 `copyObjectMaxBytes: LIMITS.COPY_SIMPLE_LIMIT`（`copyNeedsSlice()` 收敛成「只认厂商声明的上限」一条规则，且对未知厂商保持旧语义 `false`）；`server/bucket-stats.js` 删除唯一调用 COS `?stats` 的 `getBucketStatViaApi()`（S3 协议没有「读桶容量」这个操作，`S3Client#request()` 会抛 501），腾讯云桶容量退化为**分页列举估算**（超过 5001 个对象时界面标注为下界）；`server/s3-client.js` 的域名清单补 `myqcloud.com` / `cos`（漏了就会在地域留空时签成 `us-east-1`，云端返回**合法但为空**的桶列表 ⇒ 界面「获取成功，共 0 个存储桶」）；`tests/audit42-regressions.test.js` 的 `CONFORMANCE` 对照表补腾讯云。**改名（一律「改名 + 保留兼容别名 + 一次性迁移」）**：数据目录开关 `COS_DATA_DIR` → `S3_DATA_DIR`，新增 `server/data-dir.js` 作**唯一实现点**（原先 10 个 store 各拼一遍同样的三元表达式；取值写成函数而非模块常量），旧名继续可用且首次命中时提示一次；前端 localStorage 的 `cosmgr.prefs.v1` / `cosmgr.auth.v1` → `s3mgr.*`，新增 `readMigrating()`（新键优先 / 旧键兜底并当场迁移后再删），并把 `window.__savePrefs` 从 `explorer.js` 搬到 `main.js`；`requireCfgCos()` / `requireCos()` → `requireS3()`、`cosStream` → `s3Stream`、`cosmgr_session` → `s3mgr_session`、`cosmgr-captcha/1.0` → `s3mgr-captcha/1.0`、`__cosCaptchaReady` → `__s3CaptchaReady`（脚本 URL 的 `onload` 与 window 上的回调名必须同时改，否则组件永远渲染不出来）。**腾讯云的产品名与真实域名（`cos.<region>.myqcloud.com`）保留 `COS` 字样** —— 那是厂商商标与端点，不是本项目的协议选择。另外收口 `copySource()` 时**真实发生过一次事故**：删厂商分支时顺手把它第 3 个形参 `region` 也去掉了，而三处调用点仍按老位置传四个实参 ⇒ `key` 错位到 `region` 上，拼出 `/<桶>/<地域>` 这种**语法合法但指向不存在对象**的 CopySource（请求会被云端正常受理，只是复制错了东西），被 `tests/azure-client.test.js` 的 R30 用例（按四参调用）当场抓住 —— 遂**保留四参签名**（`region` 收下但不参与判据）并补 `R49-18` / `R49-18a`。**9 条行为护栏**（同文件 R49-10~R49-18，共 **18 条**）+ **16 条反向对照**（`R49-10a`~`R49-18a`；台账 504 → **520**）；版本 `1.7.0` → `1.7.2` | **为什么「有一张自签名证书」等于没有 HTTPS**：它不是「差一点的 HTTPS」，而是**两件事都没拿到** —— ① 没有可信签发链，浏览器判它为 `NET::ERR_CERT_AUTHORITY_INVALID`（告警并没有被消除，只是从「没有」变成「每次都要手点继续访问」）；② **安全上下文（Secure Context）根本不成立** —— WebAuthn（Windows Hello 登录）、Service Worker、剪贴板、摄像头/麦克风、通知这些「必须有 HTTPS 才能用」的能力**一个也换不来**。于是它剩下的只是「看起来像 HTTPS」的错觉，外加一处需要长期维护、还极易配错权限的私钥。**产品语义因此收敛为**「只加载运维自备的真实证书；没有证书就只跑 HTTP」——**明确不做静默降级**：无证书时内置 HTTPS（3443）与 WebDAV 一律不启动，并在日志与界面上说清「缺什么 / 放哪儿 / 不放会怎样」。**判据只有一个实现点**是这一轮的关键设计：`loadTlsCert()` 返回 `{ok:true, cert, key, certFile, keyFile}` 或 `{ok:false, reason, certFile, keyFile, missing}`，它同时驱动三个消费方（内置 HTTPS 是否监听 / WebDAV 是否监听 / 明文 301 的目标端口该指向哪里）—— 三者若各判各的，必然出现「HTTPS 没起、但 301 仍然往 3443 送人」这类组合态，而访客看到的是 `ERR_CONNECTION_REFUSED`、日志却一片正常。301 的目标端口新增 `PUBLIC_HTTPS_PORT`（缺省取反代的 **443**，而不再是内置的 3443）；并且**没有证书时不再 301**（`if (!TLS.ok && !security.TRUST_PROXY) return next();`）—— 把访客送去一个没人监听的端口，比不跳转更糟。**「只读」是硬约束**：旧 `local-cert.js` 最危险的一点是「读不到 / 签名太弱就**就地重签**并把私钥写回缓存」，运维的证书会在自己不知情时被应用改掉；现在任何分支都不会创建或改写文件，代价是原来那份证书缓存文件随之消失（备份清单相应改为 `data/tls/`）。校验被提到**任何监听发生之前**：证书解析不了、私钥带口令、**证书与私钥不配对**，都在这里当场判成 `ok:false` —— 而不是等 `https.createServer()` 抛 `ERR_OSSL_X509_KEY_VALUES_MISMATCH`（那时表现为「端口在监听、请求进来就断」，是最难排查的一类）。**部署脚本不再代签**：`--tls selfsigned` 被显式拒绝；ACME 申请失败由「回退自签名」改为**直接中断部署**（提示给出两条出路：`--tls file` 或 `--tls none`）；取代生成函数的是 `use_provided_cert()`，它**只校验并认领**，且仍要过唯一判据点 `cert_file_ok`（字段非空 + 与私钥配对）—— 只判「文件存在」会放过一种坏证书：`openssl` 能读、`nginx -t` 也过，浏览器里证书信息却是一片空白。HSTS 的长期值**只对 ACME 签发的证书**下发，其余来源（含自备证书）一律 `max-age=0`：无法确认可信链时不该让浏览器长期记住它。**WebDAV 不再「转圈」**：它是**强制 HTTPS** 的（Basic 凭据只是 base64，走明文等同明文发口令），没有证书时只能不启动 —— 但原因必须能到界面，故新增 `getTlsError()` 经 `webdavView()` 带到前端，界面显示「已启用，但无法启动：<原因>」而不是永远停在「服务正在启动…」。**一轮里最值得记下的两条自省**：其一，`R49-08` 的负向断言（`deploy.sh` 里不得出现 `gen_self_signed`）**被我自己写的解释性注释满足了** —— 那句注释为了说明「为什么删掉它」原样写着旧函数名，而 `stripComments()` 只处理 `//` 与 `/* */`、**不认 shell 的 `#`**；修法是补一个 shell 口径的剥注释器（行首与行内的 `#`，引号内与 `${VAR#pat}` 不算），并给剥注释器本身加三条自证（能剥掉注释 / 不吃代码 / 等长）。其二，`R49-02` 反向对照最初写 `minFail: 2` 却只得 `fail=1`：不是护栏弱，而是第 3 条用例的**第一条断言**（目录快照「不得新建文件」）会先命中并中止该用例，后面那条「源码里不得出现写盘 API」**根本没机会执行** —— 于是补登 `R49-02b`（把写入调用塞进不可达分支，快照看不到变化，**只有静态判据能抓住**），两条对照各证一个判据。另有一条变异（把 WebDAV 的 `if (!tls.ok)` 改成 `if (false)`）会让 WebDAV **真的监听成功**，而该用例不 stop，于是 `node --test` 因监听句柄**永不退出**、被前台超时强杀并在工作区留下 `.reversebak` —— 变异要选「同样能证伪、但不改变进程存活状态」的那一处（改判「原因是否被记录」）。 |
| R50 | 用户提出的四项中的三项（非审计轮）：① 「文件分享页的文件图标还是默认的，我们之前已经制作了 SVG 内联图标，把文件分享页的默认图标修改为对应的文件图标」；② 「支持左键框选多选文件」；④ 「分享链接的『链接创建成功』页……改为：使用 div 展示链接，添加一个『复制』按钮，展示文件的文件名、链接创建时间、过期时间、价格、允许下载次数，再添加一个链接的二维码（尽量 0 依赖实现）」。第 ③ 项「多文件 / 文件夹分享」经用户确认**单列一轮** | 1 个新模块（`server/file-icons.js`）+ 1 个新路由（`GET /links/qrcode`）+ **17 条行为护栏**（`tests/audit50-regressions.test.js`）+ **18 条反向对照**（`R50-1a`~`4g`，台账 520 → **538**）+ `public/js/explorer.js` 的框选实现、`public/js/ops.js` 的弹窗改版与复制按钮；版本 `1.7.2` → `1.7.3` | 三条里最有隐患的是①：分享页是**服务端渲染的独立文档**，它没有 `index.html` 那套 `#icon-sprite` 雪碧 —— `<use href="#fic-x">` 在那里只会画出一片空白，而且**浏览器既不报错、控制台也干干净净**，没有人会从症状上想到「图标没内联」。故 `file-icons.js` 从 `index.html` 解析 `<symbol>` 后**按需内联**，并且刻意**不复制图形**（图形的唯一真相仍在 `index.html`），代价是每次都要解析一次雪碧、收益是永不漂移。据此设了一条**跨端等值**护栏：服务端 `iconIdFor` 必须与前端 `util.js` 的 `iconIdOf` 对 22 个样本**逐项相同** —— 否则同一个文件在文件列表与分享页会显示不同图标，而两处各自的单测都是绿的。雪碧读不到时如实回**空串**（调用方降级回 `📄`、页面照常 200），绝不返回一个不存在的 id。②的判据是**视口坐标下的矩形相交**（与选框同坐标系，横竖滚动都不必换算），4px 阈值是刻意的：空白处 `mousedown` 的既有语义是「清除选择」，不加阈值的话任何带轻微抖动的空击都会变成框选。④的两处如实记录的局限：`qrcode.js` 止于版本 10（约 213 字节），**预签名直链**（400+ 字节）编不出二维码，此时那个位置显示原因而不是一块让用户对着扫码的空白方块；复制按钮带 `execCommand('copy')` 回退，因为 `navigator.clipboard` 只在安全上下文存在，而本服务最常见的部署形态正是「局域网 IP + HTTP」。**判据塌陷两处**（都记在前面）：① 只有**跨端等值**那条能抓住服务端选图标的漂移，纯函数层的自洽断言抓不住；② 框选沙箱的假 `querySelectorAll` 若恒返回空数组，「一个都没选中」会是**假绿**而不是真绿。 |
| R51 | 用户提出的两项（非审计轮）：① 「修改『链接创建成功』页：增加对话框和链接 div 标签的宽度，使链接可以一行显示完」；② 「多文件 / 文件夹分享：如果多文件和/或文件夹分享，文件分享页以列表形式显示全部文件和文件夹，可勾选要下载的文件，并分页显示 —— 每页最多 50 个文件/文件夹，50 个以上则分页」（即 R50 挪下来的第 ③ 项）。三条口径经用户确认：**只勾 1 个文件按原名直传、多选或含文件夹则打包 `.tar.gz`**；**整批算 1 次下载**；列表**扁平平铺**（不按层级折叠，每行显示相对路径） | 4 个新服务端模块（`server/tar.js` 零依赖 tar 写出 / `server/share-bundle.js` 打包下发 / `server/traffic-meter.js` 计量唯一实现点 / `server/attachment-name.js` 附件头唯一实现点）+ 1 个新前端模块（`public/js/share-list.js`）+ `share-store` / `share-routes` / `routes/links.js` 的多条目改造 + **34 条行为护栏**（`tests/audit51-regressions.test.js`）+ **40 条反向对照**（`R51-1a`~`5h`，台账 538 → **578**）；版本 `1.7.3` → `1.7.4` | 本轮的核心判据只有一条、但它同时决定两件事：**`listView` 由服务端算**（多条目或唯一一条是文件夹）—— 「页面要不要列表」与「下载是直传还是打包」必须是**同一个**判据，否则会出现「页面是列表、下载却只认第一个文件」这种半吊子状态。**打包为什么自己写 tar（零依赖）**：运行时依赖刻意只有 `express`（R49 之后连云厂商 SDK 都移除了），为一次打包下载引入 `tar-stream` 不成比例；而 ustar 的格式本身很小（512 字节定长头 + 内容 + 补零，两个全零块收尾）。刻意做的三件事都有护栏：**GNU `L` 条目**承载超 100 字节的中文/深层路径（PAX 更「标准」但解析器要求更高，而这里没有需要 PAX 才能表达的信息）；**base-256 大端**编码超过 `8**11-1` 的 size（继续按八进制写不会报错，只会让解包出来的长度变成一个看起来合理、实际完全错误的数字）；**`safeName` 就地消解 `..`**（对象 key 由我们自己产生，但这层防御不依赖上游可信）。**三处「宁可中止也不产出坏包」**：① tar 头声明的长度必须与实发字节**完全相等**，短了会让解包工具把下一个文件头当内容读走、长了会连带破坏后面所有条目，故两个方向都抛错；最初按「短了补零」处理，探针立刻暴露出它会为一次失败的下发申请 GB 级内存（gap 的上界就是对象大小），而且交出去的是一个**能通过解包**、尾巴全是零的坏文件，极难发现；② 长度在**打开流之前**重新 head 一次，不用创建时的快照值（对象被覆盖过之后快照只是一个历史事实）；③ 单个对象不存在时**跳过**（一条分享里 2000 个对象，一个被删就整包下不了对用户是净损失）。**两处刻意的口径差异**：计量环节在打包管线里放在 **gzip 之后**（用户拿到的是压缩字节，明文总量既不可见也无意义），与主站下载的「明文口径」不同；直传 vs 打包的分界是「勾了几项」，只勾一个文件却套一层 `tar.gz` 是纯粹的负担（还得先解压），而直传独有进度与 Range 续传。**分页是服务端渲染的**（`?page=N`，无需 JS 即可翻页、天然可后退可分享），勾选是**渐进增强**（脚本不可用时仍能勾本页提交；有脚本时按链接存 `sessionStorage` 实现跨页累计，提交时把其它页的补成隐藏 `k` 字段）。**勾选必须能被服务端校验**：`parseSelection` 只接受**创建时快照里存在**的 key，勾文件夹则从快照展开其后代文件 —— 否则 `/s/:id/dl` 就是一个任意对象下载器。**两个自己踩到的坑**：① CSP 断言最初直接扫 `server/index.js`，先命中了那句注释「SEC-06：移除 `script-src` 的 `'unsafe-inline'`」，得到一条恒假的判据（必须先剥注释）；② 判假 DOM 节点上的 `.disabled` / `.checked` 属性是**恒绿**的（假 DOM 不解析 `innerHTML`），故一律改判**下发出去的 HTML**。 |
| R52 | 用户提出的五项（非审计轮，需求原文）：① 「当前已有文件夹分享，但并未实现多文件和文件夹的分享（即：既可以选择多文件，也可以同时选择文件和文件夹）」；② 「当前的『移动』功能：多文件移动时，前端报告移动成功，但实际未成功」；③ 「当前已有单文件、文件夹的『移动』功能，但没有『复制粘贴』的功能」；④ 「文件分享页：如果有多个文件/文件夹，应默认选中全部」；⑤ 「文件分享页：如果分享了子文件夹，则文件名中还是会显示上一级文件夹的名称，这可能会暴露隐私，修复它」。四条口径经用户确认：① 入口补在**多选右键菜单**（「复制链接（N 项）」，与工具栏一致）；② 「**默认不预选当前目录 + 结果如实汇总**」；③ 「**与 Windows 资源管理器一致：逐个询问是否覆盖，可选「全是」**」；⑤ 「**隐藏「分享根之上」的祖先**」（保留被分享的那层文件夹名） | 1 条新路由（`POST /fs/copy`，随之触发 R28-02 的「/fs 写入口」硬计数 5 → 6）+ 1 条新前端 API（`API.copy`）+ 文件列表的复制 / 粘贴（工具栏 + 右键三处分支 + `Ctrl+C` / `Ctrl+V`）+ `share-store.itemPaths` 展示路径唯一实现点 + `parseSelection` 的 `mode=all` / `mode=exclude&x=` 协议 + **19 条行为护栏**（`tests/audit52-regressions.test.js`）+ **22 条反向对照**（`R52-01`~`R52-06b`，台账 580 → **602**，实测 `CASES.length`）；版本 `1.7.4` → `1.7.5` | 五项里有两项是**同一类谎报**（②「报成功、实际没动」与 ④ 的「清空后点下载反而拿到全部」），故落点集中在「**结果必须与意图一致**」上。**① R52-02（移动）的两个根因缺一不可**：目标被**默认预选成当前目录**（旧写法 `fixedTarget \|\| App.state.prefix`，而 `fixedTarget` 只有「拖到文件夹行上」才拿得到 ⇒ 工具栏那条路径的目标恒等于这些文件自己的父目录，服务端算出 `newKey === key` 后直接返回跳过）+ `skipped` 被**当成成功**统计（只筛 `!x.ok`）。只修前者，用户仍会把「跳过 N 项」看成「移动完成」；只修后者，用户仍面对一个默认填好了错误目标的弹窗。连带修掉一处**顺序**缺陷：「目标与源相同」必须先于「不能移动到自身内部」判定，否则「把 `src/` 移到它自己的父目录」被报成「不能将文件夹移动到其自身内部」—— 文案讲的是一个**根本没发生**的错误，而且让「如实回报跳过」对**文件夹**永远不可达。**② R52-03（复制 / 粘贴）的核心是「先问、再写」**：云端覆盖不可撤销，故第一次请求只**逐项探测**冲突、**一个字节都不写**，回来 `needsDecision` 后前端**逐项**询问（可勾「全是」），再把 `decisions` 带回去重发；冲突粒度是**用户选中的那一项**，不是「每个冲突的子对象」（一个 2000 文件的文件夹撞名不该弹 2000 次窗）。⚠️ 与 `rename` / `move` 共用 `copyBatch` 时**必须传 `rollback:false`**：它内部回滚删的是「本次复制成功的目标键」，那对 rename / move 成立（它们预先拒掉一切冲突 ⇒「成功的键」⊆「本次新建的键」），而**复制允许覆盖**，`copied` 里会混进目标侧本来就有的对象 —— 照单全删就是 R11-03 / R12-02 记录过的不可逆事故。★ 这条护栏最初**比名字弱**：①②两个场景里被覆盖的对象恰好就是**失败**的那一项，它从没进过 `copied` 台账，于是即便没关内部回滚，结果也**碰巧是对的**；补了场景③（覆盖成功项与失败项落在**同一批**里）之后 `R52-03c` 才真正变红。**③ R52-04（默认全选）必须是「跨页」的**：只靠脚本在加载后勾上，脚本被拦时就退化成"一个都没勾"；只知道本页 50 个时，第 2 页及以后反而在用户什么都不做时不会被下载。故服务端**直接渲染 `checked`**（无 JS 也成立），另注入整份快照清单，提交时挑**最短且无歧义**的表示（请求行塞几千个 `k` 会被 Node / nginx 拒掉，表现为点「下载选中」毫无反应）。这里有一处**反直觉但必需**的协议决定：排除集走独立字段名 `x` 而**不**复用 `k` —— `mode=exclude` 下 `k` 的语义翻转成「要排除的」，而页面上已勾选的复选框**一定**会随表单提交成 `k`，混在一起的效果是「用户**正要下载**的文件反被排除掉」。写这条护栏时又实测出两个真缺陷：排除集里**漏了本页未勾选**的项（浏览器不提交未勾选的复选框 ⇒ 用户取消掉的文件照样被下载），以及**清空选择**后提交会「什么都不带」而被服务端读成「整条分享」（与他刚做的操作正好相反）。**④ R52-05（脱敏）只影响展示**：`itemPaths` 是列表行与归档条目名的**唯一**来源（页面脱敏、压缩包里照旧等于没做，而归档更严重 —— 解出来的目录结构就是分享者的组织方式）；复选框 `value`、下载校验、加密元数据仍用**原始 key**（展示名绝不能变成"决定从桶里取哪个对象"的输入）。判据按「共同祖先**本身**是否被选中」分两支（是 ⇒ 只抹它之上、保留它自己的名字；否 ⇒ 整段抹掉），无共同祖先时原样 —— 抹掉任意一段都会让两条不同路径撞成同一个名字。**⑤ 三处判据塌陷（本轮最贵的一节）**：其一，桩化的 `openModal` **必须与真实实现同形** —— `close()` 要调 `onClose`、按钮的 `onClick` 要收到**它自己的** `close`；缺了这两点，「先 close 再 finish」这类顺序缺陷与「关没关弹窗」这类断言会**双双变成恒真**（`R52-03e` 第一次实跑就是 `fail=0`，而变异明明生效）。其二，`POST /fs/copy` 按 R23-04 棘轮改用 `apiHandler` 之后，**错误体里的 `code` / `quota` 被静默丢掉**了 —— 前端 `api.js` 把 `code` 挂回 Error、`util.js` 的 `showQuotaDialog` 靠它区分「超出 API Key 空间上限」与「超出存储桶配额」，丢了就只能对所有 403 弹同一条提示；故把 `apiHandler` 的落地改走**唯一**的错误体序列化点 `errorBody()`（它是 `{ error }` 的**超集**，只在有这两个字段时多两项，其余输出与旧写法逐字一致）。其三，一条既有的不变量当场变红：新路由里拼出的目标键写作 `targetOf(key)`，而 R14-13 的判据要求 `const newKey = ...` 那一行**看得见** `normalizeKey(` —— 判据不认识间接层，故改为 `normalizeKey(targetOf(key))`（幂等）并写明这是**有意**的冗余。**⑥ 一处刻意的能力缺口**：只提供「复制」，**不提供「剪切」** —— 剪切语义是「粘贴成功后才删源」，而复制允许**逐项跳过**，于是「粘贴了一半」时源该删哪些需要一套单独设计并验证过的事务语义；没做对之前，给一个会静默丢数据的「剪切」比不给更糟。**⑦ 两条既有护栏的判据形态必须随本轮同步**：其一，新增 `/fs/copy` 写入口，R28-02 的「/fs 写入口」**硬计数** 5 → 6（这条硬计数正是「新入口有没有过桶级闸门」的提醒装置 —— 数字对不上不一定是缺陷，但必须先回答「新入口过闸门没有」）；其二，`Ctrl+C` / `Ctrl+V` 走**应用内**剪贴板也必须 `preventDefault`（否则浏览器对页面文字的选择复制会跟着动），`bindKeyboard` 里的处数由 1 变 3，R47-01b 原本写死「只剩一处 preventDefault」会**把合法增长判成回退**，故改判「**每一处** `preventDefault` 都必须挂在 Ctrl/Cmd 组合键的分支上」（判据前先剥行注释，防「注释里写了 `e.ctrlKey`」这类假绿）—— 这个口径既容得下新增，也照旧抓得住「把刷新键重新拦下来」。两处都实跑 `--only=` 反向对照核对了**失败名单**（`R28-02` 红 2 条含本条；`R47-01a` 红 2 条含 `01b`），而不是只看 `fail>=1`。 |
| R53 | 用户提出的一项（非审计轮，需求原文）：「在『用户管理』和『线程并发』之间添加『发信设置』卡片，允许用户设置 SMTP。尽量不要新增任何依赖项。」 | 1 个新服务端模块（`server/smtp.js`，零依赖 SMTP 客户端）+ 1 个新路由模块（`server/routes/smtp.js`，三条接口）+ 配置段落 `config-store.smtp`（含**字段级加密**的口令）+ 系统设置页一张**管理员专属**卡片（`#sysset-smtp-card`）+ **32 条行为护栏**（`tests/audit53-regressions.test.js`）+ **17 条反向对照**（`R53-01a`~`R53-09c`，逐条实跑并核对**失败名单**，台账 602 → **619**）；版本 `1.7.5` → `1.7.6` | **① 零依赖是本轮的硬约束，也是唯一可行的形态**：需求原文「尽量不要新增任何依赖项」 ⇒ 不引 `nodemailer`，直接用 `node:net` / `node:tls` 手写会话：EHLO（被 502 拒则退回 HELO）→ STARTTLS（升级后**必须重发** EHLO —— 明文阶段大量服务器隐瞒 AUTH，不重发就会误判「此服务器不需要登录」而在明文里发口令）→ AUTH（PLAIN 优先，否则 LOGIN 的 334 三次握手）→ MAIL FROM → RCPT TO → DATA → 正文 → `CRLF.CRLF` → QUIT。信件构造同样自己来：非 ASCII 的主题 / 显示名走 **RFC 2047** 编码字并按 76 字符折行，正文 base64 且折行，DATA 载荷行首的点做**点填充**（不填充会被服务端当成结束标记，正文从第一个点起被截断 —— 这是本轮两处真缺陷之一）。 **② 保密闸门：口令只在加密连接上发出**。明文连接上一律拒发并报错 —— 宁可让「测试邮件」失败，也不能让一次抓包拿到凭据；而如果不设这道闸门，界面上显示的恰恰是「测试成功」。**③ 信头注入面**：SMTP 是行式协议，命令与信头都是手工拼进一行的，地址或文本里带一个 CR / LF 就能追加 `RCPT TO` / 伪造 `From:` / 覆盖 `Subject:`；故所有地址与文本字段一律拒绝含换行的输入。⚠️ **判据必须落在 trim 之前** —— 早先写成先 `v.trim()` 再判 `[\r\n]`，于是 `a@b.com\r\n` 被裁成合法地址放行，「能不能注入」变成依赖「trim 恰好把恶意内容删干净」的性质（中间的换行删不掉，两种输入两种答案）。这是本轮另一处真缺陷，两条都由自写护栏**首跑**抓出。 **④ 加密方式缺省跟随端口**：固定 `secure: true` 会让 587 去握隐式 TLS 而必然超时；缺省 `secure: false` 又会让 465 在明文里发口令、被自己的保密闸门挡下 —— 两个方向的**默认组合**都必须是「这一行的常见用法」，故由端口推导，并允许显式覆盖。 **⑤ 三处归一化调用点（纵深防御）**：`normalize()`（读盘，历史配置没有这一段 ⇒ 补齐为关闭态）、`save()`（**顶层键替换**，半截对象会让发信时端口变成 `undefined`）、`getSmtp()`（取用）各归一一次 —— 故对应反向对照**必须三步一起撤**才变红，只撤任一处 `getSmtp()` 都仍完整（台账里已注明这与 R28-03 同型，是纵深防御的正常形态）。**⑥ 对外视图只有 `smtpView()`**：它是唯一出口，任何路由都不得把 `cfg.smtp` 直接回传（与 `captcha` 同一套规矩）；`configured` 只要求「有主机 + 有发件人」，因为无认证中继也是合法配置。**⑦ 测试邮件不受 `enabled` 限制**（管理员手动触发的一次性动作）。 |
| R54 | 用户提出的四项中的第一项（非审计轮，需求原文）：「在『用户设置』上方新增『站点设置』。该功能默认开启，因此无需启用 / 关闭开关。1、站点名称：用于显示在浏览器标题栏、邮件发信中，默认为『Kepler 对象存储管理系统』；2、公开注册：用于决定登录页是否可以注册新用户（公开注册：可随意注册用户；邀请码：注册时必须填写邀请码；关闭注册：不开放注册，需要管理员添加用户）；3、新用户身份：新注册的用户直接赋予的权限，默认为『普通用户』……此次改动相当大，可以拆成几次完成。如：先完成『站点设置』卡片，再做注册、忘记密码页，最后再处理邀请码系统。」（2.1~2.6 的登录页注册 / 记住密码 / 忘记密码 / 邮箱验证码与第 4 项邀请码系统按用户确认的**三步走**拆到后续两轮） | 1 个新路由模块（`server/routes/site.js`，三条接口）+ 配置段落 `config-store.site`（`normalizeSiteInto()` 为**唯一归一化实现点**，四处调用）+ `limits.js` 新增站点名称 / 注册模式 / 新用户身份三层判据 + 系统设置页一张**管理员专属**卡片（`#sysset-site-card`，位于「用户管理」**之上**、**无启用开关**）+ **22 条行为护栏**（`tests/audit54-regressions.test.js`）+ **13 条反向对照**（`R54-01a`~`R54-07b`，逐条实跑并核对**失败名单**，台账 619 → **632**）；**第②步**（登录页注册 / 记住密码 / 忘记密码 + 邮箱验证码体系，覆盖需求 2.1~2.6）：1 个新模块（`server/email-code.js`，验证码签发 / 核销 / 发信唯一实现点）+ 四条新路由（`POST /auth/register` / `POST /auth/forgot` / `POST /auth/reset` 进匿名白名单 `PUBLIC_API` 6 → 9 条；`POST /auth/email/code` 需登录）+ `limits.js` 邮箱判据层（`parseEmailInput` / `normalizeEmail`）+ `config-store` 的邮箱字段与查重（`assertEmailFree` / `findUserByIdentifier` / `userView.email`）+ 登录页四态遮罩（`login` / `init` / `register` / `forgot`）+ **30 条行为护栏**（`tests/audit54b-regressions.test.js`）+ **22 条反向对照**（`R54b-01a`~`R54b-08c`，逐条实跑并核对**失败名单**，台账 632 → **654**）；**第③步**（邀请码系统，覆盖需求第 4 / 4.1 项，外加用户追加的「管理员可批量导出邀请码，文件格式为 txt，一行一个」）：1 个新存储模块（`server/invite-store.js`，生成 / 核销 / 回滚 / 批量设置 / 删除 / 导出为纯文本的**唯一实现点**）+ 1 个新路由模块（`server/routes/invite.js`，六条**全部** `requireAdmin`，且三条字面量路径排在 `PUT /invites/:id` 之前）+ `limits.js` 邀请码判据层（归一化 / 格式 / 数量 / 次数上限 / 过期时间 / 备注共 6 个函数）+ `side-foot` 新入口与整页（`public/js/invitemgr.js`，`public/js` 30 → **31**）+ 登录页邀请码输入框（仅 `invite` 模式的注册形态出现）+ **24 条行为护栏**（`tests/audit54c-regressions.test.js`）+ **33 条反向对照**（`R54c-01a`~`R54c-05f-c`，逐条实跑并核对**失败名单**，台账 654 → **687**）；版本 `1.7.6` → `1.7.9` | **① 权限刻意分两级**：`GET /site/info` **公开**（登录页在拿到会话之前就要设浏览器标题栏），`GET/PUT /site/config` **仅管理员**；这是 `PUBLIC_API` 匿名白名单第一次为「页面外观」而不是「认证流程」开口子，故两条反向对照分别钉住「公开的那条万一被挂上 `requireAdmin`」与「忘记登记进白名单」。**② 默认注册模式必须是 `closed`**：本版本之前系统**没有注册入口**，默认成 `open` / `invite` 等于升级即悄悄开放了一个谁都能进来的注册通道 —— 这是本卡片唯一一个「默认值本身就是安全属性」的字段。**③ 站点名称的默认值必须与 `public/index.html` 的静态 `<title>` 同文**：`applySiteName()` 拿不到接口时不写标题，此时显示的就是那句静态 `<title>`；两者一旦不同文，用户会看到「刚打开是一个名字、登录后又变一个」而全程没有任何报错。**④ 站点名称与 SMTP 发件人显示名是两个不同功能的字段**：`limits.js` 里 `SITE_NAME_MAX` 与 `SMTP_NAME_MAX` 同为 128 却**刻意各留一份常量**，共用一个时给其中一个放宽就会让另一个跟着动，而那种连动没有任何理由。**⑤ `/site/info` 只回 `ok` + `siteName` 两个字段**：匿名可达的接口多回一个字段就是把配置面暴露给未登录的人，判据写成**键集合的精确相等**而不是「至少包含」。**⑥ 本轮最容易顺手改坏别处的是「纯位置声明」**：`ADMIN_ONLY_CARDS` 插入新成员与 `safeView()` 插入 `site:` 行两处，**同时打坏了 4 条既有反向对照的 anchor**（`R41-02k` / `R48-04a` / `R53-04a` / `R53-09a`）—— `invariants.test.js` 一跑就报「命中失效 anchor」，这正是那条兜网存在的意义；顺手还纠正了 `R41-02k` 一处 R53 遗留的**判据错位**（anchor 顺着往后挪了一行，于是它判的已经不是它声称要判的那一行）。**⑦ 归一化只补结构、不拒绝非法值**：入参非法由路由层**显式 400**，落盘路径遇脏值则静默补齐 —— 配置文件可能被手工编辑或来自老版本，落盘时把它整份拒掉只会让人连界面都进不去。**⑧ 第②步的五条口径（见 `audit54b-regressions.test.js` 那一行的详述）**：其一，**`/auth/forgot` 必须「恒真」** —— 它在匿名白名单里，回「该账号不存在」等于白送一个账号枚举器，故发信失败与冷却命中都只记日志、响应一字不变；而需登录的 `/auth/email/code` 则**如实回 429 + `Retry-After`**。其二，**改邮箱要两道证明**（验证码证明「这个地址归我」、当前密码证明「是我」），缺前者会手滑把重置渠道白送，缺后者会在会话被劫持时被永久接管。其三，**`req.authUser` 没有 `email`**（只有 `{id, username, role, permissions}`），取当前邮箱必须走 `configStore.findUserRawById(me.id)` —— 这是本轮真 HTTP 护栏抓到的**生产 bug**（`alreadyBound` 分支写 `normalizeEmail(me.email)` 恒 `undefined`、永不命中）。其四，**管理员设置 / 修改的邮箱视为「已验证」**，不设 `emailVerified` 字段：管理员本就能重置任何人的密码，标记未验证只会形成死锁。其五，**验证码只存 `sha256` 哈希**、比对走 `timingSafeEqual`；`server/email-code.js` 刻意**不含任何 require**（`limits.js` 是「零 require 叶子模块」，它的破环职责不能被破坏），键构造函数也因此叫 `codeKey` 而非 `keyOf` —— `invariants.test.js` 的缓存键护栏用 `/\bkeyOf\s*\(/g` 扫全库、会误伤任何同名函数，改护栏放行等于给它开一个洞。**第③步（邀请码系统）的五个取舍**：其一，**导出刻意用 POST 而不是 GET**：响应体是**明文邀请码集合**（与 `GET /backup/code` 同级），而 GET 的完整 URL 会进浏览器历史 / `Referer` / 反向代理的 access log —— 一个「导出全部」的 GET 等于把整批口令写进至少三处日志；代价是前端不能靠 `<a href>` 直接下载（发不出 CSRF 头），故 `api.js` 新增 `requestText()`（用 `res.text()` 而不是 `res.json()`）并由 `invitemgr.js` 自己造 Blob。其二，**注册的先后顺序本身就是安全性质**：限流 → 注册模式 → 邀请码**格式** → 两次密码一致 → 人机验证 → **核销** → 建号；「格式错（抄错一位）」当场 400 说清楚，而「这枚码是否存在 / 是否已用尽」必须等**人机验证之后**才回答 —— 否则这个限流只有 10 次 / 10 分钟的匿名端点会变成一条**邀请码存在性 oracle**（与 R21-05 收敛登录分支、`/auth/forgot` 响应恒真是同一个判据）。其三，**未给出的字段一律「不修改」**：`buildPatch` / `applyPatch` 只认 `!== undefined` —— `disabled:false`（重新启用）、`maxUses:0`（改成不限制）、`expiresAt:null`（改成永久）**全是合法值**，用真值判断会让这三个动作**静默失效而界面显示成功**；界面上则必须有显式的「不修改」档位，不能拿「空即默认」表达（那会把「改成永久」读成「不修改」）。其四，**「次数用尽」是可逆状态、不落字段**：把 `maxUses` 调大那枚码立刻复活，故只存 `maxUses` / `used`，状态由 `status()` 现算，且顺序固定为 `disabled → expired → used_up → active`（**停用排最前** —— 它是管理员刚做过的显式动作，排在后面会让「已停用且已用尽」显示成「已用尽」，管理员去调配额却发现仍然注册不了）；这与链接管理里 `removeDead()` 刻意不删 `exhausted` 记录同源。其五，**生成与核销两端各有硬约束**：邀请码用 `crypto.randomInt` **逐位**取值（`Math.random` 的内部状态可由少量输出反推 ⇒ 同一进程后续**所有**校验码都可预测；逐位取值同时规避取模偏差），核销**不删记录**（否则「我发出去的这批码用掉了哪些」无从查），而建号失败时 `rollback` 只归还**最后一个与本用户名相同**的那一条（`addUser()` 内部有 scrypt 的 await，期间别的请求可能追加了自己的名字，直接 `pop()` 会删错人 —— 而 `used` 计数仍然正确，症状极轻微）。此外，`invite-store` 的落盘走**同步** `secureStore.writeJson` 而**刻意不学** `share-store` 的 `writeJsonAsync`：`disabled` 与 `remove()` 是**吊销**语义，异步写会在进程重启 / 崩溃时丢掉队列里尚未 flush 的那一次，表现是「点了停用、重启后那枚码又活了」。 |
| R55 | 用户报告的一项（非审计轮，**同一发布包内的缺陷修复**，R55；原话：「修复SMTP问题：即使用户名、密码等配置正确，仍无法正常发信。」）。同一发布包内用户又追加了两项：**「修复（三）中的两个发现」**（① 发信设置的启用开关只落盘、不影响服务端行为；② 开发文档目录树里 audit53 一行被机械编辑剥空了行内代码）与**「检查部署脚本在换仓库 / 换账号后是否还能正常使用」** | 1 条修复（新增 `config-store.smtpSendConfig()` 作为发信路径**唯一**取用入口 + `smtpConfigured()` 唯一判据；`server/email-code.js` / `server/routes/smtp.js` 改走该入口）+ **4 条行为护栏**（并入 `tests/audit53-regressions.test.js` 的新第 ⑨ 层）**+ 5 条启用开关护栏**（同文件的新第 ⑩ 层；该文件 32 → **41 条**）+ **4 条反向对照**（`R53-10a`~`R53-10d` + `R53-11a`~`R53-11b`）与**部署侧 1 条**（`D1-24`，并新增 1 条部署脚本护栏），逐条实跑并核对**失败名单**，台账 687 → **694**；另修复 `Develop_Document.md` 目录树中 audit53 一行被机械编辑剥空的行内代码。**版本号 `1.7.9` → `1.8.1`**（用户要求：本轮起恢复「展示版本号 + 简述修改内容」的提交信息，不再使用 `Inherit Release`） | **① 根因是「把对外视图当内部配置用了」**：`smtpView()` 为保密把口令裁成 `hasPassword` 布尔值，而 `server/email-code.js`（验证码签发 / 核销 / 发信的**唯一实现点**）错拿它去发信 ⇒ `password` 恒为 `undefined` ⇒ `smtp.validateForSend()` 判 400「已填写登录用户名但密码为空」。**只要管理员填了登录用户名**（真实 SMTP 服务器几乎都要求认证），登录页的「发送验证码」与「忘记密码」**一封也发不出去**。**② 症状两极分化，是最难从现象反推根因的一类故障**：管理员手点的「发送测试邮件」走含口令的内部读（`getSmtp()`）、**照样成功** —— 同一份落盘配置、两个读法，用户看到的是「用户名密码都填对了，却发不了信」。故 R53 既有的「真跑一次 SMTP 会话」全绿**挡不住它**：⑥⑦ 两层跑的都是测试邮件那条路径。**③ 修法是收敛取用点，而不是改一处调用**：新增 `smtpSendConfig()` 作为发信路径**唯一**取用入口（明文口令 + `configured` 判据一次给全），`configured` 抽成 `smtpConfigured()` 纯函数供「对外视图」与「发信端」共用；两处各写一遍 `host && from` 时，一旦语义分叉就会表现成「路由放行并回『验证码已发送』，而发信端抛 503」，或反过来「界面显示未配置、实际能发」。**④ 护栏必须落在「假服务器实际收到的 AUTH 载荷」上**：⑨ 层先落盘一份口令 → 真连一个**要求认证**的假 SMTP（沿用 `TLS-PSK` 免证书）→ 断言 `AUTH PLAIN` 载荷就是那份口令、且验证码真的进了 DATA 正文；再走一次匿名 HTTP `POST /auth/forgot`，把「路由 → `email-code.js` → `smtp.js`」整条链路串起来（该路径全程没有会话身份，口令只可能来自落盘配置）。只断言「源码里有 `smtpSendConfig` 这个词」是钉不住它的 —— 那正是假绿的标本。**⑤ 一条反向对照首跑是假绿**：`R53-10c`（判据分叉）第一版补丁只改一个字段，第二轮继承了上一轮已被清掉的字段 ⇒ 两组输入塌成同一种，变异打不出来（`fail=0`）；改成两组都把 `host` / `from` 写全才红 —— 「红的是不是本条」与「**应该红几条**」必须一起问。**⑥ 启用开关必须落在「系统发信」这条路径上**：`enabled` 原先只落盘、不拦任何服务端行为。口径经确认是「**停用 = 系统自动发信一律不发**，管理员手点的测试邮件不受限制」—— 故闸门只能加在 `email-code.js`（系统发信的**唯一**实现点），**不能**折进 `smtpConfigured()`：后者回答的是「配没配」，折进去会让卡片在停用后显示成「未配置」（配置其实还在）并顺手把测试邮件一起停掉。判据要落在「假服务器收到几行命令」上 —— 只断言「抛了错」是钉不住「有没有偷偷发出去」的；且必须有**正向对照**（同一份配置启用即照常发），否则「一律拒绝」也能全绿。**⑦ 「老安装机重装不了」的根因在状态文件、不在脚本**：`/etc/kepler/deploy.conf` 存着当年的 `REPO_URL`，而 `load_state()` 的回读优先级**高于**脚本内置的 `DEFAULT_REPO_URL`；旧仓库随账号迁移后已 404，于是重装时 `git clone` 打到一个死地址 —— 而重装走的又是安装目录里那份脚本，它的头注释已指向新地址，用户更难联想到是状态文件里的旧值。修法是**只迁移「恰好等于历史默认值」的地址**（用户自建 fork / 自托管镜像原样保留），且显式 `--repo` / 环境变量仍在 `load_state` **之后**应用、永远优先。**⑧ 「检查文档」也能查出真缺陷**：机械编辑剥空行内代码后 Markdown 照样渲染、docs-sync 也全绿（它校验的是文件名与计数，不是正文质量），只有逐字读才发现 —— 这类「静默内容损坏」只能靠与**同文的另一处副本**对照（本行与「六、审计发现台账」里 R53 那一段本应是同一份笔记）。 |
| R56 | 用户提出的三项（非审计轮，R56；原话：「先推进版本号至1.8.1，本次及之后的提交均正常推送（不再标记为Inherit Release，而是和之前一样展示版本号、简述修改内容）；再将SMTP和站点配置也纳入「备份配置」备份的条目，并说明「邀请码部分不备份，因为邀请码条数可能过多。」然后再推进版本号至1.8.2，再推送。」） | ① **版本推进**：`1.7.9` → `1.8.1`（五个落点全量同步）并**按新约定推送**（提交信息 = 版本号 + 变更简述，不再用 `Inherit Release`）；② **备份范围扩展**：`server/backup.js` 的 `SCOPES` 8 → **10** 项（末尾追加「发信设置」「站点设置」）、`SECTIONS` 7 → **9** 分区，`collect()` / `apply()` 各补两段，`isEmptyData()` 补两条判据；`server/config-store.js` 新增 `smtpIsDefault()` / `siteIsDefault()` 作为「这一段是否仍是默认值」的**唯一**判据；③ 界面与文档写明「**邀请码不备份，因为邀请码条数可能过多**」（`public/index.html` 新增一条说明、`public/js/backupcfg.js` 的导出对话框同步）；④ `tests/audit38-regressions.test.js` 31 → **37 条**（新增 6 条 `R55-01`~`R55-05`）+ **7 条反向对照**（`R55-B1`~`R55-B7`，逐条实跑并核对**失败名单**，台账 694 → **701**）；⑤ **版本推进**：`1.8.1` → `1.8.2` 并推送 | **① 「并入备份」的真正难点不是多加两行，而是「空判据」**：`isEmptyData()` 回答的是「这台实例是不是全新」，写法一直是「逐分区看有没有值」—— 但发信设置的 `secure` 缺省**跟随端口**（465 → `true`），于是**全新实例**的 `collect()` 里 `secure` 就是 `true`；照抄「有值就算配过」会把任何一台机器都判成「已配置」，`canImport()` 从此恒为 `false`（导入窗口一出生就是关着的，且没有任何报错）。站点设置更极端：它的默认值**本身就是非空的**（站点名有默认名、注册模式默认 `closed`、身份默认 `user`）。故判据改成「**归一化之后是否等于「把空对象归一化」的结果**」（`smtpIsDefault()` / `siteIsDefault()`），把默认值的定义权唯一留在 `normalizeSmtpInto()` / `normalizeSiteInto()` 里 —— 哪天默认端口或推导规则改了，判据自动跟上。**② 「改回默认值」必须等于「从没改过」**：否则「站点名留空 → 保存」（界面上就是「恢复默认名」）会静默把导入窗口永久关上；护栏里专门有一条把站点设置**显式写成默认值**并要求判为空。**③ 两段新分区的口令处理刻意不同**：WebDAV 账户口令在 `config.enc` 里是**字段级密封**（绑定本实例的 `data/secret.key`），故必须「导出取明文、导入按目标实例重封」；SMTP 口令本就是**明文字段**（靠整文件加密保护），换实例无需重封 —— 两者现象相似、理由不同，注释里写明以免后人「顺手统一」。**④ 导入是覆盖而不是合并**：`saveSmtp()` 的口令是**三态**的（省略 / 空串 = 保持不变、`null` = 显式清除），把载荷里的空口令原样传进去会变成「保持不变」⇒ 目标实例的旧口令被留下（「导入即恢复」退化成「导入后仍用着上一台的凭据」，界面上完全看不出来），故导入侧显式把空口令传成 `null`。**⑤ 一条既有反向对照被本轮改「老化」**：`R38-02c` 的锚点取的是 `ipguard` 块**加上紧随的 `};`（`collect()` 的收尾）**，而 R55 在 ipguard 之后追加了两段 ⇒ 那条 `};` 不再紧跟其后，锚点失效。`invariants.test.js` 的「anchor 必须在各自的 file 内命中」一跑就报出来（这正是那条兜网存在的意义），改为只锚 `ipguard` 块本身即可。**⑥ 「新增条目的顺序」是个容易忽略的契约**：新增项一律追加在**末尾**，因为 `SCOPES` 的顺序同时是界面清单顺序与 `GET /backup/status` 的下发顺序 —— 插在中间会让「本轮到底动了哪几项」在界面上看不出来。**⑦ 邀请码为什么不备份**：它不是「不想备」，而是**条数不可控** —— 一次可批量生成 500 枚、且核销**不删记录**（否则「发出去的这批码用掉了哪些」无从查起），条数只增不减；随备份走既会把备份撑到 `express.json` 的 2MB 上限（与分享链接 / 订单同一个理由），也会让「备份」这个动作变成一次口令集的分发。这条说明是用户**点名要写**的交付物，故除了代码排除之外还专门有一条护栏盯着界面上的那句话。 |
| R57 | 用户提出的三项（非审计轮，R57；原话：「继续修复SMTP问题：登陆用户名、密码、SMTP 服务器地址、端口全部正确，但仍无法发信。另修复找回密码流程的漏洞和问题：1、重置密码页面，div标签显示「用户名或邮箱」，但下方编辑框的提示词却是「请输入用户名」，两处语义不一致会导致用户困惑，使其同步；2、点击「发送验证码」会提示「未登录或会话已过期，请重新登录」；3、点击「发送验证码」，即使发送失败也会立即进入重设密码的窗口，修复它；4、重设密码的窗口没有「重新发送验证码」，添加它，并设为「60 秒后可重新发送」。5、推进版本号至1.8.3并推送至GitHub。」） | ① **系统发信的第二例失败**（与 `[1.7.9]` 表象相同、根因不同）：`server/smtp.js` 新增 `verify()` 并把「连接 → EHLO → STARTTLS → AUTH」抽成与 `sendMail()` **共用**的 `withSession(o, fn)`；`server/email-code.js` 新增 `mailerGate()` / `mailerState()` / `probeMailer()`，取配置收口成全库唯一一处；`server/routes/auth.js` 的 `/auth/forgot` 在**限流之后、读取标识之前**插入站点级闸门（`await emailCode.probeMailer()`，失败如实 `503`）；② `public/js/api.js` 的 `WRITE_EXEMPT` 补登登录前三条匿名端点（`/auth/register` / `/auth/forgot` / `/auth/reset`）；③ `public/js/main.js` 四处（`placeholder` 按形态同步、`forgotStep` 只在 `try` 的成功分支推进、`#btn-auth-resend` 的接线与 `startResendCountdown` / `renderResendBtn` / `stopResendCountdown`、离开忘记密码形态时叫停倒计时）+ `public/index.html` 的 `.code-line` 与重发按钮；④ **12 条新护栏**（`tests/audit53-regressions.test.js` 41 → **45 条**，新增第 ⑪ 站点级探针层 `R57-01`~`R57-04`；`tests/audit47-regressions.test.js` 20 → **21 条**，新增 `R57-05a`；`tests/audit54b-regressions.test.js` 30 → **33 条**，新增第 ⑧ 层 `R57-06`~`R57-08`）+ **8 条反向对照**（`R57-01a`~`R57-08a`，逐条实跑并核对**失败名单**，台账 701 → **709**；另把 `R53-10a` / `R53-11a` 的锚点迁到 R57 的新形状）；⑤ **版本推进**：`1.8.2` → `1.8.3`（五个落点全量同步）并推送 | **① 「发不出信」有两类根因，第二类藏在一句正确的口径后面**：`[1.7.9]` 修的是「口令被对外视图裁空」，修好之后口令确实带上了，剩下的失败就只剩**连接 / 认证本身**；而 `/auth/forgot` 的**恒真 200**（防账户枚举，正确且必须保留）把这类失败一并吞掉 ⇒ 用户手上没有任何线索。修法不是「按标识如实报错」（那会重新打开 oracle），而是把失败里**与标识无关**的部分**提前探出来** —— 「配没配 / 开没开 / 连得上吗」对任意标识都是**同一句回答**。**② 判据是「闸门的位置」，不是「有没有闸门」**：探针必须在**读取标识之前**执行（`R57-03` 钉死顺序），否则响应又随标识而变；这条与「命中与否一律静默」并不矛盾 —— 二者回答的是两个不同的问题。**③ 探针必须与真发信共用同一条会话路径**：`withSession()` 抽出后 `verify()` 与 `sendMail()` 只差最后一步动作；若各写一份，「探针报健康而真发信仍发不出」就会成为下一次工单。**④ 假 401 的根因在**前端**、且症状与真实故障恰好指向相反方向**：请求本身**成功**，界面却弹「未登录或会话已过期」（那是同步请求 `GET /api/config` 的 401），而流程还照常推进 —— 用户只会说「发送失败却放行了」。判据落在「这三条匿名端点不得触发界面同步」上，且用例**先自证**「普通写请求确实会通知一次」，否则「什么都不通知」也能让断言全绿。**⑤ 「发送失败却进入下一步」是双半问题**：服务端要**如实回错**（否则前端根本进不到 `catch`），前端要**只在 `try` 的成功分支推进步号**（推进写在 `finally` 或无条件写在请求之后就必错）。两半缺一，现象仍在。**⑥ 同一输入框在四种形态里是同一个元素**：`placeholder` 必须按形态改写而不是写死在 HTML 上，否则必然在别的形态（登录 / 初始化 / 注册）下说错话；同理，重发按钮的倒计时必须在**离开忘记密码形态时叫停**，否则定时器会在别的形态下空转、再进来时挂着上一次的剩余秒数。**⑦ 反向对照会随「修复形状」老化**：R57 把取配置收口进 `mailerState()`、把闸门改成返回 `{status, error}`，`R53-10a` / `R53-11a` 的旧锚点随之失效 —— 失效不报错，只会在跑到那一条时才说「anchor 未命中」，故必须**随语义改形状**（`invariants.test.js` 的 anchor 命中检查是这条兜网）。 |
| R58 | 用户报告的**两项**（非审计轮，R58；承接 R57 的发信修复，原话：「SMTP：QQ 邮箱仍提示失败，重置密码页提示：系统发信当前不可用：连接 SMTP 服务器 smtp.qq.com:465 失败（建连）：AggregateError。使用非 QQ 邮箱，卡死在“正在连接 SMTP 服务器并发送”，重置密码页卡死在“发送中”」） | ① **建连无超时**：`server/smtp.js` 新增 `awaitSocketEvent(sock, okEvents, o, when)`（显式定时器兜住整段建连，`connect` / `secureConnect` / `error` / 超时四条出口，到点即销毁套接字并抛 `connTimeoutError()`），`connect()` 与 `_starttls()` 都改走它；`withSession()` 把 `await s.connect()` **移入 `try`**（原先在建连失败时绕过 `finally` 的 `quit()` ⇒ 套接字泄漏）；② **零信息文案**：`wrapConnError()` 拆开 `AggregateError.errors[]`，输出「N 个地址全部不可达 —— [地址] 错误码、…」+ 按错误码附`CONN_HINT`可执行提示（`hintFor()`），并给错误对象加 `connCodes`；③ **3 条新护栏**（`tests/audit53-regressions.test.js` 45 → **48 条**，新增第 ⑫ 建连截止层 `R57-09`~`R57-11`）+ **2 条反向对照**（`R57-09a` / `R57-10a`，台账 709 → **711**）；④ **版本推进**：`1.8.3` → `1.8.4`（五个落点全量同步）并推送 | **① 两个症状、一个缺口**：「报 AggregateError」与「永久卡住」看起来是两件事，其实是**同一个缺口** —— 建连阶段（DNS → TCP SYN → TLS 握手）**没有任何失败出口**。**② `socket.setTimeout()` 管不到建连**：它计的是**已建立连接上的「无活动」**，且原实现要到 `_bindLongLived()`（`connect` 事件之后）才装上 ⇒ 对端把数据包**丢弃**（而非拒绝）时 Promise **永不 settle**（实测黑洞地址 `10.255.255.1:465` 8 秒内**零事件**，真实 SYN 重传约 130 秒）⇒ 界面卡死。**③ `AggregateError` 是 Node 20 的行为**：`autoSelectFamily` 默认开启，域名解析出多地址而**全部**连不上时抛它，其 `message` 是**空串**、真实原因在 `.errors[]`（每条含 `code` / `address`）⇒ 取 `e.message` 得到工单原文那句零信息文案。**④ 建连必须显式查`黑名单`**：超时后**不销毁套接字**的话每次失败泄漏一条连接（故 `awaitSocketEvent` 的 `fail` 分支带 `destroy()`）；而 `withSession` 的 `connect()` 也必须在 `try` 内，否则超时路径同样漏掉 `quit()`。**⑤ 「一律立刻拒绝」也能让前两条全绿** ⇒ 必须有**正向对照**（`R57-11`：调大超时后真实 `127.0.0.1` 假服务器会话仍成功）。**⑥ 反向对照的「挂住型」变异要认出来**：`R57-09a` 退回裸 `once` 后 R57-09 直接**挂住**（报数器记 `cancelled` 而非 `not ok`），跑者取消其同批兄弟 R57-10 / R57-11，R57-02 被留在变异态的 `net` 桩带红（`# fail 1` + `# cancelled 3`）—— 判红看的是「`cancelled` 里出现了 R57-09」，**不能**按 `not ok` 行数（4）填 `minFail`。**⑦ 试做的一版 `_cmd` 前置判据被实测否掉**：以为 `sock.write` 对已关闭套接字「同步抛」`ERR_SOCKET_CLOSED`，写了防护 + 护栏 + 反向对照，实测 `fail=0`（真相：`write` 只**异步** emit `error`，从不同步抛；且 `quit()` 的 try/catch 早已吞掉它）⇒ **整体撤回**，不留无用代码（`fail=0` 就是护栏打在了不存在的路径上）。**⑧ 本机取证**：本机可正常连 `smtp.qq.com:465`（133ms）与 `:587`（39ms），DNS 解析出 `183.47.120.204` / `183.47.101.192` ⇒ 用户故障在**实际服务器侧网络**（防火墙 / 云安全组拦 465，或无 IPv6 出口导致 `ENETUNREACH`）；修复后用户将看到**逐地址原因 + 可执行提示（含「改用 587」建议）**，而不再零信息 / 永久卡死。 |
| R59 | 用户报告的**两个安装故障**（非审计轮，R59；承接 R58，原话要点：① CentOS 首次安装必定提示安装 Node 失败 —— 报错已给出能直接成功的 NodeSource 方案（下载并执行 setup_20.x 后 `dnf install -y nodejs --allowerasing`），但 CentOS 8 已停止维护（EOL）致官方源整体下线、dnf 装不上；② GitHub 仓库可能因网络原因无法拉取） | ① **deploy.sh 两处修复**：新增 `centos_eol_repo()`（只在已 EOL 的 CentOS 7/8、非 Stream 上为真）、`centos_vault_hints()`（阿里云 Vault 归档源三步：curl 取源 / `clean all` + `makecache` / NodeSource + `dnf --allowerasing`）+ 迁移建议（Rocky / Alma / CentOS Stream）；`node_eol_hints()` 接入 `install_node` 三失败出口，并在 NodeSource【A】分支就地提示「CentOS EOL 改用 Vault」；新增 `MIRROR_REPO_URL="https://gitee.com/xing_sen/kepler"`，`prepare_source()` 在默认仓库克隆失败时**自动改用 Gitee 镜像重试**（`REPO_URL == DEFAULT_REPO_URL` 门控）+ 失败提示给出手动 `--repo` 重跑命令；② **3 条行为护栏**（`tests/deploy-script.test.js` 45 → **48 条**）+ **3 条反向对照**（`R59-01a` / `R59-02a` / `R59-03a`，台账 711 → **714**）；③ **版本推进**：`1.8.4` → `1.8.5`（五个落点全量同步）并推送 | **① 定性：不是网络、不是 NodeSource 的错，是 CentOS 官方源整体下线**（EOL）。CentOS 7/8 的 mirrorlist 与镜像站元数据已撤 ⇒ `dnf install` 取不到包；正解是换 Vault 归档源（阿里云 `Centos-vault-<主版本>.repo`）+ 迁移建议，并在【A】旁边就地提示（门控，不影响 Rocky / Alma / Stream）。**② 判据必须避开「只认字面量那一行」的假绿**：`centos_vault_hints` 文案里若写 `mirrorlist.centos.org` 域名，会被既有护栏「`codeOnly()` 后不得含该域名」满足而误判（提示文案也算被测代码）⇒ 改写成「镜像列表 mirrorlist 与镜像站 mirror」。**③ 反向对照的「护栏比名字弱」标本**：`MIRROR_REPO_URL` 在 `prepare_source` 出现**两处**（自动重试行 + 失败提示行），只撤前者时 `/MIRROR_REPO_URL/` 仍被后者满足 ⇒ 首版 `fail=0`；须**两步同撤**且判据落在**执行的那一行**（`git clone --depth 1 "$MIRROR_REPO_URL"`）。**④ Gitee 重试必须门控** `REPO_URL == DEFAULT_REPO_URL`（用户显式 `--repo` 时不覆盖其意图），且失败提示里的手动重跑命令必须**真的用镜像地址**。**⑤ 三处反向对照逐条实跑确认 `fail=1`**：R59-01a（撤 `centos_eol_repo` 的 EOL 判定）、R59-02a（撤 Vault 指引的「清理并重建缓存」两步）、R59-03a（两步同撤镜像重试）。 |
| R60 | 用户报告的一项（非审计轮，R60；原话：「修改部署脚本 deploy.sh：SSL证书部署部分，acme.sh 使用 GitHub官方镜像，这可能导致因网络原因无法部署，应改为使用国内镜像。」） | ① **deploy.sh**：`install_acme_sh()` 的下载顺序由「官方源优先 + Gitee 兜底」改为**国内镜像优先**（`https://gitee.com/neilpang/acme.sh/raw/master/acme.sh`，acme.sh 作者 neilpang 维护的官方仓库镜像），GitHub `raw.githubusercontent.com` 降为兜底；新增 `VER=` 内容校验（与首行 shebang、`bash -n` 合为三重校验）；`acme_failure_hints()` 措辞同步为「国内镜像优先」；② **1 条行为护栏**（`tests/deploy-script.test.js` 48 → **49 条**：静态断言「第一个下载地址是国内镜像」+ 假 curl 记录实际请求序列）；③ **1 条反向对照**（`R60-01a`，双步 mutations 换回官方优先，台账 714 → **715**）；④ **版本推进**：`1.8.5` → `1.8.6`（五个落点全量同步）并推送 | **① 根因是「顺序」而不是「镜像不可用」**：Gitee 镜像一直是通的，但被放在 `else` 分支里，首个 `curl` 仍打向 `raw.githubusercontent.com` ⇒ 国内服务器每次部署先白等一个 `--connect-timeout 15`（丢包时更久），甚至直接失败；**只把 URL 换位置、不改顺序等于没改**。**② 判据必须落在「第一个被执行的下载地址」**：只断言「`gitee` 出现过」会被兜底分支满足 ⇒ 假绿；故用假 `curl` 记录**实际请求序列**，并要求「镜像成功时不得再请求 GitHub」。**③ 探针两处环境坑**：Git-Bash 的 `mktemp -d` 返回 Windows 路径，直接塞进 `PATH` 会被 `:` 按盘符拆开（假 curl 永远轮不到、退化成真实 curl 白等 15s）⇒ 先 `cygpath -u` 归一化；`LOG_FILE` 是 readonly 且指向不可写的 `/var/log`，`run` 的重定向会在**执行命令之前**失败（命令根本没跑）⇒ 只替换日志包装层 `run()`，被测下载分支原样执行。**④ 反向对照用缩进区分主/兜底两行**（7 空格 vs 9 空格）：否则 9 空格行包含「7 空格 + URL」子串，`replace` 只替首处 ⇒ 两步互相抵消、`fail=0`。 |
| R61 | 用户报告的一项（非审计轮，R61；原话：「SMTP再次出错，报错提示：发送失败：网络连接异常，请检查网络后重试」） | ① **server/smtp.js**：新增 `markUserFacing()`，并在 `withSession()`（`sendMail()` 与 `verify()` **共同**的错误出口）统一给无 `status` 的错误盖上 `status = 500`；② **1 条行为护栏**（`tests/audit53-regressions.test.js` 48 → **49 条**，新增第 ⑬ 用户文案层 `R61-01`：真实 HTTP 向 `127.0.0.1:1` 发测试邮件，断言响应体点名主机与错误码、且不含「网络连接异常」）；③ **1 条反向对照**（`R61-01a` 撤掉盖戳那一步，台账 715 → **716**）；④ **版本推进**：`1.8.6` → `1.8.7`（五个落点全量同步）并推送 | **① 那句话不是 SMTP 说的**：全库只有 `server/s3.js` 的 `translateError()` 会产出「网络连接异常，请检查网络后重试」。链路是 `smtp.sendMail()` 抛出的连接错误**没有 `status`** ⇒ `apiHandler` 判 `e.status ? e : translateError(e)` ⇒ 落进**对象存储**的翻译层 ⇒ 正则命中 `ETIMEDOUT / ECONNRESET / ENOTFOUND …` ⇒ 整段替换。**② R58 刚做的详细诊断被这一层吃掉了**：R58 已经把「哪个地址、几个地址全部不可达、各自什么码、该改端口还是放行防火墙」拼好，但它在**到达界面之前**就被覆盖 —— 所以用户看到的是「和没修一样」。这正是「修在 A 层、被 B 层抹掉」的典型，**只看 smtp.js 永远查不出来**。**③ 修在唯一出口而不是每条 `throw`**：`withSession` 是 `sendMail` / `verify` 的共同边界，新增错误路径不会漏盖；`status` 取 500 与原先翻译层给出的状态码一致 ⇒ **只改文案、不改变 HTTP 语义**。**④ 判据落在真实 HTTP 响应体上**：`127.0.0.1:1` 必然 `ECONNREFUSED`（即时、不依赖外网），断言「点名主机 + 带错误码 + 不含网络连接异常」—— 而不是断言「smtp.js 里写了 status」（那只能证明写了，证明不了路由层真的用上）。**⑤ 反向对照用单行代码锚点**（`throw markUserFacing(e);` 全库唯一）：跨注释行的锚点在 `invariants` 的**双侧 `stripComments()`** 比对下会失配。 |
| R62 | 用户提出的**八项需求**（非审计轮，R62；原话：「当前 side-foot 中已有优惠券设置一栏，完成这个功能。1、用户可单独或批量生成优惠券；2、可设置优惠券类型限制：无门槛、限特定链接（可直接选择/搜索已有的付费链接）、限特定用户；3、可设置优惠券使用限制：次数（总次数、是否为每个用户只能使用一次）、时间（开始和到期时间）；4、付费链接分享页，应添加优惠券码填写处；5、使用优惠券，分享页的价格应如此显示：原价划线变灰，优惠后价格突出显示；6、优惠券无效则弹出相应提示；7、订单管理的付费订单页，应添加原价、应付、优惠、实付、使用的优惠券；8、订单管理的付费订单页：如果处理退款且该优惠券不是无门槛优惠券，则自动设置相应的优惠券为「对该用户可重新使用」。」） | ① 新增 `server/coupon-store.js`（生成 / 状态判定 / 适用范围 / 核销台账 / 按订单回退的**唯一实现点**）+ `server/routes/coupon.js`（五条，全部 `requireAdmin`）+ `public/js/couponmgr.js` + `#couponmgr` 页面与侧栏入口；② `limits.js` 新增券码 / 数量 / 金额 / 次数 / 时间 / 目标解析器（`normalizeCouponCode` 与 `parseCouponMaxUsesInput` **复用**邀请码实现，不写第二份）；③ 分享页：`POST /s/:id/coupon` + `payPage` 价格块（原价划线 + 优惠价）+ 券码 Cookie + 独立限流 `couponLimiter`；④ 下单：金额 / 原价 / 优惠 / 券码 / 券类型**快照**进订单，建单后核销、失败即回退；⑤ 订单页：新增原价 / 应付 / 优惠 / 实付 / 优惠券五列；⑥ 退款：非无门槛券按订单号 `releaseByOrder()` 回退；⑦ **15 条行为护栏**（`tests/coupon.test.js` 五层）+ **4 条反向对照**（`R62-01a`~`R62-04a`，台账 716 → **720**）+ `routes-surface` 登记五条新路由；⑧ **版本推进**：`1.8.7` → `1.8.8`（五个落点全量同步） | **① 「类型限制」是并列三选一，不是两个可叠加的开关**：把「限链接」与「限用户」做成可同时勾选，语义会变成「两者都要满足」，而界面上几乎必然被读成「任一满足」。故 `type` 单字段三值（`any` / `links` / `users`），非当前类型的目标集合在落盘归一化时清空。**② 优惠金额必须封顶到「原价 − 1 分」**：支付网关不接受 0 元订单，而「10 元券买 6 元文件」是极常见的配置。封顶后订单页「优惠」列显示的是**这张订单上真的减掉的钱**（299 分），而不是券面额（500 分）—— 否则会出现「原价 3 + 优惠 5 = 实付 0.01」这种对不上账的组合。`R62-01a` 撤掉封顶即变红。**③ 「每人一次」与「退款可重新使用」都需要**人**这个粒度的台账**：只记 `used` 总数，两个功能都无从实现。台账记 `{ identity, orderId, usedAt }`，退款按**订单号**回退（不是按身份 —— 同一用户可能用同一张券下过多笔订单，按身份删会把他其它订单的记录一并抹掉）。**④ 身份只能分两层**：已登录 → `u:<userId>`；未登录 → `a:<sha256(IP + UA)>`。这是刻意的近似，写明「换网络 / 换设备视为另一个人」；而「限特定用户」的券要求 `userId` 非空且命中名单，匿名访客必然被判 `wrong_user` 并提示登录。**⑤ 券码校验端点必须单独限流**：10 位券码是可枚举的折扣通道；但**不能**复用 `shareLimiter` —— 输错几次券码不该把「发起支付」的预算一起消耗掉。**⑥ 未成交要还券**：券在建单时核销（否则并发能下出多笔「每人一次」的券），因此 `siteUrlFor` 失败与网关 `createCharge` 失败两条分支都必须 `releaseByOrder()`，否则用户一次都没付成、券却已用尽。**⑦ 分享页券表单必须独立于支付表单**：HTML 不允许嵌套 `<form>`，浏览器会静默丢掉内层，表现是「点应用没反应」。**⑧ 一个自己踩过的判据坑**：新写的 `normalizeCouponCode` 与 `parseCouponMaxUsesInput` 一开始是照抄邀请码的，导致 `invariants` 的两条旧 anchor 在 `limits.js` 内**各出现 2 次**（`replace` 只替首处 ⇒ 变异可能打错行）。修法不是改 anchor，而是**复用**（`const normalizeCouponCode = normalizeInviteCode`）—— 同一判据本来就不该有第二份实现。 |
| R62b | 用户 UI 工单（R62 的追加，非审计轮，版本 `1.8.9`；原话：「付费链接界面异常：似乎是优惠券相关UI出错。优惠券输入的相关组件应这样处理：放置在『立即支付』的下方，默认折叠（显示为『使用优惠券』）。」+ 截图） | ① **分享页 `payPage`**：券码区从「价格与支付方式之间」移到**支付表单之后**（即「立即支付」下方），改用原生 `<details>` **默认折叠**成一行「使用优惠券」；只有「已选券 / 券无效」时才自动展开；券无效的提示也移进折叠区、紧跟输入框；② **CSS**：`.coupon-form .btn` 改为 `flex:0 0 auto; width:auto`，输入框 `flex:1 1 auto; min-width:0`；③ **1 条护栏**（`tests/coupon.test.js` 15 → **16 条**，`R62-16`）+ **1 条反向对照**（`R62-05a`，台账 720 → **721**）；④ **版本推进**：`1.8.8` → `1.8.9`（五个落点全量同步） | **① 截图里的「输入框一条缝」不是宽度没设，而是按钮抢空间**：`.btn` 的基础样式是 `display:block; width:100%`，在 `display:flex` 的券表单里，按钮以 100% basis 占满整行，输入框（`flex:1; min-width:0`）被合法地压到 0 —— 这类「两个都对、凑在一起就坏」的布局问题，只有在**同一条 flex 行**里才会暴露。**② 折叠用原生 `<details>/<summary>`**：分享页是服务端渲染，且 CSP 不允许内联脚本，原生折叠是这里唯一「零脚本且一定能用」的形态；不用 `hidden` + `onclick`（那需要脚本，且隐藏后无法键盘展开）。**③ 判据必须落在「渲染顺序」上**：`const couponBox = …` 定义在 `payPage` 之前，按文件位置比较会得出相反结论；故 `R62-16` 比较的是 body 模板里的**插槽** `${couponBox}` 与支付表单的先后。**④ 反向对照只改宽度**：`R62-05a` 把 `width:auto` 改回 `100%`，`fail=1` 且红的正是 `R62-16` —— 证明这条护栏真的打在「按钮与输入框抢空间」这个成因上。 |
| R64 | 用户提出的**三项需求**（非审计轮，R64；原话：「1、如果是需要付费的文件，且当前未登录账号，则在『文件分享』卡片的下方新增一个『恢复购买』的超链接标签；① 点击『恢复购买』，让用户输入订单号，如果订单号存在且可以与当前链接匹配，则允许其重新下载而无需再次付费；② 在整个页面的右上角新增『登录』；2、如果是需要付费的文件，且当前已登录账号，则……新增『查看历史订单』……① 可以查看自己已购买的全部订单，重新下载；② 其中也显示免费下载的文件，但只展示第一次下载的记录，重复下载不计；③ 页面右上角新增『退出登录』；3、完善订单号系统；① 当前订单号仅 16 位……修改订单号格式的建议：Unix 时间戳 + 链接 UID + 用户 UID + 随机字符串……总位数 36 位及以上（13 位毫秒级时间戳、9 位链接 UID、9 位用户 UID、5 位随机字符串）；② 不论是游客还是已登录用户，都向他们展示订单号、允许其复制，并告知『订单号是售后和取回下载权限的唯一凭证』……以上功能的所有前提建立在一件事上：该订单号的状态是『支付成功』。」） | ① 新增 `server/order-no.js`（订单号编解码**唯一实现点**：36 位 = 13 时间戳 + 9 链接 UID + 9 用户 UID + 5 随机串）+ `server/download-log.js`（免费下载台账：`(userId, linkId, fileKey)` 去重，只记首次）；② `payment-orders` 新增 `orderNo` / `linkUid` / `userUid` / `userId` / `userName` 快照与 `findByOrderNo()` / `listForUser()` / **`claimForLink()`**（恢复购买的唯一判定点）；③ `share-routes` 新增 `POST /s/:id/logout`、`GET\|POST /s/:id/restore`、`GET /s/:id/history` 与 `paidBelowHtml` / `orderNoBox` 两个渲染件、右上角 `.topbar`、`noteFreeDownloads()`（两处下载成功分支）；④ 新增 `public/js/share-order.js`（订单号一键复制，普通脚本）+ `main.js` 的 `takeShareNext()`；⑤ `security.js` 新增 `orderRestoreLimiter`（10 分钟 20 次）；⑥ **14 条行为护栏**（`tests/share-orders.test.js`）+ **4 条反向对照**（`R64-01a`~`R64-04a`，台账 727 → **731**）；⑦ **版本推进**：`1.8.9` → `1.9.0`（五个落点全量同步） | **① 「36 位订单号」与「微信 32 位上限」是硬冲突，靠拆成两个号解决**：`out_trade_no` 只能是 `order.id`（16 位 base64url），订单号必须另立一个字段。若图省事把 `order.id` 直接加长，微信支付会在下单那一刻回一个与「长度」有关的参数错误，而支付宝 / PayPal 照常成功 —— 表现是「只有微信付不了」，极易被当成渠道配置问题去查一遍密钥。**② 恢复购买只签发票据，不给下载路径加分支**：分享页 / `GET /s/:id/dl` / `HEAD /s/:id/dl` 三处都只认票据 Cookie `sp_<linkId>_pay`，所以「恢复购买」只要签出**同一枚**票据即可 —— 任何「再写一个 `?restored=1` 分支」的做法都会长出第二套判据，而两套判据必然有一处先改。**③ 拒绝文案必须同形**：「订单号不存在」与「订单号不属于本链接」分开回话，这个匿名端点立刻变成**订单号存在性预言机**（36 位虽然猜不出来，但用户会拿别人的号试出「这单存在」）。故两条都回同一句，且判定收敛到 `claimForLink()` 一处。**④ 链接 UID 必须可复算，但匹配权威仍是 `linkId`**：UID 用 `sha256('kepler:link:'+id)` 派生，同一链接恒得同一 9 位串（否则订单号里那一段纯属装饰）；但**匹配只认订单上的 `linkId`** —— 派生口径将来若变化（换哈希版本），历史订单号不该因此失效。**⑤ 免费下载「只记首次」需要一个正确粒度的键**：`(userId, linkId, fileKey)`。少一个维度就会两种错法：只记 `linkId` → 甲下载过、乙打开历史订单也看到这条；只记 `userId` → 同一文件的另一条链接被并成一条。**游客不记**是刻意的：没有稳定身份，记了也无法归集，反而会让「按 IP 归集」这个错误做法显得可行。**⑥ 历史订单里点「重新下载」不能又被送回付费墙**：票据是 Cookie，而 `GET /s/:id/history` 只渲染列表 —— 于是渲染时顺带为每笔 `paid` 且链接仍存在的订单**补发**对应票据（已退款不补、链接已删不补），否则这一页的「重新下载」链接会指向一个要求付款的页面。**⑦ 分享页的 `?next=` 是开放重定向面**：`takeShareNext()` 只放行 `/^\/s\/[A-Za-z0-9_-]{1,64}$/`，且在登录成功后**只消费一次**。分享页是匿名可达的，把 `next` 原样 `location.replace()` 等于给出一个「跳到任意站点」的入口。**⑧ 两处「看起来多余、其实必需」的判据**：其一，`normalize()` **不折叠大小写**（订单号区分大小写，折叠会让两个不同订单撞成一条）；其二，`findByOrderNo()` **先原样精确匹配再退化归一化** —— 若先归一化，历史订单的 base64url `id` 里的 `-` / `_` 会被抹掉，老订单**永远查不到**（本轮实测就踩了这一次，`R64-05` 把它钉住）。**⑨ 测试侧的两处口径错误（先在探针里确认行为正确、再修断言）**：票据是通过 **Set-Cookie 响应头**下发的，用「响应体里有没有 `sp_…_pay=`」去判会**恒假**；「退出登录」的负向断言若在整页 HTML 上搜文案，会命中 CSS 注释里同样写着的那四个字 —— 判据改判 `action="/s/<id>/logout"` 是否存在。 |
| R65 | 用户提出的**四项需求**（非审计轮，R65；原话：「在站点设置和用户设置之间新增『订单取回』卡片：1、取回次数限制：可设置通过订单号取回下载权限的次数限制；2、错误尝试次数上限：通过订单号取回下载权限的尝试次数限制，可设置输错多少次，该IP就需要24小时后再试；3、确保这里的封禁IP只影响『尝试取回下载权限』这一件事，并且管理员可以在『IP地址管理』中解封；4、该卡片不需要开关，默认持久化。」） | ① 新增 `server/restore-guard.js`（连击计数 + 封禁表**唯一实现点**，落盘 `data/restore-bans.json`）+ `server/routes/restore.js`（`GET`/`PUT /restore/config`，均 `requireAdmin`）；② `limits.js` 新增 `RESTORE_USES_MIN/MAX/DEFAULT`（1/100/3）与 `RESTORE_FAILS_MIN/MAX/DEFAULT`（1/50/5）+ 两个 `parse*Input()`；③ `config-store.js` 新增 `DEFAULT_CONFIG.restore` 与 `normalizeRestoreInto()` / `getRestore()` / `saveRestore()`（**PATCH 语义**）；④ `payment-orders.claimForLink(no, linkId, { maxUses })` 增加**按订单号**的配额判定与自增（`restoreCount` / `lastRestoredAt`）；⑤ `share-routes` 的两条取回端点接入封禁判定（**排在限流器之前**）与 `noteSuccess()`，被封时渲染 429 页**不渲染表单**；⑥ `routes/ipguard.js` 的 `GET /ipguard` 追加 `restoreBans` + 新增 `POST /ipguard/restore-bans/unban`；⑦ `public/index.html` 新增 `#sysset-restore-card`（**在站点设置与用户设置之间**，无任何开关）与 `#iprestore-card`，`syssettings.js` / `ipmgr.js` / `api.js` / `main.js` 接线；⑧ **10 条行为护栏**（`tests/restore-settings.test.js`）+ 5 条反向对照（`R65-01a`~`R65-05a`，台账 731 → **736**）；⑨ **版本推进**：`1.9.0` → `1.9.1`（五个落点全量同步） | **① 两个计数必须落在不同对象上**：取回次数记在**订单**（`order.restoreCount`），输错次数记在**IP**。若把取回次数也记在 IP 上，同一个出口 IP（办公室、家宽 NAT）里谁先取回就把别人的额度吃掉了 —— 而这两个需求读起来都像「限制次数」，用户回答提问时也专门确认过「取回次数限制按**每个订单号**」。**② 自增必须发生在 `claimForLink()` 内部而不是调用方**：这是唯一判定点，并发两个请求同时读到「用了 2 次」再各自写回 3，就白送一次额度；且「判定」与「记账」分开写，必然出现「判了没记」或「记了没判」的一半修复。**③ `used_up` 不计输错**：额度用尽是**正常使用走到尽头**，不是「猜错了」；把它计入封禁，等于让一个把 3 次用满的合法用户在第 5 次刷新时被自己封 24 小时。**④ 形状错误（空串 / 长度不对）反而要计入输错**：那是「乱敲」的形态，若免费放行，`maxFails` 对最需要拦的那种行为恰好无效 —— 这道闸门只对「认真但记错」的人起作用，那是一种最坏的设计。**⑤ 封禁只被分享页的两条取回端点显式调用，绝不挂全局中间件**（需求第 3 条点名的就是这个）：挂上去的后果不是「多拦一些」，而是这个 IP 之后的分享页浏览、上传、下载、后台全部 403 —— 一处限速闸门顺手升级成全网封锁，而管理员还在纳闷「为什么只有他家上不来」。`R65-08` 就是这条的正面护栏（封禁期内分享页 / `HEAD /dl` / `GET /dl` 必须全部照常）。**⑥ 封禁表必须落盘、连击计数刻意只在内存**：连击落内存是因为它描述的是「同一个人**正在**乱敲」这个短期状态，跨重启累计会把一年前的几次错输算进今天；封禁落盘是因为不落盘时「重启一次 = 批量解封」，`deploy.sh` 的一次 `systemctl restart` 就能把这 24 小时清零，等于这条限制从来没有生效过。配套地，`server/index.js` 的退出钩子里补了 `restoreGuard.flush()`。**⑦ 封禁判定排在限流器之前**：24 小时比「10 分钟 20 次」严重得多，先说重的；否则被封的用户会先看到一句「请求过于频繁，请稍后再试」，按它等 10 分钟回来仍然进不去，永远看不到那句「24 小时后自动解封」。**⑧ 「不需要开关」不是一个界面偏好，而是一处语义选择**（需求第 4 条）：有开关就意味着存在「关闭」状态，而关闭后这条匿名通道**无任何限制** —— 那比默认开着更糟；同理它不进「备份配置」范围时也沿用同一逻辑，默认值即策略。**⑨ 一次测试侧的踩坑**：`shareStore.create()` 是 **async**，夹具 `makePaidLink()` 漏了 `await` ⇒ `l.id` 是 `undefined`、订单的 `linkId` 也成 `undefined`，于是 `claimForLink` 一律回 `invalid`，四条用例（配额 / HTTP 第 N+1 次 / 封禁只拦取回 / 解封）一起红 —— 看着像实现坏了，实际是夹具没等。修法是让夹具 `async` 并给每个调用点补 `await`；教训是**先跑通再怀疑实现**。**⑩ 一个「文档先于实现」的核对**：三条新路由必须同时进 `routes-surface` 的 `EXPECTED`（含 `mustBeAdmin` 清单）与 HTTP API 表 —— 本轮 `EXPECTED` 只登记了两条 `restore/config`、漏了 `POST /ipguard/restore-bans/unban`，总数差 1 而「无路由丢失」照旧全绿（那条只查「台账里的都在」，不查「实际的都在」），正好被总数断言抓住。 |
| R66 | 外部评审清单（按「最高优先级 / 次优先 / 明确不做」三档共十余条，非审计轮，R66）。逐条回代码与实测核对后**只做成立且低成本的**：① **最高优先级的那一条：补 CI** —— 1255 条护栏此前没有任何自动化执行者（属实）；② **次优先：测试隔离** —— 「`audit38` 用 `withEnv()` 清 `config-store` 缓存导致 `backup.js` 读到旧实例」**不属实**（`withEnv()` 清的是 `security` / `_context` / `_shared`，`require` 缓存按绝对路径命中，实测 `backup` 与测试是同一实例、凭证可见），但「`crypto-storage.test.js` 把数据目录写死成 `ROOT/data` 而 `helpers.js` 早已兜底 `S3_DATA_DIR`」**属实**；③ **密钥轮换的预留位** —— 「`config.enc` 抬头加版本号」**早已存在**（`ENC_FLAG` + `ENC_VERSION = 1`），而「`enc-meta.json` 加 `keyId`」属实且成本极低；④ **`/health` 扩展** —— `configured` / `corrupted` 早已有，缺 `bucketCount` / `lastWriteAt`；⑤ **编辑器类型提示** —— 属实，但只做实`jsconfig.json`，不做全量 `@ts-check`；⑥ **拆巨型文件 / ADR 目录 / 明确不做的三条**——分别留待单独一轮与明确不做（理由见 `CHANGELOG`）。 | ① 新增 `.github/workflows/ci.yml`（ubuntu 18/20/22 + windows 22；`npm ci` → lint → **逐文件**测试，禁止 `continue-on-error`）+ `jsconfig.json`；② `tests/crypto-storage.test.js` 的 `DATA` 改为跟随 `S3_DATA_DIR`；③ `enc-store.js` 新增 `CURRENT_KEY_ID` / `stampKeyId()`（**唯一盖章点**，包住直传 crypto / 直传 magic / 分片 crypto / 分片 magic 四个元数据生产点）/ `keyIdOf()`（老记录默认 1），密文格式零改动；④ `GET /health` 追加 `bucketCount` 与 `lastWriteAt`，**仅管理员下发**；⑤ `tests/repo-hygiene.test.js` **4 条**新护栏 + `crypto-storage.test.js` 追加 `R66-03`；⑥ `audit40` 的 `if (r.unavailable) return;` 改 `t.skip()`（原写法在没有 bash 的机器上「报告通过但从未执行」）；⑦ **4 条反向对照**（`R66-01a`~`04a`，台账 736 → **740**）；⑧ 文档：目录树补 CI 与 `jsconfig.json`、修正「为什么没有引入 MasterCard / Visa」一节的字段笔误与排版、「500+ 条用例」改为实测 **1260 条**、测试文件 69 → **70**；⑨ **版本推进**：`1.9.1` → `1.9.2`。 | **① 评审给的行数全部偏低**（`share-routes` 报 2141、实测 2730；`config-store` 2139 → 2742；`webdav-server` 1121 → 1495；`deploy.sh` 3472 → 4253）：结论方向对，但**数字不能直接引用**。**② 「9 条靠本机无 bash 而 fail」无法在本机复核**（本机有 bash），机制属实：`audit16` / `deploy-script` 有**硬失败**分支，`audit40` 则是**静默 `return`** —— 后者比前者更糟，它报告通过却从未执行，故本轮只修这一处（改成显式 `skip`）。**③ 「69 个文件各写各的重载逻辑」夸大了**：实际 **15 个**文件含 `require.cache` 操作。**④ 评审的 `reloadGraph()` 重构不做，理由是缺陷不成立**：`withEnv()` 根本没清 `config-store`；`backup.js` 与测试文件 `require` 的是同一份实例（缓存键是解析后的绝对路径），故「写进新实例、读旧实例」不可能发生。**⑤ `keyId` 必须是唯一实现点**：元数据有 4 个生产点，逐个手写 `keyId: 1` 将来新增第五种形态必然漏，而漏掉的表现（这条密文没有密钥归属）要到**真正轮换那天**才暴露。**⑥ `/health` 的字段要按角色分档而不是给它挂 `requireAdmin`**：挂上去普通用户就 403、拿不到「服务是否可用」，而前端全局横幅正靠它 —— 这与「匿名接口只回必要字段」是同一条纪律的两面。**⑦ 本轮两次踩到「注释参与判据」**：CI 的文件头注释里写着 `npm test`（不剥注释，「含 npm ci」这类断言会被注释满足）；`crypto-storage` 的说明性注释里写着 `path.join(ROOT, 'data')`（不剥注释，正确的修法反而被判红）—— 一个假绿、一个假红，同一处根因。**⑧ 明确不做**：拆巨型文件（要单独一轮、所有 anchor 与路由顺序都得重跑）、引入数据库 / SM4 / 自签名证书（与前几轮结论一致，SM4 有本机实测数据）、`LOG_SINK` 日志外发（部署形态决策）。 |
| R67 | 外部评审清单的「最高代价项」（非审计轮，R67；原话：「现在开始：P1-4 拆巨型文件 / ADR 目录」）。评审建议新建 `docs/ADR/` 存「为什么这样做」，并把四个巨型文件拆开。本轮先实证可拆性再动手，只动风险最低的一个。 | ① 新增 `docs/ADR/` **七篇** + `index.md`（五节强制：背景 / 决定 / 理由 / 备选方案（已否决）/ 后果与约束）；② `server/webdav-server.js` **1496 → 215 行**入口 + `server/webdav/{defs,util,listing,auth,xml,app}.js`（按原文件自己的六条分节标记**逐字搬运**，分段做过逐字节比对）；③ `tests/helpers.js` 新增 `packageSource(entry, pkg)`，13 处「读整个文件」的静态断言改读**整包**；④ 台账按「原始行号 → 新文件」机械迁移 **33 条**，并新增三条**拆包不变量**（孤儿文件 / 反向成环 / 入口不得注册路由）+ 三条反向对照（`R67-01a`~`03a`，台账 740 → **743**）；⑤ `docs-sync` 新增「ADR 索引 ↔ 实际文件」双向断言（21 → **22 条**）；⑥ 文档：目录树登记 `docs/ADR` 与 `server/webdav/`、分层图改指 `webdav/app.js`、用例 1260 → **1264**；⑦ 版本 `1.9.2` → `1.9.3`。 | **① 拆包的成本不在搬代码，而在「静态断言的范围」。** 13 处测试是「读整个文件的源码做断言」，其中最危险的是**负向断言**（「不得再出现 X」）：X 搬走之后，只读入口的断言**依旧通过而覆盖已经消失** —— 这比直接变红糟得多。本轮 `R22-03` 的**扫描范围自检**（「应至少 5 处 `davErrorMessage(e)`，当前 0」）当场抓住了它，这就是本项目坚持「负向判据必须自带下界自检」的原因；修法不是放宽断言，而是把「入口 + 包目录全部 `.js`」当一个整体读（`packageSource()`），同时**保留每个文件里的正向自检**，否则「哪儿都没有」也能让负向断言通过。**② `deploy.sh` 不能拆，理由是一处硬约束而不是偏好。** `README` 的一键安装是 `curl -fLo /tmp/kepler-deploy.sh <raw.githubusercontent.com>/…/deploy.sh && sudo bash /tmp/kepler-deploy.sh` —— 该地址**只给单个文件**，脚本在工作目录之外执行，`source deploy/lib/*.sh` 在那一瞬间必然找不到目标；而「先把仓库拉下来再跑」又要求引导段本身已经能跑（循环）。真要拆得先加「拼接成单文件」的构建步骤，与 ADR-0004 的零构建取向冲突，代价大于收益。`share-routes.js` / `config-store.js` 各 2000+ 行、各 30+ 条 anchor，同理需要一次独立的迁移窗口。**③ 结构坏掉时，没有任何行为测试会变红。** 孤儿文件（从 require 里删掉一个模块，路径不再被调用）、反向成环（为拿 `buildApp` 让 `defs` 去 require `./app`，表现是「某个导出启动时是 undefined」而不是报错）、实现搬回入口（图省事写在 facade 里，几个月后又变回巨型文件）—— 三种坏法都被「测试仍然全绿」掩护，故必须单独立结构断言，并各自配一条反向对照。**④ 迁移台账要机械、要验两遍。** 按「原始行号 → 新文件」的映射批量改 `file` 字段，先跑 `invariants`（740 条 anchor 自检，一跑就知道有没有打偏），再**逐条实跑** 33 条确认「撤销仍然变红、红的正是本条」。**⑤ 顺带修掉一处过期说明**：文件头还写着「复用本地自签名证书」，而 R49 早已移除该能力（见 ADR-0003）。 |
| R68 | 用户提出的一项需求（非审计轮，R68；原话：「在『发信设置』和『线程并发』之间新增一个『协议设置』：用户可设置是否在注册页、登录页和分享页显示它们，以及显示的文案（允许用户用 `<a>` 链接包裹，例如：继续注册则代表您已阅读并同意`<a>用户协议</a>`和`<a>隐私政策</a>`），允许用户分别设置单独的用户协议和隐私协议。两种协议都使用固定高度的编辑框，支持 markdown 或其他格式，带竖滚动条，以免协议文本过长导致 UI 体验差。访客点击链接阅读协议，则弹出一个对话框展示，有关闭按钮。」**末句另行指定归属**：「『用户可设置是否在注册页、登录页和分享页显示它们，以及显示的文案』这一设置项，应放置在【站点设置】卡片中，『协议设置』只保存协议文案。」） | ① **配置分两段落盘，归属按用户末句切分**：`cfg.site.notices{login,register,share}{enabled,text}` 归站点设置（三行「显示提示 + 文案」输入框），`cfg.agreements{terms,privacy}` 归协议设置（两个 `textarea`）；② 新增 `server/agreement-text.js`（渲染**唯一实现点**：整段转义后只插入自己生成的标签 + 极小 Markdown 子集 + `<a>` 改写）与 `server/agreement-view.js`（页面级视图**唯一实现点**：`noticeForPage` / `publicPayload`）；③ 四条接口（`GET/PUT /agreements/config`、`POST /agreements/preview` 均 requireAdmin，`GET /site/agreements` 公开）并同步 `routes-surface` 的 137→141 与 `PUBLIC_API`；④ 编辑框固定 260px + 竖滚动条 + `resize: vertical`；⑤ **分享页的对话框用 CSS `:target` 而非脚本**（该页 CSP 不放行内联脚本），关闭入口是 `href="#!"` 的遮罩、右上角 ×、底部按钮三处；⑥ 登录/注册页走公开接口，点击链接复用 `openAgreementDialog()`；⑦ 备份 `SCOPES` 追加第 10 分区「协议设置」，`sanitizeSite` 纳入 `notices` —— 只备份开关不备份正文会造出「提示挂着、点了没内容」。 | **① 「过滤危险标签」这条常见写法在本场景是错的。** 这两段文字要在**匿名访客**的浏览器里渲染，黑名单漏一个（`<img onerror>` / `<svg onload>` / `<iframe srcdoc>` / `javascript:`）就是存储型 XSS。改为**先整段转义、再只在白名单位置插入本模块生成的固定标签串** —— 输出里的每个标签都可追溯，管理员输入里的 `<` 永远只能是 `&lt;`。判据也据此写：断言的是「`<img onerror>` 在输出里变成 `&lt;img`」，而不是「输出里没有 `onerror` 这个词」（后者会被正文里正常出现的英文单词满足）。**② 链接正则不允许括号，是刻意的。** 初版用 `[^)\s]*`，`[点我](javascript:alert(1))` 会匹配到 `javascript:alert(1`，留下一个孤零零的 `)`；改成 `[^()\s]*` 后整段匹配不上即原样显示 —— 拒链的同时**不吞字**。**③ 「不显示」有三种，别只做一种。** 开关关 ⇒ 不显示；开关开但两份正文都空 ⇒ **整条提示也不显示**（提示里必然至少一个 `<a>`，点开是空对话框比不显示更让人困惑）；只填了一份 ⇒ 那一份的 `<a>` 退化成**纯文字**。三件事共用 `agreement-view` 一个判据，否则设置页预览与分享页会在界面上悄悄分叉。**④ 负向断言的注释陷阱，本轮又踩一次。** 我在站点设置卡片里写了「刻意不用 `ip-switch`」的注释，把 `audit54` 的 `R54-6`（负向断言「卡片没有启用开关」）判红 —— 与 `FACTS.md` §十五第 ② 类同源，只是方向相反（那类是**注释满足了正向断言**，这类是**注释触发了负向断言**）。判据改为先剥 HTML 注释再判。**⑤ 位置断言要带类名前缀。** `R68-20` 起初判 `/ag-notice/.test(页面)` 而页面自带样式表里恒有 `.ag-notice { … }`，于是「关掉后无痕迹」这条**恒绿**；改成 `/class="ag-notice"/`。**⑥ 夹具里的 `async` 漏 `await` 是复发型坑**（`shareStore.create()` 返回 Promise，漏了就拿到 `l.id === undefined`，表现是分享页 404）—— 与 R65 同型。 |
| R70 | 用户提出的一项需求（非审计轮，R70；原话：「为该项目添加完整的 PWA（渐进式网页应用）支持，使网站可被安装为独立浏览器应用并创建桌面快捷方式运行」，追加「生成的快捷方式的名称以用户在『站点名称』中填写的为准」，图标用其提供的 SVG 并要求「加白底和圆角正方形」） | 2 个新模块（`server/pwa.js` / `public/js/pwa.js`）+ 1 个前端模板（`public/sw.js`）+ 6 个图标文件 + **17 条行为护栏**（`tests/audit70-pwa.test.js`）+ **14 条反向对照**（`R70-01a`~`R70-16a`）；版本 `1.9.5` → `1.9.6` | 本轮最关键的一条约束来自需求措辞本身：**「快捷方式的名称以站点名称为准」决定了 manifest 不能是静态文件**。系统在**安装那一刻**读 manifest 的 `name`（退化到 `short_name`），装完即固化，之后改 `document.title` 完全无效；而站点名称是可配置项。故 manifest 改成 `GET /manifest.webmanifest` 现场生成（`Cache-Control: no-cache`，改完名字下一步点「安装」就是新的）。**`short_name` 刻意不截短**（与 `name` 同值）—— Chrome/Edge 建桌面快捷方式**优先取 `short_name`**，在服务端自作主张截短会让需求只对一半，而用户看到的是被截断的那个。`/sw.js` 同理走动态路由：它是**模板**，版本号占位符由服务端替换，缓存名因此带版本 ⇒ 发版即换缓存 ⇒ `activate` 删掉上一版；否则用户升级后仍拿旧 `main.js`（SW 缓存无过期时间），表现为「服务端修好了、用户那边还是老样子」。⚠️ **本轮实测踩到一个真实缺陷**：占位符在模板里原本出现两次（文件头注释解释它是什么 + `const VERSION` 那一行），而 `String.replace` 只替首处 —— 于是被替换的是**注释**、常量一字未动，响应里"看起来"确实少了一处占位符；探针查到 `const VERSION = '__KEPLER_VERSION__';` 原样存在、缓存标签退化成 `dev`、所有版本共用一份缓存。修法两条腿：替换改全局，且模板注释里**刻意不再写那个字面串**（`R70-06` 断言占位符在模板里恰好 1 次且必须落在 `const VERSION` 行）。**缓存策略刻意收窄**：`/api` `/s` `/dav` 完全不拦截（会话态与一次性数据进缓存会造成「换账号看到别人的数据」「链接已过期离线还能打开」）；`/s/:id` 本身也是导航请求，若被「导航失败退回 index.html」兜住，离线打开分享链接会看到登录页 —— 属于**用错的界面回答对的问题**。导航网络优先、静态资源缓存优先 + 后台回源；`install` 逐项 `add` 而非 `addAll`（后者一项失败即整个安装失败，而界面上的表现只是「安装按钮点了没反应」）。`beforeinstallprompt` **只保存凭据**、`prompt()` 挂在用户点击上（该事件每页只发一次，在回调里用掉等于永久失去安装入口）；SW 注册失败一律静默（明文 HTTP / 隐私模式被拒是正常情况，在这里 `throw` 会拿核心功能去换增强功能）。**图标**按需求「白底 + 圆角正方形」：圆角**烤进图标本身**（Windows 快捷方式与任务栏对 SVG 圆角支持不一致），另做一张 `purpose: maskable` 的满版白底交 Android 按形状裁切；PNG 由本机 Chrome 无头光栅化（零新增依赖）并用自写零依赖 PNG 解码器**逐像素核对**（四角 `alpha=0` = 圆角生效、maskable 四角 `255,255,255,255` = 满版、中心为 `#FFE777`），不靠肉眼。**方法上的三处自省**：① 两条 PWA 端点的逻辑全部收进 `server/pwa.js`、`index.js` 只挂载 —— 因为最初把 `/sw.js` 内联在 `index.js`、测试又重写了一份等价路由，导致针对生产的反向变异**根本打不到测试实际跑的函数**（`fail=0` 假绿）；② CSP 补 `worker-src`/`child-src` 时，长注释挤占了 `audit-regressions` 用「CSP 头名 → 结尾指令」900 字符窗口定位 CSP 的空间，`audit40` 还依赖「每条指令各占一行、以双引号开头」的形态 —— 最终把注释挪到 `setHeader` **之前**（窗口外）并恢复逐行结构，**没有去放宽那两条既有判据**；③ 注释里一度同时写了那两个定位用的字面串，`indexOf` 先命中注释把窗口截成 43 字符，又一次「判据落在注释上」。**4 条反向对照首跑假绿**：`R70-01b` 的测试站点名只有 6 个字、`slice(0,12)` 截不到（判据的**输入数据**太短）；`R70-05a` 只改替换方式还不够，必须同时让占位符真的出现两次才复现得出该 bug；`R70-06a` 的 anchor 整句在注释里，被 `invariants` 的「双侧剥注释」自检判成悬空。真浏览器冒烟（Chrome 无头）确认：模块图执行、无 CSP/m 模块错误、SW 真的注册，且 `CacheStorage` 里的缓存名为 **`kepler-shell-1.9.6`** —— 若版本号替换没生效这里会是 `kepler-shell-dev` |
| R71 | 用户提出的权限漏洞（非审计轮，R71；原话：「当前系统的权限逻辑存在漏洞：管理员之间可以互相删除，导致越权风险：在现有管理员角色之上新增『根用户』角色 … 根用户拥有对任意用户（包括管理员和其他根用户）的添加、编辑、删除权限；管理员仅能管理普通用户，无权添加、编辑或删除管理员及根用户」） | 1 个新模块（`server/roles.js`）+ 1 个新护栏文件（`tests/root-role.test.js` **24 条**）+ 三层权限矩阵（用户管理五条路由 + 三条「授予角色」通道）+ `requireAdmin` 判据放宽到管理层 + 前端 `util.isStaffRole`/`roleLabel` + 根用户徽章与按钮门控 + 版本 `1.9.6` → `1.9.7` | **① 漏洞的形态不是「少了一个 if」，而是「两个概念共用一个词」**：旧实现里 `role === 'admin'` 同时表示「能进用户管理」和「能管任何人」，于是任何管理员都能删掉其它管理员。修法必须把这两件事拆成两个判据：`requireAdmin`（能不能用这个功能，判据 `roles.isStaff`）与 `denyIfCannotManage`（能管谁，判据 `roles.canManageUser`）。只把前者写宽、不改后者，等于什么都没修。**② 五条路由共用**：编辑 / 删除 / 封禁 / 解封 / 强制登出全部走同一个 `denyIfCannotManage()`。封禁是**软删除**（目标立刻失去登录能力），漏掉它等于漏洞换个按钮继续存在。**③ 三条「授予角色」的通道都要堵**：`POST /users { role }`、`PUT /users/:id { role }`（改角色 = 授予角色）、邀请码 /「新用户身份」（等于批量发管理员）。只堵第一条，管理员仍能靠另两条造出与自己同级的账户。**④ 根用户由「事件」产生，不由「授予」产生**：`resolveNewUserRole()` 在**空库**时强制第一个账户为 root（判据放存储层而非 `/auth/init`，防止「清空用户后走公开注册」绕过）；已有账户后请求 `root` 一律 403；`root` 的 `PUT { role }` 一律 400（不可撤销 —— 撤销即等于转让）。升级场景由 `ensureRootUser()` 按 `createdAt` 把**最早创建**的账户补成 root（幂等、纯函数式判据），并顺带修掉读盘归一化把 `root` 降级成 `user` 的白名单问题。**⑤ 判定必须排在写操作之前**：403 之后目标用户必须**一字节未改**、会话**未被吊销**，并留一条 `users.denied`（level=warn）审计日志 —— 只断言状态码的话，「先删再回滚」也能全绿。**⑥ 前端只是第一层**：`isStaffRole()` 决定「根用户也能看到管理入口」，`userTableHtml()` 对他人 admin/root 行把编辑 / 封禁 / 删除渲染成 `disabled` + 说明性 `title`（而非可点后报错），角色下拉只对根用户出现，且 UI 里**没有** root 这一档。**⑦ 沙箱 stubs 的连带修复**：`syssettings.js` 新增两个 util 具名导入后，7 个前端沙箱的 `util.js` 桩缺符号会在 ESM **链接期**整片变红（audit31 一次红 14 条），桩里按真实实现补 `isStaffRole` / `roleLabel`；`audit33` 的「管理员可以封禁另一个管理员」按新口径改为「管理员 403 / 根用户 200」；`audit37` 的夹具原用「先 removeUser 再 addUser」，撞上「最后一个根用户不可删」后改为**复用**账户。 |
| R72 | 用户提出的需求（非审计轮，R72；原话：「修改安装脚本：当前部署完毕后的信息中不显示安装令牌，部署完毕后在部署完成的信息中添加安装令牌，快捷菜单中也要显示。」） | 1 处服务端行为调整（`routes/auth.js` 新增 `primeSetupToken()` + `server/index.js` 在 `listen` 前调用）+ 2 个 shell 读取助手（`setup_token_path` / `setup_token_read`）+ 收尾信息与管理菜单各一段展示 + **4 条行为护栏**（`tests/deploy-script.test.js`）+ **3 条反向对照**（`R72-01a`~`03a`） | **① 问题的形态是「信息生成时机不对」，不是「少打印一行」**：令牌原本是懒生成的（第一次 `GET /auth/me` 或 `/auth/init` 才落盘），而部署脚本在服务刚起来就读完了状态、把收尾信息打印完 —— 那一刻数据目录下的 `setup-token.txt` 还不存在，于是「部署完成」的信息里只能写「去翻启动日志」，可用户此时连页面都还没打开，而登录页那一栏要填的正是它（鸡生蛋）。**② 修法必须落在「谁生成」上**：让脚本自己再造一枚是最差的选择 —— 两处各自 `randomBytes` 就是两枚不同的令牌，服务端只认自己那枚（或只认文件里那枚，取决于谁先写），用户照打印的填必然 403，而现象极像「令牌功能坏了」。故把生成时机前移到**服务端启动**（`primeSetupToken()`），脚本此后**只读** `setup-token.txt`。**③ 三条边界缺一不可**：非部署模式（回环）不生成 —— 本机形态本来就不需要令牌，凭空造一个只是多一栏要填；已有账户不生成 —— 令牌只在首次初始化有意义，已初始化的实例不该再有一枚可用令牌；读用户列表失败也不生成 —— 异常状态下宁可不写凭据。**④ 展示口径**：收尾信息紧跟「访问地址」（用户的下一步就是打开页面）；没有令牌时**不硬编造**，只说明「已完成初始化 / 服务未就绪」并给出文件位置；`kepler` 菜单**每次进入都重读文件、不缓存** —— 缓存会在初始化成功后继续显示一串已失效的凭据。**⑤ 四条护栏各自钉一条路径**（静态：脚本不得出现 `randomBytes`/`openssl rand`/`/dev/urandom`，生成权只在服务端；收尾信息：真跑 `print_summary`，令牌**恰出现 1 次**，删掉文件后不得残留；菜单：真跑 `manage_menu`，显示 1 次、文件消失后不再显示；服务端：**真起 node 进程**断言启动即生成 32 位 hex、落盘与返回值一致、重复调用不换令牌、初始化后不再生成）。 |
| R73 | 用户提出的四项界面改进（非审计轮，R73；原话：「1、将「订单取回」卡片移动到「用户管理」卡片的下方，并保持整体卡片布局的排列一致性；2、「配置备份」功能中应提供文件选择入口，允许用户自行选择本地 json 文件进行备份或导入，并明确对非 json 文件的处理方式；3、在系统设置页面 toolbar 下方的空隙区域新增一个锚点导航栏，包含各卡片的快捷入口，用户点击后可平滑滚动并快速定位到对应卡片位置，同时保持锚点与卡片的一致性及响应式适配；4、当前创建首个用户的页面已修改，检查是否还有漏掉的，然后改掉。」） | 1 个新前端模块（`public/js/anchornav.js`）+ 1 个新护栏文件（`tests/settings-ux.test.js` **18 条**）+ 卡片顺序调整（`index.html`）+ 备份文件选择（`backupcfg.js` 四个纯函数 + 导入/导出对话框）+ 首个用户口径补改（`main.js` / `index.html` / `deploy.sh`）+ **8 条反向对照**（`R73-01a`~`08a`）+ 版本 `1.9.8` → `1.9.9` | **① 锚点的「一致性」不能靠手写清单，只能靠构造方式**：卡片顺序本轮就动了（取回下移），而 `ADMIN_ONLY_CARDS` 之外还有「关于」这类对普通用户也可见的卡片 —— 任何手写的锚点清单都会在「新增 / 移动 / 按角色隐藏卡片」时**静默失配**（指向错位或已不存在的卡片）。故锚点由 `buildAnchorBar()` **扫 DOM 现生成**并跳过 `hidden`，普通用户只剩一张卡时整条收起。**② 锚点逻辑必须独立成模块才能被真验证**：它塞在 `syssettings.js` 里就没法单独加载（一进来就牵动 `main.js` 的顶层 `init()`，DOM 桩撑不住），于是只能停留在「源码里有这句话」的静态断言 —— 那正是本项目反复栽的假绿类型。独立后 `settings-ux.test.js` 配一个轻量 DOM 桩**真跑**它（与 R36 `listdialog.js`、R37 `speedlimit.js` 同型）。**③ 滚动必须减掉锚点栏自身高度**：它是 sticky 贴在滚动容器顶部的，直接 `scrollIntoView` 会让卡片标题被这条栏压住，表现为「点了像没定位」；这是本轮最容易被写漏的一处算术，由 `R73-06` + `R73-03a` 双向钉住。**④ 非 .json 的处理方式是「扩展名做门禁、内容做校验」，且门禁在读文件之前**：`file.type` 在 Windows 上常为空串，拿它当判据会把正常 `.json` 挡在门外；反过来，改过后缀的文件内容也未必是能认的备份。故非 `.json` **连内容都不读**（备份里含密钥明文，不该去猜用户塞进来的是什么）。**⑤ 三种失败必须给三种不同的提示**：空文件 / 非法 JSON / 缺 `code` 字段塌成一句「文件不对」，用户无从判断是该换文件还是这份备份本就坏了。**⑥ 首个用户页面的遗留是「同一件事两个口径」**：R71 已把建号改成根用户，但初始化页仍写「创建管理员账户」、安装令牌仍只指向启动日志、用户管理说明仍写「至少保留一个管理员」—— 界面文案是三层权限唯一的对外口径，说成管理员会让用户误判自己能管到哪一层。**⑦ 顺序改动会「老化」既有判据**：`R65-10` 原本断言 `site < restore < user`，`ADMIN_ONLY_CARDS` 的两条 anchor 也含旧次序 —— 一并迁移，`invariants` 的 anchor 自检正是为此存在。 |
| R74 | 外部《Kepler 漏洞评估报告》逐条复核（9 条，`F-01`~`F-09`） | 1 条代码修复（`F-04` 导出码 KDF 异步化）+ 依赖 CVE 清零（`npm audit fix`）+ 1 个新护栏文件（`tests/audit74-regressions.test.js` 4 条）+ `invariants` 新增 1 条（`SEC-05` AST 全库扫描）+ 幻觉报告 4 条（`03`~`06`） | **只有 `F-04` 值得动代码；其余要判「是不是漏洞」，不是「像不像漏洞」**：① `F-07` **与代码相反** —— 报告把描述「R21-03 修复前状态」的注释读成了现状，实际单请求有 `MAX_WRITE_BUFFER = 128MB`（超限 `destroy()` + 413）、并发有 `MAX_WRITE_STREAMS = 2`，且 `await acquireWriteStream()` 排在缓冲**之前**；② `F-08` 的事实链断在 `git log -S` 零命中上 —— `update-check.js` 自首次出现（`558d49d`）起就指向新仓库，旧仓库 404 属实但**从来没有哪个版本的代码指向过它**；③ `F-09` 的 `errorBody()` 本就是 `{ error }` 的**超集**（`code` / `quota`），前端 `api.js` 已在消费，真实缺口只是「错误码集合没写成契约」；④ `F-02` 依赖债真实、可达性论证错（需 `comma: true` 或 `qs.stringify`，两条路项目都不走）。⑤ `F-04` 的真正价值不在「阻塞 500ms」，而在**台账 `SEC-05` 写着「全库无 `scryptSync`」而代码正用着它、且没有任何机器守着这句话** —— 判据老化 + 无护栏，正是本项目反复命名的慢性病，故修复拆成**静态面**（`espree` AST 全库扫描，含违规样例自检）与**行为面**（`setTimeout(0)` 与 `seal()` 赛跑，语义判据而非墙钟阈值）。⑥ 判据形态两次踩坑：`stripComments()` 文本匹配在正则字面量与模板串混排的文件上会**状态漂移**（既假红也假绿）；带 lookbehind 的正则被目标文件**注释里的** `backup.open()` 判红 ⇒ 两处都改成 AST。⑦ 反向变异必须先让变异体**语法自洽**：首版把 `deriveKey()` 改回 `scryptSync` 时留下孤立 `});`，结果红的是「文件级语法错误」而不是判据。 |
| R75 | 外部《依赖清单核查》复核 + 依赖面收敛 | `app.set('query parser', 'simple')` + express 钉精确版本 + `espree` 显式声明 + CI 加 `npm audit` + `invariants` 新增 2 条（运行时依赖白名单 / 未声明 require） | **核查结论：那份清单的数字全对**（运行时 68 / 开发时 92 / 嵌套 17 与 `npm ls` 及 lockfile 逐个吻合），但**"条数"不是风险面**：真正的风险是「代码直接 require 了一个没写进 `package.json` 的包」—— 它能跑纯粹因为 npm 把它平铺到了根目录。实测扫出 1 处真问题（R74 新护栏用了 `espree`，当时只是 eslint 的传递依赖）与 1 处误报（`audit49` 的**断言文案字符串**里写着 `require('selfsigned')`）⇒ 判据必须走 AST，正则会被注释与字符串骗。另把 `query parser` 换 `simple`：全库 `req.query.*` 全是扁平标量，改后 `qs` 从"论证不可达"变成**构造上不可达**（同时天然免疫原型污染），这是唯一能在**不改对象键、不改密文格式**的前提下缩小可达攻击面的动作。 |
| R76 | CVE-2026-111497（Node.js Brotli 解码器越界写，可 RCE）运行时升级（非审计轮） | `engines` ≥18 → ≥24.22.1；Dockerfile 双阶段 `node:22-alpine` → `node:24.22.1-alpine`；`deploy.sh` 最低要求 18 → 24.22.1、NodeSource 默认 20 → 24、tarball 兜底 20.19.0 → 24.22.1；CI 矩阵 18/20/22 → 24；文档与版本号五个落点同步（1.9.10 → 1.9.11） | 受影响面全覆盖：22.x < 22.23.4 / 24.x < 24.22.1 / 26.x < 26.12.1 均受影响，18 / 20 已 EOL 无修复 ⇒ 旧 `>=18` 声明下**本机、镜像、脚本安装、CI 四条路径全部曝险**；缺陷在运行时自身，升依赖无效，且浮动 tag 不自动生效、必须重建镜像。顺带按历轮教训迁移 `R40-01f` 反向对照 anchor（`setup_20.x` → `setup_24.x`）—— 由 `invariants` 的 anchor 自检当场抓住，正是「改判据形态会老化别处 anchor」的又一次复现 |
| R77 | 外部《Kepler 加密与支付模块审计》复核（7 条：`F-P1`~`P3` / `F-E1`~`E4`） | 1 条代码修复（`F-E1`：缺 IV/TAG 的历史加密元数据 fail-closed + 写入侧禁止再产出该形态）+ 1 个新护栏文件（`tests/audit77-regressions.test.js` 4 条）+ 3 条反向对照（`R77-01a`~`03a`）+ 幻觉报告 1 条（`07`） | **先复核前提，再决定改不改**：① **`F-E2` 是幻觉** —— 报告称 `data/enc-meta.json` 是「未认证的明文 JSON」，实际全部经 `secure-store.js` 的 `writeJson` 以 `{_enc:1, data: AES-256-GCM(secret.key)}` 落盘，GCM 自带认证标签、篡改会 `corruptError` 并拒绝后续写入（唯一残留是**历史明文文件**读取时被兼容，下次写入即升级）；「全库无 `setAAD`」属实，但没有 AAD ≠ 未认证。② **`F-E1` 成立** —— R24-03 的豁免分支（缺 iv/tag 跳过比对）确实没有回填迁移、也没有任何护栏，能写云端对象者可重排 / 拼接出「合法」明文；判为唯一需要动代码的一条。③ `F-P1`（微信回调分支只做字段存在性检查）的安全性质不依赖它（解密失败即不触发状态变更）、`F-P2`（券码失败原因弱枚举，有 IP+链接维度限流与 50 bit 码空间）、`F-P3`（备份码两级 KDF 回退，已处理时间侧信道）、`F-E3` / `F-E4`（magic 历史文件、分片不全时降级为不校验，元数据显式标 `integrity:none`）均**属实但不值得动代码**。④ 修复顺带揪出一个**同型隐患**：原 `new Transform()` + `nextTick(destroy)` 的「失败流」是**直通**的，调用方若立刻 `end(密文)`，'end' 会先于 nextTick ⇒ 密文被当明文吐出去；本轮 `R77-02` 的「零字节下发」断言当场抓住，改为 `failStream()`（有数据必错 + 空输入兜底 destroy）。⑤ 反向变异首次 `fail=0` 的教训：只把 `cb(err)` 改成 `cb()` **不够** —— 自定义 transform 会让 `end` 推迟、`nextTick(destroy)` 反而先到，测试照绿；必须把整个函数体退回「默认直通 Transform」这个**旧实现的可观测后果** |
| R78 | 外部《模块安全审计报告》复核（3 高 / 25 中 / 92 低 / 16 待确认） | 11 条代码修复（H-1 分享加密门禁按整份快照判定 / H-2 复制真实净增 + 记账 / H-3 优惠券筛选参数顺序 / 认证-发现1 代关 Windows Hello 补 `canManageUser` / IP-F03 命中计数落盘不崩溃且降级可见 / IP-F05 mapped 折算 / S3-F1 流式下载改空闲超时 / WebDAV-W5 回滚清 enc-meta / WebDAV-W1 username 唯一 / SMTP 信头 CRLF 兜底 / 基础设施-F1 端口占用 fail-fast）+ 1 个新护栏文件（`tests/audit78-regressions.test.js` 12 条）+ 11 条反向对照（`R78-01a`~`R78-11a`）+ 幻觉报告 2 条（`08`/`09`）；版本 `1.9.12` → `1.9.13` | **① 三条高危是同一个模式：「判据落在错的层」**。H-1 的门禁判据选了 `l.key` 而它**不是内容本身**（多条目分享里它是快照第一项）；H-2 的闸门算了 `addBytes` 而文件任务的 size 恒为 0；H-3 的参数顺序把「搜什么」和「在什么里搜」调了个个儿 —— 三者都「看起来有校验」，全绿，且都能用一句「源码里有那行」的断言骗过去。修法只能是**把判据挪到真正被执行的那一层**（整份快照 / 真实字节 / 真实签名顺序），护栏也必须断言**后果**（匿名访客拿不到明文 / 用量数字真的变了 / 搜不到的词真的消失）。**② `denyIfCannotManage` 的位置本身就是缺陷成因**：它住在 `routes/users.js` 里，所以只有 users.js 能调用；代关 Windows Hello 与重置密码是同一档运维能力，却因为「引不到」而只挂 `requireAdmin`。本轮把它下沉到 `_shared.js` —— **共用的判据必须在能被共用的地方**，否则下一轮还会漏第四条路由。配套 `R78-12` 特意做成**真发 HTTP** 的路由层用例：只测判据本身的话，「判据写好了却没接上」照样全绿。**③ 定时器里的失败必须变成返回值**：IP-F03 的 `persist()` 在`setInterval` 里抛错 = `uncaughtException` = `exit(1)`，而重启后文件还是坏的 ⇒ 崩溃循环；把落盘动作抽成 `flushHits()` 之后「不抛错」这条语义才有地方被测试钉住。**④ 超时的语义是「别永远挂着」而不是「大文件不许下」**：S3-F1 把请求级定时器留给整个 body，2GB 在 10MB/s 链路上必在 120 秒处中断；改成空闲看门狗后「慢但不断」通过、「停滞」仍被掐断 —— **两个方向都要有用例**，只测一个方向的话「一律不超时」也能全绿。**⑤ 回滚的边界再确认一次**：`rollbackCopies()` 只对「云端明确确认已删」的键清加密元数据，删除失败的副本仍在云端 —— 清它的元数据才是真正的数据丢失（密文永久不可解）。**⑥ 两条判为不存在**：`enc.key` 缺失「静默生成」与代码相反（存在但内容非法是 fail-closed 抛错，只有文件不存在才生成，那是首次部署的正常路径）；H-3 的**症状描述**「对话框恒空」方向正好相反（实测恒显示全部）—— 缺陷本体成立并已修，但现象记录错误同样要纠正，否则下一轮会按错误的现象去定位 |
| R79 | 用户报告的两个缺陷：① 付费分享页报 `error:1E08010C:DECODER routines::unsupported`；② 等待支付页的「我已完成支付，立即查询」点了没有任何反应 | ① 新增 `server/pem-key.js`（PEM / DER 密钥结构判定**唯一实现点**：真解析 PKCS#8 / PKCS#1 / SEC1、SPKI / PKCS#1，`classify()` + `explain()`）；② **L1**：`payment-gateway.js` 的 `normalizePrivateKey` / `normalizePublicKey` 改为先解析后归一化，解不出来才退回旧形态；③ **L2**：`payment-providers.js` 的 `privateKey` / `publicKey` 两个校验器改为真解析 + 要求 RSA，`maskSecret` 的 PEM 判定同源；④ 两处 `hint` 更正（不再承诺 SM2、写明 PKCS#1 / PKCS#8 与裸体都接受）；⑤ `share-routes.js`：`finalizeOrderThrottled` 返回结果码、`/pay/check` 用 `?checked=` 如实回报、等待页补「重新发起支付」、新增 `?restart=1` 落到渠道选择页（等待 / 失败 / 二维码三处「重新支付」不再自环）、`payingPage` 增加可选 `checked` 参数；⑥ 1 个新护栏文件（`tests/audit79-regressions.test.js` 7 条）+ 7 条反向对照（`R79-01a`~`R79-07a`）；⑦ 版本 `1.9.13` → `1.9.14`（五个落点全量同步） | **① 「`MIIE` 开头」是个陷阱**：PKCS#8 与 PKCS#1 的裸体前缀**完全相同**，任何基于前缀的判断都必然错一半，而错的那一半正是支付宝密钥工具与传统 `openssl genrsa` 的分界 —— 于是「有人能用、有人不能用」，看起来像环境差异。判据只能是**真解析**。**② 保存侧的近似判据与签名侧的分叉是同一个缺陷**：两边各自觉得「已经校验过了」，实际上都不解析。按 ADR-0006 把判定下沉到 `pem-key.js` 之后，两处才共用一份**会失败**的判据。**③ 一处真实踩到的误分类**：`createPublicKey(私钥)` 会**成功**（OpenSSL 从私钥导出公钥），最初「先试公钥」的实现把 EC 私钥报成「你贴了公钥」—— 提示方向完全相反。`classify()` 因此固定「先私钥后公钥」。**④ 「没反应」的根因是**判据把三种结果压成一种**：`boolean` 返回值让「刚查过还是没到账」与「一次都没查」无法区分，调用方只能一律当作无事发生。**⑤ 「如实回报」比「多查几次」更重要**：节流窗口内强行出网会把网关查单配额刷光（R8-20 的原意），所以选择**不绕过节流**，而是把「上一次查询在 N 秒前、这次没重复查」说清楚 —— 边界是**不得把「没查」说成「查了没到账」**。**⑥ restart 是绕过状态判断的开关**，必须显式加「已支付不受影响」的反向守卫，否则会诱导已付款用户二次付款。**⑦ 三处「重新支付」原本都是死路**：`href="/s/ID"` 在 `pending` / `failed` 时会命中同一分支，页面原样重画 —— 这类「链接指向自己」的缺陷在页面上表现为「点了跳一下又回来」，很容易被当成浏览器缓存 |
| R80 | 用户报告：「填写正确的应用ID、私钥、公钥、网关地址，点击『立即支付』没有任何反应」 | 六条成因各自修（均属「不会留下可读痕迹」的失败路径）：① `POST /s/:id/pay` 的三条**静默 303** → `!ps.effective` 带 `?e=pay-off`、密码票据失效**直接渲染密码页**并说明、`payer.state==='paid'` 带 `?e=paid`；新增 `PAY_E_NOTICE` 白名单 + `payNoticeFromQuery()`（不收也不回显自由文本），`GET /s/:id` 三个分支消费该原因码；三条各记一条审计日志；② 跨站拒绝**按 `Accept` 分流**（`rejectCrossSite()`：表单拿 `statePage(res,'crosssite')`，`fetch` 拿 JSON）；③ 支付宝下单前 `alipaySignType()` 校验，`SM2` 直接失败并指出改 RSA2（`rsaSign()` 只有 RSA / 非 RSA 两档，旧实现会发出「`sign_type=SM2` + RSA 签名」的废票）；④ 新增 `gatewayBase()` 剥掉网关地址里的 `#` 片段（否则查询串整串落进片段，浏览器不发给网关）；⑤ `createCharge` 说成功却没给收银台（`kind`/`url` 不完整）时**当场报错**，不再降级到「等待支付」页；⑥ `public/js/pay-poll.js` 增加「提交看门狗」（按钮禁用 +「正在创建支付订单…」+ 12 秒兜底提示），并让轮询以 `#pay-state` 为开关；⑦ 1 个新护栏文件（`tests/audit80-regressions.test.js` 11 条（含**假 DOM 里真跑** `pay-poll.js` + 1 条正常路径正向守卫））+ 10 条反向对照（`R80-01a`~`R80-10a`）；⑧ 版本 `1.9.14` → `1.9.15`（五个落点全量同步） | **① 「点了没反应」不是一条原因，而是一个**观感类别**：同一句话可以由「服务端静默返回」「浏览器根本没提交」「提交了但页面要等 10 秒」「跳过去了但网关收到空请求」四种完全不同的机制产生，而它们在任何一层日志里都长得一样 —— 排查时必须**先把「谁没说话」分层定位**（有没有收到请求 → 走到哪条分支 → 网关收到什么），否则很容易反复去改一个本来正确的判据（R27-03 就是这么修了一半：判据对了，呈现形态还是裸 JSON）。**② 静默 303 比报错更贵**：报错会被人报上来，静默重画只会让人重复点击。凡是「拒绝用户的一次明确动作」的分支，都必须给出与该动作对应的说明 —— 文案要回答「你刚才那次点击为什么不算数」，而不是复述系统状态。**③ 「保存成功」不等于「能付款」**：SM2 与带 `#` 的网关地址都是**配置层合法、运行层必然失败**的形态，而失败发生在对方服务器上（支付宝的错误页 / 空白页），本地日志一片正常。这类「本地全绿、远端全红」的配置面必须在**下单前**做本地可行性校验，把错误留在自己这边。**④ 判据要落在「实际被执行的那一层」的又一次应用**：`pay-poll.js` 的护栏没有用「源码里有没有这句话」，而是用 `vm` + 假 DOM + 可控 `setTimeout` **把它真跑一遍**，断言按钮 `disabled` 与提示文案的**实际变化** —— 静态文本断言只能证明文件里有那句话，证明不了提交时它会显示。**⑤ 渐进增强是分享页唯一安全的增强方式**：分享页 CSP 禁内联脚本，任何「必须有 JS 才能用」的交互都会在脚本被拦时整体坏掉；因此看门狗只做「让等待可见 + 超时给提示」，**禁用脚本时表单照旧能提交**。**⑥ 两段行为共用一个文件时必须显式分开关**：`pay-poll.js` 同时服务「等待页」与「付费页」，若照旧无条件轮询，付费页会在**订单还不存在**时每 3 秒打一次 `/pay/status`；两个 DOM 挂点（`form[data-pay-submit]` / `#pay-state`）就是这两个开关。 |
| R81 | 用户报告：「支付时提示"没有收到服务器的响应：订单可能没有创建成功"。后台支付订单显示"支付中"。是凭证问题还是系统问题？」 | 4 条代码修复 + 1 个新护栏文件：① `server/payment-gateway.js` 的 `fetchWithTimeout` 改为**整体超时**（连接 + 响应头 + 响应体同在一个 `try` 里，计时器直到读体完成才清），返回物从裸 `Response` 改为 `{ok,status,body}`，7 处出站调用点同步改造；按阶段给两种文案（`网关连接超时` / `网关读取超时`）；② 新增 `CHARGE_TIMEOUT_MS = 9000` 与 `deadline` 透传：`createCharge` 给整条下单链路一个**绝对截止时刻**，`wechatCreate` / `paypalCreate`（含 `paypalToken`）共用它 —— 9 秒 < 前端 12 秒看门狗，服务端一定先给结论；查单不设总预算（3 秒轮询、无人盯着，不该因慢而放弃确认）；③ `GET /s/:id/pay/status` 新增 `?probe=1` **只读探针**（只回答本地账本状态 + 渠道，绝不触发网关查单）；④ `public/js/pay-poll.js` 的 12 秒看门狗改为「先确认再说话」：按 pending / none / failed / paid / unknown 五种状态给五条不同文案，**删掉**「订单可能没有创建成功」这句错误断言；⑤ `share-routes.js` 更正 R21-06 处那句与实现相反的注释（「换渠道属于新单」实为「换渠道不等于新单」）；⑥ 1 个新护栏文件（`tests/audit81-regressions.test.js` 9 条）+ 8 条反向对照（`R81-01a`~`R81-09a`）；⑦ 版本 `1.9.15` → `1.9.16`（五个落点全量同步） | **① 与凭证无关，先排除掉它再谈系统**：凭证错会在本地签名阶段就报错（R79 的 `1E08010C`），而支付宝下单是**纯本地拼串 + 302**、一次出站都没有 —— 能让「支付宝下单」卡住的只有链路（反代 `proxy_read_timeout` 截断 POST），绝不会是 appId/私钥/公钥/网关地址填错。**② 「订单停在支付中」是一条强证据链**：`paymentOrders.create()` + `res.cookie()` + `statsStore.addLog({action:'share.pay'})` 全在 `await paymentGateway.createCharge()` **之前**同步执行 ⇒ 订单存在即证明「请求到了、过了限流与闸门、进了 createCharge」，而 `markFailed` / `markPaid` 都没跑 ⇒ 只可能**卡在 createCharge 里面**。这条推理把「前端一句话」和「后端一个状态」接上了，也是本轮所有判据的骨架。**③ `finally` 里 `clearTimeout` 是个陷阱**：它看起来「一定会执行、很安全」，但 `fetch()` 的 promise 只覆盖到**响应头** —— `finally` 因此比调用方以为的时间点早得多地跑掉，剩下的读体完全脱管。**超时的作用域必须与「这次操作」同边界**，而不是与「某个 await 表达式」同边界；同类写法（`Promise.race` + 清理、`AbortSignal.timeout` 但只在头阶段 await）在本项目其余出站路径上都要复查。**④ 两个数值必须**排序**：「服务端给自己的预算」< 「浏览器给服务端的等待」**。旧配置是 10 秒（实际 300 秒）对 12 秒 —— 名义上刚好、实际上反了。任何「前端超时兜底」都必须能指出**它所兜的那件事最坏要多久**，否则它就是一条会撒谎的 UI。**⑤ 看门狗的结论只能来自服务端**：`12 秒没动静` 这件事本身**不含任何信息**（可能是没提交、可能是提交了没回、可能是回了但页面正要跳走）。让浏览器凭「没动静」断言业务结论，等于在没有证据的地方编造证据 —— 正确做法是**问一句再说话**（`?probe=1`），并把「问不到」也如实当成一种答案。**⑥ 顺手纠正一处与实现相反的注释**：R21-06 的注释写着「换渠道属于新单（走上面的 else 分支）」，而代码与 `tests/audit21-regressions.test.js` 都明确是「复用在途订单并沿用其**原始**渠道」。注释写错比没有注释更贵 —— 它会让下一轮排查的人**照着错的模型**去定位（本轮就是这么先怀疑了渠道错配）。 |
| R82 | 用户要求的三条行为变更：「① 更换渠道即建立新的订单；② SM2 在保存时即拒绝；③ 历史在途订单全部标为失败」 | 4 处代码改动 + 1 个新护栏文件：① `server/share-routes.js` 复用条件加 `pendingOrder.platform === platform`，换渠道时 `markFailed` 原单 + `releaseCouponForOrder()` + 审计日志，然后走既有建单分支；`chargePlatform` 的注释同步更正（现恒等于 `platform`，保留变量是为钉住「回调地址与实际下单渠道同源」）；② `server/payment-providers.js` 枚举支持 `disabled` / `disabledReason`，支付宝 SM2 选项置 `disabled: true` 并改写 hint；`public/js/paysettings.js` 渲染 `<option disabled>` 且不把 disabled 项渲染成 selected；③ `server/payment-orders.js` 新增 `sweepStalePending()`（一次性、标记 `staleSwept: 'R82'`、`loadFailed` 判据在 `load()` 之后、只改状态不删记录），`server/index.js` 在 `listen` 前调用并打印/记日志；④ `tests/audit21-regressions.test.js` 的 R21-06 改为用**真实订单 + 真实票据**双段验证（换渠道建新单 / 同渠道复用），`tests/payment.test.js` 的 SM2 断言翻转；⑤ 1 个新护栏文件（`tests/audit82-regressions.test.js` 9 条）+ 8 条反向对照（`R82-01a`~`R82-08a`）+ `R21-06` 条目重述（落点从「写 platform」改为「用别的渠道拼回调地址」）；⑥ 版本 `1.9.16` → `1.9.17`（五个落点全量同步） | **① 「换渠道」这条改动最容易漏的不是下单，是券**：`validateForUse()` 对 `perUserOnce` 的券读 `c.identities` 判「是否用过」，而核销是下单时 `couponStore.consume()` 记的 —— 换了渠道却只建新单、不退旧单的券，同一张券在新单上会被判 `already_used`，用户**换个支付方式就直接付不了钱**。所以「换渠道」必须是一个**三步原子动作**：收尾旧单 → 退券 → 建新单，三步缺一是功能倒退。R82-02 用「券的 `used` 净额必须仍是 1」把这三步钉成一个可观测的数字（少了退券是 already_used 卡死；退了不退又重复核销是 2）。**② 推翻一条旧护栏时要**换落点**，不是删掉**：R21-06 的「回调地址必须与原渠道同源」在 R82 之后**结构性成立**（`chargePlatform` 恒等于 `platform`），原来的变异撤掉也全绿 —— 但那条不变量本身没过时，只是成因没了。处理方式是保留条目、把变异挪到「用别的渠道拼回调地址」上（`available[0]` 这种退化写法很常见），并把「为什么换落点」写进条目注释；直接 `retired` 会让台账里凭空多一条「不可证伪」的记录，而这个仓的退役上限是 5 条 —— 上限存在就是为了逼人先想清楚「是真不可证伪，还是只是落点选错了」。**③ 「保存时拒绝」的价值在于**错误留在自己这一层**：同一件事在保存层拒绝是「改一下再存」，在下单层拒绝是「填完整页、保存成功、某天点付款才炸」。判据同源（`options[].disabled` 一个标记，服务端校验与前端置灰都读它）才能保证两层不漂。**④ 一次性迁移的三条纪律**：**只跑一次**（标记写固定标签，写成版本号会让每次升级都误杀当时真在途的订单）；**读不到就不写**（`loadFailed` 时整体跳过，否则「空表 + 已扫过」永久落盘，等文件修好这批订单再也不会被清）；**判据读调用之后的状态** —— 本轮实现第一版把 `if (loadFailed)` 写在 `load()` **之前**，首次调用时标志还是初始 `false`，于是文件损坏时会回答「清理成功、0 笔」（R82-07 当场抓住）。**⑤ 一次性改状态而不是删记录**：`markFailed` 不是终态，网关通知仍能把它推回 `paid`（`finalizeOrder` 只对 `paid`/`refunded` 提前返回）—— 万一有人恰好在升级这一刻付款，钱不会因为这次清理而丢。 |
| R83 | 用户反馈：「订单已经创建成功（后台状态：支付中），卡住的是「从本页跳转到支付平台」这一步，不是下单失败」 | 2 处代码改动 + 1 个新护栏文件：① `server/share-routes.js` 的 `POST /s/:id/pay` 成功路径**不再** `res.redirect(302, charge.url)`（跨域 3xx）—— Chrome / Safari 会把 CSP 的 `form-action 'self'` 施加到「表单提交后的每一次重定向」上，整次导航被拦掉，控制台报 `Refused to send form data to ... form-action 'self'`，而订单早已建好（后台「支付中」）；改为 `jumpPage()` 渲染**同源**中转页（`renderPage` 新增 `refresh` 参数 ⇒ `<meta http-equiv="refresh">`），配一个 `rel="noopener noreferrer"` 的可点链接兜底，零脚本（CSP 不允许内联脚本）；② 新增 `safePayUrl()`：收银台地址只接受 `http(s)://` 并拒绝全部控制字符（`javascript:` / `data:` 进 `<a href>` / meta refresh 等于在本站源执行脚本；转义防不住这一类），非 http(s) 视同「渠道没给可用的收银台地址」⇒ `markFailed` + 退券 + 错误日志 + 页面说清原因；`form-action 'self'` **原样保留**（网关地址用户手填、可换平台，无法枚举；放宽等于拆掉防护面） | 新增 `tests/audit83-regressions.test.js` **7 条**：成功路径必须 200 同源页且**不带 `location`**（`curl` 与 Firefox 下 302 一切正常，只有状态码+跳转形态这一层判据抓得住 Chrome 的拦截）/ `javascript:`·`data:`·`vbscript:` 三种坏地址必须被拒且订单标失败 / `https://evil.example/"><script>` 不得逃出属性（断言转义成 `&quot;&gt;&lt;script&gt;`）/ 源码结构「处理器不得把 `charge.url` 交给 `res.redirect`」/ CSP 仍为 `form-action 'self'` 且不含支付域名 / 二维码渠道不受波及（仍渲染同源二维码页、无 meta refresh）；配套反向对照 `R83-01a`~`R83-06a`（6 条，逐条实跑） |
| R84 | 外部输入：《支付模块检查报告》（3 中危 + 4 低危），用户要求「分析其问题是否存在，存在的修复，不存在的写入 Audit_illusion_report.md」 | **七条全部成立**（逐条对照真实代码 + Node 单点复现），故无一条进幻觉报告；6 处生产代码改动：① `server/payment-gateway.js` 新增 `alipayRawNode()` + `alipayVerifySync()`，`alipayQuery()` 改为「先取原文 → 独立 `JSON.parse` → **读业务字段之前**验签」，验不过按 `state:'error'` fail-closed（同步响应签的是 JSON **原文切片**，重新序列化会改字节 ⇒ 不能复用 `alipayVerify`）；② 新增 `paypalEventCheck()`（事件类型白名单 + `transmission_time` 偏 5 分钟记 warn 不拦），在**出站验签之前**调用；③ `fenFromYuan()` 空串/空值返回 NaN；④ `paymentOrders.isDegraded()`（先 `load()` 再读标记）+ `POST /s/:id/pay` 命中即拒绝建单并明示「已暂停收款」+ `GET /api/payment/orders` 回 `degraded` + `public/js/ordermgr.js` 渲染红色横幅（`degradedBanner()`）；⑤ 轮询推进条件 `order.platform === 'wechat'` 放宽为「任何 pending 订单」；⑥ `share-routes.js` 复用分支新增 `submittedCode/pendingCode/couponChanged`（**换券即新单**，与换渠道同构三步原子；旧单占着同一张券时**先退再验**）+ `findTwinPending()`（5 秒内同 IP/渠道/券/价的重复提交合并成一笔，两次响应都签票据） | 新增 `tests/audit84-regressions.test.js` **13 条**：伪造 `TRADE_SUCCESS` 必须被拒（旧实现会 `markPaid` ⇒ 免费拿货）/ 真签名必须通过且**按重新序列化后的内容签的必须失败**（报告那条建议的翻车点）/ 支付宝在途订单轮询必须真查单且**已支付的不再查**（对照侧防恒真）/ 账本不可用时拒绝收款且留 `error` 日志 / 损坏文件上 `isDegraded()` 为真且**不覆盖原文件**（另起进程）/ 接口 `degraded` + 前端横幅 / `fenFromYuan` 空值 NaN 且真实 0 仍是 0、文案分叉 / 换券另建新单 + 旧券必须退回 + 同券仍复用 / 5 秒内重复提交只一笔且两次响应都带票据、**换渠道不被合并**（对照侧）/ PayPal 事件白名单矩阵 / 非白名单必须 403 且**一次验签都不发** / 横幅文案；配套反向对照 `R84-01a`~`R84-13a`（13 条，含 `R84-08b`，逐条实跑核对「红的是哪一条」），并**重锚** `R82-01a`/`R82-01b`/`R82-02a`/`R82-03a`（判据形态变了；`releaseCouponForOrder()` 新增第二个调用点后，6 空格是 8 空格的**真后缀** ⇒ 单行 anchor 会命中两处，改跨行）；台账 858 → **871**（退役仍 5） |
| R85 | 用户反馈：已能正常打开支付宝收银台，但**收银台显示的订单号与实际订单号不符**，怀疑「之前把订单号改长了，支付宝那边还是旧的短号」 | **定性：订单系统没有残留旧号。** `payment-gateway.js` 三处下单（支付宝 / 微信 / PayPal）传的 `out_trade_no` 一直是订单的内部主键 `id`（16 位），**从来不是** 36 位 `orderNo` —— 后者是 `server/order-no.js` 生成、用于「恢复购买」的业务凭证，微信 v3 对 `out_trade_no` 有 **32 位上限**，把 36 位塞进去会让微信渠道直接不可用、且异步通知回来的 `out_trade_no` 再也对不上订单。真正缺陷是**可见性**：网关侧那个短号在买家能看到的任何页面上都不存在 ⇒ 买家在收银台看到的号在站点上无处核对、管理员也没法按它去商家后台检索。改动**只补可见性、支付链路一行不改**：① `orderNoBox()` 改为接收**订单对象**（原来收字符串，传 `orderNo \|\| id` 就必然丢短号），在 36 位号下方并列出「商户订单号」并说明「同一次支付、售后核对时用它检索」，5 个调用点全部改传对象；② `public/js/ordermgr.js` 订单表新增「商户单号」列（`gatewayNoCell()`，取 `id`、带 `out_trade_no` 说明的 `title`与复制按钮 `copyGatewayNo()`：剪贴板失败时回退到弹窗手选，不用内联 `onclick` 以符合 CSP）；③ `public/index.html` 付费订单卡片的说明补一句「两个号分别是哪个」 | 新增 `tests/audit85-regressions.test.js` **5 条**：中转页 / 二维码页 / 等待页三处都必须同时出现 36 位号与收银台上的那个短号，且短号必须**等于真正发给网关的 `out_trade_no`**（不是另算一个）、「商户订单号」整页只出现一次（防重复渲染变丑）；另加源码**计数**断言 —— 4 个渲染点都必须传订单**对象**（只改一处不算修好）；前端 `gatewayNoCell()` 必须给 `id`、**不得给 36 位号**（两列同一个号等于没这一列）、空值给占位符、进 HTML 前转义，并断言表头 / 单元格 / 点击分支三处真的接上了（纯函数全绿而界面少一列是最容易漏的一层）；配套反向对照 `R85-01a`~`R85-04a`（4 条，实跑核对红的是哪一条：`01a` → 3 红、`02a` → 2 红、`03a`/`04a` 各 1 红）；台账 871 → **875**（退役仍 5） |
| R86 | 用户反馈：**已支付完成的订单号可以被别人用来取回下载权限**。要求加一条限制：订单若是在**已登录账号**下完成的，必须登录**原有账号**才能取回；**未登录**完成购买的订单在任何情况下都能用订单号取回 | 一条规则、一处判据（`paymentOrders.claimForLink()` 新增 `viewerId`）：① **闸门住在唯一判定点**：在 `paid` 分支内、**额度判定之前**插入账号归属校验 —— 订单快照的 `userId` 非空（登录态成交）时 `viewerId` 必须与之相等；`userId` 为空（游客成交）时**不设任何限制**（它没有「原账号」可依，上锁等于把凭证作废）。判定只在这一处，路由只负责把「当前登录的是谁」（`shareUser()`）传下去。② **两种拒绝分开**：未登录 → `need_login`；登录了但不是买主 → `wrong_user`；两者都给 `order: null`，且文案**不回显归属账号的 id / 用户名** —— 只回答「你登的不是买它的那个号」，不回答「这单是谁买的」。③ **路由层给按钮而不是只有文案**：`restorePage()` 新增 `loginHint`，`need_login` 渲染「去登录」、`wrong_user` 渲染「切换账号」，两者都带 `next` 回本条分享（登录完回来订单号还在手里，再输一次即可）。④ **两类都不计入「连续输错」**：与 `used_up` 同理 —— 订单真实存在、钱也真付过，只是请求者身份不对；计入的话，买主换了设备、忘了先登录、多试两次就会被封 24 小时，挡住的是主人而不是猜号者。⑤ **恢复页提前告知**：`pay-note` 补一句「在登录状态下完成的订单，须用购买时的同一个账号取回」，避免用户输完号才第一次知道这条规则 | 新增 `tests/audit86-regressions.test.js` **13 条**，分三层落点。**判定层（7 条）**：游客订单三种请求者（未登录 / 显式空串 / 已登录他人）全部放行；登录态订单未登录 → `need_login` 且 `restoreCount` 不变；换账号 → `wrong_user` 且文案不含归属者 id 与用户名；原账号放行并回传订单；**闸门先于额度**（额度已用完 + 错账号必须报 `wrong_user` 而非 `used_up`，否则「这单存在且有主」就泄露给陌生人了）；错账号连试 3 次后原账号那一次机会仍在；未支付 / 已退款仍先报各自原因（证明闸门没有插到 `paid` 分支之外，否则用户会被从「去付款」误导到「去登录」）。**HTTP 层（4 条）**：未登录 → 400 + 「去登录」**按钮**（判据钉在 `class="btn primary"` + `?next=` + 文本三者同形 —— 只查「去登录」三个字会被提示文案「请**先登录**…」满足、只查 `?next=` 会被页头那颗 `.tb-link` 登录链接满足，两种都是假绿：实测「不给按钮」的变异下它们照样全过）；换账号 → 400 + 「切换账号」按钮；原账号 → 303 并签发票据；**游客订单未登录仍 303**（回归保护：本次限制不得收紧原有行为）。**计数层 + 文案（2 条）**：`maxFails=2` 时连试 3 次归属不符仍不封禁，同时用「不存在的订单号」反证计数器没有被整体关掉；恢复页 `GET` 一开始就含「登录状态」与「同一个账号」。配套反向对照 `R86-01a`~`R86-07a` **7 条全部实跑**（`fail=2/2/5/1/1/2/1`），并重锚 `D1-07`（README 精简版删掉了「带 `--domain` 的第二处一键命令」，原锚点失效即等于没登记）；台账 875 → **882**（退役仍 5） |
| R87 | 外部审计《Kepler 全模块安全与功能审查报告》（2026-10-25，GLM-5.3，基准 v1.9.21，13 个模块 / 92 条发现）逐条复核 | 15 条确认成立并修复：① **可信代理先判对端**（`proxyPeerTrusted()` + `TRUST_PROXY_FROM`，默认回环 / 私网）—— `TRUST_PROXY=1` 此前是唯一判据，绕过反代直连应用端口自带一个 XFF 就能冒充任意 IP；② 分享侧三处 Cookie 的 `Secure` 改用与主会话同一判据 `cookieSecure()`；③ Azure 下载移植 R78 空闲看门狗（顺带补 S3 缓冲分支）；④ `normalizeRule` 归一 `methods`；⑤ `/users/me` 口令校验限流 + `/users/:id` 自助改密验当前密码；⑥ 备份导入落库前端点解析级复核 + `apply()` 改 async 并 await `flush()`；⑦ 5xx 不回显原始 `err.message`（`err.expose` 约定）；⑧ rename / move 目录分支改 `deleteKeysAll()` 按快照删源；⑨ `sliceCopyFile` 开工前预检 10000 片；⑩ 限速并发计数改成「真有数据流过才登记」；⑪ `bufferStream` 补听 `close` 结算提前断开；⑫ `normalizeKey` 按路径段判 `..` 并拒 NUL；⑬ 三处前端转义；⑭ `/api/health` 只下发 basename。新增 `tests/audit87-regressions.test.js` **17 条** + `R87-01a`~`R87-15a` **15 条**反向对照（逐条实跑，`fail` 全 = 1），另重锚 2 条旧对照 | **① 报告的前提必须逐条复核 —— 本轮最贵的一条教训**：报告把「WebDAV 透明解密绕过查看密码」定为 **P1**，而它其实是 **R22-04 明文写进 README 与本文档的设计取舍**，且 `audit22` 有一条**双向**护栏同时钉住「代码事实」与「文档口径」。照单修复会当场把那条护栏打红，并让「设了访问密码后 WebDAV 上的密文一律不可读」—— 功能倒退。同理 `CPN-S1`（匿名身份 = IP+UA）是 R62 写明的刻意近似、`DAV-S1`（整桶读写）是「挂载当前激活桶」这个设计目标本身。⇒ **审计报告的第一个待验证项是它自己的前提，不是它列出的代码行**。**② 报告的计数也不可信**：13 个子代理并行审计后未去重，`INF-S1`/`GRD-S1`/`DAV-S2` 是同一处 `forwardedClientIp()`，`GRD-F2`/`SHR-S3`、`PAY-F3`/`CPN-F4`、`FS-F3`/`INF-F4` 各是一处缺陷两条编号，去重后约 88 条；`SHR-S3` 这个编号本身是错的（分享模块没有这条）。**③ 撤掉修复必须变红的那个观察量，得真的能被观察到**：Azure 看门狗的首版反向对照 `fail=0` —— 桩 `fetch` 忽略 `AbortSignal`，于是「计时器掐断」这件事根本没发生，撤不撤修复都一样。桩必须尊重被观察机制的输入（`signal`），否则测的是桩不是产品。**④ 提前关闭的 Promise 不能裸 `await`**：`bufferStream` 那条用例若直接 await，旧实现下会**永不结算**，变异验证表现为「跑到这儿就不动了」而不是「变红」—— 必须与一个 **ref 的** 定时器赛跑（`bufferStream` 内部的定时器都 `unref()` 过，撑不住事件循环）。**⑤ 新增同形代码会老化别处 anchor**：`PUT /users/:id` 复制了 `/users/me` 的 `const current = String(b.currentPassword …)` 一行，`R21-09` 的单行 anchor 立刻出现 2 次（`replace` 只替首处 ⇒ 变异可能打到另一处）；`flush()` 改 `await` 则直接让 `R38-02x` 的 anchor 失效。两处都重锚，并回头验证仍然变红。**⑥ 改一条旧护栏的判据形态时，要保住它的意图**：`SEC-10` 原本静态断言「分享 Cookie 写了 `IS_DEPLOY`」，本轮判据升级为 `cookieSecure()` 后该断言必然变红 —— 处理方式不是删掉它，而是把判据换成新形态并**补一条反向断言**（不得再出现旧写法） |
| R88 | 用户需求（非审计轮，R88）：为优惠券系统新增「满 xx 减 xx」 | ① **`coupon-store` 新增 `minSpendFen`**（使用门槛，整数分）：`0` = 无门槛（原有直减券语义），`minSpendFen` + `amountFen` 合起来即「满 xx 减 xx」；落盘归一抽出 `clampMinSpend()` 作**唯一实现点**（`generate` / `update` / `bulkUpdate` 三处共用）；② **`limits.parseCouponMinSpendInput()`**（元 → 分）：留空 / `0` = 无门槛、负数与非数字拒绝、超上限拒绝；③ **`validateForUse()` 新增门槛判定**：原价 < 门槛 ⇒ `below_threshold`，文案按本券实际门槛填值（`fillText({min})`），**位置排在 `no_price` 之后**；④ **管理端**：生成表单新增门槛输入、列表「优惠」列改由 `fmtDiscount()` 渲染成「满 X 减 Y」（表格与删除确认共用）、`POST /coupons` 与 `PUT /coupons/:id` / `POST /coupons/bulk` 均接受 `minSpend`（元）；⑤ **6 条护栏**（`tests/coupon-threshold.test.js`）+ **6 条反向对照**（`R88-01a`~`R88-06a`，台账 897 → **903**） | **① 「加一种券类型」是这里最自然的错解**：`type` 回答**适用范围**（`any`/`links`/`users`），门槛回答**这一单够不够格**，两者是正交维度。把「满减」做成第四种 `type` 会立刻与 `links`/`users` 互斥 ——「只在某个链接上满 50 减 10」就表达不出来，正是 R62 文件头 ③ 刻意避开的错误（把并列选择做成互斥开关）。`R88-04` 专门钉住「限链接 + 满减同时生效」。**② 判定顺序是有语义的**：免费链接上填一张满减券，该答「当前分享链接无需付费」而不是「未满 50 元」—— 后者暗示「多买点就能用」，而这里没有可买的东西。`R88-04a` 把门槛判定挪到 `no_price` 之前即变红。**③ 门槛不参与金额封顶**：满 20 减 50 是**允许**的配置，在原价 20 上仍走「优惠封顶到原价 − 1 分」⇒ 优惠 19.99 / 应付 0.01。让门槛去缩减免金额会算出 0 元单，网关直接拒收。**④ 又一处「假值也是合法指令」**：`minSpend: 0` 是「把满减券改回无门槛」，和 `disabled: false` / `maxUses: 0` / `expireAt: null` 完全同构 —— `buildPatch` 必须判「字段是否出现」。用真值判断的表现是：界面点了保存、返回成功、门槛还在（`R88-05a`）。**⑤ 可选字段坏了要降级，不要丢记录**：门槛归一遇到非正数视为无门槛、超上限 clamp；与 `amountFen` 的处置**相反**（金额坏了才丢整条）—— 门槛坏了的券还能当直减券用，丢掉等于因为一个可选字段把一张已发出去的券作废。**⑥ 小于 1 分不许静默归 0**：`Math.round(0.004 * 100) = 0` 会把「我填了门槛」变成一张无门槛券，而界面显示「已保存」（`R88-01a`）。 |
| R89 | 用户需求（非审计轮，R89）：存储桶按用户隔离 —— 「一个存储桶，任何对其可见的用户登录都可以随意上传、下载、删除。应改为：每个用户只能看到和管理自己的那一部分」 | ① **桶内前缀命名空间 `u/<userId>/`**（`server/user-space.js` 为唯一实现点）：用**不可变用户 id** 而非用户名（用户名可被管理员改，改完即「文件还在、人找不到」）、根**必须带尾斜杠**（`startsWith('u/abc')` 会把 `u/abcd/` 一并放行，是静默越权）、`toAbs` / `toRel` / `isInside` / `assertOwned` 方向唯一；② **两个收口点**：`configStore.effective()` 产出 `spaceRoot`（只有它产，`effectiveForBucket()` **刻意不产** —— 分享下载 / 桶用量 / 会话清理一律绝对语义），`s3.js` 的 `p()` 首行 `assertScoped()` 兜底（收集 `Key` / `Prefix` / `Marker` / `CopySource` / `Delete.Objects[].Key`，越界一律 404 且与「不存在」同一句文案）；③ **`routes/fs.js` 19 个端点**统一走 `absKey()` / `relKey()` / `relPayload()` / `relResults()` 四个 helper（进收口点加根、出收口点剥根，客户端看到的世界不变），⚠️ 其中 `/fs/tree` 是**独立的第二条列举入口**、`/fs/upload/init` 的 key 曾漏加根、`/fs/list` 的**缓存命中分支**曾漏剥根 —— 三处都是本轮实测抓出来的；④ **`request-context.spaceRoot()` fail-closed**：角色是 `user` 却没有 `userId` 时**抛错**，绝不回退成「无作用域 = 看全部」（与 `sessionRole()` 的宽松回退刻意不同）；⑤ **分享快照落绝对 key**（`links.js` 的 `toSpacePaths()`）：分享页无会话，快照存相对 key 会让链接建得出来、点开恒 404；⑥ **WebDAV 账户可绑定站点用户**：`authenticateWebdav()` 带出 `ownerUserId`，`auth.js` 据此 `runWith({ role: 'user' })` 一处接线、PROPFIND / PUT / MOVE / COPY 全链路生效，`app.js` 的 `spaceKey()` / `spaceHref()` 是收口点；未绑定 = 管理账户（老账户不因升级失明），**绑定的用户被删除时连带吊销账户**（否则「删人」= 给凭据提权），绑定 id 写错当场 400 而非静默回退；⑦ **管理层看全部**（`spaceRoot` 为空串，行为与改造前一致）、**存量数据零搬迁**（桶根裸 key 不属于任何用户空间，普通用户在结构上无法表达）；⑧ **10 条护栏**（`tests/audit89-regressions.test.js`，纯函数 / 上下文 / 咽喉 / 路由 / 分享 / WebDAV / 生命周期七层）+ **14 条反向对照**（`R89-01a`~`R89-11b`，台账 903 → **917**） | **① 三条被排除的路线**：靠对象元数据做 ACL（`getBucket` 不返回自定义元数据 ⇒ 无法分页，1 万对象 = 1 万次 HEAD；外部工具写入 / `CopyObject` / 改名 / 存量对象全对不上）、每用户一个桶（桶是**计费与凭据**单位，腾讯云按桶最低计费、自注册走不通）、给所有 `requireConfig()` 调用点加参数（几十处、必然漏改）。**② 「绝对 key / 相对 key」必须只有一个方向**：任何「有时绝对、有时相对」的分支最后都会演变成「把根写进了文件名」（`u/abc/u/abc/a.txt`），故 `toAbs` 对已带自己根的入参不叠第二层、对**别人的**绝对前缀则当作相对路径收进自己空间。**③ 缓存里存的必须是绝对 key、出口才剥根**：管理员看 `u/alice/` 与 alice 看根目录命中的是**同一条缓存**，存相对 key 会让管理员看到「少了前缀」的路径 —— 一类只在换身份时出现、几乎不可能手工测出来的串味。**④ 「空字符串」在加根之后变成了合法指令**：`absKey(cfg, '')` 等于空间根，于是 `/fs/delete` 传空路径会递归删空整个空间、`/fs/stat` 变成「统计我整个空间」—— 四处空值守卫改判**相对入参**。**⑤ 归属判据用 id 不用用户名**：`uploadSessions` 新增 `ownerId`，`assertSessionOwner()` 改判 id，但 `list()` 仍对升级前落盘的老会话退回比 `createdBy`（只传 ownerId 会让可续传项从列表消失、分片永久悬空计费）。**⑥ 账户生命周期是攻击面**：`removeUser()` 曾会留下 `ownerUserId` 指向不存在用户的 WebDAV 账户，一旦解析回退成「未绑定」就是提权 —— 故连带删除 + 解析侧 fail-closed 双层。**⑦ 本轮的三次「护栏自伤」**：新 helper 名 `keyOf(` 撞上 `listCache.keyOf` 的既有护栏正则（改名 `spaceKey` 而不是放宽护栏）、两条 anchor 因新注释夹在代码行之间而剥注释后失配（把说明移到 anchor 之外，并在注释里写明「这个位置被护栏绑定」）、5 条旧 anchor 因调用点改写而失效（逐条按新源码重锚，语义不变）。 |
| R90 | 历史待办收口（非审计轮，R90）：PAY-F1（不关网关单 ⇒ 双份付款）/ FS-S1（上传并发内存闸门）/ 改用户名不校验当前密码 / `ops.js` 调未定义的 `currentItems()`（最高优先级） | ① **PAY-F1**：`payment-gateway.js` 新增 `closeCharge()`（支付宝 `alipay.trade.close`、微信 `POST /v3/pay/transactions/out-trade-no/{id}/close`、PayPal **无 cancel/void 端点**故如实回 `unsupported`），返回五档状态 `closed` / `not_found` / `paid` / `unsupported` / `error`；`share-routes.js` 换渠道 / 换券时**先关网关单、再改本地状态、最后才建新单**；关单结果落到订单上（`paymentOrders.setCloseState()` 的 `closeState` / `closeError`，与 `status` 正交）；② **FS-S1**：新增 `server/upload-gate.js`，挂在 `/fs/upload/simple` 与 `/fs/upload/chunk` 的 `express.raw(...)` **之前**，按「并发数（默认 16，与客户端线程并发上限对齐）+ 在途字节（默认 256MB）」双限额，超限回 **503 + `Retry-After` + `code:'UPLOAD_BUSY'`**（不是 429/400：前者像封禁、后者会被当成永久失败），名额在 `res` 的 `close` 事件归还（正常结束与 abort 都走这里）；③ **改用户名**：`PUT /users/me` 里用户名与**当前值不同**时置 `needsCurrent`（与改密 / 改邮箱同一道闸门），`profile.js` 的改名分支自带 `currentPassword` 并在为空时就地拦下；④ **`ops.js`**：复核结论是 `currentItems()` **已不存在**（R27-01 已改为 `explorer.itemOf()`），故不假装修复，改为把「不存在」钉成护栏并修掉同一函数里**真实存在**的缺陷 —— `renameOne()` 连调两次 `explorerRefresh()`（一次重命名打两轮 `/fs/list`） | **① 「关不掉」必须分档，不能只有成功/失败**：`paid` 要单独存在（用户其实已经付过钱），否则「关不掉、不知道」会把它一起吞掉，于是「已经付过钱的人」被引导去付第二次；`unsupported`（PayPal）也是单独一档 —— 官方 Orders v2 的七个端点里**没有** cancel/void（`CREATED`/`APPROVED` 既不能取消也不能作废），编一个端点比诚实标注风险更糟。**② 顺序决定能不能回滚**：先建新单再关旧单，一旦关不掉就是「两笔都能付」且无法回滚；先关后建则失败时**什么都没发生**，重试即可。**③ 关单失败 = 不建新单**（钱的安全优先于这次便利），旧单保持 `pending` 不标失败 —— 它可能仍然可付，标失败会造成「付了钱却查不到订单」；文案明确写出「避免同一件商品被付两次」。**④ 闸门的位置就是判据本身**：`express.raw` 会在 handler 之前把整个请求体读进内存，所以「在处理函数里判太大」对内存毫无帮助；峰值 ≈ 并发数 × 单请求上限，16 × 64MB ≈ 1GB，OOM 的症状是**整站** 502 而不是「上传失败」。只限并发挡不住「少数几个超大文件」，只限字节挡不住「大量小文件」⇒ 两道都要。**⑤ 无 `Content-Length` 时按单请求上限记账**（宁多算不少算），少算的后果是闸门形同虚设。**⑥ 复核旧结论要先验证前提**（R87 的教训）：`currentItems()` 那条最高优先级结论是 R27-01 的旧账，照单「修复」等于制造重复定义；真正该修的是同一函数里的重复刷新。**⑦ 本轮的两处判据自伤**：前端那条先写成「`body.currentPassword` 出现 ≥2 次」，被改密 / 改邮箱两处**满足** ⇒ 撤掉改名那一处仍全绿（反向变异 `R90-06a` 实测 `fail=0`），改为切出**改名分支本身**再断言；`alipayVerifySync` 的节点名参数化后，R80-05a / R84-02a 两条旧 anchor 分别「命中两处」与「未命中」⇒ 逐条重锚（不是放宽护栏） |
| R91 | 用户提出的两项（非审计轮，R91）：① 「为该系统引入云闪付（不考虑资质问题，这是用户端需要解决的）」，云闪付 SVG 内联代码由用户提供，并明确要求「**后台支付配置中，云闪付的位置要在微信支付和 PayPal 之间**」；② 「目前支付方式的 LOGO 只显示在后台支付配置，前台选择支付方式的页面只显示纯文字，让前台选择支付方式的页面也显示相应的 LOGO，建议对应的 LOGO 显示在相应支付方式的左侧」 | ① **云闪付 = 银联全渠道网关支付**（云闪付没有独立的聚合开放平台，它本身就是银联的支付产品）：`payment-providers.js` 新增 `unionpay` 平台（`merId` / 签名私钥 / 银联验签公钥 / `certId` / `signMethod` / `gateway`），`ORDER` 改为 `alipay,wechat,unionpay,paypal`；`payment-gateway.js` 新增 `unionpayCreate` / `unionpayQuery` / `unionpayCloseUnsupported` 并接进三张统一入口表。与既有三家不同的四处**结构差异**：报文是 `k=v&` 表单串而不是 JSON（`unionpayParseForm()` 逐字段 URL 解码）；待签串剔除的字段叫 `signature`（不是 `sign`）；一笔交易由 `merId + orderId + txnTime` 三要素确定，`txnTime` **从 `order.createdAt` 确定性重算**（下单与查单必然算出同一个值，因此不需要给订单表加列）；`orderId` 只许 8~40 位字母数字 ⇒ 用 36 位 base62 的 `orderNo`，**不能用记录 id**（base64url 含 `-` `_`，银联判报文格式错误）。后台通知复用同一套验签（`unionpayVerify`），按 `orderId` 定位订单；关单**如实回 `unsupported`**（全渠道的撤销类交易要 `origQryId`，而跳转模式下服务端拿不到它；未付订单由下单时送出的 `payTimeout` 30 分钟自动失效）。② **图形收敛到服务端唯一实现点** `server/payment-logos.js`：后台标签由 `clientSchema()` 下发 `logo` 字段渲染，前台付费页由 `share-routes.js` **内联**同一份字节（分享页是服务端渲染的独立文档，`<use>` 在那里只会画出空白）—— `public/js/payment-logos.js` 已删除（两份图形必然漂移）。付费页按钮的排布改为「单选钮 → 图标 → 名称」，图标在名称**左侧**。**13 条行为护栏**（`tests/audit91-regressions.test.js`）+ **11 条反向对照**（`R91-01a`~`R91-11a`，逐条实跑并核对失败名单，台账 930 → **941**）；前端模块 35 → 34、测试文件 90 → 91、用例 1524 → 1536 |
| R92 | 用户指令：「解决残余风险中的问题，然后推送 GitHub」。指 R91 交付时**如实标注**的三条：① 未与真实商户号联调（`certId` 是否必填、`signMethod` 选 `01` 还是 `11` 只能由入网材料确定）；② PayPal 与云闪付都无法关单（`closeState=unsupported`，双标签页付款需人工退款）；③ `GET /api/payment/config` 体积从 ~9 KB 涨到 ~25 KB（gzip 9.2 KB） | 三条各有一个**可解的部分**和一个**确实不可解的部分**，全部按「能解的做到最实、不能解的写清并留痕」处理。① **凭据自检**（`POST /api/payment/config/:platform/selftest` + 界面「凭据自检」按钮 + `paymentGateway.probeCharge()`）：拿**表单当前值**（与已保存值合并，敏感字段留空沿用旧值）真的向网关发一次**只读**请求 —— 支付宝 / 银联用 `txnType=00` 查一个必然不存在的假单号（`PROBE_ORDER_NO`）、微信 `GET /v3/pay/transactions/out-trade-no/{假单号}`、PayPal 取一次令牌 —— 按「网关是否接受我们的签名 / 令牌」与「响应能否被我们的公钥验开」给四档结论：`ok`（答复「订单不存在」= 凭据可用）/ `auth`（凭据被拒）/ `net`（没拿到可用答复）/ `config`（字段不全，连请求都发不出，且**一次出网都不发**）。它把「公钥填成应用公钥」「`signMethod` 与入网不一致」「微信私钥与证书序列号不是一对」「PayPal secret 已重置」这四类**本地永远合法、只在真实付款那一刻才炸**的错提前到保存前。**不可解部分保持不变**：自检只能**证伪**不能**证成**，`certId` 是否必填仍只能由入网材料回答。② **关单前先只读查单**（`paypalClose` / `unionpayClose`）：旧实现无条件回 `unsupported`，代价是 R90 五档里的 `paid` 在两家上**永远不可达** —— 而那是唯一一个「用户已经给过钱」的档位，也是调用方唯一会因此**放弃建新单**的档位 ⇒ 「旧单其实已经付掉了」时照样建第二笔 = 双份付款。现在关单先查一次：已付回 `paid`（拦住第二笔）、未付才 `unsupported`、查单失败回 `error`（有疑问就不放行）。PayPal 侧同时抽出一个**只读取单**入口 `paypalFetchOrder()`：`paypalQuery()` 在 `APPROVED` 时会主动 `POST /capture` 扣款，关单若复用它，「换个支付渠道」就会把旧单的钱收掉 —— 两条语义必须两个入口，且护栏直接断言关单路径**绝不出现 `/capture`**。**不可解部分**：`CREATED`/`APPROVED` 确实关不掉（Orders v2 无 cancel/void；银联撤销类交易要已成功交易的 `origQryId`），靠自然过期（PayPal 约 3 小时 / 银联 `payTimeout` 30 分钟）。③ **图形移出配置接口**：`clientSchema()` 不再下发 `logo`，改由 `GET /api/payment/logos`（`Cache-Control: private, max-age=604800` + Express 默认 ETag）下发，前端取一次后缓进 `sessionStorage`；配置接口的 `platforms` 部分从 ~27 KB 降到 ~10.8 KB（图形总量 16.5 KB）。**另修两处 R91 引入的真缺陷**：(a) 银联前台通知是**跨站 POST 表单**，而 `/s/:id/pay/return` 只注册了 GET ⇒ 云闪付用户付完款会落到 403/404；现抽出 `handlePayReturn()` 并同时挂 GET / POST，CSRF 白名单**只放行这一条形状**（`/s/<段>/pay/return` 的 POST，建单与手动查单仍必须同源），跨站 POST 因 `SameSite=Lax` 不携带票据，故回跳新增「按 `orderId` 定位」的退路（只接受属于本链接的那笔，结果仍只由 `finalizeOrder()` 查单决定）；(b) 云闪付异步通知按记录 `id` 查一个其实是 `orderNo` 的值 ⇒ **恒定查不到订单**，改用 `findByOrderNo()`。**11 条行为护栏**（`tests/audit92-regressions.test.js`）+ audit91 由 13 条改到 **14 条**（其中一条是**修正上一轮把错的实现固化成护栏**：R91-13 原本断言 `paymentOrders.get(no)`）+ **8 条反向对照**（`R92-01a`~`R92-08a`，逐条实跑并核对失败名单；另有 3 条既有对照**改锚**（R84-01a / R91-06a / R91-07a 的 anchor 因新增的自检代码出现同串而带上后续行），R91-02a / R91-08a 随被删代码退役并重建为 R92-01a / R92-05a，台账 941 → **947**）；管理员路由 10 → **12** 条；测试文件 91 → 92、用例 1536 → **1548**；版本 `1.9.26` → `1.9.27` |


## 6.5 同号异义的收敛方案：限定别名层

**结论：给每个用途补一个作用域限定的别名，但不动原编号。** 先把「为什么不干脆重编号」讲清楚，否则这看起来像偷懒：

| 可选方案 | 代价 | 采用与否 |
| --- | --- | --- |
| 全局重编号（新名 + 映射表，改全部引用） | 一次性改写全部代码注释与测试引用 | **不采用**：`docs-sync` 的双向闭合断言（引用 ⊆ 登记、登记 ⊆ 引用）**不允许分批推进**——新旧编号并存一天，「旧编号已无引用」与「新编号未登记」就同时报红。护栏事实上强制这次改动必须是**原子的一次全库手术** |
| 仅靠「引用时带轮次 / 日期」的行文约定 | 零成本 | **不充分**：靠人记的纪律都会漏（本项目已反复验证过这一点），且无法被护栏检查 |
| 别名层（本方案） | 加一张表，代码零改动 | **采用**：立即恢复检索价值；别名可被 grep；将来真要重命名时，这张表就是现成的映射表 |

代码侧实测（`server` + `public`）有 **311 处**审计编号引用，加 `tests` 与文档更多。而本项目连续 7 轮的元规律是「同一状态多个入口 / 同一逻辑多份实现处，必有改一半的漏网之鱼」——**在这种记录下做一次 300+ 处的全库重命名，风险显著高于收益**。

**命名规则**：`编号@作用域`，作用域取自该发现所在的模块或主题，全小写、连字符分词。

| 编号 | 限定别名 | 指代的发现 | 主要落点 |
| --- | --- | --- | --- |
| `FUN-01` | `FUN-01@upload-json` | 上传 `.json` 必然失败（请求体解析顺序） | `server/routes/fs.js` |
| `FUN-01` | `FUN-01@ip-guard-html` | IP 守卫 HTML 提示页分支恒抛 `ReferenceError` 被吞成 500 | `server/ip-guard.js` |
| `FUN-01` | `FUN-01@order-read-flag` | 订单读取失败标志 | `server/payment-orders.js` |
| `FUN-06` | `FUN-06@webdav-mount-prefix` | WebDAV 未校验挂载前缀 | WebDAV 路由 |
| `FUN-06` | `FUN-06@no-implicit-global-switch` | 不再顺手改写全局当前密钥 / 当前桶 | `server/config-store.js` |
| `FUN-06` | `FUN-06@stats-corrupt-guard` | 统计文件损坏护栏 | `server/stats-store.js` |
| `FUN-06` | `FUN-06@no-auto-current-bucket` | 新增桶不再自动设为当前桶 | `server/routes/buckets.js`、`config.js` |
| `FUN-09` | `FUN-09@cross-vendor-credential` | 跨厂商密钥串访 | 凭据解析 |
| `FUN-09` | `FUN-09@gitignore-param` | `gitignore` 参数缺失导致上传排除失效 | `server/routes/fs.js`、`public/js/explorer.js`、`upload.js` |
| `FUN-12` | `FUN-12@users-me` | `/users/me` 原始记录回退 | `server/routes/users.js` |
| `FUN-12` | `FUN-12@unbounded-map` | 无界 Map / 条目只增不减（**7 处**同一个编号） | `ip-guard.js`、`list-cache.js`、`security.js`、`routes/_shared.js`、`share-routes.js` |
| `FUN-13` | `FUN-13@safe-view` | `safeView` 口径不一致 | 桶视图 |
| `FUN-13` | `FUN-13@cache-invalidate-on-write-fail` | 写盘失败必须让内存缓存失效 | `server/config-store.js` |
| `FUN-13` | `FUN-13@log-rotation-starvation` | 日志轮转被缓冲饿死、`logs.jsonl` 无界增长 | `server/stats-store.js` |
| `SEC-04` | `SEC-04@gitignore-redos` | `.gitignore` 灾难性回溯（**带日期限定**） | `server/gitignore.js` |
| `SEC-04` | `SEC-04@share-same-origin` | `/s/*` 非安全方法同源校验（**无日期限定**） | `server/share-routes.js` |
| `S9` | `S9@cert-key-mode` | 私钥文件权限收紧（R49 起改为「不生成、只加载」，随自签名证书移除） | `server/tls-cert.js` |
| `S9` | `S9@error-classification` | 存储服务错误信息的分类化提示 | `server/s3.js` |
| `PERF-03` | `PERF-03@chunk-key-stream` | 分片加密缓冲（密钥流窗口化） | 加密入口 |
| `PERF-03` | `PERF-03@poll-timer-handle` | 轮询定时器句柄必须保存并可停止 | `public/js/main.js` |
| `PERF-04` | `PERF-04@list-limit` | 列举上限过大 | `server/limits.js` |
| `PERF-04` | `PERF-04@request-seq` | 前端请求序号（旧响应不得覆盖新结果） | `public/js/bucketmgr.js`、`dashboard.js` |
| `PERF-05` | `PERF-05@stats-cache-slot` | 统计缓存单槽 | 统计缓存 |
| `PERF-05` | `PERF-05@render-dom-cap` | 单次渲染的 DOM 条数上限 | `public/js/explorer.js` |
| `PERF-06` | `PERF-06@stats-write-amp` | 统计写放大 | 统计写入 |
| `PERF-06` | `PERF-06@upload-session-debounce-loss` | 上传会话去抖窗口内进程被强杀会丢元数据 | `server/upload-sessions.js`、`server/index.js` |

> 别名是**文档层的检索辅助**：不写进代码注释、不进护栏识别（`docs-sync` 仍按原编号做双向闭合）。新增引用时请给出「原编号 + 本节别名 + 轮次 / 日期」中的至少两项。

> **贯穿全程的元规律**：凡「同一状态多个读写入口」「同一逻辑多份实现」处，必有改一半的漏网之鱼；「修一处漏一处」连续 7 轮，直到第 11 轮书面确立「收敛闸门」与「唯一实现点」纪律、第 13 轮把静态护栏的地基（引号/正则感知的注释剥离）与四条反向对照纪律补齐，才真正闭环。**结论：100+ 项缺陷全部出现在用例全绿的前提下——测试绿不代表没有缺陷，只代表测试没盖到这些路径。**

