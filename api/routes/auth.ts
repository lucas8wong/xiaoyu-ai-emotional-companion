/**
 * 用户认证 API
 * 注册 / 登录 / 邮箱验证码 / 找回密码 / 修改密码 / 登出
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { accountStore } from '../services/accounts.js';
import { sendEmailCode, emailCodeStore } from '../services/email.js';
import { getAuthUser } from '../services/session.js';
import { getClientCountry, getClientIp } from '../services/geo.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { GOOGLE_CLIENT_ID, googleConfigured, verifyGoogleIdToken } from '../services/googleAuth.js';
import { bindGuestAndTrack, grantSignupRewards } from '../services/onboardNewAccount.js';

const router = Router();

// —— 登录/注册/验证码/改密等敏感接口限流（防爆破与轰炸）——
const limitLogin = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: '登录尝试过于频繁，请 10 分钟后再试' });
const limitRegister = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, message: '注册过于频繁，请稍后再试' });
const limitReset = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: '操作过于频繁，请稍后再试' });
const limitSendCode = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: '验证码发送过于频繁，请 10 分钟后再试',
  key: (req) => {
    const email = String(req.body?.email || '').toLowerCase();
    return (getClientIp(req) || 'unknown') + ':' + email;
  },
});

/**
 * 注册
 * POST /api/auth/register { username?, phone?, email, password, ref? }
 * ref = 邀请人的分享码（邀请人 userId 或设备指纹）；被邀请人得注册奖励，邀请人得邀请奖励
 */
router.post('/register', limitRegister, async (req: Request, res: Response): Promise<void> => {
  const { username, phone, email, password, ref, code, inviteCode } = req.body || {};
  const regEmail = String(email || '').trim().toLowerCase();
  const regCode = String(code || '').trim();
  // 邮箱验证码校验：先校验（不消费），注册成功后再消费——
  // 避免注册失败（用户名/邮箱已占用、密码过短等）把验证码白白烧掉，用户需重新获取。
  if (!regCode || !emailCodeStore.peek(regEmail, 'register', regCode)) {
    res.status(400).json({ success: false, error: '邮箱验证码不正确，请先获取验证码并正确填写' });
    return;
  }
  const result = accountStore.register({ username, phone, email, password });
  if (!result.user) {
    res.status(400).json({ success: false, error: result.error || '注册失败' });
    return;
  }
  // 注册成功才消费验证码（一次性）
  emailCodeStore.verify(regEmail, 'register', regCode);

  // 新账号奖励（限时对话额度 / 新人 Pro / 节日礼）——与 Google 建号**共用**同一实现，
  // 见 services/onboardNewAccount.ts；两条入口各写一份是「活动只发一半用户」的事故源头。
  await grantSignupRewards(result.user.userId);

  // 预设邀请码：注册时输入匹配的邀请码 → 额外送对话额度（与注册立得叠加）
  let appliedInviteBonus = 0;
  const inviteCodeStr = String(inviteCode || '').trim();
  if (inviteCodeStr && inviteCodeStr.length <= 64) {
    try {
      const { quotaStore: qs2, getPresetInviteBonus } = await import('../services/quota.js');
      const bonus = getPresetInviteBonus(inviteCodeStr);
      if (bonus > 0) {
        qs2.addChatBonus(result.user.userId, bonus, 'invite_code');
        qs2.setInviteCodeUsed(result.user.userId, inviteCodeStr);
        appliedInviteBonus = bonus;
        // 控制台「📣 邀请推广」台账：邀请码也按区间统计（哪个码被用了几次、发出多少额度）
        qs2.logInviteCodeUse(inviteCodeStr, result.user.userId, bonus);
        console.log(`🎁 [Register] 邀请码奖励: code=${inviteCodeStr} userId=${result.user.userId.slice(0, 8)} +对话${bonus}条`);
        const { notifyRewardByEmail } = await import('../services/rewardNotifier.js');
        notifyRewardByEmail(result.user.userId, bonus, 'invite_code');
      } else {
        console.log(`ℹ️ [Register] 邀请码无效: code=${inviteCodeStr}`);
      }
    } catch (e) {
      console.warn('⚠️ [Register] 邀请码奖励处理失败:', (e as Error)?.message);
    }
  }

  // 邀请（B 方案·2026-09-19）：被邀人（朋友）经链接注册**立刻** +N（对朋友的承诺不变）；
  // 邀请人（分享者）的奖励**等被邀人首次真实使用**才结算（见 quota.qualifyInvite，由 activity.trackFeature 触发）。
  // 注册期只做「时间无关」的反套利：设备/IP 不同（此刻才拿得到双方真实环境）+ 邀请人须为账号 + 未超上限。
  const refStr = String(ref || '').trim();
  if (refStr && refStr.length <= 64) {
    try {
      const { quotaStore, INVITE_BONUS_COUNT } = await import('../services/quota.js');
      const deviceId = String(req.headers['x-device-id'] || '');
      const inviteeIp = getClientIp(req) || '';
      const inviterAccount = accountStore.getById(refStr);
      let inviterUserId: string;
      if (inviterAccount) {
        inviterUserId = inviterAccount.userId;
      } else if (/^[0-9a-f]{32}$/i.test(refStr)) {
        // ref 是已解析的游客稳定 ID（32 位 hex），直接使用，不再重复哈希
        inviterUserId = refStr.toLowerCase();
      } else {
        inviterUserId = quotaStore.identify(refStr, inviteeIp);
      }
      // 记录邀请归属 + 被邀人注册设备/IP（供「设备/IP 不同」反套利与后续会员奖励）
      if (inviterUserId !== result.user.userId) {
        quotaStore.setInvitedBy(result.user.userId, inviterUserId, deviceId, inviteeIp);
      }
      const invite = quotaStore.isReferralValid(result.user.userId);
      if (inviterUserId !== result.user.userId && invite.valid && quotaStore.canInviteMore(inviterUserId)) {
        // 被邀人（朋友）经链接注册立刻多得 +INVITE_BONUS（叠加在注册奖励上）——朋友侧不设门槛
        quotaStore.addChatBonus(result.user.userId, INVITE_BONUS_COUNT, 'invite');
        const { notifyRewardByEmail } = await import('../services/rewardNotifier.js');
        notifyRewardByEmail(result.user.userId, INVITE_BONUS_COUNT, 'invite');
        // 邀请人侧进入「待激活」：等被邀人开口（首次真实使用）才发奖，并写台账供控制台显示
        quotaStore.markInvitePending(result.user.userId, INVITE_BONUS_COUNT);
        console.log(`🎁 [Invite] 被邀人获得引荐奖励: userId=${result.user.userId.slice(0, 8)} +${INVITE_BONUS_COUNT}次；邀请人 ${inviterUserId.slice(0, 8)} 奖励待「被邀人首次使用」结算`);
      } else {
        // 没发奖励也要留痕（控制台要能回答「人来了为什么没算」）：这个判定依赖当时的环境，事后无法还原
        const reason = inviterUserId === result.user.userId
          ? 'self-invite'
          : (!invite.valid ? (invite.reason || 'invalid') : 'inviter-cap-reached');
        quotaStore.logSignupRejected(inviterUserId, result.user.userId, reason);
        if (inviterUserId !== result.user.userId) {
          console.log(`ℹ️ [Invite] 引荐未发放(已记原因): reason=${reason} newUser=${result.user.userId.slice(0, 8)} inviter=${inviterUserId.slice(0, 8)}`);
        }
      }
    } catch (e) {
      console.warn('⚠️ [Invite] 邀请奖励处理失败:', (e as Error)?.message);
    }
  }

  // 设备/IP 记录 + 游客数据并入 + 行为追踪 + 来源归因 —— 与 Google 建号**共用**同一实现
  // （见 services/onboardNewAccount.ts）。抽出来是为了「两台入口天生一致」。
  await bindGuestAndTrack(req, result.user.userId, 'register');

  const token = accountStore.createToken(result.user.userId);
  res.json({ success: true, data: { token, user: accountStore.getPublic(result.user), inviteBonus: appliedInviteBonus } });
});

/**
 * 登录（用户名/手机号/邮箱 任一 + 密码）
 * POST /api/auth/login { account, password }
 */
router.post('/login', limitLogin, async (req: Request, res: Response): Promise<void> => {
  const { account, password } = req.body || {};
  if (!account || !password) {
    res.status(400).json({ success: false, error: '请输入邮箱和密码' });
    return;
  }
  // 登录识别仅用邮箱（手机号/用户名不作登录标识；昵称仅作展示名）
  const user = accountStore.findByEmail(String(account).trim().toLowerCase());
  // Google 建的账号没有密码：给一句明确提示，否则用户只会以为记错了密码、反复重试
  if (user && !accountStore.hasPassword(user)) {
    res.status(401).json({ success: false, error: '该账号使用 Google 登录，请点「用 Google 继续」；或用「忘记密码」设置一个密码' });
    return;
  }
  if (!user || !accountStore.verifyPassword(user, String(password))) {
    res.status(401).json({ success: false, error: '邮箱或密码错误' });
    return;
  }
  // 游客数据并入账号：登录前以游客身份使用的额度/会话/记忆/偏好全部保留
  try {
    const deviceId = String(req.headers['x-device-id'] || '');
    if (deviceId) {
      const { quotaStore: qs } = await import('../services/quota.js');
      const guestId = qs.identify(deviceId, getClientIp(req) || '');
      const { mergeGuestData } = await import('../services/mergeGuest.js');
      mergeGuestData(guestId, user.userId);
    }
  } catch (e) {
    console.warn('⚠️ [Login] 游客数据合并失败:', (e as Error)?.message);
  }

  // 记录本账号最近一次设备/IP（供其作为邀请人时的「设备/IP 不同」比较）
  try {
    const { quotaStore: qs } = await import('../services/quota.js');
    qs.noteDevice(user.userId, String(req.headers['x-device-id'] || ''), getClientIp(req) || '');
  } catch { /* 忽略 */ }

  // 行为追踪：登录成功
  try {
    const { activityStore } = await import('../services/activity.js');
    activityStore.trackLogin(user.userId, { method: 'login', ip: getClientIp(req), country: getClientCountry(req) });
  } catch { /* 追踪失败不影响登录 */ }

  const token = accountStore.createToken(user.userId);
  res.json({ success: true, data: { token, user: accountStore.getPublic(user) } });
});

/**
 * Google 一键登录 / 注册
 * POST /api/auth/google { credential, defaultName? }
 *
 * credential = 前端 Google Identity Services 返回的 ID token（JWT），服务端验签后取 sub/email。
 * 三种分支：
 *   ① 该 Google 账号已绑定过 → 直接登录；
 *   ② 邮箱已存在 → 绑定 Google 后登录（安全性：该邮箱在注册时已用验证码证明过归属，
 *      且 Google 侧 email_verified=true，两边都证明「这个人拥有这个邮箱」）；
 *   ③ 都不存在 → 建号（无密码），并发放入驻奖励。
 *
 * 返回结构与 /login 完全一致（token + user），前端无需分支处理。
 */
router.post('/google', limitLogin, async (req: Request, res: Response): Promise<void> => {
  if (!googleConfigured) {
    res.status(503).json({ success: false, error: 'Google 登录尚未配置' });
    return;
  }
  const credential = String((req.body || {}).credential || '');
  if (!credential) {
    res.status(400).json({ success: false, error: '缺少 Google 登录凭据' });
    return;
  }
  const verdict = await verifyGoogleIdToken(credential);
  if (!verdict.ok) {
    res.status(401).json({ success: false, error: verdict.error || 'Google 登录失败' });
    return;
  }
  const { sub, email, name } = verdict.claims;

  let user = accountStore.findByGoogleSub(sub);
  let isNewAccount = false;
  if (!user) {
    const byEmail = accountStore.findByEmail(email);
    if (byEmail) {
      if (!accountStore.linkGoogle(byEmail.userId, sub)) {
        res.status(409).json({ success: false, error: '该 Google 账号已绑定其它账户，请联系我们处理' });
        return;
      }
      user = accountStore.findByGoogleSub(sub) || byEmail;
      console.log(`🔗 [Google] 已绑定既有账号: userId=${user.userId.slice(0, 8)}`);
    } else {
      // 昵称优先用 Google 资料里的名字；没有就用前端按界面语言传来的兜底名
      const created = accountStore.createOAuthAccount({
        email,
        googleSub: sub,
        username: name || String((req.body || {}).defaultName || ''),
      });
      if (!created.user) {
        res.status(400).json({ success: false, error: created.error || '创建账号失败' });
        return;
      }
      user = created.user;
      isNewAccount = true;
      console.log(`🆕 [Google] 新建账号: userId=${user.userId.slice(0, 8)}`);
    }
  }

  // 与邮箱注册共用同一套收尾（设备记录 / 游客数据并入 / 行为追踪 / 来源归因）
  await bindGuestAndTrack(req, user.userId, isNewAccount ? 'register' : 'google');
  if (isNewAccount) await grantSignupRewards(user.userId);

  const token = accountStore.createToken(user.userId);
  res.json({ success: true, data: { token, user: accountStore.getPublic(user), isNew: isNewAccount } });
});

/**
 * 发送邮箱验证码
 * POST /api/auth/send-code { email, purpose: 'reset' | 'register' }
 */
router.post('/send-code', limitSendCode, async (req: Request, res: Response): Promise<void> => {
  const { email, purpose } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    res.status(400).json({ success: false, error: '邮箱格式不正确' });
    return;
  }
  const p = purpose === 'register' ? 'register' : 'reset';

  // 找回密码时，邮箱必须已注册
  if (p === 'reset' && !accountStore.findByEmail(String(email))) {
    res.status(404).json({ success: false, error: '该邮箱尚未注册' });
    return;
  }
  // 注册时，邮箱不能已注册
  if (p === 'register' && accountStore.findByEmail(String(email))) {
    res.status(409).json({ success: false, error: '该邮箱已注册，请直接登录' });
    return;
  }

  const result = await sendEmailCode(String(email), p);
  if (!result.ok) {
    res.status(500).json({ success: false, error: `验证码发送失败：${result.detail}` });
    return;
  }
  res.json({
    success: true,
    data: {
      message: '验证码已发送到邮箱（5分钟内有效）',
    }
  });
});

/**
 * 找回密码（邮箱验证码验证后重置）
 * POST /api/auth/reset-password { email, code, newPassword }
 */
router.post('/reset-password', limitReset, async (req: Request, res: Response): Promise<void> => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) {
    res.status(400).json({ success: false, error: '请完整填写邮箱、验证码和新密码' });
    return;
  }
  if (String(newPassword).length < 6) {
    res.status(400).json({ success: false, error: '新密码至少6位' });
    return;
  }
  const user = accountStore.findByEmail(String(email));
  if (!user) {
    res.status(404).json({ success: false, error: '该邮箱尚未注册' });
    return;
  }
  if (!emailCodeStore.verify(String(email), 'reset', String(code))) {
    res.status(400).json({ success: false, error: '验证码错误或已过期' });
    return;
  }
  accountStore.changePassword(user.userId, String(newPassword));
  res.json({ success: true, data: { message: '密码已重置，请使用新密码登录' } });
});

/**
 * 修改密码（需登录）
 * POST /api/auth/change-password { oldPassword, newPassword }
 */
router.post('/change-password', limitReset, async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录' });
    return;
  }
  const { oldPassword, newPassword } = req.body || {};
  if (!accountStore.verifyPassword(user, String(oldPassword || ''))) {
    res.status(400).json({ success: false, error: '原密码不正确' });
    return;
  }
  if (String(newPassword || '').length < 6) {
    res.status(400).json({ success: false, error: '新密码至少6位' });
    return;
  }
  accountStore.changePassword(user.userId, String(newPassword));
  res.json({ success: true, data: { message: '密码已修改' } });
});

/**
 * 当前登录用户信息
 * GET /api/auth/me
 */
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '未登录' });
    return;
  }
  res.json({ success: true, data: { user: accountStore.getPublic(user) } });
});

/**
 * 修改用户名（昵称）
 * POST /api/auth/rename { username }
 */
router.post('/rename', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录' });
    return;
  }
  const { username } = req.body || {};
  const result = accountStore.rename(user.userId, String(username || '').trim());
  if (!result.ok) {
    res.status(400).json({ success: false, error: result.error || '改名失败' });
    return;
  }
  res.json({ success: true, data: { message: '昵称已更新', user: accountStore.getPublic(accountStore.getById(user.userId)!) } });
});

/**
 * 注销账户（删除所有个人信息）
 * DELETE /api/auth/account
 */
router.delete('/account', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录' });
    return;
  }
  const userId = user.userId;
  const identity = user.username || user.phone || user.email;

  try {
    // 1. 删除配额/免费记录
    const { quotaStore } = await import('../services/quota.js');
    quotaStore.removeUser(userId);
    // 2. 删除会话（疗愈记录）
    const { memoryStorage } = await import('../storage/memory.js');
    memoryStorage.deleteByUser(userId);
    // 3. 删除心情日记与奖励
    const { diaryStore } = await import('../services/diary.js');
    diaryStore.removeByUser(userId);
    // 4. 删除个性化偏好
    const { preferenceStore } = await import('../services/preferences.js');
    preferenceStore.remove(userId);
    // 5. 删除反馈
    const { feedbackStore } = await import('../services/feedback.js');
    feedbackStore.removeByUser(userId);
    // 5-1. 删除站内信箱（小愈信箱：运营者写给该用户的信）
    const { inboxStore } = await import('../services/inbox.js');
    inboxStore.removeByUser(userId);
    // 5a. 删除长期记忆（用户画像/关键事实）
    const { longMemoryStore } = await import('../services/longMemory.js');
    longMemoryStore.deleteByUser(userId);
    // 5b. 删除角色剧情会话持久化记录
    const { roleplaySessionStore } = await import('../services/roleplaySessions.js');
    roleplaySessionStore.deleteByUser(userId);
    // 5b1. 删除使用时长心跳账本（合规：个人数据删除；此前漏了这条，注销后仍留时长记录）
    const { usageTimeStore } = await import('../services/usageTime.js');
    usageTimeStore.deleteUser(userId);
    // 5b2. 删除角色剧情剧本点赞
    const { roleplayLikeStore } = await import('../services/roleplayLikes.js');
    roleplayLikeStore.deleteByUser(userId);
  try {
    const { activityStore } = await import('../services/activity.js');
    activityStore.remove(userId);
  } catch { /* 忽略 */ }
    // 5c. 删除自建剧本
    const { customRoleplayStore } = await import('../services/customRoleplay.js');
    customRoleplayStore.deleteByUser(userId);
    /**
     * 5c1. 删除聊一聊角色 + 角色成长档案 + 剧情角色的剧情档案副本（2026-09-20 补）
     *
     * 为什么补这三样：它们此前**不在注销清单里** —— 自建角色的身份/底线/口吻、成长档案里的
     * 关系记忆/私人日记/反思/自画像、以及剧情角色从剧情模式迁移过来的场面片段，都是不折不扣的个人数据，
     * 注销后仍然留在 data/ 里（与 2026-09-18 补 usageTime 的那条同类）。
     * ⚠️ 三样必须一起清：只清 storyArchive 而留着 chatCharacter，角色记录里的 `story.digest`
     *    仍然带着那段剧情的摘要（等于没删干净）。
     */
    const { chatCharacterStore } = await import('../services/chatCharacter.js');
    chatCharacterStore.deleteByUser(userId);
    const { chatCharacterGrowthStore } = await import('../services/chatCharacterGrowth.js');
    chatCharacterGrowthStore.deleteByUser(userId);
    const { storyArchiveStore } = await import('../services/storyArchive.js');
    storyArchiveStore.deleteByUser(userId);
    // 5c2. 删除千世书自建剧本
    const { wenyouScenariosStore } = await import('../services/wenyouScenarios.js');
    wenyouScenariosStore.deleteByUser(userId);
    /**
     * 5c3. 注销清理（2026-09-28 审查 P1-8）：以下 6 个 per-user 存储此前**不在注销清单里**，
     * 而注销接口明确回复「所有个人信息已永久删除」——千世书存档（进行中的局 + 命名存档 + 结局）、
     * 浏览器推送订阅（endpoint/keys/UA）、配乐偏好、皮肤记录、召回记录（lastContextRef = 会话/剧本标题）、
     * 狼人杀开局台账，全部属于个人数据，必须一起清。
     */
    const { wenyouSavesStore } = await import('../services/wenyouSaves.js');
    wenyouSavesStore.deleteByUser(userId);
    const { pushSubscriptionStore } = await import('../services/push.js');
    pushSubscriptionStore.removeByUser(userId);
    const { bgmPrefStore } = await import('../services/bgmPrefs.js');
    bgmPrefStore.removeByUser(userId);
    const { skinUsageStore } = await import('../services/skinUsage.js');
    skinUsageStore.removeByUser(userId);
    const { reengageStore } = await import('../services/reengage.js');
    reengageStore.removeByUser(userId);
    const { werewolfLedger } = await import('../services/werewolfLedger.js');
    werewolfLedger.removeByUser(userId);
    // 5d. 删除用量统计（token/成本，per-user 记录）
    const { usageStore } = await import('../services/usage.js');
    usageStore.deleteByUser(userId);
    // 5e. 订阅记录匿名化（保留财务审计，清 userId/stripeCustomerId）
    const { subscriptionStore } = await import('../services/subscription.js');
    subscriptionStore.anonymizeByUser(userId);
    // 5f. 邮箱待用验证码清理
    const { emailCodeStore } = await import('../services/email.js');
    emailCodeStore.removeByEmail(user.email);
    // 6. 订单匿名化（保留财务记录，清除用户关联）
    const { paymentStore } = await import('../services/payment.js');
    paymentStore.anonymizeOrders(userId);
    // 7. 注销登录会话并删除账号
    accountStore.revokeAllTokens(userId);
    accountStore.deleteAccount(userId);
    // 8. 控制台审计留痕（独立于用户数据，保留）
    const { auditStore } = await import('../services/audit.js');
    auditStore.log('delete_account', `用户注销账户：${identity || userId.slice(0, 8)}，个人数据已删除`, req.ip || '');

    console.log(`🗑️ [Auth] 用户注销账户: ${identity || userId.slice(0, 8)}，所有个人数据已清除`);
    res.json({ success: true, data: { message: '账户已注销，所有个人信息已永久删除' } });
  } catch (e) {
    console.error('❌ [Auth] 注销账户失败:', e);
    res.status(500).json({ success: false, error: '注销失败，请稍后重试' });
  }
});

/**
 * 登出
 * POST /api/auth/logout
 */
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) accountStore.revokeToken(token);
  res.json({ success: true, data: { message: '已退出登录' } });
});

export default router;
