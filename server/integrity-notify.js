'use strict';

/**
 * 完整性巡检的**异常通知**（R103）
 * ============================================================================
 *
 * ## 它解决什么
 *
 * 巡检（`integrity.js`）只在**有人打开系统设置页**时才被看见。而它要防的恰恰是
 * 「没人看的那段时间里云端被人动了」—— 结果写进内存、写进操作日志，然后就安静地
 * 躺在那儿，直到下一次有人恰好点开卡片。周期是 6 小时，但「发现」与「被告知」
 * 之间原本可以相隔几天。
 *
 * 所以：**发现真异常时往外发一封邮件**，收件地址由管理员在卡片里固定填一个。
 *
 * ## 什么算「异常」（谁有资格触发通知）
 *
 * 只有 `missing` / `size` / `modified` 三种 —— 也就是 `result.bad` 统计的那三种。
 * 刻意**不含**：
 *   - `unknown` / `error`（HEAD 403、5xx、网络不通）：那是「没查清」，不是「坏了」。
 *     把它们算进通知，等于让一次对象存储抖动换来一封「你的数据被篡改了」的惊吓信；
 *   - `ambiguous`（同名桶）与整轮跳过（锁定态 / 元数据损坏）：那是**本系统自己**
 *     的状态问题，运维看界面就能发现，且它的正确处置是「改桶名 / 去解锁」，
 *     不是「去云端抢救数据」。
 * 一句话：**通知的内容必须是「你该去看云端了」，不能是「本系统有点不对劲」。**
 *
 * ## 为什么需要冷却与签名（不能每轮都发）
 *
 * 一轮巡检 6 小时，一天 4 轮。如果一个坏对象一直没人处理，按「有异常就发」算，
 * 收件箱一天会收到 4 封一模一样的信 —— 一周之后这个地址就会被规则丢进垃圾箱，
 * 于是**真正新增的异常也被一起忽略**。这是告警系统最经典的死法。
 *
 * 因此判据是「**签名变了** 或 **距上次发送超过冷却期**」：
 *   - 签名 = 本轮所有异常对象的 `结论|桶|键` 排序后拼接。新增一个坏对象、
 *     或某个对象从 `missing` 变成 `size`，签名都会变 ⇒ **立刻发**；
 *   - 签名不变（还是那批老问题）⇒ 每 `COOLDOWN_MS`（默认 12 小时 = 两轮）
 *     **复述一次**，兼顾「别刷屏」与「别忘了它还坏着」。
 *
 * ## 失败怎么办
 *
 * **绝不影响巡检结论**：`maybeNotify()` 自己吞掉所有异常，永不 reject ——
 * 巡检的价值在于「查出来了」，邮件只是通知渠道。发信失败 →
 *   ① 记 `lastError` 与操作日志（界面能看到「上次通知失败：…」）；
 *   ② **不推进** `lastSignature` / `lastSentAt`，下一轮继续重试；
 *   ③ 失败本身有 `FAIL_COOLDOWN_MS`（默认 30 分钟）的退避，避免 SMTP 挂掉时
 *      每轮都去连一次（那会让巡检耗时被发信超时拖长）。
 *
 * ⚠️ 通知状态**只在内存里**（与巡检的游标 / 最近结果同款）。进程重启后签名丢失，
 * 于是重启后的第一轮若仍有异常，会**再发一封**。这是刻意接受的一侧偏差：
 * 漏报比重复报贵得多，且重启不是高频事件。
 *
 * ## 隐私边界
 *
 * 邮件正文里有**桶名与对象键**（也就是文件名）—— 这些是管理员本来就看得到的信息，
 * 但邮件会经 SMTP 服务器转发。未启用 TLS 的 SMTP（明文 25 端口）意味着这些文件名
 * 在链路上是明文。卡片里的提示与 `Develop_Document.md` 都写明了这一点；
 * 不想承担这个风险的管理员不开启即可（默认关闭）。
 */

const configStore = require('./config-store');
const smtp = require('./smtp');
const statsStore = require('./stats-store');

/** 同一批异常的重述间隔（12 小时 = 默认周期 6 小时的两轮） */
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** 发信失败后的退避间隔：SMTP 挂着时别每轮都去连 */
const FAIL_COOLDOWN_MS = 30 * 60 * 1000;
/** 正文里最多列多少条明细（更多就写「等」—— 邮件不是清单，清单在界面里） */
const MAX_LINES = 10;

/** 有资格触发通知的三种结论（与 `result.bad` 的口径**必须一致**） */
const BUMP_VERDICTS = ['missing', 'size', 'modified'];

/** 结论 → 中文（邮件用；界面那份在 `public/js/syssettings.js`） */
const VERDICT_CN = { missing: '已丢失', size: '长度不符', modified: '被改写' };

let lastSignature = '';
let lastSentAt = 0;
let lastFailAt = 0;
let lastError = '';
let lastReason = 'never'; // 上一次「为什么发 / 为什么没发」，供界面解释
let sending = false;

/**
 * 读设置 + SMTP 是否可用。
 *
 * 锁定态下 `configStore.load()` 会抛 `KEYRING_LOCKED` —— 这时**不猜**，
 * 一律当作「未配置」（巡检本身在锁定态也是整轮跳过，见 `integrity.js`）。
 */
function settings() {
  let n = { enabled: false, email: '' };
  let smtpConfigured = false;
  try {
    n = configStore.getIntegrityNotify();
    smtpConfigured = configStore.smtpConfigured(configStore.getSmtp());
  } catch (e) {
    // 锁定 / 配置读不出来：保持默认（关闭）。发信与否不是这一层该报的错。
  }
  return {
    enabled: Boolean(n && n.enabled),
    email: (n && n.email) || '',
    smtpConfigured,
    siteName: (() => {
      try {
        const s = configStore.getSite();
        return (s && s.siteName) || 'Kepler';
      } catch (e) { return 'Kepler'; }
    })(),
  };
}

/** 对外状态（`integrity.state()` 会把它并进去，界面直接渲染） */
function status() {
  const s = settings();
  return {
    enabled: s.enabled,
    email: s.email,
    smtpConfigured: s.smtpConfigured,
    lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : '',
    lastError: lastError,
    lastReason: lastReason,
  };
}

/** 本轮「真异常」的签名：排序后拼接，变化即代表异常集合变了 */
function signatureOf(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && BUMP_VERDICTS.indexOf(f.verdict) >= 0)
    .map((f) => `${f.verdict}|${f.bucket || ''}|${f.key || ''}`)
    .sort()
    .join('\n');
}

/** 正文里的一行明细（桶名 / 键可能含任意字符，这里只做单行化，不做转义） */
function lineOf(f, i) {
  const where = `${f.bucket || ''} / ${f.key || ''}`;
  const verdict = VERDICT_CN[f.verdict] || f.verdict || '异常';
  const detail = String(f.detail || '').replace(/[\r\n]+/g, ' ');
  return `${i + 1}. ${where}（${verdict}）${detail ? '：' + detail : ''}`;
}

/** 组装纯文本正文（不拼 HTML：本模块只发纯文本，见 `smtp.js` 的支持范围） */
function buildText(result, siteName) {
  const findings = (Array.isArray(result.findings) ? result.findings : [])
    .filter((f) => f && BUMP_VERDICTS.indexOf(f.verdict) >= 0);
  const shown = findings.slice(0, MAX_LINES);
  const more = findings.length > shown.length
    ? `（仅列前 ${MAX_LINES} 条，完整明细见「系统设置 → 完整性巡检」与操作日志）`
    : '';
  const when = result.at || new Date().toISOString();
  return [
    `${siteName} 的完整性巡检发现 ${result.bad} 个异常对象。`,
    '',
    `巡检时间：${when}`,
    `本轮扫描：${result.scanned} 个对象（正常 ${result.ok}，异常 ${result.bad}，跳过 ${result.skipped}）`,
    '',
    '异常明细：',
    ...shown.map(lineOf),
    ...(more ? [more] : []),
    '',
    '这条通知说明：云端那份密文与本地元数据对不上（被删除 / 长度变了 / 写完之后又被写过）。',
    '请尽快到对象存储控制台核对这几个对象，并确认是否有同步工具、生命周期规则或勒索软件在改动它们。',
    '巡检本身是只读的，它不会修改云端任何对象，也不会替你恢复。',
    '',
    `—— ${siteName} 自动发出的巡检通知，请勿直接回复。`,
    '',
  ].join('\n');
}

/**
 * 决定「这一轮要不要发」，要发就发一封。
 *
 * @param {object} result `integrity.runOnce()` 的本轮结果
 * @param {number} [now] 注入时间（测试用）
 * @returns {Promise<{sent:boolean, reason:string, error?:string}>} **永不 reject**
 */
async function maybeNotify(result, now = Date.now()) {
  try {
    if (!result || !(Number(result.bad) > 0)) return { sent: false, reason: 'no-bad' };
    const st = settings();
    if (!st.enabled) return { sent: false, reason: 'disabled' };
    if (!st.email) return { sent: false, reason: 'no-email' };
    if (!st.smtpConfigured) {
      /**
       * SMTP 没配：**不算错误**，只是"通知渠道还没接上"。
       * 记一次 reason 让界面能说清楚，但绝不逐轮写 warn 日志（那会把操作日志刷满）。
       */
      lastReason = 'smtp-not-configured';
      return { sent: false, reason: 'smtp-not-configured' };
    }
    if (sending) return { sent: false, reason: 'busy' };

    const sig = signatureOf(result.findings);
    const sameBatch = sig !== '' && sig === lastSignature;
    if (sameBatch && lastSentAt && (now - lastSentAt) < COOLDOWN_MS) {
      lastReason = 'cooldown';
      return { sent: false, reason: 'cooldown' };
    }
    if (lastFailAt && (now - lastFailAt) < FAIL_COOLDOWN_MS) {
      lastReason = 'fail-backoff';
      return { sent: false, reason: 'fail-backoff' };
    }

    sending = true;
    try {
      const cfg = configStore.smtpSendConfig();
      await smtp.sendMail({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        user: cfg.user, password: cfg.password,
        from: cfg.from,
        fromName: cfg.fromName || st.siteName,
        to: st.email,
        subject: `[${st.siteName}] 完整性巡检发现 ${result.bad} 个异常对象`,
        text: buildText(result, st.siteName),
      });
      lastSignature = sig;
      lastSentAt = now;
      lastFailAt = 0;
      lastError = '';
      lastReason = sameBatch ? 'cooldown-elapsed' : 'sent';
      statsStore.addLog({
        action: 'integrity.notify', level: 'warn',
        detail: `完整性巡检异常通知已发送至 ${st.email}（本轮 ${result.bad} 个异常对象）`,
      });
      return { sent: true, reason: lastReason };
    } catch (e) {
      lastFailAt = now;
      lastError = (e && (e.message || e.code)) || '未知错误';
      lastReason = 'error';
      statsStore.addLog({
        action: 'integrity.notify', level: 'warn',
        detail: `完整性巡检异常通知发送失败：${lastError}`,
      });
      return { sent: false, reason: 'error', error: lastError };
    } finally {
      sending = false;
    }
  } catch (e) {
    // 兜底：连 settings() / addLog 都炸了也不能影响巡检
    lastReason = 'error';
    lastError = (e && (e.message || e.code)) || '未知错误';
    return { sent: false, reason: 'error', error: lastError };
  }
}

/** 仅供测试：清掉内存态（签名 / 冷却 / 错误） */
function _resetForTest() {
  lastSignature = '';
  lastSentAt = 0;
  lastFailAt = 0;
  lastError = '';
  lastReason = 'never';
  sending = false;
}

module.exports = {
  COOLDOWN_MS, FAIL_COOLDOWN_MS, MAX_LINES, BUMP_VERDICTS,
  settings, status, signatureOf, buildText, maybeNotify, _resetForTest,
};
