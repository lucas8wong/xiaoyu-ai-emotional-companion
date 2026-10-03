import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

setupTempCwd();
// 固定计费单价，避免受 .env 影响导致断言不确定
process.env.INPUT_PRICE_PER_M = '2';
process.env.OUTPUT_PRICE_PER_M = '8';
process.env.CACHE_PRICE_RATIO = '0.25';
// 默认关掉分时定价（下面专门有 peak 用例再打开）：否则「跑测试的时刻恰好落在 UTC peak 窗口」
// 会让所有精确金额断言随机翻倍（2026-09-17 首次实现时就踩到：当时正是 UTC 03:17 的 peak 时段）
process.env.PRICE_PEAK_ENABLED = '0';
const mod = await import('../../api/services/usage.js');
const { usageStore, SYSTEM_USER_ID, normalizeFeature, FEATURE_LABELS, costFromUsage, isPeakAt, priceMultiplierAt, peakPricingInfo } = mod as any;

test('record：累计 token/费用/次数，含缓存命中折算', () => {
  usageStore.record('u1', { prompt_tokens: 1000, completion_tokens: 500 });
  usageStore.record('u1', { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens: 500 });

  const r = usageStore.get('u1')!;
  assert.strictEqual(r.requests, 2);
  assert.strictEqual(r.promptTokens, 2000, '非缓存 prompt 应为 1000+1000');
  assert.strictEqual(r.cachedTokens, 1000);
  assert.strictEqual(r.completionTokens, 1000);
  // cost = rec1(1000 prompt + 500 completion) + rec2(1000 prompt + 1000 cached + 500 completion)
  const expected =
    (1000 / 1e6) * 2 + (500 / 1e6) * 8 +
    (1000 / 1e6) * 2 + (1000 / 1e6) * 2 * 0.25 + (500 / 1e6) * 8;
  assert.ok(Math.abs(r.cost - expected) < 1e-6, '费用应按公式估算');
  assert.ok(r.lastUsed > 0);
});

test('record：usage 为空也计一次请求', () => {
  usageStore.record('u2', undefined);
  const r = usageStore.get('u2')!;
  assert.strictEqual(r.requests, 1);
  assert.strictEqual(r.cost, 0);
});

test('totalCost / getDailyTrend / deleteByUser', () => {
  usageStore.record('u1', { prompt_tokens: 1000, completion_tokens: 500 });
  assert.ok(usageStore.totalCost() > 0);

  const trend = usageStore.getDailyTrend(7);
  assert.strictEqual(trend.length, 7);
  assert.ok(trend[6].requests >= 1, '今天至少有 1 次请求');

  usageStore.deleteByUser('u1');
  assert.strictEqual(usageStore.get('u1'), undefined);
});

// ── 功能细分（2026-09-17 新增：控制台要能回答「这笔钱是谁花的」） ──

test('record：按 feature 分桶，总额 = 各桶之和', () => {
  usageStore.record('u3', { prompt_tokens: 1000, completion_tokens: 500 }, 'chat');
  usageStore.record('u3', { prompt_tokens: 1000, completion_tokens: 500 }, 'roleplay');

  const bf = usageStore.getUserFeatureBreakdown('u3');
  assert.ok(bf.chat && bf.roleplay, '应分别有 chat / roleplay 两个桶');
  assert.strictEqual(bf.chat.requests, 1);
  assert.strictEqual(bf.roleplay.requests, 1);
  const sum = Object.values(bf).reduce((s, b) => s + b.cost, 0);
  assert.ok(Math.abs(sum - usageStore.get('u3')!.cost) < 1e-6, '分桶金额之和应等于该用户总额');
});

test('record：feature 缺省/脏值一律归 unknown（不撑开控制台表格）', () => {
  usageStore.record('u4', { prompt_tokens: 100, completion_tokens: 10 });
  usageStore.record('u4', { prompt_tokens: 100, completion_tokens: 10 }, '不存在的功能');
  const bf = usageStore.getUserFeatureBreakdown('u4');
  assert.deepStrictEqual(Object.keys(bf), ['unknown']);
  assert.strictEqual(bf.unknown.requests, 2);
  assert.strictEqual(normalizeFeature('chat'), 'chat');
  assert.strictEqual(normalizeFeature(undefined), 'unknown');
  assert.strictEqual(FEATURE_LABELS.chat, '聊一聊');
});

test('recordImageCost：按张计费入账（出图成本不再只算 token）', () => {
  const before = usageStore.totalCost();
  usageStore.recordImageCost('u5', { provider: 'wanx', count: 2, yuan: 0.28, feature: 'image' });
  usageStore.recordImageCost(SYSTEM_USER_ID, { provider: 'seedream', count: 1, yuan: 0.2 }); // 缺省 feature=image

  const u5 = usageStore.get('u5')!;
  assert.ok(Math.abs(u5.cost - 0.28) < 1e-6, '图片成本应计入用户成本');
  const bf = usageStore.getUserFeatureBreakdown('u5');
  assert.strictEqual(bf.image.images, 2, '张数应累计');
  assert.ok(Math.abs(bf.image.imageCost - 0.28) < 1e-6);
  assert.ok(Math.abs(bf.image.cost - 0.28) < 1e-6, '桶内成本含图片成本');

  const sys = usageStore.getUserFeatureBreakdown(SYSTEM_USER_ID);
  assert.strictEqual(sys.image.images, 1, '运营出图记到系统行');

  const after = usageStore.totalCost();
  assert.ok(after > before, '图片成本应体现在总额里');
});

test('estimated 标记：流式拿不到真实 usage 的估算调用可被识别', () => {
  usageStore.record('u6', { prompt_tokens: 100, completion_tokens: 20 }, 'roleplay', { estimated: true });
  usageStore.record('u6', { prompt_tokens: 100, completion_tokens: 20 }, 'roleplay');
  const bf = usageStore.getUserFeatureBreakdown('u6');
  assert.strictEqual(bf.roleplay.requests, 2);
  assert.strictEqual(bf.roleplay.estimated, 1, '只有估算的那一次被标记');
});

test('getFeatureBreakdown：区间汇总 + 按天，空天补 0，合计与总额一致', () => {
  usageStore.record('u7', { prompt_tokens: 1000, completion_tokens: 0 }, 'wenyou');
  usageStore.recordImageCost('u7', { provider: 'cogview', count: 1, yuan: 0.06 });
  const fb = usageStore.getFeatureBreakdown(7);
  assert.strictEqual(fb.daily.length, 7);
  assert.strictEqual(fb.range.days, 7);
  const today = fb.daily[6];
  assert.ok(today.byFeature.wenyou, '今天应有文游桶');
  assert.ok(today.byFeature.image, '今天应有出图桶');
  // 当天总成本 = 当天所有功能桶之和（本文件前面的用例也记在「今天」，所以必须全量求和）
  // 容差说明：总额按展示精度 round4、分桶按 round6（写入路径一律保留原值）→ 允许 1 个 round4 单位
  const bucketSum = Object.values(today.byFeature).reduce((s, b) => s + b.cost, 0);
  assert.ok(Math.abs(today.cost - bucketSum) < 1e-4, `当天总额应等于分桶之和（展示精度内：${today.cost} vs ${bucketSum}）`);
  const dayReqSum = Object.values(today.byFeature).reduce((s, b) => s + b.requests, 0);
  assert.strictEqual(today.requests, dayReqSum, '当天调用次数也应等于分桶之和');
  assert.ok(fb.totals.images >= 1);
  assert.ok(fb.totals.imageCost > 0);
});

test('升级当天的混装记录：残差补齐为「历史未分类」，分桶之和恒等于总额', () => {
  // 实测场景（2026-09-17 上线当天）：上午旧代码写、下午新代码写 →
  // byFeature 只盖住新代码那部分（实测 207 次里仅 5 次带标记），残差 202 次必须显式可见，
  // 否则控制台会出现「分桶之和 < 当天合计」这种对不上的账。
  const mixed = [{
    userId: 'mixed1', requests: 10, promptTokens: 900, cachedTokens: 100, completionTokens: 200, cost: 1.0,
    lastUsed: Date.now(),
    byFeature: {
      roleplay: { requests: 2, promptTokens: 200, cachedTokens: 0, completionTokens: 50, cost: 0.3, images: 0, imageCost: 0, estimated: 0 },
      image: { requests: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0.06, images: 1, imageCost: 0.06, estimated: 0 },
    },
  }];
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify(mixed), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'usage-daily.json'), JSON.stringify([]), 'utf8');

  const store = new (mod as any).UsageStore();
  const bf = store.getUserFeatureBreakdown('mixed1');
  assert.strictEqual(bf.roleplay.requests, 2, '带标记的部分原样保留');
  assert.strictEqual(bf.image.images, 1);
  assert.strictEqual(bf.unknown.requests, 7, '残差 10-2-1=7 次归入历史未分类');
  assert.ok(Math.abs(bf.unknown.cost - 0.64) < 1e-6, '残差金额 1.0-0.3-0.06=0.64');
  const reqSum = Object.values(bf).reduce((s, b) => s + b.requests, 0);
  const costSum = Object.values(bf).reduce((s, b) => s + b.cost, 0);
  assert.strictEqual(reqSum, 10, '分桶次数之和必须等于总额次数');
  assert.ok(Math.abs(costSum - 1.0) < 1e-6, '分桶金额之和必须等于总额金额');
});


// ── 分时定价（peak ×2）：DeepSeek 官方 peak = 周一至周五 01:00–04:00 与 06:00–10:00 UTC ──

test('isPeakAt：时段边界与周末（UTC 判定，左闭右开）', () => {
  process.env.PRICE_PEAK_ENABLED = '1';
  try {
    const T = (iso: string) => Date.parse(iso);
    // 2026-09-17 是周四；2026-09-19 周六；2026-09-14 周一
    assert.strictEqual(isPeakAt(T('2026-09-17T02:00:00Z')), true, '周四 02:00 UTC 在 peak 窗口');
    assert.strictEqual(isPeakAt(T('2026-09-17T00:59:00Z')), false, '00:59 未进窗口');
    assert.strictEqual(isPeakAt(T('2026-09-17T01:00:00Z')), true, '01:00 左闭');
    assert.strictEqual(isPeakAt(T('2026-09-17T04:00:00Z')), false, '04:00 右开');
    assert.strictEqual(isPeakAt(T('2026-09-17T05:00:00Z')), false, '窗口之间的空档');
    assert.strictEqual(isPeakAt(T('2026-09-17T09:59:00Z')), true, '第二窗口内');
    assert.strictEqual(isPeakAt(T('2026-09-17T10:00:00Z')), false, '10:00 右开');
    assert.strictEqual(isPeakAt(T('2026-09-19T02:00:00Z')), false, '周六同小时不算 peak');
    assert.strictEqual(isPeakAt(T('2026-09-20T02:00:00Z')), false, '周日不算 peak');
    assert.strictEqual(isPeakAt(T('2026-09-14T02:00:00Z')), true, '周一算 peak');
  } finally { process.env.PRICE_PEAK_ENABLED = '0'; }
});

test('costFromUsage：带 at 时 peak 段 ×倍率，off-peak / 不传 at 用基准价', () => {
  process.env.PRICE_PEAK_ENABLED = '1';
  try {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 0 }; // 输入 1M → 基准 2 元
    const base = costFromUsage(usage);                    // 不传 at = 基准（额度层口径）
    const peak = costFromUsage(usage, Date.parse('2026-09-17T02:00:00Z'));
    const off = costFromUsage(usage, Date.parse('2026-09-17T05:00:00Z'));
    assert.strictEqual(base, 2, '不传 at 时按 off-peak 基准价（用户点数口径）');
    assert.strictEqual(off, 2, 'off-peak 时段不加价');
    assert.strictEqual(peak, 4, 'peak 时段 ×2');
    assert.strictEqual(priceMultiplierAt(Date.parse('2026-09-17T02:00:00Z')), 2);
  } finally { process.env.PRICE_PEAK_ENABLED = '0'; }
});

test('record：按「调用发起时刻」记账（peak 段的同一次调用成本翻倍）', () => {
  process.env.PRICE_PEAK_ENABLED = '1';
  try {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    usageStore.record('peak_user', usage, 'chat', { at: Date.parse('2026-09-17T02:00:00Z') });
    usageStore.record('peak_user', usage, 'chat', { at: Date.parse('2026-09-17T05:00:00Z') });
    const bf = usageStore.getUserFeatureBreakdown('peak_user');
    assert.strictEqual(bf.chat.requests, 2);
    assert.strictEqual(bf.chat.cost, 6, '一次 ×2（4 元）+ 一次 ×1（2 元）');
  } finally { process.env.PRICE_PEAK_ENABLED = '0'; }
});

test('PRICE_PEAK_ENABLED=0：整体关掉分时定价（回到单一 off-peak 价）', () => {
  process.env.PRICE_PEAK_ENABLED = '0';
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0 };
  assert.strictEqual(costFromUsage(usage, Date.parse('2026-09-17T02:00:00Z')), 2, '关掉后 peak 段也是基准价');
  const info = peakPricingInfo();
  assert.strictEqual(info.enabled, false);
  assert.strictEqual(info.activeNow, false);
  assert.strictEqual(info.multiplier, 2, '倍率仍可读（供 UI 展示）');
});

test('向后兼容：升级前写入的记录（无 byFeature）归入「历史未分类」，总额不变', () => {
  // 直接落一份「老格式」usage.json（没有 byFeature 字段），再用**新建实例**加载：
  // 目的 = 保证线上升级后，历史总额与趋势图口径一个数都不变，细分里显示为「历史未分类」。
  const legacy = [{
    userId: 'legacy1', requests: 3, promptTokens: 111, cachedTokens: 22,
    completionTokens: 33, cost: 1.2345, lastUsed: Date.now(),
  }];
  const legacyDaily = [{ date: '2026-01-01', requests: 3, promptTokens: 111, cachedTokens: 22, completionTokens: 33, cost: 1.2345 }];
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify(legacy), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'usage-daily.json'), JSON.stringify(legacyDaily), 'utf8');

  const { UsageStore } = mod;
  const store = new UsageStore();
  assert.strictEqual(store.totalCost(), 1.23, '历史总额口径不变（保留两位）');
  const bf = store.getUserFeatureBreakdown('legacy1');
  assert.deepStrictEqual(Object.keys(bf), ['unknown']);
  assert.strictEqual(bf.unknown.cost, 1.2345);
  assert.strictEqual(bf.unknown.requests, 3);
  const daily = store.getFeatureBreakdown(400); // 超过上限会被 clamp 到 90，不应抛错
  assert.ok(Array.isArray(daily.daily));
});

// ── 订阅制上游（剧情「无限制模式」的第三方托管）：token 照记，但不按 token 花钱 ──

test('record(flatRate)：订阅制调用不计 token 成本，只留参考价', () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.writeFileSync(path.join(dataDir, 'usage.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'usage-daily.json'), '[]', 'utf8');
  const store = new mod.UsageStore();

  store.record('flat-u1', { prompt_tokens: 1000, completion_tokens: 500 }, 'roleplay', { flatRate: true });

  const r = store.get('flat-u1')!;
  assert.strictEqual(r.requests, 1, '调用次数照记');
  assert.strictEqual(r.promptTokens, 1000, 'token 照记（控制台/额度仍要看）');
  assert.strictEqual(r.completionTokens, 500);
  assert.strictEqual(r.cost, 0, '订阅制上游不产生按量成本');
  assert.strictEqual(r.flatCalls, 1);
  const expected = (1000 / 1e6) * 2 + (500 / 1e6) * 8;
  assert.ok(Math.abs((r.notionalCost || 0) - expected) < 1e-6, '参考价 = 若按 DeepSeek 单价折算');
  assert.strictEqual(store.totalCost(), 0, '真实成本不因订阅制调用增加');

  const bf = store.getUserFeatureBreakdown('flat-u1');
  assert.strictEqual(bf.roleplay.cost, 0);
  assert.strictEqual(bf.roleplay.flatCalls, 1);
  assert.ok(Math.abs(bf.roleplay.notionalCost - expected) < 1e-6);
  assert.strictEqual(bf.roleplay.requests, 1, '请求数不受影响，仍看得出这个功能在被用');
});

test('getFeatureBreakdown：订阅制计入 flatCalls/notionalCost，但绝不进 cost', () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.writeFileSync(path.join(dataDir, 'usage.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'usage-daily.json'), '[]', 'utf8');
  const store = new mod.UsageStore();

  store.record('flat-u2', { prompt_tokens: 1000, completion_tokens: 0 }, 'roleplay', { flatRate: true });
  store.record('flat-u2', { prompt_tokens: 1000, completion_tokens: 0 }, 'chat'); // 对照组：按量

  const d = store.getFeatureBreakdown(1);
  assert.strictEqual(d.totals.flatCalls, 1, '区间内订阅制调用数');
  assert.ok(Math.abs(d.totals.notionalCost - 0.002) < 1e-9, '参考价 1000 prompt × 2 元/M');
  assert.ok(Math.abs(d.totals.cost - 0.002) < 1e-9, '真实成本只来自按量那条 chat');
  assert.strictEqual(d.totals.byFeature.roleplay.flatCalls, 1);
  assert.strictEqual(d.totals.byFeature.roleplay.cost, 0);
  assert.strictEqual(d.totals.byFeature.chat.flatCalls, 0);

  const day = store.getDailyTrend(1)[0];
  assert.strictEqual(day.flatCalls, 1);
  assert.ok(Math.abs(day.notionalCost - 0.002) < 1e-9);
  assert.ok(Math.abs(day.cost - 0.002) < 1e-9, '趋势图的 cost 不含订阅制');
});

test('向后兼容：老记录没有 flatCalls/notionalCost 也当 0（不产生 NaN）', () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  const legacy = [{ userId: 'legacy2', requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 10, cost: 0.5, lastUsed: Date.now() }];
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify(legacy), 'utf8');
  const store = new mod.UsageStore();
  const bf = store.getUserFeatureBreakdown('legacy2');
  assert.strictEqual(bf.unknown.flatCalls, 0);
  assert.strictEqual(bf.unknown.notionalCost, 0);
  assert.strictEqual(store.totalCost(), 0.5);
});

