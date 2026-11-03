# Kepler · Android 客户端

[Kepler](https://github.com/xingsen2005/Kepler) 是一个多云对象存储管理系统（Node.js 服务端 + Web 管理界面）。
本仓库是与之配套的 **Android 客户端**，基于 Kotlin + Jetpack Compose 实现。

**本客户端的定位是「手机端文件浏览器」**：登录后浏览、上传、下载、复制、删除对象存储里的文件，
并在可见存储桶之间切换。管理类功能（密钥、WebDAV、系统设置、桶增删改、用户管理）**刻意不实现**——
那些是一次性配置工作，在网页端完成即可，搬到手机上只会放大误操作风险。

---

## 一、功能范围

| 模块 | 已实现 | 说明 |
| --- | --- | --- |
| **登录** | 域名（或完整 URL）+ 用户名 + 密码 | 省略协议时自动补 `https://`；支持「记住账号」与「记住密码」（后者仅在 HTTPS 下生效） |
| **人机验证** | 原生验证码 | 服务端要求作答时，登录页内联显示题目与输入框，无需跳转 WebView |
| **Windows Hello 拦截** | 拒绝登录并说明原因 | 账户在网页端开启了 WebAuthn 二次验证时，App 直接拒绝，因为平台绑定的验签无法在 App 侧完成 |
| **文件浏览** | 目录列表、面包屑、进入 / 返回上一级、下拉刷新 | 文件夹恒排在文件之前 |
| **排序** | 名称 / 大小 / 修改时间 | 名称忽略大小写；大小与时间为降序 |
| **多选与批处理** | 全选、单选切换、批量删除、批量复制 | 复制采用「复制 → 切换目录 → 粘贴」的剪贴板模型，粘贴失败不会丢失剪贴板 |
| **上传** | 系统文档选择器（SAF）多选 | 服务端决策 simple / multipart 分片两条路径；客户端最多 **3 个文件并发**，队列带实时进度 |
| **下载** | 前台服务保活 + 进度通知 + 可取消 | 直接写入系统「下载/Kepler」目录，**不需要任何存储权限** |
| **存储桶** | 查看可见桶、切换当前桶 | 仅切换，不做增删改 |
| **我的** | 资料展示（用户名 / 角色 / 邮箱 / 注册时间）、退出登录 | 若账户开启了 Windows Hello，此处显示只读警告卡片 |

**明确不做**：新建文件夹、重命名、密钥管理、WebDAV 配置、站点设置、上传排除规则、文件预览、
分享链接、订单与付费下载、用户管理。

## 二、界面与适配

- **自适应导航**：窄屏（手机）底部导航栏；宽屏 ≥ 600dp（平板 / 折叠屏展开）自动切换为左侧导航栏，同一套代码。
- **全面屏（edge-to-edge）**：内容延伸至系统栏区域，状态栏 / 导航栏图标自动反色。
- **返回手势**：`enableOnBackInvokedCallback` + Compose `BackHandler`，兼容 Android 的预测性返回手势——
  在子页面（非「文件」首页）触发返回时先回到首页，不会被系统直接退出应用。
- **主题**：跟随系统深浅色，Android 12+ 支持动态取色（Material You）。
- **图标**：标准三层自适应图标（背景 / 前景 / 单色），符号占画布 61.1%（= 66dp / 108dp），
  在圆形、圆角方形、方形等任意启动器遮罩下都不会被裁切；单色层供 Android 13+ 主题图标使用。

## 三、权限（最小权限原则）

| 权限 | 用途 |
| --- | --- |
| `INTERNET` | 访问 Kepler 服务器（唯一必需的基础权限） |
| `POST_NOTIFICATIONS` | 下载进度 / 完成通知（**仅在首次下载时按需申请**，拒绝也不影响下载） |
| `FOREGROUND_SERVICE` | 下载前台服务 |
| `FOREGROUND_SERVICE_DATA_SYNC` | 声明前台服务类型（Android 14 起强制） |

**刻意不申请**：`READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`、`READ_MEDIA_*`、`MANAGE_EXTERNAL_STORAGE`。
上传走系统文档选择器（SAF）读取，下载通过 MediaStore 写入公共下载目录，两者都不需要存储权限。

## 四、安全设计

**传输**
- 生产部署使用 ACME 真实证书，App 按系统证书链校验，**不信任用户安装的 CA**。
- 内网 / 测试环境允许 `http://`（Kepler 支持 `--tls none` 部署），但：
  检测到明文地址时界面明确提示风险，且**不会把密码持久化到本地**——每次登录都要重新输入。

**本地存储**
- 会话 Cookie 与「记住我」密码经 **Android Keystore 的 AES-256-GCM** 加密后落盘，
  密钥不可导出，硬件支持时由 TEE / StrongBox 保管；每次加密使用系统随机 IV，密文带认证标签。
- 未使用 `androidx.security:security-crypto`：该库已停止维护（`EncryptedSharedPreferences`
  全系列 deprecated），本项目只需要「密钥由 Keystore 保管」这一件事，用平台 API 直接实现，
  顺带省掉整个 Tink + protobuf 依赖。
- 密钥被系统吊销（如锁屏密码被移除）时解密失败，条目自动清除并回到「需要重新登录」，不会返回脏数据。

**凭据**
- 服务端永不下发 SecretKey，客户端也没有任何展示密钥的界面。

## 五、构建

**环境**

| 项 | 版本 |
| --- | --- |
| JDK | 17+（实测 JDK 25） |
| Gradle | 9.6.0（wrapper 自带） |
| Android Gradle Plugin | 9.4.0 |
| Kotlin | 2.3.21 |
| compileSdk | 37 |
| minSdk | 34（Android 14） |
| targetSdk | 36（Android 16） |

```bash
# 调试包（~110 MB，未优化）
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk

# 发布包（~9 MB，R8 压缩 + 资源收缩 + 正式签名）
./gradlew assembleRelease        # → app/build/outputs/apk/release/app-release.apk

# 单元测试
./gradlew testDebugUnitTest      # → app/build/reports/tests/testDebugUnitTest/index.html

# 静态检查
./gradlew lintDebug              # → app/build/reports/lint-results-debug.html
```

也可直接用 Android Studio 打开本目录运行。

**发布签名**
签名凭据从根目录的 `keystore.properties` 读取（该文件与 `keystore/` 均已在 `.gitignore` 中排除，不会进版本库）：

```properties
storeFile=keystore/release.jks
storePassword=******
keyAlias=kepler-release
keyPassword=******
```

文件缺失时构建**不会失败**，release 产物只是未签名——这样 CI / 新克隆的仓库仍可正常 `assembleDebug`。
自己打包时用 `keytool` 生成一个密钥库并填写上面的四项即可。

> 仓库内配置了阿里云镜像并把仓库模式设为 `PREFER_SETTINGS`，以兼容本机 `~/.gradle/init.gradle`
> 注入的镜像源；取不到镜像时自动回退官方源。

## 六、使用

1. 按 Kepler 的文档部署服务端（`deploy.sh` 一键部署，HTTPS + ACME 证书；内网可用 `--tls none`）。
2. 登录页填写服务器地址（如 `https://kepler.example.com`，也可只填域名）、用户名、密码。
3. 登录后进入「文件」页；顶栏可切换存储桶、切换排序方式、进入多选态。

**关于 Windows Hello**：若账户在网页端开启了该验证，App 登录会被拒绝。请先在网页端「个人资料」
关闭该功能，或改用其他账户——这是需求规定的行为，不是缺陷。

## 七、目录结构

```
app/src/main/java/com/kepler/bucketmg/apk/
├── KeplerApp.kt                  # Application：依赖装配、通知渠道
├── MainActivity.kt               # 单 Activity：edge-to-edge + 根状态机（恢复/登录/主界面）
├── data/
│   ├── SessionManager.kt         # 全局会话（当前用户、服务器地址、会话过期广播）
│   ├── net/
│   │   ├── ApiClient.kt          # OkHttp：CSRF 头、持久化 CookieJar、客户端标识、401 回调
│   │   ├── ApiException.kt       # 结构化错误（状态码 → 中文提示，封禁 / 验证码 / 解锁标记）
│   │   └── KeplerApi.kt          # 全部 REST 端点
│   ├── model/Models.kt           # DTO + org.json 手工解析
│   ├── prefs/
│   │   ├── SettingsStore.kt      # DataStore：服务器地址、用户名、排序偏好等明文设置
│   │   └── SecureStore.kt        # Android Keystore AES-256-GCM：密码与会话 Cookie
│   └── repo/
│       ├── AuthRepository.kt     # 登录 / 登出 / 会话恢复 / 明文地址降级
│       └── FileUploader.kt       # simple / multipart 流式上传（整轮复用同一文件句柄）
├── service/DownloadService.kt    # 下载前台服务：MediaStore 落盘 + 进度通知 + 取消
└── ui/
    ├── Formatters.kt             # 时间（java.time）/ 大小 / 百分比格式化
    ├── theme/                    # Material3 主题（动态取色）
    ├── login/                    # 登录页（验证码、Windows Hello 拒绝、连接测试）
    ├── main/                     # 自适应导航（NavigationBar / NavigationRail）+「我的」
    ├── files/                    # 文件浏览、多选、排序、上传队列
    │   ├── FilesScreen.kt
    │   ├── FilesViewModel.kt
    │   └── Sorting.kt            # 纯函数排序逻辑（便于单测）
    └── components/               # 通用组件（加载 / 错误 / 空态、各类型对话框）
```

## 八、与服务端 API 的对照

| 功能 | 端点 |
| --- | --- |
| 登录 / 会话 | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout` |
| 站点探测 | `GET /api/site/info` |
| 原生验证码 | `GET /api/captcha/native` |
| 文件列表 | `GET /api/fs/list` |
| 删除 | `POST /api/fs/delete` |
| 复制 | `POST /api/fs/copy` |
| 下载 | `GET /api/fs/download` |
| 上传 | `POST /api/fs/upload/init`、`PUT /api/fs/upload/simple`、`PUT /api/fs/upload/chunk`、`POST /api/fs/upload/complete`、`POST /api/fs/upload/abort` |
| 存储桶 | `GET /api/buckets/local`、`PUT /api/buckets/local/:id/active` |

所有非安全方法携带 `X-Requested-With: XMLHttpRequest` 以满足服务端 CSRF 同源校验，
并以 `X-Kepler-Client: kepler-android/1.0` 标识客户端；会话通过 `s3mgr_session` Cookie 维持，
Cookie 加密持久化，应用重启后不断登录。

## 九、测试

```bash
./gradlew testDebugUnitTest
```

当前 37 个 JVM 单元测试，覆盖三块容易出错、且不依赖 Android 框架的逻辑：

| 测试类 | 覆盖内容 |
| --- | --- |
| `FormattersTest`（16） | 时区换算（`Z` / 偏移 / 无时区 / RFC1123）、脏数据兜底、大小与百分比格式化 |
| `ApiExceptionTest`（14） | HTTP 状态码 → 中文提示、服务端结构化字段（错误码 / 封禁 / 验证码 / 解锁）解析 |
| `SortingTest`（7） | 文件夹恒在前、三种排序模式、不修改入参 |

> 说明：涉及 `org.json` 的用例额外引入了 `org.json:json` 作为测试依赖——
> `android.jar` 里的 `org.json` 是抛 `Stub!` 的空壳，不覆盖这条依赖时任何 JSON 解析在 JVM 单测里都会失败。

## 十、已知限制

- 加密（透明加密）文件可下载，但不支持在 App 内输入加密访问密码后在线查看。
- 文件预览（图片 / 视频）未实现，下载后通过系统应用打开。
- 分片上传未做真正的断点续传：中途退出应用后需重新上传整个文件（服务端会话会被 abort）。
- 「修改时间」排序按服务端返回的 ISO8601 **字符串**比较；服务端若混用多种时间格式，顺序会失真。
- 仅提供中文界面（`resourceConfigurations` 限定 `zh`）。

## 十一、开源协议

与 [Kepler](https://github.com/xingsen2005/Kepler) 保持一致。此处不写死具体协议，是因为上游可能调整授权条款。
