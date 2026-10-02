import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { activityStore } = await import('../../api/services/activity.js');

test('行为追踪：记录功能使用与对象信息（detail）', () => {
  const uid = 'act-1';
  activityStore.trackFeature(uid, 'roleplay', { detail: '他等了我十五年' });
  activityStore.trackFeature(uid, 'chat', {});
  const items = activityStore.getRecentActivity(uid);
  assert.strictEqual(items.length, 2);
  const features = items.map(i => i.feature).sort();
  assert.deepStrictEqual(features, ['chat', 'roleplay']);
  const rp = items.find(i => i.feature === 'roleplay');
  assert.strictEqual(rp?.detail, '他等了我十五年');
});

test('行为追踪：detail 超长裁剪到 40 字', () => {
  const uid = 'act-detail';
  activityStore.trackFeature(uid, 'roleplay', { detail: '剧'.repeat(60) });
  const items = activityStore.getRecentActivity(uid);
  assert.strictEqual(items[0].detail!.length, 40);
});

test('行为追踪：recentActivity 上限裁剪（保留最近 10 条）', () => {
  const uid = 'act-cap';
  for (let i = 0; i < 12; i++) {
    activityStore.trackFeature(uid, i % 2 === 0 ? 'chat' : 'structure', { detail: '第' + i + '轮' });
  }
  const items = activityStore.getRecentActivity(uid);
  assert.strictEqual(items.length, 10, '只保留最近 10 条');
  assert.ok(items.some(i => i.detail === '第11轮'), '保留最近一条（第11轮）');
  assert.ok(!items.some(i => i.detail === '第0轮'), '丢弃最早的两条（第0轮）');
});

test('行为追踪：游客并入账号时 recentActivity 合并（按时间倒序取最近 10）', () => {
  const guest = 'act-guest';
  const acc = 'act-acc';
  activityStore.trackFeature(guest, 'roleplay', { detail: '剧本A' });
  activityStore.trackFeature(acc, 'chat', {});
  activityStore.mergeFrom(guest, acc);
  const items = activityStore.getRecentActivity(acc);
  assert.strictEqual(items.length, 2);
  const features = items.map(i => i.feature).sort();
  assert.deepStrictEqual(features, ['chat', 'roleplay']);
  const rp = items.find(i => i.feature === 'roleplay');
  assert.strictEqual(rp?.detail, '剧本A');
});

test('行为追踪：登录/功能使用记录国家码（P1 geo 修复）', () => {
  const uid = 'act-country';
  activityStore.trackLogin(uid, { method: 'login', ip: '8.8.8.8', country: 'us' });
  activityStore.trackFeature(uid, 'chat', { ip: '1.2.3.4', country: 'gb' });
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.logins[0].country, 'US', '登录记录应存国家码（大写）');
  assert.strictEqual(rec.lastCountry, 'GB', '功能使用应更新 lastCountry');
});

test('行为追踪：文游（千世书）作为 roleplay 计入剧情使用记录并带 detail', () => {
  const uid = 'act-wenyou';
  activityStore.trackFeature(uid, 'roleplay', { detail: 'AI 文游' });
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.roleplayCount, 1, '文游回合计入剧情使用记录 roleplayCount');
  const item = rec.recentActivity.find(i => i.feature === 'roleplay');
  assert.strictEqual(item?.detail, 'AI 文游');
});

// —— 剧情演绎三模式（角色剧情扮演 / AI 文游 / AI 狼人杀）——
// 口径：roleplayCount 仍是**三者合计**（老数据不断层），rpModes 负责拆开看「玩的是哪一个」。

test('剧情模式：三模式各自计数，合计与明细同时增长（合计 ≡ 明细之和）', () => {
  const uid = 'act-modes-1';
  activityStore.trackFeature(uid, 'roleplay', { detail: '他等了我十五年', mode: 'roleplay' });
  activityStore.trackFeature(uid, 'roleplay', { detail: 'AI 文游', mode: 'wenyou' });
  activityStore.trackFeature(uid, 'roleplay', { detail: '10 人局', mode: 'werewolf' });
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.roleplayCount, 3, '合计仍是三者之和（口径不变）');
  assert.deepStrictEqual(rec.rpModes, { roleplay: 1, wenyou: 1, werewolf: 1 });
  assert.strictEqual(rec.lastMode, 'werewolf', '最近在玩的模式要记下来');
  const modes = rec.recentActivity.filter(i => i.feature === 'roleplay').map(i => i.mode).sort();
  assert.deepStrictEqual(modes, ['roleplay', 'wenyou', 'werewolf'], '每条最近活动都带模式');
});

test('剧情模式：mode 缺省 = 剧情扮演（老的调用点不改也正确）', () => {
  const uid = 'act-modes-default';
  activityStore.trackFeature(uid, 'roleplay', { detail: '未标模式的旧调用' });
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.rpModes!.roleplay, 1, '缺省按剧情扮演计');
  assert.strictEqual(rec.rpModes!.wenyou, 0);
  assert.strictEqual(rec.rpModes!.werewolf, 0);
  assert.strictEqual(rec.recentActivity[0].mode, 'roleplay');
});

test('剧情模式：mode 只对 roleplay 生效（聊一聊/理一理不受污染）', () => {
  const uid = 'act-modes-other';
  activityStore.trackFeature(uid, 'chat', { mode: 'werewolf' }); // 不该被当真
  activityStore.trackFeature(uid, 'structure', { mode: 'wenyou' });
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.roleplayCount, 0);
  assert.strictEqual(rec.rpModes!.werewolf, 0);
  assert.strictEqual(rec.rpModes!.wenyou, 0);
  assert.ok(!rec.lastMode, '非剧情功能不写 lastMode（它表达的是「最近一次剧情模式」）');
});

test('剧情模式：游客并入账号时模式明细一并合并（否则注册后文游/狼人杀在控制台消失）', () => {
  const guest = 'act-modes-guest';
  const acc = 'act-modes-acc';
  activityStore.trackFeature(guest, 'roleplay', { detail: 'AI 文游', mode: 'wenyou' });
  activityStore.trackFeature(guest, 'roleplay', { detail: '10 人局', mode: 'werewolf' });
  activityStore.trackFeature(acc, 'roleplay', { detail: '剧本A', mode: 'roleplay' });
  activityStore.mergeFrom(guest, acc);
  const rec = activityStore.get(acc)!;
  assert.strictEqual(rec.roleplayCount, 3, '合计 = 1 + 2');
  assert.deepStrictEqual(rec.rpModes, { roleplay: 1, wenyou: 1, werewolf: 1 }, '模式明细也要合并');
  assert.strictEqual(activityStore.get(guest), undefined, '游客记录已删除');
});

test('剧情模式：旧记录（无 rpModes）读回时归一化为全 0，不产生负数/NaN', async () => {
  // 升级前的 data/user-activity.json 里没有 rpModes 字段；loadFromDisk 用它归一化（同一条路径）
  const { normRoleplayModes } = await import('../../api/services/activity.js');
  assert.deepStrictEqual(normRoleplayModes(undefined), { roleplay: 0, wenyou: 0, werewolf: 0 }, '缺失 → 全 0（历史轮次只体现在 roleplayCount）');
  assert.deepStrictEqual(normRoleplayModes({}), { roleplay: 0, wenyou: 0, werewolf: 0 }, '空对象 → 全 0');
  assert.deepStrictEqual(normRoleplayModes({ wenyou: 3 }), { roleplay: 0, wenyou: 3, werewolf: 0 }, '缺键补 0');
  assert.deepStrictEqual(normRoleplayModes({ wenyou: -5, werewolf: 'x' }), { roleplay: 0, wenyou: 0, werewolf: 0 }, '脏值不产生负数/NaN');
});

/**
 * 📤 复制邀请链接（2026-09-29）：运营端要能看出「复制过链接」的人——
 * 只看结果（拉来几个人）分不出「复制了但没人注册」和「压根不知道有这个入口」。
 */
test('邀请复制：累计次数 + 最近时间；不影响活跃口径', () => {
  const uid = 'act-invite-copy';
  assert.strictEqual(activityStore.get(uid), undefined, '初始无记录');
  const before = Date.now();
  activityStore.trackInviteCopy(uid, { ip: '1.2.3.4', country: 'hk' });
  activityStore.trackInviteCopy(uid);
  const rec = activityStore.get(uid)!;
  assert.strictEqual(rec.inviteCopyCount, 2, '复制两次 = 2');
  assert.ok((rec.inviteCopiedAt || 0) >= before, '记最近一次复制时间');
  assert.strictEqual(rec.lastIp, '1.2.3.4');
  assert.strictEqual(rec.lastCountry, 'HK', '国家码大写归一');
  // 关键口径：复制链接**不算用产品**，否则「流失/未活跃」分桶会把只复制过链接的人算成活跃
  assert.strictEqual(rec.chatCount, 0);
  assert.strictEqual(rec.roleplayCount, 0);
  assert.strictEqual(rec.loginCount, 0);
  assert.strictEqual(rec.lastFeature, null, '没有功能使用记录');
});

test('邀请复制：游客期的复制次数并入账号（注册后不清零）', () => {
  const guest = 'act-invite-guest';
  const acc = 'act-invite-acc';
  activityStore.trackInviteCopy(guest);
  activityStore.trackInviteCopy(guest);
  activityStore.trackInviteCopy(acc);
  activityStore.mergeFrom(guest, acc);
  const rec = activityStore.get(acc)!;
  assert.strictEqual(rec.inviteCopyCount, 3, '合并 = 2 + 1');
  assert.ok(rec.inviteCopiedAt, '合并后保留最近复制时间');
  assert.strictEqual(activityStore.get(guest), undefined, '游客记录已删除');
});
