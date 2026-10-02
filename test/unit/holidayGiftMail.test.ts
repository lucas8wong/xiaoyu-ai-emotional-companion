import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { accountStore } = await import('../../api/services/accounts.js');
const { reengageStore } = await import('../../api/services/reengage.js');
const { announcementStore } = await import('../../api/services/announcements.js');
const {
  holidayGiftCopy,
  renderHolidayGiftEmail,
  planHolidayGiftMail,
  publishHolidayGiftAnnouncement,
} = await import('../../api/services/holidayGiftMail.js');

function reg(username: string, email: string): string {
  const r = accountStore.register({ username, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败: ${email}`);
  return r.user.userId;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['HOLIDAY_GIFT_ID', 'HOLIDAY_GIFT_DAYS', 'HOLIDAY_GIFT_START', 'HOLIDAY_GIFT_END'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ENV_OK = {
  HOLIDAY_GIFT_ID: 'national-day-2026',
  HOLIDAY_GIFT_DAYS: '1',
  HOLIDAY_GIFT_START: '2026-10-01',
  HOLIDAY_GIFT_END: '2026-10-01',
};

test('holidayGiftCopy：三语公告含天数，且不出现 China/中国', () => {
  const c = holidayGiftCopy(3);
  assert.ok(c.annZhCN.title.includes('3'));
  assert.ok(c.annZhCN.content.includes('3'));
  assert.ok(c.annEn.title.includes('3'));
  assert.ok(c.annZhTW.content.length > 0);
  const all = JSON.stringify(c);
  assert.ok(!/China|中国/.test(all), '品牌口径：不出现 China/中国');
});

test('renderHolidayGiftEmail：三语均有主题、正文与退订链接', () => {
  const unsub = 'https://myxiaoyu.com/api/reengage/unsubscribe?userId=x&token=y&src=campaign';
  for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
    const m = renderHolidayGiftEmail(lang, { days: 1, nickname: 'Amy', unsubUrl: unsub });
    assert.ok(m.subject.length > 0, `${lang} 主题非空`);
    assert.ok(m.html.includes(unsub), `${lang} HTML 含退订链接`);
    assert.ok(m.text.includes(unsub), `${lang} 纯文本含退订链接`);
    assert.ok(m.text.includes('myxiaoyu.com'), `${lang} 纯文本含 CTA`);
  }
  // 昵称转义：不把用户输入当 HTML
  const m = renderHolidayGiftEmail('zh-CN', { days: 1, nickname: '<b>x</b>', unsubUrl: unsub });
  assert.ok(m.html.includes('&lt;b&gt;'), '昵称被转义');
});

test('planHolidayGiftMail：包含普通注册用户，排除测试账号与已退订用户', () => {
  withEnv(ENV_OK, () => {
    const a = reg('mail_keep_a', 'holidaymaila@gmail.com');
    const b = reg('mail_keep_b', 'holidaymailb@gmail.com');
    const t = reg('mail_test', 'holidaymail@test.com');
    const o = reg('mail_optout', 'holidaymailopt@gmail.com');
    reengageStore.optOut(o);

    const plan = planHolidayGiftMail();
    const ids = plan.recipients.map((r) => r.userId);
    assert.ok(ids.includes(a), '普通用户 a 在名单内');
    assert.ok(ids.includes(b), '普通用户 b 在名单内');
    assert.ok(!ids.includes(t), '测试账号被排除');
    assert.ok(!ids.includes(o), '已退订用户被排除');
    assert.ok(plan.excluded.testOrDev >= 1);
    assert.ok(plan.excluded.optedOut >= 1);
    // 每位收件人都带退订链接
    for (const r of plan.recipients) assert.ok(r.unsubUrl.includes('/api/reengage/unsubscribe'));
    // 合计：名单 + 排除原因 + 已发过 = 全部账号（不含无邮箱）
    const totalAccounts = accountStore.listAll().length;
    assert.ok(plan.recipients.length + plan.excluded.optedOut + plan.excluded.testOrDev + plan.excluded.crisis + plan.excluded.duplicateEmail + plan.alreadySent <= totalAccounts);
  });
});

test('publishHolidayGiftAnnouncement：dry-run 不写；apply 写一次；重复 apply 幂等', async () => {
  await withEnvAsync(ENV_OK, async () => {
    const before = announcementStore.list().length;
    const dry = await publishHolidayGiftAnnouncement({ apply: false });
    assert.strictEqual(dry.applied, false);
    assert.strictEqual(dry.existed, false);
    assert.strictEqual(announcementStore.list().length, before, 'dry-run 不写公告');

    const first = await publishHolidayGiftAnnouncement({ apply: true });
    assert.strictEqual(first.applied, true);
    assert.strictEqual(announcementStore.list().length, before + 1, 'apply 写一条公告');
    assert.ok(announcementStore.list().some((x) => x.titleZh === first.copy.annZhCN.title));

    const second = await publishHolidayGiftAnnouncement({ apply: true });
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.existed, true, '同活动重复发布被幂等跳过');
    assert.strictEqual(announcementStore.list().length, before + 1);
  });
});

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = Object.keys(vars);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
