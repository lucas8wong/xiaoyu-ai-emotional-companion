/**
 * 小愈「今天自己这边的小事」（off-screen life，2026-09-19）
 *
 * 起因（用户原话）：「我感觉他们的 ai 说话就好像是我真的在和一个朋友打趣聊天，还会吐槽分享之类」
 * → 诊断结论：小愈的 system 里**所有素材都是"关于用户的"**，她自己没有可分享的东西，
 * 所以只会回应、从不带来自己的东西 —— 那在体感上是客服不是朋友。
 *
 * 这组断言钉死五件事：
 *   ① 过滤真的会丢脏内容（自伤词/医疗承诺词/超长/重复/第三人称"用户"）—— 陪伴不是治疗这条红线不放松；
 *   ② 兜底池同一天稳定、按天轮换（模型失败时功能不消失，但也不会同一天反复变）；
 *   ③ 缓存**按天失效**（跨天不注入过期的小事）、按角色分开存；
 *   ④ 注入块三语齐全、空条目不注入空噪声，且写死了「不要每轮都提 / 别硬拗到 TA 的情绪上」；
 *   ⑤ 真的进得了「聊一聊」的 system（有当天条目时才进）、开关 `CHAT_DAILY_LIFE=0` 能关掉。
 *
 * ⚠️ 单测**不发真实模型调用**：生成路径（`ensureDailyLife`）在这里只验"开关关掉时连调用都不发"，
 *    真实生成质量由 `temp/eval-chat-dailylife.mts` 用真模型单独验（那条要花钱，不放进 CI）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const dl: any = await import('../../api/services/chatDailyLife.js');
const gem: any = await import('../../api/services/gemini.js');
const { todayKeyIn } = await import('../../api/services/timeAnchor.js');

const TODAY = todayKeyIn('Asia/Hong_Kong');
const YESTERDAY = '2020-01-01';

/* ───────── ① 过滤：宁可少，不要脏 ───────── */

test('过滤：自伤词 / 医疗承诺词 / 超长 / 重复 / 第三人称「用户」一律丢掉', () => {
  const got = dl.sanitizeDailyItems([
    '窗台那盆东西今天又冒了一点新芽',
    '今天有点想死',
    '陪我做个疗愈的小练习吧',
    '窗台那盆东西今天又冒了一点新芽', // 重复
    '用户今天没来',
    '啊'.repeat(80), // 超长
    '楼下那家早餐摊没开，白跑一趟',
  ]);
  assert.deepEqual(got, ['窗台那盆东西今天又冒了一点新芽', '楼下那家早餐摊没开，白跑一趟'], '过滤结果不对：' + JSON.stringify(got));
});

test('过滤：非数组 / 全脏 → 返回空数组（调用方据此退回静态池）', () => {
  assert.deepEqual(dl.sanitizeDailyItems('不是数组'), []);
  assert.deepEqual(dl.sanitizeDailyItems(['今天想死', '疗愈一下']), []);
});

test('过滤：最多留 ITEMS_PER_DAY 条（每天 2 条，不堆成清单）', () => {
  const got = dl.sanitizeDailyItems(['一', '二', '三', '四'].map((s) => s + '件小事发生在我这边'));
  assert.equal(got.length, 2, '条数没被截住：' + JSON.stringify(got));
});

/* ───────── ② 兜底池：同一天稳定、跨天轮换 ───────── */

test('兜底池：同一天两次调用结果一致（免得同一天刷新就换一批）', () => {
  assert.deepEqual(dl.fallbackItems('2026-09-19', 'zh'), dl.fallbackItems('2026-09-19', 'zh'));
  assert.equal(dl.fallbackItems('2026-09-19', 'zh').length, 2);
});

test('兜底池：不同日期会轮换（不是每天同一句）', () => {
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'];
  const sets = days.map((d) => dl.fallbackItems(d, 'zh').join('|'));
  assert.ok(new Set(sets).size >= 2, '几天下来兜底池完全没轮换：' + JSON.stringify(sets));
});

test('兜底池：英文独立文案，且通过同一套过滤（兜底也不能脏）', () => {
  const en = dl.fallbackItems('2026-09-19', 'en');
  assert.equal(en.length, 2);
  for (const t of en) assert.ok(/[A-Za-z]/.test(t), '英文兜底里混进了非英文：' + t);
  assert.deepEqual(dl.sanitizeDailyItems(en), dl.sanitizeDailyItems(en), '兜底条目应能原样通过过滤');
});

/* ───────── ③ 缓存：按天失效、按角色分开 ───────── */

test('缓存：put 之后 peek 拿得到；换一天就当作没有（不注入过期的小事）', () => {
  dl.chatDailyLifeStore.put('u-cache', 'xiaoyu', TODAY, ['今天把柜子翻了一遍'], 'model');
  assert.deepEqual(dl.chatDailyLifeStore.peek('u-cache', 'xiaoyu', TODAY).map((i: any) => i.text), ['今天把柜子翻了一遍']);
  assert.deepEqual(dl.chatDailyLifeStore.peek('u-cache', 'xiaoyu', YESTERDAY), [], '跨天没有失效');
});

test('缓存：不同角色各存各的（不串味）', () => {
  dl.chatDailyLifeStore.put('u-two', 'xiaoyu', TODAY, ['小愈的事'], 'model');
  dl.chatDailyLifeStore.put('u-two', 'cc_abc', TODAY, ['那个角色的事'], 'model');
  assert.deepEqual(dl.chatDailyLifeStore.peek('u-two', 'xiaoyu', TODAY).map((i: any) => i.text), ['小愈的事']);
  assert.deepEqual(dl.chatDailyLifeStore.peek('u-two', 'cc_abc', TODAY).map((i: any) => i.text), ['那个角色的事']);
});

test('缓存：source 如实区分 model / fallback（运营端才看得出谁一直在吃兜底）', () => {
  dl.chatDailyLifeStore.put('u-src', 'xiaoyu', TODAY, dl.fallbackItems(TODAY, 'zh'), 'fallback');
  assert.equal(dl.chatDailyLifeStore.raw('u-src', 'xiaoyu')?.source, 'fallback');
});

/* ───────── ④ 注入块：三语、空不注入、写死「不要每轮都提」 ───────── */

test('注入块：有条目才生成；三语齐全；简繁转换生效', () => {
  const items = [{ text: '窗台那盆东西今天又冒了一点新芽', at: Date.now() }];
  assert.strictEqual(dl.buildDailyLifeBlock([], 'zh'), '', '没有条目时必须返回空串（不注入空噪声）');
  const zh: string = dl.buildDailyLifeBlock(items, 'zh');
  assert.ok(zh.includes('你今天自己这边的小事'), 'zh 缺标题：' + zh.slice(0, 40));
  assert.ok(zh.includes('窗台那盆东西今天又冒了一点新芽'), 'zh 缺条目');
  const tw: string = dl.buildDailyLifeBlock(items, 'zh-TW');
  assert.ok(tw.includes('你今天自己這邊的小事'), 'zh-TW 未转繁体：' + tw.slice(0, 40));
  const en: string = dl.buildDailyLifeBlock(items, 'en');
  assert.ok(en.includes('small things from your own day'), 'en 缺标题：' + en.slice(0, 40));
});

test('注入块：写死了「不要硬 cue」的两条（本仓库反复吃过硬 cue 的亏）', () => {
  const items = [{ text: '楼下那家早餐摊没开', at: Date.now() }];
  const zh: string = dl.buildDailyLifeBlock(items, 'zh');
  assert.ok(zh.includes('不要每轮都提'), '缺「不要每轮都提」');
  assert.ok(zh.includes('不配抢戏'), '缺「用户难过时不许抢戏」这条分寸');
  assert.ok(zh.includes('可以'), '缺「可以自然带一句」这条许可（只写禁令＝不注入）');
});

/* ───────── ⑤ 进得了 system + 开关 ───────── */

test('system：有当天条目时才注入，跨天/无条目时不出现', async () => {
  const uid = 'u-sys';
  // 注入语言跟**界面偏好**走（默认偏好是 zh-TW，会把整块转成繁体）——这里显式定成 zh-CN，断言才好写
  const { preferenceStore } = await import('../../api/services/preferences.js');
  preferenceStore.set(uid, { language: 'zh-CN' });

  const noItems = (await gem.buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid, timezone: 'Asia/Hong_Kong' }, true)).system;
  assert.ok(!noItems.includes('你今天自己这边的小事'), '没有条目却注入了块');

  dl.chatDailyLifeStore.put(uid, 'xiaoyu', TODAY, ['泡茶的时候走神，水溢了一桌子'], 'model');
  const withItems = (await gem.buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid, timezone: 'Asia/Hong_Kong' }, true)).system;
  assert.ok(withItems.includes('你今天自己这边的小事'), '有当天条目却没注入');
  assert.ok(withItems.includes('泡茶的时候走神，水溢了一桌子'), '条目没进 system');
});

test('注入语言跟**本轮输出语言**走，不跟界面语言（线上实测过：界面英文 + 中文对话 → 英文小事塞进中文对话）', async () => {
  const uid = 'u-lang';
  const { preferenceStore } = await import('../../api/services/preferences.js');
  preferenceStore.set(uid, { language: 'en' }); // 界面英文
  dl.chatDailyLifeStore.put(uid, 'xiaoyu', TODAY, ['泡茶的时候走神，水溢了一桌子'], 'model');

  const zhChat = (await gem.buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid, timezone: 'Asia/Hong_Kong' }, true)).system;
  assert.ok(zhChat.includes('你今天自己这边的小事'), '界面英文 + 中文对话 → 应注入中文块');
  assert.ok(!zhChat.includes('small things from your own day'), '界面英文 + 中文对话却注入了英文块（这就是线上那次错配）');

  const enChat = (await gem.buildChatPromptParts([{ role: 'user', content: 'hey, are you there' }], { userId: uid, timezone: 'Asia/Hong_Kong' }, true)).system;
  assert.ok(enChat.includes('small things from your own day'), '英文对话 → 应注入英文块');
});

test('开关：CHAT_DAILY_LIFE=0 时注入块为空、且 ensure 连模型调用都不发', async () => {
  const before = process.env.CHAT_DAILY_LIFE;
  try {
    process.env.CHAT_DAILY_LIFE = '0';
    assert.equal(dl.dailyLifeEnabled(), false);
    const items = await dl.ensureDailyLife('u-off', 'xiaoyu', '小愈', { dateKey: TODAY });
    assert.deepEqual(items, [], '关掉开关仍然生成了内容');
    assert.equal(dl.chatDailyLifeStore.raw('u-off', 'xiaoyu'), undefined, '关掉开关仍然写了缓存');
  } finally {
    if (before === undefined) delete process.env.CHAT_DAILY_LIFE; else process.env.CHAT_DAILY_LIFE = before;
  }
});
