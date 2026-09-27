/**
 * 把 Downloads 里两套皮肤新字标（JPG，但背景是“透明棋盘格”假透明）
 * 转成真正带 alpha 的透明 WebP，覆盖 public/skins/<id>/wordmark.webp。
 *
 * 原理：从四边做“泛洪填充”，把与棋盘格同色（低饱和 + 该皮肤对应的亮度区间）的
 * 连通背景像素置为透明，保留彩色字标/叶子/彩色装饰；再 trim 掉透明留白、缩到合适宽度。
 *
 * 用法：npx tsx scripts/replace-wordmark.mts
 */
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const ROOT = process.cwd();
const MAX_WIDTH = 1024;

const TARGETS = [
  {
    id: 'star',
    label: '星空',
    src: 'C:/Users/Administrator/Downloads/xiaoyu星空.jpg',
    dest: path.join(ROOT, 'public', 'skins', 'star', 'wordmark.webp'),
    // 星空棋盘格=深灰/中灰，亮度低；字标彩色(饱和高) + 亮白星芒保留
    bg: { sat: 24, lumMin: 0, lumMax: 160 },
    mode: 'global', // 星空字标内部无“必须保留的中性暗色”，可全局抹掉所有中性暗背景(含字母挖空) 
  },
  {
    id: 'candy',
    label: '棉花糖',
    src: 'C:/Users/Administrator/Downloads/xiaoyu棉花糖.jpg',
    dest: path.join(ROOT, 'public', 'skins', 'candy', 'wordmark.webp'),
    // 棉花糖棋盘格=近白/浅灰，亮度高；字标粉橙(饱和高)保留
    bg: { sat: 24, lumMin: 195, lumMax: 255 },
    mode: 'flood', // 棉花糖字母上有白色高光(与棋盘格同色)，仅抹与边界连通的背景，避免挖穿字母
  },
];

function isBackground(r: number, g: number, b: number, cfg: { sat: number; lumMin: number; lumMax: number }): boolean {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx - mn;
  if (sat > cfg.sat) return false;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum >= cfg.lumMin && lum <= cfg.lumMax;
}

/** 泛洪后仍有“被字母围住的背景色小口袋”（如 a/o 挖空）。这些是棋盘格纹理（相邻像素对比度高），
 * 而字母上的白色高光是平滑渐变（对比度低）。据此只抹掉高对比度的挖空，保护高光。 */
function removeEnclosedCheckerboard(
  raw: Buffer,
  width: number,
  height: number,
  cfg: { sat: number; lumMin: number; lumMax: number },
  minArea: number,
  minContrast: number,
): void {
  const total = width * height;
  const label = new Int32Array(total).fill(-1);
  let next = 0;

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    if (label[i] !== -1) continue;
    if (!isBackground(raw[idx], raw[idx + 1], raw[idx + 2], cfg) || raw[idx + 3] === 0) continue;

    const pixels: number[] = [];
    const stack = [i];
    label[i] = next;
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const px = p % width;
      const py = (p / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const q = ny * width + nx;
        const qi = q * 4;
        if (label[q] === -1 && isBackground(raw[qi], raw[qi + 1], raw[qi + 2], cfg) && raw[qi + 3] > 0) {
          label[q] = next;
          stack.push(q);
        }
      }
    }

    const area = pixels.length;
    const member = new Set<number>(pixels);
    let sum = 0;
    let pairs = 0;
    for (const p of pixels) {
      const px = p % width;
      const py = (p / width) | 0;
      const idx = p * 4;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < width && ny < height) {
          const q = ny * width + nx;
          if (member.has(q)) {
            const qi = q * 4;
            sum += Math.abs(raw[idx] - raw[qi]) + Math.abs(raw[idx + 1] - raw[qi + 1]) + Math.abs(raw[idx + 2] - raw[qi + 2]);
            pairs++;
          }
        }
      }
    }
    const contrast = pairs ? sum / pairs : 0;

    if (area >= minArea && contrast >= minContrast) {
      for (const p of pixels) raw[p * 4 + 3] = 0;
    }
    next++;
  }
}

/** 去掉棋盘格背景，返回修改后的 RGBA Buffer + 尺寸。
 * mode='global'：抹掉所有命中背景色的像素（含字母挖空，适用于字标内部无必须保留的中性色）。
 * mode='flood' ：只从四边泛洪抹掉与边界连通的背景，保护字母内部与背景同色的高光。 */
async function removeBackground(
  buf: Buffer,
  cfg: { sat: number; lumMin: number; lumMax: number },
  mode: 'global' | 'flood',
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const raw = Buffer.from(data); // RGBA

  if (mode === 'global') {
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      if (isBackground(raw[idx], raw[idx + 1], raw[idx + 2], cfg)) raw[idx + 3] = 0;
    }
    return { data: raw, width, height };
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const push = (px: number): void => {
    if (!visited[px]) {
      visited[px] = 1;
      queue[tail++] = px;
    }
  };

  // 只从“确实是背景”的边界像素开始泛洪
  const trySeed = (px: number): void => {
    const idx = px * 4;
    if (isBackground(raw[idx], raw[idx + 1], raw[idx + 2], cfg)) push(px);
  };
  for (let x = 0; x < width; x++) {
    trySeed(x);
    trySeed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    trySeed(y * width);
    trySeed(y * width + width - 1);
  }

  while (head < tail) {
    const p = queue[head++];
    const idx = p * 4;
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];
    if (!isBackground(r, g, b, cfg)) continue; // 非背景：当作障碍，不扩散
    raw[idx + 3] = 0; // 透明
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }

  // 再清除被字母围住的高对比度棋盘格挖空（保留平滑的高光）
  removeEnclosedCheckerboard(raw, width, height, cfg, 50, 18);

  return { data: raw, width, height };
}

async function main(): Promise<void> {
  for (const t of TARGETS) {
    console.log(`=== ${t.label} (${t.id}) ===`);
    if (!fs.existsSync(t.src)) {
      console.log(`  ❌ 源文件不存在：${t.src}`);
      process.exitCode = 1;
      continue;
    }
    const meta = await sharp(t.src).metadata();
    console.log(`  源=${t.src} (${meta.format} ${meta.width}x${meta.height})`);

    let converted;
    if (meta.hasAlpha) {
      // 已有透明通道：直接用原 alpha
      converted = await sharp(t.src);
    } else {
      const { data, width, height } = await removeBackground(t.src, t.bg, t.mode);
      converted = sharp(data, { raw: { width, height, channels: 4 } });
    }

    await converted
      .trim({ threshold: 0 }) // 裁掉四周透明留白
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 92, effort: 6 })
      .toFile(t.dest);

    const out = await sharp(t.dest).metadata();
    console.log(`  ✅ 已写出 ${t.dest} (${out.format} ${out.width}x${out.height} hasAlpha=${out.hasAlpha})`);

    // 顺手把明亮装饰(星芒/爱心)是否被误删做个量化：统计非透明像素占比
    const { data: d, info } = await sharp(t.dest).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    console.log(`  非透明像素占比：${((opaque / px) * 100).toFixed(1)}%`);
  }
  console.log('\n✅ 转换完成');
}

main().catch((e) => {
  console.error('❌ 转换失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
