/**
 * 路由：监控统计（速率 / 存储用量 / 汇总 / 操作日志） + 健康检查
 */
const { express, configStore, statsStore } = require('./_context');
// R71：`/health` 的运维字段按「是否管理层」分档 —— 根用户必须与管理员同级
const roles = require('../roles');
const secureStore = require('../secure-store');
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
  let key;
  try { key = bucketCacheKey(cfg); } catch (e) { return; }
  /**
   * R25：同一次增量**同时**喂给「按 API Key 的配额记账」（`bucket-stats.recordUsageDelta`）。
   *
   * 这里是全库写入/释放增量最集中的咽喉点（上传直传 / 分片合并 / 删除 / 清空桶都经此处），
   * 因而也是「配额判定用数字」的唯一增量来源 —— 若另起一处记账，两边迟早漏一条路径
   * （典型症状：某个入口的写入不计入配额，用户可借它无限绕开限制）。
   * 记账是纯内存累加、不抛错；`adjustStorageCache` 本身仍保持「无缓存条目即静默空转」的语义。
   */
  recordUsageDelta(cfg, delta);
  const hit = storageCacheMap.get(key);
  if (!hit || !hit.data) return;
  hit.data.usedBytes = Math.max(0, (hit.data.usedBytes || 0) + delta);
  hit.data.statTime = new Date().toISOString();
  hit.t = Date.now();
}

// 实时上传/下载速率（近 10 秒平均）
router.get('/stats/speed', (req, res) => {
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
  const items = await listAll(client, cfg, '', { cap: LIMITS.SCAN });
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
    // 缓存键含 provider/凭据/桶/地域 —— 切换桶或多云同名桶时不会串用旧数字
    const cacheKey = bucketCacheKey(cfg);
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
router.get('/stats/summary', async (req, res) => {
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
  }
  const secureErr = secureStore.getLastWriteError();
  if (secureErr) { out.ok = false; out.secureWriteError = secureErr; }
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
