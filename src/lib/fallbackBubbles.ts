/**
 * 失败兜底文案守卫（剧情演绎 / 聊一聊通用）
 *
 * 背景（2026-09-15 线上事故）：AI 请求失败时，前端把「网络好像开小差了…」这类**失败提示**
 * 直接塞进角色消息数组，于是它：
 *   ① 被当成角色台词显示（用户看到「叔叔」突然说网络开小差）；
 *   ② 被剧情会话自动保存写进后端（`data/xiaoyu.sqlite` → `roleplay-sessions.json` 已留 3 处：
 *      1 条 errNetwork + 2 条服务端「生成失败，请稍后重试」）；
 *   ③ 作为「角色说过的话」回灌给模型当上下文，后续回复可能继续顺着它说。
 *
 * 这里把「已知的兜底 / 系统提示文案」集中成一张表，用于：
 *   1. **读历史时剔除**（不再把污染带进新一轮请求）；
 *   2. **写盘前拦截**（双保险）。
 *
 * 只做**整串精确匹配**，不做子串匹配——台词里出现「没听清」三个字是正常的，不能被误删。
 *
 * 补充：**AI 狼人杀**（`src/werewolf/`）不在本表的覆盖范围内，因为它走的是自己的存储
 * （`data/werewolf-games.json` 的对局事件流），**从不写入** `messages` / `chatMessages`，
 * 所以本表「读历史剔除 + 写盘拦截」这两层对它没有作用点。
 * 但它同样受这条红线约束：模型失败时**绝不替角色编台词**，只记一个中性的
 * `turn-failed` 事件（文案 `evTurnFailed`，形如「老周 这一轮没能开口」），
 * 该事件不是角色发言、也不进其他玩家的上下文。见 `engine/rules.ts` 的 `applyFailedTurn()`。
 */

/** 已知兜底/系统提示整串（来源：src/i18n/index.ts 的 errNetwork/errFailed/chatFallback 三语、api/services/safeError.ts 的 FRIENDLY） */
export const LOCAL_FALLBACK_BUBBLES: readonly string[] = [
  // i18n · errNetwork（简 / 繁 / 英）
  '网络好像开小差了，稍后再试试好吗？🌱',
  '網路好像開小差了，稍後再試試好嗎？🌱',
  'Network hiccup — let us try again in a moment 🌱',
  // i18n · errFailed
  '出了点小问题，请再试一次',
  '出了點小問題，請再試一次',
  'Something went wrong, please try again',
  // i18n · chatFallback（聊一聊旧兜底，历史上可能被存进剧情会话）
  '我好像没听清，能再说一遍吗？🌱',
  '我好像沒聽清，能再說一遍嗎？🌱',
  'Sorry, I did not quite catch that. Could you say it again? 🌱',
  // safeError · ai / payment / image / server / generic（服务端错误串曾直接成为角色台词）
  '生成失败，请稍后重试',
  '支付操作失败，请稍后重试',
  '图片处理失败，请稍后重试',
  '服务暂时不可用，请稍后重试',
  '操作失败，请稍后重试',
  /**
   * 额度耗尽的额度/付费文案（2026-09-18 补；**线上真实数据里已留 3 处**，见本文件顶部红线）。
   *
   * 来源：服务端 402 的 `error` 原文（简中，无句号），经前端 `src/services/api.ts` 的
   * `BACKEND_ERROR_EN` / `BACKEND_ERROR_TW` 转译后**带上句号**（繁中那句尾的「。」就是这么来的）。
   * 四种形态（简/繁 × 带/不带句号）都要收，否则整串匹配漏一个写法就等于没收。
   *
   * 为什么必须收：这类文案一旦被当成 assistant 消息落盘，会同时 ① 显示成"角色说的话"
   * ② 回灌给模型当上下文 ③ 永久留在历史里——正是 2026-09-15 那次事故的同一形态。
   * 补进本表后：前端读/写双剔、服务端 `save()` 再挡一层，且 `selfHeal` 的
   * `FALLBACK_IN_HISTORY` 检测器从此能**看见**已存在的那几条（默认只报告、不自动删）。
   */
  '免费次数已用完，请付费解锁后继续使用',
  '免费次数已用完，请付费解锁后继续使用。',
  '免費次數已用完，請付費解鎖後繼續使用',
  '免費次數已用完，請付費解鎖後繼續使用。',
  'You have used up your free chats. Unlock more with membership to continue.',
  /**
   * 聊一聊「空回复」旧兜底（2026-09-20 补；来源 `api/services/gemini.ts` 的
   * `text.trim() || '我在的。慢慢说，我会认真听。🌱'`）。
   *
   * 为什么现在才登记：这段文案 2026-09-19 就被点名过（CHANGELOG「本次只报告不改」），
   * 直到 2026-09-20 才连同**不再伪造台词**一起改掉。登记它是为了**历史数据**：
   * 已经落盘的这类 assistant 消息要能被 `selfHeal` / `chat-voice-scan` / 前端读历史看见并剔掉，
   * 否则它们会一直以"小愈说过的话"的身份回灌给模型。
   *
   * 两种字体形态都要收：`normalizeScriptText` 对 zh-TW 会转繁体；对 en 是**原样返回**——
   * 也就是说英文用户当年收到的正是这句中文（这也是当时那个实现的一个附带缺陷）。
   */
  '我在的。慢慢说，我会认真听。🌱',
  '我在的。慢慢說，我會認真聽。🌱',
  /**
   * 剧情「空回复兜底句」旧文案（2026-09-28 补，审查 P1-1）：来源 api/services/roleplay.ts 的
   * EMPTY_ROLEPLAY_REPLY_FALLBACK（已随红线⑥修复删除）。**线上历史里可能已落盘**，
   * 所以必须登记，供 selfHeal / 前端读历史 / 服务端 save() 三处剔除。
   */
  '他看向你，语气放轻了些。「我在听，你继续。」',
  '他看向你，語氣放輕了些。「我在聽，你繼續。」',
  'He looks at you, his voice lowering a little. “I’m listening. Go on.”',
  /**
   * 主动召回兜底句（2026-09-28 补，审查 P1-2）：来源 api/services/reengage.ts 的 fallbackHook。
   * 只有 chat 档的 body 曾被 appendInAppMessage 当成角色发言写进 chatMessages（现已加闸），
   * 但历史里可能已落盘，必须登记以便读/写两侧剔除。
   */
  '有些话还停在昨天，今天想继续的话，我随时都在。',
  '有些話還停在昨天，今天想繼續的話，我隨時都在。',
  'You left some words unspoken — whenever you’re ready, I’ll be here.',
  /**
   * AI 狼人杀（wolfcha 移植版）的失败文案（2026-09-28 补，审查 P1-3）：来源
   * src/wolfcha 的 dayPhase.timeout / gameMaster.tooManyRequests。超时与限流曾把这几句
   * 当成**角色发言**推入发言队列并落盘（红线⑥，与 src/werewolf 引擎 applyFailedTurn 的
   * 「只发中性事件、不编台词」正好相反）。代码已改为抛失败态，这里登记是为了剔除历史数据。
   */
  '我没啥想说的',
  '我沒啥想說的',
  'I have nothing to say',
  '（请求过于频繁，稍后再试）',
  '（請求過於頻繁，稍後再試）',
  'Too many requests, please try again later.',
];

const FALLBACK_SET = new Set(LOCAL_FALLBACK_BUBBLES.map(s => s.trim()));

/** 这条 assistant 文案是「失败兜底」而不是真实角色发言？ */
export function isFallbackBubble(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const text = content.trim();
  return text.length > 0 && FALLBACK_SET.has(text);
}

/**
 * 剔除历史里的失败兜底气泡。
 * 只动 assistant（兜底永远是「回复侧」）；user 的消息一条都不动。
 */
export function stripFallbackBubbles<T extends { role: string; content: string }>(msgs: T[] | null | undefined): T[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.filter(m => !(m && m.role === 'assistant' && isFallbackBubble(m.content)));
}
