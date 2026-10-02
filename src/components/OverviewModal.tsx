/**
 * 功能概览弹窗：回看「小愈能为你做什么？」
 * 内容与引导页第 2 页一致：两个功能（聊一聊 / 理一理）+ 地区口音（陪伴方式自 2026-09-23 起不设档位，不在此列）
 * 移动端优先
 */

import { MessageCircle, Compass, Sparkles, Languages } from 'lucide-react';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface OverviewModalProps {
  open: boolean;
  onClose: () => void;
}

export default function OverviewModal({ open, onClose }: OverviewModalProps) {
  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} width="max-w-sm" padding="p-5">
        <div className="text-center mb-4 pt-1">
          <h2 className="text-lg sm:text-xl font-bold text-gray-800 leading-snug">
            {t('obOverviewTitle')}
          </h2>
          <p className="text-[13px] text-ink-soft mt-1 leading-relaxed whitespace-pre-line">
            {t('obOverviewSub')}
          </p>
        </div>

        <div className="space-y-2.5">
          {/* 功能1：聊一聊 */}
          <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-2.5">
            <span className="w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryChatTitle')}</p>
              <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewChatDesc')}</p>
            </div>
          </div>
          {/* 功能2：理一理 */}
          <div className="flex items-start gap-3 rounded-xl border-2 border-accent/25 bg-accent-soft px-3.5 py-2.5">
            <span className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center flex-shrink-0">
              <Compass className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryStructureTitle')}</p>
              <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewStructureDesc')}</p>
            </div>
          </div>
          {/* 功能3：角色剧情扮演 */}
          <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-gradient-to-r from-primary-lighter to-accent-soft px-3.5 py-2.5">
            <span className="w-9 h-9 rounded-full bg-primary-strong text-white flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800 leading-tight">{t('roleplayTitle')}</p>
              <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('aboutRoleplayDesc')}</p>
            </div>
          </div>
          {/* 附注：地区语气（中文 10 地区 / 英文 4 风格） */}
          <div className="flex items-start gap-3 rounded-xl border-2 border-clay-border bg-white px-3.5 py-2.5">
            <span className="w-9 h-9 rounded-full bg-primary-soft text-primary flex items-center justify-center flex-shrink-0">
              <Languages className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800 leading-tight">{t('obOverviewRegionTitle')}</p>
              <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewRegionDesc')}</p>
            </div>
          </div>
          <div className="rounded-xl bg-gray-50 border border-gray-100 px-3.5 py-2.5">
            <p className="text-[11px] text-ink-soft leading-relaxed text-center">{t('obOverviewDimNote')}</p>
          </div>
        </div>
    </Modal>
  );
}
