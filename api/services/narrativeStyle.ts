/**
 * 剧情「叙事模式」的**单一来源**（B 方案，2026-09-25）
 *
 * ── 为什么要抽这个文件 ────────────────────────────────────────────────
 * 在它之前，「经典叙事 / 沉浸叙事」的差异散落在 5 个地方各写一遍：
 *   ① `pickRulesText` 的规则块（经典=小说式规则书 / 沉浸=口语清单）
 *   ② `roleplayTaskInstr` 的收尾要求（经典=每轮留钩子 / 沉浸=先接住用户）
 *   ③ `buildTurnDisciplineBlock` 的第 2/5/6 条（沉浸独有「长度跟人走」）
 *   ④ `buildUnlimitedModeBlock` 第一节的篇幅与语体
 *   ⑤ `roleplayTurnLengthBand` 的续写篇幅带
 * 于是出现了两处只有实测才会发现的坏结果（`temp/_style-conflict2.mts` 取证）：
 *   · **互串 + 字数打架**：成人块的「推进节（亲密）」**没分档** ⇒ 经典档同时收到
 *     「正文 400–700 字，亲密同样受此区间约束」与「亲密场景正文 250–450 字」，
 *     还被要求「以身体动作与感官描写为主体」（那是沉浸档的语体）；
 *   · **悬空引用**：非成人档（官方 DeepSeek 路径）的沉浸档写着「按**成人模式**的亲密档写足
 *     （250–450 字）」，而成人块根本不在那个 prompt 里。
 * 抽成档案之后，**数字与语体只在这里定义一次**，各处只做引用/措辞，不可能再互相矛盾。
 *
 * ── 两个模式的定位（这就是它们的差别，别再凭印象）─────────────────────
 *   classic（经典叙事）= **小说笔法**：第三人称叙述你所扮演的角色（用户角色一律是「你」）、
 *      长句铺陈、镜头感、细节成链条；篇幅足（zh 400–700 字 / en 250-450 words）；
 *      每轮留一个**互动钩子**（动作/悬念/没说完的话）。
 *   immersive（沉浸叙事）= **对话笔法**：日常口语、以台词为主体、括号写动作神态；
 *      日常极短（zh ≤100 字 / en <60 words），用户推进或进入亲密场景时才写足
 *      （zh 250–450 字 / en 120-250 words）；用户没推进时不另起话题，宁可停在半途。
 *   两条轴：**篇幅与语体**（小说 ↔ 对话）+ **收尾方式**（留钩子 ↔ 接住用户）。
 *   共同点：人称（用户=你、AI 角色=第三人称）、硬边界、反注水、回合纪律都不分档。
 *
 * 数据兼容：`classic` / `immersive` 这两个**取值**是落盘字段（`RoleplayMessage.style`）
 * 与控制台统计的口径，**不要改**；要改的是显示名与文案（见 i18n 的 rpStyle*）。
 */

export type RoleplayNarrativeStyle = 'classic' | 'immersive';

/** 区间（含端点）；zh 口径=字数，en 口径=词数 */
export interface Band { min: number; max: number }

export interface NarrativeProfile {
  id: RoleplayNarrativeStyle;
  /** 日常对话正文（zh 字数）：immersive 的 0–100 是**上限**式要求（"一次一两句、不超过 100 字"） */
  dailyZh: Band;
  /** 推进/亲密场景正文（zh 字数）：两种模式在这里的差别是"写足到哪一档"，不是"要不要写足" */
  intimateZh: Band;
  /** 英文口径（词） */
  dailyEnWords: Band;
  intimateEnWords: Band;
  /** 语体：literary=书面长句铺陈 / colloquial=口语短句、台词为主 */
  register: 'literary' | 'colloquial';
  /** 收尾倾向：hook=每轮必须留互动钩子 / follow=先接住用户、他不推进就不另起 */
  ending: 'hook' | 'follow';
  /** 是否「长度跟人走」（只有对话笔法需要；小说笔法每轮本来就写足） */
  followPlayerLength: boolean;
  /**
   * 成人模式下是否**物理摘掉**规则块里的篇幅压制条款。
   * 只有 immersive 需要：它的语体靠「日常化/语言简短/禁止大段落」维持，而那批条款会被摘掉，
   * 所以成人块第一节必须把语体特征正面写回来。classic 的语体（长句铺陈/镜头感）正是它要保留的性格，
   * 对它跑移除只会全部匹配不到（白告警）。
   */
  relaxLengthCaps: boolean;
  /** 续写篇幅带（zh 字数）：一轮总量上限 / 单次续写最多补多少 */
  continuationZh: { maxTotal: number; topUp: number };
  /** 续写篇幅带（en 字符口径，沿用历史的 ~6 字符/词折算） */
  continuationEnChars: { maxTotal: number; topUp: number };
}

const CLASSIC: NarrativeProfile = {
  id: 'classic',
  dailyZh: { min: 400, max: 700 },
  intimateZh: { min: 400, max: 700 },
  dailyEnWords: { min: 250, max: 450 },
  intimateEnWords: { min: 250, max: 450 },
  register: 'literary',
  ending: 'hook',
  followPlayerLength: false,
  relaxLengthCaps: false,
  continuationZh: { maxTotal: 700, topUp: 300 },
  continuationEnChars: { maxTotal: 450 * 6, topUp: 120 * 6 },
};

const IMMERSIVE: NarrativeProfile = {
  id: 'immersive',
  dailyZh: { min: 0, max: 100 },
  intimateZh: { min: 250, max: 450 },
  dailyEnWords: { min: 0, max: 60 },
  intimateEnWords: { min: 120, max: 250 },
  register: 'colloquial',
  ending: 'follow',
  followPlayerLength: true,
  relaxLengthCaps: true,
  continuationZh: { maxTotal: 450, topUp: 200 },
  continuationEnChars: { maxTotal: 250 * 6, topUp: 90 * 6 },
};

/** 未知/缺省值一律按 immersive（与改造前的归一化口径逐字一致，避免静默改变线上行为） */
export function narrativeProfile(style: RoleplayNarrativeStyle | string | undefined): NarrativeProfile {
  return style === 'classic' ? CLASSIC : IMMERSIVE;
}

/** 该模式在该语言下的篇幅口径（zh=字、en=词），供各处拼提示词/指令用 */
export function styleBands(lang: string, style: RoleplayNarrativeStyle | string | undefined): { daily: Band; intimate: Band } {
  const p = narrativeProfile(style);
  return lang === 'en' ? { daily: p.dailyEnWords, intimate: p.intimateEnWords } : { daily: p.dailyZh, intimate: p.intimateZh };
}

/**
 * 人类可读的篇幅文案（**唯一一处**把数字变成句子，避免各处自己拼又慢慢漂移）。
 * `unit` 由语言决定；immersive 的日常档是"上限式"表述，刻意与经典档分开写。
 */
export function lengthPhrase(lang: string, style: RoleplayNarrativeStyle | string | undefined, kind: 'daily' | 'intimate'): string {
  const { daily, intimate } = styleBands(lang, style);
  const b = kind === 'intimate' ? intimate : daily;
  const en = lang === 'en';
  const unit = en ? ' words' : ' 字';
  const range = b.min > 0 ? `${b.min}–${b.max}${unit}` : (en ? `under ${b.max}${unit}` : `不超过 ${b.max} 字`);
  return range;
}
