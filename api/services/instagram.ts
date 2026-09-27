/**
 * Instagram 运营连接模块（Meta Graph API）
 *
 * 能力：
 *  - Meta OAuth 连接 Instagram 专业账号（Business/Creator，需绑定 Facebook 主页）
 *  - 应用内草稿（IG 官方 API 不支持草稿，草稿存在本应用 data/instagram.json）
 *  - 一键发布：单图 / 轮播 / Reels / Story
 *  - 长令牌（60 天）自动续期
 *
 * 环境变量：
 *  - IG_APP_ID        Meta 开发者应用 App ID（必填）
 *  - IG_APP_SECRET    Meta 开发者应用 App Secret（必填）
 *  - IG_GRAPH_VERSION 可选，默认 v21.0
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('instagram.json');

const GRAPH_VERSION = process.env.IG_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const IG_APP_ID = process.env.IG_APP_ID || '';
export const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
export const igConfigured = Boolean(IG_APP_ID && IG_APP_SECRET);

/** 发布类型 */
export type IgPostType = 'image' | 'carousel' | 'reel' | 'story';

export interface InstagramConnection {
  igUserId: string;
  igUsername: string;
  fbPageId: string;
  fbPageName: string;
  /** 长令牌（60 天） */
  accessToken: string;
  tokenExpiresAt: number;
  connectedAt: number;
}

export interface IgDraft {
  id: string;
  type: IgPostType;
  caption: string;
  mediaUrls: string[];
  status: 'draft' | 'published';
  createdAt: number;
  publishedAt?: number;
  containerId?: string;
  permalink?: string;
}

class InstagramStore {
  private conn: InstagramConnection | null = null;
  private drafts: IgDraft[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<any>(FILE, {});
    if (parsed?.connection) {
        const c = parsed.connection;
        this.conn = {
          igUserId: String(c.igUserId || ''),
          igUsername: String(c.igUsername || ''),
          fbPageId: String(c.fbPageId || ''),
          fbPageName: String(c.fbPageName || ''),
          accessToken: String(c.accessToken || ''),
          tokenExpiresAt: Number(c.tokenExpiresAt || 0),
          connectedAt: Number(c.connectedAt || Date.now()),
        };
      }
      if (Array.isArray(parsed?.drafts)) {
        this.drafts = parsed.drafts.map((d: any) => ({
          id: String(d.id || uuidv4()),
          type: (['image', 'carousel', 'reel', 'story'].includes(d.type) ? d.type : 'image') as IgPostType,
          caption: String(d.caption || ''),
          mediaUrls: Array.isArray(d.mediaUrls) ? d.mediaUrls.map(String) : [],
          status: d.status === 'published' ? 'published' : 'draft',
          createdAt: Number(d.createdAt || Date.now()),
          publishedAt: d.publishedAt ? Number(d.publishedAt) : undefined,
          containerId: d.containerId ? String(d.containerId) : undefined,
          permalink: d.permalink ? String(d.permalink) : undefined,
        }));
      }
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, { connection: this.conn, drafts: this.drafts });
    } catch { /* 忽略 */ }
  }

  getConnection(): InstagramConnection | null { return this.conn; }

  setConnection(c: InstagramConnection): void {
    this.conn = c;
    this.saveToDisk();
  }

  clearConnection(): void {
    this.conn = null;
    this.saveToDisk();
  }

  listDrafts(): IgDraft[] {
    return [...this.drafts].sort((a, b) => b.createdAt - a.createdAt);
  }

  getDraft(id: string): IgDraft | null {
    return this.drafts.find((d) => d.id === id) || null;
  }

  addDraft(d: Omit<IgDraft, 'id' | 'createdAt' | 'status'>): IgDraft {
    const item: IgDraft = { ...d, id: uuidv4(), status: 'draft', createdAt: Date.now() };
    this.drafts.unshift(item);
    this.saveToDisk();
    return item;
  }

  removeDraft(id: string): boolean {
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((d) => d.id !== id);
    if (this.drafts.length !== before) {
      this.saveToDisk();
      return true;
    }
    return false;
  }

  markPublished(id: string, meta: { containerId: string; permalink?: string }): void {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return;
    d.status = 'published';
    d.publishedAt = Date.now();
    d.containerId = meta.containerId;
    if (meta.permalink) d.permalink = meta.permalink;
    this.saveToDisk();
  }
}

export const instagramStore = new InstagramStore();

/* ============ Meta Graph API 调用 ============ */

function graphErrBody(body: any): string {
  const msg = body?.error?.message || body?.message || '';
  const code = body?.error?.code;
  return code ? `Meta 错误 ${code}: ${msg}` : (msg || 'Meta API 返回未知错误');
}

async function graphGet<T = any>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const resp = await fetch(`${GRAPH}${path}?${qs}`, { method: 'GET' });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body?.error) throw new Error(graphErrBody(body));
  return body as T;
}

async function graphPost<T = any>(path: string, body: Record<string, string>, token: string): Promise<T> {
  const form = new URLSearchParams({ ...body, access_token: token });
  const resp = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json?.error) throw new Error(graphErrBody(json));
  return json as T;
}

/* ============ OAuth ============ */

/** 生成 Meta 登录授权地址（跳转到 Facebook 登录页） */
export function buildAuthUrl(redirectUri: string, state: string): string {
  const scope = 'instagram_business_basic,instagram_business_content_publish,pages_show_list';
  const p = new URLSearchParams({
    client_id: IG_APP_ID,
    redirect_uri: redirectUri,
    state,
    scope,
    response_type: 'code',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${p.toString()}`;
}

/** code → 短令牌 → 长令牌（60 天），并解析出绑定的 Instagram 专业账号 */
export async function exchangeCode(redirectUri: string, code: string): Promise<InstagramConnection> {
  if (!igConfigured) throw new Error('Meta 应用未配置：请在 .env 设置 IG_APP_ID / IG_APP_SECRET');

  // 1. code → 短令牌
  const short = await graphGet<{ access_token: string }>('/oauth/access_token', {
    client_id: IG_APP_ID,
    client_secret: IG_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  }, '');

  // 2. 短令牌 → 长令牌（60 天）
  const long = await graphGet<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: IG_APP_ID,
    client_secret: IG_APP_SECRET,
    fb_exchange_token: short.access_token,
  }, '');

  const token = long.access_token;
  const expiresIn = Number(long.expires_in || 60 * 24 * 3600);

  // 3. 列出绑定主页，找到挂有 Instagram 专业账号的主页
  const accounts = await graphGet<{ data: Array<{ id: string; name?: string; instagram_business_account?: { id: string; username?: string } }> }>(
    '/me/accounts', { fields: 'id,name,instagram_business_account{id,username}' }, token,
  );
  const target = (accounts.data || []).find((p) => p.instagram_business_account?.id);
  if (!target?.instagram_business_account?.id) {
    throw new Error('未找到可用的 Instagram 专业账号：请确认 IG 账号已切换为专业版（Business/Creator）并绑定到你的 Facebook 主页');
  }
  const ig = target.instagram_business_account;

  // 4. 补一次用户名（部分授权返回里 username 可能为空）
  let username = ig.username || '';
  if (!username) {
    try {
      const me = await graphGet<{ username: string }>(`/${ig.id}`, { fields: 'username' }, token);
      username = me.username;
    } catch { /* 忽略 */ }
  }

  return {
    igUserId: ig.id,
    igUsername: username || target.name || 'instagram',
    fbPageId: target.id,
    fbPageName: target.name || '',
    accessToken: token,
    tokenExpiresAt: Date.now() + expiresIn * 1000,
    connectedAt: Date.now(),
  };
}

/** 用当前长令牌换一个新长令牌（续期），临近过期时调用 */
export async function refreshToken(conn: InstagramConnection): Promise<InstagramConnection> {
  const long = await graphGet<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: IG_APP_ID,
    client_secret: IG_APP_SECRET,
    fb_exchange_token: conn.accessToken,
  }, '');
  const expiresIn = Number(long.expires_in || 60 * 24 * 3600);
  const next: InstagramConnection = { ...conn, accessToken: long.access_token, tokenExpiresAt: Date.now() + expiresIn * 1000 };
  instagramStore.setConnection(next);
  return next;
}

/** 发布前取可用连接（临近 7 天过期自动续期） */
export async function ensureUsableConnection(): Promise<InstagramConnection> {
  const conn = instagramStore.getConnection();
  if (!conn) throw new Error('尚未连接 Instagram 账号，请先到控制台完成连接');
  if (conn.tokenExpiresAt - Date.now() < 7 * 24 * 3600 * 1000) {
    try { return await refreshToken(conn); } catch { /* 续期失败则继续用旧令牌 */ }
  }
  return conn;
}

/* ============ 发布 ============ */

export interface PublishResult {
  containerId: string;
  permalink?: string;
}

/** 创建容器 + 发布。mediaUrls 需为 Meta 可访问的公网 URL */
export async function publishPost(type: IgPostType, caption: string, mediaUrls: string[]): Promise<PublishResult> {
  const conn = await ensureUsableConnection();
  const token = conn.accessToken;
  const ig = conn.igUserId;
  const urls = (mediaUrls || []).map((u) => String(u).trim()).filter(Boolean);

  if (urls.length === 0) throw new Error('请至少提供一个媒体 URL（需为公网可访问的图片/视频地址）');

  let containerId = '';

  if (type === 'carousel') {
    // 轮播：先为每张图创建子容器
    const children: string[] = [];
    for (const url of urls) {
      const c = await graphPost<{ id: string }>(`/${ig}/media`, { image_url: url, is_carousel_item: 'true' }, token);
      children.push(c.id);
    }
    const car = await graphPost<{ id: string }>(`/${ig}/media`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption,
    }, token);
    containerId = car.id;
  } else if (type === 'reel') {
    const reel = await graphPost<{ id: string }>(`/${ig}/media`, {
      media_type: 'REELS',
      video_url: urls[0],
      caption,
      share_to_feed: 'true',
    }, token);
    containerId = reel.id;
  } else if (type === 'story') {
    const story = await graphPost<{ id: string }>(`/${ig}/media`, {
      media_type: 'STORIES',
      image_url: urls[0],
    }, token);
    containerId = story.id;
  } else {
    // 单图
    const img = await graphPost<{ id: string }>(`/${ig}/media`, { image_url: urls[0], caption }, token);
    containerId = img.id;
  }

  // 发布容器
  const pub = await graphPost<{ id: string }>(`/${ig}/media_publish`, { creation_id: containerId }, token);
  const publishedId = pub.id || containerId;

  // 取 permalink
  let permalink: string | undefined;
  try {
    const info = await graphGet<{ permalink?: string; shortcode?: string }>(`/${publishedId}`, { fields: 'permalink,shortcode' }, token);
    permalink = info.permalink || (info.shortcode ? `https://www.instagram.com/p/${info.shortcode}/` : undefined);
  } catch { /* 忽略 */ }

  return { containerId: publishedId, permalink };
}
