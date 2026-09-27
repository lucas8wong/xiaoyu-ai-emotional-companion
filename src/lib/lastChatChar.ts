import type { ChatCharacterMeta } from '../services/api';

const KEY = 'cure_last_chat_character';

/** 读取记忆的「上一次聊天角色」，用于进入聊一聊时立即渲染，避免先闪默认小愈再变。 */
export function getLastChatChar(): ChatCharacterMeta | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as ChatCharacterMeta;
    return c && typeof c.id === 'string' ? c : null;
  } catch {
    return null;
  }
}

/** 记录 / 清除上一次聊天角色。 */
export function setLastChatChar(c: ChatCharacterMeta | null): void {
  try {
    if (!c) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* 忽略：localStorage 不可用时仅影响「快速渲染优化」，不影响功能 */
  }
}
