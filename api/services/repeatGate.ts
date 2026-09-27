/**
 * 生成后重复闸（A 方案，2026-09-24 立）
 *
 * ## 为什么需要它（前三轮尝试都给不出的东西）
 * 2026-09-24 用真实数据把三条路都走完了：
 *   · **提示词**：反重复清单（`buildAntiRepeatBlock`）是唯一被 A/B 证明有效的形式，但它只覆盖
 *     最近 2–3 条（原句/长公共子串）与 12 条（模板），而且**只是告知**——实测同一句原句被点名后
 *     下一轮照样复用；
 *   · **采样参数**：temperature / top_p / frequency+presence penalty / top_k / repetition_penalty
 *     全部试过，唯一效应大到能看见的是 penalty 0.3→0.6；更糟的是实测**上游 seed 不可复现**
 *     （同配置同 seed 两次跑 18 对只有 1 对逐字相同），所以那台上游根本做不了严格配对实验；
 *   · **换模型**：Qwen3.5-27B 同门变体全部 503、大的 gated；能用的三个实测都不优于现役
 *     （GLM-4-32B 的「低重复」是长度假象，归一化后 20.1% vs 现役 21.2%）。
 *
 * 结论：**模型不可控、噪声大于效应 ⇒ 不该再指望"调到某个参数它就不复读"，而应在输出之后判、
 * 判到复读就换一版**。这就是本模块。它是确定性的：同一段正文进来，判据每次给同样的答案。
 *
 * ## 判据（阈值不是拍脑袋，是从全库 314 段会话 / 1291 个可比对轮次上量的）
 * 全库分位：最长逐字复用 p90=21 / p95=39 / p99=150 字；Jaccard p90=0.22。
 * 两个信号：
 *   1. **severe（整段复读）**：本次回复与最近任一条 AI 回复的最长公共子串 ≥ `MIN_SPAN`（默认 80 字，
 *      英文 160）—— 这是用户最直观的"复读"，全库 2.7% 的轮次命中；
 *   2. **circulating（片段循环）**：某个 ≥ `CIRC_SPAN`（默认 20 字）的片段在最近 `WINDOW`（默认 8）
 *      条 AI 回复里**至少 2 条**都出现过 —— 这一路专治"换词不换骨架/同一句形容词反复出现"。
 *      为什么必须有它：被投诉那位用户（230f0f97「与周即白的故事」）的逐字跨度**最大只有 45 字**，
 *      纯看 severe 判据根本抓不到他；而循环片段判据正好命中他出问题的那一轮（span=45, circ=2）。
 * 两路合并后全库触发率 **8.91%**（115/1291）—— 这个代价买的是"每一轮都能拦住 200–280 字整段照抄"。
 *
 * ## 有界重生成（绝不无限重试）
 * 命中后**最多重写 `MAX_ATTEMPTS`（默认 1）次**，并且把刚被复用的片段**点名**塞进"本轮禁止复现"
 * 段（`roleplay.ts` 的 `extraAvoid`）。重写结果**只有在确实更好时才采纳**：
 *   · 重复严重度必须下降（`repeatSeverity`）；
 *   · **字数不得明显缩水**（≥ 原版的 60%）—— 这条是被 GLM-4-32B 那次实验教出来的：
 *     "写得短"会让重复指标自动变好看，绝不能把"少写"当成"不复读"；
 *   · 重写失败/超时/为空 → **保留原文**，绝不把用户已经看到的内容弄丢。
 *
 * ## 红线
 * 不改用户可见的**已落盘**内容：闸门跑在服务端返回之前，用户始终只看到最终那一版；
 * 流式路径下第一版已经流出去了，所以路由会先下发 `{type:'rewrite'}` 让前端显示"正在重写"，
 * 随后 `done.reply`（权威文本）覆盖为最终版——前端本来就以 done.reply 定稿（见 `attemptTurn`）。
 *
 * ## 开关
 *   RP_REPEAT_GATE=0        整块关掉（消融/止血）
 *   RP_REPEAT_GATE_SCOPE    adult（默认，只在真的走了第三方去限制模型时生效）/ all
 *   RP_REPEAT_GATE_MAX      重写次数上限，默认 1，硬上限 2
 *   RP_REPEAT_MIN_SPAN / RP_REPEAT_CIRC_SPAN / RP_REPEAT_CIRC_COUNT / RP_REPEAT_WINDOW
 *   RP_REPEAT_MIN_CHARS     短于这个长度不判（避免短回复误伤），默认 80
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { longestCommonSpan } from '../../src/lib/repeatPhrases.js';

export type RepeatLang = 'zh' | 'zh-TW' | 'en';
export interface RepeatHistoryMessage { role: string; content: string }
export type RepeatReason = 'verbatim' | 'circulating';

export interface RepeatFinding {
  /** 是否判定为复读 */
  hit: boolean;
  reasons: RepeatReason[];
  /** 与最近任一条 AI 回复的最长逐字复用片段长度（字符） */
  longestSpan: number;
  /** 命中"片段循环"的条数：最近 WINDOW 条里有多少条含同一 ≥CIRC_SPAN 的片段 */
  circulating: number;
  /** 用于重写点名的片段（最长优先，去包含，最多 3 条） */
  spans: string[];
  /** 实际参与比对的前文条数 */
  compared: number;
}

const MAX_BAN_SPANS = 3;
const MAX_BAN_SPAN_CHARS = 60;

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const intOr = (v: string | undefined, dflt: number): number => Math.max(0, Math.floor(num(v, dflt)));

/** 整块开关（消融/止血用）；默认开 */
export function repeatGateEnabled(): boolean {
  return process.env.RP_REPEAT_GATE !== '0';
}
/**
 * 生效范围：默认 `adult`——只在**本轮真的路由到第三方去限制模型**时判。
 * 为什么默认窄：退化是那台 abliterated 模型的特性，官方 DeepSeek 链路不该为它多花一次调用与等待。
 */
export function repeatGateScope(): 'adult' | 'all' {
  return String(process.env.RP_REPEAT_GATE_SCOPE || 'adult').toLowerCase() === 'all' ? 'all' : 'adult';
}
/** 重写次数上限（默认 1，硬上限 2——防"越改越坏还一直改"） */
export function repeatGateMaxAttempts(): number {
  return Math.min(2, intOr(process.env.RP_REPEAT_GATE_MAX, 1));
}
const minSpan = (lang: RepeatLang): number => intOr(process.env.RP_REPEAT_MIN_SPAN, lang === 'en' ? 160 : 80);
const circSpan = (lang: RepeatLang): number => intOr(process.env.RP_REPEAT_CIRC_SPAN, lang === 'en' ? 40 : 20);
const circCount = (): number => Math.max(2, intOr(process.env.RP_REPEAT_CIRC_COUNT, 2));
const windowSize = (): number => Math.max(2, intOr(process.env.RP_REPEAT_WINDOW, 8));
const minChars = (): number => Math.max(0, intOr(process.env.RP_REPEAT_MIN_CHARS, 80));

/** 两个串是否共享一个长度 ≥ L 的公共片段（用 L-gram 集合判定，避免退化成 O(n·m) 长公共子串） */
function shareSpan(a: string, b: string, L: number): boolean {
  const A = a.replace(/\s+/g, '');
  const B = b.replace(/\s+/g, '');
  if (A.length < L || B.length < L) return false;
  const seen = new Set<string>();
  for (let i = 0; i + L <= A.length; i++) seen.add(A.slice(i, i + L));
  for (let i = 0; i + L <= B.length; i++) if (seen.has(B.slice(i, i + L))) return true;
  return false;
}

/** 去包含 + 限长，得到用于"点名禁止"的片段列表 */
function pickBanSpans(spans: string[]): string[] {
  const sorted = [...new Set(spans.filter((s) => s.trim().length > 0))].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const s of sorted) {
    if (kept.some((k) => k.includes(s))) continue;
    kept.push(s);
    if (kept.length >= MAX_BAN_SPANS) break;
  }
  return kept.map((s) => (s.length > MAX_BAN_SPAN_CHARS ? s.slice(0, MAX_BAN_SPAN_CHARS) : s));
}

/**
 * 判一次复读。**纯函数**（不读盘、不写盘、不调模型）——所有阈值来自 env，判据可单测、可回归。
 */
export function findRepeat(reply: string, history: RepeatHistoryMessage[], lang: RepeatLang = 'zh'): RepeatFinding {
  const text = String(reply || '').trim();
  const empty: RepeatFinding = { hit: false, reasons: [], longestSpan: 0, circulating: 0, spans: [], compared: 0 };
  if (text.replace(/\s+/g, '').length < minChars()) return empty;
  const prevs = (history || [])
    .filter((m) => m && m.role === 'assistant' && String(m.content || '').trim())
    .slice(-windowSize())
    .map((m) => String(m.content));
  // 少于 2 条前文时不判：只有一条前文时，"像"几乎是必然的（同一场景同一角色），会误伤
  if (prevs.length < 2) return { ...empty, compared: prevs.length };

  const SEV = minSpan(lang);
  const CIRC = circSpan(lang);
  const spans: string[] = [];
  let longestSpan = 0;
  let circulating = 0;
  for (const p of prevs) {
    const span = longestCommonSpan(p, text);
    if (span.length > longestSpan) longestSpan = span.length;
    if (span.length >= CIRC) spans.push(span);
    if (shareSpan(p, text, CIRC)) circulating += 1;
  }
  const reasons: RepeatReason[] = [];
  if (longestSpan >= SEV) reasons.push('verbatim');
  if (circulating >= circCount()) reasons.push('circulating');
  return {
    hit: reasons.length > 0,
    reasons,
    longestSpan,
    circulating,
    spans: reasons.length ? pickBanSpans(spans) : [],
    compared: prevs.length,
  };
}

/** 严重度：越小越好。severe 权重远高于 circulating（整段照抄比一句话反复更严重） */
export function repeatSeverity(f: RepeatFinding): number {
  return f.longestSpan + f.circulating * 15 + (f.reasons.includes('verbatim') ? 40 : 0);
}

/* ============================ 计数（可观测） ============================ */

export interface RepeatGateDay {
  /** 被闸门评估过的回合数（分母） */
  checked: number;
  /** 判为复读的回合数 */
  hit: number;
  /** 真的发起过重写的次数 */
  regenerated: number;
  /** 重写后被采纳 */
  accepted: number;
  /** 重写后仍不够好 → 保留原文 */
  keptOriginal: number;
  /** 重写调用失败/为空 → 保留原文 */
  failed: number;
  byReason: Record<string, number>;
}
interface Shape { days: Record<string, RepeatGateDay>; recent: { at: number; reasons: string[]; longestSpan: number; circulating: number; accepted: boolean }[] }

const GATE_FILE = dataFile('repeat-gate.json');
const KEEP_DAYS = 30;
const MAX_RECENT = 30;
const emptyDay = (): RepeatGateDay => ({ checked: 0, hit: 0, regenerated: 0, accepted: 0, keptOriginal: 0, failed: 0, byReason: {} });
const dayKey = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

class RepeatGateStore {
  private data: Shape = { days: {}, recent: [] };
  constructor() { this.load(); }
  private load(): void {
    const parsed = readJson<Shape>(GATE_FILE, { days: {}, recent: [] });
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      this.data = { days: parsed.days, recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
    }
  }
  private save(): void { try { writeJson(GATE_FILE, this.data); } catch { /* 埋点失败绝不影响主流程 */ } }
  record(finding: RepeatFinding, outcome: 'checked' | 'hit' | 'regenerated' | 'accepted' | 'kept' | 'failed'): void {
    const at = Date.now();
    const key = dayKey(at);
    const day = this.data.days[key] || emptyDay();
    day.checked += 1;
    if (outcome !== 'checked') day.hit += 1;
    if (outcome === 'regenerated' || outcome === 'accepted' || outcome === 'kept' || outcome === 'failed') day.regenerated += 1;
    if (outcome === 'accepted') day.accepted += 1;
    if (outcome === 'kept') day.keptOriginal += 1;
    if (outcome === 'failed') day.failed += 1;
    for (const r of finding.reasons) day.byReason[r] = (day.byReason[r] || 0) + 1;
    this.data.days[key] = day;
    if (outcome !== 'checked') {
      this.data.recent.unshift({ at, reasons: finding.reasons, longestSpan: finding.longestSpan, circulating: finding.circulating, accepted: outcome === 'accepted' });
      this.data.recent = this.data.recent.slice(0, MAX_RECENT);
    }
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > KEEP_DAYS) delete this.data.days[keys.shift()!];
    this.save();
  }
  summary(days = 7): { days: ({ date: string } & RepeatGateDay)[]; total: RepeatGateDay; recent: Shape['recent'] } {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 7));
    const out: ({ date: string } & RepeatGateDay)[] = [];
    const total = emptyDay();
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d.getTime());
      const day = this.data.days[key] || emptyDay();
      out.push({ date: key, ...day });
      total.checked += day.checked; total.hit += day.hit; total.regenerated += day.regenerated;
      total.accepted += day.accepted; total.keptOriginal += day.keptOriginal; total.failed += day.failed;
      for (const [k, v] of Object.entries(day.byReason)) total.byReason[k] = (total.byReason[k] || 0) + v;
    }
    return { days: out, total, recent: this.data.recent };
  }
}
export const repeatGateStore = new RepeatGateStore();

/* ============================ 有界重生成 ============================ */

export interface RepeatGateOutcome<T> {
  /** 最终应当返回给用户的那一版 */
  outcome: { reply: string; payload: T };
  /** 是否判为复读 */
  gated: boolean;
  /** 重写是否被采纳（false 且 gated=true 表示保留了原文） */
  accepted: boolean;
  finding: RepeatFinding;
  rewrite?: { finding: RepeatFinding; reply: string };
}

/**
 * 跑一次闸门：判 → （命中则）带点名重写一次 → 只在更好时采纳。
 * `regenerate` 由路由注入（它才知道怎么重建 prompt 与走流式），本函数只负责判据与采纳策略。
 */
export async function runRepeatGate<T>(args: {
  reply: string;
  history: RepeatHistoryMessage[];
  lang?: RepeatLang;
  /** 本轮是否真的走了第三方去限制模型（决定 adult 范围下闸门是否生效） */
  adult: boolean;
  /** 重写开始前的回调（路由用来下发 {type:'rewrite'}） */
  onRewrite?: () => void;
  regenerate: (banSpans: string[]) => Promise<{ reply: string; payload: T }>;
}): Promise<RepeatGateOutcome<T>> {
  const lang = args.lang || 'zh';
  const base = { outcome: { reply: args.reply, payload: undefined as unknown as T }, gated: false, accepted: false, finding: { hit: false, reasons: [], longestSpan: 0, circulating: 0, spans: [], compared: 0 } as RepeatFinding };
  if (!repeatGateEnabled()) return base;
  if (repeatGateScope() === 'adult' && !args.adult) return base;
  const maxAttempts = repeatGateMaxAttempts();
  const original = { reply: args.reply, payload: undefined as unknown as T };
  base.outcome = original;
  if (maxAttempts < 1) return base;

  const finding = findRepeat(args.reply, args.history, lang);
  if (!finding.hit) { repeatGateStore.record(finding, 'checked'); return { ...base, finding }; }

  args.onRewrite?.();
  let next: { reply: string; payload: T };
  try {
    next = await args.regenerate(finding.spans);
  } catch (e) {
    console.warn('⚠️ [RepeatGate] 重写调用失败，保留原文：' + ((e as Error)?.message || e));
    repeatGateStore.record(finding, 'failed');
    return { ...base, gated: true, finding };
  }
  const text = String(next?.reply || '').trim();
  if (!text) {
    console.warn('⚠️ [RepeatGate] 重写返回空，保留原文');
    repeatGateStore.record(finding, 'failed');
    return { ...base, gated: true, finding };
  }
  const rewriteFinding = findRepeat(text, args.history, lang);
  const oldLen = args.reply.replace(/\s+/g, '').length;
  const newLen = text.replace(/\s+/g, '').length;
  /**
   * 采纳条件（缺一不可）：
   *  1. 严重度确实下降（不是"换了个说法但一样重复"）；
   *  2. **字数没明显缩水**（≥ 原版 60%）—— GLM-4-32B 那次实验的教训：少写会让重复指标自动变好看；
   *  3. 新一版仍然是一段可用正文（≥ minChars）。
   */
  const better = repeatSeverity(rewriteFinding) < repeatSeverity(finding);
  const longEnough = newLen >= Math.max(minChars(), Math.floor(oldLen * 0.6));
  const accepted = better && longEnough;
  if (!accepted) {
    const why = !better ? '重复度没有下降' : '字数缩水过多（' + oldLen + ' → ' + newLen + '）';
    console.warn(
      '[RepeatGate] 命中复读（' + finding.reasons.join('/') + '，复用 ' + finding.longestSpan + ' 字 / 循环 ' + finding.circulating +
      ' 条）但重写未被采纳：' + why + ' → 保留原文',
    );
    repeatGateStore.record(finding, 'kept');
    return { ...base, gated: true, finding, rewrite: { finding: rewriteFinding, reply: text } };
  }
  console.log(
    '[RepeatGate] 命中复读（' + finding.reasons.join('/') + '，复用 ' + finding.longestSpan + ' 字 / 循环 ' + finding.circulating +
    ' 条）→ 重写已采纳：复用 ' + rewriteFinding.longestSpan + ' 字 / 循环 ' + rewriteFinding.circulating + ' 条，' +
    oldLen + ' → ' + newLen + ' 字（禁项 ' + finding.spans.length + ' 条）',
  );
  repeatGateStore.record(finding, 'accepted');
  return { outcome: { reply: text, payload: next.payload }, gated: true, accepted: true, finding, rewrite: { finding: rewriteFinding, reply: text } };
}
