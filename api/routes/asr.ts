/**
 * ASR 语音转文字代理路由（POST /api/asr）
 *
 * 客户端用 MediaRecorder 录音后用 Web Audio 解码并重采样为 16kHz 单声道 PCM16，以 base64 上传。
 * 这里**优先转发给 faster-whisper 侧车**（`ASR_SIDECAR_URL`，本地 CPU 亚秒级）；
 * 侧车不可用时**回退到 transformers.js Whisper**（api/services/asr.ts），保证不中断。
 * 免费、无 API key、大陆/港澳/海外均可用；失败返回 502，前端回退手输/提示。
 */

import { Router } from 'express';
import { transcribe, normalizeAsrLang, pcm16ToFloat32 } from '../services/asr.js';

const MAX_BYTES = 3 * 1024 * 1024; // 16kHz mono PCM16 约 93s，够用；超出拒绝防滥用
const SIDECAR_URL = (process.env.ASR_SIDECAR_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
const SIDECAR_TIMEOUT_MS = 6000; // 侧车单次请求超时：避免侧车挂了导致每个请求都干等
const SIDECAR_RETRY_AFTER_MS = 60000; // 侧车失败后 60s 内不再探测（避免每请求都等超时）

const router = Router();

// 侧车健康闸：上次失败时间戳（0 = 从未失败/可用），用于在侧车宕机时快速回退
let sidecarDownUntil = 0;

async function trySidecar(language: string, audioBase64: string): Promise<string | null> {
  if (Date.now() < sidecarDownUntil) return null; // 侧车近期不可用：直接走 transformers.js
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
    try {
      const r = await fetch(`${SIDECAR_URL}/asr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: language, audioBase64 }),
        signal: controller.signal,
      });
      if (r.ok) {
        const j = (await r.json()) as { text?: string };
        return j.text || '';
      }
      console.warn('[ASR] sidecar non-ok status:', r.status);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[ASR] sidecar unavailable, will fallback:', (e as Error)?.message);
  }
  sidecarDownUntil = Date.now() + SIDECAR_RETRY_AFTER_MS;
  return null;
}

router.post('/asr', async (req, res) => {
  const { lang, audioBase64 } = (req.body || {}) as { lang?: string; audioBase64?: string };
  const language = normalizeAsrLang(lang);

  if (typeof audioBase64 !== 'string' || !audioBase64) {
    res.status(400).json({ success: false, error: 'audio required' });
    return;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(audioBase64, 'base64');
  } catch {
    res.status(400).json({ success: false, error: 'invalid audio' });
    return;
  }
  if (buf.length < 2) {
    res.status(400).json({ success: false, error: 'no audio' });
    return;
  }
  if (buf.length > MAX_BYTES) {
    res.status(400).json({ success: false, error: 'audio too long' });
    return;
  }

  // 1) 优先 faster-whisper 侧车（亚秒级）
  const sidecarText = await trySidecar(language, audioBase64);
  if (sidecarText !== null) {
    res.json({ success: true, data: { text: sidecarText } });
    return;
  }

  // 2) 回退 transformers.js Whisper
  try {
    const f32 = pcm16ToFloat32(buf);
    const text = await transcribe(f32, language);
    res.json({ success: true, data: { text } });
  } catch (err) {
    console.error('[ASR] transcribe failed:', (err as Error)?.message);
    if (!res.headersSent) res.status(502).json({ success: false, error: 'asr unavailable' });
  }
});

export default router;
