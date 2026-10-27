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
 * ## ⑩ 启用开关层（R55 追加，见文件末尾）
 *
 * 卡片上那颗「启用 / 停用发信功能」开关**原先只落盘**、不拦任何服务端行为 ——
 * 停用之后系统发的验证码照样发得出去。口径（经确认）：停用 = **系统自动发信
 * （验证码 / 重置密码）一律不发**，而管理员手点的「发送测试邮件」**不受限制**
 * （R53 已定，见 ⑦ 层）。闸门落在 `email-code.js` 的发信点上，**不折进**
 * `smtpConfigured()` —— 后者回答的是「配没配」，不是「开没开」。
 *
 * ⚠️ 协议层**必须真跑**：只断言「代码里有 `EHLO` 这几个字母」是证明不了握手
 *    顺序与响应码判定的 —— 而顺序错了在真服务器上一样会卡住。
 *
 * ## ⑪ 站点级探针层（R57 追加，见文件末尾）
 *
 * 「配置全对却收不到信」的根因是**失败被刻意静默**（`/auth/forgot` 恒真是防枚举的
 * 必要设计）。修法不是把它改成如实报错（那会开出一条账户存在性 oracle），而是把失败中
 * **与标识无关的那一部分**提前探出来：连不上 / STARTTLS 未宣告 / 认证被拒 / 口令缺失。
 * ④ 层钉「管理员手点的测试邮件」，⑩ 层钉「系统自动发信是否被开关拦住」，
 * ⑪ 层钉的是**站点级健康探针**本身及其在 `/auth/forgot` 里的**执行位置**。
 *
 * ## ⑫ 建连截止层（R57 追加，见文件末尾）
 *
 * 同一份工单的另外两个症状 —— 「失败（建连）：AggregateError」与「永远停在
 * 正在连接 / 发送中」—— 其实是**同一个缺口**：建连阶段（DNS → TCP → TLS）没有
 * 任何失败出口。两条护栏分别守住「有硬截止」「错误带得出逐地址原因 + 可执行提示」，
 * 再加一条正向对照，证明截止逻辑不误伤正常连接（否则「一律立刻拒绝」也能全绿）。
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
 * ④ 安全视图：safeView 的 smtp 段**只给管理员**，且任何分支都不含口令明文
 * ================================================================== */

test('R53-4 · safeView：smtp 段只下发给管理员，且任何分支都不含口令明文', () => {
  configStore.saveSmtp({ host: 'view.example.com', port: 465, user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: 'Kepler' });

  // 正常分支（有配置）
  const admin = configStore.safeView('admin');
  assert(admin.smtp, 'safeView（管理员）必须下发 smtp 段 —— 发信设置卡片要用');
  assertNoSecret(admin.smtp, 'safeView 正常分支');
  assertEqual(admin.smtp.host, 'view.example.com');
  assertEqual(admin.smtp.port, 465);
  assertEqual(admin.smtp.hasPassword, true, '已设置密码时 hasPassword 必须为 true');
  assertEqual(admin.smtp.configured, true, '有主机 + 有发件人 ⇒ configured');
  assertEqual(admin.smtp.fromName, 'Kepler');
  // 整个响应体里也不能出现口令
  assert(!/SECRET-PW/.test(JSON.stringify(admin)), 'safeView 整体序列化结果里不得出现口令');

  /**
   * ⚠️ R94（审核 M03-03）**改了这条判据的方向**：本用例原先断言「普通用户同样必须带
   * smtp 段」，那正是缺陷本身 —— `GET /api/config` 只要求「有会话」，于是任意已登录
   * 用户都能读到 SMTP 主机 / 端口 / 加密方式 / 登录用户名 / 发件人地址（基础设施拓扑）。
   * 设置页走的是独立的 `/api/smtp/config`（`requireAdmin`），前端 `public/js/` 从不读
   * `config.smtp`，所以裁掉不会影响任何界面。
   */
  const user = configStore.safeView('user');
  assertEqual(user.smtp, null, '普通用户不得拿到 smtp 段（发信拓扑只给管理员）');
  assert(!/SECRET-PW/.test(JSON.stringify(user)), 'safeView 整体序列化结果里不得出现口令');
  assert(!/view\.example\.com/.test(JSON.stringify(user)), '普通用户的响应体里不得出现 SMTP 主机名');
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
    /**
     * ⭐ 「本连接是否已升级」必须**按连接**记，不能共用 `rec.upgraded`。
     *
     * 「明文阶段只宣告 STARTTLS、升级后才给出 AUTH」是**每条连接各自**的事；
     * 而 `rec.upgraded` 是整台假服务器的观察位（跨连接累积，见文件末尾的断言）。
     * 两者共用会造出一种极隐蔽的假红：R57 起 `/auth/forgot` 先跑一次健康探针
     * （第一条连接）、随后真发信才是第二条连接 —— 第二条一上来就看到
     * `rec.upgraded === true`，于是**既不宣告 STARTTLS 又不给出 AUTH**，
     * 客户端按「未加密的连接绝不发送口令」拒绝，真发信被路由静默吞掉，
     * 用例报「没收到 RCPT TO」。真实服务器不会这样。
     */
    let upgradedConn = false;
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
        if (opt.starttls && !upgradedConn) caps.push('STARTTLS');
        if (opt.auth && (!opt.starttls || upgradedConn)) caps.push(`AUTH ${opt.auth}`);
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
      upgradedConn = true;
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

/* ================================================================== *
 * ⑩ 启用开关层：`smtp.enabled` 必须真的拦住**系统自动发信**
 * ================================================================== */

/**
 * ⑩ 层为什么必要：卡片上那颗「启用 / 停用发信功能」开关**原先只落盘**、
 * 不拦任何服务端行为 —— 停用之后系统发的验证码照样发得出去。
 *
 * 口径（经确认）：**停用 = 系统自动发信（验证码 / 重置密码）一律不发**；
 * 管理员手点的「发送测试邮件」**不受限制**（R53 已定，见 ⑦ 层）—— 若一并停掉，
 * 就关掉了「先配好、再验证」的窗口。
 *
 * ⚠️ 闸门刻意**不折进** `smtpConfigured()`：那个判据还管着「界面显示已配置 /
 * 未配置」与测试邮件的准入；折进去会让卡片在停用后显示成「未配置」（配置其实还在），
 * 并顺手把测试邮件一起停掉。故本层第一件要钉的就是**「停用 ≠ 未配置」**。
 *
 * ⚠️ 判据必须落在「假服务器到底收到几行命令」上：只断言 `sendCodeMail` 抛了错，
 * 是钉不住「有没有偷偷发出去」的。
 */

test('R53-11 · 开关：停用后**系统发信**直接 503，且一个字节都不发出去', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    configStore.saveSmtp({
      enabled: false, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    // 「停用」不等于「未配置」：卡片与路由的闸门都仍应认为配置是完整的
    assertEqual(configStore.smtpSendConfig().configured, true,
      '停用只是「不发」，配置本身还在 —— configured 不得因此变成 false');
    assertEqual(configStore.smtpView(configStore.load()).configured, true,
      '对外视图同理：configured 回答的是「配没配」，不是「开没开」');

    let err = null;
    try {
      await emailCode.sendCodeMail({ purpose: 'reset', email: 'a@b.com', username: 'x', code: '111111' });
    } catch (e) { err = e; }
    assert(err, '停用后系统发信必须直接抛错，而不是照发出去');
    assertEqual(err.status, 503, '应为 503（配置类问题），而不是网络超时');
    assertMatch(err.message, /停用/, '提示必须写明「已停用」，不能与「尚未配置」混为一谈');
    assertEqual(mock.rec.lines.length, 0,
      `停用后连一次连接都不该发起，实际收到 ${mock.rec.lines.length} 行：${JSON.stringify(mock.rec.lines.slice(0, 4))}`);
  } finally {
    mock.close();
  }
});

test('R53-11 · 开关：同一份配置只要启用就照常发信（正向对照）', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    await withPsk(() => emailCode.sendCodeMail({
      purpose: 'reset', email: 'someone@example.com', username: 'alice', code: '246813',
    }));
    assertEqual(mock.rec.authSeen, 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      '启用时必须照常发信 —— 缺了这条，「一律拒绝」也能让上一条全绿');
  } finally {
    mock.close();
  }
});

test('R53-11 · 开关：停用不影响管理员手点的「发送测试邮件」（R53 既有口径）', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  const s = await serve(ADMIN);
  try {
    configStore.saveSmtp({
      enabled: false, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    const t = await withPsk(() => request(s.port, 'POST', '/api/smtp/test', { body: {} }));
    assertEqual(t.status, 200, `测试邮件不受开关限制，应 200，实际 ${t.status}：${t.raw}`);
    assertEqual(mock.rec.authSeen, 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      '测试邮件仍须真的与服务器完成一次会话（否则「不受限制」只是纸面口径）');
  } finally {
    s.close();
    mock.close();
  }
});

/**
 * ⚠️ R57 改写：本条原先是「停用时匿名『忘记密码』**仍恒真 200**，且一封都不发」。
 *
 * 那条口径把**站点级状态**与**标识级差异**混为一谈了。「停用」对任何标识都是同一个
 * 答案（问谁都回「系统发信已停用」），如实回**不会**泄露出「这个用户名是否存在」；
 * 而 200 的代价是用户收到一句「验证码已发送」然后永远等不到信 —— 实测工单两条，
 * 都表现为「SMTP 配置全对，就是收不到邮件」。
 *
 * 因此本条改测**真正该守的性质**：站点级失败可以如实回，但**任意标识拿到的响应
 * 必须逐字节相同**（那才是防枚举的判据），且停用后连一次连接都不该发起。
 */
test('R53-11 · 开关：停用后匿名「忘记密码」如实 503，且**对任意标识逐字节相同**（不泄露账户是否存在）', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  await configStore.addUser({
    username: 'r53-disabled', password: 'Unit!2026abc', role: 'user', email: 'target2@example.com',
  });
  configStore.saveSmtp({
    enabled: false, host: '127.0.0.1', port: mock.port, secure: false,
    user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
  });
  const app = express();
  app.use(express.json());
  app.use('/api', require(SERVER('routes', 'auth.js')));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    // 三个不同的 IP（限流是按 IP 的）分别覆盖「命中真实账户 / 完全不存在的标识 / 空标识」
    const hit = await request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.55.2.1' }, body: { identifier: 'r53-disabled' },
    });
    const miss = await request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.55.2.2' }, body: { identifier: 'r53-no-such-user' },
    });
    const empty = await request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.55.2.3' }, body: { identifier: '' },
    });
    assertEqual(hit.status, 503,
      `「停用」是站点级状态，应如实告知（与标识是否命中无关），实际 ${hit.status}：${hit.raw}`);
    assertMatch(hit.json.error, /停用/, '提示必须写明「已停用」，不能与「尚未配置」混为一谈');
    assertEqual(hit.raw, miss.raw, '命中与未命中的响应体必须逐字节相同 —— 否则就是一条账户存在性 oracle');
    assertEqual(hit.raw, empty.raw, '空标识同理：站点级状态不随标识而变');
    assertEqual(mock.rec.lines.length, 0,
      '停用后不得有任何发信连接 —— 闸门必须先于探针（否则探针会替"停用"先连一次）');
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    mock.close();
  }
});

test('R53-11 · 开关：停用时需登录的「发送邮箱验证码」如实回 503（与 /auth/forgot 刻意不同）', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  await configStore.addUser({
    username: 'r53-mailcode', password: 'Unit!2026abc', role: 'user', email: 'old@example.com',
  });
  const me = configStore.listUsers().find((u) => u.username === 'r53-mailcode');
  assert(me && me.id, '前置：新建用户必须能查到 id（鉴权中间件只注入 id / username / role / permissions）');
  configStore.saveSmtp({
    enabled: false, host: '127.0.0.1', port: mock.port, secure: false,
    user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = me; next(); });
  app.use('/api', require(SERVER('routes', 'auth.js')));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await request(srv.address().port, 'POST', '/api/auth/email/code', {
      headers: { 'X-Forwarded-For': '10.55.3.1' }, body: { email: 'brand-new@example.com' },
    });
    assertEqual(r.status, 503,
      `需登录的接口应如实告知「发信已停用」（用户提交的是自己的新地址，不存在 oracle 顾虑），实际 ${r.status}：${r.raw}`);
    assertMatch(JSON.stringify(r.json), /停用/, '错误里必须写清是「已停用」而不是「未配置」');
    assertEqual(mock.rec.lines.length, 0, '停用后不得发起任何发信连接');
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    mock.close();
  }
});

/* ================================================================== *
 * ⑪ R57 站点级健康探针：把「配置全对却发不出去」从静默失败变成可执行的提示
 * ================================================================== */

/**
 * ⑪ 层为什么必要（两份真实工单）
 *
 *  工单一：系统邮件走的是「对外视图」取配置 ⇒ 口令被裁成 `hasPassword` ⇒ 一封也发不出去，
 *         而管理员手点的测试邮件走内部读、照样成功（R55 的 `R53-10a` 已钉）。
 *  工单二：启用开关没打开 —— 测试邮件**不受**开关限制，照样成功；系统邮件全部静默丢掉，
 *         用户看到的只有一句「验证码已发送」。
 *
 * 两次的表象都是「用户名 / 密码 / 服务器 / 端口全对，就是收不到邮件」。
 * 根因不在某一处配置，而在**失败被刻意静默**（`/auth/forgot` 恒真是防枚举的必要设计）。
 * 修法不是把它改成如实报错（那会开出一条账户存在性 oracle），而是把失败里
 * **与标识无关的那一部分**提前探出来：连不上 / STARTTLS 未宣告 / 认证被拒 / 口令缺失。
 */
test('R57-01 · 探针：真的连了一次 SMTP 服务器并完成登录，且**不投递**任何邮件', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    const r = await withPsk(() => emailCode.probeMailer());
    assertEqual(r.ok, true, `健康配置的探针必须通过，实际：${JSON.stringify(r)}`);
    assertEqual(mock.rec.authSeen, 'PLAIN:\u0000u@x.com\u0000SECRET-PW',
      '探针必须真的走完登录 —— 只连上不认证的话，它证明不了「那份口令还能用」'
      + '（口令过期 / 被服务商要求用授权码，正是最常见的发信失败原因）');
    // 不投递：没有信封、没有正文 —— 探针不能顺手发一封信给任何人
    for (const verb of ['MAIL FROM', 'RCPT TO', 'DATA']) {
      assert(!mock.rec.lines.some((l) => l === verb || l.startsWith(verb + ':') || l.startsWith(verb + ' ')),
        `探针不得进入投递阶段（不得发出 ${verb}）—— 它只验链路`);
    }
  } finally {
    mock.close();
  }
});

test('R57-02 · 探针：认证被拒 / 连不上 / 未配置 / 已停用 四种失败都给出可执行的提示', async () => {
  // ① 认证被拒（服务商改了授权码 / 口令里是登录密码而非授权码）—— 最常见的真故障
  const bad = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true, authFail: true });
  try {
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: bad.port, secure: false,
      user: 'u@x.com', password: 'WRONG-PW', from: 'a@b.com', fromName: '',
    });
    const r = await withPsk(() => emailCode.probeMailer());
    assertEqual(r.ok, false, '认证被拒时必须判失败（否则又会回到「显示已发送、信永远不来」）');
    assertEqual(r.status, 503, '配置类失败应是 503，而不是网络超时那种不确定状态');
    assertMatch(r.error, /系统发信当前不可用/, '必须开门见山说明"现在发不出去"');
    assertMatch(r.error, /登录（AUTH PLAIN）/, '必须说清是哪一步被拒 —— 否则管理员只能靠猜');
    assertMatch(r.error, /535/, '要把服务端的原话带出来（它常直接写着"请使用授权码"这类真正的原因）');
  } finally {
    bad.close();
  }

  // ② 连不上：把主机指向一个**刚关闭**的端口（回环上立刻 ECONNREFUSED，不必等超时）
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  configStore.saveSmtp({
    enabled: true, host: '127.0.0.1', port: deadPort, secure: false,
    user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
  });
  const c = await emailCode.probeMailer();
  assertEqual(c.ok, false, '端口无人监听时必须判失败');
  assertEqual(c.status, 503);
  assertMatch(c.error, /连接 SMTP 服务器/, '错误里要说清连的是哪个主机端口 —— 这才是能照着改的信息');

  // ③ 未配置与 ④ 已停用：两条闸门各自给出**不同**的文案（混成一句会让管理员去重填一份本来就对的配置）
  configStore.save({ smtp: {} });
  const n = await emailCode.probeMailer();
  assertMatch(n.error, /尚未配置发信/, '未配置要指向「系统设置 → 发信设置」');

  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    configStore.saveSmtp({
      enabled: false, host: '127.0.0.1', port: mock.port, secure: false,
      user: 'u@x.com', password: 'SECRET-PW', from: 'a@b.com', fromName: '',
    });
    const d = await emailCode.probeMailer();
    assertMatch(d.error, /停用/, '停用要写「已停用」，与「尚未配置」严格分开');
    assertEqual(mock.rec.lines.length, 0, '停用判在探针之前 ⇒ 一个字节都不该发出去');
  } finally {
    mock.close();
  }
});

test('R57-03 · 闸门顺序：站点级探针必须在**读取标识之前**执行（否则响应又随标识而变）', () => {
  const src = fs.readFileSync(SERVER('routes', 'auth.js'), 'utf8');
  const from = src.indexOf("router.post('/auth/forgot'");
  const to = src.indexOf("router.post('/auth/reset'");
  assert(from > 0 && to > from, '自证：应当能取到 /auth/forgot 的实现段');
  const body = src.slice(from, to);

  const iGate = body.indexOf('await emailCode.probeMailer()');
  const iFind = body.indexOf('configStore.findUserByIdentifier(');
  assert(iGate > 0, '/auth/forgot 必须调站点级探针');
  assert(iFind > 0, '自证：该段里应当有按标识查用户的调用');
  /**
   * ⚠️ 这条顺序**就是判据本身**，不是风格问题：把探针挪进 `if (raw && email)` 里
   * （"只有真要发信时才探"）会让响应随标识而变 —— 命中且发不出去 ⇒ 503，
   * 未命中 ⇒ 200，这条匿名端点立刻变回一条账户存在性 oracle。
   */
  assert(iGate < iFind,
    '探针必须先于标识查找 —— 它回答的是站点级状态，不能沾上标识');
});

test('R57-04 · 端到端：配置齐全但服务器认证被拒时，匿名「忘记密码」如实 503（不再回「已发送」）', async () => {
  const mock = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true, authFail: true });
  await configStore.addUser({
    username: 'r57-authfail', password: 'Unit!2026abc', role: 'user', email: 'r57@example.com',
  });
  configStore.saveSmtp({
    enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
    user: 'u@x.com', password: 'WRONG-PW', from: 'a@b.com', fromName: '',
  });
  const app = express();
  app.use(express.json());
  app.use('/api', require(SERVER('routes', 'auth.js')));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const hit = await withPsk(() => request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.57.1.1' }, body: { identifier: 'r57-authfail' },
    }));
    const miss = await withPsk(() => request(srv.address().port, 'POST', '/api/auth/forgot', {
      headers: { 'X-Forwarded-For': '10.57.1.2' }, body: { identifier: 'r57-nobody' },
    }));
    assertEqual(hit.status, 503,
      `认证被拒时不能再回「已发送」—— 那正是用户"配置全对却收不到信"的来源，实际 ${hit.status}：${hit.raw}`);
    assertEqual(hit.raw, miss.raw,
      '站点级失败对命中与未命中必须逐字节相同（防枚举的判据落在这里，而不是"一律 200"）');
    assert(!mock.rec.lines.some((l) => l.startsWith('MAIL FROM')),
      '认证都没过，不该有任何投递动作');
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    mock.close();
  }
});

/* ================================================================== *
 * ⑫ R57 建连截止层：把「建连阶段没有任何失败出口」这一根因钉死
 * ================================================================== */

/**
 * ⑫ 层为什么必要（同一份工单的另外两个症状）
 *
 *  症状 A：`系统发信当前不可用：连接 SMTP 服务器 smtp.qq.com:465 失败（建连）：AggregateError`
 *  症状 B：`正在连接 SMTP 服务器并发送…` / `发送中…` **永久卡住**
 *
 * 两者其实是**同一个缺口**：建连阶段（DNS 解析 → TCP SYN → TLS 握手）**没有任何失败出口**。
 *
 *  - `socket.setTimeout()` 计的是**已建立连接上的「无活动」**，且原实现要到
 *    `_bindLongLived()`（在 `connect` 事件之后）才装上 ⇒ 对端把包**丢弃**（而非
 *    拒绝）时那个 Promise **永不 settle**（实测黑洞地址 8 秒内零事件，真实 SYN
 *    重传约 130 秒）⇒ 症状 B。
 *  - Node 20 起 `autoSelectFamily` 默认开启，域名解析出多个地址而**全部**连不上时
 *    抛的是 `AggregateError`，其 `message` 是**空串** ⇒ 原实现取 `e.message` 得到
 *    零信息文案 ⇒ 症状 A。
 *
 * 故两条护栏分别守住「有硬截止」与「错误里带得出可执行信息」，再加一条**正向对照**
 * 证明截止逻辑不误伤正常连接（否则「一律立刻拒绝」也能让前两条全绿）。
 */

test('R57-09 · 建连：对端丢包（数据包被丢弃）时按硬截止报错，绝不永久挂住', async () => {
  const smtpLib = require(SERVER('smtp.js'));
  const realConnect = net.connect;
  const realCreate = net.createConnection;
  /**
   * ⚠️ `net.connect === net.createConnection` 是**同一个函数引用**（Node 里就是别名），
   * 两个名字都要替换 —— 只换一个的话，本进程内 fake 服务器 / 其它测试的
   * `server.listen` 之后的连接也会走这个桩，把整片测试挂住。
   * 桩返回一个**永不 emit `connect` 的裸 Socket**，精确模拟「SYN 被丢弃」：
   * 没有 error、没有 connect —— 只有硬截止能救。
   */
  let made = null;
  const stub = () => { made = new net.Socket(); return made; };
  net.connect = stub;
  net.createConnection = stub;
  try {
    const t0 = Date.now();
    await assertReject(
      () => smtpLib.sendMail(Object.assign({}, BASE, {
        host: 'blackhole.invalid', port: 465, secure: false, timeoutMs: 400,
      })),
      '对端丢包时必须报错 —— 永久 pending 就是那个"卡死"的 bug',
    );
    const dt = Date.now() - t0;
    assert(dt >= 300, `不能立刻报错（否则测到的不是截止逻辑本身），实际 ${dt}ms`);
    assert(dt < 3000, `硬截止必须真的生效（否则界面会一直停在"正在连接 SMTP 服务器并发送…"），实际 ${dt}ms`);
    assert(made && made.destroyed, '超时后必须销毁套接字 —— 否则每次失败都泄漏一条连接');
  } finally {
    net.connect = realConnect;
    net.createConnection = realCreate;
  }
});

test('R57-10 · 建连：AggregateError 拆成逐地址原因与可执行提示（不是一句零信息文案）', async () => {
  const smtpLib = require(SERVER('smtp.js'));
  const realConnect = net.connect;
  const realCreate = net.createConnection;
  /** 模拟 `autoSelectFamily` 的真实产物：多地址全败，`message` 为空串，原因在 `.errors[]` */
  const stub = () => {
    const s = new net.Socket();
    setImmediate(() => {
      const e1 = Object.assign(new Error('connect ENETUNREACH 240e::1:465'), {
        code: 'ENETUNREACH', address: '240e::1', port: 465,
      });
      const e2 = Object.assign(new Error('connect ETIMEDOUT 183.47.120.204:465'), {
        code: 'ETIMEDOUT', address: '183.47.120.204', port: 465,
      });
      s.emit('error', new AggregateError([e1, e2]));
    });
    return s;
  };
  net.connect = stub;
  net.createConnection = stub;
  try {
    /** ⚠️ `assertReject` 只返回 true，拿不到异常对象 ⇒ 这里手工捕一次（要读 message） */
    let e = null;
    try {
      await smtpLib.sendMail(Object.assign({}, BASE, {
        host: 'multi.example', port: 465, secure: false, timeoutMs: 3000,
      }));
    } catch (err) { e = err; }
    assert(e, 'AggregateError 也必须走到失败出口（不能吞掉）');
    assertMatch(e.message, /连接 SMTP 服务器 multi\.example:465 失败/);
    assertMatch(e.message, /240e::1/, '自证：原因真的来自 errors[]，不是凭空拼的');
    assertMatch(e.message, /ENETUNREACH/, '逐地址必须带上各自的错误码 —— 不同码要改的东西不同');
    assertMatch(e.message, /183\.47\.120\.204/, '第 2 个地址的原因也必须带出来（不能只报第一个）');
    assertMatch(e.message, /ETIMEDOUT/);
    assertMatch(e.message, /网络不可达|路由|IPv6/, '必须附一条可执行的下一步，而不是把原始错误码甩给用户');
    assert(
      !/^连接 SMTP 服务器 [^：]*失败（[^）]*）：AggregateError$/.test(e.message),
      '绝不能只剩一句零信息的 AggregateError —— 那正是工单原文',
    );
  } finally {
    net.connect = realConnect;
    net.createConnection = realCreate;
  }
});

test('R57-11 · 正向对照：调大超时后真实 SMTP 会话仍成功（硬截止不误杀正常连接）', async () => {
  const s = await startMock({ ehlo: ['mock'], auth: 'PLAIN LOGIN', starttls: true });
  try {
    const r = await withPsk(() => require(SERVER('smtp.js')).sendMail(
      Object.assign({ host: '127.0.0.1', port: s.port, secure: false, timeoutMs: 8000 }, BASE),
    ));
    assertEqual(r.ok, true,
      '正向对照：正常连接 + 足够超时必须成功 —— 缺了它，「一律立刻拒绝」也能让 R57-09 全绿');
  } finally {
    s.close();
  }
});

/* ================================================================== *
 * ⑬ R61：发信失败的「详情被 S3 翻译层覆盖」
 * ================================================================== */

test('R61-01 · 发信失败必须把 SMTP 的详细原因原样回给界面（不得被 S3 翻译层覆盖）', async () => {
  /**
   * 工单原文：「SMTP再次出错，报错提示：发送失败：网络连接异常，请检查网络后重试」。
   *
   * 那句话**不是 SMTP 模块说的** —— 全库只有 `server/s3.js` 的 `translateError()`
   * 会产出它。链路是：`smtp.sendMail()` 抛出的连接错误**没有 `status`** ⇒
   * `apiHandler` 判 `e.status ? e : translateError(e)` ⇒ 落进**对象存储**的翻译层 ⇒
   * 正则命中 `ETIMEDOUT / ECONNRESET / ENOTFOUND …` ⇒ 整段替换成那句零信息文案。
   * R58 拼好的「哪个地址、几个地址全部不可达、各自什么错误码、该改端口还是放行防火墙」
   * 就这样在到达界面之前被吃掉了 —— 用户看到的和没修之前一模一样。
   *
   * 判据落在**真实 HTTP 响应体**上（而不是「smtp.js 里有没有写 status」）：
   * 后者只能证明「写了」，证明不了「路由层真的用上了」。
   */
  const s = await serve(ADMIN);
  try {
    /**
     * `127.0.0.1:1` —— 本机必然 `ECONNREFUSED`，即时返回：不发外网请求、
     * 不依赖任何外部服务、也不需要等 SYN 重传（测试必须稳定且快）。
     */
    configStore.saveSmtp({
      host: '127.0.0.1', port: 1, secure: false, user: '', password: '', from: 'a@b.com',
    });
    const r = await request(s.port, 'POST', '/api/smtp/test', { body: {} });
    const msg = String((r.json && r.json.error) || '');

    assertMatch(msg, /连接 SMTP 服务器 127\.0\.0\.1:1 失败/,
      `必须点名「连的是谁、在哪个阶段失败」；实际：${msg}`);
    assertMatch(msg, /ECONNREFUSED|对方主动拒绝/,
      `必须带底层错误码与可执行提示（拒绝 ≠ 超时：一个要改端口、一个要放行防火墙）；实际：${msg}`);
    assert(!/网络连接异常/.test(msg),
      `绝不能把 SMTP 失败说成 S3 翻译层的「网络连接异常，请检查网络后重试」—— 那正是工单原文；实际：${msg}`);
    assert(!/^操作失败，请重试$/.test(msg),
      `也不能退化成无信息的兜底文案；实际：${msg}`);
    assertEqual(r.status, 500,
      `连接失败应回 500（与原先由翻译层给出的状态码一致，本修复只改文案）；实际 ${r.status}：${msg}`);
  } finally {
    s.close();
  }
});
