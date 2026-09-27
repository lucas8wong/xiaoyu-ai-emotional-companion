/**
 * 界面外观（独立弹窗）
 * 从「个性化偏好」里拆出来：只展示皮肤切换 + 白板卡片透明度调节，不混入 AI 对话偏好。
 */
import { X, Palette } from 'lucide-react';
import SkinSwitcher from './SkinSwitcher';
import { useSkin } from './SkinProvider';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { SectionCard } from './ui/Surface';
import './usage-slider.css';

interface AppearanceModalProps {
  open: boolean;
  onClose: () => void;
}

export default function AppearanceModal({ open, onClose }: AppearanceModalProps) {
  const { cardBgAlpha, setCardBgAlpha, skin, bgWash, setBgWash, meta } = useSkin();
  if (!open) return null;

  const pct = Math.round(cardBgAlpha * 100);
  const washPct = Math.round(bgWash * 100);
  const bgPreview = meta.bg || meta.bgPortrait || '/skins/healing/bg.webp?v=3';

  return (
    <Modal open={open} onClose={onClose}>
        <div className="text-center mb-5">
          <div className="w-12 h-12 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-2">
            <Palette className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-xl font-bold text-gray-800">{t('skinAppearance')}</h2>
          <p className="text-sm text-ink-soft mt-1">{t('skinAppearanceHint')}</p>
        </div>
        <SectionCard className="p-4 space-y-4">
          <SkinSwitcher showHeader={false} />

          {/* 白板卡片不透明度调节：滑块 0–100 与数字 1:1 对齐（0=全透，100=不透）；默认 80%） */}
          <div className="pt-3 border-t border-clay-border/70">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-sm font-semibold text-gray-800">{t('cardTransparency')}</p>
              <span className="text-sm font-bold text-primary-text tabular-nums">{pct}%</span>
            </div>
            <p className="text-[11px] text-ink-soft mb-2.5 leading-relaxed">{t('cardTransparencyHint')}</p>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={cardBgAlpha}
              onChange={(e) => setCardBgAlpha(Number(e.target.value))}
              className="usage-slider"
              style={{ '--usage-fill': pct + '%' } as React.CSSProperties}
              aria-label={t('cardTransparency')}
            />
            {/* 实时预览：迷你背景上叠一张半透明白卡 */}
            <div
              className="mt-3 rounded-xl overflow-hidden border border-clay-border"
              style={{
                backgroundImage:
                  'radial-gradient(120px 60px at 20% 20%, rgba(134,239,172,.45), transparent 60%), radial-gradient(120px 60px at 80% 0%, rgba(253,230,138,.5), transparent 60%), linear-gradient(135deg, #FBF6EE, #E9F5EC)',
              }}
            >
              <div className="card-white m-4 rounded-lg px-3 py-2 shadow-sm">
                <p className="text-[12px] font-semibold text-gray-800 leading-tight">{t('cardTransparencyPreview')}</p>
                <p className="text-[10px] text-ink-soft mt-0.5">{t('cardTransparencyPreviewSub')}</p>
              </div>
            </div>
          </div>

          {/* 氛围背景深浅调节：所有皮肤都可调（滑块 0=背景明显/深，100=全浅/背景淡） */}
          {skin && (
            <div className="pt-3 border-t border-clay-border/70">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-sm font-semibold text-gray-800">{t('bgWash')}</p>
                <span className="text-sm font-bold text-primary-text tabular-nums">{washPct}%</span>
              </div>
              <p className="text-[11px] text-ink-soft mb-2.5 leading-relaxed">{t('bgWashHint')}</p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={bgWash}
                onChange={(e) => setBgWash(Number(e.target.value))}
                className="usage-slider"
                style={{ '--usage-fill': washPct + '%' } as React.CSSProperties}
                aria-label={t('bgWash')}
              />
              {/* 实时预览：在当前皮肤背景上叠一层对应深浅、当前肤色的柔光罩 */}
              <div
                className="mt-3 rounded-xl overflow-hidden border border-clay-border h-16"
                style={{
                  backgroundImage:
                    `linear-gradient(rgb(var(--skin-bg-wash-color) / ${bgWash}), rgb(var(--skin-bg-wash-color) / ${bgWash})), url("${bgPreview}")`,
                  backgroundSize: 'cover, cover',
                  backgroundPosition: 'center, center',
                }}
              />
              <p className="text-[10px] text-ink-soft mt-1">{t('bgWashPreview')}</p>
            </div>
          )}
        </SectionCard>
    </Modal>
  );
}
