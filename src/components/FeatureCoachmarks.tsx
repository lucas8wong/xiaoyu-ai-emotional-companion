/**
 * 首次进入 · 功能引导气泡（coach-mark，通用组件，供聊一聊/主页/剧情模式复用）
 *
 * 形态 B：暗色遮罩 + 目标高亮「洞」+ 一条指向对应按钮的气泡，逐个介绍功能点。
 * 每个气泡可关闭（关闭 = 跳到下一步）、可「跳过」整个引导、「下一个」推进。
 * 各页面各自的 localStorage 记忆键控制是否显示（如 cure_chat_coach_seen / cure_home_coach_seen / cure_rp_coach_seen）。
 *
 * ⚠️ 2026-09-22 修「新用户主页理一理气泡被隐私确认横幅挡住」：底部隐私横幅（未同意的新访客常驻，
 *   手机 ~104px / 桌面 ~61px）占掉视口最下面一条，而本组件此前把「目标在不在视口里」「气泡放上还是放下」
 *   都按**整条视口**算，洞与气泡会落进横幅那一条（实测桌面 1280×800：理一理按钮 754–800 整颗在
 *   横幅 739–800 之下，洞挖开的是横幅、箭头也指着横幅；360×640 同样整颗被盖住），且全屏遮罩把横幅
 *   压暗并吞掉它的点击（「同意并继续」在 7 步引导期间根本点不动）。
 *   现在：① 安全区底边 = 视口高 − store.privacyBannerH（与 2026-09-03 聊一聊输入栏预留同一口径），
 *   洞的可见性判定、滚动补差与气泡定位全按它来；② 遮罩裁到安全区 ⇒ 横幅在引导期间保持可见、可点
 *   （合规提示不该被引导吞掉）。横幅不存在（已同意/已登录）时 privacyBannerH=0，行为与改前一致。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';

export interface CoachStep {
  key: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  text: string;
}
interface FeatureCoachmarksProps {
  steps: CoachStep[];
  onDone: () => void;
  /**
   * 「跳过」的语义与「走完」不同：走完只是这一层讲完了，跳过是"我不想看引导"。
   * 需要区分时传它（聊一聊按层拆成两套气泡时就靠这个：在列表层点跳过，不该进了对话又弹五条）。
   * 不传则与旧行为一致（跳过 = onDone）。
   */
  onSkip?: () => void;
}

interface Coords {
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function FeatureCoachmarks({ steps, onDone, onSkip }: FeatureCoachmarksProps) {
  const [idx, setIdx] = useState(0);
  const [coords, setCoords] = useState<Coords | null>(null);
  const coordsRef = useRef<Coords | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  /** 气泡实测高度：决定它放目标下方放不放得下、会不会越进底部隐私横幅那一条 */
  const [bubbleH, setBubbleH] = useState(0);
  /** 底部隐私横幅高度（px；无横幅=0），引导的「安全区底边」= 视口高 − 它 */
  const privacyBannerH = useAppStore((s) => s.privacyBannerH);
  /** 隐私政策弹窗是否打开（可从底部横幅点进来）：打开时引导让位，不压在弹窗上（见下方 return null） */
  const privacyOpen = useAppStore((s) => s.privacyOpen);
  const step = steps[idx];

  const advance = useCallback((delta: number) => {
    const next = idx + delta;
    if (next < 0) return;
    if (!steps[next]) { onDone(); return; }
    setIdx(next);
  }, [idx, steps, onDone]);

  // 气泡渲染后量一次真实高度（无依赖数组 = 每轮渲染后校正；同值 setState 会被 React bail out，不会死循环）
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    setBubbleH((prev) => (prev === h ? prev : h));
  });

  // 取当前目标元素的视口矩形，并监听窗口尺寸/横竖屏/键盘高度变化（移动端键盘会抬高底部输入栏）。
  // 首次挂载时 ref 可能尚未赋给目标元素（下一帧才会附加）→ 用 rAF 重试直至拿到矩形；
  // 连续多帧仍拿不到（目标不存在）→ 跳到下一步，避免卡住。
  useLayoutEffect(() => {
    if (!step) return;
    // 隐私政策弹窗期间引导整体让位（见下方 return null）：不为它挂监听/滚动，弹窗关掉后重来一遍
    if (privacyOpen) return;
    const measure = () => {
      const el = step.anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const next = { left: r.left, top: r.top, width: r.width, height: r.height };
      const prev = coordsRef.current;
      if (!prev || prev.left !== next.left || prev.top !== next.top || prev.width !== next.width || prev.height !== next.height) {
        coordsRef.current = next;
        setCoords(next);
      }
    };
    /**
     * 只在「目标不在视口内」时才滚动，且**一次性、无动画**。
     *
     * 🐞 2026-09-18 修「首次进入 AI 文游，页面自己跳几下」（用户反馈）：
     *   旧实现是 `scrollIntoView({ block: 'center', behavior: 'auto' })`，两处叠加导致页面自己动：
     *     ① `behavior:'auto'` 不是「立即」，而是「用 CSS 的 scroll-behavior」，本项目 `index.css` 里
     *        `html{scroll-behavior:smooth}`，于是每次调用都变成**动画滚动**；
     *     ② 它还被放进了下面 250ms 的轮询里，动画没走完就被再次触发 → 页面连续抖动（实测 y=96→105→101→95→91）；
     *  而且目标本来就在屏幕内也照滚不误（文游首页「命书阁」在 y=509 / 视口 932，仍然被滚了 91px）。
     *   现在：已在视口内 → 一动不动；不在视口内 → 只滚一次（`block:'nearest'` 最小距离 + `behavior:'instant'` 忽略 smooth）。
     *   轮询只负责重新测量「洞」和气泡的位置，不再主动滚动（否则会和用户自己的滚动手势打架）。
     */
    const ensureVisible = () => {
      const el = step.anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      // 安全底边：底部隐私横幅占的那一条不算可用区（横幅是 fixed，不改变视口高，所以要自己扣）
      const safeBottom = vh - 8 - privacyBannerH;
      const inside = r.top >= 8 && r.bottom <= safeBottom && r.left >= 0 && r.right <= vw;
      if (inside) return;
      try {
        // 'instant' 明确要求立即跳转，不受 html{scroll-behavior:smooth} 影响
        el.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
      } catch { /* 忽略 */ }
      // 「nearest」只保证目标进视口，它可能正好停在横幅底下（实测 1280×800 整颗按钮落在横幅下）
      // ⇒ 再补一次差额，把目标抬到安全底边之上。一次性、无动画；页面滚到底时差额会被浏览器自然吃掉。
      const after = el.getBoundingClientRect();
      const deficit = after.bottom - safeBottom;
      if (deficit > 0) {
        const room = Math.max(0, after.top - 8); // 别把目标顶出屏幕上方
        const dy = Math.min(deficit, room);
        if (dy > 0) {
          try {
            window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
          } catch {
            window.scrollBy(0, dy);
          }
        }
      }
    };
    // 首次挂载时 ref 可能尚未赋给目标元素（下一帧才会附加）→ 用 rAF 重试直至拿到矩形；
    // 连续多帧仍拿不到（目标不存在）→ 跳到下一步，避免卡住。
    let raf = 0;
    let tries = 0;
    const retryRead = () => {
      const el = step.anchorRef.current;
      if (!el) {
        if (tries++ < 20) { raf = requestAnimationFrame(retryRead); }
        else { advance(1); }
        return;
      }
      measure();
      ensureVisible();
    };
    retryRead();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('load', measure);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    // 目标位置可能因首页懒加载/字体替换等布局变化而漂移 → 低频重测「洞」与气泡位置；
    // ⚠️ 这里**不再**重新滚动（见 ensureVisible 注释：那是「页面自己跳」的成因）。
    const iv = setInterval(() => { measure(); }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('load', measure);
      vv?.removeEventListener('resize', measure);
    };
  }, [step, advance, privacyBannerH, privacyOpen]);

  if (!step) return null;
  if (typeof window === 'undefined') return null;
  /**
   * 隐私政策弹窗是 z-[80]，在引导遮罩（z-90/91）之下，让横幅可点之后，用户从横幅点「隐私政策」
   * 会看到弹窗被压在引导暗色遮罩下、按钮点不动。所以弹窗期间引导整体不渲染（组件仍挂载，idx 不丢），
   * 关闭弹窗后自动回到当前这一步。
   */
  if (privacyOpen) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bubbleMaxW = Math.min(320, vw - 24);
  const targetCenterX = coords ? coords.left + coords.width / 2 : vw / 2;
  const bubbleLeft = coords ? Math.max(12, Math.min(targetCenterX - bubbleMaxW / 2, vw - bubbleMaxW - 12)) : 12;

  /**
   * 气泡放目标上/下方，但**安全区底边 = 视口高 − 隐私横幅高**，气泡不许越进横幅那一条。
   * 判定顺序：下面放得下 → 放下面；放不下 → 放上面；两边都放不下（极小屏兜底）→ 选空间大的一侧并夹紧。
   * estH 用气泡实测高度（bubbleH），首帧还没量到时退化为 96px 估算，量完自动校正。
   */
  const GAP = 14;
  const safeBottom = Math.max(0, vh - privacyBannerH);
  const estH = bubbleH || 96;
  const roomBelow = coords ? safeBottom - 8 - (coords.top + coords.height + GAP) : 0;
  const roomAbove = coords ? coords.top - GAP - 8 : 0;
  const below = coords ? (roomBelow >= estH ? true : roomAbove >= estH ? false : roomBelow >= roomAbove) : true;

  // 气泡贴近目标（目标尽量已滚动到屏幕中央，见 ensureVisible）；气泡相对目标放上/下方
  const bubbleStyle: React.CSSProperties = {
    left: bubbleLeft,
    width: bubbleMaxW,
    maxWidth: bubbleMaxW,
    ...(coords
      ? (below
          // 放下面：贴着目标底边，但不越过安全底边
          ? { top: Math.max(8, Math.min(coords.top + coords.height + GAP, safeBottom - 8 - estH)) }
          // 放上面：贴着目标顶边，且气泡下沿不越过安全底边（bottom ≥ 横幅高 + 8）
          : { bottom: Math.max(vh - coords.top + GAP, vh - safeBottom + 8) })
      : { top: 8 }),
  };
  const arrowLeft = Math.max(14, Math.min(targetCenterX - bubbleLeft - 7, bubbleMaxW - 20));

  return (
    <>
      {/* 遮罩层：只铺到隐私横幅上沿（bottom = privacyBannerH + overflow-hidden 把洞外那圈 9999px
          暗色影子裁掉）⇒ 横幅在引导期间既不被压暗、也仍可点「同意并继续」（合规提示不该被引导吞掉）。
          没有横幅时 privacyBannerH=0，就是原来的全屏遮罩。 */}
      <div className="fixed inset-x-0 top-0 z-[90] overflow-hidden" style={{ bottom: privacyBannerH }}>
        {coords ? (
          <div
            className="absolute"
            style={{
              left: coords.left - 3,
              top: coords.top - 3,
              width: coords.width + 6,
              height: coords.height + 6,
              borderRadius: 12,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-black/45" />
        )}
      </div>

      {coords && step && (
        /* 气泡层：整屏（坐标口径与遮罩一致＝视口坐标）但自身不接收点击，只有气泡可点
           这样底部那条横幅不会被这一层吞掉。 */
        <div className="fixed inset-0 z-[91] pointer-events-none">
        <div
          ref={bubbleRef}
          className="absolute pointer-events-auto bg-primary-soft rounded-2xl border border-primary shadow-2xl px-4 py-3"
          style={bubbleStyle}
        >
          <button
            onClick={onSkip ?? onDone}
            aria-label={t('uiTourDone')}
            title={t('uiTourDone')}
            className="absolute right-2 top-2 p-1 text-ink-soft hover:text-ink flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
          <p className="text-[13px] leading-relaxed text-ink pr-6">{step.text}</p>
          <div className="flex items-center justify-between gap-3 mt-2">
            <button onClick={onSkip ?? onDone} className="text-[11px] text-ink-soft hover:text-ink underline underline-offset-2">
              {t('coachSkip')}
            </button>
            <button
              onClick={() => advance(1)}
              className="text-[12px] font-medium text-white bg-primary-strong rounded-full px-3.5 py-1.5 hover:bg-primary transition-colors"
            >
              {steps[idx + 1] ? t('coachNext') : t('coachDone')}
            </button>
          </div>
          {/* 指向目标的小箭头（与气泡背景同色，跟随皮肤） */}
          <div
            className={`absolute w-3 h-3 rotate-45 bg-primary-soft ${below ? '-top-1.5' : '-bottom-1.5'}`}
            style={below ? { left: arrowLeft, top: -6 } : { left: arrowLeft, bottom: -6 }}
          />
        </div>
        </div>
      )}
    </>
  );
}
