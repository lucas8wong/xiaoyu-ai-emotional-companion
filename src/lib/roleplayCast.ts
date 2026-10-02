/**
 * 多角色（群像）剧情的「说话人分段」解析器（纯函数 · 无 DOM / 无请求 · 同构）
 *
 * ## 背景（2026-10-01 多角色试水）
 * 剧情提示词本来就允许模型一次演多人，但输出里没有「谁在说」的标记，前端只能一整段塞进一个气泡。
 * 服务端 `buildMulticastBlock` 补了一行标记协议：**属于某个角色的段落以 `【角色名】` 开头**，
 * 不属于任何人的场景交代不加标记。本模块就是把这段文本切成「一段 = 一个气泡」的唯一实现——
 * 服务端（反重复清单要剃标记）与前端（渲染 / 长图分享 / TTS）共用同一份，避免两处判据漂移。
 *
 * ## 归属规则（三条，都是"宁可退化、不可乱认"）
 * 1. **行首标记换人**：`【名字】` 位于行首（前面只有空白）且名字在名单里 → 从这里开始属于该角色，
 *    直到下一个可识别的行首标记。
 * 2. **空行边界转旁白**：过了一个空行之后，第一个非空白内容若不是标记 → 这一段是**旁白**（speaker=null）。
 *    没有空行时，不带标记的下一行**跟随上一个说话人**（模型的"动作/神态"常写在台词下一行，
 *    用空行把它切成旁白会在视觉上拆开同一个角色的台词与动作）。
 * 3. **名单外一律当正文**：`【某某】` 不在名单里、或 `【` 出现在句子中间 → 原样当正文，
 *    不做"猜名字"正则（避免把正文里的方括号内容误判成说话人）。
 *
 * ## 三条硬约束（与 `roleplayText.ts` 同源，别"优化"掉）
 * 1. **不能吞字符**：没有可识别标记 → 退化成「单段旁白」**原样返回**；
 * 2. **流式容错**：行首出现未闭合的 `【裴` / `【裴修远` 是打字过程中的常态——必须**扣住不渲染**
 *    （否则用户会看到"【裴"闪一下、随即跳到新气泡）；
 * 3. **幂等**：同一段文本在任何时刻解析，已定稿的部分结果一致。
 *
 * ⚠️ 这是**展示层分段**：不改 `m.content` 原文（复制 / 落盘 / 版本切换一律仍取原文）；
 * 长图分享、TTS、反重复清单要的是**没有标记**的文本，走 `stripCastTags`。
 */

export interface CastName {
  id: string;
  name: string;
  avatar?: string;
  /** 是否本剧本主 AI 角色（可被用户自定义名字替换） */
  lead?: boolean;
}

export interface CastSegment {
  /** 这一段的说话人；null = 旁白/场景交代（不属于任何角色） */
  speaker: CastName | null;
  /** 段落正文（**不含** `【名字】` 标记本身） */
  text: string;
}

/** "空白"口径（含全角空格），与 roleplayText.ts 同一份 */
const BLANK = new Set([' ', '\t', '\u3000', '\r']);
const isBlank = (ch: string | undefined): boolean => ch === undefined ? false : BLANK.has(ch);

/** 这个位置能不能起一个标记：前面只有空白且最近的可见字符是换行（或整个文本的开头） */
function isLineStart(s: string, i: number): boolean {
  if (i <= 0) return true;
  let j = i - 1;
  while (j >= 0 && isBlank(s[j])) j -= 1;
  return j < 0 || s[j] === '\n';
}

/** 名单里的名字，长名优先（避免 `翠屏` 被 `翠` 之类的短名前缀抢先） */
function nameList(cast: readonly CastName[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cast || []) {
    const n = String(c?.name || '').trim();
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * 一段多角色文本 → 段落数组。
 * 没有可识别标记时返回 `[{ speaker: null, text: 原文 }]`（调用方据此走原来的单气泡渲染）。
 */
export function parseCastSegments(raw: string, cast: readonly CastName[]): CastSegment[] {
  const s = String(raw ?? '');
  const names = nameList(cast);
  if (!s) return [];
  if (names.length === 0) return [{ speaker: null, text: s }];
  const byName = new Map<string, CastName>();
  for (const c of cast || []) {
    const n = String(c?.name || '').trim();
    if (n && !byName.has(n)) byName.set(n, c);
  }

  const segs: CastSegment[] = [];
  let speaker: CastName | null = null;
  let buf = '';
  const flush = () => {
    const text = buf.trim();
    if (text) segs.push({ speaker, text });
    buf = '';
  };

  let i = 0;
  /** 流式：是否因为"未闭合的标记"扣住了尾巴（扣住时不能再走"没有标记就原样返回"的兜底） */
  let heldBack = false;
  /** 段首：文本开头，或刚过了一个空行 */
  let atParaStart = true;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '【' && isLineStart(s, i)) {
      let hit: string | null = null;
      for (const n of names) {
        if (s.startsWith('【' + n + '】', i)) { hit = n; break; }
      }
      if (hit) {
        flush();
        speaker = byName.get(hit) || null;
        i += hit.length + 2; // 【 + name + 】
        atParaStart = false;
        continue;
      }
      // 流式：行首的「【…」还没闭合，且可能是某个 cast 名的前缀/本身 → 扣住尾巴。
      // 两种都要：`【裴`（名字没写全）与 `【裴修远`（名字写全了、右括号还没到）。
      const rest = s.slice(i + 1);
      if (rest.indexOf('】') === -1 && names.some((n) => n.startsWith(rest) || rest.startsWith(n))) {
        heldBack = true;
        break;
      }
    }

    // 空行之后的第一段内容若不是标记 → 旁白（收紧到"整段"粒度，见文件头规则 2）
    if (atParaStart && !isBlank(ch) && ch !== '\n') {
      flush();
      speaker = null;
      atParaStart = false;
    }

    // 空行判定：`\n` 之后（跳过空白）还是 `\n` → 这是空行，下一段进入"段首"
    if (ch === '\n') {
      let j = i + 1;
      while (j < s.length && isBlank(s[j])) j += 1;
      if (j < s.length && s[j] === '\n') atParaStart = true;
    }

    buf += ch;
    i += 1;
  }
  flush();
  // 结尾被扣住（标记正在打字中）→ 只给已经判定的部分，绝不用"半截标记"去走兜底
  if (heldBack) return segs;
  // 一条标记都没解析出来 → 原样单段（绝不吃字符）
  if (segs.length === 0) return [{ speaker: null, text: s }];
  return segs;
}

/**
 * 剃掉全部可识别的说话人标记 —— 给**要"没有标记"的展面**用：
 * 长图分享（StoryShareModal）、TTS（storyVoice）、反重复清单（collectAvoidPhrases）。
 * 注意不是给主气泡渲染用的（那里要的是分段，见 parseCastSegments）。
 */
export function stripCastTags(raw: string, cast: readonly (CastName | string)[]): string {
  let s = String(raw ?? '');
  if (!s) return s;
  // 只用到名字本身：允许调用方直接传名字数组（服务端 roleplayReply 手里就是 string[]）
  const names = (cast || [])
    .map((c) => (typeof c === 'string' ? c : String(c?.name || '')))
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const n of names) s = s.split('【' + n + '】').join('');
  return s;
}

/** 这份文本是不是多角色分段（至少有一段带说话人）？给调用方做"要不要走群像渲染"的判定 */
export function hasCastSpeaker(segs: readonly CastSegment[]): boolean {
  return segs.some((x) => x.speaker !== null);
}
