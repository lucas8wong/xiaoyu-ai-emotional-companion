import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { pushSubscriptionStore, getVapidPublicKey } = await import('../../api/services/push.js');

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } });

test('推送订阅存储：添加/查询/移除', () => {
  const uid = 'push-1';
  pushSubscriptionStore.add(uid, sub('https://push.example/1'));
  pushSubscriptionStore.add(uid, sub('https://push.example/2'));
  assert.strictEqual(pushSubscriptionStore.has(uid), true);
  assert.strictEqual(pushSubscriptionStore.listByUser(uid).length, 2);
  pushSubscriptionStore.remove(uid, 'https://push.example/1');
  assert.strictEqual(pushSubscriptionStore.listByUser(uid).length, 1);
});

test('推送订阅存储：同 endpoint 覆盖而非重复', () => {
  const uid = 'push-2';
  pushSubscriptionStore.add(uid, sub('https://push.example/same'));
  pushSubscriptionStore.add(uid, sub('https://push.example/same'));
  assert.strictEqual(pushSubscriptionStore.listByUser(uid).length, 1);
});

test('推送订阅存储：removeEndpoint 全局清理（失效端点）', () => {
  const uid = 'push-3';
  pushSubscriptionStore.add(uid, sub('https://push.example/clean'));
  pushSubscriptionStore.removeEndpoint('https://push.example/clean');
  assert.strictEqual(pushSubscriptionStore.has(uid), false);
});

test('推送订阅存储：无效订阅忽略', () => {
  const uid = 'push-4';
  pushSubscriptionStore.add(uid, { endpoint: '', keys: { p256dh: '', auth: '' } } as never);
  assert.strictEqual(pushSubscriptionStore.has(uid), false);
});

test('VAPID 公钥：生成 base64url 且同进程稳定', () => {
  const a = getVapidPublicKey();
  const b = getVapidPublicKey();
  assert.ok(a && a.length > 30, '公钥应有内容');
  assert.strictEqual(a, b, '同进程应稳定');
});
