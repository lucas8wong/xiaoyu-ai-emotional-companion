/**
 * 皮肤静态化：把「管理员生成皮肤」从运行时 manifest 变为静态随包发布。
 *
 * 流程：扫描 public/skins/<id>/meta.json（完整 SkinMeta 形状）→
 *   1) 写 src/lib/generated-skins.ts（静态数据，被 src/lib/skin.ts 并入 SKINS）
 *   2) 写 src/generated-skins.css（每套皮肤 :root[data-skin=id] 的 CSS 变量，从 palette 推导）
 *   3) 把 public/skins/manifest.json 置为 []（全局默认皮肤不再走动态清单；动态机制留作未来用户自建皮肤）
 *
 * 生成后需重新构建前端（npm run build:prod）才会把新皮肤烘焙进 bundle。
 */
import path from 'path';
import fs from 'fs/promises';

/** 手写/品牌皮肤 id：这些由 src/lib/skin.ts 的 SKINS 常量直接维护，不写入 GENERATED_STATIC_SKINS。 */
const HAND_AUTHORED_SKIN_IDS = ['default', 'healing', 'zen', 'star', 'candy'];

/** SkinMeta 的所有字符串字段（用于从 meta.json 里挑出干净对象，避免 TS 多余属性报错）。 */
const SKIN_META_KEYS = [
  'id', 'labelKey', 'descKey', 'label', 'desc', 'bg', 'bgPortrait', 'hero', 'chat', 'structure', 'story',
  'chatSm', 'structureSm', 'storySm', 'wordmark', 'heart', 'favicon', 'companion', 'membership',
  'modeHug', 'modeAlly', 'modeClarify', 'modeLight', 'modeObjective',
  'modeHugSm', 'modeAllySm', 'modeClarifySm', 'modeLightSm', 'modeObjectiveSm',
  'feedback', 'planFree', 'planPlus', 'planPro', 'planFreeSm', 'planPlusSm', 'planProSm', 'feedbackSm', 'preview',
] as const;

interface SkinMetaFile {
  id?: string;
  bg?: string;
  hero?: string;
  bgPortrait?: string;
  palette?: string[];
  [k: string]: unknown;
}

/* 【颜色工具】 */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/** amt>0 向白提亮，amt<0 向黑压暗（|amt| 为程度）。 */
function shade(hex: string, amt: number): string {
  const rgb = hexToRgb(hex);
  const target = amt >= 0 ? 255 : 0;
  const t = Math.abs(amt);
  return rgbToHex([rgb[0] + (target - rgb[0]) * t, rgb[1] + (target - rgb[1]) * t, rgb[2] + (target - rgb[2]) * t]);
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

function sanitizePalette(palette: unknown): string[] {
  if (!Array.isArray(palette)) return [];
  return (palette as unknown[])
    .filter((c): c is string => typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c))
    .map((c) => (c.startsWith('#') ? c : `#${c}`));
}

/**
 * 同一个颜色出两行：`--color-x`（hex，给 CSS/内联样式直接用）+ `--color-x-rgb`（RGB 三通道，给 Tailwind 的
 * `/透明度` 修饰符用，裸 `var()` 解析不出颜色，`bg-primary/10` 这类类会被 Tailwind 静默丢弃，
 * 详见 tailwind.config.js 顶部注释）。两行必须同源同改，`test/unit/themeTokens.test.ts` 守着这条不变量。
 */
function tokenPair(name: string, hex: string): string[] {
  const [r, g, b] = hexToRgb(hex);
  return [`  --color-${name}: ${hex};`, `  --color-${name}-rgb: ${r} ${g} ${b};`];
}

/** 从生成的 palette 推导一套「够用」的皮肤 CSS 变量（作为起始方案，可手工微调）。 */
function buildSkinCss(meta: SkinMetaFile): string {
  const palette = sanitizePalette(meta.palette);
  if (!palette.length) return '';
  const primary = palette.reduce((best, c) =>
    saturation(c) * (1 - Math.abs(luminance(c) - 0.5)) > saturation(best) * (1 - Math.abs(luminance(best) - 0.5)) ? c : best);
  const bg = palette.reduce((best, c) => (luminance(c) > luminance(best) ? c : best));
  const fg = palette.reduce((best, c) => (luminance(c) < luminance(best) ? c : best));
  const accent = (palette.filter((c) => c !== primary).reduce((best, c) => (saturation(c) > saturation(best) ? c : best), primary));
  const bgWash = luminance(bg) < 0.5 ? 0.4 : 0;
  const bgRgb = hexToRgb(bg);
  const bgImage = meta.bg ? `url("${meta.bg}")` : 'none';
  const portrait = meta.bgPortrait ? `url("${meta.bgPortrait}")` : bgImage;
  const heroImage = meta.hero ? `url("${meta.hero}")` : 'none';
  return [
    `:root[data-skin="${meta.id}"] {`,
    ...tokenPair('primary', primary),
    ...tokenPair('primary-strong', shade(primary, -0.18)),
    ...tokenPair('primary-soft', shade(primary, 0.78)),
    ...tokenPair('primary-lighter', shade(primary, 0.9)),
    ...tokenPair('accent', accent),
    ...tokenPair('accent-soft', shade(accent, 0.72)),
    ...tokenPair('bg', bg),
    ...tokenPair('fg', fg),
    ...tokenPair('muted', shade(fg, 0.72)),
    ...tokenPair('muted-fg', shade(fg, 0.3)),
    ...tokenPair('border', shade(primary, 0.6)),
    ...tokenPair('ring', primary),
    `  --skin-bg-image: ${bgImage};`,
    `  --skin-hero-image: ${heroImage};`,
    `  --skin-bg-wash: ${bgWash};`,
    `  --skin-bg-wash-color: ${bgRgb[0]} ${bgRgb[1]} ${bgRgb[2]};`,
    `  --skin-display-font: "Varela Round", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;`,
    `}`,
    `@media (max-width: 640px) { :root[data-skin="${meta.id}"] { --skin-bg-image: ${portrait}; } }`,
  ].join('\n');
}

function toSkinMeta(entry: SkinMetaFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SKIN_META_KEYS) {
    const v = entry[k];
    out[k] = typeof v === 'string' ? v : '';
  }
  out.id = entry.id || '';
  return out;
}

function buildGeneratedSkinsTs(entries: SkinMetaFile[]): string {
  const body = entries.map((e) => JSON.stringify(toSkinMeta(e), null, 2)).join(',\n  ');
  return `import type { SkinMeta } from './skin';

/**
 * 管理员生成的皮肤（静态化）清单，由皮肤生成器 / scripts/staticize-skins.mts 写入。
 * 生成后需重新构建前端（npm run build:prod），皮肤即作为静态资源随包发布、首帧即命中。
 * 手写/品牌皮肤（default/healing/zen/star/candy）不在此列。
 */
export const GENERATED_STATIC_SKINS: SkinMeta[] = [
  ${body}
];
`;
}

function buildGeneratedSkinsCss(entries: SkinMetaFile[]): string {
  const blocks = entries.map((e) => buildSkinCss(e)).filter(Boolean);
  return [
    '/* 自动生成：管理员生成皮肤（静态）的 CSS 变量。由皮肤生成器 / scripts/staticize-skins.mts 写入，可手工微调。 */',
    '',
    ...blocks,
    '',
  ].join('\n');
}

async function readMetaEntries(publicRoot: string): Promise<SkinMetaFile[]> {
  const skinsDir = path.join(publicRoot, 'skins');
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(skinsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    dirs = [];
  }
  const entries: SkinMetaFile[] = [];
  for (const name of dirs) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(skinsDir, name, 'meta.json'), 'utf8')) as SkinMetaFile;
      // 只收「完整 SkinMeta 形状」且「非手写」的动态皮肤（有 id 且至少有一个背景/hero 图 URL）
      if (j && j.id && (j.bg || j.hero) && !HAND_AUTHORED_SKIN_IDS.includes(j.id)) entries.push(j);
    } catch {
      /* 忽略非皮肤目录 */
    }
  }
  return entries;
}

/** 重新生成静态皮肤数据 + CSS，并把全局 manifest 置空（动态机制留作未来用户自建皮肤）。 */
export async function writeStaticSkins(projectRoot: string): Promise<{ count: number; generatedSkins: string[] }> {
  const publicRoot = path.join(projectRoot, 'public');
  const entries = await readMetaEntries(publicRoot);
  const ids = entries.map((e) => e.id as string);

  const tsPath = path.join(projectRoot, 'src', 'lib', 'generated-skins.ts');
  await fs.writeFile(tsPath, buildGeneratedSkinsTs(entries), 'utf8');

  const cssPath = path.join(projectRoot, 'src', 'generated-skins.css');
  await fs.writeFile(cssPath, buildGeneratedSkinsCss(entries), 'utf8');

  // 全局默认皮肤不再走运行时动态清单
  await fs.writeFile(path.join(publicRoot, 'skins', 'manifest.json'), '[]\n', 'utf8');

  return { count: entries.length, generatedSkins: ids };
}
