/**
 * 对白引号规范守卫测试（2026-09-17）
 *
 * 背景（用户口径）：「对白是不是应该用双引号“”而不是「」」→ 拍板 **按语言版本分**：
 *   简中 “” ／ 繁中 「」 ／ 英文 ""
 *
 * 为什么要归一而不能只靠提示词：线上 1398 条真实 AI 剧情回复实测
 *   「」791 条(57%)、“”280 条(20%)、ASCII 直引号 156 条(11%)，同一段里混用 25 条。
 * 而且 opencc 的简繁转换**不转换引号**（`zhConvert.ts` 实测：两套引号各自原样透传）
 * —— 所以「跟随语言版本」必须显式做。
 *
 * 这组断言钉死三件后续编辑最容易悄悄破坏的事：
 *   1. 字形映射方向正确（简中→ “”，繁中→ 「」，英文不动）；
 *   2. **流式安全**：逐 delta 归一的串联结果必须与整段归一**逐字相同**（否则打字过程中会跳字形）；
 *   3. **幂等 + 长度守恒**（每个引号都是 1:1 换字形，不许吞字符、不许变长）；
 *   4. 撇号保护：英文撇号（don’t / O’Brien）不能被当成引号换掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const dq: any = await import('../../api/services/dialogueQuotes.js');
const rp: any = await import('../../api/services/roleplay.js');

const norm = (t: string, lang: string) => dq.normalizeDialogueQuotes(t, lang);

test('简中：繁体引号 → “”/‘’，ASCII 直引号按配对 → “”', () => {
  assert.equal(norm('他说：「别走。」', 'zh'), '他说：“别走。”');
  assert.equal(norm('她说：「他喊『喂』了。」', 'zh'), '她说：“他喊‘喂’了。”');
  assert.equal(norm('他说："别走。"', 'zh'), '他说：“别走。”');
  assert.equal(norm('他喊了一声"喂"，又补了句"快走"。', 'zh'), '他喊了一声“喂”，又补了句“快走”。');
  // 已经是简中字形 → 原样
  assert.equal(norm('他说：“别走。”', 'zh'), '他说：“别走。”');
});

test('繁中：简体引号 → 「」/『』，ASCII 直引号按配对 → 「」（只换字形、不动简繁字体）', () => {
  // ⚠️ 本函数**只管引号字形**，不负责简繁字体：字体由 normalizeRplangText(opencc) 先做，
  //    所以这里「他说」不会变成「他說」；真实链路里两者串联（见文末接入测试）。
  assert.equal(norm('他说：“别走。”', 'zh-TW'), '他说：「别走。」');
  assert.equal(norm('她说：“他喊‘喂’了。”', 'zh-TW'), '她说：「他喊『喂』了。」');
  assert.equal(norm('他说："别走。"', 'zh-TW'), '他说：「别走。」');
  // 已经是繁中字形 → 原样
  assert.equal(norm('他說：「別走。」', 'zh-TW'), '他說：「別走。」');
});

test('英文：一律不动（英文的规范就是 ASCII 直引号）', () => {
  const en = 'He said, "Don\'t go." She nodded.';
  assert.equal(norm(en, 'en'), en);
  assert.equal(norm('He said, “Don’t go.”', 'en'), 'He said, “Don’t go.”');
  assert.equal(norm('他说：「别走。」', 'en'), '他说：「别走。」');
});

test('撇号保护：don’t / O’Brien 的 ’ 不是引号，不换字形', () => {
  const tw = norm('他说 don’t，后来喊了一声「好」。', 'zh-TW');
  assert.ok(tw.includes('don’t'), '英文撇号被换掉了：' + tw);
  assert.ok(norm('O’Brien said "hi"', 'zh').includes('O’Brien'), '英文撇号被换掉了');
  // 中文里的嵌套单引号仍要换（繁中 → 『』）
  assert.equal(norm('他說：‘好’', 'zh-TW'), '他說：『好』');
  // 简中同理：繁体嵌套单引号 → ‘’
  assert.equal(norm('他说：『好』', 'zh'), '他说：‘好’');
});

test('幂等：跑两次结果不变（归一发生在每个渲染/重放路径上）', () => {
  const samples: Array<[string, string]> = [
    ['他说：「别走。」他说："走吧。"', 'zh'],
    ['他說：“別走。”', 'zh-TW'],
    ['He said, "go".', 'en'],
  ];
  for (const [text, lang] of samples) {
    const once = norm(text, lang);
    assert.equal(norm(once, lang), once, `${lang}: ${text}`);
  }
});

test('流式安全：逐 delta 归一的串联 === 整段归一（每个切分点都试）', () => {
  const cases: Array<[string, string]> = [
    ['他垂下眼："你来了。"（他说得很轻。）\n「嗯。」', 'zh'],
    ['他垂下眼："你来了。"\n（他说得很轻。）', 'zh-TW'],
    ['{「」“”"』\n他笑了："好。"', 'zh'],
  ];
  for (const [text, lang] of cases) {
    const whole = norm(text, lang);
    for (let cut = 0; cut <= text.length; cut++) {
      const n = dq.createDialogueQuoteNormalizer(lang);
      const streamed = n.push(text.slice(0, cut)) + n.push(text.slice(cut));
      assert.equal(streamed, whole, `${lang} 在 ${cut} 处切分时流式结果与整段不同：${streamed}`);
    }
  }
});

test('长度守恒：只换字形，不吞字符、不变长（对每组都成立）', () => {
  const samples: Array<[string, string]> = [
    ['他说：「别走。」', 'zh'],
    ['他说："别走。"别怕。', 'zh'],
    ['他說：“別走。”', 'zh-TW'],
    ['don’t 「走」 "no"', 'zh-TW'],
  ];
  for (const [text, lang] of samples) {
    assert.equal(norm(text, lang).length, text.length, `${lang}: ${text}`);
  }
});

test('配对修复：模型用两个开引号框台词（“台词……“）→ 第二个补成闭引号', () => {
  // 真实取证：用户 cf8077d3（林清缇）在无限制链路上写出的就是这种形态，8 个回合全部命中
  // `回复仍不完整（unclosed，续写 2 次）`——计数不配对 → 被判半截 → 自动续写 → 重讲同一拍。
  // 取证目录 temp/rp-rep-cf8077d3/（未闭合标记.txt / 复读接缝.txt）。
  assert.equal(norm('他低声道：“这双手若是不安……“', 'zh'), '他低声道：“这双手若是不安……”');
  // 一句里多个台词，每个都是"两开" → 各自修成一对
  const two = '“别动……“他顿了顿。“听我说……“';
  assert.equal(norm(two, 'zh'), '“别动……”他顿了顿。“听我说……”');
  // 落单的闭引号 → 补成开引号（保持成对）
  assert.equal(norm('”你来了。”', 'zh'), '“你来了。”');
  // 繁中同理（字形换成 「」）
  assert.equal(norm('他說：「別走……「', 'zh-TW'), '他說：「別走……」');
  // 已经配对的一律不动
  assert.equal(norm('他说：“别走。”', 'zh'), '他说：“别走。”');
  // 幂等：修完再跑一次不变
  const once = norm(two, 'zh');
  assert.equal(norm(once, 'zh'), once);
  // 长度守恒（1:1 换字形）
  assert.equal(norm(two, 'zh').length, two.length);
});

test('配对修复：流式与整段结果一致（含撇号切在 delta 边界）', () => {
  const cases: Array<[string, string]> = [
    ['他说：“这双手若是不安……“他停住了。', 'zh'],
    ['他說：「別走……「（他沒動。）', 'zh-TW'],
    ['don’t “走……“', 'zh-TW'],
  ];
  for (const [text, lang] of cases) {
    const whole = norm(text, lang);
    for (let cut = 0; cut <= text.length; cut++) {
      const n = dq.createDialogueQuoteNormalizer(lang);
      const streamed = n.push(text.slice(0, cut)) + n.push(text.slice(cut));
      assert.equal(streamed, whole, `${lang} 在 ${cut} 处切分时流式结果与整段不同：${streamed}`);
    }
  }
});

test('引号规范条款：三语齐全、字形明确、带示例', () => {
  const zh = dq.quoteRuleBlock('zh');
  const tw = dq.quoteRuleBlock('zh-TW');
  const en = dq.quoteRuleBlock('en');

  assert.ok(zh.includes('【引号规范 · 严格遵守】'), 'zh 缺标题');
  assert.ok(zh.includes('“别走。”'), 'zh 示例没用简中字形');
  assert.ok(zh.includes('「」'), 'zh 应显式点名不要用「」');
  assert.ok(tw.includes('【引號規範 · 嚴格遵守】'), 'zh-TW 未转繁体：' + tw.slice(0, 30));
  assert.ok(tw.includes('「別走。」'), 'zh-TW 示例没用繁中字形');
  assert.ok(en.includes('[Quotation rule'), 'en 缺条款');
  assert.ok(en.includes('straight double quotes'), 'en 未点名直引号');
  // 三语都要提醒"不要混用/不要用另一套"
  assert.ok(zh.includes('不要混用'), 'zh 缺"不要混用"');
  assert.ok(tw.includes('不要混用'), 'zh-TW 缺"不要混用"');
});

test('接入真实 prompt：三语 system 里都带上了引号条款（且不跑到回合纪律块之后）', () => {
  const scenario = rp.SCENARIOS[0];
  const cases: Array<[string, string, string]> = [
    ['zh', '【引号规范', '【回合纪律'],
    ['zh-TW', '【引號規範', '【回合紀律'],
    ['en', '[Quotation rule', 'HIGHEST PRIORITY'],
  ];
  for (const [lang, marker, tailMarker] of cases) {
    const sys = rp.buildSystemPrompt(scenario, lang, undefined, undefined, undefined, 'immersive', false);
    assert.ok(sys.includes(marker), `${lang} 的 system 缺引号条款`);
    const composed = rp.composeRoleplaySystem({ sys, lang, style: 'immersive' });
    const q = composed.indexOf(marker);
    const tail = composed.lastIndexOf(tailMarker);
    assert.ok(q >= 0 && tail > q, `${lang} 的引号条款跑到回合纪律块之后了（q=${q}, tail=${tail}）`);
  }
});
