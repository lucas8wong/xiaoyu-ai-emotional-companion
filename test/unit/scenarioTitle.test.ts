/**
 * 剧情标题统一解析单元测试（`api/services/scenarioTitle.ts`）
 *
 * 需求背景（2026-09-17 用户拍板）：「与你的旅程」和控制台里，用户自建（含 AI 代写）的剧情
 * **不许再显示「自定义剧情」或 custom_xxx 内部 id**，要显示用户自己起的剧名，另给一个「自建」标志。
 *
 * 覆盖：
 *  - id 前缀判定（角色扮演 `custom_` 与千世书 `custom-` 两种都要认）
 *  - 自建剧本解析链：本人 > 公开 > 跨用户 > 会话标题快照
 *  - 没起名的占位标题（create() 默认值「自定义剧情」）不算真名
 *  - 千世书：内置书 / 本人自建 / 跨用户自建 / **存档里内嵌的 scenario.title**
 *  - 官方剧本仍按界面语言本地化，且不带 custom 标志
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { customRoleplayStore } = await import('../../api/services/customRoleplay.js');
const { wenyouScenariosStore } = await import('../../api/services/wenyouScenarios.js');
const { wenyouSavesStore } = await import('../../api/services/wenyouSaves.js');
const { listScenarios } = await import('../../api/services/roleplay.js');
const { resolveRoleplayTitle, resolveWenyouTitle, isCustomScenarioId } = await import('../../api/services/scenarioTitle.js');

function makeCustom(userId: string, title: string) {
  return customRoleplayStore.create(userId, { title, aiName: '墨白', aiPersona: '人设', background: '背景', opening: '开场' });
}

test('isCustomScenarioId：两套自建 id 前缀都要认，内置剧本不能误判', () => {
  assert.strictEqual(isCustomScenarioId('custom_mtqy8099ib3dmt'), true, '角色扮演自建：下划线');
  assert.strictEqual(isCustomScenarioId('custom-ab12cd'), true, '千世书自建：连字符');
  assert.strictEqual(isCustomScenarioId('CUSTOM_AB'), true, '大小写不敏感');
  assert.strictEqual(isCustomScenarioId('xian'), false, '内置文游书');
  assert.strictEqual(isCustomScenarioId(''), false);
  assert.strictEqual(isCustomScenarioId(undefined), false);
});

test('自建剧本：显示用户自己起的剧名 + custom 标志（本人 / 跨用户都能解析）', () => {
  const rec = makeCustom('uOwner', '虚空一脈');
  const own = resolveRoleplayTitle(rec.id, 'uOwner', 'zh');
  assert.strictEqual(own.title, '虚空一脈');
  assert.strictEqual(own.custom, true);

  // 跨用户兜底：会话归属错位（游客建剧本 → 注册并入账号）也不该退回内部 id
  const other = resolveRoleplayTitle(rec.id, 'uStranger', 'zh');
  assert.strictEqual(other.title, '虚空一脈');
  assert.strictEqual(other.custom, true);
  assert.notStrictEqual(other.title, rec.id, '绝不把 custom_ 内部 id 当剧名');
});

test('自建剧本已删除：回退会话里的标题快照，仍显示真名 + 标出 deleted', () => {
  const rec = makeCustom('uDel', '雨夜咖啡馆');
  const before = resolveRoleplayTitle(rec.id, 'uDel', 'zh', '雨夜咖啡馆');
  assert.strictEqual(before.title, '雨夜咖啡馆');
  assert.strictEqual(before.deleted, false, '剧本还在 → 不是已删');
  customRoleplayStore.delete('uDel', rec.id);
  // 剧本没了、快照还在 → 仍是真名，不会变成「自定义剧情」，但要标出已删（用户口径：看得出来是已删的）
  const after = resolveRoleplayTitle(rec.id, 'uDel', 'zh', '雨夜咖啡馆');
  assert.strictEqual(after.title, '雨夜咖啡馆');
  assert.strictEqual(after.custom, true);
  assert.strictEqual(after.deleted, true);
  // 连快照都没有 → 空串 + deleted（前端显示「自建剧情 · 已删」，服务端不写占位）
  const bare = resolveRoleplayTitle(rec.id, 'uDel', 'zh');
  assert.strictEqual(bare.title, '');
  assert.strictEqual(bare.custom, true);
  assert.strictEqual(bare.deleted, true);
});

test('没起名的占位标题（create 默认「自定义剧情」）不算真名', () => {
  const rec = customRoleplayStore.create('uBlank', { aiName: '', aiPersona: '人设', background: '背景', opening: '开场' });
  assert.strictEqual(rec.title, '自定义剧情', 'store 默认值保持原样（本次只改显示口径）');
  const r = resolveRoleplayTitle(rec.id, 'uBlank', 'zh');
  assert.strictEqual(r.title, '', '连角色名都没有 → 空串，交给前端兜底文案');
  assert.strictEqual(r.custom, true);
  // 快照若是占位标题，也要被过滤
  assert.strictEqual(resolveRoleplayTitle(rec.id, 'uBlank', 'zh', '自定义剧情').title, '');
  assert.strictEqual(resolveRoleplayTitle(rec.id, 'uBlank', 'zh', '用户后来起的名字').title, '用户后来起的名字');
});

test('没起名但有 AI 角色名：兜出「与X的故事」（线上 5 个剧本就是这种，别再显示「自定义剧情」）', () => {
  const rec = makeCustom('uNoTitle', '自定义剧情'); // aiName = 墨白
  assert.strictEqual(rec.title, '自定义剧情');
  assert.strictEqual(resolveRoleplayTitle(rec.id, 'uNoTitle', 'zh').title, '与墨白的故事');
  assert.strictEqual(resolveRoleplayTitle(rec.id, 'uNoTitle', 'zh-TW').title, '與墨白的故事');
  assert.strictEqual(resolveRoleplayTitle(rec.id, 'uNoTitle', 'en').title, 'A story with 墨白');
  // 真名永远优先于派生名
  const named = makeCustom('uNoTitle2', '聚光灯之外');
  assert.strictEqual(resolveRoleplayTitle(named.id, 'uNoTitle2', 'zh').title, '聚光灯之外');
});

test('官方剧本：按界面语言本地化，不带 custom 标志；未知 id 原样返回', () => {
  const firstId = String(listScenarios('zh')[0]?.id ?? '');
  assert.ok(firstId, '官方剧本列表非空');
  const zh = resolveRoleplayTitle(firstId, 'uAny', 'zh');
  assert.strictEqual(zh.custom, false);
  assert.strictEqual(zh.deleted, false, '官方剧本不会被标「已删」');
  assert.ok(zh.title.length > 0, '官方剧本有本地化标题');
  assert.notStrictEqual(zh.title, firstId);
  assert.strictEqual(resolveRoleplayTitle(firstId, 'uAny', 'en').custom, false);

  const unknown = resolveRoleplayTitle('no_such_scenario', 'uAny', 'zh');
  assert.strictEqual(unknown.title, 'no_such_scenario');
  assert.strictEqual(unknown.custom, false);
  assert.strictEqual(unknown.deleted, false);
});

test('千世书：内置书用内置书名，不是自建', () => {
  assert.deepStrictEqual(resolveWenyouTitle('xian', 'uAny'), { title: '缥缈仙途', custom: false, deleted: false });
});

test('千世书自建书：本人 / 跨用户 / 存档内嵌标题三层兜底都要能解析出真名', () => {
  wenyouScenariosStore.set('uMine', [{ id: 'custom-mine', title: '我的江湖' }]);
  const mine = resolveWenyouTitle('custom-mine', 'uMine');
  assert.strictEqual(mine.title, '我的江湖');
  assert.strictEqual(mine.custom, true);

  // 剧本只挂在别人名下（列表是前端整表推送的，归属可能错位）→ 跨用户兜底
  const other = resolveWenyouTitle('custom-mine', 'uSomeoneElse');
  assert.strictEqual(other.title, '我的江湖');
  assert.strictEqual(other.custom, true);

  // 剧本列表彻底没了，但存档里内嵌了 scenario.title → 仍显示真名
  wenyouSavesStore.set('uArchived', {
    games: { 'custom-archived': { v: 2, scenario: { id: 'custom-archived', title: '存档里的那本书' }, state: { history: [] }, pendingTurn: null } },
    slots: [],
    endings: {},
    stats: null,
  });
  const archived = resolveWenyouTitle('custom-archived', 'uArchived');
  assert.strictEqual(archived.title, '存档里的那本书');
  assert.strictEqual(archived.custom, true);

  // 三层都查不到 → 空串 + custom 标志（前端显示「自建剧情」兜底，绝不露出 custom-xxx）
  // ⚠️ 千世书**不标「已删」**：书库是前端整表推送的，服务端查不到可能只是还没同步，误标比不标更糟
  const lost = resolveWenyouTitle('custom-gone', 'uNobody');
  assert.strictEqual(lost.title, '');
  assert.strictEqual(lost.custom, true);
  assert.strictEqual(lost.deleted, false, '千世书不下「已删」结论（权威在前端 localStorage）');
});
