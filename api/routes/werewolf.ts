/**
 * AI 狼人杀 API
 *
 * GET  /api/werewolf/config：局型、每日局数上限、整局预估点数
 * GET  /api/werewolf/roster，可拉入的角色（聊一聊角色）+ 内置陪玩 + 今日剩余局数
 * POST /api/werewolf/start，开局（选人 / 局型）
 * POST /api/werewolf/:id/action，真人本轮动作（发言 / 刀 / 验 / 用药 / 投票 / 开枪）
 * GET  /api/werewolf/:id，取当前视角的对局视图（**必过视角过滤**）
 * GET  /api/werewolf/games，我的对局列表
 * POST /api/werewolf/:id/abandon，放弃本局（回滚未结算点数）
 *
 * 安全：`/action` 的发言先在服务层过 `safety.ts`；命中自伤类内容时返回
 * `crisis: true` 并**中断对局**，由前端把用户带到陪伴/危机响应路径（绝不当成游戏发言继续玩）。
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';

import { resolveUserId } from '../services/session.js';
import { safeError } from '../services/safeError.js';
import {
  WerewolfError,
  abandonGame,
  advanceGame,
  estimateGameCredit,
  getGameView,
  listGames,
  listRosterCharacters,
  startGame,
  submitHumanAction,
  werewolfQuota,
} from '../services/werewolf.js';
import { GAME_SIZES, ROSTERS } from '../../src/werewolf/engine/types.js';
import { BUILTIN_PLAYERS, type OutputLang } from '../../src/werewolf/ai/prompt.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { getClientCountry, getClientIp } from '../services/geo.js';

const router = Router();

/** 界面语言（与 journey 路由同口径） */
function langOf(req: Request): OutputLang {
  const raw = String(req.headers['x-lang'] || '').toLowerCase();
  if (raw.startsWith('en')) return 'en';
  if (raw.startsWith('zh-tw') || raw.includes('hant')) return 'zh-TW';
  return 'zh';
}

/** WerewolfError 的 code → HTTP 状态（前端按 code 出文案） */
function statusFor(code: string | undefined): number {
  switch (code) {
    case 'GAME_NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'WEREWOLF_DAILY_LIMIT':
    case 'CHAT_QUOTA_EXCEEDED':
      return 402;
    case 'BAD_SIZE':
    case 'NOT_YOUR_TURN':
    case 'BAD_SPEECH':
    case 'BAD_VOTE':
    case 'BAD_ACTION':
    case 'NO_TARGET':
      return 400;
    default:
      return 500;
  }
}

function fail(res: Response, error: unknown, fallback: string): void {
  if (error instanceof WerewolfError) {
    res.status(statusFor(error.code)).json({ success: false, error: fallback, code: error.code });
    return;
  }
  console.error('[Werewolf] error:', safeError('server', error));
  res.status(500).json({ success: false, error: fallback });
}

router.get('/config', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    const sizes = GAME_SIZES.map((size) => ({
      size,
      roster: ROSTERS[size],
      estimatedCredit: estimateGameCredit(size).credit,
      estimatedCalls: estimateGameCredit(size).calls,
    }));
    res.json({
      success: true,
      data: {
        sizes,
        quota: werewolfQuota(userId),
        builtinCount: BUILTIN_PLAYERS.length,
      },
    });
  } catch (error) {
    fail(res, error, '获取配置失败');
  }
});

router.get('/roster', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    res.json({
      success: true,
      data: {
        characters: listRosterCharacters(userId),
        builtin: BUILTIN_PLAYERS.map((b) => ({ id: b.id, name: b.name, identity: b.identity })),
        quota: werewolfQuota(userId),
      },
    });
  } catch (error) {
    fail(res, error, '获取角色列表失败');
  }
});

router.post('/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const size = Number(body.size) || 6;
    const characterIds = Array.isArray(body.characterIds) ? body.characterIds.map(String) : [];
    const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined;

    const data = await startGame({
      userId,
      size: size as 6 | 9 | 12,
      characterIds,
      lang: langOf(req),
      seed,
    });

    // 行为埋点（移植版那条路由之外的第二条合法入口）：狼人杀**按局**计入「剧情演绎」使用记录。
    // FeatureKey 仍是 'roleplay'（合计口径不变），靠 mode:'werewolf' 让运营端能拆开看。
    // 与 roleplay/textgame 一致：测试请求不计。
    if (!isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
      activityStore.trackFeature(userId, 'roleplay', {
        detail: `${size} 人局`,
        mode: 'werewolf',
        ip: getClientIp(req),
        country: getClientCountry(req),
      });
    }
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, '开局失败');
  }
});

router.get('/games', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    res.json({ success: true, data: { games: listGames(userId), quota: werewolfQuota(userId) } });
  } catch (error) {
    fail(res, error, '获取对局列表失败');
  }
});

router.get('/:id', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    const view = getGameView(userId, String(req.params.id || ''));
    res.json({ success: true, data: { view, quota: werewolfQuota(userId) } });
  } catch (error) {
    fail(res, error, '获取对局失败');
  }
});

router.post('/:id/action', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const data = await submitHumanAction({
      userId,
      gameId: String(req.params.id || ''),
      text: typeof body.text === 'string' ? body.text : undefined,
      target: body.target == null ? undefined : Number(body.target),
      heal: body.heal === true,
      poison: body.poison == null ? undefined : Number(body.poison),
    });
    // crisis = 命中危机内容：对局已中断，前端应切到陪伴/危机响应，而不是继续玩
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, '操作失败');
  }
});

router.post('/:id/advance', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const data = await advanceGame(userId, String(req.params.id || ''), langOf(req));
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, '推进对局失败');
  }
});

router.post('/:id/abandon', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    const removed = abandonGame(userId, String(req.params.id || ''));
    res.json({ success: true, data: { removed } });
  } catch (error) {
    fail(res, error, '放弃对局失败');
  }
});

export default router;
