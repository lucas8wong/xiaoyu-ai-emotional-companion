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
/* ───────── 来源行：挂在**最后一段**（2026-09-29） ───────── */

test('来源挂到最后一段气泡上（分段与不分段同一口径）', () => {
  const sources = [{ title: '月饼寄错引消费纠纷', url: 'https://news.sina.com.cn/a.html' }];
  const split = mapServerMessages([
    { role: 'assistant', content: '第一段。\n\n第二段。', timestamp: 't0', sources },
  ]);
  assert.equal(split.length, 2);
  assert.equal(split[0].sources, undefined, '来源不该挂到中间那段');
  assert.deepEqual(split[1].sources, sources, '来源应挂在最后一段（与实时路径一致）');

  const single = mapServerMessages([
    { role: 'assistant', content: '一句话', timestamp: 't1', sources },
  ]);
  assert.deepEqual(single[0].sources, sources);
});

test('没有搜索的回复不写 sources 字段（「没搜」与「搜了没结果」分得开）', () => {
  const none = mapServerMessages([
    { role: 'assistant', content: '一段。\n\n二段。', timestamp: 't0' },
  ]);
  assert.ok(none.every((m) => m.sources === undefined));
  const empty = mapServerMessages([
    { role: 'assistant', content: '一段。', timestamp: 't1', sources: [] },
  ]);
  assert.equal(empty[0].sources, undefined, '空数组不应变成 sources: []');
});
/* ───────── 按段来源：挂到提到它的那条气泡（2026-09-29） ───────── */

test('按段来源：第 j 段引用谁就挂谁，不是全堆在最后一条', () => {
  const weibo = [{ title: 'Tiffany月饼', url: 'https://m.weibo.cn/search?containerid=x' }];
  const r = mapServerMessages([{
    role: 'assistant',
    content: '看了一圈热搜，笑出声。\n\nTiffany月饼，又上榜了。\n\n还有个哥们，900家店下单2700次。',
    timestamp: 't0',
    sourceSegments: [null, weibo, null],
  }]);
  assert.equal(r.length, 3);
  assert.equal(r[0].sources, undefined, '没引用任何条目的段落不该有来源行');
  assert.deepEqual(r[1].sources, weibo, '第 2 段引用了 Tiffany 那条 → 来源挂第 2 条气泡');
  assert.equal(r[2].sources, undefined);
});

test('按段来源 + 整轮来源：最后一段合并去重，中间段只有自己的', () => {
  const seg = [{ title: 'Tiffany月饼', url: 'https://m.weibo.cn/search?containerid=x' }];
  const turn = [{ title: '月饼寄错', url: 'https://news.sina.com.cn/a.html', host: 'finance.sina.com.cn' }];
  const r = mapServerMessages([{
    role: 'assistant',
    content: '第一段。\n\n第二段引用了 Tiffany月饼。',
    timestamp: 't1',
    sources: turn,
    sourceSegments: [null, seg],
  }]);
  assert.equal(r[0].sources, undefined, '整轮来源只挂最后一段，前一段不该有');
  assert.deepEqual(r[1].sources, [...seg, ...turn], '最后一段＝自己的 + 整轮的');
  const dup = mapServerMessages([{
    role: 'assistant',
    content: '第一段。\n\n第二段。',
    timestamp: 't2',
    sources: seg,
    sourceSegments: [null, seg],
  }]);
  assert.deepEqual(dup[1].sources, seg, '同一条出现在两边时只留一份');
});
