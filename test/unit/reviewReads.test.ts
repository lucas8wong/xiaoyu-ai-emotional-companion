/**
 * 审阅「已读 / 未读」状态存储的单测。
 *
 * store 在 import 时用 process.cwd() 定位 data/，所以必须先 setupTempCwd 再动态 import
 * ——否则会往真实 data/ 里写（AGENTS.md 红线 3：data/ 里是真实用户数据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { reviewReadStore } = await import('../../api/services/reviewReads.js');

const K1 = 'sk_aaaaaaaaaaaaaaaa';
const K2 = 'sk_bbbbbbbbbbbbbbbb';

test('标记已读 → 读回；未标记的键返回 null', () => {
  reviewReadStore.reset();
  assert.equal(reviewReadStore.get(K1), null);
  reviewReadStore.mark([K1], { read: true }, 1_700_000_000_000);
  const s = reviewReadStore.get(K1)!;
  assert.equal(s.readAt, 1_700_000_000_000);
  assert.equal(s.opens, 0, '标已读不该顺手把 opens 加一（打开由 open 单独记）');
  assert.equal(reviewReadStore.stats().read, 1);
});

test('已读 → 未读：清掉 readAt，但保留星标与备注（别把审阅结论一起抹掉）', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1], { read: true, starred: true, note: '结尾又问想不想多说' }, 1000);
  reviewReadStore.mark([K1], { read: false }, 2000);
  const s = reviewReadStore.get(K1)!;
  assert.equal(s.readAt, undefined);
  assert.equal(s.starred, true);
  assert.equal(s.note, '结尾又问想不想多说');
  assert.equal(reviewReadStore.stats().read, 0);
  assert.equal(reviewReadStore.stats().starred, 1);
});

test('打开次数：重复看同一条会累加（看第二遍的样本往往才是真问题）', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1], { read: true, open: true }, 1000);
  reviewReadStore.mark([K1], { open: true }, 2000);
  const s = reviewReadStore.get(K1)!;
  assert.equal(s.opens, 2);
  assert.equal(s.lastOpenAt, 2000);
});

test('批量标记只动给到的键；非法键被忽略', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1, K2], { read: true }, 1000);
  const r = reviewReadStore.mark([K2], { read: false }, 2000);
  assert.equal(r.updated, 1);
  assert.ok(reviewReadStore.get(K1)!.readAt);
  assert.equal(reviewReadStore.get(K2), null, '退未读且无星标/备注/打开记录 → 不留垃圾条目');
  assert.equal(reviewReadStore.mark(['', '   ', 'x'.repeat(80)], { read: true }).updated, 0);
});

test('备注超长被截断，清空备注即删除该字段', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1], { note: '啊'.repeat(600) }, 1000);
  assert.equal(reviewReadStore.get(K1)!.note!.length, 500);
  // 空备注 + 没读过 + 没星标 = 什么都没有 → 直接不留条目（避免垃圾键越攒越多）
  reviewReadStore.mark([K1], { note: '   ' }, 2000);
  assert.equal(reviewReadStore.get(K1), null);

  // 但「读过」的条目清空备注后仍要留着（已读状态不能被备注操作抹掉）
  reviewReadStore.mark([K1], { read: true, note: '慢' }, 3000);
  reviewReadStore.mark([K1], { note: '' }, 4000);
  assert.ok(reviewReadStore.get(K1)!.readAt);
  assert.equal(reviewReadStore.get(K1)!.note, undefined);
});

test('落盘再读回：状态跨进程/跨设备一致（这就是「手机和电脑同一份进度」的依据）', async () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1], { read: true, starred: true, note: '慢' }, 1234);
  const file = path.join(process.cwd(), 'data', 'review-reads.json');
  assert.ok(fs.existsSync(file), '应写出 data/review-reads.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.keys[K1].note, '慢');
  // 文件里**不能**有正文/身份（这里只存指纹 + 时间 + 结论）
  assert.equal(Object.keys(raw).sort().join(','), 'keys,updatedAt,version');

  // 换一个新实例（模拟进程重启）再读
  const mod = await import('../../api/services/reviewReads.js?fresh=1');
  assert.equal(mod.reviewReadStore.get(K1)!.starred, true);
  assert.equal(mod.reviewReadStore.get(K1)!.note, '慢');
});

/* ───────── 2026-09-25：指纹口径 v1（含尾条）→ v2（只锚开头）带来的迁移/清理 ───────── */

test('★ rename：把老键的标记搬到新键（不搬 = 用户之前标过的已读全变回未读）', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1], { read: true, starred: true, note: '问句收尾' }, 1000);
  reviewReadStore.mark([K2], { read: true, open: true }, 2000);

  assert.equal(reviewReadStore.rename(K1, K2), true);
  assert.equal(reviewReadStore.get(K1), null, '老键要清掉，否则这份文件会越攒越多死键');
  const s = reviewReadStore.get(K2)!;
  assert.equal(s.readAt, 1000, 'readAt 取更早的（第一次读到的时刻）');
  assert.equal(s.starred, true, '星标不能因为搬家丢掉');
  assert.equal(s.note, '问句收尾', '备注不能因为搬家丢掉');
  assert.equal(s.opens, 1, 'opens 取两边更大的');

  // 幂等：老键已经不在了 → false，且不该清掉新键
  assert.equal(reviewReadStore.rename(K1, K2), false);
  assert.ok(reviewReadStore.get(K2));
  // 同键 / 空键不动
  assert.equal(reviewReadStore.rename(K2, K2), false);
  assert.equal(reviewReadStore.rename('', K2), false);
});

test('★ prune：清掉不在档案里的键（迁移遗留 + 被档案上限丢弃的），在档的标记一个不动', () => {
  reviewReadStore.reset();
  reviewReadStore.mark([K1, K2], { read: true }, 1000);
  assert.equal(reviewReadStore.prune(new Set([K1])), 1);
  assert.ok(reviewReadStore.get(K1)!.readAt, '还在档案里的标记不能被清');
  assert.equal(reviewReadStore.get(K2), null);
  assert.equal(reviewReadStore.prune(new Set([K1])), 0, '没什么可清时返回 0（不触发多余落盘）');
});
