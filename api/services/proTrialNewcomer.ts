/**
 * 新人福利：给「当前无会员」的注册用户开通 7 天 Pro 试用，并按其 IP 地区语言发恭喜邮件。
 *
 * 与 proTrial.ts（老用户一次性授予、不区分会员、不发邮件）不同：
 * - 只作用于「没有会员」(当前 plan===free，含无 plus/pro/lifetime、无生效中的 Pro 试用) 的用户；
 * - 以用户 IP/国家定邮件语言（简中 / 繁中 / English）；游客（无邮箱）跳过；
 * - 默认 dry-run（零副作用）；apply 时授权 + 发信 + 写幂等 marker（data/pro-trial-newcomer-campaign.json），
 *   避免重复授权 / 重复发信。
 *
 * 安全红线：apply 前请先经调用方备份（本服务不改数据前不负责备份本身）；邮件文案遵守
 * 「陪伴非治疗 / gentle healing」品牌口径，无医疗承诺。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore, type Account } from './accounts.js';
import { quotaStore, isProTrialPromoActive, type UserRecord } from './quota.js';
import { looksLikeTestAccount } from './adminAnalytics.js';
import { sendEmail } from './email.js';
import { toZhTw } from './zhConvert.js';
import { inferLanguageForUser, regionLabelForUser, type EmailLang } from './userLang.js';

const CAMPAIGN_FILE = dataFile('pro-trial-newcomer-campaign.json');

// 语言/地区推断已抽到 services/userLang.ts（会员开通通知 memberNotifier 共用同一口径）；
// 这里原样再导出，老的调用点（路由、scripts、单测）无需改动。
export { inferLanguageForUser, regionLabelForUser };
export type { EmailLang };

export interface ProTrialNewcomerCampaign {
  days: number;
  grantedTo: number;
  emailedTo: number;
  at: number;
  /** 本轮已处理（授权过）的 userId，重跑时跳过，避免重复授权/发信 */
  userIds: string[];
}

export interface NewcomerCandidate {
  userId: string;
  username: string;
  email: string;
  language: EmailLang;
  /** 地区标签（用于报告；港/澳/台/大陆/国家名，未知为空） */
  country: string;
}

export interface NewcomerRunReport {
  dryRun: boolean;
  days: number;
  /** 本轮「符合候选人条件」的总数（注册/有邮箱/非测试/当前 free） */
  totalEligible: number;
  /** 这次实际要处理（= totalEligible 中未被本轮 marker 处理过的；force 则全部；再减去 exclude） */
  candidates: NewcomerCandidate[];
  byLanguage: Record<EmailLang, number>;
  /** 因本轮已处理（或主动排除）而被跳过的数量 */
  skippedProcessed: number;
  /** 主动排除的用户数量（exclude 生效） */
  excludedCount: number;
  granted: number;
  emailed: number;
  emailFailed: number;
  markerExists: boolean;
  /** apply 时生成的一致性备份路径（调用方在 apply 前产生） */
  backupPath?: string;
}

/** 本次新人福利的天数（默认读 .env PRO_TRIAL_DAYS，缺省 7） */
export function newcomerProTrialDays(): number {
  const n = Number(process.env.PRO_TRIAL_DAYS || 0);
  return n > 0 ? n : 7;
}

/** 读取本轮已处理名单（未执行过返回空集） */
export function getProcessedUserIds(): Set<string> {
  const flag = readJson<ProTrialNewcomerCampaign | null>(CAMPAIGN_FILE, null);
  return new Set(flag?.userIds || []);
}

const FREE_DEFAULT: UserRecord = { userId: '', freeUsed: 0, unlockUntil: null, createdAt: 0 };

/** 是否符合「新人福利」候选：注册账号、有邮箱、非测试、当前无会员（plan===free）且从未领过 Pro 试用 */
export function isNewcomerEligible(acc: Account): boolean {
  if (!acc.email) return false;
  if (looksLikeTestAccount(acc)) return false;
  const rec = quotaStore.getRecord(acc.userId) ?? { ...FREE_DEFAULT, userId: acc.userId };
  // 已发过 Pro 试用（含 2026-08-29 老用户那轮）→ 不重复授权/发信（一次性新人礼）
  if (rec.trialProGrantedAt) return false;
  return quotaStore.getPlan(rec) === 'free';
}

/** 列出本轮全部符合条件的新人（含语言/地区标签），不落地任何变动 */
export function listNewcomerCandidates(): NewcomerCandidate[] {
  const out: NewcomerCandidate[] = [];
  for (const acc of accountStore.listAll()) {
    if (!isNewcomerEligible(acc)) continue;
    out.push({
      userId: acc.userId,
      username: (acc.username || '').trim(),
      email: acc.email,
      language: inferLanguageForUser(acc.userId),
      country: regionLabelForUser(acc.userId),
    });
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 品牌邮件外壳（与 rewardNotifier 一致的风格；主绿/奶油底/墨绿字） */
function brandShell(body: string, cta: string, footer: string, tagline: string): string {
  return `
    <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:440px;margin:0 auto;background:#FBF6EE;border-radius:16px;padding:32px 28px;border:1px solid #E4E0D4">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:36px;line-height:1">🌱</div>
        <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#178353">Xiaoyu</p>
        <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">${tagline}</p>
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

/**
 * 生成恭喜邮件（subject + html）。zh-TW 由 zh-CN 经 opencc 转繁体，避免简繁错误。
 */
export function buildCongratsEmail(lang: EmailLang, username: string, days: number): { subject: string; html: string } {
  const name = (username || '').trim() ? `Dear <b>${escapeHtml(username)}</b>,` : 'Hi there,';
  const zhName = (username || '').trim() ? `亲爱的 <b>${escapeHtml(username)}</b>，` : '你好，';

  if (lang === 'en') {
    const subject = `🎁 Your ${days}-day Pro trial is live`;
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${name}<br/>
        A gift from Xiaoyu: you've been upgraded to a free <b style="color:#1FA46B">${days}-day Pro trial</b> 🎁.</p>
      <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">During your trial you get unlimited chats, longer context, and full role-play &amp; story modes.</p>
      <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">No action needed — just open Xiaoyu and start talking. We're glad you're here. 💛</p>`;
    return { subject, html: brandShell(body, 'Enter Xiaoyu →', 'Every feeling deserves to be understood.', 'gentle healing, for every feeling') };
  }

  // 简中底稿
  const zhSubject = `🎁 你的 ${days} 天 Pro 体验已开通`;
  const zhBody = `
    <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${zhName}<br/>
      小愈为你准备了一份新人礼物，你已免费开通 <b style="color:#1FA46B">${days} 天 Pro 体验</b> 🎁。</p>
    <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">体验期间，你可以无限畅聊、享受更长的上下文，还能畅玩角色扮演与 AI 文游。</p>
    <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">无需任何操作，打开 Xiaoyu 就能马上开始。很高兴你在这里。💛</p>`;
  const zhCta = '进入 Xiaoyu →';
  const zhFooter = '你的每一种情绪，都值得被理解。';
  const zhTagline = 'gentle healing, for every feeling';
  const zhHtml = brandShell(zhBody, zhCta, zhFooter, zhTagline);

  if (lang === 'zh-TW') {
    return { subject: toZhTw(zhSubject), html: toZhTw(zhHtml) };
  }
  return { subject: zhSubject, html: zhHtml };
}

/** 发送单人恭喜邮件（失败仅记录，不抛出，避免单点失败中断整批） */
export async function sendCongratsEmail(email: string, username: string, lang: EmailLang, days: number): Promise<{ ok: boolean; detail: string }> {
  const { subject, html } = buildCongratsEmail(lang, username, days);
  return sendEmail(email, subject, html);
}

/**
 * 注册链路自动发放「新人 Pro 试用」：仅活动期内生效。
 * - 非活动期 / 无邮箱 / 测试账号 / 已发过试用(trialProGrantedAt) / 已是会员 → 不发（零副作用）；
 * - 发放：授 7 天 Pro + 按用户 IP 地区语言发恭喜邮件；
 * - 幂等：发放后写 trialProGrantedAt（由 grantProTrial 完成），重跑/再次调用自动跳过；
 * - 单点失败不抛出（邮件失败仅记录，授权仍生效）。
 */
export async function maybeGrantNewcomerProTrial(userId: string): Promise<{
  granted: boolean;
  emailed: boolean;
  reason?: string;
  detail?: string;
}> {
  if (!isProTrialPromoActive()) {
    return { granted: false, emailed: false, reason: 'campaign-inactive' };
  }
  const acc = accountStore.getById(userId);
  if (!acc || !acc.email) {
    return { granted: false, emailed: false, reason: 'no-account-or-email' };
  }
  if (!isNewcomerEligible(acc)) {
    return { granted: false, emailed: false, reason: 'not-eligible' };
  }
  const days = newcomerProTrialDays();
  try {
    quotaStore.grantProTrial(userId, days);
  } catch (e) {
    return { granted: false, emailed: false, reason: 'grant-failed', detail: (e as Error)?.message };
  }
  const lang = inferLanguageForUser(userId);
  const emailRes = await sendCongratsEmail(acc.email, (acc.username || '').trim(), lang, days);
  return { granted: true, emailed: emailRes.ok, reason: emailRes.ok ? undefined : 'email-failed', detail: emailRes.detail };
}

/**
 * 批量执行「新人福利」。默认 dry-run（零副作用：不授权、不发信、不写 marker）。
 * opts:
 *  - days      试用天数（缺省 .env/7）
 *  - dryRun    默认 true；false 时授权+发信+写 marker
 *  - force     默认 false；true 时忽略已有 marker 重新处理全部符合者（用于新一轮/重跑）
 *  - backupPath 可选：调用方在 apply 前生成的一致性备份路径，回填进报告（仅作记录）
 */
/** 把 exclude 列表解析成 userId 集：每项可为 userId 或邮箱（大小写不敏感） */
function buildExcludeSet(exclude?: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of exclude || []) {
    const v = String(raw).trim().toLowerCase();
    if (!v) continue;
    const byEmail = accountStore.findByEmail(v);
    if (byEmail) set.add(byEmail.userId);
    set.add(v);
  }
  return set;
}

export async function runNewcomerProTrial(opts: { days?: number; dryRun?: boolean; force?: boolean; backupPath?: string; exclude?: string[] } = {}): Promise<NewcomerRunReport> {
  const days = opts.days ?? newcomerProTrialDays();
  const dryRun = opts.dryRun !== false;
  const force = !!opts.force;

  const processed = getProcessedUserIds();
  const excludeSet = buildExcludeSet(opts.exclude);
  const totalEligible = listNewcomerCandidates();
  const candidates = totalEligible.filter((c) => !excludeSet.has(c.userId) && (force || !processed.has(c.userId)));
  // 排除数 = 主动 exclude 命中数（与 marker 无关）
  const excludedByExclude = totalEligible.filter((c) => excludeSet.has(c.userId)).length;
  const skippedProcessed = totalEligible.length - candidates.length - excludedByExclude;

  const byLanguage: Record<EmailLang, number> = { 'zh-CN': 0, 'zh-TW': 0, en: 0 };
  for (const c of candidates) byLanguage[c.language] += 1;

  if (dryRun) {
    return {
      dryRun: true,
      days,
      totalEligible: totalEligible.length,
      candidates,
      byLanguage,
      skippedProcessed,
      excludedCount: excludedByExclude,
      granted: 0,
      emailed: 0,
      emailFailed: 0,
      markerExists: readJson<ProTrialNewcomerCampaign | null>(CAMPAIGN_FILE, null) !== null,
      backupPath: opts.backupPath,
    };
  }

  let granted = 0;
  let emailed = 0;
  let emailFailed = 0;
  const newlyProcessed = new Set<string>(processed);

  for (const c of candidates) {
    // 授权
    try {
      quotaStore.grantProTrial(c.userId, days);
      granted += 1;
    } catch (e) {
      // 只留 userId 前 8 位、邮件只留首字母+域名（2026-09-29 审查 A4-P3：日志不该留完整 PII）
      console.warn('[NewcomerTrial] 授权失败:', c.userId.slice(0, 8), (e as Error)?.message);
    }
    // 发信（失败不中断整批）
    const res = await sendCongratsEmail(c.email, c.username, c.language, days);
    if (res.ok) emailed += 1;
    else {
      emailFailed += 1;
      console.warn('[NewcomerTrial] 邮件发送失败:', String(c.email).replace(/^(.).*?(@.*)$/, '$1***$2'), res.detail);
    }
    newlyProcessed.add(c.userId);
  }

  writeJson(CAMPAIGN_FILE, { days, grantedTo: granted, emailedTo: emailed, at: Date.now(), userIds: [...newlyProcessed] });

  return {
    dryRun: false,
    days,
    totalEligible: totalEligible.length,
    candidates,
    byLanguage,
    skippedProcessed,
    excludedCount: excludedByExclude,
    granted,
    emailed,
    emailFailed,
    markerExists: true,
    backupPath: opts.backupPath,
  };
}
