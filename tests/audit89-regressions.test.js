/**
 * R89 · 存储空间隔离（每个用户只能看到并管理自己的那一部分）
 *
 * 改造前：一个桶对任何「可见」的登录用户是全开的 —— `/fs/list?prefix=` 传空串就是整桶
 * 列举，`/fs/delete` 传谁的 key 就删谁的文件，`/fs/presign` 能给任意对象签直链。
 * 现在：桶内按 `u/<userId>/` 前缀分段，**进收口点加根、出收口点剥根**，
 * 没有空间根的只有管理层。
 *
 * 断言分层（任何一层缺失都会留下假绿）：
 *  ① **纯函数层**（真实 `user-space.js`）：根的形态、越界判定、加根/剥根的方向；
 *  ② **上下文层**（真实 `request-context.js`）：fail-closed 而不是回退成「看全部」；
 *  ③ **咽喉层**（真实 `s3.p()` + 假客户端）：任何绕过路由的绝对 key 都被兜底拦下；
 *  ④ **路由层**（真实 express 路由 + 真发 HTTP）：列举/树/删除/分享的收支方向；
 *  ⑤ **WebDAV 层**（真实 `authMiddleware`）：账户绑定用户后请求上下文真的带上了根；
 *  ⑥ **账户生命周期**（真实 `config-store`）：删用户必须连带吊销其 WebDAV 账户。
 *
 * ⚠️ 桩必须在**路由模块加载前**装好：`routes/fs.js` 在加载时就把 `p` / `requireConfig`
 *    解构走了，之后再替换模块导出对它无效（本项目反复踩过的「桩打不到」）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');

const { ROOT, request, assertEqual } = require('./helpers');

const S = (...p) => path.join(ROOT, 'server', ...p);

/* ==================== 桩：必须早于路由模块的加载 ==================== */

const s3mod = require(S('s3.js'));
const realP = s3mod.p;

/** 假客户端：所有方法都成功，并把调用参数记进 `calls`（供「到底打没打云端」断言） */
let calls = [];
const fakeClient = new Proxy({}, {
  get: (_t, method) => (params, cb) => {
    calls.push({ method: String(method), params });
    const prefix = String((params && params.Prefix) || '');
    cb(null, {
      headers: { 'content-length': '32', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      // 列举端点返回一条对象（名字取自请求前缀）—— 出口是否剥根才可被观察
      Contents: prefix ? [{ Key: prefix + 'a.txt', Size: 10, ETag: '"x"' }] : [],
      CommonPrefixes: [], IsTruncated: 'false', NextMarker: '',
    });
  },
});

/**
 * 把 `p()` 转成「走真实咽喉点 + 假客户端」：这样 `s3.assertScoped()` 是真的在跑，
 * 而不是被桩整体短路掉 —— 否则 R89-03 会变成一条永远绿的假护栏。
 */
s3mod.p = (client, method, params, opts) => realP(client || fakeClient, method, params, opts);
s3mod.getClient = () => fakeClient;

const shared = require(S('routes/_shared.js'));
const requestContext = require(S('request-context.js'));

/**
 * `requireConfig` 的 `spaceRoot` **跟随当前会话**（与生产一致：它来自
 * `configStore.effective()`），而不是写死一个值 —— 否则「管理员不该有根」这条
 * 正对照就测不到。
 */
shared.requireConfig = () => ({
  bucket: 'r89-bucket', region: 'ap-guangzhou', provider: 'tencent',
  credentialId: 'cred-r89', bucketId: 'b-r89', secretId: 'ak-r89', secretKey: 'sk-r89',
  spaceRoot: requestContext.spaceRoot(),
});
// 配额闸门不是本轮主题，且需要真实的密钥/桶记录才能算；这里放行，由专属用例覆盖
shared.assertCredentialQuota = async () => {};
shared.assertBucketQuota = async () => {};

const userSpace = require(S('user-space.js'));
const fsRoutes = require(S('routes/fs.js'));
const linksRoutes = require(S('routes/links.js'));
const statsRoutes = require(S('routes/stats.js'));
const shareStore = require(S('share-store.js'));
const configStore = require(S('config-store.js'));
const webdavAuth = require(S('webdav/auth.js'));

const express = require(path.join(ROOT, 'node_modules', 'express'));

/**
 * 起一个本地服务：先按 `who` 建立请求上下文（模拟 `/api` 的鉴权中间件），
 * 再挂路由。上下文用 AsyncLocalStorage，`next()` 之后整条异步链都能取到。
 */
async function serve(router, who) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    req.authUser = who;
    if (!who) return next();
    requestContext.runWith(
      { token: 't', userId: who.id, role: who.role, activeBucketId: '' },
      () => next(),
    );
  });
  // 生产里这些路由挂在 `/api` 下（`index.js` 的 `app.use('/api', routes)`），
  // 路由自身写的是 `/fs/list` —— 这里必须同样挂载，否则整组用例都是 404 假绿
  app.use('/api', router);
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

const USER = { id: 'u1', username: 'alice', role: 'user', permissions: {} };
const ADMIN = { id: 'a1', username: 'root1', role: 'admin', permissions: {} };

/**
 * 先占位一个管理账户。
 *
 * R71 起「系统创建的第一个账户」会被引导成**根用户**（`resolveNewUserRole`），
 * 于是 `addUser({ role: 'user' })` 拿到的其实是 root —— 而 R89 明确拒绝把 WebDAV
 * 账户绑到管理层身上（他们没有独立空间）。不先占位的话，下面的用例会以
 * 「绑不上去」的形式红掉，且报错看起来像是功能坏了。
 */
async function bootstrapAdmin() {
  try {
    await configStore.addUser({ username: 'r89boot', password: 'Passw0rd!boot', role: 'admin' });
  } catch (e) { /* 已存在（同一进程内第二次调用） */ }
}

/* ==================================================================== */
/* R89-01 · 纯函数层：根的形态与「加根 / 剥根」的方向                       */
/* ==================================================================== */

test('R89-01 · 空间根必须以 `/` 结尾，且加根/剥根只有唯一方向', () => {
  /* ---- 根的形态：尾斜杠不是美观问题 ---- */
  assertEqual(userSpace.rootForUserId('abc'), 'u/abc/');
  assertEqual(
    userSpace.isInside('u/abc/', 'u/abcd/x.txt'), false,
    '`startsWith("u/abc")` 会把 `u/abcd/` 一并放行 —— 这是静默越权，故根必须带尾斜杠',
  );
  assertEqual(userSpace.isInside('u/abc/', 'u/abc/x.txt'), true);
  assertEqual(userSpace.isInside('u/abc/', 'u/abc/'), true, '空间根自身算「在内」');

  /* ---- 加根 ---- */
  assertEqual(userSpace.toAbs('u/abc/', 'dir/a.txt'), 'u/abc/dir/a.txt');
  assertEqual(
    userSpace.toAbs('u/abc/', 'u/abc/a.txt'), 'u/abc/a.txt',
    '客户端已经带着自己的根时不得叠加第二层（否则会拼出 u/abc/u/abc/a.txt）',
  );
  assertEqual(
    userSpace.toAbs('u/abc/', 'u/zzz/a.txt'), 'u/abc/u/zzz/a.txt',
    '别人的绝对前缀必须被当作**相对路径**收进自己的空间，而不是原样放行',
  );

  /* ---- 剥根：越界必须返回 null，不能返回空串 ---- */
  assertEqual(userSpace.toRel('u/abc/', 'u/abc/dir/a.txt'), 'dir/a.txt');
  assertEqual(userSpace.toRel('u/abc/', 'u/abc/'), '');
  assertEqual(
    userSpace.toRel('u/abc/', 'u/abc2/a.txt'), null,
    '越界必须与「空串」区分开：返回空串会让调用方以为「这是空间根目录」',
  );

  /* ---- 管理层：无根即恒等 ---- */
  assertEqual(userSpace.toAbs('', 'dir/a.txt'), 'dir/a.txt');
  assertEqual(userSpace.toRel('', 'dir/a.txt'), 'dir/a.txt');

  /* ---- 非法用户标识：宁可 500，也不拼出一个能穿越的 key ---- */
  for (const bad of ['a/b', '..', 'a b']) {
    let threw = null;
    try { userSpace.rootForUserId(bad); } catch (e) { threw = e; }
    assert(threw && threw.status === 500, `用户标识「${bad}」必须被拒绝（拼进 key 会越界）`);
  }
});

/* ==================================================================== */
/* R89-02 · 上下文层：判不准时必须 fail-closed                              */
/* ==================================================================== */

test('R89-02 · 角色是 user 却拿不到 userId 时抛错，绝不回退成「看全部」', () => {
  assertEqual(
    requestContext.runWith({ role: 'user', userId: 'abc' }, () => requestContext.spaceRoot()),
    'u/abc/',
  );
  assertEqual(
    requestContext.runWith({ role: 'admin', userId: 'abc' }, () => requestContext.spaceRoot()),
    '',
    '管理层没有空间根（这是「看全部」的唯一合法来源）',
  );
  assertEqual(
    requestContext.runWith({ role: 'root', userId: 'abc' }, () => requestContext.spaceRoot()),
    '',
  );
  assertEqual(requestContext.spaceRoot(), '', '无上下文（分享页 / 内部调用）视为无作用域');

  let threw = null;
  try {
    requestContext.runWith({ role: 'user' }, () => requestContext.spaceRoot());
  } catch (e) { threw = e; }
  assert(threw, '缺 userId 必须抛错');
  assertEqual(threw.status, 500);
});

/* ==================================================================== */
/* R89-03 · 咽喉层：绕过路由的绝对 key 也必须被拦                           */
/* ==================================================================== */

test('R89-03 · s3.p() 兜底断言：越界 key 一律 404，且不向上游发请求', async () => {
  const deny = async (params) => {
    calls = [];
    let err = null;
    try {
      await requestContext.runWith({ role: 'user', userId: 'abc' }, () => realP(fakeClient, 'putObject', params));
    } catch (e) { err = e; }
    return { err, calls };
  };

  /* ---- 越界：Key / Prefix / CopySource / 批量 Delete 四个入口都要拦 ---- */
  const beyond = [
    { Bucket: 'b', Key: 'u/other/a.txt' },
    { Bucket: 'b', Prefix: 'legacy/' },
    { Bucket: 'b', Key: 'u/abc/a.txt', CopySource: '/b/u/other/b.txt' },
    { Bucket: 'b', Delete: { Objects: [{ Key: 'u/other/c.txt' }] } },
  ];
  for (const params of beyond) {
    const { err, calls: seen } = await deny(params);
    assert(err, '越界参数必须被拒绝：' + JSON.stringify(params));
    assertEqual(err.status, 404, '越界一律 404（不是 403）');
    assertEqual(err.message, '对象不存在或无权访问', '文案必须与「不存在」同一句，不能当存在性预言机');
    assertEqual(seen.length, 0, '被拦下的请求一个字节都不该发往上游');
  }

  /* ---- 正对照：空间内放行；管理层不受约束 ---- */
  calls = [];
  await requestContext.runWith({ role: 'user', userId: 'abc' }, () => realP(fakeClient, 'getObject', { Bucket: 'b', Key: 'u/abc/a.txt' }));
  assertEqual(calls.length, 1, '自己空间内的对象必须放行（否则功能全废）');

  calls = [];
  await realP(fakeClient, 'getObject', { Bucket: 'b', Key: 'u/other/a.txt' });
  assertEqual(calls.length, 1, '无上下文（分享下载 / 内部任务）走绝对语义，不设限');
});

/* ==================================================================== */
/* R89-04 / R89-05 · 路由层：列举与目录树                                  */
/* ==================================================================== */

test('R89-04 · /fs/list：前缀加根、响应剥根，且**缓存命中**与首次结果一致', async () => {
  const srv = await serve(fsRoutes, USER);
  try {
    calls = [];
    const first = await request(srv.port, 'GET', '/api/fs/list?prefix=');
    assertEqual(first.status, 200);
    const sent = calls.filter((c) => c.method === 'getBucket');
    assertEqual(sent.length, 1);
    assertEqual(
      sent[0].params.Prefix, 'u/u1/',
      '空 prefix 必须是「自己的根」，而不是整个桶（改造前的核心越权点）',
    );

    /* 让上游真的返回一个对象，检查出口是否剥掉了根 */
    assertEqual(
      first.json && first.json.contents && first.json.contents[0] && first.json.contents[0].key,
      'a.txt',
      '响应里的 key 必须是相对 key（出口剥根）—— 漏了这一步，用户会在自己的文件名前面'
        + '看到一个内部 id，而且再点进去就会拼出 u/u1/u/u1/…',
    );
    assertEqual(first.json.prefix, '', '响应里的 prefix 同样要剥根');
    const srv2 = await serve(fsRoutes, USER);
    try {
      /* 同一个进程内 list-cache 是共享的：第二次请求必然命中缓存 —— 这正是要验的分支 */
      const again = await request(srv2.port, 'GET', '/api/fs/list?prefix=');
      assertEqual(again.status, 200);
      assertEqual(
        again.json && again.json.prefix, '',
        '缓存命中时也必须剥根（否则同一目录第二次刷新会突然多出一层 u/u1/）',
      );
    } finally { await srv2.close(); }
  } finally { await srv.close(); }

  /* 正对照：管理层看的是桶内真实路径，不加根也不剥根 */
  const adminSrv = await serve(fsRoutes, ADMIN);
  try {
    calls = [];
    const r = await request(adminSrv.port, 'GET', '/api/fs/list?prefix=legacy/');
    assertEqual(r.status, 200);
    const sent = calls.filter((c) => c.method === 'getBucket');
    assertEqual(sent[0].params.Prefix, 'legacy/', '管理层必须能直接列举存量区');
    assertEqual(r.json && r.json.prefix, 'legacy/');
  } finally { await adminSrv.close(); }
});

test('R89-05 · /fs/tree：侧边栏树是第二条列举入口，同样必须加根', async () => {
  const srv = await serve(fsRoutes, USER);
  try {
    calls = [];
    const r = await request(srv.port, 'GET', '/api/fs/tree?prefix=');
    assertEqual(r.status, 200);
    const sent = calls.filter((c) => c.method === 'getBucket');
    assertEqual(sent.length, 1);
    assertEqual(
      sent[0].params.Prefix, 'u/u1/',
      '漏了这一步的表现极具欺骗性：侧边栏变成一列空白条目（剥根后全成空串），'
        + '实际是把整个桶的顶层目录都列了出来',
    );
  } finally { await srv.close(); }
});

/* ==================================================================== */
/* R89-06 · 路由层：空路径不得被当成「整个空间」                            */
/* ==================================================================== */

test('R89-06 · /fs/delete 与 /fs/stat：空 path 必须 400，不能加根成空间根', async () => {
  const srv = await serve(fsRoutes, USER);
  try {
    calls = [];
    const del = await request(srv.port, 'POST', '/api/fs/delete', { body: { paths: [''] } });
    assertEqual(del.status, 400, '空路径必须被拒绝');
    assertEqual(
      calls.filter((c) => /delete/i.test(c.method)).length, 0,
      '一个空字符串就能触发「递归删除空间根」是不可接受的（deletePrefixAll 不可逆）',
    );

    const stat = await request(srv.port, 'GET', '/api/fs/stat?path=');
    assertEqual(stat.status, 400, '缺 path 不能变成「统计我整个空间」');
  } finally { await srv.close(); }
});

/* ==================================================================== */
/* R89-07 · 分享：快照必须落**绝对** key（否则链接建得出来、点开恒 404）      */
/* ==================================================================== */

test('R89-07 · POST /links：快照存桶内绝对 key，客户端提交的仍是相对 key', async () => {
  const captured = [];
  const realCreate = shareStore.create;
  shareStore.create = async (rec) => {
    captured.push(rec);
    return { id: 'x'.repeat(22), fileName: 'a.txt', items: rec.items };
  };
  const srv = await serve(linksRoutes, USER);
  try {
    const r = await request(srv.port, 'POST', '/api/links', { body: { paths: ['dir/a.txt'] } });
    assertEqual(r.status, 200);
    assertEqual(captured.length, 1);
    assertEqual(
      captured[0].items[0].key, 'u/u1/dir/a.txt',
      '分享是无会话的（/s/... 不经过鉴权中间件），快照里必须是绝对 key —— '
        + '存相对 key 会让链接建得出来、下载时恒 404',
    );

    /* 正对照：管理层建的链接维持原样（存量链接与老订单的绝对 key 快照照常可用） */
    const adminSrv = await serve(linksRoutes, ADMIN);
    try {
      const r2 = await request(adminSrv.port, 'POST', '/api/links', { body: { paths: ['legacy/a.txt'] } });
      assertEqual(r2.status, 200);
      assertEqual(captured[1].items[0].key, 'legacy/a.txt');
    } finally { await adminSrv.close(); }
  } finally {
    shareStore.create = realCreate;
    await srv.close();
  }
});

/* ==================================================================== */
/* R89-08 · WebDAV：账户绑定用户后，请求上下文必须带上空间根                 */
/* ==================================================================== */

test('R89-08 · WebDAV 绑定用户的账户：认证后上下文带根；未绑定 / 用户已删则按管理层', async () => {
  configStore.setWebdavEnabled(true);
  await bootstrapAdmin();
  const user = await configStore.addUser({ username: 'r89dav', password: 'Passw0rd!r89', role: 'user' });
  const bound = configStore.addWebdavAccount({
    appName: 'r89-bound', username: 'r89bound', password: 'DavPass!1', ownerUserId: user.id,
  });
  const free = configStore.addWebdavAccount({
    appName: 'r89-free', username: 'r89free', password: 'DavPass!2',
  });

  const login = async (username, password) => {
    const req = {
      socket: { encrypted: true, remoteAddress: '127.0.0.1' },
      headers: { authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
      get: () => '',
    };
    let root = null;
    let status = 200;
    const res = {
      setHeader() {}, status(s) { status = s; return res; }, type() { return res; }, send() { return res; },
    };
    await webdavAuth.authMiddleware(req, res, () => { root = requestContext.spaceRoot(); });
    return { root, status, account: req.webdavUser };
  };

  const r1 = await login('r89bound', 'DavPass!1');
  assertEqual(r1.status, 200);
  assertEqual(r1.account.ownerUserId, user.id, '认证结果必须带出绑定关系');
  assertEqual(
    r1.root, 'u/' + user.id + '/',
    '绑定用户的 WebDAV 账户只能看自己的空间（这是「WebDAV 也能随便读写整桶」的修复点）',
  );

  const r2 = await login('r89free', 'DavPass!2');
  assertEqual(r2.root, '', '未绑定的账户是管理账户（既有语义，不因升级而突然看不到原文件）');

  /**
   * 绑定关系指向的用户**已不存在**时必须是 403，而不是「回退成未绑定」。
   *
   * 这条分支在正常 API 下不可达（`removeUser()` 会连带吊销账户，R89-09）——
   * 它防的是「配置被手改 / 从备份还原 / 老版本数据」这类状态。测试直接用
   * 打桩模拟该状态，而不是为了可测性给生产代码开后门。
   */
  const realFind = configStore.findUserRawById;
  configStore.findUserRawById = () => null;
  try {
    const gone = await login('r89bound', 'DavPass!1');
    assertEqual(
      gone.status, 403,
      '绑定的用户查不到时必须 403 —— 一旦回退成「未绑定」，删掉一个普通用户'
        + '就等于把他手里的 WebDAV 凭据升级成管理员凭据',
    );
    assertEqual(gone.root, null, '连上下文都不该建立');
  } finally {
    configStore.findUserRawById = realFind;
  }

  /* 账户绑定关系可改：显式解绑 → 退回管理权限 */
  configStore.updateWebdavAccount(bound.id, { ownerUserId: '' });
  const r3 = await login('r89bound', 'DavPass!1');
  assertEqual(r3.root, '');
  configStore.updateWebdavAccount(bound.id, { ownerUserId: user.id });

  /* 绑定到一个不存在的用户必须当场拒绝，不能静默当成「未绑定」 */
  let threw = null;
  try { configStore.addWebdavAccount({ appName: 'r89-bad', username: 'r89bad', password: 'DavPass!3', ownerUserId: 'nope' }); }
  catch (e) { threw = e; }
  assert(threw && threw.status === 400, '写错用户 id 必须报错 —— 否则受限账户会被悄悄升级成能看全部');

  configStore.removeWebdavAccount(free.id);
  configStore.removeWebdavAccount(bound.id);
});

/* ==================================================================== */
/* R89-09 · 账户生命周期：删用户必须连带吊销其 WebDAV 凭据                   */
/* ==================================================================== */

test('R89-09 · 删除用户时连带删除其绑定的 WebDAV 账户（否则删人=给凭据提权）', async () => {
  await bootstrapAdmin();
  const user = await configStore.addUser({ username: 'r89del', password: 'Passw0rd!r89', role: 'user' });
  const acc = configStore.addWebdavAccount({
    appName: 'r89-del-acc', username: 'r89delacc', password: 'DavPass!9', ownerUserId: user.id,
  });
  const before = configStore.getWebdav().accounts.some((a) => a.id === acc.id);
  assertEqual(before, true, '前置：账户应已创建');

  configStore.removeUser(user.id);

  const after = configStore.getWebdav().accounts.some((a) => a.id === acc.id);
  assertEqual(
    after, false,
    '用户被删后该账户必须一并消失 —— 留着它的 ownerUserId 指向不存在的用户，'
      + '一旦解析回退成「未绑定」，就等于把普通用户的凭据升级成管理凭据',
  );
});

/* ==================================================================== */
/* R89-10 · 用量统计：普通用户看到的必须是「自己那一段」                      */
/* ==================================================================== */

test('R89-10 · /stats/storage：普通用户按自己的根扫描，管理层才是桶级总量', async () => {
  const userSrv = await serve(statsRoutes, USER);
  try {
    calls = [];
    const r = await request(userSrv.port, 'GET', '/api/stats/storage');
    assertEqual(r.status, 200);
    const scans = calls.filter((c) => c.method === 'getBucket' || c.method === 'listObjectsV2');
    assertEqual(scans.length >= 1, true, '用量统计应至少发起一次列举');
    for (const c of scans) {
      assertEqual(
        String(c.params.Prefix || ''), 'u/u1/',
        '普通用户的用量只能扫自己的根：桶级总量既是聚合信息泄露，也与他'
          + '「只能看到自己那一部分」的界面自相矛盾',
      );
    }
  } finally { await userSrv.close(); }

  const adminSrv = await serve(statsRoutes, ADMIN);
  try {
    calls = [];
    const r = await request(adminSrv.port, 'GET', '/api/stats/storage');
    assertEqual(r.status, 200);
    const scans = calls.filter((c) => c.method === 'getBucket' || c.method === 'listObjectsV2');
    assertEqual(scans.length >= 1, true);
    assertEqual(
      String(scans[0].params.Prefix || ''), '',
      '管理层仍是桶级总量（行为与改造前一致）',
    );
  } finally { await adminSrv.close(); }
});
