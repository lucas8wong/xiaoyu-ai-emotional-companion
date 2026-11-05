export const SYMBOLS = ['QQQM', 'SPYM'] as const;
export type Symbol = typeof SYMBOLS[number];
export type Direction = 'low' | 'neutral' | 'hot';
export interface Bar { date: string; close: number; adjustedClose: number }
export interface Metrics {
  date: string; close: number; changePct: number; drawdownPct: number;
  ma200: number; gapPct: number;
}
export interface Thresholds { drawdownPct: number; belowMaPct: number; aboveMaPct: number }
export interface SignalState {
  confirmed: Direction; candidate: Direction; candidateCount: number;
  lastDate: string | null; lastAlerts: Partial<Record<Direction, string>>;
}
export interface ValuationSnapshot {
  symbol: Symbol; date: string; pe: number; source: string; method: string; proxy: string;
}
export interface ValuationResult {
  status: 'unknown' | 'cheap' | 'fair' | 'expensive';
  pe: number | null; date: string | null; percentile: number | null;
  reason: string; source: string;
}
export interface Analysis {
  symbol: Symbol; metrics: Metrics | null; price: Direction | null;
  confirmed: Direction; valuation: ValuationResult; errors: string[];
  valuationConfirmed?: ValuationResult['status'];
}
export interface Session { date: string; closeAt: number }
export type Fetcher = typeof fetch;
