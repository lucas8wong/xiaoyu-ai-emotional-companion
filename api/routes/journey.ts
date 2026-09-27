/**
 * «与你的旅程» API
 * GET /api/journey  —— 聚合当前用户（登录账号或游客设备指纹）的陪伴旅程
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { resolveUserId } from '../services/session.js';
import { resolveUserTimezone } from '../services/requestTimezone.js';
import { getJourney } from '../services/journey.js';

const router = Router();

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const lang = String(req.headers['x-lang'] || '');
    res.json({ success: true, data: getJourney(userId, lang, resolveUserTimezone(req, userId)) });
  } catch (error) {
    console.error('Journey query error:', error);
    res.status(500).json({ success: false, error: '获取旅程失败' });
  }
});

export default router;
