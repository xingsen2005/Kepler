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

  // 矩阵：至少要覆盖声明的两端（engines: >=18）与当前 LTS，以及两个平台
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    assert(code.includes(os), `矩阵里必须有 ${os} —— 只跑 Linux 会漏掉换行/路径类问题`);
  }
  for (const v of ["'18'", "'20'", "'22'"]) {
    assert(code.includes(v), `矩阵里必须有 Node ${v}（engines 声明 >=18，就得真的验 18）`);
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
