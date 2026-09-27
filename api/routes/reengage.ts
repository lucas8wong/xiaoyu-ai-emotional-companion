/**
 * 召回（re-engagement）管理接口
 *  - POST /api/reengage/run   运营手动触发一次召回循环（默认 dry-run 预览；?apply=1 才真正发送）
 *  - GET  /api/reengage/unsubscribe   用户从邮件里的退订链接进来（无鉴权，凭签名 token）
 *
 * admin 端点沿用 /api/payment/admin 的 ?token= / x-admin-token 鉴权（fail-closed）。
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { runReengagementCycle, sendPushTest, unsubscribeToken, reengageStore, listOutreachSubjects, type EngagementFeature } from '../services/reengage.js';
import { getVapidPublicKey, pushSubscriptionStore } from '../services/push.js';
import { resolveUserId, getAuthUser } from '../services/session.js';
import { accountStore } from '../services/accounts.js';
import { preferenceStore } from '../services/preferences.js';
import { normalizeTimezone } from '../services/timeAnchor.js';

const router = Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) console.warn('⚠️ [Security] ADMIN_TOKEN 未配置：/api/reengage/run 已禁用。');

function isAdmin(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const token = String(req.query?.token || req.headers['x-admin-token'] || '');
  if (!token || token.length !== ADMIN_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(ADMIN_TOKEN, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 手动跑一次召回循环（默认预览，不发送）
 * POST /api/reengage/run?apply=1&limit=20
 */
router.post('/run', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    return;
  }
  const apply = String(req.query?.apply || '') === '1';
  const limit = Number(req.query?.limit || 0);
  try {
    const summary = await runReengagementCycle({ apply, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined });
    // 实际发送时不给前端回传预览（避免敏感文案泄出）；预览模式返回 previews 供运营审阅
    res.json({ success: true, data: { ...summary, mode: apply ? 'apply' : 'dry-run' } });
  } catch (e) {
    console.error('[Reengage] run error:', (e as Error)?.message);
    res.status(500).json({ success: false, error: '召回流程失败' });
  }
});

/**
 * 用户的邮件退订入口（凭签名 token，无需登录）
 * GET /api/reengage/unsubscribe?userId=..&token=..[&src=campaign]
 *
 * 退订状态**全站共用**（reengageStore.optOut）：召回邮件与运营群发（adultCampaign）读同一份名单，
 * 用户说一次「不想再收到」，不该因为换了模块就再来一封。
 * src 只影响落地页文案（召回 vs 产品更新），不影响退订行为。
 */
router.get('/unsubscribe', (req: Request, res: Response): void => {
  const userId = String(req.query?.userId || '');
  const token = String(req.query?.token || '');
  if (!userId || token !== unsubscribeToken(userId)) {
    res.status(400).type('html').send('<html><body style="font-family:sans-serif;background:#FBF6EE;color:#243B2E;padding:40px"><h2>链接无效</h2><p>这个退订链接无法识别，或已过期。你可以直接忽略此类邮件。</p></body></html>');
    return;
  }
  reengageStore.optOut(userId);
  const campaign = String(req.query?.src || '') === 'campaign';
  const back = '<p style="font-size:12px;color:#7A8A80">如果是误点，<a href="/api/reengage/resubscribe?userId='
    + encodeURIComponent(userId) + '&token=' + token + '" style="color:#178353">点这里恢复接收</a>。</p>';
  const body = campaign
    ? '<h2>已退订</h2><p>我们不会再向你发送产品更新邮件了。小愈永远在这里，等你需要的时候。<br/>Every feeling deserves to be understood.</p>'
    : '<h2>已退订</h2><p>我们不会再向你发送这类召回消息了。小愈永远在这里，等你需要的时候。<br/>Every feeling deserves to be understood.</p>';
  res.type('html').send('<html><body style="font-family:sans-serif;background:#FBF6EE;color:#243B2E;padding:40px;text-align:center"><div style="font-size:40px">🌱</div>' + body + back + '</body></html>');
});

/**
 * 恢复接收邮件（退订后反悔 / 误点）；凭同一个签名 token，无需登录。
 * GET /api/reengage/resubscribe?userId=..&token=..
 */
router.get('/resubscribe', (req: Request, res: Response): void => {
  const userId = String(req.query?.userId || '');
  const token = String(req.query?.token || '');
  if (!userId || token !== unsubscribeToken(userId)) {
    res.status(400).type('html').send('<html><body style="font-family:sans-serif;background:#FBF6EE;color:#243B2E;padding:40px"><h2>链接无效</h2><p>这个链接无法识别，或已过期。</p></body></html>');
    return;
  }
  reengageStore.optIn(userId);
  res.type('html').send('<html><body style="font-family:sans-serif;background:#FBF6EE;color:#243B2E;padding:40px;text-align:center"><div style="font-size:40px">🌱</div><h2>已恢复接收</h2><p>谢谢你愿意继续收信。小愈一直在这里。<br/>Every feeling deserves to be understood.</p></body></html>');
});

/**
 * 用户在邮件里点「回到 Xiaoyu」按钮：记录一次「返回」事件，再 302 跳到对应会话。
 * GET /api/reengage/click?userId=..&token=..&to=..
 */
router.get('/click', (req: Request, res: Response): void => {
  const userId = String(req.query?.userId || '');
  const token = String(req.query?.token || '');
  if (!userId || token !== unsubscribeToken(userId)) {
    res.status(400).type('html').send('<html><body style="font-family:sans-serif;background:#FBF6EE;color:#243B2E;padding:40px"><h2>链接已失效</h2><p>你可以直接打开 Xiaoyu 继续使用。</p></body></html>');
    return;
  }
  reengageStore.markReturn(userId);
  let to = String(req.query?.to || '');
  if (!/^https:\/\/myxiaoyu\.com\//.test(to) && !to.startsWith('/')) to = 'https://myxiaoyu.com/';
  res.redirect(302, to);
});

/**
 * 召回统计（控制台「用户行为」用）：每个注册用户的发信/返回/退订情况。
 * GET /api/reengage/admin/stats   （admin ?token= / x-admin-token）
 */
router.get('/admin/stats', (req: Request, res: Response): void => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    return;
  }
  const rows = accountStore.listAll().map((a) => ({
    userId: a.userId,
    username: a.username || null,
    email: a.email,
    hasPushSubscription: pushSubscriptionStore.has(a.userId),
    ...reengageStore.getStats(a.userId),
  }));
  res.json({ success: true, data: rows });
});

/**
 * 前端订阅 PWA 推送：拿到 VAPID 公钥
 * GET /api/reengage/push/vapid
 */
router.get('/push/vapid', (req: Request, res: Response): void => {
  res.json({ success: true, data: { publicKey: getVapidPublicKey() } });
});

/**
 * 保存当前浏览器的推送订阅（按当前会话用户归属）
 * POST /api/reengage/push/subscribe  body: { subscription }
 */
router.post('/push/subscribe', (req: Request, res: Response): void => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    res.status(400).json({ success: false, error: '无效的推送订阅' });
    return;
  }
  const userId = resolveUserId(req);
  if (!userId) {
    res.status(400).json({ success: false, error: '无法识别用户' });
    return;
  }
  const ua = String(req.headers['user-agent'] || '');
  pushSubscriptionStore.add(userId, subscription, ua);
  res.json({ success: true, data: { subscribed: true } });
});

/**
 * 移除当前浏览器的推送订阅（用户关闭「AI 主动找我」时调用）
 * POST /api/reengage/push/unsubscribe  body: { endpoint }
 */
router.post('/push/unsubscribe', (req: Request, res: Response): void => {
  const endpoint = String(req.body?.endpoint || '');
  if (!endpoint) {
    res.status(400).json({ success: false, error: '缺少端点' });
    return;
  }
  const userId = resolveUserId(req);
  pushSubscriptionStore.remove(userId, endpoint);
  res.json({ success: true, data: { unsubscribed: true } });
});

/** 从 User-Agent 粗判平台（仅用于控制台识别电脑/手机） */
function platformFromUa(ua: string): string {
  const u = (ua || '').toLowerCase();
  if (!u) return '未知';
  if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) return 'iOS';
  if (u.includes('android')) return 'Android';
  if (u.includes('windows')) return 'Windows';
  if (u.includes('mac os')) return 'macOS';
  if (u.includes('linux')) return 'Linux';
  return '未知';
}
/** 从 User-Agent 粗判浏览器 */
function browserFromUa(ua: string): string {
  const u = (ua || '').toLowerCase();
  if (!u) return '未知';
  if (u.includes('edg/')) return 'Edge';
  if (u.includes('chrome')) return 'Chrome';
  if (u.includes('firefox')) return 'Firefox';
  if (u.includes('safari') && !u.includes('chrome')) return 'Safari';
  return '未知';
}

/**
 * 列出全部推送订阅及其设备信息（控制台「📱 订阅设备」用，识别电脑/手机/浏览器/何时订阅/皮肤）
 * GET /api/reengage/push/admin/subs   (admin ?token= / x-admin-token)
 */
router.get('/push/admin/subs', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: 'UNAUTHORIZED' }); return; }
  const acc = new Map(accountStore.listAll().map((a) => [a.userId, { username: a.username || null, email: a.email || null }]));
  const rows = pushSubscriptionStore.listAll().map((r) => ({
    userId: r.userId,
    username: (acc.get(r.userId) as any)?.username ?? null,
    email: (acc.get(r.userId) as any)?.email ?? null,
    createdAt: r.createdAt,
    skin: r.skin || null,
    ua: r.ua || null,
    platform: platformFromUa(r.ua || ''),
    browser: browserFromUa(r.ua || ''),
    endpointHost: (() => { try { return new URL(r.subscription.endpoint).host; } catch { return '' } })(),
    endpoint: r.subscription.endpoint,
  }));
  res.json({ success: true, data: rows });
});

/**
 * 设备「打卡」：App 打开时上报当前订阅端点 + 浏览器 User-Agent，
 * 让旧订阅（此前未存 ua）也能在控制台「📱 订阅设备」识别出电脑/手机。
 * POST /api/reengage/push/device   body: { endpoint }
 */
router.post('/push/device', (req: Request, res: Response): void => {
  const endpoint = String((req.body || {}).endpoint || '');
  const ua = String(req.headers['user-agent'] || '');
  if (!endpoint || !ua) { res.json({ success: true, updated: false }); return; }
  const updated = pushSubscriptionStore.setUaByEndpoint(endpoint, ua);
  res.json({ success: true, updated });
});

/**
 * 推送前试（PWA）订阅与「AI 主动找我」偏好管理
 *  - 前端订阅 PWA 推送：拿到 VAPID 公钥
 *  - 对象级静音 / 安静时段 / 时区（供「主动找我」开高频 + 分散）
 *  - 测试推送
 */

/**
 * 当前登录用户的「主动找我」偏好轮廓（静音对象 / 安静时段 / 时区 / 近 30 天对象主动记录）
 * GET /api/reengage/outreach/profile
 */
router.get('/outreach/profile', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  const prefs = preferenceStore.get(userId);
  const prof = reengageStore.getOutreachProfile(userId);
  res.json({
    success: true,
    data: {
      proactivePush: prefs.proactivePush,
      proactiveFrequency: prefs.proactiveFrequency,
      mutedSubjects: prof.mutedSubjects,
      quietHours: prof.quietHours,
      timezone: prof.timezone,
      lastOutreachAt: prof.lastOutreachAt,
    },
  });
});

/**
 * 静音某个对象（聊一聊角色 / 剧本 / 千世书 / 理一理）
 * POST /api/reengage/mute  body: { subjectKey }
 */
router.post('/mute', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  const subjectKey = String(req.body?.subjectKey || '');
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  if (!subjectKey) { res.status(400).json({ success: false, error: '缺少 subjectKey' }); return; }
  reengageStore.muteSubject(userId, subjectKey);
  res.json({ success: true, data: { subjectKey, muted: true } });
});

/**
 * 取消静音对象
 * POST /api/reengage/unmute  body: { subjectKey }
 */
router.post('/unmute', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  const subjectKey = String(req.body?.subjectKey || '');
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  if (!subjectKey) { res.status(400).json({ success: false, error: '缺少 subjectKey' }); return; }
  reengageStore.unmuteSubject(userId, subjectKey);
  res.json({ success: true, data: { subjectKey, muted: false } });
});

/**
 * 当前登录用户的全部「可主动找你」对象（聊一聊角色 / 剧本 / 千世书 / 理一理）+ 静音状态。
 * 用于「AI 主动找我」面板里逐对象设置静音。
 * GET /api/reengage/outreach/subjects
 */
router.get('/outreach/subjects', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  const subjects = listOutreachSubjects(userId).map((s) => ({
    subjectKey: s.key,
    feature: s.feature,
    label: s.senderName && s.contextRef ? `${s.senderName} · ${s.contextRef}` : (s.contextRef || s.senderName || s.feature),
    muted: reengageStore.isSubjectMuted(userId, s.key),
  }));
  res.json({ success: true, data: subjects });
});

/**
 * 设置安静时段（本地 HH:mm ~ HH:mm；空则清除）
 * POST /api/reengage/quiet-hours  body: { start, end }
 */
router.post('/quiet-hours', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  const start = String(req.body?.start || '');
  const end = String(req.body?.end || '');
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  reengageStore.setQuietHours(userId, start, end);
  res.json({ success: true, data: { quietHours: (start && end) ? { start, end } : null } });
});

/**
 * 上报用户本地时区（供安静时段/每日预算准时；同时也是「时间锚」算用户那边"今天"的依据）
 * POST /api/reengage/timezone  body: { timezone }
 */
router.post('/timezone', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  const timezone = String(req.body?.timezone || '');
  if (!userId) { res.status(401).json({ success: false, error: '需登录' }); return; }
  reengageStore.setTimezone(userId, timezone);
  // 时间锚也要用它：写进偏好（值没变时不写盘，避免每次打开页面都重写 preferences.json）
  try {
    const valid = normalizeTimezone(timezone);
    if (valid && preferenceStore.get(userId).timezone !== valid) preferenceStore.set(userId, { timezone: valid });
  } catch { /* 忽略：时区只是优化项，失败不影响主流程 */ }
  res.json({ success: true, data: { timezone: timezone || null } });
});

/**
 * 一次性「测试推送」：给指定账号发一条真实 Web Push（跳过流失/冷却筛选），
 * 用最近一次使用场景的角色口吻生成内容。用于确认 Web Push 链路通。
 *  - 目标默认取当前**已登录**会话用户（在「AI 主动找我」面板里点「发一条测试推送」自测）。
 *  - admin 可用 ?userId= 指定任意注册账号（?userId= 需 x-admin-token / ?token=）。
 *  - feature 可选覆盖场景（chat/roleplay/structure/wenyou）。
 * 鉴权：未指定 userId 时必须为登录用户（避免匿名反复触发 DeepSeek 文案生成）；指定 userId 时必须为 admin。
 * POST /api/reengage/push/test  body?: { feature? }   query?: { userId? }
 */
router.post('/push/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const explicit = String(req.query?.userId || req.body?.userId || '');
    let target: string;
    if (explicit) {
      if (!isAdmin(req)) {
        res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
        return;
      }
      target = explicit;
    } else {
      const user = getAuthUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: '需登录后才能发测试推送' });
        return;
      }
      target = user.userId;
    }
    const feature = (req.body?.feature as EngagementFeature | undefined) || undefined;
    const targetId = (req.body?.targetId as string | undefined) || undefined;
    const r = await sendPushTest(target, feature, targetId);
    // 未送达时把「真实原因」放进 error，前端不再显示笼统的「发送失败」
    res.json(r.ok ? { success: true, data: r } : { success: false, data: r, error: r.detail });
  } catch (e) {
    console.error('[Reengage] push/test error:', (e as Error)?.message);
    res.status(500).json({ success: false, error: '测试推送失败' });
  }
});

export default router;
