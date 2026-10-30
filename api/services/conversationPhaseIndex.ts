import type { VerifiedConversationSummary } from './conversationSummaryCoverage.js';
import { memoryQueryTerms } from './conversationMemorySelection.js';

export interface ConversationPhase {
  id: string; from: number; to: number;
  chapters: Array<{ id: string; from: number; to: number; sourceStart: number; sourceEnd: number; text: string; messages: number[] }>;
}

/** Rebuildable in-memory directory of already validated chapters. Its ranges
 * are navigation only: never serialize as automatic recaps/coverage proofs.
 * Callers supply the current owner/run's chapters and correction exclusions. */
export function conversationPhaseIndex(chapters: readonly VerifiedConversationSummary[], before: number,
  excludedMessages: readonly number[] = []): ConversationPhase[] {
  const excluded = new Set(excludedMessages), phases = new Map<number, ConversationPhase>();
  for (const chapter of [...chapters].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const start = chapter.sourceStartMessage, end = chapter.sourceEndMessage;
    if (start === undefined || !Number.isInteger(start) || start < 0 || end <= start || end - start > 128 || end > before
      || excludedMessages.some(i => i >= start && i < end)) continue;
    const bucket = Math.floor((chapter.from - 1) / 50);
    let phase = phases.get(bucket);
    if (!phase) { phase = { id: `phase:${bucket * 50 + 1}`, from: chapter.from, to: chapter.to, chapters: [] }; phases.set(bucket, phase); }
    phase.to = Math.max(phase.to, chapter.to);
    const facts = (chapter.facts || []).filter(f => f.evidence.length && f.evidence.every(e => e.message >= start && e.message < end && !excluded.has(e.message)));
    phase.chapters.push({ id: `recap:${chapter.from}:${chapter.to}`, from: chapter.from, to: chapter.to,
      sourceStart: start, sourceEnd: end,
      text: [chapter.text, ...facts.map(f => f.text)].join('\n'),
      messages: [...new Set(facts.flatMap(f => f.evidence.map(e => e.message)))].sort((a, b) => a - b) });
  }
  return [...phases.values()];
}

/** Directory hits locate source ranges, never establish a fact or a date. */
export function phaseSourceCandidates(phases: readonly ConversationPhase[], queries: readonly string[]) {
  const chapters = phases.flatMap(p => p.chapters), selected = new Map<string, typeof chapters[number]>();
  const terms = chapters.map(c => memoryQueryTerms(c.text)), frequency = new Map<string,number>();
  for (const set of terms) for (const term of set) frequency.set(term,(frequency.get(term)||0)+1);
  for (const query of queries) {
    const wanted=memoryQueryTerms(query);
    const scores=terms.map(set=>[...wanted].reduce((score,term)=>score+(set.has(term)?Math.log(1+chapters.length/(frequency.get(term)||1)):0),0));
    const matches = chapters.map((chapter, i) => ({ chapter, score: scores[i] }))
      .filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.chapter.from - b.chapter.from).slice(0, 2);
    for (const { chapter } of matches) { if (selected.size < 8) selected.set(chapter.id, chapter); }
  }
  return [...selected.values()];
}
