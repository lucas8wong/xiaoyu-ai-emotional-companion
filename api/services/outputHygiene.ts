/**
 * 输出卫生（2026-09-29）：把模型**写进正文的内部思考**挡在用户视线之外。
 *
 * ## 真机取证（就是这一条推动的改动）
 * 用户实测截图里，小愈的回复以这样两段开头：
 *    「上面是对应来源的编号标记……等等，这里没有实时资讯列表的编号。我用的是 web_search。
 *      那我应该直接附链接，不要用编号标记。」
 *    「我重写，去掉编号，直接附链接。」
 * 后面才是真正要说的话。也就是说：模型把「要不要写引用标记」这件事**当成对白说给了用户听**，
 * 顺带暴露了工具名（web_search）、内部规则（编号标记 / 实时资讯列表）和自我更正。
 *
 * 先排除过一个更糟的可能：推理内容被当成正文外发，已确认**不是**。
 * `api/services/deepseek.ts` 的流式循环里 `reasoning_content` 单独累积、从不进 `onToken`，
 * 所以这段文字确实是模型写在 content 里的。
 *
 * ## 三道闸（顺序＝从便宜到贵）
 *   ① 提示词层（主）：明确"只输出对话正文、不写内部思考/自我更正/工具名"（gemini.ts 的 outputHygieneBlock）；
 *   ② 剥：把**开头连续的自言自语**整句剥掉（本文件 `stripLeadingMetaLeak`）；
 *   ③ 重生成：剥完仍命中强特征 → 追加一句纠正重生成一次（gemini 两条回复路径）。
 */

/**
 * 内部规则词：**只有这套规则的用词**才直接判定为自言自语（真机里模型就是围着这几个词打转）。
 * 刻意不含裸「等等」「我应该」，那是正常语气（「等等，你先别急」）；也不含单独的工具名，
 * 因为用户问「web_search 是什么」时小愈解释它是合理的。
 */
const META_RULE = /编号标记|来源标记|标记编号|(实时资讯|资讯)(速览|列表)/;
/** 工具名（需配合「第一人称/指示语开头」才算自言自语，见 isMetaSentence） */
const META_TOOL = /\bweb_?search\b|\bread_url\b|工具调用/i;
/** 明确的自我更正 / 内部动作 */
const META_SELF_FIX = /我(先)?(重写|重新写|重新回答|重新说|再写|重新组织)|(那)?我应该(直接|先|重新)|让我(先)?(检查|核对|确认)一下/;
/** 第一人称 / 指示语开头（「我用的是…」「上面是…」「这里没有…」） */
const META_FIRST_PERSON = /^(嗯+[，,]?\s*)?(那我|我|这|这里|上面|前面|刚才)/;

/**
 * 一句话是不是「内部思考」：
 *   ① 命中内部规则词（编号标记 / 实时资讯速览 …）；
 *   ② 明确的自我更正（我重写 / 那我应该直接 / 让我先检查）；
 *   ③ 工具名 **且** 以第一人称/指示语开头（「我用的是 web_search」）。
 * 三条之外一律当正常正文，宁可漏剥一句，也不要把小愈的话删掉。
 */
function isMetaSentence(s: string): boolean {
  const t = (s || '').trim();
  if (!t) return false;
  if (META_RULE.test(t) || META_SELF_FIX.test(t)) return true;
  return META_TOOL.test(t) && META_FIRST_PERSON.test(t);
}

/** 开头 200 字里出现「内部思考句」 → 认为这条回复混进了自言自语（用于决定要不要重生成） */
export function looksLikeMetaLeak(text: string): boolean {
  const head = String(text || '').slice(0, 200);
  return head.split(/(?<=[。！？!?；;])\s*/).some(isMetaSentence);
}

/**
 * 把**每一段开头连续的自言自语**整句剥掉（段＝气泡）。
 * ⚠️ 只剥开头：正文中间出现「等等」很可能是正常语气（「等等，你别急」），不能动。
 * 剥完某一段变空 → 该段整段丢掉（真机里那段自言自语本身就独占一条气泡）。
 * 返回是否真的改动过（调用方据此决定要不要让前端重建气泡）。
 */
export function stripLeadingMetaLeak(text: string): { text: string; changed: boolean } {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, changed: false };
  const segs = raw.split('\n\n');
  const kept: string[] = [];
  let changed = false;
  for (const seg of segs) {
    // 按句切开（保留标点）：只从**句首连续**剥
    const parts = seg.split(/(?<=[。！？!?；;])\s*/);
    let i = 0;
    while (i < parts.length && isMetaSentence(parts[i])) i++;
    if (i === 0) { kept.push(seg); continue; }
    changed = true;
    const rest = parts.slice(i).join('').trim();
    if (rest) kept.push(rest);
  }
  // 全剥光了 → 交给调用方按「空回复」处理（红线 6：绝不替模型编一句台词）
  return { text: kept.join('\n\n'), changed };
}
