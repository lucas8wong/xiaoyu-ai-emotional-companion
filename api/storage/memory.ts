/**
 * 会话存储模块（文件持久化版）
 * 管理用户会话、情感分析数据和AI生成内容
 * 会话数据持久化到 data/sessions.json，进程重启不丢失
 */

import { dataFile, readJson, writeJson } from './persistence.js';
// 保留期分层判据需要知道「这个 userId 是不是登录账号」：accounts.ts 只依赖持久化层，不反向依赖本模块（无循环）
import { accountStore } from '../services/accounts.js';

export interface EmotionAnalysis {
  id: string;
  category?: string;
  emotion: string;
  intensity: number;
  timestamp: Date;
  analysis: string;
  suggestions: string[];
}

export interface Question {
  id: string;
  question: string;
  answer?: string;
  timestamp: Date;
}

export interface DetailedAnalysis {
  id: string;
  category?: string;
  emotionalState: string;
  triggers: string[];
  coreIssues: string[];
  recommendations: string[];
  positiveFactors: string[];
  timestamp: Date;
}

export interface HealingStory {
  id: string;
  title: string;
  content: string;
  mood: string;
  timestamp: Date;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  image?: string; // 用户消息附带的图片（base64 data URL，视觉理解）
  audio?: string; // 微信式语音气泡：用户消息附带的录音 data URL（前端点播；模型靠 content 理解）
  /** 引用回复：这条用户消息是在回复哪一句（落库，刷新/换设备后引用卡还在；也是提示词「本轮回复指向」的来源）
   *  kind：被引用的是纯图片/纯语音消息（本身没有文字）时记下类型，界面用占位词而不是空白卡。
   *  at：被引用消息的时间戳——界面「点引用块跳回原消息」时用它定位（消息 id 会随刷新而变，时间戳不会）。 */
  replyTo?: { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio'; at?: string };
  /**
   * 这条回复引用的**来源链接**（2026-09-29）：本轮 `web_search` 命中的结构化结果（路由层收口后最多 3 条）。
   *
   * 为什么要落库：在这之前来源只活在服务端的工具结果里，前端只收到一个布尔 search 事件 —— 于是
   * 「链接」能不能被用户看到，全看模型愿不愿意把 URL 写进正文；用户不问就常常没有，刷新更是一点不剩。
   * 现在随消息持久化，气泡下方常显。缺省 undefined = 该轮没有搜索（或历史老数据）——
   * **不要**用空数组回填，那会把「没搜」和「搜了但没结果」混成同一件事。
   */
  sources?: { title: string; url: string; host?: string }[];
  /**
   * **按段**的来源（2026-09-29）：段下标＝气泡下标（回复按 \n\n 分段发送，一段＝一条气泡）。
   * 模型引用「实时资讯速览」里某条时，它的出处要挂在**提到它的那条气泡**下面，
   * 而不是把整轮命中都堆在最后一条 —— 那样读者对不上哪句是哪条的出处。null = 该段没有引用。
   * 与 `sources` 并存：前者回答「这句从哪来」，后者回答「这一轮查到的都在这里」。
   */
  sourceSegments?: ({ title: string; url: string; host?: string }[] | null)[];
}

export interface UserSession {
  sessionId: string;
  userId?: string; // 所属用户（设备指纹+IP 生成），用于历史记录查询
  emotionAnalysis?: EmotionAnalysis;
  rawInput?: string; // 用户原始输入文本（理一理语言跟随：检测用户输入字体）
  questions: Question[];
  detailedAnalysis?: DetailedAnalysis;
  healingStory?: HealingStory;
  chatMessages?: ChatMessage[]; // 聊一聊（对话陪伴模式）的消息历史
  chatTitle?: string; // 聊一聊对话标题（取首条用户消息，自动生成）
  chatUpdatedAt?: Date; // 聊一聊对话最近更新时间（用于多对话排序）
  chatPinned?: boolean; // 聊一聊对话置顶（置顶会话排在列表最前，且不受每用户会话上限清理影响）
  characterId?: string; // 聊一聊当前角色（缺省/内置默认 = 小愈），用于每角色独立会话线
  /**
   * 这条会话上次被用户「读到」的时刻（ms）——未读数的唯一来源（方案 A2 微信式消息列表）。
   *
   * 口径（刻意保守，别改成"存在即未读"）：
   *  - `undefined`（老数据）= **视为已读**。否则上线那一刻，所有人历史里的回复都会变成未读。
   *  - 打开会话（GET /chats/:id）、在读的时候收发消息（POST /chat/read）都会把它推到 now。
   *  - 角色主动发来的消息（reengage 的 in-app 通道）**不动**这个字段 → 自然成为未读。
   */
  chatLastReadAt?: number;
  createdAt: Date;
  updatedAt: Date;
}

const SESSIONS_FILE = dataFile('sessions.json');

// 聊一聊保留上限（防止 sessions.json 无界膨胀）：单会话最多保留最近 N 条消息；每用户最多保留最近 N 个聊天会话，更早的自动清理
const MAX_CHAT_MSGS = 100;
const MAX_CHAT_SESSIONS = 50;

// 会话保留期（分层）：按「最后活跃 updatedAt」起算——游客（设备身份）= 7 天；登录账号 = 30 天。
// 判据：会话 userId 命中 accounts.json（accountStore.getById）= 登录账号；游客 id / 无主遗留会话按 7 天。
const GUEST_SESSION_TIMEOUT = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000;

/** 仅把「已知日期字段」的 ISO 字符串还原为 Date，避免误伤用户消息内容（如恰好形如时间戳的文本） */
const DATE_KEYS = new Set(['timestamp', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'chatUpdatedAt']);
function reviveDates(key: string, value: any): any {
  if (DATE_KEYS.has(key) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return value;
}

/** 兼容 Date 与 ISO 字符串，取毫秒时间戳（防御磁盘上可能残留的字符串日期） */
function toTime(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * 未读条数（方案 A2 微信式消息列表）：`chatLastReadAt` 之后**角色说过的话**算未读。
 *
 * 为什么只算 assistant：用户自己发的消息不需要"未读"；把用户消息也算进去会让角标在
 * 用户自己发完消息后仍然挂着（每次发消息都要立刻清零，容易漏）。
 *
 * 为什么 undefined 视为已读：这个字段是 2026-09-20 新加的，老会话没有它；
 * 若按"存在即未读"处理，上线当天所有历史回复都会变成未读角标（假红点）。
 */
export function countUnread(session: UserSession): number {
  const lastRead = session?.chatLastReadAt;
  if (typeof lastRead !== 'number' || !Number.isFinite(lastRead)) return 0;
  return (session.chatMessages || []).filter((m) => m.role === 'assistant' && toTime(m.timestamp) > lastRead).length;
}

/**
 * 文件持久化存储类
 */
class MemoryStorage {
  private sessions: Map<string, UserSession> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;

  /** 该会话适用的保留期：登录账号 30 天；游客（设备身份）/无主遗留会话 7 天 */
  private retentionFor(session: UserSession): number {
    return session.userId && accountStore.getById(session.userId) ? ACCOUNT_SESSION_TIMEOUT : GUEST_SESSION_TIMEOUT;
  }

  /** 是否已过保留期（按最后活跃 updatedAt 判定） */
  private isExpired(session: UserSession, now: number = Date.now()): boolean {
    return now - session.updatedAt.getTime() > this.retentionFor(session);
  }

  constructor() {
    this.loadFromDisk();
  }

  /**
   * 从磁盘加载会话数据
   */
  private loadFromDisk(): void {
    const parsed = readJson<UserSession[]>(SESSIONS_FILE, [], reviveDates);
    if (Array.isArray(parsed)) {
      parsed.forEach((s: UserSession) => {
        if (s && s.sessionId) this.sessions.set(s.sessionId, s);
      });
    }
    console.log(`💾 [Storage] 已从磁盘加载 ${this.sessions.size} 个会话`);
  }

  /**
   * 防抖保存到磁盘
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 300);
  }

  private saveToDisk(): void {
    try {
      writeJson(SESSIONS_FILE, Array.from(this.sessions.values()));
    } catch (error) {
      console.warn('⚠️ [Storage] 保存会话数据失败:', (error as Error)?.message);
    }
  }

  /**
   * 创建新会话
   */
  createSession(sessionId: string): UserSession {
    const session: UserSession = {
      sessionId,
      questions: [],
      chatMessages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.sessions.set(sessionId, session);
    this.cleanupExpiredSessions();
    this.scheduleSave();
    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): UserSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      // 检查会话是否过期（按「最后活跃」而非创建时间：活跃会话不应被误删，P1-05；保留期分层见 retentionFor）
      if (this.isExpired(session)) {
        this.sessions.delete(sessionId);
        return undefined;
      }
      session.updatedAt = new Date();
    }
    return session;
  }

  /**
   * 更新会话
   */
  updateSession(sessionId: string, updates: Partial<UserSession>): UserSession | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    Object.assign(session, updates, { updatedAt: new Date() });
    this.sessions.set(sessionId, session);

    // —— 聊一聊保留上限（防止 sessions.json 无界膨胀）——
    // 单会话：最多保留最近 MAX_CHAT_MSGS 条消息（保留最近，截掉最早的）
    if (session.chatMessages && session.chatMessages.length > MAX_CHAT_MSGS) {
      session.chatMessages = session.chatMessages.slice(-MAX_CHAT_MSGS);
    }
    // 每用户：最多保留最近活跃的 MAX_CHAT_SESSIONS 个聊天会话，更早的删除（置顶会话豁免，防止用户置顶后被自动清掉）
    if (session.userId) {
      const mine = Array.from(this.sessions.values())
        .filter(s => s.userId === session.userId && (s.chatMessages?.length || 0) > 0)
        .sort((a, b) => toTime(b.chatUpdatedAt || b.updatedAt) - toTime(a.chatUpdatedAt || a.updatedAt));
      if (mine.length > MAX_CHAT_SESSIONS) {
        const pinnedCount = mine.filter(s => s.chatPinned).length;
        const droppable = mine.filter(s => !s.chatPinned); // 只从未置顶会话里淘汰最旧的
        const keepUnpinned = Math.max(0, MAX_CHAT_SESSIONS - pinnedCount);
        for (const old of droppable.slice(keepUnpinned)) this.sessions.delete(old.sessionId);
      }
    }

    this.scheduleSave();
    return session;
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const ok = this.sessions.delete(sessionId);
    if (ok) this.scheduleSave();
    return ok;
  }

  /**
   * 游客会话并入账号：把游客期间的会话（聊一聊/理一理记录）归属转移给账号
   */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.userId === oldId) { s.userId = newId; changed = true; }
    }
    if (changed) this.scheduleSave();
    console.log(`🔀 [Storage] 会话归属转移: ${oldId.slice(0, 8)} -> ${newId.slice(0, 8)} (${changed ? '有变更' : '无数据'})`);
  }

  /**
   * 删除某用户的全部会话（账户注销时）
   */
  deleteByUser(userId: string): void {
    let changed = false;
    for (const [sid, s] of this.sessions.entries()) {
      if (s.userId === userId) {
        this.sessions.delete(sid);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /**
   * 获取所有活跃会话
   */
  getActiveSessions(): UserSession[] {
    this.cleanupExpiredSessions();
    return Array.from(this.sessions.values());
  }

  /**
   * 清理过期会话（按最后活跃 updatedAt + 分层保留期，P1-05）
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isExpired(session, now)) this.sessions.delete(sessionId);
    }
  }

  /**
   * 获取存储统计信息
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    memoryUsage: string;
  } {
    this.cleanupExpiredSessions();
    // 估算内存占用（按会话数 + 消息/问题条数粗略估算，避免对全部内容做 JSON 序列化）
    let approxBytes = 0;
    for (const s of this.sessions.values()) {
      approxBytes += 200 + (s.chatMessages?.length || 0) * 240 + (s.questions?.length || 0) * 240;
    }
    return {
      totalSessions: this.sessions.size,
      activeSessions: this.sessions.size,
      memoryUsage: `${Math.round(approxBytes / 1024)} KB`
    };
  }
}

// 导出单例实例
export const memoryStorage = new MemoryStorage();
export default memoryStorage;