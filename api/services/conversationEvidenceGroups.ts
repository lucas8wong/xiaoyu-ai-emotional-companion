import type { ArchivedMessage } from '../storage/conversationArchive.js';
import { memoryRelevance } from './conversationMemorySelection.js';
import type { ConversationRecallPlan } from './conversationRecallPlan.js';

export interface RecallCandidate { at: number; message: ArchivedMessage; start?: number; score: number }
export interface SourceEvidenceGroup { id: string; anchors: number[]; rows: Array<{ at: number; message: ArchivedMessage; start?: number }>; score: number; matches: number[] }

/** A complete sentence neighbourhood, never a character-cut predicate. A long
 * unpunctuated sentence remains whole and may be omitted by the final budget.
 * The record explicitly says whether the complete message was included. */
export function evidencePassage(content: string, query: string, start?: number) {
  if (content.length <= 900) return { text: content, from: 0, to: content.length };
  const spans: Array<{ from: number; to: number; text: string }> = [];
  const sentence = /[\s\S]+?(?:[。！？!?\n]+|[.](?=\s|$)|$)/gu;
  for (const match of content.matchAll(sentence)) if (match[0]) spans.push({ from: match.index!, to: match.index! + match[0].length, text: match[0] });
  if (!spans.length) return { text: content, from: 0, to: content.length };
  const scores = memoryRelevance(query, spans.map(s => s.text));
  const position = start === undefined ? -1 : spans.findIndex(s => start >= s.from && start < s.to);
  const best = position >= 0 ? position : scores.reduce((n, score, i) => score > scores[n] ? i : n, 0);
  const from = spans[Math.max(0, best - 1)].from, to = spans[Math.min(spans.length - 1, best + 1)].to;
  return { text: content.slice(from, to), from, to };
}

export function sourceEvidenceGroups(candidates: readonly RecallCandidate[], plan: ConversationRecallPlan,
  read: (from: number, to: number) => ArchivedMessage[], before: number, allowed: (at: number, message: ArchivedMessage) => boolean): SourceEvidenceGroup[] {
  const groups: SourceEvidenceGroup[] = [];
  for (const candidate of candidates.slice(0, 32)) {
    const at = candidate.at;
    if (!Number.isInteger(at) || at < 0 || at >= before) continue;
    const from = Math.max(0, at - 1), to = Math.min(before, at + 3), sources = read(from, to);
    const anchor = sources[at - from];
    if (!anchor || !allowed(at, anchor)) continue;
    // An assistant anchor needs its user's question. A user anchor needs its
    // answer; one following turn may supply a condition or correction.
    const indices = new Set([at]);
    if (anchor.role === 'assistant' && at > 0 && sources[at - from - 1]?.role === 'user') indices.add(at - 1);
    if (at + 1 < before) indices.add(at + 1);
    if (at + 2 < before && sources[at + 1 - from]?.role === 'assistant') indices.add(at + 2);
    const rows = sources.flatMap((message, i) => indices.has(from + i) && allowed(from + i, message)
      ? [{ at: from + i, message, ...(from + i === at && candidate.start !== undefined ? { start: candidate.start } : {}) }] : []);
    const text = rows.map(r => r.message.content).join('\n');
    const matches = plan.questions.filter(q => memoryRelevance(q.text, [text])[0] > 0).map(q => q.id);
    const group: SourceEvidenceGroup = { id: `source:${at}`, anchors: [at], rows, score: candidate.score, matches };
    // Overlapping groups are one atomic event. Do not serialize the same
    // message twice or turn adjacent pieces into mutually evictable facts.
    const overlaps = groups.filter(g => g.rows.some(r => rows.some(s => s.at === r.at))
      && new Set([...g.rows, ...rows].map(r => r.at)).size <= 4);
    for (const old of overlaps) {
      if (new Set([...old.rows, ...group.rows].map(r => r.at)).size > 4) continue;
      group.rows = [...new Map([...old.rows, ...group.rows].map(r => [r.at, r])).values()].sort((a, b) => a.at - b.at);
      group.anchors = [...new Set([...old.anchors, ...group.anchors])].sort((a, b) => a - b);
      group.matches = [...new Set([...old.matches, ...group.matches])];
      group.score = Math.max(group.score, old.score); groups.splice(groups.indexOf(old), 1);
    }
    group.id = `source:${group.anchors.join(':')}`;
    groups.push(group);
  }
  return groups.sort((a, b) => b.score - a.score || a.rows[0].at - b.rows[0].at);
}

export function serializeEvidenceGroup(group: SourceEvidenceGroup, query: string) {
  return group.rows.map(row => {
    const passage = evidencePassage(row.message.content, query, row.start);
    return JSON.stringify({ retrievalMatched: group.anchors.includes(row.at), evidenceGroup: group.id,
      message: row.at + 1, role: row.message.role, time: row.message.timestamp ? String(row.message.timestamp) : 'unknown',
      ...(!group.anchors.includes(row.at) ? { adjacentTo: group.anchors[0] + 1 } : {}),
      ...(passage.from !== 0 || passage.to !== row.message.content.length
        ? { excerptStart: passage.from, excerptEnd: passage.to, offsetUnit: 'utf16', completeMessage: false } : {}),
      excerpt: passage.text });
  }).join('\n');
}

/** Fair first pass per query, then relevance. Selection is indivisible and
 * bounded by the caller's existing evidence budget, including metadata. */
export function selectEvidenceGroups(groups: readonly SourceEvidenceGroup[], plan: ConversationRecallPlan, budget: number,
  estimate: (text: string) => number) {
  const selected = new Map<string, string>();
  const maximumGroups = Math.min(12, Math.max(3, plan.questions.length * 2));
  const add = (group: SourceEvidenceGroup) => {
    if (selected.has(group.id)) return true;
    if (selected.size >= maximumGroups) return false;
    const text = serializeEvidenceGroup(group, plan.searches[0] || '');
    if (estimate([...selected.values(), text].join('\n')) > budget) return false;
    selected.set(group.id, text); return true;
  };
  for (const question of plan.questions) for (const group of groups.filter(g => g.matches.includes(question.id))) if (add(group)) break;
  for (const group of groups) add(group);
  const admitted = groups.filter(g => selected.has(g.id));
  return { text: [...selected.values()].join('\n'), selected: admitted,
    matchedQueryParts: [...new Set(admitted.flatMap(g => g.matches))], omittedGroups: groups.length - admitted.length };
}
