import type { ChatCharacterMeta, ChatSessionMeta } from '../services/api';

/**
 * 进入「聊一聊」时决定默认激活的角色。
 *
 * 行为：默认取「上一次聊天」的角色——即最近一次更新会话所属的角色。
 * 若 chatSessionId 指定了某个会话，则以该会话所属角色为准（保证展示角色与打开的会话一致）。
 * 置顶只影响会话列表排序，不代表「最近」，因此按 updatedAt 取最大（忽略置顶）。
 * 若目标角色已被删除/不存在，则回落到默认角色（小愈）。
 */
export function pickActiveCharacter(
  chars: ChatCharacterMeta[],
  sessions: ChatSessionMeta[],
  chatSessionId?: string | null,
): ChatCharacterMeta | null {
  let target: ChatSessionMeta | null = null;
  if (chatSessionId) {
    target = sessions.find(s => s.sessionId === chatSessionId) || null;
  }
  if (!target) {
    for (const s of sessions) {
      if (!target || new Date(s.updatedAt).getTime() > new Date(target.updatedAt).getTime()) target = s;
    }
  }
  const activeCharId = target ? (target.characterId || 'xiaoyu') : 'xiaoyu';
  const defaultChar = chars.find(c => c.isDefault) || chars[0] || null;
  return chars.find(c => c.id === activeCharId) || defaultChar;
}
