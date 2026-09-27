/**
 * 类型门禁（2026-09-17 立）
 *
 * 问题：`npm run check`（= `tsc --noEmit`）长期红着——31 条诊断**全部**来自上游移植子系统
 * `src/wolfcha/**`（狼人杀）。而 `tsconfig.json` 里的 `exclude: ["src/wolfcha"]` 救不了它：
 * 只要有**被 include 的文件 import 了 wolfcha**（`WolfchaHost.tsx` 就是），tsc 就会把这些文件
 * 拉进同一个 program，exclude 只管"根文件集合"，不管被拉进来的依赖。
 *
 * 后果（可持续性）：门禁永远红着 → 没人看它 → 第一方代码新增的类型错误会被淹没在 31 条噪声里。
 *
 * 做法：把两边的诊断**分开报告**，只让第一方（src 里非 wolfcha + api + test）决定退出码；
 * wolfcha 的存量单独打印并作为基线可见（清完它的那天，这个脚本自然变成"全绿"）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// 直接跑 typescript 的 JS 入口（`node node_modules/typescript/bin/tsc`）：跨平台最稳。
// ⚠️ 不能用 `node_modules/.bin/tsc.cmd` + spawnSync（Node 18+ 在 Windows 上会 EINVAL，
//    而且**静默返回空输出**——那会让这个门禁假装全绿，比没有门禁更危险）；
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

const isVendored = (l) => /src[\\/]wolfcha[\\/]/.test(l);
const vendored = lines.filter(isVendored);
const firstParty = lines.filter((l) => !isVendored(l));

console.log(`tsc 诊断：第一方 ${firstParty.length} 条 ／ 上游移植子系统 src/wolfcha ${vendored.length} 条`);

if (firstParty.length > 0) {
  console.error('\n❌ 第一方代码类型错误（必须修）：');
  for (const l of firstParty) console.error('  ' + l);
  process.exit(1);
}

if (vendored.length > 0) {
  console.log(`\nℹ️ src/wolfcha 的 ${vendored.length} 条是**既有基线**（上游移植代码，按 backlog 处理）。`);
  console.log('   要看明细：`npm run check:all`（或 npx tsc --noEmit）。');
}

console.log('\n✅ 第一方类型检查通过');
