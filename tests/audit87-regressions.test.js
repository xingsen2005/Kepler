/**
 * R87 · 《Kepler 全模块安全与功能审查报告》（2026-10-25，GLM-5.3，基准 v1.9.21）修复护栏
 *
 * 本轮只为本仓库**确认成立且值得修**的条目建护栏。报告里被判为「不成立 / 已文档化取舍」
 * 的条目见 `Audit_illusion_report.md`，不在此文件里造用例。
 *
 * 覆盖（15 条）：
 *  - R87-01 INF-S1 / GRD-S1 / DAV-S2：`TRUST_PROXY=1` 必须**先判对端**再采信 XFF
 *  - R87-02 SHR-F1：分享侧 Cookie 的 `Secure` 与主会话同一判据（`cookieSecure()`）
 *  - R87-03 CLD-F1：Azure 下载按**空闲**判死，不按总时长（含 S3 缓冲分支）
 *  - R87-04 GRD-F2：`normalizeRule` 归一 `methods`（缺字段的导入规则不得炸全站）
 *  - R87-05 AUT-S1：`/users/me` 的口令校验必须**先过**限流再 scrypt
 *  - R87-06 AUT-S2：编辑**自己**改密码 / 改邮箱必须校验当前密码
 *  - R87-07 CFG-S1 + CFG-F1：备份导入落库前校验端点，且 `apply()` 等待落盘
 *  - R87-08 INF-S2：5xx 不回显原始 `err.message`
 *  - R87-09 FS-F1：rename / move 目录分支按**快照**删源
 *  - R87-10 CLD-F2：`sliceCopyFile` 在**开工前**就拒绝超出 10000 片
 *  - R87-11 GRD-F1：限速并发计数在「真有数据流过」时才登记
 *  - R87-12 DAV-F1：上传流提前关闭必须结算 Promise（否则写信号量槽位泄漏）
 *  - R87-13 CLD-F5 + FS-S3：`normalizeKey` 允许 `a..b.txt`、拒绝 NUL 与 `..` 段
 *  - R87-14 WEB-S1/S2/S3：三处回退 label / `data-id` / methods 单元格必须转义
 *  - R87-15 INF-S3：`/api/health` 只下发写错误文件的 basename
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Readable, PassThrough } = require('stream');

const { ROOT, request, assertEqual } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SEC = path.join(ROOT, 'server', 'security.js');

/** 剥掉整行注释（`//` 开头）后按行返回 —— 静态断言不得被注释满足 */
function codeLines(src) {
  return String(src).split('\n').filter((l) => !/^\s*\/\//.test(l));
}

/** 起一个只挂指定 router 的本地服务（与 agreement-settings 同款骨架） */
async function serve(router, middleware) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (middleware) app.use(middleware);
  app.use(router);
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ==================================================================== */
/* R87-01 · 可信代理：先判对端，再读 X-Forwarded-For                        */
/* ==================================================================== */

test('R87-01 · `TRUST_PROXY=1` 也必须先判对端，公网直连不得采信 XFF', () => {
  const saved = { tp: process.env.TRUST_PROXY, from: process.env.TRUST_PROXY_FROM };
  const fresh = () => {
    delete require.cache[require.resolve(SEC)];
    return require(SEC);
  };
  process.env.TRUST_PROXY = '1';
  delete process.env.TRUST_PROXY_FROM;
  try {
    const sec = fresh();

    /* ---- 正向对照：对端是回环（deploy.sh 生成的反代形态）→ 照旧采信 ---- */
    const proxied = sec.clientIpInfo({
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    assertEqual(proxied.ip, '203.0.113.9',
      'R87-01：对端是回环（Nginx 在本机）时必须采信 XFF，否则默认部署的限流/锁定全部退化成「都算本机」');
    assertEqual(proxied.fromForwarded, true, 'R87-01：采信时仍须标记来源');

    /* ---- 核心：对端是公网 —— 这正是「绕过 Nginx 直连应用端口」的形状 ---- */
    const direct = sec.clientIpInfo({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '198.51.100.7' },
    });
    assertEqual(direct.ip, '198.51.100.7',
      'R87-01：公网对端伪造的 XFF 必须被忽略，来源取 socket 对端 —— '
      + '否则任何人直连 3000 端口都能冒充任意 IP，按 IP 的登录限流/失败锁定/IP 屏蔽/'
      + '分享限流/取回封禁一次性失效，还能把无辜第三方塞进黑名单');
    assertEqual(direct.fromForwarded, false, 'R87-01：被忽略时不得标记为「来自转发头」');

    /* ---- 正向对照：私网对端（容器化部署里反代在 docker 网段）→ 采信 ---- */
    const bridge = sec.clientIpInfo({
      headers: { 'x-forwarded-for': '203.0.113.10' },
      socket: { remoteAddress: '172.17.0.1' },
    });
    assertEqual(bridge.ip, '203.0.113.10', 'R87-01：私网对端（docker bridge）仍须采信');

    /* ---- 显式白名单：收窄到单跳地址 ---- */
    process.env.TRUST_PROXY_FROM = '10.1.2.0/24';
    const narrowed = fresh();
    assertEqual(narrowed.clientIpInfo({
      headers: { 'x-forwarded-for': '203.0.113.11' },
      socket: { remoteAddress: '127.0.0.1' },
    }).ip, '127.0.0.1',
      'R87-01：显式白名单之外的（哪怕回环）一律不采信');
    assertEqual(narrowed.clientIpInfo({
      headers: { 'x-forwarded-for': '203.0.113.12' },
      socket: { remoteAddress: '10.1.2.9' },
    }).ip, '203.0.113.12', 'R87-01：命中白名单 CIDR 的必须采信（护栏不得退化成「一律不信任」）');
  } finally {
    if (saved.tp === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved.tp;
    if (saved.from === undefined) delete process.env.TRUST_PROXY_FROM; else process.env.TRUST_PROXY_FROM = saved.from;
    delete require.cache[require.resolve(SEC)];
    require(SEC); // 复原：后续用例拿到默认实例
  }
});

/* ==================================================================== */
/* R87-02 · 分享侧 Cookie 的 Secure 与主会话同一判据                        */
/* ==================================================================== */

test('R87-02 · 分享侧 Cookie 不得再用 `!!IS_DEPLOY`，必须走 cookieSecure()', () => {
  const src = read('server/share-routes.js');
  const bad = codeLines(src).map((l, i) => [l, i]).filter(([l]) => /secure:\s*!!security\.IS_DEPLOY/.test(l));
  assertEqual(bad.length, 0,
    'R87-02：分享侧 Cookie 仍用静态 `!!IS_DEPLOY` —— 在「无证书 + 无反代」的纯 HTTP 部署下'
    + '浏览器会丢弃这些 Cookie：密码解锁死循环、已付款者永远停在未支付页、退出登录失效');

  const uses = codeLines(src).filter((l) => /secure:\s*security\.cookieSecure\(\)/.test(l)).length;
  assertEqual(uses, 3,
    `R87-02：三个下发点（encCookieOptions / shareCookieOptions / logout 清除）都必须改口径，实际 ${uses} 处`);

  /* ---- 判据本身：部署模式但**确实没有** HTTPS 时不得加 Secure ---- */
  const saved = { host: process.env.HOST, tp: process.env.TRUST_PROXY };
  process.env.HOST = '0.0.0.0';
  delete process.env.TRUST_PROXY;
  try {
    delete require.cache[require.resolve(SEC)];
    const sec = require(SEC);
    assertEqual(sec.cookieSecure(), false,
      'R87-02：`HOST=0.0.0.0` + 无证书 + 无反代 = 纯 HTTP 实例，Secure 必须为 false，'
      + '否则这是一个「可用的实例被判死」的错误耦合');
    sec.setTlsAvailable(true);
    assertEqual(sec.cookieSecure(), true, 'R87-02：本进程加载到证书后必须加 Secure（护栏不得退化成「永不加」）');
  } finally {
    if (saved.host === undefined) delete process.env.HOST; else process.env.HOST = saved.host;
    if (saved.tp === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved.tp;
    delete require.cache[require.resolve(SEC)];
    require(SEC);
  }
});

/* ==================================================================== */
/* R87-03 · Azure 下载按「空闲」判死                                         */
/* ==================================================================== */

/** 造一个「每 gapMs 来一块」的 web 流 */
function slowBody(chunks, gapMs, signal) {
  let i = 0;
  return new globalThis.ReadableStream({
    pull(c) {
      /**
       * 必须尊重 AbortSignal：真实 fetch 被 abort 时 body 会直接报错，
       * 而一个「忽略 signal」的桩会让「计时器掐断」这个待观察行为**观察不到**
       * —— 反向变异就会假绿（撤掉修复照样通过）。
       */
      if (signal && signal.aborted) { c.error(new Error('aborted')); return undefined; }
      if (i >= chunks.length) { c.close(); return undefined; }
      const n = i;
      i += 1;
      return new Promise((r) => setTimeout(r, gapMs)).then(() => c.enqueue(new Uint8Array(chunks[n])));
    },
  });
}

test('R87-03 · Azure 下载超过 timeout 总时长但持续有数据时必须成功（按空闲判死）', async () => {
  const savedFetch = global.fetch;
  const { AzureBlobClient } = require(path.join(ROOT, 'server', 'azure-client.js'));
  const client = new AzureBlobClient({
    accountName: 'testacct', accountKey: 'a2V5', bucket: 'b', timeout: 1200,
  });
  const blobs = Array.from({ length: 6 }, () => Buffer.alloc(16, 7)); // 6 块 × 400ms = 2.4s > 1.2s
  global.fetch = async (url, opts) => new Response(slowBody(blobs, 400, opts && opts.signal), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  try {
    const out = new PassThrough();
    const got = [];
    out.on('data', (d) => got.push(d));
    const done = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    await client.getObject({ Bucket: 'b', Key: 'big.bin', Output: out });
    await done;
    assertEqual(Buffer.concat(got).length, 96,
      'R87-03：总时长 2.4s（> 1.2s 超时）但每 400ms 都有数据 —— 旧实现会把请求级计时器'
      + '一路罩到 body 结束，于是「传输得久」被当成「请求超时」，大文件必挂在 120 秒处');
  } finally {
    global.fetch = savedFetch;
  }
});

test('R87-03b · 真正停滞（一个字节都不再来）仍必须被掐断', async () => {
  const savedFetch = global.fetch;
  const { AzureBlobClient } = require(path.join(ROOT, 'server', 'azure-client.js'));
  const client = new AzureBlobClient({
    accountName: 'testacct', accountKey: 'a2V5', bucket: 'b', timeout: 400,
  });
  // 第一块之后永不 closer：模拟上游「响应头到了、body 卡住」
  global.fetch = async () => new Response(new globalThis.ReadableStream({
    pull(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
  }), { status: 200 });
  try {
    const out = new PassThrough();
    /**
     * 看门狗的定时器 `unref()` 过（不把进程钉在事件循环里），所以这里必须有**一个 ref 的
     * 定时器**把事件循环撑住：否则「会不会被掐断」这个观察量会因为进程提前退出而永远悬着。
     */
    const err = await Promise.race([
      new Promise((resolve) => {
        out.on('error', resolve);
        out.on('finish', () => resolve(null));
        client.getObject({ Bucket: 'b', Key: 'stall.bin', Output: out }).catch((e) => resolve(e));
      }),
      new Promise((resolve) => { setTimeout(() => resolve(null), 1500); }),
    ]);
    assert(err, 'R87-03b：停滞的上游必须报错，不能永远挂着（看门狗不得退化成「什么都不断」）');
  } finally {
    global.fetch = savedFetch;
  }
});

/* ==================================================================== */
/* R87-04 · normalizeRule 归一 methods                                      */
/* ==================================================================== */

test('R87-04 · 缺 `methods` 的导入规则不得让全局守卫抛 TypeError', () => {
  const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
  try {
    // 备份导入路径：外部 JSON 原样进来，这条规则**没有** methods 字段
    ipGuard.replaceAllRules([{ target: '203.0.113.77', enabled: true, remark: '导入的规则' }]);
    let v;
    assert.doesNotThrow(() => { v = ipGuard.evaluate('203.0.113.77', 'GET'); },
      'R87-04：`matchRules()` 直接读 `r.methods.length` —— 归一化漏了 methods 就是'
      + '每个请求一个 TypeError，全站 500 且管理接口在同一个进程里一起不可用');
    assertEqual(v.ok, false, 'R87-04：这条规则仍必须生效（护栏不得退化成「把规则丢掉」）');
    assert.doesNotThrow(() => ipGuard.evaluate('203.0.113.78', 'POST'),
      'R87-04：未命中规则的请求同样不得抛错');
  } finally {
    ipGuard.replaceAllRules([]);
  }
});

/* ==================================================================== */
/* R87-05 · /users/me 的口令校验必须先过限流                                 */
/* ==================================================================== */

test('R87-05 · `/users/me` 与 `/users/:id` 的 scrypt 校验前必须挂限流', () => {
  const lines = codeLines(read('server/routes/users.js'));
  const idxLimitMe = lines.findIndex((l) => /passwordLimiter\('users-me:' \+ ip\)/.test(l));
  const idxVerifyMe = lines.findIndex((l) => /verifyUserPassword\(me\.id, current\)/.test(l));
  assert(idxLimitMe >= 0, 'R87-05：`PUT /users/me` 的 needsCurrent 分支必须挂 `passwordLimiter`');
  assert(idxLimitMe < idxVerifyMe,
    'R87-05：限流必须排在 scrypt 校验**之前** —— 排在后面等于一次请求已经付过 CPU 才决定要不要限');

  const idxLimitSelf = lines.findIndex((l) => /passwordLimiter\('users-self-edit:' \+ ip\)/.test(l));
  const idxVerifySelf = lines.findIndex((l) => /verifyUserPassword\(target\.id, current\)/.test(l));
  assert(idxLimitSelf >= 0, 'R87-05：`PUT /users/:id` 的自助改密分支同样必须限流');
  assert(idxLimitSelf < idxVerifySelf, 'R87-05：同 —— 限流在校验之前');
});

/* ==================================================================== */
/* R87-06 · 编辑自己改密码 / 改邮箱必须校验当前密码                          */
/* ==================================================================== */

test('R87-06 · `PUT /users/:id` 编辑自己时改密码必须校验当前密码', async () => {
  const cfg = require(path.join(ROOT, 'server', 'config-store.js'));
  const saved = {
    getUserById: cfg.getUserById, updateUser: cfg.updateUser, verifyUserPassword: cfg.verifyUserPassword,
  };
  const users = {
    u1: { id: 'u1', username: 'root1', role: 'root', email: '' },
    u2: { id: 'u2', username: 'plain', role: 'user', email: '' },
  };
  const touched = [];
  cfg.getUserById = (id) => users[id] || null;
  cfg.updateUser = async (id, patch) => { touched.push({ id, patch }); return Object.assign({}, users[id], patch); };
  cfg.verifyUserPassword = async (id, pw) => pw === 'right-pass';

  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'users.js'))];
  const usersRouter = require(path.join(ROOT, 'server', 'routes', 'users.js'));
  const srv = await serve(usersRouter, (req, res, next) => {
    req.authUser = { id: 'u1', username: 'root1', role: 'root' };
    next();
  });
  try {
    /* ---- ① 改密码但不给当前密码 → 400（旧实现直接落库） ---- */
    const r1 = await request(srv.port, 'PUT', '/users/u1', { body: { password: 'Newpass123' } });
    assertEqual(r1.status, 400,
      'R87-06：`isSelf` 分支此前跳过全部判定，`patch.password` 直接落库 —— '
      + '窃取管理员会话者无需知道当前密码即可改密+改邮箱，再把真实所有者永久锁出');
    assertEqual(r1.json && r1.json.needCurrentPassword, true, 'R87-06：必须告诉前端要补当前密码');
    assertEqual(touched.length, 0, 'R87-06：被拦下的请求不得写入任何字段');

    /* ---- ② 当前密码错 → 403 ---- */
    const r2 = await request(srv.port, 'PUT', '/users/u1', {
      body: { password: 'Newpass123', currentPassword: 'wrong' },
    });
    assertEqual(r2.status, 403, 'R87-06：当前密码不正确必须 403');
    assertEqual(touched.length, 0, 'R87-06：403 时同样不得落库');

    /* ---- ③ 正向对照：给对了当前密码 → 成功 ---- */
    const r3 = await request(srv.port, 'PUT', '/users/u1', {
      body: { password: 'Newpass123', currentPassword: 'right-pass' },
    });
    assertEqual(r3.status, 200, 'R87-06：正确当前密码必须放行（护栏不得退化成「谁都改不了」）');
    assertEqual(touched.length, 1, 'R87-06：放行后必须真的写入');

    /* ---- ④ 正向对照：管理员改**别人**的密码不需要当前密码 ---- */
    const r4 = await request(srv.port, 'PUT', '/users/u2', { body: { password: 'Other1234' } });
    assertEqual(r4.status, 200, 'R87-06：管理他人（运维重置）不该被这道闸拦住');
  } finally {
    await srv.close();
    cfg.getUserById = saved.getUserById;
    cfg.updateUser = saved.updateUser;
    cfg.verifyUserPassword = saved.verifyUserPassword;
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'users.js'))];
  }
});

/* ==================================================================== */
/* R87-07 · 备份导入：端点校验 + 等待落盘                                    */
/* ==================================================================== */

test('R87-07 · 备份导入必须校验端点，且 `apply()` 等待落盘', async () => {
  const backup = require(path.join(ROOT, 'server', 'backup.js'));
  const payload = {
    credentials: {
      credentials: [{ id: 'c1', provider: 's3', secretId: 'AK', secretKey: 'SK', endpoint: 'http://169.254.169.254' }],
      activeCredentialId: 'c1',
    },
    buckets: { buckets: [], activeBucketId: '' },
  };
  await assert.rejects(
    () => Promise.resolve().then(() => backup.apply(payload)),
    (e) => {
      assert(/端点|内网|回环|元数据/.test(String(e && e.message)),
        `R87-07：拒绝原因应指向端点，实际：${e && e.message}`);
      return true;
    },
    'R87-07：导入路径此前对 endpoint 零校验 —— 危险端点落库后跨密钥轮换存活，'
    + '管理员之后重填真实 AK/SK 就发给那个地址（凭证外发）',
  );

  const src = read('server/backup.js');
  assert(/async function apply\(/.test(src), 'R87-07：apply 必须是 async（要 await 落盘队列）');
  assert(/await configStore\.flush\(\)/.test(src), 'R87-07：`flush()` 必须 await，否则「导入成功」先于落盘');
});

/* ==================================================================== */
/* R87-08 · 5xx 不回显原始 err.message                                      */
/* ==================================================================== */

test('R87-08 · 全局错误处理器对 5xx 必须换成固定文案（expose 除外）', () => {
  const lines = codeLines(read('server/index.js'));
  const guard = lines.find((l) => /if \(status >= 500 && !err\.expose\) msg = '服务器内部错误';/.test(l));
  assert(guard,
    'R87-08：未分类异常带着 fs/net 的原始 message（Windows 上是 `ENOENT … C:\\Users\\…\\data\\config.enc`，'
    + 'Linux 上是 `/opt/kepler/data/…`），而 `pwa.js`、`routes/stats.js` 都是**无鉴权**入口，'
    + '匿名请求就能读到部署路径');
  const hasFullLeak = lines.some((l) => /res\.status\(status\)\.json\(\{ error: err\.message/.test(l));
  assert(!hasFullLeak, 'R87-08：不得在 5xx 分支直传 err.message');

  const s3src = read('server/s3.js');
  assert(/err\.expose = true;/.test(s3src),
    'R87-08：`translateError()` 产出的是固定文案，必须显式 expose —— 否则护栏退化成「一律不给」，'
    + '用户看不到「签名错误，请检查 AccessKey / SecretKey」这类可执行的提示');
});

/* ==================================================================== */
/* R87-09 · 目录 rename / move 按快照删源                                   */
/* ==================================================================== */

test('R87-09 · `deleteKeysAll` 只删给定的 key（不做任何重新列举）', async () => {
  const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
  const deleted = [];
  const client = {
    deleteMultipleObject(params, cb) {
      const keys = params.Objects.map((o) => o.Key);
      deleted.push(keys);
      cb(null, { Deleted: keys.map((k) => ({ Key: k })) });
    },
  };
  const marked = [];
  const r = await gateway.deleteKeysAll(client, { bucket: 'b', region: 'r' },
    ['dir/a.txt', 'dir/b.txt'], (ks) => marked.push(...ks));
  assertEqual(r.count, 2, 'R87-09：两个 key 都必须真删');
  assertEqual(r.truncated, false, 'R87-09：全部成功时不得报「未删干净」');
  assertEqual(JSON.stringify(deleted), JSON.stringify([['dir/a.txt', 'dir/b.txt']]),
    'R87-09：只允许删**给定的快照**，绝不能按前缀重新列举后再删');
  assertEqual(marked.length, 2, 'R87-09：确认删除的 key 必须交给回调（清解密元数据 / 标分享失效）');

  /* ---- 失败必须如实上报，不能被当成成功 ---- */
  const halfClient = {
    deleteMultipleObject(params, cb) {
      cb(null, { Deleted: [{ Key: params.Objects[0].Key }], Error: [{ Key: params.Objects[1].Key, Message: 'denied' }] });
    },
  };
  const r2 = await gateway.deleteKeysAll(halfClient, { bucket: 'b', region: 'r' }, ['x', 'y'], null);
  assertEqual(r2.count, 1, 'R87-09：只算云端确认删除的');
  assertEqual(r2.truncated, true, 'R87-09：有对象没删掉必须置 truncated，不能静默当成功');
});

test('R87-09b · rename / move 的目录分支必须接 `deleteKeysAll`，不得再按前缀重列', () => {
  const lines = codeLines(read('server/routes/fs.js'));
  const snapshotDeletes = lines.filter((l) => /gateway\.deleteKeysAll\(client, cfg, items\.map/.test(l)).length;
  assertEqual(snapshotDeletes, 2, `R87-09b：rename 与 move 两条分支都要改成快照删除，实际 ${snapshotDeletes} 处`);
  const reListDeletes = lines.filter((l) => /gateway\.deletePrefixAll\(client, cfg, key, \(ks\) => shareStore\.markMissingByKeys/.test(l)).length;
  assertEqual(reListDeletes, 0,
    'R87-09b：rename / move 不得再在「复制快照 → 删源」之间按前缀重新列举 —— 窗口内新上传的对象'
    + '没被复制却会被删掉（静默、不可逆的数据丢失）');
});

/* ==================================================================== */
/* R87-10 · sliceCopyFile 开工前拒超 10000 片                                */
/* ==================================================================== */

test('R87-10 · 超出 10000 片的复制必须在**第一个请求之前**失败', async () => {
  const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));
  let inits = 0;
  let sends = 0;
  const fake = {
    // FUN-10：HEAD 走 `_head()`（返回 fetch 形状的 Response），不经过 `headObject`
    _head() {
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers({ 'content-length': String(700 * 1024 * 1024 * 1024) }),
      });
    },
    multipartInit(params, cb) { inits += 1; cb(null, { UploadId: 'u1' }); },
    _send() {
      sends += 1;
      return Promise.resolve('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>');
    },
  };
  // 借用真实原型的 sliceCopyFile，只替换它依赖的 I/O
  const src = S3Client.prototype.sliceCopyFile;
  const client = Object.assign(Object.create(S3Client.prototype), fake, { timeout: 1000, fixedPartBytes: 64 * 1024 * 1024 });
  const err = await new Promise((resolve) => {
    client.sliceCopyFile({ Bucket: 'b', Key: 'dst', CopySource: 'b/src', PartSize: 64 * 1024 * 1024 })
      .then(() => resolve(null), resolve);
  });
  assert(err, 'R87-10：>640GB（64MB 分片下 10001 片）必须报错，而不是传完 10000 片才失败');
  assertEqual(err.status, 400, 'R87-10：这是参数问题，必须是 400 且文案可直接给用户看');
  assertEqual(inits, 0, 'R87-10：必须在 multipartInit **之前**就拒绝（否则已经开始产生云端状态）');
  assertEqual(sends, 0, 'R87-10：一个分片都不许传');
  assert(src && typeof src === 'function', 'R87-10：前置事实 —— sliceCopyFile 仍存在');
});

/* ==================================================================== */
/* R87-11 · 限速并发计数懒登记                                              */
/* ==================================================================== */

test('R87-11 · 限速环节的并发计数必须「真有数据流过」才登记', () => {
  const src = read('server/throttle.js');
  const lines = codeLines(src);
  const factoryInc = lines.findIndex((l) => /^  b\.active = \(b\.active \|\| 0\) \+ 1;$/.test(l));
  assertEqual(factoryInc, -1,
    'R87-11：工厂里就 +1 是泄漏源 —— 调用方「先建环节、再接线」，中间任何一步失败都会'
    + '直接 return，`close` 永不触发，计数永久 +1；反复请求不存在的路径即可把同一个键的'
    + '合法下载压到 10 B/s 量级，进程内永不自愈');
  const inTransform = lines.findIndex((l) => /if \(!registered\) \{ registered = true; b\.active = \(b\.active \|\| 0\) \+ 1; \}/.test(l));
  assert(inTransform > 0, 'R87-11：登记必须搬进 transform 回调');
  const guardedDec = lines.findIndex((l) => /^\s+if \(registered\) \{$/.test(l));
  assert(guardedDec > inTransform, 'R87-11：退出计数必须与登记对称（没登记过不许减，否则会打成负数）');
});

/* ==================================================================== */
/* R87-12 · bufferStream 提前关闭必须结算                                   */
/* ==================================================================== */

test('R87-12 · 上传流提前关闭必须拒绝 Promise（否则写信号量槽位永久泄漏）', async () => {
  const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from('abc'));
  const p = gateway.__test__.bufferStream ? gateway.__test__.bufferStream(stream, 1024) : null;
  assert(p, 'R87-12：前置事实 —— bufferStream 必须可被测试直接驱动');
  // 模拟「客户端半途中止」：只有 close，没有 end/error
  setImmediate(() => { stream.destroy(); });
  /**
   * 与一个 ref 的定时器赛跑：旧实现下这个 Promise **永不结算**，直接 await 会把整个
   * 测试进程挂死（变异验证时表现为「跑到这里就不动了」而不是「变红」）。
   */
  const err = await Promise.race([
    p.then(() => null, (e) => e),
    new Promise((resolve) => { setTimeout(() => resolve('PENDING'), 800); }),
  ]);
  assert(err && err !== 'PENDING',
    'R87-12：半途断开的流必须让 Promise **结算为失败** —— 旧实现只监 end/error，'
    + '`await bufferStream()` 永不返回，`finally { release() }` 不执行，MAX_WRITE_STREAMS(=2) 的'
    + '槽位被占死；断两次后所有 WebDAV 写入一起挂死');

  /* ---- 正向对照：正常读完必须成功 ---- */
  const ok = new Readable({ read() {} });
  ok.push(Buffer.from('hello'));
  ok.push(null);
  const buf = await gateway.__test__.bufferStream(ok, 1024);
  assertEqual(buf.toString(), 'hello', 'R87-12：正常结束不得被判成「提前关闭」');
});

/* ==================================================================== */
/* R87-13 · normalizeKey 的 .. 判据                                          */
/* ==================================================================== */

test('R87-13 · `normalizeKey` 必须允许 `a..b.txt`、拒绝 `..` 段与 NUL', () => {
  const s3 = require(path.join(ROOT, 'server', 's3.js'));
  assertEqual(s3.normalizeKey('docs/a..b.txt'), 'docs/a..b.txt',
    'R87-13：`a..b.txt` / `report..final.pdf` 是合法命名，按子串判 `..` 会把它们一起拒掉（400 且文案看不懂）');
  assertEqual(s3.normalizeKey('report..final.pdf'), 'report..final.pdf', 'R87-13：同上');
  assert.throws(() => s3.normalizeKey('../etc/passwd'), /不能包含 \.\./,
    'R87-13：`..` 整段仍必须拒绝（穿越防线不得为了放行合法名而失效）');
  assert.throws(() => s3.normalizeKey('a/../b'), /不能包含 \.\./, 'R87-13：中段的 `..` 同样拒绝');
  assert.throws(() => s3.normalizeKey('a\u0000b'), /空字符/,
    'R87-13：NUL 会让 list-cache / search-candidates 的缓存键撞车（`a\\0b` 与 `ab` 同键）');
});

/* ==================================================================== */
/* R87-14 · 前端三处回退 label / data-id / methods 必须转义                  */
/* ==================================================================== */

test('R87-14 · 徽章 label、桶列表 data-id、IP 规则方法单元格都必须转义', () => {
  const files = {
    'public/js/ordermgr.js': /\$\{escapeHtml\(sm\.label\)\}/,
    'public/js/couponmgr.js': /\$\{escapeHtml\(sm\.label\)\}/,
  };
  for (const [f, re] of Object.entries(files)) {
    const lines = codeLines(read(f));
    assert(lines.some((l) => re.test(l)), `R87-14：${f} 的徽章 label 必须经 escapeHtml`);
    assert(!lines.some((l) => /\$\{sm\.label\}/.test(l) && !/escapeHtml\(sm\.label\)/.test(l)),
      `R87-14：${f} 仍有未转义的 sm.label 插值`);
  }
  const main = codeLines(read('public/js/main.js'));
  assert(!main.some((l) => /data-id="\$\{b\.id\}"/.test(l)), 'R87-14：main.js 的桶列表 data-id 必须转义');
  assert(main.some((l) => /data-id="\$\{escapeHtml\(b\.id\)\}"/.test(l)), 'R87-14：同上（正向）');
  const ipmgr = codeLines(read('public/js/ipmgr.js'));
  assert(ipmgr.some((l) => /\$\{escapeHtml\(m\)\}/.test(l)), 'R87-14：ipmgr 的 methods 单元格必须转义');
});

/* ==================================================================== */
/* R87-15 · /api/health 只下发 basename                                     */
/* ==================================================================== */

test('R87-15 · `/api/health` 的 secureWriteError 只下发文件名', () => {
  const lines = codeLines(read('server/routes/stats.js'));
  const assign = lines.find((l) => /out\.secureWriteError = Object\.assign\(\{\}, secureErr/.test(l));
  assert(assign,
    'R87-15：`getLastWriteError()` 原样带着绝对路径，而 `/health` 只要求登录 —— '
    + '任何普通用户都能读到本实例的磁盘布局与数据目录');
  const tail = lines.slice(lines.indexOf(assign), lines.indexOf(assign) + 3).join('\n');
  assert(/basename/.test(tail), 'R87-15：必须取 `path.basename()`（与 secure-store 自己打日志的口径一致）');
  assert(!lines.some((l) => /out\.secureWriteError = secureErr;/.test(l)), 'R87-15：不得再直传整对象');
});
