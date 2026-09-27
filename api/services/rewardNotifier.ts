/**
 * 奖励通知：系统发放 credit 奖励时，向注册用户发邮件通知。
 * 游客（无邮箱）跳过；邮件失败不影响奖励发放。
 * 品牌英文邮件：主绿 #1FA46B · 奶油底 #FBF6EE · 深绿 #178353
 */

import { sendEmail } from './email.js';
import { accountStore } from './accounts.js';

const REASON_LABEL: Record<string, string> = {
  register: 'your sign-up gift',
  invite: 'your invite reward',
  invite_code: 'your invite code bonus',
  feedback: 'your feedback reward',
  reward: 'a reward',
};

/** 品牌邮件外壳（统一风格） */
function brandShell(body: string, footer?: string): string {
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
          <a href="https://myxiaoyu.com/" style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">进入 Xiaoyu →</a>
        </div>
      </div>
      <p style="margin:18px 0 0;font-size:12px;color:#A0A7B5;text-align:center;line-height:1.6">
        ${footer || 'Every feeling deserves to be understood.'}
      </p>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 向用户发奖励邮件（仅注册用户；游客无邮箱跳过）
 * @param message 运营者给用户的回复信息（随奖励邮件一起发，可留空）
 */
export async function notifyRewardByEmail(userId: string, count: number, reason: string, message?: string): Promise<void> {
  try {
    const acc = accountStore.getById(userId);
    if (!acc || !acc.email) return; // 游客/无邮箱跳过
    const label = REASON_LABEL[reason] || REASON_LABEL.reward;
    const subject = 'You earned ' + count + ' free sessions 🎁';
    const note = message && message.trim()
      ? '<p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#178353">💬 A note for you</p>' +
        '<div style="margin:0 0 12px;padding:12px 14px;background:#F0FDF4;border-left:3px solid #1FA46B;border-radius:8px;font-size:14px;color:#243B2E;line-height:1.7;white-space:pre-wrap">' + escapeHtml(message.trim()) + '</div>'
      : '';
    const html = brandShell(
      '<p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.6">' +
      '<b style="color:#178353">A little gift from Xiaoyu 🌷</b><br/>' +
      'You just earned <b style="color:#1FA46B">' + count + ' free sessions</b> (' + label + ').</p>' +
      note +
      '<p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">' +
      'They\'re already in your account — just open Xiaoyu and keep talking. No action needed.</p>'
    );
    await sendEmail(acc.email, subject, html);
  } catch (e) {
    console.warn('[Reward] 奖励邮件发送失败:', (e as Error)?.message);
  }
}

/**
 * 到期前 3 天提醒邮件（每人只发一次，由 /api/payment/quota 钩子触发）
 */
export async function notifyExpiryReminder(userId: string, daysLeft: number): Promise<void> {
  try {
    const acc = accountStore.getById(userId);
    if (!acc || !acc.email) return; // 游客/无邮箱跳过
    const d = daysLeft > 1 ? daysLeft + ' days' : '1 day';
    const subject = 'Your Xiaoyu membership ends in ' + d + ' 💛';
    const html = brandShell(
      '<p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.6">' +
      '<b style="color:#178353">Heads up from Xiaoyu 🌱</b><br/>' +
      'Your membership ends in <b style="color:#1FA46B">' + d + '</b> — renew anytime to keep unlimited chats and everything else.</p>' +
      '<p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">' +
      'Come back soon — every feeling deserves to be understood. 💛</p>'
    );
    await sendEmail(acc.email, subject, html);
  } catch (e) {
    console.warn('[Reward] 到期提醒邮件发送失败:', (e as Error)?.message);
  }
}
