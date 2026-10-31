/**
 * 第九十七轮护栏：主密钥信封（R97）—— HTTP 面的三档权限与「解锁通道」的暴露面
 *
 * ## 为什么单独立一个文件
 *
 * `keyring.test.js` 守密码学契约、`keyrotate.test.js` 守流程契约，两个都在
 * 进程内直接调模块。而本轮**最容易被将来的改动放松**的东西不在那两个层面：
 *
 *  · `/key/status` 是**匿名**接口 —— 它多返回一个字段，就等于匿名泄露一个事实；
 *  · `/key/unlock` 是**匿名 + 昂贵（scrypt）**的接口 —— 限流与失败锁的**顺序**
 *    写反了功能上照旧能解锁，只是每次请求白烧一次 CPU，而这一点没有任何功能
 *    现象会暴露；
 *  · `/key/migrate`、`/key/rotate-login` 是**根用户**专属 —— 它们改的是
 *    "全实例的解密能力"，管理员也不该有；
 *  · 锁定态闸门里那条 `LOCKED_ALLOWED` 放行清单是**死锁的唯一出口**：
 *    漏掉 `/key/unlock` 就是"永远解不了锁"。
 *
 * ## 判据落点
 *
 *  R97-23~R97-28、R97-31 落在**真实 HTTP 响应**上（状态码 / 响应体字段集合 /
 *  有没有 Set-Cookie）；R97-29 是**结构断言**，因为它的回归形态是"有人觉得这条
 *  路径不用放行"——那种改动在本地跑一切正常（本地根本不锁），只有结构断言抓得住。
 *
 * ## 夹具说明
 *
 * 这里挂的是**真实路由模块** `server/routes/key.js`；harness 只补两件事：把
 * `X-Requested-With` 交给真实的 `security.csrfGuard`（与 `index.js` 同一实现点），
 * 以及用 `X-Test-Role` 模拟"已通过鉴权的调用者"。后者是**测试支架**而非被测逻辑 ——
 * 鉴权链本身由 `tests/auth-session.test.js` 与 `routes-surface` 负责。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const test = require('node:test');

const { assert, assertEqual, ROOT } = require('./helpers');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-r97-http-'));
process.env.S3_DATA_DIR = tmpDir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

const security = require(SERVER('security.js'));
const configStore = require(SERVER('config-store.js'));
const keyring = require(SERVER('keyring.js'));
const keyRoutes = require(SERVER('routes', 'key.js'));
const authSession = require(SERVER('auth-session.js'));

const PASSPHRASE = 'HttpMainPass789';
let rootUser = null;

/* ---------------------------------------------------------------- *
 * 夹具：钉住 keyring 状态，避免用例互相污染
 * ---------------------------------------------------------------- */
test.before(async () => {
  rootUser = await configStore.addUser({
    username: 'root', password: PASSPHRASE, role: 'root',
  });
  configStore.flushPending();
  // 包裹的必须是**真的那把**主密钥：否则解锁后读配置会解不开，
  // 而那是"配置损坏"而不是本文件要考的形态
  await keyring.create(PASSPHRASE, Buffer.from(configStore.getMasterKey()));
  keyring.lock(); // 从「锁定态」开始，正好是本轮的新常态
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
});

/* ---------------------------------------------------------------- *
 * 极简 HTTP 夹具
 * ---------------------------------------------------------------- */
function buildApp() {
  const app = express();
  app.use(express.json());
  // 与 index.js 的 /api 前置闸门同序：先 CSRF，再（模拟已鉴权的）调用者
  app.use('/api', (req, res, next) => {
    if (!security.csrfGuard(req)) {
      return res.status(403).json({ error: '请求缺少同源校验头，已拒绝（CSRF 防护）' });
    }
    const role = String(req.headers['x-test-role'] || '');
    if (role) req.authUser = { id: rootUser.id, username: rootUser.username, role };
    next();
  });
  app.use('/api', keyRoutes);
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(port);
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
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================================================================== *
 * 1 · /key/status 的分级下发
 * ================================================================== */

test('R97-23 · /key/status 匿名：只答"要不要解锁"，不泄露版本号与旧密钥是否存在', async () => {
  if (!keyring.isUnlocked()) keyring.lock();
  await withServer(async (port) => {
    const r = await request(port, 'GET', '/api/key/status');
    assertEqual(r.status, 200, '匿名也必须能问（否则锁定态下前端无从判断）');
    const keys = Object.keys(r.json || {}).sort();
    /**
     * 判据是**字段集合相等**，不是"包含"。
     * 「多返回一个字段」正是这类接口唯一的回归形态，`includes` 抓不到它。
     */
    assertEqual(JSON.stringify(keys), JSON.stringify(['envelope', 'locked', 'unlocked']),
      '匿名只应拿到三个布尔字段，实际：' + keys.join(','));
    assertEqual(r.json.locked, true, '锁定态要如实报告');
    assertEqual(r.json.envelope, true, '已有容器');
    assert(
      !('legacyKeyPresent' in r.json) && !('kekVersion' in r.json),
      '匿名不得知道"有没有旧明文密钥""版本号到几"——那是攻击者的选靶信息');
  });
});

test('R97-24 · /key/status 带会话：给出完整状态（密钥卡片要显示"上次轮转于…"）', async () => {
  await withServer(async (port) => {
    const token = authSession.createSession({
      id: rootUser.id, username: rootUser.username, role: 'root',
    });
    const r = await request(port, 'GET', '/api/key/status', {
      headers: { Cookie: authSession.COOKIE_NAME + '=' + token },
    });
    assertEqual(r.status, 200, '带会话应正常返回');
    assertEqual(r.json.envelope, true, 'envelope');
    assertEqual(r.json.kekVersion, 1, '带会话才给版本号');
    assertEqual(typeof r.json.legacyKeyPresent, 'boolean', '带会话才给旧密钥存在性');
    assertEqual(r.json.needsMigration, false, '已有容器就不该提示迁移');
  });
});

test('R97-31 · 容器损坏时 /key/status 回 500 且带 code（前端要能说"这里要运维介入"）', async () => {
  const file = path.join(tmpDir, 'keyring.json');
  const snapshot = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, '{ 坏掉的容器', 'utf8');
    await withServer(async (port) => {
      const r = await request(port, 'GET', '/api/key/status');
      assertEqual(r.status, 500, '损坏必须显式 500，而不是 200 + 一片空白');
      assertEqual(r.json && r.json.code, 'KEYRING_CORRUPT', '要带可识别的错误码');
      assertEqual(r.json.locked, false, '这是"坏了"，不是"锁定"——两者不能混为一谈');
    });
  } finally {
    fs.writeFileSync(file, snapshot);
  }
});

/* ================================================================== *
 * 2 · /key/unlock 的三道闸
 * ================================================================== */

test('R97-25 · /key/unlock 缺同源头 → 403（匿名接口不等于免 CSRF）', async () => {
  await withServer(async (port) => {
    const r = await request(port, 'POST', '/api/key/unlock', {
      body: { passphrase: PASSPHRASE },
      headers: { 'X-Requested-With': '' },
    });
    assertEqual(r.status, 403, '匿名接口一样要过 CSRF 闸门');
    assertEqual(keyring.isUnlocked(), false, '被 CSRF 拦下的请求不得产生解锁副作用');
  });
});

test('R97-26 · /key/unlock 成功：解锁，但**不签发会话**（解锁不是免登录通道）', async () => {
  assertEqual(keyring.isUnlocked(), false, '前置：锁定态');
  await withServer(async (port) => {
    const r = await request(port, 'POST', '/api/key/unlock', {
      body: { passphrase: PASSPHRASE },
    });
    assertEqual(r.status, 200, '正确口令应解锁');
    assertEqual(r.json && r.json.unlocked, true, '响应应报告已解锁');
    assertEqual(keyring.isUnlocked(), true, '进程内应真的解锁了');
    /**
     * 这一条是本轮的安全边界：若解锁顺带签发会话，`/key/unlock` 就成了一条
     * **只需主口令就能拿到登录态**的旁路 —— 而主口令是运维在 .env 里写的那串，
     * 与"谁在用这个账号"无关。
     */
    assertEqual(r.headers['set-cookie'], undefined, '解锁不得下发任何 Cookie');
  });
});

/* ================================================================== *
 * 3 · 迁移 / 轮转的权限档
 * ================================================================== */

test('R97-27 · /key/migrate 与 /key/rotate-login：管理员也不行，必须根用户', async () => {
  await withServer(async (port) => {
    for (const urlPath of ['/api/key/migrate', '/api/key/rotate-login']) {
      const anon = await request(port, 'POST', urlPath, { body: { passphrase: PASSPHRASE } });
      assertEqual(anon.status, 403, urlPath + ' 匿名叫用必须 403');
      for (const role of ['user', 'admin']) {
        const r = await request(port, 'POST', urlPath, {
          body: { passphrase: PASSPHRASE },
          headers: { 'X-Test-Role': role },
        });
        /**
         * `admin` 也在拒绝之列：R71 立过规矩 —— `isStaff`（能管站点/用户）与
         * `canManageUser`（能改谁的凭据）必须分开。解锁因子影响的是**全实例的
         * 解密能力**，比"管用户"高一档，不能继承管理员的权力。
         */
        assertEqual(r.status, 403, urlPath + ' 角色 ' + role + ' 必须 403');
      }
    }
  });
});

test('R97-28 · 根用户调迁移/轮转时，缺口令是 400 而不是 500（参数缺失与内部错误要分得开）', async () => {
  await withServer(async (port) => {
    const m = await request(port, 'POST', '/api/key/migrate', {
      body: {}, headers: { 'X-Test-Role': 'root' },
    });
    assertEqual(m.status, 400, '空口令应是 400');
    assert(/口令/.test(m.json && m.json.error), '错误文案要指出缺的是口令');

    const r = await request(port, 'POST', '/api/key/rotate-login', {
      body: { currentPassphrase: PASSPHRASE }, headers: { 'X-Test-Role': 'root' },
    });
    assertEqual(r.status, 400, '缺新口令应是 400');
  });
});

/* ================================================================== *
 * 4 · 锁定态闸门（结构断言：它的回归形态在本地跑不出来）
 * ================================================================== */

test('R97-29 · index.js 的锁定态闸门：放行清单必须含解锁两条路径，且排在鉴权之前', () => {
  const src = fs.readFileSync(SERVER('index.js'), 'utf8');
  const gateLine = src.split('\n').find((l) => l.includes('LOCKED_ALLOWED = new Set('));
  assert(gateLine, '必须存在 LOCKED_ALLOWED 放行清单');
  /**
   * 漏掉 `/key/unlock` 的后果不是"某个功能不好用"，而是**死锁**：
   * 锁定态下所有 /api 都 503，而唯一能解锁的接口自己也 503。
   */
  assert(/'\/key\/unlock'/.test(gateLine), '放行清单必须含 /key/unlock（否则永久死锁）');
  assert(/'\/key\/status'/.test(gateLine), '放行清单必须含 /key/status（否则前端不知道该解锁）');

  const guardIdx = src.indexOf('configStore.isLocked()');
  assert(guardIdx > 0, '闸门必须真的用 configStore.isLocked() 判定');
  /**
   * 顺序：CSRF → 锁定闸门 → 鉴权。
   * 闸门若排到鉴权之后，锁定态会先回 401（"未登录"），前端就会去渲染登录页，
   * 而登录本身也解不开数据 —— 用户看到的是"密码明明是对的却登不进去"。
   */
  const csrfIdx = src.indexOf('security.csrfGuard(req)');
  const authIdx = src.indexOf('authSession.parseToken(req)');
  assert(csrfIdx > 0 && authIdx > csrfIdx, '前置：CSRF 与鉴权的相对顺序');
  assert(guardIdx > csrfIdx && guardIdx < authIdx,
    '锁定闸门必须夹在 CSRF 与鉴权之间');
});

/* ================================================================== *
 * 5 · 失败锁（放最后：它会把本 IP 的解锁预算刷完）
 * ================================================================== */

test('R97-30 · /key/unlock 连续失败 → 临时锁定，且锁定期内**正确口令也进不去**', async () => {
  await withServer(async (port) => {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await request(port, 'POST', '/api/key/unlock', { body: { passphrase: 'WrongPass' + i } });
      codes.push(r.status);
    }
    assertEqual(codes.join(','), '401,401,401,401,401', '前 5 次失败都应是 401');

    const locked = await request(port, 'POST', '/api/key/unlock', { body: { passphrase: 'WrongPassX' } });
    assertEqual(locked.status, 429, '第 6 次应被失败锁挡住（429）');

    const correctWhileLocked = await request(port, 'POST', '/api/key/unlock', {
      body: { passphrase: PASSPHRASE },
    });
    /**
     * 正确口令也挡 —— 这一条容易被写成"口令对了就放行"（看起来更友好），
     * 但那等于锁形同虚设：爆破者只要在锁定窗口里塞一次正确口令就继续试，
     * 而"锁定"本来就是为了让爆破速率与 scrypt 成本解耦。
     */
    assertEqual(correctWhileLocked.status, 429, '锁定期内正确口令也必须被挡');
    assertEqual(keyring.isUnlocked(), true, '前置状态未被这次失败带偏（此前已解锁）');
  });
});
