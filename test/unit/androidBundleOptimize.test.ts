import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { androidMediaPlan, compactAndroidImage, optimizeAndroidBundle } from '../../scripts/lib/androidBundleOptimize.mts';

test('optimization is confined to art and background music; UI, fonts and effects stay intact', () => {
  for (const p of ['skins/pixel/a.webp', 'pay-qr.jpg', 'fonts/a.woff2', 'audio/reward.mp3', 'media/help.mp4', 'assets/main.js']) assert.equal(androidMediaPlan(p), undefined);
  assert.equal(androidMediaPlan('assets/scene-123.webp')?.kind, 'image');
  assert.equal(androidMediaPlan('music/story.mp3')?.kind, 'audio');
});

test('rejects production and non-generated directories before touching files', async () => {
  await assert.rejects(optimizeAndroidBundle({ root: 'public', cache: 'temp/android-media-cache', ffmpeg: 'missing', ffprobe: 'missing' }), /isolated Android/);
});

test('large transparent art keeps its aspect ratio and alpha while fitting the mobile limit', async () => {
  const pixels = Buffer.alloc(1536 * 1024 * 4);
  let seed = 37;
  for (let i = 0; i < pixels.length; i += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[i] = (seed >>> 24) & 255; pixels[i + 1] = (seed >>> 16) & 255;
    pixels[i + 2] = (seed >>> 8) & 255; pixels[i + 3] = 128;
  }
  const input = await sharp(pixels, { raw: { width: 1536, height: 1024, channels: 4 } }).webp({ lossless: true }).toBuffer();
  const plan = androidMediaPlan('assets/test.webp')!;
  assert.equal(plan.kind, 'image');
  if (plan.kind !== 'image') return;
  const output = await compactAndroidImage(input, plan);
  assert.ok(output.length <= input.length);
  const meta = await sharp(output).metadata();
  assert.equal(meta.hasAlpha, true);
  assert.ok(Math.abs(meta.width! / meta.height! - 1.5) < 0.003);
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 853);
});
