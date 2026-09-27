/**
 * journey 聚合器单元测试（«与你的旅程»，纯代码数据可视化）
 * buildJourney 为纯函数，直接注入数据断言：
 *  - summary 汇总正确
 *  - characters 派生字段（daysKnown / streak / facts / relationMemories）正确
 *  - moments 按时间倒序且类型正确
 *  - 空数据不崩溃
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildJourney } from '../../api/services/journey.js';

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('空数据：summary/characters/moments 归零且不崩溃', () => {
  const r = buildJourney({ characters: [], diaries: [], likes: [], stories: [], moodStreak: 0 });
  assert.deepStrictEqual(r.summary, { daysKnown: 0, checkins: 0, characters: 0, memories: 0, portraits: 0, likes: 0, moodStreak: 0 });
  assert.deepStrictEqual(r.characters, []);
  assert.deepStrictEqual(r.moments, []);
  assert.deepStrictEqual(r.stories, []);
});

test('聚合：summary/characters/moments 正确', () => {
  const now = Date.now();
  const today = new Date();
  const yesterday = new Date(now - DAY_MS);
  const base = now - 10 * DAY_MS; // 小愈初次相遇：10 天前

  const r = buildJourney({
    characters: [
      {
        id: 'xiaoyu', name: '小愈', isDefault: true,
        firstChatAt: base,
        chatDays: [dayKey(today), dayKey(yesterday)],
        milestones: { '30': true, '100': false },
        relationship: [{ text: '你和我聊起过那只叫团子的猫', at: now - 3 * DAY_MS }],
        selfPortrait: { text: '在 TA 眼里，你是一个很温柔的人', at: now - 2 * DAY_MS },
        portraitHistory: [],
        facts: ['用户叫小林', '用户养了一只叫团子的猫'],
      },
      {
        id: 'cc_x', name: '阿暖', isDefault: false,
        avatar: '/skins/candy/companion.webp?v=2',
        firstChatAt: now - 2 * DAY_MS,
        chatDays: [],
        relationship: [],
        selfPortrait: undefined,
        portraitHistory: [],
        facts: [],
      },
    ],
    diaries: [{ date: dayKey(today), mood: 'happy', note: '今天状态不错', createdAt: now - DAY_MS }],
    likes: [{ at: now - 12 * 60 * 60 * 1000, title: '雨夜捡到的他会暖床' }],
    stories: [
      { scenarioId: 's1', title: '替姐出嫁那夜', at: now - 5 * DAY_MS, kind: 'roleplay' },
      { scenarioId: 'xian', title: '缥缈仙途', at: now - DAY_MS, kind: 'wenyou' },
    ],
    moodStreak: 2,
  });

  // summary
  assert.strictEqual(r.summary.checkins, 1);
  assert.strictEqual(r.summary.characters, 2);
  assert.strictEqual(r.summary.memories, 1);
  assert.strictEqual(r.summary.portraits, 1);
  assert.strictEqual(r.summary.likes, 1);
  assert.strictEqual(r.summary.moodStreak, 2);
  // daysKnown = 最早的「初次相遇」到今天（10 天前 → 认识 11 天）
  assert.strictEqual(r.summary.daysKnown, 11);

  // characters
  const xiaoyu = r.characters.find((c) => c.id === 'xiaoyu')!;
  assert.strictEqual(xiaoyu.daysKnown, 11);
  assert.strictEqual(xiaoyu.streak, 2);
  assert.deepStrictEqual(xiaoyu.facts, ['用户叫小林', '用户养了一只叫团子的猫']);
  assert.deepStrictEqual(xiaoyu.milestones, [30]); // 已达成里程碑：30 轮（100 未达成）
  assert.strictEqual(xiaoyu.relationMemories.length, 1);

  const warm = r.characters.find((c) => c.id === 'cc_x')!;
  assert.strictEqual(warm.daysKnown, 3); // 2 天前 → 认识 3 天
  assert.strictEqual(warm.streak, 0);
  assert.strictEqual(warm.facts.length, 0);
  assert.strictEqual(warm.avatar, '/skins/candy/companion.webp?v=2'); // 聊一聊头像透传
  assert.strictEqual(xiaoyu.avatar, undefined); // 内置小愈无头像（前端按皮肤解析）

  // stories：你去过的剧情（用户级，含文游），时间倒序
  assert.deepStrictEqual(r.stories.map((s) => s.title), ['缥缈仙途', '替姐出嫁那夜']);
  assert.strictEqual(r.stories[0].scenarioId, 'xian');
  assert.strictEqual(r.stories[0].kind, 'wenyou');
  assert.strictEqual(r.stories[1].kind, 'roleplay');

  // moments：时间倒序且各类型齐全（xiaoyu 的 first/memory/portrait + cc_x 的 first + mood + like = 6）
  assert.strictEqual(r.moments.length, 6);
  assert.strictEqual(r.moments[0].type, 'like'); // like（12h 前）最新 → 排最前
  assert.strictEqual(r.moments.filter((m) => m.type === 'first').length, 2);
  assert.strictEqual(r.moments.filter((m) => m.type === 'memory').length, 1);
  assert.strictEqual(r.moments.filter((m) => m.type === 'portrait').length, 1);
  assert.strictEqual(r.moments.filter((m) => m.type === 'mood').length, 1);
  assert.strictEqual(r.moments.filter((m) => m.type === 'like').length, 1);
  const first = r.moments.find((m) => m.type === 'first' && m.characterId === 'xiaoyu')!;
  assert.strictEqual(first.characterName, '小愈');
  const mood = r.moments.find((m) => m.type === 'mood')!;
  assert.strictEqual(mood.mood, 'happy');
  assert.strictEqual(mood.note, '今天状态不错');
  const like = r.moments.find((m) => m.type === 'like')!;
  assert.strictEqual(like.text, '雨夜捡到的他会暖床');
});

test('自建剧情：stories / like 瞬间带 custom 标志（前端据此渲染「自建」，不显示「自定义剧情」）', () => {
  const now = Date.now();
  const r = buildJourney({
    characters: [],
    diaries: [],
    likes: [
      { at: now - 2 * 60 * 60 * 1000, title: '虚空一脈', custom: true },
      { at: now - 3 * 60 * 60 * 1000, title: '', custom: true, deleted: true },
    ],
    stories: [
      { scenarioId: 'custom_mta04dcft8re28', title: '虚空一脈', at: now, kind: 'roleplay', custom: true },
      { scenarioId: 'custom-mine', title: '我的江湖', at: now - DAY_MS, kind: 'wenyou', custom: true },
      { scenarioId: 's1', title: '替姐出嫁那夜', at: now - 2 * DAY_MS, kind: 'roleplay' },
      // 剧本已被创作者删除：真名都拿不到 → 标题空串 + deleted 标志（前端显示「自建剧情 · 已删」）
      { scenarioId: 'custom_mt3o842ia2bcg2', title: '', at: now - 3 * DAY_MS, kind: 'roleplay', custom: true, deleted: true },
    ],
    moodStreak: 0,
  });
  assert.strictEqual(r.stories[0].custom, true);
  assert.strictEqual(r.stories[0].title, '虚空一脈');
  assert.strictEqual(r.stories[0].deleted, undefined, '还在的剧本不带「已删」');
  assert.strictEqual(r.stories[1].custom, true, '千世书自建书同样带标志');
  assert.strictEqual(r.stories[2].custom, undefined, '官方剧本不带自建标志');
  const gone = r.stories.find((s) => s.scenarioId === 'custom_mt3o842ia2bcg2')!;
  assert.strictEqual(gone.title, '');
  assert.strictEqual(gone.custom, true);
  assert.strictEqual(gone.deleted, true, '被删的剧本要能看出是已删的');
  const like = r.moments.find((m) => m.type === 'like' && m.text === '虚空一脈')!;
  assert.strictEqual(like.custom, true);
  assert.strictEqual(like.text, '虚空一脈');
  const likeGone = r.moments.find((m) => m.type === 'like' && m.deleted)!;
  assert.strictEqual(likeGone.custom, true, '点赞过的剧本被删 → 也要带 deleted');
});

test('无任何聊天/打卡时 daysKnown 为 0，且不产生 first 时刻', () => {
  const r = buildJourney({
    characters: [
      { id: 'xiaoyu', name: '小愈', isDefault: true, firstChatAt: undefined, chatDays: [], relationship: [], selfPortrait: undefined, portraitHistory: [], facts: [] },
    ],
    diaries: [],
    likes: [],
    stories: [],
    moodStreak: 0,
  });
  assert.strictEqual(r.summary.daysKnown, 0);
  assert.strictEqual(r.moments.length, 0);
  assert.strictEqual(r.characters[0].daysKnown, 0);
});
