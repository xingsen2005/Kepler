/**
 * 路由：用户管理
 *
 * 权限模型（三层，R71）：
 *  0. **根用户**（`root`）：系统部署完成后创建的第一个账户，角色**不可授予、不可撤销**。
 *     可对任意用户（含管理员与其他根用户）执行增删改、封禁、强制登出。
 *  1. **管理员**（`admin`）：可查看全部用户，但**只能管理普通用户** —— 对管理员与
 *     根用户的编辑 / 删除 / 封禁 / 强制登出一律 403。也不能创建管理员、不能调整角色
 *     （「改角色」= 授予角色，等价于「添加管理员」）。
 *  2. **普通用户**：仅能查看与修改**自己**的资料（用户名 / 密码 / 邮箱）。
 *     - `GET /users` 对普通用户只返回自己一条记录，不泄露其他账户信息；
 *     - 修改他人、调整角色、新建/删除用户一律 403。
 *
 * 前端隐藏入口只是第一层，本模块的接口层校验才是真正的边界。两层边界**必须分开写**：
 * `requireAdmin`（能不能用「用户管理」这个功能）与 `assertCanManageUser`（能管谁）。
 * 旧实现只有前者，于是「管理员」这个角色既表示「能进用户管理」，又隐含「能管任何人」——
 * 管理员之间可以互相删除的越权漏洞正是由此而来。
 */
const { express, configStore, statsStore, authSession, emailCode, security, shareStore } = require('./_context');
/**
 * R71：**「谁能管谁」的唯一接口层判定点** —— R78 起实现搬到 `_shared.js`。
 *
 * 搬家的原因：代用户关闭 Windows Hello 与「重置密码」是同一档运维能力，
 * 必须共用同一条判据；而它此前只住在 users.js 里，`routes/webauthn.js` 那条
 * `POST /users/:id/webauthn/disable` 因此一直只挂 `requireAdmin`（管理员可以
 * 静默拆掉根用户的二因素）。判据只能有一份实现，谁需要谁引。
 */
const { requireAdmin, sendError, denyIfCannotManage } = require('./_shared');
/**
 * R71：角色语义的唯一事实源。本文件**不得**再出现 `role === 'admin'` 这类字面量比较 ——
 * 越权判据一旦散在多个 if 里，漏掉任何一处（例如新加的「强制登出」）都不会报错，
 * 只会让加固看起来已经生效。
 */
const roles = require('../roles');
// R37：限速入参合法性的唯一判据（与配额同款——非法值必须 400，不能被归一化成 0 = 不限速）
// R54②：邮箱的入参判据与归一化（`normalizeEmail` 与 `config-store` 落盘兜底同源）
const { parseSpeedLimitInput, parseEmailInput, normalizeEmail, EMAIL_CODE_RESEND_MS } = require('../limits');
/**
 * R98：注销的**政策与执行**收口在 `account-deletion.js`（15 天冷静期、连带清理、
 * 到期清扫）。本模块只负责「谁在什么时候可以申请 / 撤销」，不自己算日期、不自己删账户 ——
 * 否则登录路径与后台清扫会各自维护一份"什么算到期"。
 */
const accountDeletion = require('../account-deletion');

const router = express.Router();

function isAdmin(req) {
  // R71：「管理层」= 管理员或根用户（根用户继承管理员的全部能力）
  return Boolean(req.authUser && roles.isStaff(req.authUser.role));
}

/**
 * 目标用户的**实时**记录（角色只信存储，不信请求体）。
 * 不存在时已回写 404，调用方直接 `return`。
 */
function loadTargetUser(req, res) {
  const target = configStore.getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return null;
  }
  return target;
}

/**
 * R69 / L-7：**`permissions` 是保留字段，不参与任何鉴权判断**。
 *
 * 现状：全库只有 `role` 会进 `requireAdmin` / `bucketsFor` / `credentialsFor` 的判据；
 * `permissions` 一路被存下来、回显、并在编辑用户时写审计日志「更新权限」，但**没有
 * 任何一处读它**。结果是：管理员在接口上写 `permissions` 会得到「更新成功」，
 * 而那个权限其实一点作用都没有 —— 这是一条**错误的安全预期**，比缺功能更危险
 * （有人会以为自己已经把某个用户限制住了）。
 *
 * 对外只有两个诚实的选择：服务端落地细粒度 RBAC，或者**明确拒绝**非空 `permissions`。
 * 落地 RBAC 需要一张权限表 + 每个路由的判据，属于功能扩建；本轮按「宁可拒绝、
 * 不可假装」处理：非空即 400 并指路 `role`。空对象 `{}` 是历史默认值，放行以兼容
 * 既有调用方（前端从不发送该字段）。
 */
function rejectUnsupportedPermissions(permissions) {
  if (permissions === undefined || permissions === null) return null;
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    return 'permissions 字段必须是不参与鉴权的保留字段（当前版本不支持，请留空）';
  }
  if (Object.keys(permissions).length === 0) return null;
  return '当前版本不支持细粒度 permissions：该字段不参与任何授权判断，'
    + '设置后不会生效。请改用「角色」（管理员 / 普通用户）控制访问范围。';
}

/* ============================ 自助资料（所有登录用户） ============================ */

// 当前用户资料（等价于 /auth/me 的 user 字段，但语义上归属"我的资料"）
router.get('/users/me', (req, res) => {
  const me = req.authUser;
  if (!me) return res.status(401).json({ error: '请先登录' });
  // FUN-12：只回传安全视图（userView），绝不回退到 getUserById() 的原始记录
  // —— 原始记录含 passwordHash / passwordSalt / webauthn.publicKey。
  const u = configStore.listUsers().find((x) => x.id === me.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: u });
});

/**
 * 修改自己的资料：**仅允许用户名与密码**。
 *
 * 明确不接受 role / permissions —— 普通用户不得自行提权，管理员调整自己的角色
 * 也应走 `/users/:id`（那里有"至少保留一个管理员"的保护逻辑）。
 */
router.put('/users/me', async (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });
    const b = req.body || {};

    const patch = {};
    /**
     * R21-09 + R54② + R90：哪些改动需要**二次确认当前密码**。
     *
     * 用户名、密码、邮箱三者都能通向「永久接管账户」，因此同款处理：
     *  · 改密 —— R21-09 的理由：会话一旦被劫持（XSS、共享机器未登出、Cookie 泄露），
     *    攻击者可以直接改密，把真正的 owner 锁在外面，**"拿到会话"直接升级为
     *    "永久接管账户"**；
     *  · 改邮箱 —— 邮箱是「忘记密码」的**收件渠道**。攻击者只要换成自己的邮箱，
     *    就能走「忘记密码」把账户永久接管，而**验证码对此毫无帮助**（收件箱本来
     *    就在他手上）。所以"通过验证码"证明的是"这个地址归我"，**证明不了"是我"**；
     *    证明"是我"的仍然是当前密码。两者缺一不可。
     *  · 改用户名 —— R90：它是登录凭据的另一半，改掉之后真实所有者**连登录都进不去**，
     *    详见下方那段注释。
     */
    let needsCurrent = false;
    /** 邮箱确实发生了变化（用于日志，以及"成功后核销验证码"） */
    let emailChanged = false;
    /** R98：昵称是否出现在本次提交里（用于日志；昵称无验证码可核销） */
    let nicknameChanged = false;

    /**
     * R90：**改用户名同样要当前密码**。
     *
     * 旧实现只对「密码 / 邮箱」要求 `currentPassword`，用户名被漏掉了 —— 而用户名
     * 是**登录凭据的另一半**：会话劫持者把它改掉之后，真实所有者用惯用的用户名
     * 直接**登不进来**（提示「用户名或密码错误」），受害者的第一反应是「我记错密码了」，
     * 于是不断重试、走「忘记密码」—— 而找回邮件只会发到（可能也被改掉的）邮箱。
     * 这是与改密同级的**永久接管**路径，且绕过成本更低（不需要知道旧密码）。
     *
     * 与邮箱那一条的区别：邮箱要**两把钥匙**（验证码证明"地址归我" + 当前密码证明"是我"），
     * 用户名没有可验证的"归属"对象，因此只要当前密码这一把 —— 但必须有。
     * 提交值与原值相同时**不算改动**（表单每次都会把原值带上来）。
     */
    if (b.username !== undefined) {
      if (String(b.username) !== String(me.username)) needsCurrent = true;
      patch.username = b.username;
    }

    if (b.password !== undefined && b.password !== '') {
      if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password)) {
        return res.status(400).json({ error: '两次输入的密码不一致' });
      }
      patch.password = b.password;
      needsCurrent = true;
    }

    // R54②：邮箱（需求 2.3 补填 / 2.4 修改）
    if (b.email !== undefined) {
      const rawMe = configStore.findUserRawById(me.id);
      const currentEmail = normalizeEmail(rawMe && rawMe.email);
      const mail = normalizeEmail(b.email);
      /**
       * 与现状相同 ⇒ 视为**没改**。
       *
       * 界面上用户没动这个字段时，表单也会把原值原样提交；若把它当成"要换绑"，
       * 就会要求用户为一个自己没做过的操作去收验证码、输当前密码。
       */
      if (mail !== currentEmail) {
        if (mail) {
          const code = String(b.emailCode == null ? '' : b.emailCode).trim();
          if (!code) return res.status(400).json({ error: '请先获取并填写新邮箱收到的验证码' });
          const r = emailCode.check({ purpose: 'verify', email: mail, code });
          if (!r.ok) {
            statsStore.addLog({
              action: 'users.self-update', level: 'warn',
              detail: `用户「${me.username}」修改邮箱失败（验证码不通过：${r.reason}）`,
            });
            return res.status(400).json({ error: emailCode.CODE_FAIL_TEXT });
          }
        }
        /**
         * `mail === ''` 是**合法值**：解绑。它不要验证码 —— 解绑是**收紧**（把找回
         * 密码的渠道主动摘掉）而不是放松 —— 但仍要当前密码（见下）：否则劫持者
         * 可以先把 owner 的邮箱摘掉，让他连"忘记密码"都走不了。
         */
        patch.email = mail;
        emailChanged = true;
        needsCurrent = true;
      }
    }

    /**
     * R98：昵称（展示名）。
     *
     * **不要求当前密码**，也不要验证码 —— 它与登录凭据无关，改了也不会让任何人
     * 更容易接管账户；它唯一的影响是界面上显示的名字。反过来，若把它也纳入
     * "需二次确认"那一档，用户每次想换个显示名都得输密码，属于无谓的摩擦。
     *
     * 入参在这里先按**码点**判长度：`updateUser` 里的归一化会静默截断，
     * 而"提交了 100 个字、存下来 32 个"是一次**假成功**（用户以为改成功了）。
     * 判据与存储层共用同一个上限常量，避免两处各写一个数字。
     */
    if (b.nickname !== undefined) {
      const rawNick = String(b.nickname == null ? '' : b.nickname);
      if (Array.from(rawNick).length > configStore.NICKNAME_MAX) {
        return res.status(400).json({ error: `昵称最长 ${configStore.NICKNAME_MAX} 个字符` });
      }
      patch.nickname = rawNick;
      nicknameChanged = true;
    }

    if (needsCurrent) {
      /**
       * R87：本端点会做一次**口令哈希校验**，必须按 IP 限流。
       *
       * `configStore.verifyUserPassword` 是 scrypt（N=131072），单次约几十到上百毫秒
       * CPU。此前这条路径**没有任何 limiter**（SEC-05 只给 `routes/webauthn.js` 挂了
       * `passwordLimiter`），于是有两重后果：
       *  ① 任何登录用户并发提交即可拖死进程内**全部** scrypt 路径（登录 / WebDAV / 备份）；
       *  ② 会话被劫持者可以无限速地爆破 `currentPassword`，通过后改密码 + 改邮箱，
       *     把真实所有者永久锁在门外 —— 这一步本应被「知道当前密码」挡住。
       * 限流键与 webauthn 那条**刻意分开**（`users-me:` 前缀）：两个端点的预算互不挤占。
       */
      const ip = security.clientIp(req) || 'unknown';
      const rl = security.passwordLimiter('users-me:' + ip);
      if (!rl.ok) {
        res.setHeader('Retry-After', String(rl.retryAfter));
        return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
      }
      // 校验走 `configStore.verifyUserPassword`（与登录、WebDAV 认证共用的同一份
      // scrypt 校验实现，不另写一套比较）。
      const current = String(b.currentPassword == null ? '' : b.currentPassword);
      if (!current) {
        return res.status(400).json({ error: '请输入当前密码以确认身份', needCurrentPassword: true });
      }
      if (!(await configStore.verifyUserPassword(me.id, current))) {
        statsStore.addLog({ action: 'users.self-update', level: 'warn', detail: `用户「${me.username}」自助变更（用户名 / 密码 / 邮箱）：当前密码校验失败` });
        return res.status(403).json({ error: '当前密码不正确' });
      }
    }

    // 显式拒绝越权字段，避免"默默忽略"造成的语义误解
    if (b.role !== undefined) return res.status(403).json({ error: '不能修改自己的角色' });
    if (b.permissions !== undefined) return res.status(403).json({ error: '不能修改自己的权限' });
    // R37：下载限速属于「被强制执行的限额」，由管理员在用户管理中设定。
    // 若允许用户自行修改，就等于给受限方一个「解除限制」按钮（与配额自绕过同一个问题）。
    if (b.speedLimit !== undefined) return res.status(403).json({ error: '不能修改自己的下载限速' });

    const user = await configStore.updateUser(me.id, patch);
    /**
     * 邮箱**落库成功之后**才核销验证码（与 `/auth/reset` 同一顺序，理由见其注释）：
     * 先核销的话，落库若因"该邮箱已被其他账户使用"（409）失败，用户就得重新收一封信，
     * 而这一轮里其实什么都没变。
     */
    if (emailChanged && patch.email) emailCode.consume({ purpose: 'verify', email: patch.email });

    // 用户名为登录凭据的一部分：改名后强制该账户全部会话失效，要求重新登录，
    // 避免旧会话里缓存的旧用户名与新凭据不一致。
    if (patch.username && patch.username !== me.username) {
      authSession.destroyUserSessions(me.id);
      const parts = ['修改用户名'];
      if (patch.password) parts.push('修改密码');
      if (emailChanged) parts.push(patch.email ? '修改邮箱' : '解绑邮箱');
      if (nicknameChanged) parts.push('修改昵称');
      statsStore.addLog({ action: 'users.self-update', level: 'warn', detail: `用户「${me.username}」${parts.join('并')}，已强制重新登录` });
      return res.json({ ok: true, user, reauthRequired: true });
    }

    const parts = [];
    if (patch.username) parts.push('修改用户名');
    if (patch.password) parts.push('修改密码');
    if (emailChanged) parts.push(patch.email ? '修改邮箱' : '解绑邮箱');
    if (nicknameChanged) parts.push('修改昵称');
    // SEC-02 同理：改密码后**其它设备**的会话必须立即失效（防「密码已改但仍被旧会话控制」），
    // 当前这台设备保留，避免用户改完密码立刻掉线。
    if (patch.password) {
      authSession.destroyUserSessionsExcept(me.id, req.sessionToken);
    }
    statsStore.addLog({ action: 'users.self-update', detail: `用户「${me.username}」更新了自己的资料（${parts.join('，') || '无变更'}）` });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/* ======================== 注销账户（R98，15 天冷静期） ======================== */

/**
 * 自助注销的三条接口。
 *
 * 分工刻意与「改邮箱」不同：改邮箱是**换一个收件渠道**，注销是**把账户整个删掉**。
 * 所以：
 *  ① 验证码发往**已绑定**的邮箱（不是用户临时输入的地址）—— 注销要证明的是
 *     "我是这个账户的主人"，而不是"我能收到某个地址的信"；
 *  ② 验证码用途独立（`delete`），不能拿"改邮箱"那枚码来注销，反之亦然；
 *  ③ 申请提交后**不立即删**，而是进入 15 天冷静期；期间**登录即撤销**（见 auth.js
 *     的 `completeLogin`）—— 这条是给"账户被盗后被人恶意注销"留的救济通道。
 */

/**
 * 发送注销验证码（发往当前绑定邮箱）。
 *
 * 限流**复用** `/auth/email/code` 的那两个实例（同一 IP / 同一用户共享预算）：
 * 若各开一套，"每用户每天能收几封信"就有了两条独立通道，日配额形同虚设 ——
 * 而这两条通道烧的是同一个 SMTP 账号。
 */
router.post('/users/me/deletion/code', async (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });
    const raw = configStore.findUserRawById(me.id);
    if (!raw) return res.status(404).json({ error: '用户不存在' });
    if (roles.isRoot(raw.role)) {
      return res.status(403).json({ error: '根用户账户不可注销' });
    }
    if (configStore.userView(raw).deletion) {
      return res.status(409).json({ error: '已提交过注销申请，请先撤销或等待到期' });
    }
    const mail = normalizeEmail(raw.email);
    if (!mail) {
      // 没有邮箱 = 没有验证途径。这里必须明说"先去绑定邮箱"，而不是发一封不可能的邮件
      return res.status(400).json({ error: '请先绑定并验证邮箱，再申请注销' });
    }

    const ip = security.clientIp(req) || 'unknown';
    const rl = security.emailCodeLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `请求过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    const url = security.emailCodeUserLimiter('u:' + me.id);
    if (!url.ok) {
      res.setHeader('Retry-After', String(url.retryAfter));
      return res.status(429).json({ error: `该账户近期请求的邮箱验证码过多，请 ${url.retryAfter} 秒后重试` });
    }

    const r = await emailCode.sendCode({ purpose: 'delete', email: mail, username: raw.username });
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: `请求过于频繁，请 ${r.retryAfter} 秒后重试` });
    }
    statsStore.addLog({ action: 'users.deletion.request', detail: `已向「${mail}」发送注销验证码（用户：${raw.username}）` });
    res.json({ ok: true, to: mail, resendAfter: Math.round(EMAIL_CODE_RESEND_MS / 1000) });
  } catch (e) {
    sendError(res, e);
  }
});

/** 提交注销申请：验证码通过后写入计划删除时刻（15 天后） */
router.post('/users/me/deletion', async (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });
    const raw = configStore.findUserRawById(me.id);
    if (!raw) return res.status(404).json({ error: '用户不存在' });
    if (roles.isRoot(raw.role)) {
      return res.status(403).json({ error: '根用户账户不可注销' });
    }
    const mail = normalizeEmail(raw.email);
    if (!mail) return res.status(400).json({ error: '请先绑定并验证邮箱，再申请注销' });
    /**
     * 已有申请 ⇒ 409，且**排在验证码校验之前**。
     *
     * 顺序很重要：先验码的话，"已经提交过"的人拿一枚过期码来重提会得到
     * 「验证码不通过」—— 他会以为是邮件出了问题，去重发、去重试，而真相是
     * 申请早已生效。更糟的是每次都白白消耗一次尝试次数。
     */
    if (configStore.userView(raw).deletion) {
      return res.status(409).json({ error: '已提交过注销申请，请先撤销或等待到期' });
    }

    const code = String((req.body || {}).code == null ? '' : (req.body || {}).code).trim();
    if (!code) return res.status(400).json({ error: '请填写邮箱收到的验证码' });
    const check = emailCode.check({ purpose: 'delete', email: mail, code });
    if (!check.ok) {
      statsStore.addLog({
        action: 'users.deletion.request', level: 'warn',
        detail: `用户「${raw.username}」提交注销申请失败（验证码不通过：${check.reason}）`,
      });
      return res.status(400).json({ error: emailCode.CODE_FAIL_TEXT });
    }

    const user = configStore.requestAccountDeletion(me.id, accountDeletion.deletionDueAt());
    // 落库成功之后才核销（与改邮箱同一顺序：失败时不该让用户再收一封信）
    emailCode.consume({ purpose: 'delete', email: mail });
    statsStore.addLog({
      action: 'users.deletion.request', level: 'warn',
      detail: `用户「${raw.username}」申请注销账户，将于 ${user.deletion.deleteAt} 自动删除（期间登录即撤销）`,
    });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 撤销注销申请。
 *
 * 登录成功时也会自动撤销（`completeLogin`），这条接口是给"正登录着、想立刻反悔"
 * 的人用的 —— 否则他得先退出再登录一次，而"退出"在某些单点登录部署下并不容易。
 */
router.delete('/users/me/deletion', (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });
    if (!configStore.cancelAccountDeletion(me.id)) {
      return res.status(404).json({ error: '当前没有待撤销的注销申请' });
    }
    statsStore.addLog({ action: 'users.deletion.cancel', level: 'warn', detail: `用户「${me.username}」撤销了注销申请` });
    const raw = configStore.findUserRawById(me.id);
    res.json({ ok: true, user: raw ? configStore.userView(raw) : null });
  } catch (e) {
    sendError(res, e);
  }
});

/* ============================ 用户列表 ============================ */

// 用户列表：管理员看到全部；普通用户只看到自己（避免枚举其他账户）
router.get('/users', (req, res) => {
  const me = req.authUser;
  if (!me) return res.status(401).json({ error: '请先登录' });
  const all = configStore.listUsers();
  if (isAdmin(req)) return res.json({ users: all, scope: 'all' });
  res.json({ users: all.filter((u) => u.id === me.id), scope: 'self' });
});

/* ============================ 管理员专用 ============================ */

// 新增用户（用户名 / 密码 / 角色 / 权限）
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    /**
     * R71：**新建账户的角色也要过越权闸门**。
     *
     * 旧实现把 `b.role` 原样透给 `configStore.addUser()`，于是任何管理员都能
     * `POST /users { role: 'admin' }` 造一个与自己同级、且自己**无权管理**的账户。
     * 需求把「添加管理员」明确划给根用户，所以这里逐档判定：
     *  - 请求 `root` ⇒ 403（任何人都不能授予，根用户自己也不行）；
     *  - 请求 `admin` ⇒ 仅根用户；管理员一律 403；
     *  - 不传 / 传 `user` ⇒ 保持原行为。
     */
    if (b.role === roles.ROOT) {
      return res.status(403).json({ error: '根用户角色不可授予：它只属于系统创建的第一个账户' });
    }
    if (b.role === roles.ADMIN && !roles.canAssignRole(req.authUser && req.authUser.role)) {
      return res.status(403).json({ error: '仅根用户可创建管理员账户' });
    }
    if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    // R37：用户级下载限速（字节/秒；0 = 不限速）——与配额/密钥同款前置校验
    let speedLimit = 0;
    if (b.speedLimit !== undefined) {
      const r = parseSpeedLimitInput(b.speedLimit);
      if (!r.ok) return res.status(400).json({ error: r.error });
      speedLimit = r.value;
    }
    /**
     * R54②（需求 2.6）：管理员添加用户时**可直接设置邮箱**。
     *
     * 留空 = 不设置（需求 2.3 的场景：不开放注册时被添加的用户常常没有邮箱）；
     * 非空则必须是合法地址（非法 400，与其它入参同款，不由落盘层静默归一）。
     * 「管理员设置的邮箱视为已验证」的理由见 `config-store.userView` 的注释。
     */
    let email = '';
    if (b.email !== undefined) {
      const raw = String(b.email == null ? '' : b.email).trim();
      if (raw) {
        const r = parseEmailInput(raw);
        if (!r.ok) return res.status(400).json({ error: r.error });
        email = r.value;
      }
    }
    // R69 / L-7：permissions 不参与鉴权 —— 非空一律拒绝，别给管理员留下"已限制"的错觉
    const permErr = rejectUnsupportedPermissions(b.permissions);
    if (permErr) return res.status(400).json({ error: permErr });
    const user = await configStore.addUser({
      username: b.username,
      password: b.password,
      role: b.role,
      permissions: b.permissions,
      speedLimit,
      email,
    });
    statsStore.addLog({
      action: 'users.create',
      detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」新增用户「${user.username}」`
        + `（${roles.roleLabel(user.role)}${email ? `，邮箱：${email}` : ''}）`,
    });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

// 编辑用户（用户名 / 密码留空不改 / 角色 / 权限）
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const target = loadTargetUser(req, res);
    if (!target) return;
    /**
     * R71：**越权判定必须排在所有写操作之前**。
     *
     * 目标角色取自存储（`target.role`），不是请求体里的 `b.role` —— 后者是「想改成
     * 什么」，拿它当现状就等于让「把我自己这级的账户改成 user 再删」绕开所有判定。
     *
     * 「编辑自己」不经过这条判定：管理员在用户管理里点自己那一行时（前端已不渲染
     * 该按钮，但直接调接口仍可能发生）他改的是**自己的**资料，不构成对他人的越权；
     * 角色字段另有 `canAssignRole` 闸门兜住，不可能借此提权。
     */
    const isSelf = target.id === (req.authUser && req.authUser.id);
    if (!isSelf && denyIfCannotManage(req, res, target, '编辑')) return;
    const b = req.body || {};
    /**
     * R87：**编辑自己**时，改密码 / 改邮箱必须先校验当前密码。
     *
     * 这条与 `/users/me` 是同一道闸（R21-09 就是这么加的），但当时只加在了 `/users/me`
     * 上。而 `isSelf` 分支**跳过了** `denyIfCannotManage`，随后 `patch.password`
     * 直接落库 —— 于是「会话被劫持的管理员」只要对自己的 id 调一次本端点，
     * 就能在**不知道当前密码**的前提下改密 + 改邮箱，再靠 `sensitive` 触发的
     * 全会话失效把真实所有者永久锁出。换句话说 R21-09 保护的正是这类人，
     * 却留了一条同义的旁路。
     *
     * 判定与 `/users/me` 完全同源（`touchesCred` 的两条判据、提示文案、日志动作都对齐）。
     */
    if (isSelf) {
      const changesPassword = b.password !== undefined && b.password !== '';
      const changesEmail = b.email !== undefined;
      /**
       * R94（审核 M02-01 / M01-04）：**改用户名同样要当前口令**。
       *
       * R90 把闸门补到了密码 / 邮箱，唯独漏了用户名 —— 而用户名是「我是谁」的
       * 对外标识：会话被劫持后，攻击者只要对自己的 id 调一次本端点就能把名字改成
       * 另一个人的，再配合「按用户名归属」的分享链接（见 M02-02）继承他人资产。
       * `/users/me` 侧早已把用户名算进 `needsCurrent`，两边必须同源。
       */
      const changesUsername = b.username !== undefined && String(b.username) !== String(target.username);
      if (changesPassword || changesEmail || changesUsername) {
        const ip = security.clientIp(req) || 'unknown';
        const rl = security.passwordLimiter('users-self-edit:' + ip);
        if (!rl.ok) {
          res.setHeader('Retry-After', String(rl.retryAfter));
          return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
        }
        const current = String(b.currentPassword == null ? '' : b.currentPassword);
        if (!current) {
          return res.status(400).json({ error: '请输入当前密码以确认身份', needCurrentPassword: true });
        }
        if (!(await configStore.verifyUserPassword(target.id, current))) {
          statsStore.addLog({
            action: 'users.update', level: 'warn',
            detail: `用户「${target.username}」自助变更（密码 / 邮箱）：当前密码校验失败`,
          });
          return res.status(403).json({ error: '当前密码不正确' });
        }
      }
    }
    /**
     * R71：**角色字段的闸门**。
     *
     * 「调整角色」= 授予角色。允许管理员改角色，他就既能把普通用户提成管理员
     * （等价于「添加管理员」，绕过 `POST /users` 上的同一道闸门），也能把自己这级
     * 账户降级后再删除（两步越权）。因此：非根用户提交 `role` 一律 403；
     * 提交 `root` 则谁都 403（不可授予）。
     */
    if (b.role !== undefined) {
      if (b.role === roles.ROOT) {
        return res.status(403).json({ error: '根用户角色不可授予：它只属于系统创建的第一个账户' });
      }
      if (!roles.canAssignRole(req.authUser && req.authUser.role)) {
        return res.status(403).json({ error: '仅根用户可调整用户角色' });
      }
    }
    if (b.password !== undefined && b.password !== '' && b.confirmPassword !== undefined &&
      String(b.confirmPassword) !== String(b.password)) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    const patch = {};
    if (b.username !== undefined) patch.username = b.username;
    if (b.password !== undefined && b.password !== '') patch.password = b.password;
    if (b.role !== undefined) patch.role = b.role;
    // R69 / L-7：同 `/users` —— 非空 permissions 一律 400（该字段不参与鉴权）
    const permErr = rejectUnsupportedPermissions(b.permissions);
    if (permErr) return res.status(400).json({ error: permErr });
    if (b.permissions !== undefined) patch.permissions = b.permissions;
    // R37：用户级下载限速（0 = 不限速）
    if (b.speedLimit !== undefined) {
      const r = parseSpeedLimitInput(b.speedLimit);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.speedLimit = r.value;
    }
    /**
     * R54②（需求 2.5）：管理员可修改任何人的邮箱（含**解绑**：提交空串）。
     *
     * 与「用户名 / 角色 / 权限」不同，邮箱**不进 `sensitive`**（即不撤销该用户的会话）：
     *  - 它不是身份、也不是权限，改它不会让既有会话越权；
     *  - 而"管理员一改邮箱就把人踢下线"是纯打扰；
     *  - 「管理员用改邮箱的方式接管账户」也不构成新增风险 —— 他本来就能直接
     *    重置任何人的密码（`patch.password` 那一条）。
     */
    if (b.email !== undefined) {
      const raw = String(b.email == null ? '' : b.email).trim();
      if (raw) {
        const r = parseEmailInput(raw);
        if (!r.ok) return res.status(400).json({ error: r.error });
        patch.email = r.value;
      } else {
        patch.email = ''; // 解绑
      }
    }
    const user = await configStore.updateUser(req.params.id, patch);
    const parts = [];
    if (patch.username) parts.push('修改用户名');
    if (patch.role) parts.push(`调整为${roles.roleLabel(user.role)}`);
    if (patch.permissions) parts.push('更新权限');
    if (patch.password) parts.push('重置密码');
    if (patch.speedLimit !== undefined) parts.push(patch.speedLimit ? '设置下载限速' : '取消下载限速');
    // 注意用 `!== undefined` 而不是真值判断：解绑（`''`）同样是"改了"
    if (patch.email !== undefined) parts.push(patch.email ? '设置邮箱' : '解绑邮箱');
    statsStore.addLog({ action: 'users.update', detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」编辑用户「${user.username}」（${parts.join('，') || '无变更'}）` });

    // SEC-02：凡改变「身份 / 权限 / 凭据」的编辑，都必须让该用户的既有会话立即失效。
    //  - 改名：会话里缓存的用户名已过期；
    //  - 降权 / 调整权限：否则旧会话继续持原权限最长 24 小时（越权窗口）；
    //  - 重置密码：这是典型的应急响应动作，不撤销会话等于应急响应失效。
    const sensitive = patch.username !== undefined || patch.role !== undefined
      || patch.permissions !== undefined || patch.password !== undefined;
    if (sensitive) {
      const n = authSession.destroyUserSessions(user.id);
      if (n > 0) {
        statsStore.addLog({ action: 'users.logout', level: 'warn', detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」变更了用户「${user.username}」的凭据/权限，其 ${n} 个会话已失效` });
      }
      return res.json({ ok: true, user, sessionsRevoked: n });
    }
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 封禁用户（仅管理员，R33；R71 起管理员只能封禁普通用户）。
 *
 * 请求体：`{ reason, until }` —— `until` 为 epoch 毫秒（前端由 `datetime-local`
 * 换算而来），缺省 / 空 = 永久封禁。校验（原因必填、长度、时间格式）全部收在
 * `configStore.setUserBan()` 一处，路由不另写一份 —— 否则"接口说合法、存储说非法"
 * 这类分叉迟早会出现。
 *
 * 为什么**没有**「至少保留一个管理员」的保护（删除 / 降级那两处有）：
 * 封禁不允许作用于自己（下一行的自保护），因此发起者本人必然是未被封禁的管理员，
 * 封谁都不会让系统失去全部可用管理员。删除 / 降级则可能作用在**自己以外的**最后一个
 * 管理员上（自己还在，但对方被删后可能只剩自己，也可能自己没有管理权限），故需保护。
 *
 * ⚠️ R71：**封禁是「软删除」**（目标立刻失去登录能力），所以它同样受
 * 「管理员只能管理普通用户」约束 —— 否则修好了删除却留下封禁，越权只是换了个按钮。
 */
router.post('/users/:id/ban', requireAdmin, (req, res) => {
  try {
    const target = loadTargetUser(req, res);
    if (!target) return;
    if (target.id === req.authUser.id) {
      return res.status(400).json({ error: '不能封禁当前登录的账户' });
    }
    if (denyIfCannotManage(req, res, target, '封禁')) return;
    const b = req.body || {};
    const user = configStore.setUserBan(target.id, { reason: b.reason, until: b.until });
    /**
     * 封禁必须**立即生效**：只写标记不清会话的话，被封者手里的会话还能继续
     * 读写对象存储，直到会话自然过期（最长 30 天）—— 那等于没封。
     * 与改密 / 降权 / 删除同一处置（SEC-02），复用同一个撤销入口。
     */
    const n = authSession.destroyUserSessions(target.id);
    statsStore.addLog({
      action: 'users.ban', level: 'warn',
      detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」封禁用户「${user.username}」`
        + `（原因：${user.ban.reason}；解封时间：${user.ban.until || '永久'}），其 ${n} 个会话已失效`,
    });
    res.json({ ok: true, user, sessionsRevoked: n });
  } catch (e) {
    sendError(res, e);
  }
});

// 解除封禁（仅管理员，R33）：立即恢复登录，无需等到期时间
router.post('/users/:id/unban', requireAdmin, (req, res) => {
  try {
    const target = loadTargetUser(req, res);
    if (!target) return;
    // R71：「解封」同样是管理动作，必须与封禁同口径（否则管理员能悄悄解掉根用户的封禁状态）
    if (denyIfCannotManage(req, res, target, '解封')) return;
    /**
     * 「有没有被封」的唯一判据是 `banInfo()`：已到期的封禁（state='expired'）也算
     * "封过"，允许管理员显式把标记清干净；只有从未封禁过才拒绝 —— 否则一个
     * 永远成功的「解封」按钮会让人以为刚才那一下真的解开了什么。
     */
    if (configStore.banInfo(target).state === 'none') {
      return res.status(400).json({ error: '该用户当前未被封禁' });
    }
    const user = configStore.clearUserBan(target.id);
    statsStore.addLog({
      action: 'users.unban', level: 'warn',
      detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」解除了用户「${user.username}」的封禁`,
    });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 删除用户。
 *
 * 两道保护，**顺序不能换**：
 *  ① 自保护（400）—— 谁都不能删自己，否则会把自己锁在系统外；
 *  ② 越权判定（403）—— 管理员只能删普通用户。R71 之前这一步**根本不存在**，
 *     于是任何管理员都能删掉其他管理员，甚至删掉根用户 ⇒ 最高权限账户被下属清除。
 *
 * 注意判定排在 `removeUser()` **之前**：403 之后目标用户必须原封不动地还在库里，
 * 且其会话不能被吊销（会话被踢也是破坏，只是看不见）。
 */
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const target = loadTargetUser(req, res);
    if (!target) return;
    if (target.id === req.authUser.id) {
      return res.status(400).json({ error: '不能删除当前登录的账户' });
    }
    if (denyIfCannotManage(req, res, target, '删除')) return;
    configStore.removeUser(req.params.id);
    /**
     * R94（审核 M02-02）：**连带解除该用户的分享链接归属**。
     *
     * 链接归属判据是 `createdBy`（用户名）。不处理的话，「删掉用户 + 建一个同名账号」
     * 就等于把前者留下的全部分享链接（含付费链接的收款人身份）转交出去。
     * 只清空归属、不删链接 —— 理由见 `shareStore.orphanByCreator()` 的说明。
     */
    const orphaned = shareStore.orphanByCreator(target.username);
    // SEC-02：账户已删除，其会话必须立即失效，否则被删除者仍能继续读写对象存储。
    const n = authSession.destroyUserSessions(target.id);
    statsStore.addLog({ action: 'users.delete', level: 'warn', detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」删除用户「${target.username}」（${n} 个会话已失效，${orphaned} 条分享链接已解除归属）` });
    res.json({ ok: true, sessionsRevoked: n, linksOrphaned: orphaned });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 管理员强制登出指定用户的全部会话（S11）。
 *
 * R71：同样是管理动作 —— 允许管理员踢掉根的会话，等于给了一个「让最高权限账户
 * 随时掉线」的骚扰通道（并且是可重复的），故与删除 / 封禁同口径。
 */
router.post('/users/:id/logout', requireAdmin, (req, res) => {
  try {
    const target = loadTargetUser(req, res);
    if (!target) return;
    if (denyIfCannotManage(req, res, target, '强制登出')) return;
    const n = authSession.destroyUserSessions(target.id);
    statsStore.addLog({ action: 'users.logout', level: 'warn', detail: `${roles.roleLabel(req.authUser.role)}「${req.authUser.username}」强制登出用户「${target.username}」（${n} 个会话）` });
    res.json({ ok: true, sessions: n });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
