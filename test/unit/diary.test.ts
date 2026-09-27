import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { diaryStore, todayStr } = await import('../../api/services/diary.js');

test('todayStr：YYYY-MM-DD 格式', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

test('save：当天首次打卡发 5 次奖励；重复提交覆盖不重复发奖', () => {
  const u = 'diaryA';
  const first = diaryStore.save(u, 'happy', '今天很开心');
  assert.strictEqual(first.streak, 1);
  assert.deepStrictEqual(first.reward, { bonus: 5 });
  assert.strictEqual(first.entry.mood, 'happy');
  assert.strictEqual(first.entry.note, '今天很开心');
  assert.strictEqual(first.entry.date, todayStr());

  // 同日重复提交：覆盖内容，不再发奖
  const second = diaryStore.save(u, 'calm', '心情平复了');
  assert.strictEqual(second.reward, null, '重复打卡不再发奖');
  assert.strictEqual(second.entry.mood, 'calm');
  assert.strictEqual(second.entry.note, '心情平复了');
  assert.strictEqual(second.streak, 1);
});

test('list：按日期倒序；用户隔离', () => {
  // 仅能通过 save 写今天的记录；用两个不同用户验证隔离
  diaryStore.save('diaryB', 'sad', '难过');
  diaryStore.save('diaryC', 'angry', '生气');

  assert.strictEqual(diaryStore.list('diaryB').length, 1);
  assert.strictEqual(diaryStore.list('diaryB')[0].mood, 'sad');
  assert.strictEqual(diaryStore.list('diaryC').length, 1);
  assert.strictEqual(diaryStore.list('nobody').length, 0);
});

test('removeByUser：删除该用户全部日记', () => {
  diaryStore.save('diaryD', 'ok', '还好');
  diaryStore.removeByUser('diaryD');
  assert.strictEqual(diaryStore.list('diaryD').length, 0);
});

test('checkinStats：打卡用户/次数按日期范围与排除集合统计', () => {
  const today = todayStr();
  const before = diaryStore.checkinStats(today, today);
  // 新增两个用户各打一次卡；diaryE 同日重复提交覆盖、不重复计数
  diaryStore.save('diaryE', 'happy', '今天');
  diaryStore.save('diaryF', 'calm', '今天');
  diaryStore.save('diaryE', 'sad', '覆盖仍一条');
  const after = diaryStore.checkinStats(today, today);
  assert.strictEqual(after.users, before.users + 2, '新增两个打卡用户');
  assert.strictEqual(after.count, before.count + 2, '打卡次数 +2（diaryE 重复覆盖不新增）');

  // 排除 diaryE 后：只剩新增的 diaryF 计入
  const excl = new Set(['diaryE']);
  assert.strictEqual(diaryStore.checkinStats(today, today, excl).users, before.users + 1);
  assert.strictEqual(diaryStore.checkinStats(today, today, excl).count, before.count + 1);

  // 未来日期范围内无打卡
  const tom = new Date(); tom.setDate(tom.getDate() + 1);
  const t = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
  assert.deepStrictEqual(diaryStore.checkinStats(t, t), { users: 0, count: 0 });
});

test('checkinByUser：逐用户打卡计数与最近时间戳', () => {
  const uid = 'diaryG';
  const today = todayStr();
  assert.strictEqual(diaryStore.checkinByUser(today, today).get(uid), undefined, '新用户此前无打卡');
  diaryStore.save(uid, 'happy', '第一次');
  diaryStore.save(uid, 'calm', '同日重复提交，仍为一条');
  const rec = diaryStore.checkinByUser(today, today).get(uid);
  assert.ok(rec, '应有打卡记录');
  assert.strictEqual(rec.count, 1, '同日重复提交仍计 1 次');
  assert.ok(rec.lastAt && rec.lastAt > 0, 'lastAt 为时间戳');
  // 排除该用户后不再出现
  assert.strictEqual(diaryStore.checkinByUser(today, today, new Set([uid])).get(uid), undefined);
});
