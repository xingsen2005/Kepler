/**
 * 反向对照（mutation check）通用脚本
 *
 * 项目约定：每加一条回归护栏，都要**退回旧实现确认它必须 FAIL** —— 否则护栏可能只是
 * 「看起来覆盖了」，实际上根本没打在那条路径上（历史上出现过多次：护栏覆盖了它
 * 承诺之外的地方）。
 *
 * 用法：
 *   node scripts/reverse-check.js <目标文件(相对项目根)> <锚点文件> <替换文件> <测试文件> <期望最小失败数>
 *
 * 更简单的用法：直接改下面的 CASES 后 `node scripts/reverse-check.js`（见文件末尾）。
 *
 * 崩溃安全：先断言锚点命中 → 备份 → 变异 → 跑测试 → **无论如何都还原**
 * （exit / SIGINT / SIGTERM / uncaughtException 均强制还原）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * 跑一个测试文件并返回它的输出。
 *
 * 首选 `spawnSync`（同步、最简单）；但某些 Windows 环境下 `spawnSync` 恒返回
 * `status=null / error=EBUSY`（本项目 RE-03 / R7-07 两条用例也栽在同一处环境问题上），
 * 此时**静默退回异步 `spawn`** —— 否则 `fail` 计数取不到，每条反向对照都会被误判成失败。
 *
 * 变异期间额外注入 `REVERSE_CHECK_MUTATING=1`：此时工作区里的 anchor 是被**故意**
 * 删掉的，`invariants.test.js` 里「反向变异 anchor 必须在各自的 file 内命中」那条
 * 自检会**必然**变红 —— 它是针对提交态锚点腐烂设计的，变异态下必须豁免。否则
 * 每条反向对照都会凭空 +1 个红项，掩盖「真实不变量到底抓没抓到」这一唯一要看的信息。
 */
function runTestFile(testFile) {
  const args = ['--test', path.join('tests', testFile)];
  const env = { ...process.env, REVERSE_CHECK_MUTATING: '1' };
  return new Promise((resolve) => {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env });
    if (r.status !== null && !r.error) return resolve((r.stdout || '') + (r.stderr || ''));
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve(out));
    p.on('close', () => resolve(out));
  });
}

async function runCase({ name, file, anchor, replacement, mutations, testFile, minFail }) {
  const target = path.join(ROOT, file);
  const backup = target + '.reversebak';
  let restored = false;

  /**
   * 还原 = 「写回源码」+「删掉备份」两件事，**必须分开报错**。
   *
   * 早期实现把两步放进同一个 try：删备份失败（例如被环境的批量删除护栏拦下）
   * 也会打印「还原失败！请手动用 X.reversebak 覆盖 X」—— 而实际上源码**已经**写回，
   * 这句提示会让人白跑一趟去排查并不存在的「工作区被留在变异态」。
   * 真正的灾难只有一种：`copyFileSync` 失败（源码仍是变异后的内容）。
   */
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, target);
        console.log('  [restore] 已还原 ' + file);
        try {
          fs.unlinkSync(backup);
        } catch (e) {
          console.warn('  [restore] 备份未能删除（源码已还原，可手动删）：' + backup
            + '（' + e.message + '）');
        }
      }
    } catch (e) {
      console.error('  [restore] 还原失败！工作区可能仍是变异态，请手动用 '
        + backup + ' 覆盖 ' + target + '：', e.message);
    }
    detach();
  };
  /**
   * 四个兜底还原钩子。**每条用例用完必须摘掉** —— 早期版本只 add 不 remove，
   * 跑满 10 条后 `process` 上堆了 40 个监听器，Node 直接抛
   * `MaxListenersExceededWarning`（真正崩溃时反而可能错过还原）。
   */
  const handlers = {
    exit: restore,
    SIGINT: () => { restore(); process.exit(130); },
    SIGTERM: () => { restore(); process.exit(143); },
    uncaughtException: (e) => { console.error(e); restore(); process.exit(1); },
  };
  const detach = () => {
    for (const k of Object.keys(handlers)) process.removeListener(k, handlers[k]);
  };
  process.on('exit', handlers.exit);
  process.on('SIGINT', handlers.SIGINT);
  process.on('SIGTERM', handlers.SIGTERM);
  process.on('uncaughtException', handlers.uncaughtException);

  console.log('\n=== ' + name + ' ===');
  const original = fs.readFileSync(target, 'utf8');
  // 支持一次用例做多步变异（如「把整段代码挪到别处」= 删除 + 插入）
  const steps = Array.isArray(mutations) ? mutations : [{ anchor, replacement }];
  for (const st of steps) {
    if (original.indexOf(st.anchor) < 0) {
      console.error('  ❌ 锚点未命中，未做任何修改：\n     ' + JSON.stringify(st.anchor.slice(0, 120)));
      return false;
    }
  }
  let patched = original;
  for (const st of steps) patched = patched.replace(st.anchor, st.replacement);
  fs.writeFileSync(backup, original);
  fs.writeFileSync(target, patched);
  console.log('  [mutate] 已退回旧实现，跑 ' + testFile + ' …');

  const out = await runTestFile(testFile);
  /**
   * 失败数解析必须同时认两种 reporter 格式：
   *  - TAP（Node 18/20 在**非 TTY**（管道）下的默认）：`# fail 3`
   *  - spec（Node ≥ 22 起成为默认）：`ℹ fail 3`
   * 只认前者时，在 Node 22+ 上每条对照都会解析成 `fail=-1` 而被判失败 ——
   * 实测本机 Node 24 下 `--only=R14-08`（既有条目）同样报 -1，**与变异的正确性无关**。
   * 护栏静默失效比护栏缺失更危险，故此处显式兼容。
   */
  const m = /^(?:#|ℹ)\s*fail\s+(\d+)/m.exec(out);
  const failCount = m ? Number(m[1]) : -1;
  restore();

  if (failCount < minFail) {
    console.error('  ❌ 反向对照失败：退回旧实现后 fail=' + failCount + '（期望 ≥ ' + minFail + '）');
    console.error(out.split('\n').filter((l) => /^(not ok|ok) /.test(l)).join('\n'));
    return false;
  }
  console.log('  ✅ fail=' + failCount + '（期望 ≥ ' + minFail + '）');
  console.log(out.split('\n').filter((l) => /^(not ok) /.test(l)).map((l) => '     ' + l).join('\n'));
  return true;
}

/**
 * R7-07 用：index.js 里 prune 的**调用点**（R11-12 之后它是 `pruneSessions();`），
 * 用于「挪到单实例锁之前」的变异。
 *
 * 注意：这里不再搬整段函数定义（R11-12 把函数抽成 `pruneSessions` 并加了定时器），
 * 只搬**调用点** —— 变异要复现的正是「启动即执行的那一次跑在锁之前」。
 */
const PRUNE_CALL = 'pruneSessions();\n';

/**
 * 全部反向对照用例。**导出**是为了让 `tests/invariants.test.js` 能在测试里
 * 校验「每条 anchor 在自己的 file 内命中」（R11-18：3 条 anchor 悄悄失效了却没人
 * 发现 —— 脚本只会在跑到那一条时才报「锚点未命中」，而没人跑就等于没登记）。
 */
const CASES = [
    {
      name: 'R7-01 · 分片会话不再记录 provider（退回「默认 tencent」）',
      file: 'server/routes/fs.js',
      anchor: '        provider: cfg.provider, // R7-01',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-02 · encryptBuffer 内部恢复 setMeta（元数据回到「先于云端写入」）',
      file: 'server/enc-store.js',
      /**
       * ⚠️ R48 之后锚点必须挪到 `finish` 闭包里，**不能**留在 `return` 那一行：
       * `encryptBuffer` 被拆成「唯一实现 + 执行器」，那把 `finish` 拿到的密文
       * 组装成返回值的闭包是**同步路径与线程路径共用**的那一点，而 crypto 分支的
       * `return finish(...)` 只覆盖同步路径 —— 实测留在 return 上时 fail 从 2 掉到 1
       *（`fs-gateway` 已改走异步入口，走的是池内计算，压根不经过那一行），
       * 反向对照就此**悄悄变弱**。锚在 `finish` 里，两条路径都回到「加密时就写元数据」。
       */
      anchor: '    const finish = (ct, tag) => {\n      meta.crypto.segments[0].tag = tag.toString(\'hex\');\n      return { data: Buffer.concat([CRYPTO_MAGIC, iv, ct, tag]), meta };\n    };',
      replacement: '    const finish = (ct, tag) => {\n      meta.crypto.segments[0].tag = tag.toString(\'hex\');\n      const out = { data: Buffer.concat([CRYPTO_MAGIC, iv, ct, tag]), meta };\n      setMeta(bucket, key, out.meta);\n      return out;\n    };',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R7-03 · WebDAV 删对象不再标记分享链接',
      file: 'server/fs-gateway.js',
      anchor: '  // R7-03：云端确认删除后才标（与「元数据只按已确认删除的 key 清」同一约束）\n  shareStore.markMissingByKeys(cfg.bucket, [k]);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：原 anchor 是「同批确认删除的 key 一并标记…」+ `markMissingByKeys(cfg.bucket, keys)`，
      // R10-03 把该行改成按白名单 `res.okKeys` 标记后，锚点再也不存在 —— 这条等于没登记。
      // 重新指向当前代码（缩进也变了）：仍守同一条纪律（删目录必须标记分享链接）。
      // R23-03：循环收敛到 `deletePrefixAll` 后，标记动作移进网关的 `onDeleted` 回调，
      // 参数名由 `res.okKeys` 变为 `keys`（同一判据），锚点随之更新。
      name: 'R7-03 · WebDAV 删目录不再标记分享链接',
      file: 'server/fs-gateway.js',
      anchor: '    // R7-03：只认**本批确认删除**的 key，绝不按前缀\n    shareStore.markMissingByKeys(cfg.bucket, keys);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-03 · 清空桶不再标记分享链接',
      file: 'server/routes/buckets.js',
      anchor: '      shareStore.markMissingByKeys(cfg.bucket, deletedKeys);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-04 · resolveBucketId 不再认 /dav/*（WebDAV 退回「无桶上下文」）',
      file: 'server/ip-guard.js',
      anchor: "  if (p === '/dav' || p.indexOf('/dav/') === 0) {",
      replacement: '  if (false) {',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      // R36：`writeObject` 新增第 7 个参数 `uploader`，Headers 由字面量改成
      // `Object.assign(...)` —— 旧 anchor 不再命中，锚点随重构一起迁移。
      // 变异**只**改「走不走 p()」这一件事：Headers 保持与现实现逐字相同，
      // 否则就变成「顺带把上传者元数据也丢了」的另一处变异，红的原因就不唯一了。
      name: 'R7-06 · fs-gateway 的 putObject 退回「直接回调式调用」（绕过 p()）',
      file: 'server/fs-gateway.js',
      anchor: "  await p(s3, 'putObject', {\n"
        + "    Bucket: cfg.bucket, Region: cfg.region, Key: k,\n"
        + "    Body: body,\n"
        + '    ContentLength: body.length,\n'
        + '    // R36：WebDAV 上传同样记录上传者（属性面板与网页上传看到的是同一份数据）。\n'
        + '    Headers: Object.assign(\n'
        + "      { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '      uploaderMeta(uploader),\n'
        + '    ),\n'
        + '  });',
      replacement: '  await new Promise((resolve, reject) => {\n'
        + '    s3.putObject({\n'
        + '      Bucket: cfg.bucket, Region: cfg.region, Key: k,\n'
        + '      Body: body,\n'
        + '      ContentLength: body.length,\n'
        + '      Headers: Object.assign(\n'
        + "        { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '        uploaderMeta(uploader),\n'
        + '      ),\n'
        + '    }, (err) => (err ? reject(err) : resolve()));\n'
        + '  });',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-06 · 分片中止退回「直接回调式调用」（绕过 p()）',
      file: 'server/upload-sessions.js',
      anchor: "      const { p } = require('./s3');\n"
        + "      p(s3, 'multipartAbort', { Bucket: o.bucket, Region: o.region, Key: o.key, UploadId: o.uploadId })\n"
        + '        .catch(() => {});',
      replacement: "      s3.multipartAbort({ Bucket: o.bucket, Region: o.region, Key: o.key, UploadId: o.uploadId }, () => {});",
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-03 把回滚集合从「全部复制过的」改成「本次新建的」（`fresh`），
      // 原 anchor `copied.slice(i, i + 1000)` 已不存在 —— 改锚在新写法上，变异不变。
      // R12-04：回滚又被下沉成 `gateway.rollbackCopies()`（唯一实现点），
      // 再改锚到那里 —— 锚在 canonical 上也更耐改。
      name: 'R7-11 · movePrefix 失败后不再回滚（目标留下半份副本）',
      file: 'server/fs-gateway.js',
      anchor: '    const batch = keys.slice(i, i + 1000);',
      replacement: '    const batch = [];',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-12 · 超上限淘汰回到「无条件删除会话」',
      file: 'server/upload-sessions.js',
      // 锚点带上 R7-12 注释：过期分支里有一行一模一样的 `if (!abortRemote(o)) continue;`
      anchor: '      // 云端分片的 UploadId 句柄随之丢失：用户既无法中止、也无法续传，分片持续计费。\n      if (!abortRemote(o)) continue;',
      replacement: '      abortRemote(o);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: '遗留项 · 撤掉 HEAD /s/:id/dl 短路（回到「HEAD 走完整 GET handler」）',
      file: 'server/share-routes.js',
      anchor: "router.head('/s/:id/dl',",
      replacement: "router.post('/s/__never__/dl',",
      testFile: 'audit7-regressions.test.js',
      // 只保证 1 条失败：「失效链接返回 410」这条无论走不走 HEAD 短路都会是 410，
      // 它守的是状态码映射，不是短路本身
      minFail: 1,
    },
    {
      name: 'R7-08 · 撤掉「无人接管」的令牌兜底释放（回到全靠调用方）',
      file: 'server/fs-gateway.js',
      anchor: '      armReaderHandoff(out, releaseReader); // R7-08：无人接管时兜底释放',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-09 · 新增一个「建了就不管」的 setInterval（前端定时器句柄约定）',
      file: 'public/js/main.js',
      anchor: 'function startStatsTimer() {',
      replacement: 'function startStatsTimer() {\n  App._leakTimer = setInterval(() => {}, 1000);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-10 · 存储用量回到「缓存 rejected Promise」（失败永不恢复）',
      file: 'public/js/main.js',
      anchor: '      if (!storageCache) {\n        storageCache = API.storage().catch((e) => { storageCache = null; throw e; });\n      }',
      replacement: '      if (!storageCache) storageCache = API.storage();',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-12 把 prune 抽成 `pruneSessions()` + 定时兜底后，原 anchor
      // （整段 `uploadSessions.prune(...)` 定义）已不存在。改锚在**调用点**上。
      //
      // ⚠️ 坑（R15 实测发现）：早先这条变异是「把 `pruneSessions();` 搬到
      // `const instanceLock = ...` 之前」。但 `pruneSessions` 是**第 340 行的 `const`
      // 箭头函数**，搬到第 315 行之前会先撞 TDZ（`Cannot access before initialization`）
      // → 子进程因**未捕获异常**退出（状态码同样是 1）且一个字节都没写，
      // 于是 audit7 的两条断言（`status===1`、未写 upload-sessions.json）**双双被巧合满足**
      // → `fail=0`。这不是「护栏没抓到」，而是**变异不等价于旧实现**（假绿第六种形态）。
      // 现在改为自包含地复现旧实现的可观测后果：prune 真的在锁之前跑完并触发落盘。
      name: 'R7-07 · prune() 挪回单实例锁之前',
      file: 'server/index.js',
      mutations: [
        { anchor: PRUNE_CALL, replacement: '' },
        {
          anchor: "const instanceLock = require('./instance-lock');",
          replacement: "require('./upload-sessions').prune(() => null); // 变异：prune 回到单实例锁之前\n\nconst instanceLock = require('./instance-lock');",
        },
      ],
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-05 · 令牌密钥重新与密码哈希解绑（改密后旧令牌仍有效）',
      file: 'server/enc-store.js',
      anchor: "    .update(String(s.passwordHash || ''))\n    .update(String(s.passwordSalt || ''))",
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R7-03 · 彻底删桶不再标记分享链接',
      file: 'server/routes/buckets.js',
      anchor: '    const deadLinks = shareStore.markMissingByBucket(b.bucket);',
      replacement: '    const deadLinks = 0;',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D3 · GET /users 对普通用户返回全部（回到「可枚举全部账户」）',
      file: 'server/routes/users.js',
      anchor: "  res.json({ users: all.filter((u) => u.id === me.id), scope: 'self' });",
      replacement: "  res.json({ users: all, scope: 'all' });",
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D1 · tryAcquire 开始记录来源 IP（文档已声称「不记录」，代码必须一致）',
      file: 'server/share-store.js',
      anchor: '  l.downloads = Number(l.downloads) + 1;\n  l.lastDownloadAt = new Date().toISOString();',
      replacement: '  l.downloads = Number(l.downloads) + 1;\n  l.lastDownloadAt = new Date().toISOString();\n  l.lastDownloadIp = (l.lastDownloadIp || \'\');\n  l.clientIps = (l.clientIps || []).concat([\'1.2.3.4\']);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D1/D4 · 把被证伪的措辞写回 README（漂移护栏必须报警）',
      file: 'README.md',
      anchor: '托管链接可查看**已下载次数与最近下载时间**（分享下载不记录来源 IP，IP 仅在登录 / 解锁限流的告警日志中出现）。',
      replacement: '支持监控每次下载的时间、次数与来源 IP，可即时拉黑（即使对方正在下载）。',
      testFile: 'docs-sync.test.js',
      minFail: 1,
    },
    {
      name: '文档路由覆盖 · ipguard 的 enabled 子路由压回「家族记法」',
      file: 'Develop_Document.md',
      anchor: '`/ipguard/rules/:id` · `PUT /ipguard/rules/:id/enabled`',
      replacement: '`/ipguard/rules/:id`',
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: '文档路由覆盖 · /fs/upload/abort 压回 `/abort`',
      file: 'Develop_Document.md',
      anchor: '`/fs/upload/complete` · `POST /fs/upload/abort`',
      replacement: '`/fs/upload/complete` · `/abort`',
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },

    /* ======================= 第 8 轮（原 ANALYSIS-ROUND8.md，已并入开发文档） ======================= */

    {
      name: 'R8-01 · 微信签名调用漏传报文主体（实参整体左移 → 必然抛 TypeError）',
      file: 'server/payment-gateway.js',
      anchor: '    Authorization: wechatAuthorization(method, path, raw, cfg, { timestamp, nonce }),',
      replacement: '    Authorization: wechatAuthorization(method, path, cfg, { timestamp, nonce }),',
      testFile: 'payment-gateway.test.js',
      minFail: 1,
    },
    {
      // R11-18：R10-05 之后该常量改为 `= LIMITS.MAGIC_SYNC_MAX`（单一来源），
      // 原 anchor `const MAGIC_CHUNK_MAX = 5 * 1024 * 1024;` 已不存在。改锚在新写法上，
      // 变异仍是「把上限压到 4MB」（低于 S3 非末片 5MB 的协议下限）。
      name: 'R8-02 · magic 分片上限压到 4MB（低于 AWS S3 的 5MB 分片下限）',
      file: 'server/routes/fs.js',
      anchor: 'const MAGIC_CHUNK_MAX = LIMITS.MAGIC_SYNC_MAX;',
      replacement: 'const MAGIC_CHUNK_MAX = 4 * 1024 * 1024;',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-03 · 明文覆盖写入不再清旧密文元数据（magic 静默损坏 / crypto 中途死亡）',
      file: 'server/enc-store.js',
      anchor: '  if (removeMeta(bucket, key)) { flushMeta(); return true; }',
      replacement: '  if (false) { flushMeta(); return true; }',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R8-06：恢复「已标记 missing 即短路」的旧形态。
       *
       * ⚠️ R14-10 之后探测函数外面包了一层 `singleFlight`，且缓存读取抽象成了
       * `existsHit()` —— 旧 anchor（`const now = Date.now();` + `existsProbe.get`）
       * 已不存在，必须跟着改。这类「重构把 anchor 改没了」由
       * `tests/invariants.test.js` 的「反向变异 anchor 必须在各自的 file 内命中」抓出
       * （本次就是它报的红），否则这条对照会静默失效。
       */
      name: 'R8-06 · probeObjectMissing 恢复「已标记即短路」（clearMissing 变死代码）',
      file: 'server/share-routes.js',
      anchor: '  const hit = existsHit(l.id, Date.now());\n  if (hit) return hit.missing;',
      replacement: '  if (l.missingAt) return true;\n  const hit = existsHit(l.id, Date.now());\n  if (hit) return hit.missing;',
      testFile: 'share-deleted.test.js',
      minFail: 1,
    },
    {
      name: 'R8-09 · 503 分支不再回滚下载计数（服务端故障静默吞掉用户配额）',
      file: 'server/share-routes.js',
      anchor: '      shareStore.release(l.id);\n      return renderPage(res, 503, {',
      replacement: '      return renderPage(res, 503, {',
      testFile: 'share-deleted.test.js',
      minFail: 1,
    },
    {
      name: 'R8-11 · list-cache 键丢掉 kind 命名空间（list / search 互相命中）',
      file: 'server/list-cache.js',
      // R21-11 把 `keyOf` 的每一段加了 `seg()` 消毒（剥掉分隔符 `\u0000`），
      // anchor 随之更新 —— 变异仍然只针对「丢掉 kind」这一件事。
      anchor: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].map(seg).join(SEP);',
      replacement: '  return [bucket, prefix, marker, maxKeys, delimiter].map(seg).join(SEP);',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-12 · 当前密码错误改回 401（前端会当成会话过期并强制登出）',
      file: 'server/routes/webauthn.js',
      anchor: "      return res.status(403).json({ error: '密码不正确，无法开启 Windows Hello' });",
      replacement: "      return res.status(401).json({ error: '密码不正确，无法开启 Windows Hello' });",
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-21 · 分片列举缓存写入前不再清扫（回到只增不减）',
      file: 'server/routes/_shared.js',
      anchor: '    sweepFragmentCache(); // R8-21：写入前先清扫 + 兜住硬上限\n',
      replacement: '',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    // R11-18 · 已删除：R8-24 的变异「`l.bucket && l.bucket !== bucket` → `l.bucket !== bucket`」
    // 与下面 R9-07 那一条**互为反向**（R9-07 复核后判定严格口径才是对的，把 R8-24 的结论推翻了），
    // 因此这条的「变异方向」现在等于修复方向，不是变异。且它引用的那行代码在 R9-07 之后
    // 已不存在（现为 `if (l.bucket !== bucket) continue;`）—— 保留只会让脚本报锚点未命中。
    // 该类别由 R9-07 那一条（严格口径 = 正解）守住。
    {
      name: 'R8-25 · create() 不再做跨链接订单裁剪（删链接后订单永久滞留）',
      file: 'server/payment-orders.js',
      anchor: '  pruneGlobal(); // R8-25：跨链接的兜底上限（自身已带 O(1) 前置判断，超限才排序）\n',
      replacement: '',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },

    /* ======================= 第 9 轮（原 ANALYSIS-ROUND9.md，已并入开发文档） ======================= */

    {
      name: 'R9-01 · WebDAV 目录 COPY/MOVE 去掉自嵌套守卫（可复制到自身子目录 → 无界递归）',
      file: 'server/webdav/app.js',
      anchor: "      if ((dstKey.replace(/\\/+$/, '') + '/').startsWith(srcKey)) {",
      replacement: '      if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-02 · deleteMultipleObject 丢弃厂商 <Error>（调用方只能拿到空列表 → 误判全部成功）',
      file: 'server/s3-client.js',
      anchor: "      for (const blk of tagAll(body, 'Error')) {",
      replacement: '      for (const blk of ([])) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：第 11 轮把 routes/fs.js 的第 5 份内联副本收敛到 `deleteMultipleConfirmed`
      // 后，判据只剩 `server/s3.js` 这一处（唯一实现点），原 anchor 不存在了 —— 改锚到那里。
      name: 'R9-02 · 批量删除判据退回黑名单（未确认删除的对象被静默丢弃）',
      file: 'server/s3.js',
      anchor: '    if (!okSet.has(k) && !errMap.has(k)) {',
      replacement: '    if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-03 · copyObject 回退到 copyMeta（源无元数据时不清目标 → 陈旧密文元数据残留）',
      file: 'server/fs-gateway.js',
      anchor: '  const metaCopied = encStore.reconcileAfterWrite(cfg.bucket, dstK, srcMeta || null);',
      replacement: "  encStore.copyMeta(cfg.bucket, srcK, cfg.bucket, dstK);\n  const metaCopied = 0;",
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-04 · readObject 不再把 Range 交给云端（回 200 + 全量长度却只发一部分）',
      file: 'server/fs-gateway.js',
      anchor: '  const cloudRange = served ? `bytes=${served.start}-${served.end}` : null;',
      replacement: '  const cloudRange = null;',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-09 之后闸门变成 `statusQueryDue(order) && payStatusLimiter(ip).ok`，
      // 变异只拆掉限流那一半（保留 statusQueryDue），保证变异后仍是「真的要查单」。
      // R11-18：本条的锚点在 R10-09 之后被改写（闸门顺序变了），按「R9-05」检索会漏，
      // 故登记 `原编号` 并在 name 里同时保留两个编号
      原编号: 'R9-05',
      name: 'R10-09（原 R9-05）· /pay/status 去掉按 IP 预算闸门（R8-20 节流可被绕过）',
      file: 'server/share-routes.js',
      anchor: '    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {',
      replacement: '    if (statusQueryDue(order) && true) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-06 · WebDAV 目录 MOVE 去掉 Overwrite:F 判定（目标已存在仍静默覆盖）',
      file: 'server/webdav/app.js',
      /**
       * ⚠️ R14 复核修正：旧 anchor 是**一整行注释**。
       * `tests/invariants.test.js` 的 anchor 自检要先剥注释才能防住「anchor 被删、
       * 字面留在注释里」的假活 —— 而纯注释 anchor 剥完只剩空白，于是「命中」恒真、
       * 「唯一性」得到 67 这种荒谬计数（实测）。它此前一直"绿"，靠的是源码里到处是空白。
       * 改用紧随其后的**代码行**：既唯一（实测恰 1 处），也真正落在变异要打的地方。
       */
      anchor: '        if (!overwrite && await destinationExists(s3, cfg, dstKey, true)) {',
      replacement: '        if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-07 · markMissingByBucket 回到宽松口径（跨桶误标 + 历史链接被永久 410）',
      file: 'server/share-store.js',
      anchor: '    if (l.bucket !== bucket) continue;',
      replacement: '    if (l.bucket && l.bucket !== bucket) continue;',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-01 之后「测试专用开关」已删除，改由 exitPathWritable() 判定目录本身。
      // 变异直接还原成旧实现的「无条件 mkdirSync」，新的行为护栏必须变红。
      // R11-18：同上 —— 锚点是 R10-01 之后的新写法，沿用 R9-08 的名字会漏检索
      原编号: 'R9-08',
      // R12-03：私有副本 `exitPathWritable()` 已删除，退出路径改调唯一实现点
      name: 'R10-01（原 R9-08）· 退出路径退回「无条件 mkdirSync」（删掉的目录被退出钩子复活）',
      file: 'server/upload-sessions.js',
      anchor: '    if (!secureStore.exitPathWritable(DATA_DIR)) return;',
      replacement: '    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-09 · encryptBuffer 去掉 magic 同步上限（超大缓冲同步加密数秒）',
      file: 'server/enc-store.js',
      anchor: "  if (s.mode === 'magic' && buf && buf.length > LIMITS.MAGIC_SYNC_MAX) {",
      replacement: '  if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-09 · 续传残留口去掉分片大小复检（旧会话仍可提交超限分片）',
      file: 'server/routes/fs.js',
      // R45：上限从裸 `MAGIC_CHUNK_MAX` 换成 `magicChunkCap(sess.provider)`（UCloud 的
      // 定长分片是 8MB，拿 5MB 去比会把合法会话误判成超限），锚点随判据形态同步迁移；
      // 变异语义不变（整个复检关掉 → 旧会话仍可提交超限分片）。
      anchor: "    } else if (encStore.currentMode() === 'magic' && sess.chunkSize > magicChunkCap(sess.provider)) {",
      replacement: '    } else if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-10 · enc.js 取消标记失效（用户主动取消被当成「无法连接本地服务」报错）',
      file: 'public/js/enc.js',
      anchor: '      if (isCancelled(e)) return;',
      replacement: '      if (false) return;',
      testFile: 'frontend.test.js',
      minFail: 1,
    },

    /* ======================= 第 10 轮（原 ANALYSIS-ROUND10.md，已并入开发文档） ======================= */

    {
      name: 'R10-02 · /fs/move 的 newKey 去掉文件夹尾斜杠（目录层级丢失 + 元数据漂移）',
      file: 'server/routes/fs.js',
      anchor: "      const newKey = normalizeKey(targetPrefix + baseName(key) + (isFolder ? '/' : ''));",
      replacement: '      const newKey = normalizeKey(targetPrefix + baseName(key));',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // 真正的旧行为是「整批按成功处理」（`okKeys = list`）。只把 errMap 那段改掉
      // 并不会影响 `okKeys`，护栏不会变红 —— 变异必须真的等价于旧实现。
      name: 'R10-03 · 批量删除判据退回「整批按成功」（未确认删除也进入元数据清理）',
      file: 'server/s3.js',
      anchor: '  const okKeys = list.filter((k) => okSet.has(k));',
      replacement: '  const okKeys = list.slice();',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-04 · migratePrefix 回到「清整个目标前缀」（目录 MOVE 误删目标已有元数据）',
      file: 'server/enc-store.js',
      anchor: '   const overwrite = (opts && opts.overwriteRelKeys instanceof Set) ? opts.overwriteRelKeys : null;',
      replacement: '   const overwrite = new Set(Object.keys(files).filter((k) => k.startsWith(to)).map((k) => k.slice(to.length)));',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-05 · init 的 simple/multipart 分界不再感知加密模式（5–8MB 死路）',
      file: 'server/routes/fs.js',
      // R45：这条三元表达式被包进了 `Math.min(<此式>, providers.putObjectMaxBytes(...))`
      // （直传分界同时受厂商单请求上限约束）⇒ 尾部 `;` 变 `,`、缩进由 6 空格变 8 空格，
      // 锚点与替换同步迁移；变异语义不变（magic 分支退回裸 SIMPLE_THRESHOLD → 5–8MB 又成死路）。
      anchor: '        ? Math.min(SIMPLE_THRESHOLD, MAGIC_CHUNK_MAX)\n        : SIMPLE_THRESHOLD,\n      providers.putObjectMaxBytes(cfg.provider)',
      replacement: '        ? SIMPLE_THRESHOLD\n        : SIMPLE_THRESHOLD,\n      providers.putObjectMaxBytes(cfg.provider)',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-06 · WebDAV MOVE 删源后不标记分享链接（管理端长期显示有效）',
      file: 'server/fs-gateway.js',
      anchor: '  shareStore.markMissingByKeys(cfg.bucket, [fromKey]);',
      replacement: '  // 变异：MOVE 删源不标记分享链接',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-07 · WebDAV HEAD 对任何 Range 都宣告 206（与 GET 的退化不一致 → 拼装损坏）',
      file: 'server/webdav/app.js',
      anchor: '        if (rh && gateway.rangeServable(st)) {',
      replacement: '        if (rh) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-08 把上限抽成 `chunkCap`（缺 chunkSize 时回落硬上限）后，
      // 原 anchor 已不存在 —— 改锚在 `chunkCap` 判定上，变异仍是「完全不校验」。
      name: 'R10-08 · /fs/upload/chunk 不校验分片大小（超大分片同步阻塞数秒）',
      file: 'server/routes/fs.js',
      anchor: '    if (req.body.length > chunkCap) {',
      replacement: '    if (false) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-10 · 分片 complete 的用量缓存修正退回手拼 cfg（缺 secretId → 恒不命中）',
      file: 'server/routes/fs.js',
      // R27-04：R10-10 的记账已从 `sess.size` 改为**实际字节** `actualBytes`，
      // 原 anchor（`adjustStorageCache(sess.size, sessCfg)`）已不存在。变异语义不变：
      // 仍是把「完整 cfg」退回「缺 secretId 的手拼对象」→ 缓存键永不相等 → 修正恒为空操作。
      anchor: '    adjustStorageCache(actualBytes, sessCfg);',
      replacement: '    adjustStorageCache(actualBytes, { bucket: sess.bucket, region: sess.region, provider: sess.provider, credentialId: sess.credentialId });',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · Overwrite 判据漏掉「目标是已存在的文件」',
      file: 'server/webdav/listing.js',
      anchor: '  if (bare && await head(bare)) return true;',
      replacement: '  if (false && await head(bare)) return true;',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · Overwrite 判据漏掉「目标是空目录（仅占位对象）」',
      file: 'server/webdav/listing.js',
      // ⚠ anchor 必须唯一：`if (await head(prefix)) return true;` 在 `destinationExists()`
      // 里出现**两次**（文件源分支 / 目录源分支），而 `String.replace` 只改**首处** ——
      // 只写单行 anchor 会命中文件源那处，而本用例是 `MOVE /dav/dirA/`（**目录源**），
      // 走的是另一处 → 变异不生效 → 假绿（实测 fail=0）。故带前导换行锚定行首。
      anchor: '\n  if (await head(prefix)) return true;',
      replacement: '\n  if (false) return true;',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · 目录 COPY 退回「逐对象判定」（复制掉一部分才 412，目标留半成品）',
      file: 'server/webdav/app.js',
      // R13-04 复核后保留容器级判据（`destinationExists(..., true)` 的三种形态已覆盖
      // 「目标非空」），只是外面多了一层 `if (!overwrite) {` —— anchor 随缩进同步。
      anchor: "          if (await destinationExists(s3, cfg, dstKey, true)) {\n            return res.status(412).type('text/plain')\n              .send(`412 Precondition Failed：目标「${dstDir}」已存在且请求声明 Overwrite: F`);\n          }\n",
      replacement: "          if (false) {\n            return res.status(412).type('text/plain')\n              .send(`412 Precondition Failed：目标「${dstDir}」已存在且请求声明 Overwrite: F`);\n          }\n",
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-12 · app.head 注册到 app.get 之后（HEAD 被 GET 吞掉 → 每次 HEAD 都下载整份对象）',
      file: 'server/webdav/app.js',
      // R34：这两行的挂载点判据由手写 `req.path.startsWith(MOUNT)` 收敛为 `inMount(req.path)`，
      // 锚点**随代码一起迁移**（否则本条会静默失效 —— 脚本只在跑到它时才报「锚点未命中」，
      // 而没人跑就等于没登记）。守的判据不变：head 必须注册在 get 之前。
      anchor: "  app.head('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, true) : next()));\n  app.get('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, false) : next()));",
      replacement: "  app.get('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, false) : next()));\n  app.head('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, true) : next()));",
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },

    /* ======================= 第 11 轮（原 ANALYSIS-ROUND11.md，已并入开发文档） ======================= */

    {
      // 变异只撤掉外层 while 对 stalled 的引用（内层仍置位）—— 正是 R11-01 的旧实现：
      // `break` 只跳内层 for，循环照样跑满 MAX_ROUNDS=1000。
      // R23-03：循环本体已从 `routes/fs.js` 收敛到 `fs-gateway.deletePrefixAll()`
      // （三份同构实现合一），锚点随之改指唯一实现点 —— 判据与纪律不变。
      name: 'R11-01 · deletePrefixAll 的「整批 0 成功即停下」退回到只 break 内层 for（跑满 1000 轮）',
      file: 'server/fs-gateway.js',
      anchor: '  while (truncated && !stalled && rounds < MAX_ROUNDS) {',
      replacement: '  while (truncated && rounds < MAX_ROUNDS) {',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // 两步变异：把 migratePrefix 整段挪到「删源 + 标记分享链接」之后（R11-02 的旧顺序）
      name: 'R11-02 · 目录 MOVE 的元数据迁移退回「删源之后」（中断时目标密文挂已删源 key 的凭据）',
      file: 'server/fs-gateway.js',
      mutations: [
        {
          anchor: "  const relKeys = new Set(items.map((x) => x.key.slice((srcP + '/').length)).filter(Boolean));\n  const metaMig = encStore.migratePrefix(cfg.bucket, srcP + '/', dstP + '/', { overwriteRelKeys: relKeys });\n  const metaMoved = metaMig.moved;\n",
          replacement: '',
        },
        {
          anchor: '  if (removedKeys.length) shareStore.markMissingByKeys(cfg.bucket, removedKeys);\n',
          replacement: "  if (removedKeys.length) shareStore.markMissingByKeys(cfg.bucket, removedKeys);\n"
            + "  const relKeys = new Set(items.map((x) => x.key.slice((srcP + '/').length)).filter(Boolean));\n"
            + "  const metaMig = encStore.migratePrefix(cfg.bucket, srcP + '/', dstP + '/', { overwriteRelKeys: relKeys });\n"
            + "  const metaMoved = metaMig.moved;\n",
        },
      ],
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * ⏭ 已退役（2026-09-24，R14 复核时发现）。
       *
       * R12-02 之后，`movePrefix()` 会在**动手之前**就以 409 拒绝「目标下已存在同名
       * 对象」的移动（`fs-gateway.js` 的 `conflicts` 预检）。于是本用例构造的
       * 「目标侧既有对象 + 复制失败 → 回滚」场景**再也走不到回滚分支**，断言退化为
       * 「409 早退后目标未被改动」这一平凡事实 —— 实测退回 `copied.slice()` 仍 fail=0
       * （变异不可观测 = 假护栏）。同一纪律（回滚只删「本次才新建」者）已由 R13-02
       * 经 WebDAV 目录 COPY 走同一个 `rollbackCopies()` 真实覆盖，故此处退役。
       */
      name: 'R11-03 · 目录 MOVE 回滚退回「删掉所有本次复制过的目标键」（连目标侧既有对象一起删）',
      file: 'server/fs-gateway.js',
      anchor: '    const fresh = copied.filter((k) => !existedBefore.has(k));',
      replacement: '    const fresh = copied.slice();',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
      retired: true,
      retiredReason: 'R12-02 的冲突预检使「目标侧既有对象」在复制前即 409 中止，回滚分支不可达；'
        + '同纪律已由 R13-02（webdav 目录 COPY → rollbackCopies）真实覆盖',
    },
    {
      name: 'R11-04 · 上游 401 原样透传（前端当成会话过期 → 强制登出死循环）',
      file: 'server/s3.js',
      anchor: '  err.status = status === 401 ? 502 : (status >= 400 && status < 600 ? status : 500);',
      replacement: '  err.status = status >= 400 && status < 600 ? status : 500;',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-12 的同款缺陷在 API 面重演：撤掉 HEAD handler，express 会把 HEAD 退化成 GET
      name: 'R11-05 · 撤掉 HEAD /fs/download（express 让 HEAD 回落 GET → 每次 HEAD 都下载整份对象）',
      file: 'server/routes/fs.js',
      anchor: "router.head('/fs/download', async (req, res) => {",
      replacement: "router.post('/fs/__never__/download', async (req, res) => {",
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R11-06 · WebDAV 文件 MOVE 到自身不再拒绝（自复制 + 删源 = 静默数据丢失）',
      file: 'server/webdav/app.js',
      /**
       * ⚠️ anchor 必须**在文件内唯一**：`String.replace` 只替换**首处**。
       * `if (srcKey === dstKey) {` 在目录分支（`:884`）里还有一份同款守卫，
       * 单行 anchor 会命中**文件分支**（`:845`，本用例的目标）—— 眼下结果正确，
       * 但只要将来两个分支的先后顺序调换，变异就会静默打到另一边、照样"绿"。
       * 故带上紧跟的独有代码行（`const srcIsDir`）锁死为唯一命中。
       */
      anchor: '      if (srcKey === dstKey) {\n'
        + '        return res.status(403).type(\'text/plain\')\n'
        + '          .send(`403 Forbidden：${isMove ? \'移动\' : \'复制\'}目标与源相同`);\n'
        + '      }\n\n      const srcIsDir = srcKey.endsWith(\'/\');',
      replacement: '      if (false) {\n'
        + '        return res.status(403).type(\'text/plain\')\n'
        + '          .send(`403 Forbidden：${isMove ? \'移动\' : \'复制\'}目标与源相同`);\n'
        + '      }\n\n      const srcIsDir = srcKey.endsWith(\'/\');',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R12-03：`enc-store` 的内联判定也改调唯一实现点了
      name: 'R11-07 · 退出路径退回「无条件 mkdirSync」（删掉的 data 目录被退出钩子复活）',
      file: 'server/enc-store.js',
      anchor: '  if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return;\n',
      replacement: '',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * ⏭ 已退役（2026-09-24，R14 复核时发现）。
       *
       * R12-05 之后，magic + 缺 `chunkSize` 会在**入口**就被 409 挡住
       * （`routes/fs.js` 的 `base = NaN` 守卫），根本到不了本处 `chunkCap` 回落；
       * 而即便撤掉入口那道，最内层 `encryptPart` 也会以同一 409 兜住
       * （`tests/audit11-regressions.test.js:615` 的注释自陈）。可观测结果被两层
       * **同态**保证，单文件变异无法证伪（实测 fail=0）。故此条退役。
       */
      name: 'R11-08 · 分片大小上限退回「只认会话声明值」（缺 chunkSize 时完全不校验）',
      file: 'server/routes/fs.js',
      anchor: "    const chunkCap = Number(sess.chunkSize) > 0\n      ? Number(sess.chunkSize)\n      : (mode === 'magic' ? MAGIC_CHUNK_MAX : UPLOAD_CHUNK_MAX);",
      replacement: '    const chunkCap = Number(sess.chunkSize) > 0 ? Number(sess.chunkSize) : Infinity;',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
      retired: true,
      retiredReason: 'R12-05 的入口 409 使 chunkCap 回落分支不可达；撤掉入口后 encryptPart 仍兜同一状态，'
        + '单文件变异不可证伪（状态被两层同态保证）',
    },
    {
      name: 'R11-14 · /fs/upload/chunk 不再校验分片序号范围（越界序号直接打到云端）',
      file: 'server/routes/fs.js',
      anchor: '    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {',
      replacement: '    if (false) {',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-17 ①：旧护栏只断言「不得 206」，判定退化成恒 false 照样全绿，
      // 这条变异必须靠新加的正向对照（小加密对象 HEAD 必须 206）变红。
      name: 'R11-17 · WebDAV HEAD 对任何 Range 都回 200（判定退化成恒 false）',
      file: 'server/webdav/app.js',
      anchor: '        if (rh && gateway.rangeServable(st)) {',
      replacement: '        if (rh && false) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-17 ②：顺序对    {
      // R11-17 ②：顺序对调 → 限流器被无条件按压（被订单级节流拦下的轮询也扣预算）
      name: 'R11-17 · IP 查单预算闸门顺序对调（被订单级节流拦下时也扣预算）',
      file: 'server/share-routes.js',
      anchor: '    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {',
      replacement: '    if (security.payStatusLimiter(ip).ok && statusQueryDue(order)) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-01：撤掉 helpers 的顶层兜底 → 回到"靠每个用例自觉设 env"。
      // 那正是全量测试写生产 config.enc / stats.json 的根因（加载时序）
      name: 'R13-01 · 测试隔离退回「靠每个用例自觉」（不设 env 的进程回落生产 data/）',
      file: 'tests/helpers.js',
      anchor: 'if (!process.env.S3_DATA_DIR) {',
      replacement: 'if (false) { // 变异：撤掉默认安全',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-02：回滚退回"全量 created"（丢掉 fresh 过滤）→ 删掉复制前就存在的用户对象
      name: 'R13-02 · 目录 COPY 回滚退回全量 created（删掉复制前就存在的目标对象）',
      file: 'server/webdav/app.js',
      anchor: '          const fresh = created.filter((k) => !existedBefore.has(k));',
      replacement: '          const fresh = created.slice(); // 变异：无 fresh 过滤',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-03：失败后不再等在飞的 worker 落地就取快照 → 孤儿留在目标目录，日志谎报
      name: 'R13-03 · 目录 COPY 失败不再等 worker 落地（快照过早 → 目标残留孤儿）',
      file: 'server/webdav/app.js',
      anchor: '          await Promise.allSettled(workers);\n',
      replacement: '          // 变异：不再等在飞的 worker 落地\n',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-04 ①：摘掉容器级判据 → 目标非空但无同名对象时被放行（违背 RFC 4918 §9.8.4）
      name: 'R13-04 · 目录 COPY 摘掉容器级 Overwrite:F 判据（目标非空仍放行）',
      file: 'server/webdav/app.js',
      anchor: '          if (await destinationExists(s3, cfg, dstKey, true)) {',
      replacement: '          if (false) { // 变异：摘掉容器级判据',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-04 ②：摘掉键级兜底 → 容器级探测 fail-open 时同名对象被静默覆盖
      name: 'R13-04 · 目录 COPY 摘掉键级兜底（容器级 fail-open 时静默覆盖同名对象）',
      file: 'server/webdav/app.js',
      anchor: '          for (const t of targets) if (existedBefore.has(t.dst)) conflicts.push(t.dst);',
      replacement: '          for (const t of targets) if (false) conflicts.push(t.dst);',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-05 ①：删源失败不再回滚目标副本（旧实现：源与目标并存，既不回滚也不留痕）
      name: 'R13-05 · moveObject 删源失败不再回滚目标副本（源与目标并存）',
      file: 'server/fs-gateway.js',
      anchor: '      const rb = await rollbackCopies(s3, cfg, [toKey]);',
      replacement: '      const rb = { removed: 1, errors: [] }; // 变异：不回滚，且谎报成功',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-05 ②：忽略"目标原本已存在" → 回滚把用户复制前就有的对象一并删掉（不可逆）
      name: 'R13-05 · moveObject 忽略「目标原本已存在」（回滚删掉用户既有数据）',
      file: 'server/fs-gateway.js',
      anchor: '    if (dstExistedBefore) {',
      replacement: '    if (false) { // 变异：无视「目标原本已存在」',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R13-06：本条的"被测对象"是**检查器本身**。
       *
       * 旧实现「找定义」用含 `const|let|var name =` 的正则，但「取 canonical 函数体」
       * 只认 `function name(` —— 两套不同源。于是把 canonical 重构成箭头函数并
       * 删掉判据，`mustContain` 校验**静默跳过**、违规数归零（第 12 轮头条缺陷原地复活）。
       * 变异同时做两步（换成箭头形态 + 函数体退化），期望新检查器报红；
       * 若退回旧的"只认 function 声明"版本，这条会重新变绿。
       */
      name: 'R13-06 · canonical 重构成箭头函数并退化函数体（旧检查器静默跳过）',
      file: 'server/fs-gateway.js',
      mutations: [
        {
          anchor: 'async function rollbackCopies(s3, cfg, keys) {',
          replacement: 'const rollbackCopies = async (s3, cfg, keys) => { // 变异：换定义形态',
        },
        {
          anchor: '      const res = await deleteMultipleConfirmed(s3, cfg, batch);',
          replacement: '      const res = { okKeys: batch, errors: [] }; // 变异：函数体退化',
        },
      ],
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /**
       * R13-07：删掉**一个登记入口**对唯一实现点的调用。
       *
       * 旧口径 `minCalls` 是"计数代理"：全库总数够就放行，于是「删一处真实接线 +
       * 在没人读的地方补一处空调用」即可绕过。逐文件点名后此路不通
       * （三处 exit 钩子分属三个文件，缺一个就报一个）。
       */
      name: 'R13-07 · 登记入口不再调用唯一实现点（旧 minCalls 计数代理照样放行）',
      file: 'server/enc-store.js',
      anchor: '  if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return;',
      replacement: '  // 变异：登记入口不再调用唯一实现点',
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ================== 第 14 轮（ANALYSIS-ROUND14.md） ==================
     * 验收口径不是「逐条看代码改没改」，而是**撤掉修复，护栏必须变红**。
     * 本轮两条高危（R14-01 / R14-02）的共同点正是「486 条用例全绿、功能为零」——
     * 它们的护栏若不能反向变红，等于又给了一次同样的假阴性。
     */
    {
      // 判据退回「是不是函数」：生产四处传的是 PassThrough（object），
      // 于是全部走 arrayBuffer 分支 —— 对象被无界读进内存、传入的流永不 end、
      // 加密读信号量永久泄漏。这正是 R14-01 修复前的真实形态。
      name: 'R14-01 · S3 流式判据退回 typeof === function（非腾讯云厂商下载全断）',
      file: 'server/s3-client.js',
      anchor: '      if (out && typeof out.pipe === \'function\') {',
      replacement: '      if (typeof params.Output === \'function\') {',
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      // CSP 少一个域名：Turnstile 的脚本源被拦截 → 组件永不 load →
      // 而"需要验证码"的开关已打开 → 全站账号无法登录。修复前就是这个形态。
      name: 'R14-02 · CSP 去掉 challenges.cloudflare.com（启用 Turnstile 后锁死登录）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn; "',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 等价于「pending 不再受保护」= 修复前的裁剪口径。
      // 后果：付款者正在收银台时订单被裁 → 异步通知查无此单 → 钱付了拿不到文件。
      name: 'R14-03 · 订单裁剪不再保护支付窗口内的 pending（钱付了拿不到文件）',
      file: 'server/payment-orders.js',
      anchor: '  return now - t < PENDING_KEEP_MS;',
      replacement: '  return false;',
      testFile: 'audit14-regressions.test.js',
      minFail: 1,
    },
    {
      // 去掉支付态检查 = 修复前的形态：已付用户再点一次付费会覆盖已付票据。
      name: 'R14-05 · 发起支付不再查当前支付态（已付凭证被 pending 覆盖）',
      file: 'server/share-routes.js',
      // ⚠ anchor 必须唯一：`const payer = payerStateFor(l, req);` 在 GET /s/:id（缩进 4）、
      // POST /s/:id/pay（缩进 2）、GET /s/:id/dl（缩进 4）各出现一次，而 replace 只改**首处**。
      // 只写单行 anchor 会命中 GET 那处，支付处理器原封不动 → 变异不生效 → 假绿（fail=0）。
      // 故带前导换行锚定行首，并追加支付处理器独有的下一行代码，锁死为唯一命中。
      anchor: '\n  const payer = payerStateFor(l, req);\n  if (payer.state === \'paid\') {',
      replacement: '\n  const payer = { state: \'none\' };\n  if (payer.state === \'paid\') {',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 口令错误分支不跑 dummyHash → 「有效用户名 = 响应更快」→ 可枚举账户名。
      name: 'R14-07 · WebDAV 口令错误分支不再跑 dummyHash（用户名枚举侧信道反向放大）',
      file: 'server/config-store.js',
      anchor: '  if (!constTimeEquals(password, plain)) { await dummyHash(password); return { ok: false }; }',
      replacement: '  if (!constTimeEquals(password, plain)) { return { ok: false }; }',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 写入侧不再过 normalizeKey = 修复前的形态：`newName='..'` 能写出 `a/..`，
      // 此后删除 / 移动 / stat 一律 400 —— 不可逆的幽灵对象。
      name: 'R14-13 · rename 的 newKey 不再过 normalizeKey（产出删不掉的幽灵对象）',
      file: 'server/routes/fs.js',
      anchor: "    const newKey = normalizeKey(parentOf(key) + newName + (isFolder ? '/' : ''));",
      replacement: "    const newKey = parentOf(key) + newName + (isFolder ? '/' : '');",
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ---------- 第 14 轮 · P2 性能批次（本地收口，报告 §3.1 / §3.2(1)） ----------
     * 四条（R14-08/09/10/12）表面是四个问题，本质是同一件事：某条高频路径缺少
     * 「去抖 / 缓存 / 并发合并」中的某一层。修复载体是共享原语 `server/coalesce.js`，
     * 所以这里的每一条变异都要么废掉那一层、要么废掉那条接线。
     */
    {
      /**
       * R14-08：把序列化（含全量 AES-GCM）挪回**入队之前** —— 修复前的真实形态。
       * 两步变异：先把按引用传递的活对象序列化成一个 `text` 常量，再让队列只用它。
       * 顺带把 `null, 1` 缩进也加回去（同一缺陷的另一半）。
       */
      name: 'R14-08 · 加密退回「入队前同步执行」并带缩进（异步写仍阻塞调用栈）',
      file: 'server/secure-store.js',
      mutations: [
        {
          anchor: '  const prev = queues.get(file) || Promise.resolve();',
          replacement: '  const text = serialize(obj);\n  const prev = queues.get(file) || Promise.resolve();',
        },
        {
          anchor: '      return atomic.writeAtomic(file, serialize(obj));',
          replacement: '      return atomic.writeAtomic(file, text);',
        },
        {
          anchor: '  return JSON.stringify({ [ENC_FLAG]: ENC_VERSION, data: configStore.encrypt(obj) });',
          replacement: '  return JSON.stringify({ [ENC_FLAG]: ENC_VERSION, data: configStore.encrypt(obj) }, null, 1);',
        },
      ],
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-09：订单落盘退回「每次状态变更立刻全量落盘」= 去抖形同不存在。
       * 一次真实支付流程（setTradeNo / markPaid / markDownloaded）会变成三次
       * 全量序列化 + 加密 + 写盘，而 POST /s/:id/pay 匿名可达。
       */
      name: 'R14-09 · 订单落盘退回「每次变更立刻全量落盘」（去抖失效）',
      file: 'server/payment-orders.js',
      anchor: '  writer.schedule();',
      replacement: '  secureStore.writeJsonAsync(FILE, cache);',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-09 的另一半：`create()` 上的 `prune()` 退回无守卫的全表 filter + sort。
       * 后果不可用行为断言表达（裁剪结果完全等价，只是每次 create 白扫一遍全表），
       * 故由 `tests/invariants.test.js` 的静态检查「prune 必须被总量守卫」守。
       */
      name: 'R14-09 · create 上的 prune 退回无守卫的全表扫描',
      file: 'server/payment-orders.js',
      anchor: '  if (orders.length > MAX_ORDERS_PER_LINK) prune(o.linkId);',
      replacement: '  prune(o.linkId);',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-10：拆掉探测的并发去重 —— 同一链接的并发请求各打一次 headObject。
       * 变异后箭头函数**不被调用**（少了那对调用括号），整段探测根本不会执行，
       * 于是「并发只探一次」的断言拿到 0 次而失败 —— 这正是要证明的因果链。
       */
      name: 'R14-10 · 分享页探测退回「无并发去重」（同链接并发各打一次云端）',
      file: 'server/share-routes.js',
      anchor: '  return singleFlight(`share-exists:${l.id}`, async () => {',
      replacement: '  return (async () => {',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-12：把 `/fs/stat` 的并发合并与短缓存一起撤掉 = 修复前的形态：
       * 每次请求都串行翻页全量列举（默认上限 2 万 → 最多约 21 次云端往返），
       * 而该路由既没有限流器也不需要管理员。
       */
      name: 'R14-12 · /fs/stat 退回「无缓存、无限流的全量列举」',
      file: 'server/routes/fs.js',
      mutations: [
        {
          anchor: '      const cachedStat = listCache.get(statKey);',
          replacement: '      const cachedStat = null;',
        },
        {
          anchor: '        const again = listCache.get(statKey);',
          replacement: '        const again = null;',
        },
        {
          anchor: '        listCache.set(statKey, out);',
          replacement: '        void out;',
        },
      ],
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-12 的另一半：只拆并发合并、保留缓存。
       *
       * 与上一条**并存**是有意的 —— 上一条证明"回到旧实现会变红"，这一条单独证明
       * 「singleFlight 那一层真的在挡并发」。少了它，一个只删 `singleFlight` 的
       * 半修（缓存还在，单请求场景全绿）就没有任何护栏能发现。
       */
      name: 'R14-12 · /fs/stat 只拆并发合并（缓存仍在，单请求测不出）',
      file: 'server/routes/fs.js',
      anchor: '      const payload = await singleFlight(`fs-stat:${statKey}`, async () => {',
      replacement: '      const payload = await (async () => {',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 `requireStore()` 挪回 `await` 之前 —— 这就是修复前的形态。
       *
       * 后果：`await hashPassword()`（scrypt，约 50~100ms）期间若 60 秒 TTL 到期，
       * `load()` 会把 `cached` 换成**新对象**，手上的 cfg 就此脱钩；随后的
       * `persist(cfg)` 又把 `cached` 指回旧对象 —— 这段时间内别人的写入被**整体覆盖**，
       * 双方都收到成功响应，一方静默丢更新（丢的若是角色/权限，表现为「降权不生效」）。
       *
       * 这条与 R14-06 此前**只有静态检查、没有反向对照**（`--only=R14-04` 曾因此无匹配）：
       * 静态检查只能证明「现在这样写是对的」，证明不了「退回旧写法会被抓到」。
       */
      name: 'R14-04 · addUser 把 requireStore() 挪回 await 之前（静默丢更新）',
      file: 'server/config-store.js',
      anchor: '  const { salt, hash, params } = await hashPassword(password);\n  const cfg = requireStore();',
      replacement: '  const cfg = requireStore();\n  const { salt, hash, params } = await hashPassword(password);',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉安全响应头中间件 = 修复前的形态（8443 端口是**另一个** Express 实例，
       * 主站那套头一份都不会自动带上）。可渲染类型（html / svg）被浏览器内联渲染时
       * `<script>` 即执行，配合被缓存的 Basic 凭据 = 一个文件拿到该账户名下全部桶的读写删权限。
       *
       * 替换为空串后中间件只剩 `next()`：语法合法、服务照跑，只有静态检查会报。
       * 刻意**不**在替换内容里写任何含 `Content-Security-Policy` 的字样 ——
       * 静态检查跑在 `stripComments()` 之上，但让变异体「看起来像有头」会削弱这条对照的说服力。
       */
      name: 'R14-06 · WebDAV 独立实例去掉安全响应头（html/svg 内联渲染即执行脚本）',
      file: 'server/webdav/app.js',
      anchor: "    res.setHeader('Content-Security-Policy', \"default-src 'none'; sandbox\");\n"
        + "    res.setHeader('X-Content-Type-Options', 'nosniff');\n"
        + "    res.setHeader('Referrer-Policy', 'no-referrer');",
      replacement: '',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉「候选集订阅写操作失效」的接线 = 回到「写完不失效」。
       *
       * 后果：TTL 内用户一直看到「刚删掉的文件还在 / 刚上传的搜不到」，
       * 且**没有任何报错** —— 唯一的自愈途径是等 TTL 到期。
       */
      name: '搜索候选集 · 不订阅 onMutate（写操作不再让候选集失效）',
      file: 'server/search-candidates.js',
      anchor: 'listCache.onMutate((method, params) => {\n'
        + '  try { drop(params && params.Bucket); } catch (e) { /* 缓存失效失败不影响主流程 */ }\n'
        + '});',
      replacement: '/* 变异：不再订阅云端写操作 */',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 让 `/fs/search` 永远不从候选集取条目 —— 等价于**这层缓存根本没接上**。
       *
       * 只测「结果对不对」发现不了它（结果当然还是对的），只测「重复搜索省了调用」
       * 也发现不了它 —— `listCache` 是秒级页缓存、且接入候选集**之前**就存在，
       * 「重复搜索免费」在本变异下照样成立。所以护栏必须是**关掉 listCache**
       * （`LIST_CACHE_TTL_MS=0`）之后断言「第二轮仍不打云端」：
       * 那时能省下调用的只剩候选集，本变异必然让它多打一次云端。
       *
       * 反面教材：本条初次登记时跑出 `fail=0`，正是因为当时的断言被 listCache 兜住了。
       */
      name: '搜索候选集 · /fs/search 不读候选集（这层缓存等于没接）',
      file: 'server/routes/fs.js',
      anchor: '    let cand = candidates.get(candKey);',
      replacement: '    let cand = null; // 变异：不读候选集',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 游标边界从「严格大于」放宽成「大于等于」。
       *
       * 游标语义必须与对象存储的 `Marker` 一致（返回**大于**它的 key）：用 `>=`
       * 会让续扫把刚刚处理过的那个对象再返回一次 —— 用户看到重复项，且分页越多重复越多。
       */
      name: '搜索候选集 · firstAfter 的游标边界用 >=（续扫重复返回刚处理过的对象）',
      file: 'server/search-candidates.js',
      anchor: '    if (items[mid].key > cursor) hi = mid; else lo = mid + 1;',
      replacement: '    if (items[mid].key >= cursor) hi = mid; else lo = mid + 1;',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * `put` 覆盖已有键时刷新 `at` = 「写一次就永不过期」。
       *
       * 热条目（被反复命中的前缀）的陈旧窗口会被无限延长，而这层缓存唯一的一致性
       * 兜底就是 TTL —— 站外写入（控制台 / 生命周期规则 / 别的工具）系统收不到任何信号。
       */
      name: '搜索候选集 · put 刷新 at（热条目永不失效，站外写入的陈旧窗口无限延长）',
      file: 'server/search-candidates.js',
      anchor: '    at: prev ? prev.at : now,',
      replacement: '    at: now,',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 缓存键丢掉搜索范围维度。
       *
       * 「递归」与「仅当前目录」是两套完全不同的键集合（delimiter `''` vs `'/'`），
       * 共用一份候选集时用户切了范围却拿到另一次搜索的结果 —— 界面上看不出任何异常。
       * 与 R8-11（键丢 kind 命名空间）同型。
       */
      name: '搜索候选集 · keyOf 丢掉 scope（递归与仅当前目录互相命中）',
      file: 'server/search-candidates.js',
      // R21-11 同 list-cache：每段先经 `\u0000` 消毒再拼接，anchor 随之更新。
      anchor: "  return [ident, prefix, scope || ''].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      replacement: "  return [ident, prefix].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * `put` 不再先查 tooBig = 超限被丢弃后**还能**重新写入。
       *
       * 此时物化出来的是一段「中间窗口」（从当前页开始）而不是从头开始的连续前缀；
       * 后续请求按「已物化 = 从头连续」的前提去续扫，窗口之前的对象被静默漏掉。
       * 这条同时覆盖静态检查（检查 21 的守卫顺序）。
       */
      name: '搜索候选集 · put 不查 tooBig（物化出中间窗口，续扫静默漏对象）',
      file: 'server/search-candidates.js',
      anchor: '  if (isTooBig(key, now)) return false;',
      replacement: '  if (false) return false;',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 路由里的桶标识退化成「只有桶名」= 这条判据当初要拦的形态。
       * 用来验证 `cacheKeyViolations` 放宽后（允许 canonical 局部别名）**仍然**抓得住
       * 「看着像标识、其实是桶名」的那种写法。
       */
      name: '搜索候选集 · 桶标识退化为纯桶名（缓存键缺区分维度）',
      file: 'server/routes/fs.js',
      anchor: '    const ident = bucketCacheKey(cfg);',
      replacement: '    const ident = cfg.bucket;',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 部署脚本（deploy.sh）此前完全没有登记反向对照 —— 它的护栏只在
       * tests/deploy-script.test.js 里，退不回旧实现就等于没验证过。
       * Debian/Ubuntu 的 nginx.conf 顶层就有 include /etc/nginx/modules-enabled/*.conf;
       * （动态模块目录，位于 http{} 之外），而该目录在装了 nginx 的机器上必然存在。
       * 退回「主配置里任意通配 include 目录」的挑法后，站点配置会被写进 modules-enabled，
       * server{} 落在 main 上下文 → nginx -t 报 "server" directive is not allowed here。
       */
      name: 'D1-01 · nginx 站点目录退回「任意通配 include 目录」（Debian 会选中 modules-enabled）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '    [[ -n "$d" ]] || continue',
          replacement: '    [[ "$d" == *\'*\'* ]] || continue\n    d="${d%/*}"',
        },
        {
          anchor: '  done < <(nginx_http_include_dirs "$NGINX_CONF_PATH")',
          replacement: "  done < <(grep -oE 'include[[:space:]]+[^;]+;' \"$NGINX_CONF_PATH\" 2>/dev/null | sed -E 's/include[[:space:]]+//; s/;$//; s/^\"//; s/\"$//' || true)",
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 值经 stdin 传进 node，本来不需要转义；多包一层「安全转义」会把反斜杠、引号、
       * 制表符变成字面字符写进真实密码 —— 提示成功却登不上，且只有特殊字符才触发。
       */
      name: 'D1-02 · 改管理员凭据退回「先转义再传值」（docker 分支写坏真实密码）',
      file: 'deploy.sh',
      anchor: 'printf \'%s\' "$value" | docker compose run',
      replacement: 'printf \'%s\' "${value//\\\\/\\\\\\\\}" | docker compose run',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 值若恰好长得像 JSON 字符串字面量（密码就是 "abc123" 连着引号），
       * JSON.parse 会把引号「解码」掉 → 用户拿原密码登不上。
       */
      name: 'D1-03 · 内联脚本退回 JSON.parse 解码（密码长得像 JSON 字面量时被改坏）',
      file: 'deploy.sh',
      anchor: "  const value = input.replace(/\\r?\\n$/, '');",
      replacement: "  let value = input.replace(/\\r?\\n$/, '');\n"
        + "  try { const decoded = JSON.parse(input); if (typeof decoded === 'string') value = decoded; } catch (e) {}",
      testFile: 'deploy-script.test.js',
      minFail: 2,
    },
    {
      /*
       * pkg_install 失败即 die → 它后面的 EPEL 兜底与整段「对症」提示（含 --skip-nginx）
       * 全是死代码；而 RHEL 系 nginx 在 EPEL 里，第一枪打不中是常态。
       */
      name: 'D1-04 · nginx 安装退回会中断的 pkg_install（EPEL 兜底与对症提示成死代码）',
      file: 'deploy.sh',
      anchor: '    pkg_run_pm nginx || true',
      replacement: '    pkg_install nginx',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 放行「域名:端口」的后果：is_ip_addr 只看到冒号就当成 IP → 静默改自签名证书，
       * server_name 里带端口又让 nginx -t 失败，用户在最难懂的一步卡住。
       */
      name: 'D1-05 · 删掉「域名带端口」校验（静默自签名 + server_name 带端口打挂 nginx -t）',
      file: 'deploy.sh',
      anchor: '  if [[ "$DOMAIN" =~ :[0-9]+$ ]] && [[ "$DOMAIN" != *::* ]]; then\n'
        + '    die "域名里不要带端口：${DOMAIN}（端口请用 --https-port / --http-port 指定，例如：--domain ${DOMAIN%%:*} --https-port ${DOMAIN##*:}）"\n'
        + '  fi',
      replacement: '  : # 「带端口」校验已被反向对照移除',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉重装前的完整性预检后，安装目录里若躺着一个坏掉的 deploy.sh
       * （最典型：curl 不带 -f 把 14 字节的「404: Not Found」存成了它），
       * exec 出去就是一句「404: line 1: 404:: command not found」—— 用户完全无从下手。
       *
       * ⚠️ R39 把这段内联判据（shebang + `bash -n`）收敛进了唯一实现点 `script_is_sane()`
       * （与「自我交接」共用同一份），**旧 anchor 随之失效**（本条曾在全量里报「未命中」）。
       * 按纪律「重构挪旧锚点位置时连旧锚点一起迁移」：锚点改指 `reinstall_now` 里那次
       * **委托调用**，变异意图不变 —— 撤掉预检，坏脚本照样被直接 exec。
       */
      name: 'D1-06 · 删掉重装前的脚本完整性预检（坏脚本被直接 exec）',
      file: 'deploy.sh',
      anchor: '  if ! script_is_sane "$target"; then\n'
        + '    die "安装目录内的部署脚本不完整或已损坏：${target}（无法重装，请重新执行一键部署）"\n'
        + '  fi',
      replacement: '  : # 完整性预检已被反向对照移除',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 一键安装命令退回「裸管道 + 不带 -f」：curl 收到 404 仍返回 0，
       * 会把 14 字节的「404: Not Found」原样存成 deploy.sh；即使带 -f，
       * 管道下 $? 取到的也是右侧 bash 的 0，下载失败会被当成成功。
       * 注意锚点必须落在 README（.md 只剥 HTML 注释）——deploy.sh 里这条命令
       * 整段都是 `#` 注释，纯注释锚点会被不变量检查判为「剥注释后无法验证」。
       */
      name: 'D1-07 · 一键安装命令退回「curl … | sudo bash」（去掉 -f 后 404 会被存成脚本）',
      file: 'README.md',
      anchor: 'curl -fLo /tmp/kepler-deploy.sh https://raw.githubusercontent.com/xingsen2005/Kepler/main/deploy.sh \\\n'
        + '  && sudo bash /tmp/kepler-deploy.sh --domain s3.example.com',
      replacement: 'curl -fsSL https://raw.githubusercontent.com/xingsen2005/Kepler/main/deploy.sh | sudo bash -s -- --domain s3.example.com',
      testFile: 'docs-sync.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 git 退回「必需包」：git 混进 pkg_install 后，dnf 一失败就整段 die，
       * prepare_source 里那段「没有 git 也能装（把源码打包上传）」的提示永远执行不到。
       * CentOS/RHEL 8 的模块流过滤恰好会让 git 装不上 —— 用户被卡死在第一步。
       */
      name: 'D1-08 · 基础工具把 git 退回「必需包」（CentOS 8 上装不上即中断）',
      file: 'deploy.sh',
      anchor: '    if ((${#hard_pkgs[@]})); then pkg_install "${hard_pkgs[@]}"; fi\n'
        + '    if ! have git; then pkg_install_opt git || true; fi',
      replacement: '    pkg_install "${to_install[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉「模块流被过滤」诊断分支 → 用户日志掉进通用兜底，只被告知"未能自动识别原因"，
       * 拿不到 dnf module reset/enable 这条真正的修复命令，也不知道"没有 git 也能部署"。
       *
       * （第 19 轮：判据从「本分支自己 grep 日志」收敛为 `pkg_failure_kind` 的**唯一实现点**，
       *   anchor 随之换新形态 —— 原锚点是 `elif grep -qiE 'modular filtering'`，
       *   改判据后它必然腐烂，这正是 invariants 里那条「anchor 必须命中」自检要抓的。）
       */
      name: 'D1-09 · 删掉「模块流被过滤」诊断（CentOS 8 装包失败的诊断退回通用兜底）',
      file: 'deploy.sh',
      anchor: '  elif [[ "$kind" == "modular" ]]; then',
      replacement: '  elif false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 不再识别「机器上已有 nodejs 与新版互斥」→ Node 装不上的**真原因**被埋掉。
       * 用户真实日志（CentOS Linux 8）里，dnf 明明写了
       *   cannot install both nodejs-2:20.20.2-1nodesource.x86_64 and nodejs-1:16.13.1-3.module_el8…
       * 但脚本只给「三种方式都没装上」的通用指引，用户无从知道要先卸掉系统那份 nodejs。
       * 变异成恒 false：冲突分支不再触发，行为断言（module reset nodejs / remove -y nodejs）全部落空。
       */
      name: 'D1-10 · Node 冲突判据失效（已有 nodejs 互斥的真原因不再被点出）',
      file: 'deploy.sh',
      anchor: '  log_since_mark | grep -qiE \'cannot install both|conflicts? with|obsoletes?|--allowerasing\'',
      replacement: '  return 1',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉「临时无视 exclude」那条可敲命令 → 用户被 exclude=nginx 挡住时，只被告知去
       * grep 配置、去 ls 面板路径，却没有任何一条能直接执行的命令；日志现象
       * `All matches were filtered out by exclude filtering for argument: nginx` 就此卡死。
       */
      name: 'D1-11 · 删掉 nginx 被 exclude 过滤时的绕开命令（--disableexcludes）',
      file: 'deploy.sh',
      anchor: '          add_hint "    ${PM} install -y --disableexcludes=all nginx"',
      replacement: '          add_hint ""',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把锁文件根条目的 devDependencies 掏空 —— 重现「包清单加了依赖、锁文件没跟着更新」。
       * 这正是 CentOS 8 日志里 `npm ci` 每次 EUSAGE 的真因（Missing: eslint@9.39.5 from lock file）：
       * 部署脚本第一枪打的就是 npm ci --omit=dev，锁文件不同步则这一枪**必然**落空，
       * 只能靠兜底 npm install 侥幸装上。锁文件是构建产物，没人会主动看 → 必须由护栏钉住。
       */
      name: 'D1-12 · 锁文件与 package.json 脱同步（npm ci 必然 EUSAGE，只能靠兜底碰运气）',
      file: 'package-lock.json',
      // R75：新增 espree 后锚点同步（声明了三个字段就必须一起清掉，否则"脱同步"不成立）
      anchor: '      "devDependencies": {\n        "eslint": "^9.0.0",\n        "espree": "^10.4.0"\n      }',
      replacement: '      "devDependencies": {}',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 让「shell 的 `/*` 不是块注释开头」这条判据失效 → 剥注释再次吞掉大段代码。
       * deploy.sh 的 `[[ "$INSTALL_DIR" == /* ]]`（862 行）、`#  include …/*.conf;`（1396 行）、
       * `"$INSTALL_DIR"/*`（2711 行）会各吞掉 330 / 16 / 85 行，落在里面的反向变异 anchor
       * 永远"未命中" —— 台账全绿，但是假绿。变异后 `每个函数定义都必须还在` 必须变红。
       */
      name: 'D1-13 · 剥注释把 shell 的 /* 当块注释（大段代码从锚点视图里消失）',
      file: 'tests/invariants.test.js',
      anchor: 'function isShellPatternAt(src, i) {',
      replacement: 'function isShellPatternAt(src, i) {\n  return false;\n}\nfunction _deadShellPattern(src, i) {',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 acme.sh 账户目录的推导退回「只按主机名找」——这正是最初写错的那版
       * （用通配符去匹配 ca/ 下一层目录）。acme.sh 的 CA_DIR 是 ca/<host>/<path>/，
       * 账户密钥在**最里层**，只看外层目录永远判成「没注册过」。
       * 后果：每次重跑都强索 EAB（而 acme.sh 早把 EAB 存进 ca.conf），
       * 用户被要求反复去 CA 控制台复制凭据，却怎么填都「还是没注册」。
       */
      name: 'D1-14 · acme.sh 账户目录退回「只按主机名找」（已注册的账户永远判不出来）',
      file: 'deploy.sh',
      anchor: `  printf '%s/ca/%s/%s' "$ACME_HOME" "$host" "$path"`,
      replacement: `  printf '%s/ca/%s' "$ACME_HOME" "$host"`,
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * rerun_cmd 不再脱敏 → 把原始命令行原样回显。用户带 --eab-hmac-key 重跑时，
       * 提示与日志里就会出现明文 HMAC（相当于签发密码），而且会被复制粘贴到处传。
       */
      name: 'D1-15 · 重跑提示不再抹掉 EAB HMAC（明文密钥回显到屏幕与日志）',
      file: 'deploy.sh',
      anchor: '  orig="$(redact_args "$ORIG_ARGS")"  # 原样重跑，但不把 EAB 密钥回显出来',
      replacement: '  orig="$ORIG_ARGS"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉「非 LE 一律走 acme.sh」的分流 → 所有 CA 都落到 certbot 通道。
       * CentOS 8 的 certbot 是 1.22（Python 3.6），**不支持 --eab-kid/--eab-hmac-key**，
       * 于是 LiteSSL / ZeroSSL 这类强制 EAB 的 CA 在签发那一步必然失败 ——
       * 而失败又是「回退自签名」的非致命路径，用户只会看到一句「证书签发失败」。
       */
      name: 'D1-16 · 非 LE 的 CA 也交给 certbot（1.22 不支持 EAB，CentOS 8 那类机器必失败）',
      file: 'deploy.sh',
      anchor: '  if [[ "$CA_PROVIDER" != "letsencrypt" ]]; then\n    # 非 LE 一律 acme.sh：certbot 的 EAB 参数在 CentOS 8 那代根本不认',
      replacement: '  if false; then\n    # 非 LE 一律 acme.sh：certbot 的 EAB 参数在 CentOS 8 那代根本不认',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉 --install-cert → 证书只留在 acme.sh 的私有目录，Nginx 仍指向
       * /etc/kepler/ssl/acme/。表现极隐蔽：首次签发看着成功了（文件在别处也齐全），
       * 但**续期后 Nginx 一直用着旧证书**，直到过期才被发现。
       */
      name: 'D1-17 · 不再 --install-cert（续期只更新 acme.sh 私有目录，Nginx 一直用旧证书）',
      file: 'deploy.sh',
      anchor: '  if ! acme_install_cert "$ACME_CERT_DIR"; then',
      replacement: '  if false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 EAB HMAC 写进部署状态文件。状态文件是 0600 的普通文本，会被备份/同步/贴到群里
       * 排障（README 里就让人备份数据目录）；HMAC 相当于该 CA 的签发密码，泄漏即可冒名签发。
       * 而且这是**多余**的落盘：acme.sh 自己已经把 EAB 存在 ca.conf 里，重跑并不需要它。
       */
      name: 'D1-18 · EAB HMAC 密钥落进部署状态文件（多余且等于明文泄漏签发密码）',
      file: 'deploy.sh',
      anchor: 'EAB_KID=${EAB_KID}"',
      replacement: 'EAB_KID=${EAB_KID}\nEAB_HMAC_KEY=${EAB_HMAC_KEY}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把「只对 ACME 证书发长期 HSTS」退回成「一律 max-age=31536000」——正是 R49 之前的写法。
       * 后果：证书来自运维自备（内网 CA / 自建 CA，浏览器未必信任）时，浏览器已经记住了该域名的
       * 长期 HSTS，随后对它的证书错误不再给「继续访问」入口（提示「此网站使用了 HSTS」），
       * 站点对浏览器**彻底不可达**，且用户没有回退手段。
       */
      name: 'D1-19 · 非 ACME 证书（自备 / 无法确认可信）也下发长期 HSTS（浏览器锁死，无「继续访问」入口）',
      file: 'deploy.sh',
      anchor: '  if [[ "$cert_fullchain" == "${ACME_CERT_DIR}/"* ]]; then\n    hsts_header=\'    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\'\n  else\n    hsts_header=\'    add_header Strict-Transport-Security "max-age=0" always;\'\n  fi',
      replacement: '  hsts_header=\'    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\'',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉 acme.sh 的 gitee 兜底 + 落盘双检，退回 `curl … | sh`（官方安装器从
       * raw.githubusercontent.com 取文件）。国内服务器连不上 GitHub → acme.sh 装不上
       * → 所有需要 EAB 的 CA 全军覆没（certbot 又不支持 EAB），必然回退自签名。
       * 而且管道写法违反 D1-06：下载失败被右侧 sh 吞掉。
       */
      name: 'D1-20 · acme.sh 退回「curl … | sh」且无国内镜像（GitHub 不通时装不上）',
      file: 'deploy.sh',
      anchor: 'install_acme_sh() {',
      replacement: 'install_acme_sh() { bash -c "curl -fsSL https://get.acme.sh | sh -s email=${EMAIL}"; return 0; }\nfunction _dead_install_acme_sh() {',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R60-01a：把 acme.sh 的下载源换回「官方 GitHub 优先 + gitee 兜底」。
       *
       * 这正是本次修复要消灭的形态：国内服务器每次部署都先撞一次
       * raw.githubusercontent.com 的 connect-timeout（15s，丢包时更久），
       * 明明有国内镜像却「偶发装不上」。
       *
       * ⚠️ 必须用**缩进**区分两行 URL（主分支 7 空格、兜底分支 9 空格）：
       * 若锚点不带缩进，9 空格行里就包含「7 空格 + URL」这个子串，
       * `String.replace` 只替首处 ⇒ 第二步会改错行、两步互相抵消 ⇒ `fail=0` 假绿。
       * 顺序也关键：先把「兜底」换成 gitee，再把「主分支」换成 github ——
       * 反过来第二步会命中刚换成 github 的主分支，而不是兜底。
       */
      name: 'R60-01a · acme.sh 下载换回「GitHub 官方源优先」（国内服务器先白等一次超时）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '         https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh; then',
          replacement: '         https://gitee.com/neilpang/acme.sh/raw/master/acme.sh; then',
        },
        {
          anchor: '       https://gitee.com/neilpang/acme.sh/raw/master/acme.sh; then',
          replacement: '       https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh; then',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R61-01a：撤掉 `withSession` 出口处给 SMTP 错误盖的 `status`。
       *
       * 后果：连接错误没有 `status` ⇒ `apiHandler` 判 `e.status ? e : translateError(e)`
       * ⇒ 落进**对象存储**的翻译层 ⇒ R58 拼好的「哪个地址 / 什么码 / 该改什么」
       * 被替换成一句「网络连接异常，请检查网络后重试」—— 工单原文。
       *
       * anchor 用**单行代码**（`throw markUserFacing(e);` 全库唯一），不含注释行：
       * `invariants.test.js` 的 anchor 自检是**双侧 stripComments() 后**比对，
       * 跨注释行的锚点在剥注释后会失配。
       */
      name: 'R61-01a · SMTP 错误不再盖 status（详情被 S3 翻译层覆盖成「网络连接异常」）',
      file: 'server/smtp.js',
      anchor: '    throw markUserFacing(e);',
      replacement: '    throw e;',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R62-01a：价格封顶失效 —— 优惠金额不再封到「原价 − 1 分」。
       *
       * 后果：10 元券买 6 元文件 ⇒ 应付 0 元，而支付网关不接受 0 元订单；
       * 订单页也会出现「原价 6 + 优惠 10 = 实付 0.01」这种对不上账的组合。
       */
      name: 'R62-01a · 优惠不再封顶到「原价 − 1 分」（券面额大于价格时应付变成 0）',
      file: 'server/coupon-store.js',
      anchor: '  const maxDiscount = Math.max(0, orig - MIN_PAYABLE_FEN);\n  const applied = Math.min(want, maxDiscount);',
      replacement: '  const applied = want;',
      testFile: 'coupon.test.js',
      minFail: 1,
    },
    {
      /*
       * R62-02a：撤掉「每个用户只能使用一次」的判据。
       *
       * 后果：同一账号可以反复使用同一张定向券，需求 3 的第二半直接失效。
       */
      name: 'R62-02a · 「每个用户只能使用一次」不再拦同一身份',
      file: 'server/coupon-store.js',
      anchor: "    if (!who || (Array.isArray(c.identities) ? c.identities : []).indexOf(who) >= 0) return fail('already_used');",
      replacement: "    if (false) return fail('already_used');",
      testFile: 'coupon.test.js',
      minFail: 1,
    },
    {
      /*
       * R62-03a：退款时不再回退优惠券。
       *
       * 后果：需求 8 失效 —— 钱退了，那张定向券仍然记着「这人用过了」，
       * 买家重新下单时只会看到「您已使用过该优惠券」。
       */
      name: 'R62-03a · 退款不再让非无门槛券恢复可用（需求 8 失效）',
      file: 'server/routes/payment.js',
      anchor: "    if (o.couponId && o.couponType && o.couponType !== 'any') {",
      replacement: '    if (false) {',
      testFile: 'coupon.test.js',
      minFail: 1,
    },
    {
      /*
       * R62-04a：下单时不再快照原价。
       *
       * 后果：订单页的「原价 / 优惠 / 应付」三列失去依据（原价退化成实付，
       * 优惠列永远为 0），历史订单再也说不清「这张券到底减了多少」。
       */
      name: 'R62-04a · 下单不再快照原价（订单页「原价 / 优惠」失去依据）',
      file: 'server/share-routes.js',
      anchor: '      originalFen: ps.amountFen,',
      replacement: '      originalFen: amountFen,',
      testFile: 'coupon.test.js',
      minFail: 1,
    },
    {
      /*
       * R62-05a：券表单里的按钮改回 `width: 100%`（工单截图的直接成因）。
       *
       * `.btn` 的基础样式就是 `display:block; width:100%`，放进 flex 行后按钮占满整行、
       * 输入框被挤成一条几十像素的空盒子 —— 用户看到的正是那张截图。
       */
      name: 'R62-05a · 券表单按钮改回 width:100%（输入框被挤成一条）',
      file: 'server/share-routes.js',
      anchor: '  .coupon-form .btn { flex: 0 0 auto; width: auto; margin: 0; padding: 9px 14px;',
      replacement: '  .coupon-form .btn { flex: 0 0 auto; width: 100%; margin: 0; padding: 9px 14px;',
      testFile: 'coupon.test.js',
      minFail: 1,
    },
    {
      /*
       * 把速率限制判据退回「只认 rate limit / too many / exceeded」，漏掉 acme.sh 实际的
       * 驼峰措辞 rateLimited、Le_OrderFinalize、429。后果：acme.sh 被限流时的日志（
       * error:rateLimited / status 429）匹配不到限流分支，掉进「未能识别」兜底，
       * 用户只看到笼统的「签发失败」。而且原来的分支还排在「连接失败」之后，
       * 429 的日志一旦同时含 timeout/ssl 之类词会被更宽泛的连接判据抢先吞掉，
       * 报成「连不上 CA」——方向全错（429 恰恰说明网络是通的、请求到了 CA）。
       */
      name: 'D1-21 · CA 速率限制（rateLimited/429）判据漏匹配且排到「连接失败」之后',
      file: 'deploy.sh',
      anchor: "elif grep -qiE 'rate ?limit|ratelimited|too many|exceeded|Le_OrderFinalize|429|retry after' <<<\"$tail_log\"; then",
      replacement: "elif grep -qiE 'rate limit|too many|exceeded' <<<\"$tail_log\"; then",
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 默认 CA 退回 letsencrypt。用户实测在公共后缀域名（*.l.cd）上反复用 LE 被
       * rateLimited(429) 拒签，明确要求「不要再使用 LE」。LE 按「注册域名/公共后缀」
       * 7 天共享约 50 张配额，公共后缀下所有人都挤一个池子，不适合当默认 CA；
       * ZeroSSL 走 HTTP-01、acme.sh 能用 --email 自动换 EAB（零手工），更稳妥。
       */
      name: 'D1-22 · 默认 CA 退回 letsencrypt（公共后缀域名反复 rateLimited）',
      file: 'deploy.sh',
      anchor: 'CA_PROVIDER="zerossl"',
      replacement: 'CA_PROVIDER="letsencrypt"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 acme_install_cert 退回「拿 run 返回码直接判失败」。宝塔/自编译的 nginx 不是
       * systemd native service（systemctl reload 报 "is not active, cannot reload"），
       * acme.sh 的 --install-cert 会先把 key/fullchain 写进指定路径、之后才跑 --reloadcmd，
       * reload 失败时 acme.sh 返回非零打 "Reload error"，但证书其实已经装好了。
       * 拿返回码判失败 → 误回退自签名，用户看到的是「证书签发失败」而证书其实已到手。
       */
      name: 'D1-23 · acme 证书落盘后仍因 reload 失败误判「安装失败」回退自签名',
      file: 'deploy.sh',
      anchor: '  if ! run "$(acme_bin)" "${args[@]}" </dev/null; then\n'
        + '    warn "acme.sh --install-cert 返回非零（多半是 --reloadcmd 那步失败）；证书可能已落盘，继续核对文件。"\n'
        + '  fi',
      replacement: '  if ! run "$(acme_bin)" "${args[@]}" </dev/null; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 账号 / 仓库迁移后的「老安装机还能不能重装」。
       *
       * 老安装机的 /etc/kepler/deploy.conf 里存着**当年的默认仓库地址**（旧账号），
       * 而那个仓库现在已 404；load_state 读 REPO_URL 时不再过 migrate_repo_url()，
       * 旧地址就原样带进 prepare_source 的 `git clone --depth 1 "$REPO_URL"` ——
       * 重装直接失败，用户只看到一句「源码拉取失败（<旧地址>）」，无从知道是脚本里
       * 的默认值过期了（重装走的又是安装目录里那份脚本，它的 HEAD 注释已指向新地址）。
       *
       * ⚠️ 判据必须**真跑一次 load_state**（把 STATE_DIR 指到临时目录）：
       * 只断言「源码里出现过 migrate_repo_url 这个词」是钉不住它的 —— 那正是假绿的标本。
       */
      name: 'D1-24 · load_state 不再迁移历史默认仓库地址（老安装机重装去拉一个 404 死仓库）',
      file: 'deploy.sh',
      anchor: '      REPO_URL) REPO_URL="$(migrate_repo_url "$value")" ;;',
      replacement: '      REPO_URL) REPO_URL="$value" ;;',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R59-01a：`centos_eol_repo()` 被摘成恒假 —— EOL 专因（Vault 归档源）永不给出。
       *
       * CentOS 7/8 已 EOL，官方 yum 源整体下线，`dnf install` 连元数据都取不到；
       * 用户报的「首次安装必定提示装 Node 失败」在 CentOS 8 上正来自这里。退回恒假后，
       * 失败出口只剩通用【A】NodeSource 指南 —— 而那套方案在本机照样装不上
       * （它也要走 dnf），用户照着做必然再失败一次。
       *
       * 台账里那条用例既查源码、又**真跑 bash** 逐个断言只在 CentOS 7/8 命中 ⇒ 恒假必红。
       * 实测 `fail=1`。
       */
      name: 'R59-01a · CentOS EOL 判据被摘成恒假（Vault 归档源永不给出，用户照着 NodeSource 再失败一次）',
      file: 'deploy.sh',
      anchor: 'centos_eol_repo() {\n  [[ "${OS_ID:-}" == "centos" ]] || return 1',
      replacement: 'centos_eol_repo() {\n  return 1',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R59-02a：`centos_vault_hints()` 里的三步命令被删成只剩一句空话 ——
       * 用户拿不到「换成 Vault 源」的可敲命令，等于这条修复没落地。
       *
       * ⚠️ 变异只删「清理并重建缓存」那一步（`dnf clean all` + `makecache`）：
       * 这是三步里最容易被忽略、也最容易「看着像对、其实没生效」的一步 ——
       * 只换源不清缓存，旧的 mirrorlist 元数据会继续作祟。台账用例专门钉了它。
       * 实测 `fail=1`。
       */
      name: 'R59-02a · Vault 指引丢掉「清理并重建缓存」这一步（只换源不清缓存，元数据继续作祟）',
      file: 'deploy.sh',
      anchor: '  add_hint "      ${PM} clean all"\n  add_hint "      ${PM} makecache"\n',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R59-03a：GitHub 拉不通时不再改用 Gitee 镜像 —— 退回「失败即 die」。
       *
       * 国内服务器拉 GitHub 常超时/TLS 被重置；镜像重试能省掉用户「手动换 --repo
       * 再跑一遍」这一趟。
       *
       * ⚠️ 必须两步一起撤**且缩进要跟着当前实现走**：`prepare_source` 里
       * `MIRROR_REPO_URL` 出现**两处** —— 自动重试那一行、以及失败提示里
       * 「手动用镜像重跑」那一行。只撤前者时，`/MIRROR_REPO_URL/` 仍被后者满足 ⇒
       * 第一版 `fail=0`（实测）。且判据也必须落在**执行的那一行**
       * （`git clone --depth 1 "$MIRROR_REPO_URL"`），而不是「这个词出现过」。
       * 两步同撤 + 判据收紧后 `fail=1`。
       *
       * ⚠️ R63 把这段镜像兜底从「顶层 if」挪进了 `elif [[ "$clone_url" == ... ]]`
       * 分支，缩进由 6 空格变 4 空格 —— 旧 anchor 因此**未命中**（invariants 立刻报
       * 「1 条失效 anchor」）。这正是「改判据形态会老化别处 anchor」的标本：
       * 挪动代码块时必须回头把台账里钉这段代码的条目一起重锚。
       */
      name: 'R59-03a · 克隆失败不再改用 Gitee 镜像重试（国内服务器拉 GitHub 失败即中断）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '    if run git clone --depth 1 "$MIRROR_REPO_URL" "${tmp}/src"; then',
          replacement: '    if false; then',
        },
        {
          anchor: '      add_hint "     · 国内服务器推荐用 Gitee 镜像（脚本已自动试过，仍失败可手动重试）："\n      add_hint "       $(rerun_cmd --repo ${MIRROR_REPO_URL})"',
          replacement: '      : # 镜像提示已移除',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 「界面显示 https://localhost:8443/dav/，WebDAV 用不了」两处根因之一：
       * Nginx 站点配置里的 /dav 反代只是一段**注释**（「应用内开启后取消注释」），
       * 于是 https://<域名>/dav/ 根本没人转发 → 404。把 location 行退回注释态即可复现。
       */
      name: 'D2-01 · Nginx 的 /dav 反代退回「注释待手工启用」（界面给的地址必然 404）',
      file: 'deploy.sh',
      anchor: '    location ^~ /dav {',
      replacement: '    # location ^~ /dav {',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 同一条链路的第二种坏法：反代在、端口写死。用户改 WEBDAV_PORT 后 .env 与 Nginx
       * 各说各话 —— 应用监听 9443、Nginx 转发 8443，界面有地址但连不上。
       * 这是「端口只有一个事实来源」这条契约的反向对照。
       */
      name: 'D2-01 · Nginx 上游端口写死 8443（WEBDAV_PORT 改了也不跟，反代打空）',
      file: 'deploy.sh',
      anchor: '        proxy_pass https://127.0.0.1:${WEBDAV_PORT};',
      replacement: '        proxy_pass https://127.0.0.1:8443;',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * .env 里的 WEBDAV_PORT 写死 8443：应用侧 DEFAULT_PORT 读的是它，
       * 于是「脚本以为的端口」与「应用实际监听的端口」脱节，反代必然打空。
       */
      name: 'D2-03 · .env 的 WEBDAV_PORT 写死 8443（不再跟随环境变量）',
      file: 'deploy.sh',
      anchor: 'WEBDAV_PORT=${WEBDAV_PORT}',
      replacement: 'WEBDAV_PORT=8443',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * serverUrl 退回「只拼监听地址 + 端口」——即故障现场那一版。
       * `.env` 里 HOST=0.0.0.0，于是界面恒显示 https://localhost:8443/dav/。
       * 变异手法：让主路径拿不到请求主机（退化成末档兜底），等价于原来的行为。
       */
      name: 'D2-02 · WebDAV 地址退回「只拼监听地址」（界面恒显示 localhost:8443）',
      file: 'server/webdav-server.js',
      anchor: '  const host = reqHost(req);',
      replacement: "  const host = '';",
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 路由层不把 req 传下去：serverUrl 拿不到请求主机 → 退化成监听地址。
       * 这条最隐蔽 —— 界面照常显示地址、服务照常「运行中」，静态读代码看不出问题。
       */
      name: 'D2-04 · WebDAV 路由不把 req 传给 serverUrl（地址静默退化成监听地址）',
      file: 'server/routes/webdav.js',
      anchor: '    serverUrl: webdav.serverUrl(req),',
      replacement: '    serverUrl: webdav.serverUrl(),',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 前端兜底退回写死的 `https://<本机IP>:<端口>`：那不是可用地址而是伪地址，
       * 用户照抄必然连不上，且完全看不出问题出在哪。
       */
      name: 'D2-05 · 前端地址兜底退回「写死 <本机IP>:端口」（误导性伪地址）',
      file: 'public/js/syssettings.js',
      anchor: "  const urlEl = document.getElementById('webdav-url');\n"
        + '  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? webdavFallbackUrl(w) : \'—\');',
      replacement: "  const urlEl = document.getElementById('webdav-url');\n"
        + "  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? 'https://<本机IP>:' + w.port + w.mount : '—');",
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-01：把 ip-guard 的取 IP 退回「只看 socket.remoteAddress」——即故障现场那一版。
       * 默认部署是「Nginx 反代 + TRUST_PROXY=1」，socket 对端恒为 127.0.0.1，
       * 于是守卫判定的永远是回环地址，紧接着被「本机永远放行」短路。
       * 症状是**所有屏蔽规则整体失效而界面一切正常**。
       */
      name: 'R17-01 · ip-guard 取 IP 退回「只看 socket」（反代下恒见 127.0.0.1）',
      file: 'server/ip-guard.js',
      anchor: 'function clientIp(req) {\n  return security.clientIpInfo(req).ip;\n}',
      replacement: "function clientIp(req) {\n  return (req && req.socket && req.socket.remoteAddress) || '';\n}",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-01：把「回环豁免」退回**无条件**。此时 TRUST_PROXY=1 下任何人只要发一个
       * `X-Forwarded-For: 127.0.0.1` 就把自己变成「本机」——R17-01 的修复被一个请求头
       * 整条抵消（等价于没修）。这条对照钉的就是「豁免只对 socket 对端成立」。
       */
      name: 'R17-01 · 「本机永远放行」退回无条件（一个 XFF: 127.0.0.1 即重获豁免）',
      file: 'server/ip-guard.js',
      anchor: '  if (!fromForwarded && (ip === \'127.0.0.1\' || ip === \'::1\')) {',
      replacement: "  if (ip === '127.0.0.1' || ip === '::1') {",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-02：把 `httpsUrl` 退回「只查协议不查主机」——即报告里的原始实现。
       * 于是 `https://127.0.0.1:8443/gateway.do`、云元数据地址都能通过支付设置校验并存盘，
       * 服务端会带着商户私钥主动出站（`alipayQuery`），并把下载者 302 过去。
       */
      name: 'R17-02 · 支付宝网关地址退回「只查协议」（内网 / 元数据地址被放行）',
      file: 'server/payment-providers.js',
      anchor: '    try {\n      assertSafeEndpoint(v);\n    } catch (e) {\n      return e.message;\n    }\n',
      replacement: '',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-03：把「站点对外地址」退回「只查形状」。该值会被拼成 return_url 交给支付
       * 网关，支付完成后由网关把用户浏览器重定向过来 —— 指向外站就是一条经网关背书的
       * 开放重定向（地址栏走的是支付宝 → 攻击者站点）。
       */
      name: 'R17-03 · 「站点对外地址」退回「只查形状」（外站可被当作回跳目标）',
      file: 'server/routes/payment.js',
      anchor: 'if (url && !security.isOwnSiteHost(url, [req.headers.host])) {',
      replacement: 'if (url && false) {',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-03 的第二道：`siteUrlFor()` 对**配置值**的兜底校验。保存路径已挡了外站，
       * 但配置可能是旧版本写入或手改的文件 —— 少了这道兜底，展示层会把付款人 302 到外站。
       */
      name: 'R17-03 · siteUrlFor 不再兜底校验配置值（旧配置可把付款人 302 到外站）',
      file: 'server/share-routes.js',
      anchor: "  if (base && !security.isOwnSiteHost(base, [])) base = '';",
      replacement: "  if (false) base = '';",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-04：asyncHandler 把抛错「吞掉」而不是交给 next(err)。Express 4 既不接
       * async 抛错、这里又不转交，于是客户端拿不到任何响应 —— 请求永久挂起（转圈），
       * 比 500 更难排查。
       */
      name: 'R17-04 · asyncHandler 吞掉抛错而非 next(err)（请求永久挂起）',
      file: 'server/routes/_shared.js',
      anchor: '    Promise.resolve(fn(req, res, next)).catch(next);',
      replacement: '    Promise.resolve(fn(req, res, next)).catch(() => {});',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-04 的第二道：某个公开匿名可达的 async 处理器退回「裸 async」。
       * 静态上少一层包装看不出来，实际效果是这条路径的抛错不再有兜底 ——
       * 正是 8 处清单要钉住的契约。
       */
      name: 'R17-04 · /s/:id/pay 退回裸 async handler（该路径抛错即挂起）',
      file: 'server/share-routes.js',
      anchor: "router.post('/s/:id/pay', asyncHandler(async (req, res) => {",
      replacement: "router.post('/s/:id/pay', async (req, res) => {",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-01（第 18 轮）：把 `acme_issue_skipped` 的退出码判据退回「认不出的码」。
       *
       * acme.sh 的 `RENEW_SKIP=2` 是「证书未到续期时间」的**成功**语义（源码第 93 行
       * `RENEW_SKIP=2`，`issue()` 打印 "Skipping. Next renewal time is: …" 后 `return $RENEW_SKIP`）。
       * 丢掉这个判据后就只剩「措辞」那一层兜底 —— 而现场日志里退出码是被放大到
       * `[错误] 命令执行失败（退出码 2）` 呈现的，用户看到的正是这一行。
       * 后果：`issue_acme_sh` 判签发失败 → `setup_tls` 回退自签名 → 点「重新安装」SSL 掉级。
       */
      name: 'D3-01 · acme_issue_skipped 不再认退出码 2（重装把正式证书降级为自签名）',
      file: 'deploy.sh',
      anchor: '  if ((rc == 2)); then return 0; fi\n',
      replacement: '  if ((rc == 99)); then return 0; fi\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-02（第 18 轮）：绕过 `_run_impl` 的「容忍列表」—— 无论调用方声明了什么退出码，
       * 一律打 `[错误] 命令执行失败（退出码 N）`。
       * 现场表现就是「上一行：已存在 ZeroSSL 的 ACME 账户，跳过注册。下一行：[错误] 命令执行失败」，
       * 明明两行说的是同一件正常的事，读起来却像证书坏了。
       */
      name: 'D3-02 · run_allow_rc 的容忍列表失效（被允许的退出码照样打成错误）',
      file: 'deploy.sh',
      anchor: '    if ((tolerated == 0)); then\n',
      replacement: '    if ((1)); then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-03（第 18 轮）：`tls_cert_reusable` 的文件判据退回「存在即算」更狠的一档 ——
       * 直接 `return 0`，等于「有目录就算有证书」。空文件、垃圾内容、缺失的 privkey
       * 全部被判成「可复用」→ 跳过申请 → Nginx 拿一张读不出来的证书起不来，
       * 而「已跳过证书申请」的输出看着一切正常，现场很难往证书上想。
       */
      name: 'D3-03 · tls_cert_reusable 退回「有文件即算可复用」（空/垃圾证书被跳过申请）',
      file: 'deploy.sh',
      anchor: '  [[ -s "${dir}/fullchain.pem" && -s "${dir}/privkey.pem" ]] || return 1\n'
        + '  have openssl || return 1\n',
      replacement: '  return 0\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-04（第 18 轮）：`setup_tls` 的 auto|acme 分支退回「无条件申请」（跳过分支失效）。
       * 证书明明装好且在有效期内，重装还是跑去 `--issue`；只要那次申请失败
       * （CA 配额 / 网络 / EAB 任何一项），后面就接 `gen_self_signed` —— 正式证书被降级。
       * 这正是用户报的「重新安装后 SSL 又只能退回自签名」的后半段：
       * 症状的根因是「不该跑的步骤跑了」，而不是「申请本身有 bug」。
       */
      name: 'D3-04 · setup_tls 退回「无条件申请」（已完成步骤被重做，失败即降级）',
      file: 'deploy.sh',
      anchor: '      if [[ "$FORCE_CERT" != "1" ]] && tls_cert_reusable "$ACME_CERT_DIR"; then\n',
      replacement: '      if false; then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-05（第 18 轮）：把 CERT_REUSE_MIN_DAYS 从 30 抬到 365。
       * 分工是「本脚本只负责首次签发 / 补签，续期归 acme.sh 的每日任务（它在到期前
       * 60 天自己续）」。阈值一旦越过 acme.sh 的续期窗口，两边就都不可信：
       * 90 天有效期的证书被判成「不够新」而去重签，而真正的边界含义也随之上移。
       * 阈值是「跳过申请」这件事的**唯一尺度**，尺度错了，跳过与不跳过都失去意义。
       */
      name: 'D3-05 · CERT_REUSE_MIN_DAYS 越过 acme.sh 的续期窗口（两边的分工被打乱）',
      file: 'deploy.sh',
      anchor: 'CERT_REUSE_MIN_DAYS=30\n',
      replacement: 'CERT_REUSE_MIN_DAYS=365\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-06（第 19 轮）：`pkg_auto_repair` 的 modular 分支失效 —— 回到「只诊断、不修复」。
       *
       * 这一条钉的是用户的原话：「脚本自动安装 git 失败。这种最基础的操作不应该出问题。」
       * 旧实现**已经能识别**这是模块流问题，却只把 `dnf module reset perl` 打印出来让人去敲；
       * 而 git 走的是**可选**通道，装不上只降级不中断 —— 于是重装时 `prepare_source`
       * 才发现没有 git，整个部署卡在拉源码那一步。
       * 把 case 分支改成一个永不匹配的标签，就等于退回那个「识别了但不作为」的版本。
       */
      name: 'D3-06 · 包装不上时不再自动修模块流（退回「只诊断不修复」，git 仍然装不上）',
      file: 'deploy.sh',
      anchor: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n    modular)\n',
      replacement: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n    never_matches)\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-07（第 19 轮）：把 `--nobest` 提到判据**之前**（无条件放宽候选版本）。
       *
       * `--nobest` 是 dnf 自己的建议，但它只在「已经确认是模块流不一致」之后才值得用；
       * 无条件先试，就是在没搞清原因的情况下换一个版本装上、把问题推给下一个环节 ——
       * 网络类失败也会去装一个「非最佳版本」的包，并骗过「自动修复没碰系统」这条边界。
       */
      name: 'D3-07 · 自动修复无条件放宽候选版本（--nobest 越过原因判据）',
      file: 'deploy.sh',
      anchor: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n',
      replacement: '  if pkg_run_pm_nobest "${pkgs[@]}"; then return 0; fi\n'
        + '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-08（第 19 轮）：删掉 failovermethod 的无害警告说明。
       *
       * 现场日志里那 5 行 `Invalid configuration value: failovermethod=…` 是最显眼的东西，
       * 但它**不是**失败原因（旧版 yum 的选项，dnf 不支持）。脚本不主动说清，
       * 用户就会顺着它把排查方向整个搞错 —— 真实故障现场里正是如此。
       */
      name: 'D3-08 · 删除 failovermethod 无害警告说明（用户被最显眼的那几行带偏）',
      file: 'deploy.sh',
      anchor: "  if grep -qiE 'Invalid configuration value.*failovermethod' <<<\"$tail_log\"; then\n",
      replacement: '  if false; then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-09（第 19 轮）：模块名不再验证 —— 直接把包名当模块名去 reset。
       *
       * 报错里给的是**包名**（perl-libs），`module reset` 要的是**模块名**（perl）。
       * 跳过 `module list` 验证就等于把 perl-libs 拿去 reset —— 它根本不是模块，
       * 只会多刷一行错，而真正要复位的 perl 一次都没被动过。
       * 表现：`module reset -y perl-libs` 看着像做了事，git 依旧装不上。
       */
      name: 'D3-09 · 包名被直接当模块名 reset（跳过一次 module list 验证）',
      file: 'deploy.sh',
      anchor: '      if module_exists "$cand"; then mod="$cand"; break; fi\n',
      replacement: '      mod="$cand"; break\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-10（第 19 轮）：`pkg_install_opt` 不接自动修复 —— **git 走的正是这条通道**。
       *
       * 只在必需通道里修等于没修：用户看到的「git 装不上」恰好发生在这条可选通道上。
       * 后果与 D3-06 同类，但更隐蔽 —— 必需通道（nginx/nodejs）一切正常，
       * 只有 git 这一条路径悄悄退回「只编号不干活」。
       */
      name: 'D3-10 · 可选通道不接自动修复（git 恰好走的就是这条通道）',
      file: 'deploy.sh',
      anchor: '    if pkg_auto_repair "${pkgs[@]}"; then return 0; fi\n'
        + '    # on_pkg_failure 在「可选」分支里 return 1（表示未装上）。这里是**裸调用**，\n',
      replacement: '    # on_pkg_failure 在「可选」分支里 return 1（表示未装上）。这里是**裸调用**，\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-11（第 19 轮）：自动修复里**去掉「绕过模块过滤」这一档**，退回「只 reset/enable」。
       *
       * 用户现场是**全新安装的纯净系统** —— 模块流状态本来就是对的，`module reset perl`
       * 与 `module enable perl:5.26` 全是空转，那台机器上永远修不好。
       * 真正的机制是 RHEL 8 的 module failsafe（按模块的包级过滤清单屏蔽 perl-libs），
       * 只有 `module_hotfixes`（让仓库按包级视图求解）能过。
       */
      name: 'D3-11 · 撤掉「绕过模块过滤」档（纯净系统上 reset/enable 全是空转，git 依旧装不上）',
      file: 'deploy.sh',
      anchor: '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi\n',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-12（第 19 轮）：给 `--setopt='*.module_hotfixes=true'` **去掉引号**。
       *
       * 那个 `*` 不引起来会被 shell 当通配符，在当前工作目录里做 glob 展开 ——
       * dnf 收到的是被换成文件名的垃圾参数，而失败信息完全看不出是这个原因。
       * 这是本条修复里最容易被"顺手简化"掉的一个字符。
       *
       * ⚠️ anchor 必须带上 `"${pkgs[@]}"` 这一截才**唯一**：命令原文在 deploy.sh 里出现两次
       * （实现处 + 诊断提示处），只写命令本身会命中首处之外的第二处、或让护栏以为"还在"。
       * 护栏侧对应地断言「**每一处** `--setopt=` 后面都紧跟引号」。
       */
      name: 'D3-12 · --setopt 的通配符丢掉引号（被 shell 展开成文件名，dnf 收到垃圾参数）',
      file: 'deploy.sh',
      anchor: "--setopt='*.module_hotfixes=true' \"${pkgs[@]}\"",
      replacement: '--setopt=*.module_hotfixes=true "${pkgs[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-13（第 19 轮）：把「绕过模块过滤」挪到「复位模块流」**之后**。
       *
       * 顺序反了的后果：纯净系统上先去 reset/enable 空转一遍（那是**全局**状态变更，
       * 副作用大且对这个故障无效），再去绕过过滤 —— 结果虽然也可能装上，但用户机器
       * 的模块流已被无谓改过。零副作用的那一档必须在前。
       */
      name: 'D3-13 · 修复档顺序颠倒（先动全局模块流，再试零副作用的绕过过滤）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi\n',
          replacement: '',
        },
        {
          anchor: '          if pkg_repair_modular_streams "${pkgs[@]}"; then return 0; fi ;;',
          replacement: '          if pkg_repair_modular_streams "${pkgs[@]}"; then return 0; fi\n'
            + '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi ;;',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-14（第 19 轮）：失败判据不再认 `modulefailsafe` 这个机制名。
       *
       * 判据只认 `filtered out by modular filtering` 时，日志里出现的是
       * `modulefailsafe` 措辞的那些变体就落进通用兜底 —— 用户拿不到「绕过模块过滤」这条
       * 唯一有效的命令。判据漏一个机制名，整条修复路径就整段失效。
       */
      name: 'D3-14 · 失败判据不认 modulefailsafe（掉进通用兜底，拿不到对症命令）',
      file: 'deploy.sh',
      anchor: '|modulefailsafe|module_hotfixes|requires module\\(|',
      replacement: '|requires module\\(|',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-15（第 20 轮）：把证书「内容可用」的判据退回「只看文件字节数」。
       *
       * 两处**一起**退，缺一不可：
       *   ① `cert_file_ok` 里对 subject/issuer「必须有实值」的检查 ——
       *      这才是拦住「字段全空白证书」的那一句；只删其中一行不行，
       *      另一行（issuer）照样把它拦下，变异就等于没做；
       *   ② `tls_cert_reusable` 里对 `cert_file_ok` 的调用 —— 复用判据若只看 `-s`，
       *      一份坏证书会被**每次重装永久复用**，永远修不回来。
       *
       * 两处一起退，红项落在**两个不同用例**上（分工，不是冗余）：
       *   ① 打红第 39 条 —— 守「签发安装时坏证书不得被当成成功」（`cert_file_ok` 里
       *      subject/issuer 的实值检查 + 行为桩 `BLANK_SUBJ=1`）；
       *   ② 打红第 39 条与第 31 条（`tls_cert_reusable 的判据与阈值`）—— 第 39 条管
       *      「三处调用点都在」，第 31 条管「**复用这一处**的内容校验不能被摘掉」。
       * 合计 2 个不同用例，故 `minFail: 2`（本脚手架一次施加全部变异、只取合计 `# fail`，
       * 无法按变异归因）：只退 ① 时只有第 39 条红（=1），到不了 2。
       * 早期第 31 条还没单独断言 `cert_file_ok` 时，退回旧实现只打中第 39 条一个用例、
       * `fail=1` —— 正是这么暴露「复用路径那一半没被独立守着」的。
       */
      name: 'D3-15 · 证书判据退回「只看文件非空」（字段全空白的证书被当成签发成功 / 被永久复用）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '  [[ "$s" == subject=* && -n "${s#subject=}" ]] || return 1\n'
            + '  [[ "$i" == issuer=*  && -n "${i#issuer=}"  ]] || return 1\n',
          replacement: '',
        },
        {
          anchor: '  cert_file_ok "${dir}/fullchain.pem" "${dir}/privkey.pem" || return 1\n',
          replacement: '',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 2,
    },
    {
      /*
       * D3-16（第 20 轮）：撤掉 `setup_tls` 收尾的「实际对外提供的是哪份证书」比对。
       *
       * `nginx -t` 只能证明我们写的配置能被解析，证明不了浏览器看到的就是这份证书。
       * 撤掉这一步，「脚本说 ZeroSSL 签发成功、浏览器却说不安全」这种错配就再也
       * 没有任何地方能发现 —— 现场只能靠人去猜，而这一猜就是几十分钟。
       */
      name: 'D3-16 · 撤掉「实际对外提供的证书」收尾比对（浏览器看到的不是这份，脚本仍报成功）',
      file: 'deploy.sh',
      anchor: '  tls_probe_served || true\n',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },

    /* ==================================================================
     * 第 21 轮（R21-xx）
     *
     * 每条都断言「退回旧实现后，`tests/audit21-regressions.test.js` 必须变红」。
     * 变异刻意**等效于旧实现的可观测后果**，而不是「把源码搬个位置」：
     *   · R21-01 把门禁判据整体置假（= 旧实现根本没有这道门禁）；
     *   · R21-03 把写入并发上限放到无穷（= 旧实现只有单请求上限）；
     *   · R21-12 撤掉 `redirect: 'manual'`（= 旧实现默认 follow，请求会真的打到 Location）。
     * ================================================================== */
    {
      name: 'R21-01 · 分享下载的加密门禁整体失效（密文对象照样下发明文）',
      file: 'server/share-routes.js',
      anchor: 'function encGateNeeded(l) {\n  if (!l) return false;',
      replacement: 'function encGateNeeded(l) {\n  if (true) return false; // 变异：门禁失效，等价于旧实现没有这道判据',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-03 · 流式写入并发上限失效（WebDAV PUT 可无限并发，N×256MB）',
      file: 'server/fs-gateway.js',
      anchor: 'const MAX_WRITE_STREAMS = 2;',
      replacement: 'const MAX_WRITE_STREAMS = Infinity; // 变异：等价于旧实现只有单请求上限',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-05 · Windows Hello 失败分支恢复可区分（用户名 oracle 复活）',
      file: 'server/routes/auth.js',
      anchor: "    if (!configStore.isWebauthnEnabled(raw)) return authFail('该账户未启用 Windows Hello');",
      replacement: "    if (!configStore.isWebauthnEnabled(raw)) return res.status(400).json({ error: '该账户未启用 Windows Hello，请使用密码登录' });",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R21-06（R82 重述）：**回调地址必须与实际下单渠道同源**。
       *
       * 条目 id 保留，但变异的**落点换了**，原因写在这里以免日后误解：
       * 原始形态是「`notifyUrl` 用请求体的 `platform`，下单用 `order.platform`」——
       * 两者能分叉的前提正是「复用在途订单时不看渠道」，而 R82 把这个前提去掉了
       * （复用多一个 `pendingOrder.platform === platform` 的条件）⇒ `chargePlatform`
       * 恒等于 `platform`，「写 A 还是写 B」产出同一个回调地址，**变异不可观测**。
       *
       * 但**不变量本身仍然有效且可证伪**：回调地址必须由「这一单实际走的渠道」决定。
       * 于是把变异落点挪到「用一条**别的**渠道去拼回调地址」上（这里取 `available[0]`，
       * 即"顺手拿了第一条可用渠道"这种很常见的退化写法）—— 它产生的正是原始缺陷的
       * **后果**（下单走 A、回调写 B），R82-01 会当场变红。
       */
      name: 'R21-06 · notifyUrl 不再与实际下单渠道同源（改用「第一条可用渠道」拼回调地址）',
      file: 'server/share-routes.js',
      anchor: '    notifyUrl: `${base}/pay/notify/${encodeURIComponent(chargePlatform)}`,',
      replacement: '    notifyUrl: `${base}/pay/notify/${encodeURIComponent(available[0])}`,',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-09 · 自助改密不再校验当前密码（会话劫持即可永久接管账户）',
      file: 'server/routes/users.js',
      anchor: "      const current = String(b.currentPassword == null ? '' : b.currentPassword);",
      replacement: "      const current = 'correct-pw'; // 变异：等价于旧实现完全不校验当前密码",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-10 · 撤掉抢锁宽限期（新鲜空锁被当成无主 → 双持有）',
      file: 'server/instance-lock.js',
      anchor: '      if (!cur && !force && lockAgeMs() < LOCK_SHAPE_GRACE_MS) {\n        return { ok: false, stale: false, pid: null };\n      }\n',
      replacement: '',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-11 · 列举缓存键不再消毒分隔符（参数可注入 → 进程级串味）',
      file: 'server/list-cache.js',
      anchor: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].map(seg).join(SEP);',
      replacement: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].join(SEP);',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-11 · 搜索候选集键不再消毒分隔符（同型串味）',
      file: 'server/search-candidates.js',
      anchor: "  return [ident, prefix, scope || ''].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      replacement: "  return [ident, prefix, scope || ''].join(SEP);",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-12 · S3 客户端恢复默认 follow（3xx 被静默跟随到内网地址）',
      file: 'server/s3-client.js',
      anchor: "    const init = { method, headers: signed, redirect: 'manual' };",
      replacement: '    const init = { method, headers: signed };',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-12 · 支付网关恢复默认 follow（带商户凭据的请求被打到 Location 指向处）',
      file: 'server/payment-gateway.js',
      // R81：`fetchWithTimeout` 里 `res` 改成先声明后赋值（超时要把读体也包进同一段 try），
      // 锚点随之去掉 `const `。判据本身（必须显式 `redirect: 'manual'`）没变。
      anchor: "      res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal, redirect: 'manual' }));",
      replacement: "      res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-13 · HTTPS 跳转目标退回 HOST（Docker 下 301 到 https://0.0.0.0:3443/…）',
      file: 'server/security.js',
      anchor: '  if (!isBindAllHost(local)) return { host: local, fallbackToBindAll: false };\n'
        + '  const dom = configuredSiteHost();\n'
        + '  if (dom) return { host: dom, fallbackToBindAll: false };\n'
        + '  return { host: local, fallbackToBindAll: true };\n',
      replacement: '  return { host: local, fallbackToBindAll: false };\n',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-14 · WebDAV 错误响应回显上游原始 message（泄漏请求 ID / 端点 / 密钥片段）',
      file: 'server/webdav/defs.js',
      anchor: '  const fromUpstream = !!e && (e.statusCode !== undefined || e.rawMessage !== undefined);\n'
        + "  if (!fromUpstream) return String((e && e.message) || '操作失败，请重试');\n"
        + '  return translateError(e).message;\n',
      replacement: "  return String((e && e.message) || '操作失败，请重试');\n",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-15 · 跳过清单版本号漂移（读者无法判断清单对应哪个构建）',
      file: 'SCAN-SKIPLIST.md',
      anchor: '- 项目：`object-manager` v1.2.2',
      replacement: '- 项目：`object-manager` v1.2.0',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
      /**
       * R22 退役：该清单从未纳入 git（仓库管理决策），R22 复核时已不在工作区 ——
       * 目标文件不存在 ⇒ 变异无法施加，且对应的护栏（`audit21-regressions.test.js`
       * 的 R21-15 用例）已改为「文件缺失即跳过」，撤掉修复与否都不可观测。
       * 退役而非删除：留痕可审计；文件若回归仓库，把本条的 `retired` 去掉即可复活。
       */
      retired: true,
      retiredReason: 'SCAN-SKIPLIST.md 未纳入 git 且已不在工作区，变异无目标、护栏空转；'
        + '对应用例改为「文件缺失即跳过」，撤不撤修复都不可观测，故退役保留留痕。',
    },

    /* ==================== 第 22 轮（R22-01 ~ R22-06） ==================== */

    {
      name: 'R22-01 · Windows Hello 第三支恢复可区分（「用户名存在且已启用二次验证」的 oracle 复活）',
      file: 'server/routes/auth.js',
      anchor: '      return authFail(`验签失败（${r.reason}）`);',
      replacement: '      return res.status(401).json({ error: webauthn.publicReason(r.reason), reason: r.reason });',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-02 · 转发头取值不再校验格式（非法串各自成为独立来源 → 限流 / 锁定键随头轮换）',
      file: 'server/security.js',
      anchor: "  return isIpLiteral(pick) ? pick : '';",
      replacement: '  return pick;',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-02 · 部署脚本退回追加语义（该头首段 = 客户端原值，IP 守卫与限流按伪造值判定）',
      file: 'deploy.sh',
      anchor: '        proxy_set_header X-Forwarded-For \\$remote_addr;',
      replacement: '        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · PROPFIND 出口退回裸发上游 message（泄漏请求 ID / 端点 / 密钥片段）',
      file: 'server/webdav/app.js',
      anchor: '      return res.status(207).send(multistatus([propResponse(hrefFor(key), item)]));\n'
        + '    } catch (e) {\n'
        + '      // R22-03：与其余同型 catch 同一口径 —— 上游原始 message 只进服务端日志\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));",
      replacement: '      return res.status(207).send(multistatus([propResponse(hrefFor(key), item)]));\n'
        + '    } catch (e) {\n'
        + '      // R22-03：与其余同型 catch 同一口径 —— 上游原始 message 只进服务端日志\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · MKCOL 出口退回裸发上游 message',
      file: 'server/webdav/app.js',
      anchor: '      res.status(201).end();\n'
        + '    } catch (e) {\n'
        + '      // R22-03：MKCOL 同型收口\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));",
      replacement: '      res.status(201).end();\n'
        + '    } catch (e) {\n'
        + '      // R22-03：MKCOL 同型收口\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · DELETE 出口退回裸发上游 message',
      file: 'server/webdav/app.js',
      anchor: "        res.status(st === 404 ? 404 : 500).type('text/plain').send(st === 404 ? '404 Not Found' : davErrorMessage(e));",
      replacement: "        res.status(st === 404 ? 404 : 500).type('text/plain').send(st === 404 ? '404 Not Found' : e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · COPY 出口退回裸发上游 message',
      file: 'server/webdav/app.js',
      anchor: '        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);\n'
        + "        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : davErrorMessage(e));",
      replacement: '        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);\n'
        + "        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-04 · README 删去「WebDAV 出口不叠加查看密码」的口径（文档又变成含糊承诺）',
      file: 'README.md',
      anchor: '；**WebDAV 挂载（`/dav`）不叠加这道门禁**，它由独立的 Basic 认证与 IP 守卫把关，凭据须由管理员授予。',
      replacement: '。',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-05 · README 退回「令牌仅通过 x-enc-token 请求头传递」（与分享页 Cookie 通道矛盾）',
      file: 'README.md',
      anchor: '管理端只从 `x-enc-token` 请求头读取该令牌，分享页另发一枚 `HttpOnly`、`path=/s/` 的 Cookie 复用（不进入 `/api/**`）；',
      replacement: '令牌**仅通过 `x-enc-token` 请求头**传递；',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-06 · httpsRedirectHost 注释退回与实现相反的顺序（下轮会被再报一次文档不同步）',
      file: 'server/security.js',
      anchor: '/**\n'
        + ' * R21-13：明文 → HTTPS 跳转目标的**唯一实现点**。\n'
        + ' *\n'
        + ' * 目标选取顺序（R22-06：注释必须与 `:158-168` 的实现**逐项同序**，否则下轮会被\n'
        + ' * 当成「文档不同步」再报一次）：**被允许的请求 Host → 本机 HOST（非通配时）\n'
        + ' * → 配置的站点主/备域名 → 通配回退并告警**。\n'
        + ' *\n'
        + ' * 为什么不直接用 HOST 兜底：`Dockerfile` 里 `HOST=0.0.0.0`（容器必须监听通配地址\n'
        + ' * 才能被外部访问），而 `0.0.0.0` 作为**跳转目标**毫无意义 —— 按 README 的 Docker\n'
        + ' * 快速启动（不注入 `TRUST_PROXY`、不配置站点域名）访问 `http://<服务器>:3000`，\n'
        + ' * 会被 301 到 `https://0.0.0.0:3443/…`（Windows 上根本无法解析）。这不是安全问题，\n'
        + ' * 而是「照文档做即坏」。因此通配绑定地址**不再作为首选兜底**：先看有没有配置站点\n'
        + ' * 域名；都没有时保留原行为并置 `fallbackToBindAll`，由调用方打一条显式告警\n'
        + ' * （保持跳转比默默不跳更可诊断 —— 后者会让人以为 HTTPS 已经就绪，而部署模式下\n'
        + ' * Secure Cookie 其实不会下发）。\n'
        + ' *\n'
        + ' * @param {string} rawHost 请求的 Host 头（可带端口）\n'
        + ' * @returns {{ host: string, fallbackToBindAll: boolean }}\n'
        + ' */\n'
        + 'function httpsRedirectHost(rawHost) {',
      replacement: '/**\n'
        + ' * R21-13：明文 → HTTPS 跳转目标的**唯一实现点**。\n'
        + ' *\n'
        + ' * 目标选取顺序：**被允许的请求 Host → 配置的站点主/备域名 → 本机 HOST**。\n'
        + ' */\n'
        + 'function httpsRedirectHost(rawHost) {',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-01：UploadPart 的 ETag 退回「只从响应体解析」。
       * S3 的 UploadPart 成功响应**体为空**、ETag 只在 `ETag` 响应头，故空串会被存进
       * 会话、合并时提交 `<ETag></ETag>` → 云端 InvalidPart：五家 S3 兼容厂商（OSS /
       * OBS / 七牛 / 又拍 / AWS）所有 >8MB 文件在最后一步必失败。
       */
      name: 'R23-01 · 分片上传 ETag 退回「只解析响应体」（S3 兼容厂商大文件合并必失败）',
      file: 'server/s3-client.js',
      anchor: '      // R23-01：必须取 raw 响应 —— ETag 只在响应头（S3 的 UploadPart 响应体为空）\n'
        + '      const { res, body } = await this._send({\n'
        + "        method: 'PUT', bucket, key: params.Key || '',\n"
        + '        query: { partNumber: String(partNumber), uploadId: params.UploadId },\n'
        + '        body: params.Body, contentLength: params.ContentLength,\n'
        + "        streamBody: params.Body && typeof params.Body.pipe === 'function',\n"
        + '      }, { raw: true });\n'
        + '      return { ETag: etagOf(res, body) };',
      replacement: '      const body = await this._send({\n'
        + "        method: 'PUT', bucket, key: params.Key || '',\n"
        + '        query: { partNumber: String(partNumber), uploadId: params.UploadId },\n'
        + '        body: params.Body, contentLength: params.ContentLength,\n'
        + "        streamBody: params.Body && typeof params.Body.pipe === 'function',\n"
        + '      });\n'
        + "      return { ETag: tag(body, 'ETag') };",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-02：落盘失败补偿退回「同步 try/catch + 先清 dirty」。
       * 默认写入器是异步的（`writeJsonAsync`），同步 catch 既抓不到拒绝、也读不到
       * `resolve(false)`；dirty 已清零 → 变更静默丢失且后续 flush / 退出同步写全部跳过。
       */
      name: 'R23-02 · 去抖落盘失败补偿退回「同步 try/catch」（写失败静默丢变更）',
      file: 'server/coalesce.js',
      anchor: '    let ret;\n'
        + '    try {\n'
        + '      ret = write(file, snap);\n'
        + '    } catch (e) {\n'
        + '      markWriteFailed(e); // 同步写入器抛错（如 corrupt 文件拒绝写，或注入的同步假写入器）\n'
        + '      return;\n'
        + '    }\n'
        + '    if (ret && typeof ret.then === \'function\') {\n'
        + '      ret.then((ok) => {\n'
        + '        // 注入的假写入器若 resolve(undefined) 视为成功；只有显式 false / 拒绝算失败。\n'
        + "        if (ok === false) markWriteFailed(new Error('写入器返回失败（false）'));\n"
        + '        else lastError = null;\n'
        + '      }, (e) => markWriteFailed(e));\n'
        + '    } else {\n'
        + '      lastError = null;\n'
        + '    }',
      replacement: '    try {\n'
        + '      write(file, snap);\n'
        + '    } catch (e) {\n'
        + '      console.error(`[coalesce] 排队落盘失败 ${path.basename(file)}: ${(e && e.message) || e}`);\n'
        + '    }',
      testFile: 'audit14-perf.test.js',
      minFail: 2,
    },
    {
      /**
       * R23-04：把 `/fs/search` 从 `apiHandler(...)` 包装退回**未包装的裸 async**。
       * 两步变异（同时改开头与结尾，保证仍是**语法合法**的代码 —— 只删 `try {` 会留下
       * 孤儿 catch、让子进程直接崩在解析阶段，那是「变异不等价」的假红，正是本项目
       * 反复强调要避免的形态）。
       *
       * 退回后该处理器既无包装、也无自带 try/catch → Express 4 不捕获它的 rejection，
       * 抛错即请求永久挂起（既不 500 也不结束）。静态护栏必须报红。
       */
      name: 'R23-04 · 路由处理器退回「未包装的裸 async」（Express 4 下抛错即请求永久挂起）',
      file: 'server/routes/fs.js',
      mutations: [
        {
          anchor: "router.get('/fs/search', apiHandler(async (req, res) => {",
          replacement: "router.get('/fs/search', async (req, res) => {",
        },
        {
          anchor: '      hint: !exhausted ? `该目录下还有未扫描的对象（本轮已扫描 ${scanned} 个），可继续搜索。` : \'\',\n    });\n}));',
          replacement: '      hint: !exhausted ? `该目录下还有未扫描的对象（本轮已扫描 ${scanned} 个），可继续搜索。` : \'\',\n    });\n});',
        },
      ],
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    /* ======================= 第 24 轮（P2 安全加固批次） ======================= */
    {
      /**
       * R24-01：站点对外地址的兜底退回「直接信任请求 Host」。
       * 这是回调劫持的原始形态：付费链接的任意访问者带自定义 Host 即可让
       * `notify_url` / `return_url` 指向自己的域。
       */
      name: 'R24-01 · 支付回调地址退回「直接信任请求 Host」（异步通知被劫持）',
      file: 'server/share-routes.js',
      anchor: "  if (host && security.isOwnSiteHost(host, [])) return (proto + '://' + host).replace(/\\/+$/, '');",
      replacement: "  if (host) return (proto + '://' + host).replace(/\\/+$/, '');",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-02：WebAuthn 的 rpId 退回「无条件按请求 Host 推导」。
       * 把域名解析到同一 IP 的钓鱼站于是能完整代理两步登录，防钓鱼属性被抵消。
       */
      name: 'R24-02 · WebAuthn rpId 退回「按请求 Host 推导」（钓鱼站可代理两步登录）',
      file: 'server/routes/_shared.js',
      anchor: '  if (security.IS_DEPLOY && !security.isOwnSiteHost(rpId, []) && !isLoopbackHostname(rpId)) {',
      replacement: '  if (false && security.IS_DEPLOY && !security.isOwnSiteHost(rpId, []) && !isLoopbackHostname(rpId)) {',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-03：解密侧退回「只用密文流里的 IV」而不与元数据比对。
       * 重排等长分段时每段自洽、GCM 认证全部通过 → 静默产出被重排的明文。
       */
      name: 'R24-03 · 分段 IV 退回「不与元数据比对」（重排 / 拼接密文静默通过）',
      file: 'server/enc-store.js',
      anchor: "            const wantIv = segs[si] && segs[si].iv ? String(segs[si].iv).toLowerCase() : '';",
      replacement: "            const wantIv = ''; // 退回：只认密文流里的 IV，不与元数据比对",
      testFile: 'crypto-storage.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-06：CSRF 退回「只认自定义头」的单点判据。
       * 该判据依赖「浏览器不让跨站请求伪造自定义头」—— 一旦引入 CORS 或反代补头，
       * 防线静默消失且没有任何症状。
       */
      name: 'R24-06 · CSRF 退回「只认 X-Requested-With」单点判据（跨站来源不再校验）',
      file: 'server/security.js',
      anchor: '  let from = \'\';\n'
        + '  try { from = new URL(src).host; } catch (e) { return false; }\n'
        + '  const want = normalizeHost(String(req.get(\'host\') || \'\'));\n'
        + '  return normalizeHost(from) !== \'\' && normalizeHost(from) === want;',
      replacement: '  return true; // 退回：只认自定义头，不校验来源',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-04（棘轮）：在路由里**多复制一份**内联错误响应。
       *
       * 本轮的棘轮护栏（`invariants.test.js` 的 `INLINE_ERROR_COPY_MAX`）只许减不许增，
       * 这条对照把总数从冻结点推高 1 —— 若棘轮失效（判据被改坏 / 上限被悄悄上调），
       * 这里就撤不红。注入的行是**静态注入**（该文件在 `invariants.test.js` 里只被当作
       * 文本读取、从不执行），因此无需保证运行时可达。
       */
      name: 'R23-04（棘轮）· 路由内联错误响应副本数增加 1（收敛点形同虚设）',
      file: 'server/routes/fs.js',
      anchor: '    res.json(payload);\n}));\n',
      replacement: '    const err = e.status ? e : translateError(e); // 棘轮反例：多复制一份\n'
        + '    res.json(payload);\n}));\n',
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ==================== R25 · 负载均衡（按 API Key 的空间配额） ====================
     *
     * 本轮的判据全部集中在「谁被算进用量」与「每个写入入口都真的接了闸门」两件事上。
     * 每条对照对应 `tests/audit25-regressions.test.js` 里**各自**的断言落点 ——
     * 只有这样才能证明「某处闸门被摘掉」会真的变红，而不是被另一处的断言掩盖。
     */
    {
      name: 'R25-01 · 用量聚合只看 credentialId（未绑定密钥的桶被漏算）',
      file: 'server/bucket-stats.js',
      anchor: 'const mine = (cfg.buckets || []).filter((b) => configStore.credentialIdForBucket(cfg, b) === credId);',
      replacement: "const mine = (cfg.buckets || []).filter((b) => (b.credentialId || '') === credId);",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-02 · 配额判定不再拒绝（闸门整条失效）',
      file: 'server/bucket-stats.js',
      anchor: 'if (usage.usedBytes + addBytes > usage.quotaBytes) {',
      replacement: 'if (false) {',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-03 · 判定不再并入未取样增量（缓存期内可无限超额）',
      file: 'server/bucket-stats.js',
      anchor: 'const pending = Math.max(0, pendingUsageDelta(r.cfg));',
      replacement: 'const pending = 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-04 · 咽喉点不再把写入增量喂给配额记账',
      file: 'server/routes/stats.js',
      anchor: '  recordUsageDelta(cfg, delta);\n',
      replacement: '',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【mkdir】· 新建文件夹不再过配额闸门',
      file: 'server/routes/fs.js',
      // 三处闸门（mkdir / rename / move）的 `await` 行**逐字相同**，仅靠注释行区分时，
      // 注释被 `stripComments` 抹白成等长空格，注释长度一旦相同两条 anchor 就会互相命中
      // （`String.replace` 只替换首处 → 变异打偏 → 假绿）。故 anchor 必须带上紧随其前的
      // **真实代码行**（各不相同），唯一性才由代码而非注释长度决定。
      // R28-02：anchor 改为**纯代码行**（不再夹注释）—— 本轮给每个闸门后面追加了
      // `assertBucketQuota`，夹注释的 anchor 会因为「注释变长」而失配（注释在扫描前
      // 被抹成等长空白，长度一变就命中不了）。代码行本身足以唯一。
      anchor: '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '    const client = getClient(cfg);\n'
        + '    await assertBucketQuota(client, cfg, { addBytes: 0 });',
      replacement: '    const client = getClient(cfg);',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【simple】· 直传不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: '    await assertCredentialQuota(cfg.credentialId, { addBytes: req.body.length });',
      replacement: '    void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【init】· 分片上传初始化不再过配额闸门',
      file: 'server/routes/fs.js',
      // R28-02：init 的净增量先落到 `netAdd` 变量再进闸门（两处闸门共用同一口径），
      // 故 anchor 随之改为这三行纯代码。
      anchor: '      const netAdd = Math.max(0, size - already);\n'
        + '      await assertCredentialQuota(cfg.credentialId, { addBytes: netAdd });\n'
        + '      await assertBucketQuota(client, cfg, { addBytes: netAdd });',
      replacement: '      const netAdd = Math.max(0, size - already);',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【rename】· 重命名不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: '    if (newKey === key) return res.json({ ok: true, unchanged: true });\n\n'
        + '    // R25：重命名是「复制到新键 + 删源键」，同桶内净占用不变 → `addBytes=0`（仅「已超额」时拒绝）\n'
        + '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: '    if (newKey === key) return res.json({ ok: true, unchanged: true });\n\n'
        + '    // R25：（变异）闸门已摘除',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【move】· 移动不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: "    if (!paths.length) throw badRequest('未选择要移动的对象');\n"
        + '    // R25：移动同桶内净占用不变 → `addBytes=0`（仅「已超额」时拒绝）\n'
        + '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: "    if (!paths.length) throw badRequest('未选择要移动的对象');\n"
        + '    // R25：（变异）闸门已摘除',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-06 · 新建存储桶不再过配额闸门',
      file: 'server/routes/buckets.js',
      anchor: '      await assertCredentialQuota(targetCred, { addBytes: 0 });',
      replacement: '      void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV PUT·目录】· 不再过配额闸门',
      file: 'server/webdav/app.js',
      // R28-02：同「mkdir」—— anchor 去注释化，靠 8 空格缩进与 MKCOL/COPY 的 6 空格区分
      anchor: '        await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '        await bucketStats.assertBucketQuota(s3, cfg, { addBytes: 0 });',
      replacement: '        void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV PUT·文件】· 不再过配额闸门',
      file: 'server/webdav/app.js',
      anchor: '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: putLen });',
      replacement: '      void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV MKCOL】· 不再过配额闸门',
      file: 'server/webdav/app.js',
      anchor: "      const dirKey = key.endsWith('/') ? key : key + '/';\n"
        + '      // R25：新建集合是 0 字节对象 → `addBytes=0`\n'
        + '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: "      const dirKey = key.endsWith('/') ? key : key + '/';",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV COPY·MOVE】· 不再过配额闸门',
      file: 'server/webdav/app.js',
      anchor: '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '      await bucketStats.assertBucketQuota(s3, cfg, { addBytes: 0 });\n'
        + '      if (!srcIsDir) {',
      replacement: '      if (!srcIsDir) {',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-08 · 前端配额错误码与服务端不一致（弹窗永不触发）',
      file: 'public/js/util.js',
      anchor: "export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';",
      replacement: "export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED_TYPO';",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    /* ==================== R26 · 新增四家 S3 兼容服务商 ====================
     *
     * 本轮的判据全部落在**厂商差异点**上：R2 的账户 ID 前缀、MinIO 的路径风格、
     * 「地域可留空」的建桶闸门、以及「重新保存不得改写厂商/端点」。
     * 每条对照对应 `tests/audit26-regressions.test.js` 里**各自**的断言落点。
     *
     * ⚠️ 有些差异点由**三处**协同实现（元数据 → 客户端工厂 → 寻址判据），
     * 每一处都单独登记一条 —— 只钉住其中一处时，另外两处被摘掉照旧全绿。
     */
    {
      name: 'R26-01 · 前端展示顺序漏掉新增厂商（与服务端注册表漂移）',
      file: 'public/js/provider-logos.js',
      // R30：Azure 正式接入后 ORDER 变为「又拍云 → Azure → AWS S3」，锚点随之更新；
      // R45：UCloud 插到「七牛云 → UCloud → 又拍云」之间，锚点再次同步迁移。
      // ⚠️ **每次往注册表里插一家厂商，这条 anchor 都会失效** —— `invariants.test.js`
      // 的「anchor 必须在各自的 file 内命中」自检会当场点名，务必顺手迁移。
      // 变异语义不变（删掉一家 → 前端顺序与服务端注册表逐项比对必然错位）。
      anchor: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'ucloud', 'upyun', 'azure', 'aws', 'gcs', 'r2', 'minio', 'b2'];",
      replacement: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'upyun', 'azure', 'aws', 'gcs', 'r2', 'minio', 'b2'];",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-01b · 商标图形被换成别的版本（viewBox 与源文件不一致）',
      file: 'public/js/provider-logos.js',
      anchor: "    viewBox: '0 0 2048 1024',",
      replacement: "    viewBox: '0 0 1024 1024',",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-02 · R2 端点组装不再幂等（重复保存把域名拼成两层）',
      file: 'server/providers.js',
      anchor: '    if (/^https?:\\/\\//i.test(raw)) return raw;\n'
        + "    const suffix = p.endpointTemplate.replace('{region}', '');\n"
        + "    if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase())) return 'https://' + raw;",
      replacement: '    if (/^https?:\\/\\//i.test(raw)) return raw;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-03 · R2 回到「地域填主机名中段」的推导路径（拼出 auto.r2... 假域名）',
      file: 'server/providers.js',
      anchor: "  if (p.endpointMode === 'template') return '';\n  if (p.endpointTemplate && region) {",
      replacement: '  if (p.endpointTemplate && region) {',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-04a · 地域字符集不再受限（可拼进端点改写主机 / 路径）',
      file: 'server/providers.js',
      anchor: 'const REGION_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;',
      replacement: 'const REGION_SAFE_RE = /^[\\s\\S]*$/;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-04b · 允许留空的厂商不再补默认地域（空串进入签名串）',
      file: 'server/providers.js',
      anchor: "  const raw = String(region || '').trim() || String(p.defaultRegion || '').trim();",
      replacement: "  const raw = String(region || '').trim();",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05a · MinIO 不再强制路径风格（拼出解析不了的 bucket.<host>）',
      file: 'server/providers.js',
      anchor: '  return resolve(id).forcePathStyle === true;',
      replacement: '  return false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05b · 客户端工厂漏传 forcePathStyle（元数据对了但没接上线）',
      file: 'server/s3.js',
      anchor: '    forcePathStyle: providers.forcePathStyle(pid),',
      replacement: '    forcePathStyle: false,',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05c · 寻址判据丢掉 forcePathStyle（唯一的 _virtualHosted 实现）',
      file: 'server/s3-client.js',
      anchor: "    return !this.forcePathStyle && this.basePath === '';",
      replacement: "    return this.basePath === '';",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06a · 「只改备注」的保存把端点一并清空（旧实现的无条件写入）',
      file: 'server/config-store.js',
      anchor: '      exist.endpoint = ep;',
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06b · 重新保存无条件改写厂商（R2 密钥被回落成腾讯云）',
      file: 'server/config-store.js',
      anchor: '    if (explicitProvider) exist.provider = pid;',
      replacement: '    exist.provider = pid;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06c · 端点组装改用入参厂商（重新保存 R2 时按腾讯云组装 → 账户 ID 送校验被拒）',
      file: 'server/config-store.js',
      anchor: '  const epProvider = explicitProvider || (exist && exist.provider) || pid;',
      replacement: '  const epProvider = pid;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06d · 不再要求「必填端点」的厂商真的填端点（落库一条永远连不上的密钥）',
      file: 'server/config-store.js',
      anchor: '  if (endpoint || !providers.endpointRequired(pid)) return;',
      replacement: '  return;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06e · 更新密钥时先落值后校验（被拒绝的更新把内存里的端点改坏）',
      file: 'server/config-store.js',
      anchor: '    assertEndpointProvided(c.provider, nextEndpoint);',
      replacement: '    // 变异：校验挪到落值之后',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-07a · 建桶时不再为「地域可留空」的厂商补默认地域（空串落库）',
      file: 'server/routes/buckets.js',
      anchor: "      region = providers.regionFor(effectiveProvider, '');",
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-07b · 建桶的地域闸门整体失效（必填厂商也放行空地域）',
      file: 'server/routes/buckets.js',
      anchor: "      return res.status(400).json({ error: '请填写存储桶地域（Region）' });",
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08a · 表单的服务端点栏不再按厂商显隐',
      file: 'public/js/credmgr.js',
      anchor: '    epItem.hidden = !mode;',
      replacement: '    epItem.hidden = false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08b · 保存密钥时不再提交服务端点（前端收了值却发不出去）',
      file: 'public/js/credmgr.js',
      anchor: '      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers, endpoint });',
      replacement: '      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers });',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08c · 建桶表单的地域星号不再按厂商隐显（界面说必填、服务端允许留空）',
      file: 'public/js/main.js',
      anchor: '    if (regionReq) regionReq.hidden = prov.regionRequired === false;',
      replacement: '    if (regionReq) regionReq.hidden = false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },

    /* ============================================================== *
     * R27 台账补登（外部独立审计 26 条）
     *
     * 第 27 轮当时只加了 tests/audit27-regressions.test.js 的行为护栏，
     * 未登记反向对照 —— 于是「撤掉修复是否真的变红」从未被验证过。
     * 这里按铁律补齐：每条都撤销该轮引入的**判据本身**（而非某个副作用）。
     * ============================================================== */
    {
      name: 'R27-01 · 重命名入口重新引用 explorer 上不存在的成员（对话框不弹、静默无反应）',
      file: 'public/js/ops.js',
      anchor: '    const item = explorer.itemOf(key);',
      replacement: '    const item = explorer.__noSuchMember(key);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-03 · 分享页同源校验退回裸 req.secure（反代 TLS 终结下全部 POST 被自己挡成 403）',
      file: 'server/share-routes.js',
      anchor: '    secure: security.requestIsSecure(req), // R27-03：与上面同一判据（Referer 回退分支同病）',
      replacement: '    secure: req.secure,',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-07 · XFF 规范化不再拒绝前导零写法（同一地址得到多个限流键 → 预算可轮换）',
      file: 'server/ip-guard.js',
      anchor: '    if (/(^|\\.)0\\d/.test(s)) return null;',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-09 · 规则目标 `1.2.3.4/` 重新退化成 /0（一条笔误屏蔽全网）',
      file: 'server/ip-guard.js',
      anchor: "    if (prefixPart !== null && prefixPart === '') return null;",
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-10 · 畸形百分号编码重新把 ip-guard 打成 500（未认证可达 + 日志刷屏）',
      file: 'server/ip-guard.js',
      anchor: '    try {\n'
        + '      return decodeURIComponent(m[1]);\n'
        + '    } catch (e) {\n'
        + '      return null;\n'
        + '    }',
      replacement: '    return decodeURIComponent(m[1]);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-11 · AES-GCM 在认证通过前就把明文下发（等长错误明文先到客户端）',
      file: 'server/enc-store.js',
      anchor: '            segPlain.push(decipher.update(t)); // R27-11：先攒着，认证通过后再 push',
      replacement: '            this.push(decipher.update(t));',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-13 · 主密钥回到「先以默认权限落地再 chmod」（存在同机可读私钥的窗口）',
      file: 'server/config-store.js',
      anchor: "writeAtomicSync(KEY_FILE, key.toString('hex'), { mode: 0o600 })",
      replacement: "writeAtomicSync(KEY_FILE, key.toString('hex'))",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-14 · 原子写不再 fsync（断电后 rename 可能先于数据落盘）',
      file: 'server/atomic-write.js',
      anchor: '    fs.fsyncSync(fd);',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-15 · S3 签名路径不再删除点段（含 `.` 段的键必然 SignatureDoesNotMatch）',
      file: 'server/s3-client.js',
      anchor: "    if (seg === '.') continue;",
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-20 · 二维码走位不再跳过第 6 列（第 0 列永远拿不到数据位）',
      file: 'server/qrcode.js',
      anchor: '    if (right === 6) right = 5;',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-25 · 端点黑名单比对不再去掉尾点（`localhost.` / 元数据主机名可绕过）',
      file: 'server/endpoint-guard.js',
      anchor: '  const hostKey = normalizeHostForCompare(host); // R27-25：去尾点后再比对黑名单',
      replacement: "  const hostKey = String(host || '').toLowerCase();",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-26 · gzip 跳过判据不再小写化（/api/fs/DOWNLOAD 被纳入压缩流程）',
      file: 'server/gzip.js',
      anchor: "  const path = String(req.path || '').toLowerCase();",
      replacement: "  const path = String(req.path || '');",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-04/12 · 合并完成不再按实际字节记账（重回客户端在 init 声明的 size）',
      file: 'server/routes/fs.js',
      anchor: '    adjustStorageCache(actualBytes, sessCfg);',
      replacement: '    adjustStorageCache(sess.size, sessCfg);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },

    /* ============================================================== *
     * R28 台账补登（第二轮独立审计 6 条）
     * ============================================================== */
    {
      name: 'R28-01 · 派生缓存 `_parsed` 重新被一并加密落盘（IPv6 规则重启后永不命中）',
      file: 'server/ip-guard.js',
      anchor: '      delete copy._parsed;',
      replacement: '      void 0;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-02 · /fs/mkdir 的桶级配额闸门被摘除（quotaBytes 退回「只展示、零拦截」）',
      file: 'server/routes/fs.js',
      anchor: '    const client = getClient(cfg);\n'
        + '    await assertBucketQuota(client, cfg, { addBytes: 0 });\n'
        + "    let key = normalizeKey(String((req.body || {}).path || ''));",
      replacement: '    const client = getClient(cfg);\n'
        + "    let key = normalizeKey(String((req.body || {}).path || ''));",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-03 · 带 Range 的请求重新进入压缩流程（206 与 Content-Encoding 打架）',
      file: 'server/gzip.js',
      // 本轮的修复是**两层**（`shouldCompress` 按请求头 `Range` 早退 + `end()` 阶段按真实 206 /
      // `Content-Range` 兜底），任何一层单独摘掉都不可观测（另一层仍然拦住）—— 这正是
      // 「纵深防御」的正常形态。故这里用多步变异把**两层一起**退回旧实现，
      // 判据是真实 Range 请求的响应头（audit28 的端到端用例）。
      mutations: [
        { anchor: '  if (req.headers && req.headers.range) return false;', replacement: '  void 0;' },
        {
          anchor: '    const ranged = Number(res.statusCode) === 206 || Boolean(res.getHeader(\'Content-Range\'));',
          replacement: '    const ranged = false;',
        },
      ],
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      // R49 退役：自签名证书不再由本应用生成 —— `server/local-cert.js` 整体删除，
      // 改为只读加载运维自备的 TLS_CERT_FILE / TLS_KEY_FILE（见 server/tls-cert.js）。
      // 「读取缓存证书 → 判定弱签名 → 就地重签」这条链路已不存在，变异无目标。
      retired: true,
      retiredReason: 'R49 移除自签名证书后 server/local-cert.js 整模块删除，'
        + '本应用不再生成/改写任何证书，弱签名重签分支已不存在；取代它的护栏见 audit49。',
      name: 'R28-04 · 弱签名判据回到 X509Certificate#signatureAlgorithm（Node 18/20/22 无此属性 → 恒 false）',
      file: 'server/local-cert.js',
      anchor: '    const oid = signatureOidOf(new crypto.X509Certificate(certPem).raw);\n'
        + '    return !oid || WEAK_SIGNATURE_OIDS.has(oid);',
      replacement: "    return /sha1/i.test(String(new crypto.X509Certificate(certPem).signatureAlgorithm || ''));",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      // R49 退役：同上 —— 读取路径本身（getSelfSignedCert）已随模块删除。
      retired: true,
      retiredReason: 'R49 移除自签名证书后 getSelfSignedCert 已不存在，'
        + '「读取缓存 → 复用或重签」的调用点无从变异；取而代之的是 audit49 的加载失败降级用例。',
      name: 'R28-04 · 判据函数还在、但读取路径不再调用它（重签分支永远不可达）',
      file: 'server/local-cert.js',
      anchor: '      if (c.key && c.cert && fresh && !isWeakSignature(c.cert)) return c;',
      replacement: '      if (c.key && c.cert && fresh) return c;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-05 · 接管时「先让锁文件消失再放行」（第三实例可趁隙抢到锁）',
      file: 'server/instance-lock.js',
      // 早期实现（R27-21）是「把锁文件 rename 挪走 → 校验 → 建新锁」，R28-05 换成
      // 「抢 O_EXCL 接管标记 → 就地覆写」。这里复现**可观测后果**：接管时把 LOCK_FILE
      // 删掉并直接放行（不抢标记）—— 锁文件在窗口内不存在，第三实例的 wx 创建会成功
      // 并与原持有者形成双持锁（见 audit28 的 R28-05 用例）。
      anchor: "      fs.writeFileSync(TAKEOVER_FILE, payload, { flag: 'wx' });",
      replacement: '      try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 变异：锁文件已不存在 */ }\n'
        + '      return true;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-06 · unparsable 与「规则命中」文案重新分不清（把人引去找一条不存在的规则）',
      file: 'server/ip-guard.js',
      anchor: "  if (reason === 'unparsable') return '无法识别您的来源地址（反代未按模板转发 X-Forwarded-For，或该值非法），已拒绝访问';",
      replacement: "  if (reason === 'unparsable') return '您的 IP 已被管理员屏蔽';",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    /* ============ R29 / R30 / AZ · Azure 接入 + 用户报告问题的修复 ============
     *
     * 第 29 轮（用户报告的两个运行期问题）与第 30 轮（Azure 接入）此前**只写了行为护栏、
     * 没登记变异**（台账停在 233），这里连同第 30 轮缺陷检测（`AZ-01`~`AZ-05`）一并补登。
     *
     * ⚠️ Azure 这一组要绕开两类「改了也全绿」：
     *  ① **假服务的期望值曾与实现同源**（SAS 规范资源一处照抄了客户端的错误形态）——
     *     两侧共享同一假设时，验签只能证明自洽。现在假服务按官方规范写死期望值，
     *     故 AZ-01 的变异是**真的**会红（这也是它当初能骗过 20 条用例的原因）。
     *  ② **纵深防御的各层单独摘掉都不可观测**：块列表的「只发一页」与「按分片号去重」
     *     互为兜底，任一层单独摘掉都不改变可观测结果 → R30-02 按**多步变异**登记
     *     （一起退回旧实现：既多打一次请求，又把同一批分片重复累加）。
     *
     * ⚠️ 补登后逐条实跑，又逼出四处台账自身的问题（判据与修法都写在这里，别再踩）：
     *  ① **变异必须自包含，不能只删一半**：AZ-03 最初只锚到 `if (!this._isGone(e)) throw e;`
     *     那一行，替换后留下一个悬空的 `}` ⇒ 整个测试文件语法错误、以
     *     `not ok 1 - tests\azure-client.test.js`（**文件级**）计入 fail。计数同样是 1，
     *     `fail>=1` 被**巧合满足**而一条行为断言都没跑 —— 与 R7-07（搬源码撞 TDZ）同型。
     *     判据：红的是**用例名**，还是文件本身？只看 `fail>=1` 看不出来，必须看名单。
     *  ② **期望失败数要按实测写**：R30-02 / AZ-05 原本写 `minFail: 2`，实测各只有 1 条用例
     *     能观测（两层防御的另一层在单页 / 同会话场景下无从触发）。写高了会把**正确**的
     *     变异误判成失败，写低了才是真放过。
     *  ③ **护栏可能被注释满足**：R29-02b 首跑 `fail=0`，追下去是 `audit29-regressions.test.js`
     *     的 `src.slice(i, i + 900).includes('App.onConfigChanged(')` —— 而 `toggleBucketEnabled`
     *     上方那段**说明注释里也有同样字样**，真调用被摘掉后注释照旧命中。判据改为只认
     *     代码行（该文件里的 `codeLines()`）后正常变红。**这正是为什么每条护栏都要跑一次
     *     反向变异**：护栏自称覆盖了 N 处，与它真的打在那 N 处上，是两件事。
     */
    {
      name: 'R30-01 · 账户级请求（列容器）被误回退成默认容器（getService 打到 /容器?comp=list）',
      file: 'server/azure-client.js',
      anchor: "      return this.basePath || '/'; // 账户级请求：路径即根",
      replacement: "      return this.basePath + '/' + encodeURIComponent(this.container); // 旧实现：误当成「用默认容器」",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 多步变异：① 去掉按分片号去重；② 只要响应带游标就再取一次同一页（旧实现的 marker 循环
      // 从未把 marker 送进请求，因此第二圈拿到的还是第一页）—— 合起来正是旧实现的可观测后果：
      // 请求数 +1 且分片被重复累加（实测 [1,2,1,2]）。
      name: 'R30-02 · Get Block List 被写成翻页循环（多打一次请求 + 同一批分片重复累加）',
      file: 'server/azure-client.js',
      mutations: [
        {
          anchor: "        if (!n || seen.has(n)) continue;\n        seen.add(n);",
          replacement: "        if (!n) continue;",
        },
        {
          anchor: "      const { text } = await this._request({\n        method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n      });",
          replacement: "      let { text } = await this._request({\n        method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n      });\n"
            + "      if (tag(text, 'NextMarker')) { // 旧实现：游标从未进入请求 ⇒ 再取一次仍是同一页\n"
            + "        const again = await this._request({\n          method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n        });\n"
            + '        text += again.text;\n      }',
        },
      ],
      testFile: 'azure-client.test.js',
      minFail: 1, // 实测：只有「带游标」那条用例能观测到（无游标时单页，两层防御都无从触发）
    },
    {
      name: 'AZ-01 · SAS 规范资源退回旧形态（缺 /blob 服务名、且用编码后的路径去签）',
      file: 'server/azure-client.js',
      anchor: "      const canonicalizedResource = `/blob/${this.accountName}/${bucket}`\n        + (key ? '/' + String(key) : '');",
      replacement: "      const canonicalizedResource = `/${this.accountName}${path}`;",
      testFile: 'azure-client.test.js',
      minFail: 2,
    },
    {
      name: 'AZ-02 · 复制源 URL 硬编码公有云域名（主权云 / Azurite 下复制必然失败）',
      file: 'server/azure-client.js',
      anchor: "    return `${this.protocol}//${this.host}${this.basePath}${p}`;",
      replacement: "    return `https://${this.accountName}.blob.core.windows.net${p}`;",
      testFile: 'azure-client.test.js',
      minFail: 2,
    },
    {
      name: 'AZ-03 · 单删退回「不存在即报错」（与 S3/COS 及本文件批删口径分叉）',
      file: 'server/azure-client.js',
      // ⚠️ 锚点必须**带上收尾的 `}`**。第一版只锚到 `if (!this._isGone(e)) throw e;` 那一行，
      // 替换后留下一个孤立的 `}` ⇒ 整个 azure-client.test.js 变成语法错误、以
      // `not ok 1 - tests\azure-client.test.js`（文件级）计入 fail —— 计数同样是 1，
      // 「撤掉修复必须变红」被**巧合满足**，而实际上一条行为断言都没跑到。
      // 这正是 R7-07 那类「变异把源码弄成另一件事」的坑（判据：看红的是**用例名**还是文件本身）。
      anchor: "      try {\n        await this._request({ method: 'DELETE', bucket, key });\n      } catch (e) {\n"
        + "        if (!this._isGone(e)) throw e; // 本就不存在 = 已达成删除（与 S3 / COS 的幂等语义一致）\n      }",
      replacement: "      await this._request({ method: 'DELETE', bucket, key });",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 旧实现用的是一个「宽容解码」助手（非法转义原样保留）。这里把两半都复现出来，
      // 避免变异引入原实现没有的异常路径（那会让"进程因别的原因死掉"混进来）。
      name: 'AZ-04 · 查询值在签名里被重复解码（键名含字面 %XX 时签名与实发不符 ⇒ 403）',
      file: 'server/azure-client.js',
      anchor: "    out += '\\n' + name.toLowerCase() + ':' + value;",
      replacement: "    let decoded;\n    try { decoded = decodeURIComponent(String(value)); } catch (err) { decoded = String(value); }\n"
        + "    out += '\\n' + name.toLowerCase() + ':' + decoded;",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 旧实现不按会话过滤：Azure 的未提交块挂在目标对象上，他次会话遗留的块照样被当成进度。
      // 判据取「提交结果里出现了外来的那个块」，而不是「块名长什么样」——后者改不动行为。
      name: 'AZ-05 · 块列表不再按会话令牌过滤（采信上一次会话遗留的块）',
      file: 'server/azure-client.js',
      anchor: "        if (blockTokenIn(name) !== own) continue; // 他次会话的遗留块：不认，否则会跳过本应重传的分片",
      replacement: "        // 旧实现不按会话过滤：他次会话的块照样被当成「已落云」的进度",
      testFile: 'azure-client.test.js',
      minFail: 1, // 实测：本文件里只有这条专属用例构造了「他次会话遗留的块」；同会话内续传照旧全绿
    },
    {
      name: 'R29-01a · 上传停滞看门狗被摘掉（服务端不回应就永远停在「上传中」）',
      file: 'public/js/api.js',
      anchor: "    const armWatchdog = () => {\n      clearWatchdog();",
      replacement: "    const armWatchdog = () => {\n      if (UPLOAD_IDLE_MS >= 0) return; // 旧实现：没有任何停滞保护（不 arm 定时器）\n      clearWatchdog();",
      testFile: 'audit29-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R29-01b · 停滞错误被标成 aborted（本该重试两次变成一次即失败）',
      file: 'public/js/api.js',
      anchor: "        err.stalled = true; // 不设 aborted：让上层按既有的重试策略再试",
      replacement: "        err.stalled = true;\n        err.aborted = true; // 旧实现：标成 aborted ⇒ uploadWithRetry 直接放弃",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01c · 进度条不再封顶 99%（请求体一发完就显示 100%，看起来就是「假死」）',
      file: 'public/js/upload.js',
      anchor: "  t.progress = t.size ? Math.min(99, (t.loaded / t.size) * 100) : 99;",
      replacement: "  t.progress = t.size ? Math.min(100, (t.loaded / t.size) * 100) : 100;",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01d · 丢掉「服务器处理中」相位（字节已发完却仍写「上传中」）',
      file: 'public/js/upload.js',
      anchor: "      if (t.state === 'uploading' && t.phase === 'processing') st[0] = '服务器处理中…';",
      replacement: "      // 旧实现没有「服务器处理中」这一相位",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01e · 上传成功后的界面刷新不再吞异常（业务成功却被改判成「失败」）',
      file: 'public/js/upload.js',
      anchor: "  try { App.refreshStorage && App.refreshStorage(); } catch (e) { /* 立即刷新状态栏存储用量 */ }",
      replacement: "  App.refreshStorage && App.refreshStorage();",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02a · 密钥可见性改完不再刷新全局配置（存储桶弹窗的密钥下拉读的是快照）',
      file: 'public/js/credmgr.js',
      anchor: "    await API.updateCredential(cred.id, { visibleToUsers: want });\n    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });\n    refresh();\n    App.reloadConfig();",
      replacement: "    await API.updateCredential(cred.id, { visibleToUsers: want });\n    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });\n    refresh();",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02b · 启停存储桶退回只派发 buckets-changed（侧边栏读的是快照，没人重新取数）',
      file: 'public/js/bucketmgr.js',
      anchor: "    App.onConfigChanged();\n  } catch (e) {\n    toast(`${label}失败：` + e.message, { type: 'error' });",
      replacement: "    window.dispatchEvent(new CustomEvent('buckets-changed'));\n  } catch (e) {\n    toast(`${label}失败：` + e.message, { type: 'error' });",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02c · 清空桶 / 桶内容变动后不再走全局刷新（被删掉的文件仍留在文件列表里）',
      file: 'public/js/bucketmgr.js',
      anchor: "function afterBucketMutated(row) {\n  App.onConfigChanged();\n  if (row && row.active) App.refreshStorage();\n}",
      replacement: "function afterBucketMutated(row) {\n  window.dispatchEvent(new CustomEvent('buckets-changed'));\n  if (row && row.active) { App.refreshStorage(); App.refresh(); }\n}",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R31-01 / R31-02：批量删除的 Content-MD5。
       *
       * 缺陷来源（用户报障）：网页界面删文件，Toast 显示
       * 「删除完成，N 项失败：MissingArgument: Missing Some Required Arguments.」
       *
       * 定位链：`ops.js` → `API.del` → `POST /api/fs/delete` → `deleteMultipleConfirmed`
       * → `s3-client.deleteMultipleObject` → `_send()` 的 `${code}: ${message}`。
       * 报错文案形如 `Name: Message.`，说明**上游**返回了
       * `<Code>MissingArgument</Code><Message>Missing Some Required Arguments.</Message>`
       * —— 项目内四个错误整形点（`s3.translateError`、`davErrorMessage`、
       * `deleteMultipleConfirmed`、`routes/fs.js`）输出的全是中文，故这句原文只可能来自云端。
       *
       * 定位到厂商与缺失项：`DeleteObjects`（`POST /<bucket>?delete`）**必须**带
       * `Content-MD5` —— AWS S3 明确「required for all Multi-Object Delete requests」，
       * 阿里云 OSS 的请求头表把 Content-MD5 标为「是」并示范 `Content-MD5: MD5Value`；
       * 缺失时 OSS 回的就是上面那句**不点明缺什么**的 `MissingArgument`（现实世界同形
       * 报错：lobe-chat#6746「s3 为阿里云的对象存储」，结论同样是补 Content-MD5）。
       * 本项目的 `deleteMultipleObject` 一直只发 `content-type`，故**所有**文件
       * （含刚上传成功的）在任何走该厂商的桶上都删不掉，而同桶列举/上传/下载全正常。
       *
       * 两条变异各自有独立的可观测后果（不是同一条的重复）：
       *  - R31-01 摘掉请求头 → 伪服务回 400 MissingArgument，整批抛错；
       *  - R31-02 把 base64 换成 hex（值不对）→ 伪服务回 400 InvalidDigest。
       *    这条专门证明护栏**校验的是值**而不是「有没有这个头」：只断言 presence
       *    的护栏挡不住「随便写个常量」。
       *
       * 伪服务的期望值按 AWS/OSS 规范写死（自己算 base64(MD5)），**不引用**客户端
       * 的任何片段；并带一条「缺头必须被拒」的自检，避免伪服务形同虚设（第 30 轮
       * SAS 假绿即「期望值与实现同源」）。
       */
      name: 'R31-01a · 批量删除丢掉 Content-MD5（阿里云 OSS 回 MissingArgument，任何文件都删不掉）',
      file: 'server/s3-client.js',
      anchor: "          headers: {\n            'content-type': 'application/xml',\n            'content-md5': md5Base64Of(xmlBuf),\n          },\n          body: xmlBuf,",
      replacement: "          headers: { 'content-type': 'application/xml' },\n          body: xml,",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      name: 'R31-01b · Content-MD5 用 hex 而非 base64（值不对 → 上游判 InvalidDigest）',
      file: 'server/s3-client.js',
      anchor: "            'content-md5': md5Base64Of(xmlBuf),",
      replacement: "            'content-md5': crypto.createHash('md5').update(xmlBuf).digest('hex'),",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      /**
       * R31-02 / R31-03：用户报障的第二件事 ——（设置页两张卡片）
       * 「支付设置」「登录验证」填好信息保存成功后，若功能当前是**停用**状态，
       * 应自动把状态置为启用。用户明确的两个前提：
       *  ① 必须是**本次新填了**信息（不能「关了又被自动打开」，否则开关再也关不掉）；
       *  ② 填写的信息必须**符合规则**（凭证完整）；
       * 支付卡片只自动开**总开关**，不动渠道开关。
       *
       * 实现落在两处调用链上：
       *  - `public/js/syssettings.js` 的 `saveCaptchaSettings()`（把 enabled 一并提交，
       *    不额外发请求 ⇒ 不存在「已保存但启用失败」的半途状态）；
       *  - `public/js/paysettings.js` 的 `doSave()`（保存成功后追加一次
       *    `API.setPaymentEnabled(true)`；能否开由服务端 `paymentRules.checkGlobalToggle`
       *    裁定，前端**不复刻**该规则 —— 复刻就成了同一个判据的第二个实现点）。
       *
       * 这三条闸门**每一条都对应一个会红的用例**（不是同一个断言的重复）：
       *  - ② `typedNew`：R31-02b / R31-03a 摘掉后，「没填新信息时保存」那两条用例转红；
       *  - ① 「保存前已是启用态」：R31-02a / R31-03b 摘掉后，可停用性用例转红；
       *  - ③ 「凭证完整」：R31-02c / R31-03c 摘掉后，不完整凭证用例转红。
       * 之所以要三条分立，是因为「护栏覆盖了 N 处」与「它真的打在那 N 处上」是两件事
       * （R29-02b 的 `fail=0`、AZ-03 的「文件级红灯」都栽在这里）。
       *
       * 判据落在**真实调用链**上：测试用桩模块图在 Node 里 import 真实的
       * syssettings.js / paysettings.js，用假 DOM 触发真实的保存点击，
       * 断言「实际提交给服务端的 payload」。只断言源码字样的护栏挡不住
       * 「闸门写反了 / 条件恒真」，也挡不住「自动启用根本没接到保存流程上」。
       */
      name: 'R31-02a · 登录验证自动启用不再要求「保存前是停用」（取消勾选保存也会被强行打开）',
      file: 'public/js/syssettings.js',
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked\n    && typedNew && !!sel.siteKey && hasSecret;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02b · 登录验证自动启用不再要求「本次新填了信息」（只拨开关再保存就被打开）',
      file: 'public/js/syssettings.js',
      anchor: "    && typedNew && !!sel.siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      replacement: "    && !!sel.siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02c · 登录验证自动启用不再要求「凭证完整」（只填站点密钥就被启用）',
      file: 'public/js/syssettings.js',
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1, // 实测 2（「只填站点密钥」与「早已配好密钥」两条一起红）；取 1 留余量
    },
    {
      name: 'R31-03a · 支付自动启用不再要求「本次新填了信息」（没改任何字段保存也会开总开关）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (!globalEnabled && r.complete) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-03b · 支付自动启用不再要求「总开关处于停用」（已开着也再切一次）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (typedNew && r.complete) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-03c · 支付自动启用不再要求「凭证完整」（半配好就开总开关）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (!globalEnabled && typedNew) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R32-01 / R32-02：两个新增的批量清理按钮。
       *
       * 需求：① 订单管理加「删除失效订单」（清掉全部**支付失败**的订单）；
       * ② 链接管理加「删除失效链接」（清掉**文件已删除**与**已过期**的链接）。
       *
       * 这一轮最容易做错的地方全都不是「功能有没有写」，而是**边界**：
       *  - 订单那边有个现成的 `isProtected()`，顺手写成「删掉所有可裁流水」就会连
       *    **超出支付窗口的 pending** 一起清 —— 那是「付款者可能正在收银台上」的灰色地带
       *    （R14-03），自动裁剪按容量兜住即可，不该由一次人工点击静默清掉；
       *  - 链接那边「已关闭」（下载次数用尽）是**可逆**状态（调大次数即可复活），
       *    一旦被当成失效删掉就不可逆了；
       *  - 链接管理页**普通用户也能进**，作用域必须靠 `canManage` 隔离，不能照抄
       *    订单那边「反正调用方是管理员」的前提（那边挂了 requireAdmin，这边**不能挂**）；
       *  - 新增的 `DELETE /links/dead` 与既有参数路由 `DELETE /links/:id` 同前缀，
       *    注册顺序反了就会被参数路由吞掉 —— 而路由表里两条路径看起来都在。
       *
       * 九条变异各自瞄准一个独立的落点（`fail>=minFail` 只能说明「有东西红了」，
       * 所以每条的期望都是「至少一条、且必须包含它指名的那个用例」）：
       *  - R32-01a 判据放宽成 `!isProtected` → 超窗 pending 被删；
       *  - R32-01b 去掉 `persist()` → 重启后失效订单整批复活；
       *  - R32-01c 路由丢掉 requireAdmin → 普通用户可批量删流水；
       *  - R32-01d 前端漏接线 → 按钮点了没有任何请求；
       *  - R32-02a 服务端把 exhausted 当失效 → 可逆状态被不可逆地删掉；
       *  - R32-02b 服务端丢掉作用域 → 普通用户越权删别人的链接；
       *  - R32-02c 路由注册在 /links/:id 之后 → dead 被参数路由吞掉；
       *  - R32-02d 前端 DEAD_STATUS 多收 exhausted → 界面承诺的条数与实际删除数不符；
       *  - R32-02e 前端漏接线 → 按钮点了没有任何请求。
       */
      name: 'R32-01a · 删除失效订单的判据放宽成「所有可裁流水」（超窗 pending 被一并清掉）',
      file: 'server/payment-orders.js',
      anchor: "  const victims = all.filter((o) => o.status === 'failed' && !isProtected(o, now));",
      replacement: '  const victims = all.filter((o) => !isProtected(o, now));',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01b · 删除失效订单后不落盘（只改内存，重启后失效订单整批复活）',
      file: 'server/payment-orders.js',
      anchor: '  persist();\n  return victims.length;',
      replacement: '  return victims.length;',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01c · 批量删除订单的路由漏挂 requireAdmin（普通用户可清空订单流水）',
      file: 'server/routes/payment.js',
      anchor: "router.delete('/payment/orders/failed', requireAdmin, (req, res) => {",
      replacement: "router.delete('/payment/orders/failed', (req, res) => {",
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01d · 前端「删除失效订单」按钮没接上线（点了不发任何请求）',
      file: 'public/js/ordermgr.js',
      anchor: "  const clean = document.getElementById('btn-orders-clean');\n  if (clean) clean.onclick = () => removeFailedOrders();",
      replacement: '  // （按钮未接线）',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02a · 服务端把「已关闭」也当成失效链接删掉（可逆状态被不可逆地清除）',
      file: 'server/share-store.js',
      anchor: "    if (st !== 'deleted' && st !== 'expired') continue;",
      replacement: "    if (st !== 'deleted' && st !== 'expired' && st !== 'exhausted') continue;",
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02b · 删除失效链接丢掉作用域判定（普通用户可删别人创建的链接）',
      file: 'server/share-store.js',
      anchor: "    if (!canManage(l, role, username)) continue;\n    links.splice(i, 1);",
      replacement: '    links.splice(i, 1);',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 顺序类缺陷的**唯一**可观测后果：把注册动作挪到 `DELETE /links/:id` 之后，
       * 路径里的 `dead` 就会被 `:id` 当成链接 id 吞掉。此时路由表里两条路径**都还在**、
       * 「无路由丢失」「路由总数」照样全绿 —— 只有真发请求才暴露。
       * 因此这里用两步变异（先摘掉、再追加到文件末尾）真实还原「注册顺序反了」。
       *
       * 锚点里含 `${who}` 与反引号，故**必须**用双引号字符串书写（模板串会把它当插值）。
       */
      name: 'R32-02c · 失效链接路由注册在 /links/:id 之后（dead 被参数路由吞掉，按钮点了只提示「链接不存在」）',
      file: 'server/routes/links.js',
      mutations: [
        {
          anchor: "router.delete('/links/dead', (req, res) => {\n  const role = roleOf(req);\n  const who = (req.authUser && req.authUser.username) || '';\n  const removed = shareStore.removeDead(role, who);\n  if (removed > 0) {\n    statsStore.addLog({\n      action: 'share.delete',\n      level: 'warn',\n      detail: `「${who}」删除失效分享链接 ${removed} 条（文件已删除 / 已过期）`,\n    });\n  }\n  res.json({ ok: true, removed });\n});\n\n",
          replacement: '',
        },
        {
          anchor: '\nmodule.exports = router;',
          replacement: "\nrouter.delete('/links/dead', (req, res) => {\n  const role = roleOf(req);\n  const who = (req.authUser && req.authUser.username) || '';\n  const removed = shareStore.removeDead(role, who);\n  if (removed > 0) {\n    statsStore.addLog({\n      action: 'share.delete',\n      level: 'warn',\n      detail: `「${who}」删除失效分享链接 ${removed} 条（文件已删除 / 已过期）`,\n    });\n  }\n  res.json({ ok: true, removed });\n});\n\nmodule.exports = router;",
        },
      ],
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02d · 前端「失效」集合多收「已关闭」（界面承诺删 3 条、服务端只删 2 条）',
      file: 'public/js/share-status.js',
      anchor: "export const DEAD_STATUS = new Set(['deleted', 'expired']);",
      replacement: "export const DEAD_STATUS = new Set(['deleted', 'expired', 'exhausted']);",
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02e · 前端「删除失效链接」按钮没接上线（点了不发任何请求）',
      file: 'public/js/linkmgr.js',
      anchor: "  const clean = document.getElementById('btn-links-clean');\n  if (clean) clean.onclick = () => removeDeadLinks();",
      replacement: '  // （按钮未接线）',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R33：用户管理「封禁」功能（管理员封禁他人 + 到期时间 + 解封 + 封禁原因 +
       * 被封者登录时可见原因与解封时间）。
       *
       * 这一轮的落点比上一轮散：**存储判据、路由守卫、登录顺序、前端接线**四处，
       * 每一处都能单独做错，且做错之后的症状都极具误导性：
       *  - 判据里漏掉到期时间 → 封禁永不到期，管理员设的「到期时间」形同虚设；
       *  - 写入后不落盘 → 跑得好好的，重启之后封禁整体消失；
       *  - 漏掉 requireAdmin → 任何登录用户都能封掉管理员；
       *  - 漏掉自封禁保护 → 系统里最后一个管理员能把自己锁在门外，且没人能解开；
       *  - 封禁后不吊销会话 → 被封者拿着旧会话继续读写对象存储最长 30 天；
       *  - **登录判定的顺序反了**（先按用户名判封禁、再验密码）→ 响应差异重新变成
       *    用户名枚举通道，把 R21-05 / R22-01 刚收敛掉的东西又漏开一条；
       *  - 第二步（Windows Hello）回带 banned 的 403 → 同上，还额外多一处；
       *  - 前端把 datetime-local 的裸字符串直接提交 → 跨时区部署时封禁错位若干小时。
       *
       * 十七条各自瞄准一个独立的落点（`fail>=minFail` 只说明「有东西红了」，
       * 所以每条的期望都是「至少一条、且必须包含它指名的那个用例」）。
       */
      name: 'R33-01a · 封禁判据忽略到期时间（管理员设的「到期时间」永不生效）',
      file: 'server/config-store.js',
      anchor: '  const active = Boolean(b.active) && (permanent || t > at);',
      replacement: '  const active = Boolean(b.active);',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01b · 封禁写入后不落盘（重启之后封禁整体消失）',
      file: 'server/config-store.js',
      anchor: "  user.ban = { active: true, reason: text, until: iso };\n  user.updatedAt = new Date().toISOString();\n  persist(cfg);",
      replacement: "  user.ban = { active: true, reason: text, until: iso };\n  user.updatedAt = new Date().toISOString();",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01c · 去掉「到期时间必须晚于当前时间」的校验（写下一条出生即失效的封禁却回 ok）',
      file: 'server/config-store.js',
      anchor: "  if (iso && Date.parse(iso) <= Date.now()) {\n    throw Object.assign(new Error('封禁到期时间必须晚于当前时间'), { status: 400 });\n  }",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01d · 去掉「封禁原因必填」的校验（登录页只剩一句没有信息量的"你被封了"）',
      file: 'server/config-store.js',
      anchor: "  if (!text) throw Object.assign(new Error('请填写封禁原因'), { status: 400 });",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01e · userView 不再暴露封禁状态（列表与登录页都拿不到状态与原因）',
      file: 'server/config-store.js',
      anchor: '    ban: banInfo(u),\n',
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02a · 封禁路由漏挂 requireAdmin（任何登录用户都能封掉管理员）',
      file: 'server/routes/users.js',
      anchor: "router.post('/users/:id/ban', requireAdmin, (req, res) => {",
      replacement: "router.post('/users/:id/ban', (req, res) => {",
      // 判据走 audit33（真发 HTTP 断言 403），而不是 routes-surface 的静态清单：
      // 后者守的「mustBeAdmin」机制已由 R32-01c 反向对照过，这里要证的是**行为**。
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02b · 去掉自封禁保护（最后一个管理员能把自己锁在门外，且没人能解开）',
      file: 'server/routes/users.js',
      anchor: "    if (target.id === req.authUser.id) {\n      return res.status(400).json({ error: '不能封禁当前登录的账户' });\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02c · 封禁后不吊销该用户的会话（被封者拿旧会话继续用最长 30 天）',
      file: 'server/routes/users.js',
      anchor: "    const n = authSession.destroyUserSessions(target.id);\n    statsStore.addLog({\n      action: 'users.ban', level: 'warn',",
      replacement: "    const n = 0;\n    statsStore.addLog({\n      action: 'users.ban', level: 'warn',",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02d · 去掉解封的「当前未被封禁」判据（一个永远成功的解封按钮）',
      file: 'server/routes/users.js',
      anchor: "    if (configStore.banInfo(target).state === 'none') {\n      return res.status(400).json({ error: '该用户当前未被封禁' });\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-03a · 登录路径不判封禁（被封者凭密码照常进入系统）',
      file: 'server/routes/auth.js',
      anchor: '    const ban = configStore.banInfo(raw);\n    if (ban.active) {',
      replacement: '    const ban = configStore.banInfo(raw);\n    if (ban.active && false) {',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 顺序类缺陷的可观测后果：封禁判定一旦挪到**密码校验之前**，把密码打错的人
       * 也会先收到「该账户已被封禁 + 原因 + 解封时间」的 403 —— 登录接口于是免费
       * 提供了一条「该用户名存在且已被封禁」的枚举通道。
       *
       * 用两步变异真实还原「把判定挪到前面去」：先摘掉原位置的那段，再插到
       * `authenticateUser` 之前（并按用户名查记录）。锚点含 `${user.username}` 与反引号，
       * 故**必须**用双引号字符串书写（模板串会把 `${}` 当插值）。
       */
      name: 'R33-03b · 封禁判定挪到密码校验之前（密码错也能问出"这个号被封了"→ 用户名枚举）',
      file: 'server/routes/auth.js',
      mutations: [
        {
          anchor: "    const ban = configStore.banInfo(raw);\n    if (ban.active) {\n      statsStore.addLog({\n        action: 'auth.fail', level: 'warn',\n        detail: `被封禁的账户尝试登录（用户名：${user.username}；解封时间：${ban.until || '永久'}）`,\n      });\n      return res.status(403).json({\n        error: '该账户已被封禁',\n        banned: true,\n        reason: ban.reason,\n        until: ban.until,\n      });\n    }\n\n",
          replacement: '',
        },
        {
          anchor: '    const user = await configStore.authenticateUser(username, password);',
          replacement: "    const _earlyBan = configStore.banInfo(configStore.findUserRaw(username));\n    if (_earlyBan.active) {\n      return res.status(403).json({ error: '该账户已被封禁', banned: true, reason: _earlyBan.reason, until: _earlyBan.until });\n    }\n    const user = await configStore.authenticateUser(username, password);",
        },
      ],
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-03c · 登录第二步回带 banned 的 403（匿名端点重新变成"该号存在且被封"的 oracle）',
      file: 'server/routes/auth.js',
      anchor: "    if (configStore.banInfo(raw).active) return authFail('该账户已被封禁');",
      replacement: "    if (configStore.banInfo(raw).active) return res.status(403).json({ error: '该账户已被封禁', banned: true });",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04a · 前端「封禁」按钮没接上线（点了不弹窗、不发请求）',
      file: 'public/js/syssettings.js',
      anchor: "    } else if (act === 'ban') {\n      btn.onclick = () => showBanForm(user);\n    }",
      replacement: '    }',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04b · 前端「解封」按钮没接上线（点了不发任何请求）',
      file: 'public/js/syssettings.js',
      anchor: "    } else if (act === 'unban') {\n      btn.onclick = () => unbanUser(user);\n    }",
      replacement: '    }',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04c · datetime-local 的裸字符串直接提交（跨时区部署时封禁错位若干小时）',
      file: 'public/js/syssettings.js',
      anchor: '    until = ms;',
      replacement: '    until = raw;',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04d · 登录失败不按 e.banned 分岔（被封者只看到"用户名或密码错误"，反复重试密码）',
      file: 'public/js/main.js',
      anchor: "    showAuthError(e && e.banned ? banNotice(e) : (e.message || '登录失败'));",
      replacement: "    showAuthError(e.message || '登录失败');",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04e · api.js 不把 banned/reason/until 挂回错误对象（登录页拿不到原因与解封时间）',
      file: 'public/js/api.js',
      anchor: "    if (data && data.banned) {\n      err.banned = true;\n      err.reason = data.reason || '';\n      err.until = data.until || '';\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R34：WebDAV 根路径挂载失败 —— `OPTIONS /` 答 200 + `DAV: 1`，`PROPFIND /` 却回
       * **HTML 404**，Windows WebClient 于是报「输入的文件夹似乎无效，请选择另一个」。
       *
       * 根因：「路径是否在挂载点内」这一判据**手写在 9 处**，而 `/` 只在部分地方被放行。
       * 八条各自瞄准一个独立落点，做错之后的症状都极具误导性：
       *  - 退回手写前缀 → 根路径重新落进 Express 兜底（报文与真实原因毫无关系）；
       *  - 去掉 `OPTIONS *` 豁免 → 服务级能力探测被边界答成 404，`DAV` 头缺席；
       *  - 把 `inMount` 放宽到整个根命名空间 → 顺手撤销 FUN-06 的边界；
       *  - 前缀剥离退回字符级 → `/davx` 造出「界面看不到、WebDAV 却能读」的幽灵 key `x`；
       *  - 405 兜底退回手写前缀 → `LOCK /` 由 405 退化成 404（客户端以为资源不存在而放弃）；
       *  - 摘掉 `/` 的写保护 → PUT / MKCOL / DELETE 在根路径上**真的动手**。
       */
      name: 'R34-01a · PROPFIND 包装退回手写前缀判据（根路径重新落到 Express 兜底 HTML 404）',
      file: 'server/webdav/app.js',
      anchor: "  app['propfind']('*', (req, res, next) => {\n    if (!inMount(req.path)) return next();",
      replacement: "  app['propfind']('*', (req, res, next) => {\n    if (!req.path.startsWith(MOUNT)) return next();",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01b · 去掉 `OPTIONS *` 的服务级豁免（能力探测被边界答成 404，且没有 DAV 头）',
      file: 'server/webdav/app.js',
      anchor: "    if (req.method === 'OPTIONS' && req.path === '*') return next();\n",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01c · inMount 放宽到整个根命名空间（把 FUN-06 的边界一并撤销）',
      file: 'server/webdav/util.js',
      anchor: "  return reqPath === '/' || reqPath === MOUNT || reqPath.indexOf(MOUNT + '/') === 0;",
      replacement: "  return reqPath.charAt(0) === '/';",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01d · 前缀剥离退回字符级 startsWith（`/davx` 产生界面看不到的幽灵 key `x`）',
      file: 'server/webdav/util.js',
      anchor: '  if (pth === MOUNT || pth.indexOf(MOUNT + \'/\') === 0) pth = pth.slice(MOUNT.length);',
      replacement: '  if (pth.indexOf(MOUNT) === 0) pth = pth.slice(MOUNT.length);',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01e · 405 兜底退回手写前缀判据（`LOCK /` 由 405 退化成 Express 默认 404）',
      file: 'server/webdav/app.js',
      anchor: "  app.use((req, res, next) => {\n    if (!inMount(req.path)) return next();\n    const m = String(req.method || '').toUpperCase();\n    if (WEBDAV_METHODS.has(m)) return next();",
      replacement: "  app.use((req, res, next) => {\n    if (!req.path.startsWith(MOUNT)) return next();\n    const m = String(req.method || '').toUpperCase();\n    if (WEBDAV_METHODS.has(m)) return next();",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01f · 摘掉 MKCOL 的根路径写保护（`MKCOL /` 从 409 变成真的建集合）',
      file: 'server/webdav/app.js',
      anchor: '      const key = reqPathToKey(req.path);\n      if (!key) return res.status(409).end();',
      replacement: '      const key = reqPathToKey(req.path);',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01g · 摘掉 PUT 的根路径写保护（`PUT /` 不再回 409）',
      file: 'server/webdav/app.js',
      anchor: "      if (!key) return res.status(409).type('text/plain').send('409 Conflict：无法上传到根路径');",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01h · 摘掉 DELETE 的根路径写保护（`DELETE /` 不再回 403）',
      file: 'server/webdav/app.js',
      anchor: "      if (!key) return res.status(403).type('text/plain').send('403：禁止删除存储桶根');",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R34（其二）：「关于」卡片「检查更新」。
       *
       * 这一轮的落点分散在**纯函数 / 路由 / 文案 / DOM 接线**四处，每处都能单独做错，
       * 且症状都很误导：
       *  - 版本比较按**字符串**比 → `1.10.0` 被判成小于 `1.9.9`，升级提示永远发不出来；
       *  - 无法解析时返回 0（相等）而不是 null → 一个不合规的 tag 被当成「已是最新」，
       *    功能看着正常，用户永远收不到提示；
       *  - `/update/check` 误挂 requireAdmin → 「关于」是唯一对普通用户可见的卡片，
       *    普通用户一点就 403；
       *  - 按钮没接线 → 点了毫无反应；
       *  - 去掉缓存 → 未认证的 GitHub API 只有 60 次/小时，连点几下就打光额度，
       *    之后所有人都只能看到「检查更新失败」。
       */
      name: 'R34-02a · updateNotice 分支写反（有新版本却提示"当前已是最新版本"）',
      file: 'public/js/util.js',
      anchor: '  if (r.hasUpdate) {',
      replacement: '  if (!r.hasUpdate) {',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02b · 版本号无法解析时返回 0（不合规的 tag 被当成"已是最新"，静默失效）',
      file: 'server/update-check.js',
      anchor: '  if (!x || !y) return null;',
      replacement: '  if (!x || !y) return 0;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02c · /update/check 误挂 requireAdmin（普通用户的按钮一点就 403）',
      file: 'server/routes/stats.js',
      anchor: "router.get('/update/check', asyncHandler(async (req, res) => {",
      replacement: "router.get('/update/check', requireAdmin, asyncHandler(async (req, res) => {",
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02d · 前端「检查更新」按钮没接上线（点了没有任何反应）',
      file: 'public/js/syssettings.js',
      anchor: '  if (btnUpdate) btnUpdate.onclick = checkUpdate;',
      replacement: '  if (btnUpdate) btnUpdate.onclick = null;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02e · 去掉 10 分钟结果缓存（连点按钮打光 GitHub 未认证额度）',
      file: 'server/update-check.js',
      anchor: '  if (!force && cache.value && (Date.now() - cache.at) < CACHE_MS) {',
      replacement: '  if (false) {',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02f · 来源回退失效：某一级失败就整次报错（Release 不存在时功能直接不可用）',
      file: 'server/update-check.js',
      anchor: '      failures.push(`${src.key}：${(e && e.message) || e}`);\n      continue;',
      replacement: '      failures.push(`${src.key}：${(e && e.message) || e}`);\n      break;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02g · 号不可解析时直接当"已是最新"返回（换来源的兜底被摘掉）',
      file: 'server/update-check.js',
      anchor: '      continue; // 换下一个来源 —— 一个不合规的 tag 不该让整次检查失败',
      replacement: '      return Object.assign({}, { latest: raw, hasUpdate: false, url: RELEASES_PAGE, source: src.key }, { current: cur });',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02h · 前端沙箱的 util 桩缺一个导出（ESM 链接期报错 → 9 条无关用例整片变红）',
      file: 'tests/audit31-regressions.test.js',
      anchor: "export const updateNotice = (r) => (r && r.hasUpdate ? '有新版本' : '当前已是最新版本。');",
      replacement: '',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },

    /* ---------------- R35 · 用户管理：10 条预览 + 「显示全部」对话框 ---------------- */
    {
      name: 'R35-01a · 卡片不再截断（11 位用户全渲染 → 「最多展示 10 个」名存实亡）',
      file: 'public/js/syssettings.js',
      anchor: '  const shown = users.slice(0, USER_PREVIEW_LIMIT);',
      replacement: '  const shown = users;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：判据下沉到 `util.previewMoreState()`（四张卡片共用），锚点随之迁到
      // 那个**唯一实现点**上 —— 变异仍只改「严格大于 vs 大于等于」这一件事。
      name: 'R35-01b · 「显示全部」判据写成 >=（正好 10 位也摆出按钮，点开是与卡片一字不差的副本）',
      file: 'public/js/util.js',
      anchor: '  const over = total > limit;',
      replacement: '  const over = total >= limit;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01c · 「显示全部」永久隐藏（超过 10 位也出不来按钮 → 后 40 个用户无从管理）',
      file: 'public/js/syssettings.js',
      anchor: '  if (more) more.hidden = !over;',
      replacement: '  if (more) more.hidden = true;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：对话框改为「只提供数据 + 行渲染回调」，截断动作改在行渲染里复现
      // （`rowHtml` 收到的是**已过滤的完整列表**，切片到 10 就等价于旧 bug）。
      name: 'R35-01d · 对话框也按 10 条截断（「显示全部」里仍然看不全）',
      file: 'public/js/syssettings.js',
      anchor: '    rowHtml: (shown) => userTableHtml(shown, currentId),',
      replacement: '    rowHtml: (shown) => userTableHtml(shown.slice(0, USER_PREVIEW_LIMIT), currentId),',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：搜索框接线移入 `listdialog.js`（四张卡片共用）—— 锚点随之下沉，
      // 变异仍是「干脆不接线」。
      name: 'R35-01e · 搜索框不接线（弹窗里那个输入框输什么都没反应）',
      file: 'public/js/listdialog.js',
      anchor: '  search.oninput = () => { state.query = search.value; repaint(); };',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01f · 搜索改成大小写敏感（`ali` 查不到 `Alice`）',
      file: 'public/js/util.js',
      anchor: "  const q = String(query == null ? '' : query).trim().toLowerCase();",
      replacement: "  const q = String(query == null ? '' : query).trim();",
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      // R36：`filterUsersByName()` 的空串短路下沉到 `matchesQuery()`（四张卡片共用
      // 同一条关键词规则）—— 锚点随之迁到那里；变异仍是「空关键词谁都匹配不上」，
      // 表现为搜索框一清空整个列表白屏。
      name: 'R35-01g · 空关键词返回空数组（搜索框一清空、整个列表就白屏）',
      file: 'public/js/util.js',
      anchor: '  if (!q) return true;',
      replacement: '  if (!q) return false;',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      // R36：行按钮绑定改由 `listdialog.js` 统一调用卡片传入的 `bindRows()` ——
      // 锚点下沉，变异仍是「渲染了行、却不绑按钮」（看得见、点不动）。
      name: 'R35-01h · 对话框里的行不绑按钮（看得见、点不动）',
      file: 'public/js/listdialog.js',
      anchor: '    if (o.bindRows) o.bindRows(list, shown);',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01i · 卡片刷新后不重绘对话框（在对话框里删掉的人继续留在对话框里）',
      file: 'public/js/syssettings.js',
      anchor: '  updateUserMore(users.length);\n  repaintAllUsers(); // 对话框开着时同步刷新：删/封/改名之后两边必须一致',
      replacement: '  updateUserMore(users.length);',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：`clearUserDom()` 改调 `usersDialog.close()` 关窗，但**显式清空容器**这一步
      // 仍然必须保留（关闭只是把弹窗从 #modal-root 移除，容器节点里的用户名 / 角色 /
      // 封禁原因不会自己消失）。锚点即这两行，变异把它们去掉。
      name: 'R35-01j · 登出不清理对话框（换账号后上一个账号的用户列表仍留在 DOM 里）',
      file: 'public/js/syssettings.js',
      anchor: "  const allList = document.getElementById('user-all-body');\n  if (allList) allList.innerHTML = '';",
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01k · 关闭弹窗时不复位状态（第二次点「显示全部」再也打不开）',
      file: 'public/js/syssettings.js',
      anchor: '    onClose: () => { usersDialog = null; },',
      replacement: '    onClose: () => {},',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01l · 去掉 `.list-more[hidden]` 规则（容器是 display:flex，hidden 属性彻底失效 → 按钮一直露着）',
      file: 'public/css/style.css',
      anchor: '.list-more[hidden] { display: none; }\n',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01m · 滚动容器去掉高度上限与 overflow（对话框再也滚不动，长列表把弹窗撑爆）',
      file: 'public/css/style.css',
      anchor: '  max-height: min(54vh, 460px); overflow: auto; border: 1px solid var(--border);',
      replacement: '  border: 1px solid var(--border);',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：对话框不再自己渲染表格（改调卡片传入的 `rowHtml`），故把「另抄一份表头」
      // 复现为在 `rowHtml` 里额外拼一段表头 —— 静态断言数 `syssettings.js` 里
      // `<th>用户名</th>` 的出现次数，凭空多一份即变红（两处迟早分叉）。
      name: 'R35-01n · 对话框里另抄一份表格表头（用户表格出现两份 → 两处迟早分叉）',
      file: 'public/js/syssettings.js',
      anchor: '    rowHtml: (shown) => userTableHtml(shown, currentId),',
      replacement: "    rowHtml: (shown) => '<table class=\"lk-table user-tbl\"><thead><tr><th>用户名</th></tr></thead><tbody></tbody></table>'"
        + ' + userTableHtml(shown, currentId),',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01o · 去掉「仅管理员」守卫（普通用户也能打开全部用户对话框）',
      file: 'public/js/syssettings.js',
      anchor: 'function showAllUsers() {\n  if (!canManageUsers()) return;',
      replacement: 'function showAllUsers() {',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：`filterUsersByName()` 改为委托 `matchesQuery()` 之后，「空关键词返回入参本体」
      // **不再是单步变异能复现的** —— `.filter()` 本身就会新建数组，光去掉防御性 `.slice()`
      // 已经测不出来（本轮实测 fail=0）。改为两步，合起来才等于旧实现：
      //   ① 去掉 `.slice()`（`all` 就是调用方的数组本体）；
      //   ② 空关键词短路 `return all`（旧写法正是 `if (!q) return all;`）。
      name: 'R35-01p · 空关键词返回入参本体（把模块级 usersState 交出去，调用方一 sort 就改到全局状态）',
      file: 'public/js/util.js',
      mutations: [
        {
          anchor: '  const all = Array.isArray(list) ? list.slice() : [];',
          replacement: '  const all = Array.isArray(list) ? list : [];',
        },
        {
          anchor: '  return all.filter((u) => matchesQuery(query, (u && u.username) || \'\')',
          replacement: '  if (!String(query == null ? \'\' : query).trim()) return all;\n'
            + '  return all.filter((u) => matchesQuery(query, (u && u.username) || \'\')',
        },
      ],
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：过滤动作改由「卡片传入的 `filter()` 回调」承担（骨架在 listdialog.js），
      // 锚点随之迁到 `showAllUsers` 里那份回调上；变异仍是「无视搜索关键词」。
      name: 'R35-01q · 对话框忽略搜索关键词（过滤与「刷新后保持过滤」两条用例同时变红）',
      file: 'public/js/syssettings.js',
      anchor: '    filter: (list, st) => filterUsersByName(list, st.query, st.filters.role),',
      replacement: "    filter: (list, st) => filterUsersByName(list, '', st.filters.role),",
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01r · 反向对照脚本不再拒绝位置参数（`R35-01` 被静默忽略 → 跑满全量数小时）',
      file: 'scripts/reverse-check.js',
      // ⚠️ 本条的**目标文件就是台账自身**，因此 anchor 必须**跨行**（字面量里写 `\n` 转义，
      //    而不是真换行）。单行 anchor 会在本文件里命中两次：CASES 里那处字面量
      //    （行号更靠前！）与真正的代码，而 `String.replace` 只替**首处** —— 变异会打在
      //    台账的字符串上、被测代码毫发无伤，实跑得到 fail=0「护栏没抓到」的假象（已踩一次）。
      anchor: '  if (stray.length) {\n    return {\n      error: \'无法识别的参数：\' + stray.join(\' \')',
      replacement: '  if (false) {\n    return {\n      error: \'无法识别的参数：\' + stray.join(\' \')',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },

    /* ---------------- R36 · 四张列表卡片「显示全部」+ 属性面板「创建者 / 上传者」+ 上传者元数据 ----------------
     * 本轮是**功能需求**（不是缺陷），反向对照的落点因此分三类：
     *  ① 共享判据层（util.matchesQuery / util.previewMoreState / listdialog.openListDialog）——
     *     四张卡片都靠它们，改坏一处四张一起坏（其中「严格大于」那条由 R35-01b 继续守着）；
     *  ② 各卡片自己的接线（截断上限、下拉筛选、搜索字段、全量 vs 子集判定）；
     *  ③ 服务端「上传者」元数据的唯一实现点与各写入出口。
     */
    {
      // 需求 2②③④ / 3：一张卡片要同时搜多个字段（密钥：备注+ID；桶：桶名+备注；
      // 链接：文件名+分享者），全靠 matchesQuery 的 `.some`。退化成只比第一个字段，
      // 表现为「搜第二个字段永远搜不到」。
      name: 'R36-01a · matchesQuery 只比较第一个字段（多字段搜索退化成单字段）',
      file: 'public/js/util.js',
      anchor: '  const list = Array.isArray(texts) ? texts : [texts];',
      replacement: '  const list = Array.isArray(texts) ? texts.slice(0, 1) : [texts];',
      testFile: 'audit36-regressions.test.js',
      minFail: 2,
    },
    {
      // 打开时快照一份数据集：后台刷新（删除 / 新增）之后对话框里还是旧的那一份，
      // 表现为「在对话框里删掉一条，它却还在」。
      name: 'R36-01b · openListDialog 打开时快照 items（后台刷新后对话框不更新）',
      file: 'public/js/listdialog.js',
      anchor: '  function currentAll() {\n    return (o.items && o.items()) || [];\n  }',
      replacement: '  const __snap = (o.items && o.items()) || [];\n  function currentAll() {\n    return __snap;\n  }',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 「筛不到」与「一条都没有」必须两句话 —— 合并之后用户分不清是数据没了还是筛错了。
      name: 'R36-01c · openListDialog 把「无匹配」与「一条都没有」合并成同一句文案',
      file: 'public/js/listdialog.js',
      anchor: "      list.innerHTML = `<div class=\"lk-empty\">${all.length ? (o.emptyMatch || '没有匹配的项') : (o.emptyAll || '暂无数据')}</div>`;",
      replacement: "      list.innerHTML = `<div class=\"lk-empty\">${o.emptyMatch || '没有匹配的项'}</div>`;",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 筛选生效时计数必须同时给出「匹配 x / 共 N」；只写「共 N」时用户无法确认到底筛没筛到。
      name: 'R36-01d · openListDialog 计数不再给出「匹配 x / 共 N」',
      file: 'public/js/listdialog.js',
      anchor: '        ? `匹配 ${shown.length} / 共 ${all.length} ${unitShort}`',
      replacement: '        ? `共 ${all.length} ${unitShort}`',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 服务商下拉不去重：同一家出现多次（数据集里同厂商的密钥 / 桶通常占多数）。
      name: 'R36-01e · providerSelectOptions 不去重（下拉里同一服务商出现多次）',
      file: 'public/js/listdialog.js',
      anchor: '    if (!seen.includes(pid)) seen.push(pid);',
      replacement: '    seen.push(pid);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // bucket 为空的**历史链接**若占一个选项，就是一个「选了必然为空」的空选项 ——
      // 它们在「全部存储桶」下本来仍然可见（见 R36-05 的「历史链接不得被筛掉」）。
      name: 'R36-01f · bucketSelectOptions 把空 bucket 也列成一个选项',
      file: 'public/js/listdialog.js',
      anchor: '    if (b && !seen.includes(b)) seen.push(b);',
      replacement: '    if (!seen.includes(b)) seen.push(b);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 1 的核心判据：「标签随对象类型变」只在 util.propertyBodyHtml 里写一次。
      // 写反即变红（文件夹属性里出现「上传者」、文件属性里出现「创建者」）。
      name: 'R36-02a · propertyBodyHtml 把标签写反（文件夹显示「上传者」、文件显示「创建者」）',
      file: 'public/js/util.js',
      anchor: "  const ownerRow = row(st.isFolder ? '创建者' : '上传者', ownerText(st.uploader));",
      replacement: "  const ownerRow = row(st.isFolder ? '上传者' : '创建者', ownerText(st.uploader));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 历史对象没有元数据。**不能**拿「当前登录用户」或「最后操作者」顶替 ——
      // 那是在编造一个看起来合理的事实，属性面板的价值恰恰在于它说的是真的。
      name: 'R36-02b · ownerText 对空值顶替一个「合理」的名字（而不是如实显示「—」）',
      file: 'public/js/util.js',
      anchor: "  const name = String(u == null ? '' : u).trim();\n  if (name) return escapeHtml(name);",
      replacement: "  const name = String(u == null ? '' : u).trim() || '未知用户';\n  if (name) return escapeHtml(name);",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-03a · 密钥卡片不再截断（11 个密钥全渲染 → 需求 2① 名存实亡）',
      file: 'public/js/credmgr.js',
      anchor: '  const shown = creds.slice(0, CRED_PREVIEW_LIMIT);',
      replacement: '  const shown = creds;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-03b · 密钥卡片对话框忽略服务商筛选（下拉成了摆设）',
      file: 'public/js/credmgr.js',
      anchor: '    filter: (list, st) => filterCreds(list, st.query, st.filters.provider),',
      replacement: "    filter: (list, st) => filterCreds(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 2② 明说「搜索备注」——但密钥卡片同时要能按「访问密钥 ID」搜（占位符里写了）。
      name: 'R36-03c · 密钥卡片搜索不再匹配「访问密钥 ID」（只搜备注）',
      file: 'public/js/credmgr.js',
      anchor: "    && matchesQuery(query, [(c && c.remark) || '', (c && c.secretIdMasked) || '']));",
      replacement: "    && matchesQuery(query, [(c && c.remark) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-04a · 存储桶卡片不再截断（11 个存储桶全渲染 → 需求 2① 名存实亡）',
      file: 'public/js/bucketmgr.js',
      anchor: '  const shown = cache.slice(0, BUCKET_PREVIEW_LIMIT);',
      replacement: '  const shown = cache;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // ⚠️ 本轮最容易犯的语义错误：把**筛过的子集**当成全域去数启用桶，
      // 于是「按厂商筛选后只剩 1 个启用桶」的假象把本该可停用的按钮锁死。
      name: 'R36-04b · 存储桶的「只剩一个启用桶不得停用」按筛过的子集判定',
      file: 'public/js/bucketmgr.js',
      anchor: '    rowHtml: (shown) => bucketTableHtml(shown, cache),',
      replacement: '    rowHtml: (shown) => bucketTableHtml(shown, shown),',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-04c · 存储桶对话框忽略服务商筛选（下拉成了摆设）',
      file: 'public/js/bucketmgr.js',
      anchor: '    filter: (list, st) => filterBuckets(list, st.query, st.filters.provider),',
      replacement: "    filter: (list, st) => filterBuckets(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 2④：**一个**搜索框同时搜「存储桶名称」与「备注」。只搜桶名即退化为半个功能。
      name: 'R36-04d · 存储桶搜索只搜桶名、不搜备注（需求 2④「一个框搜两者」名存实亡）',
      file: 'public/js/bucketmgr.js',
      anchor: "    && matchesQuery(query, [(r && r.bucket) || '', (r && r.remark) || '']));",
      replacement: "    && matchesQuery(query, [(r && r.bucket) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 3：分享链接卡片的预览上限是 **100**（与另两张卡片的 10 不同）。
      name: 'R36-05a · 分享链接卡片的预览上限从 100 改成 10（与需求 3 不符）',
      file: 'public/js/linkmgr.js',
      anchor: 'const LINK_PREVIEW_LIMIT = 100;',
      replacement: 'const LINK_PREVIEW_LIMIT = 10;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-05b · 分享链接筛选忽略存储桶（下拉成了摆设）',
      file: 'public/js/linkmgr.js',
      anchor: "  return (Array.isArray(list) ? list : []).filter((l) => (!want || String((l && l.bucket) || '') === want)",
      replacement: '  return (Array.isArray(list) ? list : []).filter((l) => (!want || true)',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 3：搜索要同时覆盖「文件名」与「分享者」。
      name: 'R36-05c · 分享链接搜索忽略分享者（只搜文件名）',
      file: 'public/js/linkmgr.js',
      anchor: "    && matchesQuery(query, [(l && (l.fileName || l.key)) || '', (l && l.createdBy) || '']));",
      replacement: "    && matchesQuery(query, [(l && (l.fileName || l.key)) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 0：用户对话框新增角色下拉。
      name: 'R36-06a · 全部用户对话框忽略角色筛选（新增的下拉成了摆设）',
      file: 'public/js/syssettings.js',
      anchor: '    filter: (list, st) => filterUsersByName(list, st.query, st.filters.role),',
      replacement: "    filter: (list, st) => filterUsersByName(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 角色条件写死成恒真：选了「管理员」也照样把普通用户列出来。
      name: 'R36-06b · filterUsersByName 的角色条件失效（选了角色仍列出全部用户）',
      file: 'public/js/util.js',
      anchor: "    && (!wantRole || String((u && u.role) || '') === wantRole));",
      replacement: '    && (!wantRole || true));',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 静态结构护栏：四张卡片必须共用 util.previewMoreState，不得就地重写判据 ——
      // 「严格大于」写两份，必然有一天其中一份被改成 >=（R35-01b 守的就是这里）。
      name: 'R36-07a · 密钥卡片不再共用 previewMoreState（就地重写了一份判据）',
      file: 'public/js/credmgr.js',
      anchor: "  const { over, hint: hintText } = previewMoreState(total, CRED_PREVIEW_LIMIT, '个密钥');",
      replacement: "  const over = total > CRED_PREVIEW_LIMIT;\n  const hintText = over ? '卡片仅显示前 10 个密钥，共 ' + total + ' 个密钥' : '';",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 静态结构护栏：对话框骨架只允许一份（listdialog.openListDialog）。
      // 这里用一个**最小可判定的代理变异** —— 把共用函数换成模块自有的名字，
      // 静态断言 `openListDialog(` 随即失配（即「各写一份」的形态）。
      name: 'R36-07b · 分享链接卡片不再共用 openListDialog（对话框各写一套）',
      file: 'public/js/linkmgr.js',
      anchor: '  linksDialog = openListDialog({',
      replacement: '  linksDialog = openListDialogInline({',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 截断上限必须引用常量：就地写死数字 10 之后，改上限时卡片与提示文案会分家。
      name: 'R36-07c · 存储桶卡片把截断上限写死成数字（与提示文案分家）',
      file: 'public/js/bucketmgr.js',
      anchor: '  const shown = cache.slice(0, BUCKET_PREVIEW_LIMIT);',
      replacement: '  const shown = cache.slice(0, 10);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 元数据键名只能在 s3.js 出现一次（协议护栏：期望值按约定写死在测试里）。
      // R49 备注：这个键名是**上层统一命名**，云端真正存下来的是去掉前缀的 `uploader`
      // —— 因此从 x-cos-meta-* 改名成 x-s3-meta-* 不影响历史对象。
      name: 'R36-08a · 上传者元数据键名被改短（上层统一前缀 x-s3-meta-* 丢失）',
      file: 'server/s3.js',
      anchor: "const UPLOADER_META = 'x-s3-meta-uploader';",
      replacement: "const UPLOADER_META = 'x-meta-uploader';",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // gateway.writeObject 的第 7 个参数 `uploader` 若半路丢掉，网页上传能记上传者、
      // WebDAV 上传却永远显示「—」—— 同一条链路两个出口两套行为。
      name: 'R36-08b · gateway.writeObject 丢掉 uploader（第 7 个参数半路流失）',
      file: 'server/fs-gateway.js',
      anchor: '      uploaderMeta(uploader),',
      replacement: '      {},',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 适配器必须把上层的 `x-s3-meta-*` 翻译成各自厂商的头（S3 → x-amz-meta-*）。
      name: 'R36-08c · s3-client 不再翻译 x-s3-meta-*（元数据到了云端变成自定义残留头）',
      file: 'server/s3-client.js',
      anchor: "      if (k.toLowerCase().startsWith('x-s3-meta-')) {",
      replacement: '      if (false) {',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 新建文件夹的目录标记对象也要带上传者，否则文件夹属性永远只能显示「—」。
      name: 'R36-08d · mkdir 写入点不带上传者（文件夹属性永远显示「—」）',
      file: 'server/routes/fs.js',
      anchor: "      Headers: uploaderMeta(req.authUser && req.authUser.username),\n    });\n    res.json({ ok: true, key });",
      replacement: '      Headers: {},\n    });\n    res.json({ ok: true, key });',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 移动文件夹时重建空目录标记，必须**沿用**原标记的上传者 —— 否则一次移动就把
      // 文件夹的「创建者」抹成「—」（文件的上传者反而因为复制保留元数据而幸存）。
      name: 'R36-08e · movePrefix 重建空目录标记时不沿用原上传者（移动一次创建者就丢）',
      file: 'server/fs-gateway.js',
      anchor: '      markerMeta = uploaderMeta(readUploader(h.headers));',
      replacement: '      markerMeta = {};',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },

    /* ---------------- R37 · 下载限速（五层取最小）+ IP 地址管理页 ----------------
     * 本轮是**功能需求**，且它的失效方式有一个共同特征：**看起来全都配好了、实际一点没限**。
     * 因此对照分四类：
     *  ① 多层取最小 / 层聚合的语义（取成最大、把 0 当有效值、IP 层传错形状）；
     *  ② 节拍器本身（限速失效、写间隔无上界、并发不公平）—— 这一层**只有计时能证伪**；
     *  ③ 两类 IP 规则互斥（屏蔽不产生限速、限速不拦截、禁用/0 速率不生效）；
     *  ④ 接线与迁移（三个下载出口漏一个、接口表字段半路流失、卡片搬回去）。
     */
    {
      // 「各层取最小值」写反成取最大值 = 限速整体失效（用户以为设了 5MB/s，实际按最大的那层走）。
      name: 'R37-01a · pickEffective 改成取**最大值**（多层限速的语义反了）',
      file: 'server/throttle.js',
      anchor: '    if (l.bytesPerSec < best.bytesPerSec) best = l; // 严格小于：同值保持更高优先层',
      replacement: '    if (l.bytesPerSec > best.bytesPerSec) best = l; // 变异：取最大',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 0 = 「这一层没设」，必须先从候选里剔掉；否则取最小值会得到 0，
      // 表现是「一设限速就完全下不动」——而且是在**别的层**设的限速把它压死的。
      name: 'R37-01b · pickEffective 把 0 当作有效限速参与取最小（下载被压成 0）',
      file: 'server/throttle.js',
      anchor: '    .filter((l) => l && normalizeSpeedLimit(l.bytesPerSec) > 0)',
      replacement: '    .filter((l) => Boolean(l))',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 本轮的**头号静默失效**：`speedLimitFor` 只接受原始 IP 字符串，传
      // `{ip, fromForwarded}` 包装对象时 CIDR 匹配读到 `undefined`，恒不命中 ——
      // IP 限速「配好了、保存成功、界面显示生效」，实际全速下载。
      name: 'R37-01c · resolveLimit 给 speedLimitFor 传包装对象（IP 限速静默失效）',
      file: 'server/throttle.js',
      anchor: "  const ipHit = ipGuard.speedLimitFor(ctx.ip, ctx.method || 'GET', ctx.bucketId);",
      replacement: "  const ipHit = ipGuard.speedLimitFor({ ip: ctx.ip, fromForwarded: false }, ctx.method || 'GET', ctx.bucketId);",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 退回朴素的「攒够一整块、等够这一块的时间、再整块放行」实现：平均速率看着是对的，
      // 但**写间隔没有任何上界**（1KB/s + 64KB 分块 = 64 秒静默），
      // `res.setTimeout(10min)` 这个**无活动**超时会把正常下载判死。
      // 这是本轮唯一只有计时类断言能证伪的形态。
      name: 'R37-02a · 节拍器退回「攒够一整块再放行」（写间隔无上界 → 无活动超时误杀）',
      file: 'server/throttle.js',
      anchor: '    if (!timer && !t.destroyed) timer = setTimeout(pump, SLICE_MS);',
      replacement: '    if (!timer && !t.destroyed) timer = setTimeout(pump, Math.max(SLICE_MS, Math.floor((buf ? buf.length : 1) / Math.max(1, b.rate / 1000))));',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 同一实体上的并发下载不按连接数均分每拍额度：总量看着没超，但**分配极不公平**
      // （先到的把每一拍吃满，后到的长期排队）。实测过的原始症状是 2×/1×，即 `active` 未参与。
      name: 'R37-02b · 节拍器不按并发数均分额度（同一实体的两条下载严重不公平）',
      file: 'server/throttle.js',
      anchor: '    const perTick = Math.max(1, Math.floor(b.cap / Math.max(1, b.active || 1)));',
      replacement: '    const perTick = Math.max(1, b.cap);',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 接口层的入参校验若漏掉负数，`-1` 会被存成 0 = **不限速**：
      // 用户以为设了限速、实际全速（与 `quotaBytes` 踩过的坑同型）。
      name: 'R37-03a · parseSpeedLimitInput 接受负数（静默变成「不限速」）',
      file: 'server/limits.js',
      anchor: "  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '限速值不能为负数（0 表示不限速）' };",
      replacement: '  if (!Number.isFinite(n)) return { ok: false, error: "请输入数字" };',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 屏蔽判定若不跳过 `kind === 'speed'` 的规则，一条「限速」规则会把请求直接 403 ——
      // 需求写明限速**只慢不拦**，这种错法用户完全无法理解（"我明明设的是限速"）。
      name: 'R37-04a · matchRules 不再跳过限速规则（限速规则把请求 403 掉）',
      file: 'server/ip-guard.js',
      anchor: "    if (r.kind === 'speed') continue;",
      replacement: '    if (false) continue;',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 「禁用」按钮对限速规则必须同样有效：漏掉 enabled 判定之后，界面上写着「已禁用」、
      // 实际仍在限速，用户唯一的自救手段是删掉规则。
      // ⚠️ 锚点必须**跨行**：单行 `if (!r.enabled) continue;` 在本文件里有两处
      //（matchRules 与本函数各一处），而 `String.replace` 只替首处 —— 会打到无关分支上。
      name: 'R37-04b · speedLimitFor 不再检查 enabled（已禁用的限速规则仍在限速）',
      file: 'server/ip-guard.js',
      anchor: "    if (!r.enabled) continue;\n    if (r.kind !== 'speed') continue;                 // 屏蔽规则不参与限速\n    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      replacement: "    if (r.kind !== 'speed') continue;                 // 屏蔽规则不参与限速\n    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 速率为 0 的限速规则必须等价于「没设」。若拿 0 当有效速率，命中它的下载会被
      // 卡在 1 字节/秒的下限上 —— 表现是「下载永远不动」，比屏蔽还难排查。
      name: 'R37-04c · speedLimitFor 接受 0 速率（命中后下载几乎停滞）',
      file: 'server/ip-guard.js',
      anchor: "    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      replacement: "    if (!(Number(r.speedLimit) >= 0)) continue;       // 变异：0 也算有效速率",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 节拍器插错位置（放在计量**之后**）：traffic / statsStore 记的与实际下发不一致，
      // 且解密后的明文字节不再是被计量的那一份，「今天下载了多少」从此对不上账。
      name: 'R37-05a · download-stream 把节拍器插在计量环节之后（计量口径与限速不一致）',
      file: 'server/download-stream.js',
      anchor: '  const stages = throttle ? [out, throttle, meter, res] : [out, meter, res];',
      replacement: '  const stages = throttle ? [out, meter, throttle, res] : [out, meter, res];',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // WebDAV 的 GET 是完全独立的下发路径：漏掉这一处接线，主站限速生效、挂载盘全速 ——
      // 「限速」成了一个可以被换条路绕过的摆设。这是本轮最容易漏的一处。
      name: 'R37-05b · WebDAV 下载出口漏接限速（挂载盘成了全速旁路）',
      file: 'server/webdav/app.js',
      anchor: '      const throttle = makeThrottle({\n        ip: security.clientIp(req),\n        method: req.method,\n        credentialId: cfg.credentialId,\n        bucketId: cfg.bucketId,\n      });',
      replacement: '      const throttle = null;',
      testFile: 'audit37-regressions.test.js',
      minFail: 2,
    },
    {
      // 前端把限速值拼进请求体这一步若丢掉，用户在「文件分享」里填了限速、界面提示保存成功，
      // 而记录上仍是 0（= 不限速）——「填了不生效」是最难被用户定位的一类失效。
      name: 'R37-06a · 文件分享对话框不再提交 speedLimit（填了不生效）',
      file: 'public/js/ops.js',
      anchor: '            body.speedLimit = sp.bytes;',
      replacement: '',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 「文件分享」与「链接管理」是**同一条记录上的同一个字段**（已与用户确认）。
      // create 不落这个字段 → 在文件分享里设的限速不会被保存。
      name: 'R37-06b · share-store.create 不落 speedLimit（文件分享设的限速丢失）',
      file: 'server/share-store.js',
      anchor: '    speedLimit: normalizeSpeedLimit(speedLimit), // R37：链接级下载限速（0 = 不限）',
      replacement: '',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 迁移若做成「复制一份回桶页」，就会出现两张卡片各自渲染、各自请求同一份规则表
      // （同一状态两条读路径），而且用户会以为改了一个另一个也跟着变。
      name: 'R37-07a · IP 屏蔽卡片被复制回存储桶页（迁移退化成两份）',
      file: 'public/index.html',
      anchor: '        <section id="bucketmgr" class="card-view" hidden>',
      replacement: '        <section id="bucketmgr" class="card-view" hidden>\n          <div class="dash-card wide" id="ipguard-card"><div id="ipguard-table"></div></div>',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },

    /* ============ R38-01 · Windows Hello「当前访问地址不是本站域名」 ============ */

    {
      // 根因就是这一行漏了 `SITE_DOMAIN`：允许集里只剩 `HOST=0.0.0.0` 这个**通配
      // 绑定地址**（请求的 `Host` 头永远不可能等于它）加上两个默认空字符串 ——
      // 允许集**实际为空**，于是用真实域名访问本站反而被判成「访问了外站」。
      name: 'R38-01a · SITE_DOMAIN 未纳入「本站域名」允许集（用户报的 403 原样复现）',
      file: 'server/security.js',
      anchor: '  const own = new Set([normalizeHost(DEPLOY_HOST), SITE_DOMAIN]);',
      replacement: '  const own = new Set([normalizeHost(DEPLOY_HOST)]);',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 修这个根因时最顺手的做法就是「把这道判据放宽」—— 而那会把 R24-02 的防钓鱼面
      // 一起拆掉：任何域名都成了「本站」，攻击者可以在仿冒域上骗取 Windows Hello 签名。
      name: 'R38-01b · 干脆把 isOwnSiteHost 放宽成恒真（防钓鱼面被一起拆掉）',
      file: 'server/security.js',
      anchor: '  return own.has(h);\n}',
      replacement: '  return true;\n}',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // `0.0.0.0` 留在允许集里**不会**造成误放行（请求 `Host` 不可能等于它），
      // 但会让 `httpsRedirectHost()` 的回退分支把「无域名可用」误判成「有域名可用」，
      // 跳转目标于是变成 `https://0.0.0.0:3443/…` —— 一个必然打不开的地址。
      name: 'R38-01c · 不再剔除通配绑定地址（跳转目标退回 https://0.0.0.0:3443/…）',
      file: 'server/security.js',
      anchor: '  for (const x of [...own]) { if (isBindAllHost(x)) own.delete(x); }',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 「本站叫什么」与「分享链接优先用哪个域名」是两件事：后者只是展示偏好，
      // 拿它做 HTTPS 跳转目标会把用户送到一个并不提供本系统的域名上。
      name: 'R38-01d · HTTPS 跳转目标不认 SITE_DOMAIN（用户被送到分享用 CDN 域名）',
      file: 'server/security.js',
      anchor: '  if (SITE_DOMAIN) return SITE_DOMAIN;',
      replacement: '  if (false) return SITE_DOMAIN;',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 只改应用侧，只能救「手动设了 SITE_DOMAIN」的那一半；一键部署的站点完全靠
      // 这一行拿到自己的域名 —— 少了它，自动部署的站点原样踩同一个坑。
      name: 'R38-01f · 部署脚本不写 SITE_DOMAIN（自动部署的站点仍被判「外站」）',
      file: 'deploy.sh',
      anchor: 'SITE_DOMAIN=${DOMAIN}',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },

    /* ==================== R38-02 · 设置页「备份配置」 ==================== */

    {
      // 需求把「API Key 管理」与「负载均衡」列成两项，但它们在 `config.enc` 里是
      // **同一条 credentials 记录**（`quotaBytes`）。另立一个分区 = 同一个字段两个
      // 来源，导入时谁覆盖谁全凭顺序。
      name: 'R38-02b · 「负载均衡」被拆成独立分区（同一条记录两个来源）',
      file: 'server/backup.js',
      anchor: "  { label: '负载均衡', section: 'credentials' },",
      replacement: "  { label: '负载均衡', section: 'loadbalance' },",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求原话：「所有用户均不在备份范围内（包括管理员）」。账户与口令哈希属于
      // **这台实例**的身份，跨实例搬运等于把「谁能登录」一起搬走。
      name: 'R38-02c · 备份把用户表一起带上（跨实例搬运把「谁能登录」也搬走）',
      file: 'server/backup.js',
      /*
       * R55 复核：原锚点取的是 `ipguard` 块**加上紧随的 `};`（collect 的收尾）** ——
       * R55 在 ipguard 之后追加了 `smtp` / `site` 两段，那条 `};` 立刻不再紧跟其后，
       * 锚点失效（`invariants` 报「未命中」）。改为只锚 `ipguard` 块本身：
       * 变异要复现的是「把用户表塞进 collect 的返回值」，与它后面还有没有别的键无关。
       * 实测 `fail=3`：`R38-02c` + `R38-02e` / `R38-02g`（多出来的 `users` 分区同时打坏
       * 「分区集合必须与 SECTIONS 一致」这两条）—— 与 R55 之前一致，故 `minFail` 未上调。
       */
      anchor: '    ipguard: {\n      rules: clone(ipGuard.listRules() || []), // listRules 已剥掉派生缓存 `_parsed`\n    },',
      replacement: '    ipguard: {\n      rules: clone(ipGuard.listRules() || []), // listRules 已剥掉派生缓存 `_parsed`\n    },\n    users: clone(cfg.users || []),',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // WebDAV 口令在 `config.enc` 里是**字段级密封**（绑定本实例的 `data/secret.key`）。
      // 原样把 `passwordSealed` 搬走，在目标实例上是一段永远解不开的密文 ——
      // 症状是「导入成功、WebDAV 却登录不上」，且界面上看不出任何异常。
      name: 'R38-02k · 备份里带上 passwordSealed（跨实例永远解不开）',
      file: 'server/backup.js',
      anchor: "      password: String(full.password || ''),\n    };",
      replacement: "      password: String(full.password || ''),\n      passwordSealed: String(a.passwordSealed || 'sealed'),\n    };",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 准入判据要求「备份范围内每一项都算数」。漏掉任何一项，都会让「已经配过该项
      // 的实例」仍然显示可导入 —— 而那一次点击是**不可撤销**的整批覆盖。
      //
      // R41 起「登陆验证」的判据有**两半**：新结构的 `providers`（任一套填过即算数）
      // 与旧载荷的扁平 `siteKey`/`secretKey`。本条的变异摘掉的是**旧扁平键那一半**
      // （`R41-02g` 守的是 `providers` 那一半），两侧各有一条对照，不会互相遮蔽。
      name: 'R38-02l · 准入判据漏掉「登陆验证」的旧扁平键一侧（配过却仍允许导入线上实例）',
      file: 'server/backup.js',
      anchor: '  if (cap.siteKey || cap.secretKey) return false;\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 另一侧的失效：分区清单里列了、实际没写回。界面上「导入成功 7 项」，
      // 而上传排除一个字都没变 —— 没有任何运行期症状。
      name: 'R38-02m · 导入漏还原「上传排除」分区（清单列了、实际没写回）',
      file: 'server/backup.js',
      anchor: '  configStore.save({\n    uploadExcludes: {\n      dsStore: boolOf(ue.dsStore),\n      thumbsDb: boolOf(ue.thumbsDb),\n      gitignore: boolOf(ue.gitignore),\n    },\n  });',
      replacement: '  void ue; // 变异：整个分区不写回',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 导入若图省事循环调 `addRule()`，会丢掉 `id` 与 `enabled` ——
      // 「备份时停用的屏蔽规则，还原后变成启用」，用户只会觉得「导入把配置弄坏了」。
      name: 'R38-02o · 整批替换丢掉规则的 id / 停用状态（停用的屏蔽规则悄悄生效）',
      file: 'server/ip-guard.js',
      anchor: '  guard.rules = (Array.isArray(rules) ? rules : []).map((r) => {\n    const o = normalizeRule(r);\n    if (!o.id) o.id = newId();\n    return o;\n  });',
      replacement: '  guard.rules = (Array.isArray(rules) ? rules : []).map((r) => (\n    Object.assign({}, normalizeRule(r), { id: newId(), enabled: true })\n  ));',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 实时码里含 API Key / 支付凭证 / WebDAV 口令的**明文**。
      name: 'R38-02q · /backup/code 漏挂 requireAdmin（普通用户可读走全部密钥明文）',
      file: 'server/routes/backup.js',
      anchor: "router.get('/backup/code', requireAdmin, (req, res) => {",
      replacement: "router.get('/backup/code', (req, res) => {",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求原话：「导出该代码需进行权限验证（输入密码）」。拿掉这一步，任何持有
      // 有效会话的人都能把整份配置（含全部密钥明文）导出走。
      name: 'R38-02r · 导出不再校验账户口令（有会话就能导出全部密钥）',
      file: 'server/routes/backup.js',
      anchor: '  await assertAccountPassword(req, b.password);',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 顺序本身就是安全属性：先解密再判准入，会让「在已配置实例上反复试备份密码」
      // 成为一条可利用的**口令爆破信道**（响应差异可区分密码对不对）。
      name: 'R38-02s · 导入准入判据被摘掉（已配置实例上可反复试密码）',
      file: 'server/routes/backup.js',
      anchor: '  if (!backup.canImport()) {',
      replacement: '  if (false) {',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 准入判据被写成定值（「现算」的反面）—— 用户刚配好一个密钥，页面仍然显示
      // 「可以导入」，而那次点击会把线上配置整批覆盖掉。
      //
      // ⚠️ 这条对照**首次登记时 fail=0**，两次都错在同一个思路上：先去改 `backup.canImport()`
      // 的**本体**（加一个 module 级缓存），而护栏在 R38-02l 里已经先调过一次该函数、
      // 之后实例一直是「已配置」状态，缓存值恰好与期望值相同，于是变异测不出。
      // 打在**接口返回值**上才真正落在这条用例的判据上 —— 登记前实跑一遍的价值就在这里。
      name: 'R38-02t · 准入判据被写成定值（已配置实例仍显示「可以导入」）',
      file: 'server/routes/backup.js',
      anchor: '    canImport: backup.canImport(),',
      replacement: '    canImport: true,',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 「仅管理员可见」是这道功能的**第一层**保护：实时码里就是密钥明文。
      name: 'R38-02w · 备份卡片未纳入 ADMIN_ONLY_CARDS（普通用户也能读到实时码）',
      file: 'public/js/syssettings.js',
      anchor: "'sysset-payment-card', 'sysset-backup-card'];",
      replacement: "'sysset-payment-card'];",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求把「所有用户」排除在备份之外，于是导入**只覆盖备份范围里的顶层键**。
      // 顺手把载荷里的用户表也写进去（载荷里没有就写成空数组），后果不是「某个设置
      // 没还原」，而是把系统导成**零管理员** —— 管理页打不开、也没有自助恢复通道。
      name: 'R38-02x · 导入顺手写了用户表（把系统导成零管理员 → 永久锁死）',
      file: 'server/backup.js',
      anchor: '  configStore.flush();\n  return summarize(collect());',
      replacement: '  configStore.save({ users: Array.isArray(data.users) ? data.users : [] });\n  configStore.flush();\n  return summarize(collect());',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },

    /* ======== R39-01 · 部署脚本与应用的版本对齐（「修完重新部署仍复现」） ======== */

    {
      // 用户报的「重新部署后故障依旧」的最小复现：判据退化成「永不交接」，
      // 于是旧脚本继续生成环境变量、应用却已是新代码 —— 新文案 + 旧环境。
      name: 'R39-01a · 自我交接判据退化成「永不交接」（新代码 + 旧环境原样复现）',
      file: 'deploy.sh',
      anchor: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi\n  return 0',
      replacement: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi\n  return 1',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：内容一致也交接 —— 每次正常部署都白跑一整趟。
      name: 'R39-01b · 判据退化成「永远交接」（同版本也白跑一趟）',
      file: 'deploy.sh',
      anchor: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi',
      replacement: '  if [[ 1 == 0 ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 摘掉防环兜底 → 交出去的脚本会再交接回来，部署成了无限递归。
      name: 'R39-01c · 摘掉防环标记（自我交接变成无限递归）',
      file: 'deploy.sh',
      anchor: '  if [[ "${KEPLER_SELF_HANDOFF:-0}" == "1" ]]; then return 1; fi',
      replacement: '  if [[ "${KEPLER_SELF_HANDOFF:-0}" == "__never__" ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 脚本走管道（curl | bash）时无法自证版本，取向**必须**是「交给安装目录里那份」。
      // 反过来（不交接）就等于「管道部署永远拿不到新环境变量」，坑照旧。
      name: 'R39-01d · 自证不了版本时改为「不交接」（管道部署仍用旧环境变量）',
      file: 'deploy.sh',
      anchor: '  if [[ -z "${SELF_SCRIPT_HASH:-}" ]]; then return 0; fi',
      replacement: '  if [[ -z "${SELF_SCRIPT_HASH:-}" ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // ⭐ 本轮根因的正面对照：主流程不再交接 → 后面每一步都由上一版逻辑跑完，
      // 环境变量由旧 gen_env_file 生成。位置断言（必须在 gen_env_file 之前）即变红。
      name: 'R39-01e · 主流程不再做版本交接（环境变量仍由上一版逻辑生成）',
      file: 'deploy.sh',
      anchor: '\n  handoff_to_installed_script\n',
      replacement: '\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // exec 不触发 EXIT trap：不摘旧 trap，新进程一启动就撞上自己留下的锁，
      // 直接判「另一个部署进程正在运行」—— 交接等于没发生。
      name: 'R39-01f · exec 前不摘 EXIT trap（新进程撞上自己的锁直接退出）',
      file: 'deploy.sh',
      anchor: '  trap - EXIT\n  if ((${#ORIGINAL_ARGV[@]} > 0)); then',
      replacement: '  if ((${#ORIGINAL_ARGV[@]} > 0)); then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 不带域名 → 第二趟会再问一次域名；非交互场景（管道 / CI）直接判失败。
      name: 'R39-01g · 交接时不带已解析的域名（第二趟重复提问 / 非交互直接失败）',
      file: 'deploy.sh',
      anchor: 'KEPLER_SELF_HANDOFF=1 DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      replacement: 'KEPLER_SELF_HANDOFF=1 \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 不带锁 → 与 R39-01f 同后果的另一条实现路径：锁没交接，新进程自锁。
      name: 'R39-01h · 交接时不带单实例锁（新进程判「另一个部署进程正在运行」）',
      file: 'deploy.sh',
      anchor: 'KEPLER_SELF_HANDOFF=1 DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      replacement: 'DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // exec 前不做完整性预检 → 会把安装目录里被污染的文件（例如把下载到的
      // `404: Not Found` 响应体存成的「脚本」）当成脚本执行，以一句无从下手的报错中断。
      name: 'R39-01i · 交接前不做脚本完整性预检（把污染文件当脚本执行）',
      file: 'deploy.sh',
      anchor: '  if ! script_is_sane "$target"; then\n    warn "安装目录里的部署脚本疑似损坏',
      replacement: '  if false; then\n    warn "安装目录里的部署脚本疑似损坏',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 第二趟以安装目录自身为源码目录；若不短路，就会对它做
      // `tar -cf - . | tar -xf - -C 自己` —— 一边读一边覆盖自己。
      name: 'R39-01j · 取消「源码目录==安装目录」短路（对自己做 tar 自解压）',
      file: 'deploy.sh',
      anchor: '  if [[ -n "$src_real" && "$src_real" == "$dst_real" ]]; then',
      replacement: '  if false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 启动瞬间不采样指纹 → 判据永远认为「自己就是最新那份」（运行中被覆盖后再读自己，
      // 读到的已经是新内容），于是这个坑重新变成不可发现的。
      name: 'R39-01k · 启动时不采样自身指纹（判据永远认为「自己是最新」）',
      file: 'deploy.sh',
      anchor: 'SELF_SCRIPT_HASH="$(script_content_hash "$SELF_SCRIPT_FILE")"',
      replacement: 'SELF_SCRIPT_HASH=""',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },

    /* ======== R40-01 · EL8 上装 Node.js：模块包版本互斥 ======== */

    {
      // 用户给的那条命令的关键就是 `--allowerasing`：没有它，EL8 的 AppStream
      // nodejs:16 模块包与 NodeSource 的 nodejs20 直接互斥，dnf 连事务都进不去。
      name: 'R40-01a · 唯一实现点退化成「一个参数都不给」（EL8 装 Node 仍进不了事务）',
      file: 'deploy.sh',
      anchor: '  if [[ "${PM:-}" == "dnf" ]]; then printf \'%s\' "--allowerasing"; fi\n  return 0',
      replacement: '  return 0',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：无条件给。`--allowerasing` 是 dnf 的参数，旧版 yum / apt / apk / zypper
      // 收到它会直接报未知选项 —— 「修好了 EL8、弄坏了 EL7 与 Debian」。
      name: 'R40-01b · 参数变成「所有包管理器都给」（旧 yum / apt / apk 因未知选项直接失败）',
      file: 'deploy.sh',
      anchor: '  if [[ "${PM:-}" == "dnf" ]]; then printf \'%s\' "--allowerasing"; fi',
      replacement: '  if [[ 1 == 1 ]]; then printf \'%s\' "--allowerasing"; fi',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 两处安装点各是一条独立的路：只改一处 = 走另一条路（NodeSource / 发行版源）的
      // 机器仍然装不上。护栏数的是「两处都带」，撤掉一处即变红。
      name: 'R40-01c · 发行版源那条 node 安装退回不带额外参数（走这条路的 EL8 仍装不上）',
      file: 'deploy.sh',
      anchor: '    dnf|yum) run_soft "$PM" install -y nodejs $(node_pm_extra_args) ;;',
      replacement: '    dnf|yum) run_soft "$PM" install -y nodejs ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R40-01d · NodeSource 那条 node 安装退回不带额外参数（装完源之后照样失败）',
      file: 'deploy.sh',
      anchor: '        && run_soft "$PM" install -y nodejs $(node_pm_extra_args)',
      replacement: '        && run_soft "$PM" install -y nodejs',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 本轮改动的另一半：不再显式装 `npm` 这个独立包名 —— 单独 install npm 会把
      // AppStream 的 nodejs-npm 等模块包整串拉回来，正好又撞上同一个互斥。
      name: 'R40-01e · RPM 分支退回 `install -y nodejs npm`（把模块包整串拉回来，又撞同一个冲突）',
      file: 'deploy.sh',
      anchor: '    dnf|yum) run_soft "$PM" install -y nodejs $(node_pm_extra_args) ;;',
      replacement: '    dnf|yum) run_soft "$PM" install -y nodejs npm ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 装包命令已经带了 --allowerasing，指引的第一条就该是它；退回旧版「先 module reset」
      // 会把用户推去动全局模块状态（副作用大、且不是对症的那一档）。
      // ⚠️ 必须整段替换：`--allowerasing` 在同一段里出现**两次**（第 1 条与第 4 条），
      //    只改第 1 条的话输出里仍有这个词，护栏照样全绿（实测过）。
      name: 'R40-01f · 冲突指引退回「先 module reset」且不再给 --allowerasing',
      file: 'deploy.sh',
      anchor: '      add_hint "    1) ${PM} install -y nodejs --allowerasing   # 先试这条：让 dnf 直接替换掉冲突的旧模块包"\n'
        + '      add_hint "    2) ${PM} module reset nodejs"\n'
        + '      add_hint "    3) ${PM} remove -y nodejs npm nodejs-full-i18n nodejs-libs nodejs-devel"\n'
        + '      add_hint "    4) curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && ${PM} install -y nodejs --allowerasing" ;;',
      replacement: '      add_hint "    1) ${PM} module reset nodejs"\n'
        + '      add_hint "    2) ${PM} remove -y nodejs npm nodejs-full-i18n nodejs-libs nodejs-devel"\n'
        + '      add_hint "    3) curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && ${PM} install -y nodejs" ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },

    /* ======== R40-02 · 「用户管理」里不能编辑自己 ======== */

    {
      // 需求原文：「隐藏自己那一列的『编辑』按钮」。判据是 `isSelf`，把它短路成 false
      // 就等于「自己那一行也渲染编辑按钮」—— 管理员又能把自己改废了。
      name: 'R40-02a · 自己那一行也渲染「编辑」按钮（isSelf 判据被短路）',
      file: 'public/js/syssettings.js',
      anchor: '          const editBtn = isSelf ? \'\'',
      replacement: '          const editBtn = false ? \'\'',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：算了却不渲染。`editBtn` 是插值进行模板的，撤掉那一行 = 谁都编辑不了
      // —— proves「按钮算出来了」与「按钮真的在行里」是两件事。
      name: 'R40-02b · 行模板不再插 ${editBtn}（按钮算了却没渲染，所有人都不能编辑）',
      file: 'public/js/syssettings.js',
      anchor: '              ${editBtn}\n              ${banBtn}',
      replacement: '              ${banBtn}',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },

    /* ======== R40-03 · 日间 / 暗黑快捷切换 ======== */

    {
      // 多步变异 = 把按钮**搬到**账户菜单右侧（而不是删掉它）：需求是「在账户菜单的
      // **左侧**」，位置断言是 `btn < menu`，只有真的换位置才能证伪它。
      name: 'R40-03a · 切换按钮被挪到账户菜单右侧（需求是左侧）',
      file: 'public/index.html',
      mutations: [
        {
          anchor: '          <button id="btn-theme" class="tb-btn theme-btn" type="button" title="切换到暗黑模式" aria-pressed="false">\n'
            + '            <svg class="ic-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.3 2.2a9.9 9.9 0 1 0 9.5 12.6 7.9 7.9 0 0 1-9.5-12.6z"/></svg>\n'
            + '            <svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"><path d="M12 2.7v2.3M12 19v2.3M2.7 12H5M19 12h2.3M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></g></svg>\n'
            + '          </button>\n',
          replacement: '',
        },
        {
          anchor: '          <span class="tb-sep"></span>\n          <button id="btn-syssettings"',
          replacement: '          <span class="tb-sep"></span>\n'
            + '          <button id="btn-theme" class="tb-btn theme-btn" type="button" title="切换到暗黑模式" aria-pressed="false">\n'
            + '            <svg class="ic-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.3 2.2a9.9 9.9 0 1 0 9.5 12.6 7.9 7.9 0 0 1-9.5-12.6z"/></svg>\n'
            + '            <svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"><path d="M12 2.7v2.3M12 19v2.3M2.7 12H5M19 12h2.3M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></g></svg>\n'
            + '          </button>\n'
            + '          <button id="btn-syssettings"',
        },
      ],
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 「不闪白」的全部秘密就是这一句：解析期同步落属性。改成等 DOMContentLoaded
      // 就等于「暗色用户每次加载先看一帧白」—— 而这正是本轮要避免的。
      name: 'R40-03b · theme.js 不再在解析期落属性（暗色用户每次加载先闪一帧白）',
      file: 'public/js/theme.js',
      anchor: '  if (root.document) init(root.document);',
      replacement: '  if (false) init(root.document);',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 「当前是哪个主题」必须读 DOM 属性。改读 storage 之后，隐私模式（storage 恒抛）
      // 下每次读到的都是日间 → 第一次点击之后再也切不回亮色（单向切换）。
      name: 'R40-03c · toggle 改以 storage 为「当前值」（隐私模式下点两下切不回去）',
      file: 'public/js/theme.js',
      anchor: '        setTheme(doc, st, toggle(doc.documentElement.getAttribute(ATTR)));',
      replacement: '        setTheme(doc, st, toggle(read(st)));',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 脏值必须归到日间。改成「真值即暗色」之后，localStorage 里任何残留字符串都会
      // 让页面变暗 —— 主题成了脏数据说了算。
      name: 'R40-03d · normalize 退化成「真值即暗色」（脏数据决定主题）',
      file: 'public/js/theme.js',
      anchor: '  function normalize(value) {\n    return value === DARK ? DARK : LIGHT;\n  }',
      replacement: '  function normalize(value) {\n    return value ? DARK : LIGHT;\n  }',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 明暗两套变量必须一一对应。少一格 = 那个面在暗色下仍是亮色（实测里最刺眼的是
      // 输入框 / 对话框 / 提示块那几块白）。
      name: 'R40-03e · 暗色块漏掉一个颜色变量（那个面在暗色下仍是亮色）',
      file: 'public/css/style.css',
      anchor: '  --muted: #8b93a1;',
      replacement: '',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 图标靠 CSS 按主题显隐。少了这一条，日间模式下两颗图标会一起出现
      //（月亮与太阳叠在一起），且点了没有视觉反馈。
      name: 'R40-03f · 暗色模式下不再露出太阳图标（两颗图标同时出现）',
      file: 'public/css/style.css',
      anchor: '[data-theme="dark"] .theme-btn .ic-sun { display: inline; }',
      replacement: '[data-theme="dark"] .theme-btn .ic-sun { display: none; }',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-01：把实现脚本真正所在的那个域名从 CSP 里撤掉 = 修复前的形态。
       *
       * 实测（无头 Chrome + DevTools 协议）：`www.recaptcha.net` 下发的只是**引导脚本**，
       * 它再注入 `recaptcha/releases/<版本>/recaptcha__*.js`，该实现在中国大陆解析到
       * `www.gstatic.cn`。CSP 的 host-source 是**精确匹配**，站点里只列了 `www.gstatic.com`
       * ⇒ 实现在 `script-src-elem` 上报违规 ⇒ `grecaptcha` 永不 ready ⇒
       * 界面永远停在「正在加载人机验证组件…」（实测轮询 20.28s 耗尽）。
       */
      name: 'R41-01a · CSP 去掉 www.gstatic.cn（reCAPTCHA 卡在「正在加载人机验证组件…」）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://challenges.cloudflare.com; "',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-01b：少写一个 `www` —— 最像「已经修好了」的错法。
       *
       * host-source 精确匹配，`https://gstatic.cn` **不**匹配 `https://www.gstatic.cn`：
       * 源码里肉眼看是「加了 gstatic.cn」，浏览器里照样拦。
       */
      name: 'R41-01b · CSP 把实现脚本域名写成 gstatic.cn（少一个 www = 仍然被拦）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://gstatic.cn https://challenges.cloudflare.com; "',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02a：保存时只写「当前选中」的那一套（= 旧扁平结构的思路）。
       * 后果：切一次服务商，另一家的密钥就被悄悄丢弃 —— 需求要的正是「两套同时保存」。
       */
      name: 'R41-02a · saveCaptcha 只写选中服务商（切换服务商即丢掉另一套）',
      file: 'server/config-store.js',
      anchor: '  for (const name of CAPTCHA_PROVIDERS) {\n'
        + '    const e = incoming[name];\n'
        + '    if (!e || typeof e !== \'object\') continue;',
      replacement: '  for (const name of CAPTCHA_PROVIDERS.filter((n) => n === provider)) {\n'
        + '    const e = incoming[name];\n'
        + '    if (!e || typeof e !== \'object\') continue;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02b：派生视图写死取 reCAPTCHA 那一套（而不是选中那一套）。
       * 后果：切到 Turnstile 后，服务端仍在用 reCAPTCHA 的密钥校验、前端仍渲染 reCAPTCHA 组件 ——
       * 「切换」在界面上看着成功了，实际一点没生效。
       */
      name: 'R41-02b · getCaptcha 的派生 siteKey/secretKey 固定取 reCAPTCHA（切换不生效）',
      file: 'server/config-store.js',
      anchor: '  const providersMap = captchaProvidersOf(c);\n  const sel = providersMap[provider];',
      replacement: '  const providersMap = captchaProvidersOf(c);\n  const sel = providersMap.recaptcha;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02c：**顺序陷阱** —— 先取密钥、再决定用哪一家。
       *
       * 环境变量 `CAPTCHA_PROVIDER` 把生效方切到 Turnstile，而密钥却按**存储里**的
       * reCAPTCHA 取：前端会拿着 reCAPTCHA 的 siteKey 去渲染 Turnstile 组件（渲染失败），
       * 服务端也会拿错密钥去回源校验。
       */
      name: 'R41-02c · resolveConfig 先取密钥再定服务商（环境变量切家后取错那一套）',
      file: 'server/captcha.js',
      anchor: '  const sel = (byProvider[merged.provider] && typeof byProvider[merged.provider] === \'object\')\n'
        + '    ? byProvider[merged.provider] : null;',
      replacement: '  const keyProvider = stored.provider === \'turnstile\' ? \'turnstile\' : \'recaptcha\';\n'
        + '  const sel = (byProvider[keyProvider] && typeof byProvider[keyProvider] === \'object\')\n'
        + '    ? byProvider[keyProvider] : null;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02d：旧扁平配置不再被迁进它当时选中的那一套。
       * 后果：升级到本版本后，管理员原有的 siteKey/secretKey 凭空消失，登录页无验证码可用。
       */
      name: 'R41-02d · 旧扁平配置不再迁进 providers[provider]（升级后密钥凭空消失）',
      file: 'server/config-store.js',
      anchor: '    if (!e.siteKey && !e.secretKey && p === flatProvider) {',
      replacement: '    if (!e.siteKey && !e.secretKey && p === \'recaptcha\') {',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02e：把「空串 = 保持原密钥」当成「清空」。
       * 后果：界面上的密码框永远不回填明文、每次保存都提交空串 ⇒ 管理员只改一下超时时间，
       * 两套密钥当场清空，登录立刻被 `captcha_not_configured` 拦死。
       */
      name: 'R41-02e · saveCaptcha 把空串当作清除密钥（改一次超时即清空密钥、锁死登录）',
      file: 'server/config-store.js',
      anchor: '    else if (e.secretKey !== undefined && e.secretKey !== \'\') cur.secretKey = String(e.secretKey);',
      replacement: '    else if (e.secretKey !== undefined && e.secretKey !== null) cur.secretKey = String(e.secretKey || \'\');',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02f：管理端视图把明文 secretKey 一起下发。
       * 后果：服务端密钥只该用于回源校验，一旦进入响应体就等于「任何拿到管理员会话的人
       * 都能把密钥导出带走」（浏览器缓存 / 代理日志 / 前端内存四处都是）。
       */
      name: 'R41-02f · GET /captcha/config 下发明文 secretKey（密钥外泄）',
      file: 'server/routes/captcha.js',
      anchor: '    out[name] = { siteKey: String(e.siteKey || \'\'), hasSecret: Boolean(e.secretKey) };',
      replacement: '    out[name] = { siteKey: String(e.siteKey || \'\'), hasSecret: Boolean(e.secretKey), secretKey: String(e.secretKey || \'\') };',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02g：空判据只看扁平键（漏掉 providers）。
       * 后果：只配了 Turnstile 的实例被判定为「全新」⇒ 导入闸门打开 ⇒ 一次点击把已配置的
       * 那一套静默覆盖掉，而界面上没有任何提示。
       */
      name: 'R41-02g · isEmptyData 漏掉 providers（只配了 Turnstile 仍允许导入、静默覆盖）',
      file: 'server/backup.js',
      anchor: '  const capProvs = (cap.providers && typeof cap.providers === \'object\') ? cap.providers : {};',
      replacement: '  const capProvs = {};',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02h：备份不再携带两套凭证。
       * 后果：恢复后另一家（多半是尚未启用的那一家）的密钥没了，管理员得回服务商控制台
       * 重新申请一遍 —— 备份「能用」但没保住该保住的东西。
       */
      name: 'R41-02h · 备份不再携带两套凭证（恢复后另一家密钥丢失）',
      file: 'server/backup.js',
      anchor: 'function captchaProviders(cap) {\n  return configStore.captchaProvidersOf(cap || {});\n}',
      replacement: 'function captchaProviders(cap) {\n  return { recaptcha: { siteKey: \'\', secretKey: \'\' }, turnstile: { siteKey: \'\', secretKey: \'\' } };\n}',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02i：前端只提交「当前选中」那一家的输入框。
       * 后果：正是需求点名的那个毛病 —— 切换服务商时另一套被清空。
       */
      name: 'R41-02i · 前端只提交选中服务商（切家即清空另一套）',
      file: 'public/js/syssettings.js',
      anchor: '  for (const p of CAPTCHA_PROVIDERS) {\n'
        + '    const sk = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    const se = document.getElementById(\'captcha-secretkey-\' + p);',
      replacement: '  for (const p of [chipValue(\'captcha-provider\') || \'recaptcha\']) {\n'
        + '    const sk = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    const se = document.getElementById(\'captcha-secretkey-\' + p);',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02j：回填时把两家的站点密钥都写进 reCAPTCHA 那一个输入框（串台）。
       * 后果：界面显示的密钥与它标注的服务商对不上，管理员照着改只会越改越乱。
       */
      name: 'R41-02j · 前端回填串台（两家的密钥都写进 reCAPTCHA 的输入框）',
      file: 'public/js/syssettings.js',
      anchor: '    const siteKey = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    if (siteKey) siteKey.value = e.siteKey || \'\';',
      replacement: '    const siteKey = document.getElementById(\'captcha-sitekey-recaptcha\');\n'
        + '    if (siteKey) siteKey.value = e.siteKey || \'\';',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02k：通用 `save()` 不再归一 captcha。
       * 后果：一次带扁平 `siteKey` 的部分写入会与 `providers` 并存两个真相，而读取侧只认
       * `providers` ⇒ **写入静默失效**（接口回 ok、界面显示已保存，登录页却拿不到 siteKey）。
       */
      name: 'R41-02k · save() 不再归一 captcha（扁平键写入静默失效）',
      file: 'server/config-store.js',
      /**
       * ⚠️ R54 复核纠正：这条 anchor 在 R53 曾经被「顺着往后挪一行」改成
       * `normalizeSmtpInto(cur);\n  return persist(cur);` —— 那让**判据本身失效**了：
       * 变异撤掉的是 smtp 归一化，而本条声称守的是 **captcha** 归一化，
       * 它只是**碰巧**还能让 audit41 红（别的用例被牵连）。现已改回直接锚
       * **captcha 那一行**，与实际要证伪的对象对齐。
       */
      anchor: '  normalizeCaptchaInto(cur);\n',
      replacement: '',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02l：启用校验把「另一家配好了」当成「这一家配好了」。
       * 后果：管理员切到一家空配置的服务商并点保存，功能被启用、登录页却渲染不出组件 ⇒
       * 所有人被 `captcha_not_configured` 挡在门外。
       */
      name: 'R41-02l · 启用校验拿另一家的凭证放行（切换后锁死登录）',
      file: 'public/js/syssettings.js',
      anchor: '    if (!sel.siteKey) { showMsg(`启用验证码需填写「${captchaProviderName(provider)}」的站点密钥（Site Key）`, \'bad\'); return; }',
      replacement: '    const otherKey = CAPTCHA_PROVIDERS.some((x) => { const el = document.getElementById(\'captcha-sitekey-\' + x); return !!(el && (el.value || \'\').trim()); });\n'
        + '    if (!sel.siteKey && !otherKey) { showMsg(`启用验证码需填写「${captchaProviderName(provider)}」的站点密钥（Site Key）`, \'bad\'); return; }',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02m：路由把空串也当成「清除密钥」。
       * 后果与 R41-02e 同型，只是发生在边界层：前端每次保存都提交空串（密码框不回填明文），
       * 于是每点一次「保存设置」都会把这一家的服务端密钥清掉。
       */
      name: 'R41-02m · PUT /captcha/config 把空 secretKey 当成清除（每次保存都清密钥）',
      file: 'server/routes/captcha.js',
      anchor: '  if (entry.secretKey === null) out.secretKey = null;',
      replacement: '  if (entry.secretKey === null || entry.secretKey === \'\') out.secretKey = null;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01a：把「跨厂商不继承」这条判据整个去掉 = 修复前的形态。
       *
       * 后果：`/api/config/verify` 验证**别家**密钥时，会把当前激活桶的
       * region / bucket / endpoint 一起带上 —— 用华为云密钥实际打向
       * `obs.ap-southeast-2.myhuaweicloud.com`（华为云没有该地域）⇒ DNS 失败，
       * 界面只说「网络连接异常」；又拍云更隐蔽：端点固定且正确，错的是**签名地域**。
       * 用户可见症状即「密钥完全正确却验不过」，且「谁先配好谁正常」。
       */
      name: 'R42-01a · /config/verify 跨厂商继承激活桶的 region/bucket/endpoint（正确的 key 也验不过）',
      file: 'server/routes/config.js',
      anchor: '    const sameProvider = !reqProvider\n      || reqProvider === String(stored.provider || providers.DEFAULT_PROVIDER_ID);',
      replacement: '    const sameProvider = true;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01b：只把 `region` 的一处继承放开（bucket / endpoint 仍受控）。
       * 单点变异，用来定位「究竟是哪一项污染了验证」——
       * 端点由地域推导的厂商（华为云 / 七牛 / B2）会因此打到不存在的主机。
       */
      name: 'R42-01b · /config/verify 只把 region 的继承放开（端点被别家地域拼走）',
      file: 'server/routes/config.js',
      anchor: 'const region = (b.region && String(b.region).trim()) || inherit(stored.region);',
      replacement: "const region = (b.region && String(b.region).trim()) || stored.region || '';",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01c：只把 `bucket` 的继承放开。
       * 后果：拿激活桶（属于别家厂商）的名字去本厂商做 headBucket 存在性探测 ——
       * 即便密钥有效，也会得到「未找到存储桶 / 存储桶验证失败」。
       */
      name: 'R42-01c · /config/verify 只把 bucket 的继承放开（拿别家的桶名去探测）',
      file: 'server/routes/config.js',
      anchor: 'const bucket = (b.bucket && String(b.bucket).trim()) || inherit(stored.bucket);',
      replacement: "const bucket = (b.bucket && String(b.bucket).trim()) || stored.bucket || '';",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01d：只把 `endpoint` 的继承放开。
       * 后果最直白：阿里云等「有固定端点」的厂商 `effective().endpoint` **恒非空**，
       * 于是别家密钥的请求被原样发到它的域名上。
       */
      name: 'R42-01d · /config/verify 只把 endpoint 的继承放开（请求发到别家域名）',
      file: 'server/routes/config.js',
      anchor: '(b.endpoint && String(b.endpoint).trim()) || inherit(stored.endpoint)',
      replacement: "(b.endpoint && String(b.endpoint).trim()) || stored.endpoint || ''",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02a：撤掉华为云的 UNSIGNED-PAYLOAD 声明。
       * 华为云 OBS 的 V4 只支持 UNSIGNED-PAYLOAD（与流式分块），发真实载荷哈希
       * 必得 403 SignatureDoesNotMatch，且报文不带任何线索 ⇒ 界面显示
       * 「签名错误：请检查 AccessKey / SecretKey 是否正确」，把运维引向轮换一把
       * 完全有效的密钥。
       */
      name: 'R42-02a · 华为云不再声明 unsignedPayload（发真实载荷哈希 = OBS 403）',
      file: 'server/providers.js',
      anchor: '    unsignedPayload: true,',
      replacement: '    unsignedPayload: false,',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02b：把「按厂商下发」改成「一律 true」——
       * 看着更「安全」，实际会把七牛打挂（其 S3 文档明确要求每个请求带 payload 的 sha256）。
       * 这条同时压住两个方向：华为云必须开，别家必须不开。
       */
      name: 'R42-02b · unsignedPayload 不再按厂商判定（一律 true = 七牛等被拒）',
      file: 'server/providers.js',
      anchor: 'return resolve(id).unsignedPayload === true;',
      replacement: 'return true;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02c：客户端拿到标志却不用（注册表是对的，`s3-client` 丢了）。
       * 「配置层改好了、执行层没执行」—— 本项目反复踩过的形态，必须单独一条。
       */
      name: 'R42-02c · s3-client 忽略 unsignedPayload 标志（注册表正确但执行层失效）',
      file: 'server/s3-client.js',
      anchor: 'if (this.unsignedPayload) payloadHash = UNSIGNED_PAYLOAD;',
      replacement: 'if (false && this.unsignedPayload) payloadHash = UNSIGNED_PAYLOAD;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02d：顺手给七牛也开上（「多开一家更保险」的直觉错法）。
       * 七牛 Kodo 的 S3 文档明确要求真实载荷 sha256，开成 UNSIGNED-PAYLOAD 会被拒。
       */
      name: 'R42-02d · 七牛云也被声明 unsignedPayload（该家明确要求真实载荷哈希）',
      file: 'server/providers.js',
      anchor: "credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },",
      replacement: "credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },\n    unsignedPayload: true,",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01a：把 getService 里的地域补查整条撤掉（= 修复前的形态）。
       *
       * 后果：华为云的 ListBuckets 不回地域，客户端便拿**自己的 region** 冒充桶的地域
       * 返回给界面；界面回填进「添加存储桶」表单后，请求打到
       * `<bucket>.obs.<假地域>.myhuaweicloud.com`，而 OBS 对地域不一致回
       * **404 NoSuchBucket**（官方《Accessing OBS》），界面读成「资源不存在 / 密钥不对」。
       */
      name: 'R43-01a · getService 不补查 GetBucketLocation（拿客户端地域冒充桶地域 ⇒ 添加桶必 404）',
      file: 'server/s3-client.js',
      anchor: 'if (!region && this.queryBucketLocation) region = await this._bucketLocation(name);',
      replacement: 'if (false) region = await this._bucketLocation(name);',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01b：注册表里撤掉华为云的声明。
       * 「配置层改对了、执行层没执行」的镜像形态：能力在客户端写着，但没有任何厂商打开它。
       */
      name: 'R43-01b · 注册表撤掉华为云的 queryBucketLocation（能力在、没人开）',
      file: 'server/providers.js',
      anchor: '    queryBucketLocation: true,',
      replacement: '    queryBucketLocation: false,',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01c：判据一律 true —— 「多开几家更保险」的直觉错法。
       * 后果：每个缺地域的桶都多打一轮 ?location（含 AWS / MinIO 等），
       * 且让「只有华为云需要它」这条事实失去护栏。
       */
      name: 'R43-01c · queryBucketLocation 不再按厂商判定（一律 true = 别家也白打一轮）',
      file: 'server/providers.js',
      anchor: 'return resolve(id).queryBucketLocation === true;',
      replacement: 'return true;',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01d：客户端工厂不再把标志传下去（注册表正确，实例上却是 false）。
       * 单独一条，用来区分「没声明」与「声明了但没下发」—— 合并成一条就分不清。
       */
      name: 'R43-01d · s3.createClient 不下发 queryBucketLocation（声明了却传不到客户端）',
      file: 'server/s3.js',
      anchor: 'queryBucketLocation: providers.queryBucketLocation(pid),',
      replacement: 'queryBucketLocation: false,',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01e：补查发了、但响应解析不出来（恒空串）。
       * 这是「请求发了就算修好」的假象：网络层全对，地域照旧是客户端那个。
       */
      name: 'R43-01e · _bucketLocation 解析不出地域（请求发了、值仍是空的）',
      file: 'server/s3-client.js',
      anchor: "return normalizeBucketRegion(unescapeXml(tag(body, 'Location') || tag(body, 'LocationConstraint')));",
      replacement: "return '';",
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-01f：把「只在缺地域时才补查」的前置条件去掉 ⇒ 已有地域的桶也被再问一次。
       * 后果不是错值而是**每次列举桶都多一轮请求**（账号桶一多即成倍放大）。
       */
      name: 'R43-01f · 去掉「仅缺地域时补查」的前置条件（已有地域也再问一轮）',
      file: 'server/s3-client.js',
      anchor: 'if (!region && this.queryBucketLocation)',
      replacement: 'if (this.queryBucketLocation)',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-02a：又拍云的字段名回退成「操作员 / 操作员密码」= 用户报的形态。
       * 字段名是「该填什么」的唯一提示，写错等于让用户拿账号密码去试 S3 签名。
       */
      name: 'R43-02a · 又拍云密钥字段回退成「操作员 / 操作员密码」（用户报的原形态）',
      file: 'server/providers.js',
      anchor: "      id: 'AccessKey',\n      key: 'SecretAccessKey',\n      idPlaceholder: '请输入又拍云 S3 AccessKey',",
      replacement: "      id: '操作员',\n      key: '操作员密码',\n      idPlaceholder: '请输入操作员名称',",
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-02b：掩码函数空转（原样返回）。
       * 判据落在函数层，但另有 R43-03b 从**调用点层**钉住「DOM 里不得出现完整码」。
       */
      name: 'R43-02b · maskCode 原样返回（掩码形同虚设，明文照旧铺在页面上）',
      file: 'public/js/backupcfg.js',
      anchor: "export function maskCode(code) {\n  const s = String(code == null ? '' : code);",
      replacement: "export function maskCode(code) {\n  return String(code == null ? '' : code);\n  const s = String(code == null ? '' : code);",
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R43-02c：**调用点**写回明文 —— 「助手函数写对了、真接线处没用它」。
       * R43-03b 专门落在调用点层，就是为这一条存在的（R21-14 / R40-03 同型教训）。
       */
      name: 'R43-02c · 调用点写回明文（maskCode 正确但没被用上）',
      file: 'public/js/backupcfg.js',
      anchor: 'if (ta) ta.value = maskCode(liveCode);',
      replacement: 'if (ta) ta.value = liveCode;',
      testFile: 'audit43-regressions.test.js',
      minFail: 1,
    },

    /* ================================================================== *
     * R44 —— 侧栏「文件夹导航」→「文件类型」筛选（1.6.6 → 1.6.7）
     *
     * 这一轮的风险不在「功能写不出来」，而在四个**静默失效**的形态：
     *   ① 分类表分叉（前端再存一份后缀表 ⇒ 与服务端漂移）；
     *   ② 过滤点分叉（侧栏自己过滤一遍 / 渲染忘了用可见集 / 全选选到隐藏项）；
     *   ③ 图标名拼错（`<use href="#不存在">` 在浏览器里**静默渲染成空白**，
     *      不报错、控制台不提示 —— 只能靠双向覆盖断言兜住）；
     *   ④ 归一化变换漏掉（图形大小不齐，肉眼才发现）。
     * 另有一条是本轮**实测踩到**的真事故（R44-06a 的裸 `render()`），
     * 与 R27-01 的裸 `currentItems()` 完全同类：静态看代码毫无异常，
     * 运行期抛 ReferenceError，用户侧只看到「点了没反应」。
     * ================================================================== */

    {
      /*
       * R44-01a：apk 在两处都列（「压缩包」和「可执行文件」各留一份）。
       * 看似无害（都是"可执行/归档"），但 `typeOf()` 是按 `Object.entries` **键序**
       * 返回**第一个**命中的类，archive 排在 exec 之前 ⇒ apk 永远判成 archive，
       * 侧栏「可执行文件」永远少数几个，而界面完全看不出问题。
       */
      name: 'R44-01a · apk 同时留在 archive 与 exec（键序让 apk 永远判成压缩包）',
      file: 'server/routes/_shared.js',
      anchor: "  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'jar'],",
      replacement: "  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'jar', 'apk'],",
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-01b：顺手把 `svg` 从 image 删掉（「图片后缀太多，清一清」）。
       * 后果不是少一个图标：svg 会掉进 `other`，**丢掉缩略图与图片预览**
       * （服务端按 type 决定是否走图片口径），用户看到的是「以前能预览的 svg 现在不能了」。
       * 分类表只允许**新增与搬家**，不允许删减。
       */
      name: 'R44-01b · TYPE_EXT 顺手删掉 svg（sv 掉进 other，缩略图与预览一起没了）',
      file: 'server/routes/_shared.js',
      anchor: "  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic'],",
      replacement: "  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'heic'],",
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-02a：过滤判据从「排除文件夹」改成「文件夹也算」。
       * 这是本轮澄清过的口径：文件夹不属于任何文件类型，选中具体类型时必须隐藏。
       * 写成 `||` 后每个筛选结果里都混着文件夹，计数与列表行数对不上。
       */
      name: 'R44-02a · visibleItems 不再排除文件夹（每个筛选结果都混进文件夹）',
      file: 'public/js/explorer.js',
      anchor: '  if (!t) return state.items;\n  return state.items.filter((i) => !i.isFolder && i.type === t);',
      replacement: '  if (!t) return state.items;\n  return state.items.filter((i) => i.isFolder || i.type === t);',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-03a：渲染仍迭代 `state.items`（筛选只改了侧栏高亮，列表没动）。
       * 「算出来了、没人用」的典型形态 —— 侧栏点得很热闹，列表纹丝不动。
       */
      name: 'R44-03a · renderList 迭代 state.items（筛选算出来了、列表没跟着变）',
      file: 'public/js/explorer.js',
      anchor: '  const rows = state.visible.map((item, idx) => {',
      replacement: '  const rows = state.items.map((item, idx) => {',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-04a：「全选」基于全部项而不是可见项。
       * 筛选「图片」时把隐藏的文件夹 / 压缩包也选上，随后的下载与删除
       * 会作用到用户**看不见**的对象上 —— 这是会丢数据的形态。
       */
      name: 'R44-04a · selectAll 基于 state.items（把看不见的项也选上，删除会误伤）',
      file: 'public/js/explorer.js',
      anchor: '    App.state.selection = new Set(state.visible.map((i) => i.key));',
      replacement: '    App.state.selection = new Set(state.items.map((i) => i.key));',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-05a：切换类型时不再把被隐藏的项踢出选中集。
       * 与 R44-04a 是**两个不同的入口**（一个是全选、一个是切筛选），
       * 合并成一条就分不清是哪条路径漏了。
       */
      name: 'R44-05a · setTypeFilter 不清理被隐藏的选中项（切类型后旧选中残留）',
      file: 'public/js/explorer.js',
      anchor: '    const vis = new Set(visibleItems().map((i) => i.key));\n    for (const k of [...App.state.selection]) if (!vis.has(k)) App.state.selection.delete(k);',
      replacement: '    void visibleItems();',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-06a：**本轮实测踩到的真事故** —— `setTypeFilter` 里写成裸 `render()`。
       *
       * `render` 是 `explorer` 对象的方法，模块作用域里没有这个自由标识符；
       * 每次点击类型都抛 ReferenceError，用户侧只看到「点了完全没反应」，
       * 界面与静态审查都毫无痕迹。与 R27-01 的裸 `currentItems()`、
       * R27-01 在 `ops.js` 里的裸 `explorer` 是同一类事故。
       * ⚠️ 这条对照是**先写护栏、护栏当场变红**抓出来的，不是事后补的。
       */
      name: 'R44-06a · 裸 render()（丢掉 explorer. 前缀，点类型即抛 ReferenceError）',
      file: 'public/js/explorer.js',
      anchor: '  explorer.render();\n}',
      replacement: '  render();\n}',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-07a：EXEC_ICON 少一个键（apk）。
       * 「查表失败静默回退默认值」是最容易漏测的形态：不报错、不空白，
       * 只是 Android 安装包显示成了 Windows 图标 —— 只有逐后缀断言才看得见。
       */
      name: 'R44-07a · EXEC_ICON 丢掉 apk 键（Android 包静默显示成 Windows 图标）',
      file: 'public/js/util.js',
      anchor: "const EXEC_ICON = { exe: 'fic-exe', msi: 'fic-exe', com: 'fic-exe', apk: 'fic-apk', ipa: 'fic-ipa', hpkg: 'fic-hpkg' };",
      replacement: "const EXEC_ICON = { exe: 'fic-exe', msi: 'fic-exe', com: 'fic-exe', ipa: 'fic-ipa', hpkg: 'fic-hpkg' };",
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-08a：FILE_TYPES 里把图片与视频调换顺序。
       * 顺序是需求明文给定的（全部、图片、视频、音频、文档、压缩包、可执行文件），
       * 且侧栏渲染顺序直接取自这个数组 —— 只有断言顺序才挡得住「顺手排个序」。
       */
      name: 'R44-08a · FILE_TYPES 调换图片/视频顺序（侧栏顺序与需求不符）',
      file: 'public/js/util.js',
      anchor: "  { id: 'image', label: '图片', icon: 'fic-image' },\n  { id: 'video', label: '视频', icon: 'fic-video' },",
      replacement: "  { id: 'video', label: '视频', icon: 'fic-video' },\n  { id: 'image', label: '图片', icon: 'fic-image' },",
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-09a：`iconHtml` 绕过 `iconIdOf` 直接查 TYPE_ICON。
       * 后果是**两类图标一起丢**：文件夹拿不到 `fic-folder`，
       * 可执行文件的四套系统图标也全塌成 `fic-other` —— 而页面依然"有图标"，
       * 只是全是灰的，肉眼很容易当成设计如此。
       */
      name: 'R44-09a · iconHtml 绕过 iconIdOf（文件夹 + 四套系统图标一起塌成 other）',
      file: 'public/js/util.js',
      anchor: '  return `<svg class="fic" viewBox="0 0 1024 1024" aria-hidden="true"><use href="#${iconIdOf(item)}"></use></svg>`;',
      replacement: '  return `<svg class="fic" viewBox="0 0 1024 1024" aria-hidden="true"><use href="#${TYPE_ICON[item.type] || \'fic-other\'}"></use></svg>`;',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-10a：文件夹细分判据整条撤掉（`item.type === 'exec'` → `false`）。
       * exec 是「同类型再按扩展名细分」的唯一一处，撤掉它四套系统图标全部塌成默认。
       */
      name: 'R44-10a · iconIdOf 撤掉 exec 分支（四套系统图标塌成默认 Windows 图标）',
      file: 'public/js/util.js',
      anchor: "  if (item.type === 'exec') {",
      replacement: '  if (false) {',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-11a：精灵图里把某个 `<symbol>` 的 id 改坏（= JS 引用了一个不存在的图标）。
       *
       * 这是本轮**最隐蔽**的形态：浏览器对 `<use href="#不存在">` 既不报错也不警告，
       * 只是画一片空白。没有双向覆盖断言的话，只能靠人盯着某一行看半天。
       */
      name: 'R44-11a · 精灵图 fic-hpkg 的 id 改坏（JS 引用不存在的图标，静默空白）',
      file: 'public/index.html',
      anchor: '<symbol id="fic-hpkg" viewBox="0 0 1024 1024">',
      replacement: '<symbol id="ficx-hpkg" viewBox="0 0 1024 1024">',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-12a：把图片的底色改成文档的蓝（「统一成一个蓝色更清爽」）。
       * 底色是 ico.txt 逐类规定的，改一处就是「图片和文档长得一样」，
       * 而列表里最依赖底色的恰恰是这种同形状不同类的区分。
       */
      name: 'R44-12a · 图片底色改成文档的蓝（同形状不同类的区分全丢了）',
      file: 'public/index.html',
      anchor: '<symbol id="fic-image" viewBox="0 0 1024 1024"><rect x="0" y="0" width="1024" height="1024" rx="200" fill="#00a672"/>',
      replacement: '<symbol id="fic-image" viewBox="0 0 1024 1024"><rect x="0" y="0" width="1024" height="1024" rx="200" fill="#3f6dcb"/>',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-13a：`filetype.js` 自己过滤一遍（「侧栏顺手把自己那份也算好」）。
       * 与 explorer 的过滤规则分叉：这里只按类型、忘了排除文件夹（或反过来），
       * 于是侧栏计数与列表行数永远差一点，且永远没人发现。
       */
      name: 'R44-13a · filetype.js 自己过滤一遍（过滤点分叉，计数与列表对不上）',
      file: 'public/js/filetype.js',
      anchor: '    const items = explorer.allItems();',
      replacement: '    const items = explorer.allItems().filter((i) => !i.isFolder);',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R44-14a：`resetMainView` 不再清筛选值。
       * 换账号 / 换桶时，上一个会话的筛选会被带进新会话 —— 新账号一进来
       * 看到的是一个"被滤空"的目录，只有一两样东西，像是数据丢了。
       */
      name: 'R44-14a · resetMainView 不再清 typeFilter（换账号后目录像空的）',
      file: 'public/js/main.js',
      anchor: "  App.state.typeFilter = '';",
      replacement: '  void 0;',
      testFile: 'audit44-regressions.test.js',
      minFail: 1,
    },

    /* ================================================================== *
     * R45 —— S3 兼容协议接入 UCloud（US3）（1.6.7 → 1.6.8）
     *
     * 这一轮的风险**全部集中在「厂商差异被当成通用行为」**上，而且三种形态都
     * 不报错、不崩溃，只是「某个操作在某一家厂商上必失败」：
     *   ① 容量限制只处理了用户点名的那条（1GB），漏掉官方同页并列的另外两条
     *      —— 尤其 CopyObject 的 **100MB**（项目原先"未声明的 S3 厂商服务端复制
     *      不受大小限制"的假设，对 US3 直接不成立）；
     *   ② 定长分片被当成「下限」而不是「钉死的值」（30GB 的文件算成 9MB 分片）；
     *   ③ 厂商开关随手跟着别家开 / 忘了传（forcePathStyle 与定长分片都属此类，
     *      与 R26-05 的 MinIO、R42/R43 的华为云完全同型）。
     * 每条对照都打在「**撤掉这个修复，用户侧就会复现**」的那一处。
     * ================================================================== */

    {
      /*
       * R45-01a：前端 ORDER 把 UCloud 挪到又拍云**之后**。
       * 需求逐字点名了位置（「UCloud 需要在七牛云和又拍云之间」），而顺序在界面上
       * 是唯一的呈现 —— 挪错不会报错，只是选择器里排错。
       */
      name: 'R45-01a · 前端 ORDER 把 UCloud 挪到又拍云之后（需求点名了位置）',
      file: 'public/js/provider-logos.js',
      anchor: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'ucloud', 'upyun',",
      replacement: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'upyun', 'ucloud',",
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /* R45-01b：注册表里的厂商 id 拼错一位 —— 厂商从列表里整个消失，位置断言同时失守。 */
      name: 'R45-01b · 注册表里 ucloud 的 id 拼错一位（厂商凭空消失）',
      file: 'server/providers.js',
      anchor: "    id: 'ucloud',",
      replacement: "    id: 'uclodu',",
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-01c：UCloud 跟着 MinIO 一起走虚拟主机风格（删掉 forcePathStyle）。
       *
       * ⚠️ 这是本轮**最隐蔽**的一条：官方明说除少数地域外，virtual host style 的
       * https「will be supported in the future」，而本项目一律走 https。
       * 漏掉它的表现是「密钥正确、桶也存在，但每个请求都失败」—— 与 R26-05 的
       * MinIO 同型，归因完全看不出来。
       */
      name: 'R45-01c · UCloud 走虚拟主机风格（https 下多数地域尚未支持，静默连不上）',
      file: 'server/providers.js',
      anchor: "    forcePathStyle: true,\n    credentialLabel: {\n      id: 'API 公钥',",
      replacement: "    credentialLabel: {\n      id: 'API 公钥',",
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /* R45-02a：单请求上限被「顺手」放大到 5GB（AWS 的值）—— 1GB 那条限制随即失守。 */
      name: 'R45-02a · putObjectMaxBytes 被改成 5GB（1GB 的限制失守）',
      file: 'server/providers.js',
      anchor: '    putObjectMaxBytes: 1024 * 1024 * 1024,',
      replacement: '    putObjectMaxBytes: 5 * 1024 * 1024 * 1024,',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-02b：定长分片被改成 5MB（把它当成「≥5MB 的下限」，与 AWS 的协议下限混淆）。
       * 分清这两者正是本轮的核心：US3 要的是**恰好 8MB**。
       */
      name: 'R45-02b · fixedPartBytes 被当成下限改成 5MB（US3 要的是恰好 8MB）',
      file: 'server/providers.js',
      anchor: '    fixedPartBytes: 8 * 1024 * 1024,',
      replacement: '    fixedPartBytes: 5 * 1024 * 1024,',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /* R45-02c：分片数上限记错（10000 → 5000），单文件天花板随之腰斩。 */
      name: 'R45-02c · 分片数上限记成 5000（单文件天花板腰斩）',
      file: 'server/providers.js',
      anchor: 'const PART_COUNT_MAX = 10000;',
      replacement: 'const PART_COUNT_MAX = 5000;',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-02d：`copyNeedsSlice` 丢掉「厂商声明了上限」这一分支 —— 即**退回旧实现**
       * （「未声明的 S3 兼容厂商服务端复制不受大小限制」）。US3 上重命名 / 移动
       * 100MB~5GB 的对象会重新变成必失败，而本项目其余厂商行为不变。
       *
       * R49 改锚：判据从「①声明上限 ②isCos 且 >5GB」两段收敛成**一条规则**
       * （腾讯云的 5GB 改成注册表上的 `copyObjectMaxBytes` 声明），所以「丢掉厂商
       * 声明分支」现在的等价变异就是把唯一的返回式换成 `return false;`。
       */
      name: 'R45-02d · copyNeedsSlice 丢掉厂商声明分支（退回「一律单请求复制」）',
      file: 'server/providers.js',
      anchor: '  return Number.isFinite(declared) && declared > 0 ? n > declared : false;',
      replacement: '  return false;',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-03a：客户端工厂**漏传** `fixedPartBytes`。
       *
       * 这是与「注册表元数据」「s3-client 判据」并列的第三个可被独立摘掉的地方 ——
       * 只钉住前两处的话，`s3.js` 里少传一个字段照旧全绿，而线上表现是
       * 「US3 的分块复制发 64MB 分片、被 400 拒绝」。与 R26-05 对 forcePathStyle
       * 的用法同型。
       */
      name: 'R45-03a · s3.createClient 漏传 fixedPartBytes（分块复制必被 400 拒绝）',
      file: 'server/s3.js',
      anchor: '    fixedPartBytes: providers.fixedPartBytes(pid),\n  });',
      replacement: '  });',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-03b：`sliceCopyFile` 丢掉厂商定长值（回落到本实现的 64MB 默认分片）。
       * 「值传下来了、但取值顺序把它盖住」—— 与 R26-05 的 `_virtualHosted()` 同类：
       * 光断言字段存在是抓不到的，必须真跑一次分块复制看**发出的分片边界**。
       */
      name: 'R45-03b · sliceCopyFile 丢掉厂商定长值（发 64MB 分片而非 8MB）',
      file: 'server/s3-client.js',
      anchor: 'Number(params.PartSize) || this.fixedPartBytes || 64 * 1024 * 1024',
      replacement: 'Number(params.PartSize) || 64 * 1024 * 1024',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-04a：magic 上限从「与厂商定长取大」改成「取小」。
       * 5MB 是对 US3 **非法**的分片尺寸（它要 8MB），结果就是「开了 magic 之后
       * US3 的大文件传不动、关掉就正常」。
       */
      name: 'R45-04a · magicChunkCap 改成取小（算出对 US3 非法的 5MB 分片）',
      file: 'server/routes/fs.js',
      anchor: '  return Math.max(MAGIC_CHUNK_MAX, providers.fixedPartBytes(provider));',
      replacement: '  return Math.min(MAGIC_CHUNK_MAX, providers.fixedPartBytes(provider));',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-04b：分片尺寸不再钉死厂商值（退回「按体积浮动的算式」）。
       * 1GB 的文件仍**恰好**是 8MB ⇒ 小文件照样能传；30GB 算成 9MB ⇒ 大文件必 400。
       * 这正是「最容易被误判成网络问题」的那种回归。
       */
      name: 'R45-04b · 分片尺寸不再钉死厂商值（30GB 文件算出 9MB 分片必 400）',
      file: 'server/routes/fs.js',
      anchor: '      const plainChunkFinal = fixedPart > 0 ? fixedPart : plainChunk;',
      replacement: '      const plainChunkFinal = plainChunk;',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-04c：直传分界不再受厂商上限约束（去掉取小）。
       * 今天它是个 no-op（项目阈值 8MB < 1GB），但摘掉它之后，
       * 「超过厂商上限一定走分片」就从「结构上的结论」退回「当下的巧合」——
       * 而这条正是用户本轮点名要保证的。
       */
      name: 'R45-04c · 直传分界不再受厂商上限约束（回到「碰巧没事」）',
      file: 'server/routes/fs.js',
      anchor: '      providers.putObjectMaxBytes(cfg.provider)',
      replacement: '      Infinity',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R45-04d：目录 MOVE 的复制路径退回旧的 5GB 阈值。
       * 「三条复制路径，改了一条漏两条」—— 目录 MOVE 是重命名大目录的**唯一**
       * 入口，漏掉它意味着整目录移动在 US3 上失败。
       */
      name: 'R45-04d · 目录 MOVE 的复制路径退回旧 5GB 阈值（漏掉第三条路径）',
      file: 'server/fs-gateway.js',
      anchor: '        const large = providers.copyNeedsSlice(cfg.provider, it.size);',
      replacement: '        const large = Number(it.size || 0) > 5 * 1024 * 1024 * 1024;',
      testFile: 'audit45-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R46-01a：`deriveRegionFromHost` 漏认 `ufileos.com` —— 即**本次修复前的真实状态**。
       *
       * 撤掉 `|ufileos` 后，UCloud 的默认端点 `https://s3-cn-bj.ufileos.com` 反推不出地域，
       * 签名地域退回兜底的 `us-east-1`：请求打到 cn-bj 的主机上、凭证作用域却写着
       * us-east-1，云端返回**合法但为空**的桶列表 ⇒ 界面「获取成功，共 0 个存储桶」，
       * 且换 API 密钥还是 US3 令牌都一样（与权限无关）。
       *
       * 判据落在**实际发出去的 `Authorization` 头**的凭证作用域上，而不是 `client.region`
       * —— 地域最终是以那一串的形式被执行、被云端读取的（R38-01f 的教训：光源码有、
       * 不等于跑起来是那样）。
       */
      name: 'R46-01a · deriveRegionFromHost 漏认 ufileos.com（UCloud 签名地域退回 us-east-1）',
      file: 'server/s3-client.js',
      anchor: 'backblazeb2|ufileos',
      replacement: 'backblazeb2',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },

    /* ==== R47 · 操作即时生效 / 刷新回到原页 / 刷新键交还浏览器（用户报告三条） ==== */

    {
      // 用户报的「按 F5 没有作用」就是这个分支：抢走浏览器刷新键、只重取文件列表，
      // 于是用户只能改用工具栏那颗按钮做整页重载。
      name: 'R47-01a · 刷新键又被拦截（用户按刷新键"没有作用"的原始形态）',
      file: 'public/js/main.js',
      anchor: "    } else if (e.key === 'Enter' && s.selection.size === 1) { explorer.openItem([...s.selection][0]); }",
      replacement: "    } else if (e.key === 'F5') { e.preventDefault(); explorer.refresh(); }\n    else if (e.key === 'Enter' && s.selection.size === 1) { explorer.openItem([...s.selection][0]); }",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 右键菜单恢复「刷新 F5」标注 —— 该键现在是整页重载，提示与实际行为不符。
      name: 'R47-01c · 右键菜单重新宣称刷新键（提示与实际行为不符）',
      file: 'public/js/explorer.js',
      anchor: "    items.push({ text: '刷新列表', onClick: () => explorer.refresh() });",
      replacement: "    items.push({ text: '刷新', k: 'F5', onClick: () => explorer.refresh() });",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 角色门控被摘 → 普通用户把地址栏改成 #ordermgr 就能直接进管理员页。
      // 判据只允许读 `renderUserMenu()` 写下的 hidden，正是为了让这条越权无从发生。
      name: 'R47-02b · 地址栏记忆不再看角色的可见性（改 hash 即可进管理员页）',
      file: 'public/js/main.js',
      anchor: "    if (!el || el.hidden) return 'explorer';",
      replacement: "    if (!el) return 'explorer';",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 改用 location.hash 赋值 → ① 污染历史（与 ← → 的文件浏览历史打架）；
      // ② 派发 hashchange 把自己又绕回 switchMainView（多余的一次重复刷新）。
      // ⚠️ anchor 只取**代码行**：`invariants.test.js` 的「anchor 必须命中」是**双侧剥注释**
      // 之后比对的，跨注释行的 anchor 会在那里报「未命中」（本轮第一版就踩了）。
      name: 'R47-02c · 回写地址栏改用 location.hash 赋值（污染历史 + 触发自身 hashchange）',
      file: 'public/js/main.js',
      anchor: "  const target = v === 'explorer' ? location.pathname + location.search : '#' + v;",
      replacement: "  const target = location.hash;\n  if (v === 'explorer') location.hash = ''; else location.hash = v;",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 启动不再按地址栏恢复 → 刷新永远回到文件浏览（用户报的缺陷 ② 原样复现）。
      name: 'R47-02d · 启动不再按地址栏恢复页面（刷新一律回到文件浏览）',
      file: 'public/js/main.js',
      anchor: "  const startView = viewFromHash();\n  await loadConfig(true);",
      replacement: "  const startView = 'explorer';\n  await loadConfig(true);",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 登出只复位内存状态、不清地址栏 → 地址栏仍挂着管理页，刷新或换账号照着重放
      //（与 resetMainView 头部那条越权原因同源）。anchor 只取代码行，理由同 R47-02c。
      name: 'R47-02e · 登出不复位地址栏（管理页 hash 残留，换账号照着重放）',
      file: 'public/js/main.js',
      anchor: "  writeViewHash('explorer');",
      replacement: '  void 0;',
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // hashchange 监听未注册 → 手工改地址栏（或浏览器前进后退）不再有任何反应。
      name: 'R47-02f · hashchange 监听未注册（手工改地址栏没有反应）',
      file: 'public/js/main.js',
      anchor: "  bindViewHash();\n  // R47：写操作成功后自动同步界面（消除「必须刷新才看到生效结果」）",
      replacement: "  // R47：写操作成功后自动同步界面（消除「必须刷新才看到生效结果」）",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 写成功不再通知界面 —— 即本轮修复前的真实状态（跨区块陈旧，只能靠手动刷新）。
      name: 'R47-03a · 写成功后不再通知界面（"必须刷新才生效"的原样复现）',
      file: 'public/js/api.js',
      anchor: "  notifyWrite(method, path);\n  return data;",
      replacement: "  return data;",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 豁免判据整条失效 → 连**读**请求也通知：一次页面加载就会自激式反复整轮刷新。
      name: 'R47-03b · 豁免判据整条失效（读请求也通知 → 页面加载自激刷新）',
      file: 'public/js/api.js',
      anchor: "  if (!writeObserver) return;\n  if (isWriteExempt(method, path)) return;",
      replacement: "  if (!writeObserver) return;",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // ⚠️ 这条复现的正是**我自己在本轮写第一版时踩到的坑**：把 `/api/payment/config`
      // 当整段前缀豁免，于是同前缀的 `PUT /api/payment/config/<平台>`（真正的保存）
      // 一起被豁免 —— 「验证能过、保存不生效」，且因为表面上"配置都对"极难排查。
      // 两步变异：把条目退化成无 suffix，再把匹配退化成 startsWith。
      name: 'R47-03c · 支付渠道「验证」的豁免范围被扩到整个前缀（真保存也被一起豁免）',
      file: 'public/js/api.js',
      mutations: [
        {
          anchor: "  { path: '/api/payment/config', suffix: '/validate', why: '① 支付渠道「验证」探针（同前缀的 PUT 是保存，不在此列）' },",
          replacement: "  { path: '/api/payment/config', why: '① 支付渠道「验证」探针' },",
        },
        {
          anchor: '    : path === e.path));',
          // ⚠️ 括号数必须与原串一致：`startsWith(` 多了一个开括号，因此补一个闭括号。
          // 第一版漏了它 → 变异体语法错误 ⇒ 整个 api.js 加载失败 ⇒ 该文件所有用例一起变红，
          // `fail=10` 看起来"通过"，红的却不是这条用例判据（正是本项目反复强调的
          //「fail>=minFail 不说明红的是哪条」）。登记前的实跑 + 看名单才把它抓出来。
          replacement: '    : path.startsWith(e.path)));',
        },
      ],
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 失败也通知（并且连错误都不抛了）→ 界面会为一次**没有发生**的变更去整轮刷新。
      name: 'R47-03d · 写请求失败也通知界面（错误也没被抛出）',
      file: 'public/js/api.js',
      anchor: "    throw err;\n  }\n  // R47：写请求**成功**后通知界面同步。",
      replacement: "  }\n  // R47：写请求**成功**后通知界面同步。",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 同步不重拉配置快照 → 侧边栏 / 状态栏仍是旧值（R29-02 那类「必须按 F5」的缺口）。
      name: 'R47-04a · 同步不重拉配置快照（侧边栏 / 状态栏仍旧）',
      file: 'public/js/main.js',
      anchor: "    await loadConfig(false);\n    loadEncState(); // 非 async：内部两个请求自带 catch，不需要等",
      replacement: "    loadEncState(); // 非 async：内部两个请求自带 catch，不需要等",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 只刷文件列表、不刷当前区块 → 停在设置页时改完设置仍看不到生效（缺陷 ① 的一种）。
      name: 'R47-04b · 同步只刷文件列表（停在其它区块时改完看不到生效）',
      file: 'public/js/main.js',
      anchor: "    if (App.state.mainView === 'explorer') await explorer.refresh({ silent: true });\n    else switchMainView(App.state.mainView, { syncHash: false });",
      replacement: "    await explorer.refresh({ silent: true });",
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 去抖被摘 → 一次批量操作（上传一批文件）会连发几十次整轮刷新。
      name: 'R47-04c · 去抖被摘（批量写请求逐条整轮刷新）',
      file: 'public/js/main.js',
      anchor: '  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);',
      replacement: '  syncNow();',
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // 两处重入保护同时摘掉 → 同步进行中的写请求会与同步**并发**（同一份界面被并行重建）。
      name: 'R47-04e · 重入保护被摘（同步中的写请求与同步并发）',
      file: 'public/js/main.js',
      mutations: [
        {
          anchor: '  if (syncing) { syncPending = true; return; }\n  if (syncTimer) clearTimeout(syncTimer);',
          replacement: '  if (syncTimer) clearTimeout(syncTimer);',
        },
        {
          anchor: '  if (syncing) { syncPending = true; return; }\n  syncing = true;',
          replacement: '  syncing = true;',
        },
      ],
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // ⚠️ 反向变异**必须真的把那句调用摘掉**：写成注释会**被自己的断言满足**
      //（护栏是按 includes 查那个函数名字符串的），于是 fail=0 —— 本项目反复踩过的
      //「判据落在注释上 = 假绿」。这里直接换成一句空语句。
      name: 'R47-05 · 写观察者未注册（整套同步是死代码）',
      file: 'public/js/main.js',
      anchor: "  bindViewHash();\n  // R47：写操作成功后自动同步界面（消除「必须刷新才看到生效结果」）\n  setWriteObserver(onServerWrite);",
      replacement: '  bindViewHash();\n  void 0;',
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    /* ---------------- R48 · 多线程加密 / 多文件并发 / 收入统计 ---------------- */
    {
      // 本轮要修的**原缺陷本体**：CPU 密集的那一步在主线程同步跑（5MB 约占住事件循环 330ms）。
      // 退回去就是把 await 的异步入口换回同步入口 —— 护栏 A7 必须变红。
      name: 'R48-01a · 整文件加密退回主线程同步入口（事件循环被阻塞的原样复现）',
      file: 'server/fs-gateway.js',
      anchor: '  const enc = await encStore.encryptBufferAsync(cfg.bucket, k, plainBuf);',
      replacement: '  const enc = encStore.encryptBuffer(cfg.bucket, k, plainBuf);',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 分片路径（48MB 一片，同步加密约 3 秒）同样必须走多线程入口。
      name: 'R48-01b · 分片加密退回同步 encryptPart',
      file: 'server/routes/fs.js',
      anchor: '      body = await encStore.encryptPartAsync(sess, partNumber, req.body);',
      replacement: '      body = encStore.encryptPart(sess, partNumber, req.body);',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 线程数不再收敛到 [1, min(8, 核数-1)] —— 用户在界面上填 1000 就真的会去建 1000 个线程。
      name: 'R48-01c · 线程数不再收敛（填多少就起多少）',
      file: 'server/enc-pool.js',
      anchor: '  return Math.min(v, HARD_MAX_WORKERS, cpuBudget());',
      replacement: '  return v;',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // worker 入口就是本文件：它 require 的相对模块会在**每个线程里**再求值一次。
      // 把 config-store 拉进去 = 主线程与 N 个工作线程争同一份配置文件的读写锁。
      name: 'R48-01d · 工作线程把带副作用的模块拉进线程（并发加载 config-store）',
      file: 'server/enc-pool.js',
      anchor: "const { Worker, isMainThread, parentPort } = require('worker_threads');",
      replacement: "const { Worker, isMainThread, parentPort } = require('worker_threads');\nconst _workerCfgPeek = require('./config-store');",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 回到「并发数写死在代码里」：界面上把「线程并发」设成 1 或 5，实际都按 2 跑。
      // 这正是旧实现（`MAX_FILE_CONCURRENCY = 2`）让用户「设了没用」的形态。
      name: 'R48-02a · 并发调度写死回常量（「线程并发」设了也不起作用）',
      file: 'public/js/upload.js',
      anchor: '  return uploadPlan(App.state.uploadConcurrency);',
      replacement: '  return { fileConcurrency: 2, chunkConcurrency: 3 };',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 分片并发不再由连接预算反推：文件一多（≥3）就 3 片一起发，乘积 9 > 6 条连接上限，
      // 多出来的请求只能在浏览器里排队 —— 表现出来正是「卡住不动」。
      name: 'R48-02b · 分片并发不再按连接预算反推（乘积撑爆 6 条连接）',
      file: 'public/js/util.js',
      anchor: '  const chunkConcurrency = Math.max(1, Math.min(CHUNK_CONCURRENCY_MAX, Math.floor(CONNECTION_BUDGET / fileConcurrency)));',
      replacement: '  const chunkConcurrency = CHUNK_CONCURRENCY_MAX;',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // ⭐ 「先按大值起跑、拿到配置再收窄」——头几个文件会真的打满连接池。
      // 非法/缺失一律退回**串行** 1 才是安全侧。
      name: 'R48-02c · 非法并发值按上界起跑（不再是「保守退回串行」）',
      file: 'public/js/util.js',
      anchor: '  const fileConcurrency = Number.isFinite(n) && n >= 1\n    ? Math.min(Math.floor(n), FILE_CONCURRENCY_MAX) : 1;',
      replacement: '  const fileConcurrency = Math.min(Math.max(1, Math.floor(n) || FILE_CONCURRENCY_MAX), FILE_CONCURRENCY_MAX);',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 收入统计把 pending / failed / refunded 都算成收入 —— 页面会非常好看，数字全错。
      name: 'R48-03a · 收入统计把未支付订单也算进来',
      file: 'public/js/ordermgr.js',
      anchor: "  const paid = list.filter((o) => o && o.status === 'paid');",
      replacement: '  const paid = list.filter((o) => !!o);',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 丢掉对象键、退回按文件名归集：同名的两个对象（a/b.txt 与 a\\b.txt）被并成一行，
      // 「单文件累计收入」就此变成两个文件的合计。
      name: 'R48-03b · 收入按文件名归集（丢掉对象键，同名文件被并成一行）',
      file: 'public/js/ordermgr.js',
      anchor: "    const key = fileKey ? `k:${fileKey}` : `n:${fileName}`;",
      replacement: "    const key = `n:${fileName}`;",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 订单不再快照存储桶：历史订单的桶名只能靠「现存的分享链接」反查，链接一删就永久丢失。
      name: 'R48-03c · 订单不再快照存储桶',
      file: 'server/payment-orders.js',
      anchor: "    bucket: String(bucket || ''),",
      replacement: '',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 快照优先级被摘掉（只剩「回退到现存链接」）——桶名会随链接的改动而漂移，
      // 同一笔历史收入被记到另一个桶头上。
      name: 'R48-03d · 来源桶不再优先用订单快照（桶名随链接改动而漂移）',
      file: 'server/payment-orders.js',
      anchor: "  const fromOrder = order && order.bucket ? String(order.bucket) : '';\n  if (fromOrder) return fromOrder;",
      replacement: "  const fromOrder = order && order.bucket ? String(order.bucket) : '';\n  void fromOrder;",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 渲染函数自己再算一遍收入 —— 「上下两处统计对不上」的经典成因（第二套口径）。
      name: 'R48-03e · 渲染函数另写一份收入口径（与 computeRevenue 分叉）',
      file: 'public/js/ordermgr.js',
      anchor: '  const r = computeRevenue(orders);',
      replacement: "  const r = { totalFen: 0, refundedFen: 0, soldCount: (orders || []).filter((o) => o && o.status === 'paid').length, fileCount: 0, files: [] };",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // ⭐ 这个数决定服务端同时起多少加密线程，普通用户不该看见更不该改。
      name: 'R48-04a · 「线程并发」卡片未登记为管理员专属（普通用户可见可改）',
      file: 'public/js/syssettings.js',
      /**
       * R54 / R65 / R68 / R73 同步：名单最前面是 `'sysset-site-card', `（站点设置）、
       * `'sysset-user-card', `（用户管理）与 `'sysset-restore-card', `（订单取回，R73 起排在用户管理之后），
       * R68 又在 smtp 与 concurrency 之间插了
       * `'sysset-agreement-card', `（协议设置）—— anchor 随之带上这三个新成员；
       * 旧的写法已不在源码里 —— 不随实现迁移的话这条对照会**静默失效**
       * （既不变红也不报错，`invariants` 的 anchor 自检就是为此存在的）。
       *
       * 变异**只删「线程并发」这一项**（不再顺手删 smtp）：删两项会让 `audit48` 与
       * `audit53` 同时变红，红的就不唯一了。
       */
      anchor: "const ADMIN_ONLY_CARDS = ['sysset-site-card', 'sysset-user-card', 'sysset-restore-card', 'sysset-smtp-card', 'sysset-agreement-card', 'sysset-concurrency-card',",
      replacement: "const ADMIN_ONLY_CARDS = ['sysset-site-card', 'sysset-user-card', 'sysset-restore-card', 'sysset-smtp-card', 'sysset-agreement-card',",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求白纸黑字写着「最小为 1」：把输入框下界放宽到 0，配合后端就能填 0。
      name: 'R48-04b · 输入框最小值放宽为 0（破坏「最小为 1」）',
      file: 'public/index.html',
      anchor: '<input type="number" id="conc-files" min="1" max="16" step="1" value="3"',
      replacement: '<input type="number" id="conc-files" min="0" max="16" step="1" value="3"',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // ⭐ 把「缺失」与「非法」合并：所有**历史配置**（没有 concurrency 这一段）在升级后
      // 并发被静默降到 1。用户看到的是「升级之后上传变慢了」，而配置页显示的正好是 1 ——
      // 像是自己设的，极难排查。三种输入必须三条分支。
      name: 'R48-05a · 并发配置把「缺失」当成「非法」（老配置升级后静默降到 1）',
      file: 'server/config-store.js',
      anchor: "  if (v === undefined || v === null || v === '') return DEFAULT_CONCURRENCY_FILES;",
      replacement: "  if (v === null || v === '') return DEFAULT_CONCURRENCY_FILES;",
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    {
      // 入参不校验、直接交给归一化函数 ⇒ 用户填 0 或 "abc" 会被**静默**改成 1，
      // 界面上看着像保存成功了。必须显式 400，让用户看见自己填错了。
      name: 'R48-05b · PUT /concurrency 不再校验入参（非法值被静默归一化）',
      file: 'server/routes/enc.js',
      anchor: '    const r = parseConcurrencyInput((req.body || {}).files);',
      replacement: '    const r = { ok: true, value: Number((req.body || {}).files) };',
      testFile: 'audit48-regressions.test.js',
      minFail: 1,
    },
    /* ================================================================== *
     * R49 · 移除自签名证书（护栏 = tests/audit49-regressions.test.js）
     *
     * 本轮的反向对照有一条**共同特征**：撤掉修复后「源码里看起来仍然有 HTTPS」
     * ——旧实现的问题恰恰是「源码里看着有监听，用户拿到的是连接被拒 / 一张浏览器
     * 不认的证书」。所以判据都落在**真实子进程 + 真实 HTTP/HTTPS 请求**上，而不是
     * 源码里有没有那几行。下面每条都注明「撤掉后用户会看到什么」。
     * ================================================================== */
    {
      // 撤掉后：证书与私钥不配对也能通过校验 ⇒ 内置 HTTPS 起得来、但**每个请求都在
      // TLS 握手里断**（表现为「端口在监听、浏览器直接报错」，最难排查的一种）。
      // 判据落在正向对照上：`loadTlsCert()` 必须判「不配对」为不可用。
      name: 'R49-01 · 不再校验证书与私钥是否配对（只要文件能读就放行）',
      file: 'server/tls-cert.js',
      anchor: '    if (spki(x509.publicKey).compare(spki(crypto.createPublicKey(priv))) !== 0) {',
      replacement: '    if (false) {',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：加载证书的过程会**写盘**（旧 local-cert.js 正是「读不到/太弱就就地
      // 重签并写回」）。用户会看到自己的证书被应用悄悄改掉，而日志一切正常。
      //
      // ⚠️ minFail 只写 1 不是笔误：R49-03 的第一条断言（目录快照「不得新建文件」）
      // 会先命中并**中止该用例**，后面那条「源码里不得出现写盘 API」根本没机会执行。
      // 也就是说这一条**只证明快照判据有效**；静态判据的证据在下面 R49-02b。
      name: 'R49-02 · 加载证书时顺手写回一个缓存文件（恢复旧的写盘路径）',
      file: 'server/tls-cert.js',
      anchor: '    cert = fs.readFileSync(p.certFile);',
      replacement: '    cert = fs.readFileSync(p.certFile);\n'
        + "    fs.writeFileSync(p.certFile + '.cache', cert, { mode: 0o600 });",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 与上一条是**同一条修复的两个判据**，分开登记的原因见上：快照判据会抢先中止，
      // 于是「源码里不得出现写盘 API」这条静态判据永远得不到证据。这里把写入调用塞进
      // 一个**不可达分支**（`if (false)`）——快照看不到任何变化，只有静态判据能抓住它。
      // 若这条对照变绿，说明静态判据是个摆设（等于把「以后又有人加回写盘路径」放行了）。
      name: 'R49-02b · 在不可达分支里恢复写盘调用（只有静态判据能抓住）',
      file: 'server/tls-cert.js',
      anchor: '    cert = fs.readFileSync(p.certFile);',
      replacement: '    cert = fs.readFileSync(p.certFile);\n'
        + "    if (false) { fs.writeFileSync(p.certFile + '.bak', cert); }",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：没有证书时明文请求照样被 301 到 HTTPS ⇒ 访客落到一个**没人监听**的
      // 端口（ERR_CONNECTION_REFUSED），而启动日志一片正常。这是本轮最核心的降级。
      name: 'R49-03 · 没有证书时仍把明文请求 301 到不存在的 HTTPS 端口',
      file: 'server/index.js',
      anchor: '  if (!TLS.ok && !security.TRUST_PROXY) return next();',
      replacement: '  void 0;',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：301 目标回落成**内置**的 3443 ⇒ 反代场景（对外 443）把访客送到一个
      // 外网根本不通的端口。判据是真实 301 响应的 Location 端口。
      name: 'R49-04 · 301 跳转端口回落成内置 HTTPS_PORT（反代场景把访客送错端口）',
      file: 'server/index.js',
      anchor: 'const HTTPS_REDIRECT_PORT = Number(process.env.PUBLIC_HTTPS_PORT) || (TLS.ok ? HTTPS_PORT : 443);',
      replacement: 'const HTTPS_REDIRECT_PORT = Number(process.env.PUBLIC_HTTPS_PORT) || HTTPS_PORT;',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：即便配了证书也不起内置 HTTPS ⇒ HTTPS 端口没人监听，而日志还在说
      // 「已提供 HTTPS」。判据是真实 https 请求 + 启动日志里的监听行。
      name: 'R49-05 · 配了自备证书也不启动内置 HTTPS 监听',
      file: 'server/index.js',
      anchor: "if (TLS.ok) {\n  const httpsServer = registerServer(https.createServer({ key: TLS.key, cert: TLS.cert }, app), 'HTTPS');",
      replacement: "if (false) {\n  const httpsServer = registerServer(https.createServer({ key: TLS.key, cert: TLS.cert }, app), 'HTTPS');",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：WebDAV 失败的原因不被记录（`tlsError` 留空）⇒ 界面永远是「已启用，
      // 服务正在启动…」转圈，用户完全看不出是缺证书。这就是 R49 修的那个现象。
      //
      // ⚠️ 这里**故意不**变异 `if (!tls.ok)` 那个提前 return。试过：把它改成
      // `if (false)` 之后 WebDAV 会**真的监听成功**（`https.createServer` 拿到
      // undefined key/cert 不一定抛错），而 R49-07 用例里没有 stop —— 于是
      // `node --test` 进程因仍有监听句柄**永不退出**，整条反向对照被前台超时强杀，
      // 并在工作区留下一个 `.reversebak`（实测踩到）。变异要选「同样能证伪、但不会
      // 改变进程存活状态」的那一处。
      name: 'R49-06 · WebDAV 启动失败时不记录原因（界面永远「正在启动…」）',
      file: 'server/webdav-server.js',
      anchor: '          tlsError = `${tls.reason}；WebDAV 强制 HTTPS，因此不会启动。${hintText(tls)}。`;',
      replacement: "          tlsError = '';",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：`--tls selfsigned` 不再报错，而是被静默当成 `none` ⇒ 运维以为配好了
      // HTTPS、实际只跑 HTTP（静默降级是本轮明确要杜绝的形态）。
      name: 'R49-07 · deploy.sh 重新接受 `--tls selfsigned`（静默当成只跑 HTTP）',
      file: 'deploy.sh',
      anchor: '    selfsigned|self) die "自签名证书已在本版本移除',
      replacement: '    selfsigned|self) TLS_MODE="none" ;; # 变异：静默接受（原文余下部分被此行注释掉）',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：自备证书只判「文件存在/非空」⇒ 字段全空白的坏证书（openssl 能读、
      // nginx -t 也过，浏览器里证书信息却是一片空白）照样被认领。
      name: 'R49-08 · 自备证书不再过 cert_file_ok（只判存在就认领）',
      file: 'deploy.sh',
      anchor: '  if ! cert_file_ok "$crt" "$key"; then',
      replacement: '  if false; then',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：`selfsigned` 又回到运行时依赖里 ⇒ 这条「移除」在源头被悄悄撤销
      // （依赖回来了，下一个想用它的人立刻就找得到）。
      name: 'R49-09 · selfsigned 重新出现在 package.json 依赖里',
      file: 'package.json',
      anchor: '  "dependencies": {',
      replacement: '  "dependencies": {\n    "selfsigned": "^2.4.1",',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：纯 HTTP 部署（`--tls none`）时 `.env` 又会写出 `WEBDAV_PUBLIC_URL=http://…`
      // ⇒ 界面「服务器地址」给出一个**永远不通**的地址：WebDAV 强制 HTTPS，没有证书时
      // 它根本不会启动。这条契约是 R49 顺带更正的（audit16 的 D2-03 断言已随之改写，
      // 因此必须单独登记一条对照，否则「改写断言」等于把旧行为的护栏也一起删了）。
      name: 'R49-10 · 纯 HTTP 部署时 .env 又写出 http:// 的 WEBDAV_PUBLIC_URL',
      file: 'deploy.sh',
      anchor: '    [[ "$TLS_MODE" == "none" ]] && wd_scheme=""',
      replacement: '    [[ "$TLS_MODE" == "none" ]] && wd_scheme="http"',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * ============================================================
       * R49 第二部分：移除 COS 原生 API + `cos` → `s3` 全面改名
       * ============================================================
       * 用例名沿用**护栏测试**里的编号（`R49-10a` 看守 `audit49` 的 R49-10 用例）。
       * 注意与前面那条 `R49-10` 不同源 —— 那条看守的是 `audit16` 的 D2-03
       * （纯 HTTP 部署下的 WebDAV 公开地址），`--only=R49-10` 会同时选中两者。
       *
       * 这一段的变异分两大类，各自对应一类真实事故：
       *  - `a` 组：**改不彻底 / 半途回退**（协议通路、SDK 依赖、改名只改一半）；
       *  - `b` 组：**改过头 / 按名字而不按语义改**（厂商差异外溢、兼容别名被自己改掉）。
       * 后者是本轮最危险的形态：机械改名会让 `isCos` 与 `isS3` 等价，而它原来守着
       * 「AKID 前缀」与「5GB 上限」两条**只有腾讯云适用**的规则 —— 一旦外溢，
       * 阿里云/华为云的密钥全部保存不了、AWS 的大文件复制被平白切碎。
       */
      // 撤掉后：腾讯云退回 COS 原生协议（`kind: 'cos'`）—— 一条已经没有实现的通路。
      name: 'R49-10a · 腾讯云的 kind 退回 COS 原生协议',
      file: 'server/providers.js',
      anchor: "    kind: 's3',\n    endpoint: 'https://cos.ap-guangzhou.myqcloud.com',",
      replacement: "    kind: 'cos',\n    endpoint: 'https://cos.ap-guangzhou.myqcloud.com',",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：`isCos` 以 `isS3` 的别名形式「复活」—— 正是机械改名的产物，见上面 a/b 说明。
      name: 'R49-10b · isCos 以 isS3 的别名形式重新出现在导出表里',
      file: 'server/providers.js',
      anchor: '  list, get, resolve, isSupported, nameOf, isS3, isAzure, endpointFor,',
      replacement: '  list, get, resolve, isSupported, nameOf, isS3, isAzure, endpointFor,\n  isCos: isS3,',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：地域留空时签成 us-east-1 ⇒ 云端返回**合法但为空**的桶列表
      // ⇒ 界面「获取成功，共 0 个存储桶」。R46 的同型陷阱，腾讯云并入时差点重演。
      name: 'R49-11a · 域名清单漏掉 myqcloud（空地域签错、桶列表为空）',
      file: 'server/s3-client.js',
      anchor: "    const DOM = '(?:aliyuncs|myhuaweicloud|qiniucs|amazonaws|backblazeb2|ufileos|myqcloud)\\\\.com';",
      replacement: "    const DOM = '(?:aliyuncs|myhuaweicloud|qiniucs|amazonaws|backblazeb2|ufileos)\\\\.com';",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：R46-01 的**覆盖面闸门**少一家 —— 腾讯云不在对照表里，
      // 「空地域签名地域 == 端点烘焙地域」这条对它就等于没测。
      name: 'R49-11b · CONFORMANCE 对照表里漏登记腾讯云（覆盖面闸门失效）',
      file: 'tests/audit42-regressions.test.js',
      anchor: "  { id: 'tencent', region: 'ap-guangzhou', host: 'cos.ap-guangzhou.myqcloud.com', blankRegion: 'ap-guangzhou' },\n",
      replacement: '',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：AKID 规则变成「凡 S3 厂商都要 AKID 开头」⇒ 阿里云的 LTAI…、
      // 华为云的 HPUAA… 全部保存不了（错误提示还写着「应以 AKID 开头」）。
      name: 'R49-12a · AKID 前缀规则外溢到全部 S3 厂商（别的厂商密钥存不了）',
      file: 'server/routes/_shared.js',
      anchor: '  const prefix = providers.secretIdPrefix(pid);',
      replacement: "  const prefix = providers.isS3(pid) ? 'AKID' : '';",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：5GB 上限不再来自注册表声明，而是一刀切给所有厂商 ⇒ AWS / 阿里云
      // 超过 5GB 的复制被平白改道成分片（R45 明确决定不做，且分片更慢更易失败）。
      name: 'R49-13a · 复制分片上限一刀切给所有厂商（R45 明确不外溢）',
      file: 'server/providers.js',
      anchor: '  const declared = Number(prov.copyObjectMaxBytes);',
      replacement: '  const declared = LIMITS.COPY_SIMPLE_LIMIT;',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：未知厂商被兜到默认厂商（腾讯云）⇒ 一条**已下线的厂商 id**会凭空
      // 获得 5GB 上限。旧实现（`isCos(id) && …`）对未知 id 是 false，这里必须一致。
      name: 'R49-13b · 未知厂商兜到默认厂商（凭空获得 5GB 上限）',
      file: 'server/providers.js',
      anchor: '  const prov = get(id);\n  if (!prov) return false;',
      replacement: '  const prov = resolve(id);\n  if (!prov) return false;',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：旧名 COS_DATA_DIR 不再被读取 ⇒ 存量 `.env` 里的数据目录配置被
      // **静默忽略**，数据目录退回项目内的 data/ —— 用户看到的是「配置全没了」。
      name: 'R49-14a · 数据目录不再认旧名 COS_DATA_DIR（存量部署配置被静默忽略）',
      file: 'server/data-dir.js',
      anchor: "  const legacy = String(process.env[LEGACY_ENV] || '').trim();",
      replacement: '  const legacy = \'\';',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：兼容别名被机械替换成新名自身 ⇒ 「新旧键并存」变成同义词，迁移逻辑空转。
      // 这就是 R49 实测踩到的那次事故（把 LEGACY_ENV 的值一起改了）。
      name: 'R49-14b · 兼容别名 LEGACY_ENV 的值被改成新名（迁移空转）',
      file: 'server/data-dir.js',
      anchor: "const LEGACY_ENV = 'COS_DATA_DIR';",
      replacement: "const LEGACY_ENV = 'S3_DATA_DIR';",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：旧键 `cosmgr.*` 不再兜底 ⇒ 升级后用户的**界面偏好与预填用户名一起丢**，
      // 表现是「设置全变默认、用户名不再预填」，且没有任何报错。
      name: 'R49-15a · localStorage 旧键不再兜底（升级即丢偏好与预填用户名）',
      file: 'public/js/main.js',
      anchor: '    const old = localStorage.getItem(legacyKey);',
      replacement: '    const old = null;',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：历史键常量被写成现用名 ⇒ `readMigrating(新, 新)`，迁移分支永不触发。
      name: 'R49-15b · 历史键常量被写成现用名（别名失效）',
      file: 'public/js/main.js',
      anchor: "const LEGACY_LS_KEY = 'cosmgr.prefs.v1';",
      replacement: "const LEGACY_LS_KEY = 's3mgr.prefs.v1';",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：COS SDK 回到运行时依赖 ⇒ 「移除 COS」在源头被悄悄撤销
      // （依赖回来了，下一个想用它的人立刻找得到）。
      name: 'R49-16a · cos-nodejs-sdk-v5 重新出现在 package.json 依赖里',
      file: 'package.json',
      // R75：express 由 `^4.19.2` 钉成精确版本后锚点同步（语义不变：往依赖里塞回 cos SDK）
      anchor: '  "dependencies": {\n    "express": "4.22.3"\n  },',
      replacement: '  "dependencies": {\n    "express": "4.22.3",\n    "cos-nodejs-sdk-v5": "^2.14.0"\n  },',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：COS 专属的 `GET /<bucket>?stats` 通路复活 —— S3 协议没有这个操作，
      // 复活它只能是一段永远走不到的代码（或走不到就抛 501 的死路）。
      name: 'R49-16b · COS 专属的 ?stats 桶容量通路复活',
      file: 'server/bucket-stats.js',
      anchor: "const { getClient, providerOf, listAll } = require('./s3');",
      replacement: "const { getClient, providerOf, listAll } = require('./s3');\nfunction getBucketStatViaApi() { return null; }",
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：WebDAV 的取值助手改回 COS 时代的老名字（改名只做了一半）。
      name: 'R49-17a · WebDAV 的 requireS3 改回 requireCos（改名半途而废）',
      file: 'server/webdav/listing.js',
      anchor: 'async function requireS3() {',
      replacement: 'async function requireCos() {',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      // 撤掉后：验证码脚本 URL 的 `onload=__s3CaptchaReady` 与 window 上的回调名不一致
      // ⇒ 脚本加载完找不到回调，组件**永远渲染不出来**：一个静默的空白验证码框，
      // 且只在启用验证码的站点上出现（本地开发常常看不到）。
      name: 'R49-17b · 验证码就绪回调名与脚本 onload 不一致（静默白框）',
      file: 'public/js/main.js',
      anchor: 'window.__s3CaptchaReady = () => {};',
      replacement: 'window.__s3CaptchaReadyX = () => {};',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：`copySource()` 的形参表从四个变回三个，而调用点仍按**四个实参**传
       * ⇒ 真正的 `key` 落到 `region` 的位置上，拼出 `/<桶>/<地域>` —— 一个
       * **语法合法但指向不存在对象**的 CopySource，复制静默失败。
       *
       * 这是本轮**真实发生过**的一次收口事故（删厂商分支时顺手删了形参），
       * 抓住它的正是 `tests/azure-client.test.js` 里按四参调用的 R30 用例；
       * R49-18 把这条判据连同三处调用点的实参个数一起钉住。
       */
      name: 'R49-18a · copySource 形参表被收口改窄（key 错位成地域，复制静默失败）',
      file: 'server/s3.js',
      anchor: 'function copySource(provider, bucket, region, key) {',
      replacement: 'function copySource(provider, bucket, key) {',
      testFile: 'audit49-regressions.test.js',
      minFail: 1,
    },

    /* ---------------------------- R50 ---------------------------- */
    {
      /*
       * 撤掉后：分享页退回那枚写死的 `📄` —— 无论分享的是图片 / 视频 / 压缩包
       * 都长一个样，访问者看不出自己要点开什么。
       * 判据落在**渲染出来的 HTML** 上（真发 HTTP），不是「源码里调没调 inlineSvg」。
       */
      name: 'R50-1a · 分享页退回写死的 📄 默认图标（不再按文件类型内联）',
      file: 'server/share-routes.js',
      anchor: '      ${fileIcon}\n',
      replacement: '      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">📄</div>\n',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：`inlineSvg()` 改回 `<use href="#fic-x">` 引用雪碧。
       * **这是本轮最容易犯、也最难发现的错**：分享页是服务端渲染的独立文档，
       * 没有 `index.html` 那套雪碧，`<use>` 在那里只会画出**一片空白**，
       * 而且浏览器既不报错也不警告、控制台干干净净。
       */
      name: 'R50-1b · 内联改回 <use> 引用（分享页没有雪碧 ⇒ 静默空白）',
      file: 'server/file-icons.js',
      anchor: "    + ' aria-hidden=\"true\" focusable=\"false\">' + sym.inner + '</svg>';",
      replacement: "    + ' aria-hidden=\"true\" focusable=\"false\"><use href=\"#' + id + '\"/></svg>';",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：类型分支不再按 `fic-<type>` 取，一律回中性图 —— 分享页上
       * 图片 / 视频 / 文档全都变成「其他文件」图标，而**雪碧里符号仍在**，
       * 静态看没有任何异常。
       */
      name: 'R50-1c · 类型分支退化成一律中性图（图片/视频/文档全变「其他」）',
      file: 'server/file-icons.js',
      anchor: "  const byType = 'fic-' + type;\n  if (sp.has(byType)) return byType;",
      replacement: "  const byType = 'fic-' + type;\n  if (sp.has(byType)) return sp.has(FALLBACK_ID) ? FALLBACK_ID : '';",
      testFile: 'audit50-regressions.test.js',
      minFail: 2,
    },
    {
      /*
       * 撤掉后：`exec` 的「无专属图标 → 退 Windows 同款 `fic-exe`」这条规则没了
       * ⇒ **服务端**给 `a.msi` 回 `fic-other`，而**前端** `EXEC_ICON` 仍给 `fic-exe`：
       * 同一个文件在文件列表里是 Windows 图标、在分享页上是中性文件图标。
       * 两处各自的单测都是绿的 —— 抓住它的只有跨端逐项等值那条。
       */
      name: 'R50-1d · exec 的 msi/com 回退被去掉（前后端选图标规则漂移）',
      file: 'server/file-icons.js',
      anchor: "    if (sp.has('fic-exe')) return 'fic-exe';",
      replacement: "    if (sp.has('fic-exe')) return sp.has(FALLBACK_ID) ? FALLBACK_ID : '';",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：雪碧不可用时不再回空串，而是拼一个**空的 `<svg class="file-icon">`**
       * ⇒ 分享页上出现一个尺寸正常、内容全空的方块，而调用方的降级分支
       * （`|| '<div …>📄</div>'`）永远走不到。
       */
      name: 'R50-1e · 缺符号时返回空 SVG（降级分支失效，页面留白方块）',
      file: 'server/file-icons.js',
      anchor: "  if (!sym) return '';",
      replacement: "  if (!sym) return '<svg class=\"file-icon\"></svg>';",
      testFile: 'audit50-regressions.test.js',
      minFail: 2,
    },
    {
      /*
       * 撤掉后：4px 阈值没了 ⇒ 任何一次带轻微抖动的「点空白」都会进入框选分支。
       * 用户以为清了选择，实际选中了途经的行（而空白键的既有语义正是「清除选择」）。
       */
      name: 'R50-2a · 去掉 4px 阈值（点一下空白就会误选途经的行）',
      file: 'public/js/explorer.js',
      anchor: '    if (Math.abs(dx) < MARQUEE_THRESHOLD && Math.abs(dy) < MARQUEE_THRESHOLD) return;',
      replacement: '    if (false) return;',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：命中判据从「与选框**相交**」变成「**完全落在**选框内」——
       * 列表行宽铺满整列，于是纵向框选**一行都选不中**（用户看到的是一个
       * 拖得动、但松手后什么都没选上的选框）。
       */
      name: 'R50-2b · 命中判据改成「完全包含」（纵向框选一行都选不中）',
      file: 'public/js/explorer.js',
      anchor: "    if (!r || r.right < rect.left || r.left > rect.right) return;\n    if (r.bottom < rect.top || r.top > rect.bottom) return;",
      replacement: "    if (!r || r.left < rect.left || r.right > rect.right) return;\n    if (r.top < rect.top || r.bottom > rect.bottom) return;",
      testFile: 'audit50-regressions.test.js',
      minFail: 2,
    },
    {
      /*
       * 撤掉后：松手时不再移除选框元素 ⇒ 一个半透明的方框永远钉在页面上，
       * 且它会挡住下面那些行的点击（`pointer-events:none` 只挡指针事件，
       * 视觉上的残留是实打实的）。
       */
      name: 'R50-2c · 松手后不移除选框元素（页面上残留一个框）',
      file: 'public/js/explorer.js',
      anchor: '    marquee.el.remove();',
      replacement: '    if (false) marquee.el.remove();',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：Ctrl 框选的「基线」丢了 ⇒ 叠加变成替换，用户辛苦选出来的那批
       * 被一次 Ctrl+拖框全部冲掉（而 Ctrl 的语义恰恰是「加选」）。
       */
      name: 'R50-2d · Ctrl 框选丢掉基线（叠加变成替换）',
      file: 'public/js/explorer.js',
      anchor: '  marquee = { x0: e.clientX, y0: e.clientY, base: new Set(additive ? App.state.selection : []), el: null, moved: false };',
      replacement: '  marquee = { x0: e.clientX, y0: e.clientY, base: new Set(), el: null, moved: false };',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：点行也进入框选 ⇒ 单击 / Ctrl 点 / Shift 连选**全部失效**
       * （行的 mousedown 还没跑就被清空并开始框选），拖拽移动也跟着坏。
       */
      name: 'R50-2e · 点在行上也进入框选（单击/多选/拖拽全坏）',
      file: 'public/js/explorer.js',
      anchor: "      if (e.target.closest('.grid-item') || e.target.closest('tr[data-key]') || e.target.closest('thead')) return;",
      replacement: '      if (false) return;',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：不再排除「点在 #file-area 自己的滚动条上」⇒ 拖滚动条会被框选劫持
       * （鼠标一按一拖，页面既不滚动、反而拖出一个选框）。
       * 这一条用 `e.offsetX > clientWidth` 判定，**没有任何视觉线索**，
       * 只能在行为层验。
       */
      name: 'R50-2f · 不排除滚动条（拖滚动条被框选劫持）',
      file: 'public/js/explorer.js',
      anchor: '      if (e.offsetX > els.area.clientWidth || e.offsetY > els.area.clientHeight) return;',
      replacement: '      if (false) return;',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：链接退回 `<textarea>` —— 需求明确要求改成 div 展示。
       * 附带后果是长地址在 textarea 里只能横向滚动，扫码前的肉眼核对变难。
       */
      name: 'R50-4a · 链接退回 textarea（需求要求改为 div 展示）',
      file: 'public/js/ops.js',
      anchor: '          <div class="lr-url" id="lr-url">${escapeHtml(url)}</div>',
      replacement: '          <textarea readonly>${escapeHtml(url)}</textarea>',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：信息区少一项（「允许下载次数」）。
       * 这类「逐项列表」的漏项在界面上完全不显眼 —— 少一行没人看得出来，
       * 用户只会以为「本来就没这项」。
       */
      name: 'R50-4b · 信息区漏掉「允许下载次数」一行',
      file: 'public/js/ops.js',
      anchor: "    ['允许下载次数', maxDownloads > 0 ? maxDownloads + ' 次' : '不限制'],",
      replacement: "    ['其他', ''],",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：不再去服务端取二维码 ⇒ 弹窗里那个位置永远停在「生成中…」/「生成失败」，
       * 而**代码看起来仍然是对的**（结构、样式、布局都在，只是没有码）。
       */
      name: 'R50-4c · 不取二维码（弹窗里永远没有码）',
      file: 'public/js/ops.js',
      anchor: '      const r = await API.linkQrcode(url);',
      replacement: "      const r = { svg: '' };",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：复制按钮丢掉 `execCommand` 回退 ⇒ 在 `http://` 局域网访问下
       * （本服务最常见的部署形态，`navigator.clipboard` 不存在）点「复制」
       * 只会弹一句「复制失败，请手动选择复制」。
       */
      name: 'R50-4d · 复制丢掉 execCommand 回退（http 局域网下复制失败）',
      file: 'public/js/ops.js',
      anchor: "    const ta = document.createElement('textarea');",
      replacement: "    return false;\n    const ta = document.createElement('textarea');",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：直链的过期时间取不到值（回落到 `null` ⇒ 显示「永久有效」）——
       * 而预签名直链**不支持永久**，页面等于在撒谎。
       */
      name: 'R50-4e · 直链的过期时间写成「永久有效」（页面撒谎）',
      file: 'public/js/ops.js',
      anchor: '  const expiresAt = l ? l.expiresAt : new Date(Date.now() + effHours * 3600e3).toISOString();',
      replacement: '  const expiresAt = l ? l.expiresAt : null;',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：二维码路由不再调 `toSvg()` ⇒ 永远回 `{ svg: '' }`，
       * 弹窗里只会显示「二维码生成失败」，而 200 状态码看起来一切正常。
       */
      name: 'R50-4f · 二维码路由不生成（永远回空 svg）',
      file: 'server/routes/links.js',
      anchor: '  const svg = qrcode.toSvg(text, { scale: 6, margin: 3 });',
      replacement: "  const svg = '';",
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉后：容量边界不再拒绝 ⇒ 超长内容（预签名直链必然超限）也回 200 +
       * 空 `svg`，前端拿到之后渲染出一块**空白方块**让用户对着扫码。
       */
      name: 'R50-4g · 二维码容量超限不再如实拒绝（空白方块）',
      file: 'server/routes/links.js',
      anchor: '  if (!svg) {',
      replacement: '  if (false) {',
      testFile: 'audit50-regressions.test.js',
      minFail: 1,
    },

  /* ================================================================== *
   * 第 51 轮（R51）：①「链接创建成功」页加宽、链接一行显示完
   *                 ②多文件 / 文件夹分享（列表 + 勾选 + 50/页 + 打包）
   * ================================================================== */
    {
      name: 'R51-1a · tar 校验和字段漏掉 NUL 分隔（写法不合规范）',
      file: 'server/tar.js',
      anchor: '  buf.write(octalField(sum, 7).slice(0, 6) + \'\\0 \', 148, 8, \'ascii\');',
      replacement: '  buf.write(octalField(sum, 7).slice(0, 6) + \'  \', 148, 8, \'ascii\');',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-1b · 超过 100 字节的名字不再走 GNU L 条目（长名丢失）',
      file: 'server/tar.js',
      anchor: '  if (nameBuf.length <= NAME_MAX) return [];',
      replacement: '  if (true) return [];',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-1c · size 一律按八进制写（越过 8GiB 就被截断成错长度）',
      file: 'server/tar.js',
      anchor: '  if (n <= maxOctal) return Buffer.from(octalField(n, len), \'ascii\');',
      replacement: '  return Buffer.from(octalField(n, len), \'ascii\');',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-1d · safeName 保留 `..`（归档条目可逃出解包目录）',
      file: 'server/tar.js',
      anchor: '    if (p === \'..\') { out.pop(); continue; }',
      replacement: '    if (p === \'..\') { out.push(\'..\'); continue; }',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-1e · 目录条目不带结尾斜杠（部分工具会解成同名文件）',
      file: 'server/tar.js',
      anchor: '  const name = dir ? clean + \'/\' : clean;',
      replacement: '  const name = clean;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-1f · uid 不再置 0（把运行服务的账号写进公开归档）',
      file: 'server/tar.js',
      anchor: '  numberField(0, 8).copy(buf, 108);',
      replacement: '  numberField(1000, 8).copy(buf, 108);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2a · 实际字节比声明短时不再中止（产出能解开但尾巴是垃圾的包）',
      file: 'server/share-bundle.js',
      anchor: '      if (written !== size) throw fail;',
      replacement: '      if (written > size) throw fail;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2b · 打包时硬声明一个 Content-Length（浏览器会提前判定下载完成）',
      file: 'server/share-bundle.js',
      anchor: '  res.setHeader(\'Cache-Control\', \'no-store\');',
      replacement: '  res.setHeader(\'Cache-Control\', \'no-store\');\n  res.setHeader(\'Content-Length\', \'1024\');',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2c · writeBlock 只等 drain（客户端一取消，请求永远挂着）',
      file: 'server/share-bundle.js',
      anchor: '    dest.once(\'close\', onClose);',
      replacement: '    void onClose;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2d · 归档里不再写一级目录（解包把一堆文件倒进用户当前目录）',
      file: 'server/share-bundle.js',
      anchor: '    if (base) {',
      replacement: '    if (false) {',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2e · tar 头的 size 不取打开流之前的真实长度（被覆盖过的对象必然错位）',
      file: 'server/share-bundle.js',
      anchor: '      await writeBlock(gzip, Buffer.concat(tar.entryBlocks(inArchive, { size, mtime })));',
      replacement: '      await writeBlock(gzip, Buffer.concat(tar.entryBlocks(inArchive, { size: 0, mtime })));',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-2f · 取不到的对象不再计入 skipped（静默丢内容）',
      file: 'server/share-bundle.js',
      anchor: '      if (!opened || !opened.stream) { stats.skipped += 1; continue; }',
      replacement: '      if (!opened || !opened.stream) { continue; }',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4a · 快照不再有上限（一次分享十万文件就把元数据写爆）',
      file: 'server/routes/links.js',
      anchor: '  const room = () => shareStore.SNAPSHOT_MAX - items.length;',
      replacement: '  const room = () => 1e9;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4b · 选中的文件不存在时不再整单失败（用户事后才发现少了它）',
      file: 'server/routes/links.js',
      anchor: '    if (h.missing) return { status: 404, error: \'对象不存在或无权访问：\' + h.key };',
      replacement: '    if (false) return { status: 404, error: \'对象不存在或无权访问：\' + h.key };',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4c · collectPaths 不再去重（同一个 key 在快照里出现两次）',
      file: 'server/routes/links.js',
      anchor: '    if (!out.includes(k)) out.push(k);',
      replacement: '    out.push(k);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4d · 旧 `path` 反过来压过 `paths`（新入口被静默忽略）',
      file: 'server/routes/links.js',
      anchor: '  const raw = Array.isArray(body.paths) ? body.paths : (body.path !== undefined ? [body.path] : []);',
      replacement: '  const raw = body.path !== undefined ? [body.path] : (Array.isArray(body.paths) ? body.paths : []);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3a · 条目快照不再截断到 2000',
      file: 'server/share-store.js',
      anchor: '    if (out.length >= SNAPSHOT_MAX) break;',
      replacement: '    if (false) break;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3b · itemList 不再兼容历史单文件记录（旧链接变成空分享）',
      file: 'server/share-store.js',
      anchor: '  if (l.key) return [{ key: String(l.key), size: Number(l.size) || 0, dir: String(l.key).endsWith(\'/\') }];',
      replacement: '  if (false) return [];',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3c · listView 只在多条目时成立（单个文件夹分享没有列表与勾选）',
      file: 'server/share-store.js',
      anchor: '    listView: st.itemCount > 1 || (st.itemCount === 1 && items[0].dir),',
      replacement: '    listView: st.itemCount > 1,',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3d · view 默认也附带 items（链接管理一次请求几 MB JSON）',
      file: 'server/share-store.js',
      anchor: '  if (opts.items) v.items = items.map((it) => ({ key: it.key, size: it.size, dir: it.dir }));',
      replacement: '  v.items = items.map((it) => ({ key: it.key, size: it.size, dir: it.dir }));',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3e · create 给单一普通文件也写 items（新旧记录形状分叉）',
      file: 'server/share-store.js',
      anchor: '  if (snap.length && !singleFile) l.items = snap;',
      replacement: '  if (snap.length) l.items = snap;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-3f · displayName 多条不再写「等 N 项」（订单标题与日志认不出分享内容）',
      file: 'server/share-store.js',
      anchor: '  return `${itemName(items[0].key)} 等 ${items.length} 项`;',
      replacement: '  return itemName(items[0].key);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4e · parseSelection 不再校验快照成员（变成任意对象下载器）',
      file: 'server/share-routes.js',
      anchor: '    } else if (fileSet.has(k)) {',
      replacement: '    } else if (true) {',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4f · 勾了文件夹不再展开其后代文件（打包漏内容）',
      file: 'server/share-routes.js',
      anchor: '      for (const key of filesOfSnap) {\n        if (key.startsWith(k) && !files.includes(key)) files.push(key);\n      }',
      replacement: '      void 0;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4g · 单选一个文件也套一层 tar.gz（用户还得先解压）',
      file: 'server/share-routes.js',
      anchor: '  const useBundle = sel.files.length > 1 || sel.dirs.length > 0;',
      replacement: '  const useBundle = true;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4h · 直传的文件名取 l.fileName（多条目链接会拿到「xxx 等 N 项」）',
      file: 'server/share-routes.js',
      anchor: '          fileName: shareStore.itemName(singleKey),',
      replacement: '          fileName: l.fileName,',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4i · 列表页每页不再是 50 条',
      file: 'server/share-routes.js',
      anchor: 'const LIST_PAGE_SIZE = 50;',
      replacement: 'const LIST_PAGE_SIZE = 500;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4j · ?page= 不再夹取到合法范围（越界即空页）',
      file: 'server/share-routes.js',
      anchor: '  const page = Math.min(pages, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 1));',
      replacement: '  const page = Number.isFinite(asked) ? Math.floor(asked) : 1;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4k · 选择里没有文件时不再 404（下发一个空 tar.gz）',
      file: 'server/share-routes.js',
      anchor: '  if (!sel.files.length) {',
      replacement: '  if (false) {',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4l · 扁平列表里文件排在文件夹之前',
      file: 'server/share-routes.js',
      anchor: '    if (a.dir !== b.dir) return a.dir ? -1 : 1;',
      replacement: '    if (a.dir !== b.dir) return a.dir ? 1 : -1;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4m · 打包分支被短路（多选退化成只下发第一个文件）',
      file: 'server/share-routes.js',
      anchor: '    if (useBundle) {',
      replacement: '    if (false) {',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-4n · 惰性探测不再对列表形态短路（文件夹分享被判成已删除）',
      file: 'server/share-routes.js',
      anchor: '  if (shareStore.view(l).listView) return Boolean(l.missingAt);',
      replacement: '  if (false) return Boolean(l.missingAt);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5a · 「链接创建成功」弹窗丢掉专属宽度类名（链接又折行）',
      file: 'public/js/ops.js',
      anchor: '    cls: \'link-result-dialog\',',
      replacement: '    cls: \'\',',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5b · 提交体回到旧的单 path 字段（多选被服务端拒绝）',
      file: 'public/js/ops.js',
      anchor: '            const body = { paths: list, expiresHours: hours || null };',
      replacement: '            const body = { path: list[0], expiresHours: hours || null };',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5c · 多选时不再禁用预签名直链（签出来的只有一个文件）',
      file: 'public/js/ops.js',
      anchor: '    const singleFile = list.length === 1 && !list[0].endsWith(\'/\');',
      replacement: '    const singleFile = true;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5d · 弹窗宽度回落到默认 480px（链接一行放不下）',
      file: 'public/css/style.css',
      anchor: '.dialog.link-result-dialog { width: min(900px, 96vw); }',
      replacement: '.dialog.link-result-dialog { width: 480px; }',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5e · 链接容器回到逐字符强断（一行显示完失效）',
      file: 'public/css/style.css',
      anchor: '  white-space: nowrap; overflow-x: auto; overflow-y: hidden;',
      replacement: '  white-space: normal; word-break: break-all;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5f · 勾选不再落 sessionStorage（翻页即丢）',
      file: 'public/js/share-list.js',
      anchor: '      sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(selected)));',
      replacement: '      void STORE_KEY;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5g · 提交时不补其它页的隐藏字段（跨页勾选被丢掉）',
      file: 'public/js/share-list.js',
      anchor: '      form.appendChild(hid);',
      replacement: '      void hid;',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R51-5h · 「清空选择」只清本页（翻页后残留还在）',
      file: 'public/js/share-list.js',
      anchor: '      selected.clear();',
      replacement: '      for (var j = 0; j < boxes.length; j++) selected.delete(boxes[j].value);',
      testFile: 'audit51-regressions.test.js',
      minFail: 1,
    },
    {
      // 调用点又把统计 Transform 内联回来（即 R51 收敛掉的那第二份实现）。内联版的行为与
      // 唯一实现点**等价**，所以 PERF-06 的字节数与汇总计数断言全绿 —— 唯一会红的就是
      // 「调用点必须委托 createTrafficMeter」那一层，这正是这条护栏存在的意义：
      // 撤销收敛必须被抓到，而不是靠「两边行为碰巧一样」蒙混过去。
      name: 'R51-6a · download-stream 又内联一份统计 Transform（分工收敛被打破）',
      file: 'server/download-stream.js',
      anchor: '  const meter = createTrafficMeter({ bucket, traffic });',
      replacement: '  const statsStore = require(\'./stats-store\');\n  const { Transform } = require(\'stream\');\n  let pendingBytes = 0;\n  let lastFlushAt = Date.now();\n  const meter = new Transform({\n    transform(chunk, _enc, cb) {\n      pendingBytes += chunk.length;\n      if (traffic) traffic.bytesDown += chunk.length;\n      const now = Date.now();\n      if (now - lastFlushAt >= 1000) { lastFlushAt = now; statsStore.sampleTraffic(0, pendingBytes); statsStore.trackBucket(bucket, { down: pendingBytes }); pendingBytes = 0; }\n      this.push(chunk);\n      cb();\n    },\n    flush(cb) { if (pendingBytes) { statsStore.sampleTraffic(0, pendingBytes); statsStore.trackBucket(bucket, { down: pendingBytes }); pendingBytes = 0; } cb(); },\n  });',
      testFile: 'audit-regressions.test.js',
      minFail: 1,
    },
    {
      // 唯一实现点退回逐 chunk 上报：字节数**照样精确**（accounted 与 traffic.bytesDown 都
      // 断言通过），红的是「统计写次数应被汇总（≤2）」—— 写盘次数重新与数据量成正比，
      // PERF-06 的核心不变式被打破。
      name: 'R51-6b · 唯一实现点退回逐 chunk 统计（写盘次数随 chunk 数增长）',
      file: 'server/traffic-meter.js',
      anchor: '      if (now - lastFlushAt >= intervalMs) {',
      replacement: '      if (now - lastFlushAt >= 0) {',
      testFile: 'audit-regressions.test.js',
      minFail: 1,
    },

  /* ================================================================== *
   * 第 52 轮（R52）：①多选（文件 + 文件夹）分享入口
   *                 ②「移动」报成功实际没动
   *                 ③复制 / 粘贴（冲突逐个询问，可选「全是」）
   *                 ④分享页默认全选（含无 JS 与跨页）
   *                 ⑤分享页展示路径脱敏（抹掉分享根之上的祖先）
   *                 ⑥链接结果弹窗左右等高
   * ================================================================== */
    {
      // R52-01：多选右键菜单里那个「复制链接（N 项）」。变异后菜单**结构照旧**
      // （其它项都在、`updateOpsButtons` 也不受影响），红的是「多选这条路径上有分享入口」
      // 这一层 —— 正是 R51 只做了工具栏、漏了右键菜单的那半。
      name: 'R52-01 · 多选右键菜单丢掉「复制链接（N 项）」（分享入口又只剩工具栏）',
      file: 'public/js/explorer.js',
      anchor: '    items.push({ text: `复制链接（${sel.size} 项）`, onClick: () => ops.copyLinkSelected() });',
      replacement: '    if (false) items.push({ text: `复制链接（${sel.size} 项）`, onClick: () => ops.copyLinkSelected() });',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-02 根因①：目标**默认预选当前目录**。`fixedTarget` 只有「拖到文件夹行上」
      // 才会给，于是工具栏 / 右键进来的「移动」默认目标 == 这些文件自己的父目录，
      // 服务端 `newKey === key` 直接跳过 —— 用户看到「移动完成」，文件纹丝不动。
      name: 'R52-02a · openFolderPicker 又把当前目录当默认目标（报成功、实际没动）',
      file: 'public/js/ops.js',
      anchor: '  let selected = preselected ? fixedTarget : null;',
      replacement: '  let selected = preselected ? fixedTarget : (App.state.prefix || \'\');',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-02 根因②：`skipped` 被当成成功。服务端对「本来就在目标位置」的项回
      // `{ok:true, skipped:true}`，旧代码只筛 `!x.ok` ⇒「跳过 N 项」报成「移动完成」。
      name: 'R52-02b · 移动汇总把 skipped 算进成功（「跳过 2 项」报成「移动完成」）',
      file: 'public/js/ops.js',
      anchor: '          const moved = out.filter((x) => x.ok && !x.skipped).length;',
      replacement: '          const moved = out.filter((x) => x.ok).length;',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-02 根因③：两条守卫的**顺序**。旧实现「自身内部」在前，于是「把 src/ 移动到它
      // 自己的父目录」被报成「不能将文件夹移动到其自身内部」—— 文案讲的是一个根本没发生的
      // 错误，而「目标与源相同 ⇒ 如实回报 skipped」对**文件夹**永远不可达。
      name: 'R52-02c · /fs/move 两条守卫顺序颠倒（文件夹原地移动被判成「自身内部」）',
      file: 'server/routes/fs.js',
      anchor: '        if (newKey === key) return { path: key, ok: true, skipped: true };\n'
        + '        if (isFolder && newKey.startsWith(key)) throw badRequest(\'不能将文件夹移动到其自身内部\');',
      replacement: '        if (isFolder && newKey.startsWith(key)) throw badRequest(\'不能将文件夹移动到其自身内部\');\n'
        + '        if (newKey === key) return { path: key, ok: true, skipped: true };',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：「先问、再写」。云端覆盖不可撤销，冲突必须交给用户决策而不是默认覆盖。
      name: 'R52-03a · 复制遇到同名项不再先问，直接按覆盖写（云端覆盖不可撤销）',
      file: 'server/routes/fs.js',
      anchor: '      const d = decisions ? decisions[p.key] : null;',
      replacement: '      const d = \'overwrite\';',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：目标存在性探测。`headSize()` 那份实现把「不存在」与「大小恰好是 0」
      // 塌缩成同一个 0，0 字节对象（文件夹标记）恰恰最需要被认出来 —— 故存在性单独一个函数。
      name: 'R52-03b · 目标存在性探测恒为「不存在」（同名冲突永远探测不到）',
      file: 'server/routes/fs.js',
      anchor: '    return true;\n'
        + '  } catch (e) {\n'
        + '    if (isNotFoundError(e)) return false;',
      replacement: '    return false;\n'
        + '  } catch (e) {\n'
        + '    if (isNotFoundError(e)) return false;',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // ★ R52-03：复制路径**必须**关掉 `copyBatch` 的内部回滚。它删的是「本次复制成功的
      // 目标键」，那是给 rename / move 准备的（那两条路径预先把一切冲突都拒了，故
      // 「复制成功的键」⊆「本次新建的键」）。复制**允许覆盖**，于是 `copied` 里会混进
      // 目标侧本来就有的对象 —— 全删就是 R11-03 / R12-02 那个不可逆事故。
      name: 'R52-03c · 复制路径又打开 copyBatch 内部回滚（连带删掉被覆盖的目标侧既有对象）',
      file: 'server/routes/fs.js',
      anchor: '      await copyBatch(client, cfg, tasks, 5, { reconcile: true, rollback: false });',
      replacement: '      await copyBatch(client, cfg, tasks, 5, { reconcile: true, rollback: true });',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：用户确认「与资源管理器一致」里的那个「全是」—— 勾上之后不再逐个弹窗。
      name: 'R52-03d · 冲突询问的「对后续全部冲突执行相同选择」不再生效（还得一项项点）',
      file: 'public/js/ops.js',
      anchor: '      if (r.all) carry = action;',
      replacement: '      if (false) carry = action;',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：冲突询问的三个出口。`finish()` 必须**先于** `close()`：
      // `openModal` 的 `close()` 会触发 `onClose`，而 `onClose` 兜的是「ESC / ✕ / 遮罩」
      // 那条路径（一律按取消处理）。顺序颠倒时先 resolve 的会是「取消」，用户点的按钮白点。
      name: 'R52-03e · 冲突询问先 close 再 finish（用户点的「覆盖」被 onClose 的「取消」抢先）',
      file: 'public/js/ops.js',
      anchor: '        { text: \'覆盖\', cls: \'primary\', onClick: (o, close) => { const all = wrap.querySelector(\'#cp-all\').checked; finish({ action: \'overwrite\', all }); close(); } },',
      replacement: '        { text: \'覆盖\', cls: \'primary\', onClick: (o, close) => { const all = wrap.querySelector(\'#cp-all\').checked; close(); finish({ action: \'overwrite\', all }); } },',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：默认全选要在**无 JS** 时也成立，故 `checked` 由服务端渲染。
      // 只靠脚本在加载后勾上，一旦脚本被拦（CSP 之外的拦截、老浏览器），
      // 页面就是"一个都没勾"——而「下载选中」按钮点下去什么都不会发生。
      name: 'R52-04a · 分享页不再服务端渲染 checked（脚本被拦时退化成「一个都没勾」）',
      file: 'server/share-routes.js',
      anchor: '        <input type="checkbox" name="k" value="${esc(item.key)}" checked>',
      replacement: '        <input type="checkbox" name="k" value="${esc(item.key)}">',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：整份快照清单（`#sl-keys`）。默认全选是**跨页**语义 —— 没有它，
      // 脚本只能算出"本页这些框"，第 2 页及以后的文件在用户什么都不做时不会被下载。
      name: 'R52-04b · 不再下发整份快照清单（默认全选退化成「只选本页」）',
      file: 'server/share-routes.js',
      anchor: '  const keysJson = `<script type="application/json" id="sl-keys">${',
      replacement: '  const keysJson = `<script type="application/json" id="sl-snapshot">${',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：⚠️ 这是本轮协议里唯一一处反直觉的地方。`mode=exclude` 下 `k` 的语义会
      // 从「要选的」翻转成「要排除的」，而页面里那些**已勾选**的复选框**一定**会随表单
      // 提交成 `k` —— 混进排除集，用户**正要下载**的文件反而被排除掉。
      name: 'R52-04c · 排除集又复用 `k` 字段名（本页已勾的文件反被排除）',
      file: 'public/js/share-list.js',
      anchor: '      extraName = \'x\'; // ⚠️ 见上：排除集必须与表单自动提交的 `k` 分开',
      replacement: '      extraName = \'k\';',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：默认全选落在**整份快照**上（跨页），否则第 1 页点「下载选中」只拿到 50 项。
      name: 'R52-04d · 默认全选只覆盖本页（跨页那部分用户什么都没做却下不到）',
      file: 'public/js/share-list.js',
      anchor: '  const selected = stored || new Set(allKeys);',
      replacement: '  const selected = stored || new Set(boxes.map(function (b) { return b.value; }));',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：用户「清空选择」后提交，`k` 形态会**一个 `k` 也不发** —— 而服务端把
      // 「既没有 `k` 也没有 `mode`」读成"整条分享"（那正是无 JS 列表页与「打包下载全部」
      // 的形态）。于是清空后点下载会拿到全部，与他刚做的操作正好相反。
      name: 'R52-04e · 清空选择后提交退化成「什么都不带」（被服务端读成「全选」）',
      file: 'public/js/share-list.js',
      anchor: '    } else if (snapshot.complete && (kFormCount === 0 || offDeselected.length < kFormCount)) {',
      replacement: '    } else if (snapshot.complete && offDeselected.length < kFormCount) {',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-04：排除集走独立字段名 `x`，服务端就得**只认 `x`**。读回 `k` 的话，
      // 一条只带 `x` 的请求在服务端变成「没带排除集」⇒ 落进「全选」分支，
      // 用户取消掉的文件**照样**会被下载（还会静默成 200，连报错都没有）。
      name: 'R52-04f · 服务端把排除集读成 `k`（取消掉的文件照样下发）',
      file: 'server/share-routes.js',
      anchor: '  const exRaw = query ? query.x : undefined;',
      replacement: '  const exRaw = query ? query.k : undefined;',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-05：共同祖先**本身就是被选中的那个目录** ⇒ 只抹它之上，保留它自己的名字。
      // 连它一起抹会让行名变成空串（`photos/2024/` 被抹成 `''`、子文件被抹成 `a.jpg`），
      // 于是「我分享的那个文件夹」在页面上消失。注意这条对 `photos/a.jpg` 这类
      // 「祖先只是容器」的情形**必须**照抹 —— 两个分支不能合并。
      name: 'R52-05a · 公共祖先是被选中的目录时把它也抹掉（被分享的那层名字消失）',
      file: 'server/share-store.js',
      anchor: '  if (dirSelves.has(ancestor)) return common.slice(0, -1).join(\'/\');',
      replacement: '  if (false) return common.slice(0, -1).join(\'/\');',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-05：列表行显示的是**展示名**，复选框 `value` 仍是原始 key。
      // 两者混同有两个方向都错：行内用原始 key ⇒ 隐私照旧泄露；
      // 复选框用展示名 ⇒ `parseSelection` 在快照里找不到它，整单 400。
      name: 'R52-05b · 列表行退回原始 key（分享根之上的祖先又暴露给别人）',
      file: 'server/share-routes.js',
      anchor: '        <span class="sl-name${item.dir ? \' dir\' : \'\'}">${esc(shown || item.key)}</span>',
      replacement: '        <span class="sl-name${item.dir ? \' dir\' : \'\'}">${esc(item.key)}</span>',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-05：归档条目名与列表行**同一份**展示名（`itemPaths` 是唯一实现点）。
      // 页面脱敏、压缩包里照旧，等于没做 —— 而且归档更严重（解出来的目录结构就是
      // 分享者的组织方式）。
      name: 'R52-05c · 归档条目名退回原始 key（页面看不到 photos/，下载下来却有）',
      file: 'server/share-routes.js',
      anchor: '      const shownPaths = shareStore.itemPaths(v.items);',
      replacement: '      const shownPaths = new Map();',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-06：左右两列视觉等高。信息区固定六行 ≈208px，二维码矮一截就明显不齐；
      // `flex-start` 会把「等高」直接废掉（那正是改动前的默认值）。
      name: 'R52-06a · 详情弹窗两列退回 flex-start（二维码比信息区矮一截）',
      file: 'public/css/style.css',
      anchor: '.lr-wrap { display: flex; gap: 16px; align-items: stretch; }',
      replacement: '.lr-wrap { display: flex; gap: 16px; align-items: flex-start; }',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-06：二维码尺寸是**一对**约束（容器与 svg 必须一致，且不小于信息区高度）。
      // 这条断言的是「改一行 CSS 就能同时打破两件约束里的后一件」。
      name: 'R52-06b · 二维码高度退回旧值（与六行信息区不再等高）',
      file: 'public/css/style.css',
      anchor: '.lr-qr { flex: 0 0 208px; min-height: 208px; display: flex; align-items: center; justify-content: center; }',
      replacement: '.lr-qr { flex: 0 0 172px; min-height: 172px; display: flex; align-items: center; justify-content: center; }',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：工具栏/快捷键这三条接线（复制、粘贴、Ctrl+C / Ctrl+V）。
      // 变异只动「粘贴」——它与「复制」是**两个**不同的动作，接错不会报错，
      // 只会让 Ctrl+V 悄悄变成又一次「复制」。
      name: 'R52-03f · 工具栏「粘贴」接到复制（Ctrl+V 不再粘贴）',
      file: 'public/js/main.js',
      anchor: '  $(\'op-paste\').onclick = () => ops.paste();',
      replacement: '  $(\'op-paste\').onclick = () => ops.copySelected();',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },
    {
      // R52-03：api.js 的 `copy` 封装**必须**把 `decisions` 传下去。
      // 丢了它就是「问完之后答案没发出去」——第二轮仍会被判成冲突，
      // 表现是无限循环地问同一个问题（或直接按"没决策"再问一次）。
      name: 'R52-03g · api.copy 丢掉 decisions（问完了答案发不出去）',
      file: 'public/js/api.js',
      anchor: '  copy: (paths, targetPrefix, decisions) => request(\'POST\', \'/api/fs/copy\', { paths, targetPrefix, decisions }),',
      replacement: '  copy: (paths, targetPrefix) => request(\'POST\', \'/api/fs/copy\', { paths, targetPrefix }),',
      testFile: 'audit52-regressions.test.js',
      minFail: 1,
    },

  /* ================================================================== *
   * 第 53 轮（R53）：系统设置页新增「发信设置」卡片（SMTP），
   *                 位置在「用户管理」与「线程并发」之间；
   *                 零新增依赖 —— 用 `node:net` / `node:tls` 手写 SMTP。
   * ================================================================== */
    {
      // R53-01a：端口归一化。脏端口原样落盘 ⇒ `net.connect({port: undefined})`
      // 之类的类型错误会在发信时才炸，而且栈指向加密层，看不出是配置问题。
      name: 'R53-01a · 非法端口不再回到默认值（脏值原样落盘）',
      file: 'server/limits.js',
      anchor: '  if (i < SMTP_PORT_MIN || i > SMTP_PORT_MAX) return SMTP_PORT_DEFAULT;',
      replacement: '  if (i < SMTP_PORT_MIN || i > SMTP_PORT_MAX) return i;',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-01b：入参判据。非法端口若被静默放行，界面上会显示一个用户没填过的端口。
      name: 'R53-01b · 端口入参不再判非法（静默放行）',
      file: 'server/limits.js',
      anchor: '    return { ok: false, error: `SMTP 端口须在 ${SMTP_PORT_MIN}–${SMTP_PORT_MAX} 之间` };',
      replacement: '    return { ok: true, value };',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-02a：⭐ 信头注入面。判据必须落在「trim 之前」—— 先 trim 的话，
      // 末尾那一个 CRLF 会被裁掉而放行，于是「能不能注入」变成了依赖输入形态。
      name: 'R53-02a · 地址先 trim 再判换行（末尾的 CRLF 被裁掉后放行）',
      file: 'server/limits.js',
      anchor: '  if (/[\\r\\n]/.test(raw)) return { ok: false, error: `${name}不能包含换行符` };\n  const s = raw.trim();\n  if (!s) return { ok: true, value: \'\' }; // 留空 = 不设置（口令框同样语义）',
      replacement: '  const s = String(v == null ? \'\' : v).trim();\n  if (/[\\r\\n]/.test(s)) return { ok: false, error: `${name}不能包含换行符` };\n  if (!s) return { ok: true, value: \'\' }; // 留空 = 不设置（口令框同样语义）',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-02b：长度超限必须**报错**而不是静默截断 —— 截断会让用户以为整串都存下了。
      name: 'R53-02b · 超长文本静默截断而不再报 400',
      file: 'server/limits.js',
      anchor: '  if (s.length > max) return { ok: false, error: `${name}不能超过 ${max} 个字符` };',
      replacement: '  if (s.length > max) return { ok: true, value: s.slice(0, max) };',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-03a：口令三态里的「留空 = 保持不变」。若退化成「留空即清空」，
      // 管理员每改一次主机 / 端口就得重输一次密码 —— 而且没有任何提示。
      name: 'R53-03a · 密码框留空退化成「清空密码」（改端口就得重输密码）',
      file: 'server/config-store.js',
      anchor: '      password: p.password === null ? \'\' : ((p.password !== undefined && p.password !== \'\') ? p.password : prev.password),',
      replacement: '      password: p.password === null ? \'\' : (p.password !== undefined ? p.password : \'\'),',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R53-03b：落盘归一。`save(partial)` 是**顶层键替换** —— 若只在读取侧归一，
       * 一次带半截 smtp 的写入就会留下缺 port / secure 的记录，发信时端口变
       * `undefined` 直接抛类型错误。
       *
       * ⚠️ 必须**三步一起撤**才能证伪，这是纵深防御的正常形态（与 R28-03 同型）：
       * `normalize()`（读盘）、`save()`（写盘）、`getSmtp()`（取用）各有一次归一。
       * 只撤**任何一处**，`getSmtp()` 的返回值都仍然完整 ⇒ `fail=0`。
       * 本条**最初就是只撤 `normalize()` 一处**，实跑即得 `fail=0` ——
       * 台账条目写着「半截对象直接落盘」，而那条路径根本不可观测，是**假绿**。
       */
      name: 'R53-03b · 三处归一化调用点全部撤除（半截对象直接落盘）',
      file: 'server/config-store.js',
      mutations: [
        { anchor: '  normalizeSmtpInto(cfg);', replacement: '' },
        { anchor: '  normalizeSmtpInto(cur);', replacement: '' },
        {
          anchor: '  const shadow = { smtp: cfg ? cfg.smtp : undefined };\n'
            + '  normalizeSmtpInto(shadow);\n  return shadow.smtp;',
          replacement: '  const shadow = { smtp: cfg ? cfg.smtp : undefined };\n'
            + '  return shadow.smtp;',
        },
      ],
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-03c：加密方式缺省跟随端口。恒 true 会让 587 端口去握手隐式 TLS。
      name: 'R53-03c · secure 缺省恒为 true（587 端口去握隐式 TLS）',
      file: 'server/config-store.js',
      anchor: '    secure: typeof src.secure === \'boolean\' ? src.secure : port === SMTP_PORT_DEFAULT,',
      replacement: '    secure: true,',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-04a：safeView 正常分支。漏了 smtp ⇒ 卡片每次刷新都把已保存值清空。
      // R54 同步：其后又插入了 `site: siteView(cfg),` 一行，anchor 一并带上。
      name: 'R53-04a · safeView 正常分支不再下发 smtp（卡片读不到已保存配置）',
      file: 'server/config-store.js',
      anchor: '    smtp: smtpView(cfg), // R53：发信设置（口令只回 hasPassword 布尔值）\n    site: siteView(cfg), // R54：站点设置（站点名称 / 公开注册 / 新用户身份）\n    credentials: creds.credentials,',
      replacement: '    site: siteView(cfg), // R54：站点设置（站点名称 / 公开注册 / 新用户身份）\n    credentials: creds.credentials,',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-05a：非 ASCII 主题 / 显示名必须走 RFC 2047，否则收件端显示乱码。
      name: 'R53-05a · 非 ASCII 信头不再编码（收件端乱码）',
      file: 'server/smtp.js',
      anchor: '  if (/^[\\x20-\\x7E]*$/.test(s) && s.indexOf(\'=?\') < 0) return s;',
      replacement: '  return s;',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-05b：点填充。少了它，正文里行首是点的那一行会被当成结束标记 ⇒ 信件被截断。
      name: 'R53-05b · DATA 不再做点填充（正文行首的点被当成结束标记）',
      file: 'server/smtp.js',
      anchor: "  return String(msg).split('\\r\\n').map((l) => (l.charAt(0) === '.' ? `.${l}` : l)).join('\\r\\n');",
      replacement: '  return String(msg);',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-06a：EHLO 被拒后必须退回 HELO（老式服务器只认 HELO）。
      name: 'R53-06a · EHLO 被 502 拒绝后不再退回 HELO（老服务器连不上）',
      file: 'server/smtp.js',
      anchor: '    const r2 = await this._cmd(`HELO ${name}`);',
      replacement: '    this._assertCode(res, CODE.ehlo, \'EHLO\');\n    const r2 = null;',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-07a：⭐ 本轮最硬的一条。删掉判据后口令会以**明文**发出去 ——
      // 判据落在「假服务器收到的命令里出现了 AUTH」上，故删掉即红。
      name: 'R53-07a · 未加密的连接照样发送登录口令（明文泄漏）',
      file: 'server/smtp.js',
      anchor: '    if (!this.encrypted) {',
      replacement: '    if (this.encrypted) {',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-08a：管理员守卫。三条接口里任一条漏挂 ⇒ 普通用户可读写发信配置。
      name: 'R53-08a · PUT /smtp/config 漏挂 requireAdmin（普通用户可改发信配置）',
      file: 'server/routes/smtp.js',
      anchor: "router.put('/smtp/config', requireAdmin, apiHandler(async (req, res) => {",
      replacement: "router.put('/smtp/config', apiHandler(async (req, res) => {",
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-08b：⭐ 保存接口的响应里绝不能带回口令明文。
      // 判据落在**实际 HTTP 响应体**上 —— 与「前端不回填」是两道不同的闸门。
      name: 'R53-08b · 保存响应把完整配置（含口令）回传前端',
      file: 'server/routes/smtp.js',
      // `getSmtp()` 返回的是**含明文口令**的完整配置 —— 用它当响应体即等于把口令回传
      anchor: '  const saved = configStore.saveSmtp(patch);',
      replacement: '  const saved = configStore.getSmtp();',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-09a：卡片可见性。不登记 ⇒ 普通用户看到卡片、点保存却被 403。
      name: 'R53-09a · 「发信设置」卡片未登记进 ADMIN_ONLY_CARDS（普通用户可见）',
      file: 'public/js/syssettings.js',
      // R54 / R65 / R68 / R73 同步：名单前面是 'sysset-site-card', 'sysset-user-card', 'sysset-restore-card'，
      // 且 R68 在 smtp 与 concurrency 之间插入了 'sysset-agreement-card'，
      // 故 anchor 不再从 `const ADMIN_ONLY_CARDS = ` 起算 —— 只取「smtp 紧跟在 user 之后、
      // 后面接着协议设置」这一小段（仍全文唯一），变异即把 smtp 从名单里摘掉。
      anchor: "'sysset-restore-card', 'sysset-smtp-card', 'sysset-agreement-card',",
      replacement: "'sysset-restore-card', 'sysset-agreement-card',",
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R53-09b：卡片位置。需求白纸黑字要求「在用户管理和线程并发之间」，
       * 这里让 smtp 的 id 落到「线程并发」之后来证伪 —— 若断言只看卡片是否存在就发现不了。
       *
       * ⚠️ 多步变异的 anchor **必须每一条都已在原始源码里存在**：`runCase` 会在施加
       * **任何**变异之前先拿原文逐个校验。这里早先用的是「先改成临时 id、再把两张卡的
       * id 换回来」的三步交换法，第 3 步的 `id="__r53tmp__"` 原文里根本没有 ⇒
       * 直接报「锚点未命中」、一步都没改 ⇒ 这条对照形同虚设（既不变红也不报错）。
       */
      name: 'R53-09b · 「发信设置」卡片被挪到「线程并发」之后（位置不对）',
      file: 'public/index.html',
      mutations: [
        // ① 摘掉发信卡片自己的 id
        {
          anchor: 'id="sysset-smtp-card"',
          replacement: 'data-r53-moved="sysset-smtp-card"',
        },
        /**
         * ② 把同一个 id 挂进「负载均衡」卡片里（位处「线程并发」之后）。
         * 对下标记比较而言，这与「把整段卡片 HTML 搬到线程并发之后」产生的
         * index 关系**完全一致**（都是 iUser < iConc < iSmtp），
         * 但只需动一行、也不会顺带破坏别处 ⇒ 反向对照更稳。
         */
        {
          anchor: '            <div id="lb-list" class="lb-list"></div>\n',
          replacement: '            <span id="sysset-smtp-card"></span>\n'
            + '            <div id="lb-list" class="lb-list"></div>\n',
        },
      ],
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R53-09c：口令输入框退化成明文 `type="text"`。
       *
       * 与 09a（卡片可见性）/ 09b（卡片位置）分开钉 —— 这条守的是另一件事：
       * 口令不能显示在屏幕上、也不能被浏览器当成普通字段记住。
       */
      name: 'R53-09c · 口令输入框退化成明文 type="text"',
      file: 'public/index.html',
      anchor: 'type="password" id="smtp-password" class="full"',
      replacement: 'type="text" id="smtp-password" class="full"',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-01a：站点名称的换行判据失效。
       *
       * 变异**落在 `parseSiteNameInput` 这个调用点**而不是共享的 `parseSmtpTextInput`：
       * 后者是 R53-02a 的守备范围，改它会连带打红 SMTP 的一堆用例、
       * 让「红的是不是本条判据」变得不可判。这里只改站点名称这一路。
       */
      name: 'R54-01a · 站点名称先 trim 再判换行（末尾 CRLF 被裁掉后放行）',
      file: 'server/limits.js',
      anchor: '  return parseSmtpTextInput(v, SITE_NAME_MAX, \'站点名称\');',
      replacement: '  return parseSmtpTextInput(String(v == null ? \'\' : v).trim(), SITE_NAME_MAX, \'站点名称\');',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      // R54-02a：空站点名不再回退默认名 ⇒ undefined / 空串混进标题栏与邮件 From 头。
      name: 'R54-02a · 空站点名不回退默认名（标题栏与邮件 From 会变成空串）',
      file: 'server/config-store.js',
      anchor: '    siteName: name || SITE_NAME_DEFAULT,',
      replacement: '    siteName: name,',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-02b：site 归一化的**三处调用点一起撤**（纵深防御，与 R53-03b 同型）。
       *
       * `normalize()`（读盘）/ `save()`（写盘，顶层键替换）/ `getSite()`（取用）各归一一次，
       * 只撤**任一处**，`getSite()` 的返回值都仍然完整 ⇒ `fail=0`（假绿）。
       */
      name: 'R54-02b · site 归一化三处调用点全部撤除（半截对象直接落盘）',
      file: 'server/config-store.js',
      mutations: [
        { anchor: '  normalizeSiteInto(cfg);\n', replacement: '' },
        { anchor: '  normalizeSiteInto(cur);\n', replacement: '' },
        {
          anchor: '  const shadow = { site: cfg ? cfg.site : undefined };\n'
            + '  normalizeSiteInto(shadow);\n  return shadow.site;',
          replacement: '  const shadow = { site: cfg ? cfg.site : undefined };\n'
            + '  return shadow.site;',
        },
      ],
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      // R54-03a：GET /site/config 漏挂 requireAdmin ⇒ 普通用户能读到站点配置。
      name: 'R54-03a · GET /site/config 漏挂 requireAdmin（普通用户可读站点配置）',
      file: 'server/routes/site.js',
      anchor: "router.get('/site/config', requireAdmin, apiHandler(",
      replacement: "router.get('/site/config', apiHandler(",
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-03b：把公开的 /site/info 也挂上 requireAdmin。
       *
       * 后果很隐蔽：未登录的登录页永远拿不到站点名称，界面上只表现为
       * 「标题栏一直是硬编码那串」，很难联想到是服务端 403。
       */
      name: 'R54-03b · /site/info 误挂 requireAdmin（未登录的登录页拿不到站点名称）',
      file: 'server/routes/site.js',
      anchor: "router.get('/site/info', apiHandler(",
      replacement: "router.get('/site/info', requireAdmin, apiHandler(",
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-04a：公开接口把整个站点视图回出去（公开面被撑大）。
       *
       * 判据是「只允许回 ok / siteName / registration 三个字段」—— 一旦改成整段视图，
       * 匿名调用者就能读到 `defaultRole`（新用户身份）这类纯管理侧配置。
       *
       * ⚠️ R54② 同步：R54① 时这条的 anchor 是「只回 ok 与 siteName」，本次
       * `/site/info` 多回了 `registration`（登录页要据此决定「注册」入口形态），
       * anchor 与 `audit54` 的键集合断言一并跟上 —— 判据从两个键收紧到三个键，
       * **不是**放宽（多回字段这一变异照样变红）。
       */
      name: 'R54-04a · /site/info 多回字段（匿名调用者能看到注册模式与默认身份）',
      file: 'server/routes/site.js',
      anchor: 'res.json({ ok: true, siteName: v.siteName, registration: v.registration });',
      replacement: 'res.json(Object.assign({ ok: true }, view()));',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      // R54-05a：发件人显示名不再兜底站点名称 ⇒ 邮件 From 头没有名字。
      name: 'R54-05a · 发件显示名不再兜底站点名称（邮件 From 头没有名字）',
      file: 'server/routes/smtp.js',
      anchor: '    fromName: cfg.fromName || siteName,',
      replacement: '    fromName: cfg.fromName,',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-05b：/site/info 从匿名白名单里移除。
       *
       * ⚠️ 这条只有「读源码里的 PUBLIC_API 字面量」那种判据抓得住 ——
       * 直接挂子路由起的 express 实例**绕过了 index.js 的鉴权中间件**，
       * 白名单写没写都恒绿。
       *
       * ⚠️ R54② 同步：R54② 给白名单补了三条匿名路由，`PUBLIC_API` 从单行改成
       * 多行字面量，anchor 随之改写（`/site/info` 仍在第一行、位置未动）。
       */
      name: "R54-05b · '/site/info' 不在 index.js 的匿名白名单中",
      file: 'server/index.js',
      anchor: "  '/auth/login', '/auth/login/webauthn', '/auth/me', '/auth/init', '/captcha/public', '/site/info',",
      replacement: "  '/auth/login', '/auth/login/webauthn', '/auth/me', '/auth/init', '/captcha/public',",
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      // R54-06a：站点卡片未登记进 ADMIN_ONLY_CARDS ⇒ 普通用户可见（点保存却 403）。
      name: 'R54-06a · 「站点设置」卡片未登记进 ADMIN_ONLY_CARDS（普通用户可见）',
      file: 'public/js/syssettings.js',
      anchor: "const ADMIN_ONLY_CARDS = ['sysset-site-card',",
      replacement: 'const ADMIN_ONLY_CARDS = [',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-06b：卡片被挪到「用户管理」之后（需求要求它在最上方）。
       *
       * 两步变异的 anchor 都必须在**原文**里已存在（见 R53-09b 的踩坑说明）：
       * ① 摘掉站点卡片自己的 id；② 把同一个 id 挂到「发信设置」卡片之前
       * （那里已经在线程并发之上、更在用户管理之下）⇒ 下标关系反转。
       */
      name: 'R54-06b · 「站点设置」卡片被挪到「用户管理」之后（位置不对）',
      file: 'public/index.html',
      mutations: [
        { anchor: 'id="sysset-site-card"', replacement: 'data-r54-moved="sysset-site-card"' },
        {
          anchor: '            <div class="dash-card wide sysset-card" id="sysset-smtp-card">\n',
          replacement: '            <span id="sysset-site-card"></span>\n'
            + '            <div class="dash-card wide sysset-card" id="sysset-smtp-card">\n',
        },
      ],
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-06c：给卡片加一个启用开关。
       * 需求原文「该功能默认开启，因此无需启用/关闭开关」—— 加开关就是违背需求。
       */
      name: 'R54-06c · 站点设置卡片被加上启用开关（需求明确不要开关）',
      file: 'public/index.html',
      anchor: '              <h3 class="sysset-h3"><span class="sysset-tag site">站点</span>站点设置 <span id="site-status" class="lk-count"></span></h3>',
      replacement: '              <h3 class="sysset-h3"><span class="sysset-tag site">站点</span>站点设置 <span id="site-status" class="lk-count"></span>\n'
        + '                <label class="ip-switch"><input type="checkbox" id="site-enabled"><i></i></label>\n'
        + '              </h3>',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      // R54-07a：启动流程不再把站点名称写进标题栏（取到了却不用）。
      name: 'R54-07a · main.js 取到站点名称却不写进标题栏',
      file: 'public/js/main.js',
      anchor: '    syssettings.applySiteName(info && info.siteName);',
      replacement: '    void info;',
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54-07b：把取站点名称那段挪到 checkAuth() **之后**。
       *
       * ⚠️ R68 同步：这段与 `const me = await checkAuth();` 之间**又插进了一整块**
       * （取协议提示的 `API.agreementPublic()`，同样必须早于鉴权探测）。原先「一段
       * 连写到底」的单步 anchor 因此不再命中 —— 而 anchor 失效**不会报错、只会静默
       * 跳过**，`invariants` 的 anchor 自检是唯一能发现它的地方。
       *
       * 改为**两步**（删除 + 插到 checkAuth() 之后）：两步的 anchor 都只取**稳定的
       * 短片段**（站点名称那段 / 「先探测登录态」两行），中间那块协议提示既不参与
       * anchor 也不被移动 —— 下次谁再往这两者之间塞东西，这条对照不需要跟着改。
       */
      name: 'R54-07b · 站点名称改在 checkAuth() 之后才取（未登录的登录页拿不到）',
      file: 'public/js/main.js',
      mutations: [
        {
          anchor: '  try {\n'
            + '    const info = await API.siteInfo();\n'
            + '    syssettings.applySiteName(info && info.siteName);\n'
            + '    // R54②：注册模式也来自这条公开接口 —— 登录页据此决定「注册账户」入口显不显示\n'
            + '    siteRegistration = (info && info.registration) || \'closed\';\n'
            + '  } catch (e) { /* 拿不到就用静态标题，不影响登录；注册入口按最保守的"不显示"处理 */ }\n'
            + '\n',
          replacement: '',
        },
        {
          anchor: '  // 先探测登录态\n  const me = await checkAuth();\n',
          replacement: '  // 先探测登录态\n'
            + '  const me = await checkAuth();\n'
            + '\n'
            + '  try {\n'
            + '    const info = await API.siteInfo();\n'
            + '    syssettings.applySiteName(info && info.siteName);\n'
            + '    // R54②：注册模式也来自这条公开接口 —— 登录页据此决定「注册账户」入口显不显示\n'
            + '    siteRegistration = (info && info.registration) || \'closed\';\n'
            + '  } catch (e) { /* 拿不到就用静态标题，不影响登录；注册入口按最保守的"不显示"处理 */ }\n',
        },
      ],
      testFile: 'audit54-regressions.test.js',
      minFail: 1,
    },

    /* ==================================================================
     * R54②：注册 / 忘记密码 / 邮箱验证码
     *
     * 每条对应的行为护栏在 `tests/audit54b-regressions.test.js`。
     * 与 R54① 同一纪律：判据必须落在**实际被执行的那一层**，所以这里既有
     * 判据层 / 数据层 / 验证码层的变异，也有真 HTTP 路由层与前端接线层的变异。
     * ================================================================== */
    {
      /**
       * R54b-01a：邮箱判据**先 trim 再判换行**。
       *
       * 这是最容易写错的一处（`parseSmtpAddressInput` 为此专门留了长注释）：
       * 末尾多一个 `\r\n` 的粘贴噪声会被 trim 裁掉而放行，而同一个判据对
       * 「换行在中间」的输入又是拒绝的 —— 判据与位置相关，就成了一个只挡一半的闸门。
       */
      name: 'R54b-01a · 邮箱判据先 trim 再判换行（末尾 CRLF 被裁掉后放行）',
      file: 'server/limits.js',
      anchor: 'function parseEmailInput(v, label) {\n'
        + '  const name = label || \'邮箱地址\';\n'
        + '  const raw = v == null ? \'\' : String(v);\n'
        + '  if (/[\\r\\n]/.test(raw)) return { ok: false, error: `${name}不能包含换行符` };',
      replacement: 'function parseEmailInput(v, label) {\n'
        + '  const name = label || \'邮箱地址\';\n'
        + '  const raw = v == null ? \'\' : String(v);',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-01b：本地部分不夹字符集 ⇒ `a b@c.com` / `.a@b.com` 也能过（而邮箱会直接进 `To:`）。
      name: 'R54b-01b · 邮箱本地部分不夹字符集（空格 / 前导点被放行）',
      file: 'server/limits.js',
      anchor: '  if (!EMAIL_LOCAL_RE.test(local) || local.startsWith(\'.\') || local.endsWith(\'.\') || local.includes(\'..\')) {',
      replacement: '  if (local.length > 9999) {',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-01c：归一化不再转小写 ⇒ 同一个邮箱能绑给两个账户（"重置密码该重置谁"没有答案）。
      name: 'R54b-01c · 邮箱归一化不再转小写（同一邮箱可绑两个账户）',
      file: 'server/limits.js',
      anchor: '  return raw.trim().toLowerCase();',
      replacement: '  return raw.trim();',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-02a：`updateUser` 的邮箱判据从 `!== undefined` 退回真值判断。
       *
       * 这是本轮最隐蔽的一处：解绑（空串）会**静默失效**，而界面上照样显示"保存成功"。
       */
      name: 'R54b-02a · 邮箱判据退回真值判断（解绑静默失效）',
      file: 'server/config-store.js',
      anchor: '  if (patch.email !== undefined) {\n    const mail = normalizeEmail(patch.email);',
      replacement: '  if (patch.email) {\n    const mail = normalizeEmail(patch.email);',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-02b：唯一性判据撤除 ⇒ 同一邮箱绑两个账户，「重置密码该重置谁」不再有正确答案。
      name: 'R54b-02b · 邮箱唯一性判据撤除（同一邮箱可绑两个账户）',
      file: 'server/config-store.js',
      anchor: 'function assertEmailFree(cfg, email, excludeId) {\n'
        + '  if (!email) return;\n'
        + '  const hit = (cfg.users || []).find((u) => u.id !== excludeId && normalizeEmail(u.email) === email);\n'
        + '  if (hit) throw Object.assign(new Error(\'该邮箱已被其他账户使用\'), { status: 409 });\n'
        + '}',
      replacement: 'function assertEmailFree(cfg, email, excludeId) {\n'
        + '  void cfg; void email; void excludeId;\n'
        + '}',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-03a：验证码用满之后改回「删记录」。
       *
       * 删掉就等于连 `sentAt` 一起抹掉，重发冷却随之失效 ——
       * 攻击者每试错 5 次就能立刻要一封新码，把冷却这道闸门整个绕过。
       * 同时三种失败原因也会塌成两种（"没签过"与"已被试错用尽"分不开）。
       */
      name: 'R54b-03a · 验证码用满改回"删记录"（冷却与失败原因一并塌掉）',
      file: 'server/email-code.js',
      anchor: '  if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {\n'
        + '    return { ok: false, reason: \'too_many\' };\n'
        + '  }\n'
        + '\n'
        + '  if (!sameHash(rec.hash, hashOf(code))) {\n'
        + '    rec.attempts += 1;\n'
        + '    if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { ok: false, reason: \'too_many\' };\n'
        + '    return { ok: false, reason: \'mismatch\' };\n'
        + '  }',
      replacement: '  if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {\n'
        + '    codes.delete(key);\n'
        + '    return { ok: false, reason: \'too_many\' };\n'
        + '  }\n'
        + '\n'
        + '  if (!sameHash(rec.hash, hashOf(code))) {\n'
        + '    rec.attempts += 1;\n'
        + '    if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {\n'
        + '      codes.delete(key);\n'
        + '      return { ok: false, reason: \'too_many\' };\n'
        + '    }\n'
        + '    return { ok: false, reason: \'mismatch\' };\n'
        + '  }',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-03b：重发冷却撤除 ⇒ 本站成了"给任意邮箱发信"的工具，SMTP 配额也会被一次点击风暴刷光。
      name: 'R54b-03b · 验证码重发冷却撤除（可被反复点击刷爆发信配额）',
      file: 'server/email-code.js',
      anchor: '  const prev = codes.get(key);\n'
        + '  if (prev) {\n'
        + '    const left = EMAIL_CODE_RESEND_MS - (now - prev.sentAt);\n'
        + '    if (left > 0) return { ok: false, retryAfter: Math.ceil(left / 1000) };\n'
        + '  }',
      replacement: '  void 0;',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-03c：验证码按用途隔离的键失效。
       *
       * 键里丢掉 `purpose` 之后，用户点「修改邮箱」拿到的一个码，转头填进
       * 「忘记密码」也成立 —— 而这两件事的信任前提完全不同
       * （前者是"已登录的人在证明自己拥有新邮箱"，后者是"没登录的人在要回账户"）。
       */
      name: 'R54b-03c · 验证码不按用途隔离（改邮箱的码能用于重置密码）',
      file: 'server/email-code.js',
      anchor: 'function codeKey(purpose, email) {\n  return `${purpose}|${email}`;\n}',
      replacement: 'function codeKey(purpose, email) {\n  void purpose;\n  return String(email);\n}',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-03d：邮件正文不区分用途 ⇒ 「验证邮箱」的信里写着"重置密码"，用户会以为账户被人动过。
      name: 'R54b-03d · 验证码邮件不区分用途（绑定邮箱的信写成"重置密码"）',
      file: 'server/email-code.js',
      anchor: '  const title = purpose === \'reset\' ? \'重置密码\' : \'验证邮箱\';',
      replacement: '  const title = \'重置密码\';',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-04a：注册时身份改取**请求体**。
       *
       * 最直接的后果：任何人注册时带上 `role: 'admin'` 就能自封管理员 ——
       * 而本端点匿名可达。
       *
       * ⚠️ R54③ 把这一行改成了 `granted ? granted.role : site.defaultRole`
       * （邀请码模式新增「以码上的身份为准」这半支），原 anchor 随之**老化**。
       * 这里刻意只把变异打在**公开注册那一支**（`: (b.role || site.defaultRole)`）：
       * 「连邀请码那一支也一起劫持」的同一形态已由 R54c-04d 按新代码接管 ——
       * 两条各钉一半，避免台账里出现两条一模一样的变异。
       */
      name: 'R54b-04a · 注册的身份改取请求体（可自封管理员）',
      file: 'server/routes/auth.js',
      anchor: '        role: granted ? granted.role : site.defaultRole,',
      replacement: '        role: granted ? granted.role : (b.role || site.defaultRole),',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-04b：注册不判注册模式 ⇒ 「关闭注册」形同虚设（界面藏了入口，接口却放行）。
       *
       * ⚠️ R54③ 把判据从 `site.registration !== 'open'` 改成
       * `mode !== 'open' && mode !== 'invite'`（邀请码模式一并放行），anchor 随之老化。
       * 变异形态仍是「把整条闸门短路成 false」—— 那正是本条的原始病灶。
       */
      name: 'R54b-04b · 注册不判注册模式（关闭注册下接口仍放行）',
      file: 'server/routes/auth.js',
      anchor: "    const mode = site.registration;\n    if (mode !== 'open' && mode !== 'invite') {",
      replacement: '    const mode = site.registration;\n    if (false) {',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-04c：给「邮箱验证码」也开匿名口子。
       *
       * 它是已登录用户给自己绑邮箱的第一步（`emailCodeLimiter` 按 IP 限流、且要查
       * 实时用户记录），放进匿名白名单等于让未登录者也能触发发信。
       */
      name: 'R54b-04c · /auth/email/code 被放进匿名白名单（未登录也能触发发信）',
      file: 'server/index.js',
      anchor: '  \'/auth/register\', \'/auth/forgot\', \'/auth/reset\',',
      replacement: '  \'/auth/register\', \'/auth/forgot\', \'/auth/reset\', \'/auth/email/code\',',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-05a：`/auth/forgot` 按"有没有这个账户"给出不同响应。
       *
       * 本端点在匿名白名单里，一旦响应分叉，它就成了一条**账户存在性 oracle** ——
       * R21-05 / R22-01 收敛登录三支同形，堵的正是同一个洞。
       */
      name: 'R54b-05a · /auth/forgot 命中与未命中的响应分叉（账户枚举通道）',
      file: 'server/routes/auth.js',
      anchor: '    return res.json({ ok: true, message: \'如果该账户已绑定邮箱，重置验证码已发送，请查收邮件（含垃圾邮件箱）\' });',
      replacement: '    if (!(raw && email)) return res.status(404).json({ error: \'该账户不存在或未绑定邮箱\' });\n'
        + '    return res.json({ ok: true, message: \'验证码已发送\' });',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-05b：`/auth/reset` 的"标识不存在"分支改成 404 ⇒ 与"验证码不对"的响应不再同形。
      name: 'R54b-05b · /auth/reset 的"标识不存在"分支不再同形（枚举通道）',
      file: 'server/routes/auth.js',
      anchor: '    if (!raw || !email) return authFail(\'标识不存在或该账户未绑定邮箱\');',
      replacement: '    if (!raw || !email) return res.status(404).json({ error: \'标识不存在或该账户未绑定邮箱\' });',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-05c：重置密码后不撤销会话。
       *
       * 重置密码是**应急响应动作** —— 不撤销就等于"密码已经改了，但攻击者的旧会话
       * 还能用"，这次重置白做（与管理员重置密码同一处置，SEC-02）。
       */
      name: 'R54b-05c · 重置密码后不撤销会话（应急响应失效）',
      file: 'server/routes/auth.js',
      anchor: '    const n = authSession.destroyUserSessions(raw.id);',
      replacement: '    const n = 0;',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-06a：改邮箱不再要求当前密码（R21-09 的反例）。
       *
       * 邮箱是「忘记密码」的收件渠道：会话被劫持时，攻击者只要换成自己的邮箱，
       * 就能走「忘记密码」把账户**永久接管** —— 而验证码帮不上一点忙
       * （收件箱本来就在他手上）。
       */
      name: 'R54b-06a · 改邮箱不再要求当前密码（会话劫持 ⇒ 永久接管）',
      file: 'server/routes/users.js',
      anchor: '        patch.email = mail;\n        emailChanged = true;\n        needsCurrent = true;',
      replacement: '        patch.email = mail;\n        emailChanged = true;',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-06b：改邮箱时不再核对验证码 ⇒ 手滑填成别人的地址也照单全收（重置渠道白送）。
      name: 'R54b-06b · 改邮箱时不核对验证码（地址填错也能绑上）',
      file: 'server/routes/users.js',
      anchor: '          const r = emailCode.check({ purpose: \'verify\', email: mail, code });',
      replacement: '          const r = { ok: true };',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R54b-07a：管理员新增用户时忽略 email ⇒ 需求 2.6 落空（且界面显示成功、实际没存）。
      name: 'R54b-07a · 管理员新增用户时忽略 email（需求 2.6 落空）',
      file: 'server/routes/users.js',
      anchor: '      speedLimit,\n      email,\n    });',
      replacement: '      speedLimit,\n    });',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-07b：把邮箱也塞进 `sensitive`（撤销会话）。
       *
       * 邮箱既不是身份也不是权限，改它不会让既有会话越权；"一改邮箱就把人踢下线"
       * 是纯打扰。而"管理员借改邮箱接管账户"也不成立 —— 他本来就能直接重置密码。
       */
      name: 'R54b-07b · 管理员改邮箱被纳入 sensitive（改一次就把人踢下线）',
      file: 'server/routes/users.js',
      anchor: '    const sensitive = patch.username !== undefined || patch.role !== undefined\n'
        + '      || patch.permissions !== undefined || patch.password !== undefined;',
      replacement: '    const sensitive = true;',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-08a：注册入口不看注册模式 ⇒ 关闭注册下也摆出一个点了必然失败的链接。
       *
       * ⚠️ R54③ 之后这一行是**折行**写的，且模式判据变成 `(open || invite)` ——
       * 逐字 anchor 已老化（这条正是记忆里那条教训：改判据形态会顺手打掉别处的 anchor）。
       * 变异仍打在「整条模式判据」上，与 R54c-05f-a（只把 invite 摘掉）互为不同形态。
       */
      name: 'R54b-08a · 注册入口不看注册模式（关闭注册下仍摆出按钮）',
      file: 'public/js/main.js',
      anchor: "  document.getElementById('auth-register-link').hidden =\n    !(authMode === 'login' && (siteRegistration === 'open' || siteRegistration === 'invite'));",
      replacement: "  document.getElementById('auth-register-link').hidden =\n    !(authMode === 'login');",
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-08b：「记住密码」不保存密码。
       *
       * 这条刻意**不**去动 `xorBytes`（那样一删就报错，反而好抓）—— 它动的是混淆的
       * **输入**：函数还在、混淆照跑、界面照显示"已记住"，但密码再也没被保存过。
       */
      name: 'R54b-08b · 「记住密码」不保存密码（只混淆了个空串）',
      /**
       * ⚠️ R69 改锚：H-1 把「保存密码」那条路径**整段删掉**了，原来的变异对象
       * （`xorBytes(...)` 那行）已不存在。这里改为盯**新实现里唯一可能重新泄露凭据
       * 的地方** —— 读到历史记录时的**就地清洗**：`saved.k` / `saved.p` 是升级前
       * 落盘的那份「密钥 + 异或密文」，不清洗就会一直躺在 localStorage 里等下一次
       * 被还原。把清洗条件改成恒假 ⇒ `R54b-8` 的断言立刻红。
       */
      file: 'public/js/main.js',
      anchor: '    if (saved.k !== undefined || saved.p !== undefined) {',
      replacement: '    if (false) {',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54b-08c：限流响应不再把 `Retry-After` 挂到错误对象上（界面倒计时退回"猜一个数"）。
       *
       * 这条的形态值得记：它是**「静态判据假绿」的标本**。原护栏只断言 `api.js`
       * 源码里出现过 `retryAfter` 这个词 —— 而变异成 `NaN` 之后，那句 `err.retryAfter = …`
       * 仍在源码里、词也仍在，静态断言照样绿。真正的判据必须**真跑一次请求**：
       * 装一个带 `headers.get('Retry-After')` 的假 `fetch`，断言取回来的 `err.retryAfter`
       * 就是服务端给的那个秒数（同一条用例还反向钉住「没有这个头时不得硬编一个数字」）。
       */
      name: 'R54b-08c · 限流的 Retry-After 不再挂回错误对象（界面倒计时只能写死）',
      file: 'public/js/api.js',
      anchor: '    const retryAfter = Number(res.headers.get(\'Retry-After\'));',
      replacement: '    const retryAfter = NaN;',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },

    /* ================================================================
     * R54③ · 邀请码系统（需求 4 / 4.1 + 管理员批量导出 txt）
     *
     * 五层对应 `tests/audit54c-regressions.test.js` 的五个 `====` 段：
     *   ① 判据（`server/limits.js`）   ② 存储（`server/invite-store.js`）
     *   ③ 路由（`server/routes/invite.js`）
     *   ④ 注册接入（`server/routes/auth.js`）
     *   ⑤ 前端（`public/index.html` / `main.js` / `api.js` / `invitemgr.js`）
     *
     * ⚠️ R54③ 有几条「**判据形态**」本身就是修复内容，变异时必须打在那个形态上，
     *    而不是「把函数删掉」：
     *      · `disabled !== undefined`（真值判断会让「重新启用」静默失效）；
     *      · 导出的**末尾换行**（不是「有没有 join」）；
     *      · 归一化的**顺序**（先拒换行再归一）；
     *      · 注册三步的**先后**（核销必须在人机验证之后 —— 否则是一条
     *        「邀请码存在性 oracle」）。
     *    这四条都是「源码里有 × 也照样全绿」的高发区（见 MEMORY.md §十五 五类假绿）。
     * ================================================================ */

    {
      /**
       * R54c-01a：归一化不再去空白 / 不再转大写。
       *
       * 表现不是报错，而是**同一枚码在几种输入下变成几枚不同的码**：从表格复制
       * 带上尾随空格、从聊天软件复制带上换行、人工按 4 位分组抄（`ABCD EFGHJK`），
       * 注册时一律报「邀请码无效」—— 而用户看到的提示与「真的抄错了一位」完全同形，
       * 几乎无从自查。
       */
      name: 'R54c-01a · 邀请码归一化不再去空白 / 转大写（粘贴带空格即报无效）',
      file: 'server/limits.js',
      anchor: "  return String(v == null ? '' : v).replace(/\\s+/g, '').toUpperCase();",
      replacement: "  return String(v == null ? '' : v);",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-01b：邀请码判据**先归一、再判**（撤掉「先拒换行」那一行）。
       *
       * 归一会把 `\r\n` 吃掉，于是「粘贴带了个换行」与「真的少写了一位的区别」
       * 在服务端看起来一模一样，用户只能反复看到同一句「格式不正确」。
       * 与 `parseEmailInput` 是同一条纪律（那里更硬 —— 换行会进 SMTP 信头）。
       */
      name: 'R54c-01b · 邀请码判据不再先拒换行（脏输入与抄错一位无法区分）',
      file: 'server/limits.js',
      anchor: "  const raw = v == null ? '' : String(v);\n  if (/[\\r\\n]/.test(raw)) return { ok: false, error: '邀请码不能包含换行符' };",
      replacement: "  const raw = v == null ? '' : String(v);",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-01c-a：使用次数上限不再拒负数。
       *
       * 落盘归一化会把 `-1` 归成 `0`，而 `0` 的语义是「**不限制**」—— 管理员想
       * 收紧配额，结果把限制完全放开了。这是本项目第二次踩同一个陷阱
       * （`parseSpeedLimitInput` 是方向相反的那一侧）。
       */
      name: 'R54c-01c-a · 使用次数上限不再拒负数（落盘归成 0 ⇒ 限制被彻底放开）',
      file: 'server/limits.js',
      anchor: "  if (n < 0) return { ok: false, error: '使用次数上限不能为负数（0 表示不限制）' };",
      replacement: "  if (n < -999999) return { ok: false, error: '使用次数上限不能为负数（0 表示不限制）' };",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-01c-b：过期时间不再要求「晚于当前」。
       *
       * 把一个已经过去的时间当成「过期时间」存下来，唯一的效果是让这枚码**当场失效**，
       * 而列表里「过期时间」那一列显示的又是一个未来感十足的日期 —— 管理员会以为
       * 是自己设置的，实际拿到一批立即失效的码。要立即失效**有专门的开关**（停用）。
       */
      name: 'R54c-01c-b · 过期时间不再要求晚于当前（存下过去时刻 ⇒ 这批码当场失效）',
      file: 'server/limits.js',
      anchor: "  if (ms <= now) return { ok: false, error: '过期时间须晚于当前时间；若要立即失效请使用「停用」' };",
      replacement: "  if (ms < 0) return { ok: false, error: '过期时间须晚于当前时间；若要立即失效请使用「停用」' };",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-01c-c：备注不再夹长度。
       *
       * 备注会进**审计日志**（`statsStore.addLog` 的 detail），是一条为「人类读」
       * 而存在的台账；不夹长度等于给了一个往日志里灌任意长度的入口。
       */
      name: 'R54c-01c-c · 备注不再夹长度（超长备注进审计日志）',
      file: 'server/limits.js',
      anchor: "  return parseSmtpTextInput(v, INVITE_NOTE_MAX, '备注');",
      replacement: "  return parseSmtpTextInput(v, INVITE_NOTE_MAX * 100, '备注');",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02a：生成时身份不再取入参（写死普通用户）。
       *
       * 直接让需求 4.1「单独 / 批量设置注册后的身份」落空 —— 而且**界面会显示成功**：
       * 管理员在生成时选了「管理员」，列表里那一列也照写（写的是生成后立刻
       * `view()` 出来的旧值）… 只有等到有人拿这枚码注册、发现拿到的仍是普通用户时
       * 才会暴露。
       */
      name: 'R54c-02a · 生成时身份不取入参（写死普通用户 ⇒ 需求 4.1 落空）',
      file: 'server/invite-store.js',
      anchor: '      role: normalizeDefaultRole(role),',
      replacement: "      role: 'user',",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02b-a：「不限制」的剩余次数返回 `0` 而不是 `null`。
       *
       * `0` 会被读成「已经用完了」（列表那一列、以及任何 `remaining > 0` 的判断），
       * 于是一枚**不限制使用次数**的码在界面上显示成「剩余 0 次」。用 `null` 表达
       * 「不适用」正是为了让这个区分不可能被顺手漏掉。
       */
      name: 'R54c-02b-a · 「不限制」的剩余次数返回 0 而非 null（界面读成「已用完」）',
      file: 'server/invite-store.js',
      anchor: '    remaining: maxUses > 0 ? Math.max(0, maxUses - used) : null,',
      replacement: '    remaining: Math.max(0, maxUses - used),',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02b-b：核销失败的四档原因被合并成一句「无效」。
       *
       * 四档对应的**下一步动作完全不同**：「已用尽 / 已过期」要去找管理员要新码，
       * 「格式错」是自己抄错了，「已停用」则是管理员主动关掉的。合成一句话就只能
       * 得到一张「说无效但看上去都对」的工单。
       */
      name: 'R54c-02b-b · 核销失败的四档原因被合并成一句（下一步动作无从分辨）',
      file: 'server/invite-store.js',
      anchor: "  const st = status(r);\n  if (st !== 'active') return { ok: false, reason: st };",
      replacement: "  const st = status(r);\n  if (st !== 'active') return { ok: false, reason: 'not_found' };",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02c-a：回滚不再校验「还有次数可退」。
       *
       * 把 `used` 压成负数之后，那枚码的剩余名额会凭空多出来（`maxUses - used` 变大），
       * 而列表显示的是一个负数 —— 一条只在异常路径上出现的静默超额。
       */
      name: 'R54c-02c-a · 回滚不再校验「还有次数可退」（used 被压成负数）',
      file: 'server/invite-store.js',
      anchor: '  if (wasUsed <= 0) return false;',
      replacement: '  if (wasUsed < 0) return false;',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02c-b：回滚删的不是「与本用户名相同」那一条。
       *
       * `addUser()` 内部有 scrypt 的 await，期间另一个请求可能用同一枚码注册成功并
       * 追加了自己的名字。`used` 计数仍然正确，但**删掉的是别人的名字** ——
       * 症状极轻微（只有 `usedBy` 名单错位），几乎无法排查，正是这条护栏要守住的。
       */
      name: 'R54c-02c-b · 回滚删的不是「与本用户名相同」那一条（usedBy 名单错位）',
      file: 'server/invite-store.js',
      anchor: '  if (idx >= 0) r.usedBy.splice(idx, 1);',
      replacement: '  if (idx >= 0) r.usedBy.splice(0, 1);',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02d-a：批量设置退回「整体替换」。
       *
       * PATCH 语义就是这个功能的全部价值：勾选十条码只想改「使用次数」，
       * 不能顺手把备注清空、把过期时间改成永久。判据必须落在「**没有出现在 patch
       * 里的字段保持原值**」，而不是「有没有 applyPatch 这个函数」。
       */
      name: 'R54c-02d-a · 批量设置退回整体替换（没给的字段被顺手清成默认值）',
      file: 'server/invite-store.js',
      anchor: "  if (p.note !== undefined) r.note = typeof p.note === 'string' ? p.note : '';",
      replacement: "  r.note = typeof p.note === 'string' ? p.note : '';",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02d-b：停用 / 启用判据退回**真值判断**。
       *
       * `disabled: false` 是合法值（= 重新启用），用真值判断会让这个动作**静默失效**，
       * 而界面会显示成功 —— 与 `updateUser` 里 `patch.email !== undefined` 是同一个坑。
       * ⚠️ 变异的形态刻意不是「删掉整行」：那样一删就报错，反而好抓；难抓的是
       * 「函数还在、字段照写、只是判据口径退化」。
       */
      name: 'R54c-02d-b · 停用/启用判据退回真值判断（disabled:false 静默失效）',
      file: 'server/invite-store.js',
      anchor: '  if (p.disabled !== undefined) r.disabled = Boolean(p.disabled);',
      replacement: '  if (p.disabled) r.disabled = true;',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02d-c：重置使用次数**不清 `usedBy`**。
       *
       * 「重置」的语义是「这批码重新发一轮」；留着上一轮的人名会让
       * 「这枚码最近谁在用」这一列直接失真 —— 而它正是管理员排查泄漏时的唯一线索。
       */
      name: 'R54c-02d-c · 重置使用次数不清 usedBy（「最近谁在用」失真）',
      file: 'server/invite-store.js',
      anchor: '  if (p.resetUsed) { r.used = 0; r.usedBy = []; }',
      replacement: '  if (p.resetUsed) { r.used = 0; }',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02e：导出不再补末尾换行。
       *
       * `a\nb\nc` 与 `a\nb\nc\n` 在「打开看一眼」时毫无区别，但用 `while read` /
       * `xargs` 逐行消费时会**丢掉最后一行**（读不到行尾）—— 而那是这类文件最常见的
       * 用途（批量核销 / 导入别的系统）。这正是需求原话「一行一个」要的那个形状。
       */
      name: 'R54c-02e · 导出不再补末尾换行（while read 会吞掉最后一行）',
      file: 'server/invite-store.js',
      anchor: "  return codes.length ? codes.join('\\n') + '\\n' : '';",
      replacement: "  return codes.join('\\n');",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-02f：脏记录不再整条丢弃。
       *
       * 一枚连 `INVITE_CODE_RE` 都不满足的码永远不可能被 `consume()` 命中（那里按
       * 规范形式比对），留在表里只会让管理员看见一行「有效」却怎么都注册不成功；
       * 两条同码记录的危害更大 —— 两行的「已用次数」各自计数。
       * ⚠️ 与 SEC-09「文件损坏不得静默重建」不冲突：那条守的是**整个文件**读不出来。
       */
      name: 'R54c-02f · 脏记录不再整条丢弃（非法码 / 重复码留在表里）',
      file: 'server/invite-store.js',
      anchor: '    if (!INVITE_CODE_RE.test(code)) { dropped += 1; continue; }',
      replacement: '    if (!INVITE_CODE_RE.test(code)) { dropped += 1; }',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-03c-a：单条更新的「目标不存在」不再 404。
       *
       * 它在文法上完全正确、只是目标没了（被另一个管理员删掉）—— 报 400 会把
       * 「你的请求有问题」说给一个请求毫无问题的调用方，前端据此走的提示分支也全错。
       */
      name: 'R54c-03c-a · 单条更新的「目标不存在」不再 404（降级成 400）',
      file: 'server/routes/invite.js',
      anchor: "  if (!v) throw Object.assign(new Error('邀请码不存在或已被删除'), { status: 404 });",
      replacement: "  if (!v) throw Object.assign(new Error('邀请码不存在或已被删除'), { status: 400 });",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-03c-b：批量设置允许空 `ids`。
       *
       * 「一个都没选中」被静默判成成功：前端弹一个「设置成功」，而实际上一条都没改。
       * 这与本项目「入参非法一律显式 400、落盘路径才静默归一」的分工是同一条判据。
       */
      name: 'R54c-03c-b · 批量设置允许空 ids（「一个都没选中」被静默判成成功）',
      file: 'server/routes/invite.js',
      anchor: "  const ids = parseIds(b.ids);\n  if (!ids || !ids.length) throw Object.assign(new Error('请先选择要设置的邀请码'), { status: 400 });",
      replacement: '  const ids = parseIds(b.ids) || [];',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-03d：导出响应被 JSON 包装。
       *
       * 两个后果同时发生：`Content-Type` 不再是 `text/plain`，前端 `requestText`
       * 拿到的是 `"[\\"ABCDEFGHJK\\",…]"` 原样写进 .txt —— 另存出来的文件打开就是乱码。
       * 这条端点的产物会被**直接拿去逐行消费**，包一层 JSON 等于给出一个废文件。
       */
      name: 'R54c-03d · 导出响应被 JSON 包装（另存出来的 txt 是乱码）',
      file: 'server/routes/invite.js',
      anchor: "  res.setHeader('Content-Type', 'text/plain; charset=utf-8');\n  // 文件名由前端决定（`a.download`），服务端只负责内容 —— 一处来源，不会两边不一致\n  res.send(text);",
      replacement: '  res.json(text);',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-04b：核销结果被忽略。
       *
       * 「码无效 / 已用尽 / 已停用 / 已过期」四种失败全部放行，等于**邀请码模式
       * 完全失效**（任何人都能不带码开户）—— 这是本功能最严重的一档缺陷，
       * 而界面上仍是一个漂亮的「注册成功」。
       */
      name: 'R54c-04b · 核销结果被忽略（无效/已用尽的码也照常开户）',
      file: 'server/routes/auth.js',
      anchor: '      const r = inviteStore.consume(inviteCode, username);\n      if (!r.ok) {',
      replacement: '      const r = inviteStore.consume(inviteCode, username);\n      if (false) {',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-04c：建号失败不再归还核销掉的那一次。
       *
       * 核销在 `addUser()` 之前（否则「用户名已存在」会白扣一次配额）。少了回滚，
       * 管理员看到的是「已用 1 次」却找不到对应账户 —— 一枚只够 1 次的码就此报废。
       * 「要么全成、要么全不成」是这条路径的全部内容。
       */
      name: 'R54c-04c · 建号失败不再回滚核销（管理员看到「已用 1 次」却无账户）',
      file: 'server/routes/auth.js',
      anchor: '      if (granted) inviteStore.rollback(granted.id, username);',
      replacement: '      if (false && granted) inviteStore.rollback(granted.id, username);',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-04d：注册身份改取**请求体**。
       *
       * 任何人注册时带上 `role: 'admin'` 就能自封管理员 —— 公开注册模式下这直接
       * 是一条提权通道。这条在 R54b（身份取站点设置）已验证过一次，R54③ 增加了
       * 「邀请码的 role 覆盖站点默认」这条新分支，故必须重新按新形态钉一遍。
       */
      name: 'R54c-04d · 注册身份改取请求体（任何人注册时自封管理员）',
      file: 'server/routes/auth.js',
      anchor: '        role: granted ? granted.role : site.defaultRole,',
      replacement: '        role: b.role || (granted ? granted.role : site.defaultRole),',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-04e：核销挪到人机验证**之前**。
       *
       * ⭐ 这一条的判据是**顺序本身**：这个端点限流只有 10 次 / 10 分钟，若
       * 「这枚码存在但已用尽」能在人机验证之前被区分出来，它就成了一条
       * **邀请码存在性 oracle**（拿一批码来试，响应能区分「存在」与「不存在」）。
       *
       * 变异手法是「在 captcha 那行之前**多插一次** consume」而不是搬运整段：
       * 判据是 `body.indexOf('inviteStore.consume')` 与 `body.indexOf('captcha.verify')`
       * 的先后，插一处更靠前的 consume 就足以把它打红，且变异态源码**语法自洽**
       * （用 `b.username` 而不是还没声明的 `username`，避免制造 TDZ 噪声红）。
       */
      name: 'R54c-04e · 核销挪到人机验证之前（限流端点变成邀请码存在性 oracle）',
      file: 'server/routes/auth.js',
      anchor: '    const cap = await captcha.verify({ token: b.captchaToken, remoteip: ip }, configStore);',
      replacement: "    if (mode === 'invite') inviteStore.consume(inviteCode, String(b.username == null ? '' : b.username).trim());\n    const cap = await captcha.verify({ token: b.captchaToken, remoteip: ip }, configStore);",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05a：邀请码页面丢掉 `card-view`。
       *
       * 纯样式缺陷，但它有一个固定的表现：整页没有内边距、不随主区滚动 ——
       * 邀请码列表是这个功能的主体（几十行表格），不可滚动等于不能用。
       */
      name: 'R54c-05a · 邀请码页面丢掉 card-view（整页无内边距 / 不滚动）',
      file: 'public/index.html',
      anchor: '        <section id="invitemgr" class="card-view" hidden>',
      replacement: '        <section id="invitemgr" class="card" hidden>',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05a-b：登录页的邀请码框缺省不再隐藏。
       *
       * `#auth-invite-item` 会在普通登录、初始化创建管理员等形态下都露出来 ——
       * 一个与当前动作无关的输入框，用户填了也不会被使用。
       */
      name: 'R54c-05a-b · 登录页的邀请码框缺省不再隐藏（登录态也摆着一个邀请码输入框）',
      file: 'public/index.html',
      anchor: '        <div class="form-item" id="auth-invite-item" hidden>',
      replacement: '        <div class="form-item" id="auth-invite-item">',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05b：换账号不再丢弃邀请码列表。
       *
       * `GET /invites` 会**原样回传邀请码明文**（管理员正要复制分发，打码会让页面
       * 失去意义）。不随会话重置 ⇒ 管理员登出、普通用户在同一浏览器登录后，
       * 整批明文口令仍挂在内存与 DOM 里。与 ipmgr 的按角色重置同款。
       */
      name: 'R54c-05b · 换账号不再丢弃邀请码列表（明文口令跨会话残留）',
      file: 'public/js/main.js',
      anchor: '  invitemgr.reset();',
      replacement: '  void 0;',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05c：`VIEW_ENTRY` 不再登记 `invitemgr`。
       *
       * ⭐ 这是**唯一的角色门控点**：`viewFromHash()` 靠「入口按钮是否 hidden」判断
       * 这个视图能不能进。少一条登记 ⇒ 地址栏敲 `#invitemgr` 对普通用户**不被门控**，
       * 直接落到邀请码页（页面虽然也被隐藏，但 URL 可直达这件事本身就是缺口）。
       *
       * 预期至少两条红：`R54c-05b`（VIEW_ENTRY 必须登记）与 `R54c-05c`
       * （真跑 `viewFromHash()` 的角色门控）。
       */
      name: 'R54c-05c · VIEW_ENTRY 不再登记 invitemgr（普通用户改地址栏即可进页）',
      file: 'public/js/main.js',
      anchor: "  invitemgr: 'side-invite',\n",
      replacement: '',
      testFile: 'audit54c-regressions.test.js',
      minFail: 2,
    },
    {
      /**
       * R54c-05d-a：导出改用 `request()`。
       *
       * `request()` 走 `res.json()`，拿到纯文本会在 parse 处抛错并被吞成 `null` ——
       * 症状是「点导出没反应、也没有报错」。同时它还会广播 `notifyWrite`
       * （导出并不改变服务端状态），让界面白刷一圈。
       */
      name: 'R54c-05d-a · 导出改用 request()（走 JSON 路径 ⇒ 点导出没反应也没报错）',
      file: 'public/js/api.js',
      anchor: "  exportInvites: (ids) => requestText('POST', '/api/invites/export', { ids: ids || [] }),",
      replacement: "  exportInvites: (ids) => request('POST', '/api/invites/export', { ids: ids || [] }),",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05d-b：`requestText` 退回 `res.json()`。
       *
       * 这个函数的**全部内容**就是「用 `res.text()` 而不是 `res.json()`」——
       * 变异之后它连自己存在的理由都没有了（失败路径仍在，用户看到的是
       * `Unexpected token ... in JSON` 而不是服务端那句可读文案）。
       */
      name: 'R54c-05d-b · requestText 退回 res.json()（它存在的理由被抹掉）',
      file: 'public/js/api.js',
      anchor: '  const text = await res.text();',
      replacement: '  const text = await res.json();',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05e-a：前端重算「是否过期」。
       *
       * 服务端 `invite-store.status()` 已经算好 `status` 随列表下发，前端再判一遍
       * **必然分叉** —— 最典型的表现是「列表说有效，注册时却提示已过期」
       * （两边的时钟 / 边界口径不可能永远一致）。
       */
      name: 'R54c-05e-a · 前端重算过期（列表说有效、注册却提示已过期）',
      file: 'public/js/invitemgr.js',
      anchor: '        const m = metaOf(l.status);',
      replacement: "        const m = metaOf(l.expiresAt && new Date(l.expiresAt).getTime() < Date.now() ? 'expired' : l.status);",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05e-b：批量「过期时间」撤掉「不修改」档。
       *
       * ⭐ 「不修改」与「改成永久」是**两件不同的事**，用「空即默认」会把后者读成
       * 前者（或反过来）。三个控件都必须同时具备「不修改」与各自的显式取值。
       */
      name: 'R54c-05e-b · 批量「过期时间」撤掉「不修改」档（未选的字段被顺手改成别的）',
      file: 'public/index.html',
      anchor: '                    <option value="keep">不修改</option>',
      replacement: '                    <option value="at">指定时间</option>',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05f-a：注册入口只判 `open`。
       *
       * 邀请码模式下**本来就能注册成功**，却因为入口判据没跟上而摆不出链接 ——
       * 用户拿到一枚码，却在登录页找不到任何可以输入它的地方。
       *
       * ⚠️ 这条改动同时会让 `audit54b` 的 `R54b-8` 变红（那条判据在 R54③ 已同步为
       * 「open || invite」），但**台账条目只能挂一个 testFile**，所以 `minFail` 只按
       * 本文件（`audit54c`）计 = 1；另一侧那 1 条红由 `--only=R54b-08a` 那条覆盖
       * （它把整条模式判据都抹掉，两处红都吃到）。
       */
      name: 'R54c-05f-a · 注册入口只判 open（邀请码模式下摆不出注册链接）',
      file: 'public/js/main.js',
      anchor: "    !(authMode === 'login' && (siteRegistration === 'open' || siteRegistration === 'invite'));",
      replacement: "    !(authMode === 'login' && siteRegistration === 'open');",
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05f-b：邀请码输入框不随注册模式打开。
       *
       * 说明文案已经切成「请填写邀请码」，框却始终隐藏 —— 用户被要求填一个
       * 看不见的字段。R54② 那版是「恒隐藏」，这条正对着那个形态。
       */
      name: 'R54c-05f-b · 邀请码输入框不随注册模式打开（填了码也不知道填哪儿）',
      file: 'public/js/main.js',
      anchor: '    if (inviteItem) inviteItem.hidden = !needInvite;',
      replacement: '    if (inviteItem) inviteItem.hidden = true;',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R54c-05f-c：注册请求不带邀请码。
       *
       * 界面收了、校验也过了，请求里却没有它 —— 服务端于是判「没填邀请码」400。
       * 一条纯粹由「界面与服务端之间的字段名/取值不一致」造成的死循环：
       * 用户反复填码、反复被要求填码。
       */
      name: 'R54c-05f-c · 注册请求不带邀请码（界面收了、请求丢了）',
      file: 'public/js/main.js',
      anchor: '        inviteCode: inviteCode || undefined,',
      replacement: '        inviteCode: undefined,',
      testFile: 'audit54c-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R53-10a：系统发信（验证码 / 重置密码）把「含口令的内部读」换回**对外视图**。
       *
       * 这正是 R55 修的原始病灶。对外视图为了保密把 `password` 裁成 `hasPassword`
       * 布尔值 ⇒ 口令恒为空 ⇒ `validateForSend()` 判 400「已填写登录用户名但密码为空」，
       * 于是**只要管理员填了登录用户名**（真实 SMTP 服务器几乎都要求认证），
       * 登录页的验证码 / 忘记密码**一封也发不出去**。
       *
       * ⚠️ 症状是**两极分化**的：管理员手点的「发送测试邮件」走含口令的内部读、
       * 照样成功 —— 同一份落盘配置、两个读法，用户看到的就是「用户名密码都填对了，
       * 却发不了信」。故变异必须打在**取配置那一行**上，而护栏也落在
       * 「假服务器收到的 AUTH 载荷里有没有那份口令」上（`R53-10 · 取用` 四条）。
       *
       * ⚠️ R57 起「取配置」这个动作收口成了**全库唯一一处**（`mailerState()`）：
       * 发信与探针都从那里取，变异点随之从 `sendCodeMail` 移到那里（语义不变）。
       */
      name: 'R53-10a · 系统发信改回用「对外视图」取配置（口令被裁空 ⇒ 一封也发不出去）',
      file: 'server/email-code.js',
      anchor: 'function mailerState() {\n  const cfg = configStore.smtpSendConfig();',
      replacement: 'function mailerState() {\n  const cfg = configStore.smtpView(configStore.load());',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-10b：发信入口自己把口令抹成空串 —— 与「拿对外视图去发信」是同一个错的两种写法。
      name: 'R53-10b · 发信入口把口令抹成空串（错误取用的等价形态）',
      file: 'server/config-store.js',
      anchor: 'function smtpSendConfig() {\n  const s = getSmtp();',
      replacement: "function smtpSendConfig() {\n  const s = Object.assign({}, getSmtp(), { password: '' });",
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R53-10c：「能不能发信」的判据分叉。
       *
       * 视图只判主机、发信端还判发件人 ⇒ 两条路径对同一份配置给出不同答案，
       * 表现是「路由放行并回『验证码已发送』，而发信端抛 503」或者反过来
       * 「界面显示未配置、实际能发」。判据必须是同一句（`smtpConfigured()`）。
       */
      name: 'R53-10c · 「能不能发信」判据分叉（视图与发信入口各判一套）',
      file: 'server/config-store.js',
      anchor: '    configured: smtpConfigured(s),',
      replacement: '    configured: Boolean(s.host),',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      // R53-10d：发信闸门恒真 ⇒ 未配置也照发，用户只会收到「验证码已发送」然后一直等一封不会来的信。
      name: 'R53-10d · 发信闸门恒真（未配置也回「已发送」）',
      file: 'server/config-store.js',
      anchor: '  return Object.assign({}, s, { configured: smtpConfigured(s) });',
      replacement: '  return Object.assign({}, s, { configured: true });',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R53-11a：「启用 / 停用发信功能」开关若不拦**系统发信**，它就只是个装饰 ——
       * 界面上写着「已停用」，登录页取码 / 忘记密码照样把邮件发出去。
       *
       * 撤掉 `email-code.js` 里 `mailerGate()` 的那道 `if (!cfg.enabled)` 即可复现。
       * 判据落在「假服务器到底收到几行命令」上，故 ⑩ 层里三条会同时变红
       * （实测 `fail=3`：停用后 sendCodeMail 仍 503 / 匿名 forgot 如实 503 且一封不发 /
       *  email-code 如实 503）。
       *
       * ⚠️ R57 起这条闸门的**形状**变了（原先是在 `sendCodeMail` 里直接 throw，
       * 现在是 `mailerGate()` 返回一个 `{status,error}`），但语义一条没松：
       * 停用 ⇒ 系统发信一律不发。**反向对照必须跟着改形状**，否则它会变成一条
       * 「anchor 未命中」的假绿。
       */
      name: 'R53-11a · 系统发信的「启用开关」闸门被撤除（停用后照样发信）',
      file: 'server/email-code.js',
      anchor: '  if (!cfg.enabled) {\n'
        + '    return {\n'
        + '      status: 503,\n'
        + "      error: '系统发信已由管理员停用（系统设置 → 发信设置 → 启用发信功能），暂时无法发送邮件。',\n"
        + '    };\n'
        + '  }',
      replacement: '  // 启用开关闸门已被反向对照移除',
      testFile: 'audit53-regressions.test.js',
      minFail: 3,
    },
    {
      /*
       * R53-11b：把 `enabled` 折进 `smtpConfigured()` —— 一种「看着更简洁」的写法。
       *
       * 后果是**停用被显示成「未配置」**：配置明明还在，卡片却说没配；错误文案也从
       * 「已停用」退化成「尚未配置」，管理员会去重填一份本来就对的配置。
       * 这条锚住的正是「`configured` 回答『配没配』、`enabled` 回答『开没开』」这个分法。
       *
       * 实测 `fail=4`：`R53-4` 的视图层 1 条 + ⑩ 层 3 条（视图的 `configured` 一并被污染）。
       */
      name: 'R53-11b · 把 enabled 折进 smtpConfigured（停用被显示成「未配置」）',
      file: 'server/config-store.js',
      anchor: '  return Boolean(s && s.host && s.from);',
      replacement: '  return Boolean(s && s.host && s.from && s.enabled);',
      testFile: 'audit53-regressions.test.js',
      minFail: 4,
    },
    {
      /*
       * R55-B1：`collect()` 不再输出发信设置。
       *
       * 这是「新条目只加在界面上、没接进载荷」的典型坏法：备份说明里写着含「发信设置」，
       * 导出的码里却没有它 —— 用户在新实例上导入后，验证码 / 重置密码一封都发不出去，
       * 而界面上一切正常（`smtpView().configured` 为 false，但没人会去看）。
       * 实测 `fail=5`：`R38-02e` / `R38-02g`（分区集合必须与 SECTIONS 一致）+ `R55-01` / `R55-01b` / `R55-03`。
       */
      name: 'R55-B1 · collect() 不再输出发信设置（备份说明说含、载荷里却没有）',
      file: 'server/backup.js',
      anchor: '    // R55：发信设置（走 getSmtp —— 含明文口令，见 sanitizeSmtp 的说明）\n    smtp: sanitizeSmtp(configStore.getSmtp()),\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 5,
    },
    {
      /*
       * R55-B2：`collect()` 不再输出站点设置 —— 与 B1 同一个坏法的另一半
       *（站点名称会决定浏览器标题栏与邮件发件人显示名，丢了以后新实例上「站名回到默认」
       * 却没有任何提示）。
       * 实测 `fail=4`：`R38-02e` / `R38-02g` + `R55-02` / `R55-03`。
       */
      name: 'R55-B2 · collect() 不再输出站点设置（站名 / 注册模式 / 新用户身份全丢）',
      file: 'server/backup.js',
      anchor: '    // R55：站点设置（站点名称 / 公开注册 / 新用户身份）\n    site: sanitizeSite(configStore.getSite()),\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 4,
    },
    {
      /*
       * R55-B3：`apply()` 不再**写回**发信设置。
       *
       * 与 B1 的区别是「导出对、导入漏」—— 这类缺陷在**导出端做全量检查**时完全看不出来
       * （`decodeCode()` 里字段一个不少），只有真的导入一次才会发现凭据没回来。
       * 实测 `fail=2`：`R55-01` / `R55-01b`（导出端的两条全绿，正是本条要说明的事）。
       */
      name: 'R55-B3 · apply() 不再写回发信设置（导出对、导入后凭据没回来）',
      file: 'server/backup.js',
      anchor: '  const sm = sanitizeSmtp(data.smtp);\n  configStore.saveSmtp(Object.assign({}, sm, { password: sm.password === \'\' ? null : sm.password }));\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 2,
    },
    {
      /*
       * R55-B4：`isEmptyData()` 不再把这两段新分区算进「全新实例」判据。
       *
       * 后果是**导入窗口在本该关闭时仍然开着**：老实例上一旦只配了发信 / 站点设置
       *（这两样恰恰是最常单独配的），按钮就是可点的，而那一次点击会把线上配置整批覆盖掉，
       * 不可撤销 —— 界面上此前一贯显示「本实例已有配置，导入已关闭」。
       * 实测 `fail=1`：`R38-02l`（逐项枚举那一条；用例内部是个循环，首个失败的枚举项即中止本条用例）。
       */
      name: 'R55-B4 · isEmptyData 不再覆盖发信 / 站点设置（导入窗口在本该关闭时仍开着）',
      file: 'server/backup.js',
      anchor: '  if (!configStore.smtpIsDefault(data.smtp)) return false;\n  if (!configStore.siteIsDefault(data.site)) return false;\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R55-B5：`smtpIsDefault()` 退回「只比有没有值」的朴素写法（忽略端口 / TLS 方式之差）。
       *
       * 这**不是**随手加的：发信设置的 `secure` 缺省**跟随端口**（465 → true），
       * 所以「全新实例」的载荷里 `secure` 其实是 `true` —— 朴素写法要么把它判成「已配置」
       *（导入窗口永远关着），要么漏掉「只改过端口」这一种改动（导入时静默覆盖掉它）。
       * 本条钉住的是「判据必须与 `normalizeSmtpInto()` 同源」。
       * 实测 `fail=1`：`R38-02l` —— 红的正是枚举里 `发信设置（仅端口）` 那一项。
       */
      name: 'R55-B5 · smtpIsDefault 忽略端口 / TLS 之差（只改过端口的那次改动被漏判）',
      file: 'server/config-store.js',
      anchor: '  return x.enabled === y.enabled && x.host === y.host && x.port === y.port\n    && x.secure === y.secure && x.user === y.user && x.password === y.password\n    && x.from === y.from && x.fromName === y.fromName;',
      replacement: '  return x.enabled === y.enabled && x.host === y.host\n    && x.user === y.user && x.password === y.password\n    && x.from === y.from && x.fromName === y.fromName;',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R55-B6：`siteIsDefault()` 退回「有值就算配过」的朴素写法。
       *
       * 站点设置的默认值是**非空**的（站点名有默认名、注册模式默认 closed），
       * 于是朴素写法会把**任何**一台机器都判成「已配置」—— 导入窗口一出生就是关着的，
       * 且没有任何提示能解释「为什么全新部署也说已有配置」。
       * 实测 `fail=1`：`R38-02l` —— 红的正是开头那句「全新实例必须允许导入」。
       *
       * ⚠️ R68 同步：这个 `return` 后面又续了六行 `notices` 比对（三页提示的开关 + 文案），
       * anchor 必须**把整条 return 语句整段圈住** —— 只圈前三个字段时，替换后会留下
       * 一串以 `&&` 开头的孤儿行，变异体本身就有语法错误（那样 `fail` 来自崩溃而不是
       * 来自这条判据，属于「变异不等价于旧实现」的假红）。
       */
      name: 'R55-B6 · siteIsDefault 退回「有值就算配过」（全新实例也被判成已配置）',
      file: 'server/config-store.js',
      anchor: '  return x.siteName === y.siteName\n'
        + '    && x.registration === y.registration\n'
        + '    && x.defaultRole === y.defaultRole\n'
        + '    // R68：三页提示也算站点设置的一部分 —— 只开了一个开关、文案还空着，就不是默认状态。\n'
        + '    // 漏掉这一行，「开了分享页提示」的实例在备份导入对话框里会被判成「全新实例」。\n'
        + '    && x.notices.login.enabled === y.notices.login.enabled\n'
        + '    && x.notices.login.text === y.notices.login.text\n'
        + '    && x.notices.register.enabled === y.notices.register.enabled\n'
        + '    && x.notices.register.text === y.notices.register.text\n'
        + '    && x.notices.share.enabled === y.notices.share.enabled\n'
        + '    && x.notices.share.text === y.notices.share.text;',
      replacement: '  return !(x.siteName && x.registration && x.defaultRole);',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R55-B7：「邀请码不备份」这句用户要求的说明被删掉。
       *
       * 需求原话是「**再说明**『邀请码部分不备份，因为邀请码条数可能过多』」——
       * 说明本身就是要交付的东西：只把 `invites` 排除掉而不写出来，用户会以为
       * 「恢复之后邀请码也回来了」。
       * 实测 `fail=1`：`R55-05`（`邀请码` 一词在别的卡片里也有，故真正把这条判红的是「条数可能过多」）。
       */
      name: 'R55-B7 · 界面删掉「邀请码不备份」的说明（用户按需求点名要写的那句）',
      file: 'public/index.html',
      anchor: '                  <li><b>为什么不含邀请码</b>：邀请码属于运行时数据，且<b>条数可能过多</b> ——',
      replacement: '                  <li>（本说明已被反向对照移除）',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R57-01a：站点级健康探针被摘成恒真 —— 这正是「配置全对却发不出去」卷土重来的入口。
       *
       * 探针的价值全在「真连一次 SMTP 服务器并完成登录」：只报健康的话，
       * 认证被拒（服务商改成必须用授权码）与端口连不上这两类最常见的故障又会被
       * 静默吞掉，用户重新回到「点发送验证码 → 界面说过已发送 → 永远收不到信」。
       *
       * 实测 `fail=3`：R57-01（探针没认证就报成功）+ R57-02（四类失败全判成通过）+
       * R57-04（端到端又回 200「已发送」）。
       */
      name: 'R57-01a · 发信探针被摘成恒真（认证被拒 / 连不上又变成静默失败）',
      file: 'server/email-code.js',
      anchor: '    await smtp.verify({\n'
        + '      host: cfg.host, port: cfg.port, secure: cfg.secure,\n'
        + '      user: cfg.user, password: cfg.password, from: cfg.from,\n'
        + '    });',
      replacement: '    // 探针被反向对照摘除（直接报健康）',
      testFile: 'audit53-regressions.test.js',
      minFail: 3,
    },
    {
      /**
       * R57-02a：`/auth/forgot` 不再调用站点级闸门（退回 R57 之前的恒真行为）。
       *
       * 后果不是「多一条错误」，而是**用户彻底失去线索**：未配置 / 已停用 / 连不上
       * 统统回 200「验证码已发送」—— 本轮两份工单的表象就是这么来的。
       *
       * 实测 `fail=3`：R53-11（停用后匿名忘记密码不再如实 503）+ R57-03（闸门顺序失守）
       * + R57-04（配置齐全但连不上时不再 503）。`minFail` 取**实测条数**而非 1 ——
       * 它同时是「这条变异应当红几条」的下界，调小会把「悄悄少红了」当成通过。
       */
      name: 'R57-02a · /auth/forgot 的站点级闸门被摘除（未配置也回「已发送」）',
      file: 'server/routes/auth.js',
      anchor: '    const gate = await emailCode.probeMailer();\n'
        + '    if (!gate.ok) return res.status(gate.status || 503).json({ error: gate.error });',
      replacement: '    const gate = { ok: true };\n'
        + '    if (!gate.ok) return res.status(gate.status || 503).json({ error: gate.error });',
      testFile: 'audit53-regressions.test.js',
      minFail: 3,
    },
    {
      /**
       * R57-03a：登录前的匿名写端点失去界面同步豁免。
       *
       * 漏掉之后的症状极难反推：请求本身**成功**，界面却弹一句
       * 「未登录或会话已过期，请重新登录」（那是同步请求 `GET /api/config` 的 401），
       * 而流程还照常推进到下一步 —— 用户只会说「发送失败却放行了」。
       */
      name: 'R57-03a · 匿名三条端点失去「不触发界面同步」的豁免（点发送验证码会弹假 401）',
      file: 'public/js/api.js',
      anchor: "  { path: '/api/auth/register', why: '② 登录前动作：此刻本无会话，同步界面必然 401' },\n"
        + "  { path: '/api/auth/forgot', why: '② 同上（忘记密码第一步，匿名可达）' },\n"
        + "  { path: '/api/auth/reset', why: '② 同上（重置密码，匿名可达）' },",
      replacement: '  // 登录前三条匿名端点的豁免被反向对照摘除',
      testFile: 'audit47-regressions.test.js',
      minFail: 1,
    },
    {
      // R57-04a：提示词不再与 label 同步 —— label 写「用户名或邮箱」、输入框却提示「请输入用户名」。
      name: 'R57-04a · 忘记密码的 placeholder 不与 label 同步（提示词只说「用户名」）',
      file: 'public/js/main.js',
      anchor: "  userInput.placeholder = isForgot ? '请输入用户名或已绑定的邮箱' : '请输入用户名';",
      replacement: "  userInput.placeholder = '请输入用户名';",
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R57-05a：把「推进到第二步」也塞进失败分支 —— 就是用户报的
       * 「点击发送验证码，即使发送失败也会立即进入重设密码的窗口」。
       */
      name: 'R57-05a · 发送验证码失败也推进到重置窗口（catch 里也置 forgotStep）',
      file: 'public/js/main.js',
      anchor: "  } catch (e) {\n    showAuthError(e.message || '发送失败');\n  } finally {",
      replacement: "  } catch (e) {\n    showAuthError(e.message || '发送失败');\n    forgotStep = 2;\n  } finally {",
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R57-06a：首次发码后不启动倒计时 ⇒ 重发按钮一进第二步就是可点的（用户会在冷却期内连点）。
      name: 'R57-06a · 首次发码后不启动重发倒计时（重发按钮一进来就能点）',
      file: 'public/js/main.js',
      anchor: '    startResendCountdown(60);\n    showAuthOverlay();',
      replacement: '    showAuthOverlay();',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R57-07a：重发按钮的文案丢掉剩余秒数 ⇒ 需求「60 秒后可重新发送」落空（只剩一个可点的按钮）。
      name: 'R57-07a · 重发按钮不再显示倒计时秒数（需求「60 秒后可重新发送」落空）',
      file: 'public/js/main.js',
      anchor: "  btn.textContent = waiting ? `${resendLeft} 秒后可重新发送` : '重新发送验证码';",
      replacement: "  btn.textContent = '重新发送验证码';",
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      // R57-08a：切走时不叫停定时器 ⇒ 它在别的形态下继续跑，再进来时按钮上还挂着上次的剩余秒数。
      name: 'R57-08a · 离开忘记密码形态时不叫停倒计时（定时器跨形态空转）',
      file: 'public/js/main.js',
      anchor: '    resendLeft = 0;\n    stopResendCountdown();\n  }',
      replacement: '    resendLeft = 0;\n  }',
      testFile: 'audit54b-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R57-09a：建连阶段的硬截止被拆掉，退回裸 `once` —— 这正是「界面永久卡在
       * 正在连接 SMTP 服务器并发送…」的入口。
       *
       * ⚠️ 回退后的实现里**只留 `error` / 成功事件**，没有定时器：对端把数据包
       * **丢弃**（而非拒绝）时两边都不触发 ⇒ 那个 Promise 永不 settle。
       * 台账里 R57-09 用桩造出「永不 emit connect 的裸 Socket」，故它必红。
       *
       * ⚠️⭐ **这条变异的红法必须记清楚**（实测，与「干净的一条断言失败」不同）：
       *   `# fail 1` + `# cancelled 3` ——
       *   ① R57-09 **挂住**（正是它要证明的那个 bug）⇒ 跑者取消它的同批兄弟
       *      R57-10 / R57-11（`cancelled`，不是 `fail`）；
       *   ② R57-02 真红 —— 它是**连带伤**：R57-09 挂在 `finally` 之前，
       *      桩把 `net.connect` / `net.createConnection` 留在变异态，后面用到
       *      真套接字的用例全被带坏。
       *   故 `minFail: 1` 取**报数器自己的 `# fail`**（=1，即 R57-02），
       *   而**不能**按 `not ok` 行数（4）填 —— 那会把一个「挂住型」变异
       *   误当成「干净单点」变异。**判红只需 ≥1，且必须含 R57-09 的亲属**；
       *   这里 R57-09 表现成 cancelled，故判断依据是「`cancelled` 里出现了
       *   R57-09」而不是「`not ok` 里出现了 R57-09」。
       */
      name: 'R57-09a · 建连阶段的硬截止被拆掉（对端丢包时永不 settle ⇒ 界面永久卡住）',
      file: 'server/smtp.js',
      anchor: "    await awaitSocketEvent(sock, [o.secure ? 'secureConnect' : 'connect'], o, '建连');",
      replacement: "    await new Promise((res, rej) => { sock.once('error', rej); sock.once(o.secure ? 'secureConnect' : 'connect', res); });",
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R57-10a：`AggregateError` 不再拆 `.errors[]` —— 退回「取 `e.message`」的
       * 零信息文案，正是工单原文那句
       * 「连接 SMTP 服务器 smtp.qq.com:465 失败（建连）：AggregateError」。
       *
       * ⚠️ 回退后错误对象仍然是 `AggregateError` 实例，`e.message` 是**空串** ⇒
       * 走 `hintFor('')` 也拿不到提示。R57-10 断言「必须带出 240e::1 / ENETUNREACH /
       * 183.47.120.204」三条，故必红。
       *
       * 实测 `fail=1`：只红 R57-10（R57-09 走超时分支不经过这里；R57-11 是正向对照）。
       */
      name: 'R57-10a · AggregateError 不再拆逐地址原因（退回零信息的「AggregateError」文案）',
      file: 'server/smtp.js',
      anchor: '  const errs = (e && Array.isArray(e.errors) ? e.errors : []).filter(Boolean);',
      replacement: '  const errs = [];',
      testFile: 'audit53-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R63：deploy.sh 的**选源逻辑**改成「先测 GitHub 连通性，不通才转 Gitee」。
       * 用户原话：「拉取远端源码的仓库默认为 gitee，但 gitee 极有可能不是最新版，
       * 改为『测试连接 GitHub，连不通再转 gitee』」。
       *
       * ⚠️ 本轮**不推进版本号**（用户明确要求「无需推进版本号，也无需推送 github」），
       * 所以台账标签用 R63 只是「第 63 批改动」的编号，与 CHANGELOG 版本号无关 ——
       * invariants 也不做「标签 ↔ 版本」的绑定。
       *
       * 这六条钉的是同一个契约的六个面：**判据要落在真正执行的那件事上**，
       * 且信号要来得早（几秒探测）而不是「撞一次再换」。
       */

      /*
       * R63-01a：克隆绕开 choose_clone_url，直接用 `$REPO_URL`。
       *
       * 后果：`repo_reachable` 照跑、日志照打印「探测不通，改用镜像」，**克隆却仍打
       * 官方地址** —— 探测白做，用户还是等那一段没有结论的时间。这正是「信号算了
       * 但没接上」的形态：源码里两个词都在，行为却回到修复前。
       */
      name: 'R63-01a · 克隆直接用 $REPO_URL（探测算了却没接上，行为退回修复前）',
      file: 'deploy.sh',
      anchor: '  if run git clone --depth 1 "$clone_url" "${tmp}/src"; then',
      replacement: '  if run git clone --depth 1 "$REPO_URL" "${tmp}/src"; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R63-02a：连通性探针改用 `curl -sI https://github.com`。
       *
       * 这是最像「已经修好了」的坏法：探针确实存在、也确实有界超时，但判据落在
       * **另一条路**上 —— 网页首页 200 不代表 git 克隆端点通（用户可能只给网页配了
       * 代理），首页被墙也不代表 clone 不通。结论会与克隆实际结果相反。
       */
      name: 'R63-02a · 连通性探针改用 curl -I（网页首页 200 ≠ git 克隆端点通）',
      file: 'deploy.sh',
      anchor: '    GIT_TERMINAL_PROMPT=0 timeout "$REPO_PROBE_TIMEOUT" git ls-remote --heads "$url" >/dev/null 2>&1 || rc=$?',
      replacement: '    GIT_TERMINAL_PROMPT=0 timeout "$REPO_PROBE_TIMEOUT" curl -sI "https://github.com" >/dev/null 2>&1 || rc=$?',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R63-03a：探针不再用 `timeout` 兜底。
       *
       * GitHub 被黑洞时 TCP 根本连不上，而 **git 自己不设连接超时** ⇒ `ls-remote`
       * 会一直挂着。没有 timeout 的探针不是「快一点的探针」，而是把原来那段
       * 没有结论的等待**原封不动**搬到了探测里 —— 等于没修。
       */
      name: 'R63-03a · 探针不再用 timeout 兜底（被黑洞时一直挂着，等于没有探针）',
      file: 'deploy.sh',
      anchor: '    GIT_TERMINAL_PROMPT=0 timeout "$REPO_PROBE_TIMEOUT" git ls-remote --heads "$url" >/dev/null 2>&1 || rc=$?',
      replacement: '    GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$url" >/dev/null 2>&1 || rc=$?',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R63-04a：`choose_clone_url` 里「显式 --repo 直接返回」那道短路被删掉。
       *
       * 后果：用户从**内网 GitLab / 自建 fork** 部署时，脚本先去探测那个地址（多余，
       * 还可能卡 15s），探测不通就把官方 Gitee 镜像顶上去 —— 装出来的是别人的代码。
       * 「纠正用户」比装不上更糟：它悄悄换了源码来源却不报错。
       */
      name: 'R63-04a · 显式 --repo 也被探测并替换（内网 / 自建 fork 被官方镜像顶掉）',
      file: 'deploy.sh',
      anchor: '  if [[ "$REPO_URL" != "$DEFAULT_REPO_URL" ]]; then\n    printf \'%s\' "$REPO_URL"\n    return 0\n  fi',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R63-05a：走镜像分支不再调用 `warn_mirror_staleness`。
       *
       * 这正是用户提这件事的**理由**：「gitee 极有可能不是最新版」。装一份落后于
       * 官方的代码却不吭声，用户只能在「功能怎么没有」的工单里反推原因。
       * 提示里必须带实际 commit，否则「落后多少」无从谈起。
       */
      name: 'R63-05a · 走镜像时不再提示「可能不是最新版」（用户不知道装的是旧代码）',
      file: 'deploy.sh',
      anchor: '  if [[ "$clone_url" == "$MIRROR_REPO_URL" ]]; then\n    warn_mirror_staleness "$SRC_DIR"\n  fi',
      replacement: '  : # 镜像新鲜度提示已移除',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R63-06a：失败提示里的诊断命令退回 `curl -sI https://github.com`。
       *
       * 与 R63-02a 同一条坑的用户侧版本：用户照着提示自证网络，curl 说通、clone
       * 却失败（或反过来），于是把问题归到脚本「乱报错」上。诊断命令必须与克隆
       * 走同一条路，结论才有意义。
       */
      name: 'R63-06a · 失败提示退回 curl -I github.com（用户自证的结论与克隆相反）',
      file: 'deploy.sh',
      anchor: '    add_hint "  3) 检查网络（与克隆同一条路）：git ls-remote ${REPO_URL} ; echo \\$?"',
      replacement: '    add_hint "  3) 检查网络：curl -sI https://github.com -m 8 ; echo \\$?"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * R64-01a：订单号的格式判据退化成「只要是字母数字就行」。
       *
       * 后果：16 位的老订单 id、甚至任意一串都能通过 `isOrderNo()`，「36 位」这条
       * 用户需求失去约束 —— 而界面上看不出任何异常（订单号照样生成、照样能取回）。
       */
      name: 'R64-01a · 订单号格式判据退化成「字母数字即可」（36 位约束失效）',
      file: 'server/order-no.js',
      anchor: '  return v.length === ORDER_NO_LEN && /^[1-9]\\d{12}[0-9A-Za-z]{23}$/.test(v);',
      replacement: '  return /^[0-9A-Za-z_-]+$/.test(v);',
      testFile: 'share-orders.test.js',
      minFail: 2,
    },
    {
      /*
       * R64-02a：`claimForLink` 把「支付成功」这条前提放宽成「付过或正在付」。
       *
       * 后果：需求里那句「所有前提建立在订单状态是支付成功」被悄悄破掉 ——
       * 一个刚下单还没付款（甚至支付失败）的订单号就能换到下载权限。
       *
       * ⚠️ R65 同步：`paid` 分支从单行 `return` 展开成了一个块（里面要先判取回配额），
       * 旧 anchor（那行单行 return）已不在源码里。anchor 改为**分支头那一行**
       * （全文唯一，且是纯代码行 —— 注释会被剥成等长空白，不能进 anchor）。
       * 刻意**不**连带下一行：`paid` 分支头与 `const max` 之间隔着一整块注释，
       * 带 `\n` 拼两行的写法在这里必然命不中（本轮实测踩过）。
       */
      name: 'R64-02a · 恢复购买不再要求「支付成功」（pending 也能换到下载权限）',
      file: 'server/payment-orders.js',
      anchor: "  if (o.status === 'paid') {",
      replacement: "  if (o.status === 'paid' || o.status === 'pending') {",
      testFile: 'share-orders.test.js',
      minFail: 2,
    },
    {
      /*
       * R64-03a：免费下载台账不再去重。
       *
       * 后果：需求 2②「只展示第一次下载的记录，重复下载不计」失效 —— 历史订单里
       * 同一个文件按下载次数重复出现，并且每次下载都多写一条落盘记录。
       */
      name: 'R64-03a · 免费下载不再去重（重复下载逐条累加）',
      file: 'server/download-log.js',
      anchor: '    if (seen.has(dedupe)) continue;',
      replacement: '    if (false) continue;',
      testFile: 'share-orders.test.js',
      minFail: 2,
    },
    {
      /*
       * R64-04a：历史订单页不再为已支付订单补发票据。
       *
       * 后果：这一页的「重新下载」全都指向仍要求付款的分享页 —— 用户明明买过，
       * 点进去还是付费墙（功能看起来"能看订单"，实际一步也走不通）。
       */
      name: 'R64-04a · 历史订单不补发票据（点重新下载仍回到付费墙）',
      file: 'server/share-routes.js',
      anchor: "    if (o.status !== 'paid') continue;",
      replacement: '    continue;',
      testFile: 'share-orders.test.js',
      minFail: 1,
    },
    {
      /*
       * R65-01a：撤掉「按订单号的取回次数上限」。
       *
       * 后果：需求 1 完全失效 —— 一枚订单号可以被无限次取回，把它转发给谁都能拿到
       * 下载权限。`R65-04` 与 `R65-07` 各自从「函数层」与「HTTP 层」钉这件事，
       * 故预期**两条**都红（`minFail` 写 2，不许顺手调小）。
       */
      name: 'R65-01a · 取回次数上限被撤（同一订单号无限次取回）',
      file: 'server/payment-orders.js',
      anchor: '    if (limit > 0 && used >= limit) {',
      replacement: '    if (false) {',
      testFile: 'restore-settings.test.js',
      minFail: 2,
    },
    {
      /*
       * R65-02a：把封禁判定泄漏到**分享页浏览**上（需求 3 点名的就是这件事）。
       *
       * 后果：一个 IP 在取回时连续输错几次，之后连分享页都打不开 —— 一处
       * 只该管「取回」的限速闸门顺手升级成全网封锁。`R65-08` 就是这条的护栏。
       */
      name: 'R65-02a · 取回封禁泄漏到分享页浏览（封禁变成全网封锁）',
      file: 'server/share-routes.js',
      anchor: '  const viewRl = security.shareViewLimiter(security.clientIp(req));\n',
      replacement: "  if (restoreGuard.isBanned(security.clientIp(req)).banned) return res.status(429).send('blocked');\n  const viewRl = security.shareViewLimiter(security.clientIp(req));\n",
      testFile: 'restore-settings.test.js',
      minFail: 1,
    },
    {
      /*
       * R65-03a：管理端「解封」不再真的删记录（过滤条件恒真）。
       *
       * 后果：界面上点了「解封」、接口回 200，`removed` 却是 false（界面提示
       * 「当前未被限制」），被封的 IP 仍然进不去 —— 需求 3 的可解封承诺失效。
       */
      name: 'R65-03a · 管理端解封不生效（过滤条件恒真）',
      file: 'server/restore-guard.js',
      anchor: '  g.bans = g.bans.filter((b) => ipKey(b.ip) !== key);',
      replacement: '  g.bans = g.bans.filter(() => true);',
      testFile: 'restore-settings.test.js',
      minFail: 2,
    },
    {
      /*
       * R65-04a：给卡片塞回一个开关（需求 4：该卡片不需要开关）。
       *
       * 后果：出现「关闭」状态后，这条匿名取回通道在关掉时**无任何限制**，
       * 比默认开着更糟；而且这个开关与「两个值落盘即生效」的语义互相矛盾。
       */
      name: 'R65-04a · 「订单取回」卡片被加回启用开关（破坏需求 4）',
      file: 'public/index.html',
      anchor: '                  <label>取回次数限制</label>',
      replacement: '                  <input type="checkbox" id="restore-enabled" checked>\n                  <label>取回次数限制</label>',
      testFile: 'restore-settings.test.js',
      minFail: 1,
    },
    {
      /*
       * R65-05a：「连续」语义被破坏 —— 成功一次不再清零。
       *
       * 后果：这枚 IP 一辈子只能错 `maxFails` 次，跨天、跨月、跨重启都不恢复；
       * 用户偶尔手误敲错一次，几个月后攒满就被封 24 小时，且完全不明白为什么。
       */
      name: 'R65-05a · 成功取回不清零（「连续」退化为「累计」）',
      file: 'server/restore-guard.js',
      anchor: '  if (key) counters.delete(key);',
      replacement: '  if (false) counters.delete(key);',
      testFile: 'restore-settings.test.js',
      minFail: 1,
    },
    {
      /*
       * R66-01a：CI 的安装步骤退化成 `npm install`。
       *
       * 后果：CI 不再严格按 lockfile 装依赖 —— 装了与锁文件不同的版本，本地绿、CI 红
       * （或反过来）的来源就多了一条，而这条差异最难归因。判据在
       * `repo-hygiene.test.js` 里看的是 `run:` 行本身，不是「全文出现过 npm ci」。
       */
      name: 'R66-01a · CI 安装步骤退化成 npm install（不再按 lockfile）',
      file: '.github/workflows/ci.yml',
      anchor: '        run: npm ci',
      replacement: '        run: npm install',
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },
    {
      /*
       * R66-02a：测试把数据目录写死成仓库的 `data/`（R66 修掉的那个缺陷本身）。
       *
       * 后果：`protectData()` 的「备份→还原」保护的是本进程根本不会写的目录，
       * 而那层保险看起来一直在。
       */
      name: 'R66-02a · 测试把数据目录写死成仓库 data/（隔离失效）',
      file: 'tests/crypto-storage.test.js',
      anchor: "const DATA = process.env.S3_DATA_DIR || path.join(ROOT, 'data');",
      replacement: "const DATA = path.join(ROOT, 'data');",
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },
    {
      /*
       * R66-03a：元数据的 keyId 盖章写了个非法值。
       *
       * 后果：将来轮换密钥时，这批密文的密钥归属是错的 —— 而这正是「1% 成本买
       * 10 倍选择权」的那个 1%。`keyIdOf()` 会把 0 当非法值回落到 1，所以光看
       * 「能解密」是发现不了的，必须断言落盘值本身。
       */
      name: 'R66-03a · 元数据的 keyId 被写成非法值（轮换时无从判断密钥归属）',
      file: 'server/enc-store.js',
      anchor: '  meta.keyId = CURRENT_KEY_ID;',
      replacement: '  meta.keyId = 0;',
      testFile: 'crypto-storage.test.js',
      minFail: 1,
    },
    {
      /*
       * R66-04a：`/health` 的运维字段不再按角色分档（谁都拿得到）。
       *
       * 后果：普通用户拿到「这台实例一共几个桶」——跨用户规模信息；而 `/health`
       * 只要求登录、不挂 requireAdmin，所以这个泄漏是**任何登录用户**都能取的。
       */
      name: 'R66-04a · /health 的 bucketCount 不再按角色分档（普通用户可见）',
      file: 'server/routes/stats.js',
      anchor: "  if (req.authUser && roles.isStaff(req.authUser.role)) {",
      replacement: '  if (true) {',
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },
    /* ======================= 第 67 轮：拆包不变量 ======================= *
     * 这三条的性质与其他条目不同：它们撤销的不是「某个修复」，而是把**结构**改坏。
     * 之所以也要登记，是因为结构坏掉时**没有任何行为测试会变红**（见 repo-hygiene 里
     * 那三条用例上方的说明）—— 不登记就等于承认「这三条护栏没人验过」。
     */
    {
      /**
       * R67-01a：把 `xml.js` 的引用换成就地手写（孤儿化的最常见形态）。
       *
       * 这比「删掉 require」更真实：删掉会让运行时立即报 `propResponse is not defined`，
       * 而**就地补两个空函数**能让所有行为测试继续通过 —— 只有「每个模块都必须被 require」
       * 这条结构断言能发现 `xml.js` 已经没人用了。
       */
      name: 'R67-01a · 包内模块被就地重写（xml.js 变成没人 require 的孤儿）',
      file: 'server/webdav/app.js',
      anchor: "const { propResponse, multistatus } = require('./xml');",
      replacement: "const propResponse = () => '';\nconst multistatus = () => '';",
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },
    {
      /**
       * R67-02a：让下层反向 require `./app` —— 依赖成环的入口。
       *
       * 成环的表现不是报错，而是「某个导出在启动时是 undefined」，所以只能靠结构断言抓。
       */
      name: 'R67-02a · 下层模块反向 require ./app（依赖成环）',
      file: 'server/webdav/defs.js',
      anchor: "const { translateError } = require('../s3');",
      replacement: "const { translateError } = require('../s3');\nrequire('./app');",
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },
    {
      /**
       * R67-03a：在入口文件里顺手注册一条路由 —— 拆包被「磨平」的第一天。
       */
      name: 'R67-03a · 入口文件里重新注册路由（协议实现搬回 facade）',
      file: 'server/webdav-server.js',
      anchor: 'function start() { return apply(); }',
      replacement: "function start() { app.get('*', () => {}); return apply(); }",
      testFile: 'repo-hygiene.test.js',
      minFail: 1,
    },

    /* ==================================================================
     * R68：协议提示与两份协议正文（三页提示在「站点设置」，正文在「协议设置」）
     *
     * 每条对应的行为护栏在 `tests/agreement-settings.test.js`。这一轮的变异有个
     * 共同点：**都不会让服务起不来**，界面上也照样能点能存 —— 唯一的症状是
     * 「访客能打出脚本」或「点了没反应」。所以判据必须落在渲染结果与 HTTP 往返上，
     * 而不是「源码里有没有这个词」。
     * ================================================================== */
    {
      /**
       * R68-01a：把「整段转义」换成黑名单思路的第一步 —— `<` 不再转义。
       *
       * 这是最常见的写法：只过滤 `<script>` 之类的危险标签，其余原样放行。
       * 变异只动 `<` 这一行（不碰 `>`），语法照旧、页面照旧显示，只有
       * 「正文里写了 `<img onerror=…>`」时才会在访客浏览器里真的执行。
       */
      name: 'R68-01a · escapeHtml 不再转义 <（退回黑名单过滤思路）',
      // 实测 fail=2：`R68-06`（原始标签必须转义成实体）、`R68-08`（提示文案里 `<b>` 当文字）
      file: 'server/agreement-text.js',
      anchor: ".replace(/</g, '&lt;')",
      replacement: ".replace(/</g, '<')",
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-02a：链接白名单被放宽成「只要没空白就行」。
       *
       * `[点我](javascript:alert(1))` 于是原样进了 `href` —— 而协议正文由管理员填写、
       * 展示给匿名访客，等于给登录页开了一个可持久化的 XSS 入口。
       */
      name: 'R68-02a · 链接白名单被放宽（javascript: 直通 href）',
      // 实测 fail=1：`R68-07` —— 正是补上的「不带括号的 javascript: / data: 必须被拒」两条（原先那条带括号的写法压根没走到白名单，实测 `fail=0`）
      file: 'server/agreement-text.js',
      anchor: "const SAFE_HREF_RE = /^(?:https?:\\/\\/|mailto:|\\/)[^\\s]*$/i;",
      replacement: 'const SAFE_HREF_RE = /^[^\\s]*$/i;',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-03a：正文为空的那一份**仍被做成链接**。
       *
       * 症状是「点开一个空白对话框并出现关闭按钮」，比起不给链接更让人以为系统坏了。
       */
      name: 'R68-03a · 正文为空的协议仍被做成链接（点开是空对话框）',
      // 实测 fail=2：`R68-10`、`R68-13` —— 都是「空正文的那一份仍被做成链接」
      file: 'server/agreement-text.js',
      anchor: '    if (has[key]) {',
      replacement: '    if (true) {',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-04a：第二个 `<a>` 不再归到隐私协议（一律当用户协议）。
       *
       * 需求给的例子就是「同意<a>用户协议</a>和<a>隐私政策</a>」这种不写属性的写法，
       * 分类一错，两个链接会指向同一份正文 —— 界面上看不出来，只能靠渲染结果断言。
       */
      name: 'R68-04a · 第二个 <a> 也归到用户协议（按出现顺序的分类失效）',
      // 实测 fail=3：`R68-08`、`R68-10`、`R68-18` —— 都靠「第 2 个链接指向 privacy」这个事实
      file: 'server/agreement-text.js',
      anchor: "  return index === 2 ? 'privacy' : 'terms';",
      replacement: "  return 'terms';",
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-05a：notices 归一化只补两页 —— 分享页从此缺键。
       *
       * 设置页读 `notices.share.enabled` 时拿到 `undefined`（三行输入框直接崩），
       * 分享页那条判据也永远拿不到「开」的状态。
       */
      name: 'R68-05a · notices 归一化漏掉分享页（设置页读 undefined 崩溃）',
      // 实测 fail=7：`R68-01/02/03/15/18/20/21` —— 缺页会从「默认值」「归一化」「往返」「分享页」「备份」五个方向同时炸出来
      file: 'server/config-store.js',
      anchor: '  for (const page of NOTICE_PAGES) {\n'
        + '    const e = (s[page] && typeof s[page] === \'object\') ? s[page] : {};',
      replacement: '  for (const page of [\'login\', \'register\']) {\n'
        + '    const e = (s[page] && typeof s[page] === \'object\') ? s[page] : {};',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-06a：分享页的**错误页**也把提示摆出来。
       *
       * 链接不存在 / 已过期 / 次数用尽的页面上写着「继续下载即代表您已同意…」——
       * 那个页面上根本没有「继续下载」这个动作。
       */
      name: 'R68-06a · 分享页错误页也显示协议提示（页面上没有该动作）',
      // 实测 fail=1：`R68-19` —— 错误页上不得出现「继续下载即代表…」
      file: 'server/share-routes.js',
      anchor: '    noNotice: true,',
      replacement: '    noNotice: false,',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-07a：提示文案的长度上限被放宽 10 倍。
       *
       * 单行输入框的 300 字上限是「这行字要摆在登录按钮下面」的版式约束；
       * 放宽之后 400 不再被拒，前端也没有任何提示，用户只会看到按钮被挤到屏幕外。
       */
      name: 'R68-07a · 提示文案上限被放宽（超长不再 400 拒绝）',
      // 实测 fail=1：`R68-15` —— 301 字文案必须 400
      file: 'server/limits.js',
      anchor: 'const NOTICE_TEXT_MAX = 300;',
      replacement: 'const NOTICE_TEXT_MAX = 3000;',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-08a：协议正文的长度上限被放宽 10 倍。
       *
       * 上限本身是「这份正文要随 `/site/agreements` 匿名下发」的约束 ——
       * 没有上限时，一份 20 万字的协议会让每次打开登录页都先下载它。
       */
      name: 'R68-08a · 协议正文上限被放宽（超长不再 400 拒绝）',
      // 实测 fail=2：`R68-14`（保存超长正文必须 400）、`R68-17`（预览同样走这条上限）
      file: 'server/limits.js',
      anchor: 'const AGREEMENT_BODY_MAX = 20000;',
      replacement: 'const AGREEMENT_BODY_MAX = 200000;',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-09a：备份的 `collect()` 不再采集协议正文。
       *
       * 这是「只备份了开关、没备份正文」的精确形态：备份范围清单里仍写着「协议设置」，
       * 界面上看不出少了一样东西，而导入之后三页提示全在、点开全是空的。
       * 刻意**不动 `SCOPES`** —— 否则 `audit38` 的「10 个可见项」也会一起变红，
       * 红的就不唯一了（`minFail` 只为「应该红几条」兜底，不负责指出是哪几条）。
       */
      name: 'R68-09a · 备份不再采集协议正文（只备份了开关）',
      // 实测 fail=1：`R68-21` —— 备份载荷里没有 agreements 时，往返断言直接读不到
      file: 'server/backup.js',
      anchor: '    agreements: sanitizeAgreements(configStore.getAgreements()),',
      replacement: '    agreements: undefined,',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-10a：公开接口把「开关」当成「显示」，不再要求「有正文」。
       *
       * 三页全关而正文非空时，`show` 会全部变成 true；更糟的是开关关着的页面
       * 也会收到渲染好的提示 HTML。
       */
      name: 'R68-10a · 公开接口把「有正文」当成「该显示」（忽略开关）',
      // 实测 fail=1：`R68-13` —— 未开的注册页 / 分享页也被判成「显示」
      file: 'server/agreement-view.js',
      anchor: '    const on = n.enabled === true && anyAvailable;',
      replacement: '    const on = anyAvailable;',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-11a：登录页提示不再区分四种形态 —— 一律按登录页渲染。
       *
       * `init`（创建管理员）与 `forgot`（重置密码）不是「登录 / 注册」，
       * 在那些界面上摆一句「登录即代表您已同意…」是纯粹的误植。
       */
      name: 'R68-11a · 提示在「创建管理员 / 重置密码」形态下也渲染',
      // 实测 fail=1：`R68-24` —— 那行三元表达式是「只在 login / register 渲染」的唯一实现点
      file: 'public/js/main.js',
      anchor: "  const page = authMode === 'login' ? 'login' : (authMode === 'register' ? 'register' : '');",
      replacement: "  const page = 'login';",
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },
    {
      /**
       * R68-12a：协议对话框去掉「关闭」按钮。
       *
       * 需求原话点名要求「有关闭按钮」。剩下右上角 ✕ 与 Esc 也能关，
       * 所以这是「功能没坏、要求没做到」的类型 —— 只能靠结构断言钉住。
       */
      name: 'R68-12a · 协议对话框去掉「关闭」按钮（需求点名要求）',
      // 实测 fail=1：`R68-25` —— 需求点名要求的「关闭」按钮不见了
      file: 'public/js/util.js',
      anchor: "    foot: [{ text: '关闭' }],\n",
      replacement: '',
      testFile: 'agreement-settings.test.js',
      minFail: 1,
    },

    /* ---------------------------- R69（安全漏洞分析报告修复） ---------------------------- */
    {
      /**
       * R69-01a：登录遮罩打开时把「用户名」回填进密码框 —— 恢复「密码驻留客户端」的
       * 最小可观测形态。
       *
       * 撤掉后：`pwInput.value = ''` 变成回填，判据 `R69-01` 立刻红。这条不验证
       * 「有没有再引入加密/异或」，只验证「登录页绝不往密码框里塞任何值」。
       */
      name: 'R69-01a · 登录页把已有值回填进密码框（回到「密码驻留客户端」）',
      // 实测 fail=1：`R69-01`
      file: 'public/js/main.js',
      anchor: "  pwInput.value = '';",
      replacement: "  pwInput.value = String(saved.username || '');",
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-02a：勾选框文案退回「会保存密码」的说法。
       *
       * 撤掉后：页面不再声明「不保存密码」，而功能上确实不保存 —— 只剩用户
       * 自己猜。判据 `R69-02` 是**三个词**的组合（有「记住用户名」/ 无「记住密码」/
       * 有「不保存密码」），改任何一个都会红。
       */
      name: 'R69-02a · 登录页文案不再声明「不保存密码」',
      // 实测 fail=1：`R69-02`
      file: 'public/index.html',
      anchor: '不保存密码',
      replacement: '密码仅做混淆',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-03a：部署模式下 `/auth/init` 不再验安装令牌 —— H-2 的原始形态。
       *
       * 撤掉后：匿名请求又能在「进程已启动、所有者还没打开页面」的窗口里创建管理员。
       * 判据 `R69-04` 走真 HTTP（无令牌 / 错令牌都必须 403 且不留账户）。
       */
      name: 'R69-03a · 部署模式 /auth/init 不验安装令牌（管理员抢占窗口重开）',
      // 实测 fail=2：`R69-04`（无令牌与错令牌都 200 了，两条各红一次）
      file: 'server/routes/auth.js',
      anchor: "    if (setupTokenRequired()) {\n      const given = String((req.body && req.body.setupToken) || req.get('x-setup-token') || '').trim();",
      replacement: "    if (false) {\n      const given = '';",
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-04a：用户名重新允许 `@` —— M-2 的原始形态（可与邮箱空间重叠）。
       *
       * 撤掉后：`a@b.com` 这类用户名会与邮箱找回通道撞车。判据 `R69-06` 断言的是
       * **错误文案**（「不能包含 @」），所以它同时钉住了「白名单也不许含 @」——
       * 只把 @ 从白名单里去掉而不加专项检查，文案会变成通用格式错，同样会红。
       */
      name: 'R69-04a · 用户名重新允许 @（与邮箱空间重叠，可劫持找回通道）',
      // 实测 fail=1：`R69-06`
      file: 'server/config-store.js',
      anchor: "  if (name.includes('@')) {",
      replacement: '  if (false) {',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-05a：scrypt 成本参数退回 N=16384。
       *
       * 撤掉后：哈希成本降 8 倍（内存 16MB vs 128MB），离线爆破提速一个量级。
       * 判据 `R69-08` 同时断言「参数值」与「参数真的进算法」（两种 N 的哈希必须不同）。
       */
      name: 'R69-05a · scrypt 成本参数退回 N=16384（离线爆破成本降一个量级）',
      // 实测 fail=3：`R69-08`（参数值）、`R69-09`（旧哈希被判为「能用新参数验过」）、
      // `R69-10`（新建用户的 passwordParams 跟着退回 16384）
      file: 'server/config-store.js',
      anchor: 'const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };',
      replacement: 'const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-06a：`permissions` 非空不再被拒 —— 管理员又能"设置"一个不生效的权限。
       *
       * 判据 `R69-12` 走真 HTTP：非空必须 400 且不留账户，空对象必须放行。
       */
      name: 'R69-06a · 非空 permissions 重新被接受（给出「已限制」的假象）',
      // 实测 fail=1：`R69-12`
      file: 'server/routes/users.js',
      anchor: '  if (Object.keys(permissions).length === 0) return null;',
      replacement: '  return null;',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-07a：注册冲突的全局预算被放到形同虚设（30 → 10000）。
       *
       * 撤掉后：oracle 的带宽回到「每 10 分钟 10000 次」，等于没限。判据 `R69-13`
       * 直接驱动预算：30 次放行、第 31 次必须拒。
       */
      name: 'R69-07a · 注册冲突预算被放大到形同虚设（枚举带宽回到不设限）',
      // 实测 fail=1：`R69-13`
      file: 'server/security.js',
      anchor: "const registerConflictLimiter = createLimiter({ name: 'auth-register-conflict', windowMs: 10 * 60 * 1000, max: 30 });",
      replacement: "const registerConflictLimiter = createLimiter({ name: 'auth-register-conflict', windowMs: 10 * 60 * 1000, max: 10000 });",
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-08a：账户级减速上限清零 —— 跨 IP 撞库重新变成"不限速"。
       *
       * 判据 `R69-15` 断言「第 21 次起延迟 > 0 且 ≤ 1500」。改上限或改阈值都会红。
       */
      name: 'R69-08a · 账户级减速上限清零（分布式撞库不再被拖慢）',
      // 实测 fail=1：`R69-15`
      file: 'server/security.js',
      anchor: 'const ACCOUNT_FAIL_DELAY_MAX_MS = 1500;',
      replacement: 'const ACCOUNT_FAIL_DELAY_MAX_MS = 0;',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-09a：XFF 退回「永远取首段」—— M-4 的原始形态。
       *
       * 撤掉后：追加式反代 / CDN 链路下，请求方自己写的第一段就是"你的 IP"，
       * 一个请求换一个合法地址即可轮换限流键、撤销封禁。判据 `R69-16` 直接用
       * `TRUST_PROXY_HOPS=1` 的配置驱动 `forwardedClientIp()`。
       */
      name: 'R69-09a · XFF 退回永远取首段（请求方可自选 IP，限流/封禁可轮换）',
      // 实测 fail=1：`R69-16`
      file: 'server/security.js',
      anchor: '  const idx = TRUST_PROXY_HOPS > 0\n    ? Math.max(0, Math.min(parts.length - 1, parts.length - TRUST_PROXY_HOPS))\n    : 0;',
      replacement: '  const idx = 0;',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-10a：限流器 hits 表去掉硬上限 —— L-8 的原始形态。
       *
       * 撤掉后：每个新键都永久留下一条记录，IPv6 场景下是无界内存增长。
       * 判据 `R69-17` 用 `maxEntries: 2` 造淘汰，被淘汰的键必须重新从 1 计数。
       */
      name: 'R69-10a · 限流 hits 表去掉硬上限（IPv6 慢速内存 DoS 重开）',
      // 实测 fail=1：`R69-17`
      file: 'server/security.js',
      anchor: '      if (!rec && hits.size >= maxEntries) {',
      replacement: '      if (!rec && hits.size >= 1e9) {',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-11a：查单金额不再对账 —— I-5 的原始形态。
       *
       * 撤掉后：网关说 paid 就发货，"付 1 分买 100 元"这条纵深缺口重新打开。
       * 判据 `R69-20` 拦真 fetch、造「实付 1 分 / 应付 1 元」。
       */
      name: 'R69-11a · 查单不再核对金额（付 1 分也能确认 1 元的订单）',
      // 实测 fail=1：`R69-20`
      file: 'server/payment-gateway.js',
      anchor: '  if (Math.abs(want - got) > AMOUNT_TOLERANCE_FEN) {',
      replacement: '  if (false) {',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-12a：「每人一次」退回读**被截断的台账** —— L-1 的原始形态。
       *
       * 撤掉后：第 201 次核销之后，最早那位用户又能用同一张券。判据 `R69-21`
       * 刻意「先让第一个身份用完、再灌满台账把它挤出 uses」，顺序反过来测不到。
       */
      name: 'R69-12a · 「每人一次」退回读 200 条截断台账（第 201 次后可重复用）',
      // 实测 fail=1：`R69-21`（第一个身份能二次使用）
      file: 'server/coupon-store.js',
      anchor: "    if (!who || (Array.isArray(c.identities) ? c.identities : []).indexOf(who) >= 0) return fail('already_used');",
      replacement: "    if (!who || c.uses.map((u) => u.identity).indexOf(who) >= 0) return fail('already_used');",
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-13a：「确认不存在」的判据退化成恒真 —— L-12 的核心。
       *
       * 撤掉后：403 / 5xx / 网络错误全部被当成「目标不存在」，随后的复制/移动照样
       * 写入，云端覆写不可撤销。判据 `R69-22` **把源文件里这个函数的原文切出来执行**
       * —— 只查「源码里有 isNotFoundError」挡不住 `return true` 这种退化。
       */
      name: 'R69-13a · isNotFoundError 退化成恒真（403/网络错误被当成「不存在」）',
      // 实测 fail=1：`R69-22`（切源文件里的函数原文执行，403 那条断言先红）
      file: 'server/routes/fs.js',
      anchor: "  const sc = e.statusCode === undefined ? e.status : e.statusCode;\n  if (Number(sc) === 404) return true;\n  return /NoSuchKey|NotFound/i.test(String(e.code || ''));",
      replacement: '  return true;',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-14a：声明了 256KB 解析器却不调用 —— I-4 的「又一句死代码」形态。
       *
       * 撤掉后：`/pay/notify/*` 回到 2MB 上限，匿名面内存放大 8 倍。
       * 判据 `R69-23` 同时钉「顺序」（256KB 早于 2MB）与「真的调用」。
       */
      name: 'R69-14a · 256KB 解析器只声明不调用（通知端点回到 2MB 上限）',
      // 实测 fail=1：`R69-23`
      file: 'server/index.js',
      anchor: '  return NOTIFY_BODY_LIMIT_PARSER(req, res, next);',
      replacement: '  return next();',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-15a：Node 二进制包不再校验哈希 —— L-11 的原始形态。
       *
       * 撤掉后：`curl` 下来的 tar.gz 直接解到 `/usr/local`，镜像/代理/缓存任何一跳
       * 都能换掉将要运行的 node。判据 `R69-24` 断言「校验调用存在且在解压之前」。
       */
      name: 'R69-15a · Node 二进制包不校验 SHA-256（下载即解压到 /usr/local）',
      // 实测 fail=1：`R69-24`
      file: 'deploy.sh',
      anchor: '  verify_node_tarball "${tmp}/node.tar.gz" "$ver" "$NODE_ARCH" "$base"\n',
      replacement: '',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-16a：restore-guard 只 `set` 不 `delete` —— I-17 的「注释与实现不符」。
       *
       * 撤掉后：Map 的插入序 = 首次插入序，淘汰的不是「最久未活动」而是「最早出现」，
       * 刚在用的 IP 反而可能被丢掉（连同它的连击计数一起归零）。
       */
      name: 'R69-16a · restore-guard 只 set 不 delete（淘汰顺序退回首次插入序）',
      // 实测 fail=1：`R69-25`
      file: 'server/restore-guard.js',
      anchor: '  counters.delete(key);\n  counters.set(key, { fails, lastAt: now });',
      replacement: '  counters.set(key, { fails, lastAt: now });',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R69-17a：`GET /s/:id` 不再限流 —— L-2 的原始形态。
       *
       * 撤掉后：匿名访客并发请求同一个分享 URL 就能把云端调用放大 N 倍。
       * 判据 `R69-26` 要求「两个入口共用同一枚限流器」且「限流早于 shareStore.get」。
       */
      name: 'R69-17a · GET /s/:id 不再限流（分享页入口可被并发放大）',
      // 实测 fail=1：`R69-26`（限流器出现次数掉到 1）
      file: 'server/share-routes.js',
      anchor: '  const viewRl = security.shareViewLimiter(security.clientIp(req));',
      replacement: '  const viewRl = { ok: true, retryAfter: 0 };',
      testFile: 'audit69-regressions.test.js',
      minFail: 1,
    },

    /* ============ 第七十轮 · PWA（R70） ============ */
    {
      /**
       * 撤掉后：「快捷方式的名称以站点名称为准」这条需求**整条失效** ——
       * manifest 永远返回一个写死的默认名，界面上完全看不出来（页面标题仍是对的，
       * 只有装到桌面上的那个图标名字不对）。这正是本需求最容易「看着做了」的错法。
       * 判据 `R70-01`/`R70-04` 要求 name/short_name 原样取站点名称。
       */
      name: 'R70-01a · manifest 忽略站点名称（快捷方式名字退回写死值）',
      file: 'server/pwa.js',
      anchor: "  const displayName = name || 'Kepler 对象存储管理系统';",
      replacement: "  const displayName = 'Kepler 对象存储管理系统';",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`short_name` 被截成 12 个字符。Chrome/Edge 建桌面快捷方式**优先取
       * short_name**，于是需求只对了一半，而用户看到的是被截断的那个名字。
       * 判据 `R70-01` 要求两者同值。
       */
      name: 'R70-01b · short_name 被截短（Chrome 建快捷方式优先取它）',
      file: 'server/pwa.js',
      anchor: '    short_name: displayName,',
      replacement: "    short_name: displayName.slice(0, 12),",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：manifest 退回静态同名文件（把动态路由改成读盘）。判据 `R70-03`
       * 断言 `public/` 下不得存在静态 manifest —— 静态文件只能写死一个名字。
       * 这里用「注册顺序」这个等价失效点：把 manifest 路由挪到 static 之后，
       * 静态中间件先返回 404，浏览器判定不可安装。
       */
      name: 'R70-03a · manifest 路由退到 express.static 之后（被静态中间件吃掉）',
      file: 'server/index.js',
      anchor: 'app.get(pwa.MANIFEST_PATH, pwa.manifestHandler);',
      replacement: 'void pwa.MANIFEST_PATH; // 路由挪到 static 之后（见用例说明）',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：版本号替换退回**只替首处**。占位符一旦在模板里出现两次
       * （历史上注释与代码各写一次），`String.replace` 会先命中注释、常量一字未动 ——
       * 而响应里"看起来"确实少了一处占位符，不深查就发现不了。
       * 后果是缓存标签恒为 `dev`，**所有版本共用一个缓存**，发版后用户永远拿旧前端。
       *
       * ⚠️ 本条是 `mutations` 多步，**两步都落在 `server/pwa.js`**（`mutations` 不支持
       * 跨文件：每步只有 anchor / replacement，全部作用于 `file`）。第一步在
       * `renderServiceWorker` 的**函数体内**写一个占位符字面串（模拟注释式写法，
       * 位置在模板拼接之前），第二步把全局替换改回只替首处的 `replace`。
       * 只做第二步是**无效变异**：当前模板里占位符只剩一处，`replace` 也能正确替换 ——
       * 实测 fail=0（这条对照最初就因此假绿），必须两步一起才复现得出该 bug。
       *
       * 判据 `R70-05` 断言的是**代码行**里的 `const VERSION` 已是具体版本号，
       * 而不是「响应里还有没有这个字符串」—— 后者在只替注释时同样成立。
       */
      name: 'R70-05a · 版本号替换退回只替首处（被替换的是注释，常量没动）',
      file: 'server/pwa.js',
      mutations: [
        {
          anchor: "  return String(template || '').split(SW_VERSION_PLACEHOLDER).join(String(version || '0.0.0'));",
          // 变异：先拼一段「注释」到待替换文本前面，再用只替首处的 replace ——
          // 于是被替换掉的是注释里的那一处，真正的 `const VERSION` 原样留下。
          // 这正是模板里注释与代码各写一次时的真实行为。
          replacement: "  const withNote = '// 变异：注释里也写一次 __KEPLER_VERSION__\\n' + String(template || '');\n"
            + "  return withNote.replace('__KEPLER_VERSION__', String(version || '0.0.0'));",
        },
      ],
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：模板里又出现第二个占位符（注释里写一次、代码里写一次）。
       *
       * 这正是本轮实测踩到的真实形态：旧实现用只替首处的 `String.replace`，
       * 于是被替换的是**注释**、`const VERSION` 一字未动 —— 而响应里"看起来"
       * 确实少了一处占位符。判据 `R70-06` 断言占位符在模板里**恰好出现 1 次
       * 且必须落在 `const VERSION` 那一行**。
       *
       * ⚠️ anchor 必须锚在**代码行**上（`const VERSION = …`），不能锚在注释里：
       * `invariants.test.js` 的 anchor 自检是**双侧剥注释后**比对的，整句都在注释里
       * 的 anchor 会被判成「悬空」（实测第一版就这么红了）。注释的注入放在
       * replacement 里 —— 替换文本是变异态，不受那条自检约束。
       */
      name: 'R70-06a · 模板里出现第二个占位符（重新打开「注释先命中」的口子）',
      file: 'public/sw.js',
      anchor: "const VERSION = '__KEPLER_VERSION__';",
      replacement: "// 变异：注释里也写一次 __KEPLER_VERSION__（第二个占位符）\n"
        + "const VERSION = '__KEPLER_VERSION__';",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`/api` 被纳入缓存。换账号后同一 URL 可能直接命中上一个账号的数据，
       * 且这类泄露**没有任何报错**。判据 `R70-07` 逐个路径验 BYPASS_RE。
       */
      name: 'R70-07a · SW 把 /api 纳入缓存（换账号可能读到上一账号的数据）',
      file: 'public/sw.js',
      anchor: "const BYPASS_RE = /^\\/(?:api|s|dav)(?:\\/|$)/i;",
      replacement: "const BYPASS_RE = /^\\/(?:s|dav)(?:\\/|$)/i;",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：缓存名去掉版本号 ⇒ 发版后缓存永不失效 ⇒ 用户永远拿旧前端，
       * 而服务端日志一切正常。判据 `R70-08` 要求 SHELL_CACHE 带 TAG。
       */
      name: 'R70-08a · 外壳缓存名去掉版本号（发版后用户永远拿旧前端）',
      file: 'public/sw.js',
      anchor: "const SHELL_CACHE = 'kepler-shell-' + TAG;",
      replacement: "const SHELL_CACHE = 'kepler-shell';",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`install` 用 `addAll` 一次装齐。只要有一个资源拿不到，**整个安装失败**，
       * 而界面上的表现只是「安装按钮点了没反应」(Chrome 不发 beforeinstallprompt)。
       * 判据 `R70-09` 明确禁止 addAll。
       */
      name: 'R70-09a · install 退回 addAll（一项失败即整个安装失败）',
      file: 'public/sw.js',
      anchor: "    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));",
      replacement: '    await cache.addAll(SHELL);',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`index.html` 不再声明 manifest ⇒ 浏览器根本不知道有这份 manifest，
       * 可安装性归零（且**不会**报任何错，只是安装图标永不出现）。
       * 判据 `R70-10`。
       */
      name: 'R70-10a · index.html 去掉 manifest 声明（可安装性归零且无报错）',
      file: 'public/index.html',
      anchor: '  <link rel="manifest" href="/manifest.webmanifest">',
      replacement: '  <!-- manifest 已移除 -->',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：安装菜单项默认可见。浏览器不支持 / 已装成 App / 不满足可安装性时，
       * 用户点它就等于点了个没反应的东西 —— 比不摆更让人困惑。
       * 判据 `R70-11` 断言它带 hidden 且显隐由 canInstall() 决定。
       */
      name: 'R70-11a · 安装菜单项默认可见（点了没反应）',
      file: 'public/index.html',
      anchor: '<div class="um-item" id="um-install" hidden>安装到桌面</div>',
      replacement: '<div class="um-item" id="um-install">安装到桌面</div>',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`beforeinstallprompt` 回调里直接 `prompt()`。这个事件**每页只发一次**，
       * 在事件里用掉 = 用户之后点菜单永远调不出安装框（Chrome 会静默拒绝）。
       * 判据 `R70-12` 明确禁止在事件回调里调 prompt()。
       */
      name: 'R70-12a · 在 beforeinstallprompt 里直接 prompt（一次性凭据被提前用掉）',
      file: 'public/js/pwa.js',
      anchor: "    deferredPrompt = e;\n    notifyInstallState();",
      replacement: "    deferredPrompt = e;\n    e.prompt();\n    notifyInstallState();",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：SW 注册失败不再被 catch ⇒ 明文 HTTP / 隐私模式下注册被拒，
       * 异常冒泡打断 `init()` 连锁 —— 拿核心功能（登录、上传下载）去换一个增强功能。
       * 判据 `R70-13` 要求 registerServiceWorker 内有 catch。
       */
      name: 'R70-13a · SW 注册失败不再 catch（增强能力拖垮 init 主链路）',
      file: 'public/js/pwa.js',
      anchor: "    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {",
      replacement: "    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => {",
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：图标 PNG 的圆角没了（白底矩形铺满四角）。桌面上的快捷方式变成
       * 一个死板的方块 —— 正是需求原文「需要加白底和圆角正方形」要的形状差别。
       * 判据 `R70-14` **解码像素**核对四角 alpha=0。
       */
      name: 'R70-14a · 标准图标去掉圆角（四角变成不透明白底）',
      file: 'public/icons/icon.svg',
      anchor: '<rect width="1024" height="1024" rx="228" fill="#FFFFFF"/>',
      replacement: '<rect width="1024" height="1024" rx="0" fill="#FFFFFF"/>',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：SVG 的白底整块删掉 ⇒ 图标变成透明底上的图形，在深色任务栏或
       * 深色壁纸上几乎看不见（需求明确要求「加白底」）。判据 `R70-16`。
       */
      name: 'R70-16a · 图标 SVG 去掉白底（深色背景下图形几乎不可见）',
      file: 'public/icons/icon.svg',
      anchor: '<rect width="1024" height="1024" rx="228" fill="#FFFFFF"/>',
      replacement: '<!-- 白底已移除 -->',
      testFile: 'audit70-pwa.test.js',
      minFail: 1,
    },
    /* ============================ R71：根用户与管理员越权边界 ============================ */
    {
      /**
       * 撤掉后：「A 能不能管 B」退化成「只要不是普通用户就能管」⇒ 管理员之间又能
       * 互相删除 / 编辑 / 封禁，也就是本轮要修的漏洞原样回来。
       * 判据：`R71 · 判据：「谁管谁」的矩阵`。
       */
      name: 'R71-01a · canManageUser 让管理员也能管管理员（越权回来）',
      file: 'server/roles.js',
      anchor: "  if (actorRole === ADMIN) return normalizeStoredRole(targetRole) === USER;",
      replacement: '  if (actorRole === ADMIN) return true;',
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：删除路由不再判定越权 —— 请求能走到底，目标真的被删。
       * 判据：`R71 · 路由：管理员删除**另一个管理员** ⇒ 403，且目标一字节未改`。
       */
      name: 'R71-02a · 删除路由撤掉越权判定（管理员可删管理员）',
      file: 'server/routes/users.js',
      anchor: "    if (denyIfCannotManage(req, res, target, '删除')) return;",
      replacement: '    // （变异：删掉越权判定）',
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：封禁（软删除）不再受同一道闸门约束 ⇒ 修好了删除却留着封禁，
       * 越权只是换了个按钮。判据：`R71 · 路由：管理员编辑 / 封禁 / 强制登出管理员或根用户 ⇒ 一律 403`。
       */
      name: 'R71-02b · 封禁路由撤掉越权判定（管理员可封管理员/根用户）',
      file: 'server/routes/users.js',
      anchor: "    if (denyIfCannotManage(req, res, target, '封禁')) return;",
      replacement: '    // （变异：删掉越权判定）',
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：第一个账户不再被强制成根用户（请求 admin 就得到 admin）⇒
       * 全新实例没有根用户，而该角色不可再授予 ⇒ 系统永久失去最高权限。
       * 判据：`R71 · 存储：空库的第一个账户**强制**成为根用户`。
       */
      name: 'R71-03a · 空库不再强制第一个账户为根用户',
      file: 'server/config-store.js',
      anchor: '  if (!Array.isArray(cfg.users) || cfg.users.length === 0) return roles.ROOT;',
      replacement: '  if (false) return roles.ROOT;',
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`requireAdmin` 只认 `admin` ⇒ 根用户在每一个管理接口上都拿到 403，
       * 而前端也按同一判据隐藏入口（「登录后什么都没有」）。
       * 判据：`R71 · 路由：根用户通过 requireAdmin 进入管理接口（GET /users 返回全部）`。
       */
      name: 'R71-04a · requireAdmin 退回只认 admin（根用户被当成普通用户）',
      file: 'server/routes/_shared.js',
      anchor: "  if (!u || !roles.isStaff(u.role)) {",
      replacement: "  if (!u || u.role !== 'admin') {",
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：读盘白名单不认 `root` ⇒ 每次 load 都把根用户降级成 user
       * （配置里还是 root，鉴权与界面都按 user），属不可逆的静默降级。
       * 判据：`R71 · 存储：已有 root 时读盘不得把它降级，也不会把别人补成根用户`。
       */
      name: 'R71-05a · 读盘归一不认 root（读一次降一级）',
      file: 'server/roles.js',
      anchor: '  return STORED_ROLES.includes(role) ? role : USER;',
      replacement: "  return ['admin', 'user'].includes(role) ? role : USER;",
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：用户表格不再按角色门控按钮 ⇒ 管理员看到的「删除」是可点的，
       * 点下去才 403（用户会当成系统故障）。判据：`R71 · 前端：用户管理表格…`。
       */
      name: 'R71-06a · 用户表格撤掉按钮门控（他人管理员行可点删除）',
      file: 'public/js/syssettings.js',
      anchor: "          const denied = !isSelf && !iAmRoot && u.role !== 'user';",
      replacement: "          const denied = false;",
      testFile: 'root-role.test.js',
      minFail: 1,
    },
    /* ======================= 第 72 轮：安装令牌可见性 ======================= */
    {
      /**
       * 撤掉后：收尾信息里没有令牌那一行（文件其实还在、服务端也照常校验），
       * 用户装完只能去翻 journalctl —— 正是本轮要修的那个「信息不对称」。
       * 判据：`R72 · 安装令牌：收尾信息里原样打印，没有令牌时不编造`。
       */
      name: 'R72-01a · 收尾信息不再打印安装令牌',
      file: 'deploy.sh',
      anchor: '    log "  ${C_BOLD}安装令牌${C_RESET}：${C_CYAN}${setup_token}${C_RESET}"',
      replacement: '    true',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：`kepler` 菜单顶部不再显示令牌 —— 用户过两天回来重装/改密码，
       * 就再也找不到那串只在「还没初始化」时才需要的东西。
       * 判据：`R72 · 安装令牌：管理菜单顶部显示，初始化完成（文件消失）后不再显示`。
       */
      name: 'R72-02a · 管理菜单不再显示安装令牌',
      file: 'deploy.sh',
      anchor: '      log "  ${C_BOLD}安装令牌${C_RESET}：${C_CYAN}${tk}${C_RESET}"',
      replacement: '      true',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：令牌退回「等到第一次需要才生成」⇒ 部署脚本打印收尾信息时文件还不存在，
       * 收尾信息与管理菜单同时失去意义（这正是 R72 之前的形态）。
       * 判据：`R72 · 服务端：启动即生成安装令牌（不必等页面探活），幂等且初始化后不再生成`。
       */
      name: 'R72-03a · 服务端不再在启动时预生成安装令牌',
      file: 'server/routes/auth.js',
      anchor: '  return ensureSetupToken();',
      replacement: "  return '';",
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },

    /* ==================== R73：设置页四项界面改进 ==================== */
    {
      /**
       * 撤掉后：「订单取回」回到「用户管理」之上 —— 它管的是「已付款的人能怎么用
       * 订单号」，放在账户管理旁边才连得上；挪回去后本轮的位置判据立刻变红。
       *
       * 两步变异（anchor 都必须在**原文**里已存在，见 R53-09b 的踩坑说明）：
       * ① 摘掉卡片自己的 id；② 把同一个 id 挂到「用户管理」卡片之前 ⇒ 下标反转。
       */
      name: 'R73-01a · 「订单取回」被挪回「用户管理」之上（位置不对）',
      file: 'public/index.html',
      mutations: [
        { anchor: 'id="sysset-restore-card"', replacement: 'data-r73-moved="sysset-restore-card"' },
        {
          anchor: '            <div class="dash-card wide sysset-card" id="sysset-user-card">\n',
          replacement: '            <span id="sysset-restore-card"></span>\n'
            + '            <div class="dash-card wide sysset-card" id="sysset-user-card">\n',
        },
      ],
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：锚点把**隐藏的**卡片也列进去 —— 管理员看不出问题，但普通用户那边
       * 被 `ADMIN_ONLY_CARDS` 整卡隐藏的卡片会留下一个点了滚不过去的锚点。
       * 判据：R73-03（锚点数 == 可见卡片数，且跳过 hidden）。
       */
      name: 'R73-02a · 锚点栏把隐藏的卡片也列进去（点了个不存在的卡片）',
      file: 'public/js/anchornav.js',
      anchor: "const cards = Array.from(sec.querySelectorAll('.sysset-card')).filter((c) => !c.hidden);",
      replacement: "const cards = Array.from(sec.querySelectorAll('.sysset-card'));",
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：滚动不再减掉锚点栏高度 —— 卡片标题会被那条 sticky 栏压住，
       * 表现为「点了像没定位」。这是本轮最容易被写漏的一处算术。
       * 判据：R73-06（scrollTop == 卡片位置 − 栏高 − 间距）。
       */
      name: 'R73-03a · 滚动不减锚点栏高度（卡片标题被 sticky 栏盖住）',
      file: 'public/js/anchornav.js',
      anchor: '  const top = Math.max(0, sec.scrollTop + (cr.top - sr.top) - barH - 10);',
      replacement: '  const top = Math.max(0, sec.scrollTop + (cr.top - sr.top));',
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：只剩一张卡片（普通用户只看到「关于」）也要摆一条导航栏 ——
       * 一条只指向「关于」的导航是纯噪音。判据：R73-04。
       */
      name: 'R73-04a · 只剩一张卡片时仍显示导航栏（普通用户看到一条空导航）',
      file: 'public/js/anchornav.js',
      anchor: '  if (cards.length < 2) {',
      replacement: '  if (cards.length < 1) {',
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：标题直接取 `h3.textContent` —— 徽章（「站点」）、状态计数与
       * 「保存」按钮的文案会一起被拼进锚点里。判据：R73-05。
       */
      name: 'R73-05a · 锚点标题不摘徽章与按钮（标题变成「站点站点设置 保存」）',
      file: 'public/js/anchornav.js',
      anchor: "  c.querySelectorAll('.sysset-tag, .lk-count, .sysset-action, button, input, label').forEach((n) => n.remove());",
      replacement: '',
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：非 .json 也会被读进内存再解析 —— 备份里含密钥明文，不该去
       * 「猜」用户塞进来的东西。判据：R73-13（断言 FileReader 根本没被调用）。
       */
      name: 'R73-06a · 非 .json 文件也被读取解析（门禁在读文件之后）',
      file: 'public/js/backupcfg.js',
      anchor: '      if (!isBackupJsonFile(name)) {',
      replacement: '      if (false) {',
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：三种失败（空 / 非法 JSON / 缺 code）塌成同一句「文件不对」——
       * 用户无从判断是该换文件、还是这份备份本就坏了。判据：R73-11。
       *
       * 两步变异，中间态语法须自洽（两次都是整句 return 的替换）。
       */
      name: 'R73-07a · 三种解析失败塌成同一句提示（无法判断该怎么办）',
      file: 'public/js/backupcfg.js',
      mutations: [
        {
          anchor: "  if (!raw) return { ok: false, reason: '这个文件是空的' };",
          replacement: "  if (!raw) return { ok: false, reason: '文件不对' };",
        },
        {
          anchor: "    return { ok: false, reason: '不是有效的 JSON —— 文件无法解析，请确认它没有被编辑器改坏' };",
          replacement: "    return { ok: false, reason: '文件不对' };",
        },
      ],
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    {
      /**
       * 撤掉后：初始化页又写回「创建管理员账户」—— R71 起这一页建的是根用户，
       * 说成管理员会让用户误判自己能管到哪一层。判据：R73-16。
       */
      name: 'R73-08a · 初始化页改回「创建管理员账户」（根用户口径回退）',
      file: 'public/js/main.js',
      anchor: "    title.textContent = '创建根用户账户';",
      replacement: "    title.textContent = '创建管理员账户';",
      testFile: 'settings-ux.test.js',
      minFail: 1,
    },
    /**
     * R77（外部审计 F-E1）：缺 IV/TAG 的历史加密元数据必须 fail-closed。
     *
     * 三条各挡一个面，缺一条就会留下一个「撤掉修复仍然全绿」的缺口：
     *  ① 解密期判据 —— 撤掉后老条目重新走「跳过比对」；
     *  ② 写入期判据 —— 撤掉后旧版本会话续传又能落出免检条目（豁免被续命）；
     *  ③ 「失败发生在下发之前」的形态 —— 把失败流退回「直通 + nextTick destroy」，
     *     调用方一旦立刻 `end(密文)`，'end' 会先于 nextTick，密文被当明文吐出去。
     *
     * 判据文件：`tests/audit77-regressions.test.js`（断言后果，不断言源码形状）。
     */
    {
      name: 'R77-01a · 撤掉历史元数据免检判据（缺 IV/TAG 的对象重新静默解密）',
      file: 'server/enc-store.js',
      anchor: "  const legacyAt = segs.findIndex((s) => !s || !s.iv || !s.tag);\n  if (legacyAt >= 0) {\n    if (!legacyUnverifiedAllowed()) {",
      replacement: "  const legacyAt = -1;\n  if (legacyAt >= 0) {\n    if (!legacyUnverifiedAllowed()) {",
      testFile: 'audit77-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R77-02a · 撤掉写入侧 IV/TAG 校验（旧会话续传又能落出免检条目）',
      file: 'server/enc-store.js',
      anchor: "      if (!v || !v.iv || !v.tag) {\n        throw bad(`第 ${n} 分片的加密元数据缺少 IV/TAG（可能来自旧版本的上传会话），请取消任务后重新上传`);",
      replacement: "      if (false) {\n        throw bad(`第 ${n} 分片的加密元数据缺少 IV/TAG（可能来自旧版本的上传会话），请取消任务后重新上传`);",
      testFile: 'audit77-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R77-03a · 失败流退回「直通 + nextTick destroy」（密文被当成明文先吐出去）',
      file: 'server/enc-store.js',
      /**
       * 必须把**整个函数体**退回旧形态，只改 `cb(err)` → `cb()` 是不够的：
       * 自定义 transform 会让 `end()` 的处理推迟到下一轮，`nextTick(destroy)`
       * 反而先到 —— 于是测试仍然全绿（实测 fail=0）。旧形态的要害是
       * **默认直通 Transform**：它会在同一个 tick 里把密文原样推给下游并 `end`，
       * 抢在 destroy 之前。
       */
      anchor: "  const err = new Error(message);\n  const t = new Transform({ transform(chunk, enc, cb) { cb(err); } });",
      replacement: "  const err = new Error(message);\n  const t = new Transform();",
      testFile: 'audit77-regressions.test.js',
      minFail: 1,
    },
    /* ---------------- R78：外部《模块安全审计报告》 ----------------
     *
     * 每条都配了「撤销后必须变红」的判据。特别注意 01a 与 11a：
     * 前者是 R21-01 的**回归形态**（判据对象选错了），后者是「判据写好了却没接上」——
     * 两种都不是"少了一个 if"，只断言源码里有那行字是抓不住的。
     */
    {
      name: 'R78-01a · 加密门禁退回「只看 l.key 一个对象」（多条目/文件夹分享整体绕过）',
      file: 'server/share-routes.js',
      anchor: "  const items = shareStore.view(l, { items: true }).items || [];\n  return items.some((i) => !!encStore.getMeta(l.bucket, i.key));",
      replacement: "  return !!encStore.getMeta(l.bucket, l.key);",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-02a · 复制成功后不再记账（15 分钟缓存窗口内可无限超额）',
      file: 'server/routes/fs.js',
      anchor: "    adjustStorageCache(Math.max(0, addedBytes), cfg);",
      replacement: "    void addedBytes; // R78 反向变异：只过闸门、不记账",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-03a · 单文件复制退回 size:0（配额闸门在"新增 0 字节"下判定）',
      file: 'server/routes/fs.js',
      anchor: "          const sz = await headSize(client, cfg, p.key);",
      replacement: "          const sz = 0;",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-04a · 优惠券筛选参数顺序退回反转（搜索框变成恒真判据）',
      file: 'public/js/couponmgr.js',
      anchor: "      return matchesQuery(state.query, text);",
      replacement: "      return matchesQuery(text, state.query);",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-05a · parseIpInfo 不再折算 IPv4-mapped（v4 规则对 mapped 流量永不命中）',
      file: 'server/ip-guard.js',
      anchor: "    const mapped = mappedV4Int(bytes);\n    if (mapped !== null) return { v6: false, ip: mapped };",
      replacement: "    const mapped = null;\n    if (false) return { v6: false, ip: 0 };",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-06a · 命中计数落盘失败重新抛错（定时器里 = uncaughtException = 崩溃循环）',
      file: 'server/ip-guard.js',
      anchor: "        '—— 计数保留在内存中并会持续重试，进程不会因此退出。');\n    }\n    return false;",
      replacement: "        '—— 计数保留在内存中并会持续重试，进程不会因此退出。');\n    }\n    throw e;",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-07a · 流式下载退回「请求级定时器管整个 body」（大文件必然中途中断）',
      file: 'server/s3-client.js',
      anchor: "        clearTimeout(timeoutTimer);\n        const idleMs = Number(params.__timeoutMs) || this.timeout;",
      replacement: "        const idleMs = Number(params.__timeoutMs) || this.timeout;",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-08a · 回滚副本不再清加密元数据（留下指向已删对象的孤儿记录）',
      file: 'server/fs-gateway.js',
      anchor: "  if (removedKeys.length) encStore.removeMetaBatch(cfg.bucket, removedKeys);",
      replacement: "  if (false) encStore.removeMetaBatch(cfg.bucket, removedKeys);",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-09a · WebDAV 账户不再校验 username 唯一（第二个账户创建成功却永远登不上）',
      file: 'server/config-store.js',
      anchor: "  if (cfg.webdav.accounts.some((a) => a.username === username)) {",
      replacement: "  if (false) {",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-10a · SMTP 收件地址不再折行（CRLF 信头注入）',
      file: 'server/smtp.js',
      anchor: "    to: oneLine(String(o.to || '').trim()),",
      replacement: "    to: String(o.to || '').trim(),",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R78-11a · webauthn 代关路由拆掉「能管谁」判定（管理员可静默拆根用户的二因素）',
      file: 'server/routes/webauthn.js',
      anchor: "    if (denyIfCannotManage(req, res, target, '关闭 Windows Hello 验证')) return;",
      replacement: "    if (false) return; // R78 反向变异：只挂 requireAdmin",
      testFile: 'audit78-regressions.test.js',
      minFail: 1,
    },

    /* ---------------- R79：支付密钥真实解析（L1/L2）+ 等待页按钮无反应 ---------------- */
    {
      /**
       * L1 退回「不解析、一律补 PKCS#8 头」——正是 `1E08010C:DECODER routines::unsupported`
       * 的成因：PKCS#1 裸体（同样以 `MIIE` 开头）被套上 PKCS#8 标签，OpenSSL 解码即失败。
       * 判据落在「签名能否被配对公钥验签」，故撤销后 R79-01 必红。
       */
      name: 'R79-01a · 私钥归一化退回「按前缀猜结构」（裸 PKCS#1 被套错头 ⇒ 1E08010C）',
      file: 'server/payment-gateway.js',
      anchor: '  const parsed = pemKey.normalizePrivateKey(s);\n  if (parsed) return parsed;',
      replacement: "  const parsed = ''; // R79 反向变异：不解析，直接按 PKCS#8 包裹\n  if (parsed) return parsed;",
      testFile: 'audit79-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * L2 退回「头尾成对 / 字符集 + 长度」的近似判据 ⇒ 公钥贴进私钥框、`'A'×240`、
       * 带口令私钥、截断 PEM 全部重新放行。
       * 两层同时变红：R79-02（真实 HTTP 保存端点）与 R79-03（校验器本身）——`minFail: 2`。
       */
      name: 'R79-02a · 私钥校验器退回「只看头尾标记 / 只看长度」（四类错填重新放行）',
      file: 'server/payment-providers.js',
      anchor: "  privateKey(v) {\n    const c = pemKey.classify(v);\n    if (c && c.kind === 'private' && c.type === 'rsa') return true;\n    return pemKey.explain('private', v);\n  },",
      replacement: "  privateKey(v) {\n    // R79 反向变异：退回只看形状的近似判据\n    const s = String(v);\n    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) && /-----END [A-Z ]*PRIVATE KEY-----/.test(s)) return true;\n    if (s.replace(/[\\s\\r\\n]/g, '').length >= 200) return true;\n    return '不是有效的私钥';\n  },",
      testFile: 'audit79-regressions.test.js',
      minFail: 2,
    },
    {
      /**
       * 公钥侧单独退回。只有 R79-03 会红（R79-02 只走 `privateKey` 字段），故 `minFail: 1`
       * —— 这也是「应该红几条」这个问题的答案，比"红了至少一条"更严。
       */
      name: 'R79-03a · 公钥校验器退回「只看头尾标记」（私钥可被贴进公钥框）',
      file: 'server/payment-providers.js',
      anchor: "  publicKey(v) {\n    const c = pemKey.classify(v);\n    if (c && c.kind === 'public' && c.type === 'rsa') return true;\n    return pemKey.explain('public', v);\n  },",
      replacement: "  publicKey(v) {\n    // R79 反向变异：退回只看形状的近似判据\n    const s = String(v);\n    if (/-----BEGIN [A-Z ]*PUBLIC KEY-----/.test(s) && /-----END [A-Z ]*PUBLIC KEY-----/.test(s)) return true;\n    if (s.replace(/[\\s\\r\\n]/g, '').length >= 100) return true;\n    return '不是有效的公钥';\n  },",
      testFile: 'audit79-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 「点了没反应」的原始形态：无条件 303 回 `/s/:id`，结果码丢了。
       * 等待页因此原样重画，`checked=pending` / `checked=recent` 都拿不到 ⇒
       * R79-04 与 R79-05 同时红（前者要 pending、后者要 recent），`minFail: 2`。
       */
      name: 'R79-04a · /pay/check 退回「无条件 303 回分享页」（结果码丢失 ⇒ 按钮点了没反应）',
      file: 'server/share-routes.js',
      anchor: "  const outcome = await finalizeOrderThrottled(l, order);\n  const back = '/s/' + encodeURIComponent(l.id);\n  if (outcome === 'pending' || outcome === 'throttled') {\n    return res.redirect(303, back + '?checked=' + (outcome === 'pending' ? 'pending' : 'recent'));\n  }\n  return res.redirect(303, back);",
      replacement: "  // R79 反向变异：丢掉结果码，一律回分享页\n  await finalizeOrderThrottled(l, order);\n  return res.redirect(303, '/s/' + l.id);",
      testFile: 'audit79-regressions.test.js',
      minFail: 2,
    },
    {
      /**
       * 更细的一种：节流命中（**本轮没出网**）也报 `checked=pending`，
       * 等于告诉用户"已向网关查询"——把"没查"说成"查了没到账"。
       * 只有 R79-05 会红（R79-04 走的是首次点击），故 `minFail: 1`。
       */
      name: 'R79-05a · 节流命中时也谎称「已向网关查询」（把没查说成查了没到账）',
      file: 'server/share-routes.js',
      anchor: "    return res.redirect(303, back + '?checked=' + (outcome === 'pending' ? 'pending' : 'recent'));",
      replacement: "    return res.redirect(303, back + '?checked=' + (outcome === 'pending' ? 'pending' : 'pending'));",
      testFile: 'audit79-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 查单确认已到账却不回报 `paid` ⇒ 已经付过钱的人被留在等待页，
       * 而订单其实已经落库为 paid（状态与界面脱节）。
       */
      name: 'R79-06a · 查单已到账仍回报 pending（已付款用户被留在等待页）',
      file: 'server/share-routes.js',
      anchor: "  if (st === 'paid') return 'paid';",
      replacement: "  if (st === 'paid') return 'pending'; // R79 反向变异",
      testFile: 'audit79-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * `?restart=1` 被忽略 ⇒ 等待页 / 失败页上的「重新支付」又变回自环：
       * GET 回来仍旧命中 pending / failed 分支，页面原样重画。
       */
      name: 'R79-07a · 忽略 ?restart=1（等待页 / 失败页的「重新支付」变回死路）',
      file: 'server/share-routes.js',
      anchor: "    const restart = req.query.restart === '1';",
      replacement: '    const restart = false; // R79 反向变异：忽略 restart',
      testFile: 'audit79-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R80 的原始形态：`!ps.effective` 时 `res.redirect(303, '/s/' + l.id)` ——
       * 页面被原样重画一次，一个字都不解释。撤掉原因码后 R80-01 必红。
       */
      name: 'R80-01a · 付费停用时退回「静默 303 回分享页」（点了没有任何反应）',
      file: 'server/share-routes.js',
      anchor: "    return res.redirect(303, '/s/' + l.id + '?e=pay-off');",
      replacement: "    return res.redirect(303, '/s/' + l.id); // R80 反向变异：静默回去",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 密码票据失效时静默 303 ⇒ 用户既没看到密码框，也不知道该去哪输密码。
       */
      name: 'R80-02a · 密码票据失效时退回「静默 303」而不是渲染密码页',
      file: 'server/share-routes.js',
      anchor: "    return passwordPage(res, l, true,\n      '访问密码的验证状态已失效（可能是浏览器清理了 Cookie，或换了浏览器/隐身窗口），请重新输入访问密码后再支付。');",
      replacement: "    return res.redirect(303, '/s/' + l.id); // R80 反向变异：静默回去",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 已支付分支静默 303 ⇒ `/s/:id` 只是换成"已支付页"，没有一个字说明
       * 「你刚才那次点击为什么没有建单」。
       */
      name: 'R80-03a · 已支付再点退回「静默 303」（不说明这次没有新建订单）',
      file: 'server/share-routes.js',
      anchor: "    return res.redirect(303, '/s/' + l.id + '?e=paid');",
      replacement: "    return res.redirect(303, '/s/' + l.id); // R80 反向变异：静默回去",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 跨站拒绝退回「一律 JSON」⇒ 表单导航的用户落到一片 `{"error":…}` 上，
       * 这与本项目历史上记档的「提交无反应」是同一现象。
       */
      name: 'R80-04a · 跨站拒绝退回「一律返回裸 JSON」（表单提交者看到一片 JSON）',
      file: 'server/share-routes.js',
      anchor: "  if (accept.indexOf('text/html') >= 0) {\n    return statePage(res, 'crosssite');\n  }",
      replacement: "  // R80 反向变异：不再区分调用方，一律 JSON",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * `rsaSign()` 只有 RSA / 非 RSA 两档 ⇒ SM2 会被静默当成 RSA-SHA256，
       * 而 URL 里写着 `sign_type=SM2`：本地一切成功，支付宝必然 ILLEGAL_SIGN。
       */
      name: 'R80-05a · SM2 不再本地拒绝（静默降级成 RSA 签名，跳过去被网关拒）',
      file: 'server/payment-gateway.js',
      anchor: '  const signType = alipaySignType(cfg.signType);',
      replacement: "  const signType = cfg.signType || 'RSA2'; // R80 反向变异：不做任何校验",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 网关地址里的 `#` 会把整串签名参数压进**片段**：浏览器不把片段发给服务器，
       * 支付宝收到空请求 —— 页面"跳过去了"，却一片空白。
       */
      name: 'R80-06a · 网关地址不再剥掉 # 片段（签名参数全落进片段）',
      file: 'server/payment-gateway.js',
      anchor: "  return s.split('#')[0].trim();",
      replacement: '  return s; // R80 反向变异：不剥片段',
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 渠道说"成功"却没给收银台时静默降到「等待支付」页：用户既没被送去支付平台
       * 也没有二维码，那个「我已完成支付」按钮永远查不到东西。
       */
      name: 'R80-07a · 无收银台地址时静默降级到等待支付页（订单建了、收银台没给）',
      file: 'server/share-routes.js',
      anchor: "  paymentOrders.markFailed(order.id, '支付渠道未返回可用的收银台地址');",
      replacement: "  if (!charge.url) return payingPage(res, l, order); // R80 反向变异：静默降级\n"
        + "  paymentOrders.markFailed(order.id, '支付渠道未返回可用的收银台地址');",
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 支付表单不带 `data-pay-submit` ⇒ 脚本认不出它，点击的即时反馈与兜底提示
       * 一起消失（R80-08 直接断挂点，R80-09 靠假 DOM 真跑）。
       */
      name: 'R80-08a · 支付表单去掉 data-pay-submit 标记（脚本无从接管提交反馈）',
      file: 'server/share-routes.js',
      anchor: '<form method="POST" action="/s/${esc(l.id)}/pay" data-pay-submit="1">',
      replacement: '<form method="POST" action="/s/${esc(l.id)}/pay">',
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 脚本不再接管提交 ⇒ 按钮不变灰、提示位不出现、12 秒兜底也不会响：
       * 页面在"什么都没发生"与"其实被浏览器吞了"之间毫无区分能力。
       */
      name: 'R80-09a · pay-poll 不再接管支付表单（提交后依旧毫无反馈）',
      file: 'public/js/pay-poll.js',
      anchor: "  const form = document.querySelector ? document.querySelector('form[data-pay-submit]') : null;\n  if (!form) return;",
      replacement: '  const form = null; // R80 反向变异：不接管表单\n  if (!form) return;',
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 轮询不再以「页面上有没有 #pay-state」为开关 ⇒ 付费页（此时还没有订单）
       * 每 3 秒白打一次 `/pay/status`。
       */
      name: 'R80-10a · 轮询不再按 #pay-state 开关（付费页也每 3 秒打一次 /pay/status）',
      file: 'public/js/pay-poll.js',
      anchor: '  if (stateBox()) {',
      replacement: '  if (true) { // R80 反向变异：无条件轮询',
      testFile: 'audit80-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R81 的正中心：把 `clearTimeout` 挪回「拿到响应头」的那一刻。
       *
       * 这就是旧实现 —— `fetch()` 一 resolve 就清计时器，剩下的 `res.text()`
       * 不再受 signal 约束，只能等 undici 默认的 300 秒 `bodyTimeout`。
       * 桩会在 14 秒把响应体补完，于是旧实现会**判成已支付**（R81-01 当场变红），
       * 而正确实现 10 秒就放弃 —— 两种结局可区分，且用例不会真的挂 5 分钟。
       */
      name: 'R81-01a · 出站超时只管到响应头（读响应体不再受 signal 约束）',
      file: 'server/payment-gateway.js',
      anchor: "    phase = 'body';",
      replacement: "    clearTimeout(timer); // R81 反向变异：拿到头就停表（旧 bug）\n    phase = 'body';",
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 阶段标记不再切到「读体」⇒ 卡在响应体时也只报「没收到响应头」。
       * 这两句文案是现场唯一能区分「连不上」与「对方 hang 住」的东西。
       */
      name: 'R81-05a · 超时不再区分「连不上」与「响应体读不完」（阶段标记恒为 head）',
      file: 'server/payment-gateway.js',
      anchor: "    phase = 'body';",
      replacement: "    phase = 'head'; // R81 反向变异：永不进入读体阶段",
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * PayPal 取 token 不共用 deadline ⇒「取 token 10 秒 + 建单 10 秒」= 20 秒，
       * 必然长过前端 12 秒的提交看门狗 —— 又回到「前端说没收到、后台还在等」。
       */
      name: 'R81-04a · PayPal 取 token 不共用下单总预算（两次串行出站各 10 秒）',
      file: 'server/payment-gateway.js',
      anchor: '  const token = await paypalToken(cfg, deadline);',
      replacement: '  const token = await paypalToken(cfg); // R81 反向变异：token 不共用预算',
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * `createCharge` 不把 deadline 传给渠道实现 ⇒ 总预算形同虚设（9 秒只是一个没被读的常量）。
       */
      name: 'R81-04b · createCharge 算了 deadline 却不往下传（总预算形同虚设）',
      file: 'server/payment-gateway.js',
      anchor: '    const r = await run(cfg, opts, deadline);',
      replacement: '    const r = await run(cfg, opts); // R81 反向变异：deadline 没传下去',
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 探针回答「支付中」时不再给结论 ⇒ 落到「无法确认」那一条。
       * 用户看到的就是「不知道」，而服务端明明已经知道订单建好了。
       */
      name: 'R81-06a · 探针说「支付中」时不给结论（退回"不知道"）',
      file: 'public/js/pay-poll.js',
      anchor: "      if (state === 'pending') {",
      replacement: "      if (state === 'never-pending') { // R81 反向变异：不处理 pending",
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 探针回答「查不到订单」时不再区分 ⇒ 与「已建单」混成同一条文案，
       * 正是「订单可能没有创建成功」那句错误断言的老毛病。
       */
      name: 'R81-07a · 探针说「查不到订单」时不区分（两种处境混成一条文案）',
      file: 'public/js/pay-poll.js',
      anchor: "      if (state === 'none') {",
      replacement: "      if (state === 'never-none') { // R81 反向变异：不处理 none",
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 探针说「已支付」时不再刷新 ⇒ 用户明明付完了，页面还停在「请重试」。
       */
      name: 'R81-08a · 探针说「已支付」时不刷新页面（用户以为没付成功）',
      file: 'public/js/pay-poll.js',
      anchor: "      if (state === 'paid') {",
      replacement: "      if (state === 'never-paid') { // R81 反向变异：不处理 paid",
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 探针不再是只读的：它会走到下面的主动查单分支，卡住期间反而给网关加压，
       * 而且「问一句」与「推一次状态」这两件事被合成一件。
       */
      name: 'R81-09a · ?probe=1 不再是只读（会触发网关查单）',
      file: 'server/share-routes.js',
      anchor: "  if (String(req.query.probe || '') === '1') {",
      replacement: '  if (false) { // R81 反向变异：探针不生效，落到主动查单',
      testFile: 'audit81-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R82 的正中心：复用条件退回「只看有没有在途订单」。
       * 用户选了微信、却拿到支付宝收银台 —— 这正是用户要求修掉的现象。
       */
      name: 'R82-01a · 复用不看渠道（用户选微信却拿到支付宝收银台）',
      file: 'server/share-routes.js',
      anchor: '  const sameChannel = !!(pendingOrder && pendingOrder.platform === platform);',
      replacement: '  const sameChannel = !!pendingOrder; // R82 反向变异：不看渠道就复用',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 被放弃的在途订单不收尾 ⇒ 管理页永远显示「支付中」，
       * 而用户这次已经换渠道成功了 —— 后台与用户手上各说一套。
       */
      name: 'R82-01b · 换渠道时不收尾原在途订单（后台永远停在「支付中」）',
      file: 'server/share-routes.js',
      anchor: "      paymentOrders.markFailed(pendingOrder.id, '已更换支付方式，原在途订单作废');",
      replacement: '      void pendingOrder; // R82 反向变异：不收尾原在途订单',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 换渠道时不退券 ⇒ 同一张「每人一次」的券在新单上被判 already_used，
       * 用户换个支付方式就卡在「优惠券不可用」，钱反而付不出去。
       */
      name: 'R82-02a · 换渠道时不退券（「每人一次」的券变成死结）',
      file: 'server/share-routes.js',
      anchor: '      releaseCouponForOrder(pendingOrder);',
      replacement: '      void 0; // R82 反向变异：不退券',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 同渠道也不再复用 ⇒ 每点一次就多一笔商户单号，用户可能付两次。
       */
      name: 'R82-03a · 同渠道也不复用（每次点击都新建订单）',
      file: 'server/share-routes.js',
      anchor: '  const sameChannel = !!(pendingOrder && pendingOrder.platform === platform);',
      replacement: '  const sameChannel = false; // R82 反向变异：永不复用',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 保存侧不再拦 disabled 枚举值 ⇒ SM2 又能存进去，错误被推回「点立即支付」那一刻。
       */
      name: 'R82-04a · 保存时不再拦 disabled 枚举值（SM2 又能存进配置）',
      file: 'server/payment-providers.js',
      anchor: '      if (hit && hit.disabled) {',
      replacement: '      if (false) { // R82 反向变异：不拦 disabled 值',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 前端不再渲染 disabled ⇒ 用户仍能选中一个「保存必失败」的值。
       */
      name: 'R82-05a · 前端不渲染 disabled（SM2 仍可选，提交后才失败）',
      file: 'public/js/paysettings.js',
      anchor: "${o.disabled ? ' disabled' : ''}",
      replacement: "${''}",
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 一次性标记失效 ⇒ 每次重启都重扫一遍，把当时**真正在途**的订单误杀一批。
       */
      name: 'R82-06a · 清理不再"只跑一次"（每次重启都误杀真在途订单）',
      file: 'server/payment-orders.js',
      anchor: '  if (db.staleSwept === STALE_SWEEP_MARK) return { swept: 0, skipped: true, already: true };',
      replacement: '  if (false) return { swept: 0, skipped: true, already: true }; // R82 反向变异：可重复扫',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 判据读「调用之前」的状态 ⇒ 文件损坏时返回 skipped:false，「清了 0 笔」被当成清理成功。
       */
      name: 'R82-07a · loadFailed 判据读到 load() 之前（文件损坏时误报"清理成功"）',
      file: 'server/payment-orders.js',
      anchor: '  const db = load();\n  if (loadFailed) return { swept: 0, skipped: true };',
      replacement: '  if (loadFailed) return { swept: 0, skipped: true };\n  const db = load(); // R82 反向变异：先判后加载',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 启动路径不再调用清理 ⇒ 升级后没人执行迁移，管理页继续一片「支付中」。
       */
      name: 'R82-08a · 服务启动不再执行清理（升级后没人跑迁移）',
      file: 'server/index.js',
      anchor: '  const swept = paymentOrders.sweepStalePending();',
      replacement: '  const swept = { swept: 0, skipped: true }; // R82 反向变异：不执行清理',
      testFile: 'audit82-regressions.test.js',
      minFail: 1,
    },
  ];

module.exports = { runCase, CASES, parseArgs };

/**
 * 解析命令行参数（**独立成函数**，便于被测试直接驱动）。
 *
 * 过滤**只认** `--only=<片段>`；位置参数一律**报错**。
 *
 * ⚠️ 早期版本对被忽略的位置参数一声不吭：`node scripts/reverse-check.js R35-01`
 * （本意「只跑这一轮」）会**静默**跑满全量台账 —— 全量 315 条里含 36 条以
 * `deploy-script.test.js` 为对象的对照，而那一个文件单跑就要约 2.5 分钟，加起来是
 * **数小时**。实测踩过一次：10 分钟才跑完 14 条，只能强杀，而强杀会留下一个
 * **正处于变异态**的源文件（`*.reversebak` 里能看出是哪一个）。
 *
 * 「看着筛了、其实没筛」与护栏假绿同源（都是判据没落在它声称要守的东西上），
 * 故这里直接报错，而不是打个提示继续跑。
 *
 * 校验**放在纯函数里**而不是内联在主流程：内联的话只能用「源码里有没有这段字样」
 * 去断言，而本文件里还存着这条对照自己的 anchor 字面量 —— 文本断言会被那份副本满足，
 * 于是**永远为真**（实测就是这么得到一次 fail=0 的假绿）。
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const stray = args.filter((a) => a.indexOf('--only=') !== 0);
  if (stray.length) {
    return {
      error: '无法识别的参数：' + stray.join(' ')
        + '\n按用例名过滤请用 `--only=<片段>`（例如 --only=R35-01）；'
        + '不带参数 = 跑**全量**台账（很慢，且含 36 条 2.5 分钟级的 deploy-script 对照）。',
    };
  }
  return { only: onlyArg ? onlyArg.slice('--only='.length) : '' };
}

/* 直接运行时执行下面登记的用例 */
if (require.main === module) {
  // `--only=<片段>` 按 name 过滤，便于单条复核（全量跑一遍耗时较长）
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  const only = parsed.only;
  const matched = only ? CASES.filter((c) => c.name.indexOf(only) >= 0) : CASES;
  if (only && !matched.length) {
    console.error('没有 name 含「' + only + '」的用例');
    process.exit(2);
  }
  /**
   * 退役项**不参与**「撤掉修复必须变红」的判定 —— 它们的变异已被后续轮次的修复
   * 变成不可观测（原因见各自条目上的 `retiredReason`）。但仍然**打印**出来，
   * 退役不是删除：台账里留痕、可审计，且 `invariants.test.js` 会把「退役必须写明
   * 原因」当作硬断言，防止有人用 `retired` 把跑不红的对照项悄悄藏起来。
   */
  const retired = matched.filter((c) => c.retired);
  const cases = matched.filter((c) => !c.retired);
  for (const c of retired) {
    console.log('\n=== ' + c.name + ' ===');
    console.log('  ⏭ 已退役（不再可证伪）：' + (c.retiredReason || '（未写原因！）'));
  }
  if (retired.length) {
    console.log(`\n（另有 ${retired.length} 条已退役，未计入下面的通过判定）`);
  }
  let allOk = true;
  (async () => {
    for (const c of cases) allOk = (await runCase(c)) && allOk;
    process.exit(allOk ? 0 : 1);
  })();
}
