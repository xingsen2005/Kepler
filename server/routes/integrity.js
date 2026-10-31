/**
 * 路由：完整性巡检（R99）
 *
 * 两条接口，**都仅管理员**：
 *  - `GET /integrity`      —— 读最近一次巡检结果（不发起任何云端请求）
 *  - `POST /integrity/run` —— 立刻跑一轮（会真的对云端发 HEAD）
 *
 * ## 为什么「立即巡检」是 POST 而不是 GET
 *
 * 它**不是只读的**：会按候选集对云端逐个发 HEAD，消耗的是真实的请求配额与带宽，
 * 且并发上限、每轮条数都是服务端维护的共享状态（游标会被推进）。用 GET 的话，
 * 浏览器预取、代理重放、用户连按刷新都会各触发一轮，与「只读查询」的心智不符。
 *
 * ## 为什么没有「启用 / 停用」开关
 *
 * 开关就在环境变量 `INTEGRITY_SWEEP_MS`（0 = 关闭）里 —— 它是**部署级**的取舍
 * （有的实例把对象存储当备份盘，不希望后台有任何额外请求），而不是一个日常
 * 会来回拨的按钮。做成界面开关会多出一份"当前是否启用"的落盘状态，而定时器
 * 读的却是环境变量，两者迟早不一致。
 *
 * ## 权限为什么不是「比管理员更高一档」
 *
 * 巡检只读、不改任何数据、不碰密钥（连解密都不做），结果里也只有「哪个对象异常」。
 * 管理员本来就掌握全部桶与对象，因此不需要像密钥轮转那样收窄到根用户。
 */
const { express } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
const integrity = require('../integrity');

const router = express.Router();

/**
 * 读巡检状态（仅管理员）。
 *
 * 刻意**不在这里顺手跑一轮**：这个接口会被系统设置页反复调用（切角色、切卡片、
 * 手动刷新），而每次巡检都是真实的云端请求。想立刻体检就走下面那条 POST。
 */
router.get('/integrity', requireAdmin, apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, integrity.state()));
}));

/**
 * 立刻跑一轮（仅管理员）。
 *
 * `integrity.runOnce()` 内部对「定时器正在跑」做了合流：两个请求同时点只会
 * 有一次真实巡检（另一次直接拿到同一个 Promise），不会把云端请求翻倍。
 */
router.post('/integrity/run', requireAdmin, apiHandler(async (req, res) => {
  const s = await integrity.runOnce();
  res.json(Object.assign({ ok: true }, s));
}));

module.exports = router;
