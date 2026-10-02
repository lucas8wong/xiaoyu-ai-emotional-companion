/**
 * 登录 / 注册 / 重设密码 弹窗
 */

import { useEffect, useRef, useState } from 'react';
import { X, Loader2, Mail, Lock, Info, Ticket, User as UserIcon, ShieldCheck, Eye, EyeOff, Gift, Compass } from 'lucide-react';
import {
  login,
  loginWithGoogle,
  register,
  sendEmailCode,
  resetPassword,
  setAuth,
  type AuthUser,
} from '../services/api';
import { t } from '../i18n';
import GoogleSignInButton from './GoogleSignInButton';
import LangSwitch from './LangSwitch';
import { useAppStore } from '../store/useAppStore';
import Modal from './ui/Modal';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onLoginSuccess: (user: AuthUser) => void;
  onRegistered?: () => void; // 注册成功额外回调（用于区分"登录"与"新注册"）
  initialTab?: 'login' | 'register' | 'reset';
  initialEmail?: string; // 深链预填（邮件 "Open Xiaoyu" 按钮带参）
  initialCode?: string;  // 深链预填验证码
  registerChatBonus?: number; // 限时活动：注册可送的对话额度（0/undefined 表示活动未开启）
  registerProPromoActive?: boolean; // 新人 Pro 限时活动：注册即送 Pro 无限使用（true 时注册页优先展示）
  registerProDays?: number; // 新人注册即送的 Pro 天数（0=未开启）
  /**
   * 注册后免费档每天多少条（2026-09-27 分档口径：游客 5 条/天 → 注册 20 条/天）。
   * 由调用方从后端数字算好传入；拿不到就不显示这一句（不渲染 `undefined 条`）。
   */
  registeredDailyTiao?: number;
  /** Google OAuth Client ID（后端 /api/payment/quota 下发）；为空则不渲染「用 Google 继续」 */
  googleClientId?: string;
}

type Tab = 'login' | 'register' | 'reset';

/**
 * 自报来源选项（「你怎么知道我们的」）——值存服务端 attribution.heardFrom，
 * 与 UTM 归因是两种口径（basis: self-report vs journey），报表里分开看。
 * 顺序按我们的实际渠道优先级排，最后一项兜底。
 */
const HEARD_FROM_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'instagram', labelKey: 'heardFromInstagram' },
  { value: 'xiaohongshu', labelKey: 'heardFromXiaohongshu' },
  { value: 'search', labelKey: 'heardFromSearch' },
  { value: 'friend', labelKey: 'heardFromFriend' },
  { value: 'reddit_forum', labelKey: 'heardFromForum' },
  { value: 'ai_assistant', labelKey: 'heardFromAi' },
  { value: 'other', labelKey: 'heardFromOther' },
];

export default function AuthModal({ open, onClose, onLoginSuccess, onRegistered, initialTab = 'login', initialEmail = '', initialCode = '', registerChatBonus = 0, registerProPromoActive = false, registerProDays = 0, registeredDailyTiao, googleClientId = '' }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, setLangTick] = useState(0); // 语言切换后强制本组件用新语言重渲染

  // 登录表单
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  // 注册表单
  const [rEmail, setREmail] = useState('');
  const [rCode, setRCode] = useState('');
  const [rInviteCode, setRInviteCode] = useState('');
  // 自报来源（可选）：注册这一刻问最准，不填也能注册（不做成必填，避免伤转化）
  const [rHeardFrom, setRHeardFrom] = useState('');
  const [rPassword, setRPassword] = useState('');
  // 邀请码是否展开（默认折叠，减少首屏高度）
  const [inviteOpen, setInviteOpen] = useState(false);
  // 注册隐私知情同意
  const [agree, setAgree] = useState(false);
  const setPrivacyOpen = useAppStore((s) => s.setPrivacyOpen);
  // 注册密码可见性切换
  const [showPwd, setShowPwd] = useState(false);
  // 找回表单
  const [fEmail, setFEmail] = useState('');
  const [fCode, setFCode] = useState('');
  const [fPassword, setFPassword] = useState('');

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setMessage(null);
      setAgree(false);
      setInviteOpen(false);
      if (initialEmail || initialCode) {
        if (initialTab === 'reset') {
          if (initialEmail) setFEmail(initialEmail);
          if (initialCode) setFCode(initialCode);
        } else {
          if (initialEmail) setREmail(initialEmail);
          if (initialCode) setRCode(initialCode);
        }
      }
    }
  }, [open, initialTab, initialEmail, initialCode]);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  if (!open) return null;

  const startCountdown = () => {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1 && timerRef.current) clearInterval(timerRef.current);
        return c > 0 ? c - 1 : 0;
      });
    }, 1000);
  };

  const handleLogin = async () => {
    if (!account.trim() || !password) { setMessage({ type: 'err', text: t('errAccountPwd') }); return; }
    setBusy(true); setMessage(null);
    const r = await login(account.trim(), password);
    setBusy(false);
    if (r.success && r.data) {
      setAuth(r.data.token, r.data.user);
      onLoginSuccess(r.data.user);
      onClose();
    } else {
      setMessage({ type: 'err', text: r.error || t('errFailed') });
    }
  };

  // Google 一键登录/注册：服务端验签 ID token，返回结构与 login 一致；isNew 时才触发「注册成功」回调
  const handleGoogle = async (credential: string) => {
    setBusy(true); setMessage(null);
    const r = await loginWithGoogle(credential, t('nicknameDefault'));
    setBusy(false);
    if (r.success && r.data) {
      setAuth(r.data.token, r.data.user);
      onLoginSuccess(r.data.user);
      if (r.data.isNew) onRegistered?.();
      onClose();
    } else {
      setMessage({ type: 'err', text: r.error || t('errGoogleFailed') });
    }
  };

  const handleRegister = async () => {
    if (!rEmail.trim()) { setMessage({ type: 'err', text: t('errNeedEmail') }); return; }
    // 邮箱格式校验（与后端一致：有@、有点、无连续点/结尾点）
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(rEmail.trim()) || /\.\./.test(rEmail.trim()) || /\.$/.test(rEmail.trim())) {
      setMessage({ type: 'err', text: t('errEmailInvalid') }); return;
    }
    if (rPassword.length < 6) { setMessage({ type: 'err', text: t('errPwdMin') }); return; }
    if (!agree) { setMessage({ type: 'err', text: t('regAgreeError') }); return; }
    setBusy(true); setMessage(null);
    // 读取 URL 中的邀请码（?ref=xxx）
    let ref = '';
    try { ref = new URLSearchParams(window.location.search).get('ref') || ''; } catch { /* 忽略 */ }
    const r = await register({
      username: genDefaultName(),
      email: rEmail.trim(),
      password: rPassword,
      ref: ref || undefined,
      code: rCode.trim(),
      inviteCode: rInviteCode.trim() || undefined,
      heardFrom: rHeardFrom || undefined,
    });
    setBusy(false);
    if (r.success && r.data) {
      setAuth(r.data.token, r.data.user);
      onLoginSuccess(r.data.user);
      onRegistered?.();
      onClose();
    } else {
      setMessage({ type: 'err', text: r.error || t('errFailed') });
    }
  };

  // 发送注册验证码（验证邮箱真实，防手误输错）
  const handleSendRegisterCode = async () => {
    if (!rEmail.trim()) { setMessage({ type: 'err', text: t('errNeedEmail') }); return; }
    setBusy(true); setMessage(null);
    const r = await sendEmailCode(rEmail.trim(), 'register');
    setBusy(false);
    if (r.success) { setMessage({ type: 'ok', text: t('codeSent') }); startCountdown(); }
    else setMessage({ type: 'err', text: r.error || t('errFailed') });
  };

  const handleSendCode = async () => {
    if (!fEmail.trim()) { setMessage({ type: 'err', text: t('errNeedEmail2') }); return; }
    setBusy(true); setMessage(null);
    const r = await sendEmailCode(fEmail.trim(), 'reset');
    setBusy(false);
    if (r.success) {
      setMessage({ type: 'ok', text: t('codeSent') });
      startCountdown();
    } else {
      setMessage({ type: 'err', text: r.error || t('errFailed') });
    }
  };

  const handleReset = async () => {
    if (!fEmail.trim() || !fCode.trim() || fPassword.length < 6) {
      setMessage({ type: 'err', text: t('errResetForm') });
      return;
    }
    setBusy(true); setMessage(null);
    const r = await resetPassword(fEmail.trim(), fCode.trim(), fPassword);
    setBusy(false);
    if (r.success) {
      setMessage({ type: 'ok', text: t('pwdReset') });
      setTimeout(() => setTab('login'), 1200);
    } else {
      setMessage({ type: 'err', text: r.error || t('errFailed') });
    }
  };

  // 「用 Google 继续」+「或」分隔线：登录与注册两个 tab 共用同一段（两处各写一遍必然漂移）
  const googleBlock = googleClientId ? (
    <div className="space-y-3">
      <GoogleSignInButton clientId={googleClientId} onCredential={handleGoogle} disabled={busy} />
      <div className="flex items-center gap-3">
        <span className="flex-1 h-px bg-gray-200" />
        <span className="text-[11px] text-ink-soft">{t('orDivider')}</span>
        <span className="flex-1 h-px bg-gray-200" />
      </div>
    </div>
  ) : null;

  const inputCls = "w-full pl-10 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent";
  const labelCls = "block text-xs text-ink-soft mb-1";

  // 内联校验派生值（输入时即时反馈）
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailOk = emailRe.test(rEmail.trim()) && !/\.\./.test(rEmail.trim()) && !/\.$/.test(rEmail.trim());
  const pwdOk = rPassword.length >= 6;
  // 昵称不在注册主流程收集：由系统自动生成默认昵称（满足后端「username 或 phone 至少填一个」），用户可在「我的」修改。
  // 默认昵称统一为「小愈的朋友 / Yu's friend」，不再带随机后缀——昵称仅作展示名，不承担唯一标识（唯一标识是 userId）。
  const genDefaultName = () => t('nicknameDefault');

  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[70] bg-black/50 flex items-center justify-center p-4" padding="p-4 sm:p-5" showClose={false}>
        {/* 顶栏：左上语言切换（简/繁/EN）、右上关闭；用流式布局而非绝对定位，避免英文长 Tab 标签与语言切换重叠 */}
        <div className="flex items-center justify-between mb-2">
          <LangSwitch compact onChange={() => setLangTick(t => t + 1)} />
          <button onClick={onClose} aria-label={t('authClose')} className="text-ink-soft hover:text-gray-700 p-2 -m-2 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab 切换 */}
        <div className="flex justify-center gap-4 mb-4 border-b border-gray-100 pb-2">
          {([
            ['login', t('authLogin')],
            ['register', t('authRegister')],
            ['reset', t('authReset')],
          ] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              onClick={() => { setTab(t); setMessage(null); }}
              className={`text-sm font-medium pb-1 border-b-2 transition-colors ${
                tab === t ? 'border-primary text-primary-text' : 'border-transparent text-ink-soft hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {message && (
          <div className={`text-sm rounded-lg p-3 mb-3 ${message.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {message.text}
          </div>
        )}

        {/* 登录 */}
        {tab === 'login' && (
          <div className="space-y-3">
            {googleBlock}
            <div>
              <label className={labelCls} htmlFor="auth-label-account">{t('labelAccount')}</label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-label-account" type="email" inputMode="email" autoComplete="email" className={inputCls} value={account} onChange={(e) => setAccount(e.target.value)} placeholder={t('accountPh')} />
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="auth-auth-password">{t('authPassword')}</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-auth-password" type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('authPassword')} />
              </div>
            </div>
            <button
              onClick={handleLogin}
              disabled={busy}
              className="w-full bg-primary-strong text-white py-3 rounded-lg font-medium hover:bg-primary disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {t('authLoginBtn')}
            </button>
            <p className="text-xs text-ink-soft text-center">
              {t('loginTip')}
            </p>
          </div>
        )}

        {/* 注册 */}
        {tab === 'register' && (
          <div className="space-y-3">
            {googleBlock}
            {registerProPromoActive && registerProDays > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                <Gift className="w-4 h-4 text-amber-700 shrink-0" />
                <p className="text-xs text-amber-700 leading-snug">{t('registerProTip', { n: registerProDays })}</p>
              </div>
            ) : registerChatBonus > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-primary-soft border border-primary-lighter px-3 py-2">
                <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                <div className="text-xs text-primary-text leading-snug">
                  <p>{t('registerBonusTip', { n: registerChatBonus })}</p>
                  {/* 2026-09-27 分档：注册不只送一笔，**每天**的额度也从游客档升到 20 条 */}
                  {registeredDailyTiao != null && (
                    <p className="mt-0.5">{t('registerDailyTip', { d: registeredDailyTiao })}</p>
                  )}
                </div>
              </div>
            ) : registeredDailyTiao != null ? (
              <div className="flex items-center gap-2 rounded-lg bg-primary-soft border border-primary-lighter px-3 py-2">
                <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                <p className="text-xs text-primary-text leading-snug">{t('registerDailyTip', { d: registeredDailyTiao })}</p>
              </div>
            ) : null}
            <div>
              <label className={labelCls} htmlFor="auth-label-email">{t('labelEmail')}</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-label-email" type="email" className={inputCls} value={rEmail} onChange={(e) => setREmail(e.target.value)} placeholder={t('emailPh')} autoComplete="email" inputMode="email" />
              </div>
              {rEmail.trim() && (emailOk
                ? <p className="text-[11px] text-primary-text mt-1 leading-snug">✓</p>
                : <p className="text-[11px] text-red-500 mt-1 leading-snug">{t('errEmailInvalid')}</p>)}
            </div>
            <div>
              <label className={labelCls} htmlFor="auth-auth-code">{t('authCode')}</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <ShieldCheck className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                  <input id="auth-auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" className={inputCls} value={rCode} onChange={(e) => setRCode(e.target.value)} placeholder={t('codePh')} />
                </div>
                <button
                  onClick={handleSendRegisterCode}
                  disabled={busy || countdown > 0}
                  className="px-3 py-2 text-sm bg-white text-primary-text rounded-lg border border-clay-border hover:bg-primary-soft disabled:opacity-50 whitespace-nowrap min-h-[44px]"
                >
                  {countdown > 0 ? t('resendCountdown', { n: countdown }) : t('authSendCode')}
                </button>
              </div>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-amber-700 leading-snug">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {t('registerEmailSpamTip')}
            </p>
            <div>
              <label className={labelCls} htmlFor="auth-label-reg-pwd">{t('labelRegPwd')}</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-label-reg-pwd" type={showPwd ? 'text' : 'password'} className={inputCls + ' pr-11'} value={rPassword} onChange={(e) => setRPassword(e.target.value)} placeholder={t('regPwdPh')} autoComplete="new-password" />
                <button type="button" onClick={() => setShowPwd(v => !v)} aria-label={t('pwdToggle')} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-gray-600 p-1">
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {rPassword && (pwdOk
                ? <p className="text-[11px] text-primary-text mt-1 leading-snug">✓</p>
                : <p className="text-[11px] text-red-500 mt-1 leading-snug">{t('errPwdMin')}</p>)}
            </div>
            {/* 自报来源（可选）：补 tracking 看不见的口口相传 / 暗社交（DM、群聊、截图）
                —— 归因技能里最被低估的信号，也是 direct 黑洞唯一的出路 */}
            <div>
              <label className={labelCls} htmlFor="auth-heard-from-label">{t('heardFromLabel')}</label>
              <div className="relative">
                <Compass className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <select id="auth-heard-from-label"
                  className={inputCls + ' appearance-none pr-8 bg-white'}
                  value={rHeardFrom}
                  onChange={(e) => setRHeardFrom(e.target.value)}
                >
                  <option value="">{t('heardFromSkip')}</option>
                  {HEARD_FROM_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* 知情同意：注册前须勾选《用户协议》与《隐私政策》 */}
            <div className="flex items-start gap-2 text-[11px] text-ink-soft leading-snug">
              <input
                id="reg-agree"
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <label htmlFor="reg-agree" className="cursor-pointer">
                {t('regAgree')}
                <button type="button" onClick={() => setPrivacyOpen(true)} className="underline text-primary-text font-medium ml-0.5">
                  {t('regAgreePrivacy')}
                </button>
              </label>
            </div>
            {inviteOpen ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-ink-soft">{t('inviteCodeLabel')}</span>
                  <button type="button" onClick={() => setInviteOpen(false)} className="tap-y text-[11px] text-ink-soft hover:text-primary-text">
                    {t('inviteCodeCollapse')}
                  </button>
                </div>
                <div className="relative">
                  <Ticket className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                  <input className={inputCls} aria-label={t('inviteCodeLabel')} value={rInviteCode} onChange={(e) => setRInviteCode(e.target.value)} placeholder={t('inviteCodePh')} />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="flex items-center gap-1.5 text-xs text-ink-soft hover:text-primary-text"
              >
                <Ticket className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                <span>{t('inviteCodeToggle')}</span>
              </button>
            )}
            <button
              onClick={handleRegister}
              disabled={busy}
              className="w-full bg-primary-strong text-white py-3 rounded-lg font-medium hover:bg-primary disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {t('authRegisterAndLogin')}
            </button>
          </div>
        )}

        {/* 重设密码 */}
        {tab === 'reset' && (
          <div className="space-y-3">
            <div>
              <label className={labelCls} htmlFor="auth-label-reset-email">{t('labelResetEmail')}</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-label-reset-email" className={inputCls} value={fEmail} onChange={(e) => setFEmail(e.target.value)} placeholder={t('resetEmailPh')} />
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="auth-auth-code">{t('authCode')}</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <ShieldCheck className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                  <input id="auth-auth-code" className={inputCls} value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder={t('codePh')} />
                </div>
                <button
                  onClick={handleSendCode}
                  disabled={busy || countdown > 0}
                  className="px-3 py-2 text-sm bg-white text-primary-text rounded-lg border border-clay-border hover:bg-primary-soft disabled:opacity-50 whitespace-nowrap"
                >
                  {countdown > 0 ? t('resendCountdown', { n: countdown }) : t('authSendCode')}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="auth-label-new-pwd">{t('labelNewPwd')}</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-label-new-pwd" type="password" className={inputCls} value={fPassword} onChange={(e) => setFPassword(e.target.value)} placeholder={t('resetPwdPh')} />
              </div>
            </div>
            <button
              onClick={handleReset}
              disabled={busy}
              className="w-full bg-primary-strong text-white py-3 rounded-lg font-medium hover:bg-primary disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {t('authResetBtn')}
            </button>
            <p className="text-xs text-ink-soft text-center">
              {t('resetTip')}
            </p>
          </div>
        )}
    </Modal>
  );
}