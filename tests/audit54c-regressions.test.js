/**
 * 第 54 轮护栏（第三部分）—— 邀请码系统
 *
 * 需求原文：
 *  > 4、在左侧栏（side-foot）新增“邀请码设置”；
 *  > 4.1、管理员可批量生成、删除邀请码，并单独、批量设置邀请码的使用次数、
 *  >      过期时间、注册后的身份。
 *  >（用户追加）管理员可批量导出邀请码，文件格式为 txt，一行一个。
 *
 * ## 断言分五层，缺一层就留一种假绿
 *
 *  ① **判据层**（真实 `server/limits.js`）：邀请码入参判据与归一化；
 *  ② **存储层**（真实 `server/invite-store.js`）：生成 / 核销 / 回滚 / 批量设置 /
 *     删除 / 导出 / 状态判定 / 脏数据丢弃；
 *  ③ **路由层**（真 HTTP）：六条接口的鉴权（未登录 / 普通用户 / 管理员）、
 *     生成与批量设置的回环、导出的**文本形状**（一行一个、末尾换行）；
 *  ④ **注册接入层**（真 HTTP）：三种注册模式 × 邀请码的四档失败 × 身份取自邀请码 ×
 *     建号失败回滚；
 *  ⑤ **前端层**：侧栏入口与页面、`MAIN_VIEWS` / `VIEW_ENTRY` 的角色门控、
 *     六个 API 方法与 `requestText`、登录页邀请码输入框。
 *
 * ⚠️ 配置与用户会**真实落盘**（`config.enc` / `invites.json`），因此必须在 require 之前
 *    把 `S3_DATA_DIR` 指到临时目录 —— 否则跑一次测试就在项目真实 `data/` 里留下一堆
 *    测试用户与邀请码。
 *
 * ⚠️ 限流键取自 `security.clientIp()`，默认只认 socket 对端 ⇒ 注册限流器（10 次 / 10 分钟）
 *    会被跨用例互相消耗，出现「单独跑绿、一起跑红」。故本文件显式打开 `TRUST_PROXY=1`
 *    并**逐请求给一个不同的 `X-Forwarded-For`**（见 `nextIp()`）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('r54c-');
process.env.S3_DATA_DIR = tmp.dir;
process.env.TRUST_PROXY = '1'; // 见文件头：为了按请求隔离限流预算

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const readJs = (n) => fs.readFileSync(JS(n), 'utf8');
const readHtml = () => fs.readFileSync(PUBLIC('index.html'), 'utf8');
/** 剥掉注释后的源码 —— 判「有没有某段代码」时必须先剥：注释里出现同名词是本仓库的经典假绿 */
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

const express = require(path.join(ROOT, 'node_modules', 'express'));
const limits = require(SERVER('limits.js'));
const configStore = require(SERVER('config-store.js'));
const secureStore = require(SERVER('secure-store.js'));
const inviteStore = require(SERVER('invite-store.js'));

const authRoutes = require(SERVER('routes', 'auth.js'));
const inviteRoutes = require(SERVER('routes', 'invite.js'));

const PASSWORD = 'Unit!2026abc';

/** 邀请码形态：10 位、全大写、不含 0/O/1/I/L */
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;

let ipSeq = 0;
/** 每次请求换一个来源 IP：隔离注册限流器的预算（见文件头） */
function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}

let server = null;
let port = 0;

/**
 * ⚠️ 冒充身份必须**随请求头走**，不能用闭包变量 —— 中间件只在起服务器那一次注册，
 * 它捕获的是首次调用时的形参作用域，后续传的身份根本进不去
 * （R54② 实测症状：除第一条以外全部 401 / 403）。
 */
async function api(method, urlPath, { ip, body, as } = {}) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const raw = req.headers['x-test-auth'];
      if (raw) { req.authUser = JSON.parse(raw); req.sessionToken = 'test-session-token'; }
      next();
    });
    /**
     * 模拟 `server/index.js` 的鉴权闸门：**非公开路径**上没有会话一律 401。
     *
     * 少了这一层，「未登录」会被 `requireAdmin` 判成 403 —— 而真实部署下它是 401，
     * 两者对前端的意义完全不同（401 触发跳登录、403 只是提示无权限）。
     * 这里只对 `/api/invites*` 生效：`/api/auth/register` 是匿名白名单里的，
     * 给它加闸门会把注册用例全部挡成 401。
     */
    app.use('/api/invites', (req, res, next) => {
      if (!req.authUser) return res.status(401).json({ error: '登录已过期，请重新登录' });
      next();
    });
    app.use('/api', inviteRoutes);
    app.use('/api', authRoutes);
    server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }
  const headers = { 'X-Forwarded-For': ip || nextIp() };
  if (as) headers['x-test-auth'] = JSON.stringify(as);
  return request(port, method, urlPath, { headers, body: body === undefined ? null : body });
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir, {
    label: 'r54c-',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});

/* ================================================================== *
 * 第 1 层 · 判据层（真实 limits.js）
 * ================================================================== */

test('R54c-01a · 邀请码归一化：去全部空白 + 转大写（粘贴带换行 / 分组空格都能对上）', () => {
  assertEqual(limits.normalizeInviteCode(' abcd efgh jk '), 'ABCDEFGHJK');
  assertEqual(limits.normalizeInviteCode('AB\nCD\tEFGHJK'), 'ABCDEFGHJK');
  assertEqual(limits.normalizeInviteCode(null), '');
  assertEqual(limits.normalizeInviteCode(undefined), '');
  // 归一化本身**不判合法性**：长度不对照样原样返回，判据在 parseInviteCodeInput
  assertEqual(limits.normalizeInviteCode('ABC'), 'ABC');
});

test('R54c-01b · 邀请码格式判据：长度 / 字符集 / 换行三档', () => {
  // 正例：由生成器产出的码必然合法
  const good = inviteStore.generate({
    count: 1, role: 'user', maxUses: 0, expiresAt: null, note: '', createdBy: 't',
  })[0].code;
  assertEqual(limits.parseInviteCodeInput(good).ok, true, `生成出来的码必须能通过自己的判据（${good}）`);
  // 小写 + 空格同样合法（归一化后是同一枚码）
  assertEqual(limits.parseInviteCodeInput(' ' + good.toLowerCase() + ' ').value, good, '大小写与首尾空格都要归一');
  // 反例：空 / 太短 / 太长的邀请码
  assertEqual(limits.parseInviteCodeInput('').ok, false, '空串非法');
  assertEqual(limits.parseInviteCodeInput('ABC').ok, false, '长度不足非法');
  assertEqual(limits.parseInviteCodeInput(good + 'A').ok, false, '长度超出非法');
  // 反例：字符集 —— 0 / O / 1 / I / L 刻意被排除（易混字符），斜杠等更不合法
  for (const bad of ['ABCDEFGHJ0', 'ABCDEFGHJO', 'ABCDEFGHJ1', 'ABCDEFGHJI', 'ABCDEFGHJL', 'ABCDEFGHJ/', 'ABCDEFGHJ-']) {
    assertEqual(limits.parseInviteCodeInput(bad).ok, false, `字符集外的 ${bad} 必须非法`);
  }
  /**
   * ⚠️ 换行必须在**归一化之前**被拒（与 `parseEmailInput` 同一条纪律）。
   * 先归一会把 `\r\n` 吃掉，于是「粘贴带了换行」与「真的少写了一位的区别」
   * 在服务端看起来一模一样，用户只能反复看到同一句「格式不正确」。
   */
  const nl = limits.parseInviteCodeInput('ABCDEFGHJK\n');
  assertEqual(nl.ok, false, '带换行的输入必须被拒（而不是被静默归一）');
  assertMatch(nl.error, /换行/, '报错要指出原因是换行，否则用户无从自查');
  assertEqual(limits.parseInviteCodeInput('ABCD\r\nEFGHJK').ok, false, '中间换行同样要拒');
});

test('R54c-01c · 数量 / 次数上限 / 过期时间 / 备注四个入参判据', () => {
  // 生成数量：1 ~ INVITE_BATCH_MAX
  assertEqual(limits.parseInviteCountInput(1).ok, true);
  assertEqual(limits.parseInviteCountInput(limits.INVITE_BATCH_MAX).ok, true);
  for (const bad of [0, -1, 1.5, limits.INVITE_BATCH_MAX + 1, '', null, undefined, 'abc']) {
    assertEqual(limits.parseInviteCountInput(bad).ok, false, `生成数量 ${JSON.stringify(bad)} 必须非法`);
  }
  assertEqual(limits.parseInviteCountInput('5').value, 5, '数字字符串要接受（表单/JSON 常给出字符串）');

  // 次数上限：**0 合法且语义是「不限制」**，负数是必须拒的那一档
  assertEqual(limits.parseInviteMaxUsesInput(0).ok, true, '0 必须合法（= 不限制）');
  assertEqual(limits.parseInviteMaxUsesInput(0).value, 0);
  assertEqual(limits.parseInviteMaxUsesInput(-1).ok, false, '负数必须 400 —— 落盘归一会把 -1 归成 0（不限制），正好把限制完全放开');
  assertEqual(limits.parseInviteMaxUsesInput(limits.INVITE_MAX_USES_MAX + 1).ok, false);

  // 过期时间：null / '' = 永久；过去时刻必须拒（要立即失效有「停用」）
  const now = 1_800_000_000_000;
  assertEqual(limits.parseInviteExpiresInput(null, now).value, null, 'null = 永久有效');
  assertEqual(limits.parseInviteExpiresInput('', now).value, null, '空串 = 永久有效');
  assertEqual(limits.parseInviteExpiresInput(now + 60_000, now).value, new Date(now + 60_000).toISOString(), '数字按 epoch 毫秒');
  assertEqual(limits.parseInviteExpiresInput('2030-01-01T00:00:00Z', now).ok, true);
  assertEqual(limits.parseInviteExpiresInput('2000-01-01T00:00:00Z', now).ok, false, '过去的时刻必须拒');
  assertEqual(limits.parseInviteExpiresInput(now, now).ok, false, '恰好等于 now 也算「不晚于当前时间」');
  assertEqual(limits.parseInviteExpiresInput('不是时间', now).ok, false);
  assertEqual(limits.parseInviteExpiresInput('2030-01-01\n', now).ok, false, '换行同样先拒');

  // 备注：复用 parseSmtpTextInput 的两条判据（拒换行 + 夹长度）
  assertEqual(limits.parseInviteNoteInput('  市场部  ').value, '市场部');
  assertEqual(limits.parseInviteNoteInput('').value, '');
  assertEqual(limits.parseInviteNoteInput('a\r\nb').ok, false, '备注不能含换行（它会进审计日志）');
  assertEqual(limits.parseInviteNoteInput('x'.repeat(limits.INVITE_NOTE_MAX + 1)).ok, false, '超长备注非法');
});

/* ================================================================== *
 * 第 2 层 · 存储层（真实 invite-store.js）
 * ================================================================== */

test('R54c-02a · 生成：码形合法、批内不重复、字段按入参落盘', () => {
  const made = inviteStore.generate({
    count: 25, role: 'admin', maxUses: 3, expiresAt: null, note: '批次甲', createdBy: 'boss',
  });
  assertEqual(made.length, 25, '应生成 25 枚');
  assertEqual(new Set(made.map((x) => x.code)).size, 25, '同一批内不得出现重复码');
  for (const m of made) {
    assertMatch(m.code, CODE_RE, `码形必须合法（实际 ${m.code}）`);
    assertEqual(m.role, 'admin', '身份按入参落盘');
    assertEqual(m.maxUses, 3);
    assertEqual(m.used, 0);
    assertEqual(m.remaining, 3);
    assertEqual(m.status, 'active');
    assertEqual(m.note, '批次甲');
    assertEqual(m.createdBy, 'boss');
    assertEqual(m.expiresAt, null, 'null = 永久有效');
  }
  // 与库里已有的码也不得撞（这条由 generate 的撞码重摇循环保证）
  const all = inviteStore.list().map((x) => x.code);
  assertEqual(new Set(all).size, all.length, '全局不得出现重复码');
});

test('R54c-02b · 核销四档失败 + 用满即失效；`remaining` 为 null 表示不限制', () => {
  const [a] = inviteStore.generate({ count: 1, role: 'user', maxUses: 2, expiresAt: null, note: '', createdBy: 't' });
  assertEqual(a.remaining, 2);
  assertEqual(inviteStore.consume(a.code, 'alice').ok, true);
  const second = inviteStore.consume(a.code.toLowerCase(), 'bob');
  assertEqual(second.ok, true, '小写输入也要能核销（归一化）');
  assertEqual(second.invite.used, 2);
  assertEqual(second.invite.remaining, 0);
  assertEqual(second.invite.status, 'used_up', '用满 → used_up');
  assertEqual(inviteStore.consume(a.code, 'carol').reason, 'used_up', '再核销 → used_up（而不是「删掉记录」变成 not_found）');

  // 四种失败原因必须可区分 —— 合成一句话等于把四种不同的下一步动作混成一种
  assertEqual(inviteStore.consume('ZZZZZZZZZZ', 'x').reason, 'not_found');
  assertEqual(inviteStore.consume('', 'x').reason, 'not_found');
  const [d] = inviteStore.generate({ count: 1, role: 'user', maxUses: 0, expiresAt: null, note: '', createdBy: 't' });
  inviteStore.update(d.id, { disabled: true });
  assertEqual(inviteStore.consume(d.code, 'x').reason, 'disabled');
  const [e] = inviteStore.generate({ count: 1, role: 'user', maxUses: 0, expiresAt: null, note: '', createdBy: 't' });
  inviteStore.update(e.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assertEqual(inviteStore.consume(e.code, 'x').reason, 'expired');

  // maxUses = 0 是**不限制**：连核销 5 次都成功，且 remaining 为 null
  const [f] = inviteStore.generate({ count: 1, role: 'user', maxUses: 0, expiresAt: null, note: '', createdBy: 't' });
  for (let i = 0; i < 5; i++) assertEqual(inviteStore.consume(f.code, 'u' + i).ok, true, '不限制的码可以反复使用');
  assertEqual(inviteStore.list().find((x) => x.id === f.id).remaining, null, '不限制时 remaining 必须是 null（不是 0）');
});

test('R54c-02c · 回滚：只归还与本用户名相同的那一条，计数一并退回', () => {
  const [a] = inviteStore.generate({ count: 1, role: 'user', maxUses: 2, expiresAt: null, note: '', createdBy: 't' });
  inviteStore.consume(a.code, 'alice');
  inviteStore.consume(a.code, 'bob');
  assertEqual(inviteStore.rollback(a.id, 'bob'), true);
  const rec = inviteStore.list().find((x) => x.id === a.id);
  assertEqual(rec.used, 1, '计数退回');
  assertEqual(rec.usedBy.join(','), 'alice', '只删掉 bob 那一条，alice 的名字必须留着');
  assertEqual(rec.status, 'active', '回滚后恢复可用');
  assertEqual(inviteStore.rollback(a.id, 'nobody'), true, '有次数可退时回滚成立（退掉最近一条）');
  assertEqual(inviteStore.rollback(a.id, 'nobody'), false, '没有次数可退时回滚返回 false（不得把 used 压成负数）');
  assertEqual(inviteStore.list().find((x) => x.id === a.id).used, 0);
  assertEqual(inviteStore.rollback('no-such-id', 'x'), false, '不存在的 id 回滚返回 false');
});

test('R54c-02d · 批量设置：PATCH 语义（只改出现过的字段）+ 不存在的 id 计入 skipped', () => {
  const made = inviteStore.generate({ count: 3, role: 'user', maxUses: 1, expiresAt: null, note: '旧', createdBy: 't' });
  const r = inviteStore.bulkUpdate([made[0].id, made[1].id, 'ghost-id'], { maxUses: 9, role: 'admin' });
  assertEqual(r.updated, 2, '两条命中');
  assertEqual(r.skipped, 1, '不存在的 id 必须如实计入 skipped（而不是整批失败）');
  const l = inviteStore.list();
  for (const id of [made[0].id, made[1].id]) {
    const x = l.find((y) => y.id === id);
    assertEqual(x.maxUses, 9, '未给出的字段保持原值？—— maxUses 给出了，应改成 9');
    assertEqual(x.role, 'admin');
    assertEqual(x.note, '旧', '**没有出现在 patch 里的 note 必须保持原值**（PATCH 语义）');
    assertEqual(x.expiresAt, null, '没给 expiresAt 也不能被顺手改成别的');
  }
  assertEqual(l.find((y) => y.id === made[2].id).maxUses, 1, '未被选中的那条完全不动');

  // disabled: false / maxUses: 0 / expiresAt: null 三个「假值」都必须是**有效指令**
  const [z] = inviteStore.generate({ count: 1, role: 'admin', maxUses: 5, expiresAt: new Date(Date.now() + 3600e3).toISOString(), note: 'x', createdBy: 't' });
  inviteStore.update(z.id, { disabled: true });
  assertEqual(inviteStore.consume(z.code, 'u').reason, 'disabled');
  inviteStore.update(z.id, { disabled: false });
  assertEqual(inviteStore.consume(z.code, 'u').ok, true, 'disabled:false 必须真的重新启用（真值判断会让它静默失效）');
  inviteStore.update(z.id, { maxUses: 0 });
  assertEqual(inviteStore.list().find((x) => x.id === z.id).maxUses, 0, 'maxUses:0 必须落成「不限制」');
  inviteStore.update(z.id, { expiresAt: null });
  assertEqual(inviteStore.list().find((x) => x.id === z.id).expiresAt, null, 'expiresAt:null 必须落成「永久」');
  inviteStore.update(z.id, { resetUsed: true });
  const afterReset = inviteStore.list().find((x) => x.id === z.id);
  assertEqual(afterReset.used, 0, 'resetUsed 要把计数清零');
  assertEqual(afterReset.usedBy.length, 0, '重置计数时 usedBy 必须一并清空（否则「最近谁在用」直接失真）');
});

test('R54c-02e · 导出：一行一个、末尾换行、无 BOM、可只导选中项', () => {
  const made = inviteStore.generate({ count: 4, role: 'user', maxUses: 0, expiresAt: null, note: '导出', createdBy: 't' });
  const ids = made.map((x) => x.id);
  const text = inviteStore.exportText({ ids });
  // 「一行一个」= n 个码时恰好 n+1 段（末尾那个空段来自收尾换行）
  assertEqual(text.split('\n').length, ids.length + 1, '导出文本必须恰好是 n 行 + 末尾一个换行');
  assert(text.endsWith('\n'), '末尾必须有换行 —— 否则 while read 一类的逐行消费会丢掉最后一行');
  assert(!text.startsWith('\uFEFF'), '不得带 BOM（邀请码全是 ASCII，BOM 只会污染第一行）');
  const lines = text.split('\n').slice(0, -1);
  assertEqual(lines.length, 4);
  for (const line of lines) assertMatch(line, CODE_RE, `每一行都必须恰好是一枚码（实际 ${JSON.stringify(line)}）`);
  assertEqual(new Set(lines).size, 4, '四行互不相同');
  // 顺序与库内顺序一致（导出的第一行就是列表里的第一枚）
  assertEqual(lines[0], made[0].code);

  const one = inviteStore.exportText({ ids: [made[2].id] });
  assertEqual(one, made[2].code + '\n', '按 ids 导出只含那一个');
  assertEqual(inviteStore.exportText({ ids: ['不存在'] }), '', '空集导出空串（**不是**一个孤零零的换行 —— 那看起来像一枚空码）');
  // 不给 ids = 全部
  const all = inviteStore.exportText({});
  assert(all.split('\n').length > ids.length + 1, '不给 ids 时应导出全部（本文件前面的用例已往库里放过码）');
});

test('R54c-02f · 脏数据不静默重建，但非法 / 重复记录整条丢弃（并打出告警）', () => {
  const file = path.join(tmp.dir, 'invites.json');
  const raw = secureStore.readJson(file, null);
  assert(raw && Array.isArray(raw.invites), 'invites.json 必须是 { invites: [...] } 形状');
  const before = raw.invites.length;
  raw.invites.push({ id: 'bad-1', code: 'BAD!!', role: 'user' });
  raw.invites.push({ id: 'bad-2', code: raw.invites[0].code, role: 'user' }); // 与第一条重复
  raw.invites.push(null);
  /**
   * ⚠️ 必须用 `secureStore.writeJson` 写回，**不能** `fs.writeFileSync(file, JSON.stringify(raw))`：
   * `readJson` 交出来的是**解密后的对象**，那么写回磁盘的就是明文，下一次读会落到
   * 「存在但不是合法密文」那条分支而抛错（`readJson` 的注释把这条列为本项目最不可逆的
   * 一类数据丢失）。用同一对读写构造脏数据，就绕开了这个坑。
   */
  secureStore.writeJson(file, raw);

  const got = withFreshInviteStore((fresh) => ({
    n: fresh.list().length,
    codes: fresh.list().map((x) => x.code),
  }));
  assertEqual(got.n, before, '非法码 / 重复码 / null 记录都被丢弃，合法记录一条不少');
  assert(!got.codes.includes('BAD!!'), '非法码必须真的不在表里');
  assertEqual(new Set(got.codes).size, got.codes.length, '重复码只保留一条（两条同码记录会让「核销的是哪一条」不确定）');
});

/**
 * 用一个**读磁盘**的新实例跑一段断言，跑完把 require 缓存**还原**成原实例。
 *
 * ⚠️ 必须还原：`server/routes/_context.js` 在模块加载时就把 `invite-store` 的实例
 * 固定住了（`inviteStore: require('../invite-store')`）。若不还原，
 * 本文件后面的用例通过 HTTP 改的是老实例、而断言读的是新实例 —— 会出现
 * 「路由明明写成功了，列表却是空的」这种纯粹由测试自己制造的假红。
 */
function withFreshInviteStore(fn) {
  const p = require.resolve(SERVER('invite-store.js'));
  const saved = require.cache[p];
  delete require.cache[p];
  try {
    return fn(require(p));
  } finally {
    require.cache[p] = saved;
  }
}

/* ================================================================== *
 * 第 3 层 · 路由层（真 HTTP，六条接口全部仅管理员）
 * ================================================================== */

const ADMIN = { id: 'u-admin', username: 'root', role: 'admin', permissions: {} };
/**
 * R71：**授予管理员**只有根用户能做（`invite.js` 的 `assertCanGrantRole`），
 * 故凡是「发一张 role=admin 的邀请码」的用例都得用这个身份。
 */
const ROOT_ACTOR = { id: 'u-root', username: 'root', role: 'root', permissions: {} };
const PLAIN = { id: 'u-plain', username: 'bob', role: 'user', permissions: {} };

test('R54c-03a · 六条邀请码接口全部要求管理员：未登录 401、普通用户 403', async () => {
  const calls = [
    ['GET', '/api/invites', undefined],
    ['POST', '/api/invites', { count: 1 }],
    ['POST', '/api/invites/bulk', { ids: ['x'], maxUses: 1 }],
    ['POST', '/api/invites/delete', { ids: ['x'] }],
    ['POST', '/api/invites/export', { ids: [] }],
    ['PUT', '/api/invites/x', { maxUses: 1 }],
  ];
  for (const [m, p, b] of calls) {
    const anon = await api(m, p, { body: b });
    assertEqual(anon.status, 401, `${m} ${p}：未登录应 401（实际 ${anon.status}）`);
    const plain = await api(m, p, { body: b, as: PLAIN });
    assertEqual(plain.status, 403, `${m} ${p}：普通用户应 403（实际 ${plain.status}）`);
    assertEqual((plain.json || {}).error, '仅管理员可执行该操作', `${m} ${p}：403 的文案要与 requireAdmin 同源`);
  }
});

test('R54c-03b · 生成 → 列表 → 批量设置 → 删除：真 HTTP 回环', async () => {
  // R71：本用例要发 role=admin 的码（授予管理员），只有根用户能做
  const gen = await api('POST', '/api/invites', {
    body: { count: 3, role: 'admin', maxUses: 2, note: 'HTTP 批次' },
    as: ROOT_ACTOR,
  });
  assertEqual(gen.status, 200);
  assertEqual((gen.json.invites || []).length, 3);
  const ids = gen.json.invites.map((x) => x.id);

  const list = await api('GET', '/api/invites', { as: ADMIN });
  assertEqual(list.status, 200);
  const seen = list.json.invites.filter((x) => ids.includes(x.id));
  assertEqual(seen.length, 3, '刚生成的三个必须出现在列表里');
  assertEqual(seen[0].role, 'admin');
  assertEqual(seen[0].note, 'HTTP 批次');
  // ⚠️ 管理员接口**原样回传 code** —— 打码会让这个页面失去意义（管理员正是要复制它）
  assertMatch(seen[0].code, CODE_RE, '管理员列表必须回传完整邀请码');

  const bulk = await api('POST', '/api/invites/bulk', {
    body: { ids: ids.slice(0, 2), maxUses: 7, disabled: true }, as: ADMIN,
  });
  assertEqual(bulk.status, 200);
  assertEqual(bulk.json.updated, 2);
  assertEqual(bulk.json.skipped, 0);
  const after = await api('GET', '/api/invites', { as: ADMIN });
  const two = after.json.invites.filter((x) => ids.slice(0, 2).includes(x.id));
  assert(two.every((x) => x.maxUses === 7 && x.status === 'disabled'), '两条都被改成 7 次 / 已停用');
  assertEqual(after.json.invites.find((x) => x.id === ids[2]).maxUses, 2, '未被选中的那条不动');

  const del = await api('POST', '/api/invites/delete', { body: { ids }, as: ADMIN });
  assertEqual(del.status, 200);
  assertEqual(del.json.removed, 3);
  const final = await api('GET', '/api/invites', { as: ADMIN });
  assertEqual(final.json.invites.filter((x) => ids.includes(x.id)).length, 0, '删除后不得再出现在列表里');
});

test('R54c-03c · 入参非法一律 400（不静默改写），且不留下任何副作用', async () => {
  const cases = [
    { body: { count: 0 }, msg: '数量 0' },
    { body: { count: 501 }, msg: '数量超上限' },
    { body: { count: 1, maxUses: -1 }, msg: '负的次数上限' },
    { body: { count: 1, role: 'boss' }, msg: '非法身份' },
    { body: { count: 1, expiresAt: '2000-01-01T00:00:00Z' }, msg: '过期时间在过去' },
    { body: { count: 1, note: 'a\nb' }, msg: '备注含换行' },
    { body: { count: 1, note: 'x'.repeat(200) }, msg: '备注超长' },
  ];
  for (const c of cases) {
    const before = inviteStore.list().length;
    const r = await api('POST', '/api/invites', { body: c.body, as: ADMIN });
    assertEqual(r.status, 400, `${c.msg}：应 400（实际 ${r.status}）`);
    assert((r.json || {}).error, `${c.msg}：400 必须带可读文案`);
    assertEqual(inviteStore.list().length, before, `${c.msg}：非法入参**不得**留下任何新记录`);
  }
  // 批量接口：空 ids / 没有任何要改的字段 都是 400（而不是「静默成功」）
  assertEqual((await api('POST', '/api/invites/bulk', { body: { ids: [], maxUses: 1 }, as: ADMIN })).status, 400);
  assertEqual((await api('POST', '/api/invites/bulk', { body: { ids: ['x'] }, as: ADMIN })).status, 400);
  assertEqual((await api('POST', '/api/invites/delete', { body: { ids: [] }, as: ADMIN })).status, 400);
  assertEqual((await api('POST', '/api/invites/bulk', { body: { ids: 'not-array', maxUses: 1 }, as: ADMIN })).status, 400);
  // 单条更新：不存在的 id 是 404，不是 400（它文法正确、只是目标没了）
  assertEqual((await api('PUT', '/api/invites/no-such-id', { body: { maxUses: 1 }, as: ADMIN })).status, 404);
});

test('R54c-03d · 导出端点：响应体就是纯文本本身（不是 JSON），且带 text/plain 头', async () => {
  const gen = await api('POST', '/api/invites', { body: { count: 3, note: '导出' }, as: ADMIN });
  const ids = gen.json.invites.map((x) => x.id);
  const r = await api('POST', '/api/invites/export', { body: { ids }, as: ADMIN });
  assertEqual(r.status, 200);
  assertMatch(r.headers['content-type'] || '', /text\/plain/, '必须是 text/plain —— 前端是按「拿文本再存文件」消费的');
  // ⚠️ 关键判据：raw **不是** JSON。若哪天有人给它套上 `res.json(...)`，前端会在
  // `res.json()` 抛错后被吞成 null，症状是「点了导出没反应、也没有报错」。
  assertEqual(r.json, null, '响应体不得是合法 JSON');
  assertEqual(r.raw, ids.map((k) => inviteStore.list().find((x) => x.id === k).code).join('\n') + '\n',
    '导出的文本必须恰好是「按列表顺序、一行一个、末尾换行」');
  assertEqual(r.raw.split('\n').length - 1, 3);

  const all = await api('POST', '/api/invites/export', { body: { ids: [] }, as: ADMIN });
  assert(all.raw.split('\n').length - 1 > 3, 'ids 为空数组 = 导出全部');
});

/* ================================================================== *
 * 第 4 层 · 注册接入层（真 HTTP）
 * ================================================================== */

/** 直接改站点设置（绕开路由：这里测的是注册行为，不是设置接口） */
function setRegistration(mode, defaultRole) {
  configStore.saveSite(Object.assign({ registration: mode }, defaultRole ? { defaultRole } : null));
}

let regSeq = 0;
function uniqName(prefix) {
  regSeq += 1;
  return `${prefix || 'user'}${regSeq}`;
}

test('R54c-04a · closed 模式：注册被拒（文案指向管理员），且**不看**邀不邀请码', async () => {
  setRegistration('closed');
  const r = await api('POST', '/api/auth/register', {
    body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD, inviteCode: 'ZZZZZZZZZZ' },
  });
  assertEqual(r.status, 403);
  assertMatch((r.json || {}).error, /未开放注册/, 'closed 的文案必须是「不开放注册」而不是邀请码相关的话术');
  /**
   * ⚠️ R54② 遗留的临时口径已在 R54③ **解除**：`invite` 不再走「功能尚未开放」的拒绝分支。
   * 这条断言把它钉死 —— 谁把 `invite` 又塞回 `REGISTER_DENY_TEXT`，这里不会变红
   * （那条分支已不可达），但下面 04b 会因为「邀请码模式注册不成功」而变红。
   */
  assert(!/邀请码功能尚未开放/.test(readJs('main.js')), '前端不得再出现「邀请码功能尚未开放」这种过期文案');
});

test('R54c-04b · invite 模式：没填码 400、格式错 400、码无效 403、码有效则注册成功', async () => {
  /**
   * R71：**空库的第一个账户**会被强制建成根用户（「根用户只属于部署后的第一个账户」）。
   * 本用例要验的是「身份取自邀请码上的 role」，故先把「第一个账户」这一特殊性消耗掉，
   * 否则下面那次注册会被建成根用户，断言就变成在测另一条规则了。
   */
  if (configStore.listUsers().length === 0) {
    await configStore.addUser({ username: 'seed-owner', password: PASSWORD, role: 'user' });
  }
  setRegistration('invite', 'user');
  const ip = nextIp();

  const noCode = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD },
  });
  assertEqual(noCode.status, 400, '邀请码模式下不填码应 400');
  assertMatch((noCode.json || {}).error, /请输入邀请码/);

  const badForm = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD, inviteCode: 'ABC' },
  });
  assertEqual(badForm.status, 400, '格式不对应 400（而不是拿它去查库）');
  assertMatch((badForm.json || {}).error, /格式/, '格式错的文案要说清是「格式」而不是「无效」');
  const nlForm = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD, inviteCode: 'ABCDEFGHJK\n' },
  });
  assertEqual(nlForm.status, 400, '含换行的码同样 400');
  assertMatch((nlForm.json || {}).error, /换行/);

  const notFound = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD, inviteCode: 'ZZZZZZZZZZ' },
  });
  assertEqual(notFound.status, 403, '格式对但库里没有 → 403');
  assertMatch((notFound.json || {}).error, /无效/);

  // 有效码：注册成功，且身份取自**码上的 role**（而不是站点默认身份）
  setRegistration('invite', 'user');
  const [v] = inviteStore.generate({ count: 1, role: 'admin', maxUses: 1, expiresAt: null, note: 'HTTP 注册', createdBy: 'root' });
  const name = uniqName('invited');
  const ok = await api('POST', '/api/auth/register', {
    ip, body: { username: name, password: PASSWORD, confirmPassword: PASSWORD, inviteCode: v.code },
  });
  assertEqual(ok.status, 200, `有效邀请码应注册成功（实际 ${ok.status}：${(ok.json || {}).error || ''}）`);
  assertEqual(ok.json.user.username, name);
  assertEqual(ok.json.user.role, 'admin', '身份必须取自邀请码上的 role（需求 4.1），而不是站点默认身份');
  assertEqual(configStore.findUserRaw(name).role, 'admin', '落盘的也必须是 admin');
  const used = inviteStore.list().find((x) => x.id === v.id);
  assertEqual(used.used, 1, '核销后计数 +1');
  assertEqual(used.status, 'used_up', 'maxUses=1 用满后必须立刻变 used_up');
});

test('R54c-04c · 建号失败必须把核销掉的那一次**还回去**（回滚判据）', async () => {
  setRegistration('invite', 'user');
  const ip = nextIp();
  const [v] = inviteStore.generate({ count: 1, role: 'user', maxUses: 5, expiresAt: null, note: '回滚', createdBy: 'root' });
  const name = uniqName('dup');

  const first = await api('POST', '/api/auth/register', {
    ip, body: { username: name, password: PASSWORD, confirmPassword: PASSWORD, inviteCode: v.code },
  });
  assertEqual(first.status, 200, '第一次注册应成功');
  assertEqual(inviteStore.list().find((x) => x.id === v.id).used, 1);

  // 同一个用户名再注册一次 → configStore.addUser 抛 409 ⇒ 必须回滚
  const dup = await api('POST', '/api/auth/register', {
    ip, body: { username: name, password: PASSWORD, confirmPassword: PASSWORD, inviteCode: v.code },
  });
  assertEqual(dup.status, 409, '用户名重复应 409');
  assertEqual(inviteStore.list().find((x) => x.id === v.id).used, 1,
    '建号失败的那一次**不得**计入使用次数（否则管理员看到「已用 1 次」却没有对应账户）');

  // 密码不合规同样要走回滚
  const weak = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: '123', confirmPassword: '123', inviteCode: v.code },
  });
  assertEqual(weak.status >= 400, true, `弱密码应被拒（实际 ${weak.status}）`);
  assertEqual(inviteStore.list().find((x) => x.id === v.id).used, 1, '弱密码被拒同样不得占用次数');

  // 两次密码不一致也在核销之前挡下 —— 此时根本不该核销
  const mismatch = await api('POST', '/api/auth/register', {
    ip, body: { username: uniqName(), password: PASSWORD, confirmPassword: PASSWORD + 'x', inviteCode: v.code },
  });
  assertEqual(mismatch.status, 400);
  assertEqual(inviteStore.list().find((x) => x.id === v.id).used, 1, '密码不一致在核销之前挡下 ⇒ 次数不变');
});

test('R54c-04d · open 模式：身份取站点默认，请求体里的 role 一律被忽略', async () => {
  setRegistration('open', 'user');
  const a = await api('POST', '/api/auth/register', {
    body: { username: uniqName('openA'), password: PASSWORD, confirmPassword: PASSWORD },
  });
  assertEqual(a.status, 200, '公开注册应成功');
  assertEqual(a.json.user.role, 'user');

  // 请求体里塞 role / permissions 必须被忽略（否则任何人注册时自封管理员）
  const b = await api('POST', '/api/auth/register', {
    body: {
      username: uniqName('openB'), password: PASSWORD, confirmPassword: PASSWORD,
      role: 'admin', permissions: { all: true },
    },
  });
  assertEqual(b.status, 200);
  assertEqual(b.json.user.role, 'user', '请求体里的 role 必须被忽略');

  // open 模式下身份来自站点设置
  setRegistration('open', 'admin');
  const c = await api('POST', '/api/auth/register', {
    body: { username: uniqName('openC'), password: PASSWORD, confirmPassword: PASSWORD },
  });
  assertEqual(c.json.user.role, 'admin', 'open 模式的身份取自站点设置的 defaultRole');
  setRegistration('closed', 'user');
});

test('R54c-04e · 注册的三步顺序：模式 → 邀请码**格式** → 核销（格式错在核销之前挡下）', () => {
  const code = readCode('server/routes/auth.js');
  const body = code.slice(code.indexOf("router.post('/auth/register'"), code.indexOf("router.post('/auth/forgot'"));
  assert(body.length > 200, '自证：必须真的取到了 register 的处理函数体');
  const iMode = body.indexOf("mode !== 'open' && mode !== 'invite'");
  const iFormat = body.indexOf('parseInviteCodeInput');
  const iConfirm = body.indexOf('两次输入的密码不一致');
  const iCaptcha = body.indexOf('captcha.verify');
  const iConsume = body.indexOf('inviteStore.consume');
  const iAdd = body.indexOf('configStore.addUser');
  const order = { iMode, iFormat, iConfirm, iCaptcha, iConsume, iAdd };
  for (const [k, v] of Object.entries(order)) assert(v > 0, `自证：${k} 应在函数体里出现一次`);
  assert(iMode < iFormat, '注册模式必须最先判（否则 closed 也会白走一遍 scrypt —— 匿名端的 CPU 消耗入口）');
  assert(iFormat < iConsume, '邀请码的**格式**校验必须早于核销（抄错一位应立刻 400 说清楚，而不是等到查完库）');
  /**
   * ⭐ 核销必须在人机验证**之后**：这个端点限流只有 10 次 / 10 分钟，
   * 若「这枚码存在但已用尽」能在人机验证之前被区分出来，它就成了一条
   * **邀请码存在性 oracle**（拿一批码来试，响应能区分「存在」与「不存在」）。
   */
  assert(iCaptcha < iConsume, '核销必须在人机验证之后（否则成为一条邀请码存在性 oracle）');
  assert(iConsume < iAdd, '核销必须紧挨在建号之前 —— 核销后到建号之间只剩一步，失败窗口最小');
  assert(body.includes('inviteStore.rollback('), '建号失败必须回滚核销');
  // 回滚必须与 addUser 同处一个 try/catch（而不是散落在别处）
  const iTry = body.indexOf('try {', iConsume);
  assert(iTry > 0 && body.slice(iTry, iAdd).length < 400, 'addUser 必须被 try 包住，catch 里做回滚');
});

/* ================================================================== *
 * 第 5 层 · 前端层
 * ================================================================== */

test('R54c-05a · index.html：侧栏入口与页面就位，且页面是 card-view 主视图', () => {
  const html = readHtml();
  assert(/id="side-invite"[^>]*>/.test(html), '侧栏应有「邀请码设置」入口（带 id 供按角色显隐）');
  // 位置：在「密钥设置」之前（需求「在左侧栏新增」；摆在密钥设置之上是就近的账户类入口）
  assert(html.indexOf('id="side-invite"') < html.indexOf('id="side-settings"'),
    '邀请码入口应排在「密钥设置」之前');
  assert(/<section\s+id="invitemgr"[^>]*class="[^"]*\bcard-view\b[^"]*"/.test(html),
    '邀请码页面必须带 card-view（否则整页无内边距 / 不滚动）');
  for (const id of ['invitemgr-table', 'btn-invites-generate', 'btn-invites-export', 'btn-invites-delete',
    'invite-bulk-bar', 'inv-bulk-uses', 'inv-bulk-exp-mode', 'inv-bulk-role', 'btn-invite-bulk', 'btn-invite-all']) {
    assert(html.includes(`id="${id}"`), `邀请码页面缺少 #${id}`);
  }
  // 站点设置卡片里那句「邀请码管理将随后续版本提供」必须已经改掉（本轮就是那个「后续版本」）
  assert(!html.includes('邀请码管理将随后续版本提供'), '站点设置卡片的说明必须同步更新，不得再挂着过期承诺');
});

test('R54c-05b · main.js：MAIN_VIEWS / VIEW_ENTRY / 五个接线点一个不少', () => {
  const main = readJs('main.js');
  assert(/import \* as invitemgr from '\.\/invitemgr\.js'/.test(main), '必须导入 invitemgr 模块');
  const mv = /MAIN_VIEWS\s*=\s*\[([^\]]+)\]/.exec(main);
  assert(mv && mv[1].includes("'invitemgr'"), 'MAIN_VIEWS 必须包含 invitemgr（否则换账号后该区块会残留）');
  const ve = main.slice(main.indexOf('const VIEW_ENTRY'), main.indexOf('function writeViewHash'));
  assert(ve.includes("invitemgr: 'side-invite'"),
    'VIEW_ENTRY 必须登记 invitemgr → side-invite —— 否则地址栏 #invitemgr 对普通用户**不被门控**');
  assert(!/role\s*===/.test(ve), '不得在 VIEW_ENTRY 里另写一份角色名单（越权缺口的经典来源）');
  // 侧栏点击 / 区块刷新 / 换账号重置 / 角色门控 四处
  assert(/\$\('side-invite'\)\.onclick/.test(main), '侧栏按钮必须接线');
  assert(/v === 'invitemgr'\)\s*invitemgr\.refresh\(\)/.test(main), 'switchMainView 必须刷新邀请码页');
  const reset = main.slice(main.indexOf('function resetMainView'), main.indexOf('App.resetMainView'));
  assert(reset.includes('invitemgr.reset()'),
    'resetMainView 必须丢弃邀请码列表 —— 它是含明文口令的管理员数据，不得跨会话残留');
  const menu = main.slice(main.indexOf('function renderUserMenu'), main.indexOf('function bindUserMenu'));
  assert(/getElementById\('side-invite'\)/.test(menu) && /sideInvite\.hidden\s*=\s*!isAdmin/.test(menu),
    'renderUserMenu（角色权威渲染点）必须把 side-invite 按角色赋 hidden');
  assert(/invitePage\s*=\s*document\.getElementById\('invitemgr'\)/.test(menu)
    && /invitePage\.hidden\s*=\s*true/.test(menu),
    '页面本身也要按角色关掉 —— 入口隐藏只是第一层');
});

test('R54c-05c · 角色门控真跑：普通用户改地址栏也进不了邀请码页', () => {
  const src = readJs('main.js');
  const declStart = src.indexOf('const MAIN_VIEWS');
  const declEnd = src.indexOf('function writeViewHash');
  const decls = src.slice(declStart, declEnd);
  const body = src.slice(src.indexOf('function viewFromHash'), src.indexOf('function switchMainView'));
  assert(decls.includes("'invitemgr'") && decls.includes("'side-invite'"), '自证：抽出的确是真东西');
  const factory = new Function('location', 'document',
    decls + '\n' + body + '\nreturn viewFromHash();');
  const run = (hash, hidden) => factory({ hash }, {
    getElementById: (id) => ({ hidden: (hidden || []).includes(id) }),
  });
  assertEqual(run('', []), 'explorer', '无 hash 落到文件浏览');
  assertEqual(run('#invitemgr', []), 'invitemgr', '管理员（入口可见）应能直达邀请码页');
  assertEqual(run('#invitemgr', ['side-invite']), 'explorer',
    '⭐ 普通用户（入口被 roleRenderUserMenu 判为隐藏）改地址栏不得进入邀请码页');
  assertEqual(run('#invitemgr', ['__missing__']), 'invitemgr',
    '对照组：只隐藏别的 id 时仍能进入 —— 证明上一条的红不是因为「随便隐藏点什么都会回落」');
});

test('R54c-05d · api.js：六个接口方法与 `requestText` 的形状', () => {
  const api = readCode('public/js/api.js');
  for (const m of ['invites:', 'generateInvites:', 'updateInvite:', 'bulkUpdateInvites:', 'deleteInvites:', 'exportInvites:']) {
    assert(api.includes(m), `api.js 应暴露 ${m.replace(':', '')}`);
  }
  assert(/invites:\s*\(\)\s*=>\s*request\('GET',\s*'\/api\/invites'\)/.test(api), 'GET /api/invites');
  assert(/bulkUpdateInvites:\s*\(ids,\s*b\)\s*=>\s*request\('POST',\s*'\/api\/invites\/bulk',\s*Object\.assign\(\{ ids \}/.test(api),
    '批量设置必须把 ids 与 patch 合并进请求体');
  /**
   * ⭐ 导出**必须**走 `requestText` 且**必须是 POST**：
   *  - 走 `request()` 会在 `res.json()` 抛错后被吞成 `null`（点导出没反应、也没报错）；
   *  - 用 GET 会把整批明文口令写进浏览器历史与反向代理的 access log。
   */
  assert(/exportInvites:\s*\(ids\)\s*=>\s*requestText\('POST',\s*'\/api\/invites\/export'/.test(api),
    '导出必须是 POST + requestText');
  assert(/async function requestText\(/.test(api), 'api.js 应有 requestText 实现');
  // ⚠️ 切片必须在 `requestText` **自己的函数体**内结束：往后多切一点就会切进
  // `notifyWrite` 的定义，于是「不得出现 notifyWrite」这条断言对着别处变红/变绿。
  const iRT = api.indexOf('async function requestText(');
  const iEnd = api.indexOf('let writeObserver');
  assert(iRT > 0 && iEnd > iRT, '自证：requestText 的函数体切片取到了真东西');
  const body = api.slice(iRT, iEnd);
  assert(body.includes('res.text()'), 'requestText 必须用 res.text() 取文本');
  assert(!body.includes('res.json()'), 'requestText 里不得出现 res.json() —— 那正是它存在的理由');
  assert(/JSON\.parse\(text\)/.test(body), '失败路径必须从 JSON 错误体里解析出 message（否则用户看到一串 JSON 原文）');
  assert(!body.includes('notifyWrite'), 'requestText 不得广播写操作（导出不改变服务端状态）');
});

test('R54c-05e · invitemgr.js：导出走 POST 拿文本、状态判定不做第二份、批量字段有「不修改」档', () => {
  const code = readCode('public/js/invitemgr.js');
  assert(/API\.exportInvites\(/.test(code), '导出必须调 API.exportInvites');
  assert(!/<a[^>]*href[^>]*download/.test(code), '不得用 <a href download>（发不出 CSRF 头，也无法 POST）');
  assert(/new Blob\(\[text\]/.test(code), '导出要自己造 Blob 再下载');
  /**
   * ⭐ **状态判定不得在前端再写一份**：服务端 `invite-store.view()` 已经算好 `status`
   * 随列表下发。前端再判一遍必然分叉（表现：列表说有效、注册却提示已过期）。
   * 判据落在「不得出现那几条判定比较」上，而不是「有没有 STATUS_META」——
   * 后者是映射表，本来就该有。
   */
  assert(!/expiresAt\s*&&\s*new Date/.test(code),
    '前端不得重算过期 —— 判定只有服务端 `invite-store.status()` 一份（重算必然分叉：列表说有效、注册却提示已过期）');
  assert(!/maxUses\s*>\s*0\s*&&/.test(code), '前端不得重算「是否用尽」');
  assert(/l\.status/.test(code), '状态必须取自服务端下发的 `status` 字段');
  /**
   * 批量设置的三个控件都必须有「不修改」档：
   * 「不修改」与「改成 0 / 改成永久」是两件不同的事，用「空即默认」会把后者读成前者。
   */
  const html = readHtml();
  assert(/<option value="">不修改<\/option>/.test(html), '批量「身份」必须有「不修改」档');
  assert(/<option value="keep">不修改<\/option>/.test(html), '批量「过期时间」必须有「不修改」档');
  assert(/<option value="never">永久有效<\/option>/.test(html), '批量「过期时间」必须有「永久有效」档');
  const bulk = code.slice(code.indexOf('function readBulkFields'), code.indexOf('async function applyBulk'));
  assert(/expiresAt = null/.test(bulk) && /mode === 'at'/.test(bulk),
    '批量读值必须显式区分「不修改」（字段不出现）与「改成永久」（expiresAt: null）');
});

test('R54c-05f · 登录页：邀请码输入框只在「注册 + 邀请码模式」出现，且注册入口在两种模式下都可用', () => {
  const html = readHtml();
  assert(/id="auth-invite"/.test(html) && /id="auth-invite-item"[^>]*hidden/.test(html),
    '登录页应有邀请码输入框，且缺省隐藏');
  const main = readJs('main.js');
  // 注册入口：open 与 invite 都出现，只有 closed 隐藏
  assert(/siteRegistration === 'open' \|\| siteRegistration === 'invite'/.test(main),
    '注册入口必须在「公开注册」与「邀请码」两种模式下都出现（两种模式都能注册成功）');
  assert(/inviteItem\.hidden = !needInvite/.test(main), '邀请码框只在邀请码模式的注册形态下打开');
  assert(/inviteCode: inviteCode \|\| undefined/.test(main), '注册请求必须带上邀请码');
  // 回车提交也要覆盖邀请码框（否则填完码按回车毫无反应）
  assert(/'auth-code', 'auth-invite'/.test(main), '回车提交的输入框清单必须包含 auth-invite');
});
