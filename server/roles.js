/**
 * 角色模型（R71）—— **角色语义的唯一事实源**
 *
 * 三层角色：
 *  - `root`  根用户：系统**部署完成后创建的第一个账户**，角色**不可通过界面转让、
 *            不可重复授予**，拥有对任意用户（含管理员与其他根用户）的增删改权限，
 *            并继承管理员的全部能力；
 *  - `admin` 管理员：仅能管理**普通用户**，无权添加 / 编辑 / 删除管理员与根用户；
 *  - `user`  普通用户：仅能查看与修改自己的资料。
 *
 * ## 为什么必须收成一个模块
 *
 * 本项目的角色判据原本散在 20+ 处（`role === 'admin'` 字面量），分布形态是：
 * 「服务端 9 处 + 前端 15 处」。加一层角色时，任何一处漏改都会产生**方向相反**的
 * 两种事故：
 *  - 漏在**放行侧**（`requireAdmin`、`roleOf`、`bucketsFor`）⇒ 根用户明明拥有最高权限，
 *    却被当普通用户，界面缺入口、接口 403 —— 表现为「系统坏了」；
 *  - 漏在**限制侧**（删除 / 编辑 / 封禁的越权判定）⇒ 管理员仍能删掉管理员或根用户，
 *    也就是本轮要修的漏洞**没修上**。
 *
 * 第二种最危险：它不会报错，只会让「已经加固过」的系统继续可被越权，且看起来一切正常。
 * 因此这里给出**四类判据**，并要求所有调用点只引用它们、不再手写字面量比较：
 *  1. {@link isRoot} / {@link isStaff} —— 「这一侧是不是管理层」；
 *  2. {@link isAssignableRole} / {@link normalizeStoredRole} —— 「这个值能不能被授予 / 落盘」；
 *  3. {@link canManageUser} —— 「A 能不能管理 B」的唯一判定点（删除 / 编辑 / 封禁 / 强踢共用）；
 *  4. {@link roleLabel} —— 日志与界面文案的唯一映射点（审计日志里写「根用户」而不是 `root`）。
 */
const ROOT = 'root';
const ADMIN = 'admin';
const USER = 'user';

/** 落盘后**允许存在**的角色（含根用户） */
const STORED_ROLES = [ROOT, ADMIN, USER];

/**
 * 可被**授予**的角色。
 *
 * ⚠️ `root` **刻意不在其中**：根用户由「空库的第一个账户」这一**事件**产生，而不是由
 * 谁授予。把它放进可授予集合，任何一次 `POST /users { role: 'root' }` 都会多出一个
 * 最高权限账户 —— 那正是需求里明令禁止的「重复授予」。
 */
const ASSIGNABLE_ROLES = [ADMIN, USER];

/**
 * 读盘归一：任何历史脏值一律按**最小权限**处理。
 *
 * 与旧实现 `['admin','user'].includes(role) ? role : 'user'` 的差别只有一点 ——
 * **必须认可 `root`**。这一行曾把 `root` 静默降级成 `user`（读一次盘就丢一次根权限），
 * 属于「读了就忘」型的不可逆事故，故单列一条护栏（`tests/root-role.test.js`）。
 */
function normalizeStoredRole(role) {
  return STORED_ROLES.includes(role) ? role : USER;
}

/** 是否根用户 */
function isRoot(role) {
  return role === ROOT;
}

/**
 * 是否**管理层**（管理员或根用户）。
 *
 * 这是「功能可用性」判据：可见哪些桶、能否进用户管理、能否看日志、`requireAdmin`
 * 是否放行……全部走它。**不要**用它做「谁管谁」的越权判定 —— 那是
 * {@link canManageUser} 的职责，两者混用正是本轮漏洞的成因。
 */
function isStaff(role) {
  return role === ROOT || role === ADMIN;
}

/** 是否是**可授予**的角色（root 永远为 false） */
function isAssignableRole(role) {
  return ASSIGNABLE_ROLES.includes(role);
}

/**
 * 「A 能不能管理 B」的**唯一判定点**。
 *
 * 规则（与需求逐字对应）：
 *  - 根用户 → 任意用户（含管理员与其他根用户）；
 *  - 管理员 → **仅普通用户**；
 *  - 普通用户 → 谁都不能管（自管走 `/users/me`，不经过本函数）。
 *
 * ⚠️ 调用方**必须传入目标的实时角色**（从存储读出来的），不能信请求体：
 * `PUT /users/:id` 的 `role` 字段只是「想改成什么」，不是「现在是什么」。
 * 静默地拿它当现状，就会出现「管理员把管理员改成 user 再删」这种两步越权。
 */
function canManageUser(actorRole, targetRole) {
  if (isRoot(actorRole)) return true;
  if (actorRole === ADMIN) return normalizeStoredRole(targetRole) === USER;
  return false;
}

/**
 * 管理员能否把某用户改成目标角色。
 *
 * 只有根用户可以调整角色。理由不是「管理员不能改密码」那条（改密是运维动作），
 * 而是：**改角色等于授予角色** —— 允许管理员把普通用户提成管理员，就等于允许他
 * 「添加管理员」（需求明确禁止），并且这条路径还能绕过 `POST /users` 上的同一道闸门。
 */
function canAssignRole(actorRole) {
  return isRoot(actorRole);
}

/** 角色 → 中文标签（审计日志与界面共用；未知值不抛错，按普通用户展示） */
function roleLabel(role) {
  if (role === ROOT) return '根用户';
  if (role === ADMIN) return '管理员';
  return '普通用户';
}

module.exports = {
  ROOT, ADMIN, USER, STORED_ROLES, ASSIGNABLE_ROLES,
  normalizeStoredRole, isRoot, isStaff, isAssignableRole,
  canManageUser, canAssignRole, roleLabel,
};
