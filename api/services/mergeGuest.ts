/**
 * 游客数据并入账号（注册/登录成功后调用）
 * 把游客期间产生的 配额 / 会话(聊一聊·理一理) / 长期记忆 / 角色剧情会话 / 偏好 / 成年确认 全部带到账号，
 * 避免「游客用了半天、一注册额度清零、聊天记录消失」。
 */

import { quotaStore } from './quota.js';
import memoryStorage from '../storage/memory.js';
import { longMemoryStore } from './longMemory.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import { roleplayLikeStore } from './roleplayLikes.js';
import { preferenceStore } from './preferences.js';
import { adultConfirmStore } from './adultConfirm.js';
import { activityStore } from './activity.js';
import { customRoleplayStore } from './customRoleplay.js';
import { usageTimeStore } from './usageTime.js';

export function mergeGuestData(guestId: string, accountId: string): void {
  if (!guestId || !accountId || guestId === accountId) return;
  quotaStore.mergeFrom(guestId, accountId);
  memoryStorage.reassignUser(guestId, accountId);
  longMemoryStore.reassignUser(guestId, accountId, quotaStore.getMaxMemoryFacts(accountId));
  roleplaySessionStore.reassignUser(guestId, accountId);
  roleplayLikeStore.reassignUser(guestId, accountId);
  // 游客自建角色剧情随注册转到账号，否则「与你的旅程」里自建剧本标题解析不到（显示英文 id）
  customRoleplayStore.reassignUser(guestId, accountId);
  preferenceStore.reassignUser(guestId, accountId);
  // 成年确认（18+ 门槛）随注册并入账号：游客在 App 内确认过，注册后不该再被拦一次
  adultConfirmStore.reassignUser(guestId, accountId);
  activityStore.mergeFrom(guestId, accountId);
  // 使用时长（心跳账本）：游客期记到的秒数随注册并入账号 —— 否则账号侧看起来「一注册就没有使用时长」，
  // 而控制台区间视图里那段时间又挂在游客身份上（2026-09-18 补）
  usageTimeStore.mergeUsers(guestId, accountId);
  console.log(`🔀 [Merge] 游客数据合并完成: ${guestId.slice(0, 8)} -> ${accountId.slice(0, 8)}`);
}
