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
 * 那个开关与那个功能区——这正是引导语的构件，比关键词表稳；但实测仍有失手
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
