/**
 * 订单号编解码 —— 36 位「时间戳 + 链接 UID + 用户 UID + 随机串」（R64）
 *
 * ## 为什么订单号必须变长
 *
 * 旧订单号是 24 位 base64url 的**随机**记录 id：够唯一，但**不携带任何信息**，
 * 也**不是**给用户保存的东西 —— 一旦浏览器的支付凭证 Cookie 丢失（换设备、清缓存、
 * Cookie 过期），付过钱的人就再也取不回下载权限，只能重新付款或找分享者手工核对。
 *
 * 现在订单号自身就是「取回凭据」：只要用户记下它，就能在任何设备、任何时候用
 * 「恢复购买」把下载权限要回来。因此它必须**足够长**（防枚举）且**可读可抄**
 * （纯字母数字、无分隔符，36 位）。
 *
 * ## 结构（共 36 位，全部为 base62 字符）
 *
 * | 段 | 位数 | 来源 | 说明 |
 * | --- | --- | --- | --- |
 * | 时间戳 | 13 | `Date.now()` | 毫秒级 Unix 时间戳，可判读下单时间（对账友好） |
 * | 链接 UID | 9 | `sha256('kepler:link:' + linkId)` | 由链接 id **确定性**派生，同一链接恒定 |
 * | 用户 UID | 9 | `sha256('kepler:user:' + userId)`；游客随机 | 同一账号恒定；游客按单随机 |
 * | 随机串 | 5 | `crypto.randomInt` | 同一毫秒、同一链接、同一用户的并发订单不撞号 |
 *
 * 三个「UID」段都是**区分大小写、非顺序**的随机字母 + 数字（62 进制），刻意不用
 * 递增序号：顺序号会泄露业务量（"这家站一天卖多少"），也更容易被暴力猜。
 *
 * ### 为什么链接 / 用户 UID 用哈希派生而不是各存一个随机值
 *
 * 恢复购买时要回答「这个订单号属于这条链接吗」。若 UID 是建单时随机生成的，
 * 那么同一条链接的每笔订单都会有不同的链接 UID，匹配只能回落到 `order.linkId`
 * 上 —— 那时订单号里的这一段就**只剩装饰作用**。用哈希派生后，「同一链接恒得
 * 同一个 9 位串」这条性质本身就可校验（见 `linkUidOf`）。
 *
 * ⚠️ 但**匹配的权威判据仍是订单上的 `linkId`**（`payment-orders.claimForLink`）：
 * UID 是派生值，将来若派生口径变化（例如换哈希版本），旧订单号不该因此失效。
 *
 * ### 游客的「用户 UID」
 *
 * 匿名付费没有账号 id 可用。需求允许「直接随机生成一个或会话映射」——这里取
 * **按单随机**：游客本来就没有稳定身份，把随机值绑到 Cookie 上反而会造出一个
 * 半吊子的"影子账号"（换浏览器就断，还得额外维护一份映射表）。订单号的可取回性
 * 由**订单号本身**保证，不依赖这个字段。
 *
 * ### 熵
 *
 * 链接 UID 对同一链接是已知的（链接 id 就在 URL 里）。攻击者若要猜中别人的订单号，
 * 需要同时命中 9 位用户 UID + 5 位随机串 = 62^14 ≈ 1.2e25 —— 加上 `POST
 * /s/:id/restore` 的按 IP 限流，枚举不可行。
 */
const crypto = require('crypto');

/** 62 进制字母表（数字 + 大写 + 小写，区分大小写） */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const TS_LEN = 13;
const LINK_UID_LEN = 9;
const USER_UID_LEN = 9;
const RAND_LEN = 5;
/** 订单号总长度：13 + 9 + 9 + 5 */
const ORDER_NO_LEN = TS_LEN + LINK_UID_LEN + USER_UID_LEN + RAND_LEN;

/** 定长零填充的时间戳段（2286 年之前恒为 13 位） */
function tsSegment(ts) {
  const n = Number.isFinite(ts) ? Math.floor(ts) : Date.now();
  return String(n).padStart(TS_LEN, '0').slice(-TS_LEN);
}

/**
 * 生成 `len` 位密码学随机 base62 串。
 *
 * ⚠️ 用 `crypto.randomInt(62)` 而**不是** `randomBytes % 62`：后者对 62 取模会让
 * 前 8 个字符的出现概率高约 3%（256 % 62 = 8），是那种"看着没问题、统计上偏一点"
 * 的弱随机。`randomInt` 内部做拒绝采样，分布是均匀的。
 */
function randomId(len) {
  const n = Math.max(0, Math.floor(Number(len) || 0));
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/**
 * 把任意输入**确定性**映射成 `len` 位 base62 串（sha256 → 逐字符取模）。
 *
 * 两字节一取（65536 % 62 ≈ 0.02% 偏差，仅用于派生非机密标识），保证同一输入
 * 永远得到同一串 —— 「同一链接 / 同一账号的 UID 恒定」正是靠这一点成立的。
 */
function deriveId(input, len) {
  const n = Math.max(0, Math.floor(Number(len) || 0));
  if (!n) return '';
  const digest = crypto.createHash('sha256').update(String(input)).digest();
  let out = '';
  for (let i = 0; i < n; i++) {
    const hi = digest[(i * 2) % digest.length];
    const lo = digest[(i * 2 + 1) % digest.length];
    out += ALPHABET[((hi << 8) | lo) % ALPHABET.length];
  }
  return out;
}

/** 链接的 9 位 UID（同一 linkId 恒定） */
function linkUidOf(linkId) {
  return deriveId('kepler:link:' + String(linkId || ''), LINK_UID_LEN);
}

/** 账号的 9 位 UID（同一 userId 恒定）；无 userId 时返回空串，由调用方改用随机值 */
function userUidOf(userId) {
  const id = String(userId || '');
  return id ? deriveId('kepler:user:' + id, USER_UID_LEN) : '';
}

/**
 * 组装订单号。
 * @param {{linkId: string, userId?: string, ts?: number, linkUid?: string, userUid?: string, rand?: string}} p
 * @returns {{no: string, linkUid: string, userUid: string}}
 */
function compose(p) {
  const o = p && typeof p === 'object' ? p : {};
  const linkUid = String(o.linkUid || '').slice(0, LINK_UID_LEN) || linkUidOf(o.linkId);
  const uid = String(o.userUid || '').slice(0, USER_UID_LEN) || userUidOf(o.userId) || randomId(USER_UID_LEN);
  const rand = String(o.rand || '').slice(0, RAND_LEN) || randomId(RAND_LEN);
  return { no: tsSegment(o.ts) + linkUid + uid + rand, linkUid, userUid: uid };
}

/** 该字符串是不是一个格式合法的订单号（36 位、首段为 13 位十进制时间戳） */
function isOrderNo(s) {
  const v = String(s || '');
  return v.length === ORDER_NO_LEN && /^[1-9]\d{12}[0-9A-Za-z]{23}$/.test(v);
}

/**
 * 拆解订单号（仅用于展示 / 诊断）。
 * @returns {{ok: boolean, ts: number, time: string, linkUid: string, userUid: string, rand: string}}
 */
function parse(s) {
  const v = String(s || '');
  if (!isOrderNo(v)) {
    return { ok: false, ts: 0, time: '', linkUid: '', userUid: '', rand: '' };
  }
  const ts = Number(v.slice(0, TS_LEN));
  return {
    ok: true,
    ts,
    time: new Date(ts).toISOString(),
    linkUid: v.slice(TS_LEN, TS_LEN + LINK_UID_LEN),
    userUid: v.slice(TS_LEN + LINK_UID_LEN, TS_LEN + LINK_UID_LEN + USER_UID_LEN),
    rand: v.slice(ORDER_NO_LEN - RAND_LEN),
  };
}

/**
 * 用户输入的归一化：只去掉首尾空白与中间的空格 / 连字符（用户抄写时常会分组）。
 *
 * ⚠️ **绝不折叠大小写** —— 订单号是区分大小写的 base62，把 `a` 和 `A` 当成同一个
 * 会直接把有效熵从 62^14 砍到 36^14（约 1/10^3），且会让两个不同订单号互相命中的
 * 概率大幅上升。抄错大小写就是抄错了，如实提示而不是猜。
 */
function normalize(raw) {
  return String(raw || '').replace(/[\s-]+/g, '');
}

module.exports = {
  ALPHABET,
  TS_LEN, LINK_UID_LEN, USER_UID_LEN, RAND_LEN, ORDER_NO_LEN,
  randomId, deriveId, linkUidOf, userUidOf, compose, isOrderNo, parse, normalize,
};
