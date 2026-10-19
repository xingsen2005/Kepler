/**
 * 第四十七轮护栏（R47）—— 用户报告的三条界面体验缺陷：
 *
 *   ①「用户执行某些操作后，必须刷新才能看到正式生效的结果」
 *   ②「用户刷新页面，不会回到原来的页面」
 *   ③「用户只能使用浏览器的刷新按钮，按 F5 刷新没有作用」
 *
 * 三者的因果：**③ 是根因**。旧实现 `bindKeyboard()` 里把刷新键抢走了
 * （`preventDefault()` 之后只重取文件列表），所以用户口中的「刷新」= 按那个键，
 * 而它毫无反应；唯一能真正重载的只剩浏览器工具栏那颗刷新按钮，整页重载又因为
 * 没有地址记忆而回到文件浏览首页（②），重载前那些**跨区块**的陈旧数据也只能靠
 * 用户自己发现（①）。
 *
 * 本文件分三层验证（越往下越接近「真跑一遍」）：
 *  1. **前端源码层**（main.js / explorer.js）：刷新键已交还浏览器；地址栏记忆的
 *     白名单与角色门控；登出时记忆必须作废；
 *  2. **api.js 行为层**：装一个假 `fetch`，**真调用** `request()`，验证
 *     「写成功才通知、读与豁免不通知、失败绝不通知」；
 *  3. **端到端层**：把 main.js 里**真实的** `onServerWrite` / `syncNow` 抽出来挂到
 *     **真实的** api.js 上，用假 fetch 驱动一次写请求，断言界面同步真的被触发
 *     —— 含去抖合并与「同步期间再写一轮」的重入保护。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertReject, ROOT } = require('./helpers');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const readSrc = (...p) => fs.readFileSync(JS(...p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 若 `src[i]` 开启了一段字符串 / 注释，返回跳过它之后的下标；否则返回 -1。
 *
 * 必须**跳过字符串与注释** —— 否则函数体里出现 `'{'`（比如这个项目大量存在的
 * 中文提示文案与注释）会让配对提前结束，取出来的"函数体"其实只有半截，
 * 后面的断言就变成对半截文本的**假绿**。
 */
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { let j = i; while (j < src.length && src[j] !== '\n') j++; return j; }
  if (c === '/' && src[i + 1] === '*') { let j = i + 2; while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++; return j + 2; }
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
    return j + 1;
  }
  return -1;
}

/** 从 `startIdx` 处的 `[` / `{` 起做配对，返回配对符之后的下标（左闭右开）。 */
function matchSpan(src, startIdx) {
  const open = src[startIdx];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  assert(close, 'R47：括号配对只支持 [ 与 {');
  let d = 0;
  for (let i = startIdx; i < src.length; i++) {
    const sk = skipLiteral(src, i);
    if (sk > 0) { i = sk - 1; continue; }
    if (src[i] === open) d++;
    else if (src[i] === close) { d--; if (d === 0) return i + 1; }
  }
  throw new Error('R47：括号未配对：' + src.slice(startIdx, startIdx + 60));
}

/** 取出具名函数（含 `async function`）的**函数体源码**（不含签名）。 */
function fnBody(src, name) {
  const idx = src.indexOf('function ' + name + '(');
  assert(idx >= 0, `R47：main.js 里应存在函数 ${name}()`);
  const open = src.indexOf('{', idx);
  assert(open > 0, 'R47：未找到函数体起始的 {');
  const end = matchSpan(src, open);
  const body = src.slice(open, end);
  assert(body.length > 60, `R47：${name}() 的函数体过短（${body.length} 字节），抽取逻辑可能出错`);
  return body;
}

/** 取出一段 `const NAME = [ … ];` / `const NAME = { … };` 声明的完整源码。 */
function declText(src, name) {
  const key = 'const ' + name + ' = ';
  const i = src.indexOf(key);
  assert(i >= 0, `R47：main.js 里未找到 ${name} 声明`);
  return src.slice(i, matchSpan(src, i + key.length)) + ';';
}

/* ================================================================== *
 * 第 1 层 · 刷新键交还浏览器（缺陷 ③）
 * ================================================================== */

test('R47-01a · 刷新键不再被拦截（键盘处理里不得再出现该键与 preventDefault 的组合）', () => {
  const src = readSrc('main.js');
  const body = fnBody(src, 'bindKeyboard');
  // 自证抽取到的是**正确的那段**：这一支必须还在（否则说明取错了区域，
  // 后面的「不含刷新键」就成了对空文本的假绿）
  assert(body.includes("e.key === 'Backspace'"), 'R47-01a 自证：应当取到键盘分支（含 Backspace 返回上一级）');
  assert(body.includes("e.key === 'Delete'"), 'R47-01a 自证：应当取到键盘分支（含 Delete 删除）');
  assert(!/\bF5\b/.test(body), 'R47-01a：键盘处理里不得再出现刷新键 —— 它必须交还浏览器做整页重载');
  assert(!/preventDefault\(\);\s*explorer\.refresh\(\)/.test(body), 'R47-01a：不得再有「拦截刷新键后只刷新文件列表」的写法');
});

test('R47-01b · 刷新键仍在「a」分支上保留（证明被摘掉的只有刷新键那一条，而非把整段快捷键删了）', () => {
  const body = fnBody(readSrc('main.js'), 'bindKeyboard');
  assert(body.includes("e.key.toLowerCase() === 'a'"), 'R47-01b：Ctrl/Cmd+A 全选仍然保留');
  /**
   * R52 起这里**不能再写「只剩一处 preventDefault」**：Ctrl+C / Ctrl+V 已改走应用内
   * 剪贴板（`ops.copySelected()` / `ops.paste()`），同样必须 preventDefault 才能压住
   * 浏览器对页面文字的选择复制 —— 于是处数从 1 变成 3，是**合法增长**。
   *
   * 但直接把计数放宽成 `>= 1` 会把这条护栏打软：它原本拦的正是「又有一个不带修饰键的
   * 分支抢走浏览器默认行为」。所以改判**每一处** preventDefault 都必须挂在
   * Ctrl/Cmd 组合键的分支上 —— 这个口径既容得下 R52 的两处新增，也照旧抓得住
   * 「把刷新键重新拦下来」那种回退（`else if (e.key === 'F5') { e.preventDefault(); … }`
   * 里那处 preventDefault 落在一个没有 ctrlKey/metaKey 的分支上 ⇒ 立刻变红）。
   */
  const at = [...body.matchAll(/preventDefault\(\)/g)].map((m) => m.index);
  assert(at.length >= 1, 'R47-01b：Ctrl+A 的全选分支必须保留一处 preventDefault（否则全选会连浏览器选区一起动）');
  for (const i of at) {
    const head = body.slice(0, i);
    const br = head.lastIndexOf('else if (');
    // 剥掉行注释再判：注释里写出 `e.ctrlKey` 不算数（本项目反复踩的「判据落在注释上」）
    const cond = body.slice(br < 0 ? 0 : br, i).replace(/\/\/[^\n]*/g, '');
    assert(/\be\.(ctrlKey|metaKey)\b/.test(cond),
      'R47-01b：preventDefault 只允许出现在 Ctrl/Cmd 组合键的分支上 —— 挂到其它键上等于又抢了浏览器默认行为'
      + `（实际所在分支：${JSON.stringify(cond.split('\n').pop().trim().slice(0, 90))}）`);
  }
});

test('R47-01c · 右键菜单不再宣称刷新键（否则提示与实际行为不符）', () => {
  const src = readSrc('explorer.js');
  assert(!src.includes("k: 'F5'"), 'R47-01c：右键菜单不得再标注刷新键（该键现在是浏览器整页重载）');
  assert(src.includes("explorer.refresh()"), 'R47-01c：右键「刷新列表」本身必须保留（它仍然只重取本目录）');
});

/* ================================================================== *
 * 第 2 层 · 地址栏记忆（缺陷 ②）
 * ================================================================== */

test('R47-02a · 有地址栏记忆能力：主区块状态 + 白名单解析 + 回写', () => {
  const src = readSrc('main.js');
  assert(/mainView:\s*'explorer'/.test(src), 'R47-02a：App.state 里应有 mainView（当前主区块，与文件列表排版 view 区分开）');
  const body = fnBody(src, 'viewFromHash');
  assert(body.includes('MAIN_VIEWS.includes'), 'R47-02a：hash 必须过白名单 —— 地址栏是用户可任意编辑的输入，不能直接当区块 id 用');
  assert(!body.includes('location.hash ='), 'R47-02a：解析函数不得反过来写地址栏（读写必须分离，否则内部会自己触发 hashchange）');
});

/**
 * 把 main.js 里**真实的** `MAIN_VIEWS` + `VIEW_ENTRY` + `viewFromHash()` 抽出来求值，
 * 用假的 `location` / `document` 驱动它。
 *
 * 为什么不能只做源码断言：这里的关键性质是「入口被隐藏时**结果**必须回落」，而
 * 源码断言（「必须出现 `el.hidden`」）连**取反**都抓不到 —— `!el.hidden` 同样含这个子串。
 */
function buildViewGateHarness() {
  const src = readSrc('main.js');
  const decls = declText(src, 'MAIN_VIEWS') + '\n' + declText(src, 'VIEW_ENTRY');
  const body = fnBody(src, 'viewFromHash');
  // 自证：三段都取到了**真东西**（否则后面的断言是对空壳的假绿）
  assert(decls.includes("'credmgr'") && decls.includes("'side-orders'"),
    'R47 自证：抽出的 MAIN_VIEWS / VIEW_ENTRY 应含真实内容');
  const factory = new Function('location', 'document',
    decls + '\nfunction viewFromHash()' + body
    + '\nreturn { viewFromHash: viewFromHash, MAIN_VIEWS: MAIN_VIEWS, VIEW_ENTRY: VIEW_ENTRY };');
  const boot = factory({ hash: '' }, { getElementById: () => null });
  // R54③ 新增 `invitemgr` ⇒ 8 → 9；R62 新增 `couponmgr` ⇒ 9 → 10。
  // 这个数字是**自证**（证明抽出来的确实是真东西），不是判据本身 —— 判据是下面那些
  // viewFromHash() 的行为断言。新增主区块时同步这里即可。
  assertEqual(boot.MAIN_VIEWS.length, 10, 'R47 自证：MAIN_VIEWS 应有 10 个区块');
  assertEqual(boot.VIEW_ENTRY.ordermgr, 'side-orders', 'R47 自证：VIEW_ENTRY 应把订单区块映射到它的入口');
  return {
    viewFromHash: (hash, { hidden = [], missing = [] } = {}) => {
      const hs = new Set(hidden);
      const ms = new Set(missing);
      const document = { getElementById: (id) => (ms.has(id) ? null : { hidden: hs.has(id) }) };
      return factory({ hash }, document).viewFromHash();
    },
  };
}

test('R47-02b · 地址栏记忆必须按角色门控（普通用户改 hash 也不能进管理员页）—— 真跑 viewFromHash()', () => {
  const h = buildViewGateHarness();
  // 已知区块 + 入口可见 → 落到该区块
  assertEqual(h.viewFromHash(''), 'explorer', 'R47-02b：无 hash 应落到文件浏览');
  assertEqual(h.viewFromHash('#explorer'), 'explorer', 'R47-02b：#explorer 应落到文件浏览');
  assertEqual(h.viewFromHash('#dashboard'), 'dashboard', 'R47-02b：入口可见的区块应能直达');
  assertEqual(h.viewFromHash('#ordermgr'), 'ordermgr', 'R47-02b：管理员（入口可见）应能直达订单管理');
  // ⭐ 核心越权判据：入口被 renderUserMenu() 判为隐藏（普通用户）⇒ 必须回落
  assertEqual(h.viewFromHash('#ordermgr', { hidden: ['side-orders'] }), 'explorer',
    'R47-02b：普通用户改地址栏不得进入订单管理（入口被角色权威点判为隐藏）');
  assertEqual(h.viewFromHash('#ipmgr', { hidden: ['side-ipmgr'] }), 'explorer',
    'R47-02b：同理，IP 地址管理页不得被地址栏绕过');
  // 入口元素根本不存在时同样不得进入（防御 HTML 结构变动）
  assertEqual(h.viewFromHash('#ordermgr', { missing: ['side-orders'] }), 'explorer',
    'R47-02b：入口元素不存在时必须回落');
  // 白名单：任意字符串不得被当成区块 id 用
  assertEqual(h.viewFromHash('#../../etc/passwd'), 'explorer', 'R47-02b：非白名单的 hash 一律回落');
  assertEqual(h.viewFromHash('#Ordermgr'), 'explorer', 'R47-02b：大小写不匹配也一律回落');

  // 角色名单只有一份（不在 VIEW_ENTRY 里另写），否则「改 hash 即可进管理员页」会悄悄回来
  const src = readSrc('main.js');
  const entryMap = src.slice(src.indexOf('const VIEW_ENTRY'), src.indexOf('function writeViewHash'));
  assert(entryMap.includes("ordermgr: 'side-orders'") && entryMap.includes("ipmgr: 'side-ipmgr'"),
    'R47-02b：管理员专属区块（订单 / IP 管理）的入口必须登记在册，才能被门控挡下');
  assert(!/role\s*===/.test(entryMap), 'R47-02b：不得在此另写一份角色名单（越权缺口的经典来源）');
});

test('R47-02c · 回写地址栏走 replaceState（不污染历史、不触发 hashchange）', () => {
  const body = fnBody(readSrc('main.js'), 'writeViewHash');
  assert(body.includes('history.replaceState'), 'R47-02c：必须用 replaceState —— 否则浏览器「后退」会在区块间跳，与 ← → 的文件浏览历史打架');
  assert(!/location\.hash\s*=/.test(body), 'R47-02c：不得用 location.hash 赋值（会产生历史记录并触发 hashchange，把自己绕回来）');
  assert(/v === 'explorer'/.test(body), 'R47-02c：默认落点应回写为**无 hash** 的干净地址');
});

test('R47-02d · 启动时按地址栏恢复页面（且必须在 navigate 之前读 hash）', () => {
  const src = readSrc('main.js');
  const body = fnBody(src, 'bootstrapApp');
  const readAt = body.indexOf('viewFromHash()');
  const navAt = body.indexOf("App.navigate(''");
  assert(readAt >= 0, 'R47-02d：启动流程必须读一次地址栏 —— 否则刷新永远回到文件浏览');
  assert(navAt >= 0, 'R47-02d 自证：启动流程里应当有 App.navigate 调用（没有它就说明取错了函数）');
  assert(readAt < navAt, 'R47-02d：读地址栏必须早于 App.navigate —— 后者会把 hash 归一化回 explorer，读晚了永远恢复不出来');
  assert(body.includes('switchMainView(startView'), 'R47-02d：读完必须真的切过去');
});

test('R47-02e · 换账号 / 登出时地址栏记忆必须作废（与「上个会话区块不得残留」同源）', () => {
  const src = readSrc('main.js');
  const body = fnBody(src, 'resetMainView');
  assert(/mainView\s*=\s*'explorer'/.test(body), 'R47-02e：resetMainView 必须把主区块状态复位');
  assert(body.includes("writeViewHash('explorer')"),
    'R47-02e：必须同时把地址栏里的区块清掉 —— 否则登出后地址栏仍挂着管理页，刷新或换账号会照着重放');
  // 与既有的越权原因同一处：订单 / IP 数据必须仍被丢弃（本轮不得因为新增复位而挤掉旧复位）
  assert(body.includes('ordermgr.reset()') && body.includes('ipmgr.reset()'),
    'R47-02e：既有的跨会话数据丢弃必须保留');
});

test('R47-02f · 手工改地址栏也能落到对应区块（且启动早期不响应）', () => {
  const src = readSrc('main.js');
  const body = fnBody(src, 'bindViewHash');
  assert(body.includes("addEventListener('hashchange'"), 'R47-02f：必须监听 hashchange（手工改 hash / 浏览器前进后退）');
  assert(body.includes('App._bootstrapped'), 'R47-02f：各区块尚未建立时不得响应，否则会对着还不存在的视图切换');
  assert(body.includes('App.state.user'), 'R47-02f：登录遮罩期（无会话）不得响应');
  assert(src.includes('bindViewHash();'), 'R47-02f：监听必须被真正注册（init 里调用）');
});

/* ================================================================== *
 * 第 3 层 · api.js 的写通知（缺陷 ①）—— 真跑 request()
 * ================================================================== */

/** 载入真实的 api.js 模块（ESM，Node 22 起 require 可直接同步加载）。 */
function loadApi() {
  const p = JS('api.js');
  if (require.cache[require.resolve(p)]) delete require.cache[require.resolve(p)];
  return require(p);
}

/** 装一个假 fetch；返回收到的调用记录。 */
async function withFakeFetch(resp, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    calls.push({ url, method: (opt && opt.method) || 'GET' });
    return {
      ok: resp.ok !== false,
      status: resp.status || (resp.ok === false ? 500 : 200),
      json: async () => (resp.body || {}),
      // 真实 `Response` 一定带 `headers`；缺了它，读响应头的错误路径会以 TypeError 收场
      headers: { get: () => null },
    };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

test('R47-03a · 写请求成功后必须通知界面（这是全站唯一收口点）', async () => {
  const api = loadApi();
  const seen = [];
  api.setWriteObserver((p) => seen.push(p));
  const calls = await withFakeFetch({ ok: true, body: { ok: 1 } }, () => api.API.saveConfig({ a: 1 }));
  assertEqual(calls.length, 1, 'R47-03a 自证：应当真发出了一次请求');
  assertEqual(calls[0].method, 'PUT', 'R47-03a 自证：本条测的必须是**写**请求');
  assertEqual(seen.length, 1, 'R47-03a：写成功必须通知一次（否则又回到「必须手动刷新」）');
  assertEqual(seen[0], '/api/config', 'R47-03a：通知应带真实请求路径，便于排查');
  api.setWriteObserver(null);
});

test('R47-03b · 读请求与"非变更类"写请求不得通知（否则一次页面加载会自激式刷新）', async () => {
  const api = loadApi();
  const seen = [];
  api.setWriteObserver((p) => seen.push(p));
  await withFakeFetch({ ok: true, body: {} }, async () => {
    await api.API.getConfig();                       // 读
    await api.API.verifyConfig({});                  // 探针：只验连通性
    await api.API.validatePayment('wechat', {});     // 探针：只验支付凭据
    await api.API.logout();                          // 会话生命周期
    await api.API.encUnlock('pw');                   // 会话内解锁
    await api.API.webauthnRegisterOptions('pw');     // 生成挑战
  });
  assertEqual(seen.length, 0, `R47-03b：这些请求都不得触发界面同步，实际通知了：${JSON.stringify(seen)}`);
  api.setWriteObserver(null);
});

test('R47-03c · 豁免必须是"那条探针"，不能顺手把同前缀的真实保存一起豁免', async () => {
  const api = loadApi();
  const seen = [];
  api.setWriteObserver((p) => seen.push(p));
  await withFakeFetch({ ok: true, body: {} }, async () => {
    await api.API.validatePayment('wechat', {});  // /api/payment/config/wechat/validate → 探针，豁免
    await api.API.savePayment('wechat', {});      // /api/payment/config/wechat         → 真保存，必须通知
  });
  assertEqual(seen.length, 1, 'R47-03c：支付渠道**保存**必须通知（它和同前缀的"验证"不是一回事）');
  assertEqual(seen[0], '/api/payment/config/wechat', 'R47-03c：通知的必须是保存那条路径');
  api.setWriteObserver(null);
});

/**
 * R57：登录前的三个**匿名**写端点（注册 / 忘记密码 / 重置密码）也必须豁免界面同步。
 *
 * 漏登记的后果实测过：`POST /api/auth/forgot` 成功后触发一次界面同步，而同步的第一步
 * 就是 `GET /api/config`（需要会话）⇒ 401 ⇒ `loadConfig()` 的 catch 把服务端那句
 * 401 文案 `toast` 出来。于是用户点「发送验证码」明明成功了，却先看到
 * 「未登录或会话已过期，请重新登录」；而窗口**紧接着又进了重置密码那一步** ——
 * 两件事叠在一起，看起来就是"发送失败却放行了"。
 *
 * 判据刻意**先自证观察者是活的**：只断言"一条都没通知"的话，观察者没接上也会全绿。
 */
test('R57-05a · 登录前的匿名写端点不得触发界面同步（否则会 toast 一句假的"会话已过期"）', async () => {
  const api = loadApi();
  const seen = [];
  api.setWriteObserver((p) => seen.push(p));

  // 自证：普通写请求必须通知一次
  await withFakeFetch({ ok: true, body: {} }, () => api.API.mkdir('/a'));
  assertEqual(seen.length, 1, `自证：普通写请求应通知一次，实际：${JSON.stringify(seen)}`);

  await withFakeFetch({ ok: true, body: {} }, async () => {
    await api.API.register({ username: 'u', password: 'p' });
    await api.API.forgotPassword({ identifier: 'u' });
    await api.API.resetPassword({ identifier: 'u', code: '123456', password: 'p' });
  });
  assertEqual(seen.length, 1,
    '登录前的三条匿名端点不得触发界面同步（此刻没有会话，同步必然 401 并把 401 文案弹给用户）'
    + `，实际通知了：${JSON.stringify(seen)}`);
  api.setWriteObserver(null);
});

test('R47-03d · 写请求失败绝不通知（失败没有需要同步的变更）', async () => {
  const api = loadApi();
  const seen = [];
  api.setWriteObserver((p) => seen.push(p));
  await assertReject(
    () => withFakeFetch({ ok: false, status: 500, body: { error: 'boom' } }, () => api.API.mkdir('/a')),
    'R47-03d：失败请求必须抛出',
  );
  assertEqual(seen.length, 0, 'R47-03d：失败的写请求绝不能通知界面同步');
  api.setWriteObserver(null);
});

test('R47-03e · 观察者自身抛错不得影响请求结果（同步是锦上添花，不是业务的一部分）', async () => {
  const api = loadApi();
  api.setWriteObserver(() => { throw new Error('观察者炸了'); });
  let got = null;
  await withFakeFetch({ ok: true, body: { ok: 1 } }, async () => {
    got = await api.API.mkdir('/a'); // 若观察者的异常冒泡，这一句就会抛、测试自然失败
  });
  assert(got && got.ok === 1, 'R47-03e：观察者抛错时请求仍须正常返回');
  api.setWriteObserver(null);
});

/* ================================================================== *
 * 第 4 层 · 端到端：写请求 → 界面同步（真 api.js + 真 main.js 抽段）
 * ================================================================== */

/**
 * 把 main.js 里**真实的**「写通知 → 去抖 → 同步」那一段抽出来，注入桩依赖后
 * 返回 `onServerWrite`。
 *
 * 为什么不用源码级断言了事：这一段的核心价值是**时序**（去抖合并、重入保护），
 * 而"文本里有没有 setTimeout"完全看不出去抖是否有效。这里把真源码求值进一个
 * 受控作用域，就能用假 fetch 驱动**真实的** api.js，观察真实调用序列。
 */
function buildSyncHarness({ mainView = 'explorer', loadConfig } = {}) {
  const src = readSrc('main.js');
  const startIdx = src.indexOf('const SYNC_DEBOUNCE_MS = ');
  assert(startIdx > 0, 'R47：main.js 里应能找到 SYNC_DEBOUNCE_MS 声明');
  const fnIdx = src.indexOf('async function syncNow(');
  assert(fnIdx > startIdx, 'R47：syncNow 应紧随其常量声明之后（抽段依赖这一顺序）');
  const block = src.slice(startIdx, matchSpan(src, src.indexOf('{', fnIdx)));
  // 自证抽到的是完整一段：两个函数与常量都必须在
  for (const need of ['SYNC_DEBOUNCE_MS', 'function onServerWrite', 'function syncNow', 'syncPending']) {
    assert(block.includes(need), `R47 自证：抽出的同步段里缺少 ${need}`);
  }

  const rec = { cfg: [], enc: 0, explorer: [], view: [] };
  const App = { state: { mainView } };
  const deps = {
    App,
    loadConfig: (...a) => { rec.cfg.push(a); return (loadConfig || (() => Promise.resolve()))(...a); },
    loadEncState: () => { rec.enc++; },
    explorer: { refresh: (o) => { rec.explorer.push(o); return Promise.resolve(); } },
    switchMainView: (v, o) => { rec.view.push([v, o]); },
  };
  const factory = new Function(
    'App', 'loadConfig', 'loadEncState', 'explorer', 'switchMainView',
    block + '\nreturn { onServerWrite: onServerWrite, syncNow: syncNow, debounce: SYNC_DEBOUNCE_MS };',
  );
  const mod = factory(deps.App, deps.loadConfig, deps.loadEncState, deps.explorer, deps.switchMainView);
  assert(mod.debounce > 0 && mod.debounce <= 1000, `R47：去抖窗口取值应合理，实际 ${mod.debounce}`);
  return { mod, rec, App };
}

test('R47-04a · 写成功后应重拉配置 + 加密摘要 + 刷新**当前区块**（端到端）', async () => {
  const api = loadApi();
  const h = buildSyncHarness({ mainView: 'explorer' });
  api.setWriteObserver(h.mod.onServerWrite);
  await withFakeFetch({ ok: true, body: {} }, () => api.API.saveConfig({ a: 1 }));
  await sleep(h.mod.debounce + 120);

  assertEqual(h.rec.cfg.length, 1, 'R47-04a：必须重拉一次配置（侧边栏 / 状态栏读的是这份快照）');
  assertEqual(h.rec.cfg[0][0], false, 'R47-04a：重拉配置必须是"非首次"语义（first=false）');
  assertEqual(h.rec.enc, 1, 'R47-04a：必须刷新加密摘要（下载门控判定）');
  assertEqual(h.rec.explorer.length, 1, 'R47-04a：当前区块是文件浏览，必须刷新文件列表');
  assertEqual(h.rec.explorer[0] && h.rec.explorer[0].silent, true, 'R47-04a：后台同步不该弹加载提示（silent）');
  assertEqual(h.rec.view.length, 0, 'R47-04a：已经是文件浏览，不应再去切视图');
  api.setWriteObserver(null);
});

test('R47-04b · 停留在其它区块时只刷新那个区块（不越权刷新看不见的页面）', async () => {
  const api = loadApi();
  const h = buildSyncHarness({ mainView: 'dashboard' });
  api.setWriteObserver(h.mod.onServerWrite);
  await withFakeFetch({ ok: true, body: {} }, () => api.API.saveConfig({ a: 1 }));
  await sleep(h.mod.debounce + 120);
  assertEqual(h.rec.explorer.length, 0, 'R47-04b：不在文件浏览页时不必刷新文件列表');
  assertEqual(h.rec.view.length, 1, 'R47-04b：应切到当前区块以触发它自己的 refresh()');
  assertEqual(h.rec.view[0][0], 'dashboard', 'R47-04b：刷新的是当前区块');
  assertEqual(h.rec.view[0][1] && h.rec.view[0][1].syncHash, false, 'R47-04b：同步时不得回写地址栏（否则会把 hash 改成当前值，抹掉用户意图）');
  api.setWriteObserver(null);
});

test('R47-04c · 批量写请求必须合并成一次同步（去抖真的生效）', async () => {
  const api = loadApi();
  const h = buildSyncHarness();
  api.setWriteObserver(h.mod.onServerWrite);
  await withFakeFetch({ ok: true, body: {} }, async () => {
    await Promise.all([
      api.API.saveConfig({ a: 1 }),
      api.API.mkdir('/x'),
      api.API.addCredential({ name: 'k' }),
      api.API.createLink({ k: 'v' }),
      api.API.setPaymentEnabled(true),
    ]);
  });
  await sleep(h.mod.debounce + 150);
  assertEqual(h.rec.cfg.length, 1, 'R47-04c：5 条写请求只该产生 1 次配置重拉（去抖合并）');
  assertEqual(h.rec.explorer.length, 1, 'R47-04c：同理只该刷新 1 次文件列表');
  api.setWriteObserver(null);
});

test('R47-04d · 读请求与豁免请求根本不进入同步（不是"同步了但没变化"）', async () => {
  const api = loadApi();
  const h = buildSyncHarness();
  api.setWriteObserver(h.mod.onServerWrite);
  await withFakeFetch({ ok: true, body: {} }, async () => {
    await api.API.getConfig();
    await api.API.verifyConfig({});
    await api.API.list({ prefix: '' });
  });
  await sleep(h.mod.debounce + 150);
  assertEqual(h.rec.cfg.length, 0, 'R47-04d：读请求不得触发任何同步');
  assertEqual(h.rec.view.length + h.rec.explorer.length, 0, 'R47-04d：读请求不得触发任何界面刷新');
  api.setWriteObserver(null);
});

test('R47-04e · 同步过程中的写请求不得与同步并发（重入保护：必须串行、且不丢）', async () => {
  const api = loadApi();
  // 第一次 loadConfig 卡住，用于制造「同步进行中又来了一个写请求」的窗口
  const events = [];
  const gates = [];
  const stepped = () => new Promise((res) => {
    events.push('cfg-start');
    gates.push(() => { events.push('cfg-end'); res(); });
  });
  const h = buildSyncHarness({ loadConfig: () => stepped() });
  api.setWriteObserver(h.mod.onServerWrite);

  await withFakeFetch({ ok: true, body: {} }, async () => {
    await api.API.saveConfig({ a: 1 });           // 触发第 1 轮同步
    await sleep(h.mod.debounce + 60);             // 等它进入 loadConfig（卡住状态）
    await api.API.mkdir('/y');                    // 同步进行中的写请求
    await sleep(h.mod.debounce + 60);             // 等"若未被保护"的那个定时器该触发的时间点
    assert(gates.length === 1,
      `R47-04e：同步进行中不得并发再开一轮同步（此时应仍只有 1 次配置重拉），实际 ${gates.length}`);
    gates[0]();                                   // 放行第 1 轮
    await sleep(h.mod.debounce + 60);
    assertEqual(gates.length, 2, 'R47-04e：被合并的那次写请求不能丢，必须在第 1 轮结束后补上');
    gates[1]();                                   // 放行第 2 轮
  });

  await sleep(50);
  assertEqual(events.join(','), 'cfg-start,cfg-end,cfg-start,cfg-end',
    'R47-04e：两轮必须严格串行（start/end 交替），不得重叠');
  api.setWriteObserver(null);
});

/* ================================================================== *
 * 接线：观察者必须在启动时装上（否则上面全部逻辑都是死代码）
 * ================================================================== */

test('R47-05 · 启动时必须注册写观察者，且方向只能是 api.js 不反向依赖 main.js', () => {
  const main = readSrc('main.js');
  const initBody = fnBody(main, 'init');
  assert(initBody.includes('setWriteObserver(onServerWrite)'),
    'R47-05：init() 里必须注册写观察者 —— 否则整套同步是死代码');
  assert(initBody.includes('bindViewHash()'), 'R47-05：init() 里必须注册地址栏监听');
  assert(/import\s*\{[^}]*setWriteObserver[^}]*\}\s*from\s*'\.\/api\.js'/.test(main),
    'R47-05：setWriteObserver 必须自 api.js 具名导入');
  // 唯一收口点：依赖方向必须单向 —— api.js 一个 import 都没有，自然就不可能反向依赖
  // 界面层。这条断言守的是「别为了图方便把 main.js / App 拽进来」。
  const api = readSrc('api.js');
  assert(!/^\s*import\s/m.test(api), 'R47-05：api.js 不得出现任何 import（它必须是最底层，不能反向依赖界面层）');
});
