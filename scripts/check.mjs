/**
 * 类型门禁（2026-09-17 立；2026-09-28 收紧为「零豁免」）
 *
 * 历史：`npm run check` 曾长期红着 —— 诊断全部来自上游移植子系统 `src/wolfcha`，而
 * `tsconfig.json` 的 exclude 救不了它（第一方文件 import 了 wolfcha，就会被拉进同一个 program）。
 * 2026-09-17 的办法是把诊断分成「第一方 / 上游」两组、只让第一方决定退出码，先让门禁可用。
 *
 * 代价（2026-09-28 全仓审查证实）：`src/wolfcha` 被整体豁免 → 真实缺陷藏在里面。
 * 本轮就在那 19 条「既有基线」中挖出一条用户可见的 bug（编辑自定义角色静默无效的 arity 不匹配）。
 *
 * 现在：那 19 条已逐条修完，**豁免名单为空**；只要 tsc 报出一条诊断就失败。
 * 以后若引入新的上游/第三方代码，请把它修干净，不要再开豁免口子——
 * 「永远红着、或者永远被豁免」的门禁，等于没有门禁。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// 直接跑 typescript 的 JS 入口（`node node_modules/typescript/bin/tsc`）：跨平台最稳。
// ⚠️ 不能用 `node_modules/.bin/tsc.cmd` + spawnSync（Node 18+ 在 Windows 上会 EINVAL，
//    而且**静默返回空输出** —— 那会让门禁假装全绿，比没有门禁更危险）；
//    也不能用 `npx + shell:true`（DEP0190 告警会盖住真正的诊断）。
const tscJs = path.resolve('node_modules', 'typescript', 'bin', 'tsc');
let run;
if (fs.existsSync(tscJs)) {
  run = spawnSync(process.execPath, [tscJs, '--noEmit'], { encoding: 'utf8' });
} else {
  run = spawnSync('npx', ['tsc', '--noEmit'], { encoding: 'utf8', shell: process.platform === 'win32' });
}
if (run.error || run.status === null) {
  console.error('❌ 无法运行 tsc（门禁不成立，按失败处理）：', run.error ? run.error.message : '进程没有返回状态');
  process.exit(2);
}
const out = `${run.stdout || ''}${run.stderr || ''}`;
const lines = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));

console.log(`tsc 诊断：${lines.length} 条`);
if (lines.length > 0) {
  console.error('\n❌ 类型错误（门禁零豁免，必须修）：');
  for (const l of lines) console.error('  ' + l);
  process.exit(1);
}
console.log('\n✅ 类型检查通过（0 条诊断）');
