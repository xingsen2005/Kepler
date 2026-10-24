/**
 * 第八十轮护栏：「点击『立即支付』没有任何反应」
 *
 * ## 缺陷（用户原话）
 *
 *   「填写正确的应用ID、私钥、公钥、网关地址，点击『立即支付』没有任何反应。」
 *
 * 与 R79 的 ① 不同：这一次**凭证是对的**，`1E08010C` 已经不会再出现。真正的问题是
 * 「点击 → 页面纹丝不动」这个**观感**在系统里有多条来源，而它们**没有一条**会留下
 * 可读的痕迹。逐条排查后成立的：
 *
 *   A. `POST /s/:id/pay` 有三条**静默 303**（`res.redirect(303, '/s/' + l.id)`）：
 *      付费刚被停用 / 密码票据失效 / 订单已支付。页面上一个字都不变 —— 尤其第一条，
 *      当 `ps.effective` 由真变假，`/s/:id` 走的仍是同一张卡片，肉眼几乎无法察觉。
 *   B. 表单提交**没有任何即时反馈**：微信 / PayPal 下单是**真出网**（最长 10 秒），
 *      期间按钮既不变灰也没有转圈；而浏览器插件、受限内嵌窗口（缺 `allow-forms` 的
 *      `<iframe sandbox>`）会**整条吞掉**提交 —— 服务端连一条请求都收不到。
 *   C. 跨站校验对**表单导航**返回裸 JSON：用户落到一片 `{"error":…}` 上。本项目历史上
 *      就把同一现象记成过「提交无反应」，修 R27-03 时只修了判据、没修呈现形态。
 *   D. 支付宝渠道把 `sign_type=SM2` 静默降级成 RSA-SHA256（`rsaSign` 只分两档）：
 *      这边一切成功、跳转也发生了，支付宝必然回 `ILLEGAL_SIGN`。
 *   E. 网关地址里一个 `#` 就能让 `?app_id=…&sign=…` 整串落进**片段**：浏览器不把片段
 *      发给服务器，支付宝收到空请求 —— 页面「跳过去了」，却是一片空白。
 *   F. `createCharge` 说成功但没给收银台（`kind` 拼错 / `url` 为空）时，旧实现落到
 *      「等待支付」页：用户既没被送去支付平台也没有二维码，那个「我已完成支付」按钮
 *      永远查不到东西 —— 又一条「没有反应」。
 *
 * ## 判据落点
 *
 *  · A/B/F 落在**真实 HTTP 响应**上：303 的 `Location`、跟随之后页面里到底出现了什么字；
 *  · B 的另一半（脚本真的会拦住第二次点击、真的会在超时后给提示）用 `vm` 把
 *    `public/js/pay-poll.js` **真跑**一遍，喂一个假 DOM 与可控 `setTimeout`，断言 DOM 变化；
 *  · C 落在 `Content-Type` 与响应体形态上（浏览器拿页面、fetch 拿 JSON）；
 *  · D/E 落在 `createCharge` / `alipayBuildUrl` 的**返回物**上（错的签名算法必须
 *    根本产不出 URL；错的网关地址产出的 URL 必须能被解析出 sign）。
 *
 * ## 隔离
 * store 都认 `S3_DATA_DIR`，必须**先设环境变量再 require**。网关查单被换成可控桩。
 */
const path = require('path');
const http = require('http');
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r80-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ---------------------------------------------------------------- *
 * 密钥素材（R80 不测密钥，但付费流程需要一对真钥匙才能走到 302）
 * ---------------------------------------------------------------- */
const KEY_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const SPKI_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).trim();

/* ---------------------------------------------------------------- *
 * 打桩
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

/** 付费配置可变：每个用例按需要打开/关闭总开关与渠道 */
let paymentCfg = {
  enabled: true,
  siteUrl: 'http://127.0.0.1:3000',
  platforms: {
    alipay: {
      enabled: true, appId: '2021000000000000', privateKey: PKCS8_PEM,
      alipayPublicKey: SPKI_PEM, signType: 'RSA2',
      gateway: 'https://openapi.alipay.com/gateway.do',
    },
  },
};
configStore.getPayment = () => paymentCfg;
function resetPaymentCfg() {
  paymentCfg = {
    enabled: true,
    siteUrl: 'http://127.0.0.1:3000',
    platforms: {
      alipay: {
        enabled: true, appId: '2021000000000000', privateKey: PKCS8_PEM,
        alipayPublicKey: SPKI_PEM, signType: 'RSA2',
        gateway: 'https://openapi.alipay.com/gateway.do',
      },
    },
  };
}

const statsStore = require(SERVER('stats-store.js'));
const logs = [];
statsStore.addLog = (r) => { logs.push(r); };
statsStore.trackBucket = () => {};
statsStore.track = () => {};

const shareStore = require(SERVER('share-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const paymentGateway = require(SERVER('payment-gateway.js'));
const shareRoutes = require(SERVER('share-routes.js'));

paymentGateway.queryCharge = async () => ({ paid: false, state: 'pending', tradeNo: '', failReason: '' });

/* ---------------------------------------------------------------- *
 * HTTP 夹具
 * ---------------------------------------------------------------- */
async function serve() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', shareRoutes);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

let seq = 0;
function makePaidLink(key, extra) {
  seq += 1;
  return shareStore.create(Object.assign({
    key, bucket: 'tb-' + seq, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 5,
    expiresHours: 0, maxDownloads: 0, password: null, createdBy: 'tester',
    paid: { required: true, amountFen: 500 },
  }, extra || {}));
}

function makeOrder(l, patch) {
  const o = paymentOrders.create(Object.assign({
    linkId: l.id, platform: 'alipay', amountFen: 500, currency: 'CNY',
    fileName: l.fileName, fileKey: l.key, bucket: l.bucket, payerIp: '127.0.0.1',
  }, patch || {}));
  return paymentOrders.get(o.id);
}

const payCookie = (l, order) => 'sp_' + l.id + '_pay=' + encodeURIComponent(paymentOrders.orderToken(order));

/** 表单形态的 POST（浏览器点按钮就是这个样子：urlencoded + Accept: text/html） */
function postForm(port, urlPath, { fields = {}, headers = {} } = {}) {
  const body = Object.keys(fields)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/* ================================================================== *
 * A. 三条静默 303 必须变成「说清楚」的返回
 * ================================================================== */

test('R80-01 · 付费刚被停用：点击必须带回原因码，并解释这次为什么没建单', async () => {
  const srv = await serve();
  resetPaymentCfg();
  try {
    const l = await makePaidLink('a/off.txt');

    // 页面还在（ps.effective 为真），用户点了按钮 —— 但这一秒渠道被关掉了
    paymentCfg = Object.assign({}, paymentCfg, { enabled: false });

    const r = await postForm(srv.port, '/s/' + l.id + '/pay', {
      fields: { platform: 'alipay' },
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assertEqual(r.status, 303, 'PRG：应 303 回分享页');
    assert(/[?&]e=pay-off/.test(String(r.headers.location)),
      `静默 303 必须变成带原因码的 303，实际 Location：${r.headers.location}`);

    const page = await request(srv.port, 'GET', String(r.headers.location).replace(/^https?:\/\/[^/]+/, ''));
    assertEqual(page.status, 200, '落地页应正常渲染');
    assert(page.raw.includes('本次点击没有创建支付订单'),
      '页面必须说清「这次点击没有建单」，而不是只把免费页重画一遍');
    assert(page.raw.includes('免费下载'), '同时要告诉用户现在可以直接下载');
  } finally {
    resetPaymentCfg();
    await srv.close();
  }
});

test('R80-02 · 密码票据失效：点击必须落到密码页并说明，而不是静默回去', async () => {
  const srv = await serve();
  resetPaymentCfg();
  try {
    const l = await makePaidLink('a/pw.txt', { password: 'guest-pass' });
    const r = await postForm(srv.port, '/s/' + l.id + '/pay', {
      fields: { platform: 'alipay' },
      headers: { Accept: 'text/html' },
    });
    assertEqual(r.status, 401, `应直接渲染密码页（401），实际 ${r.status}`);
    assert(r.raw.includes('请重新输入访问密码'), '页面必须说明为什么这次支付没发起');
    assert(r.raw.includes('name="password"'), '密码页必须仍然给出输入框（否则用户无处可去）');
  } finally {
    await srv.close();
  }
});

test('R80-03 · 已支付再点：必须带回 e=paid，并说明没有新建订单', async () => {
  const srv = await serve();
  resetPaymentCfg();
  try {
    const l = await makePaidLink('a/paid.txt');
    const order = makeOrder(l);
    paymentOrders.markPaid(order.id);
    const cookie = payCookie(l, order);

    const r = await postForm(srv.port, '/s/' + l.id + '/pay', {
      fields: { platform: 'alipay' },
      headers: { Accept: 'text/html', cookie },
    });
    assertEqual(r.status, 303, 'PRG：应 303 回分享页');
    assert(/[?&]e=paid/.test(String(r.headers.location)),
      `已支付分支必须带回原因码，实际 Location：${r.headers.location}`);

    const page = await request(srv.port, 'GET', String(r.headers.location).replace(/^https?:\/\/[^/]+/, ''), { headers: { cookie } });
    assert(page.raw.includes('本次点击没有新建订单'), '页面必须说明这次点击没有产生新订单');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * C. 跨站校验：浏览器拿页面，fetch 拿 JSON
 * ================================================================== */

test('R80-04 · 跨站拒绝的呈现形态要跟着调用方走（表单不得收到裸 JSON）', async () => {
  const srv = await serve();
  try {
    const asForm = await postForm(srv.port, '/s/whatever/pay', {
      headers: { Origin: 'https://evil.example', Accept: 'text/html,application/xhtml+xml' },
    });
    assertEqual(asForm.status, 403, '跨站请求仍必须被拒（安全等级不下降）');
    assert(/text\/html/.test(String(asForm.headers['content-type'])),
      `表单导航必须拿到页面，实际 Content-Type：${asForm.headers['content-type']}`);
    assert(asForm.raw.includes('请求来源不受信任'), '页面要给出可读的拒绝原因');

    // fetch / XHR 仍然要能读到机器可解析的错误
    const asFetch = await postForm(srv.port, '/s/whatever/pay', {
      headers: { Origin: 'https://evil.example', Accept: 'application/json' },
    });
    assertEqual(asFetch.status, 403, '同上：仍必须被拒');
    assert(/application\/json/.test(String(asFetch.headers['content-type'])),
      '脚本调用方仍应拿到 JSON（前端要靠 error 字段提示）');
    assert(/请求来源校验失败/.test(asFetch.raw), 'JSON 里要有 error 文案');
  } finally {
    await srv.close();
  }
});

/* ================================================================== *
 * D/E. 支付宝下单：错的签名算法与带 # 的网关地址都不能"看起来成功"
 * ================================================================== */

test('R80-05 · sign_type=SM2 必须在本地就失败，而不是跳过去让支付宝报 ILLEGAL_SIGN', async () => {
  const charge = await paymentGateway.createCharge('alipay', {
    appId: '2021000000000000', privateKey: PKCS8_PEM, signType: 'SM2',
    gateway: 'https://openapi.alipay.com/gateway.do',
  }, {
    order: { id: 'o-r80-05', amountFen: 500 },
    subject: '测试文件',
    returnUrl: 'https://example.com/s/x/pay/return',
    notifyUrl: 'https://example.com/pay/notify/alipay',
  });
  assertEqual(charge.ok, false, 'SM2 必须 fail-closed —— 本地只有 RSA 签名实现，产出的一定是废票');
  assert(/SM2/.test(String(charge.error)), `错误信息要点名是 SM2，实际：${charge.error}`);
  assert(/RSA2/.test(String(charge.error)), `错误信息要给出可照做的出路（改 RSA2），实际：${charge.error}`);

  // 反面：RSA2 / RSA 仍必须正常产出收银台
  for (const st of ['RSA2', 'RSA']) {
    const ok = await paymentGateway.createCharge('alipay', {
      appId: '2021000000000000', privateKey: PKCS8_PEM, signType: st,
      gateway: 'https://openapi.alipay.com/gateway.do',
    }, {
      order: { id: 'o-r80-05-' + st, amountFen: 500 },
      subject: 'x', returnUrl: 'https://example.com/r', notifyUrl: 'https://example.com/n',
    });
    assertEqual(ok.ok, true, `${st} 应能正常下单`);
  }
});

test('R80-06 · 网关地址带 # 时，签名参数不得落进片段', async () => {
  const charge = await paymentGateway.createCharge('alipay', {
    appId: '2021000000000000', privateKey: PKCS8_PEM, signType: 'RSA2',
    // 用户从文档里连锚点一起粘过来，或输入框里留了个 #
    gateway: 'https://openapi.alipay.com/gateway.do#',
  }, {
    order: { id: 'o-r80-06', amountFen: 500 },
    subject: '测试文件',
    returnUrl: 'https://example.com/s/x/pay/return',
    notifyUrl: 'https://example.com/pay/notify/alipay',
  });
  assertEqual(charge.ok, true, '下单应成功');
  const u = new URL(charge.url);
  assertEqual(u.hash, '', `网关地址里的 # 必须被剥掉，实际 hash：${u.hash.slice(0, 60)}`);
  assertEqual(u.searchParams.get('app_id'), '2021000000000000',
    'app_id 必须落在查询串里（落在片段里浏览器根本不会发给网关）');
  assert(u.searchParams.get('sign'), 'sign 必须在查询串里');
  assert(u.searchParams.get('biz_content'), 'biz_content 必须在查询串里');
});

/* ================================================================== *
 * F. createCharge 说成功却没给收银台 ⇒ 必须报错，而不是进「等待支付」
 * ================================================================== */

test('R80-07 · 渠道返回了「成功」但没有收银台地址：必须当场报错，不得进等待页', async () => {
  const srv = await serve();
  resetPaymentCfg();
  const orig = paymentGateway.createCharge;
  try {
    // 模拟网关实现回归：ok=true，但既无 url 也无二维码
    paymentGateway.createCharge = async () => ({ ok: true, kind: 'redirect', url: '' });

    const l = await makePaidLink('a/empty-gate.txt');
    const r = await postForm(srv.port, '/s/' + l.id + '/pay', {
      fields: { platform: 'alipay' },
      headers: { Accept: 'text/html' },
    });
    assertEqual(r.status, 400, `应给出错误页（400），实际 ${r.status}`);
    assert(/没有返回可用的收银台地址/.test(r.raw), '页面必须说清"渠道没给收银台"这件事');
    assert(!r.raw.includes('我已完成支付，立即查询'), '绝不能落到等待支付页（那里永远查不到东西）');
  } finally {
    paymentGateway.createCharge = orig;
    await srv.close();
  }
});

/* ================================================================== *
 * B. 付费页的提交反馈：真实 HTTP 渲染 + 脚本真跑
 * ================================================================== */

test('R80-08 · 付费页必须带提交反馈的挂点（表单标记 / 提示位 / 同源脚本）', async () => {
  const srv = await serve();
  resetPaymentCfg();
  try {
    const l = await makePaidLink('a/page.txt');
    const page = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(page.status, 200, '付费页应正常渲染');
    assert(page.raw.includes('立即支付'), '前提：付费页上确实有「立即支付」按钮');
    assert(/<form method="POST" action="\/s\/[^"]+\/pay" data-pay-submit="1">/.test(page.raw),
      '支付表单必须带 data-pay-submit 标记（脚本靠它认人）');
    assert(page.raw.includes('id="pay-submit-note"'), '必须有提交提示位，否则脚本无处写字');
    assert(page.raw.includes('/js/pay-poll.js'), '提交反馈必须来自**同源脚本**（分享页 CSP 禁内联）');
  } finally {
    await srv.close();
  }
});

/**
 * 在假 DOM 里**真跑**一遍 `public/js/pay-poll.js`。
 *
 * 为什么不用源码文本断言：`includes('没有收到服务器的响应')` 这种判据只证明"文件里有这句话"，
 * 证明不了"提交时它会显示出来"。这里喂一个最小 DOM + 可控 `setTimeout`，直接观察 DOM 变化。
 */
function runPayPoll(opts) {
  const o = opts || {};
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pay-poll.js'), 'utf8');

  const listeners = {};
  const note = { textContent: '', className: '', hidden: true };
  const btn = { textContent: '立即支付', disabled: false };
  const form = {
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector() { return btn; },
  };
  const doc = {
    currentScript: { getAttribute: () => 'link-abc' },
    hidden: false,
    getElementById(id) {
      if (id === 'pay-submit-note') return note;
      if (id === 'pay-state') return o.stateBox || null;
      return null;
    },
    querySelector(sel) { return sel === 'form[data-pay-submit]' ? form : null; },
    addEventListener() {},
  };
  const timers = [];
  const intervals = [];
  const ctx = {
    document: doc,
    window: { addEventListener() {} },
    location: { pathname: '/s/link-abc', reload() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    encodeURIComponent,
    decodeURIComponent,
  };
  vm.runInNewContext(src, ctx, { filename: 'pay-poll.js' });
  return { listeners, note, btn, form, timers, intervals };
}

test('R80-09 · 提交瞬间必须让"点到了"可见，并在 12 秒无响应时给出可照做的提示', async () => {
  const box = runPayPoll();
  assert(typeof box.listeners.submit === 'function',
    '脚本必须给 form[data-pay-submit] 挂上 submit 监听（否则点击仍然毫无反馈）');

  // ① 提交瞬间：按钮禁用 + 文案改变 + 提示位出现
  box.listeners.submit({ preventDefault() {} });
  assertEqual(box.btn.disabled, true, '提交后按钮必须立即禁用（防连点重复下单）');
  assert(/正在创建支付订单/.test(box.btn.textContent), `按钮文案要变，实际：${box.btn.textContent}`);
  assertEqual(box.note.hidden, false, '必须立刻显示提示位（这就是"点到了"的可见证据）');
  assert(/正在向支付渠道创建订单/.test(box.note.textContent), '提示要说清正在做什么');

  // ② 走完 12 秒计时器（页面还没跳走 ⇒ 这次提交没拿到响应）
  const t = box.timers[box.timers.length - 1];
  assertEqual(t.ms, 12000, '兜底计时器应为 12 秒（微信/PayPal 下单最长 10 秒）');
  t.fn();
  assertEqual(box.btn.disabled, false, '超时后按钮必须恢复可点（否则用户彻底无法重试）');
  assert(/没有收到服务器的响应/.test(box.note.textContent),
    `超时必须如实说明"没拿到响应"，实际：${box.note.textContent}`);
  assert(/插件|内嵌窗口/.test(box.note.textContent),
    '提示要列出最可能的成因（拦截 / 受限内嵌窗口），否则用户只能猜');

  // ③ 第二次点击必须被吞掉（不能产生第二笔订单）
  let prevented = false;
  box.btn.disabled = true;
  box.listeners.submit({ preventDefault() { prevented = true; } });
  assertEqual(prevented, true, '按钮已禁用时的重复提交必须被拦下');
});

test('R80-10 · 付费页没有支付状态元素：脚本不得开始轮询', async () => {
  const box = runPayPoll({ stateBox: null });
  assertEqual(box.intervals.length, 0,
    '付费页（渠道选择页）此时还**没有订单**，不该每 3 秒去打一次 /pay/status');

  // 反面：等待页有 #pay-state ⇒ 必须开轮询
  const wait = runPayPoll({ stateBox: { textContent: '支付中…' } });
  assert(wait.intervals.length > 0, '等待支付页必须继续轮询（R8-07 的既有能力不能丢）');
});

/* ================================================================== *
 * 正向守卫：改了三条拒绝分支与下单前置校验之后，正常路径必须仍然通
 * ================================================================== */

test('R80-11 · 凭证齐全时，点「立即支付」仍必须真的跳到支付宝收银台', async () => {
  const srv = await serve();
  resetPaymentCfg();
  try {
    const l = await makePaidLink('a/happy.txt');
    // 先确认页面上真的有按钮（否则下面的 POST 没有现实对应物）
    const page = await request(srv.port, 'GET', '/s/' + l.id);
    assert(page.raw.includes('立即支付'), '前提：付费页上必须有「立即支付」按钮');

    const r = await postForm(srv.port, '/s/' + l.id + '/pay', {
      fields: { platform: 'alipay' },
      headers: { Accept: 'text/html' },
    });
    assertEqual(r.status, 302, `正常路径必须 302 跳收银台，实际 ${r.status}`);
    const loc = String(r.headers.location);
    assert(/^https:\/\/openapi\.alipay\.com\/gateway\.do\?/.test(loc),
      `必须跳到支付宝网关，实际：${loc.slice(0, 120)}`);
    const u = new URL(loc);
    assertEqual(u.searchParams.get('sign_type'), 'RSA2', '签名算法应落在查询串里');
    assert(u.searchParams.get('sign'), '必须带签名（否则收银台必然拒绝）');
    assertEqual(u.searchParams.get('app_id'), '2021000000000000', 'app_id 必须正确透传');
  } finally {
    resetPaymentCfg();
    await srv.close();
  }
});
