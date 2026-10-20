/**
 * 列举/扫描上限集中定义（PERF-04）
 *
 * ## 为什么要集中
 *
 * 旧代码里这些数字散落在 4 个文件（s3.js / routes/fs.js / routes/buckets.js /
 * webdav-server.js），取值从 2 万到 20 万不等且互不知情。`listAll()` 串行翻页把
 * 全部结果累积到内存数组，20 万对象意味着 200 次串行云端往返 + 一次整体序列化，
 * 单请求即可产生数秒长任务与数百 MB 内存峰值 —— 多个请求并发就可能撑爆内存。
 *
 * ## 取值依据
 *
 * - `SCAN`（搜索/估算扫描）：**5000**。用户搜索通常关注最近/前若干页，
 *   超出应给出「结果过多，请细化关键词」而非假装全量返回。
 * - `STAT`（文件夹属性计数）：**20000**。精确到 2 万已满足「这个文件夹有多大」；
 *   超过时返回 `truncated=true`，UI 显示「≥N」而非假精确值。
 * - `DELETE`（删除/清空）：**5000**。删除走「列举一页→删一页」流式循环，
 *   内存恒定，循环次数自然覆盖超大桶，无需一次读入大量对象。
 * - `PROPFIND`（WebDAV Depth: infinity）：**5000**。文件系统客户端对超大目录
 *   本身也不能良好呈现，超出同样标注截断。
 * - `HARD_MAX`（硬性天花板）：**50000**。任何调用方都不得越过，用于兜住回归。
 *
 * 所有 cap 均可通过环境变量覆盖，便于在受控环境下做压力验证。
 */

/** 从环境变量读取正整数上限，非法/缺失时回退默认值 */
function fromEnv(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** 任何列举操作的硬性天花板 —— 越过即视为缺陷 */
const HARD_MAX = 50000;

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return HARD_MAX;
  return Math.min(Math.floor(n), HARD_MAX);
}

const LIMITS = {
  /** 单页列举条数上限（/fs/list 的 maxKeys；对象存储服务端单页上限 1000） */
  LIST_PAGE: 1000,
  /** 搜索 / 用量估算扫描上限 */
  SCAN: clamp(fromEnv('LIST_SCAN_CAP', 5000)),
  /** 文件夹属性计数上限 */
  STAT: clamp(fromEnv('LIST_STAT_CAP', 20000)),
  /** 删除 / 清空时的单次列举上限（循环调用，恒定内存） */
  DELETE: clamp(fromEnv('LIST_DELETE_CAP', 5000)),
  /** WebDAV Depth: infinity 的 PROPFIND 上限 */
  PROPFIND: clamp(fromEnv('LIST_PROPFIND_CAP', 5000)),
  /** 硬性天花板 */
  HARD_MAX,
  /**
   * 单请求复制（`putObjectCopy`）的大小上限 —— 超过必须走分块复制。
   * 此前 routes/fs.js 与 fs-gateway.js 各写一份同样的常量，属于典型的
   * 「同一类常量多份实现」，改一处漏一处就会分叉，故收拢到这里。
   */
  COPY_SIMPLE_LIMIT: 5 * 1024 * 1024 * 1024,
  /**
   * R9-09：magic（异或流）加密模式下，**单次同步加密的输入上限**。
   *
   * `xorBuf` 的密钥流每 32 字节做一次 SHA-256，且 `encryptBuffer` / `encryptPart`
   * 都是**同步**函数、在 handler 里直接调用 —— 输入越大，事件循环被占住越久。
   * 本机实测 sha256 单块 ≈ 2.55µs：
   *   5MB ≈ 418ms、8MB ≈ 669ms、48MB ≈ 4.0s（纯同步阻塞）。
   * 多路并发上传时这些阻塞会叠加，整个服务在数秒内不响应任何请求。
   *
   * **不能再往下压**：5MB 是 AWS S3 对「除最后一片外」的分片下限，压到 4MB 会让
   * 启用 magic 的大文件在 AWS S3 上合并时报 `EntityTooSmall`（腾讯云 COS 是 1MB、
   * 阿里云 OSS / 华为云 OBS 是 100KB，本可更小，但必须取各厂商中最严的那个）。
   * 也就是说 —— 它同时是**性能上限**与**协议下限**，改之前先查协议。
   *
   * R8-02 只把这个上限用于分片路径（`routes/fs.js` 的 `chunkSize`），而直传
   * （`/fs/upload/simple`，`express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后同步
   * 加密）两条路径没有约束。R9-09 把它**下沉到 `encStore.encryptBuffer` 内部**，
   * 使「按模式拒绝超限输入」成为加密入口自身的契约，而不是逐个调用点各写一次 ——
   * 否则就是第 N 次「同一状态多入口，改一处漏一处」。
   */
  MAGIC_SYNC_MAX: 5 * 1024 * 1024,
};

/**
 * 解析调用方传入的 cap：
 *  - 未传（undefined/null）→ 返回 `dflt`
 *  - 显式传 false / 0 → 无显式上限，仍受 HARD_MAX 约束
 *  - 其它值 → 取 min(值, HARD_MAX)
 */
function resolveCap(requested, dflt) {
  if (requested === undefined || requested === null) return clamp(dflt);
  if (requested === false || requested === 0) return HARD_MAX;
  return clamp(requested);
}

/* ============================ 下载限速（R37） ============================ */

/**
 * UI 的 MB 与字节的换算基数。
 *
 * 取 1024 而非 1000：与 `public/js/util.js` 的 `fmtSize()` 同基数 —— 界面上
 * 「文件大小」与「限速」用两套基数，用户会算不平（1.5 MB/s 传输 150 MB 文件
 * 到底要 100 秒还是 150 秒）。
 */
const MB = 1024 * 1024;

/**
 * 归一化限速值 → **非负整数字节/秒**；`0` = 不限速。
 *
 * 这是「什么是合法的限速值」的**唯一判据**，放在本文件（无任何 require 的叶子
 * 模块）而不是 `throttle.js`：`config-store` / `share-store` 写盘时要用它归一化，
 * 而 `throttle.js` 反过来要 require 它们 —— 判据若住在 `throttle.js` 就会成环。
 *
 * 约定与 `normalizeQuotaBytes` 一致：非有限数 / 非正数一律归 0（不限），
 * 正数向下取整（速率是字节/秒，小数没有意义）。
 */
function normalizeSpeedLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 字节/秒 → MB/s（展示用，保留一位小数；0 = 不限速） */
function toMBps(bytesPerSec) {
  const n = normalizeSpeedLimit(bytesPerSec);
  if (!n) return 0;
  return Math.round((n / MB) * 10) / 10;
}

/**
 * 校验**接口入参**里用户填的限速值 —— 四个设置入口（API Key / 存储桶 / 用户 /
 * 分享链接）共用的**唯一实现点**。
 *
 * 为什么不能直接把 `b.speedLimit` 丢给 `normalizeSpeedLimit`：
 * 它与配额（R25 的 `quotaBytes`）是同一个陷阱 —— 界面填 `-1` / `abc` 会被
 * 归一化成 `0`，而 `0` 的语义是「**不限速**」。于是用户以为设置了限制，
 * 实际把限制**完全放开**了（正好反了）。所以入参必须先判定合法性，
 * 非法一律 400 让用户看见，而不是静默改写成「更宽松」的值。
 *
 * @param {*} v 原始入参
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 *          `value` 为向下取整的字节/秒；`0` = 不限速
 */
function parseSpeedLimitInput(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '限速值不能为负数（0 表示不限速）' };
  return { ok: true, value: Math.floor(n) };
}

/* ============================ 线程并发（R48） ============================ */

/**
 * 「线程并发」——同时上传 / 加密的**文件数**上下界。
 *
 * 放在本文件（无任何 require 的叶子模块）：`config-store` 读盘归一化要用它，
 * `routes/enc.js` 校验入参也要用它，两边必须是**同一个数**。若各写一份，
 * 界面允许 32、存储层却截到 16，用户会看到「设了没生效」。
 *
 * 上界 16 是**界面护栏**：再大也绕不过浏览器 HTTP/1.1 每主机 6 连接
 * （见 `public/js/upload.js` 的 `uploadPlan()`），只会让请求在浏览器里排队；
 * 服务端线程池另有 `HARD_MAX_WORKERS=8` 的硬顶（`server/enc-pool.js`）。
 */
const CONCURRENCY_FILES_MIN = 1;
const CONCURRENCY_FILES_MAX = 16;

/**
 * 校验**接口入参**里的并发数 —— 与 `parseSpeedLimitInput` 同一套路数。
 *
 * 为什么不能直接把入参交给 `configStore` 的归一化函数：那会把非法值静默改写
 * （`0` / `-3` / `"abc"` 一律变成 1），用户以为自己把并发调到了 1，实际是入参
 * 被拒后回落；更糟的是若将来归一化改成「非法即最大」，一次手滑就把并发开满。
 * 入参必须**显式**判定合法，非法一律 400 让用户看见。
 *
 * @param {*} v 原始入参
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
function parseConcurrencyInput(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < CONCURRENCY_FILES_MIN) {
    return { ok: false, error: `同时上传 / 加密的文件数不能小于 ${CONCURRENCY_FILES_MIN}` };
  }
  const value = Math.floor(n);
  if (value > CONCURRENCY_FILES_MAX) {
    return { ok: false, error: `同时上传 / 加密的文件数不能超过 ${CONCURRENCY_FILES_MAX}` };
  }
  return { ok: true, value };
}

/* ============================ 发信设置 / SMTP（R53） ============================ */

/**
 * 默认端口：**465**（隐式 TLS，与 `secure: true` 配套）。
 *
 * 587（STARTTLS）与 25（纯明文 / 中继）同样常见，但默认值必须落在「最不容易出错」
 * 的那一档：465 建连即 TLS，不存在「服务端不宣告 STARTTLS 就退回明文」的分支，
 * 也就不会把口令发出去。管理员要用 587 时把 `secure` 关掉即可。
 */
const SMTP_PORT_DEFAULT = 465;
const SMTP_PORT_MIN = 1;
const SMTP_PORT_MAX = 65535; // 传输层端口的协议上限（uint16）

/** 主机名上限：DNS 名的协议上限就是 255（RFC 1035 的标签拼接后总长限制） */
const SMTP_HOST_MAX = 255;
/** 邮箱地址上限：本地部分 64 + `@` + 域名 255 = 320（RFC 5321 §4.5.3） */
const SMTP_ADDRESS_MAX = 320;
/** 发件人显示名上限：过长会被部分客户端截断，128 足够放中文别名 */
const SMTP_NAME_MAX = 128;
/** 口令上限：只为拦住「把整段文本误粘进口令框」，口令本身不校验复杂度 */
const SMTP_PASSWORD_MAX = 512;

/**
 * 归一化 SMTP 端口 → `1..65535` 的整数。
 *
 * 与 `normalizeConcurrencyFiles()` 不同，这里**三种输入合并成同一个结果**：
 * 端口没有「更保守」的取值（`concurrency` 可以退到 1 表示不并发，端口退到 1
 * 毫无意义且会让用户困惑「为什么我填的端口变成了 1」）。因此缺失 / 非数字 /
 * 越界一律回到**文档化的默认值** 465，并由入参校验（`parseSmtpPortInput`）
 * 先把非法值挡在 400，用户不会走到这条静默路径。
 */
function normalizeSmtpPort(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return SMTP_PORT_DEFAULT;
  const i = Math.floor(n);
  if (i < SMTP_PORT_MIN || i > SMTP_PORT_MAX) return SMTP_PORT_DEFAULT;
  return i;
}

/**
 * 校验**接口入参**里的 SMTP 端口 —— 与 `parseConcurrencyInput` 同一套路数：
 * 非法值一律 400 让用户看见，而不是静默改写成另一个端口。
 */
function parseSmtpPortInput(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
    return { ok: false, error: 'SMTP 端口须为数字' };
  }
  const value = Math.floor(n);
  if (value < SMTP_PORT_MIN || value > SMTP_PORT_MAX) {
    return { ok: false, error: `SMTP 端口须在 ${SMTP_PORT_MIN}–${SMTP_PORT_MAX} 之间` };
  }
  return { ok: true, value };
}

/**
 * 校验**接口入参**里的邮箱地址（发件人 / 收件人）。
 *
 * ⚠️ 这里有一条**安全铁律**：必须拒绝 CR / LF。
 *
 * SMTP 是行式协议 —— `MAIL FROM:<…>` 与 `From: …` 都是我们**手工拼进命令与
 * 信头**的。一旦地址里带 `\r\n`，攻击者就能在 envelope 或信头里**注入任意行**
 * （追加 `RCPT TO`、伪造 `Bcc`、覆盖 `Subject`），即经典的 SMTP 头部注入。
 * base64 / 长度上限都挡不住它，只有在这里显式拒绝才行 —— 这是唯一的判据点。
 */
function parseSmtpAddressInput(v, label) {
  const name = label || '邮箱地址';
  const raw = v == null ? '' : String(v);
  /**
   * ⚠️ 必须在 **trim 之前**判换行。
   *
   * 先 trim 再判的话，`a@b.com\r\n` 会被裁成 `a@b.com` 而**放行** ——
   * 看起来无害（我们本来就会自己重拼这一行），但它把「能不能注入」变成了一个
   * 依赖「trim 恰好把恶意内容删干净」的性质：`a@b.com\r\nBcc: x@y.com`
   * 里的换行在**中间**，trim 删不掉，于是同一个判据对两种输入给出两种答案。
   * 换成「原始串里出现任一 CR / LF 即拒绝」之后，判据与位置无关，也不会被
   * 「末尾多一个换行」这种粘贴噪声带偏。
   */
  if (/[\r\n]/.test(raw)) return { ok: false, error: `${name}不能包含换行符` };
  const s = raw.trim();
  if (!s) return { ok: true, value: '' }; // 留空 = 不设置（口令框同样语义）
  if (s.length > SMTP_ADDRESS_MAX) return { ok: false, error: `${name}不能超过 ${SMTP_ADDRESS_MAX} 个字符` };
  const at = s.split('@').length - 1;
  if (at !== 1) return { ok: false, error: `${name}须为合法的邮箱地址（有且仅有一个 @）` };
  const [local, domain] = s.split('@');
  if (!local || !domain || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) {
    return { ok: false, error: `${name}的域名部分不合法` };
  }
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return { ok: false, error: `${name}的域名含有非法字符` };
  return { ok: true, value: s };
}

/**
 * 校验**接口入参**里的普通文本字段（主机、用户名、发件人别名）。
 *
 * 与地址同理：拒绝 CR / LF（防命令 / 信头注入），再夹长度。不校验内容合法性 ——
 * 主机名可以是 IP、用户名可以是任意字符串，交给 SMTP 服务器去判，我们不做猜测。
 */
function parseSmtpTextInput(v, max, label) {
  const name = label || '该字段';
  const raw = v == null ? '' : String(v);
  // 同 `parseSmtpAddressInput`：拒绝换行必须在 trim 之前（理由见那里）
  if (/[\r\n]/.test(raw)) return { ok: false, error: `${name}不能包含换行符` };
  const s = raw.trim();
  if (s.length > max) return { ok: false, error: `${name}不能超过 ${max} 个字符` };
  return { ok: true, value: s };
}

/* ============================ 站点设置（R54） ============================ */

/**
 * 站点名称上限 —— 它与 `SMTP_NAME_MAX` 同为 128，但**刻意各留一份常量**：
 * 两者是**不同功能**的字段（浏览器标题栏 / 邮件发件人显示名），哪天要给其中一个
 * 放宽或收紧，共用一个常量就会让另一个跟着动，而那种连动没有任何理由。
 */
const SITE_NAME_MAX = 128;

/**
 * 默认站点名称。
 *
 * 必须与 `public/index.html` 的 `<title>` 保持一致：升级到本版本时，
 * 老配置里没有 `site` 段，标题栏要在**不发任何请求**的情况下也照旧显示同一串字。
 */
const SITE_NAME_DEFAULT = 'Kepler 对象存储管理系统';

/**
 * 注册模式（三态）——
 *  - `open`   公开注册：任何人都能在登录页注册；
 *  - `invite` 邀请码：注册时必须填写有效的邀请码；
 *  - `closed` 关闭注册：不开放注册，新用户只能由管理员添加。
 *
 * ⚠️ 默认值是 `closed`：本版本之前系统**没有注册入口**，默认成另外两个值
 * 等于升级即悄悄开放了一个谁都能进来的注册通道。
 */
const REGISTRATION_MODES = ['open', 'invite', 'closed'];
const REGISTRATION_DEFAULT = 'closed';

/** 新注册用户可被直接赋予的角色（与 `config-store` 的 `normalizeRole()` 同口径） */
const DEFAULT_ROLES = ['user', 'admin'];
const DEFAULT_ROLE_FALLBACK = 'user';

/** 归一化注册模式：非法 / 缺失一律回到「关闭注册」（最保守的一档） */
function normalizeRegistrationMode(v) {
  return REGISTRATION_MODES.includes(v) ? v : REGISTRATION_DEFAULT;
}

/** 归一化新用户默认身份：非法一律回到「普通用户」 */
function normalizeDefaultRole(v) {
  return DEFAULT_ROLES.includes(v) ? v : DEFAULT_ROLE_FALLBACK;
}

/**
 * 校验**接口入参**里的站点名称。
 *
 * 直接复用 `parseSmtpTextInput()` 的两条判据（拒绝 CR / LF + 夹长度）：
 * 站点名称会被拼进**邮件信头**（发件人显示名的兜底）与 HTML `<title>`，
 * 换行注入面与 `parseSmtpAddressInput` 遇到的是同一类问题。
 *
 * 返回值允许空串（= 恢复默认名），由落盘归一化把空串换成 `SITE_NAME_DEFAULT`。
 */
function parseSiteNameInput(v) {
  return parseSmtpTextInput(v, SITE_NAME_MAX, '站点名称');
}

/* ============================ 邮箱（R54 第 ② 步） ============================ */

/**
 * 邮箱地址长度上限 —— 取 RFC 5321 的 `Mailbox` 上限 254（`local@domain`）。
 * 与 `SMTP_ADDRESS_MAX`（320，那是 SMTP 路径 `<>` 的规范上限）**刻意不同值**：
 * 两者量的是不同的东西，共用会让其中一个被另一个的取舍带走。
 */
const EMAIL_MAX = 254;

/** 邮箱验证码位数（6 位十进制，`crypto.randomInt` 取值，不用 `Math.random`） */
const EMAIL_CODE_LEN = 6;

/**
 * 邮箱**本地部分**的合法字符集（RFC 5322 的 `atext`，外加点号）。
 *
 * ⚠️ 这一条不是"形式主义"：邮箱会被原样放进 SMTP 的 `To:`，而 `smtp.sendMail()`
 * 只判"非空"（`validateForSend` 不校验格式）。不夹这个字符集的话，
 * `a@b.com,c@d.com` 这类输入会通过「有且仅有一个 @」的判据 ——
 * 逗号在 RFC 5322 里是**地址分隔符**，于是我们就会替调用者把同一封信
 * 发给第二个地址（`/auth/email/code` 是任何登录用户都能打的接口）。
 * 引号包裹的本地部分（`"foo bar"@x.com`）同样排除：账户邮箱没有这个用法。
 */
const EMAIL_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

/** 验证码有效期：10 分钟 */
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * 同一个验证码最多被试错几次。
 *
 * 6 位十进制 = 10^6 种可能，5 次尝试把命中率压到 5e-6 —— 与「10 分钟 + 每邮箱重发冷却」
 * 叠加后，靠猜码重置别人密码是不可行的。**用满即作废**（不是「用满即锁定」）：
 * 后者会让攻击者用「故意错 5 次」把账户的重置入口锁死。
 */
const EMAIL_CODE_MAX_ATTEMPTS = 5;

/**
 * 同一邮箱的重发冷却：60 秒。
 *
 * 这一条同时管住两件事 —— ① 有人拿本站当"给某人发垃圾邮件"的工具；
 * ② 有人靠反复点「发送验证码」把 SMTP 服务器的发信配额刷光。
 */
const EMAIL_CODE_RESEND_MS = 60 * 1000;

/**
 * 归一化邮箱（**落盘 / 比对**用）：去空白 + 全部转小写。
 *
 * 转小写是刻意的：`Alice@Example.com` 与 `alice@example.com` 在本系统的语义里
 * 是**同一个**邮箱（域名本来就大小写不敏感，而实务上所有主流邮件服务商的
 * local part 也都不区分大小写）。不归一化的话会出现「同一个邮箱绑给两个账号」，
 * 而那时「重置密码该重置谁」就没有正确答案了。
 */
function normalizeEmail(v) {
  const raw = v == null ? '' : String(v);
  if (/[\r\n]/.test(raw)) return ''; // 脏数据：含换行一律视为「没有邮箱」
  return raw.trim().toLowerCase();
}

/**
 * 校验**接口入参**里的邮箱地址。
 *
 * 判据与 `parseSmtpAddressInput()` **刻意同源但各写一份**：那个函数校验的是
 * 「SMTP 发件人 / 收件人」，允许留空（= 不设置）且用的是 320 的上限；
 * 而这里是「用户的账户邮箱」，语义是**必须给出一个合法地址**，空串非法。
 * 共用一个实现会立刻在「留空算不算合法」上打架。
 *
 * ⚠️ 与 `parseSmtpAddressInput` 一样：**先判 CR / LF 再 trim**。邮箱会被直接拼进
 * 信头 `To:`，一个换行就是一次信头注入；而先 trim 会把 `a@b.com\r\n` 裁成合法地址放行。
 */
function parseEmailInput(v, label) {
  const name = label || '邮箱地址';
  const raw = v == null ? '' : String(v);
  if (/[\r\n]/.test(raw)) return { ok: false, error: `${name}不能包含换行符` };
  const s = raw.trim();
  if (!s) return { ok: false, error: `请输入${name}` };
  if (s.length > EMAIL_MAX) return { ok: false, error: `${name}不能超过 ${EMAIL_MAX} 个字符` };
  const at = s.split('@').length - 1;
  if (at !== 1) return { ok: false, error: `${name}须为合法地址（有且仅有一个 @）` };
  const [local, domain] = s.split('@');
  if (!local || local.length > 64) return { ok: false, error: `${name}的用户名部分不合法` };
  if (!EMAIL_LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, error: `${name}的用户名部分含有非法字符` };
  }
  if (!domain || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) {
    return { ok: false, error: `${name}的域名部分不合法` };
  }
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return { ok: false, error: `${name}的域名含有非法字符` };
  /**
   * 域名必须**含点且顶级标签是字母**（`a@localhost` 拒掉）。
   *
   * 本系统的邮箱只有两个用途：发验证码、收重置码 —— 内网地址发不出去，
   * 放行只会让用户拿到一句来自 SMTP 服务器的、看不懂的报错。
   */
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(domain)) {
    return { ok: false, error: `${name}的域名不完整（须形如 example.com）` };
  }
  return { ok: true, value: normalizeEmail(s) };
}

/**
 * 生成 `EMAIL_CODE_LEN` 位的十进制验证码（`crypto.randomInt` 是密码学安全的）。
 *
 * ⚠️ 这个函数**刻意不放在 `limits.js`**：本模块是**零 require 的叶子模块**
 * （它承担打破 `config-store` ↔ 各路由循环依赖的职责），任何 `require` 都会
 * 让这层结构失守。生成逻辑住在 `server/email-code.js`。
 */

/* ============================ 邀请码（R54 第 ③ 步） ============================ */

/**
 * 邀请码字符集 —— **去掉易混字符**：`0`/`O`、`1`/`I`/`L`。
 *
 * 邀请码与验证码的差别在于**它是给人念、给人抄、给人手打的**：管理员会把一批码
 * 贴进群里、发给同事、印在纸上。`0O`、`1Il` 在多数无衬线字体里几乎同形，留着
 * 就必然出现「明明抄对了却提示无效」的工单，而这类问题排查起来完全是噪音。
 * 代价是每个字符的熵从 log2(36)=5.17 降到 log2(31)=4.95，可以忽略。
 */
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 邀请码长度 —— 10 位 × 31 字符集 ≈ **49.5 位熵**。
 *
 * 取值依据：邀请码是**一枚免注册口令**，拿到即能开户（身份还可能是管理员）。
 * 它不能像分享链接 ID 那样靠 128 位，因为要手抄；但也不能短到能扫。
 * 注册接口另有 10 次 / 10 分钟的 IP 限流（`security.registerLimiter`），
 * 49.5 位熵在该速率下不可枚举。之所以不取 12 位：多两位换来 10 位熵，
 * 却让手抄出错概率上升，而限流已经把枚举速率压到极低。
 */
const INVITE_CODE_LEN = 10;

/**
 * 邀请码的**规范形式**（校验用）：恰好 `INVITE_CODE_LEN` 个字符、全大写、无分隔符。
 *
 * ⚠️ 归一化（大小写、空白）在 `normalizeInviteCode()` 里做，这里只判「归一之后
 * 是不是一枚码」。两者分开是刻意的：`INVITE_CODE_RE` 也用来判**库里的码是否仍然是
 * 合法形态**（`invite-store.load()` 会把不合规的记录清掉），那条路径不该先做一遍归一。
 */
const INVITE_CODE_RE = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LEN}}$`);

/**
 * 单次「批量生成」的条数上限。
 *
 * 500 是个运维尺度的取舍：一次贴 500 个码已经远超任何正常的分发场景（给一个部门
 * 发码通常几十个），而每次生成都要保证**库内唯一**（生成时要与已有记录比对），
 * 无上限就等于让一次请求把 `invites.json` 写爆、把响应撑成几 MB。
 */
const INVITE_BATCH_MAX = 500;

/** 备注（批次用途 / 领用人）上限 —— 走 `parseSmtpTextInput` 的同一组判据 */
const INVITE_NOTE_MAX = 64;

/**
 * 单个邀请码的「最大使用次数」上限。`0` = **不限制**（与分享链接的
 * `maxDownloads` 同语义：0 表示不限制，而不是「一次都不能用」）。
 *
 * 上限只为拦住手滑输入（`999999999`），业务上没有理由设到十万次以上 ——
 * 真有那种量级的需求，正确做法是给码设过期时间，而不是把次数开到无限。
 */
const INVITE_MAX_USES_MAX = 100000;

/**
 * 一个邀请码最多记多少条「被谁用过」。
 *
 * `used`（计数）永远是准的，`usedBy`（名单）只是给人看的，故**刻意截断**：
 * `invites.json` 是每次打开「邀请码设置」页都要整体读入并加密解密的文件，
 * 一个不限次数的码被用上千次就会拖着整个文件一起变大。只留最近 50 条就够回答
 * 「这枚码最近是谁在用」，超出的部分由**审计日志**兜底（注册成功那条里带了码 id）。
 */
const INVITE_USED_BY_MAX = 50;

/**
 * 归一化邀请码（**落盘 / 比对**用）：去掉**全部**空白 + 转大写。
 *
 * 去掉全部空白（而不只是首尾）是为了容忍三种极常见的粘贴形态：
 * 从表格里复制带上的尾随空格、从聊天软件复制带上的换行、以及人工抄写时
 * 按 4 位一组加的 `ABCD EFGHJK`。这些输入在语义上就是同一枚码，
 * 不归一化会让「粘贴之后提示无效」变成一个几乎无法自查的坑。
 *
 * ⚠️ 与 `normalizeEmail()` 的处置**相反**（那里含 CR/LF 一律归零）——
 * 因为两者的下游不同：邮箱会被**拼进 SMTP 信头**（换行即注入），
 * 邀请码只用于**查表比对**，且比对前必然经过本函数，换行在表里也查不到。
 */
function normalizeInviteCode(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
}

/**
 * 校验**接口入参**里的邀请码。
 *
 * ⚠️ 与 `parseEmailInput` 一样：**先判 CR / LF 再归一**。
 *
 * 这里判换行不是为了防注入（邀请码不进任何信头 / 命令行），而是为了**不让一条
 * 脏输入变成一次查询**：`normalizeInviteCode` 会把 `AB\nCD` 拼成 `ABCD`，
 * 于是「粘贴带了个换行」与「真的输错了一位」在服务端看起来一模一样，
 * 用户拿到的提示却是同一句「邀请码无效」—— 那是最难自查的一类报错。
 * 显式拒掉换行，用户至少知道问题出在复制上。
 */
function parseInviteCodeInput(v) {
  const raw = v == null ? '' : String(v);
  if (/[\r\n]/.test(raw)) return { ok: false, error: '邀请码不能包含换行符' };
  const s = normalizeInviteCode(raw);
  if (!s) return { ok: false, error: '请输入邀请码' };
  if (!INVITE_CODE_RE.test(s)) {
    return { ok: false, error: `邀请码格式不正确（应为 ${INVITE_CODE_LEN} 位字母数字，不含 0/O/1/I/L）` };
  }
  return { ok: true, value: s };
}

/**
 * 校验**接口入参**里的「生成条数」。
 *
 * 与 `parseConcurrencyInput` 同一套路数：非法值一律 400 让用户看见，
 * 而不是静默夹到边界（「我填了 1000，怎么只生成了 500」同样是工单）。
 */
function parseInviteCountInput(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: '生成数量须为整数' };
  }
  if (n < 1) return { ok: false, error: '生成数量至少为 1' };
  if (n > INVITE_BATCH_MAX) return { ok: false, error: `一次最多生成 ${INVITE_BATCH_MAX} 个邀请码` };
  return { ok: true, value: n };
}

/**
 * 校验**接口入参**里的「最大使用次数」。`0` = 不限制。
 *
 * 负数是**必须显式拒掉**的一档：落盘归一化会把 `-1` 归成 `0`，而 `0` 的语义是
 * 「**不限制**」—— 管理员想收紧配额，结果把限制完全放开了（与 `parseSpeedLimitInput`
 * 拦的是同一个陷阱，方向正好相反的那一侧）。
 */
function parseInviteMaxUsesInput(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: '使用次数上限须为整数（0 表示不限制）' };
  }
  if (n < 0) return { ok: false, error: '使用次数上限不能为负数（0 表示不限制）' };
  if (n > INVITE_MAX_USES_MAX) return { ok: false, error: `使用次数上限不能超过 ${INVITE_MAX_USES_MAX}` };
  return { ok: true, value: n };
}

/**
 * 校验**接口入参**里的「过期时间」。
 *
 * 接受 `null` / `''`（= **永久有效**）、ISO 8601 字符串、以及 epoch 毫秒。
 * 返回归一后的 **ISO 字符串** 或 `null`。
 *
 * ⚠️ **必须晚于 `now`**：把一个已经过去的时间当成「过期时间」存下来，唯一的效果
 * 是让这枚码**当场就无效**，而界面上「过期时间」那一列显示的又是一个未来感十足的
 * 日期 —— 管理员会以为是自己设置的，实际拿到一批立即失效的码。
 * 要立即失效**有专门的开关**（`disabled`），所以这里直接 400 并指路。
 *
 * `now` 可注入：测试要构造「恰好边界」「已过期」的场景，不能依赖真实时钟。
 */
function parseInviteExpiresInput(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  let ms;
  if (typeof v === 'number') ms = v;
  else {
    const raw = String(v);
    if (/[\r\n]/.test(raw)) return { ok: false, error: '过期时间不能包含换行符' };
    const s = raw.trim();
    if (!s) return { ok: true, value: null };
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) return { ok: false, error: '过期时间格式不正确' };
  if (ms <= now) return { ok: false, error: '过期时间须晚于当前时间；若要立即失效请使用「停用」' };
  return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * 校验**接口入参**里的备注。
 *
 * 直接复用 `parseSmtpTextInput()` 的两条判据（拒绝 CR / LF + 夹长度）：
 * 备注会进**审计日志**（`statsStore.addLog` 的 detail），而日志是 JSONL ——
 * 换行虽然被 JSON 转义、不会真的多出一行，但台账读起来会被截断，
 * 且「能塞进什么」这件事没有理由在这里放宽。
 */
function parseInviteNoteInput(v) {
  return parseSmtpTextInput(v, INVITE_NOTE_MAX, '备注');
}

/* ============================ 优惠券（R62） ============================ */

/**
 * 券码与邀请码共用同一套字符集与长度：两者都是**给人抄、给人念**的短口令
 * （优惠券会被管理员贴进群里、或被买家手输）。`0/O`、`1/I/L` 同形的坑完全一样，
 * 故字符集**复用**而不是再定义一份 —— 两份字面量迟早会漂移。
 */
const COUPON_CODE_ALPHABET = INVITE_CODE_ALPHABET;
const COUPON_CODE_LEN = INVITE_CODE_LEN;
const COUPON_CODE_RE = new RegExp(`^[${COUPON_CODE_ALPHABET}]{${COUPON_CODE_LEN}}$`);

/** 单次批量生成上限（优惠券比邀请码分发范围更窄，200 已远超正常场景） */
const COUPON_BATCH_MAX = 200;
const COUPON_NOTE_MAX = INVITE_NOTE_MAX;

/**
 * 单张券可领取/使用的总次数上限。`0` = 不限制（与邀请码同一语义：
 * **0 不是「一次都不能用」**，而是「不限」）。
 */
const COUPON_MAX_USES_MAX = INVITE_MAX_USES_MAX;

/** 优惠券的**适用范围**类型 —— 也是需求原文里的「类型限制」三档 */
const COUPON_TYPES = ['any', 'links', 'users'];

/**
 * 一次最多关联多少个目标（链接 / 用户）。
 *
 * 上限的意义不是业务约束，而是**请求体与落盘体积**：`linkIds` / `userIds` 会整段
 * 进 `coupons.json`，无上限等于允许一次请求把文件写大一个数量级。
 */
const COUPON_MAX_TARGETS = 200;

/** 优惠金额（分）的上下界：与 `payment-rules` 的金额区间保持一致 */
const COUPON_AMOUNT_MIN_FEN = 1;
const COUPON_AMOUNT_MAX_FEN = 10000000;

/** 单张券最多保留多少条核销台账（超出丢最旧；`used` 计数始终准确） */
const COUPON_USES_MAX = 200;

/** 券码归一化：**直接复用** `normalizeInviteCode`（去全部空白 + 转大写，语义逐字相同）。
 *  刻意不再抄一份实现 —— 同一判据两份代码必然漂移，而漂移的表现是
 *  「邀请码能粘贴带空格、优惠券却说无效」这种没人会往那儿想的差异。 */
const normalizeCouponCode = normalizeInviteCode;

/** 适用范围归一化：认不出的一律回落到 `any`（不因为一个脏值把券变成「谁都不可用」） */
function normalizeCouponType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return COUPON_TYPES.indexOf(s) >= 0 ? s : 'any';
}

function parseCouponCodeInput(v) {
  const raw = v == null ? '' : String(v);
  if (/[\r\n]/.test(raw)) return { ok: false, error: '优惠券码不能包含换行符' };
  const s = normalizeCouponCode(raw);
  if (!s) return { ok: false, error: '请输入优惠券码' };
  if (!COUPON_CODE_RE.test(s)) {
    return { ok: false, error: `优惠券码格式不正确（应为 ${COUPON_CODE_LEN} 位字母数字，不含 0/O/1/I/L）` };
  }
  return { ok: true, value: s };
}

function parseCouponCountInput(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: '生成数量须为整数' };
  }
  if (n < 1) return { ok: false, error: '生成数量至少为 1' };
  if (n > COUPON_BATCH_MAX) return { ok: false, error: `一次最多生成 ${COUPON_BATCH_MAX} 张优惠券` };
  return { ok: true, value: n };
}

/**
 * 优惠**金额**（元）→ 分。
 *
 * 入参是「元」（界面上的输入框），落盘一律是整数「分」——与 `payment-rules`
 * 全局一致，杜绝浮点误差。最低 0.01 元：0 元券在语义上就是「免费」，
 * 那会让下单链路必须处理「应付 0 元」这种网关不接受的状态（本版本刻意不支持）。
 */
function parseCouponAmountInput(v) {
  if (v === undefined || v === null || v === '') return { ok: false, error: '请填写优惠金额' };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, error: '优惠金额必须是数字' };
  if (n < 0) return { ok: false, error: '优惠金额不能为负数' };
  const fen = Math.round(n * 100);
  if (fen < COUPON_AMOUNT_MIN_FEN) return { ok: false, error: '优惠金额最低 0.01 元' };
  if (fen > COUPON_AMOUNT_MAX_FEN) return { ok: false, error: `优惠金额不能超过 ${COUPON_AMOUNT_MAX_FEN / 100} 元` };
  return { ok: true, value: fen };
}

/**
 * 券的「总使用次数」校验：**复用**邀请码的同一实现（`0` = 不限制、负数必须拒绝、
 * 上限同为 `COUPON_MAX_USES_MAX`）。理由同 `normalizeCouponCode`：同一判据不写两份。
 */
const parseCouponMaxUsesInput = parseInviteMaxUsesInput;

/**
 * 券的「开始 / 到期时间」。
 *
 * - `null` / `''` → `null`（开始 = 立即可用；到期 = 永久有效）
 * - 接受 ISO 8601 与 epoch 毫秒，统一归一成 ISO 字符串
 *
 * 与邀请码的差别：**开始时间允许是过去**（「立刻生效」的正常写法），
 * 只有到期时间必须晚于当前时间 —— 否则存下来的是一张出生即失效的券。
 */
function parseCouponTimeInput(v, label, now = Date.now()) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  let ms;
  if (typeof v === 'number') ms = v;
  else {
    const s = String(v).trim();
    if (/^\d+$/.test(s)) ms = Number(s);
    else ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) return { ok: false, error: `${label}格式不正确` };
  if (label === '到期时间' && ms <= now) {
    return { ok: false, error: '到期时间须晚于当前时间；若要立即失效请使用「停用」' };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

/** 目标 id 列表（链接 / 用户）：去空白、去重、限长、拒绝非字符串 */
function parseCouponIdsInput(v, label) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (!out.length) return { ok: false, error: `请至少选择 1 个${label}` };
  if (out.length > COUPON_MAX_TARGETS) {
    return { ok: false, error: `一次最多选择 ${COUPON_MAX_TARGETS} 个${label}` };
  }
  return { ok: true, value: out };
}

function parseCouponNoteInput(v) {
  return parseSmtpTextInput(v, COUPON_NOTE_MAX, '备注');
}

/* ============================ 订单取回（R65） ============================ */

/**
 * 「订单取回」的两个上限（系统设置 → 订单取回）。
 *
 *  - `RESTORE_USES_*`：**同一笔订单号**最多可成功取回下载权限几次（按订单计，
 *    不是按 IP）。它的作用是「订单号泄漏 / 被转发给一群人」时有个止损点，
 *    而同一用户在几台设备上各取回一次不该被卡住 —— 因此默认值给到 3。
 *  - `RESTORE_FAILS_*`：同一来源 IP **连续**输错几次订单号就封 24 小时。
 *
 * ⚠️ 下限一律是 **1**：允许填 0 会让「取回」这个功能直接不可用，而界面上
 * 又没有任何开关可以表达「我确实想关掉它」—— 那是一个只能靠改配置回滚的死状态。
 */
const RESTORE_USES_MIN = 1;
const RESTORE_USES_MAX = 100;
const RESTORE_USES_DEFAULT = 3;
const RESTORE_FAILS_MIN = 1;
const RESTORE_FAILS_MAX = 50;
const RESTORE_FAILS_DEFAULT = 5;
/** 连续输错触发封禁后的封禁时长：固定 24 小时（需求 2 原文），不做成可配 */
const RESTORE_BAN_MS = 24 * 60 * 60 * 1000;
/** 「连续」的空闲重置窗口：超过这个时长没有新的失败，连击计数归零 */
const RESTORE_FAIL_IDLE_MS = 24 * 60 * 60 * 1000;

/** 通用整数入参判据（上下限 + 提示文案都由调用方给全） */
function parseIntInRange(v, min, max, label) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
    return { ok: false, error: `${label}须为数字` };
  }
  const value = Math.floor(n);
  if (value < min || value > max) {
    return { ok: false, error: `${label}须在 ${min}–${max} 之间` };
  }
  return { ok: true, value };
}

/** 校验接口入参：取回次数限制 */
function parseRestoreUsesInput(v) {
  return parseIntInRange(v, RESTORE_USES_MIN, RESTORE_USES_MAX, '取回次数限制');
}

/** 校验接口入参：连续输错次数上限 */
function parseRestoreFailsInput(v) {
  return parseIntInRange(v, RESTORE_FAILS_MIN, RESTORE_FAILS_MAX, '错误尝试次数上限');
}

module.exports = {
  LIMITS, resolveCap, HARD_MAX,
  MB, normalizeSpeedLimit, toMBps, parseSpeedLimitInput,
  CONCURRENCY_FILES_MIN, CONCURRENCY_FILES_MAX, parseConcurrencyInput,
  SMTP_PORT_DEFAULT, SMTP_PORT_MIN, SMTP_PORT_MAX, normalizeSmtpPort, parseSmtpPortInput,
  SMTP_HOST_MAX, SMTP_ADDRESS_MAX, SMTP_NAME_MAX, SMTP_PASSWORD_MAX,
  parseSmtpAddressInput, parseSmtpTextInput,
  // R54：站点设置
  SITE_NAME_MAX, SITE_NAME_DEFAULT, parseSiteNameInput,
  REGISTRATION_MODES, REGISTRATION_DEFAULT, normalizeRegistrationMode,
  DEFAULT_ROLES, DEFAULT_ROLE_FALLBACK, normalizeDefaultRole,
  // R54②：邮箱与验证码
  EMAIL_MAX, EMAIL_CODE_LEN, EMAIL_CODE_TTL_MS, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_MS,
  normalizeEmail, parseEmailInput,
  // R54③：邀请码
  INVITE_CODE_ALPHABET, INVITE_CODE_LEN, INVITE_CODE_RE,
  INVITE_BATCH_MAX, INVITE_MAX_USES_MAX, INVITE_NOTE_MAX, INVITE_USED_BY_MAX,
  normalizeInviteCode, parseInviteCodeInput, parseInviteCountInput,
  parseInviteMaxUsesInput, parseInviteExpiresInput, parseInviteNoteInput,
  // R62：优惠券
  COUPON_CODE_ALPHABET, COUPON_CODE_LEN, COUPON_CODE_RE,
  COUPON_BATCH_MAX, COUPON_NOTE_MAX, COUPON_MAX_USES_MAX, COUPON_TYPES,
  COUPON_MAX_TARGETS, COUPON_AMOUNT_MIN_FEN, COUPON_AMOUNT_MAX_FEN, COUPON_USES_MAX,
  normalizeCouponCode, normalizeCouponType,
  parseCouponCodeInput, parseCouponCountInput, parseCouponAmountInput,
  parseCouponMaxUsesInput, parseCouponTimeInput, parseCouponIdsInput, parseCouponNoteInput,
  // R65：订单取回（配置上限 + 封禁时长）
  RESTORE_USES_MIN, RESTORE_USES_MAX, RESTORE_USES_DEFAULT,
  RESTORE_FAILS_MIN, RESTORE_FAILS_MAX, RESTORE_FAILS_DEFAULT,
  RESTORE_BAN_MS, RESTORE_FAIL_IDLE_MS,
  parseRestoreUsesInput, parseRestoreFailsInput,
};
