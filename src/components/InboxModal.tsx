/**
 * 小愈信箱（站内信弹窗）
 *
 * 定位：**留存层**。奖励弹窗（首页琥珀横幅）只负责叫醒——它 5 秒后 ack 即清，
 * 运营者写给用户的那段话（note）如果只挂在弹窗上，错过就永远找不回来。
 * 这里的信按 userId 存在后端（api/services/inbox.ts），随时可回看，
 * 而且**游客也能收**（运营端的奖励邮件到不了没有邮箱的游客）。
 *
 * 交互约定：
 *   · 打开即全部已读（后端标记，本地同步红点）——信不是待办，不需要用户逐封点确认；
 *   · 未读样式按「打开那一刻」的状态渲染，不在本次会话里被刚标记的已读抹掉（用户才看得清哪封是新的）。
 */

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import Modal from './ui/Modal';
import { getInbox, readInbox, type InboxLetter } from '../services/api';
import { t } from '../i18n';

interface InboxModalProps {
  open: boolean;
  onClose: () => void;
  /** 未读数变化回调（「我的」卡片上的红点据此实时更新） */
  onUnreadChange?: (n: number) => void;
}

/** 信件时间：短格式（本地化），跨年只显示月日已足够——信箱是近期记忆 */
function formatWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function InboxModal({ open, onClose, onUnreadChange }: InboxModalProps) {
  const [letters, setLetters] = useState<InboxLetter[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    getInbox()
      .then((r) => {
        if (!alive) return;
        if (r.success && r.data) {
          setLetters(r.data.items);
          // 打开信箱 = 已读：后端是权威，本地只负责把红点同步掉
          if (r.data.unread > 0) {
            void readInbox().then((rr) => {
              if (alive && rr.success && rr.data) onUnreadChange?.(rr.data.unread);
            });
          } else {
            onUnreadChange?.(0);
          }
        }
        setLoading(false);
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t('inboxTitle')} subtitle={t('inboxDesc')} maxHeight="max-h-[85vh]">
      {loading && letters.length === 0 ? (
        <div className="py-10 text-center">
          <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin mx-auto" />
        </div>
      ) : letters.length === 0 ? (
        <div className="py-10 text-center">
          <div className="w-12 h-12 rounded-full bg-primary-soft text-primary flex items-center justify-center mx-auto mb-3">
            <Mail className="w-6 h-6" />
          </div>
          <p className="text-sm text-ink-soft leading-relaxed">{t('inboxEmpty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {letters.map((l) => {
            const isReward = l.kind === 'reward' && l.rewardCount > 0;
            const body = l.body || (l.rewardCount > 0 ? t('inboxLetterRewardOnly', { n: l.rewardCount }) : t('inboxNoBody'));
            return (
              <li
                key={l.id}
                className={
                  'rounded-xl border p-3.5 transition-colors ' +
                  (l.read ? 'border-clay-border bg-white' : 'border-primary/30 bg-primary-soft/40')
                }
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary-text">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    {isReward ? t('inboxLetterReward', { n: l.rewardCount }) : t('inboxTitle')}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {!l.read && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />}
                    <span className="text-[11px] text-ink-soft tabular-nums">{formatWhen(l.createdAt)}</span>
                  </span>
                </div>
                {/* 运营者写的原文：保留换行；React 默认转义，不走 dangerouslySetInnerHTML */}
                <p className={'text-[13px] leading-relaxed whitespace-pre-wrap break-words ' + (l.body ? 'text-gray-700' : 'text-ink-soft')}>
                  {body}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <button
        onClick={onClose}
        className="mt-5 w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.98] transition-all"
      >
        {t('inboxGotIt')}
      </button>
    </Modal>
  );
}
