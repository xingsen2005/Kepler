/**
 * 第 74 轮护栏 —— 《Kepler 漏洞评估报告》复核轮
 *
 * ## 这一轮在修什么
 *
 * 报告列了 9 条（F-01~F-09）。复核后**只有 F-04 需要动代码**：其余或事实不成立、
 * 或属报告自己已承认的设计约束（逐条判定见 `Audit_illusion_report.md`）。
 *
 * F-04 有两条独立的问题，各配一条护栏：
 *
 *  ① **`SEC-05` 的判据与实际相反**。`Develop_Document.md` 台账写「全库无 `scryptSync`」，
 *     而 `server/backup.js` 一直在用它 —— 那句判据**从来没有任何机器在验证**。
 *     静态判据放在 `tests/invariants.test.js`（那里已有全库扫描器），本文件不重复。
 *  ② **同步 scrypt 阻塞事件循环**。`N=131072 / r=8 / p=1` 实测阻塞主线程 ≈ 530ms，
 *     期间 WebDAV、下载、全部 API 排队。行为判据在本文件（R74-01）。
 *
 * ## 为什么行为判据不用墙钟阈值
 *
 * 「`seal()` 花了几百毫秒」是**性能**判据，换台慢机器就假红（`Develop_Document.md`
 * 「测试护栏编写约定」明确要求确定性探针）。这里用的是**语义**判据：
 * 在一个 `setTimeout(0)` 与 `seal()` 之间赛跑 —— 异步实现下定时器必然先插进来，
 * 同步实现下它只能等 KDF 算完。与机器快慢无关。
 *
 * ⚠️ 配置会真实落盘，`S3_DATA_DIR` 必须在 require 之前指到临时目录。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('r70-');
process.env.S3_DATA_DIR = tmp.dir;

const backup = require(path.join(ROOT, 'server', 'backup.js'));

/** 断言 promise 一定 reject，且错误信息满足给定条件 */
async function assertRejectsLike(fn, predicate, msg) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`断言失败：期望抛错但成功返回（${msg}）`);
  if (!predicate(err)) throw new Error(`断言失败：${msg}\n  实际错误：${err.message}`);
}

/* ==================================================================== */
/* R74-01 · 行为判据：KDF 必须让出主线程                                  */
/* ==================================================================== */

test('R74-01 · 导出码加密期间事件循环不得被占死（定时器必须能插进来）', async () => {
  assertEqual(backup.seal.constructor.name, 'AsyncFunction',
    'R74-01：`backup.seal()` 必须是 async 函数 —— 它内部的 KDF 已改为异步 scrypt');

  /**
   * 判据：`seal()` 是异步的，其内部的 KDF 必须**让出**主线程。先挂一个
   * `setTimeout(0)`，再看它是否在 `seal()` 完成**之前**触发。同步 scrypt 会让这个
   * 定时器在整个 KDF 期间无法执行 —— 于是 `timerFired === false`，本条红。
   *
   * 注意判据的**位置**：`timerFired` 必须在 `await seal(...)` 之后、且不经过任何
   * 额外 await 就读。写成 `await seal(); await timer; if (timerFired)` 是错的 ——
   * 那时定时器早就跑完了，无论实现同步还是异步都会绿（本项目记档过的
   * 「执行条件压根没跑到」型假绿）。
   */
  let timerFired = false;
  const timer = new Promise((resolve) => {
    setTimeout(() => { timerFired = true; resolve(); }, 0);
  });

  const sealed = await backup.seal(backup.buildCode(), 'backup-pass-123');
  const firedBeforeSealDone = timerFired;
  await timer;

  assertEqual(firedBeforeSealDone, true,
    'R74-01：`seal()` 返回之前 `setTimeout(0)` 没能插进来 ⇒ 主线程被整段占住。'
    + '同步 scrypt 的典型表现就是"函数返回时定时器才一起饿醒"，生产环境里这 500ms 就是全站停顿');

  // 正向对照：改完必须还能正常往返，不能"为了不阻塞"把功能改坏
  const out = await backup.open(sealed, 'backup-pass-123');
  assertEqual(JSON.stringify(out), JSON.stringify(backup.decodeCode(backup.buildCode())),
    'R74-01：异步化之后导出码必须仍然可以完整往返（这条防的是"改对了性能、改坏了功能"）');
});

/* ==================================================================== */
/* R74-02 · 历史导出码必须仍然解得开                                      */
/* ==================================================================== */

test('R74-02 · 用旧 KDF 参数（N=16384）封出的导出码仍可解开', async () => {
  /**
   * R69 把 `SCRYPT` 的 N 从 16384 提到 131072，并靠「新参数 → 旧参数」两级回退
   * 兼容历史导出码。本轮把回退改成了 async 循环 —— 必须确认**第二级仍然走得到**，
   * 否则线上那些用旧版导出的码会在一夜之间全部失效，且表现是"密码错误"
   * （用户会去怀疑密码，而不是怀疑版本）。
   *
   * 这里**刻意硬编 16384**，不读 `backup.SCRYPT_LEGACY`：它是一个**历史事实**
   * （旧版真的用这个值封过码），不是实现细节。哪天有人把 `SCRYPT_LEGACY` 改成
   * 别的值，这条就该红 —— 因为那些旧码的解密能力是承诺，不是配置。
   */
  const LEGACY_N = 16384;
  const crypto = require('crypto');
  const code = backup.buildCode();
  const pw = 'backup-pass-123';
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, 32, {
      N: LEGACY_N, r: 8, p: 1, maxmem: 192 * 1024 * 1024,
    }, (e, k) => (e ? reject(e) : resolve(k)));
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(code, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const legacyCode = [backup.SEAL_HEAD, b64u(salt), b64u(iv), b64u(tag), b64u(ct)].join('.');

  const out = await backup.open(legacyCode, pw);
  assertEqual(JSON.stringify(out), JSON.stringify(backup.decodeCode(code)),
    'R74-02：旧参数封出的导出码必须仍然解得开 —— 异步化的两级回退不能只剩一级');
});

/* ==================================================================== */
/* R74-03 · 两类失败必须可区分                                            */
/* ==================================================================== */

test('R74-03 · 结构损坏（能解开但不是备份）不得报成「密码错误」', async () => {
  /**
   * `open()` 的两级 KDF 回退是一个 try/catch 循环，而 `decodeCode()` 抛的是
   * 「解开了但不是备份内容」。若把 `decodeCode()` 留在 try 里，它会被当成
   * "这级参数不对"而 continue —— 用户于是被告知"密码错误"，而他真正的处境是
   * "码是对的，里面不是备份"。这两种失败对应**完全不同的可执行动作**
   * （重输密码 vs 重新复制一份正确的导出码），必须能区分。
   */
  const good = await backup.seal('这不是备份码的内容', 'backup-pass-123');
  await assertRejectsLike(
    () => backup.open(good, 'backup-pass-123'),
    (e) => !/密码错误/.test(e.message),
    'R74-03：结构错误被报成了「密码错误」—— 两级 KDF 回退把 decodeCode 的异常一起吞了',
  );
});

/* ==================================================================== */
/* R74-04 · 路由必须 await（否则会把 Promise 当码串返回）                 */
/* ==================================================================== */

/**
 * 扫一段源码里所有未 `await` 的 `backup.seal()` / `backup.open()` 调用。
 *
 * ⚠️ 为什么用 AST 而不是正则：本文件的**目标文件 `server/routes/backup.js`
 * 第 18 行就有一句文档注释**写 `backup.open()`。正则（哪怕带 lookbehind）照样
 * 命中它 ⇒ 判据被注释判红，真实的 `await` 调用反倒没人看。本项目记档过的
 * 「判据被注释满足 / 被注释干扰」情形，正反两面都踩过。
 *
 * AST 天然不含注释，且能准确回答"这个 `CallExpression` 是不是 `AwaitExpression`
 * 的操作数"——判据落在实际执行的那一层上。
 *
 * @param {string} src 源码
 * @returns {Array<{line:number,name:string}>} 未 await 的调用点
 */
function findUnawaitedCalls(src) {
  const espree = require('espree');
  const ast = espree.parse(src, { ecmaVersion: 2023, sourceType: 'script', loc: true });
  const parents = new Map();

  (function link(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    parents.set(node, parent);
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const val = node[key];
      if (Array.isArray(val)) val.forEach((c) => link(c, node));
      else if (val && typeof val.type === 'string') link(val, node);
    }
  }(ast, null));

  const hits = [];
  for (const [node, parent] of parents) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) continue;
    if (!callee.object || callee.object.type !== 'Identifier' || callee.object.name !== 'backup') continue;
    const name = callee.property && callee.property.name;
    if (name !== 'seal' && name !== 'open') continue;
    // 只要被 await 直接包住就通过；其余（裸调用、赋值给变量后再 await 也行——但那是
    // 罕见写法，这里按"必须直接 await"从严，宁可贵一点也不要漏判）
    if (parent && parent.type === 'AwaitExpression' && parent.argument === node) continue;
    hits.push({ line: node.loc.start.line, name });
  }
  return hits;
}

test('R74-04 · 备份路由必须 await seal/open（漏了 await 会把 Promise 发出去）', () => {
  /**
   * `seal` / `open` 改 async 后，路由侧**漏一个 `await`** 的后果极隐蔽：
   * JSON 序列化一个 Promise 得到 `{}`，接口仍返回 200 —— 前端拿到空对象，
   * 报错落在几百行外的"导出码格式不正确"。这类"改了签名没改调用点"是本项目
   * 反复记档的慢性病，所以顺带钉一条**调用点层**的静态判据。
   */
  // ---- 判据自检：先证明扫描器真的能抓到违规（否则整条用例是空转）----
  // 注：`await` 不能出现在 script 顶层，样例统一包进 async 函数体
  const wrap = (body) => `async function f(){ ${body} }`;
  assertEqual(findUnawaitedCalls(wrap('const c = backup.seal(plain, pw);')).length, 1,
    'R74-04：扫描器抓不到裸调用 `backup.seal(...)` —— 判据本身失效，本条会永远绿');
  assertEqual(findUnawaitedCalls(wrap('const d = backup.open(code, pw);'))[0].name,
    'open', 'R74-04：扫描器没认出 `backup.open(...)`');
  assertEqual(findUnawaitedCalls(wrap('const c = await backup.seal(plain, pw);')).length, 0,
    'R74-04：扫描器把带了 await 的调用也判成违规 —— 会假红');
  assertEqual(findUnawaitedCalls('// 注释里写 backup.open() 不算调用\nconst x = 1;').length, 0,
    'R74-04：扫描器把注释里的文字当成调用 —— 目标文件第 18 行正是这种情形');

  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'backup.js'), 'utf8');

  // ---- 扫描范围自检：目标文件里必须真的有这两处调用 ----
  const total = (src.match(/backup\.(seal|open)\s*\(/g) || []).length;
  assert(total >= 2,
    `扫描范围自检：\`server/routes/backup.js\` 里应至少出现 2 处 seal/open，实际 ${total} 处 —— 路由可能已改名，判据需同步调整`);

  const bad = findUnawaitedCalls(src);
  assertEqual(bad.length, 0,
    'R74-04：`server/routes/backup.js` 里有 backup.seal/open 调用没有 await —— '
    + '`seal()` / `open()` 已是 async，漏 await 会把 Promise 直接序列化成 `{}` 返回。'
    + `命中：${bad.map((b) => `L${b.line} backup.${b.name}()`).join(', ')}`);

  // ---- 正向对照：确实存在带 await 的调用（防"根本没调用"型空转）----
  assert(/await\s+backup\.(seal|open)\s*\(/.test(src),
    'R74-04：没有找到任何 `await backup.seal/open(...)` —— 判据空转，需同步调整本用例');
});

test.after(async () => {
  await cleanupTempDir(tmp);
});
