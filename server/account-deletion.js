/**
 * R98：账户注销（15 天冷静期）—— **政策常量与"真正删除"的唯一实现点**。
 * ============================================================================
 *
 * 分三件事，刻意分开：
 *  ① **申请**（路由层）—— 需要邮箱验证码，写入 `user.deletion = { requestedAt, deleteAt }`；
 *  ② **撤销**（登录路径 + 撤销接口）—— 只清字段，不需要任何验证（收紧方向）；
 *  ③ **到期执行**（本模块）—— 真正把账户从库里删掉，并做完全部连带清理。
 *
 * ## 为什么冷静期不是"队列"而是用户记录上的两个时刻
 *
 * 队列（内存 / 单独的待办文件）都会引入第四份需要备份、需要迁移的状态；而"删除"
 * 这件事的判据只有一条 —— 到点了吗。把它写在用户记录上，随 `config.enc` 一起加密
 * 落盘、一起备份，重启、换机、恢复备份都不会丢。代价是每次清扫要遍历用户表，
 * 而用户表本来就在内存里（`listUsers()` 天天遍历它）。
 *
 * ## 为什么"到期执行"必须是幂等 + 逐条容错的
 *
 * 清扫器每小时跑一次，且启动时也跑一次 —— 同一条记录可能被反复看到（删除失败时
 * 尤其如此）。因此：
 *  · 每条删除独立 try/catch，一条失败不影响其余（一个"最后一个管理员"不该让
 *    别人的注销永远排队）；
 *  · 删除失败时**保留申请**并记 error 日志，下一轮再试 —— 失败方向必须是"账户还在"，
 *    绝不能是"记录没了、账户还在"。
 *
 * ## 连带清理的三件事（缺一件都是提权或残留）
 *
 *  ① 分享链接归属（`shareStore.orphanByCreator`）—— 不解除的话，"删掉用户 + 建一个
 *     同名账号"就把前者留下的链接（含付费链接的收款人身份）转交出去了；
 *  ② 全部会话（`authSession.destroyUserSessions`）—— 不然被删者手里的 Cookie 还能
 *     继续读写对象存储；
 *  ③ WebDAV 账户由 `removeUser()` 内部连带删除（R89）。
 */
const configStore = require('./config-store');
const shareStore = require('./share-store');
const authSession = require('./auth-session');
const statsStore = require('./stats-store');

/** 冷静期天数。改这里即可调整全实例的政策，UI 与文案都从这里取。 */
const COOLING_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 从现在起算的到期时刻（ISO）。路由层把它交给 `requestAccountDeletion()`。 */
function deletionDueAt(from = Date.now()) {
  return new Date(from + COOLING_DAYS * DAY_MS).toISOString();
}

/**
 * 删除一个账户并完成全部连带清理。
 *
 * ⚠️ 调用方必须自己确认"该删"（到期 / 管理员操作），本函数**不做政策判断** ——
 * 它只负责把删除做干净。保护性判据（最后一个根用户 / 最后一个管理员）在
 * `removeUser()` 里，失败时会抛出 400，此处原样上抛。
 */
function purgeUser(id, reason) {
  const raw = configStore.findUserRawById(id);
  if (!raw) return null;
  const username = raw.username;
  configStore.removeUser(id);
  const links = shareStore.orphanByCreator(username);
  const sessions = authSession.destroyUserSessions(id);
  statsStore.addLog({
    action: 'users.delete',
    level: 'warn',
    detail: `账户「${username}」${reason || '已注销'}（${sessions} 个会话已失效，${links} 条分享链接已解除归属）`,
  });
  return { username, links, sessions };
}

/**
 * 清扫所有到期账户。返回**成功删除**的条数。
 *
 * `now` 可注入（测试用），默认当前时刻。逐条 try/catch 的理由见文件头；
 * 失败时保留申请 —— `removeUser()` 抛错发生在 `splice` 之前，记录没被动过。
 */
function purgeDue(now = new Date()) {
  let removed = 0;
  let due = [];
  try {
    due = configStore.dueDeletionUsers(now.toISOString());
  } catch (e) {
    statsStore.addLog({ action: 'users.delete', level: 'error', detail: `注销清扫无法读取用户表：${e.message}` });
    return 0;
  }
  for (const u of due) {
    try {
      purgeUser(u.id, '注销申请到期，已自动删除');
      removed += 1;
    } catch (e) {
      statsStore.addLog({
        action: 'users.delete',
        level: 'error',
        detail: `账户「${u.username}」到期注销失败（${e.message}），申请已保留，下一轮重试`,
      });
    }
  }
  return removed;
}

module.exports = { COOLING_DAYS, DAY_MS, deletionDueAt, purgeUser, purgeDue };
