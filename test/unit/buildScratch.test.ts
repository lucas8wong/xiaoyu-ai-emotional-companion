import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBuildScratch, removeBuildScratch, reclaimAbandonedBuilds } from '../../scripts/lib/buildScratch.mts';

function fixture(run: (root: string, dir: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-scratch-test-'));
  fs.mkdirSync(path.join(root, 'temp'));
  try { run(root, path.join(root, 'temp/dist-next-123')); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('only new generated scratch paths can be registered', () => fixture((root, dir) => {
  for (const name of ['data', 'dist', 'temp/natural-memory-release', 'temp/../data']) {
    assert.throws(() => registerBuildScratch(root, path.join(root, name)));
  }
  fs.mkdirSync(dir);
  assert.throws(() => registerBuildScratch(root, dir), /new path/);
}));

test('normal cleanup handles readonly generated assets without touching history', () => fixture((root, dir) => {
  const history = path.join(root, 'temp/retained-history');
  fs.writeFileSync(history, 'keep');
  registerBuildScratch(root, dir);
  fs.mkdirSync(dir);
  const asset = path.join(dir, 'asset.js');
  fs.writeFileSync(asset, 'generated');
  fs.chmodSync(asset, 0o400);
  removeBuildScratch(root, dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(history, 'utf8'), 'keep');
}));

test('protected files fail closed before deleting any generated contents', () => fixture((root, dir) => {
  registerBuildScratch(root, dir);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'asset.js'), 'keep on failure');
  fs.writeFileSync(path.join(dir, 'backup.sqlite'), 'protected');
  assert.throws(() => removeBuildScratch(root, dir), /Protected/);
  assert.equal(fs.readFileSync(path.join(dir, 'asset.js'), 'utf8'), 'keep on failure');
}));

test('abandoned sweep keeps active owners and unregistered old directories', () => fixture((root, dir) => {
  registerBuildScratch(root, dir);
  fs.mkdirSync(dir);
  const unknown = path.join(root, 'temp/dist-next-456');
  fs.mkdirSync(unknown);
  reclaimAbandonedBuilds(root, Date.now() + 2 * 3600_000);
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(unknown));
}));

test('a dead owner can be reclaimed after the grace period', () => fixture((root, dir) => {
  registerBuildScratch(root, dir);
  fs.mkdirSync(dir);
  const record = path.join(root, 'temp/.build-scratch/dist-next-123.json');
  const owner = JSON.parse(fs.readFileSync(record, 'utf8'));
  owner.pid = 2147483647;
  fs.writeFileSync(record, JSON.stringify(owner));
  reclaimAbandonedBuilds(root);
  assert.ok(fs.existsSync(dir));
  reclaimAbandonedBuilds(root, Date.now() + 2 * 3600_000);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(record), false);
}));

test('directory links cannot redirect cleanup to protected contents', () => fixture((root, dir) => {
  registerBuildScratch(root, dir);
  fs.mkdirSync(dir);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'backup.sqlite'), 'keep');
  fs.symlinkSync(data, path.join(dir, 'linked'), 'junction');
  assert.throws(() => removeBuildScratch(root, dir), /linked/);
  assert.equal(fs.readFileSync(path.join(data, 'backup.sqlite'), 'utf8'), 'keep');
}));
