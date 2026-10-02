/**
 * 新账号落地（signup onboarding），**邮箱注册与 Google 建号两条入口共用同一实现**。
 *
 * 为什么单独抽出来（2026-10）：
 * 注册路径原本散着 7 段收尾动作（注册奖励 / 新人 Pro / 节日礼 / 设备记录 / 游客数据合并 /
 * 行为追踪 / 来源归因）。加 Google 一键登录时若复制一份，日后任何一场活动都只会发一半用户
 *。「改了注册忘了改 Google」是注定会发生的事故。所以两条入口都调这里的函数。
 *
 * 未纳入本模块：预设邀请码 / 邀请链接（ref）奖励仍在 routes/auth.ts 的邮箱注册里
 * （那套带「设备·IP 不同」反套利判定，且与注册表单字段耦合）。**Google 建号暂不支持邀请码**，
 * 日后要做需要把这部分也一并抽出来。
 */

import type { Request } from 'express';
import { getClientCountry, getClientIp } from './geo.js';

/** 入驻奖励标签：日志里区分是邮箱注册还是 Google 建号 */
export type SignupMethod = 'register' | 'google';

/**
 * 发放新账号奖励：限时对话额度 + 新人 Pro 试用 + 节日礼。
 * 三者互相独立、各自 try/catch：任何一项失败都不影响账号本身与其它奖励。
 */
export async function grantSignupRewards(userId: string): Promise<void> {
  // 注册即送（限时活动）：活动期内新账户获得对话额度（chat credit）；游客不享受
  try {
    const { quotaStore, REGISTER_CHAT_BONUS_COUNT } = await import('./quota.js');
    if (quotaStore.isChatBonusActive()) {
      quotaStore.addChatBonus(userId, REGISTER_CHAT_BONUS_COUNT, 'register');
      console.log(`🎁 [Signup] 注册限时奖励: userId=${userId.slice(0, 8)} +对话${REGISTER_CHAT_BONUS_COUNT}条`);
      // 发邮件通知（新账号必有邮箱）
      const { notifyRewardByEmail } = await import('./rewardNotifier.js');
      notifyRewardByEmail(userId, REGISTER_CHAT_BONUS_COUNT, 'register');
    } else {
      console.log('ℹ️ [Signup] 注册限时活动已结束，不发放对话奖励');
    }
  } catch (e) {
    console.warn('⚠️ [Signup] 注册奖励处理失败:', (e as Error)?.message);
  }

  // 新人 Pro 限时活动：注册即送 Pro 天数 + 按 IP 地区语言发恭喜邮件（仅活动期内生效）
  try {
    const { maybeGrantNewcomerProTrial } = await import('./proTrialNewcomer.js');
    const gift = await maybeGrantNewcomerProTrial(userId);
    if (gift.granted) {
      console.log(`🎁 [Signup] 新人 Pro 试用已发放: userId=${userId.slice(0, 8)} emailed=${gift.emailed}`);
    } else if (gift.reason && gift.reason !== 'campaign-inactive') {
      console.log(`ℹ️ [Signup] 新人 Pro 试用未发放 (${gift.reason}): userId=${userId.slice(0, 8)}`);
    }
  } catch (e) {
    console.warn('⚠️ [Signup] 新人 Pro 试用发放失败:', (e as Error)?.message);
  }

  // 节日礼：活动窗口内（.env HOLIDAY_GIFT_*）新注册用户即时获得节日 Pro 赠送。
  // 与运营端批量发放共用同一份 marker（data/holiday-gift.json），不会重复；失败不影响注册。
  try {
    const { maybeGrantHolidayGiftOnRegister } = await import('./holidayGift.js');
    const gift = maybeGrantHolidayGiftOnRegister(userId);
    if (gift.granted) {
      console.log(`🎁 [Signup] 节日 Pro 赠送已发放: userId=${userId.slice(0, 8)} days=${gift.days}`);
    }
  } catch (e) {
    console.warn('⚠️ [Signup] 节日 Pro 赠送发放失败:', (e as Error)?.message);
  }
}

/**
 * 把「这台设备上的游客」并入新账号，并补上设备/IP 记录、行为追踪与来源归因。
 *
 * ⚠️ 只在**建号那一刻**调用（注册 / Google 首次建号）。
 * 老账号的普通登录走 routes/auth.ts 里那条更轻的路径，那里绝不能调本函数，
 * 否则每次登录都会写一次「来源归因」的注册事件。
 */
export async function bindGuestAndTrack(req: Request, userId: string, method: SignupMethod): Promise<void> {
  // 记录本账号注册时的设备/IP（供其日后作为邀请人时的「设备/IP 不同」比较）
  try {
    const { quotaStore } = await import('./quota.js');
    quotaStore.noteDevice(userId, String(req.headers['x-device-id'] || ''), getClientIp(req) || '');
  } catch { /* 忽略 */ }

  // 游客数据并入账号：注册前以游客身份使用的额度/会话/记忆/偏好全部保留
  // 孤儿归因：把「同一设备指纹、不同 IP」的历史游客记录也一并合并（找回 IP 漂移期间的邀请奖励）
  try {
    const deviceId = String(req.headers['x-device-id'] || '');
    if (deviceId) {
      const { quotaStore } = await import('./quota.js');
      const { mergeGuestData } = await import('./mergeGuest.js');
      const targets = new Set<string>();
      // 同一设备指纹下的所有历史游客记录（含当前 IP 与历史不同 IP 的孤儿）
      for (const id of quotaStore.listByDeviceKey(quotaStore.identifyByDevice(deviceId), userId)) {
        targets.add(id);
      }
      // 当前 IP 的游客记录兜底（老记录可能还没打 deviceKey 标签）
      const guestId = quotaStore.identify(deviceId, getClientIp(req) || '');
      if (guestId !== userId) targets.add(guestId);
      for (const id of targets) mergeGuestData(id, userId);
    }
  } catch (e) {
    console.warn(`⚠️ [${method}] 游客数据合并失败:`, (e as Error)?.message);
  }

  // 行为追踪：建号即首次登录
  try {
    const { activityStore } = await import('./activity.js');
    activityStore.trackLogin(userId, { method, ip: getClientIp(req), country: getClientCountry(req) });
  } catch { /* 追踪失败不影响主流程 */ }

  // 来源归因（identify/merge）：把该匿名设备上的 first-touch 落到这个账号上，
  // 否则「注册用户全都像凭空出现」，后续才能回答「哪个渠道带来注册/付费」。
  // 只存渠道维度，不存 IP/邮箱；客户端带来的 first 优先（它在落地那一刻就记下了）。
  try {
    const deviceId = String(req.headers['x-device-id'] || '');
    const { attributionStore } = await import('./attribution.js');
    attributionStore.recordSignup(userId, deviceId, (req.body || {}).attr);
  } catch (e) {
    console.warn(`⚠️ [${method}] 来源归因记录失败:`, (e as Error)?.message);
  }
}
