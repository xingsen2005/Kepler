/**
 * 第 69 轮护栏 —— 《安全漏洞分析报告》（2026-10-20，基准 v1.9.4 @ 18ad77e）修复项
 *
 * 报告列了 2 高危 / 5 中危 / 12 低危 / 22 提示级。本文件覆盖**有行为判据**的那些，
 * 逐条落护栏；纯产品取舍或需要大规模功能扩建的（如 I-3 票据过期、I-8 WebAuthn、
 * I-10 会话空闲超时）不在本文件，处理结论见报告「九、处理记录」。
 *
 * ## 编排上的两个刻意选择
 *
 * ① **本文件把 `HOST` 设成 `0.0.0.0`** —— 只有部署模式（`IS_DEPLOY`）才会启用
 *    安装令牌。H-2 的缺口恰恰**只在部署形态下成立**，在回环模式里测它等于没测。
 * ② **`TRUST_PROXY=1` + `TRUST_PROXY_HOPS=1`** —— M-4 修的就是「追加式 XFF」这条链路，
 *    不打开代理信任就永远走不到按跳数剥取那一支。
 *
 * ⚠️ 配置与用户会真实落盘，所以 `S3_DATA_DIR` 必须在 require 之前指到临时目录。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('r69-');
process.env.S3_DATA_DIR = tmp.dir;
process.env.HOST = '0.0.0.0';        // 部署模式：见文件头 ①
process.env.TRUST_PROXY = '1';       // 见文件头 ②
process.env.TRUST_PROXY_HOPS = '1';

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const readSrc = (abs) => fs.readFileSync(abs, 'utf8');

const express = require(path.join(ROOT, 'node_modules', 'express'));
const security = require(SERVER('security.js'));
const configStore = require(SERVER('config-store.js'));
const couponStore = require(SERVER('coupon-store.js'));
const gateway = require(SERVER('payment-gateway.js'));
const dataDir = require(SERVER('data-dir.js'));

const authRoutes = require(SERVER('routes', 'auth.js'));
const userRoutes = require(SERVER('routes', 'users.js'));

/**
 * R94（审核 M01-02）：`setupTokenMatches()` 改成**只读不生成**（原先它会调
 * `ensureSetupToken()`，于是初始化完成后任何一次匿名 `POST /auth/init` 都能让
 * `data/setup-token.txt` 复活并再打印一次）。生成点于是只剩生产启动路径
 * `server/index.js` 里那句 `primeSetupToken()`；本文件是直接挂路由的，必须自己
 * 补上这一步，否则临时数据目录里永远没有令牌文件。
 */
authRoutes.primeSetupToken();

const PASSWORD = 'Unit!2026abc';

/* ================================================================== *
 * 极简 HTTP 客户端（只挂 auth / users 两条路由）
 * ================================================================== */

let server = null;
let port = 0;
let ipSeq = 0;

function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}

async function api(method, urlPath, { ip, body, as } = {}) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const raw = req.headers['x-test-auth'];
      if (raw) { req.authUser = JSON.parse(raw); req.sessionToken = 'test-session-token'; }
      next();
    });
    app.use('/api', authRoutes);
    app.use('/api', userRoutes);
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
    label: 'r69-',
    flushers: [{ name: 'config-store', flush: () => configStore.flush() }],
  });
});

/* ================================================================== *
 * H-1：浏览器端不再保存密码
 * ================================================================== */

test('R69-01 · 前端「记住密码」已彻底移除：localStorage 只留用户名', () => {
  const main = readSrc(path.join(PUBLIC('js', 'main.js')));
  // 可还原密码的三件套（密钥、密文、异或）必须一件不剩
  for (const dead of ['xorBytes', 'b64ToBytes', 'bytesToB64', 'rememberPassword', 'REMEMBER_MODE.PASSWORD']) {
    assertEqual(main.indexOf(dead), -1, `main.js 里不应再出现 ${dead}（密码以可还原形态驻留客户端）`);
  }
  assert(main.indexOf('REMEMBER_MODE.USERNAME') >= 0, '必须保留「记住用户名」这一档');
  // 登录页回填处必须显式清空密码框 —— 否则浏览器自动填充之外还有一条自家回填路径
  assertMatch(main, /pwInput\.value = '';/, '登录遮罩打开时必须清空密码框');
});

test('R69-02 · 登录页文案如实说明「不保存密码」', () => {
  const html = readSrc(PUBLIC('index.html'));
  assert(html.indexOf('记住用户名') >= 0, '勾选框文案应为「记住用户名」');
  assert(html.indexOf('记住密码') === -1, '页面上不应再出现「记住密码」字样');
  assert(html.indexOf('不保存密码') >= 0, '必须明确告知用户不保存密码');
});

/* ================================================================== *
 * H-2：部署模式下 /auth/init 需要安装令牌
 * ================================================================== */

test('R69-03 · 部署模式：未初始化时告知需要安装令牌，且响应里不含令牌本身', async () => {
  assertEqual(security.IS_DEPLOY, true, '前置：本文件必须跑在部署模式（HOST=0.0.0.0）');
  const r = await api('GET', '/api/auth/me');
  assertEqual(r.status, 200, `GET /auth/me 应 200（实际 ${r.status}）`);
  assertEqual(r.json.initialized, false, '前置：临时数据目录里应当还没有用户');
  assertEqual(r.json.setupTokenRequired, true, '部署模式必须告知前端需要安装令牌');
  assert(String(r.json.setupHint || '').indexOf('安装令牌') >= 0, '提示里应说明令牌在哪里找');
  // 令牌本身绝不能出现在任何 HTTP 响应里
  assert(!/[0-9a-f]{32}/.test(String(r.json.setupHint || '')), '提示文案不得携带令牌');
});

test('R69-04 · 部署模式：无令牌 / 错令牌的初始化一律 403，且不创建任何账户', async () => {
  const before = configStore.listUsers().length;
  const r1 = await api('POST', '/api/auth/init', { body: { username: 'evil', password: PASSWORD } });
  assertEqual(r1.status, 403, `无令牌必须 403（实际 ${r1.status}）`);
  const r2 = await api('POST', '/api/auth/init', { body: { username: 'evil', password: PASSWORD, setupToken: 'deadbeef' } });
  assertEqual(r2.status, 403, `错令牌必须 403（实际 ${r2.status}）`);
  assertEqual(configStore.listUsers().length, before, '被拒的初始化不得留下账户');
  const tokenFile = path.join(dataDir.dataDir(), 'setup-token.txt');
  assert(fs.existsSync(tokenFile), '令牌应已落盘到 data/setup-token.txt');
});

test('R69-05 · 部署模式：正确令牌可完成初始化，且令牌是一次性的（用后即删）', async () => {
  const tokenFile = path.join(dataDir.dataDir(), 'setup-token.txt');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assertMatch(token, /^[0-9a-f]{32}$/, '令牌应为 16 字节 hex');

  const r = await api('POST', '/api/auth/init', { body: { username: 'owner', password: PASSWORD, setupToken: token } });
  assertEqual(r.status, 200, `带正确令牌应能初始化（实际 ${r.status} ${JSON.stringify(r.json)}）`);
  assertEqual(configStore.listUsers().length, 1, '应当只建出一个账户（R71 起空库的第一个账户是根用户）');
  assertEqual(fs.existsSync(tokenFile), false, '初始化成功后令牌文件必须删除（一次性）');

  // 再拿同一枚令牌重放：系统已初始化，无论如何都不该再建号
  const again = await api('POST', '/api/auth/init', { body: { username: 'evil', password: PASSWORD, setupToken: token } });
  assert(again.status === 403 || again.status === 409, `重放应被拒（实际 ${again.status}）`);
  assertEqual(configStore.listUsers().length, 1, '重放不得新增账户');
});

/* ================================================================== *
 * M-2：用户名不得与邮箱空间重叠
 * ================================================================== */

test('R69-06 · 用户名拒绝 @（不能再冒充别人的邮箱）', async () => {
  let threw = null;
  try {
    await configStore.addUser({ username: 'victim@example.com', password: PASSWORD, role: 'user' });
  } catch (e) { threw = e; }
  assert(threw, '含 @ 的用户名必须被拒绝');
  assertEqual(threw.status, 400, `应为 400 而不是 ${threw.status}`);
  assertMatch(String(threw.message), /不能包含 @/);
});

test('R69-07 · findUserByIdentifier：含 @ 时按邮箱查，其余按用户名查', async () => {
  await configStore.addUser({ username: 'mailer', password: PASSWORD, role: 'user', email: 'mailer@example.com' });
  await configStore.addUser({ username: 'plainuser', password: PASSWORD, role: 'user' });

  const byMail = configStore.findUserByIdentifier('mailer@example.com');
  assertEqual(byMail && byMail.username, 'mailer', '含 @ 的标识必须命中邮箱');
  const byName = configStore.findUserByIdentifier('mailer');
  assertEqual(byName && byName.username, 'mailer', '不含 @ 的标识按用户名命中');
  assertEqual(configStore.findUserByIdentifier('nobody@example.com'), null, '不存在的邮箱应为 null');
});

/* ================================================================== *
 * M-3：scrypt 参数提升 + 旧哈希不被锁死
 * ================================================================== */

test('R69-08 · scrypt 成本参数提升到 N=131072，且该参数真的参与了哈希', async () => {
  assertEqual(configStore.SCRYPT_PARAMS.N, 131072, '新哈希必须用 N=131072（OWASP 下限）');
  assertEqual(configStore.SCRYPT_PARAMS.r, 8);
  assertEqual(configStore.SCRYPT_PARAMS.p, 1);
  const salt = 'cd'.repeat(16);
  const a = await configStore.scryptHex(PASSWORD, salt, configStore.SCRYPT_PARAMS);
  const b = await configStore.scryptHex(PASSWORD, salt, { N: 16384, r: 8, p: 1 });
  assert(a.length === 64 && b.length === 64, '哈希应为 32 字节（hex 64 位）');
  assert(a !== b, '参数必须真的进算法 —— 若两者相同，说明 maxmem/N 根本没被用上');
});

test('R69-09 · 旧参数（N=16384）的哈希仍能验过 —— 升级不得把存量用户锁在门外', async () => {
  const salt = 'ab'.repeat(16);
  // 用**旧参数**手工造一枚哈希（等价于升级前落盘的那些记录）
  const legacy = await configStore.scryptHex(PASSWORD, salt, { N: 16384, r: 8, p: 1 });
  assertEqual(
    configStore.normalizeScryptParams(undefined).N, 16384,
    '没有 passwordParams 的历史记录必须按旧参数解释',
  );
  assertEqual(
    await configStore.verifyPassword(PASSWORD, legacy, salt, configStore.normalizeScryptParams(undefined)),
    true,
    '旧哈希用旧参数必须验得过（否则升级即等于全员锁死）',
  );
  assertEqual(
    await configStore.verifyPassword(PASSWORD, legacy, salt, configStore.SCRYPT_PARAMS),
    false,
    '旧哈希不能用新参数验（参数是哈希的一部分，不能猜）',
  );
});

test('R69-10 · 新建用户落盘 passwordParams，供日后按参数验', async () => {
  const u = await configStore.addUser({ username: 'scryptuser', password: PASSWORD, role: 'user' });
  assertEqual(u.passwordHash, undefined, '用户视图不得含 passwordHash');
  const live = configStore.findUserRawById(u.id);
  assert(live, '前置：应能按 id 取到原始记录');
  assertEqual(live.passwordParams && live.passwordParams.N, 131072,
    '落盘记录必须带 passwordParams（否则升级后无法区分新旧哈希）');
});

/* ================================================================== *
 * L-5：口令策略
 * ================================================================== */

test('R69-11 · 口令策略：8 位下限、弱口令黑名单、纯重复字符', async () => {
  const tries = [
    ['Abc12!', '少于 8 位'],
    ['password', '常见弱口令'],
    ['aaaaaaaa', '同一个字符重复'],
    ['12345678', '连续数字（弱口令表）'],
  ];
  for (const [pw, why] of tries) {
    let threw = null;
    try { await configStore.addUser({ username: `pol${Math.random().toString(16).slice(2, 8)}`, password: pw, role: 'user' }); } catch (e) { threw = e; }
    assert(threw, `口令「${pw}」应被拒绝（${why}）`);
    assertEqual(threw.status, 400, `口令不合规应 400（实际 ${threw.status}）`);
  }
  const ok = await configStore.addUser({ username: 'policyok', password: 'Kx9!wq2Z', role: 'user' });
  assert(ok && ok.id, '合规口令必须能建号');
});

/* ================================================================== *
 * L-7：permissions 不参与鉴权 ⇒ 非空必须被拒
 * ================================================================== */

test('R69-12 · 非空 permissions 被 400 拒绝（不给「已限制」的错觉）', async () => {
  /**
   * R71 起 `/auth/init` 建出的**是根用户**（不是管理员），故这里按「管理层」取账户、
   * 并原样回填它真实的角色 —— 冒充成 `admin` 会让下面的「新建普通用户」虽然仍能过，
   * 但用例就不再代表真实身份了（真正的根用户在界面上是能建管理员的）。
   */
  const admin = configStore.listUsers().find((u) => u.role === 'admin' || u.role === 'root');
  assert(admin, '前置：R69-05 已建出管理层账户');
  const asActor = { id: admin.id, username: admin.username, role: admin.role, permissions: {} };
  const r = await api('POST', '/api/users', {
    as: asActor,
    body: { username: 'permuser', password: PASSWORD, role: 'user', permissions: { canDelete: true } },
  });
  assertEqual(r.status, 400, `非空 permissions 必须 400（实际 ${r.status}）`);
  assertMatch(String(r.json.error || ''), /permissions/);
  assertEqual(configStore.listUsers().some((u) => u.username === 'permuser'), false, '被拒的请求不得留下用户');

  // 空对象是历史默认值，必须放行
  const ok = await api('POST', '/api/users', {
    as: asActor,
    body: { username: 'permok', password: PASSWORD, role: 'user', permissions: {} },
  });
  assertEqual(ok.status, 200, `空 permissions 应放行（实际 ${ok.status} ${JSON.stringify(ok.json)}）`);
});

/* ================================================================== *
 * L-4：注册冲突的全局预算
 * ================================================================== */

test('R69-13 · 注册冲突预算：全站 30 次/10 分钟封顶，第 31 次起不再区分「存在与否」', () => {
  const lim = security.registerConflictLimiter;
  const key = security.REGISTER_CONFLICT_KEY;
  assertEqual(typeof lim, 'function', '必须存在跨 IP 的注册冲突预算');
  for (let i = 0; i < 30; i++) {
    assertEqual(lim(key).ok, true, `第 ${i + 1} 次冲突答案应放行`);
  }
  assertEqual(lim(key).ok, false, '第 31 次冲突答案必须被预算拦下（否则等于无限枚举）');
});

test('R69-14 · 注册路由真的把「用户名已存在」接进了预算', () => {
  const src = readSrc(SERVER('routes', 'auth.js'));
  assert(src.indexOf('security.registerConflictLimiter(security.REGISTER_CONFLICT_KEY)') >= 0,
    'auth.js 必须调用共享预算（只加限流器不接线等于没修）');
  assertMatch(src, /用户名已存在/, '判据应落在「用户名已存在」这条 409 上');
});

/* ================================================================== *
 * L-6：跨 IP 的账户级减速
 * ================================================================== */

test('R69-15 · 账户级减速：前 20 次不拖，之后线性增长并封顶 1.5 秒', () => {
  const user = 'delayed-user';
  for (let i = 0; i < 20; i++) {
    security.noteAccountFail(user);
    assertEqual(security.accountFailDelayMs(user), 0, `第 ${i + 1} 次失败不该有延迟`);
  }
  security.noteAccountFail(user);
  const d1 = security.accountFailDelayMs(user);
  assert(d1 > 0, '第 21 次失败开始必须减速');
  assert(d1 <= 1500, '减速上限 1.5 秒');
  for (let i = 0; i < 100; i++) security.noteAccountFail(user);
  assertEqual(security.accountFailDelayMs(user), 1500, '大量失败后应封顶在 1.5 秒');
  security.resetAccountFail(user);
  assertEqual(security.accountFailDelayMs(user), 0, '成功后必须清零');
});

/* ================================================================== *
 * M-4：XFF 按跳数剥取
 * ================================================================== */

test('R69-16 · TRUST_PROXY_HOPS=1 取最后一段；伪造成首段的地址不再被采信', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } };
  assertEqual(security.forwardedClientIp(req), '5.6.7.8',
    '追加式链路下离自己最近的一跳在末尾 —— 取首段等于让请求方自选 IP');
  // 末尾不合法 ⇒ 不采信（不能悄悄退回首段，那正是攻击者写的位置）
  assertEqual(security.forwardedClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, not-an-ip' } }), '',
    '末尾不是合法 IP 时应退回空串，而不是采信请求方伪造的首段');
});

/* ================================================================== *
 * L-8：限流表有硬上限
 * ================================================================== */

test('R69-17 · 限流器 hits 表达上限后淘汰最旧键（IPv6 慢速内存 DoS）', () => {
  const lim = security.createLimiter({ name: 'r69-cap', windowMs: 60 * 1000, max: 1, maxEntries: 2 });
  assertEqual(lim('a').ok, true);
  assertEqual(lim('b').ok, true);
  assertEqual(lim('c').ok, true);            // 触发淘汰：'a' 被丢
  assertEqual(lim('a').ok, true,
    '被淘汰的键应重新从 1 计数 —— 若这里 false，说明上限没有生效（旧键一直留着）');
});

/* ================================================================== *
 * L-10：Secure 与 TLS 实际可用性对齐（接线）
 * ================================================================== */

test('R69-18 · Secure Cookie 判据接入「TLS 实际可用」这一事实', () => {
  assertEqual(typeof security.setTlsAvailable, 'function', 'security 必须暴露 setTlsAvailable');
  const idx = readSrc(SERVER('index.js'));
  assertMatch(idx, /security\.setTlsAvailable\(Boolean\(TLS\.ok\)\)/,
    'index.js 必须把 loadTlsCert() 的真实结果回填给 security');
});

/* ================================================================== *
 * M-1：PayPal 回调必须验签
 * ================================================================== */

test('R69-19 · 未配置 webhookId 时 PayPal 验签直接失败（不再零验签放行）', async () => {
  let threw = null;
  try {
    await gateway.paypalVerifyWebhook({ mode: 'sandbox' }, {}, { event_type: 'CHECKOUT.ORDER.APPROVED' });
  } catch (e) { threw = e; }
  assert(threw, '缺 webhookId 必须抛错 —— 旧实现是 `return { ok: true }`');
  assertMatch(String(threw.message || ''), /webhookId|Webhook/i);

  const src = readSrc(SERVER('share-routes.js'));
  assertMatch(src, /await verifyNotified\(platform, req\)/,
    '通知入口必须 await 验签结果（不 await 等于永远拿到一个 Promise，恒真）');
  assertEqual(src.indexOf('return { ok: true }; // PayPal'), -1, '旧的零验签分支必须消失');
});

/* ================================================================== *
 * I-5：查单金额对账
 * ================================================================== */

test('R69-20 · 微信查单金额与订单不符时不认账（付 1 分钱拿不走 1 元的单）', async () => {
  // 微信请求要先在本地签名，所以必须给一对真密钥（与 payment-gateway.test.js 同款）
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cfg = { appId: 'wx-app', mchId: 'mch-1', privateKey, certSerialNo: 'S' };
  const realFetch = global.fetch;
  const order = { id: 'ORD-AMT', amountFen: 100 };

  const stub = (total) => async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      trade_state: 'SUCCESS', transaction_id: 'wx-1',
      amount: { total, currency: 'CNY' },
    }),
  });

  try {
    global.fetch = stub(1); // 实付 1 分
    const bad = await gateway.queryCharge('wechat', cfg, order);
    assertEqual(bad.paid, false, '金额不符绝不能判为已支付');
    assertMatch(String(bad.failReason || ''), /金额/);

    global.fetch = stub(100); // 实付 1 元
    const good = await gateway.queryCharge('wechat', cfg, order);
    assertEqual(good.paid, true, `金额一致应正常认账（实际 ${JSON.stringify(good)}）`);
  } finally {
    global.fetch = realFetch;
  }
});

/* ================================================================== *
 * L-1：优惠券「每人一次」不被 200 条台账截断击穿
 * ================================================================== */

test('R69-21 · 台账被截断后，最早那位用户仍不能第二次用同一张券', () => {
  const [c] = couponStore.generate({
    count: 1, type: 'all', amountFen: 100, maxUses: 0, perUserOnce: true, createdBy: 'test',
  });
  const first = 'user-1';
  // ⚠️ 顺序是判据的一部分：**先**让第一个身份用完，再灌满台账把它挤出 `uses`。
  // 反过来（先灌满再让第一个用）它恰好落在最后 200 条里，永远测不到截断。
  couponStore.consume({ couponId: c.id, identity: first, orderId: 'ord-first' });
  for (let i = 0; i < 205; i++) {
    couponStore.consume({ couponId: c.id, identity: `user-${i + 10}`, orderId: `ord-${i}` });
  }

  const use = (identity) => couponStore.validateForUse({
    code: c.code,
    link: { id: 'link-1', paid: { amountFen: 1000 } },
    identity,
    userId: '',
  });

  assertEqual(use(first).ok, false, '第一个身份被台账截断后仍须判为已用');
  assertEqual(use(first).reason, 'already_used');
  assertEqual(use('user-999').ok, true, '没用过的身份必须放行');
});

/* ================================================================== *
 * L-12 / I-4 / I-17 / L-11 / L-2：接线与顺序（源码层，行为面太重）
 * ================================================================== */

test('R69-22 · 冲突探测只在「确认不存在」时放行（403/5xx/网络一律 fail-closed）', () => {
  const src = readSrc(SERVER('routes', 'fs.js'));
  assertMatch(src, /function isNotFoundError\(e\)/,
    '必须有一条「确认不存在」的唯一判据');
  assertMatch(src, /if \(!isNotFoundError\(e\)\) \{/,
    'assertNoConflict 必须对非 404 一路 fail-closed');
  assertMatch(src, /if \(isNotFoundError\(e\)\) return false;/,
    'existsKey（复制冲突探测）同样只能在 404 时返回 false');
  assertEqual(src.indexOf('} catch (e) {\n    return false;'), -1,
    '「任何异常都当不存在」的旧写法必须消失（它让覆写变得静默）');

  /**
   * 判据必须落在**实际被执行的那一层**：把源文件里那个函数的原文切出来执行。
   * 只查「源码里有 isNotFoundError」挡不住「函数体被改成 `return true`」这类退化
   * —— 那种改法下上面三条断言全绿，而行为已经退回到 fail-open。
   */
  const start = src.indexOf('function isNotFoundError(e) {');
  const end = src.indexOf('\n}\n', start);
  assert(start >= 0 && end > start, '前置：应能切出函数原文');
  const body = src.slice(start, end + 3);
  const fn = new Function(`${body}; return isNotFoundError;`)();
  assertEqual(fn({ statusCode: 404 }), true, '404 是「确认不存在」');
  assertEqual(fn({ status: 404 }), true, '有的封装只带 status');
  assertEqual(fn({ code: 'NoSuchKey' }), true, 'NoSuchKey 是「确认不存在」');
  assertEqual(fn({ statusCode: 403, code: 'AccessDenied' }), false, '403 不是「不存在」的证据');
  assertEqual(fn({ statusCode: 500 }), false, '5xx 不是「不存在」的证据');
  assertEqual(fn({ code: 'ECONNRESET' }), false, '网络错误不是「不存在」的证据');
});

test('R69-23 · 支付通知的 256KB 上限挂在全局解析器之前（否则又是一句死代码）', () => {
  const src = readSrc(SERVER('index.js'));
  const small = src.indexOf("express.json({ limit: '256kb' })");
  const big = src.indexOf("express.json({ limit: '2mb' })");
  assert(small >= 0 && big >= 0, '两个解析器都应存在');
  assert(small < big, '256KB 解析器必须**先**挂载，否则 2MB 那个会把 body 先吃掉');
  assertMatch(src, /NOTIFY_PATH_RE = \/\^\\\/pay\\\/notify\\\/\//, '判据应指向 /pay/notify/ 路径');
  assert(src.indexOf('NOTIFY_BODY_LIMIT_PARSER(req, res, next);') >= 0,
    '光声明解析器不够 —— 必须在中间件里真的调用它（声明了不调用又是死代码）');
});

test('R69-24 · Node 二进制包在解压前校验 SHA-256（L-11）', () => {
  const src = readSrc(path.join(ROOT, 'deploy.sh'));
  // 用不含 `${…}` 的前缀定位（避免 lint 的 no-template-curly-in-string 误报）
  const verify = src.indexOf('verify_node_tarball "');
  const extract = src.indexOf('run tar -xzf "');
  assert(verify >= 0, '必须调用 verify_node_tarball');
  assert(extract >= 0, '前置：解压那一行还在');
  assert(verify < extract, '校验必须发生在解压（把内容写进 /usr/local）之前');
  assertMatch(src, /SHASUMS256\.txt/, '判据应基于官方 SHASUMS256.txt');
  assertMatch(src, /\$2 == n \{ print \$1; exit \}/,
    '必须按 tarball 文件名从校验单里取对应那一行的哈希（整份校验单里有很多平台）');
});

test('R69-25 · restore-guard 的淘汰顺序真正等于「最久未活动」', () => {
  const src = readSrc(SERVER('restore-guard.js'));
  const del = src.indexOf('  counters.delete(key);\n  counters.set(key, { fails, lastAt: now });');
  assert(del >= 0, '必须先 delete 再 set（只 set 不会移动 Map 的插入位置）');
});

test('R69-26 · 分享页两个入口都用同一枚限流器，且「查表之前」就限流（L-2）', () => {
  const src = readSrc(SERVER('share-routes.js'));
  const hits = src.split('security.shareViewLimiter(security.clientIp(req))').length - 1;
  assert(hits >= 2, `GET /s/:id 与 HEAD /s/:id/dl 都必须限流（实际出现 ${hits} 次）`);
  const getHandler = src.indexOf("router.get('/s/:id', async (req, res) => {");
  assert(getHandler >= 0, '前置：GET /s/:id 还在');
  const limiterAt = src.indexOf('security.shareViewLimiter', getHandler);
  const lookupAt = src.indexOf('shareStore.get(req.params.id)', getHandler);
  assert(limiterAt > getHandler && limiterAt < lookupAt,
    '限流必须早于 shareStore.get —— 否则「不存在的 ID」这条最容易被扫的路径不计数');
});
