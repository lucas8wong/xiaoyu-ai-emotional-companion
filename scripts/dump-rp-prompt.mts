/**
 * 导出剧情链路**实际发给模型的 system prompt**（原样，未经改写）
 *
 * 做法：stub 掉 globalThis.fetch 拦截真实请求体，调用生产代码 roleplayReply()，
 * 因此拿到的是模型真正收到的那份提示词（含规则块、边界句、无限制模式块、任务指令）。
 *
 * 用法：npx tsx scripts/dump-rp-prompt.mts [scenarioId]
 * 输出：temp/prompt-<lang>-<off|on>.txt 并在终端打印中文两版
 */
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from '../test/unit/setup.js';

const PROJECT_ROOT = process.cwd();
setupTempCwd();

for (const p of ['RP_ZH', 'RP_EN']) {
  process.env[p + '_BASE_URL'] = 'http://127.0.0.1:9/v1';
  process.env[p + '_API_KEY'] = 'stub';
  process.env[p + '_MODEL'] = 'stub/model';
}
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.DEEPSEEK_API_KEY = 'stub';

const rp: any = await import('../api/services/roleplay.js');

const scenarioId = process.argv[2] || (rp.listScenarios('zh') as any[])[0].id;
const scenario = rp.getScenario(scenarioId);
if (!scenario) { console.error('取不到剧本 ' + scenarioId); process.exit(1); }

let captured: any[] | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init: any) => {
  captured = JSON.parse(init.body).messages;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '（stub 回复）' } }], usage: {} }),
    text: async () => '',
  } as any;
}) as any;

const outDir = path.join(PROJECT_ROOT, 'temp');
fs.mkdirSync(outDir, { recursive: true });

async function dump(lang: string, unlimited: boolean) {
  captured = null;
  await rp.roleplayReply(scenario, [{ role: 'user', content: '（探针）我推门进来。' }], { lang, unlimited });
  const sys = String(captured?.[0]?.content || '');
  const file = path.join(outDir, `prompt-${lang}-${unlimited ? 'on' : 'off'}.txt`);
  fs.writeFileSync(file, sys, 'utf8');
  return { sys, file };
}

const zhOff = await dump('zh', false);
const zhOn = await dump('zh', true);
const enOff = await dump('en', false);
const enOn = await dump('en', true);
globalThis.fetch = realFetch;

console.log(`剧本: ${scenarioId}\n`);
for (const [n, d] of [['zh off', zhOff], ['zh on', zhOn], ['en off', enOff], ['en on', enOn]] as const) {
  console.log(`${n.padEnd(8)} ${String(d.sys.length).padStart(5)} 字  → ${path.relative(PROJECT_ROOT, d.file)}`);
}

// 【规则块是从哪一段开始的，便于对照阅读】
const MARK = { zh: '【写作与交互要求】', en: '[Writing & interaction rules]' };
for (const [lang, d] of [['zh', zhOn], ['en', enOn]] as const) {
  const i = d.sys.indexOf(MARK[lang as 'zh' | 'en']);
  console.log(`\n=== ${lang} 提示词结构（on 版）===`);
  console.log(`  内容块（角色卡+背景+开场）: 0 ~ ${i} 字`);
  console.log(`  规则块+边界句+无限制块+任务指令: ${i} ~ ${d.sys.length} 字`);
}

// 【无限制模式块的原文（这是你要改的那一段）】
console.log('\n' + '='.repeat(70));
console.log('【无限制模式块 · 中文原文】');
console.log('='.repeat(70));
console.log(rp.buildUnlimitedModeBlock('zh'));
console.log('\n' + '='.repeat(70));
console.log('【无限制模式块 · 英文原文】');
console.log('='.repeat(70));
console.log(rp.buildUnlimitedModeBlock('en'));
console.log('\n完整提示词已写入 temp/prompt-zh-off.txt / prompt-zh-on.txt / prompt-en-off.txt / prompt-en-on.txt');
