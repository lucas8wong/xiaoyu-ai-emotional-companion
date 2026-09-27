/**
 * 设置说明弹窗（个性化偏好，合并为一个 ⓘ）
 * 入口：个性化偏好区块标题旁的 ⓘ（PreferenceInfo）
 * 内容：作用范围（聊一聊 & 理一理，不含角色扮演）+ 这里实际有的全局项；
 *       地区语气/语气程度/智能贴合/内心独白已在「聊一聊 - 小愈怎么陪你」里设置，此处只作提示
 *       （「陪伴方式」档位自 2026-09-23 起整体退场，不再出现在任何设置里）。
 */
import { X } from 'lucide-react';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { Banner } from './ui/Surface';

interface SettingExplainModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingExplainModal({ open, onClose }: SettingExplainModalProps) {
  if (!open) return null;

  // 在渲染内取文案，保证跟随当前语言（不在模块加载时固化）
  const globalItems: [string, string][] = [
    [t('profileProactivePush'), t('profileProactivePushDesc')],
  ];

  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[70] bg-black/40 flex items-center justify-center p-4" padding="p-5" maxHeight="max-h-[85vh]" showClose={false}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-800">{t('prefsExplainTitle')}</h3>
          <button type="button" onClick={onClose} className="p-1 -mr-1 rounded-full hover:bg-gray-100 transition-colors" aria-label="close">
            <X className="w-5 h-5 text-ink-soft" />
          </button>
        </div>

        <div className="text-left">
          {/* 作用范围 */}
          <Banner tone="mint" className="mb-3" title={<span className="text-[13px] font-normal leading-relaxed">{t('prefsExplainScope')}</span>} />

          {/* 移入聊一聊的提示 */}
          <Banner tone="amber" className="mb-4" title={<span className="text-[13px] font-normal leading-relaxed">{t('prefsExplainMoved')}</span>} />

          {/* 这里实际有的全局项 */}
          <section>
            <h4 className="text-sm font-semibold text-ink mb-2.5">{t('prefsExplainHere')}</h4>
            <div className="space-y-2">
              {globalItems.map(([label, desc]) => (
                <div key={label} className="rounded-xl border border-clay-border bg-clay-muted/40 px-3 py-2.5">
                  <p className="text-[13px] font-semibold text-gray-800">{label}</p>
                  <p className="text-[12px] text-ink-soft leading-relaxed mt-0.5">{desc}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
    </Modal>
  );
}
