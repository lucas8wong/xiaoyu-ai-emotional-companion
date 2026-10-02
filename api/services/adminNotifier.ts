/**
 * 运营通知：管理控制台出现需要运营处理的事件时，发邮件提醒。
 * - 新 UGC 投稿（自建剧本投稿，等待运营挑为精选）
 * - 待确认订单（用户点「我已付款」，等待运营确认到账解锁）
 * - 新用户反馈（「意见反馈」提交后，等待运营在控制台处理/发奖励），每条一封，含游客反馈；
 *   每日上限 ADMIN_NOTIFY_FEEDBACK_DAILY_CAP（默认 30，<=0 不限），超出只记日志、反馈照样进控制台。
 *
 * 收件地址：ADMIN_NOTIFY_EMAIL → MAIL_BCC → SMTP_FROM → SMTP_USER；都没配置则 console 日志兜底。
 * fire-and-forget：绝不抛错、不阻塞用户请求；发送失败仅告警，不影响业务。
 * 品牌英文邮件壳沿用主绿 #1FA46B / 奶油底 #FBF6EE / 深绿 #178353（与 email.ts 一致）。
 */

import 'dotenv/config';
import { sendEmail } from './email.js';
import type { CustomScenario } from './customRoleplay.js';
import type { Order } from './payment.js';
import type { Feedback } from './feedback.js';

/** 管理控制台地址（邮件 CTA 深链根；仅提示用，不泄露令牌） */
const ADMIN_CONSOLE_URL = process.env.ADMIN_CONSOLE_URL || 'https://myxiaoyu.com/admin.html';

/**
 * 解析通知收件地址：ADMIN_NOTIFY_EMAIL → MAIL_BCC → SMTP_FROM → SMTP_USER。
 * MAIL_BCC（运营抄送）排在 SMTP_FROM 之前：Resend 通道下 SMTP_FROM 是
 * noreply@mail.myxiaoyu.com（只发不收的地址），发过去等于没人收到。
 */
function adminEmail(): string {
  return process.env.ADMIN_NOTIFY_EMAIL || process.env.MAIL_BCC || process.env.SMTP_FROM || process.env.SMTP_USER || '';
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 品牌邮件外壳（运营通知版） */
function brandShell(preTitle: string, body: string, ctaHref: string, ctaText: string): string {
  return `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;background:#FBF6EE;border-radius:16px;padding:32px 28px;border:1px solid #E4E0D4">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:36px;line-height:1">🌱</div>
        <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#178353">Xiaoyu · 运营通知</p>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
      </div>
      <div style="background:#FFFFFF;border-radius:12px;padding:24px;border:1px solid #DCE8D5">
        <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.6"><b style="color:#178353">${preTitle}</b></p>
        ${body}
        <div style="text-align:center;margin-top:20px">
          <a href="${ctaHref}" style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">${ctaText}</a>
        </div>
        <p style="margin:14px 0 0;font-size:12px;color:#A0A7B5;text-align:center;line-height:1.6">如果已处理完毕，可忽略本邮件。</p>
      </div>
    </div>`;
}

/** 键值行（信息表格） */
function fieldRow(label: string, value: string): string {
  return `<tr><td style="padding:6px 12px 6px 0;color:#7A8A80;font-size:13px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 0;font-size:14px;color:#243B2E;word-break:break-word">${value}</td></tr>`;
}

export interface NotifyUser {
  username?: string;
  email?: string;
}

/**
 * 新 UGC 投稿提醒（自建剧本投稿后，运营在控制台「UGC 精选」挑为精选）
 */
export async function notifyNewUgcSubmission(rec: CustomScenario, author?: NotifyUser): Promise<void> {
  const to = adminEmail();
  if (!to) {
    console.log(`📧 [AdminNotify] 未配置管理通知邮箱，跳过 UGC 投稿提醒（可在 .env 设 ADMIN_NOTIFY_EMAIL）。剧本=${rec.title}`);
    return;
  }
  try {
    const authorLabel = (author?.username || '（用户）') + (author?.email ? ` · ${author.email}` : '');
    const subject = `[Xiaoyu 控制台] 新 UGC 投稿：${rec.title}`;
    const body = `<table style="border-collapse:collapse;width:100%">
      ${fieldRow('剧本标题', escapeHtml(rec.title))}
      ${fieldRow('AI 角色', escapeHtml(rec.aiName || '—'))}
      ${fieldRow('作者', escapeHtml(authorLabel))}
      ${fieldRow('投稿时间', escapeHtml(new Date(rec.updatedAt).toLocaleString('zh-CN')))}
    </table>
    <p style="margin:14px 0 0;font-size:14px;color:#243B2E;line-height:1.7">有一条新的角色剧情投稿，等待你在控制台「UGC 精选」中挑为精选。</p>`;
    const html = brandShell('🎨 新 UGC 投稿', body, ADMIN_CONSOLE_URL + '#ugc', '打开控制台处理 →');
    const r = await sendEmail(to, subject, html, undefined, { critical: true });
    if (!r.ok) console.warn('[AdminNotify] UGC 投稿邮件发送失败:', r.detail);
  } catch (e) {
    console.warn('[AdminNotify] UGC 投稿通知异常:', (e as Error)?.message);
  }
}

/**
 * 待确认订单提醒（用户标记已付款，等待运营核对到账并解锁）
 */
export async function notifyNewOrderConfirm(order: Order, buyer?: NotifyUser): Promise<void> {
  const to = adminEmail();
  if (!to) {
    console.log(`📧 [AdminNotify] 未配置管理通知邮箱，跳过订单待确认提醒（可在 .env 设 ADMIN_NOTIFY_EMAIL）。订单=${order.orderId}`);
    return;
  }
  try {
    const planLabel = order.plan === 'pro' ? 'Pro' : 'Plus';
    const purchaseLabel = order.purchase === 'yearly' ? '年付' : order.purchase === 'lifetime' ? '买断' : '月付';
    const buyerLabel = (buyer?.username || '（用户）') + (buyer?.email ? ` · ${buyer.email}` : '');
    const subject = `[Xiaoyu 控制台] 订单待确认：${order.orderId}`;
    const body = `<table style="border-collapse:collapse;width:100%">
      ${fieldRow('订单号', escapeHtml(order.orderId))}
      ${fieldRow('档位', escapeHtml(planLabel))}
      ${fieldRow('购买方式', escapeHtml(purchaseLabel))}
      ${fieldRow('金额', `¥${escapeHtml(String(order.price))}`)}
      ${fieldRow('用户', escapeHtml(buyerLabel))}
      ${fieldRow('付款备注', escapeHtml(order.remark || '—'))}
      ${fieldRow('下单时间', escapeHtml(new Date(order.createdAt).toLocaleString('zh-CN')))}
    </table>
    <p style="margin:14px 0 0;font-size:14px;color:#243B2E;line-height:1.7">用户已标记付款，等待你在控制台「订单」确认到账并解锁。</p>`;
    const html = brandShell('🛒 待确认订单', body, ADMIN_CONSOLE_URL + '#orders', '打开控制台确认 →');
    const r = await sendEmail(to, subject, html, undefined, { critical: true });
    if (!r.ok) console.warn('[AdminNotify] 订单待确认邮件发送失败:', r.detail);
  } catch (e) {
    console.warn('[AdminNotify] 订单待确认通知异常:', (e as Error)?.message);
  }
}

/** 反馈类型 → 中文标签（与前端 feedbackType / 控制台徽章口径一致） */
function feedbackTypeLabel(type: string): string {
  const t = String(type || '').toLowerCase();
  if (t === 'suggest' || type === '建议') return '建议';
  if (t === 'issue' || type === '问题') return '问题';
  if (t === 'praise' || type === '夸奖') return '夸奖';
  return '其他';
}

/** 反馈通知每日上限（读环境变量，便于运行时/测试调整；<=0 表示不限量） */
function feedbackDailyCap(): number {
  const n = Number(process.env.ADMIN_NOTIFY_FEEDBACK_DAILY_CAP);
  return Number.isFinite(n) && process.env.ADMIN_NOTIFY_FEEDBACK_DAILY_CAP ? n : 30;
}

let feedbackMailDate = '';
let feedbackMailSent = 0;

/**
 * 当日反馈邮件配额（进程内计数，按服务器本地日期跨天重置）。
 * 目的：反馈门槛低（游客也能提交）且重复提交无成本，防止灌水把运营邮箱刷爆；
 * 超出上限的反馈**不丢**，仍在控制台「💬 反馈」列表里，只是不再发邮件。
 */
function consumeFeedbackMailQuota(): boolean {
  const cap = feedbackDailyCap();
  if (cap <= 0) return true;
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (feedbackMailDate !== key) {
    feedbackMailDate = key;
    feedbackMailSent = 0;
  }
  if (feedbackMailSent >= cap) return false;
  feedbackMailSent++;
  return true;
}

/** 测试用：重置当日反馈邮件计数 */
export function __resetFeedbackMailQuota(): void {
  feedbackMailDate = '';
  feedbackMailSent = 0;
}

/**
 * 新反馈提醒（用户在「意见反馈」提交后，运营在控制台「💬 反馈」处理并可发 5–50 条奖励）
 * 口径（用户确认）：每条反馈立即一封，含游客反馈；超每日上限则只记日志。
 */
export async function notifyNewFeedback(item: Feedback, user?: NotifyUser): Promise<void> {
  const to = adminEmail();
  const typeLabel = feedbackTypeLabel(item.type);
  const digest = String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!to) {
    console.log(`📧 [AdminNotify] 未配置管理通知邮箱，跳过反馈提醒（可在 .env 设 ADMIN_NOTIFY_EMAIL）。反馈=${item.id}`);
    return;
  }
  if (!consumeFeedbackMailQuota()) {
    console.log(`📧 [AdminNotify] 今日反馈提醒已达上限（ADMIN_NOTIFY_FEEDBACK_DAILY_CAP=${feedbackDailyCap()}），本条只记日志、不发邮件（控制台仍可见）。反馈=${item.id}`);
    return;
  }
  try {
    const userLabel = (user?.username || '游客/设备') + (user?.email ? ` · ${user.email}` : '');
    const rawCtx = String(item.context || '').trim();
    const ctxHtml = rawCtx
      ? `<p style="margin:16px 0 6px;font-size:13px;color:#7A8A80">AI 对话上下文</p>
    <div style="background:#F7F7F4;border-left:3px solid #DCE8D5;border-radius:8px;padding:12px 14px;font-size:13px;color:#5A6B60;line-height:1.7;white-space:pre-wrap;word-break:break-word">${escapeHtml(rawCtx.slice(0, 600))}${rawCtx.length > 600 ? '…（完整上下文见控制台「查看对话」）' : ''}</div>`
      : '';
    const subject = `[Xiaoyu 控制台] 新反馈（${typeLabel}）：${digest || item.id}`;
    const body = `<table style="border-collapse:collapse;width:100%">
      ${fieldRow('类型', escapeHtml(typeLabel))}
      ${fieldRow('用户', escapeHtml(userLabel))}
      ${fieldRow('联系方式', escapeHtml(item.contact || '—'))}
      ${fieldRow('提交时间', escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN')))}
      ${fieldRow('反馈编号', escapeHtml(item.id))}
    </table>
    <p style="margin:16px 0 6px;font-size:13px;color:#7A8A80">反馈内容</p>
    <div style="background:#FBF6EE;border-left:3px solid #1FA46B;border-radius:8px;padding:12px 14px;font-size:14px;color:#243B2E;line-height:1.7;white-space:pre-wrap;word-break:break-word">${escapeHtml(item.content)}</div>
    ${ctxHtml}
    <p style="margin:14px 0 0;font-size:14px;color:#243B2E;line-height:1.7">有一条新反馈，等待你在控制台「💬 反馈」查看，可直接给这条反馈发奖励（5–50 条消息）。</p>`;
    const html = brandShell('💬 新用户反馈', body, ADMIN_CONSOLE_URL + '#feedback', '打开控制台处理 →');
    const r = await sendEmail(to, subject, html, undefined, { critical: true });
    if (!r.ok) console.warn('[AdminNotify] 反馈提醒邮件发送失败:', r.detail);
  } catch (e) {
    console.warn('[AdminNotify] 反馈提醒通知异常:', (e as Error)?.message);
  }
}
