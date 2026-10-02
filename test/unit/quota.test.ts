import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { quotaStore, estimateChatCredit, REFERRAL_INVITER_MIN_DAYS, REFERRAL_NEW_ACCOUNT_BOOST, REFERRAL_NEW_ACCOUNT_BOOST_DAYS, GUEST_DAILY_CREDIT, FREE_DAILY_CREDIT, UNIT_CREDIT } = await import('../../api/services/quota.js');
const { accountStore } = await import('../../api/services/accounts.js');

// 注册一个邀请人账号，可回拨 createdAt 以模拟“注册满 N 天”
function registerInviter(seed: string, ageDays = 8): string {
  const r = accountStore.register({ username: 'inv_' + seed, email: seed + '@test.com', password: 'secret1' });
  assert.ok(r.user, '邀请人注册应成功: ' + seed);
  (r.user as any).createdAt = Date.now() - ageDays * 86400000; // 同一进程内对象回拨，accountStore.getById 返回同一引用
  return r.user!.userId;
}

/**
 * 注册一个普通免费档账号（2026-09-27 分档后：**注册账号才拿免费档日额度**，裸 ID 是游客档 = 5 条/天）。
 * 凡是「要连做多笔点数」的用例都该用注册账号，否则会被游客档的 5 条日额度拦下（那是另一条规则）。
 */
function registerFree(seed: string): string {
  const r = accountStore.register({ username: 'free_' + seed, email: 'free_' + seed + '@test.com', password: 'secret1' });
  assert.ok(r.user, '免费档账号注册应成功: ' + seed);
  return r.user!.userId;
}

test('identify：确定性 + 格式', () => {
  const a = quotaStore.identify('deviceA', '1.2.3.4');
  const b = quotaStore.identify('deviceA', '1.2.3.4');
  const c = quotaStore.identify('deviceA', '5.6.7.8');
  assert.strictEqual(a, b, '相同输入应得到相同 ID');
  assert.notStrictEqual(a, c, '不同 IP 应得到不同 ID');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('理一理额度：consume/rollback（默认 FREE_STRUCT=3）', () => {
  const uid = 'q-struct';
  assert.strictEqual(quotaStore.consume(uid), true);
  assert.strictEqual(quotaStore.consume(uid), true);
  assert.strictEqual(quotaStore.consume(uid), true);
  assert.strictEqual(quotaStore.consume(uid), false, '3 次用尽后应拒绝');
  quotaStore.rollback(uid);
  assert.strictEqual(quotaStore.consume(uid), true, '回滚后应可再消耗一次');
});

test('unlock 续费不降级：pro 续 plus 仍保持 pro', () => {
  const uid = 'q-nodown';
  quotaStore.setPlan(uid, 'pro');
  quotaStore.unlock(uid, 30, 'plus');
  assert.strictEqual(quotaStore.getQuota(uid).plan, 'pro', 'pro 续 plus 不应降级');

  const uid2 = 'q-plus';
  quotaStore.unlock(uid2, 30, 'plus');
  assert.strictEqual(quotaStore.getQuota(uid2).plan, 'plus');
});

test('聊一聊每日额度：plus 消耗/回滚', () => {
  const uid = 'q-chat';
  quotaStore.setPlan(uid, 'plus');
  const q = quotaStore.getChatQuota(uid);
  assert.strictEqual(q.plan, 'plus');
  assert.strictEqual(q.canChat, true);
  assert.strictEqual(quotaStore.consumeChat(uid), true);
  assert.strictEqual(quotaStore.getChatQuota(uid).usedToday, 1);
  quotaStore.rollbackChat(uid);
  assert.strictEqual(quotaStore.getChatQuota(uid).usedToday, 0);
});

test('邀请/奖励：addBonus + consumeReward', () => {
  const uid = 'q-bonus';
  quotaStore.addBonus(uid, 3, 'invite');
  const q = quotaStore.getQuota(uid);
  assert.strictEqual(q.bonusFree, 3);
  assert.ok(q.pendingReward, '应有待通知奖励');
  quotaStore.consumeReward(uid);
  assert.strictEqual(quotaStore.getQuota(uid).pendingReward, null);
});

test('邀请防刷上限（INVITE_MAX=20）', () => {
  const uid = 'q-invite';
  for (let i = 0; i < 20; i++) quotaStore.recordInvite(uid);
  assert.strictEqual(quotaStore.canInviteMore(uid), false);
});

test('买断（lifetime）：lifetime 标记 + 远期有效期 + 对外呈现 pro 级', () => {
  const uid = 'q-lifetime';
  quotaStore.unlockLifetime(uid, 'pro');
  const q = quotaStore.getQuota(uid);
  assert.strictEqual(q.lifetime, true, '应标记 lifetime');
  assert.strictEqual(q.plan, 'pro', 'lifetime 权益按 pro 级');
  assert.ok((q.unlockUntil || 0) > Date.now() + 3650 * 86400000 - 60000, '有效期应约 10 年');
});

test('引荐有效：邀请人注册满7天 + 设备/IP不同 → 首购邀请人同档会员（月付对等）', () => {
  const inviterId = registerInviter('valid');
  const invitee = 'q-ref-valid';
  quotaStore.noteDevice(inviterId, 'dev-inviter', '5.6.7.8');
  quotaStore.setInvitedBy(invitee, inviterId, 'dev-friend', '1.2.3.4');

  const v = quotaStore.isReferralValid(invitee);
  assert.strictEqual(v.valid, true, '设备/IP 均不同 + 邀请人满 7 天应有效: ' + JSON.stringify(v));

  const before = quotaStore.getRecord(inviterId)?.unlockUntil || 0;
  const r = quotaStore.rewardInviterForPurchase(invitee, 'plus', 'monthly', 30);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.inviter, inviterId, '首次付费应奖励邀请人');
  assert.strictEqual(r.inviterDays, 30, '邀请人应得同档（月付 30 天），不封顶减免');
  assert.strictEqual(r.friendBonusDays, 15, '被邀人月付应送半月');
  const after = quotaStore.getRecord(inviterId)?.unlockUntil || 0;
  assert.ok(after >= before + 30 * 86400000, '邀请人会员应延长 ≥30 天');
  assert.strictEqual(quotaStore.getRecord(inviterId)?.plan, 'plus', '邀请人应得同档会员');

  const r2 = quotaStore.rewardInviterForPurchase(invitee, 'pro', 'monthly', 30);
  assert.strictEqual(r2.inviter, null, '同一被邀人只奖励一次');
  assert.strictEqual(r2.friendBonusDays, 15, '被邀人再次月付仍送半月（只要引荐仍有效）');
});

test('引荐年付封顶：购买年付/终身 → 邀请人封顶 365 天', () => {
  const inviterId = registerInviter('cap');
  const invitee = 'q-ref-cap';
  quotaStore.noteDevice(inviterId, 'dev-cap', '9.9.9.9');
  quotaStore.setInvitedBy(invitee, inviterId, 'dev-cap-f', '8.8.8.8');

  const rg = quotaStore.rewardInviterForPurchase(invitee, 'pro', 'yearly', 365);
  assert.strictEqual(rg.inviterDays, 365, '年付 365 天不超额');
  assert.strictEqual(rg.friendBonusDays, 0, '年付不送半月');

  const inviter2 = registerInviter('cap2');
  const invitee2 = 'q-ref-cap2';
  quotaStore.noteDevice(inviter2, 'dev-cap2', '7.7.7.7');
  quotaStore.setInvitedBy(invitee2, inviter2, 'dev-cap2-f', '6.6.6.6');
  const rl = quotaStore.rewardInviterForPurchase(invitee2, 'pro', 'lifetime', 3650);
  assert.strictEqual(rl.inviterDays, 365, '终身档封顶为年付 365 天');
  assert.strictEqual(rl.friendBonusDays, 0, '终身档不送半月');
});

test('引荐反套利：设备相同 → 无效；IP 相同 → 无效；邀请人非账号 → 无效（**新账号不再被拦**）', () => {
  // 同设备
  const invD = registerInviter('samedev');
  quotaStore.noteDevice(invD, 'dev-same', '5.5.5.5');
  const eD = 'q-ref-samedev';
  quotaStore.setInvitedBy(eD, invD, 'dev-same', '4.4.4.4');
  const vD = quotaStore.isReferralValid(eD);
  assert.strictEqual(vD.valid, false);
  assert.strictEqual(vD.reason, 'same-device');

  // 同 IP
  const invI = registerInviter('sameip');
  quotaStore.noteDevice(invI, 'dev-inv', '3.3.3.3');
  const eI = 'q-ref-sameip';
  quotaStore.setInvitedBy(eI, invI, 'dev-friend-ip', '3.3.3.3');
  const vI = quotaStore.isReferralValid(eI);
  assert.strictEqual(vI.valid, false);
  assert.strictEqual(vI.reason, 'same-ip');

  // 邀请人非注册账号
  const eN = 'q-ref-noacc';
  quotaStore.setInvitedBy(eN, 'fake-user-not-account', 'dev-a', '2.2.2.2');
  const vN = quotaStore.isReferralValid(eN);
  assert.strictEqual(vN.valid, false);
  assert.strictEqual(vN.reason, 'inviter-not-account');

  // 邀请人刚注册（1 天）——2026-09-19 B 方案：**不再拦**（门槛改到被邀人侧「首次真实使用」）
  const invT = registerInviter('toonew', 1);
  quotaStore.noteDevice(invT, 'dev-new', '1.1.1.1');
  const eT = 'q-ref-toonew';
  quotaStore.setInvitedBy(eT, invT, 'dev-new-f', '0.0.0.0');
  const vT = quotaStore.isReferralValid(eT);
  assert.strictEqual(vT.valid, true, '新账号分享链接应有效（旧「注册满 7 天」门槛已取消）: ' + JSON.stringify(vT));
  assert.strictEqual(REFERRAL_INVITER_MIN_DAYS, 0, '默认不设邀请人年龄门槛（.env 可调回 >0）');
});

test('千世书 AI 托管：仅 pro/lifetime 允许 + 每日上限记账/回滚', () => {
  const free = 'q-auto-free';
  assert.strictEqual(quotaStore.canAutoPlay(free).allowed, false, '免费不可托管');
  quotaStore.setPlan(free, 'plus');
  assert.strictEqual(quotaStore.canAutoPlay(free).allowed, false, 'Plus 不可托管');
  const pro = 'q-auto-pro';
  quotaStore.setPlan(pro, 'pro');
  const ap = quotaStore.canAutoPlay(pro);
  assert.strictEqual(ap.allowed, true, 'Pro 可托管');
  assert.ok(ap.remainToday > 0, '应有托管额度');
  const before = ap.remainToday;
  quotaStore.consumeAutoPlay(pro);
  assert.strictEqual(quotaStore.canAutoPlay(pro).remainToday, before - 1, '消耗后应 -1');
  quotaStore.rollbackAutoPlay(pro);
  assert.strictEqual(quotaStore.canAutoPlay(pro).remainToday, before, '回滚后应恢复');
  // lifetime 亦可托管（买断=pro 级）
  const life = 'q-auto-life';
  quotaStore.setPlan(life, 'lifetime');
  assert.strictEqual(quotaStore.canAutoPlay(life).allowed, true, 'Lifetime 可托管');
});

test('千世书 AI 生成：消耗 genCredit 后回滚应恢复额度（与消耗对称）', () => {
  const uid = 'q-gen-credit';
  // 新手创作礼：+1 次 AI 剧本生成额度
  assert.strictEqual(quotaStore.grantFirstCharCreationGift(uid), true);
  assert.strictEqual(quotaStore.getQuota(uid).genCredit, 1);

  quotaStore.consumeGenerate(uid); // 优先扣 genCredit
  assert.strictEqual(quotaStore.getQuota(uid).genCredit, 0, '应先扣额外额度');

  quotaStore.rollbackGenerate(uid); // 失败回滚
  assert.strictEqual(quotaStore.getQuota(uid).genCredit, 1, '回滚应恢复 genCredit（不再白烧额度）');
});

test('首次创建角色礼：pendingReward.count 应 +1，才能触发恭喜提示', () => {
  const uid = 'q-char-gift';
  assert.strictEqual(quotaStore.grantFirstCharCreationGift(uid), true);
  const q = quotaStore.getQuota(uid);
  assert.strictEqual(q.pendingReward?.count, 1, '待通知奖励 count 应为 1（此前恒为 0 导致提示被吞）');
  assert.strictEqual(q.genCredit, 1, '应发 1 次 AI 剧本生成额度');
  // 幂等：只发一次
  assert.strictEqual(quotaStore.grantFirstCharCreationGift(uid), false);
  assert.strictEqual(quotaStore.getQuota(uid).genCredit, 1);
});

// —— 统一点数（credit）账本（Phase 1 聊一聊试点）——

test('统一点数：getCreditQuota 按档位给每日上限（Free/Plus/Pro 均兜底）', () => {
  // 2026-09-27 起免费档再分两种：**非账号 = 游客档（5 条/天）**、注册账号 = 免费档（.env 口径 20 条/天）。
  // 所以「Free 每日 30 点」这条旧断言必须按身份拆开看，不能拿一个裸 ID 当注册免费用户。
  assert.strictEqual(quotaStore.getCreditQuota('q-credit-free').plan, 'free');
  assert.strictEqual(quotaStore.getCreditQuota('q-credit-free').dailyCap, GUEST_DAILY_CREDIT, '裸 ID（游客）每日 = 游客档');
  quotaStore.setPlan('q-credit-plus', 'plus');
  assert.strictEqual(quotaStore.getCreditQuota('q-credit-plus').dailyCap, 300, 'Plus 每日 300 点');
  quotaStore.setPlan('q-credit-pro', 'pro');
  assert.strictEqual(quotaStore.getCreditQuota('q-credit-pro').dailyCap, 1500, 'Pro 也设兜底（1500）');
});

test('统一口径（CREDIT_QUOTA_ENABLED=1）：Pro = 无限，且「无限」不能被编码成 0', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    quotaStore.setPlan('q-credit-unlim-pro', 'pro');
    const q = quotaStore.getCreditQuota('q-credit-unlim-pro');
    assert.strictEqual(q.unlimited, true, '统一口径下 Pro 应为无限');
    assert.strictEqual(q.dailyCap, null, '无限时上限给 null（Infinity 会被 JSON 变成 null，必须显式标记）');
    assert.strictEqual(q.creditRemain, null, '无限时剩余给 null，前端靠 unlimited 判断，不能走 ?? 0');
    assert.strictEqual(q.canUse, true);

    // 无限档照旧记账（异常用量告警靠这份数据），正常用量永不因额度被拒
    const r = quotaStore.reserveCredit('q-credit-unlim-pro', 'chat', { credit: 40 });
    assert.strictEqual(r.ok, true, '无限档不应因额度不足被拒');
    assert.ok(quotaStore.getCreditQuota('q-credit-unlim-pro').usedToday > 0, '无限档仍需记账');

    /**
     * 但无限**有内部公平使用阀**（`PRO_FAIR_USE_TIAO`，默认 200 条/天）：
     * 校准报告实测 Pro 的 P90 = 280 条/天（≈¥2.8/天）> 月费日均 ¥2.4 —— 不封顶就是拿月费补贴重度用户。
     * 阀值只影响"当天真实消耗"，对外的「无限」展示不变。
     */
    const huge = quotaStore.reserveCredit('q-credit-unlim-pro', 'chat', { credit: 999999 });
    assert.strictEqual(huge.ok, false, '单笔远超公平使用阀必须被拒');
    assert.strictEqual(huge.reason, 'fair-use', '拒绝原因要能与「额度用完」区分（文案不同）');

    // 免费 / Plus 仍受上限约束（统一口径只放开 Pro）；裸 ID = 游客档（2026-09-27 分档）
    quotaStore.setPlan('q-credit-unlim-free', 'free');
    const f = quotaStore.getCreditQuota('q-credit-unlim-free');
    assert.strictEqual(f.unlimited, false);
    assert.strictEqual(f.dailyCap, GUEST_DAILY_CREDIT, '免费档（游客）上限不因统一口径而变');
    assert.strictEqual(quotaStore.reserveCredit('q-credit-unlim-free', 'chat', { credit: 999999 }).ok, false, '免费档超额应被拒');
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});

test('统一口径（CREDIT_QUOTA_ENABLED=1）：奖励只发点数，不再往「条」池里加', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    const uid = 'q-reward-unified';
    const unit = quotaStore.getQuota(uid).unitCredit;
    const bonus0 = quotaStore.getQuota(uid).creditBonus || 0;
    quotaStore.addChatBonus(uid, 20, 'register'); // 注册礼 20 条
    const bonus1 = quotaStore.getQuota(uid).creditBonus || 0;
    assert.strictEqual(bonus1 - bonus0, 20 * unit, '20 条应折成 20×unitCredit 点（用户当量不变）');
    assert.strictEqual(quotaStore.getQuota(uid).chatBonusFree, 0, '统一口径下不应再往旧「条」池加（否则又是两套账）');
    assert.ok((quotaStore.getQuota(uid).pendingReward?.count || 0) >= 20, '待通知奖励仍按「条」记（前端展示口径）');
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});

test('统一点数：reserve → 结算（多退少补）→ 回滚', () => {
  // 用**注册账号**（免费档）跑这笔账：游客档只有 5 条（2026-09-27 分档），
  // 本用例要连做 5+4+3 点，落在游客档上会被日额度拦下——那是另一条规则，别混进来测。
  const uid = registerFree('flow');
  // 预扣 5 点
  const r = quotaStore.reserveCredit(uid, 'chat', { credit: 5 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.token);
  assert.strictEqual(r.reserved, 5);
  assert.strictEqual(quotaStore.getCreditQuota(uid).usedToday, 5);
  // 真实用 3 → 退 2
  quotaStore.settleCredit(uid, r.token!, 3);
  assert.strictEqual(quotaStore.getCreditQuota(uid).usedToday, 3);
  // 预扣 4 → 真实用 6 → 补 2（累计 3+6=9）
  const r2 = quotaStore.reserveCredit(uid, 'chat', { credit: 4 });
  assert.strictEqual(r2.ok, true);
  quotaStore.settleCredit(uid, r2.token!, 6);
  assert.strictEqual(quotaStore.getCreditQuota(uid).usedToday, 9);
  // 预扣 3 → 失败回滚 → 恢复为 9
  const r3 = quotaStore.reserveCredit(uid, 'chat', { credit: 3 });
  assert.strictEqual(r3.ok, true);
  quotaStore.rollbackCredit(uid, r3.token!);
  assert.strictEqual(quotaStore.getCreditQuota(uid).usedToday, 9);
});

test('统一点数：余额/每日上限不足 → 拒绝', () => {
  const uid = 'q-credit-out';
  const r = quotaStore.reserveCredit(uid, 'chat', { credit: 99999 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-credit');
});

test('统一点数：持久赠送先于每日上限消耗，回滚恢复', () => {
  const uid = 'q-credit-bonus';
  quotaStore.addCreditBonus(uid, 10, 'register');
  assert.strictEqual(quotaStore.getCreditQuota(uid).bonus, 10);
  const r = quotaStore.reserveCredit(uid, 'chat', { credit: 4 });
  assert.strictEqual(r.ok, true);
  // 先扣 bonus，每日未动
  assert.strictEqual(quotaStore.getCreditQuota(uid).bonus, 6);
  assert.strictEqual(quotaStore.getCreditQuota(uid).usedToday, 0);
  quotaStore.rollbackCredit(uid, r.token!);
  assert.strictEqual(quotaStore.getCreditQuota(uid).bonus, 10, '回滚应恢复 bonus');
});

/**
 * 赠送余额的「累计获得 / 已用」（2026-09-29 用户提问：「赠送余额为什么没用已用的记录？」）。
 * `creditBonus` 是**余额**（扣减直接做减法），账本原先既不存累计获得也不存累计已用 ⇒ 运营端算不出「用了多少」。
 * 现在两条**发放**路径都累加 `creditGrantedTotal`，退款/结算补收**不算**发放（算了「已用」就会虚低）。
 */
test('统一点数：赠送「累计获得 / 已用」= 累计 − 余额；退款不计入累计', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    const uid = registerFree('granted');
    const unit = quotaStore.getQuota(uid).unitCredit;
    const rec = quotaStore.getRecord(uid)!;
    rec.creditBonus = 0;
    rec.creditGrantedTotal = 0; // 清掉注册礼，从零开始量这 23 条
    // 两条发放路径都必须记：addCreditBonus（直接给点数）+ addChatBonus（条 → 点数）
    quotaStore.addCreditBonus(uid, 3 * unit, 'feedback');
    quotaStore.addChatBonus(uid, 20, 'register');
    let qd = quotaStore.describeQuota(uid);
    assert.strictEqual(qd.credit.bonusTiao, 23, '余额 = 3 + 20 条');
    assert.strictEqual(qd.credit.bonusGrantedTiao, 23, '累计获得 = 3 + 20 条（两条发放路径都要记）');
    assert.strictEqual(qd.credit.bonusUsedTiao, 0, '没消耗 → 已用 0');
    assert.strictEqual(qd.credit.grantSince, '2026-09-29', '口径起点要能下发给前端（老记录标注用）');
    // 用掉 4 条：赠送先扣 → 余额 19、已用 4
    const r = quotaStore.reserveCredit(uid, 'chat', { credit: 4 * unit });
    assert.strictEqual(r.ok, true);
    qd = quotaStore.describeQuota(uid);
    assert.strictEqual(qd.credit.bonusTiao, 19);
    assert.strictEqual(qd.credit.bonusUsedTiao, 4, '已用 = 累计获得 − 当前余额');
    // 失败回滚：钱退回来了，但「累计获得」绝不能涨（否则已用虚低）
    quotaStore.rollbackCredit(uid, r.token!);
    qd = quotaStore.describeQuota(uid);
    assert.strictEqual(qd.credit.bonusGrantedTiao, 23, '退款/结算补收不得计入累计获得');
    assert.strictEqual(qd.credit.bonusUsedTiao, 0, '回滚后已用回到 0');
    // 老记录（字段缺失）：已用算不出来 → null（前端显示「—」），**不能用 0 冒充**
    const legacyUid = registerFree('granted-legacy');
    quotaStore.getQuota(legacyUid); // 先 ensure（配额记录是懒建的，否则 getRecord 是 undefined）
    const legacyRec = quotaStore.getRecord(legacyUid)!;
    delete legacyRec.creditGrantedTotal;
    legacyRec.creditBonus = 5 * unit;
    const lqd = quotaStore.describeQuota(legacyUid);
    assert.strictEqual(lqd.credit.bonusGrantedTiao, null, '老记录无累计 → null');
    assert.strictEqual(lqd.credit.bonusUsedTiao, null, '老记录算不出已用 → null（显示「—」，不显示 0）');
    // 余额高于累计（人工调账/历史迁移）时「已用」下限为 0，不出现负数
    const oddUid = registerFree('granted-odd');
    quotaStore.getQuota(oddUid); // 同上：先 ensure
    const oddRec = quotaStore.getRecord(oddUid)!;
    oddRec.creditGrantedTotal = 0;
    oddRec.creditBonus = 7 * unit;
    assert.strictEqual(quotaStore.describeQuota(oddUid).credit.bonusUsedTiao, 0, '余额 > 累计时已用按 0 兜底');
    // 退款走 refundCreditBonus（狼人杀重启兜底那条路）：钱回来了，但累计**不能**涨
    quotaStore.refundCreditBonus(oddUid, 2 * unit, 'werewolf-refund');
    assert.strictEqual(quotaStore.describeQuota(oddUid).credit.bonusGrantedTiao, 0, '退款不得计入累计获得');
    assert.strictEqual(quotaStore.describeQuota(oddUid).credit.bonusTiao, 9, '退款只回余额');
    assert.strictEqual(quotaStore.getQuota(oddUid).pendingReward, null, '退款不是奖励，不该给用户弹「恭喜获得额度」');
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});

test('estimateChatCredit：返回正 credit 与 token 结构', () => {
  const est = estimateChatCredit({ historyText: '你好呀，今天心情怎么样？', thinkingLevel: 'high' });
  assert.ok(est.credit > 0, 'credit 应为正整数');
  assert.ok(est.promptTokens > 0, 'promptTokens 应 >0');
  assert.ok(est.completionTokens > 0, 'completionTokens 应 >0');
});

test('引荐结算（B 方案）：待激活 → 首次真实使用才发；新账号按 ×1.5 加成；幂等', () => {
  // 邀请人：刚注册（1 天）→ 落在加成窗口内
  const inviter = registerInviter('boost', 1);
  quotaStore.noteDevice(inviter, 'dev-boost-inv', '7.7.1.1');
  const invitee = 'q-ref-boost-friend';
  quotaStore.setInvitedBy(invitee, inviter, 'dev-boost-f', '7.7.2.2');
  quotaStore.markInvitePending(invitee, 50);

  assert.strictEqual(quotaStore.getRecord(invitee)?.invitePending, true, '注册后应是待激活');
  assert.strictEqual(quotaStore.getRecord(inviter)?.inviteCount || 0, 0, '待激活期间邀请人数不算');
  assert.strictEqual(REFERRAL_NEW_ACCOUNT_BOOST, 1.5, '默认加成倍数 1.5');
  assert.strictEqual(REFERRAL_NEW_ACCOUNT_BOOST_DAYS, 7, '默认加成窗口 7 天');
  assert.strictEqual(quotaStore.inviteBoostFor(inviter), 1.5, '注册 1 天的邀请人应在加成窗口内');

  // 被邀人开口 → 结算：50 × 1.5 = 75 条
  const r = quotaStore.qualifyInvite(invitee);
  assert.strictEqual(r.settled, true);
  assert.strictEqual(r.inviter, inviter);
  assert.strictEqual(r.inviterCredits, 75, '新账号加成后应为 75 条');
  assert.strictEqual(r.boost, 1.5);
  assert.strictEqual(quotaStore.getRecord(inviter)?.inviteCount, 1, '结算后邀请人数 +1');
  assert.ok((quotaStore.getQuota(inviter).bonusFree || 0) >= 75, '邀请人应拿到 75 条额度');
  assert.strictEqual(quotaStore.getRecord(invitee)?.invitePending, false, '结算后不再是待激活');
  assert.ok((quotaStore.getRecord(invitee)?.inviteQualifiedAt || 0) > 0, '应记录结算时间（幂等标记）');

  // 幂等
  const r2 = quotaStore.qualifyInvite(invitee);
  assert.strictEqual(r2.settled, false);
  assert.strictEqual(quotaStore.getRecord(inviter)?.inviteCount, 1, '重复结算不应再加人数');

  // 邀请人非账号 → 结算时如实拒绝
  const invitee2 = 'q-ref-nonacc';
  quotaStore.setInvitedBy(invitee2, 'ghost-inviter-xyz', 'dev-ghost-f', '7.7.3.3');
  quotaStore.markInvitePending(invitee2, 50);
  const r3 = quotaStore.qualifyInvite(invitee2);
  assert.strictEqual(r3.settled, true);
  assert.strictEqual(r3.reason, 'inviter-not-account');
  assert.strictEqual(r3.inviterCredits, 0);
});

test('引荐结算：邀请人已达上限 → 结算时拒绝（不重复发）', () => {
  const inviter = registerInviter('caplimit', 30);
  quotaStore.noteDevice(inviter, 'dev-cap-inv', '8.8.1.1');
  for (let i = 0; i < 20; i++) quotaStore.recordInvite(inviter); // 先打满上限
  assert.strictEqual(quotaStore.canInviteMore(inviter), false);
  const invitee = 'q-ref-cap-friend';
  quotaStore.setInvitedBy(invitee, inviter, 'dev-cap-f', '8.8.2.2');
  quotaStore.markInvitePending(invitee, 50);
  const r = quotaStore.qualifyInvite(invitee);
  assert.strictEqual(r.settled, true);
  assert.strictEqual(r.reason, 'inviter-cap-reached');
  assert.strictEqual(r.inviterCredits, 0);
  assert.strictEqual(quotaStore.getRecord(inviter)?.inviteCount, 20, '上限内不增不减');
});

test('describeQuota（控制台额度总览）：所有池归一 + 点数换算成「条」+ 无限档不编数字', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    const uid = 'q-describe';
    const before = quotaStore.describeQuota(uid);
    assert.strictEqual(before.creditEnabled, true);
    assert.strictEqual(before.unlimited, false);
    assert.strictEqual(before.struct.total >= 3, true, '理一理池底数 >= FREE_STRUCT(3)');
    assert.strictEqual(before.chat.total >= 5, true, '对话池底数 >= FREE_CHAT(5)');
    assert.strictEqual(before.credit.usedTodayTiao, 0);
    assert.strictEqual(before.credit.remainTodayTiao, before.credit.dailyCapTiao, '未用时今日剩余 = 今日上限');

    // 送 20 条注册礼 → 赠送余额 +20 条，可用合计同步 +20
    quotaStore.addChatBonus(uid, 20, 'register');
    const after = quotaStore.describeQuota(uid);
    assert.strictEqual(after.credit.bonusTiao, 20, '20 条注册礼 = 赠送余额 20 条');
    assert.strictEqual(after.credit.remainTiao, (after.credit.remainTodayTiao || 0) + 20);
    assert.strictEqual(after.pendingReward?.count, 20, '待发奖励也一并给全');

    // 消耗先扣赠送余额：20 - 3
    const r = quotaStore.reserveCredit(uid, 'chat', { credit: 3 * after.unitCredit });
    assert.strictEqual(r.ok, true);
    const used = quotaStore.describeQuota(uid);
    assert.strictEqual(used.credit.bonusTiao, 17, '赠送余额先扣：20 - 3');
    assert.strictEqual(used.credit.remainTiao, (after.credit.remainTiao as number) - 3, '可用合计同步 -3');

    // 无赠送余额时：今日已用也要换算回「条」
    const uid2 = 'q-describe-used';
    const unit2 = quotaStore.describeQuota(uid2).unitCredit;
    quotaStore.reserveCredit(uid2, 'chat', { credit: 2 * unit2 });
    assert.strictEqual(quotaStore.describeQuota(uid2).credit.usedTodayTiao, 2, '今日已用换算回「条」');

    // 无限档（Pro）：unlimited=true，数值一律 null（Infinity 编不出 JSON）
    const proId = 'q-describe-pro';
    quotaStore.setPlan(proId, 'pro');
    const pro = quotaStore.describeQuota(proId);
    assert.strictEqual(pro.unlimited, true);
    assert.strictEqual(pro.credit.remainTiao, null);
    assert.strictEqual(pro.credit.dailyCapTiao, null);
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});

/**
 * 分档日额度（2026-09-27 用户拍板）：**游客 5 条/天；注册账号 20 条/天**（注册再一次性送 20 条）。
 *
 * 为什么必须锁死这条：
 *  - 游客身份 = `sha256(设备指纹 :: IP)`，**换 IP 就是换一个全新的人**、重新领一份满额日额度
 *    （线上真实案例：同一台设备两天里出现 3 个游客身份、各领 200 点）。游客档越小，
 *    这条「轮换绕过」的收益越小 → 5 条是产品决策，不是随手填的数字。
 *  - 注册账号（`accounts.json` 里有记录）必须始终是 20 条/天：这是「注册才有每天 20 条」的承诺，
 *    判据只能来自账号表，不能靠 ID 形状猜（游客 ID 也是 32 位 hex，与账号 UUID 不同但不该用形状判定）。
 */
test('分档日额度：游客 5 条/天、注册账号 20 条/天（判据 = 账号表）', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    // ⚠️ 测试进程不加载项目 `.env`（`setupTempCwd()` 先切了 cwd），所以这里断言的是**代码兜底值**与
    //    「游客 5 条」这条规则本身；生产口径在 `.env`：`FREE_DAILY_CREDIT=200` / `UNIT_CREDIT=10` = **注册 20 条/天**。
    assert.strictEqual(GUEST_DAILY_CREDIT / UNIT_CREDIT, 5, '游客档必须正好 5 条/天（.env GUEST_DAILY_TIAO）');
    assert.ok(FREE_DAILY_CREDIT > GUEST_DAILY_CREDIT, '注册免费档必须高于游客档（否则注册没有任何增量）');
    const guestTiao = GUEST_DAILY_CREDIT / UNIT_CREDIT;

    // 游客：identify() 的产出形状（32 位 hex），账号表里没有 → 游客档
    const guestId = quotaStore.identify('dev-tier-guest', '1.2.3.4');
    assert.strictEqual(quotaStore.getCreditQuota(guestId).dailyCap, GUEST_DAILY_CREDIT, '游客 = 游客档上限');
    assert.strictEqual(quotaStore.getCreditQuota(guestId).creditRemain, GUEST_DAILY_CREDIT, '游客开局可用 = 游客档');

    // 游客正好能用完自己的日额度，再多一条就被拒（账本按整条进出）
    for (let i = 0; i < guestTiao; i++) {
      assert.strictEqual(quotaStore.reserveCredit(guestId, 'chat', { credit: UNIT_CREDIT }).ok, true, `游客第 ${i + 1} 条应放行`);
    }
    const denied = quotaStore.reserveCredit(guestId, 'chat', { credit: UNIT_CREDIT });
    assert.strictEqual(denied.ok, false, '游客超出日额度应被拒');
    assert.strictEqual(denied.reason, 'no-credit');

    // 注册账号：账号表里有记录 → 免费档（与游客档彻底分开）
    const reg = accountStore.register({ username: 'tier_reg', email: 'tier_reg@test.com', password: 'secret1' });
    assert.ok(reg.user, '测试账号应注册成功');
    const regId = reg.user!.userId;
    assert.strictEqual(quotaStore.getCreditQuota(regId).dailyCap, FREE_DAILY_CREDIT, '注册账号 = 免费档上限');
    assert.ok(
      (quotaStore.getCreditQuota(regId).creditRemain as number) > GUEST_DAILY_CREDIT,
      '注册后当天可用额度必须高于游客（20 条 vs 5 条）',
    );

    // 对外配额里必须带上分档数字（前端「游客 N 条 / 注册 M 条」文案的唯一来源）
    const q = quotaStore.getQuota(regId);
    assert.strictEqual(q.guestDailyCredit, GUEST_DAILY_CREDIT);
    assert.strictEqual(q.freeDailyCredit, FREE_DAILY_CREDIT);
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});

/**
 * 设备维度合并（2026-09-27）：**同一台设备的游客身份共用一份日额度**。
 *
 * 为什么必须锁死：
 *  - 游客身份 = `sha256(设备指纹 :: IP)` ⇒ 换网络就是一个新身份、重新领一份满额日额度
 *    （线上真实案例：同一 deviceKey 两天 3 个身份各领 200/70/200 点）。合并后换 IP 不再重置。
 *  - 但**不能**合并成「所有游客一个池」：没带 `X-Device-Id` 的请求（心跳 sendBeacon 就打不了头）
 *    必须仍然各自独立，否则真人会被陌生人吃光额度。
 *  - 注册账号不参与游客池：同一台电脑上两个人的账号互不影响。
 */
test('设备维度合并：同设备换 IP 共用一份额度；异设备/无设备号/注册账号都不受影响', () => {
  const prev = process.env.CREDIT_QUOTA_ENABLED;
  process.env.CREDIT_QUOTA_ENABLED = '1';
  try {
    const guestTiao = GUEST_DAILY_CREDIT / UNIT_CREDIT; // 测试进程无 .env → 5 条

    // ① 同一台设备的两个身份（同 deviceId、不同 IP = 换网络）
    const devA1 = quotaStore.identify('dev-pool-A', '1.1.1.1');
    const devA2 = quotaStore.identify('dev-pool-A', '2.2.2.2');
    quotaStore.setDeviceKey(devA1, 'dev-pool-A');
    quotaStore.setDeviceKey(devA2, 'dev-pool-A');
    assert.notStrictEqual(devA1, devA2, '换 IP 确实是另一个身份 id（这正是漏洞的入口）');

    // 身份 1 用掉 3 条 → 身份 2 看到的剩余**同步减少**（同一份额度）
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(quotaStore.reserveCredit(devA1, 'chat', { credit: UNIT_CREDIT }).ok, true, `身份1 第 ${i + 1} 条`);
    }
    assert.strictEqual(quotaStore.getCreditQuota(devA2).creditRemain, (guestTiao - 3) * UNIT_CREDIT, '换 IP 后必须接着扣，不能重新给满');

    // 身份 2 再用 2 条 → 合计用满 → 两个身份都被拒
    for (let i = 0; i < 2; i++) {
      assert.strictEqual(quotaStore.reserveCredit(devA2, 'chat', { credit: UNIT_CREDIT }).ok, true, `身份2 第 ${i + 1} 条`);
    }
    assert.strictEqual(quotaStore.reserveCredit(devA1, 'chat', { credit: UNIT_CREDIT }).ok, false, '合计用满后原身份也被拒');
    assert.strictEqual(quotaStore.reserveCredit(devA2, 'chat', { credit: UNIT_CREDIT }).ok, false, '合计用满后新身份也被拒');
    // 账本没有重复扣：两条记录各自只记自己的用量（合计 = 日额度，不是 2 倍）
    assert.strictEqual(quotaStore.getRecord(devA1)!.creditUsedToday, 3 * UNIT_CREDIT);
    assert.strictEqual(quotaStore.getRecord(devA2)!.creditUsedToday, 2 * UNIT_CREDIT);

    // ② 另一台设备额度独立（证明不是「所有游客一个池」）
    const devB = quotaStore.identify('dev-pool-B', '1.1.1.1');
    quotaStore.setDeviceKey(devB, 'dev-pool-B');
    assert.strictEqual(quotaStore.getCreditQuota(devB).creditRemain, GUEST_DAILY_CREDIT, '另一台设备仍是满额');
    assert.strictEqual(quotaStore.reserveCredit(devB, 'chat', { credit: UNIT_CREDIT }).ok, true);

    // ③ 无设备号（X-Device-Id 缺失，如 sendBeacon 心跳）→ **不合并**，否则所有人共用一个池
    const noDev1 = quotaStore.identify('', '1.1.1.1');
    const noDev2 = quotaStore.identify('', '2.2.2.2');
    quotaStore.setDeviceKey(noDev1, '');
    quotaStore.setDeviceKey(noDev2, '');
    assert.strictEqual(quotaStore.getRecord(noDev1)?.deviceKey, undefined, '空设备号不应打标签（也就不参与合并）');
    for (let i = 0; i < guestTiao; i++) {
      assert.strictEqual(quotaStore.reserveCredit(noDev1, 'chat', { credit: UNIT_CREDIT }).ok, true, `无设备号身份1 第 ${i + 1} 条`);
    }
    assert.strictEqual(quotaStore.reserveCredit(noDev1, 'chat', { credit: UNIT_CREDIT }).ok, false, '无设备号身份1 用满');
    assert.strictEqual(quotaStore.getCreditQuota(noDev2).creditRemain, GUEST_DAILY_CREDIT, '另一个无设备号身份不受影响（各自独立）');
    assert.strictEqual(quotaStore.reserveCredit(noDev2, 'chat', { credit: UNIT_CREDIT }).ok, true);

    // ④ 注册账号不并入游客池：即便账号也被打了同一设备的标签，游客用量也不消耗它的额度
    const reg = accountStore.register({ username: 'pool_reg', email: 'pool_reg@test.com', password: 'secret1' });
    assert.ok(reg.user, '测试账号应注册成功');
    const regId = reg.user!.userId;
    quotaStore.setDeviceKey(regId, 'dev-pool-A'); // 防御性：把账号也标成同设备
    assert.strictEqual(quotaStore.getCreditQuota(regId).dailyCap, FREE_DAILY_CREDIT, '账号仍是免费档（不是游客档）');
    assert.strictEqual(quotaStore.getCreditQuota(regId).creditRemain, FREE_DAILY_CREDIT, '账号额度不被同设备游客的用量吃掉');
    assert.strictEqual(quotaStore.reserveCredit(regId, 'chat', { credit: UNIT_CREDIT }).ok, true, '账号照常可用');
  } finally {
    if (prev === undefined) delete process.env.CREDIT_QUOTA_ENABLED;
    else process.env.CREDIT_QUOTA_ENABLED = prev;
  }
});
