/**
 * 服务端点安全校验（SEC-03：防盲 SSRF 与凭据明文外发）
 *
 * 背景：自定义 `endpoint` 会直接决定服务端把凭据发往哪里。旧实现对它只做了
 * `/^https?:\/\//i` 判断 —— **不校验主机、不强制 HTTPS、不限制私网段**，
 * 于是 `{"endpoint":"http://169.254.169.254/latest/meta-data/"}` 就能让本服务
 * 替请求方去访问云平台实例元数据端点（IMDSv1 下可换取实例凭据），
 * 也可用于内网端口扫描（错误被分类化包装 → 属盲 SSRF）。
 *
 * 策略（默认从严，可用环境变量显式放开内网调试场景）：
 *  - 仅接受 http / https 协议；
 *  - **回环地址**（127.0.0.1 / localhost / ::1）默认拒绝，需 `ALLOW_LOOPBACK_ENDPOINT=1`；
 *  - **内部/链路本地/保留 IP 字面量**默认拒绝，需 `ALLOW_PRIVATE_ENDPOINT=1`；
 *  - 非回环一律要求 https（明文 http 会把访问密钥暴露在链路上）；
 *  - 云元数据专用主机名永远拒绝（不受上述开关影响）。
 *
 * 说明：**不对域名做 DNS 解析**再判定 —— 解析会引入新的解析面与 TOCTOU 问题，
 * 且内网对象存储常以内部域名暴露。因此这里只判定「IP 字面量」与元数据主机名，
 * 这是在不破坏既有内网部署前提下的务实边界。
 */

/** 允许回环端点（本地对象存储调试，如 MinIO）。默认关闭。 */
const ALLOW_LOOPBACK_ENDPOINT = String(process.env.ALLOW_LOOPBACK_ENDPOINT || '') === '1';
/** 允许内网/链路本地 IP 字面量端点（内网对象存储）。默认关闭。 */
const ALLOW_PRIVATE_ENDPOINT = String(process.env.ALLOW_PRIVATE_ENDPOINT || '') === '1';

/** 云平台实例元数据服务地址 —— 永远拒绝，不受环境变量影响 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',          // AWS / Azure / 阿里云 / 腾讯云 通用 IMDS
  'metadata.google.internal', // GCP
  'metadata.goog',
  '100.100.100.200',          // 阿里云内网元数据
  'fd00:ec2::254',            // AWS IPv6 IMDS
]);

/** 主机名是否为 IP 字面量（IPv4 点分十进制，或含冒号的 IPv6 写法） */
function isIpLiteral(host) {
  const h = String(host || '');
  if (!h) return false;
  if (h.includes(':')) return true; // IPv6 任何写法都按字面量处理
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

/** 是否为回环主机名 */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

/**
 * R27-25：用于**黑名单比对**的主机规范化 —— 去掉末尾的点。
 *
 * 尾点写法（`localhost.`、`metadata.google.internal.`）在 DNS 语义上与不带尾点是
 * **同一个名字**（尾点只是把它标成绝对 FQDN），但字符串比较不认，于是
 * `METADATA_HOSTS`（文档写明「永远拒绝，不受环境变量影响」）与回环判据都能被
 * 一个尾点绕过：实测 `assertSafeEndpoint('https://metadata.google.internal.')`
 * 旧实现直接放行、`https://localhost.` 也一样。规范化后两者都回到黑名单里。
 */
function normalizeHostForCompare(host) {
  return String(host || '').trim().toLowerCase().replace(/\.+$/, '');
}

function reject(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

/**
 * 校验并返回规范化后的端点字符串。
 *
 * @param {string} endpoint 用户/配置提供的端点（空字符串表示"用厂商默认端点"，直接放行）
 * @returns {string} 校验通过的端点（原样返回，保留可能的 path 前缀）
 * @throws {Error} status=400 的校验失败错误
 */
function assertSafeEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return ''; // 未自定义端点 → 由 providers.endpointFor() 决定，无需校验

  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw reject('服务端点格式不正确，应为形如 https://s3.example.com 的完整地址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw reject('服务端点仅支持 http / https 协议');
  }

  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw reject('服务端点缺少主机名');
  const hostKey = normalizeHostForCompare(host); // R27-25：去尾点后再比对黑名单

  // ① 云元数据地址：最高优先级，无条件拒绝
  if (METADATA_HOSTS.has(hostKey)) {
    throw reject('该地址属于云平台实例元数据服务，禁止作为服务端点');
  }

  // ② 回环地址
  if (isLoopbackHost(hostKey)) {
    if (!ALLOW_LOOPBACK_ENDPOINT) {
      throw reject('服务端点不能指向本机回环地址（如确需本地对象存储调试，请设置环境变量 ALLOW_LOOPBACK_ENDPOINT=1）');
    }
    return raw;
  }

  // ③ 非回环一律要求 HTTPS —— 否则访问密钥会以明文暴露在链路上
  if (u.protocol === 'http:') {
    throw reject('服务端点必须使用 https://（明文 http 会让访问密钥暴露在链路上）');
  }

  // ④ 私网 / 链路本地 / 保留 IP 字面量
  if (isIpLiteral(host)) {
    // 懒加载避免与 ip-guard 形成循环依赖
    const ipGuard = require('./ip-guard');
    if (ipGuard.isPrivateIP(host) && !ALLOW_PRIVATE_ENDPOINT) {
      throw reject('服务端点不能指向内网 / 链路本地 / 保留地址（如确需内网对象存储，请设置环境变量 ALLOW_PRIVATE_ENDPOINT=1）');
    }
  }

  return raw;
}

/**
 * R69：在同步校验之上补一次**域名解析**复核（保存端点时调用）。
 *
 * 同步那层只判 IP 字面量与元数据主机名，这是刻意的边界（内网对象存储常用内部域名）。
 * 但它留下一个缺口：`https://s3.attacker.example` 保存时解析到公网，之后（或靠 DNS
 * 轮询）解析到 `169.254.169.254` / 内网地址，全程都能通过 —— 服务端随后会带着真实
 * 云密钥连过去。这里在保存时解析一次并复判，把「域名指向内网」这一类挡在落库之前。
 *
 * 语义上与同步版**同级**（不是新增一档更严的策略）：
 *  · 回环 / 私网 / 链路本地仍受 `ALLOW_LOOPBACK_ENDPOINT` / `ALLOW_PRIVATE_ENDPOINT` 控制；
 *  · 解析失败**放行**（离线部署 / 内网 DNS 保存时不可达是常态，提前拒绝会让人配不进去；
 *    真要连的时候连不上，那是另一码事）；
 *  · 任一解析结果落在禁止段即整条拒绝 —— 多 A 记录里混一个内网地址就够做轮询绕过。
 *
 * ⚠️ 这**不是** TOCTOU 的终结：连接时 DNS 仍可能变。它的价值是把"保存即指向内网"
 * 这条最省事的路径堵死；彻底的修法是连接期复判（需要把 DNS 解析下沉到出站客户端）。
 *
 * @returns {Promise<string>} 与同步版相同的"原样返回"
 */
async function assertSafeEndpointResolved(endpoint) {
  const raw = assertSafeEndpoint(endpoint);
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch (e) { return raw; }
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!host || isIpLiteral(host)) return raw; // 字面量已由同步版判过
  if (normalizeHostForCompare(host) === 'localhost') return raw;

  let addrs = [];
  try {
    const dns = require('dns');
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    return raw; // 解析不了 → 保持同步版的结论（见函数头第 2 条）
  }
  const ipGuard = require('./ip-guard');
  for (const a of addrs) {
    const ip = String((a && a.address) || '');
    if (!ip) continue;
    if (METADATA_HOSTS.has(ip)) {
      throw reject(`服务端点域名 ${host} 解析到了云平台实例元数据地址，禁止使用`);
    }
    if (isLoopbackHost(ip) && !ALLOW_LOOPBACK_ENDPOINT) {
      throw reject(`服务端点域名 ${host} 解析到了本机回环地址（如确需本地对象存储调试，请设置 ALLOW_LOOPBACK_ENDPOINT=1）`);
    }
    if (ipGuard.isPrivateIP(ip) && !ALLOW_PRIVATE_ENDPOINT) {
      throw reject(`服务端点域名 ${host} 解析到了内网 / 链路本地 / 保留地址（如确需内网对象存储，请设置 ALLOW_PRIVATE_ENDPOINT=1）`);
    }
  }
  return raw;
}

module.exports = {
  assertSafeEndpoint,
  assertSafeEndpointResolved,
  isIpLiteral,
  isLoopbackHost,
  normalizeHostForCompare, // R27-25：黑名单比对前的唯一规范化点
  ALLOW_LOOPBACK_ENDPOINT,
  ALLOW_PRIVATE_ENDPOINT,
  METADATA_HOSTS,
};
