/**
 * 路由：协议设置（R68）
 *
 * 四条接口，权限分两级 —— 与 `routes/site.js` 同一套理由：
 *  - `GET /agreements/config`  —— 仅管理员。两份协议正文的源文本（Markdown），
 *    设置页的两个编辑框要回填它。
 *  - `PUT /agreements/config`  —— 仅管理员。**严格 PATCH**：只写给出的那一份。
 *  - `POST /agreements/preview` —— 仅管理员。把**尚未保存**的文本渲染成 HTML，
 *    给设置页的「预览」用。刻意用 POST：请求体是整份协议的草稿，塞进 URL 会
 *    被浏览器历史、反向代理的 access log 各记一份。
 *  - `GET /site/agreements`    —— **公开**（已登记进 `index.js` 的 `PUBLIC_API`）。
 *    登录页在拿到会话之前就要显示提示、点开协议；匿名访客根本没法带会话。
 *
 * ## 为什么「三页是否显示提示」不在这几条接口里
 *
 * 那是**站点设置**的一部分（需求明确：「用户可设置是否在注册页、登录页和分享页
 * 显示它们，以及显示的文案」这一项放在【站点设置】卡片里，协议设置只保存协议文案）。
 * 落盘位置也照此分：`cfg.site.notices` 归站点设置，`cfg.agreements` 归本模块。
 */
const { express, configStore, statsStore } = require('./_context');
const { requireAdmin, apiHandler } = require('./_shared');
// 正文长度上限的唯一判据（与 `config-store` 的落盘归一化同源）
const { parseAgreementBodyInput } = require('../limits');
// 渲染的两个唯一实现点：纯渲染器 + 配置驱动的页面视图
const agreementView = require('../agreement-view');
const { DOC_LABELS } = require('../agreement-text');

const router = express.Router();

/** 对外视图（唯一实现点）*/
function view() {
  return configStore.agreementsView(configStore.load());
}

// 查看两份协议正文（仅管理员）
router.get('/agreements/config', requireAdmin, apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, view()));
}));

/**
 * 保存协议正文（**PATCH 语义**：缺省的那一份保持原值；仅管理员）。
 *
 * 空串合法 —— 它的语义是「清空这一份协议」，此时所有指向它的链接退化成纯文字。
 * 长度上限的判据落在**路由层**（非法一律 400），`config-store` 只做兜底归一：
 * 「静默把超长文本截断」会让管理员以为保存成功了，而实际只存进去前半份。
 */
router.put('/agreements/config', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (b.terms !== undefined) {
    const r = parseAgreementBodyInput(b.terms, DOC_LABELS.terms);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.terms = r.value;
  }
  if (b.privacy !== undefined) {
    const r = parseAgreementBodyInput(b.privacy, DOC_LABELS.privacy);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
    patch.privacy = r.value;
  }
  if (b.terms === undefined && b.privacy === undefined) {
    throw Object.assign(new Error('请至少提交一份协议正文'), { status: 400 });
  }

  const saved = configStore.saveAgreements(patch);
  statsStore.addLog({
    action: 'config.save', level: 'info',
    detail: `管理员「${req.authUser.username}」更新协议设置`
      + `（${DOC_LABELS.terms}=${saved.terms.length} 字，`
      + `${DOC_LABELS.privacy}=${saved.privacy.length} 字）`,
  });
  res.json(Object.assign({ ok: true }, view()));
}));

/**
 * 预览渲染结果（仅管理员）。
 *
 * 入参 `{ terms?, privacy? }`，两者都可缺省（缺省 = 空）。返回与保存后完全同源的
 * HTML —— 设置页只是把它塞进对话框，不自己拼一份“差不多”的预览。
 */
router.post('/agreements/preview', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  const terms = parseAgreementBodyInput(b.terms, DOC_LABELS.terms);
  if (!terms.ok) throw Object.assign(new Error(terms.error), { status: 400 });
  const privacy = parseAgreementBodyInput(b.privacy, DOC_LABELS.privacy);
  if (!privacy.ok) throw Object.assign(new Error(privacy.error), { status: 400 });

  const docs = agreementView.docsOf(terms.value, privacy.value);
  res.json({ ok: true, docs });
}));

/**
 * 公开视图（**匿名可访问**）：三页提示 + 被引用到的协议正文。
 *
 * 返回值刻意极小：三页全关时 `docs` 是空对象，一条协议正文都不会跟着发出去。
 * 具体判断（开关 / 是否有正文 / 用哪句默认文案）全在 `agreement-view.publicPayload()`
 * 里，这里只负责搬运 —— 分享页调的是同一个函数的另一入口。
 */
router.get('/site/agreements', apiHandler(async (req, res) => {
  res.json(Object.assign({ ok: true }, agreementView.publicPayload()));
}));

module.exports = router;
