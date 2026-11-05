import type { Session } from './types.js';

const MIN_YEAR = 2020;
const MAX_YEAR = 2040;
const DAY = 86_400_000;
const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});
const bjParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function parts(format: Intl.DateTimeFormat, ms: number): Record<string, string> {
  if (!Number.isFinite(ms)) throw new Error('Invalid calendar timestamp');
  return Object.fromEntries(format.formatToParts(ms).map(p => [p.type, p.value]));
}
function dateIn(format: Intl.DateTimeFormat, ms: number): string {
  const p = parts(format, ms);
  return `${p.year}-${p.month}-${p.day}`;
}
function checkedDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid session date');
  const d = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid session date');
  }
  if (d.getUTCFullYear() < MIN_YEAR || d.getUTCFullYear() > MAX_YEAR) {
    throw new Error(`NYSE calendar supports ${MIN_YEAR}-${MAX_YEAR} only`);
  }
  return d;
}
function iso(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function monthDay(year: number, month: number, day: number): string {
  return iso(Date.UTC(year, month - 1, day));
}
function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return monthDay(year, month, 1 + (weekday - first + 7) % 7 + (nth - 1) * 7);
}
function lastMondayMay(year: number): string {
  const last = new Date(Date.UTC(year, 4, 31));
  return monthDay(year, 5, 31 - (last.getUTCDay() - 1 + 7) % 7);
}
function observed(year: number, month: number, day: number): string {
  const ms = Date.UTC(year, month - 1, day);
  const weekday = new Date(ms).getUTCDay();
  return iso(ms + (weekday === 6 ? -DAY : weekday === 0 ? DAY : 0));
}
// Gregorian Easter, used for the exchange's Good Friday closure.
function goodFriday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return iso(Date.UTC(year, month - 1, day) - 2 * DAY);
}
const holidayCache = new Map<number, Set<string>>();
const sessionCache = new Map<string, Session | null>();
function holidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const jan1 = new Date(Date.UTC(year, 0, 1));
  // NYSE does not close the preceding Friday when New Year's Day is Saturday.
  const newYear = jan1.getUTCDay() === 0 ? monthDay(year, 1, 2) : monthDay(year, 1, 1);
  const result = new Set([
    newYear, nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3),
    goodFriday(year), lastMondayMay(year), observed(year, 7, 4),
    nthWeekday(year, 9, 1, 1), nthWeekday(year, 11, 4, 4), observed(year, 12, 25),
  ]);
  if (year >= 2022) result.add(observed(year, 6, 19));
  if (year === 2025) result.add('2025-01-09'); // President Carter's national day of mourning.
  holidayCache.set(year, result);
  return result;
}

/** NYSE regular session close; announced exceptional closures are explicitly recorded. */
export function sessionForDate(date: string): Session | null {
  if (sessionCache.has(date)) return sessionCache.get(date)!;
  const d = checkedDate(date);
  const year = d.getUTCFullYear();
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays(year).has(date)) {
    sessionCache.set(date, null);
    return null;
  }
  const thanksgiving = checkedDate(nthWeekday(year, 11, 4, 4)).getTime();
  const early = date.endsWith('-07-03') || date.endsWith('-12-24') || date === iso(thanksgiving + DAY);
  const localCloseHour = early ? 13 : 16;
  // At UTC noon New York is always on the same date; Intl supplies the actual DST offset.
  const noon = d.getTime() + 12 * 3_600_000;
  const offsetHours = 12 - Number(parts(nyParts, noon).hour);
  const session = { date, closeAt: d.getTime() + (localCloseHour + offsetHours) * 3_600_000 };
  sessionCache.set(date, session);
  return session;
}

export function latestCompletedSession(nowMs: number, delayMinutes = 30): Session {
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0 || delayMinutes > 1440) {
    throw new Error('Invalid session publication delay');
  }
  const today = checkedDate(dateIn(nyParts, nowMs));
  for (let back = 0; back < 15; back++) {
    const session = sessionForDate(iso(today.getTime() - back * DAY));
    if (session && session.closeAt + delayMinutes * 60_000 <= nowMs) return session;
  }
  throw new Error('No completed NYSE session in supported calendar');
}

/** Inclusive trading dates, in chronological order. */
export function sessionsBetween(startDate: string, endDate: string): string[] {
  const start = checkedDate(startDate).getTime(), end = checkedDate(endDate).getTime();
  if (start > end) throw new Error('Session range is reversed');
  const result: string[] = [];
  for (let ms = start; ms <= end; ms += DAY) {
    const date = iso(ms);
    const day = new Date(ms);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays(day.getUTCFullYear()).has(date)) result.push(date);
  }
  return result;
}

export function beijingDate(nowMs: number): string { return dateIn(bjParts, nowMs); }
