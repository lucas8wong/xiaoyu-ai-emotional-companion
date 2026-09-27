/**
 * TTS 朗读代理路由（POST /api/tts）
 * 优先走本地 CosyVoice2 侧车（自然年轻女声，带停顿/语气，比 Edge 更拟人）；
 * 侧车/模型不可用时回退 msedge-tts（微软 Edge 神经音色，免费）。
 * 返回 audio 流（侧车=wav；msedge=mp3）。失败 502，前端静默处理。
 */

import { Router } from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// 默认音色（按界面语言）：中文晓晓（女）/ 繁体曉臻 / 英文 Aria（女）
const VOICES: Record<string, string> = {
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  en: 'en-US-AriaNeural',
};

// 备用音色（男声）：中文云希 / 繁体雲哲 / 英文 Guy
const VOICES_ALT: Record<string, string> = {
  'zh-CN': 'zh-CN-YunxiNeural',
  'zh-TW': 'zh-TW-YunJheNeural',
  en: 'en-US-GuyNeural',
};

const MAX_TEXT = 2000; // 单段最大字符（超出截断，防滥用）
// msedge-tts 的 Edge 端点仅支持库自带的 <prosody>（语速/音高），会拒绝 <break>/express-as。
// 这里只微调 rate/pitch 让声音更缓、更暖（A 档）；要停顿/情感需上面三档更自然的模型。
const TTS_RATE = process.env.TTS_RATE || '-2%';
const TTS_PITCH = process.env.TTS_PITCH || '+2%';
// 侧车为可选项：仅当显式配置 TTS_SIDECAR_URL 才启用（否则/未部署好时直接用 msedge，不干等）。
const SIDECAR_URL = (process.env.TTS_SIDECAR_URL || '').replace(/\/+$/, '');
const SIDECAR_ENABLED = !!SIDECAR_URL;
const SIDECAR_TIMEOUT_MS = 20000; // CosyVoice 首次/长文本稍久
const SIDECAR_RETRY_AFTER_MS = 60000;
// 默认预设音色：CosyVoice2 内置自然中文女声（年轻）；可经 TTS_SIDECAR_SPEAKER 覆盖
const SIDECAR_SPEAKER = process.env.TTS_SIDECAR_SPEAKER || '中文女';
// VoxCPM2 GPU 侧车（更拟人，48kHz，可音色/语气设计）：优先尝试；不可用回退 CosyVoice/msedge
const VOXCPM_URL = (process.env.VOXCPM_URL || '').replace(/\/+$/, '');
const VOXCPM_ENABLED = !!VOXCPM_URL;
const VOXCPM_TIMEOUT_MS = 30000;
const VOXCPM_VOICE = process.env.VOXCPM_VOICE || '(young adult female voice, warm and clear tone, moderate pace)';

const router = Router();

let sidecarDownUntil = 0;

async function tryVoxcpm(text: string, voice?: string, reference?: string): Promise<Buffer | null> {
  if (!VOXCPM_ENABLED) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOXCPM_TIMEOUT_MS);
    try {
      const r = await fetch(`${VOXCPM_URL}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT), voice: voice || '', reference: reference || '' }),
        signal: controller.signal,
      });
      if (r.ok) {
        const j = (await r.json()) as { audioBase64?: string };
        if (j.audioBase64) return Buffer.from(j.audioBase64, 'base64');
      }
      console.warn('[TTS] voxcpm non-ok:', r.status);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[TTS] voxcpm unavailable:', (e as Error)?.message);
  }
  return null;
}

async function trySidecar(text: string, lang: string, speaker = SIDECAR_SPEAKER): Promise<Buffer | null> {
  if (!SIDECAR_ENABLED || Date.now() < sidecarDownUntil) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
    try {
      const r = await fetch(`${SIDECAR_URL}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT), lang, voice_type: 'sft', speaker }),
        signal: controller.signal,
      });
      if (r.ok) {
        const j = (await r.json()) as { audioBase64?: string };
        if (j.audioBase64) return Buffer.from(j.audioBase64, 'base64');
      }
      console.warn('[TTS] sidecar non-ok:', r.status);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[TTS] sidecar unavailable, fallback to msedge:', (e as Error)?.message);
  }
  sidecarDownUntil = Date.now() + SIDECAR_RETRY_AFTER_MS;
  return null;
}

router.post('/tts', async (req, res) => {
  const { text, lang = 'zh-CN', voice, reference } = (req.body || {}) as { text?: string; lang?: string; voice?: string; reference?: string };
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) {
    res.status(400).json({ error: 'text required' });
    return;
  }

  // 1) 优先 VoxCPM2 GPU 侧车（更拟人、48kHz、可音色/语气设计）
  const voxBuf = await tryVoxcpm(content, voice, reference);
  if (voxBuf) {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Engine', 'voxcpm');
    res.setHeader('X-TTS-Voice', voice || VOXCPM_VOICE);
    res.send(voxBuf);
    return;
  }

  // 2) 其次本地 CosyVoice2 侧车（自然拟人）；voice 参数可选（前端音色选择），缺省用预设
  const sidecarBuf = await trySidecar(content, lang, voice || SIDECAR_SPEAKER);
  if (sidecarBuf) {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Engine', 'cosyvoice');
    res.send(sidecarBuf);
    return;
  }

  // 3) 回退 msedge-tts（Edge 神经音色）
  const voiceName = voice || VOICES[lang] || VOICES_ALT[lang] || VOICES.en;
  let tts: MsEdgeTTS | null = null;
  try {
    tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(content.slice(0, MAX_TEXT), { rate: TTS_RATE, pitch: TTS_PITCH });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Voice', voiceName);
    res.setHeader('X-TTS-Engine', 'msedge');
    let ended = false;
    audioStream.on('error', (err) => {
      console.error('[TTS] stream error:', (err as Error)?.message);
      if (!ended && !res.headersSent) {
        res.status(502).json({ error: 'tts failed' });
      } else if (!ended) {
        res.end();
      }
      ended = true;
    });
    audioStream.pipe(res);
    res.on('close', () => {
      ended = true;
      try { audioStream.destroy(); } catch { /* ignore */ }
      try { tts?.close(); } catch { /* ignore */ }
    });
  } catch (err) {
    console.error('[TTS] synth failed:', (err as Error)?.message);
    if (!res.headersSent) res.status(502).json({ error: 'tts unavailable' });
    try { tts?.close(); } catch { /* ignore */ }
  }
});

// 流式合成：把侧车的 /tts/stream SSE 原样转发给前端（渐进播放，首段更快出声）。
router.post('/tts/stream', async (req, res) => {
  const { text, lang = 'zh-CN', voice, reference } = (req.body || {}) as { text?: string; lang?: string; voice?: string; reference?: string };
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) {
    res.status(400).json({ error: 'text required' });
    return;
  }
  if (!VOXCPM_ENABLED) {
    // 无 VoxCPM 侧车：降级为整段 /tts，以单帧 SSE 返回（前端流式解析兼容）
    try {
      const buf = await tryVoxcpm(content, voice, reference) ?? await trySidecar(content, lang, voice || SIDECAR_SPEAKER);
      if (buf) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ pcm: ',' + Buffer.from(buf).toString('base64'), sr: 48000, wav: true })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      }
    } catch (e) { console.warn('[TTS] stream fallback failed:', (e as Error)?.message); }
    res.status(502).json({ error: 'tts unavailable' });
    return;
  }

  try {
    const r = await fetch(`${VOXCPM_URL}/tts/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content.slice(0, MAX_TEXT), voice: voice || VOXCPM_VOICE, reference: reference || '' }),
    });
    if (!r.ok || !r.body) {
      console.warn('[TTS] voxcpm stream non-ok:', r.status);
      res.status(502).json({ error: 'tts unavailable' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    console.warn('[TTS] voxcpm stream error:', (e as Error)?.message);
    if (!res.headersSent) res.status(502).json({ error: 'tts unavailable' });
  }
});

export default router;
