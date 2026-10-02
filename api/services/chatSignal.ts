/**
 * 聊一聊「交接信号」（2026-09-25 · 用户拍板）
 *
 * ## 为什么不能用关键词判这个
 * 用户原话：「我觉得应该是让 ai 判断，ai 觉得不会回答了，同时传一个判断的 true 之类的逻辑，
 * 然后就触发弹窗这样，如果是用既定的关键词就很不稳定」。
 * **真机取证（就是这条推动的改动）**：用户发「**操我吧**」（自建角色），小愈的回复**完整指了路**
 * （「想玩真的，去剧情演绎，右上角有个『我的偏好』，把无限制模式打开…」），但后端当时的判据里
 * 带一道**用户消息关键词闸**，而那份词表没收「操」⇒ **回复对、按钮没出**。
 * 关键词路线就是这样碎的：词表永远追不上用户的说法。
 *
 * ## 做法：让模型自己传这个 true
 * 与剧情「一拍计划」（`src/lib/beatPlan.ts`）**同一套机制**：模型在**确实做了这次交接**时，
 * 在回复末尾单独一行输出一个标记；服务端把标记**剥掉**（用户看不到）并把"出现过标记"当作
 * **模型自己的判断结果** → 下发 `hint + hintCompact`，前端出直达按钮。
 * 关键词判据降级为**兜底**（模型忘了标记、但话里要件齐全时才用），**用户侧关键词闸整个删掉**。
 *
 * ## 两条红线
 *   1. **标记绝不落进业务消息集合**（AGENTS.md 红线 6：内部标记不是"小愈说过的话"）
 *      ⇒ 落盘 / 下发 / 回灌统一用剥好的 `text`；
 *   2. **剥标记不许吞掉正文**：剥完一个字都不剩 → 判定为"没剥"（宁可留一个标记，也不要把回复清空）。
 */


/* ───────────────── 来源引用标记（2026-09-29 · 第四轮） ───────────────── */

/**
 * 为什么需要标记：来源归属不能靠**文字匹配**。
 *
 * 实测（2026-09-29 用户第三次反馈「给出新闻信息不跟着来源」）：那一轮**确实调用了 web_search**
 * （服务端日志 `🔧 [tool] web_search` 有据），但模型把结果**意译成了自己的话**：标题、域名、URL
 * 一个都没原样出现，于是按标题/域名/URL 的匹配**一条都归不上**，来源行要么空、要么退回整轮堆在最后一条。
 * 结论：归属必须由**模型显式声明**，服务端照单执行；文字匹配只留作兜底。
 *
 * 做法与上面的「交接信号」完全同源：速览条目在提示词里带编号（[1] [2] …），模型转述某一条时
 * 在那句话末尾写上 `[[3]]`；服务端①把它**剥掉**（用户看不到、绝不落盘，红线 6）②据此把该条的
 * 出处挂到**那条气泡**下面。
 */
/** 标记本体（用于探测） */
const CITE_RE = /\[\[\s*(\d{1,2})\s*\]\]/g;
/**
 * 剥离用的规则：标记本体 **+ 中文正文里它前面那个空格**。
 * 为什么连空格一起剥：模型习惯写「…过生日了 [[1]]，粉圈…」，只剥标记会留下「了 ，」这种空隙。
 * ⚠️ 流式过滤器与 extractCitations 必须用**同一条**规则，否则「打字时看到的」和「重进看到的」不一样。
 */
const CITE_STRIP_RE = /(?<=[\u4e00-\u9fff])[ \t]*\[\[\s*\d{1,2}\s*\]\]|\[\[\s*\d{1,2}\s*\]\]/g;
/** 流式过滤要扣住的最大尾长（`[[12]]` 全形 + 余量） */
const CITE_HOLD = 10;

/**
 * 把一条完整回复里的引用标记剥掉，并返回用到的编号。
 * `at` ＝ 标记去掉之后、它在**正文**里的字符偏移，调用方据此判断它属于哪一段（哪条气泡）。
 * 单遍实现：`replace` 回调拿到本次匹配的偏移，减去此前已剥掉的总长度，就是它在正文里的位置。
 */
export function extractCitations(text: string): { text: string; cites: { n: number; at: number }[] } {
  const raw = text || '';
  CITE_RE.lastIndex = 0;
  if (!CITE_RE.test(raw)) return { text: raw, cites: [] };
  const cites: { n: number; at: number }[] = [];
  let removed = 0;
  const out = raw.replace(CITE_STRIP_RE, (full: string, offset: number) => {
    const n = Number(/\[\[\s*(\d{1,2})/.exec(full)?.[1] || 0);
    if (Number.isFinite(n) && n >= 1) cites.push({ n, at: offset - removed });
    removed += full.length;
    return '';
  });
  return cites.length ? { text: out, cites } : { text: raw, cites: [] };
}

/**
 * 流式版：标记可能**被切成多个 delta**，所以扣住「可能是标记开头」的尾巴，完整标记出现时剥掉。
 * 与 createChatHandoffFilter 同一套做法；这里不负责记编号（编号位置在最终正文上重算，更稳）。
 * 用法：`feed(delta)` → 可安全下发的文本；流结束时**必须**调一次 `flush()`。
 */
export function createCitationFilter() {
  let buf = '';
  /**
   * 尾部有多少字符**可能是没写完的标记**，先扣住不发。
   * ⚠️ 2026-09-29 实测踩到的坑：一开始只扣「等于 `[[` 前缀」的尾巴，而模型常把标记切在
   * `[[1` + `]]` 之间，`[[1` 不匹配 `[[` 前缀，于是被直接放出去，用户就看到了半截标记
   * （而且前端 `s.full = 流式文本` 一旦拿到就不再用最终正文，等于标记永久留在气泡里）。
   * 正确判据：尾巴匹配 `[[` + 最多两位数字 + 空白 到结尾，才可能是没写完的标记。
   */
  const tailHold = (s: string): number => {
    // ① **没写完的标记**：`[[` + 最多两位数字 + 最多两个右括号（模型实测会把标记切成 `[[1` + `]]`,
    //    甚至 `[[1]` + `]`，只扣「[[ + 数字」会漏掉后一种，用户就看到半截标记了）；
    // ② 中文后面那个空格（它后面可能就跟一个标记）
    const m = /\[\[\s*\d{0,2}\s*\]{0,2}\s*$|(?<=[\u4e00-\u9fff])[ \t]+$/.exec(s);
    if (!m) return 0;
    return Math.min(m[0].length, CITE_HOLD);
  };
  return {
    feed(delta: string): string {
      buf += delta || '';
      CITE_RE.lastIndex = 0;
      // 与 extractCitations 同一条剥离规则（含「吃掉中文标记前那个空格」）
      if (CITE_RE.test(buf)) { CITE_RE.lastIndex = 0; buf = buf.replace(CITE_STRIP_RE, ''); }
      const hold = tailHold(buf);
      const emit = buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
      return emit;
    },
    flush(): string {
      CITE_RE.lastIndex = 0;
      if (CITE_RE.test(buf)) { CITE_RE.lastIndex = 0; buf = buf.replace(CITE_STRIP_RE, ''); }
      const out = buf; buf = '';
      return out;
    },
  };
}

/** 交接标记（模型输出、服务端剥离；同时接受几种写法，大小写不敏感） */
export const CHAT_HANDOFF_MARK = '[[RP-UNLOCK]]';

/** 容忍写法：RP 与 UNLOCK 之间的分隔符（-/_/空格）、全角方括号、大小写 */
const MARK_RE = /\[\[\s*rp[\s_-]*unlock\s*\]\]/gi;
/** 流式过滤要扣住的最大尾长：标记本身 + 可能的换行/空格 */
const HOLD = 24;
/** 用于尾前缀比较的规范形（小写、无分隔符差异） */
const CANON = '[[rp-unlock]]';

/** 把一条完整回复里的标记剥掉；返回剥好的正文 + 模型有没有给这次交接打标 */
export function extractChatHandoff(text: string): { text: string; handoff: boolean } {
  const raw = text || '';
  MARK_RE.lastIndex = 0;
  const handoff = MARK_RE.test(raw);
  MARK_RE.lastIndex = 0;
  if (!handoff) return { text: raw, handoff: false };
  const stripped = raw.replace(MARK_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  // 红线②：剥完是空的 → 当成没剥（正文优先）
  if (!stripped.trim()) return { text: raw, handoff: true };
  return { text: stripped, handoff: true };
}

/**
 * 流式版：标记可能**被切成好几个 delta**（实测模型常在最后一口气吐出来），
 * 所以必须①扣住"可能是标记开头"的尾部、②在完整标记出现时剥掉并置位。
 * 用法：`feed(delta)` 返回**可以安全下发**的文本；流结束时必须调一次 `flush()` 把扣住的尾巴吐出来。
 */
export function createChatHandoffFilter() {
  let buf = '';
  let seen = false;
  /** 尾部有多少字符可能是标记的开头（前缀匹配）→ 这段先扣住不发 */
  const tailHold = (s: string): number => {
    const n = Math.min(s.length, HOLD);
    const tail = s.slice(s.length - n);
    for (let k = Math.min(n, CANON.length - 1); k >= 1; k--) {
      if (tail.slice(n - k).toLowerCase() === CANON.slice(0, k)) return k;
    }
    return 0;
  };
  return {
    /** 模型有没有给这次交接打标 */
    get handoff(): boolean { return seen; },
    /** 吃一段 delta，返回可以安全下发的文本（可能为空串） */
    feed(delta: string): string {
      buf += delta || '';
      MARK_RE.lastIndex = 0;
      if (MARK_RE.test(buf)) { seen = true; MARK_RE.lastIndex = 0; buf = buf.replace(MARK_RE, ''); }
      const hold = tailHold(buf);
      const emit = buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
      return emit;
    },
    /** 流结束时调用：把扣住的尾巴吐出来（标记本身仍然剥掉） */
    flush(): string {
      MARK_RE.lastIndex = 0;
      if (MARK_RE.test(buf)) { seen = true; MARK_RE.lastIndex = 0; buf = buf.replace(MARK_RE, ''); }
      const out = buf; buf = '';
      return out;
    },
  };
}

/**
 * 模型刚把 TA 引到「剧情 + 无限制模式」的那段话（**单一信号源**）。
 *
 * ⚠️ 这是**兜底**，不是主判据（主判据＝上面的标记）。它只认"要件"：一段话里**同时**出现
 * 那个开关与那个功能区，这正是引导语的构件，比关键词表稳；但实测仍有失手
 * （真机里有一条回复写成「右上角『我的偏好』，去开那个模式试试」，没提剧情 → 要件不齐），
 * 所以标记才是主路径。
 */
export function replySuggestsAdultHandoff(replyText: string): boolean {
  const r = replyText || '';
  if (!r.trim()) return false;
  const sw = /(无限制模式|成人模式|Unlimited mode)/i;
  const place = /(剧情演绎|剧情模式|剧情|剧本|本子|Roleplay|roleplay|story)/i;
  return sw.test(r) && place.test(r);
}
