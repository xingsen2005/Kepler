/**
 * 真实支付网关适配器（零依赖，基于 Node 内置 crypto + 全局 fetch）
 *
 * 支持三个渠道，各自选用**最适合 PC 浏览器场景**的下单方式：
 *   alipay  电脑网站支付 alipay.trade.page.pay → 跳转支付宝收银台（无需二维码）
 *   wechat  Native 支付 APIv3 → 返回 code_url，由自研 qrcode.js 渲染二维码
 *   paypal  Orders v2 → 跳转 PayPal 审批页，回调后再 capture 收款
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 关键设计：支付结果一律以「服务端主动查单」为准，不采信异步通知的内容。      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 常见做法是「收到异步通知 → 验签 → 置为已支付」。但验签要自研三套（支付宝 RSA2、
 * 微信 APIv3 平台证书、PayPal Webhook），**任一处写错都是直接的安全漏洞**：
 * 伪造一条"支付成功"通知就能白嫖文件，且这类漏洞在开发期完全测不出来。
 *
 * 改成：通知/回跳只当作"去查一下"的触发信号，真正的判定由服务端**主动调用网关查单**，
 * 结果来自我们与网关之间的 TLS 连接，不依赖对通知内容的信任。
 * 代价是每个渠道多一个查单接口，换来的是「宁可慢一点确认，也绝不被伪造」。
 *
 * 安全约定：
 *  - **PayPal / 微信为固定官方域名**（本文件内常量，不可配置）；支付宝网关地址
 *    来自支付设置里的 `gateway` 字段，**保存时已经 `assertSafeEndpoint()` 校验**
 *    （拒回环 / 内网 / 云元数据，见 `payment-providers.js` 的 httpsUrl 校验器）。
 *    因此这里可以放心直接使用 `cfg.gateway`，但仍不得新增"绕过校验的取址路径"。
 *  - 全部请求带超时（默认 10 秒），失败一律当作"未确认"，绝不乐观置为已支付
 *  - 私钥只进本模块，绝不写日志、绝不回传前端
 */
'use strict';

const crypto = require('crypto');
const qrcode = require('./qrcode');
// 密钥结构判定（PEM / 裸 Base64 / PKCS#1 / PKCS#8）的**唯一实现点**，保存校验器共用
const pemKey = require('./pem-key');

const TIMEOUT_MS = 10000;
/**
 * R81：「用户正盯着屏幕等」的那一次下单，**整体**只给 9 秒。
 *
 * 单次出站 10 秒（`TIMEOUT_MS`）是给「查单」这种后台动作定的 —— 没人盯着。
 * 但下单不同：PayPal 的下单是**两次**串行出站（取 token + 建单），各自 10 秒就是
 * 20 秒，而付费页的提交看门狗只等 12 秒（`public/js/pay-poll.js` 的
 * `SUBMIT_TIMEOUT_MS`）⇒ 必然出现「服务端还在等网关、前端已经宣布没收到响应」。
 * 9 秒 < 12 秒，服务端总能先给出结论（成功跳转 / 明确失败原因）。
 */
const CHARGE_TIMEOUT_MS = 9000;
const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const WECHAT_HOST = 'https://api.mch.weixin.qq.com';

/** PayPal 的沙箱 / 生产域名（凭证不通用，由配置里的 mode 决定） */
function paypalHost(mode) {
  return String(mode || '').toLowerCase() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/** PEM 包裹：每 64 字符折行，与各家控制台导出 / openssl 输出的形态一致 */
function wrapPem(label, body) {
  const wrapped = String(body).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

/**
 * 私钥归一化：PEM 原样返回；裸 Base64 体则**先认 ASN.1 结构，再补 PEM 头**。
 *
 * ⚠️ 这里曾经只做一件事：给裸 Base64 一律补 `-----BEGIN PRIVATE KEY-----`（PKCS#8）。
 * 而 PKCS#1（`RSA PRIVATE KEY`）与 PKCS#8 的裸 Base64 体**都以 `MIIE` 开头**
 * —— PKCS#8 是 `MIIE…IBADANBgkq`（算法标识紧跟在版本号后），PKCS#1 是
 * `MIIE…IBAAKCgQEA`（版本号后直接是模数）—— 只看前缀根本分不出来。于是从
 * 支付宝「密钥工具」或 `openssl rsa -traditional` 导出的 PKCS#1 私钥会被硬套成
 * PKCS#8 头，OpenSSL 在**解码阶段**就失败，报
 * `error:1E08010C:DECODER routines::unsupported`。这条报错发生在本地签名，
 * 请求**根本没发出去**，所以现场看起来像"网关拒签"，实际是密钥格式没对上。
 *
 * 现在交给 `pem-key.js`（**唯一实现点**，保存校验器用的是同一份判据）真解析：
 * 把密钥体当 DER，依次按 PKCS#8 / PKCS#1 / SEC1 解一遍，任一成功即采用。
 *
 * 解不出来时**退回旧行为**（按 PKCS#8 补头）—— 那说明粘贴的内容本身不是密钥
 * （被截断 / 混进了公钥），让失败留在签名那一刻，由 OpenSSL 给出确切原因；
 * 这里猜一句"格式不对"只会把有用的报错吞掉。
 */
function normalizePrivateKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/-----BEGIN/.test(s)) return s;
  const body = s.replace(/[\s\r\n]/g, '');
  const parsed = pemKey.normalizePrivateKey(s);
  if (parsed) return parsed;
  return wrapPem('PRIVATE KEY', body);
}

function rsaSign(content, privateKey, signType) {
  const algo = String(signType || 'RSA2').toUpperCase() === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  return crypto.createSign(algo).update(content, 'utf8').sign(normalizePrivateKey(privateKey), 'base64');
}

/**
 * 与 `normalizePrivateKey` 对称：裸 Base64 按结构识别后包裹。
 *
 * 支付宝公钥是 X.509 SubjectPublicKeyInfo（裸体以 `MIIBI` 开头），但 openssl 也能
 * 导出 PKCS#1 的 `RSA PUBLIC KEY`（裸体 `MIIBCgKCAQEA…`）。只认 SPKI 的话，后者
 * 会被补上错误的 PEM 头，验签恒失败 —— 与上面私钥那一半是同一个缺陷的两种表现。
 */
function normalizePublicKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/-----BEGIN/.test(s)) return s;
  const body = s.replace(/[\s\r\n]/g, '');
  const parsed = pemKey.normalizePublicKey(s);
  if (parsed) return parsed;
  return wrapPem('PUBLIC KEY', body);
}

/**
 * 校验支付宝异步通知/响应签名（SEC-03）
 *
 * 这里是 rsaSign 的镜像，用于**确认通知确实来自支付宝**：没有它，任何人在
 * 知道回调地址后都能 POST 一条假通知，逼本系统用真实商户凭据去向网关查单
 * （查单配额消耗、日志污染，极端情况下把商户查单接口刷到限流）。
 *
 * 待签串存在两个历史变体 —— 支付宝官方 SDK 的 V1 只剔除 `sign`，V2 还会额外
 * 剔除 `sign_type`。两个变体都试一遍：能通过其一即视为验签通过。
 * 这不构成安全削弱（攻击者仍必须持有应用私钥），只是为了兼容两种 SDK 版本。
 *
 * @param {object} params 通知参数（含 sign）
 * @param {string} publicKey 支付宝公钥（PEM 或裸 Base64）
 * @param {string} [signType] RSA2（默认）| RSA；SM2 无法在本地验签，一律返回 false
 * @returns {boolean}
 */
function alipayVerify(params, publicKey, signType) {
  const p = params && typeof params === 'object' ? params : {};
  const sign = String(p.sign || '');
  const key = normalizePublicKey(publicKey);
  if (!sign || !key) return false;
  const st = String(signType || (p.sign_type) || 'RSA2').toUpperCase();
  if (st === 'SM2') return false; // 国密需 SM2 实现，本地不具备 —— 明确拒绝而非放行
  const algo = st === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  const withoutType = Object.assign({}, p);
  delete withoutType.sign_type;
  const variants = [alipaySignPayload(p), alipaySignPayload(withoutType)];
  for (const content of new Set(variants)) {
    if (!content) continue;
    try {
      if (crypto.createVerify(algo).update(content, 'utf8').verify(key, sign, 'base64')) return true;
    } catch (e) { /* 换下一个变体继续 */ }
  }
  return false;
}

/* ============================ 支付宝 ============================ */

/**
 * 待签名串：参数按 key 升序，剔除 sign 本身与空值，k=v 用 & 连接（值**不做** URL 编码）。
 * 导出以便行为测试直接驱动 —— 这里的排序与过滤规则错一格，签名就永远对不上。
 */
function alipaySignPayload(params) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  return keys.map((k) => `${k}=${params[k]}`).join('&');
}

/**
 * 网关地址归一化（R80）：去掉片段、去掉空白。
 *
 * 「网关地址」是管理员手填的输入框，粘贴时常带上行尾空白或一个 `#`（有人习惯
 * 从文档里连带拷贝锚点）。而 `alipayBuildUrl` 是在地址**尾部**接查询串的：
 * 一旦 base 里带 `#`，`?app_id=…&sign=…` 就整串落进**片段**里 —— 浏览器不会把片段
 * 发给服务器，支付宝收到的是一个**没有任何参数**的请求，回一个空白/参数错误页。
 * 用户看到的是「点了立即支付，跳过去一片空白」，而服务端日志一切正常。
 * 片段在网关地址里没有任何语义，直接剥掉。
 */
function gatewayBase(raw) {
  const s = String(raw == null ? '' : raw).trim() || ALIPAY_GATEWAY;
  return s.split('#')[0].trim();
}

/** 组装支付宝网关跳转 URL（含 sign） */
function alipayBuildUrl(gateway, params, privateKey, signType) {
  const payload = alipaySignPayload(params);
  const sign = rsaSign(payload, privateKey, signType);
  const all = Object.assign({}, params, { sign });
  const query = Object.keys(all)
    .filter((k) => all[k] !== undefined && all[k] !== null && all[k] !== '')
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  const base = gatewayBase(gateway);
  return base + (base.includes('?') ? '&' : '?') + query;
}

/**
 * 签名算法归一化（R80）。
 *
 * `rsaSign()` 只有两档：`RSA` → SHA1，其余一律 SHA256。于是配置里选 **SM2（国密）**
 * 时会出现「URL 写着 `sign_type=SM2`、签名却是 RSA-SHA256」—— 支付宝必然回
 * `ILLEGAL_SIGN`，而本系统这边**本地一切成功**：订单建好了、跳转也发生了。
 * 使用者看到的只是「点完跳到支付宝，报了个错」，无从判断是配置问题。
 *
 * 因此这里在下单**之前**就明确拒绝，并把「改哪里」说出来。查单侧 `alipayVerify()`
 * 对 SM2 早已是同一种态度（本地无法验签 → 明确 false），两处口径就此一致。
 */
const ALIPAY_SIGN_TYPES = ['RSA2', 'RSA'];
function alipaySignType(raw) {
  const st = String(raw == null ? '' : raw).trim().toUpperCase() || 'RSA2';
  if (ALIPAY_SIGN_TYPES.indexOf(st) < 0) {
    throw new Error(`签名算法「${st}」本系统暂不支持（只有 RSA2 / RSA 两种），`
      + '请在「系统设置 → 支付设置 → 支付宝」把签名算法改为 RSA2 后重试');
  }
  return st;
}

function alipayTimestamp() {
  // 支付宝要求 yyyy-MM-dd HH:mm:ss，且时区与北京时间一致
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function alipayCreate(cfg, { order, subject, returnUrl, notifyUrl }) {
  // 先归一化签名算法：非 RSA2/RSA 在这里就抛，页面会显示「创建支付订单失败：…」，
  // 而不是带着一个必然被网关拒绝的 sign_type 跳过去（见 alipaySignType）。
  const signType = alipaySignType(cfg.signType);
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: signType,
    timestamp: alipayTimestamp(),
    version: '1.0',
    return_url: returnUrl,
    notify_url: notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.id,
      total_amount: (order.amountFen / 100).toFixed(2),
      subject: subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  };
  if (cfg.appCertSn) params.app_cert_sn = cfg.appCertSn;
  if (cfg.rootCertSn) params.alipay_root_cert_sn = cfg.rootCertSn;
  const url = alipayBuildUrl(cfg.gateway, params, cfg.privateKey, signType);
  return { kind: 'redirect', url, tradeNo: '' };
}

/**
 * 审计 I-5：查单结果的**金额复核**（纵深防御）。
 *
 * 「只要网关说 paid 就发货」缺一道对账：订单金额是服务端算的，但**到账金额**从来没被
 * 校验过。当前三家网关的 `out_trade_no` 绑定了金额，所以少付并不可达 —— 这是纵深缺口，
 * 不是可利用漏洞。但缺口一旦成立后果极重（付 0.01 元拿走 100 元的文件），值得提前堵。
 *
 * 口径：按「分」比较，容忍 ±1 分（不同网关的取整/四舍五入差异）。
 *  · `order.amountFen` 缺失（老订单/内部调用）⇒ 无法比对，**跳过**（不误伤）；
 *  · 网关响应里读不到金额 ⇒ **不放行**（fail-closed：宁可让人工核对，也不凭空发货）。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
const AMOUNT_TOLERANCE_FEN = 1;

/**
 * 元 → 分；非法输入返回 NaN（不要用 0 兜底：0 会被当成"实付 0 元"而误判不符）
 *
 * ⚠️ 空值必须显式挡在 `Number()` **之前**：`Number('')` / `Number('  ')` 都是 **0**、
 * `Number(null)` 也是 0，只有 `Number('abc')` 才给 NaN。旧实现只做了后者，
 * 于是「网关响应里读不到金额」会被当成**实付 0 元**，文案写成
 * 「支付金额与订单金额不一致（实付 0.00，应付 5.00）」—— 方向仍是 fail-closed
 * （不会误放行），但把管理员引向「是不是真少收了钱」，而真相是「响应里根本没有金额」。
 */
function fenFromYuan(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (s === '') return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function checkPaidAmount(order, actualFen, actualLabel) {
  const want = Number(order && order.amountFen);
  if (!Number.isFinite(want) || want <= 0) return { ok: true }; // 无应付额可对 ⇒ 跳过
  const got = Number(actualFen);
  if (!Number.isFinite(got)) {
    return { ok: false, reason: '无法从网关响应中确认实付金额，已中止自动确认，请人工核对' };
  }
  if (Math.abs(want - got) > AMOUNT_TOLERANCE_FEN) {
    return {
      ok: false,
      reason: `支付金额与订单金额不一致（实付 ${actualLabel || (got / 100).toFixed(2)}，`
        + `应付 ${(want / 100).toFixed(2)}），已中止自动确认`,
    };
  }
  return { ok: true };
}

/**
 * 从支付宝**同步响应原文**里取出 `<key>` 节点的原始子串（大括号配对）。
 *
 * 为什么对着原文切、而不是 `JSON.parse` 后 `JSON.stringify(node)`：
 * 支付宝的同步响应签名是对 `alipay_trade_query_response` 这段 JSON 的**原始字节**
 * 做的。重新序列化会变 —— 数字被重新格式化（`5.00` → `5`）、`\uXXXX` 被解码成字符、
 * 键序可能不同 —— 任意一个字节不同，签名就恒定对不上。
 * 所以这里按「跳过字符串字面量 + 配对大括号」从原文里切，保证逐字节一致。
 */
function alipayRawNode(raw, key) {
  const s = String(raw == null ? '' : raw);
  const marker = `"${key}":`;
  const at = s.indexOf(marker);
  if (at < 0) return '';
  let i = at + marker.length;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (s[i] !== '{') return '';
  const start = i;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

/**
 * 校验支付宝**同步响应**（查单等）的签名 —— R21-04 的闭合点。
 *
 * ⚠️ 绝不能复用 `alipayVerify()`：那个是给**异步通知**用的，待签串是
 * 「参数按 key 升序、`k=v` 用 `&` 连接」；同步响应签的是**原始 JSON 子串**。
 * 两种口径完全不同，拿通知那套来验响应会**恒定失败**（把所有真实支付判成失败）。
 *
 * 为什么必须验：查单是「支付结果判定的唯一入口」，而**支付宝网关地址是管理员手填**的。
 * 地址一旦填错/被诱导成恶意站点（能通过「https + 非内网」这层校验），对方返回一条
 * 金额相符的 `TRADE_SUCCESS` 就能让订单变 `paid` —— 用户一分钱没付。金额对账（I-5）
 * 拦得住「金额不同」，拦不住「金额相同的伪造成功」。微信/PayPal 的主机名是代码内的
 * 常量，不受这一条影响。
 *
 * @returns {boolean} 验不过一律 false（调用方按 `state:'error'` 处理，fail-closed）
 */
function alipayVerifySync(raw, json, cfg) {
  const sign = String((json && json.sign) || '').trim();
  const key = normalizePublicKey(cfg && cfg.alipayPublicKey);
  if (!sign || !key) return false;
  const content = alipayRawNode(raw, 'alipay_trade_query_response');
  if (!content) return false;
  const st = String((cfg && cfg.signType) || (json && json.sign_type) || 'RSA2').toUpperCase();
  if (st === 'SM2') return false; // 国密需 SM2 实现，本地不具备 —— 明确拒绝而非放行
  const algo = st === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  try {
    return crypto.createVerify(algo).update(content, 'utf8').verify(key, sign, 'base64');
  } catch (e) {
    return false;
  }
}

async function alipayQuery(cfg, order) {
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.query',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: cfg.signType || 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: order.id }),
  };
  const url = alipayBuildUrl(cfg.gateway || ALIPAY_GATEWAY, params, cfg.privateKey, cfg.signType);
  // M-1：取**原文**（text），验签必须对着原始字节；解析失败按「无法识别」处理
  const r = await fetchWithTimeout(url, undefined, 'text');
  const raw = String(r.body == null ? '' : r.body);
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
  const node = json && json.alipay_trade_query_response;
  if (!node) return { paid: false, state: 'error', tradeNo: '', failReason: '支付宝返回内容无法识别' };
  /**
   * 验签在**读任何业务字段之前**。顺序很重要：先看 `trade_status` 再看签名，
   * 就等于先相信了不可信的输入（"检查前先使用"）。
   */
  if (!alipayVerifySync(raw, json, cfg)) {
    return {
      paid: false, state: 'error', tradeNo: '',
      failReason: '支付宝响应签名校验失败：无法确认这条响应来自支付宝。'
        + '请检查「支付设置 → 支付宝」里的**支付宝公钥**是否为开放平台上该应用的支付宝公钥'
        + '（不是应用公钥、也不是应用私钥），以及网关地址是否为 https://openapi.alipay.com/gateway.do',
    };
  }
  if (node.code !== '10000') {
    // 交易不存在（还未在支付宝侧创建）也算未支付，不该报成错误
    if (node.sub_code === 'ACQ.TRADE_NOT_EXIST') return { paid: false, state: 'pending', tradeNo: '', failReason: '' };
    return { paid: false, state: 'error', tradeNo: '', failReason: `${node.sub_msg || node.msg || '查询失败'}` };
  }
  const st = node.trade_status;
  if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
    // I-5：先对账再认账（total_amount 是「元」字符串）
    const amt = checkPaidAmount(order, fenFromYuan(node.total_amount), node.total_amount);
    if (!amt.ok) return { paid: false, state: 'error', tradeNo: node.trade_no || '', failReason: amt.reason };
    return { paid: true, state: 'paid', tradeNo: node.trade_no || '', failReason: '' };
  }
  if (st === 'TRADE_CLOSED') return { paid: false, state: 'failed', tradeNo: node.trade_no || '', failReason: '交易已关闭' };
  return { paid: false, state: 'pending', tradeNo: node.trade_no || '', failReason: '' };
}

/* ============================ 微信支付（APIv3） ============================ */

/**
 * APIv3 待签名串：`方法\n路径\n时间戳\n随机串\n报文主体\n`
 * 注意 **GET 请求也要带最后的换行**（主体为空串），漏掉会恒定 401。
 */
function wechatSignPayload(method, canonicalUrl, timestamp, nonce, body) {
  return `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body || ''}\n`;
}

/** 组装 Authorization 头：WECHATPAY2-SHA256-RSA2048 mchid="",nonce_str="",signature="",timestamp="",serial_no="" */
function wechatAuthorization(method, canonicalUrl, body, cfg, { timestamp, nonce }) {
  const payload = wechatSignPayload(method, canonicalUrl, timestamp, nonce, body);
  const signature = rsaSign(payload, cfg.privateKey, 'RSA2');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",`
    + `signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.certSerialNo}"`;
}

async function wechatRequest(method, path, cfg, body, deadline) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const raw = body === undefined || body === null ? '' : JSON.stringify(body);
  const headers = {
    // R8-01：签名函数是五参数（…, body, cfg, {timestamp, nonce}）。旧实现漏传 body，
    // 实参整体左移一位 → cfg 收到 body、第五参解构 undefined → 每次调用必抛 TypeError。
    // 微信渠道的下单与查单都经过这里，因此该渠道此前 100% 不可用。
    Authorization: wechatAuthorization(method, path, raw, cfg, { timestamp, nonce }),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 's3-manager',
  };
  if (cfg.subMchId) headers['Wechatpay-Serial'] = cfg.certSerialNo;
  const r = await fetchWithTimeout(WECHAT_HOST + path, {
    method,
    headers,
    body: method === 'GET' ? undefined : raw,
  }, 'text', deadline);
  const text = r.body == null ? '' : String(r.body);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.detail)) || text || `HTTP ${r.status}`;
    throw new Error(String(msg).slice(0, 300));
  }
  return json || {};
}

async function wechatCreate(cfg, { order, subject, notifyUrl }, deadline) {
  const payload = {
    appid: cfg.appId,
    mchid: cfg.mchId,
    description: subject,
    out_trade_no: order.id,
    notify_url: notifyUrl,
    amount: { total: Number(order.amountFen), currency: 'CNY' },
  };
  if (cfg.subMchId) { payload.sub_mchid = cfg.subMchId; if (cfg.subAppId) payload.sub_appid = cfg.subAppId; }
  const r = await wechatRequest('POST', '/v3/pay/transactions/native', cfg, payload, deadline);
  const codeUrl = r.code_url;
  if (!codeUrl) throw new Error('微信支付未返回 code_url');
  return { kind: 'qrcode', url: '', codeUrl, svg: qrcode.toSvg(codeUrl, { scale: 6, margin: 3 }), tradeNo: '' };
}

/**
 * 解密微信支付通知里的 resource（AES-256-GCM，密钥即 APIv3 密钥）。
 *
 * 只用于**从通知里取出订单号**去定位订单，解密结果不参与"是否已支付"的判定
 * —— 判定仍然由随后的主动查单给出。所以即使这里的实现有偏差，
 * 最坏结果是"通知没能触发查单"，而不会造成误判已支付。
 */
function wechatDecryptResource(apiV3Key, resource) {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  if (key.length !== 32) throw new Error('APIv3 密钥长度不是 32 字节，无法解密通知');
  const buf = Buffer.from(String((resource && resource.ciphertext) || ''), 'base64');
  if (buf.length <= 16) throw new Error('通知密文长度不足');
  const iv = Buffer.from(String((resource && resource.nonce) || ''), 'utf8');
  const aad = Buffer.from(String((resource && resource.associated_data) || ''), 'utf8');
  const tag = buf.slice(buf.length - 16);
  const data = buf.slice(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function wechatQuery(cfg, order) {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}?mchid=${encodeURIComponent(cfg.mchId)}`;
  const r = await wechatRequest('GET', path, cfg);
  const st = r.trade_state;
  const tradeNo = r.transaction_id || '';
  if (st === 'SUCCESS') {
    // I-5：微信以「分」回 total，直接比对（币种不符也视为对账失败）
    const currency = (r.amount && r.amount.currency) || '';
    if (currency && currency !== 'CNY') {
      return { paid: false, state: 'error', tradeNo, failReason: `支付币种不符（${currency}）` };
    }
    const amt = checkPaidAmount(order, r.amount && r.amount.total,
      r.amount && Number.isFinite(Number(r.amount.total)) ? `${(Number(r.amount.total) / 100).toFixed(2)} 元` : '');
    if (!amt.ok) return { paid: false, state: 'error', tradeNo, failReason: amt.reason };
    return { paid: true, state: 'paid', tradeNo, failReason: '' };
  }
  if (st === 'CLOSED' || st === 'PAYERROR' || st === 'REVOKED') {
    return { paid: false, state: 'failed', tradeNo, failReason: '交易已关闭或支付失败' };
  }
  return { paid: false, state: 'pending', tradeNo, failReason: '' };
}

/* ============================ PayPal ============================ */

function paypalBasic(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

async function paypalToken(cfg, deadline) {
  const r = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: paypalBasic(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 'json', deadline);
  const json = r.body;
  if (!r.ok || !json || !json.access_token) throw new Error('PayPal 获取访问令牌失败');
  return json.access_token;
}

async function paypalCreate(cfg, { order, subject, returnUrl, cancelUrl }, deadline) {
  // 两次串行出站共用同一个截止时刻：只给「取 token」10 秒、再给「建单」10 秒，
  // 前端 12 秒的看门狗必然先响（见 CHARGE_TIMEOUT_MS 的注释）
  const token = await paypalToken(cfg, deadline);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: order.id,
      description: subject.slice(0, 127),
      amount: { currency_code: order.currency || 'CNY', value: (order.amountFen / 100).toFixed(2) },
    }],
    application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW' },
  };
  const r = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'json', deadline);
  const json = r.body;
  if (!r.ok || !json || !json.id) throw new Error((json && (json.message || json.name)) || 'PayPal 创建订单失败');
  const approve = (json.links || []).find((l) => l.rel === 'approve');
  if (!approve || !approve.href) throw new Error('PayPal 未返回审批链接');
  return { kind: 'redirect', url: approve.href, tradeNo: json.id };
}

/** PayPal 的「查单」= 查询订单状态；若已获批准则顺带 capture（真正扣款） */
/**
 * 从 PayPal 订单报文里取「首笔 capture 的实付金额」（元字符串）。
 * 结构：`purchase_units[].payments.captures[].amount.value`；未 capture 时读不到。
 */
function paypalCaptureAmount(orderJson) {
  const units = (orderJson && orderJson.purchase_units) || [];
  for (const u of units) {
    const caps = (u && u.payments && u.payments.captures) || [];
    for (const c of caps) {
      const v = c && c.amount && c.amount.value;
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  }
  for (const u of units) {
    const v = u && u.amount && u.amount.value;
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

async function paypalQuery(cfg, order) {
  const id = order.tradeNo;
  if (!id) return { paid: false, state: 'pending', tradeNo: '', failReason: '' };
  const token = await paypalToken(cfg);
  const r = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 'json');
  const json = r.body;
  if (!r.ok || !json) return { paid: false, state: 'error', tradeNo: id, failReason: 'PayPal 查询订单失败' };
  const status = json.status;
  if (status === 'COMPLETED') {
    // I-5：对账（PayPal 金额是「元」字符串）
    const amt = checkPaidAmount(order, fenFromYuan(paypalCaptureAmount(json)), paypalCaptureAmount(json));
    if (!amt.ok) return { paid: false, state: 'error', tradeNo: id, failReason: amt.reason };
    return { paid: true, state: 'paid', tradeNo: id, failReason: '' };
  }
  if (status === 'VOIDED') return { paid: false, state: 'failed', tradeNo: id, failReason: '订单已作废' };
  if (status === 'APPROVED') {
    // 买家已同意，尚未扣款 —— 由我们主动 capture 完成收款
    const cap = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, 'json');
    const capJson = cap.body;
    if (cap.ok && capJson && capJson.status === 'COMPLETED') {
      const amt = checkPaidAmount(order, fenFromYuan(paypalCaptureAmount(capJson)), paypalCaptureAmount(capJson));
      if (!amt.ok) return { paid: false, state: 'error', tradeNo: id, failReason: amt.reason };
      return { paid: true, state: 'paid', tradeNo: id, failReason: '' };
    }
    const reason = (capJson && (capJson.message || capJson.name)) || '扣款未完成';
    if (capJson && capJson.status === 'PAYER_ACTION_REQUIRED') {
      return { paid: false, state: 'pending', tradeNo: id, failReason: '' };
    }
    return { paid: false, state: 'failed', tradeNo: id, failReason: String(reason).slice(0, 200) };
  }
  return { paid: false, state: 'pending', tradeNo: id, failReason: '' };
}

/**
 * R84（L-4）：PayPal 回调的事件类型白名单。
 *
 * 旧实现把 `verification_status === 'SUCCESS'` 当成唯一判据 —— 签名确实是真的，
 * 但「签名是真的」只回答「这条通知来自 PayPal」，不回答「这条通知与我要处理的事有关」。
 * 任何类型的 PayPal 事件（订阅、争议、发票……）都能触发一次**带真实商户密钥的查单**，
 * 消耗查单配额并污染日志。
 *
 * 白名单只收与「这笔订单可能已收款」直接相关的三个：订单获批（等我们去 capture）、
 * capture 完成、旧版 sale 完成。其余记日志后丢弃。
 */
const PAYPAL_EVENT_TYPES = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.SALE.COMPLETED',
]);

/**
 * 回调时间戳容许的偏移。超过只当「可疑重放」**记 warn**，不拦 —— 因为 PayPal 会在
 * 我们的端点短暂不可用时重试投递（间隔可达数分钟），把重试当伪造拦掉等于自废重试。
 * 真正的判定源始终是服务端主动查单，陈旧通知最多让我们多查一次（幂等）。
 */
const PAYPAL_TRANSMISSION_SKEW_MS = 5 * 60 * 1000;

/**
 * R84（L-4）：判定这条 PayPal 回调「该不该处理」。
 *
 * @param {object} event   回调体（`webhook_event`）
 * @param {object} headers 请求头（小写键）
 * @returns {{accept: boolean, stale: boolean, reason: string}}
 *   `accept=false` ⇒ 调用方应直接丢弃（不消耗查单配额）；
 *   `accept=true, stale=true` ⇒ 照常处理，但记一条 warn。
 */
function paypalEventCheck(event, headers) {
  const e = event && typeof event === 'object' ? event : {};
  const type = String(e.event_type || '').trim();
  if (!PAYPAL_EVENT_TYPES.has(type)) {
    return { accept: false, stale: false, reason: `不处理的事件类型 ${type || '(空)'}` };
  }
  const h = headers || {};
  const at = Date.parse(String(h['paypal-transmission-time'] || '').trim());
  if (!Number.isFinite(at)) {
    return { accept: true, stale: true, reason: '回调时间戳无法解析' };
  }
  const skew = Date.now() - at;
  if (Math.abs(skew) > PAYPAL_TRANSMISSION_SKEW_MS) {
    return {
      accept: true, stale: true,
      reason: `回调时间戳偏离当前 ${Math.round(Math.abs(skew) / 1000)} 秒`,
    };
  }
  return { accept: true, stale: false, reason: '' };
}

/**
 * R69：PayPal 回调验签 —— 官方验签 API（`/v1/notifications/verify-webhook-signature`）。
 *
 * 本地无法离线验签（签名用 PayPal 的证书链与私钥），只能回源问一次。代价是每个回调
 * 多两次出站请求（取 token + 验签），换来的是「谁都能往这个端点灌伪造通知」这件事
 * 不再成立 —— 之前这一支是**零验签直接放行**的。
 *
 * 未配置 `webhookId` 时直接抛错（调用方按"验不过"丢弃）：只有这样才能避免
 * 「配置项摆在界面上、却从未被任何代码消费」的假象（旧实现正是如此）。
 *
 * @returns {Promise<boolean>} 验签通过与否
 */
async function paypalVerifyWebhook(cfg, headers, event) {
  const webhookId = String((cfg && cfg.webhookId) || '').trim();
  if (!webhookId) throw new Error('未配置 Webhook ID，无法验签');
  const h = headers || {};
  const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  for (const k of need) {
    if (!String(h[k] || '').trim()) throw new Error(`回调缺少签名头 ${k}`);
  }
  const token = await paypalToken(cfg);
  const r = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: String(h['paypal-auth-algo']),
      cert_url: String(h['paypal-cert-url']),
      transmission_id: String(h['paypal-transmission-id']),
      transmission_sig: String(h['paypal-transmission-sig']),
      transmission_time: String(h['paypal-transmission-time']),
      webhook_id: webhookId,
      webhook_event: event,
    }),
  }, 'json');
  const json = r.body;
  if (!r.ok || !json) throw new Error('PayPal 验签接口请求失败');
  return json.verification_status === 'SUCCESS';
}

/* ============================ 统一入口 ============================ */

/** 从 URL 里取主机名，只用于错误文案（不含路径/查询串，绝不回显任何密钥） */
function hostOf(url) {
  try { return new URL(String(url)).host; } catch (e) { return '支付网关'; }
}

/**
 * 出站请求：**超时必须是整体的**（连接 + 响应头 + 响应体）。
 *
 * ⚠️ 这里踩过一次「前端说没收到响应、后端订单停在『支付中』」的坑，成因见下。
 *
 * 旧实现把 `AbortController` 的计时器放在 `finally` 里 `clearTimeout`，看上去很规矩，
 * 但 `fetch()` 的 promise 是**一拿到响应头就 resolve** 的 —— `finally` 随即执行，
 * 计时器当场被清掉。于是剩下那句 `await res.text()` / `await res.json()`
 * **完全不受这个 signal 约束**，只受 undici 默认 `bodyTimeout`（**300 秒**）兜底。
 * 网关接受 TLS 连接、回了响应头、却一直不吐响应体时（出口代理吞包、中间设备半开
 * 连接、对方进程 hang 住），`createCharge` 会挂到 5 分钟。而订单在
 * `await createCharge()` **之前**就已同步落库为 pending（见 `share-routes.js` 的下单
 * 顺序）⇒ 后端显示「支付中」，前端 12 秒就看门狗收工，两边说法永远对不上。
 *
 * 现在把「读体」搬进同一段 `try`，计时器直到响应体读完才清，signal 全程有效。
 * 同时按「卡在响应头」与「卡在响应体」给两种文案 —— 现场排查时这一句就能定位。
 *
 * @param {string} url
 * @param {object} [init]     传给 `fetch` 的其它选项
 * @param {'json'|'text'|'none'} [as] 读体方式，默认 `'json'`；`'none'` 表示不关心内容
 * @param {{t:number}|null} [deadline] 上级给的**绝对**截止时刻（`Date.now() + 预算`），
 *        用于把「取 token + 建单」这类多次串行出站压进一个总预算里
 * @returns {Promise<{ok:boolean, status:number, body:any}>} `body` 为解析后的 JSON / 原始文本 / `null`
 */
async function fetchWithTimeout(url, init, as, deadline) {
  const mode = as || 'json';
  const host = hostOf(url);
  const room = deadline ? deadline.t - Date.now() : TIMEOUT_MS;
  const budget = Math.min(TIMEOUT_MS, room);
  if (budget <= 0) {
    throw new Error(`下单总耗时已超过 ${Math.round(CHARGE_TIMEOUT_MS / 1000)} 秒，未再向 ${host} 发起请求`);
  }

  const ctrl = new AbortController();
  let phase = 'head'; // head = 还没拿到响应头；body = 已拿到头、正在读体
  const timer = setTimeout(() => ctrl.abort(), budget);
  const timedOut = () => new Error(phase === 'head'
    ? `网关连接超时：${budget}ms 内没有收到 ${host} 的响应头`
    : `网关读取超时：已连上 ${host} 并收到响应头，但 ${budget}ms 内没有读完响应体`);

  try {
    let res;
    try {
      /**
       * R21-12：出站**不跟随重定向**（`fetch` 默认是 `follow`）。
       *
       * 三个网关的 API 主机都是固定常量（支付宝网关 / 微信 APIv3 / PayPal），正常响应
       * 不会重定向；一旦出现 3xx，说明链路被中间人终结、或主机/配置被人改写 ——
       * 跟随它等于把「携带商户凭据的请求」发向我们从未批准过的主机。3xx 一律当错误，
       * 由 `createCharge` / `queryCharge` 按「下单失败 / 未确认」处理（fail-closed：
       * 绝不会因为一个重定向而把订单判成已支付）。
       */
      res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal, redirect: 'manual' }));
    } catch (e) {
      if (ctrl.signal.aborted) throw timedOut();
      throw e;
    }
    phase = 'body';
    if (res.status >= 300 && res.status < 400) {
      // 不跟随，但也要把连接放掉：留着未读的 body 会让 socket 一直挂着
      await cancelBody(res);
      throw new Error(`网关返回重定向（HTTP ${res.status}），已拒绝跟随（防 SSRF）`);
    }

    let body = null;
    try {
      if (mode === 'text') {
        body = await res.text();
      } else if (mode === 'json') {
        const text = await res.text();
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; } // 非 JSON 交给调用方按"无法识别"处理
      } else {
        await cancelBody(res);
      }
    } catch (e) {
      if (ctrl.signal.aborted) throw timedOut();
      throw e;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 丢弃响应体（尽力而为：连接已关闭时会抛，忽略即可） */
async function cancelBody(res) {
  if (res && res.body && typeof res.body.cancel === 'function') {
    try { await res.body.cancel(); } catch (e) { /* 已经结束 */ }
  }
}


/**
 * 下单
 * @param {string} platform alipay | wechat | paypal
 * @param {object} cfg     该平台保存的凭证
 * @param {object} opts    { order, subject, returnUrl, notifyUrl, cancelUrl }
 * @returns {Promise<{ok: boolean, kind?: string, url?: string, codeUrl?: string, svg?: string, tradeNo?: string, error?: string}>}
 */
async function createCharge(platform, cfg, opts) {
  const run = { alipay: alipayCreate, wechat: wechatCreate, paypal: paypalCreate }[platform];
  if (!run) return { ok: false, error: `未知的支付平台：${platform}` };
  /**
   * R81：整条下单链路共用**一个**截止时刻（而不是每个出站请求各 10 秒）。
   *
   * 支付宝分支不出网（纯本地签名 + 拼 URL），这个预算对它没有任何影响；
   * 微信是 1 次出站，PayPal 是「取 token + 建单」2 次串行 —— 各给 10 秒就是 20 秒，
   * 必然长过前端 12 秒的提交看门狗，于是出现「前端说没收到响应、后端其实还在等」。
   * 压到 9 秒后，服务端**一定**先给出结论，前端那句看门狗只在真·没收到任何响应时响。
   *
   * 查单（`queryCharge`）不设总预算：它在 3 秒一次的轮询里跑，没人盯着，
   * 单次 10 秒的 timeout 就够（也不该因为一次慢查单而放弃确认）。
   */
  const deadline = { t: Date.now() + CHARGE_TIMEOUT_MS };
  try {
    const r = await run(cfg, opts, deadline);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    // 网关错误信息可能含内部细节，统一截断；私钥等敏感值不会进入这里
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

/**
 * 主动查单（支付结果判定的唯一可信来源）
 * @returns {Promise<{paid: boolean, state: 'paid'|'pending'|'failed'|'error', tradeNo: string, failReason: string, error?: string}>}
 */
async function queryCharge(platform, cfg, order) {
  const run = { alipay: alipayQuery, wechat: wechatQuery, paypal: paypalQuery }[platform];
  if (!run) return { paid: false, state: 'error', tradeNo: '', failReason: `未知的支付平台：${platform}` };
  try {
    return await run(cfg, order);
  } catch (e) {
    // 查单失败一律当作"没能确认"，绝不乐观判定为已支付
    return { paid: false, state: 'error', tradeNo: '', failReason: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports = {
  TIMEOUT_MS, CHARGE_TIMEOUT_MS, ALIPAY_GATEWAY, WECHAT_HOST,
  paypalHost, normalizePrivateKey, normalizePublicKey,
  alipaySignPayload, alipayBuildUrl, alipayTimestamp, alipayVerify,
  // R84：同步响应验签（M-1）—— 导出以便直接驱动「原文切片」与「验签口径」这两处纯函数
  alipayRawNode, alipayVerifySync, fenFromYuan,
  // R84（L-1）：金额对账的文案分叉（「查不到金额」vs「金额不符」）要能被直接断言
  checkPaidAmount,
  wechatSignPayload, wechatAuthorization, wechatDecryptResource,
  paypalVerifyWebhook,
  // R84（L-4）：事件类型白名单 + 时间新鲜度判定 —— 导出以便直接驱动这三条分支
  paypalEventCheck, PAYPAL_EVENT_TYPES, PAYPAL_TRANSMISSION_SKEW_MS,
  createCharge, queryCharge,
};
