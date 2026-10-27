/**
 * 路由：监控统计（速率 / 存储用量 / 汇总 / 操作日志） + 健康检查
 */
const { express, configStore, statsStore } = require('./_context');
// R71：`/health` 的运维字段按「是否管理层」分档 —— 根用户必须与管理员同级
const roles = require('../roles');
const secureStore = require('../secure-store');
const encPool = require('../enc-pool'); // R94（审核 M09-07）：健康检查报加密线程池降级状态
const updateCheck = require('../update-check');
const { LIMITS } = require('../limits');
const { getClient, translateError, listAll } = require('../s3');
const { requireConfig, requireAdmin, bucketCacheKey, asyncHandler, recordUsageDelta } = require('./_shared');

const router = express.Router();

/* ==================== 容量缓存（PERF-05） ====================
 *
 * 旧实现是**单槽**变量 `{key,t,data}`：多桶交替查询时每换一次桶就整槽失效，
 * 命中率趋近于 0，且不可缓存多桶结果。改为按 `bucketCacheKey` 索引的 Map +
 * LRU 上限（最多 16 桶），并叠加「同桶并发请求共享同一个 in-flight Promise」，
 * 避免同一次页面刷新对每个桶重复发起昂贵的云端调用。
 */
const STORAGE_TTL = 15 * 60 * 1000; // 列举扫描不便宜（最多 5000 个对象），15 分钟一取足够且更省调用（PERF-05）
const STORAGE_CACHE_MAX = 16;
/** @type {Map<string, {t:number, data:object}>} */
const storageCacheMap = new Map();
/** @type {Map<string, Promise<object>>} */
const storageInflight = new Map();

/**
 * R89：用量缓存的键**必须含空间维度**。
 *
 * 缓存原本只按桶区分 —— 于是「谁先请求，谁的数字被所有人看到」：管理员先刷新一次，
 * 桶级总量就被缓存下来，接下来 `delta` 时长内每个普通用户的状态栏拿到的都是
 * **整个桶**的用量（这是「每个用户只看自己的那一部分」的直接反面）。
 *
 * 空串 = 管理层视角（桶级总量）。`adjustStorageCache()` 与之共用本函数，
 * 否则「刚传完文件用量不动」会重新出现。
 */
function storageKeyOf(cfg) {
  return bucketCacheKey(cfg) + '|' + String((cfg && cfg.spaceRoot) || '');
}

function cacheGet(key) {
  const hit = storageCacheMap.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t >= STORAGE_TTL) { storageCacheMap.delete(key); return null; }
  // LRU：命中即移到末尾
  storageCacheMap.delete(key);
  storageCacheMap.set(key, hit);
  return hit.data;
}

function cacheSet(key, data) {
  storageCacheMap.delete(key);
  storageCacheMap.set(key, { t: Date.now(), data });
  while (storageCacheMap.size > STORAGE_CACHE_MAX) {
    storageCacheMap.delete(storageCacheMap.keys().next().value);
  }
}

/**
 * 用量缓存增量修正：上传/删除后立即修正本地缓存，使状态栏无需等缓存过期（15 分钟）就能反映变化。
 *
 * @param {number} delta 正数=新增字节，负数=释放字节
 * @param {object} [cfg] 目标桶配置（用于计算缓存键）。缺失时不做修正 ——
 *   宁可让数字 TTL 到期后再刷新，也不能把增量加到**错误的桶**上。
 */
function adjustStorageCache(delta, cfg) {
  if (!delta || !cfg) return;
  let base;
  try { base = bucketCacheKey(cfg); } catch (e) { return; }
  /**
   * R25：同一次增量**同时**喂给「按 API Key 的配额记账」（`bucket-stats.recordUsageDelta`）。
   *
   * 这里是全库写入/释放增量最集中的咽喉点（上传直传 / 分片合并 / 删除 / 清空桶都经此处），
   * 因而也是「配额判定用数字」的唯一增量来源 —— 若另起一处记账，两边迟早漏一条路径
   * （典型症状：某个入口的写入不计入配额，用户可借它无限绕开限制）。
   * 记账是纯内存累加、不抛错；`adjustStorageCache` 本身仍保持「无缓存条目即静默空转」的语义。
   */
  recordUsageDelta(cfg, delta);
  const root = String(cfg.spaceRoot || '');
  const hit = storageCacheMap.get(base + '|' + root);
  if (hit && hit.data) {
    hit.data.usedBytes = Math.max(0, (hit.data.usedBytes || 0) + delta);
    hit.data.statTime = new Date().toISOString();
    hit.t = Date.now();
  }
  /**
   * R89：非管理层的写入**失效**桶级（管理层）那条缓存，而不是猜一个增量。
   *
   * 桶级总量是**所有人**的合计，一次属于某个用户空间的写入到底让它涨了多少，
   * 这里只知道总额（`delta`），不知道归属 —— 直接加进去数字是对的，但「桶级」
   * 这条数字随后就没有记录者了（谁的写入都往它上面加，包括管理层自己的）。
   * 与其维护一个没人能对账的混合账本，不如让它作废、让管理员的下次请求重新扫一遍：
   * 代价是他最多晚 15 秒看到准确数字，收益是不再出现「两个来源各说一套」。
   */
  if (root) storageCacheMap.delete(base + '|');
}

// 实时上传/下载速率（近 10 秒平均）
//
// R94（审核 M13-07）：**仅管理员**。`statsStore.speed()` 统计的是**全实例**吞吐
// （`sampleTraffic()` 不带用户维度），普通用户拿到的不是"自己那一部分"，而是所有
// 用户加总的实时速率 —— 与 R89 为 `/stats/storage` 做的那次收敛（按 `spaceRoot`
// 只统计自己那一段）是同一条产品约定，这里是当时漏掉的一处。
router.get('/stats/speed', requireAdmin, (req, res) => {
  res.json(statsStore.speed());
});

/**
 * 桶用量：**分页列举对象累计**（唯一路径）。
 *
 * R49：此前这里先试腾讯云 COS 原生的 `GET /<bucket>?stats`（一次调用拿到精确总量，
 * 失败才回退列举）。COS 原生协议整体移除后，`S3Client#request()` 对任何 action 都
 * 立即回 `NotImplemented`（501），那条快路径就变成了「每个桶白打一次必然失败的请求」，
 * 因此直接删除 —— 现在**所有**厂商都走列举，`source` 恒为 `'ListScan'`。
 *
 * `estimated` 如实反映是否为下界：`listAll` 最多扫 `LIMITS.SCAN` 个对象，
 * 扫满即意味着后面还有（此时数字是**下界**，界面会标注出来）。
 *
 * @param {object} cfg 目标桶配置
 */
async function queryStorage(cfg) {
  const client = getClient(cfg);
  // R89：普通用户只统计**自己那一段**（`cfg.spaceRoot`），管理层仍是桶级总量。
  // 不加根的话，状态栏/仪表盘会向普通用户展示整个桶的用量 —— 既是聚合信息泄露，
  // 也与他「只能看到自己那一部分」的界面自相矛盾。
  const items = await listAll(client, cfg, String(cfg.spaceRoot || ''), { cap: LIMITS.SCAN });
  return {
    usedBytes: items.reduce((s, x) => s + x.size, 0),
    objectCount: items.length,
    source: 'ListScan',
    estimated: items.length >= LIMITS.SCAN,
    statTime: new Date().toISOString(),
  };
}

// 存储用量（按桶缓存；R49 起一律为分页列举结果，见 queryStorage 的说明）
router.get('/stats/storage', async (req, res) => {
  try {
    const cfg = requireConfig();
    // 缓存键含 provider/凭据/桶/地域 —— 切换桶或多云同名桶时不会串用旧数字；
    // R89 起还含**空间维度**（见 storageKeyOf）
    const cacheKey = storageKeyOf(cfg);
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // 同桶并发请求合并：共享同一个 in-flight Promise，避免重复打云端（PERF-05）
    let inflight = storageInflight.get(cacheKey);
    if (!inflight) {
      inflight = queryStorage(cfg)
        .then((out) => { cacheSet(cacheKey, out); return out; })
        .finally(() => { storageInflight.delete(cacheKey); });
      storageInflight.set(cacheKey, inflight);
    }
    res.json(await inflight);
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 汇总统计：容量 + 流量 + 请求（7 天）
//
// R94（审核 M13-07）：**仅管理员** —— 与 `/stats/logs`（SEC-07）与 `/stats/storage`
// （R89 按 `spaceRoot` 收敛）同一口径。`statsStore.summary()` 里的 7 天流量、按请求
// 类型聚合、以及 `quotaBytes`（取自**全实例**配置）都不带用户维度；对普通用户开放
// 等于把「全站此刻有多少人传了多少东西」摊给每个人看，单用户规模下甚至能反推
// 他人的活动时间与体量。
router.get('/stats/summary', requireAdmin, async (req, res) => {
  try {
    const cfg = configStore.get();
    const quotaBytes = cfg ? cfg.quotaBytes : 0; // 0 = 无限制
    res.json(Object.assign({ quotaBytes }, statsStore.summary()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 操作日志（**仅管理员**）
//
// SEC-07：日志 detail 字段包含用户名、客户端 IP、对象键、桶名
// （如 auth.login / fs.delete / share.download），对普通用户开放等于泄露
// 全部存储桶清单与其它用户的完整操作轨迹，违反「普通用户仅见自己可见资源」的约定。
router.get('/stats/logs', requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const logs = await statsStore.getLogs({ limit, level: String(req.query.level || ''), action: String(req.query.action || '') });
  res.json({ logs });
}));

/* ============================ 健康检查 ============================ */

router.get('/health', (req, res) => {
  const cfg = configStore.get();
  // SEC-09：把「敏感数据文件写入失败」与「文件损坏」状态一并暴露，
  // 否则 enc-meta.json 这类唯一解密凭据的故障将完全静默（密文永久不可解）。
  const out = {
    ok: true,
    time: new Date().toISOString(),
    configured: Boolean(cfg && cfg.secretId && cfg.secretKey),
    corrupted: configStore.isCorrupted(),
  };
  /**
   * R66：运维诊断最常问的两件事 —— 「这台实例上到底有几个桶」与「配置最后一次
   * 被改动是什么时候」。没有它们，排查只能去翻 `logs.jsonl`（明文、5000 条滚动、
   * 可被本机用户编辑）或者 `stat data/config.enc` 看文件 mtime（加密落盘后
   * 每次内容都变，但 mtime 会被任何一次重启刷掉）。
   *
   * ⚠️ **仅管理员可见**，这是它与上面两个字段的关键区别：`configured` / `corrupted`
   * 是「这台实例能不能用」，普通用户也要得到这个答案；而「一共几个桶」是**跨用户**
   * 的规模信息（普通用户只看得到 `visibleToUsers` 的那些）。`/health` 只要求登录、
   * 不挂 `requireAdmin`（前端全局横幅与运维探针都靠它），所以这里按角色分档下发，
   * 而不是给它单独挂管理员守卫 —— 那会让普通用户拿到 403、拿不到「服务是否可用」。
   */
  if (req.authUser && roles.isStaff(req.authUser.role)) {
    out.bucketCount = cfg && Array.isArray(cfg.buckets) ? cfg.buckets.length : 0;
    out.lastWriteAt = (cfg && cfg.updatedAt) || '';
    /**
     * R94（审核 M09-07）：把加密线程池的降级状态报出来。
     *
     * 降级后 magic 模式一个 48MB 分片要在主线程同步异或约 3 秒、期间全站零响应，
     * 而管理界面的「线程并发」卡片看不出任何区别 —— 运维只会觉得「这台机器最近
     * 怎么这么慢」。只给管理层看（与 `bucketCount` 同档），普通用户不需要。
     */
    const pool = encPool.stats();
    out.encPool = {
      degraded: Boolean(pool.degraded),
      cooling: Boolean(pool.cooling),
      workers: pool.workers,
      queued: pool.queued,
      degradeCount: pool.degradeCount,
    };
  }
  const secureErr = secureStore.getLastWriteError();
  /**
   * R87：只下发**文件名**，不下发绝对路径。
   *
   * `getLastWriteError()` 原样带着 `file`（如 `C:\Users\…\data\links.json` 或
   * `/opt/kepler/data/config.enc`），而 `/health` 只要求登录、不挂 `requireAdmin`
   * —— 任何普通用户都能读到本实例的磁盘布局与数据目录。
   * `secure-store.js` 自己打印日志时用的就是 `path.basename()`，这里对齐同一口径。
   */
  if (secureErr) {
    out.ok = false;
    /**
     * R94（审核 M13-01）：`message` 同样要脱敏，不能只换 `file`。
     *
     * R87 把 `file` 换成了 basename，却用 `Object.assign({}, secureErr, …)`
     * 把其余字段原样带出 —— 而 `message` 就是 `atomic.writeAtomicSync()` 抛出的
     * **原始 fs 错误文案**，Node 的 fs 错误里带**绝对路径**：
     * `EACCES: permission denied, open '/opt/kepler/data/links.json.1234.a1b2.tmp'`
     * （Windows 上是 `C://Users//<登录名>//…`）。本端点只要求登录、不挂 requireAdmin
     * ⇒ 任何普通用户在磁盘写满 / 只读挂载的那一刻都能读到数据目录布局与系统用户名。
     *
     * 改成**白名单重建**（而不是在旧对象上覆盖）：只留 filename + 固定文案 + 时刻，
     * 原始 message 仅进服务端日志（`secure-store` 的 console.error 已经打过）。
     */
    out.secureWriteError = {
      file: require('path').basename(String(secureErr.file || '')),
      message: '敏感数据文件写入失败（详见服务端日志）',
      at: secureErr.at,
    };
  }
  const corruptFiles = secureStore.corruptList();
  if (corruptFiles.length) { out.ok = false; out.corruptFiles = corruptFiles; }
  res.status(out.ok ? 200 : 503).json(out);
});

/* ============================ 更新检查 ============================ */

/**
 * GET /update/check —— 「关于」卡片里的「检查更新」按钮。
 *
 * **刻意不挂 `requireAdmin`**：「关于」是设置页里**唯一保留给普通用户**的卡片
 * （见 `public/js/syssettings.js` 的 `ADMIN_ONLY_CARDS` 与 `refresh()` 的非管理员分支），
 * 误挂管理员守卫会让普通用户点一下就 403 —— 而那正是需求要求「所有用户都能用」的按钮。
 *
 * 判据与缓存全部下沉到 `server/update-check.js`（版本比较的**唯一实现点**）；
 * 这里只做「调用 + 回包」，出错时把 `status = 502` 交给全局错误处理器。
 */
router.get('/update/check', asyncHandler(async (req, res) => {
  res.json(await updateCheck.checkForUpdate());
}));

module.exports = router;
module.exports.adjustStorageCache = adjustStorageCache;
