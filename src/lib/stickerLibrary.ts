/** Shared by chat and Moments. Callers load catalog.json lazily, never in a prompt.
 * This module does not send messages, consume quota, or choose when to use a sticker.
 */
export type StickerContext = 'chat' | 'moments';
export interface LibrarySticker {
  id: string;
  url: string;
  posterUrl?: string;
  title: string;
  titleZh?: string;
  titleZhHant?: string;
  alt: string;
  glyph?: string;
  categories: string[];
  tags: string[];
  style: string;
  contexts: StickerContext[];
  sourceId: string;
  license: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  animated: boolean;
  review: string;
}
export interface StickerLibrary {
  schemaVersion: 1;
  version: string;
  assets: LibrarySticker[];
}
export interface StickerSearchOptions {
  query?: string;
  context?: StickerContext;
  style?: string;
  categories?: readonly string[];
  excludeIds?: readonly string[];
  allowAnimated?: boolean;
  limit?: number;
}

export const STICKER_LIBRARY_VERSION = '2026-10-25.1';
export const STICKER_CATALOG_URL = `/stickers/catalog.json?v=${STICKER_LIBRARY_VERSION}`;
const LOCAL_ASSET = /^\/stickers\/assets\/[a-z0-9-]+\.(webp|png)$/;
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().trim();

export function isLocalStickerAsset(url: string): boolean {
  return LOCAL_ASSET.test(url);
}

/** Resolve model/user-supplied IDs through the allowlist, never use invented URLs. */
export function stickerById(catalog: StickerLibrary, id: string): LibrarySticker | undefined {
  return catalog.assets.find(a => a.id === id && isLocalStickerAsset(a.url)
    && (!a.posterUrl || isLocalStickerAsset(a.posterUrl)));
}

/** Use the static poster for reduced motion, with no additional network dependency. */
export function stickerDisplayUrl(sticker: LibrarySticker, reducedMotion = false): string {
  return reducedMotion && sticker.animated && sticker.posterUrl ? sticker.posterUrl : sticker.url;
}

function searchScore(a: LibrarySticker, query: string): number {
  if (!query) return a.categories.some(c => ['happy', 'comfort', 'greeting', 'agreement'].includes(c)) ? 2 : 1;
  const labels = [a.title, a.titleZh || '', a.titleZhHant || '', a.glyph || '', ...a.tags].map(normalize);
  let score = labels.includes(query) ? 100 : 0;
  for (const label of labels) {
    if (!label) continue;
    if (label.includes(query)) score = Math.max(score, 50);
    // Chinese aliases can occur in a longer phrase; English aliases require words.
    if (label.length >= 2 && /[\u3400-\u9fff]/u.test(label) && query.includes(label)) score += 3;
    if (/^[a-z][a-z -]+$/.test(label) && query.split(/\W+/).includes(label)) score += 2;
  }
  return score;
}

/** Metadata search with optional persona style, topic and per-character repeat filters.
 * No synthetic popularity/frequency score: this is relevance, not a trending chart.
 */
export function searchStickerLibrary(catalog: StickerLibrary, options: StickerSearchOptions = {}): LibrarySticker[] {
  const query = normalize((options.query || '').slice(0, 160));
  const limit = Math.max(0, Math.min(60, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 24));
  if (!limit || catalog.schemaVersion !== 1) return [];
  const exclude = new Set(options.excludeIds || []);
  const scored = catalog.assets.filter(a => !exclude.has(a.id)
    && isLocalStickerAsset(a.url) && (!a.posterUrl || isLocalStickerAsset(a.posterUrl))
    && (!options.context || a.contexts.includes(options.context))
    && (!options.style || a.style === options.style)
    && (!options.categories?.length || options.categories.some(c => a.categories.includes(c)))
    && (options.allowAnimated !== false || !a.animated))
    .map(asset => ({ asset, score: searchScore(asset, query) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  // Round robin equal-score styles, so a large source cannot bury all other styles.
  const result: LibrarySticker[] = [];
  const styleCounts = new Map<string, number>();
  while (scored.length && result.length < limit) {
    const top = scored[0].score;
    let best = 0;
    for (let i = 1; i < scored.length && scored[i].score === top; i++) {
      if ((styleCounts.get(scored[i].asset.style) || 0) < (styleCounts.get(scored[best].asset.style) || 0)) best = i;
    }
    const [{ asset }] = scored.splice(best, 1);
    result.push(asset);
    styleCounts.set(asset.style, (styleCounts.get(asset.style) || 0) + 1);
  }
  return result;
}
