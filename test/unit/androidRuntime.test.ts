import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const runtime = fs.readFileSync('android/runtime.js', 'utf8');
function boot(backendOrigin: string) {
  const calls: { input: string | Request; init?: RequestInit }[] = [];
  let unregistered = false;
  const state = { backendOrigin, backendOrigins: ['https://myxiaoyu.com', 'https://approved.example'] };
  const window = { __XIAOYU_ANDROID__: state, fetch: async (input: string | Request, init?: RequestInit) => { calls.push({ input, init }); return new Response('ok'); } };
  vm.runInNewContext(runtime, { window, URL, Request, location: { href: 'https://myxiaoyu.com/', origin: 'https://myxiaoyu.com' },
    navigator: { serviceWorker: { getRegistrations: async () => [{ unregister: async () => { unregistered = true; } }] } },
    document: { addEventListener() {} } });
  return { window, calls, state, wasUnregistered: () => unregistered };
}
test('Android runtime redirects only canonical API requests to the signed allowlist', async () => {
  const app = boot('https://approved.example');
  await app.window.fetch('/api/roleplay/session', { method: 'POST', body: 'synthetic' });
  assert.equal(app.calls[0].input, 'https://approved.example/api/roleplay/session');
  assert.equal(app.calls[0].init?.method, 'POST');
  assert.equal(app.calls.length, 1, 'no POST replay');
  await app.window.fetch('https://other.example/api/test');
  assert.equal(app.calls[1].input, 'https://other.example/api/test');
  await app.window.fetch('/assets/main-build.js');
  assert.equal(app.calls[2].input, '/assets/main-build.js');
  assert.equal(app.wasUnregistered(), true);
});
test('unapproved backend cannot receive credentials; Request bodies and headers survive approved routing', async () => {
  const app = boot('https://unapproved.example');
  await app.window.fetch('/api/auth/me', { headers: { authorization: 'synthetic' } });
  assert.equal(app.calls[0].input, '/api/auth/me');
  app.state.backendOrigin = 'https://approved.example';
  await app.window.fetch(new Request('https://myxiaoyu.com/api/chat', { method: 'POST', headers: { authorization: 'synthetic' }, body: 'message' }));
  const request = app.calls[1].input as Request;
  assert.equal(request.url, 'https://approved.example/api/chat');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), 'synthetic');
  assert.equal(await request.text(), 'message');
});
