import { randomUUID } from 'node:crypto';
import { dataFile, persistence, writeJsonStrict } from '../storage/persistence.js';

export interface FeatureUsageEvent {
  id: string; at: number; userId: string; action: string; observationId?: string;
  outcome: 'completed' | 'failed' | 'disconnected'; httpStatus: number;
  /** Allowlisted Express template, never raw URLs, body text, token, scenario or session IDs. */
  route?: string;
  origin?: 'client';
}
const FILE = dataFile('feature-usage-events.json');
function legacyLedger(): { since: number; events: FeatureUsageEvent[] } {
  const raw = persistence.read(FILE);
  if (!raw) return { since: Date.now(), events: [] };
  const value = JSON.parse(raw);
  if (!value || !Number.isFinite(value.since) || !Array.isArray(value.events)) throw Error('Invalid feature usage ledger');
  return value;
}
// Keep the legacy baseline in place. SQLite commits one small page and its cursor
// atomically. The file provider has no multi-key transactions and keeps its old format.
const PAGE_SIZE = 256;
const INDEX = dataFile('feature-usage-pages.json');
const pageFile = (page: number) => dataFile(`feature-usage-page-${page}.json`);
interface Index { lastPage: number; revision: string; since: number }
function readIndex(): Index | null {
  const raw = persistence.read(INDEX);
  if (raw === null) return null;
  const index = JSON.parse(raw);
  if (!index || !Number.isSafeInteger(index.lastPage) || index.lastPage < 0 ||
      !Number.isFinite(index.since) || typeof index.revision !== 'string') throw Error('Invalid feature usage index');
  return index;
}
function readPage(page: number): FeatureUsageEvent[] {
  const rows = JSON.parse(persistence.read(pageFile(page)) ?? 'null');
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw Error('Invalid feature usage page');
  return rows;
}
function readAll(index: Index | null) {
  const ledger = legacyLedger();
  if (index) {
    ledger.since = Math.min(ledger.since, index.since);
    for (let i = 0; i <= index.lastPage; i++) ledger.events.push(...readPage(i));
  }
  return ledger;
}

let cachedIds: { revision?: string; ids: Set<string>; since: number } | undefined;
function append(event: FeatureUsageEvent) {
  const index = readIndex();
  if (!cachedIds || cachedIds.revision !== index?.revision) {
    const ledger = readAll(index);
    cachedIds = { revision: index?.revision, ids: new Set(ledger.events.map(e => e.id)), since: ledger.since };
  }
  if (cachedIds.ids.has(event.id)) return;
  let page = index?.lastPage ?? 0;
  let rows = index ? readPage(page) : [];
  if (rows.length === PAGE_SIZE) { page++; rows = []; }
  const revision = randomUUID();
  const since = Math.min(cachedIds.since, event.at);
  writeJsonStrict(pageFile(page), [...rows, event]);
  writeJsonStrict(INDEX, { lastPage: page, since, revision });
  cachedIds.ids.add(event.id);
  cachedIds.revision = revision;
  cachedIds.since = since;
}

function changeOwner(from: string, to?: string) {
  const update = (rows: FeatureUsageEvent[]) => to === undefined ? rows.filter(e => e.userId !== from)
    : rows.map(e => e.userId === from ? { ...e, userId: to } : e);
  const work = () => {
    const legacy = legacyLedger();
    if (legacy.events.some(e => e.userId === from)) writeJsonStrict(FILE, { ...legacy, events: update(legacy.events) });
    if (!persistence.transaction) return;
    const index = readIndex();
    if (!index) return;
    for (let i = 0; i <= index.lastPage; i++) {
      const rows = readPage(i);
      if (rows.some(e => e.userId === from)) writeJsonStrict(pageFile(i), update(rows));
    }
    writeJsonStrict(INDEX, { ...index, revision: randomUUID() });
  };
  if (persistence.transaction) persistence.transaction(work); else work();
  cachedIds = undefined;
}
let errors = 0;
export const featureUsageEvents = {
  read: () => persistence.transaction ? persistence.transaction(() => readAll(readIndex())) : legacyLedger(),
  recordingErrors: () => errors,
  record(event: FeatureUsageEvent) {
    try {
      if (persistence.transaction) persistence.transaction(() => append(event));
      else {
        const data = legacyLedger();
        if (!data.events.some(e => e.id === event.id))
          writeJsonStrict(FILE, { ...data, since: Math.min(data.since,event.at), events: [...data.events, event] });
      }
      return true;
    } catch { errors++; console.error('[feature-usage] event persistence failed'); return false; }
  },
  deleteUser(userId: string) { changeOwner(userId); },
  reassignUser(from: string, to: string) { changeOwner(from, to); },
};
