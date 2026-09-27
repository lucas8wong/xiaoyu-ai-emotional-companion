/**
 * Instagram 运营管理接口
 *
 * 管理端接口统一挂在 /api/instagram/admin/*，用 ?token=ADMIN_TOKEN 鉴权（与控制台一致）
 * OAuth 回调无需 token，但校验 state（state 即 ADMIN_TOKEN）
 *
 * 图片媒体要求公网 URL；本服务也支持 base64 上传到 public/uploads/ig/（需服务器可写 public 目录）
 */

import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  IG_APP_ID, igConfigured,
  instagramStore, buildAuthUrl, exchangeCode,
  publishPost,
  type IgPostType,
} from '../services/instagram.js';

const router = Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function isAdmin(req: Request): boolean {
  if (!ADMIN_TOKEN) return false; // 未配置令牌 → 一律拒绝
  const token = String(req.query?.token || req.headers['x-admin-token'] || '');
  if (!token || token.length !== ADMIN_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(ADMIN_TOKEN, 'utf8'));
  } catch {
    return false;
  }
}

function redirectUri(req: Request): string {
  const host = req.get('host') || 'localhost:3001';
  return `${req.protocol}://${host}/api/instagram/callback`;
}

const IG_TYPES: IgPostType[] = ['image', 'carousel', 'reel', 'story'];

/** GET /api/instagram/admin/status?token= 连接状态 + 草稿数量 */
router.get('/admin/status', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const conn = instagramStore.getConnection();
  res.json({
    success: true,
    data: {
      configured: igConfigured,
      appId: IG_APP_ID || '',
      connected: Boolean(conn),
      igUsername: conn?.igUsername || '',
      igUserId: conn?.igUserId || '',
      tokenExpiresAt: conn?.tokenExpiresAt || 0,
      connectedAt: conn?.connectedAt || 0,
      draftsCount: instagramStore.listDrafts().filter((d) => d.status === 'draft').length,
    },
  });
});

/** GET /api/instagram/admin/auth-url?token= 返回 Meta 授权链接（新窗口打开） */
router.get('/admin/auth-url', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  if (!igConfigured) {
    res.status(400).json({ success: false, error: 'Meta 应用未配置：请在 .env 设置 IG_APP_ID / IG_APP_SECRET 后重启服务' });
    return;
  }
  res.json({ success: true, data: { url: buildAuthUrl(redirectUri(req), ADMIN_TOKEN) } });
});

/** GET /api/instagram/callback?code=&state= Meta OAuth 回调 */
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const error = String(req.query.error || '');
  if (error) {
    res.redirect('/admin.html?ig=err');
    return;
  }
  if (!ADMIN_TOKEN || state !== ADMIN_TOKEN) {
    res.redirect('/admin.html?ig=err');
    return;
  }
  if (!code) {
    res.redirect('/admin.html?ig=err');
    return;
  }
  try {
    const conn = await exchangeCode(redirectUri(req), code);
    instagramStore.setConnection(conn);
    res.redirect('/admin.html?ig=ok');
  } catch (e) {
    console.error('Instagram OAuth 回调失败:', (e as Error)?.message);
    res.redirect('/admin.html?ig=err');
  }
});

/** POST /api/instagram/admin/disconnect?token= */
router.post('/admin/disconnect', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  instagramStore.clearConnection();
  res.json({ success: true, data: { connected: false } });
});

/** POST /api/instagram/admin/upload?token= 上传本地图片 → 返回公网 URL（base64 dataUrl） */
router.post('/admin/upload', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const { dataUrl } = req.body || {};
  if (typeof dataUrl !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    res.status(400).json({ success: false, error: '请提供 base64 图片（data:image/...;base64,...）' });
    return;
  }
  try {
    const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const ext = (m?.[1] || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
    const buf = Buffer.from(m?.[2] || '', 'base64');
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) {
      res.status(400).json({ success: false, error: '图片为空或超过 8MB' });
      return;
    }
    const dir = path.join(process.cwd(), 'public', 'uploads', 'ig');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    const host = req.get('host') || 'localhost:3001';
    const url = `${req.protocol}://${host}/uploads/ig/${name}`;
    res.json({ success: true, data: { url } });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error)?.message || '上传失败' });
  }
});

/** POST /api/instagram/admin/generate?token= AI 生成英文文案（复用 DeepSeek） */
router.post('/admin/generate', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const { topic, type } = req.body || {};
  const t = String(topic || '').trim().slice(0, 120);
  if (!t) { res.status(400).json({ success: false, error: '请填写内容主题' }); return; }
  const pt: 'image' | 'carousel' | 'reel' = IG_TYPES.includes(type) && type !== 'story' ? (type as 'image' | 'carousel' | 'reel') : 'image';
  try {
    const { generateInstagramPost } = await import('../services/gemini.js');
    const draft = await generateInstagramPost({ topic: t, type: pt });
    if (!draft) { res.status(500).json({ success: false, error: 'AI 生成失败，请重试' }); return; }
    res.json({ success: true, data: draft });
  } catch (e) {
    console.error('IG AI 生成失败:', (e as Error)?.message);
    res.status(500).json({ success: false, error: (e as Error)?.message || 'AI 生成失败' });
  }
});

/** POST /api/instagram/admin/drafts?token= 保存草稿 { type, caption, mediaUrls[] } */
router.post('/admin/drafts', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const { type, caption, mediaUrls } = req.body || {};
  const pt: IgPostType = IG_TYPES.includes(type) ? type : 'image';
  const urls = Array.isArray(mediaUrls) ? mediaUrls.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const cap = String(caption || '').trim().slice(0, 2200);
  if (!cap && urls.length === 0) {
    res.status(400).json({ success: false, error: '文案或媒体至少填一项' });
    return;
  }
  const d = instagramStore.addDraft({ type: pt, caption: cap, mediaUrls: urls });
  res.json({ success: true, data: d });
});

/** GET /api/instagram/admin/drafts?token= 草稿列表 */
router.get('/admin/drafts', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  res.json({ success: true, data: { drafts: instagramStore.listDrafts() } });
});

/** DELETE /api/instagram/admin/drafts/:id?token= 删除草稿 */
router.delete('/admin/drafts/:id', (req: Request, res: Response): void => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const ok = instagramStore.removeDraft(String(req.params.id || ''));
  res.json({ success: ok, error: ok ? undefined : '草稿不存在' });
});

/** POST /api/instagram/admin/drafts/:id/publish?token= 发布草稿 */
router.post('/admin/drafts/:id/publish', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const d = instagramStore.getDraft(String(req.params.id || ''));
  if (!d) { res.status(404).json({ success: false, error: '草稿不存在' }); return; }
  if (d.status === 'published') { res.status(400).json({ success: false, error: '该草稿已发布' }); return; }
  try {
    const r = await publishPost(d.type, d.caption, d.mediaUrls);
    instagramStore.markPublished(d.id, r);
    res.json({ success: true, data: { id: d.id, permalink: r.permalink } });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error)?.message || '发布失败' });
  }
});

/** POST /api/instagram/admin/publish?token= 直接发布（同时留档） */
router.post('/admin/publish', async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ success: false, error: '无权限' }); return; }
  const { type, caption, mediaUrls } = req.body || {};
  const pt: IgPostType = IG_TYPES.includes(type) ? type : 'image';
  const urls = Array.isArray(mediaUrls) ? mediaUrls.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const cap = String(caption || '').trim().slice(0, 2200);
  try {
    const r = await publishPost(pt, cap, urls);
    const d = instagramStore.addDraft({ type: pt, caption: cap, mediaUrls: urls });
    instagramStore.markPublished(d.id, r);
    res.json({ success: true, data: { id: d.id, permalink: r.permalink } });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error)?.message || '发布失败' });
  }
});

export default router;
