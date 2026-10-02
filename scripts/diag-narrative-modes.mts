/**
 * 诊断：成人模式下「经典叙事 / 沉浸叙事」的区别是否被拉平
 *
 * 用法：npx tsx scripts/diag-narrative-modes.mts
 * 输出：对 4 种组合（classic/immersive × 成人开关）打印长度与结构相关的关键行，并做对比。
 */
import fs from 'node:fs';
import { setupTempCwd } from '../test/unit/setup.js';

const PROJECT_ROOT = process.cwd();
setupTempCwd();

const rp: any = await import('../api/services/roleplay.js');
const scenario = rp.getScenario((rp.listScenarios('zh') as any[])[0].id);

function build(style: 'classic' | 'immersive', adult: boolean): string {
  const sys = rp.buildSystemPrompt(scenario, 'zh', undefined, undefined, undefined, style, adult);
  // 注意：必须把 style 传进去，否则两种风格都会拿到同一档（默认 immersive），这正是要诊断的问题
  return sys + (adult ? '\n\n' + rp.buildUnlimitedModeBlock('zh', style) : '');
}

const out: Record<string, string> = {};
for (const style of ['classic', 'immersive'] as const) {
  for (const adult of [false, true]) {
    out[`${style}-${adult ? 'adult' : 'plain'}`] = build(style, adult);
  }
}
fs.mkdirSync(`${PROJECT_ROOT}/temp`, { recursive: true });
for (const [k, v] of Object.entries(out)) {
  fs.writeFileSync(`${PROJECT_ROOT}/temp/prompt-${k}.txt`, v, 'utf8');
}

console.log('\n=== 四种组合的 system 长度 ===');
for (const [k, v] of Object.entries(out)) console.log('  ' + k.padEnd(18) + v.length + ' 字');

const LEN_RE = /[^。；\n]*(字数|简洁|简短|一两句|四句|上限|300|600|展开|动作|日常化|大段落)[^。；\n]*[。；]?/g;

function extract(name: string): string[] {
  const txt = out[name];
  const hits = (txt.match(LEN_RE) || []).map((s) => s.trim()).filter((s) => s.length > 4);
  return [...new Set(hits)];
}

console.log('\n=== 长度/结构相关指令对比 ===');
for (const style of ['classic', 'immersive'] as const) {
  console.log(`\n--- ${style} ---`);
  const plain = extract(`${style}-plain`);
  const adult = extract(`${style}-adult`);
  console.log('  [未开成人模式]');
  plain.forEach((l) => console.log('    · ' + l.slice(0, 78)));
  console.log('  [开启成人模式]');
  adult.forEach((l) => console.log('    · ' + l.slice(0, 78)));
}

console.log('\n=== 关键判据：两种风格在成人模式下的长度指令是否相同 ===');
const c = extract('classic-adult').join('|');
const i = extract('immersive-adult').join('|');
// 成人块是两种风格共用的，所以只要块里带长度目标，就会把两者拉平
const block = rp.buildUnlimitedModeBlock('zh');
const blockHasLen = /300–600 字/.test(block);
console.log('  成人块里是否含统一长度目标(300-600 字)：' + (blockHasLen ? '是 ← 这就是拉平的原因' : '否'));
console.log('  classic+adult 与 immersive+adult 的长度指令是否完全一致：' + (c === i ? '一致（区别被抹平）' : '不同'));
console.log('\n完整提示词已写入 temp/prompt-classic-*.txt / prompt-immersive-*.txt');
