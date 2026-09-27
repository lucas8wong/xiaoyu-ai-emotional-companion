import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { usageTimeStore, usageDiagStore } = await import('../../api/services/usageTime.js');

/** 与服务端一致的本地日期键（YYYY-MM-DD） */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('addActiveTime：同日累计、超上限封顶、非法秒数忽略', () => {
  const uid = 'u_add';
  const today = todayKey();
  usageTimeStore.setDailySeconds(uid, today, 0);
  usageTimeStore.addActiveTime(uid, 100);
  usageTimeStore.addActiveTime(uid, 50);
  assert.strictEqual(usageTimeStore.getUserLifetime(uid), 150);

  // 单次 >3600 被封顶到 3600（防异常/滥用）
  usageTimeStore.addActiveTime(uid, 99999);
  assert.strictEqual(usageTimeStore.getUserLifetime(uid), 150 + 3600);

  // 非法秒数忽略
  usageTimeStore.addActiveTime(uid, 0);
  usageTimeStore.addActiveTime(uid, -5);
  usageTimeStore.addActiveTime('', 10);
  assert.strictEqual(usageTimeStore.getUserLifetime(uid), 150 + 3600);
});

test('getUserLifetime：跨日期求和', () => {
  usageTimeStore.setDailySeconds('u_life', '2026-06-01', 100);
  usageTimeStore.setDailySeconds('u_life', '2026-06-02', 200);
  usageTimeStore.setDailySeconds('u_life', '2026-06-03', 0);
  usageTimeStore.setDailySeconds('u_life', '2026-06-04', 30);
  assert.strictEqual(usageTimeStore.getUserLifetime('u_life'), 100 + 200 + 30);
});

test('getRangeSummaries：区间合计/按用户合计/按日趋势/用户排序', () => {
  usageTimeStore.setDailySeconds('a', '2026-07-01', 100);
  usageTimeStore.setDailySeconds('a', '2026-07-02', 200);
  usageTimeStore.setDailySeconds('a', '2026-07-10', 50); // 区间外，不计入区间（但计入 lifetime）
  usageTimeStore.setDailySeconds('b', '2026-07-02', 300);
  usageTimeStore.setDailySeconds('b', '2026-07-03', 120);

  const s = usageTimeStore.getRangeSummaries('2026-07-01', '2026-07-03');
  assert.strictEqual(s.totalSeconds, 100 + 200 + 300 + 120);
  assert.strictEqual(s.activeUsers, 2);
  assert.strictEqual(usageTimeStore.getUserLifetime('a'), 100 + 200 + 50);
  assert.strictEqual(usageTimeStore.getUserLifetime('b'), 300 + 120);
  // lifetimeTotal 对「全部存储数据」求和（store 为单例，跨测试共享，这里按当前全部记录校验）
  const expectedLifetime = usageTimeStore.listAll().reduce(
    (sum, e) => sum + Object.values(e.daily).reduce((s, v) => s + v, 0), 0
  );
  assert.strictEqual(s.lifetimeTotal, expectedLifetime);
  assert.ok(s.lifetimeTotal >= 350 + 420, 'lifetimeTotal 至少应包含 a/b 的全量');

  assert.deepStrictEqual(s.daily, [
    { date: '2026-07-01', seconds: 100 },
    { date: '2026-07-02', seconds: 500 }, // a200 + b300 合并
    { date: '2026-07-03', seconds: 120 },
  ]);

  // 按区间秒数降序：b(420) > a(300)
  assert.strictEqual(s.users[0].userId, 'b');
  assert.strictEqual(s.users[0].seconds, 420);
  assert.strictEqual(s.users[1].userId, 'a');
  assert.strictEqual(s.users[1].seconds, 300);
});

test('getRangeSummaries：from>to 自动交换、空区间返回空', () => {
  usageTimeStore.setDailySeconds('c', '2026-08-05', 10);
  usageTimeStore.setDailySeconds('c', '2026-08-06', 20);

  const swapped = usageTimeStore.getRangeSummaries('2026-08-06', '2026-08-05');
  assert.strictEqual(swapped.totalSeconds, 30);
  assert.deepStrictEqual(swapped.daily, [
    { date: '2026-08-05', seconds: 10 },
    { date: '2026-08-06', seconds: 20 },
  ]);

  const empty = usageTimeStore.getRangeSummaries('2030-01-01', '2030-01-02');
  assert.strictEqual(empty.totalSeconds, 0);
  assert.strictEqual(empty.activeUsers, 0);
  assert.deepStrictEqual(empty.daily, []);
  assert.deepStrictEqual(empty.users, []);
});

test('mergeUsers：游客并入账号（同日累加、跨日保留、游客记录删除）', () => {
  usageTimeStore.setDailySeconds('guest_m', '2026-05-01', 60);
  usageTimeStore.setDailySeconds('guest_m', '2026-05-02', 30);
  usageTimeStore.setDailySeconds('acc_m', '2026-05-02', 10);
  usageTimeStore.mergeUsers('guest_m', 'acc_m');

  assert.strictEqual(usageTimeStore.getUserLifetime('guest_m'), 0, '游客身份应被清空');
  assert.strictEqual(usageTimeStore.getUserLifetime('acc_m'), 60 + 30 + 10, '同日应累加、跨日应保留');
  const s = usageTimeStore.getRangeSummaries('2026-05-01', '2026-05-02');
  assert.strictEqual(s.users.find((u) => u.userId === 'acc_m')!.seconds, 100);

  // 游客本来就没有记录 / 并入自己 → 安全无副作用
  usageTimeStore.mergeUsers('nobody', 'acc_m');
  usageTimeStore.mergeUsers('acc_m', 'acc_m');
  assert.strictEqual(usageTimeStore.getUserLifetime('acc_m'), 100);
});

test('mergeUsers：同日秒数相加（单日仍受 24h 上限保护）', () => {
  usageTimeStore.setDailySeconds('guest_cap', '2026-05-03', 3600);
  usageTimeStore.setDailySeconds('acc_cap', '2026-05-03', 3600);
  usageTimeStore.mergeUsers('guest_cap', 'acc_cap');
  const daily = usageTimeStore.listAll().find((e) => e.userId === 'acc_cap')!.daily;
  assert.strictEqual(daily['2026-05-03'], 7200, '同日相加');
  assert.ok(daily['2026-05-03'] <= 86400, '单日不得超过 24h（上限只在该路径起作用，防异常上报累加）');
});

test('deleteUser：注销后时长记录被删除（合规）', () => {
  usageTimeStore.setDailySeconds('acc_del', '2026-05-04', 120);
  usageTimeStore.deleteUser('acc_del');
  assert.strictEqual(usageTimeStore.getUserLifetime('acc_del'), 0);
  assert.ok(!usageTimeStore.listAll().some((e) => e.userId === 'acc_del'));
  usageTimeStore.deleteUser(''); // 空 id 安全
});

test('usageDiagStore：只累加 true/数字，false/undefined 跳过；快照带兜底零值', () => {
  usageDiagStore.reset();
  usageDiagStore.bump({ reports: 1, visible: true, focused: false, diagOnly: undefined, gateClosedVisible: true });
  usageDiagStore.bump({ reports: 1, visible: true, withSeconds: true });
  const s = usageDiagStore.snapshot();
  assert.strictEqual(s.reports, 2);
  assert.strictEqual(s.visible, 2);
  assert.strictEqual(s.withSeconds, 1);
  assert.strictEqual(s.focused, 0, 'false 不应计数（快照里给 0 兜底）');
  assert.strictEqual(s.diagOnly, 0);
  assert.strictEqual(s.gateClosedVisible, 1);
  assert.ok(s.updatedAt > 0);
});
