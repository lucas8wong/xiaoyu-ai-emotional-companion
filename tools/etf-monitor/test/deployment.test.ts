import test from 'node:test';
import assert from 'node:assert/strict';
// Scripts are intentionally JS so account setup works without a TS runtime.
// @ts-ignore no declaration required for the deployment CLI helper
import { safeUrl, adminRequest, wranglerEnvironment, root } from '../scripts/common.mjs';

test('deployment URL cannot transmit the administrative bearer to an unrelated host', () => {
  assert.equal(safeUrl('https://synthetic-monitor.example.workers.dev/'), 'https://synthetic-monitor.example.workers.dev');
  for (const value of ['http://synthetic.workers.dev', 'https://workers.dev.evil.invalid', 'https://example.invalid',
    'https://user:password@example.workers.dev', 'https://example.workers.dev/path',
    'https://example.workers.dev/?token=secret', 'https://example.workers.dev:4433']) {
    assert.throws(() => safeUrl(value));
  }
});

test('admin transport refuses redirects and credentials do not enter URL/body', async t => {
  const token = 'synthetic-management-token-with-thirty-two-chars';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), 'https://synthetic.example.workers.dev/admin/status');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    assert.equal(init?.body, undefined);
    return Response.json({ control: { enabled: false } });
  });
  await adminRequest('https://synthetic.example.workers.dev', token, '/admin/status');
  assert.equal(calls, 1);
  await assert.rejects(adminRequest('https://unrelated.invalid', token, '/admin/status'));
  assert.equal(calls, 1);
});

test('wrangler writes OAuth and log state only inside the isolated ignored project directory', () => {
  const environment = wranglerEnvironment();
  assert.equal(environment.WRANGLER_SEND_METRICS, 'false');
  assert.ok(environment.XDG_CONFIG_HOME.startsWith(root));
  assert.ok(environment.WRANGLER_LOG_PATH.startsWith(root));
});
