/**
 * 第八十三轮护栏：**表单 POST 之后不许再跨域 3xx**
 *
 * ## 用户原话
 *
 *   「订单已经创建成功（后台状态：支付中），卡住的是「从本页跳转到支付平台」这一步，
 *     不是下单失败。」
 *
 * 这句话正是 R81 看门狗在 `pending` 态下给出的判定。它说的是实情：订单建好了，
 * 页面却没走。本轮要回答的就是「为什么没走」。
 *
 * ## 根因：CSP `form-action` 也管「表单 POST 之后的重定向目标」
 *
 * 浏览器对 `form-action` 的实现并不一致，而**不一致的方向恰好是最伤的那个**：
 *
 *  · Chrome / Safari：把 `form-action` 施加到**提交后的每一次重定向**上。
 *    表单一 POST，服务端回 `302 Location: https://openapi.alipay.com/...`，
 *    浏览器判定「重定向目标不在 form-action 允许列表里」⇒ **拦掉整次导航**，
 *    控制台报 `Refused to send form data to '' because it violates ... "form-action 'self'"`
 *    （注意报错里那个域名是空的、甚至指向表单自己的 action —— 于是这条错误信息
 *    本身就会把人往错的方向带）；
 *  · Firefox：只查表单初始 action，重定向照走。
 *
 * 所以症状是「同一个站点，Firefox 能付、Chrome 点了没反应」，而**服务端日志一切正常**
 * （订单确实建好了、302 也确实回了）—— 极易被误判成网络/代理/网关问题。
 * W3C 的 webappsec-csp issue #8 自 2015 年至今未定，不能指望统一。
 *
 * ## 修法：让表单 POST 只回同源页面，由页面自己发起导航
 *
 * 页面自身发起的导航（meta refresh、点链接）**不受 `form-action` 约束**。
 * 于是 `POST /s/:id/pay` 成功后渲染「正在跳转到支付平台」中转页：
 * meta refresh 自动走，同时给一个可点按钮兜底。零脚本 —— CSP 不允许内联脚本，
 * 而这两样都不需要脚本。
 *
 * 另一条路（把网关域名加进 `form-action`）被**明确否决**：网关地址是用户手填、
 * 可换支付平台的，无法枚举；为修一个 bug 而拆掉这条指令的防护面不划算。
 * R83-05 就是钉这一点的 —— 哪天有人图省事把 CSP 放宽了，它会变红。
 *
 * ## 判据落点
 *
 *  · R83-01/02/03/06 落在**真实 HTTP 响应**上（状态码、有无 location、响应体里的
 *    跳转形态、非法地址是否被拒、订单最终状态）；
 *  · R83-04 落在**源码结构**上：这是「防回归」，而回归的形态是「有人觉得 302 更省事
 *    又改回去」—— 那种改动在运行期看起来完全正常（因为 Firefox 能走），只有结构断言抓得住；
 *  · R83-05 落在**CSP 头本身**。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir } = require('./helpers.js');

const tmp = makeTempDir('r83-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 打桩（与 audit82 同构：真实路由 + 真实 store，只替换外部依赖）
 * ---------------------------------------------------------------- */
const s3 = require(SERVER('s3.js'));
s3.getClient = () => ({
  headObject(_p, cb) { cb(null, { headers: { 'content-length': '5' } }); },
  getObject(params, cb) { params.Output.end(Buffer.from('hello')); cb(null, {}); },
});

const configStore = require(SERVER('config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const paymentRules = require(SERVER('payment-rules.js'));
paymentRules.snapshot = () => ({
  enabled: true,
  states: { alipay: true, wechat: true },
  configuredMap: { alipay: true, wechat: true },
  available: ['alipay', 'wechat'],
});
paymentRules.resolvePaidState = () => ({
  required: true, effective: true, amountFen: 100, currency: 'CNY', reason: '',
});

const paymentProviders = require(SERVER('payment-providers.js'));
paymentProviders.isConfigured = () => true;

const statsStore = require(SERVER('stats-store.js'));
const logs = [];
statsStore.addLog = (r) => { logs.push(r); };
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

/** 下单桩：默认回一个「跳收银台」的成功结果，`charge` 可被每条用例改写 */
let charge = { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
const origCharge = paymentGateway.createCharge;
paymentGateway.createCharge = async () => charge;

/* ---------------------------------------------------------------- *
 * HTTP 夹具
 * ---------------------------------------------------------------- */
async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', shareRoutes);
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

/** 表单形态的 POST（浏览器点「立即支付」就是这个样子） */
function postForm(port, urlPath) {
  const body = 'platform=alipay&coupon=';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let seq = 0;
async function makePaidLink() {
  seq += 1;
  return shareStore.create({
    key: 'r83/' + seq + '.txt', bucket: 'tb-' + seq, region: 'ap-guangzhou',
    fileName: 'f' + seq + '.txt', size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 100, currency: 'CNY' },
  });
}

/** 取本次用例最近建的那笔订单（`listAll()` 是按时间倒序还是正序不做假设，直接按 id 找最大的） */
const lastOrder = () => {
  const all = paymentOrders.listAll() || [];
  if (!all.length) return null;
  return all.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
};

/* ================================================================== *
 * ① 核心：跳转必须由「同源中转页」发起，而不是这次表单 POST 的 3xx
 * ================================================================== */
test('R83-01 · 表单 POST 成功后必须回同源中转页（200），不得再跨域 3xx', async () => {
  charge = { ok: true, kind: 'redirect', url: 'https://example.invalid/pay?a=1&b=2' };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await postForm(srv.port, '/s/' + l.id + '/pay');

    assertEqual(r.status, 200, `必须是同源页面（200），实际 ${r.status}：${r.raw.slice(0, 200)}`);
    assert(!r.headers.location,
      `★ 不得再用 3xx 把人送去网关：Chrome/Safari 会把 form-action 施加到表单提交后的`
      + `重定向目标上，跨域 3xx 会被整条拦掉（页面一动不动，而订单已建好）。`
      + `实际带了 location：${r.headers.location}`);
    assert(/text\/html/.test(String(r.headers['content-type'] || '')), '中转页必须是 HTML');

    // 两个跳转通道都要在：meta refresh（自动）+ 可点链接（兜底，禁用 JS 也能用）
    assert(/http-equiv="refresh"[^>]*content="0;url=https:\/\/example\.invalid\/pay\?a=1&amp;b=2"/.test(r.raw),
      `meta refresh 必须带上收银台地址（且经属性转义：& 要写成 &amp;）。实际片段：`
      + r.raw.slice(Math.max(0, r.raw.indexOf('refresh') - 40), r.raw.indexOf('refresh') + 160));
    assert(r.raw.indexOf('href="https://example.invalid/pay?a=1&amp;b=2"') >= 0,
      '必须有可点击的收银台链接兜底（meta refresh 被插件/浏览器设置拦掉时靠它）');
    assert(/rel="noopener noreferrer"/.test(r.raw), '外链要带 rel=noopener noreferrer');
    assert(/正在跳转到/.test(r.raw), '页面要明确说「正在跳转」，而不是一片空白');
    // `orderMetaRows()` 已自带「支付金额 / 支付方式 / 订单号」三行 —— 再插一次会让同一张卡片里
    // 出现两行「支付方式」（本轮真踩过），属于「不报错、只是变丑」的静默回归，用计数钉住
    assertEqual((r.raw.match(/<span>支付方式<\/span>/g) || []).length, 1,
      '「支付方式」只能出现一行（orderMetaRows() 已经渲染过）');

    // 订单必须是 pending（不是 failed）：中转页的存在前提是「真的可以付」
    const o = lastOrder();
    assert(o, '必须留下了订单');
    assertEqual(o.status, 'pending', '走到中转页时订单应是在途（pending）');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ② 收银台地址的协议白名单
 * ================================================================== */
test('R83-02 · 收银台地址只接受 http/https：javascript: / data: 一律拒绝跳转', async () => {
  const bad = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ];
  const srv = await serve();
  try {
    for (const url of bad) {
      charge = { ok: true, kind: 'redirect', url };
      const l = await makePaidLink();
      const r = await postForm(srv.port, '/s/' + l.id + '/pay');

      /**
       * 关键：**不能**把它渲染成可点的链接 / meta refresh。这类协议在
       * `<a href>` 里点一下就是「在本站源里执行脚本」，是自伤型 XSS。
       */
      assert(r.raw.indexOf(url) < 0,
        `不可执行的协议不得出现在响应里（${url}），实际出现了`);
      assert(!/http-equiv="refresh"/.test(r.raw), `拒绝跳转时不该再有 meta refresh（${url}）`);
      assert(/没有返回可用的收银台地址/.test(r.raw),
        `要说清「渠道没给可用的收银台地址」，实际：${r.raw.slice(0, 200)}`);

      const o = lastOrder();
      assertEqual(o.status, 'failed', `订单必须收尾为失败（${url}），否则永远停在支付中`);
    }
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ③ 地址进属性前的转义
 * ================================================================== */
test('R83-03 · 收银台地址进 href / meta content 前必须转义（不能逃出属性）', async () => {
  const url = 'https://evil.example/"><script>alert(1)</script>';
  charge = { ok: true, kind: 'redirect', url };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await postForm(srv.port, '/s/' + l.id + '/pay');

    assert(r.raw.indexOf('"><script>') < 0,
      '★ 地址里的引号与尖括号不得原样落进属性 —— 否则可以从 href 里逃出来执行脚本');
    assert(r.raw.indexOf('&quot;&gt;&lt;script&gt;') >= 0,
      `应当整体转义为实体（&quot;&gt;&lt;script&gt;）。实际片段：`
      + r.raw.slice(Math.max(0, r.raw.indexOf('evil.example') - 20), r.raw.indexOf('evil.example') + 90));
    assertEqual(r.status, 200, '转义后仍是一张正常的中转页');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * ④ 源码结构：这是防回归的钉子
 * ================================================================== */
test('R83-04 · 源码层：支付 POST 处理器不得把 charge.url 交给 res.redirect', () => {
  const src = fs.readFileSync(SERVER('share-routes.js'), 'utf8');

  // 取出 POST /s/:id/pay 的处理器体（按大括号配对，避免被同文件其它 res.redirect 干扰）
  const at = src.indexOf("router.post('/s/:id/pay'");
  assert(at >= 0, '必须能定位到 POST /s/:id/pay');
  const braceStart = src.indexOf('{', src.indexOf('async (req, res)', at));
  let depth = 0;
  let end = -1;
  for (let k = braceStart; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) { end = k; break; }
    }
  }
  assert(end > braceStart, '必须能取出处理器体');
  const handler = src.slice(braceStart, end + 1);

  assert(!/res\.redirect\([^;]*charge\.url/.test(handler),
    '★ 回归钉子：处理器里不得出现「把 charge.url 塞进 res.redirect」——'
    + '那正是 Chrome/Safari 按 form-action 拦掉的形态，而它在 Firefox 与 curl 下看起来完全正常');
  assert(/jumpPage\(res, l, order, payUrl\)/.test(handler),
    '成功路径必须走 jumpPage()');
  assert(/safePayUrl\(charge\.url\)/.test(handler),
    'charge.url 必须先过 safePayUrl()（协议白名单）再渲染');
});

/* ================================================================== *
 * ⑤ 不许靠放宽 CSP 来「修」
 * ================================================================== */
test("R83-05 · 不许靠放宽 CSP 修：form-action 必须仍是 'self'，不得加进支付域名", () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const m = src.match(/Content-Security-Policy['"]?\s*,\s*([\s\S]{0,1200}?)<\/|Content-Security-Policy['"]?\s*,\s*([\s\S]{0,900}?)\);/);
  const block = m ? (m[1] || m[2] || '') : '';
  assert(/form-action 'self';/.test(src), "form-action 'self' 必须原样保留（防御面不许为 bug 让路）");
  assert(!/form-action[^;"]*(alipay|weixin|wechat|paypal)/i.test(src),
    '不得把某个支付网关域名加进 form-action —— 网关地址是用户手填的，枚举不出来，且这等于拆掉这条指令');
  assert(block || /form-action 'self';/.test(src), 'CSP 头必须可定位');
});

/* ================================================================== *
 * ⑥ 微信 Native 不该被这次改动波及
 * ================================================================== */
test('R83-06 · 二维码渠道不受影响：仍然渲染同源二维码页，不跳转', async () => {
  charge = { ok: true, kind: 'qrcode', svg: '<svg id="fakeqr"></svg>', codeUrl: 'weixin://x' };
  const srv = await serve();
  try {
    const l = await makePaidLink();
    const r = await postForm(srv.port, '/s/' + l.id + '/pay');

    assertEqual(r.status, 200, `二维码页应是 200，实际 ${r.status}`);
    assert(!r.headers.location, '二维码页不该有 location');
    /**
     * R93：码**从内容重绘**（`qrBoxHtml(payload)` → `qrcode.toSvg()`），不再把网关
     * 返回的 SVG 字符串原样内联 —— 订单里存的是码的内容而不是几十 KB 的图形，
     * 刷新/回访时才能凭 `order.qrPayload` 重建同一张图。所以桩里的 `svg`
     * 不该出现在页面上，要断言的是「有一个画着 SVG 的 .qr-box」。
     */
    assert(r.raw.indexOf('class="qr-box"') >= 0, '必须渲染二维码容器');
    assert(/<div class="qr-box"[^>]*>\s*<svg/i.test(r.raw), '二维码容器里必须有内联 SVG');
    assert(r.raw.indexOf('立即支付') < 0, '已经有码时不该再摆「立即支付」按钮');
    assert(!/http-equiv="refresh"/.test(r.raw), '二维码页不该自动跳走（用户要扫码）');
    assertEqual(lastOrder().status, 'pending', '二维码页对应的是在途订单');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * 收尾
 * ================================================================== */
test('R83-99 · 收尾：还原下单桩', () => {
  paymentGateway.createCharge = origCharge;
  assertEqual(typeof paymentGateway.createCharge, 'function', '下单桩已还原');
});
