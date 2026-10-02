/**
 * 我的（个人中心弹窗）
 * 会员状态 / 免费次数 / 邀请好友 / 修改昵称 / 修改密码 / 删除账户 / 退出登录
 * 意见反馈已独立出去（顶栏 + 首页入口），不再在此
 */

import { useEffect, useState } from 'react';
import { Crown, User as UserIcon, Gift, Copy, Check, HeartHandshake, LogOut, ChevronDown, ChevronUp, ChevronRight, Ticket, Mail } from 'lucide-react';
import SocialFollow from './SocialFollow';
import { getQuota, getPayConfig, getReferralSummary, renameUser, changePassword, deleteAccount, getInviteLink, trackInviteCopy, logout, getSubscriptionStatus, getStripePortal, fetchCurrentUser, applyInviteCode, getInbox, quotaChatRemain, quotaIsUnlimited, type QuotaInfo, type AuthUser, type SubscriptionStatus, type MyReferralSummary } from '../services/api';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { BTN, INPUT, Section } from './ui/controls';
import { SectionCard } from './ui/Surface';

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
  onNeedPay: () => void;
  onOpenMembership: () => void;
  /** 打开「邀请好友」弹窗看完整的邀请记录（弹窗里是明细列表） */
  onOpenInvite?: () => void;
  /** 打开「小愈信箱」（运营者写给用户的信：奖励回复等）。由 Home 关掉本弹窗后再开，避免弹窗套弹窗 */
  onOpenInbox?: () => void;
  onNeedLogin: () => void;
  /** 昵称修改成功后的新用户：同步回主页等处的登录态展示 */
  onRenamed?: (user: AuthUser) => void;
}

export default function ProfileModal({ open, onClose, onLogout, onOpenMembership, onOpenInvite, onOpenInbox, onNeedLogin, onRenamed }: ProfileModalProps) {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  // 邀请记录摘要（谁能看到自己的邀请战绩——用户反馈「找不到」后的入口）：与邀请弹窗同一份口径
  const [referral, setReferral] = useState<MyReferralSummary | null>(null);
  // 邀请/注册奖励配置（默认=当前后端默认值；配置接口返回后用真实数值）
  const [bonuses, setBonuses] = useState<{ register: number; invite: number; inviteMax: number }>({ register: 20, invite: 50, inviteMax: 20 });
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(() => {
    try { const raw = localStorage.getItem('cure_app_user'); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  const [nameInput, setNameInput] = useState('');
  const [nameMsg, setNameMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdMsg, setPwdMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [delMsg, setDelMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // 账户设置折叠
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 补填邀请码（注册时没填的用户）：折叠态 + 输入 + 结果提示
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteInput, setInviteInput] = useState('');
  const [inviteMsg, setInviteMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  /** 本次会话刚补填成功的码（服务端配额刷新前先本地生效，入口立即变成「已使用」） */
  const [inviteApplied, setInviteApplied] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  // 小愈信箱未读数（卡片红点）；0 = 不显示徽标
  const [inboxUnread, setInboxUnread] = useState(0);

  useEffect(() => {
    if (!open) return;
    // 邀请记录摘要（失败静默：入口本身不受影响）
    getReferralSummary().then((r) => { if (r.success && r.data) setReferral(r.data); }).catch(() => { /* 忽略 */ });
    // 打开时重新读取登录状态：登录/登出后 localStorage 已更新，避免弹窗显示旧的游客态
    try {
      const raw = localStorage.getItem('cure_app_user');
      setUser(raw ? JSON.parse(raw) : null);
    } catch { setUser(null); }
    // 用后端权威账号刷新昵称：本地缓存可能落后于后端（改名发生在其它会话/设备时）
    fetchCurrentUser().then(r => {
      if (r.success && r.data?.user) {
        const u = r.data.user;
        setUser(u);
        try { localStorage.setItem('cure_app_user', JSON.stringify(u)); } catch { /* 忽略 */ }
      }
    });
    getQuota().then(r => { if (r.success && r.data) setQuota(r.data); });
    getPayConfig().then(r => { if (r.success && r.data && r.data.bonuses) setBonuses(r.data.bonuses); });
    getSubscriptionStatus().then(r => { if (r.success && r.data) setSub(r.data.data); });
    // 小愈信箱未读数（失败静默：入口本身不受影响，红点宁可漏报也不要卡住弹窗）
    getInbox().then(r => { if (r.success && r.data) setInboxUnread(r.data.unread); }).catch(() => { /* 忽略 */ });
  }, [open]);

  const handleManageSub = async () => {
    setSubBusy(true);
    try {
      const r = await getStripePortal();
      if (r.success && r.data && r.data.url) window.location.href = r.data.url;
      else setSubBusy(false);
    } catch { setSubBusy(false); }
  };

  if (!open) return null;


  // 判断是否仍在使用「系统默认昵称」（小愈的朋友+随机后缀 / Yu's friend+随机后缀）
  const defaultNickBase = t('nicknameDefault');
  const isDefaultNick = !!user?.username && user.username.trim().startsWith(defaultNickBase);

  const handleRename = async () => {
    if (!nameInput.trim()) { setNameMsg({ type: 'err', text: t('errNameEmpty') }); return; }
    setBusy(true);
    const r = await renameUser(nameInput.trim());
    setBusy(false);
    if (r.success) {
      // 用后端返回的最新用户写回缓存与状态，否则下次打开/刷新仍显示旧昵称
      const updated = r.data?.user;
      if (updated) {
        setUser(updated);
        try { localStorage.setItem('cure_app_user', JSON.stringify(updated)); } catch { /* 忽略 */ }
        onRenamed?.(updated);
      }
      setNameMsg({ type: 'ok', text: t('profileNameUpdated') });
      setNameInput('');
    }
    else setNameMsg({ type: 'err', text: r.error || t('errSaveFailed') });
  };

  const handleChangePwd = async () => {
    if (!oldPwd || !newPwd || newPwd.length < 6) { setPwdMsg({ type: 'err', text: t('errPwdShort') }); return; }
    setBusy(true);
    const r = await changePassword(oldPwd, newPwd);
    setBusy(false);
    if (r.success) { setPwdMsg({ type: 'ok', text: t('profilePwdChanged') }); setOldPwd(''); setNewPwd(''); }
    else setPwdMsg({ type: 'err', text: r.error || t('errChangeFailed') });
  };

  const handleDelete = async () => {
    /**
     * 注销确认词必须覆盖**界面会提示的每一种写法**（2026-09-28 审查 B4）：
     * zh-TW 的指引与报错都在让用户输入「刪除」，而这里只认「删除」/「delete」——
     * 结果繁体用户永远注销不了账号（用户权利/合规被卡死，还陷入「输入了却说不对」的死循环）。
     */
    const ACCEPTED_DELETE_WORDS = ['删除', '刪除', 'delete'];
    const confirmWord = delConfirm.trim().toLowerCase();
    if (!ACCEPTED_DELETE_WORDS.includes(confirmWord)) { setDelMsg({ type: 'err', text: t('errDeleteConfirm') }); return; }
    setBusy(true);
    const r = await deleteAccount();
    setBusy(false);
    if (r.success) { logout(); onLogout(); onClose(); }
    else setDelMsg({ type: 'err', text: r.error || t('errDelete') });
  };

  const handleCopyInvite = () => {
    // 埋点：控制台要能看出「复制过邀请链接」的人（失败静默，见 trackInviteCopy）
    try { navigator.clipboard.writeText(getInviteLink()); void trackInviteCopy(); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };

  /**
   * 注册后补填邀请码：一人一次（服务端判定），成功后把配额里的 inviteCode 就地改写，入口立即隐藏。
   * 失败按服务端业务码给本地化文案，其余情况回落到服务端错误文案（如限流提示）。
   */
  const handleApplyInviteCode = async () => {
    const code = inviteInput.trim();
    if (!code) return;
    setInviteBusy(true);
    setInviteMsg(null);
    const r = await applyInviteCode(code);
    setInviteBusy(false);
    if (r.success && r.data) {
      const applied = r.data.code;
      setInviteApplied(applied);
      setInviteInput('');
      setInviteOpen(false);
      setInviteMsg({ type: 'ok', text: t('inviteCodeApplyOk', { n: r.data.bonus }) });
      setQuota((q) => (q ? { ...q, inviteCode: applied } : q));
      return;
    }
    const text = r.code === 'INVITE_CODE_USED' ? t('inviteCodeErrUsed')
      : r.code === 'INVITE_CODE_INVALID' ? t('inviteCodeErrInvalid')
      : r.code === 'NOT_LOGGED_IN' ? t('inviteCodeErrLogin')
      : (r.error || t('errSaveFailed'));
    setInviteMsg({ type: 'err', text });
  };

  const memberBadge: React.ReactNode = quota?.lifetime
    ? <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-white text-[11px] font-semibold">{t('memLifetimeBadge')}</span>
    : quota?.plan === 'pro'
    ? <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-white text-[11px] font-semibold">Pro</span>
    : quota?.plan === 'plus'
    ? <span className="px-2 py-0.5 rounded-full bg-primary-strong text-white text-[11px] font-semibold">Plus</span>
    : quota?.unlockUntil && quota.unlocked
    ? <span className="px-2 py-0.5 rounded-full bg-primary text-white text-[11px] font-semibold">{t('profileMemberActive')}</span>
    : quota?.unlockUntil
    ? t('profileMemberExpired')
    : t('profileMemberNone');

  return (
    <Modal open={open} onClose={onClose} maxHeight="max-h-[calc(100dvh-2rem)]">
        <div className="text-center mb-5">
          <div className="w-14 h-14 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-3">
            <UserIcon className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-xl font-bold text-gray-800">{t('myProfile')}</h2>
          {user ? (
            <p className="text-sm text-ink-soft mt-1">{user.username || user.email}</p>
          ) : (
            <div className="mt-1.5">
              <p className="text-[11px] text-ink-soft">{t('profileGuest')}</p>
              <button onClick={onNeedLogin} className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:text-primary-text font-medium">
                {t('login')} →
              </button>
            </div>
          )}
        </div>

        {/* 昵称：直接可见可改（不再藏在账户设置折叠里） */}

        {/* 会员与额度（合并：会员状态为主 CTA，免费次数做信息展示） */}
        <Section className="mb-4" icon={<Crown className="w-3.5 h-3.5" />} title={t('profileMemberStatus')}>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">{memberBadge}</span>
            {quota?.unlockUntil && (
              <span className="text-xs text-ink-soft">
                {quota.lifetime
                  ? t('memLifetimeBadge')
                  : quota.unlocked ? t('profileDaysLeft', { n: Math.max(0, Math.ceil((quota.unlockUntil - Date.now()) / 86400000)), date: new Date(quota.unlockUntil).toLocaleDateString() }) : t('profileMemberExpired')}
              </span>
            )}
          </div>
          {/* 额度（信息展示，弱化）：统一口径下单位是「条」且**按天重置**（游客 5 条/天、注册 20 条/天）；
              旧口径才显示理一理池的「次」——别在点数制下继续印旧池数字 */}
          <p className="text-xs text-ink-soft mt-2">
            {quota?.creditEnabled
              ? (quotaIsUnlimited(quota) ? t('chatQuotaPro') : t('chatQuotaCredit', { n: quotaChatRemain(quota) }))
              : <>
                  {t('profileFreeCount')}：{t('profileLeft', { n: quota?.remainFree ?? 0 })}
                  {quota?.freeUsed ? ' · ' + t('profileUsed', { n: quota.freeUsed }) : ''}
                  {quota?.bonusFree ? ' ' + t('profileBonus', { n: quota.bonusFree }) : ''}
                </>}
          </p>
          {/* 主 CTA：会员（未开通→开通；已开通→续费/查看权益） */}
          {!quota?.unlocked ? (
            <button onClick={onOpenMembership} className={'mt-3 ' + BTN.primary + ' ' + BTN.size}>
              {t('profileOpenMember')}
            </button>
          ) : (
            <button onClick={onOpenMembership} className={'mt-3 ' + BTN.amber + ' ' + BTN.size}>
              {t('profileViewBenefits')}
            </button>
          )}
          {/* 连续包月订阅管理（有订阅时显示） */}
          {sub?.subscribed && (
            <div className="mt-2 rounded-lg bg-[#635BFF]/5 border border-[#635BFF]/25 px-3 py-2">
              <p className="text-[11px] text-[#635BFF] font-medium">
                🔄 {t('subStatusLine', { plan: sub.plan === 'pro' ? 'Pro' : 'Plus', days: sub.daysLeft ?? 0 })}
                {sub.cancelAtPeriodEnd ? ' · ' + t('subCanceling') : ''}
              </p>
              <button
                onClick={handleManageSub}
                disabled={subBusy}
                className="mt-2 w-full text-[12px] text-white bg-[#635BFF] py-2 rounded-full hover:opacity-90 disabled:opacity-50 transition-all active:scale-[0.98]"
              >
                {t('subManageBtn')}
              </button>
            </div>
          )}
        </Section>

        {/* 小愈信箱：运营者写给这个用户的信（奖励回复等）都留在这里，随时可回看。
            为什么入口要有未读红点：发奖励时首页那条琥珀横幅 5 秒后 ack 即清，
            用户错过横幅后，这里是唯一能再看到那段回复的地方。 */}
        {onOpenInbox && (
          <Section className="mb-4" icon={<Mail className="w-3.5 h-3.5" />} title={t('inboxTitle')} desc={t('inboxDesc')}>
            <button
              onClick={onOpenInbox}
              className={BTN.subtle + ' ' + BTN.size + ' flex items-center justify-center gap-2'}
            >
              <Mail className="w-4 h-4 text-primary" />
              {t('inboxOpen')}
              {inboxUnread > 0 && (
                <span className="inline-flex items-center rounded-full bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0.5 leading-none">
                  {t('inboxUnread', { n: inboxUnread })}
                </span>
              )}
            </button>
          </Section>
        )}

        {/* 分享邀请（裂变入口） */}
        <Section className="mb-4" icon={<Gift className="w-3.5 h-3.5" />} title={t('profileInviteTitle')} desc={t('profileInviteDesc', { n: bonuses.invite, m: bonuses.inviteMax })}>
          {/* 我的邀请战绩：三格数字（摘要）+ 明细入口。文案只留必要信息，口径与规则说明都在邀请弹窗里 */}
          {user && referral && (
            <div className="mb-2.5">
              {referral.invitedCount > 0 ? (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { v: referral.rewardedCount, k: t('profileInviteStatPeople') },
                    { v: referral.creditsEarned, k: t('profileInviteStatCredits') },
                    { v: referral.memberDaysEarned, k: t('profileInviteStatDays') },
                  ].map((c) => (
                    <div key={c.k} className="rounded-xl bg-clay-muted/50 py-2 text-center">
                      <div className="text-base font-bold text-primary-text tabular-nums leading-none">{c.v}</div>
                      <div className="text-[10px] text-ink-soft mt-1 leading-none">{c.k}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-ink-soft">{t('profileInviteNone', { n: bonuses.invite })}</p>
              )}
              {referral.pendingCount > 0 && (
                <span className="inline-flex items-center mt-2 rounded-full bg-amber-100 text-amber-700 px-2.5 py-1 text-[11px] font-medium">
                  {t('profileInvitePending', { n: referral.pendingCount })}
                </span>
              )}
            </div>
          )}
          <button onClick={handleCopyInvite} className={BTN.subtle + ' ' + BTN.size + ' flex items-center justify-center gap-2'}>
            {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            {copied ? t('profileCopied') : t('profileCopy')}
          </button>
          {user && onOpenInvite && (
            <button
              onClick={onOpenInvite}
              className="mt-1 w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-clay-muted/60 transition-colors duration-150 active:scale-[0.98]"
            >
              <span className="text-[12px] font-medium text-gray-700">{t('profileInviteViewRecords')}</span>
              <ChevronRight className="w-4 h-4 text-ink-soft flex-shrink-0" />
            </button>
          )}
          {/*
            补填邀请码（注册时没填的用户）：
            · 只在「登录 + 还没填过」时出现——填过就换成一行「已使用 xxx」，游客不显示（填了也不算，不给假入口）。
            · 交互与注册弹窗同款（折叠 → 输入 → 领取），文案复用 inviteCodeToggle / inviteCodeLabel / inviteCodePh。
          */}
          {user && (quota?.inviteCode || inviteApplied) && (
            <p className="mt-2.5 text-[11px] text-primary-text">
              {t('inviteCodeApplied', { code: quota?.inviteCode || inviteApplied })}
            </p>
          )}
          {user && quota && !quota.inviteCode && !inviteApplied && (
            inviteOpen ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-ink-soft">{t('inviteCodeLabel')}</span>
                  <button type="button" onClick={() => setInviteOpen(false)} className="text-[11px] text-ink-soft hover:text-primary-text">
                    {t('inviteCodeCollapse')}
                  </button>
                </div>
                <input
                  className={INPUT}
                  aria-label={t('inviteCodeLabel')}
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  placeholder={t('inviteCodePh')}
                />
                <button
                  onClick={handleApplyInviteCode}
                  disabled={inviteBusy || !inviteInput.trim()}
                  className={'mt-2 ' + BTN.primary + ' ' + BTN.size}
                >
                  {t('inviteCodeApply')}
                </button>
                <p className="text-[11px] text-ink-soft mt-1 leading-snug">{t('inviteCodeHint')}</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="mt-2.5 w-full flex items-center gap-1.5 text-xs text-ink-soft hover:text-primary-text"
              >
                <Ticket className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                <span>{t('inviteCodeToggle')}</span>
              </button>
            )
          )}
          {inviteMsg && (
            <p className={'text-[11px] mt-2 ' + (inviteMsg.type === 'ok' ? 'text-primary-text' : 'text-red-500')}>{inviteMsg.text}</p>
          )}
        </Section>
        {user && (
          <Section className="mb-4" icon={<HeartHandshake className="w-3.5 h-3.5" />} title={t('profileRenameTitle')}>
            {isDefaultNick && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2 leading-snug">
                {t('nicknameDefaultReminder', { name: user.username ?? '' })}
              </p>
            )}
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={user.username || t('profileRenamePh')}
              className={INPUT}
            />
            <p className="text-[11px] text-ink-soft mt-1 mb-2 leading-snug">{t('nicknameHint')}</p>
            <button onClick={handleRename} disabled={busy} className={BTN.primary + ' ' + BTN.size}>
              {t('profileSave')}
            </button>
            {nameMsg && <p className={'text-xs mt-2 ' + (nameMsg.type === 'ok' ? 'text-green-600' : 'text-red-500')}>{nameMsg.text}</p>}
          </Section>
        )}

        {/* 账户设置（折叠：昵称 / 密码 / 删除） */}
        {user && (
          <SectionCard className="p-4 mb-4">
            <button
              onClick={() => setSettingsOpen(o => !o)}
              aria-expanded={settingsOpen}
              className="w-full flex items-center justify-between text-sm font-bold text-gray-800"
            >
              <span className="flex items-center gap-2">{t('profileAccountSettings')}</span>
              {settingsOpen ? <ChevronUp className="w-4 h-4 text-ink-soft" /> : <ChevronDown className="w-4 h-4 text-ink-soft" />}
            </button>
            {settingsOpen && (
              <div className="mt-4 space-y-4">

                {/* 修改密码 */}
                <div>
                  <p className="text-sm font-bold text-gray-800 mb-2">{t('profilePwdTitle')}</p>
                  <input
                    type="password"
                    value={oldPwd}
                    onChange={(e) => setOldPwd(e.target.value)}
                    placeholder={t('profileOldPwdPh')}
                    className={INPUT + ' mb-2'}
                  />
                  <input
                    type="password"
                    value={newPwd}
                    onChange={(e) => setNewPwd(e.target.value)}
                    placeholder={t('profileNewPwdPh')}
                    className={INPUT + ' mb-2'}
                  />
                  <button onClick={handleChangePwd} disabled={busy} className={BTN.subtle + ' ' + BTN.size}>
                    {t('profilePwdConfirm')}
                  </button>
                  {pwdMsg && <p className={`text-xs mt-2 ${pwdMsg.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{pwdMsg.text}</p>}
                </div>
                {/* 删除账户（红框警示：不可逆） */}
                <div className="border-2 border-red-200 rounded-xl p-3 bg-red-50/40">
                  <p className="text-sm font-bold text-gray-800 mb-2">{t('profileDeleteTitle')}</p>
                  <p className="text-xs text-ink-soft leading-relaxed mb-2">{t('profileDeleteDesc')}</p>
                  <input
                    value={delConfirm}
                    onChange={(e) => setDelConfirm(e.target.value)}
                    placeholder={t('profileDeletePh')}
                    className={INPUT + ' mb-2 border-red-200'}
                  />
                  <button onClick={handleDelete} disabled={busy} className="w-full bg-red-50 text-red-600 border border-red-200 py-2.5 rounded-full text-sm font-semibold hover:bg-red-100 transition-all active:scale-[0.98]">
                    {t('profileDeleteBtn')}
                  </button>
                  {delMsg && <p className={`text-xs mt-2 ${delMsg.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{delMsg.text}</p>}
                </div>
              </div>
            )}
          </SectionCard>
        )}

        {/* 退出登录（仅登录用户） */}
        {user && (
          <button
            onClick={() => { if (confirm(t('profileLogoutConfirm'))) { logout(); onLogout(); onClose(); } }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-full text-sm text-red-500 border-2 border-red-100 hover:bg-red-50 transition-colors active:scale-[0.98]"
          >
            <LogOut className="w-4 h-4" />
            {t('profileLogout')}
          </button>
        )}
        {/* 社交关注：Instagram */}
        <div className="mt-4 pt-3 border-t border-clay-border">
          <SocialFollow compact />
        </div>
    </Modal>
  );
}