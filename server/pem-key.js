/**
 * PEM / DER 密钥结构判定 —— **唯一实现点**
 *
 * 为什么单独成一个模块：这件事同时被两个地方需要，而它们此前各写了一份**都不解析**的
 * 近似判据，于是同一类缺陷在两处各自成立：
 *   · `payment-providers.js` 的保存校验器（`VALIDATORS.privateKey` / `publicKey`）
 *     —— 判据是「像 PEM」或「是一段够长的 Base64」，**从不真的解析**。实测：
 *     把公钥贴进私钥框、`'A'.repeat(240)`、无口令的加密私钥，全部通过校验并落盘；
 *   · `payment-gateway.js` 的 `normalizePrivateKey()` —— 裸 Base64 一律补
 *     `-----BEGIN PRIVATE KEY-----`，而 PKCS#1 与 PKCS#8 的裸体**都以 `MIIE` 开头**
 *     （PKCS#8 是 `MIIE…IBADANBgkq`，PKCS#1 是 `MIIE…IBAAKCgQEA`），前缀分不出来 ⇒
 *     PKCS#1 被套上 PKCS#8 头，OpenSSL 在解码阶段直接失败
 *     （`error:1E08010C:DECODER routines::unsupported`，请求根本没发出去）。
 *
 * 按 ADR-0006 的纪律，共用的判据必须住在能被共用的地方；分散两处就一定会再次分叉。
 *
 * ## 判定口径
 *
 * 只做两件事，都基于 Node 内置 `crypto` 的真实解析，**不做任何字符层面的猜测**：
 *  1. `decodePrivateKey()` / `decodePublicKey()` —— 把「用户粘贴的东西」解成 KeyObject。
 *     输入可以是 PEM（带 `-----BEGIN …-----` 头）或**裸 Base64 密钥体**（各家控制台
 *     「复制密钥」按钮给出的常常就是这一种）。裸体依次按该类别下所有可能的 ASN.1
 *     结构试解（私钥：PKCS#8 / PKCS#1 / SEC1；公钥：SPKI / PKCS#1），**任一成功即采用**。
 *  2. `normalizePrivateKey()` / `normalizePublicKey()` —— 解出来之后统一重新导出为
 *     **PEM**，并且私钥固定导出 PKCS#8、公钥固定导出 SPKI。下游（`createSign` /
 *     `createVerify`）因此只有一种输入形态，不必再关心用户当初粘的是哪种。
 *
 * 解不出来时**返回 null，由调用方决定说什么**：保存校验要说「这不是一把能用的 RSA
 * 私钥」，签名处则保留原始文本让 OpenSSL 报出确切原因（猜测性转述会把有用的报错吞掉）。
 *
 * ## 为什么不用「前缀 / 长度」这类快速判据
 *
 * 它们全都可被反例击穿，而且击穿方式恰好是**真实会发生的错填**：
 *  - `MIIE` 开头 ⇒ 可能是 PKCS#1，也可能是 PKCS#8（见上）；
 *  - `MIIBI` 开头 ⇒ 确实是 SPKI 公钥，但把**公钥**贴进私钥框同样满足它；
 *  - 「Base64 字符集 + 够长」 ⇒ `'A'.repeat(240)` 满足，且它有 `=` 补位、解码后是
 *    180 字节的合法长度；
 *  - 「头尾标记成对」 ⇒ `-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`
 *    满足（这是真实会发生的粘贴不全）。
 * 真实解析是唯一能同时否掉这四种的判据。
 */

'use strict';

const crypto = require('crypto');

/**
 * 取出「密钥体」并判断它原本是不是 PEM。
 *
 * `-----BEGIN …-----` 之间允许出现说明文字与空行：各平台的控制台都把密钥放在一段
 * 带提示的文本里，「整段复制」是最常见的粘贴方式。
 *
 * @param {*} raw
 * @returns {{body: string, pem: boolean, label: string, encrypted: boolean}}
 *   `pem` —— 输入本身带 PEM 头；`label` —— BEGIN 行里的标签（如 `RSA PRIVATE KEY`）；
 *   `encrypted` —— 是「加密私钥」（`ENCRYPTED PRIVATE KEY` 或带 `Proc-Type: 4,ENCRYPTED`）。
 */
function split(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { body: '', pem: false, label: '', encrypted: false };
  const m = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(s);
  if (!m) {
    // 裸 Base64：允许中间有换行 / 空格（从控制台复制时常被折行）
    return { body: s.replace(/[\s\r\n]/g, ''), pem: false, label: '', encrypted: false };
  }
  const label = m[1];
  // 只取第一个 BEGIN 到它对应的 END 之间；没有 END 时（粘贴不全）body 为空 → 解析必失败
  const begin = s.indexOf(m[0]) + m[0].length;
  const endTag = '-----END ' + label + '-----';
  const end = s.indexOf(endTag, begin);
  const body = end >= 0 ? s.slice(begin, end) : '';
  /**
   * 加密私钥的两种历史形态：
   *  · PKCS#8：`-----BEGIN ENCRYPTED PRIVATE KEY-----`（标签本身就是判据）；
   *  · 传统 PEM 头：标签仍是 `RSA PRIVATE KEY`，但头之后带 `Proc-Type: 4,ENCRYPTED`
   *    与 `DEK-Info:` 两行，我自己不持有口令，`createPrivateKey` 会要求 passphrase。
   * 两者都必须先认出来，否则用户拿到的报错是 `ERR_OSSL_…` 而不是「这把私钥有口令」。
   */
  const encrypted = label === 'ENCRYPTED PRIVATE KEY'
    || /Proc-Type:\s*4\s*,\s*ENCRYPTED/i.test(s);
  return { body: body.replace(/[\s\r\n]/g, ''), pem: true, label, encrypted };
}

/** 把 Base64 / PEM 文本还原成 DER 字节；失败返回 null（不抛错） */
function toDer(s) {
  if (!s.body) return null;
  const buf = Buffer.from(s.body, 'base64');
  // Buffer.from 对非法 Base64 会静默截断，故回验一次「编码后长度是否对得上量级」
  return buf.length >= 8 ? buf : null;
}

/**
 * 私钥的候选 ASN.1 结构。
 *
 * 支付宝「密钥生成工具」导出 PKCS#8；`openssl genrsa`（1.x / 部分 3.x 默认）与
 * `openssl rsa -traditional` 导出 PKCS#1；微信商户平台下载的 `apiclient_key.pem`
 * 是 PKCS#8。SEC1（`EC PRIVATE KEY`）列在这里只为让报错更准确 —— 它解得开但不是
 * RSA，由调用方按 `asymmetricKeyType` 拒绝。
 */
const PRIVATE_TYPES = ['pkcs8', 'pkcs1', 'sec1'];
const PUBLIC_TYPES = ['spki', 'pkcs1'];

function tryParse(kind, der, type) {
  try {
    const k = kind === 'private'
      ? crypto.createPrivateKey({ key: der, format: 'der', type })
      : crypto.createPublicKey({ key: der, format: 'der', type });
    if (!k || k.type !== kind) return null;
    return k;
  } catch (e) {
    return null;
  }
}

/**
 * 把任意输入解成 KeyObject。
 *
 * 三条路径，按顺序尝试：
 *  ① 带 PEM 头 → 直接交给 `createPrivateKey(pem)` / `createPublicKey(pem)`
 *     （OpenSSL 自己会认标签，标签与内容不符时会明确报错，这正是我们要的行为）；
 *  ② 裸 Base64 → 还原成 DER，逐个试候选 ASN.1 结构；
 *  ③ 都失败 → null。
 *
 * @param {'private'|'public'} kind
 * @param {*} raw
 * @returns {{key: crypto.KeyObject, type: string, encrypted: boolean}|null}
 *   `type` 是 `key.asymmetricKeyType`（`rsa` / `ec` / `ed25519` / `sm2`…）；
 *   `encrypted` 为 true 表示「这是一把有口令的私钥」—— 解析必然失败，但**原因不同**，
 *   调用方据此给出可执行的提示，而不是一句"格式不对"。
 */
function decodeKey(kind, raw) {
  const s = split(raw);
  const types = kind === 'private' ? PRIVATE_TYPES : PUBLIC_TYPES;
  if (s.pem) {
    if (s.encrypted) return null; // 无口令时必失败，且原因已由 split() 标出
    try {
      const k = kind === 'private'
        ? crypto.createPrivateKey(s.body ? String(raw).trim() : '')
        : crypto.createPublicKey(s.body ? String(raw).trim() : '');
      if (k && k.type === kind) return { key: k, type: k.asymmetricKeyType, encrypted: false };
    } catch (e) { /* 落到下面的裸体分支再试一次（用户可能只粘了标签 + 裸体） */ }
  }
  const der = toDer(s);
  if (!der) return null;
  for (const t of types) {
    const k = tryParse(kind, der, t);
    if (k) return { key: k, type: k.asymmetricKeyType, encrypted: false };
  }
  return null;
}

/**
 * 判断「用户粘进来的到底是什么」，返回 `{kind, type}` 或 null。
 *
 * 关键在**不对称性**：`crypto.createPrivateKey()` 只在输入确实是私钥材料时才成功，
 * 而 `crypto.createPublicKey()` 对**私钥也会成功**（OpenSSL 会顺手从中导出公钥）。
 * 所以「私钥解得开」足以证明它是私钥，「公钥解得开」**不能**证明它是公钥。
 *
 * 因此必须先试私钥，私钥失败才认定是公钥。顺序反过来（先试公钥）会把每一把私钥
 * 都判成公钥 —— 于是「把公钥贴进私钥框」与「把私钥贴进公钥框」这两种最常见的错填
 * 都会拿到「格式正确」的结论，而这正是本次要修掉的缺陷形态之一。
 *
 * @param {*} raw
 * @returns {{kind: 'private'|'public', type: string}|null}
 */
function classify(raw) {
  const priv = decodeKey('private', raw);
  if (priv) return { kind: 'private', type: priv.type };
  const pub = decodeKey('public', raw);
  if (pub) return { kind: 'public', type: pub.type };
  return null;
}

/** 解析并确认为 RSA 私钥（支付宝 / 微信都用 RSA 签名，EC / Ed25519 一律不适用） */
function decodeRsaPrivate(raw) {
  const d = decodeKey('private', raw);
  if (!d || d.type !== 'rsa') return null;
  return d.key;
}

/** 解析并确认为 RSA 公钥（`classify()` 已保证它不是私钥材料） */
function decodeRsaPublic(raw) {
  const c = classify(raw);
  if (!c || c.kind !== 'public' || c.type !== 'rsa') return null;
  const d = decodeKey('public', raw);
  return d ? d.key : null;
}

/** 导出为 PEM（私钥固定 PKCS#8、公钥固定 SPKI）；失败返回 '' */
function exportPem(kind, key) {
  if (!key) return '';
  try {
    const pem = String(key.export({ type: kind === 'private' ? 'pkcs8' : 'spki', format: 'pem' }));
    return pem.trim();
  } catch (e) {
    return '';
  }
}

/**
 * 归一化为 PEM。解不出来时返回 ''（调用方据此决定报错文案）。
 *
 * 与旧实现的差别只有一点、但正是缺陷本身：**不再凭前缀决定补哪个头**。
 * 补头这件事只发生在「裸 Base64 且结构已确认为该类密钥」之后。
 *
 * 非 RSA（EC / Ed25519 / SM2）也照样导出 —— 那是**合法密钥**，只是不适用于
 * 支付宝 RSA2 / 微信 APIv3。该由校验器按 `decodeKey().type` 明确拒绝并说清原因，
 * 而不是在这里含糊地返回空串（否则管理员只会看到"无法解析"）。
 */
function normalizePrivateKey(raw) {
  const d = decodeKey('private', raw);
  return d ? exportPem('private', d.key) : '';
}

function normalizePublicKey(raw) {
  const d = decodeKey('public', raw);
  return d ? exportPem('public', d.key) : '';
}

/**
 * 给「解不出来」这件事一个能直接照做的说法。
 *
 * 校验器由管理员在设置页直接看到，所以文案要回答「我该检查什么」，而不是复述 ORM 报错。
 * 判据顺序与真实出错频率一致：贴错框（公钥贴进私钥）> 粘贴不全 > 有口令 > 不是 RSA。
 */
function explain(kind, raw) {
  const s = split(raw);
  const what = kind === 'private' ? '私钥' : '公钥';
  if (!s.body && !s.pem) return `不是有效的${what}：内容为空`;
  if (s.encrypted) {
    return `这是一把带口令的${what}（ENCRYPTED PRIVATE KEY / Proc-Type: 4,ENCRYPTED），`
      + '本系统不会保存口令。请先解开口令再粘贴，例如：'
      + 'openssl pkcs8 -in 原文件.pem -out 无口令.pem -nodes';
  }
  /**
   * 先判定「这是哪类材料」，再分别处置。顺序不能反：
   *  · 贴错框（公钥贴进私钥框 / 反之）—— 最常见，且换框即可解决；
   *  · 类别对了但**不是 RSA**（EC / Ed25519）—— 结构合法，换密钥才行；
   *  · 两者都不是 —— 才是截断 / 乱填 / 填了别的东西。
   * 用 `classify()` 而不是单独试某一类，正是因为它区分了「公钥解得开」与
   * 「确实是公钥」（见 classify 的注释），否则 EC 私钥会被误报成「你贴了公钥」。
   */
  const c = classify(raw);
  if (c && c.kind !== kind) {
    const actual = c.kind === 'private' ? '私钥' : '公钥';
    return `这不是${what}，而是一把「${actual}」（粘贴时选错了输入框）`
      + '—— 私钥用于签名、公钥用于验签，两者不能互换';
  }
  if (c && c.type !== 'rsa') {
    return `这把${what}的结构可以解析，但类型是 ${c.type}，不是 RSA —— `
      + '支付宝 RSA2 与微信支付 APIv3 都只接受 RSA（2048 位及以上）密钥';
  }
  if (s.pem && !s.body) {
    return `PEM 不完整：只找到开头的 -----BEGIN ${s.label || what}-----，缺少成对的结尾标记。`
      + '请整段重新复制（含最后一行），注意不要丢掉折行';
  }
  return `不是有效的${what}：无法解析为 RSA ${what}。常见原因：`
    + '① 内容被截断（只复制了一部分）；② 混入了多余字符；'
    + `③ 这不是密钥（例如把 App Secret / APIv3 密钥填了进来）。`
    + `期望形态：PEM（-----BEGIN ${kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY'}-----）`
    + '或完整的 Base64 密钥体（PKCS#8 / PKCS#1 均可）';
}

module.exports = {
  split,
  decodeKey,
  classify,
  decodeRsaPrivate,
  decodeRsaPublic,
  exportPem,
  normalizePrivateKey,
  normalizePublicKey,
  explain,
  PRIVATE_TYPES,
  PUBLIC_TYPES,
};