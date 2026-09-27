/**
 * 自建剧本（用户自定义角色剧情）
 * 按登录用户（userId）持久化到 data/custom-roleplay.json，私人可见，进程重启不丢失。
 *
 * 审核状态机（UGC 精选分层）：
 *   draft(未投稿) → pending(待审核) → approved(已通过·一般公开) → featured(精选)
 *                                          ↑        ↓
 *                                    rejected(已驳回，附 reviewNote)  → 改稿重投 → pending
 * 公开可游玩 = approved 或 featured（getPublished 即“公开可见”）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

export type CustomStatus = 'pending' | 'approved' | 'featured' | 'rejected';

export interface CustomScenario {
  id: string;
  userId: string;
  title: string;
  aiName: string;
  aiPersona: string;
  background: string;
  opening: string;
  /** 角色头像（裁剪后的图片 data URL，可选） */
  avatar?: string;
  /** 聊天背景图（裁剪后的图片 data URL，可选） */
  chatBackground?: string;
  /** 已投稿过（有审核状态即视为已投稿，保持与 status 同步） */
  published?: boolean;
  /** 审核状态；未设置 = 草稿（未投稿/已取消投稿） */
  status?: CustomStatus;
  /** 运营精选（展示到「精选」区块，仅 approved/pending 可被设为 featured） */
  featured?: boolean;
  featuredAt?: number;
  /** 运营驳回/建议反馈（rejected 时展示给投稿者） */
  reviewNote?: string;
  reviewedAt?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * **创建时**是否用「无限制模式（成人模型）」辅助生成（剧情生成那个开关）。仅创建那一刻记录一次。
   *
   * 来路：客户端自述（方案 A2，与角色扮演会话打标一致）——管理端核对够用，不作取证。
   * 缺省 undefined = 未记录（老数据 / 手写而非 AI 生成），**不要当作 false**。
   * 注意：更新剧本（update）**不改变**这个字段——它描述的是「创建方式」这个历史事实。
   */
  createdWithUnlimited?: boolean;
  /** 创建时辅助生成所用的模型名 */
  createdWithModel?: string;
  /**
   * 创建这份剧本时用户给 AI 的**提示词原文**（「AI 帮我写剧本」的灵感；改稿要求保存时不覆盖）。
   * 由前端保存时回传（草稿生成接口本身不落库），缺省 undefined = 非 AI 生成 / 老数据。
   */
  creationPrompt?: string;
}

const FILE = dataFile('custom-roleplay.json');

const isPublic = (s: CustomScenario): boolean => s.status === 'approved' || s.status === 'featured';

/** 让 published / featured 与 status 保持一致 */
function syncFlags(rec: CustomScenario): void {
  rec.published = !!rec.status;
  rec.featured = rec.status === 'featured' ? true : undefined;
  if (rec.status !== 'featured' && rec.featuredAt) rec.featuredAt = undefined;
}

class CustomRoleplayStore {
  private items: CustomScenario[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<any[]>(FILE, []);
    if (!Array.isArray(parsed)) return;
    this.items = parsed
      .filter((r: any) => r && r.id && r.userId)
      .map((r: any) => this.migrate(r));
  }

  /** 旧数据迁移：仅凭 published/featured 推定 status（旧「已投稿未精选」本就不公开 → 归 pending） */
  private migrate(r: any): CustomScenario {
    const rec: CustomScenario = { ...r };
    if (!rec.status) {
      if (rec.published && rec.featured) rec.status = 'featured';
      else if (rec.published) rec.status = 'pending';
    }
    if (rec.status === 'featured' && !rec.featuredAt) rec.featuredAt = rec.updatedAt || Date.now();
    syncFlags(rec);
    return rec;
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch { /* 忽略 */ }
  }

  create(userId: string, data: { title?: string; aiName?: string; aiPersona?: string; background?: string; opening?: string; avatar?: string; chatBackground?: string; createdWithUnlimited?: boolean; createdWithModel?: string; creationPrompt?: string }): CustomScenario {
    const now = Date.now();
    const rec: CustomScenario = {
      id: 'custom_' + now.toString(36) + Math.random().toString(36).slice(2, 8),
      userId,
      title: (data.title || '').trim() || '自定义剧情',
      aiName: (data.aiName || '').trim(),
      aiPersona: (data.aiPersona || '').trim(),
      background: (data.background || '').trim(),
      opening: (data.opening || '').trim(),
      avatar: data.avatar || undefined,
      chatBackground: data.chatBackground || undefined,
      // 🚨 这里是**逐字段构造**记录，新字段不显式写进来就会被静默丢掉（同 roleplaySessions.withTs 那类坑）。
      // 审计标记（方案 A2）：只采信 boolean（传 'true'/1 一律忽略）；模型名截断防异常长串撑大文件。
      ...(typeof data.createdWithUnlimited === 'boolean' ? { createdWithUnlimited: data.createdWithUnlimited } : {}),
      ...(typeof data.createdWithModel === 'string' && data.createdWithModel ? { createdWithModel: data.createdWithModel.slice(0, 80) } : {}),
      ...(typeof data.creationPrompt === 'string' && data.creationPrompt.trim() ? { creationPrompt: data.creationPrompt.trim().slice(0, 8000) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(rec);
    this.saveToDisk();
    return rec;
  }

  listByUser(userId: string): CustomScenario[] {
    return this.items.filter((i) => i.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(userId: string, id: string): CustomScenario | undefined {
    return this.items.find((i) => i.userId === userId && i.id === id);
  }

  /** 取一个「公开可见」（approved/featured）的剧本，任何玩家可游玩；标题解析等也用它 */
  getPublished(id: string): CustomScenario | undefined {
    return this.items.find((i) => i.id === id && isPublic(i));
  }

  /** 按 id 跨所有用户找剧本（仅用于标题解析兜底；绝不用于游玩/编辑权限判定） */
  findById(id: string): CustomScenario | undefined {
    return this.items.find((i) => i.id === id);
  }

  /**
   * 编辑自建剧本内容（仅本人；归属校验在路由层做）。
   * 内容变更即复位为草稿（清投稿/精选/驳回反馈）——防止「已公开副本」在运营挑选后被创作者悄悄改写，
   * 也保证已驳回剧本在改稿后重新投稿才会再次进入运营挑选。
   */
  update(userId: string, id: string, data: { title?: string; aiName?: string; aiPersona?: string; background?: string; opening?: string; avatar?: string; chatBackground?: string }): CustomScenario | undefined {
    const rec = this.items.find((i) => i.userId === userId && i.id === id);
    if (!rec) return undefined;
    rec.title = (data.title || '').trim() || rec.title;
    rec.aiName = (data.aiName || '').trim();
    rec.aiPersona = (data.aiPersona || '').trim();
    rec.background = (data.background || '').trim();
    rec.opening = (data.opening || '').trim();
    rec.avatar = data.avatar || undefined;
    rec.chatBackground = data.chatBackground || undefined;
    if (rec.status) {
      rec.status = undefined;
      rec.featured = undefined;
      rec.featuredAt = undefined;
      rec.reviewNote = undefined;
      rec.reviewedAt = undefined;
    }
    rec.published = false;
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 用户投稿/取消投稿（需归属校验在路由层做）；投稿 → 待审核，不公开 */
  setPublished(userId: string, id: string, published: boolean): CustomScenario | undefined {
    const rec = this.items.find((i) => i.userId === userId && i.id === id);
    if (!rec) return undefined;
    if (published) {
      rec.status = 'pending';
      rec.reviewNote = undefined;
      rec.reviewedAt = undefined;
    } else {
      rec.status = undefined;
      rec.featured = undefined;
      rec.featuredAt = undefined;
      rec.reviewNote = undefined;
      rec.reviewedAt = undefined;
    }
    syncFlags(rec);
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 运营「通过」→ 一般公开（approved） */
  approve(id: string): CustomScenario | undefined {
    const rec = this.items.find((i) => i.id === id && i.published);
    if (!rec) return undefined;
    rec.status = 'approved';
    rec.reviewNote = undefined;
    rec.reviewedAt = undefined;
    syncFlags(rec);
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 运营「驳回」→ rejected + 反馈评价 */
  reject(id: string, note: string): CustomScenario | undefined {
    const rec = this.items.find((i) => i.id === id && i.published);
    if (!rec) return undefined;
    rec.status = 'rejected';
    rec.reviewNote = (note || '').trim().slice(0, 1000) || undefined;
    rec.reviewedAt = Date.now();
    syncFlags(rec);
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 运营「设为精选/取消精选」（只允许对已投稿剧本操作，路由层校验）；取消精选回 approved */
  setFeatured(id: string, featured: boolean): CustomScenario | undefined {
    const rec = this.items.find((i) => i.id === id && i.published);
    if (!rec) return undefined;
    rec.status = featured ? 'featured' : 'approved';
    rec.featured = featured ? true : undefined;
    rec.featuredAt = featured ? Date.now() : undefined;
    rec.reviewNote = undefined;
    rec.reviewedAt = undefined;
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 运营「撤回」（从公开撤下 → 回待审核，不公开，清精选/反馈） */
  withdraw(id: string): CustomScenario | undefined {
    const rec = this.items.find((i) => i.id === id && i.published);
    if (!rec) return undefined;
    rec.status = 'pending';
    rec.featured = undefined;
    rec.featuredAt = undefined;
    rec.reviewNote = undefined;
    rec.reviewedAt = undefined;
    syncFlags(rec);
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  /** 已投稿剧本（供 admin 筛选/挑选） */
  listPublished(): CustomScenario[] {
    return this.items.filter((i) => i.published).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 待审核（尚未被运营处理） */
  listPending(): CustomScenario[] {
    return this.items.filter((i) => i.status === 'pending').sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 已通过·一般公开（供「玩家共创」一般区块展示） */
  listApproved(): CustomScenario[] {
    return this.items.filter((i) => i.status === 'approved').sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 已驳回（附反馈，投稿者可见改稿重投） */
  listRejected(): CustomScenario[] {
    return this.items.filter((i) => i.status === 'rejected').sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 运营精选剧本（供「精选」区块展示） */
  listFeatured(): CustomScenario[] {
    return this.items.filter((i) => i.status === 'featured').sort((a, b) => (b.featuredAt || 0) - (a.featuredAt || 0));
  }

  delete(userId: string, id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.userId === userId && i.id === id));
    if (this.items.length !== before) { this.saveToDisk(); return true; }
    return false;
  }

  /** 删除某用户的全部自建剧本（账户注销时） */
  deleteByUser(userId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.userId !== userId);
    if (this.items.length !== before) this.saveToDisk();
  }

  /** 游客自建剧本并入账号（游客期间创建的角色剧情随注册转到账号；id 全局唯一，无冲突） */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    let changed = false;
    for (const r of this.items) {
      if (r.userId === oldId) { r.userId = newId; changed = true; }
    }
    if (changed) this.saveToDisk();
  }
}

export const customRoleplayStore = new CustomRoleplayStore();
export default customRoleplayStore;
