/**
 * 微信式语音气泡（纯气泡，不含文字）：播放/暂停、伪波形、时长。
 * 外层是一个「胶囊形气泡」，配色跟随当前皮肤（--color-primary / --color-primary-strong）。
 * 两种用法：
 *  - 用户录音（accent="light"）：自持 <audio src>，点即播，自己读时长。
 *  - 小愈朗读（accent="brand"）：由父级通过 onToggle 接管播放；音频未就绪时区分两态
 *    尚未开始合成：静态「点击生成」入口（不转圈、不写“准备中”，点了才发起合成并播放）；
 *    合成在途（loading=true）：转圈 + 加载提示；就绪后变为可播气泡。
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Loader2 } from 'lucide-react';

type Accent = 'light' | 'brand';

const BARS = [6, 10, 14, 9, 12, 7, 11, 8, 13, 6, 10, 9]; // 伪波形高度(px)

export interface VoiceMessageProps {
  /** 已就绪的音频 URL/data URL（用户录音，或小愈预载后的 object URL） */
  src?: string;
  /** 预设时长（秒）；null=未知 → 展示占位 */
  duration?: number | null;
  /** 外部控制的播放态（小愈侧） */
  playing?: boolean;
  /** 合成/加载中（小愈侧显示加载态） */
  loading?: boolean;
  /** 外部接管播放（小愈侧传入 playAssistantVoice） */
  onToggle?: () => void;
  /** 配色：light=用户发（绿气泡内白透）；brand=小愈朗读（白气泡内皮肤主色） */
  accent?: Accent;
  /** 加载态提示文案（未传则回退默认） */
  loadingLabel?: string;
  /** 未就绪（尚未合成）时的静态入口文案（未传则回退默认） */
  notReadyLabel?: string;
}

export default function VoiceMessage({ src, duration, playing, loading, onToggle, accent = 'light', loadingLabel, notReadyLabel }: VoiceMessageProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [internalPlaying, setInternalPlaying] = useState(false);
  const [internalDuration, setInternalDuration] = useState(0);

  const isExternal = typeof onToggle === 'function';
  const activePlaying = isExternal ? !!playing : internalPlaying;
  // 小愈侧：音频源尚未就绪（未预载/未合成）。此状态分两种呈现：
  //  - loading=true → 合成在途，显示转圈 + 加载文案（不可重复点击）；
  //  - loading=false → 未开始合成，显示静态「点击生成」入口（点击才发起合成并播放，避免假加载）。
  const notReady = isExternal && !src;

  // 用户侧：自持 audio，读时长 + 播完复位
  useEffect(() => {
    const a = audioRef.current;
    if (!a || isExternal) return;
    const onLoaded = () => { try { setInternalDuration(Math.round(a.duration || 0)); } catch { /* 忽略 */ } };
    const onEnded = () => setInternalPlaying(false);
    a.addEventListener('loadedmetadata', onLoaded);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('loadedmetadata', onLoaded);
      a.removeEventListener('ended', onEnded);
    };
  }, [isExternal]);

  const handleToggle = () => {
    if (isExternal) { onToggle?.(); return; }
    const a = audioRef.current;
    if (!a) return;
    if (internalPlaying) {
      a.pause();
      setInternalPlaying(false);
    } else {
      a.play()
        .then(() => setInternalPlaying(true))
        .catch(() => { /* 自动播放受限/解码失败：静默 */ });
    }
  };

  const shownDuration = duration ?? (isExternal ? null : (internalDuration || null));
  const brand = accent === 'brand';

  // 胶囊气泡容器：skin-aware（主色/主色强）+ 圆角胶囊 + 轻边框，读作「独立气泡」
  const container = brand
    ? 'bg-primary/10 border border-primary/25'
    : 'bg-white/20 border border-white/25';

  // 播放圆钮
  const ring = brand
    ? 'bg-primary text-white'
    : 'bg-white/90 text-primary-text';

  // 伪波形
  const barBg = brand ? 'bg-primary/70' : 'bg-white/90';

  // 时长
  const durText = brand ? 'text-primary-text' : 'text-white/95';

  // 状态提示文案与颜色（仅小愈侧会出现）
  const loadingHint = loadingLabel ?? '正在生成语音…';
  const idleHint = notReadyLabel ?? '点击生成语音';
  const stateTextColor = brand ? 'text-primary-text' : 'text-white/95';

  return (
    <div className={`inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 max-w-full ${container}`}>
      {notReady ? (
        loading ? (
          <button
            onClick={handleToggle}
            onPointerDown={(e) => e.stopPropagation()}
            disabled
            aria-label={loadingHint}
            title={loadingHint}
            className="inline-flex items-center gap-2 opacity-70 cursor-wait transition-opacity"
          >
            <Loader2 className={`w-4 h-4 animate-spin ${stateTextColor}`} />
            <span className={`text-[12px] font-medium whitespace-nowrap ${stateTextColor}`}>{loadingHint}</span>
          </button>
        ) : (
          <button
            onClick={handleToggle}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={idleHint}
            title={idleHint}
            className="inline-flex items-center gap-2 transition-opacity"
          >
            <span className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${ring}`}>
              <Play className="w-3.5 h-3.5" />
            </span>
            <span className={`text-[12px] font-medium whitespace-nowrap ${stateTextColor}`}>{idleHint}</span>
          </button>
        )
      ) : (
        <>
          <button
            onClick={handleToggle}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={loading}
            aria-label={loading ? '正在生成语音' : activePlaying ? '暂停语音' : '播放语音'}
            title={loading ? '正在生成语音' : activePlaying ? '暂停语音' : '播放语音'}
            className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${ring} ${loading ? 'opacity-60 cursor-wait' : ''} transition-colors`}
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : activePlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <span className={`flex items-end gap-0.5 h-5 ${activePlaying ? 'animate-pulse' : ''}`}>
            {BARS.map((h, i) => (
              <span key={i} style={{ height: h }} className={`w-0.5 rounded ${barBg}`} />
            ))}
          </span>
          <span className={`text-[12px] flex-shrink-0 tabular-nums ${durText}`}>
            {shownDuration ? `${shownDuration}″` : '…″'}
          </span>
        </>
      )}
      {!isExternal && src && <audio ref={audioRef} src={src} className="hidden" preload="metadata" />}
    </div>
  );
}
