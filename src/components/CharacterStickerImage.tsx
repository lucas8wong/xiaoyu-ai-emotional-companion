import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { validCharacterSticker, type CharacterSticker } from '../lib/characterSticker';
import { getLang } from '../i18n';

/** Optional media never becomes a system/fallback message when unavailable. */
export default function CharacterStickerImage({ sticker }: { sticker: CharacterSticker }) {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [playing, setPlaying] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<'none' | 'motion' | 'all'>('none');
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReduced(media.matches); setPlaying(null); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  if (!validCharacterSticker(sticker) || failed === 'all') return null;
  const motion = sticker.animated && (playing ?? !reduced) && failed !== 'motion';
  const src = motion ? sticker.url : sticker.posterUrl || sticker.url;
  const lang = getLang();
  const label = motion ? lang === 'en' ? 'Pause sticker' : lang === 'zh-TW' ? '暫停表情動畫' : '暂停表情动画'
    : lang === 'en' ? 'Play sticker' : lang === 'zh-TW' ? '播放表情動畫' : '播放表情动画';
  return <figure className="relative my-2 w-fit max-w-full" data-character-sticker={sticker.id}>
    <img src={src} alt={sticker.alt} width={sticker.width} height={sticker.height} loading="lazy" decoding="async"
      className="h-auto max-h-44 w-36 max-w-full object-contain"
      onError={() => setFailed(motion && sticker.posterUrl ? 'motion' : 'all')} />
    {sticker.animated && failed === 'none' && <button type="button" aria-label={label} title={label}
      aria-pressed={motion} onClick={() => setPlaying(!motion)}
      className="absolute bottom-0 end-0 flex h-11 w-11 items-center justify-center rounded-full border border-clay-border bg-clay-surface/95 text-ink-soft shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      {motion ? <Pause className="h-4 w-4" aria-hidden="true"/> : <Play className="h-4 w-4" aria-hidden="true"/>}
    </button>}
  </figure>;
}
