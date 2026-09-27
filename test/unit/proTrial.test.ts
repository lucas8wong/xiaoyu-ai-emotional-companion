import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore } = await import('../../api/services/quota.js');
const { proTrialDays, hasGrantedCampaign, grantProTrialToExisting, maybeGrantProTrialOnStartup } = await import('../../api/services/proTrial.js');

test('proTrialDays：读取 PRO_TRIAL_DAYS，<=0 或缺失返回 0', () => {
  process.env.PRO_TRIAL_DAYS = '7';
  assert.strictEqual(proTrialDays(), 7);
  process.env.PRO_TRIAL_DAYS = '0';
  assert.strictEqual(proTrialDays(), 0);
  process.env.PRO_TRIAL_DAYS = '7';
});

test('grantProTrialToExisting：days<=0 直接返回 0', () => {
  process.env.PRO_TRIAL_DAYS = '0';
  assert.strictEqual(grantProTrialToExisting(0), 0);
  process.env.PRO_TRIAL_DAYS = '7';
});

test('grantProTrialToExisting：只授予注册用户，幂等', () => {
  assert.strictEqual(hasGrantedCampaign(), false, '初始未执行过');
  const r = accountStore.register({ username: 'realuser', email: 'realuser@gmail.com', password: 'pw123456' });
  assert.ok(r.user);

  const granted = grantProTrialToExisting(7);
  assert.strictEqual(granted, 1, '应为 1 位注册用户授予 Pro');
  const q = quotaStore.getQuota(r.user.userId);
  assert.strictEqual(q.trialProActive, true);
  assert.ok(q.trialProUntil > Date.now());

  // 幂等：重复执行返回 -1
  assert.strictEqual(grantProTrialToExisting(7), -1);
});

test('maybeGrantProTrialOnStartup：已授予过则不重复执行', () => {
  // 上面已授予并写入 flag，这里应安全 no-op
  assert.doesNotThrow(() => maybeGrantProTrialOnStartup());
});
