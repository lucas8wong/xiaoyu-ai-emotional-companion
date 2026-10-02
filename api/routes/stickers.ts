/**
 * 表情包（动图/贴纸）在线搜索代理路由
 *   GET /api/stickers/search?q=...  搜索（默认供应商 ALAPI 斗图表情包，免费、需 token）
 *   GET /api/stickers/img?u=...    图片代理：浏览器只请求本站，由服务器取上游图回流，
 *                                   规避 https 线上「混合内容」与部分上游主机 SSL 异常
 * 未配置 STICKER_API_KEY（=ALAPI token）时搜索返回 not_configured（200 + 业务标记，离线、零外部依赖）。
 * 已配置则代理上游，用递归稳健抽取把任意返回结构统一映射为 { items: [{ url, thumbUrl?, title? }] }，
 * 并对关键词 / 标题过内容安全过滤（红线直接拒）。可用 STICKER_API_URL 换成其它供应商。
 */

import { Router } from 'express';
import { checkContentSafety } from '../services/safety.js';
import { fetchPublicUrl } from '../services/news.js';

const router = Router();

const DEFAULT_UPSTREAM = 'https://v3.alapi.cn/api/doutu';

/** 同词结果缓存（5 分钟）：避免重复搜索再次命中 ALAPI 免费额度限流（code=429） */
const CACHE_TTL = 5 * 60 * 1000;
/** 搜索缓存上限（2026-09-29 审查 A3-P2） */
const CACHE_MAX = 500;
const cache = new Map<string, { items: StickerItem[]; ts: number }>();

/** 图片代理内存缓存（24h，上限 500 张）：重复检索/滚动不再反复打上游，首屏并行加载更快 */
const IMG_CACHE_TTL = 24 * 60 * 60 * 1000;
const IMG_CACHE_MAX = 500;
/** 图片代理的安全边界（2026-09-28 审查 B2/B3）：此前既无超时也无体积上限 */
const IMG_FETCH_TIMEOUT = 8000;
const IMG_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const imgCache = new Map<string, { buf: Buffer; ct: string; ts: number }>();

interface StickerItem {
  url: string;
  thumbUrl?: string;
  title?: string;
}

/** 判断一个字符串是否像图片/动图 URL */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+\.(jpe?g|png|gif|webp|bmp)([?#]\S*)?$/i.test(s) || /^https?:\/\/\S+$/i.test(s);
}

function pick(rec: Record<string, unknown>, ...ks: string[]): string {
  for (const k of ks) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** 递归收集图片 URL（深度限制，兼容数组/单对象/list/images/纯字符串） */
function collect(node: unknown, depth: number, out: StickerItem[]): StickerItem[] {
  if (depth > 5) return out;
  if (typeof node === 'string') {
    if (looksLikeUrl(node)) out.push({ url: node });
    return out;
  }
  if (Array.isArray(node)) {
    for (const x of node) collect(x, depth + 1, out);
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    const rec = node as Record<string, unknown>;
    const url = pick(rec, 'url', 'image', 'img', 'cover', 'src', 'gif', 'realUrl', 'origUrl', 'pic');
    if (url) {
      out.push({
        url,
        thumbUrl: pick(rec, 'thumbUrl', 'thumbnail', 'thumb', 'small', 'smallUrl', 'pic') || undefined,
        title: pick(rec, 'title', 'name', 'desc', 'description') || undefined,
      });
      return out; // 命中单图对象后不再下钻，避免把兄弟字段当重复图
    }
    for (const v of Object.values(rec)) {
      if (Array.isArray(v) || (typeof v === 'object' && v !== null)) collect(v, depth + 1, out);
    }
  }
  return out;
}

function mapItems(data: unknown): StickerItem[] {
  const out = collect(data, 0, []);
  const seen = new Set<string>();
  return out
    .filter((x) => {
      const k = x.url;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((x) => ({ url: x.url, thumbUrl: x.thumbUrl, title: x.title }));
}

/** 图片代理 SSRF 防护：仅允许公网 http/https，封禁本地/内网/回环地址 */
function isSafeImageUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  if (u.length > 2048) return false;
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return false;
    if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host)) return false;
    const ipv6Loopback = /^\[?0*:+\]?$/.test(host);
    if (ipv6Loopback) return false;
    return true;
  } catch {
    return false;
  }
}

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) {
    res.status(400).json({ error: 'q required', code: 'BAD_QUERY' });
    return;
  }

  const key = (process.env.STICKER_API_KEY || '').trim();
  if (!key) {
    // 200 + 业务标记：未配置是「功能未上线」不是服务故障，避免 5xx 触发前端重试 + console error
    res.json({ success: false, error: 'not_configured', code: 'NOT_CONFIGURED', message: '表情包在线搜索未配置（需要 STICKER_API_KEY，如 ALAPI token）' });
    return;
  }

  // 关键词安全门禁：命中红线（自伤/暴力/色情/毒品/教唆）直接拒绝
  if (!checkContentSafety(q).safe) {
    res.status(400).json({ error: 'query_rejected', code: 'QUERY_REJECTED' });
    return;
  }

  // 同词缓存命中：不重复打 ALAPI（省配额、避开限流）
  const hit = cache.get(q);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    res.json({ success: true, data: { items: hit.items } });
    return;
  }

  const base = (process.env.STICKER_API_URL || DEFAULT_UPSTREAM).trim();
  try {
    const upstream = new URL(base);
    upstream.searchParams.set('token', key);
    upstream.searchParams.set('keyword', q);
    const r = await fetch(upstream.toString());

    // ALAPI 限流：HTTP 429 或 JSON code=429，返回 rate_limited（200，不触发前端重试，避免雪崩）
    if (r.status === 429) {
      res.json({ success: false, error: 'rate_limited', code: 'RATE_LIMITED', message: '表情包搜索太频繁，请稍后再试' });
      return;
    }
    if (!r.ok) {
      console.error('[stickers] upstream status:', r.status);
      res.status(502).json({ error: 'upstream_error', code: 'UPSTREAM_ERROR' });
      return;
    }
    const body = await r.json();
    // ALAPI 对 token 错误/超限仍返回 HTTP 200 + success:false，区分限流与真实错误
    const bodyRec = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (bodyRec.success === false) {
      if (bodyRec.code === 429) {
        res.json({ success: false, error: 'rate_limited', code: 'RATE_LIMITED', message: '表情包搜索太频繁，请稍后再试' });
        return;
      }
      console.error('[stickers] upstream business error:', String(bodyRec.message || bodyRec.code || ''));
      res.status(502).json({ error: 'upstream_error', code: 'UPSTREAM_ERROR' });
      return;
    }
    // ALAPI 成功结构通常为 { success, code, message, data, ... }；data 可能为数组 / 对象 / {list} / 纯字符串
    const data = bodyRec.data ?? body;
    const items = mapItems(data)
      .filter((it) => checkContentSafety(it.title || '').safe)
      .slice(0, 20);
    cache.set(q, { items, ts: Date.now() });
    // 内存上限（2026-09-29 审查 A3-P2）：图片缓存早有 500 上限，搜索缓存此前无上限
    // 任意关键词都能各塞一条，长期运行会一直涨。
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    res.json({ success: true, data: { items } });
  } catch (e) {
    console.error('[stickers] search failed:', (e as Error)?.message);
    res.status(502).json({ error: 'upstream_error', code: 'UPSTREAM_ERROR' });
  }
});

/** 图片代理：浏览器请求本站，由服务器取上游图并回流（规避混合内容 + 部分上游主机 SSL 异常）。
 *  先试原 URL，失败再试换协议（http↔https），仍失败回退 1×1 透明占位 PNG（不留破图）。 */
router.get('/img', async (req, res) => {
  const u = String(req.query.u || '').trim();
  if (!isSafeImageUrl(u)) {
    res.status(400).json({ error: 'bad_url', code: 'BAD_URL' });
    return;
  }
  // 缓存命中：直接回图，不再打上游
  const hit = imgCache.get(u);
  if (hit && Date.now() - hit.ts < IMG_CACHE_TTL) {
    res.set('Content-Type', hit.ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(hit.buf);
    return;
  }
  const swapped = u.startsWith('https://') ? u.replace(/^https:/, 'http:') : u.replace(/^http:/, 'https:');
  const candidates = swapped && swapped !== u ? [u, swapped] : [u];
  for (const cand of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IMG_FETCH_TIMEOUT);
      try {
        // fetchPublicUrl：逐跳校验重定向（否则公网图 302 到内网就能被这里代理读回，2026-09-28 审查 B3）。
        const r = await fetchPublicUrl(cand, { signal: ctrl.signal });
        if (r.ok) {
          const ct = r.headers.get('content-type') || 'image/jpeg';
          const ab = await r.arrayBuffer();
          // 体积上限：此前无上限，上游返回超大文件即可吃满内存（2026-09-28 审查 B2）。
          if (ab.byteLength <= IMG_MAX_BYTES) {
            const buf = Buffer.from(ab);
            imgCache.set(cand, { buf, ct, ts: Date.now() });
            if (imgCache.size > IMG_CACHE_MAX) {
              const first = imgCache.keys().next().value;
              if (first) imgCache.delete(first);
            }
            res.set('Content-Type', ct);
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(buf);
            return;
          }
        }
      } finally {
        // 内层 finally 保证超时定时器一定被清掉（否则每次代理都留一个 8s 定时器）
        clearTimeout(timer);
      }
    } catch { /* 尝试下一候选 */ }
  }
  // 兜底：1×1 透明 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(png);
});

export default router;
