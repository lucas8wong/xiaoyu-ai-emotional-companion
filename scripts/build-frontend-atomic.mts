/**
 * Build and publish the frontend without exposing a half-written dist directory.
 *
 * Vite normally empties dist before writing. Express serves that same directory in
 * production, so a visitor refreshing during a build can receive an HTML entry whose
 * hashed assets do not exist yet. Build into temp first, verify it, copy assets/pages,
 * and replace the root HTML entry last.
 */
import { spawnSync } from 'node:child_process';
import {
  type Dirent,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { registerBuildScratch, removeBuildScratch, reclaimAbandonedBuilds } from './lib/buildScratch.mts';

const root = process.cwd();
const tempRoot = path.resolve(root, 'temp');
const lockDir = path.join(tempRoot, '.frontend-build.lock');
const stageDir = path.join(tempRoot, `dist-next-${process.pid}`);
const liveDir = path.resolve(root, 'dist');
const skipPrerender = process.argv.includes('--skip-prerender');

function assertInsideTemp(target: string): void {
  const rel = path.relative(tempRoot, path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to remove a path outside temp: ${target}`);
  }
}

function safeRemove(target: string): void {
  assertInsideTemp(target);
  rmSync(target, { recursive: true, force: true });
}

function acquireLock(): void {
  mkdirSync(tempRoot, { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch {
    let ownerAlive = false;
    try {
      const ownerPid = Number(readFileSync(path.join(lockDir, 'owner.txt'), 'utf8').split('\n')[0]);
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      }
    } catch { /* 上次构建被中断后留下的锁可回收 */ }
    const stale = existsSync(lockDir) && !ownerAlive;
    if (!stale) throw new Error('Another frontend build is already running');
    safeRemove(lockDir);
    mkdirSync(lockDir);
  }
  writeFileSync(path.join(lockDir, 'owner.txt'), `${process.pid}\n${new Date().toISOString()}\n`);
}

function run(label: string, entry: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): void {
  console.log(`\n[atomic-build] ${label}`);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function verifyStage(): void {
  const indexPath = path.join(stageDir, 'index.html');
  if (!existsSync(indexPath)) throw new Error('Staged build has no index.html');
  const html = readFileSync(indexPath, 'utf8');
  const refs = Array.from(html.matchAll(/(?:src|href)=["'](\/assets\/[^"'#?]+)/g), (m) => m[1]);
  if (refs.length === 0) throw new Error('Staged index.html has no hashed asset references');
  const missing = refs.filter((ref) => !existsSync(path.join(stageDir, ref.replace(/^\/+/, ''))));
  if (missing.length) throw new Error(`Staged index references missing assets: ${missing.join(', ')}`);
}

function publish(): void {
  mkdirSync(liveDir, { recursive: true });

  // Copy every immutable asset and prerendered page first. Existing hashed assets are
  // intentionally retained so already-open tabs can finish loading the previous version.
  for (const name of ['assets']) {
    const source = path.join(stageDir, name);
    if (existsSync(source)) cpSync(source, path.join(liveDir, name), { recursive: true, force: true });
  }
  cpSync(stageDir, liveDir, {
    recursive: true,
    force: true,
    filter: (source) => path.resolve(source) !== path.join(stageDir, 'index.html'),
  });

  // The root HTML is the release pointer. Replace it only after all referenced files exist.
  const stagedIndex = path.join(stageDir, 'index.html');
  const nextIndex = path.join(liveDir, `.index.html.next-${process.pid}`);
  copyFileSync(stagedIndex, nextIndex);
  renameSync(nextIndex, path.join(liveDir, 'index.html'));
}


/**
 * 清理历史构建遗留的哈希资源。
 *
 * 背景：publish() 为了「已经打开的标签页还能按旧 hash 把分包下完」**只增不删**，
 * 长期跑下来 dist/assets 会无限膨胀（2026-10-19 实测：2146 个 JS/CSS 文件、594MB）。
 * 这既拖慢每次发布的复制/上传/备份，也让 Cloudflare 回源与整目录打包越来越重。
 *
 * 保留口径（宁可多留，不误删当前版本）：
 *   ① 本次构建产出的全部 assets；
 *   ② 当前 dist 里所有 HTML（含预渲染页）引用到的 assets；
 *   ③ 最近 KEEP_RELEASES-1 次发布的资源清单（.assets-releases.json）；
 *   ④ 最近 24 小时内的文件一律不动（构建并发/紧急回滚窗口；再旧的标签页由 appRecovery 自动刷新兜底）。
 * 该文件读不到、或本次构建没有产出 assets 时，直接跳过，绝不因清单异常删光线上包。
 *
 * 为什么是 24 小时而不是更宽：实测这台机器一天能发十几次前端（每次都会产生一批带新 hash 的
 * JS/CSS），按天保留会让 dist 里的历史分包无限堆下去；24 小时 + 最近 5 次发布已经覆盖
 * 所有"还开着的标签页"的合理窗口。
 */
const RELEASES_FILE = '.assets-releases.json';
const KEEP_RELEASES = 5;
const MIN_ASSET_AGE_MS = 24 * 60 * 60 * 1000;

function listRelativeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

function collectReferencedAssets(): Set<string> {
  const refs = new Set<string>();
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(liveDir, { withFileTypes: true });
  } catch {
    return refs;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    let html = '';
    try {
      html = readFileSync(path.join(liveDir, entry.name), 'utf8');
    } catch {
      continue;
    }
    for (const match of html.matchAll(/\/assets\/([^"'#?\s)]+)/g)) refs.add(match[1]);
  }
  return refs;
}

interface ReleaseRecord {
  at: string;
  assets: string[];
}

function readReleases(): ReleaseRecord[] {
  const file = path.join(liveDir, RELEASES_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ReleaseRecord =>
        !!item && typeof item === 'object'
        && typeof (item as ReleaseRecord).at === 'string'
        && Array.isArray((item as ReleaseRecord).assets))
      .map((item) => ({ at: item.at, assets: item.assets.filter((a) => typeof a === 'string') }));
  } catch {
    return [];
  }
}

function pruneStaleAssets(currentAssets: string[]): void {
  if (process.env.XIAOYU_KEEP_STALE_ASSETS === '1') {
    console.log('[atomic-build] stale asset pruning skipped (XIAOYU_KEEP_STALE_ASSETS=1)');
    return;
  }
  if (currentAssets.length === 0) {
    console.warn('[atomic-build] no assets in this build; skip pruning to protect the live build');
    return;
  }
  const releases = readReleases();
  const keep = new Set(currentAssets);
  for (const ref of collectReferencedAssets()) keep.add(ref);
  for (const release of releases.slice(-(KEEP_RELEASES - 1))) {
    for (const asset of release.assets) keep.add(asset);
  }
  releases.push({ at: new Date().toISOString(), assets: currentAssets });
  try {
    writeFileSync(path.join(liveDir, RELEASES_FILE), JSON.stringify(releases.slice(-KEEP_RELEASES), null, 1));
  } catch { /* 清单写不进去就保守跳过清理 */ return; }

  const assetsDir = path.join(liveDir, 'assets');
  let removed = 0;
  let freed = 0;
  for (const rel of listRelativeFiles(assetsDir)) {
    if (keep.has(rel)) continue;
    const full = path.join(assetsDir, rel);
    try {
      const stat = statSync(full);
      if (Date.now() - stat.mtimeMs < MIN_ASSET_AGE_MS) continue;
      freed += stat.size;
      rmSync(full, { force: true });
      removed += 1;
    } catch { /* 单个文件删不掉不影响发布 */ }
  }
  if (removed > 0) {
    console.log('[atomic-build] pruned ' + removed + ' stale asset files (' + (freed / 1048576).toFixed(1) + ' MB); kept ' + keep.size);
  } else {
    console.log('[atomic-build] no stale assets to prune');
  }
}

acquireLock();
let scratchRegistered = false;
try {
  reclaimAbandonedBuilds(root);
  const tsx = path.resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const vite = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const buildEnv = { XIAOYU_DIST_DIR: stageDir };
  if (!existsSync(tsx) || !existsSync(vite)) throw new Error('Dependencies missing; run npm install first');

  safeRemove(stageDir);
  registerBuildScratch(root, stageDir);
  scratchRegistered = true;
  run('type check', path.resolve(root, 'scripts', 'check.mjs'));
  run('sitemap', tsx, [path.resolve(root, 'scripts', 'gen-sitemap.mts')]);
  run('vite build in isolated directory', vite, ['build'], buildEnv);
  if (!skipPrerender) run('prerender isolated build', tsx, [path.resolve(root, 'scripts', 'prerender.mts')], buildEnv);
  verifyStage();
  publish();
  // 发布完成后再清理旧哈希资源：当前版本与最近几次发布都保留，详见 pruneStaleAssets。
  pruneStaleAssets(listRelativeFiles(path.join(stageDir, 'assets')));
  console.log(`\n[atomic-build] published ${skipPrerender ? 'production' : 'SEO'} build; live dist was never emptied`);
} finally {
  try {
    if (scratchRegistered) removeBuildScratch(root, stageDir);
  } finally {
    if (existsSync(lockDir)) safeRemove(lockDir);
  }
}
