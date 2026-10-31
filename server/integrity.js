/**
 * 完整性巡检 / 防勒索校验（R99）
 * ============================================================================
 *
 * ## 它要解决的问题
 *
 * 本系统把**密文**放到别人的对象存储上。云端那份字节是否还是我们写上去的那份，
 * 本地原本一无所知：控制台误操作、生命周期规则、同步工具回写、勒索软件批量覆盖
 * —— 这些都不会经过本系统，`list-cache` 的失效钩子也收不到任何信号。
 *
 * 表现最恶劣的一种是**静默**：文件还在、能列出来、点下载也不报错，但内容已经不
 * 是自己的了。因此需要一个**周期性、只读、不需要解密**的体检：只看「对象还在不在」
 * 「长度对不对」「写完之后有没有被动过」。
 *
 * ## 三个判据，全部来自一次 HEAD
 *
 * | 判据 | 事实 | 能抓到什么 |
 * | --- | --- | --- |
 * | `missing` | HEAD 返回 404 / NoSuchKey | 对象被删、被生命周期规则清掉、桶被换 |
 * | `size` | `ContentLength` ≠ 由元数据推导的长度 | 截断、拼接、被换成别的文件、上传中断 |
 * | `modified` | 云端 `Last-Modified` 晚于本地 `createdAt`（带时钟容差） | **同长度的原位覆盖**（勒索软件 / 同步工具回写） |
 *
 * ⚠️ 第三个判据是**不需要额外请求**就拿到的最强信号：`modified` 只说明"这个对象在
 * 我们写完它之后又被写过一次"，而本系统除了「用户主动覆盖上传」（那时会一并更新
 * `createdAt`）之外，没有任何正常路径会去改写一个已存在的密文。
 *
 * ## 为什么不重算 `enc-meta.json` 里那些 sha256
 *
 * 因为**那些摘要是明文的**（`magic.sha256` 是整个明文文件的摘要，`magic.parts[].sha256`
 * 是每个明文分片的摘要）。重算它们必须先把密文解出来 —— 而本轮的红线是
 * **巡检不碰密钥**：不需要解锁、不读 DEK、不做任何解密。巡检要在「进程处于锁定态」
 * 时也能安全地什么都不做，而不是成为一条新的"必须解锁才能跑"的后台任务。
 *
 * 代价必须写清楚：**同长度、且 `Last-Modified` 没变的原位篡改，本巡检抓不到**
 * （攻击者若连对象的时间戳都能保持一致，只能靠下载时的 GCM tag / 明文摘要检出）。
 * 这是刻意接受的边界，不是遗漏 —— 见 `Develop_Document.md` 的同名小节。
 *
 * ## 为什么必须最先判「锁定态」
 *
 * `enc-meta.json` 是**加密文件**。R97 记录过三条真实误判路径，其中最贵的一条：
 * `enc-store.loadMeta()` 的 catch 会置 `metaCorrupt = true` 并**本进程永久拒写**
 * —— 锁定态下读一次元数据就会把全站的新密文元数据锁死，解锁也救不回来。
 * 因此巡检的门是 `configStore.isLocked()`（唯一判据点），锁定就**一步都不往下走**：
 * 不枚举桶、不读元数据、不发任何云端请求。
 *
 * ## 候选集与成本
 *
 * 候选集 = `enc-meta.json` 的键（"我们加密过哪些对象"的**唯一权威**），不是列举
 * 云端的结果：列举回答的是"桶里有什么"，既证明不了"我们那份还在"，也解释不了
 * "少了一个对象"到底是删了还是改名了。轮转游标 + 每轮上限把成本摊平 —— 一万个
 * 对象、每轮 200、每小时一轮，两天覆盖一遍，云端请求量约等于一次浏览。
 *
 * 顺带复用 `search-candidates` 的候选集：若某个桶最近被"全桶递归搜索"过，
 * 那份候选集里已经带着每个对象的尺寸，**命中的对象连 HEAD 都省了**（少一次请求）。
 * 它只用来省请求，绝不拿来当判据 —— 候选集是明确可能过期的清单。
 */
const encStore = require('./enc-store');
const configStore = require('./config-store');
const { resolveBucketClient, mapLimit, bucketCacheKey } = require('./bucket-stats');
const candidates = require('./search-candidates');
const { p } = require('./s3');
const statsStore = require('./stats-store');

/** 每轮默认巡检对象数（每桶）。给「一次巡检别把云端配额吃光」一个硬上限。 */
const DEFAULT_BATCH = 200;
/**
 * 巡检周期默认 6 小时。
 *
 * 选这个值的理由：本功能防的是"云端被人动了而我们不知道"，它不是监控、不需要分钟级；
 * 而 6 小时 × 200 个对象/轮 ≈ 一天 800 个对象，让"被发现"的延迟与"被抓到之前损失多少"
 * 都落在可接受区间。`INTEGRITY_SWEEP_MS=0` 可整体关闭（排查线上问题时的手闸）。
 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * 「被改写」判据的时钟容差。
 *
 * 云端与本机的时钟不可能严格一致，而 `Last-Modified` 只精确到秒；上传完成到元数据
 * 落盘之间又有几百毫秒。容差取得太小会把正常上传判成篡改（最忌讳的假阳性：用户
 * 一开巡检就看到自己刚传的文件"被篡改"），取得太大则会漏掉紧跟写入的覆盖。
 * 5 分钟远大于时钟漂移，又远小于"我们写完它之后才被改写"的现实间隔。
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * 内存里保留的明细条数上限（界面上只展示最近的这些，全量在操作日志里）。
 *
 * ⚠️ 明细必须记进**本轮的结果对象**，不能记进模块级的 `last` —— `last` 是上一轮的
 * 结果，而本轮要到 `commit()` 才替换它。R99 第一版就踩了这个：计数（`bad`）是本轮的，
 * 明细却写进了**上一轮**的数组，于是「2 项异常 + 空列表」，日志里那句"哪些对象异常"
 * 也跟着变空 —— 计数与明细各说各话，比不显示更误导。
 */
const MAX_FINDINGS = 50;
/** 并发 HEAD 上限：巡检是后台任务，不该把连接池占满 */
const CONCURRENCY = 4;

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** 巡检周期（毫秒）；0 = 关闭。每次读环境变量，便于测试与线上止血 */
function intervalMs() { return envInt('INTEGRITY_SWEEP_MS', DEFAULT_INTERVAL_MS); }
function batchSize() {
  const n = envInt('INTEGRITY_BATCH', DEFAULT_BATCH);
  return n > 0 ? n : DEFAULT_BATCH;
}
function enabled() { return intervalMs() > 0; }

/* ============================ 判据 ============================ */

/**
 * 由加密元数据推导「云端对象应该有多长」。
 *
 * 密文布局（与 `enc-store` 的加密实现逐字节对应）：
 *  - `crypto`：`[COSCENC01][iv(12)][ct][tag(16)]`，分片上传时**只有第一片**带魔数头，
 *    其余片是 `[iv][ct][tag]`；因此总长 = 魔数长 + Σ(12 + ctLen + 16)。
 *  - `magic`：魔数覆写文件头 + 其余流式异或，**长度与明文完全相等**。
 *
 * @returns {number|null} null = 这条元数据算不出长度（未知模式 / 结构残缺）
 */
function expectedCloudSize(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (meta.mode === 'magic') {
    const n = Number(meta.origSize);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (meta.mode === 'crypto') {
    const segs = meta.crypto && meta.crypto.segments;
    if (!Array.isArray(segs) || !segs.length) return null;
    let total = encStore.CRYPTO_MAGIC.length;
    for (const s of segs) {
      const ctLen = Number(s && s.ctLen);
      if (!Number.isFinite(ctLen) || ctLen < 0) return null;
      total += encStore.IV_LEN + ctLen + encStore.TAG_LEN;
    }
    return total;
  }
  return null;
}

/** `Last-Modified` 头 → 毫秒时间戳；解析不出来返回 null（判据跳过，不猜） */
function parseHttpDate(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 判定一条 HEAD 结果。
 *
 * @param {object} args
 * @param {object} args.meta  加密元数据（`enc-meta.json` 里的条目）
 * @param {number} args.cloudSize 云端 `Content-Length`
 * @param {string} [args.lastModified] 云端 `Last-Modified`
 * @returns {{verdict:'ok'|'size'|'modified'|'unknown', expect:number|null, detail:string}}
 */
function classify({ meta, cloudSize, lastModified }) {
  const expect = expectedCloudSize(meta);
  if (expect === null) {
    return { verdict: 'unknown', expect: null, detail: '元数据无法推导密文长度（模式未知或结构残缺）' };
  }
  const size = Number(cloudSize);
  if (!Number.isFinite(size)) {
    return { verdict: 'unknown', expect, detail: '云端未回传 Content-Length' };
  }
  if (size !== expect) {
    return {
      verdict: 'size', expect,
      detail: `长度不符：云端 ${size} 字节，按元数据应为 ${expect} 字节（差 ${size - expect}）`,
    };
  }
  /**
   * 「写完之后又被写过」。
   *
   * `createdAt` 解析不出来时**跳过这一条**而不是当成篡改：历史条目里存在没有
   * `createdAt` 的记录（R66 之前写入的），把它们全判成"被改写"会制造一整屏假警报，
   * 那比漏检更糟 —— 用户会立刻学会无视这个功能。
   */
  const wroteAt = Date.parse(String((meta && meta.createdAt) || ''));
  const cloudAt = parseHttpDate(lastModified);
  if (Number.isFinite(wroteAt) && cloudAt !== null && cloudAt > wroteAt + CLOCK_SKEW_MS) {
    return {
      verdict: 'modified', expect,
      detail: `对象在本系统写入之后又被改动过：本地写入 ${new Date(wroteAt).toISOString()}，`
        + `云端最后修改 ${new Date(cloudAt).toISOString()}`,
    };
  }
  return { verdict: 'ok', expect, detail: '' };
}

/**
 * 「确认不存在」的唯一判据（与 `routes/fs.js` 的 `isNotFoundError()` 同口径）。
 *
 * 只认 404 与 `NoSuchKey` / `NotFound`。**403（凭据缺 HeadObject 权限）、5xx、
 * 网络超时一律不算**「不存在」—— 把探测失败当成"对象没了"，巡检就会在凭据过期或
 * 网络抖动时刷出一整批假警报，而真正的丢失反而被淹没。
 */
function isNotFoundError(e) {
  if (!e) return false;
  const sc = e.statusCode === undefined ? e.status : e.statusCode;
  if (Number(sc) === 404) return true;
  return /NoSuchKey|NotFound/i.test(String(e.code || ''));
}

/* ============================ 巡检状态 ============================ */

/** 每桶的轮转游标（进程内；重启归零 —— 巡检没有"必须接着上次"的语义） */
const cursors = new Map();
/** 最近一次的巡检结果（供界面展示） */
let last = {
  at: null, durationMs: 0, scanned: 0, ok: 0, bad: 0, skipped: 0, buckets: 0,
  findings: [], skippedReason: '',
};
let running = null;

function state() {
  return {
    enabled: enabled(),
    intervalMs: intervalMs(),
    batch: batchSize(),
    lastRunAt: last.at,
    durationMs: last.durationMs,
    scanned: last.scanned,
    ok: last.ok,
    bad: last.bad,
    skipped: last.skipped,
    buckets: last.buckets,
    skippedReason: last.skippedReason,
    // 锁定 / 元数据损坏是**两种完全不同的状态**，界面上要分开说（R97 同款教训）
    locked: configStore.isLocked(),
    metaCorrupt: encStore.metaIsCorrupt(),
    findings: last.findings.slice(),
  };
}

/* ============================ 候选集 ============================ */

/**
 * 候选集命中：从「全桶递归搜索」留下的候选集里取出 key → 云端尺寸。
 *
 * 只用它**省掉 HEAD**，不用它当判据。候选集过期由 TTL 自愈（默认 10 秒），
 * 因此这里只在"刚好热着"时命中，否则老老实实发 HEAD。
 */
function cachedSizes(cfg) {
  let key = null;
  try {
    key = candidates.keyOf(bucketCacheKey(cfg), '', 'recursive');
  } catch (e) {
    return null;
  }
  const cand = candidates.get(key);
  if (!cand || !cand.complete || !Array.isArray(cand.items)) return null;
  const m = new Map();
  for (const it of cand.items) {
    if (it && typeof it.key === 'string') m.set(it.key, Number(it.size) || 0);
  }
  return m;
}

/**
 * 跑一轮巡检。
 *
 * 逐桶处理、每桶只取 `batch` 条（轮转游标），单条失败不影响其余，
 * 单桶失败不影响其它桶 —— 与 `account-deletion.purgeDue()` 同一条纪律：
 * 后台任务必须"部分成功也算成功"，否则一次网络抖动会让整轮白跑。
 *
 * ⚠️ 刻意**不是** `async function`：定时器与「立即巡检」撞车时，两次调用必须拿到
 * **同一个 Promise**（`p1 === p2`），否则"合流"只是"两次都跑"的委婉说法。
 * `async` 会把返回的 Promise 再包一层，身份就断了。
 *
 * @param {Date} [now]
 * @returns {Promise<object>} 与 `state()` 同形（另带本次结果）
 */
function runOnce(now = new Date()) {
  if (running) return running; // 定时器与「立即巡检」撞车时共用同一次
  running = runOnceInner(now).finally(() => { running = null; });
  return running;
}

async function runOnceInner(now) {
  const started = Date.now();
  const result = {
    at: now.toISOString(), durationMs: 0, scanned: 0, ok: 0, bad: 0, skipped: 0,
    buckets: 0, findings: [], skippedReason: '',
  };
  /**
   * 明细的**唯一写入点**：写进本轮结果对象，不写模块级的 `last`。
   * （`last` 此刻还是上一轮的结果，要到 `commit()` 才被替换 —— 详见 `MAX_FINDINGS` 的注释。）
   */
  const noteFinding = (f) => {
    if (result.findings.length >= MAX_FINDINGS) return;
    result.findings.push(f);
  };
  const commit = (reason) => {
    result.skippedReason = reason || '';
    result.durationMs = Date.now() - started;
    last = result;
    if (reason) return state();
    if (result.bad > 0) {
      statsStore.addLog({
        action: 'integrity.findings', level: 'warn',
        detail: `完整性巡检发现 ${result.bad} 个异常对象（本轮共查 ${result.scanned} 个）：`
          + result.findings.slice(0, 5).map((f) => `${f.bucket}/${f.key}（${f.verdict}）`).join('、')
          + (result.bad > 5 ? ' 等' : ''),
      });
    }
    return state();
  };

  /**
   * ⚠️ 门必须开在最前面（理由见文件头）：锁定态下读 `enc-meta.json` 会把
   * `metaCorrupt` 置真并让本进程永久拒写元数据 —— 一次巡检就能把全站上传打坏。
   */
  if (configStore.isLocked()) return commit('locked');
  if (encStore.metaIsCorrupt()) return commit('meta-corrupt');

  let buckets = [];
  try {
    buckets = encStore.metaBuckets();
  } catch (e) {
    return commit('meta-unreadable');
  }
  result.buckets = buckets.length;
  if (!buckets.length) return commit('');

  for (const bucket of buckets) {
    const target = resolveBucketClient({ bucket, region: '' });
    if (!target) {
      // 桶已从配置里移除 / 该厂商没有可用密钥：跳过，不猜
      result.skipped += 1;
      continue;
    }
    let entries = [];
    try {
      entries = encStore.metaEntriesFor(bucket)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } catch (e) {
      result.skipped += 1;
      continue;
    }
    if (!entries.length) continue;
    const start = (cursors.get(bucket) || 0) % entries.length;
    const slice = [];
    for (let i = 0; i < Math.min(batchSize(), entries.length); i++) {
      slice.push(entries[(start + i) % entries.length]);
    }
    cursors.set(bucket, (start + slice.length) % entries.length);

    const sizes = cachedSizes(target.cfg);
    await mapLimit(slice, CONCURRENCY, async (ent) => {
      const base = { bucket, key: ent.key, mode: (ent.meta && ent.meta.mode) || '' };
      try {
        let cloudSize = sizes ? sizes.get(ent.key) : undefined;
        let lastModified = null;
        if (cloudSize === undefined) {
          const head = await p(target.s3, 'headObject', {
            Bucket: target.cfg.bucket, Region: target.cfg.region, Key: ent.key,
          });
          cloudSize = Number(head && head.headers && head.headers['content-length']);
          lastModified = head && head.headers && head.headers['last-modified'];
        }
        const r = classify({ meta: ent.meta, cloudSize, lastModified });
        result.scanned += 1;
        if (r.verdict === 'ok') { result.ok += 1; return; }
        if (r.verdict === 'unknown') { result.skipped += 1; noteFinding({ ...base, verdict: r.verdict, detail: r.detail }); return; }
        result.bad += 1;
        noteFinding({ ...base, verdict: r.verdict, detail: r.detail });
      } catch (e) {
        if (isNotFoundError(e)) {
          result.scanned += 1;
          result.bad += 1;
          noteFinding({ ...base, verdict: 'missing', detail: '云端已无此对象（HEAD 404 / NoSuchKey）' });
          return;
        }
        // 其余（403 / 5xx / 网络）**不是**「不存在」的证据：计为跳过，绝不报成丢失
        result.skipped += 1;
        noteFinding({ ...base, verdict: 'error', detail: `无法确认（${(e && (e.code || e.message)) || '未知错误'}）` });
      }
    });
  }
  return commit('');
}

/** 供测试与「重置巡检进度」使用：清空游标与最近结果 */
function _resetForTest() {
  cursors.clear();
  running = null;
  last = {
    at: null, durationMs: 0, scanned: 0, ok: 0, bad: 0, skipped: 0, buckets: 0,
    findings: [], skippedReason: '',
  };
}

module.exports = {
  DEFAULT_BATCH, DEFAULT_INTERVAL_MS, CLOCK_SKEW_MS, MAX_FINDINGS,
  intervalMs, batchSize, enabled,
  expectedCloudSize, classify, isNotFoundError,
  runOnce, state, _resetForTest,
};
