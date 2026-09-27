/**
 * 邀请反馈（用户侧）API
 * GET  /api/referral/summary     —— 当前登录用户的「我的邀请记录」
 * POST /api/referral/invite-code —— 注册后补填预设邀请码（注册时没填的人补领额度，一人一次）
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

export default router;
