/**
 * 云出图适配层（剧情背景图「改成调用 API 生成」）
 *
 * 背景：原实现是本机 GPU 侧车（`scripts/image_server.py` :8004，SDXL）。本机只有一张 16GB 卡，
 * 还要跑 VoxCPM TTS，实测可用显存 3.6↔15.5GB 摆动 → 出图必须"与 TTS 互斥"、并发只有 1–2，
 * 且 SDXL 画不准机构性道具。改用云 API 后：不再抢卡、并发不再是瓶颈、语义遵循度上一个档。
 *
 * 🔴 红线（与 `sceneArt.ts` 同一条，本层继续守）：
 *   本层**只接受** prompt / negative / size / seed 这些**结构化参数**，
 *   **不提供任何"传一段用户文本"的入口**。prompt 必须由调用方用白名单表拼好
 *   （`src/lib/storyScene.ts` 的 `scenePrompt` / `storyScenePrompt` / `ownThemePrompt`）。
 *
 * 支持的后端（用 `SCENE_ART_PROVIDER` 选；不设则按"有没有配 key"自动挑）：
 *   - `wanx`     阿里云百炼 · 通义万相 / Qwen-Image（✅ 支持负向词，国内直连，人民币）
 *   - `seedream` 火山方舟 · 豆包 Seedream（画质/语义最强，❌ 无负向词）
 *   - `cogview`  智谱 BigModel · CogView（便宜，❌ 无负向词）
 *   - `openai`   OpenAI gpt-image-1（需海外通道，❌ 无负向词，尺寸只有 3 种）
 *   - `sidecar`  本机 GPU 侧车（保留为**降级兜底**；不配任何 key 时的默认）
 *
 * ⚠️ 单价与模型 ID 会变：`REF_PRICE_YUAN` 只用于跑批前的 `--dry-run` 估价，
 *    **下单前请以厂商官网定价页为准**（见 `docs/scene-art-cloud-api-plan.md`）。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export type ImageProviderId = 'wanx' | 'seedream' | 'cogview' | 'openai' | 'sidecar';

export interface ImageProviderCaps {
  id: ImageProviderId;
  label: string;
  /** 是否支持 negative_prompt（**不支持时本层自动加"正向守卫词"**顶替） */
  negative: boolean;
  /** 是否接受任意 WxH */
  customSize: boolean;
  /** 异步任务型（提交后轮询） */
  asyncTask: boolean;
  /** 参考单价（元/张，1280×720 一档；**仅用于估价，需按官网核对**） */
  refPriceYuan: number;
  docsUrl: string;
  /** 是否产出 webp（false → 需要本层转码，否则体积从 37KB 涨到 1–3MB） */
  webp: boolean;
}

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderCaps> = {
  wanx: {
    id: 'wanx', label: '阿里云百炼 · 通义万相',
    // ✅ 单价已核对：wan2.2-t2i-flash 0.14 元/张、wan2.2-t2i-plus 0.20 元/张
    //    （中国内地；国际部署 flash 约 0.183 元/张）。免费额度 100 张/模型。
    //    来源：https://help.aliyun.com/zh/model-studio/model-pricing
    negative: true, customSize: true, asyncTask: true, refPriceYuan: 0.14, webp: false,
    docsUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  },
  seedream: {
    id: 'seedream', label: '火山方舟 · 豆包 Seedream',
    negative: false, customSize: true, asyncTask: false, refPriceYuan: 0.2, webp: false,
    docsUrl: 'https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seedream-4-0',
  },
  cogview: {
    id: 'cogview', label: '智谱 BigModel · CogView',
    // ✅ 单价已核对：CogView-4 0.06 元/次（另有 0.03 元/次档）；**CogView-3-Flash 免费**。
    //    来源：https://docs.bigmodel.cn/cn/guide/start/pricing
    negative: false, customSize: true, asyncTask: false, refPriceYuan: 0.06, webp: false,
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-4',
  },
  openai: {
    id: 'openai', label: 'OpenAI · gpt-image-1',
    negative: false, customSize: false, asyncTask: false, refPriceYuan: 0.45, webp: true,
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-image-1',
  },
  sidecar: {
    id: 'sidecar', label: '本机 GPU 侧车（降级兜底）',
    negative: true, customSize: true, asyncTask: false, refPriceYuan: 0, webp: true,
    docsUrl: 'docs/roleplay-immersion-plan.md',
  },
};

/** 各后端认的 key 环境变量（按顺序取第一个非空） */
const KEY_ENVS: Record<ImageProviderId, string[]> = {
  wanx: ['DASHSCOPE_API_KEY', 'SCENE_ART_API_KEY'],
  seedream: ['ARK_API_KEY', 'VOLC_ARK_API_KEY', 'SCENE_ART_API_KEY'],
  cogview: ['ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'SCENE_ART_API_KEY'],
  openai: ['OPENAI_API_KEY', 'SCENE_ART_API_KEY'],
  sidecar: [],
};

const DEFAULT_BASE: Record<ImageProviderId, string> = {
  wanx: 'https://dashscope.aliyuncs.com',
  seedream: 'https://ark.cn-beijing.volces.com',
  cogview: 'https://open.bigmodel.cn',
  openai: 'https://api.openai.com',
  sidecar: 'http://127.0.0.1:8004',
};

const DEFAULT_MODEL: Record<ImageProviderId, string> = {
  wanx: 'wan2.2-t2i-flash',
  seedream: 'doubao-seedream-4-0-250828',
  cogview: 'cogview-4-250304',
  openai: 'gpt-image-1',
  sidecar: 'sdxl',
};

/**
 * ⚠️ **免费额度是按模型分开算的**（2026-09-14 用户从控制台确认）：`wan2.2-t2i-flash` 的 100 张用尽后，
 * `wanx2.0-t2i-turbo`(500) / `wanx-v1`(500) / `wan2.6-image`(50) **各有独立免费池**。
 * 所以 `SCENE_ART_MODEL` 支持**逗号分隔的候选链**：某个模型报"额度用尽"就自动切下一个，
 * 而不是整批中止（不必人工重启）。
 */
function modelList(id: ImageProviderId): string[] {
  const raw = (process.env.SCENE_ART_MODEL || '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [DEFAULT_MODEL[id]];
  return list.length ? list : [DEFAULT_MODEL[id]];
}
let modelIdx = 0;

export function providerModel(id: ImageProviderId): string {
  const list = modelList(id);
  return list[Math.min(modelIdx, list.length - 1)];
}
export function providerModels(id: ImageProviderId): string[] { return modelList(id); }
/** 切到候选链里的下一个模型（额度用尽时用）；没有下一个返回 false */
export function rotateProviderModel(id: ImageProviderId = 'wanx'): boolean {
  if (modelIdx < modelList(id).length - 1) { modelIdx++; return true; }
  return false;
}

/**
 * 已知的老 wanx 模型尺寸白名单 —— ⚠️ **每个模型不一样，不能共用一张表**。
 * 2026-09-14 实测：`wanx2.0-t2i-turbo` 有 `864*1152`，而 `wanx-v1` **没有**（它只有 `768*1152`）——
 * 共用一张表导致自动切到 wanx-v1 后 **104 张连续 400**。
 * 所以：已知的写在这里（省一次试错），**未知的靠 `parseAllowedSizes` 从报错里学**（见 `learnAllowedSizes`）。
 */
export const WANX_LEGACY_SIZES_BY_MODEL: Array<[RegExp, string[]]> = [
  [/^wanx2\.0-t2i-turbo$/i, ['768*768', '576*1024', '1024*576', '1024*1024', '720*1280', '1280*720', '864*1152', '1152*864']],
  [/^wanx-v1$/i, ['1024*1024', '720*1280', '1280*720', '768*1152']],
];
/** 兼容旧引用（wanx2.0-t2i-turbo 那一套） */
export const WANX_LEGACY_SIZES = WANX_LEGACY_SIZES_BY_MODEL[0][1];

/** 从报错学到/试出来的"该模型实际可用的尺寸"（进程内记忆） */
const learnedSize = new Map<string, string>();
export function learnedSizeFor(model: string): string | undefined { return learnedSize.get(model); }
export function learnAllowedSizes(model: string, allowed: string[], width: number, height: number): string {
  const picked = pickClosestSize(allowed, width, height);
  learnedSize.set(model, picked);
  return picked;
}

/** 从后端报错正文里解析"允许的尺寸集合"（实测形态：`The size does not match the allowed size ['a*b', ...]`） */
export function parseAllowedSizes(msg: string): string[] {
  const m = /allowed size\s*\[([^\]]+)\]/i.exec(String(msg || ''));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => /^\d+\*\d+$/.test(s));
}

/** 老 wanx 模型（wanx-v1 / wanx2.0 / wanx2.1）**只接受固定尺寸集合** */
export function isLegacyWanxModel(model: string): boolean {
  return /^wanx(-v1$|2\.[0-9])/i.test(String(model || '').trim());
}
/** 在允许集合里挑**宽高比最接近**的一个（3:4 → wanx2.0 是 864*1152、wanx-v1 是 768*1152） */
export function pickClosestSize(allowed: string[], width: number, height: number): string {
  const target = width / height;
  let best = allowed[0], bestDiff = Infinity;
  for (const s of allowed) {
    const [w, h] = s.split('*').map(Number);
    if (!w || !h) continue;
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

/**
 * 正向守卫词：给**不支持负向词**的后端顶替 `NEGATIVE_PROMPT`。
 * ⚠️ 这是**固定常量**，不是用户文本 —— 红线仍然只有白名单表能进 prompt。
 */
export const POSITIVE_GUARD = 'empty scene without people, no text or lettering, no watermark';

/**
 * 出图默认尺寸 = **竖版 3:4（960×1280）**。
 *
 * ⚠️ 2026-09-14 用户一句「这些图怎么都是横着的，聊天背景是竖着的吧」——**是真 bug，而且旧图一直是错的**。
 *    真机实测（`temp/measure-scene-aspect.mjs`，无头 Chrome 量容器 + object-cover 裁切）：
 *      · 手机 390×844：背景容器 **421×631 = 0.668（竖）** → 16:9 的图**只能看到 37.6%**（裁掉 62%）
 *      · 桌面 1440×900：容器 693×662 = 1.047 → 16:9 可见 58.9%
 *    场景图**唯一**的消费方是 `StorySceneBackdrop`（`absolute inset-0` 满屏 + `object-cover`），
 *    没有别处依赖 16:9，所以换比例是安全的。
 *
 * 为什么选 3:4（而不是 9:16 / 1:1 / 4:5）——按"较差场景也要够看"挑：
 *    | 图比例 | 手机 0.668 | 矮屏手机 0.82 | 桌面 1.047 | 最差 |
 *    | 16:9   | 37.6%     | 50.1%        | 58.9%     | 37.6% |
 *    | 1:1    | 66.8%     | 82%          | 95%       | 66.8% |
 *    | 3:4 ✅ | 89.1%     | 91.5%        | 71.6%     | 71.6% |
 *    | 9:16   | 84.2%     | 68.6%        | 53.7%     | 53.7% |
 *    3:4 在**两种手机屏下都 ≥89%**（主力人群在手机上），桌面也没垮。
 */
export const DEFAULT_SCENE_SIZE = { width: 960, height: 1280 };

function envOf(id: ImageProviderId): string {
  for (const k of KEY_ENVS[id]) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * 决定用哪个后端：显式 `SCENE_ART_PROVIDER` 优先；否则**谁配了 key 用谁**；
 * 都没有 → `sidecar`（保持原行为，不静默改线上链路）。
 */
export function resolveProviderId(explicit = process.env.SCENE_ART_PROVIDER): ImageProviderId {
  const want = String(explicit || '').trim().toLowerCase();
  if (want === 'off' || want === '0') return 'sidecar'; // 'off' 由上层 SCENE_ART_ENABLED 处理
  if (want && want in IMAGE_PROVIDERS) return want as ImageProviderId;
  for (const id of ['wanx', 'seedream', 'cogview', 'openai'] as ImageProviderId[]) {
    if (envOf(id)) return id;
  }
  return 'sidecar';
}

export function providerApiKey(id: ImageProviderId): string {
  return envOf(id);
}

export function providerBaseUrl(id: ImageProviderId): string {
  const k = id === 'sidecar' ? 'SCENE_ART_URL' : 'SCENE_ART_BASE_URL';
  return (process.env[k] || DEFAULT_BASE[id]).replace(/\/+$/, '');
}

/** 该后端当前是否可用（配了 key；sidecar 不需要 key） */
export function providerReady(id: ImageProviderId): boolean {
  return id === 'sidecar' ? true : !!envOf(id);
}

export interface ImageGenRequest {
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
  seed?: number;
  /** gpt-image-1 的 quality 档（low/medium/high），其它后端忽略 */
  quality?: string;
  /** 仅本机侧车用：白名单枚举（世界观/主题），不是用户文本 */
  worldview?: string;
  theme?: string;
}

export interface ImageGenResult {
  ok: boolean;
  /** 图像字节（webp/png/jpeg，看 `ext`） */
  bytes?: Buffer;
  ext?: 'webp' | 'png' | 'jpg';
  seconds?: number;
  seed?: number;
  provider?: ImageProviderId;
  /** 该后端不支持负向词 → 已改用正向守卫词（跑批日志会记） */
  negativeDropped?: boolean;
  /** 后端故障/超时 → 上层降级到共享图库（不打扰用户） */
  degraded?: boolean;
  /** 可重试（限流类；`generateImage` 内部已退避重试过） */
  retryable?: boolean;
  /** 账号级错误（免费额度用尽/余额不足/Key 失效）→ 上层应**立刻中止整批**，重试无意义 */
  fatal?: boolean;
  code?: string;
  message?: string;
}

// ─────────────── 尺寸映射 ───────────────

/** 后端要的尺寸字符串（`wanx` 用 `W*H`，其余用 `WxH`） */
export function sizeString(id: ImageProviderId, width: number, height: number): string {
  const w = Math.max(512, Math.round(width / 8) * 8);
  const h = Math.max(512, Math.round(height / 8) * 8);
  if (!IMAGE_PROVIDERS[id].customSize) {
    // gpt-image-1 只有三档固定尺寸 → 按宽高比取最接近的一档
    const landscape = w / h > 1.15, portrait = h / w > 1.15;
    if (portrait) return '1024x1536';
    return landscape ? '1536x1024' : '1024x1024';
  }
  if (id === 'wanx') {
    const model = providerModel('wanx');
    // ① 已经学到过这个模型可用什么尺寸 → 直接用（省一次 400 试错）
    const learned = learnedSize.get(model);
    if (learned) return learned;
    // ② 已知白名单 → 吸附到宽高比最接近的那个
    const known = WANX_LEGACY_SIZES_BY_MODEL.find(([re]) => re.test(model));
    if (known) return pickClosestSize(known[1], w, h);
    // ③ 新模型（wan2.x）/ 未知模型 → 先按请求尺寸发；若被拒，`generateImage` 会从报错里学会并重试
    return `${w}*${h}`;
  }
  return `${w}x${h}`;
}

/**
 * 拼最终正向 prompt：不支持负向词的后端，把**固定守卫词**前置。
 * （内容打头是 SDXL 时代的讲究；云模型指令遵循强，前置否定指令更稳。）
 */
export function promptFor(id: ImageProviderId, req: ImageGenRequest): { prompt: string; negative?: string; negativeDropped: boolean } {
  const caps = IMAGE_PROVIDERS[id];
  if (caps.negative && req.negative) {
    return { prompt: req.prompt, negative: req.negative, negativeDropped: false };
  }
  return { prompt: POSITIVE_GUARD + ', ' + req.prompt, negative: undefined, negativeDropped: !!req.negative };
}

/** 估价（元）—— 只给 `--dry-run` 用；真实账单以厂商控制台为准 */
export function estimateCostYuan(id: ImageProviderId, count: number): number {
  return Math.round(IMAGE_PROVIDERS[id].refPriceYuan * count * 100) / 100;
}

/**
 * 该后端的**参考单价**（元/张）—— 供成本记账使用（与 estimateCostYuan 同源，避免两处单价漂移）。
 * 注意：这是标价估算，不含厂商免费额度；侧车（本机 GPU）为 0（只有电费）。
 */
export function priceOfProvider(id: ImageProviderId): number {
  return IMAGE_PROVIDERS[id]?.refPriceYuan ?? 0;
}

/**
 * 稳定种子：同一 key（`{剧本}-{幕}`）永远得到同一个 seed → 出图可复现，
 * 抽检不合格时用 `seed + 1` 换一版（与 `generate_scene_art.py` 的 `--seed-offset` 同思路）。
 */
export function stableSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647;
}

// ─────────────── 取图 / 转码 ───────────────

function extFromContentType(ct: string, url = ''): 'webp' | 'png' | 'jpg' {
  const s = (ct || '').toLowerCase();
  if (s.includes('webp')) return 'webp';
  if (s.includes('png')) return 'png';
  if (s.includes('jpeg') || s.includes('jpg')) return 'jpg';
  const u = url.toLowerCase();
  if (u.includes('.webp')) return 'webp';
  if (u.includes('.png')) return 'png';
  return 'jpg';
}

const require_ = createRequire(import.meta.url);

/** 转码器可用性（跑批日志用；`--dry-run` 也会打印，避免"跑完才发现体积没压下来"） */
export function webpTool(): 'sharp' | 'ffmpeg' | 'none' {
  try { require_('sharp'); return 'sharp'; } catch { /* 继续 */ }
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 10000 });
    if (r.status === 0) return 'ffmpeg';
  } catch { /* 继续 */ }
  return 'none';
}

/**
 * 转成 webp —— **必须做**：现有 110 张图库平均 37KB/张，云 API 直出 PNG 是 1–3MB，
 * 用户主要在手机上（港澳/海外）看剧情，不转码 = 带宽与首屏灾难。
 * 优先 `sharp`，退 `ffmpeg`（项目已有用它压图的先例），都没有就原样返回（并如实给出扩展名）。
 */
export async function toWebp(bytes: Buffer, ext: 'webp' | 'png' | 'jpg', quality = 82): Promise<{ bytes: Buffer; ext: 'webp' | 'png' | 'jpg' }> {
  if (ext === 'webp') return { bytes, ext };
  try {
    const sharp = require_('sharp') as (b: Buffer) => { webp: (o: { quality: number }) => { toBuffer: () => Promise<Buffer> } };
    const out = await sharp(bytes).webp({ quality }).toBuffer();
    if (out && out.length > 0) return { bytes: out, ext: 'webp' };
  } catch { /* sharp 不在 → 走 ffmpeg */ }
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-quality', String(quality), '-f', 'webp', 'pipe:1'], {
      input: bytes, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
    });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) return { bytes: r.stdout, ext: 'webp' };
  } catch { /* 没有 ffmpeg */ }
  return { bytes, ext };
}

async function downloadImage(url: string, timeoutMs: number): Promise<{ bytes: Buffer; ext: 'webp' | 'png' | 'jpg' }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('下载出图结果失败 ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return { bytes: buf, ext: extFromContentType(r.headers.get('content-type') || '', url) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON（网关报错页） */ }
    return { status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function pickUrl(json: Record<string, unknown>): string {
  const data = (json.data as Array<{ url?: string; b64_json?: string }> | undefined) || [];
  if (data[0]?.url) return data[0].url;
  const output = json.output as { results?: Array<{ url?: string }> } | undefined;
  if (output?.results?.[0]?.url) return output.results[0].url;
  return '';
}

function pickB64(json: Record<string, unknown>): string {
  const data = (json.data as Array<{ b64_json?: string }> | undefined) || [];
  return data[0]?.b64_json || '';
}

const errText = (t: string) => t.replace(/\s+/g, ' ').slice(0, 200);

/**
 * 把后端错误分类成"能重试 / 必须中止 / 直接降级"。
 *
 * ⚠️ 2026-09-14 实测教训（一次跑批 561 张全废）：
 *   · **429 `Throttling.RateQuota`**（限流）必须**退避重试**——低配额档 QPS 很低，一次并发就撞，直接判失败会成片丢图；
 *   · **403 `AllocationQuota.FreeTierOnly` / 余额不足 / Key 失效** 是**账号级**错误：重试一万次也一样，
 *     必须**立刻中止整批**并让人去控制台处理，而不是把 590 张各撞一次（既浪费时间，也把日志淹掉）。
 */
const RATE_RE = /Throttling|RateQuota|rate limit|too many requests|429/i;
const FATAL_RE = /AllocationQuota|FreeTierOnly|Arrearage|InsufficientBalance|余额不足|欠费|free quota exhausted/i;
const AUTH_RE = /InvalidApiKey|invalid_api_key|Authentication|Unauthorized|api key/i;

export interface ApiErrorClass { code: 'RATE_LIMIT' | 'QUOTA' | 'AUTH' | 'API_ERROR'; retryable: boolean; fatal: boolean }

export function classifyApiError(status: number, body: string): ApiErrorClass {
  const s = `${body}`;
  if (status === 401 || (status === 403 && AUTH_RE.test(s) && !FATAL_RE.test(s))) return { code: 'AUTH', retryable: false, fatal: true };
  if (status === 403 || FATAL_RE.test(s)) return { code: 'QUOTA', retryable: false, fatal: true };
  if (status === 429 || RATE_RE.test(s)) return { code: 'RATE_LIMIT', retryable: true, fatal: false };
  if (status >= 500) return { code: 'API_ERROR', retryable: true, fatal: false };
  return { code: 'API_ERROR', retryable: false, fatal: false };
}

/** 构造一个带分类信息的错误（上层据此决定"重试 / 中止 / 降级"） */
function apiFail(status: number, text: string, label: string): Error {
  const c = classifyApiError(status, text);
  return Object.assign(new Error(`${label} ${status} ${errText(text)}`), { degraded: !c.fatal, ...c });
}

// ─────────────── 各后端实现 ───────────────

interface BackendResult { bytes: Buffer; ext: 'webp' | 'png' | 'jpg'; seed?: number }

/**
 * 阿里云百炼（DashScope）：**异步任务**型 —— 提交拿 task_id，再轮询到 SUCCEEDED。
 * 支持 `negative_prompt`（现有 `SCENE_NEGATIVE_PROMPT` 表可原样复用，红线靠负向词压制）。
 */
async function genWanx(req: ImageGenRequest, timeoutMs: number): Promise<BackendResult> {
  const base = providerBaseUrl('wanx');
  const p = promptFor('wanx', req);
  const submit = await postJson(
    `${base}/api/v1/services/aigc/text2image/image-synthesis`,
    {
      model: providerModel('wanx'),
      input: { prompt: p.prompt, ...(p.negative ? { negative_prompt: p.negative } : {}) },
      parameters: {
        size: sizeString('wanx', req.width || DEFAULT_SCENE_SIZE.width, req.height || DEFAULT_SCENE_SIZE.height),
        n: 1,
        prompt_extend: false, // 关掉扩写：prompt 必须完全来自白名单表
        ...(req.seed != null ? { seed: req.seed } : {}),
      },
    },
    { Authorization: 'Bearer ' + providerApiKey('wanx'), 'X-DashScope-Async': 'enable' },
    Math.min(timeoutMs, 30000),
  );
  if (submit.status >= 400) throw apiFail(submit.status, submit.text, '百炼提交失败');
  const taskId = String((submit.json.output as { task_id?: string } | undefined)?.task_id || '');
  if (!taskId) throw Object.assign(new Error('百炼未返回 task_id：' + errText(submit.text)), { degraded: true });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let poll: Record<string, unknown>;
    try {
      const r = await fetch(`${base}/api/v1/tasks/${taskId}`, { headers: { Authorization: 'Bearer ' + providerApiKey('wanx') }, signal: ac.signal });
      poll = JSON.parse(await r.text()) as Record<string, unknown>;
    } finally { clearTimeout(timer); }
    const out = poll.output as { task_status?: string; message?: string } | undefined;
    const status = String(out?.task_status || '');
    if (status === 'SUCCEEDED') {
      const url = pickUrl(poll);
      if (!url) throw Object.assign(new Error('百炼成功但没给图 URL'), { degraded: true });
      const dl = await downloadImage(url, 30000);
      return { ...dl, seed: req.seed };
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const msg = String(out?.message || '');
      // 尺寸被拒时把"允许的集合"带出来 → generateImage 会学会它并用正确尺寸重试（见 parseAllowedSizes）
      throw Object.assign(new Error('百炼任务 ' + status + '：' + msg), { degraded: true, allowedSizes: parseAllowedSizes(msg) });
    }
  }
  throw Object.assign(new Error('百炼出图超时'), { degraded: true });
}

/** 火山方舟（Ark）· Seedream：同步返回 URL。**无 negative_prompt**（靠正向守卫词）。 */
async function genSeedream(req: ImageGenRequest, timeoutMs: number): Promise<BackendResult> {
  const p = promptFor('seedream', req);
  const r = await postJson(
    `${providerBaseUrl('seedream')}/api/v3/images/generations`,
    {
      model: providerModel('seedream'),
      prompt: p.prompt,
      size: sizeString('seedream', req.width || DEFAULT_SCENE_SIZE.width, req.height || DEFAULT_SCENE_SIZE.height),
      response_format: 'url',
      watermark: false,
      sequential_image_generation: 'disabled',
      ...(req.seed != null ? { seed: req.seed } : {}),
    },
    { Authorization: 'Bearer ' + providerApiKey('seedream') },
    timeoutMs,
  );
  if (r.status >= 400) throw apiFail(r.status, r.text, 'Seedream');
  const url = pickUrl(r.json);
  if (!url) throw Object.assign(new Error('Seedream 未返回图 URL'), { degraded: true });
  const dl = await downloadImage(url, 30000);
  return { ...dl, seed: req.seed };
}

/** 智谱 CogView：同步返回 URL。**无 negative_prompt**。 */
async function genCogview(req: ImageGenRequest, timeoutMs: number): Promise<BackendResult> {
  const p = promptFor('cogview', req);
  const r = await postJson(
    `${providerBaseUrl('cogview')}/api/paas/v4/images/generations`,
    {
      model: providerModel('cogview'),
      prompt: p.prompt,
      size: sizeString('cogview', req.width || DEFAULT_SCENE_SIZE.width, req.height || DEFAULT_SCENE_SIZE.height),
    },
    { Authorization: 'Bearer ' + providerApiKey('cogview') },
    timeoutMs,
  );
  if (r.status >= 400) throw apiFail(r.status, r.text, 'CogView');
  const url = pickUrl(r.json);
  if (!url) throw Object.assign(new Error('CogView 未返回图 URL'), { degraded: true });
  const dl = await downloadImage(url, 30000);
  return { ...dl, seed: req.seed };
}

/** OpenAI gpt-image-1：返回 b64_json（不是 URL）。**无 negative_prompt**、尺寸只有 3 档。 */
async function genOpenai(req: ImageGenRequest, timeoutMs: number): Promise<BackendResult> {
  const p = promptFor('openai', req);
  const r = await postJson(
    `${providerBaseUrl('openai')}/v1/images/generations`,
    {
      model: providerModel('openai'),
      prompt: p.prompt,
      size: sizeString('openai', req.width || DEFAULT_SCENE_SIZE.width, req.height || DEFAULT_SCENE_SIZE.height),
      quality: req.quality || process.env.SCENE_ART_OPENAI_QUALITY || 'medium',
      output_format: 'webp',
      n: 1,
    },
    { Authorization: 'Bearer ' + providerApiKey('openai') },
    timeoutMs,
  );
  if (r.status >= 400) throw apiFail(r.status, r.text, 'gpt-image-1');
  const b64 = pickB64(r.json);
  if (!b64) throw Object.assign(new Error('gpt-image-1 未返回图像数据'), { degraded: true });
  return { bytes: Buffer.from(b64, 'base64'), ext: 'webp' };
}

/** 本机 GPU 侧车（降级兜底）：只收白名单枚举，返回 webpBase64 */
async function genSidecar(req: ImageGenRequest, timeoutMs: number): Promise<BackendResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${providerBaseUrl('sidecar')}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worldview: req.worldview || '',
        theme: req.theme || '',
        prompt: req.prompt,
        width: req.width, height: req.height, seed: req.seed,
      }),
      signal: ac.signal,
    });
    if (!r.ok) throw Object.assign(new Error('侧车返回 ' + r.status), { degraded: r.status === 503 });
    const payload = (await r.json()) as { webpBase64?: string };
    if (!payload?.webpBase64) throw new Error('侧车未返回图像');
    return { bytes: Buffer.from(payload.webpBase64, 'base64'), ext: 'webp', seed: req.seed };
  } finally { clearTimeout(timer); }
}

/**
 * 统一入口：调所选后端出图，**失败一律返回 `ok:false` + `degraded:true`**（不抛），
 * 让上层安静地降级到共享图库 —— 出图永远不该阻塞剧情。
 *
 * 限流（429）内部**退避重试**（低配额档 QPS 很低，实测并发 3 就会成片 429）；
 * 账号级错误（403 免费额度用尽 / 余额不足 / Key 失效）返回 `fatal:true` —— 上层应**立刻中止整批**，
 * 重试没有任何意义（2026-09-14 实测：590 张各撞一次，561 张全废）。
 */
export async function generateImage(
  req: ImageGenRequest,
  opts: { provider?: ImageProviderId; timeoutMs?: number; convertWebp?: boolean; maxRateRetries?: number } = {},
): Promise<ImageGenResult> {
  const id = opts.provider || resolveProviderId();
  const caps = IMAGE_PROVIDERS[id];
  const timeoutMs = opts.timeoutMs || Number(process.env.SCENE_ART_API_TIMEOUT_MS || 120000);
  const maxRateRetries = opts.maxRateRetries ?? Number(process.env.SCENE_ART_RATE_RETRIES || 4);
  if (!providerReady(id)) {
    return { ok: false, degraded: true, code: 'NO_API_KEY', provider: id, message: `${caps.label} 未配置 API Key（见 KEY_ENVS）` };
  }
  const started = Date.now();
  let out: BackendResult | null = null;
  let lastErr: Error | null = null;
  let sizeLearned = false;
  for (let attempt = 0; attempt <= maxRateRetries; attempt++) {
    try {
      if (id === 'wanx') out = await genWanx(req, timeoutMs);
      else if (id === 'seedream') out = await genSeedream(req, timeoutMs);
      else if (id === 'cogview') out = await genCogview(req, timeoutMs);
      else if (id === 'openai') out = await genOpenai(req, timeoutMs);
      else out = await genSidecar(req, timeoutMs);
      break;
    } catch (e) {
      const err = e as Error & { degraded?: boolean; code?: string; retryable?: boolean; fatal?: boolean; allowedSizes?: string[] };
      lastErr = err;
      // ① 后端说"这个尺寸不允许" → **从报错里学会该模型的可用尺寸**，用正确的尺寸重试（只学一次）
      const allowed = err?.allowedSizes;
      if (allowed && allowed.length && !sizeLearned) {
        sizeLearned = true;
        learnAllowedSizes(providerModel(id), allowed, req.width || DEFAULT_SCENE_SIZE.width, req.height || DEFAULT_SCENE_SIZE.height);
        attempt--; // 同一张、同一轮，用刚学到的尺寸重来
        continue;
      }
      // ② 限流 → 指数退避重试（4s / 10s / 25s / 45s）
      if (err?.retryable && attempt < maxRateRetries) {
        const wait = [4000, 10000, 25000, 45000][attempt] ?? 45000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      return {
        ok: false, degraded: err?.degraded !== false, fatal: !!err?.fatal, retryable: !!err?.retryable,
        provider: id,
        code: aborted ? 'TIMEOUT' : err?.code || (id === 'sidecar' ? 'SIDECAR_DOWN' : 'API_ERROR'),
        message: (aborted ? '出图超时：' : '') + (err?.message || String(e)),
      };
    }
  }
  if (!out) {
    const err = lastErr as (Error & { code?: string; fatal?: boolean; retryable?: boolean }) | null;
    return {
      ok: false, degraded: !err?.fatal, fatal: !!err?.fatal, retryable: !!err?.retryable, provider: id,
      code: err?.code || 'RATE_LIMIT', message: '限流重试仍失败：' + (err?.message || ''),
    };
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const wantWebp = opts.convertWebp !== false;
  const encoded = wantWebp ? await toWebp(out.bytes, out.ext) : { bytes: out.bytes, ext: out.ext };
  return {
    ok: true, bytes: encoded.bytes, ext: encoded.ext, seconds,
    seed: out.seed, provider: id, negativeDropped: promptFor(id, req).negativeDropped,
  };
}
