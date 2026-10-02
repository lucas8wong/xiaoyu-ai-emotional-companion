/**
 * 个性化偏好（独立弹窗，从「我的」独立出来）
 */
import { Settings2 } from 'lucide-react';
import PreferenceInfo from './PreferenceInfo';
import PreferencePanel from './PreferencePanel';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { SectionCard } from './ui/Surface';
import type { PwaInstallMode } from '../hooks/usePwaInstall';

interface PreferencesModalProps {
  open: boolean;
  onClose: () => void;
  onFeedback?: () => void;
  onRequestMembership?: () => void; // 非 Pro 点击「最大」档时触发会员升级引导
  focusProactivePush?: boolean; // 直达「主动找我」：打开后定位/高亮推送开关
  /** 「AI 主动找我」里的「装到桌面/主屏」引导（2026-10-02）：Home 的 usePwaInstall 单例注入 */
  pwaInstall?: { installed: boolean; mode: PwaInstallMode; promptInstall: () => Promise<string> } | null;
}

export default function PreferencesModal({ open, onClose, onFeedback, onRequestMembership, focusProactivePush = false, pwaInstall = null }: PreferencesModalProps) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose}>
        <div className="text-center mb-5">
          <div className="w-12 h-12 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-2">
            <Settings2 className="w-6 h-6 text-primary" />
          </div>
          <div className="flex items-center justify-center gap-1">
            <h2 className="text-xl font-bold text-gray-800">{t('profilePrefs')}</h2>
            <PreferenceInfo />
          </div>
        </div>
        <SectionCard className="p-4">
          <PreferencePanel variant="global" onFeedback={onFeedback} onRequestMembership={onRequestMembership} focusProactivePush={focusProactivePush} pwaInstall={pwaInstall} />
        </SectionCard>
    </Modal>
  );
}
