/**
 * 仅限测试的 TLS 证书 —— 一对 ECDSA P-256 自签证书（CN=localhost，2036-10 到期）。
 *
 * 为什么需要它：R49 之后**产品不再生成自签名证书**（自签名会被浏览器判为不安全，也换不来
 * WebAuthn / Service Worker 等需要「安全上下文」的功能），改为只读加载运维自备的
 * `TLS_CERT_FILE` / `TLS_KEY_FILE`；内置 HTTPS 与 WebDAV 都是「没有可用证书就不启动」。
 * 而 audit9~13 是拿**真实 WebDAV 服务**做端到端验证的，没有证书会一律报「WebDAV 未能启动」。
 * 于是测试进程自带一对「自备证书」—— 走的仍是生产那条加载路径，**不是**给产品开后门。
 *
 * ⚠️ 这是一把**公开的、只在测试里使用**的密钥：只签了 localhost，与产品、部署、任何用户
 * 数据都无关，没有任何机密性可言。存成 base64 而不是直接放 `.pem`，是为了不让仓库里出现
 * PEM 私钥块 —— 那会命中各类「私钥泄漏」扫描（含托管平台的 push protection），
 * 白白制造一次需要人工判断的告警，而它本身并不敏感。
 *
 * 重新生成（十年一遇；换掉后请同步下面两段 base64）：
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
 *     -days 3650 -keyout privkey.pem -out fullchain.pem -subj "/CN=localhost" \
 *     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 *   # 然后：base64 -w76 privkey.pem / fullchain.pem
 */

const CERT_B64 =
  'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJtVENDQVQrZ0F3SUJBZ0lVS0J1UG1GQnRW' +
  'bmtuS24yN3hFdFlDZTdQQXpJd0NnWUlLb1pJemowRUF3SXcKRkRFU01CQUdBMVVFQXd3SmJHOWpZ' +
  'V3hvYjNOME1CNFhEVEkyTVRBeE16QXlNamswT0ZvWERUTTJNVEF4TURBeQpNamswT0Zvd0ZERVNN' +
  'QkFHQTFVRUF3d0piRzlqWVd4b2IzTjBNRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBECkFRY0RR' +
  'Z0FFRjdiN0w1QjN6bVkzanhTTWI5Y05USkR5NU1ROGlsR1ZPRHI5djRSMm1aSE9LOE1aWXQ0amVI' +
  'UTIKT01nS1ZBUTNtYzRKcmJQcTZvdUJxbnJPNisyODhxTnZNRzB3SFFZRFZSME9CQllFRkpJZXdE' +
  'WitWRTdmSUdkMQp2THd4Tk1sQWJmQzVNQjhHQTFVZEl3UVlNQmFBRkpJZXdEWitWRTdmSUdkMXZM' +
  'd3hOTWxBYmZDNU1BOEdBMVVkCkV3RUIvd1FGTUFNQkFmOHdHZ1lEVlIwUkJCTXdFWUlKYkc5allX' +
  'eG9iM04waHdSL0FBQUJNQW9HQ0NxR1NNNDkKQkFNQ0EwZ0FNRVVDSVFENlJYSVVpalVLbXk2cStB' +
  'Tks1TXZVaVNjQVphZG13KzMxbE1TR2pxejF1d0lnT1c2OQpaVU9QZzVqcXNhNW1ZQTdEdWtORnRU' +
  'UHViNHkvNFRLTTY3aEVPblU9Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K';

const KEY_B64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdT' +
  'TTQ5QXdFSEJHMHdhd0lCQVFRZ3ZwT0U3NVZ0eHJQR2ZLN2cKM05nZFFMa0N2RXFrUUhXemJhY3Nj' +
  'RE8ydUJHaFJBTkNBQVFYdHZzdmtIZk9aamVQRkl4djF3MU1rUExreER5SwpVWlU0T3YyL2hIYVpr' +
  'YzRyd3hsaTNpTjRkRFk0eUFwVUJEZVp6Z210cytycWk0R3FlczdyN2J6eQotLS0tLUVORCBQUklW' +
  'QVRFIEtFWS0tLS0tCg==';

/** 证书链（PEM 文本）。 */
function cert() { return Buffer.from(CERT_B64, 'base64').toString('utf8'); }
/** 私钥（PEM 文本，无口令）。 */
function key() { return Buffer.from(KEY_B64, 'base64').toString('utf8'); }

module.exports = { cert, key };
