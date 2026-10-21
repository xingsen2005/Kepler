/**
 * 第七十三轮护栏（R73，用户提出的四项界面改进）
 *
 *  1. 「订单取回」卡片移到「用户管理」之下，整体排列保持一致；
 *  2. 「配置备份」提供本地 JSON 文件选择入口，并明确非 JSON 文件的处理；
 *  3. 系统设置页顶部新增卡片锚点导航栏（平滑滚动 + 与卡片一致 + 响应式）；
 *  4. 首个用户页面的旧口径（R71 起建的是**根用户**）补改干净。
 *
 * ## 分层：每条都指向**实际被执行的那一层**
 *
 *  - 锚点导航：不读源码猜，而是配一个轻量 DOM 桩**真跑** `anchornav.js`
 *    （它独立成模块正是为了能被这样加载 —— 塞在 `syssettings.js` 里会牵动
 *    `main.js` 的顶层 `init()`，桩撑不住）；
 *  - 备份文件：四个纯函数**真 import 真跑**（`backupcfg.js` 无 DOM 依赖）；
 *  - 结构 / 响应式：读 `index.html` 与 `style.css` 的真实文本；
 *  - 文案口径：读 `main.js` / `index.html` 的真实内容。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT } = require('./helpers.js');

const HTML = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = () => fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
/** 只取会真正渲染出来的部分（HTML 注释不参与渲染，负向断言必须先剥掉） */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const MOD = (f) => `file:///${path.join(ROOT, 'public', 'js', f).replace(/\\/g, '/')}`;

/* ================================================================== *
 * ① 卡片顺序：「订单取回」在「用户管理」之下
 * ================================================================== */

test('R73-01 · 卡片顺序：站点设置 → 用户管理 → 订单取回 → 发信设置', () => {
  const html = HTML();
  const at = (k) => html.indexOf(`id="sysset-${k}-card"`);
  const [site, user, restore, smtp] = ['site', 'user', 'restore', 'smtp'].map(at);
  assert(site > 0 && user > 0 && restore > 0 && smtp > 0, '四张卡片都必须存在');
  assert(site < user && user < restore && restore < smtp,
    `顺序应为 站点 → 用户 → 取回 → 发信，实际 ${site}/${user}/${restore}/${smtp}`);
});

test('R73-02 · ADMIN_ONLY_CARDS 的次序与 DOM 一致（不是只看「在里面」）', () => {
  const js = JS('syssettings.js');
  assertMatch(js,
    /ADMIN_ONLY_CARDS\s*=\s*\['sysset-site-card',\s*'sysset-user-card',\s*'sysset-restore-card',\s*'sysset-smtp-card',/,
    '名单前四项必须与页面顺序同序（站点 → 用户 → 取回 → 发信）—— 顺序一致才不会在以后按下标做判断时错位');
});

/* ================================================================== *
 * ② 锚点导航栏：真跑 anchornav.js
 * ================================================================== */

/**
 * 极简 DOM 桩：只实现 `anchornav.js` 真正用到的那几个 API。
 *
 * ⚠️ 刻意**不**用 jsdom（项目零新增依赖）：这里要验证的是「扫描哪些卡片、
 * 跳过哪些、滚动到哪」，一个能记下 `scrollTo` 参数的假容器就够，
 * 而且比 jsdom 更能暴露「忘了减锚点栏高度」这类算术错误 —— 那是 jsdom
 * 不会替你算出来的（它没有真实布局）。
 */
function stubDom(cards) {
  const mkEl = (tag, opts = {}) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: opts.id || '',
      /**
       * `className` 必须是**活的**（与 `_classes` 双向同步）：
       * `anchornav.js` 里是 `a.className = 'sysset-anchor-link'` 直接赋值，
       * 而 `syncAnchorActive()` 认的是 `_classes` —— 不同步的话这里查不到任何链接，
       * 高亮测试会返回空串，看起来像「功能没做」其实是桩不真。
       */
      _classes: new Set((opts.className || '').split(/\s+/).filter(Boolean)),
      hidden: opts.hidden || false,
      /**
       * ⚠️ `textContent` 必须是**聚合子节点**的（真实 DOM 就是这样）。
       * 桩里若把它当普通字段，克隆 h3 后取到的就是空串，标题判定会全部退化成
       * 「卡片 N」的兜底值 —— 于是「标题不含徽章 / 计数」这条护栏会变成假绿/假红。
       */
      _text: opts.textContent || '',
      href: '',
      dataset: {},
      offsetHeight: opts.offsetHeight || 0,
      _children: [],
      _rect: opts.rect || { top: 0 },
      _listeners: {},
      scrollTop: opts.scrollTop || 0,
      _scrolled: [],
      appendChild(c) { c._parent = this; this._children.push(c); return c; },
      removeChild(c) { this._children = this._children.filter((x) => x !== c); },
      /** 真实 DOM 的 `remove()` 会让自己脱离父节点 —— 桩里写成空操作的话，
       *  `cardAnchorTitle` 摘掉徽章 / 按钮那一步就等于没做，标题会带着它们一起被断言。 */
      remove() { if (this._parent) this._parent.removeChild(this); },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      setAttribute() {}, getAttribute() { return null; },
      get textContent() {
        return this._children.length ? this._children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) { this._text = String(v); this._children = []; },
      get className() { return [...this._classes].join(' '); },
      set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
      getBoundingClientRect() { return this._rect; },
      scrollTo(o) { this._scrolled.push(o); this.scrollTop = o.top; },
      /** 深拷贝（克隆后要能再 querySelectorAll —— cardAnchorTitle 正是这么摘徽章的） */
      cloneNode() {
        const c = mkEl(this.tagName, { className: this.className });
        c._text = this._text;
        for (const ch of this._children) c.appendChild(ch.cloneNode(true));
        return c;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const want = String(sel).split(',').map((s) => s.trim().replace(/^\./, ''));
        const hit = [];
        const walk = (n) => {
          for (const c of n._children) {
            if (want.some((w) => c._classes.has(w))) hit.push(c);
            walk(c);
          }
        };
        walk(this);
        return hit;
      },
      get classList() {
        const self = this;
        return {
          add: (c) => self._classes.add(c),
          remove: (c) => self._classes.delete(c),
          contains: (c) => self._classes.has(c),
          toggle: (c, on) => { if (on) self._classes.add(c); else self._classes.delete(c); },
        };
      },
    };
    return el;
  };

  const sec = mkEl('section', { id: 'systemsettings', className: 'card-view', rect: { top: 0 } });
  const bar = mkEl('nav', { id: 'sysset-anchorbar', className: 'sysset-anchorbar', hidden: true, offsetHeight: 33 });
  sec.appendChild(bar);
  for (const c of cards) {
    const card = mkEl('div', {
      id: c.id || '', className: `dash-card wide sysset-card`, hidden: !!c.hidden, rect: { top: c.top || 0 },
    });
    // h3：徽章 + 标题 + 计数 + 按钮，用来验「标题不含这些」
    const h3 = mkEl('h3', { className: 'sysset-h3' });
    const tag = mkEl('span', { className: 'sysset-tag', textContent: c.tag || '标签' });
    const title = mkEl('span', { textContent: c.title || '' });
    const cnt = mkEl('span', { className: 'lk-count', textContent: c.count || '' });
    const btn = mkEl('button', { className: 'mini-btn sysset-action', textContent: '保存' });
    h3.appendChild(tag); h3.appendChild(title); h3.appendChild(cnt); h3.appendChild(btn);
    card.appendChild(h3);
    sec.appendChild(card);
  }
  const byId = new Map();
  byId.set('systemsettings', sec);
  byId.set('sysset-anchorbar', bar);
  for (const c of cards) if (c.id) byId.set(c.id, sec._children.find((x) => x.id === c.id));

  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => mkEl(t),
  };
  return { sec, bar, byId, mkEl };
}

test('R73-03 · 锚点数与实际卡片一一对应，且跳过隐藏的卡片', async () => {
  const { bar } = stubDom([
    { id: 'sysset-site-card', title: '站点设置', top: 100 },
    { id: 'sysset-user-card', title: '用户管理', top: 500 },
    { id: 'sysset-restore-card', title: '订单取回', top: 900, hidden: true }, // 被角色隐藏
    { id: 'sysset-smtp-card', title: '发信设置', top: 1300 },
  ]);
  const m = await import(MOD('anchornav.js'));
  const cards = m.buildAnchorBar();

  assertEqual(cards.length, 3, '隐藏的「订单取回」不得出现在锚点里（否则点了会滚到不存在的卡片）');
  assertEqual(bar._children.length, 3, '锚点条目数必须等于可见卡片数');
  const texts = bar._children.map((a) => a.textContent);
  assertEqual(texts.join(','), '站点设置,用户管理,发信设置', `锚点文案应只含可见卡片，实际 ${texts.join(',')}`);
  assert(bar.hidden === false, '有 3 张卡片时应显示导航栏');
});

test('R73-04 · 只剩一张可见卡片（普通用户）时整条导航收起', async () => {
  const { bar } = stubDom([
    { id: 'sysset-user-card', title: '用户管理', hidden: true },
    { id: 'sysset-about-card', title: '关于' },
  ]);
  const m = await import(MOD('anchornav.js'));
  const cards = m.buildAnchorBar();
  assertEqual(cards.length, 0, '只有一张卡时不该生成导航');
  assert(bar.hidden === true, '导航栏必须收起 —— 一条只指向「关于」的导航栏是噪音');
});

test('R73-05 · 锚点标题不含徽章 / 计数 / 按钮文案', async () => {
  const { bar } = stubDom([
    { id: 'a', title: '站点设置', tag: '站点', count: '已启用', top: 10 },
    { id: 'b', title: '线程并发', tag: '并发', top: 20 },
  ]);
  const m = await import(MOD('anchornav.js'));
  m.buildAnchorBar();
  const t = bar._children.map((a) => a.textContent);
  assertEqual(t[0], '站点设置', `标题应为纯标题，实际「${t[0]}」`);
  assertEqual(t[1], '线程并发', `标题应为纯标题，实际「${t[1]}」`);
  assert(!t.some((x) => /保存|已启用|站点并发/.test(x)), '不得把标签徽章、状态计数或按钮文案拼进标题');
});

test('R73-06 · 点击后滚动到卡片，且**减掉锚点栏高度**（否则标题被压住）', async () => {
  const { sec, bar } = stubDom([
    { id: 'a', title: '站点设置', top: 100 },
    { id: 'b', title: '线程并发', top: 900 },
  ]);
  const m = await import(MOD('anchornav.js'));
  m.buildAnchorBar();
  const link = bar._children[1];
  const target = sec._children.find((x) => x.id === 'b');
  // 触发 click（桩里 addEventListener 存的就是它）
  link._listeners.click[0]({ preventDefault() {} });

  assertEqual(sec._scrolled.length, 1, '点击应触发一次滚动');
  const want = 900 - bar.offsetHeight - 10;
  assertEqual(sec._scrolled[0].top, want,
    `scrollTop 必须是「卡片位置 − 锚点栏高度 − 间距」= ${want}；不减栏高就会让标题被 sticky 栏盖住`);
  assertEqual(sec._scrolled[0].behavior, 'smooth', '应当是平滑滚动');
  void target;
});

test('R73-07 · 高亮跟随滚动：越过锚点栏下沿的最后一张卡', async () => {
  const { sec, bar } = stubDom([
    { id: 'a', title: '站点设置', top: 0 },
    { id: 'b', title: '线程并发', top: 400 },
    { id: 'c', title: '支付设置', top: 1200 },
  ]);
  const m = await import(MOD('anchornav.js'));
  m.buildAnchorBar();
  // 容器滚到「已越过 a、尚未到 c」的位置：把 b 挪到锚点栏下沿之上
  sec._children.find((x) => x.id === 'b')._rect = { top: 5 };
  sec._children.find((x) => x.id === 'c')._rect = { top: 900 };
  const active = m.syncAnchorActive();
  assertEqual(active, 'b', '顶边已越过、且最靠下的那张应为高亮项');
  const hit = bar._children.filter((a) => a._classes.has('active'));
  assertEqual(hit.length, 1, '高亮项必须唯一 —— 多个高亮等于没高亮');
  assertEqual(hit[0].dataset.target, 'b', '高亮的应是 b');
});

/* ================================================================== *
 * ③ 锚点栏的结构与响应式（HTML / CSS 真实文本）
 * ================================================================== */

test('R73-08 · 锚点栏挂在系统设置页内、且在卡片栅格之前（紧贴工具栏下方）', () => {
  const html = HTML();
  const iSec = html.indexOf('id="systemsettings"');
  const iBar = html.indexOf('id="sysset-anchorbar"');
  const iGrid = html.indexOf('<div class="dash-grid">', iSec);
  assert(iSec > 0 && iBar > 0 && iGrid > 0, '三处结构都应存在');
  assert(iSec < iBar && iBar < iGrid,
    `锚点栏必须在 #systemsettings 内、且排在卡片栅格之前（实际 ${iSec}/${iBar}/${iGrid}）`);
});

test('R73-09 · 锚点栏 sticky 生效 + [hidden] 真的能收起 + 窄屏横向滚动', () => {
  const css = CSS();
  /**
   * ⚠️ 必须锚**顶层**那条（行首无缩进）：`@media` 里还有一条同名的窄屏规则，
   * 而它排在文件更靠前的位置 —— `indexOf` 会先命中它，拿到的 block 里自然没有
   * `position: sticky`，于是这条断言会莫名其妙地红。
   */
  const m = /\n\.sysset-anchorbar \{/.exec(css);
  assert(m, '应有顶层 .sysset-anchorbar 规则（媒体查询里那条不算）');
  const i = m.index + 1;
  const block = css.slice(i, css.indexOf('}', i));
  assertMatch(block, /position:\s*sticky/, '必须 sticky：滚动时它要一直可见，否则滚到一半就没法再跳');
  // `display:flex` 会盖掉 [hidden] 的 display:none —— 少了这条，普通用户会看到一条空白横条
  assertMatch(css, /\.sysset-anchorbar\[hidden\]\s*\{\s*display:\s*none/,
    '必须显式写回 [hidden] 的 display:none（flex 会盖掉它）');

  // 响应式：窄屏那一段里必须有横向滚动，而不是任由它换行
  const mi = css.indexOf('@media (max-width: 760px)');
  assert(mi > 0, '应有窄屏断点');
  const mBlock = css.slice(mi, css.indexOf('\n}\n', mi));
  assertMatch(mBlock, /\.sysset-anchorbar[\s\S]{0,200}overflow-x:\s*auto/,
    '窄屏下应改为横向滚动 —— 十几张卡片换行会把它撑成好几行');
});

/* ================================================================== *
 * ④ 配置备份：本地 JSON 文件（真跑纯函数）
 * ================================================================== */

test('R73-10 · 只收 .json：扩展名门禁（大小写不敏感），其余一律拒绝', async () => {
  const { isBackupJsonFile } = await import(MOD('backupcfg.js'));
  for (const ok of ['a.json', 'backup.JSON', 'kepler-config-backup-abc123.json', ' my file .json ']) {
    assert(isBackupJsonFile(ok) === true, `应接受 ${JSON.stringify(ok)}`);
  }
  for (const no of ['a.txt', 'a.zip', 'a.json.bak', 'a', 'a.jsonx', '', null, undefined]) {
    assert(isBackupJsonFile(no) === false, `应拒绝 ${JSON.stringify(no)}`);
  }
});

test('R73-11 · 非 JSON / 缺 code / 空文件给出**各不相同**的提示（便于判断该换文件还是文件坏了）', async () => {
  const { parseBackupFile } = await import(MOD('backupcfg.js'));

  const good = parseBackupFile(JSON.stringify({ app: 'kepler', code: 'KEPLER-CONFIG-SEALED-V1.abc', fingerprint: 'f1' }));
  assert(good.ok === true && good.code === 'KEPLER-CONFIG-SEALED-V1.abc', '正常备份应解析出导出码');
  assertEqual(good.fingerprint, 'f1', '指纹应一并取出');

  const bad = parseBackupFile('这不是 JSON');
  assert(bad.ok === false, '非法 JSON 必须拒绝');
  assertMatch(bad.reason, /JSON/, '提示要说明「不是有效的 JSON」');

  const noCode = parseBackupFile(JSON.stringify({ app: 'kepler' }));
  assert(noCode.ok === false, '缺 code 字段必须拒绝');
  assertMatch(noCode.reason, /导出码|code/, '提示要指向「缺少 code 字段」');

  const empty = parseBackupFile('   ');
  assert(empty.ok === false && /空/.test(empty.reason), '空文件要有专门提示');

  // 三条提示必须互不相同 —— 都写成「文件不对」，用户无从判断该怎么办
  const all = [bad.reason, noCode.reason, empty.reason];
  assertEqual(new Set(all).size, 3, `三种失败必须给出三种不同提示，实际：${all.join(' | ')}`);
});

test('R73-12 · 导入走文件：选中后自动填码（真跑 pickBackupFile）', async () => {
  const { pickBackupFile } = await import(MOD('backupcfg.js'));
  const code = 'KEPLER-CONFIG-SEALED-V1.zzz';
  const file = { name: 'kepler-config-backup-f1.json', size: 200 };

  // 打桩：input.click() 后同步塞入文件并触发 change
  globalThis.document = {
    createElement: () => {
      const el = {
        type: '', accept: '', style: {}, files: null, _ls: {},
        addEventListener(t, fn) { this._ls[t] = fn; },
        click() { this.files = [file]; this._ls.change(); },
      };
      return el;
    },
    body: { appendChild() {}, removeChild() {} },
  };
  globalThis.FileReader = class {
    readAsText() { this.result = JSON.stringify({ app: 'kepler', code, fingerprint: 'f1' }); this.onload(); }
  };

  const r = await pickBackupFile();
  assert(r && r.error === undefined, `正常文件应解析成功，实际 ${JSON.stringify(r)}`);
  assertEqual(r.code, code, '应把文件里的导出码取出来');
  assertEqual(r.name, file.name, '应带回文件名（界面上要显示「已读取：xxx」）');
});

test('R73-13 · 非 .json 文件**连内容都不读**（扩展名门禁在读文件之前）', async () => {
  const { pickBackupFile } = await import(MOD('backupcfg.js'));
  let readCalled = false;
  globalThis.document = {
    createElement: () => {
      const el = {
        type: '', accept: '', style: {}, files: null, _ls: {},
        addEventListener(t, fn) { this._ls[t] = fn; },
        click() { this.files = [{ name: 'notes.txt', size: 10 }]; this._ls.change(); },
      };
      return el;
    },
    body: { appendChild() {}, removeChild() {} },
  };
  globalThis.FileReader = class {
    readAsText() { readCalled = true; this.onload(); }
  };

  const r = await pickBackupFile();
  assert(r && typeof r.error === 'string', `.txt 必须被拒，实际 ${JSON.stringify(r)}`);
  assertMatch(r.error, /只接受\s*\.json/, '提示要明说只接受 .json');
  assertEqual(readCalled, false,
    '非 .json 文件不得读取其内容 —— 备份里含密钥明文，不该去猜用户塞进来的是什么');
});

test('R73-14 · 导出文件名：留空用默认名，自定义补齐 .json 并去掉非法字符', async () => {
  const { backupFileName } = await import(MOD('backupcfg.js'));
  assertEqual(backupFileName('ab12', ''), 'kepler-config-backup-ab12.json', '留空应回落默认名');
  assertEqual(backupFileName('ab12', null), 'kepler-config-backup-ab12.json', 'null 同样回落');
  assertEqual(backupFileName('ab12', '我的备份'), '我的备份.json', '自定义名要补 .json');
  assertEqual(backupFileName('ab12', 'my backup.json'), 'my backup.json', '已带 .json 不重复补');
  // Windows 文件名非法字符：不换掉会让下载直接失败，且浏览器层无提示
  assertEqual(backupFileName('ab12', 'a:b*c?d'), 'a_b_c_d.json', '非法字符必须替换为 _');
  assert(/^[A-Za-z0-9_-]+\.json$/.test(backupFileName('we!rd/fp', '')), '指纹里的怪字符也要清掉');
});

test('R73-15 · 界面上写明了非 JSON 的处理方式（不只是代码里拒了）', () => {
  const src = JS('backupcfg.js');
  assertMatch(src, /只接受 \.json 文件/, '拒绝提示要出现在界面文案里');
  assertMatch(src, /不会被上传|不会上传到服务器/, '要说明文件不会上传（读取在本地完成）');
  assertMatch(src, /showSaveFilePicker/, '导出应优先走「另存为」让用户选位置');
});

/* ================================================================== *
 * ⑤ 首个用户页面：R71 之后的旧口径补改
 * ================================================================== */

test('R73-16 · 初始化页说的是「根用户」，不是「管理员」', () => {
  const js = JS('main.js');
  assertMatch(js, /title\.textContent = '创建根用户账户'/, '标题必须是「创建根用户账户」');
  assertMatch(js, /sub\.textContent = '首次使用，请创建根用户账户以初始化系统'/, '副标题同步');
  assertMatch(js, /根用户账户创建成功/, '成功提示同步');
  assert(!/创建管理员账户|管理员账户创建成功/.test(js),
    '不得残留「创建管理员账户」的旧文案 —— 它会让用户误判自己能管到哪一层');
});

test('R73-17 · 安装令牌的指引不再只指向启动日志（R72 后有三处可见）', () => {
  const html = stripHtmlComments(HTML());
  const js = JS('main.js');
  assert(!/见服务端启动日志/.test(html), 'HTML 里不得再只写「见服务端启动日志」');
  assert(!/见服务端启动日志/.test(js), 'JS 提示里也不得只写「见服务端启动日志」');
  assertMatch(html, /部署完成信息 \/ kepler 菜单/, '应指向部署完成信息与 kepler 菜单');
  assertMatch(js, /部署完成信息或 kepler 菜单/, '前端校验提示同样要给出这两处');
});

test('R73-18 · 用户管理卡片说明写清三层权限（管理员只能管普通用户）', () => {
  const html = stripHtmlComments(HTML());
  assertMatch(html, /根用户[\s\S]{0,120}管理员[\s\S]{0,120}普通用户/, '应说明三层角色');
  assertMatch(html, /管理员[\s\S]{0,60}仅能管理[\s\S]{0,20}普通用户/, '必须写明管理员只能管理普通用户');
  assertMatch(html, /至少一个根用户/, '保底规则应写「至少一个根用户」（旧文案是「至少一个管理员」）');
});
