import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { preferenceStore, resolveThinkingLevelFor } = await import('../../api/services/preferences.js');
const { quotaStore } = await import('../../api/services/quota.js');

test('get：新用户返回默认偏好', () => {
  const p = preferenceStore.get('newuser');
  assert.strictEqual(p.userId, 'newuser');
  assert.strictEqual(p.tone, 'warm');
  assert.strictEqual(p.storyStyle, 'poetic');
  assert.strictEqual(p.mode, 'hug');
  assert.strictEqual(p.language, 'zh-TW');
  assert.strictEqual(p.region, 'putonghua');
  assert.strictEqual(p.intensity, 'natural');
  assert.strictEqual(p.smartFitEnabled, true);
  assert.strictEqual(p.dataEnhance, true);
  assert.strictEqual(p.activityAwareness, true);
  assert.strictEqual(p.chatInnerMonologueEnabled, true);
  assert.strictEqual(p.roleplayInnerMonologueEnabled, true);
  const lp = p.learnedPreferences;
  assert.strictEqual(lp.directness, 0);
  assert.strictEqual(lp.warmth, 0);
  assert.strictEqual(lp.humor, 0);
  assert.ok(Object.keys(lp).length === 8);
});

test('set：部分更新不丢其它字段（undefined 过滤）', () => {
  const p = preferenceStore.set('u1', { language: 'en', mode: 'ally' });
  assert.strictEqual(p.language, 'en');
  assert.strictEqual(p.mode, 'ally');
  // 未提供的字段保留默认，不被 undefined 覆盖
  assert.strictEqual(p.tone, 'warm');
  assert.strictEqual(p.storyStyle, 'poetic');

  const p2 = preferenceStore.set('u1', { intensity: 'strong' });
  assert.strictEqual(p2.language, 'en', 'language 应保留');
  assert.strictEqual(p2.intensity, 'strong');
});

test('英文模式 region 归一为英文可用地区', () => {
  const p = preferenceStore.set('u1', { language: 'en', region: 'yuegang' });
  assert.strictEqual(p.region, 'neutral', '中文地区在英文模式被归一为 neutral');
  const p2 = preferenceStore.set('u1', { language: 'en', region: 'us' });
  assert.strictEqual(p2.region, 'us', '英文地区在英文模式保留');
});

test('setLearned：只更新给定维度并 clamp 到 ±0.12', () => {
  const p = preferenceStore.setLearned('u1', { humor: 0.5, directness: -1 });
  assert.strictEqual(p.learnedPreferences.humor, 0.12);
  assert.strictEqual(p.learnedPreferences.directness, -0.12);
  // 其余维度保持 0
  assert.strictEqual(p.learnedPreferences.warmth, 0);
});

test('reassignUser：游客偏好并入账号，账号已有则保留', () => {
  preferenceStore.set('guest', { language: 'en', tone: 'direct' });
  preferenceStore.reassignUser('guest', 'acc');
  const acc = preferenceStore.get('acc');
  assert.strictEqual(acc.language, 'en');
  assert.strictEqual(acc.tone, 'direct', '游客偏好已并入账号');

  // 账号已有偏好 → 不覆盖
  preferenceStore.set('acc', { language: 'zh-CN' });
  preferenceStore.set('guest2', { language: 'en' });
  preferenceStore.reassignUser('guest2', 'acc');
  assert.strictEqual(preferenceStore.get('acc').language, 'zh-CN', '账号已有偏好优先');
});

test('listAll / remove', () => {
  const before = preferenceStore.listAll().length;
  preferenceStore.set('lx', { tone: 'direct' });
  preferenceStore.set('ly', { mode: 'objective' });
  assert.strictEqual(preferenceStore.listAll().length, before + 2);
  preferenceStore.remove('lx');
  assert.strictEqual(preferenceStore.listAll().length, before + 1);
});

test('resolveThinkingLevelFor：非 Pro（游客/免费）max 降级 high，其余档位保留', () => {
  assert.strictEqual(resolveThinkingLevelFor('freeuser', 'max'), 'high');
  assert.strictEqual(resolveThinkingLevelFor('freeuser', 'high'), 'high');
  assert.strictEqual(resolveThinkingLevelFor('freeuser', 'off'), 'off');
  assert.strictEqual(resolveThinkingLevelFor('freeuser', 'low'), 'low');
});

test('resolveThinkingLevelFor：Pro / Lifetime 保留 max', () => {
  quotaStore.setPlan('prouser', 'pro');
  assert.strictEqual(resolveThinkingLevelFor('prouser', 'max'), 'max');
  quotaStore.setPlan('lifetimeuser', 'lifetime');
  assert.strictEqual(resolveThinkingLevelFor('lifetimeuser', 'max'), 'max');
});
