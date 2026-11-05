import assert from 'node:assert/strict';
import test from 'node:test';
import { beijingDate, latestCompletedSession, sessionForDate, sessionsBetween } from '../src/calendar.js';

test('NYSE holidays include observed dates, Good Friday, Juneteenth and Carter closure', () => {
  for (const date of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26',
    '2026-12-25', '2022-06-20', '2023-01-02', '2025-01-09', '2021-12-24']) {
    assert.equal(sessionForDate(date), null, date);
  }
  assert.ok(sessionForDate('2021-12-31'), 'Saturday New Year does not close preceding Friday');
  assert.ok(sessionForDate('2020-06-19'), 'Juneteenth became exchange holiday in 2022');
  assert.ok(sessionForDate('2026-07-02'), 'No automatic early close before observed July 4 holiday');
});

test('regular and early close timestamps follow DST and exchange-specific early close rules', () => {
  const cases = {
    '2026-03-06': '2026-03-06T21:00:00Z',
    '2026-03-09': '2026-03-09T20:00:00Z',
    '2026-10-30': '2026-10-30T20:00:00Z',
    '2026-11-02': '2026-11-02T21:00:00Z',
    '2025-07-03': '2025-07-03T17:00:00Z',
    '2026-07-02': '2026-07-02T20:00:00Z',
    '2026-11-27': '2026-11-27T18:00:00Z',
    '2026-12-24': '2026-12-24T18:00:00Z',
  };
  for (const [date, close] of Object.entries(cases)) assert.equal(sessionForDate(date)?.closeAt, Date.parse(close), date);
});

test('completed session waits publication delay, including early close, weekend and holiday', () => {
  assert.equal(latestCompletedSession(Date.parse('2026-11-05T21:29:59Z')).date, '2026-11-04');
  assert.equal(latestCompletedSession(Date.parse('2026-11-05T21:30:00Z')).date, '2026-11-05');
  assert.equal(latestCompletedSession(Date.parse('2026-11-05T21:00:00Z'), 0).date, '2026-11-05');
  assert.equal(latestCompletedSession(Date.parse('2026-11-28T06:00:00Z')).date, '2026-11-27');
  assert.equal(latestCompletedSession(Date.parse('2026-11-27T18:29:59Z')).date, '2026-11-25');
  assert.equal(latestCompletedSession(Date.parse('2026-11-27T18:30:00Z')).date, '2026-11-27');
  assert.equal(latestCompletedSession(Date.parse('2025-01-09T23:00:00Z')).date, '2025-01-08');
});

test('inclusive session range, valid dates and supported calendar bounds fail closed', () => {
  assert.deepEqual(sessionsBetween('2025-01-08', '2025-01-13'), ['2025-01-08', '2025-01-10', '2025-01-13']);
  assert.deepEqual(sessionsBetween('2026-07-03', '2026-07-05'), []);
  for (const date of ['2026-02-30', '2026-1-02', '2019-12-31', '2041-01-02']) assert.throws(() => sessionForDate(date));
  assert.throws(() => sessionsBetween('2026-02-02', '2026-01-02'), /reversed/);
  assert.ok(sessionForDate('2031-01-02'), 'Five-year estimate history can mature after 2030');
  assert.throws(() => latestCompletedSession(Date.parse('2041-01-02T23:00:00Z')), /supports/);
  assert.throws(() => latestCompletedSession(NaN));
  assert.throws(() => latestCompletedSession(Date.now(), -1));
});

test('Beijing date is independent of host timezone and New York trading date', () => {
  assert.equal(beijingDate(Date.parse('2026-11-05T15:59:59Z')), '2026-11-05');
  assert.equal(beijingDate(Date.parse('2026-11-05T16:00:00Z')), '2026-11-06');
});
