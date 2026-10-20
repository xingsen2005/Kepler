/**
 * 「协议提示」的页面级视图（R68，**唯一实现点**）
 *
 * 三处消费方：
 *  - 登录 / 注册页（`public/js/main.js`）→ 走公开接口 `GET /api/site/agreements`；
 *  - 分享页（`server/share-routes.js`，服务端渲染）→ 直接调 `noticeForPage('share')`；
 *  - 设置页的「预览」按钮 → 走仅管理员接口 `POST /api/agreements/preview`。
 *
 * 三者共享同一段判断（开没开 / 有没有正文 / 用哪句文案 / 哪几个链接），
 * 而不是各写一遍 —— 否则「设置页预览有链接、分享页却点不动」这类分叉
 * 在界面上完全看不出来，只能靠人肉比对两个页面的截图。
 *
 * ## 一条容易搞错的规则：两份协议都空 ⇒ 这一页不显示任何东西
 *
 * 开关打开、文案也填了，但两份协议正文都还是空的，此时**整条提示不显示**。
 * 理由：提示里必然至少有一个 `<a>`，而没有任何正文的链接点开是空对话框，
 * 那比不显示更让人困惑（访客会以为系统坏了）。同理，只填了一份时，另一份的
 * 链接会退化成纯文字（见 `agreement-text.js` 的 `renderNotice`）。
 */
const configStore = require('./config-store');
const { NOTICE_PAGES } = require('./limits');
const {
  renderMarkdown, renderNotice, noticeText, DOC_LABELS,
} = require('./agreement-text');

/**
 * 两份协议的渲染结果。
 *
 * `title` 是对话框标题（固定叫法），`html` 是渲染好的正文（空串 = 未填写）。
 * 渲染本身带缓存（`agreement-text.js` 里按源文本记忆），所以这里每次重建对象
 * 并不会每次都真的跑一遍 Markdown。
 */
function docsOf(terms, privacy) {
  return {
    terms: { title: DOC_LABELS.terms, html: renderMarkdown(terms) },
    privacy: { title: DOC_LABELS.privacy, html: renderMarkdown(privacy) },
  };
}

/** 「哪几份有正文」—— 决定哪些 `<a>` 能变成链接 */
function availableOf(docs) {
  return { terms: !!docs.terms.html, privacy: !!docs.privacy.html };
}

/**
 * 单页视图：这一页要不要显示提示、显示什么。
 *
 * @param {string} page `login` / `register` / `share`
 * @returns {null | { html: string, docs: object }} `docs` 只含这段文案**真正引用到**的协议
 */
function noticeForPage(page) {
  const site = configStore.getSite();
  const n = (site.notices && site.notices[page]) || null;
  if (!n || n.enabled !== true) return null;

  const ag = configStore.getAgreements();
  const docs = docsOf(ag.terms, ag.privacy);
  const available = availableOf(docs);
  if (!available.terms && !available.privacy) return null; // 两份都空 ⇒ 无可展示

  const r = renderNotice(noticeText(page, n.text), page, available);
  const used = {};
  for (const key of r.used) used[key] = docs[key];
  return { html: r.html, docs: used };
}

/**
 * 公开接口的载荷（`GET /api/site/agreements`）。
 *
 * 只下发**确实会用到的**协议正文：三页全关时 `docs` 是空对象；某一页只引用了
 * 用户协议时，隐私协议的正文不会跟着发出去。匿名接口上「能少给就少给」与
 * `/site/info` 是同一条纪律（那里连注册模式都只多给了一个字段）。
 *
 * `show[page]` 是**实际会不会显示**（开关 + 有正文两件事都成立），不是开关本身 ——
 * 前端拿它决定提示元素的显隐，不需要自己再算一遍那两个条件。
 */
function publicPayload() {
  const site = configStore.getSite();
  const ag = configStore.getAgreements();
  const docs = docsOf(ag.terms, ag.privacy);
  const available = availableOf(docs);
  const anyAvailable = available.terms || available.privacy;

  const show = {};
  const notices = {};
  const used = {};
  for (const page of NOTICE_PAGES) {
    const n = (site.notices && site.notices[page]) || {};
    const on = n.enabled === true && anyAvailable;
    show[page] = on;
    if (!on) { notices[page] = ''; continue; }
    const r = renderNotice(noticeText(page, n.text), page, available);
    notices[page] = r.html;
    for (const key of r.used) used[key] = docs[key];
  }
  return { show, notices, docs: used };
}

module.exports = { noticeForPage, publicPayload, docsOf, availableOf };
