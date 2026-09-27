/**
 * 生成站点根 favicon.ico（爱心 logo）：
 * QQ 等按默认路径请求 /favicon.ico 的浏览器拿不到图标（会回退 SPA HTML → 用浏览器自带图标）。
 * 这里把 healing 皮肤的 app-icon-48（heart 爱心 logo 白底合成）包成 PNG-in-ICO 写到 public/favicon.ico，
 * 让 QQ / 其它按 /favicon.ico 取图的浏览器能用上我们的爱心图标。
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.resolve(root, 'public/skins/healing/app-icon-48.png');
const out = path.resolve(root, 'public/favicon.ico');

(async () => {
  const png = await sharp(src).resize(32, 32).png().toBuffer();
  const w = 32, h = 32;
  // ICONDIR
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);  // reserved
  dir.writeUInt16LE(1, 2);  // type = icon
  dir.writeUInt16LE(1, 4);  // count
  // ICONDIRENTRY（单个 PNG 图像）
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0);   // width
  entry.writeUInt8(h >= 256 ? 0 : h, 1);   // height
  entry.writeUInt8(0, 2);                  // color count
  entry.writeUInt8(0, 3);                  // reserved
  entry.writeUInt16LE(1, 4);               // planes
  entry.writeUInt16LE(32, 6);              // bit count
  entry.writeUInt32LE(png.length, 8);      // bytes in resource
  entry.writeUInt32LE(22, 12);             // image offset
  const ico = Buffer.concat([dir, entry, png]);
  fs.writeFileSync(out, ico);
  console.log('wrote', out, ico.length, 'bytes');
})();
