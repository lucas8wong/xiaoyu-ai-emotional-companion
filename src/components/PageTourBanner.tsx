/**
 * 页面首次进入提示条（一次性）
 * 聊一聊 / 理一理 / 角色扮演 各自第一次进入时，在顶部显示一句「这里有什么」，
 * 用户关闭后不再显示（按页面 localStorage 标记）
 */

import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { t } from '../i18n';

const FLAGS: Record<string, string> = {
  chat: 'cure_tour_chat_seen',
  structure: 'cure_tour_structure_seen',
  roleplay: 'cure_tour_rp_seen',
};

export default function PageTourBanner({ page, className = '' }: { page: 'chat' | 'structure' | 'roleplay'; className?: string }) {
  const [show, setShow] = useState<boolean>(() => {
    try { return localStorage.getItem(FLAGS[page]) !== '1'; } catch { return false; }
  });
  if (!show) return null;
  const dismiss = () => {
    try { localStorage.setItem(FLAGS[page], '1'); } catch { /* 忽略 */ }
    setShow(false);
  };
  const text = page === 'chat' ? t('tourChat') : page === 'structure' ? t('tourStructure') : t('tourRoleplay');
  return (
    <div className={'bg-primary-lighter border-b border-clay-border px-3 py-2 text-xs text-primary-text flex items-center gap-2 ' + className}>
      <Sparkles className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 leading-relaxed">{text}</span>
      <button onClick={dismiss} aria-label={t('uiTourDone')} title={t('uiTourDone')} className="p-1 text-primary-text/70 hover:text-primary-text flex-shrink-0">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
