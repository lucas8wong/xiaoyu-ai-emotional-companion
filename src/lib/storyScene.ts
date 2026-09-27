/**
 * 剧情「场景画面」主题解析与三层配图解析（docs/roleplay-immersion-plan.md §4.2 = S2 图库层）
 *
 * ⚠️ 为什么不能用文游那套：`src/wenyou/ui/nodeArt.ts` 的 NODE_THEMES 是**武侠/权谋语境**
 * （death/conflict/betray/scheme/glory/breakthrough…，匹配词是"死/战/杀/叛/谋/封赏/渡劫"），
 * 套到 30 个都市情感剧本上会大面积落到 mundane。本文件按**都市情感语境重做**主题表，
 * 并把「世界观」独立出来（同一主题在古风/现代/港风/校园/民国下视觉完全不同）。
 *
 * 三层解析（与文游同构，便于维护者对照）：
 *   ① 专属图 `{scenarioId}-{theme}.webp`（将来按剧本单独出，未命中即跳过）
 *   ② 主题池图 `{worldview}-{theme}.webp`（**共享**，跨剧本复用 —— 本轮生成的就是这一层）
 *   ③ 剧本封面/头像兜底
 *
 * 本文件是**纯函数**（无 DOM/无请求），便于单测；配图文件的生成见 `scripts/generate_scene_art.py`。
 */

// ============ 主题表（都市情感语境） ============

export interface SceneTheme {
  id: string;
  /** UI 展示名（中文，供调试/后台使用；用户界面不直接展示） */
  label: string;
  /** 命中关键词（先重后轻，按数组顺序匹配） */
  keywords: RegExp;
  /** 出图用的"白名单视觉要素"（**只写环境/道具/光线，不写人** —— 见方案 §4.4 红线） */
  scene: string;
  /**
   * **户外版**同一幕的要素（2026-09-15 新增）。
   *
   * 为什么必须分开：`scene` 里很多幕是**绑定室内**的（"a quiet bedroom at night" / "a modern office desk" /
   * "a lived-in kitchen"）。而 30 部剧本里有 **10 部是户外场景**（街景/码头/宫殿广场/校门…），
   * 拼出来就是**自相矛盾**的 prompt，例如实测：
   *   `a quiet bedroom at night, …, narrow city street at 3am, …, outdoor scene, 1990s Hong Kong interior, tiled walls…`
   * → 模型只能把"卧室和街景搅在一起"，出了一张**房间里横着一辆车头**的怪图（用户反馈"效果不是很好"的根因）。
   * 户外剧本改用它：不绑室内、仍然表达同一幕的情绪，且同样不含任何文字载体。
   */
  outdoorCue?: string;
}

export const SCENE_THEMES: SceneTheme[] = [
  // ⚠️ **数组顺序 = 匹配优先级**。两条踩过的纪律（都是回归测试抓出来的）：
  //   ① 具体场所/天气 > 情绪词 > 氛围词：`alone` 先匹配"走廊"会把"医院走廊"判成独处；
  //      `intimate` 先匹配"别走"会把「雨下大了，先别走」判成亲密而不是雨。
  //   ② 天气（rain）要比时段（night）早 —— "雨夜"应出雨景。
  // 最终顺序：危机 → 争执 → 场所(职场/医院) → 天气(雨) → 情绪幕 → 氛围幕(独处/夜色) → 日常
  { id: 'crisis', label: '危机', keywords: /危险|追捕|追兵|逃|绑架|威胁|受伤|流血|急救|失控|崩溃|昏倒|抢|报警|险/, scene: 'a dark apartment corridor at night, one flickering light, an overturned chair', outdoorCue: 'one flickering light overhead, long hard shadows' },
  { id: 'conflict', label: '争执', keywords: /争吵|吵|质问|冷声|摔|发火|怒|争执|吼|拍桌|误会|翻脸|对峙|不满/, scene: 'a living room in hard side light, a tilted chair, scattered papers', outdoorCue: 'scattered belongings on the ground, a knocked-over chair' },
  { id: 'work', label: '职场', keywords: /项目|合同|签字|谈判|开会|会议|公司|办公室|加班|晋升|辞职|面试|方案|汇报|业绩|预算|客户|老板|上司|助理|实习生|出差|邮件|钉钉|企划|报表/, scene: 'a modern office desk with documents, a laptop and a city view at dusk', outdoorCue: 'a leather briefcase set down, a folded coat over a railing' },
  { id: 'hospital', label: '医院', keywords: /医院|病房|急诊|手术|医生|护士|消毒水|输液|病床|检查报告|住院|产房|抑郁|药|康复/, scene: 'a quiet hospital corridor with pale light and empty chairs', outdoorCue: 'pale light, empty waiting chairs by a glass door' },
  { id: 'rain', label: '雨', keywords: /雨|淋湿|伞|潮湿|雷|倾盆|水汽|淅沥|湿透|雨声/, scene: 'rain on the window from inside, blurred lights beyond the glass', outdoorCue: 'rain streaks through the light, wet reflective ground, shallow puddles' },
  { id: 'intimate', label: '亲密', keywords: /吻|唇|怀里|靠在你|牵手|十指|额头抵|肩头|温热的呼吸|贴近|抱住不|亲了|手腕|拉住|别走|别离开|抱紧/, scene: 'a dim bedroom lit by one candle, soft textiles, amber glow', outdoorCue: 'dim warm light, sheer fabric stirring, close quiet atmosphere' },
  { id: 'reconcile', label: '和好', keywords: /和好|原谅|对不起|抱歉|道歉|软下来|释然|冰释|和解|别生气了|拉回|抱住|抱/, scene: 'a sunlit room, half-open curtains, two cups on a small table', outdoorCue: 'sun-warmed surfaces, two cups left on a low table' },
  { id: 'parting', label: '离别', keywords: /再见|别过|离开|送走|远走|背影|归去|散场|道别|最后一|走了以后|站台|机场/, scene: 'an entryway at dusk, a suitcase left by the door', outdoorCue: 'a suitcase standing by the kerb, long shadows' },
  { id: 'cold', label: '冷战', keywords: /沉默|不理|冷淡|疏离|僵住|冷漠|避开|没有回应|僵持|一句话也没|隔着一|生闷气/, scene: 'a bare room in grey light, one empty chair by a curtained window', outdoorCue: 'bare branches, grey even light, an empty bench' },
  { id: 'flutter', label: '心动', keywords: /心跳|心动|脸红|耳尖|紧张|喜欢你|害羞|不敢看|撩|暧昧|悸动|失了神/, scene: 'sheer curtains at an open window, warm afternoon light, a cup on the sill', outdoorCue: 'sheer fabric stirring in the breeze, warm afternoon light' },
  { id: 'meet', label: '相遇', keywords: /初见|第一次见|遇见|刚见|报到|敲门|敲开|推门进来|认出|久别|重逢/, scene: 'a quiet doorway with framed light, a table set for two', outdoorCue: 'framed light through a doorway, a table set for two' },
  { id: 'memory', label: '回忆', keywords: /回忆|想起|从前|小时候|当年|旧|曾经|照片|日记|记得那|那些年|旧事/, scene: 'a desk with faded photographs, old letters, dusty warm light', outdoorCue: 'faded prints and folded parchment on a weathered bench' },
  { id: 'promise', label: '承诺', keywords: /承诺|答应|戒指|结婚|余生|永远|约定|誓言|未来|一直陪着|不离/, scene: 'a small velvet box on a bedside table by candlelight, golden glow', outdoorCue: 'a small velvet box catching the light, warm golden glow' },
  { id: 'alone', label: '独处', keywords: /一个人|独自|空荡|孤单|走廊|天台|空房|没人|寂寞|无所事事|发呆/, scene: 'an empty apartment at night, a single lamp, long shadows, curtains half drawn', outdoorCue: 'empty ground, one lamp, long shadows' },
  // 注意口径：不写"城市天际线/远处楼宇"这类对象——实测它们会带出**楼顶招牌字母**（抽检两次命中"有文字"），
  // 改用"半掩窗帘 + 虚焦窗景"表达"夜"，从源头去掉会违规的对象类，而不是靠换 seed 抽奖。
  { id: 'night', label: '夜色', keywords: /夜|凌晨|深夜|霓虹|灯火|街灯|车流|月光|月亮|入夜|天黑了/, scene: 'a quiet bedroom at night, sheer curtains, soft lamplight, out-of-focus window', outdoorCue: 'deep night, pools of soft lamplight, out-of-focus distant lights' },
  { id: 'daily', label: '日常', keywords: /早餐|厨房|咖啡|上班|下班|加班|沙发|客厅|买菜|外卖|电视|猫|做饭|热水|房间/, scene: 'a lived-in kitchen in morning light, steam from a cup', outdoorCue: 'morning light, a steaming cup left on a step' },
];

/** 兜底主题（什么都没命中时） */
export const DEFAULT_THEME = 'daily';

/**
 * 「关键时刻」主题：情绪/剧情张力最高的几幕。
 * 只有这些幕才值得**自动**生成专属画面（其余幕用共享图库即可）——
 * 这是单卡保护与"物有所值"的双重考虑：自动出图要花 GPU 与额度。
 */
export const KEY_MOMENT_THEMES = ['crisis', 'intimate', 'promise', 'reconcile', 'parting'] as const;

export function isKeyMomentTheme(theme: string | undefined | null): boolean {
  return (KEY_MOMENT_THEMES as readonly string[]).includes(String(theme || ''));
}

/** 剧情文本 → 主题（按 SCENE_THEMES 顺序，先重后轻） */
export function themeOfText(text: string | undefined | null): string {
  return matchTheme(text) || DEFAULT_THEME;
}

/**
 * **明确命中的**主题（未命中返回 null）。
 * 用于「换幕」判定：不能在每句台词都掉回 daily，否则画面会一直闪；
 * 只有读到明确信号（雨/吻/吵/照片…）才换场景画。
 */
export function matchTheme(text: string | undefined | null): string | null {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const t of SCENE_THEMES) {
    if (t.keywords.test(s)) return t.id;
  }
  return null;
}

// ============ 世界观（视觉基调） ============

export interface SceneWorldview {
  id: string;
  label: string;
  /** 命中标签（任一命中即算） */
  tags: string[];
  /** 出图用的场景基调（同样是白名单要素：建筑/材质/时代，不写人） */
  setting: string;
  /** 户外版基调（户外剧本用它，避免"室内墙纸/瓷砖"把街景拽回屋里）—— 2026-09-15 新增 */
  settingOutdoor?: string;
}

export const SCENE_WORLDVIEWS: SceneWorldview[] = [
  // 顺序即优先级：republic 在前，使「世家 + 留洋」这类剧本落到民国洋房（而不是古风庭院）
  // ⚠️ 2026-09-14 二次复盘：世界观**只描述风格/时代/材质，绝不描述房间类型**。
  //    之前 modern 写的是 "a modern high-rise apartment interior, sheer curtains at the window"，
  //    与"地点=办案室"拼在一起 → 模型取"公寓+纱帘"那一半，把刑警剧本画成了暖阳居家书房（用户实测反馈）。
  { id: 'republic', label: '民国洋房', setting: '1930s republican-era interior, wooden floor, lace curtains, brass details', settingOutdoor: '1930s republican-era street, wooden facades, worn paving, dusty light', tags: ['留洋'] },
  // ⚠️ 2026-09-14 云化实测修正：原文是 `... metal window frames, neon glow`，
  //    而 **`neon` 会稳定带出霓虹招牌上的字母**——SDXL 画不出字所以蒙混过关，
  //    换成云模型（万相）后 8/8 张被红线抽检拒（"霓虹招牌 'NICGHIT CLUB'"）。
  //    港风的气质靠"瓷砖墙 + 铁窗框 + 百叶窗漏进来的街灯"表达，**不靠霓虹**。
  { id: 'hk', label: '港风', setting: '1990s Hong Kong interior, tiled walls, metal window frames, street light through blinds', settingOutdoor: '1990s Hong Kong street, tiled facades, metal window frames, warm street light', tags: ['港圈年上', '粤语情话'] },
  { id: 'campus', label: '校园', setting: 'youthful school interior, painted walls, bright daylight', settingOutdoor: 'school campus exterior, brick and glass buildings, bright daylight', tags: ['校园', '私立美高', '纯情学妹', '橄榄球队长', '粘人学长', '大金毛'] },
  { id: 'ancient', label: '古风', setting: 'traditional Chinese interior, carved wooden lattice windows, silk, porcelain', settingOutdoor: 'traditional Chinese architecture, timber and stone, pale grey sky', tags: ['古代架空', '宫廷', '世家', '替嫁', '帝王', '君臣', '首辅', '才子', '和亲', '草原王子', '病弱公主', '暴君', '废后', '世子', '痴傻皇后', '偏执帝王', '世家世子'] },
  { id: 'modern', label: '现代都市', setting: 'contemporary interior, floor-to-ceiling glass, neutral materials, city light', settingOutdoor: 'contemporary city exterior, glass and concrete, overcast daylight', tags: [] },
];

export const DEFAULT_WORLDVIEW = 'modern';

/** 剧本 → 世界观（按标签；未命中 = 现代都市） */
export function worldviewOf(s: { tags?: string[] }): string {
  const tags = (s.tags || []).map(String);
  for (const w of SCENE_WORLDVIEWS) {
    if (w.tags.some(t => tags.includes(t))) return w.id;
  }
  return DEFAULT_WORLDVIEW;
}

/**
 * 出图风格/约束前缀（**必须放在 prompt 最前面**）
 *
 * ⚠️ 三条实测教训（都是踩过才知道的）：
 * 1. SDXL 的 CLIP 文本编码上限是 **77 token**，超长会被**静默截断**（diffusers 只打一行警告）。
 *    故：**约束前置 + 整体压缩到 77 token 以内**（见 scenePrompt、以及单测里的长度守卫）。
 * 2. turbo 模型 guidance_scale=0（无 CFG）时 negative_prompt 不生效 → 只能靠正向约束 + 出图后抽检重试。
 * 3. **不要把色调写死**：早先统一用 "warm palette"，结果"刑警办案室"被染成暖阳居家（用户实测反馈）。
 *    色调改为按**冷热分档**（见 `moodOf`），由调用方拼进来。
 */
export const SCENE_STYLE_BASE = 'interior scene, no people, no text, soft cinematic illustration';

/** 冷/暖/中性三档（决定光线与色调，避免"什么场景都暖阳"） */
export type SceneMood = 'cool' | 'warm' | 'neutral';

export const SCENE_MOOD_PHRASE: Record<SceneMood, string> = {
  cool: 'cool muted palette, low-key lighting, quiet tension',
  neutral: 'neutral palette, soft daylight',
  warm: 'warm palette, soft lamplight',
};

/** 冷场景：办案/医院/危机/冷战/争执/独处/夜 */
const COOL_PLACES = ['police', 'hospital'];
const COOL_THEMES = ['crisis', 'conflict', 'cold', 'alone', 'night'];
/** 暖场景：家/亲密/承诺/和好/回忆/心动/日常 */
const WARM_PLACES = ['home', 'chamber'];
const WARM_THEMES = ['intimate', 'promise', 'reconcile', 'memory', 'flutter', 'daily'];

/** 「这一刻的光」：地点优先，其次主题；都不算冷/暖则中性 */
export function moodOf(input: { place?: string | null; theme?: string | null }): SceneMood {
  const p = String(input.place || '');
  const t = String(input.theme || '');
  if (COOL_PLACES.includes(p) || COOL_THEMES.includes(t)) return 'cool';
  if (WARM_PLACES.includes(p) || WARM_THEMES.includes(t)) return 'warm';
  return 'neutral';
}

/** 兼容旧名（测试与文档里引用过） */
export const SCENE_STYLE_SUFFIX = SCENE_STYLE_BASE + ', ' + SCENE_MOOD_PHRASE.neutral;

/** 不含室内/室外的约束部分（供"依据剧本推导的场景"复用：那种场景可能是户外） */
export const SCENE_CONSTRAINTS = 'no people, no text, soft cinematic illustration';

/**
 * 「依据剧本叙事文本推导出的场景规格」拼 prompt（2026-09-14 架构修正）。
 *
 * 用于**内置剧本的主场景图**：场景内容来自 `scripts/derive_scene_specs.mts` 依据
 * 剧本的 background / openingScene / openingAssistant 推导出的 `scene`（已过红线校验），
 * 而不是靠标签猜地点。户外场景（凶案现场/街边/码头）**不再被硬塞成"室内"**。
 */
export interface StorySceneSpecLike {
  scene: string;
  mood?: SceneMood;
  indoor?: boolean;
  /** 地点 id（`SCENE_PLACES`；来自 `scripts/scene-story-specs.json`），仅用于冷暖分档 */
  place?: string | null;
}

/**
 * 把"依据剧本推导出来的场景描述"收进词数预算（**防 CLIP 77 token 静默截断**）。
 * 从**末尾按逗号边界**裁剪：SDXL 前段 token 权重更高，保住前面的要素比保住后面的重要。
 */
export function clampSceneWords(scene: string, maxWords = 26): string {
  const s = String(scene || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ').length;
  if (words <= maxWords) return s;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const out: string[] = [];
  let n = 0;
  for (const p of parts) {
    const w = p.split(' ').length;
    if (n + w > maxWords && out.length > 0) break;
    out.push(p);
    n += w;
  }
  if (out.length === 0) return s.split(' ').slice(0, maxWords).join(' ');
  return out.join(', ');
}

export function storyScenePrompt(spec: StorySceneSpecLike): string {
  const where = spec.indoor === false ? 'outdoor scene' : 'interior scene';
  const mood = SCENE_MOOD_PHRASE[(spec.mood || 'neutral') as SceneMood] || SCENE_MOOD_PHRASE.neutral;
  // 内容打头（见上方 scenePrompt 的说明）：约束交给负向词
  return [clampSceneWords(deTextTriggers(spec.scene)), mood, where].filter(Boolean).join(', ');
}

/**
 * 「每部剧本 × 每一幕」的专属画面 prompt（2026 云化新增，对应 C 方案：30 剧本 × 16 幕 = 480 张）。
 *
 * 为什么不能直接复用 `scenePrompt(worldview, theme)`：30 部剧本里有 18 部落到 `modern` 世界观，
 * 那样同一主题会拼出**完全一样**的 prompt → 出 18 张一模一样的图，白花钱。
 * 本函数把**这部剧本自己的空间**（`storyScenePrompt` 用的那份、由剧本叙事文本推导的场景规格）
 * 与**这一幕的要素**拼在一起：`医院病房` + `雨` 才是"这部剧本下雨那一幕"。
 *
 * token 预算：剧本自己的空间压到 18 词（`clampSceneWords`），避免把它挤掉主题要素。
 */
export function ownThemePrompt(
  spec: StorySceneSpecLike | null | undefined,
  worldviewId: string,
  themeId: string,
): string {
  const w = SCENE_WORLDVIEWS.find(x => x.id === worldviewId) || SCENE_WORLDVIEWS[SCENE_WORLDVIEWS.length - 1];
  const t = SCENE_THEMES.find(x => x.id === themeId);
  const mood = SCENE_MOOD_PHRASE[moodOf({ place: spec?.place, theme: themeId })] || SCENE_MOOD_PHRASE.neutral;
  const outdoor = spec?.indoor === false;
  const where = outdoor ? 'outdoor scene' : 'interior scene';
  const own = clampSceneWords(deTextTriggers(spec?.scene), 18);
  if (outdoor) {
    // 🔴 户外剧本（30 部里 10 部）：**剧本自己的空间打头**（它才是权威地点），这一幕改用 `outdoorCue`
    //    （不绑室内），世界观基调也换 `settingOutdoor` —— 三条一起消除"卧室 + 街景 + 户外 + 港风室内墙纸"
    //    的四重矛盾（用户实测反馈"背景图效果不是很好"的根因）。见 `SceneTheme.outdoorCue` 注释。
    return [own, t?.outdoorCue || deTextTriggers(t?.scene), mood, where, deTextTriggers(w.settingOutdoor || '')]
      .filter(Boolean).join(', ');
  }
  return [deTextTriggers(t?.scene), own, mood, where, deTextTriggers(w.setting)].filter(Boolean).join(', ');
}

/** 负向词（CFG>1 的模型才有效）：红线与常见崩坏一次挡掉 */
export const SCENE_NEGATIVE_PROMPT = [
  'people', 'person', 'human', 'face', 'faces', 'hands', 'body', 'crowd', 'crowd of people', 'silhouette of a person',
  'text', 'letters', 'words', 'signage', 'signboard', 'watermark', 'signature', 'logo', 'poster',
  // ⚠️ 2026-09-14 云化实测追加：只写 `text/letters/signage` **挡不住**云模型（万相 8/8 张照旧画出
  //    "霓虹招牌 'NICGHIT CLUB'"）。把**会带出字的对象类**逐个点名，是唯一有效的写法。
  'neon sign', 'neon letters', 'neon signboard', 'shop sign', 'storefront sign', 'street sign', 'billboard',
  'banner', 'graffiti', 'chinese characters', 'kanji', 'hiragana', 'alphabet', 'brand name', 'price tag',
  'menu board', 'book cover', 'newspaper headline', 'poster text', 'screen text',
  // ⚠️ 2026-09-15 追加：夜街剧本实测反复出现"店铺招牌上带模糊文字"（5/17），
  //    点名**模糊也不许**、以及店面类载体：
  'blurred letters', 'illegible text', 'faint lettering', 'awning lettering', 'shopfront lettering',
  'storefront signboard', 'shop window lettering', 'facade signage', 'window sticker', 'address plate',
  // ⚠️ 2026-09-15 追加：**车牌**——实测 `guyushen-songzhi-intimate` 被判"车牌上隐约可见字母数字"。
  //    车是剧情必需的（"那辆熟悉的车停在路边"），所以只能禁掉车牌本身（它天生带字符）。
  'license plate', 'number plate', 'car plate', 'registration plate', 'plate with letters', 'plate with numbers',
  'blood', 'corpse', 'weapon', 'gun', 'knife',
  'blurry', 'low quality', 'deformed', 'cluttered', 'oversaturated',
].join(', ');

/**
 * 「会带出文字的对象类」→ 无字替身。
 *
 * 为什么需要这一层（而不是只靠负向词）：项目自己的两条实测教训
 * （见文件上方主题表注释与 `scripts/export-scene-config.mts` 的 `SCENE_SPEC_OVERRIDES`）
 * 都指向同一个结论：**要从源头去掉会违规的对象类，而不是靠换 seed 抽奖**。
 * 负向词是"求它别画"，这里是"根本没给它可画的字"——两道一起上。
 *
 * ⚠️ 只改**视觉对象**，不改语气/冷暖/地点（否则画面会跑偏）。
 */
export const SCENE_TEXT_TRIGGERS: Array<[RegExp, string]> = [
  // 复合词先处理（neon-lit / neon glow / neon reflections / neon signs…）
  [/\bneon[\s-]*(lit|light|lights|glow|reflections?|signs?|tubes?|lights?\s*glow)?\b/gi, 'warm street light'],
  [/\bnightclub\b/gi, 'a plain lit doorway'],
  [/\bclosed storefronts?\b/gi, 'shuttered fronts'],
  [/\bstorefronts?\b/gi, 'shuttered fronts'],
  [/\bshopfronts?\b/gi, 'shuttered fronts'],
  [/\bshopping bags?\b/gi, 'cloth tote bags'],
  [/\bbillboards?\b/gi, 'blank panels'],
  [/\bsignage\b/gi, 'plain panels'],
  [/\bposters?\b/gi, 'plain sheets'],
  [/\bbanners?\b/gi, 'cloth strips'],
  [/\blogos?\b/gi, 'plain markings'],
  [/\bmenu boards?\b/gi, 'plain slate'],
  [/\bmenus?\b/gi, 'plain slate'],
  [/\bfacades?\s+with\s+(signs?|lettering|neon)\b/gi, 'plain walls'],
  [/\bcity night skyline\b/gi, 'distant unlit buildings'],
  [/\bcity skyline\b/gi, 'distant unlit buildings'],
  [/\bneon\b/gi, 'warm light'],
  // ⚠️ 2026-09-14 **全库红线复核**新增（12 张违规里 **11 张**都是这一类）：**纸张类对象会稳定带出文字**。
  //    实测原文："夜晚街边窗台上摊开的**旧书与报纸**"、"茶几上放着蜡烛和**翻开杂志**"、
  //    "地面散落着**带文字的文件纸张**"、"一叠**印有文字的纸张**"、"桌上摊开**一本有文字的书**"。
  //    ⚠️ 替换词本身**不能含触发词**（曾把 books 换成 "closed plain book" → 门禁自己锁死自己）
  //    —— 有单测 `替换词自身不含触发词` 守着这条。
  [/\bold letters?\b/gi, 'blank folded parchment'],
  [/\bletters?\b/gi, 'blank parchment'],
  [/\bnewspapers?\b/gi, 'folded blank parchment'],
  [/\bdocuments?\b/gi, 'plain folders'],
  [/\bcase files?\b/gi, 'plain storage boxes'],
  [/\bfiles\b/gi, 'plain folders'],
  [/\bmagazines?\b/gi, 'closed plain journal'],
  [/\bnotebooks?\b/gi, 'closed plain journal'],
  [/\bbooks?\b/gi, 'closed hardbound volume'],
  [/\bphotographs?\b/gi, 'blank faded prints'],
  [/\bphotos?\b/gi, 'blank faded prints'],
  [/\bpapers?\b/gi, 'blank sheets'],
  [/\breceipts?\b/gi, 'blank slips'],
  [/囍|双喜|double happiness/gi, 'plain red felt cutout'],
];

/** 把"会带出文字的对象类"替换成无字替身（幂等；空串原样返回） */
export function deTextTriggers(scene: string | null | undefined): string {
  let s = String(scene || '');
  if (!s.trim()) return s;
  for (const [re, to] of SCENE_TEXT_TRIGGERS) s = s.replace(re, to);
  return s.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

/** 这段描述里还有没有"文字触发词"（跑批前的体检用；出图流水线会断言的正是它） */
export function hasTextTrigger(scene: string | null | undefined): boolean {
  const s = String(scene || '');
  return SCENE_TEXT_TRIGGERS.some(([re]) => new RegExp(re.source, 'i').test(s));
}

/**
 * 户外场景额外压制的负向词：**实测 turbo/base 都会把"街道"画成室内客厅**（用户截图就是这种情况），
 * 所以户外的负向词里补上室内房间名，从两端夹住。
 */
export const SCENE_OUTDOOR_NEGATIVE_EXTRA = 'indoor, interior room, living room, bedroom, office room, dining table';

/** 按规格给出该图的完整负向词 */
export function negativePromptFor(spec: StorySceneSpecLike | null | undefined): string {
  if (!spec) return SCENE_NEGATIVE_PROMPT;
  const outdoor = spec.indoor === false;
  return outdoor ? SCENE_NEGATIVE_PROMPT + ', ' + SCENE_OUTDOOR_NEGATIVE_EXTRA : SCENE_NEGATIVE_PROMPT;
}

/** 拼约束前缀 + 色调 */
function _stylePrefix(mood: SceneMood): string {
  return SCENE_STYLE_BASE + ', ' + SCENE_MOOD_PHRASE[mood];
}

/**
 * 拼出图 prompt（**内容打头**版，2026-09-14 换用 SDXL base 后）。
 *
 * 为什么改：SDXL 对**前段 token 权重最高**。此前把 `interior scene, no people, no text, soft cinematic illustration`
 * 放在最前面（为了防人物/文字），结果把真正的场景内容挤到中段 → "输液架""花轿"这类具体器物画不出来。
 * 换用支持 CFG 的模型后，**约束改为交给负向词**（`NEGATIVE_PROMPT`），正面 prompt 让场景内容打头。
 */
export function scenePrompt(worldviewId: string, themeId: string): string {
  const w = SCENE_WORLDVIEWS.find(x => x.id === worldviewId) || SCENE_WORLDVIEWS[SCENE_WORLDVIEWS.length - 1];
  const t = SCENE_THEMES.find(x => x.id === themeId);
  const mood = moodOf({ theme: themeId });
  // 三层都过 deTextTriggers：主题要素 / 世界观基调（世界观是"文字污染"的主要入口，
  // 例如港风原来的 `neon glow`）——见 SCENE_TEXT_TRIGGERS 上方说明。
  return [deTextTriggers(t?.scene), SCENE_MOOD_PHRASE[mood], 'interior scene', deTextTriggers(w.setting)].filter(Boolean).join(', ');
}

// ============ 地点：每部剧本的「主场景」（A 方案） ============

/**
 * 为什么需要"地点"这一维：
 * 实测 30 部真实剧本里 **18 部**都落到 `modern` 世界观 → 共用同一批"高层公寓内景"，
 * 于是用户看到的就是"跟剧情没啥关系"的通用图。
 * 地点按剧本标签再分一档（办公室/家/医院/校园/古代内室/办案），
 * 于是**同一世界观下的不同剧本也各有自己的空间**（总裁剧是办公室、医生剧是病房、校园剧是宿舍）。
 */
export interface ScenePlace {
  id: string;
  label: string;
  tags: string[];
  /** 白名单视觉要素（同主题口径：只写环境/道具/光线，不写人） */
  scene: string;
}

export const SCENE_PLACES: ScenePlace[] = [
  // ⚠️ 只放**真·办案**标签：最初把"掌控欲/强制/双重身份/猫鼠游戏"也算进来，
  //    结果古风剧本被分到"办案室"（还带白板）——那些是**语气标签不是地点标签**，已剔除。
  // ⚠️ 二次复盘：'a dim case room with files and a desk lamp' 这种**模糊概念**SDXL-Turbo 画不出来
  //    （实测画成"暖黄夕照的样板间书房"）。改为**具体物件 + 明确的夜/百叶窗/卷宗**。
  //    实测三轮后取此版：冷白荧光灯 + 百叶窗 + 满架卷宗/文件堆（feel 由"暖"变"中性"）。
  //    已知限度：**机构性道具（证据板/警徽）4 步 turbo 画不出来**——试过 "corkboard + red string"，
  //    反而被理解成"地上的红电线"更差。要更强的场景语义需要换模型（见 CHANGELOG 的后续建议）。
  { id: 'police', label: '办案室', tags: ['刑警', '法医', '办案', '侦探'], scene: 'a dim police office at night, an evidence board pinned with photos, stacks of case files, filing cabinets, a desk lamp, blinds drawn' },
  { id: 'hospital', label: '医院', tags: ['温柔女医生', '医患', '病房', '产后抑郁', '狂躁症'], scene: 'a hospital room with pale light, a neat bed and a tall window' },
  { id: 'campus', label: '校园房间', tags: ['校园', '私立美高', '纯情学妹', '橄榄球队长', '粘人学长', '大金毛', '毕业'], scene: 'a student room with desks, books and bright daylight' },
  { id: 'office', label: '办公室', tags: ['总裁', '财阀少爷', '女霸总', '娱乐圈', '金主', '办公室', '实习生', '外卖', '洁癖', '女律师', '记者', '网络小说作者', '经纪人', '助理', '家教', '毒舌', '乌龙电话'], scene: 'a corner office with a glass wall, a desk with documents and a city view' },
  { id: 'chamber', label: '古宅内室', tags: ['古代架空', '宫廷', '帝王', '痴傻皇后', '废后', '世子', '首辅', '才子', '暴君', '和亲', '草原王子', '世家', '替嫁', '主奴', '君臣', '青梅竹马', '新婚', '虐恋', '复仇'], scene: 'a traditional chamber with a wooden desk, silk screens and an incense burner' },
  { id: 'home', label: '家里', tags: [], scene: 'a small city apartment living room with a sofa and warm lamplight' },
];

export const DEFAULT_PLACE = 'home';

/**
 * 地点 × 世界观裁剪：避免出现"古风 + 带白板的办案室"这类穿帮。
 * 世界观不在表里 = 不限制（现代/港风什么地点都成立）。
 */
export const PLACES_BY_WORLDVIEW: Record<string, string[] | undefined> = {
  ancient: ['chamber', 'home'],
  republic: ['chamber', 'home', 'office'],
  campus: ['campus', 'home', 'hospital'],
};

/** 剧本 → 地点（标签命中 → 世界观裁剪 → 兜底"家里"） */
export function placeOf(s: { tags?: string[] } | null | undefined): string {
  const tags = ((s?.tags) || []).map(String);
  let place = DEFAULT_PLACE;
  for (const p of SCENE_PLACES) {
    if (p.tags.some(t => tags.includes(t))) { place = p.id; break; }
  }
  const allowed = PLACES_BY_WORLDVIEW[worldviewOf({ tags })];
  if (allowed && !allowed.includes(place)) return allowed[0];
  return place;
}

/** 主场景图路径（每部内置剧本一张，离线跑批生成） —— 见上方 `masterSceneUrl`（带版本号） */

/** 主场景图 prompt（同样：约束 → 具体地点 → 冷暖/光线 → 世界观风格） */
export function masterScenePrompt(worldviewId: string, placeId: string): string {
  const w = SCENE_WORLDVIEWS.find(x => x.id === worldviewId) || SCENE_WORLDVIEWS[SCENE_WORLDVIEWS.length - 1];
  const p = SCENE_PLACES.find(x => x.id === placeId) || SCENE_PLACES[SCENE_PLACES.length - 1];
  const mood = moodOf({ place: placeId });
  return [SCENE_STYLE_BASE, deTextTriggers(p.scene), SCENE_MOOD_PHRASE[mood], deTextTriggers(w.setting)].filter(Boolean).join(', ');
}

// ============ 三层配图解析 ============

/**
 * 场景图**版本号**（破缓存用）。
 *
 * ⚠️ 实测踩过的大坑：这批图由 Express 静态服务，响应头是 `Cache-Control: public, max-age=604800`（**7 天**），
 * 而文件名不变（`{剧本}-master.webp`）→ **重新出图后，浏览器与 CDN 会继续给旧图最长 7 天**。
 * 用户就是这样看到"旧版客厅"的（磁盘上早已是新图）。故所有场景图 URL 一律带 `?v=`：
 * - 服务端给出的路径（主场景图 / 专属画面）用**文件 mtime** 自动版本化，出图即失效；
 * - 客户端拼的主题池路径用下面这个**常量**（每次重跑图库时手动 bump 一次）。
 */
export const SCENE_ART_VERSION = '2026-09-14h';

/** 给场景图 URL 加版本参数（已有 query 则用 & 追加） */
export function withSceneVersion(url: string, v: string = SCENE_ART_VERSION): string {
  if (!url) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(v);
}

/** 主题池图路径（离线跑批生成） */
export const scenePoolUrl = (worldviewId: string, themeId: string): string =>
  withSceneVersion(`/img/roleplay-scenes/${worldviewId}-${themeId}.webp`);

/** 剧本专属图路径（按需/Pro 自动生成；`{scenarioId}-{theme}`） */
export const sceneOwnUrl = (scenarioId: string, themeId: string): string =>
  withSceneVersion(`/img/roleplay-scenes/${scenarioId}-${themeId}.webp`);

/** 主场景图路径（每部内置剧本一张，离线跑批生成） */
export const masterSceneUrl = (scenarioId: string): string =>
  withSceneVersion(`/img/roleplay-scenes/${scenarioId}-master.webp`);

export type SceneLayer = 'own-theme' | 'master' | 'pool-theme' | 'pool-daily' | 'none';

export interface SceneResolution {
  url: string;
  theme: string | null;
  worldview: string;
  place: string;
  layer: SceneLayer;
}

/**
 * 配图优先级（2026-09-14 复盘后重定，解决"跟剧情没关系"）：
 *   ① **专属画面** `{剧本}-{幕}`（这部剧本·这一幕，按需/Pro 自动生成）
 *   ② **主场景图** `{剧本}-master`（这部剧本自己的空间，离线跑批；**换幕只靠氛围层做调色/光效**）
 *   ③ 共享主题池 `{世界观}-{幕}`（自建剧本 / 未出主场景图时）
 *   ④ 共享兜底 `{世界观}-daily`
 * ② 优先于 ③ 是关键：让"整部剧发生在一个属于它的空间里"，而不是每换一幕就跳到另一个通用房间。
 */
export function sceneUrlFor(
  scenario: { id: string; tags?: string[] } | null | undefined,
  theme: string | null,
  opts: { ownTheme?: boolean; master?: boolean } = {},
): SceneResolution {
  if (!scenario) return { url: '', theme: null, worldview: DEFAULT_WORLDVIEW, place: DEFAULT_PLACE, layer: 'none' };
  const worldview = worldviewOf(scenario);
  const place = placeOf(scenario);
  if (theme && opts.ownTheme) {
    return { url: sceneOwnUrl(scenario.id, theme), theme, worldview, place, layer: 'own-theme' };
  }
  if (opts.master) {
    return { url: masterSceneUrl(scenario.id), theme, worldview, place, layer: 'master' };
  }
  if (theme) return { url: scenePoolUrl(worldview, theme), theme, worldview, place, layer: 'pool-theme' };
  return { url: scenePoolUrl(worldview, DEFAULT_THEME), theme: null, worldview, place, layer: 'pool-daily' };
}

/**
 * 旧口径的便捷封装（用文本直接解析；保留给单测与"有无图可放"的判断）。
 * `availableOwn`：已知已生成的专属图 key 集合（`{scenarioId}-{theme}`），避免为了探测而发 404。
 */
export function sceneImageFor(
  s: { id: string; tags?: string[] } | null | undefined,
  text: string | undefined | null,
  availableOwn?: Set<string> | string[],
): SceneResolution {
  if (!s) return { url: '', theme: null, worldview: DEFAULT_WORLDVIEW, place: DEFAULT_PLACE, layer: 'none' };
  const theme = matchTheme(text);
  const ownKey = theme ? `${s.id}-${theme}` : '';
  const ownHit = !!theme && (Array.isArray(availableOwn) ? availableOwn.includes(ownKey) : !!availableOwn?.has?.(ownKey));
  return sceneUrlFor(s, theme, { ownTheme: ownHit });
}

/** 某剧本可用的主题池图（用于进入剧情时**预热**，命中缓存后换幕不迟到） */
export function poolUrlsFor(s: { tags?: string[] } | null | undefined): string[] {
  if (!s) return [];
  const worldview = worldviewOf(s);
  return SCENE_THEMES.map(t => scenePoolUrl(worldview, t.id));
}

/** 生成用的组合清单（脚本与文档共用；测试用它保证不重不漏） */
export function sceneArtMatrix(): Array<{ worldview: string; theme: string; file: string }> {
  const out: Array<{ worldview: string; theme: string; file: string }> = [];
  for (const w of SCENE_WORLDVIEWS) {
    for (const t of SCENE_THEMES) {
      out.push({ worldview: w.id, theme: t.id, file: `${w.id}-${t.id}.webp` });
    }
  }
  return out;
}
