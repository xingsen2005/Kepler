/**
 * 路由公共依赖汇聚（依赖注入点）
 *
 * 所有子路由模块统一从这里 import，好处有二：
 *  1. 避免每个子模块重复 10+ 行 require，也让依赖关系一眼可见；
 *  2. 测试时可对单一模块做依赖替换，无需加载整个 express 应用。
 */
module.exports = {
  express: require('express'),
  path: require('path'),
  providers: require('../providers'),
  paymentProviders: require('../payment-providers'),
  paymentRules: require('../payment-rules'),
  paymentOrders: require('../payment-orders'),
  // R92：凭据自检（只读出网探针）与渠道图形都只在「支付设置」这一组路由里用到
  paymentGateway: require('../payment-gateway'),
  paymentLogos: require('../payment-logos'),
  security: require('../security'),
  configStore: require('../config-store'),
  statsStore: require('../stats-store'),
  uploadSessions: require('../upload-sessions'),
  shareStore: require('../share-store'),
  gitignore: require('../gitignore'),
  webdav: require('../webdav-server'),
  authSession: require('../auth-session'),
  captcha: require('../captcha'),
  webauthn: require('../webauthn'),
  smtp: require('../smtp'), // R53：零依赖 SMTP 发信客户端
  emailCode: require('../email-code'), // R54②：邮箱验证码（签发 / 核销 / 发信唯一实现点）
  inviteStore: require('../invite-store'), // R54③：邀请码（生成 / 核销 / 导出唯一实现点）
  couponStore: require('../coupon-store'), // R62：优惠券（生成 / 校验 / 核销 / 退款回退唯一实现点）
  encStore: require('../enc-store'),
  ipGuard: require('../ip-guard'),
  s3: require('../s3'),
  streamDownload: require('../download-stream').streamDownload,
};
