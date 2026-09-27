/**
 * 新人福利 CLI：给当前无会员的注册用户开通 7 天 Pro 试用 + 按 IP 地区语言发恭喜邮件。
 *
 * 用法（在项目根目录，确保 .env 已配置 SMTP + ADMIN_TOKEN）：
 *   npx tsx scripts/grant-pro-trial-newcomer.mts                 # dry-run：只统计，零副作用
 *   npx tsx scripts/grant-pro-trial-newcomer.mts --apply         # 调服务端 admin 接口真实执行（自动备份→授权→发信→写 marker）
 *   npx tsx scripts/grant-pro-trial-newcomer.mts --apply --force # 忽略已有 marker，重新处理（新一轮/重跑；普通重跑别加）
 *   npx tsx scripts/grant-pro-trial-newcomer.mts --days=7        # 指定试用天数
 *
 * ⚠️ 为什么 apply 走服务端接口：本项目线上数据在 SQLite（PERSISTENCE_PROVIDER=sqlite），
 * 业务 store 是「整逻辑文件读写」；若在独立进程直接改 SQLite，会与运行中的服务产生「丢失更新」。
 * 因此真实执行交由运行中的 3001 进程完成（同一 store/同一连接），CLI 只需以 ADMIN_TOKEN 调它。
 */

import 'dotenv/config';
import { runNewcomerProTrial, type NewcomerRunReport } from '../api/services/proTrialNewcomer.js';

function usage(): void {
  console.log(`
新人福利：开通 7 天 Pro 试用 + 按 IP 地区语言发恭喜邮件

用法:
  npx tsx scripts/grant-pro-trial-newcomer.mts                # dry-run 报告（不改数据、不发信）
  npx tsx scripts/grant-pro-trial-newcomer.mts --apply        # 经服务端 admin 接口真实执行
  npx tsx scripts/grant-pro-trial-newcomer.mts --apply --force
  npx tsx scripts/grant-pro-trial-newcomer.mts --days=7
  npx tsx scripts/grant-pro-trial-newcomer.mts --apply --exclude=someone@example.com

选项:
  --apply         真实执行（缺省为 dry-run）
  --force         忽略已有 marker，重新处理全部符合者（新一轮/重跑）
  --exclude=      逗号分隔要排除的 userId 或邮箱（如 joy 的邮箱/ID）
  --days=N        试用天数（缺省取 .env PRO_TRIAL_DAYS / 7）
  --help          查看帮助
  `);
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printReport(report: NewcomerRunReport): void {
  const langLabel: Record<string, string> = { 'zh-CN': '简中', 'zh-TW': '繁中', en: '英文' };
  console.log('\n┌──────────── 新人福利·Pro 试用报告 ────────────┐');
  console.log(`  模式        : ${report.dryRun ? 'dry-run（零副作用）' : 'apply（已执行）'}`);
  console.log(`  试用天数    : ${report.days}`);
  console.log(`  符合条件数  : ${report.totalEligible}`);
  console.log(`  本轮处理    : ${report.candidates.length}（已跳过 ${report.skippedProcessed} 位此前已处理 · 主动排除 ${report.excludedCount} 位）`);
  console.log(`  语言分布    : 简中 ${report.byLanguage['zh-CN']} · 繁中 ${report.byLanguage['zh-TW']} · 英文 ${report.byLanguage.en}`);
  if (report.backupPath) console.log(`  备份路径    : ${report.backupPath}`);
  if (!report.dryRun) {
    console.log(`  已授权      : ${report.granted}`);
    console.log(`  已发信      : ${report.emailed}`);
    console.log(`  发信失败    : ${report.emailFailed}`);
    console.log(`  marker      : ${report.markerExists}`);
  }
  console.log('└──────────────────────────────────────────────┘');
  if (report.candidates.length) {
    console.log('\n候选人清单:');
    for (const c of report.candidates) {
      console.log(`  - ${c.username || c.email.split('@')[0]}  <${c.email}>  [${langLabel[c.language]}]  ${c.country || '(无地区记录)'}`);
    }
  }
  console.log('');
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
  const url = `${base}/api/payment/admin/newcomer-pro-trial?${params.toString()}`;
  console.log(`→ POST ${base}/api/payment/admin/newcomer-pro-trial?${displayParams.toString()}`);
  try {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.json() as any;
    if (!res.ok || body?.success !== true) {
      console.error('❌ 服务端执行失败:', body?.error || body?.detail || `HTTP ${res.status}`);
      process.exit(1);
    }
    printReport(body.data as NewcomerRunReport);
  } catch (e) {
    console.error('❌ 请求服务端失败（请确认 3001 服务已启动）:', (e as Error)?.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    usage();
    return;
  }
  if (hasFlag('--apply')) {
    await runApply();
    return;
  }
  // 默认 dry-run（本进程只读，零副作用）
  const days = daysArg();
  const exclude = excludeArg();
  const report = await runNewcomerProTrial({ dryRun: true, days, exclude });
  printReport(report);
}

main().catch((e) => {
  console.error('❌ 执行出错:', (e as Error)?.message);
  process.exit(1);
});
