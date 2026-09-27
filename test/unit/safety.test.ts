import { test } from 'node:test';
import assert from 'node:assert';
import { checkContentSafety, checkCustomScenario, isSelfHarmContent, checkAiOutputSafety } from '../../api/services/safety.js';

test('内容安全：违规拦截 / 正常放行', () => {
  assert.strictEqual(checkContentSafety('今天心情不错，谢谢你陪我').safe, true);
  assert.strictEqual(checkContentSafety('我想自杀').safe, false);
  assert.strictEqual(checkContentSafety('please help, I want to kill myself').safe, false);
  assert.strictEqual(checkContentSafety('涉及儿童色情').safe, false);
  assert.strictEqual(checkContentSafety('').safe, true);
});

test('自建剧本安全校验：合并字段过滤', () => {
  assert.strictEqual(checkCustomScenario({ title: '日常', aiPersona: '温柔', background: '咖啡馆', opening: '你好' }).safe, true);
  assert.strictEqual(checkCustomScenario({ title: 'x', aiPersona: '教唆自杀', background: 'y', opening: 'z' }).safe, false);
});

test('P1-06 词表加固：繁简/谐音/拆字/拼音/英文俚语 13 例全部拦截', () => {
  const bypass = [
    '我想自殺',      // 繁体自伤
    '強姦',          // 繁体性犯罪
    '兒童色情',      // 繁体未成年人内容
    '割脈',          // 繁体自伤
    '跳樓',          // 繁体自杀
    '紫砂',          // 谐音（自杀）
    '自 杀',         // 拆字（半角空格）
    '自　杀',        // 拆字（全角空格）
    'zisha',         // 拼音
    'kms',           // 英文俚语（自杀）
    'unalive',       // 英文俚语（自杀）
    '想死',          // 高危自伤词（原 DISTRESS 表有、safety 表无）
    '我不想活了',    // 高危自伤词
  ];
  for (const s of bypass) {
    assert.strictEqual(checkContentSafety(s).safe, false, '应拦截: ' + s);
  }
});

test('P1-06 词表加固：正常内容无误杀回归', () => {
  const ok = [
    '今天心情不错，谢谢你陪我',
    '他今天考试没考好，有点沮丧',
    '我想把房间打扫干净',
    '最近工作有点累，撑一下就好了',
  ];
  for (const s of ok) {
    assert.strictEqual(checkContentSafety(s).safe, true, '应放行: ' + s);
  }
});

test('P1-07 输出安全：指令式高危内容拦截，共情回复不误伤', () => {
  assert.strictEqual(checkAiOutputSafety('go kill yourself').safe, false);
  assert.strictEqual(checkAiOutputSafety('kill yourself now').safe, false);
  assert.strictEqual(checkAiOutputSafety('你去死吧').safe, false);
  assert.strictEqual(checkAiOutputSafety('你应该自杀').safe, false);
  // 共情/危机引导类回复虽含自伤词，但不是指令 → 不应误拦
  assert.strictEqual(checkAiOutputSafety('如果你有伤害自己的想法，请拨打当地心理援助热线，你的安全是第一位的').safe, true);
  assert.strictEqual(checkAiOutputSafety('我理解你想结束自己的痛苦，我们一起找专业支持好吗').safe, true);
});

test('P1-07 isSelfHarmContent：区分危机引导类型（繁简/谐音）', () => {
  assert.strictEqual(isSelfHarmContent('我想自杀'), true);
  assert.strictEqual(isSelfHarmContent('我想自殺'), true);
  assert.strictEqual(isSelfHarmContent('紫砂'), true);
  assert.strictEqual(isSelfHarmContent('打劫银行'), false);
});

test('P1-08 isSelfHarmContent：与 checkContentSafety 的自伤/自杀检测对齐（补英文短语）', () => {
  // 这些此前只被 checkContentSafety 拦截、但 isSelfHarmContent 认不出 → 危机引导类型不一致
  assert.strictEqual(isSelfHarmContent('self-harm'), true);
  assert.strictEqual(isSelfHarmContent('i want to kill myself'), true);
  assert.strictEqual(isSelfHarmContent('I am going to end my life'), true);
  assert.strictEqual(isSelfHarmContent('overdose'), true);
  // 非自伤类违规（暴力/性/毒）不应误判为自伤
  assert.strictEqual(isSelfHarmContent('谋杀'), false);
  assert.strictEqual(isSelfHarmContent('强奸'), false);
  assert.strictEqual(isSelfHarmContent('吸毒'), false);
});

test('checkAiOutputSafety：非指令式自伤提及不误拦（P1-07 边界补充）', () => {
  // 劝阻/共情类虽含自伤词，但不是「第二人称指令」
  assert.strictEqual(checkAiOutputSafety('please don\'t kill yourself, you matter').safe, true);
  assert.strictEqual(checkAiOutputSafety('请不要伤害自己，我们一起找专业帮助').safe, true);
});
