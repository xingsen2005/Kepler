/**
 * 路由：完整性巡检（R99 / R103）
 *
 * 三条接口，**都仅管理员**：
 *  - `GET /integrity`          —— 读最近一次巡检结果（不发起任何云端请求）
 *  - `POST /integrity/run`     —— 立刻跑一轮（会真的对云端发 HEAD）
 *  - `PUT /integrity/notify`   —— 保存「发现异常时发邮件通知」的开关与收件地址（R103）
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
 * 注意与 R103 的「异常通知」分开：那个开关管的是**要不要发邮件**，不是
 * 「要不要巡检」。巡检关掉时通知自然一封都不会发（没有结果可通知），
 * 但通知开关本身仍是独立的一段落盘配置。
 *
 * ## 权限为什么不是「比管理员更高一档」
 *
 * 巡检只读、不改任何数据、不碰密钥（连解密都不做），结果里也只有「哪个对象异常」。
 * 管理员本来就掌握全部桶与对象，因此不需要像密钥轮转那样收窄到根用户。
 * 异常通知同理：它只是把管理员已经能看到的结论发到管理员自己填的地址上。
 */
const { express, configStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
const { badRequest } = require('../s3');
const { parseEmailInput } = require('../limits');
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

/**
 * 保存异常通知设置（仅管理员，R103）。
 *
 * ## 为什么是 PUT 而不是 POST
 *
 * 这是**幂等的整段替换**：同一份 `{enabled, email}` 提交几次结果都一样，
 * 而发信是它的副作用（由巡逻在后台触发，不在这个请求里发生）。用 POST 会让人
 * 以为「点一次多发一封」。
 *
 * ## 三道校验，顺序有讲究
 *
 * ① `enabled` 按**真值**归一（`'false'` 这种字符串不能当 true，否则前端少发一个
 *    布尔就会自己打开通知）；
 * ② 地址**无论开关是否打开都要校验**（只要给了非空值）—— 否则「先填错、以后再开」
 *    这条路径会把一个坏地址静默存下来，等到真出异常那天才发现发不出去；
 * ③ 打开开关却**没填地址** ⇒ 直接 400，不做「先存着」的宽容：那等于让管理员以为
 *    通知已生效，而实际上一封都不会发。
 *
 * ## 保存成功但发不出去时**不报错**
 *
 * SMTP 是另一张卡片配的。这里若因为「SMTP 没配」而拒绝保存，管理员就被逼着按
 * 特定顺序填两张表（而且他可能是先配通知、后配 SMTP）。正确做法是**如实保存**，
 * 并在响应里带 `warning` 说明「暂时发不出去」—— 界面把这句话显示出来即可。
 */
router.put('/integrity/notify', requireAdmin, apiHandler(async (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const enabled = b.enabled === true;
  const raw = b.email == null ? '' : String(b.email);

  let email = '';
  if (raw.trim()) {
    const r = parseEmailInput(raw, '通知邮箱');
    if (!r.ok) throw badRequest(r.error);
    email = r.value;
  }
  if (enabled && !email) throw badRequest('已开启异常通知，请填写接收通知的邮箱地址');

  configStore.saveIntegrityNotify({ enabled, email });
  const n = integrity.state().notify;
  const warning = (enabled && !n.smtpConfigured)
    ? '通知已开启，但「发信设置（SMTP）」还没配置好，暂时发不出去 —— 请先在系统设置里填好发信服务器。'
    : '';
  res.json({ ok: true, notify: n, warning });
}));

module.exports = router;
