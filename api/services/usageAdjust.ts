/**
 * 历史成本口径修正账本（独立、可逆）
 *
 * 为什么存在：剧情「无限制模式」（成人档）走的是**订阅制**第三方托管（Featherless，按并发
 * 单元计费，token 不单独出账），但 2026-10-03 之前 api/services/usage.ts 把**所有** provider
 * 的 token 一律按 DeepSeek 单价折成钱，于是运营端「API 成本」被高估、利润被低估
 * （修正机制本身见 CHANGELOG #86）。
 *
 * 为什么**不**改写历史：
 *   ① 账本只有「用户 × 功能 × 天」的聚合，没有逐笔记录，也没有 provider 维度，无法精确回算；
 *   ② 流式调用不写 usage 日志（deepseek.ts 只在非流式分支打印），日志也补不出来；
 *   ③ 账本的定位是「当时真实写入的流水」，改掉就没有审计痕迹了。
 * 所以修正做成**独立的一本账**：
 *   - 每条 = 某一天扣掉（或补记）多少钱 + 口径说明 + 估算依据（当日成人/总回合数等）；
 *   - 撤销 = 删条目（remove / clearByKind），历史数据一行不动；
 *   - 读取方：净成本 = usageStore 的账面成本 + 本账本合计（扣减项用**负数**表示）。
 *
 * 数据文件：data/usage-adjust.json（新增文件，不修改任何既有数据）
 */
import crypto from 'crypto';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('usage-adjust.json');

/** 修正类型：flat-upstream = 成人档订阅制上游的 token 曾被按量计价 */
export type UsageAdjustKind = 'flat-upstream' | 'manual';

export interface UsageAdjustment {
  id: string;
  /** 归属日 YYYY-MM-DD */
  date: string;
  /** 金额（元）：**负数 = 从成本里扣掉**（修正高估）；正数 = 补记 */
  amount: number;
  kind: UsageAdjustKind;
  /** 人读说明，管理端直接展示 */
  reason: string;
  /** 估算口径（一句话公式说明），缺省表示非估算（人工补记） */
  method?: string;
  /** 估算依据的原始计数（成人回合数 / 总回合数 / 当日剧情档成本 / 占比） */
  evidence?: Record<string, number | string>;
  createdAt: number;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 估算「成人档 token 被按量计价」这一项逐日应扣回多少（**纯函数**，便于单测）。
 *
 * 口径：某日扣减 = 当日剧情档成本 ×（当日成人档回合数 / 当日剧情档总回合数）。
 *
 * 假设（写清楚，免得以后被当成"精确账单"）：同一套 prompt 构造器下，成人档与官方档的
 * **单回合 token 轮廓近似**。已知的偏差方向：成人档会额外注入 prompts/adult-lexicon.*.txt
 * （约 3KB），所以它单回合其实略贵，本估算因此**偏保守（是下限）**。
 */
export function computeFlatUpstreamAdjustments(input: {
  /** 逐日的剧情回合数（来自 roleplaySessions 的 assistant 消息，viaUnlimited 归因） */
  turnsByDay: Record<string, { total: number; adult: number }>;
  /** 逐日的剧情档账面成本（元，来自 usageStore） */
  roleplayCostByDay: Record<string, number>;
}): Array<Pick<UsageAdjustment, 'date' | 'amount' | 'kind' | 'reason' | 'method' | 'evidence'>> {
  const out: Array<Pick<UsageAdjustment, 'date' | 'amount' | 'kind' | 'reason' | 'method' | 'evidence'>> = [];
  for (const date of Object.keys(input.turnsByDay).sort()) {
    const t = input.turnsByDay[date];
    if (!t || !t.adult || t.adult <= 0) continue;
    const cost = input.roleplayCostByDay[date] || 0;
    if (cost <= 0) continue;
    const denominator = Math.max(1, t.total);
    const share = t.adult / denominator;
    const amount = -round4(cost * share);
    if (amount === 0) continue;
    out.push({
      date,
      amount,
      kind: 'flat-upstream',
      reason: date + ' 成人档（订阅制上游）token 曾被按 DeepSeek 单价计价，按回合占比扣回',
      method: '当日剧情档成本 ×（成人档回合数 / 剧情档总回合数）；单回合 token 轮廓近似，故为下限估计',
      evidence: {
        adultTurns: t.adult,
        totalTurns: denominator,
        roleplayCost: round4(cost),
        adultShare: Math.round(share * 1000) / 1000,
      },
    });
  }
  return out;
}

/** 用量修正账本（导出类是为了单测能「用一份老格式数据新建实例」验证向后兼容） */
export class UsageAdjustStore {
  private items: UsageAdjustment[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<unknown>(FILE, []);
    if (Array.isArray(parsed)) {
      this.items = (parsed as Array<Partial<UsageAdjustment>>).filter(
        (a): a is UsageAdjustment => !!a && typeof a.id === 'string' && typeof a.amount === 'number' && typeof a.date === 'string'
      );
    }
    console.log('💾 [UsageAdjust] 已从磁盘加载 ' + this.items.length + ' 条历史成本修正');
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch (error) {
      console.warn('⚠️ [UsageAdjust] 保存失败:', (error as Error)?.message);
    }
  }

  /** 全部条目（按日期正序） */
  list(): UsageAdjustment[] {
    return this.items.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  }

  /** 现有金额字段残缺的备份（重建前的手工条目要保留） */
  count(): number { return this.items.length; }

  /** 合计（元）：负 = 应扣减 */
  total(): number {
    return round4(this.items.reduce((s, a) => s + (Number(a.amount) || 0), 0));
  }

  /** 合计（元，展示精度两位） */
  totalRounded(): number {
    return round2(this.items.reduce((s, a) => s + (Number(a.amount) || 0), 0));
  }

  /** 某日期区间的合计（含首尾），用于「区间成本」口径 */
  totalInRange(from: string, to: string): number {
    return round4(this.items
      .filter(a => a.date >= from && a.date <= to)
      .reduce((s, a) => s + (Number(a.amount) || 0), 0));
  }

  add(input: { date: string; amount: number; kind?: UsageAdjustKind; reason: string; method?: string; evidence?: Record<string, number | string> }): UsageAdjustment {
    const item: UsageAdjustment = {
      id: crypto.randomUUID(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date().toISOString().slice(0, 10),
      amount: round4(Number(input.amount) || 0),
      kind: input.kind || 'manual',
      reason: String(input.reason || '').slice(0, 300),
      ...(input.method ? { method: String(input.method).slice(0, 300) } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.saveToDisk();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter(a => a.id !== id);
    if (this.items.length === before) return false;
    this.saveToDisk();
    return true;
  }

  /** 删掉某一类条目（重建前先清旧，保证幂等且不误伤手工条目） */
  clearByKind(kind: UsageAdjustKind): number {
    const before = this.items.length;
    this.items = this.items.filter(a => a.kind !== kind);
    const removed = before - this.items.length;
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  /** 把一条条目数组整体写入（替换指定 kind） */
  replaceKind(kind: UsageAdjustKind, entries: Array<Pick<UsageAdjustment, 'date' | 'amount' | 'kind' | 'reason' | 'method' | 'evidence'>>): UsageAdjustment[] {
    this.clearByKind(kind);
    const created = entries.map(e => this.add({ ...e, kind }));
    return created;
  }
}

export const usageAdjustStore = new UsageAdjustStore();
export default usageAdjustStore;

/**
 * 从真实数据重建「成人档」修正条目（幂等：先清掉旧的 flat-upstream 条目再写入）。
 *
 * 数据来源：
 *   - roleplaySessions：每条 assistant 消息的 viaUnlimited / timestamp（客户端自述，漏存就少算）
 *   - usageStore：逐日「剧情扮演」功能的账面成本
 */
export async function rebuildFlatUpstreamAdjustments(): Promise<{ removed: number; added: number; total: number }> {
  const { roleplaySessionStore } = await import('./roleplaySessions.js');
  const { usageStore } = await import('./usage.js');

  const dayKey = (ts: number): string => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  // 1) 逐日回合数（成人档归因）
  const turnsByDay: Record<string, { total: number; adult: number }> = {};
  for (const rec of roleplaySessionStore.listAll()) {
    for (const m of rec.messages || []) {
      if (m.role !== 'assistant' || typeof m.timestamp !== 'number') continue;
      const k = dayKey(m.timestamp);
      const b = (turnsByDay[k] ||= { total: 0, adult: 0 });
      b.total++;
      if (m.viaUnlimited === true) b.adult++;
    }
  }

  // 2) 逐日剧情档账面成本（getFeatureBreakdown 上限 90 天，成人档窗口远小于此）
  const breakdown = usageStore.getFeatureBreakdown(90);
  const roleplayCostByDay: Record<string, number> = {};
  const days = breakdown.daily.length;
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    roleplayCostByDay[key] = breakdown.daily[i]?.byFeature?.roleplay?.cost || 0;
  }

  const computed = computeFlatUpstreamAdjustments({ turnsByDay, roleplayCostByDay });
  const removed = usageAdjustStore.clearByKind('flat-upstream');
  const created = computed.map(e => usageAdjustStore.add({ ...e, kind: 'flat-upstream' }));
  return { removed, added: created.length, total: usageAdjustStore.totalRounded() };
}
