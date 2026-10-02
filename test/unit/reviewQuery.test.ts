/**
 * 审阅档案**查询层**单测（分页 / 日期范围 / 筛选 / 搜索）。
 *
 * 这一层从浏览器搬到服务端的理由：列表只给当前页之后，前端过滤与前端计数必然算错
 * （「未读 3」会变成「本页有 3 条未读」）。所以这里重点断言**计数口径是整个筛选范围**、
 * **搜索能搜到不在当前页的样本**。
 * 全部用编造的假数据，不读 data/（AGENTS.md 红线 3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewQueue, type ReviewItem } from '../../api/services/reviewQueue';
import { queryArchive, localDayOf, dayStartMs, dayEndMs, normalizeQuery } from '../../api/services/reviewQuery';
import type { ReviewReadState } from '../../api/services/reviewReads';

const USER = 'u_abc12345';
let seq = 0;
const ids = () => `rv_${++seq}`;

/** 用**本地时间**造样本：日期筛选按本地日算，用 UTC 写会让测试跟着机器时区飘 */
const localAt = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

function chat(day: number, over: Record<string, unknown> = {}) {
  return {
    sessionId: `sess_${day}`,
    userId: USER,
    chatTitle: `标题${day}`,
    chatMessages: [
      { role: 'user', content: `第${day}段对话的开场白，想聊聊最近的事`, timestamp: localAt(2026, 3, day, 10, 0) },
      // assistant 的回复都写得够长（>20 字）：否则会被「超短回复」线索命中，干扰 flagged 的断言
      { role: 'assistant', content: `我在呀，第${day}段的事你可以慢慢讲，我一直都在这里听着`, timestamp: localAt(2026, 3, day, 10, 0) },
      { role: 'user', content: `第${day}段对话的第二个问题，具体说一下`, timestamp: localAt(2026, 3, day, 10, 5) },
      { role: 'assistant', content: `嗯，第${day}段我明白了，你想从哪一件事开始说都可以`, timestamp: localAt(2026, 3, day, 10, 5) },
    ],
    ...over,
  };
}

function roleplay(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    scenarioId: 'secret_scenario',
    scenarioTitle: '雨夜书店',
    updatedAt: localAt(2026, 3, 12, 21, 0),
    messages: [
      { role: 'user', content: '我们进店里避雨吧，外面雨很大', timestamp: localAt(2026, 3, 12, 20, 0) },
      // 半截回复（收尾没写完）→ signals 里应有「半截」
      { role: 'assistant', content: '他推开门，铃铛响了一声，然后', timestamp: localAt(2026, 3, 12, 20, 0), viaUnlimited: false, incomplete: true },
      { role: 'user', content: '他好像有话要说，你继续写下去', timestamp: localAt(2026, 3, 12, 20, 3) },
      { role: 'assistant', content: '他停住了，没有动。', timestamp: localAt(2026, 3, 12, 20, 3), viaUnlimited: false },
    ],
    ...over,
  };
}

function buildAll() {
  return buildReviewQueue({
    chatSessions: [chat(10), chat(11), chat(12), chat(13)],
    roleplayRecords: [roleplay()],
    idFactory: ids,
    getUserSettings: () => ({ region: 'yuegang', thinkingLevel: 'max', mode: 'hug' }),
  }).items;
}

const read = (over: Partial<ReviewReadState> = {}): ReviewReadState => ({ opens: 1, ...over });

test('分页：page / pageSize / pageCount 正确，越界页码被夹回最后一页', () => {
  const items = buildAll();
  const r = queryArchive(items, { page: 1, pageSize: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.filtered, 5);
  assert.equal(r.pageCount, 3);
  assert.equal(r.items.length, 2);
  // 默认最新在前
  assert.equal(r.items[0].lastAt >= r.items[1].lastAt, true);

  const last = queryArchive(items, { page: 99, pageSize: 2 });
  assert.equal(last.page, 3, '越界要夹回最后一页，而不是给一个空页面');
  assert.equal(last.items.length, 1);

  const old = queryArchive(items, { page: 1, pageSize: 2, order: 'old' });
  assert.equal(old.items[0].lastAt <= old.items[1].lastAt, true, 'order=old 时最早的在前');
});

test('★ 列表只给摘要：不带正文，但要带 messageCount / preview / signals', () => {
  const items = buildAll();
  const r = queryArchive(items, { pageSize: 10 });
  for (const it of r.items) {
    assert.equal('messages' in it, false, '摘要不该带正文（一页几百条会把手机流量吃光）');
    assert.equal(typeof it.messageCount, 'number');
    assert.equal(typeof it.preview, 'string');
    assert.ok(Array.isArray(it.signals));
    assert.equal(typeof it.sampleKey, 'string');
  }
  const rp = r.items.find((it) => it.kind === 'roleplay')!;
  assert.ok(rp.signals.some((s) => s.k === 'half'), '半截回复要在线索里');
  assert.equal(rp.preview.startsWith('我们进店里避雨吧'), true);
});

test('★ 计数口径是「整个筛选范围」，不是本页（前端过滤那套就是栽在这里）', () => {
  const items = buildAll();
  const reads = {
    [items[0].sampleKey]: read({ readAt: 1000 }),
    [items[1].sampleKey]: read({ readAt: 2000, starred: true }),
  };
  // 每页 1 条，但计数必须是全档的
  const r = queryArchive(items, { page: 1, pageSize: 1 }, reads);
  assert.equal(r.items.length, 1);
  assert.equal(r.counts.total, 5);
  assert.equal(r.counts.read, 2);
  assert.equal(r.counts.unread, 3);
  assert.equal(r.counts.starred, 1);
  assert.equal(r.counts.flagged, 1, '有线索的条数（这里是那条半截回复）');

  // read 筛选：命中数与页码跟着变
  const unread = queryArchive(items, { read: 'unread', pageSize: 10 }, reads);
  assert.equal(unread.filtered, 3);
  assert.equal(unread.counts.unread, 3, '筛选本身不改计数口径');
  const star = queryArchive(items, { read: 'star', pageSize: 10 }, reads);
  assert.equal(star.filtered, 1);
  const flagged = queryArchive(items, { read: 'flagged', pageSize: 10 }, reads);
  assert.equal(flagged.filtered, 1);
  assert.equal(flagged.items[0].kind, 'roleplay');
});

test('日期范围按**本地日**闭区间过滤；类型筛选同时生效', () => {
  const items = buildAll();
  const from = '2026-03-11', to = '2026-03-12';
  const r = queryArchive(items, { from, to, pageSize: 10 });
  assert.equal(r.scoped, 3, '11 / 12 两天的聊一聊 + 12 号的剧情');
  assert.equal(r.items.every((it) => localDayOf(it.lastAt) >= from && localDayOf(it.lastAt) <= to), true);

  // 边界就是当天 00:00 ~ 23:59:59.999：只看 12 号那一整天
  const oneDay = queryArchive(items, { from: '2026-03-12', to: '2026-03-12', pageSize: 10 });
  assert.equal(oneDay.scoped, 2);
  assert.equal(dayStartMs('2026-03-12')! < dayEndMs('2026-03-12')!, true);

  const kind = queryArchive(items, { kind: 'chat', pageSize: 10 });
  assert.equal(kind.scoped, 4);
  assert.equal(kind.items.every((it) => it.kind === 'chat'), true);

  // 非法参数退回缺省，别让手改 URL 把接口打崩
  assert.deepEqual(normalizeQuery({ from: '不是日期', to: '2026-13-99', page: -5, pageSize: 9999 }), {
    kind: '', read: 'all', from: '', to: '', q: '', order: 'new', page: 1, pageSize: 100,
  });
});

test('★ 搜索在服务端搜**整个档案**（能搜到不在当前页的样本）+ 支持设置中文标签', () => {
  const items = buildAll();
  const page1 = queryArchive(items, { pageSize: 1 });
  assert.equal(page1.items.length, 1);

  // 第 10 段的话不在第一页，但必须搜得到
  const hit = queryArchive(items, { q: '第10段对话的第二个问题', pageSize: 10 });
  assert.equal(hit.filtered, 1, '搜索必须是全档的，不是只搜本页');
  assert.equal(localDayOf(hit.items[0].lastAt), '2026-03-10');

  // 设置项按**可读标签**也能搜到（region=yuegang → 「粤港」）
  const label = queryArchive(items, { q: '粤港', pageSize: 10 });
  assert.equal(label.filtered, 5);

  // 搜「半截」只命中真有半截回复的那条（2026-09-20 踩过的坑：固定词串会让每次搜索都命中全部）
  const half = queryArchive(items, { q: '半截', pageSize: 10 });
  assert.equal(half.filtered, 1);

  // ⚠️ 搜「无限制」不该把保守模型的样本捞回来（关着的条目不带这个关键词）
  const unlimited = queryArchive(items, { q: '无限制', pageSize: 10 });
  assert.equal(unlimited.filtered, 0, '没有一条走了无限制模式，就不该被搜出来');

  // 剧本科目也要能搜到
  assert.equal(queryArchive(items, { q: '雨夜书店', pageSize: 10 }).filtered, 1);
  assert.equal(queryArchive(items, { q: '不存在的词xyz', pageSize: 10 }).filtered, 0);
});

test('空档案 / 空参数不抛异常', () => {
  const r = queryArchive([], {});
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
  assert.equal(r.page, 1);
  assert.equal(r.pageCount, 1);
  assert.deepEqual(queryArchive([] as ReviewItem[], { q: 'x', read: 'star' }).counts, {
    total: 0, unread: 0, read: 0, starred: 0, flagged: 0, noted: 0,
  });
});
