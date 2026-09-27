/**
 * 界面皮肤选择器：展示三套皮肤（原版 / 小愈治愈系 / 东方禅意），选择即全局切换。
 */
import { useEffect, useRef } from 'react';
import { Check, Palette, Sparkles } from 'lucide-react';
import { preloadSkinImages, skinById } from '../lib/skin';
import { useSkin } from './SkinProvider';
import { t } from '../i18n';

export default function SkinSwitcher({ showHeader = true }: { showHeader?: boolean }) {
  const { skin, setSkin, skins } = useSkin();

  // 换肤前预热：面板一打开就预载所有皮肤（移动端点即切也能命中缓存）；悬停/聚焦某皮肤时再预载该皮肤
  const preloaded = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of skins) {
      if (preloaded.current.has(s.id)) continue;
      preloaded.current.add(s.id);
      preloadSkinImages(s);
    }
  }, [skins]);
  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-1.5 mb-1">
            <Palette className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold text-gray-800">{t('skinAppearance')}</h3>
          </div>
          <p className="text-[11px] text-ink-soft mb-3">{t('skinAppearanceHint')}</p>
        </>
      )}

      <div className="grid grid-cols-3 gap-2">
        {skins.map((s) => {
          const active = skin === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSkin(s.id)}
              onMouseEnter={() => preloadSkinImages(s)}
              onFocus={() => preloadSkinImages(s)}
              aria-pressed={active}
              className={'relative self-start rounded-xl overflow-hidden text-left transition-all border-2 '
                + (active ? 'border-primary shadow-sm' : 'border-clay-border hover:border-primary/60')}
            >
              {/* 预览缩略图 */}
              <span className="block h-16 bg-clay-bg">
                {s.preview ? (
                  <img src={s.preview} alt="" loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-primary"><Sparkles className="w-5 h-5" /></span>
                )}
              </span>
              <span className="block px-1.5 py-1.5 bg-white">
                <span className="block text-[11px] font-semibold text-gray-700 leading-tight">{s.label || t(s.labelKey)}</span>
              </span>
              {active && (
                <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center shadow">
                  <Check className="w-3 h-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-ink-soft mt-2.5 leading-relaxed">{skinById(skin).desc || t(skinById(skin).descKey)}</p>
    </div>
  );
}
