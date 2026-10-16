/**
 * 极简 tar 写出（**零依赖**）—— 只为「把一次分享里选中的多个对象打包成一个
 * `.tar.gz` 交给浏览器」这一件事服务。
 *
 * 为什么自己写而不引库：本项目运行时依赖刻意只有 `express`（R49 之后连腾讯云 SDK
 * 都移除了），为一次打包下载引入 `tar-stream` 之类的依赖不成比例；而 tar 的格式
 * （POSIX ustar）本身很小：512 字节定长头 + 内容 + 补零，文件集合以两个全零块收尾。
 *
 * ## 兼容性上刻意做的三件事
 *
 * 1. **GNU 长名条目**（`typeflag: 'L'`，名为 `././@LongLink`）：ustar 的 `name` 只有
 *    100 字节，中文名与深层路径轻易超限。GNU 的 `L` 条目被 `tar`(GNU/bsdtar)、
 *    `busybox tar`、Windows 10+ 自带的 `tar.exe` 全部支持，是最稳的做法。
 *    （PAX 扩展头更"标准"，但解析器要求更高，而这里没有需要 PAX 才能表达的信息。）
 *
 * 2. **超过 8 GiB 的 size 用 GNU base-256 编码**：ustar 的 `size` 字段是 11 位八进制，
 *    最大 8589934591 字节。分享一个大视频很容易越过它；继续按八进制写会被解码成
 *    完全错误的长度（截断或读到下一个文件头），而不是报错。首字节置 `0x80` 即进入
 *    base-256 大端表示，GNU tar 与 bsdtar 都认。
 *
 * 3. **路径归一化**（{@link safeName}）：剥掉前导 `/`、折叠 `.`、就地消解 `..`。
 *    解包方（无论是 `tar -x` 还是脚本）都按条目名落盘，一个 `../../etc/x` 就是一次
 *    目录穿越。对象 key 由我们自己产生，但这层防御不依赖上游是否可信。
 *
 * 本模块**只做字节**：不碰流、不碰响应、不知道对象存储。`share-bundle.js` 负责
 * 把这里的 Buffer 按顺序喂进管线。
 */

/** tar 的定长块大小 */
const BLOCK_SIZE = 512;
/** ustar `name` 字段长度 */
const NAME_MAX = 100;
/** GNU 长名条目的名字（GNU tar 约定的哨兵名，解包工具靠它识别） */
const LONG_NAME_PATH = '././@LongLink';

/** 文件类型标志 */
const TYPE = {
  file: '0',
  dir: '5',
  longName: 'L',
};

/** 把数字写成定长八进制（含末尾 NUL），长度不足在左侧补 '0' */
function octalField(value, len) {
  const s = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  return s.padStart(len - 1, '0').slice(-(len - 1)) + '\0';
}

/**
 * 数值字段编码：八进制放不下时改用 GNU base-256。
 *
 * ⚠️ 这不是"优化"，是**正确性**：截断成低 11 位八进制不会报错，只会让解包出来的
 * 文件长度变成一个看起来合理、实际完全错误的数字。
 */
function numberField(value, len) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const maxOctal = Math.pow(8, len - 1) - 1;
  if (n <= maxOctal) return Buffer.from(octalField(n, len), 'ascii');
  const buf = Buffer.alloc(len);
  buf[0] = 0x80; // base-256 标志位
  let v = BigInt(n);
  for (let i = len - 1; i >= 1; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * 路径归一化：剥前导 `/`、丢弃空段与 `.`、就地消解 `..`。
 * @returns {string} 形如 `a/b/c`（无前后斜杠）；空串表示这条路径没有可用内容
 */
function safeName(name) {
  const parts = String(name === undefined || name === null ? '' : name)
    .replace(/\\/g, '/')
    .split('/');
  const out = [];
  for (const raw of parts) {
    const p = raw.replace(/\0/g, '');
    if (!p || p === '.') continue;
    if (p === '..') { out.pop(); continue; } // 消解到上一级而不是保留 —— 绝不产生可逃出解包目录的路径
    out.push(p);
  }
  return out.join('/');
}

/**
 * 写一个 512 字节头。
 *
 * @param {object} o
 *  - name: 条目名（**必须是已归一化的**；目录请自带结尾 `/`）
 *  - size: 内容字节数（目录为 0）
 *  - type: {@link TYPE} 之一
 *  - [mtime]: 秒级时间戳（默认 0 = 1970，保证可复现的测试输出）
 *  - [mode]: 权限位（默认 0o644；目录 0o755）
 * @returns {Buffer} 恰好 512 字节
 */
function header({ name, size = 0, type = TYPE.file, mtime = 0, mode = 0o644 }) {
  const buf = Buffer.alloc(BLOCK_SIZE, 0);
  const nameBytes = Buffer.from(String(name), 'utf8');
  /**
   * 名字放不进 100 字节时，这里写一个**可读的占位**（末段文件名，必要时再截断），
   * 真正的名字由紧随其前的 GNU `L` 条目携带。GNU tar 自己也这么做 ——
   * 好处是拿 `tar -tvf` 看原始头时至少能看出"这是哪个文件"。
   * ⚠️ 截断按**字节**做，可能切到多字节字符中间：占位名只用于展示，
   * 解包工具用的是 `L` 条目里的完整名字，故不影响正确性。
   */
  let head = nameBytes;
  if (nameBytes.length > NAME_MAX) {
    const base = String(name).replace(/\/$/, '').split('/').pop() || '';
    head = Buffer.from(base, 'utf8').subarray(0, NAME_MAX);
  }
  head.copy(buf, 0);

  numberField(mode & 0o7777, 8).copy(buf, 100);
  numberField(0, 8).copy(buf, 108);                 // uid：刻意恒为 0，不泄露运行服务的账号
  numberField(0, 8).copy(buf, 116);                 // gid
  numberField(size, 12).copy(buf, 124);
  numberField(mtime, 12).copy(buf, 136);
  buf.write('        ', 148, 8, 'ascii');           // 校验和字段先按 8 个空格参与计算
  buf.write(type, 156, 1, 'ascii');
  // linkname[157..256] 恒为空
  buf.write('ustar\0', 257, 6, 'ascii');            // POSIX magic（GNU tar 写的是 "ustar  \0"，两种都认）
  buf.write('00', 263, 2, 'ascii');                 // POSIX version
  // uname / gname / devmajor / devminor 留空 —— 不写运行服务的用户名与主机信息
  numberField(0, 8).copy(buf, 329);                 // devmajor
  numberField(0, 8).copy(buf, 337);                 // devminor
  // prefix[345..500] 留空：长名一律走 GNU 'L' 条目，不用 prefix 拆分（拆错反而更难查）

  const sum = buf.reduce((a, b) => a + b, 0);
  // 校验和字段本身的规范写法是「6 位八进制 + NUL + 空格」
  buf.write(octalField(sum, 7).slice(0, 6) + '\0 ', 148, 8, 'ascii');
  return buf;
}

/**
 * 长名条目：GNU `L` 头 + 名字字节 + NUL + 补零。
 * @returns {Buffer[]} 需要按顺序写出的块；名字放得进 100 字节时返回空数组
 */
function longNameBlocks(name) {
  const nameBuf = Buffer.from(String(name), 'utf8');
  if (nameBuf.length <= NAME_MAX) return [];
  const payload = Buffer.concat([nameBuf, Buffer.from([0])]);
  return [
    header({ name: LONG_NAME_PATH, size: payload.length, type: TYPE.longName, mode: 0o644 }),
    payload,
    padding(payload.length),
  ];
}

/** 内容之后的补零：tar 的每个条目都按 512 字节对齐 */
function padding(size) {
  const n = Number(size) || 0;
  const rest = n % BLOCK_SIZE;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - rest, 0);
}

/** 归档收尾：两个全零块 */
function endBlocks() {
  return Buffer.alloc(BLOCK_SIZE * 2, 0);
}

/**
 * 生成一个条目（头 + 可选长名条目）—— 调用方只需在拿到 Buffer[] 之后、
 * 内容之前把它们按序写进管线。
 *
 * @param {string} path 归档内路径（目录**不要**带结尾 `/`，由本函数补）
 * @param {object} o { dir, size, mtime }
 * @returns {Buffer[]}
 */
function entryBlocks(path, { dir = false, size = 0, mtime = 0 } = {}) {
  const clean = safeName(path);
  if (!clean) return [];
  const name = dir ? clean + '/' : clean;
  const blocks = longNameBlocks(name);
  blocks.push(header({
    name,
    size: dir ? 0 : size,
    type: dir ? TYPE.dir : TYPE.file,
    mtime,
    mode: dir ? 0o755 : 0o644,
  }));
  return blocks;
}

module.exports = {
  BLOCK_SIZE, NAME_MAX, LONG_NAME_PATH, TYPE,
  header, longNameBlocks, entryBlocks, padding, endBlocks, safeName, numberField, octalField,
};
