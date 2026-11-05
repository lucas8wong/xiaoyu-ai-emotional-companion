import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleRequest, type Env } from '../src/worker.ts';
import { Store } from '../src/store.ts';
import { FakeD1 } from './fake-d1.ts';

const now = Date.parse('2026-11-06T00:00:00Z');
const day = 86_400_000;
const sendKey = 'SCT0000000000SyntheticFixtureOnly';
const adminToken = 'synthetic-admin-token-at-least-thirty-two-chars';
function fixture(t: test.TestContext) {
  const db = new FakeD1();
  t.after(() => db.close());
  const env: Env = { DB: db, ADMIN_TOKEN: adminToken, SERVERCHAN_SENDKEY: sendKey };
  return { db, env, store: new Store(db) };
}
function request(path: string, body: unknown = {}, options: { auth?: boolean; method?: string; token?: string } = {}) {
  const method = options.method ?? 'POST';
  return new Request(`https://synthetic-monitor.invalid${path}`, {
    method,
    headers: {
      ...(options.auth === false ? {} : { Authorization: `Bearer ${options.token ?? adminToken}` }),
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
async function invoke(env: Env, path: string, body: unknown = {}, at = now) {
  return handleRequest(request(path, body), env, at);
}
function mockWechat(t: test.TestContext) {
  const messages: Array<{ title: string; body: string; code: string }> = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const parameters = new URLSearchParams(String(init?.body));
    const body = parameters.get('desp') ?? '';
    const code = /验证码：(\d{6})/.exec(body)?.[1];
    assert.ok(code, 'code must reach the synthetic WeChat provider body');
    messages.push({ title: parameters.get('title') ?? '', body, code });
    return Response.json({ code: 0 });
  });
  return messages;
}
async function startReceipt(env: Env, messages: ReturnType<typeof mockWechat>, at = now) {
  const response = await invoke(env, '/admin/test-push', {}, at);
  assert.equal(response.status, 200);
  const result = await response.json() as { testId: string; sent: number; [key: string]: unknown };
  assert.equal(result.sent, 1);
  const code = messages.at(-1)!.code;
  assert.equal(Object.hasOwn(result, 'code'), false);
  assert.equal(Object.values(result).includes(code), false, 'HTTP response must not expose the receipt code');
  return { testId: result.testId, code };
}

test('public health is setup_required or paused by default and contains no secrets', async t => {
  const { env, store } = fixture(t);
  await store.put('deliveryTest', { id: 'private', code: '123456', at: now });
  const missing = await handleRequest(request('/health', {}, { method: 'GET', auth: false }), { DB: env.DB }, now);
  assert.equal(missing.status, 200);
  assert.equal((await missing.json() as { status: string }).status, 'setup_required');
  const response = await handleRequest(request('/health', {}, { method: 'GET', auth: false }), env, now);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control')!, /no-store/);
  const body = await response.text();
  assert.equal(JSON.parse(body).status, 'paused');
  for (const secret of [sendKey, adminToken, '123456', 'deliveryTest']) assert.equal(body.includes(secret), false);
});

test('every administrative route requires the bearer token before reading or writing', async t => {
  const { env, store } = fixture(t);
  for (const path of ['/admin/status', '/admin/validate', '/admin/test-push', '/admin/confirm-delivery', '/admin/enable', '/admin/pause', '/admin/unknown']) {
    const method = path === '/admin/status' ? 'GET' : 'POST';
    assert.equal((await handleRequest(request(path, {}, { method, auth: false }), env, now)).status, 401, path);
    assert.equal((await handleRequest(request(path, {}, { method, token: 'wrong' }), env, now)).status, 401, path);
  }
  assert.equal(await store.get('control'), null);
  assert.equal((await handleRequest(request('/admin/status', {}, { method: 'GET', token: 'short' }), { ...env, ADMIN_TOKEN: 'short' }, now)).status, 401);
  assert.equal((await handleRequest(request('/admin/status', {}, { method: 'GET' }), env, now)).status, 200);
  assert.equal((await handleRequest(request('/admin/test-push', {}, { method: 'GET' }), env, now)).status, 405);
});

test('API acceptance cannot activate; matching actual message code and fresh validation can', async t => {
  const { env, store } = fixture(t);
  const messages = mockWechat(t);
  assert.equal((await invoke(env, '/admin/enable')).status, 409);
  await store.put('validation', { valid: true });
  await store.put('control', { enabled: false, cloudValidatedAt: now, deliveryConfirmedAt: null });
  assert.equal((await invoke(env, '/admin/enable')).status, 409);
  const receipt = await startReceipt(env, messages);
  assert.equal((await invoke(env, '/admin/enable')).status, 409, 'accepted response alone is insufficient');
  const statusResponse = await handleRequest(request('/admin/status', {}, { method: 'GET' }), env, now);
  const statusText = await statusResponse.text();
  assert.equal(statusText.includes(sendKey), false);
  assert.equal(statusText.includes(adminToken), false);
  assert.equal(statusText.includes(`"code":"${receipt.code}"`), false);
  assert.equal((await invoke(env, '/admin/confirm-delivery', { ...receipt, testId: 'wrong-id' })).status, 409);
  const wrongCode = receipt.code === '000000' ? '000001' : '000000';
  assert.equal((await invoke(env, '/admin/confirm-delivery', { ...receipt, code: wrongCode })).status, 409);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt)).status, 200);
  assert.equal((await invoke(env, '/admin/enable')).status, 200);
  assert.equal((await store.get<{ enabled: boolean }>('control'))?.enabled, true);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt)).status, 409, 'receipt is single use');
});

test('receipt confirmation rejects expired and future-dated tests', async t => {
  const { env } = fixture(t);
  const messages = mockWechat(t);
  const receipt = await startReceipt(env, messages);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt, now - 1)).status, 409);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt, now + 30 * 60_000 + 1)).status, 409);
});

test('activation rejects old validation, old receipt, and explicitly failed validation', async t => {
  const { env, store } = fixture(t);
  const messages = mockWechat(t);
  await store.put('control', { enabled: false, cloudValidatedAt: now - day - 1, deliveryConfirmedAt: null });
  await store.put('validation', { valid: true });
  const receipt = await startReceipt(env, messages);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt)).status, 200);
  assert.equal((await invoke(env, '/admin/enable')).status, 409);
  const control = await store.get<Record<string, unknown>>('control');
  await store.put('control', { ...control, cloudValidatedAt: now, deliveryConfirmedAt: now - day - 1 });
  assert.equal((await invoke(env, '/admin/enable')).status, 409);
  await store.put('control', { ...control, cloudValidatedAt: now, deliveryConfirmedAt: now });
  await store.put('validation', { valid: false });
  assert.equal((await invoke(env, '/admin/enable')).status, 409);
});

test('changing SendKey after confirmed delivery requires a new receipt proof', async t => {
  const { env, store } = fixture(t);
  const messages = mockWechat(t);
  await store.put('control', { enabled: false, cloudValidatedAt: now, deliveryConfirmedAt: null });
  await store.put('validation', { valid: true });
  const receipt = await startReceipt(env, messages);
  assert.equal((await invoke(env, '/admin/confirm-delivery', receipt)).status, 200);
  const changed = { ...env, SERVERCHAN_SENDKEY: 'SCT9999999999SyntheticDifferentDestination' };
  assert.equal((await invoke(changed, '/admin/enable')).status, 409);
  assert.equal((await invoke(env, '/admin/enable')).status, 200);
});

test('Cloudflare fetch execution context never becomes the request timestamp', async t => {
  const { env, store } = fixture(t);
  const realNow = Date.now();
  await store.put('control', { enabled: true, cloudValidatedAt: realNow, deliveryConfirmedAt: realNow });
  await store.put('lastTick', { at: realNow });
  const context = { valueOf() { throw new Error('ExecutionContext is not a timestamp'); } };
  const response = await worker.fetch(request('/health', {}, { method: 'GET', auth: false }), env, context);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, 'ok');
});
