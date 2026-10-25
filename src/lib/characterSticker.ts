/** Persist attachments separately from spoken text and model history. */
export interface CharacterSticker {
  id: string;
  version: string;
  url: string;
  posterUrl?: string;
  alt: string;
  width: number;
  height: number;
  animated: boolean;
}

const LOCAL = /^\/api\/stickers\/local\/[a-z0-9-]+\.(?:webp|png)$/;
export function validCharacterSticker(value: unknown): value is CharacterSticker {
  if (!value || typeof value !== 'object') return false;
  const a = value as CharacterSticker;
  return typeof a.id === 'string' && /^[a-z0-9-]{1,100}$/.test(a.id)
    && typeof a.version === 'string' && a.version.length <= 40
    && typeof a.url === 'string' && LOCAL.test(a.url)
    && (!a.posterUrl || LOCAL.test(a.posterUrl))
    && typeof a.alt === 'string' && a.alt.length > 0 && a.alt.length <= 160
    && Number.isInteger(a.width) && a.width > 0 && a.width <= 1024
    && Number.isInteger(a.height) && a.height > 0 && a.height <= 1024
    && typeof a.animated === 'boolean' && (!a.animated || !!a.posterUrl);
}
