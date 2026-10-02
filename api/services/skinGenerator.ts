/**
 * 皮肤生成器：主题 → 风格锚点 → 每槽位英文提示词 → Seedream 顺序出图 → 落盘。
 * 支持 dryRun（只出提示词不花钱）、slots 子集、断点续跑（跳过已存在的槽位文件）。
 * 敏感 Key 经调用方注入；本模块只在需要 LLM 扩写时读取 DEEPSEEK_API_KEY。
 */
import '../services/env.js'; // 确保 .env / .env.local 先加载（副作用）

import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { SKIN_SLOTS, slotByKey, type SkinSlot } from './skinSlots.js';
import { writeStaticSkins } from './skinStaticize.js';
import { generateAppIconsForSkin } from './appIcons.js';
import { generateImage, downloadImage, type SeedreamImageResult } from './seedream.js';
import { SYSTEM_USER_ID, usageStore } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const publicRoot = path.join(projectRoot, 'public');
/** 生成的皮肤统一保存为 WebP（sharp 重编码 + 按用途缩小，避免动辄 1MB/张）。 */
const IMAGE_EXT = 'webp';
/**
 * Seedream 参考单价（元/张），仅用于运营端成本记账（真实账单以火山控制台为准）。
 * 与 api/services/imageApi.ts 里 seedream 档的参考价同量级，可用 SEEDREAM_PRICE_YUAN 覆盖。
 */
const SEEDREAM_PRICE_YUAN = Number(process.env.SEEDREAM_PRICE_YUAN || 0.2);
/** 各槽位生成图的目标最大宽度（保持宽高比；首页大图 1600 / 插图 800 / 图标与 logo 512–1200）。 */
const WEBP_WIDTH: Record<string, number> = {
  bg: 1600, bgPortrait: 900, hero: 1600, chat: 800, structure: 800, story: 800,
  wordmark: 1200, heart: 512, favicon: 512, companion: 800, membership: 512,
  modeHug: 512, modeAlly: 512, modeClarify: 512, modeLight: 512, modeObjective: 512,
  feedback: 512, planFree: 512, planPlus: 512, planPro: 512, preview: 800,
};

export interface StyleAnchor {
  themeEnglish: string;
  mood: string;
  palette: string[];
  keywords: string[];
}

export interface GenerateSkinOptions {
  theme: string;
  skinId?: string;
  slots?: string[];
  dryRun?: boolean;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** 可选：更详细的风格规格（用于向 LLM/出图模型传递材质/色彩/元素等描述；不作为皮肤显示名） */
  styleSpec?: string;
}

export interface SlotOutcome {
  key: string;
  titleEn: string;
  prompt: string;
  status: 'ok' | 'skipped' | 'dryrun' | 'error';
  file?: string;
  error?: string;
}

export interface GenerateSkinResult {
  skinId: string;
  theme: string;
  dryRun: boolean;
  styleAnchor: StyleAnchor;
  slots: SlotOutcome[];
  imageDir: string;
  metaFile?: string;
  total: number;
  generated: number;
}

/* 【工具函数】 */

function asciiSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function deriveSkinId(theme: string): string {
  const t = theme.trim();
  // 少量常见中文主题 → 英文 id（生成目录/皮肤 id 用 ASCII）
  if (/星|夜|night|star/i.test(t)) return 'star';
  if (/海|ocean|sea/i.test(t)) return 'ocean';
  if (/月|moon/i.test(t)) return 'moon';
  if (/森|森林|forest/i.test(t)) return 'forest';
  if (/花|flower|blossom/i.test(t)) return 'flower';
  if (/雪|snow/i.test(t)) return 'snow';
  const slug = asciiSlug(t);
  return slug || 'skin';
}

function isStarry(theme: string): boolean {
  return /星|星空|夜|night|star|galaxy/i.test(theme);
}

/** 软萌粉彩风（棉柔/马卡龙/糖果/粉彩/梦幻治愈/少女心）：提示词不防粉彩卡通，反而强化。 */
function isSoft(theme: string, spec?: string): boolean {
  const s = `${theme} ${spec || ''}`;
  return /棉花糖|cotton candy|软萌|毛绒|马卡龙|pastel|糖果|candy|梦幻|治愈|少女心|girly|kawaii|蓬松|squishy|puffy|plush|云朵|cloud/i.test(s);
}

/** Seedream 5.0 最低总像素 ≥ 3,686,400；按长宽比取合规尺寸，兜底保证不超最小像素。 */
function sizeForSlot(slot: SkinSlot): string {
  if (/^\d+x\d+$/.test(slot.size)) {
    const [w, h] = slot.size.split('x').map(Number);
    if (w * h >= 3686400) return slot.size;
  }
  switch (slot.aspect) {
    case 'wide':
    case 'logo':
      return '2560x1440';
    case 'portrait':
      return '1440x2560';
    default:
      return '1920x1920';
  }
}

function templateAnchor(theme: string): StyleAnchor {
  if (isStarry(theme)) {
    return {
      themeEnglish: 'starry night',
      mood: 'serene, dreamy, enchanting, elegant night',
      palette: ['#0B1026', '#1B2A6B', '#5B3E8C', '#E8C96A', '#9BD1E8'],
      keywords: ['starry night', 'night sky', 'stars', 'moonlight', 'soft glow', 'high detail', 'no text', 'no UI', 'no watermark'],
    };
  }
  if (isSoft(theme)) {
    return {
      themeEnglish: 'cotton candy pastel dream',
      mood: 'dreamy, healing, cute, soft, wildly imaginative',
      palette: ['#F8C8DC', '#C9B6F0', '#BFD9F2', '#FBE7A1', '#FFF0F6'],
      keywords: ['cotton candy', 'pastel pink', 'pastel purple', 'pastel blue', 'pastel yellow', 'plush fluffy', 'soft marble swirls', 'gradient nebula', 'colorful cloud puffs', 'glittering stardust', 'cross starbursts', 'no text', 'no UI', 'no watermark'],
    };
  }
  return {
    themeEnglish: asciiSlug(theme) || 'gentle healing',
    mood: 'calm, soft, warm, gentle',
    palette: ['#FBF6EE', '#1FA46B', '#178353', '#DCFCE7', '#F59E0B'],
    keywords: ['gentle healing', 'soft cream', 'mint green', 'amber accent', 'no text', 'no UI', 'no watermark'],
  };
}

function parseJsonLoose(text: string): any {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch { /* 继续 */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 失败 */ }
  }
  return null;
}

/** 有 DEEPSEEK_API_KEY 时用 DeepSeek 扩写风格锚点；否则返回 null（回退模板）。 */
async function expandStyleAnchorWithLLM(theme: string, spec?: string): Promise<StyleAnchor | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return null;
  try {
    const { createDeepSeekClient } = await import('./deepseek.js');
    const client = createDeepSeekClient();
    const soft = isSoft(theme, spec);
    const specBlock = spec ? `\n【风格规格（必须充分体现）】${spec}\n` : '';
    const styleRule = soft
      ? `风格要求：**软萌、梦幻、治愈、少女心、有想象力**：棉柔/毛绒/蓬松质感、马卡龙粉紫蓝黄、渐变星云、棉花糖云朵、闪烁星尘、十字星芒、柔软大理石纹理；可可爱爱、粉彩、卡通感是**加分项**，不要违和。`
      : `风格要求：**精致、有质感、有氛围**，风格契合主题即可，**不要强制「璀璨梦幻/华丽」这类固定形容词**；**绝不要幼稚、不要卡通、不要扁平粉彩、不要 clip-art**；星空/宇宙主题参考深邃夜色与星光（深蓝/紫/金），不要马卡龙粉彩。`;
    const prompt =
      `你是「小愈」情绪陪伴产品的资深视觉设计师。请基于用户给的主题，产出一套皮肤「风格锚点」，只输出一个 JSON 对象，不要解释、不要代码围栏。` +
      `主题：${theme}\n` + specBlock +
      `输出格式：{"themeEnglish":"英文主题名(小写)","mood":"情绪关键词,逗号分隔","palette":["#六位hex",...5个],"keywords":["英文风格关键词",...6-9个],}\n` +
      styleRule +
      `关键词里必须包含 no text、no UI、no watermark 用于图片生成。`;
    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash', // DeepSeek 兼容占位符，等价于"默认模型"
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      userId: SYSTEM_USER_ID, // 运营内部调用：记到「系统/后台」行
      feature: 'internal',
    });
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = parseJsonLoose(text);
    if (json && typeof json.themeEnglish === 'string' && Array.isArray(json.palette)) {
      const palette = (json.palette as any[]).filter((c) => typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c)).map((c) => c.startsWith('#') ? c : `#${c}`);
      if (!palette.length) return null;
      return {
        themeEnglish: json.themeEnglish,
        mood: String(json.mood || 'calm, soft, gentle'),
        palette,
        keywords: (Array.isArray(json.keywords) ? json.keywords : []).map(String).slice(0, 12),
      };
    }
  } catch {
    return null; // LLM 失败/未配置 → 模板兜底
  }
  return null;
}

async function buildStyleAnchor(theme: string, spec?: string): Promise<StyleAnchor> {
  const llmAnchor = await expandStyleAnchorWithLLM(theme, spec);
  return llmAnchor ?? templateAnchor(theme);
}

function buildSlotPrompt(slot: SkinSlot, anchor: StyleAnchor, soft: boolean): string {
  const fill =
    'Composition: the subject fills the ENTIRE canvas edge-to-edge, large and centered, no empty background, ' +
    'no unused margins, no letterboxing, no wasted space, no rounded border, no frame, no card outline, no picture-in-picture; ' +
    'it must fully cover the frame and be safe to crop into a square card. ';
  const cue = soft
    ? 'Soft dreamy cute pastel: cotton candy, plush squishy fluffy, puffy, soft marble swirls, pastel pink/purple/blue/yellow, gradient nebula, colorful cloud puffs, glittering stardust, brilliant cross-shaped starbursts, dreamy healing girly,'
    : 'A refined, high-quality illustration with depth and atmosphere, rich but tasteful color, elegant lighting,';
  const base =
    `${cue} Theme: ${anchor.themeEnglish}. Mood: ${anchor.mood}. Palette: ${anchor.palette.join(', ')}. Keywords: ${anchor.keywords.join(', ')}. ` +
    (soft ? 'Cute, kawaii, soft, dreamy, healing.' : 'Not childish, not flat pastel, not cartoon, not clip-art.') +
    ` ${fill}No text, no watermark, no UI, no interface elements, no people unless noted.`;
  const aspectWord = slot.aspect === 'portrait' ? 'vertical' : slot.aspect === 'wide' ? 'wide' : 'square';
  switch (slot.kind) {
    case 'scene':
      return `${base} A ${aspectWord} ${slot.titleEn} for the Xiaoyu gentle-healing companion app, soft glow, atmospheric depth, rich gradient, fills the whole frame. `;
    case 'illustration':
      return `${base} A ${aspectWord} ${slot.titleEn} illustration, the central subject is large and fills the frame, rich detail, refined, edge-to-edge artwork. `;
    case 'avatar':
      return `${base} A friendly ${slot.titleEn}, the character or abstract form fills the frame large and centered, soft glow, square crop. `;
    case 'logo':
      return `${base} A brand ${slot.titleEn}, elegant minimal typography that fills the frame large and clear, on a rich background, small accent. `;
    case 'icon':
      return `${base} A minimal flat ${slot.titleEn}, the icon glyph is large, bold, centered, fills the tile, on a simple rich background, crisp, no tiny details, no extra space. `;
    default:
      return base;
  }
}

async function saveImage(filePath: string, img: SeedreamImageResult, slotKey: string): Promise<void> {
  let buffer: Buffer;
  if (img.base64) {
    const raw = img.base64.includes(',') ? img.base64.split(',')[1] : img.base64;
    buffer = Buffer.from(raw, 'base64');
  } else if (img.url) {
    const d = await downloadImage(img.url);
    buffer = d.buffer;
  } else {
    throw new Error('无可落盘的图片数据');
  }
  // 重编码为 WebP 并按槽位缩小，避免每张 1MB 拖慢换肤
  const w = WEBP_WIDTH[slotKey] || 800;
  const webp = await sharp(buffer).resize({ width: w, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  await fs.writeFile(filePath, webp);
  // 入口卡图标（chat/structure/story）、陪伴方式图标（modeHug/modeAlly/modeClarify/modeLight/modeObjective）、
  // 会员档图标（planFree/planPlus/planPro）与意见反馈图标（feedback）在界面里只有 ~40-56px，
  // 额外生成 240px 小图 `*-sm.webp`，供首页/开始页/场景卡/会员徽章在手机端用小图省流量（无则前端回退大图）
  if (slotKey === 'chat' || slotKey === 'structure' || slotKey === 'story' ||
      slotKey === 'modeHug' || slotKey === 'modeAlly' || slotKey === 'modeClarify' || slotKey === 'modeLight' || slotKey === 'modeObjective' ||
      slotKey === 'planFree' || slotKey === 'planPlus' || slotKey === 'planPro' || slotKey === 'feedback') {
    const smallPath = filePath.replace(/\.webp$/, '-sm.webp');
    const small = await sharp(buffer).resize({ width: 240, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    await fs.writeFile(smallPath, small);
  }
}

/* 【主流程】 */

export async function generateSkin(opts: GenerateSkinOptions): Promise<GenerateSkinResult> {
  const theme = (opts.theme || '').trim();
  if (!theme) throw new Error('缺少主题');
  const skinId = (opts.skinId && opts.skinId.trim()) ? opts.skinId.trim() : deriveSkinId(theme);
  const styleSpec = opts.styleSpec?.trim() || undefined;
  const soft = isSoft(theme, styleSpec);
  const anchor = await buildStyleAnchor(theme, styleSpec);

  const requested = opts.slots && opts.slots.length ? opts.slots : SKIN_SLOTS.map((s) => s.key);
  const slots = SKIN_SLOTS.filter((s) => requested.includes(s.key));
  if (!slots.length) throw new Error('没有可用的槽位');

  const imageDir = path.join(publicRoot, 'skins', skinId);
  await fs.mkdir(imageDir, { recursive: true });

  const dryRun = !!opts.dryRun;
  const outcomes: SlotOutcome[] = [];
  let generated = 0;

  for (const slot of slots) {
    const prompt = buildSlotPrompt(slot, anchor, soft);
    if (dryRun) {
      outcomes.push({ key: slot.key, titleEn: slot.titleEn, prompt, status: 'dryrun' });
      continue;
    }
    const filePath = path.join(imageDir, `${slot.key}.${IMAGE_EXT}`);
    if (existsSync(filePath)) {
      outcomes.push({ key: slot.key, titleEn: slot.titleEn, prompt, status: 'skipped', file: filePath });
      continue;
    }
    try {
      const img = await generateImage(prompt, sizeForSlot(slot), {
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
      });
      await saveImage(filePath, img, slot.key);
      generated++;
      // 运营出图同样是真金白银（Seedream 按张计费）：记进成本账本，归到「出图」一行
      try { usageStore.recordImageCost(SYSTEM_USER_ID, { provider: 'seedream', count: 1, yuan: SEEDREAM_PRICE_YUAN }); } catch { /* 记账失败不影响出图 */ }
      outcomes.push({ key: slot.key, titleEn: slot.titleEn, prompt, status: 'ok', file: filePath });
    } catch (e) {
      outcomes.push({ key: slot.key, titleEn: slot.titleEn, prompt, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  const metaFile = path.join(imageDir, 'meta.json');
  // 写「完整 SkinMeta」形状的 meta.json（供前端动态加载：生成即出现、免改源码）
  const u = (key: string): string => (existsSync(path.join(imageDir, `${key}.${IMAGE_EXT}`)) ? `/skins/${skinId}/${key}.${IMAGE_EXT}?v=2` : '');
  const meta = {
    id: skinId,
    label: theme,
    desc: `由管理员生成 · ${theme}`,
    labelKey: '',
    descKey: '',
    bg: u('bg'),
    bgPortrait: u('bgPortrait'),
    hero: u('hero'),
    chat: u('chat'),
    structure: u('structure'),
    story: u('story'),
    chatSm: existsSync(path.join(imageDir, 'chat-sm.webp')) ? `/skins/${skinId}/chat-sm.webp?v=2` : '',
    structureSm: existsSync(path.join(imageDir, 'structure-sm.webp')) ? `/skins/${skinId}/structure-sm.webp?v=2` : '',
    storySm: existsSync(path.join(imageDir, 'story-sm.webp')) ? `/skins/${skinId}/story-sm.webp?v=2` : '',
    wordmark: u('wordmark'),
    heart: u('heart'),
    favicon: u('favicon'),
    companion: u('companion'),
    membership: u('membership'),
    modeHug: u('modeHug'),
    modeAlly: u('modeAlly'),
    modeClarify: u('modeClarify'),
    modeLight: u('modeLight'),
    modeObjective: u('modeObjective'),
    modeHugSm: existsSync(path.join(imageDir, 'modeHug-sm.webp')) ? `/skins/${skinId}/modeHug-sm.webp?v=2` : '',
    modeAllySm: existsSync(path.join(imageDir, 'modeAlly-sm.webp')) ? `/skins/${skinId}/modeAlly-sm.webp?v=2` : '',
    modeClarifySm: existsSync(path.join(imageDir, 'modeClarify-sm.webp')) ? `/skins/${skinId}/modeClarify-sm.webp?v=2` : '',
    modeLightSm: existsSync(path.join(imageDir, 'modeLight-sm.webp')) ? `/skins/${skinId}/modeLight-sm.webp?v=2` : '',
    modeObjectiveSm: existsSync(path.join(imageDir, 'modeObjective-sm.webp')) ? `/skins/${skinId}/modeObjective-sm.webp?v=2` : '',
    feedback: u('feedback'),
    feedbackSm: existsSync(path.join(imageDir, 'feedback-sm.webp')) ? `/skins/${skinId}/feedback-sm.webp?v=2` : '',
    planFree: u('planFree'),
    planPlus: u('planPlus'),
    planPro: u('planPro'),
    planFreeSm: existsSync(path.join(imageDir, 'planFree-sm.webp')) ? `/skins/${skinId}/planFree-sm.webp?v=2` : '',
    planPlusSm: existsSync(path.join(imageDir, 'planPlus-sm.webp')) ? `/skins/${skinId}/planPlus-sm.webp?v=2` : '',
    planProSm: existsSync(path.join(imageDir, 'planPro-sm.webp')) ? `/skins/${skinId}/planPro-sm.webp?v=2` : '',
    preview: u('preview'),
    palette: anchor.palette,
    theme,
    createdAt: new Date().toISOString(),
    styleAnchor: anchor,
    slots: outcomes.map((o) => ({ key: o.key, file: o.file, prompt: o.prompt })),
  };
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  // 管理员生成的皮肤 = 默认皮肤：静态化（写入 src/lib/generated-skins.ts + src/generated-skins.css），
  // 并把 public/skins/manifest.json 置空（动态机制留作未来用户自建皮肤）。重新构建前端后皮肤即随包发布。
  await writeStaticSkins(projectRoot);
  // 新皮肤自动生成「hero 正方形 app 图标 + 该皮肤 PWA manifest」（图标随皮肤）
  await generateAppIconsForSkin(publicRoot, skinId);

  return {
    skinId,
    theme,
    dryRun,
    styleAnchor: anchor,
    slots: outcomes,
    imageDir,
    metaFile,
    total: slots.length,
    generated,
  };
}

export { slotByKey };
