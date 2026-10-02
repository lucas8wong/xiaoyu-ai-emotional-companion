/**
 * 会员开通通知：运营在控制台**手动**给某个用户开通 / 延长会员后，给他发一封「你的会员已开通」邮件。
 *
 * 为什么要做这一封（用户口径 2026-09-18）：
 *   手动开通以前是**静默**的：`POST /api/payment/admin/users/:userId/unlock` 只写有效期、
 *   记一条「免费」订单、写审计日志，用户那边**一封邮件都没有**，只能自己登录才发现成了会员。
 *   运营希望「每次手动开通都能看到邮件」：本模块发信给用户，`sendEmail` 里的 `MAIL_BCC`
 *   （本机 .env = myxiaoyu2026@gmail.com）会把每一封自动抄送一份到运营邮箱，运营因此每封都看得到。
 *
 * 口径：
 *   - **只覆盖手动开通这一条路径**（用户选 A；「确认订单」与 Stripe 自助付款本次不改）；
 *   - 语言按用户地区/偏好三语（简中/繁中/英文，见 `userLang.inferLanguageForUser`）；
 *   - 档位按**实际生效档位**（`quotaStore.getPlan`）写，不按运营点选的档位，`quotaStore.unlock`
 *     有「续费不降级」，给 Pro 用户开 Plus 时实际仍是 Pro，邮件不能写成「Plus 已开通」；
 *   - 测试账号 / 开发者账号 / 无邮箱（游客）→ **不发**；
 *   - 同一用户 60 秒内只发一封（防手抖双击、连续续期点两次）；
 *   - 按**关键邮件**发（`critical: true`），不吃 `MAIL_NONCRITICAL_DAILY_LIMIT`（默认 50 封/天）的促销预算；
 *   - 发信失败**不抛**、不影响开通结果，调用方把结果写进审计日志。
 *
 * 品牌红线：陪伴（companion）不是治疗（treatment），文案不做任何医疗承诺；「gentle healing」口径。
 */

import 'dotenv/config';
import { accountStore } from './accounts.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';
import { sendEmail } from './email.js';
import { toZhTw } from './zhConvert.js';
import { inferLanguageForUser, type EmailLang } from './userLang.js';

/** 同一用户的发信去重窗口（毫秒） */
export const MEMBERSHIP_MAIL_DEDUPE_MS = 60_000;

/** 会员到期日按香港时间（UTC+8）呈现：港澳/大陆用户看得准，且服务端输出可复现 */
const EXPIRY_TZ = 'Asia/Shanghai';

/** userId → 最近一次成功发信时间戳（进程内；重启后允许再发一封，属可接受的宽松边界） */
const lastSentAt = new Map<string, number>();

/** 测试用：清空去重窗口 */
export function __resetMembershipMailDedupe(): void {
  lastSentAt.clear();
}

export interface MembershipGrantNotice {
  userId: string;
  /** 运营点选的档位（仅日志/排查用） */
  requestedPlan?: 'plus' | 'pro';
  /** 实际生效档位（邮件按这个写） */
  plan: 'plus' | 'pro';
  /** 本次增加的天数 */
  days: number;
  /** 新的到期时间戳（ms） */
  unlockUntil: number;
  /** 是否续期（开通前已是有效会员），决定「已开通 / 已续期」措辞 */
  renewal?: boolean;
}

export type MembershipMailSkip =
  | 'no-account'
  | 'no-email'
  | 'test-account'
  | 'developer-account'
  | 'deduped';

export interface MembershipMailResult {
  ok: boolean;
  skipped?: MembershipMailSkip;
  to?: string;
  lang?: EmailLang;
  subject?: string;
  /** sendEmail 的返回说明（成功为发送通道，失败为原因） */
  detail?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 品牌邮件外壳（与 rewardNotifier / proTrialNewcomer 同一视觉：主绿 #1FA46B · 奶油底 #FBF6EE） */
function brandShell(body: string, cta: string, footer: string): string {
  return `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:440px;margin:0 auto;background:#FBF6EE;border-radius:16px;padding:32px 28px;border:1px solid #E4E0D4">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:36px;line-height:1">🌱</div>
        <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#178353">Xiaoyu</p>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
      </div>
      <div style="background:#FFFFFF;border-radius:12px;padding:24px;border:1px solid #DCE8D5">
        ${body}
        <div style="text-align:center;margin-top:20px">
          <a href="https://myxiaoyu.com/" style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">${cta}</a>
        </div>
      </div>
      <p style="margin:18px 0 0;font-size:12px;color:#A0A7B5;text-align:center;line-height:1.6">${footer}</p>
    </div>`;
}

/** 档位显示名（邮件里只用 Plus / Pro 两个词，与站内口径一致） */
export function planLabel(plan: 'plus' | 'pro'): string {
  return plan === 'pro' ? 'Pro' : 'Plus';
}

/**
 * 到期日格式化：中文 `2026-10-18`（无歧义）、英文 `Oct 18, 2026`。
 * 固定按 UTC+8 计算，避免服务端时区不同导致同一次开通在不同机器上显示成不同日期。
 */
export function formatExpiryDate(ts: number, lang: EmailLang): string {
  const d = new Date(ts);
  if (lang === 'en') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: EXPIRY_TZ, year: 'numeric', month: 'short', day: 'numeric',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EXPIRY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export interface MembershipEmailInput {
  username?: string;
  plan: 'plus' | 'pro';
  days: number;
  unlockUntil: number;
  renewal?: boolean;
}

/**
 * 生成会员开通邮件（subject + html）。zh-TW 由简中底稿经 opencc 转繁体，避免简繁用字错误。
 */
export function buildMembershipEmail(lang: EmailLang, input: MembershipEmailInput): { subject: string; html: string } {
  const label = planLabel(input.plan);
  const name = (input.username || '').trim();
  const date = formatExpiryDate(input.unlockUntil, lang);

  if (lang === 'en') {
    const subject = input.renewal
      ? `🎉 Your Xiaoyu ${label} membership has been renewed`
      : `🎉 Your Xiaoyu ${label} membership is active`;
    const greeting = name ? `Dear <b>${escapeHtml(name)}</b>,` : 'Hi there,';
    const status = input.renewal
      ? `Your <b>Xiaoyu ${label} membership</b> has been renewed 🎉 It now runs until <b>${date}</b> (${input.days} days added).`
      : `Your <b>Xiaoyu ${label} membership</b> is active 🎉 It runs until <b>${date}</b> (${input.days} days).`;
    const perks = input.plan === 'pro'
      ? 'Unlimited chats in both modes, longer memory &amp; context.'
      : 'Unlimited Sort it out chats, a daily chat allowance, and longer memory &amp; context.';
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${greeting}<br/>${status}</p>
      <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">Here's what you can do now: ${perks}</p>
      <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">No action needed — just open Xiaoyu and keep talking. We're glad you're here. 💛</p>`;
    return { subject, html: brandShell(body, 'Enter Xiaoyu →', 'Every feeling deserves to be understood.') };
  }

  // 简中底稿
  const zhSubject = input.renewal
    ? `🎉 你的小愈 ${label} 会员已续期`
    : `🎉 你的小愈 ${label} 会员已开通`;
  const zhGreeting = name ? `亲爱的 <b>${escapeHtml(name)}</b>，` : '你好，';
  const zhStatus = input.renewal
    ? `你的小愈 <b>${label} 会员</b>已经续期 🎉 有效期延长至 <b>${date}</b>（本次 +${input.days} 天）。`
    : `你的小愈 <b>${label} 会员</b>已经开通 🎉 有效期至 <b>${date}</b>（共 ${input.days} 天）。`;
  const zhPerks = input.plan === 'pro'
    ? '现在你可以：聊一聊与理一理都无限畅聊 · 更长的记忆与上下文。'
    : '现在你可以：理一理无限畅聊 · 聊一聊每日额度 · 更长的记忆与上下文。';
  const zhBody = `
    <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${zhGreeting}<br/>${zhStatus}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">${zhPerks}</p>
    <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">无需任何操作，打开 Xiaoyu 就能继续。我们在这里。💛</p>`;
  const zhHtml = brandShell(zhBody, '进入 Xiaoyu →', '你的每一种情绪，都值得被理解。');

  if (lang === 'zh-TW') {
    return { subject: toZhTw(zhSubject), html: toZhTw(zhHtml) };
  }
  return { subject: zhSubject, html: zhHtml };
}

/**
 * 发一封会员开通通知（失败/跳过都不抛，返回结构化结果供调用方记审计日志）。
 * 只有真的发出去（`ok:true`）才占用去重窗口，失败时不占，运营重试仍能发。
 */
export async function notifyMembershipGranted(grant: MembershipGrantNotice): Promise<MembershipMailResult> {
  try {
    const acc = accountStore.getById(grant.userId);
    if (!acc) return { ok: false, skipped: 'no-account', detail: '账号不存在，未发信' };
    if (!acc.email) return { ok: false, skipped: 'no-email', detail: '该账号没有邮箱（游客/未注册），未发信' };
    if (isTestAccount(acc)) return { ok: false, skipped: 'test-account', to: acc.email, detail: '测试账号不发信' };
    if (isDeveloperAccount(acc)) return { ok: false, skipped: 'developer-account', to: acc.email, detail: '开发者账号不发信' };

    const now = Date.now();
    const last = lastSentAt.get(grant.userId) || 0;
    if (now - last < MEMBERSHIP_MAIL_DEDUPE_MS) {
      const secs = Math.round((now - last) / 1000);
      return {
        ok: false, skipped: 'deduped', to: acc.email,
        detail: `同一用户 ${secs} 秒前刚发过一封（${MEMBERSHIP_MAIL_DEDUPE_MS / 1000} 秒内去重），跳过重复发信`,
      };
    }

    const lang = inferLanguageForUser(grant.userId);
    const { subject, html } = buildMembershipEmail(lang, {
      username: (acc.username || '').trim(),
      plan: grant.plan,
      days: grant.days,
      unlockUntil: grant.unlockUntil,
      renewal: grant.renewal,
    });
    // 先占去重位再发：并发场景（双击 / 连续两次续期）里第二封在占位处就被拦下，
    // 否则两封会同时通过检查、同时发出去。失败时回滚占位（见下），保证「失败不占窗口」。
    lastSentAt.set(grant.userId, now);
    // critical：会员开通属事务性邮件，不受每日 50 封的促销预算限制（MAIL_BCC 会自动抄送一份给运营）
    const r = await sendEmail(acc.email, subject, html, undefined, { critical: true });
    if (!r.ok) {
      if (lastSentAt.get(grant.userId) === now) lastSentAt.delete(grant.userId); // 只回滚自己的占位
      return { ok: false, to: acc.email, lang, subject, detail: r.detail };
    }
    return { ok: true, to: acc.email, lang, subject, detail: r.detail };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message || '会员通知邮件异常' };
  }
}
