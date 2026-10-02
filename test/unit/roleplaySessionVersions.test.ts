/**
 * 剧情会话「AI 回复多版本」落盘/读回的单测（配合 `src/lib/rpVersions.ts` 的纯逻辑单测）。
 *
 * 为什么单独测这一层：版本候选只在**内存**里对是不够的，剧情会话会自动保存到后端
 * （`data/roleplay-sessions.json`，登录用户跨设备续写），如果服务端只存 `role/story/content`，
 * 用户重抽出来的旧版会在换设备/刷新后凭空消失，而界面上「◀ 1/2 ▶」还在（点不动）
 * 比一开始就没有版本更糟。所以这里把「落盘保留版本」「脏数据自洽化」「版本数上限」都钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { roleplaySessionStore } = await import('../../api/services/roleplaySessions.js');

const u = 'vers_user';
const sc = 'vers_scenario';

test('重生成产生的多版本会随会话落盘，读回后仍可切换', () => {
  roleplaySessionStore.save(u, sc, [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '第二版', versions: ['第一版', '第二版'], vi: 1 },
  ]);
  const msgs = roleplaySessionStore.get(u, sc)!;
  const last = msgs[msgs.length - 1];
  assert.deepEqual(last.versions, ['第一版', '第二版'], '两个版本都要在库里');
  assert.strictEqual(last.vi, 1);
  assert.strictEqual(last.content, '第二版', 'content 必须等于 versions[vi]');
  // 开场白（没有重生成过）不落版本字段，老数据格式保持原样
  assert.strictEqual(msgs[0].versions, undefined);
});

test('单版消息不落 versions/vi（避免给老数据加噪音字段）', () => {
  roleplaySessionStore.save(u, 'one', [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '嗨' },
    { role: 'assistant', content: '只有一版', versions: ['只有一版'], vi: 0 },
  ]);
  const last = roleplaySessionStore.get(u, 'one')!.slice(-1)[0];
  assert.strictEqual(last.versions, undefined);
  assert.strictEqual(last.vi, undefined);
});

test('脏数据自洽化：vi 越界 / content 不在 versions 里 → 以 content 为准，不许出现「显示的正文不在版本列表里」', () => {
  // vi 越界 → 回落到最后一版
  roleplaySessionStore.save(u, 'dirty1', [{ role: 'assistant', content: 'B', versions: ['A', 'B'], vi: 99 }]);
  const d1 = roleplaySessionStore.get(u, 'dirty1')![0];
  assert.strictEqual(d1.vi, 1);
  assert.strictEqual(d1.versions![d1.vi!], 'B');

  // content 不在 versions 里 → 把当前正文补成最新一版（内容优先，绝不丢用户正在看的那条）
  roleplaySessionStore.save(u, 'dirty2', [{ role: 'assistant', content: 'C', versions: ['A', 'B'], vi: 0 }]);
  const d2 = roleplaySessionStore.get(u, 'dirty2')![0];
  assert.strictEqual(d2.versions![d2.vi!], 'C');
  assert.deepEqual(d2.versions, ['A', 'B', 'C']);

  // versions 里混入非字符串 → 过滤掉，其余正常
  roleplaySessionStore.save(u, 'dirty3', [{ role: 'assistant', content: 'B', versions: ['A', 7 as any, 'B'], vi: 1 }]);
  const d3 = roleplaySessionStore.get(u, 'dirty3')![0];
  assert.deepEqual(d3.versions, ['A', 'B']);
  assert.strictEqual(d3.versions![d3.vi!], 'B');
});

test('版本数上限 5：丢弃最旧的、保留当前版（防止无限重抽把会话文件撑爆）', () => {
  const versions = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
  roleplaySessionStore.save(u, 'cap', [{ role: 'assistant', content: 'v6', versions, vi: 5 }]);
  const m = roleplaySessionStore.get(u, 'cap')![0];
  assert.strictEqual(m.versions!.length, 5);
  assert.deepEqual(m.versions, ['v2', 'v3', 'v4', 'v5', 'v6'], '丢最旧的一个');
  assert.strictEqual(m.versions![m.vi!], 'v6', '当前版永远还在，且下标被同步位移');

  // 当前版正好是最旧的那一版时：**不许被裁掉**（否则 content 与 versions[vi] 会对不上），
  // 裁剪规则 = 当前版 + 最近的 4 版，按时间顺序重排
  roleplaySessionStore.save(u, 'cap2', [{ role: 'assistant', content: 'v1', versions, vi: 0 }]);
  const m2 = roleplaySessionStore.get(u, 'cap2')![0];
  assert.deepEqual(m2.versions, ['v1', 'v3', 'v4', 'v5', 'v6']);
  assert.strictEqual(m2.versions![m2.vi!], 'v1', '正在显示的版本不许被裁掉');
  assert.strictEqual(m2.vi, 0);
});

test('每个版本各自截断到 4000 字符（与单条 content 的既有上限一致）', () => {
  const long = 'x'.repeat(5000);
  roleplaySessionStore.save(u, 'long', [{ role: 'assistant', content: 'short', versions: [long, 'short'], vi: 1 }]);
  const m = roleplaySessionStore.get(u, 'long')![0];
  assert.strictEqual(m.versions![0].length, 4000);
  assert.strictEqual(m.versions![1], 'short');
  assert.strictEqual(m.versions![m.vi!], 'short');
});

/**
 * ⚠️ 2026-09 口径变更（编辑重发 · 1B + 2A）：用户消息**开始**带版本字段了（以前这里断言"不应被保存"）。
 *
 * 为什么改：用户改写自己刚发的那句之后，旧正文 + 它的那条回复要被冻结保存成可切回的分支
 * （`src/lib/rpVersions.ts` 的 tails）。若服务端仍把它们丢掉，用户刷新/换设备后 ◀ n/m ▶ 还在却点不动，
 * 旧那支剧情**永久消失**，与「AI 回复多版本」当年要在服务端保留是同一个理由。
 */
test('用户消息的「编辑重发」分支会落盘/读回（versions + vi + tails）', () => {
  roleplaySessionStore.save(u, 'user-branch', [
    { role: 'assistant', content: '开场白' },
    {
      role: 'user',
      content: '我其实挺难过的',
      versions: ['我有点累', '我其实挺难过的'],
      vi: 1,
      // tails 按**版本下标**对齐：tails[0] = 旧那版（v0「我有点累」）的回复，被冻结保留；
      // tails[1] = 当前版 → null（它的后续就活在主线里，即下面那条「那就慢慢说。」）
      tails: [[{ role: 'assistant', content: '那就先歇一会儿。' }], null],
    },
    { role: 'assistant', content: '那就慢慢说。' },
  ]);
  const m = roleplaySessionStore.get(u, 'user-branch')![1];
  assert.strictEqual(m.role, 'user');
  assert.deepEqual(m.versions, ['我有点累', '我其实挺难过的'], '两个正文版本都要在库里');
  assert.strictEqual(m.content, '我其实挺难过的', 'content 必须等于 versions[vi]');
  assert.strictEqual(m.vi, 1);
  assert.strictEqual(m.tails!.length, 2, '尾巴按版本对齐');
  assert.strictEqual(m.tails![0]!.length, 1, '旧那支的回复被冻结保留（可切回）');
  assert.strictEqual(m.tails![0]![0].content, '那就先歇一会儿。');
  assert.strictEqual(m.tails![1], null, '缺省/空的尾巴 = 这一版的后续活在主线里');
});

test('用户分支的脏数据兜底：单版不落字段、尾巴只留 role/content、版本上限 3', () => {
  // 单版 = 老格式，不落字段（不给老数据加噪音）
  roleplaySessionStore.save(u, 'user-one', [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '我', versions: ['我'] as any, vi: 0 as any },
  ]);
  assert.strictEqual(roleplaySessionStore.get(u, 'user-one')![1].versions, undefined);

  // 尾巴里的脏元素（缺 role / content 不是字符串）被丢掉；超量只留前 N 条
  roleplaySessionStore.save(u, 'user-tail', [
    {
      role: 'user',
      content: 'b',
      versions: ['a', 'b'],
      vi: 1,
      tails: [
        [
          { role: 'assistant', content: '真回复' },
          { role: 'assistant' } as any,
          { role: 'assistant', content: '第三条' },
          { role: 'assistant', content: '第四条' },
        ],
        null,
      ],
    },
  ]);
  const t = roleplaySessionStore.get(u, 'user-tail')![0];
  assert.deepEqual(t.tails![0], [
    { role: 'assistant', content: '真回复' },
    { role: 'assistant', content: '第三条' },
  ], '只留结构合法的最多 2 条');

  // 版本上限 3：丢最旧的、当前版必须保留
  roleplaySessionStore.save(u, 'user-cap', [
    { role: 'user', content: 'v5', versions: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'], vi: 5 },
  ]);
  const c = roleplaySessionStore.get(u, 'user-cap')![0];
  assert.strictEqual(c.versions!.length, 3);
  assert.deepEqual(c.versions, ['v3', 'v4', 'v5'], '保留当前版 + 最近两版');
  assert.strictEqual(c.versions![c.vi!], 'v5');
});
