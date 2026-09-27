/**
 * 剧情「环境音」播放层（S1 声音层 · docs/roleplay-immersion-plan.md §4.1）
 *
 * 与 BGM 的关键区别（别混在一起做）：
 * - BGM 由 `useScenarioBgm` 管（世界观底色、跨详情/对话延续、用户可选曲）；
 * - 本 hook 管**这一刻的空气**：随「换幕」切换循环环境音（雨/风/室内底噪）+ 剧情触发的一次性音效（雷）。
 *
 * 三条纪律：
 * 1. **默认关**（想听再开），开关与音量持久化（localStorage + 登录用户服务端 `roleplayAmbienceEnabled`）。
 * 2. **必须用户手势**才能出声：开关由点击触发；未开启前不发任何请求（省流量）。
 * 3. **宁可轻、不可抢**：音量上限 0.45、默认 0.26，低于朗读；换幕用短淡化，避免硬切爆音。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreferences, savePreferences } from '../services/api';
import {
  ambienceForTheme, ambienceUrl, clampAmbienceVolume, oneShotsForText,
  AMBIENCE_DEFAULT_VOLUME, ONE_SHOT_COOLDOWN_MS,
} from '../lib/storyAmbience';

const LS_ENABLED = 'xiaoyu_rp_ambience_enabled_v1';
const LS_VOLUME = 'cure_rp_ambience_volume';

function loadEnabledLocal(): boolean {
  try {
    const raw = localStorage.getItem(LS_ENABLED);
    if (raw != null) return raw === '1';
  } catch { /* 忽略 */ }
  return false; // 默认关
}
function saveEnabledLocal(v: boolean): void {
  try { localStorage.setItem(LS_ENABLED, v ? '1' : '0'); } catch { /* 忽略 */ }
}
function loadVolumeLocal(): number {
  try {
    const v = parseFloat(localStorage.getItem(LS_VOLUME) || '');
    if (Number.isFinite(v) && v > 0) return clampAmbienceVolume(v);
  } catch { /* 忽略 */ }
  return AMBIENCE_DEFAULT_VOLUME;
}

export interface StoryAmbience {
  enabled: boolean;
  toggle: () => void;
  volume: number;
  setVolume: (v: number) => void;
  /** 当前循环环境音 id（未开启/未激活时为 null）——用于面板展示与测试断言 */
  currentLoop: string | null;
  /** 最近一次触发的一次性音效 id（便于观测/测试） */
  lastOneShot: string | null;
}

export function useStoryAmbience(opts: {
  theme: string;
  text?: string;
  /** 是否在剧情视图内（离开则停声） */
  active: boolean;
  loggedIn?: boolean;
}): StoryAmbience {
  const { theme, text, active, loggedIn } = opts;
  const [enabled, setEnabledState] = useState<boolean>(() => loadEnabledLocal());
  const [volume, setVolumeState] = useState<number>(() => loadVolumeLocal());
  const [currentLoop, setCurrentLoop] = useState<string | null>(null);
  const [lastOneShot, setLastOneShot] = useState<string | null>(null);

  const loopRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lastOneShotAtRef = useRef<number>(0);

  const spec = ambienceForTheme(theme);

  const ensureLoopEl = useCallback((): HTMLAudioElement => {
    if (!loopRef.current) {
      const a = new Audio();
      a.loop = true;
      a.preload = 'none';
      a.volume = 0;
      loopRef.current = a;
    }
    return loopRef.current;
  }, []);

  /** 短淡化播放（换幕不硬切） */
  const fadeTo = useCallback((el: HTMLAudioElement, target: number, ms = 600) => {
    const steps = 12;
    const from = el.volume;
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      const v = from + (target - from) * (i / steps);
      try { el.volume = Math.max(0, Math.min(1, v)); } catch { /* 忽略 */ }
      if (i >= steps) clearInterval(timer);
    }, Math.max(16, Math.round(ms / steps)));
    return timer;
  }, []);

  // 换幕 / 开关 / 视图变化 → 切换或停止环境音
  useEffect(() => {
    const el = loopRef.current;
    if (!enabled || !active) {
      if (el) { try { el.pause(); } catch { /* 忽略 */ } }
      setCurrentLoop(null);
      return;
    }
    const want = spec.loop;
    if (!want) return;
    const url = ambienceUrl(want);
    const el2 = ensureLoopEl();
    const already = el2.src.endsWith(encodeURIComponent(want) + '.wav');
    if (!already) {
      try { el2.volume = 0; } catch { /* 忽略 */ }
      el2.src = url;
      try { el2.load(); } catch { /* 忽略 */ }
    }
    el2.volume = clampAmbienceVolume(volume * 0.35); // 先极轻起播，再淡入到目标
    void el2.play().then(() => {
      setCurrentLoop(want);
      fadeTo(el2, clampAmbienceVolume(volume));
    }).catch(() => { setCurrentLoop(null); });
  }, [enabled, active, spec.loop, volume, ensureLoopEl, fadeTo]);

  // 一次性音效（剧情文本触发，带冷却）
  useEffect(() => {
    if (!enabled || !active) return;
    const shots = oneShotsForText(text);
    if (shots.length === 0) return;
    const id = shots[0];
    const now = Date.now();
    if (now - lastOneShotAtRef.current < ONE_SHOT_COOLDOWN_MS) return;
    lastOneShotAtRef.current = now;
    const a = new Audio(ambienceUrl(id));
    a.volume = Math.min(0.6, clampAmbienceVolume(volume) + 0.12);
    void a.play().then(() => setLastOneShot(id)).catch(() => { /* 忽略 */ });
  }, [text, enabled, active, volume]);

  // 卸载：停声并释放
  useEffect(() => () => {
    const el = loopRef.current;
    if (el) { try { el.pause(); } catch { /* 忽略 */ } }
    loopRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    setEnabledState(next);
    saveEnabledLocal(next);
    enabledRef.current = next;
    if (!next) {
      const el = loopRef.current;
      if (el) { try { el.pause(); } catch { /* 忽略 */ } }
      setCurrentLoop(null);
    }
    if (loggedIn) void savePreferences({ roleplayAmbienceEnabled: next }).catch(() => { /* 忽略 */ });
  }, [loggedIn]);

  const setVolume = useCallback((v: number) => {
    const nv = clampAmbienceVolume(v);
    setVolumeState(nv);
    try { localStorage.setItem(LS_VOLUME, String(nv)); } catch { /* 忽略 */ }
    const el = loopRef.current;
    if (el) { try { el.volume = nv; } catch { /* 忽略 */ } }
  }, []);

  // 登录用户：首次进入拉云端开关
  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    void getPreferences().then((r) => {
      if (!alive || !r?.success || !r.data) return;
      const v = (r.data as { roleplayAmbienceEnabled?: boolean }).roleplayAmbienceEnabled;
      if (typeof v === 'boolean' && v !== enabledRef.current) {
        setEnabledState(v);
        saveEnabledLocal(v);
        enabledRef.current = v;
      }
    }).catch(() => { /* 忽略 */ });
    return () => { alive = false; };
  }, [loggedIn]);

  return { enabled, toggle, volume, setVolume, currentLoop, lastOneShot };
}
