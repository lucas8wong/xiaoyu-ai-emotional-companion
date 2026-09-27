/**
 * 诊断脚本：检查 Downloads 里两套皮肤新字标的真实内容（是否带透明通道、背景色），
 * 并把源图复制到 temp/inspect-wordmark/ 供 read_image 人工复核。
 * 用法：npx tsx scripts/inspect-wordmark.mts
 */
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'temp', 'inspect-wordmark');

const SOURCES = [
  { id: 'star', src: 'C:/Users/Administrator/Downloads/xiaoyu星空.jpg', label: '星空' },
  { id: 'candy', src: 'C:/Users/Administrator/Downloads/xiaoyu棉花糖.jpg', label: '棉花糖' },
];

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const s of SOURCES) {
    const full = path.resolve(s.src);
    console.log(`\n=== ${s.label} (${s.id}) ===`);
    if (!fs.existsSync(full)) {
      console.log(`  ❌ 源文件不存在：${full}`);
      continue;
    }
    const meta = await sharp(full).metadata();
    console.log(`  src=${full}`);
    console.log(`  format=${meta.format} width=${meta.width} height=${meta.height} channels=${meta.channels} hasAlpha=${meta.hasAlpha}`);
    console.log(`  size=${fs.statSync(full).size} bytes`);

    let corners: string[][] = [];
    if (meta.width && meta.height) {
      const { data, info } = await sharp(full).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width, height } = info;
      const px = (x: number, y: number): number[] => {
        const i = (y * width + x) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      const pts: Array<[number, number]> = [
        [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
        [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
        [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
      ];
      corners = pts.map(([x, y]) => px(x, y).map((v) => v.toFixed(0)));
      console.log('  border pixels (RGBA):');
      corners.forEach((c, idx) => console.log(`    ${idx}: [${c.join(', ')}]`));
    }

    const ext = s.src.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    const copy = path.join(OUT_DIR, `${s.id}.${ext}`);
    fs.copyFileSync(full, copy);
    console.log(`  ➜ 已复制参考图到 ${copy}`);
  }
  console.log('\n✅ inspect 完成，请用 read_image 查看 temp/inspect-wordmark/{star,candy}.{png,jpg}');
}

main().catch((e) => {
  console.error('❌ inspect 失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
