/**
 * 节日礼通知 CLI：**站内三语公告 + 群发邮件**（"你已获得 N 天完整 Pro"）。
 *
 * 用法（在项目根目录，确保 .env 已配置 HOLIDAY_GIFT_*、CAMPAIGN_SMTP_* 与 ADMIN_TOKEN）：
 *   npx tsx scripts/notify-holiday-gift.mts                    # dry-run：名单/样例/公告文案，零副作用
 *   npx tsx scripts/notify-holiday-gift.mts --announce         # 发布站内三语公告（幂等，只发一次）
 *   npx tsx scripts/notify-holiday-gift.mts --mail             # 真发邮件（受每日上限约束）
 *   npx tsx scripts/notify-holiday-gift.mts --mail --limit=200 # 显式批量上限（硬上限 HOLIDAY_GIFT_MAIL_HARD_LIMIT）
 *   npx tsx scripts/notify-holiday-gift.mts --all              # 公告 + 邮件
 *
 * ⚠️ 全部经**运行中的 3001 服务**执行（admin 接口）：本项目线上数据在 SQLite，业务 store 是
 *    「整逻辑文件读写」，独立进程直接改会与在线服务产生丢失更新。
 * 通道：群发邮件走独立 SMTP（CAMPAIGN_SMTP_*，默认 myxiaoyu2026@gmail.com），
 *       与承载注册验证码/改密的 Resend 主通道物理隔离，不占主通道的非关键邮件预算。
 */

import 'dotenv/config';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function numArg(name: string): number | undefined {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!m) return undefined;
  const n = Number(m.split('=')[1]);
  return n > 0 ? n : undefined;
}

function usage(): void {
  console.log(`
节日礼通知：站内三语公告 + 群发邮件

用法:
  npx tsx scripts/notify-holiday-gift.mts                    # dry-run 报告（不改数据、不发信）
  npx tsx scripts/notify-holiday-gift.mts --announce         # 发布站内三语公告（幂等）
  npx tsx scripts/notify-holiday-gift.mts --mail             # 真发邮件
  npx tsx scripts/notify-holiday-gift.mts --mail --limit=200 # 显式批量上限
  npx tsx scripts/notify-holiday-gift.mts --all              # 公告 + 邮件

选项:
  --announce     发布站内三语公告（apply）
  --mail         真实群发邮件（apply）
  --all          = --announce + --mail
  --limit=N      本次群发上限（默认＝当日剩余额度；硬上限 HOLIDAY_GIFT_MAIL_HARD_LIMIT）
  --sample=N     dry-run 样例封数（默认 3）
  --crisis       允许发给处于情绪危机的用户（默认排除）
  --help         查看帮助
  `);
}

interface AdminResult<T> { success?: boolean; error?: string; detail?: string; data?: T }

async function callAdmin<T>(path: string, params: Record<string, string>): Promise<T> {
  const base = process.env.BASE_URL || 'http://127.0.0.1:3001';
  const token = process.env.ADMIN_TOKEN || '';
  if (!token) {
    console.error('❌ 未配置 ADMIN_TOKEN，无法通过服务端接口执行。请在 .env 设置。');
    process.exit(1);
  }
  const qs = new URLSearchParams({ token, ...params });
  const display = new URLSearchParams(qs);
  display.set('token', '****');
  console.log(`→ POST ${base}${path}?${display.toString()}`);
  try {
    const res = await fetch(`${base}${path}?${qs.toString()}`, { method: 'POST' });
    const body = await res.json() as AdminResult<T>;
    if (!res.ok || body?.success !== true) {
      console.error('❌ 服务端执行失败:', body?.error || body?.detail || `HTTP ${res.status}`);
      process.exit(1);
    }
    return body.data as T;
  } catch (e) {
    console.error('❌ 请求服务端失败（请确认 3001 服务已启动）:', (e as Error)?.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (hasFlag('--help')) { usage(); return; }

  const doAnnounce = hasFlag('--announce') || hasFlag('--all');
  const doMail = hasFlag('--mail') || hasFlag('--all');
  const extras: Record<string, string> = {};
  const limit = numArg('limit');
  if (limit) extras.limit = String(limit);
  const sample = numArg('sample');
  if (sample) extras.sample = String(sample);
  if (hasFlag('--crisis')) extras.crisis = '1';

  // ① 公告
  const ann = await callAdmin<any>('/api/payment/admin/holiday-gift/announce', {
    ...(doAnnounce ? { apply: '1' } : {}),
  });
  console.log('\n┌──────────── 节日礼·站内公告 ────────────┐');
  console.log(`  活动标识    : ${ann?.campaignId}`);
  console.log(`  状态        : ${ann?.applied ? '已发布' : ann?.existed ? '此前已发布（幂等跳过）' : 'dry-run（未发布）'}`);
  if (ann?.announcementId) console.log(`  公告 id     : ${ann.announcementId}`);
  const c = ann?.copy;
  if (c) {
    console.log(`  简中        : ${c.annZhCN.title}`);
    console.log(`  繁中        : ${c.annZhTW.title}`);
    console.log(`  英文        : ${c.annEn.title}`);
  }
  console.log('└──────────────────────────────────────────────┘');

  // ② 邮件
  const mail = await callAdmin<any>('/api/payment/admin/holiday-gift/mail', {
    ...(doMail ? { apply: '1' } : {}),
    ...extras,
  });
  console.log('\n┌──────────── 节日礼·群发邮件 ────────────┐');
  console.log(`  模式        : ${mail?.applied ? 'apply（已发）' : 'dry-run（未发）'}`);
  console.log(`  群发通道    : ${mail?.transport?.ready ? `就绪（${mail.transport.from}）` : `未就绪：${mail?.transport?.reason}`}`);
  console.log(`  待发人数    : ${mail?.planned}（已发过 ${mail?.alreadySent} 位）`);
  console.log(`  语言分布    : 简中 ${mail?.byLang?.['zh-CN'] || 0} · 繁中 ${mail?.byLang?.['zh-TW'] || 0} · 英文 ${mail?.byLang?.en || 0}`);
  if (mail?.excluded) {
    const ex = mail.excluded;
    console.log(`  已排除      : 无邮箱 ${ex.noEmail} · 测试/开发 ${ex.testOrDev} · 已退订 ${ex.optedOut} · 情绪危机 ${ex.crisis} · 重复邮箱 ${ex.duplicateEmail}`);
  }
  console.log(`  今日已发    : ${mail?.sentToday} / 上限 ${mail?.dailyCap}（预计需 ${mail?.estimatedDays} 个发送日）`);
  if (mail?.applied) {
    console.log(`  已发成功    : ${mail?.sent} · 失败 ${mail?.failed} · 因上限跳过 ${mail?.skippedByCap}`);
    for (const err of (mail?.errors || []).slice(0, 10)) console.log(`    ✗ ${err.email}: ${err.detail}`);
  }
  console.log('└──────────────────────────────────────────────┘');
  if (Array.isArray(mail?.samples) && mail.samples.length) {
    console.log('\n样例（按语言各一封）:');
    for (const s of mail.samples) console.log(`  - [${s.lang}] ${s.subject}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('❌ 执行出错:', (e as Error)?.message);
  process.exit(1);
});
