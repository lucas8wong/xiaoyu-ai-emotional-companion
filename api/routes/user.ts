/**
 * 用户端杂项 API：反馈 / 公告 / 个性化偏好
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { safeError } from '../services/safeError.js';
import { resolveUserId, isLoggedIn } from '../services/session.js';
import { resolveUserTimezone } from '../services/requestTimezone.js';
import { feedbackStore } from '../services/feedback.js';
import { accountStore } from '../services/accounts.js';
import { notifyNewFeedback } from '../services/adminNotifier.js';
import { announcementStore } from '../services/announcements.js';
import { preferenceStore, resolveThinkingLevelFor } from '../services/preferences.js';
// 关系档白名单（2026-09-21）：非法值一律**当没传**（不能让它落成 friend —— 那会把用户
// 已经选好的"恋人"静默改回默认；偏好面板是字段级提交，一次手滑不该丢设置）。
import { isRelationKind } from '../services/chatRelation.js';
import { adultConfirmStore, isAdultConfirmed } from '../services/adultConfirm.js';
import { quotaStore } from '../services/quota.js';

const router = Router();

/**
 * 提交用户反馈
 * POST /api/feedback { type, content, contact? }
 */
router.post('/feedback', async (req: Request, res: Response): Promise<void> => {
  const { type, content, contact, context } = req.body || {};
  if (!content || typeof content !== 'string' || content.trim().length < 2) {
    res.status(400).json({ success: false, error: '请填写反馈内容' });
    return;
  }
  const userId = resolveUserId(req);
  const item = feedbackStore.add(userId, type, content, contact, context);
  // 运营提醒：控制台收到反馈即发邮件（fire-and-forget，绝不阻塞/影响用户请求）
  const accounted = isLoggedIn(req) ? accountStore.getById(userId) : undefined;
  void notifyNewFeedback(
    item,
    accounted ? { username: accounted.username || accounted.phone, email: accounted.email } : undefined,
  );
  // 「提交反馈获得额度」：仅已注册登录用户，每天一次（发少量对话额度，作为免费额度用完后的再获取途径）
  let reward: { granted: boolean; count: number } = { granted: false, count: 0 };
  if (isLoggedIn(req)) {
    reward = quotaStore.grantFeedbackReward(userId);
  }
  res.json({
    success: true,
    data: {
      id: item.id,
      message: '感谢你的反馈，我们会认真阅读 💛',
      ...(reward.granted ? { reward } : {}),
    },
  });
});

/**
 * 获取当前公告列表（最多3条，新在前）
 * GET /api/announcement
 */
router.get('/announcement', async (req: Request, res: Response): Promise<void> => {
  const list = announcementStore.list();
  res.json({
    success: true,
    data: list.map(a => ({
      id: a.id,
      // 三语字段：前端按用户语言选择显示
      titleZh: a.titleZh, contentZh: a.contentZh,
      titleTw: a.titleTw, contentTw: a.contentTw,
      titleEn: a.titleEn, contentEn: a.contentEn,
      updatedAt: a.createdAt,
    })),
  });
});

/**
 * 偏好的**生效值**：未做成年确认时，「无限制模式」一律对外视为关。
 *
 * 为什么要单独做这层归一，而不是只挡写入：
 *   存量数据里可能已经有 `roleplayUnlimited: true`（本门槛上线前开启的用户）。
 *   服务端从路由层（roleplay.ts prefAllowedFor）起就不放行，但如果前端仍读到 true，
 *   用户看到的就是「开关明明开着、剧情却没变化」——正是 roleplayModel.ts 里
 *   明确要避免的「用户开了但静默没生效」。所以对外只暴露生效值：
 *   开关显示为关 → 用户点开 → 弹 18+ 确认 → 确认后同一次操作即真正开启。
 */
function effectivePreferences(userId: string) {
  const adultConfirmed = isAdultConfirmed(userId);
  const prefs = preferenceStore.get(userId);
  return { ...prefs, roleplayUnlimited: prefs.roleplayUnlimited === true && adultConfirmed, adultConfirmed };
}

/**
 * 获取我的个性化偏好
 * GET /api/preferences
 *
 * 额外返回 `adultConfirmed`：它**不是**偏好，而是服务端的成年确认留痕（services/adultConfirm.ts）。
 * 前端需要它来决定「点开无限制模式时要不要先弹 18+ 确认」，所以搭在这里一起返回，
 * 省一次请求（该接口本来就在前端缓存里）。写回时由 PUT 侧忽略，不能被客户端改写。
 */
router.get('/preferences', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  res.json({ success: true, data: effectivePreferences(userId) });
});

/**
 * 记录成年确认（18+ 门槛 · 自声明）
 * POST /api/adult-confirm { source? } → { confirmed: true, confirmedAt }
 *
 * 说明：这是**用户自声明**，不是身份核验（产品无证件/出生日期采集）。它的价值在于
 *   ① 让「开启成人向模式」这一步变成一次显式、有留痕的主动动作，而不是一个藏在设置里的开关；
 *   ② 让服务端能在真正路由到去限制模型那一步再挡一次（见 roleplay.ts prefAllowedFor）。
 * 幂等：重复确认不覆盖首次时间。
 */
router.post('/adult-confirm', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  if (!userId) {
    res.status(400).json({ success: false, error: '无法识别用户' });
    return;
  }
  const source = req.body?.source;
  const rec = adultConfirmStore.confirm(userId, source === 'email-campaign' || source === 'roleplay-toggle' ? source : 'api', req.headers['user-agent']);
  res.json({ success: true, data: { confirmed: true, confirmedAt: rec.confirmedAt, loggedIn: isLoggedIn(req) } });
});

/**
 * 保存个性化偏好
 * PUT /api/preferences { tone?, storyStyle?, mode?, language? }
 */
router.put('/preferences', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  const { tone, storyStyle, mode, language, region, intensity, smartFitEnabled, dataEnhance, activityAwareness, chatInnerMonologueEnabled, roleplayInnerMonologueEnabled, roleplayUnlimited, roleplayScriptUnlimited, narrativeStyle, thinkingLevel, assistantVoiceEnabled, roleplayVoiceEnabled, roleplayAmbienceEnabled, roleplayAutoSceneArt, proactivePush, proactiveFrequency, xiaoyuRelation } = req.body || {};
  // 关系档：白名单外的一律 undefined（= 不改），见文件头 import 处的说明
  const safeRelation = isRelationKind(xiaoyuRelation) ? xiaoyuRelation : undefined;
  // 深度思考：max 仅 Pro/Lifetime 可享受；非 Pro（游客/免费/Plus）在此归一化回 high，
  // 避免把「最大」持久化到偏好里，导致前端/后续读取仍显示 max。
  const resolvedThinking = thinkingLevel !== undefined ? resolveThinkingLevelFor(userId, thinkingLevel as any) : undefined;
  /**
   * 硬 18+ 门槛（第一道闸 · 写入侧）：未在服务端留过成年确认时，`roleplayUnlimited: true` **一律不落盘**。
   *
   * 为什么静默降级为 false 而不是返回 400：
   *   偏好接口是「整包写入」，前端一次 savePreferences 可能顺带提交多个字段；
   *   用 400 会让别的字段也一起失败。改成降级 + 回传 adultConfirmed=false，
   *   前端就能就地弹 18+ 确认框，确认后重试同一次写入即可。
   * 注意：这是**兜底**，不是唯一防线——真正的关卡在 roleplay.ts prefAllowedFor（路由到去限制模型那一步），
   * 因为偏好文件可能被直连请求或历史数据改成 true。
   */
  const adultConfirmed = isAdultConfirmed(userId);
  const safeUnlimited = roleplayUnlimited === true && !adultConfirmed ? false : roleplayUnlimited;
  // 剧本生成的「用无限制模型」走**同一套双闸**：未过 18+ 确认就不落盘，
  // 且读取侧 roleplay.ts 的 prefAllowedFor 会再挡一次。两个开关语义一致，用户不会困惑。
  const safeScriptUnlimited = roleplayScriptUnlimited === true && !adultConfirmed ? false : roleplayScriptUnlimited;
  /**
   * 叙事模式（2026-09-25 C 方案）：白名单两个取值，别的一律当"没传"（= 不改）。
   * 与 adult 闸无关：它只决定篇幅与语体，不涉及内容尺度。
   */
  const safeNarrativeStyle = narrativeStyle === 'classic' || narrativeStyle === 'immersive' ? narrativeStyle : undefined;
  /**
   * 注意 `roleplayUnlimitedByScenario`（单剧本的无限制模式选择，见 preferences.ts）**不在这里写**：
   * 它是一张表，从前端整包提交会因漏带而覆盖掉别的剧本的选择；只由
   * POST /api/roleplay/unlimited → preferenceStore.setUnlimitedForScenario 读-合并-写。
   * 这里既不解构也不回写它 → set() 会原样保留已存的那张表。
   */
  const prefs = preferenceStore.set(userId, { tone, storyStyle, mode, language, region, intensity, smartFitEnabled, dataEnhance, activityAwareness, chatInnerMonologueEnabled, roleplayInnerMonologueEnabled, roleplayUnlimited: safeUnlimited, roleplayScriptUnlimited: safeScriptUnlimited, ...(safeNarrativeStyle ? { narrativeStyle: safeNarrativeStyle } : {}), thinkingLevel: resolvedThinking, assistantVoiceEnabled, roleplayVoiceEnabled, roleplayAmbienceEnabled, roleplayAutoSceneArt, proactivePush, proactiveFrequency, xiaoyuRelation: safeRelation });
  res.json({ success: true, data: { ...prefs, roleplayUnlimited: prefs.roleplayUnlimited === true && adultConfirmed, roleplayScriptUnlimited: prefs.roleplayScriptUnlimited === true && adultConfirmed, adultConfirmed } });
});

/**
 * 获取我的长期记忆（记忆管理，P1-09b；登录/游客按本人身份）
 * GET /api/memory → { facts: string[], entries: [{text, at, kind, dateKey?, atApprox?, stale?}] }
 * entries 让前端能显示「记住于 X」（时间轴，2026-09-17）；facts 保留给旧调用方。
 */
router.get('/memory', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  const { longMemoryStore, toEntryView } = await import('../services/longMemory.js');
  const { todayKeyIn } = await import('../services/timeAnchor.js');
  const todayKey = todayKeyIn(resolveUserTimezone(req, userId) || '');
  const entries = longMemoryStore.getEntries(userId).map((e) => toEntryView(e, todayKey));
  res.json({ success: true, data: { facts: entries.map((e) => e.text), entries } });
});

/**
 * 删除一条长期记忆（按索引，仅本人，P1-09b）
 * DELETE /api/memory/:index → { facts: string[] }（删除后的最新列表）
 * 可选 ?characterId=：指定删除某个角色维度（聊一聊自定义角色）的记忆；缺省为内置小愈。
 */
router.delete('/memory/:index', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ success: false, error: '无效的记忆索引' });
    return;
  }
  const { longMemoryStore, toEntryView } = await import('../services/longMemory.js');
  const { todayKeyIn } = await import('../services/timeAnchor.js');
  const characterId = typeof req.query.characterId === 'string' && req.query.characterId ? req.query.characterId : undefined;
  if (!longMemoryStore.removeFact(userId, index, characterId)) {
    res.status(404).json({ success: false, error: '记忆不存在' });
    return;
  }
  const todayKey = todayKeyIn(resolveUserTimezone(req, userId) || '');
  const entries = longMemoryStore.getEntries(userId, characterId).map((e) => toEntryView(e, todayKey));
  res.json({ success: true, data: { facts: entries.map((e) => e.text), entries } });
});

export default router;
