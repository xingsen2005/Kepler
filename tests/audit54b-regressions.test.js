/**
 * 第 54 轮护栏（第二部分）—— 注册 / 忘记密码 / 邮箱验证码
 *
 * 需求原文（全文见 CHANGELOG 的 [1.7.8]）：
 *  > 2.1、为登录页新增“注册”、“记住密码”和“忘记密码”；
 *  > 2.2、“忘记密码”允许用户通过邮件重置密码；
 *  > 2.3、不开放注册情况下被添加的用户可能没有邮箱，允许他们添加邮箱（通过验证码）；
 *  > 2.4、允许用户修改邮箱（通过验证码）；
 *  > 2.5、管理员可以修改任何人的邮箱；
 *  > 2.6、管理员添加新用户时，可以直接设置他的邮箱；
 *
 * ## 断言分七层，缺一层就留一种假绿
 *
 *  ① **判据层**（真实 `server/limits.js`）：邮箱入参判据与归一化；
 *  ② **数据层**（真实 `server/config-store.js`）：`email` 字段、唯一性、解绑、「用户名或邮箱」查用户；
 *  ③ **验证码层**（真实 `server/email-code.js`）：签发 / 核销 / 重发冷却 / 用满作废 / 过期 / 用途隔离 / 内存有界；
 *  ④ **注册路由层**（真 HTTP）：三种注册模式、身份按站点设置、请求体里的 role 被忽略；
 *  ⑤ **找回路由层**（真 HTTP + 真发信）：`/auth/forgot` 响应**逐字节相同**（不泄露账户是否存在）、
 *     `/auth/reset` 的失败分支同形、端到端「真发信取码 → 改密 → 旧会话失效」；
 *  ⑥ **自助 / 管理邮箱层**（真 HTTP）：验证码必填、当前密码必填（R21-09 同款）、
 *     管理员的「直设 / 直改 / 解绑」、以及**改邮箱不撤销会话**这条反向判据；
 *  ⑦ **前端层**：登录页三种形态、`rememberMode` 的取值、四个新 API、编辑资料的邮箱区。
 *
 * ⚠️ 配置与用户会**真实落盘**（`config.enc`），因此必须在 require 之前把 `S3_DATA_DIR`
 *    指到临时目录 —— 否则跑一次测试就在项目真实 `data/` 里留下一堆测试用户。
 *
 * ⚠️ 限流键取自 `security.clientIp()`，而它**默认只认 socket 对端地址** ⇒ 本文件里
 *    所有请求的限流键会全是 `127.0.0.1`，注册（10/10min）、发码（10/10min）、
 *    重置（20/10min）三个限流器会被跨用例地互相消耗，出现"单独跑绿、一起跑红"。
 *    故本文件显式打开 `TRUST_PROXY=1` 并**逐请求给一个不同的 `X-Forwarded-For`**
 *    —— 这既隔离了限流预算，又顺带跑在「Nginx 反代」这一真实部署形态上。
 *    需要断言"同一来源累计"的用例（重置锁定）显式指定固定 IP。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('node:net');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');
const { pathToFileURL } = require('node:url');

const tmp = makeTempDir('r54b-');
process.env.S3_DATA_DIR = tmp.dir;
process.env.TRUST_PROXY = '1'; // 见文件头：为了按请求隔离限流预算

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const readJs = (n) => fs.readFileSync(JS(n), 'utf8');
const readHtml = () => fs.readFileSync(PUBLIC('index.html'), 'utf8');

const express = require(path.join(ROOT, 'node_modules', 'express'));
const limits = require(SERVER('limits.js'));
const configStore = require(SERVER('config-store.js'));
const secureStore = require(SERVER('secure-store.js'));
const authSession = require(SERVER('auth-session.js'));
const emailCode = require(SERVER('email-code.js'));
const security = require(SERVER('security.js'));

const authRoutes = require(SERVER('routes', 'auth.js'));
const userRoutes = require(SERVER('routes', 'users.js'));

/* ================================================================== *
 * 公共工具
 * ================================================================== */

const PASSWORD = 'Unit!2026abc';

/** 建一个用户，返回它的**安全视图**（含 id / username / email / role） */
async function mkUser(name, role = 'user', email = '') {
  return configStore.addUser({ username: name, password: PASSWORD, role, email });
}

let ipSeq = 0;
/** 每次请求换一个来源 IP：隔离三个限流器的预算（见文件头） */
function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}

let server = null;
let port = 0;
/** 当前请求要冒充的登录用户（null = 未登录）；`api()` 的 `as` 参数覆盖它 */
const authUser = null;

/**
 * ⚠️ 冒充身份必须**随请求头走**，不能用闭包变量。
 *
 * 中间件只在起服务器那一次注册，它捕获的是**首次调用** `api()` 时的形参作用域 ——
 * 后续调用传的 `as` 根本进不去（症状是"除了第一条以外全部 401 / 403"）。
 * 头里带 JSON 是无状态的，也就不需要与测试执行顺序对齐。
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
    app.use('/api', userRoutes);
    app.use('/api', authRoutes);
    server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }
  const who = as === undefined ? authUser : as;
  const headers = { 'X-Forwarded-For': ip || nextIp() };
  if (who) headers['x-test-auth'] = JSON.stringify(who);
  return request(port, method, urlPath, { headers, body: body === undefined ? null : body });
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir, {
    label: 'r54b-',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});

/**
 * 极简假 SMTP 服务器（明文、不需认证）—— 记录每次会话收到的命令与 DATA 正文。
 *
 * ⚠️ 必须**真连真发**：`sendCodeMail()` 拼主题、拼正文、走 RFC 2047 编码，
 * 用源码正则是证明不了「收件端真的收到了那个验证码」的。
 */
function startMock() {
  const rec = { lines: [], data: [] };
  let inData = false;
  const server2 = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          rec.data.push(line);
          if (line === '.') { inData = false; sock.write('250 2.0.0 Queued\r\n'); }
          continue;
        }
        rec.lines.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-mock\r\n250 SIZE 10240000\r\n');
        else if (up.startsWith('HELO')) sock.write('250 mock\r\n');
        else if (up.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
        else if (up.startsWith('RCPT TO')) sock.write('250 OK\r\n');
        else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (up === 'QUIT') {
          sock.write('221 Bye\r\n');
          setTimeout(() => { try { sock.destroy(); } catch (_) { /* 已销毁 */ } }, 5);
        } else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server2.listen(0, '127.0.0.1', () => resolve({
      port: server2.address().port,
      rec,
      reset: () => { rec.lines.length = 0; rec.data.length = 0; },
      close: () => {
        if (typeof server2.closeAllConnections === 'function') server2.closeAllConnections();
        server2.close();
      },
    }));
  });
}

/** 从假服务器的 DATA 记录里还原出邮件正文（`buildMessage` 用 base64，见 smtp.js） */
function mailText(rec) {
  const lines = rec.data.slice();
  if (lines[lines.length - 1] === '.') lines.pop();
  const sep = lines.indexOf('');
  const b64 = (sep >= 0 ? lines.slice(sep + 1) : lines).join('');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** 从信头里取出第一个 RFC 2047 编码字并解码 */
function decodeFirstEncodedWord(s) {
  const m = /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(s);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
}

/** 把发信设置指向假服务器 */
function useMockSmtp(mock) {
  configStore.saveSmtp({
    enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
    user: '', password: '', from: 'noreply@example.com', fromName: '',
  });
}

/** 从假服务器收到的最后一封信里取 6 位验证码 */
function codeFromMock(rec) {
  const m = /验证码：(\d{6})/.exec(mailText(rec));
  assert(m, '假服务器收到的邮件正文里必须有 6 位验证码');
  return m[1];
}

/* ================================================================== *
 * ① 判据层 · parseEmailInput / normalizeEmail
 * ================================================================== */

test('R54b-1 · 邮箱入参：合法地址归一化为小写，逗号 / 空格 / 无点域名一律拒绝', () => {
  for (const good of ['a@b.com', 'A.B+c@sub.example.co', 'x_y-z@a-b.com.cn', 'n@t.io']) {
    assertEqual(limits.parseEmailInput(good).ok, true, `${good} 应合法`);
  }
  // 归一化：去空白 + 全小写（`findUserByIdentifier` 与唯一性判据都按归一值比对）
  assertEqual(limits.parseEmailInput('  A@B.CoM  ').value, 'a@b.com');
  assertEqual(limits.normalizeEmail('  A@B.CoM  '), 'a@b.com');

  const bad = [
    ['', '空串非法 —— 与 SMTP 那个"留空 = 不设置"的判据刻意不同'],
    ['   ', '纯空白同理'],
    ['a', '没有 @'],
    ['a@@b.com', '两个 @'],
    ['a@b', '域名无点'],
    ['a@localhost', '内网地址发不出去，放行只会让用户拿到看不懂的 SMTP 报错'],
    ['a@b..com', '域名里有连续点'],
    ['a@.com', '域名以点开头'],
    ['a@b.com.', '域名以点结尾'],
    ['a@b.c', '顶级标签不足两位'],
    ['a@b.com,c@d.com', '逗号是 RFC 5322 的地址分隔符 —— 会变成"一封信发两个地址"'],
    ['a b@c.com', '本地部分不得含空格'],
    ['"a b"@c.com', '引号包裹的本地部分不做支持（账户邮箱没有这个用法）'],
    ['.a@b.com', '本地部分不得以点开头'],
    ['a..b@x.com', '本地部分不得有连续点'],
    [`${'x'.repeat(65)}@b.com`, '本地部分超过 64'],
    [`a@${'x'.repeat(250)}.com`, '整体超过 254'],
  ];
  for (const [v, why] of bad) {
    const r = limits.parseEmailInput(v);
    assertEqual(r.ok, false, `应拒绝：${JSON.stringify(v)}（${why}）`);
    assert(typeof r.error === 'string' && r.error.length > 0, '非法入参必须带提示文案');
  }

  /**
   * ⚠️ 换行必须在 **trim 之前**判：`a@b.com\r\nBcc: x@y.com` 的换行在中间，
   * 末尾多一个 `\r\n` 的那种输入也会被 trim 裁掉而放行 —— 而邮箱会被直接拼进 `To:`。
   */
  assertEqual(limits.parseEmailInput('a@b.com\r\nBcc: x@y.com').ok, false, '信头注入必须被拒');
  assertEqual(limits.parseEmailInput('a@b.com\r\n').ok, false, '末尾换行也必须被拒（判据在 trim 之前）');
  // 脏数据（含换行）在读盘路径上视为「没有邮箱」，而不是当成一个地址留着
  assertEqual(limits.normalizeEmail('a@b.com\n'), '');
  assertEqual(limits.normalizeEmail(null), '');
  assertEqual(limits.normalizeEmail(undefined), '');
});

/* ================================================================== *
 * ② 数据层 · email 字段 / 唯一性 / 解绑 / 按标识查用户
 * ================================================================== */

test('R54b-2 · addUser 可带邮箱；邮箱唯一（空串不参与）；用户名冲突仍是 409', async () => {
  const a = await mkUser('b-user1', 'user', 'User1@Example.com');
  assertEqual(a.email, 'user1@example.com', '邮箱必须归一化（去空白 + 转小写）后落库');

  // 同一个邮箱（哪怕大小写不同）不能绑给第二个账户 —— 否则"重置密码该重置谁"没有答案
  let err = null;
  try { await mkUser('b-user2', 'user', 'USER1@example.com'); } catch (e) { err = e; }
  assert(err, '重复邮箱必须被拒');
  assertEqual(err.status, 409);

  // 空串不参与唯一性：可以有任意多个人没有邮箱（需求 2.3 的场景）
  const c = await mkUser('b-user3');
  assertEqual(c.email, '', '未给邮箱 ⇒ 空串而不是 undefined');
  const d = await mkUser('b-user4', 'user', '   ');
  assertEqual(d.email, '', '纯空白同样归一为空串');

  // 用户名冲突沿用既有判据
  err = null;
  try { await mkUser('b-user1'); } catch (e) { err = e; }
  assertEqual(err && err.status, 409);
});

test('R54b-2 · updateUser 的邮箱判据是 !== undefined —— 空串（解绑）必须真生效', async () => {
  const u = await mkUser('b-bind', 'user', 'bind@example.com');
  /**
   * 这是本轮最容易写错的一处：写成 `if (patch.email)` 的话，"解绑"会**静默失效**，
   * 而界面上会显示保存成功。
   */
  const off = await configStore.updateUser(u.id, { email: '' });
  assertEqual(off.email, '', '空串必须真的解绑');
  const on = await configStore.updateUser(u.id, { email: 'again@example.com' });
  assertEqual(on.email, 'again@example.com');
  // 未传 email ⇒ 保持原值（PATCH 语义）
  assertEqual((await configStore.updateUser(u.id, { role: 'user' })).email, 'again@example.com');
  assertEqual(configStore.getUserById(u.id).email, 'again@example.com', '必须真落库');
});

test('R54b-2 · findUserByIdentifier：用户名与邮箱都能查到同一个账户', async () => {
  const u = await mkUser('b-find', 'user', 'find@example.com');
  assertEqual(configStore.findUserByIdentifier('b-find').id, u.id, '用户名可查');
  assertEqual(configStore.findUserByIdentifier('B-FIND').id, u.id, '用户名大小写不敏感');
  assertEqual(configStore.findUserByIdentifier('find@example.com').id, u.id, '邮箱可查');
  assertEqual(configStore.findUserByIdentifier('FIND@EXAMPLE.COM').id, u.id, '邮箱大小写不敏感');
  assertEqual(configStore.findUserByIdentifier('  find@example.com  ').id, u.id, '首尾空白被裁');
  assertEqual(configStore.findUserByIdentifier(''), null, '空标识不得命中任何人');
  assertEqual(configStore.findUserByIdentifier('nobody@nowhere.com'), null);
});

test('R54b-2 · userView 下发 email，但**不**引入 emailVerified 之类的第二字段', async () => {
  const u = await mkUser('b-view', 'user', 'view@example.com');
  const v = configStore.getUserById(u.id); // 原始记录
  assertEqual(v.email, 'view@example.com', '原始记录里有 email');
  const view = configStore.userView(v);
  assertEqual(view.email, 'view@example.com', '安全视图必须下发 email（编辑资料要显示它）');
  /**
   * 「非空即视为已验证」是刻意的收敛：两个来源（用户走验证码自助绑定 / 管理员直接设置）
   * 都成立，加一个恒为真的布尔字段只是噪音，还会让人怀疑它可能有假值。
   */
  assertEqual(view.emailVerified, undefined, '不得引入恒为真的 emailVerified');
});

/* ================================================================== *
 * ③ 验证码层 · issue / check / consume / 冷却 / 作废 / 过期 / 用途隔离
 * ================================================================== */

test('R54b-3 · 正确的码通过、错误的码计数；用满 5 次即作废（不是"锁定"）', () => {
  emailCode.clear();
  const email = 'code1@example.com';
  const r = emailCode.issue({ purpose: 'verify', email });
  assertEqual(r.ok, true, '首次签发必须成功');
  assert(/^\d{6}$/.test(r.code), '验证码必须是 6 位十进制（且由 crypto.randomInt 产生）');

  assertEqual(emailCode.check({ purpose: 'verify', email, code: '000000' === r.code ? '111111' : '000000' }).ok, false, '错误的码不得通过');
  assertEqual(emailCode.check({ purpose: 'verify', email, code: r.code }).ok, true, '正确的码必须通过');
  // 核销之前可以重复校验同一份记录（`check` 不改持久状态）
  assertEqual(emailCode.check({ purpose: 'verify', email, code: r.code }).ok, true, '核销前仍可再核验一次');

  emailCode.consume({ purpose: 'verify', email });
  assertEqual(emailCode.check({ purpose: 'verify', email, code: r.code }).ok, false, '核销后必须失效（一次性）');
  assertEqual(emailCode.check({ purpose: 'verify', email, code: r.code }).reason, 'not_found');

  // 用满即**作废**：故意错 5 次后，正确的码也不再有效 —— 这是"作废"而不是"锁死入口"
  emailCode.clear();
  const e2 = 'code2@example.com';
  const r2 = emailCode.issue({ purpose: 'verify', email: e2 });
  let last = null;
  for (let i = 0; i < limits.EMAIL_CODE_MAX_ATTEMPTS; i++) {
    last = emailCode.check({ purpose: 'verify', email: e2, code: '999999' === r2.code ? '111111' : '999999' });
    assertEqual(last.ok, false);
  }
  assertEqual(last.reason, 'too_many', '第 5 次错误就必须判定"已用尽"');
  assertEqual(emailCode.check({ purpose: 'verify', email: e2, code: r2.code }).reason, 'too_many',
    '用尽后**正确的码**也不再通过（这一轮已作废）');
  /**
   * 作废 ≠ 锁定：冷却一过就能重新要一封。
   * ⚠️ 刻意**不删记录**（见 `email-code.js` 的注释）—— 删掉就等于把 `sentAt` 一起抹掉，
   * 重发冷却随之失效，攻击者每试错 5 次就能立刻要一封新码。
   */
  const realNow2 = Date.now;
  try {
    Date.now = () => realNow2() + limits.EMAIL_CODE_RESEND_MS + 1000;
    assertEqual(emailCode.issue({ purpose: 'verify', email: e2 }).ok, true, '作废不是锁定：冷却一过应能重新签发');
  } finally {
    Date.now = realNow2;
  }
});

test('R54b-3 · 重发冷却：60 秒内再要一次会被拒，并给出剩余秒数', () => {
  emailCode.clear();
  const email = 'cool@example.com';
  assertEqual(emailCode.issue({ purpose: 'reset', email }).ok, true);
  const again = emailCode.issue({ purpose: 'reset', email });
  assertEqual(again.ok, false, '冷却期内不得重复签发（否则本站成了群发工具）');
  assert(again.retryAfter > 0 && again.retryAfter <= 60, `retryAfter 应在 1..60 秒，实际 ${again.retryAfter}`);
  // 发送失败时回滚必须连冷却一起撤掉 —— 否则用户没收到信却要干等 60 秒
  emailCode.rollback({ purpose: 'reset', email });
  assertEqual(emailCode.issue({ purpose: 'reset', email }).ok, true, 'rollback 后必须能立刻重发');
});

test('R54b-3 · 过期即失效（并连带把条目清掉，内存不会只增不减）', () => {
  emailCode.clear();
  const email = 'ttl@example.com';
  const r = emailCode.issue({ purpose: 'reset', email });
  assertEqual(emailCode.size(), 1);
  const realNow = Date.now;
  try {
    // 把时钟拨到 10 分钟以后（`email-code.js` 每次调用都现取 Date.now，故补丁生效）
    Date.now = () => realNow() + limits.EMAIL_CODE_TTL_MS + 1000;
    const late = emailCode.check({ purpose: 'reset', email, code: r.code });
    assertEqual(late.ok, false, '过期后正确的码也必须失效');
    assertEqual(late.reason, 'not_found');
    assertEqual(emailCode.size(), 0, '惰性清扫必须把过期条目删掉');
  } finally {
    Date.now = realNow;
  }
});

test('R54b-3 · 两个用途的码互不通用（verify 的码不能拿去 reset）', () => {
  emailCode.clear();
  const email = 'purpose@example.com';
  const r = emailCode.issue({ purpose: 'verify', email });
  assertEqual(emailCode.check({ purpose: 'reset', email, code: r.code }).ok, false,
    '「证明我拥有这个新邮箱」与「没登录的人要回账户」的信任前提不同，码必须分用途存');
  assertEqual(emailCode.check({ purpose: 'verify', email, code: r.code }).ok, true, '本用途仍应通过');
});

test('R54b-3 · 内存有界：签发到上限后按最早过期淘汰，size 不再增长', () => {
  emailCode.clear();
  // 键的空间来自匿名可达的接口 —— 不设上限的话，10 万个不同邮箱就能把进程内存撑爆
  for (let i = 0; i < 1200; i++) emailCode.issue({ purpose: 'verify', email: `flood${i}@example.com` });
  assert(emailCode.size() <= 1000, `内存必须有硬上限，实际 size=${emailCode.size()}`);
  emailCode.clear();
});

test('R54b-3 · 验证码只存哈希：进程内存里不留可读的明文副本', () => {
  const src = fs.readFileSync(SERVER('email-code.js'), 'utf8');
  assertMatch(src, /hash: hashOf\(code\)/, '落进 Map 的必须是 sha256 摘要，而不是明文验证码');
  assertMatch(src, /function hashOf[\s\S]{0,240}?sha256/, 'hashOf 必须是 sha256（而不是 base64 / 直接存原串）');
  // 条目里不得有别的明文字段（`check` 只按 hash 比对）
  assert(!/plain\s*:/.test(src), '不得在条目里保存明文验证码');
  // 校验必须走常数时间比较（与 config-store 处理凭据的既有纪律一致）
  assertMatch(src, /timingSafeEqual/, '摘要比对应使用常数时间比较');
});

/* ================================================================== *
 * ④ 注册路由层 · 三种模式 / 身份 / 忽略请求体里的提权字段
 * ================================================================== */

test('R54b-4 · 注册：关闭模式明确拒绝（403 + 说明）；邀请码模式在 R54③ 起改为「校验邀请码」', async () => {
  configStore.saveSite({ registration: 'closed' });
  let r = await api('POST', '/api/auth/register', { body: { username: 'nope1', password: PASSWORD } });
  assertEqual(r.status, 403);
  assertMatch(r.json.error, /未开放注册/);
  assertEqual(configStore.listUsers().some((u) => u.username === 'nope1'), false, '被拒时不得创建账户');

  /**
   * ⚠️ R54② 的临时口径（「邀请码模式一律拒绝，因为功能属第 ③ 步」）已在 **R54③ 解除**：
   * 邀请码系统落地之后，该模式改为「必须填一枚有效邀请码」—— 不填是 400（格式/必填）、
   * 填了但不匹配是 403（原因分四档）。完整的四档判据在
   * `tests/audit54c-regressions.test.js` 的 `R54c-04b`，这里只钉住
   * 「**不再**是那句『功能尚未开放』的 403」—— 谁把它退回去，本条立刻变红。
   */
  configStore.saveSite({ registration: 'invite' });
  r = await api('POST', '/api/auth/register', { body: { username: 'nope2', password: PASSWORD } });
  assertEqual(r.status, 400, `不带邀请码应为 400（提示「请输入邀请码」），实际 ${r.status}`);
  assertMatch(r.json.error, /邀请码/);
  assert(!/尚未开放/.test(r.json.error), '不得再出现「邀请码功能尚未开放」这类过期话术');
  assertEqual(configStore.listUsers().some((u) => u.username === 'nope2'), false);
});

test('R54b-4 · 注册：开放时建成账户并按站点设置赋身份，请求体里的 role 被忽略', async () => {
  configStore.saveSite({ registration: 'open', defaultRole: 'user' });
  const r = await api('POST', '/api/auth/register', {
    // 恶意请求体：带上 role / permissions / email —— 三条都必须被忽略
    body: { username: 'reg-a', password: PASSWORD, confirmPassword: PASSWORD, role: 'admin', permissions: { all: true }, email: 'attacker@example.com' },
  });
  assertEqual(r.status, 200, `注册应成功：${r.raw}`);
  assertEqual(r.json.user.username, 'reg-a');
  assertEqual(r.json.user.role, 'user', '身份必须取站点设置（默认普通用户），而不是请求体里的 admin');
  assertEqual(r.json.user.email, '', '需求口径：注册只收用户名 + 密码，不收邮箱');
  assertEqual(r.json.user.permissions && r.json.user.permissions.all, undefined, '权限不得来自请求体');
  // 注册即登录：响应里必须真的带上了会话 Cookie
  assert(String(r.headers['set-cookie'] || '').includes(authSession.COOKIE_NAME + '='),
    '注册成功应当直接签发会话（响应必须带会话 Cookie）');

  // 需求 3：新用户身份可设为管理员 —— 此时新账户确实是管理员
  configStore.saveSite({ defaultRole: 'admin' });
  const r2 = await api('POST', '/api/auth/register', { body: { username: 'reg-b', password: PASSWORD } });
  assertEqual(r2.json.user.role, 'admin', '站点设置成"管理员"时新用户就是管理员');
  configStore.saveSite({ defaultRole: 'user', registration: 'closed' }); // 还原，免得影响后续用例
});

test('R54b-4 · 注册：两次密码不一致 400、重名 409、弱密码 400（沿用既有判据）', async () => {
  configStore.saveSite({ registration: 'open' });
  try {
    const r1 = await api('POST', '/api/auth/register', {
      body: { username: 'reg-c', password: PASSWORD, confirmPassword: 'x'.repeat(8) },
    });
    assertEqual(r1.status, 400);

    await api('POST', '/api/auth/register', { body: { username: 'reg-d', password: PASSWORD } });
    const r2 = await api('POST', '/api/auth/register', { body: { username: 'reg-d', password: PASSWORD } });
    assertEqual(r2.status, 409, '重名必须 409（与管理员新增用户同一判据）');

    const r3 = await api('POST', '/api/auth/register', { body: { username: 'reg-e', password: '123' } });
    assertEqual(r3.status, 400, '弱密码必须 400 —— 注册入口不能绕过密码策略');
  } finally {
    configStore.saveSite({ registration: 'closed' });
  }
});

test('R54b-4 · 公开白名单：注册 / 忘记密码 / 重置密码在内，邮箱验证码在外', () => {
  const idx = fs.readFileSync(SERVER('index.js'), 'utf8');
  const m = /const PUBLIC_API = new Set\(\[([^\]]*)\]\)/.exec(idx);
  assert(m, 'index.js 应有 PUBLIC_API 的 Set 声明（先确认解析口径没失效）');
  for (const p of ['/auth/register', '/auth/forgot', '/auth/reset']) {
    assert(m[1].includes(`'${p}'`), `${p} 必须在匿名白名单里 —— 登录之前就要用`);
  }
  assert(!m[1].includes("'/auth/email/code'"),
    '/auth/email/code 必须**不在**白名单 —— 它是登录用户给自己绑邮箱的第一步，必须持会话');
});

/* ================================================================== *
 * ⑤ 找回密码路由层 · 恒真响应 / 同形失败 / 端到端真发信
 * ================================================================== */

test('R54b-5 · 忘记密码：SMTP 未配置时统一 503（与标识是否命中无关）', async () => {
  configStore.save({ smtp: {} });
  const r = await api('POST', '/api/auth/forgot', { body: { identifier: 'whatever' } });
  assertEqual(r.status, 503, '发不出去就该明说，而不是让用户等一封永远不来的邮件');
  assertMatch(r.json.error, /SMTP|发信/);
});

test('R54b-5 · 忘记密码：命中 / 未命中 / 账户没邮箱 三种情况的响应**逐字节相同**', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    await mkUser('forgot-a', 'user', 'has-mail@example.com');
    await mkUser('forgot-b'); // 没有邮箱（需求 2.3 的场景）

    mock.reset();
    const hit = await api('POST', '/api/auth/forgot', { body: { identifier: 'forgot-a' } });
    assertEqual(hit.status, 200);
    assert(mock.rec.data.length > 0, '命中必须真的发了一封信');

    const byMail = await api('POST', '/api/auth/forgot', { body: { identifier: 'has-mail@example.com' } });
    const noMail = await api('POST', '/api/auth/forgot', { body: { identifier: 'forgot-b' } });
    const missing = await api('POST', '/api/auth/forgot', { body: { identifier: 'no-such-user' } });
    const empty = await api('POST', '/api/auth/forgot', { body: { identifier: '' } });

    /**
     * 本端点在匿名白名单里。响应一旦按「有没有这个账户 / 它的邮箱是否为空」而不同，
     * 它就成了一条**账户存在性 oracle**（R21-05 / R22-01 收敛登录三支同形堵的就是这个洞）。
     */
    for (const [label, res] of [['邮箱命中', byMail], ['账户无邮箱', noMail], ['账户不存在', missing], ['标识为空', empty]]) {
      assertEqual(res.status, 200, `${label}：状态码必须同为 200`);
      assertEqual(res.raw, hit.raw, `${label}：响应体必须与"命中"逐字节相同（否则就是枚举通道）`);
    }
    // 冷却（60 秒）同样**不得**体现在响应里 —— 命中时回 429、未命中回 200 也是 oracle
    assertEqual(byMail.status, 200, '重发冷却不得让响应与"未命中"分叉');
  } finally {
    mock.close();
  }
});

test('R54b-5 · 忘记密码 → 重置：端到端真发信取码 → 改密成功 → 旧会话失效', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    configStore.saveSite({ siteName: '端到端站' });
    const u = await mkUser('reset-a', 'user', 'reset-a@example.com');
    const oldToken = authSession.createSession(configStore.getUserById(u.id), {});
    assert(authSession.getSession(oldToken), '前置：应当有一个有效会话');

    mock.reset();
    const ask = await api('POST', '/api/auth/forgot', { body: { identifier: 'reset-a' } });
    assertEqual(ask.status, 200);
    // 主题与正文都要有站点名称与验证码
    const payload = mock.rec.data.join('\r\n');
    const subjIdx = payload.indexOf('Subject:');
    assertEqual(decodeFirstEncodedWord(payload.slice(subjIdx)), '端到端站 重置密码验证码',
      '重置邮件的主题必须是「站点名称 + 重置密码验证码」');
    const code = codeFromMock(mock.rec);
    assertMatch(mailText(mock.rec), /账户「reset-a」/, '正文要点明是哪个账户在重置');

    // 验证码错误 ⇒ 统一的失败文案（不区分"没签过码"与"码不对"）
    const bad = await api('POST', '/api/auth/reset', {
      body: { identifier: 'reset-a', code: code === '000000' ? '111111' : '000000', password: 'NewPass!2026' },
    });
    assertEqual(bad.status, 400);
    assertEqual(bad.json.error, emailCode.CODE_FAIL_TEXT);

    const ok = await api('POST', '/api/auth/reset', {
      body: { identifier: 'reset-a', code, password: 'NewPass!2026', confirmPassword: 'NewPass!2026' },
    });
    assertEqual(ok.status, 200, `重置应成功：${ok.raw}`);

    // 新密码真的生效了（走与登录同一个 scrypt 校验实现）
    const authed = await configStore.authenticateUser('reset-a', 'NewPass!2026');
    assert(authed, '新密码必须能登录');
    assertEqual(await configStore.authenticateUser('reset-a', PASSWORD), null, '旧密码必须已失效');

    /**
     * 重置密码是**应急响应动作**：不撤销既有会话就等于这次重置白做
     * （"密码改了但攻击者的旧会话还能用"）。
     */
    assertEqual(authSession.getSession(oldToken), null, '重置后全部会话必须立即失效');

    // 一次性：同一个码不能再用一次
    const again = await api('POST', '/api/auth/reset', {
      body: { identifier: 'reset-a', code, password: 'Third!2026x' },
    });
    assertEqual(again.status, 400, '验证码必须一次性');
    assertEqual(again.json.error, emailCode.CODE_FAIL_TEXT);
  } finally {
    mock.close();
  }
});

test('R54b-5 · 重置：标识不存在 / 账户没邮箱 / 码不对 三种失败响应同形', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    await mkUser('reset-b'); // 无邮箱
    const bodies = [
      { identifier: 'no-such-user', code: '123456', password: 'Xx!2026abc' },
      { identifier: 'reset-b', code: '123456', password: 'Xx!2026abc' },
    ];
    const raws = [];
    for (const body of bodies) {
      const r = await api('POST', '/api/auth/reset', { body });
      assertEqual(r.status, 400);
      assertEqual(r.json.error, emailCode.CODE_FAIL_TEXT);
      raws.push(r.raw);
    }
    assertEqual(raws[0], raws[1], '两种失败的响应必须逐字节相同');
    // 空密码 / 两次不一致要在**校验验证码之前**判掉（否则用户为一个手滑打错的密码白等一封信）
    const mismatch = await api('POST', '/api/auth/reset', {
      body: { identifier: 'no-such-user', code: '123456', password: 'Xx!2026abc', confirmPassword: 'Yy!2026abc' },
    });
    assertEqual(mismatch.status, 400);
    assertMatch(mismatch.json.error, /不一致/, '这类离线可判的错误必须先报，且与验证码无关');
  } finally {
    mock.close();
  }
});

test('R54b-5 · 重置：连错验证码会被临时锁定，且**不与登录共用预算**', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    await mkUser('reset-c', 'user', 'reset-c@example.com');
    const ip = '10.77.77.77';
    let locked = null;
    for (let i = 0; i < 8; i++) {
      const r = await api('POST', '/api/auth/reset', {
        ip, body: { identifier: 'reset-c', code: '135790', password: 'Zz!2026abc' },
      });
      if (r.status === 429) { locked = r; break; }
    }
    assert(locked, '连续失败必须触发临时锁定');
    assertMatch(locked.json.error, /失败次数过多/);
    /**
     * 锁定键带上了来源 IP：否则任何人只要知道别人的用户名，连错 5 次验证码
     * 就能把对方的重置入口冻结最长 30 分钟 —— 锁定被反向用作 DoS。
     */
    assertEqual(authRoutes.resetLockKey(ip, 'reset-c'), authRoutes.resetLockKey(ip, 'RESET-C'),
      '锁键里的标识必须规范化（大小写轮换不得各拿一份预算）');
    assert(authRoutes.resetLockKey(ip, 'reset-c') !== authRoutes.resetLockKey('10.88.88.88', 'reset-c'),
      '不同来源必须互不影响');
    /**
     * 重置路径的失败**不得**把登录也一起锁掉 —— 共用一份预算的话，攻击者只要在
     * 「忘记密码」里连错 5 次验证码，就能把正常登录一并冻结（语义不同就各给一条锁定器）。
     */
    assert(security.resetLock.locked(authRoutes.resetLockKey(ip, 'reset-c')) > 0, '重置路径此刻应处在锁定中');
    assertEqual(security.loginLock.locked(authRoutes.loginLockKey(ip, 'reset-c')), 0,
      '登录的失败预算必须一个都没被消耗');
    const login = await api('POST', '/api/auth/login', { ip, body: { username: 'reset-c', password: 'Zz!2026abc' } });
    assertEqual(login.status, 401, '此刻用错密码登录应回 401（而不是被重置路径的锁定连坐成 429）');
  } finally {
    mock.close();
  }
});

/* ================================================================== *
 * ⑥ 自助 / 管理员邮箱 · 验证码必填 + 当前密码必填 + 管理员直设
 * ================================================================== */

test('R54b-6 · 请求邮箱验证码：非法 400、已被占用 409、已是自己的 200 alreadyBound', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    const me = await mkUser('mail-me', 'user', 'mine@example.com');
    await mkUser('mail-other', 'user', 'taken@example.com');
    const asMe = { id: me.id, username: me.username, role: 'user' };

    let r = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'not-an-email' } });
    assertEqual(r.status, 400);

    r = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'TAKEN@example.com' } });
    assertEqual(r.status, 409, '已被占用的邮箱必须提前拒绝 —— 否则我们会代用户给**另一个人的邮箱**发信');
    assertMatch(r.json.error, /已被其他账户使用/);

    r = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'Mine@Example.com' } });
    assertEqual(r.status, 200);
    assertEqual(r.json.alreadyBound, true, '与现状相同 ⇒ 不必白发一封');

    mock.reset();
    r = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'new-mail@example.com' } });
    assertEqual(r.status, 200, `应发出验证码：${r.raw}`);
    assertEqual(r.json.to, 'new-mail@example.com');
    assertEqual(r.json.resendAfter, 60, '回给前端的冷却秒数必须与 EMAIL_CODE_RESEND_MS 对齐（倒计时要用）');
    const code = codeFromMock(mock.rec);
    assertMatch(mailText(mock.rec), /验证邮箱/, '验证邮箱的邮件标题/正文应当与"重置密码"区分开');

    // 冷却：同一个邮箱 60 秒内再要一次 ⇒ 如实回 429（这里不是匿名端点，不存在枚举问题）
    const again = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'new-mail@example.com' } });
    assertEqual(again.status, 429);
    assert(Number(again.headers['retry-after']) > 0, '必须带 Retry-After');

    // 验证码正确 ⇒ 落库；且码被核销（再用一次不成立）
    const set = await api('PUT', '/api/users/me', {
      as: asMe, body: { email: 'new-mail@example.com', emailCode: code, currentPassword: PASSWORD },
    });
    assertEqual(set.status, 200, `改邮箱应成功：${set.raw}`);
    assertEqual(set.json.user.email, 'new-mail@example.com');
    assertEqual(configStore.getUserById(me.id).email, 'new-mail@example.com', '必须真落库（而不是只回了响应）');
  } finally {
    mock.close();
  }
});

test('R54b-6 · 改邮箱：缺验证码 400、码错 400（统一文案）；提交同一邮箱视为没改', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    const me = await mkUser('mail-2', 'user', 'm2@example.com');
    const asMe = { id: me.id, username: me.username, role: 'user' };

    let r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'x1@example.com' } });
    assertEqual(r.status, 400);
    assertMatch(r.json.error, /验证码/);

    r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'x1@example.com', emailCode: '000000', currentPassword: PASSWORD } });
    assertEqual(r.status, 400);
    assertEqual(r.json.error, emailCode.CODE_FAIL_TEXT, '码不对时只说一句话（"没签过"与"码错了"不可区分）');
    assertEqual(configStore.getUserById(me.id).email, 'm2@example.com', '失败时不得改动邮箱');

    // 提交与现状相同的邮箱 ⇒ 视为"没改"，不要求验证码（界面上用户没动这个字段）
    r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'm2@example.com', username: 'mail-2' } });
    assertEqual(r.status, 200, `同值提交不应被拦：${r.raw}`);
    assertEqual(r.json.user.email, 'm2@example.com');

    // 解绑：空串合法，且**不需要**验证码（收紧而不是放松），但仍要当前密码
    r = await api('PUT', '/api/users/me', { as: asMe, body: { email: '', currentPassword: PASSWORD } });
    assertEqual(r.status, 200, `解绑应成功：${r.raw}`);
    assertEqual(r.json.user.email, '', '解绑必须真的生效（判据是 !== undefined 而不是真值判断）');
  } finally {
    mock.close();
  }
});

test('R54b-6 · 改邮箱必须二次确认当前密码（R21-09 同款）', async () => {
  const mock = await startMock();
  try {
    useMockSmtp(mock);
    const me = await mkUser('mail-3', 'user', 'm3@example.com');
    const asMe = { id: me.id, username: me.username, role: 'user' };

    const ask = await api('POST', '/api/auth/email/code', { as: asMe, body: { email: 'm3-new@example.com' } });
    assertEqual(ask.status, 200);
    const code = codeFromMock(mock.rec);

    // 没带当前密码
    let r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'm3-new@example.com', emailCode: code } });
    assertEqual(r.status, 400);
    assertEqual(r.json.needCurrentPassword, true);

    // 当前密码错
    r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'm3-new@example.com', emailCode: code, currentPassword: 'wrong-password' } });
    assertEqual(r.status, 403);
    assertEqual(configStore.getUserById(me.id).email, 'm3@example.com', '当前密码不对时不得改动邮箱');

    /**
     * 为什么这一条必须有：邮箱是「忘记密码」的**收件渠道**。会话被劫持时，
     * 攻击者只要把自己的邮箱绑上来，就能走「忘记密码」把账户永久接管 ——
     * 而**验证码对此毫无帮助**（收件箱本来就在他手上）。
     */
    r = await api('PUT', '/api/users/me', { as: asMe, body: { email: 'm3-new@example.com', emailCode: code, currentPassword: PASSWORD } });
    assertEqual(r.status, 200, `带齐两项证明后应成功：${r.raw}`);
    assertEqual(configStore.getUserById(me.id).email, 'm3-new@example.com');
  } finally {
    mock.close();
  }
});

test('R54b-7 · 管理员：新增 / 编辑用户可直接设置邮箱，留空 = 不设置，非法 400', async () => {
  const admin = { id: 'admin-1', username: 'boss', role: 'admin' };
  await mkUser('boss', 'admin');

  let r = await api('POST', '/api/users', { as: admin, body: { username: 'adm-1', password: PASSWORD, email: 'adm1@example.com' } });
  assertEqual(r.status, 200, `管理员可直接设邮箱（需求 2.6）：${r.raw}`);
  assertEqual(r.json.user.email, 'adm1@example.com');
  const id = r.json.user.id;

  r = await api('POST', '/api/users', { as: admin, body: { username: 'adm-2', password: PASSWORD } });
  assertEqual(r.json.user.email, '', '留空 = 不设置邮箱（需求 2.3 的场景）');

  r = await api('POST', '/api/users', { as: admin, body: { username: 'adm-3', password: PASSWORD, email: 'bad@@x' } });
  assertEqual(r.status, 400, '非法邮箱必须 400（不由落盘层静默归一）');

  r = await api('POST', '/api/users', { as: admin, body: { username: 'adm-4', password: PASSWORD, email: 'ADM1@example.com' } });
  assertEqual(r.status, 409, '邮箱唯一性对管理员同样成立');

  // 需求 2.5：管理员可修改任何人的邮箱
  r = await api('PUT', `/api/users/${id}`, { as: admin, body: { email: 'adm1-new@example.com' } });
  assertEqual(r.status, 200, `管理员改邮箱：${r.raw}`);
  assertEqual(r.json.user.email, 'adm1-new@example.com');

  // 解绑：空串（判据必须是 `!== undefined`，否则解绑会静默失效）
  r = await api('PUT', `/api/users/${id}`, { as: admin, body: { email: '' } });
  assertEqual(r.status, 200, `管理员解绑邮箱：${r.raw}`);
  assertEqual(r.json.user.email, '');
  assertEqual(configStore.getUserById(id).email, '', '解绑必须真落库');

  r = await api('PUT', `/api/users/${id}`, { as: admin, body: { email: 'not-an-email' } });
  assertEqual(r.status, 400);
});

test('R54b-7 · 管理员改邮箱**不**撤销会话（它不是身份、也不是权限）', async () => {
  const admin = { id: 'admin-2', username: 'boss2', role: 'admin' };
  await mkUser('boss2', 'admin');
  const u = await mkUser('sess-user', 'user', 's@example.com');
  const token = authSession.createSession(configStore.getUserById(u.id), {});

  const r = await api('PUT', `/api/users/${u.id}`, { as: admin, body: { email: 's-new@example.com' } });
  assertEqual(r.status, 200);
  assertEqual(r.json.sessionsRevoked, undefined, '改邮箱不属于 sensitive —— 不该撤会话');
  assert(authSession.getSession(token), '改邮箱后会话必须仍然有效（否则是纯打扰）');

  // 反向对照：改**角色**必须撤会话（证明上面那条断言有牙齿，不是恒真）
  const r2 = await api('PUT', `/api/users/${u.id}`, { as: admin, body: { role: 'admin' } });
  assertEqual(r2.status, 200);
  assert(r2.json.sessionsRevoked >= 1, '改角色必须撤销会话（SEC-02）');
  assertEqual(authSession.getSession(token), null, '改角色后旧会话必须失效');
});

/* ================================================================== *
 * ⑦ 前端层（静态接线）
 * ================================================================== */

test('R54b-8 · 登录页：有「注册」「忘记密码」「返回登录」三个入口与验证码输入框', () => {
  const html = readHtml();
  for (const id of ['auth-register-link', 'auth-forgot-link', 'auth-back-login', 'auth-code']) {
    assert(html.includes(`id="${id}"`), `index.html 必须有 #${id}（需求 2.1 / 2.2）`);
  }
  // 三个入口都得是**默认隐藏**、由 JS 按模式点亮 —— 否则登录页一上来就同时摆出三条互斥的路
  for (const id of ['auth-register-link', 'auth-forgot-link', 'auth-back-login']) {
    assert(new RegExp(`id="${id}"[^>]*\\shidden`).test(html), `#${id} 必须默认 hidden`);
  }
  // 「记住密码」取代了原来的「记住登录状态」—— 文案不得再声称"不保存密码"
  assert(!/仅保存用户名/.test(html), '「记住密码」已取代「记住登录状态」，旧的"绝不保存密码"文案必须撤掉');
  assertMatch(html, /记住密码/);

  const main = readJs('main.js');
  for (const mode of ['register', 'forgot']) {
    assert(main.includes(`'${mode}'`), `main.js 的 authMode 必须支持 ${mode}`);
  }
  // 忘记密码是两步：第一步发码、第二步凭码改密
  assertMatch(main, /forgotStep/, '忘记密码必须有"第几步"的状态（两步流程）');
  assertMatch(main, /forgotIdentifier/, '第二步要原样带回第一步填的标识');
  /**
   * 注册入口必须由「在登录页」**且**「站点允许注册」两个条件共同决定 ——
   * 只判前者的话，关闭注册下会摆出一个点了必然失败的链接。
   *
   * ⚠️ R54③ 起「允许注册」是**两种模式**：`open`（直接注册）与 `invite`（要填邀请码）。
   * 只认 `open` 会让邀请码模式下的用户**完全看不到注册入口** —— 而那个模式下
   * 注册恰恰是能成功的，等于把功能藏掉了。只有 `closed` 才整条隐藏。
   */
  // 把连续空白压成一个空格再匹配：这条赋值在源码里是**折行**写的，
  // 逐字正则会被换行与缩进绊倒（而那不是判据想守的东西）。
  const mainFlat = main.replace(/\s+/g, ' ');
  assertMatch(mainFlat,
    /auth-register-link'\)\.hidden = !\(authMode === 'login' && \(siteRegistration === 'open' \|\| siteRegistration === 'invite'\)\)/,
    '注册入口必须同时看"是不是登录页"与"站点是否允许注册（open 或 invite）"');
});

test('R54b-8 · 「记住密码」：本机保存密码走 REMEMBER_MODE 分支，且带一个明确的关闭态', () => {
  const main = readJs('main.js');
  assertMatch(main, /REMEMBER_MODE/, '必须有一个集中的"记住密码"取值口径（而不是散落的布尔）');
  for (const v of ['NONE', 'PASSWORD']) {
    assert(main.includes(v), `REMEMBER_MODE 应有 ${v} 一档`);
  }
  // 保存 / 清除的唯一实现点
  assertMatch(main, /function\s+saveRemember/, '仍然只能有一个保存实现点');
  assertMatch(main, /function\s+loadRemember/, '仍然只能有一个读取实现点');
  /**
   * 存的是**密码本身**，因此必须过一层混淆：明文落 localStorage 意味着
   * 「打开开发者工具看一眼」就能把凭据抄走。
   * ⚠️ 但混淆不是加密 —— 判据只能落在"真的做了变换"，不能声称它是安全的。
   */
  assertMatch(main, /xorBytes/, '落盘的密码必须经过一层异或混淆');
  assertMatch(main, /getRandomValues/, '混淆密钥必须来自密码学随机源');
  /**
   * 混淆的**输入**必须是密码本身 —— 这条比"有没有调 xorBytes"更接近要害：
   * 把 `String(password || '')` 换成 `''`，混淆照样跑、函数照样在，
   * 但"记住密码"已经不再记住任何东西了。
   */
  assertMatch(main, /new TextEncoder\(\)\.encode\(String\(password/, '被混淆的必须是密码本身');
  assertMatch(main, /p: bytesToB64\(secret\)/, '落盘的是混淆结果（`p`），不是用户名也不是明文');
  assertMatch(main, /b64ToBytes\(saved\.p\), b64ToBytes\(saved\.k\)/, '取回密码时要同时用密文与密钥解');
  // 界面提示必须如实说明"只是混淆、不是加密"
  assertMatch(readHtml(), /并不是加密/, '提示必须如实说明"混淆不是加密"，不能让用户以为它安全');
});

test('R54b-8 · api.js 暴露注册 / 忘记密码 / 重置 / 邮箱验证码四个接口', () => {
  const api = readJs('api.js');
  for (const pair of [
    ['register:', '/api/auth/register'],
    ['forgotPassword:', '/api/auth/forgot'],
    ['resetPassword:', '/api/auth/reset'],
    ['emailCode:', '/api/auth/email/code'],
  ]) {
    assert(api.includes(pair[0]), `api.js 应暴露 ${pair[0]}`);
    assert(api.includes(pair[1]), `api.js 应打到 ${pair[1]}`);
  }
  // 前三条是"登录前"要用的，401 时不得触发全局跳登录（本来就在登录页）
  assertMatch(api, /register[\s\S]{0,400}?noAuthRedirect/, '注册失败不得派发 auth-required');
  assertMatch(api, /forgotPassword[\s\S]{0,400}?noAuthRedirect/, '忘记密码失败不得派发 auth-required');
});

/**
 * ⚠️ 这条**必须**是真跑一次请求，不能只断言 `api.js` 源码里出现过 `retryAfter`。
 *
 * 静态判据（「文件里有这个词」）在 R54② 里恰好是**假绿**的反面教材：源码里两处
 * 都写着 `retryAfter`，但真到响应那一步要先经过 `res.headers.get('Retry-After')`
 * —— 而当时**所有**假 `fetch` 桩都没有 `headers`，于是这条路径一跑就是 TypeError、
 * 错误对象上根本没有 `status`（更谈不上 `retryAfter`）。断言只打在源码上，
 * 这层就永远看不见。判据因此落在**实际被执行的那一层**：装一个带响应头的假 `fetch`
 * 真调一次 `request()`。
 */
test('R54b-8 · api.js：限流响应真的把 Retry-After 挂到 err.retryAfter 上', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    // 真实 `Response` 一定带 headers；此处刻意给出，正是上面那段注释要守的东西
    headers: { get: (n) => (String(n).toLowerCase() === 'retry-after' ? '37' : null) },
    json: async () => ({ error: '发送过于频繁，请稍后再试' }),
  });
  try {
    const { API } = await import(pathToFileURL(JS('api.js')).href);
    let err = null;
    try { await API.emailCode('someone@example.com'); } catch (e) { err = e; }
    assert(err, '429 必须抛出错误');
    assertEqual(err.status, 429, '错误对象必须保留状态码（否则调用方连"是限流"都判不出来）');
    assertEqual(err.retryAfter, 37,
      '界面倒计时要用服务端给的秒数（Retry-After）—— 写死一个猜的数会与服务端窗口对不上');

    // 对照：响应没带这个头时**不得**凭空造一个值出来（否则倒计时会锁住一个不存在的窗口）
    globalThis.fetch = async () => ({
      ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: 'x' }),
    });
    let err2 = null;
    try { await API.emailCode('someone@example.com'); } catch (e) { err2 = e; }
    assert(err2, '429 仍然必须抛错');
    assertEqual(err2.retryAfter, undefined, '没有 Retry-After 时不得硬编一个数字');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('R54b-8 · 编辑资料弹窗：邮箱 + 验证码 + 发送按钮 + 倒计时', () => {
  const p = readJs('profile.js');
  assertMatch(p, /p-f-email\b/, '编辑资料必须有邮箱输入框');
  assertMatch(p, /p-f-email-code/, '必须有验证码输入框');
  assertMatch(p, /p-f-email-send/, '必须有"发送验证码"按钮');
  assertMatch(p, /API\.emailCode\(/, '"发送验证码"必须真的调接口（而不是只改 UI）');
  assertMatch(p, /startCountdown/, '必须有倒计时（与服务端的重发冷却对齐）');
  // 改邮箱必须带上验证码与当前密码
  assertMatch(p, /emailCode/, '保存时必须把验证码放进请求体');
  assertMatch(p, /body\.email\s*=/, '保存时必须把邮箱放进请求体');
});

/* ================================================================== *
 * ⑧ R57 找回密码流程的三处修补（前端接线层）
 * ================================================================== */

test('R57-06 · 忘记密码第一步：标识输入框的提示词必须与「用户名或邮箱」的 label 同步', () => {
  const main = readJs('main.js');
  /**
   * 一处真相：两个文案由**同一个三元**决定。分写两处必然分叉 —— 本轮修的就是这个
   * （label 改成了「用户名或邮箱」，而 `index.html` 里的 placeholder 还写死「请输入用户名」，
   * 用户会以为这里只收用户名，明明绑过邮箱也不敢填）。
   */
  assertMatch(main,
    /userInput\.placeholder\s*=\s*isForgot\s*\?\s*'请输入用户名或已绑定的邮箱'\s*:\s*'请输入用户名'/,
    'forgot 形态的 placeholder 必须说「用户名或邮箱」，其余形态回到「请输入用户名」');
  assert(!/userInput\.placeholder\s*=\s*'请输入用户名';/.test(main),
    '不得再有把 placeholder 写死成「请输入用户名」的地方 —— 那正是 label 与提示词不一致的来源');
  // 静态 HTML 是登录形态，因此默认文案就该是「请输入用户名」
  assertMatch(readHtml(), /id="auth-username"[^>]*placeholder="请输入用户名"/,
    'index.html 的默认 placeholder 对登录形态仍是正确的');
});

test('R57-07 · 发送验证码失败时不得进入重置窗口（步号只能在 try 的成功分支里推进）', () => {
  const src = readJs('main.js');
  const i = src.indexOf('async function submitForgotAsk');
  assert(i > 0, '自证：应当能取到 submitForgotAsk()');
  const j = src.indexOf('async function submitForgotReset', i);
  assert(j > i, '自证：应当能取到它后面的 submitForgotReset()');
  const body = src.slice(i, j);

  const iCatch = body.indexOf('} catch (');
  assert(iCatch > 0, '自证：该函数应当有 catch 分支');
  const tryPart = body.slice(0, iCatch);
  const catchPart = body.slice(iCatch);
  assert(tryPart.includes('await API.forgotPassword'), '自证：成功分支里应当真的调了发码接口');
  assert(tryPart.includes('forgotStep = 2'), '推进步号必须发生在 await 成功之后');
  assert(!/forgotStep\s*=\s*2/.test(catchPart),
    '失败分支（catch）里绝不能推进步号 —— 那就是「发送失败也会立即进入重设密码的窗口」');
  /**
   * ⚠️ 这里钉住的是"前端不会无缘无故地推进"；「发送失败 ⇒ 真的不推进」的另一半
   * 落在服务端：站点级失败（未配置 / 已停用 / 连不上 / 认证被拒）必须回非 2xx，
   * 见 `audit53-regressions.test.js` 的 R57-02 / R57-04。两半合起来才是完整修复。
   */
});

test('R57-08 · 重置窗口：「重新发送验证码」存在、带 60 秒倒计时，且重绘不会把它复原成可点', () => {
  const html = readHtml();
  assert(html.includes('id="btn-auth-resend"'), '重置窗口必须有「重新发送验证码」按钮');
  // 与验证码输入框同一行（`.code-line`）：放到别处用户根本找不到重发入口
  assert(/<div class="code-line">[\s\S]{0,400}?id="btn-auth-resend"/.test(html),
    '重发按钮应与验证码输入框同一行');
  assert(/type="button"[^>]*id="btn-auth-resend"|id="btn-auth-resend"[^>]*type="button"/.test(html),
    '必须是 type="button" —— 默认的 submit 会被回车键连带触发');

  const main = readJs('main.js');
  assertMatch(main, /秒后可重新发送/, '倒计时期间必须显示剩余秒数（需求：60 秒后可重新发送）');
  assertMatch(main, /function\s+renderResendBtn/, '按钮的文案/可用性必须有唯一渲染点');
  assertMatch(main, /function\s+startResendCountdown/, '必须有倒计时实现');
  assertMatch(main, /function\s+stopResendCountdown/, '必须有停止倒计时的实现（否则离开后定时器还在跑）');
  assertMatch(main, /resendLeft/, '剩余秒数必须是状态，而不是只写进 DOM 文本');

  // 首次发码成功后立刻开始倒计时（刚发出去的那封信，本来就不该马上再发一封）
  const iAsk = main.indexOf('async function submitForgotAsk');
  const askBody = main.slice(iAsk, main.indexOf('async function submitForgotReset', iAsk));
  assert(askBody.includes('startResendCountdown(60)'), '首次发码成功后必须立刻开始倒计时');
  // 重发入口必须真的调接口（只改 UI 就成了假按钮）
  assertMatch(main, /async function resendForgotCode[\s\S]{0,1200}?API\.forgotPassword/,
    '重发必须真的调 `/auth/forgot`，不能只改界面');
  // 切走时停表；重绘后重新渲染（否则 HTML 的初始文案会把它"复原"成可点，用户能在冷却期内连点）
  const iMode = main.indexOf('function setAuthMode');
  assert(iMode > 0, '自证：应当能取到 setAuthMode()');
  const modeBody = main.slice(iMode, main.indexOf('function hideAuthOverlay', iMode));
  assert(modeBody.includes('stopResendCountdown()'),
    '切走忘记密码形态时必须停掉倒计时 —— 否则定时器会在别的形态下继续空转，再进来时按钮上还挂着上次的剩余秒数');
  const iOverlay = main.indexOf('function showAuthOverlay()');
  assert(iOverlay > 0, '自证：应当能取到 showAuthOverlay()');
  const overlayBody = main.slice(iOverlay, main.indexOf('function setAuthMode', iOverlay));
  assert(overlayBody.includes('renderResendBtn()'),
    '遮罩重绘后必须重新渲染重发按钮的文案与可用性 —— 否则它会被 HTML 的初始文案"复原"成可点');
  // 绑定入口（与另外三个入口同款：直接赋 onclick，避免监听器叠加）
  assertMatch(main, /link\('btn-auth-resend',\s*resendForgotCode\)/, '重发按钮必须被真正绑定');
});
