/**
 * 历史成本口径修正账本（独立、可逆）的单测。
 *
 * 为什么值得测：这本账直接改运营端看到的「利润」，而且它的每一条都是**估算**，
 * 口径（逐日按回合占比、负数扣减、重建幂等、不误伤手工条目）一旦漂了没人会发现。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const mod = await import('../../api/services/usageAdjust.js');
const { UsageAdjustStore, computeFlatUpstreamAdjustments } = mod as any;

const FRESH = () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage-adjust.json'), '[]', 'utf8');
  return new UsageAdjustStore();
};

test('computeFlatUpstreamAdjustments：按当日回合占比扣减，金额为负（下限估计）', () => {
  const out = computeFlatUpstreamAdjustments({
    turnsByDay: { '2026-10-02': { total: 100, adult: 50 }, '2026-10-03': { total: 10, adult: 0 } },
    roleplayCostByDay: { '2026-10-02': 10, '2026-10-03': 5 },
  });
  assert.strictEqual(out.length, 1, '只有成人回合>0 且当日有成本才产生条目');
  assert.strictEqual(out[0].date, '2026-10-02');
  assert.strictEqual(out[0].amount, -5, '10 元 × 50% 扣 5');
  assert.strictEqual(out[0].kind, 'flat-upstream');
  assert.strictEqual((out[0].evidence as any).adultTurns, 50);
  assert.ok(String(out[0].method).includes('下限'), '口径要写明是下限估计');
});

test('computeFlatUpstreamAdjustments：无成人回合 / 无成本的天一律不产生条目', () => {
  const out = computeFlatUpstreamAdjustments({
    turnsByDay: { a: { total: 0, adult: 0 }, b: { total: 10, adult: 3 } },
    roleplayCostByDay: { a: 1, b: 0 },
  });
  assert.strictEqual(out.length, 0);
});

test('账本：负数累加、区间合计、删除即撤销', () => {
  const store = FRESH();
  const a = store.add({ date: '2026-10-02', amount: -6.87, reason: 'x' });
  store.add({ date: '2026-10-03', amount: -1.09, reason: 'y' });
  assert.strictEqual(store.totalRounded(), -7.96);

  assert.strictEqual(store.totalInRange('2026-10-02', '2026-10-02'), -6.87);
  assert.strictEqual(store.totalInRange('2026-10-03', '2026-10-03'), -1.09);

  assert.strictEqual(store.remove(a.id), true);
  assert.strictEqual(store.totalRounded(), -1.09, '删掉就回到未修正状态（可逆）');
  assert.strictEqual(store.remove('不存在'), false);
});

test('replaceKind 幂等：重建只替换同类条目，不误伤手工补记', () => {
  const store = FRESH();
  store.add({ date: '2026-10-02', amount: -6.87, kind: 'flat-upstream', reason: '旧' });
  store.add({ date: '2026-10-02', amount: 3, kind: 'manual', reason: '手工补记' });

  store.replaceKind('flat-upstream', computeFlatUpstreamAdjustments({
    turnsByDay: { '2026-10-02': { total: 4, adult: 1 } },
    roleplayCostByDay: { '2026-10-02': 8 },
  }) as any);
  const first = store.totalRounded();
  assert.strictEqual(first, -2 + 3, '旧条目被替换成 -2，手工的 +3 还在');

  store.replaceKind('flat-upstream', computeFlatUpstreamAdjustments({
    turnsByDay: { '2026-10-02': { total: 4, adult: 1 } },
    roleplayCostByDay: { '2026-10-02': 8 },
  }) as any);
  assert.strictEqual(store.totalRounded(), first, '重建两次结果一致（幂等）');
  assert.strictEqual(store.list().filter((x: any) => x.kind === 'flat-upstream').length, 1);
});

test('向后兼容：老/脏数据不炸，非法条目被丢弃，磁盘重载保留', () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.writeFileSync(path.join(dataDir, 'usage-adjust.json'), JSON.stringify([
    { id: 'ok', date: '2026-10-02', amount: -1.5, kind: 'flat-upstream', reason: 'r', createdAt: 1 },
    { date: 'no-id', amount: -1, reason: '缺 id' },
    { id: 'bad', date: '2026-10-02', reason: '缺 amount' },
  ]), 'utf8');

  const store = new UsageAdjustStore();
  assert.strictEqual(store.count(), 1, '只有结构完整的那条被加载');
  assert.strictEqual(store.totalRounded(), -1.5);
});
