import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
// 与线上一致的记账口径（点数制），便于断言「补发 20 条 = +20 × UNIT_CREDIT 点」
process.env.CREDIT_QUOTA_ENABLED = '1';

const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore, UNIT_CREDIT } = await import('../../api/services/quota.js');
const { activityStore } = await import('../../api/services/activity.js');
const {
  buildBackfillEmail,
  isRegisterBonusMissed,
  getBackfillProcessedIds,
  listRegisterBonusCandidates,
  runRegisterBonusBackfill,
  MISSED_WINDOW_END_MS,
} = await import('../../api/services/registerBonusBackfill.js');

function reg(username: string, email: string) {
  const r = accountStore.register({ username, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败: ${email}`);
  return r.user.userId;
}

test('isRegisterBonusMissed：只认「漏发窗口之后注册」的非测试/非开发者账号', () => {
  const fresh = reg('rb_fresh', 'rbfresh@gmail.com');
  const acc = accountStore.getById(fresh)!;

  assert.strictEqual(isRegisterBonusMissed(acc), true, '刚注册（晚于 2026-09-06）属于漏发');
  assert.strictEqual(
    isRegisterBonusMissed({ ...acc, createdAt: MISSED_WINDOW_END_MS - 1000 }),
    false,
    '窗口内/之前注册不算漏发',
  );
  // 测试账号（TEST_ACCOUNTS / @test.com）与开发者账号都不补发
  const tester = reg('tester_rb', 'test@test.com');
  assert.strictEqual(isRegisterBonusMissed(accountStore.getById(tester)!), false, '测试账号排除');
  // 开发者账号不再内置在代码里（2026-09-27 移出，避免个人邮箱进公开仓库），改由 DEV_ACCOUNTS 配置
  process.env.DEV_ACCOUNTS = 'dev-owner@example.com';
  const dev = reg('dev_rb', 'dev-owner@example.com');
  assert.strictEqual(isRegisterBonusMissed(accountStore.getById(dev)!), false, '开发者账号排除');
});

test('runRegisterBonusBackfill dry-run：统计候选/语言/零副作用', async () => {
  const cn = reg('rb_cn', 'rbcn@gmail.com');
  const tw = reg('rb_tw', 'rbtw@gmail.com');
  const en = reg('rb_en', 'rben@gmail.com');
  activityStore.trackLogin(cn, { method: 'login', ip: '1.1.1.1', country: 'CN' });
  activityStore.trackLogin(tw, { method: 'login', ip: '1.1.1.1', country: 'TW' });
  activityStore.trackLogin(en, { method: 'login', ip: '1.1.1.1', country: 'US' });
  const before = quotaStore.getQuota(cn).creditBonus;

  assert.strictEqual(getBackfillProcessedIds().size, 0, '此时尚未写 marker');
  const report = await runRegisterBonusBackfill({ dryRun: true });

  assert.strictEqual(report.dryRun, true);
  assert.strictEqual(report.count, 20, '缺省补发 20 条');
  assert.strictEqual(report.granted, 0, 'dry-run 不补发');
  assert.strictEqual(report.emailed, 0, 'dry-run 不发信');
  assert.strictEqual(getBackfillProcessedIds().size, 0, 'dry-run 不写 marker');
  assert.strictEqual(quotaStore.getQuota(cn).creditBonus, before, 'dry-run 不改额度');

  const ids = new Set(report.candidates.map((c) => c.userId));
  assert.ok(ids.has(cn) && ids.has(tw) && ids.has(en), '三类语言用户都在候选里');
  assert.ok(report.byLanguage['zh-CN'] >= 1 && report.byLanguage['zh-TW'] >= 1 && report.byLanguage.en >= 1);
});

test('runRegisterBonusBackfill exclude：按 userId 或邮箱排除', async () => {
  const a = reg('rb_excl_a', 'rbexcla@gmail.com');
  const b = reg('rb_excl_b', 'rbexclb@gmail.com');
  const report = await runRegisterBonusBackfill({ dryRun: true, exclude: [a, 'rbexclb@gmail.com'] });
  const ids = new Set(report.candidates.map((c) => c.userId));
  assert.ok(!ids.has(a), '按 userId 排除生效');
  assert.ok(!ids.has(b), '按邮箱排除生效');
  assert.ok(report.excludedCount >= 2);
});

test('runRegisterBonusBackfill apply：补 20 条 + 发信 + 写 marker；重跑不重复，force 才重做', async () => {
  const a = reg('rb_apply_a', 'rbapplya@gmail.com');
  const b = reg('rb_apply_b', 'rbapplyb@gmail.com');
  const beforeA = quotaStore.getQuota(a).creditBonus;

  const report = await runRegisterBonusBackfill({ dryRun: false, throttleMs: 0 });
  assert.strictEqual(report.dryRun, false);
  assert.strictEqual(report.granted >= 2, true, '至少补发了本测试的 2 位');
  assert.strictEqual(report.emailed >= 2, true, 'console 模式应视为发送成功');
  assert.strictEqual(report.emailFailed, 0);
  assert.strictEqual(report.markerExists, true);
  assert.strictEqual(
    quotaStore.getQuota(a).creditBonus,
    beforeA + 20 * UNIT_CREDIT,
    '补发 20 条 = +20 × UNIT_CREDIT 点',
  );

  const processed = getBackfillProcessedIds();
  assert.ok(processed.has(a) && processed.has(b), 'marker 记录已处理 userId');

  // 重跑（非 force）：候选应被 marker 全部跳过
  const rerun = await runRegisterBonusBackfill({ dryRun: true });
  assert.strictEqual(rerun.candidates.length, 0, '重跑不重复处理');
  assert.strictEqual(rerun.skippedProcessed >= 2, true);

  // force：忽略 marker 重新处理（会重复补发，仅特殊情况下用）
  const forced = await runRegisterBonusBackfill({ dryRun: true, force: true });
  assert.ok(forced.candidates.length >= 2, 'force 时重新纳入候选');
});

test('listRegisterBonusCandidates：since 覆盖可排除「自定义截止之后」的账号', () => {
  const u = reg('rb_since', 'rbsince@gmail.com');
  assert.ok(listRegisterBonusCandidates(MISSED_WINDOW_END_MS).some((c) => c.userId === u), '默认截止纳入');
  const future = Date.now() + 86400000;
  assert.ok(!listRegisterBonusCandidates(future).some((c) => c.userId === u), '截止晚于注册时间 → 排除');
});

test('buildBackfillEmail：三语都要说清「漏发 + 已补上」，且守品牌红线', () => {
  const zh = buildBackfillEmail('zh-CN', '小愈用户', 20);
  const tw = buildBackfillEmail('zh-TW', '小愈用戶', 20);
  const en = buildBackfillEmail('en', 'Xiaoyu User', 20);

  assert.match(zh.subject, /20 条对话额度已到账/);
  assert.match(zh.html, /没有送到你的账号/);
  assert.match(zh.html, /已存入你的账号/);
  assert.match(tw.subject, /20 條對話額度已到賬/);
  assert.match(tw.html, /進入 Xiaoyu/);
  assert.match(en.subject, /20 free chats added/);
  assert.match(en.html, /missed/);
  assert.match(en.html, /Enter Xiaoyu/);
  // 品牌红线：陪伴非治疗，不出现治疗/诊断/治愈承诺
  assert.doesNotMatch(zh.html, /治疗|诊断|治愈/);
  assert.doesNotMatch(tw.html, /治療|診斷|治癒/);
  assert.doesNotMatch(en.html, /diagnos|treat|cure/i);
});
