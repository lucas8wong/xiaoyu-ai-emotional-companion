/**
 * 「个性化偏好」ⓘ 说明入口（自包含）：ⓘ 按钮 + 打开说明弹窗
 * 放在「个性化偏好」区块标题旁；与 PreferencePanel 解耦，可多处复用。
 */
import { useState } from 'react';
import { Info } from 'lucide-react';
import { t } from '../i18n';
import SettingExplainModal from './SettingExplainModal';

export default function PreferenceInfo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="p-0.5 rounded-full text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-all"
        aria-label={t('prefsExplainTitle')}
        title={t('prefsExplainTitle')}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      <SettingExplainModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
