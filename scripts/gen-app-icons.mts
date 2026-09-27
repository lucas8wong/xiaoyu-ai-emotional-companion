/**
 * 为所有皮肤重建「hero 正方形 app 图标 + 每皮肤 PWA manifest」。
 * 源图 public/skins/<id>/hero.*，按首页 hero object-cover 语义 center-crop 到正方形。
 * 皮肤生成器生成新皮肤时会自动调用（api/services/skinGenerator.ts）；本脚本可手动全量重建。
 * 用法：npx tsx scripts/gen-app-icons.mts
 */
import path from 'node:path';
import fs from 'node:fs';
import { generateAppIconsForSkin } from '../api/services/appIcons.js';

const SKINS_DIR = path.resolve('public/skins');

async function main(): Promise<void> {
  if (!fs.existsSync(SKINS_DIR)) { console.error('skins dir not found'); process.exit(1); }
  const dirs = fs.readdirSync(SKINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const id of dirs) {
    await generateAppIconsForSkin(path.resolve('public'), id);
    console.log(`done ${id}`);
  }
}

void main();
