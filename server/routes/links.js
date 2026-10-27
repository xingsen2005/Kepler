/**
 * 路由：分享链接管理
 *  — 管理员可见/可管理全部链接；普通用户仅限自己创建的（shareStore.listFor / canManage）
 */
const { express, configStore, statsStore, shareStore, paymentProviders, paymentRules } = require('./_context');
const { getClient, p, normalizeKey, badRequest, listAllInfo } = require('../s3');
const userSpace = require('../user-space'); // R89：分享快照必须落**绝对** key（见 toSpacePaths）
const { roleOf, requireConfig, mapLimit } = require('./_shared');
const { parseSpeedLimitInput } = require('../limits');
// R50：二维码生成器 —— 与微信支付 Native 下单用的是**同一个**零依赖实现
// （`server/qrcode.js`，`payment-gateway.js` 也调它的 `toSvg`）。
const qrcode = require('../qrcode');
const router = express.Router();

/**
 * 本生成器当前能编码的最大内容长度（字节）。
 *
 * R50 刻意**没有**扩大 `qrcode.js` 的版本表（仍为 V1~10 / 纠错级别 M）：
 * 那张表连同对齐图案、版本信息位、剩余位规则是被 `tests/qrcode.test.js` 逐项
 * 钉住的成熟实现，为了一张二维码去动它，收益远小于风险。
 * 代价是约 213 字节以上的内容编不出来 —— 分享链接（`https://<域名>/s/<22 字符>`）
 * 远在限额之内；而**预签名直链**（带 `q-signature` 等查询串，通常 400+ 字节）
 * 编不出来，此时如实告知用户，而不是渲染一张空白的二维码。
 *
 * 这里从容量表**推导**而非写死数字：改了版本表这个值自动跟着变。
 */
function maxQrBytes() {
  const v = qrcode.CAPACITY.length - 1;           // 支持的最高版本
  const countBits = v <= 9 ? 8 : 16;               // 字符数指示符位数（见 qrcode.js）
  return Math.floor((qrcode.capacityBytes(v) * 8 - 4 - countBits) / 8);
}

/** 当前支付能力快照（开关 + 凭证完整 + 可用渠道） */
function paySnapshot() {
  const stored = configStore.getPayment();
  return Object.assign({ enabled: stored.enabled }, paymentRules.snapshot(
    stored.platforms, paymentProviders.ORDER, (id) => paymentProviders.isConfigured(id, stored.platforms[id]),
  ));
}

/**
 * 付费配置落盘前的提示（不是错误）。
 *
 * 付费是**分享者的意图**，支付渠道是否就绪是**系统当前状态**，两者解耦：
 * 即便支付被停用、或没有可用渠道，也允许保存配置 —— 否则管理员调一次开关
 * 就会把所有链接的付费配置冲掉，与「停用后自动免费、启用后按原配置恢复」相悖。
 * 这里只返回一句提示，由前端以警告形式告知。
 */
function paidWarning(paid) {
  if (!paid || !paid.required) return '';
  try {
    const snap = paySnapshot();
    if (!snap.enabled) return '支付功能当前处于停用状态，付费配置已保存，但该链接暂时按免费下载处理。';
    if (!snap.available.length) return '当前没有可用的支付渠道（需渠道已启用且凭证填写完整），付费配置已保存，但该链接暂时按免费下载处理。';
  } catch (e) { /* 支付模块异常不应阻断链接保存 */ }
  return '';
}

/** 校验并规范化链接参数，返回 {expiresHours, maxDownloads, password, speedLimit} 或抛出 badRequest */
function parseLinkParams(b) {
  const out = {};
  if (b.expiresHours !== undefined) {
    if (b.expiresHours === null || b.expiresHours === '' || Number(b.expiresHours) === 0) {
      out.expiresHours = null; // 永久有效
    } else {
      const h = Number(b.expiresHours);
      if (!Number.isFinite(h) || h <= 0) throw badRequest('有效期必须为正数（小时），或留空表示永久有效');
      if (h > 24 * 3650) throw badRequest('有效期最长 10 年');
      out.expiresHours = h;
    }
  }
  if (b.maxDownloads !== undefined) {
    const n = Number(b.maxDownloads);
    if (!Number.isInteger(n) || n < 0) throw badRequest('下载次数必须为不小于 0 的整数（0 表示不限制）');
    if (n > 1e9) throw badRequest('下载次数数值过大');
    out.maxDownloads = n;
  }
  if (b.password !== undefined) {
    if (b.password === null || b.password === '') {
      out.password = null; // 未启用 / 清除密码
    } else {
      const pw = String(b.password);
      /**
       * R94（审核 M08-05）：长度下界从 **1** 提到 **6**。
       *
       * 下界 1 在协议上是合法的，但实际上等于没保护：口令校验入口是**匿名可达**的，
       * 而爆破预算只有 `shareLimiter`（20 次/10 分钟/(IP+链接)）与 `shareLock`
       * （5 次失败冻结 30 分钟/(IP+链接)）—— 都是**按 IP** 计的，分布式来源下
       * 没有任何总量约束。于是 4 位数字 PIN 在 50 个 IP 并行下约 10 小时可穷举，
       * 而单字符口令几十秒就完了。下界提到 6（与 `config-store.assertPasswordPolicy`
       * 的取向一致）让"猜"重新变得不划算；已有短口令的链接**照常工作**
       * （只在创建 / 改密时校验），用户下次改密码时会被要求补足长度。
       */
      if (pw.length < 6 || pw.length > 64) throw badRequest('访问密码长度须为 6-64 个字符');
      out.password = pw;
    }
  }
  if (b.paid !== undefined) {
    // paid: null → 关闭付费下载；paid: { required, amount } → 设置（amount 单位为元）
    const p0 = b.paid && typeof b.paid === 'object' ? b.paid : {};
    const required = Boolean(p0.required);
    let amountFen = 0;
    if (p0.amount !== undefined && p0.amount !== null && p0.amount !== '') {
      const r = paymentRules.normalizeAmount(p0.amount);
      if (!r.ok) throw badRequest(r.message);
      amountFen = r.fen;
    }
    if (required && amountFen <= 0) {
      throw badRequest(`已开启「需付费下载」，请填写付费金额（最低 ${paymentRules.formatAmount(paymentRules.MIN_AMOUNT_FEN)} 元）`);
    }
    // required=false 时金额仍会保留，便于下次直接打开开关
    out.paid = { required: required && amountFen > 0, amountFen, currency: paymentRules.CURRENCY };
  }
  /**
   * R37：下载限速（字节/秒；0 = 不限）。
   *
   * ⚠️ 这里**只判合法性，不判「是否被上层限制」**。上层（API Key / 存储桶 /
   * 用户管理）设了更小的值时，本字段照常保存 —— 实际生效速率由
   * `server/throttle.js` 的 `resolveLimit()` 在下载时取各层最小值。
   * 前端会先调 `GET /throttle/ceiling` 拿到上层下限并给出提示（需求里的
   * 「已在 API Key 管理中设置限速为 xx MB/S」），但那是**提示**而不是拦截：
   * 若在这里硬拒，用户就没法先在分享层填好值、等管理员放宽上层后再生效。
   */
  if (b.speedLimit !== undefined) {
    const r = parseSpeedLimitInput(b.speedLimit);
    if (!r.ok) throw badRequest(r.error);
    out.speedLimit = r.value;
  }
  return out;
}

// 分享链接列表（管理员看全部；普通用户仅看自己创建的）
router.get('/links', (req, res) => {
  res.json({ links: shareStore.listFor(roleOf(req), req.authUser && req.authUser.username) });
});

/**
 * 分享链接二维码（R50）。
 *
 * 「链接创建成功」弹窗里要展示链接的二维码，好让用户直接扫码打开。
 * 二维码由**服务端**生成：`server/qrcode.js` 已是零依赖的自研实现，
 * 前端再引一个 npm 包既违背「仅 3 个依赖」的约定，也会和它漂移成两种图形。
 * 故这里只把 `text` 收下来、调 `toSvg()`、以 JSON 回传 SVG 字符串。
 *
 * 为什么不让前端直接 `<img src="/api/links/qrcode?text=...">`：
 * `/api` 上的 CSRF 校验要求自定义头 `X-Requested-With`，`<img>` 发不出来，
 * 那样请求会被 403 拒掉。故一律经 `api.js` 的 `request()`（它带这个头）。
 *
 * ⚠️ 路径是**单段** `links/qrcode`，与 `GET /links`（精确匹配）不冲突；
 * 本模块**没有** `GET /links/:id`，因此也不存在「被参数路由吞掉」的风险
 * ——与同文件里 `/links/dead` 需要提前注册的情形不同。
 *
 * 不挂 `requireAdmin`：普通用户同样要创建分享链接（见 `POST /links` 的注释）。
 */
router.get('/links/qrcode', (req, res) => {
  const text = String(req.query.text === undefined ? '' : req.query.text);
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });
  const svg = qrcode.toSvg(text, { scale: 6, margin: 3 });
  if (!svg) {
    return res.status(400).json({
      error: `内容过长，无法生成二维码（当前最多支持 ${maxQrBytes()} 字节）`,
    });
  }
  res.json({ svg });
});

/* ---------------- R51：多文件 / 文件夹分享的快照构建 ---------------- */

/**
 * 归一化顶层路径（去重、保序、剔除空项）。
 *
 * `paths` 是 R51 的新入口（文件与文件夹可混选）；`path` 继续接受，
 * 于是旧客户端与既有测试的请求体一字不改仍然可用 —— 这不只是兼容，
 * 也让「单文件分享」这条最常用的路径不必经过任何新代码分支。
 */
function collectPaths(body) {
  const raw = Array.isArray(body.paths) ? body.paths : (body.path !== undefined ? [body.path] : []);
  const out = [];
  for (const p of raw) {
    const k = normalizeKey(String(p === undefined || p === null ? '' : p));
    if (!k) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * R89：相对路径 → 桶内**绝对** key（分享快照必须存绝对 key）。
 *
 * 分享链接是**无会话**的（`share-routes.js` 挂在 `/s/...` 上，不经过 `/api` 的
 * 鉴权中间件，因此没有 `requestContext`），下载时不可能再补算空间根 ——
 * 所以快照里必须是绝对 key，`items[]` 一旦存了相对 key，链接建得出来、
 * 点开却恒 404，而且要等用户投诉才会发现。
 *
 * 反过来，这里若**不加根**，`buildSnapshot` 的 `headObject` 会被 `s3.js` 的
 * 兜底断言判成越界（普通用户永远建不出分享）。
 */
function toSpacePaths(cfg, rels) {
  return rels.map((r) => userSpace.toAbs(cfg.spaceRoot, r));
}

/**
 * 构建条目快照（创建时冻结，上限 {@link shareStore.SNAPSHOT_MAX}）。
 *
 * 两个刻意的取舍：
 *
 *  · **文件并行 head、目录串行列举**。文件之间互不相关，用有并发上限的 `mapLimit`
 *    并行探测（`headObject` 是单次往返，用户勾 200 个文件时串行会等到天荒地老）；
 *    而目录列举本身就是**串行翻页**（`listAllInfo` 内部按游标一页页走），
 *    再套一层并行只会让"哪个目录失败"更难定位。并发上限取 4，与多桶统计同一口径。
 *
 *  · **超限截断且如实上报**（返回 `truncated`），不静默丢内容 —— 用户看到的是
 *    "只快照了前 2000 项"，而不是过几天发现少了一半文件。也**不**用报错拒绝：
 *    分享一个两万文件的目录是合理需求，截断比整单失败更有用。
 *
 * @returns {Promise<{error?: string, status?: number, items?, truncated?, summary?}>}
 */
async function buildSnapshot({ client, cfg, paths }) {
  const items = [];
  let truncated = false;
  const room = () => shareStore.SNAPSHOT_MAX - items.length;

  const files = paths.filter((k) => !k.endsWith('/'));
  const dirs = paths.filter((k) => k.endsWith('/'));

  const heads = await mapLimit(files, 4, async (k) => {
    try {
      const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k });
      return { key: k, size: Number(head.headers['content-length']) || 0 };
    } catch (e) {
      return { key: k, missing: true };
    }
  });
  for (const h of heads) {
    if (!room()) { truncated = true; break; }
    // 文件不存在就整单失败（与 R51 之前单个文件的报错口径一致）：
    // 让用户当场知道自己选错了一个对象，比事后在分享页里发现少了它好得多。
    if (h.missing) return { status: 404, error: '对象不存在或无权访问：' + h.key };
    items.push({ key: h.key, size: h.size, dir: false });
  }

  for (const d of dirs) {
    if (!room()) { truncated = true; break; }
    let info;
    try {
      // 给列举留出「目录行自身」的位置：room() - 1
      info = await listAllInfo(client, cfg, d, { cap: Math.max(1, room() - 1), skipPrefixSelf: true });
    } catch (e) {
      return { status: 404, error: '目录不存在或无权访问：' + d };
    }
    if (!room()) { truncated = true; break; }
    items.push({ key: d, size: 0, dir: true });
    for (const it of info.items) {
      if (!room()) { truncated = true; break; }
      items.push({ key: it.key, size: Number(it.size) || 0, dir: false });
    }
    if (info.truncated) truncated = true;
  }

  const st = shareStore.itemStats(items);
  const fileCount = items.length - st.dirCount;
  const summary = items.length === 1 && !items[0].dir
    ? items[0].key
    : `${items.length} 项（${st.dirCount} 个文件夹 / ${fileCount} 个文件）`;
  return { items, truncated, summary };
}

// 创建链接（对目标对象做 head 校验并快照文件名/大小；R51 起支持多文件与文件夹）
router.post('/links', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const b = req.body || {};
    const paths = collectPaths(b);
    if (!paths.length) return res.status(400).json({ error: '请选择要分享的文件或文件夹' });
    const params = parseLinkParams(b);

    // R89：加空间根（见 toSpacePaths 的说明）。越界/伪造的 key 由这里收口成「自己的
    // 命名空间下不存在」，再由 buildSnapshot 报 404 —— 与「文件真的不存在」同一句文案。
    const snap = await buildSnapshot({ client, cfg, paths: toSpacePaths(cfg, paths) });
    if (snap.error) return res.status(snap.status || 400).json({ error: snap.error });
    if (!snap.items.length) return res.status(400).json({ error: '请选择要分享的文件或文件夹' });

    const link = await shareStore.create({
      key: '', bucket: cfg.bucket, region: cfg.region,
      items: snap.items,
      expiresHours: params.expiresHours === undefined ? 24 * 7 : params.expiresHours,
      maxDownloads: params.maxDownloads === undefined ? 0 : params.maxDownloads,
      password: params.password === undefined ? null : params.password,
      paid: params.paid,
      speedLimit: params.speedLimit, // R37：未传 = 0（不限速）
      createdBy: (req.authUser && req.authUser.username) || '',
    });
    statsStore.addLog({
      action: 'share.create',
      detail: `创建分享链接 ${statsStore.logRef(link.id)}（${snap.summary}）${snap.truncated ? `，条目超过 ${shareStore.SNAPSHOT_MAX} 已截断` : ''}${link.paid && link.paid.required ? `，需付费 ${paymentRules.formatAmount(link.paid.amountFen)} 元` : ''}`,
    });
    res.json(Object.assign(
      { ok: true }, link,
      { warn: paidWarning(link.paid) },
      snap.truncated ? { truncated: true, snapshotMax: shareStore.SNAPSHOT_MAX } : {},
    ));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 修改链接（有效期 / 次数 / 密码 / 重置计数；普通用户仅限自己创建的）
router.put('/links/:id', async (req, res) => {
  try {
    const target = shareStore.get(req.params.id);
    if (!target) return res.status(404).json({ error: '链接不存在' });
    if (!shareStore.canManage(target, roleOf(req), req.authUser && req.authUser.username)) {
      return res.status(403).json({ error: '无权修改该分享链接' });
    }
    const params = parseLinkParams(req.body || {});
    if (req.body && req.body.resetCount !== undefined && typeof req.body.resetCount !== 'boolean') {
      throw badRequest('resetCount 必须为布尔值');
    }
    const link = await shareStore.update(req.params.id, Object.assign({}, params, {
      resetCount: Boolean(req.body && req.body.resetCount),
    }));
    statsStore.addLog({
      action: 'share.update',
      detail: `修改分享链接 ${statsStore.logRef(req.params.id)}${params.paid ? `，付费下载：${link.paid && link.paid.required ? `需付 ${paymentRules.formatAmount(link.paid.amountFen)} 元` : '关闭'}` : ''}`,
    });
    res.json(Object.assign({ ok: true }, link, { warn: paidWarning(link.paid) }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 删除全部失效链接（「文件已删除」与「已过期」）—— 链接管理页的「删除失效链接」按钮。
 *
 * ⚠️ **必须注册在 `DELETE /links/:id` 之前**：express 按注册顺序匹配，若放在参数路由
 * 后面，路径里的 `dead` 会被 `:id` 当成一个链接 id 吞掉 —— 请求永远到不了这里，
 * 界面上表现为「点了按钮提示『链接不存在』」，而路由表里两条路径看起来都在。
 *
 * 作用域与列表接口一致（`shareStore.removeDead` 内部用 `canManage`），**不挂 requireAdmin**：
 * 链接管理页普通用户也能进，每个人只清自己创建的那批。
 *
 * 哪些算「失效」由 `shareStore.removeDead()` 裁定（与 `status()` 同源），本路由不判。
 */
router.delete('/links/dead', (req, res) => {
  const role = roleOf(req);
  const who = (req.authUser && req.authUser.username) || '';
  const removed = shareStore.removeDead(role, who);
  if (removed > 0) {
    statsStore.addLog({
      action: 'share.delete',
      level: 'warn',
      detail: `「${who}」删除失效分享链接 ${removed} 条（文件已删除 / 已过期）`,
    });
  }
  res.json({ ok: true, removed });
});

// 删除链接（仅删除本地分享记录，不影响云端对象；普通用户仅限自己创建的）
router.delete('/links/:id', (req, res) => {
  const target = shareStore.get(req.params.id);
  if (!target) return res.status(404).json({ error: '链接不存在' });
  if (!shareStore.canManage(target, roleOf(req), req.authUser && req.authUser.username)) {
    return res.status(403).json({ error: '无权删除该分享链接' });
  }
  if (!shareStore.remove(req.params.id)) return res.status(404).json({ error: '链接不存在' });
  statsStore.addLog({ action: 'share.delete', detail: '删除分享链接 ' + statsStore.logRef(req.params.id), level: 'warn' });
  res.json({ ok: true });
});

module.exports = router;
