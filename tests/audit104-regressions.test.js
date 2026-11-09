/**
 * 第 104 轮护栏 —— 《Kepler v2.1.3 安全审计报告》六条成立项的回归验证
 * ============================================================================
 *
 * 报告 `Security_Audit.md` 给出 F-01 ~ F-06 六条（另有一条「信息」级部署加固项与
 * 一条被它自己证伪的 P1，二者进 `Audit_illusion_report.md`，不在本文件）。六条**全部成立**：
 *
 *  · F-01 锁定态读盘污染 —— R97 只修了下半句（`readJson` 认清 `KEYRING_LOCKED`），
 *    上半句（10 个调用点不得把它当「文件坏了」缓存空表）全都没跟上。启动任务不判
 *    `r.ok`，于是「不设 env 主口令的普通重启」必然走到这条路上。
 *  · F-02 支付宝同步响应「验签对象 ≠ 业务对象」—— `JSON.parse` 取最后一个同名键、
 *    `indexOf` 取第一个，一份真签名可以让伪造的 `TRADE_SUCCESS` 通过。
 *  · F-03 `captchaHosts()` 无条件采信请求 `Host`，把 R94 的 hostname 核对整条架空。
 *  · F-04 `passwordSet()` fail-closed 而 `checkPassword()` fail-open（设置读不出来时
 *    任意口令可换令牌）。
 *  · F-05 `backup.apply()` 只 `await flush()`，不知道写盘其实失败了。
 *  · F-06 `reconcile()` 不在轮转互斥里，并发解锁可能删掉轮转意图日志。
 *
 * ## 判据落在「实际被执行的那一层」
 *
 *  · F-01 落在**真实文件 + 真实重启**：先用真 keyring 写四个数据文件，再清 require
 *    缓存模拟重启（不设 env 主口令 ⇒ 锁定），跑一遍启动路径的读，再解锁、再写，
 *    最后**再重启一次**核对磁盘内容 —— 只断言「锁定态没抛错」会假绿。
 *  · F-02 落在 `queryCharge()` 的**返回值**上（本地网关桩 + 真 RSA 签名），
 *    外加切片纯函数的三个边界（重复键 / 字符串值里的同名键 / 嵌套同名键）。
 *  · F-03 落在**真实登录路由**：桩只换 `captchaNative.guard`（外部边界），
 *    断言它收到的 `expectedHosts` —— 直接断言源码里「有没有 isOwnSiteHost」弱得多。
 *  · F-04 落在**真的坏文件**上（写一份非法 JSON 的 enc-settings.json）。
 *  · F-05 落在**真的写盘失败**上（把 `atomic.writeAtomic` 换成对 config.enc 抛错）。
 *  · F-06 落在互斥**内部**调用 `reconcile()`，并附一条「不在互斥里就会删意图」的对照。
 *
 * ## 隔离
 *
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**；每个用例独占临时目录 +
 * 清 server 缓存（`keyring` 的解锁态是模块级，不清缓存就造不出「重启后锁定」）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  assert, assertEqual, ROOT, makeTempDir, cleanupTempDir, request,
} = require('./helpers.js');

/** 站点域名必须在 require security.js **之前**落定（captchaHosts 用它构造允许集） */
process.env.SITE_DOMAIN = 'kepler.example.com';

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个用例独占一个数据目录；`slot` 只是 require 之前占位用的 */
const slot = makeTempDir('r104-slot-');
process.env.S3_DATA_DIR = slot.dir;

function clearServerCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'server'))) delete require.cache[k];
  }
}

/** 「重启进程」：清掉全部 server 模块缓存（模块级解锁态、缓存表、失败标志都会归零） */
function boot() {
  clearServerCache();
  return {
    keyring: require(SERVER('keyring.js')),
    configStore: require(SERVER('config-store.js')),
    secureStore: require(SERVER('secure-store.js')),
    shareStore: require(SERVER('share-store.js')),
    uploadSessions: require(SERVER('upload-sessions.js')),
    ipGuard: require(SERVER('ip-guard.js')),
    encStore: require(SERVER('enc-store.js')),
  };
}

/** 在独占目录里跑一个用例：设目录 → 清缓存 → 跑 → 收尾还原目录 */
async function withDir(label, fn) {
  const dir = makeTempDir(`r104-${label}-`);
  const prev = process.env.S3_DATA_DIR;
  process.env.S3_DATA_DIR = dir.dir;
  try {
    clearServerCache();
    return await fn(dir.dir);
  } finally {
    process.env.S3_DATA_DIR = prev;
    await wait(50);
    await cleanupTempDir(dir.dir, { label: `r104-${label}-` });
  }
}

/* ================================================================== *
 * F-01 · 锁定态读盘不得污染任何缓存
 * ================================================================== */

const PW = 'MasterPass-104';

/** 建一个「启用信封加密 + 有根用户」的实例，并把四个 store 各写一条真实数据 */
async function seed(dir) {
  delete process.env[require(SERVER('keyring.js')).ENV_PASSPHRASE];
  let m = boot();
  await m.keyring.create(PW);
  await m.configStore.addUser({ username: 'root', password: 'RootPass-104', role: 'root' });
  m.configStore.flushPending();
  await wait(200);
  m.configStore.getMasterKey(); // 触发一次读，确认可解密

  const link = await m.shareStore.create({
    key: 'r104/a.txt', bucket: 'b1', region: 'ap-guangzhou',
    fileName: 'a.txt', size: 10, expiresHours: 0, maxDownloads: 0,
    password: null, createdBy: 'tester',
  });
  await m.shareStore.flush();

  const sess = m.uploadSessions.create({
    uploadId: 'up-104', key: 'r104/big.bin', bucket: 'b1', region: 'ap-guangzhou',
    size: 1024, chunkSize: 512, createdBy: 'tester', ownerId: 'u-root',
  });
  m.uploadSessions.flush();
  await m.secureStore.flush();

  m.ipGuard.addRule({ target: '203.0.113.9', kind: 'block', remark: 'R104 样本' });

  await m.encStore.updateSettings({ mode: 'magic' });
  m.encStore.setMeta('b1', 'r104/a.txt', {
    mode: 'magic', origSize: 10, salt: '00'.repeat(16),
  });
  m.encStore.flushMeta();

  await wait(120);
  m = boot(); // 用一个全新模块集合核对「真的写下去了」
  for (const f of ['links.json', 'upload-sessions.json', 'ipguard.json', 'enc-settings.json', 'enc-meta.json']) {
    assert(fs.existsSync(path.join(dir, f)), `前置：${f} 必须已落盘（否则本用例证明不了覆盖）`);
  }
  return { linkId: link.id, sessionId: sess.id, mode: m.encStore.currentMode(), unlocked: m.keyring.isUnlocked() };
}

test('R104-01 · F-01 · 锁定态读盘（启动路径）不得把空表钉进缓存：解锁后数据必须还在', async () => {
  await withDir('lock', async (dir) => {
    await seed(dir);

    /**
     * 模拟「不设 KEPLER_MASTER_PASSPHRASE 的普通重启」：模块全新加载 ⇒ 进程锁定。
     * 这正是 README §功能特性 写明的默认形态，也是报告里 F-01 的触发前提。
     */
    let m = boot();
    assertEqual(m.keyring.exists(), true, '前置：keyring.json 在磁盘上');
    assertEqual(m.keyring.isUnlocked(), false, '前置：没设 env 主口令 ⇒ 必须是锁定态');

    // ① 启动路径的清扫（`index.js` 的 bootUnlock.then → pruneSessions）在锁定态下跑一遍
    m.uploadSessions.prune(() => null);

    // ② 锁定态下的四处读：全部只该「借出空表」，一张也不许缓存
    assertEqual(m.shareStore.list().length, 0, '锁定态读不到分享表（借出空表）');
    assertEqual(m.uploadSessions.list().length, 0, '锁定态读不到会话表（借出空表）');
    assertEqual(m.ipGuard.listRules().length, 0, '锁定态读不到 IP 规则（借出空表）');
    assertEqual(m.encStore.currentMode(), 'none', '锁定态读到的是默认设置（但不得缓存）');
    assertEqual(m.encStore.getMeta('b1', 'r104/a.txt'), null, '锁定态读不到元数据（借出空表）');
    assertEqual(m.shareStore.get('whatever'), null, '锁定态的 get() 必须是 null 而不是抛错');

    // ③ 让锁定态排下的去抖写全部到点（旧实现在这里把空表写进磁盘）
    await wait(450);

    // ④ 解锁：此后任何一次读都必须重新落到磁盘
    await m.keyring.unlock(PW);
    assertEqual(m.shareStore.list().length, 1,
      '★解锁后分享链接必须还在（旧实现缓存了 {links:[]}，解锁后仍是 0 条，下一次写入就整份覆盖）');
    assertEqual(m.uploadSessions.list().length, 1,
      '★解锁后上传会话必须还在（丢了就意味分片 IV/TAG 全失，已传分片永久不可解）');
    assertEqual(m.ipGuard.listRules().length, 1,
      '★解锁后 IP 黑名单必须还在（它是本条里最具安全属性的后果）');
    assertEqual(m.encStore.currentMode(), 'magic',
      '★解锁后加密方式必须还是 magic（旧实现缓存了 defaultSettings()，新上传会明文落云）');
    assert(m.encStore.getMeta('b1', 'r104/a.txt') !== null,
      '★解锁后加密元数据必须可读（它是解密的唯一凭据）');
    assertEqual(m.encStore.metaIsCorrupt(), false,
      '★锁定态不是损坏：metaCorrupt 不得被置真（否则本进程永久拒写元数据）');
    assertEqual(m.encStore.passwordSet(), false,
      '★解锁后必须回到「设置可读」：未设查看密码 ⇒ passwordSet() 为 false'
      + '（旧实现会把 settingsUnavailable 一直留着 ⇒ 永远要求密码、写路径永远 503）');

    // ⑤ 解锁后再写一次，然后**再重启**核对磁盘：证明上一轮没有被空表覆盖
    await m.shareStore.create({
      key: 'r104/c.txt', bucket: 'b1', region: 'ap-guangzhou',
      fileName: 'c.txt', size: 3, expiresHours: 0, maxDownloads: 0,
      password: null, createdBy: 'tester',
    });
    await m.shareStore.flush();
    m.uploadSessions.create({
      uploadId: 'up-104b', key: 'r104/big2.bin', bucket: 'b1', region: 'ap-guangzhou',
      size: 512, chunkSize: 512, createdBy: 'tester', ownerId: 'u-root',
    });
    m.uploadSessions.flush();
    await m.secureStore.flush();
    m.ipGuard.addRule({ target: '203.0.113.10', kind: 'block' });
    await wait(250);

    m = boot();
    await m.keyring.unlock(PW);
    assertEqual(m.shareStore.list().length, 2, '★重启后分享表仍是 2 条（旧数据 + 新数据，一条都没丢）');
    assertEqual(m.uploadSessions.list().length, 2, '★重启后会话表仍是 2 条');
    assertEqual(m.ipGuard.listRules().length, 2, '★重启后 IP 规则仍是 2 条');
    assertEqual(m.encStore.currentMode(), 'magic', '★重启后加密方式仍是 magic');
  });
});

/* ================================================================== *
 * F-02 · 支付宝同步响应：验签对象必须等于业务对象
 * ================================================================== */

const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const signNode = (content) => crypto.createSign('RSA-SHA256').update(content, 'utf8')
  .sign(KEY_PAIR.privateKey, 'base64');

const REAL_NODE = '{"code":"40004","sub_code":"ACQ.TRADE_NOT_EXIST","msg":"交易不存在"}';
const FAKE_NODE = '{"code":"10000","trade_status":"TRADE_SUCCESS","total_amount":"5.00","trade_no":"T-FAKE"}';

async function gatewayStub(body, status = 200) {
  const s = http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: s.address().port,
    close: () => new Promise((r) => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close(r);
    }),
  };
}

const alipayCfg = (port) => ({
  appId: '2021000000000000', privateKey: PKCS8_PEM, signType: 'RSA2',
  alipayPublicKey: SPKI_PEM,
  gateway: `http://127.0.0.1:${port}/gateway.do`,
});

test('R104-02 · F-02 · 同一响应出现两个业务节点必须被拒（真签名不得给伪造节点背书）', async () => {
  const pg = require(SERVER('payment-gateway.js'));

  /* ① 纯函数：重复键 ⇒ 切不出内容（count = 2） */
  const dup = `{"alipay_trade_query_response":${REAL_NODE},"sign":"x","alipay_trade_query_response":${FAKE_NODE}}`;
  assertEqual(pg.alipayNodeText(dup, 'alipay_trade_query_response').count, 2, '两个同名节点必须被数出来');
  assertEqual(pg.alipayRawNode(dup, 'alipay_trade_query_response'), '',
    '★重复键必须切不出内容（旧实现取第一个 ⇒ 验签用真节点、取值用假节点）');
  assertEqual(pg.alipaySyncNode(dup, 'alipay_trade_query_response').error, 'duplicate', '原因要能区分「分叉」');

  /* ② 字符串值里出现的同名键不算节点（`indexOf` 会把它当成节点起点） */
  const inString = '{"note":"\\"alipay_trade_query_response\\":{\\"code\\":\\"99999\\"}",'
    + `"alipay_trade_query_response":${REAL_NODE},"sign":"x"}`;
  assertEqual(pg.alipayNodeText(inString, 'alipay_trade_query_response').count, 1,
    '字符串字面量里的同名键不是业务节点');
  assertEqual(pg.alipayRawNode(inString, 'alipay_trade_query_response'), REAL_NODE, '仍要取到真正的那个节点');

  /* ④ 嵌套里的同名键不算分叉（只有根对象的直接键才有意义） */
  const nested = `{"extra":{"alipay_trade_query_response":{"code":"99999"}},"alipay_trade_query_response":${REAL_NODE}}`;
  assertEqual(pg.alipayRawNode(nested, 'alipay_trade_query_response'), REAL_NODE, '嵌套同名键不得被当成第二个节点');
});

test('R104-08 · F-02 · 端到端：真签名 + 追加的伪造节点不得让订单变已付', async () => {
  const pg = require(SERVER('payment-gateway.js'));

  /* ① 真签名只对真节点有效，追加一个伪造 TRADE_SUCCESS ⇒ 必须判 error */
  const srv = await gatewayStub(
    `{"alipay_trade_query_response":${REAL_NODE},"sign":"${signNode(REAL_NODE)}",`
    + `"alipay_trade_query_response":${FAKE_NODE}}`,
  );
  try {
    const r = await pg.queryCharge('alipay', alipayCfg(srv.port), {
      id: 'o-r104-02', amountFen: 500, platform: 'alipay',
    });
    assertEqual(r.paid, false,
      `★真签名只对真节点有效：追加一个伪造的 TRADE_SUCCESS 不得让订单变已付（实际：${JSON.stringify(r)}）`);
    assertEqual(r.state, 'error', '应判「无法确认」，而不是「已支付」或「未支付」');
    assert(/多个同名|无法识别/.test(String(r.failReason)),
      `文案要说清是响应结构有问题，而不是去查公钥（实际：${r.failReason}）`);
  } finally {
    await srv.close();
  }

  /* ② 对照：同一份真签名 + 只留真节点 ⇒ 必须照常走「未支付」（不能把正常响应一起判死） */
  const ok = await gatewayStub(`{"alipay_trade_query_response":${REAL_NODE},"sign":"${signNode(REAL_NODE)}"}`);
  try {
    const r = await pg.queryCharge('alipay', alipayCfg(ok.port), {
      id: 'o-r104-02b', amountFen: 500, platform: 'alipay',
    });
    assertEqual(r.paid, false, '交易不存在 = 未支付');
    assertEqual(r.state, 'pending', `对照：单节点 + 真签名必须正常解析（实际：${JSON.stringify(r)}）`);
  } finally {
    await ok.close();
  }
});

/* ================================================================== *
 * F-03 · captchaHosts 不得采信请求 Host
 * ================================================================== */

test('R104-03 · F-03 · 登录时人机验证的允许域名只由服务端权威来源构造（Host: evil.com 不得进白名单）', async () => {
  const ctx = require(SERVER('routes/_context.js'));
  const seen = [];
  const origGuard = ctx.captchaNative.guard;
  ctx.captchaNative.guard = async (args) => {
    seen.push(args.expectedHosts);
    return { passed: false, reason: 'r104-stub' };
  };
  const app = ctx.express();
  app.use(ctx.express.json());
  app.use(require(SERVER('routes/auth.js')));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  try {
    // 攻击形态：跨站 Host + 刻意不带 Origin/Referer（csrfGuard 在无 src 时放行）
    const r = await request(port, 'POST', '/auth/login', {
      headers: { Host: 'evil.com' },
      body: { username: 'nobody', password: 'x', captchaToken: 'token-from-evil' },
    });
    assertEqual(r.status, 403, '桩返回「未通过」⇒ 路由应回 403（登录被拦，符合预期）');
    assertEqual(seen.length, 1, '人机验证必须真的被调用到');
    assert(seen[0].indexOf('evil.com') < 0,
      `★请求 Host 不得进允许集（旧实现无条件加进去 ⇒ 在 evil.com 解出的 token 直接放行）：${JSON.stringify(seen[0])}`);
    assert(seen[0].indexOf('kepler.example.com') >= 0,
      `本站域名必须在允许集里（否则正常登录会被自己的判据拦下）：${JSON.stringify(seen[0])}`);

    // 对照：Host 就是本站域名时仍然可用（证明这条修复没有把正常路径一起关掉）
    await request(port, 'POST', '/auth/login', {
      headers: { Host: 'kepler.example.com' },
      body: { username: 'nobody', password: 'x', captchaToken: 't' },
    });
    assertEqual(seen.length, 2, '第二次也要走到人机验证');
    assert(seen[1].indexOf('kepler.example.com') >= 0, '本站域名照旧在允许集里');
  } finally {
    ctx.captchaNative.guard = origGuard;
    await new Promise((r) => srv.close(r));
  }
});

/* ================================================================== *
 * F-04 · 设置不可用时校验必须 fail-closed
 * ================================================================== */

test('R104-04 · F-04 · enc-settings.json 读不出来时：任意口令不得换到访问令牌', async () => {
  await withDir('pw', async (dir) => {
    fs.writeFileSync(path.join(dir, 'enc-settings.json'), '{ 这不是合法 JSON', 'utf8');
    const enc = require(SERVER('enc-store.js'));

    assertEqual(enc.passwordSet(), true, '门禁形态早就 fail-closed（要求密码）——这是对照，不是被测项');
    assertEqual(await enc.checkPassword('anything'), false,
      '★读不到设置时**任意**口令都必须被拒（旧实现：passwordHash 为空 ⇒ 直接放行）');
    assertEqual(await enc.checkPassword(''), false, '空口令同样不得放行');

    let threw = false;
    let code = '';
    try { enc.issueToken(); } catch (e) { threw = true; code = (e && e.code) || ''; }
    assert(threw, '★设置不可用时不得签发令牌');
    assertEqual(code, 'ENC_SETTINGS_UNAVAILABLE', '失败原因要可判定（路由据此回 503 而不是 500）');
    assertEqual(enc.verifyToken('9999999999999.abcdef'), false, '★旧票也不得在不可用状态下被认');
  });
});

/* ================================================================== *
 * F-05 · 备份导入必须知道「写盘失败了」
 * ================================================================== */

test('R104-05 · F-05 · 配置写盘失败时导入必须报错（不得显示「导入完成」）', async () => {
  await withDir('backup', async (dir) => {
    const m = boot();
    await m.configStore.addUser({ username: 'root', password: 'RootPass-104', role: 'root' });
    m.configStore.flushPending();
    await wait(200);
    m.configStore.getMasterKey();

    const backup = require(SERVER('backup.js'));
    const atomic = require(SERVER('atomic-write.js'));
    const data = backup.collect();
    const orig = atomic.writeAtomic;
    /**
     * 只让 config.enc 的写入失败 —— 这就是「磁盘满 / 权限错误」在生产里的等价形态：
     * `config-store` 的写队列把异常吞成 `lastWriteError`，队列本身照常 resolve。
     */
    atomic.writeAtomic = async (file, text) => {
      if (String(file).endsWith('config.enc')) throw new Error('ENOSPC: no space left on device');
      return orig(file, text);
    };
    let err = null;
    try {
      await backup.apply(data);
    } catch (e) {
      err = e;
    } finally {
      atomic.writeAtomic = orig;
    }
    assert(err, '★写盘失败时 backup.apply() 必须抛错（旧实现只 await flush()，它永远 resolve）');
    assertEqual(err.status, 500, '应是 500（界面显示失败），而不是 200「导入完成」');
    assert(/写入磁盘|写盘|ENOSPC/.test(String(err.message)), `错误文案要指出是写盘问题：${err.message}`);
  });
});

/* ================================================================== *
 * F-06 · reconcile 必须与轮转互斥
 * ================================================================== */

test('R104-06 · F-06 · 轮转进行中不得删掉轮转意图日志', async () => {
  await withDir('rotate', async (dir) => {
    const m = boot();
    await m.keyring.create(PW);
    await m.configStore.addUser({ username: 'root', password: 'RootPass-104', role: 'root' });
    await wait(150);

    const keyRotate = require(SERVER('key-rotate.js'));
    const intentPath = path.join(dir, keyRotate.INTENT_NAME);
    const writeIntent = () => fs.writeFileSync(intentPath, JSON.stringify({
      v: 1,
      userId: 'whatever',
      cred: { salt: 'aa', hash: 'bb' },
      fromKekVersion: 1,
      toKekVersion: 2,
    }));

    /**
     * 对照：不在互斥里时，`kekVersion === from` ⇒ `clearIntent()`。
     * 这条对照证明下面的断言不是恒真（否则「意图还在」可能只是因为它压根不会被删）。
     */
    writeIntent();
    const outside = await keyRotate.reconcile();
    assertEqual(outside.reason, 'not-rotated', '对照：轮转还没发生时 reconcile 会走 not-rotated');
    assertEqual(fs.existsSync(intentPath), false, '对照：这条分支确实会删掉意图日志');

    // 被测：轮转进行中（互斥内部）调用 reconcile ⇒ 必须原样跳过，且不删意图
    writeIntent();
    const inside = await keyRotate.withRotationLock(async () => {
      const r = await keyRotate.reconcile();
      return { r, stillThere: fs.existsSync(intentPath) };
    });
    assertEqual(inside.r.reason, 'rotating',
      `★轮转进行中 reconcile 必须直接跳过（旧实现会去判 kekVersion 并删意图）：${JSON.stringify(inside.r)}`);
    assertEqual(inside.stillThere, true,
      '★意图日志必须留着 —— 它是崩溃之后唯一能把「新 KEK + 旧登录口令」补回来的凭据');
  });
});

/* ================================================================== *
 * 启动门（F-01 的另一半）：静态形状 + 顺序
 * ================================================================== */

test('R104-07 · F-01 · 启动清扫必须真的等解锁成功（不是「等解锁尝试」）', () => {
  const idx = readSrc('server', 'index.js');
  const guards = idx.split('if (!r || !r.ok) return;').length - 1;
  assertEqual(guards, 2,
    `首次清扫（pruneSessions）与注销清扫（sweepDeletions）都必须判 r.ok，实际 ${guards} 处`);

  const pruneAt = idx.indexOf('try { pruneSessions(); } catch (e)');
  assert(pruneAt > 0, 'pruneSessions() 的调用点必须存在（本判据只锁顺序）');
  const guardAt = idx.lastIndexOf('if (!r || !r.ok) return;', pruneAt);
  assert(guardAt > 0 && guardAt < pruneAt, '判 r.ok 必须排在首次清扫之前');

  const sweepAt = idx.indexOf('paymentOrders.sweepStalePending()');
  const lockAt = idx.lastIndexOf('configStore.isLocked()', sweepAt);
  /**
   * ⚠️ 不能只判「前面出现过 isLocked()」—— `/api` 的锁定门在文件靠前处也有一处，
   * 那样写会在撤掉修复后照样变绿（实测：这条一开始就是假绿）。必须判**紧邻**：
   * 三目表达式只隔几行，距离远大于它说明判据被拆掉了。
   */
  assert(sweepAt > 0 && lockAt > 0 && sweepAt - lockAt < 120,
    '★启动期的订单清扫必须先判锁定态（旧实现无条件跑 ⇒ load() 失败被记成进程级 loadFailed）');
});
