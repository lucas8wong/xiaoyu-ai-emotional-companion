/**
 * 控制台「📝 提示词」页的**唯一数据源**（只读）。
 *
 * 为什么要有这个文件：提示词散在 20 多个模块里（人设/去 AI 腔/安全边界/各模式的组装串），
 * 运营想知道「现在模型到底收到什么」只能翻代码或翻线上日志。这里把每条链路的**当前**文本
 * 按模式收拢成结构化数据，控制台直接渲染。
 *
 * 纪律（重要）：
 *   1. **不复制文本**。所有内容都从真实调用点同源的 builder / 常量读出来 —— 复制一份必然漂移，
 *      那正是「提示词监控」最不能出的错。取不到的（内联在函数里、未导出）如实标出来，
 *      不猜、不近似。
 *   2. **只读、无副作用**。不写 store、不发请求、不落盘；需要用户上下文才有内容的块（记忆/昵称/
 *      地区语气/括号开关），一律用「示例值」渲染，并在 note 里写明这是示例。
 *   3. 敏感内容（成人模式提示词、情欲/分流引导）**照实展示**——控制台本来就是 ADMIN_TOKEN 鉴权，
 *      且运营必须能看到模型收到的原文；但会在 note 里标明敏感。
 *
 * 出口：
 *   · promptCatalogIndex()                    → 模式清单（不含正文，供左侧列表）
 *   · promptCatalogMode(id, {lang, scenarioId, style}) → 单个模式全文
 */
import crypto from 'node:crypto';
import {
  PERSONA, HUMANIZE_RULES, BRAND_TONE, STORY_STYLE_ABSTRACT, REGION_CARDS, INTENSITY_MAP,
  REGION_CARDS_EN, INTENSITY_MAP_EN, SAFETY_TONE, INJECTION_BOUNDARY, CONTENT_GUIDE,
  CHAT_REDIRECT_GUIDE, LANGUAGE_REQUIREMENT, METHODOLOGY_SELECTOR,
  buildPlainTextDirective, buildUserPersonDirective, buildOutputScriptDirective,
} from './prompts.js';
import type { OutputLang } from './zhConvert.js';
import { COMPANION_STANCE, NO_META_NARRATION_RULE } from './companionStance.js';
import {
  CHAT_SLOP_ZH, CHAT_SLOP_EN, CHAT_FIRST_TURN_ZH, CHAT_FIRST_TURN_EN,
  CHAT_ADULT_REDIRECT_ZH, CHAT_ADULT_REDIRECT_EN, CHAT_EXPLICIT_STEER_ZH,
  buildChatAntiRepeatBlock, buildChatLengthTargetBlock,
} from './chatVoice.js';
import { buildChatRelationBlock } from './chatRelation.js';
import { buildChatStateBlock } from './chatState.js';
import { buildDailyLifeBlock, fallbackItems } from './chatDailyLife.js';
import {
  buildPersona, buildCustomCharacterPersona, buildChatInnerMonologueBlock, buildChatPromptParts,
  buildEmotionAnalysisPrompt, buildQuestionsPrompt, buildDetailedAnalysisPrompt,
  buildHealingStoryPrompt, buildFollowUpPrompt, STORY_STYLE_EXTRA,
  buildMemoryExtractPrompt, buildGrowthTickPrompt, buildAnnouncementPrompt, buildInstagramPrompt,
  type ChatMessageInput, type EmotionAnalysisResult, type DetailedAnalysisResult,
} from './gemini.js';
import type { ChatCharacter } from './chatCharacter.js';
import {
  SCENARIOS, getScenario, buildSystemPrompt as buildRpSystemPrompt, composeRoleplaySystem,
  roleplayTaskInstr, roleplayContinueInstr, buildTurnDisciplineBlock, buildLengthDirective,
  buildPunctuationDirective, buildUnlimitedModeBlock, pickRulesText, buildCustomScenarioSystem,
  buildDraftSystemPrompt, buildReviseSystemPrompt, buildSuggestSystemPrompt, injectionBoundaryFor,
  type RPLang, type RoleplayScenario, type RoleplayNarrativeStyle,
} from './roleplay.js';
import { quoteRuleBlock } from './dialogueQuotes.js';
import { LIFE_TOOLS } from './lifeTools.js';
import { textgameLangDirective, textgameGmBase, textgameJsonDirective } from './textgamePrompts.js';
import { skeletonPrompt, eventsPrompt } from './scenarioGenerator.js';
import { buildSystemPrompt as buildWerewolfSystemPrompt, BUILTIN_PLAYERS } from '../../src/werewolf/ai/prompt.js';
import { buildHookPrompt, type Candidate, type EngagementFeature } from './reengage.js';
import { AI_ANALYST_SYSTEM_PROMPT } from './adminAnalytics.js';
import { nowParts } from './timeAnchor.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type PromptBlockKind = 'static' | 'dynamic' | 'sample' | 'sensitive' | 'gap';

export interface PromptBlock {
  id: string;
  /** 显示名（中文，带来源标记） */
  name: string;
  /** 来源：文件 + 函数/常量名 */
  source: string;
  text: string;
  chars: number;
  kind: PromptBlockKind;
  /** 口径说明（示例值？按用户上下文变？敏感？未纳入？） */
  note?: string;
}

export interface PromptVariant {
  id: string;
  name: string;
  text: string;
  chars: number;
}

export interface PromptModeMeta {
  id: string;
  name: string;
  icon: string;
  group: string;
  desc: string;
  /** 真实调用入口（函数 / 路由 / feature 成本归属） */
  entry: string;
  feature?: string;
  /** 该模式的可选参数（控制台据此显示下拉） */
  options?: { key: 'scenario' | 'style' | 'lang'; label: string; values: { value: string; label: string }[] };
  blockCount: number;
  variantCount: number;
  chars: number;
  /** 正文指纹：同一模式文本变了它就变（控制台用来提示「服务端提示词已更新」） */
  hash: string;
}

export interface PromptMode extends PromptModeMeta {
  notes: string[];
  variants: PromptVariant[];
  /** 该模式下每个变体/块的完整列表见 variant.blockList？——保持扁平：正文都在 variants + blockList 里 */
  blockList: PromptBlock[];
}

export interface PromptCatalogIndex {
  generatedAt: string;
  version: string;
  groups: { id: string; name: string; desc: string }[];
  modes: PromptModeMeta[];
  scenarios: { id: string; title: string }[];
  totals: { modes: number; chars: number };
  notes: string[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const LANG_LABEL: Record<string, string> = { zh: '简体中文', 'zh-TW': '繁體中文', en: 'English' };
const ALL_LANGS: RPLang[] = ['zh', 'zh-TW', 'en'];
/** 本目录的版本号：提示词结构变了就改它（控制台显示，便于对照 CHANGELOG） */
export const PROMPT_CATALOG_VERSION = '2026-09-26';

function blk(
  id: string,
  name: string,
  source: string,
  text: string,
  kind: PromptBlockKind = 'static',
  note?: string,
): PromptBlock {
  const t = String(text ?? '');
  return { id, name, source, text: t, chars: t.length, kind, ...(note ? { note } : {}) };
}

function variant(id: string, name: string, text: string): PromptVariant {
  const t = String(text ?? '');
  return { id, name, text: t, chars: t.length };
}

function hashOf(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 10);
}

/** 把「示例字符串」显式标出来，免得运营把样本当成真实用户内容 */
function sample(label: string): string {
  return '（示例）' + label;
}

// ---------------------------------------------------------------------------
// 1. 聊一聊（小愈 / 自定义角色）
// ---------------------------------------------------------------------------

const DEMO_HISTORY: Record<string, ChatMessageInput[]> = {
  zh: [
    { role: 'user', content: '今天上班被领导当众说了，很闷' },
    { role: 'assistant', content: '当众啊……那一下肯定不好受' },
    { role: 'user', content: '就是觉得自己很没用' },
  ],
  'zh-TW': [
    { role: 'user', content: '今天上班被主管當眾說了，很悶' },
    { role: 'assistant', content: '當眾啊……那一下肯定不好受' },
    { role: 'user', content: '就是覺得自己很沒用' },
  ],
  en: [
    { role: 'user', content: 'My manager called me out in front of everyone today' },
    { role: 'assistant', content: 'In front of everyone… that stings' },
    { role: 'user', content: 'I just feel useless' },
  ],
};

const SAMPLE_CHARACTER: ChatCharacter = {
  id: 'sample-luoyan',
  userId: '',
  name: '洛言',
  avatar: '',
  identity: sample('三十岁的深夜电台主播，说话慢，习惯先听人把话讲完。'),
  boundaries: sample('不评判、不催、不说教；不制造依赖。'),
  voice: sample('语速慢、句子短，常用「嗯，我在」；不连着两轮用同一个口头禅。'),
  opening: sample('今天信号不太好，但我还在。'),
  isDefault: false,
  createdAt: 0,
  updatedAt: 0,
  relation: 'friend',
};

async function buildChatMode(langs: RPLang[]): Promise<PromptMode> {
  const variants: PromptVariant[] = [];
  for (const lang of langs) {
    const parts = await buildChatPromptParts(DEMO_HISTORY[lang] || DEMO_HISTORY.zh, { userId: undefined }, true);
    variants.push(variant('sys-' + lang, `system 全文 · ${LANG_LABEL[lang]} · 常规轮`, parts.system));
    variants.push(variant('user-' + lang, `user 消息块 · ${LANG_LABEL[lang]}`, parts.user));
  }
  // 首轮（历史里还没有任何一条 assistant 回复）会额外注入「首轮开场块」
  const firstTurn = await buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: undefined }, true);
  variants.push(variant('sys-first', 'system 全文 · 简体中文 · 首轮（含首轮开场块）', firstTurn.system));

  const blockList: PromptBlock[] = [
    blk('persona-all', '小愈人设组装（buildPersona：PERSONA+地区+去AI腔+陪伴倾向+品牌语气…）', 'gemini.ts buildPersona()', buildPersona(undefined, undefined, undefined, 'zh-CN'), 'sample', '无 userId 时记忆/昵称/今日小事/行为感知为空；有用户时会追加这些块'),
    blk('region-default', '地区语气块（缺省：普通话·自然）', 'gemini.ts buildRegionBlock()', (buildPersona(undefined) || '').length ? '(见上方人设组装：地区语气卡按用户偏好取 REGION_CARDS / REGION_CARDS_EN)' : '', 'dynamic', '按用户偏好地区/强度取；完整卡表见「共用块库」'),
    blk('custom-persona', '自定义角色人设（灵魂框架）', 'gemini.ts buildCustomCharacterPersona()', buildCustomCharacterPersona(SAMPLE_CHARACTER, undefined, undefined, undefined, 'zh-CN'), 'sample', '用示例角色「洛言」渲染；真实文本由该角色的 identity/boundaries/voice/opening 组成'),
    blk('inner-on', '括号心理/神情 · 开启（默认）', 'gemini.ts buildChatInnerMonologueBlock()', buildChatInnerMonologueBlock(undefined, true)),
    blk('inner-off', '括号心理/神情 · 关闭', 'gemini.ts buildChatInnerMonologueBlock()', buildChatInnerMonologueBlock(undefined, false)),
    blk('slop-zh', '套话清单（每轮都在场）', 'chatVoice.ts CHAT_SLOP_ZH', CHAT_SLOP_ZH),
    blk('slop-en', '套话清单（英文）', 'chatVoice.ts CHAT_SLOP_EN', CHAT_SLOP_EN),
    blk('first-turn-zh', '首轮开场块', 'chatVoice.ts CHAT_FIRST_TURN_ZH', CHAT_FIRST_TURN_ZH),
    blk('first-turn-en', '首轮开场块（英文）', 'chatVoice.ts CHAT_FIRST_TURN_EN', CHAT_FIRST_TURN_EN),
    blk('length-sample', '本轮长度档（示例：用户上一条 12 字）', 'chatVoice.ts buildChatLengthTargetBlock()', buildChatLengthTargetBlock('就是觉得自己很没用', 'zh'), 'sample', '按用户上一条消息长度现算，逐轮不同'),
    blk('relation-sample', '关系档 × 气氛块（示例：朋友·轻松玩梗）', 'chatRelation.ts buildChatRelationBlock()', buildChatRelationBlock({ relation: 'friend', scene: 'playful', lang: 'zh' }), 'sample'),
    blk('state-empty', '会话状态块（示例：暂无状态=空）', 'chatState.ts buildChatStateBlock()', buildChatStateBlock(undefined, { lang: 'zh' }) || '(无状态时不注入)', 'sample'),
    blk('antirepeat-sample', '负例块（示例历史下的实际文案）', 'chatVoice.ts buildChatAntiRepeatBlock()', buildChatAntiRepeatBlock({ lang: 'zh', history: DEMO_HISTORY.zh as any }) || '(抽不到复现片段时不注入)', 'sample'),
    blk('daily-life-sample', '今日小事块（示例：静态池抽 6 条）', 'chatDailyLife.ts buildDailyLifeBlock()', buildDailyLifeBlock(fallbackItems('2026-09-26', 'zh', 6).map((t) => ({ text: t })) as any, 'zh'), 'sample', '真实条目由后台每天生成一次（生成提示词内联在 chatDailyLife.ts 的 ensureDailyLife，未导出）'),
    blk('adult-redirect-zh', '情欲话题引导块（敏感）', 'chatVoice.ts CHAT_ADULT_REDIRECT_ZH', CHAT_ADULT_REDIRECT_ZH, 'sensitive', '常驻注入，命中情欲话题时用'),
    blk('adult-redirect-en', '情欲话题引导块（英文·敏感）', 'chatVoice.ts CHAT_ADULT_REDIRECT_EN', CHAT_ADULT_REDIRECT_EN, 'sensitive'),
    blk('explicit-steer-zh', '露骨戏硬引导块（仅命中时注入·敏感）', 'chatVoice.ts CHAT_EXPLICIT_STEER_ZH', CHAT_EXPLICIT_STEER_ZH, 'sensitive', '由 detectExplicitScene() 按上一条用户消息判定后注入'),
    blk('tools-life', '工具定义：生活工具（随每次请求一起发给模型）', 'lifeTools.ts LIFE_TOOLS', LIFE_TOOLS.map((t: any) => {
      const f = t?.function || {};
      return `${f.name}：${f.description}\n参数：${JSON.stringify(f.parameters)}`;
    }).join('\n\n')),
    blk('tools-inline', '工具定义：web_search / read_url（内联未导出）', 'gemini.ts WEB_SEARCH_TOOL / READ_URL_TOOL', '实时搜索互联网，返回「标题+摘要+链接」供你汇总转述…… ／ 读取用户提供的网页链接正文（如小红书/抖音/大众点评/新闻/攻略链接）……', 'gap', '这两个 schema 内联在 gemini.ts，未导出；完整文本见该文件常量'),
    blk('tool-nudge', '工具轮收尾语（调完工具后再补一条 user 消息）', 'gemini.ts appendToolResults()', '请直接基于上面工具返回的信息回答我的问题，给出具体事实/数字。如果信息确实不足，请如实说明目前查不到。不要重复调用工具。', 'gap', '内联未导出，此处为原文摘录'),
    blk('turn-end', '收尾硬规则 / 安全边界 / 语言规则', 'gemini.ts buildChatPromptParts() 模板尾部', '见上方 system 全文（【收尾形态·硬规则】… INJECTION_BOUNDARY … 输出语言）'),
  ];

  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'chat',
    name: '聊一聊（小愈 / 自定义角色）',
    icon: '💬',
    group: 'companion',
    desc: '对话陪伴主链路：人设 + 去 AI 腔 + 地区语气 + 记忆/时间 + 关系档 + 会话状态 + 长度档 + 负例块',
    entry: 'api/services/gemini.ts buildChatPromptParts()（chatReply / chatReplyStream 共用）',
    feature: 'chat',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: [
      '控制台按 ADMIN_TOKEN 鉴权；本页含成人向/情欲引导提示词原文，请勿截图外传。',
      '示例渲染：无 userId（没有真实用户上下文），记忆块/昵称块/今日小事/行为感知这类「有用户才有」的块为空；标注 sample 的块用示例值渲染。',
      '真实调用 = 上面的 system 全文 + user 消息块，历史由会话带入。',
    ],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 2. 理一理（情绪梳理：理解 → 提问 → 情绪笔记 → 暖心故事 → 追问）
// ---------------------------------------------------------------------------

const SAMPLE_EMOTION: EmotionAnalysisResult = {
  category: '压力与耗竭',
  emotion: '疲惫',
  intensity: 7,
  analysis: sample('用户说「今天上班被领导当众说了，觉得自己很没用」'),
  suggestions: [sample('先让这份难受被好好待一会儿')],
};

const SAMPLE_DETAILED: DetailedAnalysisResult = {
  category: '压力与耗竭',
  valence: 'negative',
  emotionalState: sample('当下是很累、也有点自我否定'),
  triggers: [sample('被当众指出问题')],
  coreIssues: [sample('怕自己不够好')],
  recommendations: [sample('先把今晚过好，明天再说这件事')],
  positiveFactors: [sample('愿意把事情说出来')],
};

function buildStructureMode(langs: RPLang[]): PromptMode {
  const useLangs = langs.length ? langs : (['zh'] as RPLang[]);
  const variants: PromptVariant[] = [];
  for (const lang of useLangs) {
    const langNote = lang === 'zh' ? '' : `（⚠️ 该链路无 userId 时按缺省简中渲染；真实 ${LANG_LABEL[lang]} 用户由偏好驱动地区语气/输出语言块）`;
    variants.push(variant('emotion-' + lang, `① 情绪理解 · ${LANG_LABEL[lang]}${langNote}`, buildEmotionAnalysisPrompt(sample('今天跟同事吵了一架，很闷'), undefined, undefined)));
    variants.push(variant('questions-' + lang, `② 深入提问 · ${LANG_LABEL[lang]}${langNote}`, buildQuestionsPrompt(SAMPLE_EMOTION, undefined, sample('今天跟同事吵了一架'), undefined)));
    variants.push(variant('detailed-' + lang, `③ 情绪笔记 · ${LANG_LABEL[lang]}${langNote}`, buildDetailedAnalysisPrompt(SAMPLE_EMOTION, [{ question: sample('最想说的是哪一句？'), answer: sample('我其实想被认可') }], undefined, undefined)));
    variants.push(variant('story-' + lang, `④ 暖心故事 · ${LANG_LABEL[lang]}${langNote}`, buildHealingStoryPrompt(SAMPLE_DETAILED, undefined, sample('今天跟同事吵了一架'), undefined, STORY_STYLE_EXTRA.warm)));
    variants.push(variant('followup-' + lang, `⑤ 追问 · ${LANG_LABEL[lang]}${langNote}`, buildFollowUpPrompt({ analysis: SAMPLE_EMOTION.analysis, suggestions: SAMPLE_EMOTION.suggestions, detailed: SAMPLE_DETAILED.emotionalState, story: '' }, sample('我明天该怎么面对他？'), undefined, undefined)));
  }
  const blockList: PromptBlock[] = [
    blk('framework', '理解与陪伴框架（METHODOLOGY_SELECTOR）', 'prompts.ts METHODOLOGY_SELECTOR', METHODOLOGY_SELECTOR),
    ...Object.keys(STORY_STYLE_EXTRA).map((k) => blk('style-' + k, `故事风格附加块：${k}`, 'gemini.ts STORY_STYLE_EXTRA', STORY_STYLE_EXTRA[k])),
    blk('gap', '未纳入：语言/地区相关块按用户偏好即时生成', 'gemini.ts regionReminder() / langReminder()', '（这两个块读用户偏好与上一条输入，无 userId 时按缺省渲染，故未单独列出）', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'structure',
    name: '理一理（情绪梳理五步）',
    icon: '🧭',
    group: 'companion',
    desc: '结构化链路：情绪理解 → 深入提问 → 情绪笔记 → 暖心故事 → 追问；每步一次模型调用',
    entry: 'api/services/gemini.ts analyzeEmotion / generateQuestions / generateDetailedAnalysis / generateHealingStory / followUp',
    feature: 'structure',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: [
      '五个变体就是五步各自**完整**的 prompt（含人设 + 框架 + 输出语言），不是片段。',
      '故事风格有四档（诗意/温暖/简洁/抽象搞笑），示例用「温暖」；四档原文见块列表。',
    ],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 3. 剧情扮演（官方剧本 / 自建剧本 / AI 建剧 / AI 改稿 / 候选建议）
// ---------------------------------------------------------------------------

const SAMPLE_CUSTOM = {
  aiName: sample('沈清言'),
  aiPersona: sample('三十一岁的心外科医生，说话克制，习惯用最短的句子把情绪收起来。'),
  background: sample('你们在同一栋楼的夜班电梯里认识了三个月。'),
  opening: sample('电梯门开的时候他正低头看表，抬头看见你，停了一下。'),
};

function pickScenario(scenarioId?: string): RoleplayScenario {
  if (scenarioId) {
    const s = getScenario(scenarioId);
    if (s) return s;
  }
  return SCENARIOS[0];
}

function buildRoleplayMode(opts: { lang?: RPLang; scenarioId?: string; style?: RoleplayNarrativeStyle }): PromptMode {
  const scenario = pickScenario(opts.scenarioId);
  const langs = opts.lang ? [opts.lang] : ALL_LANGS;
  const styles: RoleplayNarrativeStyle[] = opts.style ? [opts.style] : ['immersive', 'classic'];
  const variants: PromptVariant[] = [];
  for (const lang of langs) {
    for (const style of styles) {
      const text = scenario[lang === 'en' ? 'en' : 'zh'];
      const aiName = text.ai.name;
      const sys = buildRpSystemPrompt(scenario, lang, undefined, undefined, undefined, style, false);
      const taskInstr = roleplayTaskInstr(style, aiName, lang);
      const composed = composeRoleplaySystem({ sys, lang, style, taskInstr, adult: false, userId: undefined });
      variants.push(variant(`${lang}-${style}`, `完整 system（模型真正收到的） · ${LANG_LABEL[lang]} · ${style === 'immersive' ? '沉浸/对话笔法' : '经典/小说笔法'}`, composed));
    }
  }
  /**
   * 成人档（无限制模式）单独给一个变体：它在 system 里的**成人口径散在四处**
   * （system 尾句 / 成人块 / 任务指令 / 回合纪律），只看成人块会漏掉后三处的差异。
   * 2026-09-27 用户口径「成人模式也要适当的自己推进剧情…可以主动调情，主动说色情的话，做色情的动作」
   * 就是改这四处 —— 所以这里必须能一眼看到**组装后的原文**。
   */
  for (const lang of langs) {
    const text = scenario[lang === 'en' ? 'en' : 'zh'];
    const adultSys = buildRpSystemPrompt(scenario, lang, undefined, undefined, undefined, 'immersive', true);
    const adultTask = roleplayTaskInstr('immersive', text.ai.name, lang, { adult: true });
    variants.push(variant(`adult-${lang}`, `🔞 完整 system · 成人模式（无限制） · ${LANG_LABEL[lang]} · 沉浸`, composeRoleplaySystem({
      sys: adultSys, lang, style: 'immersive', taskInstr: adultTask, adult: true, userId: undefined,
    })));
  }
  const zhName = scenario.zh.ai.name;
  const blockList: PromptBlock[] = [
    blk('injection', '安全边界句（反注入）', 'roleplay.ts injectionBoundaryFor()', injectionBoundaryFor('zh') + '\n\n---\n\n' + injectionBoundaryFor('en')),
    blk('task', '本轮任务指令（沉浸/经典各一份）', 'roleplay.ts roleplayTaskInstr()', roleplayTaskInstr('immersive', zhName, 'zh') + '\n\n---\n\n' + roleplayTaskInstr('classic', zhName, 'zh')),
    blk('task-adult', '本轮任务指令 · 成人档（🔞 主动推进分支）', 'roleplay.ts roleplayTaskInstr({ adult: true })', roleplayTaskInstr('immersive', zhName, 'zh', { adult: true }), 'sensitive', '默认档原文见上一条；成人档把「把选择权交回用户」换成「由你主动往下带」'),
    blk('discipline-adult', '回合纪律块 · 成人档（🔞 例外分支）', 'roleplay.ts buildTurnDisciplineBlock(..., adult)', buildTurnDisciplineBlock('zh', 'immersive', false, true), 'sensitive', '默认档把「角色要更主动」列为被压过；成人档改为只管节奏与收尾形态，不收窄推进幅度'),
    blk('continue', '续写指令（被截断后续写）', 'roleplay.ts roleplayContinueInstr()', roleplayContinueInstr('zh')),
    blk('discipline-immersive', '回合纪律块 · 沉浸', 'roleplay.ts buildTurnDisciplineBlock()', buildTurnDisciplineBlock('zh', 'immersive', false)),
    blk('discipline-classic', '回合纪律块 · 经典', 'roleplay.ts buildTurnDisciplineBlock()', buildTurnDisciplineBlock('zh', 'classic', false)),
    blk('length-im', '篇幅硬要求 · 沉浸', 'roleplay.ts buildLengthDirective()', buildLengthDirective('zh', 'immersive')),
    blk('length-cl', '篇幅硬要求 · 经典', 'roleplay.ts buildLengthDirective()', buildLengthDirective('zh', 'classic')),
    blk('punct', '标点硬要求', 'roleplay.ts buildPunctuationDirective()', buildPunctuationDirective('zh')),
    blk('quotes', '引号规范', 'dialogueQuotes.ts quoteRuleBlock()', quoteRuleBlock('zh')),
    blk('plain', '纯文本格式指令', 'prompts.ts buildPlainTextDirective()', buildPlainTextDirective('zh-CN')),
    blk('person', '用户角色人称指令', 'prompts.ts buildUserPersonDirective()', buildUserPersonDirective('zh-CN', sample('阿宁'))),
    blk('adult', '成人模式独立块（🔞 敏感，仅无限制模式注入）', 'roleplay.ts buildUnlimitedModeBlock()', buildUnlimitedModeBlock('zh', 'immersive'), 'sensitive', '是否注入由 18+ 确认 + 用户偏好 + 剧本默认共同决定（unlimitedForScenario）'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'roleplay',
    name: '剧情扮演（官方剧本）',
    icon: '🎭',
    group: 'story',
    desc: '沉浸式角色扮演：剧本人设 + 写作规则 + 篇幅/标点/引号 + 回合纪律 + 任务指令（+ 成人块）',
    entry: 'api/services/roleplay.ts composeRoleplaySystem() ← buildSystemPrompt() + roleplayTaskInstr()',
    feature: 'roleplay',
    options: {
      key: 'scenario',
      label: '剧本',
      values: SCENARIOS.map((s) => ({ value: s.id, label: s.zh.title })),
    },
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all) + ':' + scenario.id,
    notes: [
      '每个剧本各自不同：上面按所选剧本渲染（默认第一个）；换剧本请用下拉。',
      '完整 system 的顺序（composeRoleplaySystem）：剧本骨架 → 括号开关 → 安全边界 → [成人块] → 任务指令 → 回合纪律 → 用户偏好 → 本轮禁止复现。',
      '规则正文（沉浸 V2 / 经典）与括号开关块内联在 roleplay.ts，已包含在「完整 system」里。',
    ],
    variants,
    blockList,
  };
}

function buildRoleplayCustomMode(langs: RPLang[]): PromptMode {
  const useLangs = langs.length ? langs : ALL_LANGS;
  const variants = useLangs.map((lang) => {
    const rules = pickRulesText('immersive', lang, sample('阿宁'), false);
    return variant('sys-' + lang, `自建剧本 system · ${LANG_LABEL[lang]}`, buildCustomScenarioSystem(SAMPLE_CUSTOM, lang, rules));
  });
  const blockList: PromptBlock[] = [
    blk('rules-zh', '写作与交互要求（沉浸·规则正文）', 'roleplay.ts pickRulesText()', pickRulesText('immersive', 'zh', sample('阿宁'), false), 'sample', '含规则正文 + 篇幅 + 标点 + 引号 + 纯文本 + 人称五段'),
    blk('gap', '与官方剧本的差别', 'roleplay.ts roleplayReplyCustom()', '自建剧本没有「用户扮演的角色」段（官方剧本有），且会额外注入字体指令 langHint；其余块与官方剧本同一套。', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'roleplay-custom',
    name: '剧情扮演（自建剧本）',
    icon: '✍️',
    group: 'story',
    desc: '用户自建剧本开演时的 system：人设/背景/开场 + 同一套写作规则',
    entry: 'api/services/roleplay.ts roleplayReplyCustom() → buildCustomScenarioSystem()',
    feature: 'roleplay',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['用示例剧本（沈清言/心外科医生）渲染；真实文本来自用户填写的 aiPersona / background / opening。'],
    variants,
    blockList,
  };
}

function buildRoleplayDraftMode(langs: RPLang[]): PromptMode {
  const useLangs = langs.length ? langs : ALL_LANGS;
  const variants = useLangs.map((lang) => variant('draft-' + lang, `AI 建剧 system · ${LANG_LABEL[lang]}`, buildDraftSystemPrompt(lang)));
  const reviseVariants = useLangs.map((lang) => variant('revise-' + lang, `AI 改稿 system · ${LANG_LABEL[lang]}`, buildReviseSystemPrompt(lang, SAMPLE_CUSTOM)));
  const blockList: PromptBlock[] = [
    blk('user-block', '用户输入块（灵感/要求）', 'roleplay.ts roleplayDraftCustom() / roleplayReviseCustom()', '【玩家灵感 / 剧本】<用户原文>   ／   【修改要求】<用户原文>', 'gap', '用户原文直接拼在 user 消息里（input 侧），不在 system 内'),
    blk('retry', '格式重试追加句', 'roleplay.ts DRAFT_MAX_ATTEMPTS 循环', '【重要】上一次输出不是合法 JSON 或缺少字段。请只输出一个 JSON 对象，五个字段全部填满，不要任何解释与 markdown 围栏，不要中途截断。'),
    blk('limit', '输出上限与思考档', 'roleplay.ts DRAFT_MAX_TOKENS / thinkingLevel: off', 'maxTokens=8192、thinkingLevel=off（原因见代码注释：思考会吃光 JSON 预算导致空输出）', 'static'),
  ];
  const variantsAll = variants.concat(reviseVariants);
  const all = variantsAll.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'roleplay-authoring',
    name: 'AI 建剧 / AI 改稿',
    icon: '🪄',
    group: 'story',
    desc: '运营与用户都能看到的「五个字段」任务书：AI 帮写剧本、AI 按修改要求改稿',
    entry: 'api/services/roleplay.ts roleplayDraftCustom() / roleplayReviseCustom()',
    feature: 'roleplay',
    blockCount: blockList.length,
    variantCount: variantsAll.length,
    chars: all.length,
    hash: hashOf(all),
    notes: [
      '这两个提示词是「内容安全的下游关卡」：命中禁项时任务书要求模型输出五个空字段，路由据此判 CONTENT_REJECTED。',
      '用户当时的输入（灵感/修改要求）会另行留档，见控制台「用户记录」里的「🪄 AI 建剧提示词」。',
    ],
    variants: variantsAll,
    blockList,
  };
}

function buildRoleplaySuggestMode(langs: RPLang[]): PromptMode {
  const useLangs = langs.length ? langs : ALL_LANGS;
  const scenario = SCENARIOS[0];
  const variants = useLangs.map((lang) => {
    const t = scenario[lang === 'en' ? 'en' : 'zh'];
    return variant('suggest-' + lang, `候选建议 system · ${LANG_LABEL[lang]}`, buildSuggestSystemPrompt({
      lang,
      aiName: t.ai.name,
      aiDesc: t.ai.personality,
      userName: t.user.name,
      userDesc: t.user.personality,
      background: t.background,
      opening: t.openingScene,
      rules: pickRulesText('immersive', lang, sample('阿宁'), false),
    }));
  });
  const blockList: PromptBlock[] = [
    blk('gap', '说明', 'roleplay.ts buildSuggestSystemPrompt()', '候选建议只给「以玩家身份可以怎么接」的几个方向，不进正文；用示例剧本渲染。', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'roleplay-suggest',
    name: '剧情候选建议',
    icon: '💡',
    group: 'story',
    desc: '每轮给玩家的「可以怎么接」建议（JSON 输出）',
    entry: 'api/services/roleplay.ts buildSuggestSystemPrompt()（roleplaySuggestions / roleplaySuggestionsCustom）',
    feature: 'roleplay',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: [],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 4. AI 文游（千世书）
// ---------------------------------------------------------------------------

function buildTextgameMode(langs: RPLang[]): PromptMode {
  const keys = langs.length ? langs.map((l) => (l === 'zh' ? 'zh-CN' : l)) : ['zh-CN', 'zh-TW', 'en'];
  const variants: PromptVariant[] = [];
  for (const k of keys) {
    const gm = textgameGmBase(k) + textgameLangDirective(k);
    variants.push(variant('sys-' + k, `真实 system（gmBase + langDirective） · ${LANG_LABEL[k === 'zh-CN' ? 'zh' : k]}`, gm));
    variants.push(variant('tail-stream-' + k, `追加在最后一条用户消息尾部 · 流式 · ${k}`, textgameLangDirective(k) + textgameJsonDirective(true, true)));
    variants.push(variant('tail-json-' + k, `追加在最后一条用户消息尾部 · 单 JSON · ${k}`, textgameLangDirective(k) + textgameJsonDirective(true, false)));
  }
  const blockList: PromptBlock[] = [
    blk('gm-zh', 'GM 底色人设 · 简中', 'textgamePrompts.ts textgameGmBase()', textgameGmBase('zh-CN')),
    blk('gm-tw', 'GM 底色人设 · 繁中', 'textgamePrompts.ts textgameGmBase()', textgameGmBase('zh-TW')),
    blk('gm-en', 'GM 底色人设 · 英文', 'textgamePrompts.ts textgameGmBase()', textgameGmBase('en')),
    blk('lang-zh', '输出语言硬要求 · 简中', 'textgamePrompts.ts textgameLangDirective()', textgameLangDirective('zh-CN')),
    blk('lang-tw', '输出语言硬要求 · 繁中', 'textgamePrompts.ts textgameLangDirective()', textgameLangDirective('zh-TW')),
    blk('lang-en', '输出语言硬要求 · 英文', 'textgamePrompts.ts textgameLangDirective()', textgameLangDirective('en')),
    blk('json-stream', '输出格式 · 流式（正文先行 + 尾部 JSON）', 'textgamePrompts.ts textgameJsonDirective()', textgameJsonDirective(true, true)),
    blk('json-single', '输出格式 · 单 JSON', 'textgamePrompts.ts textgameJsonDirective()', textgameJsonDirective(true, false)),
    blk('repair', 'JSON 纠错重试追加句（仅简中·已发现的缺口）', 'api/routes/textgame.ts POST /chat 纠正分支', '你上一条输出格式不对：没有完整的 JSON 对象……（该追加句目前只有简中版本，en/zh-TW 用户同样会看到——与 jsonDirective 同一处缺口）', 'gap'),
    blk('host', '剧本主持词（systemPrompt）在哪', 'src/wenyou/engine/prompt.ts buildTurnMessages()', '剧本自带的 systemPrompt + 属性说明 + 格式契约，由前端拼好后**作为第一条 user 消息**发上来（客户端会把 system 拍平成 user，路由也会丢弃 system 角色消息）——所以不在服务端 system 里。', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'textgame',
    name: 'AI 文游（千世书）',
    icon: '📜',
    group: 'story',
    desc: '文字人生模拟的每回合提示词：GM 底色 + 输出语言硬要求 + 输出格式硬要求',
    entry: 'api/routes/textgame.ts POST /chat（片段来自 api/services/textgamePrompts.ts）',
    feature: 'wenyou',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['⚠️ 已发现的缺口：jsonDirective 与 JSON 纠错句只有简中版本，却被追加给 en/zh-TW 用户。'],
    variants,
    blockList,
  };
}

const SAMPLE_SKELETON = {
  title: sample('小城药铺'),
  intro: sample('你在城南的药铺里长大，柜台上那盏灯三十年没灭过。'),
  attributes: [
    { key: 'hp', name: '体魄', initial: 70, max: 100, deathBelow: 0, bands: [{ upTo: 30, label: '虚弱', severity: 'critical' }] },
    { key: 'favor', name: '声望', initial: 30, max: 100, bands: [{ upTo: 60, label: '寻常', severity: 'normal' }] },
  ],
  openings: [{ name: sample('学徒'), prompt: sample('你刚被收进药铺做学徒。') }],
  ambitions: [sample('把药铺开成城里最好的一家')],
  turnUnit: '年',
  maxTurns: 25,
  systemPrompt: sample('你是一间小城药铺的掌柜，讲规矩也讲人情。'),
  endings: [{ condition: 'hp<=0', tone: sample('灯灭了') }],
};

function buildTextgameGenerateMode(langs: RPLang[]): PromptMode {
  const keys = langs.length ? langs.map((l) => (l === 'zh' ? 'zh-CN' : l)) : ['zh-CN', 'en'];
  const variants: PromptVariant[] = [];
  for (const k of keys) {
    const sk = skeletonPrompt(sample('民国小城的一间药铺'), k as any);
    variants.push(variant('skeleton-' + k, `① 剧本骨架生成 · ${k}`, sk.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')));
    const ev = eventsPrompt(sample('民国小城的一间药铺'), SAMPLE_SKELETON as any, [sample('你已经收下第一个学徒')], 20, k as any, 0, 3);
    variants.push(variant('events-' + k, `② 支线事件池生成 · ${k}`, ev.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')));
  }
  const blockList: PromptBlock[] = [
    blk('grammar-zh', '条件语法片段（简中）', 'scenarioGenerator.ts CONDITION_GRAMMAR', '条件语法（严格）：只能用 "属性key<=数字"、"属性key>=数字"、或字面量 "maxTurns"；多个子句用 " & " 连接……', 'gap', '该常量未导出，此处给的是首句摘录；完整文本见源码该行'),
    blk('focus', '并发批次取材面（错开撞名）', 'scenarioGenerator.ts BATCH_FOCUS_ZH / _EN', '机遇与成长 / 危机与风险 / 人际与情感 / 外部世界与变故 / 内心与抉择 / 日常与细节（中英各 6 条）', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'textgame-generate',
    name: 'AI 文游 · 生成剧本',
    icon: '🧱',
    group: 'story',
    desc: '「AI 生成剧本」两步：先出骨架（属性/结局/世界观），再批量出支线事件池',
    entry: 'api/services/scenarioGenerator.ts skeletonPrompt() / eventsPrompt()（generateScenario 调用）',
    feature: 'wenyou',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['骨架/事件池用示例主题与示例骨架渲染；真实生成时主题来自用户输入，属性与结局由第一步产出。'],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 5. AI 狼人杀
// ---------------------------------------------------------------------------

function buildWerewolfMode(langs: RPLang[]): PromptMode {
  const useLangs = langs.length ? langs : ALL_LANGS;
  const p = BUILTIN_PLAYERS[0];
  const persona = { seat: 3, name: p.name, builtinPersona: { identity: p.identity, voice: p.voice } };
  const variants: PromptVariant[] = [];
  for (const lang of useLangs) {
    for (const role of ['villager', 'werewolf'] as const) {
      variants.push(variant(`${lang}-${role}`, `AI 玩家 system · ${LANG_LABEL[lang]} · ${role === 'werewolf' ? '狼人' : '平民'}（9 人局）`, buildWerewolfSystemPrompt(persona as any, role as any, 9, lang as any)));
    }
  }
  const blockList: PromptBlock[] = [
    blk('user-prompt', '本轮 user 块（局面/私有信息/任务/输出契约）', 'src/werewolf/ai/prompt.ts buildUserPrompt()', '【牌桌】…（座位与存活）\n【只有你知道】…\n【场上已经发生的】…\n【本轮任务】…\n【输出】{…}', 'gap', '由 buildUserPrompt 按真实局势拼装（含视角过滤），无法用静态示例代表，故只给结构；函数已导出可直接调试。'),
    blk('players', '内置陪玩人设（8 位）', 'src/werewolf/ai/prompt.ts BUILTIN_PLAYERS', BUILTIN_PLAYERS.map((x) => `${x.name}：${x.identity}\n  口吻：${x.voice}`).join('\n')),
    blk('wolfcha', '狼人杀移植版（wolfcha 子应用）的注入提示词', 'api/routes/wolfchaCompat.ts POST /chat', 'You must reply with ONE valid JSON object only…（JSON schema 注入）\n\nReply with one valid JSON object only. 只输出一个合法的 JSON 对象。', 'gap', '走 raw fetch 转发（不是 generateContent），提示词内联在路由里；真实游戏提示词由前端 src/wolfcha 提供'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'werewolf',
    name: 'AI 狼人杀',
    icon: '🐺',
    group: 'story',
    desc: '每个 AI 玩家的 system：人格 + 身份 + 公平性护栏 + 沉浸纪律 + 输出契约',
    entry: 'src/werewolf/ai/prompt.ts buildSystemPrompt()/buildAgentMessages ← api/services/werewolf.ts runAiActor()',
    feature: 'werewolf',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['用内置陪玩「' + p.name + '」渲染；真实对局里 persona 可能来自用户的聊一聊角色（含记忆与关系）。'],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 6. 后台链路：记忆 / 成长 / 今日小事
// ---------------------------------------------------------------------------

function buildMemoryMode(): PromptMode {
  const np = nowParts();
  const variants: PromptVariant[] = [
    variant('extract', '长期记忆·事实提取（每轮用户消息后异步跑一次）', buildMemoryExtractPrompt(np, '小愈', sample('- [状态·3 天前（2026-09-23）] 用户在准备一场面试'), sample('我下周三要去面试了，有点怕'))),
    variant('growth', '角色成长沉淀（每 6 轮一次：关系记忆/反思/日记）', buildGrowthTickPrompt('小愈', [sample('用户在做产品经理')], [sample('你们聊过芒市那家米线店')], sample('用户：今天好累 ／ 小愈：先躺会儿，我不走'), false)),
    variant('growth-portrait', '角色成长沉淀 · 含自画像（每 3 次反思一次）', buildGrowthTickPrompt('小愈', [sample('用户在做产品经理')], [sample('你们聊过芒市那家米线店')], sample('用户：今天好累 ／ 小愈：先躺会儿，我不走'), true)),
  ];
  const blockList: PromptBlock[] = [
    blk('daily-life-block', '今日小事·注入块（示例）', 'chatDailyLife.ts buildDailyLifeBlock()', buildDailyLifeBlock(fallbackItems('2026-09-26', 'zh', 6).map((t) => ({ text: t })) as any, 'zh'), 'sample'),
    blk('daily-life-gen', '今日小事·生成提示词（后台每日一次）', 'chatDailyLife.ts ensureDailyLife() 内联', '（内联在函数里、未导出：你是"<角色名>"——一个有自己的日子的陪伴者…… 要做成「可查看」需要把该字面量抽成导出 builder）', 'gap'),
    blk('story-bridge', '剧情出身角色的人设块（聊一聊里用）', 'storyBridge.ts storyPromptBlock()/composeStory*()', '（这些块按剧情档案动态拼装，且目前**只有简中**；要查看请在「用户记录」里看具体角色）', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'memory',
    name: '长期记忆与角色成长（后台）',
    icon: '🧠',
    group: 'memory',
    desc: '不直接面对用户、但决定模型「记得什么」的后台链路',
    entry: 'api/services/gemini.ts extractMemoryFacts() / runCharacterGrowthTick()（chat 回复后异步触发）',
    feature: 'memory',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['这些调用真实花钱（feature=memory），但用户看不见。'],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 7. 运营与后台文案
// ---------------------------------------------------------------------------

const SAMPLE_CAND: Candidate = {
  userId: 'sample',
  email: 'sample@example.com',
  channel: 'push',
  feature: 'chat',
  intent: 'winback' as any,
  contextRef: sample('上周聊到加班到很晚'),
  recentText: sample('用户：最近老是加班 ／ 小愈：那你今晚几点能到家？'),
  deepLink: 'https://myxiaoyu.com/',
  senderName: '小愈',
  nickname: sample('阿宁'),
  subjectKey: 'chat::xiaoyu',
  targetId: 'xiaoyu',
  newsTopics: [sample('今天的热搜话题')],
};

function buildOpsMode(): PromptMode {
  const variants: PromptVariant[] = [
    variant('announce', '公告草稿（三语一次产出）', buildAnnouncementPrompt(sample('上线新皮肤「奶咖」，会员可用'))),
    variant('ig-image', 'Instagram 文案 · 单图', buildInstagramPrompt({ topic: sample('深夜睡不着的时候，有人陪着'), type: 'image' })),
    variant('ig-carousel', 'Instagram 文案 · 轮播', buildInstagramPrompt({ topic: sample('五种把情绪说出来的方式'), type: 'carousel' })),
    variant('analyst', '控制台「AI 分析」商业分析 system', AI_ANALYST_SYSTEM_PROMPT),
  ];
  for (const feature of ['chat', 'structure', 'roleplay', 'wenyou'] as EngagementFeature[]) {
    for (const lang of ALL_LANGS) {
      variants.push(variant(`hook-${feature}-${lang}`, `主动召回文案 · ${feature} · ${LANG_LABEL[lang]}`, buildHookPrompt(feature, { ...SAMPLE_CAND, feature } as Candidate, lang as any)));
    }
  }
  const blockList: PromptBlock[] = [
    blk('analyst-user', 'AI 分析 user 块', 'api/routes/paymentAdmin.ts POST /ai-summary', '【运营数据 JSON】{…}（把控制台聚合数据塞给模型）'),
    blk('hook-system', '主动召回 system 行', 'reengage.ts generateHook() 内联', `你是一名为情感陪伴 App 写主动联系消息的文案助手。基调是「陪伴/召回」，绝不虚构、绝不夸大、绝不涉及任何诊疗承诺。<语言要求>`, 'gap', '内联未导出；语言要求由 LANG_NOTE 按用户语言追加'),
    blk('gap', '召回静态兜底（不是提示词）', 'reengage.ts fallbackHook()', '（模型失败时直接发三语静态文案：有些话还没说完 / 有些话还停在昨天…）', 'gap'),
  ];
  const all = variants.map((v) => v.text).concat(blockList.map((b) => b.text)).join('\u0000');
  return {
    id: 'ops',
    name: '运营与后台文案',
    icon: '📣',
    group: 'ops',
    desc: '公告、Instagram、控制台 AI 分析、流失召回文案',
    entry: 'gemini.ts buildAnnouncementPrompt / buildInstagramPrompt · adminAnalytics.ts AI_ANALYST_SYSTEM_PROMPT · reengage.ts buildHookPrompt',
    blockCount: blockList.length,
    variantCount: variants.length,
    chars: all.length,
    hash: hashOf(all),
    notes: ['这些调用的成本归属是 internal / reengage（见控制台「总览 → API 成本构成」）。'],
    variants,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 8. 共用块库（被多个模式引用）
// ---------------------------------------------------------------------------

function buildSharedMode(): PromptMode {
  const blockList: PromptBlock[] = [
    blk('persona', '小愈人设 PERSONA（所有陪伴链路的地基）', 'prompts.ts PERSONA', PERSONA),
    blk('humanize', '去 AI 腔 HUMANIZE_RULES', 'prompts.ts HUMANIZE_RULES', HUMANIZE_RULES),
    blk('brand', '品牌语气 BRAND_TONE', 'prompts.ts BRAND_TONE', BRAND_TONE),
    blk('stance', '陪伴倾向判断 COMPANION_STANCE', 'companionStance.ts COMPANION_STANCE', COMPANION_STANCE),
    blk('nometa', '禁把方法说出口 NO_META_NARRATION_RULE', 'companionStance.ts NO_META_NARRATION_RULE', NO_META_NARRATION_RULE),
    blk('method', '理解与陪伴框架 METHODOLOGY_SELECTOR', 'prompts.ts METHODOLOGY_SELECTOR', METHODOLOGY_SELECTOR),
    blk('safety-tone', '高危降风格 SAFETY_TONE（命中自伤词时注入）', 'prompts.ts SAFETY_TONE', SAFETY_TONE),
    blk('injection', '安全边界 INJECTION_BOUNDARY（反注入）', 'prompts.ts INJECTION_BOUNDARY', INJECTION_BOUNDARY),
    blk('abstract', '故事风格·抽象搞笑 STORY_STYLE_ABSTRACT', 'prompts.ts STORY_STYLE_ABSTRACT', STORY_STYLE_ABSTRACT),
    ...Object.keys(REGION_CARDS).map((k) => blk('region-' + k, `地区语气卡 · ${k}`, 'prompts.ts REGION_CARDS', REGION_CARDS[k])),
    ...Object.keys(INTENSITY_MAP).map((k) => blk('intensity-' + k, `语气程度 · ${k}`, 'prompts.ts INTENSITY_MAP', INTENSITY_MAP[k])),
    ...Object.keys(REGION_CARDS_EN).map((k) => blk('region-en-' + k, `地区语气卡（英文） · ${k}`, 'prompts.ts REGION_CARDS_EN', REGION_CARDS_EN[k])),
    ...Object.keys(INTENSITY_MAP_EN).map((k) => blk('intensity-en-' + k, `语气程度（英文） · ${k}`, 'prompts.ts INTENSITY_MAP_EN', INTENSITY_MAP_EN[k])),
    ...Object.keys(LANGUAGE_REQUIREMENT).map((k) => blk('lang-' + k, `输出语言映射 · ${k}`, 'prompts.ts LANGUAGE_REQUIREMENT', LANGUAGE_REQUIREMENT[k])),
    ...Object.keys(CONTENT_GUIDE).map((k) => {
      const g = CONTENT_GUIDE[k as OutputLang];
      return blk('guide-' + k, `内容降级引导 · ${k}`, 'prompts.ts CONTENT_GUIDE', `【危机】${g.crisis}\n\n【边界】${g.boundary}`, 'sensitive');
    }),
    ...Object.keys(CHAT_REDIRECT_GUIDE).map((k) => {
      const g = CHAT_REDIRECT_GUIDE[k as OutputLang];
      return blk('redirect-' + k, `分流引导（聊一聊遇到越界话题时） · ${k}`, 'prompts.ts CHAT_REDIRECT_GUIDE', Object.keys(g).map((kind) => `【${kind}】${(g as any)[kind]}`).join('\n\n'), 'sensitive');
    }),
    blk('plain', '纯文本格式指令（剧情用）', 'prompts.ts buildPlainTextDirective()', buildPlainTextDirective('zh-CN')),
    blk('person', '用户角色人称指令（剧情用）', 'prompts.ts buildUserPersonDirective()', buildUserPersonDirective('zh-CN', sample('阿宁'))),
    blk('script', '输出字体指令', 'prompts.ts buildOutputScriptDirective()', buildOutputScriptDirective('zh-CN') + '\n\n---\n\n' + buildOutputScriptDirective('zh-TW') + '\n\n---\n\n' + buildOutputScriptDirective('en')),
  ];
  const all = blockList.map((b) => b.text).join('\u0000');
  return {
    id: 'shared',
    name: '共用块库',
    icon: '🧩',
    group: 'shared',
    desc: '被多个模式引用的公共提示词：人设、去 AI 腔、品牌语气、地区语气、安全与引导、格式指令',
    entry: 'api/services/prompts.ts · companionStance.ts · dialogueQuotes.ts · narrativeStyle.ts',
    blockCount: blockList.length,
    variantCount: 0,
    chars: all.length,
    hash: hashOf(all),
    notes: ['同一个块常被多条链路引用；改这里的文案会同时影响所有引用它的模式。'],
    variants: [],
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 9. 出图类（不是 LLM system prompt，但也是「提示词」）
// ---------------------------------------------------------------------------

function buildImageMode(): PromptMode {
  const blockList: PromptBlock[] = [
    blk('positive', '正向守卫词 POSITIVE_GUARD', 'imageApi.ts POSITIVE_GUARD', 'empty scene without people, no text or lettering, no watermark'),
    blk('scene', '剧情按需出图的场景 prompt 表', 'src/lib/storyScene.js scenePrompt() / SCENE_NEGATIVE_PROMPT', '（表在 src 侧，含主题 → 画面 prompt 与负向词；运营侧入口是剧情里「这一刻」的出图）', 'gap'),
    blk('skin-anchor', '皮肤生成·风格锚点（LLM 扩写）', 'skinGenerator.ts expandStyleAnchorWithLLM() 内联', '你是「小愈」情绪陪伴产品的资深视觉设计师。请基于用户给的主题……（内联未导出）', 'gap'),
    blk('skin-slot', '皮肤生成·21 槽位出图 prompt', 'skinGenerator.ts buildSlotPrompt() 内联', 'A refined, high-quality illustration with depth…（内联未导出；控制台「皮肤生成」页可预览 dryRun 结果）', 'gap'),
  ];
  const all = blockList.map((b) => b.text).join('\u0000');
  return {
    id: 'image',
    name: '出图类提示词',
    icon: '🎨',
    group: 'shared',
    desc: '皮肤生成与剧情场景图用的图像 prompt（不走 LLM system）',
    entry: 'api/services/imageApi.ts · skinGenerator.ts · src/lib/storyScene.js',
    blockCount: blockList.length,
    variantCount: 0,
    chars: all.length,
    hash: hashOf(all),
    notes: ['这一组只做「在哪、是什么」的索引：图像 prompt 的控制台预览入口分别是「皮肤生成」页与剧情出图链路。'],
    variants: [],
    blockList,
  };
}

// ---------------------------------------------------------------------------
// 出口
// ---------------------------------------------------------------------------

const GROUPS: { id: string; name: string; desc: string }[] = [
  { id: 'companion', name: '陪伴（C 端）', desc: '聊一聊 / 理一理' },
  { id: 'story', name: '剧情与文游', desc: '剧情扮演 / 自建剧本 / AI 建剧 / 文游 / 狼人杀' },
  { id: 'memory', name: '记忆与成长（后台）', desc: '长期记忆、角色成长、今日小事' },
  { id: 'ops', name: '运营与后台文案', desc: '公告 / Instagram / AI 分析 / 召回文案' },
  { id: 'shared', name: '共用块库与出图', desc: '公共提示词与图像 prompt 索引' },
];

/** 建立单个模式（内部按 id 分发；参数只影响示例渲染） */
export async function buildPromptMode(
  id: string,
  opts: { lang?: RPLang; scenarioId?: string; style?: RoleplayNarrativeStyle } = {},
): Promise<PromptMode | null> {
  // 不给 lang 就渲染全部三语（给了就只渲染那一种，减少返回体积）
  const langs = opts.lang ? [opts.lang] : ALL_LANGS;
  switch (id) {
    case 'chat': return buildChatMode(langs);
    case 'structure': return buildStructureMode(langs);
    case 'roleplay': return buildRoleplayMode(opts);
    case 'roleplay-custom': return buildRoleplayCustomMode(langs);
    case 'roleplay-authoring': return buildRoleplayDraftMode(langs);
    case 'roleplay-suggest': return buildRoleplaySuggestMode(langs);
    case 'textgame': return buildTextgameMode(langs);
    case 'textgame-generate': return buildTextgameGenerateMode(langs);
    case 'werewolf': return buildWerewolfMode(langs);
    case 'memory': return buildMemoryMode();
    case 'ops': return buildOpsMode();
    case 'shared': return buildSharedMode();
    case 'image': return buildImageMode();
    default: return null;
  }
}

/** 模式清单（含每个模式的字数与指纹；不含正文） */
export async function promptCatalogIndex(): Promise<PromptCatalogIndex> {
  const modes = await Promise.all(PROMPT_MODE_MANIFEST.map((m) => buildPromptMode(m.id)));
  const metas: PromptModeMeta[] = [];
  for (const m of modes) {
    if (!m) continue;
    metas.push({
      id: m.id, name: m.name, icon: m.icon, group: m.group, desc: m.desc, entry: m.entry,
      ...(m.feature ? { feature: m.feature } : {}),
      ...(m.options ? { options: m.options } : {}),
      blockCount: m.blockCount, variantCount: m.variantCount, chars: m.chars, hash: m.hash,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    version: PROMPT_CATALOG_VERSION,
    groups: GROUPS,
    modes: metas,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.zh.title })),
    totals: {
      modes: metas.length,
      chars: metas.reduce((n, m) => n + m.chars, 0),
    },
    notes: [
      '全部文本都从**真实调用点同源的**常量/builder 读出（不是另一份拷贝），所以这里看到的即线上模型收到的。',
      '标 gap 的条目是「取不到/需人工看代码」的位置，已如实标注函数与文件，不做近似。',
      '含成人向与情欲引导原文：仅 ADMIN_TOKEN 可访问，请勿外传或截图。',
    ],
  };
}

/** 左侧列表用的模式清单（顺序即展示顺序） */
export const PROMPT_MODE_MANIFEST: { id: string; name: string; icon: string }[] = [
  { id: 'chat', name: '聊一聊', icon: '💬' },
  { id: 'structure', name: '理一理', icon: '🧭' },
  { id: 'roleplay', name: '剧情扮演', icon: '🎭' },
  { id: 'roleplay-custom', name: '自建剧本', icon: '✍️' },
  { id: 'roleplay-authoring', name: 'AI 建剧 / 改稿', icon: '🪄' },
  { id: 'roleplay-suggest', name: '剧情候选建议', icon: '💡' },
  { id: 'textgame', name: 'AI 文游', icon: '📜' },
  { id: 'textgame-generate', name: 'AI 文游·生成剧本', icon: '🧱' },
  { id: 'werewolf', name: 'AI 狼人杀', icon: '🐺' },
  { id: 'memory', name: '记忆与成长', icon: '🧠' },
  { id: 'ops', name: '运营与后台文案', icon: '📣' },
  { id: 'shared', name: '共用块库', icon: '🧩' },
  { id: 'image', name: '出图类提示词', icon: '🎨' },
];
