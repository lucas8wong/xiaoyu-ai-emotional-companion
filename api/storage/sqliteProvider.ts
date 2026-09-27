/**
 * SQLite 持久化 Provider（可选，默认不启用）
 * 用 better-sqlite3（**同步**，兼容现有同步 persistence 接口），把所有逻辑文件（*.json）
 * 映射到同一张 `kv(key, value)` 表，数据统一存放在一个 `data/xiaoyu.sqlite` 文件里。
 * 好处：单个文件、原子写、好备份/迁移；适合单实例持久化。
 * 启用：环境变量 `PERSISTENCE_PROVIDER=sqlite`（默认 `file`，行为不变，可随时切回）。
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import type { PersistenceProvider } from './persistence.js';

let db: Database.Database | null = null;
function getDb(): Database.Database {
  if (!db) {
    db = new Database(sqliteDbPath());
    db.pragma('journal_mode = WAL');
    db.exec('create table if not exists kv (key text primary key, value text not null)');
  }
  return db;
}

/** SQLite 文件路径（与 dataDir 一致，放持久卷里） */
export function sqliteDbPath(): string {
  return path.join(process.cwd(), 'data', 'xiaoyu.sqlite');
}

/** 逻辑文件 → kv key（本项目所有数据文件都在 data/ 平铺，用 basename 唯一） */
function keyOf(file: string): string {
  return path.basename(file);
}

const sqliteProvider: PersistenceProvider = {
  read(file) {
    try {
      const row = getDb().prepare('select value from kv where key = ?').get(keyOf(file)) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  },
  write(file, content) {
    try {
      getDb()
        .prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value')
        .run(keyOf(file), content);
    } catch {
      /* 忽略 */
    }
  },
  ensureDir() {
    /* SQLite 文件自建，无需目录 */
  },
};

export function createSqlitePersistenceProvider(): PersistenceProvider {
  return sqliteProvider;
}
