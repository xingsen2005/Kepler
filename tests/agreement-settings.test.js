/**
 * 第六十八轮 · 协议设置（R68）
 *
 * ## 需求原文（拆成四条可断言的事实）
 *
 *  ① 设置页在「发信设置」与「线程并发」之间新增「协议设置」卡片，**只保存两份协议文案**
 *     （用户协议 / 隐私协议），两个编辑框固定高度、带竖滚动；
 *  ② 「是否在注册页 / 登录页 / 分享页显示、以及显示的文案」这一项在【站点设置】卡片里；
 *  ③ 文案里允许用 `<a>…</a>` 把词包成链接；
 *  ④ 访客点链接 → 弹出对话框展示协议正文，有关闭按钮。
 *
 * ## 本文件守的是「行为」，不是「界面上有这一段 HTML」
 *
 * 最难自查的三类错法，恰好都不会让界面报错：
 *  - **渲染层的 XSS**：管理员写 `<script>` 或 `[x](javascript:…)`，页面照常「看起来对」；
 *  - **归一化漏页**：历史配置里 site 段缺 `notices`，设置页读 `undefined.enabled` 崩掉；
 *  - **空正文的链接**：正文还没填，链接却是可点的 —— 点开一个空对话框比不能点更糟。
 *
 * ⚠️ 数据目录必须在 require 之前指向临时目录（`share-store` / `config-store` 都在
 * 加载时解析路径），否则用例会把假协议写进项目真实的 `data/config.enc`。
 */
const path = require('path');
const { test } = require('node:test');
const {
  assert, assertEqual, assertMatch, makeTempDir, request,
} = require('./helpers.js');

const tmp = makeTempDir('s3-agreement-');
process.env.S3_DATA_DIR = tmp.dir;

const http = require('http');
const fs = require('fs');
const express = require(path.join(__dirname, '..', 'node_modules', 'express'));

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const agreementText = require(path.join(ROOT, 'server', 'agreement-text.js'));
const agreementView = require(path.join(ROOT, 'server', 'agreement-view.js'));
const backup = require(path.join(ROOT, 'server', 'backup.js'));

// 分享页要真起一次；云端一律用「对象存在」的假客户端（本文件不测下载）
const s3 = require(path.join(ROOT, 'server', 's3.js'));
s3.getClient = () => ({
  headObject(_p, cb) { cb(null, { headers: { 'content-length': '12' } }); },
  getObject(_p, cb) { cb(null, { headers: { 'content-length': '12' } }); },
});
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => ({ bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent' });

/** 起一个只挂指定路由的本地服务 */
async function serve(mount, router, middleware) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (middleware) app.use(middleware);
  app.use(mount, router);
  // 统一错误落地点（与 index.js 同形：结构化 status 透传）
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 起一个挂「站点设置 + 协议设置」两条路由的服务，并按角色注入 req.authUser */
async function serveSettings(role) {
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'site.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'agreements.js'))];
  const site = require(path.join(ROOT, 'server', 'routes', 'site.js'));
  const agreements = require(path.join(ROOT, 'server', 'routes', 'agreements.js'));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    // 公开接口在真实服务里由 index.js 的 PUBLIC_API 放行；这里用 role = null 模拟匿名
    req.authUser = role || null;
    next();
  });
  app.use(site);
  app.use(agreements);
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

const ADMIN = { id: 'u-admin', username: 'admin', role: 'admin' };
const USER = { id: 'u-plain', username: 'plain', role: 'user' };

const TERMS = '# 用户协议\n\n第一段**重点**。\n\n- 条目一\n- 条目二';
const PRIVACY = '## 隐私协议\n\n我们只收集必要信息。';

/* ==================================================================== *
 * ① 存储与归一化
 * ==================================================================== */

test('R68-01 · 全新实例：两份协议为空、三页提示全关，且算「默认状态」', () => {
  const ag = configStore.getAgreements();
  assertEqual(ag.terms, '', '历史配置没有这一段 ⇒ 用户协议为空串');
  assertEqual(ag.privacy, '', '历史配置没有这一段 ⇒ 隐私协议为空串');

  const site = configStore.getSite();
  assertEqual(Object.keys(site.notices).sort().join(','), 'login,register,share',
    '三页提示必须逐页补齐（缺页会让设置页读 undefined.enabled 直接崩）');
  for (const page of ['login', 'register', 'share']) {
    assertEqual(site.notices[page].enabled, false,
      `全新实例上 ${page} 的提示必须是关的 —— 它是「显示给访客看的内容」，默认不摆出来`);
    assertEqual(site.notices[page].text, '');
  }

  assertEqual(configStore.agreementsIsDefault(undefined), true, '没有这一段 = 默认状态');
  assertEqual(configStore.siteIsDefault(undefined), true, '站点设置同理');
});

test('R68-02 · 归一化不信任入参：字符串 "false" 不算开，多余的页名被丢弃', () => {
  const half = configStore.siteView({
    site: {
      notices: {
        login: { enabled: 'false', text: '  带空白的文案  ' }, // 字符串 "false" 用 !! 判会变 true
        register: 'not-an-object', // 完全非法
        share: { enabled: 1, text: 42 }, // 1 与 42 都不是合法类型
        home: { enabled: true, text: '不存在的页' }, // 不认识的页名
      },
    },
  });
  assertEqual(half.notices.login.enabled, false,
    'enabled 必须字面量 true 才算开 —— `!!"false"` 为真会把一个关掉的开关打开');
  assertEqual(half.notices.login.text, '带空白的文案', '文案两端空白应被裁掉（单行输入框的语义）');
  assertEqual(half.notices.register.enabled, false, '非对象的页配置按「关」处理');
  assertEqual(half.notices.share.enabled, false, '数字 1 不是布尔，不算开');
  assertEqual(half.notices.share.text, '', '数字 42 不是字符串，按空文案处理');
  assertEqual(half.notices.home, undefined,
    '不认识的页名必须被丢弃 —— 留着会让「保存」把一份早已废弃的配置一直写回去，界面上还看不到');
});

test('R68-03 · saveSite 是逐页合并：只翻一个开关不清空任何文案', () => {
  configStore.saveSite({
    notices: {
      login: { enabled: true, text: '登录页文案' },
      register: { enabled: false, text: '注册页文案' },
      share: { enabled: false, text: '分享页文案' },
    },
  });
  // 只提交 login.enabled（界面上「翻一下开关」就是这个载荷）
  configStore.saveSite({ notices: { login: { enabled: false } } });
  const s = configStore.getSite();
  assertEqual(s.notices.login.enabled, false, '开关应被改掉');
  assertEqual(s.notices.login.text, '登录页文案',
    '只翻开关不能清空文案 —— 整体替换会让界面上刚编辑的半句话凭空消失');
  assertEqual(s.notices.register.text, '注册页文案', '未提交的页必须原样保留');
  assertEqual(s.notices.share.text, '分享页文案', '未提交的页必须原样保留');
});

test('R68-04 · saveAgreements 是严格 PATCH：只写一份不动另一份', () => {
  configStore.saveAgreements({ terms: TERMS, privacy: PRIVACY });
  configStore.saveAgreements({ terms: '只改用户协议' });
  const ag = configStore.getAgreements();
  assertEqual(ag.terms, '只改用户协议', '用户协议应被更新');
  assertEqual(ag.privacy, PRIVACY,
    '隐私协议必须原样保留 —— 顶层键替换 + 不归一会让它变成 undefined，而界面上看不出异常');
});

/* ==================================================================== *
 * ② 渲染器（纯函数层：XSS 与 Markdown 子集）
 * ==================================================================== */

test('R68-05 · 协议正文：先整体转义，再把 Markdown 子集变成标签', () => {
  const html = agreementText.renderMarkdown([
    '# 标题',
    '',
    '正文 **粗体** 与 `code`',
    '',
    '- 一',
    '- 二',
    '',
    '1. 甲',
    '2. 乙',
    '',
    '> 引用',
  ].join('\n'));
  assertMatch(html, /<h1>标题<\/h1>/, '`# ` 应渲染成一级标题');
  assertMatch(html, /<strong>粗体<\/strong>/, '`**x**` 应渲染成 strong');
  assertMatch(html, /<code>code<\/code>/, '`` `x` `` 应渲染成 code');
  assertMatch(html, /<ul>[\s\S]*<li>一<\/li>[\s\S]*<\/ul>/, '`- ` 应渲染成无序列表');
  assertMatch(html, /<ol>[\s\S]*<li>甲<\/li>[\s\S]*<\/ol>/, '`1. ` 应渲染成有序列表');
  assertMatch(html, /<blockquote>引用<\/blockquote>/, '`> ` 应渲染成引用');
});

test('R68-06 · 协议正文：任何原始标签都只能以转义形式出现（存储型 XSS 的唯一判据）', () => {
  const evil = '正常文字<script>alert(1)</script><img src=x onerror=alert(2)><svg onload=alert(3)>';
  const html = agreementText.renderMarkdown(evil);
  assertEqual(html.indexOf('<script'), -1, '不得出现真实 <script 标签');
  assertEqual(html.indexOf('<img'), -1, '不得出现真实 <img 标签（onerror 的常见载体）');
  assertEqual(html.indexOf('<svg'), -1, '不得出现真实 <svg 标签');
  assertMatch(html, /&lt;script&gt;/, '原文里的标签必须被转义成实体，而不是被删掉（否则内容会静默丢失）');
  // 反向确认：转义之后这些字仍然读得出来
  assertMatch(html, /&lt;img src=x onerror=alert\(2\)&gt;/, '整段原文都要保留，只是以实体形式');
});

test('R68-07 · 协议正文：javascript: / data: 链接被拒，且原文一个字都不丢', () => {
  const html = agreementText.renderMarkdown('[点我](javascript:alert(1))');
  assertEqual(/href="javascript/i.test(html), false, 'javascript: 协议必须被拒绝');
  assertEqual(/<a\s/i.test(html), false, '被拒的链接不得留下半截 <a>');
  assertMatch(html, /\[点我\]\(javascript:alert\(1\)\)/,
    '整段应原样显示 —— 只拒「做成链接」，不能把管理员写的字也一起吞掉');

  const ok = agreementText.renderMarkdown('[官网](https://example.com/a?b=1&c=2)');
  assertMatch(ok, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/,
    'https 链接应保留，`&` 必须转义成 &amp;（否则属性会被截断）');

  /**
   * ⚠️ 上面那条带括号的写法**根本没有走到白名单**：链接正则 `([^()\s]*)` 不允许括号，
   * 于是 `[x](javascript:alert(1))` 整段匹配不上、被当作普通文字原样输出 ——
   * 它守的是「不吞字」，不是「拒链」。
   *
   * 实测代价：把 `SAFE_HREF_RE` 放宽成 `/^[^\s]*$/`（任何协议都放行）之后，
   * R68-07 依然全绿、整份 `agreement-settings` 的 `fail=0` —— **白名单这条防线
   * 当时没有任何用例真的踩到**。故这里补上**不带括号**的两种危险协议：
   * 它们能匹配链接正则，是唯一能把白名单判据逼出来的写法。
   */
  const bareJs = agreementText.renderMarkdown('[点我](javascript:alert)');
  assertEqual(/href=|<a\s/i.test(bareJs), false,
    '不带括号的 javascript: 链接也必须被白名单拒绝（括号正则挡不住它）');
  assertMatch(bareJs, /^<p>点我<\/p>$/, '被拒时只留文字，不留 <a>、不留裸露的地址');

  const dataUri = agreementText.renderMarkdown('[点我](data:text/html,hi)');
  assertEqual(/href=|<a\s/i.test(dataUri), false, 'data: 协议同样必须被拒绝');
  // 正向对照：白名单里的三种写法都得真的变成链接（否则上两条会被「什么都不生成」蒙混过关）
  assertMatch(agreementText.renderMarkdown('[站内](/privacy)'), /<a href="\/privacy"/, '站内绝对路径应放行');
  assertMatch(agreementText.renderMarkdown('[信](mailto:a@b.c)'), /<a href="mailto:a@b\.c"/, 'mailto 应放行');
});

test('R68-08 · 提示文案：`<a>` 被改写，其余标签一律当文字', () => {
  const r = agreementText.renderNotice(
    '继续注册则代表您已阅读并同意<a>用户协议</a>和<a>隐私政策</a><b>粗体不算</b>',
    'register',
    { terms: true, privacy: true },
  );
  assertMatch(r.html, /<a class="ag-link" href="#ag-register-terms" data-doc="terms">用户协议<\/a>/,
    '第 1 个 <a> 指向用户协议，且带该页的锚点（分享页靠它做 :target）');
  assertMatch(r.html, /<a class="ag-link" href="#ag-register-privacy" data-doc="privacy">隐私政策<\/a>/,
    '第 2 个 <a> 指向隐私协议');
  assertMatch(r.html, /&lt;b&gt;粗体不算&lt;\/b&gt;/, '`<b>` 不在白名单里，必须当文字显示');
  assertEqual(r.used.join(','), 'terms,privacy', 'used 应报告这段文案真正引用到的协议');
});

test('R68-09 · 提示文案：data-doc 显式指定优先于「按出现顺序」', () => {
  const r = agreementText.renderNotice(
    '<a data-doc="privacy">隐私在前</a>与<a data-doc="privacy">又一个隐私</a>',
    'login',
    { terms: true, privacy: true },
  );
  assertEqual(r.used.join(','), 'privacy',
    '两个链接都显式指向 privacy 时，used 里只能有 privacy —— 否则会把用户协议也一起下发');
  assertMatch(r.html, /data-doc="privacy">隐私在前<\/a>/, '显式属性必须生效');
});

test('R68-10 · 提示文案：正文为空的那一份不做成链接（否则点开是空对话框）', () => {
  const r = agreementText.renderNotice(
    '同意<a>用户协议</a>和<a>隐私协议</a>', 'share', { terms: true, privacy: false },
  );
  assertMatch(r.html, /ag-link[^>]*data-doc="terms"/, '有正文的那一份仍然是链接');
  assert(!/data-doc="privacy"/.test(r.html), '没有正文的那一份不得生成链接');
  assertMatch(r.html, /和隐私协议$/, '但文字必须保留（不能整段消失）');
  assertEqual(r.used.join(','), 'terms', 'used 不应包含没有正文的协议');
});

test('R68-11 · 默认文案按页面各写一句，且都能被自定义文案替换', () => {
  assert(agreementText.DEFAULT_NOTICES.login.indexOf('登录') >= 0, '登录页默认句应说「登录」');
  assert(agreementText.DEFAULT_NOTICES.register.indexOf('注册') >= 0, '注册页默认句应说「注册」');
  assert(agreementText.DEFAULT_NOTICES.share.indexOf('下载') >= 0, '分享页默认句应说「下载」');
  assertEqual(agreementText.noticeText('login', '自定义'), '自定义', '自定义文案优先');
  assertEqual(agreementText.noticeText('login', '   '), agreementText.DEFAULT_NOTICES.login,
    '空白文案视同未填 —— 否则「留空」会显示成一句空气');
});

/* ==================================================================== *
 * ③ 页面级视图（开关 + 正文 + 文案三者合起来才决定「显示什么」）
 * ==================================================================== */

test('R68-12 · 两份正文都空时整条提示不显示（哪怕开关是开的）', () => {
  configStore.saveAgreements({ terms: '', privacy: '' });
  configStore.saveSite({
    notices: {
      login: { enabled: true, text: '' },
      register: { enabled: true, text: '' },
      share: { enabled: true, text: '' },
    },
  });
  assertEqual(agreementView.noticeForPage('login'), null,
    '没有正文就没有链接可点，整条提示不显示 —— 摆一句「同意…」却点不开任何东西是误导');
  const p = agreementView.publicPayload();
  assertEqual(JSON.stringify(p.show), JSON.stringify({ login: false, register: false, share: false }),
    'show 必须是「实际会不会显示」，不能直接回开关本身');
  assertEqual(Object.keys(p.docs).length, 0, '三页全关时一份协议正文都不该下发（匿名接口能少给就少给）');
});

test('R68-13 · 只开一页时，只有那一页显示，且只下发被引用到的正文', () => {
  configStore.saveAgreements({ terms: TERMS, privacy: '' });
  configStore.saveSite({
    notices: {
      login: { enabled: true, text: '' },
      register: { enabled: false, text: '' },
      share: { enabled: false, text: '' },
    },
  });
  const p = agreementView.publicPayload();
  assertEqual(p.show.login, true, '登录页开关打开且有正文 ⇒ 显示');
  assertEqual(p.show.register, false, '注册页未开 ⇒ 不显示');
  assertEqual(p.show.share, false, '分享页未开 ⇒ 不显示');
  assertMatch(p.notices.login, /ag-link/, '登录页提示里应有可点链接');
  assertEqual(p.notices.register, '', '未开的页不下发提示 HTML');
  assertEqual(Object.keys(p.docs).join(','), 'terms', '只有隐私协议为空 ⇒ 不下发空的隐私协议');
});

/* ==================================================================== *
 * ④ HTTP 层：权限、往返、入参校验
 * ==================================================================== */

test('R68-14 · 协议正文往返，且超长 / 缺字段按 400 拒绝（不静默截断）', async () => {
  const s = await serveSettings(ADMIN);
  try {
    let r = await request(s.port, 'PUT', '/agreements/config', { body: { terms: TERMS } });
    assertEqual(r.status, 200, `管理员保存应 200，实际 ${r.status}`);
    assertEqual(r.json.terms, TERMS, '返回体应回填刚保存的正文');
    assertEqual(r.json.privacy, '', '未提交的另一份保持原值（空）');

    r = await request(s.port, 'GET', '/agreements/config');
    assertEqual(r.status, 200);
    assertEqual(r.json.terms, TERMS, '读回来必须与写进去的逐字一致（含换行）');

    // 20000 字符上限：多一个就 400，且**不能**静默截断
    r = await request(s.port, 'PUT', '/agreements/config', { body: { terms: 'x'.repeat(20001) } });
    assertEqual(r.status, 400, '超长正文必须 400');
    assertMatch(r.json.error, /20000/, '错误消息里要写清上限（管理员才知道该删多少）');
    assertEqual(configStore.getAgreements().terms, TERMS, '被拒的请求不得改动已保存的内容');

    r = await request(s.port, 'PUT', '/agreements/config', { body: {} });
    assertEqual(r.status, 400, '一份都没提交时 400，而不是把两份都清空');
  } finally {
    await s.close();
  }
});

test('R68-15 · 三页提示往返；不认识的页名 / 非布尔开关 / 超长文案都按 400 拒绝', async () => {
  // 先复位到一个确定的起点（本文件里多条用例共享同一份配置）
  configStore.saveSite({
    notices: {
      login: { enabled: false, text: '' },
      register: { enabled: false, text: '' },
      share: { enabled: false, text: '' },
    },
  });
  const s = await serveSettings(ADMIN);
  try {
    let r = await request(s.port, 'PUT', '/site/config', {
      body: { notices: { share: { enabled: true, text: '继续下载即代表同意<a>用户协议</a>' } } },
    });
    assertEqual(r.status, 200, `应 200，实际 ${r.status}`);
    assertEqual(r.json.notices.share.enabled, true, '开关应落盘');
    assertEqual(r.json.notices.share.text, '继续下载即代表同意<a>用户协议</a>',
      '文案必须原样保存 —— 前端不做任何标签处理，服务端也不能改它');
    assertEqual(r.json.notices.login.enabled, false, '未提交的页保持原值');

    r = await request(s.port, 'PUT', '/site/config', { body: { notices: { home: { enabled: true } } } });
    assertEqual(r.status, 400, '不认识的页名必须 400 —— 静默忽略会让界面显示「已保存」而实际什么都没变');

    r = await request(s.port, 'PUT', '/site/config', { body: { notices: { login: { enabled: 'true' } } } });
    assertEqual(r.status, 400, 'enabled 必须是布尔，字符串 "true" 不接受');

    r = await request(s.port, 'PUT', '/site/config', { body: { notices: { login: { text: 'x'.repeat(301) } } } });
    assertEqual(r.status, 400, '提示文案超过 300 字符必须 400');

    r = await request(s.port, 'PUT', '/site/config', { body: { notices: { share: { text: '两行\n文案' } } } });
    assertEqual(r.status, 400, '单行提示文案不接受换行（会破坏登录卡片的排版）');
  } finally {
    await s.close();
  }
});

test('R68-16 · 权限：公开接口匿名可读，管理员接口匿名 403、普通用户 403', async () => {
  const anon = await serveSettings(null);
  try {
    const r = await request(anon.port, 'GET', '/site/agreements');
    assertEqual(r.status, 200, '匿名访客必须能读到协议提示（登录页在登录之前就要显示它）');
    assertEqual(typeof r.json.show, 'object', '载荷必须带 tri-state 的 show');
    // 管理接口在匿名声下必须拒绝（真实服务里由 /api 的会话中间件先拦，这里用 403 兜底判定）
    for (const [m, p] of [['GET', '/agreements/config'], ['PUT', '/agreements/config'], ['POST', '/agreements/preview']]) {
      const rr = await request(anon.port, m, p, { body: m === 'GET' ? null : {} });
      assert(rr.status === 401 || rr.status === 403, `${m} ${p} 匿名访问应被拒，实际 ${rr.status}`);
    }
  } finally {
    await anon.close();
  }

  const plain = await serveSettings(USER);
  try {
    const r = await request(plain.port, 'GET', '/agreements/config');
    assertEqual(r.status, 403, '普通用户不得读取 / 修改协议设置');
  } finally {
    await plain.close();
  }
});

test('R68-17 · 预览接口用「尚未保存」的草稿渲染，且与下发时同一个渲染器', async () => {
  const s = await serveSettings(ADMIN);
  try {
    const r = await request(s.port, 'POST', '/agreements/preview', {
      body: { terms: '# 草稿标题\n\n**未保存**的内容' },
    });
    assertEqual(r.status, 200, `预览应 200，实际 ${r.status}`);
    assertMatch(r.json.docs.terms.html, /<h1>草稿标题<\/h1>/, '草稿应被渲染成标题');
    assertMatch(r.json.docs.terms.html, /<strong>未保存<\/strong>/, '粗体应生效');
    assertEqual(configStore.getAgreements().terms, TERMS,
      '预览绝不能落盘 —— 它只是替管理员看一眼渲染结果');
  } finally {
    await s.close();
  }
});

/* ==================================================================== *
 * ⑤ 分享页（服务端渲染 + 零脚本 :target 对话框）
 * ==================================================================== */

/** 造一条「单文件、无密码、不付费」的分享链接（`create` 是 async —— 忘了 await 会拿到 undefined） */
async function makeLink(key) {
  return shareStore.create({
    key, bucket: 'tb-ag', region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 1024,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  });
}

test('R68-18 · 分享页：提示 + :target 对话框，且不含任何脚本（CSP 与零构建的前提）', async () => {
  configStore.saveAgreements({ terms: TERMS, privacy: PRIVACY });
  configStore.saveSite({ notices: { share: { enabled: true, text: '' } } });

  const l = await makeLink('share/one.txt');
  const s = await serve('/', shareRoutes);
  try {
    const r = await request(s.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200, `分享页应 200，实际 ${r.status}`);
    assertMatch(r.raw, /class="ag-notice"/, '应渲染出协议提示');
    assertMatch(r.raw, /href="#ag-share-terms"/, '提示里的链接必须指向该页的对话框锚点');
    assertMatch(r.raw, /id="ag-share-terms"/, '必须生成用户协议的对话框');
    assertMatch(r.raw, /id="ag-share-privacy"/, '必须生成隐私协议的对话框');
    assertMatch(r.raw, /ag-modal:target/, '对话框的显示必须靠 CSS :target（分享页 CSP 不允许内联脚本）');
    assertMatch(r.raw, /class="ag-close" href="#!"/, '必须有可点的关闭入口');
    assertEqual(/<script/i.test(r.raw), false,
      '分享页不得出现脚本 —— 这是它能在严格 CSP 下工作的前提');
  } finally {
    await s.close();
  }
});

test('R68-19 · 分享页：错误页不显示提示（那一页没有「继续下载」这个动作）', async () => {
  configStore.saveSite({ notices: { share: { enabled: true, text: '' } } });
  const s = await serve('/', shareRoutes);
  try {
    const r = await request(s.port, 'GET', '/s/not-a-real-link');
    assertEqual(r.status, 404, `不存在的链接应 404，实际 ${r.status}`);
    assertEqual(/class="ag-notice"/.test(r.raw), false,
      '错误页不得出现「继续下载即代表您已阅读并同意…」—— 自相矛盾');
    assertEqual(/id="ag-share-terms"/.test(r.raw), false, '错误页也不该生成没人能点开的对话框');
  } finally {
    await s.close();
  }
});

test('R68-20 · 分享页：开关关闭时整页不出现任何协议痕迹', async () => {
  configStore.saveSite({
    notices: { login: { enabled: true }, register: { enabled: false }, share: { enabled: false } },
  });
  const l = await makeLink('share/two.txt');
  const s = await serve('/', shareRoutes);
  try {
    const r = await request(s.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200);
    // ⚠️ 判据必须带 `class="` 前缀：样式表里永远躺着 `.ag-notice { … }` 与 `.ag-modal { … }`，
    // 只搜裸类名会把「页面自己的 CSS」当成「渲染出了提示」—— 那是本文件最容易假红的一条。
    assertEqual(/class="ag-notice"/.test(r.raw), false, '分享页未开 ⇒ 不得渲染提示');
    assertEqual(/class="ag-modal"/.test(r.raw), false, '也不得生成对话框（否则页面里躺着一份没人能点开的协议）');
  } finally {
    await s.close();
  }
});

/* ==================================================================== *
 * ⑥ 备份往返（协议是「换了实例就得重填一遍」的配置）
 * ==================================================================== */

test('R68-21 · 备份：两份正文与三页提示都在范围内，且能整段还原', () => {
  configStore.saveAgreements({ terms: '备份用用户协议', privacy: '备份用隐私协议' });
  configStore.saveSite({
    notices: {
      login: { enabled: true, text: '登录页提示' },
      register: { enabled: false, text: '' },
      share: { enabled: true, text: '分享页提示' },
    },
  });

  const data = backup.collect();
  assertEqual(data.agreements.terms, '备份用用户协议', '协议正文必须随备份走');
  assertEqual(data.agreements.privacy, '备份用隐私协议');
  assertEqual(data.site.notices.share.enabled, true,
    '三页提示属于站点设置，必须跟着走 —— 只备份正文会出现「提示挂着、点了没内容」的残缺态');
  assertEqual(data.site.notices.share.text, '分享页提示');

  assertEqual(backup.isEmptyData(data), false,
    '填过协议就不是「全新实例」—— 漏判会让导入窗口在这个实例上保持敞开');

  // 换到「空配置」再导入，断言逐字还原
  configStore.saveAgreements({ terms: '', privacy: '' });
  configStore.saveSite({ notices: { login: { enabled: false }, share: { enabled: false } } });
  backup.apply(data);
  assertEqual(configStore.getAgreements().terms, '备份用用户协议', '导入后协议正文应还原');
  assertEqual(configStore.getSite().notices.share.enabled, true, '导入后开关应还原');
  assertEqual(configStore.getSite().notices.share.text, '分享页提示', '导入后文案应还原');
  assertEqual(configStore.getSite().notices.login.enabled, true, '另一页也要还原');
});

/* ==================================================================== *
 * ⑦ 前端接线（静态断言：这几处一旦没接上，界面上完全看不出来）
 * ==================================================================== */

test('R68-22 · 卡片位置在「发信设置」与「线程并发」之间，且在 ADMIN_ONLY_CARDS 里', () => {
  const html = read('public/index.html');
  const iSmtp = html.indexOf('id="sysset-smtp-card"');
  const iAg = html.indexOf('id="sysset-agreement-card"');
  const iConc = html.indexOf('id="sysset-concurrency-card"');
  assert(iSmtp >= 0 && iAg >= 0 && iConc >= 0, '三张卡片都必须存在');
  assert(iSmtp < iAg && iAg < iConc,
    `需求要求协议设置落在「发信设置」与「线程并发」之间，实际下标 ${iSmtp}/${iAg}/${iConc}`);

  const js = read('public/js/syssettings.js');
  assertMatch(js, /ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-agreement-card'/,
    '协议设置必须登记进 ADMIN_ONLY_CARDS —— 否则普通用户也能看到并修改协议');
  // 三页开关必须在站点设置卡片里（需求明确「这一设置项应放置在【站点设置】卡片中」）
  const iSite = html.indexOf('id="sysset-site-card"');
  const iUser = html.indexOf('id="sysset-user-card"');
  const siteBlock = html.slice(iSite, iUser);
  for (const page of ['login', 'register', 'share']) {
    assertMatch(siteBlock, new RegExp(`id="site-notice-${page}"`),
      `站点设置卡片里必须有 ${page} 页的开关`);
    assertMatch(siteBlock, new RegExp(`id="site-notice-${page}-text"`),
      `站点设置卡片里必须有 ${page} 页的文案输入框`);
  }
  // 协议设置卡片里**不能**再放一遍这些开关（需求：协议设置只保存协议文案）
  const agBlock = html.slice(iAg, iConc);
  assertEqual(/site-notice-/.test(agBlock), false,
    '协议设置卡片里不得再出现三页开关 —— 需求把它归站点设置，两处都能改就会有先后之争');
});

test('R68-23 · 两个编辑框是固定高度 + 竖滚动，且卡片能预览', () => {
  const html = read('public/index.html');
  const iAg = html.indexOf('id="sysset-agreement-card"');
  const iConc = html.indexOf('id="sysset-concurrency-card"');
  const block = html.slice(iAg, iConc);
  assertMatch(block, /id="agreement-terms"[^>]*class="ag-editor"/, '用户协议编辑框必须有 ag-editor 类');
  assertMatch(block, /id="agreement-privacy"[^>]*class="ag-editor"/, '隐私协议编辑框同上');
  assertMatch(block, /id="btn-agreement-preview"/, '必须有「预览渲染效果」按钮');

  const css = read('public/css/style.css');
  const iCss = css.indexOf('.ag-editor {');
  assert(iCss >= 0, '必须有 .ag-editor 样式（没有它编辑框会随内容无限长高）');
  const rule = css.slice(iCss, css.indexOf('}', iCss));
  assertMatch(rule, /height:\s*\d+px/, '固定高度：必须有显式 height（靠 rows 撑不算固定）');
  assertMatch(rule, /overflow-y:\s*auto/, '竖滚动：内容超出时必须出滚动条而不是撑开卡片');
});

test('R68-24 · 登录 / 注册页：提示元素存在，且只在 login / register 两种形态下渲染', () => {
  const html = read('public/index.html');
  assertMatch(html, /id="auth-agreement"/, '登录卡片里必须有提示挂载点');
  const main = read('public/js/main.js');
  assertMatch(main, /API\.agreementPublic\(\)/,
    '必须从公开接口取协议提示 —— 未登录时也要显示它');
  assertMatch(main, /renderAuthAgreement\(\)/, 'showAuthOverlay 里必须渲染一次（四种形态共用同一个渲染点）');
  assertMatch(main, /authMode === 'login' \? 'login' : \(authMode === 'register' \? 'register' : ''\)/,
    'init（创建管理员）与 forgot（重置密码）不是注册页 / 登录页，不得显示提示');
  assertMatch(main, /e\.preventDefault\(\)/,
    '链接点击必须阻止默认跳锚点行为（登录页没有 #ag-login-terms 这个目标）');
  assertMatch(main, /openAgreementDialog\(/, '点链接要打开协议对话框');
});

test('R68-25 · 协议对话框必须有关闭入口（需求原文）', () => {
  const util = read('public/js/util.js');
  const i = util.indexOf('export function openAgreementDialog');
  assert(i >= 0, 'openAgreementDialog 必须存在于 util.js（三处共用同一个对话框）');
  const body = util.slice(i, util.indexOf('\n}\n', i));
  assertMatch(body, /foot:\s*\[\{\s*text:\s*'关闭'/, '必须有「关闭」按钮');
  assertMatch(body, /body:\s*\{\s*html:/,
    '正文必须走 `{ html }` 这条「显式声明可信 HTML」的通道（不要用字符串直塞的兼容路径）');
  // openModal 自带右上角 ✕ 与 Esc 关闭，这里确认它没被覆盖掉
  assertMatch(util, /data-x title="关闭"/, '右上角关闭按钮必须仍在');
});
