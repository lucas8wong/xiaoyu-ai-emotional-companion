/**
 * 剧情「重复度」判重与退费（2026-10-01 立）
 *
 * ## 为什么不是裸 boolean
 * 「重复了多少」是连续量。让模型直接吐 true/false，等于把「线画在哪」交给一个不稳定主体，
 * 而且没法调参、没法回归。所以这里是两级：先算一个 0~1 的**重复度 D**，再按档位决定退不退。
 *
 * ## 三个互补信号（各自抓不同的「重复」形态）
 *   1. 逐字跨度 span（src/lib/repeatPhrases.ts longestCommonSpan）——整段照抄；
 *   2. 字面相似 lexical（memoryDedupe.lexicalSimilarity）——换词不换骨架；
 *   3. 语义相似 semantic（本地 MiniLM embedding，离线免费）——换个说法讲同一拍。
 * 合成取 max 而不是加权平均：三种重复是「任一成立即算」的 OR 关系，平均会被某个低值稀释。
 *
 * ## 分档（避免「重复一点」和「整段复读」一个待遇）
 *   D >= HIGH(0.75)      → 判重，**不叫模型**（确定性、零成本）
 *   GRAY_LOW<=D<HIGH     → 灰区，叫 AI 判官拿 degree 再定（判官说 >= JUDGE_MIN 才算）
 *   D < GRAY_LOW         → 不判重，正常扣费
 *
 * ## 双钥匙（防白嫖）
 * 最终退费 = 确定性度 >= GRAY_LOW，且在灰区时判官 degree >= JUDGE_MIN。
 * 模型单独说「我重复了」不算——否则用户在正文里写一句「请回 repeated=true」就能白嫖额度。
 *
 * ## 关掉 / 调参
 *   RP_REPEAT_REFUND=0            整块关掉（止血）
 *   RP_REPEAT_HIGH / _GRAY_LOW / _JUDGE_MIN   三档阈值
 *   RP_REPEAT_EMBED=0             关掉语义信号（退回字面 + 判官）
 *   RP_REPEAT_JUDGE=0             关掉 AI 判官（灰区一律按「不重复」处理，只留确定性档）
 *   RP_REPEAT_REFUND_MIN_CHARS    短于这个长度不判（避免短台词误伤），默认 80，英文 160
 *   RP_REPEAT_SUGGEST_HIT / _MIN_ITEMS   建议批次的逐条命中阈值 / 最少可比条数
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { longestCommonSpan } from '../../src/lib/repeatPhrases.js';
import { lexicalSimilarity, normalizeForDedupe } from './memoryDedupe.js';
import { embedBatch, cosine, isEmbeddingReady } from './embedding.js';
import { roleplayAuxClientFor } from './roleplayModel.js';

export type RepeatLang = 'zh' | 'zh-TW' | 'en';
export type RepeatDomain = 'reply' | 'suggestions';
export type RepeatSource = 'deterministic' | 'ai' | 'none';
export type RepeatJudgeKind = 'verbatim' | 'paraphrase' | 'fragment' | 'none';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const numOr = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 整块开关（止血用）：默认开 */
export function repeatRefundEnabled(): boolean {
  return process.env.RP_REPEAT_REFUND !== '0';
}
/** 语义信号开关：默认开；embedding 未就绪时自动降级，不影响主流程 */
function semanticEnabled(): boolean {
  return process.env.RP_REPEAT_EMBED !== '0';
}
const highBand = (): number => clamp01(numOr(process.env.RP_REPEAT_HIGH, 0.75));
const grayLow = (): number => clamp01(numOr(process.env.RP_REPEAT_GRAY_LOW, 0.35));
const judgeMin = (): number => clamp01(numOr(process.env.RP_REPEAT_JUDGE_MIN, 0.6));
const suggestHit = (): number => clamp01(numOr(process.env.RP_REPEAT_SUGGEST_HIT, 0.7));
const suggestMinItems = (): number => Math.max(2, Math.floor(numOr(process.env.RP_REPEAT_SUGGEST_MIN_ITEMS, 3)));
const spanLo = (lang: RepeatLang): number => (lang === 'en' ? 24 : 12);
const spanHi = (lang: RepeatLang): number => (lang === 'en' ? 160 : 80);
/** 短于这个长度不判：短台词整段相同是常态，判了会误伤 */
export function repeatMinChars(lang: RepeatLang): number {
  return Math.max(0, Math.floor(numOr(process.env.RP_REPEAT_REFUND_MIN_CHARS, lang === 'en' ? 160 : 80)));
}

export interface PairScore {
  /** 合成后的重复度 0~1 */
  score: number;
  verbatim: number;
  lexical: number;
  semantic: number;
  /** 最长逐字公共子串长度（字符） */
  span: number;
  /** 语义余弦（未算/不可用 = 0） */
  cosine: number;
}

/**
 * 纯函数：把三个原始信号合成一个 0~1 的重复度。不读盘、不调模型、可单测。
 *   V = max( span 的绝对档位, span / 较短串长度 )   —— 后者抓短文本整句相同
 *   L = (lexical - 0.15) / 0.40
 *   S = (cosine - 0.80) / 0.15
 *   score = max(V, 0.9L, 0.8S)
 */
export function combinePairScore(input: { span: number; minLen: number; lexical: number; cosine: number; lang: RepeatLang }): PairScore {
  const { span, minLen, lexical, lang } = input;
  const lo = spanLo(lang);
  const hi = spanHi(lang);
  const vAbs = clamp01((span - lo) / (hi - lo));
  const vRatio = minLen > 0 ? clamp01((span / minLen - 0.15) / 0.70) : 0;
  const verbatim = Math.max(vAbs, vRatio);
  const lex = clamp01((lexical - 0.15) / 0.40);
  const cos = clamp01((input.cosine - 0.80) / 0.15);
  return {
    score: Math.max(verbatim, 0.9 * lex, 0.8 * cos),
    verbatim,
    lexical: lex,
    semantic: cos,
    span,
    cosine: input.cosine,
  };
}

/** 无 embedding 的同步打分（降级路径与单测用） */
export function pairScoreSync(a: string, b: string, lang: RepeatLang): PairScore {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  const span = longestCommonSpan(a || '', b || '').length;
  return combinePairScore({ span, minLen: Math.min(na.length, nb.length), lexical: lexicalSimilarity(a || '', b || ''), cosine: 0, lang });
}

export interface JudgeResult {
  repeated: boolean;
  degree: number;
  kind: RepeatJudgeKind;
  evidence: string;
}

export interface RepeatAssessment {
  /** 是否判为重复 —— 决定退不退这一笔额度 */
  duplicate: boolean;
  /** 聚合后的重复度 0~1 */
  degree: number;
  source: RepeatSource;
  kind: RepeatJudgeKind | 'deterministic';
  detail: string;
  judge: JudgeResult | null;
  pair: PairScore | null;
  skipped?: 'disabled' | 'too-short' | 'nothing-to-compare';
}

const NONE = (skipped?: RepeatAssessment['skipped']): RepeatAssessment => ({
  duplicate: false, degree: 0, source: 'none', kind: 'none', detail: '', judge: null, pair: null, skipped,
});

/* ============================ AI 判官（只在灰区调用） ============================ */

const JUDGE_ZH = [
  '你是一个「剧情重复判定器」。下面给你同一部剧情作品里相邻的两段内容。',
  '请判断【后一段】是否在重复【前一段】，并给出重复程度。',
  '只输出 JSON：{"repeated": true 或 false, "degree": 0到1之间的小数, "kind": "verbatim|paraphrase|fragment|none", "evidence": "不超过20字的依据"}',
  '',
  '判据：',
  '- 逐字或几乎逐字照抄：kind=verbatim，degree 接近 1；',
  '- 同一件事、同一拍剧情换个说法再演一遍（换了词但信息量没有新增）：kind=paraphrase，degree 0.5~0.9，仍然算重复；',
  '- 只共用一两句固定口头禅或称呼，其余是新的：kind=fragment，degree 0.2~0.4，不算重复；',
  '- 只是场景连续导致的自然承接（同一人物、地点、动作的必要延续，内容确实在推进）：kind=none，degree 接近 0，不算重复。',
  '判定要严：只有「信息量上没有新增、只是把前一段又说了一遍」才算重复。',
].join('\n');

const JUDGE_TW = [
  '你是一個「劇情重複判定器」。下面給你同一部劇情作品裡相鄰的兩段內容。',
  '請判斷【後一段】是否在重複【前一段】，並給出重複程度。',
  '只輸出 JSON：{"repeated": true 或 false, "degree": 0到1之間的小數, "kind": "verbatim|paraphrase|fragment|none", "evidence": "不超過20字的依據"}',
  '',
  '判據：',
  '- 逐字或幾乎逐字照抄：kind=verbatim，degree 接近 1；',
  '- 同一件事、同一拍劇情換個說法再演一遍（換了詞但資訊量沒有新增）：kind=paraphrase，degree 0.5~0.9，仍然算重複；',
  '- 只共用一兩句固定口頭禪或稱呼，其餘是新的：kind=fragment，degree 0.2~0.4，不算重複；',
  '- 只是場景連續導致的自然承接（同一人物、地點、動作的必要延續，內容確實在推進）：kind=none，degree 接近 0，不算重複。',
  '判定要嚴：只有「資訊量上沒有新增、只是把前一段又說了一遍」才算重複。',
].join('\n');

const JUDGE_EN = [
  'You are a DUPLICATE-DETECTION judge. You are given two adjacent passages from the same story.',
  'Decide whether the SECOND passage repeats the FIRST, and how much.',
  'Output ONLY JSON: {"repeated": true or false, "degree": a number between 0 and 1, "kind": "verbatim|paraphrase|fragment|none", "evidence": "<= 20 characters"}',
  '',
  'Rules:',
  '- Copied verbatim or almost verbatim: kind=verbatim, degree near 1;',
  '- The same beat told again in different words with no new information: kind=paraphrase, degree 0.5-0.9, still a repeat;',
  '- Only a shared catchphrase or form of address, everything else is new: kind=fragment, degree 0.2-0.4, NOT a repeat;',
  '- Merely a natural continuation because the scene is continuous (same people/place/action, the story is genuinely advancing): kind=none, degree near 0, NOT a repeat.',
  'Be strict: count it as a repeat only when there is NO new information and the first passage is simply said again.',
].join('\n');

function judgeContract(lang: RepeatLang): string {
  return lang === 'en' ? JUDGE_EN : lang === 'zh-TW' ? JUDGE_TW : JUDGE_ZH;
}

function parseJudge(raw: string): JudgeResult | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const kind = String(o.kind || 'none') as RepeatJudgeKind;
    return {
      repeated: o.repeated === true,
      degree: clamp01(numOr(String(o.degree ?? ''), 0)),
      kind: (['verbatim', 'paraphrase', 'fragment', 'none'] as string[]).includes(kind) ? kind : 'none',
      evidence: String(o.evidence || '').slice(0, 40),
    };
  } catch {
    return null;
  }
}

async function judgeRepeatByAI(input: { current: string; previous: string; lang: RepeatLang; domain: RepeatDomain; userId?: string }): Promise<JudgeResult | null> {
  try {
    const { client } = roleplayAuxClientFor();
    const label = input.domain === 'suggestions' ? '候选接话（玩家要说的话）' : '剧情回复';
    const user = [
      '【判定对象】' + label,
      '',
      '【前一段】',
      input.previous.slice(0, 1500),
      '',
      '【后一段】',
      input.current.slice(0, 1500),
    ].join('\n');
    const result = await client.models.generateContent({
      contents: [
        { role: 'system', parts: [{ text: judgeContract(input.lang) }] },
        { role: 'user', parts: [{ text: user }] },
      ],
      userId: input.userId,
      jsonMode: true,
      feature: 'roleplay',
    });
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseJudge(text);
  } catch (e) {
    console.warn('⚠️ [RepeatRefund] 判官调用失败，按不重复处理（照常扣费）：' + ((e as Error)?.message || e));
    return null;
  }
}

/* ============================ 决策（双钥匙） ============================ */

async function decide(input: { degree: number; current: string; previous: string; lang: RepeatLang; domain: RepeatDomain; userId?: string; pair: PairScore | null }): Promise<RepeatAssessment> {
  const d = clamp01(input.degree);
  const hi = highBand();
  if (d >= hi) {
    return { duplicate: true, degree: d, source: 'deterministic', kind: 'deterministic', detail: '重复度 ' + d.toFixed(2) + ' >= ' + hi, judge: null, pair: input.pair };
  }
  if (d >= grayLow()) {
    if (process.env.RP_REPEAT_JUDGE === '0') {
      return { duplicate: false, degree: d, source: 'none', kind: 'none', detail: '灰区但判官已关闭', judge: null, pair: input.pair };
    }
    const judge = await judgeRepeatByAI({ current: input.current, previous: input.previous, lang: input.lang, domain: input.domain, userId: input.userId });
    if (!judge) return { duplicate: false, degree: d, source: 'none', kind: 'none', detail: '灰区但判官不可用', judge: null, pair: input.pair };
    const duplicate = judge.repeated && judge.degree >= judgeMin() && judge.kind !== 'fragment';
    return { duplicate, degree: Math.max(d, judge.degree), source: 'ai', kind: judge.kind, detail: judge.evidence || ('判官 degree ' + judge.degree.toFixed(2)), judge, pair: input.pair };
  }
  return { duplicate: false, degree: d, source: 'none', kind: 'none', detail: '', judge: null, pair: input.pair };
}

/* ============================ 剧情回复：与「上一段」比 ============================ */

/**
 * 主回合判重：把本轮最终回复与「上一段回复」比（重新生成时由前端传被替换的那一版）。
 * 只在回复足够长（>= repeatMinChars）时才判——短台词整段相同是常态。
 */
export async function assessReplyRepeat(current: string, previous: string[], lang: RepeatLang, opts?: { userId?: string }): Promise<RepeatAssessment> {
  if (!repeatRefundEnabled()) return NONE('disabled');
  const cur = String(current || '');
  if (normalizeForDedupe(cur).length < repeatMinChars(lang)) return NONE('too-short');
  const prevs = (previous || []).map((p) => String(p || '')).filter((p) => normalizeForDedupe(p).length > 0).slice(0, 4);
  if (prevs.length === 0) return NONE('nothing-to-compare');

  let curVec: number[] | null = null;
  let prevVecs: (number[] | null)[] = [];
  if (semanticEnabled() && isEmbeddingReady()) {
    const vecs = await embedBatch([cur, ...prevs]);
    curVec = vecs[0] ?? null;
    prevVecs = vecs.slice(1);
  }

  const nc = normalizeForDedupe(cur);
  let best: PairScore | null = null;
  let bestPrev = '';
  prevs.forEach((p, i) => {
    const np = normalizeForDedupe(p);
    const span = longestCommonSpan(p, cur).length;
    const pv = prevVecs[i];
    const cosVal = curVec && pv ? cosine(curVec, pv) : 0;
    const pair = combinePairScore({ span, minLen: Math.min(nc.length, np.length), lexical: lexicalSimilarity(p, cur), cosine: cosVal, lang });
    if (!best || pair.score > best.score) { best = pair; bestPrev = p; }
  });
  const pair = best as PairScore | null;
  const a = await decide({ degree: pair ? pair.score : 0, current: cur, previous: bestPrev, lang, domain: 'reply', userId: opts?.userId, pair });
  repeatRefundStore.record(a, 'reply');
  return a;
}

/* ============================ 建议批次：与「上一批建议」比 ============================ */

const SUGGEST_ITEM_MIN = 10;

/**
 * 建议批次判重：逐条与上一批建议取最大相似度，命中条数 / 可比条数 = 覆盖率。
 * 只与「上一批建议」比，不跟剧情正文比——玩家台词与旁白天然不像，比了只会误伤。
 * 太短的条目（< SUGGEST_ITEM_MIN 字）不计入分母；可比条数不足 suggestMinItems 时不判。
 */
export async function assessSuggestionsRepeat(items: string[], previous: string[], lang: RepeatLang, opts?: { userId?: string }): Promise<RepeatAssessment> {
  if (!repeatRefundEnabled()) return NONE('disabled');
  const news = (items || []).map((s) => String(s || '')).filter((s) => normalizeForDedupe(s).length >= SUGGEST_ITEM_MIN);
  const prevs = (previous || []).map((s) => String(s || '')).filter((s) => normalizeForDedupe(s).length >= SUGGEST_ITEM_MIN);
  if (news.length === 0) return NONE('too-short');
  if (prevs.length === 0) return NONE('nothing-to-compare');
  if (news.length < suggestMinItems()) return NONE('too-short');

  const hitBar = suggestHit();
  let hits = 0;
  let sum = 0;
  for (const item of news) {
    let itemBest = 0;
    for (const p of prevs) {
      const s = pairScoreSync(p, item, lang).score;
      if (s > itemBest) itemBest = s;
    }
    sum += itemBest;
    if (itemBest >= hitBar) hits += 1;
  }
  const coverage = hits / news.length;
  const avg = sum / news.length;
  const degree = clamp01(coverage * 0.7 + avg * 0.3);
  const a = await decide({
    degree,
    current: news.join('\n'),
    previous: prevs.join('\n'),
    lang,
    domain: 'suggestions',
    userId: opts?.userId,
    pair: null,
  });
  if (!a.detail) a.detail = '命中 ' + hits + '/' + news.length + ' 条';
  repeatRefundStore.record(a, 'suggestions');
  return a;
}

/* ============================ 埋点（可观测 / 标定阈值） ============================ */

export interface RepeatRefundDay {
  checked: number;
  duplicate: number;
  deterministic: number;
  byAi: number;
  byDomain: Record<string, number>;
  byKind: Record<string, number>;
}
interface Shape { days: Record<string, RepeatRefundDay>; recent: { at: number; domain: string; degree: number; source: string; kind: string; detail: string }[] }

const FILE = dataFile('repeat-refund.json');
const KEEP_DAYS = 30;
const MAX_RECENT = 40;
const emptyDay = (): RepeatRefundDay => ({ checked: 0, duplicate: 0, deterministic: 0, byAi: 0, byDomain: {}, byKind: {} });
const dayKey = (at: number): string => {
  const d = new Date(at);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

class RepeatRefundStore {
  private data: Shape = { days: {}, recent: [] };
  constructor() { this.load(); }
  private load(): void {
    const parsed = readJson<Shape>(FILE, { days: {}, recent: [] });
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      this.data = { days: parsed.days, recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
    }
  }
  private save(): void { try { writeJson(FILE, this.data); } catch { /* 埋点失败绝不影响主流程 */ } }
  record(a: RepeatAssessment, domain: RepeatDomain): void {
    // 开关：单测/影子跑时不想污染线上统计就设 0（只跳过写盘，不影响判重结果）
    if (process.env.RP_REPEAT_REFUND_STATS === '0') return;
    const at = Date.now();
    const key = dayKey(at);
    const day = this.data.days[key] || emptyDay();
    day.checked += 1;
    day.byDomain[domain] = (day.byDomain[domain] || 0) + 1;
    if (a.duplicate) {
      day.duplicate += 1;
      if (a.source === 'deterministic') day.deterministic += 1;
      if (a.source === 'ai') day.byAi += 1;
      day.byKind[a.kind] = (day.byKind[a.kind] || 0) + 1;
      this.data.recent.unshift({ at, domain, degree: a.degree, source: a.source, kind: a.kind, detail: a.detail });
      this.data.recent = this.data.recent.slice(0, MAX_RECENT);
    }
    this.data.days[key] = day;
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > KEEP_DAYS) delete this.data.days[keys.shift() as string];
    this.save();
  }
  summary(days = 7): { days: ({ date: string } & RepeatRefundDay)[]; total: RepeatRefundDay; recent: Shape['recent'] } {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 7));
    const out: ({ date: string } & RepeatRefundDay)[] = [];
    const total = emptyDay();
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d.getTime());
      const day = this.data.days[key] || emptyDay();
      out.push({ date: key, ...day });
      total.checked += day.checked; total.duplicate += day.duplicate;
      total.deterministic += day.deterministic; total.byAi += day.byAi;
      for (const [k, v] of Object.entries(day.byDomain)) total.byDomain[k] = (total.byDomain[k] || 0) + v;
      for (const [k, v] of Object.entries(day.byKind)) total.byKind[k] = (total.byKind[k] || 0) + v;
    }
    return { days: out, total, recent: this.data.recent };
  }
}
export const repeatRefundStore = new RepeatRefundStore();
