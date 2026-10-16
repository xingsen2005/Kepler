/**
 * 第四十四轮护栏（R44）—— 侧栏「文件夹导航」换成「文件类型」筛选
 *
 * 需求（原文）：
 *  1. 移除「文件夹导航」，因为这个功能与顶部的地址栏重复；
 *  2. 将「文件夹导航」替换为「文件类型」功能：可筛选当前存储桶中的文件，
 *     分为 全部 / 图片 / 视频 / 音频 / 文档 / 压缩包 / 可执行文件。
 *     后缀名处理规则与 SVG 图标由 `ico.txt` 给出，直接替换文件夹的 icon；
 *     每个类型有规定的背景色，图形绘在背景色上，图标要缩放到**视觉一致**。
 *
 * 澄清后的行为口径（用户在两处选项里选定）：
 *  · 筛选范围 = **当前目录列表**，即时生效、不发请求；
 *  · 选中某个具体类型时**文件夹不显示**（文件夹不属于任何文件类型），「全部」恢复。
 *
 * ## 本轮的四个真实风险（护栏按此分四层）
 *
 * ① **分类表分叉**：前端再存一份后缀表 → 与服务端 `TYPE_EXT` 漂移，
 *    「侧栏数得到 3 个图片、搜索却说 0 个」。故分类**只有服务端一份**，
 *    前端一律读 `item.type`；本文件既断言 `TYPE_EXT.exec` 的成员，
 *    也断言前端源码里**不存在**后缀表。
 *
 * ② **过滤点分叉**：侧栏自己也过滤一遍 → 侧栏按类型、渲染忘了排除文件夹，
 *    或「全选」选到看不见的项，随后的删除 / 下载作用到隐藏对象上。
 *    故过滤**只有 `explorer.visibleItems()` 一份实现**，且渲染、连选、拖拽落点、
 *    全选都只看 `state.visible`。
 *
 * ③ **图标名写错**：`<use href="#fic-exec">` 这种「引用了精灵图里不存在的 id」
 *    在浏览器里**静默渲染成空白**（不报错、不抛异常、控制台干干净净）。
 *    故这里做**双向覆盖检查**：JS 引用的每个 `fic-*` 必须有对应 `<symbol>`，
 *    每个 `<symbol>` 也必须真的被引用（防拼错与防死代码）。
 *
 * ④ **视觉一致**：`ico.txt` 的 10 个图形各自画布不同（有 1024 有 512），
 *    直接塞进同一个 viewBox 会大小不一。修法是离线把每个图形按**视觉包围盒**
 *    归一化到 1024 画布中央的 720×720 方框（含椭圆弧的真实描点），
 *    变换写死在 `<symbol>` 里的 `<g transform>`。故这里断言每个 symbol 的
 *    `<g>` 都带 `translate(...) scale(...)`（漏了 = 图形大小不齐）。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R44-*` 条目。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT } = require('./helpers.js');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const utilUrl = pathToFileURL(JS('util.js')).href;

/* ================================================================== *
 * ① 纯函数层（真实 util.js）
 * ================================================================== */

test('R44 · util.FILE_TYPES：恰好 7 项、顺序即需求给出的顺序、「全部」的 icon 为空', async () => {
  const u = await import(utilUrl);

  assert(Array.isArray(u.FILE_TYPES), 'FILE_TYPES 必须是数组');
  assertEqual(u.FILE_TYPES.length, 7, `侧栏应有 7 项（全部 + 6 个类型），实际 ${u.FILE_TYPES.length}`);

  assertEqual(u.FILE_TYPES.map((t) => t.id).join(','), ',image,video,audio,doc,archive,exec',
    '顺序必须与需求一致：「全部、图片、视频、音频、文档、压缩包、可执行文件」；'
    + '「全部」的 id 是空串（= 不筛选）');
  assertEqual(u.FILE_TYPES.map((t) => t.label).join(','), '全部,图片,视频,音频,文档,压缩包,可执行文件',
    '标签文案必须与需求逐字一致');

  assertEqual(u.FILE_TYPES[0].icon, '',
    '「全部」不对应任何文件类型，icon 必须是空串 —— 由 filetype.js 回退到中性四宫格');
  for (const t of u.FILE_TYPES.slice(1)) {
    assert(/^fic-[a-z]+$/.test(t.icon), `${t.label} 的 icon 应形如 fic-xxx，实际 ${JSON.stringify(t.icon)}`);
  }
  const ids = u.FILE_TYPES.slice(1).map((t) => t.icon);
  assertEqual(new Set(ids).size, ids.length, '除「全部」外，各类型的图标不得重复（重复 = 有一个类型画错图标）');
});

test('R44 · util.iconIdOf：文件夹 / 各类型 / 可执行文件按扩展名细分 / 未分类回退', async () => {
  const u = await import(utilUrl);
  const of = (o) => u.iconIdOf(Object.assign({ isFolder: false, name: 'x.bin', type: 'other' }, o));

  assertEqual(of({ isFolder: true, type: 'folder', name: 'docs' }), 'fic-folder',
    '文件夹用 ico.txt 给定的文件夹图标（不再是内联 svg）');

  assertEqual(of({ type: 'image', name: 'a.jpg' }), 'fic-image');
  assertEqual(of({ type: 'video', name: 'a.mp4' }), 'fic-video');
  assertEqual(of({ type: 'audio', name: 'a.mp3' }), 'fic-audio');
  assertEqual(of({ type: 'doc', name: 'a.docx' }), 'fic-doc');
  assertEqual(of({ type: 'archive', name: 'a.zip' }), 'fic-archive');

  // 可执行文件四套系统图标 —— 这是本轮唯一「同类型再细分」的地方
  assertEqual(of({ type: 'exec', name: 'setup.exe' }), 'fic-exe', 'exe 用 Windows 图标');
  assertEqual(of({ type: 'exec', name: 'setup.msi' }), 'fic-exe', 'msi 与 exe 同口径（Windows 安装包）');
  assertEqual(of({ type: 'exec', name: 'cmd.com' }), 'fic-exe', 'com 与 exe 同口径');
  assertEqual(of({ type: 'exec', name: 'app.apk' }), 'fic-apk', 'apk 用 Android 图标');
  assertEqual(of({ type: 'exec', name: 'app.ipa' }), 'fic-ipa', 'ipa 用 iOS 图标');
  assertEqual(of({ type: 'exec', name: 'app.hpkg' }), 'fic-hpkg', 'hpkg 用 HarmonyOS 图标');

  assertEqual(of({ type: 'exec', name: 'SETUP.EXE' }), 'fic-exe',
    '扩展名比较必须大小写不敏感（云端 key 大小写任意，写死小写会露成默认图标）');
  assertEqual(of({ type: 'exec', name: 'a.tar.gz' }), 'fic-exe',
    '取**最后**一段扩展名；未登记的 exec 后缀回退 Windows 图标而不是空白');
  assertEqual(of({ type: 'exec', name: 'noext' }), 'fic-exe', '无点号时整串当扩展名 → 回退，不得抛错');
  assertEqual(of({ type: 'exec', name: '' }), 'fic-exe', '空名字不得抛错');
  assertEqual(of({ type: 'exec' }), 'fic-exe', 'name 缺失不得抛错');

  assertEqual(of({ type: 'other', name: 'a.pdf' }), 'fic-other', '未分类回退到中性图标');
  assertEqual(of({ type: 'weird', name: 'a.x' }), 'fic-other', '未知类型也回退到中性图标（不得返回 undefined）');
  assertEqual(of({}), 'fic-other', '字段全缺时不得抛错');

  // 判据必须落在 exec 的**细分**上：map 里少一个键就会静默变成 Windows 图标
  const src = readSrc('public', 'js', 'util.js');
  assert(/apk:\s*'fic-apk'/.test(src), 'EXEC_ICON 必须给 apk 配 fic-apk');
  assert(/ipa:\s*'fic-ipa'/.test(src), 'EXEC_ICON 必须给 ipa 配 fic-ipa');
  assert(/hpkg:\s*'fic-hpkg'/.test(src), 'EXEC_ICON 必须给 hpkg 配 fic-hpkg');
});

test('R44 · util.iconHtml：输出 <use href="#…"> 的 1024 画布 svg，且没有任何按后缀的文字徽标', async () => {
  const u = await import(utilUrl);

  const img = u.iconHtml({ isFolder: false, name: 'a.png', type: 'image' });
  assertEqual(img, '<svg class="fic" viewBox="0 0 1024 1024" aria-hidden="true"><use href="#fic-image"></use></svg>',
    '图标必须是雪碧引用（`<use href="#…">`），不是内联 path，也不是文字徽标');
  assert(/viewBox="0 0 1024 1024"/.test(img), 'viewBox 必须与精灵图符号一致，否则图形会被裁切 / 变形');

  assert(/fic-folder/.test(u.iconHtml({ isFolder: true, name: 'docs', type: 'folder' })),
    '文件夹同样走雪碧图标（需求：直接替换文件夹的 icon）');
  assert(/fic-apk/.test(u.iconHtml({ isFolder: false, name: 'a.apk', type: 'exec' })),
    'iconHtml 必须把扩展名一路传到 iconIdOf（写成只看 type 会丢掉四套系统图标）');

  // 转义：名字里塞引号不得逃出 href
  const evil = u.iconHtml({ isFolder: false, name: '"><script>x</script>.apk', type: 'exec' });
  assert(!/<script/.test(evil), '名字不得未转义地进入标记');
  assert(/href="#fic-apk"/.test(evil), '取扩展名后仍应命中 apk 图标');

  // 旧实现（按后缀渲染文字角标）必须彻底消失 —— 否则新旧两套图标会同时出现
  assert(!/extShort/.test(readSrc('public', 'js', 'util.js')), 'util.js 不得再保留 extShort（旧文字角标）');
  assert(!/EXT_COLOR/.test(readSrc('public', 'js', 'util.js')), 'util.js 不得再保留 EXT_COLOR（徽标配色表已由精灵图取代）');
  assert(!/badge/.test(readSrc('public', 'js', 'util.js')), 'util.js 不得再产生 badge 角标');
});

test('R44 · util.TYPE_LABEL.exec：新增可执行文件的类型文案，且不与其它类型撞名', async () => {
  const u = await import(utilUrl);
  assertEqual(u.TYPE_LABEL.exec, '可执行文件', '类型列 / 筛选面板需要这个文案');
  const labels = Object.values(u.TYPE_LABEL);
  assertEqual(new Set(labels).size, labels.length, '类型文案不得重复（重复 = 下拉里出现两个一模一样的选项）');
});

/* ================================================================== *
 * ② 服务端分类表（真实 server/routes/_shared.js）
 * ================================================================== */

test('R44 · TYPE_EXT.exec：新增六项，且 apk 必须从 archive 搬走（不能两处都有）', () => {
  const shared = require(SERVER('routes', '_shared.js'));
  const src = readSrc('server', 'routes', '_shared.js');

  const m = /const TYPE_EXT = \{([\s\S]*?)\n\};/.exec(src);
  assert(m, '必须能定位到 TYPE_EXT 字面量');
  const body = m[1];
  const execLine = /exec:\s*\[([^\]]*)\]/.exec(body);
  assert(execLine, 'TYPE_EXT 必须新增 exec 一类');
  const execList = execLine[1].match(/'([a-z0-9]+)'/g).map((s) => s.replace(/'/g, ''));
  assertEqual(execList.join(','), 'exe,msi,com,apk,ipa,hpkg', 'exec 成员与顺序应与需求给出的后缀规则一致');

  const archLine = /archive:\s*\[([^\]]*)\]/.exec(body);
  assert(archLine, 'archive 一类必须仍在');
  const archList = archLine[1].match(/'([a-z0-9]+)'/g).map((s) => s.replace(/'/g, ''));
  assert(!archList.includes('apk'),
    'apk 必须从 archive 移出 —— 两处都列时 typeOf() 按对象键序返回 archive，'
    + '侧栏「可执行文件」的计数会永远比实际少，而界面看不出问题');

  // 判据落在「实际被执行的那一层」：typeOf() 的真实返回值
  assertEqual(shared.typeOf('app.apk'), 'exec', 'typeOf 必须把 apk 判成 exec');
  assertEqual(shared.typeOf('setup.exe'), 'exec');
  assertEqual(shared.typeOf('x.msi'), 'exec');
  assertEqual(shared.typeOf('cmd.com'), 'exec');
  assertEqual(shared.typeOf('a.ipa'), 'exec');
  assertEqual(shared.typeOf('b.hpkg'), 'exec');
  assertEqual(shared.typeOf('c.zip'), 'archive', 'zip 仍归压缩包（搬家不得误伤）');
  assertEqual(shared.typeOf('d.svg'), 'image', 'svg 仍归图片 —— 移出去会让它丢掉缩略图与预览');
  assertEqual(shared.typeOf('e.wps'), 'doc', 'wps 归文档');
  assertEqual(shared.typeOf('f.bin'), 'other', '未登记后缀仍是 other');

  // 一个扩展名只能属于一类（多归会让「图片」和「可执行文件」同时算上它）
  const all = [...body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)]
    .flatMap((x) => x[2].match(/'([a-z0-9]+)'/g).map((s) => s.replace(/'/g, '')));
  const dup = all.filter((e, i) => all.indexOf(e) !== i);
  assertEqual(dup.length, 0, `同一扩展名不得出现在两类里，重复项：${dup.join(',')}`);
});

test('R44 · 前端不另存后缀表：分类一律读服务端给的 item.type', () => {
  const util = readSrc('public', 'js', 'util.js');
  const ft = readSrc('public', 'js', 'filetype.js');

  // 不该出现"扩展名 → 类型"的表：形如 ['jpg','png',...] 的数组字面量
  for (const [name, src] of [['util.js', util], ['filetype.js', ft]]) {
    assert(!/\[\s*'jpe?g'\s*,/.test(src),
      `${name} 里不得出现图片后缀数组 —— 分类表只有 server/routes/_shared.js 一份，`
      + '前端再存一份必然漂移（侧栏数得到、搜索却说没有）');
    assert(!/\[\s*'mp4'\s*,/.test(src), `${name} 里不得出现视频后缀数组（同因）`);
  }
  assert(/item\.type/.test(util), 'util.js 必须按 item.type 取图标');
  assert(/TYPE_EXT/.test(readSrc('server', 'routes', '_shared.js')),
    '分类表的权威落点仍是服务端的 TYPE_EXT');
});

/* ================================================================== *
 * ③ 精灵图：JS 引用 ↔ index.html 符号的双向覆盖
 * ================================================================== */

test('R44 · 精灵图双向覆盖：JS 引用的每个 fic-* 都有 <symbol>，每个 <symbol> 也都被引用', () => {
  const html = readSrc('public', 'index.html');

  assert(/<svg id="icon-sprite"[^>]*>/.test(html), 'index.html 必须有 <svg id="icon-sprite"> 承载符号');
  assert(/<svg id="icon-sprite"[\s\S]{0,80}width="0"[\s\S]{0,40}height="0"/.test(html),
    '精灵图必须零尺寸 —— 否则会在页面顶部留下一个 1024px 的空白块');

  const spriteBlock = /<svg id="icon-sprite"[\s\S]*?<\/svg>/.exec(html);
  assert(spriteBlock, '必须能定位到精灵图块');
  const defined = new Set([...spriteBlock[0].matchAll(/<symbol\s+id="(fic-[a-z]+)"/g)].map((m) => m[1]));
  assert(defined.size > 0, '精灵图里必须至少有一个 <symbol>');

  const jsFiles = fs.readdirSync(JS()).filter((f) => f.endsWith('.js'));
  const used = new Set();
  for (const f of jsFiles) {
    for (const m of readSrc('public', 'js', f).matchAll(/fic-[a-z]+/g)) used.add(m[0]);
  }

  const missing = [...used].filter((id) => !defined.has(id)).sort();
  assertEqual(missing.length, 0,
    `JS 引用了精灵图里不存在的图标：${missing.join(', ')} —— `
    + '`<use href="#不存在">` 在浏览器里**静默渲染成空白**，不报错、控制台也不提示，'
    + '只能靠这条断言兜住');

  const unused = [...defined].filter((id) => !used.has(id)).sort();
  assertEqual(unused.length, 0,
    `精灵图里定义了但没有任何 JS 引用的图标：${unused.join(', ')} —— 死图标会让包体膨胀，且一旦改名往往只改一处`);

  // 每个符号的画布与归一化变换
  const symbols = [...spriteBlock[0].matchAll(/<symbol\s+id="(fic-[a-z]+)"\s+viewBox="([^"]+)"\s*>([\s\S]*?)<\/symbol>/g)];
  assertEqual(symbols.length, defined.size,
    '每个 <symbol> 都必须带 viewBox 且能被解析（缺 viewBox = 图形按 100% 缩放，大小乱掉）');
  for (const [, id, vb, inner] of symbols) {
    assertEqual(vb.replace(/\s+/g, ' ').trim(), '0 0 1024 1024',
      `${id} 的 viewBox 必须是 1024 画布（归一化的落点）`);

    if (id === 'fic-folder') {
      // 文件夹用 ico.txt 给定的三色文件夹图形（无卡片底色），但仍须归一化
      assert(/<g transform="translate\(33\.231 33\.231\) scale\(0\.935\)">/.test(inner),
        'fic-folder 必须带按视觉包围盒算出的 translate/scale（ico.txt 的文件夹画布与 1024 不同，'
        + '照搬会明显偏小或出框）');
      continue;
    }

    // 「全部」不是 ico.txt 里的文件类型，是本轮自绘的中性标记：图形直接画在 1024 画布上
    if (id === 'fic-all') {
      assert(/<rect x="0" y="0" width="1024" height="1024" rx="200" fill="#8a94a6"\/>/.test(inner),
        'fic-all 必须同样带一枚全幅圆角底色块（与其它类型视觉同源）');
      const rects = [...inner.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)];
      const innerRects = rects.filter((r) => r[3] !== '1024');
      assertEqual(innerRects.length, 4, 'fic-all 的四宫格应为 4 个方块');
      for (const r of innerRects) {
        const x = +r[1]; const y = +r[2];
        const right = x + +r[3]; const bottom = y + +r[4];
        assert(x >= 152 && y >= 152 && right <= 872 && bottom <= 872,
          `fic-all 的方块 ${x},${y} 超出归一化视框 [152,872] —— 与其它类型同框才叫「视觉一致」（需求③）`);
      }
      continue;
    }

    assert(/<rect x="0" y="0" width="1024" height="1024" rx="200" fill="#[0-9a-fA-F]{6}"\/>/.test(inner),
      `${id} 必须自带一枚全幅圆角底色块（需求①：各类型有规定的背景色；`
      + '底色烘进符号里，这样「底色 + 图形」只有一个落点）');
    const t = /<g transform="translate\(([-\d. ]+)\) scale\(([\d.]+)\)">/.exec(inner);
    assert(t, `${id} 必须把图形缩放到统一视框（需求③：视觉一致）—— `
      + '变换由离线按视觉包围盒算出，漏掉就会大小不齐');
    const s = Number(t[2]);
    assert(s > 0.6 && s < 1.05,
      `${id} 的缩放应为「图形最长边铺满 720/1024」量级（实测各图标 0.70~0.99），实际 ${s}`);
  }

  // 底色取值与 ico.txt 给定的一致（逐个钉死，避免"看起来差不多"就改了）
  const wantBg = {
    'fic-image': '#00a672', 'fic-video': '#eb4847', 'fic-doc': '#3f6dcb',
    'fic-audio': '#8868c5', 'fic-archive': '#ff8e50',
    'fic-exe': '#62d8b6', 'fic-apk': '#62d8b6', 'fic-ipa': '#62d8b6', 'fic-hpkg': '#62d8b6',
  };
  for (const [id, color] of Object.entries(wantBg)) {
    const sym = symbols.find((s) => s[1] === id);
    assert(sym, `精灵图应有 ${id}`);
    assert(new RegExp(`fill="${color}"`, 'i').test(sym[3]),
      `${id} 的底色应为 ${color}（ico.txt 规定的背景色），实际渲染片段里找不到`);
  }
});

test('R44 · 侧栏容器已换：index.html 里没有 #tree，只有 #filetype', () => {
  const html = readSrc('public', 'index.html');
  assert(!/id="tree"/.test(html), 'index.html 不得再保留「文件夹导航」容器 #tree');
  assert(/<nav id="filetype" class="filetype"/.test(html), 'index.html 必须有 <nav id="filetype"> 作为文件类型筛选的落点');
  assert(/文件类型筛选/.test(html), '容器应带 title 说明用途（可发现性）');

  const css = readSrc('public', 'css', 'style.css');
  assert(/\.filetype\s*\{/.test(css), 'CSS 必须有 .filetype 规则');
  assert(/\.ft-row\s*\{/.test(css), 'CSS 必须有 .ft-row 规则');
  assert(/\.ft-row\.active\s*\{/.test(css), '当前选中的类型必须有高亮样式（否则用户不知道正在筛什么）');
  // 移动对话框仍在用这套类名，不能被顺手删掉
  assert(/\.tree-row\s*\{/.test(css) && /\.tree-kids\s*\{/.test(css),
    '.tree-row / .tree-kids 仍被「移动到…」的文件夹选择器复用，不得删除');
});

/* ================================================================== *
 * ④ 移除文件夹导航：模块与调用点
 * ================================================================== */

test('R44 · tree.js 已删除，且没有任何残留在引用它', () => {
  assert(!fs.existsSync(JS('tree.js')), 'public/js/tree.js 必须已删除');

  const files = [
    ...fs.readdirSync(JS()).map((f) => ['public/js/' + f, readSrc('public', 'js', f)]),
    ['public/index.html', readSrc('public', 'index.html')],
    ['public/css/style.css', readSrc('public', 'css', 'style.css')],
  ];
  for (const [name, src] of files) {
    assert(!/tree\.js/.test(src), `${name} 仍引用了已删除的 tree.js`);
    assert(!/\btree\.init\s*\(/.test(src), `${name} 仍在调用 tree.init()`);
    assert(!/refreshTree/.test(src), `${name} 仍残留 refreshTree（ops.js 的旧调用点）`);
    assert(!/renderTreeActive/.test(src), `${name} 仍残留 renderTreeActive（explorer.js 的旧高亮）`);
  }
});

test('R44 · filetype.js 是侧栏唯一渲染点，且只做「把点击翻译成筛选值」', () => {
  const ft = readSrc('public', 'js', 'filetype.js');
  const main = readSrc('public', 'js', 'main.js');
  const exp = readSrc('public', 'js', 'explorer.js');

  assert(/import \{ explorer \} from '\.\/explorer\.js'/.test(ft), 'filetype.js 应只依赖 explorer 与 util');
  assert(/import \{ FILE_TYPES \} from '\.\/util\.js'/.test(ft), 'filetype.js 的类型清单必须来自 util.js');
  assert(/explorer\.setTypeFilter\(/.test(ft), 'filetype.js 必须调用 explorer.setTypeFilter（唯一生效路径）');
  assert(!/filter\(/.test(ft.replace(/\/\*[\s\S]*?\*\//g, '')),
    'filetype.js 不得自己过滤列表 —— 过滤只有 explorer.visibleItems() 一份实现，'
    + '两边各写一套迟早不一致（例如一处忘了排除文件夹）');
  assert(/explorer\.allItems\(\)/.test(ft), '侧栏计数应取 explorer.allItems()，而不是另存一份列表');

  assert(/import \{ filetype \} from '\.\/filetype\.js'/.test(main), 'main.js 必须导入 filetype');
  assert(!/import \{ tree \}/.test(main), 'main.js 不得再导入 tree');
  const inits = (main.match(/filetype\.init\(\);/g) || []).length;
  assertEqual(inits, 5, `登录 / 换桶 / 初始化等 5 个入口都要重建侧栏，实际 ${inits} 处`);

  // 筛选状态必须有初值，且换账号 / 重置主视图时要清掉
  // （否则新账号一进来就停在上一账号的筛选上，目录看着像空的）
  assertEqual((main.match(/typeFilter/g) || []).length, 2,
    'main.js 里应恰有 2 处 typeFilter：初始值 + resetMainView 的重置');
  assert(/typeFilter: ''/.test(main), 'App.state 必须给 typeFilter 一个空串初值（undefined 会被当成"筛选了某个类型"）');
  const reset = /function resetMainView\(\)[\s\S]*?\n\}/.exec(main);
  assert(reset, '必须能定位 resetMainView');
  assert(/App\.state\.typeFilter = '';/.test(reset[0]),
    'resetMainView 必须清掉筛选值 —— 它正是换账号 / 换桶时丢弃上一会话上下文的落点');
});

/* ================================================================== *
 * ⑤ 过滤行为（沙箱：真实 explorer.js + 真实 util.js）
 * ================================================================== */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r44-sandbox-'));
let sandboxSeq = 0;

/**
 * 假 DOM（与 audit33 / audit35 / audit36 同源）。
 *
 * ⚠️ 与那几份一样：`getElementById` 对任何 id 都会凭空造元素，所以
 *    「按钮到底有没有渲染出来」只能断言在 **innerHTML 字符串**上，
 *    不能断言 `getElementById('eh-clear-type')` 非空。
 */
function installFakeDom() {
  const byId = new Map();
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  const parseAttrs = (s) => {
    const out = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2];
    return out;
  };
  const mk = (id) => {
    const el = {
      id, hidden: false, _html: '', textContent: '', value: '', disabled: false,
      style: {}, dataset: {}, className: '', attrs: {}, _kids: new Map(),
      scrollTop: 0, clientHeight: 0, scrollHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; },
      querySelector(sel) {
        if (!el._kids.has(sel)) el._kids.set(sel, mk('kid:' + sel));
        return el._kids.get(sel);
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, remove() {}, focus() {}, click() {},
      get innerHTML() { return el._html; },
      set innerHTML(v) {
        el._html = String(v);
        const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
        let m;
        while ((m = tagRe.exec(el._html))) {
          const attrs = parseAttrs(m[2]);
          if (attrs.id) {
            const e2 = byId.get(attrs.id) || mk(attrs.id);
            e2.attrs = attrs;
            byId.set(attrs.id, e2);
          }
        }
      },
    };
    return el;
  };

  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mk(id)); return byId.get(id); },
    createElement: () => mk('created'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  return { byId, get: (id) => globalThis.document.getElementById(id) };
}

/** 目录里的固定内容：一个文件夹 + 2 图片 + 1 视频 + 1 压缩包 + 1 可执行文件 */
const FIXTURE = {
  prefixes: [{ prefix: 'docs/', name: 'docs' }],
  contents: [
    { key: 'a.jpg', name: 'a.jpg', size: 100, lastModified: '2026-01-02T00:00:00.000Z', etag: 'e1', isFolder: false, type: 'image' },
    { key: 'b.png', name: 'b.png', size: 200, lastModified: '2026-01-03T00:00:00.000Z', etag: 'e2', isFolder: false, type: 'image' },
    { key: 'c.mp4', name: 'c.mp4', size: 300, lastModified: '2026-01-04T00:00:00.000Z', etag: 'e3', isFolder: false, type: 'video' },
    { key: 'd.zip', name: 'd.zip', size: 400, lastModified: '2026-01-05T00:00:00.000Z', etag: 'e4', isFolder: false, type: 'archive' },
    { key: 'setup.exe', name: 'setup.exe', size: 500, lastModified: '2026-01-06T00:00:00.000Z', etag: 'e5', isFolder: false, type: 'exec' },
  ],
  nextMarker: '',
  isTruncated: false,
};

/**
 * 搭一套「真实 explorer.js + 真实 util.js + 桩依赖」的模块图。
 * 一律 copy 真实文件（而不是在测试里重写一份）—— 否则测到的是测试自己的副本（R30 的教训）。
 */
async function loadExplorer() {
  sandboxSeq += 1;
  const dir = path.join(TMP, 'run' + sandboxSeq);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(JS('explorer.js'), path.join(dir, 'explorer.js'));
  fs.copyFileSync(JS('util.js'), path.join(dir, 'util.js'));
  fs.writeFileSync(path.join(dir, 'api.js'), `
export const API = {
  list: async () => globalThis.__fixture,
  search: async () => ({ matches: [], scanned: 0, cursor: '' }),
  tree: async () => ({ folders: [] }),
  stat: async () => ({}),
  thumbUrl: (k) => '/thumb/' + k,
};
`);
  fs.writeFileSync(path.join(dir, 'main.js'), `
export const App = {
  state: {
    prefix: '', view: 'list', typeFilter: '',
    sort: { key: 'name', dir: 'asc' },
    columns: ['name', 'size', 'type', 'modified'],
    selection: new Set(),
    bucket: 'demo', bucketDisplay: 'demo', user: { role: 'admin' },
  },
  updateStatusbar: () => { globalThis.__statusbar = (globalThis.__statusbar || 0) + 1; },
  updateNavButtons() {}, backToExplorer() {},
};
`);
  fs.writeFileSync(path.join(dir, 'upload.js'), `export const uploadMgr = { enqueue() {} };`);
  fs.writeFileSync(path.join(dir, 'ops.js'), `
export const ops = {
  needConfig: () => false, newFolder() {}, renameSelected() {}, moveSelected() {},
  deleteSelected() {}, downloadSelected() {}, copyLinkKeys() {}, moveKeysTo() {},
  deleteKeys() {}, downloadKeys() {},
};
`);
  fs.writeFileSync(path.join(dir, 'enc.js'), `export const openDownload = () => {};`);

  globalThis.__fixture = FIXTURE;
  const dom = installFakeDom();
  const m = await import(pathToFileURL(path.join(dir, 'explorer.js')).href + '?n=' + sandboxSeq);
  m.explorer.init();
  await m.explorer.refresh({ silent: true });
  return { explorer: m.explorer, dom };
}

test('R44 · visibleItems()：「全部」含文件夹，选中具体类型时文件夹被隐藏', async () => {
  const { explorer } = await loadExplorer();

  assertEqual(explorer.allItems().length, 6, '当前目录共 6 项（1 文件夹 + 5 文件）');

  const all = explorer.visibleItems();
  assertEqual(all.length, 6, '「全部」= 不筛选，文件夹必须在列');
  assert(all.some((i) => i.isFolder), '「全部」下文件夹要显示（用户还得靠它进子目录）');

  explorer.setTypeFilter('image');
  const imgs = explorer.visibleItems();
  assertEqual(imgs.length, 2, '图片应为 2 个');
  assertEqual(imgs.map((i) => i.key).join(','), 'a.jpg,b.png', '只应留下图片');
  assert(!imgs.some((i) => i.isFolder),
    '选中具体类型时**不得**显示文件夹 —— 文件夹不属于任何文件类型，'
    + '混在里面会让「筛选后还剩几条」这个数字对不上，也不符合本轮确认的口径');

  explorer.setTypeFilter('exec');
  assertEqual(explorer.visibleItems().map((i) => i.key).join(','), 'setup.exe', '可执行文件筛选应命中 exe');

  explorer.setTypeFilter('audio');
  assertEqual(explorer.visibleItems().length, 0, '本目录没有音频 → 空');

  explorer.setTypeFilter('');
  assertEqual(explorer.visibleItems().length, 6, '清空筛选要恢复全部（含文件夹）');
  assertEqual(explorer.currentTypeFilter(), '', '清空后状态必须是空串（不是 undefined）');
});

test('R44 · 渲染只看可见集：筛选后列表里不出现被隐藏的类型，且空结果给的是「可退回」的提示', async () => {
  const { explorer, dom } = await loadExplorer();
  const area = dom.get('file-area');
  const empty = dom.get('empty-hint');

  explorer.setTypeFilter('image');
  assertEqual((area.innerHTML.match(/<tr /g) || []).length, 2, '列表行数应等于可见集大小（而不是整个目录）');
  assert(/use href="#fic-image"/.test(area.innerHTML), '图片行必须用图片图标');
  assert(!/use href="#fic-folder"/.test(area.innerHTML), '筛选图片时不得出现文件夹行');
  assert(!/use href="#fic-archive"/.test(area.innerHTML), '筛选图片时不得出现压缩包行');

  // 渲染进 HTML 的是图标，不是旧的后缀文字角标
  assert(!/class="badge/.test(area.innerHTML), '不得再输出文字徽标');

  // 滤空：必须说清是「类型过滤」而不是「目录为空」，并给一键退回
  explorer.setTypeFilter('audio');
  assert(/没有/.test(empty.innerHTML) && /音频/.test(empty.innerHTML),
    '滤空提示必须指明是哪个类型 —— 显示「此文件夹为空」会让用户以为文件丢了');
  assert(/id="eh-clear-type"/.test(empty.innerHTML), '必须提供「显示全部文件」按钮（否则用户只能自己去找侧栏）');

  // 目录真的为空时，文案仍是原来那句，不能与被滤空混淆
  explorer.setTypeFilter('');
  globalThis.__fixture = { prefixes: [], contents: [], nextMarker: '', isTruncated: false };
  await explorer.refresh({ silent: true });
  assert(!/没有/.test(empty.innerHTML) || /空的|为空/.test(empty.innerHTML),
    '目录本身为空时仍用「此文件夹为空」口径，不得套用类型过滤那套文案');
  globalThis.__fixture = FIXTURE;
});

test('R44 · setTypeFilter / selectAll：绝不把「看不见的项」留在选中集里', async () => {
  const { explorer } = await loadExplorer();
  const App = (await import(pathToFileURL(path.join(TMP, 'run' + sandboxSeq, 'main.js')).href)).App;

  // 选中文件夹 + 一个图片，然后筛图片 → 文件夹必须被剔除
  App.state.selection = new Set(['docs/', 'a.jpg']);
  explorer.setTypeFilter('image');
  assertEqual([...App.state.selection].join(','), 'a.jpg',
    '筛选后被隐藏的项必须立刻退出选中集 —— 否则随后的下载 / 删除会作用到用户看不见的对象上');

  // 全选只覆盖当前可见项
  explorer.setTypeFilter('image');
  explorer.selectAll();
  assertEqual([...App.state.selection].sort().join(','), 'a.jpg,b.png',
    '「全选」只应选中当前可见的 2 张图片；把隐藏的文件夹也选上会导致误删');

  explorer.setTypeFilter('video');
  explorer.selectAll();
  assertEqual([...App.state.selection].join(','), 'c.mp4', '换类型后全选要重算，不得叠加旧选中集');
});

test('R44 · 源码不变量：渲染 / 连选 / 拖拽落点 / 全选都只用 state.visible', () => {
  const src = readSrc('public', 'js', 'explorer.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert(/state\.visible\s*=\s*visibleItems\(\)/.test(code), 'render() 必须先把 visibleItems() 的结果落到 state.visible');
  assertEqual((code.match(/state\.visible\.map\(/g) || []).length, 4,
    'render 的 renderedKeys、selectAll、renderList、renderGrid 四处都应按 state.visible 迭代'
    + '（重新渲染时按 state.items 记 renderedKeys，会让"是否已渲染"的判断永远为真）');
  assertEqual((code.match(/state\.visible\[/g) || []).length, 4,
    'shift 连选、拖拽落点等按下标取项的地方必须用 state.visible —— '
    + '用 state.items 会让下标与渲染出来的行错位，拖错文件');
  assert(/App\.state\.selection = new Set\(state\.visible\.map/.test(code),
    'selectAll 必须基于 state.visible');
  assert(!/App\.state\.selection = new Set\(state\.items/.test(code), 'selectAll 不得基于 state.items');
  assertEqual((code.match(/function visibleItems\(\)/g) || []).length, 1,
    '过滤规则只允许一份实现；`function visibleItems(` 在同一文件里多次出现 = 有人又抄了一份');
  assert(/!i\.isFolder && i\.type === t/.test(code),
    '具体类型的判据必须同时要求「不是文件夹」与「类型相符」—— 少了前一半会把文件夹混进每个筛选结果');
  assert(/if \(!t\) return state\.items;/.test(code), '「全部」必须原样返回 state.items（含文件夹）');

  // 过滤状态只有一个落点
  assertEqual((code.match(/App\.state\.typeFilter\s*=/g) || []).length, 1,
    'typeFilter 的写入口只允许 setTypeFilter 一处（多一处就会出现两套真相）');

  // ⚠️ 本轮实测踩到的事故：`setTypeFilter` 里写成了裸 `render()` —— `render` 是
  // `explorer` 对象的方法，模块作用域里没有这个自由标识符，于是每次点击类型都抛
  // ReferenceError，表现为「点了完全没反应」且控制台之外毫无痕迹
  // （与 R27-01 的裸 `currentItems()` 完全同类）。这里按"调用点形态"钉死。
  assert(/explorer\.render\(\);/.test(code), 'setTypeFilter 必须通过 explorer.render() 重绘');
  assert(!/(^|[^.\w])render\(\s*\)\s*;/m.test(code),
    'explorer.js 里不得出现裸 `render();` 调用 —— render / loadMore / navigate 等都是本对象的'
    + '方法，不是模块内的自由标识符；漏了 `explorer.` 前缀会在运行期抛 ReferenceError，'
    + '而静态看代码完全正常');
});
