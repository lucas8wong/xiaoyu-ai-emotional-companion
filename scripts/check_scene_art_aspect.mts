#!/usr/bin/env node
/**
 * 场景图比例门禁：磁盘上的 `public/img/roleplay-scenes/*` 必须**全部是竖版**（高 > 宽）。
 *
 * 为什么需要（2026-09-14）：出图口径曾经是 16:9，但真机背景容器是**竖版 0.668**，
 * 于是 `object-cover` 把每张图裁掉 62%。改口径之后必须能**逐张证明**旧图已被重出覆盖，
 * 而不是"看起来挺竖的"。
 *
 * 用法：
 *   npx tsx scripts/check_scene_art_aspect.mts            # 体检（非 0 退出 = 还有旧横版）
 *   npx tsx scripts/check_scene_art_aspect.mts --list      # 顺便逐张列出横版文件
 * 退出码：0 = 全部竖版；1 = 存在横版（= 还没重出，或有人把尺寸改回横版了）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public', 'img', 'roleplay-scenes');
const require_ = createRequire(import.meta.url);
const sharp = require_('sharp') as (f: string) => { metadata: () => Promise<{ width?: number; height?: number }> };

const listAll = process.argv.includes('--list');
const files = fs.readdirSync(DIR).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)).sort();

const bySize = new Map<string, number>();
const landscape: Array<{ file: string; w: number; h: number }> = [];
for (const f of files) {
  const m = await sharp(path.join(DIR, f)).metadata();
  const w = m.width || 0, h = m.height || 0;
  bySize.set(`${w}x${h}`, (bySize.get(`${w}x${h}`) || 0) + 1);
  if (w && h && w >= h) landscape.push({ file: f, w, h });
}

console.log(`扫描 ${files.length} 张：`);
for (const [size, n] of [...bySize.entries()].sort((a, b) => b[1] - a[1])) {
  const [w, h] = size.split('x').map(Number);
  const tag = w > h ? '⚠️ 横版（旧口径）' : w === h ? '⚠️ 方形' : '✅ 竖版';
  console.log(`  ${size.padEnd(12)} ${String(n).padStart(4)} 张  ${tag}`);
}
if (landscape.length) {
  console.error(`\n❌ ${landscape.length} 张仍是横版/方形（= 还没按竖版重出）：`);
  for (const l of (listAll ? landscape : landscape.slice(0, 12))) console.log(`   · ${l.file}  ${l.w}x${l.h}`);
  if (!listAll && landscape.length > 12) console.log(`   …另有 ${landscape.length - 12} 张（加 --list 全列）`);
  process.exit(1);
}
console.log('\n✅ 全部竖版：旧横版已被重出覆盖干净。');
