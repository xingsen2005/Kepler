#!/usr/bin/env node
/**
 * Windows 单文件客户端构建脚本
 * ============================================================================
 *
 * 产出：`client/windows/Kepler.exe` —— 一个**独立单文件**可执行程序：
 *   · 内置 Node 运行时（Node SEA 单可执行应用架构）；
 *   · 内置 Kepler 服务端全部代码 + 前端全部静态资源 + 生产期 node_modules；
 *   · 首次启动时把内置应用解压到 `%LOCALAPPDATA%\Kepler\client\v<版本>\app`（仅一次），
 *     随后 require 解压产物启动服务，行为与仓库内 `npm start` 完全一致；
 *   · 自动挑选端口（默认 3000，占用则顺延）、就绪后自动打开浏览器；
 *   · 数据目录默认落在 exe 同级的 `data\`（便携，可整体拷贝迁移），不可写时退回
 *     `%APPDATA%\Kepler\data`；也可用 `S3_DATA_DIR` 显式指定。
 *
 * 为什么是「自解压 + SEA」而不是把全部代码 esbuild 打进一个 JS：
 *   服务端有多处**运行期从磁盘读文件 / 起工作线程**的硬性要求 ——
 *     · `enc-pool.js` 用 `new Worker(path.join(__dirname, 'enc-pool.js'))`
 *       （worker_threads 只接受真实文件路径，不接受内存字符串）；
 *     · `express.static(PUBLIC_DIR)` / `file-icons.js` 直接读 `public/index.html`；
 *     · `ip-guard.js` 读 `server/china-ips.txt`。
 *   纯内存 bundle 要么改这些实现点（破坏「与仓库同源」的等价性），要么在运行期
 *   把文件落盘。既然如此，不如**原样打包整个应用树**：解压出来的就是仓库里
 *   那份代码，行为逐字节一致，唯一成本是首次启动多一次解压（约 1~2 秒）。
 *
 * 归档格式（KPC1，全部内嵌在 SEA 主脚本的 base64 串里）：
 *   [0..4)   magic 'KPC1'
 *   [4..8)   u32le  manifestGz.length
 *   [8..8+m) manifestGz  = gzip(JSON([{ p: 归档内路径, l: 字节长度 }, ...]（顺序即数据区顺序）))
 *   [8+m..)  dataGz      = gzip(全部文件字节顺序拼接)
 *
 * 依赖收集：**按 require 依赖图精确收集**，不整目录拷 node_modules ——
 * 仓库的 node_modules 里留有历史遗留包（如 R49 移除的 selfsigned / node-forge
 * 及其依赖），盲拷会把它们也带进客户端。从 server/ 全部 .js 出发做 BFS：
 * 相对路径入文件队列，裸标识符经 require.resolve 定位包根，包根下所有 .js
 * 再入队（传递闭包）。被其它包根包含的嵌套包根去重（其文件已随外层拷入）。
 *
 * 用法：
 *   node scripts/build-client-windows.js [--out <目录>] [--name <exe 名>]
 *                                        [--node <node.exe>] [--postject <cli.js>]
 * 默认产出 `client/windows/Kepler.exe`，并附 `使用说明.txt`。
 * 中间产物在 `<out>/.build/`，成功即清理；失败时保留便于排查。
 */

'use strict';

const USAGE = [
  '用法：node scripts/build-client-windows.js [选项]',
  '  --out <目录>     输出目录（默认 client/windows）',
  '  --name <文件名>  exe 文件名（默认 Kepler.exe）',
  '  --node <node.exe>  用于 SEA 打包的 Node 可执行文件（默认当前 Node）',
  '  --postject <cli.js>  postject CLI 路径（默认自动探测）',
  '  --dry-run           只收集文件并打印清单，不打包',
  ' --keep-build        构建后保留中间产物（便于排查）',
].join('\n');

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* -------------------------------------------------------------------------- */
/* 命令行参数                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opt = { out: path.join(ROOT, 'client', 'windows'), name: 'Kepler.exe', node: '', postject: '', dryRun: false, keepBuild: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少取值`); return argv[++i]; };
    if (a === '--out') opt.out = path.resolve(next());
    else if (a === '--name') opt.name = next();
    else if (a === '--node') opt.node = path.resolve(next());
    else if (a === '--postject') opt.postject = path.resolve(next());
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--keep-build') opt.keepBuild = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else throw new Error(`未知参数：${a}\n${USAGE}`);
  }
  return opt;
}

/* -------------------------------------------------------------------------- */
/* 文件收集                                                                    */
/* -------------------------------------------------------------------------- */

const TEXT_EXT = new Set(['.js', '.json', '.txt', '.html', '.css', '.md']);

function walkFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

/** 统一成 LF —— 让产物不受构建机 git autocrlf 设置影响（已知文本扩展名才规范化） */
function readNormalized(file) {
  const buf = fs.readFileSync(file);
  if (TEXT_EXT.has(path.extname(file).toLowerCase()) && buf.includes(0x0d)) {
    return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  }
  return buf;
}

/** 相对路径 → 补全扩展名 / index，解析为真实文件（解析不到返回 null） */
function resolveFile(base) {
  const cands = [base, base + '.js', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.json')];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* 继续 */ }
  }
  return null;
}

/** 从包内某文件向上找到包含 package.json 的目录 = 包根 */
function packageRootOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const REQUIRE_RE = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\1/g;

/**
 * Node 核心模块名集合。
 * ⚠️ 必须跳过：`require.resolve('fs')` 对核心模块**返回的就是字符串 'fs' 本身**，
 * 拿它去 `packageRootOf` 会沿相对路径 'fs' → dirname '.' 爬到当前工作目录，
 * 把整个仓库（tests/、eslint、历史遗留包…）当成一个"包"走一遍 —— 实测踩过。
 */
const CORE_MODULES = new Set(require('module').builtinModules);

function isCoreModule(spec) {
  return spec.startsWith('node:') || CORE_MODULES.has(spec);
}

/**
 * 从 server/ 出发沿 require 图收集生产期 node_modules 包根。
 * 返回去重（去掉被其它包根包含的嵌套根）后的包根列表。
 */
function collectPackageRoots(serverDir) {
  const roots = new Set();
  const seen = new Set();
  const queue = walkFiles(serverDir).filter((f) => f.endsWith('.js'));

  const addRoot = (root) => {
    // 防御：核心模块误解析（见 CORE_MODULES 注释）或任何非常量根都可能把仓库根/工作目录
    // 拖进来走全量遍历 —— 这里显式只接受 node_modules 下的绝对包目录。
    if (!root || !path.isAbsolute(root)) return;
    const rel = path.relative(ROOT, root).replaceAll('\\', '/');
    if (!rel.startsWith('node_modules/')) return;
    if (roots.has(root)) return;
    roots.add(root);
    for (const f of walkFiles(root)) {
      if (f.endsWith('.js') && !seen.has(f)) queue.push(f);
    }
  };

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    for (const m of src.matchAll(REQUIRE_RE)) {
      const spec = m[2];
      if (!spec || isCoreModule(spec)) continue;
      let resolved = null;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        resolved = resolveFile(path.resolve(path.dirname(file), spec));
        if (resolved && !seen.has(resolved)) queue.push(resolved);
      } else {
        try { resolved = require.resolve(spec, { paths: [path.dirname(file)] }); } catch (e) { resolved = null; }
        if (resolved) addRoot(packageRootOf(resolved));
      }
    }
  }

  // 嵌套包根的文件已随外层包根整体拷入，去掉避免归档出现重复路径
  const sorted = [...roots].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const r of sorted) {
    if (!kept.some((k) => r === k || r.startsWith(k + path.sep))) kept.push(r);
  }
  return kept;
}

/** 汇总所有要打进归档的文件：[{ arc, abs }]（arc = 归档内相对路径） */
function collectAppFiles() {
  const files = [];
  const push = (abs, arc) => files.push({ abs, arc });
  for (const f of walkFiles(path.join(ROOT, 'server'))) push(f, path.relative(ROOT, f).replaceAll('\\', '/'));
  for (const f of walkFiles(path.join(ROOT, 'public'))) push(f, path.relative(ROOT, f).replaceAll('\\', '/'));
  push(path.join(ROOT, 'package.json'), 'package.json');
  for (const root of collectPackageRoots(path.join(ROOT, 'server'))) {
    const rel = path.relative(ROOT, root).replaceAll('\\', '/');
    for (const f of walkFiles(root)) push(f, rel + '/' + path.relative(root, f).replaceAll('\\', '/'));
  }
  // 排序 + 去重，保证构建可复现
  files.sort((a, b) => (a.arc < b.arc ? -1 : a.arc > b.arc ? 1 : 0));
  const seenArc = new Set();
  const out = files.filter((f) => (seenArc.has(f.arc) ? false : (seenArc.add(f.arc), true)));
  // 护栏：收集结果只允许落在 server/ public/ node_modules/ package.json 四个前缀下。
  // 依赖图一旦解析错（核心模块、路径穿越、历史遗留包），会在这里直接炸掉，而不是
  // 悄悄把 tests/、整个仓库或 eslint 打进客户端。
  const bad = out.filter((f) => !/^(server\/|public\/|node_modules\/|package\.json$)/.test(f.arc));
  if (bad.length) {
    throw new Error(`收集到 ${bad.length} 个越界文件（前 5 个：${bad.slice(0, 5).map((f) => f.arc).join('、')}）`
      + ' —— 依赖图解析异常，请检查 collectPackageRoots');
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 归档                                                                        */
/* -------------------------------------------------------------------------- */

const MAGIC = 'KPC1';

function buildArchive(files) {
  const manifest = [];
  const chunks = [];
  for (const f of files) {
    const data = readNormalized(f.abs);
    manifest.push({ p: f.arc, l: data.length });
    chunks.push(data);
  }
  const manifestGz = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8'), { level: 9 });
  const dataGz = zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
  const header = Buffer.alloc(8);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32LE(manifestGz.length, 4);
  const archive = Buffer.concat([header, manifestGz, dataGz]);
  return { archive, rawBytes: chunks.reduce((s, c) => s + c.length, 0) };
}

/* -------------------------------------------------------------------------- */
/* 启动器（SEA 主脚本）                                                         */
/* -------------------------------------------------------------------------- */

function renderLauncher(version, archiveB64) {
  const lines = [];
  for (let i = 0; i < archiveB64.length; i += 4000) lines.push(`  '${archiveB64.slice(i, i + 4000)}',`);
  return `'use strict';
/*
 * Kepler 单文件客户端启动器 —— 由 scripts/build-client-windows.js 自动生成，请勿手改。
 * 版本：${version}
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const net = require('net');
const { exec } = require('child_process');
// ⚠️ SEA 关键：SEA 给嵌入脚本绑定的 require 只认核心模块（embedderRequire），
// 用它去 require 磁盘上的用户模块（解压后的 server/index.js）会报
// ERR_UNKNOWN_BUILTIN_MODULE。必须用 createRequire 拿一个走**正常文件系统解析**
// 的 require，才能加载解压出来的应用树。
const { createRequire } = require('node:module');

const VERSION = ${JSON.stringify(version)};
const MAGIC = 'KPC1';
const ARCHIVE_B64 = [
${lines.join('\n')}
].join('');

const EXE_DIR = path.dirname(process.execPath);
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CACHE_DIR = path.join(LOCAL, 'Kepler', 'client', 'v' + VERSION, 'app');
const MARKER = '.kpc-complete';
const PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009];

function log() { console.log.apply(console, ['[Kepler]'].concat([].slice.call(arguments))); }

function fatal(msg, e) {
  console.error('[Kepler] ' + msg);
  if (e && e.stack) console.error(e.stack);
  console.error('[Kepler] 启动失败。按回车键退出（30 秒后自动退出）…');
  try { process.stdin.resume(); process.stdin.once('data', () => process.exit(1)); } catch (e2) { /* 无 stdin */ }
  setTimeout(() => process.exit(1), 30000);
}

/* ---------- 解压内置应用到缓存目录（版本级隔离，已就绪则跳过） ---------- */
function ensureApp() {
  try {
    if (fs.readFileSync(path.join(CACHE_DIR, MARKER), 'utf8') === VERSION) return CACHE_DIR;
  } catch (e) { /* 需要解压 */ }
  const raw = Buffer.from(ARCHIVE_B64, 'base64');
  if (raw.length < 8 || raw.slice(0, 4).toString('latin1') !== MAGIC) {
    throw new Error('内置应用包损坏（magic 不匹配）');
  }
  const manifestLen = raw.readUInt32LE(4);
  const manifest = JSON.parse(zlib.gunzipSync(raw.slice(8, 8 + manifestLen)).toString('utf8'));
  const data = zlib.gunzipSync(raw.slice(8 + manifestLen));
  const tmp = CACHE_DIR + '.extract-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  let off = 0;
  for (const f of manifest) {
    const dest = path.join(tmp, f.p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data.slice(off, off + f.l));
    off += f.l;
  }
  if (off !== data.length) throw new Error('内置应用包损坏（数据区长度不匹配）');
  fs.writeFileSync(path.join(tmp, MARKER), VERSION);
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fs.renameSync(tmp, CACHE_DIR);
    return CACHE_DIR;
  } catch (e) {
    // 旧缓存被占用（极少数：标记文件被手工删掉的同时旧实例仍在跑）—— 本次用临时目录，功能不受影响
    log('注意：无法切换到共享缓存目录，本次使用独立目录运行（' + path.basename(tmp) + '）');
    return tmp;
  }
}

/* ---------- 数据目录：exe 同级 data\\（便携）优先，不可写退回 AppData ---------- */
function pickDataDir() {
  const preset = String(process.env.S3_DATA_DIR || '').trim();
  if (preset) return path.resolve(preset);
  const portable = path.join(EXE_DIR, 'data');
  try {
    fs.mkdirSync(portable, { recursive: true });
    const probe = path.join(portable, '.w-' + process.pid);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return portable;
  } catch (e) { /* 不可写：退回用户目录 */ }
  const fallback = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kepler', 'data');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/* ---------- 端口与健康探测 ---------- */
function getJson(port, p) {
  return new Promise((resolve) => {
    // ⚠️ 服务端全局 CSRF 守卫要求 X-Requested-With + 同源 Origin；不带会直接 403/拦截，
    // 导致健康探测误判「没有 Kepler 在跑」。这里补齐这两个头。
    const req = http.get({
      host: '127.0.0.1', port, path: p, timeout: 800,
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Origin': 'http://127.0.0.1:' + port },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 端口上是否已经跑着一个 Kepler。
 *  ⚠️ 不能用 /api/health：它走全局 /api 鉴权中间件，匿名必 401，无法用于「已有实例」探测。
 *  改用公开、免登录的 /api/auth/me，其响应形状稳定为 {ok:true, user, initialized}。 */
function isKeplerRunning(port) {
  return getJson(port, '/api/auth/me').then((r) =>
    !!(r && r.json && r.json.ok === true));
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(port) {
  if (process.env.KEPLER_NO_BROWSER === '1') return;
  const url = 'http://127.0.0.1:' + port;
  exec('cmd /c start "" "' + url + '"', (e) => {
    if (e) log('无法自动打开浏览器，请手动访问 ' + url);
  });
}

/* ---------- 主流程 ---------- */
(async () => {
  try {
    const forced = Number(process.env.PORT) || 0;
    if (!forced && await isKeplerRunning(PORTS[0])) {
      // 已有实例：不重复起服务，直接帮用户打开界面
      openBrowser(PORTS[0]);
      log('检测到已在运行的 Kepler 实例（端口 ' + PORTS[0] + '），已为您打开界面。');
      return;
    }
    let port = forced;
    if (!port) {
      for (const p of PORTS) { if (await portFree(p)) { port = p; break; } }
      if (!port) throw new Error('3000~3009 端口全部被占用。可设置环境变量 PORT 指定其它端口。');
    }
    const dataDir = pickDataDir();
    const appDir = ensureApp();
    process.env.S3_DATA_DIR = dataDir;
    process.env.PORT = String(port);
    try { process.title = 'Kepler v' + VERSION; } catch (e) { /* 非 Windows 忽略 */ }
    log('单文件客户端 v' + VERSION);
    log('应用目录  : ' + appDir);
    log('数据目录  : ' + dataDir);
    // 用 createRequire 取得「正常文件系统解析」的 require（见顶部说明），加载解压后的服务端入口。
    const entryModule = path.join(appDir, 'server', 'index.js');
    const appRequire = createRequire(entryModule);
    appRequire(entryModule);
    for (let i = 0; i < 150; i++) {
      if (await isKeplerRunning(port)) break;
      await sleep(100);
    }
    log('地址      : http://127.0.0.1:' + port + (port === 3000 ? '' : '（3000 被占用，已自动顺延）'));
    openBrowser(port);
    log('浏览器将自动打开界面；关闭本窗口即停止服务。');
  } catch (e) {
    fatal(e && e.message ? e.message : String(e), e);
  }
})();
`;
}

/* -------------------------------------------------------------------------- */
/* SEA 打包                                                                    */
/* -------------------------------------------------------------------------- */

/** 从 node.exe 里自动探测 SEA fuse 字符串（各 Node 版本取值不同，不能硬编码） */
function detectSeaFuse(nodeExe) {
  const buf = fs.readFileSync(nodeExe);
  const m = buf.toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]{32}/);
  if (!m) throw new Error(`${nodeExe} 中未找到 NODE_SEA_FUSE_* —— 该 Node 构建不支持 SEA，请换一个官方 Node ≥ 18 的 Windows 构建`);
  return m[0];
}

/** 定位 postject CLI（--postject 参数 > 环境变量 > 仓库本地 > 托管工作区 > npx 兜底） */
function findPostject(explicit) {
  const cands = [
    explicit,
    process.env.KEPLER_POSTJECT,
    (() => { try { return require.resolve('postject/dist/cli.js', { paths: [ROOT] }); } catch (e) { return null; } })(),
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'postject', 'dist', 'cli.js'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* 继续 */ } }
  return null;
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.status !== 0) {
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    throw new Error(`命令执行失败（exit ${r.status}）：${cmd} ${args.join(' ')}\n${out}`);
  }
  return r;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

function main() {
  const opt = parseArgs(process.argv);
  const nodeExe = opt.node || process.execPath;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;

  // 1. 收集文件
  const files = collectAppFiles();
  const nmCount = files.filter((f) => f.arc.startsWith('node_modules/')).length;
  const roots = [...new Set(files
    .filter((f) => f.arc.startsWith('node_modules/'))
    .map((f) => f.arc.split('/').slice(0, 2).join('/')))].sort();

  if (opt.dryRun) {
    console.log('');
    console.log(`  [dry-run] 共 ${files.length} 个文件：`);
    for (const f of files) console.log('    ' + f.arc);
    console.log(`  [dry-run] node_modules 包根（${roots.length} 个）：`);
    for (const r of roots) console.log('    ' + r);
    console.log('');
    return;
  }
  console.log(`  [1/5] 收集文件：共 ${files.length} 个`
    + `（server ${files.filter((f) => f.arc.startsWith('server/')).length}`
    + ` · public ${files.filter((f) => f.arc.startsWith('public/')).length}`
    + ` · node_modules ${nmCount} · package.json 1）`);

  // 2. 归档
  const { archive, rawBytes } = buildArchive(files);
  console.log(`  [2/5] 归档：原始 ${(rawBytes / 1024 / 1024).toFixed(2)} MB → 压缩后 ${(archive.length / 1024 / 1024).toFixed(2)} MB（${files.length} 个文件，node_modules ${nmCount} 个）`);

  // 3. 生成启动器 + SEA blob
  const buildDir = path.join(opt.out, '.build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const launcherPath = path.join(buildDir, 'launcher.js');
  fs.writeFileSync(launcherPath, renderLauncher(version, archive.toString('base64')), 'utf8');
  // 护栏：启动器进 SEA blob 前必须自身可解析 —— 生成式代码（超长 base64 分片数组）
  // 一旦拼错（如分片间漏逗号）只会在用户双击 exe 时才以 SyntaxError 炸掉，
  // 这里先挡一道。
  run(process.execPath, ['--check', launcherPath]);
  const seaConfig = {
    main: launcherPath,
    output: path.join(buildDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  const seaConfigPath = path.join(buildDir, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  // Node 22 用 --experimental-sea-config；更高版本去掉了 experimental 前缀，两种都试
  let sea;
  try {
    sea = run(nodeExe, ['--experimental-sea-config', seaConfigPath], { cwd: buildDir });
  } catch (e) {
    sea = run(nodeExe, ['--sea-config', seaConfigPath], { cwd: buildDir });
  }
  if (!fs.existsSync(seaConfig.output)) throw new Error('sea-prep.blob 未生成');
  const blobSize = fs.statSync(seaConfig.output).size;
  console.log(`  [3/5] SEA blob：${(blobSize / 1024 / 1024).toFixed(2)} MB`);

  // 4. 复制 node.exe 并注入 blob
  fs.mkdirSync(opt.out, { recursive: true });
  const exePath = path.join(opt.out, opt.name);
  fs.copyFileSync(nodeExe, exePath);
  const fuse = detectSeaFuse(nodeExe);
  const postjectCli = findPostject(opt.postject);
  if (!postjectCli) {
    throw new Error('未找到 postject。请先安装（npm i -D postject，或装到任意位置后用 --postject <dist/cli.js> 指定），'
      + '也可设置环境变量 KEPLER_POSTJECT。');
  }
  run(process.execPath, [postjectCli, exePath, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', fuse]);
  const exeSize = fs.statSync(exePath).size;
  console.log(`  [4/5] 注入完成：${exePath}（${(exeSize / 1024 / 1024).toFixed(1)} MB，fuse=${fuse}）`);

  // 5. 使用说明 + 清理中间产物
  const readme = path.join(opt.out, '使用说明.txt');
  fs.writeFileSync(readme, renderReadme(version, opt.name), 'utf8');
  if (opt.keepBuild) {
    console.log(`  [5/5] 已保留中间产物（--keep-build）：${buildDir}`);
  } else {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`  [5/5] 完成：`);
  console.log(`        ${exePath}`);
  console.log(`        ${readme}`);
  console.log('');
  console.log('  双击 exe 即可使用（无需安装 Node.js）。数据默认存放在 exe 同级 data\\ 目录。');
  console.log('');
}

function renderReadme(version, exeName) {
  return [
    `Kepler 单文件客户端（Windows）使用说明`,
    '='.repeat(60),
    '',
    '一、这是什么',
    '  一个独立的可执行文件，内置 Node 运行时、Kepler 服务端与全部前端资源。',
    '  无需安装 Node.js、无需解压、无外部依赖，拷贝到任何 Windows 电脑即可运行。',
    '',
    '二、如何使用',
    `  1. 双击 ${exeName}。`,
    `  2. 首次启动会把内置应用解压到 %LOCALAPPDATA%\\Kepler\\client\\v${version}\\app（仅一次，约 1~2 秒）。`,
    '  3. 浏览器自动打开 http://127.0.0.1:3000 ，随后与常规部署用法完全一致。',
    '  4. 关闭黑色的控制台窗口 = 停止服务；再次双击即重新启动。',
    '',
    '三、数据存放在哪',
    '  · 默认：exe 同级 data\\ 目录（把 exe 和 data\\ 一起拷贝即可整体迁移）。',
    '  · 若 exe 所在目录不可写（如 C:\\Program Files），自动退回 %APPDATA%\\Kepler\\data。',
    '  · 也可用环境变量 S3_DATA_DIR 显式指定其它目录。',
    '',
    '四、端口',
    '  · 默认 3000；被占用时自动顺延（3001、3002 …，界面上会显示实际地址）。',
    '  · 若 3000 上已有 Kepler 实例在运行，再次双击只会打开界面，不会重复启动服务。',
    '  · 可用环境变量 PORT 强制指定端口。',
    '  · 环境变量 KEPLER_NO_BROWSER=1 可禁止自动打开浏览器（服务器场景）。',
    '',
    '五、说明与限制',
    '  · 仅监听 127.0.0.1（本机访问）。如需局域网访问，启动前设置 HOST=0.0.0.0',
    '    （请注意随之而来的安全风险）。',
    '  · HTTPS / WebDAV：与完整版一致，需自备证书放到数据目录 tls\\ 下',
    '    （fullchain.pem / privkey.pem），或设置 TLS_CERT_FILE / TLS_KEY_FILE。',
    '  · 加密上传使用工作线程池，行为与完整版完全一致。',
    '  · 升级：用新构建的 exe 覆盖旧文件即可，应用缓存按版本隔离，互不干扰。',
    '  · exe 未做代码签名，首次在别的机器上运行可能被 SmartScreen 拦截，',
    '    选择「更多信息 → 仍要运行」即可（自包含单文件无法附带签名说明）。',
    '',
  ].join('\r\n');
}

let BUILD_OUT_DIR = path.join(ROOT, 'client', 'windows');
try {
  BUILD_OUT_DIR = parseArgs(process.argv).out;
  main();
} catch (e) {
  console.error('');
  console.error('  构建失败：' + (e && e.message ? e.message : String(e)));
  console.error('  中间产物保留在 ' + path.join(BUILD_OUT_DIR, '.build') + ' 便于排查。');
  console.error('');
  process.exit(1);
}
