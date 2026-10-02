/**
 * 「这一条回复写完了吗」——剧情/对话流式回复的**完整性判定 + 续写拼接**（纯函数，前后端共用）
 *
 * 为什么需要它（2026-09-18 诊断结论）：
 *   用户「小愈的朋友」(98e677f1…) 在《与沈辞的故事》里的最后一条 AI 回复，落盘内容是
 *   `……乖，慢慢刷。”\n\n（他并未退` —— 括号没闭合、停在半句中间，而**整条链路没有任何一环**
 *   发现它没写完：剧情路由不看上游的 `finish_reason`，前端拿到什么就存什么，
 *   于是「半截台词」被当成完整回复永久留在历史里（详情见
 *   `temp/rp-check/诊断-98e677f1-最新剧情回复是否中断.md`）。
 *
 * 这里只做两件**可判定**的事，不碰提示词、不碰数据：
 *   1. `looksIncomplete()` —— 这条回复是不是断在半路（三条判据：上游 `finish_reason=length`、
 *      标记符（括号/引号）没配对、结尾不是句末标点）；
 *   2. `overlapTrim()` / `mergeContinuation()` —— 续写回来的那一段与已写内容**去重叠**再拼接
 *      （模型续写几乎必然把断点前几个字重抄一遍，直接拼会得到「（他并未退（他并未退出去」）。
 *
 * 设计口径（刻意保守，宁可漏报也不要误报）：
 *   - **只在有正文时才判定**：空回复走既有的空回复重试，不归这里管；
 *   - **行尾装饰符（emoji / 变体选择符 / 零宽连接符）不算"没写完"**：`……稍后再试好吗？🌱` 结尾是
 *     emoji 但句子是完整的，先剥掉装饰符再看标点；
 *   - **结尾是收尾标记（」”』））且配对平衡 → 算写完**：模型常以台词收尾，不写句号；
 *   - 判定结果只影响「要不要续写 / 要不要提示」，**绝不改写已有正文**。
 */

/** 句末标点（真正表示"这句话说完了"的那几个；`；`/`:`/`,` 不算） */
const TERMINAL_PUNCT = new Set(['。', '！', '？', '…', '～', '!', '?', '.', '~']);

/** 收尾标记：出现在末尾且配对平衡时算"写完" */
const CLOSERS = new Set(['）', ')', '」', '』', '”', '"', '】', '》', '〉', '›', '»']);

/** 成对标记（开 → 闭）。直引号 `"` 两侧同一个字符，单独处理 */
const PAIRS: Array<[string, string]> = [
  ['（', '）'],
  ['(', ')'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['【', '】'],
  ['《', '》'],
  ['〈', '〉'],
];

/**
 * 行尾可忽略的装饰符：空白、零宽连接符、变体选择符、emoji。
 * 只剥"尾部"，不影响正文判定（`……好吗？🌱` → `……好吗？`）。
 * 不用 `\p{Emoji_Component}`：它把 0-9 也算进去，会把结尾的数字剥掉。
 */
// 说明：这条规则担心「字符类里混入了可组合序列」（例如把 emoji 与 ZWJ 分开写会切错字符）。
// 这里的意图恰恰相反：要的就是**逐码点**匹配尾部装饰（ZWJ U+200D / 变体选择符 / 键帽 U+20E3 / 扩展象形），
// 而不是匹配整个 emoji 序列，所以按规则作者的本意保留原样，仅关闭这一条并留下理由（2026-09-28 审查 C1）。
// eslint-disable-next-line no-misleading-character-class -- 有意逐码点匹配尾部装饰，见上方说明
const TRAILING_DECORATION = /[\s\u3000\u200d\ufe0e\ufe0f\u20e3\p{Extended_Pictographic}]+$/gu;

/** 未闭合的成对标记（用于埋点归因与提示文案；空数组 = 标记都配对） */
export function unclosedMarkers(raw: string): string[] {
  const s = String(raw ?? '');
  const bad: string[] = [];
  for (const [open, close] of PAIRS) {
    const opens = countOf(s, open);
    const closes = countOf(s, close);
    if (opens > closes) bad.push(open + close);
  }
  // 英文直引号：奇数个 = 有落单的（模型写英文对白时最常见）
  if (countOf(s, '"') % 2 === 1) bad.push('""');
  return bad;
}

function countOf(s: string, ch: string): number {
  let n = 0;
  let i = s.indexOf(ch);
  while (i >= 0) {
    n += 1;
    i = s.indexOf(ch, i + ch.length);
  }
  return n;
}

/** 去掉行尾装饰符（空白 / emoji / 变体选择符）后的正文，用于判定「写完没有」 */
export function stripTrailingDecoration(raw: string): string {
  return String(raw ?? '').replace(TRAILING_DECORATION, '');
}

export type IncompleteReason = 'length' | 'unclosed' | 'mid_sentence';

/**
 * 这条回复是不是断在半路。
 *
 * @param raw          模型这一轮的完整输出（已归一化）
 * @param finishReason 上游 `finish_reason`（拿不到就不传）
 * @returns null = 判定为写完了；否则给出原因（用于日志/埋点/提示文案）
 */
export function incompleteReason(raw: string, finishReason?: string): IncompleteReason | null {
  const body = stripTrailingDecoration(raw);
  // 上游明确说「撞到 max_tokens 上限」→ 无论文本长相如何都算没写完
  if (String(finishReason || '').toLowerCase() === 'length' && body.length > 0) return 'length';
  if (!body) return null; // 空回复不归这里管（有独立的空回复重试）
  if (unclosedMarkers(body).length > 0) return 'unclosed';
  const last = body[body.length - 1];
  if (TERMINAL_PUNCT.has(last)) return null;
  if (CLOSERS.has(last)) return null; // 以台词/心声收尾，标记已配对 → 写完了
  return 'mid_sentence';
}

/** `incompleteReason()` 的布尔形式（缺省口径用） */
export function looksIncomplete(raw: string, finishReason?: string): boolean {
  return incompleteReason(raw, finishReason) !== null;
}

/**
 * 把**续写新增的那一段**裁进字数预算里（只在句末标点处裁）——用户口径「续写应该只是满足一次的
 * 字数量，而不是每次都生成类似初始回复的量」（2026-09-19）。
 *
 * 为什么需要硬裁：预算已经写进续写指令了，但**指令管不住长度**——模型会照旧再写一整条（实测
 * 799 → 续 551 → 再续 618 = 1968 字，而这一轮的目标篇幅只有 400–700）。所以除了"说"，还要有"拦"。
 *
 * 三条边界（宁可少裁也不砍断句子）：
 *   1. **不超预算就原样返回**；
 *   2. 从预算位置向前找最近的**句末标点**（含收尾引号/括号）→ 在它之后裁断；
 *   3. 整个前缀里**一个句界都没有** → 原样返回（宁可超预算，也不把一句好好的话砍成半句——
 *      那正是这次要治的毛病）。调用方拿到 `trimmed` 自行记日志。
 */
export function trimAdditionToBudget(addition: string, budget: number): { text: string; trimmed: boolean } {
  const a = String(addition ?? '');
  if (budget <= 0 || a.length <= budget) return { text: a, trimmed: false };
  const head = a.slice(0, Math.floor(budget));
  const ENDS = new Set(['。', '！', '？', '…', '～', '!', '?', '.', '~', '”', '」', '』', '）', ')', '】', '》']);
  let cut = 0;
  for (let i = head.length - 1; i >= 0; i--) if (ENDS.has(head[i])) { cut = i + 1; break; }
  if (cut <= 0) return { text: a, trimmed: false };
  return { text: a.slice(0, cut), trimmed: true };
}

/**
 * 续写去重叠：把 `addition` 开头与 `base` 结尾**逐字重复**的部分剪掉。
 *
 * 例：base=`…（他并未退`，addition=`退出去半步，反手把门带上。` → 返回 `出去半步，反手把门带上。`
 *
 * 两条规则：
 *   1. **整段重写**（`addition` 以**整份 base** 开头，模型把上文原样重抄一遍再往下写）：
 *      直接剪掉整份 base —— 这种"重叠"长度等于 base，通常远超下面的上限，只有单独处理才不会漏剪；
 *   2. 否则取**最长**公共重叠（从大到小试），上限 `maxOverlap` 字符。
 *
 * 为什么要上限：模型有时会写出很长的重复片段，无上限的匹配在"通篇重复字符"（如整段「……」）时
 * 会误剪掉正文。上限之外的长重叠由调用方当作**没有进展**处理（见 roleplayReplyWithContinuation：
 * 拼接后没变长就停手，保留半截 + 交前端提示），这比拼出一段重复文字更安全。
 */
export function overlapTrim(base: string, addition: string, maxOverlap = 200): string {
  const b = String(base ?? '');
  const a = String(addition ?? '');
  if (!a) return '';
  if (b && a.startsWith(b)) return a.slice(b.length);
  const cap = Math.min(maxOverlap, b.length, a.length);
  for (let k = cap; k >= 1; k--) {
    if (b.endsWith(a.slice(0, k))) return a.slice(k);
  }
  return a;
}

/** 续写拼接：已写正文 + 去掉重叠的续写段（模型没写出新内容时原样返回 base） */
export function mergeContinuation(base: string, addition: string, maxOverlap = 200): string {
  const b = String(base ?? '');
  const trimmed = overlapTrim(b, addition, maxOverlap);
  return b + trimmed;
}

/** 埋点/日志用的原因码：PARTIAL_LENGTH | PARTIAL_UNCLOSED | PARTIAL_MID_SENTENCE */
export function incompleteCode(reason: IncompleteReason | null): string | null {
  return reason ? 'PARTIAL_' + reason.toUpperCase() : null;
}

/** 未闭合标记的位置（栈式配对；ASCII 直引号按奇偶取最后一个）——用于判断"断点是不是真在括号里" */
export function unclosedPositions(raw: string): Array<{ marker: string; at: number }> {
  const s = String(raw ?? '');
  const out: Array<{ marker: string; at: number }> = [];
  for (const [open, close] of PAIRS) {
    const stack: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === open) stack.push(i);
      else if (ch === close && stack.length) stack.pop();
    }
    for (const i of stack) out.push({ marker: open + close, at: i });
  }
  if (countOf(s, '"') % 2 === 1) out.push({ marker: '""', at: s.lastIndexOf('"') });
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 未闭合的标记是不是**落在尾部窗口里**——也就是"真的写到一半被截断"，
 * 而不是"正文中段有个落单的开括号/开引号"（后者续写补不回来，只会换来一段重讲）。
 *
 * 为什么需要这条：`unclosed` 一直是自动续写的**真截断**通道（2026-09-19 只收窄了 `mid_sentence`），
 * 但它在无限制链路上被一个**格式习惯**高频命中——模型用两个开引号框台词（`“台词……“`），
 * 计数天然不配对（取证见 `temp/rp-rep-cf8077d3/`）。这类"中段落单"每轮都被续满 2 次、且 2 次之后
 * 仍然 unclosed（`data/server-err.log` 里 8 条 `回复仍不完整（unclosed，续写 2 次）`）。
 *
 * @param window 尾部窗口长度（默认 120 字）：落单的开启符在这个范围内 = 断在它里面 = 真截断
 */
export function unclosedNearTail(raw: string, window = 120): boolean {
  const s = stripTrailingDecoration(String(raw ?? ''));
  const pos = unclosedPositions(s);
  if (!pos.length) return true; // 已经配对了（调用方一般不会走到这里）：没有"格式问题"的证据，不改变行为
  return pos.some((p) => s.length - p.at <= window);
}

/**
 * **自动续写的触发闸**（2026-09-19 收窄；起因见 `temp/rp-rep-8f17a9ac/` 的诊断报告）。
 *
 * 为什么不能「只要判定没写完就续」：
 *   `mid_sentence`（结尾没句末标点）在无限制链路（27B abliterated）上是**收尾习惯**，不是截断——
 *   实测该链路 11% 的回合命中、个别用户 6/9 命中，而且**续满 2 次后仍然不完整**
 *   （服务端日志：`仍不完整（mid_sentence，续写 2 次）`）。也就是说：这类续写收益极低，
 *   代价却是**把整篇 2000+ 字正文再喂给弱模型一次**——而那次生成一旦"重讲一遍"，
 *   就会被拼进正文，用户看到的就是大段复读（诊断里 4/9 条命中、最长 1112 字）。
 *
 * 所以只有**真截断**才自动续写：
 *   - `length`（撞上 max_tokens）→ 续；
 *   - `unclosed`（括号/引号没闭合）→ **断点确实落在那对标记里**才续（`unclosedNearTail`）；
 *     中段落单的开启符（模型格式习惯，见 `temp/rp-rep-cf8077d3/` 的 8 条取证）不续；
 *   - `mid_sentence`：上游若**明确说写完了**（`finish_reason=stop`）→ **不续**，交前端提示 + 手动「续写」；
 *     上游没说（拿不到 finish_reason，可能是流被掐断）→ 仍然续。
 *
 * @param opts.midSentence 旧口径开关（`RP_CONTINUE_MID_SENTENCE=1`）——把 mid_sentence 也当成可续，
 *                         用于消融对比与线上止血回滚。
 * @param opts.text        本轮正文：给了才能对 `unclosed` 做"断点是否落在标记里"的判断；
 *                         **不传 = 保持收窄前的 unclosed 口径**（老调用方与老测试不受影响）。
 * @param opts.unclosedWindow 尾部窗口（默认 120 字）。
 */
export function autoContinueEligible(
  reason: IncompleteReason | null,
  finishReason?: string,
  opts: { midSentence?: boolean; text?: string; unclosedWindow?: number } = {},
): boolean {
  if (reason === 'length') return true;
  if (reason === 'unclosed') {
    if (opts.text === undefined) return true;
    return unclosedNearTail(opts.text, opts.unclosedWindow ?? 120);
  }
  if (reason !== 'mid_sentence') return false;
  if (opts.midSentence) return true;
  return String(finishReason || '').trim().toLowerCase() !== 'stop';
}

/**
 * 续写里**逐字抄自已写正文**的最长片段长度（8-gram 连续命中，空白先归一）。
 *
 * 口径与 `temp/rp-rep-8f17a9ac/probe-continuation.mts` 完全一致——那边用它量出过一组关键事实：
 * **真续写抄写 0–9 字，重讲同一拍抄写 150 字以上**。这里只是把它从脚本搬进代码，成为线上判据。
 */
export function longestCopyFrom(base: string, addition: string, gram = 8): number {
  const norm = (s: string) => String(s ?? '').replace(/\s+/g, '');
  const A = norm(base);
  const B = norm(addition);
  if (A.length < gram || B.length < gram) return 0;
  const seen = new Set<string>();
  for (let i = 0; i + gram <= A.length; i++) seen.add(A.slice(i, i + gram));
  let run = 0;
  let longest = 0;
  for (let i = 0; i + gram <= B.length; i++) {
    if (seen.has(B.slice(i, i + gram))) {
      run += 1;
      longest = Math.max(longest, run + gram - 1);
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * 「续写被判定为重讲」的阈值（逐字抄自已写正文的字数）。
 *
 * 取值依据（都是**实测**，不是拍的）：真续写 0–9 字（`probe-continuation.mts` 8 次探针，
 * 逐字抄写片段全部 0 字）；重讲同一拍 50 / 98 / 141 / 461 字（用户 cf8077d3 的真实落盘，
 * 见 `temp/rp-rep-cf8077d3/修复前后-真实数据核验.txt`）、最长 1112 字（8f17a9ac）。
 * 40 落在两簇之间：离"真续写"的上限观察值（9）有 4 倍以上余量，又能覆盖最小的一例重讲（50 字）。
 * ⚠️ 这是**逐字**判据：措辞微变的重讲（同一拍换个说法）抓不到——那种靠"别触发续写"来避免（见 autoContinueEligible）。
 */
export const CONTINUATION_RETELL_MIN_CHARS = 40;

/** 这段续写是不是"把已经写过的东西再讲一遍"（逐字抄写 ≥ min 字） */
export function continuationIsRetelling(
  base: string,
  addition: string,
  min = CONTINUATION_RETELL_MIN_CHARS,
): { retell: boolean; copied: number } {
  const copied = longestCopyFrom(base, addition);
  return { retell: copied >= min, copied };
}

/**
 * 带**重讲闸**的续写拼接：先按既有口径去掉接缝重叠，再检查剩下的新内容是不是原文的复述。
 * 命中即**丢弃这一段续写**（返回已写正文），并给出 `retell/copied` 供调用方记日志。
 *
 * 为什么必须在这里拦：`overlapTrim` 只剪**接缝处的逐字重叠**（≤200 字），而弱模型的重讲
 * 是"从更早的地方重新铺一遍"——接缝处往往一个字节都不重（措辞微变），于是拼接后正文里
 * 出现两块同一拍的内容。判据见 `continuationIsRetelling`。
 */
export function mergeContinuationGuarded(
  base: string,
  addition: string,
  opts: { maxOverlap?: number; retellMin?: number } = {},
): { text: string; added: string; retell: boolean; copied: number } {
  const b = String(base ?? '');
  const trimmed = overlapTrim(b, addition, opts.maxOverlap ?? 200);
  const { retell, copied } = continuationIsRetelling(b, trimmed, opts.retellMin ?? CONTINUATION_RETELL_MIN_CHARS);
  if (retell) return { text: b, added: '', retell: true, copied };
  return { text: b + trimmed, added: trimmed, retell: false, copied };
}

/**
 * **续写锚点**：喂回模型的"我自己写到哪儿了"只保留尾部 `max` 字（默认 300），不再把整篇正文塞回去。
 *
 * 为什么要改短：续写请求原本把**整条正文**（2000–3000 字）当成模型自己的上一条消息，
 * 于是弱模型很容易把"继续写"理解成"把这一轮再写一遍"，而那种重写会被拼在正文后面 = 复读。
 * 只给尾部一小段，模型能看到的可复述内容就只有这一小段（配合 `overlapTrim` 的 200 字上限，
 * 边界重叠也能被剪掉），结构上不给"重讲整篇"留余地。
 *
 * 切点尽量落在句子边界上；窗口里找不到边界就原样给尾部（宁可切在半句，也不给整篇）。
 */
export function continuationAnchor(partial: string, max = 300): string {
  const s = String(partial ?? '');
  if (max <= 0 || s.length <= max) return s;
  const tail = s.slice(-max);
  const m = tail.match(/[。！？…～!?~”」』）)】]\s*\n?|\n/);
  if (m && m.index !== undefined) {
    const cut = m.index + m[0].length;
    // 至少保留 40 字，避免边界恰好落在窗口最前面时锚点退化成空
    if (cut < tail.length - 40) return tail.slice(cut).replace(/^\s+/, '');
  }
  return tail;
}
