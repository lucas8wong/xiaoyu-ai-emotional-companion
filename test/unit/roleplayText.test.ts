import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { parseRoleplayText, hasThoughtMarker, type RpSegment } from '../../src/lib/roleplayText.js';

const kinds = (segs: RpSegment[]) => segs.map(s => s.type).join(',');
const join = (segs: RpSegment[]) => segs.map(s => s.text).join('');
/** 去掉所有空白后的字符序列（用于「一个字符都没吞」的通用断言） */
const bare = (s: string) => s.replace(/\s+/g, '');

test('纯旁白：只有 narration，且逐字符等于原文', () => {
  const raw = '窗外的雨下了一整夜，他把杯子推到一边，没有再说话。';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'narration');
  assert.strictEqual(join(segs), raw);
});

test('空串/非字符串安全返回空数组', () => {
  assert.deepStrictEqual(parseRoleplayText(''), []);
  assert.deepStrictEqual(parseRoleplayText(undefined as unknown as string), []);
});

test('对白：直角引号「」/『』、中文弯引号“”、英文直引号 " 都识别为 dialogue，且 inner 不含标记符', () => {
  const cases: Array<[string, string]> = [
    ['「我在听，你继续。」', '我在听，你继续。'],
    ['『别走。』', '别走。'],
    ['“你怎么才来。”', '你怎么才来。'],
    ['"Come in."', 'Come in.'],
  ];
  for (const [raw, inner] of cases) {
    const segs = parseRoleplayText(raw);
    assert.strictEqual(kinds(segs), 'dialogue', raw);
    assert.strictEqual(segs[0].inner, inner, raw);
    // 整段就是这一句对白 = 独占一行 → 块级台词卡（2026-09-17 起对白也参与块级判定）
    assert.strictEqual(segs[0].block, true, raw);
  }
});

test('心声：全角（）与半角 () 都识别为 thought', () => {
  const segs = parseRoleplayText('（他轻轻叹了口气）「我在这儿。」');
  assert.strictEqual(kinds(segs), 'thought,dialogue');
  assert.strictEqual(segs[0].inner, '他轻轻叹了口气');
  assert.strictEqual(segs[1].inner, '我在这儿。');

  const en = parseRoleplayText('(he sighs softly) "Take your time."');
  // 英文惯例是括号后带空格 → 中间那段空格是旁白（原样保留，不能被"优化"掉）
  assert.strictEqual(kinds(en), 'thought,narration,dialogue');
  assert.strictEqual(en[0].inner, 'he sighs softly');
  assert.strictEqual(en[2].inner, 'Take your time.');
});

test('旁白 + 对白 + 心声混排：类型顺序正确，且原文一个字符都没丢', () => {
  const raw = '他垂下眼，声音很轻。\n（其实他等了整整一个晚上。）\n「我只是想确认你没事。」';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'narration,thought,dialogue');
  // thought 独占一行 → 块级；它前面那段的尾随换行被吸收（块级自带换行，否则会多一条空行）
  assert.strictEqual(segs[1].block, true);
  // 对白也独占一行 → 块级台词卡（2026-09-17 起「高亮给对白」）
  assert.strictEqual(segs[2].block, true);
  assert.strictEqual(bare(join(segs)), bare(raw));
});

test('嵌套：不同类标记嵌在心声里整体算心声，不被切开、也不吞字符', () => {
  const raw = '（他想起她说的「别走」）他站在原地没动。';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'thought,narration');
  assert.strictEqual(segs[0].inner, '他想起她说的「别走」');
  assert.strictEqual(join(segs), raw);
});

test('嵌套：同类型括号按深度配对，内层括号保留在 inner 里', () => {
  const raw = '（他说（很小声））「你听见了吗？」';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'thought,dialogue');
  assert.strictEqual(segs[0].inner, '他说（很小声）');
  assert.strictEqual(segs[0].text, '（他说（很小声））');
});

test('流式容错：未闭合的 （ 按心声渲染（闭合时不跳变），且内容不丢', () => {
  const raw = '他顿了一下。（其实他';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'narration,thought');
  assert.strictEqual(segs[1].close, '');
  assert.strictEqual(segs[1].inner, '其实他');
  assert.strictEqual(join(segs), raw);
});

test('流式容错：未闭合的「 按对白渲染，且后面继续追加的字符都在这一片里', () => {
  const segs = parseRoleplayText('他说「我在');
  assert.strictEqual(kinds(segs), 'narration,dialogue');
  assert.strictEqual(segs[1].close, '');
  assert.strictEqual(segs[1].inner, '我在');
});

test('流式容错：落单的右括号（如笑脸 )）不会开启新片段，也不会吞掉后面的台词', () => {
  const raw = '他笑了一下 :)。「走吧。」';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'narration,dialogue');
  assert.strictEqual(segs[1].inner, '走吧。');
  assert.strictEqual(join(segs), raw);
});

test('块级判定：独占一行的心声 → block=true；夹在句子中间的心声 → 行内（不拆句）', () => {
  const own = parseRoleplayText('他停下脚步。\n（她没有回头。）\n「算了。」');
  assert.strictEqual(own.find(s => s.type === 'thought')!.block, true);

  const inline = parseRoleplayText('他停下脚步，（她没说话）然后继续往前走。');
  const th = inline.find(s => s.type === 'thought')!;
  assert.strictEqual(th.block, false);
  assert.strictEqual(kinds(inline), 'narration,thought,narration');
});

test('块级心声吸收紧邻空白：渲染层不会多出空行，心意内容本身不变', () => {
  const raw = '前面一句。\n（心里那句实话。）\n后面一句。';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(segs[0].text, '前面一句。');
  assert.strictEqual(segs[1].text, '（心里那句实话。）');
  assert.strictEqual(segs[2].text, '后面一句。');
  // 行内心声不受影响（空白原样保留）
  const inline = parseRoleplayText('甲（乙）丙');
  assert.strictEqual(join(inline), '甲（乙）丙');
});

test('多个角色同场：每段对白各自成片，中间的旁白保留', () => {
  const raw = '「你来了。」他侧过身。\n「嗯。」另一个人应了一声。';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(kinds(segs), 'dialogue,narration,dialogue,narration');
  assert.strictEqual(bare(join(segs)), bare(raw));
});

test('块级对白：独占一行 → block=true（台词卡）；夹在句中 → 行内（只靠引号着色，不切句）', () => {
  const own = parseRoleplayText('他推开门。\n「我回来了。」\n屋里没人应声。');
  assert.strictEqual(kinds(own), 'narration,dialogue,narration');
  assert.strictEqual(own.find(s => s.type === 'dialogue')!.block, true);

  const inline = parseRoleplayText('「你来了。」他侧过身让开门口。');
  assert.strictEqual(kinds(inline), 'dialogue,narration');
  assert.strictEqual(inline.find(s => s.type === 'dialogue')!.block, false);
});

test('块级对白吸收紧邻空白：台词卡上下不会各多一条空行，且一个字符都不丢', () => {
  const raw = '前面一句。\n「我在。」\n后面一句。';
  const segs = parseRoleplayText(raw);
  assert.strictEqual(segs[0].text, '前面一句。');
  assert.strictEqual(segs[1].text, '「我在。」');
  assert.strictEqual(segs[2].text, '后面一句。');
  assert.strictEqual(bare(join(segs)), bare(raw));
});

test('流式容错：未闭合的对白恒为行内（闭合那一刻才升级成块级，打字过程中样式不跳变）', () => {
  const streaming = parseRoleplayText('他说\n「我在');
  assert.strictEqual(streaming[1].type, 'dialogue');
  assert.strictEqual(streaming[1].block, false);
  // 未闭合时不做空白吸收（没有块级存在），原文原样保留
  assert.strictEqual(streaming[0].text, '他说\n');

  const closed = parseRoleplayText('他说\n「我在。」');
  assert.strictEqual(closed[1].block, true);
});

test('多角色同场：一条消息里两种对白形态各归其位（块级 1 个 / 行内 2 个）', () => {
  const raw = '他推开门。\n「我回来了。」\n「住下就住下，」她抬眼看他，「你怕什么？」';
  const segs = parseRoleplayText(raw);
  const dlgs = segs.filter(s => s.type === 'dialogue');
  assert.strictEqual(dlgs.length, 3);
  assert.deepStrictEqual(dlgs.map(d => !!d.block), [true, false, false]);
  assert.strictEqual(bare(join(segs)), bare(raw));
});

test('hasThoughtMarker：只在真含括号时为真（给"首次提示"做轻量探测）', () => {
  assert.strictEqual(hasThoughtMarker('（他叹了口气）'), true);
  assert.strictEqual(hasThoughtMarker('(sighs)'), true);
  assert.strictEqual(hasThoughtMarker('「我只是在听。」'), false);
  assert.strictEqual(hasThoughtMarker(''), false);
});

test('性能：3000 字长回复线性分词，不因回溯正则卡住', () => {
  const raw = '他看向你。'.repeat(200) + '（心里默数着每一秒。）'.repeat(20) + '「我在。」'.repeat(100);
  const t0 = Date.now();
  const segs = parseRoleplayText(raw);
  const cost = Date.now() - t0;
  assert.ok(segs.length > 100);
  assert.strictEqual(bare(join(segs)), bare(raw));
  assert.ok(cost < 200, `分词耗时 ${cost}ms 过高`);
});

/**
 * CSS 守卫（2026-09-19 用户口径「经典叙事的对话高亮应该跟沉浸叙事的高亮一样」）：
 * 解析器只负责"这是不是对白"，**高亮**由 `.rp-dialogue-*` 决定。原先行内对白**没有任何容器规则**，
 * 于是模型把台词写进长段叙述时（经典档的常态：实测对白字数里只有 10.5% 被高亮，沉浸档 48.1%）
 * 用户看到的台词就是裸文本 —— 高亮与否取决于模型的排版习惯，而不是"这是不是台词"。
 * 这条测试把"两档共用同一套容器"钉死，防止以后有人"顺手"把行内版的容器删掉。
 */
test('CSS：行内对白与块级对白共用同一套容器（底色 + 左竖线）', async () => {
  const css = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
  const rule = (name: string) => {
    // ⚠️ 刻意不用正则：源码里的转义字符串很容易在写入时被吃掉（本轮就踩了一次），改成纯字符串扫描
    const at = css.indexOf('.' + name + ' {');
    if (at < 0) return '';
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
  };
  const block = rule('rp-dialogue-block');
  const inline = rule('rp-dialogue-inline');
  assert.ok(block.includes('background-color'), '块级对白应有底色');
  assert.ok(block.includes('border-left'), '块级对白应有左竖线');
  assert.ok(inline.includes('background-color'), '行内对白也要有底色（否则经典档的台词又变回裸文本）');
  assert.ok(inline.includes('border-left'), '行内对白也要有左竖线（同一套容器语言）');
  assert.ok(inline.includes('inline-block'), '行内版要用 inline-block 承载，否则竖线/圆角会随折行碎成一堆小竖条');
  assert.ok(inline.includes('max-width'), '行内版要限制宽度，不能顶出气泡');
  // 心声仍然不上容器（2026-09-17 口径：只有"说出来的话"带容器）
  const thought = rule('rp-thought-block');
  assert.ok(!thought.includes('background-color'), '心声不该有底色');
  assert.ok(!thought.includes('border-left'), '心声不该有左竖线');
});
