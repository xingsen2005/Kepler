/**
 * 第九十八轮护栏：昵称 + 自助注销（R98）—— HTTP 面的行为契约
 *
 * ## 这一轮真正容易出错的地方
 *
 *  · **昵称是"给了就写"的字段**：它不走当前密码那道闸门（与用户名 / 密码 / 邮箱
 *    刻意不同）。一旦有人"顺手"把它并进 `needsCurrent` 那一档，用户每次改显示名
 *    都要输密码；反过来，若把它当成登录凭据，两个同名昵称就会互相冲突。
 *  · **注销的证据链是"能收到绑定邮箱的信"**，不是"能收到某个地址的信"：验证码必须
 *    发往**已绑定**地址，且用途与改邮箱的 `verify` **分开**（否则将来放宽其中一条
 *    会连带放宽另一条）。
 *  · **15 天 + 登录即撤销**是一条安全属性：注销是破坏性操作，冷静期内的登录必须
 *    能把它撤销；但**已到期**的申请不能靠登录续命（否则"自动删除"只是口号）。
 *  · **根用户不可注销**：本项目里根用户的口令同时是主密钥信封的解锁因子，
 *    删掉它没有任何界面路径能恢复。
 *
 * ## 判据落点
 *
 * 全部落在**真实 HTTP 响应 + 存储状态**上：状态码、响应体字段、`GET /users/me`
 * 里 `deletion` 的实际取值。夹具只补"已通过鉴权的调用者"（`X-Test-User` 头）——
 * 鉴权链本身由 `auth-session` / `routes-surface` 负责。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const test = require('node:test');

const { assert, assertEqual, ROOT } = require('./helpers');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-r98-http-'));
process.env.S3_DATA_DIR = tmpDir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

const configStore = require(SERVER('config-store.js'));
const emailCode = require(SERVER('email-code.js'));
const shareStore = require(SERVER('share-store.js'));
const accountDeletion = require(SERVER('account-deletion.js'));
const usersRoutes = require(SERVER('routes', 'users.js'));
const authRoutes = require(SERVER('routes', 'auth.js'));

const DAY = 24 * 60 * 60 * 1000;
const PASS = 'Passw0rd!98';
let root = null;
let alice = null;
let bob = null;

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */
test.before(async () => {
  // 第一个账户会被提升为根用户（`ensureRootUser`），故先建它
  root = await configStore.addUser({ username: 'root98', password: PASS, email: 'root98@x.test' });
  alice = await configStore.addUser({ username: 'alice98', password: PASS, email: 'alice98@x.test' });
  bob = await configStore.addUser({ username: 'bob98', password: PASS }); // 刻意不绑邮箱
  configStore.flushPending();
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
});

/* ---------------------------------------------------------------- *
 * 极简 HTTP 夹具（只补"已通过鉴权"这一步）
 * ---------------------------------------------------------------- */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const name = String(req.headers['x-test-user'] || '');
    if (name) {
      const u = configStore.findUserRaw(name);
      if (u) req.authUser = { id: u.id, username: u.username, role: u.role };
    }
    next();
  });
  app.use('/api', usersRoutes);
  app.use('/api', authRoutes);
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function request(port, method, urlPath, opts) {
  const o = opts || {};
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers = Object.assign({
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
  }, o.headers || {});
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 以某个用户的身份发请求 */
const as = (name) => ({ 'X-Test-User': name });

/** 直接读存储里的原始记录（断言"到底写没写"） */
const rawOf = (name) => configStore.findUserRaw(name);

/** 把一条到期（或未到期）的注销申请直接写进存储 —— 模拟"时间过去了" */
function putDeletion(name, msFromNow) {
  const cfg = configStore.load();
  const u = cfg.users.find((x) => x.username === name);
  const now = Date.now();
  u.deletion = {
    requestedAt: new Date(now - (15 * DAY) + msFromNow).toISOString(),
    deleteAt: new Date(now + msFromNow).toISOString(),
  };
  configStore.save(cfg);
}

/* ================================================================== *
 * 一、昵称
 * ================================================================== */

test('R98-01 · GET /users/me 必须下发 nickname / createdAt / deletion 三个字段', async () => {
  await withServer(async (port) => {
    const r = await request(port, 'GET', '/api/users/me', { headers: as('alice98') });
    assertEqual(r.status, 200, '应能读到自己的资料');
    assertEqual(r.json.user.nickname, '', '未设置昵称时必须是空串（由前端回退显示用户名）');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(r.json.user.createdAt), '必须下发注册时间（ISO 字符串）');
    assertEqual(r.json.user.deletion, null, '没有注销申请时 deletion 必须是 null');
  });
});

test('R98-02 · 改昵称不需要当前密码；超长 400；清空回退为空串', async () => {
  await withServer(async (port) => {
    const a = await request(port, 'PUT', '/api/users/me', {
      headers: as('alice98'), body: { nickname: '  小艾  ' },
    });
    assertEqual(a.status, 200, `改昵称不得要求当前密码（实际 ${a.status}: ${a.raw}）`);
    assertEqual(a.json.user.nickname, '小艾', '首尾空白必须被归一（否则"看起来没改"也是写操作）');

    const b = await request(port, 'PUT', '/api/users/me', {
      headers: as('alice98'), body: { nickname: '字'.repeat(configStore.NICKNAME_MAX + 1) },
    });
    assertEqual(b.status, 400, '超长昵称必须明确拒绝 —— 静默截断是一次假成功');

    const c = await request(port, 'PUT', '/api/users/me', {
      headers: as('alice98'), body: { nickname: '' },
    });
    assertEqual(c.status, 200, '清空昵称必须成功（空串是合法值，不能按"没改"忽略）');
    assertEqual(c.json.user.nickname, '', '清空后必须是空串');
  });
});

/* ================================================================== *
 * 二、注销：谁能申请
 * ================================================================== */

test('R98-03 · 根用户不可注销（403，且不写任何申请）', async () => {
  await withServer(async (port) => {
    const code = emailCode.issue({ purpose: 'delete', email: 'root98@x.test' });
    const r = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('root98'), body: { code: code.code },
    });
    assertEqual(r.status, 403, '根用户提交注销必须 403');
    assertEqual(rawOf('root98').deletion, null, '拒绝之后不得留下任何申请');
  });
});

test('R98-04 · 没有绑定邮箱时，发码与提交都要 400（并说清"先去绑邮箱"）', async () => {
  await withServer(async (port) => {
    const a = await request(port, 'POST', '/api/users/me/deletion/code', { headers: as('bob98') });
    assertEqual(a.status, 400, '无邮箱时发码必须 400');
    assert(/绑定/.test(a.json.error), '错误信息要指向"先绑定邮箱"，而不是一句"发送失败"');

    const b = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('bob98'), body: { code: '123456' },
    });
    assertEqual(b.status, 400, '无邮箱时提交必须 400');
    assertEqual(rawOf('bob98').deletion, null, '无邮箱时不得写入申请');
  });
});

/* ================================================================== *
 * 三、证据链：验证码必须"发往绑定邮箱 + 用途独立"
 * ================================================================== */

test('R98-05 · 验证码错误：400 且不写申请', async () => {
  await withServer(async (port) => {
    emailCode.clear(); // 重发冷却按「用途|邮箱」记，跨用例必须清掉，否则后面签发不出新码
    const issued = emailCode.issue({ purpose: 'delete', email: 'alice98@x.test' });
    assert(issued.ok, '前置：应能签发注销验证码');
    const r = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('alice98'), body: { code: '000000' },
    });
    assertEqual(r.status, 400, '错误验证码必须 400');
    assertEqual(rawOf('alice98').deletion, null, '验证码没过就绝不能写申请');
  });
});

test('R98-06 · 用途隔离：改邮箱的 verify 码不能拿来注销', async () => {
  await withServer(async (port) => {
    emailCode.clear();
    const v = emailCode.issue({ purpose: 'verify', email: 'alice98@x.test' });
    assert(v.ok, '前置：应能签发一枚 verify 码');
    const r = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('alice98'), body: { code: v.code },
    });
    assertEqual(r.status, 400, 'verify 码用于注销必须被拒（两种用途的信任前提不同）');
    assertEqual(rawOf('alice98').deletion, null, '用途不对时同样不得写申请');
  });
});

/* ================================================================== *
 * 四、冷静期：15 天、幂等、撤销
 * ================================================================== */

test('R98-07 · 提交成功：计划删除时间 = 15 天后', async () => {
  await withServer(async (port) => {
    emailCode.clear();
    const code = emailCode.issue({ purpose: 'delete', email: 'alice98@x.test' });
    assert(code.ok, '前置：应能签发注销验证码');
    const before = Date.now();
    const r = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('alice98'), body: { code: code.code },
    });
    assertEqual(r.status, 200, `提交注销应成功（实际 ${r.status}: ${r.raw}）`);
    const due = Date.parse(r.json.user.deletion.deleteAt);
    const want = before + 15 * DAY;
    assert(Math.abs(due - want) < 60 * 1000,
      `冷静期必须正好 15 天（期望约 ${new Date(want).toISOString()}，实际 ${r.json.user.deletion.deleteAt}）`);
    assertEqual(rawOf('alice98').deletion.deleteAt, r.json.user.deletion.deleteAt, '存储与响应必须一致');
  });
});

test('R98-08 · 重复提交 / 重复发码都 409（防止把冷静期悄悄续期）', async () => {
  await withServer(async (port) => {
    // 前置：确保确有一条待撤销的申请（不依赖上一个用例的副作用）
    if (!rawOf('alice98').deletion) {
      emailCode.clear();
      const c = emailCode.issue({ purpose: 'delete', email: 'alice98@x.test' });
      await request(port, 'POST', '/api/users/me/deletion', {
        headers: as('alice98'), body: { code: c.code },
      });
    }
    const a = await request(port, 'POST', '/api/users/me/deletion', {
      headers: as('alice98'), body: { code: '123456' },
    });
    assertEqual(a.status, 409, '已有申请时重复提交必须 409');
    const b = await request(port, 'POST', '/api/users/me/deletion/code', { headers: as('alice98') });
    assertEqual(b.status, 409, '已有申请时不该再发信（省一封必然用不上的邮件）');
  });
});

test('R98-09 · 撤销：清空申请；没有申请时 404', async () => {
  await withServer(async (port) => {
    const r = await request(port, 'DELETE', '/api/users/me/deletion', { headers: as('alice98') });
    assertEqual(r.status, 200, '撤销应成功');
    assertEqual(rawOf('alice98').deletion, null, '撤销后存储里必须是 null');
    const again = await request(port, 'DELETE', '/api/users/me/deletion', { headers: as('alice98') });
    assertEqual(again.status, 404, '没有待撤销申请时必须 404（不做"永远成功"的空操作）');
  });
});

/* ================================================================== *
 * 五、登录：冷静期内撤销、到期执行
 * ================================================================== */

test('R98-10 · 冷静期内登录 ⇒ 立即撤销，并在响应里明确告知', async () => {
  await withServer(async (port) => {
    putDeletion('alice98', 10 * DAY);
    const r = await request(port, 'POST', '/api/auth/login', {
      body: { username: 'alice98', password: PASS },
    });
    assertEqual(r.status, 200, `应能登录（实际 ${r.status}: ${r.raw}）`);
    assertEqual(r.json.deletionCancelled, true, '必须如实告诉用户"注销申请已被撤销"');
    assertEqual(r.json.user.deletion, null, '响应里的 user 必须已经是撤销后的状态');
    assertEqual(rawOf('alice98').deletion, null, '存储里也必须清掉');
  });
});

test('R98-11 · 已到期：登录不再撤销，而是当场执行删除（403 + deleted）', async () => {
  await withServer(async (port) => {
    putDeletion('alice98', -1 * DAY); // 昨天就该删了
    const r = await request(port, 'POST', '/api/auth/login', {
      body: { username: 'alice98', password: PASS },
    });
    assertEqual(r.status, 403, '到期账户不得再签发会话');
    assertEqual(r.json.deleted, true, '要明确告知账户已注销（而不是"密码错误"）');
    assertEqual(rawOf('alice98'), null, '账户必须真的被删除');
    assertEqual(r.headers['set-cookie'], undefined, '不得给已删除账户下发会话 Cookie');
  });
});

/* ================================================================== *
 * 六、后台清扫
 * ================================================================== */

test('R98-12 · 到期清扫：删账户 + 解除分享链接归属（防同名账户继承）', async () => {
  const carol = await configStore.addUser({ username: 'carol98', password: PASS, email: 'carol98@x.test' });
  await shareStore.create({
    key: 'docs/a.txt', bucket: 'tb', region: 'ap-guangzhou', fileName: 'a.txt', size: 10,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'carol98',
  });
  putDeletion('carol98', -1 * DAY);

  const n = accountDeletion.purgeDue();
  assert(n >= 1, `到期账户应被清扫（实际删除 ${n} 个）`);
  assertEqual(configStore.getUserById(carol.id), null, '账户必须被删除');
  const links = shareStore.list ? shareStore.list() : [];
  const left = links.filter((l) => l.createdBy === 'carol98');
  assertEqual(left.length, 0, '该用户创建的分享链接必须解除归属（否则同名新账户会继承它们）');
});
