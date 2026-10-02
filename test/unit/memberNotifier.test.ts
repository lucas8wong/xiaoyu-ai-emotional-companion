/**
 * 会员开通通知（memberNotifier）：运营在控制台手动开通会员后，给用户发的那封「会员已开通 / 已续期」邮件。
 *
 * 口径（2026-09-18 需求）：只覆盖「手动开通」这一条路径；语言按用户地区/偏好三语；
 * 档位按实际生效档位；测试/开发者/无邮箱不发；60 秒内同人去重；发信失败不抛、不占用去重窗口。
 *
 * 测试进程里 MAIL_MODE 默认 console（setupTempCwd 后无 .env），sendEmail 只打日志不真发，
 * 所以可以安全断言「发给了谁、发了什么」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { accountStore } = await import('../../api/services/accounts.js');
const { activityStore } = await import('../../api/services/activity.js');
const { preferenceStore } = await import('../../api/services/preferences.js');
const {
  buildMembershipEmail,
  formatExpiryDate,
  planLabel,
  notifyMembershipGranted,
  MEMBERSHIP_MAIL_DEDUPE_MS,
  __resetMembershipMailDedupe,
} = await import('../../api/services/memberNotifier.js');

/** 2026-10-18 12:00（香港时间），固定时间戳，断言日期不受机器时区影响 */
const UNTIL = Date.UTC(2026, 9, 18, 4, 0, 0);
/** 2026-11-17 12:00（香港时间），续期后的到期日 */
const UNTIL_RENEWED = Date.UTC(2026, 10, 17, 4, 0, 0);

let seq = 0;
function reg(username: string, email: string, country?: string): string {
  seq += 1;
  const r = accountStore.register({ username: `${username}${seq}`, email, password: 'pw123456' });
  assert.ok(r.user, `注册失败(${email}): ${r.error}`);
  const userId = r.user!.userId;
  if (country) activityStore.trackLogin(userId, { method: 'login', ip: '1.2.3.4', country });
  return userId;
}

function withLogs(run: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push('WARN:' + args.join(' ')); };
  try {
    run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return logs;
}

/** 让 fire-and-forget / await 的微任务跑完 */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// ---------- 模板 ----------

test('formatExpiryDate：固定时间戳按 UTC+8 呈现，中英各一套', () => {
  assert.strictEqual(formatExpiryDate(UNTIL, 'zh-CN'), '2026-10-18');
  assert.strictEqual(formatExpiryDate(UNTIL, 'zh-TW'), '2026-10-18');
  assert.strictEqual(formatExpiryDate(UNTIL, 'en'), 'Oct 18, 2026');
  // 跨日边界：UTC 19:00 = 香港次日 03:00 → 日期必须按 UTC+8 走
  assert.strictEqual(formatExpiryDate(Date.UTC(2026, 9, 18, 19, 0, 0), 'zh-CN'), '2026-10-19');
});

test('planLabel：plus→Plus，pro→Pro', () => {
  assert.strictEqual(planLabel('plus'), 'Plus');
  assert.strictEqual(planLabel('pro'), 'Pro');
});

test('buildMembershipEmail(zh-CN)：新开通写「已开通」，含档位/到期日/天数/进站入口，无医疗承诺', () => {
  const { subject, html } = buildMembershipEmail('zh-CN', {
    username: '阿明', plan: 'plus', days: 30, unlockUntil: UNTIL,
  });
  assert.ok(subject.includes('小愈') && subject.includes('Plus') && subject.includes('已开通'), '主题应为「小愈 Plus 会员已开通」：' + subject);
  assert.ok(html.includes('阿明'), '正文应带用户昵称');
  assert.ok(html.includes('2026-10-18'), '正文应含到期日');
  assert.ok(html.includes('共 30 天'), '正文应含本次天数');
  assert.ok(html.includes('理一理无限畅聊'), 'Plus 应写清楚权益');
  assert.ok(html.includes('https://myxiaoyu.com/'), '应带进站入口');
  assert.ok(!/治疗|療程|therapy|treatment|cure\b/i.test(html), '品牌红线：不得出现治疗类承诺');
});

test('buildMembershipEmail(zh-CN)：续期写「已续期 / 有效期延长至」，不写「已开通」', () => {
  const { subject, html } = buildMembershipEmail('zh-CN', {
    username: '', plan: 'pro', days: 30, unlockUntil: UNTIL_RENEWED, renewal: true,
  });
  assert.ok(subject.includes('已续期'), '续期主题应为「已续期」：' + subject);
  assert.ok(html.includes('有效期延长至') && html.includes('2026-11-17') && html.includes('本次 +30 天'), '续期正文应写明延长到哪天、本次加了多少天');
  assert.ok(!subject.includes('已开通'), '续期不应再说「已开通」');
  assert.ok(html.includes('你好'), '无昵称时用「你好」兜底，不留空');
});

test('buildMembershipEmail(zh-TW)：繁体用字（會員/開通/進入），到期日不变', () => {
  const { subject, html } = buildMembershipEmail('zh-TW', {
    username: '小明', plan: 'plus', days: 30, unlockUntil: UNTIL,
  });
  assert.ok(subject.includes('會員') && subject.includes('已開通'), '繁中主题用字应正确：' + subject);
  assert.ok(html.includes('會員') && html.includes('進入 Xiaoyu'), '繁中正文/按钮用字应正确');
  assert.ok(html.includes('2026-10-18'), '到期日保持不变');
  assert.ok(!/会员|开通|进入/.test(html), '不应残留简体用字');
});

test('buildMembershipEmail(en)：全英文（无中日韩字符）+ 英文日期', () => {
  const { subject, html } = buildMembershipEmail('en', {
    username: 'Amy', plan: 'pro', days: 30, unlockUntil: UNTIL,
  });
  assert.ok(subject.includes('Xiaoyu Pro membership is active'), '英文主题：' + subject);
  assert.ok(html.includes('Oct 18, 2026') && html.includes('Amy'), '英文正文应含英文日期与昵称');
  assert.ok(!/[\u4e00-\u9fff]/.test(html), '英文邮件不应出现中日韩字符');
  assert.ok(!/[\u4e00-\u9fff]/.test(subject), '英文主题不应出现中日韩字符');
});

test('buildMembershipEmail：Pro 与 Plus 权益文案可区分（Pro 提「都无限畅聊」）', () => {
  const pro = buildMembershipEmail('zh-CN', { plan: 'pro', days: 30, unlockUntil: UNTIL });
  const plus = buildMembershipEmail('zh-CN', { plan: 'plus', days: 30, unlockUntil: UNTIL });
  // 2026-09-23：原 Pro 权益里的「全部陪伴方式」已删（档位退场），改用「都无限畅聊」这个 Pro 独有说法做区分
  assert.ok(pro.html.includes('都无限畅聊') && pro.html.includes('更长的记忆'), 'Pro 权益应与 Plus 不同');
  assert.ok(!plus.html.includes('都无限畅聊'), 'Plus 不应写成 Pro 的权益');
  assert.ok(!pro.html.includes('陪伴方式') && !plus.html.includes('陪伴方式'), '档位退场后邮件不再承诺「陪伴方式」');
  const proEn = buildMembershipEmail('en', { plan: 'pro', days: 30, unlockUntil: UNTIL });
  assert.ok(proEn.html.includes('Unlimited chats in both modes'), '英文 Pro 权益');
});

// ---------- 发信（跳过 / 语言 / 去重 / 失败） ----------

test('notifyMembershipGranted：按用户地区语言发给本人（console 模式日志可见收件人）', async () => {
  __resetMembershipMailDedupe();
  const hk = reg('member_hk', 'member-hk@example.com', 'HK');   // 港 → 繁中
  const cn = reg('member_cn', 'member-cn@example.com', 'CN');   // 大陆 → 简中
  const us = reg('member_us', 'member-us@example.com', 'US');   // 其它 → 英文

  const logs = withLogs(() => {
    void notifyMembershipGranted({ userId: hk, plan: 'plus', days: 30, unlockUntil: UNTIL });
    void notifyMembershipGranted({ userId: cn, plan: 'plus', days: 30, unlockUntil: UNTIL });
    void notifyMembershipGranted({ userId: us, plan: 'pro', days: 30, unlockUntil: UNTIL });
  });
  await tick();

  assert.ok(logs.some((l) => l.includes('MAIL:console') && l.includes('member-hk@example.com')), '港区用户应收到邮件');
  assert.ok(logs.some((l) => l.includes('已開通')), '港区用户应为繁中主题');
  assert.ok(logs.some((l) => l.includes('已开通') && l.includes('member-cn@example.com')), '大陆用户应为简中主题');
  assert.ok(logs.some((l) => l.includes('membership is active') && l.includes('member-us@example.com')), '其它地区用户应为英文主题');
});

test('notifyMembershipGranted：优先用显式语言偏好（无地区记录时）', async () => {
  __resetMembershipMailDedupe();
  const uid = reg('member_pref', 'member-pref@example.com'); // 无登录/地区记录
  preferenceStore.set(uid, { language: 'zh-CN' });
  const r = await notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.lang, 'zh-CN', '应尊重已保存的语言偏好');
  assert.ok((r.subject || '').includes('已开通'));
});

test('notifyMembershipGranted：账号不存在 / 无邮箱 → 不发信（返回跳过原因）', async () => {
  __resetMembershipMailDedupe();
  const ghost = await notifyMembershipGranted({ userId: 'no-such-user', plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(ghost.ok, false);
  assert.strictEqual(ghost.skipped, 'no-account');

  const uid = reg('member_noemail', 'member-noemail@example.com');
  const acc = accountStore.getById(uid)!;
  acc.email = ''; // 模拟无邮箱（游客/未绑定）
  const r = await notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, 'no-email');
});

test('notifyMembershipGranted：测试账号与开发者账号不发信', async () => {
  __resetMembershipMailDedupe();
  const testAcc = reg('member_test', 'member-test@test.com');
  const r1 = await notifyMembershipGranted({ userId: testAcc, plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(r1.skipped, 'test-account', '测试账号不发');

  process.env.DEV_ACCOUNTS = 'dev-owner@example.com';
  const devAcc = reg('member_dev', 'dev-owner@example.com');
  const r2 = await notifyMembershipGranted({ userId: devAcc, plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(r2.skipped, 'developer-account', '开发者账号不发');
});

test('notifyMembershipGranted：60 秒内重复开通只发一封（防手抖双击 / 连续续期）', async () => {
  __resetMembershipMailDedupe();
  const uid = reg('member_dedupe', 'member-dedupe@example.com', 'CN');
  assert.ok(MEMBERSHIP_MAIL_DEDUPE_MS >= 1000);
  const logs = withLogs(() => {
    void notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL });
    void notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL, renewal: true });
  });
  await tick();
  assert.strictEqual(logs.filter((l) => l.includes('[MAIL:console] to=member-dedupe@example.com')).length, 1, '只应发出一封');

  const again = await notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL });
  assert.strictEqual(again.skipped, 'deduped', '窗口内第二次应被去重');
});

test('notifyMembershipGranted：发信失败不抛，且不占用去重窗口（下次仍能发）', async () => {
  __resetMembershipMailDedupe();
  const uid = reg('member_fail', 'member-fail@example.com', 'CN');
  // console 模式 + NODE_ENV=production → sendEmail 拒绝发送（模拟通道不可用），走失败分支
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let failed;
  try {
    failed = await notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL });
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
  assert.strictEqual(failed.ok, false, '失败应如实返回 ok:false，而不是抛异常');
  assert.ok(!failed.skipped, '失败不是「跳过」，要能被审计日志区分出来');
  assert.ok((failed.detail || '').length > 0, '应带失败原因');

  const logs = withLogs(() => { void notifyMembershipGranted({ userId: uid, plan: 'plus', days: 30, unlockUntil: UNTIL }); });
  await tick();
  assert.ok(logs.some((l) => l.includes('[MAIL:console] to=member-fail@example.com')), '失败未占用去重窗口 → 恢复后应能补发');
});
