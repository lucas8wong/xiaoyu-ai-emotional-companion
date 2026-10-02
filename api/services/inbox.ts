/**
 * 小愈信箱（站内信）
 *
 * 为什么要有它（2026-09-30）：
 *   运营端发放反馈奖励时可以写一段「给用户的话」（note）。此前这段 note **只进邮件**，
 *   于是 ①无邮箱的游客 100% 收不到；②站内那次恭喜弹窗 5 秒后 ack 即清，错过就再也找不回来。
 *   信件是「人对人的回复」，语义上必须能留存，弹窗只负责叫醒，信箱负责放得住。
 *
 * 边界（AGENTS.md 红线 6）：本模块只存 **UI 通知文案**，绝不写进 `messages` / `chatMessages`，
 *   否则会被当成「小愈说过的话」落盘并回灌给模型当上下文。
 *
 * 与 `announcements` 的区别：公告是「所有人都能看」，信箱是「写给你的这一封」，按 userId 隔离。
 * 持久化 data/inbox.json（经 storage/persistence 层，sqlite/file 无关）。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('inbox.json');

/** 每个用户最多保留的信件数（超出丢最旧），防止长期运营把单文件撑大 */
const MAX_PER_USER = 50;
/** 单封正文上限（与运营端 note 的 500 字上限一致） */
const MAX_BODY = 500;

export type InboxKind = 'reward' | 'system';

export interface InboxLetter {
  id: string;
  userId: string;
  kind: InboxKind;
  /** 奖励条数（kind='reward' 时用于文案「获得 N 次免费体验奖励」） */
  rewardCount?: number;
  /** 奖励原因（register / invite / feedback …）：仅排查用，前端不展示 */
  reason?: string;
  /** 运营者写给这个用户的话（可为空：没有附言的信件依然会留档，便于回看奖励） */
  body: string;
  read: boolean;
  createdAt: number;
}

class InboxStore {
  private items: InboxLetter[] = [];

  constructor() { this.loadFromDisk(); }

  /** 旧数据/脏数据的归一：字段缺失一律给安全默认值，绝不因一条坏记录丢掉整箱信 */
  private migrate(raw: any): InboxLetter | null {
    const userId = String(raw?.userId || '');
    if (!userId) return null;
    const kind: InboxKind = raw?.kind === 'system' ? 'system' : 'reward';
    const rewardCount = Number(raw?.rewardCount);
    return {
      id: String(raw?.id || 'inb' + Date.now() + Math.random().toString(36).slice(2, 6)),
      userId,
      kind,
      ...(Number.isFinite(rewardCount) && rewardCount > 0 ? { rewardCount: Math.round(rewardCount) } : {}),
      ...(raw?.reason ? { reason: String(raw.reason).slice(0, 30) } : {}),
      body: String(raw?.body ?? '').slice(0, MAX_BODY),
      read: raw?.read === true,
      createdAt: Number(raw?.createdAt) || Date.now(),
    };
  }

  private loadFromDisk(): void {
    const parsed = readJson<any>(FILE, []);
    if (!Array.isArray(parsed)) return;
    this.items = parsed.map((r) => this.migrate(r)).filter((x): x is InboxLetter => x !== null);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch { /* 忽略：写信失败不能影响奖励发放本身 */ }
  }

  /**
   * 给某个用户写一封信（新在前）。
   * @returns 写入的信件；userId 为空时返回 null（不写孤儿信）
   */
  add(userId: string, opts: { kind?: InboxKind; rewardCount?: number; reason?: string; body?: string } = {}): InboxLetter | null {
    const uid = String(userId || '');
    if (!uid) return null;
    const count = Number(opts.rewardCount);
    const letter: InboxLetter = {
      id: 'inb' + Date.now() + Math.random().toString(36).slice(2, 6),
      userId: uid,
      kind: opts.kind === 'system' ? 'system' : 'reward',
      ...(Number.isFinite(count) && count > 0 ? { rewardCount: Math.round(count) } : {}),
      ...(opts.reason ? { reason: String(opts.reason).slice(0, 30) } : {}),
      body: String(opts.body ?? '').slice(0, MAX_BODY),
      read: false,
      createdAt: Date.now(),
    };
    this.items.unshift(letter);
    this.trimUser(uid);
    this.saveToDisk();
    return letter;
  }

  /** 只保留该用户最近的 MAX_PER_USER 封 */
  private trimUser(userId: string): void {
    const mine = this.items.filter((i) => i.userId === userId);
    if (mine.length <= MAX_PER_USER) return;
    const drop = new Set(mine.slice(MAX_PER_USER).map((i) => i.id));
    this.items = this.items.filter((i) => !drop.has(i.id));
  }

  /** 某个用户的信件（新在前，默认最多 50 封） */
  list(userId: string, limit: number = MAX_PER_USER): InboxLetter[] {
    const uid = String(userId || '');
    if (!uid) return [];
    return this.items
      .filter((i) => i.userId === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, Math.round(limit)));
  }

  /** 未读数（前端红点） */
  unreadCount(userId: string): number {
    const uid = String(userId || '');
    if (!uid) return 0;
    return this.items.filter((i) => i.userId === uid && !i.read).length;
  }

  /**
   * 标记已读。
   * @param id 传 id = 只标这一封（且必须属于该用户）；不传 = 全部已读（打开信箱即全读）
   * @returns 标记后的未读数
   */
  markRead(userId: string, id?: string): number {
    const uid = String(userId || '');
    if (!uid) return 0;
    let changed = false;
    for (const item of this.items) {
      if (item.userId !== uid) continue;
      if (id && item.id !== id) continue;
      if (!item.read) { item.read = true; changed = true; }
    }
    if (changed) this.saveToDisk();
    return this.unreadCount(uid);
  }

  /** 账户注销：清空该用户的全部信件（个人数据删除义务） */
  removeByUser(userId: string): void {
    const uid = String(userId || '');
    if (!uid) return;
    const before = this.items.length;
    this.items = this.items.filter((i) => i.userId !== uid);
    if (this.items.length !== before) this.saveToDisk();
  }
}

export const inboxStore = new InboxStore();
export default inboxStore;
