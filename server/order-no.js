/**
 * 订单号编解码 —— 36 位「混淆段 + 链接 UID + 用户 UID + 随机串」（R64 / R105）
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
 * ## R105：首段不再携带下单时间
 *
 * R64 的首段是 13 位毫秒级 Unix 时间戳，好处是「扫一眼就知道什么时候下的单」。
 * 但它同时意味着**任何人拿到订单号就能读出精确到毫秒的下单时间** —— 而订单号
 * 是要交给用户保存、在客服对话里粘贴、被截图转发的凭据。这等于把一个不该公开的
 * 时间侧信道一起发了出去：可以据此推断站点的成交时段分布、判断某笔交易与他人的
 * 先后关系，也能和其他数据做关联。
 *
 * 故 R105 把这一段的语义从「时间戳」改为**不可判读的随机串**，长度仍为 13 位
 * （订单号总长 36 位不变 —— 这是银联 `orderId` 的 8~40 位限制、微信 / 支付宝的
 * 参数上限，以及「用户能一口气抄下来」三者共同框定的）。
 *
 * ### 为什么不做「可逆混淆」（把时间加密后仍放在首位）
 *
 * 两条路都走不通：
 *  · 用**代码内固定常量**做异或 / 线性同余：读代码就能反解，属伪安全 —— 比明文
 *    更糟，因为它会让后来的人以为这里已经做了保护；
 *  · 用 configStore 里的**主密钥**：锁定态（R97 / R104）拿不到密钥，而建单发生在
 *    支付链路上 —— 那里绝不允许因为「解不开密钥」而生成不出订单号。
 *
 * 而「下单时间」这个信息在订单记录里本来就有 `createdAt`（ISO 字符串，订单管理页
 * 照常显示、可排序、可对账），订单号没有必要再冗余携带一份。
 *
 * ## 结构（共 36 位，全部为 base62 字符）
 *
 * | 段 | 位数 | 来源 | 说明 |
 * | --- | --- | --- | --- |
 * | 混淆段 | 13 | `crypto.randomInt` | 随机 base62，**不携带任何时间信息**（R105 前为毫秒时间戳） |
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
 * 需要同时命中 13 位混淆段 + 9 位用户 UID + 5 位随机串 = 62^27 ≈ 1.2e48 —— 加上
 * `POST /s/:id/restore` 的按 IP 限流与失败冻结，枚举不可行。（R105 之前混淆段是
 * 时间戳、可想见地落在某个窄区间内，实际有效熵只有 62^14。）
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
 * 首段：13 位随机 base62。
 *
 * ⚠️ R105 之前这里是 `String(Date.now()).padStart(13, '0')` —— 一段可读出精确
 * 下单时间的毫秒时间戳。名字保留 `maskSegment` 而不是继续叫 `tsSegment`，是为了
 * 让「这一段已经不是时间」在调用点上一眼可见。
 *
 * 定长 13 位：与旧订单号**逐字节同构**（长度、字符集、位置都不变），所以历史订单号
 * 仍然通过 `isOrderNo()`，银联的 8~40 位字母数字判据、微信 / 支付宝的参数上限也都
 * 不受影响。
 */
function maskSegment() {
  return randomId(TS_LEN);
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
 *
 * ⚠️ `ts` 是 R64 的历史参数：R105 起**不再参与**组装（首段已改为随机串），
 * 传进来也不会出现在订单号里 —— 刻意保留这个「被忽略」的行为而不是报错，是为了
 * 让外部遗留调用点不至于因为一个无用参数而整条链路失败；但注释写在这里，免得
 * 后来的人以为「传 ts 还能让订单号可反解时间」。
 *
 * @param {{linkId: string, userId?: string, linkUid?: string, userUid?: string, rand?: string, mask?: string}} p
 * @returns {{no: string, linkUid: string, userUid: string, mask: string}}
 */
function compose(p) {
  const o = p && typeof p === 'object' ? p : {};
  const linkUid = String(o.linkUid || '').slice(0, LINK_UID_LEN) || linkUidOf(o.linkId);
  const uid = String(o.userUid || '').slice(0, USER_UID_LEN) || userUidOf(o.userId) || randomId(USER_UID_LEN);
  const rand = String(o.rand || '').slice(0, RAND_LEN) || randomId(RAND_LEN);
  const mask = String(o.mask || '').slice(0, TS_LEN) || maskSegment();
  return { no: mask + linkUid + uid + rand, linkUid, userUid: uid, mask };
}

/**
 * 该字符串是不是一个格式合法的订单号（36 位纯 base62）。
 *
 * ⚠️ R105：判据**不再**检查首段「是不是 13 位十进制时间戳」—— 首段现在是随机串，
 * 如果还要求它长得像时间戳，新生成的订单号会全部被判为非法，而「恢复购买」会
 * 对每一笔新订单回「订单号格式不正确」。长度 + 字符集就是这里能判的全部；
 * 「这个号存不存在」一律交给 `payment-orders.findByOrderNo()` 查表。
 */
function isOrderNo(s) {
  const v = String(s || '');
  return v.length === ORDER_NO_LEN && /^[0-9A-Za-z]+$/.test(v);
}

/**
 * 拆解订单号（仅用于展示 / 诊断）。
 *
 * R105：不再返回 `ts` / `time` —— 首段已不可判读，继续提供一个「反解下单时间」的
 * 入口只会让后来的人误用。要下单时间请读订单记录上的 `createdAt`。
 * @returns {{ok: boolean, mask: string, linkUid: string, userUid: string, rand: string}}
 */
function parse(s) {
  const v = String(s || '');
  if (!isOrderNo(v)) {
    return { ok: false, mask: '', linkUid: '', userUid: '', rand: '' };
  }
  return {
    ok: true,
    mask: v.slice(0, TS_LEN),
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
