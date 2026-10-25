/** Reproducible, resumable public-asset import. No account data or model calls.
 * node scripts/build-sticker-library.mjs --dry-run
 * node scripts/build-sticker-library.mjs --apply
 * Originals/HTTP cache: ignored temp/sticker-library; ship public/stickers in full.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { categorizeSticker, excludedSticker, stickerCategories, stickerAliasTags } from './lib/stickerTaxonomy.mjs';

const root = process.cwd();
const cache = path.join(root, 'temp/sticker-library');
const output = path.join(root, 'public/stickers');
const apply = process.argv.includes('--apply');
if (apply && process.argv.includes('--dry-run')) throw Error('Choose either --dry-run or --apply');
if (process.argv.slice(2).some(a => !['--apply', '--dry-run'].includes(a))) throw Error('Unknown import option');
const sources = [
  { id: 'fluent', repo: 'microsoft/fluentui-emoji', ref: '1ffb34c752ecf5d402f04cfb4b392c77f57c54bc', license: 'MIT', licenseFile: 'LICENSE', author: 'Microsoft Corporation', style: '3d', tree: 'fluentui-emoji' },
  { id: 'blob', repo: 'Raymo111/emoji', ref: 'ec4fa3b7d74dfd299570cb63ab6ce9d74e4b6f01', license: 'Apache-2.0', licenseFile: 'LICENSE', author: 'Blob Emoji community; Google; Raymo111', style: 'blob', tree: 'emoji' },
  { id: 'blobfox', repo: 'adri326/blobfox', ref: '445df93c31bd691ff5937a3272b42eafd453f6d3', license: 'Apache-2.0', licenseFile: 'LICENSE.txt', author: 'Feuerfuchs and the blobfox team', style: 'fox', tree: 'blobfox' },
];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const rawUrl = (s, p) => `https://raw.githubusercontent.com/${s.repo}/${s.ref}/${p.split('/').map(encodeURIComponent).join('/')}`;
await fs.mkdir(cache, { recursive: true });

async function download(url) {
  const file = path.join(cache, 'http', hash(url));
  try { return await fs.readFile(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Xiaoyu-asset-library/1.0' } });
      if (!res.ok) throw Error(`HTTP ${res.status}: ${url}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw Error(`Asset size out of bounds: ${url}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      return bytes;
    } catch (e) { last = e; }
  }
  throw last;
}

const jobs = [];
for (const source of sources) {
  const bytes = await download(`https://api.github.com/repos/${source.repo}/git/trees/${source.ref}?recursive=1`);
  const tree = JSON.parse(bytes);
  if (tree.truncated || !Array.isArray(tree.tree)) throw Error(`Incomplete source tree: ${source.id}`);
  if (source.id === 'blobfox') {
    const archive = path.join(cache, `blobfox-${source.ref}.tar.gz`);
    const buf = await download(rawUrl(source, 'blobfox.tar.gz'));
    await fs.writeFile(archive, buf);
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    // Extract only flat, explicitly named PNG files from the pinned source archive.
    const selected = entries.filter(p => /^[a-zA-Z0-9_-]+\.png$/.test(p) && !excludedSticker(p));
    const folder = path.join(cache, 'blobfox-original');
    await fs.mkdir(folder, { recursive: true });
    execFileSync('tar', ['-xf', archive, '-C', folder, ...selected]);
    jobs.push(...selected.map(p => ({ source, originalPath: `blobfox.tar.gz#${p}`, local: path.join(folder, p), name: p.replace(/\.png$/, ''), archiveSha256: hash(buf) })));
  } else {
    const selected = tree.tree.filter(x => source.id === 'fluent'
      ? /\/3D\/[^/]+\.png$/.test(x.path) && !/(Dark|Light|Medium)\/3D\//.test(x.path)
      : /^docs\/(?:a?blob[a-z0-9_]+|comfyblob|gentleblob|google(?:cat|dog|fox|bear|duck|bee|cake|heart|sun|snail|bird|blueheart|redheart))[.](?:png|gif)$/i.test(x.path));
    for (const item of selected) {
      const name = source.id === 'fluent' ? item.path.split('/')[1] : path.basename(item.path).replace(/\.[^.]+$/, '');
      if (!excludedSticker(name)) jobs.push({ source, originalPath: item.path, name });
    }
  }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidates: jobs.length, bySource: Object.fromEntries(sources.map(s => [s.id, jobs.filter(j => j.source === s).length])), categories: stickerCategories.length }));
if (!apply) process.exit(0);

await fs.mkdir(path.join(output, 'assets'), { recursive: true });
await fs.mkdir(path.join(output, 'licenses'), { recursive: true });
const sourceRecords = [];
for (const s of sources) {
  const license = await download(rawUrl(s, s.licenseFile));
  await fs.writeFile(path.join(output, 'licenses', `${s.id}.txt`), license);
  // Preserve upstream author and contribution notices, not only a generic license.
  const readme = await download(rawUrl(s, 'README.md'));
  await fs.writeFile(path.join(output, 'licenses', `${s.id}-upstream-README.md`), readme);
  sourceRecords.push({ ...s, url: `https://github.com/${s.repo}/tree/${s.ref}`, licenseUrl: `/stickers/licenses/${s.id}.txt`, upstreamReadme: `/stickers/licenses/${s.id}-upstream-README.md` });
}
// Blobfox ships an Apache attribution notice that references the full terms.
// Bundle those terms too, using the complete Apache license in the Blob source.
await fs.copyFile(path.join(output, 'licenses/blob.txt'), path.join(output, 'licenses/Apache-2.0.txt'));

const cldrRef = '91c267402229a59e3ef2774544f001bf959e8809';
const cldrBase = `https://raw.githubusercontent.com/unicode-org/cldr-json/${cldrRef}`;
const annotations = {};
for (const locale of ['zh', 'zh-Hant']) {
  const json = JSON.parse(await download(`${cldrBase}/cldr-json/cldr-annotations-full/annotations/${locale}/annotations.json`));
  annotations[locale] = json.annotations.annotations;
}
await fs.writeFile(path.join(output, 'licenses/cldr.txt'), await download(`${cldrBase}/LICENSE`));
sourceRecords.push({ id: 'cldr', author: 'Unicode, Inc.', ref: cldrRef, license: 'Unicode-3.0', url: `https://github.com/unicode-org/cldr-json/tree/${cldrRef}`, licenseUrl: '/stickers/licenses/cldr.txt', use: 'Chinese names and keyword metadata' });

const rows = [];
let cursor = 0;
let done = 0;
async function convert(job) {
  const { source, originalPath } = job;
  const original = job.local ? await fs.readFile(job.local) : await download(rawUrl(source, originalPath));
  const originalSha256 = hash(original);
  let metadata = { cldr: job.name, keywords: [], group: 'Reactions', glyph: '' };
  if (source.id === 'fluent') {
    metadata = JSON.parse(await download(rawUrl(source, `assets/${job.name}/metadata.json`)));
  }
  let category = categorizeSticker(`${metadata.cldr} ${(metadata.keywords || []).join(' ')}`, source.id !== 'fluent');
  if (category[0].id === 'misc' && source.id === 'fluent') {
    const fallback = { 'People & Body': 'people', 'Objects': 'objects', 'Symbols': 'symbols', 'Travel & Places': 'travel', 'Activities': 'play' }[metadata.group];
    if (fallback) category = [stickerCategories.find(c => c.id === fallback)];
  }
  const glyph = (metadata.glyph || '').replace(/\ufe0f/g, '');
  const localized = locale => annotations[locale][metadata.glyph] || annotations[locale][glyph];
  const zh = localized('zh');
  const zhHant = localized('zh-Hant');
  const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `${source.id}-${slug}-${originalSha256.slice(0, 10)}`;
  const input = await sharp(original, { animated: true, limitInputPixels: 64 * 1024 * 1024 }).metadata();
  const apng = input.format === 'png' && original.includes(Buffer.from('acTL'));
  const pages = input.pages || 1;
  // libvips doesn't decode APNG animation. Preserve it, never silently flatten it.
  const animated = apng || pages > 1;
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:rights>${source.author}; ${source.license}. Xiaoyu: resized/re-encoded WebP or preserved APNG; see /stickers/NOTICE.txt and catalog.json.</dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>`;
  let encoded = apng ? original : await sharp(original, { animated: true }).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 4, loop: input.loop ?? 0 }).withXmp(xmp).toBuffer();
  if (!apng && encoded.length > (animated ? 384 * 1024 : 64 * 1024)) {
    encoded = await sharp(original, { animated: true }).resize({ width: 192, height: 192, fit: 'inside', withoutEnlargement: true }).webp({ quality: 62, effort: 5, loop: input.loop ?? 0 }).withXmp(xmp).toBuffer();
  }
  if (encoded.length > 512 * 1024) throw Error(`Oversized asset: ${id}`);
  const sha256 = hash(encoded);
  const extension = apng ? 'png' : 'webp';
  const filename = `${id}-${sha256.slice(0, 10)}.${extension}`;
  await fs.writeFile(path.join(output, 'assets', filename), encoded);
  const info = await sharp(encoded, { animated: true }).metadata();
  let posterUrl;
  if (animated) {
    const poster = await sharp(original).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).withXmp(xmp).toBuffer();
    const posterName = `${id}-poster-${hash(poster).slice(0, 10)}.webp`;
    await fs.writeFile(path.join(output, 'assets', posterName), poster);
    posterUrl = `/stickers/assets/${posterName}`;
  }
  const tags = [...new Set([...category.flatMap(c => c.keywords), ...stickerAliasTags(`${metadata.cldr} ${(metadata.keywords || []).join(' ')}`, source.id !== 'fluent'), ...(metadata.keywords || []), ...(zh?.default || []), ...(zhHant?.default || []), metadata.cldr, job.name])];
  return {
    id, url: `/stickers/assets/${filename}`, posterUrl, title: metadata.cldr,
    titleZh: zh?.tts?.[0], titleZhHant: zhHant?.tts?.[0],
    alt: zh?.tts?.[0] || `${category[0].zh} · ${metadata.cldr}`, glyph: metadata.glyph || undefined,
    categories: category.map(c => c.id), tags, style: source.style,
    contexts: ['chat', 'moments'], sourceId: source.id, license: source.license,
    originalPath, originalSha256, archiveSha256: job.archiveSha256,
    sourceUrl: job.local ? rawUrl(source, 'blobfox.tar.gz') : rawUrl(source, originalPath),
    sha256, bytes: encoded.length, originalBytes: original.length,
    width: info.width, height: info.pageHeight || info.height, animated,
    frames: apng ? original.readUInt32BE(original.indexOf(Buffer.from('acTL')) + 4) : (info.pages || 1),
    review: 'source-and-filename',
  };
}
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    rows.push(await convert(job));
    done++;
    if (done % 100 === 0) console.log(`Imported ${done}/${jobs.length}`);
  }
}));
rows.sort((a, b) => a.id.localeCompare(b.id));
const seen = new Set();
const assets = rows.filter(a => { if (seen.has(a.sha256)) return false; seen.add(a.sha256); return true; });
const catalog = { schemaVersion: 1, version: '2026-10-25.1', sources: sourceRecords, categories: stickerCategories.map(({ pattern: _pattern, ...c }) => c), assets };
const report = { version: catalog.version, candidates: rows.length, uniqueAssets: assets.length, animated: assets.filter(a => a.animated).length, bySource: Object.fromEntries(sources.map(s => [s.id, assets.filter(a => a.sourceId === s.id).length])), byCategory: Object.fromEntries(stickerCategories.map(c => [c.id, assets.filter(a => a.categories.includes(c.id)).length])), originalBytes: assets.reduce((n, a) => n + a.originalBytes, 0), compressedBytes: assets.reduce((n, a) => n + a.bytes, 0) };
// Manifest replacement last: a failed/resumed import cannot expose partial catalog rows.
await fs.writeFile(path.join(output, 'catalog.next.json'), JSON.stringify(catalog));
await fs.rename(path.join(output, 'catalog.next.json'), path.join(output, 'catalog.json'));
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(path.join(output, 'NOTICE.txt'), `Xiaoyu sticker library\n\nFluent Emoji: Copyright (c) Microsoft Corporation. MIT.\nBlob Emoji: Blob Emoji community, Google and Raymo111. Apache-2.0.\nBlobfox: Feuerfuchs and the blobfox team. Apache-2.0.\nChinese annotation metadata: Copyright Unicode, Inc., Unicode-3.0.\n\nLocal modifications: resized/re-encoded as WebP; APNG motion preserved in PNG; static posters added; application search tags added.\nPer-file source, SHA-256, license and modifications: catalog.json; full upstream terms and credits: licenses/.\nFilename screening is not full visual approval. No live popularity ranking is claimed.\n`);
console.log(JSON.stringify(report));
