/**
 * 控制台 AI 商业分析：数据聚合 + 分析提示词
 *
 * 只输出聚合指标（计数/分布/合计），**绝不包含 PII**（邮箱、IP、昵称、对话内容、反馈正文都不外发）
 * 与 geo「IP 不外发」的红线一致：外发到 DeepSeek 的只有数字。
 */

import { accountStore } from './accounts.js';
import { quotaStore } from './quota.js';
import { paymentStore } from './payment.js';
import { activityStore } from './activity.js';
import { feedbackStore } from './feedback.js';
import { subscriptionStore } from './subscription.js';
import { visitStore } from './visits.js';
import { lookupIp } from './geo.js';

const DAY = 86400000;

/** 近似排除测试/开发账号（与 /geo 口径接近；用户名/邮箱以 test/dev 开头或测试域名） */
export function looksLikeTestAccount(a: { username?: string; email?: string; phone?: string }): boolean {
  const s = [a.username, a.email, a.phone].filter(Boolean).join(' ');
  return /^(test|dev)/i.test(s) || /@test\.|@example\.com/i.test(s);
}

export interface AdminAnalyticsBundle {
  generatedAt: number;
  users: {
    totalAccounts: number;
    totalQuotaRecords: number;
    planDistribution: Record<string, number>;
    unlockedNow: number;
    registered7d: number;
    active7d: number;
    /** 7 日活跃中属于「注册账号」的数量 */
    active7dRegistered: number;
    /** 7 日活跃中属于「访客/设备」的数量（无注册账号） */
    active7dGuest: number;
  };
  usage30d: { chat: number; structure: number; roleplay: number };
  payments: {
    totalOrders: number;
    /** 已创建订单但用户未完成付款/未点「我已付款」（pending 状态） */
    pendingUnpaid: number;
    /** 用户已点「我已付款」、待管理员确认的瞬时状态数（paid 状态） */
    awaitingConfirm: number;
    unlocked: number;
    /** 已解锁且真实付费（source=paid）的订单数，累计口径 */
    unlockedPaid: number;
    /** 已解锁但为免费开通/试用/赠送（source=free）的订单数 */
    unlockedFree: number;
    /** 去重后的真实付费用户数（排除已注销的 DELETED_USER 占位） */
    realPayingUsers: number;
    revenueCny: number;
    byPlan: Record<string, { count: number; revenueCny: number }>;
    subscriptions: { active: number; canceled: number; pastDue: number };
  };
  geo: { byCountry: { name: string; count: number }[]; unknown: number };
  visits: { totalVisitors: number; avgDaily30: number; peakHour: { hour: number; count: number } | null };
  feedback: { total: number; byType: Record<string, number> };
}

/** 聚合控制台全部数据（只含计数/分布/合计，无 PII） */
export function buildAdminAnalyticsBundle(): AdminAnalyticsBundle {
  const now = Date.now();
  const accounts = accountStore.listAll() || [];
  const quotaRecs = quotaStore.listAll() || [];
  const activity = activityStore.listAll() || [];
  const orders = paymentStore.listAll() || [];
  const subs = subscriptionStore.listAll() || [];
  const feedbacks = feedbackStore.listAll() || [];

  const accountIds = new Set(accounts.map((a) => a.userId));
  const excluded = new Set(accounts.filter(looksLikeTestAccount).map((a) => a.userId));

  // 【用户】
  const planDistribution: Record<string, number> = {};
  let unlockedNow = 0;
  for (const q of quotaRecs) {
    const plan = (q.plan as string) || 'free';
    planDistribution[plan] = (planDistribution[plan] || 0) + 1;
    if (q.unlockUntil && q.unlockUntil > now) unlockedNow += 1;
  }
  const registered7d = accounts.filter((a) => !excluded.has(a.userId) && (a as any).createdAt >= now - 7 * DAY).length;
  const active7dItems = activity.filter((a) => !excluded.has(a.userId) && a.lastActiveAt >= now - 7 * DAY);
  const active7d = active7dItems.length;
  const active7dRegistered = active7dItems.filter((a) => accountIds.has(a.userId)).length;
  const active7dGuest = active7d - active7dRegistered;

  // 【使用（近 30 天）】
  const usage30d = { chat: 0, structure: 0, roleplay: 0 };
  for (const a of activity) {
    if (excluded.has(a.userId)) continue;
    for (const it of a.recentActivity || []) {
      if (it.at >= now - 30 * DAY && (usage30d as any)[it.feature] !== undefined) usage30d[it.feature] += 1;
    }
  }

  // 【支付】
  let pending = 0, paid = 0, unlocked = 0, unlockedPaid = 0, unlockedFree = 0, revenueCny = 0;
  const payingUserIds = new Set<string>();
  const byPlan: Record<string, { count: number; revenueCny: number }> = {};
  for (const o of orders) {
    if (o.status === 'pending') pending += 1;
    else if (o.status === 'paid') paid += 1;
    else if (o.status === 'unlocked') {
      unlocked += 1;
      // 收入只计真实付费订单（source === 'paid'）；免费开通/试用/赠送（source === 'free'）
      // 不计入收入，与 paymentStore.revenueStats() 口径保持一致，避免 AI 商业分析收入虚高。
      if ((o as any).source === 'free') {
        unlockedFree += 1;
        continue;
      }
      unlockedPaid += 1;
      const uid = String((o as any).userId || '');
      if (uid && uid !== 'DELETED_USER') payingUserIds.add(uid);
      const price = Number((o as any).price) || 0;
      revenueCny += price;
      const p = (o.plan as string) || 'plus';
      byPlan[p] = byPlan[p] || { count: 0, revenueCny: 0 };
      byPlan[p].count += 1;
      byPlan[p].revenueCny += price;
    }
  }
  const subscriptions = { active: 0, canceled: 0, pastDue: 0 };
  for (const s of subs) {
    if (s.status === 'canceled') subscriptions.canceled += 1;
    else if (s.status === 'past_due') subscriptions.pastDue += 1;
    else subscriptions.active += 1;
  }

  // 【地区（与 /geo 同口径，取 top 10）】
  const countryMap = new Map<string, number>();
  let unknown = 0;
  for (const a of activity) {
    if (excluded.has(a.userId)) continue;
    const isAccount = accountIds.has(a.userId);
    const latest = (a.logins || []).filter((l: any) => l?.ip).sort((x: any, y: any) => (y.at || 0) - (x.at || 0))[0] as { ip?: string; country?: string } | undefined;
    const ip = isAccount ? latest?.ip : a.lastIp;
    if (!ip) continue;
    const geo = lookupIp(ip, isAccount ? latest?.country : a.lastCountry);
    if (geo.isPrivate) continue;
    if (geo.country === '未知') { unknown += 1; continue; }
    countryMap.set(geo.country, (countryMap.get(geo.country) || 0) + 1);
  }
  const byCountry = [...countryMap.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 10);

  // 【访问】
  const daily = visitStore.getDailyVisits(30);
  const hourly = visitStore.getHourlyVisits(30);
  const avgDaily30 = daily.length ? Math.round((daily.reduce((s, d) => s + d.count, 0) / daily.length) * 10) / 10 : 0;
  const peakHour = hourly.some((h) => h.count > 0)
    ? hourly.reduce((p, h) => (h.count > (p?.count || 0) ? h : p), hourly[0])
    : null;

  // 【反馈（只计数，不传正文）】
  const byType: Record<string, number> = {};
  for (const f of feedbacks) byType[f.type] = (byType[f.type] || 0) + 1;

  return {
    generatedAt: now,
    users: {
      totalAccounts: accounts.length,
      totalQuotaRecords: quotaRecs.length,
      planDistribution,
      unlockedNow,
      registered7d,
      active7d,
      active7dRegistered,
      active7dGuest,
    },
    usage30d,
    payments: {
      totalOrders: orders.length,
      pendingUnpaid: pending,
      awaitingConfirm: paid,
      unlocked,
      unlockedPaid,
      unlockedFree,
      realPayingUsers: payingUserIds.size,
      revenueCny: Math.round(revenueCny * 100) / 100,
      byPlan,
      subscriptions,
    },
    geo: { byCountry, unknown },
    visits: { totalVisitors: visitStore.getVisitCount(), avgDaily30, peakHour },
    feedback: { total: feedbacks.length, byType },
  };
}

/** AI 商业分析师 system 提示词（品牌红线：陪伴非治疗、gentle healing；禁止编造数字） */
export const AI_ANALYST_SYSTEM_PROMPT = `你是小愈（Xiaoyu）的产品与商业分析师。小愈是面向港澳/海外用户的 AI 情绪陪伴网页应用，品牌定位 "gentle healing"（陪伴而非治疗）。
用户会给你一份控制台聚合的真实运营数据 JSON（仅聚合指标，无任何个人隐私字段）。请用中文输出一份商业分析报告，Markdown 格式，结构如下：
## 一、概览（2-3 句总体判断）
## 二、关键洞察（3-5 条，每条引用具体数字，说明"数据说明了什么"）
## 三、风险与问题（按严重程度列出：转化/流失/地区结构/付费结构等）
## 四、可执行优化建议（按 P0/P1/P2 优先级；每条含：做什么、为什么、预期影响；P0/P1 共 2-4 条即可）
硬性要求：
1. 只基于给定数据，禁止编造任何数字；数据缺失或过少时明确写"数据不足"。
2. 建议贴合"情绪陪伴"定位，不得建议医疗化话术、夸大功效或诱导付费等违规运营手段。
3. 总长度 500-800 字；关键数字用 **加粗**。
4. 若用户提供了【额外聚焦】问题，优先回答该问题并相应缩短其余部分。
字段口径（务必据此理解，避免误读）：
- 订单状态三段不要混：payments.pendingUnpaid = 已创建订单但用户**未完成付款/未点「我已付款」**（下单后流失/未付款）；payments.awaitingConfirm = 用户已点「我已付款」、**待管理员确认**的瞬时状态（几乎恒为 0，代表不了「没人付费」）；payments.unlocked = 已解锁订单。累计真实付费订单看 payments.unlockedPaid，免费开通/试用/赠送看 payments.unlockedFree，去重付费用户数看 payments.realPayingUsers。
- 收入只认 payments.revenueCny（仅真实付费订单合计）；payments.unlocked 包含免费开通订单，不能当「付费笔数/付费用户数」用。
- users.active7d 包含注册账号与访客/设备；注册账号见 users.active7dRegistered，访客见 users.active7dGuest。同理 users.totalQuotaRecords 含大量访客配额记录（users.planDistribution 也包含访客），不能直接当作注册用户数（注册用户数用 users.totalAccounts）。
- 地区分布 geo.byCountry 只统计了能定位到国家/地区的活动（unknown 为未识别），计数为「活动行数」而非去重人数，跨页解读时注意口径，且 country 计数求和才是总数（不要凭百分比反推）。
- 单笔支付金额不能代表整档定价：revenueCny 是合计、byPlan 内是每档合计；要判断定价档位请用 byPlan 的分档合计与对应订单数，不要用单笔订单金额外推。`;
