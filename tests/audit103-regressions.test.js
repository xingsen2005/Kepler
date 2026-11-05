/**
 * 第 103 轮护栏 —— 巡检异常通知（邮件）+ 分享链接的随机 4 位口令
 * ============================================================================
 *
 * 本轮是**功能需求**（不是审计修复），但两件事都属于「看起来做了、其实没做」的高危形状，
 * 所以每条都要求「撤销实现 ⇒ 本文件变红」，台账见 `scripts/reverse-check.js` 的 `R103-*`：
 *
 *  ① **通知**：最容易写错的是「有异常就发」—— 6 小时一轮、一天 4 封同样的信，
 *     一周后这个收件地址就被规则丢进垃圾箱，于是真正的新异常也被一起忽略。
 *     本文件钉住的是「签名变了才立刻发、同一批只在冷却后复述」；
 *  ② 另一半是**不该发的别发**：`unknown` / `error`（403、5xx、网络不通）是「没查清」，
 *     不是「坏了」；把它们算进通知，等于让一次对象存储抖动换来一封「你的数据被篡改了」；
 *  ③ **发信失败绝不影响巡检结论**：`maybeNotify()` 永不 reject，失败只记 `lastError`
 *     并**不推进签名**（否则一次 SMTP 故障会让这批异常永远收不到信）；
 *  ④ **随机口令**：4 位、字母 + 数字**都必须出现**、不含易混字符、用 `crypto` 而不是
 *     `Math.random`，且前端与服务端的**下界同口径**（4）。
 *
 * ## 隔离
 *
 * `config-store` 的数据目录是模块级常量，因此每个用例独占一个临时目录 + 清 server 缓存；
 * SMTP 一律用 `require.cache` 换掉 `sendMail`（真模块 + 只换边界，`audit99` 同款手法），
 * **绝不**让测试真的去连一台 SMTP 服务器。
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  assert, assertEqual, ROOT, makeTempDir, cleanupTempDir, request,
} = require('./helpers.js');

/** 占位目录：每个用例都会在 require server 模块前换成自己的目录 */
const slot = makeTempDir('r103-slot-');
process.env.S3_DATA_DIR = slot.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** 清掉 server 侧的模块缓存（数据目录、SMTP 桩都必须重新绑定） */
function clearServerCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'server'))) delete require.cache[k];
  }
}

/**
 * 全新的模块集合，`sendMail` 换成桩。
 *
 * ⚠️ 桩必须在 `require('integrity-notify')` **之前**塞进缓存：那个模块在顶层就把
 * `./smtp` 绑成了局部变量，之后再换缓存里的条目它看不到（这是「桩没生效」最常见的形态，
 * 表现为测试真的去连 smtp 然后超时失败）。
 */
function fresh(sendMail) {
  clearServerCache();
  const smtpPath = SERVER('smtp.js');
  const realSmtp = require(smtpPath);
  require.cache[smtpPath] = {
    id: smtpPath,
    filename: smtpPath,
    loaded: true,
    exports: Object.assign({}, realSmtp, { sendMail }),
  };
  return {
    configStore: require(SERVER('config-store.js')),
    notify: require(SERVER('integrity-notify.js')),
    integrity: require(SERVER('integrity.js')),
  };
}

/**
 * 起一个「可发信 + 已配置通知」的实例，跑完自动收拾。
 *
 * `opts.configure=false` 用来造「SMTP 没配」的世界；`opts.enabled/email` 直接决定
 * 通知开关，方便每条用例只关心自己那一个变量。
 */
async function withInstance(label, opts, fn) {
  const o = opts || {};
  const dir = makeTempDir(`r103-${label}-`);
  const prevDir = process.env.S3_DATA_DIR;
  process.env.S3_DATA_DIR = dir.dir;
  const calls = [];
  const sendMail = async (msg) => {
    calls.push(msg);
    if (o.failWith) throw new Error(o.failWith);
    return { ok: true, encrypted: true };
  };
  let m = null;
  try {
    m = fresh(sendMail);
    await m.configStore.addUser({ username: 'root', password: 'RootPass123', role: 'root' });
    m.configStore.flushPending();
    await wait(120);
    m.configStore.getMasterKey();
    if (o.configure !== false) {
      m.configStore.saveSmtp({
        enabled: true, host: 'smtp.example.com', port: 587, secure: false,
        user: 'bot', password: 'x', from: 'bot@example.com', fromName: 'Kepler',
      });
    }
    if (o.enabled !== undefined || o.email !== undefined) {
      m.configStore.saveIntegrityNotify({
        enabled: o.enabled === undefined ? true : o.enabled,
        email: o.email === undefined ? 'ops@example.com' : o.email,
      });
    }
    m.configStore.flushPending();
    await wait(120);
    return await fn(Object.assign({ calls, dir: dir.dir }, m));
  } finally {
    try { if (m) m.configStore.flushPending(); } catch (e) { /* 尽力而为 */ }
    await wait(50);
    process.env.S3_DATA_DIR = prevDir;
    await cleanupTempDir(dir.dir, { label: `r103-${label}-` });
  }
}

/** 一轮「查出 1 个丢失对象」的结果（形状与 `integrity.runOnce()` 一致） */
function badResult(extra) {
  return Object.assign({
    at: '2026-11-05T05:00:00.000Z',
    durationMs: 12, scanned: 3, ok: 2, bad: 1, skipped: 0, buckets: 1,
    findings: [{ bucket: 'b1', key: 'docs/a.txt', mode: 'crypto', verdict: 'missing', detail: '云端已无此对象（HEAD 404 / NoSuchKey）' }],
  }, extra || {});
}

/* ============================ ① 设置读写 ============================ */

test('R103-01 · 通知设置：默认关闭；部分写入不得把开关抹掉；旧配置读盘补齐', async () => {
  await withInstance('cfg', {}, async ({ configStore }) => {
    const d = configStore.getIntegrityNotify();
    assertEqual(d.enabled, false, '默认必须是关闭：巡检出网是它的本职，但往外发邮件是管理员的选择');
    assertEqual(d.email, '', '默认没有收件地址');

    configStore.saveIntegrityNotify({ enabled: true, email: 'ops@example.com' });
    assertEqual(configStore.getIntegrityNotify().enabled, true, '开启后应落盘');

    /**
     * 关键一条：`save()` 是**顶层键替换**，所以「只改地址」的写入若走 `save()`，
     * 归一化会把 `enabled` 补成 `false` —— 表现为「填了地址，开关自己关了」。
     * `saveIntegrityNotify()` 必须先合并再归一。
     */
    configStore.saveIntegrityNotify({ email: 'noc@example.com' });
    const after = configStore.getIntegrityNotify();
    assertEqual(after.enabled, true, '只改地址不得把开关关掉（顶层替换的经典事故）');
    assertEqual(after.email, 'noc@example.com', '地址应更新');

    /** 历史配置（完全没有 integrity 段）读出来必须是完整结构 */
    configStore.save({ integrity: undefined });
    const legacy = configStore.getIntegrityNotify();
    assertEqual(legacy.enabled, false, '缺这一段时应补齐为关闭');
    assertEqual(legacy.email, '', '缺这一段时应补齐为空地址');

    /** 脏值：`enabled: 'true'`（字符串）不得被当成真 —— 前端漏发一个布尔就会自己打开通知 */
    configStore.saveIntegrityNotify({ enabled: 'true', email: 'ops@example.com' });
    assertEqual(configStore.getIntegrityNotify().enabled, false, '只认真正的 true');
  });
});

/* ============================ ② 什么时候发 ============================ */

test('R103-02 · 只在「真异常 + 开关开 + 有地址 + SMTP 可用」四条同时成立时发信', async () => {
  await withInstance('gate', {}, async ({ notify, calls, configStore }) => {
    // ① 没有异常：不发（这条挡的是「每轮都发一封问安信」）
    let r = await notify.maybeNotify(badResult({ bad: 0, ok: 3, findings: [] }));
    assertEqual(r.sent, false, 'bad=0 不得发信');
    assertEqual(r.reason, 'no-bad', '原因应为 no-bad');

    // ② 只有「没查清」（error / unknown）：也不算异常
    r = await notify.maybeNotify(badResult({
      bad: 0, ok: 2,
      findings: [{ bucket: 'b1', key: 'x', verdict: 'error', detail: '无法确认（403）' }],
    }));
    assertEqual(r.sent, false, '403 / 5xx 属于「没查清」，绝不能触发「数据被篡改」的通知');

    // ③ 开关关掉：不发
    configStore.saveIntegrityNotify({ enabled: false, email: 'ops@example.com' });
    r = await notify.maybeNotify(badResult());
    assertEqual(r.reason, 'disabled', '开关关闭时不得发信');

    // ④ 开了开关但地址为空：不发
    configStore.saveIntegrityNotify({ enabled: true, email: '' });
    r = await notify.maybeNotify(badResult());
    assertEqual(r.reason, 'no-email', '没有收件地址时不得发信');

    assertEqual(calls.length, 0, '以上四种情况一个字节都不该投递出去');
  });
});

test('R103-03 · SMTP 没配时不发（但也不算错误）；配好之后正文含结论中文与对象位置', async () => {
  await withInstance('smtp', { configure: false, enabled: true }, async ({ notify, calls, configStore }) => {
    let r = await notify.maybeNotify(badResult());
    assertEqual(r.reason, 'smtp-not-configured', 'SMTP 没配时应如实回答「渠道没接上」');
    assertEqual(r.sent, false, '发不出去就不要假装发了');
    assertEqual(calls.length, 0, '一个字节都不该投递');

    configStore.saveSmtp({
      enabled: true, host: 'smtp.example.com', port: 587, secure: false,
      user: 'bot', password: 'x', from: 'bot@example.com',
    });
    r = await notify.maybeNotify(badResult());
    assertEqual(r.sent, true, 'SMTP 配好之后应真的投递');
    assertEqual(calls.length, 1, '只投递一封');
    const msg = calls[0];
    assertEqual(msg.to, 'ops@example.com', '收件人必须是管理员填的那一个');
    assert(msg.subject.includes('1'), '标题里要有异常数量：' + msg.subject);
    assert(msg.text.includes('b1 / docs/a.txt'), '正文要写清楚是哪个桶的哪个对象');
    assert(msg.text.includes('已丢失'), '结论要用中文，不把 missing 这种内部枚举甩给收件人');
    assert(msg.text.includes('只读'), '正文要说明巡检不会替人恢复/修改云端');
  });
});

test('R103-04 · 同一批异常不重复轰炸；出现新异常立刻发；冷却到期复述一次', async () => {
  await withInstance('cool', { enabled: true }, async ({ notify, calls }) => {
    const t0 = Date.parse('2026-11-05T05:00:00.000Z');
    let r = await notify.maybeNotify(badResult(), t0);
    assertEqual(r.sent, true, '第一次发现异常应立刻发');
    assertEqual(calls.length, 1, '第一封');

    // 同一批（6 小时后的下一轮）：不发
    r = await notify.maybeNotify(badResult(), t0 + 6 * 3600 * 1000);
    assertEqual(r.reason, 'cooldown', '同一批异常在冷却期内不得再发');
    assertEqual(calls.length, 1, '收件箱不该每 6 小时收到一封同样的信');

    // 异常集合变了（多了一个对象）：立刻发
    const worse = badResult({
      bad: 2, ok: 1, findings: badResult().findings.concat([
        { bucket: 'b1', key: 'docs/b.txt', verdict: 'modified', detail: '写完之后又被写过一次' },
      ]),
    });
    r = await notify.maybeNotify(worse, t0 + 7 * 3600 * 1000);
    assertEqual(r.sent, true, '签名变化（新增一个坏对象）必须立刻发 —— 否则新问题要等 12 小时');
    assertEqual(calls.length, 2, '第二封');

    // 冷却到期：同一批也复述一次（别让人以为它自己好了）
    r = await notify.maybeNotify(worse, t0 + 7 * 3600 * 1000 + notify.COOLDOWN_MS + 1000);
    assertEqual(r.sent, true, '冷却到期应复述一次');
    assertEqual(calls.length, 3, '第三封');
  });
});

test('R103-05 · 发信失败不影响巡检结论，且不推进签名（下一轮继续重试）', async () => {
  await withInstance('fail', { enabled: true, failWith: 'SMTP 连接超时' }, async ({ notify, calls, integrity }) => {
    const t0 = Date.parse('2026-11-05T05:00:00.000Z');
    const r = await notify.maybeNotify(badResult(), t0);
    assertEqual(r.sent, false, '失败就是失败');
    assertEqual(r.reason, 'error', '原因应为 error');
    assert(r.error && r.error.includes('SMTP'), '要把失败原因带出来：' + r.error);
    assertEqual(calls.length, 1, '确实尝试过一次');

    const st = notify.status();
    assertEqual(st.lastError.includes('SMTP'), true, 'status 里要能看到上一次失败，界面据此显示');
    assertEqual(st.lastSentAt, '', '失败不得被记成「已发送」');

    // 巡检状态照常可读 —— 发信失败绝不把巡检结论变成「失败」
    const is = integrity.state();
    assertEqual(typeof is.bad, 'number', '巡检状态必须仍然可用');
    assert(is.notify && typeof is.notify === 'object', '状态里要带上通知投递信息供界面渲染');

    // 失败退避：紧接着再来一轮不会立刻重连（避免 SMTP 挂掉时每轮都卡一次超时）
    const r2 = await notify.maybeNotify(badResult(), t0 + 60 * 1000);
    assertEqual(r2.reason, 'fail-backoff', '失败后应有一段退避');
    assertEqual(calls.length, 1, '退避期内不得再连');

    // 退避过后仍要重试（否则一次偶发失败就永久静音）
    const r3 = await notify.maybeNotify(badResult(), t0 + notify.FAIL_COOLDOWN_MS + 1000);
    assertEqual(calls.length, 2, '退避过后必须重试 —— 签名没变也要重发，因为上一封根本没发出去');
    assertEqual(r3.reason, 'error', '这一轮桩仍然失败');
  });
});

/* ============================ ③ 路由 ============================ */

/** 只挂 integrity 路由的 app（`req.authUser` 由这里注入，模拟登录态） */
async function serveIntegrity(role) {
  clearServerCache();
  const smtpPath = SERVER('smtp.js');
  const realSmtp = require(smtpPath);
  require.cache[smtpPath] = {
    id: smtpPath, filename: smtpPath, loaded: true,
    exports: Object.assign({}, realSmtp, { sendMail: async () => ({ ok: true }) }),
  };
  const ctx = require(SERVER('routes/_context.js'));
  const app = ctx.express();
  app.use(ctx.express.json({ limit: '1mb' }));
  app.use((req, res, next) => { req.authUser = role === null ? null : { id: 'u1', role: role || 'admin' }; next(); });
  app.use(require(SERVER('routes/integrity.js')));
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('R103-06 · PUT /integrity/notify：坏地址 400、开开关却不填地址 400、SMTP 没配时存下来并给 warning', async () => {
  const dir = makeTempDir('r103-route-');
  const prevDir = process.env.S3_DATA_DIR;
  process.env.S3_DATA_DIR = dir.dir;
  let api = null;
  try {
    api = await serveIntegrity('admin');
    const configStore = require(SERVER('config-store.js'));
    await configStore.addUser({ username: 'root', password: 'RootPass123', role: 'root' });
    configStore.flushPending();
    await wait(120);
    configStore.getMasterKey();

    // 地址非法 → 400（且错误文案要说清是哪一部分不合法）
    let r = await request(api.port, 'PUT', '/integrity/notify', { body: { enabled: true, email: 'not-an-email' } });
    assertEqual(r.status, 400, '坏地址必须当场拒绝，不能先存着等出事那天才发现发不出去');

    // 开着开关却不填地址 → 400
    r = await request(api.port, 'PUT', '/integrity/notify', { body: { enabled: true, email: '' } });
    assertEqual(r.status, 400, '开启通知却没有地址，等于让管理员以为已经生效');

    // 合法地址 + 未配 SMTP：200，带 warning
    r = await request(api.port, 'PUT', '/integrity/notify', { body: { enabled: true, email: 'Ops@Example.com' } });
    assertEqual(r.status, 200, 'SMTP 没配不该拒绝保存（两张卡片可以任意顺序配）');
    assertEqual(r.json.notify.enabled, true, '开关应落盘');
    assertEqual(r.json.notify.email, 'ops@example.com', '地址应归一（小写）');
    assert(r.json.warning && r.json.warning.includes('SMTP'), '要如实告诉管理员「现在暂时发不出去」：' + r.json.warning);

    // GET /integrity 也要带上这份设置（卡片只发一个请求就能渲染）
    const g = await request(api.port, 'GET', '/integrity');
    assertEqual(g.status, 200, 'GET /integrity 应可用');
    assertEqual(g.json.notify && g.json.notify.email, 'ops@example.com', '状态里要带通知设置');

    // 关闭：允许把地址留空
    r = await request(api.port, 'PUT', '/integrity/notify', { body: { enabled: false, email: '' } });
    assertEqual(r.status, 200, '关掉通知时允许清空地址');
    assertEqual(r.json.notify.enabled, false, '开关应关闭');

    // 普通用户：403（这条接口改的是「异常告警发给谁」）
    const api2 = await serveIntegrity('user');
    try {
      const r2 = await request(api2.port, 'PUT', '/integrity/notify', { body: { enabled: true, email: 'a@b.com' } });
      assertEqual(r2.status, 403, '非管理员不得改通知设置');
    } finally { await api2.close(); }
  } finally {
    if (api) await api.close();
    process.env.S3_DATA_DIR = prevDir;
    await cleanupTempDir(dir.dir, { label: 'r103-route-' });
  }
});

/* ============================ ④ 随机口令 ============================ */

test('R103-07 · 随机口令：4 位、字母与数字都出现、不含易混字符、不用 Math.random', async () => {
  const { randomSharePassword } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'util.js')).href);
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const s = randomSharePassword(4);
    assertEqual(s.length, 4, '默认就是 4 位：' + s);
    assert(/^[a-z0-9]+$/.test(s), '只能是字母数字：' + s);
    assert(/[a-z]/.test(s), '必须含字母（「字母和数字的组合」）：' + s);
    assert(/[0-9]/.test(s), '必须含数字：' + s);
    /**
     * 易混字符必须排除：`0/o`、`1/l/i` 在多数无衬线字体里几乎同形，
     * 4 位口令只错一位就全废，而这串东西是给人念、给人抄的。
     */
    assert(!/[01loi]/.test(s), '不得出现 0 / 1 / l / o / i 这类易混字符：' + s);
    seen.add(s);
  }
  assert(seen.size > 200, `400 次生成应有足够多不同结果（实际 ${seen.size} 种），否则是常量或弱随机`);

  // 长度可调，但被收敛到 2~12（越界不该产出空串或超长口令）
  assertEqual(randomSharePassword(6).length, 6, '传入 6 应得到 6 位');
  assertEqual(randomSharePassword(1).length, 2, '小于 2 收敛到 2（否则「字母+数字各一个」无处安放）');
  assertEqual(randomSharePassword(99).length, 12, '上限 12');

  /** 静态：绝不能用 Math.random —— 那是一枚访问凭据，可预测就等于没有 */
  const util = readSrc('public', 'js', 'util.js');
  const body = util.slice(util.indexOf('function sharePwRand'), util.indexOf('export function randomSharePassword'));
  assert(body.indexOf('Math.random') === -1, '随机数必须用 crypto.getRandomValues');
  assert(body.indexOf('crypto.getRandomValues') > 0, '随机数必须用 crypto.getRandomValues');
});

test('R103-08 · 分享口令下界：前端与服务端同为 4（且都不是 1）', () => {
  const ops = readSrc('public', 'js', 'ops.js');
  const links = readSrc('server', 'routes', 'links.js');
  assert(ops.indexOf('if (pw.length < 4)') > 0, '前端下界应为 4：' + '（与「随机生成 4 位」同口径，否则生成出来的口令自己存不进去）');
  assert(links.indexOf("if (pw.length < 4 || pw.length > 64) throw badRequest('访问密码长度须为 4-64 个字符');") > 0,
    '服务端下界应为 4 且与文案一致（下界 1 才是真正不可接受的：那等于没有保护）');

  /** 生成按钮必须真的接上：只加 HTML 不接事件，用户点了没反应 */
  assert(/id="lk-pw-gen"/.test(readSrc('public', 'index.html')) === false,
    '创建分享的弹窗是 JS 拼出来的（ops.js），不该在 index.html 里再写一份 —— 出现两份就会有两套行为');
  assert(ops.indexOf("wrap.querySelector('#lk-pw-gen')") > 0, '按钮必须在弹窗内按 id 取到并接线');
  assert(ops.indexOf('randomSharePassword(4)') > 0, '点击应调用生成器（4 位）');
  assert(ops.indexOf('pwOn.checked = true') > 0,
    '未勾选密码保护时点「随机生成」要顺手替用户勾上并解锁输入框，否则看起来什么都没发生');
});
