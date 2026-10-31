/**
 * 密钥管理路由（R97）—— 解锁 / 迁移 / 轮转
 *
 * 四条接口，权限分成两档：
 *
 * | 方法与路径 | 谁能调 | 为什么 |
 * |---|---|---|
 * | `GET  /key/status`        | 匿名 | 锁定态下前端**还没有会话可用**，必须能先问"要不要解锁" |
 * | `POST /key/unlock`        | 匿名 | 同上 —— 解锁本身就是"拿到会话之前"的动作 |
 * | `POST /key/migrate`       | 根用户 | 建立信封、删除明文密钥，一次性但影响全局 |
 * | `POST /key/rotate-login`  | 根用户 | 改解锁因子，等同改根口令 |
 *
 * 前两条列进 `server/index.js` 的 `PUBLIC_API`，否则会被鉴权挡在门外（锁定态下
 * 没有人能登录，也就永远解锁不了 —— 死锁）。它们的暴露面由**限流 + 失败锁定**约束，
 * 见 `security.keyUnlockLimiter` / `security.keyUnlockLock`。
 *
 * ⚠️ 一条容易想当然的地方：`/key/unlock` 成功**不签发会话**。解锁只解决"进程能不能
 * 解密数据"，登录是另一件事（要用户名 + 口令，走 `/auth/login`）。把两者混起来
 * 会让"解锁"变成一条免登录通道。
 */
const express = require('express');

const security = require('../security');
const statsStore = require('../stats-store');
const keyring = require('../keyring');
const keyRotate = require('../key-rotate');
const authSession = require('../auth-session');
const { requireRoot } = require('./_shared');

const router = express.Router();

/** 审计（失败也不影响响应 —— 审计写不下不该让解锁失败） */
function audit(action, level, detail) {
  try {
    statsStore.addLog({ action, level, detail });
  } catch (e) {
    console.error('[key-routes] 审计日志写入失败：', (e && e.message) || e);
  }
}

/**
 * 密钥状态。
 *
 * 分级下发：匿名调用者只拿"要不要解锁"这一个布尔组合 —— 足够前端渲染解锁页，
 * 但不告诉他这个实例有没有旧明文密钥文件（那等于给攻击者报出"去偷哪个文件"）。
 * 带有效会话的调用者才拿到版本号与时间（密钥卡片要显示"上次轮转于…"）。
 *
 * 会话在这里**手动**取，不经 `/api` 鉴权中间件 —— 因为本路径在 `PUBLIC_API` 里，
 * 中间件会直接放行。取不到就是匿名，逻辑与中间件完全一致（`parseToken` +
 * `getSession` 是会话判定的唯一实现点，这里没有另写一套判据）。
 */
router.get('/key/status', (req, res) => {
  try {
    const st = keyRotate.status();
    const token = authSession.parseToken(req);
    const authed = Boolean(token && authSession.getSession(token));
    if (!authed) {
      return res.json({ envelope: st.envelope, locked: st.locked, unlocked: st.unlocked });
    }
    return res.json(st);
  } catch (e) {
    // 容器坏了（格式不认识）也要让前端知道"这里出问题了"，而不是 500 后一片空白
    return res.status(500).json({
      error: (e && e.message) || '读取密钥状态失败',
      code: (e && e.code) || 'KEYRING_STATUS_FAILED',
      locked: false,
    });
  }
});

/**
 * 解锁。
 *
 * 三道闸，顺序不能换：**限流 → 失败锁 → 校验**。
 * 把校验放前面就等于每次请求都先付一次 scrypt，限流失去意义（CPU 已经花掉了）。
 */
router.post('/key/unlock', async (req, res) => {
  const ip = security.clientIp(req) || 'unknown';
  try {
    const rl = security.keyUnlockLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    const lockedLeft = security.keyUnlockLock.locked(ip);
    if (lockedLeft > 0) {
      res.setHeader('Retry-After', String(lockedLeft));
      return res.status(429).json({ error: `失败次数过多，请 ${lockedLeft} 秒后重试` });
    }

    const passphrase = String((req.body && req.body.passphrase) || '');
    if (!passphrase) return res.status(400).json({ error: '主口令不能为空' });

    const info = await keyring.unlock(passphrase);
    security.keyUnlockLock.reset(ip);
    audit('key.unlock', 'info', `主密钥已解锁（kekVersion=${info.kekVersion}，IP：${ip}）`);
    return res.json({ ok: true, kekVersion: info.kekVersion, unlocked: true });
  } catch (e) {
    /**
     * 口令错：记账 + 回 401。**不区分**"口令错"与"容器坏"的对外文案 ——
     * 后者由 `corrupt` 错误自带 500，前端能看到需要运维介入的信号；
     * 而这层只负责把可重试的失败计进锁定器。
     */
    if (e && e.code === 'KEYRING_BAD_PASSPHRASE') {
      const left = security.keyUnlockLock.fail(ip);
      audit('key.unlock', 'warn', `主密钥解锁失败：口令不正确（IP：${ip}）`);
      res.setHeader('Retry-After', String(left || 60));
      return res.status(401).json({
        error: left > 0 ? `主口令不正确，已临时锁定 ${left} 秒` : '主口令不正确',
        left: left || 0,
      });
    }
    const status = (e && e.status) || 500;
    if (status >= 500) console.error('[key-routes] unlock:', e);
    return res.status(status).json({ error: (e && e.message) || '解锁失败' });
  }
});

/**
 * 迁移到信封加密（一次性）。
 *
 * 需要根用户会话 + 根口令（`migrate()` 内部会 `verifyUserPassword`）。
 * 迁移完成后 `secret.key` 默认被删除，`/key/status` 的 `legacyKeyPresent` 变 false。
 */
router.post('/key/migrate', requireRoot, async (req, res) => {
  const ip = security.clientIp(req) || 'unknown';
  try {
    const rl = security.keyRotateLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    const passphrase = String((req.body && req.body.passphrase) || '');
    if (!passphrase) return res.status(400).json({ error: '请输入当前根口令' });
    const r = await keyRotate.migrate(passphrase, {
      keepLegacyKey: Boolean(req.body && req.body.keepLegacyKey),
    });
    return res.json(r);
  } catch (e) {
    const status = (e && e.status) || 500;
    if (status >= 500) console.error('[key-routes] migrate:', e);
    return res.status(status).json({
      error: (e && e.message) || '迁移失败',
      code: (e && e.code) || undefined,
    });
  }
});

/**
 * 轮转登录密钥（= 改根口令 + 重裹 DEK）。
 *
 * 成功后全部会话失效 —— 响应必须能正常返回，否则前端拿不到"已被踢下线"的信号，
 * 只会看到下一个请求 401 然后莫名其妙。所以会话清理放在 `rotateLogin()` 里
 * **返回之前**做，本层不额外销毁自己的会话。
 */
router.post('/key/rotate-login', requireRoot, async (req, res) => {
  const ip = security.clientIp(req) || 'unknown';
  try {
    const rl = security.keyRotateLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    const body = req.body || {};
    const currentPassphrase = String(body.currentPassphrase || '');
    const newPassphrase = String(body.newPassphrase || '');
    if (!currentPassphrase) return res.status(400).json({ error: '请输入当前主口令' });
    if (!newPassphrase) return res.status(400).json({ error: '请输入新主口令' });

    const r = await keyRotate.rotateLogin({
      currentPassphrase,
      newPassphrase,
      actor: (req.authUser && req.authUser.username) || '',
    });
    return res.json(Object.assign({ ok: true }, r));
  } catch (e) {
    const status = (e && e.status) || 500;
    if (status >= 500) console.error('[key-routes] rotate:', e);
    return res.status(status).json({
      error: (e && e.message) || '轮转失败',
      code: (e && e.code) || undefined,
    });
  }
});

module.exports = router;
