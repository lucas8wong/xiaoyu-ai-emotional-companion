/**
 * 邀请推广聚合（控制台「用户行为 → 📣 邀请推广」的数据源）
 *
 * 要回答的三个问题（用户原话）：
 *   ①「哪个用户用了自己的推广链接」→ 每个推广人一行，展开是他的被邀人名单（谁、什么时候注册）；
 *   ②「拉了多少人」→ 归因人数（invitedAll）+ 真发了奖励的人数（rewardedAll，= quota.inviteCount）；
 *   ③「赚了多少额度 / 区间内赚的所有额度」→ 邀请额度（条，每人 +INVITE_BONUS）+ 被邀人首购带来的同档会员天数。
 *   ④「预设邀请码（🎫 xiaoyu2026 那类）也用得怎么样」→ 并入同一张榜的 `codes[]`：哪个码被用了几次、
 *      区间内发出多少额度（码没有推广人，额度是发给**注册者**的）。
 *
 * ── 数据来源与「精确 / 近似」的分界（2026-09-18 落地时用户拍板口径 B）──
 *  · **台账（精确）**：`data/referral-events.json`（referralEvents.ts），从本功能上线起逐条记录真实发放
 *    （时间 / 邀请人 / 被邀人 / 额度 / 天数），区间统计首选它。
 *  · **回算（近似）**：台账之前的历史只有「累计 inviteCount」与「被邀人注册时间」可用，于是：
 *      - 注册邀请：把**台账上线前**注册的被邀人按注册时间升序取前 `inviteCount − 台账已记数` 个，
 *        视为当时真正发了奖励的邀请（时间=被邀人注册时间，额度=INVITE_BONUS）；
 *      - 会员天数：被邀人 `inviteeRewardedInviter=true`（首购已走过奖励判定）+ 其**最早一笔已解锁订单**，
 *        按订单档位回算邀请人获得的天数（封顶年付）。
 *    这两类事件在返回值里标 `source: 'estimate'`，并在报告里给 `approximate` 标志，控制台据此显示「近似」。
 *  · 反套利（同设备/IP）被拒的自邀、以及超出 INVITE_MAX 的邀请，在回算里**无法还原**，
 *    因此历史区间的额度可能略高于真实发放；台账上线后的数字是精确的。
 *
 * 阅读顺序建议：`buildReferralReport()` → `totals`（区间合计）→ `inviters[]`（每行=一个推广人）→ `invitees[]`（明细）。
 */

import { quotaStore, INVITE_BONUS_COUNT, INVITE_MAX, PRESET_INVITE_CODES_MAP, REFERRAL_YEARLY_CAP_DAYS, REFERRAL_INVITER_MIN_DAYS, REFERRAL_MONTHLY_BONUS_DAYS, REFERRAL_NEW_ACCOUNT_BOOST, REFERRAL_NEW_ACCOUNT_BOOST_DAYS, UNLOCK_DAYS_COUNT, type UserRecord } from './quota.js';
import { accountStore } from './accounts.js';
import { paymentStore, type Order } from './payment.js';
import { referralEventStore, type ReferralEvent } from './referralEvents.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';

/** 一次「被邀人」明细行（控制台下钻用） */
export interface ReferralInviteeRow {
  userId: string;
  name: string;
  email: string | null;
  /** 链接被使用的时间：台账精确时间，或回算用的被邀人注册时间 */
  at: number;
  /** 'ledger'=台账精确；'estimate'=历史回算；'none'=归因了但没发奖励（反套利/超上限/无记录） */
  source: 'ledger' | 'estimate' | 'none';
  rewarded: boolean;
  /** 该被邀人给邀请人带来的邀请额度（条） */
  credits: number;
  /** 是否付费过（任一已解锁付费单） */
  paid: boolean;
  planNow: string;
  /** 首购 → 邀请人获得的同档会员天数（无则 null） */
  purchase: { at: number; plan: string; purchase: string; days: number; friendBonusDays: number; source: 'ledger' | 'estimate' } | null;
  /**
   * 未给邀请人发奖励的原因（只在 rewarded=false 时有值）：
   * 'same-device' / 'same-ip' / 'inviter-not-account' / 'inviter-cap-reached' / 'self-invite' / 'unknown'
   * / 'invitee-inactive'（待激活：被邀人注册了但还没开始用，B 方案的门槛就卡在这里）
   * `reasonSource`：'ledger' = 发放当刻判定留痕（精确）；'estimate' = 事后按现有数据推定；null = 无法判定
   */
  rejectReason?: string | null;
  rejectReasonSource?: 'ledger' | 'estimate' | null;
  /** 待激活：注册期反套利已过，等被邀人首次真实使用才结算欢迎奖励 */
  pending?: boolean;
  /** 结算时用的新账号加成倍数（>1 表示享了「注册 7 天内邀请 ×1.5」） */
  boost?: number | null;
}

/** 一个推广人（邀请人）一行 */
export interface ReferralInviterRow {
  userId: string;
  kind: 'account' | 'guest';
  name: string;
  email: string | null;
  createdAt: number | null;
  /** 链接被多少人用过（有归因），累计 / 区间内新归因 */
  invitedAll: number;
  invitedRange: number;
  /** 注册了但还没开始用（待激活，B 方案的门槛）的人数 */
  pendingAll: number;
  pendingRange: number;
  /** 判定不合格（反套利/上限/自邀，永远不会发）的人数 */
  rejectedAll: number;
  rejectedRange: number;
  /** 享了新账号加成（×1.5）的结算笔数 */
  boostedAll: number;
  boostedRange: number;
  /** 真发了奖励的人数（累计 = quota.inviteCount）/ 区间内 */
  rewardedAll: number;
  rewardedRange: number;
  /** 邀请额度（条）：邀请人赚到的 / 其中区间内 */
  creditsAll: number;
  creditsRange: number;
  /** 被邀人同时拿到的额度（条，成本口径） */
  inviteeCreditsAll: number;
  inviteeCreditsRange: number;
  /** 被邀人首购 → 邀请人获得的会员天数（同档·封顶年付） */
  memberDaysAll: number;
  memberDaysRange: number;
  /** 被邀人月付 → 被邀人本人加赠的天数（「送半月」，成本口径） */
  friendBonusDaysAll: number;
  friendBonusDaysRange: number;
  purchaseCountAll: number;
  purchaseCountRange: number;
  /** 最近一次邀请（链接被使用）时间 */
  lastInviteAt: number | null;
  invitees: ReferralInviteeRow[];
}

/** 一个预设邀请码（🎫 xiaoyu2026 那类）一行 */
export interface ReferralCodeRow {
  code: string;
  /** 每人额度（条）；null = 该码已从 .env 的 INVITE_CODES 下线 → 额度未知，只统计使用人数 */
  bonus: number | null;
  /** 用码注册的人数：累计 / 区间内新注册 */
  registrationsAll: number;
  registrationsRange: number;
  /** 发出额度（条）：给注册者的；累计 / 区间内 */
  creditsAll: number;
  creditsRange: number;
  /** 该行是否含「回算」成分（台账上线前的用码记录，额度按当前配置估算） */
  approximate: boolean;
  /** 最近一次被使用 */
  lastUsedAt: number | null;
  /** 用码的用户明细 */
  users: ReferralInviteeRow[];
}

export interface ReferralReport {
  generatedAt: number;
  mode: 'all' | 'range';
  range: { from: string; to: string } | null;
  config: {
    inviteBonus: number;
    inviteMax: number;
    inviterMinDays: number;
    yearlyCapDays: number;
    monthlyBonusDays: number;
    /** 新账号加成：邀请人注册 ≤ newAccountBoostDays 天时额度 ×newAccountBoost */
    newAccountBoost: number;
    newAccountBoostDays: number;
  };
  ledger: {
    /** 台账条数 */
    events: number;
    /** 台账覆盖起点（ms，null=还没有任何台账） */
    since: number | null;
  };
  /** 区间数字里是否含「回算」成分（控制台要显示「近似」） */
  approximate: boolean;
  totals: {
    inviters: number;
    invitersRange: number;
    invitedAll: number;
    invitedRange: number;
    /** 有归因但**没**给邀请人发奖励的人数（反套利拦截 / 超上限 / 自邀），含推定；**不含**待激活 */
    rejectedAll: number;
    rejectedRange: number;
    /** 待激活人数：注册了但还没开始用，等被邀人开口才结算（B 方案的门槛） */
    pendingAll: number;
    pendingRange: number;
    /** 享了新账号加成的结算笔数（累计 / 区间） */
    boostedAll: number;
    boostedRange: number;
    rewardedAll: number;
    rewardedRange: number;
    creditsAll: number;
    creditsRange: number;
    inviteeCreditsAll: number;
    inviteeCreditsRange: number;
    memberDaysAll: number;
    memberDaysRange: number;
    friendBonusDaysAll: number;
    friendBonusDaysRange: number;
    purchaseCountAll: number;
    purchaseCountRange: number;
    /** 预设邀请码：被使用过的码数 / 用码注册人数 / 发出额度 */
    codesAll: number;
    codesRange: number;
    codeRegistrationsAll: number;
    codeRegistrationsRange: number;
    codeCreditsAll: number;
    codeCreditsRange: number;
  };
  inviters: ReferralInviterRow[];
  /** 预设邀请码（并入同一张榜展示：码没有推广人，所以单列一块） */
  codes: ReferralCodeRow[];
}

const DAY_MS = 86400000;

function ymdToTs(ymd: string, endOfDay = false): number | null {
  const s = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(s + (endOfDay ? 'T23:59:59.999' : 'T00:00:00')).getTime();
  return Number.isFinite(t) ? t : null;
}

function displayName(userId: string): string {
  const acc = accountStore.getById(userId);
  if (!acc) return '游客设备 ' + String(userId).slice(0, 12) + '…';
  return acc.username || acc.phone || (acc.email || '').split('@')[0] || String(userId).slice(0, 8);
}

/** 订单档位 → 邀请人应得天数（与 rewardInviterForPurchase 同口径：按订单天数、封顶年付） */
function inviterDaysOfOrder(order: Order): number {
  const days = Number(order.days) > 0 ? Number(order.days) : UNLOCK_DAYS_COUNT;
  return Math.max(0, Math.min(days, REFERRAL_YEARLY_CAP_DAYS));
}

function orderAt(order: Order): number {
  return order.confirmedAt || order.createdAt || 0;
}

/**
 * 构建邀请推广报告。from/to（YYYY-MM-DD）成对给定时为区间口径；否则为「全部时间」累计口径。
 * 全部时间 = 累计值（台账 + 回算合计），区间 = 只统计区间内发生的事件。
 */
export function buildReferralReport(opts: { from?: string; to?: string } = {}): ReferralReport {
  const now = Date.now();
  const fromTs = opts.from ? ymdToTs(opts.from) : null;
  const toTs = opts.to ? ymdToTs(opts.to, true) : null;
  const rangeActive = fromTs !== null && toTs !== null;
  // 注意：不带 from/to（mode='all'）时 inRange 恒真 → 行内的 *Range 字段等于累计字段。
  // 控制台在「全部时间」视图只读 All 字段、在区间视图只读 Range 字段，因此两者不会混着显示。
  const inRange = (t: number | null | undefined): boolean => {
    if (t === null || t === undefined || !t) return false;
    if (!rangeActive) return true;
    return t >= (fromTs as number) && t <= (toTs as number);
  };

  const allAccounts = accountStore.listAll() || [];
  const excluded = new Set(
    allAccounts.filter(a => isTestAccount(a) || isDeveloperAccount(a)).map(a => a.userId)
  );

  const quotaUsers = quotaStore.listAll();
  const quotaById = new Map<string, UserRecord>(quotaUsers.map(u => [u.userId, u]));

  // 【被邀人按邀请人归并（排除测试/运营账号：他们不是真实推广）】
  const inviteesByInviter = new Map<string, UserRecord[]>();
  const inviterIdSet = new Set<string>();
  for (const u of quotaUsers) {
    const inviterId = u.invitedBy;
    if (!inviterId || inviterId === u.userId) continue;
    if (excluded.has(u.userId) || excluded.has(inviterId)) continue;
    inviterIdSet.add(inviterId);
    const arr = inviteesByInviter.get(inviterId);
    if (arr) arr.push(u); else inviteesByInviter.set(inviterId, [u]);
  }
  // 邀请人数 >0 但没有被邀人记录（被邀人账号已注销/归并）：也列出，避免「累计邀请数」对不上
  for (const u of quotaUsers) {
    if ((u.inviteCount || 0) > 0 && !excluded.has(u.userId)) inviterIdSet.add(u.userId);
  }

  // 【订单：某用户最早一笔「已解锁」订单（回算首购会员天数用）】
  const ordersByUser = new Map<string, Order[]>();
  for (const o of paymentStore.listAll()) {
    if (o.status !== 'unlocked') continue;
    const arr = ordersByUser.get(o.userId);
    if (arr) arr.push(o); else ordersByUser.set(o.userId, [o]);
  }
  for (const arr of ordersByUser.values()) arr.sort((a, b) => orderAt(a) - orderAt(b));
  const firstUnlockedOrder = (userId: string): Order | null => (ordersByUser.get(userId) || [])[0] || null;
  const hasPaidOrder = (userId: string): boolean =>
    (ordersByUser.get(userId) || []).some(o => o.source === 'paid');

  // 【台账索引】
  const events = referralEventStore.listAll();
  const ledgerSince = referralEventStore.earliestAt();
  const signupEventKey = (inviterId: string, inviteeId: string) => inviterId + '|' + inviteeId;
  const codeEventKey = (code: string, inviteeId: string) => String(code).toLowerCase() + '|' + inviteeId;
  const signupEvents = new Map<string, ReferralEvent>();
  const pendingEvents = new Map<string, ReferralEvent>();
  const rejectedEvents = new Map<string, ReferralEvent>();
  const purchaseEvents = new Map<string, ReferralEvent[]>();
  const codeEvents = new Map<string, ReferralEvent>();
  for (const e of events) {
    const key = signupEventKey(e.inviterId, e.inviteeId);
    if (e.kind === 'signup') {
      if (!signupEvents.has(key)) signupEvents.set(key, e);
    } else if (e.kind === 'signup_pending') {
      // 注册期反套利已过、正在等被邀人「首次真实使用」结算（B 方案）
      if (!pendingEvents.has(key)) pendingEvents.set(key, e);
    } else if (e.kind === 'signup_rejected') {
      // 「人来了但没发奖励」的判定结果（2026-09-19 起逐条留痕；此前历史无记录 → 只能有限推定）
      if (!rejectedEvents.has(key)) rejectedEvents.set(key, e);
    } else if (e.kind === 'code') {
      // 邀请码事件：按「码 + 注册者」索引（码事件不进推广人榜）
      const ck = codeEventKey(e.code || e.inviterId.replace(/^code:/, ''), e.inviteeId);
      if (!codeEvents.has(ck)) codeEvents.set(ck, e);
    } else {
      const arr = purchaseEvents.get(key);
      if (arr) arr.push(e); else purchaseEvents.set(key, [e]);
    }
  }

  const inviters: ReferralInviterRow[] = [];

  for (const inviterId of inviterIdSet) {
    const invRec = quotaById.get(inviterId);
    const acc = accountStore.getById(inviterId);
    const inviteCount = invRec?.inviteCount || 0;
    const inviteeRecs = (inviteesByInviter.get(inviterId) || [])
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    // 台账已精确记录过的注册邀请数 → 剩下的才是需要回算的历史
    let ledgerSignupCount = 0;
    for (const rec of inviteeRecs) {
      if (signupEvents.has(signupEventKey(inviterId, rec.userId))) ledgerSignupCount++;
    }
    // 回算：只对「台账上线前」注册的被邀人，按注册时间升序取前 residual 个（最接近真实发放顺序）
    const residual = Math.max(0, inviteCount - ledgerSignupCount);
    const estimateIds = new Set<string>();
    let taken = 0;
    for (const rec of inviteeRecs) {
      if (taken >= residual) break;
      if (signupEvents.has(signupEventKey(inviterId, rec.userId))) continue;
      if (ledgerSince !== null && (rec.createdAt || 0) >= ledgerSince) continue; // 台账期内没记 = 当时没发奖励
      estimateIds.add(rec.userId);
      taken++;
    }

    const invitees: ReferralInviteeRow[] = inviteeRecs.map(rec => {
      const key = signupEventKey(inviterId, rec.userId);
      const evt = signupEvents.get(key);
      const pendingEvt = pendingEvents.get(key);
      const isEstimate = !evt && !pendingEvt && estimateIds.has(rec.userId);
      // 「人来了」的时刻：已结算用结算时间，待激活用注册时间（pending 事件时刻），否则回算用注册时间
      const at = evt ? evt.at : ((pendingEvt || rec.invitePendingAt) ? (pendingEvt?.at || rec.createdAt || 0) : (rec.createdAt || 0));
      const credits = evt ? (evt.credits || 0) : (isEstimate ? INVITE_BONUS_COUNT : 0);
      const source: ReferralInviteeRow['source'] = evt ? 'ledger' : (isEstimate ? 'estimate' : 'none');
      // 待激活：注册期反套利过了，但被邀人还没开口 → 不结算（B 方案）；已结算/已拒绝的以结算结果为准
      const pending = !evt && !!pendingEvt && !rejectedEvents.has(key);
      const boost = evt && (evt.boost || 1) > 1 ? (evt.boost as number) : null;

      // 首购 → 邀请人会员天数：台账优先（精确），否则用「已走过奖励判定 + 最早已解锁订单」回算
      let purchase: ReferralInviteeRow['purchase'] = null;
      const pevts = purchaseEvents.get(key) || [];
      const granted = pevts.find(e => (e.days || 0) > 0);
      const ledgerFriendDays = pevts.reduce((s, e) => s + (e.friendBonusDays || 0), 0);
      if (granted) {
        // 台账已精确记过「邀请人获得天数」
        purchase = {
          at: granted.at,
          plan: String(granted.plan || 'plus'),
          purchase: String(granted.purchase || 'monthly'),
          days: granted.days || 0,
          friendBonusDays: ledgerFriendDays,
          source: 'ledger',
        };
      } else if (rec.inviteeRewardedInviter) {
        const order = firstUnlockedOrder(rec.userId);
        if (order) {
          purchase = {
            at: orderAt(order),
            plan: String(order.plan || 'plus'),
            purchase: String(order.purchase || (order.source === 'paid' ? 'monthly' : 'subscription')),
            days: inviterDaysOfOrder(order),
            // 月付加赠：台账里的精确值优先；没有台账时只对「真实付费单次购买」回算（订阅单被标 free，不加半月）
            friendBonusDays: ledgerFriendDays > 0
              ? ledgerFriendDays
              : (order.source === 'paid' && (order.purchase || 'monthly') === 'monthly' ? REFERRAL_MONTHLY_BONUS_DAYS : 0),
            source: 'estimate',
          };
        } else if (ledgerFriendDays > 0) {
          // 只有「月付加赠」被记（邀请人天数没记）：如实显示，天数按 0
          purchase = { at: pevts[0].at, plan: String(pevts[0].plan || 'plus'), purchase: String(pevts[0].purchase || 'monthly'), days: 0, friendBonusDays: ledgerFriendDays, source: 'ledger' };
        }
      }

      // 【未发放原因（只在没发奖励时给）：台账留痕优先；没有留痕的历史只能做**有限**推定】
      // 说明：判定依赖「邀请人当时的设备/IP」，而 lastDeviceKey/lastIp 会随后变化 → 事后**不可**可靠还原，
      // 所以只能推三种与时间无关/可由现有数据算出的原因，其余如实标 unknown（界面写明「历史未记原因」）。
      let rejectReason: string | null = null;
      let rejectReasonSource: 'ledger' | 'estimate' | null = null;
      if (credits <= 0) {
        const rej = rejectedEvents.get(key);
        if (pending) {
          // 待激活：不是「不发」，是「还没到时候」（被邀人还没开始用），B 方案的门槛就在这里
          rejectReason = 'invitee-inactive';
          rejectReasonSource = 'ledger';
        } else if (rej?.reason) {
          rejectReason = rej.reason;
          rejectReasonSource = 'ledger';
        } else if (inviterId === rec.userId) {
          rejectReason = 'self-invite';
          rejectReasonSource = 'estimate';
        } else if (!acc) {
          rejectReason = 'inviter-not-account';
          rejectReasonSource = 'estimate';
        } else if (REFERRAL_INVITER_MIN_DAYS > 0 && (rec.createdAt || 0) - (acc.createdAt || 0) < REFERRAL_INVITER_MIN_DAYS * DAY_MS) {
          // 只在运营把 INVITE_INVITER_MIN_DAYS 调回 >0 时才会命中（默认 0 = 不设年龄门槛）
          rejectReason = 'inviter-too-new';
          rejectReasonSource = 'estimate';
        } else if (inviteCount >= INVITE_MAX) {
          rejectReason = 'inviter-cap-reached';
          rejectReasonSource = 'estimate';
        } else {
          rejectReason = 'unknown';
          rejectReasonSource = null;
        }
      }

      return {
        userId: rec.userId,
        name: displayName(rec.userId),
        email: accEmail(rec.userId),
        at,
        source,
        rewarded: credits > 0,
        credits,
        paid: hasPaidOrder(rec.userId),
        planNow: (() => { const r = quotaById.get(rec.userId); return r ? quotaStore.getPlan(r) : 'free'; })(),
        purchase,
        rejectReason,
        rejectReasonSource,
        pending,
        boost,
      };
    });

    const inRangeInvitees = invitees.filter(i => inRange(i.at));
    const row: ReferralInviterRow = {
      userId: inviterId,
      kind: acc ? 'account' : 'guest',
      name: displayName(inviterId),
      email: accEmail(inviterId),
      createdAt: acc?.createdAt ?? (invRec?.createdAt ?? null),
      invitedAll: invitees.length,
      invitedRange: inRangeInvitees.length,
      pendingAll: invitees.filter(i => !!i.pending).length,
      pendingRange: invitees.filter(i => !!i.pending && inRange(i.at)).length,
      rejectedAll: invitees.filter(i => !i.rewarded && !i.pending).length,
      rejectedRange: invitees.filter(i => !i.rewarded && !i.pending && inRange(i.at)).length,
      boostedAll: invitees.filter(i => (i.boost || 1) > 1).length,
      boostedRange: invitees.filter(i => (i.boost || 1) > 1 && inRange(i.at)).length,
      rewardedAll: invitees.filter(i => i.rewarded).length,
      rewardedRange: invitees.filter(i => i.rewarded && inRange(i.at)).length,
      creditsAll: invitees.reduce((s, i) => s + i.credits, 0),
      creditsRange: invitees.reduce((s, i) => s + (i.rewarded && inRange(i.at) ? i.credits : 0), 0),
      inviteeCreditsAll: 0,
      inviteeCreditsRange: 0,
      memberDaysAll: invitees.reduce((s, i) => s + (i.purchase ? i.purchase.days : 0), 0),
      memberDaysRange: invitees.reduce((s, i) => s + (i.purchase && inRange(i.purchase.at) ? i.purchase.days : 0), 0),
      friendBonusDaysAll: invitees.reduce((s, i) => s + (i.purchase ? i.purchase.friendBonusDays : 0), 0),
      friendBonusDaysRange: invitees.reduce((s, i) => s + (i.purchase && inRange(i.purchase.at) ? i.purchase.friendBonusDays : 0), 0),
      purchaseCountAll: invitees.filter(i => !!i.purchase && i.purchase.days > 0).length,
      purchaseCountRange: invitees.filter(i => !!i.purchase && i.purchase.days > 0 && inRange(i.purchase.at)).length,
      lastInviteAt: invitees.length ? Math.max(...invitees.map(i => i.at || 0)) : null,
      invitees,
    };

    // 被邀人侧额度（成本口径）：台账精确值优先，回算按同等额度估算
    // 注意 B 方案（2026-09-19）后被邀人的那份记在**注册时的 pending 事件**上，所以两处都要看
    for (const i of invitees) {
      const k = signupEventKey(inviterId, i.userId);
      const evt = signupEvents.get(k);
      const pend = pendingEvents.get(k);
      const inviteeCredits = (evt?.inviteeCredits || 0) > 0
        ? (evt!.inviteeCredits || 0)
        : ((pend?.inviteeCredits || 0) > 0
            ? (pend!.inviteeCredits || 0)
            : (i.source === 'estimate' ? INVITE_BONUS_COUNT : 0));
      row.inviteeCreditsAll += inviteeCredits;
      if (inviteeCredits > 0 && inRange(evt ? evt.at : (pend?.at || i.at))) row.inviteeCreditsRange += inviteeCredits;
    }

    inviters.push(row);
  }

  // 榜序：区间视图按区间额度，全部时间按累计额度；同额按邀请人数、再按最近邀请时间
  inviters.sort((a, b) => {
    const pa = rangeActive ? a.creditsRange : a.creditsAll;
    const pb = rangeActive ? b.creditsRange : b.creditsAll;
    return pb - pa
      || (rangeActive ? b.invitedRange - a.invitedRange : b.invitedAll - a.invitedAll)
      || (b.lastInviteAt || 0) - (a.lastInviteAt || 0)
      || a.name.localeCompare(b.name);
  });

  const sum = (pick: (r: ReferralInviterRow) => number) => inviters.reduce((s, r) => s + pick(r), 0);
  const approximate = rangeActive
    ? inviters.some(r => r.invitees.some(i => inRange(i.at) && (i.source === 'estimate' || (i.purchase && i.purchase.source === 'estimate' && inRange(i.purchase.at)))))
    : inviters.some(r => r.invitees.some(i => i.source === 'estimate'));

  // 【🎫 预设邀请码（并入同一张榜：码没有推广人，所以单列一块）】
  // 口径与推广人一致：台账（自 2026-09-18 起每次用码逐条精确记录）优先；更早的历史按「用到该码的用户注册时间」
  // × 当前配置额度回算并标「近似」；码已从 .env 的 INVITE_CODES 下线时 bonus=null（额度未知，只统计人数）。
  const codeUsers = new Map<string, UserRecord[]>();
  for (const u of quotaUsers) {
    const c = String(u.inviteCodeUsed || '').trim().toLowerCase();
    if (!c) continue;
    if (excluded.has(u.userId)) continue;
    const arr = codeUsers.get(c);
    if (arr) arr.push(u); else codeUsers.set(c, [u]);
  }

  const codes: ReferralCodeRow[] = [];
  for (const [code, recsRaw] of codeUsers) {
    const recs = recsRaw.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const bonus = Object.prototype.hasOwnProperty.call(PRESET_INVITE_CODES_MAP, code) ? PRESET_INVITE_CODES_MAP[code] : null;
    const ledgerHits = recs.filter(rec => codeEvents.has(codeEventKey(code, rec.userId))).length;
    // 回算：只对「台账上线前」用码注册的人（台账期内没有记录 = 当时没发），按注册时间升序取前 residual 个
    const residual = Math.max(0, recs.length - ledgerHits);
    const estimateIds = new Set<string>();
    let taken = 0;
    for (const rec of recs) {
      if (taken >= residual || bonus == null) break;
      if (codeEvents.has(codeEventKey(code, rec.userId))) continue;
      if (ledgerSince !== null && (rec.createdAt || 0) >= ledgerSince) continue;
      estimateIds.add(rec.userId);
      taken++;
    }

    const users: ReferralInviteeRow[] = recs.map(rec => {
      const evt = codeEvents.get(codeEventKey(code, rec.userId));
      const isEstimate = !evt && estimateIds.has(rec.userId);
      const credits = evt ? (evt.credits || 0) : (isEstimate && bonus != null ? bonus : 0);
      const acc2 = accountStore.getById(rec.userId);
      return {
        userId: rec.userId,
        name: displayName(rec.userId),
        email: acc2?.email || null,
        at: evt ? evt.at : (rec.createdAt || 0),
        source: evt ? 'ledger' : (isEstimate ? 'estimate' : 'none'),
        rewarded: credits > 0,
        credits,
        paid: hasPaidOrder(rec.userId),
        planNow: (() => { const r2 = quotaById.get(rec.userId); return r2 ? quotaStore.getPlan(r2) : 'free'; })(),
        purchase: null, // 邀请码不产生「邀请人会员天数」（那是推广链接的规则）
      };
    });

    codes.push({
      code,
      bonus,
      registrationsAll: users.length,
      registrationsRange: users.filter(u => inRange(u.at)).length,
      creditsAll: users.reduce((s, u) => s + u.credits, 0),
      creditsRange: users.reduce((s, u) => s + (u.rewarded && inRange(u.at) ? u.credits : 0), 0),
      approximate: users.some(u => u.source === 'estimate'),
      lastUsedAt: users.length ? Math.max(...users.map(u => u.at || 0)) : null,
      users,
    });
  }
  // 码序：区间视图按区间额度（再按区间人数），全部时间按累计额度；同额按最近使用
  codes.sort((a, b) => {
    const pa = rangeActive ? a.creditsRange : a.creditsAll;
    const pb = rangeActive ? b.creditsRange : b.creditsAll;
    return pb - pa
      || (rangeActive ? b.registrationsRange - a.registrationsRange : b.registrationsAll - a.registrationsAll)
      || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
      || a.code.localeCompare(b.code);
  });
  const codeSum = (pick: (r: ReferralCodeRow) => number) => codes.reduce((s, r) => s + pick(r), 0);
  const codeApproximate = rangeActive
    ? codes.some(r => r.users.some(u => u.source === 'estimate' && inRange(u.at)))
    : codes.some(r => r.users.some(u => u.source === 'estimate'));

  return {
    generatedAt: now,
    mode: rangeActive ? 'range' : 'all',
    range: rangeActive ? { from: opts.from as string, to: opts.to as string } : null,
    config: {
      inviteBonus: INVITE_BONUS_COUNT,
      inviteMax: INVITE_MAX,
      inviterMinDays: REFERRAL_INVITER_MIN_DAYS,
      yearlyCapDays: REFERRAL_YEARLY_CAP_DAYS,
      monthlyBonusDays: REFERRAL_MONTHLY_BONUS_DAYS,
      newAccountBoost: REFERRAL_NEW_ACCOUNT_BOOST,
      newAccountBoostDays: REFERRAL_NEW_ACCOUNT_BOOST_DAYS,
    },
    ledger: { events: referralEventStore.size(), since: ledgerSince },
    approximate: approximate || codeApproximate,
    totals: {
      inviters: inviters.length,
      invitersRange: rangeActive
        ? inviters.filter(r => r.invitedRange > 0 || r.creditsRange > 0 || r.memberDaysRange > 0 || r.friendBonusDaysRange > 0).length
        : inviters.filter(r => r.invitedAll > 0 || r.memberDaysAll > 0).length,
      invitedAll: sum(r => r.invitedAll),
      invitedRange: sum(r => r.invitedRange),
      rejectedAll: sum(r => r.rejectedAll),
      rejectedRange: sum(r => r.rejectedRange),
      pendingAll: sum(r => r.pendingAll),
      pendingRange: sum(r => r.pendingRange),
      boostedAll: sum(r => r.boostedAll),
      boostedRange: sum(r => r.boostedRange),
      rewardedAll: sum(r => r.rewardedAll),
      rewardedRange: sum(r => r.rewardedRange),
      creditsAll: sum(r => r.creditsAll),
      creditsRange: sum(r => r.creditsRange),
      inviteeCreditsAll: sum(r => r.inviteeCreditsAll),
      inviteeCreditsRange: sum(r => r.inviteeCreditsRange),
      memberDaysAll: sum(r => r.memberDaysAll),
      memberDaysRange: sum(r => r.memberDaysRange),
      friendBonusDaysAll: sum(r => r.friendBonusDaysAll),
      friendBonusDaysRange: sum(r => r.friendBonusDaysRange),
      purchaseCountAll: sum(r => r.purchaseCountAll),
      purchaseCountRange: sum(r => r.purchaseCountRange),
      codesAll: codes.length,
      codesRange: rangeActive
        ? codes.filter(r => r.registrationsRange > 0 || r.creditsRange > 0).length
        : codes.length,
      codeRegistrationsAll: codeSum(r => r.registrationsAll),
      codeRegistrationsRange: codeSum(r => r.registrationsRange),
      codeCreditsAll: codeSum(r => r.creditsAll),
      codeCreditsRange: codeSum(r => r.creditsRange),
    },
    inviters,
    codes,
  };
}

/** 账号邮箱（游客推广人没有账号 → null） */
function accEmail(userId: string): string | null {
  const acc = accountStore.getById(userId);
  return acc?.email || null;
}

/**
 * 用户邮箱打码（**给邀请人看被邀人**用：只显示可辨认的前 2 位 + 域名，不暴露完整邮箱）。
 * 说明：邀请人是把链接分享出去的人，通常认得自己邀来的人；但链接也可能公开转发，
 * 所以这里只给「能认出来」的最小信息，不给完整邮箱。
 */
export function maskInviteeEmail(email: string | null): string | null {
  if (!email || !email.includes('@')) return null;
  const [name, domain] = email.split('@');
  const head = name.slice(0, Math.min(2, name.length));
  return head + '***@' + domain;
}

/** 用户侧「我的邀请记录」一行 */
export interface MyReferralInvitee {
  /** 昵称（邀请人通常认得）；没有昵称时给打码邮箱 */
  name: string;
  maskedEmail: string | null;
  at: number;
  rewarded: boolean;
  credits: number;
  /** 未计入时的原因（前端按语言映射文案）：invitee-inactive（还没开口）/ same-device / same-ip / unknown … */
  rejectReason: string | null;
  /** 待激活：朋友注册了、还没开始用（B 方案：他开口后你才拿到奖励） */
  pending: boolean;
  /** 这一笔享了新账号加成（×1.5） */
  boost: number | null;
  /** 这个朋友买了会员时：邀请人拿到的同档天数 */
  memberDays: number;
  friendPurchasedPlan: string | null;
}

export interface MyReferralSummary {
  /** 是否已满足邀请资格（是注册账号；B 方案起不再要求注册满 N 天） */
  eligible: boolean;
  /** 不合格原因：'not-account'（游客设备）；保留 'too-new' 兼容把 INVITE_INVITER_MIN_DAYS 调回 >0 的部署 */
  ineligibleReason: 'not-account' | 'too-new' | null;
  /** 还需等多少天才有资格（仅 too-new） */
  daysUntilEligible: number;
  config: { inviteBonus: number; inviteMax: number; minDays: number; yearlyCapDays: number; monthlyBonusDays: number; newAccountBoost: number; newAccountBoostDays: number };
  invitedCount: number;
  rewardedCount: number;
  /** 待激活人数（朋友注册了还没开口） */
  pendingCount: number;
  /** 判定不合格人数（反套利/超上限，永远不会发） */
  rejectedCount: number;
  creditsEarned: number;
  memberDaysEarned: number;
  invitees: MyReferralInvitee[];
}

/**
 * 用户自己的邀请记录（「邀请反馈区」数据源）。
 *
 * 口径与运营端 `buildReferralReport()` **完全同源**（复用同一个聚合结果，避免两处各算一套）：
 * 累计口径、排除测试/运营账号、未发放原因取自台账留痕（无留痕的历史按有限推定给出或标 unknown）。
 * 与运营端的差别只有两点：只返回**自己**那一行；被邀人身份**打码**（不外泄完整邮箱）。
 */
export function buildMyReferralSummary(userId: string): MyReferralSummary {
  const acc = accountStore.getById(userId);
  const report = buildReferralReport();
  const row = report.inviters.find(r => r.userId === userId);
  const minDays = REFERRAL_INVITER_MIN_DAYS;
  const ageDays = acc ? (Date.now() - (acc.createdAt || 0)) / DAY_MS : 0;
  const eligible = !!acc && ageDays >= minDays;
  const invitees: MyReferralInvitee[] = (row?.invitees || []).map(i => ({
    name: i.name,
    maskedEmail: maskInviteeEmail(i.email),
    at: i.at,
    rewarded: i.rewarded,
    credits: i.credits,
    rejectReason: i.rewarded ? null : (i.rejectReason || null),
    pending: !!i.pending,
    boost: i.boost && i.boost > 1 ? i.boost : null,
    memberDays: i.purchase ? i.purchase.days : 0,
    friendPurchasedPlan: i.purchase && i.purchase.days > 0 ? i.purchase.plan : null,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
  return {
    eligible,
    ineligibleReason: !acc ? 'not-account' : (eligible ? null : 'too-new'),
    daysUntilEligible: !acc || eligible ? 0 : Math.max(1, Math.ceil(minDays - ageDays)),
    config: {
      inviteBonus: INVITE_BONUS_COUNT,
      inviteMax: INVITE_MAX,
      minDays: REFERRAL_INVITER_MIN_DAYS,
      yearlyCapDays: REFERRAL_YEARLY_CAP_DAYS,
      monthlyBonusDays: REFERRAL_MONTHLY_BONUS_DAYS,
      newAccountBoost: REFERRAL_NEW_ACCOUNT_BOOST,
      newAccountBoostDays: REFERRAL_NEW_ACCOUNT_BOOST_DAYS,
    },
    invitedCount: row?.invitedAll || 0,
    rewardedCount: row?.rewardedAll || 0,
    pendingCount: (row?.invitees || []).filter(i => !!i.pending).length,
    rejectedCount: (row?.invitees || []).filter(i => !i.rewarded && !i.pending).length,
    creditsEarned: row?.creditsAll || 0,
    memberDaysEarned: row?.memberDaysAll || 0,
    invitees,
  };
}

export default buildReferralReport;
