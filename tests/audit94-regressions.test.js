/**
 * 第九十四轮护栏：**逐条复核《全模块安全与功能缺陷审计报告》**（MiniMax M3.1-Flash）
 *
 * ## 这一轮的性质与以往不同
 *
 * 前九十三轮都是「对着一个具体 bug 修」，本轮是**对着 90 条外部审计结论逐条判定**
 * 存在性：成立的修、不成立的写进 `Audit_illusion_report.md`。因此这里只覆盖
 * **「确实成立且已修」**的那部分，每一条都对着一个**具体的失败后果**，而不是
 * 「代码里有这段字样」。
 *
 * ## 判据落点（为什么这么选）
 *
 *  · **行为层**（首选）：`safeView` 的角色裁剪、桶名校验、R2 账户 ID、金额换算、
 *    明文锁接管、XML 控制字符、gzip 回调 —— 这些都是能直接驱动纯函数 / 单模块
 *    观察到的，绝不退化成源码字符串比对。
 *  · **调用点层**（次选）：像 `/auth/forgot` 用 `publicError` 而不是 `error`、
 *    `moveOneObject` 的「先删源后搬元数据」这类**顺序就是判据本身**的，
 *    只能落在源码上 —— 但会把注释抹成等长空格后再比对（否则注释就能满足断言，
 *    这是本项目踩过多次的假绿形态）。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const fs = require('fs');
/* eslint-disable no-template-curly-in-string -- 本文件里有若干「源码字面量」锚点，
   里面的 `${...}` 必须保持**未求值**（它们要逐字匹配被测源码，而不是被 JS 展开）。 */
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r94-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);

/** 把 `//` 与 `/* *\/` 注释抹成**等长空格**（保留行号与偏移，anchor 不会因注释失配） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const configStore = require(SERVER('config-store.js'));
const providers = require(SERVER('providers.js'));

/* ================================================================== *
 * ① M03：发信拓扑只给管理员 / 匿名端点不回显内部诊断
 * ================================================================== */

test('R94-01 · M03-03：`safeView` 的 smtp 段只下发给管理员（普通用户拿 null）', () => {
  configStore.saveSmtp({
    host: 'mail.internal.corp', port: 587, user: 'u@x.com', password: 'PW-XYZ', from: 'a@b.com', fromName: 'K',
  });
  const admin = configStore.safeView('admin');
  assert(admin.smtp && admin.smtp.host === 'mail.internal.corp', '管理员必须拿到 smtp 段（发信设置卡片要用）');
  assert(!/PW-XYZ/.test(JSON.stringify(admin)), '任何角色的响应体都不得出现 SMTP 口令明文');

  const user = configStore.safeView('user');
  assertEqual(user.smtp, null, '普通用户不得拿到 smtp 段 —— 它含主机/端口/账号，属基础设施拓扑');
  assert(!/mail\.internal\.corp/.test(JSON.stringify(user)), '普通用户的整个响应体里都不得出现 SMTP 主机名');
  // 正向对照：同一份配置下 `site` 段仍然要给普通用户（前端标题栏要用）
  assert(user.site && typeof user.site.siteName === 'string', '裁剪只能裁 smtp，不能顺手把 site 也裁了');
});

test('R94-02 · M03-02：探针失败时匿名端点只回**类别**，主机/端口/服务端原文只留在详情版', async () => {
  const emailCode = require(SERVER('email-code.js'));
  const smtp = require(SERVER('smtp.js'));
  configStore.saveSmtp({
    enabled: true, host: 'mail.internal.corp', port: 587, secure: false,
    user: 'u@x.com', password: 'PW-XYZ', from: 'a@b.com', fromName: '',
  });
  const realVerify = smtp.verify;
  try {
    smtp.verify = async () => {
      const e = new Error('连接 SMTP 服务器 mail.internal.corp:587 失败（建连）：getaddrinfo ENOTFOUND');
      throw e;
    };
    const r = await emailCode.probeMailer();
    assertEqual(r.ok, false);
    // 详情版仍然带主机端口（管理员接口与日志要用它排查）
    assertMatch(r.error, /mail\.internal\.corp:587/, '详情版必须保留可定位信息');
    // 对外版只给类别：既不含主机端口，也不含服务端可控原文
    assert(r.publicError, '必须给出 publicError —— 匿名端点只能回这一份');
    assert(!/mail\.internal\.corp/.test(r.publicError), '对外文案不得出现 SMTP 主机名');
    assert(!/:587/.test(r.publicError), '对外文案不得出现 SMTP 端口');
    assertMatch(r.publicError, /系统发信当前不可用/, '仍然要让用户看懂「现在发不出去」');
  } finally {
    smtp.verify = realVerify;
  }
});

test('R94-03 · M03-05：健康探针必须把「本次连接加没加密」透出来', async () => {
  const emailCode = require(SERVER('email-code.js'));
  const smtp = require(SERVER('smtp.js'));
  configStore.saveSmtp({
    enabled: true, host: 'mail.corp', port: 25, secure: false,
    user: '', password: '', from: 'a@b.com', fromName: '',
  });
  const realVerify = smtp.verify;
  try {
    smtp.verify = async () => ({ ok: true, encrypted: false, authUsed: '' });
    const r = await emailCode.probeMailer();
    assertEqual(r.ok, true);
    assertEqual(r.encrypted, false, '明文链路必须在探针结果里如实体现（旧实现丢弃了这个字段）');
    smtp.verify = async () => ({ ok: true, encrypted: true, authUsed: 'PLAIN' });
    assertEqual((await emailCode.probeMailer()).encrypted, true, '加密链路同理（正向对照）');
  } finally {
    smtp.verify = realVerify;
  }
});

test('R94-04 · M03-06：邮箱验证码有一条**按用户**的日配额（换地址换 IP 都绕不过）', () => {
  const security = require(SERVER('security.js'));
  let last = null;
  for (let i = 0; i < 20; i++) last = security.emailCodeUserLimiter('u:r94-user');
  assertEqual(last.ok, true, '20 次以内应当放行（正常改邮箱顶多 2~3 封）');
  const over = security.emailCodeUserLimiter('u:r94-user');
  assertEqual(over.ok, false, '第 21 次必须被拒 —— 否则「换一批地址」就能无限发信');
  assert(over.retryAfter > 0, '拒绝时必须给出重试间隔');
  assertEqual(security.emailCodeUserLimiter('u:r94-other').ok, true, '配额按用户隔离，不能殃及他人');
});

/* ================================================================== *
 * ② M04：备份导入 / 默认配置 / 单实例锁 / 敏感文件
 * ================================================================== */

test('R94-05 · M04-01：备份**不搬运**桶级端点，且桶视图把它暴露出来（看得见）', () => {
  const backup = require(SERVER('backup.js'));
  configStore.save({
    buckets: [{
      id: 'b1', provider: 'tencent', bucket: 'r94-bucket', region: 'ap-guangzhou',
      endpoint: 'https://attacker.example.com', enabled: true, visibleToUsers: true,
    }],
    activeBucketId: 'b1',
  });
  const data = backup.collect();
  assertEqual(data.buckets.buckets[0].endpoint, '',
    '导出码里不得带桶级端点 —— 它是「导入别人导出码」这条攻击链的载体');
  // 凭据级端点仍要保留（S3 兼容厂商的正常配置项，界面上可见可改）
  configStore.save({
    credentials: [{ id: 'c1', provider: 'minio', secretId: 'ak', secretKey: 'sk', endpoint: 'https://minio.example.com' }],
    activeCredentialId: 'c1',
  });
  assertEqual(backup.collect().credentials.credentials[0].endpoint, 'https://minio.example.com',
    '凭据端点必须原样搬运（正向对照：不能把该留的也丢了）');
  // 已经落库的历史数据要「看得见」
  const view = configStore.listBuckets().buckets.find((b) => b.id === 'b1');
  assert(view && 'endpoint' in view, 'bucketView 必须带 endpoint 字段，否则管理员无法发现被植入的端点');
});

test('R94-06 · M04-02：`DEFAULT_CONFIG` 模板不会被运行期写入污染（删配置不再「复活」旧账户）', async () => {
  const D = configStore.DEFAULT_CONFIG;
  assertEqual(D.users.length, 0, '自证：模板初始应为空');
  assertEqual(D.credentials.length, 0);
  // 注意：`addUser` 是 async（内部先算 scrypt），必须 await —— 不 await 时它连
  // 「取 store」都还没走到，`D.users.length === 0` 会无条件成立，护栏等于没写。
  await configStore.addUser({ username: 'r94-pollute', password: 'Unit!2026abc', role: 'root' });
  configStore.addCredential({ provider: 'tencent', secretId: 'AKIDr94', secretKey: 'SKR94' });
  assertEqual(D.users.length, 0, '写用户不得写进模块级模板（否则删 config.enc 后旧账户会复活）');
  assertEqual(D.credentials.length, 0, '写密钥同理（明文 SecretKey 会在常量里留第二份副本）');
  const fresh = configStore.defaultConfig();
  assert(fresh.users !== D.users, '工厂必须每次给出**新的**数组，不能与模板共享引用');
  assert(Object.isFrozen(D.users), '模板本身应当冻结 —— 万一有人再往里 push，应当当场抛错而不是悄悄污染');
});

test('R94-07 · M04-03：残留锁的 pid 恰好等于本进程时**必须接管**（容器里 pid 恒为 2）', () => {
  const lockPath = path.join(tmp.dir, '.instance.lock');
  /**
   * 造一份**上一轮生命期**留下的锁：pid 与本进程相同（容器里恒为 2），
   * 但 `procStartAt` / `startedAt` 都是一小时前 —— 这正是「上次非优雅退出」的现场。
   *
   * 判据不能只看 pid：同 pid 也可能是「本进程生命期内被写下的锁」，那属于
   * 上一位持有者的正常状态，不该被抢。两者的区别只在**生命期**上，所以这里
   * 必须把时间也造对，否则这条用例根本测不到 R94-07 要修的那个场景。
   */
  const anHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, startedAt: anHourAgo, procStartAt: anHourAgo,
  }));
  // 必须重新加载模块：`held` 是模块内状态，同一进程内只能 acquire 一次
  delete require.cache[require.resolve(SERVER('instance-lock.js'))];
  const lock = require(SERVER('instance-lock.js'));
  const r = lock.acquire();
  assertEqual(r.ok, true, '同一 pid 的**上一轮**残留锁必须被接管 —— 否则非优雅退出后实例永久起不来');
  assertMatch(fs.readFileSync(lockPath, 'utf8'), new RegExp(`"pid":${process.pid}`), '接管后锁内容应为本次进程');
  const written = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert(Number.isFinite(Date.parse(written.procStartAt)),
    '接管时要把本次的 procStartAt 一起写回 —— 否则下一次启动又退化成「只看 pid」');
  lock.release();

  // 反面（不得过度修正）：**本进程生命期内**写下的锁不是残影 —— 不得抢占别人的持有状态
  // （crypto-storage.test.js 的 instance-lock 用例守的正是这一侧）
  delete require.cache[require.resolve(SERVER('instance-lock.js'))];
  const lock2 = require(SERVER('instance-lock.js'));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assertEqual(lock2.acquire().ok, false,
    '同一生命期的锁（startedAt 晚于本进程启动）必须按「已持有」拒绝 —— 判据是生命期，不是 pid 相等');
  try { fs.unlinkSync(lockPath); } catch (e) { /* ignore */ }
});

test('R94-08 · M04-04：WebDAV 账户的**空间绑定**随备份搬运，绑不到用户时拒绝导入而不是静默扩权', async () => {
  const backup = require(SERVER('backup.js'));
  const me = await configStore.addUser({ username: 'r94-alice', password: 'Unit!2026abc', role: 'user' });
  assert(me && me.id, '自证：用户已建立（addUser 是 async，漏 await 会拿到 Promise）');
  const acc = configStore.addWebdavAccount({ appName: 'app', username: 'u1', password: 'pw-123456', ownerUserId: me.id });
  const data = backup.collect();
  const exported = data.webdav.accounts.find((a) => a.username === 'u1');
  assertEqual(exported.ownerUserId, me.id, '导出必须带上绑定关系（否则导入后最小权限账户变整桶权限）');
  assert(acc && acc.id, '自证：账户已创建');

  // 目标实例上找不到该用户 ⇒ 该账户不得被导入（并如实回报）
  configStore.removeUser(me.id);
  const sum = await backup.apply(data);
  const names = (configStore.getWebdav().accounts || []).map((a) => a.username);
  assert(!names.includes('u1'), '绑定的用户在目标实例上不存在时，不得把该账户落成「未绑定」（= 整桶权限）');
  assert(Array.isArray(sum.webdavSkipped) && sum.webdavSkipped.includes('u1'),
    '被跳过的账户必须出现在摘要里 —— 静默消失同样不可接受');
});

test('R94-09 · M04-05：`readJson` 遇到「读之前刚被删掉」应回落到 fallback，而不是永久锁死写入', () => {
  const secureStore = require(SERVER('secure-store.js'));
  const target = path.join(tmp.dir, 'r94-gone.json');
  const realExists = fs.existsSync;
  const realRead = fs.readFileSync;
  try {
    // 精确复刻那条 TOCTOU：existsSync 说「在」，readFileSync 却抛 ENOENT
    fs.existsSync = (p) => (p === target ? true : realExists(p));
    fs.readFileSync = (p, enc) => {
      if (p === target) {
        const e = new Error(`ENOENT: no such file or directory, open '${p}'`);
        e.code = 'ENOENT';
        throw e;
      }
      return realRead(p, enc);
    };
    const out = secureStore.readJson(target, { fallback: true });
    assertEqual(out.fallback, true, 'ENOENT = 「已经不存在」，与「存在但读不出来」相反，必须回落');
  } finally {
    fs.existsSync = realExists;
    fs.readFileSync = realRead;
  }
});

/* ================================================================== *
 * ③ M05：桶名 / R2 账户 ID / 先校验后落值
 * ================================================================== */

test('R94-10 · M05-01：含 `/` 的桶名一律拒绝（它是绕过 endpoint-guard 的唯一通道）', () => {
  for (const bad of ['169.254.169.254/x', 'evil.example/x', 'a/../../evil', '..', 'a b', 'a:b']) {
    assertEqual(providers.isValidBucketName(bad), false, `桶名「${bad}」必须判非法`);
    let threw = null;
    try {
      configStore.addBucket({ provider: 'tencent', bucket: bad, region: 'ap-guangzhou' });
    } catch (e) { threw = e; }
    assert(threw && threw.status === 400, `addBucket 必须对「${bad}」抛 400，实际：${threw && threw.message}`);
  }
  // 正向对照：真实桶名（含腾讯云 APPID 后缀、点、下划线、连字符）必须全部放行
  for (const good of ['mybucket-1250000000', 'a.b_c', 'A1']) {
    assertEqual(providers.isValidBucketName(good), true, `合法桶名「${good}」不得被误伤`);
  }
  const saved = configStore.addBucket({ provider: 'tencent', bucket: 'r94-ok-1250000000', region: 'ap-guangzhou' });
  assertEqual(saved.bucket, 'r94-ok-1250000000', '合法桶名应能正常落库');
});

test('R94-11 · M05-02：R2 的「账户 ID」含 `/` 时组装端点必须报 400（否则主机被改写）', () => {
  for (const bad of ['evil.example/x', 'evil.example/', '169.254.169.254']) {
    let threw = null;
    try { providers.composeEndpoint('r2', bad); } catch (e) { threw = e; }
    assert(threw && threw.status === 400, `「${bad}」必须被拒（拼出来会得到 https://evil.example/...）`);
  }
  const ok = providers.composeEndpoint('r2', '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');
  assertEqual(ok, 'https://1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.r2.cloudflarestorage.com', '合法账户 ID 仍要正确组装');
});

test('R94-12 · M05-03：被 400 拒绝的更新**不得**在内存 / 磁盘上留下脏值（先校验后落值）', () => {
  const cred = configStore.addCredential({ provider: 'aliyun', secretId: 'AKr94aliyun', secretKey: 'sk' });
  let threw = null;
  try {
    // 同时改厂商 + 给一个明文 http 端点：端点校验必失败
    configStore.updateCredential(cred.id, { provider: 'minio', endpoint: 'http://minio.internal:9000' });
  } catch (e) { threw = e; }
  assert(threw, '明文 http 端点必须被拒');
  const after = configStore.load().credentials.find((c) => c.id === cred.id);
  assertEqual(after.provider, 'aliyun', '被拒的更新不得改写 provider（否则真实密钥会被发往另一家厂商的端点）');
  assertEqual(after.endpoint, '', '端点同理不得被写入');
});

test('R94-13 · M05-06：`addBucket` 引用不存在的 credentialId 必须 400，不许回退默认厂商', () => {
  let threw = null;
  try {
    configStore.addBucket({
      provider: '', bucket: 'r94-dangling', region: 'ap-guangzhou', credentialId: 'no-such-credential',
    });
  } catch (e) { threw = e; }
  assert(threw && threw.status === 400, '悬空 credentialId 必须显式失败（静默兜底会让桶挂到别的账号上）');
  assertMatch(threw.message, /密钥不存在/, '文案要指得出问题所在');
  assertEqual(configStore.listBuckets().buckets.some((b) => b.bucket === 'r94-dangling'), false,
    '被拒的桶不得留下任何记录');
});

/* ================================================================== *
 * ④ M06 / M07 / M11 / M13：入口守卫与输出卫生
 * ================================================================== */

test('R94-14 · M06-01：单对象移动的顺序必须是「复制 → 删源成功 → 才搬元数据」', () => {
  const src = stripComments(fs.readFileSync(SERVER('routes', 'fs.js'), 'utf8'));
  const from = src.indexOf('async function moveOneObject(');
  const to = src.indexOf('async function copyBatch(');
  assert(from > 0 && to > from, '自证：应当能取到 moveOneObject 的实现段');
  const body = src.slice(from, to);
  const iDel = body.indexOf("'deleteObject'");
  const iRename = body.indexOf('encStore.renameMeta(');
  assert(iDel > 0 && iRename > 0, '自证：段内应当同时有删源与搬元数据两步');
  assert(iDel < iRename,
    '删源必须在 renameMeta 之前 —— 反过来的话删源失败会让源对象「还在云端但已无解密凭据」');
  assert(body.includes('removeMetaBatch('), '删源失败必须有回滚（撤掉目标凭据）');
  // 两条分支都必须走这个唯一实现点
  const uses = (src.match(/await moveOneObject\(/g) || []).length;
  assertEqual(uses, 2, `rename / move 两条文件分支都必须走 moveOneObject()，实际 ${uses} 处`);
});

test('R94-15 · M06-02/04/05 + M06-07：下载日志取传输结束后的字节；冲突载荷剥空间根；上传挡空路径', () => {
  const src = stripComments(fs.readFileSync(SERVER('routes', 'fs.js'), 'utf8'));
  // ① 下载审计：字节数必须在 close 之后读
  assert(src.includes("res.once('close', logDownload)"),
    '下载审计日志必须挂到响应收尾 —— 否则恒为「0 字节」（await 早于 body 传输）');
  // ② 冲突载荷：进出一律相对
  assert(src.includes('target: relKey(cfg.spaceRoot, p.newKey)'),
    '/fs/copy 的冲突载荷必须剥空间根（旧实现把 u/<uid>/ 露给普通用户）');
  assert(src.includes('const d = decisions ? decisions[rel] : null'),
    'decisions 的查找键要与回显的相对路径一致，否则「覆盖 / 跳过」点了没反应');
  // ③ 空路径守卫（两条上传入口各一条）
  assert(src.includes("if (!relIn) throw badRequest('路径不能为空')"), '/fs/upload/simple 必须挡空路径');
  assert(src.includes("if (!rel) throw badRequest('路径不能为空')"), '/fs/upload/init 必须挡空路径');
  // ④ marker 规范化
  assert(src.includes('const markerRel = normalizeKey(String(req.query.marker || \'\'))'),
    '/fs/list 的 marker 必须过 normalizeKey（否则与 list-cache 的剥 NUL 组合会撞缓存键）');
});

test('R94-16 · M06-06：gzip 中间件必须把 `res.write` 的回调透传下去', async () => {
  const gzip = require(SERVER('gzip.js'));
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.headersSent = false;
  const headers = {};
  res.setHeader = (k, v) => { headers[k] = v; };
  res.getHeader = (k) => headers[k] || '';
  const origWrite = (chunk, enc, cb) => { if (typeof cb === 'function') cb(); return true; }; // 原始 write 会回调
  res.write = origWrite;
  res.end = () => {};
  /**
   * 路径必须**命中压缩判定**：`shouldCompress()` 对 `/api` 前缀直接放行，对静态资源
   * 走扩展名白名单 —— 而 `/` 的扩展名是空串、不在白名单里。旧写法传的就是 `'/'`，
   * 于是中间件第一行 `return next()` 就退出了，**根本没有包裹 `res.write`**，
   * `cbCalled` 由测试自己的桩满足 ⇒ 断言恒真（护栏比名字弱，反向变异实测 fail=0）。
   */
  const req = { method: 'GET', headers: { 'accept-encoding': 'gzip' }, url: '/api/ping', path: '/api/ping' };
  let nextCalled = false;
  gzip.gzipMiddleware(req, res, () => { nextCalled = true; });
  assertEqual(nextCalled, true, '自证：中间件应当放行（该路径命中压缩判定）');
  assert(res.write !== origWrite,
    '自证：命中压缩判定后必须真的**包裹** res.write —— 否则下面那条断言测的是测试自己的桩');
  let cbCalled = false;
  res.write('hello', 'utf8', () => { cbCalled = true; });
  await new Promise((r) => setImmediate(r));
  assertEqual(cbCalled, true, '`res.write` 的回调必须被调用 —— 旧实现把它直接丢掉了');
});

test('R94-17 · M11-02：XML 1.0 非法控制字符必须被剥掉（否则整个 PROPFIND 非良构）', () => {
  const { xmlEsc } = require(SERVER('webdav', 'util.js'));
  const out = xmlEsc('a\u0001b<c&d');
  assertEqual(out, 'ab&lt;c&amp;d', '控制字符丢弃、`<` 与 `&` 仍要转义');
  assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out), '输出里不得残留 XML 非法字符');
  // 正向对照：\t \n \r 是 XML 合法的，不该被吞
  assertEqual(xmlEsc('a\tb'), 'a\tb', '制表符/换行/回车属合法字符，不得误删');
});

test('R94-18 · M13-01：`/health` 的写失败文案不得回显绝对路径', () => {
  const src = stripComments(fs.readFileSync(SERVER('routes', 'stats.js'), 'utf8'));
  assert(src.includes("message: '敏感数据文件写入失败（详见服务端日志）'"),
    '必须用固定文案替换原始 fs 错误（Node 的 message 里带绝对路径与系统用户名）');
  assert(!/Object\.assign\(\{\}, secureErr/.test(src),
    '不得再用「在旧对象上覆盖一个字段」的写法 —— 其余字段会原样带出（R87 那次的漏改点）');
});

test('R94-19 · M12-01：IP 规则的限速值必须过 `parseSpeedLimitInput`，`null` 视同「未传」', () => {
  const src = stripComments(fs.readFileSync(SERVER('routes', 'ipguard.js'), 'utf8'));
  assert(src.includes("require('../limits')"), '必须复用 limits 的判据（唯一实现点）');
  const posts = (src.match(/const sp = speedLimitOf\(b\);/g) || []).length;
  assertEqual(posts, 2, `新增与修改两条路由都要过判据，实际 ${posts} 处`);
  assert(src.includes('b.speedLimit === undefined || b.speedLimit === null'),
    '`null` 必须视同「未传」—— 它会让 coerceSpeedLimit 把生效中的限速归零');
});

test('R94-20 · M12-02：IP 规则的方法词表必须含 WebDAV 动词', () => {
  const ipGuard = require(SERVER('ip-guard.js'));
  for (const m of ['PROPFIND', 'MOVE', 'COPY', 'MKCOL', 'PROPPATCH']) {
    assertEqual(ipGuard.ALLOWED_METHODS.includes(m), true,
      `「${m}」是真正读写数据的方法，缺了它「只屏蔽读/写」的规则在 WebDAV 端口被绕过`);
  }
  assertEqual(ipGuard.ALLOWED_METHODS.includes('GET'), true, '正向对照：REST 动词必须还在');
});

test('R94-21 · M10-04：元 → 分的换算对三位小数不再少算 1 分', () => {
  const { yuanToFen } = require(SERVER('limits.js'));
  assertEqual(yuanToFen(1.005), 101, '1.005 元 = 101 分（`Math.round(1.005*100)` 会得 100）');
  assertEqual(yuanToFen(0.145), 15);
  assertEqual(yuanToFen(1.015), 102);
  // 正向对照：两位小数逐值不变（这条改动不得影响任何既有金额）
  for (const [y, f] of [[0.01, 1], [12.34, 1234], [100, 10000], [0.1 + 0.2, 30]]) {
    assertEqual(yuanToFen(y), f, `${y} 元应等于 ${f} 分`);
  }
});

test('R94-22 · M07-06：断点续传按**不可变的 ownerId** 找会话，改名不再失效', () => {
  const sessions = require(SERVER('upload-sessions.js'));
  const s = sessions.create({
    uploadId: 'up-r94', key: 'u/uid1/a.bin', bucket: 'b', region: 'r', size: 10,
    chunkSize: 5, provider: 'tencent', createdBy: 'old-name', ownerId: 'uid1',
  });
  assert(s && s.id, '自证：会话已创建');
  const hit = sessions.findByTarget('u/uid1/a.bin', 10, { ownerId: 'uid1', createdBy: 'new-name' });
  assert(hit && hit.id === s.id, '用户名改了也应当命中（R89 的 ownerId 判据）');
  const miss = sessions.findByTarget('u/uid1/a.bin', 10, { ownerId: 'uid2', createdBy: 'old-name' });
  assertEqual(miss, null, '别的用户不得命中（正向对照：不能放宽成谁都匹配）');
});

/* ================================================================== *
 * 第二批（同轮继续复核）：M08 / M09 / M10 / M11 / M12 / M13
 * ================================================================== */

test('R94-23 · M08-07：日志里的分享链接 id 必须脱敏 —— 它本身就是无口令链接的凭据', () => {
  const stats = require(SERVER('stats-store.js'));
  const full = 'Kx9vQ2mZpLb7RtYwNc4AsE'; // 现代分享链接 id：22 字符 base64url
  const tag = stats.logRef(full);
  assert(tag.length < full.length, '必须比原 id 短');
  assertEqual(tag.slice(-1), '…', '截断要有可见标记，否则运维会把它当成完整 id');
  const prefix = tag.slice(0, -1);
  assertEqual(full.indexOf(prefix), 0, '保留前缀，运维仍能在链接列表里对上号');
  assert(prefix.length <= 6, `最多留 6 位（实际 ${prefix.length}）`);
  assertEqual(stats.logRef(''), '-');
  assertEqual(stats.logRef(null), '-');
  assertEqual(stats.logRef('abcd1234'), 'ab…', '历史 8 字符 id 只能留 2 位（48 位熵里必须留下足够的不确定性）');
  assertEqual(stats.logRef('abcdefgh1234'), 'abcd…');

  // 源码层：分享 / 创建日志里不得再出现**完整**的链接 id 插值
  const share = stripComments(fs.readFileSync(SERVER('share-routes.js'), 'utf8'));
  assertEqual(share.indexOf('链接 ${l.id}'), -1, '日志里的链接 id 必须走 statsStore.logRef()');
  assert(share.indexOf('链接 ${statsStore.logRef(l.id)}') > 0, '自证：确实换成了脱敏写法');
  const links = stripComments(fs.readFileSync(path.join(SERVER('routes'), 'links.js'), 'utf8'));
  assert(links.indexOf('创建分享链接 ${statsStore.logRef(link.id)}') > 0, '创建日志同样要脱敏');
  assertEqual(links.indexOf('删除分享链接 ' + "' + req.params.id"), -1, '删除日志里的 id 也要脱敏');
});

test('R94-24 · M09-07：线程池降级**不是永久**的 —— 冷却过后 configure() 必须能复位', () => {
  const pool = require(SERVER('enc-pool.js'));
  pool._resetForTest();
  assertEqual(pool.configure(1), 1, '自证：正常配置能建池');
  assertEqual(pool.stats().degraded, false);

  pool._resetForTest();
  pool._degradeForTest(5 * 1000); // 5 秒前刚降级
  assertEqual(pool.configure(1), 0, '冷却窗口内不许反复建池（资源紧张时那样会抖成 spawn/失败循环）');
  assertEqual(pool.stats().cooling, true, '运维要能从 stats 里看出「还要等多久才自动重试」');

  pool._degradeForTest(120 * 1000); // 2 分钟前降级 —— 已过冷却窗口
  assert(pool.configure(1) >= 1,
    '冷却过后必须能重新建池：否则一次瞬时线程抖动就把整个进程钉死在主线程同步加密（magic 48MB 一片约 3 秒、全站零响应）');
  assertEqual(pool.stats().degraded, false, '复位后 degraded 必须回到 false');
  pool.shutdown();
});

test('R94-25 · M09-08：线程**根本起不来**时也要退回主线程，而不是把上传打成 500', () => {
  const src = stripComments(fs.readFileSync(SERVER('enc-pool.js'), 'utf8'));

  const i = src.indexOf('function spawnSlot()');
  assert(i > 0, '找不到 spawnSlot');
  const body = src.slice(i, src.indexOf('function runOn', i));
  assertMatch(body, /try\s*\{[\s\S]*new Worker\(WORKER_FILE/,
    '`new Worker()` 必须包在 try 里 —— EMFILE/ENOMEM/pids.max 时它是**同步抛错**');
  assertMatch(body, /catch \(e\) \{[\s\S]*degrade\(e\)[\s\S]*return null/,
    '起不来时要降级并返回 null（让调用方走主线程），而不是把异常继续往上抛');

  const j = src.indexOf('function submit(job)');
  const sbody = src.slice(j, src.indexOf('async function viaPoolOrLocal', j));
  assertMatch(sbody, /if \(!slot\) return null/,
    '`submit()` 不得在槽位为 null 时继续排队 —— 降级后队列没有消费者，塞进去就是永不 resolve 的挂起');

  const v = src.indexOf('async function viaPoolOrLocal');
  assertMatch(src.slice(v, v + 1200), /try \{\s*p = submit\(job\);/,
    '`submit()` 本身也在 try 里 —— 「永远有同步兜底」必须覆盖提交阶段');
});

test('R94-26 · M10-01：台账截断到 200 条后，退款仍能定位、幂等仍成立', () => {
  const couponStore = require(SERVER('coupon-store.js'));
  const c = couponStore.generate({ count: 1, type: 'any', linkIds: [], amountFen: 300, maxUses: 0 })[0];
  couponStore.consume({ couponId: c.id, identity: 'u:first', orderId: 'ORD-FIRST' });
  for (let i = 0; i < 205; i += 1) {
    couponStore.consume({ couponId: c.id, identity: `u:x${i}`, orderId: `ORD-X${i}` });
  }
  const v = couponStore.get(c.id);
  assertEqual(v.uses.length, 200, '自证：台账确实被截断到 200 条');
  assertEqual(v.used, 206, '自证：used 计数是准的');

  couponStore.consume({ couponId: c.id, identity: 'u:first', orderId: 'ORD-FIRST' });
  assertEqual(couponStore.get(c.id).used, 206,
    '同一订单重复核销不得再加 1 —— 旧实现的幂等判据读的正是那份被截断的台账');

  const rel = couponStore.releaseByOrder('ORD-FIRST');
  assert(rel && rel.couponId === c.id,
    '退款必须能定位到早期订单（旧实现返回 null ⇒ 券不退、used 不减，连日志都不留）');
  assertEqual(rel.identity, 'u:first', '回退要带回身份，前面那句「已对该用户恢复可用」才不是空话');
  assertEqual(couponStore.get(c.id).used, 205);
  assertEqual(couponStore.get(c.id).identities.indexOf('u:first'), -1, '退款后该用户应可重新使用');
});

test('R94-27 · M10-02：`consume()` 自身必须挡配额（判据下沉到写点）', () => {
  const couponStore = require(SERVER('coupon-store.js'));

  const c = couponStore.generate({ count: 1, type: 'any', linkIds: [], amountFen: 100, maxUses: 1 })[0];
  couponStore.consume({ couponId: c.id, identity: 'u:a', orderId: 'O-A' });
  const r = couponStore.consume({ couponId: c.id, identity: 'u:b', orderId: 'O-B' });
  assertEqual(r && r.ok, false, '超过 maxUses 必须被拒，而不是无脑 used += 1');
  assertEqual(r.reason, 'used_up');
  assertEqual(couponStore.get(c.id).used, 1, '被拒的核销不得计数');

  const d = couponStore.generate({ count: 1, type: 'any', linkIds: [], amountFen: 100, perUserOnce: true })[0];
  couponStore.consume({ couponId: d.id, identity: 'u:z', orderId: 'P-1' });
  const r2 = couponStore.consume({ couponId: d.id, identity: 'u:z', orderId: 'P-2' });
  assertEqual(r2 && r2.reason, 'already_used', '「每人一次」同样要在写点拦住');

  // 正向对照：正常路径仍然返回券视图（老调用方读 `.code` 不会突然坏掉）
  const e = couponStore.generate({ count: 1, type: 'any', linkIds: [], amountFen: 100 })[0];
  const ok = couponStore.consume({ couponId: e.id, identity: 'u:y', orderId: 'Q-1' });
  assert(ok && ok.code === e.code && ok.used === 1, '成功路径的返回形状必须保持不变');

  // 调用点：建单前要重校验一次（await 窗口真正所在的那一段）
  const share = stripComments(fs.readFileSync(SERVER('share-routes.js'), 'utf8'));
  assert(share.indexOf('const recheck = couponStore.validateForUse(') > 0,
    '建单前必须重校验优惠券 —— 校验与建单之间隔着关旧单的 await');
  assert(share.indexOf('coupon.consume-rejected') > 0, '核销被拒要留审计日志，不能安静地少收一笔钱');
});

test('R94-28 · M11-01：文件复制 / 移动的目标不能是集合（`dir/` 会被占位对象吃掉）', async () => {
  const gateway = require(SERVER('fs-gateway.js'));
  for (const [fn, label] of [['copyObject', '复制'], ['moveObject', '移动']]) {
    let err = null;
    try { await gateway[fn]('bucket', 'z.txt', 'target/', null, null); } catch (e) { err = e; }
    assert(err, `${fn} 必须拒绝以 / 结尾的目标键`);
    assertEqual(err.status, 409, `${fn} 应回 409 Conflict`);
    assert(String(err.message).indexOf('集合') >= 0, `${fn} 的错误文案要点明原因`);
  }

  // WebDAV 侧：按 RFC 4918 §9.8.3 把「Destination 指向集合」翻译成 <集合>/<源名>
  const dav = stripComments(fs.readFileSync(path.join(SERVER('webdav'), 'app.js'), 'utf8'));
  assert(dav.indexOf("if (!srcIsDir && dstKey.endsWith('/'))") > 0,
    'Destination 以 / 结尾时必须走独立分支，不能把 dstKey 直接当目标键');
  assert(dav.indexOf('targetKey = dstKey + base;') > 0, '目标键必须是 <集合>/<源名>');
  assert(dav.indexOf('let targetKey = dstKey;') > 0, '默认（非集合目标）仍然沿用 Destination 本身');
});

test('R94-29 · M11-04：上游游标不前进时必须中止，不能死循环打云端', async () => {
  const listing = require(path.join(SERVER('webdav'), 'listing.js'));
  const cfg = { bucket: 'b', region: 'r' };
  let calls = 0;
  /** 假客户端：永远说「还有」，且 NextMarker 恒定 —— 正是审计描述的异常上游 */
  const stuckClient = {
    getBucket: (params, cb) => {
      calls += 1;
      if (calls > 50) return cb(new Error('游标没前进却一直在翻页 —— 死循环'));
      return cb(null, { Contents: [{ Key: 'a/1.txt', Size: 1 }], IsTruncated: 'true', NextMarker: 'M' });
    },
  };
  const r = await listing.listLevel(stuckClient, cfg, 'a/');
  assertEqual(r.truncated, true, '游标不前进时必须按「结果不完整」上报，而不是假装列完了');
  assert(calls <= 3, `只应迭代极少几轮（实际 ${calls} 轮）`);

  calls = 0;
  let threw = null;
  try {
    await listing.forEachPrefixPage(stuckClient, cfg, 'a/', async () => true);
  } catch (e) { threw = e; }
  assert(threw, 'COPY/MOVE 的驱动循环必须**抛错中止**：静默收尾会让调用方以为已复制完整，随后把源删掉');
  assertEqual(threw.code, 'LIST_CURSOR_STUCK');

  // 正向对照：正常翻页不受影响
  let n = 0;
  const okClient = {
    getBucket: (params, cb) => {
      n += 1;
      if (n === 1) return cb(null, { Contents: [{ Key: 'a/1.txt', Size: 1 }], IsTruncated: 'true', NextMarker: 'a/2' });
      return cb(null, { Contents: [{ Key: 'a/2.txt', Size: 1 }], IsTruncated: 'false' });
    },
  };
  const pages = [];
  await listing.forEachPrefixPage(okClient, cfg, 'a/', async (items) => { pages.push(items.length); });
  assertEqual(pages.length, 2, '两页都要处理到');
});

test('R94-30 · M12-03：带转发头的回环请求不再享有「本机永久放行」豁免', () => {
  const guard = require(SERVER('ip-guard.js'));
  const exempt = guard.evaluate('127.0.0.1', 'GET', null, {});
  assertEqual(exempt.ok, true, '自证：真正的本机直连仍然放行（产品特性保留）');
  assertEqual(exempt.loopbackExempt, true, '并且要能被界面看见「豁免正在生效」');

  const proxied = guard.evaluate('127.0.0.1', 'GET', null, { hasForwarded: true });
  assertEqual(proxied.loopbackExempt, undefined,
    '反代流量（带 X-Forwarded-* 头）不得再被当成「本机」豁免 —— 否则全部屏蔽规则静默失效');
  // 规则仍按 127.0.0.1 参与后续判定（这里没有规则 ⇒ 放行是正常的，但豁免标记必须消失）
  const added = guard.addRule({ target: '127.0.0.1', methods: [], bucketIds: [], enabled: true, kind: 'block' });
  try {
    const blocked = guard.evaluate('127.0.0.1', 'GET', null, { hasForwarded: true });
    assertEqual(blocked.ok, false, '配了规则之后，带转发头的回环请求必须被规则拦下');
    assertEqual(blocked.reason, 'rule');
  } finally {
    // 这条规则落在**共享**的 data 目录里，不删掉会污染本文件后续用例
    if (added && added.id) guard.removeRule(added.id);
  }
  const view = guard.view();
  assertEqual(typeof view.loopbackExempt, 'boolean', 'view() 必须带出「豁免是否在生效」');
});

test('R94-31 · M12-05：客户端中途断开时，计量环节也要把残余字节结算掉', async () => {
  const statsStore = require(SERVER('stats-store.js'));
  const meterMod = require(SERVER('traffic-meter.js'));
  const savedSample = statsStore.sampleTraffic;
  let reported = 0;
  statsStore.sampleTraffic = (up, down) => { reported += down; }; // 护栏直接替换（模块用属性访问调用）
  try {
    const traffic = { bytesDown: 0 };
    const m = meterMod.createTrafficMeter({ bucket: 'b', traffic, intervalMs: 60000 });
    m.write(Buffer.alloc(1024));
    await new Promise((r) => setTimeout(r, 30));
    m.destroy(); // 客户端断开 → pipeline 销毁整条管线，`_flush` 不会执行
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(reported, traffic.bytesDown,
      '中断路径也必须结算：否则统计页的「今日下行」会比审计日志少一截（被限速时偏差被放大）');

    // 正常结束不得重复上报
    reported = 0;
    const t2 = { bytesDown: 0 };
    const m2 = meterMod.createTrafficMeter({ bucket: 'b', traffic: t2, intervalMs: 60000 });
    m2.write(Buffer.alloc(100));
    m2.end(Buffer.alloc(50));
    await new Promise((r) => setTimeout(r, 60));
    assertEqual(reported, t2.bytesDown, '`flush()` 与 `close` 必须互斥，不能算两遍');
  } finally {
    statsStore.sampleTraffic = savedSample;
  }
});

test('R94-32 · M13-06：`DEPLOY_MODE=1` 让「部署模式」与 `HOST` 解耦（改回回环不再静默拆掉 Secure）', () => {
  const { execFileSync } = require('child_process');
  const script = `process.stdout.write(String(require(${JSON.stringify(SERVER('security.js'))}).IS_DEPLOY))`;
  const run = (env) => execFileSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { S3_DATA_DIR: tmp.dir }, env),
    encoding: 'utf8',
  }).trim();

  assertEqual(run({ HOST: '127.0.0.1', DEPLOY_MODE: '1' }), 'true',
    '监听回环 + 显式部署开关 ⇒ 仍是部署模式（否则 HSTS 与 Cookie 的 Secure 会被静默关掉）');
  assertEqual(run({ HOST: '0.0.0.0', DEPLOY_MODE: '' }), 'true', '监听非回环 ⇒ 部署模式（历史行为不变）');
  assertEqual(run({ HOST: '127.0.0.1', DEPLOY_MODE: '' }), 'false', '本地开发仍是非部署模式（历史行为不变）');
});

test('R94-33 · M13-08：`is_ip_addr()` 不得把「含冒号的任意串」当成 IP', () => {
  const { execFileSync } = require('child_process');
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  const fn = src.slice(src.indexOf('is_ip_addr() {'), src.indexOf('\n}\n', src.indexOf('is_ip_addr() {')) + 2);
  const probe = `
set -u
${fn}
for v in "$@"; do if is_ip_addr "$v"; then echo "$v=IP"; else echo "$v=NOT"; fi; done
`;
  const out = execFileSync('bash', ['-c', probe, 'probe',
    '127.0.0.1', '2001:db8::1', '::1', 'foo:bar', 'a:; rm -rf /', '203.0.113.5:443', '999.1.1.1'],
  { encoding: 'utf8' }).trim().split('\n');
  assertEqual(out[0], '127.0.0.1=IP');
  assertEqual(out[1], '2001:db8::1=IP', '真正的 IPv6 字面量要放行');
  assertEqual(out[2], '::1=IP');
  assertEqual(out[3], 'foo:bar=NOT', '旧实现「见冒号就算 IP」，域名校验被整体绕过');
  assertEqual(out[4], 'a:; rm -rf /=NOT', '带分号/空格的串绝不能进 nginx 配置');
  assertEqual(out[5], '203.0.113.5:443=NOT', 'host:port 不是 IP（collect_config 另有专门文案）');
  assertEqual(out[6], '999.1.1.1=NOT', '每段必须在 0-255 内');
});

test('R94-34 · M13-07：`/api/stats/speed` 与 `/api/stats/summary` 必须是管理员专属', () => {
  const src = stripComments(fs.readFileSync(path.join(SERVER('routes'), 'stats.js'), 'utf8'));
  assertMatch(src, /router\.get\('\/stats\/speed', requireAdmin,/, '实时速率是全实例吞吐，普通用户没有意义');
  assertMatch(src, /router\.get\('\/stats\/summary', requireAdmin,/, '7 天流量同理（与 /stats/logs、R89 的 storage 收敛同一口径）');
  // 前端不得再向普通用户轮询这两条
  const main = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8'));
  assert(main.indexOf('if (!isStaffRole(App.state.user && App.state.user.role)) return;') > 0,
    'startStatsTimer 必须对非管理员直接返回');
  assert(main.indexOf('if (node) node.hidden = !staff;') > 0, '非管理员的状态栏速度格要隐藏，不能留一个永远「↑— ↓—」的格子');
});

test('R94-35 · M03-04：人机验证必须核对服务商应答的 hostname（同一 sitekey 多域名共用时）', () => {
  const captcha = require(SERVER('captcha.js'));
  assertEqual(captcha.hostnameAllowed('a.com', ['a.com', 'b.com']), true);
  assertEqual(captcha.hostnameAllowed('A.COM.', ['a.com']), true, '大小写与尾点要归一化，否则误伤正常用户');
  assertEqual(captcha.hostnameAllowed('a.com:443', ['a.com']), true, 'Host 头可能带端口');
  assertEqual(captcha.hostnameAllowed('evil.com', ['a.com']), false, '在别的域名上解出的 token 必须拒');
  assertEqual(captcha.hostnameAllowed('', ['a.com']), true, '服务商没给 hostname 时不因此拒绝（Turnstile 少数场景）');
  assertEqual(captcha.hostnameAllowed('a.com', []), true, '没有允许集时不拒绝（本地/测试环境）');
  assertMatch(captcha.publicReason('captcha_host_mismatch'), /域名/);

  const auth = stripComments(fs.readFileSync(path.join(SERVER('routes'), 'auth.js'), 'utf8'));
  assert(auth.indexOf('expectedHosts: captchaHosts(req)') > 0, '登录与注册两条入口都要把本站域名传进去');
});

test('R94-36 · M13-03：取不到 SHASUMS256.txt 不再静默放行（与「失败即中止」口径对齐）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  const i = src.indexOf('verify_node_tarball() {');
  assert(i > 0, '找不到 verify_node_tarball');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assertEqual(body.indexOf('跳过哈希校验（完整性问题请自行确认来源可信）'), -1,
    '旧实现此处 warn + return 0，与注释「失败即中止，无跳过开关」直接矛盾');
  assert(body.indexOf('_unverified_node_allow') > 0, '取不到校验单要走统一的「要么中止、要么显式放行」出口');
  const helper = src.slice(src.indexOf('_unverified_node_allow() {'), src.indexOf('\n}\n', src.indexOf('_unverified_node_allow() {')));
  assert(helper.indexOf('KEPLER_ALLOW_UNVERIFIED_NODE') > 0, '逃生口必须显式（运维自己写下来），不能默认静默通过');
  assert(helper.indexOf('die_with_hint') > 0, '默认路径必须中止部署');
});

test('R94-37 · M13-11：EAB HMAC 密钥可以从文件 / 环境变量读，不必进 argv', () => {
  const { execFileSync } = require('child_process');
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  const i = src.indexOf('function resolve_eab_secret()');
  assert(i > 0, '找不到 resolve_eab_secret');
  const fn = src.slice(i, src.indexOf('\n}\n', i) + 2);
  const keyFile = path.join(tmp.dir, 'eab.txt');
  fs.writeFileSync(keyFile, 'SECRET-FROM-FILE\n');
  const probe = `
set -u
die(){ echo "DIE: $*" >&2; exit 1; }
EAB_HMAC_KEY=""; EAB_HMAC_KEY_FILE="$1"
${fn}
resolve_eab_secret
printf '%s\\n' "$EAB_HMAC_KEY"
`;
  const fromFile = execFileSync('bash', ['-c', probe, 'probe', keyFile], { encoding: 'utf8' }).trim();
  assertEqual(fromFile, 'SECRET-FROM-FILE', '必须能从文件读到密钥（内容去掉换行与空白）');
  const fromEnv = execFileSync('bash', ['-c', probe, 'probe', ''], {
    encoding: 'utf8', env: Object.assign({}, process.env, { KEPLER_EAB_HMAC_KEY: 'SECRET-FROM-ENV' }),
  }).trim();
  assertEqual(fromEnv, 'SECRET-FROM-ENV', '环境变量通道（/proc/<pid>/environ 只对同 uid 可读）优先于文件');
  assert(src.indexOf('--eab-hmac-key-file) EAB_HMAC_KEY_FILE="$2" ;;') > 0, '参数必须能被解析');
});

test('R94-38 · M13-04 / M13-02 / M13-05：部署脚本的权限与可信代理默认值', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  // M13-04：以 root 被 exec 的脚本不能归应用账号
  assert(src.indexOf('chown root:root "${INSTALL_DIR}/deploy.sh"') > 0,
    'deploy.sh 必须 root 拥有 —— 否则应用进程改写它，管理员下次执行 kepler 就是 root 提权');
  assert(src.indexOf('chown root:root "$INSTALL_DIR" 2>/dev/null || true') > 0,
    '安装目录本身也要 root：只改文件不改目录，应用仍可删掉再重建');
  // M13-02：可信代理必须显式收窄
  assert(src.indexOf('local trust_from="TRUST_PROXY_FROM=127.0.0.1"') > 0, 'systemd 形态写回环');
  assert(src.indexOf('TRUST_PROXY_FROM=172.16.0.0/12,127.0.0.1') > 0, 'docker 形态写网桥网段');
  assert(src.indexOf('${trust_from}') > 0, '并且真的写进 .env');
  // M13-05：systemd 形态不再对全网卡监听
  assert(src.indexOf('local host_line="HOST=127.0.0.1"') > 0, 'systemd 形态绑回环（Nginx 从 127.0.0.1 反代）');
  assertEqual(src.indexOf('HOST=0.0.0.0\n'), -1, '.env 里不得再有一刀切的 HOST=0.0.0.0');
  // M13-06：显式部署开关
  assert(src.indexOf('\nDEPLOY_MODE=1\n') > 0, '.env 必须无条件写入 DEPLOY_MODE=1');
});

test('R94-39 · M12-06：派生缓存 `_parsed` 只在 `publicRule()` 一处被剥掉，预检接口也不许漏', () => {
  const ipGuard = require(SERVER('ip-guard.js'));
  const added = ipGuard.addRule({
    target: '2001:db8::/32', methods: [], bucketIds: [], enabled: true, kind: 'block',
  });
  try {
    const v = ipGuard.evaluate('2001:db8::1', 'GET', null);
    assertEqual(v.ok, false, '规则得**真的**能命中，否则这条护栏测不到点子上');
    // 缺陷前提：`evaluate()` 回传的是规则**本体**，`_parsed`（IPv6 是 16 字节 Buffer）就挂在上面
    assert(v.rule && v.rule._parsed, '`evaluate()` 的 rule 上带着 `_parsed` —— 直接回传就是缺陷');

    const pub = ipGuard.publicRule(v.rule);
    assertEqual(pub._parsed, undefined, '出接口前必须剥掉 `_parsed`');
    assertEqual(pub.id, v.rule.id, '剥壳不能顺手把业务字段一起丢掉');
    assertEqual(pub.target, v.rule.target);
    // 剥的是**副本**：不能把内存里的预解析缓存真的删了（那是性能优化）
    assert(v.rule._parsed, '剥壳必须改副本，否则每条规则下一次判定都要重新 parseTarget()');

    // 另一条读路径（规则列表）同一口径 —— 两条路径不能各写一遍
    assertEqual(ipGuard.listRules().some((r) => r._parsed !== undefined), false,
      '规则列表本来就该是剥过壳的（R28-01）');
  } finally {
    ipGuard.removeRule(added.id);
  }

  const route = stripComments(fs.readFileSync(path.join(SERVER('routes'), 'ipguard.js'), 'utf8'));
  assert(route.indexOf('ipGuard.publicRule(v.rule)') > 0,
    '预检接口的 `matchedRule` 必须走唯一实现点，不许再手写一遍剥壳');
  const src = stripComments(fs.readFileSync(SERVER('ip-guard.js'), 'utf8'));
  const dels = src.match(/delete\s+\w+\._parsed/g) || [];
  assertEqual(dels.length, 1,
    '整个 ip-guard.js 只允许 `publicRule()` 里那一处 `delete` —— 多一处就是又分叉出一条读路径');
});

/* ================================================================== *
 * ② 补齐「已修但此前没有护栏」的那一批（M01 / M02 / M03 / M04）
 * ================================================================== */

const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('R94-40 · M01-01：Windows Hello 的**注册验证**这一层也要校验当前口令', () => {
  const src = stripComments(readSrc('server', 'routes', 'webauthn.js'));
  const i = src.indexOf("router.post('/webauthn/register/verify'");
  assert(i > 0, '找不到注册验证端点');
  const body = src.slice(i, src.indexOf('router.', i + 10));
  assert(body.indexOf('verifyUserPassword(') > 0,
    '把公钥落库的是这一层，口令校验只加在 register/options（不写库）上等于没加');
  assert(body.indexOf('passwordLimiter(') > 0, '它也是口令哈希入口，必须与 options 同一条限流');
  assert(body.indexOf('expectedUserId') > 0, '挑战归属校验（R27-24）不能因为加口令而丢掉');
  const fe = stripComments(readSrc('public', 'js', 'webauthn.js'));
  assert(/password,\n/.test(fe) || fe.indexOf('    password,') > 0, '前端必须把同一个口令随注册结果回传');
});

test('R94-41 · M01-03：账户级失败计数会**衰减**（15 分钟窗口外的失败不再累计）', () => {
  const sec = require(SERVER('security.js'));
  const realNow = Date.now;
  try {
    sec.resetAccountFail('decay-user');
    for (let i = 0; i < 25; i += 1) sec.noteAccountFail('decay-user');
    assert(sec.accountFailDelayMs('decay-user') > 0, '连续 25 次失败必须开始拖慢（这是它存在的意义）');

    // 16 分钟后再看：窗口已过 ⇒ 延迟必须归零，而不是永久背着 1.5 秒
    Date.now = () => realNow() + 16 * 60 * 1000;
    assertEqual(sec.accountFailDelayMs('decay-user'), 0,
      '过期记录不得再产生延迟 —— 否则「零散输错 20 次」的用户此后每次登录都被拖满');
    sec.noteAccountFail('decay-user');
    assertEqual(sec.accountFailDelayMs('decay-user'), 0, '窗口外的第一次失败应当从 0 重新计');
  } finally {
    Date.now = realNow;
    sec.resetAccountFail('decay-user');
  }
});

test('R94-42 · M01-05：「记住登录状态」由服务端挑战裁定，第二步不许再采信请求体', () => {
  const src = stripComments(readSrc('server', 'routes', 'auth.js'));
  assert(src.indexOf('username: user.username, remember: Boolean(b.remember) }') > 0,
    '第一步要把 remember 记进挑战（否则服务端对这个选项毫无约束力）');
  assert(src.indexOf('return completeLogin(res, user, Boolean(r.remember), pre.ip);') > 0,
    '第二步必须用**挑战里那份**，用 b.remember 等于让前端自己决定会话时长');
  assert(src.indexOf('return completeLogin(res, user, Boolean(b.remember), pre.ip);') > 0,
    '（自证：未启用二次验证的直连分支仍然用请求体的值 —— 那是同一次请求，不是两步）');
});

test('R94-43 · M02-01 / M01-04：编辑自己时**改用户名**同样要当前口令', () => {
  const src = stripComments(readSrc('server', 'routes', 'users.js'));
  assert(src.indexOf('const changesUsername = b.username !== undefined && String(b.username) !== String(target.username);') > 0,
    '用户名是「我是谁」的对外标识，改它必须与改密码/改邮箱同一道闸');
  const i = src.indexOf('if (changesPassword || changesEmail || changesUsername) {');
  assert(i > 0, '闸门的判据里必须包含 changesUsername（只加常量不进判据 = 没加）');
  const body = src.slice(i, src.indexOf('\n    }\n', i));
  assert(body.indexOf('verifyUserPassword(') > 0, '这一层必须真的校验当前口令');
});

test('R94-44 · M02-02：删用户要解除其链接归属（同名新账号不得继承）', async () => {
  const shareStore = require(SERVER('share-store.js'));
  const v = await shareStore.create({
    key: 'docs/a.txt', bucket: 'bucket-x', region: 'r',
    items: [{ key: 'docs/a.txt', size: 3 }], createdBy: 'alice',
  });
  try {
    assertEqual(v.createdBy, 'alice', '自证：建链时的归属先落下来');
    assertEqual(shareStore.orphanByCreator('alice'), 1, '删用户时必须摘掉他名下的链接归属');
    const after = shareStore.get(v.id);
    assert(after, '只摘归属、**不删链接** —— 已分发出去的 URL 不该因为删用户而报废');
    assertEqual(after.createdBy, '', '归属必须被清空（清空后同名新账号 canManage 不再命中）');
    assertEqual(shareStore.canManage(after, 'user', 'alice'), false,
      '同名新账号（非管理员）不得再管这条链接');
    assertEqual(shareStore.canManage(after, 'user', 'bob'), false, '正向对照：别人本来也管不了');
  } finally {
    shareStore.remove(v.id);
  }
});

test('R94-45 · M02-03 / M02-05：邀请码身份锁定 + 「还有人能管用户」要数根用户', () => {
  const fe = stripComments(readSrc('public', 'js', 'invitemgr.js'));
  assert(fe.indexOf('const lockedRole = !canGrantAdmin && role === \'admin\';') > 0,
    '根用户发放的 admin 邀请码，普通管理员不得在界面上下调身份');
  assert(fe.indexOf('if (roleSel && !roleSel.disabled) out.role = roleSel.value;') > 0,
    '禁用的下拉不参与提交 —— 否则「界面锁住、请求里照填」等于没锁');
  const cs = stripComments(readSrc('server', 'config-store.js'));
  assert(cs.indexOf("return (cfg.users || []).filter((u) => u.role === 'admin' || roles.isRoot(u.role)).length;") > 0,
    '「还有人能管用户」= 管理员 + 根用户：只数字面量会让「1 根 + 1 管理员」的系统误报');
});

test('R94-46 · M03-01：SMTP 的证书身份校验对象必须是**配置的 host**（IP 目标也一样）', () => {
  const src = stripComments(readSrc('server', 'smtp.js'));
  assert(src.indexOf('checkServerIdentity: isIpHost ? (hostname, cert) => tls.checkServerIdentity(o.host, cert) : undefined,') > 0,
    'servername 置 undefined 时（IP 目标，RFC 6066 不许塞 IP）必须显式指定校验对象，否则拿 undefined 比 SAN 恒定失败');
  assert(src.indexOf('const isIpHost = net.isIP(o.host) > 0;') > 0, '判据要落在「是不是 IP」上');
  assertEqual(src.indexOf('rejectUnauthorized: false'), -1, '不能靠「跳过校验」来绕过这个问题');
});

/* ================================================================== *
 * ③ M04 / M05 / M06：只搬已知平台、解析级复核、进出一律相对
 * ================================================================== */

test('R94-47 · M04-06：备份导出 / 导入只搬**注册表内**的支付平台', () => {
  const cs = require(SERVER('config-store.js'));
  const out = cs.sanitizePaymentPlatforms({
    alipay: { enabled: true, appId: 'x' },
    'evil-platform': { enabled: true, endpoint: 'http://127.0.0.1/' },
  });
  assert(out && typeof out === 'object', '必须返回过滤后的对象');
  assertEqual(Object.prototype.hasOwnProperty.call(out, 'evil-platform'), false,
    '注册表里没有的平台 id 不得经备份写进 config.enc（界面看不到，也没有代码消费它）');
  assert(out.alipay && out.alipay.appId === 'x', '正向对照：已知平台的配置要保留');
  const bk = stripComments(readSrc('server', 'backup.js'));
  assert(bk.indexOf('platforms: configStore.sanitizePaymentPlatforms(pay.platforms),') > 0,
    '导出与导入两侧都必须过这个唯一过滤点（旧实现是 clone(pay.platforms)）');
});

test('R94-48 · M05-04 / M05-05 / M05-07：公开判据锚定、连接验证走解析级复核、Azure 不吃流当字符串', () => {
  const buckets = stripComments(readSrc('server', 'routes', 'buckets.js'));
  assert(buckets.indexOf('const ALL_USERS_URI_RE = /(^|\\/)global\\/AllUsers$/;') > 0,
    'URI 判据必须**锚定结尾**：includes 会把 …/global/AllUsersX 也算成「授权给所有人」');
  assertEqual(buckets.indexOf("includes('global/AllUsers')"), -1, '旧的子串判据必须不再存在');

  const cfgRoute = stripComments(readSrc('server', 'routes', 'config.js'));
  assert(cfgRoute.indexOf('await assertSafeEndpointResolved(providers.composeEndpoint(epProvider, b.endpoint))') > 0,
    '「会真的发出请求」的连接验证路径必须解析域名 —— 同步版不解析，等于同一个判据只堵了一处');

  const az = stripComments(readSrc('server', 'azure-client.js'));
  assert(az.indexOf('typeof spec.body.pipe') > 0 && az.indexOf('for await (const chunk of spec.body)') > 0,
    'Azure 适配器必须把 Node 流读成 Buffer；否则 String(stream) 得到 "[object Object]"，云端 201 但写进去 15 字节垃圾');
});

test('R94-49 · M06-04 / M06-05：冲突结果用**相对键**回传；两条上传路径挡空路径', () => {
  const fsSrc = stripComments(readSrc('server', 'routes', 'fs.js'));
  assert(fsSrc.indexOf('const rel = relKey(cfg.spaceRoot, p.key);') > 0,
    '冲突决策的键必须是相对键（绝对键会把内部用户 id 命名空间渲染到界面上）');
  assert(fsSrc.indexOf('target: relKey(cfg.spaceRoot, p.newKey),') > 0, '同一条口径要覆盖目标键');
  const empties = (fsSrc.match(/if \(!rel\w*\) throw badRequest\('路径不能为空'\);/g) || []).length;
  assertEqual(empties, 4,
    'simple / init / rename / move 四条路径都要挡空路径 —— 空 key 加根后等于空间根，'
    + '会把目录标记对象写成「内容是文件、却叫目录」');
});

test('R94-50 · M06-08：可当文档执行的 Content-Type 写入时一律降级为二进制', () => {
  const gw = require(SERVER('fs-gateway.js'));
  for (const t of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml',
    'application/javascript', 'text/javascript', 'application/xhtml+xml']) {
    assertEqual(gw.normalizeContentType(t), 'application/octet-stream',
      `「${t}」在存储厂商域名上直链打开就是同源页面 / 脚本，写入时必须降级`);
  }
  assertEqual(gw.normalizeContentType('image/png'), 'image/png', '正向对照：无害类型原样保留');
  assertEqual(gw.normalizeContentType(''), 'application/octet-stream', '空值落到二进制（保守）');
  const gwSrc = stripComments(readSrc('server', 'fs-gateway.js'));
  assert(gwSrc.indexOf("{ 'Content-Type': normalizeContentType(contentType) },") > 0,
    '归一化必须落在**写入的唯一收口点**上，否则 WebDAV PUT 仍能把 Content-Type 原样写进去');
});

/* ================================================================== *
 * ④ M07：上传闸门的位置、单人上限、前端取消语义
 * ================================================================== */

test('R94-51 · M07-01：内存闸门必须挂在**应用级** `express.raw` 之前', () => {
  const idx = stripComments(readSrc('server', 'index.js'));
  const gateAt = idx.indexOf("app.use(UPLOAD_RAW_PATHS, require('./upload-gate').gate());");
  const rawAt = idx.indexOf('app.use(UPLOAD_RAW_PATHS, express.raw({ type: () => true, limit: \'64mb\' }));');
  assert(gateAt > 0, '必须有一条应用级闸门（只靠路由上那条会被应用级 raw 整段跳过）');
  assert(rawAt > 0, '应用级 raw 仍然要在（FUN-01：它必须早于全局 json 解析）');
  assert(gateAt < rawAt, '闸门必须早于 raw —— 反过来就只是对着已经进内存的 64MB 做判定');
  const apiMount = idx.indexOf("app.use('/api', ");
  assert(apiMount > rawAt, '两者都要在 /api 挂载之前（顺序约束不能破）');
});

test('R94-52 · M07-03 / M07-04：单人上传名额是**按主体**计的，别一个人占满全场', () => {
  const gate = require(SERVER('upload-gate.js'));
  gate.reset();
  const perUser = gate.maxPerUserConcurrent();
  assert(perUser < gate.maxConcurrent(), '单人上限必须小于全局上限，否则「单人上限」没有意义');
  const tickets = [];
  try {
    for (let i = 0; i < perUser; i += 1) {
      const r = gate.tryAcquire(1, 'user-a');
      assertEqual(r.ok, true, `第 ${i + 1} 个名额应当放行（单人上限 ${perUser}）`);
      tickets.push(r.ticket);
    }
    const over = gate.tryAcquire(1, 'user-a');
    assertEqual(over.ok, false, '超过单人上限必须拒绝');
    assertMatch(over.reason, /单人上限/, '文案要能区分「服务器忙」与「你自己占太多」，否则用户以为是网络问题');
    const other = gate.tryAcquire(1, 'user-b');
    assertEqual(other.ok, true, '别人不该被 A 占满的名额挡住（全局还有余量）');
    tickets.push(other.ticket);
  } finally {
    tickets.forEach((t) => gate.release(t));
    gate.reset();
  }
  // 名额要能归还：否则用户的名额只减不增，最终自己都传不了
  assertEqual(gate.tryAcquire(1, 'user-a').ok, true, '全部归还之后必须又能拿到名额');
  gate.reset();

  const fsSrc = stripComments(readSrc('server', 'routes', 'fs.js'));
  const capAt = fsSrc.indexOf('uploadSessions.assertCapacity({ ownerId: whoId, createdBy: who });');
  const initAt = fsSrc.indexOf("const init = await p(client, 'multipartInit', {");
  assert(capAt > 0 && initAt > 0 && capAt < initAt,
    '必须先判自己的会话名额、再去建云端 UploadId —— 反过来会在超限时白建一个悬挂任务');
});

test('R94-53 · M07-05 / M07-07 / M07-09：失败态取消要真回收云端碎片、合并阶段要给出原因、成功后放掉 File', () => {
  const up = stripComments(readSrc('public', 'js', 'upload.js'));
  assert(up.indexOf("if (['uploading', 'paused', 'waiting', 'failed'].includes(t.state)) t.state = 'canceled';") > 0,
    '「中途失败 → 点取消」是最需要回收的那条路径，判据不能只覆盖 uploading/paused/waiting');
  assert(up.indexOf('if (t.sessionId) {') > 0,
    '回收判据必须是「有没有分片还挂在云端」（sessionId），而不是任务状态');
  assert(up.indexOf('已在本地取消，但云端碎片未能回收；系统稍后会重试清理') > 0,
    '远端中止失败不能吞掉 —— 那是「本地已取消、云端还在计费」的唯一信号');
  assert(up.indexOf("if (t.blocked) { st[0] = escapeHtml(t.blocked); st[1] = 'bad'; }") > 0,
    '合并阶段被拦下的操作要显示原因，否则就是「点了没反应」');
  assert(up.indexOf('t.file = null;') > 0,
    '上传成功后必须放掉 File 引用（done 的任务不再需要它），否则标签页内存随上传次数单调增长');
});

test('R94-54 · M07-08：对象键里的 Unicode 双向控制字符必须被剥掉', () => {
  const s3 = require(SERVER('s3.js'));
  assertEqual(s3.normalizeKey('合同\u202Etxt.exe'), '合同txt.exe',
    'U+202E 会让「合同exe.txt」显示成「合同txt.exe」，浏览器与保存对话框都会被骗');
  assertEqual(s3.normalizeKey('a\u200Fb.txt'), 'ab.txt', 'U+200F（RLM）同理');
  assertEqual(s3.normalizeKey('x\u2066y\u2069.txt'), 'xy.txt', '隔离符（LRI/PDI）也要剥');
  assertEqual(s3.normalizeKey('正常 名称.txt'), '正常 名称.txt', '正向对照：普通文件名不受影响');
});

/* ================================================================== *
 * ⑤ M08 / M09：分享与加密元数据
 * ================================================================== */

test('R94-55 · M08-01 / M08-02 / M08-05：多条目不因单对象缺失整条失效；下载接受 GET+POST；口令下界 6', async () => {
  const shareStore = require(SERVER('share-store.js'));
  const list = await shareStore.create({
    key: 'docs/a.txt', bucket: 'bucket-y', region: 'r',
    items: [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/b.txt', size: 2 }], createdBy: 'u1',
  });
  const single = await shareStore.create({
    key: 'docs/c.txt', bucket: 'bucket-y', region: 'r',
    items: [{ key: 'docs/c.txt', size: 1 }], createdBy: 'u1',
  });
  try {
    assertEqual(shareStore.get(list.id) && shareStore.view(shareStore.get(list.id)).listView, true,
      '自证：多条目链接走 listView 口径');
    shareStore.markMissingByKeys('bucket-y', ['docs/a.txt', 'docs/c.txt']);
    assertEqual(shareStore.get(list.id).missingAt, undefined,
      '多条目 / 文件夹分享不得因为少了**某一个**对象就整条落 missingAt —— 那会让已分发的 URL 直接 410 且不可自愈');
    assert(shareStore.get(single.id).missingAt,
      '正向对照：单文件链接的 key 真被删了，仍然必须标成已删除');
  } finally {
    shareStore.remove(list.id);
    shareStore.remove(single.id);
    shareStore.flush();
  }

  const sr = stripComments(readSrc('server', 'share-routes.js'));
  assert(sr.indexOf("router.get('/s/:id/dl', downloadHandler);") > 0, 'GET 必须保留（手写 URL / 分页链接 / 单文件直链）');
  assert(sr.indexOf("router.post('/s/:id/dl', express.urlencoded({ extended: false, limit: '2mb' }), downloadHandler);") > 0,
    'POST 是「下载选中」的正解 —— 勾选项塞查询串会顶爆 Node 的 16KB 请求行上限（431，且连 Express 都进不来）');

  const links = stripComments(readSrc('server', 'routes', 'links.js'));
  assert(links.indexOf("if (pw.length < 6 || pw.length > 64) throw badRequest('访问密码长度须为 6-64 个字符');") > 0,
    '下界 1 等于没保护：口令校验入口匿名可达，而爆破预算只按 IP 计');
});

test('R94-56 · M08-03 / M08-04：链接表**去抖合并写**；密码票据带服务端有效期', async () => {
  const shareStore = require(SERVER('share-store.js'));
  const fsMod = require('fs');
  const file = path.join(tmp.dir, 'links.json');
  const v = await shareStore.create({
    key: 'd/x.txt', bucket: 'bucket-z', region: 'r', items: [{ key: 'd/x.txt', size: 1 }], createdBy: 'u2',
  });
  try {
    /* M08-04：票据必须带签发时间，旧格式（纯 64 位 hex）不再接受 */
    const cryptoMod = require('crypto');
    const encStore = require(SERVER('enc-store.js'));
    const link = shareStore.get(v.id);
    assert(link, '自证：链接建出来了');
    assertEqual(shareStore.verifyToken(link, 'a'.repeat(64)), false,
      '旧格式票据正是「永不过期」的那个东西，必须不再接受');
    const good = shareStore.accessToken(link);
    assertEqual(shareStore.verifyToken(link, good), true, '自证：新格式票据要能验证通过');
    assert(good.indexOf('.') > 0, '新格式是 <iat36>.<hmac>');
    // 伪造一枚 8 天前签发的票据（签名正确、只是过期）—— 必须被 TTL 挡下
    const iat = Date.now() - 8 * 24 * 3600 * 1000;
    const bind = link.passwordHash || 'no-pass';
    const h = cryptoMod.createHmac('sha256', encStore.masterKey())
      .update('share-pass:' + link.id + '|' + bind + '|' + String(iat)).digest('hex');
    assertEqual(shareStore.verifyToken(link, iat.toString(36) + '.' + h), false,
      '服务端有效期必须真的参与判定，否则 Cookie 的 maxAge 只是浏览器侧的自觉行为');

    /* M08-03：写路径必须是去抖合并写 —— 下载风暴只落一次盘，而不是每次下载都做一遍
     * 「全表 JSON.stringify + 全表 AES-GCM + 原子写」。 */
    require(SERVER('coalesce.js')).flushAllSync(); // 项目自带的「模拟退出同步收口」钩子
    assert(fsMod.existsSync(file), '退出路径同步落盘之后链接表必须真的在磁盘上');
    assert(fsMod.readFileSync(file).length > 0, '落盘内容不能为空');
    const src = stripComments(readSrc('server', 'share-store.js'));
    assert(src.indexOf('coalesce.debouncedPersist(FILE, () => cache || null, { debounceMs: 250, dataDir: DATA_DIR })') > 0,
      '写盘必须走去抖合并写（与 payment-orders / download-log 同款），'
      + '否则匿名可达的 GET /s/:id/dl 每命中一次就把整个进程卡住一遍');
    assertEqual(src.indexOf('writeJsonAsync(FILE, cache)'), -1, '旧的「每次都直接写」必须不再存在');
  } finally {
    shareStore.remove(v.id);
    shareStore.flush();
  }
});

/* ================================================================== *
 * ⑥ M09：加密元数据的落盘语义
 * ================================================================== */

test('R94-57 · M09-01 / M09-05 / M09-06：元数据落盘必须走**会抛错**的入口', () => {
  const secureStore = require(SERVER('secure-store.js'));
  let threw = false;
  try {
    secureStore.writeJsonStrict(path.join(tmp.dir, 'no-such-dir-r94', 'x.json'), { a: 1 });
  } catch (e) {
    threw = true;
    assertEqual(e.writeFailed, true, '失败必须带可判定的标记（调用方据此不推进序号）');
  }
  assert(threw, '写不下去就必须抛错 —— 旧 `writeJson()` 吞错后调用方照样推进 metaSavedSeq，等于「假装已落盘」');

  const enc = stripComments(readSrc('server', 'enc-store.js'));
  assert(enc.indexOf('secureStore.writeJsonStrict(META_FILE, loadMeta());') > 0,
    '元数据落盘必须用抛错入口：它是解密的唯一凭据，丢了就是云端有密文、本地没有 IV/TAG');
  assert(enc.indexOf('if (persistMetaSync() === false) return false;') > 0,
    '「按纪律跳过未写」（返回 false）同样不得推进 metaSavedSeq');
  assert(enc.indexOf('if (settingsUnavailable) throw settingsUnavailableError();') > 0,
    'M09-05：设置读不出来时写路径必须拒绝 —— 不能一边读不出、一边把新设置写进去');
  assert(enc.indexOf('if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return false;') > 0,
    'M09-06：退出路径只写不建，判据走唯一实现点 exitPathWritable()');
});

test('R94-58 · M09-02 / M09-04：设置不可用要被标记；元数据表走去抖合并写', () => {
  const enc = stripComments(readSrc('server', 'enc-store.js'));
  assert(enc.indexOf('settingsUnavailable = true;') > 0,
    '设置读不出来必须标记下来（否则加密方式与「查看密码」门禁同时静默回落到默认值）');
  assert(enc.indexOf('settingsUnavailable,') > 0, '这个状态要能被界面 / 健康检查看见');
  assert(enc.indexOf('if (settingsUnavailable) secureStore.clearCorrupt(SETTINGS_FILE);') > 0,
    '管理员必须能从接口上把设置救回来（否则只能手改磁盘）');
  assert(enc.indexOf('const metaWriter = coalesce.debouncedPersist(') > 0,
    'M09-04：每次元数据变更都做一次全表序列化 + 全表 AES-GCM + 全量写是 O(N²) 写放大');
  assert(enc.indexOf('if (metaCorrupt) return null;') > 0,
    '去抖快照在损坏状态下必须返回 null（= 本次不写），与 coalesce 的契约一致');
});

test('R94-59 · M09-03：分片上传必须记下**本片密文**对应的加密元数据', () => {
  const fsSrc = stripComments(readSrc('server', 'routes', 'fs.js'));
  const snapAt = fsSrc.indexOf('partMetaSnapshot = (sess.enc && sess.enc.parts) ? sess.enc.parts[partNumber] : null;');
  const encAt = fsSrc.indexOf('body = await encStore.encryptPartAsync(sess, partNumber, req.body);');
  const uploadAt = fsSrc.indexOf("const data = await p(getClientForSession(sess), 'multipartUpload', {");
  const backAt = fsSrc.indexOf('if (partMetaSnapshot && sess.enc && sess.enc.parts) sess.enc.parts[partNumber] = partMetaSnapshot;');
  const etagAt = fsSrc.indexOf('uploadSessions.setPart(sess.id, partNumber, etag, req.body.length);');
  assert(encAt > 0 && snapAt > 0 && uploadAt > 0 && backAt > 0 && etagAt > 0, '四处都要找得到');
  assert(encAt < snapAt, '快照必须取在「加密刚完成」那一刻 —— 取晚了就已经被并发请求覆盖了');
  assert(snapAt < uploadAt, '快照要早于上传（上传期间别的请求还可能改本地 IV）');
  assert(backAt < etagAt,
    '写回元数据必须排在登记 etag **之前**、且两者之间不能有 await：'
    + '否则「云端密文 A + 本地 IV B」会让该对象永久不可解');
  const between = fsSrc.slice(backAt, etagAt);
  assertEqual(/await\s/.test(between), false, '这两行必须在同一个同步片段里，中间不许出现 await');
});

/* ================================================================== *
 * ⑦ M11 / M12 / M13：WebDAV 协议面、预检分支、CI 固定 SHA
 * ================================================================== */

test('R94-60 · M11-03 / M11-05：`Destination` 支持绝对路径 / 相对引用；MKCOL 校验父集合', () => {
  const app = stripComments(readSrc('server', 'webdav', 'app.js'));
  assert(app.indexOf("new URL(destHeader, 'https://' + String(req.headers.host || 'localhost') + String(req.path || '/'))") > 0,
    'RFC 4918 §8.3 的 Simple-ref 允许绝对路径 / 相对引用，必须以请求自身为 base 解析');
  assertEqual(app.indexOf('destUrl = new URL(destHeader);'), -1, '不带 base 的旧写法必须不再存在');
  assert(app.indexOf("if (parentKey && parentKey !== dirKey && parentKey !== rootKey) {") > 0,
    'MKCOL 必须校验父集合存在（否则在桶里留下没有父目录的占位对象）');
  assert(app.indexOf('if (st === 404 || /NoSuchKey|NotFound/i.test(code)) parentExists = false;') > 0,
    '只有「确实不存在」才判否，网络抖动按存在处理（宁可多建一层也不要让用户完全建不了目录）');
});

test('R94-61 · M12-04：预检的 `unparsable` 必须单独处理，不能落进读 matchedRule 的分支', () => {
  const fe = stripComments(readSrc('public', 'js', 'ipmgr.js'));
  assert(fe.indexOf("} else if (r.reason === 'unparsable') {") > 0,
    '无法解析的地址没有 matchedRule（null），落进 else 分支会 TypeError 并被吞成「检测失败」');
  assert(fe.indexOf('无法解析为合法 IP，按「拒绝」处理') > 0, '文案要说清真实原因，否则管理员排障方向被带偏');
  const elseAt = fe.indexOf('} else if (r.reason === \'unparsable\') {');
  const matchedAt = fe.indexOf('const m = r.matchedRule;');
  assert(matchedAt > elseAt, '读 matchedRule 的分支必须排在 unparsable 之后');
});

test('R94-62 · M13-09：CI 的 action 必须固定到 commit SHA，不用浮动 tag', () => {
  const yml = readSrc('.github', 'workflows', 'ci.yml');
  const uses = yml.split(/\r?\n/).filter((l) => /^\s*uses:\s+\S+/.test(l)).map((l) => l.trim());
  assert(uses.length > 0, 'CI 里应当有 action');
  for (const u of uses) {
    const ref = u.replace(/^uses:\s+/, '').split('@')[1] || '';
    assert(/^[0-9a-f]{40}$/.test(ref), `「${u}」必须固定到 40 位 commit SHA —— 浮动 tag 可被上游（或被盗账号）指向任意代码`);
  }
  assertEqual(/actions\/checkout@v4/.test(yml), false, '不得再出现 @v4 这类浮动引用');
});
