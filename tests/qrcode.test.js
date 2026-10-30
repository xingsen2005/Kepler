/**
 * 二维码生成器（server/qrcode.js）—— 行为断言
 *
 * 这是**自研实现**，没有第三方库可对照，所以校验策略是「拿规范里的标准常量 + 数学性质」
 * 双重夹逼，而不是"跑一遍看不报错"：
 *   1. 生成多项式：对照 ISO/IEC 18004 的 α 幂次表（能对上说明 GF(256) 与多项式乘法都对）
 *   2. 生成多项式：额外验证 g(α^i) ≡ 0（不依赖记忆的数学自校验，覆盖表外的 n）
 *   3. 格式信息：对照 8 种掩码在纠错级别 M 下的 15 位标准串
 *   4. 端到端：编码后按规范位置回读，结构必须自洽
 */
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT } = require('./helpers');

const qr = require(path.join(ROOT, 'server', 'qrcode.js'));

/* GF(256) 的对数表（模块内部未导出，测试里重建一份用于换算 α 幂次） */
const LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
})();

/* ================================================================== *
 * 1 · GF(256) 与生成多项式
 * ================================================================== */

test('GF(256) 基本性质：α^0=1、α^255=1、乘法可逆', () => {
  assertEqual(qr.gfMul(1, 1), 1, 'α^0 · α^0 = 1');
  assertEqual(qr.gfMul(0, 123), 0, '0 乘任何数为 0');
  // α^254 · α^1 = α^255 = 1
  let a254 = 1;
  for (let i = 0; i < 254; i++) a254 = qr.gfMul(a254, 2);
  assertEqual(qr.gfMul(a254, 2), 1, 'α^255 = 1（本原多项式闭合）');
});

// 生成多项式的标准 α 幂次表（ISO/IEC 18004）
// 注：只收录能可靠对照的项；其余 n 由下面的数学自校验覆盖
const GEN_STD = {
  7: [0, 87, 229, 146, 149, 238, 102, 21],
  10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
  13: [0, 74, 152, 176, 100, 86, 100, 106, 104, 130, 218, 206, 140, 78],
  18: [0, 215, 234, 158, 94, 184, 97, 118, 170, 79, 187, 152, 148, 252, 179, 5, 98, 96, 153],
  22: [0, 210, 171, 247, 242, 93, 230, 14, 109, 221, 53, 200, 74, 8, 172, 98, 80, 219, 134, 160, 105, 165, 231],
};

test('生成多项式与标准 α 幂次表一致', () => {
  for (const n of Object.keys(GEN_STD)) {
    const g = qr.genPoly(Number(n));
    assertEqual(g.length, Number(n) + 1, `genPoly(${n}) 应有 ${Number(n) + 1} 项`);
    const actual = g.map((v) => (v === 0 ? -1 : LOG[v]));
    assertEqual(JSON.stringify(actual), JSON.stringify(GEN_STD[n]), `genPoly(${n}) 的 α 幂次序列`);
  }
});

/** α^k（k 可为 0） */
function alphaPow(k) {
  let v = 1;
  for (let j = 0; j < k; j++) v = qr.gfMul(v, 2);
  return v;
}

test('生成多项式在 α^0 … α^(n-1) 处取值恒为 0（数学自校验）', () => {
  for (let n = 1; n <= 26; n++) {
    const g = qr.genPoly(n);
    for (let i = 0; i < n; i++) {
      // Horner 法代入 x = α^i；g(x) = ∏(x - α^j) 在这些点必为 0
      let acc = 0;
      for (const coef of g) acc = qr.gfMul(acc, alphaPow(i)) ^ coef;
      assertEqual(acc, 0, `genPoly(${n}) 在 α^${i} 处应为 0`);
    }
  }
});

/* ================================================================== *
 * 2 · 格式信息
 * ================================================================== */

// 纠错级别 M（指示符 00）下 8 种掩码的 15 位格式串（bit14 → bit0）
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];

test('格式信息：8 种掩码均与标准 15 位串一致', () => {
  for (let mask = 0; mask < 8; mask++) {
    const s = qr.formatBits(mask).toString(2).padStart(15, '0');
    assertEqual(s, FORMAT_M[mask], `掩码 ${mask} 的格式串`);
  }
});

/* ================================================================== *
 * 3 · 版本与容量
 * ================================================================== */

test('容量表自洽：数据码字 + 纠错码字 = 总码字', () => {
  for (let v = 1; v <= 10; v++) {
    const c = qr.CAPACITY[v];
    const data = c.blocks.reduce((s, n) => s + n, 0);
    assertEqual(data + c.ec * c.blocks.length, c.total, `版本 ${v} 的总码字数`);
  }
});

test('版本选择：按字节数挑最小可用版本，超出范围返回 0', () => {
  assertEqual(qr.pickVersion(2), 1, '2 字节 → 版本 1');
  assertEqual(qr.pickVersion(500), 0, '500 字节超出版本 10 的容量 → 0');
  // 单调递增：容量需求越大，选出的版本不应更小
  let prev = 0;
  for (let n = 1; n <= 200; n++) {
    const v = qr.pickVersion(n);
    assert(v >= prev, `字节数 ${n} 时版本不应回退（${v} < ${prev}）`);
    prev = v;
  }
});

/* ================================================================== *
 * 4 · 端到端结构
 * ================================================================== */

test('编码结果满足 QR 的结构约束', () => {
  const q = qr.encode('weixin://wxpay/bizpayurl?pr=abcdefg');
  assert(q, '编码应成功');
  assertEqual(q.size, q.version * 4 + 17, '尺寸 = 4×版本 + 17');

  const row = (r) => q.modules[r].join('');
  assertEqual(row(0).slice(0, 7), '1111111', '左上定位图案外框');
  assertEqual(row(0).slice(-7), '1111111', '右上定位图案外框');
  assertEqual(row(q.size - 7).slice(0, 7), '1111111', '左下定位图案外框');
  assertEqual(q.modules[3][3], 1, '定位图案中心为深色');
  assertEqual(row(0)[7], '0', '定位图案右侧分隔符为白');
  assertEqual(q.modules[q.size - 8][8], 1, '固定深色模块');

  // 定时图案：第 6 行 / 第 6 列黑白交替
  for (let i = 8; i < q.size - 8; i++) {
    assertEqual(q.modules[6][i], i % 2 === 0 ? 1 : 0, `第 6 行第 ${i} 列的定时图案`);
  }
});

test('格式信息落在标准位置：回读值与 encode() 实际使用的掩码一致（R95）', () => {
  const samples = [
    'weixin://wxpay/bizpayurl?pr=abcdefg',
    'https://example.com/s/abcdefghijklmnop',
    'x'.repeat(120),
  ];
  for (const text of samples) {
    const q = qr.encode(text);
    const r = readFormatAtStandardPositions(q.modules);
    // 判据落在**位置**上：主副本与副本都必须「精确命中」（距离 0）某个合法码字，
    // 且解出的 (纠错级别, 掩码) 等于编码器真正用的那一组。
    // 旧实现把每个 bit 的 (行, 列) 整体写反 ⇒ 读回来是正确串的逐位颠倒，
    // 它往往离**别的**合法码字只差 3 位（BCH 能纠 3 位），所以必须要求距离 0。
    assertEqual(r.ec, 0, `版本 ${q.version}：「${text.slice(0, 12)}…」的纠错级别应为 M（00），实际 ${r.ec}`);
    assertEqual(r.maskA, q.mask, `版本 ${q.version}：主副本读出的掩码应等于 encode() 使用的 ${q.mask}`);
    assertEqual(r.maskB, q.mask, `版本 ${q.version}：副本读出的掩码应等于 encode() 使用的 ${q.mask}`);
  }
});

/* ================================================================== *
 * 5 · 独立解码（R95）：把矩阵真的解回原文
 * ================================================================== */

/**
 * 为什么要有这一节：「回读自己写的位置」永远自洽 —— 行列写反也不报错。
 * 旧用例（`modules[8][i]` 读回、再 reverse 后比 `FORMAT_M`）验的是「这 15 位按**实现
 * 的**位序读出来是个合法 M 级码字」，对「位置对不对」一无所知；而 `placeFormat()`
 * 的行列互换恰好是「位序内部自洽、位置全错」，于是整片测试区从它眼皮底下通过。
 *
 * 这一段是**按 ISO/IEC 18004 另写一份解码器**（功能图案占位、格式信息位置、掩码、
 * 蛇形走位、反交织、RS 校验子、Byte 模式解析），不复用 `server/qrcode.js` 的任何
 * 布局函数。它能解回原文，才说明「扫码器扫得出来」。
 */

const QR_M_BLOCKS = [null,
  { b: [16], ec: 10 }, { b: [28], ec: 16 }, { b: [44], ec: 26 }, { b: [32, 32], ec: 18 },
  { b: [43, 43], ec: 24 }, { b: [27, 27, 27, 27], ec: 16 }, { b: [31, 31, 31, 31], ec: 18 },
  { b: [38, 38, 39, 39], ec: 22 }, { b: [36, 36, 36, 37, 37], ec: 22 },
  { b: [43, 43, 43, 43, 44], ec: 26 }];

const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** BCH(15,5) 生成多项式 0x537，异或掩模 0x5412 —— 32 个合法格式码字 */
const FORMAT_WORDS = (() => {
  const out = [];
  for (let ec = 0; ec < 4; ec++) {
    for (let m = 0; m < 8; m++) {
      const d0 = (ec << 3) | m;
      let d = d0 << 10;
      for (let i = 0; i < 5; i++) if ((d >>> (14 - i)) & 1) d ^= 0x537 << (4 - i);
      out.push({ ec, mask: m, word: ((d0 << 10) | d) ^ 0x5412 });
    }
  }
  return out;
})();

function bitDiff(a, b) {
  let v = a ^ b, n = 0;
  while (v) { n += v & 1; v >>= 1; }
  return n;
}

/**
 * ISO/IEC 18004 §7.9.1 规定的格式信息位置（`m[行][列]`）。
 *
 * 与 ZXing `MatrixUtil.TYPE_INFO_COORDINATES` 的 `(x=列, y=行)` 一一对应：
 * `{8,0}…{0,8}` 换成本文件的写法则为 bit0~bit5 落在 **(0..5, 8)**（竖条）。
 */
function readFormatAtStandardPositions(m) {
  const size = m.length;
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a[i] = m[i][8];
  a[6] = m[7][8]; a[7] = m[8][8]; a[8] = m[8][7];
  for (let i = 9; i <= 14; i++) a[i] = m[8][14 - i];
  for (let i = 0; i <= 7; i++) b[i] = m[8][size - 1 - i];
  for (let i = 8; i <= 14; i++) b[i] = m[size - 15 + i][8];
  const toInt = (bits) => bits.reduce((s, bit, i) => s + (bit << i), 0);
  const pick = (bits) => {
    const w = toInt(bits);
    const hit = FORMAT_WORDS.find((v) => bitDiff(w, v.word) === 0);
    return hit ? { ec: hit.ec, mask: hit.mask } : { ec: -1, mask: -1 };
  };
  const pa = pick(a), pb = pick(b);
  return { ec: pa.ec, maskA: pa.mask, maskB: pb.mask };
}

const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 功能图案占位图（独立按规范算，不读 qrcode.js 的 flag） */
function qrFuncMap(version) {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) f[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const co = QR_ALIGN[version] || [];
  for (const r0 of co) for (const c0 of co) {
    if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r0 + dr, c0 + dc);
  }
  for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  }
  return f;
}

/** 按规范顺序读码字（右下角起、两列一组蛇形、跳过第 6 列），并就地反掩码 */
function qrReadCodewords(m, f, mask) {
  const size = m.length, bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        const col = k === 0 ? right : right - 1;
        if (col < 0 || f[row][col]) continue;
        bits.push(m[row][col] ^ (QR_MASKS[mask](row, col) ? 1 : 0));
      }
    }
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

/** RS 校验子：整块（数据 + 纠错）在 α^0…α^(ec-1) 处必须全为 0 */
function qrRsClean(block, ecLen) {
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const cw of block) acc = qr.gfMul(acc, alphaPow(i)) ^ cw;
    if (acc !== 0) return false;
  }
  return true;
}

/**
 * 独立解码。返回 `{ok, text, mask, ec}`；失败时 `why` 说明卡在哪一步 ——
 * 「格式信息读不出来」「RS 校验不过」「模式不对」是三类完全不同的病因。
 */
function qrDecode(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  const fmt = readFormatAtStandardPositions(m);
  if (fmt.ec < 0 || fmt.maskA !== fmt.maskB) return { ok: false, why: '格式信息在标准位置读不出合法的 (级别, 掩码)' };
  if (fmt.ec !== 0) return { ok: false, why: `纠错级别不是 M（读到 ${fmt.ec}）` };
  const tbl = QR_M_BLOCKS[version];
  if (!tbl) return { ok: false, why: `版本 ${version} 超出本解码器表` };
  const cw = qrReadCodewords(m, qrFuncMap(version), fmt.maskA);
  // 反交织：先按「第 i 个字节取自各块」摊平，再按块长度切回
  const datas = tbl.b.map(() => []);
  let p = 0;
  for (let i = 0; i < Math.max.apply(null, tbl.b); i++) {
    for (let bi = 0; bi < tbl.b.length; bi++) if (i < tbl.b[bi]) datas[bi].push(cw[p++]);
  }
  const ecs = tbl.b.map(() => []);
  for (let i = 0; i < tbl.ec; i++) for (let bi = 0; bi < tbl.b.length; bi++) ecs[bi].push(cw[p++]);
  for (let bi = 0; bi < tbl.b.length; bi++) {
    if (!qrRsClean(datas[bi].concat(ecs[bi]), tbl.ec)) {
      return { ok: false, why: `第 ${bi + 1} 块的 RS 校验子不为 0（按格式信息解不出内容）` };
    }
  }
  const data = datas.reduce((s, b) => s.concat(b), []);
  const bs = [];
  for (const byte of data) for (let j = 7; j >= 0; j--) bs.push((byte >>> j) & 1);
  let at = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | bs[at]; at += 1; } return v; };
  const mode = take(4);
  if (mode !== 0b0100) return { ok: false, why: `模式指示符不是 Byte（读到 ${mode.toString(2)}）` };
  const len = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return { ok: true, text: Buffer.from(bytes).toString('utf8'), mask: fmt.maskA, ec: fmt.ec };
}

test('独立解码器：能把矩阵解回原文（这才是「扫码器扫得出来」）', () => {
  const samples = [
    'weixin://wxpay/bizpayurl?pr=abcdefg',
    'https://example.com/s/abcdefghijklmnop',
    'A'.repeat(60),                      // 版本 4：两块交织
    'B'.repeat(120),                     // 版本 7：四块 + 版本信息位
    'C'.repeat(200),                     // 版本 10：五块（块长不等）
  ];
  for (const text of samples) {
    const q = qr.encode(text);
    assert(q, `「${text.slice(0, 8)}…」应编码成功`);
    const r = qrDecode(q.modules);
    assert(r.ok, `「${text.slice(0, 8)}…」（版本 ${q.version}）解不出来：${r.why}`);
    assertEqual(r.text, text, `解出的内容应与原文逐字相同（版本 ${q.version}）`);
    assertEqual(r.mask, q.mask, `解出的掩码应等于编码器实际使用的掩码（版本 ${q.version}）`);
  }
});

test('SVG 输出：尺寸与内容正确', () => {
  const svg = qr.toSvg('https://example.com/pay/abc', { scale: 4, margin: 3 });
  assertMatch(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '应以 svg 根标签开头');
  assert(svg.includes('<rect'), '应包含矩形');
  assert(svg.includes('fill="#fff"'), '应有白色底');
  assert(!/undefined|NaN/.test(svg), 'SVG 中不应出现 undefined / NaN');
});

test('超出容量时返回 null 与空 SVG（不抛异常）', () => {
  const long = 'x'.repeat(500);
  assertEqual(qr.encode(long), null, '超长内容应返回 null');
  assertEqual(qr.toSvg(long), '', '超长内容的 SVG 应为空串');
});
