/**
 * 第四十九轮护栏 —— 两条产品语义改动
 *
 * 【第 1 部分：R49-01 ~ R49-09】移除自签名证书与 `selfsigned` 依赖
 *
 * 本轮要钉住的是一条**产品语义**，不是一次实现细节：
 *
 *   自签名证书不是「能用的 HTTPS」。它没有可信签发链，浏览器照样判它不安全
 *   （必须人工点「继续访问」）；更关键的是**安全上下文并不成立** —— WebAuthn
 *   （Windows Hello 登录）、Service Worker、剪贴板、摄像头/麦克风、通知这些
 *   「必须有 HTTPS 才能用」的能力一个都换不来。于是它只剩下「看起来像 HTTPS」
 *   的错觉，外加一份要长期维护的私钥。
 *
 * 移除之后，产品变成「**只加载运维自备的真实证书**；没有证书就只跑 HTTP」。
 * 这条语义最容易在后续被改回去的地方是「没有证书时偷偷降级」，所以本文件的判据
 * 一律围绕「**没有证书会发生什么**」：
 *
 *  - R49-01 未配置证书 → 判「不可用」，并说清缺的是哪个文件
 *  - R49-02 证书内容不可用 / 与私钥不配对 → 判「不可用」（附正向对照）
 *  - R49-03 **只读**：加载证书绝不写盘（旧实现会就地重签并把私钥写回）
 *  - R49-04 无证书时明文请求必须照常服务（不得 301 到没人监听的端口）
 *  - R49-05 反代场景的 301 目标是**对外**端口，不是内置的 3443
 *  - R49-06 提供证书时内置 HTTPS 必须真的监听
 *  - R49-07 WebDAV 缺证书时不得启动，且原因必须能传到界面
 *  - R49-08 部署脚本不得再生成自签名证书
 *  - R49-09 运行时依赖与源码里不得再有 selfsigned
 *
 * R49-04/05/06 刻意走**真实子进程 + 真实 HTTP 请求**：这三条判的是「启动顺序与
 * 监听结果」，只有把进程真起起来才看得见（旧实现的问题恰恰是「源码里看着有监听」，
 * 而用户拿到的是连接被拒）。
 *
 * 【第 2 部分：R49-10 ~ R49-17】移除 COS 原生 API，腾讯云改走 S3 兼容协议
 *
 * 改动的实质是「**删掉一条协议通路**」：腾讯云原先用 `cos-nodejs-sdk-v5` 走
 * COS 原生协议，与「S3 兼容」是两套签名、两套错误码；合并后全项目只剩一条
 * S3 通路（外加 Azure 的独立实现）。随之而来的是**全面改名** `cos` → `s3`。
 *
 * 改名类改动有两个互不相同的风险，判据分开钉：
 *
 *  ① **改过头**（把语义不该动的地方一起改了）。最典型的是上一轮机械替换时把
 *     `data-dir.js` 里的 `LEGACY_ENV = 'COS_DATA_DIR'` 自身也改掉 —— 旧环境变量
 *     被静默忽略，用户 `.env` 里的数据目录配置「凭空失效」。R49-14 因此**真跑**
 *     `dataDir()` 覆盖「新名优先 / 旧名兜底并提示 / 都不设走默认」三条分支。
 *  ③ **收口时把函数签名一起改窄了**。R49-18 是这条的真实案例：把 `copySource()`
 *     的厂商分支删掉时，顺手把它第 3 个形参 `region` 也从签名里去掉，而**仍有调用点
 *     按老位置传四个实参** ⇒ `key` 落到 `region` 的位置上，拼出 `/<桶>/<地域>` 这种
 *     **语法合法但指向不存在对象**的 CopySource，复制静默失败。抓住它的正是
 *     `tests/azure-client.test.js` 里那条按**四参**调用的 R30 用例 —— 判据落在
 *     「实际被执行的那一层」才看得见参数错位。
 *
 *  ② **改不彻底，或者按「名字」而不是按「语义」改**。机械改名会让
 *     `isCos()` 退化成一个与 `isS3()` 完全相同的函数，于是它在 4 个调用点上的
 *     原有含义被悄悄改写成「所有 S3 厂商」：
 *       · `_shared.js` 的 AKID 前缀校验会**拒掉阿里云/华为云的全部密钥**；
 *       · `copyNeedsSlice()` 会把 5GB 上限**外溢到所有厂商**（R45 明确不做）。
 *     R49-12 / R49-13 用**行为**判据守住这两处：腾讯云照旧生效、别的厂商不受影响。
 *     厂商差异不再用「是不是 COS」表达，而是搬进注册表字段（`secretIdPrefix` /
 *     `copyObjectMaxBytes`），并把判据收敛成唯一实现点。
 *
 * R49-11 单独覆盖 R46 的同型陷阱：地域留空时靠主机名反推**签名地域**，
 * 域名清单漏掉 `myqcloud.com` 的后果是「绑定成功但 0 个存储桶」——一个**合法的
 * 空结果**，比报错难查得多。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const test = require('node:test');
const { assert, assertEqual, ROOT, request, waitForPort, ensureTestTls, packageSource } = require('./helpers');

const R = (...p) => path.join(ROOT, ...p);
const readSrc = (...p) => fs.readFileSync(R(...p), 'utf8');
const tlsCert = require(R('server', 'tls-cert.js'));
const providers = require(R('server', 'providers.js'));
const { LIMITS } = require(R('server', 'limits.js'));
const { S3Client } = require(R('server', 's3-client.js'));
const shared = require(R('server', 'routes', '_shared.js'));
const s3Mod = require(R('server', 's3.js'));

/**
 * 剥掉注释（块注释 + 行注释），并把注释换成**等长空格** —— 与 `invariants.test.js`
 * 同口径。本文件里有「某文件不得出现写盘 API」这类负向断言，而解释性注释里恰恰
 * 会写到那些名字（比如说明「旧实现会 writeFileSync 写回私钥」），不剥就会假红；
 * 反过来，不换成等长空格又会让「源码里没有 X」被注释满足而假绿。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p) => p + _m.slice(p.length).replace(/[^\n]/g, ' '));
}

/**
 * shell 口径的剥注释：把 `#` 注释抹成**等长空格**（行内注释也剥）。
 *
 * 为什么不能直接用上面的 `stripComments`：那是 JS 口径（只认 `//` 与 `/* *​/`），
 * 而 `deploy.sh` 的注释是 `#`。R49-08 要判「deploy.sh 里不得再出现 gen_self_signed /
 * `openssl req -x509`」，而我在同一文件里为解释「为什么删掉它」写的注释恰好含这两个
 * 字面片段 ⇒ 不按 shell 口径剥，删除干净了也照样「通过」（假绿，本项目已记录三次）。
 *
 * 只认「行首空白后」或「前面是空白」的 `#`：`${VAR#pat}`、`$#`、引号里的 `#`
 * 都不算注释（引号状态在行内跟踪）。⚠️ here-doc 内部的行**也会**被当注释剥掉 ——
 * 对本文件无影响（判据只看函数与命令），但换文件复用时要记得这一点。
 */
function stripShellComments(src) {
  return String(src)
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          out += ch;
          if (ch === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          // 注释开始：余下整行抹成空格（长度不变 ⇒ 下标仍与原文对齐，可安全切片）
          return out + line.slice(i).replace(/[^\n]/g, ' ');
        }
        out += ch;
      }
      return out;
    })
    .join('\n');
}

/** 在临时目录里造一对可用证书（内容来自 tests/fixtures/test-tls.js）。 */
function writeCertPair(dir) {
  const tls = require('./fixtures/test-tls.js');
  const tlsDir = path.join(dir, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true });
  const certFile = path.join(tlsDir, 'fullchain.pem');
  const keyFile = path.join(tlsDir, 'privkey.pem');
  fs.writeFileSync(certFile, tls.cert());
  fs.writeFileSync(keyFile, tls.key(), { mode: 0o600 });
  return { certFile, keyFile };
}

/** 目录快照（名字 → 大小|mtime），用于「加载不得写盘」的判据。 */
function snapshot(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(p, rel + '/');
      else {
        const st = fs.statSync(p);
        out[rel] = `${st.size}|${st.mtimeMs}`;
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 在受控环境变量下调用一次 loadTlsCert()，调用后还原环境。 */
function loadWith(env) {
  const keys = Object.keys(env);
  const backup = {};
  for (const k of keys) {
    backup[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return tlsCert.loadTlsCert();
  } finally {
    for (const k of keys) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
}

/* ================================================================== *
 * R49-01 · 未配置证书
 * ================================================================== */

test('R49-01 · 未配置证书必须判「不可用」，并说清缺的是哪个文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-none-'));
  try {
    const certFile = path.join(dir, 'tls', 'fullchain.pem');
    const keyFile = path.join(dir, 'tls', 'privkey.pem');
    const r = loadWith({ TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
    assertEqual(r.ok, false, 'R49-01：一个证书都没配时必须判不可用（判可用就会去起一个没有证书的 HTTPS）');
    assert(/未配置 TLS 证书/.test(r.reason),
      `R49-01：原因要能让人一眼看懂是「没配」，而不是「读失败」：${r.reason}`);
    assertEqual(r.missing.length, 2, 'R49-01：两个文件都不在，missing 必须列全');
    assert(r.reason.includes('fullchain.pem') && r.reason.includes('privkey.pem'),
      `R49-01：必须点名缺哪个文件（否则运维只能猜）：${r.reason}`);

    // 只缺一个也要说清是哪一个 —— 否则「证书放了、私钥忘了」会被当成放了
    fs.writeFileSync(path.join(dir, 'only-cert.pem'), 'whatever');
    const r2 = loadWith({
      TLS_CERT_FILE: path.join(dir, 'only-cert.pem'),
      TLS_KEY_FILE: path.join(dir, 'absent.pem'),
    });
    assertEqual(r2.ok, false, 'R49-01：证书与私钥缺一即不可用（TLS 无法只靠一半工作）');
    assertEqual(r2.missing.length, 1, 'R49-01：只缺一个时 missing 必须只列那一个');
    assert(/absent\.pem/.test(r2.reason), `R49-01：缺的那个文件名必须出现在原因里：${r2.reason}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * R49-02 · 内容不可用 / 不配对
 * ================================================================== */

test('R49-02 · 坏证书与「证书私钥不配对」都必须判不可用（附正向对照）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-bad-'));
  try {
    const { certFile, keyFile } = writeCertPair(dir);

    // 正向对照：真正可用的一对必须判可用 —— 否则下面两条「一律拒绝」也能全绿
    const good = loadWith({ TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
    assertEqual(good.ok, true, 'R49-02 正向对照：配对且能解析的证书必须判可用');
    assert(Buffer.isBuffer(good.cert) && Buffer.isBuffer(good.key),
      'R49-02：应返回 Buffer（https.createServer 直接吃 Buffer，不必再解一次编码）');

    // ① 内容不是证书：只判「文件存在且非空」的实现会放它过去，然后在 TLS 握手里炸
    fs.writeFileSync(path.join(dir, 'junk.pem'), 'not a certificate\n');
    const junk = loadWith({ TLS_CERT_FILE: path.join(dir, 'junk.pem'), TLS_KEY_FILE: keyFile });
    assertEqual(junk.ok, false, 'R49-02：不是证书的文件必须判不可用（否则表现为「端口在监听、请求进来就断」）');
    assert(/不可用/.test(junk.reason), `R49-02：原因要指出证书本身有问题：${junk.reason}`);

    // ② 私钥不配对：另一把合法的 EC 私钥（形状完全正常，就是配不上这份证书）
    const otherKey = path.join(dir, 'other-key.pem');
    fs.writeFileSync(otherKey, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const mismatch = loadWith({ TLS_CERT_FILE: certFile, TLS_KEY_FILE: otherKey });
    assertEqual(mismatch.ok, false, 'R49-02：证书与私钥不配对必须判不可用（这是 acme.sh/CA 换证书不换 key 的典型形态）');
    assert(/不配对/.test(mismatch.reason), `R49-02：原因要能区分「不配对」与「读不到」：${mismatch.reason}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * R49-03 · 只读：加载证书绝不写盘
 * ================================================================== */

test('R49-03 · 加载证书的过程绝不能写盘（旧实现会就地重签并把私钥写回）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-readonly-'));
  try {
    const { certFile, keyFile } = writeCertPair(dir);
    // 连「没有证书」的那条路也要一起看：旧实现的写盘恰恰发生在「读不到就去生成」时
    const before = snapshot(dir);
    const ok = loadWith({ TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
    const none = loadWith({ TLS_CERT_FILE: path.join(dir, 'no.pem'), TLS_KEY_FILE: path.join(dir, 'no.key') });
    const after = snapshot(dir);
    assertEqual(ok.ok, true, '前置：这一对证书本应可用（否则本条的写盘判据等于没执行）');
    assertEqual(none.ok, false, '前置：不存在的证书本应判不可用');

    const added = Object.keys(after).filter((k) => !(k in before));
    const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
    assertEqual(added.length, 0,
      `R49-03：加载证书不得新建任何文件（新建了 ${added.join(', ')}）——「顺手签一张」必须彻底消失`);
    assertEqual(changed.length, 0,
      `R49-03：加载证书不得改写任何文件（改动了 ${changed.join(', ')}）—— 运维的证书文件不归我们管`);

    // 静态侧：源码里不得出现任何写盘 API（剥注释后判定，避免被解释性注释满足）
    const src = stripComments(readSrc('server', 'tls-cert.js'));
    const writes = ['writeFileSync', 'appendFileSync', 'createWriteStream', 'mkdirSync', 'writeFile\\(',
      'chmodSync', 'unlinkSync', 'rmSync', 'atomicWrite']
      .filter((pat) => new RegExp(pat).test(src));
    assertEqual(writes.length, 0,
      `R49-03：server/tls-cert.js 里不得出现写盘 API（命中：${writes.join(', ')}）—— 本模块只读加载`);
    assert(!/local-cert\.json/.test(src),
      'R49-03：不得再引用旧的证书缓存文件 data/local-cert.json（那条「缓存 + 重签」的路已整体移除）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * R49-04 / R49-05 / R49-06 · 真实子进程
 * ================================================================== */

/** 占一个空闲端口再放掉（用于给子进程指定端口）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 起一个真实的应用进程，返回句柄（含累积日志）。 */
function startApp(env) {
  const child = spawn(process.execPath, [R('server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      // 清掉可能从父进程继承来的端口/证书配置，避免用例之间互相污染
      TLS_CERT_FILE: '', TLS_KEY_FILE: '', PUBLIC_HTTPS_PORT: '', TRUST_PROXY: '', HTTPS_PORT: '',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  return {
    child,
    log: () => log,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}

async function httpsGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, path: urlPath, method: 'GET', rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('R49-04 · 没有证书时明文请求必须照常服务（不得 301 到没人监听的端口）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-http-'));
  const port = await freePort();
  const app = startApp({
    S3_DATA_DIR: dir, HOST: '0.0.0.0', PORT: String(port), SITE_DOMAIN: 'r49.test',
    TLS_CERT_FILE: path.join(dir, 'tls', 'fullchain.pem'),
    TLS_KEY_FILE: path.join(dir, 'tls', 'privkey.pem'),
  });
  try {
    await waitForPort(port, 20000);
    const res = await request(port, 'GET', '/');
    assertEqual(res.status, 200,
      'R49-04：没有证书时「只跑 HTTP」，明文请求必须被正常服务 —— 若被 301，访客会落到一个'
      + `没人监听的 HTTPS 端口上（ERR_CONNECTION_REFUSED，且日志一片正常）。实际 ${res.status}`
      + ` Location=${res.headers.location}`);
    assert(/未配置 TLS 证书/.test(app.log()),
      `R49-04：启动日志必须说清是「没配证书」，而不是含糊的「HTTPS 启动失败」：${app.log().slice(0, 500)}`);
    assert(/仅提供 HTTP/.test(app.log()),
      `R49-04：必须明确告诉运维现在只有 HTTP 可用：${app.log().slice(0, 500)}`);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R49-05 · 反代场景的 301 目标必须是「对外」端口，不是内置的 3443', async () => {
  const results = {};
  for (const [label, extra] of [
    ['default', {}],
    ['explicit', { PUBLIC_HTTPS_PORT: '8443' }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-redir-'));
    const port = await freePort();
    const app = startApp(Object.assign({
      S3_DATA_DIR: dir, HOST: '0.0.0.0', PORT: String(port), SITE_DOMAIN: 'r49.test', TRUST_PROXY: '1',
      TLS_CERT_FILE: path.join(dir, 'tls', 'fullchain.pem'),
      TLS_KEY_FILE: path.join(dir, 'tls', 'privkey.pem'),
    }, extra));
    try {
      await waitForPort(port, 20000);
      const res = await request(port, 'GET', '/api/health');
      results[label] = { status: res.status, location: res.headers.location || '' };
    } finally {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  assertEqual(results.default.status, 301,
    `R49-05 前置：位于可信反代之后时明文请求应被 301（这是既有的防降级行为）：${JSON.stringify(results.default)}`);
  assertEqual(results.default.location, 'https://r49.test:443/api/health',
    'R49-05：未显式指定时，301 目标端口应取反代的标准 443 —— 旧实现指向内置的 3443，'
    + `等于把访客送给一张浏览器不认的自签名证书：${results.default.location}`);
  assertEqual(results.explicit.location, 'https://r49.test:8443/api/health',
    `R49-05：PUBLIC_HTTPS_PORT 必须能覆盖跳转端口（反代对外不是 443 时唯一的手段）：${results.explicit.location}`);
});

test('R49-06 · 提供自备证书时内置 HTTPS 必须真的监听', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-https-'));
  ensureTestTls(dir);
  const httpPort = await freePort();
  const httpsPort = await freePort();
  const app = startApp({
    S3_DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(httpPort), HTTPS_PORT: String(httpsPort),
  });
  try {
    await waitForPort(httpPort, 20000);
    let res = null;
    const deadline = Date.now() + 20000;
    let lastErr = null;
    while (Date.now() < deadline && !res) {
      try { res = await httpsGet(httpsPort, '/'); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
    }
    assert(res, `R49-06：给了证书就必须真的起 HTTPS 监听（连不上：${lastErr && lastErr.message}）`);
    assertEqual(res.status, 200, 'R49-06：HTTPS 上的静态首页应正常返回');
    assert(/HTTPS  : https:\/\//.test(app.log()),
      `R49-06：启动日志必须报告 HTTPS 已监听（否则运维无从确认证书被用上了）：${app.log().slice(0, 600)}`);
    assert(app.log().includes(path.join('tls', 'fullchain.pem')),
      `R49-06：日志里应带上实际使用的证书路径（一眼看出读的是哪一份）：${app.log().slice(0, 600)}`);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * R49-07 · WebDAV 缺证书时不得启动
 * ================================================================== */

test('R49-07 · WebDAV 缺证书时不得启动，且原因必须能传到界面（tlsError）', async () => {
  const webdav = require(R('server', 'webdav-server.js'));
  const configStore = require(R('server', 'config-store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-r49-dav-'));
  const origGet = configStore.getWebdav;
  const envBackup = { TLS_CERT_FILE: process.env.TLS_CERT_FILE, TLS_KEY_FILE: process.env.TLS_KEY_FILE };
  configStore.getWebdav = () => ({ enabled: true, accounts: [{ id: 'a1', username: 'u' }] });
  process.env.TLS_CERT_FILE = path.join(dir, 'tls', 'fullchain.pem');
  process.env.TLS_KEY_FILE = path.join(dir, 'tls', 'privkey.pem');
  try {
    await webdav.apply();
    assertEqual(webdav.isRunning(), false,
      'R49-07：WebDAV 强制 HTTPS（Basic 凭据等同明文口令），没有证书就**不能**启动 —— 更不得降级成明文');
    const msg = webdav.getTlsError();
    assert(/未配置 TLS 证书/.test(msg),
      `R49-07：界面必须能拿到「为什么没起来」的原因，否则用户只能看到「正在启动…」永远转圈：${JSON.stringify(msg)}`);
    assert(/WebDAV 强制 HTTPS/.test(msg),
      `R49-07：原因里要点明 WebDAV 是强制 HTTPS 的（不是普通的启动失败）：${JSON.stringify(msg)}`);
  } finally {
    configStore.getWebdav = origGet;
    if (envBackup.TLS_CERT_FILE === undefined) delete process.env.TLS_CERT_FILE;
    else process.env.TLS_CERT_FILE = envBackup.TLS_CERT_FILE;
    if (envBackup.TLS_KEY_FILE === undefined) delete process.env.TLS_KEY_FILE;
    else process.env.TLS_KEY_FILE = envBackup.TLS_KEY_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * R49-08 · 部署脚本不得再生成自签名证书
 * ================================================================== */

test('R49-08 · deploy.sh 不得再生成自签名证书（只校验并认领自备证书）', () => {
  const src = readSrc('deploy.sh');

  // 自证（1）：剥注释器本身必须先被证明「能剥掉注释、又不吃代码、还等长」——
  // 否则下面那句「代码里没有 X」可能只是因为剥注释器把整份文件都吃光了。
  const probe = stripShellComments('# 旧实现（gen_self_signed）会用 openssl req -x509\nkeep_me=1  # 尾注 gen_self_signed\n');
  assert(!/gen_self_signed|req -x509/.test(probe),
    'R49-08 自证：剥注释器必须能抹掉行首与行内 `#` 注释里的名字');
  assert(/keep_me=1/.test(probe), 'R49-08 自证：剥注释器不得吃掉代码');
  assertEqual(probe.indexOf('keep_me'), '# 旧实现（gen_self_signed）会用 openssl req -x509\n'.length,
    'R49-08 自证：剥注释必须保持等长（否则按下标切函数体会错位）');

  // ⚠️ 判据必须打在**剥注释后的代码**上：我在 deploy.sh 里为解释「为什么删掉它」写的
  // 注释（`# 旧实现（gen_self_signed）会用 \`openssl req -x509\` 现场签一张…`）恰好含
  // 这两个字面片段 ⇒ 直接用原始源码判定会被**注释满足**（本项目已记录三次同类假绿）。
  const code = stripShellComments(src);
  assert(/^use_provided_cert\(\)\s*\{/m.test(code) && /cert_file_ok/.test(code),
    'R49-08 自证（2）：剥注释后仍应看得到 use_provided_cert() 与它调用的 cert_file_ok');

  assert(!/gen_self_signed/.test(code),
    'R49-08：自签名生成器必须整体删除（留一个「以后可能用到」的残骸，迟早会被某条分支再调起来）');
  assert(!/req\s+-x509/.test(code),
    'R49-08：deploy.sh 里不得再出现现场签发自签名证书的命令');
  assert(/use_provided_cert/.test(code),
    'R49-08：必须有取代它的「自备证书」分支');

  // 函数体内必须真的调用 cert_file_ok。判「存在」会被同文件别处的同名串满足，所以
  // 限定在**该函数体**内；用剥注释后的文本切片，避免被函数里那条「判据必须过
  // cert_file_ok」的注释满足。
  const body = code.slice(code.indexOf('use_provided_cert() {'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert(/if\s*!\s*cert_file_ok\s+"\$crt"\s+"\$key"/.test(fn),
    'R49-08：自备证书也必须过 cert_file_ok（字段非空 + 与私钥配对）—— 只判存在会把坏证书当成配好了');
  assert(/selfsigned\|self\)\s*die/.test(code),
    'R49-08：--tls selfsigned 必须被显式拒绝（而不是静默当成别的模式）');
  // 失败不得再回退：签发失败的那条分支必须明说「不再回退自签名证书」
  assert(/已不再回退自签名证书/.test(code), 'R49-08：ACME 失败必须明确告知不再回退自签名');
});

/* ================================================================== *
 * R49-09 · 依赖与源码里不得再有 selfsigned
 * ================================================================== */

test('R49-09 · 依赖清单与源码里都不得再出现 selfsigned', () => {
  const pkg = JSON.parse(readSrc('package.json'));
  assert(!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'selfsigned'),
    'R49-09：package.json 的运行时依赖里不得再有 selfsigned');
  assert(!Object.prototype.hasOwnProperty.call(pkg.devDependencies || {}, 'selfsigned'),
    'R49-09：也不得以 devDependency 的形式留在仓库里（否则 CI 装完仍然带着它）');
  assert(!/selfsigned/.test(readSrc('package-lock.json')),
    'R49-09：锁文件里不得再有 selfsigned（连同它带来的 node-forge / @types/node-forge）');

  // 源码里不得再有它的调用点；旧模块也应当整体消失
  const offenders = [];
  for (const dir of ['server', 'scripts', 'public/js']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir, d), { withFileTypes: true })) {
        const rel = path.join(dir, d, e.name);
        if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (/require\(\s*['"]selfsigned['"]\s*\)/.test(readSrc(rel))) offenders.push(rel);
      }
    };
    walk('');
  }
  assertEqual(offenders.length, 0, `R49-09：这些文件仍在 require('selfsigned')：${offenders.join(', ')}`);
  assertEqual(fs.existsSync(R('server', 'local-cert.js')), false,
    'R49-09：server/local-cert.js 必须删除（它的全部职责都是「生成/缓存自签名证书」）');
  assertEqual(fs.existsSync(R('server', 'tls-cert.js')), true,
    'R49-09：取代它的 server/tls-cert.js 必须存在');
});

/* ================================================================== *
 * R49-10 · 腾讯云并入 S3 兼容协议，注册表里再无 cos 形态
 * ================================================================== */

test('R49-10 · 腾讯云走 S3 兼容协议，厂商注册表里不再有 cos 形态', () => {
  const tencent = providers.resolve('tencent');
  assertEqual(tencent.kind, 's3',
    'R49-10：腾讯云必须并入 S3 兼容协议（原先 kind 是 \'cos\'，走 cos-nodejs-sdk-v5）');
  assert(/^https:\/\/cos\.[a-z0-9-]+\.myqcloud\.com$/.test(tencent.endpoint),
    `R49-10：端点是腾讯云的 **S3 兼容**域名 cos.<region>.myqcloud.com，实际 ${JSON.stringify(tencent.endpoint)}`);
  assertEqual(tencent.endpointTemplate, 'https://cos.{region}.myqcloud.com',
    'R49-10：端点模板要与端点同前缀（换地域时只替换 {region}）');

  // 注册表里不允许再有任何一家走 cos 形态
  const bad = providers.list().filter((p) => p.kind !== 's3' && p.kind !== 'azure').map((p) => `${p.id}:${p.kind}`);
  assertEqual(bad.length, 0, `R49-10：kind 只允许 s3 / azure，实际出现 ${bad.join(', ')}`);

  // `isCos` 必须整体消失：机械改名会让它变成 isS3 的同义词，厂商差异随之静默扩散
  assertEqual(typeof providers.isCos, 'undefined',
    'R49-10：`providers.isCos` 必须删除 —— 它一旦等于 isS3，AKID 规则与 5GB 上限就会外溢到所有厂商');
  assert(!/\befunction isCos\b/.test(stripComments(readSrc('server', 'providers.js'))),
    'R49-10：providers.js 里不得留下 isCos 的实现');
});

/* ================================================================== *
 * R49-11 · 地域留空时靠 S3 兼容域名反推签名地域（R46 同型陷阱）
 * ================================================================== */

test('R49-11 · 腾讯云 S3 兼容域名必须能反推签名地域（否则「绑定成功但 0 个桶」）', () => {
  /**
   * 真跑客户端构造 —— 判的是**签名地域**这个可观察结果，不是「域名清单里有 myqcloud」。
   *
   * 为什么必须这样判：`deriveRegionFromHost()` 的失败表现是**云端返回一个合法的空
   * 桶列表**（地域推成 us-east-1，请求本身合法、只是问错了地方），界面上就是
   * 「获取成功，共 0 个存储桶」。源码里清单写没写对，只有构造出客户端才看得见。
   */
  const at = (host) => new S3Client({ endpoint: `https://${host}` }).region;

  assertEqual(at('cos.ap-guangzhou.myqcloud.com'), 'ap-guangzhou',
    'R49-11：腾讯云默认端点必须推出 ap-guangzhou（推不出会退到 us-east-1，桶列表为空）');
  assertEqual(at('cos.ap-shanghai.myqcloud.com'), 'ap-shanghai', 'R49-11：换地域同样要推得出');
  assertEqual(at('cos.eu-frankfurt.myqcloud.com'), 'eu-frankfurt', 'R49-11：非亚太地域同样要推得出');

  /**
   * 负向：域名后缀不是 `myqcloud.com` 时**不得**被误判成腾讯云。
   *
   * 未命中时客户端会兜底成 `us-east-1`（见构造函数的 `|| 'us-east-1'`）——这正是
   * 「推不出地域」的可观察后果，也是 R46 那个「合法但为空」的桶列表的来源。
   * 所以这里断言的是「不等于 ap-guangzhou」，而不是某个具体的出错值。
   */
  assert(at('cos.ap-guangzhou.myqcloud.com.cn') !== 'ap-guangzhou',
    'R49-11：`.com.cn` 后缀不得命中 myqcloud.com 规则（判据的收尾字符必须咬死，否则任意后缀都会被当腾讯云）');
  assertEqual(at('cos.ap-guangzhou.myqcloud.com.cn'), 'us-east-1',
    'R49-11：未命中时的兜底必须是 us-east-1 —— 这条同时说明「漏登记域名」会静默签错地域');

  // R46-01 的覆盖面闸门：凡「默认端点里烘焙了地域」的厂商都必须在 audit42 的对照表里，
  // 腾讯云刚并入，漏登记就等于漏测。
  const conf = readSrc('tests', 'audit42-regressions.test.js');
  assert(/id:\s*'tencent'/.test(conf),
    'R49-11：audit42 的 CONFORMANCE 对照表必须补上 tencent —— R46-01 的覆盖面闸门就是为此存在的');
  assert(/cos\.ap-guangzhou\.myqcloud\.com/.test(conf),
    'R49-11：对照表里 tencent 的 host 必须是腾讯云的 S3 兼容域名');
});

/* ================================================================== *
 * R49-12 · AKID 前缀约定来自注册表，不外溢到别的厂商
 * ================================================================== */

test('R49-12 · AKID 前缀校验随厂商下发，别的 S3 厂商不得被误杀', () => {
  assertEqual(providers.secretIdPrefix('tencent'), 'AKID',
    'R49-12：腾讯云的密钥前缀约定要落在**注册表字段**上（原先是 `isCos && /^AKID/` 的临时判据）');
  assertEqual(providers.secretIdPrefix('aliyun'), '',
    'R49-12：阿里云没有前缀约定，必须返回空串（返回 AKID 就等于拒掉全部阿里云密钥）');

  // 行为判据：同一串密钥，在腾讯云通过、在阿里云也必须通过
  assertEqual(shared.validateCredentialFormat('tencent', 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), '',
    'R49-12：合规的腾讯云 SecretId 必须通过格式校验');
  assert(/AKID/.test(shared.validateCredentialFormat('tencent', 'LTAI5tSomeKey')),
    'R49-12：腾讯云若填了阿里云风格的密钥，错误提示里要点明应以 AKID 开头');

  /**
   * ⭐ 这条是本轮最关键的回归点：机械改名后 `isCos` 恒等于 `isS3`，
   * 于是「AKID 规则」会变成「所有 S3 厂商」——阿里云的 LTAI…/ 华为云的 AK… 全部被拒。
   */
  assertEqual(shared.validateCredentialFormat('aliyun', 'LTAI5tSomeKey'), '',
    'R49-12：AKID 规则**不得外溢** —— 阿里云的密钥在阿里云下必须通过（外溢即无法保存配置）');
  assertEqual(shared.validateCredentialFormat('huawei', 'HPUAAabcdefg'), '',
    'R49-12：华为云同理（它的密钥既不以 AKID 开头，也没有统一前缀）');

  // 反向自证：判据真的能报错（若 validateCredentialFormat 恒返回空串，上面几条会被空实现满足）
  assert(shared.validateCredentialFormat('tencent', 'bad') !== '',
    'R49-12 自证：不合规的腾讯云密钥必须被判不合规（否则上面「通过」的断言毫无意义）');
});

/* ================================================================== *
 * R49-13 · 复制分片上限只认厂商声明的数值
 * ================================================================== */

test('R49-13 · 复制分片阈值只认厂商声明的上限，不外溢到全体 S3 厂商', () => {
  const over = LIMITS.COPY_SIMPLE_LIMIT + 1;
  const under = LIMITS.COPY_SIMPLE_LIMIT - 1;

  assertEqual(providers.resolve('tencent').copyObjectMaxBytes, LIMITS.COPY_SIMPLE_LIMIT,
    'R49-13：腾讯云 5GB 上限要落在注册表字段上（原先藏在 `isCos(id) && n > 5GB` 里）');
  assertEqual(providers.copyNeedsSlice('tencent', over), true,
    'R49-13：腾讯云超过 5GB 必须改走 sliceCopyFile（否则 PutObjectCopy 必报 EntityTooLarge）');
  assertEqual(providers.copyNeedsSlice('tencent', under), false,
    'R49-13：上限之内不得平白多切一刀（分片复制更慢、更易失败）');

  /**
   * ⭐ 另一条最关键的回归点：`isCos` 退化成 `isS3` 后，5GB 上限会外溢到**所有**
   * S3 厂商 —— R45 明确决定不做这件事（各厂商 PutObjectCopy 上限不同，未声明即
   * 沿用项目阈值）。外溢的后果是把本来一次能成的复制切成多片。
   */
  assertEqual(providers.copyNeedsSlice('aliyun', over), false,
    'R49-13：阿里云未声明上限，不得跟着腾讯云走 5GB 分片（R45 明确不外溢）');
  assertEqual(providers.copyNeedsSlice('aws', over), false, 'R49-13：AWS 同理');
  assertEqual(providers.copyNeedsSlice('ucloud', 200 * 1024 * 1024), true,
    'R49-13：UCloud 自己声明的 100MB 上限（R45）必须仍然生效 —— 收敛判据时不能把它丢了');

  assertEqual(providers.copyNeedsSlice('tencent', 0), false, 'R49-13：大小为 0 不得判需要分片');
  assertEqual(providers.copyNeedsSlice('tencent', NaN), false, 'R49-13：非法大小不得判需要分片');
  assertEqual(providers.copyNeedsSlice('no-such-provider', over), false,
    'R49-13：未知厂商不得抛异常，按「不需要分片」处理');
});

/* ================================================================== *
 * R49-14 · 数据目录开关改名，且旧名仍然可用（真跑 dataDir()）
 * ================================================================== */

/** 取一份**全新的** data-dir 模块实例（模块内有一次性的弃用提示标志，必须重置） */
function freshDataDir() {
  const p = R('server', 'data-dir.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

test('R49-14 · 数据目录唯一实现点：新名优先、旧名兜底并提示、都不设走默认', () => {
  const keys = ['S3_DATA_DIR', 'COS_DATA_DIR'];
  const backup = {};
  for (const k of keys) backup[k] = process.env[k];
  const restore = () => {
    for (const k of keys) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  };
  const abs = (name) => path.join(os.tmpdir(), name);

  try {
    // ① 新名
    delete process.env.COS_DATA_DIR;
    process.env.S3_DATA_DIR = abs('r49-new');
    assertEqual(freshDataDir().dataDir(), path.resolve(abs('r49-new')),
      'R49-14：S3_DATA_DIR 必须生效');

    // ② 旧名兜底 —— 这是本轮改名的兼容契约：用户 `.env` 里写的是 COS_DATA_DIR，
    //    静默忽略会让数据目录退回项目内的 data/，用户看到「配置全没了」
    process.env.S3_DATA_DIR = '';
    process.env.COS_DATA_DIR = abs('r49-legacy');
    const warned = [];
    const origWarn = console.warn;
    console.warn = (m) => warned.push(String(m));
    let legacyDir;
    try { legacyDir = freshDataDir().dataDir(); } finally { console.warn = origWarn; }
    assertEqual(legacyDir, path.resolve(abs('r49-legacy')),
      'R49-14：旧名 COS_DATA_DIR 必须继续可用（部署契约，改名时不能把它一刀切掉）');
    assertEqual(warned.length, 1, `R49-14：用到旧名必须提示一次（实际 ${warned.length} 次）`);
    assert(/COS_DATA_DIR/.test(warned[0]) && /S3_DATA_DIR/.test(warned[0]),
      `R49-14：提示里要同时点明旧名与新名，用户才知道该改什么：${warned[0]}`);

    // ③ 都不设 → 项目内的 data/
    delete process.env.S3_DATA_DIR;
    delete process.env.COS_DATA_DIR;
    const d = freshDataDir();
    assertEqual(d.dataDir(), path.join(ROOT, 'data'), 'R49-14：都不设时走默认目录');
    assertEqual(d.defaultDataDir(), path.join(ROOT, 'data'), 'R49-14：默认目录只有一个实现点');
    assertEqual(d.PRIMARY_ENV, 'S3_DATA_DIR', 'R49-14：现用名常量');
    assertEqual(d.LEGACY_ENV, 'COS_DATA_DIR', 'R49-14：历史名常量（兼容别名，别被机械替换改掉）');

    // ④ 唯一实现点：别的 server 文件不得自己拼数据目录
    const offenders = [];
    for (const name of fs.readdirSync(R('server'))) {
      if (!name.endsWith('.js') || name === 'data-dir.js') continue;
      if (/process\.env\.(?:COS|S3)_DATA_DIR/.test(readSrc('server', name))) offenders.push(name);
    }
    assertEqual(offenders.length, 0,
      `R49-14：数据目录只允许 data-dir.js 读环境变量，这些文件又自己读了：${offenders.join(', ')}`);
  } finally {
    restore();
    delete require.cache[require.resolve(R('server', 'data-dir.js'))];
  }
});

/* ================================================================== *
 * R49-15 · 前端 localStorage 键改名 + 旧键迁移（真跑迁移函数）
 * ================================================================== */

/**
 * 从源码里按**大括号配对**取出一个具名函数的源文本。
 *
 * 为什么不用 `vm` 直接跑整个 `main.js`：它有 20 多个 import 与一堆 DOM 依赖，
 * 起沙箱的成本远高于收益；而 `readMigrating` 是**只依赖 localStorage 的纯函数**，
 * 摘出来跑的就是**真实实现**（不是重写一遍），迁移分支一旦被摘掉就会红。
 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `R49-15：源码里找不到函数 ${name}（改名或被删了？）`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`R49-15：函数 ${name} 的大括号不配对`);
}

test('R49-15 · 界面偏好键改名后，旧键必须能迁移（否则升级即丢设置）', async () => {
  const mainSrc = readSrc('public', 'js', 'main.js');

  // ① 历史键必须原样保留为常量 —— 名字错了等于没有兼容
  assert(/const LEGACY_LS_KEY = 'cosmgr\.prefs\.v1';/.test(mainSrc),
    'R49-15：偏好历史键必须是 cosmgr.prefs.v1（写成别的值 = 老用户偏好读不到）');
  assert(/const LEGACY_REMEMBER_LS_KEY = 'cosmgr\.auth\.v1';/.test(mainSrc),
    'R49-15：「记住我」的历史键必须是 cosmgr.auth.v1');
  assert(/const LS_KEY = 's3mgr\.prefs\.v1';/.test(mainSrc), 'R49-15：现用偏好键');
  assert(/const REMEMBER_LS_KEY = 's3mgr\.auth\.v1';/.test(mainSrc), 'R49-15：现用「记住我」键');

  // ② 真跑迁移：把**真实实现**摘到临时模块里驱动
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-prefs-'));
  const file = path.join(dir, 'prefs.mjs');
  fs.writeFileSync(file, extractFunction(mainSrc, 'readMigrating') + '\nexport { readMigrating };\n');
  const mod = await import(pathToFileURL(file).href);

  const store = new Map();
  const prevLs = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    // 只有旧键 → 返回值正确、写入新键、清掉旧键（只迁一次）
    store.set('cosmgr.prefs.v1', '{"view":"grid"}');
    assertEqual(mod.readMigrating('s3mgr.prefs.v1', 'cosmgr.prefs.v1'), '{"view":"grid"}',
      'R49-15：旧键有值时必须能读到（这是「升级不丢设置」的全部意义）');
    assertEqual(store.get('s3mgr.prefs.v1'), '{"view":"grid"}', 'R49-15：必须把旧值写入新键');
    assertEqual(store.has('cosmgr.prefs.v1'), false, 'R49-15：迁移完要清掉旧键（避免旧值被反复读回）');

    // 新键已有 → 以新键为准，旧键不动（不能反过来覆盖用户的新设置）
    store.set('cosmgr.prefs.v1', '{"view":"list"}');
    assertEqual(mod.readMigrating('s3mgr.prefs.v1', 'cosmgr.prefs.v1'), '{"view":"grid"}',
      'R49-15：新键存在时必须以新键为准');
    assertEqual(store.get('cosmgr.prefs.v1'), '{"view":"list"}', 'R49-15：新键存在时不得动旧键');

    // 都没有 → null（不得抛异常 / 不得编造默认值）
    store.clear();
    assertEqual(mod.readMigrating('s3mgr.prefs.v1', 'cosmgr.prefs.v1'), null,
      'R49-15：都没有时返回 null（调用方自己兜默认值）');
  } finally {
    globalThis.localStorage = prevLs;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ③ 旧键字面量只允许出现在 main.js（唯一实现点），别处不得再拼
  const offenders = [];
  for (const name of fs.readdirSync(R('public', 'js'))) {
    if (!name.endsWith('.js')) continue;
    const code = stripComments(readSrc('public', 'js', name));
    if (name !== 'main.js' && /cosmgr/.test(code)) offenders.push(`public/js/${name}`);
  }
  for (const name of fs.readdirSync(R('server'))) {
    if (!name.endsWith('.js') || name === 'data-dir.js') continue;
    if (/COS_DATA_DIR/.test(stripComments(readSrc('server', name)))) offenders.push(`server/${name}`);
  }
  assertEqual(offenders.length, 0,
    `R49-15：旧键字面量必须只留在唯一实现点里（main.js / data-dir.js），实际外泄到：${offenders.join(', ')}`);

  // ④ `__savePrefs` 已搬到 main.js —— 键名散落两处正是「改名漏一处」的成因
  assert(/window\.__savePrefs\s*=/.test(readSrc('public', 'js', 'main.js')),
    'R49-15：window.__savePrefs 的实现在 main.js');
  assert(!/window\.__savePrefs\s*=/.test(stripComments(readSrc('public', 'js', 'explorer.js'))),
    'R49-15：explorer.js 不得再自己写 localStorage 存偏好（键名要与 main.js 收口到一处）');
});

/* ================================================================== *
 * R49-16 · COS 原生实现、SDK 依赖与文件名整体退场
 * ================================================================== */

test('R49-16 · COS 原生实现与 cos-nodejs-sdk-v5 整体移除', () => {
  // 模块换名：cos.js → s3.js
  assertEqual(fs.existsSync(R('server', 'cos.js')), false, 'R49-16：server/cos.js 必须删除');
  assertEqual(fs.existsSync(R('server', 's3.js')), true, 'R49-16：取代它的 server/s3.js 必须存在');

  // 依赖：运行时只剩 express
  const pkg = JSON.parse(readSrc('package.json'));
  assert(!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'cos-nodejs-sdk-v5'),
    'R49-16：package.json 不得再有 cos-nodejs-sdk-v5');
  assert(!/cos-nodejs-sdk-v5/.test(readSrc('package-lock.json')),
    'R49-16：锁文件里不得残留（连同它拖进来的 request / conf 等整棵子树）');
  assertEqual(Object.keys(pkg.dependencies || {}).join(','), 'express',
    `R49-16：运行时依赖应只剩 express，实际 ${JSON.stringify(Object.keys(pkg.dependencies || {}))}`);

  // 源码里不得再有它的调用点，也不得有文件名带 cos 的模块
  const reqs = [];
  const names = [];
  for (const dir of ['server', 'scripts', 'public/js', 'tests']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir, d), { withFileTypes: true })) {
        if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
        const rel = path.join(dir, d, e.name);
        if (!e.name.endsWith('.js')) continue;
        if (/require\(\s*['"]cos-nodejs-sdk-v5['"]\s*\)/.test(readSrc(rel))) reqs.push(rel);
        if (dir === 'server' && /cos/i.test(e.name)) names.push(rel);
      }
    };
    walk('');
  }
  assertEqual(reqs.length, 0, `R49-16：这些文件仍在加载该 COS SDK：${reqs.join(', ')}`);
  assertEqual(names.length, 0, `R49-16：server/ 下不得再有文件名含 cos 的模块：${names.join(', ')}`);

  // 唯一真正的能力退化：COS 的 ?stats 单次桶容量接口随 SDK 一起没了
  const bs = stripComments(readSrc('server', 'bucket-stats.js'));
  assert(!/getBucketStatViaApi/.test(bs),
    'R49-16：bucket-stats.js 里的 COS 专属 ?stats 通路必须删除（S3 协议没有这个操作，client 会抛 501）');
  assert(!/\?stats|Action=GetBucketStat/.test(bs), 'R49-16：不得再拼 COS 的 ?stats 请求');
});

/* ================================================================== *
 * R49-17 · 改名后的标识符不再残留 cos 形态
 * ================================================================== */

test('R49-17 · 与 cos 有关的标识符 / 反馈串全部改用 s3 口径', () => {
  // 服务端局部命名
  const gw = stripComments(readSrc('server', 'fs-gateway.js'));
  assert(!/requireCfgCos|\bcosStream\b|\bcosOpts\b/.test(gw),
    'R49-17：fs-gateway.js 里不得再出现 requireCfgCos / cosStream / cosOpts');
  assert(/function requireS3\(/.test(gw), 'R49-17：fs-gateway.js 的新名字是 requireS3');

  const wd = stripComments(packageSource('server/webdav-server.js', 'server/webdav'));
  assert(!/function requireCos\(/.test(wd), 'R49-17：webdav-server.js 里不得再有 requireCos');
  assert(/async function requireS3\(/.test(wd), 'R49-17：webdav-server.js 的新名字是 requireS3');

  // 会话 Cookie 与验证码 UA
  assert(/const COOKIE_NAME = 's3mgr_session';/.test(readSrc('server', 'auth-session.js')),
    'R49-17：会话 Cookie 应为 s3mgr_session（旧名 cosmgr_session）');
  assert(/'User-Agent': 's3mgr-captcha\/1\.0'/.test(readSrc('server', 'captcha.js')),
    'R49-17：验证码请求的 UA 应为 s3mgr-captcha/1.0');

  // 前端验证码回调名：脚本 URL 里的 onload 与 window 上的赋值必须一致，
  // 否则脚本加载完找不到回调 → 组件永远渲染不出来（静默的空白验证码框）
  const mainSrc = readSrc('public', 'js', 'main.js');
  assert(/onload=__s3CaptchaReady/.test(mainSrc), 'R49-17：验证码脚本 URL 要挂到 __s3CaptchaReady');
  assert(/window\.__s3CaptchaReady\s*=/.test(mainSrc), 'R49-17：window 上的回调名必须与 URL 一致');
  assert(!/__cosCaptchaReady/.test(stripComments(mainSrc)), 'R49-17：不得残留 __cosCaptchaReady');
});

/* ================================================================== *
 * R49-18 · 收口 `copySource()` 时形参表不得改窄（参数错位是静默失败）
 * ================================================================== */

test('R49-18 · copySource 的形参表不得被收口时改窄（去掉 region 会让 key 错位）', () => {
  /**
   * 本轮的真实现象：删掉 `copySource()` 的厂商分支时，顺带把第 3 个形参 `region`
   * 也去掉了，而调用点仍按老位置传四个实参 ⇒ 真正的 `key` 落进 `region` 的位置，
   * 复制请求指向一个不存在对象。
   *
   * 为什么这条必须**按四参调用**来判：三参版本在「只传三个实参」时行为正确，
   * 只有**保留四个实参**的调用（`tests/azure-client.test.js` 的 R30 用例就是）
   * 才会暴露错位。所以判据就是「四参调用必须返回以第 4 个实参为键的路径」。
   */
  const src = s3Mod.copySource('azure', 'mycontainer', 'auto', 'dir/a b.txt');
  assertEqual(src, '/mycontainer/dir/a%20b.txt',
    'R49-18：四参调用时第 4 个实参才是 key —— 形参表被改窄会让 key 错位成「地域」');
  assertEqual(s3Mod.copySource('aliyun', 'b1', 'cn-hangzhou', 'k.txt'), '/b1/k.txt',
    'R49-18：S3 厂商同理（全部厂商统一形态）');
  assert(!src.includes('myqcloud'),
    'R49-18：不得再落进 `bucket.cos.<region>.myqcloud.com/…` 外链分支（R49 已整体删除）');

  // 三处生产调用点必须仍按**四个实参**传：少传会让 key 变成 undefined
  const sites = [
    ['server/fs-gateway.js', 'copySource(cfg.provider, cfg.bucket, cfg.region, srcK)'],
    ['server/fs-gateway.js', 'copySource(cfg.provider, cfg.bucket, cfg.region, it.key)'],
    ['server/routes/fs.js', 'copySource(cfg.provider, cfg.bucket, cfg.region, fromKey)'],
  ];
  for (const [file, call] of sites) {
    assert(stripComments(readSrc(file)).includes(call),
      `R49-18：${file} 的调用点必须按四参传（实参个数与形参表一致）：${call}`);
  }
});
