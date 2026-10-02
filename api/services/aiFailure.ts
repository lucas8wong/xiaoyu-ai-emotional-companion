/**
 * AI 失败/超时埋点（2026-09-15 事故后新增，用来把「AI 没接上」变成运营端可见的数字）
 *
 * 背景：本次事故里用户等了 37 分钟只看到「网络好像开小差了」，而**服务端完全不知情**
 * （连接在传输层就断了，服务端日志被重启覆盖），运营端看不到任何异常，
 * 只能等用户投诉。这里按「日 × 功能 × 失败原因码」记数，并区分「自动重试救回来」的次数。
 *
 * 口径与隐私：
 * - 只记 feature / code / 是否恢复 / 时间戳，**不记 userId、不记任何用户内容**；
 * - 日期键用服务端本地日期 YYYY-MM-DD；
 * - 数据文件 data/ai-failures.json，只保留最近 30 天 + 最近 30 条事件明细；
 * - 测试设备不计（入口路由层已过滤）；
 * - **「系统护栏」类原因码另算**（`GUARD_CODES`）：它不是 AI 没接上，而是服务端主动拒写，
 *   用户看不到任何提示 → 不能计入「用户实际看到失败提示」（详见 GUARD_CODES 的注释）；
 * - **「回复被截断」类另算**（`isTruncationCode`）：有回复、只是没收尾，用户看到的是
 *   「没写完 · 续写」提示条（可自助续写），也不是失败提示条 → 同样不计入失败提示量。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const AI_FAIL_FILE = dataFile('ai-failures.json');
const KEEP_DAYS = 30;
const MAX_RECENT = 30;

/**
 * 「系统护栏」类原因码（2026-09-18 立），**不是 AI 没接上**，是服务端主动拒写。
 *
 * 目前只有 `UNANSWERED_TURN`（`roleplaySessions.save()` 拦下「把已生成的回复截掉的中间态写入」，
 * 判据见 `src/lib/rpWriteGuard.ts`）。为什么要单独一类：
 *   它命中时**用户看不到任何失败提示**（这一轮的新回复回来后正常落盘），可它以前被算进
 *   `total` 又没被算进 `recovered`，于是运营卡上「用户实际看到失败提示 = 失败 − 救回」把护栏命中
 *   当成了用户可见失败，2026-09-18 当天 25 次里 16 次是这么来的，等于把卡片数字凭空放大 1.8 倍。
 * 口径：`total` 仍是「记下来的全部事件」（不改历史语义），护栏命中另算 `guardTotal / guardByCode`，
 * 由展示端从「用户实际看到失败提示」里剔除。
 */
export const GUARD_CODES: readonly string[] = ['UNANSWERED_TURN'];
const isGuardCode = (code: string): boolean => GUARD_CODES.includes(code);

/**
 * 「回复被截断」类原因码（`PARTIAL` / `PARTIAL_LENGTH` / `PARTIAL_UNCLOSED` / `PARTIAL_MID_SENTENCE`）。
 *
 * 语义上它**不是「没接上」**：这一轮**有回复**，只是没收尾。用户看到的是气泡下方那条琥珀提示
 * 「没写完 · 续写」（点一下就能接着写下去），**不是**失败提示条。所以运营卡上它要和真失败分开算、
 * 并写明"用户可见后果"（2026-09-18 用户拍板 C：口径要更细，别让管理员把 9 次截断读成 9 次失败）。
 */
export const isTruncationCode = (code: string): boolean => code === 'PARTIAL' || code.startsWith('PARTIAL_');

export interface AiFailDay {
  /** 这一轮 AI 没接上的次数（= 需要提示/重试的次数） */
  total: number;
  /** 其中被「自动重试一次」救回来的次数（用户无感） */
  recovered: number;
  byFeature: Record<string, number>;
  byCode: Record<string, number>;
}
export interface AiFailEvent { at: number; feature: string; code: string; recovered: boolean }
interface Shape { days: Record<string, AiFailDay>; recent: AiFailEvent[] }

const emptyDay = (): AiFailDay => ({ total: 0, recovered: 0, byFeature: {}, byCode: {} });
const dayKey = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const bump = (obj: Record<string, number>, key: string): void => { obj[key] = (obj[key] || 0) + 1; };

class AiFailureStore {
  private data: Shape = { days: {}, recent: [] };

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<Shape>(AI_FAIL_FILE, { days: {}, recent: [] });
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      this.data = { days: parsed.days, recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
    }
  }

  private saveToDisk(): void {
    try { writeJson(AI_FAIL_FILE, this.data); } catch { /* 忽略：埋点失败绝不影响主流程 */ }
  }

  /** 记一次「AI 没接上」。recovered=true 表示这次由「自动重试一次」救回来了（用户无感） */
  record(feature: string, code: string, recovered = false): void {
    const at = Date.now();
    const key = dayKey(at);
    const day = this.data.days[key] || emptyDay();
    // 口径：total = 所有「这一轮 AI 没接上」的次数（含后来被救回的），
    // recovered = 其中被自动重试救回的；所以「用户实际看到失败提示 ≈ total - recovered」。
    day.total += 1;
    if (recovered) day.recovered += 1;
    bump(day.byFeature, feature || 'other');
    bump(day.byCode, code || 'UNKNOWN');
    this.data.days[key] = day;
    this.data.recent.unshift({ at, feature: feature || 'other', code: code || 'UNKNOWN', recovered });
    this.data.recent = this.data.recent.slice(0, MAX_RECENT);
    // 只留最近 KEEP_DAYS 天
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > KEEP_DAYS) {
      const drop = keys.shift()!;
      delete this.data.days[drop];
    }
    this.saveToDisk();
  }

  /**
   * 近 N 天汇总（含今日）；按日期倒序。
   * `guardTotal/guardByCode` = 其中「系统护栏」类（见 GUARD_CODES，用户无感）；
   * `truncatedTotal/truncatedByCode` = 其中「回复被截断」类（见 isTruncationCode，用户看到的是「没写完 · 续写」提示条）。
   */
  summary(days = 7): { days: { date: string; total: number; recovered: number; guardTotal: number; truncatedTotal: number; byFeature: Record<string, number>; byCode: Record<string, number> }[]; total: number; recovered: number; guardTotal: number; guardByCode: Record<string, number>; truncatedTotal: number; truncatedByCode: Record<string, number>; byCode: Record<string, number>; byFeature: Record<string, number>; recent: AiFailEvent[] } {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 7));
    const now = Date.now();
    const out: { date: string; total: number; recovered: number; guardTotal: number; truncatedTotal: number; byFeature: Record<string, number>; byCode: Record<string, number> }[] = [];
    const totalByCode: Record<string, number> = {};
    const totalByFeature: Record<string, number> = {};
    const guardByCode: Record<string, number> = {};
    const truncatedByCode: Record<string, number> = {};
    let total = 0, recovered = 0, guardTotal = 0, truncatedTotal = 0;
    for (let i = 0; i < n; i++) {
      const date = dayKey(now - i * 86400000);
      const d = this.data.days[date];
      const dayByCode = d?.byCode || {};
      // 单日分类量：由原因码现算（不改落盘结构 → 老数据零迁移）
      const dayGuard = Object.entries(dayByCode).reduce((acc, [k, v]) => acc + (isGuardCode(k) ? v : 0), 0);
      const dayTruncated = Object.entries(dayByCode).reduce((acc, [k, v]) => acc + (isTruncationCode(k) ? v : 0), 0);
      out.push({
        date,
        total: d?.total || 0,
        recovered: d?.recovered || 0,
        guardTotal: dayGuard,
        truncatedTotal: dayTruncated,
        byFeature: d?.byFeature || {},
        byCode: dayByCode,
      });
      if (d) {
        total += d.total;
        recovered += d.recovered;
        guardTotal += dayGuard;
        truncatedTotal += dayTruncated;
        for (const [k, v] of Object.entries(dayByCode)) {
          totalByCode[k] = (totalByCode[k] || 0) + v;
          if (isGuardCode(k)) guardByCode[k] = (guardByCode[k] || 0) + v;
          if (isTruncationCode(k)) truncatedByCode[k] = (truncatedByCode[k] || 0) + v;
        }
        for (const [k, v] of Object.entries(d.byFeature)) totalByFeature[k] = (totalByFeature[k] || 0) + v;
      }
    }
    return { days: out, total, recovered, guardTotal, guardByCode, truncatedTotal, truncatedByCode, byCode: totalByCode, byFeature: totalByFeature, recent: this.data.recent.slice(0, MAX_RECENT) };
  }
}

export const aiFailureStore = new AiFailureStore();
