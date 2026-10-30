import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from '../unit/setup.js';
setupTempCwd();
process.env.PERSISTENCE_PROVIDER = 'sqlite';
process.env.ARCHIVE_SEMANTIC = '0';
const { conversationArchive: archive } = await import('../../api/storage/conversationArchive.js');
const { hybridArchiveRecallBlock, emptyArchiveEvidence } = await import('../../api/services/archiveRecall.js');
const { archiveSemantic } = await import('../../api/services/archiveSemantic.js');
const { sourceDigest, admittedSummaryCoverage } = await import('../../api/services/conversationSummaryCoverage.js');
const { fitMemoryText, fitStoryMemory } = await import('../../api/services/storyInputBudget.js');
const { groupMemoryEvidenceRecords } = await import('../../api/services/conversationMemorySelection.js');
const { estimateTextTokens } = await import('../../api/services/quota.js');
const source = [
  { role: 'user', content: '林澄承诺借出三百元，必须周六归还，而且先交押金。', timestamp: 1800000000000 },
  { role: 'assistant', content: '答应有条件借款，尚未交付。', timestamp: 1800000001000 },
  { role: 'user', content: '后来林澄取消了承诺，没有交付三百元。', timestamp: 1800000002000 },
  { role: 'assistant', content: '原借款已取消。', timestamp: 1800000003000 },
];

test('final wrapper and shared allocator cannot separate conditions from their evidence group', async () => {
  archive.ensure('atomic-final', () => source);
  const block = await hybridArchiveRecallBlock('atomic-final', '林澄借款的条件和最后结果是什么？', 4, { evidenceTokens: 4096 });
  const groups = groupMemoryEvidenceRecords(block).groups;
  assert.ok(groups.length); assert.deepEqual(admittedSummaryCoverage(block), []);
  const budget = estimateTextTokens(block) - 5;
  const wrapper = fitMemoryText(block, budget, estimateTextTokens, '林澄借款条件？');
  for (const group of groups) assert.ok(!wrapper.includes(group.text.split('\n')[0]) || wrapper.includes(group.text));
  const selected = fitStoryMemory('', block, { count: 20, tokens: 4096, inputTokens: 8192 }, estimateTextTokens, 100, 4096, '林澄借款条件？');
  const text = JSON.stringify(selected);
  assert.match(text, /周六归还/); assert.match(text, /先交押金/); assert.match(text, /取消/);
});

test('navigation is owner/source checked, cannot revive exclusions, and never grants coverage', async () => {
  archive.ensure('phase-owner', () => source);
  archive.ensure('different-owner', () => [{ role: 'user', content: 'PRIVATE_FOREIGN_SOURCE' }]);
  const info = archive.info('phase-owner');
  const chapter = { version: 1 as const, from: 1, to: 2, text: '林澄借款的条件', sourceHash: sourceDigest(source),
    archiveScope: 'phase-owner', sourceRevision: info.revision, sourceStartMessage: 0, sourceEndMessage: 4, facts: [] };
  const block = await hybridArchiveRecallBlock('phase-owner', '林澄借款条件？', 4, { navigationChapters: [chapter], excludedMessages: [0, 1] });
  assert.doesNotMatch(block, /周六归还|先交押金/); assert.deepEqual(admittedSummaryCoverage(block), []);
  const foreign = await hybridArchiveRecallBlock('different-owner', '林澄借款条件？', 1, { navigationChapters: [chapter] });
  assert.equal(foreign, emptyArchiveEvidence('en'));
  const original = archive.range('phase-owner', 0, 4);
  assert.deepEqual(original, source);
});

test('a rewrite during the semantic await invalidates the complete result', async t => {
  archive.ensure('rewrite-await', () => source);
  t.mock.method(archiveSemantic, 'search', async () => {
    archive.writeSuffix('rewrite-await', 0, [{ role: 'user', content: '新版没有这条借款。' }]);
    return [{ at: 0, message: source[0], start: 0, score: 1 }];
  });
  assert.equal(await hybridArchiveRecallBlock('rewrite-await', '林澄借款条件？', 4), '');
});

test('the rollback switch restores the previous path and all source bytes remain intact', async () => {
  archive.ensure('rollback-v2', () => source);
  const previous = process.env.CONVERSATION_RECALL_V2;
  try {
    process.env.CONVERSATION_RECALL_V2 = '0';
    const old = await hybridArchiveRecallBlock('rollback-v2', '林澄借款条件？', 4);
    assert.doesNotMatch(old, /evidenceGroup/);
    process.env.CONVERSATION_RECALL_V2 = '1';
    const next = await hybridArchiveRecallBlock('rollback-v2', '林澄借款条件？', 4);
    assert.match(next, /evidenceGroup/);
    assert.deepEqual(archive.range('rollback-v2', 0, 4), source);
  } finally { if (previous === undefined) delete process.env.CONVERSATION_RECALL_V2; else process.env.CONVERSATION_RECALL_V2 = previous; }
});

test('recent cutoff and deletion time apply to phase sources and adjacent rows', async () => {
  archive.ensure('cutoff-v2', () => source);
  const before = await hybridArchiveRecallBlock('cutoff-v2', '林澄借款条件？', 2);
  assert.match(before, /周六归还/); assert.doesNotMatch(before, /取消/);
  const after = await hybridArchiveRecallBlock('cutoff-v2', '林澄借款条件？', 4, { after: source[2].timestamp });
  assert.doesNotMatch(after, /周六归还|先交押金|没有交付/);
});
