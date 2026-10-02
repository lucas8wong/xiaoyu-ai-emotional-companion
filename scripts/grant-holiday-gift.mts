/**
 * 节日礼 CLI：给「所有注册用户」赠送 N 天完整 Pro（含活动窗口内新注册的用户）。
 *
 * 用法（在项目根目录，确保 .env 已配置 HOLIDAY_GIFT_* 与 ADMIN_TOKEN）：
 *   npx tsx scripts/grant-holiday-gift.mts                 # dry-run：只统计，零副作用（本进程只读）
 *   npx tsx scripts/grant-holiday-gift.mts --apply         # 调服务端 admin 接口真实执行（自动备份→授权→写 marker）
 *   npx tsx scripts/grant-holiday-gift.mts --apply --force # 忽略 marker 重新处理（⚠️ 会重复延长时间）
 *   npx tsx scripts/grant-holiday-gift.mts --days=1        # 指定赠送天数（缺省 .env HOLIDAY_GIFT_DAYS / 1）
 *   npx tsx scripts/grant-holiday-gift.mts --exclude=a@b.com,<userId>
 *
 * ⚠️ 为什么 apply 走服务端接口：本项目线上数据在 SQLite（PERSISTENCE_PROVIDER=sqlite），业务 store 是
 *    「整逻辑文件读写」；独立进程直接改 SQLite 会与运行中的服务产生「丢失更新」。因此真实执行交给
 *    运行中的 3001 进程（同一 store/同一连接），CLI 只以 ADMIN_TOKEN 调它。
 * ⚠️ 「当天新注册的用户」由注册链路即时发放（api/services/holidayGift.ts 的 maybeGrantHolidayGiftOnRegister），
 *    与批量发放共用同一份 marker，所以本脚本重复跑不会给同一人重复发。
 */

import 'dotenv/config';
import { runHolidayGift, isHolidayGiftActive, holidayGiftConfig, type HolidayGiftRunReport } from '../api/services/holidayGift.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function daysArg(): number | undefined {
  const m = process.argv.find((a) => a.startsWith('--days='));
  if (!m) return undefined;
  const n = Number(m.split('=')[1]);
  return n > 0 ? n : undefined;
}
function excludeArg(): string[] {
  const m = process.argv.find((a) => a.startsWith('--exclude='));
  if (!m) return [];
  return m.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function usage(): void {
  console.log(`
节日礼：给所有注册用户赠送 N 天完整 Pro

用法:
  npx tsx scripts/grant-holiday-gift.mts                 # dry-run 报告（不改数据）
  npx tsx scripts/grant-holiday-gift.mts --apply         # 经服务端 admin 接口真实执行
  npx tsx scripts/grant-holiday-gift.mts --apply --force
  npx tsx scripts/grant-holiday-gift.mts --days=1
  npx tsx scripts/grant-holiday-gift.mts --exclude=a@b.com,<userId>

选项:
  --apply      真实执行（缺省为 dry-run）
  --force      忽略已有 marker，重新处理全部候选（新一轮/重跑）
  --exclude=   逗号分隔要排除的 userId 或邮箱
  --days=N     赠送天数（缺省取 .env HOLIDAY_GIFT_DAYS / 1）
  --help       查看帮助
  `);
}

function printReport(report: HolidayGiftRunReport): void {
  console.log('\n┌──────────── 节日礼·Pro 赠送报告 ────────────┐');
  console.log(`  模式        : ${report.dryRun ? 'dry-run（零副作用）' : 'apply（已执行）'}`);
  console.log(`  活动标识    : ${report.campaignId}`);
  console.log(`  赠送天数    : ${report.days}`);
  console.log(`  窗口状态    : ${report.active ? '进行中（新注册会即时发放）' : '不在窗口内（仅批量发放）'}`);
  console.log(`  符合条件数  : ${report.totalEligible}`);
  console.log(`  本轮处理    : ${report.toProcess}（已发过 ${report.skippedProcessed} 位 · 主动排除 ${report.excludedCount} 位）`);
  if (report.backupPath) console.log(`  备份路径    : ${report.backupPath}`);
  if (!report.dryRun) console.log(`  已赠送      : ${report.granted}`);
  console.log('└──────────────────────────────────────────────┘\n');
}

async function runApply(): Promise<void> {
  const base = process.env.BASE_URL || 'http://127.0.0.1:3001';
  const token = process.env.ADMIN_TOKEN || '';
  if (!token) {
    console.error('❌ 未配置 ADMIN_TOKEN，无法通过服务端接口执行。请在 .env 设置。');
    process.exit(1);
  }
  const params = new URLSearchParams({ token, apply: '1' });
  if (hasFlag('--force')) params.set('force', '1');
  const days = daysArg();
  if (days) params.set('days', String(days));
  const exclude = excludeArg();
  if (exclude.length) params.set('exclude', exclude.join(','));
  const displayParams = new URLSearchParams(params);
  if (displayParams.has('token')) displayParams.set('token', '****');
  const url = `${base}/api/payment/admin/holiday-gift?${params.toString()}`;
  console.log(`→ POST ${base}/api/payment/admin/holiday-gift?${displayParams.toString()}`);
  try {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.json() as { success?: boolean; error?: string; detail?: string; data?: HolidayGiftRunReport };
    if (!res.ok || body?.success !== true) {
      console.error('❌ 服务端执行失败:', body?.error || body?.detail || `HTTP ${res.status}`);
      process.exit(1);
    }
    printReport(body.data as HolidayGiftRunReport);
  } catch (e) {
    console.error('❌ 请求服务端失败（请确认 3001 服务已启动）:', (e as Error)?.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (hasFlag('--help')) { usage(); return; }
  if (hasFlag('--apply')) { await runApply(); return; }

  // 默认 dry-run（本进程只读，零副作用）
  const env = holidayGiftConfig();
  console.log(`活动配置: id=${env.campaignId || '(未配置)'} days=${env.days} start=${env.start || '(未配置)'} end=${env.end || '(未配置)'} active=${isHolidayGiftActive()}`);
  const report = runHolidayGift({ dryRun: true, days: daysArg(), exclude: excludeArg() });
  printReport(report);
}

main().catch((e) => {
  console.error('❌ 执行出错:', (e as Error)?.message);
  process.exit(1);
});
