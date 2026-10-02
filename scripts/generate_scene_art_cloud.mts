#!/usr/bin/env node
/**
 * 剧情场景配图，**云 API 批量生成**（替代本机 SDXL 跑批 `generate_scene_art.py`）
 *
 * 为什么换云：本机只有一张 16GB 卡，跑批要与 VoxCPM TTS 侧车互斥（显存闸 ≥11.5GB 才敢跑），
 * 且 SDXL 画不准机构性道具。云 API 不看显存、几分钟跑完、语义遵循度更高。
 *
 * 生成三层（**单一事实来源仍是 `src/lib/storyScene.ts`**，经 `export-scene-config.mts` 导出）：
 *   --pool     共享主题池   5 世界观 × 16 主题 =  80 张（`{worldview}-{theme}.webp`）
 *   --masters  主场景图     每部内置剧本 1 张  =  30 张（`{scenarioId}-master.webp`）
 *   --own      剧本专属图   每部剧本 × 每一幕  = 480 张（`{scenarioId}-{theme}.webp`）← C 方案
 *
 * 用法：
 *   npx tsx scripts/export-scene-config.mts                       # 先导出配置（单一真源）
 *   npx tsx scripts/generate_scene_art_cloud.mts --all --dry-run   # 只出清单 + 估价，不发请求
 *   npx tsx scripts/generate_scene_art_cloud.mts --all --limit 2   # 小样验链路（发请求）
 *   npx tsx scripts/generate_scene_art_cloud.mts --all --audit     # 全量 + 红线抽检（不合格换 seed 重出）
 *
 * 🔴 红线：prompt 只来自 `temp/scene-config.json`（由白名单表拼出），**用户文本永不进 prompt**；
 *    出图后可选 `--audit` 用视觉模型判"有没有人物/文字"，不合格换 seed 重出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  generateImage, resolveProviderId, providerReady, providerModel, providerModels, providerApiKey, rotateProviderModel,
  IMAGE_PROVIDERS, estimateCostYuan, stableSeed, sizeString, webpTool, DEFAULT_SCENE_SIZE,
} from '../api/services/imageApi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

interface Row { group: 'pool' | 'masters' | 'own'; key: string; file: string; prompt: string; negative: string; worldview?: string; theme?: string; safePrompt?: string }

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valOf = (f: string, d = '') => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
/** 取 `--flag a b c` 形态的多个值（`--only` 用） */
const multiVal = (flag: string): string[] => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};

if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const cfgPath = path.resolve(ROOT, valOf('--config', 'temp/scene-config.json'));
if (!fs.existsSync(cfgPath)) {
  console.error(`❌ 缺少配置 ${cfgPath}（先跑：npx tsx scripts/export-scene-config.mts）`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
  matrix: Array<{ worldview: string; theme: string; file: string; prompt: string; negative: string }>;
  masters: Array<{ scenarioId: string; file: string; prompt: string; negative: string; worldview: string; safePrompt?: string }>;
  ownThemes?: Array<{ scenarioId: string; theme: string; file: string; prompt: string; negative: string; worldview: string; safePrompt?: string }>;
};

const outDir = path.resolve(ROOT, valOf('--out-dir', 'public/img/roleplay-scenes'));
const only = multiVal('--only');
const limit = Number(valOf('--limit', '0')) || 0;
const concurrency = Math.max(1, Number(valOf('--concurrency', '1')) || 1);
/**
 * 每次提交之间的间隔。⚠️ 实测（2026-09-14）：并发 3 时百炼**第 1 张就 429**（`Throttling.RateQuota`），
 * 561 张全废。低配额档 QPS 很低 → 默认串行 + 间隔，宁可慢也不要成片失败。
 */
const delayMs = Math.max(0, Number(valOf('--delay-ms', '1200')) || 0);
const auditRetries = Math.max(0, Number(valOf('--audit-retries', '3')) || 3);
const isDry = has('--dry-run');
const skipExisting = has('--skip-existing') || isDry;

// 【选层】
const all = has('--all') || (!has('--pool') && !has('--masters') && !has('--own'));
const rows: Row[] = [];
if (has('--pool') || all) for (const r of cfg.matrix || []) rows.push({ group: 'pool', key: `${r.worldview}-${r.theme}`, file: r.file, prompt: r.prompt, negative: r.negative, worldview: r.worldview, theme: r.theme });
if (has('--masters') || all) for (const r of cfg.masters || []) rows.push({ group: 'masters', key: `${r.scenarioId}-master`, file: r.file, prompt: r.prompt, negative: r.negative, worldview: r.worldview, safePrompt: r.safePrompt });
if (has('--own') || all) for (const r of cfg.ownThemes || []) rows.push({ group: 'own', key: `${r.scenarioId}-${r.theme}`, file: r.file, prompt: r.prompt, negative: r.negative, worldview: r.worldview, theme: r.theme, safePrompt: r.safePrompt });

let queue = rows;
if (only.length) queue = queue.filter((r) => only.some((o) => r.key.includes(o)));
if (limit > 0) queue = queue.slice(0, limit);

const provider = resolveProviderId();
const caps = IMAGE_PROVIDERS[provider];
const size = { width: DEFAULT_SCENE_SIZE.width, height: DEFAULT_SCENE_SIZE.height };
const est = estimateCostYuan(provider, queue.length);

console.log(`出图后端：${caps.label}（${provider}）  key=${providerReady(provider) ? '已配置' : '❌ 未配置'}  model=${providerModels(provider).join(' → ')}`);
console.log(`负向词：${caps.negative ? '✅ 支持（复用 SCENE_NEGATIVE_PROMPT）' : '❌ 不支持 → 自动加正向守卫词'}   尺寸：${sizeString(provider, size.width, size.height)}`);
console.log(`webp 转码器：${webpTool()}   输出目录：${outDir}`);
console.log(`本次待出：${queue.length} 张（pool ${queue.filter(r => r.group === 'pool').length} / masters ${queue.filter(r => r.group === 'masters').length} / own ${queue.filter(r => r.group === 'own').length}）  估价 ≈ ¥${est}`);

if (isDry) {
  // 干跑：把"将要发给模型的完整清单"落盘，可人工逐条审 prompt（红线"用户文本不进 prompt"的可审计证据）
  const planPath = path.join(ROOT, 'temp', 'scene-art-cloud-plan.json');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify({
    generatedAt: new Date().toISOString(), provider, model: providerModel(provider),
    size: sizeString(provider, size.width, size.height), count: queue.length, estCostYuan: est,
    items: queue.map((r) => ({ ...r, seed: stableSeed(r.key) })),
  }, null, 2));
  console.log(`\n🅳 dry-run：清单已写 ${path.relative(ROOT, planPath)}（${queue.length} 条，含 prompt/negative/seed）`);
  console.log(queue.slice(0, 3).map((r) => `  · ${r.file}\n      ${r.prompt}`).join('\n'));
  process.exit(0);
}

if (!providerReady(provider)) {
  console.error(`❌ ${caps.label} 未配置 API Key。在 .env 里加一个（wanx: DASHSCOPE_API_KEY / seedream: ARK_API_KEY / cogview: ZHIPU_API_KEY / openai: OPENAI_API_KEY），`);
  console.error('   或先 `--dry-run` 出清单核对 prompt。文档见 docs/scene-art-cloud-plan.md');
  process.exit(2);
}

// 【红线抽检（复用 generate_scene_art.py 的判定口径）】
const AUDIT_Q = '这是一张场景插画。请只输出一个JSON对象（不要其他文字）：'
  + '{"has_person":true|false,"has_text":true|false,"description":"一句话"}。'
  + 'has_person 包含人物、剪影、远景行人、镜中人、雕像分辨不清的人形；has_text 包含任何可辨认的文字/字母/招牌/水印。';

async function audit(bytes: Buffer, ext: string): Promise<{ ok: boolean; why?: string; error?: string }> {
  const key = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return { ok: true, error: 'no api key' };
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'image/webp';
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: AUDIT_Q },
          { type: 'image_url', image_url: { url: `data:${mime};base64,` + bytes.toString('base64') } },
        ] }],
        max_tokens: 2000,
      }),
    });
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, error: 'no json' };
    const o = JSON.parse(m[0]) as { has_person?: boolean; has_text?: boolean; description?: string };
    const bad = o.has_person === true || o.has_text === true;
    return { ok: !bad, why: bad ? `${o.has_person ? '有人物' : ''}${o.has_text ? (o.has_person ? ' + ' : '') + '有文字' : ''}：${o.description || ''}` : undefined };
  } catch (e) {
    return { ok: true, error: (e as Error).message }; // 抽检失败不阻塞出图，如实记录
  }
}

// 【主流程】
interface ManifestItem { file: string; group: string; provider: string; seed: number; seconds?: number; bytes?: number; ext?: string; audit?: string; error?: string; prompt: string; promptStage?: string; attempts?: number; billed?: number }

/** 账号级错误（免费额度用尽/余额不足/Key 失效）一旦出现就**全批中止**，不再继续撞墙 */
let abortReason: string | null = null;

/**
 * 阶梯式重试：**先换 seed**（同样的 prompt 换一版），**仍不合格就退到"纯主题"兜底 prompt**。
 *
 * 为什么要退一步：实测（2026-09-14）万相会把霓虹招牌上的字真画出来，8/8 张被抽检拒，
 * 而 `deTextTriggers` 只能清掉"词面"上的霓虹。某些剧本的空间描述里"街景/门面"这类对象类
 * 仍会稳定带出招牌 → 与其反复换 seed 抽奖（项目自己的纪律：不靠抽奖），不如退到按设计
 * 不含招牌的**主题层**，把这一张图救回来。
 */
async function runOne(row: Row): Promise<ManifestItem> {
  const target = path.join(outDir, row.file.replace(/\.webp$/, ''));
  const baseSeed = stableSeed(row.key);
  const item: ManifestItem = { file: row.file, group: row.group, provider, seed: baseSeed, prompt: row.prompt, attempts: 0 };
  if (skipExisting && ['webp', 'png', 'jpg'].some((e) => fs.existsSync(`${target}.${e}`))) {
    item.audit = 'skipped(exists)';
    return item;
  }
  const stages: Array<{ name: string; prompt: string }> = [{ name: 'scene', prompt: row.prompt }];
  if (row.safePrompt && row.safePrompt !== row.prompt) stages.push({ name: 'theme-fallback', prompt: row.safePrompt });

  for (const [si, stage] of stages.entries()) {
    for (let attempt = 0; attempt <= auditRetries; attempt++) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const seed = baseSeed + si * 100 + attempt;
      const r = await generateImage(
        { prompt: stage.prompt, negative: row.negative, width: size.width, height: size.height, seed, theme: row.theme, worldview: row.worldview },
        { provider },
      );
      item.attempts = (item.attempts || 0) + 1;
      if (!r.ok || !r.bytes) {
        item.error = `${r.code}: ${r.message}`; item.seed = seed;
        // ① 账号级"额度用尽" → 先尝试**自动切候选链里的下一个模型**（免费额度按模型分开算！）
        if (r.fatal && r.code === 'QUOTA' && rotateProviderModel(provider)) {
          console.log(`  🔄 模型额度用尽 → 自动切换：${providerModel(provider)}（继续跑，不中止）`);
          attempt--; // 用新模型重试同一张、同一轮（切换次数受候选链长度限制，不会死循环）
          continue;
        }
        // ② 候选链也用完了 → 立刻中止整批（实测教训：不中止的话剩下几百张会各撞一次）
        if (r.fatal) {
          abortReason = r.message || String(r.code);
          return item;
        }
        return item;
      }
      item.billed = (item.billed || 0) + 1; // 只有真正出图的请求才计费（429/403 不计费）
      if (has('--audit')) {
        const a = await audit(r.bytes, r.ext || 'webp');
        if (a.error) item.audit = `unavailable(${a.error})`;
        else if (!a.ok) {
          item.audit = `rejected#${stage.name}${attempt}(${a.why})`;
          console.log(`  ⚠️ 红线抽检不合格（${stage.name}），换 seed 重出：${row.file} — ${a.why}`);
          continue; // 换 seed 重出；本阶段用尽后自动进下一阶段
        } else item.audit = 'pass';
      }
      // 先写临时文件再原子改名：中途失败不会留下半张图（也就不会让上层误判"已有缓存"）
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = `${target}.${r.ext}.tmp`;
      fs.writeFileSync(tmp, r.bytes);
      fs.renameSync(tmp, `${target}.${r.ext}`);
      item.seed = seed; item.seconds = r.seconds; item.bytes = r.bytes.length; item.ext = r.ext;
      item.promptStage = stage.name;
      item.prompt = stage.prompt;
      return item;
    }
  }
  item.error = `红线抽检在「场景 + 主题兜底」两阶段均不合格（已放弃，保留旧图）`;
  return item;
}

async function main() {
  const started = Date.now();
  const results: ManifestItem[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length && !abortReason) {
      const row = queue[cursor++];
      const item = await runOne(row);
      results.push(item);
      const kb = item.bytes ? Math.round(item.bytes / 1024) + 'KB' : '-';
      console.log(`  [${results.length}/${queue.length}] ${item.error ? '❌' : '✅'} ${row.file} ${item.seconds ? item.seconds + 's ' : ''}${kb} ${item.audit && item.audit !== 'pass' ? item.audit : ''} ${item.error || ''}`);
    }
  });
  await Promise.all(workers);

  const okN = results.filter((r) => !r.error && r.audit !== 'skipped(exists)').length;
  const skipN = results.filter((r) => r.audit === 'skipped(exists)').length;
  const failN = results.filter((r) => r.error).length;
  const bytes = results.reduce((s, r) => s + (r.bytes || 0), 0);
  // 成本按**真正出图的请求数**算：429/403 不计费，但"抽检不合格后重出"是计费的
  const attempts = results.reduce((s, r) => s + (r.attempts || 0), 0);
  const billed = results.reduce((s, r) => s + (r.billed || 0), 0);
  const fellBack = results.filter((r) => r.promptStage === 'theme-fallback').length;
  const manifestPath = path.join(outDir, 'manifest-cloud.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(), provider, model: providerModel(provider), keyPresent: !!providerApiKey(provider),
    size: sizeString(provider, size.width, size.height), audit: has('--audit'), aborted: abortReason,
    totals: { generated: okN, skipped: skipN, failed: failN, attempts, billed, fellBackToTheme: fellBack, bytes, estCostYuan: estimateCostYuan(provider, billed) },
    items: results,
  }, null, 2));

  console.log(`\n完成：新出 ${okN} / 跳过 ${skipN} / 失败 ${failN}，合计 ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  console.log(`请求 ${attempts} 次、其中计费出图 ${billed} 次，退到「纯主题」兜底 ${fellBack} 张`);
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(0)}s，估算成本 ≈ ¥${estimateCostYuan(provider, billed)}（只算真正出图的请求；本脚本**不知道免费额度**，若走免费池则实付 ¥0，以厂商控制台账单为准）`);
  console.log(`清单：${path.relative(ROOT, manifestPath)}`);
  if (abortReason) {
    console.error('\n🛑 已中止整批，账号级错误（重试无意义）：');
    console.error('   ' + abortReason);
    console.error('   去控制台处理后再续跑（已成功的会被 --skip-existing 跳过，不重复花钱）：');
    console.error('     · 关闭「仅使用免费额度」或充值：https://bailian.console.aliyun.com/  （费用与配额）');
    console.error('     · 然后：npx tsx scripts/generate_scene_art_cloud.mts --all --audit --skip-existing');
    process.exit(2);
  }
  if (failN) console.log('⚠️ 有失败项：修好后加 --skip-existing 续跑（已成功的不会重出、不重复花钱）');
}

main().catch((e) => { console.error(e); process.exit(1); });
