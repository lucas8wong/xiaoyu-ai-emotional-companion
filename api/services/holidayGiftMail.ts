/**
 * 国庆节日礼通知：**站内三语公告 + 群发邮件**（"你已获得 N 天完整 Pro"）。
 *
 * 与 `holidayGift.ts`（只管授权）刻意分开：授权是数据变更，通知是运营动作，两者的 dry-run/幂等/上限
 * 口径不同，混在一个模块里会让"发没发信"和"发没发会员"互相牵连。
 *
 * 通道（用户 2026-10-01 明确要求「用 myxiaoyu2026@gmail 发，不占验证码那个邮箱」）：
 * 走 `sendEmail(..., { via: 'campaign' })` 的**独立群发 SMTP**（`CAMPAIGN_SMTP_*`，默认
 * `myxiaoyu2026@gmail.com`），与承载注册验证码/改密的 Resend 主通道**物理隔离**，
 * 且不消耗主通道的非关键邮件预算（见 `email.ts` 顶部注释）。
 *
 * 数据：只读 accounts / activity / roleplay-sessions；只新增 `data/holiday-gift-mail.json`
 * （投递记录，用于幂等与每日上限）；公告由 `announcementStore.addLangs` 写入。
 *
 * 合规（延续项目既有约定）：
 *  - 群发带一键退订（List-Unsubscribe），退订名单与召回共用（`reengageStore.optOut`）；
 *  - **默认不给处于情绪危机（自伤/自杀类）的用户发这封运营邮件**，用与 adultCampaign 同一口径
 *    （`isCrisisSafe`）；如需覆盖可显式传 `includeCrisis: true`；
 *  - 文案遵守品牌口径：陪伴非治疗、无医疗承诺、不出现 "China"。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore } from './accounts.js';
import { activityStore } from './activity.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import { reengageStore, unsubscribeToken, isCrisisSafe } from './reengage.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';
import { sendEmail, campaignTransportReady } from './email.js';
import { holidayGiftConfig } from './holidayGift.js';
import { inferLanguageForUser, type EmailLang } from './userLang.js';
import { toZhTw } from './zhConvert.js';

const LOG_FILE = dataFile('holiday-gift-mail.json');
const SITE = process.env.SITE_URL || 'https://myxiaoyu.com/';
const FROM_NAME = 'Xiaoyu';
/** 每日发信上限：沿用群发通道既有口径（Gmail 侧另有自己的日限额，这里只做更保守的前置刹车） */
const DAILY_CAP = Number(process.env.CAMPAIGN_DAILY_CAP || 100);
/** 显式指定 limit 时的硬上限：防止一次调用把 Gmail 日额度打穿 */
const HARD_LIMIT = Number(process.env.HOLIDAY_GIFT_MAIL_HARD_LIMIT || 200);
/**
 * 每封之间的间隔（ms）：Gmail 消费级账号短时间连发容易被临时限流（421），
 * 加一点间隔让一次批量既在 HTTP 超时内完成、又不至于触发风控。0 = 不间隔。
 */
const SEND_DELAY_MS = Number(process.env.HOLIDAY_GIFT_MAIL_DELAY_MS || 800);

// ---------------------------------------------------------------------------
// 三语文案（公告 + 邮件共用一份，避免两处口径漂移）
// ---------------------------------------------------------------------------
export interface HolidayGiftCopy {
  annZhCN: { title: string; content: string };
  annZhTW: { title: string; content: string };
  annEn: { title: string; content: string };
}

/** 站内三语公告文案（节日礼） */
export function holidayGiftCopy(days: number): HolidayGiftCopy {
  const d = days > 0 ? days : 1;
  return {
    annZhCN: {
      title: `假期快乐 🎁 送你 ${d} 天完整 Pro`,
      content: `这个假期，小愈送你 ${d} 天完整 Pro：无限畅聊、更长上下文、AI 剧情与自创角色全部解锁。已自动到账，无需任何操作，打开就能用。`,
    },
    annZhTW: {
      title: `連假愉快 🎁 送你 ${d} 天完整 Pro`,
      content: `這個假期，小愈送你 ${d} 天完整 Pro：無限暢聊、更長上下文、AI 劇情與自創角色全部解鎖。已自動到帳，無需任何操作，打開就能用。`,
    },
    annEn: {
      title: `A holiday gift 🎁 — ${d} day${d > 1 ? 's' : ''} of Pro, on us`,
      content: `This holiday, Xiaoyu is giving you ${d} day${d > 1 ? 's' : ''} of full Pro: unlimited chats, longer context, AI stories and custom characters all unlocked. It is already in your account — no action needed, just open Xiaoyu.`,
    },
  };
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 品牌邮件外壳（与 proTrialNewcomer/adultCampaign 同一视觉：主绿/奶油底/墨绿字） */
function shell(body: string, cta: string, ctaText: string, footer: string, unsubUrl: string, unsubText: string): string {
  return `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:460px;margin:0 auto;background:#FBF6EE;border-radius:16px;padding:28px 24px;border:1px solid #E4E0D4">
      <div style="text-align:center;margin-bottom:18px">
        <div style="font-size:34px;line-height:1">🌱</div>
        <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#178353">Xiaoyu · 小愈</p>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
      </div>
      <div style="background:#FFFFFF;border-radius:12px;padding:22px;border:1px solid #DCE8D5">
        ${body}
        <div style="text-align:center;margin-top:18px">
          <a href="${cta}" style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">${ctaText}</a>
        </div>
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:#A0A7B5;text-align:center;line-height:1.7">${footer}<br/>${unsubText} <a href="${unsubUrl}" style="color:#178353;text-decoration:underline">unsubscribe</a></p>
    </div>`;
}

/** 渲染一封节日礼邮件（HTML + 纯文本 + 主题）；zh-TW 由 zh-CN 经 opencc 转繁体，避免简繁错误 */
export function renderHolidayGiftEmail(
  lang: EmailLang,
  opts: { days: number; nickname?: string; unsubUrl: string },
): { subject: string; html: string; text: string } {
  const d = opts.days > 0 ? opts.days : 1;
  const name = (opts.nickname || '').trim() ? `Dear <b>${esc(opts.nickname!.trim().slice(0, 20))}</b>,` : 'Hi there,';
  const zhName = (opts.nickname || '').trim() ? `亲爱的 <b>${esc(opts.nickname!.trim().slice(0, 20))}</b>，` : '你好，';
  const cta = SITE;

  if (lang === 'en') {
    const subject = `🎁 ${d} day${d > 1 ? 's' : ''} of full Pro is already yours`;
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.75">${name}<br/>
        A gift from Xiaoyu for the holiday: your account has been upgraded to <b style="color:#1FA46B">${d} day${d > 1 ? 's' : ''} of full Pro</b> 🎁.</p>
      <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.75">While it lasts you get unlimited chats, longer context, and full access to AI stories and characters you create.</p>
      <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.75">No action needed — it is already in your account. Just open Xiaoyu and enjoy. 💛</p>`;
    const text = `A gift from Xiaoyu for the holiday: your account has been upgraded to ${d} day${d > 1 ? 's' : ''} of full Pro.

While it lasts you get unlimited chats, longer context, and full access to AI stories and characters you create.

No action needed — just open Xiaoyu: ${cta}

Unsubscribe: ${opts.unsubUrl}
Every feeling deserves to be understood.`;
    return { subject, html: shell(body, cta, 'Open Xiaoyu →', 'Every feeling deserves to be understood.', opts.unsubUrl, 'Prefer not to get emails like this?'), text };
  }

  const zhSubject = `🎁 送你 ${d} 天完整 Pro，已到账`;
  const zhBody = `
    <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.75">${zhName}<br/>
      小愈为你准备了一份节日礼物，你的账户已免费开通 <b style="color:#1FA46B">${d} 天完整 Pro</b> 🎁。</p>
    <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.75">在这段时间里，你可以无限畅聊、享受更长的上下文，还能畅玩 AI 剧情与自创角色。</p>
    <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.75">无需任何操作，它已经在你的账户里了。打开 Xiaoyu 就能用。💛</p>`;
  const zhHtml = shell(zhBody, cta, '进入 Xiaoyu →', '你的每一种情绪，都值得被理解。', opts.unsubUrl, '不想再收到这类邮件？');
  const zhText = `小愈为你准备了一份节日礼物，你的账户已免费开通 ${d} 天完整 Pro。

在这段时间里，你可以无限畅聊、享受更长的上下文，还能畅玩 AI 剧情与自创角色。

无需任何操作，打开 Xiaoyu 就能用：${cta}

不想再收到这类邮件：${opts.unsubUrl}
你的每一种情绪，都值得被理解。`;

  if (lang === 'zh-TW') return { subject: toZhTw(zhSubject), html: toZhTw(zhHtml), text: toZhTw(zhText) };
  return { subject: zhSubject, html: zhHtml, text: zhText };
}

// ---------------------------------------------------------------------------
// 投递记录（幂等 + 每日上限）
// ---------------------------------------------------------------------------
interface HolidayGiftMailRecord {
  campaignId: string; userId: string; email: string; lang: string; sentAt: number; ok: boolean; error?: string;
}
interface HolidayGiftMailState {
  records: HolidayGiftMailRecord[];
  /** campaignId → 已发布公告记录（幂等） */
  announced?: Record<string, { at: number; id: string }>;
}

function readState(): HolidayGiftMailState {
  const s = readJson<HolidayGiftMailState | null>(LOG_FILE, null);
  if (!s) return { records: [] };
  return { records: Array.isArray(s.records) ? s.records : [], announced: s.announced || {} };
}
function saveState(s: HolidayGiftMailState): void {
  try { writeJson(LOG_FILE, s); } catch { /* 记录失败不阻塞发信 */ }
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 本活动是否已成功投递过（失败的不算，允许重试） */
export function isHolidayGiftMailSent(userId: string, campaignId: string): boolean {
  return readState().records.some((r) => r.campaignId === campaignId && r.userId === userId && r.ok);
}

/** 本活动今日已成功投递数 */
export function holidayGiftMailSentToday(campaignId: string): number {
  const key = localDateKey(Date.now());
  return readState().records.filter((r) => r.campaignId === campaignId && r.ok && localDateKey(r.sentAt) === key).length;
}

// ---------------------------------------------------------------------------
// 名单筛选
// ---------------------------------------------------------------------------
export type HolidayGiftMailExclusion = 'noEmail' | 'testOrDev' | 'optedOut' | 'crisis' | 'duplicateEmail' | 'alreadySent';

export interface HolidayGiftMailRecipient {
  userId: string;
  email: string;
  nickname?: string;
  lang: EmailLang;
  unsubUrl: string;
}

export interface HolidayGiftMailPlan {
  campaignId: string;
  days: number;
  recipients: HolidayGiftMailRecipient[];
  excluded: Record<HolidayGiftMailExclusion, number>;
  byLang: Record<string, number>;
  alreadySent: number;
  transport: { ready: boolean; reason: string; from: string };
  dailyCap: number;
  sentToday: number;
  estimatedDays: number;
}

function crisisSafeFor(userId: string): boolean {
  const act = activityStore.get(userId);
  const recent = (act?.recentActivity || []).slice(-3).map((x) => x.detail || '').join('\n');
  const sessions = roleplaySessionStore.listAll().filter((r) => r.userId === userId && Array.isArray(r.messages) && r.messages.length);
  const latest = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const rpText = latest ? latest.messages.slice(-3).map((m) => m.content || '').join('\n').slice(0, 400) : '';
  return isCrisisSafe(`${recent}\n${rpText}`);
}

/**
 * 生成群发计划（dry-run 与 apply 共用）。默认排除测试/开发者、已退订、情绪危机用户，
 * 以及已成功投递过本活动的用户（幂等）。`includeCrisis: true` 可覆盖危机排除。
 */
export function planHolidayGiftMail(opts: { includeCrisis?: boolean } = {}): HolidayGiftMailPlan {
  const cfg = holidayGiftConfig();
  const campaignId = cfg.campaignId;
  if (!campaignId) throw new Error('未配置 HOLIDAY_GIFT_ID（节日礼活动标识），拒绝发送通知');
  const state = readState();
  const excluded: Record<HolidayGiftMailExclusion, number> = {
    noEmail: 0, testOrDev: 0, optedOut: 0, crisis: 0, duplicateEmail: 0, alreadySent: 0,
  };
  const recipients: HolidayGiftMailRecipient[] = [];
  const seen = new Set<string>();
  let alreadySent = 0;

  for (const acc of accountStore.listAll()) {
    const userId = acc.userId;
    const email = String(acc.email || '').trim().toLowerCase();
    if (!email) { excluded.noEmail++; continue; }
    if (isTestAccount(acc) || isDeveloperAccount(acc)) { excluded.testOrDev++; continue; }
    if (reengageStore.isOptedOut(userId)) { excluded.optedOut++; continue; }
    if (!opts.includeCrisis && !crisisSafeFor(userId)) { excluded.crisis++; continue; }
    if (seen.has(email)) { excluded.duplicateEmail++; continue; }
    if (state.records.some((r) => r.campaignId === campaignId && r.userId === userId && r.ok)) { excluded.alreadySent++; alreadySent++; continue; }
    seen.add(email);
    recipients.push({
      userId,
      email,
      nickname: (acc.username || '').trim() || undefined,
      lang: inferLanguageForUser(userId),
      unsubUrl: `${SITE}api/reengage/unsubscribe?userId=${encodeURIComponent(userId)}&token=${unsubscribeToken(userId)}&src=campaign`,
    });
  }

  const byLang: Record<string, number> = {};
  for (const r of recipients) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
  const sentToday = state.records.filter((r) => r.campaignId === campaignId && r.ok && localDateKey(r.sentAt) === localDateKey(Date.now())).length;
  const remainingToday = Math.max(0, DAILY_CAP - sentToday);
  // 先填满今天剩余额度，再按每天 DAILY_CAP 估算还要几天（今天算第 1 天）
  const todayQuota = Math.min(recipients.length, remainingToday);
  const estimatedDays = recipients.length === 0 ? 0 : 1 + Math.ceil((recipients.length - todayQuota) / Math.max(1, DAILY_CAP));

  return {
    campaignId, days: cfg.days, recipients, excluded, byLang, alreadySent,
    transport: campaignTransportReady(),
    dailyCap: DAILY_CAP, sentToday, estimatedDays,
  };
}

export interface HolidayGiftMailSummary {
  applied: boolean;
  campaignId: string;
  days: number;
  planned: number;
  sent: number;
  failed: number;
  skippedByCap: number;
  alreadySent: number;
  excluded: Record<HolidayGiftMailExclusion, number>;
  byLang: Record<string, number>;
  transport: { ready: boolean; reason: string; from: string };
  dailyCap: number;
  sentToday: number;
  estimatedDays: number;
  samples: { userId: string; email: string; lang: string; subject: string; html: string; text: string }[];
  errors: { userId: string; email: string; detail: string }[];
}

/**
 * 跑一次节日礼群发。
 * @param opts.apply false（默认）= dry-run：只出名单/样例/预估，不发信；
 *                    true = 真发，受 HARD_LIMIT 与幂等记录约束。
 * @param opts.limit 显式批量上限（不得超过 HARD_LIMIT）；缺省 = 当日剩余额度。
 */
export async function runHolidayGiftMail(opts: { apply?: boolean; limit?: number; sampleCount?: number; includeCrisis?: boolean } = {}): Promise<HolidayGiftMailSummary> {
  const plan = planHolidayGiftMail({ includeCrisis: opts.includeCrisis });
  const summary: HolidayGiftMailSummary = {
    applied: !!opts.apply, campaignId: plan.campaignId, days: plan.days,
    planned: plan.recipients.length, sent: 0, failed: 0, skippedByCap: 0,
    alreadySent: plan.alreadySent, excluded: plan.excluded, byLang: plan.byLang,
    transport: plan.transport, dailyCap: plan.dailyCap, sentToday: plan.sentToday,
    estimatedDays: plan.estimatedDays, samples: [], errors: [],
  };

  const sampleCount = opts.sampleCount && opts.sampleCount > 0 ? Math.min(opts.sampleCount, 10) : 3;
  if (!opts.apply) {
    // 样例按语言各取一封（运营需逐语言过目），不足用前几封补
    const picked: HolidayGiftMailRecipient[] = [];
    const langs = new Set<string>();
    for (const r of plan.recipients) {
      if (!langs.has(r.lang)) { langs.add(r.lang); picked.push(r); }
      if (picked.length >= sampleCount) break;
    }
    for (const r of plan.recipients) {
      if (picked.length >= sampleCount) break;
      if (!picked.includes(r)) picked.push(r);
    }
    summary.samples = picked.map((r) => {
      const mail = renderHolidayGiftEmail(r.lang, { days: plan.days, nickname: r.nickname, unsubUrl: r.unsubUrl });
      return { userId: r.userId, email: r.email, lang: r.lang, subject: mail.subject, html: mail.html, text: mail.text };
    });
    return summary;
  }

  if (!plan.transport.ready) {
    throw new Error(`群发通道未就绪：${plan.transport.reason}`);
  }

  const remainingToday = Math.max(0, DAILY_CAP - plan.sentToday);
  const requested = opts.limit && opts.limit > 0 ? Math.min(opts.limit, HARD_LIMIT) : remainingToday;
  const want = Math.min(requested, plan.recipients.length);
  const batch = plan.recipients.slice(0, want);
  summary.skippedByCap = Math.max(0, plan.recipients.length - batch.length);

  const state = readState();
  for (let i = 0; i < batch.length; i += 1) {
    const r = batch[i];
    const mail = renderHolidayGiftEmail(r.lang, { days: plan.days, nickname: r.nickname, unsubUrl: r.unsubUrl });
    const res = await sendEmail(r.email, mail.subject, mail.html, FROM_NAME, {
      unsubUrl: r.unsubUrl, text: mail.text, via: 'campaign',
    });
    state.records.push({
      campaignId: plan.campaignId, userId: r.userId, email: r.email, lang: r.lang,
      sentAt: Date.now(), ok: res.ok, error: res.ok ? undefined : res.detail,
    });
    if (state.records.length > 20000) state.records = state.records.slice(-20000);
    if (res.ok) summary.sent++;
    else { summary.failed++; summary.errors.push({ userId: r.userId, email: r.email, detail: res.detail }); }
    if (SEND_DELAY_MS > 0 && i < batch.length - 1) await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
  }
  saveState(state);
  return summary;
}

// ---------------------------------------------------------------------------
// 站内三语公告
// ---------------------------------------------------------------------------
export interface HolidayGiftAnnounceResult {
  applied: boolean;
  campaignId: string;
  existed: boolean;
  announcementId?: string;
  copy: HolidayGiftCopy;
}

/**
 * 发布节日礼三语公告（幂等：同一活动只发一次，按标题命中即跳过）。
 * apply=false 时只回传将发布的文案，不写公告。
 */
export async function publishHolidayGiftAnnouncement(opts: { apply?: boolean } = {}): Promise<HolidayGiftAnnounceResult> {
  const cfg = holidayGiftConfig();
  const campaignId = cfg.campaignId;
  if (!campaignId) throw new Error('未配置 HOLIDAY_GIFT_ID（节日礼活动标识），拒绝发布公告');
  const copy = holidayGiftCopy(cfg.days);
  const state = readState();
  const prev = state.announced?.[campaignId];
  if (prev) return { applied: false, campaignId, existed: true, announcementId: prev.id, copy };

  if (!opts.apply) return { applied: false, campaignId, existed: false, copy };

  const { announcementStore } = await import('./announcements.js');
  const existing = announcementStore.list().find((a) => a.titleZh === copy.annZhCN.title);
  if (existing) {
    state.announced = { ...(state.announced || {}), [campaignId]: { at: Date.now(), id: existing.id } };
    saveState(state);
    return { applied: false, campaignId, existed: true, announcementId: existing.id, copy };
  }
  const a = announcementStore.addLangs({ zhCN: copy.annZhCN, zhTW: copy.annZhTW, en: copy.annEn });
  state.announced = { ...(state.announced || {}), [campaignId]: { at: Date.now(), id: a.id } };
  saveState(state);
  return { applied: true, campaignId, existed: false, announcementId: a.id, copy };
}
