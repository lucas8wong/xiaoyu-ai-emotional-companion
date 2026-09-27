import type { ChatMessage } from '../services/api';

/**
 * 找「被引用的那条消息」在当前消息列表里的位置（供「点引用块 → 跳回原消息」用）。
 *
 * 为什么不按 id 找：本地刚发出的消息 id 是 `m-<时间戳>-<随机>`，刷新后从服务端读回的历史消息
 * id 会变成 `h-<序号>-<时间戳>`——**同一条消息的 id 会变**（见 src/lib/chatServerMessages.ts）。
 * 跨刷新稳定的只有三样：role、时间戳、内容。所以按下面顺序找：
 *   ① 内容完全一致（助手长回复被拆成多段时，引用的是其中某一段 → 这样能精确落到那一段）；
 *   ② 时间戳 + 角色（**纯图片 / 纯语音**引用没有文字，只能靠这个；同一时间戳多段时再用内容前缀消歧）；
 *   ③ 内容前 12 字前缀兜底（老会话没存 `at` 时用）。
 * 找不到就返回 undefined —— 调用方静默不动，绝不乱跳。
 */
export function findQuotedMessage(
  list: ChatMessage[],
  quote?: { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio'; at?: string }
): ChatMessage | undefined {
  if (!quote) return undefined;
  const body = (quote.content || '').trim();
  const sameRole = (m: ChatMessage) => m.role === quote.role;

  // ① 内容完全一致
  if (body) {
    const exact = list.find((m) => sameRole(m) && (m.content || '').trim() === body);
    if (exact) return exact;
  }

  // ② 时间戳 + 角色
  if (quote.at) {
    const cands = list.filter((m) => sameRole(m) && m.timestamp === quote.at);
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      const head = body.slice(0, 12);
      return (head ? cands.find((m) => (m.content || '').startsWith(head)) : undefined) || cands[0];
    }
  }

  // ③ 前缀兜底
  const head = body.slice(0, 12);
  if (head) return list.find((m) => sameRole(m) && (m.content || '').trim().startsWith(head));
  return undefined;
}
