// Retirement guard: old commands cannot refill the collection rejected on 2026-10-25.
if (process.argv.includes('--apply')) {
  throw Error('Legacy sticker collection retired. Use scripts/collect-modern-stickers.mjs for the approved modern families.');
}
console.log(JSON.stringify({ retired: true, activeLegacyAssets: 0, replacement: 'scripts/collect-modern-stickers.mjs' }));
