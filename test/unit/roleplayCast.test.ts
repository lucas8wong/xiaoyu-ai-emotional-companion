import { test } from 'node:test';
import assert from 'node:assert';
import { parseCastSegments, stripCastTags, hasCastSpeaker, type CastName } from '../../src/lib/roleplayCast.js';

const CAST: CastName[] = [
  { id: 'peixiuyuan', name: '裴修远', lead: true },
  { id: 'limomo', name: '李嬷嬷' },
  { id: 'cuiping', name: '翠屏' },
];

const speakers = (raw: string) => parseCastSegments(raw, CAST).map(s => (s.speaker ? s.speaker.name : '')).join(',');
const texts = (raw: string) => parseCastSegments(raw, CAST).map(s => s.text).join('|');

test('没有标记：整段退化为单条旁白，text 逐字等于原文（绝不吞字符）', () => {
  const raw = '红烛燃着，喜房里静得只剩烛芯偶尔"啪"地一响。';
  const segs = parseCastSegments(raw, CAST);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].speaker, null);
  assert.strictEqual(segs[0].text, raw);
});

test('空串 / 非字符串 / 空名单：安全返回，行为不变', () => {
  assert.deepStrictEqual(parseCastSegments('', CAST), []);
  assert.deepStrictEqual(parseCastSegments(undefined as unknown as string, CAST), []);
  const raw = '他是「裴修远」。';
  const noCast = parseCastSegments(raw, []);
  assert.strictEqual(noCast.length, 1);
  assert.strictEqual(noCast[0].speaker, null);
  assert.strictEqual(noCast[0].text, raw);
});

test('两人同场：段落归属正确，text 不含标记，顺序保持', () => {
  const raw = '【裴修远】他抬眼看向门口。"谁在外面？"\n【李嬷嬷】"回世子，是嬷嬷来请安。"';
  assert.strictEqual(speakers(raw), '裴修远,李嬷嬷');
  assert.deepStrictEqual(parseCastSegments(raw, CAST).map(s => s.text), [
    '他抬眼看向门口。"谁在外面？"',
    '"回世子，是嬷嬷来请安。"',
  ]);
});

test('首段旁白 + 之后换人：旁白 speaker 为 null；标记之间的动作行跟随该角色', () => {
  const raw = '红烛燃着。\n【裴修远】"你是林家的哪个？"\n（他眯起眼。）\n【翠屏】"小姐……"';
  assert.strictEqual(speakers(raw), ',裴修远,翠屏');
  assert.deepStrictEqual(parseCastSegments(raw, CAST).map(s => s.text), [
    '红烛燃着。',
    '"你是林家的哪个？"\n（他眯起眼。）',
    '"小姐……"',
  ]);
});

test('流式容错：行首未闭合的标记被扣住，不渲染半截、不当旁白', () => {
  // 名字还没写全
  assert.strictEqual(parseCastSegments('【裴修远】"谁在外面？"\n【裴', CAST).length, 1);
  // 名字写全了、右括号还没到
  assert.strictEqual(parseCastSegments('【裴修远】"谁在外面？"\n【裴修远', CAST).length, 1);
  // 第一段标记本身就还没闭合（整条回复刚开始）
  assert.deepStrictEqual(parseCastSegments('【裴', CAST), []);
  // 但"不可能是标记"的行首方括号要原样保留
  const stray = '【不是名单里的名字】他说。';
  const segs = parseCastSegments(stray, CAST);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].speaker, null);
  assert.strictEqual(segs[0].text, stray);
});

test('空行边界：空行后无标记的段落是旁白；同一段内无标记的行跟随上一个角色', () => {
  const raw = '红烛燃着。\n\n【裴修远】"谁在外面？"\n（他眯起眼。）\n\n（门外传来脚步声。）\n【李嬷嬷】"回世子。"';
  const segs = parseCastSegments(raw, CAST);
  assert.strictEqual(segs.map(s => (s.speaker ? s.speaker.name : '')).join(','), ',裴修远,,李嬷嬷');
  assert.deepStrictEqual(segs.map(s => s.text), [
    '红烛燃着。',
    '"谁在外面？"\n（他眯起眼。）',
    '（门外传来脚步声。）',
    '"回世子。"',
  ]);
});

test('只认行首标记：夹在句子中间的【名字】按正文处理', () => {
  const raw = '他念了一句【裴修远】的名字，然后又沉默。';
  const segs = parseCastSegments(raw, CAST);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].speaker, null);
  assert.strictEqual(segs[0].text, raw);
});

test('长名优先：名单里同时有短名时不会被抢走', () => {
  const cast: CastName[] = [{ id: 'a', name: '翠' }, { id: 'b', name: '翠屏' }];
  const segs = parseCastSegments('【翠屏】"小姐。"', cast);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].speaker?.id, 'b');
  assert.strictEqual(segs[0].text, '"小姐。"');
});

test('stripCastTags：剃掉可识别的标记，其余逐字保留', () => {
  const raw = '【裴修远】他抬眼。"谁在外面？"\n【李嬷嬷】"回世子。"';
  assert.strictEqual(stripCastTags(raw, CAST), '他抬眼。"谁在外面？"\n"回世子。"');
  // 不在名单里的方括号原样保留
  assert.strictEqual(stripCastTags('【某某】你好', CAST), '【某某】你好');
  // 空串安全
  assert.strictEqual(stripCastTags('', CAST), '');
});

test('hasCastSpeaker：只有旁白时为 false，出现说话人为 true', () => {
  assert.strictEqual(hasCastSpeaker(parseCastSegments('只有旁白。', CAST)), false);
  assert.strictEqual(hasCastSpeaker(parseCastSegments('【裴修远】"嗯。"', CAST)), true);
});

test('不吞字符：各段正文 + 被剃掉的标记 = 原文（去空白口径）', () => {
  const raw = '【裴修远】他抬眼。"谁在外面？"\n\n【李嬷嬷】"回世子，是嬷嬷来请安。"\n【翠屏】（低头）"小姐……"';
  const parts = parseCastSegments(raw, CAST).map(s => s.text).join('');
  const bare = (s: string) => s.replace(/[\s\u3000]+/g, '');
  assert.strictEqual(bare(parts), bare(stripCastTags(raw, CAST)));
});
