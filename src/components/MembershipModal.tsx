/**
 * 会员权益弹窗：按用户等级差异化
 * - Free（游客/免费）：三档对比（MembershipCompare）
 * - Plus 会员：升级 Pro 专属视图（突出 Plus→Pro 差异）
 * - Pro 会员：续费/延长视图（30/60/90 天）
 * 定价从后端 GET /api/payment/config 拉取；**主价 = 本币结算币种**（港澳 HKD / 内地 CNY / 其他 USD），
 * 另两币种只作折算小字（与付费弹窗同一口径，见 src/lib/payPrice.ts）。
 *
 * 2026-09-17 结构统一（用户口径「这里的 ui 似乎并没有同步，也帮我同步……能复用的就复用去改」）：
 *   ① 外壳换成 `ui/Modal`（遮罩/面板/头部/关闭只有一份实现）；
 *   ② 「当前档位」卡、Pro 大卡换成 `ui/PlanCard`（档位观感集中在 `PLAN_THEME`）；
 *   ③ 「30/60/90 天」与 Free 视图的「月付/年付/买断」换成同一个 `ui/SegmentedControl`。
 *   → 三个视图自此共用同一套件：以后改档位卡/分段控件只改 ui/ 那一处，不会再出现「续费视图没跟上」。
 *   皮肤强调色（`SKIN_ACCENT_*`）与档位色（`PLAN_THEME`）的分工也写在 ui/PlanCard.tsx 里。
 * 2026-09-24：价格改「本币主价 + 折算小字」（三币种并排 → 本币为主），与重做后的付费弹窗对齐。
 */

import { useEffect, useState } from 'react';
import { Check, Mail, MessageCircle, Instagram } from 'lucide-react';
import { t } from '../i18n';
import { getPayConfig, type PayConfig, type PayTerm } from '../services/api';
import { mainPrice, otherPrices } from '../lib/payPrice';
import { SUPPORT_EMAIL, SUPPORT_XHS_URL, SUPPORT_IG_URL } from '../lib/support';
import MembershipCompare from './MembershipCompare';
import Modal from './ui/Modal';
import { DiscountBadge, StrikePrice, OfferDeadline } from './ui/DiscountBadge';
import SegmentedControl from './ui/SegmentedControl';
import PlanCard, { PLAN_THEME, SKIN_ACCENT_CTA, SKIN_ACCENT_SURFACE } from './ui/PlanCard';

interface MembershipModalProps {
  open: boolean;
  onClose: () => void;
  onOpenPay: (plan: 'plus' | 'pro', term?: PayTerm) => void; // 去开通 → 打开付费弹窗（带档位 + 购买方式）
  onOpenRenew?: (days: number) => void; // Pro 续费延长 → 打开付费弹窗（带天数）
  userPlan?: 'free' | 'plus' | 'pro'; // 当前用户等级（三态差异化）
  memberDaysLeft?: number | null; // 剩余天数（Pro 续费视图）
  /** 首页已缓存的定价配置：传入即可秒显原价/现价与优惠角标，无需再等网络 */
  initialConfig?: PayConfig | null;
}

export default function MembershipModal({ open, onClose, onOpenPay, onOpenRenew, userPlan = 'free', memberDaysLeft, initialConfig }: MembershipModalProps) {
  const [config, setConfig] = useState<PayConfig | null>(initialConfig ?? null);
  const [renewDays, setRenewDays] = useState(30);
  // Plus → Pro 升级视图的购买方式（月付 / 年付 / 买断）
  const [upgradeTerm, setUpgradeTerm] = useState<PayTerm>('monthly');

  // 有首页缓存直接用（秒显）；否则打开时再拉取（失败回退 i18n 文案）
  useEffect(() => {
    if (initialConfig) { setConfig(initialConfig); return; }
    if (!open) return;
    let cancelled = false;
    (async () => {
      const r = await getPayConfig();
      if (!cancelled && r.success && r.data) setConfig(r.data);
    })();
    return () => { cancelled = true; };
  }, [open, initialConfig]);

  if (!open) return null;

  const proP = config?.pricing?.plans?.pro;
  const launch = config?.launchOffer;

  // 续费档位价格（按天比例）：本币主价
  const renewPrice = (days: number): string => {
    if (!proP) return '';
    const r = days / 30;
    return mainPrice(config, proP.usd * r, proP.hkd * r, proP.cny * r);
  };
  /**
   * 续费档位的**原价**（同样按天比例），2026-09-29 用户截图指出「续费这里还是看不到是折扣价」：
   * 续费价是按**折后**月价 × 天数折算的（服务端实扣同源），但界面只印了价格、没提优惠，
   * 于是看起来像原价。原价用 `originalUsd/Hkd/Cny` × 同一比例，与服务端 `getPriceIn` 的口径一致。
   */
  const renewOrigPrice = (days: number): string => {
    if (!proP?.originalUsd) return '';
    const r = days / 30;
    return mainPrice(config, proP.originalUsd * r, (proP.originalHkd ?? 0) * r, (proP.originalCny ?? 0) * r);
  };

  // 指定购买方式下的 Pro 本币价 + 另两币种折算
  const proTermPrices = (term: PayTerm): { main: string; others: string } => {
    if (!proP) return { main: t('mProPrice'), others: '' };
    const v = term === 'yearly' && proP.yearlyUsd != null
      ? [proP.yearlyUsd, proP.yearlyHkd, proP.yearlyCny]
      : term === 'lifetime' && proP.lifetimeUsd != null
        ? [proP.lifetimeUsd, proP.lifetimeHkd, proP.lifetimeCny]
        : [proP.usd, proP.hkd, proP.cny];
    return { main: mainPrice(config, v[0], v[1], v[2]), others: otherPrices(config, v[0], v[1], v[2]) };
  };
  const proTermPrice = proTermPrices(upgradeTerm);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={userPlan === 'pro' ? t('memRenewTitle') : userPlan === 'plus' ? t('memUpgradeTitle') : t('membershipTitle')}
      subtitle={
        userPlan === 'pro'
          ? t('memRenewDesc') + (memberDaysLeft != null ? ' · ' + t('memStatusDaysLeft', { n: memberDaysLeft }) : '')
          : userPlan === 'plus'
            ? t('memUpgradeDesc')
            : t('membershipSub')
      }
    >
      {userPlan === 'pro' ? (
        /* ===== Pro：续费 / 延长（30/60/90 天） ===== */
        <div className="space-y-4">
          {/* 当前档位卡：皮肤强调色（与首页会员横幅一致），外观走 ui/PlanCard 的皮肤强调色档 */}
          <PlanCard
            plan="pro"
            name={t('memBadgePro')}
            surfaceClassName={SKIN_ACCENT_SURFACE}
            iconClassName="bg-white/70 text-amber-700"
            topRight={<span className="text-[10px] font-medium text-amber-700 bg-white/70 rounded-full px-2 py-0.5">{t('memCurrentPlan')}</span>}
            footer={
              memberDaysLeft != null ? (
                <p className="text-xs text-amber-700 mt-1.5 font-medium">{t('memStatusDaysLeft', { n: memberDaysLeft })}</p>
              ) : null
            }
          />

          {/* 延长时长：与 Free 视图的「月付/年付/买断」同一个分段控件（原来两边各写一份，续费视图因此掉队） */}
          <SegmentedControl
            value={String(renewDays)}
            onChange={(k) => setRenewDays(Number(k))}
            options={[30, 60, 90].map((days) => ({
              key: String(days),
              label: t('memRenewDays', { n: days }),
              sub: renewPrice(days),
              endSlot: <Check className="w-3 h-3 text-primary-text" />,
            }))}
          />

          {/* 折扣行（2026-09-29）：续费价格是按**折后**月价按天折算的，但这一屏此前只印价格、不提优惠，
              用户截图指出「这个情况下还是看不到是折扣价的情况」。徽章 + 原价划线随所选时长实时变化。 */}
          {launch && renewOrigPrice(renewDays) ? (
            <div className="flex flex-col items-center gap-0.5 -mt-1">
              <span className="flex items-center justify-center gap-2 flex-wrap">
                <DiscountBadge tone="offer">{t('membershipLaunchOffer', { pct: config?.discountPct ?? 50 })}</DiscountBadge>
                <span className="text-[11px] text-ink-soft">
                  {t('memOriginalPrice')} <StrikePrice>{renewOrigPrice(renewDays)}</StrikePrice>
                </span>
              </span>
              {/* 期限（有 offerEndsAt 才显示） */}
              <OfferDeadline until={config?.offerEndsAt} />
            </div>
          ) : null}

          {/* 续费 CTA（皮肤强调色 → 主色，与首页会员横幅同源） */}
          <button
            onClick={() => onOpenRenew && onOpenRenew(renewDays)}
            className={'w-full font-semibold rounded-full py-3.5 hover:brightness-95 active:scale-[0.98] transition-all flex items-center justify-center gap-2 ' + SKIN_ACCENT_CTA}
          >
            {t('memRenewBtn')} · {t('memRenewDays', { n: renewDays })}
          </button>
          <p className="text-[11px] text-ink-soft text-center">{t('membershipPayNote')}</p>

          {/* 已订阅 Pro 的人**不该只看到"续费"**，完整权益对比放在下面：
              ① 自己能核对自己买了什么（透明）；② 各档差别本身就是"Pro 值不值"的说服材料（续费理由）。 */}
          <details className="rounded-2xl border border-clay-border bg-white">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-gray-700 flex items-center justify-between">
              {t('memViewAllPlans')}
              <span className="text-xs text-ink-soft">{t('memCurrentPlan')} · {t('mProName')}</span>
            </summary>
            <div className="px-3 pb-3">
              <MembershipCompare config={config || initialConfig || undefined} tableOnly currentPlan="pro" />
            </div>
          </details>
        </div>
      ) : userPlan === 'plus' ? (
        /* ===== Plus：升级 Pro 专属视图（月付/年付/买断可选） ===== */
        <div className="space-y-4">
          {/* Plus 当前档位（小卡，走档位色 PLAN_THEME.plus） */}
          <PlanCard
            plan="plus"
            name={t('memBadgePlus')}
            surfaceClassName={PLAN_THEME.plus.surface}
            iconClassName={PLAN_THEME.plus.icon}
            topRight={<span className="text-[10px] font-medium text-primary-text bg-primary-lighter rounded-full px-2 py-0.5">{t('memCurrentPlan')}</span>}
          />

          {/* 期限切换：月付 / 年付（省 3 个月）/ 买断，与 Free 视图同一控件 */}
          <SegmentedControl
            value={upgradeTerm}
            onChange={setUpgradeTerm}
            textSize="sm"
            options={([
              ['monthly', t('memTermMonthly')],
              ['yearly', t('memTermYearly') + ' · ' + t('memSaveMonths')],
              ['lifetime', t('memTermLifetime')],
            ] as [PayTerm, string][]).map(([k, label]) => ({ key: k, label }))}
          />

          {/* Pro 大卡（升级目标）：档位色 + 缎带 + 权益列表，全部由 ui/PlanCard 提供 */}
          <PlanCard
            plan="pro"
            name={t('memBadgePro')}
            price={proTermPrice.main}
            priceNote={proTermPrice.others || null}
            originalPrice={launch && upgradeTerm === 'monthly' && proP?.originalUsd
              ? mainPrice(config, proP.originalUsd, proP.originalHkd, proP.originalCny)
              : null}
            /* 折扣标注：这张「Plus→Pro 升级卡」此前只显示划线原价、**没有折扣标注**
               同一个价格在「免费档三卡」里带标记、在这里不带，正是用户说的「所有情况都要标」的漏网处（2026-09-29） */
            badge={launch && upgradeTerm === 'monthly' && proP?.originalUsd
              ? <span className="inline-flex flex-col items-start gap-0.5">
                  <DiscountBadge tone="offer">{t('membershipLaunchOffer', { pct: config?.discountPct ?? 50 })}</DiscountBadge>
                  <OfferDeadline until={config?.offerEndsAt} />
                </span>
              : null}
            recommended
            recommendedLabel={t('membershipRecommended')}
            /* 权益四项用对比表「Pro 專屬」那套键（`memProOnly*`，三语齐全）
               原来写的是 t('mProB1')…t('mProB4')，而这四个键**从未存在过**：界面把键名
               直接当文案渲染（截图复核时抓到「mProB1 mProB2 mProB3 mProB4」）。 */
            bullets={[t('memProOnlyAutoPlay'), t('memProOnlyGen'), t('memProOnlyAutoArt'), t('memProOnlyThink')]}
            footer={upgradeTerm === 'monthly' && proP?.subUsd != null ? (
              <p className="text-[11px] text-amber-700 mt-1 font-medium">🔄 {t('memSubPriceLine', { price: mainPrice(config, proP.subUsd, proP.subHkd, proP.subCny) })}</p>
            ) : null}
            cta={<>{t('memUpgradeBtn')}</>}
            onCta={() => onOpenPay('pro', upgradeTerm)}
            ctaClassName={SKIN_ACCENT_CTA}
          />

          {/* 保留当前 Plus */}
          <button onClick={onClose} className="w-full text-xs text-ink-soft hover:text-gray-600 py-1">
            {t('memCurrentPlan')} · {t('membershipCurrent')}
          </button>
          <p className="text-[11px] text-ink-soft text-center">{t('membershipPayNote')}</p>
        </div>
      ) : (
        /* ===== Free：三档对比（默认） ===== */
        <>
          <MembershipCompare onOpenPay={onOpenPay} onClose={onClose} config={config} currentPlan={userPlan} />
          <p className="text-[11px] text-ink-soft text-center mt-4 leading-relaxed">{t('membershipPayNote')}</p>
        </>
      )}

      {/* 客服：小红书一键直达 + 邮箱（与付费弹窗同一份地址常量，见 lib/support.ts） */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-2 text-[11px]">
        <span className="text-ink-soft">{t('payHelpTitle')}</span>
        <a href={SUPPORT_XHS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary-text hover:text-primary-strong underline underline-offset-2">
          <MessageCircle className="w-3 h-3" /> {t('payHelpXhs')}
        </a>
        <a href={SUPPORT_IG_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary-text hover:text-primary-strong underline underline-offset-2">
          <Instagram className="w-3 h-3" /> {t('payHelpIg')}
        </a>
        <a href={'mailto:' + SUPPORT_EMAIL} className="inline-flex items-center gap-1 font-medium text-primary-text hover:text-primary-strong underline underline-offset-2">
          <Mail className="w-3 h-3" /> {SUPPORT_EMAIL}
        </a>
      </div>
    </Modal>
  );
}
