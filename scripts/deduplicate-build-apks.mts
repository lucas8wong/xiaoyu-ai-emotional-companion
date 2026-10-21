/** Content-preserving NTFS hardlink deduplication of old, generated APK copies.
 * Dry run by default. Never walks live dist, public, releases, data, or links.
 * The private store and all aliased APKs must be treated as immutable artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const temp = path.resolve(root, 'temp');
const storeArg = process.argv.find(a => a.startsWith('--store='))?.slice(8);
if (!storeArg) throw new Error('Specify a private --store=absolute-path on the same volume');
const store = path.resolve(storeArg);
const apply = process.argv.includes('--apply');
if (!path.isAbsolute(storeArg) || path.parse(store).root.toLowerCase() !== path.parse(temp).root.toLowerCase()) {
  throw new Error('The private store must be an absolute path on the build volume');
}
const rel = path.relative(root, store);
if (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) throw new Error('Store must be outside the project');
if (fs.realpathSync(temp) !== temp) throw new Error('Linked temp root');
if (apply) fs.mkdirSync(store, { recursive: true });
if (fs.existsSync(store) && fs.realpathSync(store) !== store) throw new Error('Linked private store');
const cutoff = Date.now() - 3600_000;
const candidates: string[] = [];
function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!['data', '.git', '.codex', '.dsh', 'node_modules'].includes(entry.name)) walk(full);
    } else if (entry.isFile() && /^xiaoyu-\d+\.\d+\.\d+\.apk$/.test(entry.name)) {
      const st = fs.statSync(full);
      if (st.size >= 100 * 1048576 && st.mtimeMs < cutoff && st.birthtimeMs < cutoff) candidates.push(full);
    }
  }
}
walk(temp);
async function hash(file: string): Promise<string> {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
const verified = new Set<string>();
let copies = 0, replacedBytes = 0, storeBytes = 0;
for (const file of candidates) {
  const before = fs.statSync(file);
  const digest = await hash(file);
  const canonical = path.join(store, digest + '.apk');
  if (!apply) { console.log(JSON.stringify({ file: path.relative(root, file), bytes: before.size, sha256: digest })); continue; }
  if (!fs.existsSync(canonical)) {
    fs.copyFileSync(file, canonical, fs.constants.COPYFILE_EXCL);
    storeBytes += before.size;
  }
  if (!verified.has(canonical)) {
    if (fs.lstatSync(canonical).isSymbolicLink() || await hash(canonical) !== digest) throw new Error('Private store verification failed');
    verified.add(canonical);
  }
  const current = fs.statSync(file);
  if (current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error('APK changed during verification');
  if (current.ino === fs.statSync(canonical).ino) continue;
  const alias = file + '.dedup-' + process.pid;
  // Record recovery information before replacing only byte-identical APK files.
  fs.appendFileSync(path.join(store, 'aliases.jsonl'), JSON.stringify({ file, canonical, sha256: digest, bytes: before.size, mtime: before.mtimeMs }) + '\n');
  fs.linkSync(canonical, alias);
  try {
    fs.chmodSync(file, 0o600);
    fs.renameSync(alias, file);
  } catch (error) {
    fs.chmodSync(file, before.mode);
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    throw error;
  }
  if (fs.statSync(file).ino !== fs.statSync(canonical).ino) throw new Error('Hardlink verification failed');
  if (before.nlink === 1) replacedBytes += before.size;
  copies++;
}
for (const canonical of verified) fs.chmodSync(canonical, 0o444);
console.log(JSON.stringify({ apply, candidates: candidates.length, linkedCopies: copies, uniqueAPKs: verified.size, netFreedGB: (replacedBytes - storeBytes) / 2 ** 30 }));
