/**
 * 成人向定向邮件（剧情「无限制模式」上线通知）
 *
 * 这是一次**一次性运营邮件**，不是常驻自动化：给「最近活跃 + 玩过剧情扮演」的注册用户
 * 发一封三语邮件，告诉他们剧情模式新增了「无限制模式」，以及去「我的偏好」里怎么开。
 *
 * 与 reengage.ts（场景化召回）刻意分开的理由：
 *   - 召回是**个性化、长期、有上下文**的（按角色/剧本/钩子生成文案），这是一封**统一文案**的公告信；
 *   - 召回有冷却/每日预算/一生次数上限这套「不打扰」机制，一次性公告不需要、也不该共用那套状态；
 *   - 但是**共用同一个退订名单**（reengageStore.optOut）：用户说「不想再收到」，不该因为换了模块就再来一封。
 *
 * 红线（延续项目既有约定）：
 *   - 绝不给处于情绪危机（自伤/自杀类）的用户发促销性质的邮件（复用 reengage 的 isCrisisSafe 口径）；
 *   - **本邮件**绝不替用户打开「无限制模式」，只告诉他在哪儿开；开启前必须先做 18+ 成年确认（adultConfirm.ts）。
 *     （2026-09-27 补充：站内那条「聊一聊 → 去剧情并打开「无限制模式」」的引导卡是**另一条路**
 *      用户按的按钮上明确写着「打开」，所以那份意愿会被带到底：先弹 18+ 闸门，确认后自动开启
 *      （见 RoleplayPage 的 initialAdultIntent）。邮件这条口径不变，仍然只指路、不替用户改设置。）
 *   - 邮件必须带一键退订（List-Unsubscribe），且退订入口与召回共用同一份名单。
 *
 * 通道：独立的群发 SMTP（CAMPAIGN_SMTP_*，默认 myxiaoyu2026@gmail.com），
 * 不占主通道的非关键邮件预算，避免影响注册验证码/改密（见 email.ts 顶部注释）。
 *
 * 数据：只**读** accounts / user-activity / preferences / roleplay-sessions，
 * 只**新增** data/adult-campaign-log.json（投递记录，用于幂等与每日限额），不改任何既有数据文件。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore } from './accounts.js';
import { activityStore, type UserActivity } from './activity.js';
import { preferenceStore } from './preferences.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import { reengageStore, unsubscribeToken, isCrisisSafe } from './reengage.js';
import { isAdultConfirmed } from './adultConfirm.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';
import { sendEmail, campaignTransportReady } from './email.js';
import { type OutputLang } from './zhConvert.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
/** 活跃窗口（天）：用户点名「最近 15 天用过的用户」 */
const ACTIVE_DAYS = Number(process.env.CAMPAIGN_ACTIVE_DAYS || 15);
/** 剧情会话条数下限默认值：1 = 玩过就算（收窄口径由调用方显式指定） */
const DEFAULT_MIN_ROLEPLAY = Number(process.env.CAMPAIGN_MIN_ROLEPLAY || 1);
/** 群发通道每日发信上限（Gmail 侧也有自己的日限额，这里只做更保守的前置刹车） */
const DAILY_CAP = Number(process.env.CAMPAIGN_DAILY_CAP || 100);
/** 本封活动的标识：投递记录按它去重，换活动换 id 即可复用同一套机制 */
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || 'roleplay-unlimited-v1';
const SITE = 'https://myxiaoyu.com/';
const SUPPORT_EMAIL = 'myxiaoyu2026@gmail.com';
/** 发信人显示名：用「Xiaoyu」而非「AI Companion」，与召回邮件的陪伴口吻一致 */
const FROM_NAME = 'Xiaoyu';

const LOG_FILE = dataFile('adult-campaign-log.json');

type Lang = OutputLang;

export type CampaignAudience = 'active' | 'roleplay';

export interface CampaignRecipient {
  userId: string;
  email: string;
  nickname?: string;
  lang: Lang;
  /** 最近一次活跃（用户级，来自 user-activity） */
  lastActiveAt: number;
  /** 剧情扮演会话数（带消息的；不含文游「千世书」） */
  roleplaySessions: number;
  /** 剧情对话总条数（衡量「玩得多不多」；不是剧本数） */
  roleplayMessages: number;
  /** 最近玩过的剧本 id（用于把邮件按钮直达到「我的偏好」抽屉） */
  scenarioId?: string;
  /** 存量「已开启」但还没做成年确认的用户：会随本门槛生效而被要求补一次确认 */
  wasOn: boolean;
  /** 邮件 CTA 落地链接（含 18+ 门槛参数） */
  deepLink: string;
  /** 一键退订链接 */
  unsubUrl: string;
}

/** 排除原因计数（预览时给运营看「为什么少了这些人」） */
export type ExclusionReason =
  | 'noEmail' | 'testOrDev' | 'inactive' | 'noRoleplay' | 'roleplayNotRecent' | 'lowRoleplayDepth' | 'optedOut'
  | 'adultConfirmed' | 'crisis' | 'duplicateEmail' | 'alreadyDelivered';

export interface CampaignPlan {
  audience: CampaignAudience;
  activeDays: number;
  recipients: CampaignRecipient[];
  /** 每个排除原因命中的人数（同一人只记第一个命中的原因） */
  excluded: Record<ExclusionReason, number>;
  byLang: Record<string, number>;
  /** 本次待发里「存量已开启、需补成年确认」的人数 */
  wasOn: number;
  /** 已投递过本活动的人数（幂等去重命中） */
  alreadyDelivered: number;
  /** 群发通道是否就绪（缺 GMAIL 应用专用密码时为 false，预览仍可用） */
  transport: { ready: boolean; reason: string; from: string };
  /** 按 CAMPAIGN_DAILY_CAP 估算：发完这批要几个发送日 */
  dailyCap: number;
  estimatedDays: number;
  /** 今日已发出（本活动）*/
  sentToday: number;
  /** 本次使用的口径参数（写进预览，便于复查「这批人是怎么筛出来的」） */
  minRoleplay: number;
  roleplayWithinDays: number;
  minRoleplayMessages: number;
}

// ---------------------------------------------------------------------------
// 投递记录（幂等 + 每日限额）
// ---------------------------------------------------------------------------
export interface CampaignSendRecord {
  campaignId: string;
  userId: string;
  email: string;
  lang: string;
  sentAt: number;
  ok: boolean;
  error?: string;
}

class CampaignLogStore {
  private items: CampaignSendRecord[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<CampaignSendRecord[]>(LOG_FILE, []);
    if (Array.isArray(parsed)) this.items = parsed;
  }

  private saveToDisk(): void {
    try { writeJson(LOG_FILE, this.items); } catch { /* 忽略 */ }
  }

  /** 本活动是否已成功投递过（幂等：失败的不算，允许重试） */
  isDelivered(userId: string, campaignId: string = CAMPAIGN_ID): boolean {
    return this.items.some(r => r.campaignId === campaignId && r.userId === userId && r.ok);
  }

  /** 今日已成功投递数（按服务器本地日） */
  sentToday(campaignId: string = CAMPAIGN_ID): number {
    const key = localDateKey(Date.now());
    return this.items.filter(r => r.campaignId === campaignId && r.ok && localDateKey(r.sentAt) === key).length;
  }

  record(rec: CampaignSendRecord): void {
    this.items.push(rec);
    // 记录上限护栏：一次性活动也留个上限，避免文件无限增长
    if (this.items.length > 20000) this.items = this.items.slice(-20000);
    this.saveToDisk();
  }

  listAll(campaignId?: string): CampaignSendRecord[] {
    return campaignId ? this.items.filter(r => r.campaignId === campaignId) : this.items.slice();
  }

  stats(campaignId: string = CAMPAIGN_ID): { attempted: number; ok: number; failed: number } {
    const rows = this.listAll(campaignId);
    const ok = rows.filter(r => r.ok).length;
    return { attempted: rows.length, ok, failed: rows.length - ok };
  }
}

export const campaignLogStore = new CampaignLogStore();

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 名单筛选（纯函数，可单测）
// ---------------------------------------------------------------------------
const EMPTY_EXCLUSIONS = (): Record<ExclusionReason, number> => ({
  noEmail: 0, testOrDev: 0, inactive: 0, noRoleplay: 0, roleplayNotRecent: 0, lowRoleplayDepth: 0, optedOut: 0,
  adultConfirmed: 0, crisis: 0, duplicateEmail: 0, alreadyDelivered: 0,
});

/** 筛选所需的全部外部数据，全部由调用方注入，便于单测在不碰真实 store 的情况下跑 */
export interface AudienceInput {
  accounts: { userId: string; email: string; username?: string | null }[];
  /** 用户活跃记录（无则视为从未活跃） */
  activityOf: (userId: string) => UserActivity | undefined;
  /** 有消息的剧情会话：返回数量、段落总数与最近一个剧本 id */
  roleplayOf: (userId: string) => { sessions: number; totalMessages: number; latestScenarioId?: string; latestUpdatedAt: number; recentText: string };
  langOf: (userId: string) => Lang;
  isOptedOut: (userId: string) => boolean;
  isConfirmed: (userId: string) => boolean;
  /** 存量的 roleplayUnlimited 值（用于统计「已开启」） */
  storedUnlimitedOf: (userId: string) => boolean;
  isExcludedAccount: (acc: { username?: string | null; email: string }) => boolean;
  isDelivered: (userId: string) => boolean;
  now: number;
  activeDays: number;
  audience: CampaignAudience;
  /** 剧情会话条数下限（audience='roleplay' 时生效；1 = 玩过就算） */
  minRoleplay?: number;
  /** 剧情会话「最近一次发生」须在这么多天内（0/缺省 = 不限） */
  roleplayWithinDays?: number;
  /**
   * 剧情总对话条数下限（0/缺省 = 不限）。
   * 与 minRoleplay（**开过几个不同剧本**）是两回事：实测多数人只开过 1 个本但会玩很多轮，
   * 按「本数 ≥2」收窄会直接掉到个位数，衡量「玩得多不多」应该看轮数。
   */
  minRoleplayMessages?: number;
}

export function buildAudience(input: AudienceInput): { recipients: CampaignRecipient[]; excluded: Record<ExclusionReason, number>; alreadyDelivered: number } {
  const excluded = EMPTY_EXCLUSIONS();
  const recipients: CampaignRecipient[] = [];
  const cutoff = input.now - input.activeDays * DAY;
  const minRoleplay = input.minRoleplay && input.minRoleplay > 0 ? input.minRoleplay : 1;
  const rpWindowMs = input.roleplayWithinDays && input.roleplayWithinDays > 0 ? input.roleplayWithinDays * DAY : 0;
  const minMessages = input.minRoleplayMessages && input.minRoleplayMessages > 0 ? input.minRoleplayMessages : 0;
  const seenEmails = new Set<string>();
  let alreadyDelivered = 0;

  for (const acc of input.accounts) {
    const userId = acc.userId;
    const email = (acc.email || '').trim().toLowerCase();
    // 排除顺序即「记录原因」的优先级：先看硬性不可能（无邮箱/内部账号），再看行为与合规
    if (!email) { excluded.noEmail++; continue; }
    if (input.isExcludedAccount(acc)) { excluded.testOrDev++; continue; }

    const act = input.activityOf(userId);
    if (!act || !act.lastActiveAt || act.lastActiveAt < cutoff) { excluded.inactive++; continue; }

    const rp = input.roleplayOf(userId);
    if (input.audience === 'roleplay') {
      // 「最近玩过剧情」两个维度分开判：次数不够 vs 玩过但太久没玩，原因分开记，
      // 运营才看得出收窄是哪一维造成的（合成一个计数器等于把信息丢掉）。
      if (rp.sessions < minRoleplay) { excluded.noRoleplay++; continue; }
      if (rpWindowMs && (!rp.latestUpdatedAt || input.now - rp.latestUpdatedAt > rpWindowMs)) { excluded.roleplayNotRecent++; continue; }
      if (minMessages && (rp.totalMessages || 0) < minMessages) { excluded.lowRoleplayDepth++; continue; }
    }

    if (input.isOptedOut(userId)) { excluded.optedOut++; continue; }
    if (input.isConfirmed(userId)) { excluded.adultConfirmed++; continue; }
    if (!isCrisisSafe(`${act.recentActivity?.slice(-1)[0]?.detail || ''}\n${rp.recentText}`)) { excluded.crisis++; continue; }
    if (seenEmails.has(email)) { excluded.duplicateEmail++; continue; }
    if (input.isDelivered(userId)) { alreadyDelivered++; excluded.alreadyDelivered++; continue; }

    seenEmails.add(email);
    const token = unsubscribeToken(userId);
    const qs = new URLSearchParams({ adult: '1', open: 'roleplay', pref: '1' });
    if (rp.latestScenarioId) qs.set('scenario', rp.latestScenarioId);
    recipients.push({
      userId,
      email,
      nickname: acc.username || undefined,
      lang: input.langOf(userId),
      lastActiveAt: act.lastActiveAt,
      roleplaySessions: rp.sessions,
      roleplayMessages: rp.totalMessages || 0,
      scenarioId: rp.latestScenarioId,
      wasOn: input.storedUnlimitedOf(userId),
      deepLink: SITE + '?' + qs.toString(),
      unsubUrl: SITE + 'api/reengage/unsubscribe?userId=' + encodeURIComponent(userId) + '&token=' + token + '&src=campaign',
    });
  }

  // 最久没来的先发：这批人本就更可能流失，先触达收益更高（也天然把「近期活跃」留在后批，降低打扰观感）
  recipients.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  return { recipients, excluded, alreadyDelivered };
}

// ---------------------------------------------------------------------------
// 三语邮件（纯函数：便于单测断言「必含 18+ 声明与退订」）
// ---------------------------------------------------------------------------
interface CopyBlock {
  subject: string;
  greeting: string;
  lead: string;
  whatTitle: string;
  whatBody: string;
  whereTitle: string;
  whereBody: string;
  ageTitle: string;
  ageBody: string;
  limits: string;
  cta: string;
  footer: string;
  unsub: string;
  unsubLink: string;
  support: string;
  /** 纯文本版（不发 HTML 的客户端 / 反垃圾更友好） */
  text: (deepLink: string, unsubUrl: string) => string;
}

const COPY: Record<Lang, CopyBlock> = {
  'zh-CN': {
    subject: '剧情模式更新：内容尺度多了一个可选档',
    greeting: '你好，',
    lead: '剧情模式新增了「无限制模式」，现在可以在「我的偏好」里自行开启，默认是关闭的。',
    whatTitle: '开启后会怎样',
    whatBody: '剧情会改用不受平台内容限制的模型：成年角色之间的亲密与情欲情节会照实书写（不跳过、不净化），角色也会更主动。',
    whereTitle: '在哪里打开',
    whereBody: '进入任意一段剧情 → 右上角的「我的偏好」（滑杆图标）→ 找到「无限制模式」并开启。',
    ageTitle: '关于年龄',
    ageBody: '这个模式仅限年满 18 岁的用户，开启前需要先确认你已成年；未确认时开关不会生效。',
    limits: '无论是否开启，涉及未成年或幼态角色、非自愿、乱伦、兽交的内容都不会被生成，这条底线不变。',
    cta: '进入剧情模式 →',
    footer: '来自 Xiaoyu · 你的每一种情绪，都值得被理解。',
    unsub: '不想再收到这类邮件？',
    unsubLink: '点这里退订',
    support: `有任何问题，回信或联系 ${SUPPORT_EMAIL}，会有专人回复。`,
    text: (d, u) => `剧情模式新增了「无限制模式」，可在「我的偏好」里自行开启，默认关闭。\n\n`
      + `开启后：剧情改用不受平台内容限制的模型，成年角色之间的亲密与情欲情节会照实书写（不跳过、不净化），角色也会更主动。\n\n`
      + `在哪里打开：进入任意一段剧情 → 右上角「我的偏好」（滑杆图标）→ 找到「无限制模式」并开启。\n\n`
      + `关于年龄：仅限年满 18 岁用户，开启前需先确认已成年；未确认时开关不会生效。\n`
      + `无论是否开启，涉及未成年或幼态角色、非自愿、乱伦、兽交的内容都不会被生成。\n\n`
      + `进入剧情模式：${d}\n\n不想再收到这类邮件：${u}\n来自 Xiaoyu · 你的每一种情绪，都值得被理解。`,
  },
  'zh-TW': {
    subject: '劇情模式更新：內容尺度多了一個可選檔',
    greeting: '你好，',
    lead: '劇情模式新增了「無限制模式」，現在可以在「我的偏好」裡自行開啟，預設是關閉的。',
    whatTitle: '開啟後會怎樣',
    whatBody: '劇情會改用不受平台內容限制的模型：成年角色之間的親密與情慾情節會照實書寫（不跳過、不淨化），角色也會更主動。',
    whereTitle: '在哪裡打開',
    whereBody: '進入任意一段劇情 → 右上角的「我的偏好」（滑桿圖示）→ 找到「無限制模式」並開啟。',
    ageTitle: '關於年齡',
    ageBody: '這個模式僅限年滿 18 歲的使用者，開啟前需要先確認你已成年；未確認時開關不會生效。',
    limits: '無論是否開啟，涉及未成年或幼態角色、非自願、亂倫、獸交的內容都不會被生成，這條底線不變。',
    cta: '進入劇情模式 →',
    footer: '來自 Xiaoyu · 你的每一種情緒，都值得被理解。',
    unsub: '不想再收到這類郵件？',
    unsubLink: '點這裡退訂',
    support: `有任何問題，回信或聯繫 ${SUPPORT_EMAIL}，會有專人回覆。`,
    text: (d, u) => `劇情模式新增了「無限制模式」，可在「我的偏好」裡自行開啟，預設關閉。\n\n`
      + `開啟後：劇情改用不受平台內容限制的模型，成年角色之間的親密與情慾情節會照實書寫（不跳過、不淨化），角色也會更主動。\n\n`
      + `在哪裡打開：進入任意一段劇情 → 右上角「我的偏好」（滑桿圖示）→ 找到「無限制模式」並開啟。\n\n`
      + `關於年齡：僅限年滿 18 歲使用者，開啟前需先確認已成年；未確認時開關不會生效。\n`
      + `無論是否開啟，涉及未成年或幼態角色、非自願、亂倫、獸交的內容都不會被生成。\n\n`
      + `進入劇情模式：${d}\n\n不想再收到這類郵件：${u}\n來自 Xiaoyu · 你的每一種情緒，都值得被理解。`,
  },
  en: {
    subject: 'Story mode update: a new content-scope setting',
    greeting: 'Hi,',
    lead: 'Story mode now has an “Unlimited mode” you can turn on yourself under My preferences. It is off by default.',
    whatTitle: 'What it changes',
    whatBody: 'Story mode switches to a model without platform content limits: intimacy and sex between adult characters are written plainly (no skipping, no sanitizing), and the character takes more initiative.',
    whereTitle: 'Where to find it',
    whereBody: 'Open any story → tap My preferences in the top-right (the sliders icon) → turn on “Unlimited mode”.',
    ageTitle: 'About age',
    ageBody: 'This mode is for adults (18+). You will be asked to confirm you are an adult before it can be switched on; without that confirmation the setting will not take effect.',
    limits: 'Either way, content involving minors or childlike characters, non-consent, incest or bestiality is never generated — that line does not move.',
    cta: 'Open story mode →',
    footer: 'From Xiaoyu · Every feeling deserves to be understood.',
    unsub: 'Prefer not to get emails like this?',
    unsubLink: 'Unsubscribe here',
    support: `Questions? Reply to this email or contact ${SUPPORT_EMAIL} — a real person will reply.`,
    text: (d, u) => `Story mode now has an “Unlimited mode” you can turn on yourself under My preferences. It is off by default.\n\n`
      + `What it changes: story mode switches to a model without platform content limits — intimacy and sex between adult characters are written plainly (no skipping, no sanitizing), and the character takes more initiative.\n\n`
      + `Where to find it: open any story → tap My preferences in the top-right (sliders icon) → turn on “Unlimited mode”.\n\n`
      + `About age: this mode is for adults (18+). You will be asked to confirm you are an adult first; without that confirmation the setting will not take effect.\n`
      + `Either way, content involving minors or childlike characters, non-consent, incest or bestiality is never generated.\n\n`
      + `Open story mode: ${d}\n\nUnsubscribe: ${u}\nFrom Xiaoyu · Every feeling deserves to be understood.`,
  },
};

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 渲染一封活动邮件（HTML + 纯文本 + 主题） */
export function renderCampaignEmail(r: Pick<CampaignRecipient, 'lang' | 'deepLink' | 'unsubUrl' | 'nickname'>): { subject: string; html: string; text: string } {
  const c = COPY[r.lang] || COPY['zh-TW'];
  const hi = r.nickname ? `${esc(String(r.nickname).slice(0, 20))}，` : '';
  const html = `<table role="presentation" style="width:100%;max-width:520px;margin:0 auto;background:#FBF6EE;border:1px solid #E4E0D4;border-radius:12px;color:#243B2E;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
    <tr><td style="padding:20px 22px 14px;text-align:center;border-bottom:1px solid #E4E0D4">
      <div style="font-size:30px;line-height:1">🌱</div>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#178353">Xiaoyu · 小愈</p>
      <p style="margin:2px 0 0;font-size:12px;color:#7A8A80">gentle healing, for every feeling</p>
    </td></tr>
    <tr><td style="padding:18px 22px 4px;font-size:15px;line-height:1.75">
      <p style="margin:0 0 10px">${c.greeting}${hi}</p>
      <p style="margin:0 0 14px">${esc(c.lead)}</p>
    </td></tr>
    <tr><td style="padding:0 22px">
      <div style="background:#FFFFFF;border:1px solid #DCE8D5;border-radius:10px;padding:14px 16px;margin:0 0 12px">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#178353">${esc(c.whatTitle)}</p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#243B2E">${esc(c.whatBody)}</p>
      </div>
      <div style="background:#FFFFFF;border:1px solid #DCE8D5;border-radius:10px;padding:14px 16px;margin:0 0 12px">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#178353">${esc(c.whereTitle)}</p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#243B2E">${esc(c.whereBody)}</p>
      </div>
      <div style="background:#FFF7ED;border:1px solid #FDE3C0;border-radius:10px;padding:14px 16px;margin:0 0 6px">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#B45309">${esc(c.ageTitle)}</p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#7C2D12">${esc(c.ageBody)}</p>
        <p style="margin:8px 0 0;font-size:12px;line-height:1.65;color:#92400E">${esc(c.limits)}</p>
      </div>
    </td></tr>
    <tr><td style="padding:14px 22px 6px;text-align:center">
      <a href="${r.deepLink}" style="background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;padding:11px 26px;border-radius:999px;display:inline-block">${esc(c.cta)}</a>
    </td></tr>
    <tr><td style="padding:10px 22px 20px;font-size:11px;color:#A0A7B5;text-align:center;line-height:1.65">
      ${esc(c.footer)}<br/>${esc(c.support)}<br/>${esc(c.unsub)}<a href="${r.unsubUrl}" style="color:#178353;text-decoration:underline">${esc(c.unsubLink)}</a>
    </td></tr>
  </table>`;
  return { subject: c.subject, html, text: c.text(r.deepLink, r.unsubUrl) };
}

// ---------------------------------------------------------------------------
// 生成计划（dry-run 与 apply 共用）
// ---------------------------------------------------------------------------
function langOf(userId: string): Lang {
  try {
    const l = preferenceStore.get(userId).language;
    if (l === 'zh-CN' || l === 'en' || l === 'zh-TW') return l;
  } catch { /* 忽略 */ }
  return 'zh-TW'; // 与 preferences.ts 的默认语言一致
}

function roleplayOf(userId: string): { sessions: number; totalMessages: number; latestScenarioId?: string; latestUpdatedAt: number; recentText: string } {
  const rows = roleplaySessionStore.listAll()
    .filter(r => r.userId === userId && Array.isArray(r.messages) && r.messages.length > 0);
  if (!rows.length) return { sessions: 0, totalMessages: 0, latestUpdatedAt: 0, recentText: '' };
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = rows[0];
  const totalMessages = rows.reduce((n, r) => n + (r.messages?.length || 0), 0);
  const recentText = latest.messages.slice(-3).map(m => m.content || '').join('\n').slice(0, 400);
  return { sessions: rows.length, totalMessages, latestScenarioId: latest.scenarioId, latestUpdatedAt: latest.updatedAt, recentText };
}

export function planCampaign(opts: { audience?: CampaignAudience; days?: number; now?: number; minRoleplay?: number; roleplayWithinDays?: number; minRoleplayMessages?: number } = {}): CampaignPlan {
  const now = opts.now ?? Date.now();
  const audience: CampaignAudience = opts.audience === 'roleplay' ? 'roleplay' : 'active';
  const activeDays = opts.days && opts.days > 0 ? opts.days : ACTIVE_DAYS;
  const minRoleplay = opts.minRoleplay && opts.minRoleplay > 0 ? Math.floor(opts.minRoleplay) : DEFAULT_MIN_ROLEPLAY;
  const roleplayWithinDays = opts.roleplayWithinDays && opts.roleplayWithinDays > 0 ? Math.floor(opts.roleplayWithinDays) : 0;
  const minRoleplayMessages = opts.minRoleplayMessages && opts.minRoleplayMessages > 0 ? Math.floor(opts.minRoleplayMessages) : 0;

  const { recipients, excluded, alreadyDelivered } = buildAudience({
    accounts: accountStore.listAll(),
    activityOf: (id) => activityStore.get(id),
    roleplayOf,
    langOf,
    isOptedOut: (id) => reengageStore.isOptedOut(id),
    isConfirmed: (id) => isAdultConfirmed(id),
    storedUnlimitedOf: (id) => { try { return preferenceStore.get(id).roleplayUnlimited === true; } catch { return false; } },
    isExcludedAccount: (acc) => isTestAccount(acc) || isDeveloperAccount(acc),
    isDelivered: (id) => campaignLogStore.isDelivered(id),
    now, activeDays, audience, minRoleplay, roleplayWithinDays, minRoleplayMessages,
  });

  const byLang: Record<string, number> = {};
  for (const r of recipients) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
  const sentToday = campaignLogStore.sentToday();
  const remainingToday = Math.max(0, DAILY_CAP - sentToday);
  const days = remainingToday > 0
    ? Math.max(1, Math.ceil(Math.max(0, recipients.length - remainingToday) / DAILY_CAP) + 1)
    : Math.max(1, Math.ceil(recipients.length / DAILY_CAP) + 1);

  return {
    audience, activeDays, recipients, excluded,
    byLang,
    wasOn: recipients.filter(r => r.wasOn).length,
    alreadyDelivered,
    transport: campaignTransportReady(),
    dailyCap: DAILY_CAP,
    estimatedDays: recipients.length === 0 ? 0 : days,
    sentToday,
    minRoleplay,
    roleplayWithinDays,
    minRoleplayMessages,
  };
}

// ---------------------------------------------------------------------------
// 投递
// ---------------------------------------------------------------------------
export interface CampaignRunSummary {
  applied: boolean;
  campaignId: string;
  audience: CampaignAudience;
  activeDays: number;
  planned: number;
  sent: number;
  failed: number;
  skippedByCap: number;
  transport: { ready: boolean; reason: string; from: string };
  /**
   * 名单明细。**dry-run 审批要看的正是这些**：为什么少了人（排除原因）、语言分布、
   * 每日上限与发完这批要几个发送日。少了它们，预览只剩一个「planned=54」，
   * 运营没法判断该不该按发送，所以必须一并回传，不能只留在内部的 CampaignPlan 里。
   */
  excluded: Record<ExclusionReason, number>;
  byLang: Record<string, number>;
  wasOn: number;
  alreadyDelivered: number;
  dailyCap: number;
  estimatedDays: number;
  sentToday: number;
  /** 本次口径参数（复查用） */
  minRoleplay: number;
  roleplayWithinDays: number;
  minRoleplayMessages: number;
  /** dry-run：前几封样例（含主题与渲染后的 HTML，供人工过目） */
  samples: { userId: string; email: string; lang: string; subject: string; html: string; text: string; deepLink: string }[];
  errors: { userId: string; email: string; detail: string }[];
}

/**
 * 跑一次活动。
 * @param opts.apply false（默认）= dry-run：只出名单/样例/预估，不发信；
 *                    true = 真发，受 CAMPAIGN_DAILY_CAP 与幂等记录约束。
 */
export async function runAdultCampaign(opts: { apply?: boolean; audience?: CampaignAudience; days?: number; limit?: number; sampleCount?: number; minRoleplay?: number; roleplayWithinDays?: number; minRoleplayMessages?: number } = {}): Promise<CampaignRunSummary> {
  const plan = planCampaign({ audience: opts.audience, days: opts.days, minRoleplay: opts.minRoleplay, roleplayWithinDays: opts.roleplayWithinDays, minRoleplayMessages: opts.minRoleplayMessages });
  const summary: CampaignRunSummary = {
    applied: !!opts.apply,
    campaignId: CAMPAIGN_ID,
    audience: plan.audience,
    activeDays: plan.activeDays,
    planned: plan.recipients.length,
    sent: 0, failed: 0, skippedByCap: 0,
    transport: plan.transport,
    // 名单明细随 summary 一起回传：dry-run 审批看的正是「为什么少了人 / 各语言多少封 / 要发几天」
    excluded: plan.excluded,
    byLang: plan.byLang,
    wasOn: plan.wasOn,
    alreadyDelivered: plan.alreadyDelivered,
    dailyCap: plan.dailyCap,
    estimatedDays: plan.estimatedDays,
    sentToday: plan.sentToday,
    minRoleplay: plan.minRoleplay,
    roleplayWithinDays: plan.roleplayWithinDays,
    minRoleplayMessages: plan.minRoleplayMessages,
    samples: [],
    errors: [],
  };

  const sampleCount = opts.sampleCount && opts.sampleCount > 0 ? Math.min(opts.sampleCount, 10) : 3;

  if (!opts.apply) {
    // 样例按语言各取一封（运营需要逐语言过目），不足则用前几封补
    const picked: CampaignRecipient[] = [];
    const langsSeen = new Set<string>();
    for (const r of plan.recipients) {
      if (!langsSeen.has(r.lang)) { langsSeen.add(r.lang); picked.push(r); }
      if (picked.length >= sampleCount) break;
    }
    for (const r of plan.recipients) {
      if (picked.length >= sampleCount) break;
      if (!picked.includes(r)) picked.push(r);
    }
    summary.samples = picked.map(r => {
      const mail = renderCampaignEmail(r);
      return { userId: r.userId, email: r.email, lang: r.lang, subject: mail.subject, html: mail.html, text: mail.text, deepLink: r.deepLink };
    });
    return summary;
  }

  // 真发：每日限额（今日已发 + 本次上限不得超过 CAMPAIGN_DAILY_CAP）
  const remainingToday = Math.max(0, DAILY_CAP - campaignLogStore.sentToday());
  const want = opts.limit && opts.limit > 0 ? Math.min(opts.limit, remainingToday) : remainingToday;
  const batch = plan.recipients.slice(0, want);
  summary.skippedByCap = Math.max(0, plan.recipients.length - batch.length);

  for (const r of batch) {
    const mail = renderCampaignEmail(r);
    const res = await sendEmail(r.email, mail.subject, mail.html, FROM_NAME, {
      unsubUrl: r.unsubUrl,
      text: mail.text,
      via: 'campaign',
    });
    campaignLogStore.record({
      campaignId: CAMPAIGN_ID, userId: r.userId, email: r.email, lang: r.lang,
      sentAt: Date.now(), ok: res.ok, error: res.ok ? undefined : res.detail,
    });
    if (res.ok) summary.sent++;
    else {
      summary.failed++;
      summary.errors.push({ userId: r.userId, email: r.email, detail: res.detail });
    }
  }
  return summary;
}

/** 供运营端展示：本活动的累计投递情况 */
export function campaignStats(): { campaignId: string; attempted: number; ok: number; failed: number; sentToday: number; dailyCap: number; transport: { ready: boolean; reason: string; from: string } } {
  return {
    campaignId: CAMPAIGN_ID,
    ...campaignLogStore.stats(),
    sentToday: campaignLogStore.sentToday(),
    dailyCap: DAILY_CAP,
    transport: campaignTransportReady(),
  };
}

export const CAMPAIGN_CONST = { CAMPAIGN_ID, ACTIVE_DAYS, DAILY_CAP, SITE };
