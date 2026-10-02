/**
 * Google 一键登录：验证前端 Google Identity Services（GIS）返回的 ID token。
 *
 * 设计取舍（2026-10）：
 * - **零依赖**：直接拉 Google 的 JWKS + Node 内置 crypto 验签，不引 google-auth-library。
 *   少一个依赖就少一处供应链面，且这段逻辑（RS256 + JWKS 轮换）本身很短。
 * - **只走 ID token 流程**：前端 renderButton 拿 credential（JWT）直接 POST 给后端验签，
 *   不需要 authorization code 交换 → **不需要 Client Secret**（少一个能泄露的机密）。
 *
 * 防御清单（每一条都对应一种真实攻击，别删）：
 *   1. 只接受 alg=RS256，挡 alg=none / HS256 算法混淆（拿公钥当 HMAC 密钥）
 *   2. kid 必须命中 JWKS，未知 kid 先强制刷新一次 JWKS（应对 Google 轮换密钥）
 *   3. 必须验签成功
 *   4. exp 未过期（含 5 分钟时钟偏差）
 *   5. aud === 本站 Client ID，挡「别家应用的 token 拿来登我们的站」
 *   6. iss ∈ accounts.google.com
 *   7. email_verified === true，只有 Google 确认过的邮箱才允许按邮箱匹配/建号
 */

import 'dotenv/config';
import crypto from 'crypto';

/** 允许用 env 覆盖（单测用本地 http 服务喂一份自造 JWKS，避免测试依赖外网） */
const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const ALLOWED_ALG = 'RS256';
/** 允许的时钟偏差：Google 与服务器的时间都可能漂移几秒 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** JWKS 本地缓存时长（Google 对 JWKS 响应带 Cache-Control，这里再兜一层，避免每次登录都出网一次） */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** 未配置时整个 Google 登录入口保持关闭（前端也不会渲染按钮） */
export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
export const googleConfigured = Boolean(GOOGLE_CLIENT_ID);

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }
interface JwksResponse { keys?: Jwk[] }

let cachedKeys: Map<string, Jwk> | null = null;
let cachedAt = 0;

/** 拉取并缓存 Google 公钥集；force=true 用于「kid 未知、可能刚轮换」时强制刷新一次 */
async function loadJwks(force = false): Promise<Map<string, Jwk>> {
  const now = Date.now();
  if (!force && cachedKeys && now - cachedAt < JWKS_TTL_MS) return cachedKeys;
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS 拉取失败: HTTP ${res.status}`);
  const body = (await res.json()) as JwksResponse;
  const keys = new Map<string, Jwk>();
  for (const k of body.keys || []) {
    // 只收 RSA 签名公钥（Google 目前全是 RS256）
    if (k && k.kid && k.kty === 'RSA' && k.n && k.e) keys.set(k.kid, k);
  }
  if (keys.size === 0) throw new Error('JWKS 为空');
  cachedKeys = keys;
  cachedAt = now;
  return keys;
}

function b64urlJson<T>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export interface GoogleClaims {
  sub: string;
  email: string;
  name?: string;
}

export type GoogleVerifyResult =
  | { ok: true; claims: GoogleClaims }
  | { ok: false; error: string };

/**
 * 验证 Google ID token。任何一步不通过都返回 { ok:false }，调用方一律 401；
 * 错误文案面向用户，直白但不泄露内部细节。
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleVerifyResult> {
  if (!googleConfigured) return { ok: false, error: 'Google 登录尚未配置' };
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { ok: false, error: '登录凭据格式不正确' };
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = b64urlJson<Record<string, unknown>>(payloadB64);
  if (!header || !payload) return { ok: false, error: '登录凭据格式不正确' };
  if (header.alg !== ALLOWED_ALG) return { ok: false, error: '登录凭据签名算法不被接受' };
  if (!header.kid) return { ok: false, error: '登录凭据缺少密钥标识' };

  let keys: Map<string, Jwk>;
  try {
    keys = await loadJwks();
    if (!keys.has(header.kid)) keys = await loadJwks(true);
  } catch (e) {
    console.error('⚠️ [Google] JWKS 获取失败:', (e as Error)?.message);
    return { ok: false, error: 'Google 登录服务暂时不可用，请稍后重试' };
  }
  const jwk = keys.get(header.kid);
  if (!jwk) return { ok: false, error: '登录凭据签名无法验证' };

  let signatureOk = false;
  try {
    const key = crypto.createPublicKey(
      { key: jwk, format: 'jwk' } as unknown as Parameters<typeof crypto.createPublicKey>[0],
    );
    signatureOk = crypto.verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(sigB64, 'base64url'),
    );
  } catch {
    return { ok: false, error: '登录凭据签名验证失败' };
  }
  if (!signatureOk) return { ok: false, error: '登录凭据签名验证失败' };

  const now = Date.now();
  const exp = Number(payload.exp) * 1000;
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_MS < now) return { ok: false, error: '登录凭据已过期，请重试' };
  if (!ISSUERS.has(String(payload.iss))) return { ok: false, error: '登录凭据签发方不被信任' };
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(GOOGLE_CLIENT_ID) : aud === GOOGLE_CLIENT_ID;
  if (!audOk) return { ok: false, error: '登录凭据不属于本站' };

  const sub = String(payload.sub || '').trim();
  if (!sub) return { ok: false, error: '登录凭据缺少用户标识' };
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: '该 Google 账号没有可用邮箱' };
  // 只有 Google 确认过的邮箱才允许按邮箱匹配既有账号 / 自动建号（否则可用未验证邮箱抢占别人的账号）
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'Google 邮箱尚未验证，请换一个 Google 账号或改用邮箱注册' };
  }
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  return { ok: true, claims: { sub, email, name: name || undefined } };
}
