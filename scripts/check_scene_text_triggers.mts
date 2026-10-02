#!/usr/bin/env node
/**
 * 出图前体检：`temp/scene-config.json` 里还有没有「会带出文字的对象类」（neon/sign/billboard/skyline…）。
 *
 * 为什么单独立一个门禁：2026-09-14 云化实测，万相真会把霓虹招牌上的字画出来
 * （"霓虹招牌 'NICGHIT CLUB'"），2 张 × 4 轮换 seed **8/8 被红线抽检拒**。
 * 负向词只写 `text/letters/signage` **挡不住**，必须从 prompt 源头去掉这类对象。
 * 项目纪律原文（`src/lib/storyScene.ts`）：**"从源头去掉会违规的对象类，而不是靠换 seed 抽奖"**。
 *
 * 用法（改过 `src/lib/storyScene.ts` 或场景规格后跑）：
 *   npx tsx scripts/export-scene-config.mts && npx tsx scripts/check_scene_text_triggers.mts
 * 退出码：0 = 干净；1 = 有残留（打印是哪一层、哪一条）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTextTrigger, SCENE_NEGATIVE_PROMPT } from '../src/lib/storyScene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.resolve(ROOT, process.argv[2] || 'temp/scene-config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`❌ 缺少配置 ${cfgPath}（先跑：npx tsx scripts/export-scene-config.mts）`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
  matrix: Array<{ file: string; prompt: string }>;
  masters: Array<{ file: string; prompt: string }>;
  ownThemes?: Array<{ file: string; prompt: string; safePrompt?: string }>;
};

const layers: Array<[string, Array<{ file: string; prompt: string }>]> = [
  ['主题池(pool)', cfg.matrix || []],
  ['主场景图(masters)', cfg.masters || []],
  ['专属图(own：剧本场景)', (cfg.ownThemes || []).map(r => ({ file: r.file, prompt: r.prompt }))],
  ['专属图(own：纯主题兜底)', (cfg.ownThemes || []).filter(r => r.safePrompt).map(r => ({ file: r.file, prompt: r.safePrompt! }))],
];

// 负向词本身必须点名这些对象类（只靠 text/letters 实测无效）
const NEG_REQUIRED = ['text', 'signage', 'neon sign', 'neon letters', 'shop sign', 'street sign', 'billboard', 'chinese characters', 'kanji'];
const negMissing = NEG_REQUIRED.filter(t => !SCENE_NEGATIVE_PROMPT.includes(t));

let bad = 0;
for (const [name, rows] of layers) {
  const hits = rows.filter(r => hasTextTrigger(r.prompt));
  console.log(`${hits.length === 0 ? '✅' : '❌'} ${name}: ${hits.length} / ${rows.length} 条含文字触发词`);
  for (const h of hits.slice(0, 5)) {
    bad++;
    console.log(`     · ${h.file}\n       ${h.prompt.slice(0, 160)}`);
  }
  if (hits.length > 5) console.log(`     …另有 ${hits.length - 5} 条`);
}

console.log(`${negMissing.length === 0 ? '✅' : '❌'} 负向词点名了关键对象类${negMissing.length ? '（缺：' + negMissing.join(', ') + '）' : ''}`);

const total = layers.reduce((s, [, rows]) => s + rows.filter(r => hasTextTrigger(r.prompt)).length, 0);
if (total > 0 || negMissing.length > 0) {
  console.error(`\n❌ 体检未通过：${total} 条 prompt 含文字触发词。修 \`src/lib/storyScene.ts\` 的 SCENE_TEXT_TRIGGERS / 世界观基调，或对应剧本的场景规格，然后重跑 export + 本脚本。`);
  process.exit(1);
}
console.log('\n✅ 体检通过：所有层的 prompt 都不含「会带出文字的对象类」。');
