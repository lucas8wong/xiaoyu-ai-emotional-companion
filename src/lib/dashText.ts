/**
 * 破折号「——」的替代口径（唯一实现，前后端共用）
 *
 * 背景（2026-10-02 用户提出）：全库「——」过多，读起来冗余。聊一聊早就禁用它
 * （`api/services/chatVoice.ts`），剧情与文案却没有，于是两种模式口径矛盾——
 * 而仓库的硬教训是「写进提示词的示例会被逐字抄，标点风格同样是示例」。
 *
 * ## 替代规则（按功能，一刀切会读不通）
 *   1. 装饰性分隔（整行/整串就是 `—— X ——`）→ `【X】`（注释）或 `· X ·`（界面文案）
 *   2. 行首 / 行尾的单个装饰 `—— ` → 直接去掉
 *   3. 解释、列举（右段含顿号）→ 冒号 `：`
 *   4. 左侧是极短独立答句（≤3 字，如「不是」「有」）→ 句号 `。`
 *   5. 其余停顿、顺承、插入语 → 逗号 `，`（默认）
 *   6. 整行没有中文（英文文案）→ 双破折号收成单个英文破折号 `—`（英文里的正规用法）
 *
 * ## 两个入口
 *   · `rewriteEmDashLine()`：**一次性清扫源文件**用；按完整行判定，效果最好。
 *   · `stripEmDash()`：**运行时兜底**用。模型偶尔复发时，把输出里的「——」换成逗号。
 *     刻意做成上下文无关（纯替换），这样在流式逐 token 调用下也保持一致。
 *     ⚠️ 只用在**模型输出**上；用户自己发的消息一个字都不动。
 */

/** 中文双破折号（两个 U+2014） */
export const EM_DASH = '——'
const EM_DASH_RE = /——/g
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** 左侧取「最后一个停顿标点之后」的小句，用来判断是不是极短独立答句 */
function leftClause(line: string, idx: number): string {
  const before = line.slice(0, idx)
  const cut = Math.max(
    before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'),
    before.lastIndexOf('；'), before.lastIndexOf('，'), before.lastIndexOf('、'),
    before.lastIndexOf('：'), before.lastIndexOf('\n'),
  )
  return before.slice(cut + 1).trim()
}

/** 右侧取到本句结束为止的片段，用来判断是不是列举 */
function rightSegment(line: string, idx: number): string {
  const after = line.slice(idx + 2).trim()
  const m = after.match(/^[^。！？；\n]*/)
  return m ? m[0] : after
}

/** 一处「——」按功能该换成什么 */
export function dashReplacement(line: string, idx: number): string {
  const left = leftClause(line, idx)
  if (left.length > 0 && left.length <= 3) return '。'
  if (rightSegment(line, idx).includes('、')) return '：'
  return '，'
}

/** 一次性清扫用：按整行改写（装饰性分隔单独处理） */
export function rewriteEmDashLine(input: string): string {
  let line = input
  if (!line.includes(EM_DASH)) return line

  // 横线装饰行（整行只有规线字符，如 `/* ———————— */`）→ 换成制表横线 ─，它不是标点
  if (/^[\s/*=─—_-]{4,}$/.test(line)) return line.replace(/—/g, '─')
  // 长横线串（———）先收敛成标准破折号，装饰性标题才不会在 【】 里留下半截横线
  line = line.replace(/—{3,}/g, EM_DASH)

  // 英文行：收成单个 em dash（英文里这才是正规写法）
  if (!CJK_RE.test(line)) return line.replace(EM_DASH_RE, '—')

  // ① 整行就是装饰性分隔：`// —— X ——` / `/* —— X —— */` / `* —— X ——`
  const header = line.match(/^(\s*(?:\/\/+|\/\*+|\*+)?[ \t]*)——[ \t]*(.+?)[ \t]*——([ \t]*(?:\*\/)?[ \t]*)$/)
  // ② 整个字符串就是装饰性分隔：`'—— 或直接说 ——'`
  const ornament = header ? null : line.match(/^(.*["'`])——[ \t]*(.+?)[ \t]*——(["'`].*)$/)

  let s: string
  const title = (v: string) => v.replace(/^[—，\s]+|[—，\s]+$/g, '')
  if (header) s = `${header[1]}【${title(header[2])}】${header[3]}`
  else if (ornament) s = `${ornament[1]}· ${title(ornament[2])} ·${ornament[3]}`
  else {
    // ③ 行首 / 行尾的单个装饰
    s = line.replace(/^(\s*(?:\/\/+|\/\*+|\*+)[ \t]*)——[ \t]+/, '$1')
    s = s.replace(/[ \t]*——[ \t]*(\*\/)?[ \t]*$/, '$1')
    // 中文里标点两侧不留空格：先把「 —— 」吃成「——」，替换后才不会留下「 ，」
    s = s.replace(/[ \t\u3000]+——/g, '——').replace(/——[ \t\u3000]+/g, '——')
  }

  // ④ 兜底逐处替换（同时清掉「装饰里又夹着——」的残留，保证输出一个都不剩）
  return s.replace(EM_DASH_RE, (_m, offset: number) => dashReplacement(s, offset))
}

/** 运行时兜底：上下文无关，纯把「——」换成标点；只用于模型输出 */
export function stripEmDash(text: string): string {
  if (!text || !text.includes(EM_DASH)) return text
  const zh = CJK_RE.test(text)
  return text.replace(EM_DASH_RE, () => (zh ? '，' : '—'))
}
