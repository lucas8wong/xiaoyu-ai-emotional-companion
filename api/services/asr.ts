/**
 * 本地语音转文字（ASR，Whisper + transformers.js）
 *
 * 聊一聊「语音输入」此前走浏览器 Web Speech API（Chrome/Edge 底层是 Google 云端），
 * 大陆网络无法访问 Google 服务 → 不可用；Firefox 也一直不支持。
 * 现在改为**服务端自托管 Whisper**（免费、无 API key、大陆/港澳/海外/Firefox 均可用）：
 * 客户端用 MediaRecorder 录音 → 解码成 16kHz 单声道 PCM16 → 上传 /api/asr，
 * 本服务用 @huggingface/transformers 的 automatic-speech-recognition（Whisper）转成文字。
 *
 * 与 api/services/embedding.ts 同一套基建：模型首次加载进缓存目录，之后离线可用；
 * 模型未就绪或失败时由调用方降级（返回 502，前端回退手输/提示），不抛裸错。
 */

import { pipeline, env } from '@huggingface/transformers';

// 支持外部指定模型缓存目录（Docker 里烤进镜像，离线可用）
if (process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

// 多语言 Whisper（含普通话 zh / 繁体 zh / 粤语 yue / 英文 en），可经 ASR_WHISPER_MODEL 覆盖。
// 默认 whisper-large-v3-turbo：多语言、质量最高、速度快；上云 CPU 同质但慢。
const MODEL = process.env.ASR_WHISPER_MODEL || 'onnx-community/whisper-large-v3-turbo';

// GPU 设备选择：**质量由模型决定，GPU/CPU 只影响速度不影响质量** → 本地 GPU 与云 CPU 同质无缝。
// Windows 实测：DirectML(dml) 与 WebGPU 对 Whisper 生成不可靠（会返回空 token/量化报错），故 Windows 默认 CPU；
// Linux x64（云上 GPU 机器）：cuda 可用；其它/未开启：CPU。
function gpuDevice(): string | undefined {
  if (process.env.ASR_USE_GPU !== '1') return undefined;
  if (process.platform === 'linux' && process.arch === 'x64') return 'cuda';
  return undefined;
}

let asrPromise: Promise<any> | null = null;
function loadTranscriber(device?: string): Promise<any> {
  const opts: Record<string, unknown> = { dtype: 'q8' };
  if (device) opts.device = device;
  return pipeline('automatic-speech-recognition', MODEL, opts);
}

function getTranscriber(): Promise<any> {
  if (!asrPromise) {
    const device = gpuDevice();
    asrPromise = loadTranscriber(device)
      .then((t) => { asrReady = true; console.log(`[ASR] model ready: ${MODEL} (${device ?? 'cpu'})`); return t; })
      .catch((e) => {
        if (device) {
          // GPU 加载失败 → 自动回退 CPU（同一模型、同质量，只是慢一点），不阻断服务
          console.warn(`[ASR] ${device} load failed (${(e as Error)?.message}); fallback to CPU`);
          return loadTranscriber(undefined)
            .then((t) => { asrReady = true; console.log(`[ASR] model ready: ${MODEL} (cpu, fallback)`); return t; })
            .catch((e2) => { asrPromise = null; throw e2; });
        }
        asrPromise = null;
        throw e;
      });
  }
  return asrPromise;
}

let asrReady = false;
/** 是否已就绪（模型加载完成）；启动时预热，冷启动时避免每次请求都等待加载 */
export function isAsrReady(): boolean { return asrReady; }

/** 预热：启动时调用（fire-and-forget），首次加载模型并返回是否就绪 */
export async function ensureAsrReady(): Promise<boolean> {
  try {
    // 只验证「模型能加载」，不做推理——whisper-large-v3-turbo 对纯静音/合成音会返回空 token 导致解码报错，
    // 但那不代表模型不可用；真实语音推理由 transcribe 处理。
    await getTranscriber();
    asrReady = true;
    return true;
  } catch {
    asrReady = false;
    return false;
  }
}

/**
 * 把 16kHz 单声道 Float32Array（-1..1 采样）转成文字。
 * @param pcm16k 16kHz 单声道归一化采样
 * @param lang   Whisper 语言码（zh / yue / en）；自动检测时传空串
 */
export async function transcribe(pcm16k: Float32Array, lang: string): Promise<string> {
  const asr = await getTranscriber();
  try {
    const out = await asr(pcm16k, {
      language: lang || undefined,
      task: 'transcribe',
    } as any);
    return (out && typeof out.text === 'string' ? out.text : '').trim();
  } catch (e) {
    // 静音/无词/个别 EP 生成空 token 导致解码报错 → 视为「没听清」返回空，客户端显示「没听清，请再说一次」，
    // 避免 502 刷屏（真实服务故障已在 getTranscriber 层抛出）。
    console.warn('[ASR] transcribe returned no text:', (e as Error)?.message);
    return '';
  }
}

/** 清空缓存/句柄（主要为测试隔离用；生产不调用） */
export function clearAsrCache(): void { asrPromise = null; asrReady = false; }

/** 支持的识别语言码（Whisper）：zh 普通话/繁中、yue 粤语、en 英语 */
const ASR_LANGS = new Set(['zh', 'yue', 'en']);

/** 归一化传入语言码；不合法时回退 zh */
export function normalizeAsrLang(lang: string | undefined): string {
  return lang && ASR_LANGS.has(lang) ? lang : 'zh';
}

/**
 * 把 base64 解码后的 PCM16（little-endian，16kHz 单声道）Buffer 转成 Float32Array(-1..1)。
 * 这是纯函数，便于单测（不用加载 Whisper 模型）。
 */
export function pcm16ToFloat32(buf: Buffer): Float32Array {
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  return f32;
}
