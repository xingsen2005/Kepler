/**
 * 路由：文件透明加密设置 + 上传排除设置 + 线程并发设置
 *  — 设置类接口仅管理员；/enc/unlock 为密码验证（限流 + 失败锁定）
 */
const { express, security, configStore, statsStore, encStore } = require('./_context');
const { requireAdmin, asyncHandler } = require('./_shared');
// R48：并发数入参合法性的唯一判据（与 config-store 的读盘归一化共用同一个上下界常量）
const { parseConcurrencyInput } = require('../limits');

const router = express.Router();

const ENC_MODE_LABEL = { none: '不加密', crypto: 'crypto（AES-256-GCM）', magic: '文件头魔数（轻量混淆）' };

/* ============================ 加密设置 ============================ */

// 查看加密设置（安全视图：不含密码哈希；仅管理员）
router.get('/enc/settings', requireAdmin, (req, res) => {
  res.json(Object.assign({ ok: true }, encStore.settingsView()));
});

/**
 * R8-14：**仅**告知「是否设置了查看密码」的最小端点，任意登录用户可读。
 *
 * 为什么不复用 `/enc/settings`：那个接口会带出 `mode` 与魔数文案（安全配置本身），
 * 对普通用户不必要。而 `passwordSet` 是必须的 —— 前端 `ensureUnlocked()` 靠它决定
 * 是否弹「加密访问密码」验证框。旧实现让非管理员把 `App.state.enc` 硬编码为
 * 「未设密码」，于是普通用户即使在管理员处拿到了查看密码也**无处输入**，
 * 点下载必然 401。
 */
router.get('/enc/status', (req, res) => {
  res.json({ ok: true, passwordSet: encStore.passwordSet() });
});

// 更新加密设置（PATCH 语义；password: ''=清除，非空=设置，缺省=保持；仅管理员）
router.put('/enc/settings', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const v = await encStore.updateSettings({ mode: b.mode, magic: b.magic, useSalt: b.useSalt, password: b.password });
    statsStore.addLog({
      action: 'enc.settings', level: 'warn',
      detail: `文件加密方式调整为「${ENC_MODE_LABEL[v.mode] || v.mode}」` +
        (v.mode === 'magic' ? `（魔数 ${v.magicText}，随机盐）` : '') +
        (v.passwordSet ? '；已设置查看密码' : ''),
    });
    res.json(Object.assign({ ok: true }, v));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 加密访问密码验证 → 签发 30 分钟查看/下载令牌（限流 + 失败锁定，防爆破）
router.post('/enc/unlock', asyncHandler(async (req, res) => {
  const ip = security.clientIp(req);
  const rl = security.encUnlockLimiter(ip);
  if (!rl.ok) {
    statsStore.addLog({ action: 'enc.unlock', level: 'warn', detail: `验证过于频繁已限流（IP：${ip}）` });
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
  }
  const lockedLeft = security.encUnlockLock.locked(ip);
  if (lockedLeft > 0) {
    return res.status(429).json({ error: `失败次数过多，请 ${lockedLeft} 秒后重试` });
  }

  const pw = String((req.body || {}).password || '');
  if (!(await encStore.checkPassword(pw))) {
    const left = security.encUnlockLock.fail(ip);
    statsStore.addLog({ action: 'enc.unlock', level: 'warn', detail: '加密访问密码验证失败' });
    if (left > 0) return res.status(429).json({ error: `失败次数过多，请 ${left} 秒后重试` });
    return res.status(403).json({ error: '密码不正确' });
  }
  security.encUnlockLock.reset(ip);
  const t = encStore.issueToken();
  statsStore.addLog({ action: 'enc.unlock', detail: '加密访问密码验证通过（签发 30 分钟令牌）' });
  res.json({ ok: true, token: t.token, expiresIn: t.expiresIn });
}));

/* ============================ 上传排除设置 ============================ */

// 查看上传排除设置（仅管理员）
router.get('/upload-excludes', requireAdmin, (req, res) => {
  res.json(configStore.getUploadExcludes());
});

// 更新上传排除设置（PATCH 语义，缺省字段保持原值；仅管理员）
router.put('/upload-excludes', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['dsStore', 'thumbsDb', 'gitignore']) {
      if (b[k] !== undefined) patch[k] = Boolean(b[k]);
    }
    const v = configStore.setUploadExcludes(patch);
    statsStore.addLog({
      action: 'upload-excludes.save', level: 'info',
      detail: `更新上传排除设置（.DS_Store=${v.dsStore}，Thumbs.db=${v.thumbsDb}，.gitignore=${v.gitignore}）`,
    });
    res.json(v);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 线程并发设置（R48） ============================ */

/**
 * 更新「线程并发」—— 同时上传 / 加密的文件数（最小 1）（仅管理员）。
 *
 * 为什么**只有写接口**，读走 `GET /config`：并发数要对**所有登录用户**可见
 * （普通用户也要上传，前端调度必须知道上限），而 `safeView()` 已经把
 * `concurrency` 下发给每一个角色。若此处再开一个 GET，就出现了第二个读取口径 ——
 * 「同一份状态两个读入口」正是本项目反复吃亏的地方（改一处漏一处，两边慢慢分叉）。
 *
 * 写入是管理员专属：它决定服务端同时起多少个加密工作线程（`server/enc-pool.js`），
 * 直接关系到整机的 CPU 与内存占用，属系统级配置。普通用户的并发由这一份配置统一
 * 约束（前端 `uploadPlan()` 同源读取），不需要也不应该各有各的上限。
 */
router.put('/concurrency', requireAdmin, (req, res) => {
  try {
    const r = parseConcurrencyInput((req.body || {}).files);
    if (!r.ok) return res.status(400).json({ error: r.error });
    const v = configStore.setConcurrency({ files: r.value });
    statsStore.addLog({
      action: 'concurrency.save', level: 'info',
      detail: `管理员「${req.authUser.username}」将同时上传 / 加密的文件数设为 ${v.files}`,
    });
    res.json(v);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
