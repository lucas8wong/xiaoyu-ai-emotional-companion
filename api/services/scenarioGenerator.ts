/**
 * 千世书「AI 生成剧本」—— 服务端剧本生成管线
 *
 * 从主题生成一份完整的文字人生模拟器剧本（骨架 + 本地事件池）。
 * 复刻前端 `src/wenyou/ai/generateScenario.ts` 的两阶段分批策略与硬契约校验，
 * 但全部发生在服务端：走 DeepSeek（jsonMode 强制 JSON 对象）、读小愈额度、做输出安全过滤。
 *
 * 为什么放服务端：文游回合已由后端驱动（无需用户 Key），AI 生成剧本也应同路径，
 * 且单次生成会深度调用多次 LLM（骨架 + 多批支线），由服务端统一门控/记账更可控。
 *
 * 依赖注入：`deps.generateContent` 可传入自定义 LLM 调用（测试用），缺省用 deepseek 客户端。
 */

import { z } from 'zod';
import { createDeepSeekClient } from './deepseek.js';
import { normalizeScriptDeep, toOutputLang, type OutputLang } from './zhConvert.js';

/* ---------------- 结局条件解析（与前端 engine/condition 一致，避免运行期抛错） ---------------- */

type Clause =
  | { kind: 'maxTurns' }
  | { kind: 'has'; flag: string; neg: boolean }
  | { kind: 'cmp'; attr: string; op: '<=' | '>='; value: number };
type Condition = Clause | { kind: 'and'; parts: Clause[] };

function parseClause(input: string): Clause {
  const s = input.trim();
  if (s === 'maxTurns') return { kind: 'maxTurns' };
  const h = s.match(/^(!?)has\(\s*([^)]+?)\s*\)$/);
  if (h) return { kind: 'has', flag: h[2], neg: h[1] === '!' };
  const m = s.match(/^([a-z][a-zA-Z0-9_]*)\s*(<=|>=)\s*(-?\d+)$/);
  if (!m) throw new Error(`无法解析结局条件: ${input}`);
  return { kind: 'cmp', attr: m[1], op: m[2] as '<=' | '>=', value: Number(m[3]) };
}

function parseCondition(input: string): Condition {
  const parts = input.split('&').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`无法解析结局条件: ${input}`);
  if (parts.length === 1) return parseClause(parts[0]);
  return { kind: 'and', parts: parts.map(parseClause) };
}

/** 把模型可能输出的不严格比较写法归一为引擎只支持的 <= / >= / has() / maxTurns。 */
function normalizeCond(s: string): string {
  return s
    .split('&')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((clause) => {
      if (clause === 'maxTurns' || /^!?has\(.+\)$/.test(clause)) return clause;
      // key<N（严格小于）→ key <= N-1；key>N（严格大于）→ key >= N+1（属性为整数，等价收紧）
      const lt = clause.match(/^([a-z][a-zA-Z0-9_]*)\s*<\s*(-?\d+)$/);
      if (lt) return `${lt[1]} <= ${Number(lt[2]) - 1}`;
      const gt = clause.match(/^([a-z][a-zA-Z0-9_]*)\s*>\s*(-?\d+)$/);
      if (gt) return `${gt[1]} >= ${Number(gt[2]) + 1}`;
      // key==N / key=N（相等）→ key>=N & key<=N
      const eq = clause.match(/^([a-z][a-zA-Z0-9_]*)\s*={1,2}\s*(-?\d+)$/);
      if (eq) return `${eq[1]} >= ${eq[2]} & ${eq[1]} <= ${eq[2]}`;
      return clause;
    })
    .join(' & ');
}

function conditionAttrs(c: Condition): string[] {
  const clauses = c.kind === 'and' ? c.parts : [c];
  return clauses.flatMap((p) => (p.kind === 'cmp' && p.attr !== 'turn' ? [p.attr] : []));
}

/* ---------------- Schema（与前端 scenarios/schema.ts 对齐） ---------------- */

const bandSchema = z.object({
  upTo: z.number(),
  label: z.string().min(1),
  severity: z.enum(['critical', 'low', 'normal', 'high']).default('normal'),
  directive: z.string().optional(),
});

const attributeSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, '属性 key 必须是小写字母开头的 ASCII 标识符'),
    name: z.string().min(1),
    initial: z.number(),
    max: z.number().positive(),
    deathBelow: z.number().optional(),
    decayPerTurn: z.number().nonnegative().optional(),
    ceiling: z.number().optional(),
    ceilingUnlocks: z.array(z.object({ flag: z.string(), max: z.number() })).optional(),
    bands: z.array(bandSchema).min(1).optional(),
  })
  .refine((a) => a.initial >= 0 && a.initial <= a.max, {
    message: 'initial 必须在 [0, max] 范围内',
  })
  .refine((a) => a.deathBelow === undefined || a.deathBelow < a.initial, {
    message: 'deathBelow 必须小于 initial，否则开局即死',
  })
  .refine(
    (a) => !a.bands || a.bands.every((b, i) => i === 0 || b.upTo > a.bands![i - 1].upTo),
    { message: 'bands 的 upTo 必须严格升序' },
  );

const openingSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  flag: z.string().optional(),
});

const outcomeSchema = z.object({
  weight: z.number().positive().default(1),
  effects: z.record(z.string(), z.number()).default({}),
  reaction: z.string().optional(),
  narrative: z.string().optional(),
  flagsSet: z.array(z.string()).optional(),
  flagsClear: z.array(z.string()).optional(),
  itemsGained: z.array(z.string().min(1)).optional(),
  itemsLost: z.array(z.string().min(1)).optional(),
  endTone: z.string().optional(),
});

const localChoiceSchema = z.object({
  text: z.string().min(1),
  effects: z.record(z.string(), z.number()).default({}),
  reaction: z.string().optional(),
  outcomes: z.array(outcomeSchema).min(1).optional(),
  flagsSet: z.array(z.string()).optional(),
  flagsClear: z.array(z.string()).optional(),
  endTone: z.string().optional(),
});

const localEventSchema = z.object({
  narrative: z.string().min(1),
  choices: z.array(localChoiceSchema).min(2).max(6),
  summary: z.string().min(1),
  minTurn: z.number().int().positive().optional(),
  maxTurn: z.number().int().positive().optional(),
  once: z.boolean().optional(),
  weight: z.number().positive().optional(),
  requires: z.string().optional(),
  requiresItem: z.string().optional(),
  itemsGained: z.array(z.string().min(1)).optional(),
  itemsLost: z.array(z.string().min(1)).optional(),
  keyMoment: z.boolean().optional(),
  wildcard: z.boolean().optional(),
  art: z.string().optional(),
  gen: z.enum(['flux', 'gemini']).optional(),
});

const endingSchema = z.object({
  condition: z.string().min(1),
  tone: z.string().min(1),
  epilogue: z.string().optional(),
  art: z.string().optional(),
  gen: z.enum(['flux', 'gemini']).optional(),
});

const scenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    genre: z.string().optional(),
    intro: z.string().min(1),
    attributes: z.array(attributeSchema).min(1),
    openings: z.array(openingSchema).optional(),
    turnUnit: z.string().default('回合'),
    maxTurns: z.number().int().positive().optional(),
    finale: z.string().optional(),
    tierLabel: z.string().optional(),
    systemPrompt: z.string().min(1),
    endings: z.array(endingSchema).min(1),
    ambitions: z.array(z.string().min(1)).optional(),
    localEvents: z.array(localEventSchema).optional(),
  })
  .superRefine((sc, ctx) => {
    const keys = new Set<string>();
    sc.attributes.forEach((a, i) => {
      if (keys.has(a.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attributes', i, 'key'], message: `属性 key "${a.key}" 重复` });
      }
      keys.add(a.key);
    });
    sc.endings.forEach((e, i) => {
      try {
        parseCondition(e.condition);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endings', i, 'condition'], message: err instanceof Error ? err.message : String(err) });
      }
    });
  });

export const importScenarioSchema = scenarioSchema.superRefine((sc, ctx) => {
  const keys = new Set(sc.attributes.map((a) => a.key));
  sc.endings.forEach((e, i) => {
    try {
      const missing = conditionAttrs(parseCondition(e.condition)).find((a) => !keys.has(a));
      if (missing) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endings', i, 'condition'], message: `结局条件引用了未定义的属性 "${missing}"` });
      }
    } catch {
      // 语法错误已由 scenarioSchema 报告
    }
  });
});

/* ---------------- 骨架 schema（仅生成阶段用） ---------------- */

const CONDITION_GRAMMAR = `条件语法（严格）：只能用 "属性key<=数字"、"属性key>=数字"、或字面量 "maxTurns"；多个子句用 " & " 连接表示「同时满足」。属性 key 必须是本剧本已定义的。例：'favor<=0'、'maxTurns & hp>=70 & sanity>=70'。不支持 < > == 或任何其它写法。`;

const CONDITION_GRAMMAR_EN = `Condition syntax (strict): only "attrKey<=number", "attrKey>=number", or the literal "maxTurns"; join multiple clauses with " & " for "all must hold". Attribute keys must already be defined in this scenario. Example: 'favor<=0', 'maxTurns & hp>=70 & sanity>=70'. < > == or any other form is NOT supported.`;

const skeletonSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  attributes: z.array(attributeSchema).min(1),
  openings: z.array(openingSchema).min(1),
  ambitions: z.array(z.string().min(1)).min(1),
  turnUnit: z.string().min(1),
  maxTurns: z.number().int().positive(),
  systemPrompt: z.string().min(1),
  endings: z.array(endingSchema).min(1),
});
type Skeleton = z.infer<typeof skeletonSchema>;

/* ---------------- 提示词 ---------------- */

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

/** 剧本「骨架」生成提示词（2026-09-26 起 export：控制台「📝 提示词」页要展示当前全文） */
export function skeletonPrompt(theme: string, lang?: OutputLang): Message[] {
  const isEn = lang === 'en';
  if (isEn) {
    return [
      {
        role: 'system',
        content: `You are a senior scenario designer for a text-based life-simulation game. Based on the user's theme, design the "skeleton" of a scenario. Output only ONE JSON object, no explanations or code fences.

Field requirements:
- title: an English title (4-6 words). intro: 2-3 immersive sentences of opening background.
- attributes: exactly 3 core attributes. Each { key (a lowercase English identifier, e.g. hp/favor), name (English name), initial, max (always 100), deathBelow (optional: 0 for an attribute that kills at 0, and it must be less than initial), bands (3-4 named bands ordered by strictly ascending upTo, each { upTo, label (2-4 word English), severity (critical|low|normal|high), directive (optional: a hard instruction to the host AI when the value falls here, e.g. crisis at low value) }) }. 1-2 of them should be "death attributes" (deathBelow:0), the rest are growth/progress attributes (no deathBelow, lower starting value).
- openings: 3 starting identities { name, prompt (one-line identity setup) }.
- ambitions: 5 selectable player goals (short phrases).
- turnUnit: a single word for the turn unit (e.g. year/month/day/turn). maxTurns: an integer 20-30.
- systemPrompt: the worldview and rules for the host AI (explain each attribute, death conditions and narrative style), concise and powerful.
- endings: 18-20 endings { condition, tone (an English ending-tone name, e.g. "Fulfilled...") }. ${CONDITION_GRAMMAR_EN}
  Ending order: death-attribute "key<=0" first, then a few immediate extreme endings, then "maxTurns & ..." completion endings (more specific clauses first, fewer later), with the last one plain "maxTurns" as the fallback. All referenced attributes must be defined in attributes.

Do not output a localEvents field. Only output the JSON object.`,
      },
      { role: 'user', content: `Theme: ${theme}` },
    ];
  }
  return [
    {
      role: 'system',
      content: `你是文字人生模拟游戏的资深剧本设计师。根据用户给的主题，设计一个剧本「骨架」，只输出一个 JSON 对象，不要任何解释或代码围栏。

字段要求：
- title：中文剧本名（4-6字）。intro：2-3句开场背景，有代入感。
- attributes：恰好 3 个核心属性。每个 { key（小写英文标识符，如 hp/favor）, name（中文名）, initial, max（统一为 100）, deathBelow（可选，归零即死的属性设为 0，且必须小于 initial）, bands（3-4 段命名分段，按 upTo 严格升序，每段 { upTo, label（2-4字中文）, severity（critical|low|normal|high）, directive（可选：落入该段时给主持AI的硬指令，如低值出危机） }） }。其中 1-2 个设为「死亡属性」(deathBelow:0)，其余作为成长/进度属性（无 deathBelow，初值偏低）。
- openings：3 个开局身份 { name, prompt（一句话身份设定） }。
- ambitions：5 条玩家可选的目标（短句）。
- turnUnit：单字回合单位（如 天/年/月/载/章）。maxTurns：20-30 的整数。
- systemPrompt：给主持AI的世界观与规则（说明各属性含义、死亡条件、文风），简洁有力。
- endings：18-20 个结局 { condition, tone（中文结局基调名，如 "功成名就·..."） }。${CONDITION_GRAMMAR}
  结局排序：死亡属性的 "key<=0" 放最前；其后是若干即时极端结局；再后是 "maxTurns & ..." 满任结局，子句多（具体）的在前、少的在后，最后一条用纯 "maxTurns" 兜底。条件引用的属性必须都在 attributes 里。

不要输出 localEvents 字段。只输出 JSON 对象。`,
    },
    { role: 'user', content: `主题：${theme}` },
  ];
}

/** 并发批次的「侧重方向」：多批同时生成时用不同取材面错开，降低撞名概率（撞名会被本地去重丢掉、需要补波）。 */
const BATCH_FOCUS_ZH = [
  '机遇与成长（抓住向上的机会、积累与精进）',
  '危机与风险（意外、损失、伤病与险境）',
  '人际与情感（亲情、友情、爱恨与背叛）',
  '外部世界与变故（时代、时局、天灾与大事件）',
  '内心与抉择（价值观冲突、诱惑与自省）',
  '日常与细节（生活日常里的小转折与微光）',
];
const BATCH_FOCUS_EN = [
  'opportunity and growth (seizing chances, building up, mastery)',
  'crisis and risk (accidents, loss, injury, danger)',
  'relationships and emotion (family, friendship, love, betrayal)',
  'the wider world and upheaval (era, politics, disaster, big events)',
  'inner conflict and choices (values, temptation, self-reflection)',
  'everyday life and detail (small turns and small mercies of daily life)',
];

/** 支线「事件池」生成提示词（2026-09-26 起 export：控制台「📝 提示词」页要展示当前全文） */
export function eventsPrompt(
  theme: string,
  sk: Skeleton,
  usedSummaries: string[],
  n: number,
  lang?: OutputLang,
  focusIndex?: number,
  focusTotal?: number,
): Message[] {
  const isEn = lang === 'en';
  const focusZh = focusIndex === undefined ? '' : `\n本批侧重方向：${BATCH_FOCUS_ZH[focusIndex % BATCH_FOCUS_ZH.length]}（本批与另外 ${Math.max(0, (focusTotal ?? 1) - 1)} 批并行生成，只在本侧重方向取材，避免与其它批次雷同）。`;
  const focusEn = focusIndex === undefined ? '' : `\nThis batch's focus: ${BATCH_FOCUS_EN[focusIndex % BATCH_FOCUS_EN.length]} (it runs in parallel with ${Math.max(0, (focusTotal ?? 1) - 1)} other batch(es); draw only from this focus so the batches do not overlap).`;
  if (isEn) {
    const attrLinesEn = sk.attributes
      .map((a) => `  ${a.key} (${a.name}${a.deathBelow !== undefined ? ', death attribute, dies at 0' : ', growth attribute'})`)
      .join('\n');
    return [
      {
        role: 'system',
        content: `You are writing the "local event pool" for a text-based life-simulation scenario (branch story units playable without the AI). Output only ONE JSON object { "events": [ ... ] }, no explanations or fences.

Scenario: ${sk.title} — ${sk.intro}
Turn unit: ${sk.turnUnit}, ${sk.maxTurns} turns in total.
Attributes (effects and requires can only use these keys):
${attrLinesEn}

Each event object fields:
- narrative: 1-3 tense, vivid sentences of a situation.
- choices: 2-4 options, each { text (option text), effects (object; keys are the attribute keys above, values are positive/negative integers) }. The options of one event must form a real trade-off: growth attributes change in small steps (about ±4~±12), death attributes can swing more at crisis but a single option should not instantly kill; at least one option carries a real cost. A cautious/safe option must not be strictly worse than a risky one.
- summary: a ≤6-word unique event name, must not collide with the already-used names below.
- optional: minTurn / maxTurn (integers 1~${sk.maxTurns}), once (true = at most once per run), weight (weighted random weight, default 1), requires (${CONDITION_GRAMMAR_EN}), requiresItem (name of an item needed), itemsGained / itemsLost (arrays of item names). Use these to create state/progress-gated branches and item lines.

Already used event names (avoid): ${usedSummaries.length ? usedSummaries.join(', ') : '(none)'}

This batch produces ${n} diverse, non-overlapping events. Only output { "events": [...] }.`,
      },
      { role: 'user', content: `Theme: ${theme}. Produce ${n} new events.${focusEn}` },
    ];
  }
  const attrLines = sk.attributes
    .map((a) => `  ${a.key}（${a.name}${a.deathBelow !== undefined ? '，死亡属性，归零即死' : '，成长属性'}）`)
    .join('\n');
  return [
    {
      role: 'system',
      content: `你在为一个文字人生模拟剧本撰写「本地事件池」（无需 AI 即可游玩的分支剧情单元）。只输出一个 JSON 对象 { "events": [ ... ] }，不要任何解释或围栏。

剧本：《${sk.title}》——${sk.intro}
回合单位：${sk.turnUnit}，全局共 ${sk.maxTurns} 回合。
属性（effects 与 requires 只能用这些 key）：
${attrLines}

每个事件对象字段：
- narrative：1-3 句有张力的情境描写。
- choices：2-4 个选项，每个 { text（选项文案）, effects（对象，键为上面的属性 key，值为正负整数） }。同一事件各选项要形成真实取舍：成长属性小步变化（约 ±4~±12），死亡属性在危机时可较大波动但单个选项不应一击必死；至少一个选项带明显代价。谨慎/稳妥的选项不可严格劣于冒险选项。
- summary：≤6 字的事件名，必须唯一、且不得与下列已用名重复。
- 可选：minTurn / maxTurn（1~${sk.maxTurns} 的整数）、once（true 表示一局最多触发一次）、weight（加权随机权重，默认1）、requires（${CONDITION_GRAMMAR}）、requiresItem（需持有的物品名）、itemsGained / itemsLost（物品名数组）。用这些做出「随状态/进度解锁的分支」与物品线。

已用事件名（务必避开）：${usedSummaries.length ? usedSummaries.join('、') : '（无）'}

本次产出 ${n} 个**风格各异、互不雷同**的事件。只输出 { "events": [...] }。`,
    },
    { role: 'user', content: `主题：${theme}。请产出 ${n} 个新事件。${focusZh}` },
  ];
}

/* ---------------- JSON 提取 ---------------- */

/** 从文本里提取第一个可完整解析的 JSON 对象（字符串感知的花括号配对）。 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('AI 返回内容中没有 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const obj = text.slice(start, i + 1);
        try {
          return JSON.parse(obj);
        } catch {
          throw new Error('AI 返回的 JSON 无法解析');
        }
      }
    }
  }
  throw new Error('AI 返回内容中没有闭合的 JSON 对象');
}

/* ---------------- 事件清洗 ---------------- */

function sanitizeEvent(raw: unknown, attrKeys: Set<string>): LocalEventLike | null {
  const parsed = localEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ev = parsed.data;
  ev.choices = ev.choices.map((c) => ({
    ...c,
    effects: Object.fromEntries(Object.entries(c.effects).filter(([k]) => attrKeys.has(k))),
  }));
  if (ev.choices.some((c) => Object.keys(c.effects).length === 0)) return null;
  if (ev.requires) {
    ev.requires = normalizeCond(ev.requires);
    try {
      if (conditionAttrs(parseCondition(ev.requires)).some((a) => !attrKeys.has(a))) return null;
    } catch {
      return null;
    }
  }
  return ev as LocalEventLike;
}

type LocalEventLike = z.infer<typeof localEventSchema>;

/* ---------------- 唯一 id ---------------- */

function uniqueId(theme: string, taken: Set<string>): string {
  const ascii = theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `gen-${ascii || 'scenario'}`.slice(0, 32);
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/* ---------------- 生成入口 ---------------- */

export interface GenerateScenarioOptions {
  theme: string;
  target?: number;
  batchSize?: number;
  existingIds?: string[];
  userId?: string;
  /** 输出语言：en=英文；zh-CN=简体；zh-TW=繁体（后端直接产出目标字体，前端 opencc 幂等不再重复转换）。缺省 zh-CN。 */
  lang?: OutputLang;
  /** 深度思考档位；缺省 high（AI 生成剧本为 Pro 专属，默认深度思考） */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'max';
  /**
   * 每个「波次」并发的事件批次数（缺省 4，上限 8；1 = 旧串行行为）。
   * 为什么要并发：整份剧本原本是 1 次骨架 + 最多 7 轮支线**串行**调用，单次高思考动辄数十秒，
   * 总耗时普遍超过 100s —— 而线上经 Cloudflare 回源，超过约 100s 无数据即回 524，
   * 用户侧表现为「HTTP错误: 524」。并发让 4 批支线同时跑，墙钟时间降到约「骨架 + 一批」。
   */
  parallelBatches?: number;
  /** 进度回调：骨架完成 / 每波支线收集后（done=已收集事件数, total=目标数）。SSE 路由据此推实时进度。 */
  onProgress?: (p: { step: 'skeleton' | 'events'; done: number; total: number }) => void;
  /** 外部中断信号：客户端断开时中止上游 DeepSeek 调用（避免白烧多次生成）。 */
  signal?: AbortSignal;
}

interface GenerateContentReq {
  contents: Array<{ role: 'system' | 'user' | 'model'; parts: Array<{ text: string }> }>;
  userId?: string;
  jsonMode?: boolean;
  thinkingLevel?: GenerateScenarioOptions['thinkingLevel'];
  signal?: AbortSignal;
  /** 成本归属（运营端「API 成本构成」）：千世书剧本生成记 'wenyou' */
  feature?: string;
}

interface GenerateDeps {
  /** 可注入的 LLM 调用（测试/代理用）。缺省用 createDeepSeekClient().models.generateContent */
  generateContent?: (req: GenerateContentReq) => Promise<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    /** 'length' = 输出撞上 max_tokens（高思考档常把预算全花在 reasoning 上，正文被截断/为空） */
    finishReason?: string;
  }>;
}

export interface GeneratedScenario {
  id: string;
  title: string;
  genre?: string;
  intro: string;
  attributes: z.infer<typeof attributeSchema>[];
  openings?: z.infer<typeof openingSchema>[];
  turnUnit: string;
  maxTurns?: number;
  finale?: string;
  tierLabel?: string;
  systemPrompt: string;
  endings: z.infer<typeof endingSchema>[];
  ambitions?: string[];
  localEvents?: z.infer<typeof localEventSchema>[];
}

export async function generateScenario(
  opts: GenerateScenarioOptions,
  deps: GenerateDeps = {},
): Promise<GeneratedScenario> {
  const target = opts.target ?? 40;
  const batchSize = opts.batchSize ?? 10;
  const gen = deps.generateContent ?? createDeepSeekClient().models.generateContent;
  const userId = opts.userId;

  const callJson = async (messages: Message[]): Promise<unknown> => {
    const contents = messages.map((m) => ({
      role: (m.role === 'assistant' ? 'model' : m.role) as 'system' | 'user' | 'model',
      parts: [{ text: m.content }],
    }));
    const level = opts.thinkingLevel ?? 'high';
    const attempt = async (thinkingLevel: GenerateScenarioOptions['thinkingLevel']) => {
      const result = await gen({ contents, userId, jsonMode: true, thinkingLevel, signal: opts.signal, feature: 'wenyou' });
      return {
        text: result?.candidates?.[0]?.content?.parts?.[0]?.text || '',
        finishReason: result?.finishReason || '',
      };
    };
    let { text, finishReason } = await attempt(level);
    // 高思考档经常把 8192 输出预算全花在 reasoning 上（线上日志可见 reasoning≈8189 / content=0），
    // 导致该批返回空或被截断的 JSON → 旧逻辑只当「解析失败」丢一轮，既白等数十秒又白烧一次调用。
    // 这里对**同一批**降档重试一次（low 思考更省预算、正文更容易出全）：不重跑整份流程、不多扣额。
    if (level !== 'low' && (finishReason === 'length' || !text.trim())) {
      console.warn(`⚠️ [ScenarioGen] 批次输出为空或被截断（finish_reason=${finishReason || 'n/a'}），降档 low 重试一次`);
      ({ text, finishReason } = await attempt('low'));
    }
    if (!text.trim()) throw new Error('AI 未返回内容');
    return extractJson(text);
  };

  // 骨架
  const sk = skeletonSchema.parse(await callJson(skeletonPrompt(opts.theme, opts.lang)));
  // 模型偶尔不守「只允许 <= / >=」的语法 → 先归一，避免单个坏结局让整份生成失败
  sk.endings = sk.endings.map((e) => ({ ...e, condition: normalizeCond(e.condition) }));
  const attrKeys = new Set(sk.attributes.map((a) => a.key));
  opts.onProgress?.({ step: 'skeleton', done: 0, total: target });

  // 事件池（并发波次）：每波最多 parallel 批同时生成，批间用「侧重方向」错开以减少撞名，
  // 收齐后按 summary 本地去重；并发批次各自看到的是同一份「已用名快照」，可能撞名导致该波不够量，
  // 因此允许再补一波（maxWaves = 理论波数 + 1）。
  const events: LocalEventLike[] = [];
  const used = new Set<string>();
  const parallel = Math.max(1, Math.min(opts.parallelBatches ?? 4, 8));
  const batchCount = Math.max(1, Math.ceil(target / batchSize));
  // +2 备用波：并发批次各自看到同一份「已用名快照」，撞名会被本地去重丢掉；模型偶尔也会少给几条。
  // 只有「还没凑够 target」才会真的多跑一波，正常情况不会多花时间。
  const maxWaves = Math.max(1, Math.ceil(batchCount / parallel) + 2);
  for (let wave = 0; wave < maxWaves && events.length < target; wave++) {
    const need = target - events.length;
    const want = Math.min(batchSize, need);
    const n = Math.max(1, Math.min(parallel, Math.ceil(need / batchSize)));
    const snapshot = [...used];
    // 单批落地即合并 + 推进度（而不是等整波收齐）：用户能看到「支线 10/40、20/40…」逐批长出来
    const mergeBatch = (batch: unknown): void => {
      const arr = Array.isArray(batch) ? batch : Array.isArray((batch as { events?: unknown }).events) ? (batch as { events: unknown[] }).events : [];
      for (const raw of arr) {
        if (events.length >= target) break;
        const ev = sanitizeEvent(raw, attrKeys);
        if (ev && !used.has(ev.summary)) {
          used.add(ev.summary);
          events.push(ev);
        }
      }
      opts.onProgress?.({ step: 'events', done: events.length, total: target });
    };
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        callJson(eventsPrompt(opts.theme, sk, snapshot, want, opts.lang, n > 1 ? i : undefined, n))
          .then(mergeBatch)
          // 单批失败（截断/超时/解析失败）不拖垮整份生成：由后续波次补量
          .catch(() => null),
      ),
    );
  }

  if (events.length === 0) {
    throw new Error('未能生成任何有效支线事件，请重试或更换主题');
  }

  // 结局条件容错：归一后仍无法解析或引用未定义属性的结局直接丢弃（避免单个坏结局让整份生成失败）
  const endings = sk.endings.filter((e) => {
    try {
      return !conditionAttrs(parseCondition(e.condition)).some((a) => !attrKeys.has(a));
    } catch {
      return false;
    }
  });
  if (endings.length === 0) throw new Error('剧本结局条件均无法解析，请更换主题重试');
  const id = uniqueId(opts.theme, new Set(opts.existingIds ?? []));
  const scenario = { ...sk, id, endings, localEvents: events };
  return normalizeScriptDeep(importScenarioSchema.parse(scenario), toOutputLang(opts.lang)) as GeneratedScenario;
}
