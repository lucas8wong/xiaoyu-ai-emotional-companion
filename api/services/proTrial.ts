/**
 * 老用户 7 天 Pro 体验（完整 Pro 权益）
 * 面向「现有注册用户」的一次性营销活动：
 * - 在 .env 设置 PRO_TRIAL_DAYS（>0）即启用；
 * - 服务首次启动（data/pro-trial-campaign.json 不存在）时，对 accountStore.listAll()
 *   中「注册用户」（有邮箱且非测试账号）逐个授予 7 天完整 Pro 体验；
 * - 之后不再重复授予（新注册用户不自动获得，作为新品礼由运营决定）。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore } from './accounts.js';
import { quotaStore } from './quota.js';
import { looksLikeTestAccount } from './adminAnalytics.js';

const CAMPAIGN_FILE = dataFile('pro-trial-campaign.json');

export interface ProTrialCampaignFlag {
  days: number;
  grantedTo: number;
  at: number;
}

export function proTrialDays(): number {
  const n = Number(process.env.PRO_TRIAL_DAYS || 0);
  return n > 0 ? n : 0;
}

/** 是否已执行过本轮老用户赠送（幂等） */
export function hasGrantedCampaign(): boolean {
  const flag = readJson<ProTrialCampaignFlag | null>(CAMPAIGN_FILE, null);
  return !!flag && typeof flag.grantedTo === 'number';
}

/**
 * 一次性对「现有注册用户」授予 7 天完整 Pro 体验，返回实际授予人数。
 * @returns 执行过则返回 -1（已有 flag），否则返回授予人数。
 */
export function grantProTrialToExisting(days = proTrialDays()): number {
  if (days <= 0) return 0;
  if (hasGrantedCampaign()) return -1;

  const accounts = accountStore
    .listAll()
    // 只发「注册用户」= 有邮箱且非测试账号；游客（无邮箱）不发
    .filter((a) => a.email && !looksLikeTestAccount(a));

  let grantedTo = 0;
  for (const acc of accounts) {
    quotaStore.grantProTrial(acc.userId, days);
    grantedTo += 1;
  }
  writeJson(CAMPAIGN_FILE, { days, grantedTo, at: Date.now() });
  console.log(`🎁 [ProTrial] 已为 ${grantedTo} 位现有注册用户授予 ${days} 天完整 Pro 体验`);
  return grantedTo;
}

/** 启动时自动调用：有天数且未执行过才执行 */
export function maybeGrantProTrialOnStartup(): void {
  const days = proTrialDays();
  if (days <= 0) return;
  if (hasGrantedCampaign()) return;
  grantProTrialToExisting(days);
}
