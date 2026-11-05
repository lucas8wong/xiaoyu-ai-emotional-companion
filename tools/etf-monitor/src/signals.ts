import type { Bar, Direction, Metrics, SignalState, Symbol, Thresholds, ValuationResult, ValuationSnapshot } from './types.js';

/** Initial heuristics, not empirically established forecasts. Percentages use 100 = 100%. */
export const defaultThresholds: Record<Symbol, Thresholds> = {
  QQQM: { drawdownPct: -15, belowMaPct: -8, aboveMaPct: 15 },
  SPYM: { drawdownPct: -10, belowMaPct: -5, aboveMaPct: 10 },
};

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Fails closed rather than silently filling or dropping questionable observations. */
export function analyzeBars(symbol: Symbol, bars: Bar[]): Metrics {
  if (!defaultThresholds[symbol]) throw new Error('Unsupported ETF');
  if (bars.length < 252) throw new Error('At least 252 daily observations are required');
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!validDate(bar.date) || !Number.isFinite(bar.close) || bar.close <= 0 ||
      !Number.isFinite(bar.adjustedClose) || bar.adjustedClose <= 0) throw new Error('Invalid daily observation');
    if (i > 0 && bars[i - 1].date >= bar.date) throw new Error('Daily observations must be unique and chronological');
  }
  const last = bars[bars.length - 1];
  const prior = bars[bars.length - 2];
  const peak = Math.max(...bars.slice(-252).map((bar) => bar.adjustedClose));
  const ma200 = bars.slice(-200).reduce((sum, bar) => sum + bar.adjustedClose, 0) / 200;
  return {
    date: last.date,
    close: last.close,
    changePct: (last.adjustedClose / prior.adjustedClose - 1) * 100,
    drawdownPct: (last.adjustedClose / peak - 1) * 100,
    ma200,
    gapPct: (last.adjustedClose / ma200 - 1) * 100,
  };
}

export function priceCondition(symbol: Symbol, metrics: Metrics, thresholds = defaultThresholds[symbol]): Direction {
  if (!thresholds || ![metrics.drawdownPct, metrics.gapPct, thresholds.drawdownPct,
    thresholds.belowMaPct, thresholds.aboveMaPct].every(Number.isFinite)) throw new Error('Invalid price conditions');
  if (thresholds.drawdownPct >= 0 || thresholds.belowMaPct >= 0 || thresholds.aboveMaPct <= 0) {
    throw new Error('Invalid price thresholds');
  }
  if (metrics.drawdownPct <= thresholds.drawdownPct && metrics.gapPct <= thresholds.belowMaPct) return 'low';
  if (metrics.gapPct >= thresholds.aboveMaPct) return 'hot';
  return 'neutral';
}

/** Only state transitions can alert; staying in a condition never creates periodic reminders. */
export function advanceSignal(previous: SignalState | null, observed: Direction, date: string, sessionDates: string[]): {
  state: SignalState; changed: boolean; alert: boolean;
} {
  const position = sessionDates.indexOf(date);
  if (!validDate(date) || position < 0) throw new Error('Signal date must be an exchange session');
  if (!['low', 'neutral', 'hot'].includes(observed)) throw new Error('Invalid signal direction');
  const state: SignalState = previous ? { ...previous, lastAlerts: { ...previous.lastAlerts } } : {
    confirmed: 'neutral', candidate: 'neutral', candidateCount: 0, lastDate: null, lastAlerts: {},
  };
  if (state.lastDate && date <= state.lastDate) return { state, changed: false, alert: false };
  const adjacent = state.lastDate !== null && position > 0 && sessionDates[position - 1] === state.lastDate;
  state.candidateCount = adjacent && state.candidate === observed ? Math.min(state.candidateCount + 1, 2) : 1;
  state.candidate = observed;
  state.lastDate = date;
  const changed = state.candidateCount >= 2 && state.confirmed !== observed;
  let alert = false;
  if (changed) {
    const previousDirection = state.confirmed;
    state.confirmed = observed;
    if (observed !== 'neutral') {
      const lastAlert = state.lastAlerts[observed];
      const sessionsSinceAlert = lastAlert ? sessionDates.filter((session) => session > lastAlert && session <= date).length : Infinity;
      alert = previousDirection !== 'neutral' || sessionsSinceAlert >= 5;
      if (alert) state.lastAlerts[observed] = date;
    }
  }
  return { state, changed, alert };
}

function monthBefore(date: string, count: number): string {
  const month = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  month.setUTCMonth(month.getUTCMonth() - count);
  return month.toISOString().slice(0, 7);
}

/** Price extremes never stand in for unavailable fundamental valuation history. */
export function assessValuation(symbol: Symbol, snapshots: ValuationSnapshot[], asOfDate: string, sessionDates: string[]): ValuationResult {
  const available = snapshots.filter((item) => item.symbol === symbol && validDate(item.date) && item.date <= asOfDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  const current = available[0];
  const unknown = (reason: string): ValuationResult => ({
    status: 'unknown', pe: current && Number.isFinite(current.pe) && current.pe > 0 ? current.pe : null,
    date: current?.date ?? null, percentile: null, reason, source: current?.source ?? '',
  });
  if (!validDate(asOfDate)) return unknown('估值截止日期无效');
  if (!current) return unknown('缺少当前 FY1 市盈率及同口径五年历史');
  if (!Number.isFinite(current.pe) || current.pe <= 0) return unknown('当前 FY1 市盈率无效');
  if (!current.source.trim() || !current.method.trim() || !current.proxy.trim() || !/FY1/i.test(current.method)) {
    return unknown('缺少可核对的 FY1 来源、算法或指数口径');
  }
  if (!sessionDates.includes(current.date)) return unknown('当前估值日期不是已知交易日');
  if (sessionDates.filter((date) => date > current.date && date <= asOfDate).length > 5) return unknown('当前估值超过五个完整交易日未更新');
  const matchesCurrent = (item: ValuationSnapshot) => item.source === current.source && item.method === current.method && item.proxy === current.proxy;
  const latestDay = available.filter((item) => item.date === current.date);
  if (latestDay.some((item) => !matchesCurrent(item) || item.pe !== current.pe)) return unknown('当前估值存在冲突口径');
  const historical: number[] = [];
  for (let offset = 60; offset >= 1; offset--) {
    const month = monthBefore(asOfDate, offset);
    const monthSessions = sessionDates.filter((date) => date.startsWith(month));
    const monthEnd = monthSessions[monthSessions.length - 1];
    if (!monthEnd) return unknown('交易日历不足以核对连续六十个月末');
    const monthRows = available.filter((item) => item.date === monthEnd && matchesCurrent(item));
    if (!monthRows.length || monthRows.some((item) => !Number.isFinite(item.pe) || item.pe <= 0 || item.pe !== monthRows[0].pe)) {
      return unknown('缺少连续六十个完整月末的同口径 FY1 历史');
    }
    historical.push(monthRows[0].pe);
  }
  const lower = historical.filter((pe) => pe < current.pe).length;
  const equal = historical.filter((pe) => pe === current.pe).length;
  const percentile = (lower + equal / 2) / historical.length * 100;
  return {
    status: percentile <= 20 ? 'cheap' : percentile >= 80 ? 'expensive' : 'fair',
    pe: current.pe, date: current.date, percentile,
    reason: '同来源、算法及指数的固定五年六十个月末 FY1 市盈率分位', source: current.source,
  };
}
