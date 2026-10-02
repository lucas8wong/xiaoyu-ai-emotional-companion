/**
 * AI 失败埋点上报
 * POST /api/ai-failure { feature: 'chat'|'roleplay'|'wenyou'|'other', code: string, recovered?: boolean }
 *
 * 前端在「这一轮 AI 没接上」时 fire-and-forget 上报（**不含任何用户内容**），
 * 让运营端能看到「今天 AI 失败了多少次、其中多少次被自动重试救回来」
 * 2026-09-15 事故的教训：这类失败在服务端完全静默，只能靠用户投诉才知道。
 *
 * 说明：接口永远返回 success（埋点不该影响用户流程）；测试设备不计。
 */

import { Router, type Request, type Response } from 'express';
import { isTestRequest } from '../services/activity.js';
import { aiFailureStore } from '../services/aiFailure.js';

const router = Router();

const FEATURES = new Set(['chat', 'roleplay', 'wenyou', 'other']);

router.post('/', (req: Request, res: Response): void => {
  const body = (req.body || {}) as { feature?: unknown; code?: unknown; recovered?: unknown };
  const feature = String(body.feature || 'other');
  const code = String(body.code || '').slice(0, 32);
  const recovered = body.recovered === true;
  const deviceId = String(req.headers['x-device-id'] || '');

  if (isTestRequest(req.ip, deviceId)) {
    res.json({ success: true, recorded: false });
    return;
  }
  if (!FEATURES.has(feature)) {
    res.json({ success: true, recorded: false });
    return;
  }
  aiFailureStore.record(feature, code || 'UNKNOWN', recovered);
  res.json({ success: true, recorded: true });
});

export default router;
