/**
 * 第六十六轮护栏：仓库级卫生（CI / 测试隔离 / 健康检查分档）
 *
 * 这一轮不是「用户报的 bug」，而是**外部评审提出的工程建议**里被实证成立的那几条。
 * 与产品行为无关，但每一条都会让「护栏本身可不可信」发生变化，因此同样需要护栏：
 *
 *  ① **R66-01 CI 执行者**：1255 条用例此前没有任何自动化执行者，全靠提交者在本机
 *     手动 `npm test`。「写了没人跑」与「没写」在事故面前等价。
 *  ② **R66-02 测试隔离**：`crypto-storage.test.js` 曾把数据目录写死成仓库里的 `data/`，
 *     而 `helpers.js` 早已把 `S3_DATA_DIR` 兜底到临时目录 —— 于是那层「备份→还原」
 *     保护的是**本进程根本不会去写**的目录，名实不符。
 *  ③ **R66-04 健康检查分档**：`/health` 只要求登录、不挂 `requireAdmin`，新增的
 *     `bucketCount` / `lastWriteAt` 是**跨用户**的规模信息，必须只给管理员。
 *
 * ## 判据纪律（本文件最容易踩的两种假绿，都已规避）
 *
 *  - **CI 的判据不能是「全文出现 `npm ci`」**：workflow 的注释里就写着这些词，
 *    而且注释恰恰在解释「为什么要这么做」。故所有文本判据先剥掉 `#` 注释行。
 *  - **`/health` 的判据不能只看源码里有 `role === 'admin'`**：必须真的发一次 HTTP，
 *    分别以两种角色取回响应体，比「字段在不在」。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { assert, assertEqual, assertMatch, request, ROOT } = require('./helpers');

const read = (p) => fs.readFileSync(p, 'utf8');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const DOC = path.join(ROOT, 'Develop_Document.md');

/* ==================================================================== */
/* R66-01 · CI                                                          */
/* ==================================================================== */

test('R66-01 · CI 工作流存在，且真的会执行（npm ci / lint / 逐文件跑测试）', () => {
  assert(fs.existsSync(WORKFLOW),
    '.github/workflows/ci.yml 必须存在 —— 没有它，tests/ 下的护栏就没有任何自动化执行者');

  /**
   * ⚠️ 先剥注释行再断言：本 workflow 的文件头注释里写着 `npm test`、
   * 逐文件遍历的理由等字样，直接对全文做 `includes` 会**被注释满足**（假绿）。
   */
  const code = read(WORKFLOW)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  assertMatch(code, /^\s*-?\s*run: npm ci\s*$/m,
    '必须用 `npm ci`（严格按 lockfile 安装）；写成 `npm install` 会让 CI 装上与锁文件不同的版本');
  assertMatch(code, /^\s*-?\s*run: npm run lint\s*$/m,
    '静态检查必须进 CI —— 只在本机跑 lint 等于没有 lint');
  assertMatch(code, /node --test "\$f"/,
    '必须逐文件跑测试：本项目实测过「全集 glob 会卡死」，且 node 18 的 --test 不支持 glob');

  // 矩阵：至少要覆盖 engines 声明的下界（>=24.22.1 ⇒ 24），以及两个平台
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    assert(code.includes(os), `矩阵里必须有 ${os} —— 只跑 Linux 会漏掉换行/路径类问题`);
  }
  for (const v of ["'24'"]) {
    assert(code.includes(v), `矩阵里必须有 Node ${v}（engines 声明 >=24.22.1，就得真的验 24）`);
  }
  assertEqual(/continue-on-error:\s*true/.test(code), false,
    '不得用 continue-on-error 把红灯变成绿灯 —— 一条测试红就是红');
});

test('R66-01b · 文档的目录结构登记了 CI 工作流与 jsconfig（否则读者以为没有）', () => {
  const doc = read(DOC);
  assert(doc.includes('.github/workflows/ci.yml'),
    '目录结构必须列出 .github/workflows/ci.yml —— 这一条曾经长期漂移（文档写着、仓库里没有），'
    + '现在文件真的落地了，就该如实登记');
  assert(doc.includes('jsconfig.json'), '目录结构必须列出 jsconfig.json');
});

/* ==================================================================== */
/* R66-02 · 测试隔离                                                    */
/* ==================================================================== */

test('R66-02 · 测试不得把数据目录写死成仓库的 data/（必须跟随 S3_DATA_DIR）', () => {
  /**
   * 白名单只有两个，且都是**故意**引用真实路径的：
   *  - `audit13`：断言「不设 env 时默认落到哪」，那正是它要测的东西；
   *  - `audit49`：R49-14 钉 `defaultDataDir()` 的唯一实现点，同上。
   */
  const ALLOW = new Set(['audit13-regressions.test.js', 'audit49-regressions.test.js']);
  const dir = path.join(ROOT, 'tests');
  /**
   * ⚠️ 必须先剥注释再扫：`crypto-storage.test.js` 修好之后，**说明性注释里**
   * 仍写着 `path.join(ROOT, 'data')`（那正是解释「为什么不能这么写」的那段），
   * 直接按行扫会把它判红 —— 与项目里反复出现过的「判据被注释满足 / 被注释打红」
   * 是同一个坑。块注释与行注释都抹成等长空白，行号因此仍然对得上。
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.test.js') || ALLOW.has(f)) continue;
    stripComments(read(path.join(dir, f))).split('\n').forEach((line, i) => {
      if (!/path\.join\(ROOT,\s*'data'\)/.test(line)) return;
      /**
       * `process.env.S3_DATA_DIR || path.join(ROOT, 'data')` 是**合法**的兜底写法
       * （先跟随隔离目录，没有环境变量时才退回仓库 data/），不算写死。
       * 只有当同一行**没有**环境变量兜底时才算违规。
       */
      if (/process\.env\.S3_DATA_DIR/.test(line)) return;
      offenders.push(`${f}:${i + 1}`);
    });
  }
  assertEqual(offenders.length, 0,
    '以下位置把数据目录写死成仓库 data/：' + offenders.join(', ')
    + ' —— helpers.js 已把 S3_DATA_DIR 兜底到临时目录，写死 ROOT/data 只会让'
    + '「备份→还原」保护一个本进程根本不会写的目录（看着有隔离，其实没有）');

  // 定点：唯一曾经写死过的那个文件，必须真的改成跟随环境变量
  const cs = read(path.join(dir, 'crypto-storage.test.js'));
  assertMatch(cs, /const DATA = process\.env\.S3_DATA_DIR \|\|/,
    'crypto-storage 的数据目录必须跟随 S3_DATA_DIR（与 store 实际落盘的位置同源）');
});

/* ==================================================================== */
/* R66-04 · /health 的分档                                              */
/* ==================================================================== */

/** 起一个只挂 stats 路由的 app，按请求头注入角色（避免为两种角色各起一个服务） */
async function serveHealth() {
  const { express } = require('../server/routes/_context');
  const statsRouter = require('../server/routes/stats.js');
  const app = express();
  app.use('/api', (req, res, next) => {
    req.authUser = req.headers['x-test-role'] === 'admin'
      ? { id: 'u-admin', username: 'root', role: 'admin' }
      : { id: 'u-plain', username: 'bob', role: 'user' };
    next();
  });
  app.use('/api', statsRouter);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('R66-04 · /health 的 bucketCount / lastWriteAt 只给管理员（普通用户拿不到）', async () => {
  const configStore = require('../server/config-store.js');
  const realGet = configStore.get;
  // 桩掉配置读取：本用例要钉的是「按角色下发哪些字段」，与磁盘上那份配置无关
  configStore.get = () => ({
    secretId: 'sid',
    secretKey: 'skey',
    buckets: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
    updatedAt: '2026-10-20T00:00:00.000Z',
  });
  const srv = await serveHealth();
  try {
    const admin = await request(srv.port, 'GET', '/api/health', { headers: { 'x-test-role': 'admin' } });
    assertEqual(admin.status, 200, '健康检查在无损坏时应回 200');
    assertEqual(admin.json.ok, true, 'ok 应为真');
    assertEqual(admin.json.bucketCount, 3, '管理员必须看到真实的桶数量（3 个）');
    assertEqual(admin.json.lastWriteAt, '2026-10-20T00:00:00.000Z',
      '管理员必须看到配置最后一次改动时间（取自 cfg.updatedAt）');

    const plain = await request(srv.port, 'GET', '/api/health', { headers: { 'x-test-role': 'user' } });
    assertEqual(plain.status, 200, '普通用户也必须能问「服务是否可用」—— 这条不能挂 requireAdmin');
    assertEqual(plain.json.ok, true, '普通用户同样拿到 ok');
    assertEqual(plain.json.configured, true,
      'configured / corrupted 对普通用户保留：它们回答的是「这台实例能不能用」');
    assertEqual('bucketCount' in plain.json, false,
      'bucketCount 是跨用户的规模信息，不得下发给普通用户（普通用户只看得到自己可见的桶）');
    assertEqual('lastWriteAt' in plain.json, false, 'lastWriteAt 同理');
  } finally {
    configStore.get = realGet;
    await srv.close();
  }
});

/* ==================================================================== */
/* R67 · 拆包不变量（server/webdav/ 是本仓库第一个「入口 + 包目录」形态）    */
/* ==================================================================== */

/**
 * 为什么拆包之后必须再加这三条
 *
 * 把一个 1496 行的文件拆成「入口 facade + 包目录」之后，最可能悄悄坏掉的是**结构**，
 * 而且三种坏法都不会让任何行为测试变红：
 *
 *  ① **孤儿文件**：把某个模块从 app.js 的 require 里删掉，代码还在、测试也还绿
 *     （那条路径只是不再被调用），但下一次改它的人会以为它还在生效。
 *  ② **反向依赖**：为了拿到 `buildApp` 而让 `defs.js` 去 require `./app` —— 立刻成环，
 *     表现为**启动时某个导出是 undefined**，而不是报错。
 *  ③ **实现搬回 facade**：拆完之后图省事把新逻辑写在入口文件里，几个月后它又变成
 *     一个巨型文件，而这次没有任何东西会提醒你。
 *
 * 三条都只做**结构断言**（谁 require 谁、谁里有路由注册），不碰行为 —— 行为由既有的
 * 1100+ 条用例管。
 */
const WEBDAV_DIR = path.join(ROOT, 'server', 'webdav');
const WEBDAV_ENTRY = path.join(ROOT, 'server', 'webdav-server.js');
const webdavFiles = () => fs.readdirSync(WEBDAV_DIR).filter((f) => f.endsWith('.js')).sort();

test('R67-01 · server/webdav/ 内不得有孤儿文件（每个都必须被 require）', () => {
  assert(fs.existsSync(WEBDAV_DIR), 'server/webdav/ 不存在 —— 拆包结构已被还原，本组断言失去对象');
  const files = webdavFiles();
  assert(files.length >= 5,
    `server/webdav/ 至少应有 5 个模块（当前 ${files.length}）—— 少于此说明拆包被回退了`);

  // 扫描范围：server/ 下全部 js（含包内互引）+ 入口文件
  const sources = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) sources.push(read(p));
    }
  };
  walk(path.join(ROOT, 'server'));
  const all = sources.join('\n');

  const orphan = files.filter((f) => {
    const base = f.replace(/\.js$/, '');
    // `require('./app')` / `require('./webdav/app')` 两种写法都算
    return !new RegExp(`require\\(['"][^'"]*\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)`).test(all);
  });
  assertEqual(orphan.length, 0,
    `以下模块没有任何地方 require（拆包后遗留的孤儿）：${orphan.join(', ')}。`
    + '删掉它，或把它接回调用链 —— 留着会让下一个人以为它还在生效');
});

test('R67-02 · 依赖方向单向：包内下层不得 require app.js（否则成环）', () => {
  const LOWER = ['defs.js', 'util.js', 'listing.js', 'auth.js', 'xml.js'];
  const bad = [];
  for (const f of LOWER) {
    const p = path.join(WEBDAV_DIR, f);
    if (!fs.existsSync(p)) continue;
    const src = read(p);
    if (/require\((['"])\.\/app\1\)/.test(src)) bad.push(f);
  }
  assertEqual(bad.length, 0,
    `${bad.join(', ')} 反向 require 了 ./app —— 依赖必须单向（app → 下层），`
    + '成环的表现是「某个导出在启动时是 undefined」，而不是报错');

  // 反向自检：app.js 自身确实 require 了下层（否则上一条会恒绿）
  const appSrc = read(path.join(WEBDAV_DIR, 'app.js'));
  const usesLower = LOWER.filter((f) => new RegExp(`require\\(['"]\\./${f.replace('.js', '')}['"]\\)`).test(appSrc));
  assert(usesLower.length >= 3,
    `app.js 应至少 require 3 个下层模块（当前 ${usesLower.join(',') || '无'}）—— `
    + '若为 0，说明它自己又写了一份实现，上一条的方向判据也就失去意义');
});

test('R67-03 · 入口文件只做生命周期：不得再注册任何路由', () => {
  const entry = read(WEBDAV_ENTRY);
  const code = entry.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  /* 负向判据必须剥注释：本文件的说明注释里正当地提到了 `app.put(` 之类的字样 */
  const routes = code.match(/\bapp\.(get|put|post|delete|head|options|all|use)\s*\(/g) || [];
  assertEqual(routes.length, 0,
    `webdav-server.js 里仍有 ${routes.length} 处路由/中间件注册（${routes.join(', ')}）—— `
    + '协议实现必须留在 server/webdav/app.js，否则拆包会在几个月内被「顺手写回来」磨平');

  /* 正向自检：真正的注册点必须仍在 app.js 里，否则「入口很干净」可以靠「哪儿都没有」达到 */
  const appCode = read(path.join(WEBDAV_DIR, 'app.js'));
  const appRoutes = appCode.match(/\bapp\.(get|put|post|delete|head|propfind|mkcol|options)\s*\(/g) || [];
  assert(appRoutes.length >= 5,
    `app.js 应至少有 5 处路由注册（当前 ${appRoutes.length}）—— 为 0 说明路由已不在它手里`);
});

/* ==================================================================== */
/* R108 · 请求体解析面：匿名未知路径不得先缓冲                             */
/* ==================================================================== */

/**
 * **为什么要一条行为断言，而不是「源码里有没有那个正则」**：
 *
 * `express.json()` 的语义是「先把整个 body 读进内存，再 next()」。它一旦被挂成
 * 应用级中间件，`POST /随便什么` 只要带 `Content-Type: application/json`，就会在
 * 判定 404 **之前**完整缓冲一遍（上限 2MB）—— 不需要命中任何路由、不需要任何凭据。
 * 这是纯内存放大面：N 个并发即 2N MB 常驻。
 *
 * 判据必须落在**实际被执行的那一层**：源码里写着「按前缀收窄」不代表运行时真的收窄了
 * （例如中间件顺序变了、或者另一条挂在 `/` 上的路由又补了一份全局解析器）。
 * 因此这里起**真实入口**发真请求，用状态码区分两种世界：
 *
 *   · 仍被应用级解析器吃掉 ⇒ body 超 2MB ⇒ **413**
 *   · 压根没读 body        ⇒ 走到 404 兜底 ⇒ **404**
 *
 * 另外两条正向对照防止「把解析器删了」也能通过：`/api` 与 `/s` 必须仍然解析 JSON。
 */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function postRaw(port, pathname, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForApp(port, child) {
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) return false;
    const ok = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', timeout: 500 }, () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return true;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return false;
}

test('R108-01 · 匿名未知路径不得缓冲请求体（未命中路由前不解析 JSON）', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-body-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      S3_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    const up = await waitForApp(port, child);
    assert(up, '前置：真实入口应能在回环上监听（独立数据目录）');

    /* ① 3MB > 2MB 上限：若 body 被缓冲，body-parser 会先回 413 */
    const huge = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });
    assertEqual(await postRaw(port, '/totally-unknown-path', huge, 'application/json'), 404,
      '匿名未知路径不得先读请求体：超 2MB 仍应落到 404（413 说明解析器又在全路径生效了）');

    /* ② 正向对照：/api 仍要解析 JSON（口令错 ⇒ 401，而不是 415/400 解析失败） */
    assertEqual(
      await postRaw(port, '/api/auth/login', JSON.stringify({ username: 'admin', password: 'x' }), 'application/json'),
      401,
      '/api 下的 JSON 必须照旧解析：登录用错口令应回 401，不是解析失败',
    );

    /* ③ 正向对照：/s 仍要解析 JSON（坏 JSON ⇒ 400 entity.parse.failed，而不是被跳过） */
    assertEqual(await postRaw(port, '/s/abcdef', '{bad json', 'application/json'), 400,
      '/s 下的 JSON 必须照旧解析：坏 JSON 应回 400（若被跳过会变成 404 页面）');
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
  }
});

