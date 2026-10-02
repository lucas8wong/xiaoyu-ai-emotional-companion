/**
 * 付费解锁弹窗
 *
 * 通道：Stripe 结账页（卡 / Link / Apple Pay / Google Pay / **支付宝**，三种币种下单次购买都可用）。
 * 结算币种：由**服务端按访客地区**判定（港澳 HKD / 内地 CNY / 其他 USD，见 /api/payment/config 的
 *   `payCurrency`）——前端只展示该币种价格，实扣同源，页面价 = 实扣价。
 * 支付方式：服务端创建 Checkout 时**不传 payment_method_types**（动态支付方式），
 *   让结账页把该币种/该客户所有可用方式都摆出来；一旦显式指定就会关掉其它方式。
 *   2026-09-29：**微信支付从 Stripe 侧移除**（用户拍板「Stripe 那里移除微信支付这个选项」）——
 *   服务端用 `excluded_payment_method_types: ['wechat_pay']` 只摘掉它，本弹窗也不再提它；
 *   同日按要求在「单次购买」下标注**支付宝**（按界面语言：支付宝 / 支付寶 / Alipay）。
 * 2026-09-23：移除微信收款码人工确认通道；本站用户侧只有 Stripe。
 * 2026-09-24：UI 重做 —— 文案精简、单一结算币种主价、全皮肤 token（无硬编码品牌色）。
 * 2026-09-25：① Stripe 结账页点「返回」→ 服务端 cancel_url 带 pay/plan/term/days，Home 据此**原样重开本弹窗**
 *   （回到「选连续包月」那一屏，不再丢回首页）+ 顶部一句「已取消」；
 *   ② 弹窗底部补客服（小红书一键直达 + 邮箱）。
 * 2026-09-26：**微信收款码作为「Stripe 付不了」的备用通道回到用户侧**（用户拍板 B）——
 *   支付通道下方一个**默认折叠**的块：收款码图片（URL 由服务端下发、带内容哈希版本号）+ 三步说明 +
 *   「需人工确认、会有等待时间」的如实提示。付完把截图 + 注册邮箱发到小红书 / 邮箱，运营侧手动开通。
 */

import { useEffect, useState } from 'react';
import { CreditCard, Copy, Check, Mail, MessageCircle, Instagram, QrCode, ChevronDown } from 'lucide-react';
import { getQuota, getPayConfig, stripePay, getInviteLink, trackInviteCopy, isLoggedIn, type QuotaInfo, type PayConfig, type PlanKey, type PayTerm } from '../services/api';
import { mainPrice, otherPrices, payCurrencyOf, num } from '../lib/payPrice';
import { quotaTierTiao } from '../lib/quotaTiers';
import { SUPPORT_EMAIL, SUPPORT_XHS_URL, SUPPORT_IG_URL } from '../lib/support';
import { t } from '../i18n';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import { DiscountBadge, StrikePrice, OfferDeadline } from './ui/DiscountBadge';

interface PayModalProps {
  open: boolean;
  plan?: PlanKey; // 当前选择的档位（默认 plus）
  days?: number; // 续费延长天数（Pro 续费场景 30/60/90）
  term?: PayTerm; // 购买方式：月付 / 年付 / 买断（默认月付）
  /** 从 Stripe 结账页点「返回」回来的（Home 据 cancel_url 的 query 重开本弹窗）→ 顶部给一句「已取消」 */
  canceled?: boolean;
  onClose: () => void;
  onNeedLogin?: () => void;
  onOpenMembership?: () => void;
  onSwitchPlan?: (plan: PlanKey) => void; // 切换档位
}

/** 客服邮箱 / 小红书直达链接见 lib/support.ts（付费弹窗、会员弹窗共用一处，避免漂移） */

/** 结算币种符号见 lib/payPrice.ts（USD→$ / HKD→HK$ / CNY→¥） */

export default function PayModal({ open, plan = 'plus', days, term = 'monthly', canceled = false, onClose, onNeedLogin, onOpenMembership, onSwitchPlan }: PayModalProps) {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [config, setConfig] = useState<PayConfig | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  // 打开/切换档位时加载数据（配额 + 定价配置；配置里带服务端判定的结算币种）
  useEffect(() => {
    if (!open) return;
    setMessage('');
    setBusy(true);
    (async () => {
      const [q, c] = await Promise.all([getQuota(), getPayConfig()]);
      if (q.success && q.data) setQuota(q.data);
      if (c.success && c.data) setConfig(c.data);
      else setMessage(c.error || t('payErrRetry'));
      setBusy(false);
    })();
  }, [open, plan, term]);

  if (!open) return null;

  const handleStripe = async (mode: 'subscription' | 'payment' = 'subscription') => {
    setBusy(true);
    setMessage('');
    try {
      // 年付/买断只走单次购买（Stripe 按固定价）；连续包月仅月付提供
      const m: 'subscription' | 'payment' = term === 'monthly' ? mode : 'payment';
      const r = await stripePay(plan, term === 'monthly' ? days : undefined, m, term);
      if (r.success && r.data && r.data.url) {
        window.location.href = r.data.url;
      } else {
        setMessage(r.error || t('payErrRetry'));
      }
    } catch {
      setMessage(t('errNetwork'));
    } finally {
      setBusy(false);
    }
  };

  // 复制专属邀请链接：每邀请 1 人注册得邀请奖励（数值取配置）
  const copyInvite = () => {
    // 埋点：控制台要能看出「复制过邀请链接」的人（失败静默，见 trackInviteCopy）
    try { navigator.clipboard.writeText(getInviteLink()); void trackInviteCopy(); setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1500); } catch { /* 忽略 */ }
  };

  /* —— 价格（只显示本次结算币种；另两币种放在小字里便于换算；取值/格式化统一走 lib/payPrice）—— */
  const pp = config?.pricing?.plans?.[plan];
  const cur = payCurrencyOf(config);
  // 月付续费延长（30/60/90 天）：按 天数/30 比例放大，与 Stripe 单次购买实扣一致
  const ratio = term === 'monthly' && days && days > 0 ? days / 30 : 1;
  const onceVals: [number, number, number] = term === 'yearly'
    ? [num(pp?.yearlyUsd), num(pp?.yearlyHkd), num(pp?.yearlyCny)]
    : term === 'lifetime'
    ? [num(pp?.lifetimeUsd), num(pp?.lifetimeHkd), num(pp?.lifetimeCny)]
    : [num(pp?.usd) * ratio, num(pp?.hkd) * ratio, num(pp?.cny) * ratio];
  const oncePrice = mainPrice(config, ...onceVals);
  const subPrice = mainPrice(config, pp?.subUsd, pp?.subHkd, pp?.subCny);
  const origPrice = term === 'monthly' ? mainPrice(config, num(pp?.originalUsd) * ratio, num(pp?.originalHkd) * ratio, num(pp?.originalCny) * ratio) : '';
  const suffix = term === 'yearly' ? t('payPerYear') : term === 'lifetime' ? t('memLifetimeBadge') : (days && days !== 30 ? t('payPerDays', { n: days }) : t('payPerMonth'));
  // 另两币种一行小字（方便非本币用户换算）
  const others = otherPrices(config, ...onceVals);
  /**
   * 折扣标注（2026-09-29，共享组件见 ui/DiscountBadge）：
   *  - `offerBadge`：月付的限时优惠（服务端下发 launchOffer/discountPct；只在真有优惠时出现）
   *  - `saveBadge`：年付的「省 3 个月」（结构性省钱，不是限时）
   * 两者都是填充色块、11px bold，紧贴主价下方 —— 旧写法是裸琥珀小字，五皮肤实测 2.15–3.10:1 不达标。
   */
  const offerBadge = config?.launchOffer && term === 'monthly' && origPrice
    ? <DiscountBadge tone="offer">{t('membershipLaunchOffer', { pct: config.discountPct ?? 50 })}</DiscountBadge>
    : null;
  const saveBadge = term === 'yearly' ? <DiscountBadge tone="save">{t('memSaveMonths')}</DiscountBadge> : null;
  /** 分档额度（条）：游客 5 / 注册 20（数字来自后端，弹窗里不写死）——2026-09-27 口径 */
  const tier = quotaTierTiao(quota, config);

  return (
    <Modal open={open} onClose={onClose} zClass="z-50">
      <div className="text-center mb-4">
        <div className="w-12 h-12 rounded-full bg-primary-soft flex items-center justify-center mx-auto mb-2.5">
          <CreditCard className="w-6 h-6 text-primary-text" />
        </div>
        <h2 className="text-lg font-bold text-ink">{t('payTitle')}</h2>
        <p className="text-xs text-ink-soft mt-1">
          {/* 统一口径：额度是**按天重置**的「条」（游客 5 / 注册 20），不是一次性「次」——
              文案与数字都跟着口径换，别在点数制下继续印「已用完 3 次免费体验」 */}
          {quota?.creditEnabled
            ? (tier?.own != null ? t('payUsedUpCredit', { n: tier.own }) : t('payUsedUp', { n: quota?.freeTotal ?? 5 }))
            : t('payUsedUp', { n: quota?.freeTotal ?? 5 })}
          {!quota?.creditEnabled && quota?.freeUsed ? t('payUsedDetail', { n: quota.freeUsed }) : ''}
        </p>
      </div>

      <div className="space-y-3">
        {/* 从 Stripe 返回：确认「刚才那笔没付」并把人放回选择位（不报错、不吓人） */}
        {canceled && (
          <div className="rounded-xl bg-accent-soft/70 border border-accent/25 px-3 py-2 text-[11px] text-ink text-center leading-relaxed">
            {t('payCanceledNotice')}
          </div>
        )}
        {/* 注册奖励卡：仅在**真有奖励**时出现（活动期外 registerChatBonus=0，别再显示「送 0 条」） */}
        {!isLoggedIn() && ((quota?.registerProPromoActive && (quota?.registerProDays ?? 0) > 0) || (quota?.registerChatBonus ?? 0) > 0) && (
          <div className="bg-accent-soft/70 border border-accent/25 rounded-xl px-3 py-2.5 text-xs text-ink flex items-center gap-2">
            <span className="flex-1 leading-relaxed">{quota?.registerProPromoActive && (quota?.registerProDays ?? 0) > 0
              ? t('payRegisterBonusPro', { days: quota?.registerProDays ?? 0 })
              : (tier && tier.b > 0
                ? t('payRegisterBonusTiers', { b: tier.b, d: tier.d })
                : t('payRegisterBonus', { b: quota?.registerChatBonus ?? 0 }))}</span>
            <button onClick={onNeedLogin} className="shrink-0 font-semibold text-primary-text underline underline-offset-2">{t('memRegBtn')}</button>
          </div>
        )}

        {/* 档位切换 */}
        {onSwitchPlan && (
          <SegmentedControl
            value={plan === 'pro' ? 'pro' : 'plus'}
            onChange={(k) => onSwitchPlan(k as 'plus' | 'pro')}
            options={[
              { key: 'plus', label: 'Plus', sub: mainPrice(config, config?.pricing?.plans?.plus?.usd, config?.pricing?.plans?.plus?.hkd, config?.pricing?.plans?.plus?.cny) },
              { key: 'pro', label: 'Pro', sub: mainPrice(config, config?.pricing?.plans?.pro?.usd, config?.pricing?.plans?.pro?.hkd, config?.pricing?.plans?.pro?.cny) },
            ]}
          />
        )}

        {/* 价格：本次结算币种主价 + 折算小字 + 优惠 */}
        {pp && (
          <div className="text-center pt-0.5">
            <div className="flex items-baseline justify-center gap-0.5 text-ink">
              <span className="text-[34px] leading-none font-bold tracking-tight tabular-nums">{oncePrice}</span>
              <span className="text-sm text-ink-soft">{suffix}</span>
            </div>
            {/* 折扣行（2026-09-29）：折扣标注紧贴主价下方、单独一行且**填充色块**，是视线第二个落点；
                原价划掉跟在它右边（只在真有优惠时出现）。折算币种挪到下一行，不再和折扣抢位置。
                旧写法是 11px 裸琥珀字 + 原价 + 折算币种挤在一行，且琥珀字在五种皮肤下实测只有 2.15–3.10:1。 */}
            {(offerBadge || saveBadge) && (
              <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
                {offerBadge}
                {offerBadge && origPrice ? <StrikePrice>{origPrice}</StrikePrice> : null}
                {saveBadge}
              </div>
            )}
            {/* 「限时」的期限（2026-09-29 用户提问）：服务端配了 DISCOUNT_END 才显示，没配就不显示（不编日期） */}
            {offerBadge ? <div className="mt-1"><OfferDeadline until={config?.offerEndsAt} /></div> : null}
            <div className="text-[11px] text-ink-soft tabular-nums mt-1.5">{others}</div>
          </div>
        )}

        {/* 支付通道：主推连续包月 + 单次购买（唯一通道 = Stripe 结账页） */}
        <div className="rounded-2xl border border-clay-border bg-clay-surface p-3 space-y-2">
          {term === 'monthly' && (
            <>
              <button
                onClick={() => handleStripe('subscription')}
                disabled={busy}
                className="w-full bg-primary text-white py-3 rounded-xl text-[15px] font-semibold shadow-soft hover:bg-primary-strong active:scale-[0.99] disabled:opacity-50 transition-all tabular-nums"
              >
                {t('paySubBtn', { price: subPrice })}
              </button>
              <p className="text-[11px] text-ink-soft text-center">{t('paySubMethodNote')}</p>
            </>
          )}
          <button
            onClick={() => handleStripe('payment')}
            disabled={busy}
            className={"w-full border border-primary/35 text-primary-text bg-primary-lighter/70 py-2.5 rounded-xl text-sm font-semibold hover:border-primary active:scale-[0.99] disabled:opacity-50 transition-all " + (term === 'monthly' ? '' : 'mt-1')}
          >
            {t('payOnceBtn', { price: oncePrice })}
          </button>
          {/*
            可用方式提示（2026-09-29 用户要求：「这里要标注支付宝，不同语言显示对应语言」）：
            支付宝**不做币种隐藏**——实测（temp/probe-pay-methods-by-currency.mjs，建真会话回读后立即 expire）
            单次购买在 HKD / CNY / USD 三种币种下 Stripe 都解析出 ["card","alipay","link"]，
            所以这条（挂在「单次购买」按钮下）恒列支付宝；连续包月那条不列（订阅解析为 ["card","link"]，无支付宝）。
            微信支付已于同日从 Stripe 侧移除（见 excluded_payment_method_types），故此处不再出现。
          */}
          <p className="text-[11px] text-primary-text text-center">{t('payMethodAlipay')} · {t('payMethodWallets')}</p>
          <p className="text-[10px] text-ink-soft text-center pt-0.5">{t('paySecured')}</p>
        </div>

        {/* 备用通道（2026-09-26 用户拍板 B）：Stripe 走不通（卡被拒 / 没有可用方式）时的兜底 —— 微信收款码。
            **默认折叠**：不影响主通道的视线，但用户真付不了时能自己扫码走人工确认。
            收款码 URL 由服务端下发（带图片内容哈希版本号，换图不会让用户看到旧码）。 */}
        {config?.payQrUrl && (
          <details className="rounded-2xl border border-clay-border bg-clay-bg overflow-hidden">
            <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center gap-2 text-[12px] font-medium text-ink hover:bg-clay-muted/40 transition-colors">
              <QrCode className="w-4 h-4 text-primary-text shrink-0" />
              <span className="flex-1 leading-snug">{t('payQrToggle')}</span>
              <ChevronDown className="w-3.5 h-3.5 text-ink-soft shrink-0" />
            </summary>
            <div className="px-3 pb-3 space-y-2">
              <img
                src={config.payQrUrl}
                alt={t('payQrAlt')}
                className="w-40 h-40 mx-auto rounded-xl border border-clay-border bg-white object-contain"
              />
              <p className="text-[11px] leading-relaxed text-ink">{t('payQrSteps')}</p>
              <p className="text-[11px] leading-relaxed font-medium text-accent leading-snug">{t('payQrWait')}</p>
            </div>
          </details>
        )}

        {/* 邀请：一行 */}
        <div className="flex items-center gap-2 rounded-xl border border-clay-border bg-clay-bg px-3 py-2">
          <span className="flex-1 text-[11px] text-ink-soft leading-snug">{t('payInviteShort', { n: config?.bonuses?.invite ?? 50 })}</span>
          <button onClick={copyInvite} className="shrink-0 flex items-center gap-1 bg-clay-surface border border-clay-border text-ink px-2.5 py-1.5 rounded-lg text-xs font-medium hover:border-primary transition-all">
            {inviteCopied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
            {inviteCopied ? t('profileCopied') : t('copyInvite')}
          </button>
        </div>

        {message && <p className="text-xs text-red-500 text-center">{message}</p>}
      </div>

      {/* 客服：付款出问题找谁（小红书 / Instagram / 邮箱三个直达），与上面的备用通道是两件事——
          上面那张码是「怎么把钱付过来」，这里是「付完 / 付不动时找谁」。
          2026-09-29 用户要求「这里的句子可以直接删掉，留 3 个直达链接就行」：删掉说明句
          （i18n 的 `payHelpBody` 保留但不再渲染），标题 + 三个链接自己就把话说清了。 */}
      <div className="rounded-2xl border border-clay-border bg-clay-bg px-3 py-2.5 mt-3 space-y-1.5">
        <p className="text-xs font-semibold text-ink">{t('payHelpTitle')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
          <a
            href={SUPPORT_XHS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary-text hover:text-primary-strong underline underline-offset-2"
          >
            <MessageCircle className="w-3.5 h-3.5" /> {t('payHelpXhs')}
          </a>
          <a
            href={SUPPORT_IG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary-text hover:text-primary-strong underline underline-offset-2"
          >
            <Instagram className="w-3.5 h-3.5" /> {t('payHelpIg')}
          </a>
          <a
            href={'mailto:' + SUPPORT_EMAIL}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary-text hover:text-primary-strong underline underline-offset-2"
          >
            <Mail className="w-3.5 h-3.5" /> {SUPPORT_EMAIL}
          </a>
        </div>
      </div>
      {onOpenMembership && (
        <button onClick={onOpenMembership} className="block mx-auto mt-1.5 text-[11px] text-primary-text hover:text-primary-strong underline underline-offset-2">
          {t('membershipSeeAll')}
        </button>
      )}
    </Modal>
  );
}
