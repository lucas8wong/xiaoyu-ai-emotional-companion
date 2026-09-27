/**
 * 控制台「会员到期」口径（服务端唯一来源）
 *
 * 为什么单独成模块：控制台用户列表、CSV 导出、以及将来的报表都要回答同一个问题
 * 「这个人的会员到什么时候过期」——口径必须只有一份（见 `accountFilters.ts` 的同类注释），
 * 而且它要能被单测直接覆盖（放在 route 里就只能靠真机验证）。
 *
 * 口径：
 *  - `lifetime`（买断）→ `lifetime`：前端显示「永久」；
 *  - 会员有效期内（`unlockUntil`）→ `membership`：到期日 + 剩余天数；
 *  - **只有 7 天 Pro 体验**（`trialProUntil`，老用户新人礼）→ `trial`：也算「会员到期」。
 *    2026-09-18 实测：85 个注册用户里 44 个是这种，此前只看 `unlockUntil` → 控制台显示成
 *    「Pro 会员 + 到期 —」，运营**看不到任何到期时间**（这正是用户报的问题）；
 *  - 会员已过期 → `expired`：给出过期日期，运营据此判断断了多久；
 *  - 从未开通 → `none`。
 *
 * `expiryAt` 供排序/导出用：无到期为 0，控制台把 0 恒定排最后；`daysLeft` 向上取整（「今天到期」= 0）。
 */

export type ExpiryKind = 'none' | 'membership' | 'trial' | 'expired' | 'lifetime';
export type ExpiryState = 'none' | 'active' | 'expired';

export interface ExpiryFields {
  expiryKind: ExpiryKind;
  /** 有效到期时间戳（ms）；无到期为 0 */
  expiryAt: number;
  /** 剩余天数（向上取整）；过期/永久/无到期为 null */
  daysLeft: number | null;
  expiryState: ExpiryState;
}

/** 会员记录里与到期相关的字段（`quotaStore` 的 UserRecord 子集） */
export interface ExpirySource {
  plan?: string | null;
  unlockUntil?: number | null;
  trialProUntil?: number | null;
}

const DAY_MS = 86400000;

export function expiryFieldsOf(q: ExpirySource | undefined | null, now: number = Date.now()): ExpiryFields {
  const mem = Number(q?.unlockUntil) || 0;
  const trial = Number(q?.trialProUntil) || 0;
  if (q?.plan === 'lifetime') {
    return { expiryKind: 'lifetime', expiryAt: mem, daysLeft: null, expiryState: 'active' };
  }
  if (mem > now) {
    return { expiryKind: 'membership', expiryAt: mem, daysLeft: Math.ceil((mem - now) / DAY_MS), expiryState: 'active' };
  }
  if (trial > now) {
    return { expiryKind: 'trial', expiryAt: trial, daysLeft: Math.ceil((trial - now) / DAY_MS), expiryState: 'active' };
  }
  if (mem) return { expiryKind: 'expired', expiryAt: mem, daysLeft: null, expiryState: 'expired' };
  return { expiryKind: 'none', expiryAt: 0, daysLeft: null, expiryState: 'none' };
}
