import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { creationPromptLog } = await import('../../api/services/creationPromptLog.js');

test('AI 建剧提示词日志：写入后可按用户取回，新的在前', () => {
  creationPromptLog.add({ userId: 'u-a', kind: 'roleplay-draft', prompt: '第一个灵感', outcome: 'ok', lang: 'zh', resultTitle: '标题一' });
  creationPromptLog.add({ userId: 'u-a', kind: 'roleplay-revise', prompt: '改成更温柔', outcome: 'ok', lang: 'zh', scenarioId: 'custom_x' });
  creationPromptLog.add({ userId: 'u-b', kind: 'wenyou-generate', prompt: '赛博江湖', outcome: 'ok', lang: 'zh', resultTitle: '赛博江湖' });

  const list = creationPromptLog.listByUser('u-a', 10);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].prompt, '改成更温柔', '最新的在前');
  assert.strictEqual(list[0].kind, 'roleplay-revise');
  assert.strictEqual(list[0].scenarioId, 'custom_x');
  assert.strictEqual(list[1].prompt, '第一个灵感');
  assert.strictEqual(list[1].resultTitle, '标题一');
});

test('AI 建剧提示词日志：按用户隔离，不串到别人名下', () => {
  const a = creationPromptLog.listByUser('u-a', 50).map((e) => e.prompt);
  const b = creationPromptLog.listByUser('u-b', 50).map((e) => e.prompt);
  assert.ok(!a.includes('赛博江湖'));
  assert.deepStrictEqual(b, ['赛博江湖']);
});

test('AI 建剧提示词日志：超长提示词（用户直接贴整份剧本）会被截断', () => {
  const long = '人物设定。'.repeat(3000); // 15000 字
  const rec = creationPromptLog.add({ userId: 'u-long', kind: 'roleplay-draft', prompt: long, outcome: 'ok' });
  assert.ok(long.length > 8000);
  assert.ok(rec.prompt.length <= 8000 + 8, '应截断到 8000 字左右，实际 ' + rec.prompt.length);
  assert.ok(rec.prompt.endsWith('…（已截断）'));
});

test('AI 建剧提示词日志：失败/被拦的调用同样留痕（含原因档）', () => {
  creationPromptLog.add({ userId: 'u-c', kind: 'roleplay-draft', prompt: '被拦的灵感', outcome: 'blocked' });
  creationPromptLog.add({ userId: 'u-c', kind: 'roleplay-draft', prompt: '格式抖动的灵感', outcome: 'format' });
  creationPromptLog.add({ userId: 'u-c', kind: 'wenyou-generate', prompt: '上游挂了', outcome: 'error' });
  const list = creationPromptLog.listByUser('u-c', 10);
  assert.deepStrictEqual(list.map((e) => e.outcome).sort(), ['blocked', 'error', 'format']);
  assert.strictEqual(creationPromptLog.listRecent(3).length, 3);
});
