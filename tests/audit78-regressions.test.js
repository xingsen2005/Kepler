/**
 * 审计第 78 轮护栏：外部《模块安全审计报告》中**成立且值得修**的那几条
 *
 * 本文件只断言**后果**，不检查「源码里有没有那行字」。逐条对应报告编号：
 *
 *  - R78-01/02  H-1  多条目 / 文件夹分享整体绕过「加密访问密码」门禁
 *  - R78-03     H-2  `/fs/copy` 过闸门却不记账（且单文件复制 `addBytes` 恒为 0）
 *  - R78-04     H-3  优惠券「全部」对话框的 filter 参数顺序反转
 *  - R78-05     IP-F05  IPv4-mapped 地址与 v4 规则必须互相命中
 *  - R78-06     IP-F03  命中计数落盘失败不得升级成进程崩溃，且降级态必须可见
 *  - R78-07     S3-F1   流式下载不得因「总时长超时」被中断，只在数据停滞时中断
 *  - R78-08     WebDAV-W5 / 文件-F07  回滚副本必须连带清掉它的加密元数据
 *  - R78-09     WebDAV-W1  WebDAV 账户的 username 必须唯一（它才是认证查找键）
 *  - R78-10     SMTP-发现1  信头字段不得带 CRLF
 *  - R78-11     认证-发现1  「谁能管谁」判据（admin ↛ root，root → admin 放行）
 *
 * ⚠️ 桩的安装时序（本文件的核心约束）：
 *   `routes/fs.js` 与 `fs-gateway.js` 在**加载时**就把 `p` / `getClient` /
 *   `deleteMultipleConfirmed` 解构成了局部绑定 —— 加载之后再改 `module.exports`
 *   对它们无效（这正是本项目反复踩过的「桩打不到」）。所以桩统一在本文件顶部、
 *   在 require 任何路由模块**之前**装好，各用例只切换行为实现。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

require('./helpers');
const { assert, assertEqual, assertMatch, ROOT, request } = require('./helpers');

const P = (rel) => path.join(ROOT, rel);

/* ===================== 桩：必须在路由模块加载前装好 ===================== */

const s3mod = require(P('server/s3.js'));
const realP = s3mod.p;
const realDeleteMultiple = s3mod.deleteMultipleConfirmed;

/** 默认桩：所有 headObject 都「存在且 32 字节」，其余调用一律成功 */
let pImpl = async () => ({ headers: { 'content-length': '32' } });
let delImpl = null;
s3mod.p = (...args) => pImpl(...args);
s3mod.deleteMultipleConfirmed = (...args) => (delImpl ? delImpl(...args) : realDeleteMultiple(...args));
s3mod.getClient = () => ({ fake: true });

const bucketStats = require(P('server/bucket-stats.js'));
const usage = [];
const realRecord = bucketStats.recordUsageDelta;
bucketStats.recordUsageDelta = (cfg, delta) => { usage.push(delta); return realRecord(cfg, delta); };

const shared = require(P('server/routes/_shared.js'));
shared.requireConfig = () => ({
  bucket: 'r78-bucket', region: 'ap-guangzhou', provider: 'tencent', credentialId: 'cred-r78',
});

const shareRoutes = require(P('server/share-routes.js'));
const shareStore = require(P('server/share-store.js'));
const encStore = require(P('server/enc-store.js'));
const fsRoutes = require(P('server/routes/fs.js'));

/** 起一个只挂指定路由的本地服务 */
async function serve(router) {
  const express = require(P('node_modules/express'));
  const app = express();
  app.use(express.json());
  app.use('/', router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/* ==========================================================================
 * R78-01 / R78-02 · H-1：分享的加密门禁必须按**整份快照**判定
 *
 * 漏洞形态（报告 H-1）：`encGateNeeded(l)` 只查 `l.key` 这一个对象，而多条目 /
 * 文件夹分享的 `l.key` 恒等于**快照第一项**（建链时 key 传空串 ⇒
 * `share-store` 取 `snap[0].key`）。文件夹分享的第一项是目录 key，目录永远没有
 * 加密元数据 ⇒ `getMeta()` 返回 null ⇒ 列表页 / HEAD / 下载三处门禁一起失效，
 * 而下载链路本身逐文件判定加密、命中 meta 即解密下发。
 * ========================================================================== */

const BUCKET = 'r78-bucket';
const DIR = 'r78secret/';
const FILE = 'r78secret/body.txt';
const PLAIN = 'r78plain/'; // 正对照专用前缀：**绝不能**与上一个用例共用 key（见下）

/**
 * 造一条「文件夹分享」：快照第一项是目录，第二项才是文件。
 *
 * ⚠️ `prefix` 必须逐用例不同：`encStore._resetForTest()` 只丢内存缓存，
 * 加密元数据是**落盘**的，`loadMeta()` 下一次就从文件里读回来 —— 两个用例共用
 * 同一个 key 时，第一个用例写下的密文元数据会让第二个"明文"用例照样命中门禁。
 */
function makeFolderShare(prefix) {
  return shareStore.create({
    bucket: BUCKET,
    region: 'ap-guangzhou',
    createdBy: 'tester',
    items: [
      { key: prefix, size: 0, dir: true },
      { key: `${prefix}body.txt`, size: 32 },
    ],
  });
}

/** 只设置「加密访问密码」（`withMeta` 时再给 `metaKey` 挂一份加密元数据） */
async function armEncryption(on, withMeta = on, metaKey = FILE) {
  encStore._resetForTest();
  await encStore.updateSettings({ mode: 'crypto', password: on ? 'r78-pass' : '' });
  encStore.removeMetaBatch(BUCKET, [FILE, `${PLAIN}body.txt`]);
  if (withMeta) {
    encStore.setMeta(BUCKET, metaKey, { mode: 'crypto', origSize: 32, size: 40, crypto: { segs: [] } });
  }
}

test('R78-01 · 文件夹分享里只要有一个密文成员，列表页与下载都必须先过加密密码', async () => {
  await armEncryption(true);
  assert(encStore.passwordSet(), '前置：加密访问密码应已设置');
  assert(!!encStore.getMeta(BUCKET, FILE), '前置：密文成员应有加密元数据');

  const l = await makeFolderShare(DIR);
  // 前置断言：这条链接的 `l.key` 正是那个**没有**加密元数据的目录 key（漏洞的触发条件）
  assertEqual(l.key, DIR, '前置：文件夹分享的 l.key 应等于快照第一项（目录）');
  assertEqual(encStore.getMeta(BUCKET, l.key), null, '前置：目录 key 不可能有加密元数据');

  const srv = await serve(shareRoutes);
  try {
    // ① 列表页：未持令牌 ⇒ 必须停在「加密文件访问验证」页，而不是给出下载按钮
    const page = await request(srv.port, 'GET', `/s/${l.id}`);
    assertEqual(page.status, 200, `列表页应 200，实际 ${page.status}`);
    assertMatch(page.raw, /该文件已加密存储/,
      '未持加密令牌访问文件夹分享页必须停在验证页 —— 否则明文可被匿名取走（H-1）');

    // ② 下载端点：同样必须被拦（303 回分享页 = 门禁生效）
    const dl = await request(srv.port, 'GET', `/s/${l.id}/dl`);
    assertEqual(dl.status, 303, `未持令牌的下载必须 303 回分享页，实际 ${dl.status}`);
    assertMatch(String(dl.headers.location || ''), new RegExp(`/s/${l.id}$`),
      '下载被拦后应回到分享页本身');

    // ③ 正对照：持令牌后同一批请求不得再被加密门禁拦下
    //    （下载可能因云端桩不全而失败，但**不得**再以 303 回分享页表示"被门禁拦"）
    const token = encStore.issueToken().token;
    const page2 = await request(srv.port, 'GET', `/s/${l.id}`, { headers: { 'x-enc-token': token } });
    assert(!/该文件已加密存储/.test(page2.raw),
      '持有效加密令牌后不应再停在验证页（否则门禁变成了永久封锁）');
    const dl2 = await request(srv.port, 'GET', `/s/${l.id}/dl`, { headers: { 'x-enc-token': token } });
    assert(!(dl2.status === 303 && new RegExp(`/s/${l.id}$`).test(String(dl2.headers.location || ''))),
      '持有效加密令牌后下载不应再被门禁退回分享页');
  } finally {
    await srv.close();
  }
});

test('R78-02 · 正对照：整份快照都是明文时，文件夹分享不得被加密门禁误伤', async () => {
  await armEncryption(true, false); // 密码仍然设着，但这条分享里**一个密文成员都没有**
  const l = await makeFolderShare(PLAIN);

  const srv = await serve(shareRoutes);
  try {
    const page = await request(srv.port, 'GET', `/s/${l.id}`);
    assert(!/该文件已加密存储/.test(page.raw),
      '明文分享不应要求加密访问密码 —— 判据变宽不等于无差别拦截');
  } finally {
    await srv.close();
  }
  await armEncryption(false);
});

/* ==========================================================================
 * R78-03 · H-2：`/fs/copy` 必须按真实净增字节过闸门**并**记账
 *
 * 断言落在 `recordUsageDelta` 的数字上：它同时证明了两件事 ——
 * ① 单文件复制的任务大小不再是 0（否则净增为 0，这个钩子根本不会被调用）；
 * ② 成功后确实喂了增量（否则 15 分钟缓存窗口内「断言看到的是写入前的数字」）。
 * ========================================================================== */

test('R78-03 · 复制成功要记账（净增 = 新 − 旧），单文件复制也必须带真实大小', async () => {
  const SRC = 'r78src.bin';          // 1000 字节
  const SRC2 = 'r78src2.bin';        // 700 字节
  const DST2 = 'r78dst/r78src2.bin'; // 目标已存在 300 字节 ⇒ 净增 400
  pImpl = async (client, method, params) => {
    if (method === 'headObject') {
      const key = params && params.Key;
      if (key === SRC) return { headers: { 'content-length': '1000' } };
      if (key === SRC2) return { headers: { 'content-length': '700' } };
      if (key === DST2) return { headers: { 'content-length': '300' } };
      const e = new Error('Not Found');
      e.statusCode = 404; // 其余目标都不存在 ⇒ `existsKey()` 判空位
      e.code = 'NoSuchKey';
      throw e;
    }
    return {};
  };

  const srv = await serve(fsRoutes);
  try {
    usage.length = 0;
    const r1 = await request(srv.port, 'POST', '/fs/copy', {
      body: { paths: [SRC], targetPrefix: 'r78dst' },
    });
    assertEqual(r1.status, 200, `复制应成功，实际 ${r1.status}: ${r1.raw}`);
    assertEqual(usage.reduce((a, b) => a + b, 0), 1000,
      '复制 1000 字节必须让用量 +1000 —— 为 0 说明任务大小仍是 0（闸门在"新增 0 字节"下判定）');

    // 覆盖写入：净增 = 700 − 300 = 400
    usage.length = 0;
    const r2 = await request(srv.port, 'POST', '/fs/copy', {
      body: { paths: [SRC2], targetPrefix: 'r78dst', decisions: { [SRC2]: 'overwrite' } },
    });
    assertEqual(r2.status, 200, `覆盖复制应成功，实际 ${r2.status}: ${r2.raw}`);
    assertEqual(usage.reduce((a, b) => a + b, 0), 400,
      '覆盖写入的净增必须是「新大小 − 旧大小」—— 记成 700 会让用量长期虚高');
  } finally {
    await srv.close();
    pImpl = async () => ({ headers: { 'content-length': '32' } });
  }
});

/* ==========================================================================
 * R78-04 · H-3：优惠券「全部」对话框的 filter 参数顺序
 * ========================================================================== */

test('R78-04 · 优惠券对话框的关键词过滤必须真的过滤（参数顺序写反时它是一条恒真判据）', async () => {
  const { pathToFileURL } = require('node:url');
  const { matchesQuery } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'util.js')).href);

  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'couponmgr.js'), 'utf8');
  const re = /filter:\s*(\(all,\s*state\)\s*=>)/g;
  const m = re.exec(src);
  assert(m, '应在 couponmgr.js 中找到 `filter: (all, state) =>` 回调');

  // 从参数表开始，取到**函数体**配对的结尾（`(all, state) => all.filter((c) => { ... })`）
  const start = m.index + m[0].indexOf('(');
  const arrowAt = src.indexOf('=>', m.index);
  assert(arrowAt > 0, '回调必须是箭头函数');
  let i = arrowAt + 2;
  while (i < src.length && /\s/.test(src[i])) i++;
  let depth = 0;
  let seen = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; seen = true; }
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (seen && depth === 0) { i++; break; }
    }
  }
  const callbackText = src.slice(start, i);
  assert(/matchesQuery/.test(callbackText), '优惠券的 filter 回调必须使用统一的 matchesQuery 判据');

  // 用**真实** matchesQuery 与真实记录形状执行这段回调 —— 断言后果而不是字面顺序
  const fmtScope = (c) => (c.scope || '');
  const filter = new Function('matchesQuery', 'fmtScope', `return (${callbackText});`)(matchesQuery, fmtScope);

  const coupons = [
    { code: 'ABC123', note: '双十一', scope: '全场' },
    { code: 'XYZ999', note: '新人', scope: '首单' },
  ];
  const hit = filter(coupons, { query: 'abc', filters: {} });
  assertEqual(hit.length, 1, '搜索 "abc" 必须只剩 1 条 —— 参数顺序写反时会返回 2 条（判据恒真）');
  assertEqual(hit[0].code, 'ABC123', '命中的应是 ABC123');

  const miss = filter(coupons, { query: '不存在的词', filters: {} });
  assertEqual(miss.length, 0, '搜不到的词必须过滤干净 —— 参数写反时它会返回全部，搜索框形同虚设');

  assertEqual(filter(coupons, { query: '', filters: {} }).length, 2, '空关键词必须显示全部');
});

/* ==========================================================================
 * R78-05 · IP-F05：IPv4-mapped 地址与 v4 规则必须互相命中
 * ========================================================================== */

test('R78-05 · ::ffff:1.2.3.4 必须按 IPv4 判定（否则照着界面看到的地址加的规则永不生效）', () => {
  const ipGuard = require(P('server/ip-guard.js'));

  const info = ipGuard.parseIpInfo('::ffff:1.2.3.4');
  assertEqual(info.v6, false, 'mapped 地址必须折算成 IPv4 —— 展示与判定不能两套口径');
  assertEqual(info.ip, ipGuard.ipv4ToInt('1.2.3.4'), '折算后的整数必须等于 1.2.3.4');

  const rule = ipGuard.parseTarget('1.2.3.4');
  assert(ipGuard.cidrMatch(info, rule), 'v4 规则必须命中 mapped 形式的同一地址');

  // 规则本身写成 mapped 形式时也要与 v4 流量互通（`/96` 是 mapped 前缀的宽度）
  const mappedRule = ipGuard.parseTarget('::ffff:1.2.3.0/120');
  assertEqual(mappedRule.v6, false, 'mapped 规则必须折算成 IPv4');
  assertEqual(mappedRule.prefix, 24, '::ffff:1.2.3.0/120 ≡ 1.2.3.0/24');
  assert(ipGuard.cidrMatch(ipGuard.parseIpInfo('1.2.3.9'), mappedRule), '/24 应命中同段的 v4 地址');

  // 反例：真正的 IPv6 不得被折算（否则规则会误伤一大片 IPv4）
  const real6 = ipGuard.parseIpInfo('2001:db8::1');
  assertEqual(real6.v6, true, '真正的 IPv6 必须保持 v6 语义');
  assert(!ipGuard.cidrMatch(real6, rule), 'v4 规则不得命中真正的 IPv6 地址');
});

/* ==========================================================================
 * R78-06 · IP-F03：命中计数落盘失败不得把进程带崩，且降级态必须可见
 * ========================================================================== */

test('R78-06 · 命中计数写盘失败：flushHits 返回 false 而不是抛错，且 view() 暴露降级态', () => {
  const ipGuard = require(P('server/ip-guard.js'));
  const secureStore = require(P('server/secure-store.js'));
  const security = require(P('server/security.js'));

  assertEqual(ipGuard.view().rulesPersistDegraded, false, '正常态：不可写着标记应为 false');

  // 造一次命中（置脏），再把写盘打断
  ipGuard.addRule({ target: '10.78.0.9', action: 'block' });
  const realIpInfo = security.clientIpInfo;
  security.clientIpInfo = () => ({ ip: '10.78.0.9', fromForwarded: false });
  try {
    const v = ipGuard.guardRequest({ method: 'GET', headers: {}, socket: {}, url: '/' });
    assertEqual(v.ok, false, '前置：规则应命中该地址');

    const realWrite = secureStore.writeJson;
    secureStore.writeJson = () => { throw new Error('磁盘只读（R78 桩）'); };
    try {
      let threw = null;
      let ok = null;
      try { ok = ipGuard.flushHits(); } catch (e) { threw = e; }
      assertEqual(threw, null,
        'flushHits 绝不能抛错 —— 它在 setInterval 里被调用，抛错 = uncaughtException = 退出码 1 = 崩溃循环');
      assertEqual(ok, false, '写盘失败必须如实返回 false');
      assertEqual(ipGuard.view().rulesPersistDegraded, true,
        '降级状态必须能被界面看到 —— 否则"规则 0 条"与"规则整批失效"长得一模一样');
    } finally {
      secureStore.writeJson = realWrite;
    }

    // 恢复后必须能自动回到正常态（不是一次性坏死的标记）
    assertEqual(ipGuard.flushHits(), true, '写盘恢复后应能成功落盘');
    assertEqual(ipGuard.view().rulesPersistDegraded, false, '恢复后降级标记应复位');
  } finally {
    security.clientIpInfo = realIpInfo;
  }
});

/* ==========================================================================
 * R78-07 · S3-F1：流式下载超时语义（总时长 → 空闲）
 * ========================================================================== */

test('R78-07 · 流式下载：总时长超过 timeout 但数据持续流动时不得中断；停滞才中断', async () => {
  const { S3Client } = require(P('server/s3-client.js'));
  const { PassThrough } = require('node:stream');

  /** 伪 S3：按给定节奏吐 chunk */
  function startFake(gapMs, chunks) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          let i = 0;
          const tick = () => {
            if (i >= chunks) { res.end(); return; }
            i++;
            res.write(Buffer.alloc(64, 0x61));
            // `unref()`：停滞用例的间隔是 100 秒，挂着的定时器会把整个测试进程钉在
            // 事件循环里（表现为「用例全绿但跑不完」）
            const t = setTimeout(tick, gapMs);
            if (t.unref) t.unref();
          };
          tick();
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }));
    });
  }

  function drain(client) {
    return new Promise((resolve) => {
      const out = new PassThrough();
      const chunks = [];
      out.on('data', (c) => chunks.push(c));
      out.on('end', () => resolve({ err: null, bytes: Buffer.concat(chunks).length }));
      out.on('error', (e) => resolve({ err: e, bytes: Buffer.concat(chunks).length }));
      client.getObject({ Bucket: BUCKET, Key: 'big.bin', Output: out, __timeoutMs: 150 }, (e) => {
        if (e) resolve({ err: e, bytes: 0 });
      });
    });
  }

  function mkClient(port) {
    return new S3Client({
      endpoint: `http://127.0.0.1:${port}`, region: 'ap-guangzhou', bucket: BUCKET,
      accessKeyId: 'ak', secretAccessKey: 'sk', forcePathStyle: true, timeout: 150,
    });
  }

  // ① 慢但不断：20 块 × 80ms ≈ 1.6 秒，远超 150ms 的总时长预算 —— 必须完整取回
  const slow = await startFake(80, 20);
  try {
    const r = await drain(mkClient(slow.port));
    assertEqual(r.err, null, `数据持续流动时不得因总时长超时被中断（实际错误：${r.err && r.err.message}）`);
    assertEqual(r.bytes, 20 * 64, '所有分块都必须到达');
  } finally {
    await slow.close();
  }

  // ② 停滞：发一块之后再也不发 —— 必须被空闲看门狗掐断
  const stall = await startFake(100000, 2);
  try {
    const r = await drain(mkClient(stall.port));
    assert(r.err, '数据停滞超过 timeout 必须中断（否则连接会永久挂住）');
    assertMatch(String(r.err.code || r.err.message), /IdleTimeout|停滞/,
      '中断原因必须能区分「数据停滞」与「密钥被拒绝」，否则前端会误判成会话过期');
  } finally {
    await stall.close();
  }
});

/* ==========================================================================
 * R78-08 · WebDAV-W5 / 文件-F07：回滚副本必须连带清掉加密元数据
 * ========================================================================== */

test('R78-08 · rollbackCopies 必须清掉「云端确认已删」副本的加密元数据，且不得误清删除失败的', async () => {
  const gateway = require(P('server/fs-gateway.js'));
  const OK = 'r78rb/ok.txt';
  const BAD = 'r78rb/bad.txt';
  encStore.setMeta(BUCKET, OK, { mode: 'crypto', origSize: 5, size: 9, crypto: { segs: [] } });
  encStore.setMeta(BUCKET, BAD, { mode: 'crypto', origSize: 5, size: 9, crypto: { segs: [] } });

  delImpl = async (s3, cfg, keys) => ({
    okKeys: keys.filter((k) => k === OK),
    errors: keys.filter((k) => k !== OK).map((k) => ({ key: k, message: 'AccessDenied（R78 桩）' })),
  });
  try {
    const rb = await gateway.rollbackCopies({ fake: true }, { bucket: BUCKET, region: 'ap-guangzhou' }, [OK, BAD]);
    assertEqual(rb.removed, 1, '前置：只有 OK 一个被确认删除');
    assertEqual(encStore.getMeta(BUCKET, OK), null,
      '副本已删，它的加密元数据必须一起清掉 —— 否则会留下指向已删对象的孤儿记录，'
      + '用户之后往同名 key 上传明文时会被当成密文处理');
    assert(!!encStore.getMeta(BUCKET, BAD),
      '删除失败的副本**仍在云端**，清掉它的元数据才是真正的数据丢失（密文永久不可解）');
  } finally {
    delImpl = null;
    encStore.removeMetaBatch(BUCKET, [OK, BAD]);
  }
});

/* ==========================================================================
 * R78-09 · WebDAV-W1：username 唯一
 * ========================================================================== */

test('R78-09 · WebDAV 账户的 username 必须唯一（它才是认证查找键，不是 appName）', () => {
  const configStore = require(P('server/config-store.js'));
  const a = configStore.addWebdavAccount({ appName: 'r78-webdav-a', username: 'r78same', password: 'pw-a' });
  assert(a && a.id, '前置：第一个账户应创建成功');

  let err = null;
  try {
    configStore.addWebdavAccount({ appName: 'r78-webdav-b', username: 'r78same', password: 'pw-b' });
  } catch (e) { err = e; }
  assert(err, '同名 username 的第二个账户必须被拒绝 —— 认证侧 find() 只会命中第一个，'
    + '第二个账户"创建成功却永远登不上"');
  assertEqual(err.status, 409, '撞用户名属于冲突语义（409），与撞 appName 一致');

  // 反例：换一个 username 必须能建（证明判据不是「禁止建第二个账户」）
  const c = configStore.addWebdavAccount({ appName: 'r78-webdav-c', username: 'r78other', password: 'pw-c' });
  assert(c && c.id, '不同 username 的账户必须能正常创建');

  // 编辑路径同样要拦
  let err2 = null;
  try {
    configStore.updateWebdavAccount(c.id, { username: 'r78same' });
  } catch (e) { err2 = e; }
  assert(err2, '把已有账户的用户名改成已占用的值同样必须拒绝');
});

/* ==========================================================================
 * R78-10 · SMTP-发现1：信头字段不得带 CRLF
 * ========================================================================== */

test('R78-10 · SMTP 的 From / To / Subject 必须把 CRLF 折成空格（信头注入）', () => {
  const smtp = require(P('server/smtp.js'));
  const o = smtp.normalizeOptions({
    host: 'smtp.example.com', port: 465, from: 'a@b.c', to: 'x@y.z\r\nBcc: victim@evil.tld',
    fromName: 'Kepler\r\nX-Injected: 1', subject: '你好\r\nBcc: another@evil.tld',
    text: '第一行\r\n第二行（正文允许换行）',
  });
  for (const [k, v] of [['to', o.to], ['fromName', o.fromName], ['subject', o.subject], ['from', o.from]]) {
    assert(!/[\r\n]/.test(v), `${k} 不得含 CRLF（实际：${JSON.stringify(v)}）`);
  }
  assertEqual(o.text, '第一行\r\n第二行（正文允许换行）', '正文是多行内容，绝不能被折成一行');

  // 拼出来的报文里不得出现被注入的信头
  const msg = smtp.buildMessage(o);
  assert(!/^Bcc:/m.test(msg), '报文里不得出现注入出来的 Bcc 行');
  assert(!/^X-Injected:/m.test(msg), '报文里不得出现注入出来的自定义信头');
});

/* ==========================================================================
 * R78-11 · 认证-发现1：「谁能管谁」的唯一判据
 * ========================================================================== */

test('R78-11 · denyIfCannotManage：admin ↛ root/admin，root → admin 放行（webauthn 代关也走它）', () => {
  assertEqual(typeof shared.denyIfCannotManage, 'function',
    '判据必须由共享层提供 —— 只住在 users.js 里的话，webauthn 那条路由就永远漏着');

  const statsStore = require(P('server/stats-store.js'));
  const logs = [];
  const realLog = statsStore.addLog;
  statsStore.addLog = (x) => { logs.push(x); };

  /** 假 res：只需分清「已经回过 403」这件事 */
  function fakeRes() {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  }
  const me = (role, name) => ({ authUser: { role, username: name } });

  try {
    for (const target of [{ role: 'root', username: 'boss' }, { role: 'admin', username: 'peer' }]) {
      const res = fakeRes();
      const blocked = shared.denyIfCannotManage(me('admin', 'a1'), res, target, '关闭 Windows Hello 验证');
      assertEqual(blocked, true, `管理员不得管理 ${target.role}`);
      assertEqual(res.code, 403, '必须是 403');
      assertMatch(String(res.body && res.body.error), /仅根用户可执行/);
    }
    assertEqual(logs.filter((x) => x.action === 'users.denied').length, 2, '每次拒绝都要留一条审计');

    const res2 = fakeRes();
    assertEqual(shared.denyIfCannotManage(me('root', 'r1'), res2, { role: 'admin', username: 'peer' }, '关闭 Windows Hello 验证'), false,
      '根用户管理管理员是本职');
    assertEqual(res2.code, null, '放行时不得写响应');

    const res3 = fakeRes();
    assertEqual(shared.denyIfCannotManage(me('admin', 'a1'), res3, { role: 'user', username: 'u1' }, '关闭 Windows Hello 验证'), false,
      '管理员管理普通用户是本职');
    assertEqual(res3.code, null, '放行时不得写响应');
  } finally {
    statsStore.addLog = realLog;
  }
});

/* ==========================================================================
 * R78-12 · 认证-发现1（路由层）：代关 Windows Hello 必须真的走到那条判据
 *
 * R78-11 只证明「判据本身对」。真正被修的是**接线**：`POST /users/:id/webauthn/disable`
 * 此前只挂 `requireAdmin`，所以判据存在与否都不影响它 —— 必须有一条真发 HTTP 的
 * 用例，否则「判据写好了但没接上」照样全绿。
 * ========================================================================== */

test('R78-12 · 管理员调 /users/:id/webauthn/disable 对准根用户必须 403，且根用户凭据原样', async () => {
  const configStore = require(P('server/config-store.js'));
  const webauthnRoutes = require(P('server/routes/webauthn.js'));
  const express = require(P('node_modules/express'));

  // 第一个账户由存储层强制成 root（R71）
  const rootUser = await configStore.addUser({ username: 'r78root', password: 'Unit!2026abc', role: 'admin' });
  const adminUser = await configStore.addUser({ username: 'r78admin', password: 'Unit!2026abc', role: 'admin' });
  assertEqual(rootUser.role, 'root', '前置：空库第一个账户应为根用户');
  assertEqual(adminUser.role, 'admin', '前置：第二个账户应为管理员');

  const before = configStore.getUserById(rootUser.id).webauthn || null;
  assertEqual(before && before.enabled, false, '前置：根用户初始未启用 Windows Hello');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = configStore.getUserById(adminUser.id);
    req.authUser = { id: u.id, username: u.username, role: u.role, permissions: {} };
    next();
  });
  app.use('/api', webauthnRoutes);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const r = await request(server.address().port, 'POST', `/api/users/${rootUser.id}/webauthn/disable`, { body: {} });
    assertEqual(r.status, 403,
      `管理员不得代根用户关闭 Windows Hello（实际 ${r.status}）—— 旧实现只挂 requireAdmin，`
      + '管理员可以静默拆掉根用户的二因素，而受害者自己的设置页只会看到"未启用"');
    const after = configStore.getUserById(rootUser.id).webauthn || null;
    assertEqual(after && after.enabled, false, '拒绝后根用户的凭据状态必须原样');
  } finally {
    await new Promise((res) => server.close(res));
  }
});
