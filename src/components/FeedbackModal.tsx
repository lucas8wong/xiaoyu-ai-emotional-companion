/**
 * 意见反馈（独立弹窗）
 * 从首页显眼入口打开，或从各 AI 输出旁的「小标」打开（可附带 AI 回答 / 对话上下文）
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SkinFeedbackIcon } from './SkinIcon';
import { saveFeedback } from '../services/api';
import { useAppStore } from '../store/useAppStore';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
}

export default function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const feedbackContext = useAppStore(s => s.feedbackContext);
  const feedbackType = useAppStore(s => s.feedbackType);
  const setFeedbackContext = useAppStore(s => s.setFeedbackContext);
  const setFeedbackType = useAppStore(s => s.setFeedbackType);

  const [fbType, setFbType] = useState('suggest');
  const [fbContent, setFbContent] = useState('');
  const [fbContact, setFbContact] = useState('');
  const [attachContext, setAttachContext] = useState(true);
  const [fbMsg, setFbMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开时同步初始值；关闭时清掉上下文，避免串到下次全局反馈
  useEffect(() => {
    if (open) {
      setFbType(feedbackType || 'suggest');
      setFbContent('');
      setFbContact('');
      setAttachContext(!!feedbackContext);
      setFbMsg(null);
    } else {
      setFeedbackContext(null);
      setFeedbackType('suggest');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleSend = async () => {
    if (fbContent.trim().length < 2) { setFbMsg({ type: 'err', text: t('errFeedbackShort') }); return; }
    setBusy(true);
    const ctx = attachContext && feedbackContext ? feedbackContext : undefined;
    const r = await saveFeedback(fbType, fbContent, fbContact, ctx);
    setBusy(false);
    if (r.success) {
      const reward = r.data?.reward;
      setFbMsg({ type: 'ok', text: reward?.granted ? t('profileFeedbackReward', { n: reward.count }) : t('profileFeedbackSent') });
      setFbContent(''); setFbContact('');
    } else {
      setFbMsg({ type: 'err', text: r.error || t('errSaveFailed') });
    }
  };

  return (
    <Modal open={open} onClose={onClose} padding="p-5">
        <div className="text-center mb-5">
          <div className="w-14 h-14 bg-primary-soft rounded-xl overflow-hidden flex items-center justify-center mx-auto mb-3">
            <SkinFeedbackIcon className="w-full h-full" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{t('profileFeedback')}</h2>
          <p className="text-sm text-ink-soft mt-1">{t('profileFeedbackSent')}</p>
          <p className="text-xs text-amber-600 mt-1">{t('feedbackRewardHint')}</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-ink-soft mb-1">{t('fbTypeLabel')}</label>
            <select value={fbType} onChange={(e) => setFbType(e.target.value)} className="w-full px-3 py-2 border border-clay-border rounded-lg text-sm bg-white">
              {[['suggest', t('fbTypeSuggest')], ['issue', t('fbTypeIssue')], ['praise', t('fbTypePraise')], ['other', t('fbTypeOther')]].map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-soft mb-1">{t('profileFeedbackPh')}</label>
            <textarea
              value={fbContent}
              onChange={(e) => setFbContent(e.target.value)}
              placeholder={t('profileFeedbackPh')}
              rows={4}
              className="w-full px-3 py-2 border border-clay-border rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
            />
          </div>
          {feedbackContext && (
            <label className="flex items-start gap-2 bg-primary-lighter border border-clay-border rounded-lg px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={attachContext}
                onChange={(e) => setAttachContext(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <span className="text-xs text-ink-soft leading-relaxed">{t('fbAttachContext')}</span>
            </label>
          )}
          <div>
            <label className="block text-xs text-ink-soft mb-1">{t('profileContactPh')}</label>
            <input
              value={fbContact}
              onChange={(e) => setFbContact(e.target.value)}
              placeholder={t('profileContactPh')}
              className="w-full px-3 py-2 border border-clay-border rounded-lg text-sm bg-white"
            />
          </div>
          <button
            onClick={handleSend}
            disabled={busy}
            className="w-full bg-primary-strong text-white py-2.5 rounded-lg text-sm font-medium hover:bg-primary disabled:opacity-50"
          >
            {busy ? t('profileLoading') : t('profileSendFeedback')}
          </button>
          {fbMsg && <p className={`text-xs ${fbMsg.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{fbMsg.text}</p>}
        </div>
    </Modal>
  );
}
