/**
 * 小愈 Pro 上线：写入三语公告 + 给现有注册用户群发邮件（排除测试/开发者账号）。
 *
 * 安全设计：
 * - 默认 DRY-RUN：只打印将要做什么，不写文件、不发邮件、不改 .env。
 * - 真正执行需设环境变量 PRO_LAUNCH_CONFIRM=1。
 * - 7 天 Pro 体验由 .env PRO_TRIAL_DAYS 控制（在本脚本外单独设置并重启生效）。
 */

import 'dotenv/config';
import { announcementStore } from '../api/services/announcements.js';
import { accountStore } from '../api/services/accounts.js';
import { sendEmail } from '../api/services/email.js';
import { isTestAccount } from '../api/routes/paymentAdmin.js';

const CONFIRM = process.env.PRO_LAUNCH_CONFIRM === '1';

// 三语公告（限时 15 天：注册即送 7 天完整 Pro）
// 活动期按 .env PRO_TRIAL_PROMO_START=2026-09-03 + PRO_TRIAL_PROMO_DAYS=15 推导，窗口 [START, START+DAYS) → 2026-09-03 至 09-17（含首尾）。
const TITLE_ZH = '限时 15 天（9/3–9/17）：注册即送 7 天完整 Pro';
const CONTENT_ZH = '活动时间：2026年9月3日至9月17日。在此期间注册或登录，即可免费领 7 天完整 Pro：无限畅聊、更长上下文、AI 生成专属剧本、自创聊天对象（性格/背景/头像自定），越聊 TA 越成长；心情日记一键分享。限时赠送，别错过。';
const TITLE_TW = '限時 15 天（9/3–9/17）：註冊即送 7 天完整 Pro';
const CONTENT_TW = '活動時間：2026年9月3日至9月17日。在此期間註冊或登入，即可免費領 7 天完整 Pro：無限暢聊、更長上下文、AI 生成專屬劇本、自創聊天對象（性格/背景/頭像自訂），越聊 TA 越成長；心情日記一鍵分享。限時贈送，別錯過。';
const TITLE_EN = 'Limited time (Sep 3–17, 2026): 7 days of Pro free on sign-up';
const CONTENT_EN = 'Campaign period: September 3 – September 17, 2026. Sign up or log in during this window to claim 7 full days of Pro: unlimited chats, longer context, AI-written stories, and any character you create — chat more and they grow with you; share your mood diary in one tap. Limited-time gift — don\'t miss it.';

// 【邮件】
const EMAIL_SUBJECT = '小愈 Pro 限时 15 天：注册即送 7 天完整 Pro 🎁';
const EMAIL_ZH = '限时 15 天：现在注册或登录，都能免费体验 7 天完整 Pro（无限畅聊、更长上下文、AI 生成专属文游剧本，全都解锁）。\n\n你也可以不只有小愈：创建任何想聊天的对象，设定 TA 的性格和背景、上传头像；聊得越多，TA 会随着你们的互动慢慢成长。心情日记现在也能一键分享成图片。\n\n首次创建角色的朋友，额外送 1 次 AI 剧本生成额度。\n\n把你的自建剧本投稿到「精选」，被运营挑中的会展示给所有玩家。\n\n登录小愈，开始创造属于你们的故事。';
const EMAIL_EN = 'Every feeling deserves to be understood.';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emailHtml(contentZh: string, contentEn: string): string {
  return `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#FBF6EE;border-radius:16px;border:1px solid #E4E0D4">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:32px;line-height:1">🌱</div>
        <h2 style="color:#178353;margin:6px 0 0;font-size:18px">Xiaoyu · 小愈</h2>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
      </div>
      <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #DCE8D5">
        <p style="color:#243B2E;line-height:1.7;margin:0"><b style="color:#178353">亲爱的用户，</b></p>
        <p style="color:#444;line-height:1.8;white-space:pre-line;margin:8px 0 0">${esc(contentZh)}</p>
        <p style="color:#999;font-size:12px;margin:14px 0 0;font-style:italic">${esc(contentEn)}</p>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#A0A7B5;text-align:center">Every feeling deserves to be understood.</p>
    </div>`;
}

async function main(): Promise<void> {
  const accounts = accountStore.listAll().filter((a) => a.email && !isTestAccount(a));
  const message = [
    `公告（三语）: ${TITLE_ZH}`,
    `群发邮件目标: ${accounts.length} 位注册用户`,
    `邮件主题: ${EMAIL_SUBJECT}`,
  ].join('\n');

  if (!CONFIRM) {
    console.log('【DRY-RUN】未执行。将做以下动作，');
    console.log(message);
    console.log('真正执行请设 PRO_LAUNCH_CONFIRM=1（并要求 .env 设 PRO_TRIAL_DAYS=7）');
    return;
  }

  announcementStore.addLangs({
    zhCN: { title: TITLE_ZH, content: CONTENT_ZH },
    zhTW: { title: TITLE_TW, content: CONTENT_TW },
    en: { title: TITLE_EN, content: CONTENT_EN },
  });
  console.log(`✅ 已写入公告栏（三语）`);

  // 仅写公告、不发邮件：设 PRO_LAUNCH_NO_EMAIL=1（配合 PRO_LAUNCH_CONFIRM=1）
  if (process.env.PRO_LAUNCH_NO_EMAIL === '1') {
    console.log(`⏭️ 已跳过群发邮件（PRO_LAUNCH_NO_EMAIL=1）`);
    return;
  }

  let sent = 0;
  for (const acc of accounts) {
    try {
      const r = await sendEmail(acc.email, EMAIL_SUBJECT, emailHtml(EMAIL_ZH, EMAIL_EN));
      if (r.ok) sent += 1;
    } catch {
      /* 单个失败不影响其他 */
    }
  }
  console.log(`✅ 已发送邮件 ${sent}/${accounts.length}`);
}

main().catch((e) => {
  console.error('❌ 发布失败:', e);
  process.exit(1);
});
