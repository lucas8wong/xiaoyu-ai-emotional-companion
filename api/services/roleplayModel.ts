/**
 * 角色扮演链路的模型路由（按剧情语言双分支）
 *
 * 为什么需要它：剧情扮演要如实写成人向剧情，而官方 DeepSeek 会自我净化
 * （roleplay.ts 的提示词已明确「成人剧情无需避免直白描写」，但模型不执行）。
 * 因此把**角色扮演链路**按语言指向两个第三方 OpenAI 兼容后端：
 *   - zh / zh-TW → 中文表现更好的模型（RP_ZH_*）
 *   - en         → 英文表现更好的模型（RP_EN_*）
 *
 * 影响范围（其余链路一律不动，继续走 DeepSeek）：
 *   受影响的 6 个调用点全部位于 api/services/roleplay.ts：
 *     roleplayReply / roleplayReplyCustom（剧情回复）
 *     roleplaySuggestions / roleplaySuggestionsCustom（玩家候选建议）
 *     roleplayDraftCustom / roleplayReviseCustom（剧本生成 / 改写）
 *   不受影响：情感对话(gemini)、文游(textgame)、狼人杀(werewolf)、图片视觉、
 *             皮肤生成(skinGenerator)、挽留文案(reengage)、剧本列表(scenarioGenerator)。
 *
 * 安全阀：**对应分支的三项环境变量没设齐就无条件回落 DeepSeek**，
 * 保证未配置时不改变线上任何行为。
 *
 * 想切回 DeepSeek？三种方式，任选其一（都不需要删除已配好的 RP_* 配置）：
 *   ① RP_PROVIDER=deepseek          ← 两个分支一起切回（线上止血用这一行）
 *   ② RP_ZH_PROVIDER=deepseek       ← 只切中文分支（en 继续用第三方）
 *   ③ 删掉/注释该分支的 BASE_URL / API_KEY / MODEL 中任意一项 → 三项缺一即回落
 * 反向恢复：把 RP_*_PROVIDER 改成 custom（或删掉这一行）即可重新启用第三方。
 *
 * 环境变量契约
 *   RP_ZH_BASE_URL / RP_ZH_API_KEY / RP_ZH_MODEL   ← 三项设齐才启用中文分支
 *   RP_EN_BASE_URL / RP_EN_API_KEY / RP_EN_MODEL   ← 三项设齐才启用英文分支
 *   RP_ZH_MAX_TOKENS / RP_EN_MAX_TOKENS            可选，默认 4096（剧情回复上限）
 *   RP_ZH_EXTRA_BODY / RP_EN_EXTRA_BODY            可选，JSON 对象，合并进请求体。
 *                                                  第三方托管专有能力的逃生口，典型用途：
 *                                                  {"chat_template_kwargs":{"enable_thinking":false}}
 *                                                  Qwen3.5 系默认开思考，不关会白烧几百到上千
 *                                                  输出 token（实测同一句问候：338 → 3 token）。
 *
 * ⛔ 成人档**禁止思考模式**（2026-09-25 产品决定，本文件强制执行）
 *   背景：曾接入过一版「按用户灰度 + 用户可拨」的思考模式，随后做了有预注册判据的对照实验
 *   （temp/_think-seq.mts / temp/_think-seq-analyze.mjs，数据 temp/rp-think-seq/），结论是**不可用**：
 *     · 真实剧情 prompt（8-10k token）下开思考单轮中位 **423s**（关思考 16s，≈26×）；
 *     · 6 轮里 **3 轮只写出 22 字的残句**（思考吃光输出预算）；
 *     · 用生产超时 180s 跑时 **4 轮里 3 轮被掐断**并自动降级成关思考（用户白等 ~200s 拿到"没思考"的回复）；
 *     · 主终点（自身复用 ≥100 字占比）Fisher p=1.000 无差异，护栏「字数比 0.6 以上」也没过。
 *   ⇒ 用户口径「移除所有成人模型思考模式」。这里用一个**不变量**兜住：无论 `.env` 怎么配、
 *     偏好怎么传，成人档发出去的请求体里 `chat_template_kwargs.enable_thinking` **恒为 false**
 *     （见 enforceNoThinking 与 test/unit/roleplayModel.test.ts 的守卫用例）。
 *     要重新评估这件事，请先改这里并重跑上述实验，而不是悄悄加一个 env 开关。
 *   RP_TIMEOUT_MS                                  可选，默认 60000
 *   RP_PROVIDER                                    可选，'deepseek' = 两分支一起切回官方（一键止血）
 *   RP_ZH_PROVIDER / RP_EN_PROVIDER                可选，'deepseek' | 'custom'，按分支覆盖
 *                                                  （分支级优先于 RP_PROVIDER；'custom' 可强行用回第三方）
 *   RP_MAX_RETRIES                                 可选，默认 2
 *   RP_ZH_FLAT_RATE / RP_EN_FLAT_RATE / RP_AUX_FLAT_RATE
 *                                                  可选，缺省 = 订阅制（1）。第三方托管按固定月费 /
 *                                                  并发单元卖，token 不单独出账，所以 usage 账本把
 *                                                  这些调用按 **cost 0** 记、只留 notionalCost 参考价，
 *                                                  免得运营端 API 成本被「没花的 token 钱」撑虚高。
 *                                                  配 '0' = 该分支上游是**按量计费**的第三方
 *                                                  （OpenRouter 之类），恢复按 DeepSeek 单价折 token 成本。
 *                                                  全局开关 RP_FLAT_RATE=0 一次关掉三个分支。
 *   RP_STREAM_USAGE                                可选，'1' 才在流式请求里带
 *                                                  stream_options.include_usage。
 *                                                  **2026-09-17 实测：Featherless 支持该字段**
 *                                                  （temp/verify-rp-stream-usage.mts → HTTP 200，末帧回传
 *                                                  usage{prompt_tokens,completion_tokens,cached_tokens}），
 *                                                  `.env` 已开启 → 剧情流式按真实 usage 记账（含缓存折扣）。
 *                                                  关掉或不支持时：拿不到真实 usage，改用
 *                                                  deepseek.ts 的「按生成量估算 + estimated 标记」兜底
 *                                                  （额度层仍保留预扣，不会漏计费）。
 */

import { createDeepSeekClient, createCompatClient, DEEPSEEK_PROVIDER, type ProviderConfig } from './deepseek.js';
import { withUpstreamSlot, retryBusy, type QueueWaitInfo } from './rpQueue.js';

/** 剧情语言（与 RPLang 一致；这里不 import 以免循环依赖） */
export type RoleplayLang = 'zh' | 'zh-TW' | 'en';

/** 第三方分支的配置（强制非 DeepSeek，故不含 isDeepSeek） */
type CompatConfig = Omit<ProviderConfig, 'isDeepSeek'>;

/** 客户端来源：compat=第三方；deepseek=回落/被开关强制 */
export type RoleplayProviderChoice = 'custom' | 'deepseek';
/** 为什么是这个来源：未配置 / 三项缺一 / 被开关强制 / 用户未开启无限制模式 */
export type RoleplayProviderReason = 'configured' | 'unset' | 'incomplete' | 'forced' | 'user-off';

export interface RoleplayClientChoice {
  /** 与 createDeepSeekClient() 同形态的 client，可直接调 models.generateContent[Stream] */
  client: any;
  /** 实际使用的模型名，用于日志与排查 */
  model: string;
  /** true = 已切到第三方后端；false = 走 DeepSeek */
  viaCompat: boolean;
  /** 便于自检/日志解释「为什么」 */
  provider: RoleplayProviderChoice;
  reason: RoleplayProviderReason;
}

/**
 * 显式 provider 开关，用于**一键切回 DeepSeek**，无需删改已配好的 RP_* 配置。
 *
 *   RP_PROVIDER=deepseek      两个分支（zh + en）都强制回 DeepSeek ← 线上止血用这一行
 *   RP_ZH_PROVIDER=deepseek   只把中文分支切回
 *   RP_EN_PROVIDER=deepseek   只把英文分支切回
 *   RP_*_PROVIDER=custom      强制使用第三方（即使全局 RP_PROVIDER=deepseek）
 *
 * 优先级：分支级 > 全局级。取值大小写不敏感，认不出的值一律忽略（不改变原行为）。
 */
function forcedProvider(prefix: 'RP_ZH' | 'RP_EN'): 'deepseek' | 'custom' | null {
  const perBranch = (process.env[prefix + '_PROVIDER'] || '').trim().toLowerCase();
  if (perBranch === 'deepseek') return 'deepseek';
  if (perBranch === 'custom') return 'custom';
  const global = (process.env.RP_PROVIDER || '').trim().toLowerCase();
  if (global === 'deepseek') return 'deepseek';
  return null;
}

/** 三个分支共用的可选覆盖项 */
function commonOverrides(): { timeoutMs: number; maxRetries: number; streamUsage: boolean } {
  return {
    timeoutMs: Number(process.env.RP_TIMEOUT_MS || 60000),
    maxRetries: Number(process.env.RP_MAX_RETRIES || 2),
    streamUsage: process.env.RP_STREAM_USAGE === '1',
  };
}

/**
 * 读一个语言分支的配置。
 * 三项（BASE_URL / API_KEY / MODEL）任一为空 → 返回 null，表示该分支回落 DeepSeek。
 */
function readBranch(prefix: 'RP_ZH' | 'RP_EN' | 'RP_AUX'): CompatConfig | null {
  const baseUrl = (process.env[prefix + '_BASE_URL'] || '').trim();
  const apiKey = (process.env[prefix + '_API_KEY'] || '').trim();
  const model = (process.env[prefix + '_MODEL'] || '').trim();
  if (!baseUrl || !apiKey || !model) return null;

  const common = commonOverrides();
  return {
    // 日志/报错里显示的名字（deepseek.ts 用它拼 [xxx] 前缀与错误文案）
    name: prefix === 'RP_ZH' ? 'Roleplay-ZH' : prefix === 'RP_EN' ? 'Roleplay-EN' : 'Roleplay-AUX',
    // 去掉结尾斜杠，避免拼出 //chat/completions
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    // 剧情回复由 prompt 限定 300-600 字，4096 足够且不易撑爆小窗口模型；
    // 剧本生成会单独用 req.maxTokens 覆盖成更大的值。
    maxTokens: Number(process.env[prefix + '_MAX_TOKENS'] || 4096),
    timeoutMs: common.timeoutMs,
    maxRetries: common.maxRetries,
    streamUsage: common.streamUsage,
    extraBody: readExtraBody(prefix),
    // 这个上游是不是「订阅制」（固定月费/并发单元，token 不单独出账）→ 决定 usage 账本怎么记钱
    flatRate: flatRateFor(prefix),
    apiKey,
  };
}

/**
 * 该分支的上游是否按**订阅制**（固定月费 / 并发单元）计费。
 *
 * 默认 true：本项目接的第三方托管（Featherless）就是按并发单元订阅卖的，token 用量不产生
 * 按量费用。usage 账本据此把它的调用按 **cost 0** 记，只留 notionalCost 参考价，
 * 否则运营端 API 成本会被一批其实没花的 token 账单撑虚高（利润被低估）。
 *
 * 换成**按量计费**的第三方（OpenRouter 之类）时，配「RP_ZH_FLAT_RATE=0」即可恢复
 * 「按 DeepSeek 单价折算 token 成本」的旧口径；全局开关 RP_FLAT_RATE=0 一次关三个分支。
 * 注意：这只影响**成本记账**，与用户点数无关（额度层走 costFromUsage，不读账本）。
 */
function flatRateFor(prefix: 'RP_ZH' | 'RP_EN' | 'RP_AUX'): boolean {
  const perBranch = (process.env[prefix + '_FLAT_RATE'] || '').trim();
  const global = (process.env.RP_FLAT_RATE || '').trim();
  return (perBranch || global) !== '0';
}

/**
 * 托管专有扩展字段（JSON 字符串，如 {"chat_template_kwargs":{"enable_thinking":false}}）。
 * 解析失败只告警并忽略，绝不让一个配错的字符串把剧情链路整条打挂。
 */
function readExtraBody(prefix: 'RP_ZH' | 'RP_EN' | 'RP_AUX'): Record<string, unknown> | undefined {
  const raw = (process.env[prefix + '_EXTRA_BODY'] || '').trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn(`⚠️ [roleplayModel] ${prefix}_EXTRA_BODY 需为 JSON 对象，已忽略`);
    return undefined;
  } catch (e) {
    console.warn(`⚠️ [roleplayModel] ${prefix}_EXTRA_BODY 不是合法 JSON，已忽略:`, (e as Error)?.message);
    return undefined;
  }
}

/** 构造「走 DeepSeek」的选择，并带上原因 */
function deepseekChoice(reason: RoleplayProviderReason): RoleplayClientChoice {
  return {
    client: createDeepSeekClient(),
    model: DEEPSEEK_PROVIDER.model,
    viaCompat: false,
    provider: 'deepseek',
    reason,
  };
}

// 【成人档禁止思考模式（2026-09-25 产品决定）】

/**
 * 把 `chat_template_kwargs.enable_thinking` **强制写成 false**。
 *
 * 为什么要有这道不变量（而不是「靠 .env 别配错」）：
 *   成人档思考模式已按实验结论**移除**（文件头写了四条实测证据：单轮中位 423s、半数回合 22 字残句、
 *   生产超时下 3/4 被掐断、主终点 p=1.000 无差异）。一个只存在于 `.env` 的"关"是脆的
 *   任何人复制粘贴一段托管配置（Qwen3.5 系默认**开**思考）就会把它打开，而我们不会收到任何报警，
 *   只会看到"最近剧情怎么这么慢/这么短"。所以这里把「成人档不思考」写成代码里的不变量，
 *   并由 test/unit/roleplayModel.test.ts 的守卫用例钉死。
 *
 * 只在配置里已经出现 `chat_template_kwargs` 时才动它（那是托管要求的模板参数对象，
 * 顺手把 enable_thinking 定成 false）；否则不凭空造一个字段出来。
 * 其余 EXTRA_BODY 内容（temperature / top_p / 采样惩罚…）原样保留。
 */
function enforceNoThinking(cfg: CompatConfig): CompatConfig {
  const ctk = cfg.extraBody?.chat_template_kwargs as Record<string, unknown> | undefined;
  if (!ctk || typeof ctk !== 'object') return cfg;
  if (ctk.enable_thinking === false) return cfg; // 已经是关：原样返回，不打日志
  console.warn('⚠️ [roleplayModel] 成人档禁止思考模式：已把 EXTRA_BODY 的 enable_thinking 覆盖为 false');
  return { ...cfg, extraBody: { ...(cfg.extraBody || {}), chat_template_kwargs: { ...ctk, enable_thinking: false } } };
}

/**
 * 按剧情语言取 client，剧情链路唯一入口。
 * en → 英文分支；zh / zh-TW（含未知值）→ 中文分支。
 *
 * 判定顺序（上层优先）：
 *   1. 运维开关 RP_PROVIDER / RP_*_PROVIDER = deepseek  → 强制官方（最高优先，用户偏好压不过它）
 *   2. allowUnlimited === false（用户没开「无限制模式」）→ 官方
 *   3. 三项配置齐全 → 第三方（去限制模型）
 *   4. 否则 → 官方
 *
 * @param allowUnlimited 用户是否开启了「无限制模式」（来自 roleplayUnlimited 偏好）。
 *                       不传（undefined）时按**可用即用**处理，保持改造前的行为，
 *                       以免影响未接偏好的旧调用方。
 */
export function roleplayClientFor(
  lang: RoleplayLang | string | undefined,
  allowUnlimited?: boolean,
  onQueue?: (info: QueueWaitInfo) => void,
): RoleplayClientChoice {
  const prefix: 'RP_EN' | 'RP_ZH' = lang === 'en' ? 'RP_EN' : 'RP_ZH';

  // 1) 运维开关优先：一键切回 DeepSeek（无需删配置）
  if (forcedProvider(prefix) === 'deepseek') return deepseekChoice('forced');

  // 2) 用户没开「无限制模式」→ 保持保守行为，走官方
  if (allowUnlimited === false) return deepseekChoice('user-off');

  // 3) 三项齐全才启用第三方
  const cfg = readBranch(prefix);
  if (!cfg) {
    const anySet = !!(process.env[prefix + '_BASE_URL'] || process.env[prefix + '_API_KEY'] || process.env[prefix + '_MODEL']);
    return deepseekChoice(anySet ? 'incomplete' : 'unset'); // 配了一半也当没配，避免半残配置上生产
  }
  // 成人档禁止思考模式：无论配置怎么写，发出去的 enable_thinking 恒为 false（见 enforceNoThinking）
  const eff = enforceNoThinking(cfg);
  return {
    // 第三方分支一律套上本地并发闸门：托管档位以「并发单元」计价，撞满会拿到 429，
    // 而流式路径按设计不重试 → 用户会直接看到失败。排队把「必然失败」变成「稍等」。
    client: withUpstreamGate(createCompatClient(eff), onQueue),
    model: eff.model,
    viaCompat: true,
    provider: 'custom',
    reason: 'configured',
  };
}

/**
 * 把 client 的两次调用包进「本地并发闸门 + 忙时重试」。
 *
 * 只包第三方分支（DeepSeek 官方没有这种账号级并发上限，不需要排队）。
 * 流式那路额外做了一件事：记录是否已经吐过 token，吐过就绝不重试，否则会重复下发。
 */
function withUpstreamGate(client: any, onQueue?: (info: QueueWaitInfo) => void): any {
  if (!client?.models) return client;
  const models = client.models;
  return {
    ...client,
    models: {
      ...models,
      generateContent: (req: any, opts?: any) =>
        withUpstreamSlot(() => retryBusy(() => models.generateContent(req, opts)), onQueue),
      generateContentStream: (req: any, opts?: any) => {
        let emitted = false;
        const orig = req?.onToken;
        const wrapped = { ...req, onToken: (d: string) => { emitted = true; orig?.(d); } };
        return withUpstreamSlot(() => retryBusy(() => models.generateContentStream(wrapped, opts), () => emitted), onQueue);
      },
    },
  };
}

/**
 * **辅助调用**（玩家候选建议 / 剧本生成与改写）的 client，与剧情回复**分开选型**。
 *
 * 为什么必须分开：这些调用不生成成段剧情，但同样按「模型单价」从账号并发池里扣费。
 * 实测（Featherless）：账号共 4 单元、27B 模型每请求扣 2 单元 →
 * **用户点一次「生成 4 条建议」就占掉半条剧情回复的并发**。
 *
 * 默认走 DeepSeek 官方（不占并发池）。两条例外：
 *   ① 用户在「剧本生成」处显式选择无限制模型（`allowUnlimited=true`）→ 走该语言的主分支。
 *      剧本生成的任务提示词要求「不要净化成纯情清水」，官方 DeepSeek 会净化，
 *      所以这个选择权交给用户（偏好 `roleplayScriptUnlimited`）。
 *   ② 运维级逃生口 `RP_AUX_PROVIDER=custom` + `RP_AUX_BASE_URL/API_KEY/MODEL`
 *      （**建议用 cost=1 的 <16B 模型**，只扣 1 单元、比剧情回复省一半）。
 */
export function roleplayAuxClientFor(
  lang?: RoleplayLang | string,
  allowUnlimited?: boolean,
): RoleplayClientChoice {
  // ① 用户显式选择用无限制模型：走该语言的主分支（配好才生效，没配好静默回落以保可用性）
  if (allowUnlimited === true) {
    const main = roleplayClientFor(lang);
    if (main.viaCompat) {
      return { ...main, reason: 'configured' };
    }
    console.warn('⚠️ [roleplayModel] 用户选择了无限制模型生成剧本，但该语言分支未配置，已回落 DeepSeek');
  }

  // ② 运维级逃生口
  const wantsCustom = (process.env.RP_AUX_PROVIDER || '').trim().toLowerCase() === 'custom';
  if (wantsCustom) {
    const cfg = readBranch('RP_AUX');
    if (cfg) {
      return {
        client: withUpstreamGate(createCompatClient(cfg)),
        model: cfg.model,
        viaCompat: true,
        provider: 'custom',
        reason: 'configured',
      };
    }
    // 说了要用第三方却没配齐 → 明确告警后回落，不让半残配置静默上线
    console.warn('⚠️ [roleplayModel] RP_AUX_PROVIDER=custom 但 RP_AUX_BASE_URL/API_KEY/MODEL 未配齐，辅助调用已回落 DeepSeek');
  }
  return { ...deepseekChoice('unset'), reason: 'unset' };
}

/**
 * 「无限制模式」当前是否真的可用（供前端决定是否展示/可点该开关）。
 * 需要：第三方三项配齐，且没有被运维开关强制切回 DeepSeek。
 */
export function roleplayUnlimitedAvailable(): { available: boolean; zh: string | null; en: string | null } {
  const pick = (prefix: 'RP_ZH' | 'RP_EN') => {
    if (forcedProvider(prefix) === 'deepseek') return null;
    const cfg = readBranch(prefix);
    return cfg ? cfg.model : null;
  };
  const zh = pick('RP_ZH');
  const en = pick('RP_EN');
  return { available: !!(zh || en), zh, en };
}

/** 当前路由概览（供健康检查 / 启动日志 / 排查用，不参与业务逻辑） */
export function roleplayRoutingSummary(): { zh: string; en: string; zhReason: RoleplayProviderReason; enReason: RoleplayProviderReason; aux: string } {
  const zh = roleplayClientFor('zh');
  const en = roleplayClientFor('en');
  const aux = roleplayAuxClientFor();
  const label = (c: RoleplayClientChoice) =>
    c.viaCompat ? c.model : 'deepseek(default)' + (c.reason === 'forced' ? ' [RP_PROVIDER 强制]' : '');
  return { zh: label(zh), en: label(en), zhReason: zh.reason, enReason: en.reason, aux: label(aux) };
}
