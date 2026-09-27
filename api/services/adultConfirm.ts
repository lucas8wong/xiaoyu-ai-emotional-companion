/**
 * 成年人确认记录（18+ 门槛 · 服务端留痕）
 *
 * 为什么单独一个模块、而不是塞进 preferences：
 *   1. 偏好是**客户端可整体 PUT 的**可变状态（`PUT /api/preferences` 收整个 body），
 *      把「用户已确认年满 18 岁」放进偏好里，等于让客户端能自行伪造/清掉这条合规记录；
 *   2. 它是**合规留痕**、不是偏好：只追加、不因前端同步而丢，需要能按时间点追溯；
 *   3. 偏好走 reassignUser 等归并逻辑，合规记录不该跟着偏好一起被合并覆盖。
 *
 * 与内容安全阀的关系：`roleplayUnlimited`（剧情「无限制模式」）默认关，是产品侧的安全阀；
 * 本模块是它的**前置条件**——没确认成年，服务端一律按未开启处理（见 roleplay.ts prefAllowedFor
 * 与 routes/user.ts 的写入闸），这样即使有人在客户端把偏好改成 true 也不会真的切到去限制模型。
 *
 * 数据文件：data/adult-confirm.json（新增文件，不修改任何既有数据）
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('adult-confirm.json');

/** 确认来源：便于事后区分「邮件落地页确认」「App 内开关前确认」「其它」 */
export type AdultConfirmSource = 'email-campaign' | 'roleplay-toggle' | 'api';

export interface AdultConfirmRecord {
  userId: string;
  /** 首次确认时间（重复确认不覆盖，保留最早一次作为留痕） */
  confirmedAt: number;
  source: AdultConfirmSource;
  /** 客户端自报 UA（截断保存，仅留痕用，不做校验） */
  ua?: string;
}

const SOURCES: AdultConfirmSource[] = ['email-campaign', 'roleplay-toggle', 'api'];

function normalizeSource(v: unknown): AdultConfirmSource {
  return SOURCES.includes(v as AdultConfirmSource) ? (v as AdultConfirmSource) : 'api';
}

class AdultConfirmStore {
  private map = new Map<string, AdultConfirmRecord>();

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<AdultConfirmRecord[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((r) => { if (r?.userId) this.map.set(r.userId, r); });
    }
  }

  private saveToDisk(): void {
    try { writeJson(FILE, Array.from(this.map.values())); } catch { /* 忽略：留痕失败不阻塞主流程 */ }
  }

  get(userId: string): AdultConfirmRecord | undefined {
    return this.map.get(userId);
  }

  isConfirmed(userId: string): boolean {
    const r = this.map.get(userId);
    return !!r && r.confirmedAt > 0;
  }

  confirmedAt(userId: string): number | null {
    const r = this.map.get(userId);
    return r && r.confirmedAt > 0 ? r.confirmedAt : null;
  }

  /**
   * 记一次成年确认。
   * 幂等：**已确认过则保留最早时间**（合规留痕应是「第一次声明」），只补充来源缺失的情况。
   */
  confirm(userId: string, source: AdultConfirmSource = 'api', ua?: string): AdultConfirmRecord {
    if (!userId) throw new Error('adultConfirm.confirm: userId 必填');
    const cur = this.map.get(userId);
    if (cur && cur.confirmedAt > 0) return cur;
    const rec: AdultConfirmRecord = {
      userId,
      confirmedAt: Date.now(),
      source: normalizeSource(source),
      ua: ua ? String(ua).slice(0, 120) : undefined,
    };
    this.map.set(userId, rec);
    this.saveToDisk();
    return rec;
  }

  /** 撤回确认（合规兜底入口：用户要求删除该记录时用；存在即删除，不留半残状态） */
  revoke(userId: string): boolean {
    const ok = this.map.delete(userId);
    if (ok) this.saveToDisk();
    return ok;
  }

  /**
   * 游客确认并入账号（注册成功后调用）；账号已有记录则以账号的为准。
   *
   * 与 preferenceStore.reassignUser 的差别：这里**删掉游客侧记录**。偏好留在游客 id 下无害，
   * 但「已确认成年」留在设备指纹下会留下一个洞——同一台设备换个人当游客用，
   * 会直接继承上一个人的成年声明。合规记录不该跨人继承。
   */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    const g = this.map.get(oldId);
    if (!g) return;
    if (!this.map.has(newId)) this.map.set(newId, { ...g, userId: newId });
    this.map.delete(oldId);
    this.saveToDisk();
  }

  listAll(): AdultConfirmRecord[] {
    return Array.from(this.map.values());
  }

  /** 供运营端预览：只出聚合数，不出明细 */
  stats(): { confirmed: number } {
    return { confirmed: this.map.size };
  }
}

export const adultConfirmStore = new AdultConfirmStore();

/** 便捷判断（未登录/游客无 userId → false，绝不默认放行） */
export function isAdultConfirmed(userId?: string): boolean {
  if (!userId) return false;
  try {
    return adultConfirmStore.isConfirmed(userId);
  } catch {
    return false; // 记录层异常 → 保守：按未确认处理
  }
}

export default adultConfirmStore;
