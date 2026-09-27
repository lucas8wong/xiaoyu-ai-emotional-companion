/**
 * 用户行为追踪：功能使用计数（聊一聊/理一理/剧情扮演）+ 登录记录 + 活跃度
 * 持久化到 data/user-activity.json（tmp 原子写，模式与 usage.ts 一致）
 * 供运营端「用户行为分析」页面判断：谁在用、用了什么、多久没回来了
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { behaviorDailyStore } from './behaviorDaily.js';
// 邀请结算（B 方案·2026-09-19）：被邀人「首次真实使用」才给邀请人发奖——所有功能成功路径都收口在这里，
// 所以挂在这个函数上最省事、也不会漏路径。依赖方向 activity → inviteQualify → quota 是单向的
// （quota 链上没有任何模块反向 import activity），所以这里用静态 import 是安全的。
import { onUserFirstRealUse } from './inviteQualify.js';

const FILE = dataFile('user-activity.json');

/** 用户「变得活跃」回调（供召回模块判断：被召回的用户回来即算回访成功） */
export type ActiveListener = (userId: string) => void;
let onUserActive: ActiveListener | undefined;
/** 注册「用户活跃」监听；仅在需要计回访时注册（activity 自身不依赖召回模块，避免循环引用） */
export function setOnUserActive(fn: ActiveListener): void {
  onUserActive = fn;
}

export type FeatureKey = 'chat' | 'structure' | 'roleplay';

/**
 * 「剧情演绎」里的三种模式（仅 feature === 'roleplay' 时有意义）：
 *  - `roleplay`  角色剧情扮演（选一个剧本，和角色对话）
 *  - `wenyou`    AI 文游（千世书引擎，按回合）
 *  - `werewolf`  AI 狼人杀（**按局**计，一次开局记一次，不按轮）
 *
 * 口径：`roleplayCount`（及按日的 `roleplay` 桶）仍是**三者合计**，数值口径不变、老数据不断层；
 * 本字段只回答「这堆总轮次里，用户玩的是哪一种模式」。明细自 2026-09-16 起累计——
 * 早于该日的历史只有合计，`rpModes` 全 0（**不做历史回溯**）。
 */
export type RoleplayMode = 'roleplay' | 'wenyou' | 'werewolf';
export const ROLEPLAY_MODES: RoleplayMode[] = ['roleplay', 'wenyou', 'werewolf'];
/** 模式明细零值（旧记录没有 `rpModes` 字段，读回时用它兜底） */
export const zeroRoleplayModes = (): Record<RoleplayMode, number> => ({ roleplay: 0, wenyou: 0, werewolf: 0 });
/** 把任意（可能是旧的/脏的）rpModes 归一化成完整三键 */
export function normRoleplayModes(v: unknown): Record<RoleplayMode, number> {
  const out = zeroRoleplayModes();
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const m of ROLEPLAY_MODES) out[m] = Math.max(0, Math.floor(Number(o[m]) || 0));
  }
  return out;
}

/** 一次功能使用记录（供 AI 行为感知注入：仅元信息，不含对话内容） */
export interface RecentActivityItem {
  feature: FeatureKey;
  /** 对象级信息（如剧情扮演的剧本标题、狼人杀的局型）；无则省略 */
  detail?: string;
  /** 剧情演绎的模式（仅 feature === 'roleplay' 时存在；旧记录可能没有 → 视为「剧情扮演」） */
  mode?: RoleplayMode;
  at: number;
}

export interface LoginRecord {
  at: number;                 // 时间戳（ms）
  method: 'login' | 'register';
  ip?: string;
  /** ISO 国家码（cf-ipcountry / x-vercel-ip-country，仅经代理时存在，P1 修复） */
  country?: string;
}

export interface UserActivity {
  userId: string;
  firstSeenAt: number;        // 首次出现（任意功能/登录）
  lastActiveAt: number;       // 最近一次使用（功能或登录）
  lastFeature: FeatureKey | null;
  chatCount: number;          // 聊一聊：成功回复的对话轮次
  structureCount: number;     // 理一理：成功发起情绪分析的次数
  /** 剧情演绎**合计**轮次 = rpModes 三者之和（口径自始未变，老数据不断层） */
  roleplayCount: number;
  /**
   * 剧情演绎的模式明细（角色剧情扮演 / AI 文游 / AI 狼人杀）。
   * 仅自 2026-09-16 起累计；旧记录无此字段 → 读回时归一化为全 0（历史轮次只体现在 roleplayCount 里）。
   */
  rpModes?: Record<RoleplayMode, number>;
  /** 最近一次「剧情演绎」用的是哪种模式（供运营端一眼看出「最近在玩哪个」） */
  lastMode?: RoleplayMode | null;
  recentActivity: RecentActivityItem[]; // 最近功能使用（滚动保留，供 AI 行为感知；仅元信息，无内容）
  loginCount: number;
  lastLoginAt: number | null;
  lastLoginMethod: string | null;
  logins: LoginRecord[];      // 最近 MAX_LOGINS 条
  lastIp?: string;            // 最近一次出现（功能使用/登录）的 IP，供运营 IP 分布统计（含游客）
  /** 最近一次出现的 ISO 国家码（P1 修复：地区统计海外优先用国家码） */
  lastCountry?: string;
  /** 安装/下载 Xiaoyu 的次数（PWA 装上桌/主屏，含 iOS「添加到主屏」） */
  installCount?: number;
  /** 最近一次安装/下载时间戳（ms） */
  installedAt?: number | null;
}

const MAX_LOGINS = 20;
const MAX_RECENT = 10; // 行为感知：最多保留的最近活动条数

class ActivityStore {
  private map: Map<string, UserActivity> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<UserActivity[]>(FILE, []);
    if (Array.isArray(parsed)) parsed.forEach((r: UserActivity) => {
      if (!r?.userId) return;
      // 兼容旧记录：`rpModes` 是后加的字段（2026-09-16），旧数据没有 → 归一化为全 0（历史只体现在 roleplayCount）
      r.rpModes = normRoleplayModes(r.rpModes);
      if (r.lastMode && !ROLEPLAY_MODES.includes(r.lastMode)) r.lastMode = null;
      this.map.set(r.userId, r);
    });
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.map.values()));
    } catch (e) {
      console.warn('⚠️ [Activity] 保存用户行为数据失败:', (e as Error)?.message);
    }
  }

  get(userId: string): UserActivity | undefined {
    return this.map.get(userId);
  }

  listAll(): UserActivity[] {
    return Array.from(this.map.values());
  }

  /**
   * 记录一次功能使用（成功路径调用）；detail 为对象级信息（如剧情扮演的剧本标题）；ip 为来源地址（游客与注册用户都记，供 IP 分布统计）；country 为 ISO 国家码。
   * `mode` 仅对 feature === 'roleplay' 有意义（剧情扮演 / AI 文游 / AI 狼人杀），缺省按「剧情扮演」——老的三个调用点因此无需改动。
   */
  trackFeature(userId: string, feature: FeatureKey, opts?: { detail?: string; ip?: string; country?: string; mode?: RoleplayMode }): void {
    if (!userId) return;
    const now = Date.now();
    const cur = this.map.get(userId) || {
      userId, firstSeenAt: now, lastActiveAt: now, lastFeature: null,
      chatCount: 0, structureCount: 0, roleplayCount: 0, recentActivity: [],
      loginCount: 0, lastLoginAt: null, lastLoginMethod: null, logins: [],
    };
    if (feature === 'chat') cur.chatCount += 1;
    else if (feature === 'structure') cur.structureCount += 1;
    else if (feature === 'roleplay') cur.roleplayCount += 1;
    /**
     * 剧情演绎的模式明细：只在 feature === 'roleplay' 时累加。
     * ⚠️ 这里**不改** roleplayCount 的语义（仍是三模式合计），所以明细之和恒等于它——
     * 运营端可以放心用「合计 − 文游 − 狼人杀」得到剧情扮演轮次，不会出现负数。
     * `rpModes` 对所有记录都补齐三键（控制台与接口不必到处判空）。
     */
    cur.rpModes = normRoleplayModes(cur.rpModes);
    const mode: RoleplayMode | null = feature === 'roleplay' ? (opts?.mode || 'roleplay') : null;
    if (mode) {
      cur.rpModes[mode] += 1;
      cur.lastMode = mode;
    }
    if (opts?.ip) cur.lastIp = opts.ip;
    if (opts?.country) cur.lastCountry = String(opts.country).slice(0, 2).toUpperCase();
    cur.lastActiveAt = now;
    cur.lastFeature = feature;
    cur.recentActivity = cur.recentActivity || [];
    const item: RecentActivityItem = { feature, at: now };
    if (mode) item.mode = mode;
    if (opts?.detail) item.detail = String(opts.detail).slice(0, 40);
    cur.recentActivity.push(item);
    if (cur.recentActivity.length > MAX_RECENT) cur.recentActivity = cur.recentActivity.slice(-MAX_RECENT);
    this.map.set(userId, cur);
    behaviorDailyStore.addEvent(userId, feature, now, mode || undefined);
    this.saveToDisk();
    if (onUserActive) onUserActive(userId);
    // 成功跑通一次功能 = 「真的开口用了」→ 若是经推广链接注册且还在待激活，结算邀请奖励
    // （幂等；绝大多数用户不是待激活，qualifyInvite 里第一行就返回）
    onUserFirstRealUse(userId);
  }

  /** 记录一次「安装/下载 Xiaoyu」（PWA 装到桌面/主屏，含 iOS 添加到主屏） */
  trackInstall(userId: string, opts: { ip?: string; country?: string }): void {
    if (!userId) return;
    const now = Date.now();
    const cur = this.map.get(userId) || {
      userId, firstSeenAt: now, lastActiveAt: now, lastFeature: null,
      chatCount: 0, structureCount: 0, roleplayCount: 0, recentActivity: [],
      loginCount: 0, lastLoginAt: null, lastLoginMethod: null, logins: [],
      installCount: 0, installedAt: null,
    };
    cur.installCount = (cur.installCount || 0) + 1;
    cur.installedAt = now;
    if (opts.ip) cur.lastIp = opts.ip;
    if (opts.country) cur.lastCountry = String(opts.country).slice(0, 2).toUpperCase();
    cur.lastActiveAt = Math.max(cur.lastActiveAt || 0, now);
    this.map.set(userId, cur);
    behaviorDailyStore.addEvent(userId, 'install', now);
    this.saveToDisk();
    if (onUserActive) onUserActive(userId);
  }

  /** 记录一次登录/注册 */
  trackLogin(userId: string, opts: { method: 'login' | 'register'; ip?: string; country?: string }): void {
    if (!userId) return;
    const now = Date.now();
    const cur = this.map.get(userId) || {
      userId, firstSeenAt: now, lastActiveAt: now, lastFeature: null,
      chatCount: 0, structureCount: 0, roleplayCount: 0, recentActivity: [],
      loginCount: 0, lastLoginAt: null, lastLoginMethod: null, logins: [],
    };
    cur.loginCount += 1;
    cur.lastLoginAt = now;
    cur.lastLoginMethod = opts.method;
    if (opts.ip) cur.lastIp = opts.ip;
    if (opts.country) cur.lastCountry = String(opts.country).slice(0, 2).toUpperCase();
    cur.lastActiveAt = Math.max(cur.lastActiveAt, now);
    cur.logins.push({ at: now, method: opts.method, ip: opts.ip, country: opts.country ? String(opts.country).slice(0, 2).toUpperCase() : undefined });
    if (cur.logins.length > MAX_LOGINS) cur.logins = cur.logins.slice(-MAX_LOGINS);
    this.map.set(userId, cur);
    behaviorDailyStore.addEvent(userId, 'login', now);
    this.saveToDisk();
    if (onUserActive) onUserActive(userId);
  }

  /** 游客行为计数并入账号（注册/登录时调用，与 roleplaySession/memory 等合并保持同步） */
  mergeFrom(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const from = this.map.get(fromId);
    if (!from) return;
    const to = this.map.get(toId) || {
      userId: toId, firstSeenAt: from.firstSeenAt, lastActiveAt: from.lastActiveAt, lastFeature: null,
      chatCount: 0, structureCount: 0, roleplayCount: 0, recentActivity: [],
      loginCount: 0, lastLoginAt: null, lastLoginMethod: null, logins: [],
    };
    const toWasActiveAt = to.lastActiveAt || 0; // 合并前的活跃时刻（下面 lastActiveAt 会被取 max，之后无法再比较）
    to.chatCount += from.chatCount;
    to.structureCount += from.structureCount;
    to.roleplayCount += from.roleplayCount;
    // 模式明细一并并入：否则「游客期玩的文游/狼人杀」会在注册合并后从控制台消失（只剩合计）
    const fromModes = normRoleplayModes(from.rpModes);
    const toModes = normRoleplayModes(to.rpModes);
    for (const m of ROLEPLAY_MODES) toModes[m] += fromModes[m];
    to.rpModes = toModes;
    // 最近模式取「两个身份里更近活跃的那一个」——与 lastFeature 的合并方向保持一致
    if ((from.lastMode && (from.lastActiveAt || 0) >= toWasActiveAt) || (!to.lastMode && from.lastMode)) {
      to.lastMode = from.lastMode;
    }
    if (!to.lastMode) to.lastMode = null;
    to.installCount = (to.installCount || 0) + (from.installCount || 0);
    if (!to.installedAt && from.installedAt) to.installedAt = from.installedAt;
    to.loginCount += from.loginCount;
    to.firstSeenAt = Math.min(to.firstSeenAt || from.firstSeenAt, from.firstSeenAt);
    to.lastActiveAt = Math.max(to.lastActiveAt || 0, from.lastActiveAt);
    if (!to.lastFeature && from.lastFeature) to.lastFeature = from.lastFeature;
    if (!to.lastLoginAt || (from.lastLoginAt && from.lastLoginAt > to.lastLoginAt)) {
      to.lastLoginAt = from.lastLoginAt;
      to.lastLoginMethod = from.lastLoginMethod;
    }
    to.logins = to.logins.concat(from.logins).sort((a, b) => b.at - a.at).slice(0, MAX_LOGINS);
    to.recentActivity = (to.recentActivity || []).concat(from.recentActivity || [])
      .sort((a, b) => b.at - a.at).slice(0, MAX_RECENT);
    behaviorDailyStore.mergeUsers(fromId, toId);
    this.map.set(toId, to);
    this.map.delete(fromId);
    this.saveToDisk();
  }

  /** 行为感知：返回该用户最近的 10 条功能使用（按时间倒序） */
  getRecentActivity(userId: string): RecentActivityItem[] {
    const cur = this.map.get(userId);
    if (!cur || !cur.recentActivity) return [];
    return [...cur.recentActivity].sort((a, b) => b.at - a.at);
  }

  /** 账户注销时清理（合规：个人数据删除） */
  remove(userId: string): void {
    if (this.map.delete(userId)) {
      behaviorDailyStore.deleteUser(userId);
      this.saveToDisk();
    }
  }
}

export const activityStore = new ActivityStore();

/**
 * 判断是否测试请求（不写入用户行为统计）
 * 测试判定：x-device-id 以 test- 开头，或 IP 落在 RFC 5737 测试网段（203.0.113.x）
 */
export function isTestRequest(ip?: string, deviceId?: string): boolean {
  if (deviceId && /^test-|^TEST-/i.test(deviceId)) return true;
  if (ip && /^203\.0\.113\./.test(ip)) return true;
  return false;
}
