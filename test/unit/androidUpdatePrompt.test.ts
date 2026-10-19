import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidUpdatePromptGate } from '../../src/lib/androidUpdatePrompt';

test('only a confirmed newer release prompts during a foreground visit, without login', () => {
  const gate = createAndroidUpdatePromptGate();
  assert.equal(gate.claim('available', false), false);
  gate.enter('1');
  for (const status of [undefined, 'checking', 'current', 'failed', 'downloading']) assert.equal(gate.claim(status, false), false);
  assert.equal(gate.claim('available', false), true);
});
test('waits for other dialogs and typing; navigating within the app does not repeat', () => {
  const gate = createAndroidUpdatePromptGate();
  gate.enter('1');
  assert.equal(gate.claim('available', true), false);
  assert.equal(gate.claim('available', false), true);
  assert.equal(gate.enter('1'), false);
  assert.equal(gate.claim('ready', false), false);
});
test('background return and cold restart can remind again without a new login', () => {
  const gate = createAndroidUpdatePromptGate();
  gate.enter('1'); gate.claim('available', false);
  assert.equal(gate.claim('available', false), false);
  gate.enter('2');
  assert.equal(gate.claim('ready', false), true);
  const reopened = createAndroidUpdatePromptGate(); reopened.enter('1');
  assert.equal(reopened.claim('available', false), true);
});
