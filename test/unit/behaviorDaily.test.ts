import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { behaviorDailyStore } = await import('../../api/services/behaviorDaily.js');

// 埋点接入验证：activity/roleplayLikes 写日志（同进程共享单例，临时目录隔离）
const { activityStore } = await import('../../api/services/activity.js');
const { roleplayLikeStore } = await import('../../api/services/roleplayLikes.js');

/** 与服务端一致的本地日期键（YYYY-MM-DD） */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('addEvent：按日按类型累加并更新当日 lastAt', () => {
  const uid = 'bd_add_' + todayKey();
  const today = todayKey();
  behaviorDailyStore.addEvent(uid, 'chat', Date.now());
  behaviorDailyStore.addEvent(uid, 'chat', Date.now());
  behaviorDailyStore.addEvent(uid, 'structure', Date.now());
  const u = behaviorDailyStore.getUserRange(uid, today, today);
  assert.ok(u, '今日应有记录');
  assert.strictEqual(u!.chat, 2);
  assert.strictEqual(u!.structure, 1);
  assert.strictEqual(u!.roleplay, 0);
  assert.ok(u!.lastAt > 0);
  // 非法类型/空 userId 忽略
  behaviorDailyStore.addEvent('', 'chat' as any);
  behaviorDailyStore.addEvent(uid, 'bad' as any);
  assert.strictEqual(behaviorDailyStore.getUserRange(uid, today, today)!.chat, 2);
});

test('getRangeSummary：固定日期区间合计 / 区间外不计 / 用户排序 / 空区间', () => {
  const ua = 'bd_range_a';
  const ub = 'bd_range_b';
  behaviorDailyStore.setDayCounts(ua, '2026-08-01', { chat: 1, login: 2 }, 1000);
  behaviorDailyStore.setDayCounts(ua, '2026-08-03', { roleplay: 3 }, 3000);
  behaviorDailyStore.setDayCounts(ua, '2026-08-10', { chat: 9 }, 9000); // 区间外
  behaviorDailyStore.setDayCounts(ub, '2026-08-02', { structure: 5, likes: 1 }, 2000);

  const s = behaviorDailyStore.getRangeSummary('2026-08-01', '2026-08-03');
  assert.strictEqual(s.totalUsers, 2);
  assert.deepStrictEqual(s.totals, { chat: 1, structure: 5, roleplay: 3, wenyou: 0, werewolf: 0, login: 2, install: 0, likes: 1 });

  const byId = new Map(s.users.map((u: any) => [u.userId, u]));
  assert.strictEqual(byId.get(ua)!.chat, 1);
  assert.strictEqual(byId.get(ua)!.roleplay, 3);
  assert.strictEqual(byId.get(ua)!.lastAt, 3000);
  assert.strictEqual(byId.get(ub)!.structure, 5);
  // 按区间内 lastAt 降序：ua(3000) > ub(2000)
  assert.strictEqual(s.users[0].userId, ua);

  const empty = behaviorDailyStore.getRangeSummary('2030-01-01', '2030-01-02');
  assert.strictEqual(empty.totalUsers, 0);
  assert.deepStrictEqual(empty.users, []);
  assert.deepStrictEqual(empty.totals, { chat: 0, structure: 0, roleplay: 0, wenyou: 0, werewolf: 0, login: 0, install: 0, likes: 0 });
});

test('mergeUsers：游客日志并入账号（同日累加、跨日保留）并删除游客', () => {
  const guest = 'bd_guest';
  const acc = 'bd_acc';
  behaviorDailyStore.setDayCounts(guest, '2026-08-01', { chat: 2 }, 1000);
  behaviorDailyStore.setDayCounts(guest, '2026-08-02', { roleplay: 1 }, 2000);
  behaviorDailyStore.setDayCounts(acc, '2026-08-01', { chat: 3 }, 1500);

  behaviorDailyStore.mergeUsers(guest, acc);

  assert.strictEqual(behaviorDailyStore.getUserRange(guest, '2026-08-01', '2026-08-31'), null, '游客日志应被删除');
  const merged = behaviorDailyStore.getUserRange(acc, '2026-08-01', '2026-08-31')!;
  assert.strictEqual(merged.chat, 5, '同日 chat 合并累加');
  assert.strictEqual(merged.roleplay, 1, '游客的 roleplay 应带过来');
  assert.strictEqual(merged.lastAt, 2000, 'lastAt 取区间内最大值');
});

test('deleteUser：清空某用户全部日志', () => {
  const uid = 'bd_del';
  behaviorDailyStore.setDayCounts(uid, '2026-08-05', { chat: 1 }, 5000);
  behaviorDailyStore.deleteUser(uid);
  assert.strictEqual(behaviorDailyStore.getUserRange(uid, '2026-08-01', '2026-08-31'), null);
});

test('getUserLifetimeCounts：跨日期求和', () => {
  const uid = 'bd_life';
  behaviorDailyStore.setDayCounts(uid, '2026-07-01', { chat: 1, login: 1 }, 100);
  behaviorDailyStore.setDayCounts(uid, '2026-07-02', { install: 2, likes: 3 }, 200);
  const counts = behaviorDailyStore.getUserLifetimeCounts(uid);
  assert.strictEqual(counts.chat, 1);
  assert.strictEqual(counts.login, 1);
  assert.strictEqual(counts.install, 2);
  assert.strictEqual(counts.likes, 3);
});

test('埋点接入：activity 功能/登录/安装与 roleplayLikes 点赞都写入按日日志', () => {
  const today = todayKey();
  const uid = 'bd_hook';
  activityStore.trackFeature(uid, 'chat', {});
  activityStore.trackFeature(uid, 'structure', {});
  activityStore.trackFeature(uid, 'roleplay', {});
  activityStore.trackLogin(uid, { method: 'login' });
  activityStore.trackInstall(uid, {});
  roleplayLikeStore.toggle(uid, 'scenario-hook-1');

  const u = behaviorDailyStore.getUserRange(uid, today, today)!;
  assert.ok(u, '埋点应写入今日日志');
  assert.strictEqual(u.chat, 1);
  assert.strictEqual(u.structure, 1);
  assert.strictEqual(u.roleplay, 1);
  assert.strictEqual(u.login, 1);
  assert.strictEqual(u.install, 1);
  assert.strictEqual(u.likes, 1);
});

test('埋点接入：游客并入账号同步合并行为日志，注销清理日志', () => {
  const today = todayKey();
  const guest = 'bd_hook_guest';
  const acc = 'bd_hook_acc';
  activityStore.trackFeature(guest, 'roleplay', {});
  activityStore.trackFeature(acc, 'chat', {});
  // 合并：游客 roleplay 应并入账号
  activityStore.mergeFrom(guest, acc);
  const merged = behaviorDailyStore.getUserRange(acc, today, today)!;
  assert.strictEqual(merged.roleplay, 1, '游客并入账号后 roleplay 日志应带过来');
  assert.strictEqual(merged.chat, 1);
  assert.strictEqual(behaviorDailyStore.getUserRange(guest, today, today), null, '游客日志应被清除');
  // 注销：清空账号全部日志
  activityStore.remove(acc);
  assert.strictEqual(behaviorDailyStore.getUserRange(acc, today, today), null, '注销应清空行为日志');
});

// —— 剧情演绎三模式：roleplay 桶恒为**合计**，wenyou/werewolf 是模式桶 ——

test('剧情模式：文游/狼人杀事件同时累加 roleplay 合计（三者之和 ≡ 合计，老区间不断层）', () => {
  const today = todayKey();
  const uid = 'bd_modes';
  activityStore.trackFeature(uid, 'roleplay', { detail: '剧本A', mode: 'roleplay' });
  activityStore.trackFeature(uid, 'roleplay', { detail: 'AI 文游', mode: 'wenyou' });
  activityStore.trackFeature(uid, 'roleplay', { detail: '10 人局', mode: 'werewolf' });
  const u = behaviorDailyStore.getUserRange(uid, today, today)!;
  assert.strictEqual(u.roleplay, 3, '合计 = 剧情扮演 1 + 文游 1 + 狼人杀 1');
  assert.strictEqual(u.wenyou, 1);
  assert.strictEqual(u.werewolf, 1);
  assert.strictEqual(u.wenyou + u.werewolf, 2, '两个模式桶之和（剧情扮演 = 合计 − 这两个）');
});

test('剧情模式：缺省 mode 只进 roleplay 桶（不虚增文游/狼人杀）', () => {
  const today = todayKey();
  const uid = 'bd_modes_default';
  activityStore.trackFeature(uid, 'roleplay', { detail: '未标模式' });
  const u = behaviorDailyStore.getUserRange(uid, today, today)!;
  assert.strictEqual(u.roleplay, 1);
  assert.strictEqual(u.wenyou, 0);
  assert.strictEqual(u.werewolf, 0);
});

test('剧情模式：区间汇总与合并都带上模式桶', () => {
  // 用独立的用户与日期区间，避免与上面几个用例的全局区间汇总互相干扰
  const guest = 'bd_modes_guest';
  const acc = 'bd_modes_acc';
  const D1 = '2026-12-01';
  const D2 = '2026-12-02';
  behaviorDailyStore.setDayCounts(guest, D1, { roleplay: 2, wenyou: 2 }, 1000);
  behaviorDailyStore.setDayCounts(acc, D1, { roleplay: 1, werewolf: 1 }, 1500);
  behaviorDailyStore.mergeUsers(guest, acc);
  const u = behaviorDailyStore.getUserRange(acc, D1, D2)!;
  assert.strictEqual(u.roleplay, 3, '合计合并');
  assert.strictEqual(u.wenyou, 2, '文游桶合并（否则注册后控制台看不到）');
  assert.strictEqual(u.werewolf, 1);
  const s = behaviorDailyStore.getRangeSummary(D1, D2);
  assert.strictEqual(s.totalUsers, 1, '该区间只有这一个用户');
  assert.strictEqual(s.totals.roleplay, 3);
  assert.strictEqual(s.totals.wenyou, 2);
  assert.strictEqual(s.totals.werewolf, 1);
  const life = behaviorDailyStore.getUserLifetimeCounts(acc);
  assert.strictEqual(life.wenyou, 2);
  assert.strictEqual(life.werewolf, 1);
});

