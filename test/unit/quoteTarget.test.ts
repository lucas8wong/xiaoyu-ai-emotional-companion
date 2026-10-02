/**
 * 「点引用块 → 跳回原消息」的定位逻辑（src/lib/quoteTarget.ts）。
 *
 * 为什么不能按 id 找：本地消息 id 是 `m-<ts>-<rand>`，刷新后从服务端读回会变成 `h-<i>-<ts>`
 *。同一条消息 id 会变。跨刷新稳定的只有 role / 时间戳 / 内容，所以这里把三级匹配逐条钉住：
 *   ① 内容完全一致（助手长回复被拆段后，引用的是其中一段）→ 精确落到那一段；
 *   ② 时间戳 + 角色（纯图片/纯语音引用没有文字，只能靠这个）+ 内容前缀消歧；
 *   ③ 老会话没存 at → 只用前 12 字前缀兜底；
 *   ④ 都匹配不到 → undefined（调用方静默不动，绝不乱跳）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuotedMessage } from '../../src/lib/quoteTarget';
import type { ChatMessage } from '../../src/services/api';

const msg = (id: string, role: 'user' | 'assistant', content: string, timestamp: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, timestamp, ...extra });

const T1 = '2026-09-17T10:00:00.000Z';
const T2 = '2026-09-17T10:00:05.000Z';

test('内容完全一致优先：助手长回复被拆成两段时，精确跳到被引用的那一段', () => {
  const list = [
    msg('m1', 'assistant', '第一段。', T2),
    msg('m2', 'assistant', '第二段。', T2), // 拆段后时间戳相同
    msg('m3', 'user', '嗯', T2),
  ];
  const hit = findQuotedMessage(list, { role: 'assistant', content: '第二段。', at: T2 });
  assert.equal(hit?.id, 'm2');
});

test('纯图片/纯语音引用（被引用内容为空）靠「时间戳 + 角色」定位', () => {
  const list = [
    msg('m1', 'assistant', '先说点别的', T1),
    msg('m2', 'assistant', '', T2, { image: 'data:image/png;base64,x' }),
    msg('m3', 'user', '这张图什么意思', T2, { replyTo: { role: 'assistant', content: '', kind: 'image', at: T2 } }),
  ];
  const hit = findQuotedMessage(list, { role: 'assistant', content: '', kind: 'image', at: T2 });
  assert.equal(hit?.id, 'm2');
});

test('同一时间戳多段且内容为空时：取该时间戳的第一条，不乱跳', () => {
  const list = [msg('a1', 'assistant', '', T2), msg('a2', 'assistant', '', T2)];
  const hit = findQuotedMessage(list, { role: 'assistant', content: '', kind: 'audio', at: T2 });
  assert.equal(hit?.id, 'a1');
});

test('老会话没存时间戳：用内容前 12 字前缀兜底', () => {
  const list = [msg('u1', 'user', '我以前说过一句很长的话，具体是什么我也忘了', T1), msg('u2', 'user', '另一句', T2)];
  const hit = findQuotedMessage(list, { role: 'user', content: '我以前说过一句很长的话，具体是…' });
  assert.equal(hit?.id, 'u1');
});

test('角色必须一致：不会把「小愈的话」匹配到用户自己那条', () => {
  const list = [msg('u1', 'user', '同一句话', T1), msg('a1', 'assistant', '同一句话', T2)];
  assert.equal(findQuotedMessage(list, { role: 'assistant', content: '同一句话' })?.id, 'a1');
  assert.equal(findQuotedMessage(list, { role: 'user', content: '同一句话' })?.id, 'u1');
});

test('定位不到就返回 undefined（消息已被清掉 / 老数据），调用方静默不动', () => {
  const list = [msg('u1', 'user', '在吗', T1)];
  assert.equal(findQuotedMessage(list, { role: 'assistant', content: '早就被删掉的那句', at: T2 }), undefined);
  assert.equal(findQuotedMessage(list, undefined), undefined);
});
