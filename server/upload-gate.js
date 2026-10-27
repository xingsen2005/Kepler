/**
 * 上传数据面的**内存闸门**（FS-S1）。
 *
 * ## 为什么闸门必须挂在「读请求体之前」
 *
 * 两条上传路径都是 `express.raw({ type: () => true, limit: '64mb' })`：
 *
 * ```js
 * router.put('/fs/upload/simple', express.raw({ ... }), handler)
 * router.put('/fs/upload/chunk',  express.raw({ ... }), handler)
 * ```
 *
 * `express.raw` 是**中间件**，在进入 handler 之前就已经把整个请求体收进内存了。
 * 于是「在处理函数里判太大就返回 413」这类写法对内存毫无帮助 —— 判的那一刻
 * 那 64MB 已经分配完了。真正的风险也不在「一个文件有多大」，而在「同时有多少个」：
 *
 *     峰值内存 ≈ 并发请求数 × 单请求上限（64MB）× 加密副本系数
 *
 * 16 个并发 × 64MB ≈ 1GB，且 magic 模式还要再复制一份给 worker ⇒ 进程被 OOM
 * 杀掉，症状是**整站** 502，而不是「上传失败」。所以闸门只能是一个**先于 body
 * 解析**的中间件，靠 `Content-Length` 预先记账。
 *
 * ## 两道限额，各挡一类
 *
 * - **并发数**：挡「很多个小文件」——客户端「线程并发」上限是 16（`limits.js`），
 *   全局取 64 作硬天花板，同时给**单个用户**留 16（R94 / 审核 M07-04）：
 *   全局不设得大一点，"单人上限"就没有意义（一个人照样能占满），而并发数本身
 *   不直接决定内存（内存由下面的在途字节守住），宽一点只是多几个回调。
 * - **在途字节**：挡「少数几个超大文件」——4 × 64MB = 256MB 已经足够宽，而
 *   真被打满时拒绝的代价（一次重试）远小于进程被杀。单人也有一条 192MB 的线。
 *
 * 两个都要有：只限并发挡不住「16 个 64MB」，只限字节挡不住「1000 个 1KB」把
 * 文件句柄与回调堆积起来。
 *
 * ## 为什么拒绝要回 503 + Retry-After
 *
 * 这不是「参数错误」，重试立刻就会成功。前端拿到 503 显示「稍后重试」是准确的；
 * 若回 429 会被理解成「被限流封禁」，回 4xx 则可能被客户端当成永久失败而放弃。
 *
 * ## 记账口径
 *
 * 没有 `Content-Length`（`Transfer-Encoding: chunked`）时按**单请求上限**记账：
 * 宁可多算，不可少算 —— 少算的后果是闸门形同虚设。
 */

/**
 * 进程级并发硬天花板。
 *
 * R94（审核 M07-04）：原来取 16，与客户端「线程并发」上界同值 —— 于是**一个**用户
 * 就能把 16 个名额全部占住，别人一个也拿不到（详见 `DEFAULT_MAX_PER_USER`）。
 * 现在改成「全局 64 + 单人 16」：真正的内存守门人是**在途字节**（256MB），并发数
 * 只用来防「上千个 1KB 请求」把句柄与回调堆起来，给宽一点没有内存代价，
 * 却能把「一人打满全场」变成「最多占四分之一」。
 */
const DEFAULT_MAX_CONCURRENT = 64;
/** 在途字节上限：4 个 64MB 请求；超过就拒绝，而不是排队（排队会把内存压力换成超时） */
const DEFAULT_MAX_INFLIGHT_MB = 256;
/** 单请求体积上限（与 `express.raw` 的 limit 一致，用于「无 Content-Length」时记账） */
const DEFAULT_REQUEST_MAX_MB = 64;
/**
 * R94（审核 M07-04）：**单个用户**的并发名额与在途字节。
 *
 * 上面两个上限是进程级全局的，状态只有一份 —— 而客户端「线程并发」的上界正好也是
 * 16（`limits.js` 的 `FILE_CONCURRENCY_MAX`），于是**一个用户**就能开满全部 16 个
 * 名额：他保持上传不结束，其他所有用户的分片上传就一直是 503 `UPLOAD_BUSY`
 * （前端重试两次后标成"失败"）。这不是理论边界，而是管理员把「线程并发」调到最大
 * 之后的必然结果。
 *
 * 取值按「不能误伤合法用法」定：
 *  - 并发 16 = 客户端能开出的最大并发，合法用户永远碰不到自己的上限；
 *  - 在途字节 192MB（全局 256MB 的 3/4）—— 一个人占不满整块内存预算，
 *    而且 16 × 8MB（典型分片）＝ 128MB 仍在限额之内。
 * 两者都可用环境变量覆盖，与全局上限一样走 `envInt()`。
 */
const DEFAULT_MAX_PER_USER = 16;
const DEFAULT_PER_USER_INFLIGHT_MB = 192;

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function maxConcurrent() { return envInt('UPLOAD_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT); }
function maxInflightBytes() {
  return envInt('UPLOAD_MAX_INFLIGHT_MB', DEFAULT_MAX_INFLIGHT_MB) * 1024 * 1024;
}
function maxPerUserConcurrent() { return envInt('UPLOAD_MAX_PER_USER', DEFAULT_MAX_PER_USER); }
function maxPerUserBytes() {
  return envInt('UPLOAD_MAX_PER_USER_MB', DEFAULT_PER_USER_INFLIGHT_MB) * 1024 * 1024;
}
function requestMaxBytes() {
  return envInt('UPLOAD_REQUEST_MAX_MB', DEFAULT_REQUEST_MAX_MB) * 1024 * 1024;
}

/** 进程内在途状态。测试可 `reset()`；生产环境**永远不要**在运行中清空它 */
const state = { count: 0, bytes: 0, rejected: 0, peakCount: 0, peakBytes: 0 };

/**
 * R94（审核 M07-04）：**按主体**（登录用户 id）的在途状态。
 *
 * 只在有主体时记账（`gate()` 从 `req.authUser.id` 取）；无主体（理论上不该出现，
 * 上传路由都在鉴权之后）时只走全局判据，行为与旧实现一致。
 * 条目在计数归零时删除，Map 不会随请求数增长。
 */
const perUser = new Map();

function userSlot(subject) {
  const key = String(subject || '');
  if (!key) return null;
  let slot = perUser.get(key);
  if (!slot) { slot = { count: 0, bytes: 0 }; perUser.set(key, slot); }
  return { key, slot };
}

function dropIfIdle(entry) {
  if (entry && entry.slot.count <= 0 && entry.slot.bytes <= 0) perUser.delete(entry.key);
}

/**
 * 本次请求「声明」要占多少字节。
 *
 * @returns {number|null} `null` 表示无法判断 —— 调用方按**单请求上限**记账
 */
function declaredBytes(req) {
  const raw = req && req.headers ? req.headers['content-length'] : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * 试占一个名额。**同步**完成判定与记账（中间不能有 await，否则两次请求会穿过同一道判据）。
 *
 * @param {number} bytes 预计占用字节
 * @param {string} [subject] 主体（登录用户 id）；给了就额外受「单人上限」约束
 * @returns {{ok: true, ticket: object} | {ok: false, retryAfter: number, reason: string, limits: object}}
 */
function tryAcquire(bytes, subject) {
  const want = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const limitCount = maxConcurrent();
  const limitBytes = maxInflightBytes();
  if (state.count + 1 > limitCount) {
    state.rejected += 1;
    return {
      ok: false, retryAfter: 2,
      reason: `同时进行的上传任务过多（上限 ${limitCount} 个），请等当前上传完成后再试`,
      limits: { count: state.count, maxConcurrent: limitCount, bytes: state.bytes, maxBytes: limitBytes },
    };
  }
  if (state.bytes + want > limitBytes) {
    state.rejected += 1;
    return {
      ok: false, retryAfter: 2,
      reason: `服务器当前的待处理上传数据过多（在途 ${Math.round(state.bytes / 1048576)}MB，`
        + `上限 ${Math.round(limitBytes / 1048576)}MB），请等当前上传完成后再试`,
      limits: { count: state.count, maxConcurrent: limitCount, bytes: state.bytes, maxBytes: limitBytes },
    };
  }
  /**
   * R94（审核 M07-04）：单人上限。判据放在全局判据**之后**（先告诉他"服务器忙"，
   * 再细分是不是"你自己占太多"），文案也要能区分 —— 否则用户以为是网络问题。
   */
  const entry = userSlot(subject);
  if (entry) {
    const userCount = maxPerUserConcurrent();
    const userBytes = maxPerUserBytes();
    if (entry.slot.count + 1 > userCount) {
      state.rejected += 1;
      return {
        ok: false, retryAfter: 2,
        reason: `你正在进行的上传任务过多（单人上限 ${userCount} 个），请等当前上传完成后再试`,
        limits: {
          count: state.count, maxConcurrent: limitCount, bytes: state.bytes, maxBytes: limitBytes,
          userCount: entry.slot.count, userMaxConcurrent: userCount,
        },
      };
    }
    if (entry.slot.bytes + want > userBytes) {
      state.rejected += 1;
      return {
        ok: false, retryAfter: 2,
        reason: `你当前待上传的数据量过多（在途 ${Math.round(entry.slot.bytes / 1048576)}MB，`
          + `单人上限 ${Math.round(userBytes / 1048576)}MB），请等当前上传完成后再试`,
        limits: {
          count: state.count, maxConcurrent: limitCount, bytes: state.bytes, maxBytes: limitBytes,
          userBytes: entry.slot.bytes, userMaxBytes: userBytes,
        },
      };
    }
    entry.slot.count += 1;
    entry.slot.bytes += want;
  }
  state.count += 1;
  state.bytes += want;
  if (state.count > state.peakCount) state.peakCount = state.count;
  if (state.bytes > state.peakBytes) state.peakBytes = state.bytes;
  return { ok: true, ticket: { bytes: want, released: false, userId: entry ? entry.key : '' } };
}

/** 归还名额（幂等：同一 ticket 多次释放只算一次） */
function release(ticket) {
  if (!ticket || ticket.released) return;
  ticket.released = true;
  state.count = Math.max(0, state.count - 1);
  state.bytes = Math.max(0, state.bytes - ticket.bytes);
  // R94（M07-04）：单人名额同步归还（否则用户的名额只减不增，最终自己都传不了）
  if (ticket.userId) {
    const slot = perUser.get(ticket.userId);
    if (slot) {
      slot.count = Math.max(0, slot.count - 1);
      slot.bytes = Math.max(0, slot.bytes - ticket.bytes);
      dropIfIdle({ key: ticket.userId, slot });
    }
  }
}

function snapshot() {
  return {
    count: state.count, bytes: state.bytes, rejected: state.rejected,
    peakCount: state.peakCount, peakBytes: state.peakBytes,
    maxConcurrent: maxConcurrent(), maxBytes: maxInflightBytes(),
    // R94（M07-04）：单人上限也露出，便于运维判断"是不是某个人占满了"
    users: perUser.size, maxPerUserConcurrent: maxPerUserConcurrent(), maxPerUserBytes: maxPerUserBytes(),
  };
}

/** 仅供测试：清空在途状态与峰值统计 */
function reset() {
  state.count = 0; state.bytes = 0; state.rejected = 0;
  state.peakCount = 0; state.peakBytes = 0;
  perUser.clear();
}

/**
 * 造一个闸门中间件。
 *
 * ⚠️ 必须**放在 `express.raw(...)` 之前**，否则请求体已经读完，闸门只挡住了
 * 「处理」而没挡住「占内存」—— 那正是这个模块要解决的问题。
 *
 * 释放时机取 `res.on('close')`：它在「正常结束」与「客户端中途断开」两种情况下
 * 都会触发**恰好一次**，比在 handler 的 `finally` 里释放更可靠（handler 里
 * `await` 期间被 abort 时，`finally` 未必执行到；漏释放 = 名额永久泄漏，
 * 最终整站无法上传，且只能重启恢复）。
 */
function gate() {
  return function uploadGate(req, res, next) {
    /**
     * R94（审核 M07-01）：同一请求可能被挂**两处**闸门 —— 应用级（`server/index.js`，
     * 必须在应用级 `express.raw` 之前）与路由级（`routes/fs.js`，覆盖「不经过
     * index.js」的挂载形态）。两处都过一遍就会**多发一张券**，于是同一次上传占掉
     * 两个并发名额、两份在途字节。这里用请求上的标记做幂等：第二次进来直接放行。
     */
    if (req._uploadGatePassed) return next();
    req._uploadGatePassed = true;
    const declared = declaredBytes(req);
    const cost = declared == null ? requestMaxBytes() : declared;
    // R94（审核 M07-04）：带上主体，让「一个人占满全场」被单人上限挡住
    const subject = (req.authUser && req.authUser.id) || '';
    const r = tryAcquire(cost, subject);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(503).json({
        error: r.reason,
        code: 'UPLOAD_BUSY',
        retryAfter: r.retryAfter,
      });
    }
    res.on('close', () => release(r.ticket));
    next();
  };
}

module.exports = {
  DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_INFLIGHT_MB, DEFAULT_REQUEST_MAX_MB,
  DEFAULT_MAX_PER_USER, DEFAULT_PER_USER_INFLIGHT_MB, // R94：单人上限
  declaredBytes, tryAcquire, release, gate, snapshot, reset,
  maxConcurrent, maxInflightBytes, requestMaxBytes,
  maxPerUserConcurrent, maxPerUserBytes, // R94：单人上限的解析器（env 可覆盖）
};
