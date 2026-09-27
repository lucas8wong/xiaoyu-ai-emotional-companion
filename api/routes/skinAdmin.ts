/**
 * 管理员「皮肤生成」接口（fail-closed）。
 * 挂载于 /api/skin/admin；统一 ?token= / x-admin-token 鉴权（与 paymentAdmin 一致）。
 * GET  /api/skin/admin/slots              → 21 个槽位目录
 * POST /api/skin/admin/generate           → 提示词/生成皮肤（dryRun 只出提示词不花钱）
 */
import '../services/env.js'; // 先加载 .env / .env.local（副作用）
import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { SKIN_SLOTS } from '../services/skinSlots.js';
import { generateSkin } from '../services/skinGenerator.js';
import { DEFAULT_SEEDREAM_BASE_URL, DEFAULT_SEEDREAM_MODEL } from '../services/seedream.js';

const router = Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY || '';
const SEEDREAM_MODEL = process.env.SEEDREAM_MODEL || DEFAULT_SEEDREAM_MODEL;
const SEEDREAM_BASE_URL = process.env.VOLCENGINE_ARK_BASE_URL || DEFAULT_SEEDREAM_BASE_URL;

if (!ADMIN_TOKEN) {
  console.warn('⚠️ [Security] ADMIN_TOKEN 未配置：/api/skin/admin/* 均已禁用。请在 .env 设置强随机 ADMIN_TOKEN。');
}

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

router.get('/slots', (req: Request, res: Response): void => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  res.json({ success: true, data: { slots: SKIN_SLOTS } });
});

router.post('/generate', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, error: '无权限' });
    return;
  }
  const body = (req.body || {}) as { theme?: unknown; skinId?: unknown; slots?: unknown; dryRun?: unknown; styleSpec?: unknown };
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const skinId = typeof body.skinId === 'string' ? body.skinId.trim() : '';
  const styleSpec = typeof body.styleSpec === 'string' ? body.styleSpec.trim() : '';
  const dryRun = body.dryRun === true;
  const slots = Array.isArray(body.slots) ? body.slots.filter((s): s is string => typeof s === 'string') : undefined;

  if (!theme) {
    res.status(400).json({ success: false, error: '缺少主题' });
    return;
  }
  if (theme.length > 40) {
    res.status(400).json({ success: false, error: '主题过长（≤40 字）' });
    return;
  }
  if (!dryRun && !VOLCENGINE_API_KEY) {
    res.status(400).json({ success: false, error: '未配置 VOLCENGINE_API_KEY（请在 .env.local 设置）' });
    return;
  }

  try {
    const result = await generateSkin({
      theme,
      skinId,
      slots,
      dryRun,
      styleSpec,
      apiKey: VOLCENGINE_API_KEY,
      model: SEEDREAM_MODEL || undefined,
      baseUrl: SEEDREAM_BASE_URL,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skinAdmin] generate error:', msg);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
