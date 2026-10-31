/**
 * R98：昵称与注销申请的**存储层**契约
 *
 * HTTP 面（`audit98-regressions.test.js`）守的是"谁能做什么"；本文件守的是
 * 更底层、也更难被观察到的两件事：
 *
 *  ① **坏数据的方向必须是"账户留下"**。`deletion` 是定时清扫读取的判据 ——
 *     一个写坏的 `deleteAt`（不是日期、早于申请时间）如果被当成"立刻到期"，
 *     一次读盘就能把一个账户删掉，而且**无法恢复**。归一化必须让它变成 `null`。
 *  ② **昵称按码点截断，不按 UTF-16 单元**。`slice(0, 32)` 会把 emoji 的代理对
 *     劈成半个字符 —— 落盘、再读出来就是乱码，而这类损坏在界面上极难归因。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assert, assertEqual, ROOT } = require('./helpers');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-r98-unit-'));
process.env.S3_DATA_DIR = tmpDir;

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const accountDeletion = require(path.join(ROOT, 'server', 'account-deletion.js'));

const DAY = 24 * 60 * 60 * 1000;
let alice = null;

test.before(async () => {
  await configStore.addUser({ username: 'rootU', password: 'Passw0rd!98' });
  alice = await configStore.addUser({ username: 'aliceU', password: 'Passw0rd!98', email: 'a@x.test' });
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
});

/** 直接改存储里的原始记录（模拟"盘上有脏数据"） */
function writeDeletion(d) {
  const cfg = configStore.load();
  cfg.users.find((u) => u.id === alice.id).deletion = d;
  configStore.save(cfg);
}

test('R98-13 · 坏的 deletion 结构一律视为"没有申请"（fail-safe：账户留下）', () => {
  const bad = [
    { requestedAt: '2026-01-01T00:00:00.000Z', deleteAt: '2025-01-01T00:00:00.000Z' }, // 到期早于申请
    { requestedAt: 'not-a-date', deleteAt: '2026-01-01T00:00:00.000Z' },
    { requestedAt: '2026-01-01T00:00:00.000Z' }, // 缺 deleteAt
    { requestedAt: '2026-01-01T00:00:00.000Z', deleteAt: '2026-01-01T00:00:00.000Z' }, // 相等也算坏
    'garbage',
    [],
  ];
  for (const d of bad) {
    writeDeletion(d);
    const raw = configStore.findUserRawById(alice.id);
    assertEqual(configStore.userView(raw).deletion, null,
      `坏结构必须归零（否则定时清扫可能立刻删掉账户）：${JSON.stringify(d)}`);
    assertEqual(configStore.dueDeletionUsers(new Date().toISOString()).length, 0,
      `坏结构不得出现在"到期列表"里：${JSON.stringify(d)}`);
  }
});

test('R98-14 · 有效的申请原样保留，且只在到期后才进"待删列表"', () => {
  const now = Date.now();
  writeDeletion({
    requestedAt: new Date(now).toISOString(),
    deleteAt: new Date(now + 15 * DAY).toISOString(),
  });
  const raw = configStore.findUserRawById(alice.id);
  const view = configStore.userView(raw).deletion;
  assert(view && view.deleteAt, '有效申请必须保留');
  assertEqual(configStore.dueDeletionUsers(new Date().toISOString()).length, 0, '未到期不得进待删列表');
  assertEqual(configStore.dueDeletionUsers(new Date(now + 15 * DAY).toISOString()).length, 1,
    '恰好到期即应进入待删列表（边界是 <=，不是 <）');
});

test('R98-15 · 昵称按码点截断，不劈开代理对（emoji 不能变成乱码）', () => {
  assertEqual(configStore.normalizeNickname('  a\nb  '), 'a b', '控制字符压成空格、首尾与连续空白归一');
  const emoji = '😀'.repeat(configStore.NICKNAME_MAX + 5);
  const cut = configStore.normalizeNickname(emoji);
  assertEqual(Array.from(cut).length, configStore.NICKNAME_MAX, '长度按码点计');
  assertEqual(cut, '😀'.repeat(configStore.NICKNAME_MAX), '截断处不得留下半个代理对');
  assert(!/[\uD800-\uDBFF]$/.test(cut), '末尾不得是孤立的高位代理');
});

test('R98-16 · 冷静期常量是唯一事实源（UI / 文档都必须从这里取）', () => {
  assertEqual(accountDeletion.COOLING_DAYS, 15, '冷静期必须是 15 天');
  const due = Date.parse(accountDeletion.deletionDueAt(0));
  assertEqual(due, 15 * DAY, 'deletionDueAt(0) 必须正好落在第 15 天（毫秒精度）');
});
