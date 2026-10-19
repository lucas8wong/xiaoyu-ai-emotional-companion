import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidUpdatePromptGate } from '../../src/lib/androidUpdatePrompt';

test('silent for guests, current version, checks and connection failures', () => {
  const gate = createAndroidUpdatePromptGate();
  assert.equal(gate.claim('available', false), false);
  gate.enter('synthetic-session');
  assert.equal(gate.check(), true);
  assert.equal(gate.check(), false);
  for (const status of [undefined, 'checking', 'current', 'failed', 'downloading']) assert.equal(gate.claim(status, false), false);
  assert.equal(gate.claim('available', false), true);
});
test('waits for a safe Home visit; returning from a story does not repeat a dismissed prompt', () => {
  const gate = createAndroidUpdatePromptGate();
  gate.enter('synthetic-session');
  assert.equal(gate.claim('available', true), false);
  assert.equal(gate.claim('available', false), true);
  assert.equal(gate.enter('synthetic-session'), false);
  assert.equal(gate.claim('ready', false), false);
});
test('next login or app restart can remind again, including a downloaded update', () => {
  const gate = createAndroidUpdatePromptGate();
  gate.enter('first-login'); gate.claim('available', false);
  gate.enter(''); assert.equal(gate.check(), false);
  gate.enter('second-login'); assert.equal(gate.check(), true);
  assert.equal(gate.claim('ready', false), true);
  const reopened = createAndroidUpdatePromptGate(); reopened.enter('second-login');
  assert.equal(reopened.claim('available', false), true);
});
