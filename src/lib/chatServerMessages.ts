import type { ChatMessage } from '../services/api';
import { isFallbackBubble } from './fallbackBubbles';

/**
 * 把后端返回的消息数组映射为前端 ChatMessage 列表。
 *
 * 小愈「分段连发」是纯前端效果：live 时按 \n\n 把一条 reply 拆成多条气泡；
 * 历史重进时后端返回的是完整一条，这里按同样的 \n\n 规则拆回多段，保证——
 * 「当下实时」与「退出再进 / 刷新」看到的分段效果一致。
 *
 * 另外（2026-09-20 补，红线 6 的**前端读侧**）：整串命中 `fallbackBubbles` 表的 assistant 消息
 * **不渲染**——它们是失败/系统文案，不是小愈说过的话。聊一聊此前只有服务端那句伪造台词、
 * 没有这道过滤，历史里就会把系统文案显示成角色台词（2026-09-15 事故的同一形态）。
 */
export function mapServerMessages(msgs: { role: 'user' | 'assistant'; content: string; timestamp: string; image?: string; audio?: string; replyTo?: { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio' } }[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  msgs.forEach((m, i) => {
    // 失败兜底气泡不进列表（只认整串匹配，正常台词里出现「没听清」这类字样不受影响）
    if (m.role === 'assistant' && isFallbackBubble(m.content)) return;
    // 引用回复已落库：刷新/换设备重进时把引用卡一起还原（引用属于「用户那条消息」，分段只针对助手长回复）
    const quote = m.replyTo ? { replyTo: m.replyTo } : {};
    if (m.role === 'assistant' && m.content.includes('\n\n')) {
      const parts = m.content.split('\n\n').map(p => p.trim()).filter(Boolean);
      // 全为空白（如只含换行）时回退为原消息，避免把这条回复丢掉
      if (parts.length === 0) {
        out.push({ id: `h-${i}-${m.timestamp}`, role: m.role, content: m.content, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}), ...(m.audio ? { audio: m.audio } : {}), ...quote });
        return;
      }
      parts.forEach((p, j) => {
        out.push({ id: `h-${i}-${j}-${m.timestamp}`, role: 'assistant', content: p, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}) });
      });
      return;
    }
    out.push({ id: `h-${i}-${m.timestamp}`, role: m.role, content: m.content, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}), ...(m.audio ? { audio: m.audio } : {}), ...quote });
  });
  return out;
}
