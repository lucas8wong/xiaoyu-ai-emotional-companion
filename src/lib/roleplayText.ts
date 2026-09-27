/**
 * 剧情模式「内容类型」分词（纯函数，无 DOM / 无请求，便于单测）
 *
 * 背景（2026-09 用户提出）：剧情模式的 AI 回复此前是**裸文本直出**
 * （`RoleplayPage.tsx` 里 `{m.content}` + `whitespace-pre-wrap`），
 * 对白「」、旁白、括号心声（`buildRoleplayInnerMonologueBlock` 鼓励模型写的心理/神态）
 * 三者在视觉上完全同质，用户只能靠"那个括号字符"去辨认。
 *
 * 这里只做**一件事**：把一段文本切成 narration / dialogue / thought 三种片段，
 * 交给 `RoleplayRichText` 上样式。**不改动原文语义**——
 * 复制、落盘、长图分享、TTS（`storyVoice.speakableRoleplayText` 自己会剃括号）一律仍取 `m.content` 原文。
 *
 * 2026-09-17 用户口径修正：「高亮的应该是对白而不是心声」——此前容器（浅底+竖线）给的是心声，
 * 视觉上"被框起来的"反而是心里话，而人物**说出来的话**最轻。现在反过来：
 * **只有对白带容器**（独占一行的对白 = 台词卡），心声退成安静注解（小一号 + 括号淡色）。
 * 这里只负责"是不是独占一行"这个**事实**，谁上什么样式由 `RoleplayRichText` / `.rp-*` 决定。
 *
 * 三条硬约束（都来自实测/现有代码，别"优化"掉）：
 * 1. **不能吞字符**：任何解析分支都只允许"分包"，不允许丢内容。宁可整段判成旁白，
 *    也不能因为一个模型写歪的标记把台词吃掉（与 `storyVoice.dropBalanced` 同一条原则）。
 * 2. **流式容错**：剧情走 SSE 逐 token 追加，解析发生在每个渲染帧上——
 *    末尾出现"未闭合的 （/「/(" 是**常态**。未闭合时按已识别类型渲染（闭合时样式不跳变），
 *    否则用户会看到文字在打字过程中反复"变灰变白"。
 * 3. **对白标记不统一**（提示词侧就自相矛盾：`roleplay.ts` 规则写"人物话语用双引号"，
 *    示例却是 `（他叹了口气）「我在这儿。」`）→ 弯引号 / 直角引号 / 直引号都要认。
 */

export type RpSegmentType = 'narration' | 'dialogue' | 'thought';

export interface RpSegment {
  type: RpSegmentType;
  /** 片段原文（对白/心声**含**标记符本身）——便于按原文断言"没丢字符" */
  text: string;
  /** 对白/心声去掉标记符后的内容（标记符要单独着色时用） */
  inner?: string;
  /** 起始标记（未闭合时也是它，例如流式刚吐出一个「） */
  open?: string;
  /** 结束标记；未闭合时为空串 */
  close?: string;
  /**
   * 该片段**独占一行**（前后只有空白、换行或文本边界）→ 渲染成块级：
   * - **对白** → 台词卡（浅底 + 左竖线）：「说出来的话」是唯一带容器的一档；
   * - **心声** → 安静注解（无底色无竖线，仅小一号 + 括号淡色）。
   * 夹在句子中间的片段只能是行内注解——强行块级会把一句话拆成三段，反而更难读
   * （如「他停下，（她没说话）然后走了」）。
   * ⚠️ 未闭合（流式打字中）恒为 false：闭合那一刻才升级成块级。
   */
  block?: boolean;
}

interface PairDef {
  open: string;
  close: string;
  type: RpSegmentType;
}

/**
 * 标记符表。**全角/半角括号都算心声**（模型两种都会写），
 * 直角引号「」、双直角『』、中文弯引号“”、英文直引号 " 都算对白。
 * 单引号刻意不认：中文文案里的 ' 与英文所有格（'s）会误伤。
 */
const PAIRS: PairDef[] = [
  { open: '（', close: '）', type: 'thought' },
  { open: '(', close: ')', type: 'thought' },
  { open: '「', close: '」', type: 'dialogue' },
  { open: '『', close: '』', type: 'dialogue' },
  { open: '“', close: '”', type: 'dialogue' },
  { open: '"', close: '"', type: 'dialogue' },
];

/** 独占一行的判定里允许的"空白"（含全角空格） */
const BLANK = new Set([' ', '\t', '\u3000', '\r']);

function isBlank(ch: string | undefined): boolean {
  return ch === undefined ? false : BLANK.has(ch);
}

/** 该片段是否整行独占（前后只有空白、换行或文本边界） */
function isOwnLine(s: string, start: number, end: number): boolean {
  let a = start - 1;
  while (a >= 0 && isBlank(s[a])) a -= 1;
  if (a >= 0 && s[a] !== '\n') return false;
  let b = end;
  while (b < s.length && isBlank(s[b])) b += 1;
  return b >= s.length || s[b] === '\n';
}

/**
 * 块级片段会自己换行（`display:block`），因此**把紧邻的空白吞掉**，
 * 否则 `whitespace-pre-wrap` 会把那个 `\n` 也渲染出来 → 卡片上下各多一条空行。
 * 对白与心声一视同仁（谁的 `block` 为真就处理谁）——2026-09-17 起对白也会是块级。
 * 只影响渲染层，原文不动。
 */
function absorbBlockWhitespace(segs: RpSegment[]): RpSegment[] {
  if (!segs.some(x => x.block)) return segs;
  const out = segs.map(x => ({ ...x }));
  for (let k = 0; k < out.length; k++) {
    if (!out[k].block) continue;
    const prev = out[k - 1];
    if (prev && prev.type === 'narration') prev.text = prev.text.replace(/[\s\u3000]+$/, '');
    const next = out[k + 1];
    if (next && next.type === 'narration') next.text = next.text.replace(/^[\s\u3000]+/, '');
  }
  return out.filter(x => x.text.length > 0);
}

/** 一段剧情文本 → 片段数组（旁白/对白/心声） */
export function parseRoleplayText(raw: string): RpSegment[] {
  const s = String(raw ?? '');
  if (!s) return [];

  const segs: RpSegment[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      segs.push({ type: 'narration', text: buf });
      buf = '';
    }
  };

  while (i < s.length) {
    const def = PAIRS.find(p => s.startsWith(p.open, i));
    if (!def) {
      buf += s[i];
      i += 1;
      continue;
    }

    const start = i;
    const sameMarker = def.open === def.close;
    let depth = 1;
    let innerEnd = -1;
    let j = i + def.open.length;

    while (j < s.length) {
      // 同字符标记（英文直引号 "）不嵌套：下一个同字符就是闭合
      if (!sameMarker && s.startsWith(def.open, j)) {
        depth += 1;
        j += def.open.length;
        continue;
      }
      if (s.startsWith(def.close, j)) {
        depth -= 1;
        if (depth === 0) { innerEnd = j; break; }
        j += def.close.length;
        continue;
      }
      j += 1;
    }

    const closed = innerEnd >= 0;
    const end = closed ? innerEnd + def.close.length : s.length;
    flush();
    segs.push({
      type: def.type,
      text: s.slice(start, end),
      inner: s.slice(start + def.open.length, closed ? innerEnd : s.length),
      open: def.open,
      close: closed ? def.close : '',
      block: closed && isOwnLine(s, start, end),
    });
    i = end;
  }
  flush();
  return absorbBlockWhitespace(segs);
}

/** 是否含心声标记（给"首次提示"做轻量探测，避免为了问一句就全量分词） */
export function hasThoughtMarker(raw: string): boolean {
  return /[（(]/.test(String(raw ?? ''));
}
