/**
 * AI 建剧提示词日志（运营可见）
 *
 * 背景：剧情模式里「AI 帮我写剧本 / AI 改稿」是**一次性生成、不落库**的调用——草稿只回填表单，
 * 用户改完再保存，所以用户当时输入的提示词原本哪里都没留，控制台只能看到最终剧本，
 * 看不到「TA 是拿什么描述让 AI 生成的」。
 *
 * 本模块把每次 AI 建剧调用的**提示词 + 结果**留一份，供控制台（ADMIN_TOKEN 鉴权）查看。
 * 隐私口径：这是用户自己输入的内容，与聊天记录同级，只给运营后台看；不进审阅队列、不注入模型、不对外。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

/** roleplay-draft=剧情模式「AI 帮我写剧本」 · roleplay-revise=「AI 改稿」 · wenyou-generate=AI 文游「AI 生成剧本」 */
export type CreationPromptKind = 'roleplay-draft' | 'roleplay-revise' | 'wenyou-generate';
/** ok=生成成功 · blocked=输入（灵感/要求）就被红线拦下 · rejected=生成结果被安全拦下 · format=模型格式抖动 · error=调用失败 */
export type CreationPromptOutcome = 'ok' | 'blocked' | 'rejected' | 'format' | 'error';

export interface CreationPromptEntry {
  id: string;
  at: number;
  userId: string;
  kind: CreationPromptKind;
  /** 用户输入的原文（截断到 PROMPT_MAX，超长会带省略标记） */
  prompt: string;
  lang?: string;
  outcome: CreationPromptOutcome;
  /** 生成出来的标题（成功/被拦时若有） */
  resultTitle?: string;
  /** 关联对象：自建剧本 id（draft/revise）；文游生成暂无 id */
  scenarioId?: string;
}

/** 提示词原文上限：用户可能直接贴整份剧本（AI 接口本身不截断），日志里留 8000 字够复盘，又不至于撑爆文件 */
const PROMPT_MAX = 8000;
/** 全量上限：只保留最新 N 条（超出丢最旧），单文件体积可控 */
const MAX_ENTRIES = 5000;

const FILE = dataFile('creation-prompt-log.json');

class CreationPromptLogStore {
  private items: CreationPromptEntry[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<any[]>(FILE, []);
    if (!Array.isArray(parsed)) return;
    this.items = parsed.filter((e: any) => e && e.id && e.userId && e.at);
  }

  private saveToDisk(): void {
    try { writeJson(FILE, this.items); } catch { /* 忽略 */ }
  }

  private trimPrompt(raw: unknown): string {
    const s = typeof raw === 'string' ? raw : '';
    return s.length > PROMPT_MAX ? s.slice(0, PROMPT_MAX) + '…（已截断）' : s;
  }

  add(entry: {
    userId: string;
    kind: CreationPromptKind;
    prompt: unknown;
    outcome: CreationPromptOutcome;
    lang?: string;
    resultTitle?: string;
    scenarioId?: string;
  }): CreationPromptEntry {
    const at = Date.now();
    const rec: CreationPromptEntry = {
      id: 'cp_' + at.toString(36) + Math.random().toString(36).slice(2, 8),
      at,
      userId: entry.userId,
      kind: entry.kind,
      prompt: this.trimPrompt(entry.prompt),
      outcome: entry.outcome,
      ...(entry.lang ? { lang: entry.lang } : {}),
      ...(entry.resultTitle ? { resultTitle: String(entry.resultTitle).slice(0, 120) } : {}),
      ...(entry.scenarioId ? { scenarioId: String(entry.scenarioId).slice(0, 80) } : {}),
    };
    this.items.push(rec);
    if (this.items.length > MAX_ENTRIES) this.items = this.items.slice(-MAX_ENTRIES);
    this.saveToDisk();
    return rec;
  }

  /**
   * 某用户的记录（新的在前）。
   *
   * ⚠️ 同一毫秒写入的多条必须用**插入顺序倒序**兜底：`at` 是毫秒时间戳，而本模块的写入
   * 全是紧挨着的（一次建剧 = 一条；测试里连写两条），只按 `at` 排时 V8 的稳定排序会保持
   * 插入顺序 ⇒ **旧记录排在新记录前面**，调用方读到的「最新一条」是错的
   *（2026-09-25 实测：test/unit/creationPromptLog.test.ts 偶发失败，就是这个平局）。
   */
  listByUser(userId: string, limit = 30): CreationPromptEntry[] {
    return this.items
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e.userId === userId)
      .sort((a, b) => (b.e.at - a.e.at) || (b.i - a.i))
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** 全站最近记录（新的在前，同一毫秒按插入顺序倒序）——控制台「最近 AI 建剧」用 */
  listRecent(limit = 50): CreationPromptEntry[] {
    return this.items
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (b.e.at - a.e.at) || (b.i - a.i))
      .slice(0, limit)
      .map((x) => x.e);
  }

  size(): number { return this.items.length; }
}

export const creationPromptLog = new CreationPromptLogStore();
