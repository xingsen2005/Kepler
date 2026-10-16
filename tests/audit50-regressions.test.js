/**
 * 第 50 轮护栏 —— 三件事（① 分享页文件类型图标 ② 左键框选多选 ③ 「链接创建成功」页改版）
 *
 * 需求原文：
 *  1. 「文件分享页的文件图标还是默认的，我们之前已经制作了 SVG 内联图标，
 *      把文件分享页的默认图标修改为对应的文件图标」；
 *  2. 「支持左键框选多选文件」；
 *  4. 「分享链接的『链接创建成功』页……改为：使用 div 展示链接，添加一个『复制』按钮，
 *      展示文件的文件名、链接创建时间、过期时间、价格、允许下载次数，再添加一个链接的
 *      二维码（尽量 0 依赖实现）」。
 * （第 3 项「多文件 / 文件夹分享」按用户确认挪到下一轮，本轮**刻意不动**分享的数据模型。）
 *
 * ## 断言分四层，每层都要有，缺一层就留一种假绿
 *
 *  ① **纯函数层**（真实 `server/file-icons.js`）：内联出来的必须是图形**本身**
 *     （不能带 `<use>`）、必须命中该文件的类型、雪碧读不到时要如实回空串。
 *  ② **跨端一致层**：服务端选图标的那条规则必须与前端 `util.js` 的 `iconIdOf()`
 *     **逐项等值** —— 否则同一个文件在文件列表里与分享页上会显示不同图标，
 *     而两处各自的单测都是绿的。
 *  ③ **真发 HTTP 层**（真实 `share-routes.js` + 真实 express）：`GET /s/:id` 吐出的
 *     HTML 里内联的是**该类型符号的图形内容**，且**不再出现** `📄`。
 *     只断言「源码里调用了 inlineSvg」挡不住「传错了参数 / 属性名写错」。
 *  ④ **沙箱行为层**（真实 `explorer.js` / `ops.js` + 假 DOM）：框选真的选中了
 *     被框住的那些行；「链接创建成功」弹窗真的把链接、五项信息、二维码都渲染出来。
 *     这一层最要紧：本项目的多次教训都是「助手函数写对了、真接线处没用它」。
 *
 * ⚠️ 分享页是**服务端渲染**的独立文档，没有 `index.html` 那套雪碧 ——
 *    所以图标必须内联（`<use>` 在那里只会画出一片空白，且不报错）。
 *    这条由用例 3 的「不得出现 `<use>`」钉住。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('s3-r50-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const fileIcons = require(SERVER('file-icons.js'));
const shareStore = require(SERVER('share-store.js'));
const shareRoutes = require(SERVER('share-routes.js'));
const linkRoutes = require(SERVER('routes', 'links.js'));
const secureStore = require(SERVER('secure-store.js'));
const { typeOf } = require(SERVER('routes', '_shared.js'));
const qrcode = require(SERVER('qrcode.js'));

test.after(async () => {
  // links.json 走异步去抖写：不刷干就在目录删掉之后落地，只留下 ENOENT 噪声
  await cleanupTempDir(tmp.dir, {
    flushers: [{ name: 'secure-store', flush: () => secureStore.flush() }],
  });
});

/* ================================================================== *
 * 公共工具
 * ================================================================== */

/** 独立实现一份「从 index.html 取符号内容」的解析（尽量不与被测实现同源） */
function symbolInnerFromIndex(id) {
  const html = fs.readFileSync(PUBLIC('index.html'), 'utf8');
  const m = new RegExp(`<symbol\\s+id="${id}"[^>]*>([\\s\\S]*?)</symbol>`).exec(html);
  return m ? m[1] : null;
}

const httpGet = (port, p) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  }).on('error', (e) => resolve({ status: 0, body: String(e) }));
});

async function serve(mount, prefix, { auth = null } = {}) {
  const app = express();
  app.use(express.json());
  if (auth) app.use((req, _res, next) => { req.authUser = auth; next(); });
  if (prefix) app.use(prefix, mount); else app.use(mount);
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { server: s, port: s.address().port };
}

/* ================================================================== *
 * ① 纯函数层：file-icons.js
 * ================================================================== */

test('R50-1 · file-icons：内联的是图形本身（不得是 <use> 引用），并按类型命中', () => {
  const cases = [
    ['photo.JPG', 'fic-image'], ['movie.mkv', 'fic-video'], ['song.flac', 'fic-audio'],
    ['report.pdf', 'fic-doc'], ['pkg.zip', 'fic-archive'], ['setup.exe', 'fic-exe'],
    ['app.apk', 'fic-apk'], ['app.ipa', 'fic-ipa'], ['pkg.hpkg', 'fic-hpkg'],
    ['README', 'fic-other'], ['notes.unknownext', 'fic-other'], ['docs/', 'fic-folder'],
  ];
  assert(cases.length >= 12, '样本表不得被削减（它是本组断言的覆盖面）');
  for (const [name, want] of cases) {
    assertEqual(fileIcons.iconIdFor(name), want, `${name} 应命中 ${want}`);
    const svg = fileIcons.inlineSvg(name, { size: 56, cls: 'file-icon' });
    assert(svg.length > 0, `${name} 应能内联出 SVG`);
    /**
     * ⚠️ 本条是本轮最要紧的一条：分享页没有雪碧，`<use href="#fic-x">` 在那里
     * 只会画出一片空白，而且**浏览器不报错、控制台也干干净净**。
     * 所以「内联」必须是真内联 —— 断言它含有该符号的图形内容、且不含 `<use`。
     */
    assert(!svg.includes('<use'), `${name} 必须真内联（不得用 <use> 引用雪碧）`);
    const inner = symbolInnerFromIndex(want);
    assert(inner, `index.html 里应有 #${want} 符号`);
    assert(svg.includes(inner.slice(0, 60)), `${name} 内联的应是 #${want} 的图形内容`);
    assert(svg.includes('viewBox="0 0 1024 1024"'), `${name} 应保留雪碧的 viewBox`);
    assert(svg.includes('width="56"') && svg.includes('height="56"'), `${name} 应带上尺寸`);
  }
});

test('R50-1 · file-icons：雪碧整体不可用时如实回空串（调用方才能降级），且不留残缺 SVG', () => {
  try {
    fileIcons.__setSource(() => '');
    assertEqual(fileIcons.inlineSvg('a.jpg'), '', '没有雪碧时必须回空串，而不是拼一个空 <svg>');
    assertEqual(fileIcons.iconIdFor('a.jpg'), '', '锁内不可用时 iconIdFor 也应回空串');
  } finally {
    fileIcons.__setSource(null);
  }
  // 恢复后必须回到正常（证明上面的注入没有污染缓存）
  assertEqual(fileIcons.iconIdFor('a.jpg'), 'fic-image', '恢复取数后应重新命中真实雪碧');
});

test('R50-1 · file-icons：缺某个符号时按「同类型 → 中性图」逐级降级，绝不返回不存在的 id', () => {
  try {
    // 只有一个 fic-other：图片图标缺失 → 应落到中性图，而不是回一个不存在的 fic-image
    fileIcons.__setSource(() => '<symbol id="fic-other" viewBox="0 0 1024 1024"><rect/></symbol>');
    assertEqual(fileIcons.iconIdFor('a.jpg'), 'fic-other', '缺 fic-image 时应落到 fic-other');
    assertEqual(fileIcons.iconIdFor('a.exe'), 'fic-other', 'exec 的专属图缺失时也应落到 fic-other');
    // 只剩一个与本次查询毫不相干的符号 → 必须回空串，而不是回一个拼错的 id
    fileIcons.__setSource(() => '<symbol id="fic-folder" viewBox="0 0 1024 1024"><rect/></symbol>');
    assertEqual(fileIcons.iconIdFor('a.exe'), '', '既没有专属图也没有中性图时回空串');
    assertEqual(fileIcons.iconIdFor('a.jpg'), '', '同理，图片也回空串让调用方降级');
  } finally {
    fileIcons.__setSource(null);
  }
  // 全量反查：本模块能选出的每个 id 都必须在真实雪碧里存在（防拼错）
  const all = fileIcons.symbolIds();
  assert(all.length >= 12, `雪碧符号数应 ≥ 12，实际 ${all.length}`);
  for (const id of all) assert(/^fic-[a-z0-9-]+$/.test(id), `符号 id 形状可疑：${id}`);
  assert(fs.readFileSync(PUBLIC('index.html'), 'utf8').includes('<svg id="icon-sprite"'),
    '雪碧容器 #icon-sprite 必须还在 index.html 里');
});

/* ================================================================== *
 * ② 跨端一致层：服务端 iconIdFor ≡ 前端 iconIdOf
 * ================================================================== */

test('R50-1 · 服务端与前端选图标的规则必须逐项等值（否则同一个文件两处显示不同图标）', async () => {
  const util = await import(pathToFileURL(JS('util.js')).href);
  // 覆盖每个类型 + exec 的各系统细分 + 无扩展名 + 未知扩展名 + 目录
  const names = [
    'a.jpg', 'b.png', 'c.svg', 'd.mp4', 'e.mkv', 'f.mp3', 'g.flac',
    'h.pdf', 'i.docx', 'j.json', 'k.zip', 'l.iso', 'm.tar',
    'n.exe', 'o.msi', 'p.com', 'q.apk', 'r.ipa', 's.hpkg',
    'README', 'unknown.zzz', 'docs/',
  ];
  assert(names.length >= 20, '样本表不得被削减');
  const diffs = [];
  for (const n of names) {
    const isFolder = n.endsWith('/');
    const type = isFolder ? 'folder' : typeOf(n);
    const fe = util.iconIdOf({ isFolder, type, name: n });
    const be = fileIcons.iconIdFor(n);
    if (fe !== be) diffs.push(`${n}（前端 ${fe} / 服务端 ${be}）`);
  }
  assertEqual(diffs.length, 0,
    '前后端选图标的规则已漂移，同一个文件在文件列表与分享页会显示不同图标：' + diffs.join('、'));
});

/* ================================================================== *
 * ③ 真发 HTTP 层：分享页
 * ================================================================== */

test('R50-1 · 分享页 GET /s/:id：内联该文件类型的图标，且不再出现默认的 📄', async () => {
  const { server, port } = await serve(shareRoutes, '');
  try {
    const cases = [
      ['a.jpg', 'fic-image'], ['a.mkv', 'fic-video'], ['a.pdf', 'fic-doc'],
      ['a.zip', 'fic-archive'], ['a.exe', 'fic-exe'], ['a.hpkg', 'fic-hpkg'],
      ['noext', 'fic-other'],
    ];
    for (const [name, want] of cases) {
      const link = await shareStore.create({
        key: name, bucket: 'r50-bucket', region: 'ap-guangzhou', fileName: name, size: 1024,
      });
      const r = await httpGet(port, '/s/' + link.id);
      assertEqual(r.status, 200, `${name} 的分享页应 200`);
      assert(r.body.includes('<svg class="file-icon"'), `${name} 的分享页应内联 .file-icon`);
      assert(!r.body.includes('<use'), `${name} 的分享页不得出现 <use>（那里没有雪碧）`);
      const inner = symbolInnerFromIndex(want);
      assert(r.body.includes(inner.slice(0, 60)),
        `${name} 的分享页应内联 #${want} 的图形，而不是别的类型或默认图标`);
      assert(!r.body.includes('📄'), `${name} 的分享页不应再出现写死的 📄 默认图标`);
    }
  } finally {
    server.close();
  }
});

test('R50-1 · 雪碧读不到时分享页仍要能打开（降级回 📄，而不是 500）', async () => {
  const { server, port } = await serve(shareRoutes, '');
  try {
    const link = await shareStore.create({
      key: 'fallback.jpg', bucket: 'r50-bucket', region: 'ap-guangzhou', fileName: 'fallback.jpg', size: 10,
    });
    fileIcons.__setSource(() => { throw new Error('模拟雪碧文件缺失'); });
    const r = await httpGet(port, '/s/' + link.id);
    assertEqual(r.status, 200, '一枚图标读不到，不能把一张公开页面打挂');
    assert(!r.body.includes('<svg class="file-icon"'), '此时不应有内联图标');
    assert(r.body.includes('📄'), '应降级回原来的 emoji 图标（页面信息一个不少）');
    assert(r.body.includes('fallback.jpg'), '文件名仍要照常展示');
  } finally {
    fileIcons.__setSource(null);
    server.close();
  }
});

/* ================================================================== *
 * ⑤ 二维码路由（第 4 项的实现基础）
 * ================================================================== */

test('R50-4 · GET /links/qrcode：回 { svg }，且容量边界如实拒绝（不渲染空方块）', async () => {
  const { server, port } = await serve(linkRoutes, '/api', { auth: { username: 'r50', role: 'admin' } });
  try {
    const url = 'https://pan.example.com/s/' + 'A'.repeat(22);
    const ok = await httpGet(port, '/api/links/qrcode?text=' + encodeURIComponent(url));
    assertEqual(ok.status, 200, '正常分享链接应能生成');
    const obj = JSON.parse(ok.body);
    assert(obj.svg && obj.svg.startsWith('<svg'), '应回 SVG 字符串');
    assert(obj.svg.includes('<rect'), 'SVG 里应有码点矩形');
    // 与支付二维码用的是同一个实现（同参不同参都行，但必须是这条路生成的）
    assertEqual(obj.svg, qrcode.toSvg(url, { scale: 6, margin: 3 }),
      '必须复用 server/qrcode.js（不得另引二维码库）');

    /**
     * 容量边界：qrcode.js 止于版本 10（约 213 字节）。
     * 超限时**必须 400 并说明原因** —— 回一个空 `svg` 会让弹窗里出现一块
     * 空白方块，用户对着它扫码只会以为是自己手机的问题。
     */
    const max = 213;
    const edgeIn = await httpGet(port, '/api/links/qrcode?text=' + encodeURIComponent('x'.repeat(max)));
    assertEqual(edgeIn.status, 200, `${max} 字节应仍可编码`);
    const edgeOut = await httpGet(port, '/api/links/qrcode?text=' + encodeURIComponent('x'.repeat(max + 1)));
    assertEqual(edgeOut.status, 400, `${max + 1} 字节应超限`);
    const errOut = JSON.parse(edgeOut.body);
    assert(/内容过长/.test(errOut.error) && errOut.error.includes(String(max)),
      `错误文案应说明当前上限（实际：${errOut.error}）`);

    // 预签名直链（400+ 字节）必然超限 —— 这条是「如实告知」的现实形态
    const presign = 'https://b.cos.ap-guangzhou.myqcloud.com/a.zip?q-signature=' + 'f'.repeat(400);
    const rp = await httpGet(port, '/api/links/qrcode?text=' + encodeURIComponent(presign));
    assertEqual(rp.status, 400, '预签名直链超出容量，必须 400 而不是给一个坏二维码');

    const missing = await httpGet(port, '/api/links/qrcode');
    assertEqual(missing.status, 400, '缺 text 应 400');
  } finally {
    server.close();
  }
});

/* ================================================================== *
 * ④ 沙箱行为层公共设施
 * ================================================================== */

function mkTempSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r50-' + tag + '-'));
  return dir;
}

/**
 * 假 DOM。
 *
 * 与 audit44 的那份不同之处：这里的 `#file-area` 会返回**真的行对象**
 * （带 `dataset.key` 与 `getBoundingClientRect()`），因为框选的命中判据就落在
 * 「矩形相交」上 —— 若 `querySelectorAll` 永远返回空数组（audit44 那份就是），
 * 框选用例只会得到「一个都没选中」，而那是假绿而不是真绿。
 */
function installFakeDom({ rows = [] } = {}) {
  const byId = new Map();
  const docEvents = new Map();
  const created = [];

  function FakeNode() {}
  globalThis.Node = FakeNode;

  const mk = (label) => {
    const el = {
      _label: label, _html: '', textContent: '', value: '', checked: false,
      disabled: false, hidden: false, className: '', dataset: {}, attrs: {},
      style: {}, clientWidth: 0, clientHeight: 0, scrollTop: 0, scrollHeight: 0,
      offsetX: 0, offsetY: 0, _kids: new Map(), _ev: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) {
          const want = on === undefined ? !this._s.has(c) : Boolean(on);
          if (want) this._s.add(c); else this._s.delete(c);
        },
      },
      getAttribute(k) { return this.attrs[String(k)] === undefined ? null : this.attrs[String(k)]; },
      setAttribute(k, v) { this.attrs[String(k)] = String(v); },
      querySelector(sel) {
        if (!this._kids.has(sel)) this._kids.set(sel, mk(this._label + '>' + sel));
        return this._kids.get(sel);
      },
      querySelectorAll(sel) {
        if (sel === '[data-key]') return this._qsa ? this._qsa() : [];
        return [];
      },
      addEventListener(t, fn) { this._ev[t] = fn; },
      removeEventListener(t) { delete this._ev[t]; },
      appendChild(n) { this._kids.set('@' + (this._appended || 0), n); this._appended = (this._appended || 0) + 1; return n; },
      remove() { this._removed = true; },
      focus() {}, click() {}, select() {},
      getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
    };
    Object.setPrototypeOf(el, FakeNode.prototype);
    created.push(el);
    return el;
  };

  const rowsArr = rows.map((r) => {
    const row = mk('row:' + r.key);
    row.dataset = { key: r.key };
    row.getBoundingClientRect = () => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.right - r.left, height: r.bottom - r.top });
    return row;
  });

  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mk('#' + id)); return byId.get(id); },
    createElement: (tag) => mk('<' + tag + '>'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(t, fn) { docEvents.set(t, fn); },
    removeEventListener(t) { docEvents.delete(t); },
    execCommand: (cmd) => { globalThis.__execCommands.push(cmd); return true; },
    body: mk('body'),
  };
  const area = globalThis.document.getElementById('file-area');
  area._qsa = () => rowsArr;
  area.clientWidth = 400;
  area.clientHeight = 600;

  return { doc: globalThis.document, created, rows: rowsArr, docEvents, area,
    fireDoc: (t, e) => docEvents.has(t) && docEvents.get(t)(e),
    hasDoc: (t) => docEvents.has(t) };
}

/** 假的鼠标事件 */
function mouseEv(over) {
  return Object.assign({
    button: 0, ctrlKey: false, metaKey: false, shiftKey: false, key: '',
    clientX: 0, clientY: 0, offsetX: 5, offsetY: 5,
    target: { closest: () => null },
    preventDefault() { this._pd = true; }, stopPropagation() {},
  }, over || {});
}

/* ================================================================== *
 * ④-a 左键框选（真实 explorer.js + 假 DOM）
 * ================================================================== */

/**
 * 搭一套「真实 explorer.js + 真实 util.js + 桩依赖」的模块图。
 * 与 audit44 同法：一律 copy 真实文件，避免测到测试自己的副本。
 */
let feSeq = 0;
async function loadExplorer(rows) {
  feSeq += 1;
  const dir = mkTempSandbox('fe' + feSeq);
  fs.copyFileSync(JS('explorer.js'), path.join(dir, 'explorer.js'));
  fs.copyFileSync(JS('util.js'), path.join(dir, 'util.js'));
  fs.writeFileSync(path.join(dir, 'api.js'), 'export const API = { list: async () => ({}), thumbUrl: (k) => "/t/" + k };');
  fs.writeFileSync(path.join(dir, 'main.js'), `const selection = (globalThis.__r50Selection = new Set());
export const App = {
    state: { prefix: '', view: 'list', typeFilter: '', sort: { key: 'name', dir: 'asc' },
      columns: ['name'], selection, bucket: 'demo', bucketDisplay: 'demo', user: { role: 'admin' } },
    updateStatusbar() {}, updateNavButtons() {}, backToExplorer() {},
  };`);
  fs.writeFileSync(path.join(dir, 'upload.js'), 'export const uploadMgr = { enqueue() {} };');
  fs.writeFileSync(path.join(dir, 'ops.js'), 'export const ops = { copyLinkKeys() {} };');
  fs.writeFileSync(path.join(dir, 'enc.js'), 'export const openDownload = () => {};');
  const dom = installFakeDom({ rows });
  // 每次 import 都要带不同的 query，否则 ESM 缓存会让第二个用例拿到旧模块图
  const m = await import(pathToFileURL(path.join(dir, 'explorer.js')).href + '?v=' + feSeq);
  m.explorer.init();
  return { explorer: m.explorer, dom, dir };
}

/** 五行的矩形：纵向依次排开，横向都占 0~400（列表视图的形态） */
const ROWS = [
  { key: 'r0', left: 0, right: 400, top: 100, bottom: 130 },
  { key: 'r1', left: 0, right: 400, top: 130, bottom: 160 },
  { key: 'r2', left: 0, right: 400, top: 160, bottom: 190 },
  { key: 'r3', left: 0, right: 400, top: 190, bottom: 220 },
  { key: 'r4', left: 0, right: 400, top: 220, bottom: 250 },
];

test('R50-2 · 左键框选：拖过哪些行就选中哪些行（命中判据是矩形相交）', async () => {
  const { dom } = await loadExplorer(ROWS);
  assert(globalThis.__r50Selection instanceof Set, '沙箱应把选择集暴露给用例（App.state.selection 的同一个对象）');

  dom.area._ev.mousedown(mouseEv({ clientX: 300, clientY: 90 }));
  dom.fireDoc('mousemove', mouseEv({ clientX: 350, clientY: 165 }));
  assertEqual([...globalThis.__r50Selection].sort().join(','), 'r0,r1,r2',
    '从 90→165 拖过 r0(100-130)/r1(130-160)/r2(160-190 的上沿落在框内)');

  // 选框元素真的被创建出来并按视口坐标摆放
  const box = dom.created.find((e) => e.className === 'marquee');
  assert(box, '应创建一个 .marquee 选框元素');
  assertEqual(box.style.left, '300px', '选框 left 应为按下点');
  assertEqual(box.style.top, '90px', '选框 top 应为按下点');
  assertEqual(box.style.width, '50px', '选框宽应为拖动距离');
  assertEqual(box.style.height, '75px', '选框高应为拖动距离');
  assertEqual(dom.doc.body.classList.contains('marquee-dragging'), true,
    '拖动期间应禁止文字选择（否则整页会被选蓝）');

  dom.fireDoc('mouseup', mouseEv({ clientX: 350, clientY: 165 }));
  assert(box._removed, '松手后选框必须被移除');
  assert(!dom.hasDoc('mousemove'), '松手后必须摘掉 mousemove 监听（否则鼠标一动就还在框选）');
  assertEqual(dom.doc.body.classList.contains('marquee-dragging'), false, '拖动结束后应恢复文字选择');
});

test('R50-2 · 只是点一下空白（没拖动）仍然只是「清除选择」，不会误选途经的行', async () => {
  const { dom } = await loadExplorer(ROWS);
  globalThis.__r50Selection.add('seed');
  dom.area._ev.mousedown(mouseEv({ clientX: 300, clientY: 90 }));
  dom.fireDoc('mousemove', mouseEv({ clientX: 302, clientY: 92 })); // 2px < 阈值 4px
  assertEqual(globalThis.__r50Selection.size, 0, '低于阈值时不应框选到任何行');
  assertEqual(dom.created.filter((e) => e.className === 'marquee').length, 0, '低于阈值时不应创建选框');
  dom.fireDoc('mouseup', mouseEv({ clientX: 302, clientY: 92 }));
});

test('R50-2 · Ctrl 拖动是叠加（不丢原有选择），Esc 一键撤回', async () => {
  const { dom } = await loadExplorer(ROWS);
  globalThis.__r50Selection.add('r4');
  dom.area._ev.mousedown(mouseEv({ clientX: 300, clientY: 90, ctrlKey: true }));
  dom.fireDoc('mousemove', mouseEv({ clientX: 350, clientY: 165 }));
  assertEqual([...globalThis.__r50Selection].sort().join(','), 'r0,r1,r2,r4',
    'Ctrl 框选应把原有选择作为基线叠加');

  dom.fireDoc('keydown', mouseEv({ key: 'Escape' }));
  assertEqual([...globalThis.__r50Selection].join(','), 'r4',
    'Esc 应撤回拖动前的选择（框错了一键回退，不必重来）');
  assert(!dom.hasDoc('mousemove'), 'Esc 后同样要摘掉监听');
});

test('R50-2 · 点行 / 点表头 / 拖滚动条都不得触发框选（否则会吃掉既有交互）', async () => {
  const { dom } = await loadExplorer(ROWS);
  // ① 点在行上：交给行自己的 mousedown（单击/Ctrl 点/Shift 点）
  globalThis.__r50Selection.add('keep');
  dom.area._ev.mousedown(mouseEv({
    clientX: 300, clientY: 110, target: { closest: (s) => (s === 'tr[data-key]' ? {} : null) },
  }));
  assertEqual([...globalThis.__r50Selection].join(','), 'keep', '点在行上不应清空选择');
  assert(!dom.hasDoc('mousemove'), '点在行上不应进入框选');
  // ② 点在表头：既不框选也不清空（既有行为）
  dom.area._ev.mousedown(mouseEv({
    clientX: 300, clientY: 60, target: { closest: (s) => (s === 'thead' ? {} : null) },
  }));
  assert(!dom.hasDoc('mousemove'), '点在表头不应进入框选');

  // ③ 点在 #file-area 自己的滚动条上（offsetX 超出内容宽）：必须让浏览器自己处理
  dom.area._ev.mousedown(mouseEv({ clientX: 420, clientY: 200, offsetX: 420, offsetY: 200 }));
  assert(!dom.hasDoc('mousemove'), '拖滚动条不得被框选劫持（否则一拖就顺手拖出一个选框）');

  // ④ 右键不清空、也不框选
  dom.area._ev.mousedown(mouseEv({ button: 2, clientX: 300, clientY: 300 }));
  assert(!dom.hasDoc('mousemove'), '右键不应进入框选');
});

test('R50-2 · 框选在宫格视图上同样生效（两种视图共用同一段命中判据）', async () => {
  const grid = [
    { key: 'g0', left: 10, right: 140, top: 100, bottom: 200 },
    { key: 'g1', left: 150, right: 280, top: 100, bottom: 200 },
    { key: 'g2', left: 290, right: 420, top: 100, bottom: 200 },
  ];
  const { dom } = await loadExplorer(grid);
  dom.area._ev.mousedown(mouseEv({ clientX: 0, clientY: 90 }));
  dom.fireDoc('mousemove', mouseEv({ clientX: 260, clientY: 210 }));
  assertEqual([...globalThis.__r50Selection].sort().join(','), 'g0,g1',
    '横向框选宫格视图：相交的 g0/g1 入选，g2 在框外');
  dom.fireDoc('mouseup', mouseEv({ clientX: 260, clientY: 210 }));
});

/* ================================================================== *
 * ④-b 「链接创建成功」弹窗（真实 ops.js + 假 DOM）
 * ================================================================== */

let opsSeq = 0;
async function loadOps({ link, qrcodeFails = false } = {}) {
  opsSeq += 1;
  const dir = mkTempSandbox('ops' + opsSeq);
  fs.copyFileSync(JS('ops.js'), path.join(dir, 'ops.js'));
  fs.copyFileSync(JS('util.js'), path.join(dir, 'util.js'));
  fs.copyFileSync(JS('speedlimit.js'), path.join(dir, 'speedlimit.js'));
  fs.writeFileSync(path.join(dir, 'api.js'), `
export const API = {
  presign: async () => ({ url: 'https://bucket.example.com/a.jpg' }),
  createLink: async () => globalThis.__r50Link,
  linkQrcode: async () => {
    if (globalThis.__r50QrFails) { const e = new Error('内容过长，无法生成二维码（当前最多支持 213 字节）'); throw e; }
    return { svg: '<svg class="stub-qr"><rect/></svg>' };
  },
  tree: async () => ({ folders: [] }),
  throttleCeiling: async () => ({ limit: 0 }),
};
`);
  fs.writeFileSync(path.join(dir, 'main.js'), `export const App = {
    state: { prefix: '', bucket: 'demo', config: { bucket: 'demo', configured: true }, selection: new Set(), user: { role: 'admin' } },
    refreshStorage() {},
  };`);
  fs.writeFileSync(path.join(dir, 'enc.js'), 'export const openDownload = () => {};');
  globalThis.__r50Link = link;
  globalThis.__r50QrFails = Boolean(qrcodeFails);
  globalThis.__execCommands = [];
  globalThis.location = { origin: 'https://pan.example.com' };
  const dom = installFakeDom({ rows: [] });
  const m = await import(pathToFileURL(path.join(dir, 'ops.js')).href + '?v=' + opsSeq);
  return { ops: m.ops, dom };
}

/** 走完「创建分享链接 → 生成链接」这条路，返回结果弹窗的 wrap 元素 */
async function createLinkAndOpenResult(opts) {
  const { ops, dom } = await loadOps(opts);
  await ops.copyLinkKeys(['a.jpg']);
  // 创建表单是一个弹窗：点它的「生成链接」按钮
  const gen = dom.created.find((e) => e.textContent === '生成链接');
  assert(gen, '应生成「生成链接」按钮');
  await gen.onclick();
  const wrap = dom.created.find((e) => String(e.innerHTML).includes('链接创建成功'));
  assert(wrap, '应打开「链接创建成功」弹窗');
  return { dom, wrap };
}

const SAMPLE_LINK = {
  id: 'Lk1234567890abcdefghij',
  fileName: '季度报表.pdf',
  createdAt: '2026-10-13T02:00:00.000Z',
  expiresAt: '2026-10-20T02:00:00.000Z',
  maxDownloads: 5,
  downloads: 1,
  hasPassword: false,
  speedLimit: 0,
  paid: { required: true, amountFen: 150, currency: 'CNY' },
  warn: '',
};

/** 与 util.fmtTime 同口径的本地时间格式化（用例自己算一遍，避免依赖跑测时的时区） */
function localTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

test('R50-4 · 成功弹窗用 div 展示链接（不再是 textarea），并有「复制」按钮', async () => {
  const { wrap } = await createLinkAndOpenResult({ link: SAMPLE_LINK });
  const html = String(wrap.innerHTML);
  assert(html.includes('class="lr-url"'), '链接应放在 div（.lr-url）里展示');
  assert(!/<textarea/i.test(html), '不应再用 textarea 展示链接（需求明确要求改为 div）');
  assert(html.includes('>复制<'), '应有一枚「复制」按钮');
  const url = 'https://pan.example.com/s/' + SAMPLE_LINK.id;
  assert(html.includes(url), '应展示完整链接');
});

test('R50-4 · 成功弹窗逐项展示：文件名 / 创建时间 / 过期时间 / 价格 / 允许下载次数', async () => {
  const { wrap } = await createLinkAndOpenResult({ link: SAMPLE_LINK });
  const html = String(wrap.innerHTML);
  for (const label of ['文件名', '链接创建时间', '过期时间', '价格', '允许下载次数']) {
    assert(html.includes(label), `应展示「${label}」`);
  }
  assert(html.includes('季度报表.pdf'), '应展示文件名');
  // 价格与次数要真的取到值，而不是只印个标签
  assert(html.includes('¥1.50'), '付费 150 分应显示为 ¥1.50');
  assert(html.includes('5 次'), '允许下载次数应显示具体数值');
  // 创建时间与过期时间是**两个不同的时刻**（旧版只写「有效期：7 天」，没有创建时间）
  assert(html.includes(`链接创建时间</span><b>${localTime(SAMPLE_LINK.createdAt)}</b>`),
    '创建时间应取 createdAt 并格式化');
  assert(html.includes(`过期时间</span><b>${localTime(SAMPLE_LINK.expiresAt)}</b>`),
    '过期时间应取 expiresAt 并格式化');
});

test('R50-4 · 预签名直链：没有服务端记录，也要给出文件名 / 创建时间 / 过期时间与二维码', async () => {
  const { ops, dom } = await loadOps({});
  await ops.copyLinkKeys(['直链文件.rar']);
  const form = dom.created.find((e) => String(e.innerHTML).includes('链接类型'));
  assert(form, '应打开「创建分享链接」表单');
  /**
   * 切到「预签名直链」：假 DOM 的 querySelector 会**缓存**每个选择器的元素，
   * 因此这里改的正是处理函数稍后会读到的那个对象 —— 不是为了测试而特判，
   * 而是与真浏览器里「用户点了直链单选」等价的一步。
   */
  form.querySelector('input[name=lk-type]:checked').value = 'direct';
  const gen = dom.created.find((e) => e.textContent === '生成链接');
  await gen.onclick();

  const wrap = dom.created.filter((e) => String(e.innerHTML).includes('链接创建成功')).pop();
  assert(wrap, '直链也要打开结果弹窗');
  const html = String(wrap.innerHTML);
  assert(html.includes('直链文件.rar'), '直链没有服务端记录，文件名必须由调用点带上');
  for (const label of ['文件名', '链接创建时间', '过期时间', '价格', '允许下载次数']) {
    assert(html.includes(label), `直链弹窗同样要展示「${label}」`);
  }
  assert(!html.includes('永久有效'), '直链不支持永久有效 —— 过期时间必须是一个具体时刻');
  await new Promise((r) => setTimeout(r, 0));
  const qr = wrap.querySelector('#lr-qr');
  assert(String(qr.innerHTML).includes('<svg'), '直链的二维码走同一个端点');
});

test('R50-4 · 二维码真的取回来并渲染进弹窗（左侧），失败时如实说明而不是留空白', async () => {
  const { wrap, dom } = await createLinkAndOpenResult({ link: SAMPLE_LINK });
  // 二维码是异步取的：给微任务与定时器一个机会
  await new Promise((r) => setTimeout(r, 0));
  const qr = wrap.querySelector('#lr-qr');
  assert(String(qr.innerHTML).includes('<svg'), '应把服务端回传的 SVG 渲染进二维码区');
  assert(!String(qr.innerHTML).includes('生成中'), '不应停在「生成中」');
  // 布局：二维码在左、信息在右（需求指定）
  assert(String(wrap.innerHTML).indexOf('class="lr-qr"') < String(wrap.innerHTML).indexOf('class="lr-main"'),
    '二维码应排在信息区之前（即视觉上的左侧）');
  void dom;

  // 生成不出来时（超长内容 / 服务不可达）→ 明确说明
  const bad = await createLinkAndOpenResult({ link: SAMPLE_LINK, qrcodeFails: true });
  await new Promise((r) => setTimeout(r, 0));
  const qr2 = bad.wrap.querySelector('#lr-qr');
  assert(String(qr2.innerHTML).includes('内容过长'), '失败原因要如实显示给用户');
  assert(!String(qr2.innerHTML).includes('生成中'), '失败后也不应停在「生成中」');
});

test('R50-4 · 「复制」按钮在没有 clipboard 的环境（http 局域网）仍能复制成功', async () => {
  const { wrap } = await createLinkAndOpenResult({ link: SAMPLE_LINK });
  // Node 里 navigator.clipboard 不存在 —— 正是「http://内网IP」访问本服务时的处境
  const nav = globalThis.navigator;
  assert(!(nav && nav.clipboard && nav.clipboard.writeText), '前提：本环境没有 clipboard API');
  const btn = wrap.querySelector('#lr-copy');
  assert(typeof btn.onclick === 'function', '「复制」按钮应绑定了处理函数');
  await btn.onclick();
  assertEqual(globalThis.__execCommands.includes('copy'), true,
    '没有 clipboard API 时必须回退到 execCommand（否则用户只能手动框选复制）');
});
