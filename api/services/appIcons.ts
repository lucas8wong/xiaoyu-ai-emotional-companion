/**
 * 皮肤 app 图标 / PWA manifest 生成（从 hero 裁正方形）。
 * 供两处复用：
 *  - scripts/gen-app-icons.mts：手动为所有皮肤重建图标/manifest；
 *  - api/services/skinGenerator.ts：生成新皮肤后自动调用（新皮肤自动产出图标/manifest）。
 */
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

const SIZES = [32, 48, 180, 192, 512];

/** 内置皮肤的主题色/背景色（manifest 用）；未知皮肤回退 healing */
const BUILTIN_COLORS: Record<string, { theme: string; bg: string }> = {
  healing: { theme: '#1FA46B', bg: '#FBF6EE' },
  zen: { theme: '#3E5B4C', bg: '#F4EFE6' },
  star: { theme: '#3A2E7E', bg: '#191130' },
  candy: { theme: '#E289B8', bg: '#FFF4F9' },
};

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function deriveColors(id: string, palette?: string[]): { theme: string; bg: string } {
  if (palette && palette.length) {
    const theme = palette.reduce((best, c) => (saturation(c) > saturation(best) ? c : best));
    const bg = palette.reduce((best, c) => (luminance(c) > luminance(best) ? c : best));
    return { theme, bg };
  }
  return BUILTIN_COLORS[id] ?? BUILTIN_COLORS.healing;
}

/** 取图片的平均色（缩到 1×1 近似）作为系统 splash 背景色，让它贴近 hero 主色调。 */
async function avgColor(imgPath: string): Promise<string | null> {
  try {
    const { data } = await sharp(imgPath).resize(1, 1, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const p = data as Buffer;
    return `#${[p[0], p[1], p[2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}

/** 为某套皮肤生成 app-icon-{32,48,180,192,512}.png + manifest.webmanifest。
 * 图标源 = 该皮肤 hero 的「爱心 logo」（heart.*，首页白色圆角卡 + 爱心 mark），无则回退 hero 背景。 */
export async function generateAppIconsForSkin(publicRoot: string, id: string): Promise<void> {
  const dir = path.join(publicRoot, 'skins', id);
  const findAsset = (base: string): string | null => {
    for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
      const f = path.join(dir, `${base}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  };
  const mark = findAsset('heart') ?? findAsset('hero');
  if (!mark) return;

  let palette: string[] = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { palette?: unknown };
    if (Array.isArray(m.palette)) palette = (m.palette as unknown[]).filter((c): c is string => typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c)).map((c) => (c.startsWith('#') ? c : `#${c}`));
  } catch { /* 无 meta 用内置回退 */ }

  const c = deriveColors(id, palette);
  // 系统 splash 背景色取 hero 平均色（贴近 hero 主色调，衔接应用内启动页更顺），取不到回退皮肤配色
  const hero = findAsset('hero');
  const splashBg = hero ? ((await avgColor(hero)) ?? c.bg) : c.bg;
  for (const size of SIZES) {
    // 白色底 + 爱心 logo（object-cover，与首页 hero 白卡一致）；透明处露出白底
    const markBuf = await sharp(mark).resize(size, size, { fit: 'cover', position: 'centre' }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: markBuf, left: 0, top: 0 }])
      .png()
      .toFile(path.join(dir, `app-icon-${size}.png`));
  }
  const manifest = {
    name: 'Xiaoyu — AI Emotional Companion',
    short_name: 'Xiaoyu',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: splashBg,
    theme_color: c.theme,
    description: 'AI emotional companion. Every feeling deserves to be understood.',
    lang: 'zh-CN',
    icons: [
      { src: `/skins/${id}/app-icon-192.png?v=2`, sizes: '192x192', type: 'image/png' },
      { src: `/skins/${id}/app-icon-512.png?v=2`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
}
