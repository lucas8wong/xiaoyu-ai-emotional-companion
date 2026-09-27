/**
 * 链接预览（微信/QQ 式「链接卡片」）
 *   GET /api/link-preview?url=...    抓取目标网页标题/描述/缩略图（OG 元信息）
 *   GET /api/link-preview/image?u=... 缩略图图片代理（规避混合内容/上游 SSL 异常）
 *
 * 安全/限流：只允许 http/https；复用 news.ts 的 isSafeHttpUrl 拦截本地/内网/回环；
 *           页面抓取超时 6s、响应体上限 512KB；元信息/图片均内存缓存（24h，上限 500）。
 * 图片代理失败回退 1×1 透明 PNG（不留破图）。任何抓取失败都返回 success:false（前端回退为可点链接）。
 */

import { Router } from 'express';
import { isSafeHttpUrl } from '../services/news.js';

const router = Router();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT = 6000;
const MAX_HTML_BYTES = 512 * 1024; // 512KB
const META_CACHE_TTL = 24 * 60 * 60 * 1000;
const META_CACHE_MAX = 500;
const IMG_CACHE_TTL = 24 * 60 * 60 * 1000;
const IMG_CACHE_MAX = 500;

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
}

const metaCache = new Map<string, { data: LinkPreview; ts: number }>();
const imgCache = new Map<string, { buf: Buffer; ct: string; ts: number }>();

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  const v = (s || '').trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

/** 解析页面里所有 <meta> 的 property/name -> content，键统一小写。 */
function parseMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(tag))) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    }
    const key = (attrs['property'] || attrs['name'] || '').toLowerCase();
    if (key && attrs['content']) out[key] = attrs['content'];
  }
  return out;
}

function titleTag(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]) : '';
}

/** 解析 <link rel="image_src">（部分站点没有 og:image） */
function imageSrc(html: string): string {
  const m = /<link[^>]*rel=["']image_src["'][^>]*>/i.exec(html);
  if (!m) return '';
  const href = /href=["']([^"']+)["']/i.exec(m[0]);
  return href ? href[1] : '';
}

function resolveUrl(raw: string, base: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^data:/i.test(s)) return '';
  if (/^\/\//.test(s)) return 'https:' + s;
  try { return new URL(s, base).href; } catch { return ''; }
}

/** 带超时 + 响应体上限的 HTML 抓取；失败返回 ''。 */
async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const body = res.body;
    if (!body) {
      const ab = await res.arrayBuffer();
      return ab.byteLength > MAX_HTML_BYTES ? '' : Buffer.from(ab).toString('utf8');
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_HTML_BYTES) { ctrl.abort(); break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

router.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim().slice(0, 2048);
  if (!raw) {
    res.status(400).json({ error: 'url required', code: 'BAD_URL' });
    return;
  }
  if (!isSafeHttpUrl(raw)) {
    res.status(400).json({ error: 'unsafe_url', code: 'UNSAFE_URL' });
    return;
  }
  let url: string;
  try { url = new URL(raw).href; } catch {
    res.status(400).json({ error: 'bad_url', code: 'BAD_URL' });
    return;
  }

  const hit = metaCache.get(url);
  if (hit && Date.now() - hit.ts < META_CACHE_TTL) {
    res.json({ success: true, data: hit.data });
    return;
  }

  const html = await fetchHtml(url);
  if (!html) {
    res.json({ success: false, error: 'fetch_failed', code: 'FETCH_FAILED' });
    return;
  }

  const meta = parseMeta(html);
  const title = truncate(meta['og:title'] || meta['twitter:title'] || titleTag(html), 120) || url;
  const description = truncate(meta['og:description'] || meta['twitter:description'] || meta['description'] || '', 200);
  const image = resolveUrl(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || imageSrc(html), url);
  const data: LinkPreview = { url, title, description, image };

  metaCache.set(url, { data, ts: Date.now() });
  if (metaCache.size > META_CACHE_MAX) {
    const first = metaCache.keys().next().value;
    if (first) metaCache.delete(first);
  }
  res.json({ success: true, data });
});

/** 图片代理 SSRF 防护：仅允许公网 http/https，封禁本地/内网/回环地址 */
function isSafeImageUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  if (u.length > 2048) return false;
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return false;
    if (/^0\.|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host)) return false;
    const ipv6Loopback = /^\[?0*:+\]?$/.test(host);
    if (ipv6Loopback) return false;
    return true;
  } catch {
    return false;
  }
}

router.get('/image', async (req, res) => {
  const u = String(req.query.u || '').trim();
  if (!isSafeImageUrl(u)) {
    res.status(400).json({ error: 'bad_url', code: 'BAD_URL' });
    return;
  }
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
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      try {
        const r = await fetch(cand, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        if (r.ok) {
          const ct = r.headers.get('content-type') || 'image/jpeg';
          const buf = Buffer.from(await r.arrayBuffer());
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
      } finally {
        clearTimeout(t);
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
