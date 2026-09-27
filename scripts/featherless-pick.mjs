/**
 * Featherless 选型详查：按「中英文双适配 + 上下文 + 并发成本」筛
 *
 * 数据源：https://api.featherless.ai/v1/models（公开，无需 key）
 *   每条含 id / context_length / concurrency_cost / is_gated / pricing
 *
 * 三个硬指标（本项目特有）：
 *  1. context_length ≥ 32768 —— 自建剧本最坏情况 ≈3.7K token + 多轮 history
 *  2. concurrency_cost —— $25 Chat 档只有 **4 个并发单元**；cost=4 的模型一个请求就吃光并发
 *  3. 底座要中文强 —— UGI 是纯英文基准，中文只能靠底座判断（Qwen/GLM/Yi/InternLM/Hunyuan/MiniMax）
 *
 * 用法：node scripts/featherless-pick.mjs
 */
import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync('temp/fl.json', 'utf8'));
const list = raw.data || raw.models || [];

/** 去限制标记（社区微调命名惯例） */
const UNCENSORED = ['heretic', 'abliterat', 'derestricted', 'uncensored', 'unbound', 'tainted', 'heresy', 'nsfw', 'dolphin', 'unslop'];
/** 中文能力底座 */
const ZH_BASE = ['qwen', 'glm', 'yi-', 'deepseek', 'internlm', 'hunyuan', 'minimax', 'baichuan', 'ernie', 'step-'];
/** 已知 RP 社区作者/家族（英文分支） */
const RP_FAMILY = ['cydonia', 'magnum', 'rocinante', 'euryale', 'hanami', 'sapphira', 'shakudo', 'behemoth', 'stylizer', 'winton', 'unslopsmall', 'sketch', 'rotor', 'core_24b', 'harbinger', 'shining', 'fimbul', 'mytho', 'psyfighter'];

const has = (s, arr) => arr.some((k) => s.includes(k));
const MIN_CTX = 32768;

const CAND_WATCH = [
  'Bobi099/Qwen3.5-27B-heretic',
  'MuXodious/Qwen3.5-27B-tainted-heresy',
  'huihui-ai/Huihui-Qwen3.5-27B-abliterated',
  'Delta-Vector/MS3.2-Austral-Winton',
  'OddTheGreat/Rotor_24B_V.1',
  'Ateron/Sketch-Cydonia',
  'coder3101/Cydonia-24B-v4.3-heretic',
  'OddTheGreat/Core_24B_V.1',
  'BruhzWater/Sapphira-L3.3-70b-0.1',
  'Steelskull/L3.3-Shakudo-70b',
  'TareksGraveyard/Stylizer-V2-LLaMa-70B',
  'KaraKaraWitch/GoldDiamondGold-L33-70b',
  'Sao10K/L3.1-70B-Hanami-x1',
  'Infermatic/L3-70B-Euryale-v2.1-fp8-dynamic',
  'TheDrummer/UnslopNemo-12B-v4',
];

function fmt(m) {
  return (
    m.id.padEnd(52) +
    String(m.context_length ?? '?').padStart(9) +
    String(m.concurrency_cost ?? '?').padStart(7) +
    (m.is_gated ? '  gated' : '')
  );
}

console.log('Featherless 目录：' + list.length + ' 个模型\n');
console.log('id'.padEnd(52) + 'context'.padStart(9) + 'conc'.padStart(7));

// A. 点名候选详查
console.log('\n=== A. 点名候选详查（context / concurrency_cost）===');
for (const want of CAND_WATCH) {
  const hit = list.find((m) => m.id === want) || list.find((m) => m.id.toLowerCase() === want.toLowerCase());
  console.log(hit ? fmt(hit) : want.padEnd(52) + '  —— 目录中未找到');
}

// B. 中文底座 × 去限制
console.log('\n=== B. 中文底座 × 去限制（中英文双适配的主战场），仅列 context ≥ ' + MIN_CTX + ' ===');
const zhUnc = list
  .filter((m) => has(m.id.toLowerCase(), ZH_BASE) && has(m.id.toLowerCase(), UNCENSORED) && (m.context_length || 0) >= MIN_CTX)
  .sort((a, b) => (a.concurrency_cost - b.concurrency_cost) || (b.context_length - a.context_length));
console.log('命中 ' + zhUnc.length + ' 个（前 25）：');
zhUnc.slice(0, 25).forEach((m) => console.log(fmt(m)));

// C. Qwen3.5 系（最新一代）所有去限制变体
console.log('\n=== C. Qwen3.5 系去限制变体（不分上下文，看全貌）===');
list
  .filter((m) => m.id.toLowerCase().includes('qwen3.5') && has(m.id.toLowerCase(), UNCENSORED))
  .sort((a, b) => b.context_length - a.context_length)
  .slice(0, 30)
  .forEach((m) => console.log(fmt(m)));

// D. 英文 RP 家族
console.log('\n=== D. 英文 RP 社区家族（UGI 短名单同族），context ≥ ' + MIN_CTX + ' ===');
list
  .filter((m) => has(m.id.toLowerCase(), RP_FAMILY) && (m.context_length || 0) >= MIN_CTX)
  .sort((a, b) => (a.concurrency_cost - b.concurrency_cost) || (b.context_length - a.context_length))
  .slice(0, 30)
  .forEach((m) => console.log(fmt(m)));

// E. 并发成本分布说明
const costHist = {};
for (const m of list) costHist[m.concurrency_cost] = (costHist[m.concurrency_cost] || 0) + 1;
console.log('\n=== E. concurrency_cost 分布 ===');
console.log(Object.entries(costHist).sort((a, b) => a[0] - b[0]).map(([k, v]) => 'cost=' + k + ':' + v).join('  '));
console.log('提示：$25 Chat 档含 4 个并发单元 → 优先选 cost ≤ 2 的模型，否则一两个用户就打满。');
