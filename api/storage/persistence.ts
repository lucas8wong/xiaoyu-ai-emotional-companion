/**
 * 持久化抽象层（存储层唯一缝点）
 *
 * 所有业务服务的数据读写都必须经过本模块（readJson / writeJson / persistence），
 * 不允许直接碰 fs —— 这样将来把存储迁移到 SQLite / Cloudflare D1 / KV 时，
 * 只需要替换本模块的 PersistenceProvider 实现（按「逻辑文件」存取 JSON），
 * 18 个业务服务零改动。
 *
 * 当前实现：文件持久化（data/*.json，原子写 tmp+rename，与旧行为一致）。
 */

import fs from 'fs';
import path from 'path';
import { createSqlitePersistenceProvider } from './sqliteProvider.js';

/** 持久化提供者接口：业务层只依赖它，不依赖具体实现 */
export interface PersistenceProvider {
  /** 读取文件原始内容；文件不存在返回 null */
  read(file: string): string | null;
  /** 原子写（先写 tmp 再 rename，避免写一半损坏） */
  write(file: string, content: string): void;
  /** 确保目录存在 */
  ensureDir(dir: string): void;
}

/** 文件持久化实现（现状：data/*.json） */
const fileProviderImpl: PersistenceProvider = {
  read(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  },
  write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
  },
  ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  },
};

/**
 * 持久化提供者：默认本地 JSON 文件；设 PERSISTENCE_PROVIDER=sqlite 时用 SQLite（单个 .sqlite 文件）。
 * 均为**同步**实现，兼容现有 store（启动时异步化改造是阶段2的事）。
 */
const providerName = String(process.env.PERSISTENCE_PROVIDER || 'file').toLowerCase();
export const persistence: PersistenceProvider = providerName === 'sqlite' ? createSqlitePersistenceProvider() : fileProviderImpl;

/** data 目录（可被测试覆盖） */
export function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

/** 构造 data/ 下的文件路径 */
export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}

/** 读取 JSON：文件不存在或解析失败返回 fallback；可传 reviver（如 Date 还原） */
export function readJson<T>(file: string, fallback: T, reviver?: (key: string, value: any) => any): T {
  const raw = persistence.read(file);
  if (raw == null || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw, reviver) as T;
  } catch {
    return fallback;
  }
}

/**
 * 启动自检（2026-09-28 审查 P1-7）：数据目录必须存在，且必须真的能写入并读回。
 * 为什么必须 fail fast：sqlite 实现曾把读写异常全部吞掉，而 data/ 又没有任何代码创建——
 * new Database('data/xiaoyu.sqlite') 抛 SQLITE_CANTOPEN 后，每个读返回 null、每个写被丢弃，
 * 接口却照样 200。宁可启动失败，也不能「看起来正常地把用户数据全丢掉」。
 */
export function assertStorageReady(): { ok: boolean; dir: string; detail: string } {
  const dir = dataDir();
  try {
    persistence.ensureDir(dir);
    const probe = path.join(dir, '.storage-probe');
    const payload = String(Date.now());
    persistence.write(probe, payload);
    const back = persistence.read(probe);
    if (back !== payload) return { ok: false, dir, detail: 'probe read-back mismatch' };
    return { ok: true, dir, detail: providerName };
  } catch (e) {
    return { ok: false, dir, detail: (e as Error)?.message || String(e) };
  }
}

/** 写 JSON（序列化 + 原子写） */
export function writeJson(file: string, data: unknown): void {
  persistence.write(file, JSON.stringify(data));
}
