import { memoryQueryTerms } from './conversationMemorySelection.js';

export interface RecallQuestion { id: number; text: string; query: string }
export interface ConversationRecallPlan { questions: RecallQuestion[]; searches: string[]; omittedQuestions: number }

/** Local query views only. Never add an answer, another conversation, or a
 * model-generated synonym. Limits bound work, not membership or saved data. */
export function conversationRecallPlan(query: string, context = ''): ConversationRecallPlan {
  const pieces = [...new Set(query.split(/[?？;；\n]+|[，,](?=\S)|\b(?:and then|and also)\b|以及|還有|还有/iu)
    .map(s => s.trim()).filter(s => memoryQueryTerms(s).size > 0))];
  const selected = (pieces.length ? pieces : [query.trim()]).filter(Boolean).slice(0, 6);
  const subject = selected.length > 1 ? selected[0].slice(0, 160) : '';
  const questions = selected.map((text, id) => ({ id, text,
    query: id && subject ? `${subject}\n${text}` : text }));
  const direct = [...new Set([query, ...questions.map(q => q.text), ...questions.map(q => q.query)].filter(Boolean))].slice(0, 7);
  const searches = [...direct, ...(context ? [`${query}\n${context}`] : [])];
  return { questions, searches, omittedQuestions: Math.max(0, pieces.length - selected.length) };
}
