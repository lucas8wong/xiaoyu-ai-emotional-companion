/**
 * 额度用完「获取更多额度」弹窗（已注册/免费用户）
 * 游客额度用完走注册（AuthModal），不进入此弹窗。
 * 提供两个主选项：分享邀请链接（好友注册你得额度）+ 提交反馈获得额度（每人每天一次）；
 * 并保留「升级会员/付费解锁」作为可选项。
 */

import { useEffect, useState } from 'react';
import { Share2, Copy, Check, Gift, Crown, Ticket } from 'lucide-react';
import { getInviteLink, getPayConfig, getQuota, applyInviteCode, isLoggedIn, trackInviteCopy } from '../services/api';
import { quotaTierTiao } from '../lib/quotaTiers';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { BTN, INPUT } from './ui/controls';

interface QuotaPromptModalProps {
  open: boolean;
  onClose: () => void;
  /** 打开全局反馈弹窗（提交反馈获得额度） */
  onOpenFeedback: () => void;
  /** 打开会员/付费弹窗（升级会员无限畅聊） */
  onOpenMembership: () => void;
}

export default function QuotaPromptModal({ open, onClose, onOpenFeedback, onOpenMembership }: QuotaPromptModalProps) {
  const [copied, setCopied] = useState(false);
  const [bonuses, setBonuses] = useState<{ invite: number; inviteMax: number }>({ invite: 50, inviteMax: 20 });
  // 补填邀请码（注册时没填的用户）：额度耗尽这一刻动机最强，所以这里也给一个入口
  const [canFillInvite, setCanFillInvite] = useState(false);
  const [inviteInput, setInviteInput] = useState('');
  const [inviteMsg, setInviteMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  /** 注册免费档每天多少条（2026-09-27 分档）：讲「明天恢复多少」时要用真实数字 */
  const [registeredDailyTiao, setRegisteredDailyTiao] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    getPayConfig().then((r) => {
      if (r.success && r.data?.bonuses) {
        setBonuses({ invite: r.data.bonuses.invite ?? 50, inviteMax: r.data.bonuses.inviteMax ?? 20 });
      }
      // 分档数字（游客 5 / 注册 20）：文案里「每天 {d} 条，明天自动恢复」用它，前端不写死
      const tier = quotaTierTiao(null, r.data);
      if (tier) setRegisteredDailyTiao(tier.d);
    }).catch(() => { /* 配置拿不到就用默认值 */ });
    // 补填邀请码入口：只给「已登录 + 还没填过」的用户看（游客填了也不算，不给假入口）
    setInviteInput('');
    setInviteMsg(null);
    if (!isLoggedIn()) { setCanFillInvite(false); return; }
    getQuota().then((r) => {
      if (r.success && r.data) setCanFillInvite(!r.data.inviteCode);
    }).catch(() => { setCanFillInvite(false); });
  }, [open]);

  if (!open) return null;

  const copyInvite = () => {
    try {
      navigator.clipboard.writeText(getInviteLink());
      // 埋点：控制台要能看出「复制过邀请链接」的人（失败静默，见 trackInviteCopy）
      void trackInviteCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { setCopied(false); }
  };

  /** 补填邀请码：成功后隐藏入口并提示到账；失败按业务码给本地化文案 */
  const handleApplyInvite = async () => {
    const code = inviteInput.trim();
    if (!code) return;
    setInviteBusy(true);
    setInviteMsg(null);
    const r = await applyInviteCode(code);
    setInviteBusy(false);
    if (r.success && r.data) {
      setInviteInput('');
      setCanFillInvite(false);
      setInviteMsg({ type: 'ok', text: t('inviteCodeApplyOk', { n: r.data.bonus }) });
      return;
    }
    const text = r.code === 'INVITE_CODE_USED' ? t('inviteCodeErrUsed')
      : r.code === 'INVITE_CODE_INVALID' ? t('inviteCodeErrInvalid')
      : r.code === 'NOT_LOGGED_IN' ? t('inviteCodeErrLogin')
      : (r.error || t('inviteCodeErrInvalid'));
    setInviteMsg({ type: 'err', text });
  };

  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[70] bg-black/50 flex items-center justify-center p-4" padding="p-5">
        {/* 头部 */}
        <div className="text-center mb-5">
          <h2 className="text-xl font-bold text-gray-800">{t('quotaTitle')}</h2>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed">{registeredDailyTiao != null
            ? t('quotaSubDaily', { d: registeredDailyTiao })
            : t('quotaSub')}</p>
        </div>

        {/* 分享邀请 */}
        <div className="rounded-2xl border border-clay-border bg-clay-bg/60 p-4 mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-8 h-8 rounded-xl bg-primary-lighter text-primary flex items-center justify-center flex-shrink-0"><Share2 className="w-4 h-4" /></span>
            <p className="text-sm font-bold text-gray-800">{t('quotaShareTitle')}</p>
          </div>
          <p className="text-[12px] text-gray-600 leading-relaxed">{t('quotaShareDesc', { n: bonuses.invite, m: bonuses.inviteMax })}</p>
          <button
            onClick={copyInvite}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.99] transition-all"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? t('quotaCopied') : t('quotaShareBtn')}
          </button>
        </div>

        {/*
          补填邀请码（注册时没填的用户）：
          · 放在「分享邀请」之后：同属「邀请」语境，而这里是额度耗尽、最想找额度的时刻。
          · 只在「已登录 + 还没填过」时出现；领完立即隐藏并提示到账。
        */}
        {canFillInvite && (
          <div className="rounded-2xl border border-clay-border bg-clay-bg/60 p-4 mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-8 h-8 rounded-xl bg-primary-lighter text-primary flex items-center justify-center flex-shrink-0"><Ticket className="w-4 h-4" /></span>
              <p className="text-sm font-bold text-gray-800">{t('quotaInviteTitle')}</p>
            </div>
            <p className="text-[12px] text-gray-600 leading-relaxed">{t('quotaInviteDesc')}</p>
            <input
              className={'mt-3 ' + INPUT}
              aria-label={t('inviteCodeLabel')}
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              placeholder={t('inviteCodePh')}
            />
            <button
              onClick={handleApplyInvite}
              disabled={inviteBusy || !inviteInput.trim()}
              className={'mt-2.5 ' + BTN.primary + ' ' + BTN.size}
            >
              {t('inviteCodeApply')}
            </button>
          </div>
        )}
        {inviteMsg && (
          <p className={'text-[12px] mb-3 ' + (inviteMsg.type === 'ok' ? 'text-primary-text' : 'text-red-500')}>{inviteMsg.text}</p>
        )}

        {/* 提交反馈 */}
        <div className="rounded-2xl border border-clay-border bg-clay-bg/60 p-4 mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-8 h-8 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center flex-shrink-0"><Gift className="w-4 h-4" /></span>
            <p className="text-sm font-bold text-gray-800">{t('quotaFeedbackTitle')}</p>
          </div>
          <p className="text-[12px] text-gray-600 leading-relaxed">{t('quotaFeedbackDesc')}</p>
          <button
            onClick={onOpenFeedback}
            className="mt-3 w-full flex items-center justify-center gap-2 bg-amber-400 text-white font-semibold rounded-full py-2.5 hover:bg-amber-500 active:scale-[0.99] transition-all"
          >
            <Gift className="w-4 h-4" />
            {t('quotaFeedbackBtn')}
          </button>
        </div>

        {/* 升级会员（可选） */}
        <button
          onClick={onOpenMembership}
          className="w-full flex items-center justify-center gap-2 text-[13px] text-primary-text font-medium hover:bg-primary-lighter rounded-full py-2.5 transition-all"
        >
          <Crown className="w-4 h-4" />
          {t('quotaUpgradeBtn')}
        </button>
    </Modal>
  );
}
