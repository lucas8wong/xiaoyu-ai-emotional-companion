import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { reengageStore, planCandidates, isCrisisSafe, parseHookJson, fallbackHook, unsubscribeToken, backfillReturnsOnStartup, listOutreachSubjects, fetchTodayNews } = await import('../../api/services/reengage.js');
const { accountStore } = await import('../../api/services/accounts.js');
const { activityStore } = await import('../../api/services/activity.js');
const { roleplaySessionStore } = await import('../../api/services/roleplaySessions.js');
const { default: memoryStorage } = await import('../../api/storage/memory.js');
const { preferenceStore } = await import('../../api/services/preferences.js');
const { pushSubscriptionStore } = await import('../../api/services/push.js');

const DAY = 24 * 60 * 60 * 1000;
const past = () => Date.now() - 30 * DAY;

test('isCrisisSafe：自伤/自杀内容应被召回拦截', () => {
  assert.strictEqual(isCrisisSafe('我今天真的很想自杀'), false);
  assert.strictEqual(isCrisisSafe('有点难过，想找人聊聊'), true);
  assert.strictEqual(isCrisisSafe(''), true);
});

test('parseHookJson：能解析带代码块围栏的 JSON 输出', () => {
  const out = parseHookJson('```json\n{"subject":"回来吧","body":"我还在这儿等你。"}\n```');
  assert.ok(out);
  assert.strictEqual(out!.subject, '回来吧');
  assert.strictEqual(out!.body, '我还在这儿等你。');
});

test('parseHookJson：非 JSON / 缺字段返回 null', () => {
  assert.strictEqual(parseHookJson('不是 JSON'), null);
  assert.strictEqual(parseHookJson('{"body":"只有正文"}'), null);
});

test('fallbackHook：按场景与语言给出兜底文案', () => {
  const zh = fallbackHook('chat', 'zh-CN');
  assert.ok(zh.subject && zh.body);
  const roleplay = fallbackHook('roleplay', 'zh-TW');
  assert.ok(roleplay.body.includes('故事') || roleplay.body.includes('剧情'));
  const en = fallbackHook('structure', 'en');
  assert.ok(/[a-z]/i.test(en.body));
});

test('unsubscribeToken：同一 userId 恒定、不同 userId 不同', () => {
  const t1 = unsubscribeToken('u1');
  assert.strictEqual(t1, unsubscribeToken('u1'));
  assert.notStrictEqual(t1, unsubscribeToken('u2'));
});

test('reengageStore：退订与冷却状态写入正确', () => {
  const uid = 're-optout';
  assert.strictEqual(reengageStore.isOptedOut(uid), false);
  reengageStore.optOut(uid);
  assert.strictEqual(reengageStore.isOptedOut(uid), true);
});

test('planCandidates：只挑「流失 + 未退订 + 无危机」的注册用户', () => {
  // A：流失的聊一聊用户 → 应命中
  const regA = accountStore.register({ email: 'a@x.com', password: 'password', username: 'a' });
  const A = regA.user!.userId;
  activityStore.trackFeature(A, 'chat');
  activityStore.get(A)!.lastActiveAt = past();

  // B：仍活跃（最近才用）→ 不命中
  const regB = accountStore.register({ email: 'b@x.com', password: 'password', username: 'b' });
  const B = regB.user!.userId;
  activityStore.trackFeature(B, 'chat'); // lastActiveAt = now

  // C：流失的剧情用户（有剧本会话）→ 命中
  const regC = accountStore.register({ email: 'c@x.com', password: 'password', username: 'c' });
  const C = regC.user!.userId;
  activityStore.trackFeature(C, 'roleplay', { detail: '他等了我十五年' });
  activityStore.get(C)!.lastActiveAt = past();
  roleplaySessionStore.save(C, 'scenario-1', [{ role: 'assistant', content: '你可算回来了，我一直在这儿等你。' }]);

  // D：流失但已退订 → 不命中
  const regD = accountStore.register({ email: 'd@x.com', password: 'password', username: 'd' });
  const D = regD.user!.userId;
  activityStore.trackFeature(D, 'chat');
  activityStore.get(D)!.lastActiveAt = past();
  reengageStore.optOut(D);

  // E：流失但最近内容含自伤（危机）→ 不命中
  const regE = accountStore.register({ email: 'e@x.com', password: 'password', username: 'e' });
  const E = regE.user!.userId;
  activityStore.trackFeature(E, 'chat');
  activityStore.get(E)!.lastActiveAt = past();
  memoryStorage.createSession('session-e');
  memoryStorage.updateSession('session-e', { userId: E, chatMessages: [{ role: 'user', content: '我想自杀', timestamp: new Date() }] });

  const ids = planCandidates().map(c => c.userId);
  assert.ok(ids.includes(A), '流失的聊一聊用户应命中');
  assert.ok(ids.includes(C), '流失的剧情用户应命中');
  assert.ok(!ids.includes(B), '仍活跃的用户不应命中');
  assert.ok(!ids.includes(D), '已退订用户不应命中');
  assert.ok(!ids.includes(E), '危机（自伤）内容用户不应命中');
});

test('planCandidates：冷却期内不重复召回', () => {
  const reg = accountStore.register({ email: 'f@x.com', password: 'password', username: 'f' });
  const F = reg.user!.userId;
  activityStore.trackFeature(F, 'chat');
  activityStore.get(F)!.lastActiveAt = past();
  assert.ok(planCandidates().some(c => c.userId === F), '刚授信时应命中');
  reengageStore.markSent(F, 'chat', '上次话题');
  assert.ok(!planCandidates().some(c => c.userId === F), '冷却期内不应再次命中');
});

test('planCandidates：开启「AI 主动找我」且有订阅 → 走推送通道', () => {
  const reg = accountStore.register({ email: 'g@x.com', password: 'password', username: 'g' });
  const G = reg.user!.userId;
  activityStore.trackFeature(G, 'chat');
  activityStore.get(G)!.lastActiveAt = past();
  preferenceStore.set(G, { proactivePush: true });
  pushSubscriptionStore.add(G, { endpoint: 'https://push.example/g', keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } });
  const cand = planCandidates().find(c => c.userId === G);
  assert.ok(cand, '应命中');
  assert.strictEqual(cand!.channel, 'push');
});

test('planCandidates：主动找我频率控制推送冷却（常来短/偶尔长）', () => {
  // 常来：2 天前发过，但冷却=1 天 → 应再次命中
  const regF = accountStore.register({ email: 'freq@x.com', password: 'password', username: 'freq' });
  const F = regF.user!.userId;
  activityStore.trackFeature(F, 'chat');
  activityStore.get(F)!.lastActiveAt = past();
  preferenceStore.set(F, { proactivePush: true, proactiveFrequency: 'frequent' });
  pushSubscriptionStore.add(F, { endpoint: 'https://push.example/freq', keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } });
  reengageStore.markSent(F, 'chat', 't');
  reengageStore.get(F)!.lastSentAt = Date.now() - 2 * DAY;
  assert.ok(planCandidates().some(c => c.userId === F && c.channel === 'push'), 'frequent 冷却短，应再次命中');

  // 偶尔：2 天前发过，但冷却=10 天 → 不应命中
  const regO = accountStore.register({ email: 'occ@x.com', password: 'password', username: 'occ' });
  const O = regO.user!.userId;
  activityStore.trackFeature(O, 'chat');
  activityStore.get(O)!.lastActiveAt = past();
  preferenceStore.set(O, { proactivePush: true, proactiveFrequency: 'occasional' });
  pushSubscriptionStore.add(O, { endpoint: 'https://push.example/occ', keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } });
  reengageStore.markSent(O, 'chat', 't');
  reengageStore.get(O)!.lastSentAt = Date.now() - 2 * DAY;
  assert.ok(!planCandidates().some(c => c.userId === O), 'occasional 冷却长，不应再次命中');
});

test('planCandidates：主动找我但无推送订阅 → 邮件兜底（用短阈值）', () => {
  const reg = accountStore.register({ email: 'pad@x.com', password: 'password', username: 'pad' });
  const P = reg.user!.userId;
  activityStore.trackFeature(P, 'chat');
  // 2 天前用过：> 推送短阈值(1 天) 但 < 邮件长阈值(7 天) → 主动找我应仍命中且走邮件
  activityStore.get(P)!.lastActiveAt = Date.now() - 2 * DAY;
  preferenceStore.set(P, { proactivePush: true, proactiveFrequency: 'random' });
  const cand = planCandidates().find(c => c.userId === P);
  assert.ok(cand, '主动找我（无推送订阅）应命中');
  assert.strictEqual(cand!.channel, 'email', '无推送订阅应走邮件兜底（短阈值）');
});

test('reengageStore：被召回用户「回来」即记回访，且同一封召回只记一次', () => {
  const reg = accountStore.register({ email: 'ret@x.com', password: 'password', username: 'ret' });
  const U = reg.user!.userId;
  activityStore.trackFeature(U, 'chat');

  // 发信后用户回 App 用功能 → 计一次回访（无需点邮件按钮）
  reengageStore.markSent(U, 'chat', '上次话题');
  activityStore.trackFeature(U, 'chat');
  assert.strictEqual(reengageStore.getStats(U).returned, 1, '回 App 活跃后应计 1 次回访');

  // 同一封召回：再活跃不应重复计
  activityStore.trackFeature(U, 'chat');
  assert.strictEqual(reengageStore.getStats(U).returned, 1, '同一封召回只计一次回访');

  // 没被召回过的用户活跃不计回访
  const reg2 = accountStore.register({ email: 'ret2@x.com', password: 'password', username: 'ret2' });
  const U2 = reg2.user!.userId;
  activityStore.trackFeature(U2, 'chat');
  assert.strictEqual(reengageStore.getStats(U2).returned, 0, '无召回则不产生回访');

  // 再次召回（重新发信）后回来 → 应再计一次（同一用户累计 2 次）
  reengageStore.markSent(U, 'chat', '上次话题2');
  activityStore.trackFeature(U, 'chat');
  assert.strictEqual(reengageStore.getStats(U).returned, 2, '第二次召回后回来应再计一次');
});

test('reengageStore：启动回填——召回后已回来但未计回访的补计一次', () => {
  const reg = accountStore.register({ email: 'bf@x.com', password: 'password', username: 'bf' });
  const U = reg.user!.userId;
  activityStore.trackFeature(U, 'chat');
  reengageStore.markSent(U, 'chat', '上次话题');
  // 用户后来回来了（把 lastActiveAt 调到发信之后），但旧逻辑没记 return
  activityStore.get(U)!.lastActiveAt += 5000;
  backfillReturnsOnStartup();
  assert.strictEqual(reengageStore.getStats(U).returned, 1, '回填应补计一次回访');
  // 再回填一次也应幂等（不重复计）
  backfillReturnsOnStartup();
  assert.strictEqual(reengageStore.getStats(U).returned, 1, '回填幂等，不重复计');
});

test('listOutreachSubjects：枚举聊一聊(按角色) / 剧本 / 理一理', () => {
  const reg = accountStore.register({ email: 'sub@x.com', password: 'password', username: 'sub' });
  const U = reg.user!.userId;
  activityStore.trackFeature(U, 'chat', { detail: '聊一聊' });
  memoryStorage.createSession('s-one');
  memoryStorage.updateSession('s-one', { userId: U, characterId: 'xiaoyu', chatMessages: [{ role: 'user', content: '早上好', timestamp: new Date() }] });
  memoryStorage.createSession('s-two');
  memoryStorage.updateSession('s-two', { userId: U, characterId: 'cc_x', chatMessages: [{ role: 'user', content: '嗨', timestamp: new Date() }] });
  roleplaySessionStore.save(U, 'scenario-1', [{ role: 'assistant', content: '等你很久了', timestamp: Date.now() }]);
  activityStore.trackFeature(U, 'structure');
  const keys = listOutreachSubjects(U).map(s => s.key);
  assert.ok(keys.includes('chat::xiaoyu'), '应包含聊一聊·小愈');
  assert.ok(keys.includes('chat::cc_x'), '应包含聊一聊·自定义角色');
  assert.ok(keys.includes('roleplay::scenario-1'), '应包含剧本');
  assert.ok(keys.includes('structure'), '应包含理一理');
});

test('markSent：记录对象级冷却与当日预算', () => {
  const reg = accountStore.register({ email: 'ms@x.com', password: 'password', username: 'ms' });
  const U = reg.user!.userId;
  reengageStore.markSent(U, 'chat', 't', { subjectKey: 'chat::xiaoyu', intent: 'daily', channel: 'push' });
  const rec = reengageStore.get(U)!;
  assert.ok(rec.lastOutreachAt && rec.lastOutreachAt['chat::xiaoyu'] > 0, '应记录对象级冷却');
  assert.strictEqual(rec.sentToday, 1, '应记录当日预算');
  assert.strictEqual(rec.lastIntent, 'daily');
});

test('muteSubject：静音对象后 planCandidates 不再命中', () => {
  const reg = accountStore.register({ email: 'mut@x.com', password: 'password', username: 'mut' });
  const U = reg.user!.userId;
  activityStore.trackFeature(U, 'chat');
  activityStore.get(U)!.lastActiveAt = past();
  memoryStorage.createSession('sm');
  memoryStorage.updateSession('sm', { userId: U, chatMessages: [{ role: 'user', content: '我很难受', timestamp: new Date() }] });
  reengageStore.muteSubject(U, 'chat::xiaoyu');
  assert.ok(!planCandidates().some(c => c.userId === U), '静音后不应命中');
  reengageStore.unmuteSubject(U, 'chat::xiaoyu');
  assert.ok(planCandidates().some(c => c.userId === U), '取消静音后应命中');
});

test('planCandidates：intense 每日预算达到上限则不命中', () => {
  const reg = accountStore.register({ email: 'int@x.com', password: 'password', username: 'int' });
  const U = reg.user!.userId;
  activityStore.trackFeature(U, 'chat');
  activityStore.get(U)!.lastActiveAt = past();
  preferenceStore.set(U, { proactivePush: true, proactiveFrequency: 'intense' });
  pushSubscriptionStore.add(U, { endpoint: 'https://push.example/int', keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } });
  const today = new Date().toLocaleDateString('en-CA').replace(/\//g, '-');
  reengageStore.markSent(U, 'chat', 't');
  reengageStore.get(U)!.sentDate = today;
  reengageStore.get(U)!.sentToday = 10;
  assert.ok(!planCandidates().some(c => c.userId === U), '达到每日上限应不命中');
  reengageStore.get(U)!.sentToday = 9;
  assert.ok(planCandidates().some(c => c.userId === U), '未达上限应命中');
});

test('fetchTodayNews：未配置 feed 时返回空数组', async () => {
  const news = await fetchTodayNews();
  assert.ok(Array.isArray(news));
});
