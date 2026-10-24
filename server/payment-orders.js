/**
 * 付费订单存储与状态机 —— data/payments.json（经 secure-store 加密落盘）
 *
 * 状态机（对应需求三：未支付 / 支付中 / 支付失败 / 已支付，外加人工退款）：
 *
 *   （发起）→ pending ──确认成功──→ paid ──管理员标记退款──→ refunded → 拒绝下载（凭证失效）
 *                    └──确认失败──→ failed ───────────────→ 拒绝下载，可重新发起
 *
 * 只有 `paid` 允许下载；`pending`、`failed`、`refunded` 一律拦截并给出对应提示。
 * `refunded` 是**不可逆终态**：网关查单仍会说"已支付"，但本端不认（见 markPaid）。
 *
 *   本系统**不代持资金**：`refunded` 只是人工记账（"钱已在其它渠道退还"），
 *   没有任何网关侧退款调用，也没有 `/pay/refund` 之类的模拟端点。
 *
 *   已接入支付宝 / 微信支付 / PayPal 三个真实网关（`payment-gateway.js`），
 *   模拟开关 `PAYMENT_MOCK` 与模拟端点 `/pay/confirm` **均已删除，不得复活**。
 *
 *   判定原则是**只认服务端主动查单**：全库只有 `share-routes.finalizeOrder()`
 *   会调用 `markPaid`，而它先向网关查单、拿到"确实已支付"才改状态。
 *   异步通知与回跳只当**触发器**用，其内容一律不采信；查单异常按"未支付"处理
 *   （fail-closed）。已支付订单不允许后续失败回调改判。
 *
 * 设计要点：
 *  - 金额以「分」为整数**快照**进订单：分享者事后改价，已支付订单依然有效
 *    （下载者确实付过那个价钱），新订单才按新金额计算。
 *  - 已支付凭证用 HMAC 票据绑定「链接 + 订单」，无法被猜测或跨链接复用。
 *  - 文件名 / 对象键同样**快照**进订单：分享链接被删除后，订单管理页仍要能
 *    回答"这笔钱是为哪个文件付的"。只存 linkId 的话，删链接 = 订单失去上下文。
 *
 * ## R64：两个「订单号」
 *
 * | 字段 | 谁看得见 | 用途 |
 * | --- | --- | --- |
 * | `id` | 内部 | 记录主键；**同时是支付网关侧的商户订单号**（`out_trade_no` / `reference_id`） |
 * | `orderNo` | 用户 | 36 位「时间戳 + 链接 UID + 用户 UID + 随机串」，售后与「恢复购买」的唯一凭证 |
 *
 * 为什么不把 `id` 直接换成长订单号：微信支付 v3 的 `out_trade_no` **最长 32 位**，
 * 而需求要求订单号 36 位 —— 把 36 位塞进去，微信渠道会整条不可用（下单直接报参数
 * 错误），且通知里的 `out_trade_no` 再也无法精确定位订单。两个标识各司其职：
 * 网关只认短的那个（历史订单的 `id` 本来就是它），用户只认长的那个。
 *
 * `orderNo` 的生成 / 校验全部收口在 `server/order-no.js`，本模块只负责**存**与
 * **查**（并保证同一店铺内不撞号）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configStore = require('./config-store');
const secureStore = require('./secure-store');
const statsStore = require('./stats-store');
const coalesce = require('./coalesce');
const orderNo = require('./order-no');

// 数据目录：走 data-dir.js 的唯一实现点（`S3_DATA_DIR`），与 tests/helpers.js 约定的
// 隔离手段一致 —— 未设置时落到项目 data/，
// 测试进程可指向临时目录，避免在真实 data/ 里留下订单垃圾。
const DATA_DIR = require('./data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'payments.json');

/** 单个链接最多保留的订单数（超出后丢弃最旧的终态订单，防止文件无限增长） */
const MAX_ORDERS_PER_LINK = 50;

/**
 * R14-03：`pending` 订单的**不可裁窗口**。
 *
 * 发起支付的人此刻可能正在跳往收银台：异步通知到达时要用这条订单定位
 * （`resolveNotifiedOrder` → `get(tradeNo)`），拿到它才会走 `finalizeOrder`。
 * 在这段窗口里把它裁掉，后果是 **钱已付、订单查无此单、文件永远拿不到**，
 * 且没有任何告警——本模块唯一一条会直接造成经济损失的裁剪。
 *
 * 取 2 小时：覆盖主流网关的下单有效期（支付宝默认 2h、微信 2h、PayPal 约 3h 的下限），
 * 且远大于「下单 → 付款 → 通知到达」的实际链路耗时。
 */
const PENDING_KEEP_MS = (() => {
  const raw = Number(process.env.PAYMENT_PENDING_KEEP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2 * 60 * 60 * 1000;
})();
/**
 * R8-25：**全局**订单数上限（跨链接）。
 *
 * 为什么单链接上限不够：`prune(linkId)` 只处理指定链接，而它的唯一调用点在
 * `create()` 内。于是「发起支付 → 删除链接」这个循环会让该 linkId **再也不会**
 * 被 prune 触及（删链接不影响既有订单，这是刻意的：订单要保留以证明"付的是什么"），
 * `payments.json` 于是无界增长。后果是随使用时长的性能衰减 ——
 * 管理端订单页每次全表排序，`persist()` 每次全量序列化。
 *
 * 保留集恒为**全部 `paid` / `refunded`**：那是钱真正流动过的对账凭据，
 * 任何情况下都不能裁（裁掉退款记录就再也证明不了"这笔钱退过"，
 * 只能看到收了一笔、对应文件还被免费下载了）。因此若全是终态订单，
 * 宁可超限也不裁 —— 上限只约束可再造的 `pending` / `failed` 流水。
 *
 * 与 `limits.js` 的列举上限同一惯例：可用环境变量覆盖，便于受控压测与回归护栏
 * 用小上限驱动这条分支（否则要真的造两万笔订单才能碰到它）。
 */
const MAX_ORDERS_TOTAL = (() => {
  const raw = process.env.PAYMENT_MAX_ORDERS_TOTAL;
  if (raw === undefined || raw === '') return 20000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20000;
})();

/**
 * R14-09：订单落盘的**去抖窗口**（毫秒）。
 *
 * 一次真实支付流程会连续触发 `setTradeNo` / `markPaid` / `markDownloaded` 三次
 * `persist()`，而 `POST /s/:id/pay` 又是匿名可达的（20 次/10 分钟/每 IP+链接，
 * 可跨 IP 叠加）。旧实现每次都全量序列化 + 加密 + 写盘，且缩进序列化下
 * 两万条订单约 6~8MB —— 单个支付动作在事件循环上同步阻塞数百毫秒，
 * 单笔无害、量涨到一定规模后突变为全站卡顿（典型的「温水型」性能债）。
 *
 * 中间态既没人读、也活不过一个去抖窗口，所以合并掉；真正需要落盘的只有最后一次。
 * 与 `config-store` 的 250ms 同一量级。`PAYMENT_WRITE_DEBOUNCE_MS=0` 是逃生阀
 * （退回「立即写」，排查落盘问题时用）。
 *
 * 「窗口内进程被强杀会丢最后一次变更」由两处兜住：优雅停机走 `flush()`，
 * 强制退出走 `coalesce` 的统一退出钩子（同步写 + 只写不建）。
 */
const PAYMENT_WRITE_DEBOUNCE_MS = (() => {
  const raw = process.env.PAYMENT_WRITE_DEBOUNCE_MS;
  if (raw === undefined || raw === '') return 300;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
})();

let cache = null;
/**
 * 读取失败标志（FUN-01）。
 *
 * 只要**任何一次** load() 没能拿到可信数据，就必须永久拒绝写入 ——
 * 否则内存里的 `{orders: []}` 会在下一次 create() 时被落盘，
 * 把磁盘上那份（可能还能人工抢救的）订单文件整体覆盖成空表。
 *
 * 这条护栏的价值在于它**不区分失败原因**：无论是文件真的损坏，
 * 还是本模块自己有代码缺陷（历史上就是漏 require('fs') 导致每次 load 都抛
 * ReferenceError），后果都被限制在「本次进程内订单不可用」，
 * 而不会升级成「历史订单被静默清空」。
 */
let loadFailed = false;

function load() {
  if (cache) return cache;
  if (loadFailed) return { orders: [] }; // 已失败过：不再重试、不再刷屏
  try {
    if (!fs.existsSync(FILE)) { cache = { orders: [] }; return cache; }
    const raw = secureStore.readJson(FILE, null);
    if (raw && Array.isArray(raw.orders)) {
      cache = raw;
      return cache;
    }
    // 文件存在且能解析，但结构不是预期的 { orders: [...] } —— 同样视为不可信
    throw new Error('内容结构不是预期的 { orders: [] }');
  } catch (e) {
    loadFailed = true;
    // 非「文件损坏」的异常（代码缺陷）额外打出堆栈，避免再被当成"文件坏了"误导排障
    if (e && e.corrupt) console.error('[payment-orders] 订单文件损坏，已降级为空列表并锁定写入：', e.message);
    else console.error('[payment-orders] 读取订单文件失败（非文件损坏，请检查代码），已锁定写入：', (e && e.stack) || e);
  }
  cache = { orders: [] };
  return cache;
}

/**
 * 落盘队列（R14-09：去抖合并写）。
 *
 * 唯一实现点是 `coalesce.debouncedPersist()` —— 本模块不再直接调用
 * `secureStore.writeJsonAsync`。快照取 `cache` 本身（内存里那份活对象），
 * 由 `coalesce` 在**真正落盘那一刻**才序列化：
 *  - `loadFailed` 必须在这里拦住 —— 内存里的 `{orders: []}` 一旦落盘，
 *    磁盘上那份（可能还能人工抢救的）订单文件就被整体覆盖成空表（FUN-01）；
 *  - `cache` 尚未加载时同样不写（`persist()` 只在变更之后被调用，正常路径
 *    上 `cache` 必定已有值；这里只是兜住「万一」）。
 */
const writer = coalesce.debouncedPersist(
  FILE,
  () => (loadFailed || !cache ? null : cache),
  { debounceMs: PAYMENT_WRITE_DEBOUNCE_MS, dataDir: DATA_DIR },
);

function persist() {
  if (loadFailed) return; // 读取失败过 → 绝不落盘，防覆盖
  writer.schedule();
}

/**
 * R84（M-3）：订单存储是否处于「读不出来」的降级态。
 *
 * `loadFailed` 原本只护住一件事 —— **不把内存空表写出去**（FUN-01，防覆盖可抢救的数据）。
 * 但它没有向上游传递「订单系统此刻不可用」：下单、收款、签票据、放行下载全都在这份
 * **空表**上正常运行，进程重启后订单与票据一起消失，管理页也只剩空表。
 * 结果就是「买家付过钱 → 重启 → 查无此单」。
 *
 * 所以把它变成可问的状态：`POST /s/:id/pay` 命中即**拒绝收款**（fail-closed，
 * 与加密模块 F-E1 同构），管理端订单页渲染告警横幅（与 `ip-guard` 的
 * `rulesLoadDegraded` 同款「读到了但坏了必须可见」）。
 *
 * ⚠️ 必须先 `load()` 再返回：`loadFailed` 的初值是 `false`，只有真的读过一次才有意义。
 * 判据读**调用之后**的状态 —— 这个坑 R82 的 `sweepStalePending()` 已经踩过一次。
 */
function isDegraded() {
  load();
  return loadFailed;
}

/** 取消去抖并立即落盘（优雅停机走 `index.js`，测试用它驱动落盘断言） */
function flush() { writer.flush(); }

function newId() {
  return crypto.randomBytes(12).toString('base64url');
}

function masterKey() {
  return configStore.getMasterKey();
}

/* ============================ 生命周期 ============================ */

/**
 * 创建订单（pending）
 * @returns {object} 订单（内部形态）
 */
function create({
  linkId, platform, amountFen, currency, payerIp, fileName, fileKey, bucket, tradeNo,
  // R62：优惠券相关的**快照**。券可能事后被删除 / 改配置，订单必须自己记住
  // 「原价多少、优惠多少、用的是哪张券」，否则历史订单的对账信息会随券一起消失。
  originalFen, discountFen, couponCode, couponId, couponType,
  // R64：下单人身份（已登录时非空）。「查看历史订单」按它归集；游客为空，
  // 其订单只能凭订单号取回（见 claimForLink）。
  userId, userName,
}) {
  const orders = load().orders;
  const now = new Date().toISOString();
  const paid = Number(amountFen) || 0;
  const orig = Number(originalFen) > 0 ? Number(originalFen) : paid;
  /**
   * R64：订单号。撞号即重摇（同一毫秒 + 同一链接 + 同一账号时只有 5 位随机串
   * 在变，62^5 ≈ 9.2e8，正常业务量下几乎不可能撞；但"几乎"不是"绝不"，
   * 而两笔订单共用同一个取回凭证的后果是**付了钱却取回别人的订单**）。
   */
  let made = orderNo.compose({ linkId, userId });
  for (let i = 0; i < 8 && orders.some((x) => x.orderNo === made.no); i++) {
    made = orderNo.compose({ linkId, userId });
  }
  const o = {
    id: newId(),
    /**
     * 36 位用户可见订单号（见 `server/order-no.js`）。它是「恢复购买」的输入，
     * 也是用户唯一需要保存的东西 —— 与他看到的、抄下来的**逐字符相同**。
     */
    orderNo: made.no,
    linkUid: made.linkUid, // 订单号里那一段的可读副本（对账 / 排障用）
    userUid: made.userUid, // 同上；游客为按单随机的 9 位
    userId: String(userId || ''), // R64：账号 id（游客为空串）
    userName: String(userName || ''), // 快照用户名：账号被删后历史订单仍可读
    linkId: String(linkId),
    platform: String(platform || ''),
    amountFen: paid,
    /**
     * `originalFen` 是**订单当时**的原价，`discountFen` 是**这张订单上真的减掉**
     * 的金额（券面额大于原价时按「原价 − 1 分」封顶，见 coupon-store.computePayable）。
     * 三者必须满足 `originalFen − discountFen === amountFen` —— 这是订单页
     * 「原价 / 优惠 / 应付」三列能对上的唯一保证。
     */
    originalFen: orig,
    discountFen: Math.max(0, Number(discountFen) || 0),
    couponCode: String(couponCode || ''),
    couponId: String(couponId || ''),
    couponType: String(couponType || ''),
    currency: currency || 'CNY',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    refundedAt: null, // 由管理员标记的退款时间（本系统不代持资金，无网关退款调用）
    downloadedAt: null, // 是否已下载（付费下载的核心对账字段）
    /**
     * R65：凭订单号成功取回下载权限的次数（由 `claimForLink()` 在成功时自增）。
     * 历史订单没有这个字段 ⇒ 读侧按 0 处理（`Number(x) || 0`），等价于「一次都没取回过」。
     */
    restoreCount: 0,
    lastRestoredAt: null,
    failReason: '',
    payerIp: String(payerIp || ''),
    // 文件快照：链接删除后仍能回答"付的是什么"
    fileName: String(fileName || ''),
    fileKey: String(fileKey || ''),
    /**
     * R48：存储桶同样**快照**下来 —— 「收入统计」要回答「这笔钱来自哪个桶」，
     * 而链接一旦被删就再也查不到所属桶了（`linkId` 指向的记录已不存在）。
     * 历史订单没有这个字段，读侧回退到「按 linkId 查现存链接」（见 routes/payment.js）。
     */
    bucket: String(bucket || ''),
    // 网关侧的订单号（支付宝 trade_no / 微信 transaction_id / PayPal order id）
    tradeNo: String(tradeNo || ''),
  };
  orders.push(o);
  /**
   * R14-09：`prune()` 是**全表** filter + sort（`mine = all.filter(...)`），
   * 而它内部第一件事就是「该链接的订单数 ≤ 单链接上限就返回」。
   * 链接内订单数**必 ≤** 全表订单数，故 `orders.length > MAX_ORDERS_PER_LINK`
   * 这个 O(1) 判断可以安全地短路掉绝大多数 `create()` 上的全表扫描 ——
   * 裁剪结果完全等价（包括 `prune()` 末尾那条「上限被受保护订单占满」的告警：
   * 它只在 `mine.length > MAX_ORDERS_PER_LINK` 时才可能触发，那时总量必然也超限）。
   */
  if (orders.length > MAX_ORDERS_PER_LINK) prune(o.linkId);
  pruneGlobal(); // R8-25：跨链接的兜底上限（自身已带 O(1) 前置判断，超限才排序）
  persist();
  return o;
}

/**
 * 该订单是否**不可裁**（对账凭据，或仍在支付窗口内）。
 *
 * - `paid` / `refunded`：钱已经流动过，是对账凭据；
 * - 窗口内的 `pending`：付款者可能正在收银台，裁掉 = 钱付了拿不到文件（R14-03）；
 * - 其余（`failed`、超窗的 `pending`）按可再造的流水处理，允许裁剪。
 *
 * 年龄不可判定时按「在窗口内」保护 —— 宁可多留一条，不可裁掉在途付款。
 */
function isProtected(o, now) {
  if (o.status === 'paid' || o.status === 'refunded') return true;
  if (o.status !== 'pending') return false;
  const t = Date.parse(o.createdAt || '');
  if (!Number.isFinite(t)) return true;
  return now - t < PENDING_KEEP_MS;
}

/**
 * 裁剪动作必须留痕：以前它是静默的，订单丢了没人知道。
 */
function warnPruned(scope, n, extra) {
  try {
    statsStore.addLog({
      action: 'payment.prune', level: 'warn',
      detail: `订单裁剪：${scope} 丢弃 ${n} 条${extra ? `（${extra}）` : ''}`
        + ' —— 只有终态与超出支付窗口的 pending 可被裁，在途订单被裁会导致「钱付了拿不到文件」',
    });
  } catch (e) { /* 日志写不进去不应阻断业务 */ }
}

/**
 * 按链接裁剪：保留最近 MAX_ORDERS_PER_LINK 条，其余丢弃。
 *
 * 「永不裁剪」的集合包括已支付**与已退款**：两者都是钱已经流动过的记录，
 * 是对账凭据。若把退款订单裁掉，日后就无从证明「这笔钱退过」，
 * 只能看到收了一笔、对应文件还被免费下载了。
 *
 * 以及**仍在支付窗口内的 `pending`**（R14-03）—— 详见 {@link PENDING_KEEP_MS}。
 * 受保护的条目不计入上限配额，因此极端情况下（全是窗口内 pending）订单数会暂时超限：
 * 这是刻意的取舍，**宁可文件涨一会儿，不可裁掉一笔在途付款**。
 */
function prune(linkId) {
  const all = load().orders;
  const mine = all.filter((o) => o.linkId === linkId);
  if (mine.length <= MAX_ORDERS_PER_LINK) return;
  const now = Date.now();
  const frozen = new Set(mine.filter((o) => isProtected(o, now)).map((o) => o.id));
  const rest = mine
    .filter((o) => !frozen.has(o.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const keep = new Set(frozen);
  for (const o of rest.slice(0, Math.max(0, MAX_ORDERS_PER_LINK - frozen.size))) keep.add(o.id);
  const dropped = mine.length - [...keep].filter((id) => mine.some((o) => o.id === id)).length;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].linkId === linkId && !keep.has(all[i].id)) all.splice(i, 1);
  }
  if (dropped > 0) warnPruned(`链接 ${linkId}`, dropped);
  else if (frozen.size >= MAX_ORDERS_PER_LINK) {
    // 上限被受保护订单占满 —— 多半是有人在灌单，必须可见（否则运维只会看到文件变大）
    warnPruned(`链接 ${linkId}`, 0, `上限 ${MAX_ORDERS_PER_LINK} 已被受保护订单占满，无法裁剪`);
  }
}

/**
 * R8-25：跨链接的全局裁剪，见 {@link MAX_ORDERS_TOTAL} 的说明。
 *
 * 剪裁口径与 {@link prune} **必须同源**（同一把尺子 `isProtected`）：
 * 只裁可再造的流水（`failed`、超出支付窗口的 `pending`）；
 * `paid` / `refunded` 与**窗口内的 `pending`** 永不裁（R14-03）。
 * 候选按 `createdAt` **从旧到新**，优先丢弃最久远的那批。
 *
 * @returns {number} 实际裁掉的条数
 */
function pruneGlobal() {
  const all = load().orders;
  if (all.length <= MAX_ORDERS_TOTAL) return 0;
  const drop = all.length - MAX_ORDERS_TOTAL;
  const now = Date.now();
  const candidates = all
    .filter((o) => !isProtected(o, now))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, drop);
  // 全是受保护状态 —— 宁可超限也不裁对账凭据与在途订单
  if (!candidates.length) return 0;
  const victims = new Set(candidates.map((o) => o.id));
  for (let i = all.length - 1; i >= 0; i--) {
    if (victims.has(all[i].id)) all.splice(i, 1);
  }
  warnPruned('全局', victims.size);
  return victims.size;
}

/**
 * 删除全部「支付失败」订单 —— 管理端「删除失效订单」按钮的**唯一实现点**。
 *
 * 判据刻意**不是**「所有可裁的订单」，而是「`status === 'failed'`」：
 * `prune()` / `pruneGlobal()` 的候选里还包括**超出支付窗口的 `pending`**，
 * 那是一个刻意的灰色地带（R14-03：付款者可能正在收银台上），由自动裁剪按容量兜住即可。
 * 把它塞进这个由管理员手动触发的按钮里，就变成了「点一下静默清掉一批可能还在途的付款」，
 * 而按钮上写的是「支付失败」—— 名实不符的破坏远比少删几条严重。
 *
 * 仍然走一遍 `isProtected()` 是**冗余但刻意的**：它是本模块关于「什么订单不能删」的
 * 唯一判据，将来若给 `failed` 加上保护条件（例如「失败后一段时间内保留以便排查」），
 * 这里会自动跟上，不会演变成第二个各判一套的实现点。
 *
 * `paid` / `refunded` 是钱真正流动过的对账凭据，任何情况下都不进入候选集。
 *
 * @param {number} [now] 判定时刻（测试注入用）
 * @returns {number} 实际删除的条数
 */
function removeFailed(now = Date.now()) {
  const all = load().orders;
  const victims = all.filter((o) => o.status === 'failed' && !isProtected(o, now));
  if (!victims.length) return 0;
  const ids = new Set(victims.map((o) => o.id));
  for (let i = all.length - 1; i >= 0; i--) {
    if (ids.has(all[i].id)) all.splice(i, 1);
  }
  persist();
  return victims.length;
}

function get(id) {
  return load().orders.find((o) => o.id === id) || null;
}

/**
 * R82：把**历史遗留的在途订单**一次性标为失败（用户明确要求）。
 *
 * 为什么需要它：1.9.17 之前，`createCharge` 的出站超时只覆盖响应头（见
 * `payment-gateway.fetchWithTimeout` 的注释），网关「回了头却不吐体」时请求会挂到
 * undici 的 300 秒兜底；而订单在 `await createCharge()` **之前**就已落库为 pending
 * ⇒ 库里因此积下了一批**永远停在「支付中」**的订单。1.9.17 修掉了成因，但这些
 * 存量记录不会自己消失：管理页会一直显示「支付中」，`payerState()` 还会把同一个
 * 浏览器当成「有在途订单」。所以升级时要清一次。
 *
 * ## 三个刻意的设计
 *
 * ① **只跑一次**：结果写进 `payments.json` 顶层的 `staleSwept` 标记。用固定标签
 *    `'R82'` 而不是版本号 —— 写成版本号的话，以后每次升版本都会被判成「还没扫过」，
 *    于是每次升级都把当时**真正在途**的订单误杀一批。这个标记**永远不要改**。
 * ② **读不到就不扫**：`loadFailed` 时直接返回。此时内存里是 `{orders: []}`，
 *    扫一遍等于什么都没做却把标记写下去 —— 等磁盘文件修好，这批订单就再也不会被清了。
 * ③ **可恢复**：`markFailed` 不是终态。若有人恰好在升级这一刻正在付款，网关侧的
 *    异步通知仍会走到 `finalizeOrder()` → 主动查单 → `markPaid()`（`finalizeOrder`
 *    只对 `paid`/`refunded` 提前返回）。钱不会因为这次清理而丢。
 *
 * 与 `removeFailed()` 的区别：那个是**删除**失败订单（管理员手动点），这里只**改状态**，
 * 记录留着，方便管理员对着网关后台逐笔核对。
 *
 * @param {string} [reason] 写进 `failReason` 的原因
 * @returns {{swept: number, skipped: boolean, already?: boolean}}
 */
const STALE_SWEEP_MARK = 'R82';
function sweepStalePending(reason) {
  /**
   * ⚠️ `loadFailed` 必须在 `load()` **之后**再看。
   *
   * 旧写法把它放在前面：首次调用时 `loadFailed` 还是初始的 `false`（这个标志只在
   * `load()` 内部失败时才置位），于是 `load()` 抛错 → 返回空表 → 函数继续往下走 →
   * 「0 笔可清 + 写标记」—— 标记虽然因为 `persist()` 里的 `loadFailed` 守卫没落盘，
   * 但返回值会说 `skipped: false`，调用方（启动日志）就会以为清理成功执行过。
   * 判据要读**调用之后**的状态，不是调用之前的。
   */
  const db = load();
  if (loadFailed) return { swept: 0, skipped: true };
  if (db.staleSwept === STALE_SWEEP_MARK) return { swept: 0, skipped: true, already: true };
  const why = String(reason || '历史在途订单：本版修复了「网关不返回完整响应体时请求会挂 5 分钟」的缺陷，'
    + '升级时统一收尾；此类订单从未完成支付，如需核对请在支付平台后台按商户订单号查询');
  let n = 0;
  for (const o of db.orders) {
    if (o.status !== 'pending') continue;
    o.status = 'failed';
    o.failReason = why;
    o.updatedAt = new Date().toISOString();
    n += 1;
  }
  db.staleSwept = STALE_SWEEP_MARK;
  persist();
  return { swept: n, skipped: false };
}

/**
 * 按**网关侧**订单号查找（异步通知定位订单用）。
 * 微信 / PayPal 的通知里带的是网关订单号，不是我们的订单 id。
 */
function findByTradeNo(tradeNo) {
  const t = String(tradeNo || '');
  if (!t) return null;
  return load().orders.find((o) => o.tradeNo === t) || null;
}

/** 某链接的全部订单（按创建时间倒序） */
function listForLink(linkId) {
  return load().orders
    .filter((o) => o.linkId === String(linkId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * R64：按**用户可见订单号**查找。
 *
 * 同时接受内部的 `id`：R64 之前的订单只有 `id`（那时页面上的「订单号」就是它），
 * 而用户手里可能还留着那个值 —— 售后对账、恢复购买都不该因为"版本升级"而认不出来。
 * 两者的匹配都不区分来源，因此**新旧订单号一律可用**。
 */
function findByOrderNo(no) {
  const raw = String(no || '').trim();
  if (!raw) return null;
  const orders = load().orders;
  /**
   * ⚠️ **精确匹配优先**：老订单的 `id` 是 base64url，可能含 `-` / `_`，
   * 而 `normalize()` 会把这两个字符当成分组符抹掉（新订单号只含字母数字，
   * 抹了没影响）。若一上来就用抹过的串去查，一个恰好含 `-` 的老订单号会
   * 永远查不到 —— 因此先按原样比一遍，再退回"抹掉分隔符"的那一遍。
   */
  const exact = orders.find((o) => o.orderNo === raw || o.id === raw);
  if (exact) return exact;
  const slim = orderNo.normalize(raw);
  if (slim === raw) return null;
  return orders.find((o) => o.orderNo === slim || o.id === slim) || null;
}

/**
 * R64：某个账号的**全部订单**（含未成交的，按创建时间倒序）。
 *
 * 过滤口径交给调用方（分享页只要 `paid` / `refunded`）—— 这里不预设，
 * 否则「历史订单」与「订单管理」会各有一套"什么算历史"的判据。
 *
 * ⚠️ 只认 `userId` 快照，**绝不**按 IP 或昵称近似归集：按 IP 会把同一出口
 * 后面的不同人混在一起（别人买的东西出现在你的历史订单里），那是数据泄露。
 */
function listForUser(userId) {
  const uid = String(userId || '');
  if (!uid) return [];
  return load().orders
    .filter((o) => o.userId === uid)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * R64：「恢复购买」的唯一判定点 —— 订单号 → 可作为下载凭证的订单。
 *
 * 需求前提：**只有「支付成功」的订单**能取回下载权限。因此这里按顺序回答四件事：
 *   ① 订单号存在吗（不存在 / 不属于本链接一律给**同一条**文案，避免把订单号
 *      是否存在变成可探测的预言机）；
 *   ② 它是**这条链接**的订单吗（权威判据是订单上的 `linkId`，不是订单号里的
 *      `linkUid` —— 后者只是派生值，换派生口径不该让历史订单失效）；
 *   ③ 它支付成功了吗（`pending` / `failed` / `refunded` 都拒绝，并各给一条能
 *      指导下一步的文案）；
 *   ④ 通过则返回订单，由路由签发该链接的支付凭证（`orderToken`）。
 *
 * @param {string} no 用户输入的订单号（已归一化）
 * @param {string} linkId 当前分享链接 id
 * @param {{maxUses?: number}} [opts] R65：同一订单号可成功取回的次数上限
 *   （`0` / 缺省 = 不限制；判据在**本函数**里，调用方不得另写一份）
 * @returns {{ok: boolean, reason: string, order: object|null, message: string}}
 *   reason: '' | 'invalid' | 'mismatch' | 'pending' | 'failed' | 'refunded' | 'used_up'
 *
 * ⚠️ **成功时这里会把 `restoreCount` 加一并落盘**：「取回次数」必须在**判定与发放的
 * 同一处**递增，否则两个并发请求会同时读到旧计数（都能过闸门，实际取回 N+1 次）。
 * 这也意味着本函数**不再是一个纯查询** —— 名字仍是 claim（认领），语义就是「认领一次」。
 */
function claimForLink(no, linkId, opts) {
  /**
   * ⚠️ 这里交给 `findByOrderNo()` **原样**处理，不要先 `normalize`：
   * 老订单的 id 是 base64url，可能含 `-` / `_`，先抹掉分隔符就再也命中不了
   * 那笔订单（`findByOrderNo` 内部会先按原样比一遍、再退回抹掉分隔符的那遍）。
   */
  const o = findByOrderNo(no);
  const target = String(linkId || '');
  if (!o || o.linkId !== target) {
    return {
      ok: false,
      reason: 'invalid',
      order: null,
      message: '未找到该订单号，或该订单号不属于当前分享链接。请核对后重试。',
    };
  }
  if (o.status === 'paid') {
    /**
     * R65：取回次数上限。只在 `paid` 之后判、在 `paid` 之内加 —— 未支付 / 已退款 /
     * 已失败的订单本来就取不到，不该消耗这个额度。
     */
    const max = Number(opts && opts.maxUses);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    const used = Math.max(0, Number(o.restoreCount) || 0);
    if (limit > 0 && used >= limit) {
      return {
        ok: false,
        reason: 'used_up',
        order: o,
        message: `该订单号已达到取回次数上限（${limit} 次），不能再凭它取回下载权限。`
          + '如需重新下载，请联系分享者。',
      };
    }
    if (limit > 0) {
      o.restoreCount = used + 1;
      o.lastRestoredAt = new Date().toISOString();
      persist();
    }
    return { ok: true, reason: '', order: o, message: '' };
  }
  if (o.status === 'refunded') {
    return {
      ok: false,
      reason: 'refunded',
      order: o,
      message: '该订单已被分享者标记为已退款，原支付凭证已失效，无法凭它取回下载权限。',
    };
  }
  if (o.status === 'failed') {
    return {
      ok: false,
      reason: 'failed',
      order: o,
      message: '该订单支付未成功，不能作为下载凭证。请完成支付后再试。',
    };
  }
  return {
    ok: false,
    reason: 'pending',
    order: o,
    message: '该订单尚未支付成功。若已付款，请稍等片刻后重试；否则请先完成支付。',
  };
}

/** 某链接已支付订单数（供管理端展示收入概况） */
function paidCountForLink(linkId) {
  return listForLink(linkId).filter((o) => o.status === 'paid').length;
}

/* ============================ 状态流转 ============================ */

/**
 * 标记支付成功（终态；重复调用幂等）
 *
 * 「终态」的字面含义在这里被打破了一次：`refunded` 是比 `paid` 更靠后的终态。
 * 已退款的订单**不得被复活** —— 该订单确实付过钱，网关查单仍会回答"已支付"，
 * 若这里放行，一次异步通知就能把管理员刚退掉的订单重新变成有效凭证，
 * 下载者可以凭它继续下载（白嫖）。同理见 {@link markFailed}。
 */
function markPaid(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status === 'paid' || o.status === 'refunded') return o;
  o.status = 'paid';
  o.paidAt = new Date().toISOString();
  o.failReason = '';
  o.updatedAt = o.paidAt;
  persist();
  return o;
}

/** 标记支付失败（可重新发起新订单，故不是终态语义上的"作废"） */
function markFailed(id, reason) {
  const o = get(id);
  if (!o) return null;
  if (o.status === 'paid' || o.status === 'refunded') return o; // 已支付 / 已退款的订单不允许被改判失败
  o.status = 'failed';
  o.failReason = String(reason || '支付未完成');
  o.updatedAt = new Date().toISOString();
  persist();
  return o;
}

/**
 * 标记为「已退款」（人工记账动作，终态）。
 *
 * 本项目**不代持资金**：网关侧的钱从未经过本系统，因此这里不存在真正的退款调用，
 * 只是在订单上记一笔"这笔钱已在别的渠道退还给下载者"。由此产生两个必然结论：
 *  ① 该订单的支付凭证立即失效 —— 否则退款后仍能凭旧票据下载，等于白嫖；
 *  ② 「已收」统计要把这笔扣掉 —— 钱已经退回去了，账面上就不该再算作收入。
 *
 * 只允许 `paid → refunded`：其余状态（支付中 / 失败 / 已退款）一律原样返回，
 * 由调用方（路由）负责把它翻译成 400。多次调用幂等。
 *
 * @returns {object|null} 订单不存在时返回 null
 */
function markRefunded(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status !== 'paid') return o;
  o.status = 'refunded';
  o.refundedAt = new Date().toISOString();
  o.updatedAt = o.refundedAt;
  persist();
  return o;
}

/** 记录网关侧的订单号（查单 / 对账用） */
function setTradeNo(id, tradeNo) {
  const o = get(id);
  if (!o || !tradeNo) return null;
  o.tradeNo = String(tradeNo);
  o.updatedAt = new Date().toISOString();
  persist();
  return o;
}

/**
 * 标记「已下载」—— 幂等，只记首次。
 *
 * 在**放行下载之后**调用（而不是之前）：下载可能因网络中断而失败，
 * 提前标记会让"付了钱但没拿到文件"的订单在管理页显示成已下载，无法对账。
 */
function markDownloaded(id) {
  const o = get(id);
  if (!o) return null;
  if (o.downloadedAt) return o;
  o.downloadedAt = new Date().toISOString();
  o.updatedAt = o.downloadedAt;
  persist();
  return o;
}

/** 全部订单（管理端用，按创建时间倒序） */
function listAll() {
  return load().orders
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/* ============================ 已支付凭证（Cookie 票据） ============================ */

/**
 * 订单票据：`订单ID.HMAC`。
 * 签名输入同时包含 linkId 与 orderId —— 拿到 A 链接的票据无法用于 B 链接。
 */
function orderToken(order) {
  const body = `${order.linkId}:${order.id}`;
  const sig = crypto.createHmac('sha256', masterKey()).update('pay-order:' + body).digest('hex');
  return `${order.id}.${sig}`;
}

/**
 * 校验票据并取回订单
 * @returns {object|null} 票据无效 / 订单不存在 / 链接不匹配 时为 null
 */
function verifyToken(linkId, token) {
  if (typeof token !== 'string' || !token) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  const o = get(id);
  if (!o || o.linkId !== String(linkId)) return null;
  const expected = orderToken(o).slice(o.id.length + 1);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) {
    return null;
  }
  return o;
}

/**
 * 解析访问者的支付状态 —— 下载拦截的唯一判据
 *
 * `refunded` 与 `paid` **分开返回**：两者历史上都付过钱，但只有 `paid` 放行下载。
 * 若把 refunded 折叠进 pending/failed 里统称为"未支付"，退款者看到的提示会是
 * "请完成支付"——他明明付过，只是钱被退回去了，这是对账场景最需要区分的一类。
 *
 * @returns {{state: 'none'|'pending'|'paid'|'failed'|'refunded', order: object|null}}
 */
function payerState(linkId, token) {
  const o = verifyToken(linkId, token);
  if (!o) return { state: 'none', order: null };
  if (o.status === 'paid') return { state: 'paid', order: o };
  if (o.status === 'refunded') return { state: 'refunded', order: o };
  if (o.status === 'failed') return { state: 'failed', order: o };
  return { state: 'pending', order: o };
}

/**
 * R48：订单的**来源存储桶**（「收入统计」按桶归集时用）。
 *
 * 只有一条判据、只在一处实现：**订单自身的快照优先**，快照为空时回退到「按 linkId
 * 查到的现存链接」。为什么不直接读链接：链接删了就没有了，而订单是终态的对账凭据，
 * 必须能独立回答「这笔钱来自哪个桶」——这正是 `fileName` / `fileKey` 在创建时就
 * 快照下来的同一条理由。
 *
 * 两处都拿不到时返回空串，由界面显示「未知」。**绝不猜一个桶名** ——
 * 猜错等于把一笔收入记到别的桶头上，比留空难查得多。
 *
 * @param {object} order 订单（内部形态，可能没有 bucket 字段 —— 历史订单）
 * @param {object|null} link 该订单对应的分享链接（可能已被删除）
 * @returns {string}
 */
function bucketOf(order, link) {
  const fromOrder = order && order.bucket ? String(order.bucket) : '';
  if (fromOrder) return fromOrder;
  const fromLink = link && link.bucket ? String(link.bucket) : '';
  return fromLink;
}

/** 安全视图（不含 IP 等内部字段） */
function view(o) {
  if (!o) return null;
  return {
    id: o.id,
    /**
     * R64：用户可见订单号。历史订单没有这个字段 ⇒ 回退到 `id`（那时页面上
     * 显示的「订单号」就是它，用户手里留着的也是它）—— 只看 `orderNo` 会让
     * 升级前的订单在订单管理页显示成空单元格。
     */
    orderNo: o.orderNo || o.id,
    linkId: o.linkId,
    platform: o.platform,
    amountFen: o.amountFen,
    // R62：优惠相关快照（历史订单没有这些字段 ⇒ 原价回退为实付、优惠 0、无券）
    originalFen: Number(o.originalFen) > 0 ? Number(o.originalFen) : (Number(o.amountFen) || 0),
    discountFen: Math.max(0, Number(o.discountFen) || 0),
    couponCode: o.couponCode || '',
    couponId: o.couponId || '',
    couponType: o.couponType || '',
    currency: o.currency,
    status: o.status,
    createdAt: o.createdAt,
    paidAt: o.paidAt || null,
    refundedAt: o.refundedAt || null,
    downloadedAt: o.downloadedAt || null,
    /** R65：已凭订单号取回下载权限几次（订单管理页不展示，供排障与售后核对） */
    restoreCount: Math.max(0, Number(o.restoreCount) || 0),
    lastRestoredAt: o.lastRestoredAt || null,
    fileName: o.fileName || '',
    tradeNo: o.tradeNo || '',
    failReason: o.failReason || '',
  };
}

module.exports = {
  MAX_ORDERS_PER_LINK, MAX_ORDERS_TOTAL, PAYMENT_WRITE_DEBOUNCE_MS,
  create, get, findByTradeNo, listForLink, listAll, paidCountForLink,
  // R64：订单号取回 —— 按用户可见订单号查找 / 按账号归集 / 「恢复购买」的唯一判定点
  findByOrderNo, listForUser, claimForLink,
  pruneGlobal, // R8-25：导出以供测试直接驱动跨链接裁剪
  removeFailed, // R32-01：管理端「删除失效订单」（仅 failed；paid/refunded/在途 pending 不动）
  sweepStalePending, // R82：把历史遗留的 pending 一次性标为失败（只跑一次，标记在 payments.json 顶层）
  flush, // R14-09：去抖落盘的强制刷写（优雅停机 / 测试）
  isDegraded, // R84（M-3）：订单存储读不出来时为 true —— 上游据此拒绝收款 / 显示告警
  markPaid, markFailed, markRefunded, markDownloaded, setTradeNo,
  orderToken, verifyToken, payerState, view,
  bucketOf, // R48：来源桶（快照优先、回退到现存链接）—— 收入统计按桶归集的唯一实现点
};
