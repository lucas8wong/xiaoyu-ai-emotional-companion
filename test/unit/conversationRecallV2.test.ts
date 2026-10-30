import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationRecallPlan } from '../../api/services/conversationRecallPlan.js';
import { conversationPhaseIndex, phaseSourceCandidates } from '../../api/services/conversationPhaseIndex.js';
import { conversationRecallController, type RecallPorts } from '../../api/services/conversationRecallController.js';
import { evidencePassage, sourceEvidenceGroups, selectEvidenceGroups } from '../../api/services/conversationEvidenceGroups.js';
import { groupMemoryEvidenceRecords } from '../../api/services/conversationMemorySelection.js';
import type { VerifiedConversationSummary } from '../../api/services/conversationSummaryCoverage.js';

const chapter = (from: number, start: number, text: string): VerifiedConversationSummary => ({
  version: 1, from, to: from + 9, text, sourceHash: 'a'.repeat(64), archiveScope: 'owner/run', sourceRevision: 1,
  sourceStartMessage: start, sourceEndMessage: start + 20, facts: [],
});
const rows = [
  { role: 'user', content: '林澄答应借给我三百元，前提是周六归还。' },
  { role: 'assistant', content: '只有按期归还才借出，尚未交付。' },
  { role: 'user', content: '蓝色钥匙后来交给了何夏。' },
  { role: 'assistant', content: '何夏把蓝色钥匙放入青岚柜。' },
  { role: 'user', content: '补充：林澄已经取消借款承诺，没有交付三百元。' },
  { role: 'assistant', content: '取消与未交付均已明确。' },
];
const ports = (overrides: Partial<RecallPorts> = {}): RecallPorts => ({
  read: (a, b) => rows.slice(a, b),
  lexical: query => rows.flatMap((message, at) => query.includes('钥匙') && at === 2 || query.includes('借') && at === 0 ? [{ at, message, score: 1 }] : []),
  semantic: async () => [], current: () => true, allowed: () => true, estimate: s => s.length,
  ...overrides,
});

test('query planning retains independent subjects, source wording and bounded omitted parts', () => {
  const plan = conversationRecallPlan('林澄当初为什么借钱，蓝色钥匙后来给谁，借款最后兑现了吗？', '仅本人会话中的上下文');
  assert.equal(plan.questions.length, 3);
  assert.ok(plan.searches.includes('蓝色钥匙后来给谁'));
  assert.ok(plan.searches.every(s => !s.includes('青岚柜')));
  assert.ok(plan.searches.length <= 8);
  const many = conversationRecallPlan(Array.from({ length: 10 }, (_, i) => `人物${i}去了哪里`).join('？'));
  assert.equal(many.questions.length, 6); assert.equal(many.omittedQuestions, 4);
});

test('long-source passages preserve complete boundary sentences and exact UTF-16 source slices', () => {
  const content = '平常闲谈。'.repeat(150) + '🗝️蓝色钥匙交给何夏。只有周六归还才能借用。' + '其他天气。'.repeat(180);
  const passage = evidencePassage(content, '蓝色钥匙交给谁', content.indexOf('蓝色钥匙'));
  assert.equal(content.slice(passage.from, passage.to), passage.text);
  assert.match(passage.text, /只有周六归还才能借用。/);
  assert.ok(!passage.text.endsWith('只能'));
  const english = 'Ordinary text. '.repeat(120) + 'The key belongs to Nora. Only if it is returned on Saturday. More ordinary text.';
  assert.match(evidencePassage(english, 'key Nora', english.indexOf('key belongs')).text, /Only if it is returned on Saturday\./);
});

test('an indivisible unpunctuated source is omitted, never cut to make the budget fit', () => {
  const long = '完整姓名和全部条件'.repeat(300);
  assert.equal(evidencePassage(long, '条件').text, long);
  const plan = conversationRecallPlan('林澄借款条件？');
  const groups = sourceEvidenceGroups([{ at: 0, message: rows[0], score: 1 }], plan, (a, b) => rows.slice(a, b), 2, () => true);
  const full = selectEvidenceGroups(groups, plan, 10000, s => s.length);
  const short = selectEvidenceGroups(groups, plan, full.text.length - 1, s => s.length);
  assert.equal(short.text, ''); assert.equal(short.omittedGroups, 1);
  assert.equal(full.selected.length, 1); assert.match(full.text, /前提是周六归还/);
});

test('overlapping neighbourhoods stay bounded and explicit groups cannot chain across shared rows', () => {
  const plan = conversationRecallPlan('林澄与蓝色钥匙？');
  const groups = sourceEvidenceGroups(rows.map((message, at) => ({ at, message, score: 1 })), plan, (a, b) => rows.slice(a, b), rows.length, () => true);
  assert.ok(groups.every(g => g.rows.length <= 4));
  const block = [
    { message: 1, role: 'user', excerpt: '问题', evidenceGroup: 'source:0' },
    { message: 2, role: 'assistant', excerpt: '回答', evidenceGroup: 'source:0' },
    { message: 2, role: 'assistant', excerpt: '回答', evidenceGroup: 'source:2' },
    { message: 3, role: 'user', excerpt: '另一个问题', evidenceGroup: 'source:2' },
  ].map(r => JSON.stringify(r)).join('\n');
  assert.equal(groupMemoryEvidenceRecords(block).groups.length, 2);
});

test('the phase directory preserves child ranges, has no coverage, and excludes corrected chapters', () => {
  const chapters = [chapter(1, 0, '林澄的最初动机是帮助妹妹'), chapter(11, 20, '蓝色钥匙转交何夏'), chapter(51, 100, '后来已取消借款')];
  const phases = conversationPhaseIndex(chapters, 120);
  assert.equal(phases.length, 2); assert.equal(phases[0].chapters.length, 2);
  assert.ok(phaseSourceCandidates(phases, ['最初动机']).some(c => c.sourceStart === 0));
  assert.ok(!JSON.stringify(phases).includes('coverage'));
  assert.equal(conversationPhaseIndex(chapters, 120, [0])[0].chapters.length, 1);
  assert.equal(conversationPhaseIndex(chapters, 19).length, 0);
  assert.equal(conversationPhaseIndex([], 120).length, 0);
});

test('controller balances multiple subjects and retains conditions plus later cancellation', async () => {
  const result = await conversationRecallController('林澄借钱的条件是什么，蓝色钥匙交给谁，借款最后兑现了吗？', rows.length, 10000, ports({
    lexical: query => rows.flatMap((message, at) => query.includes('借') && [0, 4].includes(at) || query.includes('钥匙') && at === 2 ? [{ at, message, score: 1 }] : []),
  }));
  assert.ok(result); assert.match(result.text, /前提是周六归还/); assert.match(result.text, /何夏/); assert.match(result.text, /已经取消借款承诺/);
  assert.ok(result.diagnostics.matchedQueryParts.length >= 2);
  assert.ok(result.diagnostics.rounds <= 2);
});

test('a phase directory recovers a source even when both initial search paths miss it', async () => {
  const summary = { ...chapter(1, 0, '林澄答应借款，前提为周六归还。'), sourceEndMessage: 2 };
  const result = await conversationRecallController('林澄借款条件？', rows.length, 10000, ports({ lexical: () => [] }), { chapters: [summary] });
  assert.ok(result); assert.equal(result.diagnostics.phaseChapters, 1); assert.match(result.text, /周六归还/);
});

test('source revision changes after async search reject every candidate', async () => {
  let current = true;
  const result = await conversationRecallController('林澄借款条件？', rows.length, 10000,
    ports({ current: () => current, semantic: async () => { current = false; return []; } }));
  assert.equal(result, null);
});

test('excluded sources and deletion cutoffs apply to anchors and every neighbour', async () => {
  const result = await conversationRecallController('林澄借款条件？', rows.length, 10000,
    ports({ allowed: at => at > 1 }));
  assert.ok(result); assert.equal(result.text, '');
});

test('semantic-only matches remain usable without a literal match', async () => {
  const result = await conversationRecallController('the old arrangement?', rows.length, 10000,
    ports({ lexical: () => [], semantic: async () => [{ at: 0, message: rows[0], score: .8 }] }));
  assert.ok(result); assert.match(result.text, /前提是周六归还/);
});

test('the archive source, not a search result payload, supplies every quoted byte', async () => {
  const result = await conversationRecallController('林澄借款条件？', rows.length, 10000,
    ports({ lexical: () => [], semantic: async () => [{ at: 0, message: { role: 'user', content: 'FOREIGN_SECRET' }, score: 1 }] }));
  assert.ok(result); assert.doesNotMatch(result.text, /FOREIGN_SECRET/); assert.match(result.text, /周六归还/);
});
