/**
 * 邀请推广台账（referral events）
 *
 * 为什么要有这个文件：控制台要回答「**哪个用户的推广链接被谁用了、拉了多少人、赚了多少额度**」，
 * 以及「**某个区间内一共发出/赚到多少**」。而 `data/users.json` 里只有两个**没有时间戳**的累计量
 * （邀请人的 `inviteCount`、被邀人的 `invitedBy`），区间统计只能靠「被邀人注册时间」回算，
 * 且无法区分「当时是否真发了奖励」（反套利拦截 / 超出 20 人上限的邀请同样会留下 `invitedBy`）。
 *
 * 所以：**从本台账上线起，每一笔真实发放都逐条记一条**（谁 → 谁、什么时候、发了多少额度/天数）；
 * 上线之前的历史由 `adminReferrals.ts` 回算并标注「近似」（见该文件口径说明）。
 *
 * 记录口径（写点只有三处，都在「真发了」的分支里）：
 *  - kind='signup'  ：被邀人经推广链接注册成功 → 邀请人 +credits 条额度（被邀人同时 +inviteeCredits）
 *  - kind='purchase'：被邀人首购 → 邀请人 +days 天同档会员（封顶年付）；
 *                    被邀人月付 → 本人 +friendBonusDays 天（「送半月」）
 *  - kind='code'    ：注册时使用预设邀请码（🎫 xiaoyu2026 那类）→ 注册者 +credits 条额度；
 *                    码没有推广人，`inviterId` 用 `'code:' + 码` 占位、码本身存在 `code` 字段
 *  - kind='signup_pending'：经推广链接注册、注册期反套利已通过 → **等被邀人首次真实使用才结算**
 *                    （2026-09-19 B 方案：门槛装在被邀人侧）。此事件只记「人来了、还没开口」，
 *                    `inviteeCredits` 是**注册当刻已发给被邀人**的那份（朋友侧承诺不变）。
 *  - kind='signup_rejected'：推广链接注册但**没有**给邀请人发奖励 → 只记 `reason`
 *                    （同设备 / 同 IP / 邀请人不是账号 / 已达邀请上限 / 自邀；结算期新增加
 *                     `invitee-inactive` 不会出现在这里——待激活不是「不发」，是「还没到时候」）。
 *
 * 注意：本台账是**运营观测数据**，不参与任何额度/会员发放的计算（发放永远以 quotaStore 为准），
 * 因此即使台账写失败也不会影响用户实际拿到的奖励。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const REFERRAL_EVENTS_FILE = dataFile('referral-events.json');
/** 上限：超出即丢最旧的（台账用于近端运营观察，不追求无限留档） */
const MAX_EVENTS = 5000;

export type ReferralEventKind = 'signup' | 'signup_pending' | 'purchase' | 'code' | 'signup_rejected';

export interface ReferralEvent {
  id: string;
  /** 发生时间（ms）。signup/code=注册成功时刻；purchase=解锁/确认到账时刻 */
  at: number;
  kind: ReferralEventKind;
  /** 推广人（分享链接的人）。`code` 类事件没有推广人，用 `'code:' + 邀请码` 占位 */
  inviterId: string;
  /** 被邀人（用了推广链接 / 邀请码的人） */
  inviteeId: string;
  /** code：被使用的预设邀请码（小写） */
  code?: string;
  /** signup：邀请人本次获得的邀请额度（条）；code：注册者本次获得的额度（条） */
  credits?: number;
  /** signup：邀请人获得的新账号加成倍数（1.5 = 注册 7 天内邀请成功；无则不加成） */
  boost?: number;
  /** signup：被邀人本次同时获得的额度（条，成本口径） */
  inviteeCredits?: number;
  /** purchase：邀请人本次获得的会员天数（同档·封顶年付） */
  days?: number;
  /** purchase：被邀人月付加赠天数（「送半月」，给的是被邀人） */
  friendBonusDays?: number;
  plan?: string;
  purchase?: string;
  /**
   * 未发放/发放判定结果（signup：'valid'；signup_rejected：'same-device' / 'same-ip' /
   * 'inviter-too-new' / 'inviter-not-account' / 'inviter-cap-reached' / 'self-invite'）。
   * 控制台据此在下钻明细里写明「为什么没给邀请人发奖励」——这是**当时**的判定，事后无法可靠还原。
   */
  reason?: string;
  /** 记录来源备注（stripe / wechat / register / invite_code 等），便于排查 */
  note?: string;
}

export class ReferralEventStore {
  private items: ReferralEvent[] = [];
  private readonly file: string;

  /** file 参数供测试注入临时文件；默认 data/referral-events.json */
  constructor(file: string = REFERRAL_EVENTS_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<ReferralEvent[]>(this.file, []);
    if (Array.isArray(parsed)) {
      this.items = parsed.filter(e => !!e && !!e.inviterId && !!e.inviteeId && typeof e.at === 'number');
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(this.file, this.items);
    } catch (e) {
      // 台账只用于观测：写失败只告警，绝不抛给调用方（不能影响真实的奖励发放）
      console.warn('⚠️ [ReferralEvents] 保存台账失败:', (e as Error)?.message);
    }
  }

  /**
   * 记一条台账。inviterId/inviteeId 缺失、或没有任何金额且没有 reason 时忽略（返回 null）。
   * 幂等保护：`kind` + `inviterId` + `inviteeId` 相同且「已记过邀请人天数」的事件不重复记天数
   * （被邀人月付的「送半月」可以多次，因此不参与该去重）。
   */
  log(evt: Omit<ReferralEvent, 'id'>): ReferralEvent | null {
    if (!evt || !evt.inviterId || !evt.inviteeId) return null;
    let days = typeof evt.days === 'number' && evt.days > 0 ? evt.days : undefined;
    const friendBonusDays = typeof evt.friendBonusDays === 'number' && evt.friendBonusDays > 0 ? evt.friendBonusDays : undefined;
    const credits = typeof evt.credits === 'number' && evt.credits > 0 ? evt.credits : undefined;
    if (days && this.hasInviterDayGrant(evt.kind, evt.inviterId, evt.inviteeId)) days = undefined;
    // `reason` 单独存在也算有效事件（signup_rejected：没发钱但「为什么没发」必须留痕）
    if (!days && !friendBonusDays && !credits && !evt.reason) return null;

    const rec: ReferralEvent = {
      id: 'rf' + Date.now() + Math.random().toString(36).slice(2, 6),
      at: typeof evt.at === 'number' && evt.at > 0 ? evt.at : Date.now(),
      kind: evt.kind,
      inviterId: evt.inviterId,
      inviteeId: evt.inviteeId,
      ...(evt.code ? { code: String(evt.code).toLowerCase() } : {}),
      ...(credits !== undefined ? { credits } : {}),
      ...(typeof evt.boost === 'number' && evt.boost > 1 ? { boost: evt.boost } : {}),
      ...(typeof evt.inviteeCredits === 'number' && evt.inviteeCredits > 0 ? { inviteeCredits: evt.inviteeCredits } : {}),
      ...(days !== undefined ? { days } : {}),
      ...(friendBonusDays !== undefined ? { friendBonusDays } : {}),
      ...(evt.plan ? { plan: evt.plan } : {}),
      ...(evt.purchase ? { purchase: evt.purchase } : {}),
      ...(evt.reason ? { reason: String(evt.reason).slice(0, 40) } : {}),
      ...(evt.note ? { note: evt.note } : {}),
    };
    this.items.push(rec);
    if (this.items.length > MAX_EVENTS) this.items = this.items.slice(-MAX_EVENTS);
    this.saveToDisk();
    return rec;
  }

  /** 该（邀请人, 被邀人）是否已记过「邀请人获得会员天数」——防同一笔首购被记两次 */
  private hasInviterDayGrant(kind: ReferralEventKind, inviterId: string, inviteeId: string): boolean {
    return this.items.some(e => e.kind === kind && e.inviterId === inviterId && e.inviteeId === inviteeId && (e.days || 0) > 0);
  }

  /** 全部事件（按发生时间升序，最早在前） */
  listAll(): ReferralEvent[] {
    return this.items.slice().sort((a, b) => a.at - b.at);
  }

  /** 台账覆盖起点（除空台账返回 null）——用于判断某事件是否「已有精确记录」 */
  earliestAt(): number | null {
    if (!this.items.length) return null;
    return this.items.reduce((min, e) => (e.at < min ? e.at : min), this.items[0].at);
  }

  size(): number {
    return this.items.length;
  }
}

export const referralEventStore = new ReferralEventStore();
export default referralEventStore;
