/**
 * 18+ 成年确认（前端侧）
 *
 * 背景：剧情「无限制模式」是成人向内容，服务端只放行「已做过成年确认」的用户
 *       （留痕在 api/services/adultConfirm.ts；未确认时 roleplayUnlimited 一律按关处理）。
 *       前台因此需要一个**显式的确认动作**，而不是把开关藏在设置里点一下就算了。
 *
 * 三种进入路径都收敛到同一次 `confirmAdult()` 调用：
 *   1. 邮件落地页：`?adult=1` → 先弹确认 → 确认后继续原来的深链（见 Home.tsx）；
 *   2. App 内开关：点「无限制模式」→ 弹确认 → 确认后同一次操作真正开启（见 RoleplayPage.tsx）；
 *   3. 未登录时点邮件链接：先记 pending，登录/注册成功后再补交（见 flushAdultPending）。
 *
 * 为什么本地也存一份标记：只为了让 UI 不用每次先问服务端就能知道「大概确认过了」。
 * 权威判定始终在服务端 —— 本地标记被清掉或伪造，最多是多弹一次确认框，不会真的开启模式。
 */

import { confirmAdult } from '../services/api';

const PENDING_KEY = 'cure_adult_pending';
const CONFIRMED_KEY = 'cure_adult_confirmed';

/** 本地是否已确认过（仅用于少弹一次框；不是权威状态） */
export function hasLocalAdultConfirmation(): boolean {
  try { return localStorage.getItem(CONFIRMED_KEY) === '1'; } catch { return false; }
}

export function markLocalAdultConfirmed(): void {
  try { localStorage.setItem(CONFIRMED_KEY, '1'); } catch { /* 忽略 */ }
}

/** 用户在未登录状态下确认了年龄 → 记下来，等登录后再补交服务端留痕 */
export function markAdultPending(): void {
  try { localStorage.setItem(PENDING_KEY, '1'); } catch { /* 忽略 */ }
}

export function isAdultPending(): boolean {
  try { return localStorage.getItem(PENDING_KEY) === '1'; } catch { return false; }
}

export function clearAdultPending(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* 忽略 */ }
}

/**
 * 把「未登录时的确认」补交到服务端（登录/注册成功后调用）。
 * 幂等：无 pending 或提交失败都不抛错（下次登录再试），返回是否成功留痕。
 */
export async function flushAdultPending(source: 'email-campaign' | 'roleplay-toggle' | 'api' = 'email-campaign'): Promise<boolean> {
  if (!isAdultPending()) return false;
  try {
    const r = await confirmAdult(source);
    if (r.success) {
      markLocalAdultConfirmed();
      return true;
    }
  } catch { /* 网络异常 → 保留 pending，下次再补 */ }
  return false;
}
