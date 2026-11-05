import { latestCompletedSession, sessionForDate, sessionsBetween } from './calendar.js';
import type { Bar, Fetcher, Symbol, ValuationSnapshot } from './types.js';

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const SOURCES = {
  SPYM: 'https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-sp-500-etf-spym',
  QQQM: 'https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-nasdaq-100-etf-qndx',
} as const;
const nyDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function dateAt(ms: number): string {
  const utc = new Date(ms);
  const hour = utc.getUTCHours();
  // US daily bars are normally stamped at 13:30/14:30 UTC. Only 04:00-04:59
  // UTC needs a DST-aware lookup to decide which New York date it belongs to.
  if (hour >= 5) return utc.toISOString().slice(0, 10);
  if (hour < 4) return new Date(ms - 86_400_000).toISOString().slice(0, 10);
  const p = Object.fromEntries(nyDate.formatToParts(ms).map(item => [item.type, item.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function assertSymbol(symbol: string): asserts symbol is Symbol {
  if (symbol !== 'QQQM' && symbol !== 'SPYM') throw new Error('Unsupported ETF symbol');
}

async function boundedText(url: string, fetcher: Fetcher): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Provider request timed out')); }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'XiaoyuIndependentETFMonitor/1.0', Accept: 'application/json,text/html;q=0.9' },
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('Provider response too large');
      if (!response.body) throw new Error('Provider returned an empty body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('Provider response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(combined);
    })()]);
  } catch (error) {
    // Never expose a provider response body, stack, request context or ambient secrets.
    if (error instanceof Error && /^(Provider (HTTP \d{3}|request timed out|response too large|returned an empty body))$/.test(error.message)) throw error;
    throw new Error('Provider network request failed');
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/** Parse complete daily bars; the SPYM endpoint already carries its own SPLG history. */
export function parseYahooBars(payload: unknown, symbol: Symbol, nowMs: number): Bar[] {
  assertSymbol(symbol);
  const data = payload as { chart?: { error?: unknown; result?: Array<Record<string, any>> } };
  if (!data?.chart || data.chart.error || !Array.isArray(data.chart.result) || data.chart.result.length !== 1) {
    throw new Error('Yahoo returned no unambiguous series');
  }
  const result = data.chart.result[0];
  if (result.meta?.symbol !== symbol || result.meta?.currency !== 'USD' ||
      (result.meta?.dataGranularity && result.meta.dataGranularity !== '1d')) {
    throw new Error('Yahoo series identity or currency mismatch');
  }
  const times = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(times) || !Array.isArray(closes) || !Array.isArray(adjusted) ||
      times.length !== closes.length || times.length !== adjusted.length) {
    throw new Error('Yahoo daily arrays are missing or misaligned');
  }
  const latest = latestCompletedSession(nowMs).date;
  const today = dateAt(nowMs);
  const barDates = times.map((timestamp: unknown) => {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) throw new Error('Yahoo timestamp is invalid');
    return dateAt(timestamp * 1000);
  });
  if (!barDates.length) throw new Error('Yahoo history has fewer than 252 completed sessions');
  const sortedDates = [...barDates].sort();
  const tradingDates = new Set(sessionsBetween(sortedDates[0], sortedDates[sortedDates.length - 1]));
  const bars: Bar[] = [];
  const dates = new Set<string>();
  for (let index = 0; index < times.length; index++) {
    const date = barDates[index];
    if (date > today) throw new Error('Yahoo returned a future bar');
    if (!tradingDates.has(date)) throw new Error('Yahoo returned a nontrading-day bar');
    if (dates.has(date)) throw new Error('Yahoo returned duplicate daily bars');
    dates.add(date);
    if (date > latest) continue; // Current uncompleted session is never an input.
    if (!validPrice(closes[index]) || !validPrice(adjusted[index])) throw new Error('Yahoo completed bar has invalid prices');
    bars.push({ date, close: closes[index], adjustedClose: adjusted[index] });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 252) throw new Error('Yahoo history has fewer than 252 completed sessions');
  const expected = sessionsBetween(bars[0].date, bars[bars.length - 1].date);
  if (bars.length !== expected.length || bars.some((bar, i) => bar.date !== expected[i])) {
    throw new Error('Yahoo daily history has missing trading sessions');
  }
  return bars;
}

export async function fetchBars(symbol: Symbol, nowMs: number, fetcher: Fetcher = fetch): Promise<Bar[]> {
  assertSymbol(symbol);
  for (const host of ['query1', 'query2']) {
    try {
      const body = await boundedText(`https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d`, fetcher);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new Error('Yahoo response is not valid JSON'); }
      return parseYahooBars(payload, symbol, nowMs);
    } catch { /* Bounded second host attempt; no legacy-symbol splice or invented data. */ }
  }
  throw new Error('Yahoo daily history unavailable or invalid after two attempts');
}

/** Longer offline replay history, restricted to the fund's current investment benchmark. */
export async function fetchBacktestBars(symbol: Symbol, nowMs: number, fetcher: Fetcher = fetch): Promise<Bar[]> {
  assertSymbol(symbol);
  latestCompletedSession(nowMs); // Reject unsupported calendar years before any request.
  const startDate = symbol === 'QQQM' ? '2020-10-13' : '2020-01-24';
  const period1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const period2 = Math.floor(nowMs / 1000);
  for (const host of ['query1', 'query2']) {
    try {
      const body = await boundedText(`https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`, fetcher);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new Error('Yahoo response is not valid JSON'); }
      const bars = parseYahooBars(payload, symbol, nowMs);
      if (bars[0].date < startDate) throw new Error('Yahoo returned history before the supported fund benchmark');
      return bars;
    } catch { /* Only this fund's own endpoint; never splice another fund or benchmark. */ }
  }
  throw new Error('Yahoo replay history unavailable or invalid after two attempts');
}

function plain(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&#xfeff;|&#65279;/gi, '')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Only the official Index Characteristics FY1 row is accepted, never a trailing/fund P/E. */
export function parseOfficialValuation(html: string, symbol: Symbol): ValuationSnapshot {
  assertSymbol(symbol);
  if (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > MAX_BYTES) throw new Error('Official valuation page is invalid');
  const sections = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section\s*>/gi)]
    .map(match => match[1])
    .filter(section => /<h2\b[^>]*>[\s\S]*?Index\s+Characteristics\b[\s\S]*?<\/h2\s*>/i.test(section));
  if (sections.length !== 1) throw new Error('Official index characteristics section is missing or ambiguous');
  const heading = sections[0].match(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i)?.[1] ?? '';
  const stamp = plain(heading).match(/\bas of\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!stamp) throw new Error('Official valuation date is missing');
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const date = `${stamp[3]}-${String(months.indexOf(stamp[1].toLowerCase()) + 1).padStart(2, '0')}-${stamp[2].padStart(2, '0')}`;
  if (!sessionForDate(date)) throw new Error('Official valuation date is not a trading session');
  const values = [...sections[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].flatMap(row => {
    const cells = [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(cell => plain(cell[2]));
    return cells.length === 2 && cells[0] === 'Price/Earnings Ratio FY1' ? [cells[1]] : [];
  });
  if (values.length !== 1 || !/^\d+(?:\.\d+)?$/.test(values[0])) throw new Error('Official index FY1 P/E row is missing or ambiguous');
  const pe = Number(values[0]);
  if (!validPrice(pe)) throw new Error('Official index FY1 P/E is invalid');
  return {
    symbol, date, pe, source: SOURCES[symbol],
    method: 'SSGA index FY1 P/E; weighted harmonic average; forecast one-year EPS; positive and negative outliers included',
    proxy: symbol === 'QQQM' ? 'Nasdaq-100 index via official QNDX page; proxy for QQQM' : 'S&P 500 index via official SPYM page',
  };
}

export async function fetchValuation(symbol: Symbol, nowMs: number, fetcher: Fetcher = fetch): Promise<ValuationSnapshot> {
  assertSymbol(symbol);
  const snapshot = parseOfficialValuation(await boundedText(SOURCES[symbol], fetcher), symbol);
  if (snapshot.date > latestCompletedSession(nowMs).date) throw new Error('Official valuation is not from a completed session');
  return snapshot;
}
