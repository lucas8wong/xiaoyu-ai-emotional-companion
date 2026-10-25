import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { isLocalStickerAsset, searchStickerLibrary, stickerById, stickerDisplayUrl, type StickerLibrary } from '../../src/lib/stickerLibrary';

const root = path.resolve('public/stickers');
const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8')) as StickerLibrary;

test('bulk library contains diverse, attributed local assets for both chat and Moments', async () => {
  assert.ok(catalog.assets.length >= 2000);
  assert.equal(new Set(catalog.assets.map(a => a.id)).size, catalog.assets.length);
  assert.equal(new Set(catalog.assets.map(a => a.sha256)).size, catalog.assets.length);
  assert.ok(catalog.assets.filter(a => a.animated).length >= 100);
  assert.deepEqual([...new Set(catalog.assets.map(a => a.style))].sort(), ['3d', 'blob', 'fox']);
  for (const a of catalog.assets) {
    assert.deepEqual(a.contexts, ['chat', 'moments']);
    assert.ok(['MIT', 'Apache-2.0'].includes(a.license));
    assert.ok(a.categories.length && a.tags.length && a.sourceUrl.startsWith('https://raw.githubusercontent.com/'));
    assert.ok(a.width > 0 && a.width <= 256 && a.height > 0 && a.height <= 256, a.id);
    if (a.animated) assert.ok(a.posterUrl && isLocalStickerAsset(a.posterUrl), a.id);
  }
  for (const name of ['fluent.txt', 'blob.txt', 'blobfox.txt', 'cldr.txt']) {
    assert.ok((await fs.readFile(path.join(root, 'licenses', name))).length > 500);
  }
});

test('every asset decodes and matches its manifest hash and size; posters are static', async () => {
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < catalog.assets.length) {
      const a = catalog.assets[cursor++];
      assert.ok(isLocalStickerAsset(a.url));
      const bytes = await fs.readFile(path.resolve('public', a.url.slice(1)));
      assert.equal(bytes.length, a.bytes, a.id);
      assert.ok(bytes.length <= 512 * 1024, a.id);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), a.sha256, a.id);
      const info = await sharp(bytes, { animated: true }).metadata();
      assert.equal(info.width, a.width, a.id);
      assert.equal(info.pageHeight || info.height, a.height, a.id);
      await sharp(bytes, { animated: true }).raw().toBuffer();
      if (a.posterUrl) {
        const poster = await sharp(path.resolve('public', a.posterUrl.slice(1)), { animated: true }).metadata();
        assert.equal(poster.pages || 1, 1, a.id);
        assert.ok(poster.width! <= 256 && poster.height! <= 256, a.id);
      }
    }
  }));
});

test('Chinese daily topics and Traditional Chinese aliases retrieve relevant assets', () => {
  const examples: [string, string][] = [
    ['好困', 'tired'], ['摸摸', 'comfort'], ['收到', 'agreement'], ['下班了', 'work'],
    ['吃飯', 'food'], ['咖啡', 'drinks'], ['開心', 'happy'], ['想你', 'affection'],
    ['生日', 'celebration'], ['下雨', 'weather'], ['貓貓', 'animals'], ['吃瓜', 'waiting'],
  ];
  for (const [query, category] of examples) {
    const found = searchStickerLibrary(catalog, { query, context: 'chat', limit: 12 });
    assert.ok(found.length, query);
    assert.ok(found.some(a => a.categories.includes(category)), query);
  }
  assert.ok(searchStickerLibrary(catalog, { query: '草莓' }).some(a => /strawberry/i.test(a.title)));
  assert.ok(searchStickerLibrary(catalog, { query: 'coffee' }).some(a => a.tags.includes('coffee')));
  assert.ok(searchStickerLibrary(catalog, { query: '貓貓' }).every(a => /cat/i.test(a.title)));
  assert.ok(searchStickerLibrary(catalog, { query: '圣诞' }).every(a => a.tags.some(t => /圣诞|christmas|santa/i.test(t))));
  assert.deepEqual(searchStickerLibrary(catalog, { query: 'no_matching_topic_9876' }), []);
});

test('persona style, repeat exclusion, context and animation filters compose', () => {
  const first = searchStickerLibrary(catalog, { query: '抱抱', context: 'moments', style: 'fox', limit: 5 });
  assert.ok(first.length > 0 && first.length <= 5);
  assert.ok(first.every(a => a.style === 'fox' && a.contexts.includes('moments')));
  const next = searchStickerLibrary(catalog, { query: '抱抱', style: 'fox', excludeIds: first.map(a => a.id), allowAnimated: false, limit: 8 });
  assert.ok(next.every(a => !a.animated && !first.some(p => p.id === a.id)));
  const category = searchStickerLibrary(catalog, { categories: ['food'], limit: 10 });
  assert.ok(category.length && category.every(a => a.categories.includes('food')));
  assert.deepEqual(searchStickerLibrary(catalog, { limit: 0 }), []);
  assert.ok(searchStickerLibrary(catalog, { limit: 100000 }).length <= 60);
});

test('unknown IDs and external/path traversal assets cannot escape the local allowlist', () => {
  const known = catalog.assets[0];
  assert.equal(stickerById(catalog, known.id)?.url, known.url);
  assert.equal(stickerById(catalog, 'made-up-id'), undefined);
  for (const url of ['https://example.com/a.webp', '//evil/a.webp', '/stickers/assets/../secret.png', '/stickers/assets/a.svg', '/stickers/assets/a.webp?q=secret']) {
    assert.equal(isLocalStickerAsset(url), false, url);
    const bad = { ...catalog, assets: [{ ...known, id: 'bad', url }] };
    assert.equal(stickerById(bad, 'bad'), undefined);
    assert.deepEqual(searchStickerLibrary(bad), []);
  }
});

test('reduced motion resolves to a static poster and keeps ordinary stickers unchanged', () => {
  const animated = catalog.assets.find(a => a.animated)!;
  const still = catalog.assets.find(a => !a.animated)!;
  assert.equal(stickerDisplayUrl(animated), animated.url);
  assert.equal(stickerDisplayUrl(animated, true), animated.posterUrl);
  assert.equal(stickerDisplayUrl(still, true), still.url);
});
