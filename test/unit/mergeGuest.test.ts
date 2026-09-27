import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { preferenceStore } = await import('../../api/services/preferences.js');
const { customRoleplayStore } = await import('../../api/services/customRoleplay.js');
const { mergeGuestData } = await import('../../api/services/mergeGuest.js');

test('mergeGuestData：空/相同 id 为 no-op', () => {
  assert.doesNotThrow(() => mergeGuestData('', 'acc'));
  assert.doesNotThrow(() => mergeGuestData('same', 'same'));
});

test('mergeGuestData：把游客偏好并入账号（账号无偏好时）', () => {
  preferenceStore.set('guest', { language: 'en', tone: 'direct' });
  assert.strictEqual(preferenceStore.get('acc').language, 'zh-TW', '初始账号无记录');

  mergeGuestData('guest', 'acc');
  const acc = preferenceStore.get('acc');
  assert.strictEqual(acc.language, 'en', '账号获得游客偏好');
  assert.strictEqual(acc.tone, 'direct');
});

test('mergeGuestData：游客自建剧本一并转入账号（「与你的旅程」标题可解析）', () => {
  const rec = customRoleplayStore.create('guest_rp', { title: '我的剧本', aiName: 'AI', aiPersona: '人设', background: '背景', opening: '开场' });
  assert.strictEqual(customRoleplayStore.get('guest_rp', rec.id)?.title, '我的剧本');

  mergeGuestData('guest_rp', 'acc_rp');

  assert.strictEqual(customRoleplayStore.get('acc_rp', rec.id)?.title, '我的剧本', '账号可解析出自建剧本标题');
  assert.strictEqual(customRoleplayStore.get('guest_rp', rec.id), undefined, '游客名下已转移');
});
