import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapServerMessages } from '../../src/lib/chatServerMessages';

test('分段助手消息：按 \\n\\n 拆成多条气泡，去掉首尾空白', () => {
  const result = mapServerMessages([
    { role: 'user', content: '今天好累', timestamp: 't0' },
    { role: 'assistant', content: '第一段。\n\n第二段。\n\n  第三段。  ', timestamp: 't1' },
  ]);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(m => m.role), ['user', 'assistant', 'assistant', 'assistant']);
  assert.deepEqual(result.slice(1).map(m => m.content), ['第一段。', '第二段。', '第三段。']);
  // 同一条存库消息拆出的多段：id 唯一且带段落序号
  assert.ok(result[1].id.includes('1-0-t1'));
  assert.ok(result[2].id.includes('1-1-t1'));
  assert.ok(result[3].id.includes('1-2-t1'));
});

test('尾部带 \\n\\n 不产生空气泡', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '只有一段\n\n', timestamp: 't0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '只有一段');
});

test('单换行（非双）不拆分：仍在一条气泡', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '第一行\n第二行', timestamp: 't0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '第一行\n第二行');
});

test('用户消息即使含 \\n\\n 也不拆', () => {
  const result = mapServerMessages([
    { role: 'user', content: '多行\n\n输入', timestamp: 't0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '多行\n\n输入');
});

test('助手消息无 \\n\\n：原样单条', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '一句话', timestamp: 't0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '一句话');
});

test('全为空白的分段消息：回退为原消息，不丢失', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '\n\n  \n\n', timestamp: 't0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '\n\n  \n\n');
});

test('携带图片的消息仍保留 image 字段', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '一段。\n\n二段。', timestamp: 't0', image: 'data:image/jpeg;base64,xxx' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].image, 'data:image/jpeg;base64,xxx');
  assert.equal(result[1].image, 'data:image/jpeg;base64,xxx');
});

/* ───────── 失败兜底气泡：读侧不渲染（红线 6，2026-09-20 补） ───────── */

test('失败兜底气泡不渲染：它只是系统/失败文案，不是小愈说过的话', () => {
  const result = mapServerMessages([
    { role: 'user', content: '在吗', timestamp: 't0' },
    { role: 'assistant', content: '我在的。慢慢说，我会认真听。🌱', timestamp: 't1' },
    { role: 'assistant', content: '我在的。慢慢說，我會認真聽。🌱', timestamp: 't2' },
    { role: 'assistant', content: '网络好像开小差了，稍后再试试好吗？🌱', timestamp: 't3' },
    { role: 'assistant', content: '嗯，我在。今天想聊点什么？', timestamp: 't4' },
  ]);
  assert.deepEqual(result.map((m) => m.content), ['在吗', '嗯，我在。今天想聊点什么？'], '兜底文案没被剔掉：' + JSON.stringify(result.map((m) => m.content)));
});

test('兜底过滤只认整串：台词里出现同款字样不受影响', () => {
  const result = mapServerMessages([
    { role: 'assistant', content: '（我好像没听清，你再说一遍）他往你这边凑了凑。', timestamp: 't0' },
    { role: 'user', content: '生成失败，请稍后重试', timestamp: 't1' }, // user 说的（可能是复述），一律不动
  ]);
  assert.equal(result.length, 2, 'user 消息或正常台词被误删了');
  assert.equal(result[0].content, '（我好像没听清，你再说一遍）他往你这边凑了凑。');
  assert.equal(result[1].role, 'user');
});
