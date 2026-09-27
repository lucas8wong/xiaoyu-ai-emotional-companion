/**
 * 简体 ↔ 繁体 转换（opencc-js，纯 JS 无原生依赖）
 * 繁体模式下所有面向用户的内容（剧情剧本 / 标签 / AI 提示词）统一转繁体，
 * 与 i18n 的 zh-TW 文案配套，避免简繁混用。
 *
 * 🚨 2026-09-20 事故修复（**不要在 tw→cn 方向无条件转换**）：
 *   OpenCC 的 `tw → cn` 表里除了「字形」映射，还有**词汇/异体**规则，它只对**真的繁体文本**成立。
 *   把它作用在**本来就是简体**的文本上，会凭空造出错别字，甚至**改掉用户写下的专名**：
 *     · `沈重 → 沉重`（自建剧本角色名「沈重」被改名 —— 模型收到的人设里从头到尾写着「沉重」，
 *       于是它永远写对这个名字；用户连着两轮把「是沈重不是沉重」写进剧情偏好也没用，
 *       因为**那句偏好原文同样被这个转换改写成「是沉重不是沉重啊」**，模型读到的是自相矛盾的废话。
 *       取证：`temp/rp-59f42afe/`（用户 59f42afe 的真实记录 + 导出的真实 system prompt）
 *     · `著称 → 着称`、`显著 → 显着`（官方剧本《顾淮之·产后》人设里的正常词被改成错别字）
 *     · `安乾镐 → 安干镐`、`藉口 → 借口`
 *   所以 `toZhSimple()` 现在**先判方向**：只有这段文本确实像繁体（含繁体专用字、且不含简体专用字）
 *   才做 `tw→cn`；否则原样返回。判据是**字形本身**（见 `charScriptOf`），不依赖词表，
 *   因此对「本来就是简体的文本」是**零改写**——这正是这次要保证的不变量。
 *   ⚠️ 反向（`cn→tw`）不动：那个方向的词表没有同类陷阱（实测全库 1629 条里只有 6 条
 *   被它改动，且都是 TW 异体归一），乱动只会把 zh-TW 文案改坏。
 */
import { Converter } from 'opencc-js';

const cnToTw = Converter({ from: 'cn', to: 'tw' });
const twToCn = Converter({ from: 'tw', to: 'cn' });

/** 输出语言三态（简中/繁中/英文）——跨层统一标识，避免各层各起一个名字导致漂移 */
export type OutputLang = 'zh-CN' | 'zh-TW' | 'en';

/**
 * 把任意值归一化为 OutputLang（缺省回退 fallback，默认 zh-CN）。
 * 一致约定：zh/zh-CN/zh-HK→简体；zh-TW→繁体；en→英文。与 `langKey` 原来的三元逻辑等值。
 */
export function toOutputLang(v: unknown, fallback: OutputLang = 'zh-CN'): OutputLang {
  if (v === 'en') return 'en';
  if (v === 'zh-TW') return 'zh-TW';
  if (v === 'zh' || v === 'zh-CN' || v === 'zh-HK') return 'zh-CN';
  return fallback;
}

/** 简体文本 → 繁体（空值原样返回） */
export function toZhTw(text: string): string {
  if (!text) return text;
  return cnToTw(text);
}

/**
 * 单个字符「专属于哪一边」（判方向的**唯一判据**，不查词表）：
 *   · `trad`    —— 只有 tw→cn 会动它（如 這/陸/說/稱）→ 繁体专用字；
 *   · `simp`    —— 只有 cn→tw 会动它（如 这/陆/说/称）→ 简体专用字；
 *   · `neutral` —— 两边都不动它（如 沈/重/人/生）→ **简繁同形**。
 *
 * ⚠️ `沈` 属于 neutral：它在简繁两边都是合法字（沈阳/沈重），
 *    只有**词表**才认为「沈重」是「沉重」的繁体写法 —— 那正是不能拿来判方向的依据。
 */
type CharScript = 'simp' | 'trad' | 'neutral';
const scriptCache = new Map<string, CharScript>();
function charScriptOf(c: string): CharScript {
  const cached = scriptCache.get(c);
  if (cached) return cached;
  let s: CharScript = 'neutral';
  if (twToCn(c) !== c && cnToTw(c) === c) s = 'trad';
  else if (cnToTw(c) !== c && twToCn(c) === c) s = 'simp';
  scriptCache.set(c, s);
  return s;
}

/**
 * 这段文本是不是**像繁体**：至少含一个繁体专用字、且一个简体专用字都没有。
 *
 * 为什么这么保守（宁可漏转也不误转）：`toZhSimple` 是**有损**转换 ——
 * 对方向判错的代价是「用户写的人名被改名 / 正文出现错别字」（见文件头 2026-09-20 事故），
 * 而漏转的代价只是「本来该变简体的那几段还留着繁体」这种纯观感问题。
 * 简繁同形字（neutral）单独出现时**不算繁体**——那种文本转不转都一样，
 * 而词表偏偏会在它上面做文章（沈重→沉重）。
 */
export function looksTraditionalText(text: string): boolean {
  if (!text) return false;
  let trad = 0;
  for (const ch of text) {
    const s = charScriptOf(ch);
    if (s === 'simp') return false;   // 出现简体专用字 → 这段不是繁体（混合文本也按“不转”处理，保守优先）
    if (s === 'trad') trad += 1;
  }
  return trad > 0;
}

/**
 * 繁体文本 → 简体（内容安全归一化等用，P1-06）
 *
 * 🚨 **只在文本确实像繁体时才转**（2026-09-20）：无条件的 tw→cn 会把简体文本改坏/改名，
 * 详见文件头。需要「无论如何都要转」的场景请显式用 `twToCn`（本文件内部）。
 */
export function toZhSimple(text: string): string {
  if (!text) return text;
  if (!looksTraditionalText(text)) return text;
  return twToCn(text);
}

/**
 * **专名保护**：转换期间把「人名 / 昵称 / 作品名」等专名换成占位符，转完再原样换回来。
 *
 * 为什么需要它（2026-09-20 第二轮，用户拍板 C）：方向闸只能拦住「判错方向」这一类误伤
 * （沈重→沉重、著称→着称）；但名字里含**繁体专用字**的仍会被字体归一改掉 ——
 * 「冷昇 → 冷升」「陸深 → 陆深」。名字是**标识符**：界面上写着「冷昇」，模型收到的提示词里
 * 却叫「冷升」，它会一直用那个错名字，用户同样改不掉（与「沈重」同一个病）。
 * 所以：**名字逐字不变**，只有正文参与字体转换。
 *
 * 用法约束：
 *   · 只在**有损**的方向用（本仓库是 `tw→cn`）；`cn→tw` 是字形归一、且列表/详情接口
 *     本来就是按繁体把名字发给前端的（`api/routes/roleplay.ts` 的 `ql === 'zh-TW'` 分支），
 *     所以那个方向照转，名字仍与界面一致；
 *   · 占位符用 Unicode 私用区（PUA）——OpenCC 的词表不收录，不会被改写；
 *   · 词条按长度倒序替换（长名字优先），1 个字的词条一律忽略（保护范围过大会误伤正文）。
 */
const TERM_OPEN = '\uE000';
const TERM_CLOSE = '\uE001';
export function withProtectedTerms(text: string, terms: readonly string[] | undefined, convert: (s: string) => string): string {
  if (!text) return text;
  const list = Array.from(new Set((terms || []).map((t) => String(t || '').trim()).filter((t) => t.length >= 2 && !t.includes(TERM_OPEN))))
    .sort((a, b) => b.length - a.length);
  if (!list.length) return convert(text);
  let out = text;
  const slots: string[] = [];
  list.forEach((term, i) => {
    if (!out.includes(term)) return;
    slots[i] = term;
    out = out.split(term).join(TERM_OPEN + i + TERM_CLOSE);
  });
  out = convert(out);
  slots.forEach((term, i) => {
    if (term) out = out.split(TERM_OPEN + i + TERM_CLOSE).join(term);
  });
  return out;
}

/** `normalizeScriptText` 的专名保护版（同上：名字逐字不变，正文照常归一） */
export function normalizeScriptTextProtected(text: string, lang: string, terms?: readonly string[]): string {
  if (!text) return text;
  if (lang === 'zh-TW') return toZhTw(text);          // 简→繁：字形归一、与界面一致，照转
  if (lang === 'zh' || lang === 'zh-CN' || lang === 'zh-HK') return withProtectedTerms(text, terms, toZhSimple);
  return text;
}

/** 递归把对象/数组里所有字符串值转繁体（用于整块剧本文本） */
export function toZhTwDeep<T>(value: T): T {
  if (typeof value === 'string') return toZhTw(value) as T;
  if (Array.isArray(value)) return value.map(toZhTwDeep) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toZhTwDeep(v);
    return out as T;
  }
  return value;
}

/**
 * 归一化文本到目标字体（简体 / 繁体 / 英文原样）。
 * lang：'zh-TW'=繁体；'zh'|'zh-CN'|'zh-HK'=简体；其它（如 'en'）=英文原样（opencc 不处理英文）。
 * 这是「任何内容完全对应字体」的**硬保证**——对生成结果做后置强制归一（简↔繁可机械转换）。
 */
export function normalizeScriptText(text: string, lang: string): string {
  if (!text) return text;
  if (lang === 'zh-TW') return toZhTw(text);
  if (lang === 'zh' || lang === 'zh-CN' || lang === 'zh-HK') return toZhSimple(text);
  return text;
}

/** 一段文本是否含中文（CJK 统一表意区），用于判英文模式是否夹中文 */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(text || '');
}

/**
 * 粗略判断一段文本主要使用哪种字体（聊一聊「跟随输入」用）。
 * 无中文→'en'；转简体会变（含繁体）→'zh-TW'；转繁体会变（含简体）→'zh-CN'；简繁同形无法判定→''（调用方回退界面语言）。
 */
export function detectScriptText(text: string): 'zh-CN' | 'zh-TW' | 'en' | '' {
  if (!text) return '';
  if (!hasCjk(text)) return 'en';
  const asSimplified = toZhSimple(text);
  const asTraditional = toZhTw(text);
  if (asSimplified !== text) return 'zh-TW';
  if (asTraditional !== text) return 'zh-CN';
  return '';
}

/** 递归把对象/数组里所有字符串值归一化到目标字体（用于结构化分析结果 / 整块内容的硬保证） */
export function normalizeScriptDeep<T>(value: T, lang: string): T {
  if (typeof value === 'string') return normalizeScriptText(value, lang) as T;
  if (Array.isArray(value)) return value.map((v) => normalizeScriptDeep(v, lang)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeScriptDeep(v, lang);
    return out as T;
  }
  return value;
}
