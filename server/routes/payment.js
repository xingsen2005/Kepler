/**
 * 路由：支付平台配置（仅管理员）
 *
 * 本模块**只包含凭证配置、开关、合法性校验与订单管理**（列表 / 退款标记），
 * 不涉及任何下单 / 查单 / 网关回调等支付业务流程（后者在 share-routes.js 与 payment-gateway.js）。
 * 校验规则集中在 server/payment-providers.js，开关约束集中在 server/payment-rules.js，
 * 本文件只负责编排。
 *
 * 开关层级（对应需求一 / 二 / 四）：
 *   总开关   config.payment.enabled              —— 停用后所有付费链接自动转免费
 *   渠道开关 config.payment.platforms[id].enabled —— 各渠道独立，可任意组合
 *   约束     总开关为「启用」时，至少一个渠道开启（关闭最后一个会被拒绝）
 *
 * 安全约定：
 *  - 全部接口挂载 requireAdmin；
 *  - 敏感字段（密钥 / 证书 / Secret）任何情况下都不回传明文，只回传「是否已配置」；
 *  - 审计日志只记录"哪个平台、改了什么开关"，绝不记录字段值。
 */
const { express, configStore, statsStore, paymentProviders, paymentRules, paymentOrders, shareStore, security, couponStore, paymentGateway, paymentLogos } = require('./_context');
const { requireAdmin, asyncHandler } = require('./_shared');

const router = express.Router();

/** 审计：只记平台与动作，不记值（密钥明文一旦进日志就是永久泄露） */
function logChange(req, action, detail) {
  statsStore.addLog({
    action: `payment.${action}`,
    level: 'info',
    detail: `管理员「${req.authUser.username}」${detail}`,
  });
}

const allIds = () => paymentProviders.ORDER.slice();

/** 各渠道当前开关状态 */
function currentStates(stored) {
  return paymentRules.channelStates(stored.platforms, allIds());
}

/** 各渠道凭证是否已完整填写 */
function configuredMap(stored) {
  const m = {};
  for (const id of allIds()) m[id] = paymentProviders.isConfigured(id, stored.platforms[id]);
  return m;
}

/* ============================ 读取 ============================ */

/* ============================ 订单管理 ============================ */

/**
 * 订单列表（管理员）
 *
 * 文件名 / 对象键在创建订单时已**快照**进订单，因此分享链接被删除后，
 * 这里依然能回答"这笔钱是为什么付的"—— 只存 linkId 是做不到这点的。
 */
router.get('/payment/orders', requireAdmin, (req, res) => {
  try {
    const rows = paymentOrders.listAll().map((o) => {
      const link = shareStore.get(o.linkId); // 链接可能已被删除
      const p = paymentProviders.platform(o.platform);
      return Object.assign(paymentOrders.view(o), {
        fileName: o.fileName || (link ? link.fileName : ''),
        fileKey: o.fileKey || (link ? link.key : ''),
        /**
         * R48：「收入统计」要按文件与存储桶归集，因此订单行必须带出桶名。
         * 判据收口在 `paymentOrders.bucketOf()`（订单快照优先 → 回退现存链接 → 否则留空），
         * 这里不另写一份 —— 「同一状态两个实现」是历轮审计反复命中的形态。
         */
        bucket: paymentOrders.bucketOf(o, link),
        // 链接是否已不存在：管理页据此把链接列显示为"已删除"，而不是一个点了 404 的死链
        linkExists: Boolean(link),
        linkUrl: '/s/' + o.linkId,
        platformName: (p && p.name) || o.platform,
      });
    });
    /**
     * R84（M-3）：把「订单账本读不出来」这件事**上报到管理端**。
     *
     * `payments.json` 解析失败时 `load()` 只做两件事：返回内存空表、锁定写入（不覆盖
     * 现场，FUN-01）。它从没告诉上游「订单系统不可用」—— 于是管理页看到的是一片
     * 空，像是「从来没卖出去过」，而买家手里的票据重启后就全失效了。
     *
     * 这个字段不是给前端做买卖判定的，纯粹是"让坏了这件事可见"：与
     * `ip-guard` 的 `rulesLoadDegraded` 同款做法。
     */
    res.json({ orders: rows, degraded: paymentOrders.isDegraded() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除全部「支付失败」的订单（管理端「删除失效订单」按钮）。
 *
 * 与 `POST /payment/orders/:id/refund` 同级保护：同样是**批量且不可逆**的写操作，
 * 抹掉的又是对账页上的历史流水，因此必须沿用 `requireAdmin`。
 *
 * 只删 `failed` —— `paid` / `refunded` 是钱流动过的凭据，超出支付窗口的 `pending`
 * 也刻意保留（R14-03：付款者可能正在收银台上）。这条判据的**唯一实现点**是
 * `paymentOrders.removeFailed()`，本路由不重复实现，只负责鉴权、留痕与回包。
 *
 * 删除条数为 0 时不留日志：没有发生任何变更，写一条「删了 0 条」只会稀释审计日志。
 */
router.delete('/payment/orders/failed', requireAdmin, (req, res) => {
  try {
    const removed = paymentOrders.removeFailed();
    if (removed > 0) {
      statsStore.addLog({
        action: 'payment.delete-failed',
        level: 'warn',
        detail: `管理员「${req.authUser.username}」删除失效订单 ${removed} 条（均为「支付失败」状态的订单）`,
      });
    }
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 标记订单为「已退款」（人工记账，非网关退款）。
 *
 * 本系统**不代持资金** —— 这笔钱从未经过本服务器，退款是在微信/支付宝/PayPal 后台
 * 手动完成的。这里只做一件事：把订单置为 `refunded`，让它的支付凭证失效，
 * 并从「已收」统计里扣除。因此没有也不需要任何网关调用。
 *
 * 只允许作用于 `paid`：其余状态的订单退无可退（钱还没进账 / 已经退过了）。
 */
router.post('/payment/orders/:id/refund', requireAdmin, (req, res) => {
  try {
    const target = paymentOrders.get(req.params.id);
    if (!target) return res.status(404).json({ error: '订单不存在' });
    if (target.status !== 'paid') {
      const why = target.status === 'refunded' ? '该订单已标记为已退款'
        : target.status === 'failed' ? '该订单未支付成功，无需退款'
          : '该订单尚未完成支付，无法退款';
      return res.status(400).json({ error: why });
    }
    const o = paymentOrders.markRefunded(req.params.id);
    /**
     * R62（需求 8）：退款后让「定向券」对该用户**可重新使用**。
     *
     * 口径按需求原文：只有**非「无门槛」**的券才回退 —— 无门槛券是面向所有人的
     * 公共券，它的一次核销不随某个人的退款而返还；而「限特定链接 / 限特定用户」
     * 本质上是发给这个人的，钱退了就该还给他。
     *
     * ⚠️ 判据用订单上的 `couponType` **快照**，而不是现查券记录：券可能已被删除、
     * 或事后被改成别的类型，而「当时那张券是什么类型」才决定这次退款要不要回退。
     * 回退按**订单号**定位（`releaseByOrder`），不是按身份 —— 同一用户可能用同一张券
     * 下过多笔订单，只按身份删会把他其它订单的核销记录一并抹掉。
     */
    let couponReleased = null;
    if (o.couponId && o.couponType && o.couponType !== 'any') {
      couponReleased = couponStore.releaseByOrder(o.id);
    }
    statsStore.addLog({
      action: 'payment.refund', level: 'warn',
      detail: `管理员「${req.authUser.username}」将订单 ${o.id} 标记为已退款（¥${paymentRules.formatAmount(o.amountFen)}，原支付凭证已失效）`
        + (couponReleased ? `；优惠券 ${o.couponId} 已对该用户恢复可用` : ''),
    });
    res.json({ ok: true, order: paymentOrders.view(o) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 渠道品牌图形（内联 SVG）——与 `GET /api/payment/config` **分开下发**。
 *
 * R92：四个渠道的内联 SVG 合计约 19 KB（云闪付一个就 8 条路径），塞进配置接口会让
 * 那份响应从 ~9 KB 涨到 ~25 KB。而配置接口是「每次打开支付设置都要拉」的，
 * 图形却是**恒定不变**的代码内常量 —— 用一份每次都传的字节去换一个可以缓存一周的东西，
 * 是这个接口唯一能把体积压下来的地方。
 *
 * 因此：配置接口只给平台定义（`clientSchema()` 已不再含 `logo`），图形走这里，
 * 带 `private, max-age=604800`（一周）。Express 默认会为响应算 ETag，
 * 过期后重访也是 304 而不是重新传一遍。
 *
 * `private` 是必须的：同源里还有普通用户，图形本身不敏感，但这条路由挂着
 * `requireAdmin`，缓存语义不该暗示它可以被共享代理留存。
 *
 * 未知平台不会出现在 `allIds()` 里，因此这里无需额外的白名单判断。
 */
router.get('/payment/logos', requireAdmin, (req, res) => {
  const logos = {};
  for (const id of allIds()) logos[id] = paymentLogos.logo(id, { size: 'sm' });
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.json({ logos });
});

/**
 * 读取全部平台的表单定义 + 已保存的配置（一次请求拿全，避免前端按平台轮询）
 */
router.get('/payment/config', requireAdmin, (req, res) => {
  try {
    const stored = configStore.getPayment();
    const states = currentStates(stored);
    const ready = configuredMap(stored);
    const settings = {};
    for (const p of paymentProviders.list()) {
      const view = paymentProviders.publicView(p.id, stored.platforms[p.id]);
      settings[p.id] = {
        values: view.values,
        configured: view.configured,
        complete: ready[p.id],
        enabled: !!states[p.id],
        available: !!states[p.id] && !!ready[p.id],
      };
    }
    res.json({
      enabled: stored.enabled,
      siteUrl: stored.siteUrl || '',
      platforms: paymentProviders.clientSchema(),
      settings,
      // 当前真正可用于收款的渠道（开关已开且凭证完整）—— 前端据此提示"待补全"
      availableChannels: paymentRules.availableChannels(states, ready),
      updatedAt: stored.updatedAt || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ 总开关 ============================ */

/** 启用 / 停用支付功能（停用不影响任何已保存配置，仅让付费逻辑整体不生效） */
router.put('/payment/enabled', requireAdmin, (req, res) => {
  try {
    const on = Boolean(req.body && req.body.enabled);
    const stored = configStore.getPayment();
    const chk = paymentRules.checkGlobalToggle(on, currentStates(stored));
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    const after = configStore.setPaymentEnabled(on);
    logChange(req, 'toggle', `${on ? '启用' : '停用'}支付功能`);
    res.json({
      ok: true,
      enabled: after.enabled,
      availableChannels: paymentRules.availableChannels(currentStates(after), configuredMap(after)),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 站点对外地址 —— 支付网关回调与支付完成回跳的目标。
 *
 * 本机回环地址收不到公网回调，生产环境必须填对外可达的 https 地址；
 * 留空则按每次请求的 Host 兜底（仅适合本地调试）。
 *
 * R17-03：**形状合法 ≠ 属于本站**。该值会被 `share-routes.siteUrlFor()` 拼成
 * `return_url` / `notify_url` 交给支付网关，支付完成后由**网关**把用户浏览器
 * 重定向过来 —— 指向外站即是一条「经支付网关背书」的开放重定向。因此除形状外
 * 还要能回答「这是不是本站」，判据与 HTTPS 跳转同源（`security.isOwnSiteHost`：
 * 本机 HOST + 已配置的主域名 / 备用域名）。
 */
router.put('/payment/site-url', requireAdmin, (req, res) => {
  try {
    const raw = String((req.body && req.body.siteUrl) || '').trim();
    let url = raw.replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      return res.status(400).json({ error: '站点对外地址必须是 http(s):// 开头的完整地址' });
    }
    if (url && !security.isOwnSiteHost(url, [req.headers.host])) {
      return res.status(400).json({
        error: '站点对外地址必须是本站地址（本机主机名或已在系统中配置的主域名 / 备用域名）',
      });
    }
    const after = configStore.setPaymentSiteUrl(url);
    logChange(req, 'site-url', url ? `将站点对外地址设为 ${url}` : '清除站点对外地址（改为按请求 Host 兜底）');
    res.json({ ok: true, siteUrl: after.siteUrl || '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 渠道开关 ============================ */

/** 启用 / 停用某一支付渠道（总开关启用时不允许关闭最后一个） */
router.put('/payment/config/:platform/enabled', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) return res.status(404).json({ error: `未知的支付平台：${id}` });
  try {
    const on = Boolean(req.body && req.body.enabled);
    const stored = configStore.getPayment();
    const states = currentStates(stored);
    const chk = paymentRules.checkChannelToggle(states, id, on, stored.enabled);
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    const after = configStore.setChannelEnabled(id, on);
    const p = paymentProviders.platform(id);
    logChange(req, 'channel', `${on ? '启用' : '停用'}支付渠道「${p.name}」`);
    res.json({
      ok: true,
      platform: id,
      enabled: !!currentStates(after)[id],
      available: !!currentStates(after)[id] && !!configuredMap(after)[id],
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 凭证校验与保存 ============================ */

/**
 * 仅校验不保存（界面「校验」按钮）
 * 与保存走同一份 validate()，保证"先校验看到通过、点保存就一定通过"。
 */
router.post('/payment/config/:platform/validate', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    // 敏感字段留空时沿用已保存的值参与校验，否则"已配置但未改动"会被误判为必填缺失
    const prev = stored.platforms[id] || {};
    const merged = paymentProviders.applySave(id, prev, req.body || {});
    const r = paymentProviders.validate(id, merged);
    res.json({ ok: r.ok, errors: r.errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 凭据自检（R92）：拿**当前填写的**凭据真的去向网关发一次**只读**请求。
 *
 * 与上面的「校验」是两件事，刻意分成两个端点、两个按钮：
 *  · `validate` 只做本地格式校验（长度 / 正则 / 枚举），**不出网**，答案永远确定；
 *  · `selftest` 真的出网，回答的是「这套凭据网关到底认不认」——
 *    公钥填错（填成应用公钥）、云闪付 `signMethod` 与入网不一致、微信私钥与证书
 *    序列号不是一对、PayPal secret 已重置，这四类错在本地**全部合法**，只会在
 *    真实付款那一刻炸，而那时钱已经出账。
 *
 * 入参是**表单当前值**（`applySave` 与已保存值合并），因此不必先保存再自检 ——
 * 填完就能验；留空的敏感字段沿用旧值，与「校验」一致。
 *
 * 先过一遍 `validate()`：字段都不全就出网，只会拿到一堆无意义的网关错误码。
 */
router.post('/payment/config/:platform/selftest', requireAdmin, asyncHandler(async (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  const stored = configStore.getPayment();
  const prev = stored.platforms[id] || {};
  // 与保存完全同一条合并路径（敏感字段留空 = 沿用旧值），否则「已配置但没改动」
  // 会被当成必填缺失，自检根本发不出去
  const merged = paymentProviders.applySave(id, prev, req.body || {});
  const chk = paymentProviders.validate(id, merged);
  if (!chk.ok) {
    return res.status(400).json({ error: '凭据填写不完整或格式不正确，无法发起自检', errors: chk.errors });
  }

  const r = await paymentGateway.probeCharge(id, merged);
  const p = paymentProviders.platform(id);
  /**
   * 审计只记「谁、哪个平台、什么结论、网关原话（截断）」——
   * 自检本身不含资金操作，但它会携带商户凭据出网，留痕的价值在于
   * 「出问题时能回答：这个凭据是哪天被谁验证过的」。
   */
  statsStore.addLog({
    action: 'payment.selftest',
    level: r.ok ? 'info' : 'warn',
    detail: `管理员「${req.authUser.username}」对支付渠道「${p.name}」执行凭据自检：`
      + `${r.ok ? '通过' : '未通过'}（${r.state}）`
      + (r.detail ? `；网关答复：${String(r.detail).slice(0, 120)}` : ''),
  });
  res.json({ ok: r.ok, state: r.state, message: r.message, detail: r.detail });
}));

/** 保存某一平台的凭证（校验通过才落盘） */
router.put('/payment/config/:platform', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    const prev = stored.platforms[id] || {};
    const patch = req.body && typeof req.body === 'object' ? req.body : {};

    // 全空提交 = 清空该平台配置（不报错）
    const merged = paymentProviders.applySave(id, prev, patch);
    const hasAny = Object.keys(merged).length > 0;

    /**
     * R27-18：**全空提交等价于「清除该渠道凭证」**，必须与 DELETE 走同一道约束校验。
     *
     * `savePayment(id, {})` 会 `delete platforms[id]`（连同 `enabled` 一起删掉），
     * 而 DELETE 路由有 `checkChannelToggle` 兜着、这里没有 —— 于是同一种管理员意图
     * （「清掉最后一条渠道的凭证」）走 DELETE 会被 400 拦下，走 PUT 却被静默接受，
     * 配置停在「总开关开着、零渠道」这个代码明确定义为非法的状态。运行时
     * `resolvePaidState` 返回 `no-channel / effective:false` ⇒ **所有付费链接静默变成
     * 免费下载**，而界面上不会有任何错误提示。
     */
    if (!hasAny) {
      const chk = paymentRules.checkChannelToggle(currentStates(stored), id, false, stored.enabled);
      if (!chk.ok) return res.status(400).json({ error: chk.message });
    }

    if (hasAny) {
      const r = paymentProviders.validate(id, merged);
      if (!r.ok) {
        return res.status(400).json({
          error: '凭证校验未通过，未保存任何内容',
          errors: r.errors,
        });
      }
    }

    // 首次为该平台填写凭证时默认**开启**该渠道 —— 用户既然在配它，
    // 意图显然是要用；之后是否停用由渠道开关显式控制。
    const firstTime = Object.keys(prev).length === 0;
    if (hasAny && firstTime) configStore.setChannelEnabled(id, true);

    const after = configStore.savePayment(id, merged);
    const view = paymentProviders.publicView(id, after.platforms[id]);
    const p = paymentProviders.platform(id);
    logChange(req, 'save', hasAny ? `更新支付渠道「${p.name}」凭证` : `清空支付渠道「${p.name}」凭证`);

    const states = currentStates(after);
    const ready = configuredMap(after);
    res.json({
      ok: true,
      platform: id,
      values: view.values,
      configured: view.configured,
      complete: ready[id],
      enabled: !!states[id],
      available: !!states[id] && !!ready[id],
      updatedAt: after.platforms[id] ? after.platforms[id].updatedAt || '' : '',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** 清除某一平台的凭证（会连带关闭该渠道，故同样受"至少一个渠道"约束） */
router.delete('/payment/config/:platform', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    // 清凭证意味着该渠道不再可用，等价于把它关掉 —— 因此提前做一次约束校验，
    // 避免出现"总开关开着、却一个渠道都没有"的非法状态。
    const chk = paymentRules.checkChannelToggle(currentStates(stored), id, false, stored.enabled);
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    configStore.clearPayment(id);
    const p = paymentProviders.platform(id);
    logChange(req, 'clear', `清除支付渠道「${p.name}」凭证`);
    res.json({ ok: true, platform: id, enabled: false, available: false });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
