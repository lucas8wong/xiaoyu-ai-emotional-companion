/**
 * 剧情「模式」的单一真源（2026-10-01 双模式）
 *
 * 为什么单独一个零依赖模块：服务端（会话存储 / 路由 / 生成）与前端（详情页模式开关、存档读存）
 * **必须用同一份判据**。各写一套的后果很实际：路由把 `mode` 认成 solo、前端按 multi 读档，
 * 用户就会看到「我刚演的多角色线不见了」。
 *
 * 取值只有两个：`solo`（只有主角 AI，原有行为）/ `multi`（cast 同场，逐角色气泡）。
 * 认不出的一律回落 `solo`，与「老数据没有 mode ⇒ 当 solo」同一条口径。
 */
export type RoleplayMode = 'solo' | 'multi';

/** 老数据 / 老客户端的默认档 */
export const DEFAULT_ROLEPLAY_MODE: RoleplayMode = 'solo';

/** 解析请求里的 mode（严格只有 'multi' 才算多角色；其余一律 solo） */
export function parseRoleplayMode(v: unknown): RoleplayMode {
  return String(v ?? '').trim().toLowerCase() === 'multi' ? 'multi' : DEFAULT_ROLEPLAY_MODE;
}

/** 两部模式的中文短名（日志/埋点用；界面文案走 i18n，不要用这里） */
export const ROLEPLAY_MODE_LABEL: Record<RoleplayMode, string> = { solo: '单角色', multi: '多角色' };
