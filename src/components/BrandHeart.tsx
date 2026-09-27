/**
 * 品牌心形 mark：当前皮肤有心形图 → 白色圆角徽章内显示心形图；无（原版皮肤）→ 回退绿圆白心图标。
 * boxClass：尺寸 + 留白（如 'w-14 h-14 sm:w-16 sm:h-16 mx-auto mb-4'）；iconClass：回退图标大小。
 */
import { Heart } from 'lucide-react';
import { useSkin } from './SkinProvider';
import { t } from '../i18n';

export default function BrandHeart({ boxClass, iconClass = 'w-7 h-7 sm:w-8 sm:h-8 text-white' }: { boxClass: string; iconClass?: string }) {
  const { meta } = useSkin();
  if (meta.heart) {
    return (
      <div className={boxClass + ' overflow-hidden bg-white rounded-2xl shadow-lift ring-4 ring-white/50'}>
        <img src={meta.heart} alt={t('appName')} loading="lazy" className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div className={boxClass + ' bg-primary rounded-full flex items-center justify-center shadow-lift'}>
      <Heart className={iconClass} />
    </div>
  );
}
