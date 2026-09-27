/**
 * 会员三档：用量滑块推荐（动态角标）→ 期限切换（月付/年付/买断）→ 3 张纵向价格卡（限时特惠 + 划线原价 + 本币主价/折算小字）→ 紧凑对比表
 * 通用组件，三语言；价格来自后端 pricing config，**主价 = 本币结算币种**（港澳 HKD / 内地 CNY / 其他 USD）
 */

import { useState, useEffect, Fragment, type CSSProperties } from 'react';
import { Star, Info, Gauge, MessageCircle, BookOpenText, ListChecks, VenetianMask } from 'lucide-react';
import './usage-slider.css';
import SegmentedControl from './ui/SegmentedControl';
import PlanCard, { PLAN_THEME, type PlanKey } from './ui/PlanCard';
import { Banner, IconChip, SectionCard, Well, TONE, type Tone } from './ui/Surface';
import { t } from '../i18n';
import { getQuota, type PayConfig, type PayTerm } from '../services/api';
import { mainPrice, otherPrices } from '../lib/payPrice';

interface MembershipCompareProps {
  onOpenPay?: (plan: 'plus' | 'pro', term?: PayTerm) => void;
  onClose?: () => void;
  config?: PayConfig | null;
  /**
   * 只渲染「权益对比表」那一块（+全档说明与脚注）——给**已订阅用户**的续费弹窗用：
   * 他们不需要再被推一次价格卡，但应该看到自己买了什么、以及各档差别（也是续费的价值说明）。
   */
  tableOnly?: boolean;
  /** 当前用户档位：在对比表列头标出「目前档位」，让已订阅用户一眼看到自己的位置 */
  currentPlan?: 'free' | 'plus' | 'pro';
}

function fnum(v?: number): string {
  return v == null ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));
}

/** 本币主价 + 另两币种折算（2026-09-24：结算币种按地区定，主价只显示本币） */
function money3(config: MembershipCompareProps['config'], usd?: number, hkd?: number, cny?: number): string {
  return mainPrice(config, usd, hkd, cny);
}

/** 另两币种折算小字（如 `$4.99 · ¥35`） */
function moneyOthers(config: MembershipCompareProps['config'], usd?: number, hkd?: number, cny?: number): string {
  return otherPrices(config, usd, hkd, cny);
}

export default function MembershipCompare({ onOpenPay, onClose, config, tableOnly = false, currentPlan }: MembershipCompareProps) {
  /**
   * 分模式用量推荐器（2026-09-17 替换掉「你一天大概会聊多少句？」单滑块）。
   * 为什么必须分模式：各模式单价差很多——聊天/剧情 1 条、文游 2 条、理一理整条流程 10 条、狼人杀一局 40 条。
   * 单滑块只能按"句"估，狼人杀这种 40 倍的单价比它算不出来（还会把人低估到免费档）。
   * 权重全部来自后端 `quota.featureCostTiao`（单源 = 价目表），前端不写死。
   */
  const [use, setUse] = useState({ chat: 20, textgame: 0, structure: 1, werewolf: 0 });
  /** 是否已按用户**真实用量**预填（用于显示那句说明；没用过的用户保持上面那组默认值） */
  const [prefilled, setPrefilled] = useState(false);
  /** 旧口径（CREDIT_QUOTA_ENABLED=0 回退态）仍用「一天聊多少句」单滑块，数值口径不同不能混用 */
  const [daily, setDaily] = useState(8);
  const [term, setTerm] = useState<PayTerm>('monthly');
  const [openHint, setOpenHint] = useState<string | null>(null);

  const launch = config?.launchOffer;
  const discPct = config?.discountPct ?? 50;
  const plusP = config?.pricing?.plans?.plus;
  const proP = config?.pricing?.plans?.pro;

  // 会员权益数值：优先用后端 quota 配置（与 .env 一致），缺省回退当前默认值，避免对比表与真实档位不一致
  const q = config?.quota;
  const freeStruct = q?.freeStruct ?? 3;
  const freeChat = q?.freeChat ?? 5;
  const chatDaily = q?.chatDailyLimit ?? 40;
  const ctxFree = q?.contextFree ?? 10;
  const ctxPlus = q?.contextPlus ?? 30;
  const ctxPro = q?.contextPro ?? 60;
  const memFree = q?.memoryFree ?? 20;
  const memPlus = q?.memoryPlus ?? 60;
  const memPro = q?.memoryPro ?? 120;

  /**
   * 统一口径（一个池）：所有走 AI 的功能共用一个每日额度，展示单位统一为「条」。
   * 条数换算**复用后端同一条公式**（剩余/上限点数 ÷ `unitCredit`）——与 `quotaChatRemain()`、
   * 狼人杀顶栏 `creditsToUses()` 完全一致，避免前端另立一套换算。
   */
  const unified = !!q?.creditEnabled;
  const unitCredit = q?.unitCredit ?? 2;
  const toTiao = (credit?: number) => (credit == null ? '' : String(Math.max(0, Math.floor(credit / unitCredit))));
  const aiQuotaFree = toTiao(q?.freeDailyCredit);
  /** 游客档（2026-09-27）：对比表「免费」列仍然写**注册后的** 20 条/天，但在 hint 里把游客 5 条说清楚 */
  const aiQuotaGuest = toTiao(q?.guestDailyCredit);
  const aiTierHint = (Number(aiQuotaGuest) || 0) > 0 && (Number(aiQuotaFree) || 0) > 0
    ? t('memFeatureAiQuotaHintTiers', { g: aiQuotaGuest, d: aiQuotaFree })
    : t('memFeatureAiQuotaHint');
  const aiQuotaPlus = toTiao(q?.plusDailyCredit);
  const sceneFree = q?.sceneArtFree ?? 2;
  const scenePlus = q?.sceneArtPlus ?? 6;
  // 滑块推荐阈值：统一口径下按「条」比，旧口径下按条数比（同一条轴，不另立标准）
  const freeTiao = unified ? (Number(aiQuotaFree) || 0) : freeChat;
  const plusTiao = unified ? (Number(aiQuotaPlus) || 0) : chatDaily;
  const recByUse = daily <= freeTiao ? 'free' : daily <= plusTiao ? 'plus' : 'pro';

  // —— 分模式用量 → 一天总条数 → 推荐档位（整数，全部来自后端单价）——
  const cost = {
    chat: q?.featureCostTiao?.chat ?? 1,
    textgame: q?.featureCostTiao?.textgame ?? 2,
    structure: q?.featureCostTiao?.structure ?? 10,
    werewolf: q?.featureCostTiao?.werewolf ?? 40,
  };
  const usageTiao =
    use.chat * cost.chat + use.textgame * cost.textgame + use.structure * cost.structure + use.werewolf * cost.werewolf;
  const recByUsage: 'free' | 'plus' | 'pro' = usageTiao <= freeTiao ? 'free' : usageTiao <= plusTiao ? 'plus' : 'pro';
  const recFinal = unified ? recByUsage : recByUse;
  const recKey = recFinal === 'free' ? 'memRecFree' : recFinal === 'plus' ? 'memRecPlus' : 'memRecPro';
  // 推荐结论里的价格也必须是**本币**（原来写死在 i18n 串里的 $4.99/$9.99 会让港澳/内地用户看到美元）
  const recPrice = recFinal === 'plus'
    ? mainPrice(config, plusP?.usd, plusP?.hkd, plusP?.cny)
    : recFinal === 'pro'
      ? mainPrice(config, proP?.usd, proP?.hkd, proP?.cny)
      : '';
  // 推荐理由（带数字，用户能自己核对）：为什么是这一档
  const recReasonKey = recFinal === 'free' ? 'memRecReasonFree' : recFinal === 'plus' ? 'memRecReasonPlus' : 'memRecReasonPro';
  // 滑块上限跟随 Plus 额度：统一口径下 Plus 是 100 条/天，仍卡在 60 就永远推不出「Pro 适合你」
  const sliderMax = Math.max(60, plusTiao + Math.max(10, Math.round(plusTiao * 0.2)));

  /**
   * 用量刻度几何（2026-09-17 新增）：把「你落在哪一档」从一行灰字变成一条看得见的尺。
   * 主轴 = 0 → Plus 日额（`plusTiao`），右侧固定留出 22% 宽的 **Pro ∞ 尾段** ——
   * Pro 是「无限」，线性轴画不出来，所以给它一块固定地盘：用量超出 Plus 越多、游标越靠右
   * （到右端即饱和），既诚实又能一眼看出「已经越过 Plus 了」。
   * 边界：`plusTiao = 0`（后端配置缺失）时主轴退到 100；所有百分比都过 pctClamp()，
   * 永不产生 NaN / 负宽度 / 越界的游标。
   */
  const meterAxisMax = plusTiao > 0 ? plusTiao : 100;
  const PRO_TAIL_PCT = 22;
  const perTiaoPct = (100 - PRO_TAIL_PCT) / meterAxisMax;
  const pctClamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
  /** 0–1 的比例夹紧（**别和上面的 0–100 夹紧混用**：混了就是把比例再除一次 100，
   *  游标挪进 ∞ 尾段只有 0.06%——首轮实渲 DOM 里抓到过这个 bug，肉眼完全看不出来） */
  const ratioClamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
  const freeTickPct = pctClamp(freeTiao * perTiaoPct);
  const plusTickPct = pctClamp(meterAxisMax * perTiaoPct);
  const overPlus = usageTiao > meterAxisMax;
  // 越过 Plus 后：按「超出额度的倍数」在 ∞ 尾段里推进，超过 2 倍即顶到最右（饱和）
  const knobPct = overPlus
    ? plusTickPct + ratioClamp((usageTiao - meterAxisMax) / meterAxisMax) * PRO_TAIL_PCT
    : pctClamp(usageTiao * perTiaoPct);
  const fillPct = Math.min(knobPct, plusTickPct);
  /** 滑块填充比例（0–100%）→ CSS 自定义属性，交给 .usage-slider 画进度（见 src/index.css） */
  const fillStyle = (p: number) => ({ '--usage-fill': pctClamp(p) + '%' }) as CSSProperties;
  /** 四种用法的图标（情境图标：一扫知道这行是什么；图标只是辅助通道，文字标签始终在） */
  const MODE_ICONS = { chat: MessageCircle, textgame: BookOpenText, structure: ListChecks, werewolf: VenetianMask };
  const MODE_ROWS: [keyof typeof use, string, number][] = [
    ['chat', t('memModeChat'), 200],
    ['textgame', t('memModeWenyou'), 60],
    ['structure', t('memModeStructure'), 20],
    ['werewolf', t('memModeWerewolf'), 10],
  ];
  /** 推荐横幅的语气：Pro=琥珀（与下方 Pro 价格卡同色，形成呼应）/ Plus=薄荷 / Free=中性（配色表在 ui/Surface.tsx） */
  const recTone: Tone = recFinal === 'pro' ? 'amber' : recFinal === 'plus' ? 'mint' : 'sand';

  /**
   * 预填真实用量：用户**看得到自己是怎么用的**，比让他凭感觉拖滑块准得多。
   * 取最近 7 天的分模式日均（后端 `usage7d`）；**完全没用量 → 保持默认那组值**（新用户看到的就是"典型用法"）。
   * 上限也要跟着提：只玩剧情扮演的人一天 100+ 句很常见，滑块封在 60 就永远推不出 Pro。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const q2 = await getQuota();
        const u = q2?.data?.usage7d;
        if (!alive || !u) return;
        const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n)));
        const next = {
          chat: clamp(u.chat || 0, 200),
          textgame: clamp(u.textgame || 0, 60),
          structure: clamp(u.structure || 0, 20),
          werewolf: clamp(u.werewolf || 0, 10),
        };
        if (next.chat + next.textgame + next.structure + next.werewolf > 0) {
          setUse(next);
          setPrefilled(true);
        }
      } catch { /* 取不到就保持默认 */ }
    })();
    return () => { alive = false; };
  }, []);

  /** 指定期限下的价格：主价＝本币（符号随结算币种） */
  const termPrice = (p: typeof plusP, k: PayTerm): string => {
    if (!p) return '';
    if (k === 'yearly' && p.yearlyUsd != null) return money3(config, p.yearlyUsd, p.yearlyHkd, p.yearlyCny);
    if (k === 'lifetime' && p.lifetimeUsd != null) return money3(config, p.lifetimeUsd, p.lifetimeHkd, p.lifetimeCny);
    return money3(config, p.usd, p.hkd, p.cny);
  };

  /** 折算小字：另两币种（本币之外的参考价） */
  const termPriceOthers = (p: typeof plusP, k: PayTerm): string => {
    if (!p) return '';
    if (k === 'yearly' && p.yearlyUsd != null) return moneyOthers(config, p.yearlyUsd, p.yearlyHkd, p.yearlyCny);
    if (k === 'lifetime' && p.lifetimeUsd != null) return moneyOthers(config, p.lifetimeUsd, p.lifetimeHkd, p.lifetimeCny);
    return moneyOthers(config, p.usd, p.hkd, p.cny);
  };

  const plusPrice = termPrice(plusP, term) || t('mPlusPrice');
  const proPrice = termPrice(proP, term) || t('mProPrice');
  // 划线原价仅在月付 + 开业优惠生效时展示（本币）
  const plusOrig = launch && term === 'monthly' && plusP?.originalUsd ? money3(config, plusP.originalUsd, plusP.originalHkd, plusP.originalCny) : '';
  const proOrig = launch && term === 'monthly' && proP?.originalUsd ? money3(config, proP.originalUsd, proP.originalHkd, proP.originalCny) : '';

  const UNL = () => t('memUnlimited');
  const fmtStruct = (n: number) => n + ' ' + t('memUnitTimes');
  const fmtMsgs = (n: number) => n + ' ' + t('memUnitMsgs');
  const fmtPerDay = (n: number) => n + ' ' + t('memUnitPerDay');

  /**
   * 三张价格卡的数据（**外观令牌已抽到 `ui/PlanCard.tsx` 的 `PLAN_THEME`**——2026-09-17：
   * 原来这套 surface/icon/ring/ribbon/price/cta 令牌只服务这一处，续费视图另写了一份就掉队了；
   * 现在档位观感（含琥珀=Pro）是单一口径，会员弹窗三个视图共用）。
   */
  const cards: { key: PlanKey; name: string; tag: string; price: string; note: string; orig: string; cta: string }[] = [
    { key: 'free', name: t('mFreeName'), tag: t('memTagFree'), price: t('mFreePrice'), note: '', orig: '', cta: t('memCtaFree') },
    { key: 'plus', name: t('mPlusName'), tag: t('memTagPlus'), price: plusPrice, note: termPriceOthers(plusP, term), orig: plusOrig, cta: t('memCtaPlus') },
    { key: 'pro', name: t('mProName'), tag: t('memTagPro'), price: proPrice, note: termPriceOthers(proP, term), orig: proOrig, cta: t('memCtaPro') },
  ];

  const TERMS: [PayTerm, string][] = [
    ['monthly', t('memTermMonthly')],
    ['yearly', t('memTermYearly')],
    ['lifetime', t('memTermLifetime')],
  ];

  /**
   * 表格行。**Pro 专属四项也进表**（用户要求：一眼看出「免费/Plus 没有、Pro 有」），
   * 每组前面插一条分组行（`section`），每行都带 ℹ️ 展开说明。
   * 不写每日上限——上限属内部用量保护，写进权益行会让「无限」自相矛盾。
   */
  type Row = { key: string; label: string; cells?: string[]; hint?: string; section?: boolean; highlight?: boolean };
  const proOnlyRows: Row[] = [
    { key: 'pro-auto', label: t('memProOnlyAutoPlay'), cells: ['—', '—', '✓'], hint: t('memProOnlyAutoPlayHint'), highlight: true },
    { key: 'pro-gen', label: t('memProOnlyGen'), cells: ['—', '—', '✓'], hint: t('memProOnlyGenHint'), highlight: true },
    { key: 'pro-art', label: t('memProOnlyAutoArt'), cells: ['—', '—', '✓'], hint: t('memProOnlyAutoArtHint'), highlight: true },
    { key: 'pro-think', label: t('memProOnlyThink'), cells: ['—', '—', '✓'], hint: t('memProOnlyThinkHint'), highlight: true },
  ];

  const tableRows: Row[] = unified
    ? [
      // 顺序（商业判断）：**先讲额度、后讲 Pro 独占**——多数读者是免费/Plus，先回答「我每天能用多少」，
      // 收尾落在「只有 Pro 有这四件事」，读完的最后一个念头就是升级动机。
      { key: 'sec-quota', label: t('memSectionQuota'), section: true },
      { key: 'ai', label: t('memFeatureAiQuota'), cells: [aiQuotaFree + ' ' + t('memUnitPerDay'), aiQuotaPlus + ' ' + t('memUnitPerDay'), UNL()], hint: aiTierHint },
      { key: 'context', label: t('memFeatureContext'), cells: [fmtMsgs(ctxFree), fmtMsgs(ctxPlus), fmtMsgs(ctxPro)], hint: t('memFeatureContextHint') },
      { key: 'memory', label: t('memFeatureMemory'), cells: [fmtMsgs(memFree), fmtMsgs(memPlus), fmtMsgs(memPro)], hint: t('memFeatureMemoryHint') },
      { key: 'sceneArt', label: t('memFeatureSceneArt'), cells: [sceneFree + ' ' + t('memUnitImages'), scenePlus + ' ' + t('memUnitImages'), UNL()], hint: t('memFeatureSceneArtHint') },
      { key: 'sec-pro', label: t('memSectionPro'), section: true },
      ...proOnlyRows,
    ]
    : [
      // 旧口径（开关关闭时的线上默认）：保留原结构，Pro 专属同样进表（不再单占「AI 托管」一行）
      { key: 'sec-quota', label: t('memSectionQuota'), section: true },
      { key: 'structure', label: t('memFeatureStructure'), cells: [fmtStruct(freeStruct), UNL(), UNL()], hint: '' },
      { key: 'chat', label: t('memFeatureChat'), cells: [fmtMsgs(freeChat), fmtPerDay(chatDaily), UNL()], hint: '' },
      { key: 'context', label: t('memFeatureContext'), cells: [fmtMsgs(ctxFree), fmtMsgs(ctxPlus), fmtMsgs(ctxPro)], hint: t('memFeatureContextHint') },
      { key: 'memory', label: t('memFeatureMemory'), cells: [fmtMsgs(memFree), fmtMsgs(memPlus), fmtMsgs(memPro)], hint: t('memFeatureMemoryHint') },
      { key: 'wenyou', label: t('memFeatureWenyou'), cells: [t('memCellTrial'), t('memCellWithinQuota'), UNL()], hint: t('memFeatureWenyouHint') },
      // 2026-09-17 用户拍板：**「客服」这项删掉**（分级客服一直没落地，不做空承诺）
      { key: 'core', label: t('memFeatureCore'), cells: [t('memCellAllOpen'), t('memCellAllOpen'), t('memCellAllOpen')], hint: '' },
      { key: 'sec-pro', label: t('memSectionPro'), section: true },
      ...proOnlyRows,
    ];

  return (
    <div className="space-y-4">
      {/* 用量推荐器：只在「选档位」场景出现；已订阅用户看对比表时不需要它 */}
      {tableOnly ? null : unified ? (
        <SectionCard tint="mint" className="p-4 space-y-3">
          {/* 头部：图标 + 标题 + 总量徽标。
              图标与标题**合成一个 flex item**（图标不做外层兄弟节点）——否则 320px 下来时
              图标会被单独挤到第一行（basis 判定只看未收缩宽度，实测截图确认）；
              这个组合用 `grow shrink basis-48`（**不用 flex-1**：flex-1 的 basis 是 0%，
              换行判定拿不到真实宽度，英文标题会被挤成 4 行）。 */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <div className="grow shrink basis-48 min-w-0 flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-white border border-clay-border flex items-center justify-center text-primary-text shadow-inner flex-shrink-0">
                <Gauge className="w-4 h-4" />
              </span>
              <p className="min-w-0 text-sm font-semibold text-gray-800 leading-snug">{t('memUsageTitle')}</p>
            </div>
            <span aria-live="polite" className="ml-auto flex-shrink-0 rounded-full bg-primary-strong text-white text-[12px] font-bold px-2.5 py-1 shadow-soft tabular-nums">
              {t('memUsageTotal', { n: usageTiao })}
            </span>
          </div>

          {/* 四种用法：一行一块白底「井」（图标 + 标签 + 次数 + 成本胶囊 + 定制滑块） */}
          <div className="space-y-1.5">
            {MODE_ROWS.map(([k, label, max]) => {
              const value = use[k];
              const tiao = value * cost[k];
              const Icon = MODE_ICONS[k];
              return (
                <Well key={k}>
                  <div className="flex items-center gap-2">
                    <IconChip size="sm" tone="mint">
                      <Icon className="w-3.5 h-3.5" />
                    </IconChip>
                    <span className="flex-1 min-w-0 text-[12px] leading-snug text-gray-700">{label}</span>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[13px] font-semibold text-gray-800 tabular-nums">{value}</span>
                      {/* 成本胶囊：一行里最该被看见的数字（「1 局 = 40 条」这类单价差异全靠它） */}
                      <span className={'text-[11px] font-semibold rounded-full px-1.5 py-[1px] tabular-nums transition-colors ' + (tiao > 0 ? 'bg-primary-soft text-primary-text' : 'bg-clay-muted text-ink-soft')}>
                        {t('memModeCost', { n: tiao })}
                      </span>
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={max} value={value}
                    onChange={(e) => setUse({ ...use, [k]: Number(e.target.value) })}
                    aria-label={label}
                    className="usage-slider mt-0.5"
                    style={fillStyle((value / max) * 100)}
                  />
                </Well>
              );
            })}
          </div>

          {/* 额度刻度：把「落在哪一档」画出来（主轴 0 → Plus 日额，右侧固定 Pro ∞ 尾段） */}
          <div className="pt-1">
            <div className="relative h-2.5">
              <div className="absolute inset-0 rounded-full overflow-hidden bg-clay-muted">
                {/* ∞ 尾段底：淡琥珀，未越过 Plus 时也看得见「再往上就是 Pro」 */}
                <span className="absolute inset-y-0 right-0 bg-amber-100/80" style={{ width: PRO_TAIL_PCT + '%' }} />
                {/* 已用量：品牌色渐变填到 Plus 刻度（越过 Plus 的那一段单独用琥珀，和 Pro 卡同色） */}
                <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary to-primary-strong" style={{ width: fillPct + '%' }} />
                {overPlus && (
                  <span className="absolute inset-y-0 bg-amber-400" style={{ left: plusTickPct + '%', width: Math.max(0, knobPct - plusTickPct) + '%' }} />
                )}
                {/* 两条刻度线（免费额度 / Plus 日额）：白线压在填充上才看得见，正是需要它的时刻 */}
                <span className="absolute inset-y-0 w-px bg-white/75" style={{ left: freeTickPct + '%' }} />
                <span className="absolute inset-y-0 w-px bg-white/75" style={{ left: plusTickPct + '%' }} />
              </div>
              {/* 游标：越过 Plus 后描边转琥珀（与「Pro=琥珀」同语言，颜色不是唯一通道——位置本身也在变） */}
              <span
                className={'absolute top-1/2 w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-[2.5px] shadow-sm ' + (overPlus ? 'border-amber-500' : 'border-primary-strong')}
                style={{ left: knobPct + '%' }}
              />
            </div>
            {/* 尺子图例：三档分区名（数字已在下面那行理由里，这里只标「哪一段属于哪一档」）；
                左侧「免费」贴着自己那条刻度线的中心，避免看着像没对齐 */}
            <div className="relative mt-1 h-3 text-[10px] leading-3 text-ink-soft">
              <span className="absolute -translate-x-1/2" style={{ left: Math.max(9, freeTickPct) + '%' }}>{t('mFreeName')}</span>
              <span className="absolute -translate-x-1/2" style={{ left: plusTickPct + '%' }}>{t('mPlusName')}</span>
              <span className="absolute right-0 font-semibold text-amber-700">{t('mProName')} ∞</span>
            </div>
          </div>

          {/* 推荐结论：从「一行灰字」升级为横幅（结论大字 + 数字理由），配色与下方被推荐的价格卡呼应 */}
          <Banner
            tone={recTone}
            icon={<Star className={'w-3.5 h-3.5 ' + TONE[recTone].icon} />}
            title={t(recKey, { price: recPrice })}
            desc={t(recReasonKey, { n: usageTiao, free: freeTiao, plus: plusTiao })}
          />
          <p className="text-[11px] leading-relaxed text-ink-soft">
            {prefilled ? t('memUsageFromHistory') : t('memUsageHint')}
          </p>
        </SectionCard>
      ) : (
        <div className="rounded-2xl border border-clay-border bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-800">{t('memSliderTitle')}</p>
            <span className="text-lg font-bold text-primary-text">{daily}</span>
          </div>
          <input type="range" min={0} max={sliderMax} value={daily} onChange={(e) => setDaily(Number(e.target.value))} className="usage-slider" style={fillStyle((daily / sliderMax) * 100)} />
          <p className="text-[13px] text-gray-600 mt-2">{t(recKey, { price: recPrice })}</p>
        </div>
      )}

      {/* 期限切换：月付 / 年付（省 3 个月）/ 买断（永久）——分段控件（与 Pro 续费视图的 30/60/90 同源） */}
      {tableOnly ? null : (
        <SegmentedControl
          value={term}
          onChange={setTerm}
          options={TERMS.map(([k, label]) => ({
            key: k,
            label,
            sub: k === 'yearly' ? t('memSaveMonths') : k === 'lifetime' ? t('memLifetimeBadge') : t('memPerMonth'),
          }))}
        />
      )}

      {/* 3 张价格卡（外观全在 ui/PlanCard.tsx 的 PLAN_THEME：三视图共用一套档位观感） */}
      {tableOnly ? null : <div className="space-y-2.5">
        {cards.map(c => {
          const recommended = c.key === recFinal;
          const isFree = c.key === 'free';
          const badge = isFree ? null
            : term === 'monthly' && launch
              ? <span className="inline-block text-[10px] font-semibold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">{t('membershipLaunchOffer', { pct: discPct })}</span>
              : term === 'yearly'
                ? <span className="inline-block text-[10px] font-semibold text-primary-text bg-primary-soft rounded-full px-2 py-0.5">{t('memSaveMonths')}</span>
                : term === 'lifetime'
                  ? <span className="inline-block text-[10px] font-semibold text-primary-text bg-primary-soft rounded-full px-2 py-0.5">{t('memLifetimeBadge')}</span>
                  : null;
          return (
            <PlanCard
              key={c.key}
              plan={c.key}
              name={c.name}
              tag={c.tag}
              price={c.price}
              unit={!isFree && term === 'monthly' ? t('memPerMonth') : !isFree && term === 'lifetime' ? t('memLifetimeBadge') : null}
              priceNote={c.note || null}
              originalPrice={c.orig || null}
              badge={badge}
              recommended={recommended}
              recommendedLabel={t('membershipRecommended')}
              cta={c.cta}
              onCta={() => { if (c.key === 'free') onClose?.(); else onOpenPay?.(c.key, term); }}
            />
          );
        })}
      </div>}

      {/* 紧凑对比表（三档并排，手机宽度可容纳）——Pro 列整列淡琥珀底：一眼看出「多出来的都在哪一列」 */}
      <SectionCard header={t('membershipSeeAll')}>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-clay-border/70 bg-clay-muted/20">
              <th className="text-left text-ink-soft font-normal px-3 py-2"></th>
              {([['free', t('mFreeName')], ['plus', t('mPlusName')], ['pro', t('mProName')]] as const).map(([k, h]) => (
                <th key={k} className={'font-semibold px-1.5 py-2 whitespace-nowrap ' + (k === 'pro' ? 'text-amber-600 ' + PLAN_THEME.pro.column : 'text-gray-700')}>
                  {h}
                  {currentPlan === k && (
                    <span className="block text-[9px] font-medium text-primary-text bg-primary-lighter rounded-full px-1.5 mt-0.5">{t('memCurrentPlan')}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <Fragment key={row.key}>
                {row.section ? (
                  <tr className="bg-clay-muted/40 border-y border-clay-border/60">
                    <td colSpan={4} className="px-3 py-1.5 text-[11px] font-semibold tracking-wide text-ink-soft">{row.label}</td>
                  </tr>
                ) : (
                  <>
                <tr className={"border-b border-gray-100 last:border-0 " + (row.highlight ? 'bg-amber-50/40' : '')}>
                  <td className="text-left text-ink-soft px-3 py-2">
                    {/* ℹ️ 走**普通行内流**（不是 inline-flex）：inline-flex 会把标签文字变成一个不可分割的
                        flex item，图标固定贴在那个块的第一行右侧——长标签（「AI 額度（對話 · 劇情 · …）」）
                        折行后看起来像「图标插在句子中间」。行内流下图标总是跟在**最后一行**文字后面，读序正确。 */}
                    <span>{row.label}
                      {row.hint && (
                        <button
                          type="button"
                          onClick={() => setOpenHint(openHint === row.key ? null : row.key)}
                          aria-label={t('memInfo')}
                          title={t('memInfo')}
                          aria-expanded={openHint === row.key}
                          className={'ml-1 w-4 h-4 rounded-full inline-flex items-center justify-center align-text-top transition-colors ' + (openHint === row.key ? 'bg-primary-soft text-primary-text' : 'text-ink-soft hover:bg-primary-lighter hover:text-primary-text')}
                        >
                          <Info className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  </td>
                  {/* 数值格不换行：手机 430px 下「20 条/天」曾被折成两行（实测截图确认）；
                      数字走 tabular-nums，三列的数值才能竖着对齐 */}
                  {(row.cells || []).map((cell, ci) => <td key={ci} className={"px-1.5 py-2 text-center whitespace-nowrap tabular-nums " + (ci === 2 ? 'font-bold text-amber-600 ' + PLAN_THEME.pro.column : 'font-semibold text-gray-700')}>{cell}</td>)}
                </tr>
                {openHint === row.key && (
                  <tr className="border-b border-gray-100 bg-primary-lighter/50">
                    <td colSpan={4} className="px-4 py-2.5 text-[11px] leading-relaxed text-gray-600">{row.hint}</td>
                  </tr>
                )}
                  </>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </SectionCard>

      {/* 全档都包含（含免费版）+ 三条脚注：口径说清 = 少一半客诉（一个池 / 按消耗扣 / 公平使用）。
          收进一个安静的小字块（而不是散在卡片流里 4 行）——它们是一组说明，不是一个卖点。 */}
      <div className="rounded-xl bg-clay-muted/40 px-3 py-2.5 space-y-1">
        <p className="text-[11px] leading-relaxed text-gray-600">{t('memAllPlansLine')}</p>
        <div className="text-[11px] leading-relaxed text-ink-soft space-y-0.5">
          <p>{t('memNoteSharedPool')}</p>
          <p>{t('memNoteCost')}</p>
          <p>{t('memNoteFairUse')}</p>
        </div>
      </div>
    </div>
  );
}
