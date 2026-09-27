/**
 * 千世书自建剧本同步（登录用户）
 * GET /api/wenyou/scenarios      → 我的剧本列表
 * PUT /api/wenyou/scenarios      { scenarios: [...] } → 整表保存（前端负责合并）
 * 鉴权：Bearer token（登录用户）；未登录 401（游客仍走本地 localStorage）
 * 服务端做轻量形状校验 + 内容安全过滤（前端已用 importScenarioSchema 严格校验）
 */

import { Router, Request, Response } from 'express';
import { getAuthUser } from '../services/session.js';
import { wenyouScenariosStore } from '../services/wenyouScenarios.js';
import { wenyouSavesStore } from '../services/wenyouSaves.js';
import { checkContentSafety } from '../services/safety.js';

const router = Router();

function currentUserId(req: Request): string | null {
  const user = getAuthUser(req);
  return user ? user.userId : null;
}

/** 收集剧本内所有用户可见文本（供内容安全过滤） */
function scenarioTexts(sc: any): string[] {
  if (!sc || typeof sc !== 'object') return [];
  const out: string[] = [sc.title, sc.intro, sc.systemPrompt]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  if (Array.isArray(sc.openings)) {
    for (const o of sc.openings) {
      if (typeof o?.name === 'string') out.push(o.name);
      if (typeof o?.prompt === 'string') out.push(o.prompt);
    }
  }
  if (Array.isArray(sc.endings)) {
    for (const e of sc.endings) {
      if (typeof e?.tone === 'string') out.push(e.tone);
      if (typeof e?.epilogue === 'string') out.push(e.epilogue);
    }
  }
  if (Array.isArray(sc.localEvents)) {
    for (const ev of sc.localEvents) {
      if (typeof ev?.narrative === 'string') out.push(ev.narrative);
      if (typeof ev?.summary === 'string') out.push(ev.summary);
      if (Array.isArray(ev?.choices)) {
        for (const c of ev.choices) {
          if (typeof c?.text === 'string') out.push(c.text);
          if (typeof c?.reaction === 'string') out.push(c.reaction);
        }
      }
    }
  }
  return out;
}

/** 轻量服务端校验：形状 + 文本安全 */
function validateScenarioList(list: unknown): { ok: boolean; error?: string } {
  if (!Array.isArray(list)) return { ok: false, error: 'scenarios 必须是数组' };
  if (list.length > 50) return { ok: false, error: '剧本数量超出上限（50）' };
  for (const sc of list) {
    if (!sc || typeof sc !== 'object') return { ok: false, error: '剧本格式不正确' };
    const s = sc as any;
    if (
      typeof s.id !== 'string' || !s.id.trim() ||
      typeof s.title !== 'string' || !s.title.trim() ||
      typeof s.intro !== 'string' || !s.intro.trim()
    ) {
      return { ok: false, error: '剧本缺少 id/title/intro' };
    }
    if (!Array.isArray(s.attributes) || s.attributes.length === 0) {
      return { ok: false, error: '剧本缺少属性（attributes）' };
    }
    if (!Array.isArray(s.endings) || s.endings.length === 0) {
      return { ok: false, error: '剧本缺少结局（endings）' };
    }
    for (const text of scenarioTexts(s)) {
      const r = checkContentSafety(text);
      if (!r.safe) return { ok: false, error: r.reason || 'content_violation' };
    }
  }
  return { ok: true };
}

router.get('/scenarios', (req: Request, res: Response): void => {
  const userId = currentUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: '请先登录后再同步剧本' });
    return;
  }
  res.json({ success: true, data: { scenarios: wenyouScenariosStore.get(userId) } });
});

router.put('/scenarios', (req: Request, res: Response): void => {
  const userId = currentUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: '请先登录后再同步剧本' });
    return;
  }
  const list = (req.body as { scenarios?: unknown } | undefined)?.scenarios;
  const v = validateScenarioList(list);
  if (!v.ok) {
    res.status(400).json({ success: false, error: v.error || '剧本校验未通过' });
    return;
  }
  const saved = wenyouScenariosStore.set(userId, list as unknown[]);
  res.json({ success: true, data: { scenarios: saved } });
});

/** 轻量校验进度包：games/slots/endings/stats 形状（内容不深校验——是用户私有游戏进度，非公开人设） */
function looseSaveGameShape(v: any): boolean {
  return (
    !!v && typeof v === 'object' &&
    typeof v?.scenario?.id === 'string' &&
    !!v?.state && typeof v.state === 'object' && Array.isArray(v.state.history)
  );
}

function validateProgress(b: any): { ok: boolean; error?: string } {
  if (b !== null && typeof b !== 'object') return { ok: false, error: '进度包格式不正确' };
  const x = b ?? {};
  if (x.slots !== undefined && !Array.isArray(x.slots)) return { ok: false, error: 'slots 必须是数组' };
  if (Array.isArray(x.slots) && x.slots.length > 50) return { ok: false, error: '存档位超出上限（50）' };
  if (x.games !== undefined && (typeof x.games !== 'object' || Array.isArray(x.games) || x.games === null)) {
    return { ok: false, error: '进行中局（games）格式不正确' };
  }
  if (x.games && Object.keys(x.games).length > 50) return { ok: false, error: '进行中局超出上限（50）' };
  if (x.games) {
    for (const [id, g] of Object.entries(x.games)) {
      if (!looseSaveGameShape(g)) return { ok: false, error: `进行中局「${id}」格式不正确` };
    }
  }
  if (x.endings !== undefined && (typeof x.endings !== 'object' || Array.isArray(x.endings) || x.endings === null)) return { ok: false, error: 'endings 格式不正确' };
  if (x.stats !== undefined && (typeof x.stats !== 'object' || Array.isArray(x.stats) || x.stats === null)) return { ok: false, error: 'stats 格式不正确' };
  return { ok: true };
}

/** 千世书进度：GET 拉取（登录用户跨设备读取） */
router.get('/progress', (req: Request, res: Response): void => {
  const userId = currentUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: '请先登录后再同步进度' });
    return;
  }
  const data = wenyouSavesStore.get(userId) ?? { games: {}, slots: [], endings: {}, stats: null };
  res.json({ success: true, data });
});

/** 千世书进度：PUT 整表保存（前端负责合并、以当前设备为源） */
router.put('/progress', (req: Request, res: Response): void => {
  const userId = currentUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: '请先登录后再同步进度' });
    return;
  }
  const v = validateProgress(req.body ?? {});
  if (!v.ok) {
    res.status(400).json({ success: false, error: v.error || '进度校验未通过' });
    return;
  }
  const b = (req.body ?? {}) as any;
  const saved = wenyouSavesStore.set(userId, {
    games: b.games ?? {},
    slots: Array.isArray(b.slots) ? b.slots : [],
    endings: b.endings ?? {},
    stats: b.stats ?? null,
  });
  res.json({ success: true, data: saved });
});

export default router;
