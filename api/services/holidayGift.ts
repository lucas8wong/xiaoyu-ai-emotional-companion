/**
 * 节日礼：限时给「所有注册用户」赠送 N 天完整 Pro（**含活动期内新注册的用户**）。
 *
 * 与另两个「送 Pro」模块的分工（别重复造轮子，也别混用）：
 *  - `proTrial.ts`           老用户一次性 7 天体验，只在服务启动时跑一次、只覆盖「启动那一刻已存在」的账号；
 *  - `proTrialNewcomer.ts`   新人礼，只发给「当前无会员 + 从未领过试用」的注册用户，且发恭喜邮件；
 *  - 本模块（节日礼）         面向**所有注册账号**（不筛档位、不筛是否领过试用），活动窗口内新注册的也即时发；
 *    不发邮件、不写 `trialProGrantedAt`（授权用 `quotaStore.grantProGift`，理由见该方法注释）。
 *
 * 配置（`.env`，未配置 `HOLIDAY_GIFT_ID` 或日期非法 = 活动关闭，防误发）：
 *  - `HOLIDAY_GIFT_ID`     活动标识（如 `national-day-2026`），写进 marker，用于区分多轮节日礼与幂等；
 *  - `HOLIDAY_GIFT_DAYS`   赠送天数（默认 1）；
 *  - `HOLIDAY_GIFT_START`  活动开始日期 YYYY-MM-DD（当天 00:00 起）；
 *  - `HOLIDAY_GIFT_END`    活动结束日期 YYYY-MM-DD（含当天 23:59:59.999；留空 = 与 START 同一天）。
 *
 * 幂等：`data/holiday-gift.json` 按 `campaignId` 记录已发放的 userId。
 * 「过去注册的」由运营经 admin 接口批量发放（`runHolidayGift`，默认 dry-run）；
 * 「当天新注册的」由注册链路即时发放（`maybeGrantHolidayGiftOnRegister`）——两者共用同一份 marker，
 * 所以先批量后注册不会重复，先注册后批量也会被 marker 跳过。
 *
 * ⚠️ apply 必须交给运行中的 3001 进程执行（本项目数据在 SQLite，业务 store 是「整逻辑文件读写」，
 * 独立进程直接改会与在线服务产生丢失更新）。见 `scripts/grant-holiday-gift.mts`。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore, type Account } from './accounts.js';
import { quotaStore } from './quota.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';

const MARKER_FILE = dataFile('holiday-gift.json');

export interface HolidayGiftConfig {
  /** 活动标识；空 = 未启用 */
  campaignId: string;
  /** 赠送天数（>=1） */
  days: number;
  /** 开始日期 YYYY-MM-DD */
  start: string;
  /** 结束日期 YYYY-MM-DD（含当天） */
  end: string;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 读取节日礼配置（纯读 env，便于单测注入） */
export function holidayGiftConfig(env: NodeJS.ProcessEnv = process.env): HolidayGiftConfig {
  const campaignId = String(env.HOLIDAY_GIFT_ID || '').trim();
  const rawDays = Number(env.HOLIDAY_GIFT_DAYS || 1);
  const start = String(env.HOLIDAY_GIFT_START || '').trim();
  const end = String(env.HOLIDAY_GIFT_END || '').trim() || start;
  return { campaignId, days: rawDays > 0 ? rawDays : 1, start, end };
}

/** 解析 YYYY-MM-DD（boundary=start → 00:00:00.000；boundary=end → 23:59:59.999）；非法返回 null */
function parseYmd(s: string, boundary: 'start' | 'end'): number | null {
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = boundary === 'start'
    ? new Date(y, mo - 1, d, 0, 0, 0, 0)
    : new Date(y, mo - 1, d, 23, 59, 59, 999);
  // 真实日历校验（挡掉 2026-99-99 / 2026-02-30）
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

/** 节日礼是否进行中（含首尾两天；未配置 ID / 日期非法 → false） */
export function isHolidayGiftActive(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = holidayGiftConfig(env);
  if (!cfg.campaignId) return false;
  const startMs = parseYmd(cfg.start, 'start');
  const endMs = parseYmd(cfg.end, 'end');
  if (startMs === null || endMs === null) return false;
  const t = now.getTime();
  return t >= startMs && t <= endMs;
}

export interface HolidayGiftCandidate {
  userId: string;
  username: string;
  email: string;
}

/** 候选口径：注册账号 + 有邮箱 + 非测试/开发者账号（与 registerBonusBackfill 同一份过滤，避免口径漂移） */
function isGiftEligible(acc: Account): boolean {
  if (!acc.email) return false;
  if (isTestAccount(acc)) return false;
  if (isDeveloperAccount(acc)) return false;
  return true;
}

/** 列出全部候选（不改任何数据） */
export function listHolidayGiftCandidates(): HolidayGiftCandidate[] {
  const out: HolidayGiftCandidate[] = [];
  for (const acc of accountStore.listAll()) {
    if (!isGiftEligible(acc)) continue;
    out.push({ userId: acc.userId, username: (acc.username || '').trim(), email: acc.email });
  }
  return out;
}

interface HolidayGiftCampaignRecord {
  days: number;
  grantedTo: number;
  at: number;
  userIds: string[];
}
interface HolidayGiftMarker {
  /** campaignId → 该轮已发放记录 */
  campaigns: Record<string, HolidayGiftCampaignRecord>;
}

/** 某轮活动已发放的 userId（未执行过返回空集） */
export function getHolidayGiftGrantedIds(campaignId: string): Set<string> {
  const marker = readJson<HolidayGiftMarker | null>(MARKER_FILE, null);
  return new Set(marker?.campaigns?.[campaignId]?.userIds || []);
}

export interface HolidayGiftRunReport {
  dryRun: boolean;
  campaignId: string;
  days: number;
  /** 当下是否在活动窗口内（批量发放不强制要求，但报告里给出，便于判断「现在跑是否含新注册即时发放」） */
  active: boolean;
  totalEligible: number;
  candidates: HolidayGiftCandidate[];
  /** 本轮要处理的（= 候选 − 已发放 − 主动排除） */
  toProcess: number;
  skippedProcessed: number;
  excludedCount: number;
  granted: number;
  markerExists: boolean;
  backupPath?: string;
}

/** 把 exclude 列表解析成 userId 集：每项可为 userId 或邮箱（大小写不敏感，与新人礼同口径） */
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
 * 批量发放节日礼。默认 dry-run（零副作用：不授权、不写 marker）。
 * opts:
 *  - campaignId 活动标识（缺省 .env HOLIDAY_GIFT_ID）
 *  - days       赠送天数（缺省 .env HOLIDAY_GIFT_DAYS / 1）
 *  - dryRun     默认 true；false 时授权 + 写 marker
 *  - force      默认 false；true 时忽略 marker 重新处理全部候选（⚠️ 会重复延长时长，仅特殊情况下用）
 *  - backupPath 调用方在 apply 前生成的一致性备份路径（仅记录进报告）
 *  - exclude    排除名单（userId 或邮箱）
 */
export function runHolidayGift(opts: {
  campaignId?: string;
  days?: number;
  dryRun?: boolean;
  force?: boolean;
  exclude?: string[];
  backupPath?: string;
} = {}): HolidayGiftRunReport {
  const cfg = holidayGiftConfig();
  const campaignId = String(opts.campaignId || cfg.campaignId || '').trim();
  if (!campaignId) throw new Error('未配置 HOLIDAY_GIFT_ID（节日礼活动标识），拒绝执行');
  const days = opts.days ?? cfg.days;
  const dryRun = opts.dryRun !== false;
  const force = !!opts.force;

  const markerExists = readJson<HolidayGiftMarker | null>(MARKER_FILE, null) !== null;
  const processed = getHolidayGiftGrantedIds(campaignId);
  const excludeSet = buildExcludeSet(opts.exclude);
  const totalEligible = listHolidayGiftCandidates();
  const candidates = totalEligible.filter((c) => !excludeSet.has(c.userId) && (force || !processed.has(c.userId)));
  const excludedByExclude = totalEligible.filter((c) => excludeSet.has(c.userId)).length;
  const skippedProcessed = totalEligible.length - candidates.length - excludedByExclude;

  if (dryRun) {
    return {
      dryRun: true, campaignId, days, active: isHolidayGiftActive(),
      totalEligible: totalEligible.length, candidates,
      toProcess: candidates.length, skippedProcessed, excludedCount: excludedByExclude,
      granted: 0, markerExists, backupPath: opts.backupPath,
    };
  }

  const newlyProcessed = new Set(processed);
  let granted = 0;
  for (const c of candidates) {
    try {
      quotaStore.grantProGift(c.userId, days);
      newlyProcessed.add(c.userId);
      granted += 1;
    } catch (e) {
      // 日志只留 userId 前 8 位（PII 最小化，与新人礼一致）
      console.warn('[HolidayGift] 授权失败:', c.userId.slice(0, 8), (e as Error)?.message);
    }
  }

  const marker = readJson<HolidayGiftMarker | null>(MARKER_FILE, null);
  const campaigns: Record<string, HolidayGiftCampaignRecord> = { ...(marker?.campaigns || {}) };
  campaigns[campaignId] = { days, grantedTo: newlyProcessed.size, at: Date.now(), userIds: [...newlyProcessed] };
  writeJson(MARKER_FILE, { campaigns } satisfies HolidayGiftMarker);

  console.log(`🎁 [HolidayGift] ${campaignId} 已为 ${granted} 位注册用户赠送 ${days} 天 Pro（累计 ${newlyProcessed.size} 位）`);

  return {
    dryRun: false, campaignId, days, active: isHolidayGiftActive(),
    totalEligible: totalEligible.length, candidates,
    toProcess: candidates.length, skippedProcessed, excludedCount: excludedByExclude,
    granted, markerExists, backupPath: opts.backupPath,
  };
}

/**
 * 注册链路即时发放：活动窗口内、新注册用户、有邮箱、非测试/开发者 → 赠送节日 Pro。
 * 幂等：已在本轮 marker 中的 userId 直接跳过（与批量发放共用一份 marker）。
 * 不抛错（调用方在注册链路里包了 try/catch，但仍保证任何分支都有返回值）。
 */
export function maybeGrantHolidayGiftOnRegister(userId: string): {
  granted: boolean;
  days?: number;
  reason?: string;
} {
  const cfg = holidayGiftConfig();
  if (!cfg.campaignId || !isHolidayGiftActive()) return { granted: false, reason: 'campaign-inactive' };
  const acc = accountStore.getById(userId);
  if (!acc || !isGiftEligible(acc)) return { granted: false, reason: 'not-eligible' };

  const processed = getHolidayGiftGrantedIds(cfg.campaignId);
  if (processed.has(userId)) return { granted: false, reason: 'already-granted' };

  try {
    quotaStore.grantProGift(userId, cfg.days);
  } catch (e) {
    return { granted: false, reason: 'grant-failed', days: cfg.days };
  }
  processed.add(userId);

  const marker = readJson<HolidayGiftMarker | null>(MARKER_FILE, null);
  const campaigns: Record<string, HolidayGiftCampaignRecord> = { ...(marker?.campaigns || {}) };
  campaigns[cfg.campaignId] = { days: cfg.days, grantedTo: processed.size, at: Date.now(), userIds: [...processed] };
  writeJson(MARKER_FILE, { campaigns } satisfies HolidayGiftMarker);

  return { granted: true, days: cfg.days };
}
