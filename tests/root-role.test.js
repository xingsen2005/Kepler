/**
 * 第七十一轮护栏（R71）—— 根用户（`root`）角色与管理员的越权边界
 *
 * 需求（逐条对应到下面的用例）：
 *  1. 新增「根用户」角色，**只能且默认授予系统部署完成后创建的第一个用户**；
 *  2. 该角色**不可通过界面转让或重复授予**（既不能授予，也不能撤销）；
 *  3. 根用户拥有对**任意用户**（含管理员与其他根用户）的添加 / 编辑 / 删除权限；
 *  4. 管理员**仅能管理普通用户**，无权添加 / 编辑 / 删除管理员及根用户。
 *
 * 分层断言（任何一层缺失都会留下「假绿」）：
 *  ① **角色判据层**（真实 `server/roles.js`）：「谁管谁」「能不能授予」的判定本身；
 *  ② **存储层**（真实 `config-store`）：第一个账户是否真落成 root、读盘是否会把 root
 *     降级、越权改动是否真被拒绝；
 *  ③ **路由层**（真实 express 路由 + 真发 HTTP）：403 之后目标用户**是否真的没变** ——
 *     只断言状态码的话，「先删再回滚」也能全绿；
 *  ④ **前端层**（静态接线）：根用户徽章、按钮门控、`role === 'admin'` 字面量是否清零。
 *
 * ⚠️ 配置会真实落盘（`config.enc`），必须先把 `S3_DATA_DIR` 指到临时目录**再** require store。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');

const { assert, assertEqual, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('s3-r71-');
process.env.S3_DATA_DIR = tmp.dir;

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const statsStore = require(SERVER('stats-store.js'));
const configStore = require(SERVER('config-store.js'));
const authSession = require(SERVER('auth-session.js'));
const roles = require(SERVER('roles.js'));

/** 审计日志：只收进数组以备断言，不落盘 */
const logs = [];
statsStore.addLog = (entry) => { logs.push(entry); };

const userRoutes = require(SERVER('routes', 'users.js'));
// 「授予角色」的另两条通道（邀请码 / 站点默认身份）也挂进来 —— 只测用户管理页
// 等于默认「管理员只会从这一页动手」，而需求禁止的恰恰是**任何**添管理员的方式。
const inviteRoutes = require(SERVER('routes', 'invite.js'));
const siteRoutes = require(SERVER('routes', 'site.js'));

const PASSWORD = 'Unit!2026abc';

/* ================================================================== *
 * 公共工具
 * ================================================================== */

/** 建一个用户，返回 id（第一个账户会被存储层强制成 root） */
async function mkUser(name, role) {
  const u = await configStore.addUser({ username: name, password: PASSWORD, role });
  return u.id;
}

/**
 * 起一个只挂 `users` 路由的真 HTTP 服务。
 *
 * 身份由请求头 `x-who: <userId>` 指定，但**角色一律从存储实时读** —— 若在测试里
 * 直接伪造 `{ role: 'root' }`，那么「管理员能不能删管理员」测的就不再是真实的
 * 角色语义，而只是测试自己写的那串字面量。
 */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = String(req.get('x-who') || '');
    const u = id ? configStore.getUserById(id) : null;
    req.authUser = u ? { id: u.id, username: u.username, role: u.role, permissions: {} } : null;
    next();
  });
  app.use('/api', userRoutes);
  app.use('/api', inviteRoutes);
  app.use('/api', siteRoutes);
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

let srv = null;
let port = 0;

test.before(async () => { srv = await startServer(); port = srv.address().port; });
test.after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  await cleanupTempDir(tmp.dir, { label: 'root-role' });
});

function api(method, urlPath, { as = '', body = null } = {}) {
  return request(port, method, urlPath, {
    headers: as ? { 'x-who': as } : {},
    body,
  });
}

/* ================================================================== *
 * ① 角色判据层
 * ================================================================== */

test('R71 · 判据：根用户是管理员之上的角色，不属「普通用户」', () => {
  const { ROOT, ADMIN, USER } = roles;
  assertEqual(ROOT, 'root');
  assertEqual(ADMIN, 'admin');
  assertEqual(USER, 'user');
  assert(roles.isRoot('root') && !roles.isRoot('admin') && !roles.isRoot(undefined),
    'isRoot 只认 root —— 若把 admin 也算进去，「只有根用户能管理管理员」会变成「两个管理员互相能管」');
  assert(roles.isStaff('root') && roles.isStaff('admin') && !roles.isStaff('user'),
    'isStaff 表示「管理层」：根用户必须与管理员同级，否则它连用户管理都进不去');
  assertEqual(roles.isAssignableRole('root'), false, 'root 不可授予（不可重复授予的硬约束）');
  assertEqual(roles.isAssignableRole('admin'), true);
  assertEqual(roles.isAssignableRole('user'), true);
});

test('R71 · 判据：「谁管谁」的矩阵（canManageUser 是唯一判定点）', () => {
  assertEqual(roles.canManageUser('root', 'root'), true, '根用户可以管理其他根用户');
  assertEqual(roles.canManageUser('root', 'admin'), true, '根用户可以管理管理员');
  assertEqual(roles.canManageUser('root', 'user'), true);
  assertEqual(roles.canManageUser('admin', 'user'), true, '管理员可以管理普通用户');
  assertEqual(roles.canManageUser('admin', 'admin'), false,
    '管理员不能管理管理员 —— 这正是「管理员之间可以互相删除」的漏洞点');
  assertEqual(roles.canManageUser('admin', 'root'), false, '管理员不能管理根用户');
  assertEqual(roles.canManageUser('user', 'user'), false, '普通用户连普通用户也不能管');
});

test('R71 · 判据：角色标签（审计日志与界面同源）', () => {
  assertEqual(roles.roleLabel('root'), '根用户');
  assertEqual(roles.roleLabel('admin'), '管理员');
  assertEqual(roles.roleLabel('user'), '普通用户');
  assertEqual(roles.roleLabel(undefined), '普通用户', '未知值按最小权限展示，不抛错');
});

test('R71 · 判据：只有根用户可以调整角色（改角色 = 授予角色）', () => {
  assertEqual(roles.canAssignRole('root'), true);
  assertEqual(roles.canAssignRole('admin'), false,
    '管理员能改角色就能把普通用户提成管理员（= 添加管理员），需求明确禁止');
  assertEqual(roles.canAssignRole('user'), false);
});

/* ================================================================== *
 * ② 存储层
 * ================================================================== */

test('R71 · 存储：空库的第一个账户**强制**成为根用户（即使调用方请求 admin）', async () => {
  assertEqual(configStore.listUsers().length, 0, '前置：库应为空（本用例是全文件第一个建号的）');
  const id = await mkUser('first-owner', 'admin');
  const u = configStore.getUserById(id);
  assertEqual(u.role, 'root',
    '「第一个账户 = 根用户」的判据在存储层，不在 /auth/init —— 否则清空用户后走公开注册就能绕过');
});

test('R71 · 存储：已有账户后再请求 root 一律拒绝，请求 admin 则是普通管理员', async () => {
  const adminId = await mkUser('boss-admin', 'admin');
  assertEqual(configStore.getUserById(adminId).role, 'admin', '第二个账户不能自动成为根用户');

  let err = null;
  try { await mkUser('want-root', 'root'); } catch (e) { err = e; }
  assert(err, '已有账户后请求 root 必须失败');
  assertEqual(err.status, 403, `应为 403，实际 ${err && err.status}`);
  assert(!configStore.listUsers().some((u) => u.username === 'want-root'), '失败的建号不得留下半条记录');
  assertEqual(configStore.listUsers().filter((u) => u.role === 'root').length, 1,
    '任何路径都不能产出第二个根用户（不可重复授予）');
});

test('R71 · 存储：根用户的角色不可撤销（updateUser 拒绝任何降级）', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  let err = null;
  try { await configStore.updateUser(root.id, { role: 'admin' }); } catch (e) { err = e; }
  assert(err, '降级根用户必须失败');
  assertEqual(err.status, 400, `应为 400，实际 ${err && err.status}`);
  assertEqual(configStore.getUserById(root.id).role, 'root', '失败后角色必须原样');

  // 反向：普通用户的角色可以被根用户调整（证明上面那条不是「角色一律不能改」）
  const plainId = await mkUser('promo-target', 'user');
  const after = await configStore.updateUser(plainId, { role: 'admin' });
  assertEqual(after.role, 'admin');
  await configStore.updateUser(plainId, { role: 'user' });
});

test('R71 · 存储：最后一个根用户不可删除', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  let err = null;
  try { configStore.removeUser(root.id); } catch (e) { err = e; }
  assert(err, '删掉唯一的根用户必须失败');
  assertEqual(err.status, 400, `应为 400，实际 ${err && err.status}`);
  assertEqual(configStore.getUserById(root.id).role, 'root', '失败后账户必须还在');
});

/**
 * 读盘归一 + 存量迁移：手工写一份「只有 admin、没有 root」的 config.enc，
 * 再用**全新模块实例**读它 —— 这正是升级场景（旧版本落盘的文件里没有 root）。
 */
test('R71 · 存储：升级到本版本时，最早创建的账户被补成根用户（且 root 不会被读盘降级）', async () => {
  const cfgFile = path.join(tmp.dir, 'config.enc');
  const current = configStore.decrypt(fs.readFileSync(cfgFile, 'utf8'));
  const crafted = JSON.parse(JSON.stringify(current));
  crafted.users = crafted.users.map((u, i) => Object.assign({}, u, {
    role: 'admin', // 模拟旧版本：全库没有 root
    createdAt: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), // 越靠后越晚创建
  }));
  // 故意打乱数组顺序：迁移必须按 createdAt 选人，而不是按数组下标
  crafted.users.reverse();
  fs.writeFileSync(cfgFile, configStore.encrypt(crafted));

  const storePath = SERVER('config-store.js');
  delete require.cache[require.resolve(storePath)];
  const fresh = require(storePath);
  const users = fresh.listUsers();
  const roots = users.filter((u) => u.role === 'root');
  assertEqual(roots.length, 1, `补出来的根用户必须恰好一个，实际 ${roots.length}`);
  assertEqual(roots[0].createdAt, crafted.users.map((u) => u.createdAt).sort()[0],
    '被补成根用户的必须是**最早创建**的那个账户');

  // 再读一次同一个对象：root 不得被读盘归一降级成 user
  assertEqual(fresh.getUserById(roots[0].id).role, 'root',
    '读盘归一必须认可 root（旧实现的白名单只有 admin/user，读一次就降一次）');

  // 还原模块：后续用例继续用最初那个实例（它的缓存仍指向内存中的正确配置）
  delete require.cache[require.resolve(storePath)];
  require(storePath);
});

/* ================================================================== *
 * ③ 路由层
 * ================================================================== */

test('R71 · 路由：管理员删除**另一个管理员** ⇒ 403，且目标一字节未改', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const adminA = configStore.listUsers().find((u) => u.role === 'admin');
  assert(adminA, '前置：库里应有一个管理员');
  // 给目标建一个会话：403 之后它必须仍然有效（「踢掉会话」同样是破坏）
  const token = authSession.createSession(configStore.userView(configStore.getUserById(adminA.id)), {});
  logs.length = 0;

  const r = await api('DELETE', `/api/users/${adminA.id}`, { as: root.id === adminA.id ? '' : adminA.id });
  // 用「另一个管理员」当发起者：上面那个 adminA 就是目标，需要一个不同的管理员身份
  // （若库里还没有第二个管理员，这里现建一个）
  let actor = configStore.listUsers().find((u) => u.role === 'admin' && u.id !== adminA.id);
  if (!actor) {
    await mkUser('admin-b', 'admin');
    actor = configStore.listUsers().find((u) => u.role === 'admin' && u.id !== adminA.id);
  }
  const r2 = await api('DELETE', `/api/users/${adminA.id}`, { as: actor.id });

  assertEqual(r2.status, 403, `管理员删管理员应 403，实际 ${r2.status}（${r2.raw}）`);
  assert(/只能管理普通用户/.test(String(r2.json && r2.json.error)),
    `文案应说明边界，实际：${r2.raw}`);
  assert(configStore.getUserById(adminA.id), '被拒绝后目标用户必须仍在库里');
  assertEqual(configStore.getUserById(adminA.id).role, 'admin', '角色也不得被顺手改动');
  assert(authSession.getSession(token), '被拒绝的删除不得吊销目标的会话');
  const denied = logs.filter((e) => e.action === 'users.denied');
  assertEqual(denied.length, 1, '越权尝试必须留一条审计日志（否则「有人反复试着删根用户」完全不可见）');
  assertEqual(denied[0].level, 'warn');
  assert(/删除/.test(denied[0].detail), `日志应写明动作，实际：${denied[0].detail}`);

  void r; // 上面那次请求只是为了确保「目标自己的 id」也走过一遍，不作断言
});

test('R71 · 路由：管理员删除**根用户** ⇒ 403，根用户与全库结构不变', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  const before = configStore.listUsers().length;
  const r = await api('DELETE', `/api/users/${root.id}`, { as: admin.id });
  assertEqual(r.status, 403, `应 403，实际 ${r.status}（${r.raw}）`);
  assert(configStore.getUserById(root.id), '根用户必须仍在');
  assertEqual(configStore.listUsers().length, before, '用户总数不得变化');
});

test('R71 · 路由：管理员编辑 / 封禁 / 强制登出管理员或根用户 ⇒ 一律 403', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  const target = configStore.listUsers().find((u) => u.role === 'admin' && u.id !== admin.id);

  const cases = [
    ['PUT', `/api/users/${root.id}`, { username: 'hijack-root' }, '编辑'],
    ['PUT', `/api/users/${target.id}`, { password: 'Hijack!2026abc' }, '编辑'],
    ['POST', `/api/users/${root.id}/ban`, { reason: '越权封禁', until: Date.now() + 3600000 }, '封禁'],
    ['POST', `/api/users/${root.id}/logout`, null, '强制登出'],
    ['POST', `/api/users/${target.id}/logout`, null, '强制登出'],
    ['POST', `/api/users/${root.id}/unban`, null, '解封'],
  ];
  for (const [method, url, body, label] of cases) {
    const r = await api(method, url, { as: admin.id, body });
    assertEqual(r.status, 403, `${label} ${url} 应 403，实际 ${r.status}（${r.raw}）`);
  }
  assertEqual(configStore.getUserById(root.id).username, 'first-owner', '根用户的用户名不得被改');
  assertEqual(configStore.banInfo(configStore.getUserById(root.id)).state, 'none', '根用户不得被封禁');
});

test('R71 · 路由：管理员只能创建普通用户（admin / root 均 403）', async () => {
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  let r = await api('POST', '/api/users', {
    as: admin.id, body: { username: 'admin-made-by-admin', password: PASSWORD, role: 'admin' },
  });
  assertEqual(r.status, 403, `管理员创建管理员应 403，实际 ${r.status}（${r.raw}）`);
  r = await api('POST', '/api/users', {
    as: admin.id, body: { username: 'root-made-by-admin', password: PASSWORD, role: 'root' },
  });
  assertEqual(r.status, 403, `请求 root 应 403，实际 ${r.status}（${r.raw}）`);
  assert(!configStore.listUsers().some((u) => u.username === 'admin-made-by-admin'), '403 之后不得建号');

  r = await api('POST', '/api/users', {
    as: admin.id, body: { username: 'plain-made-by-admin', password: PASSWORD },
  });
  assertEqual(r.status, 200, `管理员建普通用户应成功：${r.raw}`);
  assertEqual(r.json.user.role, 'user');
});

test('R71 · 路由：管理员不能把普通用户「提拔」成管理员（改角色 = 授予角色）', async () => {
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  const plain = configStore.listUsers().find((u) => u.role === 'user');
  const r = await api('PUT', `/api/users/${plain.id}`, { as: admin.id, body: { role: 'admin' } });
  assertEqual(r.status, 403, `应 403，实际 ${r.status}（${r.raw}）`);
  assertEqual(configStore.getUserById(plain.id).role, 'user', '角色不得被改动');
});

/**
 * 「授予角色」的通道不止用户管理页那一条。
 *
 * 需求里「管理员无权添加管理员」若只堵 `POST /users`，那么管理员改走**邀请码**
 * （发一张 `role: 'admin'` 的码）或改**站点设置里的「新用户身份」**（设为 admin，
 * 之后每个注册者都是管理员）就绕过去了 —— 两条都不需要碰用户管理接口。
 * 故这里把另外两条通道一并钉住，并各留一条**正向对照**（普通用户身份仍可发码），
 * 防止把闸门做成「管理员什么都不能干」。
 */
test('R71 · 路由：邀请码与站点「新用户身份」两条授予通道都只对根用户开放', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  assert(root && admin, '前置：库里同时存在根用户与管理员');

  // ① 邀请码：发一张「管理员」身份的码 = 授予管理员
  let r = await api('POST', '/api/invites', { as: admin.id, body: { count: 1, role: 'admin' } });
  assertEqual(r.status, 403, `管理员发管理员邀请码应 403，实际 ${r.status}（${r.raw}）`);
  r = await api('POST', '/api/invites', { as: admin.id, body: { count: 1, role: 'user' } });
  assertEqual(r.status, 200, `管理员发普通用户邀请码仍应允许：${r.raw}`);
  r = await api('POST', '/api/invites', { as: root.id, body: { count: 1, role: 'admin' } });
  assertEqual(r.status, 200, `根用户发管理员邀请码应允许：${r.raw}`);
  const inviteId = r.json.invites[0].id;

  // ② 邀请码：把**已发出的**码改成管理员身份，同样是授予（单条 / 批量两个入口）
  r = await api('PUT', `/api/invites/${inviteId}`, { as: admin.id, body: { role: 'admin' } });
  assertEqual(r.status, 403, `管理员改码身份应 403，实际 ${r.status}（${r.raw}）`);
  r = await api('POST', '/api/invites/bulk', { as: admin.id, body: { ids: [inviteId], role: 'admin' } });
  assertEqual(r.status, 403, `批量改码身份同样 403，实际 ${r.status}（${r.raw}）`);
  r = await api('PUT', `/api/invites/${inviteId}`, { as: root.id, body: { role: 'admin' } });
  assertEqual(r.status, 200, `根用户改码身份应允许：${r.raw}`);

  // ③ 站点设置：把「新用户身份」设成管理员 = 给所有注册者发管理员
  r = await api('PUT', '/api/site/config', { as: admin.id, body: { defaultRole: 'admin' } });
  assertEqual(r.status, 403, `管理员改「新用户身份」应 403，实际 ${r.status}（${r.raw}）`);
  assertEqual(configStore.getSite().defaultRole, 'user', '403 之后配置不得被改动');
  r = await api('PUT', '/api/site/config', { as: root.id, body: { defaultRole: 'admin' } });
  assertEqual(r.status, 200, `根用户应可设置：${r.raw}`);
  assertEqual(configStore.getSite().defaultRole, 'admin');
  // 还原，避免影响后面的用例
  r = await api('PUT', '/api/site/config', { as: root.id, body: { defaultRole: 'user' } });
  assertEqual(r.status, 200);
});

test('R71 · 路由：根用户可以管理管理员（编辑 / 提权 / 降权 / 删除）', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const plain = configStore.listUsers().find((u) => u.role === 'user');

  let r = await api('PUT', `/api/users/${plain.id}`, { as: root.id, body: { role: 'admin' } });
  assertEqual(r.status, 200, `根用户提权应成功：${r.raw}`);
  assertEqual(configStore.getUserById(plain.id).role, 'admin');

  r = await api('PUT', `/api/users/${plain.id}`, { as: root.id, body: { username: 'promoted-then-renamed' } });
  assertEqual(r.status, 200, `根用户编辑管理员应成功：${r.raw}`);

  r = await api('DELETE', `/api/users/${plain.id}`, { as: root.id });
  assertEqual(r.status, 200, `根用户删除管理员应成功：${r.raw}`);
  assert(!configStore.getUserById(plain.id), '删除应真的生效');
});

test('R71 · 路由：任何人（含根用户）都不能把某账户授予/撤销根用户', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const admin = configStore.listUsers().find((u) => u.role === 'admin');

  let r = await api('PUT', `/api/users/${admin.id}`, { as: root.id, body: { role: 'root' } });
  assertEqual(r.status, 403, `根用户也不能授予 root，实际 ${r.status}（${r.raw}）`);
  assertEqual(configStore.getUserById(admin.id).role, 'admin', '不得被静默改写');

  r = await api('PUT', `/api/users/${root.id}`, { as: root.id, body: { role: 'admin' } });
  assertEqual([400, 403].includes(r.status), true, `撤销 root 必须被拒，实际 ${r.status}（${r.raw}）`);
  assertEqual(configStore.getUserById(root.id).role, 'root');
});

test('R71 · 路由：管理员删普通用户仍然成功（正向对照：别把闸门做成「一律禁止」）', async () => {
  const admin = configStore.listUsers().find((u) => u.role === 'admin');
  const id = await mkUser('deletable-plain', 'user');
  const r = await api('DELETE', `/api/users/${id}`, { as: admin.id });
  assertEqual(r.status, 200, `管理员删普通用户应成功：${r.raw}`);
  assert(!configStore.getUserById(id), '应真的删掉');
});

test('R71 · 路由：根用户不能删自己（自保护优先于「根用户可管任何人」）', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const r = await api('DELETE', `/api/users/${root.id}`, { as: root.id });
  assertEqual(r.status, 400, `删自己应 400，实际 ${r.status}（${r.raw}）`);
  assert(configStore.getUserById(root.id), '账户必须还在');
});

test('R71 · 路由：根用户通过 requireAdmin 进入管理接口（GET /users 返回全部）', async () => {
  const root = configStore.listUsers().find((u) => u.role === 'root');
  const r = await api('GET', '/api/users', { as: root.id });
  assertEqual(r.status, 200, `根用户必须能读用户列表：${r.raw}`);
  assertEqual(r.json.scope, 'all', '根用户应拿到全部用户（与管理员同级），而不是 scope:self');
});

test('R71 · 路由：管理接口对普通用户仍然 403（原有边界不因新角色而放松）', async () => {
  const plainId = await mkUser('plain-actor', 'user');
  for (const [method, url] of [
    ['GET', '/api/users'],
    ['POST', '/api/users'],
  ]) {
    const r = await api(method, url, { as: plainId, body: { username: 'nope', password: PASSWORD } });
    // GET /users 对普通用户是「只回自己」，不是 403 —— 这里只断言**写**接口被拒
    if (method === 'GET') {
      assertEqual(r.status, 200);
      assertEqual(r.json.scope, 'self', '普通用户只能看到自己');
    } else {
      assertEqual(r.status, 403, `普通用户建号应 403，实际 ${r.status}（${r.raw}）`);
    }
  }
});

/* ================================================================== *
 * ④ 前端层（静态接线）
 * ================================================================== */

test('R71 · 前端：角色判据收在 util.js，且模块里不再有 role === \'admin\' 字面量', () => {
  const util = fs.readFileSync(JS('util.js'), 'utf8');
  assert(/export function isStaffRole\(role\)/.test(util), 'isStaffRole 必须是前端唯一判据');
  assert(/export function roleLabel\(role\)/.test(util), 'roleLabel 必须与服务端同文案');

  /**
   * ⚠️ 判据不是「文件里出现 `role === 'admin'` 就红」——那会把两处**纯粹展示**的用法
   * 也判死：① 角色徽章 `u.role === 'admin' ? '管理员' : …`（前面已经先判了 root）；
   * ② `<option value="admin" …>` 的选中项。它们不决定谁能做什么，改成一刀切只会
   * 逼着后面的人把这条护栏注释掉。
   *
   * 真正要守的是**权限门控**：凡是「当前登录者是不是管理员」的判断都必须走
   * `isStaffRole()`。故判据 = 该文件出现过 `isStaffRole(`，且残留的 `role === 'admin'`
   * 不超过登记在案的展示处数。
   */
  const ALLOWED_LITERALS = { 'syssettings.js': 2 };
  // 有权限门控的模块：必须用 isStaffRole()
  for (const f of ['main.js', 'syssettings.js', 'bucketmgr.js', 'credmgr.js', 'dashboard.js',
    'explorer.js', 'ipmgr.js', 'ops.js', 'paysettings.js']) {
    const src = fs.readFileSync(JS(f), 'utf8');
    assert(/isStaffRole\(/.test(src), `${f} 必须用 isStaffRole() 判「当前登录者是否管理层」`);
    const n = (src.match(/\.role === 'admin'/g) || []).length;
    assert(n <= (ALLOWED_LITERALS[f] || 0),
      `${f} 里还有 ${n} 处 role === 'admin'（登记允许 ${ALLOWED_LITERALS[f] || 0} 处展示用法）：`
      + '权限门控一律改成 isStaffRole()，否则根用户会在那一处被当成普通用户');
  }

  // profile.js 没有权限门控（只展示自己的角色），但它同样不能把根用户显示成普通用户
  const profile = fs.readFileSync(JS('profile.js'), 'utf8');
  assert(/roleLabel\(me\.role\)/.test(profile), 'profile.js 的角色文案必须走 roleLabel()');
  assert(!/role === 'admin'/.test(profile), 'profile.js 不得再自行拼角色文案');
});

test('R71 · 前端：用户管理表格给出根用户徽章，并按「是否根用户」门控他人按钮', () => {
  const src = fs.readFileSync(JS('syssettings.js'), 'utf8');
  assert(/lk-badge root/.test(src), '必须渲染「根用户」徽章');
  assert(/const denied = !isSelf && !iAmRoot && u\.role !== 'user';/.test(src),
    '按钮门控判据必须与服务端 canManageUser 同口径（目标非普通用户 + 自己不是根用户）');
  assert(/仅根用户可管理/.test(src), '禁用按钮要有说明性 title，而不是点下去才 403');
  assert(/canEditRole = admin && !isSelf && App\.state\.user && App\.state\.user\.role === 'root'/.test(src),
    '角色下拉只对根用户出现');
  assert(!/<option value="root"/.test(src), '界面上绝不能出现「根用户」这一档 —— 它不可授予');
});

test('R71 · 前端：邀请码的「管理员」身份只对根用户渲染', () => {
  const src = fs.readFileSync(JS('invitemgr.js'), 'utf8');
  assert(/const canGrantAdmin = Boolean\(App\.state\.user && App\.state\.user\.role === 'root'\)/.test(src),
    '管理员不该看到「管理员」这一档（服务端也会 403，但界面留一个必然失败的选项只会误导）');
  assert(/\$\{canGrantAdmin/.test(src), 'admin 选项必须按 canGrantAdmin 条件渲染');
});
