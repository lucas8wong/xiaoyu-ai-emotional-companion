/**
 * 邀请好友（显眼入口弹窗 / 方案 B 首页引导卡的弹窗）
 * 说明引荐奖励：你 +N 额度 / 朋友经链接注册再 +N / 朋友购买会员你同档免费（最高年付）/ 朋友月付送半月。
 * 游客：引导「注册后即可邀请」（反套利：邀请人须为注册满 7 天的账号，游客邀请不生效）。
 *
 * 2026-09-19 追加「我的邀请记录」（邀请反馈区）：登录用户能直接看到**有没有人通过自己的链接注册**、
 * 拿到了多少额度 / 会员天数，以及「注册了但没计入」的那些人为什么没计入（原因由服务端判定并留痕）。
 */

import { useEffect, useState } from 'react';
import { X, Gift, Copy, Check, UserPlus } from 'lucide-react';
import { getInviteLink, getPayConfig, getReferralSummary, isLoggedIn, type MyReferralSummary } from '../services/api';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  onNeedRegister: () => void;
}

/** 未计入原因 → 三语文案 key（服务端给的是判定码，文案在前端按语言映射） */
function rejectReasonKey(reason: string | null): string {
  switch (reason) {
    case 'invitee-inactive': return 'inviteRejectInactive';
    case 'same-device': return 'inviteRejectSameDevice';
    case 'same-ip': return 'inviteRejectSameIp';
    case 'inviter-too-new': return 'inviteRejectTooNew';
    case 'inviter-cap-reached': return 'inviteRejectCap';
    case 'inviter-not-account': return 'inviteRejectNotAccount';
    case 'self-invite': return 'inviteRejectSelf';
    default: return 'inviteRejectUnknown';
  }
}

/** M/D（语言无关，避免为「几小时前」再加三语相对时间键） */
function fmtDay(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function InviteModal({ open, onClose, onNeedRegister }: InviteModalProps) {
  const [copied, setCopied] = useState(false);
  const [inviteBonus, setInviteBonus] = useState(50);
  const [loggedIn, setLoggedIn] = useState(false);
  const [summary, setSummary] = useState<MyReferralSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    const li = isLoggedIn();
    setLoggedIn(li);
    getPayConfig().then((r) => {
      if (r.success && r.data?.bonuses?.invite) setInviteBonus(r.data.bonuses.invite);
    });
    // 邀请记录：登录用户才拉（游客没有邀请资格）；失败就静默不显示这一块，不影响分享主流程
    if (li) {
      getReferralSummary().then((r) => {
        if (r.success && r.data) setSummary(r.data);
      }).catch(() => { /* 忽略：邀请记录是附加信息 */ });
    } else {
      setSummary(null);
    }
  }, [open]);

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(getInviteLink());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };

  if (!open) return null;

  const minDays = summary?.config.minDays ?? 7;
  const boost = summary?.config.newAccountBoost ?? 1;
  const boostDays = summary?.config.newAccountBoostDays ?? 7;
  const shown = summary ? summary.invitees.slice(0, 5) : [];

  return (
    <Modal open={open} onClose={onClose} closeOnOverlayClick={false} overlayClassName="z-[90] flex items-end sm:items-center justify-center" padding="p-5 sm:p-6" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[90vh]">

        <div className="flex items-center gap-2 mb-1">
          <span className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center flex-shrink-0">
            <Gift className="w-5 h-5" />
          </span>
          <h2 className="text-lg font-bold text-gray-800">{t('inviteModalTitle', { n: inviteBonus })}</h2>
        </div>
        <p className="text-sm text-ink-soft leading-relaxed mb-4">{t('inviteModalSub', { n: inviteBonus })}</p>

        {/* 奖励说明 */}
        <ul className="space-y-2 mb-5">
          <li className="flex items-start gap-2 text-sm text-gray-700">
            <span className="text-primary mt-0.5">•</span>
            <span>{t('inviteModalBenefitYou', { n: inviteBonus })}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-gray-700">
            <span className="text-primary mt-0.5">•</span>
            <span>{t('inviteModalBenefitFriend', { n: inviteBonus })}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-gray-700">
            <span className="text-primary mt-0.5">•</span>
            <span>{t('inviteModalBenefitMember')}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-gray-700">
            <span className="text-primary mt-0.5">•</span>
            <span>{t('inviteModalBenefitMonth')}</span>
          </li>
          {/* 「朋友开口后才计入」已写进上面「你得 N 次」那一行，不再单列（2026-09-19 文案精简）；加成单独一条 */}
          {boost > 1 && (
            <li className="flex items-start gap-2 text-sm text-amber-700">
              <span className="mt-0.5">•</span>
              <span>{t('inviteModalBenefitBoost', { x: boost, n: boostDays })}</span>
            </li>
          )}
        </ul>

        {loggedIn ? (
          <>
            <button
              onClick={handleCopy}
              className="w-full flex items-center justify-center gap-2 bg-primary text-white py-3 rounded-xl text-sm font-bold hover:bg-primary-strong transition-all"
            >
              {copied ? <Check className="w-5 h-5 text-white" /> : <Copy className="w-5 h-5" />}
              {copied ? t('inviteModalCopied') : t('inviteModalCopyBtn')}
            </button>

            {/* 邀请反馈区：有没有人通过我的链接注册 / 因此拿到多少 */}
            {summary && (
              <div className="mt-5 pt-4 border-t border-clay-border">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <h3 className="text-sm font-bold text-gray-800">{t('inviteRecordsTitle')}</h3>
                  {summary.invitedCount > 0 && (
                    <span className="text-[11px] text-ink-soft">{t('inviteRecordsTotal', { n: summary.invitedCount })}</span>
                  )}
                </div>

                {!summary.eligible && summary.ineligibleReason === 'too-new' ? (
                  <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2 mb-2">
                    {t('inviteRecordsTooNew', { n: summary.daysUntilEligible || minDays })}
                  </p>
                ) : null}

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-clay-bg rounded-lg px-2 py-2 text-center">
                    <div className="text-base font-bold text-primary">{summary.rewardedCount}</div>
                    <div className="text-[10px] text-ink-soft leading-tight">{t('inviteRecordsPeople')}</div>
                  </div>
                  <div className="bg-clay-bg rounded-lg px-2 py-2 text-center">
                    <div className="text-base font-bold text-primary">{summary.creditsEarned}</div>
                    <div className="text-[10px] text-ink-soft leading-tight">{t('inviteRecordsCredits')}</div>
                  </div>
                  <div className="bg-clay-bg rounded-lg px-2 py-2 text-center">
                    <div className="text-base font-bold text-primary">{summary.memberDaysEarned}</div>
                    <div className="text-[10px] text-ink-soft leading-tight">{t('inviteRecordsDays')}</div>
                  </div>
                </div>

                {shown.length === 0 ? (
                  <p className="text-xs text-ink-soft leading-relaxed">{t('inviteRecordsEmpty')}</p>
                ) : (
                  <div className="divide-y divide-clay-border">
                    {shown.map((it, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 py-1.5">
                        <div className="min-w-0">
                          <div className="text-xs text-gray-700 truncate">{it.name}</div>
                          <div className="text-[10px] text-ink-soft truncate">
                            {[fmtDay(it.at), it.maskedEmail, it.memberDays > 0 ? t('inviteRecordsMemberDays', { n: it.memberDays, plan: (it.friendPurchasedPlan || 'plus').toUpperCase() }) : '']
                              .filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          {it.rewarded
                            ? <span className="text-xs font-bold text-primary">{t('inviteRecordsPlus', { n: it.credits })}{it.boost && it.boost > 1 ? ' ×' + it.boost : ''}</span>
                            : it.pending
                              ? <span className="text-[10px] text-amber-700">{t('inviteRejectInactive')}</span>
                              : <span className="text-[10px] text-ink-soft">{t(rejectReasonKey(it.rejectReason), { n: minDays })}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {summary.pendingCount > 0 && (
                  <p className="text-[10px] text-amber-700 mt-2 leading-relaxed">{t('inviteRecordsPending', { n: summary.pendingCount })}</p>
                )}
                {summary.rejectedCount > 0 && (
                  <p className="text-[10px] text-ink-soft mt-1 leading-relaxed">{t('inviteRecordsRejected', { n: summary.rejectedCount })}</p>
                )}
                {summary.invitedCount > shown.length && (
                  <p className="text-[10px] text-ink-soft mt-1">{t('inviteRecordsMore', { n: summary.invitedCount - shown.length })}</p>
                )}
                {!summary.eligible && summary.ineligibleReason === 'not-account' ? (
                  <p className="text-[10px] text-ink-soft mt-1">{t('inviteRecordsGuestHint', { n: minDays })}</p>
                ) : null}
                <p className="text-[10px] text-ink-soft mt-2 leading-relaxed opacity-80">
                  {t('inviteRecordsPrivacyHint')}
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <button
              onClick={onNeedRegister}
              className="w-full flex items-center justify-center gap-2 bg-primary text-white py-3 rounded-xl text-sm font-bold hover:bg-primary-strong transition-all"
            >
              <UserPlus className="w-5 h-5" />
              {t('inviteModalGuestCta')}
            </button>
            <p className="text-[11px] text-ink-soft text-center mt-2">{t('inviteModalGuestHint')}</p>
          </>
        )}
    </Modal>
  );
}
