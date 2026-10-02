/**
 * 审阅档案的**构建编排**，把「收集数据 → 构建 → 去标识化断言 → 并进增量档案 →
 * 迁移已读标记 → 清理失效标记」这一串从前只写在后台路由里的流程抽成一处，
 * 让三条入口共用同一份口径：
 *   ① 后台页「🔄 更新档案（增量）」按钮（POST /review-queue/build）
 *   ② 命令行 `npx tsx scripts/build-review-queue.mts`
 *   ③ **服务端定时器**（2026-09-29 新增，见 server.ts 的 startReviewArchiveScheduler）
 *
 * 为什么要有第 ③ 条（这次的真实病根）：
 *   「增量档案」只解决了「重建会把旧记录挤掉」，但**没人重建**的话新记录照样进不来。
 *   2026-09-25 生成的档案一直没再生成，到 09-29 时页面上最新记录还停在 09-24
 *   用户看到的「审阅 tab 只有 9/23 的」不是筛选掉了，是压根没扫过。
 *   所以把「并档」做成定时任务，页面上「档案更新于」那行过期提醒就只在异常时才会亮。
 *
 * 边界：这个模块只在**服务端进程内**调用；纯构建仍是 reviewQueue.ts 的纯函数，
 * 去标识化 fail-closed 断言、档案合并逻辑都在既有模块里，这里只做编排。
 */

import 'dotenv/config';
import { buildReviewQueue, assertDeidentified } from './reviewQueue.js';
import { preferenceStore } from './preferences.js';
import { memoryStorage } from '../storage/memory.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import { accountStore } from './accounts.js';
import { isTestAccount, isDeveloperAccount } from './accountFilters.js';
import { isTestRequest } from './activity.js';
import {
  loadArchive, mergeArchive, writeArchive, archiveRange, ARCHIVE_VERSION, ARCHIVE_NOTE,
} from './reviewArchive.js';
import { archiveKeys } from './reviewQuery.js';
import { reviewReadStore } from './reviewReads.js';
import { auditStore } from './audit.js';

export interface ReviewBuildOptions {
  /** 本次最多把多少条有资格的对话并进档案（不是页面显示条数）；默认 500，上限 2000 */
  limit?: number;
  /** 至少几条用户发言才算有资格；默认 2 */
  minUserTurns?: number;
  /** 是否收测试/开发身份（仅自测/回归用，默认 false） */
  includeTest?: boolean;
  /** 触发来源，写进审计日志与同步调试用 */
  source?: 'admin' | 'scheduler' | 'cli';
  /** 审计日志里的访问方（IP 等），定时器/CLI 不传 */
  ip?: string;
}

export interface ReviewBuildSummary {
  itemCount: number;
  added: number;
  refreshed: number;
  dropped: number;
  archivedTotal: number;
  migratedReads: number;
  prunedReads: number;
  range: { from: number; to: number };
  stats: unknown;
}

/** 同时只允许一个构建在跑：定时器与后台按钮撞在一起时，后到的直接跳过（不是排队）。 */
let running = false;

export function isReviewBuildRunning(): boolean {
  return running;
}

/**
 * 执行一次「增量并档」。同步（底层 store 都是内存 + 同步 sqlite/json 读）。
 *
 * 并发时抛错（带可识别前缀），让调用方各自决定怎么呈现：
 *   · 路由 → 409「正在生成中」
 *   · 定时器 → 跳过本轮
 */
export function buildReviewArchive(opts: ReviewBuildOptions = {}): ReviewBuildSummary {
  if (running) throw new Error('REVIEW_BUILD_BUSY：审阅档案正在生成中');
  running = true;
  try {
    const limit = Math.min(Math.max(1, Number(opts.limit) || 500), 2000);
    const minUserTurns = Math.max(1, Number(opts.minUserTurns) || 2);
    const includeTest = opts.includeTest === true;

    const chatSessions = memoryStorage.getActiveSessions();
    const roleplayRecords = roleplaySessionStore.listAll();

    // 取值检查要的「已知身份值」：结构检查发现不了「userId 被拼进了正文」
    const known = new Set<string>();
    for (const s of chatSessions) if (typeof s.userId === 'string') known.add(s.userId);
    for (const r of roleplayRecords) if (typeof r.userId === 'string') known.add(r.userId);

    /**
     * 「这条是不是真实用户」，测试 / 开发身份默认不入队。复用既有判据，不另写一份正则
     * （accountFilters.ts 开篇就写明要避免「两处各写一份、口径漂移」）。
     */
    const isTestUser = (userId: string): boolean => {
      if (isTestRequest(undefined, userId)) return true;
      const acc = accountStore.getById(userId);
      if (acc && (isTestAccount(acc) || isDeveloperAccount(acc))) return true;
      return false;
    };

    const result = buildReviewQueue({
      chatSessions,
      roleplayRecords,
      // 「允许用于改进服务」开关真正生效的地方：关掉的用户不进队列
      shouldInclude: (userId: string) => preferenceStore.get(userId).dataEnhance !== false,
      isTestUser,
      includeTest,
      limit,
      minUserTurns,
      getUserSettings: (userId: string) => {
        const p = preferenceStore.get(userId);
        return {
          mode: p.mode,
          tone: p.tone,
          storyStyle: p.storyStyle,
          region: p.region,
          intensity: p.intensity,
          language: p.language,
          thinkingLevel: p.thinkingLevel,
          chatInnerMonologue: p.chatInnerMonologueEnabled !== false,
          roleplayInnerMonologue: p.roleplayInnerMonologueEnabled !== false,
          smartFit: p.smartFitEnabled !== false,
          roleplayUnlimited: p.roleplayUnlimited === true,
          proactivePush: p.proactivePush === true,
          proactiveFrequency: p.proactiveFrequency,
        };
      },
    });

    // fail-closed：有泄露就抛，一个字节都不写
    assertDeidentified(result.items, Array.from(known));

    const before = loadArchive();
    const now = Date.now();
    const merged = mergeArchive(before.items, result.items, { now });

    let migrated = 0;
    for (const [oldKey, newKey] of Object.entries(merged.keyMap)) {
      if (reviewReadStore.rename(oldKey, newKey)) migrated += 1;
    }
    const pruned = reviewReadStore.prune(archiveKeys(merged.items));

    const meta = {
      version: ARCHIVE_VERSION,
      generatedAt: new Date(now).toISOString(),
      itemCount: result.items.length,
      archivedTotal: merged.items.length,
      added: merged.added,
      refreshed: merged.refreshed,
      dropped: merged.dropped,
      range: archiveRange(merged.items),
      stats: result.stats,
      note: ARCHIVE_NOTE,
    };

    // fail-closed：过一遍**整个档案**（不只是本次新增的那批）
    assertDeidentified({ meta, items: merged.items }, Array.from(known));
    writeArchive(merged.items, meta);

    const detail = `生成审阅档案：本次候选 ${result.items.length} 条 → 新增 ${merged.added} / 刷新 ${merged.refreshed}，档案共 ${merged.items.length} 条`
      + `${merged.dropped ? `（超上限丢弃 ${merged.dropped}）` : ''}`
      + `${migrated ? ` · 迁移已读标记 ${migrated}` : ''}${pruned ? ` · 清理失效标记 ${pruned}` : ''}`
      + `（跳过：测试/开发身份 ${result.stats.skippedTest}、dataEnhance 关闭 ${result.stats.skippedByDataEnhance}、轮数不足 ${result.stats.skippedByFilter}${includeTest ? '；⚠️ 本次含测试身份' : ''}）`;
    auditStore.log('review_build', detail + `（来源：${opts.source || 'admin'}）`, opts.ip || '');

    const stats = result.stats as { chatScanned?: number; roleplayScanned?: number };
    console.log(
      `🔍 [ReviewArchive] 增量并档完成（${opts.source || 'admin'}）：聊一聊 ${stats.chatScanned || 0} / 剧情 ${stats.roleplayScanned || 0}`
      + ` → 新增 ${merged.added} / 刷新 ${merged.refreshed}，档案共 ${merged.items.length} 条`,
    );

    return {
      itemCount: result.items.length,
      added: merged.added,
      refreshed: merged.refreshed,
      dropped: merged.dropped,
      archivedTotal: merged.items.length,
      migratedReads: migrated,
      prunedReads: pruned,
      range: meta.range,
      stats: result.stats,
    };
  } finally {
    running = false;
  }
}

export default { buildReviewArchive, isReviewBuildRunning };
