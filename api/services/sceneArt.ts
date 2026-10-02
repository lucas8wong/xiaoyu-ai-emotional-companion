/**
 * 剧情「按需出图」服务（docs/roleplay-immersion-plan.md §4.5 = S5）
 *
 * 用途：给某个剧本按当前「主题」生成一张**该剧本专属**的场景图（共享主题池之外的那一层），
 * 落盘缓存后长期复用 —— 只承受"首次生成"，之后都是静态资源。
 *
 * 出图后端：**云 API**（见 `imageApi.ts`：通义万相 / 豆包 Seedream / CogView / gpt-image-1），
 * 本机 GPU 侧车降级为兜底。换成云 API 的原因：本机只有一张 16GB 卡还要跑 VoxCPM TTS
 * （实测可用显存 3.6↔15.5GB 摆动、并发只有 1–2），且 SDXL 画不准机构性道具。
 *
 * ⚠️ 缓存是**全局**的（`{剧本}-{幕}`，**不带 userId**）→ 一张图任何用户生成过一次就全站复用。
 *    所以云 API 的花费有硬上界：内置剧本数 × 主题数（当前 30×16 = 480 张），之后全是缓存命中。
 *
 * 🔴 红线（方案 §4.4，必须守住）：
 * 1. **prompt 只能由白名单表拼出**（worldview + theme → `scenePrompt`），
 *    **任何用户文本都不进 prompt**：不接自由 prompt、不用剧本标题/简介、不用用户自定义标签
 *    （`worldviewOf` 只认白名单里的标签，未命中即回退现代都市）。
 * 2. 只支持**内置剧本**（自建剧本走共享主题池，不参与按需出图）——避免"用户内容 → 图像模型"的通道。
 * 3. 出图**不阻塞剧情**：云 API/侧车不可用、超时、欠费 → 返回 degraded，前端继续用共享图库。
 *
 * 单卡保护（保留）：每用户每日上限（默认 Pro20/Plus6/Free2，`SCENE_ART_DAILY_CAP_*` 可调）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_THEMES, scenePrompt, worldviewOf, isKeyMomentTheme, SCENE_NEGATIVE_PROMPT } from '../../src/lib/storyScene.js';
import { getScenarioInfo } from './roleplay.js';
import { quotaStore } from './quota.js';
import { preferenceStore } from './preferences.js';
import {
  generateImage, resolveProviderId, providerReady, IMAGE_PROVIDERS,
  DEFAULT_SCENE_SIZE, stableSeed, priceOfProvider, type ImageProviderId,
} from './imageApi.js';
import { usageStore } from './usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', '..', 'public', 'scene-art');

const SCENE_ART_ENABLED = process.env.SCENE_ART_ENABLED !== '0';
/**
 * 出图超时：云 API 走异步任务（百炼要轮询）→ 默认给到 120s；
 * 侧车时代是 45s（本机 1–6s 就能出），沿用旧 env 时取两者较大值。
 */
const TIMEOUT_MS = Number(process.env.SCENE_ART_API_TIMEOUT_MS || process.env.SCENE_ART_TIMEOUT_MS || 120000);
/**
 * 出图尺寸：**竖版 3:4**（默认 960×1280）。
 * ⚠️ 2026-09-14 修正：原为 16:9，但真机实景容器是竖的（手机 421×631 = 0.668），
 *    `object-cover` 会把 16:9 裁掉 **62%**。尺寸口径的唯一真源在 `imageApi.DEFAULT_SCENE_SIZE`。
 */
const SIZE = {
  width: Number(process.env.SCENE_ART_WIDTH || DEFAULT_SCENE_SIZE.width),
  height: Number(process.env.SCENE_ART_HEIGHT || DEFAULT_SCENE_SIZE.height),
};

/**
 * 会员分档的每日上限（成本保护 + 会员权益）。
 * ⚠️ 口径变化（2026 云化）：侧车时代边际成本是电费，现在是**真金白银**（约 ¥0.1–0.2/张）。
 *    但**仍然故意不扣聊天额度**：① 缓存是全局的，同一幕全站只花一次钱，
 *    总花费有硬上界（剧本数 × 主题数）；② 单张几分钱，用额度去卡反而伤"会员更多"的表达。
 *    真要收紧，调下面的分档上限即可，不要动聊天额度。
 */
export const CAP_BY_PLAN: Record<'free' | 'plus' | 'pro', number> = {
  pro: Number(process.env.SCENE_ART_DAILY_CAP_PRO || 20),
  plus: Number(process.env.SCENE_ART_DAILY_CAP_PLUS || 6),
  free: Number(process.env.SCENE_ART_DAILY_CAP_FREE || 2),
};
/** 自动出图的冷却：同一用户两次自动出图的最小间隔（护单卡） */
export const AUTO_COOLDOWN_MS = Number(process.env.SCENE_ART_AUTO_COOLDOWN_MS || 90000);

export function sceneArtCapForPlan(plan: string): number {
  if (plan === 'pro') return CAP_BY_PLAN.pro;
  if (plan === 'plus') return CAP_BY_PLAN.plus;
  return CAP_BY_PLAN.free;
}

/** 取用户会员档（复用 quota 的既有口径：lifetime 在 getPlan 里按 pro 返回） */
export function sceneArtPlanOf(userId: string): 'free' | 'plus' | 'pro' {
  try {
    const plan = quotaStore.getQuota(userId)?.plan;
    return plan === 'pro' ? 'pro' : plan === 'plus' ? 'plus' : 'free';
  } catch {
    return 'free';
  }
}

export interface AutoDecision { ok: boolean; code?: string; message?: string }

/**
 * 「关键时刻自动出图」是否放行（纯函数，便于单测）。
 * 四道闸门：会员档（仅 Pro）→ 用户开关 → 是否关键时刻 → 冷却。
 */
export function autoSceneArtAllowed(input: {
  plan: string;
  prefEnabled: boolean;
  theme: string;
  lastAutoAt?: number;
  now?: number;
}): AutoDecision {
  if (input.plan !== 'pro') {
    return { ok: false, code: 'AUTO_PRO_ONLY', message: '关键时刻自动画面是 Pro 权益' };
  }
  if (!input.prefEnabled) {
    return { ok: false, code: 'AUTO_OFF', message: '未开启关键时刻自动画面' };
  }
  if (!isKeyMomentTheme(input.theme)) {
    return { ok: false, code: 'NOT_KEY_MOMENT', message: '这一幕不是关键时刻' };
  }
  const now = input.now ?? Date.now();
  if (input.lastAutoAt && now - input.lastAutoAt < AUTO_COOLDOWN_MS) {
    return { ok: false, code: 'AUTO_COOLDOWN', message: '自动画面太频繁，稍后再来' };
  }
  return { ok: true };
}

function autoPrefEnabled(userId: string): boolean {
  try {
    return preferenceStore.get(userId)?.roleplayAutoSceneArt === true;
  } catch {
    return false;
  }
}

const THEME_IDS = new Set(SCENE_THEMES.map(t => t.id));

export type SceneArtValidation =
  | { ok: true; scenarioId: string; theme: string; worldview: string; prompt: string; title: string }
  | { ok: false; code: 'INVALID' | 'NOT_FOUND' | 'UNSUPPORTED_THEME'; message: string };

/**
 * 纯函数校验 + prompt 组装（可单测；**单测里专门断言用户文本进不了 prompt**）
 */
export function validateSceneArtRequest(input: { scenarioId?: unknown; theme?: unknown }): SceneArtValidation {
  const scenarioId = String(input?.scenarioId ?? '').trim();
  const theme = String(input?.theme ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scenarioId)) {
    return { ok: false, code: 'INVALID', message: '剧本ID不合法' };
  }
  if (!THEME_IDS.has(theme)) {
    return { ok: false, code: 'UNSUPPORTED_THEME', message: '主题不在白名单内' };
  }
  const info = getScenarioInfo(scenarioId, 'zh') as { tags?: string[]; title?: string } | null;
  if (!info) {
    return { ok: false, code: 'NOT_FOUND', message: '只支持内置剧本（自建剧本请用共享场景图库）' };
  }
  const worldview = worldviewOf({ tags: Array.isArray(info.tags) ? info.tags : [] });
  return {
    ok: true,
    scenarioId,
    theme,
    worldview,
    prompt: scenePrompt(worldview, theme), // ← 只可能来自白名单表
    title: String(info.title || scenarioId),
  };
}

// —— 每用户每日上限（进程内；重启即清零。上限本身不是安全边界，只是单卡保护）——
const usage = new Map<string, { day: string; count: number }>();
/** 正在出图的预留名额（2026-09-29 审查 A4-P2）：与 usage 一起构成「used + inflight >= cap」 */
const inFlight = new Map<string, number>();
const lastAutoAt = new Map<string, number>();
const today = () => new Date().toISOString().slice(0, 10);

export function sceneArtQuota(userId: string): { used: number; cap: number; remain: number; plan: 'free' | 'plus' | 'pro' } {
  const plan = sceneArtPlanOf(userId);
  const cap = sceneArtCapForPlan(plan);
  const rec = usage.get(userId);
  const d = today();
  const used = rec && rec.day === d ? rec.count : 0;
  return { used, cap, remain: Math.max(0, cap - used), plan };
}

function bumpUsage(userId: string): void {
  const d = today();
  const rec = usage.get(userId);
  if (!rec || rec.day !== d) usage.set(userId, { day: d, count: 1 });
  else rec.count += 1;
}

export interface SceneArtResult {
  ok: boolean;
  url?: string;
  cached?: boolean;
  seconds?: number;
  used?: number;
  cap?: number;
  plan?: 'free' | 'plus' | 'pro';
  degraded?: boolean;
  code?: string;
  message?: string;
}

/**
 * 缓存文件名带**真实扩展名**：云 API 直出 PNG/JPEG，转码器（sharp/ffmpeg）可用时统一落 webp，
 * 不可用时如实落 `png`/`jpg` —— 不假装是 webp（否则 Express 会按 webp 发 content-type 而图是 PNG）。
 */
const CACHE_EXTS = ['webp', 'png', 'jpg'] as const;
type CacheExt = (typeof CACHE_EXTS)[number];

function cacheFile(scenarioId: string, theme: string, ext: CacheExt = 'webp'): string {
  return path.join(OUT_DIR, `${scenarioId}-${theme}.${ext}`);
}

function cacheUrl(scenarioId: string, theme: string, ext: CacheExt): string {
  return `/scene-art/${scenarioId}-${theme}.${ext}`;
}

/**
 * 已生成的直接返回（0 算力、0 等待）。
 * ⚠️ 必须带**版本参数**：这批图是 Express 静态服务、头是 `max-age=604800`（7 天），
 * 文件名不变 → 不给版本号的话，重新出图后浏览器/CDN 会继续用旧图（用户实测踩到过）。
 * 这里用**文件 mtime** 自动版本化，出图即失效。
 */
function fileVersion(f: string): string {
  try { return String(Math.floor(fs.statSync(f).mtimeMs)); } catch { return '0'; }
}

export function findCachedSceneArt(scenarioId: string, theme: string): string | null {
  for (const ext of CACHE_EXTS) {
    try {
      const f = cacheFile(scenarioId, theme, ext);
      if (fs.existsSync(f) && fs.statSync(f).size > 0) return cacheUrl(scenarioId, theme, ext) + '?v=' + fileVersion(f);
    } catch { /* 试下一个扩展名 */ }
  }
  return null;
}

/** 该剧本是否已有「主场景图」（离线跑批生成，见 scripts/generate_scene_art.py --masters） */
export function findMasterSceneArt(scenarioId: string): string | null {
  try {
    const f = path.join(OUT_DIR, '..', 'img', 'roleplay-scenes', `${scenarioId}-master.webp`);
    return fs.existsSync(f) && fs.statSync(f).size > 0 ? `/img/roleplay-scenes/${scenarioId}-master.webp?v=` + fileVersion(f) : null;
  } catch {
    return null;
  }
}

/**
 * 「批量专属图」目录（C 方案）：`public/img/roleplay-scenes/{剧本}-{幕}.webp`
 * 由 `scripts/generate_scene_art_cloud.mts --own` 用云 API 跑批写入，**每部剧本每一幕一张**。
 */
const OWN_DIR = path.resolve(OUT_DIR, '..', 'img', 'roleplay-scenes');

/**
 * 该剧本该幕的批量专属图（有则给出带版本号的 URL）。
 * 与 `findCachedSceneArt`（按需生成缓存，在 `public/scene-art/`）是两层：
 * 批量图是**预生成、确定存在**的，前端可无条件优先用，不需要任何 API 往返。
 */
export function findOwnThemeArt(scenarioId: string, theme: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scenarioId) || !/^[a-z0-9_-]{1,32}$/.test(theme)) return null;
  for (const ext of CACHE_EXTS) {
    try {
      const f = path.join(OWN_DIR, `${scenarioId}-${theme}.${ext}`);
      if (fs.existsSync(f) && fs.statSync(f).size > 0) return `/img/roleplay-scenes/${scenarioId}-${theme}.${ext}?v=` + fileVersion(f);
    } catch { /* 试下一个扩展名 */ }
  }
  return null;
}

/** 该剧本**已有哪些幕的批量专属图**（带版本号的 URL；前端据此预热：换幕即命中缓存，画面不迟到） */
export function listOwnThemeUrls(scenarioId: string): string[] {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scenarioId)) return [];
  const out: string[] = [];
  for (const t of SCENE_THEMES) {
    const u = findOwnThemeArt(scenarioId, t.id);
    if (u) out.push(u);
  }
  return out;
}

export async function generateSceneArt(
  userId: string,
  scenarioId: string,
  theme: string,
  opts: { auto?: boolean } = {},
): Promise<SceneArtResult> {
  // 🔴 2026-09-15 先查**图库**（`public/img/roleplay-scenes/{id}-{theme}.webp`，批量预生成的那 480 张）。
  //    为什么必须放在最前面：以前这一步只查 `findCachedSceneArt`（运行时缓存 `public/scene-art/`，通常为空），
  //    于是**明明图库里已经有这一幕的图**，POST 还是会真去调云 API 出图 —— 花额度 + 花云成本，
  //    而生成的图因为前端优先用图库的 `ownUrl`，**根本不会显示**（纯浪费）。
  const inLibrary = findOwnThemeArt(scenarioId, theme);
  const cached = inLibrary || findCachedSceneArt(scenarioId, theme);
  const q = sceneArtQuota(userId);
  // 已有图直接命中（0 算力、0 等待）；自动出图也走这条路，所以"同一幕"不会被重复生成
  if (cached) return { ok: true, url: cached, cached: true, used: q.used, cap: q.cap, plan: q.plan };

  // 自动出图：四道闸门（仅 Pro / 用户开关 / 关键时刻 / 冷却）
  if (opts.auto) {
    const gate = autoSceneArtAllowed({
      plan: q.plan,
      prefEnabled: autoPrefEnabled(userId),
      theme,
      lastAutoAt: lastAutoAt.get(userId),
    });
    if (!gate.ok) {
      return { ok: false, code: gate.code, message: gate.message, used: q.used, cap: q.cap, plan: q.plan };
    }
  }

  if (!SCENE_ART_ENABLED) {
    return { ok: false, degraded: true, code: 'DISABLED', message: '按需出图未开启', used: q.used, cap: q.cap, plan: q.plan };
  }
  /**
   * 并发闸门（2026-09-29 审查 A4-P2）：这里是典型的「检查后动作」——
   * 读到 q.remain → await 云端出图（最长 120s）→ 出图成功才 bumpUsage。
   * 期间同一用户的并发请求都各自看到同一个 remain → 一次能出远超上限的**付费**图；
   * 而且计数在进程内存里，重启即清零。所以把「正在出图」的名额也计入配额（used + inflight）。
   */
  const pending = inFlight.get(userId) || 0;
  if (q.remain - pending <= 0) {
    return { ok: false, code: 'DAILY_CAP', message: `今日专属画面已用完（${q.plan} 档 ${q.cap} 张/天）`, used: q.used, cap: q.cap, plan: q.plan };
  }
  inFlight.set(userId, pending + 1);
  try {

  // 白名单校验在调用方做；这里再取一次 prompt（同一函数，双保险）
  const v = validateSceneArtRequest({ scenarioId, theme });
  if (!v.ok) return { ok: false, code: v.code, message: v.message, used: q.used, cap: q.cap, plan: q.plan };

  // 出图：云 API（默认）或本机侧车（兜底）。seed 由 {剧本}-{幕} 稳定推导 → 同一幕永远同一张图。
  const seed = stableSeed(`${v.scenarioId}-${v.theme}`);
  const out = await generateImage(
    {
      prompt: v.prompt, // ← 只可能来自白名单表
      negative: SCENE_NEGATIVE_PROMPT,
      width: SIZE.width, height: SIZE.height, seed,
      worldview: v.worldview, theme: v.theme,
    },
    { timeoutMs: TIMEOUT_MS },
  );
  if (!out.ok || !out.bytes) {
    // 出图失败一律降级（不消耗额度、不打扰用户）：前端继续用共享图库/主场景图
    return {
      ok: false, degraded: out.degraded !== false,
      code: out.code || 'EMPTY', message: out.message || '出图失败',
      used: q.used, cap: q.cap, plan: q.plan,
    };
  }
  const ext: CacheExt = (out.ext || 'webp') as CacheExt;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(scenarioId, theme, ext), out.bytes);
  } catch (e) {
    return { ok: false, code: 'IO', message: '写盘失败：' + (e as Error)?.message, used: q.used, cap: q.cap, plan: q.plan };
  }
  bumpUsage(userId);
  if (opts.auto) lastAutoAt.set(userId, Date.now());
  // 出图是真金白银（云 API 按张计费）：成功出图后记一笔成本，归到控制台「出图」一行。
  // 此前这里只 `bumpUsage`（内存里的每日张数配额），**没有任何金额进成本账本** → 控制台的 API 成本看不见图片钱。
  try {
    const id = resolveProviderId();
    usageStore.recordImageCost(userId, {
      provider: id,
      count: 1,
      yuan: priceOfProvider(id),
      feature: 'image',
    });
  } catch { /* 记账失败不影响出图 */ }
  const after = sceneArtQuota(userId);
  return {
    ok: true, url: cacheUrl(scenarioId, theme, ext) + '?v=' + fileVersion(cacheFile(scenarioId, theme, ext)),
    cached: false, seconds: out.seconds, used: after.used, cap: after.cap, plan: after.plan,
  };
  } finally {
    // 无论成功、降级还是抛错，都要把预留的名额还回去（否则配额会被这次请求永久占掉一张）
    const n = (inFlight.get(userId) || 1) - 1;
    if (n <= 0) inFlight.delete(userId); else inFlight.set(userId, n);
  }
}

/** 当前出图后端信息（给后台/健康检查看：用了哪家、有没有配 key、支持不支持负向词） */
export function sceneArtBackendInfo(): { provider: ImageProviderId; label: string; ready: boolean; negative: boolean; size: string } {
  const id = resolveProviderId();
  return {
    provider: id,
    label: IMAGE_PROVIDERS[id].label,
    ready: providerReady(id),
    negative: IMAGE_PROVIDERS[id].negative,
    size: `${SIZE.width}x${SIZE.height}`,
  };
}
