/**
 * 跨托管可用性矩阵：UGI 榜候选模型在哪家 API 真能调到
 *
 * 数据来源（均为公开目录，无需 key）：
 *   - OpenRouter: https://openrouter.ai/api/v1/models   -> temp/or.json
 *   - Chutes:     https://llm.chutes.ai/v1/models       -> temp/ch.json
 *   - NanoGPT:    https://nano-gpt.com/api/models       -> temp/ng.json
 *   - Featherless: 无公开目录接口，改用模型页存在性探测（本脚本只读已存结果）
 *
 * 用法：node scripts/check-model-availability.mjs
 */
import fs from 'node:fs';

/** 候选（来自 UGI 榜单筛选）：key = 展示名，value = 匹配词（大小写不敏感） */
const CANDIDATES = [
  ['Delta-Vector/MS3.2-Austral-Winton', 'austral-winton'],
  ['OddTheGreat/Rotor_24B_V.1', 'rotor_24b'],
  ['Ateron/Sketch-Cydonia', 'sketch-cydonia'],
  ['coder3101/Cydonia-24B-v4.3-heretic', 'cydonia-24b-v4.3'],
  ['OddTheGreat/Core_24B_V.1', 'core_24b'],
  ['TheDrummer/UnslopSmall-22B-v1', 'unslopsmall'],
  ['TheDrummer/Behemoth-X-123B-v2', 'behemoth-x-123b'],
  ['BruhzWater/Sapphira-L3.3-70b-0.1', 'sapphira'],
  ['Steelskull/L3.3-Shakudo-70b', 'shakudo'],
  ['TareksGraveyard/Stylizer-V2-LLaMa-70B', 'stylizer'],
  ['KaraKaraWitch/GoldDiamondGold-L33-70b', 'golddiamondgold'],
  ['Bobi099/Qwen3.5-27B-heretic', 'qwen3.5-27b-heretic'],
  ['MuXodious/Qwen3.5-27B-tainted-heresy', 'tainted-heresy'],
  ['Sao10K/L3.1-70B-Hanami-x1', 'hanami'],
  ['TheDrummer/Cydonia-22B-v1', 'cydonia-22b'],
  ['Infermatic/L3-70B-Euryale-v2.1', 'euryale'],
  ['TheDrummer/UnslopNemo-12B', 'unslopnemo'],
  ['ReadyArt/Forgotten-Safeword-24B', 'forgotten-safeword'],
  ['LatitudeGames/Harbinger-24B', 'harbinger'],
  ['anthracite-org/magnum-v4-72b', 'magnum-v4'],
  ['TheDrummer/Rocinante-12B', 'rocinante'],
];

/** Featherless 用的是模型页 HEAD 探测结果（api 无公开目录） */
const FEATHERLESS = {
  'austral-winton': true, rotor_24b: true, 'sketch-cydonia': true, 'cydonia-24b-v4.3': true,
  core_24b: true, unslopsmall: false, 'behemoth-x-123b': false, sapphira: true,
  shakudo: true, stylizer: true, golddiamondgold: true, 'qwen3.5-27b-heretic': true,
  'tainted-heresy': true, hanami: true, 'cydonia-22b': false, euryale: true,
  unslopnemo: true, 'forgotten-safeword': true, harbinger: true,
};

function loadIds(file, pick) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pick(j).map((x) => String(x).toLowerCase());
  } catch {
    return null;
  }
}

const hosts = [
  ['OpenRouter', loadIds('temp/or.json', (j) => j.data.map((m) => m.id))],
  ['Chutes', loadIds('temp/chutes.json', (j) => j.data.map((m) => m.id))],
  ['NanoGPT', loadIds('temp/ng.json', (j) => Object.keys(j.models?.text || {}))],
];

console.log('候选模型跨托管可用性（公开目录实查；✗ = 该托管未收录，不代表不能自托管）\n');
console.log('model'.padEnd(40) + hosts.map(([n]) => n.padStart(12)).join('') + 'Featherless'.padStart(13));
console.log('-'.repeat(40 + 12 * hosts.length + 13));

const tally = {};
for (const [name, kw] of CANDIDATES) {
  let line = name.slice(0, 39).padEnd(40);
  for (const [hn, ids] of hosts) {
    const hit = ids ? ids.some((i) => i.includes(kw)) : null;
    if (hit) tally[hn] = (tally[hn] || 0) + 1;
    line += (ids === null ? '?' : hit ? '✓' : '✗').padStart(12);
  }
  const f = FEATHERLESS[kw];
  if (f) tally.Featherless = (tally.Featherless || 0) + 1;
  line += (f === undefined ? '?' : f ? '✓' : '✗').padStart(13);
  console.log(line);
}

console.log('\n命中数：' + Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '));
console.log('注：NanoGPT/Chutes 目录里含大量非 RP 模型，本表只查上表候选。');
