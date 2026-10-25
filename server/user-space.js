/**
 * 用户空间（R89）—— 桶内前缀命名空间，**唯一实现点**
 *
 * ## 要解决的问题
 *
 * 改造前「可见性」只有一个桶级开关（`bucket.visibleToUsers`）：它回答的是
 * **「你能不能进这个桶」**，进去之后没有任何边界 —— `/fs/list?prefix=` 传空串就是
 * 整桶列举，`/fs/delete` 传谁的 key 就删谁的文件，`/fs/presign` 能给别人任何对象签直链。
 *
 * ## 物理形态：`u/<userId>/`
 *
 * - 用一个**不可变**的 `userId`（32 位 hex，见 `config-store.newId()`），而不是
 *   `username`：用户名可以被管理员改，改完之后「文件还在、人找不到」；
 * - 每个桶各有一套（同一用户在 A 桶与 B 桶的空间互不相干）—— 与「切桶」的语义一致；
 * - 存量对象一律不动，只对非管理员隐藏：`legacy` 段之外的裸 key 不属于任何用户空间。
 *
 * ## 为什么不用「每用户一个桶」
 *
 * 桶是计费与凭据单位：腾讯云按桶有最低计费、每加一个用户都要管理员去云端建桶、
 * 用户自注册根本走不通。而桶内前缀在「持有 AK/SK 的只有本服务」这个前提下，
 * 隔离强度是一样的 —— 普通用户拿不到云端凭据，只能走本服务的 API。
 *
 * ## 三条铁律
 *
 * ① **根以 `/` 结尾**（`u/abc/` 而不是 `u/abc`）。这不是美观问题：
 *    `startsWith('u/abc')` 会把 `u/abcd/x` 一并放行，是一个静默的越权。
 * ② **绝对 key 与相对 key 只有一个方向**：客户端永远只提交相对 key，
 *    进收口点加根、出收口点剥根。任何「有时绝对、有时相对」的分支都会在
 *    某个端点上演变成「把根写进了文件名」（`u/abc/u/abc/a.txt`）。
 * ③ **判据 fail-closed**：角色是 `user` 却没有 `userId` ⇒ 抛错，绝不回退成
 *    「没有作用域 = 看全部」。这与 `sessionRole()` 的宽松回退**刻意不同**：
 *    那个回退服务的是「有没有管理权限」，漏判的代价是少一个按钮；
 *    这里的回退服务的是「能看到谁的字节」，漏判的代价是所有人的文件。
 */
const PREFIX = 'u/';
/** 存量数据的位置：既不属于任何用户，也不被任何用户看见（仅管理层） */
const LEGACY_PREFIX = 'legacy/';

/**
 * 用户 id 的合法字符集。
 *
 * 现状是 32 位 hex，本不需要校验；但 `userId` 会被拼进 S3 key，
 * 一旦将来换成邮箱 / 手机号 / UUID 之外的形态，一个 `/` 就能把前缀变成两层，
 * 一个 `..` 就能让 `isInside()` 的字符串前缀比较失效。故在这里一次性拒绝。
 */
const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 空间根（空串 = 无作用域，即管理层视角） */
function rootForUserId(userId) {
  const id = String(userId == null ? '' : userId).trim();
  if (!id) return '';
  if (!USER_ID_RE.test(id)) {
    const e = new Error('用户标识含有非法字符，无法确定其存储空间');
    e.status = 500;
    throw e;
  }
  return PREFIX + id + '/';
}

/** 这一段是否属于「存量区」（仅管理层可见） */
function isLegacy(key) {
  return String(key == null ? '' : key) === LEGACY_PREFIX.replace(/\/$/, '')
    || String(key == null ? '' : key).indexOf(LEGACY_PREFIX) === 0;
}

/**
 * 相对 key → 绝对 key。
 *
 * @param {string} root 空间根（空串 = 无作用域，原样返回）
 * @param {string} rel  客户端给的相对 key（**已由 `normalizeKey()` 归一**）
 */
function toAbs(root, rel) {
  const k = String(rel == null ? '' : rel);
  if (!root) return k;
  // 客户端提交的 key 若已经带着根（老前端 / 手工构造），不叠加第二层
  if (k === root) return k;
  if (k.indexOf(root) === 0) return k;
  return root + k;
}

/**
 * 绝对 key → 相对 key；**越界返回 `null`**（调用方必须当作 404/403 处理，不能当空串）。
 *
 * `root` 为空（管理层）时原样返回 —— 管理端界面直接呈现桶内真实路径。
 */
function toRel(root, abs) {
  const k = String(abs == null ? '' : abs);
  if (!root) return k;
  if (k === root) return '';           // 空间根目录本身
  if (k.indexOf(root) !== 0) return null;
  return k.slice(root.length);
}

/** 是否落在空间内（含空间根本身）。root 为空恒 true（无作用域） */
function isInside(root, abs) {
  if (!root) return true;
  const k = String(abs == null ? '' : abs);
  return k === root || k.indexOf(root) === 0;
}

/**
 * 断言之「这个绝对 key 属于我的空间」。
 *
 * ⚠️ 报错文案**不区分「不存在」与「不属于你」**：两者都给同一句，
 * 否则它就是一个存在性预言机（与 `claimForLink()` 同一条纪律）。
 */
function assertOwned(root, abs, label) {
  if (isInside(root, abs)) return abs;
  const e = new Error(`${label || '对象'}不存在或无权访问`);
  e.status = 404;
  e.spaceDenied = true;
  throw e;
}

/** 列表批量版：任一越界即整体拒绝（不做「跳过越界的那些」—— 那等于静默漏删/漏移） */
function assertAllOwned(root, list, label) {
  const arr = Array.isArray(list) ? list : [];
  for (const k of arr) assertOwned(root, k, label);
  return arr;
}

module.exports = {
  PREFIX, LEGACY_PREFIX, USER_ID_RE,
  rootForUserId, isLegacy,
  toAbs, toRel, isInside, assertOwned, assertAllOwned,
};
