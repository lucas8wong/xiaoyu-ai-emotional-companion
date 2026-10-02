/**
 * 剧情模式系统提示词 · 实时监控
 *
 * 用途：把「模型实际收到的 system prompt」（含成人块、craft 规则、语料库）中英双份打到控制台，
 *       并在**源文件变化时自动重新渲染**，方便边改边看。
 *
 * 用法：
 *   npx tsx scripts/watch-rp-prompt.mts                 # 启动监控（首次全量打印，之后只打变化）
 *   npx tsx scripts/watch-rp-prompt.mts --full          # 每次变化都重新全量打印
 *   npx tsx scripts/watch-rp-prompt.mts --once          # 只打印一次就退出（不监控）
 *   npx tsx scripts/watch-rp-prompt.mts --once --adult=off   # 打印「未开无限制模式」的版本
 *   npx tsx scripts/watch-rp-prompt.mts --parseable     # 只打变体的长度表格（给脚本/monitor 用）
 *
 * 为什么每次变动要另起进程渲染：tsx 不做模块热重载，同进程内改了 roleplay.ts 也不会生效。
 * 另起进程能保证「看到的就是最新代码 + 最新语料」。语料文件本身每次调用都会重读磁盘，
 * 但代码改动必须靠重新加载，所以统一走子进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ESM 里没有 __filename，必须从 import.meta.url 推（.mts 是 ESM，用 __filename 会直接报未定义）
const SELF = fileURLToPath(import.meta.url);

const PROJECT_ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const has = (f: string) => ARGS.includes(f);
const val = (k: string, d: string) => (ARGS.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const FULL = has('--full');
const ONCE = has('--once');
const PARSEABLE = has('--parseable');
const ADULT = val('adult', 'on') !== 'off';
const LANGS = val('langs', 'zh,en').split(',').map((s) => s.trim()).filter(Boolean);

/** 要监控的源：语料库 + 提示词源码 + 环境配置 */
const WATCH = [
  'prompts/adult-lexicon.zh.txt',
  'prompts/adult-lexicon.en.txt',
  'api/services/roleplay.ts',
  '.env',
].map((p) => path.join(PROJECT_ROOT, p));

// 【渲染模式：由子进程执行】
if (ONCE) {
  process.chdir(PROJECT_ROOT);
  const { setupTempCwd } = await import('../test/unit/setup.js');
  setupTempCwd();
  const rp: any = await import('../api/services/roleplay.js');
  const scenario = rp.getScenario((rp.listScenarios(LANGS[0]) as any[])[0].id);

  const rows: string[][] = [];
  for (const lang of LANGS as any[]) {
    const sys = rp.buildSystemPrompt(scenario, lang, undefined, undefined, undefined, 'immersive', ADULT);
    const prompt = sys + (ADULT ? '\n\n' + rp.buildUnlimitedModeBlock(lang, 'immersive') : '');
    rows.push([lang, String(prompt.length), prompt]);
  }

  if (PARSEABLE) {
    console.log('VARIANT\tCHARS\tADULT');
    for (const [lang, len] of rows) console.log(`${lang}\t${len}\t${ADULT ? 'on' : 'off'}`);
    process.exit(0);
  }

  const stamp = new Date().toLocaleTimeString();
  for (const [lang, len, prompt] of rows) {
    console.log('\n' + '='.repeat(78));
    console.log(`  system prompt · lang=${lang} · 无限制模式=${ADULT ? 'ON' : 'OFF'} · ${len} 字符 · ${stamp}`);
    console.log('='.repeat(78));
    console.log(prompt);
  }
  console.log('\n' + '-'.repeat(78));
  for (const [lang, len] of rows) console.log(`  ${lang}: ${len} 字符`);
  process.exit(0);
}

// 【监控模式】
function render(): string {
  return execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), SELF, '--once', `--adult=${ADULT ? 'on' : 'off'}`, `--langs=${LANGS.join(',')}`], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

/** 只保留发生变化的行，每次保存都全量刷 3 万字符没法看 */
function changedLines(prev: string, next: string): string[] {
  const a = prev.split('\n'), b = next.split('\n');
  const setB = new Set(b);
  const setA = new Set(a);
  const out: string[] = [];
  for (const l of b) if (l.trim() && !setA.has(l)) out.push('+ ' + l);
  for (const l of a) if (l.trim() && !setB.has(l)) out.push('- ' + l);
  return out;
}

console.log('👀 剧情提示词监控已启动');
console.log('   监控文件：');
for (const f of WATCH) console.log('     · ' + path.relative(PROJECT_ROOT, f) + (fs.existsSync(f) ? '' : '  (暂不存在)'));
console.log(`   模式：无限制模式=${ADULT ? 'ON' : 'OFF'}  语言=${LANGS.join('/')}  ${FULL ? '每次全量打印' : '变化时只打差异'}`);
console.log('   改文件即自动刷新；Ctrl+C 退出。\n');

let last = '';
function refresh(reason: string) {
  let next = '';
  try {
    next = render();
  } catch (e: any) {
    console.log(`\n⚠️ 渲染失败（${reason}）：` + String(e?.stdout || e?.message || e).slice(0, 400));
    return;
  }
  const stamp = new Date().toLocaleTimeString();
  if (!last) {
    console.log(`\n【初始渲染 ${stamp}】`);
    console.log(next);
  } else if (FULL) {
    console.log(`\n【${stamp} 重新渲染（全量）· ${reason}】`);
    console.log(next);
  } else {
    const diff = changedLines(last, next);
    // 长度表始终打印，方便一眼看出语料/规则有没有变化
    const lens = next.split('\n').filter((l) => /^\s+\w+: \d+ 字符$/.test(l)).join('  ');
    console.log(`\n【${stamp} 检测到改动 · ${reason}】`);
    if (lens) console.log('   ' + lens.trim());
    if (!diff.length) {
      console.log('   （提示词内容无变化，改动可能在注释或未影响提示词的代码里）');
    } else {
      console.log(`   变化行 ${diff.length} 条：`);
      for (const d of diff.slice(0, 60)) console.log('   ' + d);
      if (diff.length > 60) console.log(`   …还有 ${diff.length - 60} 条，用 --full 看全量`);
    }
  }
  last = next;
}

refresh('启动');
if (!ONCE) {
  // 轮询比 fs.watch 可靠：Windows 上编辑器「先删后建」的保存方式会漏事件
  let stamp = WATCH.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)).join(',');
  setInterval(() => {
    const now = WATCH.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)).join(',');
    if (now !== stamp) {
      stamp = now;
      refresh('文件已保存');
    }
  }, 900);
  console.log('\n（监控中…改 prompts/adult-lexicon.zh.txt 或 en.txt 试试）');
}
