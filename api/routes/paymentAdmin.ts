/**
 * 运营端管理接口（付费解锁后台）
 * 从 payment.ts 拆出，挂载于 /api/payment/admin；统一 ?token= / x-admin-token 鉴权（fail-closed）。
 */

import 'dotenv/config';

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { quotaStore, UNLOCK_DAYS_COUNT, FREE_STRUCT_COUNT, INVITE_BONUS_COUNT } from '../services/quota.js';
import { paymentStore, isPlanKey, type PlanKey, type Purchase } from '../services/payment.js';
import { accountStore } from '../services/accounts.js';
import { expenseStore } from '../services/expenses.js';
import { safeError } from '../services/safeError.js';
import { getDisplayLikes } from '../services/roleplay.js';
import { customRoleplayStore } from '../services/customRoleplay.js';
import { roleplayLikeStore } from '../services/roleplayLikes.js';
import { skinUsageStore } from '../services/skinUsage.js';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { sqliteDbPath } from '../storage/sqliteProvider.js';
import { runNewcomerProTrial } from '../services/proTrialNewcomer.js';
import { runHolidayGift } from '../services/holidayGift.js';
import { runRegisterBonusBackfill, runRegisterBonusEmailRetry } from '../services/registerBonusBackfill.js';
import { getClientIp } from '../services/geo.js';
import { selfExcludeStore } from '../services/selfExclude.js';
import { werewolfAdminStats } from '../services/werewolf.js';
import { isTestAccount, isDeveloperAccount } from '../services/accountFilters.js';
import { buildReferralReport } from '../services/adminReferrals.js';
import { referralEventStore } from '../services/referralEvents.js';
import { SYSTEM_USER_ID } from '../services/usage.js';
// 控制台「会员到期」口径（会员有效期 / 7 天 Pro 体验 / 已过期 / 永久 / 从未开通）：
// 列表与 CSV 导出共用 services/memberExpiry.ts 一份口径（可被单测直接覆盖）
import { expiryFieldsOf } from '../services/memberExpiry.js';

const router = Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('⚠️ [Security] ADMIN_TOKEN 未配置：所有 /api/payment/admin/* 管理接口已禁用。请在 .env 设置强随机 ADMIN_TOKEN。');
}

function isAdmin(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const token = String(req.query?.token || req.headers['x-admin-token'] || '');
  if (!token || token.length !== ADMIN_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(ADMIN_TOKEN, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 把功能分桶压成前端好用的形状：{ chat: { c: 12.34, r: 210, img: 0 }, ... }
 * （c=cost 元, r=requests 次数, img=出图张数；只保留实际发生过的功能，避免把 10 个空键塞进每个用户行）
 */
function compactCostByFeature(byFeature: Record<string, { cost: number; requests: number; images: number }> | undefined): Record<string, { c: number; r: number; img: number }> {
  const out: Record<string, { c: number; r: number; img: number }> = {};
  for (const [k, b] of Object.entries(byFeature || {})) {
    if (!b) continue;
    const img = b.images || 0;
    if (!b.cost && !b.requests && !img) continue;
    out[k] = { c: Math.round((b.cost || 0) * 10000) / 10000, r: b.requests || 0, img };
  }
  return out;
}

/** 校验 YYYY-MM-DD 且为真实日历日期（防 2026-99-99 / 2026-02-30 等格式合法但非真实日期） */function isValidYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/**
 * 改数据前的一致性备份（红线：先备份再改）。
 * SQLite：用 `VACUUM INTO` 生成独立快照（即使服务在场也能得到一致副本）；
 * 文件模式：复制相关 JSON。返回备份路径。
 */
function backupDataToTemp(prefix: string = 'newcomer-trial-backup'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(process.cwd(), 'temp', `${prefix}-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  if ((process.env.PERSISTENCE_PROVIDER || 'file').toLowerCase() === 'sqlite') {
    const src = sqliteDbPath();
    const dest = path.join(dir, 'xiaoyu.sqlite');
    const db = new Database(src);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    db.close();
    return dest;
  }
  for (const f of ['users.json', 'accounts.json', 'user-activity.json', 'preferences.json']) {
    const p = path.join(process.cwd(), 'data', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, f));
  }
  return dir;
}

/**
 * 订单来源口径（唯一判据，三处共用：列表 / 小结 / 前端徽章）
 *  - 'paid'    用户扫码付款 → 运营确认到账后解锁 —— **这才是订单，计入收入**
 *  - 'free'    运营在后台手动开通（试用/赠送）—— 也是 unlocked，但**不是订单、不计收入**
 *  - 'unknown' 早期数据没有 source 字段 —— 一律如实标注「未标注」，**不再静默当付费**展示
 *    （注意：收入统计 paymentStore.revenueStats() 的历史口径是 `source !== 'free'` 即计入，
 *     所以 unknown 仍计在收入里；展示层不撒谎，口径差异在界面上写明。）
 */
function orderSourceKind(o: { source?: string }): 'paid' | 'free' | 'unknown' {
  return o.source === 'free' ? 'free' : o.source === 'paid' ? 'paid' : 'unknown';
}

/**
 * 运营端：订单列表
 * GET /api/payment/admin/orders?token=xxx&status=all|pending|unpaid|unlocked|expired&source=all|paid|free
 *
 * 两个筛选维度互相独立、可叠加：status 管生命周期，source 管「谁付的钱 / 谁开的通」。
 * 响应额外带 summary（全库口径小结，不受筛选影响）——控制台据此把
 * 「真实付费订单 / 我免费帮他开通的 / 用户下单没付款的」三件事分开显示，
 * 避免把免费开通当成订单（2026-09-18 用户指出：「订单 tab 看到好多项，实际一个订单都没有」）。
 */
router.get('/orders', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const status = String(req.query?.status || 'pending');
  const source = String(req.query?.source || 'all');
  // 默认「待确认」只返回用户已点「我已付款」的订单（status = paid）；未付款订单用 ?status=unpaid 单独查
  let orders = status === 'all'
    ? paymentStore.listAll()
    : paymentStore.listPending();

  if (status === 'unpaid') orders = paymentStore.listUnpaid();
  if (status === 'unlocked') orders = paymentStore.listAll().filter(o => o.status === 'unlocked');
  if (status === 'expired') orders = paymentStore.listAll().filter(o => o.status === 'expired');
  // 来源维度：paid = 排除免费开通（含未标注），free = 只看免费开通
  if (source === 'paid') orders = orders.filter(o => orderSourceKind(o) !== 'free');
  if (source === 'free') orders = orders.filter(o => orderSourceKind(o) === 'free');

  orders.sort((a, b) => b.createdAt - a.createdAt);

  const rows = orders.map(o => {
    const user = quotaStore.getQuota(o.userId);
    const acc = o.userId === 'DELETED_USER' ? null : accountStore.getById(o.userId);
    return {
      orderId: o.orderId,
      plan: isPlanKey(o.plan) ? o.plan : 'plus',
      days: o.days || 30,
      status: o.status,
      source: orderSourceKind(o),
      price: o.price,
      remark: o.remark || '',
      userId: o.userId.slice(0, 8),
      userName: acc ? (acc.username || acc.phone || acc.email.split('@')[0]) : (o.userId === 'DELETED_USER' ? '已注销用户' : '游客'),
      userEmail: acc?.email || '',
      userFreeUsed: user.freeUsed,
      userUnlocked: user.unlocked,
      createdAt: new Date(o.createdAt).toLocaleString('zh-CN'),
      confirmedAt: o.confirmedAt ? new Date(o.confirmedAt).toLocaleString('zh-CN') : null,
      unlockUntil: o.unlockUntil ? new Date(o.unlockUntil).toLocaleString('zh-CN') : null,
    };
  });

  // —— 全库口径小结：把「真订单」与「我开的通」「没付的下单」分开 ——
  // 付费数/收入直接取 revenueStats()（单一口径，避免第二份实现漂移）
  const all = paymentStore.listAll();
  const rev = paymentStore.revenueStats();
  const summary = {
    total: all.length,
    paidUnlocked: rev.ordersCount,                       // 已解锁且真实付费（= 收入口径笔数）
    freeUnlocked: all.filter(o => o.status === 'unlocked' && orderSourceKind(o) === 'free').length,
    unpaid: all.filter(o => o.status === 'pending').length,
    awaitingConfirm: all.filter(o => o.status === 'paid').length,
    expired: all.filter(o => o.status === 'expired').length,
    unknownSource: all.filter(o => orderSourceKind(o) === 'unknown').length,
    revenueCny: rev.total,
    filtered: rows.length,
  };
  res.json({ success: true, data: rows, summary });
});

/**
 * 运营端：AI 狼人杀累计数据
 * GET /api/payment/admin/werewolf-stats?token=xxx
 *
 * 口径说明（写在接口旁边，避免运营端误读）：
 *  - `counters` 是**自部署起的累计量**（单独记账，不随对局历史裁剪）；
 *  - `retainedGames` / `recent` 只反映**仍保留在磁盘上的对局**（每用户最近 10 局），不是历史全量；
 *  - `estimatedCreditTotal` 按累计 token 折算，与用户账单同源单价。
 */
router.get('/werewolf-stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const data = werewolfAdminStats();
  // 「按用户汇总」补一个可读的名字：注册账号显示用户名/邮箱前缀，未注册设备留 id 前缀（游客也能玩）
  const acc = new Map(accountStore.listAll().map(a => [a.userId, a]));
  const byUser = data.byUser.map((s) => {
    const a = acc.get(s.userId);
    return {
      ...s,
      name: a ? (a.username || a.email?.split('@')[0] || a.phone || '') : '',
      isGuest: !a,
    };
  });
  res.json({ success: true, data: { ...data, byUser } });
});

/**
 * 运营端：收入统计
 * GET /api/payment/admin/stats?token=xxx
 */
/**
 * GET /api/payment/admin/rp-prompt —— 剧情模式 system prompt 全文监控
 *
 * 返回中英双份 **实际会发给模型的 system prompt**（含成人块、craft 规则、语料库），
 * 以及开/关无限制模式两种版本的字符数，供管理端实时查看「改了之后模型到底收到什么」。
 *
 * 安全：沿用本路由的 isAdmin（fail-closed，未配 ADMIN_TOKEN 时整个路由禁用）。
 *   返回内容**含成人向提示词与露骨语料**，属敏感内容——不得加入任何公开缓存、不得写入日志。
 *   为便于对比，固定使用同一个代表剧本，不按请求方传入的 id 渲染（避免被当成读取任意剧本的通道）。
 */
router.get('/rp-prompt', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(403).json({ success: false, error: 'forbidden' }); return; }
  try {
    const rp: any = await import('../services/roleplay.js');
    const list = rp.listScenarios('zh') as any[];
    const scenario = rp.getScenario(list[0].id);
    const variants: Record<string, { chars: number; prompt: string }> = {};
    for (const lang of ['zh', 'en'] as const) {
      for (const adult of [true, false] as const) {
        const sys = rp.buildSystemPrompt(scenario, lang, undefined, undefined, undefined, 'immersive', adult);
        // 用 fromCharCode 拼换行：避免任何反斜杠转义在多层引用中被吃掉（本项目已踩过两次）
        const sep = String.fromCharCode(10) + String.fromCharCode(10);
        const prompt = adult ? sys + sep + rp.buildUnlimitedModeBlock(lang, 'immersive') : sys;
        variants[lang + '-' + (adult ? 'on' : 'off')] = { chars: prompt.length, prompt };
      }
    }
    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        scenarioId: list[0].id,
        scenarioTitle: (scenario && scenario.zh && scenario.zh.title) || '',
        adultModeAvailable: rp.roleplayUnlimitedAvailable ? rp.roleplayUnlimitedAvailable() : null,
        routing: rp.roleplayRoutingSummary ? rp.roleplayRoutingSummary() : null,
        variants,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: String(e?.message || e).slice(0, 200) });
  }
});

/**
 * GET /api/payment/admin/prompts —— 控制台「📝 提示词」页数据源（2026-09-26 新增）
 *
 * 分两级，避免一次吐出 200KB：
 *   · 不带参数 → 模式清单（每组模式的字数、块数、指纹；不含正文）
 *   · ?mode=<id> → 该模式全文（变体 + 分块），可带 ?lang=zh|zh-TW|en、?scenario=<剧本id>、?style=immersive|classic
 *
 * 文本来自 api/services/promptCatalog.ts —— 那是**真实调用点同源的**常量/builder，不是另一份拷贝，
 * 所以这里看到的即线上模型收到的。安全：沿用本路由 isAdmin（fail-closed，未配 ADMIN_TOKEN 时整个路由禁用）；
 * 返回内容含成人向提示词与情欲引导原文，**不得加入公开缓存、不得写入日志**。
 */
router.get('/prompts', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(403).json({ success: false, error: 'forbidden' }); return; }
  try {
    const { promptCatalogIndex, buildPromptMode } = await import('../services/promptCatalog.js');
    res.setHeader('Cache-Control', 'no-store');
    const modeId = typeof req.query.mode === 'string' ? req.query.mode.trim() : '';
    if (!modeId) {
      res.json({ success: true, data: await promptCatalogIndex() });
      return;
    }
    const langRaw = typeof req.query.lang === 'string' ? req.query.lang : '';
    const lang = (['zh', 'zh-TW', 'en'] as const).includes(langRaw as 'zh') ? (langRaw as 'zh' | 'zh-TW' | 'en') : undefined;
    const styleRaw = typeof req.query.style === 'string' ? req.query.style : '';
    const style = (['immersive', 'classic'] as const).includes(styleRaw as 'immersive') ? (styleRaw as 'immersive' | 'classic') : undefined;
    const scenarioId = typeof req.query.scenario === 'string' ? req.query.scenario : undefined;
    const mode = await buildPromptMode(modeId, { lang, style, scenarioId });
    if (!mode) { res.status(404).json({ success: false, error: '未知模式: ' + modeId }); return; }
    res.json({ success: true, data: mode });
  } catch (e: any) {
    res.status(500).json({ success: false, error: String(e?.message || e).slice(0, 300) });
  }
});

router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  res.json({ success: true, data: paymentStore.revenueStats() });
});

/**
 * 运营端：注册趋势（近 N 天每日注册数，排除测试账户）
 * GET /api/payment/admin/register-trend?token=xxx&days=30
 */
router.get('/register-trend', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const accounts = (accountStore.listAll() || []).filter(a => !isTestAccount(a) && !isDeveloperAccount(a));
  // 按香港时间(UTC+8)分桶
  const map = new Map<string, number>();
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const start = new Date(now.getTime() - (days - 1) * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    map.set(d.toISOString().slice(0, 10), 0);
  }
  for (const a of accounts) {
    const t = new Date((a.createdAt || 0) + 8 * 3600 * 1000);
    const key = t.toISOString().slice(0, 10);
    if (map.has(key)) map.set(key, (map.get(key) || 0) + 1);
  }
  const daily = [...map.entries()].map(([date, count]) => ({ date, count }));
  const total = accounts.length;
  const last7 = daily.slice(-7).reduce((s, d) => s + d.count, 0);
  res.json({ success: true, data: { daily, total, last7, days } });
});

/**
 * 运营端：按预设邀请码统计注册人数
 * GET /api/payment/admin/invite-stats?token=xxx
 */
router.get('/invite-stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const counts = quotaStore.countByInviteCode();
  const codes = Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const total = codes.reduce((s, c) => s + c.count, 0);
  res.json({ success: true, data: { codes, total } });
});
/**
 * 运营端：邀请推广榜（**谁的推广链接被谁用了 / 拉了多少人 / 赚了多少额度与会员天数**）
 * GET /api/payment/admin/referrals?token=xxx[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *
 * 口径（实现与「精确 vs 近似」的边界见 `api/services/adminReferrals.ts` 文件头）：
 *  - **台账**：`data/referral-events.json`（referralEvents.ts）自 2026-09-18 起对每一笔真实发放逐条记账
 *    （注册邀请：邀请人 +INVITE_BONUS 条、被邀人同额；被邀人首购：邀请人 +同档天数封顶年付、月付再送半月）；
 *  - **回算**：台账之前的历史用「被邀人注册时间」与「被邀人首笔已解锁订单时间」估算，
 *    返回值里标 `source:'estimate'` 且 `approximate=true`，控制台据此显示「近似」；
 *  - 与 `/activity` 同一套区间参数：from/to 成对给定时为区间口径（区间内**发生**的邀请与发放），
 *    否则为累计口径；测试账号与运营账号在两侧都被排除（他们不是真实推广）。
 */
router.get('/referrals', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const from = String(req.query?.from || '');
  const to = String(req.query?.to || '');
  const rangeRequested = !!(from || to);
  if (rangeRequested && (!isValidYmd(from) || !isValidYmd(to))) {
    res.status(400).json({ success: false, error: '区间需同时给 from 与 to，格式 YYYY-MM-DD（且为真实日期）' });
    return;
  }
  try {
    const data = buildReferralReport(rangeRequested ? { from, to } : {});
    res.json({ success: true, data });
  } catch (error) {
    console.error('Referral report error:', error);
    res.status(500).json({ success: false, error: '生成邀请推广报告失败' });
  }
});

/**
 * 邀请**归因**口径（与「📣 邀请推广」榜同源，2026-09-29 加）。
 *
 * 为什么列表页需要它：`quota.inviteCount` 只统计**已结算**的邀请——按 2026-09-19 的 B 方案，
 * 被邀人**真的开口用过**才算数（防薅羊毛）。所以只看 `inviteCount` 会把「有人经他链接注册了、
 * 还在等首次使用」的邀请人显示成「没邀请到人」，这是**假阴性**，运营据此联系人就错了。
 * 返回：
 *  - `attributed`：台账里归到他名下的注册人数（`signup` + `signup_pending`）；
 *  - `rejected`：人来了但被反套利拦下（同设备/IP、邀请人太新、超上限…）的记录数，供详情解释。
 * 调用方用 `max(inviteCount, attributed)` 得当期归因总数——台账（2026-09-19）之前的历史只存在于
 * `inviteCount` 里，取下限会把老邀请人算少。
 */
function inviteAttributionMap(): { attributed: Map<string, number>; rejected: Map<string, number> } {
  const attributed = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const e of referralEventStore.listAll()) {
    if (!e?.inviterId) continue;
    if (e.kind === 'signup' || e.kind === 'signup_pending') {
      attributed.set(e.inviterId, (attributed.get(e.inviterId) || 0) + 1);
    } else if (e.kind === 'signup_rejected') {
      rejected.set(e.inviterId, (rejected.get(e.inviterId) || 0) + 1);
    }
  }
  return { attributed, rejected };
}

/**
 * 运营端：用户详情审计（配额 + 历史记录 + 订单）
 * GET /api/payment/admin/users/:userId?token=xxx
 */
router.get('/users/:userId', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const userId = String(req.params.userId);
  const quota = quotaStore.getQuota(userId);
  const account = accountStore.getById(userId);
  const orders = paymentStore.listAll().filter(o => o.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  const { memoryStorage } = await import('../storage/memory.js');
  const { usageStore } = await import('../services/usage.js');
  const { activityStore } = await import('../services/activity.js'); // 📤 邀请复制次数（动作口径）
  const usage = usageStore.get(userId) || null;
  const sessions = memoryStorage.getActiveSessions()
    .filter(s => s.userId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(s => ({
      sessionId: s.sessionId,
      createdAt: new Date(s.createdAt).toLocaleString('zh-CN'),
      emotion: s.emotionAnalysis?.emotion,
      intensity: s.emotionAnalysis?.intensity,
      storyTitle: s.healingStory?.title,
    }));

  res.json({
    success: true,
    data: {
      user: account ? accountStore.getPublic(account) : { userId, username: null, phone: null, email: null },
      quota,
      // 归一后的「所有额度池」（可用/已用/总量），供控制台渲染额度明细表
      quotaDetail: quotaStore.describeQuota(userId),
      /**
       * 🎟/📣 邀请（2026-09-29 用户要求「也要能看到他们是否复制了邀请链接以及是否邀请到人」）：
       * 动作口径（复制过几次、最近一次）来自 activityStore；结果口径（拉来几人、拿到多少额度）
       * 来自 quotaStore；`invitedBy/inviterName` 是「他是被谁拉进来的」，三项一起给，控制台一次渲染完。
       */
      invite: (() => {
        const qrec = quotaStore.getRecord(userId);
        const act = activityStore.get(userId);
        const inviterAcc = qrec?.invitedBy ? accountStore.getById(qrec.invitedBy) : null;
        const { attributed, rejected } = inviteAttributionMap();
        return {
          count: qrec?.inviteCount || 0,
          // 归因人数（含还没结算的），见 inviteAttributionMap 的注释：只看 count 会假阴性
          attributed: Math.max(qrec?.inviteCount || 0, attributed.get(userId) || 0),
          rejected: rejected.get(userId) || 0,
          credits: (qrec?.inviteCount || 0) * INVITE_BONUS_COUNT,
          copyCount: act?.inviteCopyCount || 0,
          copiedAt: act?.inviteCopiedAt || null,
          code: qrec?.inviteCodeUsed || null,
          invitedBy: qrec?.invitedBy || null,
          inviterName: inviterAcc ? (inviterAcc.username || (inviterAcc.email || '').split('@')[0]) : null,
        };
      })(),
      usage: usage ? {
        requests: usage.requests,
        tokens: usage.promptTokens + usage.completionTokens + usage.cachedTokens,
        cost: usage.cost,
        lastUsed: usage.lastUsed ? new Date(usage.lastUsed).toLocaleString('zh-CN') : null,
        // 功能细分：这个人的钱花在哪些功能上（聊一聊/剧情扮演/文游/狼人杀/出图…）
        costByFeature: usageStore.getUserFeatureBreakdown(userId),
      } : { requests: 0, tokens: 0, cost: 0, lastUsed: null, costByFeature: {} },
      orders: orders.map(o => ({
        orderId: o.orderId, status: o.status, price: o.price, remark: o.remark || '',
        createdAt: new Date(o.createdAt).toLocaleString('zh-CN'),
        confirmedAt: o.confirmedAt ? new Date(o.confirmedAt).toLocaleString('zh-CN') : null,
        unlockUntil: o.unlockUntil ? new Date(o.unlockUntil).toLocaleString('zh-CN') : null,
      })),
      sessions,
    }
  });
});

/**
 * 运营端：查看某用户完整聊天记录（聊一聊 + 角色扮演剧情）
 * GET /api/payment/admin/users/:userId/chat?token=xxx
 * 敏感：可能含用户私密/危机情绪内容。前端需先二次确认。
 */
router.get('/users/:userId/chat', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const userId = String(req.params.userId);

  const { memoryStorage } = await import('../storage/memory.js');
  const { roleplaySessionStore } = await import('../services/roleplaySessions.js');
  const { wenyouSavesStore } = await import('../services/wenyouSaves.js');
  const { werewolfLedger } = await import('../services/werewolfLedger.js');
  const { resolveRoleplayTitle, resolveWenyouTitle } = await import('../services/scenarioTitle.js');

  // 聊一聊：sessions.json 的 chatMessages（单会话最多 100 条，每用户最多 50 个会话，已由存储层截断）
  const chatSessions = memoryStorage.getActiveSessions()
    .filter(s => s.userId === userId && Array.isArray(s.chatMessages) && s.chatMessages.length > 0)
    .sort((a, b) =>
      new Date(b.chatUpdatedAt || b.updatedAt).getTime() - new Date(a.chatUpdatedAt || a.updatedAt).getTime()
    )
    .map(s => {
      const msgs = s.chatMessages!;
      return {
        sessionId: s.sessionId,
        title: s.chatTitle || (msgs[0]?.role === 'user' ? msgs[0].content.slice(0, 30) : '(未命名对话)'),
        messageCount: msgs.length,
        pinned: !!s.chatPinned,
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.chatUpdatedAt || s.updatedAt).toISOString(),
        // 图片只回传「有无附件」标记，避免把用户 base64 大图灌进控制台响应（隐私 + 体积）
        messages: msgs.map(m => ({
          role: m.role,
          content: m.content,
          hasImage: !!m.image,
          timestamp: new Date(m.timestamp).toISOString(),
        })),
      };
    });

  // 角色扮演：roleplay-sessions.json（按 userId+scenarioId 一条，最多 200 条消息）
  const roleplaySessions = roleplaySessionStore.listAll()
    .filter(r => r.userId === userId && Array.isArray(r.messages) && r.messages.length > 0)
    .map(r => {
      // 标题一律走统一解析：自建剧本显示用户自己起的剧名 + 「自建」标志，
      // 不再把 custom_xxx 内部 id 甩到控制台上（解析不到时回退会话里的标题快照）；
      // scenarioDeleted＝剧本已被创作者删除，控制台另标「已删」，免得「自建剧情」看起来像没起名。
      const resolved = resolveRoleplayTitle(r.scenarioId, userId, 'zh', r.scenarioTitle);
      return {
        scenarioId: r.scenarioId,
        scenarioTitle: resolved.title,
        customScenario: resolved.custom,
        scenarioDeleted: resolved.deleted,
        userPreference: r.userPreference || '',
        messageCount: r.messages.length,
        updatedAt: r.updatedAt,
        // 🚨 这里是**逐字段重建**消息（只挑 role/content/timestamp），所以审计字段必须显式带上，
        // 否则管理端永远看不到「这条是谁写的」——同一类静默丢字段的坑在本项目已出现三次。
        messages: r.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp ?? r.updatedAt).toISOString(),
          // undefined = 未记录（老数据 / 该路径未带上），前端据此显示「未记录」而不是「否」
          viaUnlimited: typeof m.viaUnlimited === 'boolean' ? m.viaUnlimited : undefined,
          model: typeof m.model === 'string' ? m.model : undefined,
        })),
        // 整段剧情的成人模式使用概况（便于列表一眼看出，不必逐条数）
        unlimitedTurns: r.messages.filter(m => m.role === 'assistant' && m.viaUnlimited === true).length,
        taggedTurns: r.messages.filter(m => m.role === 'assistant' && typeof m.viaUnlimited === 'boolean').length,
      };
    });

  // 理一理：情绪分析会话（rawInput → 情绪分析/深入问题/详细分析/疗愈故事），按 userId 取
  const analysisSessions = memoryStorage.getActiveSessions()
    .filter(s => s.userId === userId && (s.emotionAnalysis || s.rawInput || s.detailedAnalysis || s.healingStory))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(s => {
      const ea = s.emotionAnalysis;
      const da = s.detailedAnalysis;
      const hs = s.healingStory;
      return {
        sessionId: s.sessionId,
        rawInput: s.rawInput || '',
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
        emotionAnalysis: ea ? {
          emotion: ea.emotion,
          category: ea.category || '',
          intensity: ea.intensity,
          analysis: ea.analysis,
          suggestions: ea.suggestions || [],
          timestamp: new Date(ea.timestamp).toISOString(),
        } : null,
        questions: (s.questions || []).map(q => ({ question: q.question, answer: q.answer || '', timestamp: new Date(q.timestamp).toISOString() })),
        detailedAnalysis: da ? {
          emotionalState: da.emotionalState,
          triggers: da.triggers || [],
          coreIssues: da.coreIssues || [],
          recommendations: da.recommendations || [],
          positiveFactors: da.positiveFactors || [],
          timestamp: new Date(da.timestamp).toISOString(),
        } : null,
        healingStory: hs ? { title: hs.title, content: hs.content, mood: hs.mood, timestamp: new Date(hs.timestamp).toISOString() } : null,
      };
    });

  const account = accountStore.getById(userId);
  const userLabel = account
    ? (account.username || account.email || account.phone || userId.slice(0, 8))
    : userId.slice(0, 8);

  /**
   * 剧情演绎的另外两个模式（此前该弹窗只有「🎭 角色扮演」，用户玩文游/狼人杀时控制台一片空白）。
   * ⚠️ 全都只回**元信息**：文游只给剧本标题与进度计数（正文留在 wenyou-saves.json 不进控制台响应），
   * 狼人杀只给开局时间/局型/档位（台账本来就只有这些）。
   */
  const wenyouProgress = (() => {
    const p = wenyouSavesStore.get(userId);
    if (!p) return null;
    const games = Object.entries(p.games || {}).map(([scenarioId, g]) => {
      const r = resolveWenyouTitle(scenarioId, userId);
      return {
        scenarioId,
        title: r.title,
        customScenario: r.custom,
        at: p.updatedAt,
        // 进行中的局：只报「已走到第几回合」这类进度元信息（state.history 长度），不读剧情正文
        turn: Array.isArray((g as any)?.state?.history) ? (g as any).state.history.length : 0,
      };
    });
    const endings = Object.entries(p.endings || {}).map(([scenarioId, tones]) => {
      const r = resolveWenyouTitle(scenarioId, userId);
      return {
        scenarioId,
        title: r.title,
        customScenario: r.custom,
        // 达成的结局色调数量（结局文案在千世书前端，控制台只显示数量）
        endingCount: Array.isArray(tones) ? tones.length : 0,
      };
    });
    return { games, endings, slots: Array.isArray(p.slots) ? p.slots.length : 0, updatedAt: p.updatedAt || 0 };
  })();

  const werewolfGames = werewolfLedger.byUser(userId, 20).map((g) => ({
    at: g.at,
    size: g.size,
    plan: g.plan,
    source: g.source,
  }));

  // 自建剧本记录：含「创建时是否用无限制模型辅助生成」标记（方案 A2 采集）
  const { customRoleplayStore } = await import('../services/customRoleplay.js');
  const { isAdultConfirmed } = await import('../services/adultConfirm.js');
  const { unlimitedActiveFor } = await import('../services/roleplay.js');
  const customScenarios = customRoleplayStore.listByUser(userId).map(c => ({
    id: c.id,
    title: c.title,
    aiName: c.aiName,
    status: c.status || 'draft',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // undefined = 未记录（老数据 / 手写而非 AI 生成）。**不要显示成「否」**
    createdWithUnlimited: typeof c.createdWithUnlimited === 'boolean' ? c.createdWithUnlimited : undefined,
    createdWithModel: typeof c.createdWithModel === 'string' ? c.createdWithModel : undefined,
    creationPrompt: typeof c.creationPrompt === 'string' ? c.creationPrompt : undefined,
  }));
  // AI 建剧提示词：draft/revise 是**不落库**的一次性调用，只有这份日志能看到用户当时输入的原文
  const { creationPromptLog } = await import('../services/creationPromptLog.js');
  const creationPrompts = creationPromptLog.listByUser(userId, 30);
  // 该用户此刻的成人模式状态：adultConfirmed = 做过 18+ 确认；unlimitedActive = 偏好+确认都满足、真会走无限制模型
  const adultStatus = { adultConfirmed: isAdultConfirmed(userId), unlimitedActive: unlimitedActiveFor(userId) === true };

  res.json({
    success: true,
    data: {
      userId,
      userLabel,
      chatSessions,
      roleplaySessions,
      customScenarios,
      creationPrompts,
      adultStatus,
      analysisSessions,
      // 剧情演绎的另外两个模式（此前该弹窗只有「🎭 角色扮演」，玩文游/狼人杀的用户在这里一片空白）
      wenyouProgress,
      werewolfGames,
      werewolfTotal: werewolfLedger.countForUser(userId),
    },
  });
});

/**
 * 运营端：API 成本趋势（按天）
 * GET /api/payment/admin/usage-trend?token=xxx&days=30
 */
router.get('/usage-trend', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Math.min(90, Math.max(7, Number(req.query?.days || 30)));
  const { usageStore } = await import('../services/usage.js');
  res.json({ success: true, data: usageStore.getDailyTrend(days) });
});

/**
 * 运营端：API 成本构成（**谁花的钱**）——按功能细分
 * GET /api/payment/admin/cost-breakdown?token=xxx&days=30
 *
 * 口径（2026-09-17 新增「功能细分」）：
 *  - 数据源 = `usageStore` 的功能分桶。每笔调用在 `api/services/deepseek.ts` 处按 `feature` 打标
 *    （聊一聊 / 理一理 / 剧情扮演 / 千世书 · 文游 / 狼人杀 / 长期记忆 / 流失挽回 / 运营内部）；
 *  - **「出图」是按张计费**的真金白银（场景插画 / 运营皮肤），与 token 无关，单列一行；
 *  - 升级前的历史数据没有功能标记 → 归入「历史未分类」，**总额与 /usage-trend 完全一致**；
 *  - `estimated > 0` = 该功能里含「拿不到真实 usage、按生成量估算」的调用（流式中断，或第三方不支持 include_usage），
 *    前端据此提示「含估算」，避免把估算当成账单。
 */
router.get('/cost-breakdown', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Math.min(90, Math.max(1, Number(req.query?.days || 30)));
  const { usageStore, FEATURE_LABELS, peakPricingInfo } = await import('../services/usage.js');
  const data = usageStore.getFeatureBreakdown(days);
  const today = usageStore.getFeatureBreakdown(1);
  const t = today.daily[0];
  res.json({
    success: true,
    data: {
      range: data.range,
      labels: FEATURE_LABELS,
      totals: data.totals,
      today: t ? { date: t.date, cost: t.cost, requests: t.requests, byFeature: t.byFeature } : null,
      daily: data.daily,
      allTimeCost: usageStore.totalCost(),
      // 分时定价状态：peak 时段官方单价翻倍，控制台要能看出「此刻是否按 ×N 在算」
      peak: peakPricingInfo(),
      imageNote: '出图按厂商参考单价估算（万相 0.14 / Seedream 0.2 / CogView 0.06 元/张；本机侧车 0），不含厂商免费额度',
    },
  });
});

/**
 * 运营端：用户真实使用时长（按日期范围汇总 + 按用户排行）
 * GET /api/payment/admin/usage-time?token=xxx&days=30  或  &from=YYYY-MM-DD&to=YYYY-MM-DD
 * 数据源：客户端活跃时长心跳（api/services/usageTime.ts，自功能上线起累计）。
 */
router.get('/usage-time', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { usageTimeStore, usageDiagStore } = await import('../services/usageTime.js');
  const { activityStore } = await import('../services/activity.js');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let from = String(req.query?.from || '');
  let to = String(req.query?.to || '');
  if (!from || !to) {
    let days = Number(req.query?.days) || 30;
    days = Math.min(365, Math.max(1, days));
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    if (!from) from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    if (!to) to = today;
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    res.status(400).json({ success: false, error: '日期格式应为 YYYY-MM-DD' });
    return;
  }

  const summary = usageTimeStore.getRangeSummaries(from, to);
  const accounts = accountStore.listAll() || [];
  const accById = new Map(accounts.map(a => [a.userId, a]));
  const users = summary.users.map(u => {
    const acc = accById.get(u.userId);
    const isTest = acc ? isTestAccount(acc) : false;
    const label = acc ? (acc.username || acc.email.split('@')[0]) : ('设备-' + u.userId.slice(0, 8));
    return {
      userId: u.userId,
      label,
      email: acc?.email || null,
      isTest,
      seconds: u.seconds,
      lifetimeSeconds: u.lifetimeSeconds,
      lastActiveAt: activityStore.get(u.userId)?.lastActiveAt ?? null,
    };
  });

  res.json({
    success: true,
    data: {
      range: { from, to },
      totalSeconds: summary.totalSeconds,
      activeUsers: summary.activeUsers,
      lifetimeTotal: summary.lifetimeTotal,
      daily: summary.daily,
      users,
      // 心跳诊断计数（无用户内容）：看「上报里 hasFocus 是否为 false」「有没有整段 0 秒的访问」
      diag: usageDiagStore.snapshot(),
    },
  });
});

/**
 * 运营端：按天 收入 vs 成本（双柱趋势）
 * GET /api/payment/admin/daily-stats?token=xxx&days=30
 */

/**
 * 运营端：每日访问用户量（按设备首次访问日期统计）+ 累计独立访客
 * GET /api/payment/admin/visits?token=xxx&days=30
 */
router.get('/visits', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Math.min(90, Math.max(1, Number(req.query?.days || 30)));
  const { visitStore } = await import('../services/visits.js');
  res.json({
    success: true,
    data: {
      total: visitStore.getVisitCount(),
      daily: visitStore.getDailyVisits(days),
      hourly: visitStore.getHourlyVisits(days), // 访问时段分布（0-23 时，跨天独立设备去重）
    },
  });
});

/**
 * 运营端：运营自查 IP 自排除清单（方案 A：按公网 IP 免计自查访问）
 * GET    /api/payment/admin/self-ip          → 列出已排除的 IP
 * POST   /api/payment/admin/self-ip          → 登记当前请求 IP（打开控制台自动调用，幂等）
 * DELETE /api/payment/admin/self-ip/:ip      → 移除指定 IP（URL 编码传输）
 */
router.get('/self-ip', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  res.json({ success: true, data: { ips: selfExcludeStore.list() } });
});

router.post('/self-ip', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const ip = getClientIp(req);
  const added = selfExcludeStore.addAndSave(ip, '运营自查（admin）');
  res.json({ success: true, data: { ip, added } });
});

router.delete('/self-ip/:ip', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  // Express 已对 :ip 做一次 decodeURIComponent，直接取用（selfExcludeStore.remove 内部再归一化）
  const ip = String(req.params.ip || '');
  const removed = selfExcludeStore.remove(ip);
  res.json({ success: true, data: { ip, removed } });
});

router.get('/daily-stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Math.min(90, Math.max(7, Number(req.query?.days || 30)));
  const { usageStore } = await import('../services/usage.js');
  const trend = usageStore.getDailyTrend(days); // [{ date: 'MM-DD', cost, requests }]

  // 收入按天聚合（已确认解锁的订单）
  const revenueByDay = new Map<string, number>();
  for (const o of paymentStore.listAll()) {
    if (o.status !== 'unlocked') continue;
    const t = o.confirmedAt || o.createdAt;
    const d = new Date(t);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    revenueByDay.set(key, Math.round(((revenueByDay.get(key) || 0) + o.price) * 100) / 100);
  }

  const data = trend.map(t => ({
    date: t.date,
    cost: t.cost,
    revenue: revenueByDay.get(t.date) || 0,
  }));
  res.json({ success: true, data });
});

/**
 * 运营端：CSV 导出
 * GET /api/payment/admin/export?token=xxx&type=users|orders
 */
router.get('/export', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const type = String(req.query?.type || 'users');
  let csv = '';
  let filename = '';

  if (type === 'users') {
    const accounts = accountStore.listAll().filter(a => !isDeveloperAccount(a));
    filename = `cure-users-${Date.now()}.csv`;
    csv = '用户名,手机号,邮箱,注册时间,已用免费次数,理一理总量,理一理已用,理一理剩余,对话总量,对话已用,对话剩余,点数可用(条),点数今日已用(条),点数今日上限(条),点数赠送余额(条),生成额度,会员状态,会员档位,到期时间,剩余天数\n';
    for (const acc of accounts) {
      const q = quotaStore.getQuota(acc.userId);
      // 到期口径与「控制台用户列表」同源（含 Pro 体验期 / 已过期 / 永久），避免导出与页面两套说法
      const exp = expiryFieldsOf(quotaStore.getRecord(acc.userId), Date.now());
      const rawPlan = quotaStore.getRecord(acc.userId)?.plan;
      const status = exp.expiryKind === 'lifetime' ? '永久会员'
        : exp.expiryState === 'active' ? (exp.expiryKind === 'trial' ? 'Pro 体验中' : '会员中')
        : exp.expiryKind === 'expired' ? '已过期' : '非会员';
      const planLabel = rawPlan === 'lifetime' ? 'Pro（永久）'
        : rawPlan === 'pro' ? 'Pro'
        : rawPlan === 'plus' ? 'Plus'
        : exp.expiryKind === 'trial' ? 'Pro（体验）' : '免费';
      const expiryText = exp.expiryKind === 'lifetime' ? '永久'
        : exp.expiryAt ? new Date(exp.expiryAt).toLocaleString('zh-CN') : '';
      // 💳 额度列：口径与页面同源（quotaStore.describeQuota）；无限档/无值一律留空，不编数字
      const qd = quotaStore.describeQuota(acc.userId);
      const numOr = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
      const line = [
        acc.username || '',
        acc.phone || '',
        acc.email,
        new Date(acc.createdAt).toLocaleString('zh-CN'),
        String(q.freeUsed),
        String(qd.struct.total), String(qd.struct.used), String(qd.struct.remain),
        String(qd.chat.total), String(qd.chat.used), String(qd.chat.remain),
        numOr(qd.credit.remainTiao), numOr(qd.credit.usedTodayTiao), numOr(qd.credit.dailyCapTiao), numOr(qd.credit.bonusTiao),
        String(qd.genCredit),
        status,
        planLabel,
        expiryText,
        exp.daysLeft === null ? '' : String(exp.daysLeft),
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
      csv += line + '\n';
    }
  } else {
    const orders = paymentStore.listAll().sort((a, b) => b.createdAt - a.createdAt);
    filename = `cure-orders-${Date.now()}.csv`;
    // 类型/计入收入两列（2026-09-18）：免费开通单也有 price（那是档位标价，不是收款），
    // 只在「计入收入=是」上求和才是真实收入——否则 Excel 一拉就把免费开通算成营收。
    csv = '订单号,类型,计入收入,金额(标价),状态,付款凭证,用户ID,创建时间,确认时间,解锁到期\n';
    for (const o of orders) {
      const kind = orderSourceKind(o);
      const kindLabel = kind === 'free' ? '免费开通（运营手动开）' : kind === 'paid' ? '用户付款' : '未标注（早期数据）';
      const counted = o.status === 'unlocked' && kind !== 'free' ? '是' : '否';
      const line = [
        o.orderId, kindLabel, counted, String(o.price), o.status, o.remark || '', o.userId,
        new Date(o.createdAt).toLocaleString('zh-CN'),
        o.confirmedAt ? new Date(o.confirmedAt).toLocaleString('zh-CN') : '',
        o.unlockUntil ? new Date(o.unlockUntil).toLocaleString('zh-CN') : '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
      csv += line + '\n';
    }
  }

  // UTF-8 BOM 方便 Excel 打开中文
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('export_csv', `导出 ${type === 'users' ? '用户' : '订单'} CSV`, req.ip || '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);
});

/**
 * 运营端：确认订单到账并解锁
 * POST /api/payment/admin/orders/:orderId/confirm?token=xxx
 */
router.post('/orders/:orderId/confirm', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const order = paymentStore.getOrder(req.params.orderId);
  if (!order) {
    res.status(404).json({ success: false, error: '订单不存在' });
    return;
  }
  if (order.status === 'unlocked') {
    res.json({ success: true, data: { message: '该订单已解锁' } });
    return;
  }
  const plan: PlanKey = isPlanKey(order.plan) ? order.plan : 'plus';
  // 买断订单走 lifetime 解锁；月付/年付按订单天数（30/60/90/365）
  const purchase: Purchase = order.purchase || 'monthly';
  const baseDays = order.days || UNLOCK_DAYS_COUNT;
  // 被邀人首购 → 邀请人同档会员（封顶年付）；月付且引荐有效 → 被邀人 +半月
  const reward = quotaStore.rewardInviterForPurchase(order.userId, plan, purchase, baseDays);
  const grantDays = purchase === 'lifetime' ? baseDays : baseDays + reward.friendBonusDays;
  const unlockUntil = purchase === 'lifetime'
    ? quotaStore.unlockLifetime(order.userId, plan)
    : quotaStore.unlock(order.userId, grantDays, plan);
  paymentStore.markUnlocked(order.orderId, unlockUntil);
  const { auditStore } = await import('../services/audit.js');
  if (reward.inviter) auditStore.log('invite_paid_reward', `被邀人 ${order.userId.slice(0, 8)} 首购 → 邀请人 ${reward.inviter.slice(0, 8)} +${reward.inviterDays} 天（同档·封顶年付）`, req.ip || '');
  if (reward.friendBonusDays > 0) auditStore.log('invite_friend_bonus', `被邀人 ${order.userId.slice(0, 8)} 月付送半月 +${reward.friendBonusDays} 天`, req.ip || '');
  auditStore.log('confirm_order', `订单 ${order.orderId}（${plan}）确认到账解锁`, req.ip || '');
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      message: '已确认到账，用户已解锁',
      unlockUntil: new Date(unlockUntil).toLocaleString('zh-CN'),
    }
  });
});

/**
 * 运营端：把一笔订单改记为「免费开通」（不计收入）
 * POST /api/payment/admin/orders/:orderId/mark-free?token=xxx&remark=原因
 *
 * 用途：运营自测单 / 赠送单被记成了付费单（付款页自测、给朋友开），
 * 改记后它就从「付费订单 / 收入」移出，归到「免费开通（不计收入）」——口径回到事实。
 * 幂等：已是 free 只补备注；真实收款单不要用这个接口（这是运营的判断，不是系统能判的）。
 */
router.post('/orders/:orderId/mark-free', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const order = paymentStore.getOrder(req.params.orderId);
  if (!order) {
    res.status(404).json({ success: false, error: '订单不存在' });
    return;
  }
  const remark = String(req.query?.remark || '').slice(0, 60).trim();
  const changed = paymentStore.markFree(order.orderId, remark || undefined);
  const { auditStore } = await import('../services/audit.js');
  auditStore.log(
    'mark_order_free',
    `订单 ${order.orderId}（原 ${orderSourceKind(order)}）改记为免费开通（不计收入）${changed ? '' : ' · 无需变更'}${remark ? ' · ' + remark : ''}`,
    req.ip || ''
  );
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      source: 'free',
      changed,
      remark: paymentStore.getOrder(order.orderId)?.remark || '',
      message: changed ? '已改记为免费开通：不再计入付费笔数与收入' : '该订单已是免费开通（备注已补）',
    },
  });
});

/**
 * 运营端：修正一笔订单的实收金额（离线转账 / 折扣 / 按实际到账对账）
 * POST /api/payment/admin/orders/:orderId/amount   { price: number, note?: string }
 *
 * 用途：用户没走站内通道付款（微信单独转账等）或按实收价结算时，
 * 让控制台里的金额与「收入」口径回到**实际到账金额**。
 * 只改 price（+ 追加备注）；status / source 不变 —— 解锁走 /confirm，改记免费走 /mark-free。
 */
router.post('/orders/:orderId/amount', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const raw = req.body?.price ?? req.query?.price;
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) {
    res.status(400).json({ success: false, error: '金额需为 0~100000 之间的正数' });
    return;
  }
  const order = paymentStore.getOrder(req.params.orderId);
  if (!order) {
    res.status(404).json({ success: false, error: '订单不存在' });
    return;
  }
  const rounded = Math.round(price * 100) / 100;
  const note = String(req.body?.note ?? req.query?.note ?? '').slice(0, 60).trim();
  const changed = paymentStore.setPrice(order.orderId, rounded, note);
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('order_amount_set', `订单 ${order.orderId} 实收金额 ¥${changed?.from} → ¥${rounded}${note ? ' · ' + note : ''}`, req.ip || '');
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      from: changed?.from,
      to: rounded,
      remark: paymentStore.getOrder(order.orderId)?.remark || '',
      message: `已把实收金额记为 ¥${rounded}（原 ¥${changed?.from}）`,
    },
  });
});

/**
 * 测试账号 / 开发者账号判定。
 *
 * 2026-09 抽到 services/accountFilters.ts：服务层（adultCampaign 定向邮件）也要用同一口径，
 * 而 services 不能反向 import 路由（循环依赖）。判定逻辑原样搬家，这里只保留引用 + 兼容导出。
 */
export { isTestAccount, isDeveloperAccount };

/**
 * 运营端：注册用户列表（真实用户 + 测试账户分栏）+ 游客汇总 + 网站统计
 * GET /api/payment/admin/users?token=xxx
 */
router.get('/users', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const quotaUsers = new Map(quotaStore.listAll().map(u => [u.userId, u]));
  const allAccounts = accountStore.listAll() || [];
  const accounts = allAccounts.filter(a => !isDeveloperAccount(a));

  const { usageStore } = await import('../services/usage.js');
  const activityMap = new Map(
    (await import('../services/activity.js')).activityStore.listAll().map(a => [a.userId, a])
  );
  // 行为兜底：埋点上线前的老用户用已有持久化会话估算真实次数（与 /activity 一致）
  const memoryStorage = (await import('../storage/memory.js')).default;
  const roleplaySessionStore = (await import('../services/roleplaySessions.js')).roleplaySessionStore;
  const chatUserByUser = new Map<string, number>();
  const structByUser = new Map<string, number>();
  for (const s of memoryStorage.getActiveSessions()) {
    if (!s.userId) continue;
    if (s.emotionAnalysis) structByUser.set(s.userId, (structByUser.get(s.userId) || 0) + 1);
    const n = (s.chatMessages || []).filter(m => m.role === 'user').length;
    if (n > 0) chatUserByUser.set(s.userId, (chatUserByUser.get(s.userId) || 0) + n);
  }
  const rpUserByUser = new Map<string, number>();
  for (const rec of roleplaySessionStore.listAll()) {
    const n = (rec.messages || []).filter(m => m.role === 'user').length;
    if (n > 0) rpUserByUser.set(rec.userId, (rpUserByUser.get(rec.userId) || 0) + n);
  }

  // 到期口径只取一次时间戳：同一行内「会员中 / 剩余天数 / 已过期」必须一致，不各算一次 Date.now()
  const now = Date.now();

  /** 🎭 徽章「今日」列（全量口径页也要显示，见 todayRoleplayByUser 注释） */
  const rpTodayMap = await todayRoleplayByUser();
  /** 📣 邀请归因（一次请求只建一次 Map；口径见 inviteAttributionMap 注释） */
  const inviterAttr = inviteAttributionMap();

  const makeRow = (acc: any) => {
    const q = quotaUsers.get(acc.userId);
    const u = usageStore.get(acc.userId);
    const act = activityMap.get(acc.userId);
    // 累计剧情轮次（计数为 0 时用会话兜底，避免老用户显示 0 与实际不符）；徽章「今日/累计」两个口径共用它
    const rpLifetime = (act?.roleplayCount ?? 0) > 0 ? (act?.roleplayCount ?? 0) : (rpUserByUser.get(acc.userId) || 0);
    return {
      userId: acc.userId,
      name: acc.username || acc.phone || acc.email.split('@')[0],
      username: acc.username || null,
      phone: acc.phone || null,
      email: acc.email,
      freeUsed: q?.freeUsed ?? 0,
      bonusFree: q?.bonusFree ?? 0,
      unlockUntil: q?.unlockUntil ?? null,
      unlocked: !!q?.unlockUntil && q.unlockUntil > now,
      plan: q ? quotaStore.getPlan(q) : 'free',
      // 💳 额度总览（可用/已用/所有池）：口径统一由 quotaStore.describeQuota 给，控制台不再自己拼
      // （只在确实有配额记录时才取，避免给没有记录的用户凭空建一条）
      quota: q ? quotaStore.describeQuota(acc.userId) : null,
      // 「会员到期」列：会员有效期 / Pro 体验期 / 已过期 / 永久 / 从未开通（口径见 expiryFieldsOf）
      ...expiryFieldsOf(q, now),
      isTest: isTestAccount(acc), // 测试账号标记（前端标黄）
      createdAt: acc.createdAt,
      apiRequests: u?.requests ?? 0,
      apiTokens: ((u?.promptTokens ?? 0) + (u?.completionTokens ?? 0) + (u?.cachedTokens ?? 0)),
      apiCost: u?.cost ?? 0,
      costByFeature: compactCostByFeature(usageStore.getUserFeatureBreakdown(acc.userId)),
      // 行为数据：功能使用次数 / 登录 / 最近活跃（计数为 0 时用会话兜底，避免老用户显示 0 与实际不符）
      chatCount: (act?.chatCount ?? 0) > 0 ? (act?.chatCount ?? 0) : (chatUserByUser.get(acc.userId) || 0),
      structureCount: (act?.structureCount ?? 0) > 0 ? (act?.structureCount ?? 0) : (structByUser.get(acc.userId) || 0),
      roleplayCount: rpLifetime,
      rpModes: rpModesOf(act, rpLifetime),
      // 🎭 徽章「今日/累计」双口径（C 方案）：累计=rpLifetime，今日=behavior-daily 当天桶
      roleplayToday: rpTodayMap.get(acc.userId) || 0,
      roleplayTotal: rpLifetime,
      loginCount: act?.loginCount ?? 0,
      lastLoginText: act?.lastLoginAt ? new Date(act.lastLoginAt).toLocaleString('zh-CN') : null,
      lastActiveText: act?.lastActiveAt ? new Date(act.lastActiveAt).toLocaleString('zh-CN') : null,
      // 🎟/📣 邀请（2026-09-29 用户要求「也要能看到他们是否复制了邀请链接以及是否邀请到人」）：
      //  · `inviteCopyCount/inviteCopiedAt` = **动作**（activityStore，复制过几次，不随区间变）
      //  · `inviteCount` = **结果**（quotaStore，真的拉来几个注册用户）
      //  两个口径分开返回，控制台既能看到「复制了但没人注册」的人，也能看到「拉来 N 人」的人。
      inviteCode: q?.inviteCodeUsed || null,
      invitedBy: q?.invitedBy || null,
      inviteCount: q?.inviteCount || 0,
      inviteCredits: (q?.inviteCount || 0) * INVITE_BONUS_COUNT,
      // 归因人数（含「已注册、还在等首次使用」的），见 inviteAttributionMap：只看 inviteCount 会假阴性
      inviteAttributed: Math.max(q?.inviteCount || 0, inviterAttr.attributed.get(acc.userId) || 0),
      inviteRejected: inviterAttr.rejected.get(acc.userId) || 0,
      inviteCopyCount: act?.inviteCopyCount ?? 0,
      inviteCopiedAt: act?.inviteCopiedAt ?? null,
    };
  };

  const allRows = accounts.map(makeRow);
  const testers = allRows.filter(r => isTestAccount(r));
  const users = allRows.filter(r => !isTestAccount(r));
  // 游客合并为一栏（未注册账户的所有设备用户汇总；开发者账号也算已注册，避免其用量被当作游客）
  // 系统行（无 userId 的运营内部调用：运营 AI / 皮肤风格 / Instagram 文案）单独一栏，不计入游客
  const accountIds = new Set(allAccounts.map(a => a.userId));
  const guestUsages = usageStore.listAll().filter(u => !accountIds.has(u.userId) && u.userId !== SYSTEM_USER_ID);
  let guestRow: any = null;
  if (guestUsages.length > 0) {
    const totalRequests = guestUsages.reduce((s, u) => s + u.requests, 0);
    const totalTokens = guestUsages.reduce((s, u) => s + u.promptTokens + u.completionTokens + u.cachedTokens, 0);
    const totalCost = guestUsages.reduce((s, u) => s + u.cost, 0);
    const firstCreated = Math.min(...guestUsages.map(u => u.lastUsed || Date.now()));
    guestRow = {
      userId: 'GUESTS_AGGREGATED',
      kind: 'guest',
      name: `游客（${guestUsages.length} 个设备）`,
      username: null,
      phone: null,
      email: null,
      freeUsed: 0,
      bonusFree: 0,
      unlockUntil: null,
      unlocked: false,
      createdAt: firstCreated,
      apiRequests: totalRequests,
      apiTokens: Math.round(totalTokens),
      apiCost: Math.round(totalCost * 10000) / 10000,
      costByFeature: compactCostByFeature(guestUsages.reduce((acc, u) => {
        for (const [k, b] of Object.entries(usageStore.getUserFeatureBreakdown(u.userId))) {
          const cur = acc[k] || (acc[k] = { cost: 0, requests: 0, images: 0 });
          cur.cost += b.cost || 0; cur.requests += b.requests || 0; cur.images += b.images || 0;
        }
        return acc;
      }, {} as Record<string, { cost: number; requests: number; images: number }>)),
    };
  }

  // 系统/后台行：无 userId 的运营内部调用（运营 AI 分析、皮肤风格扩写、Instagram 文案）
  let systemRow: any = null;
  {
    const su = usageStore.get(SYSTEM_USER_ID);
    if (su && (su.requests > 0 || su.cost > 0)) {
      systemRow = {
        userId: SYSTEM_USER_ID,
        kind: 'system',
        name: '系统 / 后台（非用户发起）',
        username: null,
        phone: null,
        email: null,
        freeUsed: 0,
        bonusFree: 0,
        unlockUntil: null,
        unlocked: false,
        createdAt: su.lastUsed || Date.now(),
        apiRequests: su.requests,
        apiTokens: su.promptTokens + su.completionTokens + su.cachedTokens,
        apiCost: Math.round(su.cost * 10000) / 10000,
        costByFeature: compactCostByFeature(usageStore.getUserFeatureBreakdown(SYSTEM_USER_ID)),
      };
    }
  }

  users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  testers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const { visitStore } = await import('../services/visits.js');
  const stats = {
    total: users.length,               // 注册用户数（不含测试账户）
    unlocked: users.filter(r => r.unlocked).length, // 已解锁注册用户数
    visits: visitStore.getVisitCount(), // 累计独立访客数
    apiCost: usageStore.totalCost(),  // 全部 API 成本（元）
    apiRequests: usageStore.listAll().reduce((s, u) => s + u.requests, 0),
  };

  const fmt = (r: any) => ({
    ...r,
    createdAt: r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '-',
    unlockUntilText: r.unlockUntil ? new Date(r.unlockUntil).toLocaleString('zh-CN') : null,
    // 「会员到期」列显示的到期时间（会员有效期 / Pro 体验期；无到期为 null）
    expiryText: r.expiryAt ? new Date(r.expiryAt).toLocaleString('zh-CN') : null,
  });

  res.json({
    success: true,
    data: {
      stats,
      users: users.map(fmt),
      testers: testers.map(fmt),
      guests: guestRow ? [fmt(guestRow)] : [],
      system: systemRow ? [fmt(systemRow)] : [],
    }
  });
});


/**
 * 运营端：来源归因报表（first-touch 渠道 → 访问设备 → 注册 → 付费用户）
 * GET /api/payment/admin/attribution?token=xxx
 *
 * 口径（对齐 `.dsh/skills/attribution`）：
 *  - 来源＝**first-touch**（用户第一次落地时的 UTM / referrer 主机）；`direct` 是垃圾桶
 *    （DM／群聊／截图会剥掉 referrer），它的占比本身就是结论，不是「没有来源」；
 *  - 付费用户＝订单 `status==='unlocked'` 且 `source!=='free'`（与 revenueStats 口径一致，免费开通不计）；
 *  - 不做多触点加权模型：先把 first-touch 与触点路径做可信，再谈模型（避免用假设冒充结论）。
 */
router.get('/attribution', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  try {
    const { attributionStore } = await import('../services/attribution.js');
    const { paymentStore } = await import('../services/payment.js');
    const paid = new Set<string>();
    for (const o of paymentStore.listAll()) {
      if (o && o.status === 'unlocked' && o.source !== 'free' && o.userId) paid.add(o.userId);
    }
    res.json({ success: true, data: attributionStore.aggregates(paid) });
  } catch (e) {
    console.warn('⚠️ [Attribution] 报表失败:', (e as Error)?.message);
    res.status(500).json({ success: false, error: '统计失败' });
  }
});

/**
 * 剧情演绎的模式明细（累计口径）：把 activity 的 `rpModes` 归一化。
 *
 * 两条兜底规则（保证「三者之和 ≡ 合计」这个不变式，控制台怎么加都不会出现负数或空格子）：
 *  1. 老用户没有 `rpModes`（明细自 2026-09-16 起才有）→ 合计整个归到「剧情扮演」；
 *  2. 明细之和 < 合计（上线前的历史轮次）→ 差额归入「剧情扮演」。
 *     ⚠️ 这是**有意为之的近似**：那部分历史里其实混着文游，只是当时没分开记，无法回溯。
 */
function rpModesOf(act: any, total: number): { roleplay: number; wenyou: number; werewolf: number } {
  const num = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
  const raw = act?.rpModes;
  const m = { roleplay: 0, wenyou: 0, werewolf: 0 };
  if (raw && typeof raw === 'object') {
    m.roleplay = num(raw.roleplay);
    m.wenyou = num(raw.wenyou);
    m.werewolf = num(raw.werewolf);
  }
  const sum = m.roleplay + m.wenyou + m.werewolf;
  const t = Math.max(0, total || 0);
  if (sum < t) m.roleplay += t - sum;
  return m;
}

/**
 * 今日（服务端本地日）各用户的剧情轮次 —— 运营端 🎭 徽章「今日/累计」双数字里的「今日」。
 *
 * 背景（2026-09-18 用户提案 C）：徽章以前**跟着视图走**（今日视图=今日轮次、累计视图=累计轮次），
 * 同一格换个视图就变数，运营端拿它和「用户记录」里的剧情条数一对就对不上。
 * 现在徽章统一显示 `今日/累计`：累计沿用 `activity.roleplayCount`，
 * 今日取 `behavior-daily` 当天那一桶（与区间视图同源，只是把区间取成「今天」这一天）。
 */
async function todayRoleplayByUser(): Promise<Map<string, number>> {
  const { behaviorDailyStore } = await import('../services/behaviorDaily.js');
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sum = behaviorDailyStore.getRangeSummary(key, key);
  return new Map<string, number>(sum.users.map((u: any) => [u.userId, u.roleplay || 0]));
}

/**
 * 剧情演绎的模式明细（区间口径）：按日日志里 `roleplay` 是**合计桶**、`wenyou`/`werewolf` 是模式桶，
 * 所以「剧情扮演 = 合计 − 文游 − 狼人杀」（历史日期的差额自然落回剧情扮演）。
 */
function rpModesFromDaily(bd: any): { roleplay: number; wenyou: number; werewolf: number } {
  const num = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
  const wenyou = num(bd?.wenyou);
  const werewolf = num(bd?.werewolf);
  const total = num(bd?.roleplay);
  return { roleplay: Math.max(0, total - wenyou - werewolf), wenyou, werewolf };
}

/**
 * 运营端：用户行为分析（功能使用计数 + 登录记录 + 活跃度/流失 + 最近聊天摘要）
 * GET /api/payment/admin/activity?token=xxx
 */
router.get('/activity', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  try {
    const { activityStore } = await import('../services/activity.js');
    const { roleplaySessionStore } = await import('../services/roleplaySessions.js');
    const memoryStorage = (await import('../storage/memory.js')).default;
    const { usageStore } = await import('../services/usage.js');
    const { usageTimeStore } = await import('../services/usageTime.js');
    const { lookupIp } = await import('../services/geo.js');
    // 「剧情演绎」三模式的两份旁证数据（详情卡用）：文游进度 + 狼人杀台账（都只取元信息）
    const { wenyouSavesStore } = await import('../services/wenyouSaves.js');
    const { werewolfLedger } = await import('../services/werewolfLedger.js');
    const { resolveRoleplayTitle, resolveWenyouTitle } = await import('../services/scenarioTitle.js');
    const wwByUser = new Map(werewolfLedger.userSummaries().map(s => [s.userId, s]));
    /** 📣 邀请归因（一次请求只建一次 Map；口径见 inviteAttributionMap 注释） */
    const inviterAttr = inviteAttributionMap();
    /** 文游进度摘要：进行中剧本（解析成标题）+ 结局数 + 存档数；**不读正文**（控制台不需要，也避免把私密内容带出来） */
    const wenyouBriefOf = (userId: string) => {
      const p = wenyouSavesStore.get(userId);
      if (!p) return null;
      return {
        at: p.updatedAt || 0,
        games: Object.keys(p.games || {}).map(id => {
          const r = resolveWenyouTitle(id, userId);
          return { id, title: r.title, customScenario: r.custom };
        }),
        endings: Object.keys(p.endings || {}).length,
        slots: Array.isArray(p.slots) ? p.slots.length : 0,
      };
    };
    const quotaUsers = new Map(quotaStore.listAll().map(u => [u.userId, u]));
    const allAccounts = accountStore.listAll() || [];
    const accounts = allAccounts.filter(a => !isDeveloperAccount(a));
    const now = Date.now();

    // —— 区间参数（可选，控制台「用户行为」按时间整页联动用）：from/to 成对，或单个 + days 兜底（仿 /usage-time）——
    let from = String(req.query?.from || '');
    let to = String(req.query?.to || '');
    const rangeRequested = !!(from || to);
    if (rangeRequested) {
      if (!from || !to) {
        let days = Number(req.query?.days) || 30;
        days = Math.min(3650, Math.max(1, days));
        const start = new Date();
        start.setDate(start.getDate() - (days - 1));
        if (!from) from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
        if (!to) {
          const nd = new Date(now);
          to = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
        }
      }
      if (!isValidYmd(from) || !isValidYmd(to)) {
        res.status(400).json({ success: false, error: '日期格式应为 YYYY-MM-DD（需为真实日期）' });
        return;
      }
    }

    // —— 每日打卡统计（跟随整页时间跨度：全部时间=不限，区间=from~to 内发生量）——
    // 口径与「用户行为」主表一致：排除测试/开发者账号；游客设备若有打卡同样计入「打卡用户」。
    const { diaryStore } = await import('../services/diary.js');
    const excludedAccountIds = new Set(
      allAccounts.filter(a => isDeveloperAccount(a) || isTestAccount(a)).map(a => a.userId)
    );
    const checkin = diaryStore.checkinStats(from || undefined, to || undefined, excludedAccountIds);
    // 逐用户打卡计数（供「用户行为」每行展示与统计卡下钻定位具体用户）
    const checkinAll = diaryStore.checkinByUser(undefined, undefined, excludedAccountIds);
    const checkinRange = diaryStore.checkinByUser(from || undefined, to || undefined, excludedAccountIds);
    // 逐用户打卡日期（供「打卡次数」下钻逐条展示同用户的多天打卡）
    const checkinAllDates = diaryStore.checkinDatesByUser(undefined, undefined, excludedAccountIds);
    const checkinRangeDates = diaryStore.checkinDatesByUser(from || undefined, to || undefined, excludedAccountIds);

    // 最近「聊一聊」摘要：取 chatUpdatedAt 最新的会话 + 最近几条消息（过滤掉理一理会话：理一理带 emotionAnalysis）
    const chatByUser = new Map<string, { title: string; preview: { role: string; content: string; image: boolean }[]; at: number }>();
    for (const s of memoryStorage.getActiveSessions()) {
      if (!s.userId || s.emotionAnalysis || !s.chatMessages || s.chatMessages.length === 0) continue;
      const at = s.chatUpdatedAt ? new Date(s.chatUpdatedAt).getTime() : new Date(s.updatedAt).getTime();
      const cur = chatByUser.get(s.userId);
      if (!cur || at > cur.at) {
        chatByUser.set(s.userId, {
          title: s.chatTitle || '',
          preview: s.chatMessages.slice(-6).map(m => ({
            role: m.role,
            content: (m.content || (m.image ? '[图片]' : '')).slice(0, 120),
            image: !!m.image,
          })),
          at,
        });
      }
    }
    // 最近「理一理」：取用户的原始输入（rawInput）+ 情绪分析结果（小愈输出），按会话更新序取最新一次
    const structRecByUser = new Map<string, { rawInput: string; emotion: string; intensity: number; analysis: string; at: number }>();
    for (const s of memoryStorage.getActiveSessions()) {
      if (!s.userId || !s.emotionAnalysis) continue;
      const at = new Date(s.updatedAt).getTime();
      const cur = structRecByUser.get(s.userId);
      if (!cur || at > cur.at) {
        structRecByUser.set(s.userId, {
          rawInput: (s.rawInput || '').slice(0, 200),
          emotion: s.emotionAnalysis.emotion || '',
          intensity: s.emotionAnalysis.intensity ?? 0,
          analysis: (s.emotionAnalysis.analysis || '').slice(0, 200),
          at,
        });
      }
    }

    // 最近剧情会话（按用户取 updatedAt 最新的剧本）；带用户最近发言，供运营判断剧情偏好
    const rpByUser = new Map<string, { scenarioId: string; scenarioTitle: string; customScenario: boolean; scenarioDeleted: boolean; at: number; preview: { role: string; content: string }[] }>();
    for (const rec of roleplaySessionStore.listAll()) {
      const cur = rpByUser.get(rec.userId);
      if (!cur || rec.updatedAt > cur.at) {
        // 自建剧本显示用户自己起的剧名 + 「自建」标志（解析不到时回退会话标题快照；剧本被删另标「已删」）
        const resolved = resolveRoleplayTitle(rec.scenarioId, rec.userId, 'zh', rec.scenarioTitle);
        rpByUser.set(rec.userId, {
          scenarioId: rec.scenarioId,
          scenarioTitle: resolved.title,
          customScenario: resolved.custom,
          scenarioDeleted: resolved.deleted,
          at: rec.updatedAt,
          preview: (rec.messages || []).filter(m => m.role === 'user').slice(-2).map(m => ({
            role: 'user',
            content: (m.content || '').slice(0, 200),
          })),
        });
      }
    }

    // 行为兜底：埋点上线前的老用户，用已有持久化会话估算真实次数（避免「共 0 次但有记录」的矛盾显示）
    const chatUserByUser = new Map<string, number>();
    const structByUser = new Map<string, number>();
    for (const s of memoryStorage.getActiveSessions()) {
      if (!s.userId) continue;
      if (s.emotionAnalysis) structByUser.set(s.userId, (structByUser.get(s.userId) || 0) + 1);
      const n = (s.chatMessages || []).filter(m => m.role === 'user').length;
      if (n > 0) chatUserByUser.set(s.userId, (chatUserByUser.get(s.userId) || 0) + n);
    }
    const rpUserByUser = new Map<string, number>();
    for (const rec of roleplaySessionStore.listAll()) {
      const n = (rec.messages || []).filter(m => m.role === 'user').length;
      if (n > 0) rpUserByUser.set(rec.userId, (rpUserByUser.get(rec.userId) || 0) + n);
    }

    // 流失分桶：活跃(<3天) / 冷淡(3-7天) / 风险(7-30天) / 流失(>30天) / 从未活跃
    const churnOf = (last: number | null | undefined): string => {
      if (!last) return 'never';
      const days = (now - last) / 86400000;
      if (days <= 3) return 'active';
      if (days <= 7) return 'week';
      if (days <= 30) return 'month';
      return 'churned';
    };

    // 地区 IP 合并：解析某用户最近一次出现（登录/使用）的 IP 地区，供「用户行为」每行同屏展示
    const geoOf = (act: any): { ip: string; country: string; region: string; city: string; isp: string } | null => {
      const latestLogin = (act?.logins || []).filter((l: any) => l?.ip).sort((x: any, y: any) => (y.at || 0) - (x.at || 0))[0] as { ip?: string; country?: string } | undefined;
      const ip = latestLogin?.ip || act?.lastIp;
      const countryCode = latestLogin?.country || act?.lastCountry;
      if (!ip) return null;
      const g = lookupIp(ip, countryCode);
      if (g.isPrivate) return null;
      return {
        ip,
        country: g.country === '未知' ? '未知/未识别' : g.country,
        region: g.region,
        city: g.city,
        isp: g.isp,
      };
    };

    /** 🎭 徽章「今日」列（活动页的「今日/累计」双口径，见 todayRoleplayByUser 注释） */
    const rpTodayMap = await todayRoleplayByUser();

    // 该用户点赞过的剧情（显示「点了哪个剧情」）：scenarioId → 真实剧名（自建带「自建」，剧本被删带「已删」）
    const likedScenariosOf = (userId: string): { id: string; title: string; customScenario: boolean; scenarioDeleted: boolean }[] =>
      roleplayLikeStore.getUserLikeScenarioIds(userId).map((id) => {
        const r = resolveRoleplayTitle(id, userId, 'zh');
        return { id, title: r.title, customScenario: r.custom, scenarioDeleted: r.deleted };
      });

    const makeRow = (acc: any) => {
      const act = activityStore.get(acc.userId);
      const q = quotaUsers.get(acc.userId);
      // 邀请人账号（详情卡把 invitedBy 的原始 userId 翻成可读的名字/邮箱；游客推广人查不到账号则为 null）
      const inviteeInviterAcc = q?.invitedBy ? accountStore.getById(q.invitedBy) : null;
      const usageLast = usageStore.get(acc.userId)?.lastUsed;
      const lastActiveAt = act?.lastActiveAt ?? usageLast ?? (acc.createdAt ? new Date(acc.createdAt).getTime() : 0);
      const geo = geoOf(act);
      const rpTotal = (act?.roleplayCount ?? 0) > 0 ? (act?.roleplayCount ?? 0) : (rpUserByUser.get(acc.userId) || 0);
      return {
        userId: acc.userId,
        name: acc.username || acc.phone || acc.email.split('@')[0],
        email: acc.email,
        phone: acc.phone || null,
        plan: q ? quotaStore.getPlan(q) : 'free',
        unlocked: !!q?.unlockUntil && q.unlockUntil > Date.now(),
        // 🎫 会员状态（2026-09-28）：控制台「统计卡下钻」列表与「用户行为」详情卡要一眼看出
        //   「这个人是不是会员」——口径与「用户」页/CSV 导出**同源**（expiryFieldsOf）：
        //   expiryKind = lifetime 永久 / membership 在期 / trial 仅 Pro 体验 / expired 已过期 / none 从未开通。
        //   注意：`trial` 必须与「Pro 会员」区分开（用户页早就这么分，见 admin.html 的会员徽章注释）。
        ...expiryFieldsOf(q, now),
        // 💳 额度总览（用户行为页也要看得到每个人的可用/已用；口径与「用户」页同源＝describeQuota）
        quota: q ? quotaStore.describeQuota(acc.userId) : null,
        isTest: isTestAccount(acc),
        createdAt: acc.createdAt ? new Date(acc.createdAt).getTime() : 0,
        chatCount: (act?.chatCount ?? 0) > 0 ? (act?.chatCount ?? 0) : (chatUserByUser.get(acc.userId) || 0),
        structureCount: (act?.structureCount ?? 0) > 0 ? (act?.structureCount ?? 0) : (structByUser.get(acc.userId) || 0),
        roleplayCount: rpTotal,
        // 剧情演绎的模式明细（角色剧情扮演 / AI 文游 / AI 狼人杀）——「玩的是哪一个」看这三项
        rpModes: rpModesOf(act, rpTotal),
        // 🎭 徽章「今日/累计」双口径（C 方案，2026-09-18）：累计=rpTotal，今日=behavior-daily 当天桶。
        // 两个字段固定不变，行上的数字不再跟着「今日/区间/累计」视图跳（区间值仍在上面的 roleplayCount 里）。
        roleplayToday: rpTodayMap.get(acc.userId) || 0,
        roleplayTotal: rpTotal,
        lastRoleplayMode: act?.lastMode ?? null,
        // 当前皮肤（自皮肤上报上线起累计；未上报为 null）+ 剧情点赞（是否点过赞 + 点赞数）
        skin: skinUsageStore.get(acc.userId)?.skin ?? null,
        // 邀请信息：注册时用的预设邀请码（q.inviteCodeUsed）+ 邀请人（ref= 分享链接，q.invitedBy）
        inviteCode: q?.inviteCodeUsed || null,
        invitedBy: q?.invitedBy || null,
        // 📣 邀请推广（2026-09-18）：详情卡要能直接读出「是谁的链接带进来的」+「本人拉了多少人、赚了多少额度」——
        // 此前只显示一串 userId，看不出是哪个用户；`inviteCount` 为 0 表示没成功邀请过（归因 ≠ 已发放奖励）。
        inviterName: inviteeInviterAcc ? (inviteeInviterAcc.username || (inviteeInviterAcc.email || '').split('@')[0]) : null,
        inviterEmail: inviteeInviterAcc?.email || null,
        inviteCount: q?.inviteCount || 0,
        inviteCredits: (q?.inviteCount || 0) * INVITE_BONUS_COUNT,
        inviteBonus: INVITE_BONUS_COUNT,
        // 📣 归因人数（含「已注册、还在等首次使用」）与「被反套利拦下」的记录数——
        // 只看 inviteCount（已结算）会把「有人注册但还没开口」的邀请人显示成「没邀请到人」
        inviteAttributed: Math.max(q?.inviteCount || 0, inviterAttr.attributed.get(acc.userId) || 0),
        inviteRejected: inviterAttr.rejected.get(acc.userId) || 0,
        // 📤 是否复制过专属邀请链接（动作口径；与上面的邀请结果口径分开）
        inviteCopyCount: act?.inviteCopyCount ?? 0,
        inviteCopiedAt: act?.inviteCopiedAt ?? null,
        likeCount: roleplayLikeStore.getUserLikeCount(acc.userId),
        likedStory: roleplayLikeStore.getUserLikeCount(acc.userId) > 0,
        likedScenarios: likedScenariosOf(acc.userId),
        checkinCount: (checkinAll.get(acc.userId) || { count: 0 }).count,
        checkinDates: checkinAllDates.get(acc.userId) || [],
        installCount: act?.installCount ?? 0,
        installedAt: act?.installedAt ?? null,
        loginCount: act?.loginCount ?? 0,
        lastLoginAt: act?.lastLoginAt ?? null,
        lastLoginMethod: act?.lastLoginMethod ?? null,
        logins: (act?.logins ?? []).slice(-10),
        lastActiveAt,
        lastFeature: act?.lastFeature ?? null,
        churn: churnOf(lastActiveAt),
        lastChat: chatByUser.get(acc.userId) ?? null,
        lastStruct: structRecByUser.get(acc.userId) ?? null,
        lastRoleplay: rpByUser.get(acc.userId) ?? null,
        // 文游进度与狼人杀台账（详情卡「他玩的是哪一个」的旁证；狼人杀局数与页签同源）
        lastWenyou: wenyouBriefOf(acc.userId),
        werewolf: wwByUser.get(acc.userId) ?? null,
        usageSeconds: usageTimeStore.getUserLifetime(acc.userId),
        // 地区 IP 合并：该用户最近一次出现（登录/使用）的 IP 与地区
        ip: geo?.ip || '',
        country: geo?.country || '',
        region: geo?.region || '',
        city: geo?.city || '',
        isp: geo?.isp || '',
      };
    };

    const allRows = accounts.map(makeRow);
    const users = allRows.filter(r => !r.isTest).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const testers = allRows.filter(r => r.isTest).sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // 游客行为（未注册设备）：所有游客 id（activity + 有会话的）全部纳入，作完整行为分析
    const accountIds = new Set(allAccounts.map(a => a.userId));
    const guestIdSet = new Set<string>();
    for (const a of activityStore.listAll()) if (!accountIds.has(a.userId)) guestIdSet.add(a.userId);
    for (const s of memoryStorage.getActiveSessions()) if (s.userId && !accountIds.has(s.userId)) guestIdSet.add(s.userId);
    for (const rec of roleplaySessionStore.listAll()) if (!accountIds.has(rec.userId)) guestIdSet.add(rec.userId);
    // 打卡用户的游客设备纳入（仅打卡、无其他功能/会话/剧情的设备也要出现在游客列表，供统计卡下钻定位）
    for (const id of checkinAll.keys()) if (!accountIds.has(id)) guestIdSet.add(id);
    const guests = Array.from(guestIdSet).map(id => {
      const act = activityStore.get(id);
      const usageLast = usageStore.get(id)?.lastUsed;
      const chatAt = chatByUser.get(id)?.at || 0;
      const rpAt = rpByUser.get(id)?.at || 0;
      const lastActiveAt = (act?.lastActiveAt ?? usageLast ?? Math.max(chatAt, rpAt)) || 0;
      const chat = (act?.chatCount ?? 0) > 0 ? (act?.chatCount ?? 0) : (chatUserByUser.get(id) || 0);
      const struct = (act?.structureCount ?? 0) > 0 ? (act?.structureCount ?? 0) : (structByUser.get(id) || 0);
      const rp = (act?.roleplayCount ?? 0) > 0 ? (act?.roleplayCount ?? 0) : (rpUserByUser.get(id) || 0);
      const geo = geoOf(act);
      return {
        userId: id,
        device: id.slice(0, 12) + '…',
        firstSeenAt: act?.firstSeenAt ?? null,
        chatCount: chat,
        structureCount: struct,
        roleplayCount: rp,
        rpModes: rpModesOf(act, rp),
        lastRoleplayMode: act?.lastMode ?? null,
        // 当前皮肤 + 剧情点赞（游客设备同样支持皮肤上报与点赞）
        skin: skinUsageStore.get(id)?.skin ?? null,
        likeCount: roleplayLikeStore.getUserLikeCount(id),
        likedStory: roleplayLikeStore.getUserLikeCount(id) > 0,
        likedScenarios: likedScenariosOf(id),
        checkinCount: (checkinAll.get(id) || { count: 0 }).count,
        checkinDates: checkinAllDates.get(id) || [],
        installCount: act?.installCount ?? 0,
        installedAt: act?.installedAt ?? null,
        // 游客设备也能复制邀请链接（注册前先分享）；注册时 activityStore.mergeFrom 会并到账号
        inviteCopyCount: act?.inviteCopyCount ?? 0,
        inviteCopiedAt: act?.inviteCopiedAt ?? null,
        lastActiveAt,
        lastFeature: act?.lastFeature ?? null,
        churn: churnOf(lastActiveAt),
        lastChat: chatByUser.get(id) ?? null,
        lastStruct: structRecByUser.get(id) ?? null,
        lastRoleplay: rpByUser.get(id) ?? null,
        lastWenyou: wenyouBriefOf(id),
        werewolf: wwByUser.get(id) ?? null,
        usageSeconds: usageTimeStore.getUserLifetime(id),
        // 地区 IP 合并：该游客设备最近一次出现的 IP 与地区
        ip: geo?.ip || '',
        country: geo?.country || '',
        region: geo?.region || '',
        city: geo?.city || '',
        isp: geo?.isp || '',
      };
    }).filter(g => g.lastActiveAt > 0).sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const buckets = {
      active: users.filter(u => u.churn === 'active').length,
      week: users.filter(u => u.churn === 'week').length,
      month: users.filter(u => u.churn === 'month').length,
      churned: users.filter(u => u.churn === 'churned').length,
      never: users.filter(u => u.churn === 'never').length,
    };
    const totals = {
      chat: users.reduce((s, u) => s + u.chatCount, 0),
      structure: users.reduce((s, u) => s + u.structureCount, 0),
      // roleplay = 剧情演绎**合计**；wenyou/werewolf 是它的模式明细（三者之和恒等于 roleplay）
      roleplay: users.reduce((s, u) => s + u.roleplayCount, 0),
      wenyou: users.reduce((s, u) => s + (u.rpModes?.wenyou || 0), 0),
      werewolf: users.reduce((s, u) => s + (u.rpModes?.werewolf || 0), 0),
      logins: users.reduce((s, u) => s + u.loginCount, 0),
      // 累计下载/安装 Xiaoyu + 剧情点赞（口径：注册用户 + 游客设备合计）
      installs: [...users, ...guests].reduce((s, u) => s + (u.installCount || 0), 0),
      likes: [...users, ...guests].reduce((s, u) => s + (u.likeCount || 0), 0),
    };

    // —— 经典全量口径（不带 from/to）：保持原结构（buckets + 全量 totals + 全量行）——
    if (!rangeRequested) {
      res.json({
        success: true,
        data: { generatedAt: now, buckets, totals, users, testers, guests, checkinUsers: checkin.users, checkinCount: checkin.count },
      });
      return;
    }

    // —— 区间口径（from/to 给定）：整页统计按「区间内发生量」；行内附 cum=全量对象供详情弹窗 ——
    const { behaviorDailyStore } = await import('../services/behaviorDaily.js');
    const fromTs = new Date(from + 'T00:00:00').getTime();
    const toEndTs = new Date(to + 'T23:59:59.999').getTime();
    const tsIn = (t: number | null | undefined): boolean => !!t && t >= fromTs && t <= toEndTs;

    const bdSum = behaviorDailyStore.getRangeSummary(from, to);
    const bdById = new Map(bdSum.users.map((u: any) => [u.userId, u]));
    // 🎭 徽章「今日」列复用路由开头取好的 rpTodayMap（区间视图也固定显示「今日/累计」，不跟着视图变）
    const utSum = usageTimeStore.getRangeSummaries(from, to);
    const utById = new Map(utSum.users.map((u: any) => [u.userId, u]));

    // 区间行构建：接受经典全量行（含 lastChat/lastStruct/lastRoleplay/geo 等），
    // 顶层覆盖为区间值（表格用），cum 保留全量对象（详情弹窗用，A1：详情保持全量）。
    const toIntervalRow = (row: any) => {
      const bd = bdById.get(row.userId);
      const ut = utById.get(row.userId);
      const act = activityStore.get(row.userId);
      const chk = checkinRange.get(row.userId);
      const createdIn = tsIn(row.createdAt);
      let hasAct = false;
      let last = bd?.lastAt || 0;
      if (ut) hasAct = true;
      if (bd) hasAct = true;
      if (tsIn(row.lastActiveAt)) { hasAct = true; if ((row.lastActiveAt || 0) > last) last = row.lastActiveAt; }
      if (act) {
        for (const l of act.logins || []) if (tsIn(l.at)) { hasAct = true; if (l.at > last) last = l.at; }
        for (const it of act.recentActivity || []) if (tsIn(it.at)) { hasAct = true; if (it.at > last) last = it.at; }
        if (tsIn(act.installedAt)) { hasAct = true; if ((act.installedAt || 0) > last) last = act.installedAt; }
      }
      // 区间内打过卡的用户同样视为区间活跃（支持「每日打卡」统计卡下钻定位）
      if (chk) { hasAct = true; if (chk.lastAt > last) last = chk.lastAt; }
      if (createdIn && !hasAct) last = Math.max(last, row.createdAt || 0);
      if (!createdIn && !hasAct) return null; // 既非区间注册、又无区间活跃 → 不在区间视图出现
      return {
        ...row,
        // —— 区间计数（表格「行为/登录/点赞/下载」列与统计卡）——
        chatCount: bd?.chat || 0,
        structureCount: bd?.structure || 0,
        roleplayCount: bd?.roleplay || 0,
        rpModes: rpModesFromDaily(bd), // 区间口径的模式明细（合计 − 文游 − 狼人杀 = 剧情扮演）
        // 🎭 徽章「今日/累计」（C 方案）：与视图无关的两个固定口径；
        // 视图区间值仍在 roleplayCount 里（详情弹窗/统计卡用），行上不再显示它，避免同一格三义
        roleplayToday: rpTodayMap.get(row.userId) || 0,
        roleplayTotal: (act?.roleplayCount ?? 0) > 0 ? (act?.roleplayCount ?? 0) : (rpUserByUser.get(row.userId) || 0),
        lastRoleplayMode: act?.lastMode ?? null,
        loginCount: bd?.login || 0,
        likeCount: bd?.likes || 0,
        likedStory: (bd?.likes || 0) > 0,
        likedScenarios: [], // 区间口径不逐剧本追踪；详情弹窗用 cum.likedScenarios
        installCount: bd?.install || 0,
        installedAt: null,   // 区间内不精确到安装时刻；详情弹窗用 cum.installedAt
        checkinCount: chk ? chk.count : 0,
        checkinDates: checkinRangeDates.get(row.userId) || [],
        usageSeconds: ut?.seconds || 0,
        lastActiveAt: last,  // 区间最后活跃（表格）；详情弹窗用 cum.lastActiveAt
        lastLoginAt: null,   // 区间登录时刻不精确；登录次数见 loginCount
        _rangeActive: hasAct,
        cum: row,            // 全量对象（累计计数 + 最近聊天/登录/剧情/地区，详情弹窗展示）
      };
    };

    const rangeUsers = users
      .map(toIntervalRow)
      .filter((r: any) => !!r)
      .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    const rangeTesters = testers
      .map(toIntervalRow)
      .filter((r: any) => !!r)
      .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    const rangeGuests = guests
      .map(toIntervalRow)
      .filter((r: any) => !!r)
      .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    // 游客候选集补充：只有「使用时长心跳」、没有功能/会话/剧情记录的游客（经典视图从活动/会话聚合，
    // 不含仅心跳者；区间活跃游客/区间使用口径应纳入这类设备，否则与 ⏱ 区间活跃不一致）
    const accountIdSet = new Set(allAccounts.map(a => a.userId));
    const coveredGuestIds = new Set(rangeGuests.map((g: any) => g.userId));
    const extraGuestIds = Array.from(
      new Set([...bdSum.users.map((u: any) => u.userId), ...utSum.users.map((u: any) => u.userId), ...checkinRange.keys()])
    ).filter(id => !accountIdSet.has(id) && !coveredGuestIds.has(id));
    for (const id of extraGuestIds) {
      const bd = bdById.get(id);
      const ut = utById.get(id);
      const chk = checkinRange.get(id);
      rangeGuests.push({
        userId: id,
        device: String(id).slice(0, 12) + '…',
        firstSeenAt: null,
        chatCount: bd?.chat || 0,
        structureCount: bd?.structure || 0,
        roleplayCount: bd?.roleplay || 0,
        rpModes: rpModesFromDaily(bd),
        // 🎭 徽章「今日/累计」（游客同样显示两个口径；累计取 activity，老数据没有则 0）
        roleplayToday: rpTodayMap.get(id) || 0,
        roleplayTotal: activityStore.get(id)?.roleplayCount ?? 0,
        lastRoleplayMode: null,
        skin: null,
        likeCount: bd?.likes || 0,
        likedStory: (bd?.likes || 0) > 0,
        likedScenarios: [],
        installCount: bd?.install || 0,
        installedAt: null,
        lastActiveAt: Math.max(bd?.lastAt || 0, chk?.lastAt || 0),
        lastFeature: null,
        churn: 'never',
        lastChat: null,
        lastStruct: null,
        lastRoleplay: null,
        usageSeconds: ut?.seconds || 0,
        checkinCount: chk ? chk.count : 0,
        checkinDates: checkinRangeDates.get(id) || [],
        ip: '',
        country: '',
        region: '',
        city: '',
        isp: '',
        _rangeActive: true,
        cum: {
          userId: id,
          firstSeenAt: null,
          lastActiveAt: 0,
          chatCount: 0,
          structureCount: 0,
          roleplayCount: 0,
          installCount: 0,
          likeCount: 0,
          // 邀请复制是**累计**口径（没有按日事件表），这里取该设备的累计值（无记录为 0/null）
          inviteCopyCount: activityStore.get(id)?.inviteCopyCount ?? 0,
          inviteCopiedAt: activityStore.get(id)?.inviteCopiedAt ?? null,
          likedScenarios: [],
          logins: [],
          lastChat: null,
          lastStruct: null,
          lastRoleplay: null,
          lastWenyou: null,
          werewolf: null,
          usageSeconds: usageTimeStore.getUserLifetime(id),
          country: '',
          region: '',
          city: '',
        },
      });
    }
    rangeGuests.sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    const registered = rangeUsers.filter((r: any) => tsIn(r.createdAt)).length;
    const activeUsers = rangeUsers.filter((r: any) => r._rangeActive).length;
    const rangeTotals = {
      chat: rangeUsers.reduce((s: number, u: any) => s + (u.chatCount || 0), 0),
      structure: rangeUsers.reduce((s: number, u: any) => s + (u.structureCount || 0), 0),
      // 区间口径：roleplay = 剧情演绎合计，wenyou/werewolf 是它的模式明细
      roleplay: rangeUsers.reduce((s: number, u: any) => s + (u.roleplayCount || 0), 0),
      wenyou: rangeUsers.reduce((s: number, u: any) => s + (u.rpModes?.wenyou || 0), 0),
      werewolf: rangeUsers.reduce((s: number, u: any) => s + (u.rpModes?.werewolf || 0), 0),
      logins: rangeUsers.reduce((s: number, u: any) => s + (u.loginCount || 0), 0),
      // 下载/点赞：注册用户 + 游客设备合计（与经典口径一致）
      installs: [...rangeUsers, ...rangeGuests].reduce((s: number, u: any) => s + (u.installCount || 0), 0),
      likes: [...rangeUsers, ...rangeGuests].reduce((s: number, u: any) => s + (u.likeCount || 0), 0),
    };

    res.json({
      success: true,
      data: {
        generatedAt: now,
        mode: 'range',
        range: { from, to },
        registered,
        registeredTesters: rangeTesters.filter((r: any) => tsIn(r.createdAt)).length,
        activeUsers,
        activeGuests: rangeGuests.length,
        totals: rangeTotals,
        checkinUsers: checkin.users,
        checkinCount: checkin.count,
        users: rangeUsers,
        testers: rangeTesters,
        guests: rangeGuests,
      },
    });
  } catch (error) {
    console.error('Activity report error:', error);
    res.status(500).json({ success: false, error: '生成用户行为报告失败' });
  }
});

/**
 * 运营端：手动为用户开通（等级可指定）
 * POST /api/payment/admin/users/:userId/unlock?token=xxx&days=30&plan=plus|pro
 */
router.post('/users/:userId/unlock', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  // 2026-09-29 审查 A1-P2：Number('abc') = NaN，Math.max(1, NaN) = NaN → unlockUntil 被写成 NaN →
  // JSON 里落成 null，而 base 取的是用户**原有**到期时间，等于把已付的剩余天数直接抹掉。
  // 必须显式校验成有限整数并夹到 1..365；非法值退回默认 30（与 create-checkout 的夹取口径一致）。
  const daysRaw = Number(req.query?.days ?? 30);
  const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.trunc(daysRaw))) : 30;
  const plan = String(req.query?.plan || 'plus') === 'pro' ? 'pro' : 'plus';
  const userId = String(req.params.userId);

  // 发信口径要在 unlock 之前取：开通前是否已是有效会员 → 决定邮件用「已开通」还是「已续期」措辞
  const before = quotaStore.getRecord(userId);
  const wasActiveMember = !!before && quotaStore.isUnlocked(before);

  const unlockUntil = quotaStore.unlock(userId, days, plan);

  // 邮件里的档位取**实际生效档位**（unlock 有「续费不降级」：给 Pro/终身用户开 Plus 时仍保持原档，
  // 不能告诉用户「Plus 已开通」）。用记录里的 plan 字段而非 getPlan：后者会把 7 天 Pro 试用也算成 pro。
  const storedPlan = quotaStore.getRecord(userId)?.plan;
  const effectivePlan: 'plus' | 'pro' = storedPlan === 'pro' || storedPlan === 'lifetime' ? 'pro' : 'plus';

  // 记录一条审计订单（标记为免费开通，不计入收入）
  const auditOrder = paymentStore.createOrder(userId);
  if (auditOrder) {
    paymentStore.markFree(auditOrder.orderId);
    paymentStore.markUnlocked(auditOrder.orderId, unlockUntil);
  }
  const acc = accountStore.getById(userId);
  const who = acc ? (isTestAccount(acc) ? 'test account' : acc.email) : userId.slice(0, 8);
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('manual_unlock', `手动开通：${who} + ${days} 天`, req.ip || '');

  /*
   * 会员开通邮件（2026-09-18）：手动开通以前是静默的——用户那边一封邮件都没有，只能自己登录才发现。
   * 这里给用户本人发一封；sendEmail 的 MAIL_BCC（本机 .env = myxiaoyu2026@gmail.com）会**自动抄送一份给运营**，
   * 所以运营每次手动开通都能在自己邮箱看到这封邮件。
   * fire-and-forget：SMTP 慢/挂掉都**不能**卡住开通接口，也不能影响开通结果——发信结果写审计日志（控制台「审计」页可见）。
   */
  void (async () => {
    try {
      const { notifyMembershipGranted } = await import('../services/memberNotifier.js');
      const r = await notifyMembershipGranted({
        userId, requestedPlan: plan, plan: effectivePlan, days, unlockUntil, renewal: wasActiveMember,
      });
      const label = r.ok
        ? `已发送（${r.lang || '?'}${r.to ? ' → ' + r.to : ''}）`
        : r.skipped ? `未发送（${r.skipped}）` : '发送失败';
      auditStore.log('member_mail', `会员开通邮件 → ${who}：${label}${r.detail ? ' · ' + r.detail : ''}`, req.ip || '');
      if (!r.ok) console.warn('[MemberMail] 会员开通邮件未发出:', who, r.skipped || r.detail);
    } catch (e) {
      auditStore.log('member_mail', `会员开通邮件 → ${who}：异常 ${(e as Error)?.message}`, req.ip || '');
      console.warn('[MemberMail] 会员开通邮件异常:', (e as Error)?.message);
    }
  })();

  res.json({
    success: true,
    data: {
      userId,
      days,
      unlockUntil: new Date(unlockUntil).toLocaleString('zh-CN'),
      message: `已为用户开通 ${days} 天免费使用`,
    }
  });
});

/**
 * 运营端：调整会员等级（不改到期时间）
 * POST /api/payment/admin/users/:userId/plan?token=xxx&plan=plus|pro|free
 */
router.post('/users/:userId/plan', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const userId = String(req.params.userId);
  const raw = String(req.query?.plan || 'plus');
  const plan = raw === 'pro' ? 'pro' : raw === 'free' ? 'free' : 'plus';
  quotaStore.setPlan(userId, plan);
  const acc = accountStore.getById(userId);
  const who = acc ? (isTestAccount(acc) ? 'test account' : acc.email) : userId.slice(0, 8);
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('set_plan', `会员等级升级：${who} → ${plan}`, req.ip || '');
  res.json({
    success: true,
    data: { userId, plan, quota: quotaStore.getQuota(userId) },
    message: `会员等级已设为 ${plan}`,
  });
});

/**
 * 运营端：初始需求设置统计（陪伴方式/语言偏好分布）
 * GET /api/payment/admin/pref-stats?token=xxx
 */
router.get('/pref-stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { preferenceStore } = await import('../services/preferences.js');
  const devIds = new Set((accountStore.listAll() || []).filter(a => isDeveloperAccount(a)).map(a => a.userId));
  const all = preferenceStore.listAll().filter(p => !devIds.has(p.userId));
  const count = (fn: (p: any) => boolean) => all.filter(fn).length;
  res.json({
    success: true,
    data: {
      total: all.length,
      mode: {
        hug: count(p => p.mode === 'hug'),
        ally: count(p => p.mode === 'ally'),
        clarify: count(p => p.mode === 'clarify'),
        light: count(p => p.mode === 'light'),
        objective: count(p => p.mode === 'objective'),
      },
      language: {
        'zh-CN': count(p => p.language === 'zh-CN'),
        'zh-TW': count(p => p.language === 'zh-TW'),
        'en': count(p => p.language === 'en'),
      },
      // 小愈朗读开关分布（默认关；开启=想听，控制台据此看「谁开了/谁没开」）
      voice: {
        on: count(p => p.assistantVoiceEnabled === true),
        off: count(p => p.assistantVoiceEnabled === false),
      },
    }
  });
});

/**
 * 运营端：小愈朗读开关的逐用户明细（默认关；谁开了/谁没开 + 最近更新时间）
 * GET /api/payment/admin/voice-users?token=xxx
 */
router.get('/voice-users', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { preferenceStore } = await import('../services/preferences.js');
  const devIds = new Set((accountStore.listAll() || []).filter(a => isDeveloperAccount(a)).map(a => a.userId));
  const rows = preferenceStore.listAll()
    .filter(p => !devIds.has(p.userId))
    .map((p: any) => {
      const a = accountStore.getById(p.userId);
      return {
        userId: p.userId,
        user: a ? (a.username || a.phone || a.email) : '游客/设备',
        voiceEnabled: p.assistantVoiceEnabled === true,
        updatedAt: new Date(p.updatedAt).toLocaleString('zh-CN'),
      };
    })
    .sort((a: any, b: any) => Number(b.voiceEnabled) - Number(a.voiceEnabled));
  res.json({
    success: true,
    data: rows,
    total: rows.length,
    on: rows.filter((r: any) => r.voiceEnabled).length,
    off: rows.filter((r: any) => !r.voiceEnabled).length,
  });
});

/**
 * 运营端：AI 失败/超时统计（2026-09-15 事故后新增）
 * GET /api/payment/admin/ai-failures?token=xxx&days=7
 *
 * 用来回答「今天有多少次 AI 没接上、其中多少次被自动重试救回来」。
 * 只含功能/原因码/计数，无任何用户内容与 userId。缺口（fired 但没救回）才是用户真的看到失败条的量。
 */
router.get('/ai-failures', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Number(req.query?.days) || 7;
  const { aiFailureStore } = await import('../services/aiFailure.js');
  res.json({ success: true, data: aiFailureStore.summary(days) });
});

/**
 * 运营端：🔍 改进审阅队列（**去除账号关联**）
 *
 * GET  /api/payment/admin/review-queue?token=xxx&page=1&page-size=20&kind=chat|roleplay
 *      &read=unread|read|star|flagged&from=YYYY-MM-DD&to=YYYY-MM-DD&q=关键词&order=new|old
 * GET  /api/payment/admin/review-queue/item?token=xxx&key=sk_xxxx   → 单条正文（列表不带正文，手机优先）
 * POST /api/payment/admin/review-queue/build?token=xxx&limit=500&min-turns=2
 * POST /api/payment/admin/review-queue/read?token=xxx               → 已读 / 星标 / 备注（见下方那条路由）
 *
 * ⚠️ 2026-09-25 起 GET 是**增量档案**（不再是「一次生成整体覆盖的快照」）：所有筛选、统计、
 * 分页都在服务端做，列表只回当前页的摘要；条目不会被后一次生成挤掉。设计取舍见
 * `api/services/reviewArchive.ts` 顶部注释（含「为什么会漏记录」的三条根因）。
 *
 * 用途：审阅真实对话来发现 AI 的回复质量问题（如「用户想要更亲密的表达，AI 却回避」），
 * 这是**替代「翻某个用户的聊天记录」的通道**——不需要先知道是谁，也不可能知道是谁。
 *
 * 隔离度（本接口存在的全部理由）：
 *   - 只带随机代号 `rv_xxxx`，**无 userId / sessionId / scenarioId**（这三条都能反查到人：
 *     userId→accounts.json、sessionId→sessions.json、scenarioId→customRoleplay 作者）
 *   - 无邮箱 / 手机号 / 用户名 / IP
 *   - 绝对时间戳 → **只到分钟、不带秒**（2026-09-20 口径变更：原来只有日粒度 date，审阅时
 *     无法与日志/别处记录对时间）。秒级锚点才够格当唯一键；对话内部的节奏由逐条的相对
 *     偏移 offsetMs 保证。隐私政策第 7 条与审阅页说明同步改了措辞。
 *   - 用户**基础设置快照**（陪伴方式 / 深度思考档位 / 地区语气 / 括号心理 …）随条目带出：
 *     同一条回复在不同设置下的好坏标准不同，没有这一层会把「设置本来如此」误判成模型变差。
 *     只过白名单键（见 reviewQueue.normalizeSettings），能以剧本 id 为 key 的表一律不带。
 *   - 正文里用户自报的身份（手机号/姓名/机构等）生成时已洗掉，`scrubbed` 字段说明洗了什么
 *   - 「允许用于改进服务」(dataEnhance) 关闭的用户**不进队列**
 *   - **测试 / 开发身份默认整条排除**（`test-` 前缀设备、@test.com、TEST_ACCOUNTS、
 *     内置开发者邮箱、DEV_ACCOUNTS）——审阅队列是用来照**真实用户**的行为改模型的，
 *     自测对话混进来会把结论带偏。复用 `accountFilters` 与 `activity.isTestRequest`
 *     的既有判据，不另写一份。`?include-test=1` 可收进来（条目带 `test:true`），仅自测用。
 *
 * ⚠️ 对外措辞：这是「去除账号关联后的人工审阅」，**不是匿名**。自由文本里的身份
 * （如「我在氹仔那家茶餐厅打工」）正则洗不干净——别把这里的隔离度说成匿名，那个词法律上过满。
 *
 * 生成走 POST build（后台按钮），或命令行 `npx tsx scripts/build-review-queue.mts`。
 * 两条路都**并进**同一份档案（按对话身份键去重），不再整体覆盖。
 */
router.get('/review-queue', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }

  /**
   * ⚠️ 2026-09-25 起这里是**增量档案**（不再是一次生成整体覆盖的快照）：分页 / 日期范围 /
   * 筛选 / 搜索全部在服务端做，列表只回**当前页的摘要（不含正文）**——正文由
   * `/review-queue/item?key=` 按需单取。这么改的原因见 reviewArchive.ts 顶部注释。
   */
  const { loadArchive } = await import('../services/reviewArchive.js');
  const { queryArchive, REVIEW_LABELS } = await import('../services/reviewQuery.js');
  const { reviewReadStore } = await import('../services/reviewReads.js');

  const archive = loadArchive();
  const reads = reviewReadStore.all();
  const result = queryArchive(archive.items, {
    kind: String(req.query?.kind || ''),
    read: String(req.query?.read || ''),
    from: String(req.query?.from || ''),
    to: String(req.query?.to || ''),
    q: String(req.query?.q || ''),
    order: String(req.query?.order || ''),
    page: Number(req.query?.page),
    pageSize: Number(req.query?.['page-size'] ?? req.query?.pageSize),
  }, reads);

  const items = result.items.map((it) => ({
    ...it,
    readKey: it.sampleKey,
    read: reads[it.sampleKey] || null,
  }));
  const readInShown = items.filter((it) => Boolean(it.read?.readAt)).length;

  // 访问留痕：看审阅档案这件事本身要可追（谁、何时、看了哪一页、命中多少条）
  const { auditStore } = await import('../services/audit.js');
  auditStore.log(
    'review_view',
    `审阅档案：第 ${result.page}/${result.pageCount} 页 · 命中 ${result.filtered}/${result.total} 条`
    + `${result.filters.read !== 'all' ? `（筛选 ${result.filters.read}）` : ''}`
    + `${result.filters.q ? `（搜索「${result.filters.q}」）` : ''} · 本页已读 ${readInShown}`,
    req.ip || '',
  );

  res.json({
    success: true,
    data: {
      items,
      meta: archive.meta,
      labels: REVIEW_LABELS,
      exists: archive.meta !== null || archive.items.length > 0,
      legacy: archive.legacy,
      total: result.total,
      scoped: result.scoped,
      filtered: result.filtered,
      page: result.page,
      pageSize: result.pageSize,
      pageCount: result.pageCount,
      counts: result.counts,
      filters: result.filters,
      progress: {
        shown: items.length,
        readInShown,
        total: result.total,
        counts: result.counts,
        reads: reviewReadStore.stats(),
      },
    },
  });
});

/**
 * 运营端：取**单条样本的正文**（2026-09-25 新增）
 *
 * GET /api/payment/admin/review-queue/item?token=xxx&key=sk_xxxx
 *
 * 为什么要单独一条接口：档案是累积的（几百上千条），列表接口如果照旧把每条正文都带上，
 * 一页就是几百 KB —— 管理员主要在手机上看，那是不可用的。所以列表只给摘要，
 * 展开哪条才取哪条的正文。`key` = 条目的 `sampleKey`（对话身份指纹，不是 reviewId）。
 */
router.get('/review-queue/item', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }

  const key = String(req.query?.key || '').trim();
  if (!key || key.length > 64) { res.status(400).json({ success: false, error: '缺少 key' }); return; }

  const { loadArchive } = await import('../services/reviewArchive.js');
  const item = loadArchive().items.find((it) => it.sampleKey === key);
  if (!item) { res.status(404).json({ success: false, error: '档案里没有这条（可能已被重新生成或超出档案上限）' }); return; }

  const { reviewReadStore } = await import('../services/reviewReads.js');
  res.json({ success: true, data: { item: { ...item, readKey: item.sampleKey, read: reviewReadStore.get(key) || null } } });
});

router.post('/review-queue/build', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }

  /**
   * ⚠️ 默认从 50 提到 500（2026-09-25）：limit 的含义是「本次最多把多少条有资格的对话
   * **并进档案**」，不是「页面显示多少」。原来 50 会把有资格的都截掉——实测 09-20 那次
   * 386 条候选里筛出 105 条有资格，只进了 50 条，另外 55 条从视图里消失。
   * 档案的意义就是不再丢记录，所以默认取满（上限 2000）。
   *
   * 2026-09-29：这串编排搬到 `services/reviewBuilder.ts`，与「服务端定时器」
   * （server.ts 的 startReviewArchiveScheduler）共用**同一份口径**；本路由只负责
   * 鉴权、解析参数、把结果/错误翻译成 HTTP。抽出去的原因见那个文件头部注释。
   */
  const limit = Math.min(Math.max(1, Number(req.query?.limit) || 500), 2000);
  const minUserTurns = Math.max(1, Number(req.query?.['min-turns']) || 2);
  const includeTestRaw = String(req.query?.['include-test'] || '').toLowerCase();
  const includeTest = includeTestRaw === '1' || includeTestRaw === 'true';

  try {
    const { buildReviewArchive } = await import('../services/reviewBuilder.js');
    const summary = buildReviewArchive({
      limit, minUserTurns, includeTest, source: 'admin', ip: req.ip || '',
    });
    res.json({ success: true, data: summary });
  } catch (e) {
    // 去标识化断言失败 / 并发构建要让管理员**看见原因**（否则无从修）；
    // 其余一律走 safeError 的通用文案，不把内部细节抛给前端。
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('REVIEW_BUILD_BUSY')) {
      res.status(409).json({ success: false, error: '审阅档案正在生成中，请稍后再试' });
      return;
    }
    const detail = msg.includes('去标识化断言失败') ? msg.slice(0, 400) : safeError('generic', e);
    res.status(500).json({ success: false, error: detail });
  }
});

/**
 * 运营端：审阅队列的「已读 / 未读 / 星标 / 备注」标记（2026-09-20 新增）
 *
 * POST /api/payment/admin/review-queue/read
 *   body: { keys: string[], read?: boolean, open?: boolean, starred?: boolean, note?: string }
 *
 * 键 = 条目的 `sampleKey`（内容指纹，跨「重新生成队列」稳定；见 reviewQueue.ts 的说明）。
 * 状态存在 data/review-reads.json，与队列文件分开：队列每次生成整体覆盖，混在一起会把标记冲掉。
 * 只存键 + 时间 + 星标 + 备注，**没有任何对话内容**，也没有 userId。
 *
 * 为什么要留痕：标记动作本身也是运营操作（谁把哪条标成了已读/星标），与看队列一样要可追。
 */
router.post('/review-queue/read', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }

  const body = (req.body || {}) as {
    keys?: unknown; read?: unknown; open?: unknown; starred?: unknown; note?: unknown;
  };
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .map((k) => String(k || '').trim())
    .filter((k) => k.length > 0 && k.length <= 64)
    .slice(0, 300);
  if (keys.length === 0) { res.status(400).json({ success: false, error: '缺少 keys' }); return; }

  const patch: { read?: boolean; open?: boolean; starred?: boolean; note?: string } = {};
  if (typeof body.read === 'boolean') patch.read = body.read;
  if (typeof body.starred === 'boolean') patch.starred = body.starred;
  if (body.open === true) patch.open = true;
  if (typeof body.note === 'string') patch.note = body.note;
  if (Object.keys(patch).length === 0) { res.status(400).json({ success: false, error: '没有要改的字段' }); return; }

  const { reviewReadStore } = await import('../services/reviewReads.js');
  const { updated } = reviewReadStore.mark(keys, patch);

  const what = patch.read === true ? '标已读' : patch.read === false ? '标未读' : patch.open ? '记打开' : '改属性';
  const extra = (patch.starred === true ? ' · 星标' : patch.starred === false ? ' · 取消星标' : '')
    + (typeof patch.note === 'string' ? ' · 备注' : '');
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('review_read', `审阅标记：${what} ${updated} 条${extra}`, req.ip || '');

  res.json({ success: true, data: { updated, stats: reviewReadStore.stats() } });
});

/**
 * 运营端：🩺 自愈 / 修复记录（2026-09-18 新增）
 * GET  /api/payment/admin/self-heal?token=xxx&days=7  → 汇总 + 每个被检测到的问题（原因/怎么解决/现状）
 * POST /api/payment/admin/self-heal/run?token=xxx      → 立刻巡检一次（会真的修；内容删除类默认仍只报告）
 *
 * 与 /ai-failures 的分工：那张卡回答「今天 AI 没接上几次、用户看到了什么」（匿名聚合）；
 * 这里回答「哪个用户的哪条会话坏了、修了没有、现在什么状态」（具体、可复查）。
 */
router.get('/self-heal', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const days = Number(req.query?.days) || 7;
  const { selfHealStore } = await import('../services/selfHeal.js');
  res.json({ success: true, data: selfHealStore.summary(days) });
});

router.post('/self-heal/run', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { runSelfHealCycle, selfHealStore } = await import('../services/selfHeal.js');
  const run = await runSelfHealCycle({ apply: true });
  const { auditStore } = await import('../services/audit.js');
  auditStore.log(
    'self_heal_run',
    `手动巡检：扫描 ${run.scanned} 会话 · 发现 ${run.detected} · 已修 ${run.fixed} · 已缓解 ${run.mitigated} · 待人工 ${run.needsHuman} · 失败 ${run.failed}${run.backup ? ' · 备份 ' + run.backup.split(/[\\/]/).pop() : ''}`,
    req.ip || '',
  );
  res.json({ success: true, data: { run, summary: selfHealStore.summary(7) } });
});

/**
 * 运营端：用户反馈列表
 * GET /api/payment/admin/feedback?token=xxx
 */
router.get('/feedback', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { feedbackStore } = await import('../services/feedback.js');
  const { accountStore: acc } = await import('../services/accounts.js');
  const list = feedbackStore.listAll().slice(0, 100).map(f => {
    const a = acc.getById(f.userId);
    return {
      id: f.id, type: f.type, content: f.content, contact: f.contact || '',
      context: f.context || '',
      user: a ? (a.username || a.phone || a.email) : '游客/设备',
      userId: f.userId,
      status: f.status || 'pending',
      reward: f.reward || 0,
      createdAt: new Date(f.createdAt).toLocaleString('zh-CN'),
    };
  });
  res.json({ success: true, data: list });
});

/**
 * 运营端：采纳反馈并发放消息奖励（5-50 条）
 * POST /api/payment/admin/feedback-reward?token=xxx { id, reward }
 */
router.post('/feedback-reward', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { id, reward, message } = req.body || {};
  const n = Number(reward);
  if (!id || !Number.isFinite(n) || n < 5 || n > 50) {
    res.status(400).json({ success: false, error: '奖励需在 5-50 条之间' });
    return;
  }
  const { feedbackStore } = await import('../services/feedback.js');
  const f = feedbackStore.get(String(id));
  if (!f) {
    res.status(404).json({ success: false, error: '反馈不存在' });
    return;
  }
  const count = Math.round(n);
  const ok = feedbackStore.setReward(f.id, count);
  if (!ok) {
    res.status(400).json({ success: false, error: '更新失败' });
    return;
  }
  const note = typeof message === 'string' ? message.trim().slice(0, 500) : '';
  const { quotaStore } = await import('../services/quota.js');
  // note 一并写进 pendingReward：站内恭喜弹窗据此展示运营者的回复（ack 只清弹窗，信仍在信箱）
  quotaStore.addBonus(f.userId, count, 'feedback', note || undefined);
  // 站内信箱留一封信：邮件只到得了「有邮箱的注册用户」，而且看完就沉底；
  // 无邮箱的游客 + 当时没看邮件的人，只能靠这封信看到运营者的回复（2026-09-30）。
  const { inboxStore } = await import('../services/inbox.js');
  inboxStore.add(f.userId, { kind: 'reward', rewardCount: count, reason: 'feedback', body: note });
  // 发邮件通知（注册用户有邮箱，游客跳过）；message 为运营者的回复，随邮件一起发
  const { notifyRewardByEmail } = await import('../services/rewardNotifier.js');
  notifyRewardByEmail(f.userId, count, 'feedback', note || undefined);
  res.json({ success: true, data: { id: f.id, reward: count } });
});

/**
 * 运营端：发布公告（最多3条，新在前）

/**
 * 运营端：AI 帮写公告草稿（中英双语）
 * POST /api/payment/admin/announcement-draft?token=xxx { topic }
 */
router.post('/announcement-draft', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { topic } = req.body || {};
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ success: false, error: '请填写公告主题' });
    return;
  }
  try {
    const { generateAnnouncementDraft } = await import('../services/gemini.js');
    const draft = await generateAnnouncementDraft(topic.trim().slice(0, 100));
    if (!draft) {
      res.status(500).json({ success: false, error: 'AI 生成失败，请重试' });
      return;
    }
    res.json({ success: true, data: draft });
  } catch (error) {
    console.error('AI draft error:', error);
    res.status(500).json({ success: false, error: safeError('ai', error) });
  }
});

/**
 * POST /api/payment/admin/announcement?token=xxx { titleZh, contentZh, titleTw?, contentTw?, titleEn?, contentEn? }
 * 兼容旧字段 title/content（缺三语时三语同值）
 */
router.post('/announcement', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { title, content, titleZh, contentZh, titleTw, contentTw, titleEn, contentEn } = req.body || {};
  const zhTitle = String(titleZh || title || '').trim();
  const zhContent = String(contentZh || content || '').trim();
  if (!zhTitle || !zhContent) {
    res.status(400).json({ success: false, error: '请填写中文标题和内容' });
    return;
  }
  const { announcementStore, MAX_ANNOUNCEMENTS_COUNT } = await import('../services/announcements.js');
  const a = announcementStore.addLangs({
    zhCN: { title: zhTitle, content: zhContent },
    zhTW: { title: String(titleTw || zhTitle), content: String(contentTw || zhContent) },
    en: { title: String(titleEn || zhTitle), content: String(contentEn || zhContent) },
  });
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('set_announcement', `发布三语公告「${zhTitle.slice(0, 20)}」（当前最多${MAX_ANNOUNCEMENTS_COUNT}条）`, req.ip || '');
  res.json({ success: true, data: a });
});

/**
 * 运营端：删除公告
 * POST /api/payment/admin/announcement/:id/remove?token=xxx
 */
router.post('/announcement/:id/remove', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { announcementStore } = await import('../services/announcements.js');
  announcementStore.remove(String(req.params.id));
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('set_announcement', `删除公告 ${String(req.params.id).slice(0, 16)}`, req.ip || '');
  res.json({ success: true, data: { message: '公告已删除' } });
});

/**
 * 运营端：更新已发布的公告（保留 id 与创建时间，只更新三语内容；不重发邮件）
 * POST /api/payment/admin/announcement/:id/update?token=xxx { titleZh, contentZh, titleTw?, contentTw?, titleEn?, contentEn? }
 */
router.post('/announcement/:id/update', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { titleZh, contentZh, titleTw, contentTw, titleEn, contentEn } = req.body || {};
  const zhTitle = String(titleZh || '').trim();
  const zhContent = String(contentZh || '').trim();
  if (!zhTitle || !zhContent) {
    res.status(400).json({ success: false, error: '请填写中文标题和内容' });
    return;
  }
  const { announcementStore } = await import('../services/announcements.js');
  const a = announcementStore.update(String(req.params.id), {
    zhCN: { title: zhTitle, content: zhContent },
    zhTW: { title: String(titleTw || ''), content: String(contentTw || '') },
    en: { title: String(titleEn || ''), content: String(contentEn || '') },
  });
  if (!a) {
    res.status(404).json({ success: false, error: '公告不存在或已被删除' });
    return;
  }
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('set_announcement', `更新公告「${zhTitle.slice(0, 20)}」(${String(req.params.id).slice(0, 16)})`, req.ip || '');
  res.json({ success: true, data: a });
});

/**
 * 运营端：发布更新总结（可发公告和/或邮件给注册用户）
 * POST /api/payment/admin/update?token=xxx { icon, title, content, via: 'announcement'|'email'|'both' }
 */
router.post('/update', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { icon, title, content, via, titleTw, contentTw, enTitle, enContent } = req.body || {};
  if (!content) {
    res.status(400).json({ success: false, error: '请填写更新内容' });
    return;
  }
  const emojiIcon = String(icon || '✨').slice(0, 4);
  const finalTitle = String(title || '产品更新').slice(0, 50);
  const finalContent = `${emojiIcon} ${String(content).slice(0, 500)}`;
  const results: string[] = [];

  if (via !== 'email') {
    const { announcementStore } = await import('../services/announcements.js');
    announcementStore.addLangs({
      zhCN: { title: finalTitle, content: finalContent },
      zhTW: { title: String(titleTw || title || '产品更新').slice(0, 50), content: String(contentTw || content).slice(0, 500) },
      en: { title: String(enTitle || title || 'Product update').slice(0, 50), content: String(enContent || content).slice(0, 500) },
    });
    results.push('已发布为公告（三语）');
  }

  if (via !== 'announcement') {
    // 邮件推送给所有注册用户
    const accounts = (accountStore.listAll() || []).filter(a => !isTestAccount(a));
    const { sendEmail } = await import('../services/email.js');
    let sent = 0;
    for (const acc of accounts) {
      try {
        const enHtml = enContent ? `
          <div style="border-top:1px solid #eee;margin-top:16px;padding-top:14px">
            <p style="color:#333;line-height:1.7">${String(enTitle || finalTitle)}:</p>
            <p style="color:#444;line-height:1.8;white-space:pre-line">${String(enContent).slice(0, 500).replace(/</g, '&lt;')}</p>
          </div>` : '';
        const html = `
          <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#FBF6EE;border-radius:16px;border:1px solid #E4E0D4">
            <div style="text-align:center;margin-bottom:16px">
              <div style="font-size:32px;line-height:1">🌱</div>
              <h2 style="color:#178353;margin:6px 0 0;font-size:18px">Xiaoyu · 小愈</h2>
              <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
            </div>
            <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #DCE8D5">
              <p style="color:#243B2E;line-height:1.7;margin:0 0 8px"><b style="color:#178353">${finalTitle}</b></p>
              <p style="color:#444;line-height:1.8;white-space:pre-line;margin:0">${String(content).slice(0, 500).replace(/</g, '&lt;')}</p>
              ${enHtml}
              <p style="color:#999;font-size:12px;margin:12px 0 0">不想接收更新邮件可忽略本邮件。</p>
            </div>
            <p style="margin:16px 0 0;font-size:12px;color:#A0A7B5;text-align:center">Every feeling deserves to be understood.</p>
          </div>`;
        const r = await sendEmail(acc.email, `【小愈】${finalTitle}`, html);
        if (r.ok) sent++;
      } catch { /* 单个失败不影响其他 */ }
    }
    results.push(`已发送邮件给 ${sent}/${accounts.length} 位注册用户`);
  }

  const { auditStore } = await import('../services/audit.js');
  auditStore.log('send_update', `发布更新「${finalTitle}」：${results.join('；')}`, req.ip || '');
  res.json({ success: true, data: { message: results.join('；') } });
});
/**
 * 运营端：成人向定向邮件（剧情「无限制模式」上线通知）
 * POST /api/payment/admin/adult-campaign?token=xxx
 *   { apply?: boolean, audience?: 'active'|'roleplay', days?: number, limit?: number, sampleCount?: number }
 *
 * `apply` 缺省/false = dry-run：只回名单人数、排除原因、语言分布、预估发送天数与前几封样例（含渲染后的 HTML），
 * **一封都不发**。只有显式 `apply:true` 才真发，且受群发通道每日上限（CAMPAIGN_DAILY_CAP）与投递幂等约束
 * （重复调用不会给同一个人发第二封）。
 *
 * 通道 = 独立群发 SMTP（CAMPAIGN_SMTP_*，默认 myxiaoyu2026@gmail.com），不占主通道的验证码额度。
 * 名单共用召回的退订状态：退订过的用户永不触达。
 */
router.post('/adult-campaign', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { apply, audience, days, limit, sampleCount, minRoleplay, roleplayWithinDays, minRoleplayMessages } = req.body || {};
  try {
    const { runAdultCampaign } = await import('../services/adultCampaign.js');
    const wantsApply = apply === true;
    const summary = await runAdultCampaign({
      apply: wantsApply,
      audience: audience === 'roleplay' ? 'roleplay' : 'active',
      days: Number(days) > 0 ? Number(days) : undefined,
      limit: Number(limit) > 0 ? Number(limit) : undefined,
      sampleCount: Number(sampleCount) > 0 ? Number(sampleCount) : undefined,
      minRoleplay: Number(minRoleplay) > 0 ? Number(minRoleplay) : undefined,
      roleplayWithinDays: Number(roleplayWithinDays) > 0 ? Number(roleplayWithinDays) : undefined,
      minRoleplayMessages: Number(minRoleplayMessages) > 0 ? Number(minRoleplayMessages) : undefined,
    });
    if (wantsApply) {
      const { auditStore } = await import('../services/audit.js');
      auditStore.log('adult_campaign', `成人向定向邮件：计划 ${summary.planned} 人，实发 ${summary.sent} 封，失败 ${summary.failed}，因每日上限跳过 ${summary.skippedByCap}`, req.ip || '');
    }
    res.json({ success: true, data: summary });
  } catch (e) {
    console.error('[Admin] adult-campaign 失败:', (e as Error)?.message);
    res.status(500).json({ success: false, error: safeError('generic', e) });
  }
});

/**
 * 运营端：成人向定向邮件的累计投递情况 + 群发通道是否就绪
 * GET /api/payment/admin/adult-campaign/stats?token=xxx
 */
router.get('/adult-campaign/stats', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { campaignStats } = await import('../services/adultCampaign.js');
  const { adultConfirmStore } = await import('../services/adultConfirm.js');
  res.json({ success: true, data: { ...campaignStats(), adultConfirmedUsers: adultConfirmStore.stats().confirmed } });
});

/**
 * 运营端：记录 AI 更新（AI 修改代码/产品后，把精简更新内容记入审计，供追溯）
 * POST /api/payment/admin/ai-log?token=xxx { summary }
 */
router.post('/ai-log', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { summary } = req.body || {};
  if (!summary || typeof summary !== 'string' || !summary.trim()) {
    res.status(400).json({ success: false, error: '请填写更新摘要' });
    return;
  }
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('ai_update', String(summary).trim().slice(0, 200), req.ip || '');
  res.json({ success: true, data: { message: '已记录 AI 更新' } });
});

/**
 * 运营端：操作审计日志
 * GET /api/payment/admin/audit?token=xxx
 */
router.get('/audit', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { auditStore } = await import('../services/audit.js');
  const list = auditStore.listAll().slice(0, 100).map(a => ({
    id: a.id, action: a.action, detail: a.detail, ip: a.ip,
    createdAt: new Date(a.createdAt).toLocaleString('zh-CN'),
  }));
  res.json({ success: true, data: list });
});

/**
 * 运营端：转化漏斗
 * GET /api/payment/admin/funnel?token=xxx
 */
router.get('/funnel', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { visitStore } = await import('../services/visits.js');
  const accounts = (accountStore.listAll() || []).filter(a => !isTestAccount(a) && !isDeveloperAccount(a));
  const allOrders = paymentStore.listAll();
  // 付费 = 真正付过钱的订单（status=unlocked 且 source=paid）；管理员手动开通（免费赠送）不计入
  const unlockedOrders = allOrders.filter(o => o.status === 'unlocked' && o.source !== 'free');
  const paidUsers = new Set(unlockedOrders.map(o => o.userId));
  // 续费 = 同一用户有 ≥2 个已解锁订单
  const orderCountByUser = new Map<string, number>();
  for (const o of unlockedOrders) orderCountByUser.set(o.userId, (orderCountByUser.get(o.userId) || 0) + 1);
  const renewedUsers = new Set([...orderCountByUser.entries()].filter(([, n]) => n >= 2).map(([u]) => u));

  const now = Date.now();
  const d30 = now - 30 * 86400000;
  const recentAccounts = accounts.filter(a => a.createdAt > d30);
  const recentOrders = unlockedOrders.filter(o => (o.confirmedAt || o.createdAt) > d30);
  const recentPaid = new Set(recentOrders.map(o => o.userId));

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  res.json({
    success: true,
    data: {
      all: {
        visitors: visitStore.getVisitCount(),
        registered: accounts.length,
        paid: paidUsers.size,
        renewed: renewedUsers.size,
        registerRate: pct(accounts.length, visitStore.getVisitCount()),
        payRate: pct(paidUsers.size, accounts.length),
        renewRate: pct(renewedUsers.size, paidUsers.size),
      },
      last30d: {
        registered: recentAccounts.length,
        paid: recentPaid.size,
      },
      paidUsersCount: orderCountByUser.size,
    }
  });
});

/**
 * 运营端：用户 IP 地区分布（商业分析）
 * GET /api/payment/admin/geo?token=xxx
 * 数据源：activity 登录记录里的 IP（每位置册用户取最近一次登录 IP，排除测试/开发者账号）
 * 离线解析（api/services/geo.ts，ip2region 本地库）：国家/地区 + 大陆省份 + 运营商
 */
router.get('/geo', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  try {
    const { activityStore } = await import('../services/activity.js');
    const { usageTimeStore } = await import('../services/usageTime.js');
    const { roleplaySessionStore } = await import('../services/roleplaySessions.js');
    const { lookupIp } = await import('../services/geo.js');
    const memoryStorage = (await import('../storage/memory.js')).default;
    const accounts = accountStore.listAll() || [];
    const excluded = new Set(accounts.filter(a => isTestAccount(a) || isDeveloperAccount(a)).map(a => a.userId));

    const accountIds = new Set(accounts.map(a => a.userId));
    const rows: any[] = [];
    const now = Date.now();
    const days = Math.min(90, Math.max(1, Number(req.query?.days || 1)));
    const since = now - days * 86400000;
    // 行为兜底：埋点上线前的老用户，用已有持久化会话估算真实次数（与 /activity 口径一致，避免「0 次但有聊天」）
    const chatUserByUser = new Map<string, number>();
    const structByUser = new Map<string, number>();
    for (const s of memoryStorage.getActiveSessions()) {
      if (!s.userId) continue;
      if (s.emotionAnalysis) structByUser.set(s.userId, (structByUser.get(s.userId) || 0) + 1);
      const n = (s.chatMessages || []).filter(m => m.role === 'user').length;
      if (n > 0) chatUserByUser.set(s.userId, (chatUserByUser.get(s.userId) || 0) + n);
    }
    const rpUserByUser = new Map<string, number>();
    for (const rec of roleplaySessionStore.listAll()) {
      const n = (rec.messages || []).filter(m => m.role === 'user').length;
      if (n > 0) rpUserByUser.set(rec.userId, (rpUserByUser.get(rec.userId) || 0) + n);
    }
    /** 🎭 徽章「今日」列（地区下钻同屏的行为列，见 todayRoleplayByUser 注释） */
    const rpTodayMap = await todayRoleplayByUser();
    for (const a of activityStore.listAll()) {
      if (excluded.has(a.userId)) continue;
      const isAccount = accountIds.has(a.userId);
      // 注册用户：取最近一次登录 IP/国家码；游客：取最近一次功能使用记下的 IP/国家码（lastIp/lastCountry）
      const latestLogin = (a.logins || []).filter((l: any) => l?.ip).sort((x: any, y: any) => (y.at || 0) - (x.at || 0))[0] as { ip?: string; country?: string; at?: number } | undefined;
      const ip = isAccount ? latestLogin?.ip : a.lastIp;
      const countryCode = isAccount ? latestLogin?.country : a.lastCountry;
      if (!ip) continue;
      // 国家码优先（Cloudflare/Vercel，海外准确）；ip2region 兜底大陆细分（P1 修复）
      const geo = lookupIp(ip, countryCode);
      // 内网/本地不计入；「未知」保留为「未知/未识别」桶，缺口可见（不再静默丢弃）
      if (geo.isPrivate) continue;
      const displayCountry = geo.country === '未知' ? '未知/未识别' : geo.country;
      const acc = isAccount ? accountStore.getById(a.userId) : null;
      rows.push({
        kind: isAccount ? 'user' : 'guest',
        userId: a.userId,
        name: isAccount
          ? acc?.username || acc?.phone || (acc?.email || '').split('@')[0] || a.userId.slice(0, 8)
          : '游客 ' + a.userId.slice(0, 8),
        email: acc?.email || '',
        ip,
        country: displayCountry,
        region: geo.region,
        city: geo.city,
        isp: geo.isp,
        activeAt: a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString('zh-CN') : null,
        // 供前端「点击地区 → 该时间段活跃用户」下钻：登录时间戳在浏览器本地时区判定「今天」
        lastLoginAt: isAccount ? (a.lastLoginAt ?? latestLogin?.at ?? null) : null,
        loginTimes: isAccount ? (a.logins || []).map((l: any) => l?.at || 0).filter((t: number) => t > 0) : [],
        // 用于按所选时间段过滤「最近一次登录/使用」：注册用户取最近登录，游客取最近使用
        recentAt: isAccount ? (a.lastLoginAt ?? latestLogin?.at ?? 0) : (a.lastActiveAt ?? 0),
        // 用户行为合并：同一行同时给出该用户的地区 IP + 使用次数（供「地区分布」下钻同屏展示）
        chatCount: (a.chatCount ?? 0) > 0 ? (a.chatCount ?? 0) : (chatUserByUser.get(a.userId) || 0),
        structureCount: (a.structureCount ?? 0) > 0 ? (a.structureCount ?? 0) : (structByUser.get(a.userId) || 0),
        roleplayCount: (a.roleplayCount ?? 0) > 0 ? (a.roleplayCount ?? 0) : (rpUserByUser.get(a.userId) || 0),
        // 🎭 徽章「今日/累计」（C 方案）：地区下钻同屏的行为列也用同一套口径
        roleplayToday: rpTodayMap.get(a.userId) || 0,
        roleplayTotal: (a.roleplayCount ?? 0) > 0 ? (a.roleplayCount ?? 0) : (rpUserByUser.get(a.userId) || 0),
        loginCount: a.loginCount ?? 0,
        usageSeconds: usageTimeStore.getUserLifetime(a.userId),
      });
    }

    const periodRows = rows.filter((r: any) => (r.recentAt || 0) >= since);
    const bucket = (key: (r: any) => string) => {
      const m = new Map<string, number>();
      for (const r of periodRows) {
        const k = key(r) || '未知';
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };

    const total = periodRows.length;
    const users = periodRows.filter(r => r.kind === 'user');
    const guests = periodRows.filter(r => r.kind === 'guest');
    res.json({
      success: true,
      data: {
        generatedAt: Date.now(),
        days,
        total,
        totalUsers: users.length,
        totalGuests: guests.length,
        byCountry: bucket(r => r.country),
        byProvince: bucket(r => (r.country === '中国大陆' ? (r.region || '省份未知') : r.country)),
        byIsp: bucket(r => r.isp),
        users,
        guests,
      },
    });
  } catch (error) {
    console.error('Geo distribution error:', error);
    res.status(500).json({ success: false, error: '生成 IP 地区分布失败' });
  }
});

/**
 * 运营端：访问地区分布（含匿名访客，按访问 IP/设备归桶）
 * GET /api/payment/admin/geo-visits?token=xxx&days=1|7|30
 * 数据源：visits.json 的 geoDaily（/api/analysis/visit 上报时按设备记录 IP，离线解析国家/省份/运营商）
 * 口径：区间内按「设备」去重（取该设备最近一次所在地区），桶内合计 = 区间独立设备数，
 *       与「今日访问/近N天访问」的设备口径一致，可直接对账；独立 IP 数为同区间内不同出口 IP 数
 */
router.get('/geo-visits', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  try {
    const { visitStore } = await import('../services/visits.js');
    const days = Math.min(90, Math.max(1, Number(req.query?.days || 1)));
    const rows = visitStore.getGeoVisits(days);

    const display = (c: string) => (c === '未知' ? '未知/未识别' : c);
    const bucket = (key: (r: any) => string) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = key(r) || '未知';
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };

    // 独立 IP 及设备数（同 IP 多设备合并展示）
    const ipMap = new Map<string, { ip: string; country: string; region: string; city: string; isp: string; devices: number }>();
    for (const r of rows) {
      const cur = ipMap.get(r.ip);
      if (cur) cur.devices += 1;
      else ipMap.set(r.ip, { ip: r.ip, country: display(r.country), region: r.region, city: r.city, isp: r.isp, devices: 1 });
    }
    const topIps = [...ipMap.values()].sort((a, b) => b.devices - a.devices).slice(0, 50);

    res.json({
      success: true,
      data: {
        generatedAt: Date.now(),
        days,
        totalDevices: rows.length,
        totalIps: ipMap.size,
        byCountry: bucket(r => display(r.country)),
        byProvince: bucket(r => (r.country === '中国大陆' ? (r.region || '省份未知') : display(r.country))),
        byIsp: bucket(r => r.isp || '未知'),
        topIps,
      },
    });
  } catch (error) {
    console.error('Geo visits distribution error:', error);
    res.status(500).json({ success: false, error: '生成访问地区分布失败' });
  }
});

/**
 * 运营端：AI 商业分析（聚合控制台数据 → DeepSeek 总结 + 优化建议）
 * POST /api/payment/admin/ai-summary { focus? } → { summary }
 * 只发送聚合指标（无 PII），正文不外发日志（P1-04：只记长度）
 */
router.post('/ai-summary', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  try {
    const { buildAdminAnalyticsBundle, AI_ANALYST_SYSTEM_PROMPT } = await import('../services/adminAnalytics.js');
    const { createDeepSeekClient } = await import('../services/deepseek.js');
    const bundle = buildAdminAnalyticsBundle();
    const focus = String((req.body || {}).focus || '').trim().slice(0, 200);

    const client = createDeepSeekClient();
    const result = await client.models.generateContent({
      contents: [
        { role: 'system', parts: [{ text: AI_ANALYST_SYSTEM_PROMPT }] },
        { role: 'user', parts: [{ text: '【运营数据 JSON】\n' + JSON.stringify(bundle) + (focus ? '\n\n【额外聚焦】' + focus : '') }] },
      ],
      userId: SYSTEM_USER_ID, // 运营内部调用：记到「系统/后台」行，不静默丢弃
      feature: 'internal',
    });
    const summary = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!summary.trim()) throw new Error('AI 未返回内容');
    // P1-04：日志只记长度，不记分析正文（正文可能含业务敏感推断）
    console.log('🤖 [Admin] AI 商业分析完成, 长度=' + summary.length);
    res.json({
      success: true,
      data: {
        summary,
        generatedAt: Date.now(),
        counts: { accounts: bundle.users.totalAccounts, unlockedOrders: bundle.payments.unlocked },
      },
    });
  } catch (error) {
    const msg = String((error as Error)?.message || '');
    if (/未配置/.test(msg)) {
      res.status(503).json({ success: false, error: '服务器未配置 DEEPSEEK_API_KEY，无法生成 AI 分析' });
      return;
    }
    console.error('AI 商业分析失败:', msg.slice(0, 200));
    res.status(500).json({ success: false, error: 'AI 分析生成失败，请稍后重试' });
  }
});

/**
 * 运营端：流失用户挽回（用完免费未付费 / 注册后未回访）
 * GET /api/payment/admin/churn?token=xxx
 */
router.get('/churn', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const { usageStore } = await import('../services/usage.js');
  const quotaUsers = new Map(quotaStore.listAll().map(u => [u.userId, u]));
  const accounts = (accountStore.listAll() || []).filter(a => !isTestAccount(a) && !isDeveloperAccount(a));
  const now = Date.now();
  // 「理一理」免费池底数统一取 quota.ts 的 FREE_STRUCT（=3），而非 FREE_QUOTA（=5），避免流失挽回漏报
  const FREE_TOTAL = FREE_STRUCT_COUNT;

  const fmt = (acc: any, reason: string) => {
    const q = quotaUsers.get(acc.userId);
    const last = usageStore.get(acc.userId)?.lastUsed;
    return {
      userId: acc.userId,
      name: acc.username || acc.phone || acc.email.split('@')[0],
      email: acc.email,
      reason,
      freeUsed: q?.freeUsed ?? 0,
      lastUsed: last ? new Date(last).toLocaleString('zh-CN') : '从未使用',
      registeredAt: new Date(acc.createdAt).toLocaleString('zh-CN'),
    };
  };

  // 用完免费次数未付费
  const exhausted = accounts.filter(acc => {
    const q = quotaUsers.get(acc.userId);
    if (!q) return false;
    const total = FREE_TOTAL + (q.bonusFree || 0);
    return q.freeUsed >= total && !(q.unlockUntil && q.unlockUntil > now);
  }).map(acc => fmt(acc, '免费次数已用完，未付费'));

  // 注册后 7 天未回访（最近使用超过 7 天或从未使用）
  const stale = accounts.filter(acc => {
    const last = usageStore.get(acc.userId)?.lastUsed;
    if (!last) return acc.createdAt < now - 7 * 86400000;
    return last < now - 7 * 86400000;
  }).map(acc => fmt(acc, '注册后 7 天未回访'));

  res.json({ success: true, data: { exhausted, stale } });
});

/**
 * 运营端：其他支出列表（手动记录的人工/域名/服务器/营销等固定成本）
 * GET /api/payment/admin/expenses?token=xxx
 */
router.get('/expenses', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  res.json({ success: true, data: { total: expenseStore.total(), expenses: expenseStore.list() } });
});

/**
 * 运营端：新增其他支出
 * POST /api/payment/admin/expenses  body: { category, note, amount, date }
 */
router.post('/expenses', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const body = (req.body || {}) as { category?: unknown; note?: unknown; amount?: unknown; date?: unknown };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ success: false, error: '金额需为正数' });
    return;
  }
  const note = String(body.note || '').trim();
  if (!note) {
    res.status(400).json({ success: false, error: '请填写支出说明' });
    return;
  }
  const expense = expenseStore.add(String(body.category || '其他'), note, amount, String(body.date || ''));
  res.json({ success: true, data: { total: expenseStore.total(), expense, expenses: expenseStore.list() } });
});

/**
 * 运营端：删除其他支出
 * DELETE /api/payment/admin/expenses/:id
 */
router.delete('/expenses/:id', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const id = String(req.params.id || '');
  if (!id || !expenseStore.remove(id)) {
    res.status(404).json({ success: false, error: '支出不存在' });
    return;
  }
  res.json({ success: true, data: { total: expenseStore.total(), expenses: expenseStore.list() } });
});

/**
 * 运营端：商业审查看板（定价 / 盈利能力 / 商业模型三合一，纯计算，实时）
 * GET /api/payment/admin/business-review?token=xxx
 * 不依赖 AI API —— 与 dsh-business 插件同源算法，读实时价格/订单/用量数据计算
 */
router.get('/business-review', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }

  const { getUsdPrice, getHkdPrice, getCnyPrice, PRO_PRICE_USD, PRO_PRICE_CNY, PLUS_PRICE_CNY_ORIG, PRO_PRICE_CNY_ORIG, PLUS_PRICE_USD_ORIG, PRO_PRICE_USD_ORIG, DISCOUNT_PCT, FX_USD_HKD, PLUS_PRICE_USD_SUB, PRO_PRICE_USD_SUB } = await import('../services/payment.js');
  const { usageStore } = await import('../services/usage.js');

  // ===== 定价审查 =====
  const STRIPE_RATE = 3.4; // Stripe 标准 2.9% + $0.30 ≈ 按 3.4% 估算（含固定费摊薄）
  const TARGET_MARGIN = 85; // 目标贡献毛利率
  const plans = ['plus', 'pro'] as const;
  const pricingOffers: any[] = [];
  for (const p of plans) {
    const usd = getUsdPrice(p);
    const hkd = getHkdPrice(p);
    const cny = getCnyPrice(p);
    const unitCostUsd = p === 'pro' ? 0.04 : 0.02; // 单用户月均 API 成本估算（DeepSeek 极低）
    const channelCost = usd * STRIPE_RATE / 100;
    const contribution = usd - unitCostUsd - channelCost;
    const margin = usd > 0 ? (contribution / usd) * 100 : 0;
    const origUsd = p === 'pro' ? PRO_PRICE_USD_ORIG : PLUS_PRICE_USD_ORIG;
    const origCny = p === 'pro' ? PRO_PRICE_CNY_ORIG : PLUS_PRICE_CNY_ORIG;
    pricingOffers.push({
      plan: p,
      name: p === 'pro' ? 'Pro' : 'Plus',
      usd, hkd, cny,
      originalUsd: origUsd,
      originalCny: origCny,
      discountPct: DISCOUNT_PCT,
      unitCostUsd,
      stripeChannelCost: Math.round(channelCost * 10000) / 10000,
      contributionUsd: Math.round(contribution * 10000) / 10000,
      contributionMarginPct: Math.round(margin * 10) / 10,
      status: margin >= TARGET_MARGIN ? 'healthy' : 'watch',
    });
  }
  // 渠道价差检查（USD vs CNY 折算价差）
  const usdToCny = PRO_PRICE_USD > 0 ? (PRO_PRICE_CNY / PRO_PRICE_USD) : 7;
  const cnyImpliedUsd = (p: 'plus' | 'pro') => getCnyPrice(p) / usdToCny;
  const priceGapPlus = Math.abs(getUsdPrice('plus') - cnyImpliedUsd('plus')) / getUsdPrice('plus') * 100;
  const priceGapPro = Math.abs(getUsdPrice('pro') - cnyImpliedUsd('pro')) / getUsdPrice('pro') * 100;
  const maxGap = Math.max(priceGapPlus, priceGapPro);
  const priceConflicts = maxGap > 15
    ? [{ level: 'warn', message: `USD/CNY 渠道折算价差 ${Math.round(maxGap)}% 超过 15% 阈值，建议复核汇率与渠道定价` }]
    : [];

  // ===== 盈利能力（基于真实订单 + 用量）=====
  const allOrders = paymentStore.listAll();
  const unlocked = allOrders.filter(o => o.status === 'unlocked' && o.source !== 'free');
  let totalRevenue = 0, plusCount = 0, proCount = 0;
  for (const o of unlocked) {
    totalRevenue += o.price; // CNY 口径
    if (o.plan === 'pro') proCount++;
    else plusCount++;
  }
  const apiCost = usageStore.totalCost ? usageStore.totalCost() : 0;
  const otherExpenses = expenseStore.total();
  const totalCost = apiCost + otherExpenses;
  const profit = totalRevenue - totalCost;
  const profitMarginPct = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

  // 月化测算（假设 60 付费用户：30 plus + 15 pro 微信 + 15 海外混合，用 USD 口径估）
  const monthly = {
    plusUsdRevenue: 30 * getUsdPrice('plus'),
    proUsdRevenue: 15 * getUsdPrice('pro'),
    plusCnyRevenue: 10 * getCnyPrice('plus'),
    proCnyRevenue: 5 * getCnyPrice('pro'),
  };
  const monthlyUsd = monthly.plusUsdRevenue + monthly.proUsdRevenue;
  const monthlyCny = monthly.plusCnyRevenue + monthly.proCnyRevenue;

  // ===== 连续包月 MRR（基于真实订阅，USD 口径）=====
  let subMrrUsd = 0, subCount = 0, subPlus = 0, subPro = 0, subCanceled = 0;
  try {
    const { subscriptionStore } = await import('../services/subscription.js');
    const subs = subscriptionStore.listAll();
    for (const s of subs) {
      if (s.status === 'canceled') { subCanceled++; continue; }
      if (s.status !== 'active') continue;
      subCount++;
      if (s.plan === 'pro') { subPro++; subMrrUsd += PRO_PRICE_USD_SUB; }
      else { subPlus++; subMrrUsd += PLUS_PRICE_USD_SUB; }
    }
  } catch { /* 订阅服务未就绪时忽略 */ }

  // ===== 商业模型闭环检查 =====
  const modelChecks = [
    { item: '收入来源', ok: plusCount + proCount > 0 || true, detail: `Plus/Pro 双档订阅（已解锁 ${unlocked.length} 单）` },
    { item: '支付渠道', ok: true, detail: 'Stripe（信用卡 / Link，自动解锁）为主通道；微信收款码为人工兜底（付费弹窗折叠块，2026-09-26 回到用户侧，需手动确认开通）' },
    { item: '成本结构', ok: totalCost < totalRevenue, detail: `API 成本 ¥${apiCost.toFixed(2)} + 其他支出 ¥${otherExpenses.toFixed(2)} vs 收入 ¥${totalRevenue}` },
    { item: '线上可用', ok: true, detail: 'myxiaoyu.com（Cloudflare HKG）' },
    { item: '证据', ok: unlocked.length > 0, detail: unlocked.length > 0 ? '有真实付费订单' : '尚无真实付费订单（仍可运行）' },
  ];

  res.json({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      // 定价
      pricing: {
        currencyOrder: ['USD', 'HKD', 'CNY'],
        fxUsdHkd: FX_USD_HKD,
        stripeRatePct: STRIPE_RATE,
        targetMarginPct: TARGET_MARGIN,
        offers: pricingOffers,
        priceConflicts,
      },
      // 盈利
      profitability: {
        currency: 'CNY',
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        apiCost: Math.round(apiCost * 10000) / 10000,
        otherExpenses: Math.round(otherExpenses * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        profitMarginPct: Math.round(profitMarginPct * 10) / 10,
        unlockedOrders: unlocked.length,
        plusOrders: plusCount,
        proOrders: proCount,
        // 连续包月 MRR（真实订阅，USD）
        subscription: {
          mrrUsd: Math.round(subMrrUsd * 100) / 100,
          activeCount: subCount,
          plusCount: subPlus,
          proCount: subPro,
          canceledCount: subCanceled,
        },
        monthlyProjection: {
          scenario: '假设 60 付费用户/月',
          usdRevenue: Math.round(monthlyUsd * 100) / 100,
          cnyRevenue: Math.round(monthlyCny * 100) / 100,
        },
      },
      // 商业模型
      model: {
        status: modelChecks.every(c => c.ok) ? 'ready' : 'partial',
        decision: 'proceed',
        checks: modelChecks,
      },
    },
  });
});

/**
 * 运营端：UGC 精选（用户已投稿的自建剧本，运营人工挑选，分层：待审核/一般/精选/已驳回）
 * GET  /api/payment/admin/ugc                              → 所有已投稿剧本（含作者信息，邮箱打码，含 status/reviewNote 全文）
 * POST /api/payment/admin/ugc/:id/approve                  → 通过（→ 一般公开 approved）
 * POST /api/payment/admin/ugc/:id/reject  { note }         → 驳回 + 反馈（note 必填；→ rejected）
 * POST /api/payment/admin/ugc/:id/withdraw                 → 撤回（从公开撤下 → 待审核 pending）
 * POST /api/payment/admin/ugc/:id/feature  { featured }    → 设/取消精选
 */
router.get('/ugc', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
  const list = customRoleplayStore.listPublished().map((s) => {
    const acc = accountStore.getById(s.userId);
    return {
      id: s.id,
      title: s.title,
      aiName: s.aiName,
      aiPersona: s.aiPersona,
      background: s.background,
      opening: s.opening,
      published: true,
      status: s.status || 'pending',
      featured: !!s.featured,
      featuredAt: s.featuredAt || null,
      reviewNote: s.reviewNote || null,
      reviewedAt: s.reviewedAt || null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      likes: getDisplayLikes(s.id),
      author: acc?.username || acc?.email?.split('@')[0] || '匿名',
    };
  });
  res.json({ success: true, data: list });
});

router.post('/ugc/:id/feature', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
  const rec = customRoleplayStore.setFeatured(String(req.params.id), !!req.body?.featured);
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在或未投稿' });
    return;
  }
  res.json({ success: true, data: rec });
});

router.post('/ugc/:id/approve', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
  const rec = customRoleplayStore.approve(String(req.params.id));
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在或未投稿' });
    return;
  }
  res.json({ success: true, data: rec });
});

router.post('/ugc/:id/reject', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
  const note = String(req.body?.note || '').trim();
  if (!note) {
    res.status(400).json({ success: false, error: '请填写驳回评价/修改建议' });
    return;
  }
  const rec = customRoleplayStore.reject(String(req.params.id), note);
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在或未投稿' });
    return;
  }
  res.json({ success: true, data: rec });
});

router.post('/ugc/:id/withdraw', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
  const rec = customRoleplayStore.withdraw(String(req.params.id));
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在或未投稿' });
    return;
  }
  res.json({ success: true, data: rec });
});

/**
 * 运营端：新人福利——给当前无会员的注册用户开通 7 天 Pro 试用 + 按其 IP 地区语言发恭喜邮件。
 * POST /api/payment/admin/newcomer-pro-trial
 *   ?apply=1    真实执行（缺省即 dry-run：只统计、不发信、不改数据）
 *   &force=1    忽略已有 marker 重新处理全部符合者（新一轮/重跑用；普通重跑不加）
 *   &exclude=   逗号分隔要排除的 userId 或邮箱（如 joy 的邮箱/ID）
 *   &days=N     试用天数（缺省 .env PRO_TRIAL_DAYS / 7）
 *   &backup=1   apply 时自动做一致性备份；dry-run 也可显式要求（仅做备份+统计）
 * 返回：{ success, data: NewcomerRunReport }
 */
router.post('/newcomer-pro-trial', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const apply = String(req.query?.apply ?? req.body?.apply ?? '') === '1';
  const force = String(req.query?.force ?? req.body?.force ?? '') === '1';
  const days = Number(req.query?.days ?? req.body?.days ?? 0);
  const wantBackup = apply || String(req.query?.backup ?? req.body?.backup ?? '') === '1';
  const exclude = String(req.query?.exclude ?? req.body?.exclude ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let backupPath: string | undefined;
  if (wantBackup) {
    try {
      backupPath = backupDataToTemp();
    } catch (e) {
      res.status(500).json({ success: false, error: '备份失败，已中止（防止未备份即改数据）', detail: (e as Error)?.message });
      return;
    }
  }

  const report = await runNewcomerProTrial({
    days: days > 0 ? days : undefined,
    dryRun: !apply,
    force,
    exclude,
    backupPath,
  });
  res.json({ success: true, data: report });
});

/**
 * 运营端：节日礼——给「所有注册用户」赠送 N 天完整 Pro（含活动窗口内新注册的用户）。
 * POST /api/payment/admin/holiday-gift
 *   ?apply=1    真实执行（缺省即 dry-run：只统计、不改数据）
 *   &force=1    忽略 marker 重新处理全部候选（⚠️ 会重复延长时间，仅特殊情况下用）
 *   &days=N     赠送天数（缺省 .env HOLIDAY_GIFT_DAYS / 1）
 *   &exclude=   逗号分隔要排除的 userId 或邮箱
 *   &backup=1   dry-run 也做一致性备份（apply 缺省即备份）
 * 活动标识/窗口读 .env：HOLIDAY_GIFT_ID / HOLIDAY_GIFT_START / HOLIDAY_GIFT_END。
 * 返回：{ success, data: HolidayGiftRunReport }
 */
router.post('/holiday-gift', (req: Request, res: Response): void => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const apply = String(req.query?.apply ?? req.body?.apply ?? '') === '1';
  const force = String(req.query?.force ?? req.body?.force ?? '') === '1';
  const days = Number(req.query?.days ?? req.body?.days ?? 0);
  const wantBackup = apply || String(req.query?.backup ?? req.body?.backup ?? '') === '1';
  const exclude = String(req.query?.exclude ?? req.body?.exclude ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let backupPath: string | undefined;
  if (wantBackup) {
    try {
      backupPath = backupDataToTemp('holiday-gift-backup');
    } catch (e) {
      res.status(500).json({ success: false, error: '备份失败，已中止（防止未备份即改数据）', detail: (e as Error)?.message });
      return;
    }
  }

  try {
    const report = runHolidayGift({
      days: days > 0 ? days : undefined,
      dryRun: !apply,
      force,
      exclude,
      backupPath,
    });
    res.json({ success: true, data: report });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error)?.message || '执行失败' });
  }
});

/**
 * 运营端：节日礼·站内三语公告（幂等：同一 HOLIDAY_GIFT_ID 只发一次）。
 * POST /api/payment/admin/holiday-gift/announce?apply=1
 *   ?apply=1  真实发布（缺省 dry-run：只回传将发布的文案）
 * 返回：{ success, data: HolidayGiftAnnounceResult }
 */
router.post('/holiday-gift/announce', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const apply = String(req.query?.apply ?? req.body?.apply ?? '') === '1';
  try {
    const { publishHolidayGiftAnnouncement } = await import('../services/holidayGiftMail.js');
    const result = await publishHolidayGiftAnnouncement({ apply });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error)?.message || '发布公告失败' });
  }
});

/**
 * 运营端：节日礼·群发邮件（走独立群发通道 CAMPAIGN_SMTP_*，默认 myxiaoyu2026@gmail.com；
 * 不占主通道验证码/改密的额度）。给所有注册用户发「你已获得 N 天完整 Pro」。
 * POST /api/payment/admin/holiday-gift/mail
 *   ?apply=1    真实发送（缺省 dry-run：只出名单/样例/预估）
 *   &limit=N    本次发送上限（不得超过 HOLIDAY_GIFT_MAIL_HARD_LIMIT，默认 200）
 *   &sample=N   dry-run 样例封数（默认 3）
 *   &crisis=1   允许发给处于情绪危机的用户（默认排除，见服务注释）
 * 返回：{ success, data: HolidayGiftMailSummary }
 */
router.post('/holiday-gift/mail', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const apply = String(req.query?.apply ?? req.body?.apply ?? '') === '1';
  const limit = Number(req.query?.limit ?? req.body?.limit ?? 0);
  const sampleCount = Number(req.query?.sample ?? req.body?.sample ?? 0);
  const includeCrisis = String(req.query?.crisis ?? req.body?.crisis ?? '') === '1';
  try {
    const { runHolidayGiftMail } = await import('../services/holidayGiftMail.js');
    const summary = await runHolidayGiftMail({
      apply,
      limit: limit > 0 ? limit : undefined,
      sampleCount: sampleCount > 0 ? sampleCount : undefined,
      includeCrisis,
    });
    res.json({ success: true, data: summary });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error)?.message || '发送失败' });
  }
});

/**
 * 运营端：补发「注册即送对话额度」——限时活动窗口（CHAT_BONUS_START/END）漏发的一次性补齐（2026-09-25）。
 * POST /api/payment/admin/register-bonus-backfill
 *   ?apply=1    真实执行（缺省即 dry-run：只统计候选，不补发、不发信）
 *   &force=1    忽略已有 marker 重新处理全部候选（⚠️ 会重复补发，仅特殊情况下用）
 *   &count=N    补发条数（缺省 .env REGISTER_CHAT_BONUS / 20）
 *   &exclude=   逗号分隔要排除的 userId 或邮箱
 *   &backup=1   apply 时自动做一致性备份（apply 缺省即做）
 *   &since=YYYY-MM-DD  覆盖「漏发窗口结束」（缺省钉死 2026-09-06，不读 .env，见服务注释）
 * 返回：{ success, data: RegisterBonusRunReport }
 */
router.post('/register-bonus-backfill', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  // ?retry=1：只重发「额度已补、邮件没发出去」的那几个人（不重复补额度）
  if (String(req.query?.retry ?? req.body?.retry ?? '') === '1') {
    const via = String(req.query?.via ?? req.body?.via ?? 'campaign') === 'default' ? 'default' : 'campaign';
    const emails = String(req.query?.emails ?? req.body?.emails ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const retry = await runRegisterBonusEmailRetry({ via, ...(emails.length ? { emails } : {}) });
    res.json({ success: true, data: retry });
    return;
  }
  const apply = String(req.query?.apply ?? req.body?.apply ?? '') === '1';
  const force = String(req.query?.force ?? req.body?.force ?? '') === '1';
  const wantBackup = apply || String(req.query?.backup ?? req.body?.backup ?? '') === '1';
  const count = Number(req.query?.count ?? req.body?.count ?? 0);
  const sinceRaw = String(req.query?.since ?? req.body?.since ?? '').trim();
  const exclude = String(req.query?.exclude ?? req.body?.exclude ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let sinceMs: number | undefined;
  if (sinceRaw) {
    if (!isValidYmd(sinceRaw)) {
      res.status(400).json({ success: false, error: 'since 需为 YYYY-MM-DD' });
      return;
    }
    sinceMs = new Date(sinceRaw + 'T23:59:59').getTime();
  }

  let backupPath: string | undefined;
  if (wantBackup) {
    try {
      backupPath = backupDataToTemp('register-bonus-backfill');
    } catch (e) {
      res.status(500).json({ success: false, error: '备份失败，已中止（防止未备份即改数据）', detail: (e as Error)?.message });
      return;
    }
  }

  const report = await runRegisterBonusBackfill({
    count: count > 0 ? count : undefined,
    dryRun: !apply,
    force,
    exclude,
    sinceMs,
    backupPath,
  });
  res.json({ success: true, data: report });
});

/**
 * 运营账号（「🛠 运营账号」面板，2026-09-18 用户要求）：
 * 「在控制台可以单独控制这个账号的所有功能」——默认 Pro、可切 Plus/Free、且不过期。
 *
 * 口径：
 *  - 只认**运营账号**（`isDeveloperAccount`，邮箱由 .env 的 DEV_ACCOUNTS 配置）。它一直是
 *    「不进用户列表 / 不进统计 / 不收运营邮件」的（见 accountFilters），所以在控制台**看不见它**，
 *    这个面板就是它唯一的入口。
 *  - 「全功能开放」= `quotaStore.setOpsMode(userId, true, plan)`：档位锁定为所选档位 + 永不到期，
 *    底层所有额度/功能判定都走 `getPlan()`，因此一处开关即覆盖全部功能（无限点数、不限额、更长上下文…）。
 *  - **不动**账号原本的 plan / unlockUntil 记录：关掉即原样回到普通账号，历史不丢。
 *  - 红线不变：内容安全过滤（`safety.ts`）与 18+ 成人确认**不受此开关影响**。
 */
function opsAccountSummary(userId: string) {
  const acc = accountStore.getById(userId);
  if (!acc) return null;
  const raw = quotaStore.getRecord(userId);
  const q = quotaStore.getQuota(userId);
  const ops = quotaStore.getOpsState(userId);
  return {
    userId,
    name: acc.username || acc.email.split('@')[0],
    email: acc.email,
    ops,
    effective: {
      plan: q.plan,
      unlocked: q.unlocked,
      creditUnlimited: q.creditUnlimited,
      creditDailyCap: q.creditDailyCap,
      chatLimitPerDay: q.chatLimitPerDay,
      contextWindow: quotaStore.getContextWindow(userId),
      maxMemoryFacts: quotaStore.getMaxMemoryFacts(userId),
      lifetime: q.lifetime,
      unlockUntil: q.unlockUntil,
      unlockUntilText: q.unlockUntil ? new Date(q.unlockUntil).toLocaleString('zh-CN') : null,
    },
    raw: {
      plan: raw?.plan || 'free',
      unlockUntil: raw?.unlockUntil || null,
      unlockUntilText: raw?.unlockUntil ? new Date(raw.unlockUntil).toLocaleString('zh-CN') : null,
      trialProUntil: raw?.trialProUntil || null,
    },
  };
}

router.get('/ops-account', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const accounts = (accountStore.listAll() || []).filter(a => isDeveloperAccount(a));
  if (!accounts.length) { res.json({ success: true, data: { accounts: [], note: '未配置运营账号（DEV_ACCOUNTS）' } }); return; }
  const { WEREWOLF_FREE_DAILY_LIMIT, WEREWOLF_PLUS_DAILY_LIMIT, WEREWOLF_DAILY_LIMIT } = await import('../services/quota.js');
  const { preferenceStore } = await import('../services/preferences.js');
  const data = accounts.map(a => {
    const s = opsAccountSummary(a.userId);
    const pref = preferenceStore.listAll().find(p => p.userId === a.userId) || null;
    return {
      ...s,
      caps: {
        werewolfFree: WEREWOLF_FREE_DAILY_LIMIT,
        werewolfPlus: WEREWOLF_PLUS_DAILY_LIMIT,
        werewolfPro: WEREWOLF_DAILY_LIMIT,
      },
      pref: pref ? {
        roleplayUnlimited: !!pref.roleplayUnlimited,
        thinkingLevel: pref.thinkingLevel,
        proactivePush: !!pref.proactivePush,
        language: pref.language,
      } : null,
    };
  });
  res.json({ success: true, data: { accounts: data } });
});

/**
 * 运营账号：开启/关闭「全功能开放（不过期）」并选档位
 * POST /api/payment/admin/ops-account?userId=xxx&enabled=1&plan=pro|plus|free
 */
router.post('/ops-account', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const userId = String(req.query?.userId || '').trim();
  const acc = userId ? accountStore.getById(userId) : (accountStore.listAll() || []).find(a => isDeveloperAccount(a));
  if (!acc) { res.status(404).json({ success: false, error: '运营账号不存在' }); return; }
  // 兜底：只允许改运营账号（避免误伤真实用户）——想给普通用户开会员请用「开通 Plus/Pro」
  if (!isDeveloperAccount(acc)) { res.status(400).json({ success: false, error: '该账号不是运营账号（此接口只用于运营账号）' }); return; }
  const enabled = String(req.query?.enabled ?? '1') !== '0';
  const rawPlan = String(req.query?.plan || 'pro');
  const plan: 'free' | 'plus' | 'pro' = rawPlan === 'plus' ? 'plus' : rawPlan === 'free' ? 'free' : 'pro';
  quotaStore.setOpsMode(acc.userId, enabled, plan);
  const { auditStore } = await import('../services/audit.js');
  auditStore.log('ops_account', `运营账号功能：${acc.email} → ${enabled ? `全功能开放（${plan} · 不过期）` : '关闭（恢复普通账号）'}`, req.ip || '');
  res.json({ success: true, data: { userId: acc.userId, ops: quotaStore.getOpsState(acc.userId), summary: opsAccountSummary(acc.userId) } });
});

export default router;
