/**
 * 界面皮肤（用户可选外观）
 * 通过 <html data-skin="..."> 切换全局 CSS 变量；图片资源由组件按当前皮肤引用。
 * 皮肤选择只存 localStorage（纯 UI 偏好，不动后端 AI 偏好）。
 */
import { GENERATED_STATIC_SKINS } from './generated-skins';

export type SkinId = string;

export interface SkinMeta {
  id: SkinId;
  /** i18n 键：显示名 / 说明 */
  labelKey: string;
  descKey: string;
  /** 动态/生成皮肤的展示名与说明（无 i18n 键时直接用；静态皮肤用 labelKey/descKey） */
  label?: string;
  desc?: string;
  /** 氛围背景 / Hero 主场景 / 三入口插画（相对 public/ 的 URL） */
  bg: string;
  /** 竖版氛围背景（手机端/分享卡用） */
  bgPortrait: string;
  hero: string;
  chat: string;
  structure: string;
  story: string;
  /** 入口卡图标小图（≈240px；首页「开始聊聊」/ 开始页 / 了解小愈在手机端用小图省流量，无则回退大图） */
  chatSm: string;
  structureSm: string;
  storySm: string;
  /** 品牌字标 / 心形 mark / favicon / AI 陪伴头像 / 会员中心标 */
  wordmark: string;
  heart: string;
  favicon: string;
  companion: string;
  membership: string;
  /** 场景卡插画（键名沿用 mode*；2026-09-23 起仅作首页场景卡配图，不再代表「档位」） */
  modeHug: string;
  modeAlly: string;
  modeClarify: string;
  modeLight: string;
  modeObjective: string;
  /** 场景卡插画小图（≈240px；场景卡用小图省流量） */
  modeHugSm: string;
  modeAllySm: string;
  modeClarifySm: string;
  modeLightSm: string;
  modeObjectiveSm: string;
  /** 意见反馈图标（按皮肤） */
  feedback: string;
  /** 会员三档图标（按皮肤） */
  planFree: string;
  planPlus: string;
  planPro: string;
  /** 会员档图标小图（≈240px；会员徽章/会员卡用小图省流量） */
  planFreeSm: string;
  planPlusSm: string;
  planProSm: string;
  /** 意见反馈图标小图（≈240px） */
  feedbackSm: string;
  /** 选择器缩略图 */
  preview: string;
}

export const SKINS: SkinMeta[] = [
  {
    id: 'default',
    labelKey: 'skinDefault',
    descKey: 'skinDefaultDesc',
    bg: '',
    bgPortrait: '',
    hero: '',
    chat: '',
    structure: '',
    story: '',
    chatSm: '',
    structureSm: '',
    storySm: '',
    wordmark: '',
    heart: '',
    favicon: '',
    companion: '',
    membership: '',
    modeHug: '',
    modeAlly: '',
    modeClarify: '',
    modeLight: '',
    modeObjective: '',
    modeHugSm: '',
    modeAllySm: '',
    modeClarifySm: '',
    modeLightSm: '',
    modeObjectiveSm: '',
    feedback: '',
    planFree: '',
    planPlus: '',
    planPro: '',
    planFreeSm: '',
    planPlusSm: '',
    planProSm: '',
    feedbackSm: '',
    preview: '',
  },
  {
    id: 'candy',
    labelKey: 'skinCandy',
    descKey: 'skinCandyDesc',
    bg: '/skins/candy/bg.webp?v=2',
    bgPortrait: '/skins/candy/bgPortrait.webp?v=2',
    hero: '/skins/candy/hero.webp?v=2',
    chat: '/skins/candy/chat.webp?v=2',
    structure: '/skins/candy/structure.webp?v=2',
    story: '/skins/candy/story.webp?v=2',
    chatSm: '/skins/candy/chat-sm.webp?v=2',
    structureSm: '/skins/candy/structure-sm.webp?v=2',
    storySm: '/skins/candy/story-sm.webp?v=2',
    wordmark: '/skins/candy/wordmark.webp?v=4',
    heart: '/skins/candy/heart.webp?v=2',
    favicon: '/skins/candy/favicon.webp?v=2',
    companion: '/skins/candy/companion.webp?v=2',
    membership: '/skins/candy/membership.webp?v=2',
    modeHug: '/skins/candy/modeHug.webp?v=2',
    modeAlly: '/skins/candy/modeAlly.webp?v=2',
    modeClarify: '/skins/candy/modeClarify.webp?v=2',
    modeLight: '/skins/candy/modeLight.webp?v=2',
    modeObjective: '/skins/candy/modeObjective.webp?v=2',
    modeHugSm: '/skins/candy/modeHug-sm.webp?v=2',
    modeAllySm: '/skins/candy/modeAlly-sm.webp?v=2',
    modeClarifySm: '/skins/candy/modeClarify-sm.webp?v=2',
    modeLightSm: '/skins/candy/modeLight-sm.webp?v=2',
    modeObjectiveSm: '/skins/candy/modeObjective-sm.webp?v=2',
    feedback: '/skins/candy/feedback.webp?v=2',
    planFree: '/skins/candy/planFree.webp?v=2',
    planPlus: '/skins/candy/planPlus.webp?v=2',
    planPro: '/skins/candy/planPro.webp?v=2',
    planFreeSm: '/skins/candy/planFree-sm.webp?v=2',
    planPlusSm: '/skins/candy/planPlus-sm.webp?v=2',
    planProSm: '/skins/candy/planPro-sm.webp?v=2',
    feedbackSm: '/skins/candy/feedback-sm.webp?v=2',
    preview: '/skins/candy/preview.webp?v=2',
  },
  {
    id: 'healing',
    labelKey: 'skinHealing',
    descKey: 'skinHealingDesc',
    bg: '/skins/healing/bg.webp?v=3',
    bgPortrait: '/skins/healing/bg-portrait.webp?v=3',
    hero: '/skins/healing/hero.webp?v=3',
    chat: '/skins/healing/chat.webp?v=4',
    structure: '/skins/healing/structure.webp?v=3',
    story: '/skins/healing/story.webp?v=3',
    chatSm: '/skins/healing/chat-sm.webp?v=3',
    structureSm: '/skins/healing/structure-sm.webp?v=3',
    storySm: '/skins/healing/story-sm.webp?v=3',
    wordmark: '/skins/healing/wordmark.webp?v=4',
    heart: '/skins/healing/heart.png?v=3',
    favicon: '/skins/healing/favicon.png?v=3',
    companion: '/skins/healing/companion.webp?v=3',
    membership: '/skins/healing/membership.webp?v=3',
    modeHug: '/skins/healing/mode-hug.webp',
    modeAlly: '/skins/healing/mode-ally.webp',
    modeClarify: '/skins/healing/mode-clarify.webp',
    modeLight: '/skins/healing/mode-light.webp',
    modeObjective: '/skins/healing/mode-objective.webp',
    modeHugSm: '/skins/healing/mode-hug-sm.webp',
    modeAllySm: '/skins/healing/mode-ally-sm.webp',
    modeClarifySm: '/skins/healing/mode-clarify-sm.webp',
    modeLightSm: '/skins/healing/mode-light-sm.webp',
    modeObjectiveSm: '/skins/healing/mode-objective-sm.webp',
    feedback: '/skins/healing/feedback.webp',
    planFree: '/skins/healing/plan-free.webp',
    planPlus: '/skins/healing/plan-plus.webp',
    planPro: '/skins/healing/plan-pro.webp',
    planFreeSm: '/skins/healing/plan-free-sm.webp',
    planPlusSm: '/skins/healing/plan-plus-sm.webp',
    planProSm: '/skins/healing/plan-pro-sm.webp',
    feedbackSm: '/skins/healing/feedback-sm.webp',
    preview: '/skins/healing/bg-sm.webp?v=3',
  },
  {
    id: 'zen',
    labelKey: 'skinZen',
    descKey: 'skinZenDesc',
    bg: '/skins/zen/bg.webp?v=3',
    bgPortrait: '/skins/zen/bg-portrait.webp?v=3',
    hero: '/skins/zen/hero.webp?v=3',
    chat: '/skins/zen/chat.webp?v=3',
    structure: '/skins/zen/structure.webp?v=3',
    story: '/skins/zen/story.webp?v=3',
    chatSm: '/skins/zen/chat-sm.webp?v=3',
    structureSm: '/skins/zen/structure-sm.webp?v=3',
    storySm: '/skins/zen/story-sm.webp?v=3',
    wordmark: '/skins/zen/wordmark.webp?v=4',
    heart: '/skins/zen/heart.png?v=3',
    favicon: '/skins/zen/favicon.png?v=3',
    companion: '/skins/zen/companion.webp?v=3',
    membership: '/skins/zen/membership.webp?v=3',
    modeHug: '/skins/zen/mode-hug.webp',
    modeAlly: '/skins/zen/mode-ally.webp',
    modeClarify: '/skins/zen/mode-clarify.webp',
    modeLight: '/skins/zen/mode-light.webp',
    modeObjective: '/skins/zen/mode-objective.webp',
    modeHugSm: '/skins/zen/mode-hug-sm.webp',
    modeAllySm: '/skins/zen/mode-ally-sm.webp',
    modeClarifySm: '/skins/zen/mode-clarify-sm.webp',
    modeLightSm: '/skins/zen/mode-light-sm.webp',
    modeObjectiveSm: '/skins/zen/mode-objective-sm.webp',
    feedback: '/skins/zen/feedback.webp',
    planFree: '/skins/zen/plan-free.webp',
    planPlus: '/skins/zen/plan-plus.webp',
    planPro: '/skins/zen/plan-pro.webp',
    planFreeSm: '/skins/zen/plan-free-sm.webp',
    planPlusSm: '/skins/zen/plan-plus-sm.webp',
    planProSm: '/skins/zen/plan-pro-sm.webp',
    feedbackSm: '/skins/zen/feedback-sm.webp',
    preview: '/skins/zen/bg-sm.webp?v=3',
  },
  {
    id: 'star',
    labelKey: 'skinStar',
    descKey: 'skinStarDesc',
    bg: '/skins/star/bg.webp?v=3',
    bgPortrait: '/skins/star/bgPortrait.webp?v=3',
    hero: '/skins/star/hero.webp?v=3',
    chat: '/skins/star/chat.webp?v=3',
    structure: '/skins/star/structure.webp?v=3',
    story: '/skins/star/story.webp?v=3',
    chatSm: '/skins/star/chat-sm.webp?v=3',
    structureSm: '/skins/star/structure-sm.webp?v=3',
    storySm: '/skins/star/story-sm.webp?v=3',
    wordmark: '/skins/star/wordmark.webp?v=5',
    heart: '/skins/star/heart.webp?v=3',
    favicon: '/skins/star/favicon.webp?v=3',
    companion: '/skins/star/companion.webp?v=3',
    membership: '/skins/star/membership.webp?v=3',
    modeHug: '/skins/star/modeHug.webp?v=3',
    modeAlly: '/skins/star/modeAlly.webp?v=3',
    modeClarify: '/skins/star/modeClarify.webp?v=3',
    modeLight: '/skins/star/modeLight.webp?v=3',
    modeObjective: '/skins/star/modeObjective.webp?v=3',
    modeHugSm: '/skins/star/modeHug-sm.webp?v=3',
    modeAllySm: '/skins/star/modeAlly-sm.webp?v=3',
    modeClarifySm: '/skins/star/modeClarify-sm.webp?v=3',
    modeLightSm: '/skins/star/modeLight-sm.webp?v=3',
    modeObjectiveSm: '/skins/star/modeObjective-sm.webp?v=3',
    feedback: '/skins/star/feedback.webp?v=3',
    planFree: '/skins/star/planFree.webp?v=3',
    planPlus: '/skins/star/planPlus.webp?v=3',
    planPro: '/skins/star/planPro.webp?v=3',
    planFreeSm: '/skins/star/planFree-sm.webp?v=3',
    planPlusSm: '/skins/star/planPlus-sm.webp?v=3',
    planProSm: '/skins/star/planPro-sm.webp?v=3',
    feedbackSm: '/skins/star/feedback-sm.webp?v=3',
    preview: '/skins/star/preview.webp?v=3',
  },  // 管理员生成的皮肤（静态化，随 build 发布；由皮肤生成器/scripts/staticize-skins.mts 写入）
  ...GENERATED_STATIC_SKINS,
];

/**
 * 默认皮肤（2026-09-18 由「小愈治愈系」改为「棉花糖」）。
 * 用户口径：「新用户以及游客的默认皮肤都改成棉花糖」——
 * 所以这里是**没有存档时**的取值；登录用户存在 localStorage 的选择一律尊重（见 getStoredSkin）。
 */
export const DEFAULT_SKIN: SkinId = 'candy';
/** 旧默认皮肤：仅用于识别「游客存档里那份多半不是自己选的」这一情况（一次性迁移，见 getStoredSkin） */
const LEGACY_DEFAULT_SKIN: SkinId = 'healing';
/** 一次性迁移标记：写过就说明该设备已经迁移过默认皮肤，之后用户自己选什么都尊重 */
const DEFAULT_MIGRATED_KEY = 'cure_skin_default_candy_v1';

/** 品牌主绿：默认/兜底的浏览器主题色（theme-color），皮肤未定义时使用 */
export const DEFAULT_THEME_COLOR = '#1FA46B';

const SKIN_KEY = 'cure_skin';
/** 站点公共 PWA manifest（= `public/manifest.webmanifest`，也是 index.html 里的静态默认值）。
 *  没有自家资源的皮肤（`default`）用这一份，避免去请求不存在的 `/skins/<id>/manifest.webmanifest`
 *  （那会拿到 SPA 回落的 HTML → 控制台 Manifest 解析报错，见 `skinHasOwnIcons` 注释）。 */
const GLOBAL_MANIFEST_HREF = '/manifest.webmanifest?v=2';
// 皮肤版本号：每次“切换默认皮肤”或需要把既有用户一次性拉回某皮肤时 +1。
// v2：默认/强制回到「小愈治愈系」（此前默认是「原版」）。
// ⚠️ 2026-09-18 默认改成「棉花糖」时**刻意不 +1**：+1 会把所有老用户（含自己选过皮肤的付费用户）
//    一并强行拉回默认皮肤。这次只需要「新用户 + 游客」换默认，做法见 DEFAULT_SKIN 与 getStoredSkin()。
const SKIN_VERSION_KEY = 'cure_skin_version';
const SKIN_VERSION = 2;

// iOS 主屏 web app 与 Safari 的 localStorage 不互通；皮肤用 cookie 也存一份，跨 Safari ↔ 主屏 App 携带同一套皮肤。
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  try { document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`; } catch { /* 忽略 */ }
}

/* —— 动态皮肤（管理员生成，运行时从 public/skins/manifest.json 加载，免改源码） —— */
let dynamicSkins: SkinMeta[] = [];

export function setDynamicSkins(list: SkinMeta[]): void {
  dynamicSkins = Array.isArray(list) ? list : [];
}

export function getDynamicSkins(): SkinMeta[] {
  return dynamicSkins;
}

/* —— 动态皮肤清单缓存（localStorage）：把运行时 manifest 缓存下来，下次加载在首帧前同步恢复，
     避免首帧 skinById 对动态皮肤（如 candy）落回默认皮肤、闪现错误 hero —— */
const DYNAMIC_SKINS_CACHE_KEY = 'cure_dynamic_skins_cache';

function readDynamicSkinsCache(): SkinMeta[] {
  try {
    const raw = localStorage.getItem(DYNAMIC_SKINS_CACHE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SkinMeta[]) : [];
  } catch { /* 忽略 */ }
  return [];
}

export function writeDynamicSkinsCache(list: SkinMeta[]): void {
  try {
    localStorage.setItem(DYNAMIC_SKINS_CACHE_KEY, JSON.stringify(list));
  } catch { /* 忽略 */ }
}

// 模块加载（React 渲染前）同步恢复已缓存的动态皮肤：让首帧 skinById 就能命中（如 candy），不闪 healing
dynamicSkins = readDynamicSkinsCache();

export function getAllSkins(): SkinMeta[] {
  const base = [...SKINS];
  for (const d of dynamicSkins) {
    if (!base.some((s) => s.id === d.id)) base.push(d);
  }
  return base;
}

export function skinById(id: SkinId): SkinMeta {
  return getAllSkins().find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN)!;
}

/** 预载一套皮肤的全部图片（换肤前预热缓存，避免切换瞬间现场下载） */
export function preloadSkinImages(meta: SkinMeta): void {
  if (typeof window === 'undefined' || !meta) return;
  const urls = new Set<string>();
  for (const v of Object.values(meta)) {
    if (typeof v === 'string' && v.startsWith('/skins/')) urls.add(v);
  }
  for (const url of urls) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

export function getStoredSkin(): SkinId {
  let id = '';
  try {
    // 版本未升级（含之前默认「原版」）→ 一次性强制回退到默认（当前=小愈治愈系）
    const ver = Number(localStorage.getItem(SKIN_VERSION_KEY) || '0');
    if (ver >= SKIN_VERSION) {
      const v = localStorage.getItem(SKIN_KEY);
      // 动态皮肤（管理员生成）不在静态 SKINS 里，用非空 id 即接受；未命中时 skinById 会回退默认
      if (v && typeof v === 'string' && v.trim()) id = v;
    }
  } catch { /* 忽略 */ }
  // iOS 主屏 web app 与 Safari 的 localStorage 不通：回退读 cookie 携带的皮肤（SameSite=Lax、path=/）
  if (!id) {
    const cver = Number(readCookie(SKIN_VERSION_KEY) || '0');
    if (cver >= SKIN_VERSION) {
      const cv = readCookie(SKIN_KEY);
      if (cv && cv.trim()) id = cv;
    }
  }
  // 老游客的一次性迁移：存档里那份 `healing` 多半不是自己选的（是当年默认皮肤自动写进去的）。
  // 只对**未登录**设备生效——登录用户可能是真选过「小愈治愈系」，一律尊重其选择。
  if (id === LEGACY_DEFAULT_SKIN && !hasLoginToken() && !readDefaultMigrated()) {
    try { localStorage.setItem(DEFAULT_MIGRATED_KEY, '1'); } catch { /* 忽略 */ }
    id = DEFAULT_SKIN;
  }
  return id || DEFAULT_SKIN;
}

/** 该设备是否已登录（有 token）——只读 `cure_app_token`，不 import services/api，避免循环依赖 */
function hasLoginToken(): boolean {
  try { return !!localStorage.getItem('cure_app_token'); } catch { return false; }
}
function readDefaultMigrated(): boolean {
  try { return localStorage.getItem(DEFAULT_MIGRATED_KEY) === '1'; } catch { return false; }
}

/**
 * 该皮肤在 `public/skins/<id>/` 下**有没有自己的图标与 manifest 资源**。
 *
 * 为什么需要这个判断（2026-09-17 实机核对到的既有 bug）：`default` 皮肤是「纯品牌底」——
 * `SKINS` 里它的所有资源字段都是空串，`public/skins/` 下也**没有 default 目录**；
 * 而 `applySkin()` 以前一律把 favicon / 主屏图标 / manifest 改写成 `/skins/<id>/...`：
 *   - `/skins/default/app-icon-32.png` → 404（标签页图标空掉）
 *   - `/skins/default/manifest.webmanifest` → Express 把 SPA 的 `index.html` 回落给这个请求，
 *     浏览器按 manifest 解析 HTML → 控制台 `Manifest: Line: 1, column: 1, Syntax error.`
 *     （每开一次首页报一次；已由 `temp/verify-mem-usage-ui.mjs` 的基线对照确认与其它改动无关）
 * → 没有自家资源的皮肤**一律回退站点根目录的公共资源**（公共 `/manifest.webmanifest` 的图标
 *   是品牌 logo，颜色也是品牌底色，正是「default = 品牌原版」该有的样子）。
 * 管理员生成的皮肤走 `generateAppIconsForSkin()` 写 `app-icon-*.png` + `manifest.webmanifest`，
 * 所以有 hero 的皮肤天然为 true。
 */
function skinHasOwnIcons(id: SkinId): boolean {
  const builtin = SKINS.find((s) => s.id === id);
  if (builtin) return !!builtin.favicon;
  const dyn = dynamicSkins.find((s) => s.id === id);
  if (dyn) return !!dyn.favicon;
  return false; // 未知 id：不猜，保持站点公共资源
}

export function applySkin(id: SkinId): void {
  try {
    localStorage.setItem(SKIN_KEY, id);
    localStorage.setItem(SKIN_VERSION_KEY, String(SKIN_VERSION));
    writeCookie(SKIN_KEY, id);
    writeCookie(SKIN_VERSION_KEY, String(SKIN_VERSION));
  } catch { /* 忽略 */ }
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.skin = id;
  // 氛围背景深浅：按当前皮肤取记忆值（默认：星空=0.72 需罩，其它=0）
  document.documentElement.style.setProperty('--skin-bg-wash', String(getStoredBgWash(id)));
  // 浏览器标签页图标 / iOS 主屏图标 / PWA manifest 随皮肤切换（均取该皮肤 hero 正方形的 app-icon）；
  // **没有自家资源的皮肤（default）不碰图标**（保持 index.html 的站点默认），manifest 回退公共那份
  const hasOwnIcons = skinHasOwnIcons(id);
  const manifest = document.querySelector('link[rel="manifest"]');
  if (hasOwnIcons) {
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) { icon.setAttribute('href', `/skins/${id}/app-icon-32.png?v=2`); icon.setAttribute('type', 'image/png'); }
    const apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (apple) apple.setAttribute('href', `/skins/${id}/app-icon-180.png?v=2`);
    if (manifest) manifest.setAttribute('href', `/skins/${id}/manifest.webmanifest?v=2`);
  } else if (manifest) {
    manifest.setAttribute('href', GLOBAL_MANIFEST_HREF);
  }
  // 浏览器标签栏/地址栏主题色随皮肤切换：取该皮肤 CSS 主色（--color-primary），
  // 未定义/动态皮肤回退品牌绿。data-skin 已在上方设置，故 computed 反映当前皮肤。
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', primary || DEFAULT_THEME_COLOR);
}

/* —— 白板卡片背景透明度（界面外观可调，默认=中度透明 0.8） —— */
export type CardBgAlpha = number;

/**
 * 默认「卡片不透明度」= **38%**（2026-09-15 用户要求"所有用户默认都设置成 38%"；原为 80%）。
 * ⚠️ 只改这个常量**不够**：`applyCardBgAlpha` 在挂载时会把当前值写进 localStorage，
 * 所以老用户（从没拖过滑块）的存档里早就是旧的 0.8 —— 必须靠下面的版本号做一次迁移。
 */
export const DEFAULT_CARD_BG_ALPHA: CardBgAlpha = 0.38;

/** 旧的默认值：存档**正好等于它**说明用户从没主动改过（只是被写入了默认值）→ 跟着新默认走 */
const LEGACY_DEFAULT_CARD_BG_ALPHA = 0.8;

const CARD_ALPHA_KEY = 'cure_card_bg_alpha';
/** 默认值变更版本：升到该版本时，把"还在用旧默认值/没存档"的用户迁到新默认值 */
const CARD_ALPHA_VERSION_KEY = 'cure_card_bg_alpha_version';
const CARD_ALPHA_VERSION = 2;

export function getStoredCardBgAlpha(): CardBgAlpha {
  try {
    const rawStr = localStorage.getItem(CARD_ALPHA_KEY);
    const ver = Number(localStorage.getItem(CARD_ALPHA_VERSION_KEY) || '0');
    // 注意：空串必须当“没存档”处理 —— Number('') === 0，否则会被当成合法值 → 卡片全透明
    const raw = rawStr == null || rawStr.trim() === '' ? null : Number(rawStr);
    const valid = raw != null && Number.isFinite(raw) && raw >= 0 && raw <= 1;
    if (ver < CARD_ALPHA_VERSION) {
      // 迁移：**只动"仍在使用旧默认值 / 没有存档"的用户**；用户自己拖过的值（≠0.8）原样保留
      if (valid && raw !== LEGACY_DEFAULT_CARD_BG_ALPHA) return raw as CardBgAlpha;
      return DEFAULT_CARD_BG_ALPHA;
    }
    if (valid) return raw as CardBgAlpha;
  } catch { /* 忽略 */ }
  return DEFAULT_CARD_BG_ALPHA;
}

export function applyCardBgAlpha(alpha: CardBgAlpha): void {
  try {
    localStorage.setItem(CARD_ALPHA_KEY, String(alpha));
    localStorage.setItem(CARD_ALPHA_VERSION_KEY, String(CARD_ALPHA_VERSION));
  } catch { /* 忽略 */ }
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--card-bg-alpha', String(alpha));
}

/* —— 氛围背景深浅（界面外观可调，对每套皮肤分别记忆）：0=背景图明显(深)，1=全浅(背景几乎不可见)；默认：星空=0.72(需罩)，其它=0 —— */
export type BgWash = number;

const bgWashKey = (id: SkinId) => `cure_skin_bg_wash_${id}`;

export function defaultBgWash(id: SkinId): BgWash {
  // ⚠️ 这两档必须与 index.html 首屏内联脚本里的 `washes` 表**逐字一致**——
  // 不一致的后果是首帧用脚本的值、React 挂载后跳到这里的值（背景光晕闪一下）。
  // 2026-09-18 顺手修：原来 candy 缺这一档（脚本 0.32 / 这里 0），
  // 当时 candy 不是默认皮肤所以少有人看到；现在它是新用户默认皮肤，必须对齐。
  if (id === 'star') return 0.72;
  if (id === 'candy') return 0.32;
  return 0;
}

export function getStoredBgWash(id: SkinId): BgWash {
  try {
    const raw = localStorage.getItem(bgWashKey(id));
    if (raw == null) return defaultBgWash(id);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  } catch { /* 忽略 */ }
  return defaultBgWash(id);
}

export function applyBgWash(wash: BgWash, id: SkinId): void {
  try { localStorage.setItem(bgWashKey(id), String(wash)); } catch { /* 忽略 */ }
  if (typeof document === 'undefined') return;
  const v = Math.min(1, Math.max(0, wash));
  document.documentElement.style.setProperty('--skin-bg-wash', String(v));
}
