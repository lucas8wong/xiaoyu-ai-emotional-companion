import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore } = await import('../../api/services/quota.js');
const {
  holidayGiftConfig,
  isHolidayGiftActive,
  runHolidayGift,
  getHolidayGiftGrantedIds,
  maybeGrantHolidayGiftOnRegister,
} = await import('../../api/services/holidayGift.js');
const { isNewcomerEligible } = await import('../../api/services/proTrialNewcomer.js');

function reg(username: string, email: string): string {
  const r = accountStore.register({ username, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败: ${email}`);
  return r.user.userId;
}

/** 今天的 YYYY-MM-DD（本地时区，与 isHolidayGiftActive 的解析口径一致） */
function todayYmd(): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 设置/还原节日礼环境变量 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['HOLIDAY_GIFT_ID', 'HOLIDAY_GIFT_DAYS', 'HOLIDAY_GIFT_START', 'HOLIDAY_GIFT_END'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('holidayGiftConfig：默认天数 1，END 留空则与 START 同日', () => {
  const cfg = holidayGiftConfig({ HOLIDAY_GIFT_ID: 'x', HOLIDAY_GIFT_START: '2026-10-01' } as NodeJS.ProcessEnv);
  assert.strictEqual(cfg.campaignId, 'x');
  assert.strictEqual(cfg.days, 1);
  assert.strictEqual(cfg.end, '2026-10-01');
});

test('isHolidayGiftActive：窗口含首尾，未配置/非法日期关闭', () => {
  const env = (over: Record<string, string>) => ({ HOLIDAY_GIFT_ID: 'national-day', ...over } as NodeJS.ProcessEnv);
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1, 0, 0, 0), env({ HOLIDAY_GIFT_START: '2026-10-01' })), true, '当天 00:00 生效');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1, 23, 59, 59), env({ HOLIDAY_GIFT_START: '2026-10-01' })), true, '当天 23:59 仍生效');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 2, 0, 0, 0), env({ HOLIDAY_GIFT_START: '2026-10-01' })), false, '次日 00:00 结束');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1), env({ HOLIDAY_GIFT_START: '2026-10-01', HOLIDAY_GIFT_END: '2026-10-03' })), true, '多天窗口内');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 4), env({ HOLIDAY_GIFT_START: '2026-10-01', HOLIDAY_GIFT_END: '2026-10-03' })), false, '多天窗口结束后');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1), env({})), false, '未配置 ID 关闭');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1), env({ HOLIDAY_GIFT_START: 'bad-date' })), false, '非法日期关闭');
  assert.strictEqual(isHolidayGiftActive(new Date(2026, 9, 1), env({ HOLIDAY_GIFT_START: '2026-02-30' })), false, '非真实日历日期关闭');
});

test('runHolidayGift：dry-run 零副作用；apply 幂等；覆盖「所有注册用户」含已领试用者', () => {
  withEnv({ HOLIDAY_GIFT_ID: 'national-day-2026', HOLIDAY_GIFT_DAYS: '1', HOLIDAY_GIFT_START: todayYmd(), HOLIDAY_GIFT_END: todayYmd() }, () => {
    const a = reg('hg_a', 'holidaygifta@gmail.com');
    const b = reg('hg_b', 'holidaygiftb@gmail.com');
    // b 已领过 7 天新人试用：节日礼不限档位/是否领过，仍应覆盖（「所有注册用户」）
    quotaStore.grantProTrial(b, 7);

    const dry = runHolidayGift({ dryRun: true });
    assert.strictEqual(dry.totalEligible, 2, '两个注册账号都符合');
    assert.strictEqual(dry.toProcess, 2);
    assert.strictEqual(dry.granted, 0);
    assert.strictEqual(quotaStore.getQuota(a).trialProActive, false, 'dry-run 不改数据');
    assert.strictEqual(getHolidayGiftGrantedIds('national-day-2026').size, 0, 'dry-run 不写 marker');

    const applied = runHolidayGift({ dryRun: false });
    assert.strictEqual(applied.granted, 2);
    assert.strictEqual(quotaStore.getQuota(a).trialProActive, true, 'a 获得 Pro 赠送');
    assert.strictEqual(quotaStore.getQuota(a).plan, 'pro');
    assert.strictEqual(quotaStore.getQuota(b).plan, 'pro');
    assert.strictEqual(getHolidayGiftGrantedIds('national-day-2026').size, 2, 'marker 记录已发放');

    const again = runHolidayGift({ dryRun: false });
    assert.strictEqual(again.toProcess, 0, '重跑不重复发放');
    assert.strictEqual(again.granted, 0);
    assert.strictEqual(again.skippedProcessed, 2);
  });
});

test('节日礼不写 trialProGrantedAt：当天新注册者日后仍可领 7 天新人礼', () => {
  withEnv({ HOLIDAY_GIFT_ID: 'national-day-2026', HOLIDAY_GIFT_DAYS: '1', HOLIDAY_GIFT_START: todayYmd(), HOLIDAY_GIFT_END: todayYmd() }, () => {
    const u = reg('hg_newcomer', 'holidaygiftnew@gmail.com');
    const r = maybeGrantHolidayGiftOnRegister(u);
    assert.strictEqual(r.granted, true);
    assert.strictEqual(r.days, 1);
    assert.strictEqual(quotaStore.getQuota(u).trialProActive, true, '即时获得 Pro');
    assert.strictEqual(quotaStore.getRecord(u)?.trialProGrantedAt, undefined, '不写新人试用标记');

    // 赠送到期后：节日礼用户重新算「新人礼候选」；而走 grantProTrial 的会因标记被永久排除
    const v = reg('hg_trial_flag', 'holidaygiftflag@gmail.com');
    quotaStore.grantProTrial(v, 1);
    for (const id of [u, v]) {
      const rec = quotaStore.getRecord(id)!;
      rec.trialProUntil = Date.now() - 1000; // 模拟到期
    }
    assert.strictEqual(isNewcomerEligible(accountStore.getById(u)!), true, '节日礼到期后仍算新人礼候选');
    assert.strictEqual(isNewcomerEligible(accountStore.getById(v)!), false, '体验标记用户仍被排除（对照）');

    const r2 = maybeGrantHolidayGiftOnRegister(u);
    assert.strictEqual(r2.granted, false, '同一轮不重复发');
    assert.strictEqual(r2.reason, 'already-granted');
  });
});

test('maybeGrantHolidayGiftOnRegister：窗口外不发', () => {
  withEnv({ HOLIDAY_GIFT_ID: 'national-day-2026', HOLIDAY_GIFT_START: '2000-01-01', HOLIDAY_GIFT_END: '2000-01-02' }, () => {
    const u = reg('hg_closed', 'holidaygiftclosed@gmail.com');
    const r = maybeGrantHolidayGiftOnRegister(u);
    assert.strictEqual(r.granted, false);
    assert.strictEqual(r.reason, 'campaign-inactive');
    assert.strictEqual(quotaStore.getQuota(u).trialProActive, false, '窗口外不改数据');
  });
});

test('runHolidayGift：未配置 HOLIDAY_GIFT_ID 拒绝执行（防误发）', () => {
  withEnv({ HOLIDAY_GIFT_ID: undefined }, () => {
    assert.throws(() => runHolidayGift({ dryRun: true }), /HOLIDAY_GIFT_ID/);
  });
});
