import { test } from 'node:test';
import assert from 'node:assert';
import { pickActiveCharacter } from '../../src/lib/pickActiveCharacter.js';

const xiaoyu = { id: 'xiaoyu', name: '小愈', isDefault: true } as any;
const old = { id: 'old', name: '老直', isDefault: false } as any;

function session(id: string, characterId: string | undefined, updatedAt: string) {
  return { sessionId: id, characterId, updatedAt } as any;
}

test('默认取最近一次更新会话所属角色（忽略置顶排序）', () => {
  const sessions = [
    session('pinned', 'xiaoyu', '2026-08-01T00:00:00Z'), // 置顶但更旧
    session('recent', 'old', '2026-08-20T00:00:00Z'),      // 更近
  ];
  const active = pickActiveCharacter([xiaoyu, old], sessions, null);
  assert.strictEqual(active?.id, 'old');
});

test('chatSessionId 指定会话时以该会话所属角色为准', () => {
  const sessions = [
    session('a', 'xiaoyu', '2026-08-20T00:00:00Z'),
    session('b', 'old', '2026-08-25T00:00:00Z'),
  ];
  const active = pickActiveCharacter([xiaoyu, old], sessions, 'a');
  assert.strictEqual(active?.id, 'xiaoyu');
});

test('无任何会话时回落到默认角色', () => {
  const active = pickActiveCharacter([xiaoyu, old], [], null);
  assert.strictEqual(active?.id, 'xiaoyu');
});

test('最近会话所属角色已不存在时回落到默认角色', () => {
  const sessions = [session('recent', 'ghost', '2026-08-20T00:00:00Z')];
  const active = pickActiveCharacter([xiaoyu, old], sessions, null);
  assert.strictEqual(active?.id, 'xiaoyu');
});

test('最近会话未标注角色时按小愈处理', () => {
  const sessions = [session('recent', undefined, '2026-08-20T00:00:00Z')];
  const active = pickActiveCharacter([xiaoyu, old], sessions, null);
  assert.strictEqual(active?.id, 'xiaoyu');
});
