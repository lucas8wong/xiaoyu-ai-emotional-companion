/**
 * 邮箱验证码模块
 * - MAIL_MODE=console（默认）：验证码打印到日志，用于本地测试
 * - MAIL_MODE=smtp：真实发送邮件（需配置 SMTP，如 QQ/163 邮箱授权码）
 * 验证码持久化到 data/emailcodes.json，5分钟有效，一次性使用
 */

import 'dotenv/config';
import crypto from 'crypto';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const CODES_FILE = dataFile('emailcodes.json');

const CODE_TTL = Number(process.env.EMAIL_CODE_TTL_MINUTES || 5) * 60 * 1000;
const MAIL_MODE = process.env.MAIL_MODE || 'console';

// 【每日非关键邮件预算护栏（P: 关键邮件优先）】
// 关键邮件（邮箱验证码/改密）永远放行；非关键邮件（奖励通知 / 新人 Pro 恭喜 / 召回 / 公告等）
// 每天最多发 N 封，超过则跳过。把每天额度优先留给关键邮件，避免促销/通知邮件把
// Resend(约100/天)/Gmail(约500/天) 的每日上限吃光，导致新用户连验证码都收不到。
const MAIL_NONCRITICAL_DAILY_LIMIT = Number(process.env.MAIL_NONCRITICAL_DAILY_LIMIT || 50);
const MAIL_BUDGET_FILE = dataFile('mail-daily-budget.json');

interface DailyMailBudget {
  /** 服务器本地日期 YYYY-MM-DD，跨天自动重置 */
  date: string;
  /** 当日已发出的非关键邮件数 */
  nonCriticalSent: number;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadMailBudget(): DailyMailBudget {
  const b = readJson<DailyMailBudget | null>(MAIL_BUDGET_FILE, null);
  const key = todayKey();
  return b && b.date === key ? b : { date: key, nonCriticalSent: 0 };
}

function saveMailBudget(b: DailyMailBudget): void {
  try {
    writeJson(MAIL_BUDGET_FILE, b);
  } catch { /* 预算计数失败不阻塞发信 */ }
}

/**
 * 消耗一次非关键邮件名额。仅真实 SMTP 发信时调用。
 * @returns true = 本次可以从预算扣除并发送；false = 当日非关键预算已用尽（该封跳过）。
 * MAIL_NONCRITICAL_DAILY_LIMIT<=0 视为不限流（始终允许）。
 */
export function tryConsumeNonCriticalMail(): boolean {
  if (MAIL_NONCRITICAL_DAILY_LIMIT <= 0) return true;
  const b = loadMailBudget();
  if (b.nonCriticalSent >= MAIL_NONCRITICAL_DAILY_LIMIT) return false;
  b.nonCriticalSent += 1;
  saveMailBudget(b);
  return true;
}

export interface EmailCode {
  email: string;
  code: string;
  purpose: string; // 'reset' | 'register'
  expireAt: number;
}

class EmailCodeStore {
  private codes: EmailCode[] = [];

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<EmailCode[]>(CODES_FILE, []);
    if (Array.isArray(parsed)) this.codes = parsed;
  }

  private saveToDisk(): void {
    try {
      writeJson(CODES_FILE, this.codes);
    } catch { /* 忽略 */ }
  }

  private cleanup(): void {
    const now = Date.now();
    this.codes = this.codes.filter(c => c.expireAt > now);
  }

  /**
   * 生成验证码（同邮箱同用途先清旧的）
   */
  generate(email: string, purpose: string): string {
    this.cleanup();
    const e = String(email || '').trim().toLowerCase();
    this.codes = this.codes.filter(c => !(c.email === e && c.purpose === purpose));
    const code = String(crypto.randomInt(100000, 999999));
    this.codes.push({ email: e, code, purpose, expireAt: Date.now() + CODE_TTL });
    this.saveToDisk();
    return code;
  }

  /**
   * 校验验证码（一次性，成功即消费）
   */
  verify(email: string, purpose: string, code: string): boolean {
    this.cleanup();
    const e = String(email || '').trim().toLowerCase();
    const idx = this.codes.findIndex(c => c.email === e && c.purpose === purpose && c.code === code);
    if (idx === -1) return false;
    this.codes.splice(idx, 1);
    this.saveToDisk();
    return true;
  }

  /**
   * 校验验证码但不消费（peek）：用于「先校验、注册成功后再消费」，
   * 避免注册失败（用户名/邮箱/密码不合法等）把验证码白白烧掉。
   */
  peek(email: string, purpose: string, code: string): boolean {
    this.cleanup();
    const e = String(email || '').trim().toLowerCase();
    return this.codes.some(c => c.email === e && c.purpose === purpose && c.code === code);
  }

  /**
   * 注销时按邮箱清除待用验证码（P1-03；TTL 兜底之外的主动清理，忽略大小写）
   */
  removeByEmail(email: string): void {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return;
    const before = this.codes.length;
    this.codes = this.codes.filter(c => c.email.toLowerCase() !== target);
    if (this.codes.length !== before) this.saveToDisk();
  }
}

export const emailCodeStore = new EmailCodeStore();

/**
 * 发送邮件
 */
/** 把 HTML 正文转成纯文本（邮件同时发 text 版，利于进收件箱/被读作正常邮件） */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 群发通道（campaign）：与验证码通道物理隔离的独立 SMTP
// ---------------------------------------------------------------------------
/**
 * 为什么需要独立通道：
 *   - 主通道（Resend + noreply@mail.myxiaoyu.com）承载**注册验证码/改密**，是账号可用性的命门；
 *   - 成人向定向邮件一旦触发 ESP 的 AUP 或收件人投诉，被限制/封禁的是**整个发信域名**；
 *     届时用户连验证码都收不到（email.ts 现有的 50 封/天非关键预算就是为同一目的设的护栏）。
 *   - 所以运营类群发走独立凭据：出问题只影响运营邮件，不动账号命门；同时也不占用
 *     非关键邮件预算（那条预算的意义就是「把额度留给验证码」）。
 *
 * 配置（.env，用户自备 Gmail 应用专用密码）：
 *   CAMPAIGN_SMTP_USER=myxiaoyu2026@gmail.com
 *   CAMPAIGN_SMTP_PASS=<16 位应用专用密码>
 *   CAMPAIGN_SMTP_HOST=smtp.gmail.com   # 可选
 *   CAMPAIGN_SMTP_PORT=465              # 可选
 *   CAMPAIGN_SMTP_SECURE=true           # 可选
 *   CAMPAIGN_SMTP_FROM=                 # 可选，默认 = CAMPAIGN_SMTP_USER
 */
export const CAMPAIGN_DEFAULT_FROM = 'myxiaoyu2026@gmail.com';

export interface CampaignTransportConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string;
}

/** 读取群发通道配置；缺凭据返回 null（绝不静默回落到主通道） */
export function readCampaignTransport(): CampaignTransportConfig | null {
  const user = (process.env.CAMPAIGN_SMTP_USER || '').trim();
  const pass = (process.env.CAMPAIGN_SMTP_PASS || '').trim();
  if (!user || !pass) return null;
  return {
    host: (process.env.CAMPAIGN_SMTP_HOST || 'smtp.gmail.com').trim(),
    port: Number(process.env.CAMPAIGN_SMTP_PORT || 465),
    secure: String(process.env.CAMPAIGN_SMTP_SECURE || 'true') === 'true',
    user, pass,
    from: (process.env.CAMPAIGN_SMTP_FROM || user).trim(),
  };
}

/** 群发通道是否就绪（供运营端预览时提前告警，而不是发到一半才发现没配） */
export function campaignTransportReady(): { ready: boolean; reason: string; from: string } {
  const cfg = readCampaignTransport();
  if (!cfg) {
    return {
      ready: false,
      reason: '群发通道未配置：请在 .env 设置 CAMPAIGN_SMTP_USER / CAMPAIGN_SMTP_PASS（Gmail 应用专用密码，需先开启两步验证）',
      from: CAMPAIGN_DEFAULT_FROM,
    };
  }
  return { ready: true, reason: '', from: cfg.from };
}

export async function sendEmail(to: string, subject: string, html: string, fromName?: string, opts?: { unsubUrl?: string; text?: string; critical?: boolean; via?: 'default' | 'campaign' }): Promise<{ ok: boolean; detail: string }> {
  const viaCampaign = opts?.via === 'campaign';
  if (MAIL_MODE === 'smtp') {
    // 群发通道有自己的每日上限（CAMPAIGN_DAILY_CAP，由 adultCampaign 计提），不占主通道的验证码额度
    if (!viaCampaign && !opts?.critical && !tryConsumeNonCriticalMail()) {
      console.warn('[Mail] 今日非关键邮件预算已用尽，跳过：to=' + to + ' subject="' + subject + '"');
      return { ok: false, detail: '今日非关键邮件预算已用尽，已跳过（关键邮件不受影响）' };
    }
    const campaign = viaCampaign ? readCampaignTransport() : null;
    if (viaCampaign && !campaign) {
      return { ok: false, detail: campaignTransportReady().reason };
    }
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport(campaign
        ? { host: campaign.host, port: campaign.port, secure: campaign.secure, auth: { user: campaign.user, pass: campaign.pass } }
        : {
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 465),
          secure: String(process.env.SMTP_SECURE || 'true') === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });
      // fromName 供「召回」等个性化场景用；缺省统一显示品牌「AI Companion」。地址仍是 SMTP_FROM（可回复）
      const address = campaign ? campaign.from : (process.env.SMTP_FROM || process.env.SMTP_USER || '');
      const display = fromName || 'AI Companion';
      const from = { name: display, address };
      // 可读性/可送达性：带纯文本版 + List-Unsubscribe（Gmail/Outlook 识别一键退订，显著降垃圾箱）
      const text = opts?.text || htmlToText(html);
      const headers: Record<string, string> = {};
      if (opts?.unsubUrl) {
        headers['List-Unsubscribe'] = '<' + opts.unsubUrl + '>';
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      // 运营抄送：设置 MAIL_BCC 后，每封发出的邮件同时抄送一份到该邮箱（手机也能收到一份）。
      // 群发通道不发 BCC：发信地址本身就是那个 Gmail，抄送等于自发自收（且把收件人名单压在同一个邮箱）。
      // 收件人恰好就是抄送地址时不再抄送：同一地址挂在信封里两次有收到两封的风险。
      const bccRaw = campaign ? '' : (process.env.MAIL_BCC || '').trim();
      const bcc = bccRaw && bccRaw.toLowerCase() !== String(to).trim().toLowerCase() ? bccRaw : '';
      await transporter.sendMail({ from, to, subject, html, text, headers, ...(bcc ? { bcc } : {}) });
      return { ok: true, detail: campaign ? 'smtp 发送成功（群发通道）' : 'smtp 发送成功' };
    } catch (e) {
      return { ok: false, detail: (e as Error)?.message || 'SMTP 发送失败' };
    }
  }
  // console 模式：把验证码打到日志（本地测试用）
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️ [Mail] 生产环境仍为 MAIL_MODE=console：已拒绝发送，避免验证码泄露到日志。请在 .env 配置 SMTP 并将 MAIL_MODE 改为 smtp。');
    return { ok: false, detail: '邮件服务未配置（生产环境需开启 SMTP）' };
  }
  console.log(`📧 [MAIL:console] to=${to} subject="${subject}"${fromName ? ` from=${fromName}` : ''}`);
  console.log(`📧 [MAIL:console] 正文: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
  return { ok: true, detail: 'console 模式（验证码见服务器日志）' };
}

/**
 * 生成并发送邮箱验证码
 */
export async function sendEmailCode(email: string, purpose: string): Promise<{ ok: boolean; detail: string }> {
  const code = emailCodeStore.generate(email, purpose);
  const isReset = purpose === 'reset';
  const subject = isReset ? 'Your Xiaoyu password reset code' : 'Welcome to Xiaoyu — your verification code';
  // 品牌英文邮件：主绿 #1FA46B · 奶油底 #FBF6EE · 深绿 #178353
  const html = `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:440px;margin:0 auto;background:#FBF6EE;border-radius:16px;padding:32px 28px;border:1px solid #E4E0D4">
      <!-- 品牌头 -->
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:36px;line-height:1">🌱</div>
        <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#178353">Xiaoyu</p>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
      </div>
      <div style="background:#FFFFFF;border-radius:12px;padding:24px;border:1px solid #DCE8D5">
        <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.6">
          <b style="color:#178353">${isReset ? 'Hi there' : 'Welcome to Xiaoyu'} 🌷</b><br/>
          ${isReset
            ? 'You asked to reset your password. Here is your verification code:'
            : 'Thanks for signing up. One last step — your verification code is:'}
        </p>
        <p style="margin:16px 0 6px;font-size:34px;font-weight:800;letter-spacing:8px;color:#1FA46B;text-align:center">${code}</p>
        <p style="margin:0 0 16px;font-size:12px;color:#A0A7B5;text-align:center">Tip: on your phone, tap <b style="color:#178353">Copy code</b> at the top of this email (Gmail / iOS).</p>
        <div style="text-align:center;margin:0 0 16px">
          <a href="https://myxiaoyu.com/?verify=${isReset ? 'reset' : 'register'}&amp;email=${encodeURIComponent(email)}&amp;code=${code}"
             style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">
            ${isReset ? 'Reset your password on Xiaoyu' : 'Finish sign-up on Xiaoyu'} →
          </a>
        </div>
        <p style="margin:0;font-size:13px;color:#7A8A80;line-height:1.6">
          This code expires in 5 minutes. Never share it with anyone — Xiaoyu will never ask for your code.
        </p>
      </div>
      <div style="text-align:center;margin:22px 0 0">
        <a href="https://myxiaoyu.com/" style="display:inline-block;background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:999px">进入 Xiaoyu →</a>
      </div>
      <p style="margin:18px 0 0;font-size:12px;color:#A0A7B5;text-align:center;line-height:1.6">
        Every feeling deserves to be understood.<br/>
        Questions or need help? Contact <a href="mailto:myxiaoyu2026@gmail.com" style="color:#178353">myxiaoyu2026@gmail.com</a> — a real person will reply.<br/>
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>`;
  return sendEmail(email, subject, html, undefined, { critical: true });
}
