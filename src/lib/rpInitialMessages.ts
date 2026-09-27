/**
 * 剧情「进入时该用哪份消息」+ 历史消息形状校验（2026-09-17 立，纯函数便于单测钉死）
 *
 * 事故背景（线上用户报「点进某个剧情是空白页」）：`loadSession()` 的返回值被包了一层
 * `stripFallbackBubbles(...)`，而它**永远返回数组**——「没有会话」从 `null` 变成了 `[]`。
 * 调用方写的是 `setMessages(saved || [{ 开场白 }])`：`[]` 是 truthy，兜底分支从此**永不执行**，
 * 于是「第一次进一部没演过的剧情」消息数组为空、开场白被吞，剧情区只剩背景图。
 *
 * 这类 bug 的共同点是「用真值判断数组/字符串的『有没有』」，以及「外部数据没有形状校验」。
 * 所以把规则收敛成两个可以单测的纯函数：
 *   1. `sanitizeMessages()` —— 外部（localStorage / 后端 / 旧版本）来的历史先过形状校验；
 *   2. `pickInitialMessages()` —— 「续演 or 用开场白新建」只认**非空数组**，不认真值。
 */
import type { RoleplayMessage } from '../services/api';

/** 这条消息形状可用吗（role 合法 + content 是字符串）？脏数据一律判 false */
export function isUsableMessage(m: unknown): m is RoleplayMessage {
  if (!m || typeof m !== 'object') return false;
  const rec = m as { role?: unknown; content?: unknown };
  return (rec.role === 'user' || rec.role === 'assistant') && typeof rec.content === 'string';
}

/** 清洗历史消息：丢掉形状不对的条目（一条脏数据不该让整页白屏，也不该被回灌给模型） */
export function sanitizeMessages(msgs: unknown): RoleplayMessage[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.filter(isUsableMessage);
}

/**
 * 进入一部剧情时用哪份消息：
 *   · 存档是**非空数组** → 续演；
 *   · 其它一切情况（null / undefined / [] / 全是脏数据）→ 用本剧开场白新建。
 * ⚠️ 必须按 `.length` 判断——`[] || x` 恒为 `[]`，这正是 2026-09-17 那次线上缺陷的成因。
 */
export function pickInitialMessages(saved: unknown, opening: string): RoleplayMessage[] {
  const clean = sanitizeMessages(saved);
  if (clean.length > 0) return clean;
  return [{ role: 'assistant', content: typeof opening === 'string' ? opening : '' }];
}

/** 详情页「有进行中的剧情」判定：只有**非空且有可用消息**的会话才算有 */
export function hasResumableSession(saved: unknown): boolean {
  return sanitizeMessages(saved).length > 0;
}

/**
 * 会话是不是停在「一条没人接的用户消息」上（= 上一轮 AI 没接上）？
 *
 * 2026-09-18 立（线上用户 Twinkle 报「最后那句话之后 AI 就不再回复了」）：
 * 生成失败、或用户在新回复回来前就关掉页面 /「重新生成」还没出结果，落盘的历史就会以 `user` 结尾。
 * 这种会话以前是**死局**：刷新/重进后既没有失败提示条、也没有重试按钮，界面上就是「AI 再也不回我了」。
 * 进剧情时用它判定，把这个失败态**恢复**出来（只是 UI 状态，绝不写进消息集合 —— 见红线 6）。
 *
 * 只认「非空 + 最后一条是 user」；空会话交给 `pickInitialMessages` 走开场白分支。
 */
export function endsWithUnansweredTurn(msgs: unknown): boolean {
  const clean = sanitizeMessages(msgs);
  return clean.length > 0 && clean[clean.length - 1].role === 'user';
}
