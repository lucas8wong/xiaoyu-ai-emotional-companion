/**
 * 皮肤静态化脚本：把管理员生成的皮肤（public/skins/<id>/meta.json）重新生成为
 * 静态资源——写 src/lib/generated-skins.ts（并入前端 SKINS）+ src/generated-skins.css
 * （每套皮肤 :root[data-skin=id] 的 CSS 变量），并把 public/skins/manifest.json 置空。
 *
 * 用途：
 *  - 皮肤生成器（api/services/skinGenerator.ts）在生成后会自动调用；
 *  - 也可单独运行本脚本：编辑/调整了某套生成皮肤（如补图、改色板、改名）后重新生成静态数据，
 *    随后 npm run build:prod 即可让皮肤随包发布。
 *
 * 注意：手写/品牌皮肤（default/healing/zen/star/candy）不写进 GENERATED_STATIC_SKINS，由 SKINS 常量维护。
 * 用法：npx tsx scripts/staticize-skins.mts
 */
import path from 'node:path';
import { writeStaticSkins } from '../api/services/skinStaticize.js';

const ROOT = process.cwd();

async function main() {
  const result = await writeStaticSkins(ROOT);
  console.log(`✅ 已静态化 ${result.count} 套管理员生成的皮肤：${result.generatedSkins.join(', ') || '(无)'}`);
  console.log('   · src/lib/generated-skins.ts 已更新');
  console.log('   · src/generated-skins.css 已更新');
  console.log('   · public/skins/manifest.json 已置空（动态机制留作未来用户自建皮肤）');
  console.log('   👉 运行 npm run build:prod 让皮肤随 bundle 发布。');
}

main().catch((e) => {
  console.error('❌ 皮肤静态化失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
