import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/store.js';

class Statement implements D1PreparedStatement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement { return new Statement(this.db, this.sql, values); }
  execute<T>(): D1Result<T> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.values as Array<string | number | null>).map(row => ({ ...row })) as T[];
    return { success: true, results };
  }
  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0];
    return row ? (columnName ? row[columnName] : row) as T : null;
  }
  async all<T>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T>(): Promise<D1Result<T>> { return this.execute<T>(); }
}

export class FakeD1 implements D1Database {
  readonly sqlite: DatabaseSync;
  constructor(filename = ':memory:') {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  }
  prepare(sql: string): D1PreparedStatement { return new Statement(this.sqlite, sql); }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => (statement as Statement).execute<T>());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}
