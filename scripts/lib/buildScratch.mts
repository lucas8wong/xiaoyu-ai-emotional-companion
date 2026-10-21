/** Only explicitly registered, disposable build directories may be reclaimed. */
import fs from 'node:fs';
import path from 'node:path';

interface Owner { version: 1; directory: string; pid: number; created: number }
const generated = /^(dist-next-\d+|android-web-\d+|android-web-previous-\d+)$/;

function locations(root: string, directory: string) {
  const temp = path.resolve(root, 'temp');
  const target = path.resolve(directory);
  if (path.dirname(target) !== temp || !generated.test(path.basename(target))) {
    throw new Error('Not a disposable build directory: ' + target);
  }
  // A junction in the temp root must never redirect cleanup outside this workspace.
  if (fs.realpathSync(temp) !== temp) throw new Error('Build temp root must not be a link');
  return { target, record: path.join(temp, '.build-scratch', path.basename(target) + '.json') };
}

export function registerBuildScratch(root: string, directory: string): void {
  fs.mkdirSync(path.resolve(root, 'temp'), { recursive: true });
  const { target, record } = locations(root, directory);
  if (fs.existsSync(target)) throw new Error('Build scratch must start at a new path');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  if (fs.lstatSync(path.dirname(record)).isSymbolicLink()) throw new Error('Linked build registry');
  const owner: Owner = { version: 1, directory: target, pid: process.pid, created: Date.now() };
  fs.writeFileSync(record, JSON.stringify(owner), { flag: 'wx' });
}

export function removeBuildScratch(root: string, directory: string): void {
  const { target, record } = locations(root, directory);
  if (fs.lstatSync(path.dirname(record)).isSymbolicLink() || fs.lstatSync(record).isSymbolicLink()) throw new Error('Linked build registry');
  const owner = JSON.parse(fs.readFileSync(record, 'utf8')) as Owner;
  if (owner.version !== 1 || owner.directory !== target) throw new Error('Invalid build ownership record');
  const files: string[] = [];
  const walk = (current: string): void => {
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error('Refusing linked build content: ' + current);
    if (entry.isDirectory()) {
      if (['data', '.git', '.codex', '.dsh'].includes(path.basename(current))) throw new Error('Protected build content');
      for (const name of fs.readdirSync(current)) walk(path.join(current, name));
    } else {
      if (/\.(sqlite(?:-wal|-shm)?|db|jks|keystore)$/i.test(current) || /^\.env(?:\.|$)/.test(path.basename(current))) {
        throw new Error('Protected build content: ' + current);
      }
      files.push(current);
    }
  };
  if (fs.existsSync(target)) {
    // Validate the whole tree before changing anything. Normalize generated file
    // permissions only; archived evidence and business directories are never scanned.
    walk(target);
    for (const file of files) fs.chmodSync(file, 0o600);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
  fs.unlinkSync(record);
}

export function reclaimAbandonedBuilds(root: string, now = Date.now()): void {
  const records = path.resolve(root, 'temp', '.build-scratch');
  if (!fs.existsSync(records)) return;
  if (fs.lstatSync(records).isSymbolicLink()) throw new Error('Linked build registry');
  for (const name of fs.readdirSync(records)) {
    if (!name.endsWith('.json')) continue;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(records, name), 'utf8')) as Owner;
      if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.created)) continue;
      if (now - owner.created < 60 * 60 * 1000) continue;
      if (name !== path.basename(owner.directory) + '.json') continue;
      try { process.kill(owner.pid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      removeBuildScratch(root, owner.directory);
      console.log('[build-scratch] reclaimed abandoned ' + path.basename(owner.directory));
    } catch (error) {
      console.warn('[build-scratch] retained directory for inspection:', String(error));
    }
  }
}
