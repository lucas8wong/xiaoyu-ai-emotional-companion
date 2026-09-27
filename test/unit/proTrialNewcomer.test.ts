import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore } = await import('../../api/services/quota.js');
const { activityStore } = await import('../../api/services/activity.js');
const { preferenceStore } = await import('../../api/services/preferences.js');
const {
  newcomerProTrialDays,
  inferLanguageForUser,
  isNewcomerEligible,
  buildCongratsEmail,
  getProcessedUserIds,
  runNewcomerProTrial,
} = await import('../../api/services/proTrialNewcomer.js');

function reg(username: string, email: string) {
  const r = accountStore.register({ username, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败: ${email}`);
  return r.user.userId;
}

test('newcomerProTrialDays：读取 PRO_TRIAL_DAYS，<=0/缺失回退 7', () => {
  process.env.PRO_TRIAL_DAYS = '0';
  assert.strictEqual(newcomerProTrialDays(), 7);
  process.env.PRO_TRIAL_DAYS = '10';
  assert.strictEqual(newcomerProTrialDays(), 10);
  delete process.env.PRO_TRIAL_DAYS;
  assert.strictEqual(newcomerProTrialDays(), 7);
});

test('inferLanguageForUser：按最近国家/IP 映射语言', () => {
  const hk = reg('hk_user', 'hk@gmail.com');
  const cn = reg('cn_user', 'cn@gmail.com');
  const us = reg('us_user', 'us@gmail.com');
  const noIp = reg('noip_user', 'noip@gmail.com');
  const prefTw = reg('pref_tw', 'preftw@gmail.com');

  activityStore.trackLogin(hk, { method: 'login', ip: '1.1.1.1', country: 'HK' });
  activityStore.trackLogin(cn, { method: 'login', ip: '2.2.2.2', country: 'CN' });
  activityStore.trackLogin(us, { method: 'login', ip: '8.8.8.8', country: 'US' });
  preferenceStore.set(prefTw, { language: 'zh-TW' });

  assert.strictEqual(inferLanguageForUser(hk), 'zh-TW');
  assert.strictEqual(inferLanguageForUser(cn), 'zh-CN');
  assert.strictEqual(inferLanguageForUser(us), 'en');
  assert.strictEqual(inferLanguageForUser(noIp), 'en', '无地区记录且无偏好 → 默认英文');
  assert.strictEqual(inferLanguageForUser(prefTw), 'zh-TW', '无地区但有显式偏好 → 尊重偏好');
});

test('isNewcomerEligible：免费纳入，会员/测试账号排除', () => {
  const free = reg('free_user', 'free@gmail.com');
  const pro = reg('pro_user', 'pro@gmail.com');
  const tester = reg('tester', 'test@example.com');
  quotaStore.setPlan(pro, 'pro');

  assert.strictEqual(isNewcomerEligible(accountStore.getById(free)!), true);
  assert.strictEqual(isNewcomerEligible(accountStore.getById(pro)!), false, '会员不纳入');
  assert.strictEqual(isNewcomerEligible(accountStore.getById(tester)!), false, '测试账号不纳入');
});

test('runNewcomerProTrial dry-run：统计候选/语言/零副作用', async () => {
  const cn = reg('dry_cn', 'drycn@gmail.com');
  const tw = reg('dry_tw', 'drytw@gmail.com');
  const en = reg('dry_en', 'dryen@gmail.com');
  const pro = reg('dry_pro', 'drypro@gmail.com');
  const tester = reg('dry_tester', 'test@test.com');
  activityStore.trackLogin(cn, { method: 'login', ip: '1.1.1.1', country: 'CN' });
  activityStore.trackLogin(tw, { method: 'login', ip: '1.1.1.1', country: 'TW' });
  activityStore.trackLogin(en, { method: 'login', ip: '1.1.1.1', country: 'US' });
  quotaStore.setPlan(pro, 'pro');

  assert.strictEqual(getProcessedUserIds().size, 0, '此时尚未写入 marker');
  const report = await runNewcomerProTrial({ dryRun: true, days: 7 });

  assert.strictEqual(report.dryRun, true);
  assert.strictEqual(report.granted, 0, 'dry-run 不授权');
  assert.strictEqual(report.emailed, 0, 'dry-run 不发信');
  assert.strictEqual(getProcessedUserIds().size, 0, 'dry-run 不写 marker');

  const ids = new Set(report.candidates.map((c) => c.userId));
  assert.ok(ids.has(cn), '简中用户纳入');
  assert.ok(ids.has(tw), '繁中用户纳入');
  assert.ok(ids.has(en), '英文用户纳入');
  assert.ok(!ids.has(pro), '会员不纳入');
  assert.ok(!ids.has(tester), '测试账号不纳入');
  assert.ok(report.byLanguage['zh-CN'] >= 1);
  assert.ok(report.byLanguage['zh-TW'] >= 1);
  assert.ok(report.byLanguage.en >= 1);
});

test('runNewcomerProTrial exclude：主动排除指定用户（可按 userId 或邮箱）', async () => {
  const a = reg('excl_a', 'excla@gmail.com');
  const b = reg('excl_b', 'exclb@gmail.com');
  activityStore.trackLogin(a, { method: 'login', ip: '1.1.1.1', country: 'HK' });
  activityStore.trackLogin(b, { method: 'login', ip: '1.1.1.1', country: 'CN' });

  const report = await runNewcomerProTrial({ dryRun: true, days: 7, exclude: [a, 'exclb@gmail.com'] });
  const ids = new Set(report.candidates.map((c) => c.userId));
  assert.ok(!ids.has(a), '按 userId 排除生效');
  assert.ok(!ids.has(b), '按邮箱排除生效');
  assert.strictEqual(report.excludedCount >= 2, true);
});

test('runNewcomerProTrial apply：授权+发信+写 marker；重跑不重复处理', async () => {
  const a = reg('apply_a', 'applya@gmail.com');
  const b = reg('apply_b', 'applyb@gmail.com');
  activityStore.trackLogin(a, { method: 'login', ip: '1.1.1.1', country: 'HK' });
  activityStore.trackLogin(b, { method: 'login', ip: '1.1.1.1', country: 'CN' });

  const report = await runNewcomerProTrial({ dryRun: false, days: 7 });
  assert.strictEqual(report.dryRun, false);
  assert.strictEqual(report.granted >= 2, true, '至少授权了本测试的 2 位');
  assert.strictEqual(report.emailed >= 2, true, 'console 模式应视为发送成功');
  assert.strictEqual(report.markerExists, true);
  assert.strictEqual(quotaStore.getQuota(a).trialProActive, true, '授权后进入 Pro 试用');
  assert.strictEqual(quotaStore.getQuota(b).trialProActive, true);

  // 授权后所有处理用户均进入 Pro 试用 → 重跑 DRY-RUN 不会再处理任何「无会员」者（不会重复授权/发信）
  const rerun = await runNewcomerProTrial({ dryRun: true, days: 7 });
  assert.strictEqual(rerun.totalEligible, 0);
  assert.strictEqual(rerun.candidates.length, 0);
  assert.strictEqual(rerun.granted, 0);
});

test('buildCongratsEmail：三语 subject/正文，繁中简体一致且品牌口径', () => {
  const zh = buildCongratsEmail('zh-CN', '小愈用户', 7);
  const tw = buildCongratsEmail('zh-TW', '小愈用户', 7);
  const en = buildCongratsEmail('en', 'Xiaoyu User', 7);

  assert.match(zh.subject, /7 天 Pro 体验/);
  assert.match(zh.html, /小愈为你准备/);
  assert.match(zh.html, /进入 Xiaoyu/);
  assert.match(tw.subject, /7 天 Pro 體驗/);
  assert.match(tw.html, /進入 Xiaoyu/);
  assert.match(en.subject, /7-day Pro trial/);
  assert.match(en.html, /Enter Xiaoyu/);
  // 品牌红线：不出现治疗/诊断承诺
  assert.doesNotMatch(zh.html, /治疗|诊断|治愈/);
  assert.doesNotMatch(en.html, /diagnos|treat|cure/i);
});
