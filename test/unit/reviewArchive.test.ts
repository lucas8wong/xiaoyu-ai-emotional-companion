/**
 * 审阅**档案**层单测（增量累积）。
 *
 * 这层是这次修复的核心：原来「一次生成整体覆盖 + limit 最近优先截断」会让**有资格的记录消失**
 * （2026-09-25 实测：386 条候选筛出 105 条有资格，只进 50 条，另外 55 条从视图里没了）。
 * 全部用编造的假数据，不读 data/（AGENTS.md 红线 3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewQueue, itemLegacyKey, SAMPLE_KEY_VERSION } from '../../api/services/reviewQueue';
import {
  mergeArchive,
  parseArchive,
  serializeArchive,
  archiveRange,
  ARCHIVE_VERSION,
} from '../../api/services/reviewArchive';

const USER = 'u_abc12345';
const OTHER = 'u_other111';
const at = (s: string) => new Date(s);

let seq = 0;
const ids = () => `rv_${++seq}`;

/** 一段「够长」的聊一聊会话：用户发言都 >8 字（重叠兜底的锚就是按这个筛的） */
function chat(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess_1',
    userId: USER,
    chatTitle: '最近有点累',
    chatMessages: [
      { role: 'user', content: '我今天真的有点累了想找个人说说话', timestamp: at('2026-01-10T08:00:00Z') },
      { role: 'assistant', content: '我在，慢慢说', timestamp: at('2026-01-10T08:00:05Z') },
      { role: 'user', content: '工作上被否定了几次有点撑不住', timestamp: at('2026-01-10T08:01:00Z') },
      { role: 'assistant', content: '嗯，那种感觉很难受', timestamp: at('2026-01-10T08:01:04Z') },
      { role: 'user', content: '晚上一个人待着更容易想多', timestamp: at('2026-01-10T08:02:00Z') },
      { role: 'assistant', content: '那我陪你待一会儿', timestamp: at('2026-01-10T08:02:05Z') },
      { role: 'user', content: '睡前总会想起白天那些话', timestamp: at('2026-01-10T08:03:00Z') },
      { role: 'assistant', content: '那种反复回放很消耗人', timestamp: at('2026-01-10T08:03:05Z') },
      { role: 'user', content: '嗯，明天还要早起去上班', timestamp: at('2026-01-10T08:04:00Z') },
      { role: 'assistant', content: '那今晚先让自己松一点', timestamp: at('2026-01-10T08:04:05Z') },
    ],
    ...over,
  };
}

function build(sessions: unknown[], limit?: number) {
  return buildReviewQueue({
    chatSessions: sessions as never,
    ...(limit ? { limit } : {}),
    idFactory: ids,
  }).items;
}

test('★ 增量并档：档案只增不减（「后一次生成把记录挤掉」这件事不会再发生）', () => {
  const items = build([chat(), chat({ sessionId: 'sess_2', userId: OTHER, chatMessages: chat().chatMessages.map((m, i) => ({ ...m, content: m.role === 'user' ? `${m.content}（第二段）` : m.content, timestamp: at(`2026-01-11T08:0${i}:00Z`) })) })]);
  assert.equal(items.length, 2);

  const first = mergeArchive([], items, { now: 1000 });
  assert.equal(first.added, 2);
  assert.equal(first.refreshed, 0);
  assert.equal(first.items.length, 2);
  assert.ok(first.items.every((it) => it.archivedAt === 1000 && it.refreshedAt === 1000));
  assert.ok(first.items.every((it) => it.keyVersion === SAMPLE_KEY_VERSION));

  // 再生成一次，只带得回其中一条（另一条这轮不在候选里：用户关了开关 / 源头过了保留期）
  const again = mergeArchive(first.items, [items[0]], { now: 2000 });
  assert.equal(again.added, 0);
  assert.equal(again.refreshed, 1);
  assert.equal(again.items.length, 2, '没进本次候选的那条必须还在，这就是「不再漏记录」');
  // 老条目的「首次入档」时间不能被刷新冲掉；被刷新的那条要如实更新 refreshedAt
  const untouched = again.items.find((it) => it.sampleKey !== items[0].sampleKey)!;
  assert.equal(untouched.archivedAt, 1000);
  assert.equal(untouched.refreshedAt, 1000);
  assert.equal(again.items.find((it) => it.sampleKey === items[0].sampleKey)!.refreshedAt, 2000);
});

test('★ 同一段对话续写：刷新正文而不是新增一条，且「首次入档」时间不变', () => {
  const v1 = build([chat()]);
  const first = mergeArchive([], v1, { now: 1000 });

  const grown = build([chat({
    chatMessages: [
      ...chat().chatMessages,
      { role: 'user', content: '刚下楼走了一圈好一点了', timestamp: at('2026-01-10T08:10:00Z') },
      { role: 'assistant', content: '那就好', timestamp: at('2026-01-10T08:10:04Z') },
    ],
  })]);
  const second = mergeArchive(first.items, grown, { now: 5000 });
  assert.equal(second.added, 0);
  assert.equal(second.refreshed, 1);
  assert.equal(second.items.length, 1, '续写不该多出一条（老口径下这里会变成两条）');
  assert.equal(second.items[0].archivedAt, 1000, 'archivedAt = 第一次看到的时刻');
  assert.equal(second.items[0].refreshedAt, 5000);
  assert.equal(second.items[0].messages.length, 12, '正文要换成更全的那版');
  assert.deepEqual(second.keyMap, {}, '键没变，不需要迁移已读标记');
});

test('★ 头部被裁掉（剧情只留最近 200 条）时按「用户发言重叠」认出同一条，不重复入档', () => {
  const full = build([chat()]);
  const first = mergeArchive([], full, { now: 1000 });
  const oldKey = first.items[0].sampleKey;

  // 模拟「头两条被裁掉」：首条用户发言变了 → 身份键必然变，但其实是同一段对话
  const trimmed = build([chat({ chatMessages: chat().chatMessages.slice(2) })]);
  assert.notEqual(trimmed[0].sampleKey, oldKey, '前提：裁头之后身份键确实变了');

  const second = mergeArchive(first.items, trimmed, { now: 2000 });
  assert.equal(second.items.length, 1, '同一段对话不能因为裁头就多出一条');
  assert.equal(second.added, 0);
  assert.equal(second.refreshed, 1);
  assert.equal(second.items[0].sampleKey, trimmed[0].sampleKey, '键要落到新的那个上（下次生成才对得上）');
  assert.equal(second.items[0].messages.length, 10, '新版本反而更短 → 保留更全的旧正文');
  assert.equal(second.items[0].archivedAt, 1000);
  assert.equal(second.items[0].refreshedAt, 2000);
  // 旧键 → 新键的映射必须交出来：调用方据此把已读标记搬过去
  assert.deepEqual(second.keyMap, { [oldKey]: trimmed[0].sampleKey });
});

test('重叠兜底不会把「只是都说过你好」的两段不同对话并掉', () => {
  const a = build([chat()]);
  const first = mergeArchive([], a, { now: 1000 });
  // 另一段对话：用户发言与 a 只共享 1 条（<3 条），且开头完全不同
  const b = build([chat({
    sessionId: 'sess_9',
    userId: OTHER,
    chatMessages: [
      { role: 'user', content: '我今天真的有点累了想找个人说说话', timestamp: at('2026-02-01T09:00:00Z') },
      { role: 'assistant', content: '在的', timestamp: at('2026-02-01T09:00:02Z') },
      { role: 'user', content: '不过我其实是来问别的事情的', timestamp: at('2026-02-01T09:01:00Z') },
      { role: 'assistant', content: '你说', timestamp: at('2026-02-01T09:01:02Z') },
    ],
  })]);
  const second = mergeArchive(first.items, b, { now: 2000 });
  assert.equal(second.items.length, 2, '共享不足 3 条就不该并');
  assert.equal(second.added, 1);
  assert.deepEqual(second.keyMap, {});
});

test('★ 老条目（v1 含尾条指纹）读取时按 v1 口径反推旧键 → keyMap 供已读标记迁移', () => {
  const items = build([chat()]);
  // 伪造一条 2026-09-25 之前生成的档案条目：键是 v1 口径、没有 keyVersion、也没有 signals/preview
  const legacy = { ...items[0] } as Record<string, unknown>;
  legacy.sampleKey = itemLegacyKey(items[0]);
  delete legacy.keyVersion;
  delete legacy.signals;
  delete legacy.preview;

  const raw = [JSON.stringify({ generatedAt: '2026-09-20T03:39:30.688Z', itemCount: 1 }), JSON.stringify(legacy)].join('\n') + '\n';
  const parsed = parseArchive(raw);
  assert.equal(parsed.legacy, true, '应识别出「含老口径条目」');
  assert.equal(parsed.items.length, 1);
  // 老条目没有 signals/preview：当场从已存正文重算（否则列表上既没线索也没预览）
  assert.deepEqual(parsed.items[0].signals, items[0].signals);
  assert.equal(parsed.items[0].preview, items[0].preview);

  const merged = mergeArchive(parsed.items, build([chat()]), { now: 3000 });
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].sampleKey, items[0].sampleKey, 'v2 键应与本次新建的一致');
  assert.deepEqual(merged.keyMap, { [legacy.sampleKey as string]: items[0].sampleKey });
});

test('档案上限：超了按最旧的丢，并如实报出丢弃数（不静默丢）', () => {
  const a = build([chat()]);                                    // 2026-01-10
  // 另一段**内容不同**的对话（只改时间的话会被重叠兜底当成同一条，那正是上面那条测试要保证的行为）
  const b = build([chat({
    sessionId: 'sess_2',
    userId: OTHER,
    chatMessages: chat().chatMessages.map((m) => ({
      ...m,
      content: m.role === 'user' ? `${m.content}，这是另一个人的另一段` : `${m.content}（另一段）`,
      timestamp: at('2026-03-01T08:00:00Z'),
    })),
  })]);
  const merged = mergeArchive([], [...a, ...b], { now: 1000, cap: 1 });
  assert.equal(merged.added, 2, '两条不同的对话都要先入档');
  assert.equal(merged.dropped, 1, '超上限必须如实报出丢弃数（不静默丢）');
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].lastAt > a[0].lastAt, true, '留下的是更新的那条');
});

test('序列化 / 解析往返：meta 与条目都读得回来，坏行跳过', () => {
  const items = build([chat()]);
  const meta = {
    version: ARCHIVE_VERSION,
    generatedAt: '2026-09-25T00:00:00.000Z',
    itemCount: 1,
    archivedTotal: 1,
    added: 1,
    refreshed: 0,
    dropped: 0,
    range: archiveRange(items),
    stats: { chatScanned: 1 },
    note: 'n',
  };
  const text = serializeArchive(meta, items);
  const back = parseArchive(`${text}{坏行不是 JSON\n`);
  assert.equal((back.meta as { generatedAt?: string })?.generatedAt, meta.generatedAt);
  assert.equal(back.items.length, 1);
  assert.equal(back.items[0].sampleKey, items[0].sampleKey);
  assert.equal(back.legacy, false);

  // 空文件 / 只有 meta：不抛、items 为空
  assert.deepEqual(parseArchive('').items, []);
  assert.deepEqual(parseArchive('{"generatedAt":"x"}').items, []);
  // 结构不对的行（缺 messages / kind 非法）当成脏行丢掉，不能让整个档案读不出来
  assert.equal(parseArchive('{"kind":"nope","messages":[],"startedAt":1,"lastAt":1}').items.length, 0);
});

test('archiveRange：按 lastAt 给出覆盖区间；空档案给 0', () => {
  const items = build([chat()]);
  const r = archiveRange(items);
  assert.equal(r.from, items[0].lastAt);
  assert.equal(r.to, items[0].lastAt);
  assert.deepEqual(archiveRange([]), { from: 0, to: 0 });
});
