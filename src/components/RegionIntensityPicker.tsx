/**
 * 地区语气 + 语气程度 选择器（复用组件）
 * 用法：对话内「地区语气」轻提示卡片（RegionNudgeCard）
 * 与 PreferencePanel 保持一致：中文 10 地区，英文 4 风格；强度 自然/明显/很强
 */
import { getLang, t } from '../i18n';
import { type Region, type Intensity } from '../services/api';

const selectedCls = 'bg-primary-strong text-white border-primary font-medium shadow-soft';
const normalCls = 'bg-white border-clay-border text-ink hover:border-primary';

const REGIONS_ZH: [Region, string][] = [
  ['putonghua', 'regionPutonghua'],
  ['dongbei', 'regionDongbei'],
  ['jingjin', 'regionJingjin'],
  ['chuanyu', 'regionChuanyu'],
  ['yuegang', 'regionYuegang'],
  ['jiangnan', 'regionJiangnan'],
  ['guanzhong', 'regionGuanzhong'],
  ['minnan', 'regionMinnan'],
  ['mindong', 'regionMindong'],
  ['taiwan', 'regionTaiwan'],
];
const REGIONS_EN: [Region, string][] = [
  ['neutral', 'regionNeutral'],
  ['us', 'regionUs'],
  ['uk', 'regionUk'],
];
const INTENSITIES: [Intensity, string][] = [
  ['natural', 'intensityNatural'],
  ['obvious', 'intensityObvious'],
  ['strong', 'intensityStrong'],
];

interface RegionIntensityPickerProps {
  region: Region;
  intensity: Intensity;
  onRegion: (r: Region) => void;
  onIntensity: (i: Intensity) => void;
  /** 是否展示语气程度（引导页：选了地区后再显示；对话卡片：一直显示） */
  showIntensity?: boolean;
}

export default function RegionIntensityPicker({ region, intensity, onRegion, onIntensity, showIntensity = true }: RegionIntensityPickerProps) {
  const isEn = getLang() === 'en';
  return (
    <div>
      <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
        {(isEn ? REGIONS_EN : REGIONS_ZH).map(([v, key]) => (
          <button
            key={v}
            type="button"
            onClick={() => onRegion(v)}
            className={'py-1.5 sm:py-2 rounded-lg text-[13px] sm:text-sm border ' + (region === v ? selectedCls : normalCls)}
          >
            {t(key)}
          </button>
        ))}
      </div>

      {showIntensity && (
        <div className="mt-3">
          <p className="text-xs text-ink-soft mb-1.5">{t('profileIntensityTitle')}</p>
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {INTENSITIES.map(([v, key]) => (
              <button
                key={v}
                type="button"
                onClick={() => onIntensity(v)}
                className={'py-1.5 sm:py-2 rounded-lg text-[13px] sm:text-sm border ' + (intensity === v ? selectedCls : normalCls)}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-ink-soft mt-2 leading-snug">{t('intensityExplainDesc')}</p>
        </div>
      )}
    </div>
  );
}
