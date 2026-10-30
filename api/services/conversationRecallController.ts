import type { ArchivedMessage } from '../storage/conversationArchive.js';
import { memoryRelevance } from './conversationMemorySelection.js';
import { conversationRecallPlan } from './conversationRecallPlan.js';
import { conversationPhaseIndex, phaseSourceCandidates } from './conversationPhaseIndex.js';
import type { VerifiedConversationSummary } from './conversationSummaryCoverage.js';
import { sourceEvidenceGroups, selectEvidenceGroups, type RecallCandidate } from './conversationEvidenceGroups.js';

export interface RecallDiagnostics {
  version: 2; queries: number; omittedQuestions: number; rounds: number; phaseChapters: number;
  candidateMessages: number; selectedGroups: number; omittedGroups: number; matchedQueryParts: number[];
}
export interface RecallPorts {
  read(from: number, to: number): ArchivedMessage[];
  lexical(query: string): RecallCandidate[];
  semantic(queries: readonly string[]): Promise<RecallCandidate[]>;
  current(): boolean;
  allowed(at: number, message: ArchivedMessage): boolean;
  estimate(text: string): number;
}

/** Owner-scoped callers own authorization and source validation. This controller
 * only performs local searches/reads; no inference, writes, charge, or history
 * coverage. Search similarity is never reported as answer correctness. */
export async function conversationRecallController(query: string, before: number, budget: number, ports: RecallPorts,
  options: { context?: string; chapters?: readonly VerifiedConversationSummary[]; excludedMessages?: readonly number[] } = {}) {
  const plan = conversationRecallPlan(query, options.context), candidates = new Map<number, RecallCandidate>();
  const merge = (hits: readonly RecallCandidate[], weight: number) => {
    hits.forEach((hit, rank) => {
      if (!Number.isInteger(hit.at) || hit.at < 0 || hit.at >= before || !ports.allowed(hit.at, hit.message) || hit.message.content.trim() === query.trim()) return;
      const previous = candidates.get(hit.at);
      candidates.set(hit.at, { ...hit, ...(previous?.start !== undefined && hit.start === undefined ? { start: previous.start } : {}),
        score: (previous?.score || 0) + weight / (20 + rank) });
    });
  };
  for (const view of plan.searches) merge(ports.lexical(view), 1);
  try { merge(await ports.semantic(plan.searches), 1); } catch { /* independent lexical path remains available */ }
  if (!ports.current()) return null;

  const phases = process.env.CONVERSATION_PHASE_INDEX === '0' ? []
    : conversationPhaseIndex(options.chapters || [], before, options.excludedMessages);
  const chapters = phaseSourceCandidates(phases, plan.questions.map(q => q.query));
  // Phase facts only locate originals. Rank and load the actual owner-scoped
  // text, including facts missed by extraction in the same chapter.
  for (const chapter of chapters) {
    const source = ports.read(chapter.sourceStart, chapter.sourceEnd);
    const scores = memoryRelevance(query, source.map(m => m.content));
    const hits = source.map((message, i) => ({ at: chapter.sourceStart + i, message, score: scores[i] }))
      .filter(h => h.score > 0).sort((a, b) => b.score - a.score || a.at - b.at).slice(0, 3);
    merge(hits, .8);
  }
  let rounds = 1;
  const matching = (text: string) => plan.questions.filter(q => memoryRelevance(q.text, [text])[0] > 0).map(q => q.id);
  const found = new Set([...candidates.values()].flatMap(h => matching(h.message.content)));
  const missing = plan.questions.filter(q => !found.has(q.id));
  if (missing.length && plan.questions.length > 1) {
    rounds++;
    // An independent clause can recover a later subject diluted by the first
    // clause. Only one supplementary local wave; no model tool loop.
    for (const question of missing) merge(ports.lexical(question.text), 1);
  }
  if (!ports.current()) return null;
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score
    || Number(b.message.role === 'user') - Number(a.message.role === 'user') || a.at - b.at);
  // Keep independently matched subjects before spending slots on the global
  // top scores. The final token allocator still selects complete groups.
  const fair = new Map<number, RecallCandidate>();
  for (const question of plan.questions) {
    const scores = memoryRelevance(question.text, ranked.map(h => h.message.content));
    ranked.map((hit, i) => ({ hit, score: scores[i] })).filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || b.hit.score - a.hit.score).slice(0, 3).forEach(({ hit }) => fair.set(hit.at, hit));
  }
  for (const hit of ranked) { if (fair.size >= 24) break; fair.set(hit.at, hit); }
  const groups = sourceEvidenceGroups([...fair.values()], plan, ports.read, before, ports.allowed);
  const selection = selectEvidenceGroups(groups, plan, Math.max(0, budget), ports.estimate);
  if (!ports.current()) return null;
  const diagnostics: RecallDiagnostics = { version: 2, queries: plan.questions.length, omittedQuestions: plan.omittedQuestions,
    rounds, phaseChapters: chapters.length, candidateMessages: candidates.size, selectedGroups: selection.selected.length,
    omittedGroups: selection.omittedGroups, matchedQueryParts: selection.matchedQueryParts };
  return { text: selection.text, diagnostics };
}
