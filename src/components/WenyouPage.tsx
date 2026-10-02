/**
 * AI 文游（人生模拟器），千世书引擎移植
 * 挂在小愈「剧情演绎」下：全屏舞台，自带返回按钮。
 * 首次进入显示功能引导气泡（coach-mark）：选剧本 → AI 生成剧本 → 命书阁。
 * 目标按钮来自引擎内部 DOM（.wy-root 下按 class 查询填充 ref），不改动千世书源码。
 * 来源：https://github.com/rockbenben/thousand-lives（MIT License, Copyright (c) 2026 rockbenben）
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import WenyouApp from '../wenyou/App';
import '../wenyou/styles.css';
import '../wenyou/fonts.css';
import { getLang, t } from '../i18n';
import type { BridgeSeed } from '../lib/rpBridge';
import FeatureCoachmarks, { type CoachStep } from './FeatureCoachmarks';

export default function WenyouPage({ onBack, initialResumeId, onGoChat }: { onBack: () => void; initialResumeId?: string; onGoChat?: (seed: BridgeSeed) => void }) {
  const [coachOpen, setCoachOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_wy_coach_seen') !== '1'; } catch { return false; }
  });
  // 只在「首页（选剧本）」出现引导；挑战链接直达设置页等无首屏剧本卡时不弹
  const [homeReady, setHomeReady] = useState(false);
  const wyScenarioRef = useRef<HTMLElement | null>(null);
  const wyGenRef = useRef<HTMLElement | null>(null);
  const wyArchiveRef = useRef<HTMLElement | null>(null);

  // 千世书是懒加载：WenyouPage 挂载时引擎首页可能还没渲染 → 轮询等待 `.scenario-card` 出现后再填 ref 并显示引导。
  useEffect(() => {
    const attempt = () => {
      const root = document.querySelector('.wy-root');
      if (!root) return false;
      const sc = root.querySelector('.scenario-card:not(.create-card):not(.gen-card):not(.import-card)') as HTMLElement | null;
      if (!sc) return false;
      const gen = root.querySelector('.gen-card') as HTMLElement | null;
      const arc = root.querySelector('.collection-strip') as HTMLElement | null;
      wyScenarioRef.current = sc;
      wyGenRef.current = gen;
      wyArchiveRef.current = arc;
      // 等字体切片与首页网格布局稳定后再显示引导（rAF 后再置位）：
      // 否则目标矩形还在变，高亮「洞」与气泡会跟着目标挪，实测首次进入时引导自身就贡献了 0.137 的 CLS，
      // 且配合旧版「每次重测都重新滚动」会表现为「页面自己跳几下」（2026-09-18 用户反馈修复）。
      const settle = (): void => { requestAnimationFrame(() => setHomeReady(true)); };
      try {
        const fonts = document.fonts;
        if (fonts && fonts.ready) {
          void Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(settle);
        } else settle();
      } catch { settle(); }
      return true;
    };
    if (attempt()) return;
    const iv = setInterval(() => { if (attempt()) clearInterval(iv); }, 300);
    const to = setTimeout(() => clearInterval(iv), 6000);
    return () => { clearInterval(iv); clearTimeout(to); };
  }, []);

  const wyLang = getLang();
  const wyCoachSteps = useMemo<CoachStep[]>(() => [
    { key: 'archive', anchorRef: wyArchiveRef, text: t('coachWyArchive') },
    { key: 'gen', anchorRef: wyGenRef, text: t('coachWyGen') },
    { key: 'scenario', anchorRef: wyScenarioRef, text: t('coachWyScenario') },
  ], [wyScenarioRef, wyGenRef, wyArchiveRef, wyLang, t]);

  const finishCoach = useCallback(() => {
    setCoachOpen(false);
    try { localStorage.setItem('cure_wy_coach_seen', '1'); } catch { /* 忽略 */ }
  }, []);

  return (
    <>
      <div className="wy-root">
        <WenyouApp onBack={onBack} lang={getLang()} initialResumeId={initialResumeId} onGoChat={onGoChat} />
      </div>
      {coachOpen && homeReady && (
        <FeatureCoachmarks steps={wyCoachSteps} onDone={finishCoach} />
      )}
    </>
  );
}
