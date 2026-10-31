/**
 * R99 · 完整性巡检 / 防勒索校验的**行为**护栏
 * ============================================================================
 *
 * 这一轮的新模块 `server/integrity.js` 有三个"看起来对、其实错"的地方，本文件逐条钉住：
 *
 *  ① **判据本身**（长度公式 / 三个结论 / 「不存在」的口径）—— 纯函数，直接喂参数；
 *  ② **执行顺序**（锁定态必须先于一切）—— 用"桩有没有被调用"取证，
 *     而不是断言源码里出现过某个 `if`（那是假绿的老朋友）；
 *  ③ **计数的语义**（跳过 ≠ 丢失）—— 403 与 5xx 绝不能进 `bad`，
 *     否则凭据一过期，巡检就刷出一整屏"文件被删了"。
 *
 * ## 为什么用 require.cache 注入依赖
 *
 * `integrity.js` 在**顶层解构**了 `s3.p` 与 `resolveBucketClient`，事后 monkey-patch
 * `module.exports` 不生效。要真的驱动它，只能在它被 `require` **之前**把依赖模块的
 * cache 条目换掉 —— 这是本仓库既有的做法（见 `audit38` 的 `withEnv`）。
 *
 * 注入的桩都是「**真模块 + 只替换边界函数**」：`Object.assign({}, real, { ... })`。
 * 这样 `CRYPTO_MAGIC` / `IV_LEN` / `TAG_LEN` / `mapLimit` 仍然是**真实实现**，
 * 用例不会因为桩与实现各自演化而变成互相印证的空转。
 */
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const { assert, assertEqual, ROOT } = require('./helpers');

const P = {
  integrity: path.join(ROOT, 'server', 'integrity.js'),
  encStore: path.join(ROOT, 'server', 'enc-store.js'),
  configStore: path.join(ROOT, 'server', 'config-store.js'),
  bucketStats: path.join(ROOT, 'server', 'bucket-stats.js'),
  candidates: path.join(ROOT, 'server', 'search-candidates.js'),
  s3: path.join(ROOT, 'server', 's3.js'),
  statsStore: path.join(ROOT, 'server', 'stats-store.js'),
};

/**
 * 装一套桩并加载一份**全新的** `integrity.js`。
 *
 * @param {object} opts
 * @param {boolean} [opts.locked]          模拟「进程处于锁定态」
 * @param {boolean} [opts.corrupt]         模拟「本地 enc-meta 损坏」
 * @param {object} [opts.buckets]          `{ 桶名: [{key, meta}] }`
 * @param {object} [opts.sizes]            `{ key: 云端 Content-Length }`（缺省 = HEAD 404）
 * @param {object} [opts.lastModified]     `{ key: Last-Modified }`
 * @param {object} [opts.headError]        `{ key: Error }` —— 该 key 的 HEAD 抛这个错
 * @param {object} [opts.candidateItems]   模拟「全桶递归搜索」留下的候选集（命中即省 HEAD）
 * @param {function} fn                    `(mod, calls) => ...`
 */
async function withIntegrity(opts, fn) {
  const o = opts || {};
  const calls = { head: [], logs: [], metaBuckets: 0, entriesFor: [] };

  const real = {
    encStore: require(P.encStore),
    configStore: require(P.configStore),
    bucketStats: require(P.bucketStats),
    candidates: require(P.candidates),
    s3: require(P.s3),
    statsStore: require(P.statsStore),
  };

  const head = async (s3c, method, params) => {
    calls.head.push({ method, key: params && params.Key, bucket: params && params.Bucket });
    const key = params && params.Key;
    if (o.headError && o.headError[key]) throw o.headError[key];
    if (!o.sizes || !(key in o.sizes)) {
      const e = Object.assign(new Error('The specified key does not exist.'), { statusCode: 404, code: 'NoSuchKey' });
      throw e;
    }
    const headers = { 'content-length': String(o.sizes[key]) };
    if (o.lastModified && o.lastModified[key]) headers['last-modified'] = o.lastModified[key];
    return { headers };
  };

  const fakes = {
    encStore: Object.assign({}, real.encStore, {
      metaBuckets: () => { calls.metaBuckets += 1; return Object.keys(o.buckets || {}); },
      metaEntriesFor: (b) => {
        calls.entriesFor.push(b);
        return (o.buckets && o.buckets[b]) ? o.buckets[b].slice() : [];
      },
      metaIsCorrupt: () => !!o.corrupt,
    }),
    configStore: Object.assign({}, real.configStore, {
      isLocked: () => !!o.locked,
    }),
    bucketStats: Object.assign({}, real.bucketStats, {
      // 只替换「桶名 → 客户端」这一步；`mapLimit` 与 `bucketCacheKey` 保持真实实现
      resolveBucketClient: (cfg) => {
        const bucket = cfg && cfg.bucket;
        if (o.buckets && Object.prototype.hasOwnProperty.call(o.buckets, bucket)) {
          return { cfg: { bucket, region: '' }, s3: {} };
        }
        return null;
      },
    }),
    candidates: Object.assign({}, real.candidates, {
      get: () => (o.candidateItems
        ? { complete: true, items: o.candidateItems }
        : null),
    }),
    s3: { p: head },
    statsStore: Object.assign({}, real.statsStore, {
      addLog: (e) => { calls.logs.push(e); },
    }),
  };

  const saved = {};
  for (const name of Object.keys(fakes)) {
    saved[name] = require.cache[require.resolve(P[name])];
    require.cache[require.resolve(P[name])] = {
      id: P[name], filename: P[name], loaded: true, exports: fakes[name],
    };
  }
  delete require.cache[require.resolve(P.integrity)];

  try {
    const mod = require(P.integrity);
    return await fn(mod, calls);
  } finally {
    delete require.cache[require.resolve(P.integrity)];
    for (const name of Object.keys(fakes)) {
      if (saved[name]) require.cache[require.resolve(P[name])] = saved[name];
      else delete require.cache[require.resolve(P[name])];
    }
  }
}

/** 一段 crypto 密文的元数据（分片：每片 `[iv(12)][ct][tag(16)]`，首片另带魔数头） */
function cryptoSegMeta(ctLens, extra) {
  return Object.assign({
    mode: 'crypto',
    crypto: { segments: ctLens.map((n) => ({ ctLen: n })) },
  }, extra || {});
}

/* ================================================================== *
 * 第 1 层 · 判据（纯函数）
 * ================================================================== */

test('R99-01 · 密文长度必须由元数据推导：crypto 逐片 ×(12+ct+16) + 魔数头，magic 与明文等长', async () => {
  await withIntegrity({}, (m) => {
    const enc = require(P.encStore); // 真实常量（桩里也是同一份引用）
    const magicLen = enc.CRYPTO_MAGIC.length;

    assertEqual(enc.IV_LEN, 12, 'IV 长度变了就必须同步巡检公式 —— 它写在密文布局里');
    assertEqual(enc.TAG_LEN, 16, 'GCM tag 长度变了同理');

    // 单分片：魔数 + (12 + ct + 16)
    assertEqual(m.expectedCloudSize(cryptoSegMeta([100])), magicLen + 12 + 100 + 16,
      '单分片 crypto 密文长度 = 魔数 + IV + ct + tag');
    // 多分片：**只有首片**带魔数头，其余片没有
    assertEqual(m.expectedCloudSize(cryptoSegMeta([100, 50, 7])), magicLen + (12 + 100 + 16) + (12 + 50 + 16) + (12 + 7 + 16),
      '三个分片时魔数头只算一次 —— 每片都加会把整条判据推高几十字节，全部对象误判「长度不符」');

    // magic 模式：覆写文件头 + 流式异或，密文与明文**等长**
    assertEqual(m.expectedCloudSize({ mode: 'magic', origSize: 4096 }), 4096,
      'magic 模式长度恒等于明文长度（不加密、只覆写头）');

    // 算不出来就如实返回 null，不猜
    assertEqual(m.expectedCloudSize(null), null, '没有元数据时不得返回一个"猜"的长度');
    assertEqual(m.expectedCloudSize({ mode: 'none', origSize: 10 }), null, '未加密对象不该出现在候选集里，出现也不猜');
    assertEqual(m.expectedCloudSize({ mode: 'crypto', crypto: { segments: [] } }), null, '分片表为空 ⇒ 无法推导');
    assertEqual(m.expectedCloudSize({ mode: 'crypto', crypto: { segments: [{ ctLen: 'x' }] } }), null, 'ctLen 非数字 ⇒ 无法推导');
  });
});

test('R99-02 · 三个结论：长度不符 / 写完之后又被写过 / 正常', async () => {
  await withIntegrity({}, (m) => {
    const wrote = '2026-10-01T00:00:00.000Z';
    const meta = { mode: 'magic', origSize: 100, createdAt: wrote };

    const ok = m.classify({ meta, cloudSize: 100, lastModified: '2026-10-01T00:00:30.000Z' });
    assertEqual(ok.verdict, 'ok', '写入后 30 秒的 Last-Modified 属正常（元数据落盘与时钟都有几秒误差）');

    const size = m.classify({ meta, cloudSize: 99, lastModified: '2026-10-01T00:00:30.000Z' });
    assertEqual(size.verdict, 'size', '长度差 1 字节也要报 —— 截断是勒索软件最典型的脚印');
    assert(size.detail.indexOf('差 -1') >= 0, `明细里应写清差多少，实际：${size.detail}`);

    // 同长度、但云端在我们写完 10 分钟之后又被写过一次 ⇒ 原位覆盖
    const mod = m.classify({ meta, cloudSize: 100, lastModified: new Date(Date.parse(wrote) + 10 * 60 * 1000).toISOString() });
    assertEqual(mod.verdict, 'modified',
      '长度相同但 Last-Modified 明显晚于本地写入时间 ⇒ 判「被改写」（同长度的原位覆盖就藏在这里）');

    // 容差边界：4 分钟算正常，6 分钟算被改写（容差 5 分钟）
    assertEqual(m.classify({ meta, cloudSize: 100, lastModified: new Date(Date.parse(wrote) + 4 * 60 * 1000).toISOString() }).verdict, 'ok',
      '容差内不得报警 —— 一开巡检就看到自己刚传的文件"被篡改"，用户会立刻学会无视这个功能');
    assertEqual(m.classify({ meta, cloudSize: 100, lastModified: new Date(Date.parse(wrote) + 6 * 60 * 1000).toISOString() }).verdict, 'modified',
      '超过容差就要报');
  });
});

test('R99-03 · 历史条目缺 createdAt 时**跳过**「被改写」判据，而不是当成篡改', async () => {
  await withIntegrity({}, (m) => {
    const r = m.classify({ meta: { mode: 'magic', origSize: 10 }, cloudSize: 10, lastModified: '2026-10-01T00:00:00.000Z' });
    assertEqual(r.verdict, 'ok',
      '没有本地写入时间的条目无法判断"写完之后有没有被动过"，只能按长度放行（R66 之前的历史条目全都没有 createdAt）');
    const bad = m.classify({ meta: { mode: 'magic', origSize: 10 }, cloudSize: 11, lastModified: '2026-10-01T00:00:00.000Z' });
    assertEqual(bad.verdict, 'size', '但长度判据与 createdAt 无关，仍要照报');
  });
});

test('R99-04 · 「不存在」只认 404 / NoSuchKey：403 与 5xx 一律不算丢失', async () => {
  await withIntegrity({}, (m) => {
    assert(m.isNotFoundError({ statusCode: 404 }), '404 是"确实没了"');
    assert(m.isNotFoundError({ status: 404 }), '有的厂商把状态码放在 status 上');
    assert(m.isNotFoundError({ code: 'NoSuchKey' }), 'S3 的 NoSuchKey');
    assert(m.isNotFoundError({ code: 'NotFound' }), '部分厂商用 NotFound');
    assert(!m.isNotFoundError({ statusCode: 403 }), '⚠️ 403 = 凭据缺 HeadObject 权限，判成"丢失"会在凭据过期时刷满假警报');
    assert(!m.isNotFoundError({ statusCode: 500 }), '5xx 是服务端问题，与对象存不存在无关');
    assert(!m.isNotFoundError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }), '网络超时同理');
    assert(!m.isNotFoundError(null), '没有错误对象时更不能判丢失');
  });
});

/* ================================================================== *
 * 第 2 层 · 执行顺序与计数（真跑 runOnce，用"桩被调用了几次"取证）
 * ================================================================== */

test('R99-05 · ⭐ 锁定态：一步都不往下走（不读元数据、不发任何 HEAD）', async () => {
  await withIntegrity({
    locked: true,
    buckets: { b1: [{ key: 'a', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } }] },
    sizes: { a: 10 },
  }, async (m, calls) => {
    const st = await m.runOnce();
    assertEqual(st.skippedReason, 'locked', '锁定态必须以 locked 结束整轮');
    assertEqual(calls.metaBuckets, 0,
      '⚠️ 锁定态下连 metaBuckets() 都不能调 —— enc-meta.json 是加密文件，读一次就会把 metaCorrupt 置真、本进程永久拒写元数据');
    assertEqual(calls.head.length, 0, '锁定态下不得对云端发任何请求');
    assertEqual(st.scanned, 0, '整轮跳过 ⇒ 扫描数为 0（不是"扫了但都失败"）');
  });
});

test('R99-06 · 元数据损坏同样整轮跳过，且与「锁定」是两个不同的原因', async () => {
  await withIntegrity({ corrupt: true, buckets: { b1: [] } }, async (m, calls) => {
    const st = await m.runOnce();
    assertEqual(st.skippedReason, 'meta-corrupt', '损坏要以 meta-corrupt 结束，界面上才能给出不同处置');
    assertEqual(calls.head.length, 0, '损坏时不得去云端"顺便查一下"');
    assertEqual(st.locked, false, '「锁定」与「损坏」必须能分辨（R97 的同款教训：两者处置完全不同）');
  });
});

test('R99-07 · 正常一轮：ok / size / missing 的计数与明细，并落一条审计日志', async () => {
  await withIntegrity({
    buckets: {
      b1: [
        { key: 'ok.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } },
        { key: 'short.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } },
        { key: 'gone.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } },
      ],
    },
    sizes: { 'ok.bin': 10, 'short.bin': 4 }, // gone.bin 没有 ⇒ HEAD 404
  }, async (m, calls) => {
    const st = await m.runOnce();
    assertEqual(st.scanned, 3, '三个对象都要被算进扫描数');
    assertEqual(st.ok, 1, '长度相符的那个是 ok');
    assertEqual(st.bad, 2, '一个长度不符 + 一个已丢失 = 2 个异常');
    assertEqual(st.findings.length, 2, '明细只列异常项');
    const verdicts = st.findings.map((f) => f.verdict).sort();
    assertEqual(verdicts.join(','), 'missing,size', `明细里的结论应是 missing 与 size，实际 ${verdicts.join(',')}`);
    assertEqual(calls.head.length, 3, '三个对象各一次 HEAD');

    const log = calls.logs[calls.logs.length - 1];
    assert(log && log.action === 'integrity.findings', '发现异常必须落一条审计日志（否则只有打开设置页才看得到）');
    assertEqual(log.level, 'warn', '异常日志的级别是 warn');
    assert(log.detail.indexOf('2 个异常对象') >= 0, `日志里应写清异常数量，实际：${log.detail}`);
  });
});

test('R99-08 · ⭐ 403 / 5xx 计「跳过」而不是「丢失」（否则凭据过期 = 一屏假警报）', async () => {
  await withIntegrity({
    buckets: {
      b1: [
        { key: 'forbidden.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } },
        { key: 'boom.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } },
      ],
    },
    headError: {
      'forbidden.bin': Object.assign(new Error('Access Denied'), { statusCode: 403, code: 'AccessDenied' }),
      'boom.bin': Object.assign(new Error('Internal Error'), { statusCode: 500 }),
    },
  }, async (m, calls) => {
    const st = await m.runOnce();
    assertEqual(st.bad, 0, '⚠️ 两种错误都不得计入异常 —— 它们证明不了"对象没了"');
    assertEqual(st.skipped, 2, '应计为跳过');
    assertEqual(st.findings.length, 2, '但仍要留下明细，让管理员知道"这一轮没查清"');
    assertEqual(st.findings.map((f) => f.verdict).join(','), 'error,error', '结论是「无法确认」，不是「已丢失」');
    assertEqual(calls.logs.filter((l) => l.level === 'warn' && l.action === 'integrity.findings').length, 0,
      '没有异常就不该报异常日志');
  });
});

test('R99-09 · 定时器与「立即巡检」撞车时共用同一次（云端请求不翻倍）', async () => {
  await withIntegrity({
    buckets: { b1: [{ key: 'a.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } }] },
    sizes: { 'a.bin': 10 },
  }, async (m, calls) => {
    const p1 = m.runOnce();
    const p2 = m.runOnce();
    assert(p1 === p2, 'runOnce 必须对"正在跑"合流 —— 返回同一个 Promise');
    const [r1, r2] = await Promise.all([p1, p2]);
    assertEqual(r1.scanned, 1, '两次调用只应有一次真实巡检');
    assertEqual(r2.scanned, 1, '第二个调用拿到的是同一份结果');
    assertEqual(calls.head.length, 1, `HEAD 次数应为 1（实际 ${calls.head.length}）—— 翻倍会直接翻倍云端请求成本`);
  });
});

test('R99-10 · 轮转游标：每轮只取 batch 条，下一轮接着上次的位置（不永远只查开头几个）', async () => {
  const saved = process.env.INTEGRITY_BATCH;
  process.env.INTEGRITY_BATCH = '2';
  const entries = ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((k) => ({
    key: k, meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' },
  }));
  try {
    await withIntegrity({
      buckets: { b1: entries },
      sizes: { 'a.bin': 10, 'b.bin': 10, 'c.bin': 10, 'd.bin': 10 },
    }, async (m, calls) => {
      assertEqual(m.batchSize(), 2, 'INTEGRITY_BATCH 应被读到（部署侧用它给云端请求封顶）');
      const r1 = await m.runOnce();
      assertEqual(r1.scanned, 2, '每轮只查 batch 条');
      const firstKeys = calls.head.map((h) => h.key);
      assertEqual(firstKeys.join(','), 'a.bin,b.bin', '第一轮应从头开始');

      calls.head.length = 0;
      const r2 = await m.runOnce();
      assertEqual(r2.scanned, 2, '第二轮同样 batch 条');
      assertEqual(calls.head.map((h) => h.key).join(','), 'c.bin,d.bin',
        '⚠️ 游标必须推进 —— 否则每 6 小时都只查前 200 个对象，剩下的永远不会被体检');
    });
  } finally {
    if (saved === undefined) delete process.env.INTEGRITY_BATCH; else process.env.INTEGRITY_BATCH = saved;
  }
});

test('R99-11 · 候选集命中时省掉 HEAD，但仍按长度判定（候选集只省请求，不当判据）', async () => {
  await withIntegrity({
    buckets: { b1: [{ key: 'hit.bin', meta: { mode: 'magic', origSize: 10, createdAt: '2026-10-01T00:00:00.000Z' } }] },
    candidateItems: [{ key: 'hit.bin', size: 3 }],
  }, async (m, calls) => {
    const st = await m.runOnce();
    assertEqual(calls.head.length, 0, '候选集里已有尺寸 ⇒ 不必再 HEAD（省一次云端请求）');
    assertEqual(st.bad, 1, '但判据照样执行：候选集说 3 字节、元数据说 10 字节 ⇒ 长度不符');
    assertEqual(st.findings[0].verdict, 'size', '结论仍是 size');
  });
});

/* ================================================================== *
 * 第 3 层 · 接线（缺一处就是一个"看不见"或"点了报错"的功能）
 * ================================================================== */

test('R99-12 · 接线：卡片登记 / 容器与按钮 / 两条 API / 路由挂 requireAdmin', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const js = read('public/js/syssettings.js');
  const html = read('public/index.html');
  const api = read('public/js/api.js');
  const route = read('server/routes/integrity.js');

  assertMatch(js, /ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-integrity-card'/,
    '卡片必须登记进 ADMIN_ONLY_CARDS —— 否则普通用户也能看到全部桶名与对象键');
  assert(html.indexOf('id="sysset-integrity-card"') >= 0, 'index.html 必须有卡片容器');
  assert(html.indexOf('id="btn-integrity-run"') >= 0, '卡片上必须有「立即巡检」按钮（巡检不能自动跑）');
  assert(api.indexOf("'/api/integrity'") >= 0, 'api.js 必须提供 GET /api/integrity');
  assert(api.indexOf("'/api/integrity/run'") >= 0, 'api.js 必须提供 POST /api/integrity/run');

  // 两条路由都要挂 requireAdmin（数量断言，避免"只给一条挂了"）
  const guarded = route.match(/router\.(get|post)\('\/integrity[^']*',\s*requireAdmin/g) || [];
  assertEqual(guarded.length, 2, 'GET 与 POST 都必须挂 requireAdmin');

  // 渲染：锁定 / 损坏要分开说，异常与"没查清"也要分开说
  assert(js.indexOf('meta-corrupt') >= 0 && js.indexOf('locked') >= 0,
    '前端必须能区分「锁定态」与「元数据损坏」—— 两者的处置完全不同');
});

/** 本文件只用到 assertMatch 的「必须匹配」语义，单独实现以免与 helpers 的签名纠缠 */
function assertMatch(text, re, msg) {
  assert(re.test(text), msg);
}
