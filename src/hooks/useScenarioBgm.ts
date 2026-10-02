/**
 * 剧情配乐播放管理（角色剧情扮演）
 * - 默认曲：剧本级映射（storyBgm）；用户可在 ♪ 面板自选/关闭，登录用户跨设备同步，游客 localStorage
 * - 自动播放红线：浏览器要求用户手势；由调用方在「进详情看背景/进入剧情/试听」点击后 markUserGesture()
 * - 同曲跨「详情 → 对话」沿用同一 Audio 延续（不重播）；首播被浏览器拦截时可在下一次手势 tryPlay() 续上
 */
import { useEffect, useRef, useState } from 'react';
import { bgmUrl, defaultTrackForScenario, trackById, type BgmTrack } from '../lib/storyBgm';
import { getRoleplayBgmPrefs, saveRoleplayBgmPref, type ApiResponse } from '../services/api';
import { lsGet, lsSet } from '../lib/safeStorage';

const LS_PREFIX = 'cure_rp_bgm_';
const LS_VOL = 'cure_bgm_volume';
const LS_MUTE = 'cure_bgm_muted';
const OFF = 'off'; // 用户选择"不使用配乐"

// ⚠️ 这两个函数在 `useScenarioBgm()` 里被 **useState 初始化器**直接调用（即渲染期），
// 而 RoleplayPage 一挂载就会调用它，裸调 localStorage 在「存储被禁」的浏览器里会抛异常，
// 因为发生在渲染路径上、又没有 ErrorBoundary，会把**整个剧情模式**变成白屏。
// 所以这里必须走带护栏的 safeStorage（读取失败=当作没存过）。
export function loadBgmVolume(): number {
  const v = parseFloat(lsGet(LS_VOL) || '');
  return Number.isFinite(v) && v > 0 ? Math.min(v, 0.5) : 0.15;
}
export function loadBgmMuted(): boolean {
  return lsGet(LS_MUTE) === '1';
}

export interface ScenarioBgm {
  /** 当前播放对象 */
  current: BgmTrack | null;
  /** 生效的曲目 id（含默认解析结果）；用户关闭时为 null */
  effectiveTrackId: string | null;
  playing: boolean;
  paused: boolean;       // 有曲目但浏览器阻止自动播放（待用户手势）
  muted: boolean;
  volume: number;        // 0..0.5
  /** 面板选中态（含 'off'/默认标记），用于高亮 */
  userChoice: string | '' | 'off';
  markUserGesture: () => void;
  tryPlay: () => void; // 曲目已就绪但被浏览器拦截/未出声时，在当前用户手势内尝试续播（同曲跨页不重播）
  select: (trackId: string) => void; // 同套候选/默认；'off' 关闭
  togglePlay: () => void;
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
}

function readGuestChoice(scenarioId: string): string {
  try { return localStorage.getItem(LS_PREFIX + scenarioId) || ''; } catch { return ''; }
}
function writeGuestChoice(scenarioId: string, v: string): void {
  try {
    if (!v) localStorage.removeItem(LS_PREFIX + scenarioId);
    else localStorage.setItem(LS_PREFIX + scenarioId, v);
  } catch { /* 忽略 */ }
}

let remoteCache: { bgmByScenario: Record<string, string> } | null = null;
let remoteLoading: Promise<void> | null = null;

function loadRemote(): Promise<void> {
  if (remoteCache) return Promise.resolve();
  if (!remoteLoading) {
    remoteLoading = getRoleplayBgmPrefs()
      .then(r => { remoteCache = r.success && r.data ? r.data : { bgmByScenario: {} }; })
      .catch(() => { remoteCache = { bgmByScenario: {} }; })
      .finally(() => { remoteLoading = null; });
  }
  return remoteLoading;
}

export function useScenarioBgm(scenarioId: string | null | undefined, loggedIn: boolean, tags?: string[]): ScenarioBgm {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const gestureRef = useRef(false);
  const userTouchedRef = useRef(false); // 本次场景是否已手动改过（防远端回填覆盖）
  const [trackId, setTrackId] = useState<string | null>(null);   // 生效曲目
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolumeState] = useState(loadBgmVolume());
  const [muted, setMutedState] = useState(loadBgmMuted());
  const [remoteMap, setRemoteMap] = useState<Record<string, string>>({});
  const [userChoice, setUserChoice] = useState<string | '' | 'off'>('');

  const getAudio = (): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.loop = true;
      a.preload = 'auto';
      a.addEventListener('ended', () => setPlaying(false));
      audioRef.current = a;
    }
    return audioRef.current;
  };

  const applyVolume = () => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = muted ? 0 : volume;
  };

  // 音量/静音持久化（本设备）
  useEffect(() => {
    lsSet(LS_VOL, String(volume));
    applyVolume();
  }, [volume, muted]);

  const _effectiveFor = (sid: string, map: Record<string, string>, _touch: boolean): string => {
    const stored = map[sid] ?? readGuestChoice(sid);
    if (stored === OFF) return '';
    if (stored && trackById(stored)) return stored;
    return defaultTrackForScenario({ id: sid, tags }).id;
  };

  // 登录用户首次进入聊天时拉取云端偏好
  useEffect(() => {
    if (!loggedIn || remoteCache) return;
    loadRemote().then(() => { if (remoteCache) setRemoteMap(remoteCache.bgmByScenario); });
  }, [loggedIn]);

  // 剧本变化：解析默认/用户选择并（若有手势）播放
  useEffect(() => {
    const sid = scenarioId;
    userTouchedRef.current = false;
    if (!sid) {
      audioRef.current?.pause();
      setTrackId(null);
      setPlaying(false);
      setUserChoice('');
      return;
    }
    const map = remoteMap;
    const choice = map[sid] ?? readGuestChoice(sid) ?? '';
    setUserChoice(choice);
    userTouchedRef.current = !!choice; // 有历史选择视为"已明确"
    const target = choice === OFF ? null : (choice && trackById(choice) ? choice : defaultTrackForScenario({ id: sid, tags }).id);
    setTrackId(target);
    if (!target) { audioRef.current?.pause(); setPlaying(false); return; }
    const a = getAudio();
    if (a.src && a.src.endsWith('/' + encodeURIComponent(target) + '.mp3')) {
      // 同一曲目：仅处理播放态
    } else {
      a.src = bgmUrl(target);
      a.load();
    }
    applyVolume();
    if (gestureRef.current) {
      gestureRef.current = false;
      void a.play().then(() => { setPlaying(true); setBlocked(false); }).catch(() => { setPlaying(false); setBlocked(true); });
    } else {
      setPlaying(false);
      setBlocked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId]);

  // 卸载/停止
  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  const persistChoice = (sid: string, v: string) => {
    writeGuestChoice(sid, v);
    if (loggedIn && remoteMap) {
      void saveRoleplayBgmPref(sid, v === OFF ? OFF : (v || ''))
        .then((r: ApiResponse<{ bgmByScenario: Record<string, string> }>) => {
          if (r.success && r.data) { remoteCache = r.data; setRemoteMap(r.data.bgmByScenario); }
        })
        .catch(() => {});
    }
  };

  return {
    current: trackId ? trackById(trackId) || null : null,
    effectiveTrackId: trackId,
    playing,
    paused: blocked,
    muted,
    volume,
    userChoice,
    markUserGesture: () => { gestureRef.current = true; },
    tryPlay: () => {
      // 曲目已加载到播放器但尚未出声（如详情页首播被拦截、同剧本「详情→对话」延续）
      // → 在本次用户手势内直接续播，不依赖「剧本变化」effect 才触发。
      // 仅限 blocked（从未出声）场景：用户手动暂停过的不擅自恢复。
      const a = audioRef.current;
      if (!blocked || !a || !trackId || !a.src || !a.paused) return;
      void a.play().then(() => { setPlaying(true); setBlocked(false); }).catch(() => { setBlocked(true); });
    },
    select: (id: string) => {
      const sid = scenarioId;
      if (!sid) return;
      userTouchedRef.current = true;
      setUserChoice(id);
      persistChoice(sid, id);
      if (id === OFF) {
        audioRef.current?.pause();
        setTrackId(null);
        setPlaying(false);
        return;
      }
      const t = trackById(id);
      if (!t) return;
      const a = getAudio();
      a.src = bgmUrl(id);
      a.load();
      applyVolume();
      setTrackId(id);
      setBlocked(false);
      void a.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); setBlocked(true); });
    },
    togglePlay: () => {
      const a = audioRef.current;
      if (!a || !trackId) return;
      if (a.paused) {
        void a.play().then(() => { setPlaying(true); setBlocked(false); }).catch(() => setBlocked(true));
      } else {
        a.pause();
        setPlaying(false);
      }
    },
    setMuted: (m) => { setMutedState(m); lsSet(LS_MUTE, m ? '1' : '0'); },
    setVolume: (v) => setVolumeState(Math.max(0, Math.min(0.5, v))),
  };
}
