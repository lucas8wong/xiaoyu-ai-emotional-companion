/**
 * 对白引号规范（按语言版本）——**简中 “” / 繁中 「」 / 英文 ""**
 *
 * 为什么需要它（2026-09-17 实测，不是猜的）：
 * - 提示词里原本只写「人物话语用双引号表示」——中文里「」和“”**都叫引号**，模型按自己习惯走。
 *   线上 1398 条 AI 剧情回复里：「」791 条(57%)、“”280 条(20%)、ASCII 直引号 156 条(11%)，
 *   同一段里混用 25 条、同一会话里两种风格都出现过 21/261。官方剧本开场（作者数据）用的是 ASCII 直引号。
 * - `zhConvert.ts` 的 opencc 简繁转换**不转换引号**（实测 “” 与 「」 各自原样透传）
 *   → 「跟随语言版本」这件事必须显式做，不能指望转换器。
 *
 * 两类能力：
 * 1. `quoteRuleBlock(lang)`：写进 system prompt 的**明确到字形 + 带示例**的条款（补上原来的含糊句）；
 * 2. `createDialogueQuoteNormalizer(lang)`：把模型输出归一。
 *    - **流式安全**：纯逐字映射（无回溯），ASCII 直引号的配对状态跨 delta 续接；
 *    - **幂等**：再跑一次结果不变；
 *    - **重试安全**：空回复重试时调用方**每轮新建一套状态**（`createDialogueQuoteNormalizer` 里自带）。
 *
 * ⚠️ 2026-09-19 追加：**配对修复**（不是换字形，是修"用错引号"）。
 * 起因（只读取证，见 `temp/rp-rep-cf8077d3/`）：无限制链路（27B abliterated）有把开引号当闭引号用的习惯——
 * 写出来是 `“这双手若是不安……“`（**两个开引号**，没有闭引号）。后果不是"难看"这么轻：
 *   ① `replyCompleteness.unclosedMarkers()` 按计数判配对 → 这类回复**永远被判 unclosed**；
 *   ② `unclosed` 是自动续写的**真截断**通道（2026-09-19 收窄后仍保留）→ 于是每轮都被续满 2 次；
 *   ③ 弱模型被要求"接着写"时**重讲同一拍**，拼接后就是用户看到的"同一段剧情讲两遍"。
 * 实测：该用户 8 个回合全部命中 `回复仍不完整（unclosed，续写 2 次）`（`data/server-err.log`），
 * 条内逐字重复 98–141 字、跨轮最长公共子串 461 字。
 * 所以这里在**换字形之前先按"角色"配对**：处于引号内时再遇到一个开引号 → 它其实是闭引号，换成闭引号。
 * 仍然满足上面四条性质（逐字符 1:1、流式状态跨 delta 续接、幂等、不吞字符）。
 *
 * 四条刻意的边界：
 * - **英文不动**：英文的规范就是 ASCII 直引号 `"`（`normalizeDialogueQuotes` 对 en 直接原样返回）；
 * - **撇号保护**：`’` 紧跟在 ASCII 字母之后时视为英文撇号（don’t / O’Brien），不当作引号
 *   （只看前一个字符——后一个字符可能还在下一个 delta 里，两侧判定会破坏"流式 === 整段"）；
 * - **只管引号家族**：双引号（「」↔“”）与嵌套单引号（『』↔‘’），不碰《》【】（）等其它标点。
 *
 * 为什么敢在中文里换字形：这两套引号在各自书写系统里**功能等价**（引用 + 强调），
 * 换过去仍然是规范写法；所以 `「沈辞」` 在简中下变 `“沈辞”` 不会读坏。
 */
import { toZhTw } from './zhConvert.js';

type QuoteFamily = 'simplified' | 'traditional' | 'none';

/** zh/zh-CN/zh-HK → 简体；zh-TW → 繁体；其它（含 en）→ 不动 */
function familyOf(lang: string): QuoteFamily {
  if (lang === 'zh-TW') return 'traditional';
  if (lang === 'zh' || lang === 'zh-CN' || lang === 'zh-HK') return 'simplified';
  return 'none';
}

const GLYPH_MAP: Record<Exclude<QuoteFamily, 'none'>, Record<string, string>> = {
  // 繁体写法 → 简体写法
  simplified: { '「': '“', '」': '”', '『': '‘', '』': '’' },
  // 简体写法 → 繁体写法
  traditional: { '“': '「', '”': '」', '‘': '『', '’': '』' },
};

const OPEN_QUOTE: Record<Exclude<QuoteFamily, 'none'>, string> = { simplified: '“', traditional: '「' };
const CLOSE_QUOTE: Record<Exclude<QuoteFamily, 'none'>, string> = { simplified: '”', traditional: '」' };

const ASCII_DQ = '"';
const ASCII_LETTER = /[A-Za-z]/;

/** 输入侧：哪些字符**承担开引号角色**（两套字形都算；先按角色判定，再换成目标字形） */
const OPEN_ROLE = new Set(['“', '「']);
/** 输入侧：哪些字符**承担闭引号角色** */
const CLOSE_ROLE = new Set(['”', '」']);

/** 归一状态：`inQuote` 是"当前是否在一对对话双引号里面"（配对修复用），`lastChar` 只为撇号保护跨 delta 续接 */
interface ConvertState {
  inQuote: boolean;
  lastChar: string;
}
const freshState = (): ConvertState => ({ inQuote: false, lastChar: '' });

/**
 * 逐字归一。`state` 服务两件事：ASCII 直引号的配对、以及**对话引号的开/闭配对状态**（跨 delta 续接）；
 * 不传 = 从"不在引号里、上一个字符为空"开始（整段归一就是这么用的）。
 */
function convert(text: string, fam: QuoteFamily, state?: ConvertState): string {
  if (!text || fam === 'none') return text;
  const st = state || freshState();
  const table = GLYPH_MAP[fam];
  const open = OPEN_QUOTE[fam];
  const close = CLOSE_QUOTE[fam];
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ASCII_DQ) {
      out += st.inQuote ? close : open;
      st.inQuote = !st.inQuote;
      st.lastChar = ch;
      continue;
    }
    // —— 对话双引号：按"角色"配对，用错的那一个由状态纠正（见文件头 2026-09-19 追加段）——
    if (OPEN_ROLE.has(ch)) {
      // 已经在引号里还遇到开引号 → 模型拿它当闭引号用（`“台词……“`）→ 补成闭引号
      if (st.inQuote) { out += close; st.inQuote = false; } else { out += open; st.inQuote = true; }
      st.lastChar = out[out.length - 1];
      continue;
    }
    if (CLOSE_ROLE.has(ch)) {
      // 不在引号里却遇到闭引号 → 落单的闭引号，补成开引号（保持成对）
      if (st.inQuote) { out += close; st.inQuote = false; } else { out += open; st.inQuote = true; }
      st.lastChar = out[out.length - 1];
      continue;
    }
    // 撇号保护：don’t / O’Brien 里的 ’ 不是引号。
    // ⚠️ 只看**前一个字符**（状态里跨 delta 续接），不看后一个：流式切分可能正好切在 ’ 后面，
    //    那时后一个字符还在下一个 delta 里，两侧判定会让"流式串联"与"整段归一"结果不一致
    //    （实测：don’t 切在 ’ 之后时，整段是撇号、流式却变成了闭引号）。
    if (ch === '’' && ASCII_LETTER.test(st.lastChar || '')) {
      out += ch;
      st.lastChar = ch;
      continue;
    }
    const mapped = table[ch] || ch;
    out += mapped;
    st.lastChar = mapped;
  }
  return out;
}

export interface DialogueQuoteNormalizer {
  /** 流式增量：返回可直接下发的片段（ASCII 直引号与对话引号的配对状态跨调用续接） */
  push(chunk: string): string;
  /** 整段归一：用**一套全新状态**，结果与逐 delta 串联完全一致（配对奇偶只看整段自己） */
  finish(text: string): string;
}

/** 按语言版本创建归一器（一次生成/一条流用一套；空回复重试时请重新创建） */
export function createDialogueQuoteNormalizer(lang: string): DialogueQuoteNormalizer {
  const fam = familyOf(lang);
  const state = freshState();
  return {
    push: (chunk: string) => convert(chunk, fam, state),
    finish: (text: string) => convert(text, fam, freshState()),
  };
}

/** 一次性归一（非流式场景 / 短文本） */
export function normalizeDialogueQuotes(text: string, lang: string): string {
  return convert(text, familyOf(lang), freshState());
}

/** 简中模板：字形用占位符，繁体分支靠 toZhTw 转（opencc 不碰占位符，也不碰引号） */
const ZH_RULE_TEMPLATE =
  '【引号规范 · 严格遵守】人物说出来的话一律用 @DQ@ 包住（例：他说：@QO@别走。@QC@）；'
  + '不要用 @ALT@，也不要用英文直引号 "。心理活动与神态仍用（）书写，与本规范不冲突；同一段里不要混用两种引号。'
  // 2026-09-19：无限制链路的模型有「用两个开引号框住台词」（@QO@…@QO@）的习惯，会被判成"引号没配对"
  // 并触发自动续写（详见文件头）。条款里点名这个写法，配合归一器的配对修复双保险。
  + '引号必须一开一闭：开引号是 @QO@、闭引号是 @QC@，两者不同；绝不能用两个开引号把台词框起来。';

const EN_RULE =
  '[Quotation rule — strict] Put everything a character says in straight double quotes "…" '
  + '(e.g. He said, "Don\'t go."). Never use 「」 or “”. Inner thoughts and stage business stay in ( ). '
  + 'Every line of dialogue must open and close: never bracket a line with two opening quotes.';

/**
 * 给 system prompt 用的引号规范条款（带前导空行，便于直接拼在规则块后面）。
 * 位置：拼在【写作与交互要求】规则块的**末尾**——同一条规则里"离输出最近"的部分最有效。
 */
export function quoteRuleBlock(lang: string): string {
  const fam = familyOf(lang);
  if (fam === 'none') return '\n\n' + EN_RULE;
  const tw = fam === 'traditional';
  const text = tw ? toZhTw(ZH_RULE_TEMPLATE) : ZH_RULE_TEMPLATE;
  const dq = tw ? '「」' : '“”';
  const qo = tw ? '「' : '“';
  const qc = tw ? '」' : '”';
  const alt = tw ? '“”' : '「」';
  return '\n\n' + text
    .replace(/@DQ@/g, dq)
    .replace(/@QO@/g, qo)
    .replace(/@QC@/g, qc)
    .replace(/@ALT@/g, alt);
}
