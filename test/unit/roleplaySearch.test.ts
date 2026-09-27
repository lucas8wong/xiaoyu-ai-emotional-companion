/**
 * 剧情来源搜索单测（2026-08-27 增强）
 * - searchScenarios 现在会在 tag/标题/简介/详情之外额外匹配「来源」（我方原创 / 网络作者名）
 * - 验证：搜「原创」命中 AI 创作；搜作者名命中对应小红书作者；英文 Original / RedNote 同样生效
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { searchScenarios } from '../../api/services/roleplay.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchedSource(r: any): boolean {
  return Array.isArray(r.matched) && r.matched.includes('source');
}

test('剧情来源搜索：搜「原创」命中我方原创（AI 创作）', () => {
  const r = searchScenarios('原创', 'zh') as any[];
  assert.ok(r.length > 0, '搜「原创」应有结果');
  assert.ok(r.some(x => x.source === 'AI 创作' && matchedSource(x)), '应命中 AI 创作且来源命中为 source');
});

test('剧情来源搜索：按网络作者名命中（小红书 糖醋鱼饼）', () => {
  const r = searchScenarios('糖醋鱼饼', 'zh') as any[];
  assert.ok(r.length > 0, '搜作者名应有结果');
  assert.ok(
    r.some(x => String(x.source).endsWith('糖醋鱼饼') && matchedSource(x)),
    '应命中该小红书作者且来源命中为 source'
  );
});

test('剧情来源搜索：平台词「小红书」命中网络作者', () => {
  const r = searchScenarios('小红书', 'zh') as any[];
  assert.ok(r.length > 0);
  assert.ok(r.every(x => String(x.source).startsWith('小红书,')), '搜「小红书」只应命中网络作者来源');
});

test('剧情来源搜索：英文模式按 Original / RedNote 命中', () => {
  const orig = searchScenarios('original', 'en') as any[];
  assert.ok(orig.length > 0);
  assert.ok(orig.some(x => x.source === 'Original by AI' && matchedSource(x)), '搜 original 应命中 AI 原创');

  const red = searchScenarios('RedNote', 'en') as any[];
  assert.ok(red.length > 0);
  assert.ok(red.every(x => String(x.source).startsWith('RedNote,')), '搜 RedNote 只应命中网络作者来源');
});
