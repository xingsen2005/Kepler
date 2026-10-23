'use strict';

/**
 * 零依赖 SMTP 发信客户端（R53）
 *
 * ## 为什么自己写
 *
 * 需求是「允许管理员设置 SMTP」，且**尽量不新增任何依赖**。业界通行方案是
 * `nodemailer`（本体 + 十余个传递依赖），为一个「保存后发一封测试信」的用途
 * 引入整棵依赖树并不划算。SMTP 会话本身是**行式文本协议**（RFC 5321），
 * 核心握手只有六条命令，用 `node:net` + `node:tls` 即可完整实现：
 *
 *   S: 220 问候
 *   C: EHLO <helo>        → S: 250-…（能力清单）
 *   C: STARTTLS           → S: 220      （仅明文端口；升级后必须重发 EHLO）
 *   C: AUTH PLAIN <b64>   → S: 235
 *   C: MAIL FROM:<addr>   → S: 250
 *   C: RCPT TO:<addr>     → S: 250 / 251
 *   C: DATA               → S: 354
 *   C: …信头␍␊␍␊正文… + "."  → S: 250
 *   C: QUIT               → S: 221
 *
 * ## 支持范围（刻意收窄）
 *
 *  - 加密：隐式 TLS（465，`secure: true`）+ STARTTLS（587 / 25，服务端宣告才升级）；
 *  - 登录：`AUTH PLAIN` 优先，服务端不支持时退回 `AUTH LOGIN`；两者都不支持却又
 *    填了用户名 ⇒ **直接报错**，不静默降级为「不登录直接发」（那会被绝大多数
 *    服务器拒收，且报错看起来像网络不通，极难排查）；
 *  - 编码：主题走 RFC 2047 编码字、正文走 base64，统一 UTF-8；
 *  - **超时**：**建连（DNS → TCP → TLS 握手）与每条命令都有硬截止**（默认 15 秒）。
 *    ⚠️ 建连那一段不能用 `socket.setTimeout` 代替（它只在**已建立**的连接上计「无活动」）；
 *    对端把数据包**丢弃**时必须能报错，否则界面会永久卡在「发送中」。
 *    `AggregateError`（多地址全部不可达）会被拆成**逐地址 + 逐错误码**的可执行文案。
 *  - 不支持：附件 / HTML 正文 / DKIM 签名 —— 本功能只需要发纯文本测试信。
 *
 * ## ⚠️ 信头注入（本模块最硬的一条约束）
 *
 * SMTP 是行式协议，`MAIL FROM:<…>` 与 `From: …` 都是**手工拼进命令与信头**的。
 * 一旦外部字符串里带 CR / LF，攻击者就能追加任意命令或信头（伪造 `Bcc`、
 * 覆盖 `Subject`），即经典的 SMTP 头部注入。base64 化正文挡不住它 ——
 * 只有**在入口处拒绝换行**才行，判据在 `limits.js` 的 `parseSmtpAddressInput` /
 * `parseSmtpTextInput`。本模块再做一层 `oneLine()` 兜底（退化为空格），
 * 但**不能**因此放宽入口校验 —— 兜底是为了「万一漏了也不至于被注入」。
 */

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeSmtpPort } = require('./limits');

/** 建连 / 每条命令的默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15000;

/** 各阶段可接受的响应码（RFC 5321 §4.2） */
const CODE = {
  greeting: [220],
  ehlo: [250],
  starttls: [220],
  authChallenge: [334],
  authOk: [235],
  mail: [250],
  rcpt: [250, 251],
  dataReady: [354],
  dataDone: [250],
  quit: [221],
};

/** 配置类问题（口令缺失 / 地址不合法 …）—— 400，提示管理员去改设置 */
function configError(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

/**
 * 底层错误码 → 「下一步该做什么」。
 *
 * 判据不是「有没有错误」，而是**用户能不能据此改对配置**：`ECONNREFUSED` 与
 * `ETIMEDOUT` 看起来都是一句网络错误，实际一个要改端口、一个要放行防火墙。
 */
const CONN_HINT = {
  ENOTFOUND: '域名解析失败 —— 服务器地址可能拼错，或本机 DNS 不可用',
  EAI_AGAIN: '域名解析暂时无响应 —— 稍后重试，或把服务器地址直接填成 IP',
  ECONNREFUSED: '对方主动拒绝 —— 端口号可能写错，或该端口未对外开放',
  ETIMEDOUT: '连接超时（数据包被丢弃）—— 多为防火墙 / 云端安全组未放行出站该端口',
  ENETUNREACH: '网络不可达 —— 本机没有到该地址的路由（IPv6 地址多为服务器未配置 IPv6 出口）',
  EHOSTUNREACH: '主机不可达 —— 被路由或防火墙拦截',
  ECONNRESET: '连接被重置 —— 可能被中间设备（防火墙 / 代理）拦截',
  EPROTO: 'TLS 握手失败 —— 该端口可能不是隐式 TLS 端口（465 才是）',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书上的域名与所填地址不一致',
  CERT_HAS_EXPIRED: '服务器证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器使用自签名证书 —— 本模块不跳过证书校验',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书链（系统根证书可能缺失）',
};

/** 取错误码对应的可执行提示；认不出时返回空串（宁可不提示，也不给错的建议） */
function hintFor(code) {
  return CONN_HINT[String(code || '').toUpperCase()] || '';
}

/**
 * 把底层网络错误包一层，带上「连的是谁」—— 否则日志里只有 ECONNREFUSED 一个词。
 *
 * ⚠️ **必须拆开 `AggregateError`**：Node 20 起 `autoSelectFamily` 默认开启，
 * 域名解析出多个地址（IPv4 / IPv6 各一条很常见）而**全部**连不上时，抛的是
 * `AggregateError` ——它的 `message` 是**空串**，每条地址的真实原因藏在 `.errors[]` 里。
 * 直接取 `e.message` 的结果是「失败（建连）：AggregateError」这一类**零信息**文案，
 * 而管理员真正需要的恰好是「哪个地址、什么原因」（ENETUNREACH 与 ECONNREFUSED
 * 要改的东西完全不同）。实测工单原文就是这句 `AggregateError`。
 */
function wrapConnError(e, o, when) {
  const where = `${o.host}:${o.port}`;
  const errs = (e && Array.isArray(e.errors) ? e.errors : []).filter(Boolean);
  if (errs.length) {
    const detail = errs
      .map((x) => `[${x.address || '?'}] ${x.code || x.message || '未知错误'}`)
      .join('、');
    const codes = [];
    for (const x of errs) {
      const c = String((x && x.code) || '').toUpperCase();
      if (c && codes.indexOf(c) < 0) codes.push(c);
    }
    const hint = codes.map(hintFor).filter(Boolean)[0];
    const err = new Error(`连接 SMTP 服务器 ${where} 失败（${when}）：`
      + `${errs.length} 个地址全部不可达 —— ${detail}` + (hint ? `。${hint}` : ''));
    err.cause = e;
    err.connCodes = codes;
    return err;
  }
  const code = String((e && (e.code || e.errno)) || '').toUpperCase();
  const hint = hintFor(code);
  const err = new Error(`连接 SMTP 服务器 ${where} 失败（${when}）：${(e && e.message) || e}`
    + (hint ? `（${hint}）` : ''));
  err.cause = e;
  if (code) err.connCodes = [code];
  return err;
}

/** 建连 / 握手超时（与「服务器无响应」区分：这一条发生在**连接建立完成之前**） */
function connTimeoutError(o, when) {
  const err = new Error(`连接 SMTP 服务器 ${o.host}:${o.port} 超时（${when}）：`
    + `${o.timeoutMs} 毫秒内没有完成。常见原因：本机 / 服务器到外网该端口被防火墙或云端`
    + '安全组拦截、网络不通、地址写错；若服务商同时开放 587 端口（STARTTLS），改用 587 '
    + '一般可绕开对 465 的封锁。');
  err.code = 'ETIMEDOUT';
  err.isTimeout = true;
  return err;
}

/**
 * 等套接字的「成功事件」或错误，**带硬截止**。
 *
 * ## 为什么不能只靠 `socket.setTimeout`
 *
 * `socket.setTimeout` 计的是**已建立连接上的「无活动」**；而 DNS 解析、TCP 的 SYN
 * 重传、TLS 握手这三段都发生在**连接建立之前**。只挂 `_bindLongLived()` 里的那个
 * 空闲超时（它要等 `connect` 事件之后才装上）的后果是：对端把数据包**丢弃**
 * （而非拒绝）时，Promise **永不 settle** —— 实测黑洞地址下 8 秒内**一个事件都没有**
 * （真实 SYN 重传约 130 秒），表现就是界面上的「正在连接 SMTP 服务器并发送…」
 * 与「发送中…」**永久卡住**，用户既拿不到错误、也不知道该等多久。
 *
 * 故这里用一个显式定时器兜住整段建连，到点即销毁套接字并抛超时错。
 *
 * @param {import('node:net').Socket} sock
 * @param {string[]} okEvents 视为成功的首事件（`connect` / `secureConnect`）
 * @param {object} o 已归一化选项（用其 `timeoutMs`）
 * @param {string} when 阶段名（`建连` / `TLS 握手`）
 */
function awaitSocketEvent(sock, okEvents, o, when) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (!sock.destroyed) sock.destroy();
      } catch (_) { /* 销毁失败无需再处理 */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(connTimeoutError(o, when)), o.timeoutMs);
    const onErr = (e) => fail(wrapConnError(e, o, when));
    const onOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('error', onErr);
      for (const ev of okEvents) sock.removeListener(ev, onOk);
    }
    sock.once('error', onErr);
    for (const ev of okEvents) sock.once(ev, onOk);
  });
}

/**
 * EHLO / HELO 的域名参数。
 *
 * 部分服务器会拒绝 `localhost` 或含非法字符的主机名（501 或直接断连），
 * 因此这里收敛字符集；取不到合法主机名时用地址字面量 `[127.0.0.1]`
 * （RFC 5321 §4.1.4 允许，且不需要 DNS 反解）。
 */
function heloName() {
  const raw = String(os.hostname() || '').replace(/[^A-Za-z0-9.-]/g, '');
  const safe = raw.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  return safe || '[127.0.0.1]';
}

/** 任意文本 → 单行（换行一律退化为空格），防命令 / 信头注入的最后一道兜底 */
function oneLine(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
}

/**
 * RFC 2047 编码字（base64、UTF-8），并按 76 字符折行。
 *
 * 纯 ASCII 且不含 `=?` 时原样返回 —— 让绝大多数普通信件保持人类可读，
 * 也避免在 `Subject` 上无谓地套一层编码。
 */
function encodedWord(v) {
  const s = oneLine(v);
  if (/^[\x20-\x7E]*$/.test(s) && s.indexOf('=?') < 0) return s;
  const b = Buffer.from(s, 'utf8').toString('base64');
  const chunks = b.match(/.{1,48}/g) || [''];
  return chunks.map((c) => `=?UTF-8?B?${c}?=`).join('\r\n ');
}

/** 取邮箱的域名部分（用于 Message-ID 右半边）；取不到时退回 localhost */
function domainOf(addr) {
  const at = String(addr || '').lastIndexOf('@');
  const d = at < 0 ? '' : String(addr).slice(at + 1).replace(/[^A-Za-z0-9.-]/g, '');
  return d || 'localhost';
}

/**
 * 解析 EHLO 应答里的能力清单。
 *
 * 只要三件事：是否支持 STARTTLS、支持哪些登录方式（AUTH 之后的机制列表）、
 * 是否支持 SMTPUTF8。其余扩展一律忽略 —— 本模块只发纯文本测试信。
 */
function parseCaps(lines) {
  const auth = [];
  let starttls = false;
  let utf8 = false;
  for (const raw of (lines || [])) {
    const line = String(raw || '').trim();
    if (!line) continue;
    if (/^STARTTLS$/i.test(line)) { starttls = true; continue; }
    if (/^SMTPUTF8$/i.test(line)) { utf8 = true; continue; }
    const m = /^AUTH(?:\s+|=)(.+)$/i.exec(line);
    if (!m) continue;
    for (const mech of m[1].split(/\s+/)) {
      const up = String(mech || '').toUpperCase();
      if (up && auth.indexOf(up) < 0) auth.push(up);
    }
  }
  return { auth, starttls, utf8 };
}

/**
 * 点填充（dot-stuffing）：正文里行首的 `.` 必须写成 `..`，
 * 否则服务端会把该行当成 DATA 结束标记（`.` 单行）而提前截断信件。
 */
function dotStuff(msg) {
  return String(msg).split('\r\n').map((l) => (l.charAt(0) === '.' ? `.${l}` : l)).join('\r\n');
}

/** 一次性构造完整信件（信头 + 空行 + 正文），不含 DATA 结束的 `.` */
function buildMessage(o) {
  const b64 = Buffer.from(typeof o.text === 'string' ? o.text : '', 'utf8').toString('base64');
  const body = (b64.match(/.{1,76}/g) || ['']).join('\r\n');
  const fromHeader = o.fromName ? `${encodedWord(o.fromName)} <${o.from}>` : `<${o.from}>`;
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${fromHeader}`,
    `To: <${o.to}>`,
    `Subject: ${encodedWord(o.subject)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domainOf(o.from)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/**
 * 一个 SMTP 会话。
 *
 * 生命周期由 `connect()` → `handshake()` → （`auth()`）→ `send()` → `quit()`
 * 组成；**任何一步失败都必须由调用方走 `quit()`** 兜底关闭套接字
 * （`sendMail()` 用 `try/finally` 保证），否则会泄漏一条 TCP 连接。
 */
class SmtpSession {
  constructor(opts) {
    this.opts = opts;
    this.sock = null;
    this.buf = '';
    /** 正在累积的多行响应（250- 续行） */
    this.lines = [];
    /** 已完整收到、尚未被取走的响应 */
    this.responses = [];
    /** 当前等待响应的取件人 */
    this.waiter = null;
    /** 首个致命错误；置上之后所有后续操作直接抛它 */
    this.failure = null;
    /** 已进入收尾（QUIT / destroy）—— 此后的 'close' 不再算异常 */
    this.closing = false;
    /** 当前这条连接是否已加密（隐式 TLS 或 STARTTLS 升级后） */
    this.encrypted = false;
    this.caps = { auth: [], starttls: false, utf8: false };
  }

  /** 建连。隐式 TLS 与明文走不同分支，之后统一挂长期监听。 */
  async connect() {
    const o = this.opts;
    const sock = o.secure
      ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host })
      : net.connect({ host: o.host, port: o.port });
    this.sock = sock;
    sock.setEncoding('utf8');
    /**
     * ⚠️ 监听必须挂在**握手完成之前**：`net.connect` 返回后读写已就绪，
     * 220 问候可能在 'connect' 事件之前就已进缓冲区 —— 若等 `await` 之后再挂
     * 'data'（微任务晚于 I/O 回调），问候就丢了，表现为「连上了但一直等不到响应」。
     */
    sock.on('data', (chunk) => this._onData(chunk));
    /**
     * ⚠️ 这里必须走 `awaitSocketEvent` 而不是裸的 `once`：建连阶段（DNS / TCP / TLS）
     * 也要有**硬截止**，否则对端丢包时 Promise 永不 settle（见该函数注释）。
     * 连接建立之后的「无活动」超时仍由 `_bindLongLived()` 里的 `socket.setTimeout` 负责。
     */
    await awaitSocketEvent(sock, [o.secure ? 'secureConnect' : 'connect'], o, '建连');
    this.encrypted = !!o.secure;
    this._bindLongLived(sock);
  }

  /** 连接建立后的长期监听：错误 / 超时 / 关闭统一收口到 `_fail()` */
  _bindLongLived(sock) {
    const o = this.opts;
    sock.setTimeout(o.timeoutMs);
    sock.on('error', (e) => this._fail(wrapConnError(e, o, '通信')));
    sock.on('timeout', () => this._fail(new Error(`SMTP 服务器 ${o.host}:${o.port} 超过 ${o.timeoutMs} 毫秒没有响应`)));
    sock.on('close', () => this._fail(new Error(`SMTP 服务器 ${o.host}:${o.port} 关闭了连接`)));
  }

  /** 逐行切分服务端响应；续行（`250-`）累积，末行（`250 `）成帧 */
  _onData(chunk) {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const code = Number.parseInt(line.slice(0, 3), 10);
      if (!Number.isFinite(code)) continue; // 认不出的行直接丢，不污染响应帧
      this.lines.push(line.slice(4));
      if (line.charAt(3) === '-') continue;
      this.responses.push({ code, lines: this.lines.slice() });
      this.lines.length = 0;
      this._pump();
    }
  }

  /** 把已收到的响应交给正在等待的取件人 */
  _pump() {
    while (this.waiter && this.responses.length) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(this.responses.shift());
    }
  }

  /**
   * 致命错误：记下首个错误、叫醒（并拒绝）当前等待者、销毁套接字。
   * 之后的 `_read()` 都会直接抛同一个错误 —— 不会有人永远挂住。
   */
  _fail(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!this.failure) this.failure = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(e);
    }
    this.responses.length = 0;
    if (!this.closing) {
      this.closing = true;
      try {
        if (this.sock && !this.sock.destroyed) this.sock.destroy();
      } catch (_) { /* 销毁失败无需再处理 */ }
    }
  }

  /** 取下一个完整响应（无超时上限 —— 由套接字层的 `setTimeout` 兜底） */
  _read() {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiter = { resolve, reject };
      this._pump();
    });
  }

  /** 发一条命令，原样返回响应（调用方自行判定响应码） */
  async _cmd(line) {
    if (this.failure) throw this.failure;
    const p = this._read();
    this.sock.write(`${line}\r\n`, 'utf8');
    return p;
  }

  /** 发一条命令，并断言响应码；不符则抛错（带上服务端的原话，便于排查） */
  async _cmdOk(line, expect, label) {
    const res = await this._cmd(line);
    this._assertCode(res, expect, label);
    return res;
  }

  _assertCode(res, expect, label) {
    if (!expect.includes(res.code)) {
      const detail = (res.lines || []).filter(Boolean).slice(0, 3).join(' ').slice(0, 300);
      const e = new Error(`SMTP 服务器拒绝了「${label}」：${res.code} ${detail}`.trim());
      e.smtpCode = res.code;
      throw e;
    }
    return res;
  }

  /** 问候 + EHLO（+ 明文段按需升级 STARTTLS） */
  async handshake() {
    this._assertCode(await this._read(), CODE.greeting, '服务器问候');
    await this._ehlo();
  }

  async _ehlo() {
    const name = heloName();
    const res = await this._cmd(`EHLO ${name}`);
    if (res.code === 250) {
      this.caps = parseCaps(res.lines);
      return;
    }
    /**
     * 老式服务器不认 EHLO（按 RFC 5321 应回 502）—— 退回 HELO：
     * 没有能力清单，一律按「无任何扩展」处理（不加密、不登录）。
     */
    const r2 = await this._cmd(`HELO ${name}`);
    this._assertCode(r2, CODE.ehlo, 'HELO');
    this.caps = { auth: [], starttls: false, utf8: false };
  }

  async _starttls() {
    const o = this.opts;
    await this._cmdOk('STARTTLS', CODE.starttls, 'STARTTLS（请求加密）');
    const raw = this.sock;
    /**
     * 交接瞬间底层 TCP 会触发 'close' / 'error'，若不摘掉旧监听，
     * 会被 `_fail()` 误判成「服务器断了」而把一条本来正常的加密连接掐掉。
     */
    raw.removeAllListeners('data');
    raw.removeAllListeners('timeout');
    raw.removeAllListeners('error');
    raw.removeAllListeners('close');
    const secure = tls.connect({
      socket: raw,
      servername: net.isIP(o.host) ? undefined : o.host,
    });
    secure.setEncoding('utf8');
    secure.on('data', (chunk) => this._onData(chunk));
    /** 同理：升级握手也可能被中间设备吞掉，必须有硬截止（原实现会让请求永久挂住） */
    await awaitSocketEvent(secure, ['secureConnect'], o, 'TLS 握手');
    this.sock = secure;
    this.encrypted = true;
    this._bindLongLived(secure);
    /**
     * ⚠️ 升级后必须**重新** EHLO。明文阶段的能力清单不可信 ——
     * 大量服务器在加密前刻意隐瞒 AUTH（防口令走明文），升级后才给出完整清单。
     */
    await this._ehlo();
  }

  /**
   * 登录。
   *
   * ⚠️ 两条硬约束：
   *  1. **未加密的连接一律不发送口令**（明文口令会被整条链路看到）；
   *  2. 服务端不宣告任何登录方式时**报错**，不静默改为「不登录直接发」。
   */
  async auth() {
    const o = this.opts;
    if (!this.encrypted) {
      throw configError(`SMTP 服务器 ${o.host}:${o.port} 未宣告 STARTTLS —— `
        + '已拒绝以明文发送登录口令（请改用 465 端口的隐式 TLS，或在服务端开启 STARTTLS）');
    }
    const sup = this.caps.auth;
    if (!sup.length) {
      throw configError(`SMTP 服务器 ${o.host}:${o.port} 未宣告任何登录方式 —— `
        + '若该服务器本就不需要登录，请清空「用户名」与「密码」后再试');
    }
    if (sup.indexOf('PLAIN') >= 0) {
      const cred = Buffer.from(`\u0000${o.user}\u0000${o.password}`, 'utf8').toString('base64');
      await this._cmdOk(`AUTH PLAIN ${cred}`, CODE.authOk, '登录（AUTH PLAIN）');
      return;
    }
    if (sup.indexOf('LOGIN') >= 0) {
      await this._cmdOk('AUTH LOGIN', CODE.authChallenge, '登录（发起 AUTH LOGIN）');
      await this._cmdOk(Buffer.from(o.user, 'utf8').toString('base64'), CODE.authChallenge, '登录（提交用户名）');
      await this._cmdOk(Buffer.from(o.password, 'utf8').toString('base64'), CODE.authOk, '登录（提交口令）');
      return;
    }
    throw configError(`SMTP 服务器支持的登录方式（${sup.join('、')}）均不受支持（本模块支持 PLAIN 与 LOGIN）`);
  }

  /** 投递一封信（envelope → DATA → `.`） */
  async send(message) {
    await this._cmdOk(`MAIL FROM:${this._envelopeAddr(this.opts.from)}`, CODE.mail, '发件人（MAIL FROM）');
    await this._cmdOk(`RCPT TO:${this._envelopeAddr(this.opts.to)}`, CODE.rcpt, '收件人（RCPT TO）');
    await this._cmdOk('DATA', CODE.dataReady, '正文（DATA）');
    this.sock.write(`${dotStuff(message)}.\r\n`, 'utf8');
    this._assertCode(await this._read(), CODE.dataDone, '正文投递');
  }

  /** envelope 地址：非 ASCII 时必须带 `SMTPUTF8`（RFC 6531），否则服务端会拒 */
  _envelopeAddr(addr) {
    if (/^[\x20-\x7E]*$/.test(addr)) return `<${addr}>`;
    if (!this.caps.utf8) {
      throw configError(`邮件地址「${oneLine(addr)}」含非 ASCII 字符，而该 SMTP 服务器未宣告支持 SMTPUTF8`);
    }
    return `<${addr}> SMTPUTF8`;
  }

  /**
   * 收尾：先礼后兵 —— 发 QUIT，等一小会儿（服务器也可能直接 FIN 不等），
   * 再无条件销毁套接字。失败一律忽略：收尾阶段的错误不该盖掉真正的业务错误。
   */
  async quit() {
    this.closing = true;
    const sock = this.sock;
    if (!sock || sock.destroyed) return;
    try {
      sock.setTimeout(Math.min(3000, this.opts.timeoutMs));
      await this._cmd('QUIT');
    } catch (_) { /* 服务器可能直接断连，属正常 */ }
    try {
      if (!sock.destroyed) sock.destroy();
    } catch (_) { /* 同上 */ }
  }
}

/**
 * 入参收敛：缺字段补默认值，所有文本统一转字符串（不信任调用方类型）
 *
 * R78：**所有会进信头的字段一律过 `oneLine()`** —— `from` / `fromName` / `to` /
 * `subject` 都会被原样拼进 `From:` / `To:` / `Subject:` 行，而 SMTP 的信头以
 * `\r\n` 分行：一个带换行的收件地址（`a@b.c\r\nBcc: victim@x.y`）就是一次
 * **信头注入** —— 收件人之外多出一整行 `Bcc`，或者把正文提前顶到信头区。
 * 旧实现只对 `subject` 做了处理（经 `encodedWord()` 间接 `oneLine`），
 * `from` / `to` / `fromName` 是裸拼的；上游若有一条调用方没做邮箱格式校验，
 * 这里就是最后一道防线。放在**收敛点**而不是拼装点，是因为拼装点有 `From`
 * 与 `To` 两处、将来还会有 `Cc`，逐处补必然漏一处。
 * `text` 是正文，**绝不能**处理（那是合法的多行内容）。
 */
function normalizeOptions(opts) {
  const o = opts || {};
  const n = Number(o.timeoutMs);
  return {
    host: String(o.host || '').trim(),
    port: normalizeSmtpPort(o.port),
    secure: o.secure !== false,
    user: String(o.user || '').trim(),
    password: typeof o.password === 'string' ? o.password : '',
    from: oneLine(String(o.from || '').trim()),
    fromName: oneLine(String(o.fromName || '').trim()),
    to: oneLine(String(o.to || '').trim()),
    subject: oneLine(String(o.subject || '').trim()) || 'Kepler 发信测试',
    text: typeof o.text === 'string' ? o.text : '',
    timeoutMs: Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * 发信前置校验（配置类问题 → 400）。
 *
 * 四条判据只有这一份实现，`sendMail()` 与 `verify()` 共用 —— 分叉的表现是
 * 「探针报告链路健康，可真发时被判 400」，而那正是本轮要消灭的那类静默失败。
 *
 * @param {object} o 归一化后的选项
 * @param {{requireTo?: boolean}} [opts] `requireTo: false` 供**不发信**的探针使用
 *   （`verify()` 不投递任何邮件，自然没有收件人）
 * @returns {string} 空串 = 通过；非空 = 面向管理员的提示
 */
function validateForSend(o, opts) {
  const requireTo = !opts || opts.requireTo !== false;
  if (!o.host) return '尚未填写 SMTP 服务器地址';
  if (!o.from) return '尚未填写发件人地址';
  if (requireTo && !o.to) return '尚未填写收件人地址（留空则默认发给发件人自己）';
  if (o.user && !o.password) return '已填写登录用户名但密码为空（如需免密发信，请清空用户名）';
  return '';
}

/**
 * 「建连 → 握手 → 按需 STARTTLS → 认证」的**唯一实现点**，`sendMail()` 与
 * `verify()` 共用。
 *
 * 抽出来不是为了省几行，而是**两条路径必须走一模一样的登录链路**：
 * 一旦分叉（例如探针少做一次 STARTTLS 后的重新 EHLO），探针就可能对着一条
 * 「真发信时服务器并不接受」的路径报健康 —— 那比不做探针更糟。
 *
 * 任何失败都由这里用 `finally` 兜底 `quit()`，否则每次失败都泄漏一条 TCP 连接。
 *
 * @param {object} o 已归一化的选项
 * @param {(s: SmtpSession, authUsed: string) => Promise<*>} fn 会话就绪后的动作
 */
/**
 * 给 SMTP 的错误盖上「面向用户」的 HTTP 状态。
 *
 * ## 为什么必须盖（R61 实测的真实故障）
 *
 * `routes/_shared.js` 的 `apiHandler` 对**没有 `status`** 的错误一律送
 * `translateError()` —— 而那是**对象存储**的翻译层（`server/s3.js`）。它的
 * 「网络类」分支匹配 `timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed`，
 * 命中就把整段文案替换成一句「网络连接异常，请检查网络后重试」。
 *
 * 于是 R58 辛苦拼出来的诊断（连的是哪个地址、几个地址全部不可达、每个地址各自的
 * 错误码、该改端口还是该放行防火墙）**在到达界面之前就被这一句覆盖掉了** ——
 * 用户看到的就是那句零信息文案，和没修之前一模一样。
 *
 * `apiHandler` 的判据是 `e.status ? e : translateError(e)`：带 `status` 的错误原样使用。
 * 500 与原先由翻译层给出的状态码一致，因此本修复**只改文案、不改变 HTTP 语义**。
 */
function markUserFacing(e) {
  const err = e instanceof Error ? e : new Error(String(e));
  if (!err.status) err.status = 500;
  return err;
}

/**
 * 建一条 SMTP 会话并在其上执行 `fn`。
 *
 * ⚠️ 这是 `sendMail()` 与 `verify()` **共同**的错误出口：把 `markUserFacing()`
 * 放在这里（而不是各条 `throw` 上），新增的错误路径才不会漏盖 ——
 * 漏掉一条就又是一次「详情被 S3 翻译层吞掉」。
 */
async function withSession(o, fn) {
  const s = new SmtpSession(o);
  try {
    /**
     * ⚠️ `connect()` 必须**在 `try` 之内**：原先它写在 `try` 之前，建连一失败
     * 就绕过了 `finally` 里的 `quit()` ⇒ 那条正在建连的套接字没人关。
     * 超时路径尤其明显（超时的套接字不会被 Node 自动销毁）。
     */
    await s.connect();
    await s.handshake();
    if (!s.encrypted && s.caps.starttls) await s._starttls();
    let authUsed = '';
    if (o.user) {
      authUsed = s.caps.auth.indexOf('PLAIN') >= 0 ? 'PLAIN' : 'LOGIN';
      await s.auth();
    }
    return await fn(s, authUsed);
  } catch (e) {
    // 唯一出口：所有连接 / 握手 / 认证 / 协议错误都在这里盖章（见上方 markUserFacing）
    throw markUserFacing(e);
  } finally {
    await s.quit().catch(() => {});
  }
}

/**
 * 发一封信。
 *
 * @param {object} opts `{ host, port, secure, user, password, from, fromName, to, subject, text, timeoutMs }`
 * @returns {Promise<{ok: boolean, encrypted: boolean, authUsed: string}>}
 * @throws {Error} 配置问题带 `status = 400`；网络 / 协议错误为 500（由 `apiHandler` 落地）
 */
async function sendMail(opts) {
  const o = normalizeOptions(opts);
  const problem = validateForSend(o);
  if (problem) throw configError(problem);
  return withSession(o, async (s, authUsed) => {
    await s.send(buildMessage(o));
    return { ok: true, encrypted: s.encrypted, authUsed };
  });
}

/**
 * **发信前置探针**：只验证「连得上 + 握得了手 + 认得了证」，**不投递任何邮件**。
 *
 * ## 为什么需要它
 *
 * 系统自动发信（验证码 / 重置密码）失败时，`/auth/forgot` 只能**静默**处理
 * （响应恒真，否则响应差异本身就是一条账户存在性 oracle）。代价是
 * 「SMTP 配置看着全对，可一封邮件也收不到」时用户拿不到任何线索 ——
 * 实测过两次这种工单。本函数把失败里**与标识无关的那一部分**
 * （主机 / 端口 / 加密方式 / 登录口令 → 连不上、STARTTLS 未宣告、认证被拒、
 * 地址或口令组合不合法）提前暴露出来，供调用方如实回 503。
 *
 * ⚠️ 它**不校验收件人**（探针不发信），其余判据与 `sendMail()` 逐字共用
 * （`validateForSend(o, { requireTo: false })`）—— 否则会出现「探针说健康、
 * 真发却判 400」的新一重静默失败。
 */
async function verify(opts) {
  const o = normalizeOptions(opts);
  const problem = validateForSend(o, { requireTo: false });
  if (problem) throw configError(problem);
  return withSession(o, async (s, authUsed) => (
    { ok: true, encrypted: s.encrypted, authUsed }
  ));
}

module.exports = {
  sendMail, verify, DEFAULT_TIMEOUT_MS, CODE, buildMessage, dotStuff, encodedWord,
  // R78：信头字段的收敛点 —— 单独导出是为了让「CRLF 不得进信头」这条判据
  // 能在不真连 SMTP 服务器的前提下被钉住（见 tests/audit78-regressions.test.js）
  normalizeOptions,
};
