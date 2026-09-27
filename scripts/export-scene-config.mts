/**
 * 导出「场景配图」配置给 Python 出图脚本（单一事实来源 = src/lib/storyScene.ts）
 *
 * 为什么要这一步：主题表/世界观/prompt 拼接规则只应存在于一处（TS 里，能被前端与单测复用），
 * Python 脚本不该再抄一份（抄两份必然漂移）。故由本脚本把 TS 的定义导出成 JSON：
 *   npx tsx scripts/export-scene-config.mts            # 写 temp/scene-config.json
 *   python scripts/generate_scene_art.py --config temp/scene-config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENE_THEMES,
  SCENE_WORLDVIEWS,
  SCENE_PLACES,
  SCENE_STYLE_SUFFIX,
  scenePrompt,
  sceneArtMatrix,
  masterScenePrompt,
  storyScenePrompt,
  ownThemePrompt,
  negativePromptFor,
  worldviewOf,
  placeOf,
} from '../src/lib/storyScene.js';
import { listScenarios, getScenarioInfo } from '../api/services/roleplay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'temp', 'scene-config.json');
fs.mkdirSync(path.dirname(out), { recursive: true });

/**
 * 主场景图（A 方案）的**场景来源**（2026-09-14 用户反馈后修正）：
 *   ① **依据剧本叙事文本推导的场景规格**（`scripts/scene-story-specs.json`，由 derive_scene_specs.mts 生成，
 *      已过"无人物/无文字/无血腥"红线校验）——**首选**，因为画面就该来自剧本自己的故事与场景；
 *   ② 标签规则（地点 × 世界观）——仅当没有可用规格时兜底。
 * ⚠️ 只给**内置剧本**出图（自建剧本的文案是用户内容，不进任何模型/提示词）。
 */
/**
 * 人工覆盖（**视觉复检发现的具体偏差**，2026-09-14）：
 * 以"依据剧本推导的场景"为基准，补上**剧本里有、但模型没画出来**的关键器物/风格。
 * 只改 `scene`（画面描述）；剧本依据 `basis` 保持原样，便于人工审阅谁改了什么。
 * 为什么需要：4 步 turbo 对"特定建筑/器物类型"的理解有限——"病房"会画成卧室、"中式宫廊"会画成西式柱廊，
 * 把**具体器物**写进 prompt 才能纠回来（这也是本轮实测出来的规律）。
 */
const SCENE_SPEC_OVERRIDES: Record<string, string> = {
  // 「清晨的医院病房」被画成"卧室" → 补明确的医院器物
  'linjianwei-chenyi': 'hospital ward, hospital bed with white sheets, IV drip stand, bedside monitor, pale blue curtain, tall window, early morning light',
  // 「冷清皇后宫廊下」被画成"西式柱廊" → 补中式宫苑特征
  'xiaoyan-chisha': 'vermilion red wooden pillars, yellow glazed roof tiles, carved wooden eaves, worn stone steps, withered chrysanthemums, faint mist, cold grey light',
  // 「古代洞房喜房」出现西式台灯/枝形吊灯 → 收敛为中式喜房要素
  'peixiuyuan-linwantang': 'chinese bridal chamber, carved wooden bed with red canopy, red paper double happiness on the wall, red candles, silk drapes, dim warm candlelight',
  // 🔴 红线修订：这两部的画面里出现了**文字**（警戒线上的印刷字、霓虹招牌字母）
  //    经验：`cordon tape`/`neon glow` 这类词会稳定带出文字 → 换成不含字母暗示的表述
  'lutingyuan-shenyan': 'wet asphalt road at dusk, plain yellow tape strips strung between poles, shallow puddles reflecting grey sky, muddy ground, scattered wet leaves, faint mist',
  'luwang-guxiaoman': 'rain-soaked city street at night, blurred warm and cold light reflections, mirrored puddles along the kerb, one lone street lamp, dark distant buildings, drizzle',
  // 🔴 红线修订（2026-09-15 全库复核）：`neon-lit nightclub facade` **稳定带出店铺招牌文字**
  //    —— 该剧本 5/17 张被判"招牌上带有模糊文字"。夜生活街景天然吸引招牌，所以**改源头数据**：
  //    换成"瓷砖墙上一个朴素亮着灯的门口"，保住剧情要的"她迈出门口、车停在路边"的空间感，
  //    但不再给模型任何可画的字。（与上面两条同一套做法：改数据 > 堆替换规则）
  'guyushen-songzhi': 'narrow city street at 3am, a plain lit doorway in a tiled wall, wet asphalt, parked black sedan, one warm street lamp, faint haze, cool blue shadows',
};

const specFile = path.join(ROOT, 'scripts', 'scene-story-specs.json');
const specs = new Map<string, { scene: string; mood: 'cool' | 'warm' | 'neutral'; indoor: boolean; valid: boolean; place: string; basis: string }>();
if (fs.existsSync(specFile)) {
  const parsed = JSON.parse(fs.readFileSync(specFile, 'utf8')) as { items?: Array<{ scenarioId: string; scene: string; mood: 'cool' | 'warm' | 'neutral'; indoor: boolean; valid: boolean; place: string; basis: string }> };
  for (const it of parsed.items || []) specs.set(it.scenarioId, it);
}
const builtins = listScenarios('zh').map((s) => {
  const info = getScenarioInfo(s.id, 'zh') as { tags?: string[] } | null;
  const tags = Array.isArray(info?.tags) ? info!.tags! : [];
  const wv = worldviewOf({ tags });
  const place = placeOf({ tags });
  const spec = specs.get(s.id);
  const useSpec = !!spec && spec.valid && !!spec.scene;
  const override = SCENE_SPEC_OVERRIDES[s.id];
  // 这部剧本「自己的空间」（画面描述已含人工覆盖修正）——主场景图与「每剧本每幕专属图」共用同一份
  const storySpec = useSpec
    ? { scene: override || spec!.scene, mood: spec!.mood, indoor: spec!.indoor, place: spec!.place }
    : null;
  return {
    scenarioId: s.id,
    tags,
    worldview: wv,
    place: useSpec ? spec!.place : place,
    source: useSpec ? (override ? 'story-spec+override' : 'story-spec') : 'place-fallback',
    basis: useSpec ? spec!.basis : '',
    file: `${s.id}-master.webp`,
    storySpec,
    prompt: storySpec
      ? storyScenePrompt(storySpec)
      : masterScenePrompt(wv, place),
    // 兜底 prompt：依据剧本推导的场景若反复带出文字（实测 `chenboyuan-qingxing` 的街景+车总被画出招牌），
    // 退到**标签规则**那一版（地点×世界观，表述更朴素）——与专属图的 `theme-fallback` 同一套思路。
    safePrompt: masterScenePrompt(wv, place),
    negative: useSpec
      ? negativePromptFor({ scene: spec!.scene, mood: spec!.mood, indoor: spec!.indoor })
      : negativePromptFor(null),
  };
});

const config = {
  styleSuffix: SCENE_STYLE_SUFFIX,
  worldviews: SCENE_WORLDVIEWS.map(w => ({ id: w.id, label: w.label, setting: w.setting })),
  themes: SCENE_THEMES.map(t => ({ id: t.id, label: t.label, scene: t.scene })),
  places: SCENE_PLACES.map(p => ({ id: p.id, label: p.label, scene: p.scene })),
  // 共享主题池（世界观 × 主题）
  matrix: sceneArtMatrix().map(row => ({
    worldview: row.worldview,
    theme: row.theme,
    file: row.file,
    prompt: scenePrompt(row.worldview, row.theme),
    negative: negativePromptFor(null),
  })),
  // 每部内置剧本一张主场景图
  masters: builtins,
  /**
   * 每部剧本 × 每一幕的**专属图**（C 方案：30 × 16 = 480 张）。
   * 与共享主题池的区别：prompt 里拼进了**这部剧本自己的空间**（`storySpec`），
   * 所以同一主题在不同剧本下是不同画面（否则 18 部 modern 剧本会出 18 张一样的图）。
   */
  ownThemes: builtins.flatMap((b) =>
    SCENE_THEMES.map((t) => ({
      scenarioId: b.scenarioId,
      theme: t.id,
      worldview: b.worldview,
      place: b.place,
      file: `${b.scenarioId}-${t.id}.webp`,
      prompt: ownThemePrompt(b.storySpec, b.worldview, t.id),
      // 兜底 prompt：万一"剧本自己的空间"里仍有会带出文字的对象类（实测霓虹招牌最顽固），
      // 抽检连续不合格时退到**纯主题**这一层——主题表按设计不含招牌/霓虹（见 storyScene.ts 的
      // "夜" 口径注释：用"半掩窗帘 + 虚焦窗景"表达夜，而不是靠城市天际线）。
      safePrompt: scenePrompt(b.worldview, t.id),
      negative: negativePromptFor(b.storySpec),
    })),
  ),
};
fs.writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`OK ${out} — 主题池 ${config.matrix.length} 张（${config.worldviews.length} 世界观 × ${config.themes.length} 主题）+ 主场景图 ${config.masters.length} 张 + 每剧本每幕专属图 ${config.ownThemes.length} 张`);
