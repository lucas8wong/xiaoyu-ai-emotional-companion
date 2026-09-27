/**
 * 补发「注册即送对话额度」——限时活动窗口**漏发**的一次性补齐（2026-09-25）。
 *
 * 背景：注册奖励是限时活动（CHAT_BONUS_START=2026-08-22 / CHAT_BONUS_END=2026-09-06）。
 * 活动结束后注册的用户拿不到这 20 条，而站点文案（About / 游客额度条）一直承诺「注册立得 20 条」，
 * 于是这批人的额度**实际漏发**了。用户拍板：重新开启活动 + 给漏发的人补发并邮件说明。
 *
 * 设计（对齐 proTrialNewcomer 的既有做法，服务层只依赖 store，不反向 import 路由）：
 * - 候选＝**注册时间晚于漏发窗口结束**的注册账号（有邮箱、非测试/开发者账号）；
 * - 默认 dry-run（零副作用：不补发、不发信、不写 marker）；apply 时才写入；
 * - 幂等：apply 后把处理过的 userId 写进 data/register-bonus-backfill.json，重跑自动跳过（force 可强制）；
 * - 邮件按用户 IP/地区语言（简中 / 繁中 / English），文案遵守品牌口径（gentle healing，无医疗承诺）。
 *
 * ⚠️ 漏发窗口的截止时间是**常量**，不读 .env —— 因为活动马上会重新开启（清掉 CHAT_BONUS_END），
 *    若届时按 env 现算，cutoff 会变成 0、把所有老账号都算成候选（会造成大面积错误补发）。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore, type Account } from './accounts.js';
import { quotaStore, REGISTER_CHAT_BONUS_COUNT } from './quota.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';
import { sendEmail, campaignTransportReady } from './email.js';
import { toZhTw } from './zhConvert.js';
import { inferLanguageForUser, regionLabelForUser, type EmailLang } from './userLang.js';

const MARKER_FILE = dataFile('register-bonus-backfill.json');

/**
 * 漏发窗口结束时间：活动配置的 CHAT_BONUS_END=2026-09-06（含当天 23:59:59）。
 * 这段之后的注册都没拿到注册奖励。**钉成常量**，原因见文件头。
 */
export const MISSED_WINDOW_END_MS = new Date('2026-09-06T23:59:59').getTime();

export interface RegisterBonusBackfillMarker {
  count: number;
  grantedTo: number;
  emailedTo: number;
  at: number;
  /** 历史累计已处理（补发过）的 userId，重跑跳过 */
  userIds: string[];
  /** 额度已补、但**邮件没发出去**的人（可走 runRegisterBonusEmailRetry 重发，不重复补额度） */
  failed?: { userId: string; email: string }[];
}

export interface RegisterBonusCandidate {
  userId: string;
  username: string;
  email: string;
  language: EmailLang;
  country: string;
  /** 注册时间（毫秒） */
  registeredAt: number;
}

export interface RegisterBonusRunReport {
  dryRun: boolean;
  count: number;
  /** 漏发窗口结束（ISO，便于核对） */
  missedSince: string;
  totalEligible: number;
  candidates: RegisterBonusCandidate[];
  byLanguage: Record<EmailLang, number>;
  skippedProcessed: number;
  excludedCount: number;
  granted: number;
  emailed: number;
  emailFailed: number;
  markerExists: boolean;
  backupPath?: string;
  /** 失败明细（最多留 30 条，便于排查邮件投递） */
  failures?: { email: string; detail: string }[];
}

/** 已补发过的 userId（未执行过返回空集） */
export function getBackfillProcessedIds(): Set<string> {
  const marker = readJson<RegisterBonusBackfillMarker | null>(MARKER_FILE, null);
  return new Set(marker?.userIds || []);
}

/**
 * 是否属于「漏发」候选：注册账号 + 有邮箱 + 非测试/开发者 + 注册时间晚于漏发窗口结束。
 * ⚠️ 额外排除 `@example.com` / `@example.org`：这是**合成/测量账号**（首次 apply 实测有一个
 * `measure-ww-...@example.com` 混进来；Resend 也明确拒收 example.com）。
 */
export function isRegisterBonusMissed(acc: Account, since: number = MISSED_WINDOW_END_MS): boolean {
  const email = String(acc.email || '').toLowerCase();
  if (!email) return false;
  if (/(^|@)example\.(com|org|net)$/.test(email)) return false;
  if (isTestAccount(acc)) return false;
  if (isDeveloperAccount(acc)) return false;
  return Number(acc.createdAt || 0) > since;
}

/** 列出全部漏发候选（不改任何数据）。since 可覆盖（缺省＝钉死的漏发窗口结束时间）。 */
export function listRegisterBonusCandidates(since: number = MISSED_WINDOW_END_MS): RegisterBonusCandidate[] {
  const out: RegisterBonusCandidate[] = [];
  for (const acc of accountStore.listAll()) {
    if (!isRegisterBonusMissed(acc, since)) continue;
    out.push({
      userId: acc.userId,
      username: (acc.username || '').trim(),
      email: acc.email,
      language: inferLanguageForUser(acc.userId),
      country: regionLabelForUser(acc.userId),
      registeredAt: Number(acc.createdAt || 0),
    });
  }
  return out.sort((a, b) => a.registeredAt - b.registeredAt);
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
 * 「漏发补上」邮件（subject + html）。zh-TW 由 zh-CN 经 opencc 转繁体，避免简繁错误。
 * 口径：先致歉（是我们活动配置的疏漏），再说额度已补到账、无需操作。
 */
export function buildBackfillEmail(lang: EmailLang, username: string, count: number): { subject: string; html: string } {
  const name = (username || '').trim() ? `Dear <b>${escapeHtml(username)}</b>,` : 'Hi there,';
  const zhName = (username || '').trim() ? `亲爱的 <b>${escapeHtml(username)}</b>，` : '你好，';

  if (lang === 'en') {
    const subject = `🎁 We owed you a sign-up gift — ${count} free chats added`;
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${name}<br/>
        We're sorry — the sign-up gift you should have received was <b>missed</b> because of a mistake in our campaign setup.</p>
      <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">It's now in your account: <b style="color:#1FA46B">${count} free chats</b>, ready to use in Chat and Story mode.</p>
      <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">No action needed — just open Xiaoyu and keep talking. We're glad you're here. 💛</p>`;
    return { subject, html: brandShell(body, 'Enter Xiaoyu →', 'Every feeling deserves to be understood.', 'gentle healing, for every feeling') };
  }

  const zhSubject = `🎁 补上你的注册见面礼：${count} 条对话额度已到账`;
  const zhBody = `
    <p style="margin:0 0 12px;font-size:15px;color:#243B2E;line-height:1.7">${zhName}<br/>
      抱歉——你注册时本该收到的见面礼，因为我们的活动配置疏漏，当时<b>没有送到你的账号</b>。</p>
    <p style="margin:0 0 12px;font-size:14px;color:#243B2E;line-height:1.7">现在补上了：<b style="color:#1FA46B">${count} 条对话额度</b>已存入你的账号，聊一聊与角色扮演都能用。</p>
    <p style="margin:0;font-size:14px;color:#243B2E;line-height:1.7">无需任何操作，打开 Xiaoyu 就能用。很高兴你在这里。💛</p>`;
  const zhHtml = brandShell(zhBody, '进入 Xiaoyu →', '你的每一种情绪，都值得被理解。', 'gentle healing, for every feeling');

  if (lang === 'zh-TW') return { subject: toZhTw(zhSubject), html: toZhTw(zhHtml) };
  return { subject: zhSubject, html: zhHtml };
}

/**
 * 发送单人「漏发补上」邮件（失败仅返回结果，不抛出，避免单点失败中断整批）。
 *
 * ⚠️ 通道选择（2026-09-25 实测教训）：优先走**群发通道（Gmail，约 500/天）**，不占用 Resend 事务额度——
 * 首次 apply 时我们用了 critical 直发主通道，93 封把 Resend 当日额度吃到接近上限，最后 2 封被
 * 「monthly quota」拒绝（那本是留给验证码的额度）。群发通道没配时才回退主通道。
 */
export async function sendBackfillEmail(email: string, username: string, lang: EmailLang, count: number): Promise<{ ok: boolean; detail: string }> {
  const { subject, html } = buildBackfillEmail(lang, username, count);
  if (campaignTransportReady().ready) {
    const viaCampaign = await sendEmail(email, subject, html, undefined, { via: 'campaign' });
    if (viaCampaign.ok) return viaCampaign;
  }
  // 回退主通道：这是欠用户的正式通知，不受非关键邮件日限（MAIL_NONCRITICAL_DAILY_LIMIT）拦
  return sendEmail(email, subject, html, undefined, { critical: true });
}

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

/**
 * 批量补发。默认 dry-run（零副作用）。
 * opts:
 *  - count       补发条数（缺省＝REGISTER_CHAT_BONUS，20）
 *  - dryRun      默认 true；false 时补发 + 发信 + 写 marker
 *  - force       默认 false；true 时忽略已有 marker 重新处理全部候选
 *  - sinceMs     漏发窗口结束（缺省＝MISSED_WINDOW_END_MS）
 *  - exclude     主动排除（userId 或邮箱）
 *  - backupPath  调用方在 apply 前生成的一致性备份路径（仅记录进报告）
 *  - throttleMs  每人之间的间隔（默认 200ms，给 SMTP 留余量）
 */
export async function runRegisterBonusBackfill(opts: {
  count?: number;
  dryRun?: boolean;
  force?: boolean;
  sinceMs?: number;
  exclude?: string[];
  backupPath?: string;
  throttleMs?: number;
} = {}): Promise<RegisterBonusRunReport> {
  const count = opts.count ?? REGISTER_CHAT_BONUS_COUNT;
  const dryRun = opts.dryRun !== false;
  const force = !!opts.force;
  const since = opts.sinceMs ?? MISSED_WINDOW_END_MS;
  const throttleMs = opts.throttleMs ?? 200;

  const processed = getBackfillProcessedIds();
  const excludeSet = buildExcludeSet(opts.exclude);
  const totalEligible = listRegisterBonusCandidates(since);
  const candidates = totalEligible.filter((c) => !excludeSet.has(c.userId) && (force || !processed.has(c.userId)));
  const excludedByExclude = totalEligible.filter((c) => excludeSet.has(c.userId)).length;
  const skippedProcessed = totalEligible.length - candidates.length - excludedByExclude;

  const byLanguage: Record<EmailLang, number> = { 'zh-CN': 0, 'zh-TW': 0, en: 0 };
  for (const c of candidates) byLanguage[c.language] += 1;

  if (dryRun) {
    return {
      dryRun: true,
      count,
      missedSince: new Date(since).toISOString(),
      totalEligible: totalEligible.length,
      candidates,
      byLanguage,
      skippedProcessed,
      excludedCount: excludedByExclude,
      granted: 0,
      emailed: 0,
      emailFailed: 0,
      markerExists: readJson<RegisterBonusBackfillMarker | null>(MARKER_FILE, null) !== null,
      backupPath: opts.backupPath,
    };
  }

  let granted = 0;
  let emailed = 0;
  let emailFailed = 0;
  const failures: { email: string; detail: string }[] = [];
  const failedUsers: { userId: string; email: string }[] = [];
  const newlyProcessed = new Set<string>(processed);

  for (const c of candidates) {
    // ① 先补额度（邮件失败不影响额度到账）
    try {
      quotaStore.addChatBonus(c.userId, count, 'register');
      granted += 1;
    } catch (e) {
      console.warn('[RegisterBonusBackfill] 补发失败:', c.userId, (e as Error)?.message);
      continue; // 额度没补上就不发信（避免「说补了其实没补」）
    }
    // ② 再发信
    const res = await sendBackfillEmail(c.email, c.username, c.language, count);
    if (res.ok) emailed += 1;
    else {
      emailFailed += 1;
      failedUsers.push({ userId: c.userId, email: c.email });
      if (failures.length < 30) failures.push({ email: c.email, detail: res.detail });
      console.warn('[RegisterBonusBackfill] 邮件发送失败:', c.email, res.detail);
    }
    newlyProcessed.add(c.userId);
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
  }

  writeJson(MARKER_FILE, {
    count,
    grantedTo: granted,
    emailedTo: emailed,
    at: Date.now(),
    userIds: [...newlyProcessed],
    failed: failedUsers,
  } satisfies RegisterBonusBackfillMarker);

  return {
    dryRun: false,
    count,
    missedSince: new Date(since).toISOString(),
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
    ...(failures.length ? { failures } : {}),
  };
}

export interface EmailRetryReport {
  via: 'default' | 'campaign';
  attempted: number;
  sent: number;
  stillFailed: number;
  failures: { email: string; detail: string }[];
}

/**
 * 只重发「额度已补、邮件没发出去」的那几个人（不重复补额度）。
 * 用途：首次 apply 时 Resend 触顶（550 monthly quota）等，事后换通道（via='campaign' = Gmail 群发通道）补发。
 * 幂等：发成功的从 marker.failed 移除；再跑只处理仍失败的。
 */
export async function runRegisterBonusEmailRetry(opts: {
  via?: 'default' | 'campaign';
  throttleMs?: number;
  /** 显式指定要重发的邮箱（缺省用 marker.failed）——用于 marker 里没记到的偶发失败 */
  emails?: string[];
} = {}): Promise<EmailRetryReport> {
  const via = opts.via ?? 'campaign';
  const throttleMs = opts.throttleMs ?? 300;
  const marker = readJson<RegisterBonusBackfillMarker | null>(MARKER_FILE, null);
  const explicit = (opts.emails || []).map((e) => String(e).trim()).filter(Boolean);
  const failed = explicit.length
    ? explicit.map((email) => ({ userId: accountStore.findByEmail(email)?.userId || '', email }))
    : (marker?.failed || []);
  const count = marker?.count ?? REGISTER_CHAT_BONUS_COUNT;
  const failures: { email: string; detail: string }[] = [];
  const stillFailed: { userId: string; email: string }[] = [];
  let sent = 0;

  for (const f of failed) {
    // 合成/测量地址（example.com 等）：永远投不出去，直接丢弃（不再计入仍失败）
    if (/(^|@)example\.(com|org|net)$/i.test(f.email)) continue;
    const acc = accountStore.getById(f.userId);
    const lang = inferLanguageForUser(f.userId);
    const { subject, html } = buildBackfillEmail(lang, (acc?.username || '').trim(), count);
    const res = await sendEmail(f.email, subject, html, undefined, { via, critical: true });
    if (res.ok) sent += 1;
    else {
      stillFailed.push(f);
      failures.push({ email: f.email, detail: res.detail });
      console.warn('[RegisterBonusBackfill] 重发仍失败:', f.email, res.detail);
    }
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
  }

  if (marker) {
    writeJson(MARKER_FILE, { ...marker, failed: stillFailed, emailedTo: (marker.emailedTo || 0) + sent } satisfies RegisterBonusBackfillMarker);
  }

  return { via, attempted: failed.length, sent, stillFailed: stillFailed.length, failures };
}
