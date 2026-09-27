/**
 * 🩺 自愈引擎（2026-09-18 新增）：**检测「某个用户出问题了」→ 白名单修复 → 复查 → 报到运营卡**。
 *
 * 为什么要它：2026-09-18 一天里连着三次问题（Twinkle 的「最后一句没人接」、小愈的朋友的「半截回复被
 * 当成写完了」、「重新生成」把截断态整份写上去）都是**用户先发现、再由人去查**。运营卡（🚨 AI 失败）
 * 只能看到**匿名计数**，看不到「具体哪个用户、坏在哪、修好没有」。这里把这套变成本产品自己的能力：
 * 每个被检测到的问题产生一条**极简修复报告**（原因 / 怎么解决 / 现状），直接长在那张卡上。
 *
 * ── 设计红线（与 AGENTS.md 一致，改这里之前先读一遍）─────────────────────────────
 *   1. **绝不生成内容、绝不替角色编台词**：只做「可判定」的修复（补标记 / 补时间戳 / 版本自洽 / 回填剧名快照）。
 *      丢掉的回复**修不回来就是修不回来**——那样的问题只做「用户可自助续接 + 如实报告」。
 *   2. **绝不改 user 消息**；内容删除类（历史里的失败兜底文案）**默认只报告不执行**（需 `SELF_HEAL_DELETE=1`）。
 *   3. 任何写入前**先备份原文**到 `temp/self-heal-backup/`，单次修复有上限，模式可一键切换/关闭。
 *   4. 记录写进**自己的** kv（`data/self-heal.json`），**绝不写进业务 messages**（红线 6：提示/报告不是角色台词）。
 *   5. **测试设备不计**（device id 以 `test-` 开头）：自测/验证脚本不污染运营卡。
 *   6. **不做生成型修复**：不会为了"看起来接上了"去调模型补一句话 —— 那等于把 AI 文本塞进用户历史。
 *
 * ── 模式（`SELF_HEAL`）─────────────────────────────────────────────────────────
 *   - `apply`（默认）：扫描 + **执行白名单里的安全修复**（改前备份、改后复查）；
 *   - `dry`：只扫描、只记录（状态标 `observed`），一行数据都不动 —— 想先观察几天用这个；
 *   - `off`：完全不跑（定时器不起、接口返回 mode=off）。
 *
 * ── 与「AI 失败卡」的分工 ──────────────────────────────────────────────────────
 *   上面那张卡回答「今天 AI 没接上几次、用户看到了什么」——**匿名、聚合**；
 *   本引擎回答「哪个用户的那条会话坏了、我修了没有、现在什么状态」——**具体、可复查**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { roleplaySessionStore, normalizeVersions, type RoleplayMessage, type RoleplaySessionRecord } from './roleplaySessions.js';
import { customRoleplayStore } from './customRoleplay.js';
import { accountStore } from './accounts.js';
import { looksIncomplete } from '../../src/lib/replyCompleteness.js';
import { isFallbackBubble } from '../../src/lib/fallbackBubbles.js';

const FILE = dataFile('self-heal.json');
/** 记录条数上限（卡片只显示最近几条，这里只是别让 kv 无限膨胀） */
const MAX_RECORDS = 300;
/** 备份文件保留个数 */
const MAX_BACKUPS = 20;

export type HealMode = 'off' | 'dry' | 'apply';
/** `fixed` 改了数据且复查通过 · `mitigated` 无需改数据（用户可自助） · `needs_human` 需人拍板（内容删除类） · `observed` 观察模式未动手 · `pending` 本轮修复额度用满、下一轮继续 · `failed` 动手了但复查没过 */
export type HealStatus = 'fixed' | 'mitigated' | 'needs_human' | 'observed' | 'pending' | 'failed';
export type HealKind =
  | 'UNANSWERED_TAIL'          // 末句没人接
  | 'HALF_REPLY_UNMARKED'      // 半截回复没打标记
  | 'MISSING_TIMESTAMP'        // 消息缺时间戳
  | 'VERSIONS_INCONSISTENT'    // 多版本候选与正文对不上
  | 'FALLBACK_IN_HISTORY'      // 历史里留着失败兜底文案（红线 6 残留，默认只报告）
  | 'TITLE_SNAPSHOT_MISSING';  // 会话缺剧名快照

export interface HealRecord {
  /** 稳定 id：`kind|userId|scenarioId|sig` 的短哈希 —— 同一问题重复发现只更新同一条，不刷屏 */
  id: string;
  kind: HealKind;
  status: HealStatus;
  /** 首次发现时间 */
  at: number;
  /** 最近一次复查时间 */
  lastAt: number;
  /** 被观察到几次（说明它是不是一直没解决） */
  seen: number;
  userId: string;
  /** 昵称（拿不到就不带；**不带邮箱**，报告只到"哪个用户"这个粒度） */
  user?: string;
  scenarioId: string;
  title?: string;
  /** 原因（一句话人话） */
  cause: string;
  /** 怎么解决（做了什么） */
  action: string;
  /**
   * 现状（一句话）——**只写描述，不要自带状态标签**。
   * 为什么：状态由卡片按 `status` 渲染成「✅ 已修复 / ⚠️ 待人工 …」，若 `now` 里再带一遍，
   * 卡片上就会出现「现状：✅ 已缓解 ✅ 已缓解：…」这种重复（2026-09-18 第一版真机截图抓到）。
   */
  now: string;
  before?: string;
  after?: string;
  /** 修复后复查是否通过（`mitigated` 时表示"确认无需改数据"） */
  verified?: boolean;
}

export interface HealRunSummary {
  mode: HealMode;
  applied: boolean;
  at: number;
  durationMs: number;
  scanned: number;
  skippedTest: number;
  detected: number;
  fixed: number;
  mitigated: number;
  needsHuman: number;
  observed: number;
  pending: number;
  failed: number;
  /** 本次新建/更新的记录（卡片据此显示"最近几次修了什么"） */
  records: HealRecord[];
  /** 备份文件（本次真的写了数据时才有） */
  backup?: string;
}

/**
 * ⚠️ `cause` / `action` / `now` 是**纯文本报告字段**（会被原样渲染进运营卡）：
 *    不要写 Markdown 标记（`**加粗**`、`#`、`[]()`）——2026-09-18 真机实拍就抓到过
 *    「**user 消息一律不动**」两个星号直接显示给管理员看。要强调就用「」或直接说清楚。
 */
interface HealFinding {
  kind: HealKind;
  sig: string;
  cause: string;
  action: string;
  now: string;
  /** 需要改动时给出的 patch；不给 = 只报告（D1 这类"改不了"的问题） */
  repair?: { messages?: RoleplayMessage[]; scenarioTitle?: string };
  /** 内容删除类：默认只报告（需 SELF_HEAL_DELETE=1） */
  destructive?: boolean;
  /** 修复后复查（拿到的是**重新读出来**的记录） */
  verify?: (after: { messages: RoleplayMessage[] | null; title?: string }) => boolean;
  before?: string;
  after?: string;
}

// ── 配置（全部可 env 覆盖；默认值都写在函数里，改了要同步注释）────────────────────

export function selfHealMode(): HealMode {
  const raw = String(process.env.SELF_HEAL ?? 'apply').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'dry' || raw === 'observe') return 'dry';
  return 'apply';
}
/** 是否允许**内容删除类**修复自动执行（默认 0 = 只报告）。export 给 server.ts 打启动日志、卡片显示口径。 */
export function deleteAllowed(): boolean {
  return String(process.env.SELF_HEAL_DELETE ?? '0') === '1';
}
/**
 * 单次巡检最多修几条（防失控）。默认 200：**幂等 + 写前备份**之下，一次性清掉历史欠账比"每 15 分钟磨 50 条"
 * 更有用（2026-09-18 首次上线时库里积了 66 条缺时间戳 / 25 条缺剧名快照 / 13 条半截未标记）。
 * 超出的那部分**如实标 `pending`（待下一轮）**，绝不谎报"已缓解"。
 */
function maxRepairs(): number {
  const n = Number(process.env.SELF_HEAL_MAX_REPAIRS ?? 200);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}
/** 「末句没人接」判定为"稳定卡住"的静默时长（默认 10 分钟：生成中/正在续写的不算） */
function staleMs(): number {
  const n = Number(process.env.SELF_HEAL_STALE_MIN ?? 10);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60 * 1000;
}

/** 测试设备（device id 前缀）——与 isTestRequest 同口径，自测不留痕 */
const isTestDevice = (userId: string): boolean => /^test-/i.test(String(userId || ''));

const shortHash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
const tailSig = (m: RoleplayMessage | undefined): string => {
  if (!m) return '-';
  const c = String(m.content || '');
  return c.length + ':' + shortHash(c.slice(-40));
};

// ── 记录存储 ─────────────────────────────────────────────────────────────────

interface Shape {
  records: HealRecord[];
  scans: number;
  lastScanAt: number;
  lastRun?: Omit<HealRunSummary, 'records'>;
}

class SelfHealStore {
  private data: Shape = { records: [], scans: 0, lastScanAt: 0 };

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<Shape>(FILE, { records: [], scans: 0, lastScanAt: 0 });
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
      this.data = {
        records: parsed.records.filter((r) => r && r.id && r.kind),
        scans: Number(parsed.scans) || 0,
        lastScanAt: Number(parsed.lastScanAt) || 0,
        ...(parsed.lastRun ? { lastRun: parsed.lastRun } : {}),
      };
    }
  }

  private saveToDisk(): void {
    try { writeJson(FILE, this.data); } catch { /* 忽略：自愈记录写失败绝不影响主流程 */ }
  }

  /** 同 id 只留一条（更新状态/次数/时间），新的在最前 */
  upsert(rec: HealRecord): void {
    const i = this.data.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) {
      const prev = this.data.records[i];
      this.data.records[i] = { ...rec, at: prev.at, seen: prev.seen + 1 };
      const [moved] = this.data.records.splice(i, 1);
      this.data.records.unshift(moved);
    } else {
      this.data.records.unshift(rec);
    }
    if (this.data.records.length > MAX_RECORDS) this.data.records.length = MAX_RECORDS;
  }

  /** 一次巡检收尾：更新统计。`seenIds` = 本次仍存在的记录 id（未被看到的 `needs_human` 自动收口为"已不存在"） */
  finishRun(run: HealRunSummary, seenIds: Set<string>): void {
    this.data.scans += 1;
    this.data.lastScanAt = run.at;
    const { records: _drop, ...light } = run;
    this.data.lastRun = light;
    for (const r of this.data.records) {
      if (r.status === 'needs_human' && !seenIds.has(r.id)) {
        r.status = 'mitigated';
        r.now = '复查时该条件已不存在（无需处理）';
        r.lastAt = run.at;
        r.verified = true;
      }
    }
    this.saveToDisk();
  }

  summary(days = 7): {
    mode: HealMode; scans: number; lastScanAt: number; deleteAllowed: boolean;
    totals: Record<HealStatus, number>; records: HealRecord[]; lastRun?: Omit<HealRunSummary, 'records'>;
  } {
    const since = Date.now() - Math.max(1, Math.min(90, Math.floor(days) || 7)) * 86400000;
    // ⚠️ totals 必须与 records 用**同一个窗口**：第一版是"records 按窗口、totals 全部时间"，
    //    于是在"今日"视图下会看到「今日 0 条新记录」而数字块还挂着历史累计，两处口径打架。
    const totals: Record<HealStatus, number> = { fixed: 0, mitigated: 0, needs_human: 0, observed: 0, pending: 0, failed: 0 };
    for (const r of this.data.records) if (r.lastAt >= since && totals[r.status] !== undefined) totals[r.status] += 1;
    return {
      mode: selfHealMode(),
      scans: this.data.scans,
      lastScanAt: this.data.lastScanAt,
      deleteAllowed: deleteAllowed(),
      totals,
      records: this.data.records.filter((r) => r.lastAt >= since),
      ...(this.data.lastRun ? { lastRun: this.data.lastRun } : {}),
    };
  }

  listAll(): HealRecord[] { return this.data.records; }
}

export const selfHealStore = new SelfHealStore();

// ── 检测器（每个都返回「发现的问题 + 能怎么修 + 修完怎么复查」）────────────────────

function scanSession(rec: RoleplaySessionRecord, now: number, user?: string): HealFinding[] {
  const out: HealFinding[] = [];
  const msgs = Array.isArray(rec.messages) ? rec.messages : [];
  if (msgs.length === 0) return out;
  const last = msgs[msgs.length - 1];
  const base = { userId: rec.userId, scenarioId: rec.scenarioId, title: rec.scenarioTitle };

  // ① 末句没人接（Twinkle 案）：稳定静默超过阈值、尾部停在用户消息上、之前确实有角色回复。
  //    这一类**改不了**（丢掉的回复没法找回，也绝不替角色编）→ 只做"确保用户能自助续接"并如实报告。
  if (last?.role === 'user' && msgs.length >= 2 && msgs.some((m) => m.role === 'assistant')
    && now - (rec.updatedAt || 0) > staleMs()) {
    out.push({
      kind: 'UNANSWERED_TAIL',
      sig: msgs.length + ':' + tailSig(last),
      cause: '末句没人接：最后一条是用户消息，之后没有任何角色回复（生成途中离开 / 旧客户端把截断态写上了）',
      action: '不改任何内容（丢掉的回复无法找回、绝不替角色编）：保留原文，前端按尾部形态自动给出「这一句还没等到回答 · 继续说」入口',
      now: '用户重进这段剧情可一键让角色接上（这一条的回复已丢失，无法找回）',
      verify: (after) => Array.isArray(after.messages) && after.messages.length === msgs.length
        && after.messages[after.messages.length - 1]?.role === 'user',
      before: `${msgs.length} 条`,
      after: `${msgs.length} 条（未改）`,
    });
  }

  // ② 最新一条回复断在半句、但库里没有「没写完」标记 → 补标记（正文一字不改）
  if (last?.role === 'assistant' && String(last.content || '').trim() && last.incomplete !== true
    && looksIncomplete(String(last.content))) {
    const patched = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, incomplete: true as const } : m));
    out.push({
      kind: 'HALF_REPLY_UNMARKED',
      sig: 'v' + msgs.length + ':' + tailSig(last),
      cause: '最新一条角色回复断在半句（括号/引号没配对，或停在句子中间），但库里没有「没写完」标记',
      action: '只补一个 incomplete 标记，正文一字未改 → 用户看到「没写完 · 续写」提示条并可自助接着写；刷新/换设备后也分得清',
      now: '标记已落盘、正文一字未改；刷新/换设备后同样会给出「没写完 · 续写」入口',
      repair: { messages: patched },
      verify: (after) => after.messages?.[msgs.length - 1]?.incomplete === true,
      before: '无标记',
      after: 'incomplete=true',
    });
  }

  // ③ 消息缺时间戳（老数据/异常写入）→ 按保存路径同一规则补齐
  const missingTs = msgs.filter((m) => !(typeof m.timestamp === 'number' && Number.isFinite(m.timestamp))).length;
  if (missingTs > 0) {
    out.push({
      kind: 'MISSING_TIMESTAMP',
      sig: 'ts' + msgs.length + ':' + missingTs,
      cause: `${missingTs} 条消息没有有效时间戳（老数据 / 异常写入）→ 运营端的消息时间显示为空、排序不可靠`,
      action: '按「复用同位置旧时间戳，否则按消息顺序补当前时间」补齐（与保存路径同一条规则），正文一字未改',
      now: '时间戳已补齐（正文一字未改）',
      repair: { messages: msgs },
      verify: (after) => !!after.messages?.every((m) => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)),
      before: `${missingTs} 条缺时间戳`,
      after: '时间戳已补齐',
    });
  }

  // ④ 多版本候选与当前正文对不上（content ∉ versions / vi 越界 / 超 5 版上限）→ 用同一归一份重建
  const badVersions = msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.versions) && m.versions.length > 0
    && JSON.stringify(normalizeVersions(m)) !== JSON.stringify({
      ...(Array.isArray(m.versions) ? { versions: m.versions } : {}),
      ...(typeof m.vi === 'number' ? { vi: m.vi } : {}),
    })).length;
  if (badVersions > 0) {
    out.push({
      kind: 'VERSIONS_INCONSISTENT',
      sig: 'ver' + msgs.length + ':' + badVersions,
      cause: `${badVersions} 条回复的多版本候选与当前正文对不上（正文不在 versions 里 / 版本下标越界 / 超过 5 版上限）→ 界面上「◀ x/y ▶」点不出正在显示的那一版`,
      action: '用与保存路径同一份归一化规则重建 versions/vi，正文一字未改',
      now: '版本与正文已自洽（正文一字未改）',
      repair: { messages: msgs },
      verify: (after) => !!after.messages?.every((m) => !Array.isArray(m.versions) || JSON.stringify(normalizeVersions(m)) === JSON.stringify({
        ...(Array.isArray(m.versions) ? { versions: m.versions } : {}),
        ...(typeof m.vi === 'number' ? { vi: m.vi } : {}),
      })),
      before: `${badVersions} 条不自洽`,
    });
  }

  // ⑤ 历史里留着「失败兜底 / 系统提示」文案（2026-09-15 红线 6 事故残留）→ 内容删除类：默认只报告
  const fallbacks = msgs.filter((m) => m.role === 'assistant' && isFallbackBubble(m.content)).length;
  if (fallbacks > 0) {
    out.push({
      kind: 'FALLBACK_IN_HISTORY',
      sig: 'fb' + msgs.length + ':' + fallbacks,
      cause: `历史里留着 ${fallbacks} 条「失败兜底 / 系统提示」文案被当成角色台词（2026-09-15 事故残留）→ 它会被回灌给模型当上下文`,
      action: `删掉这 ${fallbacks} 条（只删整串精确匹配的系统文案，user 消息一律不动）—— 内容删除类默认只报告，需 SELF_HEAL_DELETE=1 才执行`,
      now: '默认不动数据；打开 SELF_HEAL_DELETE=1 后本引擎会自动清',
      repair: { messages: msgs.filter((m) => !(m.role === 'assistant' && isFallbackBubble(m.content))) },
      destructive: true,
      verify: (after) => !!after.messages?.every((m) => !(m.role === 'assistant' && isFallbackBubble(m.content))),
      before: `${fallbacks} 条系统文案`,
      after: '0 条',
    });
  }

  // ⑥ 会话缺剧名快照（自建剧本被删 / 早期数据）→ 只补元数据
  if (!String(rec.scenarioTitle || '').trim() && String(rec.scenarioId).startsWith('custom_')) {
    const sc = customRoleplayStore.findById(String(rec.scenarioId));
    if (sc?.title) {
      out.push({
        kind: 'TITLE_SNAPSHOT_MISSING',
        sig: 'title',
        cause: '这条会话没有剧名快照（早期数据或剧本已被创作者删除）→ 运营端与「与你的旅程」会显示成 `custom_xxx` 内部 id',
        action: '从自建剧本库回填剧名快照（只补元数据，正文一字未改）',
        now: '剧名快照已回填（只补元数据、正文一字未改）',
        repair: { scenarioTitle: String(sc.title) },
        verify: (after) => String(after.title || '').trim() === String(sc.title).trim(),
        before: '（无快照）',
        after: String(sc.title).slice(0, 40),
      });
    }
  }

  // 兜底：声明未使用（保留 base 便于后续检测器复用）
  void base;
  return out;
}

// ── 备份（改前先留一份原文，可回滚）────────────────────────────────────────────

function backupBeforeWrite(records: RoleplaySessionRecord[], at: number): string | null {
  try {
    const dir = path.join(process.cwd(), 'temp', 'self-heal-backup');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(at);
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const file = path.join(dir, `${stamp}-self-heal.json`);
    fs.writeFileSync(file, JSON.stringify(records, null, 1), 'utf-8');
    // 只留最近 MAX_BACKUPS 个（按文件名倒序）
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('-self-heal.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ }
    }
    return file;
  } catch (e) {
    console.warn('🩺 [SelfHeal] 备份失败，本轮不做任何写入:', (e as Error)?.message);
    return null;
  }
}

// ── 巡检主流程 ───────────────────────────────────────────────────────────────

/**
 * 跑一次巡检。`apply=false` 时只观察记录（dry）。
 *
 * 顺序要点：**先扫完、再决定写谁、最后统一备份一次** —— 这样一次巡检只落一个备份文件，
 * 且"备份失败"时直接放弃写入（宁可这次不修，也不做没有回滚点的修改）。
 */
export async function runSelfHealCycle(opts: { apply?: boolean; now?: number } = {}): Promise<HealRunSummary> {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const mode = selfHealMode();
  // ⚠️ `dry` 是**安全模式**：即使管理员点「立即巡检」也只观察记录、不写数据（mode=apply 才允许动手）。
  //    手动触发的语义是"现在就看一眼"，不是"绕过安全开关"。
  const apply = mode === 'apply' && (opts.apply ?? true);
  const run: HealRunSummary = {
    mode, applied: apply, at: now, durationMs: 0,
    scanned: 0, skippedTest: 0, detected: 0,
    fixed: 0, mitigated: 0, needsHuman: 0, observed: 0, pending: 0, failed: 0,
    records: [],
  };
  if (mode === 'off') { run.durationMs = Date.now() - t0; return run; }

  const sessions = roleplaySessionStore.listAll();
  const found: Array<{ rec: RoleplaySessionRecord; user?: string; f: HealFinding }> = [];
  for (const rec of sessions) {
    if (isTestDevice(rec.userId)) { run.skippedTest += 1; continue; }
    run.scanned += 1;
    let user: string | undefined;
    for (const f of scanSession(rec, now)) found.push({ rec, user, f });
  }
  run.detected = found.length;

  // 需要写盘的（非删除类，或已允许删除）→ 先备份涉及的会话原文
  const writable = found.filter(({ f }) => f.repair && (!f.destructive || deleteAllowed()));
  const guard = maxRepairs();
  let backup: string | null = null;
  if (apply && writable.length > 0) {
    const uniq = new Map<string, RoleplaySessionRecord>();
    for (const { rec } of writable) uniq.set(rec.userId + '::' + rec.scenarioId, rec);
    backup = backupBeforeWrite(Array.from(uniq.values()), now);
    if (!backup) { // 没有回滚点 → 本轮只报告
      for (const w of writable) w.f.destructive = true;
    }
  }
  if (backup) run.backup = backup;

  const seenIds = new Set<string>();
  let writes = 0;
  for (const { rec, f } of found) {
    const user = accountStore.getById(rec.userId)?.username;
    const id = shortHash(`${f.kind}|${rec.userId}|${rec.scenarioId}|${f.sig}`);
    let status: HealStatus;
    let verified: boolean | undefined;
    let nowText = f.now;
    const canWrite = !!f.repair && (!f.destructive || deleteAllowed()) && apply && writes < guard;
    if (!canWrite) {
      // 三种"没动手"要**分开记**，否则会出现「明明没修、却写着已缓解」的谎报（2026-09-18 首次上线抓到）：
      //   · 内容删除类 → needs_human（等人拍板）
      //   · 本轮额度用满 → pending（下一轮继续）
      //   · dry 模式 → observed（只有观察）
      // 只有"本来就不需要改数据的"（末句没人接）才是 mitigated。
      if (f.destructive && f.repair) { status = 'needs_human'; nowText = f.now; }
      else if (!apply) { status = 'observed'; nowText = '观察模式（SELF_HEAL=dry）：发现了但一行数据都没动'; }
      else if (f.repair) { status = 'pending'; nowText = `本轮修复额度已用满（SELF_HEAL_MAX_REPAIRS=${guard}），下一轮巡检会继续处理`; }
      else { status = 'mitigated'; }
      // 「不改数据」的那一类（末句没人接）也要**复查**：确认库里确实没被改动、回复也没丢
      if (!f.repair) {
        const cur = roleplaySessionStore.getRecord(rec.userId, rec.scenarioId);
        verified = f.verify ? f.verify({ messages: cur.messages, title: cur.scenarioTitle }) : true;
        if (!verified) { status = 'failed'; nowText = '⚠️ 复查没过（这条会话的形状与预期不符，需人工看一眼）'; }
      }
    } else {
      writes += 1;
      const wrote = roleplaySessionStore.heal(rec.userId, rec.scenarioId, f.repair!);
      const after = roleplaySessionStore.getRecord(rec.userId, rec.scenarioId);
      verified = f.verify ? f.verify({ messages: after.messages, title: after.scenarioTitle }) : true;      status = verified ? 'fixed' : 'failed';
      if (!verified) nowText = '修复后复查没过（已保留原文备份，下次巡检会重试）';
      else if (!wrote) nowText = f.now + '（同批另一次修复已一并覆盖）';
      else nowText = f.now;
    }
    const record: HealRecord = {
      id, kind: f.kind, status, at: now, lastAt: now, seen: 1,
      userId: rec.userId, ...(user ? { user } : {}),
      scenarioId: rec.scenarioId, ...(rec.scenarioTitle ? { title: rec.scenarioTitle } : {}),
      cause: f.cause, action: f.action, now: nowText,
      ...(f.before ? { before: f.before } : {}), ...(f.after ? { after: f.after } : {}),
      ...(verified !== undefined ? { verified } : {}),
    };
    selfHealStore.upsert(record);
    run.records.push(record);
    seenIds.add(id);
    if (status === 'fixed') run.fixed += 1;
    else if (status === 'mitigated') run.mitigated += 1;
    else if (status === 'needs_human') run.needsHuman += 1;
    else if (status === 'observed') run.observed += 1;
    else if (status === 'pending') run.pending += 1;
    else run.failed += 1;
  }

  run.durationMs = Date.now() - t0; // ⚠️ 必须在 finishRun 之前算好：它会把 lastRun 落盘，之后再赋值就晚了（卡片上永远是 0）
  // 没被本次看到的 needs_human 记录 → 条件已不存在，自动收口（避免卡片上永远挂着一条待办）
  selfHealStore.finishRun(run, seenIds);
  return run;
}
