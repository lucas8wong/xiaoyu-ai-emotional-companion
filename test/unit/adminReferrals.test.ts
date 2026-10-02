import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

// 预设邀请码来自 .env 的 INVITE_CODES，且 quota.ts 在**模块加载时**解析它，必须在 import 之前设好
// （测试 cwd 是临时目录，没有 .env；dotenv 也不会覆盖已存在的环境变量）
process.env.INVITE_CODES = 'refselftest:20';
setupTempCwd();
const { quotaStore, INVITE_BONUS_COUNT, REFERRAL_MONTHLY_BONUS_DAYS, REFERRAL_INVITER_MIN_DAYS, REFERRAL_NEW_ACCOUNT_BOOST } = await import('../../api/services/quota.js');
const { accountStore } = await import('../../api/services/accounts.js');
const { paymentStore } = await import('../../api/services/payment.js');
const { referralEventStore } = await import('../../api/services/referralEvents.js');
const { buildReferralReport, buildMyReferralSummary, maskInviteeEmail } = await import('../../api/services/adminReferrals.js');

/**
 * 「📣 邀请推广」测试（控制台：谁的推广链接被谁用了 / 拉了多少人 / 赚了多少额度与会员天数）
 *
 * 覆盖四件事：
 *  ① 回算：没有台账时（台账上线前的历史），按「inviteCount 个最早的被邀人 + 注册时间」推定发放；
 *  ② 台账：本功能上线后每一笔真实发放逐条记录，区间统计用它（精确）；
 *  ③ 区间 vs 累计：区间只统计区间内**发生**的事件；
 *  ④ 首购会员天数与「月付送半月」，以及测试账号不计入。
 */

const DAY = 86400000;
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function ymdDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * DAY);
  return ymd(d);
}

/** 注册一个账号；ageDays 回拨 createdAt 以模拟「注册满 N 天」（邀请人须满 7 天邀请才有效） */
function registerAccount(seed: string, ageDays = 8): string {
  const r = accountStore.register({ username: 'ref_' + seed, email: seed + '@example.com', password: 'secret1' });
  assert.ok(r.user, '账号注册应成功: ' + seed);
  (r.user as any).createdAt = Date.now() - ageDays * DAY;
  return r.user!.userId;
}

function rowOf(rep: any, userId: string) {
  return (rep.inviters || []).find((r: any) => r.userId === userId);
}

// 【① 回算（必须最先跑：此时台账还没有任何事件，模拟「台账上线前」的历史）】
test('回算：无台账时，按 inviteCount 取最早的被邀人推定发放，并标「近似」', () => {
  const inviter = registerAccount('inv-est');
  const early = registerAccount('est-early', 1);
  const late = registerAccount('est-late', 1);
  quotaStore.setInvitedBy(early, inviter, 'dev-est-a', '9.9.9.2');
  quotaStore.setInvitedBy(late, inviter, 'dev-est-b', '9.9.9.3');
  quotaStore.recordInvite(inviter); // 只成功 1 人（另一人被反套利拦下 / 记录只剩归因）

  assert.strictEqual(referralEventStore.size(), 0, '此时还没有任何台账');

  const rep = buildReferralReport();
  const row = rowOf(rep, inviter);
  assert.ok(row, '邀请人应出现在榜上');
  assert.strictEqual(row.invitedAll, 2, '两人经链接注册 → 归因 2 人');
  assert.strictEqual(row.rewardedAll, 1, '只发了 1 人的奖励');
  assert.strictEqual(row.creditsAll, INVITE_BONUS_COUNT, '回算额度 = 1 人 × 邀请额度');
  assert.strictEqual(row.invitees.filter((i: any) => i.source === 'estimate').length, 1, '恰有 1 条回算');
  assert.strictEqual(row.invitees.filter((i: any) => i.source === 'none').length, 1, '另一人归因但未发放');
  assert.strictEqual(row.invitees.find((i: any) => i.source === 'none').credits, 0, '未发放的人不计额度');
  assert.strictEqual(rep.approximate, true, '含回算 → 报告标「近似」');
});

// 【①b 邀请码回算（同样要跑在台账之前）】
test('邀请码回算：台账上线前的用码注册，按当前码额度估算并标「近似」', () => {
  const uid = registerAccount('code-est', 1);
  quotaStore.setInviteCodeUsed(uid, 'RefSelfTest'); // 大小写混写 → 报告里统一小写
  const rep = buildReferralReport();
  const row = (rep.codes || []).find((c: any) => c.code === 'refselftest');
  assert.ok(row, '被用过的邀请码应出现在 codes 里');
  assert.strictEqual(row.bonus, 20, '额度取自 INVITE_CODES 配置');
  assert.strictEqual(row.registrationsAll, 1);
  assert.strictEqual(row.creditsAll, 20, '回算额度 = 用码人数 × 码额度');
  assert.strictEqual(row.users[0].source, 'estimate');
  // 注：mode='all' 时 inRange 恒真 → 行内的 Range 字段等于累计字段（控制台在累计视图只读 All 字段）
  assert.strictEqual(row.creditsRange, row.creditsAll);
  assert.strictEqual(rep.totals.codeRegistrationsAll, 1);
  assert.strictEqual(rep.totals.codeCreditsAll, 20);
  const old = buildReferralReport({ from: '2020-01-01', to: '2020-01-31' });
  assert.strictEqual(old.totals.codeRegistrationsRange, 0);
  assert.strictEqual(old.totals.codeCreditsRange, 0);
  assert.strictEqual(old.totals.codesRange, 0);
});

// 【② 台账（精确）】
test('台账：logSignupInvite 记一条，报告按它出额度与来源', () => {
  const inviter = registerAccount('inv-led');
  const invitee = registerAccount('led-e1', 1);
  quotaStore.setInvitedBy(invitee, inviter, 'dev-led-a', '9.9.9.11');
  quotaStore.addBonus(inviter, INVITE_BONUS_COUNT, 'invite');
  quotaStore.recordInvite(inviter);
  quotaStore.logSignupInvite(inviter, invitee, INVITE_BONUS_COUNT, INVITE_BONUS_COUNT);

  assert.strictEqual(referralEventStore.size(), 1, '台账应有 1 条');
  const rep = buildReferralReport();
  const row = rowOf(rep, inviter);
  assert.strictEqual(row.creditsAll, INVITE_BONUS_COUNT);
  assert.strictEqual(row.inviteeCreditsAll, INVITE_BONUS_COUNT, '被邀人同额（成本口径）');
  assert.strictEqual(row.invitees[0].source, 'ledger', '有台账 → 精确来源');
  assert.strictEqual(rep.ledger.events, 1);
  assert.ok(rep.ledger.since, '台账覆盖起点应可得');
});

test('邀请码台账：logInviteCodeUse 记一条，码行按它出额度与来源；下线的码只统计人数', () => {
  const uid = registerAccount('code-led', 1);
  quotaStore.setInviteCodeUsed(uid, 'refselftest');
  quotaStore.logInviteCodeUse('refselftest', uid, 20);

  // 已从 .env 下线的码：只统计人数，额度未知（bonus=null，不估算）
  const legacy = registerAccount('code-legacy', 1);
  quotaStore.setInviteCodeUsed(legacy, 'legacy-offline-code');

  const rep = buildReferralReport();
  const row = (rep.codes || []).find((c: any) => c.code === 'refselftest');
  const off = (rep.codes || []).find((c: any) => c.code === 'legacy-offline-code');
  assert.strictEqual(row.registrationsAll, 2, '两个账号用过该码（含前一个测试的）');
  assert.strictEqual(row.creditsAll, 40, '20（回算）+ 20（台账）');
  assert.strictEqual(row.users.filter((u: any) => u.source === 'ledger').length, 1, '恰有一条精确台账');
  assert.ok(row.users.some((u: any) => u.credits === 20 && u.source === 'ledger' && u.rewarded), '台账那条带额度');
  assert.ok(off, '下线的码也要出现在榜上（否则运营看不到它被用过）');
  assert.strictEqual(off.bonus, null, '码已下线 → 额度未知');
  assert.strictEqual(off.registrationsAll, 1);
  assert.strictEqual(off.creditsAll, 0, '额度未知时不估算，如实记 0');
  assert.strictEqual(rep.totals.codesAll, 2);
  assert.strictEqual(rep.totals.codeRegistrationsAll, 3);
  assert.strictEqual(rep.totals.codeCreditsAll, 40);
  // 区间：今天发生的用码事件应计入区间口径
  const today = buildReferralReport({ from: ymdDaysAgo(2), to: ymd(new Date()) });
  assert.ok(today.totals.codeCreditsRange >= 20, '区间内发出额度应含台账那条');
  assert.ok(today.totals.codeRegistrationsRange >= 1, '区间内用码注册人数');
});

// 【②b 注册后补填（2026-09）：与注册路径同源发放、一人一次、无效码不落状态】
test('补填邀请码：applyInviteCode 同源发放 + 一人一次 + 无效码拒绝', () => {
  const uid = registerAccount('code-late', 1);
  const before = buildReferralReport();

  const r1 = quotaStore.applyInviteCode(uid, 'refselftest');
  assert.deepStrictEqual(r1, { ok: true, bonus: 20 }, '有效码应发放 20 条（额度取自 INVITE_CODES 配置）');
  assert.strictEqual(quotaStore.getRecord(uid)?.inviteCodeUsed, 'refselftest', '补填也要落 inviteCodeUsed（控制台统计口径）');

  const r2 = quotaStore.applyInviteCode(uid, 'refselftest');
  assert.deepStrictEqual(r2, { ok: false, reason: 'already-used' }, '一人一次：重复补填应拒绝');
  assert.strictEqual(quotaStore.applyInviteCode(uid, 'refselftest').ok, false, '拒绝不发放（幂等）');

  const other = registerAccount('code-bad', 1);
  assert.deepStrictEqual(quotaStore.applyInviteCode(other, 'no-such-code'), { ok: false, reason: 'invalid-code' }, '无效码应拒绝');
  assert.strictEqual(quotaStore.getRecord(other)?.inviteCodeUsed, undefined, '无效码不应落 inviteCodeUsed');

  // 台账与注册路径同源：补填也要逐条记账，否则控制台「📣 邀请推广」看不到这笔发放
  const after = buildReferralReport();
  assert.strictEqual(after.totals.codeCreditsAll, before.totals.codeCreditsAll + 20, '补填发放应进台账（累计口径）');
  assert.strictEqual(after.totals.codeRegistrationsAll, before.totals.codeRegistrationsAll + 1, '用码人数 +1（无效/重复不算）');
});

// 【③ 区间 vs 累计】
test('区间：只统计区间内发生的事件；更早区间为 0', () => {
  const today = buildReferralReport({ from: ymdDaysAgo(2), to: ymd(new Date()) });
  const old = buildReferralReport({ from: '2020-01-01', to: '2020-01-31' });
  assert.strictEqual(today.mode, 'range');
  assert.ok(today.totals.creditsRange >= INVITE_BONUS_COUNT, '今天发生的邀请应计入区间');
  assert.strictEqual(old.totals.creditsRange, 0, '2020 年区间没有事件');
  assert.strictEqual(old.totals.invitedRange, 0, '2020 年区间没有新被邀人');
  assert.ok(old.totals.creditsAll >= today.totals.creditsRange, '累计口径 ≥ 区间口径');
});

// 【④ 首购 → 邀请人同档会员（封顶年付）+ 被邀人月付送半月】
test('台账：被邀人首购 → 邀请人获得同档天数，月付再加赠半月；天数只记一次', () => {
  const inviter = registerAccount('inv-buy');
  quotaStore.noteDevice(inviter, 'dev-inv-buy', '5.6.7.8');
  const invitee = registerAccount('buy-e1', 1);
  quotaStore.setInvitedBy(invitee, inviter, 'dev-buy-e1', '1.2.3.4');

  const r = quotaStore.rewardInviterForPurchase(invitee, 'plus', 'monthly', 30);
  assert.strictEqual(r.inviter, inviter, '首次购买应奖励邀请人');
  assert.strictEqual(r.inviterDays, 30);
  assert.strictEqual(r.friendBonusDays, REFERRAL_MONTHLY_BONUS_DAYS, '月付应给被邀人送半月');

  let row = rowOf(buildReferralReport(), inviter);
  assert.strictEqual(row.memberDaysAll, 30, '邀请人获得 30 天');
  assert.strictEqual(row.purchaseCountAll, 1);
  assert.strictEqual(row.friendBonusDaysAll, REFERRAL_MONTHLY_BONUS_DAYS, '月付加赠计入成本口径');
  assert.strictEqual(row.invitees[0].purchase.source, 'ledger');

  // 同一被邀人再次购买：天数不重复发（首购只奖一次）
  quotaStore.rewardInviterForPurchase(invitee, 'pro', 'monthly', 30);
  row = rowOf(buildReferralReport(), inviter);
  assert.strictEqual(row.memberDaysAll, 30, '第二次购买不再给邀请人加天数');
  assert.strictEqual(row.purchaseCountAll, 1, '首购次数仍为 1');
});

test('回算：无台账天数时，用被邀人首笔已解锁订单回算（标「近似」）', () => {
  const inviter = registerAccount('inv-order');
  quotaStore.noteDevice(inviter, 'dev-inv-order', '5.6.7.9');
  const invitee = registerAccount('order-e1', 1);
  quotaStore.setInvitedBy(invitee, inviter, 'dev-order-e1', '1.2.3.6');
  // days=0 → 不记台账天数，只用它把「首购已走过奖励判定」标记上（模拟台账上线前的历史）
  quotaStore.rewardInviterForPurchase(invitee, 'plus', 'yearly', 0);
  const order = paymentStore.createOrder(invitee, 'plus', 365, 'yearly');
  paymentStore.markUnlocked(order.orderId, Date.now() + 365 * DAY);

  const rep = buildReferralReport();
  const row = rowOf(rep, inviter);
  assert.strictEqual(row.memberDaysAll, 365, '年付按订单天数回算');
  assert.strictEqual(row.invitees[0].purchase.source, 'estimate');
});

// 【⑤ 边界：测试账号不计入；游客推广人照常列出】
test('边界：测试账号不计入统计；游客推广人（无账号）仍列出', () => {
  const inviter = registerAccount('inv-edge');
  const tester = accountStore.register({ username: 'ref_tester', email: 'tester@test.com', password: 'secret1' });
  quotaStore.setInvitedBy(tester.user!.userId, inviter, 'dev-t', '7.7.7.7');
  quotaStore.recordInvite(inviter);

  const rep = buildReferralReport();
  const row = rowOf(rep, inviter);
  assert.ok(row, '邀请人仍在榜（inviteCount>0）');
  assert.strictEqual(row.invitedAll, 0, '被邀人是测试账号 → 不计入');
  assert.strictEqual(row.creditsAll, 0);

  // 游客推广人：inviterId 不是账号（同设备指纹哈希的游客也可能分享链接）
  const e = registerAccount('guest-e1', 1);
  quotaStore.setInvitedBy(e, 'guestinviter0001', 'dev-ge1', '1.2.3.5');
  quotaStore.recordInvite('guestinviter0001');
  const guestRow = rowOf(buildReferralReport(), 'guestinviter0001');
  assert.ok(guestRow, '游客推广人也应列出');
  assert.strictEqual(guestRow.kind, 'guest');
  assert.match(guestRow.name, /^游客设备/);
});

test('台账户均写盘：referral-events.json 内容与内存一致（重启后不丢）', async () => {
  const raw = referralEventStore.listAll();
  const { dataFile, readJson } = await import('../../api/storage/persistence.js');
  const onDisk = readJson<any[]>(dataFile('referral-events.json'), []);
  assert.strictEqual(onDisk.length, raw.length, '落盘条数与内存一致');
  assert.ok(onDisk.every(e => ['signup', 'purchase', 'code', 'signup_rejected'].includes(e.kind)), '每条都有 kind（signup=推广链接注册 / signup_rejected=没发奖励 / purchase=首购会员天数 / code=预设邀请码）');
});

// 【⑥ 未发放原因（「人来了为什么没算」）】
test('未发放原因：台账留痕优先（当时判定），无留痕的历史按现有数据有限推定', () => {
  // (a) 台账留痕：注册当刻判定的原因（同设备自邀）
  const inviterA = registerAccount('rej-a');
  const inviteeA = registerAccount('rej-a1', 1);
  quotaStore.setInvitedBy(inviteeA, inviterA, 'dev-rej-a', '3.3.3.1');
  quotaStore.logSignupRejected(inviterA, inviteeA, 'same-device');
  const rowA = rowOf(buildReferralReport(), inviterA);
  assert.strictEqual(rowA.invitees[0].rewarded, false);
  assert.strictEqual(rowA.invitees[0].rejectReason, 'same-device');
  assert.strictEqual(rowA.invitees[0].rejectReasonSource, 'ledger', '有留痕 → 「当时判定」');

  // (b) 推定：邀请人当时还不是注册账号（游客分享）→ 可精确推定，标记为 estimate
  const inviteeB = registerAccount('rej-b1', 1);
  quotaStore.setInvitedBy(inviteeB, 'guest-rej-inviter', 'dev-rej-b', '3.3.3.2');
  const rowB = rowOf(buildReferralReport(), 'guest-rej-inviter');
  assert.strictEqual(rowB.invitees[0].rejectReason, 'inviter-not-account');
  assert.strictEqual(rowB.invitees[0].rejectReasonSource, 'estimate');

  // (c) 2026-09-19 B 方案后：邀请人账号年龄**不再是**拒绝原因（默认 minDays=0）
  //     没有台账留痕、又推不出别的原因时，如实标 unknown（不编「邀请人太新」）
  const inviterC = registerAccount('rej-c', 2); // 注册才 2 天
  const inviteeC = registerAccount('rej-c1', 1);
  quotaStore.setInvitedBy(inviteeC, inviterC, 'dev-rej-c', '3.3.3.3');
  const rowC = rowOf(buildReferralReport(), inviterC);
  assert.strictEqual(REFERRAL_INVITER_MIN_DAYS, 0, '默认不设邀请人年龄门槛');
  assert.strictEqual(rowC.invitees[0].rejectReason, 'unknown');
  assert.strictEqual(rowC.invitees[0].rejectReasonSource, null);

  // (d) 其余历史情况：如实标 unknown（不编原因）
  const inviterD = registerAccount('rej-d');
  const inviteeD = registerAccount('rej-d1', 1);
  quotaStore.setInvitedBy(inviteeD, inviterD, 'dev-rej-d', '3.3.3.4');
  const rowD = rowOf(buildReferralReport(), inviterD);
  assert.strictEqual(rowD.invitees[0].rejectReason, 'unknown');
  assert.strictEqual(rowD.invitees[0].rejectReasonSource, null);

  // 汇总：未计入人数（累计/区间都用同一套行算出来）
  const rep = buildReferralReport({ from: ymdDaysAgo(2), to: ymd(new Date()) });
  assert.ok(rep.totals.rejectedAll >= 4, '未计入人数应含上述 4 例');
  assert.ok(rep.totals.rejectedRange >= 4, '都是近两天注册的 → 区间口径同样计入');
});

// 【⑦ 用户侧「我的邀请记录」】
test('用户侧邀请记录：只给自己那一行 + 邮箱打码 + 资格判定', () => {
  const inviter = registerAccount('my-inv');
  quotaStore.noteDevice(inviter, 'dev-my-inv', '6.6.7.8');
  const ok = registerAccount('my-f1', 1);
  quotaStore.setInvitedBy(ok, inviter, 'dev-my-f1', '6.6.6.1');
  quotaStore.addBonus(inviter, INVITE_BONUS_COUNT, 'invite');
  quotaStore.recordInvite(inviter);
  quotaStore.logSignupInvite(inviter, ok, INVITE_BONUS_COUNT, INVITE_BONUS_COUNT);
  // 一个「注册了但没计入」的朋友
  const skipped = registerAccount('my-f2', 1);
  quotaStore.setInvitedBy(skipped, inviter, 'dev-my-f2', '6.6.6.2');
  quotaStore.logSignupRejected(inviter, skipped, 'same-ip');

  const mine = buildMyReferralSummary(inviter);
  assert.strictEqual(mine.eligible, true, '注册满 7 天 → 有邀请资格');
  assert.strictEqual(mine.invitedCount, 2);
  assert.strictEqual(mine.rewardedCount, 1);
  assert.strictEqual(mine.pendingCount, 0, '没有待激活（两人都已结算/已判定）');
  assert.strictEqual(mine.rejectedCount, 1, '未计入人数（反套利拦下）');
  assert.strictEqual(mine.creditsEarned, INVITE_BONUS_COUNT);
  assert.strictEqual(mine.invitees.length, 2);
  assert.ok(mine.invitees.every(i => i.maskedEmail === 'my***@example.com'), '邮箱打码（保留前 2 位 + 域名，本地名其余部分用 ***）');
  assert.ok(mine.invitees.some(i => i.rewarded && i.credits === INVITE_BONUS_COUNT));
  const skippedRow = mine.invitees.find(i => !i.rewarded);
  assert.strictEqual(skippedRow?.rejectReason, 'same-ip', '未计入原因随行返回（前端按语言映射文案）');
  // 别人的记录不会漏进来
  const other = buildMyReferralSummary(registerAccount('my-other'));
  assert.strictEqual(other.invitedCount, 0);
  assert.deepStrictEqual(other.invitees, []);
  // 刚注册的账号同样有邀请资格（2026-09-19 B 方案取消了「邀请人须注册满 7 天」）
  const fresh = buildMyReferralSummary(registerAccount('my-fresh', 1));
  assert.strictEqual(fresh.eligible, true, '刚注册也能邀请（门槛已移到被邀人侧）');
  assert.strictEqual(fresh.ineligibleReason, null);
  assert.strictEqual(fresh.daysUntilEligible, 0);
  // 游客（非账号）→ not-account
  const guest = buildMyReferralSummary('guest-device-xyz');
  assert.strictEqual(guest.eligible, false);
  assert.strictEqual(guest.ineligibleReason, 'not-account');
  assert.strictEqual(guest.invitedCount, 0);
});

test('邮箱打码：保留前 2 位 + 域名，非法输入返回 null', () => {
  assert.strictEqual(maskInviteeEmail('abcd@gmail.com'), 'ab***@gmail.com');
  assert.strictEqual(maskInviteeEmail('a@x.com'), 'a***@x.com');
  assert.strictEqual(maskInviteeEmail('not-an-email'), null);
  assert.strictEqual(maskInviteeEmail(null), null);
});

// 【⑧ B 方案：待激活 → 首次真实使用才结算（含新账号 ×1.5）】
test('B 方案：注册只进「待激活」（未计入原因是 invitee-inactive），被邀人开口后才结算并按 ×1.5 加成', () => {
  const inviter = registerAccount('b-new', 1); // 刚注册 1 天 → 落在加成窗口内
  quotaStore.noteDevice(inviter, 'dev-b-inv', '5.5.1.1');
  const invitee = registerAccount('b-f1', 1);
  quotaStore.setInvitedBy(invitee, inviter, 'dev-b-f1', '5.5.2.2');

  // 注册当刻（auth.ts 的动作）：被邀人 +50 立刻发，邀请人侧只进待激活
  quotaStore.addChatBonus(invitee, INVITE_BONUS_COUNT, 'invite');
  quotaStore.markInvitePending(invitee, INVITE_BONUS_COUNT);

  const before = rowOf(buildReferralReport(), inviter);
  assert.strictEqual(before.invitedAll, 1, '有归因');
  assert.strictEqual(before.rewardedAll, 0, '还没结算');
  assert.strictEqual(before.pendingAll, 1, '应计入待激活');
  assert.strictEqual(before.rejectedAll, 0, '待激活不算「未计入」');
  assert.strictEqual(before.invitees[0].pending, true);
  assert.strictEqual(before.invitees[0].rejectReason, 'invitee-inactive', '原因如实写「人来了还没开口」');
  assert.strictEqual(before.invitees[0].rejectReasonSource, 'ledger');
  assert.strictEqual(before.inviteeCreditsAll, INVITE_BONUS_COUNT, '被邀人那 50 条在注册时已发（成本口径要看得见）');

  // 被邀人首次真实使用 → 结算；新账号加成 1.5 → 50 × 1.5 = 75
  const r = quotaStore.qualifyInvite(invitee);
  assert.strictEqual(r.settled, true);
  assert.strictEqual(r.inviterCredits, Math.round(INVITE_BONUS_COUNT * REFERRAL_NEW_ACCOUNT_BOOST));

  const after = rowOf(buildReferralReport(), inviter);
  assert.strictEqual(after.rewardedAll, 1);
  assert.strictEqual(after.pendingAll, 0, '结算后不再是待激活');
  assert.strictEqual(after.boostedAll, 1, '该笔享了新账号加成');
  assert.strictEqual(after.creditsAll, 75, '额度 = 50 × 1.5');
  assert.strictEqual(after.invitees[0].boost, REFERRAL_NEW_ACCOUNT_BOOST);
  assert.strictEqual(after.invitees[0].rewarded, true);
  assert.strictEqual(after.invitees[0].rejectReason, null);

  const rep = buildReferralReport();
  assert.ok(rep.totals.pendingAll >= 0 && rep.totals.boostedAll >= 1, '合计里也要有加成笔数');
  assert.strictEqual(rep.config.newAccountBoost, REFERRAL_NEW_ACCOUNT_BOOST);
  assert.strictEqual(rep.config.newAccountBoostDays, 7);
  assert.strictEqual(rep.config.inviterMinDays, 0, '配置如实反映「不设邀请人年龄门槛」');
});

test('B 方案：用户侧摘要区分「待激活」与「未计入」，并带加成标记', () => {
  const inviter = registerAccount('b2-inv', 1);
  quotaStore.noteDevice(inviter, 'dev-b2-inv', '6.6.1.1');
  const pendingFriend = registerAccount('b2-p', 1);
  quotaStore.setInvitedBy(pendingFriend, inviter, 'dev-b2-p', '6.6.2.2');
  quotaStore.markInvitePending(pendingFriend, INVITE_BONUS_COUNT);
  const qualifiedFriend = registerAccount('b2-q', 1);
  quotaStore.setInvitedBy(qualifiedFriend, inviter, 'dev-b2-q', '6.6.3.3');
  quotaStore.markInvitePending(qualifiedFriend, INVITE_BONUS_COUNT);
  quotaStore.qualifyInvite(qualifiedFriend);
  // 一个被反套利拦下的（同设备）
  const blockedFriend = registerAccount('b2-b', 1);
  quotaStore.setInvitedBy(blockedFriend, inviter, 'dev-b2-inv', '6.6.4.4');
  quotaStore.logSignupRejected(inviter, blockedFriend, 'same-device');

  const mine = buildMyReferralSummary(inviter);
  assert.strictEqual(mine.eligible, true, '刚注册也有资格（不再要求注册满 7 天）');
  assert.strictEqual(mine.invitedCount, 3);
  assert.strictEqual(mine.rewardedCount, 1);
  assert.strictEqual(mine.pendingCount, 1, '待激活 1 人');
  assert.strictEqual(mine.rejectedCount, 1, '未计入 1 人');
  assert.strictEqual(mine.creditsEarned, Math.round(INVITE_BONUS_COUNT * REFERRAL_NEW_ACCOUNT_BOOST), '额度含 ×1.5');
  const boosted = mine.invitees.find(i => i.rewarded);
  assert.strictEqual(boosted?.boost, REFERRAL_NEW_ACCOUNT_BOOST);
  const pendingRow = mine.invitees.find(i => i.pending);
  assert.strictEqual(pendingRow?.rejectReason, 'invitee-inactive');
  assert.strictEqual(pendingRow?.maskedEmail, 'b2***@example.com');
  assert.strictEqual(mine.config.minDays, 0);
  assert.strictEqual(mine.config.newAccountBoost, REFERRAL_NEW_ACCOUNT_BOOST);
});
