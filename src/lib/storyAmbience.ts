/**
 * 剧情「环境音」规格（docs/roleplay-immersion-plan.md §4.1 环境音效部分）
 *
 * 与 BGM 的分工：BGM 是**世界观底色**（一首循环曲子），环境音是**这一刻的空气**（雨/风/室内底噪），
 * 所以环境音比 BGM 更轻（默认音量更低），并支持**一次性音效**（雷声）由剧情文本触发。
 *
 * 素材来源：`scripts/generate_ambience.py` **程序合成**（免版权、无第三方权利）；
 * 想换成精选 CC0 素材时，覆盖 `public/audio/roleplay-ambience/<id>.wav` 同名文件即可，本文件不用改。
 *
 * 本文件是**纯函数**（无 DOM/无音频对象），便于单测；播放见 `src/hooks/useStoryAmbience.ts`。
 */

export interface AmbienceClip {
  id: string;
  file: string;
  /** i18n key（展示名） */
  label: string;
  /** 是否循环（雷声这类一次性音效为 false） */
  loop: boolean;
}

export const AMBIENCE_DIR = '/audio/roleplay-ambience/';

export const AMBIENCE_CLIPS: AmbienceClip[] = [
  { id: 'rain-soft', file: 'rain-soft.wav', label: 'rpAmbRain', loop: true },
  { id: 'wind-low', file: 'wind-low.wav', label: 'rpAmbWind', loop: true },
  { id: 'room-soft', file: 'room-soft.wav', label: 'rpAmbRoom', loop: true },
  { id: 'clock-tick', file: 'clock-tick.wav', label: 'rpAmbTick', loop: true },
  { id: 'thunder-far', file: 'thunder-far.wav', label: 'rpAmbThunder', loop: false },
];

export const clipById = (id: string | undefined | null): AmbienceClip | undefined =>
  AMBIENCE_CLIPS.find(c => c.id === id);

export const ambienceUrl = (id: string): string => AMBIENCE_DIR + encodeURIComponent(id) + '.wav';

/** 音量上限与默认：环境音**刻意低于** BGM 默认（0.15）之上一点点，但绝不超过人声朗读 */
export const AMBIENCE_MAX_VOLUME = 0.45;
export const AMBIENCE_DEFAULT_VOLUME = 0.26;
/** 一次性音效（雷）的最小间隔：防止连续多轮"雷"刷屏 */
export const ONE_SHOT_COOLDOWN_MS = 25000;

export interface AmbienceSpec {
  /** 当前幕的环境音循环（null = 这一幕不放环境音） */
  loop: string | null;
  /** 建议音量（0..AMBIENCE_MAX_VOLUME） */
  volume: number;
  /** 随事件触发的一次性音效 */
  oneShots: string[];
}

/**
 * 主题 → 环境音。口径：**宁可轻，不可抢**（音量都在 0.16~0.30）。
 */
export function ambienceForTheme(theme: string | undefined | null): AmbienceSpec {
  switch (String(theme || '')) {
    case 'rain':
      return { loop: 'rain-soft', volume: 0.3, oneShots: [] };
    case 'night':
      return { loop: 'wind-low', volume: 0.22, oneShots: [] };
    case 'crisis':
      return { loop: 'wind-low', volume: 0.3, oneShots: [] };
    case 'memory':
      return { loop: 'clock-tick', volume: 0.18, oneShots: [] };
    case 'alone':
      return { loop: 'room-soft', volume: 0.2, oneShots: [] };
    case 'intimate':
    case 'promise':
      return { loop: 'room-soft', volume: 0.18, oneShots: [] };
    case 'cold':
    case 'conflict':
    case 'parting':
      return { loop: 'room-soft', volume: 0.18, oneShots: [] };
    default:
      // daily / meet / flutter / reconcile / 未知：只给一点点"房间感"
      return { loop: 'room-soft', volume: 0.16, oneShots: [] };
  }
}

/**
 * 剧情文本 → 触发的一次性音效。
 * 只认**明确的声音事件**（雷/轰），不认情绪词，避免"每轮都在响"的廉价感。
 */
export function oneShotsForText(text: string | undefined | null): string[] {
  const s = String(text || '');
  if (!s.trim()) return [];
  const out: string[] = [];
  if (/雷|轰隆|thunder/i.test(s)) out.push('thunder-far');
  return out;
}

/** 用于播放层的最终音量（把建议音量收敛进上限） */
export function clampAmbienceVolume(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(AMBIENCE_MAX_VOLUME, v);
}
