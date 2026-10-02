/**
 * 生成「去除账号关联」的审阅队列，运营/开发审阅对话质量用的**唯一入口**。
 *
 * 用法：
 *   npx tsx scripts/build-review-queue.mts                     # 并进 data/review-queue.jsonl（增量档案）
 *   npx tsx scripts/build-review-queue.mts --limit 100          # 本次最多并多少条（默认 500 = 取满）
 *   npx tsx scripts/build-review-queue.mts --kinds roleplay     # 只看剧情
 *   npx tsx scripts/build-review-queue.mts --dry-run            # 只报告，不写文件
 *   npx tsx scripts/build-review-queue.mts --out temp/q.jsonl   # 导出「本次这一份」快照（不并档）
 *   npx tsx scripts/build-review-queue.mts --include-test       # 也收测试身份（仅自测/回归用）
 *
 * ⚠️ 2026-09-25 起默认行为改成**并进增量档案**（按「对话身份键」去重），不再整体覆盖：
 *    原来每次生成都覆盖，会把上一次有资格但这次被 limit 截掉的记录直接抹掉。
 *    指定 `--out` 时才退化成「本次这一份」的独立快照。
 *    ⚠️ CLI **不迁移已读标记**（`data/review-reads.json` 的键换口径时要搬）：CLI 与线上实例
 *    各持一份内存态，同时写会互相覆盖。并档后请在后台页点一次「重新生成队列」，
 *    服务端会顺手把已读标记迁到新指纹上（不迁移的表现 = 之前标过的已读全变回未读）。
 *
 * 默认只收**真实用户**：测试 / 开发身份（`test-` 前缀设备、@test.com、TEST_ACCOUNTS、
 * 内置开发者邮箱、DEV_ACCOUNTS）整条排除，审阅队列是用来照真实用户行为改模型的，
 * 自测对话混进来会把结论带偏。
 *
 * 安全设计：
 *   ① 只写审阅副本文件（`data/review-queue.jsonl`），绝不改动/删除任何既有用户数据。
 *   ② 写盘前必须过 `assertDeidentified()`，宁可不出文件，也不出带身份的队列（fail-closed）。
 *   ③ 控制台只打印计数与类别，**不打印任何一条用户内容**。
 *   ④ 先写 `.tmp` 再 rename：不会留下半截文件，也不会覆盖到一半失败。
 *
 * ⚠️ 2026-09-25 实测踩到的坑（已修）：本脚本原先**没有加载 .env**，而 `PERSISTENCE_PROVIDER`
 *    是在 `storage/persistence.ts` 模块求值时读的，于是 `npx tsx scripts/build-review-queue.mts`
 *    会走**文件**提供者，去读 `data/*.json` 那批**迁移前的旧快照**（实测只扫出 15 条聊一聊 /
 *    25 条剧情，而线上 sqlite 里是 74 / 314），"跑成功了但审的是过期内容"。
 *    现在 `dotenv/config` 放在**所有业务模块之前**导入，并在启动时打印数据源，防止再踩。
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewQueue, assertDeidentified } from '../api/services/reviewQueue.js';
import {
  loadArchive, mergeArchive, writeArchive, serializeArchive, archiveRange,
  ARCHIVE_VERSION, ARCHIVE_NOTE,
} from '../api/services/reviewArchive.js';
import { describeHits } from '../api/services/deidentify.js';
import { preferenceStore } from '../api/services/preferences.js';
import { memoryStorage } from '../api/storage/memory.js';
import { roleplaySessionStore } from '../api/services/roleplaySessions.js';
import { accountStore } from '../api/services/accounts.js';
import { isTestAccount, isDeveloperAccount } from '../api/services/accountFilters.js';
import { isTestRequest } from '../api/services/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has('dry-run');
const includeTest = has('include-test');
/** 本次最多并多少条（默认取满：limit 是「并档上限」不是「页面显示条数」） */
const limit = Number(arg('limit') || 500);
const minUserTurns = Number(arg('min-turns') || 2);
const kinds = (arg('kinds') || 'chat,roleplay')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is 'chat' | 'roleplay' => s === 'chat' || s === 'roleplay');
const outArg = arg('out');
/** 指定 --out = 导出「本次这一份」独立快照；不给则并进默认档案 */
const standalone = Boolean(outArg);
const outPath = path.resolve(root, outArg || path.join('data', 'review-queue.jsonl'));

const chatSessions = memoryStorage.getActiveSessions();
const roleplayRecords = roleplaySessionStore.listAll();

/**
 * 数据源自证：审阅的价值全在「审的是真实且最新的记录」上。
 * 走错提供者（读 data/*.json 旧快照）时这里会明显对不上线上规模，一眼就能看出来。
 */
console.log(
  `[数据源] PERSISTENCE_PROVIDER=${process.env.PERSISTENCE_PROVIDER || 'file(缺省)'}` +
  ` · 读到：聊一聊 ${chatSessions.length} 条会话 / 剧情 ${roleplayRecords.length} 条` +
  (String(process.env.PERSISTENCE_PROVIDER || '').toLowerCase() === 'sqlite' ? '' : '　⚠️ 不是 sqlite：多半读到的是 data/*.json 旧快照'),
);

/**
 * 「这条是不是真实用户」，**测试 / 开发身份默认不入队**。
 *
 * 为什么复用既有判据而不是在这里另写一份正则：`accountFilters.ts` 开篇就写明
 * 「避免两处各写一份、日后口径漂移」。所以账号级直接用它的两个函数，设备级直接用
 * `isTestRequest` 本身（会话里不存 IP，所以只走它其中的 deviceId 规则）。
 *
 * 为什么这件事必须做：审阅队列的用途是**照真实用户的行为去改模型**。自测对话混进来，
 * 会让你把「我自己测出来的现象」当成「用户在抱怨」，结论直接被带偏。
 */
function makeIsTestUser(): (userId: string) => boolean {
  return (userId: string): boolean => {
    if (isTestRequest(undefined, userId)) return true;
    const acc = accountStore.getById(userId);
    if (acc && (isTestAccount(acc) || isDeveloperAccount(acc))) return true;
    return false;
  };
}

// 收集「已知身份值」用于泄露断言：userId + 邮箱 + 手机号。
// 结构检查只能发现「键还在」，发现不了「userId 被拼进了正文」，所以取值也要查。
const knownIdentity: string[] = [];
for (const s of chatSessions) if (typeof s.userId === 'string') knownIdentity.push(s.userId);
for (const r of roleplayRecords) if (typeof r.userId === 'string') knownIdentity.push(r.userId);

const result = buildReviewQueue({
  chatSessions,
  roleplayRecords,
  // 「允许用于改进服务」开关第一次真正生效的地方：关掉的用户不进队列
  shouldInclude: (userId: string) => preferenceStore.get(userId).dataEnhance !== false,
  // 测试 / 开发身份默认整条排除（--include-test 才收，且条目上会标 test: true）
  isTestUser: makeIsTestUser(),
  includeTest,
  limit,
  minUserTurns,
  kinds,
  /**
   * 基础设置快照（与支付后台按钮同一份口径）：陪伴方式 / 深度思考档位 / 地区语气 / 括号心理 …。
   * 键由 reviewQueue 的白名单过滤，整份偏好丢进去也不会泄露（尤其以剧本 id 为 key 的那张表）。
   */
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

const knownValues = Array.from(new Set(knownIdentity));
const rel = (p: string) => path.relative(root, p);

if (dryRun) {
  // fail-closed 也照样验一遍：dry-run 的意义是「先看看这批干不干净」
  assertDeidentified(result.items, knownValues);
  console.log(`[dry-run] 未写文件。本次候选 ${result.items.length} 条`);
} else if (standalone) {
  // 导出「本次这一份」独立快照（不并档）：给一次性交付/离线分析用
  assertDeidentified(result.items, knownValues);
  const meta = {
    version: ARCHIVE_VERSION,
    generatedAt: new Date().toISOString(),
    itemCount: result.items.length,
    archivedTotal: result.items.length,
    added: result.items.length,
    refreshed: 0,
    dropped: 0,
    range: archiveRange(result.items),
    stats: result.stats,
    note: ARCHIVE_NOTE + '（本文件是 --out 导出的单次快照，不是并档结果）',
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, serializeArchive(meta, result.items), 'utf8');
  fs.renameSync(tmp, outPath); // 原子替换：不会留下半截文件
  console.log(`✅ 已导出本次快照 ${result.items.length} 条 → ${rel(outPath)}`);
} else {
  // 并进增量档案：已有条目不会被本次生成挤掉（这是「不再漏记录」的关键）
  const before = loadArchive(outPath);
  const now = Date.now();
  const merged = mergeArchive(before.items, result.items, { now });
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
  // fail-closed：过一遍**整个档案**，不只本次新增的那批
  assertDeidentified({ meta, items: merged.items }, knownValues);
  writeArchive(merged.items, meta, outPath);
  console.log(
    `✅ 已并档：本次候选 ${result.items.length} 条 → 新增 ${merged.added} / 刷新 ${merged.refreshed}，`
    + `档案共 ${merged.items.length} 条${merged.dropped ? `（超上限丢弃 ${merged.dropped}）` : ''} → ${rel(outPath)}`,
  );
  const migrate = Object.keys(merged.keyMap).length;
  if (migrate) {
    console.log(
      `   ⚠️ 有 ${migrate} 条老条目换了指纹口径，已读标记需迁移：请在后台页点一次「🔄 重新生成队列」`
      + '（服务端会顺手迁移；CLI 与线上实例各持一份内存态，直接改会互相覆盖）。',
    );
  }
}

// 只打印计数与类别，不含任何用户内容
console.log(
  `   扫描：聊一聊 ${result.stats.chatScanned} / 剧情 ${result.stats.roleplayScanned}` +
  `　跳过：测试/开发身份 ${result.stats.skippedTest} / dataEnhance 关闭 ${result.stats.skippedByDataEnhance} / 轮数不足 ${result.stats.skippedByFilter}`
);
if (includeTest) {
  console.log('   ⚠️ 已开启 --include-test：队列里含测试身份（条目带 test:true），正常审阅不该这么跑');
}
const hitDesc = describeHits(result.stats.scrubHits).join('、');
console.log(`   脱敏命中：${hitDesc || '（无）'}`);
if (result.items.length === 0) {
  console.log('   ⚠️ 队列为空，检查是否所有用户都关了「允许用于改进服务」，或 min-turns 设得太高');
}
