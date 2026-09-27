/**
 * 心情日记 API
 * POST /api/diary  { mood, note }   记录/更新今日心情
 * GET  /api/diary                    我的日记 + 连续打卡天数
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { resolveUserId } from '../services/session.js';
import { diaryStore } from '../services/diary.js';

const router = Router();

/**
 * 记录今日心情
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { mood, note } = req.body || {};
  if (!mood || typeof mood !== 'string') {
    res.status(400).json({ success: false, error: '请选择今天的心情' });
    return;
  }
  const userId = resolveUserId(req);
  const result = diaryStore.save(userId, String(mood).slice(0, 20), String(note || '').slice(0, 500));
  res.json({
    success: true,
    data: {
      entry: result.entry,
      streak: result.streak,
      reward: result.reward,
      message: result.reward
        ? `🎉 今日打卡成功！奖励 ${result.reward.bonus} 次免费体验`
        : '已记录今日心情',
    }
  });
});

/**
 * 我的日记
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  const records = diaryStore.list(userId);
  const today = records.find(r => r.date === new Date().toISOString().slice(0, 10));
  res.json({
    success: true,
    data: {
      records,
      streak: diaryStore.streak(userId),
      today,
    }
  });
});

export default router;
