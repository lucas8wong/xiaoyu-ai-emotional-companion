/**
 * 剧情标题统一解析（角色扮演自建剧本 / 官方剧本 / 千世书自建书与内置书）
 *
 * 为什么单独成模块：同一个诉求此前在三个地方各写了一遍（「与你的旅程」、控制台「用户记录」、
 * 控制台「用户行为」），三份口径还不一致——自建剧本在有的地方**原样露出内部 id**
 * （`custom_mtqy8099ib3dmt` / 千世书 `custom-ab12cd`），在另一处退化成「自定义剧情」占位。
 * 产品口径（2026-09-17 用户拍板）：一律显示**用户自己起的剧名**，另给一个「自建」标志区分来源。
 * 所以解析集中到这一个模块，谁要标题谁来调，别再各写一份。
 *
 * 解析链（自建）：本人 > 已公开 > 全库 findById > 会话标题快照 > 空串（由调用方决定兜底文案）
 * 千世书自建多一层：存档里内嵌的 `scenario.title`——剧本被删/换设备后仍能显示真名。
 *
 * 约定：解析不到真名时返回 `title: ''`（**不回退成内部 id，也不在服务端写三语占位文案**），
 * custom=true 由调用方渲染「自建」标志 + 自己的兜底文案。
 */

import { getScenario } from './roleplay.js';
import { customRoleplayStore } from './customRoleplay.js';
import { wenyouScenariosStore } from './wenyouScenarios.js';
import { wenyouSavesStore } from './wenyouSaves.js';
import { toZhTwDeep } from './zhConvert.js';

export type TitleLang = 'zh' | 'zh-TW' | 'en';

export interface ResolvedScenarioTitle {
  /** 用户/官方起的真实剧名；实在解析不到 = '' （调用方用本地化兜底文案） */
  title: string;
  /** 是否是**用户创建**的剧情（自建剧本 / 千世书自建书）→ 前端渲染「自建」标志 */
  custom: boolean;
  /**
   * 剧本记录已经**不存在**（用户把自己的自建剧本删掉了）→ 前端在名字旁加「已删」标志。
   *
   * 用户口径（2026-09-17）：删掉之后记录里只剩「自建剧情」这个名字没关系，**但要看得出来是已删的**。
   * 只有「服务端权威的剧本库」才敢下这个判断：角色扮演自建剧本存在 `custom-roleplay` 里、
   * 由服务端创建，查不到＝确实被删；而千世书自建剧本的**权威在前端 localStorage**（整表推送），
   * 服务端查不到可能只是「还没推上来」，所以千世书这一侧恒为 false（宁可不标，也不误标）。
   */
  deleted: boolean;
}

/**
 * 自建剧本 id 前缀判定。
 * ⚠️ 两套前缀不一样，别再只认一个：角色扮演自建是 `custom_`（下划线，`customRoleplay.create()`），
 * 千世书自建是 `custom-`（连字符，`src/wenyou/ui/ScenarioCreator.tsx`）。
 * 前端按前缀判断「自建」时也要用同一张口径（见 `src/components/JourneyModal.tsx`）。
 */
export function isCustomScenarioId(id: unknown): boolean {
  return /^custom[_-]/i.test(String(id || ''));
}

function normLang(lang?: string): TitleLang {
  return lang === 'zh-TW' ? 'zh-TW' : lang === 'en' ? 'en' : 'zh';
}

/**
 * 历史遗留的「用户没起名」占位标题（`customRoleplay.create()` 在标题留空时的默认值等）。
 * 这类值不是用户起的剧名，**不能当成真名显示**——否则界面上又会出现「自定义剧情」（正是用户不想看到的）。
 * 命中即视为「没有名字」，交给调用方的兜底文案（前端/控制台显示「自建剧情」）。
 */
const PLACEHOLDER_TITLES = new Set(['自定义剧情', '自訂劇情', 'Custom story', '未命名剧情', '未命名', '无标题']);

function realTitle(t?: string): string {
  const s = String(t == null ? '' : t).trim();
  return s && !PLACEHOLDER_TITLES.has(s) ? s : '';
}

/**
 * 自建剧本**没起名**时的显示名：用 AI 角色名兜底（「与沈辞的故事」）。
 *
 * 来路（2026-09-17 真实数据核对）：线上 27 个自建剧本里有 5 个标题就是 create() 的默认值
 * 「自定义剧情」——用户建剧本时「剧本标题（选填）」留空、AI 草稿也没给标题，于是剧本压根没有名字。
 * 这种时候显示占位文案（正是用户不想看到的「自定义剧情」）毫无用处；用户真正认得出这个故事的是
 * 「和谁的故事」，所以拿 aiName 生成一个可读名（不是伪造标题：标题栏仍然是空的，用户随时能自己起名）。
 * 连 aiName 都没有 → 返回空串，交回调用方的兜底文案。
 */
function derivedCustomName(aiName: unknown, lang: TitleLang): string {
  const n = String(aiName == null ? '' : aiName).trim();
  if (!n) return '';
  return lang === 'en' ? `A story with ${n}` : lang === 'zh-TW' ? `與${n}的故事` : `与${n}的故事`;
}

/** 内置千世书（AI 文游）剧本标题（文游无独立英文标题源，全语言沿用中文） */
const WENYOU_TITLES: Record<string, string> = {
  xian: '缥缈仙途', book: '穿书逆袭', officialdom: '宦海浮沉', spy: '孤岛谍影',
  wuxia: '快意江湖', sanguo: '乱世谋臣', wasteland: '末世求生', scifi: '群星彼端',
  voyage: '怒海争锋', liyuan: '梨园浮梦',
};

/**
 * 角色扮演剧本标题（官方本地化 / 自建按语言取原名）。
 * @param snapshot 会话里存的标题快照（剧本已被删除时的最后一道真名来源）
 */
export function resolveRoleplayTitle(
  scenarioId: unknown,
  userId: string,
  lang?: string,
  snapshot?: string,
): ResolvedScenarioTitle {
  const id = String(scenarioId || '');
  const L = normLang(lang);
  const snap = realTitle(snapshot);
  if (isCustomScenarioId(id)) {
    // 自建剧本：本人 > 已公开（别人投稿后我也能玩）> 跨用户兜底 > 会话快照 > 用 AI 角色名兜出的可读名。
    // 跨用户兜底覆盖「游客建好自建剧本、注册并入账号」等归属错位——数据层 id 全局唯一，解析标题无害。
    const rec = customRoleplayStore.get(userId, id)
      || customRoleplayStore.getPublished(id)
      || customRoleplayStore.findById(id);
    const title = realTitle(rec?.title) || snap || derivedCustomName(rec?.aiName, L);
    // 剧本库（服务端权威）里查不到 → 剧本已被创作者删除，前端标「已删」
    return { title, custom: true, deleted: !rec };
  }
  const s = getScenario(id);
  if (!s) return { title: snap || id, custom: false, deleted: false };
  const localized = L === 'en' ? s.en : L === 'zh-TW' ? toZhTwDeep(s.zh) : s.zh;
  return { title: (localized && localized.title) || snap || id, custom: false, deleted: false };
}

/** 从千世书存档里取剧本内嵌标题（进行中局优先，其次回看点）——剧本被删后唯一真名来源 */
function embeddedWenyouTitle(userId: string, scenarioId: string): string {
  try {
    const p = wenyouSavesStore.get(userId);
    if (!p) return '';
    const game = (p.games || {})[scenarioId] as any;
    const t = game?.scenario?.title;
    if (typeof t === 'string' && t.trim()) return t.trim();
    for (const slot of (Array.isArray(p.slots) ? p.slots : []) as any[]) {
      const sc = slot?.game?.scenario;
      if (sc && String(sc.id || '') === scenarioId && typeof sc.title === 'string' && sc.title.trim()) {
        return sc.title.trim();
      }
    }
  } catch { /* 解析兜底，绝不影响主流程 */ }
  return '';
}

/** 千世书（AI 文游）剧本标题：内置书 > 本人自建 > 全库自建 > 存档内嵌标题 */
export function resolveWenyouTitle(scenarioId: unknown, userId: string): ResolvedScenarioTitle {
  const id = String(scenarioId || '');
  if (WENYOU_TITLES[id]) return { title: WENYOU_TITLES[id], custom: false, deleted: false };
  const custom = isCustomScenarioId(id);
  if (custom) {
    // 千世书书库**服务端不是权威**（前端整表推送，服务端查不到可能只是还没推上来）→ 一律不下「已删」结论，
    // 否则会把「本地还有、只是没同步」的书误标成已删。
    let title = '';
    try {
      const mine = wenyouScenariosStore.get(userId) as { id?: string; title?: string }[];
      title = realTitle(mine.find((s) => s?.id === id)?.title);
    } catch { /* 忽略 */ }
    if (!title) title = realTitle(wenyouScenariosStore.findById(id)?.title);
    if (!title) title = realTitle(embeddedWenyouTitle(userId, id));
    return { title, custom: true, deleted: false };
  }
  return { title: id, custom: false, deleted: false };
}
