/**
 * 路由：IP 访问屏蔽（黑名单 + 国内白名单，全局 / 桶级两级）
 *  — 全部接口仅管理员；规则变更即时生效
 */
const { express, configStore, statsStore, ipGuard } = require('./_context');
const { requireAdmin } = require('./_shared');
// R65：订单取回的自动封禁（只作用于取回端点；管理端在这里展示与解封）
const restoreGuard = require('../restore-guard');

const router = express.Router();

/** 为规则附加作用范围显示信息（桶显示名列表 / 是否有已解绑桶） */
function ruleScopeView(rule, buckets) {
  const bids = Array.isArray(rule.bucketIds) ? rule.bucketIds : [];
  if (!bids.length) return Object.assign({}, rule, { bucketNames: [], bucketMissing: false, isGlobal: true });
  const names = [];
  let missing = false;
  for (const id of bids) {
    const b = buckets.find((x) => x.id === id);
    if (b) names.push(b.remark || b.bucket);
    else { missing = true; names.push('(已解绑的存储桶)'); }
  }
  return Object.assign({}, rule, { bucketNames: names, bucketMissing: missing, isGlobal: false });
}

router.get('/ipguard', requireAdmin, (req, res) => {
  const v = ipGuard.view();
  const buckets = configStore.listBuckets().buckets;
  v.rules = v.rules.map((r) => ruleScopeView(r, buckets));
  /**
   * R65：订单取回的**自动封禁**一并下发。
   *
   * 它与上面的 `rules` 是**两张表**，刻意不合并：`rules` 是管理员手工维护的
   * 访问规则（命中即 403，作用于全部请求），而这里是「连续输错订单号」自动产生、
   * 24 小时后自动过期、**只拦取回端点**的临时限制。混进同一张表会出现两个问题：
   * ① 界面上的「启用 / 禁用 / 编辑 / 作用范围」对它全都不适用；
   * ② 有人会以为删掉它就能放行访问（实际它从来没拦过访问）。
   */
  v.restoreBans = restoreGuard.listBans();
  res.json(Object.assign({ ok: true, methods: ipGuard.ALLOWED_METHODS }, v));
});

/**
 * 解封某个 IP 的「订单取回」限制（R65，仅管理员）。
 *
 * 路径用 `POST .../unban` 而不是 `DELETE /ipguard/restore-bans/:ip`：IPv6 地址里
 * 有 `:`、IPv4 里有 `.`，塞进路径段还要处理百分号编码，而这里要的只是「解掉一个
 * 地址」，放在请求体里最不容易出错。返回 `removed:false` 表示本来就没封 ——
 * 界面据此提示「该 IP 当前未被限制」，而不是一律报「已解封」。
 */
router.post('/ipguard/restore-bans/unban', requireAdmin, (req, res) => {
  const ip = String((req.body || {}).ip || '').trim();
  if (!ip) return res.status(400).json({ error: '请提供要解封的 IP 地址' });
  let removed;
  try {
    removed = restoreGuard.unban(ip);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  statsStore.addLog({
    action: 'ipguard.restore-unban', level: 'warn',
    detail: `管理员「${req.authUser.username}」${removed ? '解除' : '尝试解除（该 IP 未被封禁）'}`
      + ` IP ${ip} 的「订单取回」限制`,
  });
  res.json({ ok: true, ip, removed, restoreBans: restoreGuard.listBans() });
});

router.post('/ipguard/rules', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const rule = ipGuard.addRule({ target: b.target, remark: b.remark, methods: b.methods, bucketIds: b.bucketIds, kind: b.kind, speedLimit: b.speedLimit });
    const scope = (rule.bucketIds && rule.bucketIds.length) ? '桶级' : '全局';
    const what = rule.kind === 'speed' ? `IP 限速规则 ${rule.target}（${Math.round(rule.speedLimit / 1024 / 1024 * 10) / 10} MB/s）` : `IP 屏蔽规则 ${rule.target}`;
    statsStore.addLog({ action: 'ipguard.add', detail: `新增${scope} ${what}${rule.kind === 'speed' ? '' : (rule.methods.length ? '（' + rule.methods.join('/') + '）' : '（全部方法）')}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/ipguard/rules/:id', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const rule = ipGuard.updateRule(req.params.id, { target: b.target, remark: b.remark, methods: b.methods, bucketIds: b.bucketIds, kind: b.kind, speedLimit: b.speedLimit });
    statsStore.addLog({ action: 'ipguard.update', detail: `修改 ${rule.kind === 'speed' ? 'IP 限速' : 'IP 屏蔽'}规则 ${rule.target}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/ipguard/rules/:id/enabled', requireAdmin, (req, res) => {
  try {
    const enabled = !!(req.body || {}).enabled;
    const rule = ipGuard.setRuleEnabled(req.params.id, enabled);
    // R37：文案必须区分「屏蔽」与「限速」—— 同一条规则表里两种类型共存，
    // 日志写死「IP 屏蔽规则」会让「我刚把限速规则禁用了」在日志里查不到。
    statsStore.addLog({ action: 'ipguard.toggle', detail: `${enabled ? '启用' : '禁用'} ${rule.kind === 'speed' ? 'IP 限速' : 'IP 屏蔽'}规则 ${rule.target}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/ipguard/rules/:id', requireAdmin, (req, res) => {
  try {
    const removed = ipGuard.removeRule(req.params.id);
    statsStore.addLog({ action: 'ipguard.delete', detail: `删除 ${removed.kind === 'speed' ? 'IP 限速' : 'IP 屏蔽'}规则 ${removed.target}` });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 按存储桶屏蔽 / 放行海外 IP（仅管理员；配置写入 config.enc，ip-guard 读配置即时生效）
router.put('/buckets/local/:id/block-overseas', requireAdmin, (req, res) => {
  try {
    const enabled = !!(req.body || {}).enabled;
    const r = ipGuard.setBucketOverseas(req.params.id, enabled);
    ipGuard.invalidateOverseasCache(req.params.id);
    const b = configStore.listBuckets().buckets.find((x) => x.id === req.params.id);
    statsStore.addLog({ action: 'bucket.block-overseas', level: 'warn', detail: `管理员「${req.authUser.username}」${enabled ? '开启' : '关闭'}存储桶「${b ? b.bucket : req.params.id}」的海外 IP 屏蔽（白名单 ${r.chinaRangeCount} 段）` });
    res.json(Object.assign({ ok: true }, r));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 测试某个 IP 是否会被当前规则屏蔽（预检，便于用户校验规则）
// bucketId 可选：空 = 无桶上下文（仅全局规则）；'active' = 当前激活桶；其余 = 指定桶 id
router.get('/ipguard/test', requireAdmin, (req, res) => {
  const ip = String(req.query.ip || '').trim();
  const method = String(req.query.method || 'GET').toUpperCase();
  let bucketId = String(req.query.bucketId || '').trim();
  if (bucketId === 'active') {
    const lb = configStore.listBuckets();
    bucketId = lb.activeBucketId || '';
  }
  const v = ipGuard.evaluate(ip, method, bucketId || null);
  /**
   * R37：预检同时报告**限速**规则。
   *
   * 「不会被屏蔽」与「不会被限速」是两件事：屏蔽规则与限速规则刻意互斥
   * （见 `RULE_KINDS`），所以一次预检要同时回答两个问题，否则管理员加了一条
   * 限速规则后来预检，看到「可正常访问」会以为规则没生效。
   */
  const sp = ipGuard.speedLimitFor(ip, method, bucketId || null);
  res.json({
    ok: true, ip, method, bucketId: bucketId || null,
    allowed: v.ok, reason: v.reason || null, matchedRule: v.rule || null,
    speedRule: sp ? { target: sp.target, bytesPerSec: sp.bytesPerSec } : null,
  });
});

module.exports = router;
