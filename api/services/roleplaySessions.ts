/**
 * 角色剧情会话持久化（跨设备）
 * 登录用户 → 账号 userId（换设备也能接着上一段剧情）；游客 → 设备指纹 userId（仅本机）
 * 数据持久化到 data/roleplay-sessions.json，进程重启不丢失
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { isFallbackBubble } from '../../src/lib/fallbackBubbles.js';
import { dropsSavedReply } from '../../src/lib/rpWriteGuard.js';
import { normalizeUserBranches } from '../../src/lib/rpVersions.js';

/**
 * 兼容旧调用点与单测：判据本体已抽到 `src/lib/rpWriteGuard.ts`（**前端自动保存复用同一份**，
 * 见该文件顶部 2026-09-18 第二版说明：前端不该把「重新生成」的中间截断态推上来）。
 */
export { dropsSavedReply };

export interface RoleplayMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  /** AI 回复的多版本候选（重新生成产生；`versions[vi] === content`），仅 assistant 且重生成过才有 */
  versions?: string[];
  /** 当前显示的版本下标（对应 versions） */
  vi?: number;
  /**
   * **用户消息**被“编辑重发”改写后的多版本分支（2026-09 新增；方案 1B + 2A）。
   *
   * `versions`/`vi` 与 assistant 同一套语义（`versions[vi] === content`，见 `src/lib/rpVersions.ts`）；
   * `tails[vi]` 是**该版本对应的后续对话**（被改写掉的那一支，冻结保存，用户可 ◀/▶ 切回）；
   * `tails[vi]` 为 null/缺省 =「这一版的后续就活在主线里」（只可能是当前选中的那一版）。
   *
   * ⚠️ 尾巴里的消息**不参与模型上下文**（`toRequestMessages()` 只带 role/content），
   * 它只是给用户留的「回看/切回」入口，别在任何地方把 tails 当成正式历史读。
   */
  tails?: (RoleplayMessage[] | null)[];
  /**
   * 这条 **assistant 回复**是不是由「无限制模式（成人模型）」生成的。仅 assistant 有。
   *
   * 怎么来的：生成路径在 SSE 里下发 `{type:'meta', model, adult}`，前端保存会话时随消息回传（方案 A2）。
   * 性质：**客户端自述**，管理端监控够用，但**不适合当法律取证**。
   * 未记录（老数据 / 走 DeepSeek）= `undefined`；不要用 `false` 冒充「确定没用过」。
   */
  viaUnlimited?: boolean;
  /** 生成这条回复用的模型名（同上，客户端自述）。仅 assistant 有 */
  model?: string;
  /**
   * 生成这条回复时用户选的**叙事模式**（classic 经典 / immersive 沉浸）。仅 assistant 有。
   *
   * 为什么必须存：叙事模式一直只存在浏览器 `localStorage`（`rp_narrative_style`），
   * 服务端与落盘数据里**完全没有**这个维度，于是「经典档与沉浸档的收尾习惯是不是不一样」
   * 这类问题在真实数据上根本没法回答（2026-09-18 用户口径「要考虑用户使用的叙事模式」）。
   * 补上之后，只读扫描脚本（`scripts/rp-ending-scan.mts`）就能按模式分档统计。
   *
   * 口径同 `viaUnlimited`：**客户端自述**、只为度量与审计，缺省 = 老数据未记录
   * （老数据一律空着，**不要**用默认真值 `immersive` 回填，那会把「不知道」伪造成「快照值」）。
   */
  style?: 'classic' | 'immersive';
  /**
   * 这条 assistant 回复**没写完**（内容中断）。仅 assistant 有。
   *
   * 怎么来的：服务端在 SSE `done` 里下发 `incomplete`（判据见 `src/lib/replyCompleteness.ts`：
   * finish_reason=length / 括号引号未配对 / 停在半句中间），前端随消息回传保存。
   * 为什么要存：2026-09-18 诊断发现「半截台词」被当成完整回复永久留在历史里，
   * 刷新后用户既看不到提示、也没有续写入口。存下这个标记，历史里就分得清"写完了"和"被截断了"。
   * 缺省 undefined = 老数据 / 该路径未带上，**不要当作 false**（与 viaUnlimited 同口径）。
   */
  incomplete?: boolean;
}
/**
 * 剧情「模式」（2026-10-01 双模式）：定义与判据在 `src/lib/roleplayMode.ts`（前端/服务端共用一份）。
 *   solo  = 单角色线（只有主角 AI，原有行为）
 *   multi = 多角色线（cast 同场，逐角色气泡）
 *
 * 一部剧本对**每个用户最多两条记录**（solo + multi），消息/偏好/重新开始互相独立
 * 这就是「每部剧本最多一个多角色 + 一个单角色存档」。
 */
import { type RoleplayMode, DEFAULT_ROLEPLAY_MODE } from '../../src/lib/roleplayMode.js';
export type { RoleplayMode };
export { DEFAULT_ROLEPLAY_MODE };

export interface RoleplaySessionRecord {
  userId: string;
  scenarioId: string;
  /**
   * 这条记录属于哪条线。**可选**：老数据没有这个字段 ⇒ 一律当 `solo`（不批量重写，
   * 读取时惰性改键，见 loadFromDisk 与 keyOf 的注释）。
   */
  mode?: RoleplayMode;
  messages: RoleplayMessage[];
  /** 用户在本剧本里的独特偏好/需求（自由文本），持久随剧情保存，AI 后续始终参考 */
  userPreference?: string;
  /**
   * 保存那一刻解析到的**剧名快照**（自建剧本尤其重要）。
   *
   * 为什么存：自建剧本可以被创作者删除，剧本没了标题也就解析不到了
   * 「与你的旅程 / 运营控制台」就会退化成 `custom_xxx` 内部 id 或「自定义剧情」占位。
   * 有了快照，玩家当初看到并记下的那个剧名一直留在这条会话上（读取时仍优先取实时标题，
   * 快照只在解析不到时兜底，所以创作者改名不会让历史显示旧名）。
   */
  scenarioTitle?: string;
  updatedAt: number;
}

const FILE = dataFile('roleplay-sessions.json');

/** 单个剧本最多保存的消息条数（防止无限膨胀） */
const MAX_MSGS = 200;
const MAX_CONTENT = 4000;
/**
 * 单条 AI 回复最多保留的版本数（= 重新生成次数上限 + 1）。
 * 为什么要有上限：每个版本都是一整段台词（最长 4000 字符），无上限会让 `roleplay-sessions.json`
 * 随「无限重抽一条回复」线性膨胀。超出时**丢最旧的版本、保留当前版**（当前版永远可见）。
 */
const MAX_VERSIONS = 5;

/**
 * 会话主键：`userId::scenarioId::mode`。
 *
 * ⚠️ 2026-10-01 之前是 `userId::scenarioId`（每剧本一份）。加 mode 后同一剧本最多两条记录；
 * **老数据不批量重写**，loadFromDisk 读到没有 `mode` 的记录时按 `solo` 重新键入内存，
 * 下一次 saveToDisk() 自然写成新格式。这样迁移是幂等的，也不需要停机改文件。
 */
const keyOf = (userId: string, scenarioId: string, mode: RoleplayMode = DEFAULT_ROLEPLAY_MODE) =>
  userId + '::' + scenarioId + '::' + mode;

/**
 * 一条消息落盘时的**字段投影**（save() 与 heal() 共用）。
 *
 * 🚨 这是**重建**消息对象（只挑字段），任何新字段都必须在此显式搬过去，否则会被静默丢掉。
 * 2026-09-16 出过同类事故（字符串被提前截断 → 三节提示词无声消失且 tsc 无报错），所以这里刻意显式写；
 * 2026-09-18 抽成函数，是为了让「自愈写回」和「客户端保存」用同一套投影，避免两边字段集漂移。
 */
function projectMessage(m: RoleplayMessage, ts: number): RoleplayMessage {
  const out: RoleplayMessage = { role: m.role, content: m.content.slice(0, MAX_CONTENT), timestamp: ts };
  // 成人模式审计标记（方案 A2）：只认 assistant，且只采信 boolean，传 'true' / 1 之类一律忽略。
  if (m.role === 'assistant') {
    if (typeof m.viaUnlimited === 'boolean') out.viaUnlimited = m.viaUnlimited;
    if (typeof m.model === 'string' && m.model) out.model = m.model.slice(0, 80);
    // 叙事模式（2026-09-18）：只认这两个取值，传别的（含旧客户端没传）一律不落字段，
    // 宁可空着（=不知道），也不要写一个猜出来的模式进去污染分档统计。
    if (m.style === 'classic' || m.style === 'immersive') out.style = m.style;
    // 「这条没写完」的标记（B 方案）：只认 boolean，缺省不带该字段 = 老数据/未知
    if (typeof m.incomplete === 'boolean') out.incomplete = m.incomplete;
  }
  // 「重新生成」的多版本候选：只在 assistant 且真的有多版时才落盘
  if (m.role === 'assistant') Object.assign(out, normalizeVersions(m));
  /**
   * 用户消息的「编辑重发」分支（2026-09）：与 assistant 版本同一套归一化口径
   *（只认字符串版本、裁剪到上限、`content` 必须等于 `versions[vi]`），
   * 尾巴剪成 role/content 并限量，服务端**必须**在这里显式搬过去，
   * 否则前端编辑过的分支会被静默丢掉（本文件顶部那条「新字段必须显式搬」的告警）。
   */
  if (m.role === 'user') Object.assign(out, normalizeUserBranches(m, MAX_CONTENT));
  return out;
}

/** save() 的结果：调用方（路由）据此把「未完成回合」记进运营埋点 */
export interface RoleplaySaveResult {
  saved: boolean;
  /** 被护栏拒写的原因码；undefined = 正常落盘 */
  blocked?: 'UNANSWERED_TURN';
}

/**
 * 归一化一条消息的版本信息（落盘前的服务端兜底，防止前端/历史数据把不合法结构写进库）：
 *  - 只保留字符串版本、各自截断到 MAX_CONTENT、最多保留最近 MAX_VERSIONS 个；
 *  - **`content` 必须等于 `versions[vi]`**：找不到就按 content 重建（数据自洽优先于保留脏版本）；
 *  - 版本数 < 2（或本就没重生成过）→ 不落这两个字段（老数据格式保持原样，前端按「无版本」处理）。
 *
 * ⚠️ 2026-09-18 起 export：`api/services/selfHeal.ts` 的自愈检测器要用**同一份**规则判断
 * 「这条消息的 versions/vi 是不是不自洽」，不能各写一套判据（否则修完复查会互相打架）。
 */
export function normalizeVersions(m: RoleplayMessage): Pick<RoleplayMessage, 'versions' | 'vi'> {
  const raw = Array.isArray(m.versions) ? m.versions.filter((v): v is string => typeof v === 'string') : [];
  if (raw.length < 2) return {};
  let vers = raw.map(v => v.slice(0, MAX_CONTENT));
  const content = m.content.slice(0, MAX_CONTENT);
  let vi = typeof m.vi === 'number' && Number.isFinite(m.vi) ? Math.floor(m.vi) : vers.length - 1;
  if (vi < 0 || vi >= vers.length) vi = vers.length - 1;
  if (vers[vi] !== content) {
    const found = vers.indexOf(content);
    if (found >= 0) vi = found;
    else { vers = [...vers, content]; vi = vers.length - 1; }
  }
  if (vers.length > MAX_VERSIONS) {
    // ⚠️ 裁剪必须**先保证当前版不被裁掉**：直接 `slice(-5)` 会把「用户正看着的那一版」丢掉，
    //    落盘后 content 与 versions[vi] 就对不上了（界面上会出现「◀ 1/5 ▶ 却点不出正在显示的那条」）。
    //    规则：保留「当前版 + 最近 MAX_VERSIONS-1 个版本」，下标按时间顺序重排。
    const activeIdx = vi;
    const keepIdx = new Set<number>([activeIdx]);
    for (let i = vers.length - 1; i >= 0 && keepIdx.size < MAX_VERSIONS; i--) keepIdx.add(i);
    const ordered = Array.from(keepIdx).sort((a, b) => a - b);
    vers = ordered.map(i => vers[i]);
    vi = ordered.indexOf(activeIdx);
  }
  if (vers.length < 2) return {};
  return { versions: vers, vi };
}

class RoleplaySessionStore {
  private items: Map<string, RoleplaySessionRecord> = new Map();
  /** 进程内单调递增的 updatedAt，避免同毫秒保存导致合并「谁更新谁保留」判定不稳定 */
  private lastUpdatedAt = 0;

  constructor() { this.loadFromDisk(); }

  /** 生成单调递增的 updatedAt：>= 现有记录、且严格大于本进程之前任何一次保存 */
  private nextUpdatedAt(existingUpdatedAt?: number): number {
    const n = Math.max(Date.now(), this.lastUpdatedAt + 1, (existingUpdatedAt || 0) + 1);
    this.lastUpdatedAt = n;
    return n;
  }

  private loadFromDisk(): void {
    const parsed = readJson<RoleplaySessionRecord[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((r: RoleplaySessionRecord) => {
        if (r?.userId && r?.scenarioId && Array.isArray(r.messages)) {
          // 老记录没有 mode ⇒ 按 solo 归档（并在内存里就换成新键，下次落盘即完成迁移）
          const mode: RoleplayMode = r.mode === 'multi' ? 'multi' : 'solo';
          this.items.set(keyOf(r.userId, r.scenarioId, mode), { ...r, mode });
        }
      });
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  /**
   * 取某个剧本的会话记录。
   *   · 传了 mode → **精确**取那一档（单角色 / 多角色各一份存档）；
   *   · 不传 → 取两档里 `updatedAt` **更晚**的那份，老调用方（与你的旅程 / 跨模式桥 / 自愈）
   *     关心的都是「用户最近在演哪条线」，给最近的那份才符合直觉。
   */
  private pickRecord(userId: string, scenarioId: string, mode?: RoleplayMode): RoleplaySessionRecord | undefined {
    if (mode) return this.items.get(keyOf(userId, scenarioId, mode));
    const a = this.items.get(keyOf(userId, scenarioId, 'solo'));
    const b = this.items.get(keyOf(userId, scenarioId, 'multi'));
    if (a && b) return a.updatedAt >= b.updatedAt ? a : b;
    return a || b;
  }

  get(userId: string, scenarioId: string, mode?: RoleplayMode): RoleplayMessage[] | null {
    const r = this.pickRecord(userId, scenarioId, mode);
    if (!r || !Array.isArray(r.messages) || r.messages.length === 0) return null;
    return r.messages;
  }

  /**
   * 取完整会话记录（消息 + 用户偏好 + 剧名快照），供前端一次性读取。
   * ⚠️ `scenarioTitle` 是 2026-09-18 为「🩺 自愈引擎」的**复查**加的（修复回填快照后要能读出来验证）；
   * 老调用方只读 messages/userPreference，多这一个字段不影响兼容。
   */
  getRecord(userId: string, scenarioId: string, mode?: RoleplayMode): { messages: RoleplayMessage[] | null; userPreference?: string; scenarioTitle?: string; mode: RoleplayMode } {
    const r = this.pickRecord(userId, scenarioId, mode);
    return {
      messages: r && Array.isArray(r.messages) && r.messages.length > 0 ? r.messages : null,
      userPreference: r?.userPreference || '',
      // 回传「这份档是哪条线」：调用方（路由/跨模式桥）据此知道读到的是单角色还是多角色线
      mode: r?.mode === 'multi' ? 'multi' : 'solo',
      ...(r?.scenarioTitle ? { scenarioTitle: r.scenarioTitle } : {}),
    };
  }

  /** 用户在本剧本的独特偏好/需求文本（无则空串）。偏好与档案同档：两条线各存各的 */
  getPreference(userId: string, scenarioId: string, mode?: RoleplayMode): string {
    return this.pickRecord(userId, scenarioId, mode)?.userPreference || '';
  }

  /**
   * 保存某条线的整份历史。
   * ⚠️ `mode` 是**第 6 个位置参数**（追加在末尾）：老调用方不传 ⇒ 默认 solo，行为与加 mode 之前一致。
   */
  save(userId: string, scenarioId: string, messages: RoleplayMessage[], userPreference?: string, scenarioTitle?: string, mode: RoleplayMode = DEFAULT_ROLEPLAY_MODE): RoleplaySaveResult {
    const all = (messages || [])
      .filter((m: RoleplayMessage) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      // 🚨 服务端最后一道护栏（2026-09-15 线上事故）：前端「失败兜底 / 系统提示」文案曾被当成角色台词落盘，
      // 于是它既显示成「角色说的话」，又回灌给模型当上下文，还永久留在历史里（生产库当时已留 3 处）。
      // 前端已不再产生这种消息；这里再挡一层，任何客户端（含未更新的旧版本）写进来都会被丢弃。
      // 判定只针对 assistant、只做整串精确匹配；user 的消息一律不动。
      .filter((m: RoleplayMessage) => !(m.role === 'assistant' && isFallbackBubble(m.content)));
    if (all.length === 0) return { saved: false };
    const existing = this.items.get(keyOf(userId, scenarioId, mode));
    // 保留已有时间戳（每次重存历史不覆盖）；缺失时间戳的补发：复用上次同位置时间戳，
    // 否则按消息位置顺序用当前时间（新增消息在原有消息之后，时间自然更晚）。
    const prevTs = (existing?.messages || []).slice(-MAX_MSGS).map((m) => m.timestamp);
    const baseNow = Date.now();
    const withTs = all.map((m: RoleplayMessage, i: number) => {
      const ts = typeof m.timestamp === 'number'
        ? m.timestamp
        : (prevTs[i] ?? (baseNow + i));
      return projectMessage(m, ts);
    });
    const clean = withTs.slice(-MAX_MSGS);
    if (clean.length === 0) return { saved: false };
    // 🚨 未完成回合护栏（2026-09-18 事故）：别让一次「截断态」写入把已经生成的回复静默抹掉。
    // 命中就**保留库里已有的回复**、这次不写（下一次带上新回复的保存会正常覆盖，见 dropsSavedReply 注释）。
    if (dropsSavedReply(existing?.messages, clean)) {
      console.warn(
        `[RoleplaySession] 拒写未完成回合：新写入 ${clean.length} 条、以用户消息结尾，` +
        `而库里这条消息之后还有回复（现 ${existing!.messages.length} 条）→ 保留已有回复，不截断`,
      );
      return { saved: false, blocked: 'UNANSWERED_TURN' };
    }
    const pref = userPreference !== undefined ? userPreference : (existing?.userPreference || '');
    // 标题快照：本次解析到就更新，解析不到（剧本已在别处被删）就沿用上次的快照，别把真名抹掉。
    const snap = (scenarioTitle || '').trim() || existing?.scenarioTitle;
    this.items.set(keyOf(userId, scenarioId, mode), {
      userId,
      scenarioId,
      mode,
      messages: clean,
      userPreference: pref,
      ...(snap ? { scenarioTitle: snap.slice(0, 200) } : {}),
      updatedAt: this.nextUpdatedAt(existing?.updatedAt),
    });
    this.saveToDisk();
    return { saved: true };
  }

  /**
   * 🩺 **自愈专用写回**（服务端可信写，2026-09-18 新增；调用方 `api/services/selfHeal.ts`）。
   *
   * 与 `save()` 有**三处刻意不同**（写清楚，别被后人「顺手统一」掉）：
   *   1. **不过 `dropsSavedReply` 护栏**：那道护栏拦的是「客户端推上来的截断态」；自愈是服务端**主动修数据**，
   *      修完由调用方**复查**（复查不通过会记成 failed），不是"信任客户端"。
   *   2. **不过失败兜底文案过滤器**：`save()` 会把 `isFallbackBubble` 的 assistant 消息直接丢掉，那样
   *      自愈就**先看不见**了；这里原样保留，由检测器**显式决定**（删除类默认只报告、不动手，见 selfHeal）。
   *   3. **只改 patch 点名的字段**（messages / scenarioTitle），其余原样沿用；`updatedAt` 照旧单调递增。
   *
   * 安全边界（写死在这里，不靠调用方自觉）：
   *   - 记录不存在 → 不写（false）；
   *   - patch.messages 为空 → 不写（**绝不清空历史**）；
   *   - 投影后与现状**完全一致** → 不写（幂等：自愈重复跑不会反复刷盘/刷记录）。
   *
   * @returns 是否真的落盘
   */
  heal(userId: string, scenarioId: string, patch: { messages?: RoleplayMessage[]; scenarioTitle?: string }, mode?: RoleplayMode): boolean {
    const existing = this.pickRecord(userId, scenarioId, mode);
    const key = existing ? keyOf(userId, scenarioId, existing.mode) : keyOf(userId, scenarioId, mode);
    if (!existing) return false;
    let messages = existing.messages || [];
    if (patch.messages) {
      const prevTs = (existing.messages || []).map((m) => m.timestamp);
      const baseNow = Date.now();
      const projected = patch.messages
        .filter((m: RoleplayMessage) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m: RoleplayMessage, i: number) => projectMessage(m, typeof m.timestamp === 'number' ? m.timestamp : (prevTs[i] ?? (baseNow + i))));
      if (projected.length === 0) return false;
      messages = projected.slice(-MAX_MSGS);
    }
    const title = ((patch.scenarioTitle !== undefined ? patch.scenarioTitle : existing.scenarioTitle) || '').trim();
    const unchangedMessages = JSON.stringify(messages) === JSON.stringify(existing.messages || []);
    const unchangedTitle = title === ((existing.scenarioTitle || '').trim());
    if (unchangedMessages && unchangedTitle) return false;
    this.items.set(key, {
      userId,
      scenarioId,
      messages,
      userPreference: existing.userPreference || '',
      ...(title ? { scenarioTitle: title.slice(0, 200) } : {}),
      updatedAt: this.nextUpdatedAt(existing.updatedAt),
    });
    this.saveToDisk();
    return true;
  }

  /** 仅保存用户偏好（独立于消息更新，避免覆盖） */
  savePreference(userId: string, scenarioId: string, userPreference: string, mode: RoleplayMode = DEFAULT_ROLEPLAY_MODE): void {
    const existing = this.items.get(keyOf(userId, scenarioId, mode));
    const record: RoleplaySessionRecord = {
      userId,
      scenarioId,
      mode,
      messages: existing?.messages || [],
      userPreference: userPreference || '',
      // 🚨 逐字段重建：新字段不显式搬过来就会被静默丢掉（本文件 save() 同理）
      ...(existing?.scenarioTitle ? { scenarioTitle: existing.scenarioTitle } : {}),
      updatedAt: this.nextUpdatedAt(existing?.updatedAt),
    };
    this.items.set(keyOf(userId, scenarioId, mode), record);
    this.saveToDisk();
  }

  /**
   * 删除某条线的存档。
   * ⚠️ 不传 mode 时**只删 solo**（老客户端「重新开始」的语义 = 单一存档；不能顺手把多角色线也清掉）。
   */
  delete(userId: string, scenarioId: string, mode: RoleplayMode = DEFAULT_ROLEPLAY_MODE): void {
    if (this.items.delete(keyOf(userId, scenarioId, mode))) this.saveToDisk();
  }

  /** 该用户玩过的剧情（按场景去重，含最后游玩时间与剧名快照；供「与你的旅程」剧情足迹） */
  listByUser(userId: string): { scenarioId: string; updatedAt: number; scenarioTitle?: string; mode: RoleplayMode }[] {
    /**
     * 双模式之后同一剧本最多两条记录，而本方法的契约是「**按场景去重**的足迹」
     * 所以这里显式保留**每条线里 updatedAt 更晚**的那份，并带上 mode 供调用方标注
     *（否则「与你的旅程」里同一部剧会出现两次）。
     */
    const best = new Map<string, { scenarioId: string; updatedAt: number; scenarioTitle?: string; mode: RoleplayMode }>();
    for (const r of this.items.values()) {
      if (r.userId !== userId) continue;
      const mode: RoleplayMode = r.mode === 'multi' ? 'multi' : 'solo';
      const prev = best.get(r.scenarioId);
      if (!prev || r.updatedAt >= prev.updatedAt) {
        best.set(r.scenarioId, { scenarioId: r.scenarioId, updatedAt: r.updatedAt, scenarioTitle: r.scenarioTitle, mode });
      }
    }
    return Array.from(best.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /** 全部剧情会话（运营端用户行为分析用） */
  listAll(): RoleplaySessionRecord[] {
    return Array.from(this.items.values());
  }

  deleteByUser(userId: string): void {
    let changed = false;
    for (const k of Array.from(this.items.keys())) {
      if (k.startsWith(userId + '::')) { this.items.delete(k); changed = true; }
    }
    if (changed) this.saveToDisk();
  }

  /** 游客剧情会话并入账号（按剧本 key 转移，账号已有同剧本则保留更新更晚的） */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    let changed = false;
    for (const [k, r] of Array.from(this.items.entries())) {
      if (r.userId === oldId) {
        const nk = keyOf(newId, r.scenarioId, r.mode === 'multi' ? 'multi' : 'solo');
        const existing = this.items.get(nk);
        if (!existing || r.updatedAt >= existing.updatedAt) {
          this.items.set(nk, { ...r, userId: newId });
        }
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }
}

export const roleplaySessionStore = new RoleplaySessionStore();
export default roleplaySessionStore;
