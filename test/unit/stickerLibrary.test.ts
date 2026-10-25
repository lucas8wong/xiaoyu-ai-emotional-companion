import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isLocalStickerAsset, searchStickerLibrary, stickerById, stickerDisplayUrl, STICKER_LIBRARY_VERSION, type StickerLibrary, type LibrarySticker } from '../../src/lib/stickerLibrary';

const fixture = (id: string, extra: Partial<LibrarySticker> = {}): LibrarySticker => ({
  id, url: `/stickers/assets/${id}.webp`, title: '抱抱', alt: '合成测试素材', categories: ['hug'],
  tags: ['抱抱', '貼貼', 'cuddle'], style: 'test-dog', contexts: ['chat', 'moments'],
  sourceId: 'synthetic-test', license: 'test-only', sourceUrl: 'https://example.com/test',
  sha256: 'test-only', bytes: 1, width: 1, height: 1, animated: false, review: 'test-only',
  rightsStatus: 'cleared', publicationAllowed: true, ...extra,
});
const catalog = (...assets: LibrarySticker[]): StickerLibrary => ({ schemaVersion: 1, version: 'test-only', assets });

test('retired public catalog contains no legacy or unapproved media', async () => {
  const active = JSON.parse(await fs.readFile('public/stickers/catalog.json', 'utf8'));
  assert.equal(active.version, STICKER_LIBRARY_VERSION);
  assert.deepEqual(active.assets, []);
  assert.deepEqual(active.sources, []);
  assert.equal(active.status, 'modern-collection-rights-review');
  assert.ok(!(await fs.readdir('public/stickers')).includes('assets'));
});

test('unverified and explicitly blocked media cannot be resolved or searched', () => {
  for (const extra of [{ rightsStatus: 'unverified' as const }, { publicationAllowed: false }]) {
    const c = catalog(fixture('blocked', extra));
    assert.equal(stickerById(c, 'blocked'), undefined);
    assert.deepEqual(searchStickerLibrary(c, { query: '抱抱' }), []);
  }
  const c = catalog(fixture('allowed'));
  assert.equal(stickerById(c, 'allowed')?.id, 'allowed');
  assert.equal(stickerById(c, 'unknown'), undefined);
});

test('shared search composes context, topic, persona, repeat and animation constraints', () => {
  const c = catalog(fixture('first'), fixture('next'), fixture('other', { style: 'test-cat' }),
    fixture('chat-only', { contexts: ['chat'] }), fixture('animated', { animated: true }),
    fixture('food', { title: '吃饭', categories: ['food'], tags: ['吃飯'] }));
  const found = searchStickerLibrary(c, { query: '貼貼', context: 'moments', style: 'test-dog', excludeIds: ['first'], allowAnimated: false });
  assert.deepEqual(found.map(a => a.id), ['next']);
  assert.deepEqual(searchStickerLibrary(c, { query: '吃飯', categories: ['food'] }).map(a => a.id), ['food']);
  assert.deepEqual(searchStickerLibrary(c, { query: 'no_matching_topic' }), []);
  assert.deepEqual(searchStickerLibrary(c, { limit: 0 }), []);
});

test('external URLs, traversal, SVGs and unsafe posters are rejected', () => {
  for (const url of ['https://example.com/a.webp', '//evil/a.webp', '/stickers/assets/../secret.png', '/stickers/assets/a.svg', '/stickers/assets/a.webp?q=secret']) {
    assert.equal(isLocalStickerAsset(url), false, url);
    for (const extra of [{ url }, { posterUrl: url }]) {
      const c = catalog(fixture('bad', extra));
      assert.equal(stickerById(c, 'bad'), undefined);
      assert.deepEqual(searchStickerLibrary(c), []);
    }
  }
});

test('reduced motion uses a static poster', () => {
  const a = fixture('motion', { animated: true, posterUrl: '/stickers/assets/motion-poster.webp' });
  assert.equal(stickerDisplayUrl(a), a.url);
  assert.equal(stickerDisplayUrl(a, true), a.posterUrl);
  assert.equal(stickerDisplayUrl(fixture('still'), true), fixture('still').url);
});

test('search caps output and balances equally relevant styles', () => {
  const rows = Array.from({ length: 100 }, (_, i) => fixture(`dog-${i}`));
  const result = searchStickerLibrary(catalog(...rows, fixture('cat', { style: 'test-cat' })), { limit: 10000 });
  assert.equal(result.length, 60);
  assert.ok(result.slice(0, 2).some(a => a.style === 'test-cat'));
});

test('curation assigns actual scenes and excludes rejected templates', async () => {
  const { classifyModernSticker, modernStickerScenes } = await import('../../scripts/lib/modernStickerScenes.mjs');
  assert.equal(new Set(modernStickerScenes.map((s: { id: string }) => s.id)).size, 27);
  assert.ok(classifyModernSticker({ family: 'E', order: 16 }).scenes.includes('hug'));
  assert.ok(classifyModernSticker({ family: 'F', order: 24 }).scenes.includes('care'));
  assert.ok(!classifyModernSticker({ family: 'A', order: 3 }).scenes.includes('kiss'));
  assert.equal(classifyModernSticker({ family: 'C', order: 23 }), null);
  assert.equal(classifyModernSticker({ family: 'I', order: 70 }), null);
  assert.equal(classifyModernSticker({ family: 'D', order: 467 }), null);
});
