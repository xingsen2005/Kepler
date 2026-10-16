/**
 * TLS 证书加载 —— 管理界面 HTTPS 与 WebDAV 服务共用
 *
 * R49：**本模块不再生成自签名证书**，`selfsigned` 依赖随之移除。
 *
 * 为什么自签名证书没有意义：它不是「能用的 HTTPS」。
 *   · 它没有可信签发链，浏览器会把它判为不安全（NET::ERR_CERT_AUTHORITY_INVALID，
 *     必须人工点「继续访问」），告警并没有被消除；
 *   · 更关键的是**安全上下文（Secure Context）并不成立** —— WebAuthn（Windows Hello
 *     登录）、Service Worker、剪贴板、摄像头/麦克风、通知等能力都以「证书有效」为前提，
 *     所以那些「必须有 HTTPS 才能用」的功能一个也换不来；
 *   · 剩下的只是「看起来像 HTTPS」的错觉，以及一处需要长期维护的私钥文件。
 *
 * 现在只做一件事：**加载运维方自备的真实证书**。
 *   · 路径优先取 `TLS_CERT_FILE` / `TLS_KEY_FILE`；
 *   · 未设置时回退 `data/tls/fullchain.pem` 与 `data/tls/privkey.pem`；
 *   · 都没配 ⇒ 返回 `ok: false`，调用方据此**只提供 HTTP 服务**（内置 HTTPS 与
 *     WebDAV 一律不启动，并在日志/界面里说清原因与补救办法）。
 *
 * ⚠️ 本模块**任何时候都不创建、不签发、不改写任何文件** —— 这是与旧 `local-cert.js`
 * 最重要的区别（旧实现会在读取路径上就地重签，并把私钥写回 `data/local-cert.json`）。
 * 少了这条写入路径，也就顺带没有了「私钥文件权限过宽 / 弱签名证书长期沿用」那类问题。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * R12-01（同源）：状态目录必须跟随数据目录开关（唯一实现点见 data-dir.js）—— 否则测试 / 多实例场景
 * 下会去读**生产** `data/` 里的证书路径。
 */
const DATA_DIR = require('./data-dir').dataDir();

/** 证书 / 私钥路径：环境变量优先，其次 `data/tls/` 下的约定文件名。 */
function certPaths() {
  return {
    certFile: process.env.TLS_CERT_FILE || path.join(DATA_DIR, 'tls', 'fullchain.pem'),
    keyFile: process.env.TLS_KEY_FILE || path.join(DATA_DIR, 'tls', 'privkey.pem'),
  };
}

/** 供调用方在提示语里说明「该把证书放哪儿」。 */
function hintText(p) {
  return `把证书与私钥放到 ${p.certFile} 与 ${p.keyFile}，或用环境变量 TLS_CERT_FILE / TLS_KEY_FILE 指定路径`;
}

/**
 * 读取并校验证书。
 *
 * 返回 `{ ok: true, cert, key, certFile, keyFile }` 或
 *     `{ ok: false, reason, certFile, keyFile, missing }`。
 * `reason` 是**给运维看的一句中文**（日志与界面共用），不含堆栈。
 */
function loadTlsCert() {
  const p = certPaths();
  const missing = [p.certFile, p.keyFile].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    return {
      ok: false, certFile: p.certFile, keyFile: p.keyFile, missing,
      reason: `未配置 TLS 证书（缺少 ${missing.join('、')}）`,
    };
  }

  let cert;
  let key;
  try {
    cert = fs.readFileSync(p.certFile);
    key = fs.readFileSync(p.keyFile);
  } catch (e) {
    return { ok: false, certFile: p.certFile, keyFile: p.keyFile, missing: [], reason: `TLS 证书读取失败：${e.message}` };
  }

  /**
   * 立刻让 Node 校验一次：证书解析不了、私钥带口令（需要 passphrase）、证书与私钥
   * **不配对**，都在这里当场暴露。
   *
   * 为什么值得单独做一遍：`https.createServer()` 虽然也会因为不配对而抛
   * `ERR_OSSL_X509_KEY_VALUES_MISMATCH`，但那个错误发生在「已经准备监听」的位置，
   * 而且只有在那一条分支里；这里把它提前成 `ok: false`，就同时约束了三个消费方
   * （内置 HTTPS 是否监听、WebDAV 是否监听、301 跳转目标是否存在）—— 三者共用
   * **同一个**「到底能不能提供 HTTPS」的判据，不会再各判各的。
   */
  try {
    const x509 = new crypto.X509Certificate(cert);
    const priv = crypto.createPrivateKey(key);
    const spki = (k) => k.export({ type: 'spki', format: 'der' });
    if (spki(x509.publicKey).compare(spki(crypto.createPublicKey(priv))) !== 0) {
      throw new Error('证书与私钥不配对');
    }
  } catch (e) {
    return { ok: false, certFile: p.certFile, keyFile: p.keyFile, missing: [], reason: `TLS 证书不可用：${e.message}` };
  }

  return { ok: true, cert, key, certFile: p.certFile, keyFile: p.keyFile };
}

module.exports = { loadTlsCert, certPaths, hintText, DATA_DIR };
