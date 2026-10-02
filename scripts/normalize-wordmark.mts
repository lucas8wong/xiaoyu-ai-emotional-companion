/**
 * 统一四套皮肤（healing/zen/star/candy）「Xiaoyu 字标」的实际渲染大小：
 * 把所有 wordmark.webp 归一化到 1024×512 透明画布，且字标(含叶子/装饰)高度恒为画布高度的
 * R=0.5，使 AboutPage 以固定 h-20/h-24 渲染时各皮肤字标高度一致。
 * 用法：npx tsx scripts/normalize-wordmark.mts
 */
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'temp', 'normalize');
const CANVAS_W = 1024;
const CANVAS_H = 512;
const R = 0.5; // 字标高度占画布高度比例

const SKINS = ['healing', 'zen', 'star', 'candy'];

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const id of SKINS) {
    const file = path.join(ROOT, 'public', 'skins', id, 'wordmark.webp');
    // 先把源读进内存，避免 sharp 一直占着源文件的句柄（Windows 下会导致替换失败）
    const srcBuf = fs.readFileSync(file);
    const trimmed = await sharp(srcBuf).trim({ threshold: 0 }).toBuffer();
    const meta = await sharp(trimmed).metadata();
    const cw = meta.width as number;
    const ch = meta.height as number;

    // 2) 按目标字标高缩放（保持比例）
    const targetH = Math.round(CANVAS_H * R);
    const scale = targetH / ch;
    const newW = Math.max(1, Math.round(cw * scale));
    const newH = Math.max(1, Math.round(ch * scale));
    const resized = await sharp(trimmed).resize(newW, newH, { fit: 'fill' }).toBuffer();

    // 3) 居中放到统一透明画布
    const left = Math.round((CANVAS_W - newW) / 2);
    const top = Math.round((CANVAS_H - newH) / 2);
    const tmp = path.join(OUT_DIR, id + '.webp');
    await sharp({
      create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: resized, left, top }])
      .webp({ quality: 92, effort: 6 })
      .toFile(tmp);

    const out = await sharp(tmp).metadata();
    console.log(`${id}: content=${cw}x${ch} -> canvas=${out.width}x${out.height} contentH=${targetH} ratio=${(targetH / CANVAS_H).toFixed(3)}`);
  }
  console.log('✅ 归一化完成');
}

main().catch((e) => {
  console.error('❌ 失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
