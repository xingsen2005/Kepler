/**
 * 第四十三轮护栏（R43-01 ~ R43-03）—— 用户报告的三件事
 *
 * ① 「华为云可以正常绑定 API Key，可以从云端获取存储桶列表，但无法添加存储桶，
 *    提示『无法访问该存储桶：Error: 资源不存在：对象或存储桶不存在』」
 * ② 「又拍云不能使用操作员和密码绑定 API Key，因为又拍云使用 S3 兼容协议，
 *    也同样需要 AccessKey、SecretAccessKey」
 * ③ 「『备份设置』中，编辑框默认会完全显示备份码，应改为部分掩码，
 *    仅复制和导出才能得到完整备份码」
 *
 * ## ① 的根因（与签名、与密钥都无关）
 *
 * 华为云 OBS 的 `ListBuckets`（`GET /`）**默认不回桶的地域** —— 官方 SDK 的
 * `listBuckets(queryLocation)` 写明「`queryLocation` 默认 false」；而 OBS 对
 * 「请求域名里的地域与桶实际所在地域不一致」的响应是 **HTTP 404 NoSuchBucket**
 * （官方《Accessing OBS》：地域不一致时「上报告知桶不存在」），既不重定向也不提示
 * 地域不对。于是：
 *
 *   ListBuckets 只回 Name/CreationDate
 *     → 客户端拿**自己的** region 冒充桶的地域（`|| this.region`）
 *       → 界面把这个假地域回填进「添加存储桶」表单
 *         → 添加时访问 `<bucket>.obs.<假地域>.myhuaweicloud.com`
 *           → 404 ⇒ 界面读成「资源不存在 / 密钥不对」
 *
 * 而「列举桶能成功、添加桶必失败」这种分裂表现是**必然**的：ListBuckets 与
 * GetBucketLocation 恰好是官方点名的两个「不受 endpoint 地域限制」的接口，
 * 其余接口都必须用对地域。
 *
 * 修法：注册表声明 `queryBucketLocation: true`（华为云），`getService` 在某个桶
 * 没有地域信息时**逐个补查** `GET /<bucket>?location`，取不到才退回 `this.region`。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R43-*` 条目。
 * ⚠️ 组网一律 `listen(0)`；所有出站请求走 fetch 拦截，绝不真连云端。
 */
const fsc = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { test } = require('node:test');
const { ROOT, assert, assertEqual } = require('./helpers.js');

const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 's3-audit43-'));
process.env.S3_DATA_DIR = TMP;

const express = require(path.join(ROOT, 'node_modules', 'express'));
const providers = require(path.join(ROOT, 'server', 'providers.js'));
const s3 = require(path.join(ROOT, 'server', 's3.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const configRoutes = require(path.join(ROOT, 'server', 'routes', 'config.js'));

/* ==================================================================== */
/* 出站拦截：按 URL 分派响应，并记录每一次请求                                */
/* ==================================================================== */

const captured = [];
const realFetch = global.fetch;

/**
 * 安装 fetch 桩。
 * @param {(url:string, init:object)=>{status?:number, xml:string}|null} handler
 *        返回 null 表示「该 URL 不该被请求」，会立即失败（让假绿无处藏身）
 */
function installFetch(handler) {
  captured.length = 0;
  global.fetch = (url, init) => {
    captured.push({
      url: String(url),
      method: String((init && init.method) || 'GET').toUpperCase(),
    });
    const r = handler(String(url), init || {});
    if (!r) {
      return Promise.reject(new Error('未预期的出站请求：' + String(url)));
    }
    return Promise.resolve(new Response(r.xml || '', {
      status: r.status || 200,
      headers: { 'content-type': 'application/xml' },
    }));
  };
}
process.on('exit', () => { global.fetch = realFetch; });

const urlsOf = () => captured.map((c) => c.url);
const locationCalls = () => urlsOf().filter((u) => /\?location(?:=|&|$)/.test(u));

/** 组装一份 ListBuckets 响应；`withLocation` 为 false 时**不含** <Location>（华为云默认形态） */
function listBucketsXml(entries, withLocation) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<ListAllMyBucketsResult xmlns="http://obs.cn-north-4.myhuaweicloud.com/doc/2015-06-30/">'
    + '<Owner><ID>owner-id</ID><DisplayName>owner</DisplayName></Owner><Buckets>'
    + entries.map((e) => '<Bucket><Name>' + e.name + '</Name>'
      + '<CreationDate>2026-01-01T00:00:00.000Z</CreationDate>'
      + (withLocation ? '<Location>' + e.location + '</Location>' : '')
      + '</Bucket>').join('')
    + '</Buckets></ListAllMyBucketsResult>';
}

/* ==================================================================== */
/* R43-01 · 华为云：ListBuckets 不回地域时必须补查 GetBucketLocation          */
/* ==================================================================== */

const HW_ENTRIES = [
  { name: 'hw-east', location: 'cn-east-3' },
  { name: 'hw-south', location: 'cn-south-1' },
];

/** 华为云的假云端：服务级列举不回地域，桶级 ?location 回真实地域 */
function huaweiCloud() {
  return (url) => {
    const u = new URL(url);
    if (u.host === 'obs.cn-north-4.myhuaweicloud.com') {
      return { xml: listBucketsXml(HW_ENTRIES, false) };
    }
    const m = /^([a-z0-9-]+)\.obs\.cn-north-4\.myhuaweicloud\.com$/.exec(u.host);
    if (m && u.searchParams.has('location')) {
      const e = HW_ENTRIES.find((x) => x.name === m[1]);
      return { xml: '<?xml version="1.0" encoding="UTF-8"?><Location>'
        + (e ? e.location : 'cn-north-4') + '</Location>' };
    }
    return null;
  };
}

function makeClient(opts) {
  return s3.createClient(Object.assign({
    provider: 'huawei',
    secretId: 'HWAKxxxxxxxxxxxxxxxx',
    secretKey: 'h'.repeat(32),
    region: 'cn-north-4',
  }, opts));
}

test('R43-01a · 华为云列举桶：服务端不回地域时必须逐个补查 GetBucketLocation，不得拿客户端地域冒充', async () => {
  installFetch(huaweiCloud());
  const svc = await makeClient({}).getService({});
  const got = svc.Buckets.map((b) => b.Name + '@' + b.Region).join(',');
  assertEqual(got, 'hw-east@cn-east-3,hw-south@cn-south-1',
    'R43-01a：地域必须来自 GetBucketLocation，而不是客户端自己的 cn-north-4（实际 ' + got + '）');
  assertEqual(locationCalls().length, 2,
    'R43-01a：两个缺地域的桶各补查一次 ?location（实际 ' + JSON.stringify(urlsOf()) + '）');
  assert(!svc.Buckets.some((b) => b.Region === 'cn-north-4'),
    'R43-01a：任何桶都不得被安上客户端的 region');
  // 每个补查都必须打到**该桶自己的**主机上（虚拟主机风格，桶名在域名最前）
  assert(locationCalls().some((u) => u.startsWith('https://hw-east.obs.cn-north-4.myhuaweicloud.com/')),
    'R43-01a：补查必须走虚拟主机风格（桶名进域名），实际 ' + JSON.stringify(locationCalls()));
});

test('R43-01b · 服务端已回地域时不得多打一轮（不能变成「每次都补查」）', async () => {
  installFetch((url) => {
    const u = new URL(url);
    if (u.host === 'obs.cn-north-4.myhuaweicloud.com') {
      return { xml: listBucketsXml(HW_ENTRIES, true) };
    }
    return null; // 任何桶级请求都算违约
  });
  const svc = await makeClient({}).getService({});
  assertEqual(svc.Buckets.map((b) => b.Region).join(','), 'cn-east-3,cn-south-1',
    'R43-01b：服务端已给地域时应直接采用');
  assertEqual(locationCalls().length, 0,
    'R43-01b：不该为已有地域的桶再补查一次（实际 ' + JSON.stringify(urlsOf()) + '）');
});

test('R43-01c · 未声明 queryBucketLocation 的厂商行为与历史逐字一致（不得顺手套到别家）', async () => {
  installFetch((url) => {
    const u = new URL(url);
    if (u.host === 's3.us-east-1.amazonaws.com') {
      return { xml: listBucketsXml([{ name: 'aws-b', location: 'us-west-2' }], false) };
    }
    return null; // AWS 不该出现桶级 ?location
  });
  const svc = await s3.createClient({
    provider: 'aws', secretId: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
  }).getService({});
  assertEqual(svc.Buckets[0].Region, 'us-east-1',
    'R43-01c：AWS 未声明该能力，仍按历史兜底为客户端地域');
  assertEqual(locationCalls().length, 0, 'R43-01c：不得为 AWS 也补查 ?location');
});

test('R43-01d · 注册表里只有华为云声明 queryBucketLocation，且客户端确实拿到了它', async () => {
  assertEqual(providers.queryBucketLocation('huawei'), true, 'R43-01d：华为云必须声明 queryBucketLocation');
  for (const id of ['tencent', 'aliyun', 'qiniu', 'upyun', 'azure', 'aws', 'gcs', 'r2', 'minio', 'b2']) {
    assertEqual(providers.queryBucketLocation(id), false, `R43-01d：${id} 不得声明 queryBucketLocation`);
  }
  assertEqual(providers.queryBucketLocation('不存在的厂商'), false, 'R43-01d：未知厂商回退后也不得为 true');
  assertEqual(providers.PROVIDERS.filter((p) => p.queryBucketLocation).length, 1,
    'R43-01d：全表只允许有一家声明 queryBucketLocation');
  // 注册表 → s3.createClient → S3Client 这条链必须真的接通（配置层改对、执行层没执行是真踩过的形态）
  assertEqual(makeClient({}).queryBucketLocation, true,
    'R43-01d：厂商声明必须真的传到客户端实例上');
  assertEqual(s3.createClient({
    provider: 'aws', secretId: 'a', secretKey: 'b', region: 'us-east-1',
  }).queryBucketLocation, false, 'R43-01d：别家不得被顺带打开');
});

test('R43-01e · 端到端：经 /config/verify 取回的桶列表，地域必须是桶自己的（用户报的那条路）', async () => {
  // 种一把华为云密钥：**只有密钥、没有地域**（密钥表单里根本没有地域栏）
  configStore.save({
    credentials: [{
      id: 'c-hw', provider: 'huawei', secretId: 'HWAKxxxxxxxxxxxxxxxx',
      secretKey: 'h'.repeat(32), endpoint: '', quotaBytes: 0,
      enabled: true, visibleToUsers: true, remark: '',
    }],
    buckets: [],
    activeCredentialId: 'c-hw',
    activeBucketId: '',
  });
  installFetch(huaweiCloud());
  const srv = await serve('/api', configRoutes);
  try {
    const r = await send(srv.port, 'POST', '/api/config/verify', { credentialId: 'c-hw' });
    assertEqual(r.status, 200, 'R43-01e：验证接口应正常应答（实际 ' + r.raw + '）');
    assert(r.json && r.json.ok === true, 'R43-01e：应验证通过，实际 ' + JSON.stringify(r.json));
    const got = (r.json.buckets || []).map((b) => b.name + '@' + b.region).join(',');
    assertEqual(got, 'hw-east@cn-east-3,hw-south@cn-south-1',
      'R43-01e：界面拿到的地域必须是真实的，否则回填进表单后添加桶必被 404 拒绝（实际 ' + got + '）');
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R43-02 · 又拍云的凭据是 S3 的 AccessKey / SecretAccessKey                */
/* ==================================================================== */

test('R43-02a · 又拍云密钥字段必须是 AccessKey / SecretAccessKey（不是操作员密码）', async () => {
  const srv = providers.get('upyun');
  assert(srv && srv.credentialLabel, 'R43-02a：又拍云必须在注册表里');
  assertEqual(srv.credentialLabel.id, 'AccessKey', 'R43-02a：字段名必须是 AccessKey');
  assertEqual(srv.credentialLabel.key, 'SecretAccessKey', 'R43-02a：字段名必须是 SecretAccessKey');
  assert(!/操作员/.test(JSON.stringify(srv.credentialLabel)),
    'R43-02a：不得再出现「操作员」—— 那是控制台账号密码，与 S3 凭据是两套东西');

  // 前端那份副本必须同源（两处各写一份，漂移了没有任何东西会报错）
  const logos = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'provider-logos.js')).href);
  const web = logos.providerMeta('upyun');
  assertEqual(web.idLabel, srv.credentialLabel.id, 'R43-02a：前端 idLabel 必须与服务端同值');
  assertEqual(web.keyLabel, srv.credentialLabel.key, 'R43-02a：前端 keyLabel 必须与服务端同值');
  assert(!/操作员/.test(JSON.stringify(web)), 'R43-02a：前端元数据里也不得再出现「操作员」');
});

/* ==================================================================== */
/* R43-03 · 备份实时码默认部分掩码                                          */
/* ==================================================================== */

/** 造一串「像真的」实时码：抬头 + 一段较长的 base64url 载荷 */
const LIVE = 'KEPLER-CONFIG-V1.' + Buffer.from(JSON.stringify({
  v: 1, credentials: [{ secretId: 'AKIDxxxxxxxx', secretKey: 'very-secret-value' }],
})).toString('base64url').repeat(4);

/** ---- 前端沙箱：只替换它真正 import 的两个模块 ---- */

const JS_DIR = path.join(ROOT, 'public', 'js');

function makeSandbox(liveCode) {
  const dir = fsc.mkdtempSync(path.join(os.tmpdir(), 's3-audit43-web-'));
  fsc.writeFileSync(path.join(dir, 'api.js'),
    'export const API = {\n'
    + '  backupStatus: async () => ({ canImport: false }),\n'
    + '  backupCode: async () => ({ code: ' + JSON.stringify(liveCode) + ', fingerprint: "abc123456789", summary: {} }),\n'
    + '  backupExport: async () => ({ code: "EXPORTED", fingerprint: "abc123456789" }),\n'
    + '  backupImport: async () => ({ ok: true, summary: {} }),\n'
    + '};\n');
  fsc.writeFileSync(path.join(dir, 'util.js'),
    'export function toast() {}\nexport function openModal() {}\n');
  fsc.copyFileSync(path.join(JS_DIR, 'backupcfg.js'), path.join(dir, 'backupcfg.js'));
  return dir;
}

function installFakeDom(ids) {
  const nodes = new Map();
  const mk = (id) => ({
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    style: {}, onclick: null,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, appendChild() {}, querySelector: () => null,
  });
  for (const id of ids) nodes.set(id, mk(id));
  globalThis.document = {
    getElementById: (id) => (nodes.has(id) ? nodes.get(id) : null),
    createElement: () => mk('tmp'),
  };
  return nodes;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('R43-03a · maskCode：保留抬头与首尾、隐藏中间，且掩码串里不含完整码', async () => {
  const dir = makeSandbox(LIVE);
  const mod = await import(pathToFileURL(path.join(dir, 'backupcfg.js')).href + '?v=' + Math.random());
  const masked = mod.maskCode(LIVE);
  const payload = LIVE.slice('KEPLER-CONFIG-V1.'.length);

  assert(masked.startsWith('KEPLER-CONFIG-V1.' + payload.slice(0, 6)),
    'R43-03a：抬头与前 6 位应原样保留，实际 ' + masked.slice(0, 40));
  assert(masked.endsWith(payload.slice(-6)), 'R43-03a：末尾 6 位应原样保留');
  assert(masked.includes('•'.repeat(24)), 'R43-03a：中间必须是定宽掩码');
  assert(masked.length < LIVE.length, 'R43-03a：掩码串必须比原码短');
  assert(masked !== LIVE, 'R43-03a：掩码后绝不能等于原码');
  assert(!masked.includes(payload.slice(10, 30)), 'R43-03a：中段明文不得出现在掩码串里');
  // 反向对照：取法本身必须有效 —— 同一套取法在**原码**上必须能取到那一段
  assert(LIVE.includes(payload.slice(10, 30)), 'R43-03a：自证失败 —— 原码里本来就该有这一段');

  assertEqual(mod.maskCode(''), '', 'R43-03a：空码原样返回（空态不该显示一串掩码）');
  assertEqual(mod.maskCode(null), '', 'R43-03a：null 原样返回空串');
  const short = mod.maskCode('KEPLER-CONFIG-V1.abc');
  assertEqual(short, 'KEPLER-CONFIG-V1.•••', 'R43-03a：载荷过短时整体掩掉，不得出现「可见比掩码长」');
});

test('R43-03b · 调用点层：refresh() 之后 DOM 里只能有掩码，完整码留在内存', async () => {
  const dir = makeSandbox(LIVE);
  const nodes = installFakeDom([
    'backup-code', 'backup-meta-text', 'backup-import-hint',
    'btn-backup-copy', 'btn-backup-export', 'btn-backup-import', 'btn-backup-refresh',
  ]);
  nodes.set('sysset-backup-card', Object.assign(nodes.get('btn-backup-refresh'), { id: 'sysset-backup-card' }));

  const mod = await import(pathToFileURL(path.join(dir, 'backupcfg.js')).href + '?v=' + Math.random());
  mod.refresh();
  await tick();

  const shown = nodes.get('backup-code').value;
  assert(shown, 'R43-03b：应已填入展示串');
  assert(shown !== LIVE, 'R43-03b：DOM 里绝不能是完整实时码');
  assert(!shown.includes(LIVE.slice(0, 40)),
    'R43-03b：实时码明文不得整段出现在 textarea 里（实际 ' + shown.slice(0, 60) + '）');
  assert(shown.includes('•'), 'R43-03b：展示串必须是掩码');
  assertEqual(mod.currentLiveCode(), LIVE,
    'R43-03b：内存里仍须保留完整码（复制 / 导出走的是服务端重新生成，这里只是不落 DOM）');
  // 长度行仍应如实反映**完整码**的长度（它是「配置有没有变」的判据）
  assert(String(nodes.get('backup-meta-text').textContent).includes(String(LIVE.length) + ' 字符'),
    'R43-03b：指纹行必须报完整码的长度，实际 ' + nodes.get('backup-meta-text').textContent);
});

/* ==================================================================== */
/* 最小 HTTP 挂载（与 audit42 同款）                                        */
/* ==================================================================== */

function serve(mount, router) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'u1', role: 'admin' }; next(); });
  app.use(mount, router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function send(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : null),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
