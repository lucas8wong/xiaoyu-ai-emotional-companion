import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { roleplaySessionStore, dropsSavedReply } = await import('../../api/services/roleplaySessions.js');

const u = 'user1';
const sc = 'scenario1';

test('save/get：保存消息、按序返回', () => {
  roleplaySessionStore.save(u, sc, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ]);
  const msgs = roleplaySessionStore.get(u, sc);
  assert.ok(msgs);
  assert.strictEqual(msgs!.length, 2);
  assert.strictEqual(msgs![0].role, 'user');
  assert.strictEqual(msgs![1].content, '你好呀');
});

test('🔀 双模式：单角色线 / 多角色线各一份存档，互不覆盖、只清自己那条', () => {
  const u2 = 'user-dualmode';
  const s2 = 'sc-dualmode';
  roleplaySessionStore.save(u2, s2, [{ role: 'user', content: '单角色第一句' }, { role: 'assistant', content: '单角色回复' }], undefined, undefined, 'solo');
  roleplaySessionStore.save(u2, s2, [{ role: 'user', content: '多角色第一句' }, { role: 'assistant', content: '【李嬷嬷】多角色回复' }], undefined, undefined, 'multi');

  const solo = roleplaySessionStore.get(u2, s2, 'solo')!;
  const multi = roleplaySessionStore.get(u2, s2, 'multi')!;
  assert.strictEqual(solo[0].content, '单角色第一句');
  assert.strictEqual(multi[0].content, '多角色第一句', '两条线不能互相覆盖');

  // 不传 mode → 取**最近更新**的那份（multi 后写，所以是 multi）
  assert.strictEqual(roleplaySessionStore.get(u2, s2)![0].content, '多角色第一句');

  // 删 solo 不影响 multi（「重新开始」只该清当前那条线）
  roleplaySessionStore.delete(u2, s2, 'solo');
  assert.strictEqual(roleplaySessionStore.get(u2, s2, 'solo'), null);
  assert.ok(roleplaySessionStore.get(u2, s2, 'multi'), '删一条线不能把另一条也清掉');

  // 「与你的旅程」的足迹按剧本去重：同一剧本两条线只应出现一次
  const list = roleplaySessionStore.listByUser(u2).filter(x => x.scenarioId === s2);
  assert.strictEqual(list.length, 1, 'listByUser 必须按场景去重');
  assert.strictEqual(list[0].mode, 'multi', '去重保留最近更新的那条');
});

test('🔀 双模式：老数据（无 mode）当 solo，绝不串到多角色线', () => {
  const u3 = 'user-legacy';
  const s3 = 'sc-legacy';
  // 不传 mode = 老调用方口径（solo）
  roleplaySessionStore.save(u3, s3, [{ role: 'user', content: '老存档' }, { role: 'assistant', content: '老回复' }]);
  assert.strictEqual(roleplaySessionStore.get(u3, s3, 'solo')![0].content, '老存档');
  assert.strictEqual(roleplaySessionStore.get(u3, s3, 'multi'), null, '老存档不能被当成多角色线');
  const rec = roleplaySessionStore.listAll().find(r => r.userId === u3 && r.scenarioId === s3);
  assert.strictEqual(rec?.mode, 'solo', '落盘时要写上 mode=solo，迁移才算完成');
});

test('save 过滤非法消息 + 裁剪内容 + 空消息 no-op', () => {
  roleplaySessionStore.save(u, sc, [
    { role: 'user', content: '有效' },
    { role: 'bogus', content: '无效' } as any,
    { role: 'assistant', content: '有效2' },
  ]);
  const msgs = roleplaySessionStore.get(u, sc)!;
  assert.strictEqual(msgs.length, 2, '只保留合法 role，丢弃非法 role');
  assert.strictEqual(msgs[0].content, '有效');

  // 内容超长裁剪到 4000
  const long = 'x'.repeat(5000);
  roleplaySessionStore.save(u, sc, [{ role: 'user', content: long }]);
  assert.strictEqual(roleplaySessionStore.get(u, sc)![0].content.length, 4000);

  // 空消息数组不写库（get 返回 null）
  roleplaySessionStore.save(u, 'no-messages', []);
  assert.strictEqual(roleplaySessionStore.get(u, 'no-messages'), null);
});

test('🚨 服务端护栏：失败兜底/系统提示文案不得落盘为角色台词（2026-09-15 事故）', () => {
  const sid = 'sc-fallback-guard';
  roleplaySessionStore.save(u, sid, [
    { role: 'assistant', content: '夜店门口那道低音鼓又闷闷地滚过一轮。' },
    { role: 'user', content: '我是傻子吗，叔叔' },
    { role: 'assistant', content: '网络好像开小差了，稍后再试试好吗？🌱' },
    { role: 'assistant', content: '生成失败，请稍后重试' },
    { role: 'assistant', content: 'Network hiccup — let us try again in a moment 🌱' },
    // 2026-09-18：额度/付费文案同属这一类（线上真实数据里留了 5 条），服务端这一层也要拦住
    { role: 'assistant', content: '免費次數已用完，請付費解鎖後繼續使用。' },
    { role: 'assistant', content: '免费次数已用完，请付费解锁后继续使用' },
  ]);
  const msgs = roleplaySessionStore.get(u, sid)!;
  assert.deepStrictEqual(msgs.map((m) => m.content), [
    '夜店门口那道低音鼓又闷闷地滚过一轮。',
    '我是傻子吗，叔叔',
  ], '兜底文案应被丢弃，真实对白保留');
  assert.strictEqual(msgs.filter((m) => m.role === 'assistant').length, 1);

  // 反向：正文里出现「没听清」等字样、或兜底串被包在台词里，都不该被误删
  const sid2 = 'sc-fallback-keep';
  roleplaySessionStore.save(u, sid2, [
    { role: 'assistant', content: '他没听清，又靠近了半步。' },
    { role: 'assistant', content: '（网络好像开小差了，稍后再试试好吗？🌱 他念完这句就笑了）' },
    { role: 'user', content: '网络好像开小差了，稍后再试试好吗？🌱' }, // 用户自己也可能这么说，不能替用户删
  ]);
  assert.strictEqual(roleplaySessionStore.get(u, sid2)!.length, 3);
});

test('消息上限：只保留最近 200 条', () => {
  const msgs = Array.from({ length: 210 }, (_, i) => ({ role: 'user' as const, content: 'msg' + i }));
  roleplaySessionStore.save(u, sc, msgs);
  const got = roleplaySessionStore.get(u, sc)!;
  assert.strictEqual(got.length, 200);
  assert.strictEqual(got[0].content, 'msg10', '应丢弃最旧的 10 条');
});

test('getRecord / getPreference', () => {
  roleplaySessionStore.save(u, sc, [{ role: 'user', content: 'x' }], '想要黑化结局');
  const rec = roleplaySessionStore.getRecord(u, sc);
  assert.strictEqual(rec.messages!.length, 1);
  assert.strictEqual(rec.userPreference, '想要黑化结局');
  assert.strictEqual(roleplaySessionStore.getPreference(u, sc), '想要黑化结局');
  assert.strictEqual(roleplaySessionStore.getPreference(u, 'other'), '');
});

test('savePreference 不覆盖消息', () => {
  roleplaySessionStore.save(u, sc, [{ role: 'user', content: 'a' }], '旧偏好');
  roleplaySessionStore.savePreference(u, sc, '新偏好');
  const rec = roleplaySessionStore.getRecord(u, sc);
  assert.strictEqual(rec.userPreference, '新偏好');
  assert.strictEqual(rec.messages!.length, 1, 'savePreference 不应清空消息');
});

test('🚨 护栏：拒绝「未完成回合」的截断写（2026-09-18 Twinkle 案）', () => {
  const sid = 'sc-unanswered-guard';
  const full = [
    { role: 'user' as const, content: '开场' },
    { role: 'assistant' as const, content: '开场白' },
    { role: 'user' as const, content: '你快点到好不好' },
    { role: 'assistant' as const, content: '（他听见了）……' },
  ];
  roleplaySessionStore.save(u, sid, full);
  assert.strictEqual(roleplaySessionStore.get(u, sid)!.length, 4);

  // 客户端「重新生成」的截断态：与库里逐条同前缀、以 user 结尾、比库里短 → 拒写，回复保住
  const truncated = full.slice(0, 3);
  const r = roleplaySessionStore.save(u, sid, truncated);
  assert.strictEqual(r.saved, false);
  assert.strictEqual(r.blocked, 'UNANSWERED_TURN');
  assert.strictEqual(roleplaySessionStore.get(u, sid)!.length, 4, '已生成的回复不能被静默抹掉');
  assert.strictEqual(roleplaySessionStore.get(u, sid)![3].content, '（他听见了）……');

  // 新回复回来后（以 assistant 结尾）→ 正常覆盖，重生成的正经用法不受影响
  const regenerated = [...truncated, { role: 'assistant' as const, content: '（新的这一版）' }];
  assert.deepStrictEqual(roleplaySessionStore.save(u, sid, regenerated), { saved: true });
  assert.strictEqual(roleplaySessionStore.get(u, sid)!.length, 4);
  assert.strictEqual(roleplaySessionStore.get(u, sid)![3].content, '（新的这一版）');

  // 续写/发送新消息（前缀不同）→ 正常写：不算截断
  const nextTurn = [...roleplaySessionStore.get(u, sid)!, { role: 'user' as const, content: '嗯' }];
  assert.deepStrictEqual(roleplaySessionStore.save(u, sid, nextTurn), { saved: true });
  assert.strictEqual(roleplaySessionStore.get(u, sid)!.length, 5, '尾部这条 user 是**新**的一句，得存下来');
});

test('dropsSavedReply 判据：只在「更短 + 逐条同前缀 + 以 user 结尾 + 截掉的是 AI 回复」时成立', () => {
  const prev = [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b' },
    { role: 'assistant' as const, content: 'B' },
  ];
  assert.strictEqual(dropsSavedReply(prev, prev.slice(0, 3)), true, '典型：截掉最后一条回复');
  assert.strictEqual(dropsSavedReply(prev, prev), false, '同长度不算');
  assert.strictEqual(dropsSavedReply(prev, [...prev, { role: 'user', content: 'c' }]), false, '更长不算');
  assert.strictEqual(dropsSavedReply(prev, prev.slice(0, 2)), false, '以 assistant 结尾不算（重生成后作废后续对话是正常操作）');
  assert.strictEqual(dropsSavedReply(undefined, prev.slice(0, 3)), false, '库里没有记录时不算');
  // 前缀不同：用户又发了一句一模一样的话（新内容）→ 不能当成截断写拦住
  const sameTail = [
    { role: 'user' as const, content: 'x' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'a' },
  ];
  assert.strictEqual(dropsSavedReply(prev, sameTail), false);
  // 被截掉的那一段里没有 assistant → 不算（这一句本来就没回复，谈不上「抹掉回复」）
  const usersOnly = [
    { role: 'user' as const, content: 'a' },
    { role: 'user' as const, content: 'b' },
    { role: 'user' as const, content: 'c' },
  ];
  assert.strictEqual(dropsSavedReply(usersOnly, usersOnly.slice(0, 2)), false);
});

/**
 * 2026-09「编辑重发」加的判据 2b：末条允许被**改写**。
 *
 * 为什么必须有：编辑重发走的是「改掉最后一句 → 先把其后回复截掉 → 拿新回复」这条路，
 * 中间态的最后一条内容变了，旧判据的「一字不差的前缀」不成立 → 会被真的写下去，
 * 于是改完就走人 = 库里永久停在一条没人回的改写句上（就是本文件开头那场事故的形态）。
 */
test('dropsSavedReply 判据 2b：改写最后一句的截断态同样拒写', () => {
  const prev = [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b' },
    { role: 'assistant' as const, content: 'B' },
  ];
  const edited = [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b2' }, // 改写了最后一句，回复 B 被截掉
  ];
  assert.strictEqual(dropsSavedReply(prev, edited), true, '改写最后一句的中间态要拦');
  // 新回复回来后（更长 + 以 assistant 结尾）正常写
  assert.strictEqual(dropsSavedReply(prev, [...edited, { role: 'assistant' as const, content: 'B2' }]), false);
  // 被改写的那句本来就没回复（截掉的那段里没有 assistant）→ 判据 4 不成立，不拦
  assert.strictEqual(dropsSavedReply([
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b' },
  ], [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b2' },
  ]), false);
  // 差异出现在末条**之前** → 不是「截尾」，一律不拦（宁可漏拦，避免误伤跨设备/旧客户端的合法写入）
  assert.strictEqual(dropsSavedReply(prev, [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A2' },
    { role: 'user' as const, content: 'b2' },
  ]), false);
  // 用户新发一句（更长）不拦；切换分支（等长）不拦
  assert.strictEqual(dropsSavedReply(prev, [...prev, { role: 'user' as const, content: 'c' }]), false);
  assert.strictEqual(dropsSavedReply(prev, [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'A' },
    { role: 'user' as const, content: 'b3' },
    { role: 'assistant' as const, content: 'B' },
  ]), false, '切换分支是等长写入');
  /**
   * 🔴 判据 2b 的边界（`last >= 1`）：**整份历史被替换成一条内容不同的用户消息**。
   *
   * 这条不是假想用例 —— `test/unit/roleplaySessions.test.ts` 里那条既有用例
   *（「save 过滤非法消息 + 裁剪内容」把 5000 字长文本存成单条消息）真的把它踩出来了：
   * 起初 2b 不带 `last >= 1`，那次**合法**写入被误拦，库里留的还是旧内容（断言 4000 拿到 2）。
   */
  assert.strictEqual(dropsSavedReply(
    [{ role: 'user' as const, content: '有效' }, { role: 'assistant' as const, content: '有效2' }],
    [{ role: 'user' as const, content: 'x'.repeat(5000) }],
  ), false, '第 0 条被改写 = 整段历史被换掉，属合法写入，不许拦');
});

test('护栏判据与前端自动保存共用同一份实现（src/lib/rpWriteGuard.ts，2026-09-18 第二版）', async () => {
  const lib = await import('../../src/lib/rpWriteGuard.js');
  assert.strictEqual(dropsSavedReply, lib.dropsSavedReply, '服务端 re-export 的必须是前端那份，否则两边判据会漂移');
  // 结构型入参：前端消息对象（另一套类型）也能直接判
  assert.strictEqual(lib.dropsSavedReply([{ role: 'user', content: 'a' }], [{ role: 'user', content: 'a' }]), false);
});

test('用户隔离 + delete + deleteByUser + listAll', () => {
  const before = roleplaySessionStore.listAll().length;
  roleplaySessionStore.save('uA', sc, [{ role: 'user', content: 'a' }]);
  assert.strictEqual(roleplaySessionStore.get('uB', sc), null, '跨用户不可见');
  assert.strictEqual(roleplaySessionStore.listAll().length, before + 1);

  roleplaySessionStore.delete('uA', sc);
  assert.strictEqual(roleplaySessionStore.get('uA', sc), null);
  assert.strictEqual(roleplaySessionStore.listAll().length, before);

  roleplaySessionStore.save('uDel', sc, [{ role: 'user', content: 'x' }]);
  roleplaySessionStore.deleteByUser('uDel');
  assert.strictEqual(roleplaySessionStore.get('uDel', sc), null);
});

test('reassignUser：游客并入账号，账号已有同剧本保留更新更晚的', () => {
  // 先写账号（较旧），再写游客（较新）→ 合并后应保留游客
  roleplaySessionStore.save('acc', 's1', [{ role: 'assistant', content: 'a' }], 'apref');
  roleplaySessionStore.save('guest', 's1', [{ role: 'user', content: 'g' }], 'gpref');

  roleplaySessionStore.reassignUser('guest', 'acc');
  const rec = roleplaySessionStore.getRecord('acc', 's1');
  assert.strictEqual(rec.messages![0].content, 'g', 'guest 更新更晚则覆盖账号');
  assert.strictEqual(rec.userPreference, 'gpref');
  assert.strictEqual(roleplaySessionStore.get('guest', 's1'), null, '旧游客 key 应被删除');

  // 游客较旧 → 保账号
  roleplaySessionStore.save('guest2', 's2', [{ role: 'user', content: 'g2' }]);
  roleplaySessionStore.save('acc2', 's2', [{ role: 'assistant', content: 'a2' }]);
  roleplaySessionStore.reassignUser('guest2', 'acc2');
  assert.strictEqual(roleplaySessionStore.getRecord('acc2', 's2').messages![0].content, 'a2');
});
