/**
 * 氛围乐面板（底部弹层）
 * - 名称与语气按「氛围/轻声衬底」定位，不用"配乐"
 * - 视觉：柔和高斯头部 + 推荐卡/列表行 + 柔和音量区，全部使用项目语义色（primary/soft/clay），随皮肤主题自适应
 */
import { Music, Volume2, VolumeX, X } from 'lucide-react';
import { t } from '../i18n';
import { defaultTrackForScenario, setForScenario, tracksOfSet, type BgmTrack } from '../lib/storyBgm';
import { AMBIENCE_MAX_VOLUME, clipById } from '../lib/storyAmbience';
import type { ScenarioBgm } from '../hooks/useScenarioBgm';
import type { StoryAmbience } from '../hooks/useStoryAmbience';

export interface StoryBgmPanelProps {
  open: boolean;
  onClose: () => void;
  scenario?: { id: string; tags?: string[] } | null;
  bgm: ScenarioBgm;
  /** 环境音（S1）：随换幕的雨/风/室内底噪 + 剧情触发的雷声 */
  ambience?: StoryAmbience;
}

export default function StoryBgmPanel({ open, onClose, scenario, bgm, ambience }: StoryBgmPanelProps) {
  if (!open) return null;
  const set = scenario ? setForScenario(scenario) : 'S1';
  const defaultTrack: BgmTrack | undefined = scenario ? defaultTrackForScenario(scenario) : undefined;
  const others = tracksOfSet(set).filter((c) => c.id !== defaultTrack?.id);

  const TrackGlyph = ({ active }: { active: boolean }) => (
    <span className={'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ' + (active ? 'bg-primary-strong text-white shadow-sm' : 'bg-clay-bg text-ink-soft')}>
      <Music className="h-4 w-4" />
    </span>
  );
  const PlayingDot = () => <span className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary-strong animate-pulse" />;

  const sectionTitle = (text: string) => (
    <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-bold tracking-widest text-ink-soft">
      <span className="h-3 w-[3px] rounded-full bg-primary/40" />
      {text}
    </p>
  );

  const rowBase = 'w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-all active:scale-[0.99]';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      {/* 面板本体：与全站弹窗一致，半透明白（跟随「卡片不透明度」）+ 毛玻璃。
          原来写死 `bg-white` → 拖到 0% 也依旧实心，与「界面外观」里的透明度滑块完全脱钩。 */}
      <div className="bg-white relative flex w-full max-w-2xl max-h-[82dvh] flex-col overflow-hidden rounded-t-[28px] shadow-[0_-8px_40px_rgba(0,0,0,0.18)]">
        {/* 头部：柔光渐变 + 一句话氛围文案（改成半透明渐变，否则中间那段实心白会把毛玻璃挡掉） */}
        <div className="bg-gradient-to-br from-primary-soft via-white to-accent-soft px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/80 text-primary-text shadow-sm ring-1 ring-white/70">
                <Music className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[17px] font-bold text-gray-800 leading-tight">{t('rpBgmTitle')}</h2>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">{t('rpBgmSubtitle')}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {bgm.current && (
                <span className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ' + (bgm.playing ? 'bg-primary-strong/10 text-primary-text' : 'bg-gray-100 text-ink-soft')}>
                  {bgm.playing ? <span className="h-1.5 w-1.5 rounded-full bg-primary-strong animate-pulse" /> : null}
                  {bgm.playing ? t('rpBgmPlaying') : t('rpBgmPaused')}
                </span>
              )}
              <button onClick={onClose} aria-label={t('profileCancel')} title={t('profileCancel')} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/70 text-ink-soft hover:text-gray-600 transition-colors">
                <X className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {/* 本剧默认 */}
          {defaultTrack && (
            <section className="mb-4">
              {sectionTitle(t('rpBgmDefaultLabel'))}
              <button
                onClick={() => bgm.select(defaultTrack.id)}
                className={
                  rowBase + ' relative overflow-hidden border ' +
                  (bgm.effectiveTrackId === defaultTrack.id
                    ? 'border-primary/30 bg-primary-lighter/60 ring-1 ring-primary/20'
                    : 'border-gray-100 bg-white hover:border-primary/30 hover:bg-clay-bg')
                }
              >
                <TrackGlyph active={bgm.effectiveTrackId === defaultTrack.id} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={'text-[14.5px] font-semibold leading-snug ' + (bgm.effectiveTrackId === defaultTrack.id ? 'text-primary-text' : 'text-gray-800')}>{defaultTrack.zh}</span>
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary-text">{t('rpBgmDefaultTag')}</span>
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-soft">{defaultTrack.side}</span>
                </span>
                {bgm.effectiveTrackId === defaultTrack.id ? <PlayingDot /> : null}
              </button>
            </section>
          )}

          {/* 同风格可选 */}
          {others.length > 0 && (
            <section className="mb-4">
              {sectionTitle(t('rpBgmSameSet'))}
              <div className="space-y-1.5">
                {others.map((c) => {
                  const active = bgm.effectiveTrackId === c.id;
                  return (
                    <button key={c.id} onClick={() => bgm.select(c.id)} className={rowBase + ' border ' + (active ? 'border-primary/30 bg-primary-lighter/60' : 'border-transparent bg-clay-bg/70 hover:bg-clay-bg')}>
                      <TrackGlyph active={active} />
                      <span className="min-w-0 flex-1">
                        <span className={'block text-[13.5px] font-medium leading-snug ' + (active ? 'text-primary-text' : 'text-gray-700')}>{c.zh}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{c.side}</span>
                      </span>
                      {active ? <PlayingDot /> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 不要氛围乐 */}
          {bgm.effectiveTrackId && (
            <section className="mb-4">
              <button onClick={() => bgm.select('off')} className={rowBase + ' border border-dashed border-gray-200 text-ink-soft hover:border-gray-300 hover:bg-gray-50'}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-ink-soft ring-1 ring-gray-100"><X style={{ width: 16, height: 16 }} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-gray-600">{t('rpBgmOff')}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-soft">{t('rpBgmOffHint')}</span>
                </span>
              </button>
            </section>
          )}

          {/* 环境音（S1 声音层）：随「换幕」切换的轻环境音 + 剧情触发的雷声；默认关 */}
          {ambience && (
            <section className="mb-4">
              {sectionTitle(t('rpAmbLabel'))}
              <button
                onClick={ambience.toggle}
                aria-pressed={ambience.enabled}
                aria-label={ambience.enabled ? t('rpAmbOff') : t('rpAmbOn')}
                className={
                  rowBase + ' border ' +
                  (ambience.enabled
                    ? 'border-primary/30 bg-primary-lighter/60 ring-1 ring-primary/20'
                    : 'border-gray-100 bg-white hover:border-primary/30 hover:bg-clay-bg')
                }
              >
                <span className={'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ' + (ambience.enabled ? 'bg-primary-strong text-white shadow-sm' : 'bg-clay-bg text-ink-soft')}>
                  {ambience.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={'block text-[13.5px] font-medium leading-snug ' + (ambience.enabled ? 'text-primary-text' : 'text-gray-700')}>
                    {ambience.enabled ? t('rpAmbOff') : t('rpAmbOn')}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{t('rpAmbHint')}</span>
                  {ambience.enabled && ambience.currentLoop ? (
                    <span className="mt-1 block text-[11px] font-medium text-primary-text">{t(clipById(ambience.currentLoop)?.label || 'rpAmbLabel')}</span>
                  ) : null}
                </span>
                {ambience.enabled && ambience.currentLoop ? <PlayingDot /> : null}
              </button>
              {ambience.enabled && (
                <div className="mt-2 rounded-2xl bg-white p-3 ring-1 ring-gray-100">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-gray-600">{t('rpAmbVolume')}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold tabular-nums text-primary-text shadow-sm ring-1 ring-primary/15">
                      {Math.round((ambience.volume / AMBIENCE_MAX_VOLUME) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={2}
                    value={Math.round((ambience.volume / AMBIENCE_MAX_VOLUME) * 100)}
                    onChange={(e) => ambience.setVolume((Number(e.target.value) / 100) * AMBIENCE_MAX_VOLUME)}
                    aria-label={t('rpAmbVolume')}
                    className="w-full accent-[var(--css-primary,#1FA46B)]"
                  />
                </div>
              )}
            </section>
          )}

          {/* 音量 */}
          <section className="rounded-2xl bg-gradient-to-br from-clay-bg to-white p-4 ring-1 ring-gray-100">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="flex items-center gap-2 text-[13px] font-semibold text-gray-700">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-soft text-primary-text"><Volume2 style={{ width: 15, height: 15 }} /></span>
                {t('rpBgmVolume')}
              </span>
              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold tabular-nums text-primary-text shadow-sm ring-1 ring-primary/15">{Math.round(bgm.volume * 200)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={2}
              value={Math.round(bgm.volume * 200)}
              onChange={(e) => bgm.setVolume(Number(e.target.value) / 200)}
              aria-label={t('rpBgmVolume')}
              className="w-full accent-[var(--css-primary,#1FA46B)]"
            />
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-soft">{t('rpBgmHint')}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

export type { BgmTrack };
