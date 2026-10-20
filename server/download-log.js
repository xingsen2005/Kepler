/**
 * 免费下载记录 —— data/downloads.json（加密 JSON，与其它 store 同源）
 *
 * ## 为什么需要它（R64 需求 2②）
 *
 * 「查看历史订单」要把**已登录用户**下过的文件都列出来，而其中的免费下载
 * 在这之前**没有任何落点**：只有付费下载才有订单（`payments.json`），免费下载
 * 连一条流水都不留（`stats-store` 里只有聚合后的按天计数与操作日志，且日志
 * 不记用户身份）。于是「我上周从这个站下的那个文件叫什么」这个问题无从回答。
 *
 * ## 只记第一次
 *
 * 需求原文：「也显示免费下载的文件，但只展示第一次下载的记录，重复下载不计」。
 * 判定键是 **(userId, linkId, fileKey)** 三元组 —— 同一份分享里**不同文件**
 * 各算一条（那确实是"下载过的不同文件"），而同一个文件重复下载只留首次的
 * 时间。这条判据只在 `record()` 一处实现，下载端点不重复判断。
 *
 * ## 为什么单独一个文件，而不是塞进 payments.json
 *
 * 订单表是**钱的凭据**：管理端「收入统计」「对账」「删除失效订单」都整表遍历它。
 * 把免费下载混进去，那些统计要么把免费下载算成订单（凭空多出收入），要么
 * 到处加 `status !== 'free'` 的排除条件 —— 后者迟早漏一处。两张表各自回答
 * 各自的问题，边界清楚。
 *
 * ## 容量
 *
 * 单条记录 ≈ 120 字节，2000 条 ≈ 240KB，落盘是全量序列化（与订单同一套
 * `coalesce` 去抖 + 原子写）。上限 `MAX_RECORDS` 溢出的部分按**最旧优先**丢弃：
 * 免费下载记录是便利功能，不是对账凭据，丢了不影响任何钱的账。
 */
const fs = require('fs');
const path = require('path');
const secureStore = require('./secure-store');
const coalesce = require('./coalesce');

const DATA_DIR = require('./data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'downloads.json');

/** 全表上限（超出按 `at` 从旧到新丢弃） */
const MAX_RECORDS = (() => {
  const raw = process.env.DOWNLOAD_LOG_MAX;
  if (raw === undefined || raw === '') return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2000;
})();

/** 落盘去抖窗口：一次打包下载可能一次写几十上百条，合并成一次序列化 */
const WRITE_DEBOUNCE_MS = 300;

let cache = null;
/** 读取失败标志：任何一次 load 失败就永久拒绝写入（防把坏文件覆盖成空表，同 payment-orders） */
let loadFailed = false;

function load() {
  if (cache) return cache;
  if (loadFailed) return { records: [] };
  try {
    if (!fs.existsSync(FILE)) { cache = { records: [] }; return cache; }
    const raw = secureStore.readJson(FILE, null);
    if (raw && Array.isArray(raw.records)) {
      cache = { records: raw.records.filter(isRecord) };
      return cache;
    }
    throw new Error('内容结构不是预期的 { records: [] }');
  } catch (e) {
    loadFailed = true;
    console.error('[download-log] 读取下载记录失败，已锁定写入：', (e && e.stack) || e);
  }
  cache = { records: [] };
  return cache;
}

/** 一条记录必须能回答「谁 / 哪条分享 / 哪个文件 / 什么时候」 */
function isRecord(r) {
  return Boolean(r && typeof r === 'object'
    && typeof r.userId === 'string' && r.userId
    && typeof r.linkId === 'string' && r.linkId
    && typeof r.fileKey === 'string' && r.fileKey
    && typeof r.at === 'string' && r.at);
}

const writer = coalesce.debouncedPersist(
  FILE,
  () => (loadFailed || !cache ? null : cache),
  { debounceMs: WRITE_DEBOUNCE_MS, dataDir: DATA_DIR },
);

function persist() {
  if (loadFailed) return;
  writer.schedule();
}

function flush() { writer.flush(); }

/**
 * 记录一次（或一批）免费下载 —— **只保留首次**。
 *
 * @param {{userId: string, linkId: string, files: Array<{key: string, name?: string}>, at?: string}} p
 * @returns {number} 本次真正新增的条数（去重后）
 */
function record(p) {
  const o = p && typeof p === 'object' ? p : {};
  const userId = String(o.userId || '');
  const linkId = String(o.linkId || '');
  if (!userId || !linkId) return 0; // 游客没有稳定身份，不记录（记了也无从归集）
  const at = String(o.at || new Date().toISOString());
  const list = Array.isArray(o.files) ? o.files : [];
  const all = load().records;
  const seen = new Set(all.map((r) => r.userId + '\u0000' + r.linkId + '\u0000' + r.fileKey));
  let added = 0;
  for (const f of list) {
    const key = String((f && f.key) || '');
    if (!key) continue;
    const dedupe = userId + '\u0000' + linkId + '\u0000' + key;
    if (seen.has(dedupe)) continue; // 重复下载不计（需求 2②）
    seen.add(dedupe);
    all.push({
      userId,
      linkId,
      fileKey: key,
      fileName: String((f && f.name) || key.split('/').pop() || key),
      at,
    });
    added += 1;
  }
  if (!added) return 0;
  // 溢出按最旧优先丢弃：`at` 是 ISO 串，字典序即时间序
  if (all.length > MAX_RECORDS) {
    all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    all.splice(0, all.length - MAX_RECORDS);
  }
  persist();
  return added;
}

/** 某账号的全部下载记录（按时间倒序；不区分免费/付费 —— 付费的在订单里） */
function listForUser(userId) {
  const uid = String(userId || '');
  if (!uid) return [];
  return load().records
    .filter((r) => r.userId === uid)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 全部记录（管理端排障用） */
function listAll() {
  return load().records.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

module.exports = {
  MAX_RECORDS, WRITE_DEBOUNCE_MS,
  record, listForUser, listAll, flush,
};
