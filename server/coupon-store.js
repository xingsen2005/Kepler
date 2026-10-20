/**
 * 优惠券存储 —— data/coupons.json（加密 JSON，与其它 store 同源）
 *
 * ## 一张券是什么
 *
 *  {
 *    id, code,                       // id：16 字节 base64url；code：10 位无歧义字符（唯一）
 *    type,                           // 适用范围：'any' 无门槛 | 'links' 限特定链接 | 'users' 限特定用户
 *    linkIds, userIds,               // type 对应的目标集合（另一侧为空数组）
 *    amountFen,                      // 优惠金额（**分**，整数）
 *    maxUses, used,                  // 总使用次数（0 = 不限制）与实际核销次数
 *    perUserOnce,                    // 是否「每个用户只能使用一次」
 *    startAt, expireAt,              // 生效 / 到期时刻（null = 立即可用 / 永久有效）
 *    disabled,                       // 管理员手动停用（**可逆**，与 expired 区分开）
 *    note, createdAt, createdBy,
 *    uses: [{ identity, orderId, usedAt }]  // 核销台账（perUserOnce 与退款回退的依据）
 *  }
 *
 * ## 三处刻意的设计取舍
 *
 * ① **「次数用尽」不落字段**，与 `invite-store` 同一条理由：它是**可逆**的 ——
 *    管理员把 `maxUses` 调大，券立刻复活。落成状态字段就得记得同步改回来，
 *    漏一处就是「配额明明调大了、还是提示已用尽」。
 *
 * ② **核销台账记 `identity` 而不只是计数**。需求 3 要求「是否每个用户只能使用一次」、
 *    需求 8 要求「退款时让该用户可重新使用」—— 这两条都必须在**某个人**这个粒度上
 *    有记录。只记 `used` 总数，两个功能都无从实现。
 *
 * ③ **券的适用范围按 `type` 三选一**，而不是把「链接限制」与「用户限制」做成两个
 *    可同时开启的开关。同时开启的语义是「两者都要满足」，界面上却极容易被读成
 *    「任一满足」；需求原文也是「类型限制：A、B、C」这种并列关系。
 *
 * ## 身份（identity）怎么来
 *
 * 分享页是**匿名可达**的，付款人未必登录。故身份由 `identityFrom()` 统一给出：
 *  · 已登录 → `u:<userId>`
 *  · 未登录 → `a:<sha256(IP|User-Agent) 前 32 位>`
 *
 * 这是**刻意的折中**：`限特定用户` 必须登录才能用（否则无从判断是不是那个人）；
 * 而「每用户一次」对匿名访客按「同一出口 IP + 同一浏览器 UA」近似 —— 换网络 / 换设备
 * 会被当成另一个人。这条限制在界面上如实说明，不假装它是账号级的。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const secureStore = require('./secure-store');
const {
  COUPON_CODE_ALPHABET, COUPON_CODE_LEN, COUPON_CODE_RE,
  COUPON_MAX_TARGETS, COUPON_TYPES, COUPON_USES_MAX,
  normalizeCouponCode, normalizeCouponType,
} = require('./limits');

const DATA_DIR = require('./data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'coupons.json');

/** 应付金额的下限（分）—— 与 `payment-rules.MIN_AMOUNT_FEN` 同值，网关不接受 0 元 */
const MIN_PAYABLE_FEN = 1;

/**
 * 券不可用的原因 → 面向用户的文案（**唯一实现点**）。
 *
 * 与 `INVITE_FAIL_TEXT` 同款：文案只写一次，分享页与下单接口直接取用，
 * 避免「同一个原因在两处各写一句、改一处漏一处」。
 */
const COUPON_FAIL_TEXT = {
  not_found: '优惠券无效，请检查后重试',
  disabled: '该优惠券已被停用',
  not_started: '该优惠券尚未到可使用时间',
  expired: '该优惠券已过期',
  used_up: '该优惠券使用次数已用尽',
  wrong_link: '该优惠券不适用于当前分享链接',
  wrong_user: '该优惠券仅限指定用户使用，请先登录对应账户',
  already_used: '您已使用过该优惠券',
  no_price: '当前分享链接无需付费，无法使用优惠券',
};

let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function newId() {
  return crypto.randomBytes(16).toString('base64url');
}

/** 券码：`crypto.randomInt` 逐位取值（理由见 invite-store 的 `randomCode`：不用 Math.random） */
function randomCode() {
  let s = '';
  for (let i = 0; i < COUPON_CODE_LEN; i++) {
    s += COUPON_CODE_ALPHABET[crypto.randomInt(COUPON_CODE_ALPHABET.length)];
  }
  return s;
}

function isoOrNull(v) {
  if (!v) return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 台账条目归一化：三项都必须是字符串，缺一丢一条 */
function normalizeUses(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const u of list) {
    if (!u || typeof u !== 'object') continue;
    const identity = typeof u.identity === 'string' ? u.identity : '';
    const orderId = typeof u.orderId === 'string' ? u.orderId : '';
    if (!identity) continue;
    out.push({
      identity,
      orderId,
      usedAt: typeof u.usedAt === 'string' ? u.usedAt : '',
    });
  }
  // 只留最近 COUPON_USES_MAX 条：`used` 计数始终准确，台账只是给人看 + 退款定位
  return out.slice(-COUPON_USES_MAX);
}

/**
 * 单条记录归一化。非法记录**整条丢弃**（码不合规 / 金额非正），
 * 与 `invite-store.normalize` 同一条理由：留着只会让管理员看见一行
 * 「有效」却怎么都用不了。
 */
function normalizeRecord(r, seen, warn) {
  if (!r || typeof r !== 'object') { warn.drop += 1; return null; }
  const code = normalizeCouponCode(r.code);
  if (!COUPON_CODE_RE.test(code)) { warn.drop += 1; return null; }
  if (seen.has(code)) { warn.drop += 1; return null; }
  seen.add(code);

  const type = normalizeCouponType(r.type);
  const amountFen = Number(r.amountFen);
  if (!Number.isInteger(amountFen) || amountFen <= 0) { warn.drop += 1; return null; }

  const maxUses = Number(r.maxUses);
  const used = Number(r.used);
  const linkIds = (Array.isArray(r.linkIds) ? r.linkIds : [])
    .filter((x) => typeof x === 'string' && x).slice(0, COUPON_MAX_TARGETS);
  const userIds = (Array.isArray(r.userIds) ? r.userIds : [])
    .filter((x) => typeof x === 'string' && x).slice(0, COUPON_MAX_TARGETS);

  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    code,
    type,
    // 类型与目标集合必须自洽：`any` 不该残留目标；`links` / `users` 缺目标则不可用，
    // 但仍保留记录（管理员可以补上目标，删掉反而丢了他的备注与台账）。
    linkIds: type === 'links' ? linkIds : [],
    userIds: type === 'users' ? userIds : [],
    amountFen,
    maxUses: Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 0,
    used: Number.isInteger(used) && used > 0 ? used : 0,
    perUserOnce: Boolean(r.perUserOnce),
    startAt: isoOrNull(r.startAt),
    expireAt: isoOrNull(r.expireAt),
    disabled: Boolean(r.disabled),
    note: typeof r.note === 'string' ? r.note : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
    uses: normalizeUses(r.uses),
    /**
     * R69：**不截断**的「用过这张券的身份」索引。
     *
     * `uses` 是给人看的台账，只保留最近 `COUPON_USES_MAX`(=200) 条；而「每人一次」
     * 的判据如果也读它，超 200 次核销后最早的用户就被挤出数组 —— 他可以再用一次，
     * 且完全是静默的。索引只存身份字符串（去重），与台账解耦：
     * 台账继续截断（那是显示与退款定位），判据改读这里。
     */
    identities: normalizeIdentities(r.identities, r.uses),
  };
}

/** 身份索引归一化：优先用显式字段；旧数据从台账（可能已截断）尽力恢复 */
function normalizeIdentities(raw, uses) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v == null ? '' : v);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  // 旧记录没有这个字段：从台账里恢复（截断前的部分已经不可知，属可接受的降级）
  if (!Array.isArray(raw) && Array.isArray(uses)) uses.forEach((u) => push(u && u.identity));
  return out;
}

function normalize(raw) {
  const list = (raw && Array.isArray(raw.coupons)) ? raw.coupons : [];
  const out = [];
  const seen = new Set();
  const warn = { drop: 0 };
  for (const r of list) {
    const rec = normalizeRecord(r, seen, warn);
    if (rec) out.push(rec);
  }
  if (warn.drop > 0) {
    console.warn(`[coupon-store] 已丢弃 ${warn.drop} 条形状不合法的优惠券记录（码缺失 / 含非法字符 / 重复 / 金额非正）`);
  }
  return { coupons: out };
}

function load() {
  if (cache) return cache;
  try {
    const raw = secureStore.readJson(FILE, null);
    if (raw) {
      cache = normalize(raw);
      return cache;
    }
  } catch (e) {
    // 与 invite-store 同：损坏时打告警并降级为空表，secure-store 已锁定该文件写入，
    // 磁盘上的损坏文件不会被空表覆盖。
    console.error('[coupon-store] 优惠券文件损坏，已降级为空列表并锁定写入：', e.message);
  }
  cache = { coupons: [] };
  return cache;
}

/**
 * 落盘 —— **同步**写。
 *
 * 与 `invite-store` 同款：停用 / 删除是**吊销**语义，必须「调用返回时已落盘」；
 * 异步写丢一次 flush 就是「管理员点了停用、重启后券又活了」。
 * 核销是低频动作（每笔订单至多一次），全量加密写在这个数据量下是毫秒级。
 */
function persist() {
  ensureDataDir();
  secureStore.writeJson(FILE, cache);
}

/* ------------------------- 状态 / 视图 ------------------------- */

/**
 * 券状态：disabled | not_started | expired | used_up | active
 *
 * **停用排最前**（管理员刚做的显式动作，也最需要被看到）；
 * **未开始排在过期前**：一张「开始时间在未来、到期时间也已过」的脏配置，
 * 说「尚未开始」比说「已过期」更接近它真正该被修的地方。
 */
function status(r, now = Date.now()) {
  if (r.disabled) return 'disabled';
  if (r.startAt && Date.parse(r.startAt) > now) return 'not_started';
  if (r.expireAt && Date.parse(r.expireAt) <= now) return 'expired';
  if (Number(r.maxUses) > 0 && Number(r.used) >= Number(r.maxUses)) return 'used_up';
  return 'active';
}

/** 对外视图（唯一实现点）。管理员接口原样回传 code —— 那正是他要分发的东西。 */
function view(r, now = Date.now()) {
  const maxUses = Number(r.maxUses) || 0;
  const used = Number(r.used) || 0;
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    linkIds: Array.isArray(r.linkIds) ? r.linkIds.slice() : [],
    userIds: Array.isArray(r.userIds) ? r.userIds.slice() : [],
    amountFen: Number(r.amountFen) || 0,
    maxUses,
    used,
    remaining: maxUses > 0 ? Math.max(0, maxUses - used) : null,
    perUserOnce: Boolean(r.perUserOnce),
    startAt: r.startAt || null,
    expireAt: r.expireAt || null,
    disabled: Boolean(r.disabled),
    note: r.note || '',
    status: status(r, now),
    createdAt: r.createdAt || '',
    createdBy: r.createdBy || '',
    uses: Array.isArray(r.uses) ? r.uses.slice() : [],
  };
}

function list() {
  return load().coupons.map((r) => view(r));
}

function get(id) {
  return load().coupons.find((r) => r.id === id) || null;
}

function findByCode(code) {
  const c = normalizeCouponCode(code);
  return load().coupons.find((r) => r.code === c) || null;
}

/* ------------------------- 身份 ------------------------- */

/**
 * 统一身份（**唯一实现点**）。
 *
 * 已登录 → `u:<userId>`；未登录 → `a:<sha256(IP|UA) 前 32 位>`。
 * 后者只用于「每用户一次」的近似，**不能**用于「限特定用户」——
 * 那种券必须登录才可用（否则任何人都能冒充目标用户）。
 */
function identityFrom({ userId, ip, userAgent } = {}) {
  const uid = String(userId == null ? '' : userId);
  if (uid) return 'u:' + uid;
  const h = crypto.createHash('sha256')
    .update(String(ip == null ? '' : ip) + '|' + String(userAgent == null ? '' : userAgent))
    .digest('hex');
  return 'a:' + h.slice(0, 32);
}

/* ------------------------- 金额 ------------------------- */

/**
 * 计算「原价 / 实际优惠 / 应付」。
 *
 * 优惠金额**封顶到「原价 − 1 分」**：网关不接受 0 元订单，而「满减券面额大于商品价」
 * 是极常见的配置（10 元券买 6 元文件）。封顶后「优惠」列显示的是**这张订单上真的
 * 减掉的钱**，而不是券面那串数字 —— 否则订单页会出现「原价 6 + 优惠 10 = 实付 0.01」
 * 这种对不上账的组合。
 *
 * @returns {{originalFen:number, discountFen:number, payableFen:number}}
 */
function computePayable(originalFen, discountFen) {
  const orig = Math.max(0, Math.floor(Number(originalFen) || 0));
  const want = Math.max(0, Math.floor(Number(discountFen) || 0));
  const maxDiscount = Math.max(0, orig - MIN_PAYABLE_FEN);
  const applied = Math.min(want, maxDiscount);
  return {
    originalFen: orig,
    discountFen: applied,
    payableFen: Math.max(MIN_PAYABLE_FEN, orig - applied),
  };
}

/* ------------------------- 校验 / 核销 / 回退 ------------------------- */

/**
 * 判定一张券能否用于「这个链接 + 这个身份」，并算出应付。
 *
 * @param {object} o
 *  - `code`     用户输入的券码
 *  - `link`     分享链接内部记录（需要 id 与 paid.amountFen）
 *  - `identity` `identityFrom()` 的结果
 *  - `userId`   已登录用户 id（未登录为空）
 *  - `now`      可注入的时间（测试用）
 * @returns {{ok:false, reason:string, message:string} | {ok:true, coupon:object, originalFen:number, discountFen:number, payableFen:number}}
 */
function validateForUse({ code, link, identity, userId, now = Date.now() }) {
  const fail = (reason) => ({ ok: false, reason, message: COUPON_FAIL_TEXT[reason] || COUPON_FAIL_TEXT.not_found });

  const normalized = normalizeCouponCode(code);
  if (!normalized) return fail('not_found');
  const c = findByCode(normalized);
  if (!c) return fail('not_found');

  const st = status(c, now);
  if (st !== 'active') return fail(st);

  if (c.type === 'links') {
    const id = link && link.id ? String(link.id) : '';
    if (!id || c.linkIds.indexOf(id) < 0) return fail('wrong_link');
  }
  if (c.type === 'users') {
    const uid = String(userId || '');
    if (!uid || c.userIds.indexOf(uid) < 0) return fail('wrong_user');
  }

  if (c.perUserOnce) {
    const who = String(identity || '');
    // R69：判据读**不截断**的身份索引，不再读台账（台账只保留最近 200 条）
    if (!who || (Array.isArray(c.identities) ? c.identities : []).indexOf(who) >= 0) return fail('already_used');
  }

  const original = Number(link && link.paid && link.paid.amountFen) || 0;
  if (original <= 0) return fail('no_price');

  const calc = computePayable(original, c.amountFen);
  return {
    ok: true,
    coupon: view(c, now),
    originalFen: calc.originalFen,
    discountFen: calc.discountFen,
    payableFen: calc.payableFen,
  };
}

/**
 * 核销一张券。
 *
 * **按 `orderId` 幂等**：同一笔订单重复调用不会重复计数（支付流程里「复用待支付订单」
 * 那条分支可能再跑一次本函数）。返回 `null` 表示券不存在。
 */
function consume({ couponId, identity, orderId }) {
  const c = get(couponId);
  if (!c) return null;
  const oid = String(orderId || '');
  if (oid && c.uses.some((u) => u.orderId === oid)) return view(c);

  c.uses.push({
    identity: String(identity || ''),
    orderId: oid,
    usedAt: new Date().toISOString(),
  });
  // 台账截断只影响「最早那几条的退款定位」，计数永远准
  if (c.uses.length > COUPON_USES_MAX) c.uses = c.uses.slice(-COUPON_USES_MAX);
  /*
   * R69：「每人一次」的判据索引**不截断**。台账被截断的是显示与退款定位，
   * 身份集合必须一直留着 —— 否则第 201 次核销之后，最早那位用户又能用同一张券。
   */
  if (!Array.isArray(c.identities)) c.identities = [];
  if (c.identities.indexOf(String(identity || '')) < 0) c.identities.push(String(identity || ''));
  c.used = Number(c.used || 0) + 1;
  persist();
  return view(c);
}

/**
 * 按订单回退一次核销 —— 退款流程用（需求 8）。
 *
 * 定位方式是**订单号**而不是身份：同一用户可能用同一张券下过多笔订单，
 * 只按身份删会把他其它订单的核销记录一并抹掉（券被「凭空多出次数」）。
 *
 * @returns {{couponId:string, identity:string, used:number}|null} 未找到返回 null
 */
function releaseByOrder(orderId) {
  const oid = String(orderId || '');
  if (!oid) return null;
  for (const c of load().coupons) {
    const idx = c.uses.findIndex((u) => u.orderId === oid);
    if (idx < 0) continue;
    const [hit] = c.uses.splice(idx, 1);
    c.used = Math.max(0, Number(c.used || 0) - 1);
    /**
     * R69：索引也要回退 —— 但只在「该身份确实没有其它核销记录」时移除。
     * 同一用户可能用同一张券下过多笔订单（`perUserOnce` 为假时），
     * 退掉其中一笔就把他从"用过"里删掉，等于把"每人一次"的额度还给他了。
     */
    if (Array.isArray(c.identities) && hit && hit.identity) {
      const still = c.uses.some((u) => u.identity === hit.identity);
      if (!still) c.identities = c.identities.filter((x) => x !== hit.identity);
    }
    persist();
    return { couponId: c.id, identity: hit.identity, used: c.used };
  }
  return null;
}

/* ------------------------- 增删改 ------------------------- */

/**
 * 批量生成优惠券。
 *
 * @param {object} o `{ count, type, linkIds, userIds, amountFen, maxUses, perUserOnce, startAt, expireAt, note, createdBy }`
 *   —— 数值与时间的合法性由路由层用 `limits.js` 的解析器挡过，这里只做落盘归一。
 * @returns {Array<object>} 新生成的记录视图（按生成顺序）
 */
function generate({
  count, type, linkIds, userIds, amountFen, maxUses,
  perUserOnce, startAt, expireAt, note, createdBy,
}) {
  const store = load();
  const taken = new Set(store.coupons.map((r) => r.code));
  const n = Number(count) || 0;
  const now = new Date().toISOString();
  const t = normalizeCouponType(type);
  const made = [];
  for (let i = 0; i < n; i++) {
    // 撞码重摇（与 invite-store 同：31^10 撞上的概率可忽略，但「几乎不可能」不是「不可能」）
    let code = randomCode();
    let guard = 0;
    while (taken.has(code) && guard < 1000) { code = randomCode(); guard += 1; }
    taken.add(code);
    const rec = {
      id: newId(),
      code,
      type: t,
      linkIds: t === 'links' ? (Array.isArray(linkIds) ? linkIds.slice(0, COUPON_MAX_TARGETS) : []) : [],
      userIds: t === 'users' ? (Array.isArray(userIds) ? userIds.slice(0, COUPON_MAX_TARGETS) : []) : [],
      amountFen: Math.max(1, Math.floor(Number(amountFen) || 0)),
      maxUses: Number.isInteger(Number(maxUses)) && Number(maxUses) > 0 ? Number(maxUses) : 0,
      used: 0,
      perUserOnce: Boolean(perUserOnce),
      startAt: isoOrNull(startAt),
      expireAt: isoOrNull(expireAt),
      disabled: false,
      note: typeof note === 'string' ? note : '',
      createdAt: now,
      createdBy: createdBy || '',
      uses: [],
      identities: [], // R69：「每人一次」的不截断索引（与台账解耦）
    };
    store.coupons.push(rec);
    made.push(view(rec));
  }
  if (made.length) persist();
  return made;
}

/**
 * 批量设置（**PATCH 语义**：只改传进来的字段）。不存在的 id 静默跳过并计数。
 * @returns {{updated:number, skipped:number}}
 */
function bulkUpdate(ids, patch) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  if (!want.size) return { updated: 0, skipped: 0 };
  const p = patch || {};
  let updated = 0;
  let skipped = 0;
  for (const r of load().coupons) {
    if (!want.has(r.id)) continue;
    if (p.disabled !== undefined) r.disabled = Boolean(p.disabled);
    if (p.maxUses !== undefined) r.maxUses = Number(p.maxUses) > 0 ? Number(p.maxUses) : 0;
    if (p.amountFen !== undefined) r.amountFen = Math.max(1, Math.floor(Number(p.amountFen) || 0));
    if (p.expireAt !== undefined) r.expireAt = isoOrNull(p.expireAt);
    if (p.startAt !== undefined) r.startAt = isoOrNull(p.startAt);
    if (p.note !== undefined) r.note = typeof p.note === 'string' ? p.note : '';
    updated += 1;
  }
  for (const id of want) if (!get(id)) skipped += 1;
  if (updated) persist();
  return { updated, skipped };
}

/** 单条更新（同一套 PATCH 语义） */
function update(id, patch) {
  const r = get(id);
  if (!r) return null;
  const p = patch || {};
  if (p.disabled !== undefined) r.disabled = Boolean(p.disabled);
  if (p.maxUses !== undefined) r.maxUses = Number(p.maxUses) > 0 ? Number(p.maxUses) : 0;
  if (p.amountFen !== undefined) r.amountFen = Math.max(1, Math.floor(Number(p.amountFen) || 0));
  if (p.expireAt !== undefined) r.expireAt = isoOrNull(p.expireAt);
  if (p.startAt !== undefined) r.startAt = isoOrNull(p.startAt);
  if (p.note !== undefined) r.note = typeof p.note === 'string' ? p.note : '';
  persist();
  return view(r);
}

/** 批量删除 @returns {{removed:number, skipped:number}} */
function remove(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  if (!want.size) return { removed: 0, skipped: 0 };
  const store = load();
  const before = store.coupons.length;
  store.coupons = store.coupons.filter((r) => !want.has(r.id));
  const removed = before - store.coupons.length;
  const skipped = want.size - removed;
  if (removed) persist();
  return { removed, skipped };
}

module.exports = {
  MIN_PAYABLE_FEN, COUPON_FAIL_TEXT, COUPON_TYPES,
  list, get, findByCode, status, view,
  identityFrom, computePayable, validateForUse, consume, releaseByOrder,
  generate, update, bulkUpdate, remove,
};
