/**
 * data/*.json → data/xiaoyu.sqlite（kv 表）迁移脚本
 * 运行前请先备份 data/（本脚本只读 json、写 sqlite，不会删除 json）。
 * 用法：npx tsx scripts/migrate-json-to-sqlite.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.join(process.cwd(), 'data');
const db = new Database(path.join(dataDir, 'xiaoyu.sqlite'));
db.pragma('journal_mode = WAL');
db.exec('create table if not exists kv (key text primary key, value text not null)');

const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
const insert = db.prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value');
let n = 0;
db.transaction(() => {
  for (const f of files) {
    const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
    insert.run(f, content);
    n++;
  }
})();

console.log(`✅ migrated ${n} json file(s) -> ${path.join(dataDir, 'xiaoyu.sqlite')}`);
db.close();
