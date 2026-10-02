/**
 * 用户个性化偏好模块
 * 持久化到 data/preferences.json
 * tone: warm（温柔）/ direct（直接）；storyStyle: poetic（诗意）/ concise（简洁）/ warm（温暖）
 * region: 地区语气（中文：普通话/东北/京津/川渝/粤港/江南/关中/闽南/闽东/台湾腔；英文：neutral/us/uk/au）
 * intensity: 语气程度（natural 自然 / obvious 明显 / strong 很强）
 * smartFitEnabled: 智能贴合开关（是否允许 AI 在设定框架内做小范围微调）
 * chatInnerMonologueEnabled: 聊一聊括号心理/神态开关（默认开；关闭后 AI 不用括号写心理活动/神情/动作）
 * roleplayInnerMonologueEnabled: 剧情模式括号心理/神态开关（默认开；关闭后 AI 不用括号写心理活动/神情/动作）
 * thinkingLevel: 深度思考档位（off/low/medium/high/max，默认 high）；真正有区分的是 off/high/max，
 *   medium→high、xhigh→high 由官方映射，low 为低强度思考。
 * learnedPreferences: 8 维微调值，每维 -0.12 ~ +0.12
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { quotaStore } from './quota.js';
import { type OutputLang, toOutputLang } from './zhConvert.js';
import { normalizeTimezone } from './timeAnchor.js';
// 关系档（2026-09-21）：内置小愈不是用户创建的角色记录（`userId === ''`），
// 所以"我和小愈是什么关系"这类**用户级**选择只能存在偏好里；自定义/剧情角色的同名字段
// 存在 `ChatCharacter.relation`（每角色一档）。两处在 `gemini.ts` 汇合成一个 RelationKind。
import { normalizeRelation, type RelationKind } from './chatRelation.js';

const FILE = dataFile('preferences.json');

export type CompanionMode = 'hug' | 'ally' | 'clarify' | 'light' | 'objective';
export type Region = 'putonghua' | 'dongbei' | 'jingjin' | 'chuanyu' | 'yuegang' | 'jiangnan' | 'guanzhong' | 'minnan' | 'mindong' | 'taiwan' | 'neutral' | 'us' | 'uk';
export type Intensity = 'natural' | 'obvious' | 'strong';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** 8 个可微调子维度（AI 在用户设定框架内的小范围微调） */
export interface LearnedPreferences {
  directness: number;        // 直接度
  warmth: number;            // 温暖感
  humor: number;             // 幽默度
  adviceTendency: number;    // 建议倾向
  responseLength: number;    // 回复长短
  questionDensity: number;   // 追问密度
  markerDensity: number;     // 地区词/助词密度
  softness: number;          // 柔和度
}

const ZERO_LEARNED: LearnedPreferences = {
  directness: 0, warmth: 0, humor: 0, adviceTendency: 0,
  responseLength: 0, questionDensity: 0, markerDensity: 0, softness: 0,
};

/** 微调边界（防止"AI 突然换人"） */
export const ADAPTATION_BOUNDS = { min: -0.12, max: 0.12 };

/** 「无限制模式」的单剧本显式选择：剧本 id → 用户在那个剧本里拨的开关 */
export type ScenarioUnlimitedMap = Record<string, boolean>;
/** 表上限：正常用户不可能有这么多剧本；纯粹防止偏好文件被无界写大（超出后新条目不再记） */
const SCENARIO_UNLIMITED_MAX = 200;
/** 剧本 id 长度上限（自建 id 形如 custom_xxxx，这里只是防畸形超长 key 撑大文件） */
const SCENARIO_ID_MAX = 64;

/**
 * 归一化单剧本表：只收 boolean 值。
 * 传 'true' / 1 / null / undefined 一律丢弃，宁可当「没拨过开关」，也不要错数据
 * （否则一个字符串 'false' 会被当成「用户明确关了」，把默认开顶掉）。
 */
function normalizeScenarioUnlimitedMap(v: any): ScenarioUnlimitedMap {
  const out: ScenarioUnlimitedMap = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || !k || k.length > SCENARIO_ID_MAX) continue;
    if (typeof val !== 'boolean') continue;
    if (Object.keys(out).length >= SCENARIO_UNLIMITED_MAX) break;
    out[k] = val;
  }
  return out;
}

export interface Preferences {
  userId: string;
  tone: 'warm' | 'direct';
  storyStyle: 'poetic' | 'concise' | 'warm' | 'abstract';
  mode: CompanionMode; // 陪伴方式：hug 接住我 / ally 挺我一下 / clarify 帮我理清 / light 轻一点看 / objective 客观看看
  language: OutputLang; // 界面与 AI 输出语言
  region: Region;        // 地区语气（中文 10 地区 / 英文 neutral·us·uk）
  intensity: Intensity;  // 语气程度 3 档
  smartFitEnabled: boolean; // 智能贴合开关
  dataEnhance: boolean; // 服务改进开关：允许将去标识化后的聊天/内容用于改进服务（默认开，可在隐私设置关闭）
  activityAwareness: boolean; // 行为感知开关：允许 AI 知道用户最近在应用里做了什么（如刚玩过剧情扮演），默认开，可在隐私设置关闭
  chatInnerMonologueEnabled: boolean; // 聊一聊括号心理/神态开关（默认开）
  /**
   * 和小愈的关系档（2026-09-21）：朋友 friend（默认）/ 损友 buddy / 家人 family / 恋人 lover。
   * 只影响聊一聊的口吻参数（称呼、分寸、玩梗强度、连发条数），**不影响内容尺度**
   * safety.ts 的红线与关系档无关，恒成立（聊一聊侧没有剧情那条「无限制模式」）。
   */
  xiaoyuRelation: RelationKind;
  roleplayInnerMonologueEnabled: boolean; // 剧情模式括号心理/神态开关（默认开）
  thinkingLevel: ThinkingLevel; // 深度思考档位（默认 high；真正区分 off/high/max）
  assistantVoiceEnabled: boolean; // 小愈朗读开关（默认关）：开启才在回复下方显示语音气泡并预加载 TTS（供控制台统计）
  roleplayVoiceEnabled: boolean; // 剧情「角色配音」开关（默认关）：开启才在剧情回复下方显示语音气泡并预加载 TTS；跨设备同步
  roleplayAmbienceEnabled: boolean; // 剧情「环境音」开关（默认关）：随换幕播放雨/风/室内底噪与雷声一次性音效；跨设备同步
  roleplayAutoSceneArt: boolean; // 「关键时刻自动画面」（默认关，Pro 权益）：剧情走到高压/亲密/承诺/和好/离别这几幕时自动补一张专属画面
  roleplayUnlimited: boolean; // 剧情「无限制模式」开关（默认关，需用户显式开启）：改用去限制模型 + 放开尺度提示词（成人向内容照实书写、角色可更主动）。同时是安全阀：不开启就完全走 DeepSeek 的保守行为
  /**
   * 「无限制模式」的**单剧本**显式选择（默认空表）：key = 剧本 id，value = 用户在那个剧本里亲手拨的开关。
   *
   * 为什么需要它：本人用无限制模型创建的剧本，进聊天时成人模式默认开（见 roleplay.ts 的
   * unlimitedForScenario）。可用户总得有办法只关掉**这一个**剧本，如果那一下写的是全局
   * roleplayUnlimited，他所有剧本的成人模式会一起被关掉。
   *
   * 缺省（表里没有这个剧本）= 用户没在那个剧本里拨过开关，**不等于「关」**：
   * 这时才回落到「剧本自带默认 / 全局偏好」。三态语义与 createdWithUnlimited 一致。
   * 只由 POST /api/roleplay/unlimited 写入，不能从 /api/user/preferences 直接改（整表覆盖会误伤别的剧本）。
   */
  roleplayUnlimitedByScenario: ScenarioUnlimitedMap;
  roleplayScriptUnlimited: boolean; // 剧情「用无限制模型生成剧本」开关（默认关）：仅影响 AI 生成/改写自建剧本；同样受 18+ 成年确认这道闸（见 prefAllowedFor）。剧本生成默认走 DeepSeek 不占并发池
  /**
   * 剧情**叙事模式**（2026-09-25 C 方案）：`classic` 小说笔法 / `immersive` 对话笔法。
   * 差异定义在 `api/services/narrativeStyle.ts`（篇幅、语体、收尾、亲密档、续写带）。
   *
   * 为什么从 localStorage 搬到服务端：它原先只存在浏览器 `localStorage['rp_narrative_style']`
   * ⇒ 换设备/清缓存就回默认、控制台也看不到用户选了什么。现在以服务端为准，
   * localStorage 只作为**冷启动缓存**（老用户的本地选择会在首屏一次性迁上来）。
   *
   * 三态（和 roleplayThinking 那条不同，这里的三态是**必要的**）：
   * `'classic'`/`'immersive'` = 用户拨过；`undefined` = 还没拨过 → 前端回落到 localStorage（迁移）。
   * 归一化只认这两个取值，别的（含老数据缺失）一律**不落字段**。
   */
  narrativeStyle?: 'classic' | 'immersive';
  proactivePush: boolean; // AI 主动找我（推送通知）开关：开启后小愈可在用户离开一段时间时不定时主动发消息（默认关）
  proactiveFrequency: 'random' | 'frequent' | 'occasional' | 'intense'; // 主动找我的频率偏好：random 随机(默认) / frequent 常来(约每天5次) / occasional 偶尔 / intense 高频随性(每天≤10次)
  learnedPreferences: LearnedPreferences; // 8 维微调
  /**
   * 用户上报的 IANA 时区（如 Asia/Hong_Kong），**不是**用户设置项，而是浏览器上报的客观环境值
   * （见 POST /api/reengage/timezone；PreferencePanel 开启推送/召回时上报）。
   * 用途：时间锚（timeAnchor.ts）用它算「用户那边的今天」，避免海外用户跨日时"今天"算错一天。
   */
  timezone?: string;
  updatedAt: number;
}

// 中文 10 地区 + 英文 3 风格（neutral 标准 / us 美式 / uk 英式）
const REGIONS: Region[] = ['putonghua', 'dongbei', 'jingjin', 'chuanyu', 'yuegang', 'jiangnan', 'guanzhong', 'minnan', 'mindong', 'taiwan', 'neutral', 'us', 'uk'];
const INTENSITIES: Intensity[] = ['natural', 'obvious', 'strong'];
// 深度思考档位（默认 high；low/medium 由官方映射，UI 只暴露 off/high/max）
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * 按会员档位约束思考档位：max（最大）仅 Pro/Lifetime 可享受；其余档位放行。
 * 非 Pro（含游客/免费/Plus）请求 max 时降级为 high（默认档）。
 */
export function resolveThinkingLevelFor(userId: string | undefined, level: ThinkingLevel): ThinkingLevel {
  if (level !== 'max') return level;
  try {
    const plan = quotaStore.getQuota(userId || '').plan;
    if (plan === 'pro') return 'max'; // lifetime 在 getQuota 里按 pro 返回
  } catch { /* 忽略，按非 Pro 处理 */ }
  return 'high';
}
// 英文可用地区（标准/美式/英式）；其余为中文地区
const EN_REGIONS: Region[] = ['neutral', 'us', 'uk'];

function clampLearned(v: any): LearnedPreferences {
  const out: LearnedPreferences = { ...ZERO_LEARNED };
  const keys = Object.keys(ZERO_LEARNED) as (keyof LearnedPreferences)[];
  for (const k of keys) {
    const val = typeof v?.[k] === 'number' ? v[k] : 0;
    out[k] = Math.max(ADAPTATION_BOUNDS.min, Math.min(ADAPTATION_BOUNDS.max, val));
  }
  return out;
}

class PreferenceStore {
  private items: Map<string, Preferences> = new Map();

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<any[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((p: any) => {
        if (p?.userId) this.items.set(p.userId, this.normalize(p));
      });
    }
  }

  private normalize(p: any): Preferences {
    return {
      userId: p.userId,
      tone: p.tone === 'direct' ? 'direct' : 'warm',
      storyStyle: p.storyStyle === 'concise' || p.storyStyle === 'warm' || p.storyStyle === 'abstract' ? p.storyStyle : 'poetic',
      mode: p.mode === 'ally' || p.mode === 'clarify' || p.mode === 'light' || p.mode === 'objective' ? p.mode : 'hug',
      language: toOutputLang(p.language, 'zh-TW'),
      region: (() => {
        const lang = toOutputLang(p.language, 'zh-TW');
        // 英文模式默认/归一到 Standard（neutral）；中文地区仅中文模式可用
        if (!REGIONS.includes(p.region)) return lang === 'en' ? 'neutral' : 'putonghua';
        if (lang === 'en') return EN_REGIONS.includes(p.region) ? p.region : 'neutral';
        return p.region;
      })(),
      intensity: INTENSITIES.includes(p.intensity) ? p.intensity : 'natural',
      smartFitEnabled: typeof p.smartFitEnabled === 'boolean' ? p.smartFitEnabled : true,
      dataEnhance: typeof p.dataEnhance === 'boolean' ? p.dataEnhance : true,
      activityAwareness: typeof p.activityAwareness === 'boolean' ? p.activityAwareness : true,
      chatInnerMonologueEnabled: typeof p.chatInnerMonologueEnabled === 'boolean' ? p.chatInnerMonologueEnabled : true,
      // 关系档：`normalizeRelation` 把缺省/非法值一律回落成 friend（老数据没有这个字段）
      xiaoyuRelation: normalizeRelation(p.xiaoyuRelation),
      roleplayInnerMonologueEnabled: typeof p.roleplayInnerMonologueEnabled === 'boolean' ? p.roleplayInnerMonologueEnabled : true,
      thinkingLevel: THINKING_LEVELS.includes(p.thinkingLevel) ? p.thinkingLevel : 'high',
      assistantVoiceEnabled: typeof p.assistantVoiceEnabled === 'boolean' ? p.assistantVoiceEnabled : false,
      roleplayVoiceEnabled: typeof p.roleplayVoiceEnabled === 'boolean' ? p.roleplayVoiceEnabled : false,
      roleplayAmbienceEnabled: typeof p.roleplayAmbienceEnabled === 'boolean' ? p.roleplayAmbienceEnabled : false,
      roleplayAutoSceneArt: typeof p.roleplayAutoSceneArt === 'boolean' ? p.roleplayAutoSceneArt : false,
      // 默认关：无限制模式必须由用户显式开启（既是产品选择，也是内容安全阀）
      roleplayUnlimited: typeof p.roleplayUnlimited === 'boolean' ? p.roleplayUnlimited : false,
      // 单剧本表：整表归一化后必须**显式搬过来**，normalize 是逐字段构造，
      // 漏一行就会把已存的选择静默清零（和 customRoleplay.create 那类「逐字段丢字段」是同一个坑）
      roleplayUnlimitedByScenario: normalizeScenarioUnlimitedMap(p.roleplayUnlimitedByScenario),
      // 默认关：剧本生成走无限制模型同样要用户显式开启（且需过 18+ 成年确认那道闸）
      roleplayScriptUnlimited: typeof p.roleplayScriptUnlimited === 'boolean' ? p.roleplayScriptUnlimited : false,
      // 叙事模式（三态）：只有真的是那两个取值才落字段，「没拨过」必须保持字段不存在，
      // 否则前端没法区分「用户选的就是 immersive」与「他还没选，我该用本地缓存迁上来」
      ...(p.narrativeStyle === 'classic' || p.narrativeStyle === 'immersive' ? { narrativeStyle: p.narrativeStyle } : {}),
      proactivePush: typeof p.proactivePush === 'boolean' ? p.proactivePush : false,
      proactiveFrequency: p.proactiveFrequency === 'frequent' || p.proactiveFrequency === 'occasional' || p.proactiveFrequency === 'intense' ? p.proactiveFrequency : 'random',
      learnedPreferences: clampLearned(p.learnedPreferences),
      // 浏览器上报的时区：非法值直接丢弃（不写坏值），否则原样保留
      ...(normalizeTimezone(p.timezone) ? { timezone: normalizeTimezone(p.timezone) } : {}),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    };
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  get(userId: string): Preferences {
    return this.items.get(userId) || this.normalize({ userId, language: 'zh-TW' });
  }

  set(userId: string, prefs: Partial<Preferences>): Preferences {
    const cur = this.get(userId);
    // 过滤 undefined：路由会解构整个 body，未提供的字段是 undefined，
    // 直接展开会把已保存值覆盖为 undefined 后被 normalize 重置为默认值（导致改一项丢其它项）。
    //
    // 三态字段 narrativeStyle 另挡一道：不是那两个取值时**整条丢掉**（而不是交给 normalize 丢弃），
    // 否则一个 `narrativeStyle: null`（或老客户端传的空串）会把用户已经选好的模式冲成「没拨过」。
    const defined = Object.fromEntries(
      Object.entries(prefs).filter(([k, v]) =>
        v !== undefined && !(k === 'narrativeStyle' && v !== 'classic' && v !== 'immersive'))
    ) as Partial<Preferences>;
    const next = this.normalize({ ...cur, ...defined, userId });
    this.items.set(userId, next);
    this.saveToDisk();
    return next;
  }

  /**
   * 更新 8 维微调偏好（自动 clamp 到 ±0.12 边界）
   */
  setLearned(userId: string, patch: Partial<LearnedPreferences>): Preferences {
    const cur = this.get(userId);
    const next = this.normalize({
      ...cur,
      learnedPreferences: { ...cur.learnedPreferences, ...patch },
    });
    this.items.set(userId, next);
    this.saveToDisk();
    return next;
  }

  /**
   * 读某个剧本的「无限制模式」显式选择。
   * 返回 undefined = 用户没在这个剧本里拨过开关（**不等于关**），调用方应继续回落到剧本默认/全局偏好。
   */
  getUnlimitedForScenario(userId: string, scenarioId: string): boolean | undefined {
    if (!userId || !scenarioId) return undefined;
    const v = this.get(userId).roleplayUnlimitedByScenario?.[scenarioId];
    return typeof v === 'boolean' ? v : undefined;
  }

  /**
   * 写某个剧本的显式选择（**读-合并-写整表**）。
   *
   * 为什么不干脆让前端把 newMap 丢进 /api/user/preferences：那是字段级覆盖，
   * 客户端只要漏带半张表，用户在别的剧本里关过的开关就被无声还原了。
   * 合并这件事只有服务端做才不会错，所以这里提供一个入口。
   */
  setUnlimitedForScenario(userId: string, scenarioId: string, unlimited: boolean): Preferences {
    const merged: ScenarioUnlimitedMap = { ...this.get(userId).roleplayUnlimitedByScenario, [scenarioId]: unlimited };
    return this.set(userId, { roleplayUnlimitedByScenario: merged });
  }

  listAll(): Preferences[] {
    return Array.from(this.items.values());
  }

  remove(userId: string): void {
    if (this.items.delete(userId)) this.saveToDisk();
  }

  /** 游客偏好并入账号（账号已有偏好则以账号为准） */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    const g = this.items.get(oldId);
    if (g && !this.items.has(newId)) {
      this.items.set(newId, { ...g, userId: newId });
      this.saveToDisk();
    }
  }
}

export const preferenceStore = new PreferenceStore();
export default preferenceStore;
