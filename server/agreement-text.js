/**
 * 协议文案的渲染（R68，**唯一实现点**）
 *
 * 两样东西共用这一个模块：
 *  1. 「提示文案」—— 管理员写的一句话，允许用 `<a>…</a>` 把其中的词包成链接；
 *  2. 「协议正文」—— 管理员写的多行文本，按一个**很小的 Markdown 子集**渲染。
 *
 * ## 为什么两样都先转义、再插入自己的标签
 *
 * 这两段文字都由管理员输入，而它们要在**匿名访客**的浏览器里显示（登录页、分享页）。
 * 常见的写法是「过滤掉危险标签」（黑名单），那样的安全性取决于名单是否想全了：
 * `<img onerror>`、`<svg onload>`、`<iframe srcdoc>`、`javascript:` …… 漏一个就是
 * 存储型 XSS。这里反过来做：**原文整段转义成纯文本**，然后只在确认为「我们自己
 * 写出来的那几种标签」的位置插入固定的标签串。这样输出的 HTML 里，任何一个标签
 * 都是本文件生成的，管理员输入里的 `<` 永远只能是 `&lt;`。
 *
 * 因此：
 *  - 提示文案里**只认** `<a>`（其余写法一律当文字显示，包括 `<b>`）；
 *  - 协议正文里**只认**下文列出的那几行 Markdown 语法（其余写法同样当文字）。
 *
 * ## 支持的 Markdown 子集（刻意很小）
 *
 *  `# ` ~ `###### `   标题
 *  `- ` / `* `        无序列表
 *  `1. `              有序列表
 *  `> `               引用
 *  `**粗体**`         行内
 *  `` `代码` ``       行内
 *  `[文字](链接)`     链接（只允许 http / https / mailto / 站内绝对路径）
 *  空行               分段；段内换行原样保留成 `<br>`
 *
 * 不支持的写法不会丢内容 —— 它们按普通文字原样显示。协议不需要表格与嵌入图片，
 * 而每多一条语法就多一处「我的转义是否还成立」的推演成本。
 */

/** 同一时刻最多缓存几份渲染结果（协议正文只有两份，两份都改过就是 4 份） */
const MD_CACHE_MAX = 4;
const mdCache = new Map(); // 源文本 → html（命中后直接返回，见 renderMarkdown）

/**
 * HTML 转义（本模块内部口径）。
 *
 * 单引号也转义：本模块的输出会被拼进 `class="..."` 之外的更多位置（未来可能进属性），
 * 而 `'` 不转义时，一个 `&#39;` 级别的差异就足以让某个属性值被提前闭合。
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 链接地址白名单。
 *
 * 判据作用在**已转义**的串上（调用方保证），因此这里不必再管引号 —— 但必须挡住
 * `javascript:` / `data:` 这类「看起来像路径」的协议：`[点我](javascript:alert(1))`
 * 在 Markdown 里是合法写法，如果只判「有没有括号」就会把它原样放进 `href`。
 */
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:|\/)[^\s]*$/i;

/** 行内语法：代码片段先摘出来，避免 `**` 与 ``` ` ``` 互相拆台 */
const CODE_RE = /`([^`\n]+)`/g;

/**
 * 行内渲染 —— **入参必须是已转义的文本**。
 *
 * 顺序：代码片段（摘成占位符）→ 链接 → 粗体 → 放回代码片段。
 * 摘占位符是为了让「代码里的 `**`」保持原样：否则先做粗体就会把代码块内容改掉。
 */
function inline(escaped) {
  const codes = [];
  let out = escaped.replace(CODE_RE, (m, body) => {
    codes.push(body);
    // 占位符用 \u0000 包裹：它不可能出现在转义后的正文里，也不会被下面两条正则匹配到
    return '\u0000' + (codes.length - 1) + '\u0000';
  });

  // 链接地址里**不许**出现空格与括号：`[x](javascript:alert(1))` 这种写法带一层嵌套括号，
  // 若允许括号就会匹配成 `javascript:alert(1`、被拒后留下一个孤零零的 `)`，
  // 结果是原文少了一半。不允许括号时它整段匹配不上，于是**原样显示**，一个字都不丢。
  out = out.replace(/\[([^\]\n]*)\]\(([^()\s]*)\)/g, (m, text, href) => {
    if (!SAFE_HREF_RE.test(href)) return text; // 不安全的链接：只留文字，不留 <a>
    return `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>`;
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const body = codes[Number(i)];
    return body === undefined ? '' : `<code>${body}</code>`;
  });
  return out;
}

/**
 * 渲染协议正文（Markdown 子集）。空文本返回空串。
 *
 * 逐行判定**块级**语法用的都是「原始文本的原始行首」—— 这一步发生在转义之前，
 * 但只用来**看前缀**，剩下的内容照常转义，所以不会引入任何未转义的片段。
 */
function renderMarkdown(src) {
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  const hit = mdCache.get(text);
  if (hit !== undefined) return hit;

  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const openList = (kind) => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); closeList(); continue; }

    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flushPara(); closeList();
      const lv = m[1].length;
      out.push(`<h${lv}>${inline(escapeHtml(m[2].trim()))}</h${lv}>`);
      continue;
    }

    m = /^[-*+]\s+(.*)$/.exec(line);
    if (m) {
      flushPara(); openList('ul');
      out.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
      continue;
    }

    m = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (m) {
      flushPara(); openList('ol');
      out.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
      continue;
    }

    m = /^>\s?(.*)$/.exec(line);
    if (m) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(escapeHtml(m[1]))}</blockquote>`);
      continue;
    }

    closeList();
    para.push(inline(escapeHtml(line)));
  }
  flushPara();
  closeList();

  const html = out.join('\n');
  // 简单的「后进先出」缓存：命中率最高的永远是最近改过的那两份
  if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
  mdCache.set(text, html);
  return html;
}

/** 两份协议在界面上的固定名称（对话框标题与提示里的说法共用） */
const DOC_LABELS = { terms: '用户协议', privacy: '隐私协议' };

/**
 * 三个页面在**没填文案**时的默认句。
 *
 * 为什么给默认：开关打开而文案留空时，界面上什么都不会发生 —— 管理员会以为功能坏了。
 * 默认句按页面各自的动作写（登录 / 注册 / 下载），而不是一句通用的「继续即代表同意」，
 * 因为那句话放在分享页上会让人以为「浏览」就等于同意。
 */
const DEFAULT_NOTICES = {
  login: '登录即代表您已阅读并同意<a>用户协议</a>和<a>隐私协议</a>',
  register: '继续注册则代表您已阅读并同意<a>用户协议</a>和<a>隐私协议</a>',
  share: '继续下载即代表您已阅读并同意<a>用户协议</a>和<a>隐私协议</a>',
};

/** 取某个页面实际要显示的文案（自定义优先，空则用该页默认句） */
function noticeText(page, custom) {
  const t = typeof custom === 'string' ? custom.trim() : '';
  if (t) return t;
  return DEFAULT_NOTICES[page] || '';
}

const ANCHOR_RE = /<a(?:\s+[^>]*)?>([\s\S]*?)<\/a>/gi;

/**
 * 判定一个 `<a>` 指向哪一份协议。
 *
 * 优先看显式的 `data-doc="terms|privacy"`；没有写时**按出现顺序**：第 1 个是用户协议、
 * 第 2 个是隐私协议。顺序规则是给「例：继续注册则代表您已阅读并同意<a>用户协议</a>和
 * <a>隐私政策</a>」这种最自然的写法用的 —— 管理员不必为了让它生效去记属性名。
 * 第 3 个及以后一律当用户协议（多出来的链接不静默丢弃，只是归类到第一份）。
 */
function docOf(openTag, index) {
  const m = /data-doc\s*=\s*["']?(terms|privacy)["']?/i.exec(openTag);
  if (m) return m[1].toLowerCase();
  return index === 2 ? 'privacy' : 'terms';
}

/**
 * 渲染提示文案。
 *
 * @param {string} text 管理员写的文案（可含 `<a>`）
 * @param {string} page 所属页面（`login` / `register` / `share`），用于生成对话框锚点
 * @param {object} available 两份协议**是否已有正文**：`{ terms: boolean, privacy: boolean }`
 * @returns {{ html: string, used: string[] }} `used` = 这段文案真正引用到的协议（顺序去重）
 */
function renderNotice(text, page, available) {
  const src = String(text == null ? '' : text);
  const has = available || {};
  const used = [];
  let out = '';
  let last = 0;
  let index = 0;
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    index += 1;
    const key = docOf(m[0], index);
    const inner = escapeHtml(m[1]);
    if (has[key]) {
      if (!used.includes(key)) used.push(key);
      out += `<a class="ag-link" href="#ag-${escapeHtml(page)}-${key}" data-doc="${key}">${inner}</a>`;
    } else {
      // 这一份还没填正文：**保留文字但不做成链接** —— 点开一个空对话框比不能点更糟
      out += inner;
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return { html: out, used };
}

/**
 * 仅供测试与调用方核对：一段文案里出现了哪些 `<a>`（按顺序），以及各自被归到哪一份协议。
 *
 * 存在的理由：上面那套「显式属性优先、否则按顺序」的规则很容易在改动中走样，
 * 而它的表现是「链接指向了错的协议」—— 在界面上看不出来。有了这个纯函数，
 * 护栏可以直接断言分类结果，不必去解析渲染出来的 HTML。
 */
function classifyLinks(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(src)) !== null) {
    out.push({ index: out.length + 1, doc: docOf(m[0], out.length + 1), label: m[1] });
  }
  return out;
}

module.exports = {
  escapeHtml,
  renderMarkdown,
  renderNotice,
  classifyLinks,
  noticeText,
  DEFAULT_NOTICES,
  DOC_LABELS,
};
