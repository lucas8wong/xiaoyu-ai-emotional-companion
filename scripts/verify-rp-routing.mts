/**
 * 生产路由自检：剧情链路此刻实际指向哪个模型？
 *
 * 用法：npx tsx scripts/verify-rp-routing.mts
 *
 * 读 .env（与服务器同一份），输出 zh / en 两个分支当前生效的模型名。
 * 显示 deepseek(default) 表示该分支未配置或配置不全（三项缺一即回落）。
 * **不会打印任何 API Key。**
 */
import 'dotenv/config';

const { roleplayRoutingSummary } = await import('../api/services/roleplayModel.js');

const s = roleplayRoutingSummary() as { zh: string; en: string; zhReason: string; enReason: string };
const bar = '─'.repeat(58);
console.log('\n' + bar);
console.log('剧情扮演 · 模型路由自检');
console.log(bar);
console.log('  zh / zh-TW  →  ' + s.zh + '   [' + s.zhReason + ']');
console.log('  en          →  ' + s.en + '   [' + s.enReason + ']');
console.log('  辅助调用    →  ' + (s as any).aux);
console.log(bar);

const REASON: Record<string, string> = {
  configured: '已启用第三方',
  unset: '未配置 → 走 DeepSeek',
  incomplete: '三项缺一 → 走 DeepSeek（半残配置不上生产）',
  forced: '被开关强制切回 DeepSeek',
};
console.log('  reason 含义：' + Object.entries(REASON).map(([k, v]) => k + '=' + v).join(' / '));

const keys = ['RP_ZH_BASE_URL', 'RP_ZH_API_KEY', 'RP_ZH_MODEL', 'RP_ZH_EXTRA_BODY',
  'RP_EN_BASE_URL', 'RP_EN_API_KEY', 'RP_EN_MODEL', 'RP_EN_EXTRA_BODY',
  'RP_PROVIDER', 'RP_ZH_PROVIDER', 'RP_EN_PROVIDER',
  'RP_TIMEOUT_MS', 'RP_MAX_RETRIES', 'RP_STREAM_USAGE'];
console.log('相关环境变量（只显示是否已设置，不显示值）：');
for (const k of keys) {
  const v = process.env[k];
  const shown = v === undefined ? '—' : (k.endsWith('_API_KEY') ? '已设置(' + v.length + ' 字符)' : '已设置');
  console.log('  ' + k.padEnd(22) + shown);
}

const active = s.zh !== 'deepseek(default)' || s.en !== 'deepseek(default)';
console.log('\n结论：' + (active ? '已切换（第三方模型生效中）' : '未切换（剧情链路走 DeepSeek）'));
console.log('切回/恢复：RP_PROVIDER=deepseek 一键切回；RP_ZH_PROVIDER / RP_EN_PROVIDER 按分支；值改 custom 恢复第三方。');
if (active) {
  console.log('提示：并发受托管档位限制——Featherless $25 档 4 个并发单元，27B 模型 concurrency_cost=2，即约 2 路并发。');
}
