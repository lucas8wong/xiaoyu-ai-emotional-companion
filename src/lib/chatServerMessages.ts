import type { ChatMessage, ChatSource } from '../services/api';
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
/**
 * 合并两组来源并按 URL 去重（保持顺序：段自己的在前，整轮的在后）。
 * 为什么需要：同一段既可能引用速览里的条目（sourceSegments），又可能是整轮搜索命中的那条（sources）。
 */
export function mergeSources(a: ChatSource[], b: ChatSource[]): ChatSource[] {
  const out: ChatSource[] = [];
  for (const s of [...a, ...b]) {
    if (!s?.url || out.some((x) => x.url === s.url)) continue;
    out.push(s);
  }
  return out;
}

export function mapServerMessages(msgs: { role: 'user' | 'assistant'; content: string; timestamp: string; image?: string; audio?: string; replyTo?: { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio' }; sources?: { title: string; url: string; host?: string }[]; sourceSegments?: ({ title: string; url: string; host?: string }[] | null)[] }[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  msgs.forEach((m, i) => {
    // 失败兜底气泡不进列表（只认整串匹配，正常台词里出现「没听清」这类字样不受影响）
    if (m.role === 'assistant' && isFallbackBubble(m.content)) return;
    // 引用回复已落库：刷新/换设备重进时把引用卡一起还原（引用属于「用户那条消息」，分段只针对助手长回复）
    const quote = m.replyTo ? { replyTo: m.replyTo } : {};
    /**
     * 来源（2026-09-29）：两路来源、两种归属，这里都要还原到**实时那条路径**同样的位置——
     *  · `sourceSegments[j]` = 第 j 段（＝第 j 条气泡）**自己引用**的来源 → 挂在那条气泡下；
     *  · `sources` = 整轮（web_search 工具命中）→ 挂在**最后一段**（原来的语义，读者在回复落点看到）；
     *  · 最后一段两者都有时合并去重。
     * ⚠️ 拆分口径必须与写入侧（服务端 matchSnapshotSourcesBySegment）和分段发送器完全一致：
     *    split('\n\n') → trim → 丢空段。口径改了三边都要改，否则来源会挂到错误的气泡上。
     */
    const segSources = m.role === 'assistant' ? (m.sourceSegments || []) : [];
    const turnSources = m.role === 'assistant' ? (m.sources || []) : [];
    /**
     * 段数超出气泡数时的兜底（理论上不该发生）：把多出来的段来源合并回来，绝不静默丢弃。
     * 2026-09-29 实测踩过 —— 那时一旦对不齐，整批来源会被吞掉，用户看到的是「一条来源都没有」。
     */
    const segFrom = (from: number) => {
      const acc: ChatSource[] = [];
      for (let j = from; j < segSources.length; j++) acc.push(...(segSources[j] || []));
      return acc;
    };
    /**
     * 取第 j 段气泡的来源：自己那一段 + 「段数超出气泡数」的溢出部分（`overflowStart` 起）。
     * ⚠️ 只能并**超出**的部分，不能并后面的段 —— 否则前面每条气泡都会把后面所有来源吸过来
     * （2026-09-29 本轮实测踩到，正是用户抱怨的「全挤在最后一条」的另一种形态）。
     */
    const sourcesFor = (j: number, isLast: boolean, overflowStart: number) => {
      const own = mergeSources(segSources[j] || [], segFrom(Math.max(overflowStart, j + 1)));
      return isLast ? mergeSources(own, turnSources) : own;
    };
    if (m.role === 'assistant' && m.content.includes('\n\n')) {
      const parts = m.content.split('\n\n').map(p => p.trim()).filter(Boolean);
      // 全为空白（如只含换行）时回退为原消息，避免把这条回复丢掉
      if (parts.length === 0) {
        const s0 = sourcesFor(0, true, 1);
        out.push({ id: `h-${i}-${m.timestamp}`, role: m.role, content: m.content, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}), ...(m.audio ? { audio: m.audio } : {}), ...quote, ...(s0.length ? { sources: s0 } : {}) });
        return;
      }
      parts.forEach((p, j) => {
        const src = sourcesFor(j, j === parts.length - 1, parts.length);
        out.push({ id: `h-${i}-${j}-${m.timestamp}`, role: 'assistant', content: p, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}), ...(src.length ? { sources: src } : {}) });
      });
      return;
    }
    const single = sourcesFor(0, true, 1);
    out.push({ id: `h-${i}-${m.timestamp}`, role: m.role, content: m.content, timestamp: m.timestamp, ...(m.image ? { image: m.image } : {}), ...(m.audio ? { audio: m.audio } : {}), ...quote, ...(single.length ? { sources: single } : {}) });
  });
  return out;
}
