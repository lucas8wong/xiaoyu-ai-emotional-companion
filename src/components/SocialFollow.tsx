/**
 * 社交关注条：Instagram（跳转）
 * 用于 分享卡/关于页/主页底部/「我的」 等推广位
 */
import { Instagram, Mail } from 'lucide-react';
import { t } from '../i18n';
import { SUPPORT_EMAIL } from '../lib/support';

export default function SocialFollow({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <div className={'flex flex-col items-center gap-1.5 ' + className}>
      {!compact && <p className="text-xs text-ink-soft">{t('socialFollow')}</p>}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[13px]">
        <a href="https://instagram.com/your_xiaoyu" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-primary-text hover:text-primary font-medium">
          <Instagram className="w-4 h-4" /> {t('socialIg')}
        </a>
        <a href={'mailto:' + SUPPORT_EMAIL} className="inline-flex items-center gap-1.5 text-primary-text hover:text-primary font-medium">
          <Mail className="w-4 h-4" /> {t('socialEmail')}
        </a>
      </div>
    </div>
  );
}
