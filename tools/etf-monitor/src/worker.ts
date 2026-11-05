import { Store, type D1Database } from './store.ts';
import { dispatchNotifications, validSendKey } from './notify.ts';
import { controlFor, runTick, validateCloud } from './runtime.ts';
import { fingerprint } from './fingerprint.ts';

export interface Env { DB: D1Database; ADMIN_TOKEN?: string; SERVERCHAN_SENDKEY?: string }
const DAY = 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function authorized(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const supplied = request.headers.get('Authorization') ?? '';
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(supplied), digest(`Bearer ${env.ADMIN_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function smallBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length') ?? 0) > 4096) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let body = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  const parsed: unknown = JSON.parse(body || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY');
  return parsed as Record<string, unknown>;
}

export async function handleRequest(request: Request, env: Env, nowMs = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname;
  const store = new Store(env.DB);
  try {
    if (path === '/health' && request.method === 'GET') {
      const control = await controlFor(store);
      const lastTick = await store.get<{ at: number }>('lastTick');
      const lastAnalysis = await store.get<{ session: string; analyses: Array<{ errors: string[] }> }>('lastAnalysis');
      const configured = Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 && validSendKey(env.SERVERCHAN_SENDKEY ?? ''));
      const priceFailure = lastAnalysis?.analyses.some(a => a.errors.some(e => e.startsWith('PRICE'))) ?? false;
      const destinationChanged = control.deliveryFingerprint && control.deliveryFingerprint !== await fingerprint(env.SERVERCHAN_SENDKEY ?? '');
      const stale = control.enabled && (!lastTick || nowMs - lastTick.at > 45 * 60_000 || priceFailure || destinationChanged);
      return json({ status: !configured ? 'setup_required' : !control.enabled ? 'paused' : stale ? 'degraded' : 'ok',
        enabled: control.enabled, lastTickAt: lastTick?.at ?? null, lastDataSession: lastAnalysis?.session ?? null, version: '1.0.0' }, stale ? 503 : 200);
    }
    if (!path.startsWith('/admin/')) return json({ error: 'NOT_FOUND' }, 404);
    if (!await authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (request.method === 'GET' && path === '/admin/status') {
      return json({ control: await controlFor(store), health: await store.health(nowMs),
        validation: await store.get('validation'), lastAnalysis: await store.get('lastAnalysis'), lastFailure: await store.get('lastFailure') });
    }
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const body = await smallBody(request);
    if (path === '/admin/validate') return json(await validateCloud(store, nowMs));
    if (path === '/admin/test-push') {
      if (!validSendKey(env.SERVERCHAN_SENDKEY ?? '')) return json({ error: 'PUSH_NOT_CONFIGURED' }, 409);
      // Only a code read from the actual WeChat message can unlock activation.
      const codeBytes = crypto.getRandomValues(new Uint32Array(1));
      const code = String(codeBytes[0] % 1_000_000).padStart(6, '0');
      const id = `test:${crypto.randomUUID()}`;
      await store.commit([{ key: 'deliveryTest', value: { id, code, at: nowMs, keyFingerprint: await fingerprint(env.SERVERCHAN_SENDKEY!) } }, { key: 'deliveryCodeFailures', value: 0 }], [{
        id, kind: 'test', title: 'QQQM / SPYM 微信连通测试',
        body: `这是一条监控上线验收消息。验证码：${code}\n请在本地激活命令中输入验证码。验证码有效期为30分钟；收到本消息不代表监控已经启用。`,
        createdAt: nowMs, expiresAt: nowMs + 30 * 60_000,
      }]);
      const result = await dispatchNotifications(store, env.SERVERCHAN_SENDKEY!, nowMs);
      return json({ testId: id, ...result, note: 'API接收不代表微信已送达；请读取微信消息中的验证码。' });
    }
    if (path === '/admin/confirm-delivery') {
      const test = await store.get<{ id: string; code: string; at: number; keyFingerprint: string }>('deliveryTest');
      const failures = (await store.get<number>('deliveryCodeFailures')) ?? 0;
      if (failures >= 10) return json({ error: 'DELIVERY_CONFIRMATION_LOCKED' }, 429);
      if (!test || test.id !== body.testId || test.code !== body.code || nowMs < test.at || nowMs - test.at > 30 * 60_000 || test.keyFingerprint !== await fingerprint(env.SERVERCHAN_SENDKEY ?? '')) {
        await store.put('deliveryCodeFailures', failures + 1);
        return json({ error: 'DELIVERY_CODE_INVALID_OR_EXPIRED' }, 409);
      }
      const control = await controlFor(store);
      await store.commit([{ key: 'control', value: { ...control, deliveryConfirmedAt: nowMs, deliveryFingerprint: test.keyFingerprint } },
        { key: 'deliveryTest', value: null }, { key: 'deliveryCodeFailures', value: 0 }], []);
      return json({ confirmed: true });
    }
    if (path === '/admin/enable') {
      const control = await controlFor(store);
      if (!validSendKey(env.SERVERCHAN_SENDKEY ?? '') || !control.cloudValidatedAt || nowMs - control.cloudValidatedAt > DAY ||
          !control.deliveryConfirmedAt || nowMs - control.deliveryConfirmedAt > DAY ||
          control.deliveryFingerprint !== await fingerprint(env.SERVERCHAN_SENDKEY ?? '')) {
        return json({ error: 'FRESH_CLOUD_VALIDATION_AND_WECHAT_RECEIPT_REQUIRED' }, 409);
      }
      const validation = await store.get<{ valid: boolean }>('validation');
      if (!validation?.valid) return json({ error: 'CLOUD_VALIDATION_FAILED' }, 409);
      await store.put('control', { ...control, enabled: true });
      return json({ enabled: true, dailyReportBeijing: '08:00', intervalMinutes: 15 });
    }
    if (path === '/admin/pause') {
      await store.put('control', { ...await controlFor(store), enabled: false });
      return json({ enabled: false });
    }
    return json({ error: 'NOT_FOUND' }, 404);
  } catch {
    return json({ error: 'MONITOR_OPERATION_FAILED' }, 500);
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: unknown) { return handleRequest(request, env); },
  async scheduled(_controller: { scheduledTime: number }, env: Env, _ctx: unknown) {
    // Real execution time prevents a delayed scheduler from labelling old data as current.
    await runTick(new Store(env.DB), env.SERVERCHAN_SENDKEY ?? '', Date.now());
  },
};
