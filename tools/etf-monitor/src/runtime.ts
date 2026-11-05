import { beijingDate, latestCompletedSession, sessionForDate, sessionsBetween } from './calendar.ts';
import { fetchBars, fetchValuation } from './providers.ts';
import { advanceSignal, analyzeBars, assessValuation, priceCondition } from './signals.ts';
import { renderReport } from './report.ts';
import { Store, type NotificationInput } from './store.ts';
import { dispatchNotifications } from './notify.ts';
import { SYMBOLS, type Analysis, type Bar, type Direction, type Fetcher, type SignalState, type Symbol, type ValuationSnapshot } from './types.ts';
import { fingerprint } from './fingerprint.ts';

export interface Control {
  enabled: boolean;
  cloudValidatedAt: number | null;
  deliveryConfirmedAt: number | null;
  deliveryFingerprint?: string;
}
export const INITIAL_CONTROL: Control = { enabled: false, cloudValidatedAt: null, deliveryConfirmedAt: null };
export interface Dependencies {
  bars: (symbol: Symbol, nowMs: number) => Promise<Bar[]>;
  valuation: (symbol: Symbol, nowMs: number) => Promise<ValuationSnapshot>;
  fetcher: Fetcher;
}
export const liveDependencies: Dependencies = { bars: fetchBars, valuation: fetchValuation, fetcher: fetch };
export async function controlFor(store: Store): Promise<Control> {
  return (await store.get<Control>('control')) ?? { ...INITIAL_CONTROL };
}
function valuationDirection(status: Analysis['valuation']['status']): Direction | null {
  return status === 'unknown' ? null : status === 'cheap' ? 'low' : status === 'expensive' ? 'hot' : 'neutral';
}

/** Network failures are deliberately reduced to fixed codes; never log secret-bearing URLs. */
export async function collect(store: Store, nowMs: number, deps: Dependencies = liveDependencies) {
  const expected = latestCompletedSession(nowMs).date;
  const values: Array<{ key: string; value: unknown }> = [];
  const alerts: Symbol[] = [];
  const valuationSessions = sessionsBetween(`${Math.max(2020, Number(expected.slice(0, 4)) - 6)}-01-01`, expected);
  const analyses = await Promise.all(SYMBOLS.map(async symbol => {
    const errors: string[] = [];
    const [priceResult, valuationResult] = await Promise.allSettled([
      deps.bars(symbol, nowMs), deps.valuation(symbol, nowMs),
    ]);
    let metrics: Analysis['metrics'] = null;
    let price: Direction | null = null;
    const previous = await store.get<SignalState>(`price:${symbol}`);
    let confirmed = previous?.confirmed ?? 'neutral';
    let sessionDates: string[] = [];
    if (priceResult.status === 'fulfilled') {
      try {
        const bars = priceResult.value;
        if (bars.at(-1)?.date !== expected) throw new Error('STALE_PRICE');
        metrics = analyzeBars(symbol, bars);
        sessionDates = sessionsBetween(bars[0].date, expected);
        await store.saveBars(symbol, bars);
        price = priceCondition(symbol, metrics);
        const update = advanceSignal(previous, price, expected, sessionDates);
        confirmed = update.state.confirmed;
        values.push({ key: `price:${symbol}`, value: update.state });
        if (update.alert) alerts.push(symbol);
      } catch { errors.push('PRICE_INVALID_OR_STALE'); }
    } else errors.push('PRICE_UNAVAILABLE');

    if (valuationResult.status === 'fulfilled') {
      const snapshot = valuationResult.value;
      if (snapshot.symbol === symbol && snapshot.date <= expected && Number.isFinite(snapshot.pe) && snapshot.pe > 0) {
        await store.saveValuation(snapshot);
      } else errors.push('VALUATION_INVALID');
    } else errors.push('VALUATION_UNAVAILABLE');
    const snapshots = await store.loadValuations(symbol);
    // Calendar coverage rather than number of returned bars is the freshness clock.
    const valuation = assessValuation(symbol, snapshots, expected, valuationSessions);
    let valuationConfirmed: Analysis['valuationConfirmed'] = 'unknown';
    if (metrics && !errors.some(e => e.startsWith('PRICE'))) {
      const direction = valuationDirection(valuation.status);
      if (direction !== null) {
        const previousValuation = await store.get<SignalState>(`valuation:${symbol}`);
        const update = advanceSignal(previousValuation, direction, expected, sessionDates);
        valuationConfirmed = update.state.confirmed === 'low' ? 'cheap' : update.state.confirmed === 'hot' ? 'expensive' : 'fair';
        values.push({ key: `valuation:${symbol}`, value: update.state });
        if (update.alert && !alerts.includes(symbol)) alerts.push(symbol);
      } else {
        // An unknown day breaks the consecutive-confirmation chain without inventing a neutral valuation.
        const previousValuation = await store.get<SignalState>(`valuation:${symbol}`);
        if (previousValuation) values.push({ key: `valuation:${symbol}`, value: { ...previousValuation, candidateCount: 0, lastDate: expected } });
      }
    }
    return { symbol, metrics, price, confirmed, valuation, valuationConfirmed, errors } satisfies Analysis;
  }));
  return { analyses, values, alerts, expected };
}

export async function validateCloud(store: Store, nowMs: number, deps: Dependencies = liveDependencies) {
  const result = await collect(store, nowMs, deps);
  const valid = result.analyses.every(a => a.metrics && !a.errors.some(e => e.startsWith('PRICE')));
  // Validation does not advance signals or send notifications.
  await store.put('validation', { at: nowMs, valid, analyses: result.analyses });
  if (valid) {
    const control = await controlFor(store);
    await store.put('control', { ...control, cloudValidatedAt: nowMs });
  }
  return { valid, latestSession: result.expected, analyses: result.analyses };
}

export async function runTick(store: Store, sendKey: string, nowMs: number, deps: Dependencies = liveDependencies) {
  const control = await controlFor(store);
  if (!control.enabled) return { paused: true };
  if (!sendKey) return { paused: true, error: 'PUSH_NOT_CONFIGURED' };
  if (control.deliveryFingerprint && control.deliveryFingerprint !== await fingerprint(sendKey)) {
    await store.put('control', { ...control, enabled: false });
    await store.put('lastFailure', { at: nowMs, code: 'PUSH_DESTINATION_REVALIDATION_REQUIRED' });
    return { paused: true, error: 'PUSH_DESTINATION_REVALIDATION_REQUIRED' };
  }
  const date = beijingDate(nowMs);
  const latest = latestCompletedSession(nowMs);
  const taskKey = `analysis:${latest.date}`;
  if (await store.acquireTask(taskKey, nowMs)) {
    try {
      const result = await collect(store, nowMs, deps);
      const pricesValid = result.analyses.every(a => a.metrics && !a.errors.some(e => e.startsWith('PRICE')));
      const notifications: NotificationInput[] = [];
      if (pricesValid && result.alerts.length) {
        const report = renderReport(result.analyses.filter(a => result.alerts.includes(a.symbol)), {
          kind: 'signal', beijingDate: date, latestSession: latest.date, holiday: false,
        });
        notifications.push({ id: `signal:${latest.date}`, kind: 'signal', ...report, createdAt: nowMs, expiresAt: nowMs + 24 * 3600_000 });
      }
      const committed = await store.commitForTask(taskKey, [
        ...(pricesValid ? result.values : []), { key: 'lastAnalysis', value: { at: nowMs, session: latest.date, analyses: result.analyses } },
      ], notifications);
      if (!committed) return { paused: false, error: 'ANALYSIS_LEASE_LOST' };
      if (pricesValid) {
        await store.finishTask(taskKey, nowMs);
      } else {
        await store.failTask(taskKey, nowMs);
        const task = await store.taskStatus(taskKey);
        if (task && task.attempts >= 3) await store.commit([], [{
          id: `health:${latest.date}`, kind: 'health', title: 'ETF监控：行情数据待核实',
          body: `最近应完成交易日：${latest.date}。部分行情在三次尝试后仍缺失或过期，已暂停相关新信号。每日简报会显示具体状态。`,
          createdAt: nowMs, expiresAt: nowMs + 24 * 3600_000,
        }]);
      }
    } catch {
      await store.failTask(taskKey, nowMs);
      await store.put('lastFailure', { at: nowMs, code: 'ANALYSIS_FAILED' });
    }
  }

  // Beijing is UTC+8 without DST. Catch up a missed morning report only on its own Beijing date.
  const beijingHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(nowMs));
  if (beijingHour >= 8 && await store.acquireTask(`daily:${date}`, nowMs)) {
    try {
      const saved = await store.get<{ at: number; session: string; analyses: Analysis[] }>('lastAnalysis');
      const analyses = saved?.analyses ?? [];
      const current = saved?.session === latest.date;
      const nyParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nowMs).map(p => [p.type, p.value]));
      const nyDate = `${nyParts.year}-${nyParts.month}-${nyParts.day}`;
      const holiday = !sessionForDate(nyDate);
      const report = renderReport(analyses, {
        kind: 'daily', beijingDate: date, latestSession: latest.date, holiday,
        issues: current ? [] : ['最新完整行情尚未取得，下列缓存数据不代表当日行情；新信号暂停。'],
      });
      const committed = await store.commitForTask(`daily:${date}`, [], [{ id: `daily:${date}`, kind: 'daily', ...report, createdAt: nowMs, expiresAt: Date.parse(`${date}T23:59:59+08:00`) }]);
      if (!committed) return { paused: false, error: 'DAILY_LEASE_LOST' };
      await store.finishTask(`daily:${date}`, nowMs);
    } catch {
      await store.failTask(`daily:${date}`, nowMs);
      await store.put('lastFailure', { at: nowMs, code: 'DAILY_FAILED' });
    }
  }
  const delivery = await dispatchNotifications(store, sendKey, nowMs, deps.fetcher);
  await store.put('lastTick', { at: nowMs });
  return { paused: false, ...delivery };
}
