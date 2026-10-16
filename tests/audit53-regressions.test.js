/**
 * 第 53 轮护栏 —— 「发信设置」卡片（SMTP）
 *
 * 需求原文：
 *  > 在“用户管理”和“线程并发”之间添加“发信设置”卡片，允许用户设置 SMTP。
 *  > 尽量不要新增任何依赖项。
 *
 * 两句话拆成四条可钉的性质：
 *
 *  ① **位置**：卡片在 DOM 里必须落在 `#sysset-user-card` 之后、`#sysset-concurrency-card` 之前；
 *  ② **可设置**：读取 / 保存 / 测试三条接口齐全，且**保存是 PATCH 语义**（缺省字段保持原值）；
 *  ③ **保密**：口令明文**永不出服务端**（任何视图里都只有 `hasPassword` 布尔值）;
 *  ④ **零依赖**：`package.json` 的 dependencies 不许变，发信只能用 `node:` 内置模块。
 *
 * ## 断言分五层，缺一层就留一种假绿
 *
 *  ① **纯函数层**（真实 `server/limits.js`）：端口归一化与入参判据；
 *  ② **信头注入层**（同上）：地址 / 文本一律拒绝 CR / LF —— 这一条是**安全属性**，
 *     因为 SMTP 是行式协议，我们手工拼命令与信头，一个换行就是一次注入；
 *  ③ **配置层**（真实 `server/config-store.js`）：口令三态、落盘归一、加密方式跟随端口；
 *  ④ **协议行为层**（真实 `server/smtp.js` + 进程内假 SMTP 服务器）：真的连上去、
 *     真的按 EHLO → MAIL → RCPT → DATA → `.` → QUIT 走完一遍，并断言
 *     「未加密的连接绝不发送口令」；
 *  ⑤ **接线层**（路由台账 + 前端卡片登记）：权限与可见性。
 *
 * ## ⑨ 取用层（R55 追加，见文件末尾）
 *
 * 原文只有「发信设置」这一张卡，④ 层跑的却始终是**管理员手点的测试邮件**
 * （走 `getSmtp()`，含口令）。系统自己发的信（验证码 / 重置密码）走的是另一条
 * 取配置路径 —— `email-code.js` 曾经错拿**对外视图**（口令被裁成 `hasPassword`），
 * 于是「配置全对、测试邮件也收得到，但登录页的验证码一封都收不到」。
 * 故 ⑨ 层把**系统发信**也真跑一遍：落盘口令 → 假服务器要求认证 → 断言它收到
 * 的 `AUTH PLAIN` 载荷就是那份口令；再走一次匿名 HTTP（`/auth/forgot`）。
 *
 * ⚠️ 协议层**必须真跑**：只断言「代码里有 `EHLO` 这几个字母」是证明不了握手
 *    顺序与响应码判定的 —— 而顺序错了在真服务器上一样会卡住。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('node:net');
const tls = require('node:tls');
const test = require('node:test');
const { assert, assertEqual, assertMatch, assertReject, ROOT, makeTempDir, cleanupTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r53-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const readJs = (n) => fs.readFileSync(JS(n), 'utf8');
const readHtml = () => fs.readFileSync(PUBLIC('index.html'), 'utf8');

/* ================================================================== *
 * ① 纯函数层：端口归一化与入参判据
 * ================================================================== */

const limits = require(SERVER('limits.js'));
const { normalizeSmtpPort, parseSmtpPortInput, parseSmtpAddressInput, parseSmtpTextInput } = limits;

test('R53-1 · 端口：非法输入一律回到文档化的默认值 465（不静默取一个怪端口）', () => {
  // 缺失 / 空 / 非数字 / 越界 → 统一回到默认端口，且**不留 NaN / undefined**
  for (const v of [undefined, null, '', 'abc', NaN, 0, -1, 65536, 99999, '12abc']) {
    assertEqual(normalizeSmtpPort(v), 465, `端口 ${String(v)} 应归一化到默认 465`);
  }
  // 合法值：向下取整并保持原样
  assertEqual(normalizeSmtpPort(587), 587);
  assertEqual(normalizeSmtpPort('587'), 587);
  assertEqual(normalizeSmtpPort(25.9), 25);
  assertEqual(normalizeSmtpPort(1), 1);
  assertEqual(normalizeSmtpPort(65535), 65535);
});

test('R53-1 · 端口入参：非法一律 400 报错，而不是被静默改写', () => {
  // 与 parseSpeedLimitInput / parseConcurrencyInput 同一套路数：
  // 「非法值被归一化成另一个合法值」会让用户以为自己设置生效了。
  for (const v of ['abc', -1, 0, 65536, '']) {
    const r = parseSmtpPortInput(v);
    assertEqual(r.ok, false, `端口 ${String(v)} 必须被判为非法`);
    assert(typeof r.error === 'string' && r.error.length > 0, '非法入参必须带提示文案');
  }
  assertEqual(parseSmtpPortInput(587).ok, true);
  assertEqual(parseSmtpPortInput('587').value, 587);
});

/* ================================================================== *
 * ② 信头注入防护（安全属性）
 * ================================================================== */

test('R53-2 · 地址：含 CR / LF 一律拒绝（防 SMTP 命令 / 信头注入）', () => {
  // `MAIL FROM:<…>` 与 `From: …` 都是手工拼进**一行**里的 ——
  // 一个 \r\n 就能追加 RCPT TO、伪造 Bcc、覆盖 Subject。
  for (const bad of ['a@b.com\r\nRCPT TO:<evil@x.com>', 'a@b.com\nBcc: e@x.com', 'a@b.com\r\n', '\r\na@b.com']) {
    const r = parseSmtpAddressInput(bad, '发件人地址');
    assertEqual(r.ok, false, `地址 ${JSON.stringify(bad)} 必须被拒`);
  }
  // 顺便确认「没有 @」「多个 @」也在拒绝之列（非法邮箱不该被放行到服务端）
  assertEqual(parseSmtpAddressInput('plain', '发件人地址').ok, false);
  assertEqual(parseSmtpAddressInput('a@b@c.com', '发件人地址').ok, false);
  // 合法地址原样通过（并 trim）
  const good = parseSmtpAddressInput('  Kepler@example.com  ', '发件人地址');
  assertEqual(good.ok, true);
  assertEqual(good.value, 'Kepler@example.com');
});

test('R53-2 · 文本字段：含 CR / LF 一律拒绝；空值不报错（可留空）', () => {
  for (const bad of ['Kepler\r\nBcc: x@y.com', 'a\nb', 'x\r']) {
    assertEqual(parseSmtpTextInput(bad, 255, '发件人显示名').ok, false, JSON.stringify(bad));
  }
  const empty = parseSmtpTextInput('', 255, '发件人显示名');
  assertEqual(empty.ok, true, '显示名允许留空');
  assertEqual(empty.value, '');
  // 超长同样显式报错（不静默截断 —— 截断会让用户以为整串都存下了）
  assertEqual(parseSmtpTextInput('x'.repeat(256), 255, '发件人显示名').ok, false);
});

/* ================================================================== *
 * ③ 配置层：口令三态 + 落盘归一 + 加密方式跟随端口
 * ================================================================== */

const configStore = require(SERVER('config-store.js'));

/** 断言某对象**不含**明文口令（护栏的核心判据） */
function assertNoSecret(obj, label) {
  assert(!Object.prototype.hasOwnProperty.call(obj, 'password'),
    `${label}：不得包含 password 字段（口令明文永不出服务端）`);
  const json = JSON.stringify(obj);
  assert(!/SECRET-PW/.test(json), `${label}：序列化结果里泄漏了口令字面量`);
}

test('R53-3 · 口令三态：留空=保持不变 / null=清除 / 新值=覆盖', () => {
  const base = { host: 'smtp.example.com', port: 587, secure: false, user: 'u@x.com', from: 'a@b.com' };
  const withPw = configStore.saveSmtp(Object.assign({}, base, { password: 'SECRET-PW' }));
  assertEqual(withPw.password, 'SECRET-PW');

  // 留空 = 不提交 = 保持
  const kept = configStore.saveSmtp({ host: 'other.example.com' });
  assertEqual(kept.password, 'SECRET-PW', '密码框留空必须保持原密码不变');
  assertEqual(kept.host, 'other.example.com');

  // 显式 null = 清除
  const cleared = configStore.saveSmtp({ password: null });
  assertEqual(cleared.password, '', '显式 null 必须清除已保存的密码');

  // 新值 = 覆盖
  const replaced = configStore.saveSmtp({ password: 'NEW-PW' });
  assertEqual(replaced.password, 'NEW-PW');
});

test('R53-3 · 落盘归一：半截对象读回来也永远是完整结构', () => {
  // `save(partial)` 是顶层键替换 —— 若只有读取侧归一，一次带半截 smtp 的写入
  // 就会留下缺 port / secure 的记录，发信时端口变成 undefined 直接抛类型错误。
  configStore.save({ smtp: { host: 'half.example.com' } });
  const s = configStore.getSmtp();
  assertEqual(s.host, 'half.example.com');
  assertEqual(s.port, 465, '缺失端口必须补默认值');
  assertEqual(s.secure, true, '端口 465 ⇒ 隐式 TLS');
  assertEqual(s.enabled, false);
  assertEqual(typeof s.user, 'string');
  assertEqual(typeof s.password, 'string');
});

test('R53-3 · 加密方式缺省跟随端口：465⇒隐式 TLS，587/25⇒STARTTLS', () => {
  /**
   * 走 `configStore.save({ smtp })`（顶层键整体写入，正是前端保存之外的另一条
   * 写路径）而不是 `saveSmtp()`：后者是**严格的 PATCH**（`secure` 缺省 = 保持原值），
   * 单独改端口时不会动加密方式 —— 那是**刻意**的语义，由前端在改端口时
   * 调 `syncSmtpSecure()` 把开关一起切过去（见下一条用例）。
   */
  assertEqual(configStore.save({ smtp: { port: 587 } }).smtp.secure, false);
  assertEqual(configStore.save({ smtp: { port: 25 } }).smtp.secure, false);
  assertEqual(configStore.save({ smtp: { port: 465 } }).smtp.secure, true);
  // 显式给出时不许被端口覆盖
  assertEqual(configStore.save({ smtp: { port: 587, secure: true } }).smtp.secure, true);
});

test('R53-3 · 加密方式缺省跟随端口：仅改端口（PATCH）时保持原值，由前端同步开关', () => {
  configStore.save({ smtp: { host: 'h', port: 465 } });
  // PATCH 语义：不带 secure ⇒ 保留此前的 true（不会偷偷改判）
  assertEqual(configStore.saveSmtp({ port: 587 }).secure, true);
  // 前端的同步函数则负责在改端口时把开关切到该端口的常规组合
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'syssettings.js'), 'utf8');
  assertMatch(js, /function syncSmtpSecure\(\)/, '须存在端口 → 加密方式的同步函数');
  assertMatch(js, /smtpPortEl\.addEventListener\('input', syncSmtpSecure\)/,
    '端口输入框的 input 事件必须接到 syncSmtpSecure');
  assertMatch(js, /Math\.floor\(n\)\s*===\s*465/, '同步规则：465 ⇒ 隐式 TLS，否则 STARTTLS');
});

/* ================================================================== *
 * ④ 安全视图：safeView 的两处返回都必须含 smtp 且不含明文
 * ================================================================== */

test('R53-4 · safeView：两处返回都带 smtp，且两处都不含口令明文', () => {
  configStore.saveSmtp({ host: 'view.example.com', port: 465, user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: 'Kepler' });

  // 正常分支（有配置）
  const admin = configStore.safeView('admin');
  assert(admin.smtp, 'safeView（正常分支）必须下发 smtp 段');
  assertNoSecret(admin.smtp, 'safeView 正常分支');
  assertEqual(admin.smtp.host, 'view.example.com');
  assertEqual(admin.smtp.port, 465);
  assertEqual(admin.smtp.hasPassword, true, '已设置密码时 hasPassword 必须为 true');
  assertEqual(admin.smtp.configured, true, '有主机 + 有发件人 ⇒ configured');
  assertEqual(admin.smtp.fromName, 'Kepler');
  // 整个响应体里也不能出现口令
  assert(!/SECRET-PW/.test(JSON.stringify(admin)), 'safeView 整体序列化结果里不得出现口令');

  const user = configStore.safeView('user');
  assert(user.smtp, 'safeView（普通用户）同样必须带 smtp 段');
  assertNoSecret(user.smtp, 'safeView 普通用户分支');
});

test('R53-4 · smtpView：未配置时给出「关闭 + 默认端口」而不是 undefined', () => {
  const v = configStore.smtpView(null);
  assertEqual(v.enabled, false);
  assertEqual(v.port, 465);
  assertEqual(v.configured, false);
  assertEqual(v.hasPassword, false);
  assertNoSecret(v, 'smtpView(null)');
});

/* ================================================================== *
 * ⑤ 信件构造：编码 / 折行 / 点填充
 * ================================================================== */

const { buildMessage } = require(SERVER('smtp.js'));

test('R53-5 · 信件：非 ASCII 主题与显示名走 RFC 2047 编码字（含折行）', () => {
  const longName = '开普勒网盘'.repeat(12); // 60 个汉字 ⇒ base64 远超 76 字符
  const m = buildMessage({
    from: 'no-reply@example.com', fromName: longName,
    to: 'someone@example.com', subject: '中文测试主题',
    text: '正文第一行\n第二行',
  });
  assert(/^Subject: =\?UTF-8\?B\?/.test(m.split('\r\n').find((l) => l.startsWith('Subject:'))),
    '中文主题必须是 RFC 2047 编码字');
  assert(/^From: =\?UTF-8\?B\?/.test(m.split('\r\n').find((l) => l.startsWith('From:'))),
    '中文显示名必须是编码字');
  // 折行：编码字被切成多行后以「CRLF + 空格」续接
  assert(/\r\n =\?UTF-8\?B\?/.test(m), '超长编码字必须折行（CRLF + 空格）');
  // 编码字里绝不能出现裸的中文（那说明没编码）
  const subjectLine = m.split('\r\n').filter((l) => /^(Subject|From):/.test(l)).join('\r\n');
  assert(!/[^\x00-\x7F]/.test(subjectLine.replace(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g, '')),
    '信头里不得残留裸的非 ASCII 字符');
});

test('R53-5 · 信件：必备信头齐全，正文 base64 且按 76 字符折行', () => {
  const m = buildMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'Hi', text: 'hello' });
  for (const h of ['Date:', 'From:', 'To:', 'Subject:', 'Message-ID:', 'MIME-Version:', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']) {
    assert(m.indexOf(h) >= 0, `缺少信头：${h}`);
  }
  assert(/\r\n\r\n/.test(m), '信头与正文之间必须有空行');
  const body = m.slice(m.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  assertMatch(body, /^[A-Za-z0-9+/=\r\n]+$/, '正文必须是 base64（含折行）');
  for (const line of body.split('\r\n')) {
    assert(line.length <= 76, `base64 行不得超过 76 字符，实际 ${line.length}`);
  }
});

/* ================================================================== *
 * ⑥ 协议行为层：真跑一次 SMTP 会话（进程内假服务器）
 * ================================================================== */

const { sendMail } = require(SERVER('smtp.js'));

/**
 * 起一个最小 SMTP 服务器。
 *
 * 记录收到的**每一行命令**，用例据此断言握手顺序 —— 只断言「源码里写了 EHLO」
 * 是证明不了顺序的，而顺序错了在真服务器上一样会卡住。
 *
 * ## 为什么 AUTH 分支需要 PSK
 *
 * 「未加密的连接绝不发送口令」是本轮的一条硬约束（见 `server/smtp.js`），
 * 于是 AUTH 分支**只有在连接已加密时**才可达 —— 要么走 465 隐式 TLS，
 * 要么走 STARTTLS 升级。两者都需要证书，而项目刻意不引入证书生成依赖。
 *
 * Node 自带 **TLS-PSK**（`ciphers: 'PSK'` + `pskCallback`），无需任何证书即可握手，
 * 故测试里给 `tls.connect` 打一层补丁把 PSK 注入进去 —— `node:tls` 的模块对象是
 * **共享**的，`smtp.js` 顶部 `require` 到的就是同一个对象，天然是一个注入点。
 * 这样**生产代码里不留任何「仅为测试存在」的分支**，而 AUTH 分支仍然被真实跑到。
 *
 * @param {object} o 选项：`ehlo`（null = 不认 EHLO，回 502）/ `auth`（宣告的登录机制）
 *                    / `starttls` / `authFail` / `badRcpt` / `greeting`
 */
/** 测试用预共享密钥 —— 免自建证书即可跑通 STARTTLS（Node 22 原生支持 TLS-PSK） */
const PSK = Buffer.from('kepler-r53-test-psk', 'utf8');

function startMock(o) {
  const opt = Object.assign({ ehlo: ['mock'], auth: null, starttls: false, authFail: false, badRcpt: false, greeting: 220 }, o || {});
  const rec = { lines: [], upgraded: false, authSeen: null };
  const server = net.createServer((sock) => {
    let buf = '';
    let upgrading = false;
    /** AUTH LOGIN 的三次握手进度：'' = 未开始 / 'user' = 等用户名 / 'pass' = 等口令 */
    let loginStage = '';
    /** 当前应当往哪个套接字写（升级前 = 明文，升级后 = TLS） */
    let out = sock;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.write(`${opt.greeting} mock ESMTP\r\n`);

    function respond(line) {
      const up = line.toUpperCase();
      // AUTH LOGIN 是「挑战-应答」：后两行是裸 base64，不是命令，必须按阶段认
      if (loginStage === 'user') {
        rec.authSeen = 'LOGIN';
        rec.authUser = line;
        loginStage = 'pass';
        return '334 UGFzc3dvcmQ6\r\n';
      }
      if (loginStage === 'pass') {
        rec.authPass = line;
        loginStage = '';
        return opt.authFail ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 OK\r\n';
      }
      if (up.startsWith('EHLO')) {
        if (opt.ehlo === null) return '502 Command not implemented\r\n';
        const caps = opt.ehlo.slice();
        // 与真实服务器一致：明文阶段只宣告 STARTTLS，升级后才给出登录方式
        if (opt.starttls && !rec.upgraded) caps.push('STARTTLS');
        if (opt.auth && (!opt.starttls || rec.upgraded)) caps.push(`AUTH ${opt.auth}`);
        return caps.map((c, idx) => (idx === caps.length - 1 ? `250 ${c}` : `250-${c}`)).join('\r\n') + '\r\n';
      }
      if (up.startsWith('HELO')) return '250 mock\r\n';
      if (up.startsWith('STARTTLS')) return '220 Go ahead\r\n'; // 真正的升级时机见 `drain()`
      if (up.startsWith('AUTH PLAIN')) {
        rec.authSeen = 'PLAIN:' + Buffer.from(line.slice(11), 'base64').toString('utf8');
        return opt.authFail ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 OK\r\n';
      }
      if (up.startsWith('AUTH LOGIN')) { loginStage = 'user'; return '334 VXNlcm5hbWU6\r\n'; }
      if (up.startsWith('MAIL FROM')) return '250 OK\r\n';
      if (up.startsWith('RCPT TO')) return opt.badRcpt ? '550 5.1.1 No such user\r\n' : '250 OK\r\n';
      if (up === 'DATA') return '354 End data with <CR><LF>.<CR><LF>\r\n';
      if (up === '.') return '250 2.0.0 Queued\r\n';
      if (up === 'QUIT') return '221 Bye\r\n';
      return '';
    }

    function upgradeTls() {
      const t = new tls.TLSSocket(sock, {
        isServer: true,
        ciphers: 'PSK',
        pskCallback: () => PSK,
      });
      t.on('error', () => {});
      t.setEncoding('utf8');
      t.on('data', (chunk) => { drain(chunk); });
      out = t;
      rec.upgraded = true;
    }

    function drain(chunk) {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        rec.lines.push(line);
        const resp = respond(line);
        if (resp) out.write(resp);
        /**
         * ⭐ 升级必须发生在 220 应答**写回明文连接之后**：先升级的话，
         * 这行应答会被写进 TLS 流（握手尚未开始），客户端永远等不到 "Go ahead"。
         */
        if (line.toUpperCase().startsWith('STARTTLS')) { upgrading = true; upgradeTls(); }
        if (line.toUpperCase() === 'QUIT') {
          setTimeout(() => { try { sock.destroy(); } catch (_) { /* 已销毁 */ } }, 5);
        }
      }
    }

    sock.on('data', (chunk) => {
      // 升级期间到达的是 TLS 握手字节，交给 TLSSocket 处理
      if (!upgrading) drain(chunk);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      rec,
      close: () => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close();
      },
    }));
  });
}

/**
 * 注入 / 还原 PSK 补丁。
 *
 * ⚠️ 必须与 `startMock({ starttls: true })` 成对使用：只有带 `starttls` 的假服务器
 * 才会升级，其余用例不受影响（补丁只是给 `tls.connect` 多加两个选项）。
 */
function withPsk(fn) {
  const tls = require('node:tls');
  const real = tls.connect;
  tls.connect = function patched(arg0, ...rest) {
    const opts = (arg0 && typeof arg0 === 'object')
      ? Object.assign({}, arg0, { ciphers: 'PSK', pskCallback: () => ({ psk: PSK, identity: 'r53' }) })
      : arg0;
    return real.call(tls, opts, ...rest);
  };
  return Promise.resolve(fn()).finally(() => { tls.connect = real; });
}

const BASE = { from: 'noreply@example.com', to: 'someone@example.com' };

test('R53-6 · 协议：握手真的按 EHLO → MAIL → RCPT → DATA → 正文 → QUIT 走完', async () => {
  const s = await startMock({ ehlo: ['mock'] });
  try {
    const r = await sendMail(Object.assign({ host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 3000 }, BASE,
      { subject: '测试', text: '中文正文\n第二行' }));
    assertEqual(r.ok, true);
    assertEqual(r.encrypted, false);

    const cmds = s.rec.lines.map((l) => l.split(' ')[0].toUpperCase());
    assertEqual(cmds[0], 'EHLO', '第一步必须是 EHLO');
    assert(cmds.indexOf('MAIL') > cmds.indexOf('EHLO'), 'MAIL 必须在 EHLO 之后');
    assert(cmds.indexOf('RCPT') > cmds.indexOf('MAIL'), 'RCPT 必须在 MAIL 之后');
    assert(cmds.indexOf('DATA') > cmds.indexOf('RCPT'), 'DATA 必须在 RCPT 之后');
    assertEqual(cmds[cmds.length - 1], 'QUIT', '最后一步必须是 QUIT');
    // envelope 地址带尖括号；DATA 之后紧接着正文，并以单独一行的 `.` 结束
    assert(s.rec.lines.some((l) => l === 'MAIL FROM:<noreply@example.com>'), 'MAIL FROM 必须带尖括号');
    assert(s.rec.lines.some((l) => l === 'RCPT TO:<someone@example.com>'), 'RCPT TO 必须带尖括号');
    assert(s.rec.lines.indexOf('.') === s.rec.lines.length - 2, '正文必须以单独一行的句点结束（其后只剩 QUIT）');
  } finally {
    s.close();
  }
});

test('R53-6 · 协议：server 不认 EHLO 时退回 HELO 而不是直接失败', async () => {
  const s = await startMock({ ehlo: null });
  try {
    const r = await sendMail(Object.assign({ host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 3000 }, BASE));
    assertEqual(r.ok, true);
    const cmds = s.rec.lines.map((l) => l.split(' ')[0].toUpperCase());
    assert(cmds.indexOf('EHLO') >= 0 && cmds.indexOf('HELO') > cmds.indexOf('EHLO'),
      '先 EHLO，被拒后再 HELO');
  } finally {
    s.close();
  }
});

/**
 * ⭐ AUTH 分支的端到端：真的升级到 TLS，再真的把口令按 `PLAIN` 载荷发出去。
 *
 * 只有跑通 STARTTLS 才能到达 AUTH（明文段禁止发口令），故这里通过 PSK 补丁
 * 让真实 `server/smtp.js` 完成升级；断言落在**假服务器实际收到的那一行命令**上。
 */
test('R53-6 · 协议：STARTTLS 升级后重发 EHLO，再按 AUTH PLAIN 提交口令', async () => {
  const s = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    const r = await withPsk(() => sendMail(Object.assign(
      { host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 5000 },
      BASE, { user: 'u@x.com', password: 'SECRET-PW' },
    )));
    assertEqual(r.ok, true);
    assertEqual(r.encrypted, true, '服务器宣告了 STARTTLS ⇒ 必须已加密');
    assertEqual(r.authUsed, 'PLAIN', '同时支持 PLAIN / LOGIN 时优先 PLAIN');
    assertEqual(s.rec.upgraded, true, '必须真的走了一次 TLS 升级');

    const cmds = s.rec.lines.map((l) => l.split(' ')[0].toUpperCase());
    assertEqual(cmds.filter((c) => c === 'EHLO').length, 2,
      '升级前后各一次 EHLO —— 少发第二次就拿不到加密后才宣告的 AUTH');
    assert(cmds.indexOf('STARTTLS') > 0, 'STARTTLS 必须在 EHLO 之后');
    assert(s.rec.authSeen === 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      `AUTH PLAIN 载荷必须是 \\0user\\0password，实际：${s.rec.authSeen}`);
  } finally {
    s.close();
  }
});

test('R53-6 · 协议：只支持 LOGIN 时退回 LOGIN（334 三次握手）', async () => {
  const s = await startMock({ ehlo: ['mock'], auth: 'LOGIN', starttls: true });
  try {
    const r = await withPsk(() => sendMail(Object.assign(
      { host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 5000 },
      BASE, { user: 'u@x.com', password: 'SECRET-PW' },
    )));
    assertEqual(r.ok, true);
    assertEqual(r.authUsed, 'LOGIN');
    // LOGIN 是「挑战-应答」：AUTH LOGIN → 334 → 用户名 → 334 → 口令 → 235
    const iAuth = s.rec.lines.findIndex((l) => l.toUpperCase().startsWith('AUTH'));
    assertEqual(s.rec.lines[iAuth + 1], Buffer.from('u@x.com', 'utf8').toString('base64'),
      '第二次握手必须提交 base64 用户名');
    assertEqual(s.rec.lines[iAuth + 2], Buffer.from('SECRET-PW', 'utf8').toString('base64'),
      '第三次握手必须提交 base64 口令');
  } finally {
    s.close();
  }
});

test('R53-6 · 协议：问候码非 220 / RCPT 被拒时如实报错，且不谎报成功', async () => {
  // 问候码 554（服务不可用）
  const bad = await startMock({ greeting: 554 });
  try {
    await assertReject(() => sendMail(Object.assign({ host: '127.0.0.1', port: bad.port, secure: false, timeoutMs: 3000 }, BASE)),
      '问候码不是 220 必须抛错');
  } finally {
    bad.close();
  }

  // RCPT 被拒（550）
  const rc = await startMock({ ehlo: ['mock'], badRcpt: true });
  try {
    let msg = '';
    try { await sendMail(Object.assign({ host: '127.0.0.1', port: rc.port, secure: false, timeoutMs: 3000 }, BASE)); } catch (e) { msg = String(e.message); }
    assert(/550/.test(msg), `RCPT 被拒必须带上服务端原话（550），实际：${msg}`);
  } finally {
    rc.close();
  }
});

/**
 * ⭐ 这是本轮**最硬**的一条：明文连接绝不发送口令。
 *
 * 判据落在「服务端收到的命令里根本没有 AUTH 那一行」—— 而不是「源码里有一句 if」。
 * 源码里那句 if 就算被删掉，只要口令仍以明文发出，本用例就该红。
 */
test('R53-7 · 保密：未加密的连接绝不发送登录口令', async () => {
  const s = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN' });
  try {
    let msg = '';
    try {
      await sendMail(Object.assign({ host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 3000 },
        BASE, { user: 'u@x.com', password: 'SECRET-PW' }));
    } catch (e) { msg = String(e.message); }
    assert(/STARTTLS/.test(msg), `未加密却要登录 ⇒ 必须明确提示改用 STARTTLS，实际：${msg}`);
    assert(!s.rec.lines.some((l) => l.toUpperCase().startsWith('AUTH')),
      '明文连接上绝不允许发出 AUTH 命令');
    assert(!s.rec.lines.join('\n').includes('SECRET-PW'), '口令绝不能出现在明文连接上');
  } finally {
    s.close();
  }
});

test('R53-7 · 保密：缺口令时提前 400，不让请求带着空口令打过去', async () => {
  const s = await startMock({ ehlo: ['mock'], auth: 'PLAIN' });
  try {
    let msg = '';
    try {
      await sendMail(Object.assign({ host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 3000 },
        BASE, { user: 'u@x.com', password: '' }));
    } catch (e) { msg = String(e.message); }
    assert(/密码|口令/.test(msg), `填了用户名却没密码 ⇒ 必须给出面向管理员的提示，实际：${msg}`);
    assert(!s.rec.lines.some((l) => l.toUpperCase().startsWith('AUTH')), '不得带空口令去登录');
  } finally {
    s.close();
  }
});

test('R53-7 · 保密：缺少主机 / 发件人时提前拒绝（不发起连接）', async () => {
  for (const bad of [{ from: 'a@b.com' }, { host: 'h', from: '' }]) {
    let msg = '';
    try { await sendMail(bad); } catch (e) { msg = String(e.message); }
    assert(msg.length > 0, JSON.stringify(bad) + ' 必须被拒');
    assert(/SMTP|发件人/.test(msg), `提示应指向缺的那一项，实际：${msg}`);
  }
});

test('R53-7 · 信件：DATA 载荷行首的点必须被点填充（否则被当成结束标记截断）', () => {
  const { dotStuff: stuff, buildMessage: build } = require(SERVER('smtp.js'));
  // `buildMessage` 只产出「信头 + 空行 + base64 正文」，DATA 的结束点由 `dotStuff`
  // 之后追加 —— 因此这里直接断言填充函数本身（它是唯一的填充实现点）。
  // RFC 5321 §4.5.2：行首若是句点，就在行首**再补一个**句点（收端去掉一个还原）
  assertEqual(stuff('a\r\n.b\r\n..\r\nc\r\n'), 'a\r\n..b\r\n...\r\nc\r\n',
    '行首的点必须多补一个点（`.b`→`..b`，`..`→`...`）');
  // 与 buildMessage 组合后即为**实际写入套接字**的那一段：必须以 CRLF. CRLF 收尾
  const payload = `${stuff(build({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 'hello' }))}.\r\n`;
  assert(/\r\n\.\r\n$/.test(payload), 'DATA 必须以「CRLF . CRLF」结束');
  assert(payload.indexOf('\r\n\r\n.\r\n') < 0, '正文与结束点之间不得多出空行');
});

/* ================================================================== *
 * ⑦ 接线层：路由台账 / 卡片登记 / 卡片位置
 * ================================================================== */

const express = require(path.join(ROOT, 'node_modules', 'express'));

/** 起一个只挂载 SMTP 子路由的 express 服务；`auth` 为 null = 未登录 */
async function serve(auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.authUser = auth; next(); });
  app.use('/api', require(SERVER('routes', 'smtp.js')));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: s.address().port,
    close: () => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    },
  };
}

const ADMIN = { username: 'admin', role: 'admin' };
const USER = { username: 'u', role: 'user' };

test('R53-8 · 路由：三条接口全部仅管理员（含未登录）', async () => {
  const s = await serve(null);
  try {
    for (const [m, p, body] of [['GET', '/api/smtp/config', null], ['PUT', '/api/smtp/config', {}], ['POST', '/api/smtp/test', {}]]) {
      const r = await request(s.port, m, p, body ? { body } : {});
      assertEqual(r.status, 403, `${m} ${p} 未登录必须 403`);
    }
  } finally {
    s.close();
  }

  const u = await serve(USER);
  try {
    for (const [m, p, body] of [['GET', '/api/smtp/config', null], ['PUT', '/api/smtp/config', {}], ['POST', '/api/smtp/test', {}]]) {
      const r = await request(u.port, m, p, body ? { body } : {});
      assertEqual(r.status, 403, `${m} ${p} 普通用户必须 403`);
    }
  } finally {
    u.close();
  }
});

test('R53-8 · 路由：管理员读 → 只回 hasPassword，绝不回明文', async () => {
  const s = await serve(ADMIN);
  try {
    configStore.saveSmtp({ host: 'r.example.com', port: 587, secure: false, user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com' });
    const r = await request(s.port, 'GET', '/api/smtp/config');
    assertEqual(r.status, 200);
    assertNoSecret(r.json, 'GET /smtp/config');
    assertEqual(r.json.hasPassword, true);
    assertEqual(r.json.host, 'r.example.com');
    assertEqual(r.json.port, 587);
    // 整个响应体（含头）都不许出现口令
    assert(!/SECRET-PW/.test(r.raw), 'GET /smtp/config 响应里绝不允许出现口令');
  } finally {
    s.close();
  }
});

test('R53-8 · 路由：管理员保存 → 落盘且响应里不含口令', async () => {
  const s = await serve(ADMIN);
  try {
    const r = await request(s.port, 'PUT', '/api/smtp/config', {
      body: { host: 'w.example.com', port: 465, secure: true, user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com' },
    });
    assertEqual(r.status, 200);
    assertNoSecret(r.json, 'PUT /smtp/config');
    assertEqual(configStore.getSmtp().password, 'SECRET-PW', '保存后服务端内部必须拿到明文口令（发信要用）');
    // 再读一次：明文仍然不出服务端
    const g = await request(s.port, 'GET', '/api/smtp/config');
    assertNoSecret(g.json, '保存后再读');
  } finally {
    s.close();
  }
});

test('R53-8 · 路由：地址 / 显示名含换行 ⇒ 400（信头注入面）', async () => {
  const s = await serve(ADMIN);
  try {
    const cases = [
      { from: 'a@b.com\r\nBcc: evil@x.com' },
      { user: 'u@x.com\r\nRCPT TO:<evil@x.com>' },
      { fromName: 'Kepler\r\nBcc: evil@x.com' },
    ];
    for (const c of cases) {
      const r = await request(s.port, 'PUT', '/api/smtp/config', { body: c });
      assertEqual(r.status, 400, `含换行的字段必须被拒：${JSON.stringify(c)}`);
    }
  } finally {
    s.close();
  }
});

test('R53-8 · 路由：端口非法 ⇒ 400（不是静默改写成别的值）', async () => {
  const s = await serve(ADMIN);
  try {
    for (const port of [0, -1, 65536, 'abc']) {
      const r = await request(s.port, 'PUT', '/api/smtp/config', { body: { port } });
      assertEqual(r.status, 400, `端口 ${String(port)} 必须 400`);
    }
  } finally {
    s.close();
  }
});

test('R53-8 · 路由：端到端 —— 保存后发测试邮件，真的与 SMTP 服务器完成一次会话', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  const s = await serve(ADMIN);
  try {
    // ① 先保存一份指向假服务器的配置（隐式 TLS 关掉，否则要真证书）
    const saved = await withPsk(() => request(s.port, 'PUT', '/api/smtp/config', {
      body: {
        enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
        user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: 'Kepler',
      },
    }));
    assertEqual(saved.status, 200);
    assertNoSecret(saved.json, '保存响应');

    // ② 发测试邮件（收件人留空 ⇒ 发给发件人自己）
    const t = await withPsk(() => request(s.port, 'POST', '/api/smtp/test', { body: {} }));
    assertEqual(t.status, 200, `测试邮件应发送成功，实际 ${t.status}：${t.raw}`);
    assertEqual(t.json.to, 'a@b.com', '留空 = 发给发件人自己');
    assertEqual(t.json.encrypted, true, '宣告了 STARTTLS ⇒ 必须已加密');
    assertEqual(t.json.authUsed, 'PLAIN');
    // ③ 假服务器确实收到了完整握手
    const cmds = mock.rec.lines.map((l) => l.split(' ')[0].toUpperCase());
    assert(cmds[0] === 'EHLO' && cmds.indexOf('MAIL') > 0 && cmds.indexOf('RCPT') > cmds.indexOf('MAIL')
      && cmds.indexOf('DATA') > cmds.indexOf('RCPT'), `握手顺序不对：${cmds.join(',')}`);
    assert(mock.rec.authSeen === 'PLAIN:\u0000u@x.com\u0000SECRET-PW', `AUTH PLAIN 载荷不对：${mock.rec.authSeen}`);
  } finally {
    s.close();
    mock.close();
  }
});

test('R53-8 · 路由：三条 SMTP 接口都在台账里，且都在 mustBeAdmin 内', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'routes-surface.test.js'), 'utf8');
  for (const r of ['GET /smtp/config', 'PUT /smtp/config', 'POST /smtp/test']) {
    assert(src.indexOf(`'${r}'`) >= 0 || src.indexOf(`"${r}"`) >= 0, `路由台账缺少：${r}`);
  }
  // 三条都必须出现在 mustBeAdmin 段内：截取该数组再做判断
  const i = src.indexOf('const mustBeAdmin = [');
  assert(i >= 0, '台账应存在 mustBeAdmin 清单');
  const block = src.slice(i, src.indexOf('];', i));
  for (const r of ['GET /smtp/config', 'PUT /smtp/config', 'POST /smtp/test']) {
    assert(block.indexOf(r) >= 0, `mustBeAdmin 清单缺少：${r}`);
  }
});

test('R53-8 · 路由：模块已在 routes.js 登记并 requireAdmin + apiHandler', () => {
  const agg = fs.readFileSync(SERVER('routes.js'), 'utf8');
  assertMatch(agg, /require\('\.\/routes\/smtp'\)/, 'routes.js 必须挂载 smtp 子模块');
  assertMatch(agg, /routes\/smtp\.js\s+\S/, 'routes.js 顶部清单应登记 smtp.js');

  const r = fs.readFileSync(SERVER('routes', 'smtp.js'), 'utf8');
  assertMatch(r, /requireAdmin/, 'smtp 路由必须挂 requireAdmin');
  // R23-04 棘轮：新路由的错误落地走 apiHandler，不得复制第 N+1 份两行 catch
  const handlerBodies = r.match(/apiHandler\(/g) || [];
  assertEqual(handlerBodies.length, 3, '三条 handler 都应包在 apiHandler 里');
  assert(!/catch\s*\(\s*e\s*\)\s*\{\s*res\.status\(/.test(r), 'smtp.js 不得再内联错误响应副本');
});

/* ================================================================== *
 * ⑧ 前端：卡片位置与管理员专属登记
 * ================================================================== */

test('R53-9 · 卡片位置：「发信设置」必须夹在「用户管理」与「线程并发」之间', () => {
  const html = readHtml();
  const iUser = html.indexOf('id="sysset-user-card"');
  const iSmtp = html.indexOf('id="sysset-smtp-card"');
  const iConc = html.indexOf('id="sysset-concurrency-card"');
  assert(iUser >= 0 && iSmtp >= 0 && iConc >= 0, '三张卡片都必须存在');
  assert(iUser < iSmtp && iSmtp < iConc,
    `卡片顺序必须是「用户管理 → 发信设置 → 线程并发」，实际下标 ${iUser}/${iSmtp}/${iConc}`);
});

test('R53-9 · 卡片可见性：「发信设置」必须登记进 ADMIN_ONLY_CARDS', () => {
  // 与 R25-08 / R48-04a 同一条规矩：不登记 ⇒ 普通用户看到卡片、点保存却被 403
  const js = readJs('syssettings.js');
  assertMatch(js, /ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-smtp-card'/,
    '「发信设置」必须登记进 ADMIN_ONLY_CARDS —— 否则普通用户也会看到发信配置');
});

test('R53-9 · 表单口令框：placeholder 须写明「留空保持不变」且永不回填', () => {
  const html = readHtml();
  const i = html.indexOf('id="sysset-smtp-card"');
  const j = html.indexOf('id="sysset-concurrency-card"');
  assert(i >= 0 && j > i, '需定位到发信设置卡片区块');
  const block = html.slice(i, j);
  assert(/id="smtp-password"/.test(block), '卡片须有口令输入框');
  assert(/留空.*不变/.test(block), '口令框须提示「留空表示保持现有密码不变」');
  assert(/type="password"/.test(block), '口令输入框必须是 password 类型');
  // 回填实现里，口令框必须被显式置空（不信任任何下发值）
  const js2 = readJs('syssettings.js');
  assertMatch(js2, /set\('smtp-password',\s*''\)/, 'renderSmtp 必须把口令框显式置空');
});

/* ================================================================== *
 * ⑨ 取用层：**系统自己发的信**（验证码 / 重置密码）也必须带上口令
 * ================================================================== */

/**
 * ⑨ 层为什么必要 —— 也就是 R55 修的那个缺陷。
 *
 * ⑥⑦ 两层的「真跑一次会话」跑的全是**管理员手点的测试邮件**，它走
 * `configStore.getSmtp()`（含明文口令），所以一直是绿的。而系统自己发的信
 * （`server/email-code.js` 的 `sendCodeMail()`，验证码 / 重置密码的唯一发信点）
 * 曾经错拿**对外视图** `smtpView()` —— 视图为了保密把口令裁成 `hasPassword`
 * 布尔值，于是 `password` 恒为 `undefined`，`validateForSend()` 判 400
 * 「已填写登录用户名但密码为空」。
 *
 * 症状因此**两极分化**：管理员点「发送测试邮件」成功（同一份落盘配置、另一个读法），
 * 而登录页的「发验证码」一封也发不出去 —— 用户看到的就是「用户名密码都填对了，
 * 却发不了信」。护栏必须落在**系统发信这条路径真的用上了什么口令**上，
 * 只断言「源码里有 `smtpSendConfig` 这个词」是钉不住它的（假绿标本）。
 */
const emailCode = require(SERVER('email-code.js'));

/** 从假服务器收到的命令行里取出 DATA 正文（base64 解码；点填充不影响 base64 串） */
function dataText(rec) {
  const iData = rec.lines.indexOf('DATA');
  if (iData < 0) return '';
  const iBlank = rec.lines.indexOf('', iData); // 信头与正文之间的空行
  const iDot = rec.lines.indexOf('.', iBlank);
  return Buffer.from(rec.lines.slice(iBlank + 1, iDot).join(''), 'base64').toString('utf8');
}

test('R53-10 · 取用：两个入口的差别恰好只差口令（视图没有 password，发信入口有）', () => {
  configStore.saveSmtp({
    enabled: true, host: 'r.example.com', port: 587, secure: false,
    user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
  });
  const view = configStore.smtpView(configStore.load());
  const send = configStore.smtpSendConfig();

  assertEqual(send.password, 'SECRET-PW', '发信入口必须给出明文口令（发信要用）');
  assertEqual(view.hasPassword, true, '视图只回「有没有口令」');
  assertEqual(Object.prototype.hasOwnProperty.call(view, 'password'), false,
    '对外视图不得带 password 字段 —— 它就是「拿视图发信会静默丢口令」的根');

  // 「能不能发」的判据同源：两条路径对同一份配置必须给同一个答案，
  // 否则会出现「路由放行、发信端 503」或反过来的分叉。
  assertEqual(view.configured, send.configured, 'configured 必须是同一句判据');
  /**
   * ⚠️ 两组补丁都**写全两个字段**：只写一个的话第二轮会继承上一轮清掉的那个字段，
   * 于是「缺主机」与「缺发件人」在第二轮塌成同一种输入，「判据分叉」就打不出来
   * （实测如此 —— `R53-10c` 第一次跑出来是 `fail=0` 的假绿）。
   */
  for (const patch of [{ host: '', from: 'a@b.com' }, { host: 'r.example.com', from: '' }]) {
    configStore.saveSmtp(patch);
    const send2 = configStore.smtpSendConfig();
    const view2 = configStore.smtpView(configStore.load());
    assertEqual(send2.configured, false, `缺 ${Object.keys(patch)[0]} 时不应判定为「可发信」`);
    assertEqual(view2.configured, send2.configured, '缺字段后视图与发信入口仍须一致');
  }
});

test('R53-10 · 取用：验证码发信真的用上了落盘的口令，且验证码进了信封', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    /**
     * ⚠️ 直接调 `sendCodeMail()`（系统发信的唯一实现点），**不**先签发验证码 ——
     * 这样断言就不依赖 `issue()` 的冷却与随机数，失败原因只剩「发信这一层」。
     */
    await withPsk(() => emailCode.sendCodeMail({
      purpose: 'reset', email: 'someone@example.com', username: 'alice', code: '246813',
    }));

    assertEqual(mock.rec.authSeen, 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      '系统发信必须带上落盘的口令 —— 用对外视图取配置时它恒为空（本轮修复的缺陷）');
    assert(mock.rec.lines.some((l) => l === 'MAIL FROM:<a@b.com>'), '发件人必须是配置里的发件人');
    assert(mock.rec.lines.some((l) => l === 'RCPT TO:<someone@example.com>'), '收件人必须是目标邮箱');
    const text = dataText(mock.rec);
    assert(text.indexOf('246813') >= 0, `信里必须真的带上验证码，实际正文：${text.slice(0, 200)}`);
    assert(text.indexOf('重置密码') >= 0, '正文必须说明用途（重置密码）');
  } finally {
    mock.close();
  }
});

test('R53-10 · 取用：未配置（缺主机或发件人）时明确 503，不静默不发也不硬连', async () => {
  for (const patch of [{ host: '', from: 'a@b.com' }, { host: 'smtp.example.com', from: '' }]) {
    configStore.saveSmtp(patch);
    let err = null;
    try {
      await emailCode.sendCodeMail({ purpose: 'reset', email: 'a@b.com', username: 'x', code: '111111' });
    } catch (e) { err = e; }
    assert(err, `缺字段时应直接抛错（patch=${JSON.stringify(patch)}）`);
    assertEqual(err.status, 503, '应为 503（配置类问题），而不是网络超时');
    assertMatch(err.message, /尚未配置发信/, '提示须写明「尚未配置发信」');
  }
});

test('R53-10 · 取用：真 HTTP —— 匿名「忘记密码」触发的发信也带上了口令', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  configStore.saveSmtp({
    enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
    user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
  });
  // `addUser` 走 scrypt ⇒ 是 async 的；不 await 的话用户还没落库，`/auth/forgot` 会恒真地什么都不发
  await configStore.addUser({ username: 'r53-forgot', password: 'Unit!2026abc', role: 'user', email: 'target@example.com' });

  // 与 ⑦ 层同款：只挂 auth 子路由的最小 express 服务（`/auth/forgot` 匿名可达）
  const app = express();
  app.use(express.json());
  app.use('/api', require(SERVER('routes', 'auth.js')));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await withPsk(() => request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.55.1.1' },
      body: { identifier: 'r53-forgot' },
    }));
    assertEqual(r.status, 200, `匿名找回应当 200（响应恒真），实际 ${r.status}：${r.raw}`);
    assert(mock.rec.lines.some((l) => l === 'RCPT TO:<target@example.com>'),
      '收件人必须是那个账号绑定的邮箱');
    assertEqual(mock.rec.authSeen, 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      '路由 → email-code → smtp 整条链路上，口令必须一路都在');
    const text = dataText(mock.rec);
    assert(/验证码：\d{6}/.test(text), `信里必须是服务端签发的 6 位验证码，实际正文：${text.slice(0, 200)}`);
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    mock.close();
  }
});
