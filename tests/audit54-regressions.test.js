/**
 * 第 54 轮护栏（第一部分）—— 「站点设置」卡片
 *
 * 需求原文（全文见 CHANGELOG 的 [1.7.7]）：
 *  > 在“用户设置”上方新增“站点设置”。该功能默认开启，因此无需启用/关闭开关。
 *  > 1、站点名称：用于显示在浏览器标题栏、邮件发信中，默认为“Kepler 对象存储管理系统”；
 *  > 2、公开注册：…（公开注册 / 邀请码 / 关闭注册）
 *  > 3、新用户身份：新注册的用户直接赋予的权限，默认为“普通用户”；
 *
 * 本轮只落地**第 1 部分**：配置项 + 卡片 + 站点名称的两条消费路径（标题栏 / 发信兜底）。
 * 注册页、忘记密码、邀请码系统属后续两部分（见 CHANGELOG 与台账的拆分说明）。
 *
 * ## 断言分七层，缺一层就留一种假绿
 *
 *  ① **判据层**（真实 `server/limits.js`）：站点名称入参判据、注册模式 / 身份归一化；
 *  ② **配置层**（真实 `server/config-store.js`）：默认值、PATCH 语义、空名回退、落盘归一；
 *  ③ **视图层**：`safeView()` 两处返回都带 `site`；`siteView()` 对空配置也不出 `undefined`；
 *  ④ **路由层**（真 HTTP）：权限两级（`/site/info` 公开、`/site/config` 仅管理员）、读写回环、非法入参 400；
 *  ⑤ **发信兜底层**（真实 `server/smtp.js` + 进程内假 SMTP 服务器）：真的发一封信，
 *     断言**收到的** `From:` 显示名与 `Subject:` 就是站点名称 —— 只用源码正则证明不了这件事；
 *  ⑥ **前端卡片层**：卡片位置、管理员登记、**没有启用开关**；
 *  ⑦ **标题栏接线层**：`applySiteName()` 是唯一实现点，且启动流程真的调它。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('node:net');
const express = require('express');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir, cleanupTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('r54-');
process.env.S3_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const PUBLIC = (...p) => path.join(ROOT, 'public', ...p);
const readJs = (n) => fs.readFileSync(JS(n), 'utf8');
const readHtml = () => fs.readFileSync(PUBLIC('index.html'), 'utf8');

/* ================================================================== *
 * ① 判据层：站点名称与两个枚举的入参判据
 * ================================================================== */

const limits = require(SERVER('limits.js'));
const {
  parseSiteNameInput, SITE_NAME_MAX, SITE_NAME_DEFAULT,
  normalizeRegistrationMode, normalizeDefaultRole,
  REGISTRATION_MODES, DEFAULT_ROLES,
} = limits;

test('R54-1 · 站点名称入参：含 CR / LF 一律拒绝（它会被拼进邮件信头）', () => {
  /**
   * 站点名称有两个消费方会把**原始字符串**塞进行式 / 标记式上下文：
   * 邮件 `From:` 信头（`buildMessage` 手工拼一行）与 HTML `<title>`。
   * 一个换行就能在邮件里追加伪造信头，故与 SMTP 各字段同一口径。
   */
  for (const bad of ['Kepler\r\nBcc: x@y.com', 'a\nb', 'x\r', '\r\n', '站点\r\n名']) {
    const r = parseSiteNameInput(bad);
    assertEqual(r.ok, false, `站点名称 ${JSON.stringify(bad)} 必须被拒`);
    assert(typeof r.error === 'string' && r.error.length > 0, '非法入参必须带提示文案');
  }
  // 与 `parseSmtpAddressInput` 同款的「先 trim 后判」陷阱：末尾 CRLF 不能被 trim 裁掉而放行
  assertEqual(parseSiteNameInput('Kepler \r\n').ok, false, '末尾 CRLF 也必须被拒（判据在 trim 之前）');
});

test('R54-1 · 站点名称入参：超长显式报错，空串合法（= 恢复默认名）', () => {
  assertEqual(parseSiteNameInput('x'.repeat(SITE_NAME_MAX)).ok, true, '恰好等于上限应通过');
  const over = parseSiteNameInput('x'.repeat(SITE_NAME_MAX + 1));
  assertEqual(over.ok, false, '超长必须显式报错（不静默截断 —— 截断会让管理员以为整串都存下了）');

  const empty = parseSiteNameInput('   ');
  assertEqual(empty.ok, true, '空 / 纯空白合法');
  assertEqual(empty.value, '', '空值归一为「什么都不填」，由落盘归一化换成默认名');
  // 首尾空白被裁掉（与邮件显示名同款）
  assertEqual(parseSiteNameInput('  Kepler  ').value, 'Kepler');
});

test('R54-1 · 注册模式 / 新用户身份：非法值一律回到最保守的一档', () => {
  for (const ok of REGISTRATION_MODES) assertEqual(normalizeRegistrationMode(ok), ok);
  for (const bad of ['', null, undefined, 'OPEN', 'public', 0, {}, []]) {
    assertEqual(normalizeRegistrationMode(bad), 'closed', `注册模式 ${JSON.stringify(bad)} 应回到 closed`);
  }
  for (const ok of DEFAULT_ROLES) assertEqual(normalizeDefaultRole(ok), ok);
  for (const bad of ['', null, undefined, 'ADMIN', 'root', 1, {}]) {
    assertEqual(normalizeDefaultRole(bad), 'user', `身份 ${JSON.stringify(bad)} 应回到 user`);
  }
  // 默认名要与前端 `<title>` 同文 —— 否则升级瞬间标题栏会闪一下换了名字
  const html = readHtml();
  assert(html.includes(SITE_NAME_DEFAULT),
    `index.html 的 <title> 必须与 SITE_NAME_DEFAULT（${SITE_NAME_DEFAULT}）同文`);
});

/* ================================================================== *
 * ② 配置层：默认值 / PATCH 语义 / 空名回退 / 落盘归一
 * ================================================================== */

const configStore = require(SERVER('config-store.js'));

test('R54-2 · 默认值：历史配置没有 site 段时补齐为「默认站点名 + 关闭注册 + 普通用户」', () => {
  const s = configStore.getSite();
  assertEqual(s.siteName, SITE_NAME_DEFAULT, '缺省站点名必须是文档化的默认值');
  /**
   * 默认**关闭注册**很关键：本版本之前系统没有注册入口，
   * 默认成 open/invite 等于升级即悄悄开放了一个谁都能进来的通道。
   */
  assertEqual(s.registration, 'closed', '缺省注册模式必须是「关闭注册」（最保守的一档）');
  assertEqual(s.defaultRole, 'user', '缺省新用户身份必须是「普通用户」');
  // 结构完整：不能有 undefined 漏进标题栏
  for (const k of ['siteName', 'registration', 'defaultRole', 'updatedAt']) {
    assertEqual(typeof s[k], 'string', `site.${k} 必须是字符串（而不是 undefined）`);
  }
});

test('R54-2 · PATCH 语义：saveSite 只改给到的字段，其余保持原值', () => {
  configStore.saveSite({ siteName: '站点甲', registration: 'invite', defaultRole: 'admin' });
  const only1 = configStore.saveSite({ siteName: '站点乙' });
  assertEqual(only1.siteName, '站点乙');
  assertEqual(only1.registration, 'invite', '未给出的 registration 必须保持原值');
  assertEqual(only1.defaultRole, 'admin', '未给出的 defaultRole 必须保持原值');

  const only2 = configStore.saveSite({ registration: 'open' });
  assertEqual(only2.siteName, '站点乙', '未给出的 siteName 必须保持原值');
  assertEqual(only2.registration, 'open');

  // 每次保存都刷新 updatedAt（界面上「最后修改」要靠它）
  assert(/^\d{4}-\d{2}-\d{2}T/.test(only2.updatedAt), 'updatedAt 必须是 ISO 时间串');
});

test('R54-2 · 空站点名 → 落盘归一回退成默认名（界面上「留空恢复默认」靠它成立）', () => {
  configStore.saveSite({ siteName: '先起个名' });
  const back = configStore.saveSite({ siteName: '' });
  assertEqual(back.siteName, SITE_NAME_DEFAULT,
    '空串必须换成默认站点名 —— 一个没有名字的站点在标题栏与邮件 From 里都没有意义');
  // 纯空白同理（用户在框里敲了几个空格）
  assertEqual(configStore.saveSite({ siteName: '   ' }).siteName, SITE_NAME_DEFAULT);
});

test('R54-2 · 落盘归一：半截 site 对象读回来也永远是完整结构', () => {
  // `save(partial)` 是**顶层键替换** —— 若只在读取侧归一，
  // 一次带半截 site 的写入会留下缺 registration / defaultRole 的记录。
  configStore.save({ site: { siteName: '半截站' } });
  const s = configStore.getSite();
  assertEqual(s.siteName, '半截站');
  assertEqual(s.registration, 'closed', '缺失的注册模式必须补默认值');
  assertEqual(s.defaultRole, 'user', '缺失的身份必须补默认值');
});

test('R54-2 · 归一化只补结构、不拒绝非法值（分工：入参非法由路由层 400）', () => {
  // 与 `parseSpeedLimitInput` / `normalizeSpeedLimit` 同一分工：
  // 落盘路径遇到脏值（手工编辑过的配置文件 / 老版本残留）要能读起来，而不是抛错。
  configStore.save({ site: { siteName: 'x', registration: '乱写的', defaultRole: 'root' } });
  const s = configStore.getSite();
  assertEqual(s.registration, 'closed');
  assertEqual(s.defaultRole, 'user');
});

/* ================================================================== *
 * ③ 视图层：safeView 两处返回 + siteView 的兜底
 * ================================================================== */

test('R54-3 · safeView：两处返回都带 site（含未配置分支）', () => {
  const admin = configStore.safeView('admin');
  assert(admin.site, 'safeView（正常分支）必须下发 site 段');
  assertEqual(typeof admin.site.siteName, 'string');
  assertEqual(typeof admin.site.registration, 'string');

  const user = configStore.safeView('user');
  assert(user.site, 'safeView（普通用户）同样必须带 site 段 —— 前端标题栏也要用');
  assertEqual(user.site.siteName, admin.site.siteName);
});

test('R54-3 · siteView：任何输入都给完整结构而不是 undefined', () => {
  for (const bad of [null, undefined, {}, { site: null }]) {
    const v = configStore.siteView(bad);
    assertEqual(v.siteName, SITE_NAME_DEFAULT, `${JSON.stringify(bad)} 应给出默认站点名`);
    assertEqual(v.registration, 'closed');
    assertEqual(v.defaultRole, 'user');
  }
  // 半截对象也要补齐
  const half = configStore.siteView({ site: { siteName: '半个' } });
  assertEqual(half.siteName, '半个');
  assertEqual(half.registration, 'closed');
});

/* ================================================================== *
 * ④ 路由层：真 HTTP（权限两级 / 读写回环 / 非法入参）
 * ================================================================== */

/** 起一个只挂载站点子路由的 express 服务；`auth` 为 null = 未登录 */
async function serve(auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.authUser = auth; next(); });
  app.use('/api', require(SERVER('routes', 'site.js')));
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

test('R54-4 · /site/info 是公开接口：未登录与普通用户都能读到站点名称', async () => {
  configStore.saveSite({ siteName: '公开可见的名字' });
  for (const auth of [null, USER]) {
    const s = await serve(auth);
    try {
      const r = await request(s.port, 'GET', '/api/site/info');
      assertEqual(r.status, 200, '匿名 / 普通用户都必须能拿到站点名称（登录页要设标题栏）');
      assertEqual(r.json.ok, true);
      assertEqual(r.json.siteName, '公开可见的名字');
      /**
       * 这条接口任何匿名请求都能打到，故刻意只回三个键 ——
       * 多加一个字段就等于把配置面暴露给未登录的人。
       *
       * R54②：从两个键扩到三个键，多出来的 `registration` 是**刻意的** ——
       * 登录页要据此决定「注册」入口是可用 / 需邀请码 / 不显示。注册模式对匿名者
       * 不是秘密（它本来就由登录页行为暴露），而 `defaultRole` 依旧不给。
       */
      assertEqual(Object.keys(r.json).sort().join(','), 'ok,registration,siteName',
        '只允许回 ok / siteName / registration 三个字段');
      // 反向自检：`defaultRole` 是纯管理侧配置，绝不能出现在公开响应里
      assertEqual(r.json.defaultRole, undefined, '公开响应不得包含 defaultRole');
    } finally {
      s.close();
    }
  }
});

test('R54-4 · /site/config 仅管理员（含未登录）', async () => {
  for (const auth of [null, USER]) {
    const s = await serve(auth);
    try {
      for (const [m, body] of [['GET', null], ['PUT', {}]]) {
        const r = await request(s.port, m, '/api/site/config', body ? { body } : {});
        assertEqual(r.status, 403, `${m} /api/site/config 在 ${auth ? '普通用户' : '未登录'}下必须 403`);
      }
    } finally {
      s.close();
    }
  }
});

test('R54-4 · 管理员读写回环：保存后立即能读回，且响应即最新视图', async () => {
  const s = await serve(ADMIN);
  try {
    const put = await request(s.port, 'PUT', '/api/site/config', {
      body: { siteName: '回环站', registration: 'open', defaultRole: 'admin' },
    });
    assertEqual(put.status, 200);
    assertEqual(put.json.siteName, '回环站');
    assertEqual(put.json.registration, 'open');
    assertEqual(put.json.defaultRole, 'admin');

    const get = await request(s.port, 'GET', '/api/site/config');
    assertEqual(get.status, 200);
    assertEqual(get.json.siteName, '回环站');
    assertEqual(get.json.defaultRole, 'admin');
    // 真的落到了 store 上
    assertEqual(configStore.getSite().siteName, '回环站');
  } finally {
    s.close();
  }
});

test('R54-4 · 非法入参一律 400，且**不静默改写**（管理员以为自己设置生效了最糟）', async () => {
  const s = await serve(ADMIN);
  try {
    configStore.saveSite({ siteName: '原名字', registration: 'closed', defaultRole: 'user' });
    const cases = [
      ['站点名称含换行', { siteName: 'a\r\nBcc: x@y.com' }],
      ['站点名称超长', { siteName: 'x'.repeat(SITE_NAME_MAX + 1) }],
      ['注册模式非法', { registration: 'public' }],
      ['注册模式非字符串', { registration: 3 }],
      ['身份非法', { defaultRole: 'root' }],
      ['身份非字符串', { defaultRole: true }],
    ];
    for (const [label, body] of cases) {
      const r = await request(s.port, 'PUT', '/api/site/config', { body });
      assertEqual(r.status, 400, `${label} 必须 400`);
      assert(typeof r.json.error === 'string' && r.json.error.length > 0, `${label} 必须带可读的提示`);
    }
    // 一次都没改成功 ⇒ 配置保持原样（「非法值被静默改写成另一个合法值」是最糟的形态）
    const after = configStore.getSite();
    assertEqual(after.siteName, '原名字', '非法请求不得改动站点名称');
    assertEqual(after.registration, 'closed', '非法请求不得改动注册模式');
    assertEqual(after.defaultRole, 'user', '非法请求不得改动新用户身份');
  } finally {
    s.close();
  }
});

test('R54-4 · /site/info 必须登记进 index.js 的匿名白名单（PUBLIC_API）', () => {
  /**
   * 判据落在**源码里的那个 Set 字面量**上，而不是「另起一个 express 实例直接挂子路由」——
   * 后者绕过了 index.js 的鉴权中间件，无论白名单写没写都恒绿（这正是本文件其它
   * 路由用例 `serve()` 的用法，它对「权限」有效、对「白名单」无效）。
   *
   * 与 `tests/routes-surface.test.js` 判 `/auth/login/webauthn` 同款：
   * 白名单是一条**必须存在的配置事实**，唯一可核的地方就是它的声明处。
   */
  const idx = fs.readFileSync(SERVER('index.js'), 'utf8');
  const m = /const PUBLIC_API = new Set\(\[([^\]]*)\]\)/.exec(idx);
  assert(m, 'index.js 应有 PUBLIC_API 的 Set 声明（先确认解析口径没失效）');
  assert(m[1].includes("'/site/info'"),
    'PUBLIC_API 必须含 \'/site/info\' —— 否则未登录的登录页拿不到站点名称（表现为标题栏一直是硬编码那串）');
});

/* ================================================================== *
 * ⑤ 发信兜底层：站点名称必须真的出现在发出去的那封信里
 * ================================================================== */

/**
 * 极简假 SMTP 服务器（只跑明文，不需要认证）—— 记录每次会话收到的命令与 DATA 正文。
 *
 * ⚠️ 这里**必须真连真发**：`fromName: cfg.fromName || siteName` 这种表达式，
 * 用源码正则是证明不了「收件端真的看到站点名称」的 —— 编码、拼行、兜底顺序
 * 任何一处错了，正则照样是绿的。
 */
function startMock() {
  const rec = { lines: [], data: [] };
  let inData = false;
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          rec.data.push(line);
          if (line === '.') { inData = false; sock.write('250 2.0.0 Queued\r\n'); }
          continue;
        }
        rec.lines.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-mock\r\n250 SIZE 10240000\r\n');
        else if (up.startsWith('HELO')) sock.write('250 mock\r\n');
        else if (up.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
        else if (up.startsWith('RCPT TO')) sock.write('250 OK\r\n');
        else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (up === 'QUIT') {
          sock.write('221 Bye\r\n');
          setTimeout(() => { try { sock.destroy(); } catch (_) { /* 已销毁 */ } }, 5);
        } else sock.write('250 OK\r\n');
      }
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

/** 从信头里取出第一个 RFC 2047 编码字并解码（`=?UTF-8?B?<b64>?=`）*/
function decodeFirstEncodedWord(s) {
  // ⚠️ 开头是 `=?UTF-8?B?`（`=` 后面还有一个 `?`）—— 漏掉它正则永远不命中，
  // 于是「解出来是空串」会被误读成「服务端没编码」，而实际是判据自己写错了。
  const m = /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(s);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
}

/** 挂载站点 + 发信两个子路由（测试邮件要同时用到它们） */
async function serveMail(auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.authUser = auth; next(); });
  app.use('/api', require(SERVER('routes', 'site.js')));
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

test('R54-5 · 发信兜底：发件人显示名留空时用站点名称，且测试邮件主题带站点名称', async () => {
  const mock = await startMock();
  const s = await serveMail(ADMIN);
  try {
    configStore.saveSite({ siteName: '我的私有云' });
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
      user: '', password: '', from: 'noreply@example.com', fromName: '', // 留空 ⇒ 应兜底成站点名称
    });
    const r = await request(s.port, 'POST', '/api/smtp/test', { body: { to: 'boss@example.com' } });
    assertEqual(r.status, 200, '测试发信应成功（假服务器只跑明文、不需要认证）');

    const payload = mock.rec.data.join('\r\n');
    assert(payload.length > 0, '假服务器必须真的收到了 DATA 正文');
    // 显示名走 RFC 2047 编码字 —— 解出来必须正是站点名称
    assertEqual(decodeFirstEncodedWord(payload), '我的私有云',
      'From 的显示名必须是站点名称（发信设置里留空时兜底）');
    // 主题里也要有站点名称
    const subjIdx = payload.indexOf('Subject:');
    assert(subjIdx >= 0, '信件必须有 Subject 信头');
    assertEqual(decodeFirstEncodedWord(payload.slice(subjIdx)), '我的私有云 发信测试',
      '测试邮件的主题必须带站点名称');
  } finally {
    s.close();
    mock.close();
  }
});

test('R54-5 · 发信兜底：发信设置里填了显示名就以它为准（站点名称不得覆盖）', async () => {
  const mock = await startMock();
  const s = await serveMail(ADMIN);
  try {
    configStore.saveSite({ siteName: '我的私有云' });
    configStore.saveSmtp({
      enabled: true, host: '127.0.0.1', port: mock.port, secure: false,
      user: '', password: '', from: 'noreply@example.com', fromName: '某某平台通知',
    });
    const r = await request(s.port, 'POST', '/api/smtp/test', { body: { to: 'boss@example.com' } });
    assertEqual(r.status, 200);
    const payload = mock.rec.data.join('\r\n');
    assertEqual(decodeFirstEncodedWord(payload), '某某平台通知',
      '发信设置里明确填了显示名 ⇒ 必须是它，站点名称只在留空时兜底');
  } finally {
    s.close();
    mock.close();
  }
});

/* ================================================================== *
 * ⑥ 前端卡片层：位置 / 管理员登记 / 没有启用开关
 * ================================================================== */

test('R54-6 · 卡片位置：「站点设置」在「用户管理」之上（且不破坏 R53 的顺序）', () => {
  const html = readHtml();
  const iSite = html.indexOf('id="sysset-site-card"');
  const iUser = html.indexOf('id="sysset-user-card"');
  const iSmtp = html.indexOf('id="sysset-smtp-card"');
  const iConc = html.indexOf('id="sysset-concurrency-card"');
  assert(iSite >= 0 && iUser >= 0 && iSmtp >= 0 && iConc >= 0, '四张卡片都必须存在');
  assert(iSite < iUser,
    `需求白纸黑字要求「在用户设置上方」新增站点设置，实际下标 ${iSite}/${iUser}`);
  // R53 的顺序不能被本轮挤坏
  assert(iUser < iSmtp && iSmtp < iConc,
    `「用户管理 → 发信设置 → 线程并发」的顺序被破坏，实际下标 ${iUser}/${iSmtp}/${iConc}`);
});

test('R54-6 · 卡片没有启用开关（需求：该功能默认开启，无需开关）', () => {
  const html = readHtml();
  const i = html.indexOf('id="sysset-site-card"');
  const j = html.indexOf('id="sysset-user-card"');
  assert(i >= 0 && j > i, '需定位到站点设置卡片区块');
  /**
   * R68：先**剥掉 HTML 注释**再判「有没有开关」。
   *
   * 这条断言是负向的（「不得出现 X」），而注释不是渲染出来的东西 —— 不剥的话，
   * 一句「这里刻意不用 ip-switch」的说明就会把自己判红（本轮实际发生过）。
   * 这与 `FACTS.md` §十五第 ② 类「`innerHTML` 判据被解释性注释满足」是同一类问题，
   * 只是方向相反（那次是假绿，这次是假红）。
   */
  const block = html.slice(i, j).replace(/<!--[\s\S]*?-->/g, '');
  assert(!/ip-switch/.test(block),
    '站点设置卡片内不得出现启用开关（ip-switch）—— 它决定的是标题栏与默认身份这类必然存在的属性');
  assert(!/id="site-enabled"/.test(block), '不得存在 site-enabled 开关');
  // 但保存按钮必须存在
  assert(/id="btn-site-save"/.test(block), '卡片必须有保存按钮');
});

test('R54-6 · 卡片可见性：必须登记进 ADMIN_ONLY_CARDS（且排在最前，与 DOM 顺序一致）', () => {
  const js = readJs('syssettings.js');
  assertMatch(js, /ADMIN_ONLY_CARDS\s*=\s*\['sysset-site-card',[^\]]*'sysset-user-card'/,
    '「站点设置」必须登记进 ADMIN_ONLY_CARDS，且排在 sysset-user-card 之前（与页面上它在最上方一致）');
  // 三个控件都要在
  const html = readHtml();
  const block = html.slice(html.indexOf('id="sysset-site-card"'), html.indexOf('id="sysset-user-card"'));
  assert(/id="site-name"/.test(block), '须有站点名称输入框');
  assert(/id="site-registration"/.test(block), '须有注册模式分段选择');
  assert(/id="site-role"/.test(block), '须有新用户身份分段选择');
  for (const v of ['open', 'invite', 'closed']) {
    assert(new RegExp(`data-v="${v}"`).test(block), `注册模式须有 ${v} 这一档`);
  }
  for (const v of ['user', 'admin']) {
    assert(new RegExp(`data-v="${v}"`).test(block), `新用户身份须有 ${v} 这一档`);
  }
});

/* ================================================================== *
 * ⑦ 标题栏接线层
 * ================================================================== */

test('R54-7 · 标题栏：applySiteName 是唯一实现点，且启动流程真的调它（未登录也生效）', () => {
  const js = readJs('syssettings.js');
  assert(/export\s+function\s+applySiteName\s*\(/.test(js), 'applySiteName 必须是 syssettings.js 的导出函数');
  assert(/document\.title\s*=/.test(js), 'applySiteName 必须真的写 document.title');
  // 空串不动标题（标题栏空着比留着旧名字更糟）
  assert(/if\s*\(!n\)\s*return;/.test(js), '空名称必须直接 return，不得把标题清空');
  // 保存成功后即时生效
  assertMatch(js, /applySiteName\(r\.siteName\)/, '保存成功后必须把新站点名称写进标题栏');

  const main = readJs('main.js');
  assertMatch(main, /syssettings\.applySiteName\(/, 'main.js 必须在启动流程里调用 applySiteName');
  assertMatch(main, /API\.siteInfo\(\)/, 'main.js 必须从公开接口 /api/site/info 取站点名称');
  // 取名称必须发生在鉴权探测**之前** —— 否则登录页永远拿不到站点名称
  const iInfo = main.indexOf('API.siteInfo()');
  const iAuth = main.indexOf('await checkAuth()');
  assert(iInfo >= 0 && iAuth >= 0 && iInfo < iAuth,
    '站点名称必须在 checkAuth() 之前取 —— 未登录的登录页也要显示它');
});

/* ================================================================== *
 * 清理
 * ================================================================== */

test('R54-0 · 清理临时数据目录', () => {
  cleanupTempDir(tmp);
  os.tmpdir(); // 保持 os 引用（与其它轮次措辞一致）
});
