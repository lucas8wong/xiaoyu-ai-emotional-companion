/**
 * 语音输入（ASR 转文字）前端封装 — 聊一聊「语音输入」服务端 Whisper 路线。
 *
 * 此前走浏览器 Web Speech API（SpeechRecognition），Chrome/Edge 底层是 Google 云端，
 * 大陆网络访问不了 Google → 不可用；Firefox 也一直不支持。
 * 现在改为「浏览器录音 + 上传服务端 Whisper 转文字」：
 *   - 用 MediaRecorder 录一小段音频；
 *   - 用 Web Audio（decodeAudioData + OfflineAudioContext）解码并重采样为 16kHz 单声道；
 *   - 编码成 PCM16 base64 上传 /api/asr，由服务端 Whisper 转成文字回填输入框。
 * 免费、无 API key、大陆/港澳/海外/Firefox 均可；不再依赖浏览器厂商的云端识别。
 */

export type SpeechLangKey = 'auto' | 'zh-CN' | 'zh-HK' | 'en-US';

/** 当前浏览器是否支持 MediaRecorder（Chrome/Edge/Firefox/Safari 14+ 均支持）。 */
export function isMediaRecorderSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.MediaRecorder !== 'undefined';
}

/**
 * 把用户选择的识别语言解析成 Whisper 语言码。
 * - 'auto'：跟随界面语言（en→en、其余 zh）
 * - 显式 zh-CN（普通话）/ zh-HK（粤语）/ en-US（英语）直接映射
 */
export function resolveSpeechLang(key: SpeechLangKey, uiLang: string): string {
  if (key === 'zh-CN') return 'zh';
  if (key === 'zh-HK') return 'yue';   // Whisper 的粤语语言码
  if (key === 'en-US') return 'en';
  return uiLang === 'en' ? 'en' : 'zh';
}

/** 挑选一个浏览器支持的 MediaRecorder MIME 类型（Chrome webm/opus、Firefox ogg、Safari mp4）。 */
export function pickMediaMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * 把 MediaRecorder 产出的 Blob 解码 → 重采样为 16kHz 单声道 → 编码成 PCM16 base64。
 * 这样服务端无需依赖 ffmpeg，直接拿到归一化采样喂给 Whisper。
 */
export async function encodeAudioToPcm16Base64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext || w.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext unavailable');
  const ctx = new Ctor();
  let audioBuf: AudioBuffer;
  try {
    audioBuf = await ctx.decodeAudioData(arrayBuf);
  } finally {
    try { await ctx.close(); } catch { /* 忽略 */ }
  }

  const targetRate = 16000;
  const outLen = Math.max(1, Math.ceil(audioBuf.duration * targetRate));
  const offline = new OfflineAudioContext(1, outLen, targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const ch = rendered.getChannelData(0);

  // Float32(-1..1) → Int16 PCM (little-endian)
  const int16 = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** 把录音 Blob 转成 data URL（用于微信式语音气泡的点播；区别于交给 ASR 的 16kHz PCM）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('read blob failed'));
    fr.readAsDataURL(blob);
  });
}

/** 计算 Uint8Array 时域采样（中心 128）的 RMS 偏差；用于录音中的「说话/静音」判定。 */
export function computeRms(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - 128;
    sum += d * d;
  }
  return Math.sqrt(sum / data.length);
}

export interface SilenceDetector {
  stop: () => void;
}

export interface SilenceDetectorOptions {
  /** 连续静音多少毫秒视为「说完」 */
  silenceMs?: number;
  /** 至少要听到多久语音（避免还没开口就误停） */
  minSpeechMs?: number;
  /** 最长录音时长兜底 */
  maxMs?: number;
  /** 采样间隔 */
  intervalMs?: number;
}

/**
 * 基于 RMS 能量的静音检测：监听麦克风流，检测到「已说至少 minSpeechMs，随后静音 silenceMs」时
 * 回调 onSpeechEnd（由调用方停止录音并转写）。无外部模型、无下载，iOS Safari 也兼容。
 * 返回 { stop } 用于手动停止/卸载时清理。
 */
export function createSilenceDetector(
  stream: MediaStream,
  onSpeechEnd: () => void,
  opts: SilenceDetectorOptions = {},
): SilenceDetector {
  const { silenceMs = 1200, minSpeechMs = 600, maxMs = 60000, intervalMs = 150 } = opts;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext || w.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext unavailable');
  const ctx = new Ctor();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);
  const startedAt = Date.now();
  let peak = 0;
  let speechMs = 0;
  let lastSpeechAt = startedAt;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    try { void ctx.close(); } catch { /* 忽略 */ }
    onSpeechEnd();
  };

  const tick = () => {
    if (ended) return;
    analyser.getByteTimeDomainData(buf);
    const rms = computeRms(buf);
    // 自适应阈值：一旦听到过声音，按峰值比例判静音（不同麦克风音量都能适应）
    if (rms > 6) peak = Math.max(peak, rms);
    const isSilence = peak > 0 && rms < Math.max(peak * 0.2, 5);
    if (!isSilence) {
      speechMs += intervalMs;
      lastSpeechAt = Date.now();
    }
    const dur = Date.now() - startedAt;
    if (dur >= maxMs) { finish(); return; }
    if (speechMs >= minSpeechMs && (Date.now() - lastSpeechAt) >= silenceMs) { finish(); return; }
  };

  const timer = setInterval(tick, intervalMs);

  return {
    stop: () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      try { void ctx.close(); } catch { /* 忽略 */ }
    },
  };
}
