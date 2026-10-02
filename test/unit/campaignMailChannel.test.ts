/**
 * 群发通道（成人向定向邮件）与主通道（注册验证码/改密）的**隔离**测试
 *
 * 这是本次改动里最容易被改坏、后果最重的一条：
 *   运营群发若悄悄复用主通道凭据，一旦被 ESP 限制或收件人投诉，封的是整个发信域名，
 *   用户连验证码都收不到；若占用了主通道的每日非关键预算，同样会把额度从验证码那里抢走。
 *
 * 因为 email.ts 在模块加载时就把 MAIL_MODE 固定成常量，所以本文件必须在动态 import 之前
 * 设置环境变量，因此它单独成一个文件（其余测试共用进程内已加载的模块）。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
// 模拟生产：走真实 SMTP 分支；群发凭据刻意不配
process.env.MAIL_MODE = 'smtp';
delete process.env.CAMPAIGN_SMTP_USER;
delete process.env.CAMPAIGN_SMTP_PASS;
process.env.MAIL_NONCRITICAL_DAILY_LIMIT = '5';

const { sendEmail, campaignTransportReady, readCampaignTransport, tryConsumeNonCriticalMail } = await import('../../api/services/email.js');
const { readJson, dataFile } = await import('../../api/storage/persistence.js');

const budgetFile = () => dataFile('mail-daily-budget.json');

test('群发通道未配凭据：明确返回 null，绝不复用主通道凭据', () => {
  assert.strictEqual(readCampaignTransport(), null);
  const ready = campaignTransportReady();
  assert.strictEqual(ready.ready, false);
  assert.ok(ready.reason.includes('CAMPAIGN_SMTP_USER'), '报错必须点名缺哪个变量，而不是笼统失败');
  assert.strictEqual(ready.from, 'myxiaoyu2026@gmail.com', '默认发信地址应为用户指定的 Gmail');
});

test('群发通道未配凭据：发送明确失败，且不占用主通道（验证码）的每日额度', async () => {
  assert.strictEqual(readJson(budgetFile(), null), null, '前置：额度文件此刻应为空');

  const r = await sendEmail('nobody@example.com', 'subject', '<p>body</p>', undefined, { via: 'campaign' });
  assert.strictEqual(r.ok, false, '没配凭据就必须失败，不能假装成功');
  assert.ok(r.detail.includes('CAMPAIGN_SMTP_USER'));

  // 关键断言：群发这条路**没有**计提主通道额度，额度还在，第一次计提返回 true
  assert.strictEqual(tryConsumeNonCriticalMail(), true, '群发不得吃掉验证码的额度');
  const after = readJson<{ nonCriticalSent: number }>(budgetFile(), { nonCriticalSent: 0 });
  assert.strictEqual(after.nonCriticalSent, 1, '只有这一次显式计提被记账');
});
