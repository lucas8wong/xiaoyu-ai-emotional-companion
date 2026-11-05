import type { Bar, Symbol, ValuationSnapshot } from './types.js';

// The small structural surface also works with real Cloudflare D1 bindings.
export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: { changes?: number; [key: string]: unknown };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface NotificationInput {
  id: string;
  kind: 'daily' | 'signal' | 'health' | 'test';
  title: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}
export interface ReservedNotification extends NotificationInput {
  attemptId: string;
  attempts: number;
}
export interface TaskStatus { attempts: number; completed: boolean; leaseUntil: number }
export type SendOutcome = 'accepted' | 'rejected' | 'permanent' | 'ambiguous';

export function beijingDate(nowMs: number): string {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class Store {
  private readonly taskOwners = new Map<string, string>();
  constructor(readonly db: D1Database) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db.prepare('SELECT value FROM monitor_values WHERE key = ?').bind(key).first<{ value: string }>();
    return row ? JSON.parse(row.value) as T : null;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.commit([{ key, value }], []);
  }

  async saveBars(symbol: Symbol, bars: Bar[]): Promise<void> {
    if (bars.some(b => !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Number.isFinite(b.close) || b.close <= 0 || !Number.isFinite(b.adjustedClose) || b.adjustedClose <= 0)) {
      throw new Error('Invalid price bars');
    }
    if (!bars.length) return;
    // One JSON bind avoids the per-statement parameter limit on long histories.
    await this.db.prepare(`INSERT INTO price_bars (symbol, date, close, adjusted_close)
      SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.close'), json_extract(value, '$.adjustedClose')
      FROM json_each(?) WHERE true
      ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, adjusted_close = excluded.adjusted_close`)
      .bind(symbol, JSON.stringify(bars)).run();
  }

  async loadBars(symbol: Symbol): Promise<Bar[]> {
    const result = await this.db.prepare('SELECT date, close, adjusted_close AS adjustedClose FROM price_bars WHERE symbol = ? ORDER BY date').bind(symbol).all<Bar>();
    return result.results;
  }

  async saveValuation(snapshot: ValuationSnapshot): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || !Number.isFinite(snapshot.pe) || snapshot.pe <= 0) throw new Error('Invalid valuation snapshot');
    await this.db.prepare(`INSERT INTO valuation_snapshots (symbol, date, pe, source, method, proxy)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, date, source, method, proxy) DO UPDATE SET pe = excluded.pe`)
      .bind(snapshot.symbol, snapshot.date, snapshot.pe, snapshot.source, snapshot.method, snapshot.proxy).run();
  }

  async loadValuations(symbol: Symbol): Promise<ValuationSnapshot[]> {
    return (await this.db.prepare('SELECT symbol, date, pe, source, method, proxy FROM valuation_snapshots WHERE symbol = ? ORDER BY date, source, method, proxy').bind(symbol).all<ValuationSnapshot>()).results;
  }

  async commit(values: Array<{ key: string; value: unknown }>, notifications: NotificationInput[]): Promise<void> {
    const statements = this.commitStatements(values, notifications);
    if (statements.length) await this.db.batch(statements);
  }

  /** Ownership checks and writes share one transaction; stale owners write nothing. */
  async commitForTask(taskKey: string, values: Array<{ key: string; value: unknown }>, notifications: NotificationInput[]): Promise<boolean> {
    const owner = this.taskOwners.get(taskKey);
    if (!owner) return false;
    const statements = this.commitStatements(values, notifications, { key: taskKey, owner });
    statements.push(this.db.prepare('SELECT 1 AS owned FROM task_runs WHERE key = ? AND owner = ? AND completed = 0').bind(taskKey, owner));
    const result = await this.db.batch(statements);
    return result.at(-1)?.results[0]?.owned === 1;
  }

  private commitStatements(values: Array<{ key: string; value: unknown }>, notifications: NotificationInput[], task?: { key: string; owner: string }): D1PreparedStatement[] {
    const guard = 'WHERE EXISTS (SELECT 1 FROM task_runs WHERE key = ? AND owner = ? AND completed = 0)';
    const ownership = task ? [task.key, task.owner] : [];
    const statements = values.map(({ key, value }) => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error('Undefined state cannot be persisted');
      return this.db.prepare(`INSERT INTO monitor_values (key, value) ${task ? `SELECT ?, ? ${guard}` : 'VALUES (?, ?)'}
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, serialized, ...ownership);
    });
    for (const item of notifications) {
      if (!item.id || !item.title.trim() || /[\r\n]/.test(item.title) || item.expiresAt <= item.createdAt) throw new Error('Invalid notification');
      statements.push(this.db.prepare(`INSERT INTO notifications (id, kind, title, body, created_at, expires_at, next_attempt_at)
        ${task ? `SELECT ?, ?, ?, ?, ?, ?, ? ${guard}` : 'VALUES (?, ?, ?, ?, ?, ?, ?)'} ON CONFLICT(id) DO NOTHING`)
        .bind(item.id, item.kind, item.title, item.body, item.createdAt, item.expiresAt, item.createdAt, ...ownership));
    }
    return statements;
  }

  async acquireTask(key: string, nowMs: number, ttlMs = 180_000): Promise<boolean> {
    const owner = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO task_runs (key, attempts, completed, lease_until, owner, updated_at)
      VALUES (?, 1, 0, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      attempts = task_runs.attempts + 1, lease_until = excluded.lease_until,
      owner = excluded.owner, updated_at = excluded.updated_at
      WHERE task_runs.completed = 0 AND task_runs.attempts < 3 AND task_runs.lease_until <= ? RETURNING owner`)
      .bind(key, nowMs + ttlMs, owner, nowMs, nowMs).first<{ owner: string }>();
    if (!row) return false;
    this.taskOwners.set(key, owner);
    return true;
  }

  async finishTask(key: string, nowMs: number): Promise<void> {
    const owner = this.taskOwners.get(key);
    if (!owner) return;
    await this.db.prepare('UPDATE task_runs SET completed = 1, lease_until = 0, updated_at = ? WHERE key = ? AND owner = ?').bind(nowMs, key, owner).run();
    this.taskOwners.delete(key);
  }

  async failTask(key: string, nowMs: number): Promise<void> {
    const owner = this.taskOwners.get(key);
    if (!owner) return;
    await this.db.prepare('UPDATE task_runs SET lease_until = ?, updated_at = ? WHERE key = ? AND owner = ? AND completed = 0').bind(nowMs + 900_000, nowMs, key, owner).run();
    this.taskOwners.delete(key);
  }

  async taskStatus(key: string): Promise<TaskStatus | null> {
    const row = await this.db.prepare('SELECT attempts, completed, lease_until AS leaseUntil FROM task_runs WHERE key = ?').bind(key).first<{ attempts: number; completed: number; leaseUntil: number }>();
    return row ? { ...row, completed: row.completed === 1 } : null;
  }

  async reserveNotification(nowMs: number): Promise<ReservedNotification | null> {
    const attemptId = crypto.randomUUID();
    const date = beijingDate(nowMs);
    // D1 batch is transactional. The count and reservation INSERT execute in the
    // same transaction across workers, before any external HTTP attempt.
    await this.db.batch([
      this.db.prepare(`UPDATE send_attempts SET outcome = 'ambiguous', finished_at = ?
        WHERE outcome = 'reserved' AND id IN (SELECT current_attempt FROM notifications WHERE status = 'sending' AND lease_until <= ?)`)
        .bind(nowMs, nowMs),
      this.db.prepare("UPDATE notifications SET status = 'ambiguous', lease_until = 0 WHERE status = 'sending' AND lease_until <= ?").bind(nowMs),
      this.db.prepare("UPDATE notifications SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(nowMs),
      this.db.prepare(`INSERT INTO send_attempts (id, notification_id, beijing_date, kind, created_at, outcome)
        SELECT ?, n.id, ?, n.kind, ?, 'reserved' FROM notifications n
        WHERE n.status = 'pending' AND n.next_attempt_at <= ? AND n.created_at <= ? AND n.expires_at > ? AND n.attempts < 3
        AND (SELECT COUNT(*) FROM send_attempts WHERE beijing_date = ?) <
          CASE WHEN n.kind = 'daily' OR EXISTS (SELECT 1 FROM send_attempts WHERE beijing_date = ? AND kind = 'daily') THEN 5 ELSE 4 END
        ORDER BY CASE n.kind WHEN 'daily' THEN 0 WHEN 'signal' THEN 1 WHEN 'health' THEN 2 ELSE 3 END, n.created_at, n.id LIMIT 1`)
        .bind(attemptId, date, nowMs, nowMs, nowMs, nowMs, date, date),
      this.db.prepare(`UPDATE notifications SET status = 'sending', attempts = attempts + 1, current_attempt = ?, lease_until = ?
        WHERE id = (SELECT notification_id FROM send_attempts WHERE id = ?)`)
        .bind(attemptId, nowMs + 120_000, attemptId),
    ]);
    return this.db.prepare(`SELECT n.id, n.kind, n.title, n.body, n.created_at AS createdAt, n.expires_at AS expiresAt,
      n.current_attempt AS attemptId, n.attempts FROM notifications n JOIN send_attempts a ON a.notification_id = n.id
      WHERE a.id = ? AND n.current_attempt = ? AND n.status = 'sending'`).bind(attemptId, attemptId).first<ReservedNotification>();
  }

  async finishNotification(attemptId: string, outcome: SendOutcome, nowMs: number, providerCode: number | null = null): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE send_attempts SET outcome = ?, finished_at = ?, provider_code = ? WHERE id = ? AND outcome = 'reserved'`)
        .bind(outcome, nowMs, providerCode, attemptId),
      this.db.prepare(`UPDATE notifications SET status = CASE
          WHEN ? = 'accepted' THEN 'accepted' WHEN ? = 'ambiguous' THEN 'ambiguous'
          WHEN ? = 'permanent' OR attempts >= 3 THEN 'failed' ELSE 'pending' END,
          next_attempt_at = ?, lease_until = 0, provider_code = ?
        WHERE current_attempt = ? AND status = 'sending'`)
        .bind(outcome, outcome, outcome, nowMs + 900_000, providerCode, attemptId),
    ]);
  }

  async pendingCount(nowMs: number): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE status IN ('pending', 'sending') AND expires_at > ?").bind(nowMs).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async health(nowMs: number): Promise<{ date: string; attemptsToday: number; pending: number; accepted: number; failed: number; ambiguous: number }> {
    const date = beijingDate(nowMs);
    const results = await this.db.batch([
      this.db.prepare('SELECT COUNT(*) AS count FROM send_attempts WHERE beijing_date = ?').bind(date),
      this.db.prepare(`SELECT status, COUNT(*) AS count FROM notifications GROUP BY status`),
    ]);
    const counts = new Map((results[1].results as Array<{ status: string; count: number }>).map(row => [row.status, row.count]));
    return { date, attemptsToday: Number(results[0].results[0]?.count ?? 0), pending: (counts.get('pending') ?? 0) + (counts.get('sending') ?? 0), accepted: counts.get('accepted') ?? 0, failed: counts.get('failed') ?? 0, ambiguous: counts.get('ambiguous') ?? 0 };
  }
}
