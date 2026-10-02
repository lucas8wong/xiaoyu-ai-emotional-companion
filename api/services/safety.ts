/**
 * 内容安全过滤（关键词 + 规则拦截）
 * 用于自建剧本等内容：拦截 违规 / 危害人身安全 / 诱导自伤 等危险内容。
 * 命中即拒（Phase 1 先紧后松；后续可按举报数据逐步放宽/分层）。
 *
 * P1-06（2026-08-25 加固）：
 * - 匹配前归一化：繁→简（toZhSimple）+ 去空格（含全角）+ 小写 → 解决繁体整类绕过与「自 杀」拆字
 * - 词表扩充：谐音（紫砂/紫杀）、拼音（zisha）、英文俚语（kms/unalive/self-delete/sewerslide）、
 *   高危自伤词（想死/不想活/活不下去），自伤词与 prompts.ts DISTRESS_PATTERNS 共用
 *   单一来源 SELF_HARM_KEYWORDS，消除「检测到了但没拦截」的两表不一致
 * - 说明：关键词方案为启发式兜底（谐音变体仍可能绕过，如「紫砂」与紫砂壶的歧义属已知取舍），
 *   后续应叠加模型审核（见 CODE_REVIEW P2-4）
 *
 * P1-08（本窗口重构 / DRY）：
 * - 抽出 hasForbiddenPatterns 单一匹配入口，checkContentSafety / checkAiOutputSafety / isSelfHarmContent
 *   复用同一套「原始小写 + 归一化」匹配逻辑，去掉三处重复的 for 循环
 * - 自伤/自杀中文正则预编译为模块级常量（SELF_HARM_NORM_RE），避免每次调用重复 new RegExp
 * - isSelfHarmContent 与 checkContentSafety 的**自伤/自杀检测对齐**（补英文短语 self-harm / suicide /
 *   kill yourself / overdose 等），避免「内容已被拦截、但危机引导类型却没识别」的不一致
 */

import { toZhSimple } from './zhConvert.js';

/** 高危自伤/自杀关键词（safety 拦截 与 prompts.ts DISTRESS_PATTERNS 共用单一来源，P1-06） */
export const SELF_HARM_KEYWORDS = '自杀|自残|自伤|自戕|轻生|寻死|割腕|割脉|跳楼|跳河|上吊|服毒|过量服药|伤害自己|结束自己|了结自己|自我了断|想死|不想活|活不下去';

/** 预编译的自伤/自杀中文正则（P1-08：避免每次调用重复 new RegExp） */
const SELF_HARM_NORM_RE = new RegExp(SELF_HARM_KEYWORDS, 'i');

/** 中文/拼音规则：在「归一化文本」（繁→简、去空格、小写）上匹配 */
const FORBIDDEN_NORM: RegExp[] = [
  // 【自伤 / 自杀（含谐音/拼音；繁体经归一化处理）】
  SELF_HARM_NORM_RE,
  /紫砂|紫杀/,                              // 谐音
  /zisha/,                                  // 拼音
  /kill(yourself|myself|oneself)|selfharm/, // 英文无空格变体
  // 【暴力 / 谋杀 / 伤害他人】
  /谋杀|凶杀|虐杀|虐打|虐待|分尸|碎尸|肢解|残害|血腥|砍死|捅死|致残|殴打致死/i,
  // 【性犯罪 / 未成年】
  /性侵|强奸|轮奸|猥亵|恋童|幼女|儿童色情|未成年.{0,6}性/i,
  // 【毒品 / 危害公共安全】
  /吸毒|贩毒|制毒|毒品|冰毒|海洛因|摇头丸|爆炸物|炸弹|恐怖袭击/i,
  // 【教唆 / 诱导危险行为】
  /教唆.{0,4}(自杀|自残|自伤|犯罪|暴力|吸毒)|诱导.{0,4}(自杀|自残|自伤|伤害|犯罪)/i,
];

/** 英文规则：在「原始小写文本」上匹配（保留空格，避免拆词破坏 kill yourself 等短语匹配） */
const FORBIDDEN_RAW: RegExp[] = [
  /suicide|self[- ]?harm|kill (yourself|myself|oneself)|cut (yourself|myself)|hang (yourself|myself)|overdose|end (my|your) life|kms|unalive|self-delete|sewerslide/i,
  /murder|massacre|mutilat|dismember|gore|rape|pedophil|child porn|underage.{0,6}sex|terrori|bomb/i,
];

export interface SafetyResult {
  safe: boolean;
  reason: string;
}

/** 归一化：繁→简、去空格（含全角）、小写（P1-06） */
function normalize(text: string): string {
  return toZhSimple(text || '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/**
 * 匹配一组「原始小写 / 归一化」正则（单一匹配入口，P1-08）。
 * - raw 正则在原始小写文本上匹配，用于保留空格的英文短语（如 kill yourself）
 * - norm 正则在归一化文本上匹配：用于繁体/拆字/拼音/谐音（如 自殺、自 杀、zisha、紫砂）
 */
function hasForbiddenPatterns(text: string, raw: RegExp[], norm: RegExp[]): boolean {
  const rawText = (text || '').toLowerCase();
  const normText = normalize(rawText);
  for (const re of raw) if (re.test(rawText)) return true;
  for (const re of norm) if (re.test(normText)) return true;
  return false;
}

/** 检查一段文本是否包含被禁止的内容 */
export function checkContentSafety(text: string): SafetyResult {
  return hasForbiddenPatterns(text, FORBIDDEN_RAW, FORBIDDEN_NORM)
    ? { safe: false, reason: 'content_violation' }
    : { safe: true, reason: '' };
}

/** 检查自建剧本各字段（合并后一次过滤） */
export function checkCustomScenario(fields: { title?: string; aiName?: string; aiPersona?: string; background?: string; opening?: string }): SafetyResult {
  const combined = [fields.title, fields.aiName, fields.aiPersona, fields.background, fields.opening]
    .filter((x) => typeof x === 'string' && x.trim().length > 0)
    .join('\n');
  return checkContentSafety(combined);
}

/** 自伤/自杀变体（谐音/拼音/英文俚语/无空格），用于危机引导类型判定 */
const SELF_HARM_VARIANTS = /紫砂|紫杀|zisha|kms|unalive|self-delete|sewerslide|killyourself|selfharm/i;

/** 英文自伤/自杀短语（在原始小写文本上匹配，保留空格），与 FORBIDDEN_RAW 的自伤子集对齐（P1-08） */
const SELF_HARM_RAW_RE = /suicide|self[- ]?harm|kill (yourself|myself|oneself)|cut (yourself|myself)|hang (yourself|myself)|overdose|end (my|your) life|kms|unalive|self-delete|sewerslide/i;

/** 是否自伤/自杀类内容（归一化命中中文关键词/变体，或英文原文命中自伤短语；用于选择降级引导类型，P1-07/P1-08） */
export function isSelfHarmContent(text: string): boolean {
  return hasForbiddenPatterns(text, [SELF_HARM_RAW_RE], [SELF_HARM_NORM_RE, SELF_HARM_VARIANTS]);
}

/**
 * AI 输出安全检测（P1-07）：仅拦截「第二人称指令式」高危内容
 * （如"go kill yourself / 去死吧 / 你去自杀"），避免误伤对倾诉的共情回复
 * （如"如果你有伤害自己的想法，请拨打热线"，包含自伤词但不是指令）。
 */
const OUTPUT_DIRECTIVES_RAW = /go kill yourself|kill yourself now|you should (kill|hurt) yourself|go die|just die|end your life now|self[- ]?harm now/i;
const OUTPUT_DIRECTIVES_NORM = /去死吧|你去死|你该去死|去自杀|你应该自杀|你去自杀|跳下去|你跳楼|割腕吧|你自残/i;

/**
 * 输出侧**硬拦截**：这几类内容本身就不允许出现，与「是否是指令式」无关。
 *
 * 为什么必须独立成一层（2026-09-16 加固）：
 *   之前的 checkAiOutputSafety 只拦「第二人称指令式自伤」，理由是不误伤共情回复，这对自伤类是合理的
 *   （"如果你有伤害自己的想法，请拨打热线"含自伤词但必须放行）。但**未成年性化 / 非自愿 / 乱伦兽交
 *   属于「内容类别本身不允许」**，与句式无关，绝不能因为"不是指令式"就放行。
 *   而 FORBIDDEN_NORM 里的未成年规则只被**用户输入侧**的 checkContentSafety 使用，
 *   输出侧一直没接，在接入去限制模型（无限制模式）之后，这是唯一防线的最大缺口。
 *
 * 为什么不能只靠提示词：roleplay 提示词里写了硬边界，但提示词不是保证
 *   我们换去限制模型的理由正是"官方模型不执行提示词"，同理去限制模型也不会可靠执行硬边界。
 *   这一层不依赖模型自律，是最后的兜底。
 *
 * 与「尺度」的关系：正常成年人之间的露骨内容**不受本层影响**（那是本产品的既定尺度），
 *   本层只认「未成年/非自愿/乱伦兽交」这三个类别，避免把无限制模式打回保守。
 */
const OUTPUT_HARD_BLOCK_NORM: RegExp[] = [
  // 【未成年 / 幼态 + 性】
  // 设计取舍（都来自实测踩坑）：
  //  · 标记与动作**合成一条**：分成两条时「幼女+身体」会漏（幼女那条没列身体）。
  //  · 动作词不能只列性行为名词：「（未成年）她褪下校服」不含任何性行为名词，靠「褪下」才拦得住。
  //  · **不收裸的「性」**：会撞「个性 / 性教育 / 属性」等正常用词，只收「性行为/性关系/性交」这类完整词。
  /(未成年|没成年|未满十[六八]|未满1[68]|不满十[六八]岁|不满1[68]岁|幼女|幼态|萝莉|童颜|小学生|初中生|高中生|校服).{0,10}(性行为|性关系|性爱|性交|做爱|情欲|肉体|裸|赤裸|勃起|插入|口交|爱抚|身体|褪下|脱下|解开|抚摸|亲吻|抱紧|上床|床|呻吟|喘息|高潮|湿润|胸|腿)/,
  /恋童|儿童色情|雏妓/,
  // 非自愿 / 胁迫，（刻意不收「趁人之危」这类常用成语，避免误伤正常剧情）
  /(强奸|轮奸|迷奸|迷晕|下药).{0,12}/,
  /(强迫|胁迫|违背.{0,6}意愿).{0,10}(发生关系|性关系|做爱|性交|亲热)/,
  // 乱伦 / 兽交，（不收「人兽」二字：会撞「人兽冲突」等正常表述）
  /乱伦|兽交/,
  /(父女|母子|兄妹|姐弟).{0,8}(性|做爱|情欲|关系)/,
];
const OUTPUT_HARD_BLOCK_RAW: RegExp[] = [
  /child porn|underage (sex|girl|boy|child)|minor.{0,12}sex|pedophil|incest|bestiality|zoophil/i,
  /(rape|molest|grope).{0,24}(her|him|them|the (girl|boy|child))/i,
];

export function checkAiOutputSafety(text: string): SafetyResult {
  // 第一层：指令式自伤（原有行为，保持不变，刻意宽松以免误伤共情回复）
  if (hasForbiddenPatterns(text, [OUTPUT_DIRECTIVES_RAW], [OUTPUT_DIRECTIVES_NORM])) {
    return { safe: false, reason: 'content_violation' };
  }
  // 第二层：内容类别本身不允许（未成年性化 / 非自愿 / 乱伦兽交），红线，任何情况不放行
  if (hasForbiddenPatterns(text, OUTPUT_HARD_BLOCK_RAW, OUTPUT_HARD_BLOCK_NORM)) {
    // 这是「去限制模型在触碰我们明确写了的硬边界」的信号，必须留痕：说明提示词约束正在失效，
    // 需要看是模型问题还是剧本设定问题（而不是静默换一条兜底文案了事）。
    console.warn('🚨 [Safety] AI 输出命中硬边界（未成年性化/非自愿/乱伦兽交），已拦截替换为兜底文案');
    return { safe: false, reason: 'hard_limit_violation' };
  }
  return { safe: true, reason: '' };
}
