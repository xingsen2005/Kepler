# 开发文档

**前言**

为同时管理多家云服务厂商的对象存储系统，并同时有多用户管理、加密、分享、付费、流量监控管理、WebDAV 等需求（**同时也是为了展现本人技术力**），特此研发本系统。

以上。

1. **适用版本**：v2.1.4（取自 `package.json` 的 `version`，由 `tests/docs-sync.test.js` 护栏校验）  
2. **渲染前提与目录兜底**：本文标题为手写 HTML（`<h1 id="develop_document-sectionN">`），目录依赖这些 `id`。若目标渲染器清洗原始 HTML 并剥离 `id`，**目录链接会失效，但目录本身仍然可用**，请按下述方式定位：
   - 目录条目本身是一份完整的章节清单，条目文字与正文标题严格一致（由 `docs-sync` 双向断言保证），按标题文字在页面内搜索即可跳到对应章节；
   - 章节编号 `develop_document-sectionN` 从 1 起**连续递增**（同样由护栏断言），因此「第 N 章」的表述在标题被剥离后仍可换算；
   - 若渲染器连标签一起剥离（标题退化为纯文本），改用保留原始 HTML 的渲染器——GitHub / GitLab / VS Code 预览均保留。
   >
   > **为什么不「在构建期生成锚点」**：本项目**没有构建步骤**（前端是原生 ESM，`public/js/*.js` 直接由浏览器加载；文档是纯 Markdown，不经过任何生成器）。为一个不存在的构建期设计兜底方案没有意义，故此处给的是「失效后如何阅读」而非「如何让它不失效」。

3. **本页面仅适用于开发者，记录设计取舍及具体技术解析等内容。无二次开发或了解技术实现等需求、开箱即用则请直接忽略本文，只需阅读 [README.md](./README.md) 即可。**

4. 由于本系统功能庞杂，且已历经数十个版本迭代、审计和测试，因此必须将所有设计理念、设计意图、测试须知、二开示例等内容全部展开详细讲解才能防止对二开造成困扰，文档内容之巨可能远超阁下的想象。请只选择自己需要的章节进行阅读，当前该文档已超 10 万字（另有独立的《审计发现台账》约 9 万字，按需查阅），阅读整个开发文档是不理智的行为。

5. 《审计发现台账》一章由于篇幅过大，已另起一份文档（[`Audit_Ledger.md`](./Audit_Ledger.md)）。**这是一条长期规则**：今后每一轮的审计发现台账一律写入 `Audit_Ledger.md`，本文只保留结论与链接；编号的登记与双向闭合由 `tests/docs-sync.test.js` 直接读那份文件来保证。

6. 整体项目和文档的编写、修改仅由作者一人完成，难免有不足、错误和疏漏之处。若读者发现错漏之处，或有其它建议，请致函 <xingsen2005@sjtu.edu.cn> 指正，在此对所有提出修改建议的朋友表示感谢。

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
    - [1.10 为什么不使用 Shamir 秘密分享](#develop_document-section16)
  - [2. 技术限制与已知局限](#develop_document-section17)
  - [3. 威胁模型与不设防边界](#develop_document-section18)
  - [4. 审计后的行为变更](#develop_document-section19)
    - [4.1 主密钥信封与登录密钥轮转（R97）](#develop_document-section20)
    - [4.2 资料页面化 / 昵称 / 注册时间 / 自助注销（R98）](#develop_document-section21)
  - [5. 安全说明](#develop_document-section22)
  - [6. REST API 模块化组织](#develop_document-section23)
  - [7. HTTP API](#develop_document-section24)
    - [7.1 认证与用户](#develop_document-section25)
    - [7.2 配置、密钥与存储桶](#develop_document-section26)
    - [7.3 文件与上传](#develop_document-section27)
    - [7.4 分享、加密、IP、WebDAV、统计](#develop_document-section28)
  - [8. 支付设置](#develop_document-section29)
    - [8.1 主要校验规则](#develop_document-section30)
    - [8.2 开关层级](#develop_document-section31)
    - [8.3 接口](#develop_document-section32)
    - [8.4 支付状态机](#develop_document-section33)
    - [8.5 各状态切换的字段变化、校验与异常处理](#develop_document-section34)
    - [8.6 已支付凭证](#develop_document-section35)
    - [8.7 订单退款（人工记账）](#develop_document-section36)
    - [8.8 真实支付网关](#develop_document-section37)
    - [8.9 支付结果确认（服务端查单）](#develop_document-section38)
  - [9. 搜索](#develop_document-section39)
  - [10. 性能与可靠性](#develop_document-section40)
- [三、核心模块实现](#develop_document-section41)
  - [1. 文件加密与元数据](#develop_document-section42)
    - [1.1 三种方式与密文结构](#develop_document-section43)
    - [1.2 元数据是解密的唯一凭据](#develop_document-section44)
    - [1.3 分片路径与完整性校验](#develop_document-section45)
    - [1.4 查看密码与访问令牌](#develop_document-section46)
    - [1.5 孤儿元数据巡检](#develop_document-section47)
    - [1.6 完整性巡检 / 防勒索校验（R99）](#develop_document-section48)
  - [2. 统一文件网关](#develop_document-section49)
    - [2.1 收口的理由](#develop_document-section50)
    - [2.2 读取路径：信号量与范围请求](#develop_document-section51)
    - [2.3 删除、复制与移动的截断契约](#develop_document-section52)
  - [3. 分片上传与断点续传](#develop_document-section53)
  - [4. 分享链接生命周期](#develop_document-section54)
    - [4.1 标识与快照字段](#develop_document-section55)
    - [4.2 状态判定顺序](#develop_document-section56)
    - [4.3 下载配额与来源判定](#develop_document-section57)
  - [5. 请求上下文与会话鉴权](#develop_document-section58)
  - [6. IP 访问守卫](#develop_document-section59)
  - [7. 速率限制与失败锁定](#develop_document-section60)
  - [8. 列举上限与目录缓存](#develop_document-section61)
  - [9. 统计与操作日志](#develop_document-section62)
  - [10. WebDAV 服务](#develop_document-section63)
  - [11. 服务端点守卫](#develop_document-section64)
  - [12. 上传过滤匹配器](#develop_document-section65)
  - [13. 持久化、启动与关闭](#develop_document-section66)
  - [14. 前端模块与渲染约定](#develop_document-section67)
- [四、测试](#develop_document-section68)
  - [1. 测试与 CI](#develop_document-section69)
  - [2. 测试护栏编写约定](#develop_document-section70)
- [五、开始二次开发](#develop_document-section71)
  - [1. 高层架构总览](#develop_document-section72)
    - [1.1 分层视图与请求链路](#develop_document-section73)
    - [1.2 状态存放与启动顺序](#develop_document-section74)
  - [2. 本地启动与调试](#develop_document-section75)
    - [2.1 启动方式与端口](#develop_document-section76)
    - [2.2 服务端调试](#develop_document-section77)
    - [2.3 前端调试](#develop_document-section78)
  - [3. 最小示例 A：新增一个只读接口](#develop_document-section79)
    - [3.1 第一步：写路由](#develop_document-section80)
    - [3.2 第二步：挂载与依赖注入](#develop_document-section81)
    - [3.3 第三步：补护栏并验证](#develop_document-section82)
  - [4. 最小示例 B：新增一个前端卡片](#develop_document-section83)
  - [5. 二次开发检查清单](#develop_document-section84)

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
│   ├── order-no.js         # 【R64】订单号编解码**唯一实现点**：36 位「13 位毫秒时间戳 + 9 位链接 UID + 9 位用户 UID + 5 位随机串」，base62、区分大小写；两个 UID 由 `sha256('kepler:link:'+id)` / `sha256('kepler:user:'+id)` **确定性派生**（同一链接 / 同一账号恒定），随机串用 `crypto.randomInt` 取（不用 `randomBytes % 62`，避免分布偏斜）。⚠️ 它**不是**网关商户单号：微信 / 支付宝 / PayPal 仍用 `order.id`（16 位 base64url）作 `out_trade_no` / 商户订单号（微信支付 v3 对 `out_trade_no` 有 **≤ 32 位**硬限制）；**银联全渠道例外**——R91 起改用 36 位 `orderNo` 作 `orderId`（银联要求 8~40 位字母数字）
│   ├── payment-gateway.js  # 【支付】真实支付网关：支付宝 RSA2 / 微信 APIv3 / 云闪付（银联全渠道）/ PayPal Orders v2（查单确认，零依赖）
│   ├── payment-logos.js    # 【R91】渠道品牌图形的**唯一实现点**（内联 SVG + `SHAPES` 表 + `logoSvg()` / `logo()`）。后台「支付设置」的标签经 `GET /api/payment/logos` 下发（R92；`clientSchema()` 已不再带图形字段）、前台分享页由 `share-routes.js` 直接内联 —— 两处渲染的是**同一份字节**。⚠️ 不要在前端另存一份图形数据：两份必然漂移（原先的 `public/js/payment-logos.js` 已删除）
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
│   ├── keyring.js          # 【R97】主密钥信封**内核**：主口令经 scrypt(N=2^17) 派生 KEK → AES-256-GCM 包裹 DEK → `keyring.json` 只存 `wrappedDek` + `salt`（明文密钥永不落盘）。⚠️ 刻意**不** `require('config-store')`（循环依赖），改由 `setOnLock()` 反向注册「锁定时清掉解密后的配置缓存」—— 漏了这一步，「锁定」就只是名义上的（60 秒 TTL 内 `load()` 照样把密钥交出去）。错误码分四档：`KEYRING_LOCKED`(503) / `KEYRING_BAD_PASSPHRASE`(401) / `KEYRING_CORRUPT`(500) / `KEYRING_EXISTS`(409)
│   ├── key-rotate.js       # 【R97】密钥生命周期**编排**（不含密码学）：迁移（**只重裹、不重加密** —— 只写 `keyring.json` 一个文件，一次 rename 就位，天然原子；多文件重加密没有跨文件事务，中间崩一次就是永久不可解）/ 轮转（登录口令 = 主口令，KEK 重裹与口令哈希两边必须同时生效，`updateUser` 失败则回滚 KEK）/ 状态。⚠️ 迁移的验证步骤（锁 → 解锁 → DEK 相等 → 配置可读回）必须在删 `secret.key` **之前**跑完
│   ├── account-deletion.js # 【R98】账户注销的**政策与执行**唯一实现点：15 天冷静期（`COOLING_DAYS`）、到期清扫（`purgeDue()` 逐条 try/catch，失败即保留申请、下一轮重试）、删除时的三件连带清理（WebDAV 账户随 `removeUser` / 分享链接解除归属 / 全部会话失效）。⚠️ 申请与撤销只改用户记录上的两个时刻，不另立"待办队列"——队列会变成第四份要备份、要迁移的状态
│   ├── agreement-text.js   # 【R68】协议文案渲染**唯一实现点**：**先把原文整段 HTML 转义、再插入本文件生成的固定标签**（不是黑名单过滤——`<img onerror>` / `<svg onload>` / `javascript:` 漏一个就是存储型 XSS），提示文案只认 `<a>`、正文只认一个极小的 Markdown 子集，不支持的写法原样显示不丢内容
│   ├── agreement-view.js   # 【R68】协议提示的**页面级视图唯一实现点**：`noticeForPage()`（分享页服务端渲染直调）与 `publicPayload()`（`GET /api/site/agreements`）共用同一段判断——开没开、有没有正文、哪几个链接能点。⭐ 两份正文**都空 ⇒ 整条提示不显示**（否则点开是空对话框）；只填一份 ⇒ 另一份的 `<a>` 退化成纯文字
│   ├── bucket-stats.js     # 【配额】桶用量统计缓存 + API Key 空间配额（根级模块：打破 routes→_context→WebDAV→网关 的循环依赖）
│   ├── secure-store.js     # 其他敏感 JSON 的加密落盘（自动升级历史明文）
│   ├── atomic-write.js     # 临时文件 + rename 原子写入 + 启动孤儿 tmp 清扫
│   ├── coalesce.js         # 异步原语：去抖合并写 + 并发合并读（退出收口只注册一个处理器）
│   ├── enc-store.js        # 文件加密核心（三种方式 / 解密流 / 查看令牌 / 元数据迁移）
│   ├── integrity.js        # 【R99】完整性巡检 / 防勒索校验：**只读体检**，不解密、不碰密钥。三个判据只靠一次 HEAD —— `missing`（404 / NoSuchKey）/ `size`（`Content-Length` ≠ 由 `enc-meta` 推导的密文长度）/ `modified`（云端 `Last-Modified` 晚于 `max(createdAt, cloudWrittenAt)`，带 5 分钟时钟容差），后者是**同长度原位覆盖**（勒索软件 / 同步工具回写）唯一能被抓到的信号。候选集 = `enc-meta.json` 的键（「我们加密过哪些对象」的唯一权威），轮转游标 + 每轮上限摊平成本，命中 `search-candidates` 时连 HEAD 都省。⚠️ **第一条判据是「锁定态」**：锁定期间读 `enc-meta.json` 会把 `metaCorrupt` 置真、本进程永久拒写元数据（R97 的三条误判路径之一）
│   ├── integrity-notify.js # 【R103】巡检的**异常通知**（邮件）：只对 `missing`/`size`/`modified` 三种「真异常」发信（`unknown`/`error` 是「没查清」，整轮跳过是本系统自己的状态问题，都不发）；按**签名 + 冷却**去重 —— 签名变（新增坏对象）立刻发、同一批每 12 小时复述一次；发信失败只记 `lastError` 且**不推进签名**（下一轮继续重试，另有 30 分钟退避）；`commit()` **不 await** 它（发信最长 15 秒，等它会让「立即巡检」卡住），复用同一套 SMTP 设置
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
│   ├── captcha-native.js   # 原生验证码（R100）：给**没有浏览器 / WebView** 的客户端出一道算术题；`NATIVE_CAPTCHA=on` 才启用（默认关，因为算术题对脚本是透明的）
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
│       ├── provider-logos.js # 【多云】12 家厂商元数据与 LOGO（内联 SVG）
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
│       ├── profile.js        # 【R98】「我的资料」**独立页面**（主视图 `#profile`，入口在账户菜单「编辑资料」，所有角色可用，与用户管理分离）：昵称（展示名，可重复 / 免密码 / 清空即回退用户名）、用户名、角色与注册时间（只读）、邮箱验证码、当前密码 / 新密码、Windows Hello、**注销账户**（邮箱验证 + 15 天冷静期，期间登录即撤销）。每次进入重建 DOM 并以 `dataset.dirty` 防「正在输入被拉取结果覆盖」
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
│   ├── audit93-regressions.test.js # 【R93】付款二维码就地绘制（11 条）：① 微信下单后**留在本页**画码（200、无 `location`、无 meta refresh、`.qr-box` 内有内联 `<svg>`、无「立即支付」、有 `#pay-state`），且 `order.qrPayload` 已落库（`qrAt` 同写）；② 支付宝 `mode=face` 同样就地出码；③ `mode=page` 保持原样（有按钮、命中同源中转页、**不写** `qrPayload`）；④ 二次提交复用在途二维码且**不再调网关**（下单桩只被调 1 次）；⑤ 扫码态金额取**订单**（链接 ¥12 + 券 ¥5 ⇒ 页面 `¥7.00`，原价 `¥12.00` 划线）；⑥ 单选钮 `data-qr` 是服务端判定的投影（微信 / 当面付=1、网站应用=0），且未出码前按钮必须在；⑦ 前端只认 `data-qr`+`change`+`requestSubmit`，且**加载不自动提交**（`requestSubmit` 只许出现在 change 处理器里）；⑧ `supportsQr` 是唯一判定（微信恒真 / 支付宝看 `mode` / 缺 `mode` 保守为 false / 其余 false），`qrBoxHtml` 与 `supportsQr` 各只有一份实现、独立扫码页已消失；⑨ `mode` 不把老配置打成「未配置」（`isConfigured` / `validate` 仍过、`applySave` 补 `page`、`publicView` 回填、非法值被拒）；⑩ 码内容过长（300 字节 > 213 实测上限）时给 `.qr-box--empty` + 原因 + 出路，且不摆按钮。配套 9 条反向对照（`R93-01a`~`R93-09b`，台账 947 → **956**）
│   ├── audit94-regressions.test.js # 【R94】逐条复核《Kepler 全模块安全与功能缺陷审计报告》（MiniMax M3.1-Flash，90 条 / 去重 87 条）—— 62 条护栏只覆盖「确实成立且已修」的那部分：① 发信拓扑只给管理员、探针失败只回类别；② 健康探针透出「本次连接加没加密」；③ 邮箱验证码的按用户日配额；④ 备份不搬运桶级端点 / `DEFAULT_CONFIG` 不被污染 / 残留锁接管 / WebDAV 空间绑定随备份走 / `readJson` 的删除竞态；⑤ 桶名与 R2 账户 ID 的字符集（`/` 是绕过 endpoint-guard 的唯一通道）、被 400 拒绝的更新不留脏值；⑥ 单对象移动的三步顺序、`gzip` 的 `res.write` 回调透传；⑦ XML 1.0 非法控制字符、`Destination` 指向集合、上游游标不前进；⑧ 上传内存闸门早于 `express.raw`、单人名额、失败态取消要真回收云端碎片、双向控制字符；⑨ 日志里的分享 id 脱敏、线程池降级可恢复、券台账截断后仍可退款、`consume()` 自身挡配额；⑩ `DEPLOY_MODE`、`is_ip_addr()`、CI 固定 SHA、EAB 密钥通道、安装目录属主；⑪ 本轮新增/补全的 M01/M02/M06/M08/M09/M11/M12 各条（口令层、删用户摘归属、相对键、去抖与票据 TTL、`writeJsonStrict`、预检 `_parsed`、`unparsable` 分支）。配套 **62 条**反向对照（`R94-01a`~`R94-62a`，每条修复都逐条实跑确认「退回旧实现必须变红」）
│   ├── audit95-regressions.test.js # 【R95】《支付系统检查报告》（DeepSeek V4.1 Flash 1017，2 条结论 + 1 条未验证线索）逐条复核：**两条结论都成立**，故护栏全落在「修好之后才成立」的行为上 —— ① 标价上涨后再次提交必须按新价另建新单、页面金额 = 交给网关的金额、旧单收尾为失败（`failReason` 指向改价）；② 标价下调同样不得仍按旧的高价扣款；③ 标价变了但**券后应付没变**（¥5 → ¥3 + ¥10 券 ⇒ 都封顶到 1 分）时必须复用，不许白废一张在途单（判据是应付额不是标价）；④ 对照：标价没变仍复用，不得把正常幂等改坏。二维码那一条的护栏在 `qrcode.test.js`（独立解码器），配套 3 条反向对照（`R95-01a`~`R95-03a`）
│   ├── audit96-regressions.test.js # 【R96】《支付系统支付链路复检》（DeepSeek V4.1 Flash 1017，`1.md`）逐条复核：R95 的两条修复被确认成立，同时指出**同一处分叉只修好了无券路径** —— 券被自己的在途单占着（`perUserOnce` 判 `already_used`）、或被停用 / 过期时，`couponStateFor()` 判「不可用 ⇒ 按原价渲染且不回传券」，而下单侧 `submittedCode` 回落到券 Cookie ⇒ `couponChanged=false` ⇒ 复用旧单 / 退券重验后按新价建单 ⇒ **页面 ¥5.00、实扣 ¥4.00**（改价时页面 ¥3.00、实扣 ¥2.00）。五组测量全部复现，方向是「页面比实扣贵」，用户不会多付但台账与承诺不符 —— 与 R62 整轮在消灭的那类分叉同源。修法：`couponStateFor()` 增补 `heldCouponState()`，按下单侧同一套判据算一遍（应付额没变 ⇒ 以订单快照为准；只有 `already_used` 会被退券治好 ⇒ 按新标价复算），并在下单成功后的扫码页把刚建好的单当提示传进去（那一秒浏览器还没拿到支付票据 Cookie）。6 条护栏（`audit96-regressions.test.js`）+ 3 条反向对照（`R96-01a`~`R96-03a`）
│   ├── audit97-regressions.test.js # 【R97】主密钥信封的 **HTTP 面**（9 条）：`/key/status` 的**分级下发**（匿名只给三个布尔 —— 多返回一个字段就是匿名泄露"有没有旧明文密钥""版本到几"）、`/key/unlock` 的 CSRF / 限流 / 失败锁三道闸与"**成功不签发会话**"（否则主口令 = 免登录通道）、迁移与轮转的**根用户**档（管理员也不行，`canManageUser` 与"改解锁因子"不是一回事）、以及 `LOCKED_ALLOWED` 放行清单的结构断言（漏 `/key/unlock` = 永久死锁，而这条在本地跑不出来）
│   ├── keyring.test.js     # 【R97】信封内核的**密码学契约**（13 条，真 scrypt、真 AES-GCM，不打桩）：KDF 参数两处定义不得漂移 / 同口令同盐派生确定、换盐即换 KEK / 包裹往返（IV 必须随机、GCM 认证标签生效）/ `create` 拒绝覆盖 / 容器损坏时备份且**绝不覆盖** / 未知版本拒绝解析 / **"锁定 ≠ 损坏"的三条独立路径**（`getMasterKey` 不退回生成新密钥、`load()` 抛而非返回 null、`secure-store` 不打上"永久拒写"）/ 锁定必须连解密缓存一起清 / 换数据目录解锁态自动失效
│   ├── keyrotate.test.js   # 【R97】迁移与轮转的**流程契约**（10 条）：迁移只写 `keyring.json` 且 `config.enc` **逐字节不变**（"只重裹不重加密"是可证伪的判据，不是口号）/ 迁移后**重启**仍能解锁读回（含环境变量自动解锁）/ 幂等（重复迁移不得改写容器）/ 口令错时不建容器、不删唯一的明文凭据 / `keepLegacyKey` 如实报告"落盘风险仍在" / 轮转后 KEK 与登录口令**两边同时生效**、数据不动、全部会话失效 / 策略校验必须在**重裹之前**（判据是容器字节未变）
│   ├── audit98-regressions.test.js # 【R98】「我的资料」页面化 + 昵称 + 自助注销的 **HTTP 面**（12 条）：昵称**免当前密码**（它与登录凭据无关）/ 超长 400（归一化静默截断 = 假成功）/ 空串是合法值（清空 = 回退显示用户名）；根用户与「没绑邮箱」各自一档拒绝（前者删了没有重建路径，后者没有证据链）；验证码**用途隔离**（改邮箱的 `verify` 码不能注销）；15 天冷静期（毫秒容差）/ 重复提交与重复发码都 409（防止悄悄续期）；**冷静期内登录即撤销**并回传 `deletionCancelled`；**已到期**则登录当场删除（403 + `deleted`，且不下发 Cookie）；后台清扫解除分享链接归属（同名新账户不得继承旧链接）
│   ├── account-deletion.test.js # 【R98】昵称与注销的**存储层契约**（4 条）：坏 `deletion` 结构（到期早于申请 / 非日期 / 缺字段 / 字符串 / 数组）一律归零 —— 失败方向必须是"账户留下"（脏数据被当成"立刻到期"= 一次读盘就删号且不可恢复）；未到期不进待删列表、**恰好到期**算到期（`<=` 不是 `<`）；昵称按**码点**截断（`slice` 会劈开 emoji 代理对，落盘即乱码）；冷静期常量是唯一事实源（UI / 文档 / 测试都从 `COOLING_DAYS` 取）
│   ├── audit99-regressions.test.js # 【R99】完整性巡检的三层护栏（12 条）：**判据层**（密文长度的推导公式：crypto 逐片 `12+ct+16` + 只算一次的魔数头 / magic 与明文等长；三个结论 `size`·`modified`·`ok`；缺 `createdAt` 的历史条目不判「被改写」；「不存在」只认 404 / NoSuchKey）·**行为层**（真跑 `runOnce()`，用「桩被调用了几次」取证：锁定态一步都不往下走、元数据损坏与锁定是两个不同原因、403 / 5xx 计跳过而非丢失、定时器与手动巡检合流、轮转游标推进、候选集命中省 HEAD 但仍按长度判定）·**接线层**（卡片登记 / 容器与按钮 / 两条 API / 两条路由都挂 `requireAdmin`）。依赖用 `require.cache` 注入「真模块 + 只换边界函数」，`CRYPTO_MAGIC` / `mapLimit` 仍是真实实现
│   ├── audit100-regressions.test.js # 【R100】原生验证码的接线层（10 条，**真 HTTP**）：默认关闭时客户端行为与改动前完全一致（403 且**无** `needCaptcha`）/ 验证码全局关闭时客户端也不答题 / 开启后客户端拿到 `needCaptcha` + 题面 / **答对后用「401 用户名或密码错误」作证**已越过人机验证（刻意用不存在的账户，避免把用例变成「注册 + 登录」的复合测试）/ 答错换新题并给 `captchaError` / 浏览器不受影响 / **关掉开关立刻失效**（旧题也不能再用）/ `GET /captcha/native` 开启时发题、关闭时 404 / 静态接线（两个调用点 + 匿名白名单 + 路由 + 限流）/ 注册同样可用（用「400 密码长度至少 8 位」作证走到了 `addUser()`）
│   ├── audit101-regressions.test.js # 【R101】《密钥轮转与完整性巡检审计报告》9 条（**全部成立**，10 条）：改密闸门三态（未启用信封放行 / 已启用且非根放行 / 根用户拦下 `USE_KEY_ROTATION`）+ 三个入口接线 / 根口令哈希写盘失败 ⇒ 轮转必须失败并回滚 KEK（`rewrap` 回滚会使 `kekVersion` **+2**，用例里写明）/ 崩溃窗口由意图日志补完 + 三种「判不了就不猜」 / 并发轮转第二个拿 409 且锁会释放 / 损坏的 `keyring.json` 反复取状态只留一份备份（源文件被改过才重新留档）/ 复制·上传落库·移动三处都刷新 `cloudWrittenAt` 且 `createdAt` 不变 / magic 短文件四档边界（0 / M-1 / M / 100 字节 + 缺 `magicLen` 的历史条目）/ 同名桶歧义整桶跳过且**一个 HEAD 都不发**。每个用例独占临时数据目录（`keyring` 的解锁态是模块级且绑定路径，共用目录会让上一个用例把下一个锁在门外）
│   ├── audit103-regressions.test.js # 【R103】巡检异常通知 + 随机 4 位口令（8 条）：设置默认关闭 / 「只改地址不得把开关关掉」（顶层替换事故）/ 四种「不该发」（bad=0、只有 error、开关关、地址空）/ SMTP 没配不发但配好后正文含中文结论与对象位置 / 同一批不重复轰炸、签名变化立刻发、冷却到期复述 / 发信失败不影响巡检结论且不推进签名（含失败退避）/ 路由三条校验（坏地址 400、开开关没地址 400、SMTP 未配给 warning）/ 生成器 4 位·字母数字都出现·无易混字符·不用 `Math.random` / 前后端下界同为 4
│   ├── audit104-regressions.test.js # 【R104】《Kepler v2.1.3 安全审计报告》6 条（**全部成立**，8 条）：**锁定态读盘不得污染**（真 `keyring` + 真重启 + 解锁后核对 + 再重启核对，断言 4 个数据文件字节不变）/ 支付宝同步响应切片（同名节点 0 个 / 切不成 / 2 个三个边界 + 单节点对照）/ 端到端**真 RSA 签名 + 追加的伪造 `TRADE_SUCCESS`** 不得让订单变已付 / `Host: evil.com` 不进人机验证允许域名（桩 `captchaNative.guard` 断言 `expectedHosts`）/ 真坏 `enc-settings.json` 下任意口令不得换访问令牌 / 真写盘失败时导入必须 500 / **轮转进行中不得删意图日志**（互斥内部驱动 + 外部对照）/ 启动清扫必须等解锁**成功**（静态判据判「紧邻」，防被前面那处 `/api` 锁定门满足）。每个用例独占临时数据目录 + 清 `require.cache`，否则测出来的是「同一进程里锁了又开」的假形态
│   ├── captcha-native.test.js    # 【R100】原生验证码的模块契约（12 条）：默认关闭 ⇒ 客户端仍走 reCAPTCHA 分支（不签题）/ 全局关闭 ⇒ 直接放行 / 非客户端请求一律走原路径 / 首次发题 `retry=false`、答错 `retry=true` 且换新 token / **答对即删**（重放与「过期」同形，少一条探测面）/ TTL 按 `now` 判定 / 同一枚 token 答错满 3 次作废 / 全角数字与空白的归一化 / 超长答案不受理 / 客户端前缀白名单（不认通配 `*`）/ 内存表**过期先清、满则按插入序淘汰**
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
├── README.md · Develop_Document.md · CHANGELOG.md · Audit_Ledger.md  # 使用说明 / 开发文档 / 变更记录（据审计台账事后重建，无发布日期）/ 审计发现台账（编号含义与闭合依据的唯一正本）
├── Dockerfile · .dockerignore
├── eslint.config.js · .editorconfig
└── data/                   # 运行时数据（自动创建，勿提交 git）
    ├── secret.key          # 配置主密钥（32 字节随机，本机生成）。【R97】**历史文件**：完成迁移后即被删除，改由 `keyring.json` 承担；仍存在的实例 = 尚未迁移
    ├── keyring.json        # 【R97】主密钥信封：`salt` + `wrappedDek`（口令包裹后的 DEK）+ KDF 参数 + `kekVersion`。**单独拿到它解不出任何东西**，但它丢了等于全部密文永久不可解 —— 与 `config.enc` 同等备份优先级
    ├── keyring.rotate-intent.json # 【R101】轮转**意图日志**（只在两次写盘之间短暂存在）：已算好的根口令凭据 + `fromKekVersion` / `toKekVersion`。用于崩溃窗口的自动补完（成功即删），它不含新的秘密 —— 同一口令派生的 salt 与包裹体在 `keyring.json` 里本来就有，KDF 参数也相同，能离线爆破它的人同样能爆破 `keyring.json`
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
| `secret.key` | 配置主密钥丢失 → `config.enc` 与全部敏感 JSON 永久不可读。【R97】**迁移后此文件已不存在**，风险转移给下一行 | 否 | **最高** |
| `keyring.json` | 【R97】主密钥信封丢失 → 等同于丢主密钥：`config.enc` 与全部敏感 JSON 永久不可读（**有它还要有主口令**，二者缺一不可） | 否 | **最高** |
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
主口令 ──scrypt(N=2^17)──→ KEK ──解开──→ keyring.json 里的 wrappedDek ──→ DEK
（历史路径：secret.key 里存的就是这把 DEK 的明文本身，迁移成功后该文件被删除）
DEK ─┬─派生─→ config.enc            （访问密钥 / 桶 / 用户 / 支付凭证）
     └─派生─→ enc-settings.json · enc-meta.json · links.json
              ipguard.json · upload-sessions.json · payments.json · downloads.json
enc.key    ───直接─→ 云端对象里的 crypto / magic 密文（文件数据本身）
```

> 【R97】`secret.key` 已被上面这条链取代（历史实例迁移前的对应关系是 `secret.key ──派生──→` 同样那几个文件）。密钥轮转只换「包裹 DEK 的那把 KEK 与盐」，**DEK 不变**，所以数据文件一个字节都不用动。

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

**密钥轮换：DEK 与 `enc.key` 不可轮换（设计层面的硬约束）**

R97 起 `secret.key` 已由信封加密取代：**主口令与包裹 DEK 的 KEK 可以轮换**（`keyring.rewrap()` / `key-rotate.rotate()`，只重裹、不重加密）；但 **DEK 与 `enc.key` 仍没有 rekey 路径**，两者的语义都是「文件不存在就新生成一把」。由此产生两条必须写进运维手册的后果：

- **不能靠「删掉密钥文件让它重新生成」来轮换**——那等于丢弃旧密钥，旧密文与旧配置立即永久不可读。
- **`keyring.json` 与主口令同时泄露（或迁移前的 `secret.key` 泄露）**：只能在各厂商控制台吊销并重建子账号访问密钥、重设 WebDAV 口令、重设用户密码（`config.enc` 里的口令哈希随之整体作废）。
- **`enc.key` 泄露**：只能走「全量下载 → 用新密钥重加密 → 重新上传」。顺序是 ① 备份现有 `enc.key` + `enc-meta.json`；② 逐个下载解密出明文（**这一步依赖老元数据，先动密钥就再也解不开**）；③ 停服、移除 `enc.key`（下次启动生成新密钥）；④ 重新上传，由服务端用新密钥加密并写入新元数据。**全程服务不可用，且产生双倍流量与存储费用**。

> 引入密钥版本（`keyId`）+ DEK 的平滑轮换需要给每个密文对象与每个敏感 JSON 加版本标记并保留多代密钥，改动面覆盖 `config-store` / `enc-store` / `enc-meta` 索引，风险显著——目前**没有计划**，请按「DEK 不可轮换」来做容量与应急预案。（主口令 / KEK 的轮换不在此列：R97 已支持，且不触碰任何数据文件。）

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
| `DEPLOY_MODE` | 未设置 | **R94 新增**：显式声明「本站对外提供服务」。此前 `IS_DEPLOY` 由「`HOST` 是否回环」推导，于是反代部署下把 `HOST` 改回 `127.0.0.1`（更安全的绑定）会**静默**关掉 HSTS 与会话 Cookie 的 `Secure`。现在两者解耦：`deploy.sh` 无条件写入 `DEPLOY_MODE=1`，`IS_DEPLOY = DEPLOY_MODE || !IS_LOOPBACK`（老部署不受影响，只是多了一条显式开关） |
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
| `KEPLER_MASTER_PASSPHRASE` | 未设置 | 【R97】主口令（= 根用户登录口令）：**只**用于「进程启动时自动解锁」。无头部署（容器 / systemd）重启后没有人能点界面的解锁页，没有它就必须人工介入；设了它，`keyring.autoUnlockFromEnv()` 在启动阶段就把 DEK 解进内存。⚠️ 它等价于把这个实例的**解密能力**写进 `.env`，与 `secret.key` 落盘的风险同级 —— 只在「本机 `.env` 与 `data/` 同等受控」的前提下使用。**不设置**时进程以锁定态启动，由前端解锁页接管 |
| `KEPLER_KEEP_LEGACY_KEY` | 未设置 | 【R97】设为 `1` 时迁移**保留** `data/secret.key`（逃生阀：想先观察一段时间再删的运维）。默认删除 —— 留着它等于留着一份能直接解密全部数据的明文，改造本身失去意义。保留时 `/key/status` 的 `legacyKeyPresent` 如实为 `true`（界面会显示「落盘风险仍在」） |
| `INTEGRITY_SWEEP_MS` | `21600000`（6 小时） | 【R99】完整性巡检的周期；**设为 `0` 即整体关闭**（有的实例把对象存储当备份盘，不希望后台产生任何额外请求）。取 6 小时的理由：它防的是「云端被人动了而我们不知道」，不需要分钟级；而 6 小时 × 200 个对象/轮 ≈ 一天 800 个对象，让「被发现」的延迟与「被抓到之前损失多少」都落在可接受区间。**每次读**而不是启动时读一次，便于线上止血与测试驱动 |
| `INTEGRITY_BATCH` | `200` | 【R99】每轮、每桶最多巡检多少个对象（`0` / 非法值退回默认）。它是「一次巡检别把云端请求配额吃光」的硬上限，与上面的周期共同决定「多久能覆盖全部对象」：一万个对象、每轮 200、每 6 小时一轮 ≈ 12.5 天覆盖一遍，请求量约等于一次浏览 |
| `CAPTCHA_ENABLED` · `CAPTCHA_PROVIDER` · `CAPTCHA_SITE_KEY` · `CAPTCHA_SECRET_KEY` | 未设置 | 登录验证码的预设值；**仅当环境变量真实存在时**才写入配置，用于无界面部署时预设，不会用空值覆盖已保存的配置。`CAPTCHA_PROVIDER` 决定用哪一套，`CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET_KEY` **只作用在被选中的那一套**上（两套凭证各自独立保存，见 §7.1 的 `/captcha/config`） |
| `NATIVE_CAPTCHA` | 未设置（= 关） | 【R100】原生验证码分支的总开关，`on` / `1` / `true` / `yes` 才算开（**拼错一律当关闭**）。开着的意思是「带 `X-Kepler-Client` 头的请求改答一道本机算术题，不再要 reCAPTCHA token」。**默认关闭是刻意的**：算术题对脚本透明、请求头也可伪造，打开它等于给所有知道这个头的人一条绕过 reCAPTCHA 的路。仅当「确实有原生 App 要登录」且「愿意用弱验证换可用性」时才开 |
| `NATIVE_CAPTCHA_CLIENTS` | `kepler-android/` | 【R100】允许走原生分支的客户端标识**前缀**，逗号分隔（按 `X-Kepler-Client` 头的值做前缀匹配）。刻意不支持通配 `*` —— 那等于「任何带头即放行」，白名单至少能挡住无意识的绕过。留空回落到默认值 |
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
| **不强行统一字段名** | 四家平台各自沿用官方文档命名：支付宝 `app_id` / `private_key` / `alipay_public_key` / `sign_type`；微信支付 `mchid` / `appid` / `api_v3_key` / `serial_no` / `private_key`；云闪付 `merId` / `certId` / `privateKey` / `unionpayPublicKey` / `signMethod`；PayPal `client_id` / `client_secret` / `mode`。界面在每个字段旁标注官方字段名，可直接对照其控制台填写 |
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

欧美及多数地区强制要求强客户身份验证。这需要前端集成动态挑战流程（iframe / 重定向），后端维护验证会话状态。当前 `payment-gateway.js` 的 `createCharge` 回 `{ ok, kind?, url?, codeUrl?, svg?, tradeNo?, error? }`（`kind` 区分跳转 / 二维码，`url` / `codeUrl` / `svg` 视渠道给出），没有处理 3DS 挑战所需的异步状态机。

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

<h5>J. ECMAScript 规范垫片（intrinsic 抽象层，13 个）</h5>

> 这组不实现业务功能，而是按 ECMA-262 规范安全访问 JS 内建能力，兼容老引擎并防原型污染（清单按当前 `package-lock.json` 的运行时闭包）。

| 包 | 作用 |
| --- | --- |
| `get-intrinsic@1.3.0` | 按规范名获取原始内建（`%Object.prototype%`） |
| `call-bind-apply-helpers@1.0.2` | call / apply / bind 的分实现 |
| `call-bound@1.0.4` | `callBind(intrinsic)` 的简写（绑定好的方法） |
| `function-bind@1.1.2` | `Function.prototype.bind` 实现 |
| `es-define-property@1.0.1` | 规范语义的 `[[DefineOwnProperty]]` |
| `es-object-atoms@1.1.2` | `ToObject` / `RequireObjectCoercible` 原语 |
| `es-errors@1.3.0` | 规范错误类型构造器 |
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

<h3 id="develop_document-section16">1.10 为什么不使用 Shamir 秘密分享</h3>

Shamir 秘密分享（SSS）把一把密钥切成 `n` 份、任 `k` 份可重构。它常被当作「密钥管理的标准答案」，**但在本项目的形态下它是零增益，甚至有害**：

1. **SSS 解决的是「单份保管人不值得信任」，而本项目的保管人只有一个人。** 主口令 = 根用户登录口令，只存在于管理员脑子里。把 DEK 切成 3-of-5 之后，这 5 份仍然要**存在本机或本机可访问的位置** —— 否则服务重启时凑不齐份额，站点直接不可用。而只要份额在同一台机器 / 同一块磁盘 / 同一份备份里，**攻破一次就能拿走全部份额**，SSS 退化成一个更复杂的加密方案。
2. **它不解决运行时被攻破。** SSS 只在「多独立信任域各持一份、单人不可解密」时有效。本进程要解密就必须在内存里凑出完整 DEK —— 拿到进程内存（core dump / 调试接口 / 供应链后门）的人根本不需要份额。需求文档《登录密钥轮转》§8 已经写明这一点：**当前单实例单管理员形态下，SSS 对落盘泄露零增益**。
3. **它把「单人可用」换成「多人共管」，而那是一次组织变更，不是一次代码变更。** 引入 3-of-5 意味着：重启要 3 个人同时在线（否则服务起不来）、有人离职就要重新分片、任何一次紧急恢复都要走一遍「凑人」流程。这些成本是真实的、每天的，而收益只在「多个 custodian 互不信任且份额跨机器存放」时才成立。把它作为默认形态，等于用可用性去换一个当前并不存在的威胁。
4. **它有更便宜的替代品来对付它想解决的问题。** SSS 真正有价值的落点是「管理员遗忘主口令 ⇒ 保险库永久不可解」这个死锁，而标准解法是**一次性高熵恢复码**（用同一把 DEK 再包裹一次，离线分人保管）—— 它只需要一次 `AES-GCM`，不需要门限数学，也不改变「一个人就能启动服务」这个前提。真要上 SSS，应当等到「多 custodian 共管」成为真实需求、且份额确实**跨机器 / 跨人**存放时，再作为**恢复码之上**的附加层引入。
5. **零依赖约束下，它还会把密码学攻击面扩大一圈。** 项目运行时只依赖 `express`，现有全部密码学都走 Node 内置 `crypto`（`scrypt` / `AES-256-GCM` / `ECDSA`）。自己实现 SSS 意味着在「密钥管理」这条最敏感的路上引入一段自研数学 —— 而它的正确性很难被行为测试覆盖（份额错误、系数重复、有限域实现错误，都表现为「有时候能恢复」）。相比之下，信封加密用的是标准原语、失败模式明确（口令错 ⇒ 认证失败）。

> **一句话**：本项目的威胁模型是「**落盘泄露** + **云端被篡改**」，不是「**保管人串谋或单人叛变**」。主密钥信封加密（见 4.1）解决前者，完整性巡检（见「三、核心模块实现 1.6」）解决后者。SSS 防的是第三件事，而这件事当前不存在 —— 引入它只会让「一个人重启服务」变成「三个人一起开会」。**什么时候该重新评估**：出现多管理员共管同一实例、且明确要求「任何单人都不得独立解密」时，先落地恢复码，再叠加 3-of-5 门限。

<h2 id="develop_document-section17">2. 技术限制与已知局限</h2>

- 本项目为个人项目，未经企业级安全审计，请勿直接用于企业生产环境。
- WebDAV 的 **PUT 写入**为全量缓冲（整份文件进内存后才加密上传），属设计权衡，暂不优化；**读取侧支持 HTTP Range 断点续传**，二者不冲突——前者是写入路径，后者是读取路径。
- **`magic` 加密模式有硬性性能上限**：它的密钥流是纯位置函数（每 32 字节做一次 SHA-256），生成成本与数据量线性相关，且**在单线程里同步生成**。48MB 的分片会把事件循环阻塞约 3 秒，期间全站（含 WebDAV 与所有下载）失去响应。因此分片上传在 `magic` 模式下把单片上限压到 **5MB**（`MAGIC_CHUNK_MAX`），代价是同样的文件产生更多分片与更多请求。**这个值不能继续下调**：AWS S3 要求「除最后一片外」每片 ≥ 5MB，再小会在合并时报 `EntityTooSmall`。实际单片大小由 `magicChunkCap(provider)` 给出 = `max(5MB, providers.fixedPartBytes(provider))` —— 对分片长度有硬性约定的厂商（如 UCloud US3 定长 8MB）取该厂商的固定值，其余厂商才是 5MB。**该上限同时约束三条入口**：分片上传的 `chunkSize`、直传（`/fs/upload/simple`，`express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后一次性加密）——后两者由加密入口 `encryptBuffer` 自身按模式拒绝，不再依赖调用方各自计算；此外「会话创建时为非 magic、上传中途管理员切到 magic」的续传路径会被**如实拒绝**（409），因为分片偏移由 `chunkSize` 决定，中途改小会与已传分片边界错位（涉及已落盘数据语义的参数不可中途变更）。彻底解决需要把密钥流换成可并行 / 可预计算的构造，那会改动密文格式并影响存量数据，**当前不做**。启用 `magic` 前请评估单文件大小与并发上传数；对性能敏感的场景请用 `crypto`（AES-256-GCM 走原生实现，无此问题）。
- **加密对象的 HTTP Range 有 32MB 分界**：读取侧对加密对象是「完整下载 → 内存解密 → 切片」，因此**明文超过 `MAX_RANGE_BUFFER`（32MB）时会退化为全量流式解密并忽略 Range**，返回 200 + 全量长度。此时 WebDAV 的 HEAD **也不会宣告 206 + `Content-Range`**（R10-07）——否则续传客户端会按区间建多个连接、每个却收到整份内容，拼装出损坏文件。
- **WebDAV 挂载写入不支持分片上传**：资源管理器里往挂载盘写大文件时走的是 PUT（全量缓冲），没有分片通道。因此在 `magic` 模式下写入超过 5MB 的文件会被明确拒绝（413），提示中会给出可执行出路（改用 `AES-256-GCM` 加密模式，或改用管理界面的文件上传——那里会自动按上限切分）。这不是 bug，而是「写入路径没有分片」这一设计事实的外显。
- 会话令牌滚动续期涉及底层改动，暂不实现。
- 子用户规模通常较小，不考虑多实例 / 集群部署。
- CSRF 以同源自定义头（`X-Requested-With`）为主，并在其之上做 Origin / Referer 与 Host 同源比对（R24-06），`Origin: null` 直接拒绝。
- **attestation 不做完整性链校验**：仅覆盖 ES256 签名算法，不处理 `packed` / `tpm` 等 attestation 格式的证书链验证（本系统信任首次注册的凭据，不做认证器厂商背书）。
- 为安全起见，修改回源设置、跨域设置、修改访问权限等操作需前往服务商控制台，本程序不提供此类功能。
- **审计日志不是取证级证据**：`data/logs.jsonl` 为**明文**、上限 5000 条且会轮转重写（高负载下可能只覆盖很短的时间窗），本机有权限的用户可随意编辑。它能回答「刚才发生了什么、谁在什么时候做了什么」，但**不具备抗篡改能力，不能用于抗抵赖**。需要长期留存请把日志外发到独立的日志系统。
- **DEK 与 `enc.key` 不可轮换**：R97 起主口令 / KEK 可轮换（重裹同一 DEK），但 DEK 与 `enc.key` 都没有 rekey 路径，语义仍是「文件不存在就新生成一把」。因此**删掉密钥文件再重启不是轮换，是销毁**——旧密文与旧配置立即永久不可读。`enc.key` 一旦泄露，处置只有「全量下载 → 用新密钥重加密 → 重新上传」，且必须**先保住老的 `enc-meta.json`**（否则连第一步的解密都做不了）。完整步骤见「目录结构 → 密钥轮换：DEK 与 `enc.key` 不可轮换」。

**关于 Windows Hello 的技术约束**：

- 仅支持 **ES256（ECDSA P-256 + SHA-256）**，与 Windows Hello 平台认证器默认算法一致；注册时只声明该算法，避免浏览器协商出服务端无法验证的算法。验签遵循标准 `ecdsa-with-SHA256` 语义——对**原始被签名数据**（`authData || SHA-256(clientDataJSON)`）做一次 SHA-256；签名同时兼容 DER 与裸 `r||s`（64 字节）两种编码；
- WebAuthn 要求**安全上下文**：`https://` 或 `localhost` / `127.0.0.1`（浏览器视回环地址为安全），因此通过**局域网 IP + 明文 HTTP** 访问时该功能不可用；
- **本地优先使用** **`localhost`**：`rpId` 必须是**有效域名**，IP 字面量不合法（部分浏览器直接抛 `SecurityError`，与是否 HTTPS 无关）。前端 `webauthnReadiness()` 将不可用原因分类（浏览器不支持 / 非安全上下文 / 使用了 IP 地址 / 正常），并给出可执行的修复动作；
- 服务端校验 `challenge`（一次性、5 分钟时效）、`origin`、`rpIdHash`、凭据 ID 一致性，并**强制要求 UP 与 UV 两个标志位**（任一项未置位即拒绝，Windows Hello 的生物识别 / PIN 一定满足）；另维护 `signCount` 递增以检测凭据克隆——**但该检查仅在认证器上报非零计数时生效**：Windows Hello 等平台认证器普遍恒为 0，实现中 `prev > 0 && next > 0` 两个条件都成立才比对，即该场景下**不提供克隆检测**（硬要比对反而会让这部分用户永远登不进来）；
- 公钥与凭据 ID **不下发前端**，前端只拿到 `webauthnEnabled` 布尔值与随机挑战。


<h2 id="develop_document-section18">3. 威胁模型与不设防边界</h2>

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
| 内网对象存储的域名被 DNS 劫持 | 端点守卫在**保存端点时**做一次 DNS 解析复判，但**连接期不复判** —— 解析后地址漂移（TOCTOU）的缺口仍在，只是被显著收窄（见「服务端点守卫」） |
| 合规 / 国密 / 等保要求 | 未做算法合规性评估。支付宝的 SM2 仅为其平台侧的签名算法选项，本系统的文件加密不使用国密。SM4 未引入的**实测依据与三条阻断理由**见「1.7 为何不引入 SM4 作为文件加密算法」（唯一权威定义） |

**magic 模式的明确定位**：它是**混淆级**保护，用于对抗「有人顺手打开云盘控制台、看到一堆文件就想点开看看」这类弱动机窥探（密文文件头被魔数覆写，直接双击无法打开）。它**不**用于对抗有动机的攻击者：异或密钥流不具备语义安全——同一主密钥 + 同一盐下相同明文必产生相同密文，且只要知道任意一段明文就能反推出该段的密钥流，进而还原对象其余部分。需要真正的保密性请使用 crypto 模式。

<h2 id="develop_document-section19">4. 审计后的行为变更</h2>

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

> 2.0.0 不是「攒够功能」才升的主版本号，而是一次**安全模型升级**：主密钥不再以明文落盘（4.1）、账户可以自助消失（4.2）、云端那份密文第一次能被**定期体检**（三、1.6）。三件事分三轮交付，共用同一条主线 —— 把「我们以为的状态」变成「可验证的事实」。
>
> 这三节分别落在 4.1、4.2 与「三、核心模块实现 1.6」，只讲**为什么这样做**与**边界在哪**；逐条实现细节见代码注释与 `CHANGELOG.md` 的 `[2.0.0]` 节，逐轮取舍见 `Audit_Ledger.md` 的 `R97`~`R99` 三行。

<h3 id="develop_document-section20">4.1 主密钥信封与登录密钥轮转（R97）</h3>

改之前的状态：`data/secret.key` 是一份**明文**主密钥，谁读到 `data/` 谁就能解开全部配置（云厂商密钥、桶、用户口令哈希）。备份被顺走、磁盘被挂载、容器镜像被推到公共仓库 —— 任意一种都能让它变成一次全量泄露，而系统本身毫无察觉。

做法是**信封加密**：主口令经 `scrypt` 派生 KEK，KEK 用 AES-256-GCM 包裹一把随机 DEK，磁盘上只留 `wrappedDek` 与盐。

<h4>4.1.1 落盘形态：只有包裹后的密钥，没有明文</h4>

| 项目 | 改之前 | 改之后 |
| --- | --- | --- |
| 主密钥 | `data/secret.key`（明文，可直接使用） | `data/keyring.json` 里的 `wrappedDek` + `salt`（**没有主口令就解不开**） |
| 解密所需 | 文件本身 | 文件 + **主口令**（= 根用户登录口令），两者分离存放 |
| 进程状态 | 恒为「可用」 | 启动即**锁定态**，解锁后才可用；无头部署可用 `KEPLER_MASTER_PASSPHRASE` 启动即解锁 |
| 轮转 | 不存在（换密钥等于重加密全部数据） | 换口令只需**重裹** DEK，数据文件一个字节都不动 |

| 文件 / 状态 | 内容 | 谁掌握 |
| --- | --- | --- |
| `data/keyring.json` | `kdf` / `kdfParams`（`scrypt`，N=2^17, r=8, p=1）/ `salt` / `wrappedDek`（`base64(iv‖tag‖ciphertext)`）/ `kekVersion` | 落盘，**单独拿到它解不出任何东西**（还缺口令） |
| 内存中的 DEK | 32 字节明文 | 只在进程内；`lock()` 时尽力抹零并清引用 |
| `data/secret.key`（历史） | 32 字节明文 | **迁移成功后删除**，`KEPLER_KEEP_LEGACY_KEY=1` 可保留 |

> ⚠️ **它解决什么、不解决什么**：解决「落盘泄露」；**不解决**「运行时内存被读」。集中式密钥方案必然有这一条 —— 只要进程要解密，它就必然在内存里有一份可用的 DEK。这不是实现缺陷，而是「单实例、单人持有」形态的固有属性（也正因如此，Shamir 秘密分享在这里没有增益，见 1.10）。

<h4>4.1.2 迁移与轮转：顺序本身就是安全属性</h4>

- **迁移只「重裹」，绝不「重加密」**。`config.enc` / `enc-meta.json` / `links.json` / `payments.json` 是多个文件，没有任何跨文件事务能让它们同时切换密钥 —— 无论先写哪一边，中间崩一次都是「新密钥 + 旧密文」或反过来，**两种都永久不可解**。只写 `keyring.json` 一个文件、一次 `rename` 就位，天然原子。代价是「旧 DEK 可能已泄露」这件事没有被治愈（那需要重加密全部数据，属另一类操作）。
- **删 `secret.key` 之前必须真的走一遍「重启视角」**：锁 → 用口令解锁 → 解出的 DEK 与旧 DEK 逐字节相等 → 配置仍能读回。任何一步失败即删掉刚写的 `keyring.json`、回滚到「只有 `secret.key`」的旧状态 —— 那个状态一定可用。
- **轮转先重裹、再改口令哈希**。反过来的话一旦重裹失败，就出现「新口令能登录、却解不开数据」，比「轮转没成功」严重得多；按现在的顺序最坏是「重裹成功、改哈希失败」，此时**回滚 KEK** 保证两边一致，轮转成功后**全部会话失效**（典型触发场景就是「怀疑口令泄露」）。新口令的强度校验刻意**提前到重裹之前**：否则每次手抖都要多付两次 `scrypt`，且容器已被改写再回滚。
- **锁定态是正常状态，不是故障**。「重启后尚未解锁」在语义上与「配置损坏」是两个方向相反的事实，混起来后果很具体：`config-store.load()` 会 `return null`（随后 `requireStore()` 就**初始化一份空配置落盘**）、会标记 `corrupted=true`（随后任何写入都复印一份 `.corrupt-*` 并把原文拒写）、`secure-store.readJson()` 会把 `enc-meta.json` / `upload-sessions.json` 打上「损坏、本进程永久拒写」。**一次普通重启就能把系统钉死**，且解锁也救不回来（只能重启进程）。故这三条路径各自单独识别 `KEYRING_LOCKED` 并**原样上抛**，由 `/api` 前置闸门统一转成 `503 + locked:true`。
- **锁定时必须连「解密后的配置缓存」一起清掉**。`config-store` 的解密结果有 60 秒 TTL 缓存（内含云厂商密钥、桶、口令哈希），只抹 DEK 而留着它，「锁定」就只是名义上的。清理动作注册在 `keyring.setOnLock()` 上（反向依赖：`keyring` 不 `require('config-store')`，否则成环），锁定有多个入口，漏一个就是一个「看起来锁了」的窗口。
- **无头部署**：设 `KEPLER_MASTER_PASSPHRASE` 即「启动即解锁」；不设则进程以锁定态启动，由前端解锁页接管（`GET /key/status` 与 `POST /key/unlock` 都登记在 `PUBLIC_API` 里 —— 否则「要解锁才能登录、要登录才能解锁」永久死锁）。`/key/migrate` 与 `/key/rotate-login` 是**根用户**专属：管理员能管站点与用户，但改解锁因子影响的是全实例的**解密能力**，不继承管理员的权力。

<h3 id="develop_document-section21">4.2 资料页面化 / 昵称 / 注册时间 / 自助注销（R98）</h3>

「编辑资料」原来是账户菜单里的一个小弹窗，只装得下用户名 / 密码 / 邮箱。本轮加了三件事，其中注销**有状态**（已提交 / 可撤销 / 到期删除），塞进弹窗只剩滚动条 —— 因此改成独立页面 `#profile`：有自己的地址、刷新不丢上下文、可以反复回来查看「将于某日删除」。

<h4>4.2.1 昵称不是用户名（两者的信任前提完全不同）</h4>

| | 昵称 | 用户名 |
| --- | --- | --- |
| 作用 | **展示名**（右上角、列表、日志里的人话） | **登录凭据**（另一半是密码） |
| 唯一性 | 允许重名 | 必须唯一 |
| 修改代价 | 随时改，**不需要当前密码** | 需要当前密码 |
| 清空 | 合法值 ⇒ 回退显示用户名 | 非法（登录会失去一半凭据） |
| 长度 | 32 个**码点**（不是 32 个 UTF-16 单元） | 2–32 字符，字符集受限 |

两个刻意的决定：

- **服务端不做「昵称为空就用用户名」的回退**。回退是**渲染决策**（账户菜单要昵称、用户管理可能要真名、审计日志要可追溯），写进接口就再也分不清「我设的昵称恰好等于用户名」和「我没设昵称」。前端统一走 `displayName()`。
- **截断按码点**（`Array.from(s).slice(0, 32)`）。`s.slice(0, 32)` 会把 emoji 的代理对劈成两半，落盘即乱码 —— 而它不会报错，只会让那个昵称永久显示成 `��`。

<h4>4.2.2 注销：15 天冷静期是三个分支，缺一不可</h4>

| 时刻 | 路径 | 行为 |
| --- | --- | --- |
| 提交申请 | `POST /users/me/deletion` | 校验**发往绑定邮箱**的 `delete` 用途验证码 → 写入 `deletion = { requestedAt, deleteAt }` |
| 冷静期内再次登录 | `completeLogin()` | **撤销**申请，响应回传 `deletionCancelled: true`（必须说出来，否则用户以为仍会被删） |
| 冷静期内主动撤销 | `DELETE /users/me/deletion` | 只清字段，不需要任何验证（收紧方向） |
| 到期后登录 | `completeLogin()` | **不再撤销**，当场执行删除并回 `403 { deleted: true }` |
| 从未再登录 | `purgeDue()` | 启动一次 + 每小时一轮，逐条 try/catch；失败**保留申请**，下一轮重试 |

四条设计纪律：

1. **证据链是「能收到绑定邮箱的信」**。验证码发往**已绑定**地址（不是用户临时输入的），且用途独立为 `delete` —— 与改邮箱的 `verify`、改密码的 `reset` 共用一份的话，将来放宽其中一条会连带放宽另一条，而注销不可逆。
2. **判据顺序也是判据**：`409 已有申请` 排在验证码校验**之前**。否则拿旧码重提的人会得到「验证码不对」，去重发、去重试，而真相是申请早已生效，且每次白耗一次尝试次数。
3. **失败方向必须是「账户留下」**。`deletion` 是清扫器读取的判据：坏结构（到期早于申请 / 非日期 / 缺字段）若被当成「立刻到期」，一次读盘就删号且不可恢复 ⇒ 归一化一律归零为「没有申请」。
4. **删除时做完全部连带清理**：会话、WebDAV 凭据、分享链接的**归属**（保留链接本身，`createdBy` 置空 —— 否则「删号 + 建同名账号」就把前者留下的链接连收款身份一起转交出去了）。

<h2 id="develop_document-section22">5. 安全说明</h2>



- **密钥加密存储**：配置写入 `data/config.enc`，AES-256-GCM（随机 IV + 认证标签）；访问密钥不回传浏览器，界面仅显示掩码。**【R97】主密钥改为信封加密派生的「锁定态」模型**（详见 §「主密钥信封与登录密钥轮转」）：`data/keyring.json` 只存 `wrappedDek` + `salt`，明文密钥**永不落盘**；进程启动时处于锁定态，由主口令（= 根用户登录口令）经 scrypt 派生 KEK 解包 DEK。老实例的 `data/secret.key` 由一次显式的迁移动作取代（迁移成功即删除该文件）。
- **账号口令存储**：登录口令以 **scrypt** 派生后只存盐与摘要——16 字节随机盐（32 位十六进制）、32 字节输出、代价参数为 `N=2^17`（131072）/ `r=8` / `p=1`（R69 起新建哈希；`N=16384` 仅作为存量哈希的兼容回退值）；校验用 `timingSafeEqual` 做定长比较，避免时序侧信道。必须使用**异步** scrypt（理由见「文件加密与元数据」）：同步版本会占满单线程事件循环，几十个并发请求就能让全站（含正在进行的下载与 WebDAV）一起卡死。WebDAV 口令因协议限制只能可恢复加密，与登录口令完全隔离（见「设计背景与刻意取舍」）。
- **文件加密**：加解密只在本机服务内发生，云端为密文；crypto 主密钥存于 `data/enc.key`、解密参数（IV / TAG / 盐 / 原始文件头）存于 `data/enc-meta.json`——**二者缺其一即永久不可解，必须同等备份**（完整清单见「目录结构」中的备份表）；查看密码以 scrypt 哈希存储、与加密密钥独立；加密对象禁止预签名直链，防止绕过查看密码。
- **部署强制 HTTPS**：`HOST` 非回环时明文 HTTP 一律 301 跳转 HTTPS，会话 Cookie 自动附加 `Secure`；WebDAV 仅提供 HTTPS。
- **暴力破解防护**：登录、加密查看密码、分享密码、WebDAV 认证均有 IP / 用户名级速率限制，连续失败触发指数退避锁定（上限 30 分钟）。
- **CSRF 与安全头**：非安全方法必须携带同源自定义头 `X-Requested-With`；统一下发 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`frame-ancestors` 等响应头。
- **敏感数据加密落盘**：`enc-settings.json`、`enc-meta.json`、`links.json`、`ipguard.json`、`upload-sessions.json` 均用主密钥直接做 AES-256-GCM 加密（`secure-store.js`，非二次派生；R97 起主密钥来自 `keyring.dek()`，迁移前为 `secret.key`），并自动兼容、升级历史明文文件；`enc.key` 写入后收紧为仅当前用户可读。
- **原子写入**：所有持久化文件采用「临时文件 + rename」，避免进程被强制结束时截断；临时文件名带随机量（防同毫秒重名覆盖），启动时自动清扫历史遗留的孤儿临时文件（仅清理进程已不存在的）。
- **单实例保护**：启动时获取 `data/.instance.lock` 独占锁，检测到另一个活跃实例即拒绝启动，避免两个进程交替整体覆盖 `config.enc`；崩溃残留的脏锁自动接管。
- **错误消息脱敏**：对象存储错误被翻译为分类化中文提示（如「签名错误：请检查 AccessKey / SecretKey 是否正确」「网络连接异常」），SDK 原始信息仅写入服务端日志。
- **会话治理**：每用户最多 10 个并发会话（超出淘汰最早），支持强制登出全部设备与管理员强制登出指定用户；默认有效期 24 小时，勾选「记住登录状态」为 30 天，Cookie `Max-Age` 始终与服务端剩余有效期一致；权限判定**实时读取用户记录**（改密 / 降权 / 删户后旧会话立即失效）。
- **反向代理**：限流与 IP 屏蔽依赖真实客户端 IP，置于 Nginx / CDN 之后须设置 `TRUST_PROXY=1`，否则默认使用 TCP 对端地址（防伪造 `X-Forwarded-For` 绕过）。**反向风险同样要紧**：直连暴露时**严禁**设置，否则任何人都能伪造 `X-Forwarded-For`，IP 屏蔽与全部限流同时失效。该开关的语义是「信任请求头里的全部跳数」，在 CDN → Nginx 这类链路上，请确保最外层代理会**重写**而非追加该头。
- **最小权限建议**：请在各厂商控制台创建**子用户 / 子账号**（腾讯云 CAM、阿里云 RAM、华为云 IAM 等），仅授予所需桶的对象存储读写权限，勿使用主账号密钥。
- **操作审计**：上传 / 下载 / 删除 / 重命名 / 移动 / 配置变更等关键操作记录于 `data/logs.jsonl`，界面内可筛选查看。
- **支付结果只认服务端查单**：规则见「设计背景与刻意取舍 → 支付结果仅限服务端查单返回」（权威定义，此处不重复）。已支付票据为 `订单ID.HMAC(linkId:orderId)` 的签名 Cookie（`httpOnly` + `SameSite=Lax`），签名输入同时绑定链接与订单，无法跨链接复用。

<h2 id="develop_document-section23">6. REST API 模块化组织</h2>

`server/routes.js` 是一个轻量**聚合器**，按业务领域将路由分散到 `server/routes/` 下的子模块，各子模块互不依赖：

```
server/routes/
├── _context.js   # 依赖汇聚：统一 re-export 全部 server 模块（单一 DI 点）
├── _shared.js    # 共享工具与中间件：requireAdmin / requireConfig / 桶解析与统计缓存 / 错误响应
├── auth.js       # 登录 / 登出 / 当前用户 / 初始化（匿名白名单，最先挂载）
├── users.js      # 用户 CRUD（管理接口全部管理员）+ `/users/me/*` 自助接口（改资料 / 昵称 / 注销，本人可达）
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
├── stats.js      # 测速 / 容量 / 概览 / 审计日志 / 健康检查
├── webauthn.js   # 【R97】Windows Hello（WebAuthn）凭据注册 / 关闭
├── key.js        # 【R97】主密钥解锁 / 迁移 / 轮转（迁移与轮转仅根用户；解锁匿名可达）
└── integrity.js  # 【R99】完整性巡检 / 防勒索校验（仅管理员；只读、不碰密钥）
```

约定：

- **新增路由落在对应领域子模块**；新增领域则建 `routes/<name>.js` 并在 `routes.js` 追加一行 `router.use()`。
- **挂载顺序有语义**：`auth` 必须最先（匿名白名单依赖它先命中）；`/credentials/visibility` 必须注册在 `/credentials/:id` 之前，否则会被参数路由吞掉。改动顺序前先运行 `npm test`。
- **路由表面积受测试保护**：`tests/routes-surface.test.js` 维护期望路由基线，增删路由必须同步更新，避免误删或意外遮蔽。

<h2 id="develop_document-section24">7. HTTP API</h2>

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

<h3 id="develop_document-section25">7.1 认证与用户</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（是否已完成配置） |
| GET | `/update/check` | 【R34】「关于」卡片的「检查更新」：与服务端版本（`package.json`）比较 GitHub 上的最新版本；**不挂 `requireAdmin`**（「关于」是设置页里唯一对普通用户可见的卡片），只读、无参数、结果缓存 10 分钟 |
| GET | `/key/status` | 【R97】主密钥状态。**匿名可达**（已登记 `PUBLIC_API`）：锁定态下前端还没有会话，必须能先问「要不要解锁」。匿名只回 `{ envelope, locked, unlocked }`；带有效会话时追加 `kekVersion` / `createdAt` / `rotatedAt` / `legacyKeyPresent` / `needsMigration` |
| POST | `/key/unlock` | 【R97】用主口令解锁（派生 KEK → 解包 DEK，明文密钥只在内存）。**匿名可达**，否则「要解锁才能登录、要登录才能解锁」会死锁；限流 10 次/分钟 + 失败 5 次临时锁定。成功**不签发会话** —— 解锁与登录是两件事 |
| POST | `/key/migrate` | 【R97】把老实例迁到信封加密（**仅根用户**）：校验根口令 → 用口令派生 KEK 包裹**现有 DEK**（数据文件不重加密、单文件原子写）→ 验证可读回 → 删除 `secret.key`。幂等；失败自动回滚到旧状态 |
| POST | `/key/rotate-login` | 【R97】轮转登录密钥（**仅根用户**）：step-up 校验当前口令 → 新口令强度校验 → 重裹同一 DEK（`kekVersion+1`，数据不动）→ 同步根口令哈希 → 全部会话失效。校验通过前绝不覆盖旧 `wrappedDek` |
| GET | `/integrity` | 【R99】读最近一次完整性巡检的结果（**仅管理员**）。**不发起任何云端请求** —— 系统设置页会反复调它（切角色 / 切卡片 / 手动刷新），顺手跑一轮等于每次打开设置页都扫描一次云端。返回本轮计数（扫描 / 正常 / 异常 / 跳过）、跳过原因（`locked` / `meta-corrupt` / `meta-unreadable`）与最近 50 条明细 |
| POST | `/integrity/run` | 【R99】立刻跑一轮巡检（**仅管理员**）。⚠️ 它**不是只读的**：会按候选集对云端逐个发 HEAD，消耗真实请求配额，并推进每桶的轮转游标，因此用 POST 而不是 GET（否则浏览器预取、代理重放、连按刷新都会各触发一轮）。与定时器撞车时**合流**成同一次，请求不翻倍 |
| PUT | `/integrity/notify` | 【R103】保存「巡检发现异常时发邮件通知」的开关与收件地址（**仅管理员**）。地址无论开关是否打开都先校验（`limits.parseEmailInput`，先判 CR/LF 再归一，防信头注入）；开启却没填地址直接 `400`，不做「先存着」的宽容。**SMTP 没配时不拒绝保存**，而是在响应里带 `warning` 说明「暂时发不出去」—— 两张卡片可以任意顺序配。幂等（同一份入参提交几次结果相同），发信由巡检在后台触发，不在本请求里发生 |
| POST | `/auth/init` | 首次启动初始化管理员 |
| POST | `/auth/register` | 自助注册（受「站点设置 → 注册模式」控制：`open` / `invite` / 关闭；关闭时**先于任何入参校验**即拒）。人机验证 + 用户名冲突限流，邀请码模式还须提交有效邀请码；成功后**注册即登录**（直接签发会话） |
| POST | `/auth/reset` | 邮箱验证码重置密码：向该账户**已绑定的邮箱**发码（`reset` 用途，与绑定邮箱的 `verify` 不通用），核销后改密并**使全部会话失效**。⚠️ **根用户在启用密钥信封时被拒**（`409 USE_KEY_ROTATION`）：这条路径只改登录哈希、不重裹 `keyring.json`，改完就是「新口令能登录、旧口令才能解锁」，必须改走 `/key/rotate-login`。判定放在验证码核验**之后**（此时已证明邮箱归属，不构成探测口），且**不核销**验证码 |
| POST | `/auth/login` · `/auth/logout` · `/auth/logout-all` | 登录 / 登出 / 登出全部设备 |
| GET | `/auth/me` | 当前会话用户 |
| POST | `/auth/login` | 登录第一步：人机验证 + 密码；若已启用 Windows Hello 则返回 `webauthnRequired` + 一次性挑战（**不签发会话**） |
| POST | `/auth/login/webauthn` | 登录第二步：校验 Windows Hello 断言，通过后签发会话 |
| GET/PUT | `/users/me` | 当前用户资料（**所有登录用户可用**；PUT 接受用户名 / 密码 / 邮箱 / **R98 昵称**，显式拒绝 role / permissions）。昵称只是展示名：不需要当前密码、允许重复、可清空（清空 = 回退显示用户名）；返回值含 `nickname`、`createdAt`（注册时间）与 `deletion`（注销申请，`null` = 无） |
| POST | `/users/me/deletion/code` | 【R98】发送「注销账户」验证码到**当前绑定的邮箱**（用途独立为 `delete`，与改邮箱的 `verify` 不通用 —— 否则将来放宽其中一条会连带放宽另一条）。未绑邮箱 400、根用户 403、已有申请 409 |
| POST | `/users/me/deletion` | 【R98】提交注销申请：校验邮箱验证码后写入计划删除时刻（**15 天后**）。根用户不可注销（没有"再建一个"的路径）；已有申请 409（防止悄悄续期）。冷静期内**登录即自动撤销**，到期由后台清扫或登录路径当场删除 |
| DELETE | `/users/me/deletion` | 【R98】撤销注销申请。不需要验证码 / 密码（撤销是**收紧**方向），无待撤销申请时 404 |
| GET | `/users` | 用户列表：管理层（管理员或根用户）返回全部（`scope:'all'`），普通用户仅返回自己（`scope:'self'`）。普通用户前端不显示用户管理卡片、也不调用此接口 |
| POST | `/users` · `PUT/DELETE /users/:id` | 增删改用户（管理层）。**授权只按 `role` 判定**：`permissions` 字段目前仅原样存储与回传，不参与任何鉴权判定。⚠️ **R71 的越权边界**：管理员只能操作**普通用户**（目标为 `admin` / `root` 时 403，且判定在写操作之前 —— 目标记录与其会话都不受影响）；`role: 'root'` 任何角色都 403（不可授予、不可撤销，`root` 账户的 `PUT { role }` 也是 400）；只有根用户能创建管理员、调整角色 |
| POST | `/users/:id/logout` | 管理层强制登出指定用户。R71：管理员只能踢普通用户的会话（否则等于给了一个「让根用户随时掉线」的骚扰通道） |
| POST | `/users/:id/ban` | 管理层**封禁**指定用户：请求体 `{ reason, until }`（`reason` 必填 ≤ 200 字；`until` 为 epoch 毫秒，留空 = 永久封禁）。写入后**立即吊销该用户全部会话**；不能封禁当前登录账户。R71：封禁是**软删除**，故与删除同口径 —— 管理员不能封禁管理员 / 根用户 |
| POST | `/users/:id/unban` | 管理层**解除**指定用户的封禁，立即恢复登录；从未封禁过时返回 400（不做「永远成功」的空操作）。R71：与封禁同口径（管理员只能解普通用户） |
| POST | `/webauthn/register/options` · `/webauthn/register/verify` | 注册 Windows Hello（**需当前密码**）：下发挑战+注册选项 / 校验 attestation 并保存公钥 |
| POST | `/webauthn/disable` | 关闭自己的 Windows Hello（**需当前密码**） |
| POST | `/users/:id/webauthn/disable` | 管理员清除指定用户的 Windows Hello 凭据（救济通道） |
| GET/PUT | `/captcha/config` · `GET /captcha/public` | 验证码开关与下发；`GET` 回 `providers.{recaptcha,turnstile}.{siteKey,hasSecret}` 两套视图（**明文 `secretKey` 任何情况下都不出服务端**，与公开视图一致），`PUT` 接受 `providers` 一次提交两套、未提交的那一套原样保留。`secretKey` 留空 = 保持原密钥不变，`null` = 显式清除 |
| GET | `/captcha/native` | R100：签发一道**原生算术题**，供没有浏览器 / WebView 的客户端通过人机验证（reCAPTCHA / Turnstile 的组件它加载不了）。**匿名可达**（已进 `PUBLIC_API`），仅在 `NATIVE_CAPTCHA=on` 时启用，未启用时回 **404**（不暴露「本机支持弱验证」）；按 IP 限流 20 次/分钟。响应 `{ ok, token, question, expiresAt }`；token 一次性、TTL 5 分钟、答错满 3 次作废 |

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
  "timeout": 300000,
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


<h3 id="develop_document-section26">7.2 配置、密钥与存储桶</h3>

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

<h3 id="develop_document-section27">7.3 文件与上传</h3>

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
  "limit": 500,
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
- `chunkSize` 由服务端计算：`min(48MB, max(8MB, ceil(size/10000/1MB)·1MB))`，magic 模式再压一道 `min(·, 5MB)`；但若厂商声明了固定分片长度（`providers.fixedPartBytes()`，如 UCloud US3 为 8MB），则取 `max(5MB, 固定值)`（R45；R8-02 的 5MB 是同步阻塞上限，同时是 AWS S3「除末片外每片 ≥ 5MB」的协议下限）。
- `uploadedParts` 非空即**命中断点续传**：按「Key + Size + 创建者 + 目标桶」匹配到未完成会话且远端 `uploadId` 仍有效，客户端应跳过这些分片。
- 会话 `provider` 随会话落盘（R7-01），后续 `chunk` / `complete` / `abort` 都按**会话自身**的厂商与桶解析凭据——上传中途切桶不会让已传分片作废。

**其余两个接口的入参**：`PUT /api/fs/upload/chunk` 走 query（`session`、`part`，从 1 开始，请求体为原始分片字节）；`POST /api/fs/upload/complete` 与 `/abort` 走请求体 `{ sessionId }`。三者都会校验会话归属（SEC-10：仅创建者本人或管理员可操作）。

- `chunk` 会校验分片大小 ≤ 会话的 `chunkSize`，超限返回 **400**（R10-08）：分片偏移已由 `chunkSize` 确定，超大的分片既无法正确合并，也会让 magic 的同步 XOR 独占事件循环数秒。

<h3 id="develop_document-section28">7.4 分享、加密、IP、WebDAV、统计</h3>

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
| POST | `/s/:id/logout` | 【R64】分享页右上角「退出登录」：销毁当前会话 + 清 `s3mgr_session` Cookie 后 303 回原分享页。刻意是 **POST**（GET 会让任何一张 `<img src>` 都能替访客退出登录） |
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
| POST | `/backup/export` | 【R38】导出配置：请求体 `{ password, backupPassword }`。`password` 是**当前账户口令**（权限验证，走 scrypt 校验 + 独立的导出限流器），`backupPassword` 是导出时**当场设置的独立备份密码**（用它把备份码密封，导入时必须原样输入）。回 `{ code, fingerprint, plainFingerprint, summary }`（`sections` 属于 `GET /backup/status`）；账户口令错误回 403 |
| POST | `/backup/import` | 【R38】导入配置：请求体 `{ code, backupPassword }`。**仅当实例仍处于「首次初始化、尚未配置过任何可备份项」时才允许**，否则回 409。这条闸门**在解密之前**判定——在已配置实例上先解密再看结果，会把「备份密码对不对」从响应差异里泄成一条口令预言机。导入是**整批覆盖**语义（原有设置全部丢失） |
| PUT | `/buckets/local/:id/block-overseas` | 按桶开关海外 IP 屏蔽 |
| GET | `/smtp/config` · `PUT /smtp/config` | 【R53】发信设置（SMTP）读取 / 保存（**均仅管理员**）。读取回的是**安全视图**：`{ enabled, host, port, secure, user, from, fromName, hasPassword, configured, updatedAt }` —— **口令明文永不出服务端**，界面只能看到 `hasPassword` 布尔值。保存是 **PATCH 语义**：缺省字段保持原值；口令三态（`null` = 清除 / `''` 或省略 = 保持不变 / 其它 = 覆盖）。入参非法一律 **400 显式报错**，不静默改写。⚠️ `enabled` 是**系统自动发信**（验证码 / 重置密码）的总闸门：停用后这类邮件一律不发（`server/email-code.js` 的 `sendCodeMail()` 抛 503，文案写明是「**已停用**」而不是「未配置」）。它与 `configured` 回答的是**两个不同的问题** —— `configured` = 「配没配」，`enabled` = 「开没开」；停用**不会**让 `configured` 变假（否则卡片会显示成「未配置」，而配置其实还在） |
| POST | `/smtp/test` | 【R53】发送测试邮件（**仅管理员**）。请求体可带**尚未保存**的字段（按 PATCH 语义覆盖已保存配置后发信），`to` 留空 = 发给发件人自己。⚠️ **不受 `enabled` 开关限制** —— 它是管理员手动触发的一次性动作；若加以限制，管理员就必须「先开启、才能验证」，而开启之后配置若有误，所有依赖发信的功能都会一起受影响 |
| GET | `/site/info` | 【R54】公开的站点名称（**匿名可达**，已登记进 `index.js` 的匿名白名单 `PUBLIC_API`）：**只回** `{ ok, siteName, registration }` 三个字段（`registration` 供登录页判断是否开放注册）。登录页在**拿到会话之前**就要用它设置浏览器标题栏，故不能挂管理员守卫；键数由 `tests/audit54-regressions.test.js` 断言，刻意不多回任何一个字段 |
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
| `password` | string / null | ✘ | 缺省 `null`。长度 **4–64** 字符（R94 起下界为 4）；传 `null` / `''` 表示不启用或**清除**已有密码 |
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

<h2 id="develop_document-section29">8. 支付设置</h2>

系统设置页内的「支付设置」卡片用于登记各支付平台的 API 凭证与站点地址。凭证部分只做**必填与格式校验**（不代持资金、不做联机验证）；下单与查单由 `server/payment-gateway.js` 直连各平台官方接口完成。

<h3 id="develop_document-section30">8.1 主要校验规则</h3>

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

<h3 id="develop_document-section31">8.2 开关层级</h3>

| 层级 | 字段 | 说明 |
| --- | --- | --- |
| 总开关 | `config.payment.enabled` | 卡片右上角「启用 / 停用」。**停用后所有付费链接自动转为免费下载** |
| 渠道开关 | `config.payment.platforms[id].enabled` | 每家平台独立开关，可任意组合 |
| 约束 | — | 总开关为**启用**时，至少保留一个渠道开启；关闭最后一个会被拒绝（400）并提示先停用支付功能 |

三态区分（界面与接口均体现）：`enabled`（开关打开）→ `configured`（凭证填完）→ `available`（= 两者皆真，下载者才可选它付款）。渠道开启但凭证未填完时状态为**待补全**，不参与可收款渠道列表。

<h3 id="develop_document-section32">8.3 接口</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/payment/config` | 总开关 + 四家平台表单定义（支付宝 / 微信 / 云闪付 / PayPal）+ 已保存配置 + 可用渠道（敏感字段仅回传是否已配置） |
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

<h3 id="develop_document-section33">8.4 支付状态机</h3>

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

<h3 id="develop_document-section34">8.5 各状态切换的字段变化、校验与异常处理</h3>

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

> **币种语义**：`currency` 恒为 `CNY`——它是 `payment-rules.js` 中的常量，写入分享链接时由 `normalizePaid` 强制归一，接口不接受其他取值。PayPal 本身支持多币种，但本系统不开放：各币种的最小单位并不相同（JPY 无小数位、KWD 为三位小数），「以分为整数」这一金额语义只对人民币成立，放开币种等于引入一整类舍入错误。

<h3 id="develop_document-section35">8.6 已支付凭证</h3>

支付成功后下发 Cookie 票据 `订单ID.HMAC(linkId:orderId)`，`httpOnly` + `SameSite=Lax`。签名输入同时绑定链接与订单，因此票据**无法跨链接复用**、也无法伪造；下载端只认 `status === 'paid'` 的订单。

标记为已退款后，票据依然能被识别（`payerState` 返回 `refunded` 而非 `none`）——这让下载者看到「这笔已退款，请重新支付」而不是「请付费下载」，但**不产生任何放行效果**；退款订单同样纳入「永不裁剪」集合，否则日后无从证明这笔钱退过。

<h3 id="develop_document-section36">8.7 订单退款（人工记账）</h3>

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

<h3 id="develop_document-section37">8.8 真实支付网关</h3>

`server/payment-gateway.js` 直连四家平台的官方接口，**零新增依赖**（RSA-SHA256 签名、AES-256-GCM 解密、HTTP 调用全部基于 Node 内置模块）：

| 平台 | 下单方式 | 下载者体验 | 结果确认 |
| --- | --- | --- | --- |
| 支付宝（当面付）**推荐** | `alipay.trade.precreate`（`FACE_TO_FACE_PAYMENT`，服务端 POST 出网，同步响应**验签在读业务字段之前**） | **本页直接画出付款二维码**，用支付宝扫码付款，不跳转 | `alipay.trade.query` |
| 支付宝（网站应用） | `alipay.trade.page.pay`（RSA2 签名后跳转收银台） | 跳转到支付宝页面付款，付完自动回跳 | `alipay.trade.query` |
| 微信支付 | Native 下单（APIv3，`Authorization` 五段式签名） | **本页直接画出付款二维码**，用微信扫码付款 | 按 `out_trade_no` 查单 |
| 云闪付 | 银联全渠道网关支付（`k=v&` 表单串 + 证书签名） | 跳转到银联收银台，付完回跳 | `txnType=00` 查单 |
| PayPal | Orders v2 创建订单后跳转 `approve` 链接 | 跳转 PayPal 审批页，付完自动回跳 | 查询订单，`APPROVED` 时补一次 capture |

支付宝的两条是开放平台上**独立签约**的产品线（各有独立限额），配置里 `mode` **二选一**（`face` / `page`），默认 `page` —— 这个默认值对老配置是必须的：`mode` 一旦是必填项，升级前就配好支付宝的站点会被判「配置不完整」，支付宝整个被移出可用渠道，**已付费的链接当场失效**。

**能不能就地画码只有一处判定**：`paymentGateway.supportsQr(platform, cfg)`（微信恒真、支付宝看 `mode`、云闪付 / PayPal 恒假），前端不抄第二份名单，只读服务端下发的 `data-qr`。命中就地画码的渠道下单后**不渲染「立即支付」按钮**，改在原位置画二维码；内容包括图形都落 `order.qrPayload`（只写一次），图形由 `qrBoxHtml()` **从内容重绘**（不存 SVG），因此 F5、从支付页回访、二次点「立即支付」都能重绘出同一张码而**不再打网关**。其余渠道保持原样：同源中转页 + 跳转收银台。

微信 Native 与支付宝当面付的二维码都由 `server/qrcode.js` 自行生成（字节模式、纠错等级 M、版本 1–10、按 ISO/IEC 18004 计算纠错码字与掩码惩罚分，输出内联 SVG），不引入二维码库；`tests/qrcode.test.js` 按标准逐项校验。⚠️ 该编码器**超过 213 字节会静默返回空串**（不抛错），故 `qrBoxHtml()` 在 `toSvg()` 返回空时给一句可照做的说明而不是留白。

<h3 id="develop_document-section38">8.9 支付结果确认（服务端查单）</h3>

规则同「设计背景与刻意取舍 → [支付结果仅限服务端查单返回](#develop_document-section10)」（**权威定义，此处不重复**）。支付侧的两个具体落点：

- **四个触发点**：同步回跳 `/s/:id/pay/return`、前端轮询 `/s/:id/pay/status`、异步通知 `POST /pay/notify/:platform`，以及「我已完成支付」按钮的 `POST /s/:id/pay/check`。四者都只负责**触发一次查单**，成功与否一律以查单结果为准。
- **三层限流**：订单级最小间隔 3 秒，`payCheckLimiter`（手动查单）与 `payStatusLimiter`（轮询）各自按 IP 限额。该端点匿名可达，且会携带真实商户凭据向平台查单——缺少限流时任何人扫到回调地址即可反复触发查单、刷光平台的查单配额。

**新增一家支付平台的步骤**：① 在 `server/payment-providers.js` 定义 `fields`（含 `official` 官方字段名、`pattern` / `validator` / `secret` 标记、`maxLength`）；② 需要联机校验时用 `registerValidator(platformId, fn)` 登记，路由与前端无需改动；③ 在 `server/payment-gateway.js` 实现 `createCharge` / `queryCharge`——**查单必须 fail-closed**（异常即视为未支付，不放行）；④ 前端 `paysettings.js` 的表单由服务端下发的同一份字段定义渲染，通常无需改动，只需在 `server/payment-logos.js` 的 `SHAPES` 表追加图形（前台与后台同时生效 —— 前端不再持有图形副本）。

<h2 id="develop_document-section39">9. 搜索</h2>

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

<h2 id="develop_document-section40">10. 性能与可靠性</h2>

- **异步 I/O**：日志内存缓冲（50 条或 2 秒）批量落盘；配置、加密元数据、分享链接、上传会话、统计均异步 / 串行写入，避免阻塞事件循环。
- **缓存与并发**：解密配置 60 秒 TTL 缓存；多桶统计并发上限 3，腾讯云优先调用官方 `?stats`、失败回退对象列举（S3 厂商直接走列举估算），容量结果缓存 15 分钟。
- **高效匹配**：国内 IP 段（6000+）预排序 + 二分查找；搜索无筛选条件时降低扫描量，结果超限给出提示。
- **传输优化**：`/api` JSON 响应与静态文本资源（`.html/.js/.css/.svg/.json/.webmanifest` 等）启用 gzip——实测 `main.js` 体积降约 71%、`style.css` 降约 77%（**测量口径**：`zlib.gzipSync` 默认压缩级别，样本为当时的仓库产物；压缩比随文件内容浮动，请按「量级」而非绝对值理解，复现时以你手上的文件为准）；流式下载 / 缩略图 / 测速接口与已压缩二进制（`.png/.woff2/.mp4` 等）自动跳过，避免大文件缓冲进内存；JS / CSS 静态资源 5 分钟强缓存（HTML no-cache）；下载以 `stream.pipeline` 传递背压并设无活动超时；WebDAV **读取**支持 HTTP Range 断点续传（写入侧为全量缓冲，见「技术限制与已知局限」）。

---

<h1 id="develop_document-section41">三、核心模块实现</h1>

<h2 id="develop_document-section42">1. 文件加密与元数据</h2>


<h3 id="develop_document-section43">1.1 三种方式与密文结构</h3>

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

<h3 id="develop_document-section44">1.2 元数据是解密的唯一凭据</h3>

解密参数（IV / TAG / 盐 / 原始文件头 / 原始大小）保存在 `data/enc-meta.json`，按 `<bucket>|<key>` 索引。该文件是 crypto 与 magic 两种模式解密的**唯一**凭据来源，因此围绕它有一组硬性约束：

- 读取失败时以空表继续运行以保证服务可用，同时置「损坏」标记并**拒绝写入**，磁盘原件另存为 `.corrupt-<时间戳>` 备份等待人工恢复——绝不用空表覆盖。
- 密文一旦安全落云，立即把解密凭据同步落盘，将「云端已有密文、本地尚无元数据」的窗口压到零；上传完成等关键节点与进程退出钩子各兜一次。
- 重命名 / 移动 / 复制时同步迁移元数据；只有**云端确认删除成功**的对象才清理其元数据。按前缀无条件清空的接口已从代码中移除：它与「列举被截断」组合时会只删掉前 N 个对象却清空整个前缀的元数据，残留密文永久不可解。

<h3 id="develop_document-section45">1.3 分片路径与完整性校验</h3>

分片加密状态随上传会话持久化，magic 模式的盐与原始文件头在首次加密时即固定，进程重启后续传仍保持一致。

magic 属混淆级保护，本身没有认证标签：密文一旦被篡改或损毁，旧实现会静默产出看似正常但内容错误的明文。现改为在元数据中记录明文摘要、并在解密流末尾校验：

- 直传记录整文 SHA-256；分片路径在分片**连续且按序**到齐时给出逐片摘要，解密时在确定性边界上逐段校验；任一分片缺失则不声称可校验（回退旧行为）。
- 摘要按**还原后的完整明文**分段，而密文体偏移不含被魔数覆写的头部，故解密侧需维护独立的明文游标；跨分段边界的缓冲区必须按边界切分后分别累加，否则正常文件会被误判为篡改。
- crypto 模式为**每段独立**的 GCM 认证：段内任何字节被篡改，都会在该段 `decipher.final()` 处报错；密文被**截断**时，末尾的分段状态机走不完，`flush` 直接判为「数据不完整」——也就是说「尾部少一段 / 少几个字节」是可以检出的。
- 但**逐段 GCM 只认证单段**：AAD 为空，段序号与对象身份都没有被绑定进认证。因此把两个**等长**段的 `IV ‖ 密文 ‖ TAG` 整块互换、或把同一密钥下另一个对象的段拼进来，每段自身依然能通过认证——解出的是顺序错误或来源错误的明文，且无从察觉。这是**已知局限**：补 AAD 需要版本号与迁移路径（老密文没有 AAD，直接改会让历史对象全部解不开），因此暂未引入。

<h3 id="develop_document-section46">1.4 查看密码与访问令牌</h3>

查看密码是可选的访问控制层，与加密密钥相互独立（以 scrypt 哈希存储，忘记可重置）。校验通过后签发 30 分钟有效的 HMAC 令牌：**管理端 `/api/**` 只从 `x-enc-token` 请求头读取**（不进入 URL、浏览器历史、Referer 与访问日志），**分享页 `/s/…` 另发一枚 `HttpOnly`、`path=/s/` 的 Cookie** 供解锁后复用（该 Cookie 不进入 `/api/**`）。

R22-04：本库「解密下发」共三个出口 —— 管理端 `/api/fs/download`、分享页 `/s/:id/dl`、WebDAV 挂载 `/dav`。**查看密码只覆盖前两个**；**WebDAV 出口不叠加这道门禁**，它由独立的 Basic 认证与 IP 守卫把关，凭据须由管理员在配置中授予（非自助注册）。该归属此前未在文档中声明，是「同一控制在不同出口结论不同」的根因，现予明确。

口令校验入口一律使用异步 scrypt：该类入口攻击者可达，同步版本会占满单线程事件循环，数十个并发请求即可让全站失去响应。

<h3 id="develop_document-section47">1.5 孤儿元数据巡检</h3>

对象被本系统之外的工具删除，或云端操作成功而本地元数据写入失败，都会留下指向已不存在对象的元数据。孤儿记录本身只造成无谓膨胀，但元数据丢失意味着密文永久不可解，二者方向相反、不可简单取舍。因此提供巡检接口：列出某桶下「本地有元数据、云端已无对应对象」的候选，**交由调用方决定是否清理**，巡检过程本身不删除任何记录。

<h3 id="develop_document-section48">1.6 完整性巡检 / 防勒索校验（R99）</h3>

本系统把**密文**放在别人的对象存储上。云端那份字节是否还是我们写上去的那份，本地原本一无所知：控制台误操作、生命周期规则、同步工具回写、勒索软件批量覆盖 —— 这些都不经过本系统，`list-cache` 的失效钩子也收不到任何信号。

表现最恶劣的一种是**静默**：文件还在、能列出来、点下载也不报错，但内容已经不是自己的了。

<h4>1.6.1 三个判据，全部来自一次 HEAD</h4>

| 判据 | 事实 | 能抓到什么 |
| --- | --- | --- |
| `missing` | HEAD 返回 404 / `NoSuchKey` | 对象被删、被生命周期规则清掉、桶被换 |
| `size` | `Content-Length` ≠ 由 `enc-meta` 推导的密文长度 | 截断、拼接、被换成别的文件、上传中断 |
| `modified` | 云端 `Last-Modified` 晚于 `max(createdAt, cloudWrittenAt)`（R101；5 分钟容差） | **同长度的原位覆盖**（勒索软件 / 同步工具回写） |

密文长度的推导公式（与 `enc-store` 的加密实现逐字节对应，常量共用 `CRYPTO_MAGIC` / `IV_LEN` / `TAG_LEN`，不各写一份）：

- `crypto` 模式：`[COSCENC01][iv(12)][ct][tag(16)]`，分片上传时**只有首片**带魔数头 ⇒ 总长 = 魔数长 + Σ(12 + ctLen + 16)。
- `magic` 模式：覆写文件头 + 流式异或，密文长度 = `max(origSize, magicLen)`：明文不短于魔数时与明文等长；明文短于魔数（空文件 / `.gitkeep` 等）时恒为魔数长度（R101）。

<h4>1.6.2 边界、成本与执行顺序</h4>

- **不重算 `enc-meta` 里的 sha256**。那些摘要是**明文**的，重算必须先把密文解出来，而巡检的红线是「不碰密钥」：不解锁、不读 DEK、不做任何解密。它必须在「进程锁定」时也能安全地什么都不做，而不是变成一条「必须解锁才能跑」的后台任务。
- **抓不到什么（写清楚，不是遗漏）**：长度与 `Last-Modified` 都被保持一致的原位篡改。那种只能靠**下载时**的 GCM tag / 明文摘要发现。攻击者若能连对象时间戳都保持一致，本地就没有任何离线证据可用。
- **候选集与成本**：候选集 = `enc-meta.json` 的键（「我们加密过哪些对象」的唯一权威），不是列举云端的结果 —— 列举回答的是「桶里有什么」，既证明不了「我们那份还在」，也解释不了「少了一个对象」是删了还是改名了。轮转游标 + 每轮上限（`INTEGRITY_BATCH`，默认 200）把成本摊平：一万个对象、每 6 小时一轮、每轮 200 ≈ 12.5 天覆盖一遍，云端请求量约等于一次浏览。命中 `search-candidates`（全桶递归搜索留下的候选集）时连 HEAD 都省掉 —— 但它是一份明确可能过期的清单，**只许省请求、不许当判据**。
- **「不存在」的口径必须比「出错了」窄**：只认 404 / `NoSuchKey` / `NotFound`；403（凭据缺 HeadObject 权限）、5xx、网络超时一律计「跳过」。把探测失败当成「对象没了」，凭据一过期就是整屏假警报，而**真正的丢失会被淹没** —— 在这个功能里，假阳性的代价高于漏报（用户会立刻学会无视它）。
- **第一条判据是「锁定态」**：`enc-meta.json` 是加密文件，锁定期间读它会把 `metaCorrupt` 置真并让本进程永久拒写元数据 —— 一次巡检就能把全站上传打坏。锁定则一步都不往下走（不枚举桶、不读元数据、不发任何云端请求），且「锁定」与「元数据损坏」报**两个不同的原因**（处置完全不同：去解锁 vs 去修数据）。
- **会定时自动跑，也可手动触发**：启动 60 秒后跑首轮，此后按 `INTEGRITY_SWEEP_MS`（默认 6 小时）周期执行，两个定时器都 `unref()`；`GET /integrity` 只读内存里的最近一次结果，`POST /integrity/run` 是显式立即执行（与定时器撞车时合流为同一次）。自动跑之所以成立，是因为成本已由「轮转游标 + 每轮上限」摊平，而不是每轮全量扫。

<h4>1.6.3 异常通知：把「查出来了」变成「被告知」（R103）</h4>

巡检的结果原本只有**打开系统设置页**才看得见，而它要防的恰恰是「没人看的那段时间里云端被人动了」。周期是 6 小时，但「发现」与「有人知道」之间可以相隔几天。`server/integrity-notify.js`（仅管理员可配，收件地址固定一个）补上这一段。

- **谁能触发**：只有 `missing` / `size` / `modified` 三种（即 `result.bad` 的口径）。`unknown` / `error`（403、5xx、网络不通）是「没查清」，不是「坏了」；把对象存储的一次抖动变成一封「你的数据被篡改了」，比不通知更糟。同名桶歧义（`ambiguous`）与整轮跳过（锁定态 / 元数据损坏）同样不通知 —— 那是本系统自己的状态问题，处置方式是改桶名或去解锁，不是去云端抢救数据。
- **不能每轮都发**：6 小时一轮、一天 4 封一模一样的信，一周后这个地址就被规则丢进垃圾箱，**真正的新异常也被一起忽略**。判据是「签名变了 或 距上次发送超过冷却期」：签名 = 本轮所有异常对象的 `结论|桶|键` 排序拼接 —— 新增一个坏对象立刻发；同一批则在 `COOLDOWN_MS`（12 小时，即两轮）后**复述一次**，兼顾「别刷屏」与「别忘了它还坏着」。
- **失败不影响结论**：`maybeNotify()` 自己吞掉一切异常、永不 reject，`commit()` 也不 `await` 它（发信最长 15 秒，等它等于让「立即巡检」按钮卡住）。失败只记 `lastError` 与操作日志，**且不推进签名** —— 否则一次 SMTP 故障会让这批异常永远收不到信；另有 30 分钟退避，避免 SMTP 挂着时每轮都去连一次。
- **通知状态只在内存**：与巡检游标同款。重启后的第一轮若仍有异常会再发一封 —— 刻意接受这一侧偏差（漏报比重复报贵得多）。
- **隐私边界**：正文含**桶名与文件名**，走的是「发信设置（SMTP）」那一套服务器。未启用 TLS 的 SMTP 意味着这些内容在链路上是明文；不想承担就保持默认关闭。卡片里写明了这一点。

配置落在 `config.enc` 的 `integrity.notify`（`enabled` / `email` / `updatedAt`），保存走 `PUT /integrity/notify`；**SMTP 没配时不拒绝保存**，而是在响应里带 `warning` —— 两张卡片可以任意顺序配，否则管理员会被逼着按特定顺序填表。

<h2 id="develop_document-section49">2. 统一文件网关</h2>

<h3 id="develop_document-section50">2.1 收口的理由</h3>

`server/fs-gateway.js` 是全部对象读写删操作的唯一入口，管理端路由与 WebDAV 共用。收口之前 WebDAV 直连 SDK，会产生四类问题：写入未加密、读取直接下发密文（用户编辑回写即永久损坏）、删除 / 复制 / 移动不联动元数据、全链路无审计日志。

网关行为随加密模式自动切换：不加密时走直通路径，行为与未启用加密完全一致；加密时写操作自动加密后上传，读操作挂载解密流透明还原，删除与复制移动同步联动元数据并记录审计。

<h3 id="develop_document-section51">2.2 读取路径：信号量与范围请求</h3>

- 加密读取受信号量限流（并发上限 3），避免多路大文件同时解密造成内存线性增长。释放器必须幂等且带下界保护：可销毁流在带错误销毁时会先 `error` 后 `close`，若两个回调各递减一次，计数将漂移为负，此后并发上限永久失效。
- 加密对象的范围请求需完整下载解密后在内存中切片；明文超过上限即退化为全量流式解密（忽略 Range），避免单请求占用与明文等量的内存。非加密对象的 Range 由对象存储原生处理。

<h3 id="develop_document-section52">2.3 删除、复制与移动的截断契约</h3>

前缀删除（目录删除）必须遵守同一套契约，且全项目只允许一份实现：

1. 显式判定列举是否被截断，循环执行「列举一页 → 删除一页」直至清空或达到轮次上限；
2. **仅当云端删除确实成功后**才按批清理元数据，绝不先清元数据再删对象；
3. 目录标记对象在全部子对象删除成功后再删，截断时不删；
4. 仍被截断时如实返回截断标记，由调用方告警——绝不返回成功。

复制同样存在大小阈值：服务端单次复制有上限，超出必须先探测对象大小再决定是否分块复制，否则会出现「同一操作在管理界面成功、在 WebDAV 必然失败」的行为分裂。`CopySource` 的格式由客户端工厂统一生成（S3 厂商为 `/bucket/key`，腾讯云为外链形式），不再本地硬编码。

<h2 id="develop_document-section53">3. 分片上传与断点续传</h2>

- 会话持久化在 `data/upload-sessions.json`，记录 uploadId、已上传分片 ETag 与**分片加密参数**；加密参数同样受敏感数据保护。
- 恢复上传按「Key + Size + 创建者 + 目标桶」匹配。仅按 Key + Size 匹配会命中其他用户或其他桶的会话：前者泄露他人会话标识与分片进度（存在性侧信道），后者会让续传落到错误的桶上。
- 启动时的过期清理会尽力中止远端分片（避免持续计费）且不等待其完成；会话总数设上限，超出时按更新时间淘汰最旧的记录。
- 落盘采用去抖合并，但**去抖窗口内进程被强制终止会丢失分片加密参数**——已上传的分片将无法解密，表现为「上传成功但文件无法打开」，重新上传还会产生新的计费分片。因此优雅停机必须强制落盘；退出钩子的兜底必须使用同步写，异步写在 `exit` 处理器返回后永远不会被调度。
- 会话列表按创建者过滤，管理员可见全部。

<h2 id="develop_document-section54">4. 分享链接生命周期</h2>

<h3 id="develop_document-section55">4.1 标识与快照字段</h3>

链接 ID 为 16 字节 base64url（22 字符，128 位熵）——它会暴露在公开 URL 中，故不能过短；历史 8 / 12 字符 ID 仍可正常访问。链接在创建时快照目标对象、所属桶、展示用文件名与大小；分享者的收费意图同样原样保留在链接上。

快照只表达意图，是否真的收费由付费规则在**读取时**计算：停用支付功能后链接自动转为免费，重新启用又自然恢复，全程无需改动链接数据。

**管理页的列**：除文件与状态外，还展示**分享者**（`createdBy`）与**存储桶**（`bucket`），两者同样取自创建时的快照 —— 管理员看到一条陌生链接时，先要知道它是谁建的、指向哪个桶，才能决定是联系创建者还是直接处理。早于「按创建者隔离」那次改造创建的链接没有 `createdBy`，界面显示占位符而不是把空白当成某个用户。

<h3 id="develop_document-section56">4.2 状态判定顺序</h3>

状态序为 `已删除 > 已过期 > 次数用尽 > 有效`。「对象已不存在」排在最前：它是最根本的事实，否则管理页仍显示「有效」，管理员会去调整有效期或次数，改完照样无法下载。前端判定独立成模块并与服务端同序，避免出现「管理页显示有效、访客打开却提示文件已删除」。

对象缺失有两个判定来源：系统内删除对象时，按**已确认删除的 key 集合**批量标记（不接受前缀，理由同元数据清理）；系统外删除则依靠分享页的惰性探测补齐，且只有云端明确返回「不存在」才予标记，其余一律按「仍存在」处理——误标会让一条正常的链接被永久判死。

<h3 id="develop_document-section57">4.3 下载配额与来源判定</h3>

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

<h2 id="develop_document-section58">5. 请求上下文与会话鉴权</h2>

- 「当前桶」是会话级状态；全局默认桶的语义降级为**系统默认桶**，仅在无会话场景（WebDAV、分享链接、启动自检）与首次登录时作为回退。
- 上下文基于 `AsyncLocalStorage`，在鉴权中间件里建立一次，后续任意深度的异步调用都可取到，路由层无需逐个传参——避免为几十个调用点补参数时的漏改。切换当前桶可直接更新上下文，无需重新登录。
- 权限判定一律以**实时用户记录**为准，不使用登录时写入会话的角色快照；用户在配置中已不存在时直接销毁会话。
- 会话 Cookie 的 `Max-Age` 由服务端剩余有效期推导；勾选「记住登录状态」时有效期由 24 小时延长至 30 天。浏览器本地只保存用户名——真正免于重复登录的是会话有效期，而非本地存储的凭据。
- 未捕获异常不因已打印而继续服务：本服务持有「加密元数据」与「配置」两类一旦写坏即不可逆的状态，继续接受请求会让故障在用户数据上放大，因此记录后触发优雅关闭。

<h2 id="develop_document-section59">6. IP 访问守卫</h2>

- 规则模型：目标（单 IP 或 CIDR）、作用范围（空 = 全局，否则为桶集合）、方法（空 = 全部方法）、启用状态与命中计数。历史单桶字段在加载时迁移为数组。
- 判定优先级：**回环放行 → 桶级规则（仅作用于目标桶的请求）→ 全局规则 → 按桶屏蔽海外 IP**，任一级别命中即屏蔽；桶级与全局规则互不覆盖，各自独立生效。
- 目标桶必须按会话解析。若直接读取全局默认桶，用户切换当前桶后「对 A 桶生效的封禁」会在切到 B 桶时失效，反之 A 桶的合法请求可能撞上 B 桶的封禁。
- 「屏蔽海外 IP」按桶生效：仅当请求能解析出目标桶且该桶开启开关时才参与判定，避免误伤管理界面导致自身被拒。
- **IP 段数据须自行维护**：`china-ips.txt` 的正确性完全依赖这份数据，而 IP 段会持续分配与回收——请自行确认其数据来源、许可证与更新周期，并定期替换（替换后重启服务生效）。加载时折叠为「互不相交且升序」的闭区间这一不变量，由 `tests/audit-regressions.test.js` 断言保护：不变量一旦被破坏，二分定位会**静默漏判**（既不报错也不命中）。
- 中间件必须挂在鉴权之前（否则被屏蔽的请求会先执行一遍业务逻辑），因此需自行解析一次会话 token。WebDAV 服务复用同一套判定——它监听独立端口，此前完全不受约束，等于为屏蔽规则开了一道旁门。
- 命中提示页会回显客户端 IP；该值在启用 `TRUST_PROXY` 后来自请求方可控的请求头，必须转义。

<h2 id="develop_document-section60">7. 速率限制与失败锁定</h2>

- 限流采用滑动计数窗口，按 IP（可拼接业务键）统计，超限返回 429 并给出重试等待秒数。
- 失败锁定在「同一窗口内连续失败达阈值」后触发，冻结时长随失败次数指数增长（有上限）。计数必须按窗口衰减：终身累计会让隔数日手误一次的正常用户在第 N 次被锁在门外。**但锁定期内不得重置**——否则等到窗口滑过再失败一次即可清零，等于为锁定留了后门。
- 条目回收条件需覆盖「从未被锁定」的条目，且在记录失败的路径上同样执行回收，不能只依赖查询路径顺带触发。
- 跟踪表设有键数硬上限，达上限时优先淘汰未锁定的条目；该上限只承担内存安全职责，不作为安全边界——各入口自身的限流器才是边界。
- 预置实例覆盖登录、加密查看密码、分享密码、系统初始化、口令校验类管理动作、WebDAV 认证、分享下载与支付异步通知。其中支付通知端点匿名可达，且会携带真实商户凭据向网关查单：缺少限流时，任何人扫到回调地址即可反复触发查单、刷光查单配额。

<h2 id="develop_document-section61">8. 列举上限与目录缓存</h2>

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

<h2 id="develop_document-section62">9. 统计与操作日志</h2>

- 统计按天聚合（保留最近 30 天），另有按桶累计的上传 / 下载字节数与请求数；实时速率为内存采样，不持久化。
- 操作日志写入 `data/logs.jsonl`，上限 5000 条：内存缓冲合并写入，避免每次请求同步追加阻塞事件循环；字段经清洗去除控制字符并截断长度，避免污染 JSONL 结构。
- 轮转由定时器在空闲时执行：先刷出缓冲再轮转（否则两者几乎必然相撞、轮转长期得不到执行），且只在确实超出上限时做异步流式重写，不再无条件全量重写整个文件。
- 统计文件的损坏降级语义与敏感数据不同：统计并非核心数据，不因它拒绝启动，但**读降级为空表、写永久锁定**，磁盘原件备份为 `.corrupt-<时间戳>` 等待人工恢复。

<h2 id="develop_document-section63">10. WebDAV 服务</h2>

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

<h2 id="develop_document-section64">11. 服务端点守卫</h2>

自定义 `endpoint` 决定服务端把凭据发往何处，因此校验策略默认从严：

- 仅接受 http / https 协议；非回环地址一律要求 https，否则访问密钥将以明文暴露在链路上；
- 回环地址与私网 / 链路本地 / 保留 IP 字面量默认拒绝，可用 `ALLOW_LOOPBACK_ENDPOINT=1`、`ALLOW_PRIVATE_ENDPOINT=1` 显式放开内网对象存储场景；
- 云平台实例元数据地址永远拒绝，不受上述开关影响；
- **两层判据**：同步判据（IP 字面量 / 元数据主机名 / 协议 / 私网开关）**始终生效**；在**保存端点时**额外做一次 DNS 解析复判（`assertSafeEndpointResolved()`，`routes/config.js` 四处落库前与备份导入各复核一次）。**连接期不再复判**，因此「解析后地址漂移」（TOCTOU）的缺口仍然存在、只是被显著收窄 —— 既不把它写成「完全没有这层防护」，也不假装它是完整闭环。

<h2 id="develop_document-section65">12. 上传过滤匹配器</h2>

`.gitignore` 语法解析遵循 git 官方规范：注释、`!` 取反、尾随 `/`（仅匹配目录）、`**` 前导 / 中间 / 尾随、`* ? [..]` 通配、反斜杠转义；含 `/` 的规则锚定在 `.gitignore` 所在目录，否则可匹配任意层级；同一路径按规则顺序「最后命中者生效」。

实现必须是**线性匹配器**（模式编译为 token 序列后以动态规划推进），绝不可编译为正则：`.gitignore` 文本来自客户端，多条通配符相邻会形成嵌套量词，`**/**/**/…` 或大量 `*a*a*a…` 会让 V8 正则进入灾难性回溯，单线程事件循环被占满，全站（含 WebDAV 与所有下载）失去响应。服务端与浏览器端各有一份实现，逻辑必须保持一致。

解析设有结构性上限，超出时**截断并在匹配器上标记**，由调用方决定是否告警——静默丢弃会让「本该被忽略的文件却被上传」难以排查。

<h2 id="develop_document-section66">13. 持久化、启动与关闭</h2>

- 全部持久化文件采用「临时文件 + rename」的原子写入。直接写目标文件会先清空再写入，进程在两步之间退出即留下 0 字节文件。临时文件名必须包含随机量：仅用毫秒时间戳会在同一毫秒内重名，后一次写入以 `w` 模式打开同一临时文件并先行截断，两次写入将共用一份数据。
- 启动时清扫孤儿临时文件，三重条件缺一不可：文件名匹配本模块规则、文件名中的 pid 已不存活、修改时间早于阈值。Windows 上 `process.kill(pid, 0)` 对系统服务返回 `EPERM`，需再核对一次进程列表，避免将系统服务误判为孤儿。PID 复用会导致漏删，清扫属尽力而为，宁可漏删不可误删。
- 日志类追加改用 `appendFile` 而非「读全文件 + 整体替换」，消除 O(n) 写放大；代价是崩溃时可能只损坏最后一行，对日志场景可以接受。配置类文件仍走原子写入。
- 敏感 JSON 统一以 AES-256-GCM 加密落盘，主密钥复用配置主密钥；兼容历史明文文件，读取时自动识别、写入时自动升级。写入按文件维度串行化，避免并发交错导致文件损坏。
- 单实例锁基于独占创建的锁文件，锁内记录 pid；持有者进程已不存在时自动接管。其目的在于避免两个进程各自持有配置缓存并交替整体覆盖 `config.enc`。
- 优雅关闭按顺序收摊以下状态（`server/index.js` 的 `done()`），最后退出并设兜底超时：① 刷日志缓冲（`flushLogsSync`）→ ② 刷统计（`flushStatsSync`）→ ③ 上传会话落盘（`uploadSessions.flush`）→ ④ 加密元数据同步落盘（`encStore.flushMetaSync`）→ ⑤ 支付订单落盘（`paymentOrders.flush`）→ ⑥ 取回封禁落盘（`restoreGuard.flush`）→ ⑦ 关闭加密线程池（`encPool.shutdown`）→ ⑧ 等待 `secureStore.flush` 与 `configStore.flush` 完成；随后关闭 WebDAV、释放单实例锁、`process.exit(0)`。漏掉 ③~⑥ 任一项，进程重启后就会丢上传会话 / 加密元数据 / 订单状态 / 取回封禁。

<h2 id="develop_document-section67">14. 前端模块与渲染约定</h2>

- 前端为原生 ES Module，无构建步骤；模块按职责划分，管理端能力按角色物理分离（动机见「设计背景与刻意取舍」）。
- **非 ESM 例外共有 4 个：`pay-poll.js`、`theme.js`、`share-list.js`、`share-order.js`**（`tests/frontend.test.js` 逐个断言它们是普通脚本）。它们都服务于服务端渲染的分享页 / 首屏，需要从 `<script data-…>` 属性或 `document.currentScript` 取参数，而 `document.currentScript` 在 `type="module"` 脚本里恒为 `null`，因此写成普通脚本。`pay-poll.js` 曾经是页面里的内联 `<script>`——CSP 移除 `script-src 'unsafe-inline'` 后那段脚本被浏览器静默拒绝执行，「支付成功后自动放行」的承诺随之失效；抽成同源静态文件即落回 `script-src 'self'` 之内。**分享页与主站共用同一套 CSP**，因此分享页模板里同样不允许出现内联脚本或内联事件处理器。
- **请求序号**：文件区所有异步加载共用一个计数器，发起前自增，响应到达时若自身已不是最新一次则丢弃结果。在途时直接返回会把用户的后续操作静默丢弃，比不互斥更糟。自增必须落在「确认会发起请求」之后——早退分支同样自增会把在途请求判为过期而无人收尾，加载态将永久卡住。
- 序号只解决「旧结果不该覆盖新结果」，解决不了「服务端那一轮仍在空转扫描」，因此另配 `AbortController`：发起新一轮前取消上一轮，服务端检测到连接断开即停止翻页。主动取消必须原样抛出，不可被改写成「无法连接本地服务」这类误导性提示。
- 渲染必须幂等。登出与登录成功两个时点都要重置主视图并清空各模块的渲染缓存，否则下一个账号会看到上一个账号停留的区块。
- 富文本渲染默认按纯文本转义：弹窗与 Toast 默认纯文本，需要富文本必须显式声明并自行转义插值，使「未转义即渲染」从沉默的默认行为变为显眼的、可被评审发现的声明。
- 定时器句柄一律保存，并在登出或目标元素不存在时停止，否则会出现登出后仍持续轮询接口的无效请求。

---

<h1 id="develop_document-section68">四、测试</h1>


<h2 id="develop_document-section69">1. 测试与 CI</h2>

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

> 共 **107 个测试文件、1743 条用例**（计数口径：第 37 轮新增 `audit37-regressions.test.js` **26 条**、第 38 轮新增 `audit38-regressions.test.js` **31 条**；第 39 轮**没有**新的护栏文件，5 条版本对齐护栏落在既有的 `deploy-script.test.js` 内；第 40 轮新增 `audit40-regressions.test.js` **7 条**，另有 3 条「不能编辑自己」护栏并入既有的 `audit35-regressions.test.js`；第 41 轮新增 `audit41-regressions.test.js` **14 条**，前端侧另有 3 条「两套配置各自独立」护栏并入既有的 `audit31-regressions.test.js`；第 42 轮新增 `audit42-regressions.test.js` **9 条**；第 43 轮新增 `audit43-regressions.test.js` **8 条**；第 44 轮新增 `audit44-regressions.test.js` **14 条**；第 45 轮新增 `audit45-regressions.test.js` **12 条**；第 46 轮是小型修复、**未新增**护栏文件（1 条护栏并入既有的 `audit42-regressions.test.js`）；第 47 轮新增 `audit47-regressions.test.js` **20 条**；第 48 轮新增 `audit48-regressions.test.js` **22 条**；第 49 轮新增 `audit49-regressions.test.js` **9 条**（移除自签名证书 + 移除 COS 原生 API，配套 10 条反向对照）；第 50 轮新增 `audit50-regressions.test.js` **17 条**（分享页文件类型图标 / 左键框选多选 / 「链接创建成功」弹窗改版，配套 18 条反向对照）；第 51 轮新增 `audit51-regressions.test.js` **34 条**（「链接创建成功」弹窗加宽、链接一行显示完；多文件 / 文件夹分享的列表 + 勾选 + 50/页分页 + 打包 `.tar.gz`，配套 40 条反向对照）；第 52 轮新增 `audit52-regressions.test.js` **19 条**（多选（文件+文件夹）分享入口 /「移动」报成功实际没动 / 复制粘贴与冲突逐项询问 / 分享页默认全选与展示路径脱敏 / 链接结果弹窗左右等高，配套 22 条反向对照）；第 53 轮新增 `audit53-regressions.test.js` **32 条**（「发信设置」卡片与零依赖 SMTP 客户端，配套 17 条反向对照）；第 54 轮新增 `audit54-regressions.test.js` **22 条**（第①步「站点设置」卡片：站点名称 / 公开注册 / 新用户身份，配套 13 条反向对照）与 `audit54b-regressions.test.js` **30 条**（第②步：登录页注册 / 记住密码 / 忘记密码 + 邮箱验证码体系，配套 22 条反向对照）、`audit54c-regressions.test.js` **24 条**（第③步：邀请码系统 —— `side-foot`「邀请码设置」+ 批量生成 / 删除 / 导出 txt + 单独与批量设置使用次数 / 过期时间 / 身份，并把注册的 `invite` 模式改成真核销，配套 33 条反向对照）、第 68 轮新增 `agreement-settings.test.js` **25 条**、第 69 轮新增 `audit69-regressions.test.js` **26 条**（《安全漏洞分析报告》的 2 高 / 5 中 / 12 低逐条修复，配套 17 条反向对照）（三页协议提示 + 两份协议正文：渲染口径 / XSS / 权限 / 预览不落盘 / 备份往返 / 分享页零脚本 `:target` 弹窗）、第 77 轮新增 `audit77-regressions.test.js` **4 条**（外部加密审计 F-E1：缺 IV/TAG 的历史元数据 fail-closed，配套 3 条反向对照）；第 79 轮新增 `audit79-regressions.test.js` **7 条**（L1/L2 支付密钥真实解析 + 等待页「点了没反应」，配套 7 条反向对照）；第 80 轮新增 `audit80-regressions.test.js` **11 条**（「点击立即支付没有任何反应」的六条成因：静默 303 / 表单收到裸 JSON / SM2 静默降级 / 网关地址片段 / 无收银台静默降级 / 提交无反馈，配套 10 条反向对照）；第 81 轮新增 `audit81-regressions.test.js` **9 条**（出站超时只管到响应头 ⇒ 读响应体可挂到 undici 的 300 秒兜底；提交看门狗把「没跳去支付平台」误报成「订单没建成」，配套 8 条反向对照）；第 82 轮新增 `audit82-regressions.test.js` **9 条**（三条用户要求的行为变更：换渠道即新单 + 退券 / SM2 保存时即拒绝 / 历史在途订单一次性标失败，配套 8 条反向对照 + R21-06 重述）；第 83 轮新增 `audit83-regressions.test.js` **7 条**（表单 POST 之后不许再跨域 3xx —— Chrome/Safari 会把 CSP 的 `form-action` 施加到「表单提交后的重定向目标」上，跨域 302 被整条拦掉，页面一动不动而订单已建好；改用同源「正在跳转」中转页由页面自身发起导航，配 meta refresh + 可点链接双通道，收银台地址另加 http(s) 协议白名单，配套 6 条反向对照）；第 84 轮新增 `audit84-regressions.test.js` **13 条**（《支付模块检查报告》七条逐条复核、**全部成立**：支付宝查单响应验签（按 JSON 原文切片验，重新序列化即失效）/ 轮询推进放宽到任何 pending 订单 / 账本读不出来时 fail-closed（拒收 + 管理端横幅 + 接口 `degraded`）/ `fenFromYuan('')` 不得是 0 / 换券即新单（含「旧券必须退回」）/ 5 秒内同参数重复提交合并 / PayPal 回调事件类型白名单，配套 13 条反向对照，另重锚 4 条 R82 对照）；第 85 轮新增 `audit85-regressions.test.js` **5 条**（「支付宝页面上显示的订单号与实际订单号不符」—— 结论是**订单系统没有残留旧号**：`out_trade_no` 一直是内部 16 位 `id`，36 位 `orderNo` 从未也**不能**发给网关（微信 v3 上限 32 位），真正的缺陷是**短号在界面上完全不可见**；故本轮只补可见性、不动支付链路：中转页 / 等待页 / 二维码页 / 状态页四处并列出「订单号」与「商户单号」+ 订单管理页新增「商户单号」列（可复制），配套 4 条反向对照）；第 86 轮新增 `audit86-regressions.test.js` **13 条**（订单号取回新增「账号归属」限制：**登录态成交**的订单只能由购买时的同一个账号取回，**游客成交**的订单任何情况下都能取回；闸门排在取回额度之前、失败不消耗额度、拒绝时不回传订单快照，路由给「去登录 / 切换账号」按钮且这两类不计入连续输错，配套 7 条反向对照）；第 88 轮新增 `coupon-threshold.test.js` **6 条**（优惠券「满 xx 减 xx」门槛，配套 6 条反向对照）；第 89 轮新增 `audit89-regressions.test.js` **10 条**（存储空间隔离：桶内 `u/<userId>/` 前缀命名空间 + 两个收口点 + `/fs` 全部端点收支方向 + 分享快照绝对 key + WebDAV 账户绑定用户 + 删用户连带吊销账户，配套 14 条反向对照）；第 90~94 轮新增的护栏见 `CHANGELOG.md` 对应小节（第 94 轮为 62 条）；第 95 轮新增 `audit95-regressions.test.js` **4 条**，另在 `qrcode.test.js` 补 **1 条**独立解码器（《支付系统检查报告》2 条结论全部成立：二维码格式信息位置、改价后复用在途订单）；第 96 轮新增 `audit96-regressions.test.js` **6 条**（《支付系统支付链路复检》新增的那条同源分叉：券路径下「页面价 = 实扣价」，含停用 / 过期 / 改价 / 扫码页四种形态与一组对照）；第 97 轮新增 `keyring.test.js` **13 条**、`keyrotate.test.js` **10 条**、`audit97-regressions.test.js` **9 条**（主密钥信封与登录密钥轮转：包裹/解开契约、"锁定 ≠ 损坏"的**三条**独立路径（取密钥 / 读配置 / 读加密数据文件）、迁移只重裹不重加密、轮转的两边一致性（KEK 与登录口令）与会话失效、解锁通道的权限档与失败锁）；第 98 轮新增 `audit98-regressions.test.js` **12 条**（昵称与自助注销的 HTTP 面：昵称免密码 / 超长拒绝 / 清空语义、根用户与无邮箱的拒绝档、验证码用途隔离、15 天冷静期、重复提交 409、登录即撤销、到期当场删除、清扫解除链接归属）与 `account-deletion.test.js` **4 条**（存储层契约：坏 `deletion` 一律归零、未到期不进待删列表、昵称按码点截断、冷静期常量单一事实源）；第 99 轮新增 `audit99-regressions.test.js` **12 条**（完整性巡检 / 防勒索校验：**判据层**密文长度公式与三个结论、**行为层**用「桩被调用几次」证明锁定态一步都不往下走 / 403 与 5xx 不算丢失 / 合流 / 轮转游标、**接线层**卡片与两条路由的守卫，配套 14 条反向对照 `R99-01a`~`R99-12a`）；第 100 轮新增 `captcha-native.test.js` **12 条**（模块契约）与 `audit100-regressions.test.js` **10 条**（真 HTTP 接线 + 开关三态，配套 8 条反向对照 `R100-01a`~`R100-06b`）；第 101 轮新增 `audit101-regressions.test.js` **10 条**（《密钥轮转与完整性巡检审计报告》9 条全部成立：改密闸门三态与三个入口、写盘失败必须回滚、意图日志补完与三种「不猜」、并发 409、损坏备份去重、复制 / 上传落库 / 移动三处刷新 `cloudWrittenAt`、magic 短文件四档、同名桶零 HEAD，配套 11 条反向对照 `R101-01a`~`R101-09a`）；第 102 轮**未新增**护栏文件（3 条「部署脚本排除 client/」护栏并入既有的 `deploy-script.test.js` —— 静态 1 条 + **真跑** `drop_client_from_clone` / **真跑** `install_app` 各 1 条，配套 3 条反向对照 `R102-01a`~`R102-03a`）；第 103 轮新增 `audit103-regressions.test.js` **8 条**（巡检异常通知 + 随机 4 位口令：通知只对真异常发信、签名 + 冷却去重、**发信失败不推进签名**、路由三条校验、生成器字符集与前后端同下界，配套 8 条反向对照 `R103-01a`~`R103-08a`）；第 104 轮新增 `audit104-regressions.test.js` **8 条**（《Kepler v2.1.3 安全审计报告》6 条全部成立：锁定态读盘不得把空表钉进缓存、支付宝同步响应「验签对象 = 业务对象」、人机验证允许域名不得采信请求 `Host`、设置文件读不出来时任意口令不得换访问令牌、导入必须比对写盘结果、轮转进行中不得删意图日志、启动清扫必须等解锁**成功**，配套 15 条反向对照 `R104-01a`~`R104-07b`）；**确切条数与通过情况请以 `npm test` 结尾的汇总行为准**）。环境性红/跳过一并说明，避免被误读成回归：`RE-03` / `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY）；`audit16-regressions` 有 4 条要靠 `bash` 驱动 `deploy.sh` 的 Nginx 模板断言，无 `bash` 的机器上会以「bash 不可用（ENOENT）」失败；`SCAN-SKIPLIST.md` 不在工作区时另有一条清单一致性用例按设计跳过。全部零依赖，可直接 `npm test` 运行。修改路由、前端模块或 WebAuthn 相关代码后请先运行。文件数由 `docs-sync` 护栏校验；**用例总数没有护栏**——静态统计（`grep -rhE '^\s*test\(' tests/*.test.js | wc -l`）与 runner 实际计数口径不同（后者含 `t.test()` 子测试），无法用静态方式锁定，故此处给的是**本版发布时的实测值**（以 CI 与本地全量运行结尾的汇总行为准），它随每次改动而变，请勿当作长期基线。
>
> **本节是全文唯一的用例计数口径**：其他章节提到用例条数时一律写「见「四、测试 → 1. 测试与 CI」」而**不得另写数字**——曾经「测试与 CI」写 480+、「服务端调试」写 300+，两处都是手抄数字，没有护栏，于是静静地漂移了若干个版本。散落的数字必然失同步，收敛成一个入口才不会。

**CI 已落地**（`.github/workflows/ci.yml`，R66）：矩阵为 `ubuntu-latest` / `windows-latest` × Node `24`，步骤依次为 `npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run lint` → 逐文件 `node --test`。`tests/repo-hygiene.test.js` 断言该工作流必须存在、内容与上述一致且真的会执行。提交前仍建议在本机执行 `npm test` 与 `npm run lint`。

> **R23-05（历史事件，已于 R66 闭合）：** 本节旧版曾声称 CI 在 Linux / Windows 上运行测试并构建 Docker 镜像，而当时仓库里并没有 `.github` 目录 —— 那是「文档提到的仓库文件是否存在」尚未被校验的年代，这类声明可以长期漂移而不报红。R66 落地了 `.github/workflows/ci.yml` 与 `tests/repo-hygiene.test.js`（断言该文件存在且真的会执行），`tests/docs-sync.test.js` 也补上了「目录结构代码块里列出的仓库文件必须真实存在」的断言（`data/` 运行期子树与显式豁免项除外）。此后在树里登记一个不存在的文件会立刻变红。

<h2 id="develop_document-section70">2. 测试护栏编写约定</h2>

- **护栏优先写成行为断言**：早期有两条只检查「源码里能否 grep 到某个词」，退回旧实现后照样全部通过（形同虚设），已改写为行为断言。**确需读源码时（如「全库仅一处调用 `markPaid`」这类结构性承诺），断言的扫描范围必须与承诺范围一致**——只扫一个文件的话，在别的文件里调用一次就能同时骗过文档与护栏；这类断言应遍历全部源码文件，并在失败信息里列出命中位置。


- **写回归断言要枚举「同一状态的所有读取入口」，而不是只测改动的那一处**：某次回归断言只覆盖了「全局不变 / 会话记住 / `listBucketsFor`」即告通过，遗漏 `get()`，导致界面显示新桶、实际操作仍打全局桶。现行护栏一次性校验 `listBucketsFor` / `safeView` / `get` / `effective` 四者**必须同源**。
- **禁止墙钟阈值断言**（`assert(ms < 20)` 之类）：负载下一红一绿，而「偶发红」会让所有人学会忽略红灯，等于毁掉「全绿」这个信号本身。改用**与耗时无关的确定性探针**：
  - 判断「文件是否被整体替换」→ 比较追加前后的 `fs.stat().ino`（win32 亦可用；tmp+rename 必变）；
  - 判断时间窗口/锁定/去抖语义 → **虚拟时钟**（临时替换 `Date.now`，基准取真实当前时间再小幅推进，避免跨天影响按日期分桶的模块），比真实 `sleep` 更快且完全确定；
  - 判断「退出阶段能否落盘」→ 起**真实子进程**（`spawnSync` + `S3_DATA_DIR` 指向临时目录），父进程读回文件比对。
- **静态分析器（读源码的护栏）必须自带样例自测**，且判定窗口要由**结构**决定，不能用魔数长度：有分析器曾用 400 字符的固定窗口，而目标函数的守卫前导约 480 字符 → 退回旧实现后照样全绿。同理，抽取方法体要**配平花括号**（先跳过参数括号），不能截到下一个 `},`——search 内部有 try/catch/finally 嵌套，按缩进截会让断言范围缩水；样例自身也要花括号配平，否则解析提前收尾、自测先假红。
- **测「连接断开后停止工作」这类时序行为，用挂起的假依赖而不是 sleep**：让假 `getBucket` 把回调存起来，测试端先 `destroy()`、再手动放行首页，之后是否发起第 2 次调用就完全由被测代码的判断决定，与机器快慢无关（放行后仍需一个宽限期让事件循环推进，但那是等待而非断言）。
- 所有审计回归护栏均经**反向对照**验证检出能力：退回旧实现必须 FAIL。变异脚本要**先断言锚点命中**（静默变异失败会伪装成「护栏没抓住」），并做到崩溃安全（登记 + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 强制还原源码备份；**不含** `data/` 快照）。

<h1 id="develop_document-section71">五、开始二次开发</h1>

本章面向**第一次接触本仓库的开发者**：读完 `1. 高层架构总览` 就知道代码分几层，照着 `2. 本地启动与调试` 能在几分钟内把服务跑起来并看到界面，`3` / `4` 是两个可照抄的最小改动示例，`5` 是提交前必须过一遍的自检清单。

> 本章只讲「路怎么走」，不重复前四章的结论。凡本章与前文冲突，**以前文为准**并请顺手修正本章。

<h2 id="develop_document-section72">1. 高层架构总览</h2>

<h3 id="develop_document-section73">1.1 分层视图与请求链路</h3>

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
│        /pay/notify/:platform 支付异步通知 · /dav WebDAV 服务（独立 8443 端口）
│  端口：PORT=3000（HTTP）· HTTPS_PORT=3443（内置 HTTPS，仅当自备证书就绪时监听）
│  中间件链（顺序有语义）：请求日志 → IP 守卫（全局最前）→ CSRF 校验
│                        → 会话解析 → 限流 / 失败锁定（路由内）→ 路由分发
▼
[ 路由层 ]  server/routes.js（只负责挂载）→ server/routes/*.js（25 个模块文件：23 个领域子模块 + `_context.js` / `_shared.js`）
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
│  data/config.enc（含密钥、桶、用户）· data/secret.key · data/keyring.json · data/enc.key
│  data/keyring.rotate-intent.json（轮转意图日志，只在两次写盘之间短暂存在；成功即删）
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
2. `index.js` 先过全局 IP 守卫（`app.use(ipGuard.middleware)`，最前）→ `/api` 的 CSRF 校验 → 再解析 `s3mgr_session`，并**用实时用户记录**（不是登录时的快照）判定角色；限流在路由内执行；
3. `routes.js` 命中 `routes/fs.js` 注册的 `GET /fs/list`；
4. 路由先用 `requireConfig()` 确认已配置密钥与桶，再由 `s3.js` 的 `getClient()` 取得客户端；
5. `listCache` 命中就直接返回（同目录重复刷新不访云端）；未命中才调云端 `getBucket`，并用 `encStore.encryptedSetFor()` 标出哪些对象是密文；
6. 组装 `{ prefix, contents, prefixes, isTruncated, nextMarker }` 返回，前端按 `isTruncated` 决定是否显示「加载更多」。

<h3 id="develop_document-section74">1.2 状态存放与启动顺序</h3>

**状态全在 `data/`**，没有数据库。因此「备份」= 复制 `data/` 目录；「迁移」= 复制目录 + 保证目标机器上有同样的 `data/*.key`。写测试时优先用 `S3_DATA_DIR` 指向临时目录做隔离（多数存储模块支持；`config-store` 不支持，涉及它的用例要另想办法）。

启动顺序（`server/index.js` 末尾自上而下，顺序本身有含义）：

1. 注册 `SIGINT` / `SIGTERM`（Windows 还有 `SIGBREAK`）→ 优雅停机，`flush` 后关端口；
2. **单实例锁**：两个进程同时操作同一份 `data/` 会交替整体覆盖加密配置，因此检测到活跃实例直接拒绝启动（崩溃残留的脏锁会被自动接管，真卡住时删 `data/.instance.lock`）；
3. **主密钥自动解锁**（`keyring.autoUnlockFromEnv()`）：用 `KEPLER_MASTER_PASSPHRASE` 尝试解锁；口令错 / 未设置时**不退出**，以锁定态继续启动（前端解锁页接管），避免容器形成「起不来 → 看不到日志 → 改不对变量」的循环；
4. 清扫 atomic-write 留下的孤儿 `*.tmp`（条件：pid 已死 + mtime 超 10 分钟）；
5. 注册三组后台定时器（均 `unref()`）：上传会话清扫、注销到期清扫（R98，每小时）—— 这两组等自动解锁后再读加密配置；完整性巡检（R99，启动 60 秒后首轮 + 周期）的定时器**不等解锁**，由 `runOnce()` 把「锁定态」作为第一条判据直接返回；
6. **预生成安装令牌**（`primeSetupToken()`，`listen` 之前）：部署脚本随后立刻读它，先有文件才不会打印空令牌；
7. **清理历史「支付中」订单**（`sweepStalePending()`，`listen` 之前，只跑一次）：先把脏状态清干净再对外服务；
8. 起 HTTP（`PORT`，默认 3000）；**再按自备证书（`TLS_CERT_FILE` / `TLS_KEY_FILE`）决定是否起 HTTPS**（`HTTPS_PORT`，默认 3443）—— 没有证书就只提供 HTTP，并向日志打印缺哪个文件（R49 起不再生成自签名证书；WebDAV 同样因此不会启动）；
9. 把历史遗留的明文数据文件升级为加密存储；
10. 配置损坏（`isCorrupted()`）时打印警告——**不静默回落**；
11. 按已保存配置启动 WebDAV；
12. 注册 `uncaughtException`：记录后优雅退出（认为进程已进入未定义状态，继续服务会把故障放大到用户数据上）。调试时可用 `NO_RESTART_ON_UNCAUGHT=1` 关闭该行为。

<h2 id="develop_document-section75">2. 本地启动与调试</h2>

<h3 id="develop_document-section76">2.1 启动方式与端口</h3>

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

<h3 id="develop_document-section77">2.2 服务端调试</h3>

- **断点**：`node --inspect-brk server/index.js`，再用 Chrome 打开 `chrome://inspect`（或 VS Code 的 attach 配置）。前端代码直接在浏览器 DevTools 里断点即可。
- **看日志**：操作审计落在 `data/logs.jsonl`（滚动保留，不追求长期明细），管理员可 `GET /api/stats/logs` 拉取；启动期与异常直接打在控制台。
- **看状态**：改完配置想确认是否落盘成功，直接看 `data/config.enc`（加密）与 `GET /api/config` 的 `selfTest`（自研加密自检，失败说明密钥材料有问题）。
- **接口试探**：按 `7. HTTP API` 里的 curl 样例来。写操作记得带 `-H 'X-Requested-With: XMLHttpRequest'`，否则 403——这是最常见的「登录了却被拒」的原因。
- **测改动**：`npm test` 跑全量；用例条数的量级见「四、测试 → 1. 测试与 CI」（此处**故意不写数字**，避免第二处计数再次漂移）。只想跑其中一个文件用 `node --test tests/<file>.test.js`。**`npm test` 的 glob 必须带引号**，否则某些 shell 会先展开路径。
- **本机跑不起来的两条**：`RE-03` 与 `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY），属**环境性失败而非回归**；判定方法是看这两条之外的用例是否全绿。

<h3 id="develop_document-section78">2.3 前端调试</h3>

前端是原生 ESM、无构建步骤：**改完 `public/js/*.js` 刷新页面即可**（浏览器对 ESM 有缓存，必要时硬刷新）。

- 主视图是一个个 `<section id="...">`，由 `main.js` 的 `MAIN_VIEWS` + `switchMainView()` 统一显隐。**新增视图必须登记进 `MAIN_VIEWS`**，否则登出 / 登录切换时不会被 `resetMainView()` 复位，会残留上一个会话的 DOM。
- 仅管理员可见的内容要**整块隐藏并且不发请求**（见 `syssettings.js` 的 `ADMIN_ONLY_CARDS`），不要只靠服务端 403 兜底。
- 异步列表渲染一律走「请求序号」机制，避免旧响应覆盖新结果；渲染函数要幂等（同一份数据渲染两次结果一致）。
- 冒烟可用无头 Chrome：`chrome --headless=new --dump-dom http://127.0.0.1:3000`（Windows 下用绝对路径调用 `chrome.exe`）。

<h2 id="develop_document-section79">3. 最小示例 A：新增一个只读接口</h2>

**需求**：加一个 `GET /api/demo/ping`，返回当前登录用户名与服务器时间，仅管理员可访问。这个例子覆盖了新增后端能力要动的**全部三个地方**：路由文件、`routes.js` 挂载、路由表面积护栏。

<h3 id="develop_document-section80">3.1 第一步：写路由</h3>

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

<h3 id="develop_document-section81">3.2 第二步：挂载与依赖注入</h3>

在 `server/routes.js` 里加一行。**挂载顺序有语义**（`auth` 必须最先；`/credentials/visibility` 必须早于 `/credentials/:id`，否则会被参数路由吞掉），新模块一般追加在末尾即可：

```js
router.use(require('./routes/stats'));
router.use(require('./routes/demo'));   // 新增
```

需要用到其它 server 模块时，**先加到 `server/routes/_context.js`** 再从 `_context` 解构，不要在自己的文件里直接 `require('../config-store')`——否则测试无法对单一模块做依赖替换。

<h3 id="develop_document-section82">3.3 第三步：补护栏并验证</h3>

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

最后把新接口补进 `7. HTTP API` 的表格（否则文档与代码分叉 —— `tests/routes-surface.test.js` 会断言每条路由的完整路径能在开发文档中搜到，漏写即变红）。

<h2 id="develop_document-section83">4. 最小示例 B：新增一个前端卡片</h2>

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
   const VIEW_ENTRY = { /* … */, democard: 'side-demo' };            // ② 必须登记：viewFromHash() 用它读入口按钮的 hidden 做角色门控
   else if (v === 'democard') democard.refresh();                    // ③ switchMainView 分支
   $('side-demo').onclick = () => { switchMainView('democard'); closeSidebar(); };
   ```
   若这块内容仅管理员可见：把它加进 `syssettings.js` 的 `ADMIN_ONLY_CARDS` 一类机制——**整卡隐藏 + `refresh()` 在隐藏时提前 return**，避免「看得见拒绝操作」。若该模块会跨会话缓存敏感数据，还要在 `resetMainView()` 里补上它的 `reset()`。

前端改动执行 `npm test` 也会覆盖一部分：`tests/frontend.test.js` 会校验所有前端模块的 ESM 语法、`import` 路径是否存在、主视图列表与 DOM 是否一致。改动后应将 `1. 目录结构` 里的模块清单补上（`docs-sync` 会进行检查）。

<h2 id="develop_document-section84">5. 二次开发检查清单</h2>

- [1] **落盘使用 `atomic-write`**？直接 `writeFile` 会先截断，进程中断就留下 0 字节文件。
- [2] **权限判定用的是实时用户记录**（`findUserRawById()`）而不是会话快照？降权 / 删户 / 改密后是否主动销毁了对方会话？
- [3] **服务端点经过 `endpoint-guard`**？任何来自用户输入的 URL 都可能是一次盲 SSRF。
- [4] **新增路由登记进 `tests/routes-surface.test.js`**，敏感接口进 `mustBeAdmin`；**匿名可达**的还要登记 `server/index.js` 的 `PUBLIC_API`（否则会被会话闸门直接拦掉）。
- [5] **新增文件 / 环境变量 / 模块补进 `1. 目录结构` 与 `2. 环境变量`**——`tests/docs-sync.test.js` 会校验文件清单与环境变量表，漏了直接红。新增前端主视图还要登记 `main.js` 的 `VIEW_ENTRY`（含入口按钮 `id`，否则地址栏直达与角色门控失效）；跨会话缓存敏感数据的模块另在 `resetMainView()` 补 `reset()`。
- [6] **文档同步**：`7. HTTP API` 表格、以及涉及的章节；若插 / 删了一节，记得目录锚点会整体位移（改完用 `docs-sync` 里的目录护栏确认目录与标题仍然一一对应）。
- [7] **护栏是行为断言而不是源码 grep**：写完把实现退回旧版，确认测试真的会 FAIL；并登记 `tests/invariants.test.js` 的 `CANONICAL_IMPLS` 与 `scripts/reverse-check.js` 的 `CASES`（否则反向对照不会被 CI 跑到）。
- [8] **改动触及某个审计编号时**（代码里的 `SEC-*` / `FUN-*` / `PERF-*` / `LOW-*` / `S*` / `P*` 注释），先查同目录的 `Audit_Ledger.md`：它登记每个编号的含义与闭合依据，并由 `docs-sync` 护栏保证不遗漏。**注意编号不是全局唯一的**：已确证 11 个编号存在同号异义，且 `S4` 与 `SEC-04`、`P3` 与 `PERF-03` 是两套独立系列——因此**新引用必须带轮次或日期限定**（如 `audit6/PERF-01`、`SEC-04（2026-09-14）`）；需要无歧义指代时请用 `6.5` 的限定别名（如 `FUN-12@unbounded-map`）。
- [9] **同一事实只在一处展开细节**：凡文档标注「唯一权威定义」的内容（如「下载放行判定顺序」在 `4.3 下载配额与来源判定`），**其余引用处只写「结论 + 指向」，不复述步骤、顺序或阈值**。复述一次就多一处同步负担，而这类内容恰恰是最容易只改一半的（改了顺序却漏改复述处，读者按旧顺序实现就是错的）。当前两处「唯一权威定义」已按此纪律收口；新增同类内容时请沿用。

> 完整测试跑法与护栏编写约定见 `四、测试`。
