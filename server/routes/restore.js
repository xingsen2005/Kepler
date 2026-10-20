/**
 * 路由：订单取回设置（R65）
 *
 * 两条接口，**都仅管理员**：它们决定的是「一笔订单号能被用来取回几次」
 * 与「多少 IP 会被自动封 24 小时」，属于全局的策略，普通用户既不显示也不可改
 * （卡片整卡在系统设置页按角色隐藏，见 `syssettings.js` 的 `ADMIN_ONLY_CARDS`）。
 *
 * ## 为什么没有「启用」开关（需求 4）
 *
 * 这两条是**护栏**，不是可选项：关掉 `maxUses` 等于让订单号变成无限制的万能凭证，
 * 关掉 `maxFails` 等于对匿名端点开放无限次猜测。因此配置里没有 `enabled` 字段，
 * 落盘默认就是生效的（`config-store.normalizeRestoreInto` 保证历史配置读盘即补齐）。
 *
 * ## 判据分层
 *
 * - **入参合法性**在路由层（非法一律 400，附可读的原因），
 * - **落盘归一化**在 `config-store`（只兜底，不拒绝），
 * - **不限制**不是合法值：两个字段的下限都是 1（见 `limits.js` 的说明）。
 */
const { express, configStore, statsStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
const { parseRestoreUsesInput, parseRestoreFailsInput } = require('../limits');

const router = express.Router();

/** 对外视图（唯一实现点：口径在 `config-store.restoreView`） */
function view() {
  return configStore.restoreView(configStore.load());
}

// 查看订单取回设置（仅管理员）
router.get('/restore/config', requireAdmin, apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, view()));
}));

/**
 * 保存订单取回设置（**PATCH 语义**：缺省字段保持原值；仅管理员）。
 *
 * 两个字段都走 `limits.js` 的同一批判据 —— 与落盘归一共用一套边界值，
 * 不在这里手写 `1..100` 这种重复的魔数。
 */
router.put('/restore/config', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (b.maxUses !== undefined) {
    const r = parseRestoreUsesInput(b.maxUses);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.maxUses = r.value;
  }
  if (b.maxFails !== undefined) {
    const r = parseRestoreFailsInput(b.maxFails);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.maxFails = r.value;
  }

  const saved = configStore.saveRestore(patch);
  statsStore.addLog({
    action: 'config.save', level: 'info',
    detail: `管理员「${req.authUser.username}」更新订单取回设置`
      + `（取回次数上限=${saved.maxUses} 次，连续输错上限=${saved.maxFails} 次）`,
  });
  res.json(Object.assign({ ok: true }, view()));
}));

module.exports = router;
