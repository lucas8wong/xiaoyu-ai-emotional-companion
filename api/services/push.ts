/**
 * Web Push（PWA 推送）服务
 * - VAPID 密钥：data/vapid-keys.json，首次自动生成（稳定跨重启）
 * - 订阅存储：data/push-subscriptions.json（按 userId → 端点多份）
 * - 发送：webpush.sendNotification，失败/失效端点自动清理
 * 供「场景化召回 / AI 主动找我」在推送通道下 deliver。
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { skinUsageStore } from './skinUsage.js';
import webpush from 'web-push';

const VAPID_FILE = dataFile('vapid-keys.json');
const SUB_FILE = dataFile('push-subscriptions.json');

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:xiaoyu@myxiaoyu.com';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

interface VapidKeys { publicKey: string; privateKey: string; }

// ---------------------------------------------------------------------------
// VAPID 密钥
// ---------------------------------------------------------------------------
let vapid: VapidKeys | null = null;
let vapidLoaded = false;

function loadVapid(): VapidKeys {
  if (vapid) return vapid;
  if (!vapidLoaded) {
    const parsed = readJson<VapidKeys>(VAPID_FILE, null as never);
    const fromStore = !!(parsed && parsed.publicKey && parsed.privateKey);
    if (fromStore) {
      vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    } else {
      const keys = webpush.generateVAPIDKeys();
      vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      try { writeJson(VAPID_FILE, vapid); } catch { /* 忽略 */ }
    }
    vapidLoaded = true;
    webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
    // 诊断：记录 VAPID 来源（读存储 or 重新生成）与本进程用的公钥（仅非生产，避免污染线上）
    if (process.env.NODE_ENV !== 'production') {
      try {
        fs.appendFileSync(path.join(process.cwd(), 'temp', 'push-load.log'),
          JSON.stringify({ at: Date.now(), fromStore, publicKey: vapid.publicKey }) + '\n');
      } catch { /* 忽略 */ }
    }
  }
  return vapid!;
}

/** 前端订阅时的 applicationServerKey（公钥） */
export function getVapidPublicKey(): string {
  return loadVapid().publicKey;
}

// ---------------------------------------------------------------------------
// 订阅存储
// ---------------------------------------------------------------------------
interface PushSubRecord {
  userId: string;
  subscription: PushSubscription;
  createdAt: number;
  /** 订阅该设备当时的皮肤（通知图标跟随它）；随皮肤上报更新 */
  skin?: string;
  /** 订阅请求的 User-Agent（用于在控制台识别电脑/手机/浏览器；仅展示用） */
  ua?: string;
}

class PushSubscriptionStore {
  private items: PushSubRecord[] = [];

  constructor() { this.load(); }

  private load(): void {
    const parsed = readJson<PushSubRecord[]>(SUB_FILE, []);
    if (Array.isArray(parsed)) this.items = parsed;
  }

  private save(): void {
    try { writeJson(SUB_FILE, this.items); } catch { /* 忽略 */ }
  }

  add(userId: string, subscription: PushSubscription, ua?: string): void {
    if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return;
    const skin = skinUsageStore.get(userId)?.skin || 'healing';
    const existing = this.items.findIndex((r) => r.subscription.endpoint === subscription.endpoint);
    if (existing >= 0) {
      this.items[existing] = { userId, subscription, createdAt: this.items[existing].createdAt || Date.now(), skin, ua: ua || this.items[existing].ua };
    } else {
      this.items.push({ userId, subscription, createdAt: Date.now(), skin, ua });
    }
    this.save();
  }

  /** 皮肤上报时同步更新该用户所有订阅的皮肤（通知图标紧跟当前皮肤） */
  setSkinForUser(userId: string, skin: string): void {
    let changed = false;
    for (const r of this.items) {
      if (r.userId === userId && r.skin !== skin) { r.skin = skin; changed = true; }
    }
    if (changed) this.save();
  }

  remove(userId: string, endpoint: string): void {
    const before = this.items.length;
    this.items = this.items.filter((r) => !(r.userId === userId && r.subscription.endpoint === endpoint));
    if (this.items.length !== before) this.save();
  }

  removeEndpoint(endpoint: string): void {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.subscription.endpoint !== endpoint);
    if (this.items.length !== before) this.save();
  }

  /** 注销清理（2026-09-28 审查 P1-8）：删除该用户全部推送订阅（endpoint/keys/UA 都是个人数据） */
  removeByUser(userId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.userId !== userId);
    if (this.items.length !== before) this.save();
  }

  /** 设备打开 App 时「打卡」：按端点更新该订阅的 User-Agent（让旧订阅也能在控制台识别设备） */
  setUaByEndpoint(endpoint: string, ua: string): boolean {
    const r = this.items.find((x) => x.subscription.endpoint === endpoint);
    if (!r || !ua) return false;
    r.ua = ua;
    this.save();
    return true;
  }

  listByUser(userId: string): PushSubRecord[] {
    return this.items.filter((r) => r.userId === userId);
  }

  has(userId: string): boolean {
    return this.items.some((r) => r.userId === userId);
  }

  listAll(): PushSubRecord[] {
    return this.items;
  }
}

export const pushSubscriptionStore = new PushSubscriptionStore();

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------
export interface PushPayload {
  title: string;
  body: string;
  url?: string;       // 点击通知后打开的应用地址
  tag?: string;       // 相同 tag 覆盖同类型通知，避免堆积
  icon?: string;      // 通知大图标（缺省按用户当前皮肤自动选择）
  badge?: string;     // 通知小图标/状态栏图标（缺省按用户当前皮肤自动选择）
}

/** 取该用户当前皮肤的图标（缺省 healing）；皮肤 id 由 skin-usage 上报（last-write-wins） */
export function skinIconFor(userId: string, size: 32 | 48 | 192 | 512 = 192): string {
  const skin = (skinUsageStore.get(userId)?.skin || 'healing').trim() || 'healing';
  return `/skins/${skin}/app-icon-${size}.png`;
}

/** 向某用户的全部有效端点推送；失效端点（410/404）自动清理 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number }> {
  // 确保 VAPID 已配置（webpush.setVapidDetails 只在 loadVapid 里调用）；
  // 否则若先发推送而未先走 /vapid 订阅接口，web-push 未配置 VAPID 会发送失败。
  loadVapid();
  const subs = pushSubscriptionStore.listByUser(userId);
  let sent = 0;
  let failed = 0;
  const accountSkin = (skinUsageStore.get(userId)?.skin || 'healing').trim() || 'healing';
  for (const rec of subs) {
    // 通知图标跟随「该订阅所属设备」当时的皮肤（优先），否则回退到账号最近皮肤 / 缺省 healing
    const skin = (rec.skin || accountSkin || 'healing').trim() || 'healing';
    const perSub: PushPayload = {
      ...payload,
      icon: payload.icon || `/skins/${skin}/app-icon-192.png`,
      badge: payload.badge || `/skins/${skin}/app-icon-32.png`,
    };
    const body = JSON.stringify(perSub);
    try {
      await webpush.sendNotification(rec.subscription, body, { TTL: 3600 });
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      // 诊断：把失败的真实原因落到 temp/push-error.log（仅非生产，避免污染线上）
      if (process.env.NODE_ENV !== 'production') {
        try {
          fs.appendFileSync(path.join(process.cwd(), 'temp', 'push-error.log'),
            JSON.stringify({ at: Date.now(), userId, status: status ?? null, msg: String((e as Error)?.message || e), endpoint: rec.subscription.endpoint }) + '\n');
        } catch { /* 忽略 */ }
      }
      if (status === 404 || status === 410) {
        pushSubscriptionStore.removeEndpoint(rec.subscription.endpoint);
      }
      failed++;
    }
  }
  return { sent, failed };
}

export function hasPushSubscription(userId: string): boolean {
  return pushSubscriptionStore.has(userId);
}
