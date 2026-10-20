/**
 * API 路由聚合器
 *
 * 原先本文件承载全部 REST API（约 2200 行）。现按领域拆分为 `server/routes/` 下的子模块，
 * 本文件只负责「按正确顺序挂载」，便于定位与维护：
 *
 *   routes/_context.js  依赖汇聚（所有子模块共用）
 *   routes/_shared.js   共享工具与中间件（requireAdmin / requireConfig / 桶统计 / 排除规则…）
 *   routes/auth.js      登录认证（匿名白名单）+ Windows Hello 第二步验签
 *   routes/users.js     用户管理（仅管理员）+ 普通用户自助改资料
 *   routes/captcha.js   验证码服务配置
 *   routes/payment.js   支付平台凭证配置（仅基础配置与合法性校验，不含支付业务）
 *   routes/webauthn.js  Windows Hello（WebAuthn）凭据注册与关闭
 *   routes/config.js    系统配置 / 访问密钥 / 连接验证
 *   routes/buckets.js   存储桶管理 / 容量统计 / 清空销毁 / ACL 检查
 *   routes/ipguard.js   IP 访问屏蔽（全局 + 桶级）
 *   routes/throttle.js  下载限速的「上层下限」查询（R37，设置入口的提示文案用）
 *   routes/backup.js    配置备份（R38，实时码 / 导出 / 导入，全部仅管理员）
 *   routes/enc.js       文件加密设置 / 上传排除设置
 *   routes/webdav.js    WebDAV 服务设置
 *   routes/smtp.js      发信设置（SMTP，仅管理员；含测试邮件）
 *   routes/site.js      站点设置（R54：站点名称 / 公开注册 / 新用户身份；含公开的 /site/info）
 *   routes/agreements.js 协议设置（R68：两份协议正文；含公开的 /site/agreements）
 *   routes/invite.js    邀请码设置（R54③：批量生成 / 设置 / 删除 / 导出 txt，全部仅管理员）
 *   routes/links.js     分享链接管理
 *   routes/fs.js        文件系统（列表 / 上传 / 下载 / 重命名 / 移动 / 删除）
 *   routes/stats.js     监控统计 + 健康检查
 *
 * ⚠️ 挂载顺序约束（与拆分前保持一致，勿随意调整）：
 *  1. `/captcha/public` 必须在鉴权白名单内 —— 已在 index.js 的 PUBLIC_API 中声明；
 *  2. `/credentials/visibility` 与 `/credentials/:id` 由同一模块注册，顺序天然正确；
 *  3. `/buckets/local/:id/*` 各子路径分属不同模块，但互不冲突（路径前缀不同）；
 *  4. 分享链接 `/links` 早于文件系统注册，避免路径歧义；
 *  5. webauthn 模块须在 users 之后挂载 —— 它注册 `/users/:id/webauthn/disable`，
 *     路径更长更具体，Express 按声明顺序匹配，放在 users 之后可确保
 *     `/users/:id` PUT/DELETE 优先命中而不会被本模块的更长路径干扰。
 */
const express = require('express');

const router = express.Router();

router.use(require('./routes/auth'));
router.use(require('./routes/users'));
router.use(require('./routes/captcha'));
router.use(require('./routes/payment'));
router.use(require('./routes/webauthn'));
router.use(require('./routes/config'));
router.use(require('./routes/buckets'));
router.use(require('./routes/ipguard'));
// R37：下载限速的只读查询（`GET /throttle/ceiling`）。挂在这里只是就近 ——
// 它不注册任何参数路由，与前后模块不存在路径歧义。
// 不挂 requireAdmin：普通用户在「创建分享链接」时要能看到自己被上层限到多少。
router.use(require('./routes/throttle'));
// R38：配置备份（4 条，全部 requireAdmin —— 实时导出码含密钥明文，见 routes/backup.js）
router.use(require('./routes/backup'));
router.use(require('./routes/enc'));
router.use(require('./routes/webdav'));
router.use(require('./routes/smtp'));
// R54：站点设置。`GET /site/info` 已登记进 index.js 的 PUBLIC_API（登录页要用站点名称设标题）；
// 挂在 users 之后 ⇒ 不影响 `/users/me` 的注册下标（tests/routes-surface.test.js 有硬编码）。
router.use(require('./routes/site'));
// R68：协议设置（4 条）。`GET /site/agreements` 已登记进 index.js 的 PUBLIC_API
//（登录页在拿到会话之前就要显示协议提示）；其余三条仅管理员。
// 挂在 site 之后只是**就近** —— 它注册的是 `/agreements/*` 与一个 `/site/agreements` 字面量，
// 与前后模块都不存在路径歧义（站点设置的另外两条也是字面量路径，没有 `:id`）。
router.use(require('./routes/agreements'));
// R65：订单取回设置（2 条，全部 requireAdmin）。只注册 `/restore/config`，
// 与前后模块无路径歧义；**刻意不放进 `/site/*`** —— 站点设置讲的是「站点是谁」，
// 这份设置讲的是「取回这条路径的护栏」，两者的权限与变更理由都不同。
router.use(require('./routes/restore'));
// R54③：邀请码设置（6 条，全部 requireAdmin）。挂在 links 之前只是**就近**：
// 它只注册 `/invites*`，与前后模块不存在路径歧义。
// ⚠️ 模块内的顺序有语义 —— `/invites/bulk` / `/invites/delete` / `/invites/export`
// 三个字面量路径必须排在 `PUT /invites/:id` 之前（见该文件末尾的说明）。
router.use(require('./routes/invite'));
// R62：优惠券设置（5 条，全部 requireAdmin）。与 invites 相邻，只注册 `/coupons*`。
// ⚠️ `/coupons/bulk` / `/coupons/delete` 两条字面量路径必须排在 `PUT /coupons/:id` 之前。
router.use(require('./routes/coupon'));
router.use(require('./routes/links'));
router.use(require('./routes/fs'));
router.use(require('./routes/stats'));

module.exports = router;
