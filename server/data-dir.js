/**
 * 运行时数据目录 —— **唯一实现点**（R12-01 的形态演进 / R49 收口）
 *
 * ## 名字的两次来历
 * 这个开关最初叫 `COS_DATA_DIR`（本项目的原身是「腾讯云 COS 管理台」）。R49 移除
 * COS 原生 API、把腾讯云并入 S3 兼容协议之后，统一改名为 **`S3_DATA_DIR`**。
 *
 * ## 为什么旧名仍然可用（而且必须可用）
 * 它是**部署契约**：`deploy.sh` 把它写进 `.env` 交给运维，升级时那份 `.env` 里往往
 * 还写着旧名。静默忽略旧名的后果不是「少配一个开关」，而是**数据目录回退到项目
 * `data/`** —— 用户看到的是「配置、密钥、统计全没了」，而真实数据其实原封不动躺在
 * 原来的目录里。因此旧名命中时**照旧生效**，只打印一次弃用提醒。
 *
 * ## 为什么是「唯一实现点」而不是十条重复的三元表达式
 * 改名之前，这句话在 10 个 store 里各写了一遍：
 * `process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data')`。
 * 十条一模一样的判断，靠 `tests/invariants.test.js` 的检查 8「那一行里必须出现开关名」
 * 来守。本轮要新增「认两个名字」的分支 —— 写十遍正是最容易漏掉一处的那种改法
 * （漏掉的那个 store 会在测试进程里悄悄改写生产 `data/`），所以顺手收敛到这里。
 *
 * ⚠️ 这个名字**与厂商无关**：`data/` 装的是本项目的全部状态
 * （`config.enc` / `stats.json` / `share.json` / `ipguard.json` /
 * `payment-orders.json` / `upload-sessions.json` / `tls/` …），
 * 换成 S3 只跟随改名，语义没有变化。
 *
 * ⚠️ **取值是函数、不是模块级常量**：测试普遍「设 env + 清 require 缓存 + 重新
 * require」来拿一个隔离实例。若在这里固化成常量，清掉 store 的缓存也没用 ——
 * 本模块仍在缓存里，返回的还是旧目录。函数每次调用现读 env，与 10 个 store
 * 原本「自己读自己的 env」语义完全一致。
 */

const path = require('path');

/** 现用名 */
const PRIMARY_ENV = 'S3_DATA_DIR';
/** 历史名（部署契约，继续可用） */
const LEGACY_ENV = 'COS_DATA_DIR';

/** 项目自带的数据目录（未设任何开关时的落点） */
function defaultDataDir() {
  return path.join(__dirname, '..', 'data');
}

let legacyWarned = false;

/**
 * 解析运行时数据目录（绝对路径）。
 *
 * 优先级：`S3_DATA_DIR` → `COS_DATA_DIR`（弃用）→ 项目 `data/`。
 * 空串一律视为「未设置」—— `S3_DATA_DIR=` 这种写法在 `.env` 里很常见，
 * 当成有效值会让目录变成 `process.cwd()`。
 */
function dataDir() {
  const primary = String(process.env[PRIMARY_ENV] || '').trim();
  if (primary) return path.resolve(primary);

  const legacy = String(process.env[LEGACY_ENV] || '').trim();
  if (legacy) {
    if (!legacyWarned) {
      legacyWarned = true;
      console.warn(`[Storage Manager] 环境变量 ${LEGACY_ENV} 已更名为 ${PRIMARY_ENV}，`
        + `当前仍兼容旧名；请把它改成 ${PRIMARY_ENV}=…，旧名将在后续版本移除。`);
    }
    return path.resolve(legacy);
  }

  return defaultDataDir();
}

module.exports = { dataDir, defaultDataDir, PRIMARY_ENV, LEGACY_ENV };
