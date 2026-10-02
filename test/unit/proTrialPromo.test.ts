import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore, isProTrialPromoActive } = await import('../../api/services/quota.js');
const { activityStore } = await import('../../api/services/activity.js');
const { maybeGrantNewcomerProTrial, isNewcomerEligible } = await import('../../api/services/proTrialNewcomer.js');

function reg(username: string, email: string) {
  const r = accountStore.register({ username, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败: ${email}`);
  return r.user.userId;
}

// 【活动窗口开关】
test('isProTrialPromoActive：配置窗口开关（15 天）', () => {
  const saveStart = process.env.PRO_TRIAL_PROMO_START;
  const saveDays = process.env.PRO_TRIAL_PROMO_DAYS;

  process.env.PRO_TRIAL_PROMO_START = '2026-09-03';
  process.env.PRO_TRIAL_PROMO_DAYS = '15';
  assert.strictEqual(isProTrialPromoActive(new Date(2026, 8, 3)), true, '窗口首日生效');
  assert.strictEqual(isProTrialPromoActive(new Date(2026, 8, 17, 23, 59, 59)), true, '窗口最后一天生效');
  assert.strictEqual(isProTrialPromoActive(new Date(2026, 8, 18)), false, '窗口结束后关闭');

  process.env.PRO_TRIAL_PROMO_START = '';
  assert.strictEqual(isProTrialPromoActive(new Date(2026, 8, 3)), false, '未配置则关闭');
  process.env.PRO_TRIAL_PROMO_START = 'bad-date';
  assert.strictEqual(isProTrialPromoActive(new Date(2026, 8, 3)), false, '非法日期则关闭');

  process.env.PRO_TRIAL_PROMO_START = saveStart;
  process.env.PRO_TRIAL_PROMO_DAYS = saveDays;
});

// 【isNewcomerEligible：一次性新人礼（已发过试用不再发）】
test('isNewcomerEligible：已发过 Pro 试用则排除', () => {
  const free = reg('promo_never', 'promonever@gmail.com');
  const given = reg('promo_given', 'promogiven@gmail.com');

  // given 先授一次 7 天 Pro（会写 trialProGrantedAt / trialProUntil）
  quotaStore.grantProTrial(given, 7);

  assert.strictEqual(isNewcomerEligible(accountStore.getById(free)!), true, '从未领过 → 纳入');
  assert.strictEqual(isNewcomerEligible(accountStore.getById(given)!), false, '已发过试用 → 排除（一次性）');
});

// 【注册链路自动发放】
test('maybeGrantNewcomerProTrial：活动期内发放+发信，幂等；非活动期/会员不发', async () => {
  const saveStart = process.env.PRO_TRIAL_PROMO_START;
  const saveDays = process.env.PRO_TRIAL_PROMO_DAYS;
  // ⚠️ 窗口起点必须**相对今天**算（不能写死日期）：写死会在活动到期那天变成定时炸弹
  // 2026-09-18 实测踩到：`'2026-09-03' + 15 天` 正好到 09-18 00:00 结束，当天这条断言就全灭（与代码无关）。
  const promoStart = (() => {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  process.env.PRO_TRIAL_PROMO_START = promoStart;
  process.env.PRO_TRIAL_PROMO_DAYS = '15';

  // 活动期内、free、有邮箱 → 发放+发信
  const a = reg('promo_a', 'promoa@gmail.com');
  activityStore.trackLogin(a, { method: 'login', ip: '1.1.1.1', country: 'CN' });
  const r1 = await maybeGrantNewcomerProTrial(a);
  assert.strictEqual(r1.granted, true, '活动期内发放');
  assert.strictEqual(r1.emailed, true, 'console 模式发信视为成功');
  assert.strictEqual(quotaStore.getQuota(a).trialProActive, true, '进入 7 天 Pro 试用');

  // 已发过 → 再次调用跳过（一次性，幂等）
  const r2 = await maybeGrantNewcomerProTrial(a);
  assert.strictEqual(r2.granted, false, '已发过不再发放');
  assert.strictEqual(r2.reason, 'not-eligible');

  // 非活动期 → 不改数据、不发信
  process.env.PRO_TRIAL_PROMO_START = '';
  const b = reg('promo_b', 'promob@gmail.com');
  activityStore.trackLogin(b, { method: 'login', ip: '1.1.1.1', country: 'CN' });
  const r3 = await maybeGrantNewcomerProTrial(b);
  assert.strictEqual(r3.granted, false, '非活动期不发放');
  assert.strictEqual(r3.reason, 'campaign-inactive');
  assert.strictEqual(quotaStore.getQuota(b).trialProActive, false, '数据未被改动');

  // 会员 → 跳过
  process.env.PRO_TRIAL_PROMO_START = promoStart;
  const pro = reg('promo_pro', 'promopro@gmail.com');
  quotaStore.setPlan(pro, 'pro');
  const r4 = await maybeGrantNewcomerProTrial(pro);
  assert.strictEqual(r4.granted, false, '会员不发放');
  assert.strictEqual(r4.reason, 'not-eligible');

  process.env.PRO_TRIAL_PROMO_START = saveStart;
  process.env.PRO_TRIAL_PROMO_DAYS = saveDays;
});
