/**
 * 剧情「角色配音」播放管理（角色剧情扮演 · S1 声音层）
 *
 * 复用「聊一聊」已验证的三条硬经验（别再踩一遍）：
 * 1. **合成串行化（并发=1）**：一段剧情回复往往被拆成多条气泡，若并发打 VoxCPM 侧车，
 *    音频会串位（表现为"点这一条播的是下一条"）。见 CHANGELOG 2026-09-06。
 * 2. **缓存带文本校验**：缓存/在途请求都以「文本一致」为前提复用，内容变了就重新合成，
 *    绝不播旧文本/旧音色的音频（读字错音、漏字的根因）。
 * 3. **objectURL 生命周期**：新音频替换旧音频时先 revoke，卸载时统一回收，避免长会话内存膨胀。
 *
 * 与聊一聊的差异：剧情是**每个剧本一个音色**（`storyVoice` 按标签+性别选），
 * 且**默认关闭**（想听再开），开关随登录用户跨设备同步（偏好键 roleplayVoiceEnabled）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLang } from '../i18n';
import { ttsToAudio, getPreferences, savePreferences } from '../services/api';
import { speakableRoleplayText, clampForSpeech } from '../lib/storyVoice';

const LS_ENABLED = 'xiaoyu_rp_voice_enabled_v1';

function loadEnabledLocal(): boolean {
  try {
    const raw = localStorage.getItem(LS_ENABLED);
    if (raw != null) return raw === '1';
  } catch { /* 忽略 */ }
  return false; // 默认关（想听再开，与聊一聊口径一致）
}
function saveEnabledLocal(v: boolean): void {
  try { localStorage.setItem(LS_ENABLED, v ? '1' : '0'); } catch { /* 忽略 */ }
}

export interface StoryVoice {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** 该条音频是否已就绪（且文本与当前内容一致）→ 传 url 给语音气泡 */
  readyUrl: (id: string, content: string) => { url: string; duration: number } | undefined;
  speakingId: string | null;
  loadingId: string | null;
  /** 预载（仅在开启时真正请求；失败静默，不影响剧情） */
  prepare: (id: string, content: string) => void;
  /** 点击语音气泡：播放/停止 */
  toggle: (id: string, content: string) => void;
  stop: () => void;
}

export function useStoryVoice(opts: {
  /** VoxCPM 文本音色设计串（由 storyVoice.storyVoiceDesign 算好，含语言词） */
  design: string;
  /**
   * 音色参考名（= 预设 id，如 "gentle-f"）→ 侧车参考库 third_party/voice-refs/{name}.wav(+.txt)。
   * 2026-09-15 起剧情配音**走克隆路径**：实测设计路径语速仅 2.4~2.8 字/秒（自然朗读约 4–5），
   * 克隆路径 4.2~4.5 字/秒；且克隆只决定音色、**不拖慢语速**，所以参考音频本身偏慢也没关系。
   */
  reference?: string;
  /** 去掉开头的「角色名：」前缀用 */
  aiName?: string;
  loggedIn?: boolean;
}): StoryVoice {
  const { design, reference, aiName, loggedIn } = opts;
  const [enabled, setEnabledState] = useState<boolean>(() => loadEnabledLocal());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const designRef = useRef(design);
  designRef.current = design;
  const refRef = useRef(reference);
  refRef.current = reference;
  const aiNameRef = useRef(aiName);
  aiNameRef.current = aiName;

  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [_urlMeta, setUrlMeta] = useState<Record<string, { url: string; duration: number }>>({});

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 已注册的 objectURL：id → { url, duration, text }
  const urlRef = useRef(new Map<string, { url: string; duration: number; text: string }>());
  // 合成缓存 / 在途请求：key = id||voice||lang
  const cacheRef = useRef(new Map<string, { blob: Blob; text: string }>());
  const inflightRef = useRef(new Map<string, { text: string; promise: Promise<Blob> }>());
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const CACHE_MAX = 12;

  const cleanFor = useCallback((content: string): string => {
    const cleaned = speakableRoleplayText(content, { aiName: aiNameRef.current });
    return clampForSpeech(cleaned);
  }, []);

  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const result = chainRef.current.then(fn, fn);
    chainRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const getAudio = useCallback((id: string, content: string): Promise<Blob> => {
    const text = cleanFor(content);
    if (!text) return Promise.reject(new Error('empty speech text'));
    const voice = designRef.current;
    const lang = getLang();
    const key = `${id}||${voice}||${lang}`;
    const cached = cacheRef.current.get(key);
    if (cached && cached.text === text) return Promise.resolve(cached.blob);
    if (cached) cacheRef.current.delete(key);
    const inflight = inflightRef.current.get(key);
    if (inflight && inflight.text === text) return inflight.promise;
    const p = enqueue(async () => {
      const again = cacheRef.current.get(key);
      if (again && again.text === text) return again.blob;
      const blob = await ttsToAudio(text, lang, voice, refRef.current);
      const m = cacheRef.current;
      m.delete(key);
      m.set(key, { blob, text });
      while (m.size > CACHE_MAX) {
        const first = m.keys().next().value;
        if (first === undefined || first === key) break;
        m.delete(first);
      }
      return blob;
    });
    inflightRef.current.set(key, { text, promise: p });
    return p;
  }, [cleanFor, enqueue]);

  /** blob → objectURL + 时长（文本变化时替换并回收旧 URL） */
  const registerUrl = useCallback(async (id: string, blob: Blob, content: string): Promise<{ url: string; duration: number }> => {
    const text = cleanFor(content);
    const existing = urlRef.current.get(id);
    if (existing && existing.text === text) return existing;
    if (existing) { try { URL.revokeObjectURL(existing.url); } catch { /* 忽略 */ } }
    const url = URL.createObjectURL(blob);
    const duration = await new Promise<number>((resolve) => {
      const a = new Audio(url);
      let settled = false;
      const once = (v: number) => {
        if (settled) return;
        settled = true;
        a.removeAttribute('src');
        try { a.load(); } catch { /* 忽略 */ }
        resolve(v);
      };
      a.onloadedmetadata = () => once(Math.round(a.duration || 0));
      a.onerror = () => once(0);
      setTimeout(() => once(Math.round(a.duration || 0)), 1000);
    });
    const meta = { url, duration, text };
    urlRef.current.set(id, meta);
    setUrlMeta(prev => ({ ...prev, [id]: { url, duration } }));
    return meta;
  }, [cleanFor]);

  const readyUrl = useCallback((id: string, content: string) => {
    const meta = urlRef.current.get(id);
    if (!meta) return undefined;
    // 文本校验：会话切换/重新生成后（index 复用）绝不返回旧音频
    if (meta.text !== cleanFor(content)) return undefined;
    return { url: meta.url, duration: meta.duration };
  }, [cleanFor]);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* 忽略 */ } }
    setSpeakingId(null);
  }, []);

  const prepare = useCallback((id: string, content: string) => {
    if (!enabledRef.current) return;
    if (!cleanFor(content)) return;
    if (readyUrl(id, content)) return;
    void getAudio(id, content)
      .then(blob => registerUrl(id, blob, content))
      .catch(() => { /* 预载失败静默 */ });
  }, [cleanFor, getAudio, readyUrl, registerUrl]);

  const toggle = useCallback((id: string, content: string) => {
    const a = audioRef.current;
    if (speakingId === id && a && !a.paused) {
      stop();
      return;
    }
    if (!cleanFor(content)) return;
    stop();
    setLoadingId(id);
    void getAudio(id, content)
      .then(blob => registerUrl(id, blob, content))
      .then((meta) => {
        if (!audioRef.current) {
          const el = new Audio();
          el.addEventListener('ended', () => setSpeakingId(null));
          el.addEventListener('error', () => setSpeakingId(null));
          audioRef.current = el;
        }
        const el = audioRef.current;
        el.src = meta.url;
        el.currentTime = 0;
        void el.play().then(() => setSpeakingId(id)).catch(() => setSpeakingId(null));
      })
      .catch(() => setSpeakingId(null))
      .finally(() => setLoadingId(cur => (cur === id ? null : cur)));
  }, [cleanFor, getAudio, registerUrl, speakingId, stop]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    saveEnabledLocal(v);
    enabledRef.current = v;
    if (!v) {
      stop();
      setUrlMeta({});
      for (const m of urlRef.current.values()) { try { URL.revokeObjectURL(m.url); } catch { /* 忽略 */ } }
      urlRef.current.clear();
    }
    if (loggedIn) void savePreferences({ roleplayVoiceEnabled: v }).catch(() => { /* 同步失败不影响本地 */ });
  }, [loggedIn, stop]);

  // 登录用户：首次进入时拉云端开关（跨设备同步）
  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    void getPreferences().then((r) => {
      if (!alive || !r?.success || !r.data) return;
      const v = (r.data as { roleplayVoiceEnabled?: boolean }).roleplayVoiceEnabled;
      if (typeof v === 'boolean' && v !== enabledRef.current) {
        setEnabledState(v);
        saveEnabledLocal(v);
        enabledRef.current = v;
      }
    }).catch(() => { /* 忽略 */ });
    return () => { alive = false; };
  }, [loggedIn]);

  // 音色变化（换剧本）→ 停当前播放并回收音频（避免用上一个角色的声音继续念）
  useEffect(() => {
    stop();
    setUrlMeta({});
    for (const m of urlRef.current.values()) { try { URL.revokeObjectURL(m.url); } catch { /* 忽略 */ } }
    urlRef.current.clear();
    cacheRef.current.clear();
    inflightRef.current.clear();
  }, [design, stop]);

  // 卸载：停播 + 回收全部 objectURL
  useEffect(() => () => {
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* 忽略 */ } }
    for (const m of urlRef.current.values()) { try { URL.revokeObjectURL(m.url); } catch { /* 忽略 */ } }
    urlRef.current.clear();
  }, []);

  return { enabled, setEnabled, readyUrl, speakingId, loadingId, prepare, toggle, stop };
}
