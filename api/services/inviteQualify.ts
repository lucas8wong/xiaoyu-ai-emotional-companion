/**
 * 邀请结算触发点（B 方案·2026-09-19）
 *
 * 设计：**门槛装在被邀人侧**——邀请人的额度奖励不再在「朋友注册成功」时发，而是等
 * **被邀人第一次真正用了产品**（聊一聊 / 剧情 / 理一理 / 狼人杀任一功能成功跑通）才结算。
 * 这样既取消了「邀请人须注册满 7 天」这道装错方向的闸（业内普遍不设），
 * 又把防刷强度提上去：刷量者必须真的在被邀设备上跑通一次功能，而不是只注册个空号。
 *
 * 被挂在 `activityStore.trackFeature()` 上（所有功能成功路径的唯一收口），同步执行、幂等：
 * `quotaStore.qualifyInvite()` 内部先看 `invitePending`，非待激活的用户直接返回（廉价快路径）。
 *
 * ⚠️ 依赖方向：activity → inviteQualify → quota → {accounts, usage, referralEvents}，
 * 这条链上没有模块反向 import activity，因此是安全的；**不要**在 quota/usage/accounts 里 import activity。
 */

import { quotaStore } from './quota.js';

/** 用户首次真实使用（任一功能成功）时调用；非待激活用户是空操作 */
export function onUserFirstRealUse(userId: string): void {
  if (!userId) return;
  let result: ReturnType<typeof quotaStore.qualifyInvite>;
  try {
    result = quotaStore.qualifyInvite(userId);
  } catch (e) {
    console.warn('⚠️ [Invite] 结算失败(不影响使用):', (e as Error)?.message);
    return;
  }
  if (!result.settled || !result.inviter || result.inviterCredits <= 0) return;
  // 站内恭喜提示由 grantReward 写进 pendingReward（邀请人下次打开就看到）；
  // 邮件异步补一封，失败不影响结算结果。
  import('./rewardNotifier.js')
    .then(({ notifyRewardByEmail }) => notifyRewardByEmail(result.inviter as string, result.inviterCredits, 'invite'))
    .catch(() => { /* 邮件失败不影响奖励已发这一事实 */ });
}

export default onUserFirstRealUse;
