/**
 * 隐私政策与免责声明弹窗
 */

import { useEffect, useState } from 'react';
import { X, ShieldCheck } from 'lucide-react';
import { savePreferences } from '../services/api';
import { loadPreferences, setCachedPreferences } from '../lib/prefsCache';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface PrivacyModalProps {
  open: boolean;
  onClose: () => void;
}

export default function PrivacyModal({ open, onClose }: PrivacyModalProps) {
  const [enhance, setEnhance] = useState(true);
  const [awareness, setAwareness] = useState(true);
  useEffect(() => {
    if (!open) return;
    loadPreferences().then(p => {
      if (p) {
        if (typeof p.dataEnhance === 'boolean') setEnhance(p.dataEnhance);
        if (typeof p.activityAwareness === 'boolean') setAwareness(p.activityAwareness);
      }
    });
  }, [open]);
  const toggleEnhance = async () => {
    const next = !enhance;
    setEnhance(next);
    try { const r = await savePreferences({ dataEnhance: next }); if (r.success && r.data) setCachedPreferences(r.data); } catch { /* 忽略 */ }
  };
  const toggleAwareness = async () => {
    const next = !awareness;
    setAwareness(next);
    try { const r = await savePreferences({ activityAwareness: next }); if (r.success && r.data) setCachedPreferences(r.data); } catch { /* 忽略 */ }
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[80] bg-black/50 flex items-center justify-center p-4" width="max-w-lg" maxHeight="max-h-[85vh]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 bg-primary-soft rounded-full flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{t('privacyTitle')}</h2>
        </div>

        <div className="space-y-4 text-sm text-gray-600 leading-relaxed">
          <section>
            <h3 className="font-semibold text-gray-800 mb-1">{t('pvS1Title')}</h3>
            <p>{t('pvS1P1')}</p>
            <p>{t('pvS1P2')}</p>
            <p>{t('pvS1P3')}</p>
            <p>{t('pvS1P4')}</p>
            <p>{t('pvS1P5')}</p>
            <p>{t('pvS1P6')}</p>
            <p>{t('pvS1P7')}</p>
            <p>{t('pvS1P8')}</p>
          </section>
          <section className="bg-clay-bg border border-clay-border rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-800">{t('privacyEnhTitle')}</p>
                <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('privacyEnhDesc')}</p>
              </div>
              <button
                type="button"
                onClick={toggleEnhance}
                aria-checked={enhance}
                role="switch"
                className={'relative w-11 h-6 rounded-full flex-shrink-0 transition-colors ' + (enhance ? 'bg-primary' : 'bg-gray-300')}
              >
                <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (enhance ? 'left-[22px]' : 'left-0.5')} />
              </button>
            </div>
          </section>
          <section className="bg-clay-bg border border-clay-border rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-800">{t('activityAwareTitle')}</p>
                <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('activityAwareDesc')}</p>
              </div>
              <button
                type="button"
                onClick={toggleAwareness}
                aria-checked={awareness}
                role="switch"
                className={'relative w-11 h-6 rounded-full flex-shrink-0 transition-colors ' + (awareness ? 'bg-primary' : 'bg-gray-300')}
              >
                <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (awareness ? 'left-[22px]' : 'left-0.5')} />
              </button>
            </div>
          </section>
          <section>
            <h3 className="font-semibold text-gray-800 mb-1">{t('pvS2Title')}</h3>
            <p>{t('pvS2P1')}</p>
            <p>{t('pvS2P2')}</p>
          </section>
          <section>
            <h3 className="font-semibold text-gray-800 mb-1">{t('pvS3Title')}</h3>
            <p>{t('pvS3P1')}</p>
            <p>{t('pvS3P2')}</p>
            <p>{t('pvS3P3')}</p>
          </section>
        </div>
    </Modal>
  );
}