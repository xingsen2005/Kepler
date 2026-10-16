/**
 * 路由：站点设置（R54）
 *
 * 三条接口，**权限刻意分成两级**：
 *  - `GET /site/info`  —— **公开**。登录页在用户登录**之前**就要把站点名称
 *    显示到浏览器标题栏上；若做成管理员接口，未登录时标题栏只能是硬编码那一串，
 *    管理员改了站点名称也得刷新才看得到（而刷新前他正好在登录页）。
 *    R54② 起**多回一个 `registration`**：登录页得据此决定「注册」入口是可用、
 *    需要邀请码、还是根本不显示。注册模式对匿名者不是秘密 —— 它本来就由登录页
 *    的行为暴露（有没有注册按钮、点了之后被拒还是放行），藏着只会让前端只能
 *    「先摆一个按钮、点了再报错」。
 *    但**只多这一个**：`defaultRole`（新用户身份）是纯管理侧概念，匿名者拿到它
 *    没有任何用处，继续留在 `GET /site/config` 里。
 *  - `GET/PUT /site/config` —— **仅管理员**。站点名称 / 公开注册 / 新用户身份
 *    都是全局配置，普通用户既不显示也不可改（卡片整卡隐藏）。
 *
 * 站点设置**没有启用开关**：它决定的是「标题栏写什么」「新用户是什么身份」
 * 这类必然存在的属性，不存在「关闭」这个状态。界面上因此也不放 `ip-switch`。
 */
const { express, configStore, statsStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
// 入参合法性的唯一判据（与 `config-store` 的落盘归一化共用同一组来源）
const {
  parseSiteNameInput, REGISTRATION_MODES, DEFAULT_ROLES,
} = require('../limits');

const router = express.Router();

/** 对外视图（唯一实现点）*/
function view() {
  return configStore.siteView(configStore.load());
}

/**
 * 站点名称 + 注册模式（**公开**）。
 *
 * 返回值刻意保持极小：这是一条任何匿名请求都能打到的接口，能少给一个字段
 * 就少给一个字段（当前恰好三个键，`tests/audit54-regressions.test.js` 对此有断言）。
 */
router.get('/site/info', apiHandler(async (req, res) => {
  const v = view();
  res.json({ ok: true, siteName: v.siteName, registration: v.registration });
}));

// 查看站点设置（仅管理员）
router.get('/site/config', requireAdmin, apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, view()));
}));

/**
 * 保存站点设置（**PATCH 语义**：缺省字段保持原值；仅管理员）。
 *
 * 三个字段的判据都落在**路由层**（非法一律 400），`config-store` 只做兜底归一 ——
 * 「静默把非法值改写成另一个合法值」会让管理员以为自己设置生效了。
 */
router.put('/site/config', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (b.siteName !== undefined) {
    const r = parseSiteNameInput(b.siteName);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    // 空串合法：界面上「留空 = 恢复默认站点名」，由落盘归一化换成默认名
    patch.siteName = r.value;
  }
  if (b.registration !== undefined) {
    if (typeof b.registration !== 'string' || !REGISTRATION_MODES.includes(b.registration)) {
      throw Object.assign(
        new Error(`注册模式须为 ${REGISTRATION_MODES.join(' / ')} 之一`), { status: 400 });
    }
    patch.registration = b.registration;
  }
  if (b.defaultRole !== undefined) {
    if (typeof b.defaultRole !== 'string' || !DEFAULT_ROLES.includes(b.defaultRole)) {
      throw Object.assign(
        new Error(`新用户身份须为 ${DEFAULT_ROLES.join(' / ')} 之一`), { status: 400 });
    }
    patch.defaultRole = b.defaultRole;
  }

  const saved = configStore.saveSite(patch);
  statsStore.addLog({
    action: 'config.save', level: 'info',
    detail: `管理员「${req.authUser.username}」更新站点设置`
      + `（站点名称=${saved.siteName}，公开注册=${saved.registration}`
      + `，新用户身份=${saved.defaultRole}）`,
  });
  res.json(Object.assign({ ok: true }, view()));
}));

module.exports = router;
