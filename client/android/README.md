# Kepler 存储管理 · Android 客户端

基于 [Kepler](https://github.com/xingsen2005/Kepler)（多云对象存储管理系统）服务端开发的 Android 客户端：登录 Kepler 服务器后，即可在手机 / 平板上浏览、上传、下载、删除对象存储中的文件，并管理存储桶、访问密钥与 WebDAV 配置。

> 服务端为 Node.js 应用（本地管理界面 + 多云密钥保管），本仓库是与之配套的 Android App（Kotlin + Jetpack Compose）。

---

Tips：本项目基于 API 34 开发，遵循 Android 14 开发规范，最终编译的执行文件需要 Android 14 及以上的系统才可以安装。

## 一、功能特性

| 模块 | 能力 |
| --- | --- |
| **登录** | 输入服务器地址（域名）、用户名、密码登录；连接信息持久化、下次自动带出；支持「记住密码」（加密存储）与自动登录（会话恢复）；连接测试（读取站点名称） |
| **Windows Hello 拦截** | 登录时若检测到账户已开启 Windows Hello（WebAuthn 二次验证），**直接拒绝登录**并弹窗明确提示（本 App 不支持该验证方式） |
| **文件管理** | 目录浏览（面包屑 / 进入 / 返回上一级）、新建文件夹、重命名、多选批量删除、上传（系统文档选择器）、下载（前台服务 + MediaStore）、按名称 / 大小 / 时间排序、当前存储桶切换 |
| **上传** | 服务端决策两条路径：小文件直传（simple）/ 大文件分片（multipart，自动断点续传）；上传队列实时进度 |
| **下载** | 前台服务保活，进度通知可取消；直接写入系统「下载/Kepler」目录（**无需任何存储权限**） |
| **存储桶配置** | 查看可见桶、切换当前桶；管理员可新增 / 编辑（备注、配额、地域）/ 删除 |
| **密钥配置** | 查看访问密钥（SecretKey 服务端永不下发，仅掩码 SecretId）；管理员可新增 / 编辑 / 删除 |
| **WebDAV 配置** | 服务开关、挂载地址与运行状态、账户增删改、明文密码查看（均为管理员操作，服务端强制） |
| **系统设置** | 站点设置（名称 / 注册模式 / 新用户默认身份）、上传并发数、上传排除规则；**仅管理员可见**（普通用户导航项直接隐藏） |
| **账户** | 顶栏账户菜单展示用户名 / 角色，随时退出登录 |

## 二、界面与适配

- **自适应导航**：窄屏（手机）显示**底部导航栏**；宽屏 ≥ 600dp（平板 / 折叠屏展开 / 大屏）显示**左侧导航栏**，同一套代码自动切换。
- **全面屏（edge-to-edge）**：内容延伸至状态栏 / 导航栏区域，系统栏图标自动反色，深浅色主题 + Android 12 动态取色。

## 三、权限说明（最小权限原则）

| 权限 | 用途 | 说明 |
| --- | --- | --- |
| `INTERNET` | 访问 Kepler 服务器 | 唯一必需的基础权限 |
| `POST_NOTIFICATIONS` | 下载进度 / 完成通知 | API 33+ 运行时权限，**仅在用户下载时按需申请** |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | 下载保活 | 大文件下载期间以前台服务运行 |

**刻意不申请**：`READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` / `READ_MEDIA_*` / `MANAGE_EXTERNAL_STORAGE`。
上传通过系统文档选择器（SAF）读取文件，下载通过 MediaStore 写入公共下载目录，均无需存储权限。

## 四、构建

环境要求：JDK 17+（推荐 Android Studio 自带 JBR）、Android SDK（compileSdk 37）。

```bash
# 调试包
./gradlew assembleDebug

# 发布包
./gradlew assembleRelease
```

也可直接用 Android Studio 打开本目录运行。

> 说明：`settings.gradle.kts` 已内置阿里云国内镜像并将仓库模式设为 `PREFER_SETTINGS`，以便与本机 `~/.gradle/init.gradle`（阿里云镜像注入）共存；`gradle/wrapper` 使用 Gradle 9.6.0。

## 五、使用

1. 按 Kepler README 部署服务端（`deploy.sh` 一键部署，HTTPS + ACME 证书；内网 / 测试可用 `--tls none` 走 HTTP）。
2. App 登录页填写服务器地址（如 `https://kepler.example.com`，也可直接填域名自动补全 `https://`）、用户名、密码。
3. 登录后即可在「文件」页浏览与传输文件；「存储桶」「密钥」「WebDAV」「系统设置」按权限展示。

**关于 Windows Hello**：若账户在网页端开启了 Windows Hello 二次验证，App 登录会被拒绝并提示——请先在网页端「个人资料」关闭该功能，或改用其他账户。这是需求规定的行为（App 侧无法完成平台绑定的 WebAuthn 验签）。

**关于 HTTPS 证书**：生产部署使用 ACME 真实证书，App 按系统证书链校验；内网 HTTP 部署可用，但 App 会提示明文传输风险。

## 六、目录结构

```
app/src/main/java/com/kepler/bucketmg/apk/
├── KeplerApp.kt                 # Application：依赖初始化、通知渠道
├── MainActivity.kt              # 单 Activity + edge-to-edge + 根状态机（加载/登录/主界面）
├── data/
│   ├── SessionManager.kt        # 全局会话（当前用户、服务器地址、过期广播）
│   ├── net/
│   │   ├── ApiClient.kt         # OkHttp 客户端、CSRF 头、持久化 CookieJar、401 拦截
│   │   ├── ApiException.kt      # 结构化错误（封禁 / Windows Hello / 配额码…）
│   │   └── KeplerApi.kt         # 全部 REST 端点
│   ├── model/Models.kt          # DTO（org.json 解析）与服务商注册表
│   ├── prefs/                   # DataStore（明文设置）+ EncryptedSharedPreferences（密码/Cookie）
│   └── repo/
│       ├── AuthRepository.kt    # 登录 / 登出 / 会话恢复
│       └── FileUploader.kt      # simple / multipart 流式上传
├── service/DownloadService.kt   # 下载前台服务（MediaStore + 进度通知）
└── ui/
    ├── theme/                   # Material3 主题（动态取色）
    ├── login/                   # 登录页（Windows Hello 拒绝、封禁提示、连接测试）
    ├── main/                    # 自适应导航（BoxWithConstraints + NavigationRail/NavigationBar）+ 账户菜单
    ├── files/                   # 文件管理（浏览/上传/下载/删除/重命名）
    ├── buckets/ keys/ webdav/ settings/   # 配置管理（后三者管理员向）
    └── components/              # 通用组件（对话框、加载/错误/空态、信息行）
```

## 七、与服务端 API 的对照

| 功能 | 端点 |
| --- | --- |
| 登录 / 会话 | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout` |
| 站点探测 | `GET /api/site/info` |
| 文件 | `GET /api/fs/list`、`POST /api/fs/mkdir`、`POST /api/fs/rename`、`POST /api/fs/delete`、`GET /api/fs/download` |
| 上传 | `POST /api/fs/upload/init`、`PUT /api/fs/upload/simple`、`PUT /api/fs/upload/chunk`、`POST /api/fs/upload/complete` |
| 存储桶 | `GET /api/buckets/local`、`PUT /api/buckets/local/:id/active`（管理员：`POST/PUT/DELETE`） |
| 密钥 | `GET /api/credentials`（管理员：`POST/PUT/DELETE`） |
| WebDAV | `GET/PUT /api/webdav*`（仅管理员） |
| 系统设置 | `GET/PUT /api/site/config`、`GET /api/config`、`PUT /api/concurrency`、`GET/PUT /api/upload-excludes`（均仅管理员） |

所有非安全方法携带 `X-Requested-With: XMLHttpRequest` 头以满足服务端 CSRF 同源头校验；会话通过 `s3mgr_session` Cookie 维持（加密持久化，重启不断登录）。

## 八、联调验证记录

在本地部署 Kepler 服务端（`S3_DATA_DIR` 数据目录 + 端口 13999）完成以下实测：

- **登录链路**：`POST /api/auth/login` → `s3mgr_session` Cookie 建立 → `GET /api/auth/me` 返回 `UserInfo`（含 `role`/`isAdmin`），与客户端 DTO 一致。
- **Windows Hello 拒绝**：账户开启 WebAuthn 二次验证后登录，服务端返回 `{"ok":false,"webauthnRequired":true}`，客户端正确识别并弹窗拒绝（含引导用户去网页端关闭的说明）。
- **权限边界**：普通用户访问 `/api/webdav*`、`/api/site/config` 等服务端返回 403，客户端降级为「无权限」态展示。
- **文件浏览**：`GET /api/fs/list` 返回 `entries` 数组 + `prefix`，与 `FsEntry` DTO 字段（`name/size/mtime/isDir/etag`）匹配。
- **系统配置**：`GET /api/config` 中 `concurrency` 为对象 `{"files":3}`（非数字），已按对象 / 数字双形态兼容解析。
- **删除 / 上传**：`POST /api/fs/delete` 返回 `{ok, results:[{path, ok, error?}]}`；上传 init 返回 simple / multipart 两种模式，客户端两条路径均已实现。

## 九、已知限制

- 网页端的分享链接、付费下载、订单、IP 屏蔽、用户管理等功能未在 App 中实现（App 聚焦文件与配置管理）。
- 加密（透明加密）文件可下载，但 App 不支持加密访问密码解锁后的查看（服务端策略：密文下载需先解锁）。
- 文件预览（图片 / 视频）未实现，下载后通过系统应用打开。
- 验证码（reCAPTCHA / Turnstile）开启时无法登录（App 不集成人机验证）。

## 十、开源协议

本项目开源协议与 [Kepler](https://github.com/xingsen2005/Kepler) 一致。这里不直接写死开源协议是因为 [Kepler](https://github.com/xingsen2005/Kepler) 可能随时修改为其它商业宽松的开源协议。
