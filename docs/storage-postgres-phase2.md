# Phase 2: Making Storage Scalable (local JSON → persistent DB) Design Document

> This document is bilingual with **English first**. The Chinese original is the source of record and is preserved verbatim below: [中文原文](#zh).

> Goal: prepare for "gradually moving to the cloud after user volume grows, multi-instance/autoscaling". **This phase only does design and does not change production**, to be executed when you are at the computer.
> Key fact: the current `api/storage/persistence.ts` `readJson/writeJson` is **synchronous** (based on local files), and the `accountStore/quotaStore/memoryStorage/...` stores are synchronous stores that are **loaded into memory once at startup and then written to disk on demand**.

---

## 1. Current state and constraints

- All business data goes through `data/*.json` + **synchronous** `persistence.read/write`.
- A store calls `loadFromDisk()` at startup to read into an in-memory `Map`, then `saveToDisk()` writes back synchronously.
- Therefore **a directly replaceable storage backend must also be a synchronous API**.

### ⚠️ So Postgres cannot be swapped in directly
The Postgres client (`pg`) is **asynchronous**; if `persistence.read/write` were replaced with async Postgres, `readJson/writeJson` and all synchronous stores would all break. **Either change the whole storage layer to async (a big refactor), or use synchronous SQLite first.**

---

## 2. Two paths

### Path A (recommended first): SQLite — synchronous, single-file, does not break the interface
Use `better-sqlite3` (**synchronous**) to implement a `PersistenceProvider`: all logical files (`xxx.json`) map to the same `kv(key, value)` table, `read=SELECT`, `write=UPSERT`.

> ✅ **Implemented and enabled (2026-08-29)**: `api/storage/sqliteProvider.ts` + `PERSISTENCE_PROVIDER=sqlite` (default is still `file`); `scripts/migrate-json-to-sqlite.mts` has migrated `data/*.json` to `data/xiaoyu.sqlite` and the switch has been made. Rollback = change back to `PERSISTENCE_PROVIDER=file` and restart (note: increments after the switch will be lost).
- Pros: **synchronous**, can replace `persistence` directly; data centralised in **one SQLite file** (easy to back up, atomic writes, can live on a persistent disk/EFS); the most stable for a single instance.
- Positioning: Phase 1.5 — the **unified persistence file** when going to the cloud on a single instance/machine, more robust and easier to migrate than scattered `*.json`.
- Cost: a single SQLite file is **not suitable for multi-instance sharing** (concurrent writes on a network file system are unstable) — multiple instances still need Postgres.

### Path B (final goal): Postgres — needs async-ification, suitable for multiple instances
- First change `persistence.readJson/writeJson` and **all synchronous stores** to async (`store.loadFromDisk()`/`saveToDisk()` become `await`, and call sites like `getFacts/user.ts` change to await accordingly).
- The scale is not small (touches `accounts/quota/memoryStorage/roleplaySessions/chatCharacter/chatCharacterGrowth/...` and multiple routes).
- Benefit: true shared persistence + multiple instances + can connect to managed services (ECS/EKS/Neon/RDS).

---

## 3. Recommended route

```
阶段1（已完成）: 本地/单机 24/7（Docker + data 持久盘 + Cloudflare 边缘）
阶段1.5（可选，先做）: persistence 换成 SQLite(better-sqlite3) Provider：单一文件、更稳、好备份
阶段2（最终）: persistence + 所有 store 同步化改造为 Postgres（多实例/自动扩容）
```

**Why SQLite first:** it can be done now, verified locally, and does not break the synchronous interface; you immediately get the benefit of a "unified persistence file"; when Postgres is really needed, do the async-ification as a whole then.

---

## 4. Postgres migration design (Path B)

### 4.1 Table schema (minimal: store JSON blobs keyed by logical file)
```sql
create table if not exists xiaoyu_kv (
  key        text primary key,   -- 如 'long-memory.json'
  value      text not null,      -- JSON 内容
  updated_at timestamptz not null default now()
);
```
- `key = path.basename(file)` (all data files in this project are flat under `data/`, so the basename is unique).
- Later, tables can be split by domain (accounts/sessions/quota/...), but **make the minimal change first** with a kv table + the existing JSON structure.

### 4.2 Provider implementation points (pseudocode)
```ts
import pg from 'pg'; const { Pool } = pg;
let pool: pg.Pool;
function db(){ return pool ??= new Pool({ connectionString: process.env.DATABASE_URL }); }

const postgresProvider: PersistenceProvider = {
  async read(file){ const r = await db().query('select value from xiaoyu_kv where key=$1',[key(file)]); return r.rows[0]?.value ?? null; },
  async write(file, content){ await db().query('insert into xiaoyu_kv(key,value,updated_at) values($1,$2,now()) on conflict(key) do update set value=excluded.value, updated_at=now()',[key(file), content]); },
  ensureDir(){},
};
```

### 4.3 Key point: async-ify the storage layer
Because the provider becomes async, **you must** change:
- `api/storage/persistence.ts`'s `readJson/writeJson` to `async` (returning Promise),
- all callers to `await` (`store.loadFromDisk()` etc.),
- `user.ts`'s `getFacts/removeFact`, and the read sites in `analysis.ts`, all to await.
> This is the biggest workload of this task, and the reason Phase 2 must be "left until you are at the computer and can verify it as a whole".

### 4.4 Migration tool
Write a `scripts/migrate-json-to-postgres.mts`:
1. Read `data/*.json` (all logical files).
2. `upsert` each record into `xiaoyu_kv`.
3. Validate row counts/sampling.
Then switch `PERSISTENCE_PROVIDER=postgres`; after a restart the stores load from Postgres.

---

## 5. Important: the multi-instance problem of in-memory stores (Phase 3)
Even if the storage layer is switched to Postgres, `accountStore/quotaStore/memoryStorage/chatCharacterGrowthStore/...` are still **loaded into memory once at startup**. This means:
- Single instance is fine (data lands in the DB, loaded on restart).
- **Multiple instances will be inconsistent**: each instance has its own in-memory copy; after A writes to the DB, B's memory does not update automatically (unless every operation goes through the DB).

Phase 3 (true multi-instance/autoscaling) still needs to change these stores to **read/write the DB on every operation** (or DB + cache/message sync), not just load at startup. This is a deeper refactor than "swapping the Provider".

---

## 6. Suggested execution order (when you are at the computer)
1. **Do Path A (SQLite) first**: `better-sqlite3` Provider + `PERSISTENCE_PROVIDER=sqlite`, migrate `data/*.json` → one `.sqlite`, verify locally + run on a single cloud machine. Small change, rollback-able.
2. When multiple instances are really needed, then **Path B (Postgres + full-chain async)**, and do **Phase 3** (stores go through the DB per operation) at the same time.
3. For every step, first `npm run check` + `npm test` + a backup of `data/` (or `.sqlite`) before shipping.

---

## Appendix: currently ready (Phase 1)
- Dockerfile/compose/deployment guide are ready (`docs/cloud-deploy-phase1.md`), Cloudflare edge + AWS single instance + `data` persistent disk.
- This phase (making storage scalable) only prepares for the future and **does not change production/running services**; `PERSISTENCE_PROVIDER` still defaults to `file`.

---

<a id="zh"></a>

# 阶段2：存储可扩展化（本地 JSON → 持久化 DB）设计文档

> 目标：为「用户量大后逐步上云、多实例/自动扩容」做准备。**本阶段先只做设计，不改线上**，等你在电脑边上再执行。
> 关键事实：当前 `api/storage/persistence.ts` 的 `readJson/writeJson` 是**同步**的（基于本地文件），且 `accountStore/quotaStore/memoryStorage/...` 这些 store 是**启动时一次性加载到内存、之后按需写盘**的同步 store。

---

## 1. 现状与约束

- 所有业务数据走 `data/*.json` + **同步** `persistence.read/write`。
- store 在启动时 `loadFromDisk()` 读到内存 `Map`，之后 `saveToDisk()` 同步写回。
- 因此**能直接替换的存储后端，必须也是同步 API**。

### ⚠️ 所以 Postgres 不能直接换
Postgres 客户端（`pg`）是**异步**的；如果把 `persistence.read/write` 换成异步 Postgres，会让 `readJson/writeJson` 和所有同步 store 全部报错。**要么把整条存储层改成 async（大重构），要么先用同步的 SQLite。**

---

## 2. 两条路

### 路径 A（推荐先行）：SQLite：同步、单文件、不破坏接口
用 `better-sqlite3`（**同步**）实现一个 `PersistenceProvider`：所有逻辑文件（`xxx.json`）映射到同一张 `kv(key, value)` 表，`read=SELECT`，`write=UPSERT`。

> ✅ **已实现并启用（2026-08-29）**：`api/storage/sqliteProvider.ts` + `PERSISTENCE_PROVIDER=sqlite`（默认仍 `file`）；`scripts/migrate-json-to-sqlite.mts` 已把 `data/*.json` 迁到 `data/xiaoyu.sqlite` 并已切换。回退=改回 `PERSISTENCE_PROVIDER=file` 重启（注意会丢切换后的增量）。
- 优点：**同步**，直接替换 `persistence` 即可；数据集中到**一个 SQLite 文件**（好备份、原子写、可放持久盘/EFS）；单个实例用它最稳。
- 定位：阶段 1.5：单实例/单机上云时的**统一持久化文件**，比散落的 `*.json` 更健壮、更好迁移。
- 代价：SQLite 单文件**不适合多实例共享**（网络文件系统上并发写不稳定），多实例仍需 Postgres。

### 路径 B（最终目标）：Postgres，需要 async 化，适合多实例
- 需要先把 `persistence.readJson/writeJson` 以及**所有同步 store** 改成 async（`store.loadFromDisk()`/`saveToDisk()` 变 `await`，`getFacts/user.ts` 等调用点同步改 await）。
- 规模不小（波及 `accounts/quota/memoryStorage/roleplaySessions/chatCharacter/chatCharacterGrowth/...` 与多个路由）。
- 好处：真正的共享持久化 + 多实例 + 可接托管(ECS/EKS/Neon/RDS)。

---

## 3. 推荐路线

```
阶段1（已完成）: 本地/单机 24/7（Docker + data 持久盘 + Cloudflare 边缘）
阶段1.5（可选，先做）: persistence 换成 SQLite(better-sqlite3) Provider：单一文件、更稳、好备份
阶段2（最终）: persistence + 所有 store 同步化改造为 Postgres（多实例/自动扩容）
```

**为什么先 SQLite：** 现在就能做、能本地验证、不破坏同步接口；一步到位拿到「统一持久化文件」的收益；之后要 Postgres 时再整体 async 化。

---

## 4. Postgres 迁移设计（路径 B）

### 4.1 表结构（最小化：按逻辑文件存 JSON blob）
```sql
create table if not exists xiaoyu_kv (
  key        text primary key,   -- 如 'long-memory.json'
  value      text not null,      -- JSON 内容
  updated_at timestamptz not null default now()
);
```
- `key = path.basename(file)`（本项目所有数据文件都在 `data/` 平铺，basename 唯一）。
- 后续可按域拆表（accounts/sessions/quota/...），但**先最小改动**用 kv 表 + 现有 JSON 结构即可。

### 4.2 Provider 实现要点（伪代码）
```ts
import pg from 'pg'; const { Pool } = pg;
let pool: pg.Pool;
function db(){ return pool ??= new Pool({ connectionString: process.env.DATABASE_URL }); }

const postgresProvider: PersistenceProvider = {
  async read(file){ const r = await db().query('select value from xiaoyu_kv where key=$1',[key(file)]); return r.rows[0]?.value ?? null; },
  async write(file, content){ await db().query('insert into xiaoyu_kv(key,value,updated_at) values($1,$2,now()) on conflict(key) do update set value=excluded.value, updated_at=now()',[key(file), content]); },
  ensureDir(){},
};
```

### 4.3 关键：把存储层异步化
因为 provider 变成 async，**必须**把：
- `api/storage/persistence.ts` 的 `readJson/writeJson` 改为 `async`（返回 Promise），
- 所有调用方改成 `await`（`store.loadFromDisk()` 等），
- `user.ts` 的 `getFacts/removeFact`、`analysis.ts` 里读取处，全部 await。
> 这是本次最大工作量，也是为什么阶段2 要「留到你在电脑边上、可整体验证」再做。

### 4.4 迁移工具
写一个 `scripts/migrate-json-to-postgres.mts`：
1. 读 `data/*.json`（所有逻辑文件）。
2. 逐条 `upsert` 到 `xiaoyu_kv`。
3. 校验行数/抽样。
然后切 `PERSISTENCE_PROVIDER=postgres`，重启后 store 从 Postgres 加载。

---

## 5. 重要：内存 store 的多实例问题（阶段3）
即使存储层换成 Postgres，`accountStore/quotaStore/memoryStorage/chatCharacterGrowthStore/...` 仍是**启动时一次性加载到内存**。这意味着：
- 单实例下没问题（数据落 DB，重启加载）。
- **多实例下会不一致**：两个实例各自有一份内存副本，A 写到 DB 后 B 的内存不会自动更新（除非每操作都穿透 DB）。

阶段3（真正多实例/自动扩容）还需把这些 store 改成**每操作读写 DB**（或 DB+缓存/消息同步），而不只是启动时加载。这是比「换 Provider」更深的改造。

---

## 6. 建议的执行顺序（你在电脑旁时）
1. **先做路径 A（SQLite）**：`better-sqlite3` Provider + `PERSISTENCE_PROVIDER=sqlite`，迁移 `data/*.json` → 一个 `.sqlite`，本地验证 + 单机云上跑。改动小、可回退。
2. 等确实要多实例了，再 **路径 B（Postgres + 全链路 async）**，并同步做 **阶段3**（store 按操作穿透 DB）。
3. 每步都先 `npm run check` + `npm test` + 一次备份 `data/`（或 `.sqlite`）再上。

---

## 附：当前已就绪（阶段1）
- Dockerfile/compose/部署指南已备好（`docs/cloud-deploy-phase1.md`），Cloudflare 边缘 + AWS 单实例 + `data` 持久盘。
- 本阶段（存储可扩展化）只为将来做准备，**未改动线上/运行中的服务**；`PERSISTENCE_PROVIDER` 默认仍是 `file`。
