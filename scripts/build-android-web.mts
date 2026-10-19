/** Build a fresh APK-owned frontend. Never copy live dist (it retains old chunks). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const out = path.join(root, 'temp', `android-web-${Date.now()}`);
const assets = path.join(root, 'android/app/src/main/assets');
const web = path.join(assets, 'web');
const config = JSON.parse(fs.readFileSync('android/backend-config.json', 'utf8'));
for (const required of ['public/fonts', 'public/music', 'public/img', 'public/skins', 'src/wenyou/assets']) {
  if (!fs.existsSync(required) || !fs.readdirSync(required).length) throw new Error('Required release resources missing: ' + required);
}
if (config.storageOrigin !== 'https://myxiaoyu.com' || !Array.isArray(config.backendOrigins) || !config.backendOrigins.length) throw new Error('Keep the existing storage origin and at least one approved backend.');
for (const origin of [...config.backendOrigins, ...config.downloadOrigins]) {
  const u = new URL(origin);
  if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password) throw new Error('Endpoints must be explicit HTTPS origins.');
}
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'production', '--outDir', out], {
  stdio: 'inherit', env: { ...process.env, XIAOYU_DIST_DIR: out, XIAOYU_ANDROID_BUILD: '1', VITE_ANDROID_LOCAL: '1', VITE_API_BASE_URL: '' },
});
if (result.status !== 0) process.exit(result.status || 1);
// Explicit public allowlist; never include consoles, user uploads, database, .env or APKs.
const directories = ['img', 'skins', 'fonts', 'music', 'bgm', 'audio', 'media', 'wenyou'];
const files = ['favicon.ico', 'favicon.svg', 'logo-word.png', 'manifest.webmanifest', 'pay-qr.jpg', 'wolfcha-overrides.css', 'wolfcha.css', 'xiaoyu-avatar.jpg', 'xiaoyu-logo-192.png', 'xiaoyu-logo-512.png', 'xiaoyu-logo-new.png', 'xiaoyu-logo.png', 'xiaoyu-logo.svg', 'xiaoyu.svg'];
for (const name of [...directories, ...files]) {
  const source = path.join(root, 'public', name);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(out, name), { recursive: true });
}
fs.copyFileSync('android/runtime.js', path.join(out, 'android-runtime.js'));
const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('<head>', '<head>\n<!--XIAOYU_ANDROID_STATE-->\n<script src="/android-runtime.js"></script>');
fs.writeFileSync(indexPath, html);
const manifest: Record<string, { bytes: number; sha256: string }> = {};
function walk(dir: string) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error('Symlinks are not allowed in the APK bundle.');
    if (item.isDirectory()) walk(file);
    else {
      const relative = path.relative(out, file).replaceAll('\\', '/');
      if (/(^|\/)(admin[^/]*|console-[^/]*|\.env[^/]*|.*\.(sqlite|jks|apk|keystore))$/i.test(relative)) throw new Error('Private file in bundle: ' + relative);
      const bytes = fs.readFileSync(file);
      manifest['/' + relative] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  }
}
walk(out);
// Fail closed before replacing only this generated directory inside the known Android assets root.
if (path.resolve(web) !== path.resolve(root, 'android/app/src/main/assets/web')) throw new Error('Unexpected bundle target');
fs.mkdirSync(assets, { recursive: true });
if (fs.existsSync(web)) fs.renameSync(web, path.join(root, 'temp', `android-web-previous-${Date.now()}`));
fs.renameSync(out, web);
fs.writeFileSync(path.join(assets, 'web-manifest.json'), JSON.stringify(manifest));
fs.copyFileSync('android/backend-config.json', path.join(assets, 'backend-config.json'));
const total = Object.values(manifest).reduce((sum, f) => sum + f.bytes, 0);
console.log(`[android-web] ${Object.keys(manifest).length} files, ${(total / 1048576).toFixed(1)} MiB; no live dist or user data changed`);
