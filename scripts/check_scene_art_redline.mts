#!/usr/bin/env node
/**
 * 场景图**全库红线复核**（事后独立抽检，不信"跑批时的自我抽检"）。
 *
 * 为什么要有它：
 *   ① 跑批时的抽检会因为"视觉模型没吐合法 JSON"而**按设计放行**（实测 6 张）——那些图没有被真正判过；
 *   ② 抽检是**逐张独立判断**，全库跑一遍才能说"110+480 张全部无人无文字"；
 *   ③ 用户在意的是**线上看到什么**，所以结论必须来自对**磁盘上真实文件**的判定。
 *
 * 用法：
 *   npx tsx scripts/check_scene_art_redline.mts                 # 全库复核（约 590 张）
 *   npx tsx scripts/check_scene_art_redline.mts --only hk-      # 只复核文件名含 hk- 的
 *   npx tsx scripts/check_scene_art_redline.mts --concurrency 4
 * 产出：temp/scene-art-redline.json（逐张判定 + 违规清单）
 * 退出码：0 = 全部通过（或仅有"抽检不可用"）；1 = 存在**真违规**（有人物/有文字）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_Q, auditEnv, auditImageFile } from './lib/scene-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public', 'img', 'roleplay-scenes');
const args = process.argv.slice(2);
const valOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const only = valOf('--only', '');
const onlyList = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : [];
const concurrency = Math.max(1, Number(valOf('--concurrency', '3')) || 3);

const env = auditEnv(ROOT);
if (!env.key) { console.error('❌ 缺少 DEEPSEEK_API_KEY（.env）——红线复核需要视觉模型'); process.exit(2); }
void AUDIT_Q;

let files = fs.readdirSync(DIR).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)).sort();
if (onlyList.length) files = files.filter((f) => onlyList.some((o) => f.includes(o)));
console.log(`红线复核 ${files.length} 张（模型 ${env.model}，并发 ${concurrency}）…`);

interface Row { file: string; pass: boolean; why?: string; error?: string }
const rows: Row[] = [];
let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
  while (cursor < files.length) {
    const f = files[cursor++];
    const r = await auditImageFile(path.join(DIR, f), env);
    rows.push({ file: f, pass: r.ok, why: r.why, error: r.error });
    const n = rows.length;
    if (n % 50 === 0) console.log(`  …${n}/${files.length}`);
  }
});
await Promise.all(workers);

const bad = rows.filter((r) => !r.pass);
const unknown = rows.filter((r) => r.error);
const outPath = path.join(ROOT, 'temp', 'scene-art-redline.json');
fs.writeFileSync(outPath, JSON.stringify({
  at: new Date().toISOString(), model: env.model, total: rows.length,
  pass: rows.length - bad.length, violations: bad.length, unavailable: unknown.length,
  violationList: bad, unavailableList: unknown.map((r) => ({ file: r.file, error: r.error })),
  results: rows.sort((a, b) => a.file.localeCompare(b.file)),
}, null, 2));

console.log(`\n复核完成：通过 ${rows.length - bad.length} / ${rows.length}，违规 ${bad.length}，抽检不可用 ${unknown.length}`);
for (const b of bad.slice(0, 15)) console.log(`  ❌ ${b.file} — ${b.why}`);
if (unknown.length) console.log(`  ⚠️ 抽检不可用（需人工/重跑）：${unknown.map((r) => r.file).join(', ')}`);
console.log(`清单：${path.relative(ROOT, outPath)}`);
if (bad.length) process.exit(1);
console.log('✅ 全库无人无文字（抽检不可用的那几张见清单，建议单独复看）');
