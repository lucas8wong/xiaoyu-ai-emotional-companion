/**
 * 审阅队列构建 —— 「去除账号关联后的人工审阅」的结构层。
 *
 * 目的：让运营/开发**不需要知道是谁**也能审阅对话质量（找 bug、看 AI 回复是否满足
 * 用户意图），从而替代「直接翻某个用户的聊天记录」这种既贵又越界的做法。
 *
 * 硬约束（本文件的存在意义）：
 *   产出物里**不得出现** userId / sessionId / scenarioId / email / phone / username /
 *   deviceId / IP。其中三个容易被忽略的回溯路径：
 *     - `scenarioId`：自建剧本 id 能在 customRoleplay 里反查到作者 → 同样不能带。
 *     - `sessionId`：能在 sessions.json 里反查到 userId → 不能带。
 *     - **绝对时间戳**：和别的日志一交叉就能定位到人 → **只保留到分钟、且不带秒**
 *       （2026-09-20 口径变更：原来只给「日粒度 date」，审阅时无法和日志/别处的记录对时间）。
 *       秒级锚点它才够格当唯一键；分钟级配不出唯一性，而「对话内部」的节奏由逐条的
 *       相对偏移 offsetMs 保证（审阅「AI 这条回了多久」靠它，不靠墙上时钟）。
 *   另有 `assertDeidentified()` 在写出前做最后一道断言——宁可不出文件，也不出带身份的队列。
 *
 * 本模块**纯函数、零 I/O**：数据由调用方传入（脚本读真实文件、单测传假数据），
 * 所以单测绝不会碰到真实用户数据（AGENTS.md 红线 3）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { scrubText, scrubMessages, describeHits } from './deidentify.js';

/** 审阅队列里的单条消息：**绝对时刻只到分钟**（见 ReviewItem.startedAt），逐条用相对首条的偏移 */
export interface ReviewMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * 距该会话首条消息的毫秒偏移。保留对话节奏与「AI 这条回了多久」（审阅最需要的信号），
   * 绝对锚点只放在条目级的 startedAt 上（且只到分钟）。
   */
  offsetMs: number;
  /** 以下四项同 ScrubbedMessage：仅 assistant、白名单取值、缺省 = 未记录 */
  viaUnlimited?: boolean;
  model?: string;
  style?: 'classic' | 'immersive';
  incomplete?: boolean;
}

/** 输入：聊一聊会话（结构对齐 storage/memory.ts 的 UserSession，只取需要的字段） */
export interface RawChatSession {
  sessionId?: unknown;
  userId?: unknown;
  chatMessages?: unknown;
  chatTitle?: unknown;
  chatUpdatedAt?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

/** 输入：剧情会话（结构对齐 services/roleplaySessions.ts 的 RoleplaySessionRecord） */
export interface RawRoleplayRecord {
  userId?: unknown;
  scenarioId?: unknown;
  scenarioTitle?: unknown;
  messages?: unknown;
  userPreference?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

/**
 * 审阅界面要显示的「这个用户当时的基础设置」（**白名单**）。
 *
 * 为什么要有：同一条 AI 回复在不同设置下的「好坏」标准完全不同——深度思考档位是
 * off 还是 max、聊一聊用的是哪种陪伴方式、剧情走的是经典还是沉浸叙事，决定了
 * 「这条回复该长什么样」。没有这一层，审阅者会把「设置本来就要求这样」误判成
 * 「模型变差了」（2026-09-20 用户要求：所有样本都要能一眼看到基础设置）。
 *
 * 硬约束：只收下面列出的键、只收**原始类型**，所以 scenarioId 这类能反查到人的键
 * 根本进不来（roleplayUnlimitedByScenario 那张以剧本 id 为 key 的表尤其不能带）。
 */
export interface ReviewSettings {
  mode?: string;              // 陪伴方式：hug 接住我 / ally 挺我一下 / clarify 帮我理清 / light 轻一点看 / objective 客观看看
  tone?: string;              // 语气：warm / direct
  storyStyle?: string;        // 理一理的故事风格：poetic / concise / warm / abstract
  region?: string;            // 地区语气：yuegang / taiwan / us …
  intensity?: string;         // 语气程度：natural / obvious / strong
  language?: string;          // 输出语言：zh-CN / zh-TW / en
  thinkingLevel?: string;     // 深度思考档位：off / low / medium / high / max
  chatInnerMonologue?: boolean;     // 聊一聊括号心理 / 神态
  roleplayInnerMonologue?: boolean; // 剧情括号心理 / 神态
  smartFit?: boolean;         // 智能贴合
  roleplayUnlimited?: boolean;// 剧情无限制模式（全局档）
  proactivePush?: boolean;    // AI 主动找我
  proactiveFrequency?: string;// 主动找我频率
}

/** 允许进队列的设置键（字符串型）——白名单：新增设置项必须显式加进来 */
const SETTINGS_STRING_KEYS: readonly string[] = [
  'mode', 'tone', 'storyStyle', 'region', 'intensity', 'language', 'thinkingLevel', 'proactiveFrequency',
];
/** 允许进队列的设置键（布尔型） */
const SETTINGS_BOOL_KEYS: readonly string[] = [
  'chatInnerMonologue', 'roleplayInnerMonologue', 'smartFit', 'roleplayUnlimited', 'proactivePush',
];
/** 设置项取值长度上限（枚举值都很短；超长一律丢弃，防止把自由文本从这条路带进来） */
const SETTINGS_VALUE_MAX = 24;

/** 归一化设置快照：只留白名单键 + 原始类型；一个都没有时返回 null（= 这次没采到） */
function normalizeSettings(v: unknown): ReviewSettings | null {
  if (!v || typeof v !== 'object') return null;
  const src = v as Record<string, unknown>;
  const bag: Record<string, string | boolean> = {};
  for (const k of SETTINGS_STRING_KEYS) {
    const val = src[k];
    if (typeof val !== 'string') continue;
    const s = val.trim();
    if (s && s.length <= SETTINGS_VALUE_MAX) bag[k] = s;
  }
  for (const k of SETTINGS_BOOL_KEYS) {
    const val = src[k];
    if (typeof val === 'boolean') bag[k] = val;
  }
  return Object.keys(bag).length > 0 ? (bag as ReviewSettings) : null;
}

export interface ReviewItemMeta {
  /** 该会话/剧本此刻的无限制模式口径：true=至少有一轮走了成人模型，false=全部走保守模型，null=老数据未标记 */
  viaUnlimited: boolean | null;
  /** 打了 viaUnlimited 标记的 assistant 轮数（老数据可能是 0） */
  markedTurns: number;
  /** 走了无限制模式的 assistant 轮数 */
  unlimitedTurns: number;
  /** 模型名（消息里存了才有） */
  model: string | null;
  /** 剧本科目 / 对话标题（**已脱敏**：用户自起的名里可能带身份） */
  title: string | null;
  /** 以首条消息为 0 的偏移（毫秒）。**不是绝对时间**，见文件头注释 */
  spanMs: number;
  /**
   * 这段剧情里每条 assistant 回复带的叙事模式计数（如 { immersive: 8 }）。
   * 为什么在条目级再聚一次：叙事模式是**逐条**记的，而审阅者扫列表时要一眼看到
   * 「这段是沉浸档还是经典档」——不然得把每条回复逐条点开才能拼出来。
   */
  styleCounts: Record<string, number>;
}

export interface ReviewItem {
  /** 随机代号。与账号无任何映射关系，且**不落任何映射表**——从队列回不到用户 */
  reviewId: string;
  kind: 'chat' | 'roleplay';
  /** 只到「日」粒度 */
  date: string;
  /** assistant 轮数 */
  turnCount: number;
  /** 用户发言轮数 */
  userTurns: number;
  /**
   * 仅当调用方显式 `includeTest: true` 时才出现（默认不带）。
   * 用来说明「这条来自测试/开发身份，不是真实用户」——队列默认已经把这类整个排除掉了。
   */
  test?: boolean;
  meta: ReviewItemMeta;
  messages: ReviewMessage[];
  /** 这次洗掉了什么，如 ['手机号×2', '姓名×1'] */
  scrubbed: string[];
  droppedAttachments: number;
  /**
   * 稳定指纹：**「同一条对话」的身份** —— 已读/未读追踪靠它，增量档案的去重也靠它。
   *
   * 为什么不能用 reviewId：代号每次重建都重新随机（随机 = 不可反推 = 去标识化的前提），
   * 拿它当已读键的话，重建一次全部样本就集体变回未读——那这个功能等于没有。
   * 指纹取「类型 + 首条时刻（分钟）+ **前两条用户发言**」的加盐哈希；加了固定盐则无法用
   * 彩虹表反查某句话；**不含 userId**，所以它连不回账号。
   *
   * ⚠️ 2026-09-25 两次收口（口径版本见 SAMPLE_KEY_VERSION 的注释）：
   *   · v1 把**尾条内容**也算进指纹 → 同一段对话一续写指纹就变，于是「已读」标记会在用户
   *     又聊两句之后莫名其妙回到未读，增量档案也会把同一段对话记成两条。
   *   · v2 去掉尾条、只锚首条用户发言 → 锚太少：**不同对话**只要起始分钟与第一句话相同就
   *     会撞键（实测 113 条里有 2 组），被误合成一条同样是丢记录。
   *   现在（v3）锚**前两条**用户发言：续写不会改前两条（队列本身要求 ≥2 轮用户发言），
   *   锚点却强了一倍；开头真被裁掉时（剧情只留最近 200 条）由档案层的「用户发言重叠」兜底。
   */
  sampleKey: string;
  /** 指纹口径版本（见 SAMPLE_KEY_VERSION）。老条目缺省/更低 = 需要按当前算法重算 */
  keyVersion?: number;
  /**
   * 规则线索（**规则，不是结论**）：让「哪条更值得点开」在列表上就看得见。
   *
   * 为什么放在构建期算、随条目存下来（而不是像原来那样在前端扫正文）：
   * 列表接口不再返回正文（正文按需单取，否则一页几百条会把手机流量和渲染吃光），
   * 前端就算不出线索了。放在这里算还顺带消除了「前后端各写一份阈值」的漂移风险。
   */
  signals: ReviewSignal[];
  /** 折叠行上的首句预览（首条非空用户发言，已脱敏，最多 80 字）——列表不带正文时靠它扫 */
  preview: string;
  /** 首次进入档案的时刻（毫秒）。增量档案里「这条什么时候开始被我看到的」 */
  archivedAt?: number;
  /** 最近一次刷新正文的时刻（毫秒）：同一段对话续写后会刷新，但 archivedAt 不动 */
  refreshedAt?: number;
  /**
   * 该对话首条消息的**绝对时刻，截断到分钟**（秒与毫秒一律丢掉，取整到 60000 的倍数）。
   *
   * 口径变更（2026-09-20，用户要求「时间戳精确到分钟」）：原来是「只有日粒度的 date」。
   * 保留的隔离度是「秒不出现」——秒级锚点配上别的日志才能唯一定位到某一次请求；
   * 对话**内部**的节奏仍由 offsetMs 保证（审阅「AI 回了多久」靠它，不靠绝对时刻）。
   * 配套：隐私政策第 7 条与审阅页说明同步改成「时间只保留到分钟」。
   */
  startedAt: number;
  /** 末条消息的绝对时刻，同样截断到分钟 */
  lastAt: number;
  /** 该用户当时的基础设置快照（见 ReviewSettings）；调用方没提供就是 null（老队列也没有） */
  settings: ReviewSettings | null;
}

export interface BuildReviewQueueOptions {
  chatSessions?: readonly RawChatSession[];
  roleplayRecords?: readonly RawRoleplayRecord[];
  /**
   * 返回 false 的用户不进队列。调用方传入 `preferenceStore.get(id).dataEnhance !== false`
   * ——这是「允许用于改进服务」开关第一次真正生效的地方。
   */
  shouldInclude?: (userId: string) => boolean;
  /**
   * 判为**测试 / 开发身份**的用户不进队列（默认行为）。
   *
   * 为什么必须分开一档、而不是并进 shouldInclude：两者的含义完全不同——
   * 一个是「用户是否授权」，一个是「这条数据是不是真实用户的」。混在一起会让
   * 统计口径说不清（「跳过的 30 条里多少是没授权的、多少是自测的？」），
   * 更实际的是：审阅的目的是**照真实用户的行为改模型**，自测对话混进来会把结论带偏。
   *
   * 口径由调用方注入（本模块保持零依赖、可单测）：账号级看
   * `accountFilters.isTestAccount / isDeveloperAccount`，设备级看
   * `activity.isTestRequest(undefined, userId)`（`test-` 前缀），复用既有函数而不是抄正则。
   */
  isTestUser?: (userId: string) => boolean;
  /**
   * true = 也把测试身份收进队列，并在条目上标 `test: true`。
   * 默认 false。仅自测/回归调试用——正常审阅不该开。
   */
  includeTest?: boolean;
  /** 最多产出多少条（按最近优先截取），默认 50 */
  limit?: number;
  /** 至少要有几轮用户发言才收（滤掉「你好」这类无信息量样本），默认 2 */
  minUserTurns?: number;
  kinds?: ReadonlyArray<'chat' | 'roleplay'>;
  /** 代号生成器，默认 `rv_` + 12 位随机 hex。测试可注入固定值 */
  idFactory?: () => string;
  /**
   * 取该用户的**基础设置快照**（陪伴方式 / 深度思考档位 / 地区语气 / 括号心理 …）。
   *
   * 为什么由调用方注入：本模块零 I/O（单测绝不碰真实 preferences.json），生产由
   * 路由或构建脚本传 preferenceStore.get(id)。返回值的键会被白名单过滤
   * （见 normalizeSettings），所以多传字段不会造成泄露。
   */
  getUserSettings?: (userId: string) => ReviewSettings | null | undefined;
  now?: number;
}

export interface BuildReviewQueueResult {
  items: ReviewItem[];
  /** 统计口径，便于在控制台显示「为什么只有这么几条」 */
  stats: {
    chatScanned: number;
    roleplayScanned: number;
    /** 因 dataEnhance 关而跳过的会话数 */
    skippedByDataEnhance: number;
    /** 因「测试 / 开发身份」而跳过的会话数（与上一档分开计数，口径才说得清） */
    skippedTest: number;
    /** 因轮数不足 / 空内容而跳过的条数 */
    skippedByFilter: number;
    /** 洗掉的身份命中总计，如 { 手机号: 3 } */
    scrubHits: Record<string, number>;
  };
}

/** 产出物里绝对不允许出现的键（一旦出现即视为泄露，见 assertDeidentified） */
export const FORBIDDEN_KEYS: readonly string[] = [
  'userId',
  'sessionId',
  'scenarioId',
  'email',
  'phone',
  'username',
  'userName',
  'deviceId',
  'ip',
  'characterId',
  'createdWithUnlimited',
];

function defaultIdFactory(): string {
  // 不用 userId 派生（派生 = 可反推 = 不是去标识化），纯随机。
  // 且**不落任何映射表**：代号与账号之间不存在可查的对应关系。
  return 'rv_' + randomBytes(6).toString('hex');
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 把任意值收成「已脱敏的短字符串」，用于 title / userPreference 这类自由文本 */
function scrubShort(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const { text } = scrubText(s);
  return text.slice(0, max);
}

interface BuiltMessages {
  messages: ReviewMessage[];
  hits: Record<string, number>;
  droppedAttachments: number;
  markedTurns: number;
  unlimitedTurns: number;
  model: string | null;
  /** 末条消息相对首条的偏移 = 整个会话跨度 */
  spanMs: number;
  lastAt: number;
  /** 叙事模式计数（只统计记了的 assistant 轮） */
  styleCounts: Record<string, number>;
  /** 首条消息的绝对时刻（原始毫秒；条目级会截断到分钟） */
  firstAt: number;
}

/** 共用：脱敏消息 + 抽 viaUnlimited / model 元数据（剧情链路的调试关键） */
function buildMessages(rawMessages: unknown): BuiltMessages {
  const scrubbed = scrubMessages(rawMessages);
  let markedTurns = 0;
  let unlimitedTurns = 0;
  let model: string | null = null;

  if (Array.isArray(rawMessages)) {
    for (const m of rawMessages) {
      if (!m || typeof m !== 'object') continue;
      const r = m as { role?: unknown; viaUnlimited?: unknown; model?: unknown };
      if (r.role !== 'assistant') continue;
      if (typeof r.viaUnlimited === 'boolean') {
        markedTurns += 1;
        if (r.viaUnlimited) unlimitedTurns += 1;
      }
      if (typeof r.model === 'string' && r.model) model = r.model;
    }
  }

  // 相对时间轴：以首条为 0。绝对锚点只留条目级的 startedAt（且截断到分钟），
  // 逐条保持精确偏移——「AI 这条回了 8 秒」是审阅最需要的信号，不能被分钟粒度抹平。
  // at 为 0（时间不可解析）时一律给 0，别造出负数偏移。
  const base = scrubbed.messages[0]?.at ?? 0;
  const styleCounts: Record<string, number> = {};
  const messages: ReviewMessage[] = scrubbed.messages.map((m) => {
    const out: ReviewMessage = {
      role: m.role,
      content: m.content,
      offsetMs: m.at && base ? Math.max(0, m.at - base) : 0,
    };
    if (m.role === 'assistant') {
      if (typeof m.viaUnlimited === 'boolean') out.viaUnlimited = m.viaUnlimited;
      if (m.model) out.model = m.model;
      if (m.style) { out.style = m.style; styleCounts[m.style] = (styleCounts[m.style] || 0) + 1; }
      if (typeof m.incomplete === 'boolean') out.incomplete = m.incomplete;
    }
    return out;
  });

  const lastAt = scrubbed.messages.length ? scrubbed.messages[scrubbed.messages.length - 1].at : 0;

  return {
    messages,
    hits: scrubbed.hits,
    droppedAttachments: scrubbed.droppedAttachments,
    markedTurns,
    unlimitedTurns,
    model,
    spanMs: messages.length ? messages[messages.length - 1].offsetMs : 0,
    lastAt,
    styleCounts,
    firstAt: base,
  };
}

/** 绝对时刻截断到分钟：秒与毫秒一律丢掉（取整到 60000 的倍数；不可解析的 0 仍是 0） */
function toMinute(ms: number): number {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * 对话身份指纹的**口径版本**。改了锚点/算法就要 +1：档案层靠它判断「这条老条目要不要按新
 * 口径重算」，已读标记靠 keyMap 迁移（见 reviewArchive.mergeArchive）。
 *   1 = 类型 + 首条时刻 + 首条用户发言 + **尾条内容**（尾条会变 → 续写就换键，2026-09-25 弃用）
 *   2 = 去掉尾条，只锚首条用户发言（同日发现锚太少会撞键：不同对话被误合成一条）
 *   3 = 锚**前两条**用户发言（当前）
 */
export const SAMPLE_KEY_VERSION = 3;

/**
 * 稳定指纹（「同一条对话」的身份，已读追踪 + 增量档案去重都用它）：
 * **类型 + 首条时刻（分钟）+ 前两条用户发言**。
 *
 * 为什么是「前两条」而不是「首条」或「首尾」：
 *   · 带上尾条（v1）：用户又聊两句键就变 → 已读标记掉、增量档案把同一段记成两条。
 *   · 只带首条（v2）：锚太少，**不同对话**只要起始分钟与第一句话相同就会撞键
 *     （2026-09-25 实测：113 条里有 2 组撞键，其中一组是两段真正不同的对话）→ 误合成一条。
 *   · 前两条（v3）：对话续写不会改前两条（队列本身要求 ≥2 轮用户发言），锚点却强了一倍。
 *     若开头被裁掉（剧情只留最近 200 条），靠档案层的「用户发言重叠」兜底认回同一条。
 * 加固定盐是为了让「同一句话」在不同语料里也拿不到可比的哈希（挡彩虹表）；
 * 全程不含 userId / sessionId，所以它指不回任何账号——**这也是它只能靠内容的原因**：
 * 任何既稳定又唯一标识对话的 id（连 sessionId 的哈希也算）都会带来一条能被反查/穷举的回溯路径。
 */
function sampleKeyOf(kind: string, startMinute: number, messages: readonly ReviewMessage[]): string {
  const userMsgs: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const s = String(m.content || '').trim();
    if (!s) continue;
    userMsgs.push(s.slice(0, 200));
    if (userMsgs.length === 2) break;
  }
  const raw = ['xiaoyu-review-v3', kind, String(startMinute), userMsgs[0] || '', userMsgs[1] || ''].join('|');
  return 'sk_' + createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** v1 口径（含尾条）：只用于把 2026-09-25 之前生成的条目/已读标记迁移到当前键 */
function legacySampleKeyOf(kind: string, startMinute: number, messages: readonly ReviewMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const tail = messages.length > 0 ? messages[messages.length - 1].content : '';
  const raw = ['xiaoyu-review-v1', kind, String(startMinute), firstUser.slice(0, 200), tail.slice(0, 120)].join('|');
  return 'sk_' + createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 规则线索（列表上提示「哪条更值得点开」；**规则不是结论**） */
export interface ReviewSignal {
  k: string;
  t: string;
  cls: 'hot' | 'warm' | 'dim';
}

/**
 * 线索粗筛。四条规则都来自真实踩过的坑（AI 用问句收尾 / 半截回复 / 首字慢 / 超短回复）。
 *
 * 阈值**只此一份**：前端只负责把这里算好的结果画出来（原来这段在前端 admin.html，
 * 列表不带正文之后就必然算不出来；放到这里也顺手消掉了「前后端各写一份阈值」的漂移）。
 */
export function signalsOf(messages: readonly ReviewMessage[]): ReviewSignal[] {
  const out: ReviewSignal[] = [];
  let half = 0, ask = 0, tiny = 0, slow = 0;
  let prev: number | null = null;
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.incomplete === true) half += 1;
      const body = String(m.content || '').trim();
      if (/[?？]["'”』」）)]*$/.test(body)) ask += 1;
      if (body.length > 0 && body.length < 20) tiny += 1;
      if (prev !== null && (m.offsetMs - prev) > 20000) slow += 1;
    }
    prev = m.offsetMs || 0;
  }
  if (half) out.push({ k: 'half', t: `半截回复 ×${half}`, cls: 'hot' });
  if (ask >= 2) out.push({ k: 'ask', t: `AI 用问句收尾 ×${ask}`, cls: 'warm' });
  if (slow) out.push({ k: 'slow', t: `回复偏慢(>20s) ×${slow}`, cls: 'warm' });
  if (tiny >= 2) out.push({ k: 'tiny', t: `超短回复(<20字) ×${tiny}`, cls: 'dim' });
  return out;
}

/** 折叠行上的首句预览（首条非空用户发言，已脱敏）——列表不带正文时靠它扫 */
export function previewOf(messages: readonly ReviewMessage[], max = 80): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const s = String(m.content || '').trim();
    if (s) return s.slice(0, max);
  }
  return '';
}

/** 条目「身份键」：新条目直接用 sampleKey；老口径条目按当前算法重算（键会变，由档案层迁移已读标记） */
export function itemSampleKey(item: Pick<ReviewItem, 'kind' | 'startedAt' | 'messages'> & { keyVersion?: number; sampleKey?: string }): string {
  if (item.keyVersion === SAMPLE_KEY_VERSION && typeof item.sampleKey === 'string' && item.sampleKey) return item.sampleKey;
  return sampleKeyOf(item.kind, item.startedAt, item.messages || []);
}

/** 老条目的 v1 键（迁移已读标记时用来找回旧键） */
export function itemLegacyKey(item: Pick<ReviewItem, 'kind' | 'startedAt' | 'messages'>): string {
  return legacySampleKeyOf(item.kind, item.startedAt, item.messages || []);
}

/** 列表用的轻量条目：**去掉正文**（正文由 /review-queue/item 按需单取，手机才不会一口气拉几 MB） */
export type ReviewItemSummary = Omit<ReviewItem, 'messages'> & { messageCount: number };

/** 把完整条目压成列表条目（列表与档案共用一份口径，避免两处各写一遍） */
export function summarizeItem(item: ReviewItem): ReviewItemSummary {
  const { messages, ...rest } = item;
  return { ...rest, messageCount: Array.isArray(messages) ? messages.length : 0 };
}

/**
 * 构建审阅队列。纯函数：同样的输入 + 同样的 idFactory 得到同样的输出。
 */
export function buildReviewQueue(opts: BuildReviewQueueOptions = {}): BuildReviewQueueResult {
  const {
    chatSessions = [],
    roleplayRecords = [],
    shouldInclude,
    isTestUser,
    includeTest = false,
    limit = 50,
    minUserTurns = 2,
    kinds = ['chat', 'roleplay'],
    idFactory = defaultIdFactory,
    getUserSettings,
  } = opts;

  const stats: BuildReviewQueueResult['stats'] = {
    chatScanned: 0,
    roleplayScanned: 0,
    skippedByDataEnhance: 0,
    skippedTest: 0,
    skippedByFilter: 0,
    scrubHits: {},
  };
  /**
   * 统一的「该不该收这条」前置判定。返回 null = 收；返回 true 以外的原因 = 已被计入 stats 并跳过。
   * 抽出共用是为了让 chat / roleplay 两条路**不会各写一份口径**（那种漂移以前吃过亏）。
   */
  const preCheck = (userId: string): { skip: true; test: boolean } | { skip: false; test: boolean } => {
    const isTest = isTestUser ? isTestUser(userId) === true : false;
    if (isTest) {
      stats.skippedTest += 1;
      // 默认整条排除；显式 includeTest 才收，且条目上会带 test: true 标出来
      if (!includeTest) return { skip: true, test: true };
    }
    if (shouldInclude && !shouldInclude(userId)) {
      stats.skippedByDataEnhance += 1;
      return { skip: true, test: isTest };
    }
    return { skip: false, test: isTest };
  };
  const merge = (h: Record<string, number>) => {
    for (const [k, v] of Object.entries(h)) stats.scrubHits[k] = (stats.scrubHits[k] || 0) + v;
  };
  /**
   * 该用户的基础设置快照（白名单过滤；调用方没传 getter 就是 null）。
   * 放在这里取、在条目里带上：userId 出了这个函数就没了，之后再也补不上。
   */
  const settingsOf = (userId: string): ReviewSettings | null =>
    normalizeSettings(getUserSettings ? getUserSettings(userId) : null);

  // 收集候选（带时间用于排序），最后统一按最近优先截取
  const candidates: Array<{ sortAt: number; item: ReviewItem }> = [];

  if (kinds.includes('chat')) {
    for (const s of chatSessions) {
      // 防御：宁可跳过一条脏记录，也不能让整个队列生成崩掉（崩 = 功能直接不可用）
      if (!s || typeof s !== 'object') continue;
      const userId = typeof s.userId === 'string' ? s.userId : '';
      if (!userId) continue;
      stats.chatScanned += 1;
      const pre = preCheck(userId);
      if (pre.skip) continue;
      if (!Array.isArray(s.chatMessages) || s.chatMessages.length === 0) { stats.skippedByFilter += 1; continue; }

      const b = buildMessages(s.chatMessages);
      const userTurns = b.messages.filter((m) => m.role === 'user').length;
      if (userTurns < minUserTurns) { stats.skippedByFilter += 1; continue; }

      const lastAt = b.lastAt || toMs(s.chatUpdatedAt) || toMs(s.updatedAt) || toMs(s.createdAt);
      const title = scrubShort(s.chatTitle);
      const startedAt = toMinute(b.firstAt);
      const endedAt = toMinute(lastAt) || startedAt;
      candidates.push({
        sortAt: lastAt,
        item: {
          reviewId: idFactory(),
          kind: 'chat',
          // 只有 includeTest 时才可能出现——默认整类已被排除
          ...(pre.test ? { test: true } : {}),
          date: dayOf(lastAt || Date.now()),
          turnCount: b.messages.length - userTurns,
          userTurns,
          meta: {
            viaUnlimited: null, // 聊一聊不是剧情链路，无此口径
            markedTurns: 0,
            unlimitedTurns: 0,
            model: b.model,
            title,
            spanMs: b.spanMs,
            styleCounts: b.styleCounts,
          },
          messages: b.messages,
          scrubbed: describeHits(b.hits),
          droppedAttachments: b.droppedAttachments,
          sampleKey: sampleKeyOf('chat', startedAt, b.messages),
          keyVersion: SAMPLE_KEY_VERSION,
          signals: signalsOf(b.messages),
          preview: previewOf(b.messages),
          startedAt,
          lastAt: endedAt,
          settings: settingsOf(userId),
        },
      });
      merge(b.hits);
    }
  }

  if (kinds.includes('roleplay')) {
    for (const r of roleplayRecords) {
      if (!r || typeof r !== 'object') continue;
      const userId = typeof r.userId === 'string' ? r.userId : '';
      if (!userId) continue;
      stats.roleplayScanned += 1;
      const pre = preCheck(userId);
      if (pre.skip) continue;
      if (!Array.isArray(r.messages) || r.messages.length === 0) { stats.skippedByFilter += 1; continue; }

      const b = buildMessages(r.messages);
      const userTurns = b.messages.filter((m) => m.role === 'user').length;
      if (userTurns < minUserTurns) { stats.skippedByFilter += 1; continue; }

      // 剧本科目 + 用户反馈都脱敏：用户自起的剧名/反馈里可能带身份
      const title = scrubShort(r.scenarioTitle);
      const pref = scrubShort(r.userPreference);
      const titleWithPref = pref ? (title ? `${title} · 反馈：${pref}` : `反馈：${pref}`) : title;

      const lastAt = b.lastAt || toMs(r.updatedAt) || toMs(r.createdAt);
      const startedAt = toMinute(b.firstAt);
      const endedAt = toMinute(lastAt) || startedAt;
      candidates.push({
        sortAt: lastAt,
        item: {
          reviewId: idFactory(),
          kind: 'roleplay',
          ...(pre.test ? { test: true } : {}),
          date: dayOf(lastAt || Date.now()),
          turnCount: b.messages.length - userTurns,
          userTurns,
          meta: {
            viaUnlimited: b.markedTurns > 0 ? b.unlimitedTurns > 0 : null,
            markedTurns: b.markedTurns,
            unlimitedTurns: b.unlimitedTurns,
            model: b.model,
            title: titleWithPref,
            spanMs: b.spanMs,
            styleCounts: b.styleCounts,
          },
          messages: b.messages,
          scrubbed: describeHits(b.hits),
          droppedAttachments: b.droppedAttachments,
          sampleKey: sampleKeyOf('roleplay', startedAt, b.messages),
          keyVersion: SAMPLE_KEY_VERSION,
          signals: signalsOf(b.messages),
          preview: previewOf(b.messages),
          startedAt,
          lastAt: endedAt,
          settings: settingsOf(userId),
        },
      });
      merge(b.hits);
    }
  }

  candidates.sort((a, b) => b.sortAt - a.sortAt);
  return { items: candidates.slice(0, Math.max(0, limit)).map((c) => c.item), stats };
}

/**
 * 泄露护栏：扫描产出物，返回问题清单（空数组 = 干净）。
 *
 * 两道检查：
 *   ① 结构：出现 FORBIDDEN_KEYS 里任何键（含嵌套）。
 *   ② 取值：`knownValues`（各来源用户的 userId / 邮箱 / 手机号）出现在任何字符串里。
 *      只查结构不够——userId 可能被拼进正文或标题。
 *
 * 用法：构建脚本在写盘前调用，**非空就拒绝写文件**；单测用它做回归断言。
 */
export function findIdentityLeaks(items: unknown, knownValues: readonly string[] = []): string[] {
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  // 长度阈值 8：后台展示用户名/游客标签时一律取 userId 前 8 位（见 paymentAdmin 的
  // `userId.slice(0, 8)`），说明真实 userId ≥ 8 位。阈值取小了会把正文里的普通短词
  // 误判成身份值，进而让整个队列 fail-closed 生成不出来——那是不可用的护栏。
  const needles = knownValues.filter((v) => typeof v === 'string' && v.length >= 8);

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const n of needles) {
        if (node.includes(n)) problems.push(`取值泄露：${path} 含已知身份值`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(k) && !seenKeys.has(k)) {
          seenKeys.add(k);
          problems.push(`结构泄露：出现禁用键 \`${k}\`（${path || 'root'}）`);
        }
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };

  walk(items, '');
  return problems;
}

/** 泄露护栏的断言版：有问题直接抛，供构建脚本 fail-closed 使用 */
export function assertDeidentified(items: unknown, knownValues: readonly string[] = []): void {
  const problems = findIdentityLeaks(items, knownValues);
  if (problems.length > 0) {
    throw new Error(
      `审阅队列去标识化断言失败（拒绝写出）：\n- ${problems.slice(0, 10).join('\n- ')}` +
      (problems.length > 10 ? `\n…共 ${problems.length} 处` : '')
    );
  }
}

export default { buildReviewQueue, findIdentityLeaks, assertDeidentified, FORBIDDEN_KEYS };
