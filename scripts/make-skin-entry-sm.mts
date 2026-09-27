/**
 * 为「入口卡」与「陪伴方式」小图标在每套皮肤下生成真正的 240px 小图 `*-sm.webp`，
 * 并把 `*Sm` 字段写进有 meta.json 的动态皮肤 meta（star/candy）。
 * 静态皮肤（healing/zen/star）的 `*Sm` 字段在 src/lib/skin.ts 里手动维护。
 *
 * 用途：
 *  - 入口卡图标（chat/story/structure）在移动端只有 ~40-56px，却用 800px 大图渲染，白下大量像素。
 *  - 陪伴方式图标（modeHug/modeAlly/modeClarify/modeLight/modeObjective）同样只有 ~40px。
 * 这步用 sharp 从既有全图重编码出小图，供前端 `src` 优先取小图。
 *
 * 名称约定（沿用各皮肤既有文件名）：
 *  - healing/zen：mode-hug.webp / modeHug.webp 不存在 → 用 kebab；star/candy：modeHug.webp（camel）。
 *  - 入口键 chat/story/structure 全部是 `<key>.webp`。
 * 幂等：全部重新生成覆盖；无源图则跳过并提示。
 * 用法：npx tsx scripts/make-skin-entry-sm.mts
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKINS = ['healing', 'zen', 'star', 'candy'];
const ENTRY_KEYS = ['chat', 'story', 'structure'] as const;
const MODES = ['hug', 'ally', 'clarify', 'light', 'objective'] as const;
const PLANS = ['free', 'plus', 'pro'] as const;
const SMALL_W = 240;

const skinsDir = path.join(ROOT, 'public', 'skins');

function modeProp(mode: string): string {
  return 'mode' + mode[0].toUpperCase() + mode.slice(1);
}

/** 返回某皮肤下陪伴方式图标的实际文件名（kebab 或 camel），不存在则 null */
function modeSrcFile(dir: string, mode: string): string | null {
  const camel = modeProp(mode);
  for (const fn of [`mode-${mode}.webp`, `${camel}.webp`]) {
    if (existsSync(path.join(dir, fn))) return fn;
  }
  return null;
}

/** 会员档图标文件名：healing/zen 用 plan-free.webp（kebab），star/candy 用 planFree.webp（camel） */
function planSrcFile(dir: string, plan: string): string | null {
  const camel = 'plan' + plan[0].toUpperCase() + plan.slice(1);
  for (const fn of [`plan-${plan}.webp`, `${camel}.webp`]) {
    if (existsSync(path.join(dir, fn))) return fn;
  }
  return null;
}

async function makeSmall(dir: string, srcFile: string): Promise<number | null> {
  const src = path.join(dir, srcFile);
  if (!existsSync(src)) return null;
  const dst = path.join(dir, srcFile.replace(/\.webp$/, '-sm.webp'));
  const buf = await fs.readFile(src);
  const small = await sharp(buf).resize({ width: SMALL_W, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  await fs.writeFile(dst, small);
  return small.length;
}

for (const id of SKINS) {
  const dir = path.join(skinsDir, id);
  if (!existsSync(dir)) { console.warn(`skip ${id}: no dir`); continue; }
  for (const key of ENTRY_KEYS) {
    const bytes = await makeSmall(dir, `${key}.webp`);
    console.log(bytes == null
      ? `skip ${id}/${key}: no source`
      : `ok ${id}/${key}-sm.webp  ${(bytes / 1024).toFixed(1)}KB`);
  }
  for (const mode of MODES) {
    const file = modeSrcFile(dir, mode);
    if (!file) { console.warn(`skip ${id}/${mode}: no mode source`); continue; }
    const bytes = await makeSmall(dir, file);
    console.log(bytes == null
      ? `skip ${id}/${mode}: no mode source`
      : `ok ${id}/${file.replace(/\.webp$/, '')}-sm.webp  ${(bytes / 1024).toFixed(1)}KB`);
  }
  for (const plan of PLANS) {
    const file = planSrcFile(dir, plan);
    if (!file) { console.warn(`skip ${id}/${plan}: no plan source`); continue; }
    const bytes = await makeSmall(dir, file);
    console.log(bytes == null
      ? `skip ${id}/${plan}: no plan source`
      : `ok ${id}/${file.replace(/\.webp$/, '')}-sm.webp  ${(bytes / 1024).toFixed(1)}KB`);
  }
  const fbFile = 'feedback.webp';
  if (existsSync(path.join(dir, fbFile))) {
    const bytes = await makeSmall(dir, fbFile);
    console.log(bytes == null
      ? `skip ${id}/feedback: no source`
      : `ok ${id}/feedback-sm.webp  ${(bytes / 1024).toFixed(1)}KB`);
  }
}

// 更新有 meta.json 的动态皮肤（star / candy），把 *Sm 字段写进去，保证运行时能读到小图 URL
for (const id of SKINS) {
  const metaFile = path.join(skinsDir, id, 'meta.json');
  if (!existsSync(metaFile)) { console.log(`skip ${id}: no meta.json`); continue; }
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  const dir = path.join(skinsDir, id);
  for (const key of ENTRY_KEYS) {
    const sm = path.join(dir, `${key}-sm.webp`);
    meta[`${key}Sm`] = existsSync(sm) ? `/skins/${id}/${key}-sm.webp?v=2` : '';
  }
  for (const mode of MODES) {
    const file = modeSrcFile(dir, mode);
    const sm = file ? path.join(dir, file.replace(/\.webp$/, '-sm.webp')) : null;
    const prop = modeProp(mode);
    meta[`${prop}Sm`] = (sm && existsSync(sm)) ? `/skins/${id}/${path.basename(sm)}?v=2` : '';
  }
  for (const plan of PLANS) {
    const file = planSrcFile(dir, plan);
    const sm = file ? path.join(dir, file.replace(/\.webp$/, '-sm.webp')) : null;
    const prop = 'plan' + plan[0].toUpperCase() + plan.slice(1);
    meta[`${prop}Sm`] = (sm && existsSync(sm)) ? `/skins/${id}/${path.basename(sm)}?v=2` : '';
  }
  const fbSm = path.join(dir, 'feedback-sm.webp');
  meta.feedbackSm = existsSync(fbSm) ? `/skins/${id}/feedback-sm.webp?v=2` : '';
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`meta ${id}: entry + mode *Sm written`);
}

// 重建 manifest.json（只收「完整 SkinMeta 形状」的动态皮肤）
const dirs = (await fs.readdir(skinsDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name);
const entries: any[] = [];
for (const name of dirs) {
  const metaFile = path.join(skinsDir, name, 'meta.json');
  if (!existsSync(metaFile)) continue;
  const j = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  if (j && j.id && (j.bg || j.hero)) entries.push(j);
}
await fs.writeFile(path.join(skinsDir, 'manifest.json'), JSON.stringify(entries, null, 2), 'utf8');
console.log(`manifest.json rebuilt: ${entries.length} dynamic skin(s)`);
