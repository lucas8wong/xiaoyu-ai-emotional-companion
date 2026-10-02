/**
 * 邀请反馈（用户侧）API
 * GET  /api/referral/summary     —— 当前登录用户的「我的邀请记录」
 * POST /api/referral/invite-code —— 注册后补填预设邀请码（注册时没填的人补领额度，一人一次）
 * POST /api/referral/copied      —— 「我复制了专属邀请链接」上报（运营端看「是否复制过」，一人可多次）
 *
 * 回答用户自己的问题：「有没有人通过我的链接注册？我因此拿到多少额度 / 会员天数？」
 * 数据源与运营端「📣 邀请推广」**同源**（`services/adminReferrals.ts` 的 `buildMyReferralSummary`），
 * 差别只有两点：只返回自己的记录；被邀人身份打码（不外泄完整邮箱）。
 *
 * 未登录（游客设备）也会返回 200：`eligible=false, ineligibleReason='not-account'`，
 * 前端据此显示「注册后邀请好友」而不是报错。
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { resolveUserId } from '../services/session.js';
import { accountStore } from '../services/accounts.js';
import { buildMyReferralSummary } from '../services/adminReferrals.js';
import { quotaStore } from '../services/quota.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { getClientIp } from '../services/geo.js';
import { isSelfExcludedIp } from '../services/selfExclude.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// 补填邀请码限流：预设码很短（可能被爆破枚举），按 IP 固定窗口限次——正常用户一次就够
const limitInviteCode = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, message: '操作过于频繁，请稍后再试' });

router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const resolved = resolveUserId(req);
    // 只用账号 id：游客设备指纹没有邀请资格（规则：邀请人须为注册账号）
    const userId = accountStore.getById(resolved) ? resolved : '';
    const data = buildMyReferralSummary(userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Referral summary error:', error);
    res.status(500).json({ success: false, error: '获取邀请记录失败' });
  }
});

/**
 * POST /api/referral/invite-code  { code }
 * 注册后补填预设邀请码：注册时没填的用户可以补，一人一次。
 * 发放与注册路径完全同源（quotaStore.applyInviteCode → 额度 + inviteCodeUsed + referral-events 台账），
 * 之后发奖励邮件（与注册时同一封模板）。
 */
router.post('/invite-code', limitInviteCode, async (req: Request, res: Response): Promise<void> => {
  try {
    const resolved = resolveUserId(req);
    // 只认登录账号：游客没有「注册时没填」这件事，填了也不算（与 summary 同口径）
    const account = accountStore.getById(resolved);
    if (!account) {
      res.status(401).json({ success: false, code: 'NOT_LOGGED_IN', error: '请先登录后再补填邀请码' });
      return;
    }
    const code = String(req.body?.code || '').trim();
    if (!code) {
      res.status(400).json({ success: false, code: 'INVITE_CODE_EMPTY', error: '请输入邀请码' });
      return;
    }
    if (code.length > 64) {
      res.status(400).json({ success: false, code: 'INVITE_CODE_INVALID', error: '邀请码格式不正确' });
      return;
    }
    const result = quotaStore.applyInviteCode(account.userId, code);
    if (!result.ok) {
      if (result.reason === 'already-used') {
        res.status(400).json({ success: false, code: 'INVITE_CODE_USED', error: '你已经使用过邀请码了' });
      } else {
        res.status(400).json({ success: false, code: 'INVITE_CODE_INVALID', error: '邀请码无效，请检查后重试' });
      }
      return;
    }
    // 与注册同源：发奖励邮件（失败不影响发放，rewardNotifier 内部已兜底）
    const { notifyRewardByEmail } = await import('../services/rewardNotifier.js');
    void notifyRewardByEmail(account.userId, result.bonus, 'invite_code');
    console.log(`🎁 [InviteCode] 注册后补填: code=${code.trim().toLowerCase()} userId=${account.userId.slice(0, 8)} +对话${result.bonus}条`);
    res.json({ success: true, data: { bonus: result.bonus, code: code.trim().toLowerCase() } });
  } catch (error) {
    console.error('Invite code apply error:', error);
    res.status(500).json({ success: false, error: '补填失败，请稍后再试' });
  }
});

/**
 * POST /api/referral/copied  —— 用户端「复制了我的专属邀请链接」上报（2026-09-29）
 *
 * 为什么需要埋点：运营端要能区分三类人——「压根不知道有邀请入口」（一次没复制）、
 * 「复制了但没人注册」（该给话术/激励）、「复制且真的拉来人」。此前只有**结果**（inviteCount），
 * 没有**动作**，所以前两类分不开。
 *
 * 口径与 `/api/pwa/install` 同源：测试/内网设备与运营自查 IP 不记（避免污染）；
 * 识别用户走 resolveUserId（登录→账号，游客→设备指纹+IP 哈希），游客期复制也算，
 * 注册时由 activityStore.mergeFrom 并到账号头上。
 * 只记行为计数，**不影响活跃度分桶**（见 activityStore.trackInviteCopy 的注释）。
 */
router.post('/copied', (req: Request, res: Response): void => {
  const deviceId = String(req.headers['x-device-id'] || '');
  const clientIp = getClientIp(req);
  if (isTestRequest(req.ip, deviceId) || (clientIp && isSelfExcludedIp(clientIp))) {
    res.json({ success: true, recorded: false });
    return;
  }
  const userId = resolveUserId(req);
  if (!userId) {
    res.json({ success: true, recorded: false });
    return;
  }
  const country = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').slice(0, 2);
  activityStore.trackInviteCopy(userId, { ip: clientIp, country });
  res.json({ success: true, recorded: true });
});

export default router;
