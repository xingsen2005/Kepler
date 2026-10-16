/**
 * 路由：发信设置（SMTP）
 *  — 三条接口**全部仅管理员**（含主机 / 用户名 / 发件人，属全局配置）
 *  — 登录口令任何情况下都不出服务端：对外只有 `hasPassword` 布尔值
 *
 * R53：发信能力由 `server/smtp.js` 用 `node:net` / `node:tls` 手写，**不引入任何新依赖**
 * （对比 `nodemailer` 及其十余个传递依赖）。
 */
const { express, configStore, statsStore, smtp } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
// 入参合法性的唯一判据（与 `config-store` 的落盘归一化共用同一组上下界）
const {
  parseSmtpPortInput, parseSmtpAddressInput, parseSmtpTextInput,
  SMTP_HOST_MAX, SMTP_ADDRESS_MAX, SMTP_NAME_MAX, SMTP_PASSWORD_MAX,
} = require('../limits');

const router = express.Router();

/** 对外视图：口令退化为布尔值（与 `routes/captcha.js` 的 `providersView()` 同款规矩） */
function view() {
  return configStore.smtpView(configStore.load());
}

/** 包装 `parseSmtpTextInput`：非法一律 400，不做静默改写 */
function text(v, max, label) {
  const r = parseSmtpTextInput(v, max, label);
  if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
  return r.value;
}

/** 包装 `parseSmtpAddressInput`：非法一律 400 */
function address(v, label) {
  const r = parseSmtpAddressInput(v, label);
  if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
  return r.value;
}

/**
 * 校验并规范化提交字段 —— 语义是 **PATCH**：缺省字段保持原值。
 *
 * 口令是三态的（与验证码 `secretKey` 完全一致，见 `saveCaptcha()`）：
 *  - `null` → 显式清除；`''` 或省略 → 保持不变；其它 → 设为新值。
 *
 * ⚠️ 所有字段都必须过 CR / LF 拦截：它们会被手工拼进 SMTP 命令与信头
 * （`MAIL FROM:` / `From:` / `To:` / `Subject:`），一个换行就是一次信头注入。
 */
function readPatch(b) {
  const out = {};
  const bool = (v, label) => {
    if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') {
      throw Object.assign(new Error(`${label}须为布尔值`), { status: 400 });
    }
    return v === true || v === 'true';
  };
  if (b.enabled !== undefined) out.enabled = bool(b.enabled, '启用开关');
  if (b.host !== undefined) out.host = text(b.host, SMTP_HOST_MAX, 'SMTP 服务器地址');
  if (b.port !== undefined) {
    const r = parseSmtpPortInput(b.port);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    out.port = r.value;
  }
  if (b.secure !== undefined) out.secure = bool(b.secure, '加密方式');
  if (b.user !== undefined) out.user = text(b.user, SMTP_ADDRESS_MAX, '登录用户名');
  if (b.password !== undefined) {
    if (b.password === null) out.password = null;                 // 显式清除
    else if (b.password !== '') out.password = text(b.password, SMTP_PASSWORD_MAX, '登录密码');
  }
  if (b.from !== undefined) out.from = address(b.from, '发件人地址');
  if (b.fromName !== undefined) out.fromName = text(b.fromName, SMTP_NAME_MAX, '发件人显示名');
  return out;
}

// 查看发信设置（仅管理员；不含口令明文）
router.get('/smtp/config', requireAdmin, apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, view()));
}));

// 保存发信设置（PATCH 语义；口令留空 = 保持原值，null = 清除；仅管理员）
router.put('/smtp/config', requireAdmin, apiHandler(async (req, res) => {
  const patch = readPatch(req.body || {});
  const saved = configStore.saveSmtp(patch);
  statsStore.addLog({
    action: 'config.save', level: 'info',
    detail: `管理员「${req.authUser.username}」更新发信设置`
      + `（host=${saved.host || '未填写'}，port=${saved.port}`
      + `，${saved.secure ? '隐式 TLS' : 'STARTTLS / 明文'}`
      + `，from=${saved.from || '未填写'}，enabled=${saved.enabled}）`,
  });
  res.json(Object.assign({ ok: true }, view()));
}));

/**
 * 发送一封测试邮件（仅管理员）。
 *
 * 请求体可带**尚未保存**的字段（例如刚改的口令），按 PATCH 语义覆盖已保存配置后再发信 ——
 * 否则管理员必须「先保存、才能测试」，万一配置有误就把错的写进去了。
 *
 * `to` 留空 = 发给发件人自己。
 */
router.post('/smtp/test', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const patch = readPatch(b);
  /**
   * ⚠️ 发信取配置**只有** `smtpSendConfig()` 一个入口（含明文口令）。
   * 用对外视图 `smtpView()` 也能拿到 host / port / user，看着"能跑" ——
   * 但它的 `password` 字段是被裁掉的 `hasPassword`，口令为空 ⇒ 服务端直接
   * 判 400「已填写登录用户名但密码为空」。`email-code.js` 曾经就是误用视图，
   * 于是「配置全对却一封也发不出去」（护栏 `R53-10a`）。
   */
  const cfg = Object.assign(configStore.smtpSendConfig(), patch);
  const toRaw = (b.to === undefined || b.to === null || String(b.to).trim() === '')
    ? cfg.from
    : String(b.to).trim();
  const to = address(toRaw, '收件人地址');
  /**
   * ⚠️ 测试**不受 `enabled` 开关限制**：它是管理员显式点按钮触发的一次性动作。
   * 若加以限制，管理员就必须「先开启、才能验证」，而开启之后配置若有问题，
   * 所有依赖发信的功能都会一起受影响 —— 恰好把验证的窗口关掉了。
   */
  // R54：站点名称在发信里的两处用途（显示名兜底 + 主题前缀）共取一次
  const siteName = configStore.siteView(configStore.load()).siteName;
  const r = await smtp.sendMail({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    user: cfg.user, password: cfg.password,
    from: cfg.from,
    /**
     * R54：发件人显示名的**兜底链** —— SMTP 卡片里填了就用它，留空才退回站点名称。
     *
     * 方向刻意是「卡片优先」而不是「站点名称优先」：站点设置是全站的基础身份，
     * 而发件人显示名是**发信这件事**的呈现口径；管理员在发信设置里明确填了值，
     * 就说明他要在邮件里用那个名字（例如 `noreply@` 想显示成「某某平台通知」）。
     * 兜底只在「他没填」时生效。
     */
    fromName: cfg.fromName || siteName,
    to,
    subject: `${siteName} 发信测试`,
    text: `这是一封由 Kepler 发送的测试邮件。\n收到它，说明 SMTP 配置可以正常发信。\n\n发信时间：${new Date().toLocaleString('zh-CN')}\n`,
  });
  statsStore.addLog({
    action: 'smtp.test', level: 'info',
    detail: `管理员「${req.authUser.username}」向 ${to} 发送测试邮件成功`
      + `（加密=${r.encrypted ? '是' : '否'}，登录方式=${r.authUsed || '未登录'}）`,
  });
  res.json({ ok: true, to, encrypted: r.encrypted, authUsed: r.authUsed });
}, {
  onError: (err, req) => statsStore.addLog({
    action: 'smtp.test', level: 'warn',
    detail: `管理员「${req.authUser ? req.authUser.username : '未知'}」发送测试邮件失败：${err.message}`,
  }),
}));

module.exports = router;
