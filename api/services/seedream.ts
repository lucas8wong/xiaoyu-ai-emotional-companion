/**
 * 火山方舟 Doubao-Seedream 图片生成客户端。
 * 调用 POST {base}/images/generations（火山方舟 OpenAI 兼容图片接口）。
 * 支持 base64 直接落盘 或 返回 URL 后下载，均含重试/超时/退避。
 * 环境变量（由调用方注入，不在此处读）：
 *  - VOLCENGINE_API_KEY / VOLCENGINE_ARK_BASE_URL / SEEDREAM_MODEL
 */
import { setTimeout as sleep } from 'timers/promises';

export const DEFAULT_SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** 火山方舟 Seedream 5.0 模型 ID（可用 .env 的 SEEDREAM_MODEL 覆盖）。 */
export const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128';

export interface SeedreamConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** 是否叠加「AI 生成」水印；默认 false（皮肤素材要干净）。 */
  watermark?: boolean;
}

export interface SeedreamImageResult {
  base64?: string;
  url?: string;
  mime?: string;
}

interface SeedreamItem {
  url?: string;
  b64_json?: string;
  base64?: string;
  mime_type?: string;
  mimeType?: string;
}

function pickError(json: any, status: number, bodyText: string): string {
  if (json && typeof json === 'object') {
    const err = json.error;
    if (err) {
      if (typeof err === 'string') return err;
      if (err.message) return String(err.message);
    }
    if (json.message) return String(json.message);
  }
  return `Seedream 请求失败 (HTTP ${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`;
}

function pickImage(json: any): SeedreamItem | null {
  const arr: any[] = json?.data || json?.images || json?.output || [];
  const first = Array.isArray(arr) ? (arr[0] || {}) : json;
  if (!first || typeof first !== 'object') {
    return { url: typeof json?.url === 'string' ? json.url : undefined };
  }
  return first as SeedreamItem;
}

/**
 * 生成一张图。返回 base64 或 url（任一份即可用于落盘）。
 */
export async function generateImage(prompt: string, size: string, cfg: SeedreamConfig): Promise<SeedreamImageResult> {
  if (!cfg.apiKey) throw new Error('缺少火山方舟 API Key（VOLCENGINE_API_KEY）');
  const base = (cfg.baseUrl || DEFAULT_SEEDREAM_BASE_URL).replace(/\/+$/, '');
  const model = cfg.model || DEFAULT_SEEDREAM_MODEL;
  const maxRetries = Math.max(0, cfg.maxRetries ?? 2);
  const timeoutMs = cfg.timeoutMs ?? 120000;
  const endpoint = `${base}/images/generations`;

  const body = {
    model,
    prompt,
    size,
    sequential_image_generation: 'disabled',
    response_format: 'url',
    stream: false,
    watermark: cfg.watermark ?? false,
  };

  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s, 4s…
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const bodyText = await res.text();
      let json: any = null;
      try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* 非 JSON */ }

      if (!res.ok) {
        const err = pickError(json, res.status, bodyText);
        // 429 / 5xx → 可重试；4xx 业务错误 → 直接失败
        const retriable = res.status === 429 || res.status >= 500;
        lastError = err;
        if (!retriable || attempt === maxRetries) throw new Error(`Seedream ${res.status}: ${err}`);
        continue;
      }

      const item = pickImage(json);
      if (!item) throw new Error('Seedream 响应里没有图片数据');
      const result: SeedreamImageResult & { mime?: string } = {
        base64: item.b64_json || item.base64,
        url: item.url,
        mime: item.mime_type || item.mimeType,
      };
      // 若既无 base64 也无 url，则抓取 JSON 顶层/常见的 b64 字段兜底
      if (!result.base64 && !result.url && json) {
        const anyBase64 = json.b64_json || json.base64 || json.image || json.data_url;
        if (typeof anyBase64 === 'string') result.base64 = anyBase64.split(',')[1] || anyBase64;
      }
      if (!result.base64 && !result.url) throw new Error('Seedream 返回了未知结构（无 base64/url）');
      return { base64: result.base64, url: result.url, mime: result.mime };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      // 网络错误/超时 → 可重试；业务错误（如密钥无效、模型未开通）→ 直接抛出
      // 只认 5xx（以及非 HTTP 的网络类错误）；**4xx 不重试**——
    // 此前这里是 /Seedream (4\d\d|5\d\d)/，把上面刚抛出的「Seedream 401」又判成可重试，
    // 与 :102 的 429/5xx 判定自相矛盾（2026-09-29 审查 A4-P3）。
    const isRetriable = /fetch|abort|timeout|network|ECONN|ETIMEDOUT/i.test(msg) || /Seedream 5\d\d/.test(msg);
      if (!isRetriable || attempt === maxRetries) throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || 'Seedream 生成失败');
}

/**
 * 下载一张远程图（Seedream 返回 URL 时使用），返回 Buffer。
 */
export async function downloadImage(url: string, timeoutMs = 60000): Promise<{ buffer: Buffer; mime?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载图片失败 (HTTP ${res.status})`);
    const mime = res.headers.get('content-type') || undefined;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, mime };
  } finally {
    clearTimeout(timer);
  }
}
