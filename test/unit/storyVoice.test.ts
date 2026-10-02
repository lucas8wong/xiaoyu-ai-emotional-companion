import { test } from 'node:test';
import assert from 'node:assert';
import {
  VOICE_PRESETS,
  presetById,
  toneForScenario,
  genderForScenario,
  defaultVoicePreset,
  defaultVoiceForScenario,
  storyVoiceDesign,
  speakableRoleplayText,
  clampForSpeech,
  SPEECH_MAX_CHARS,
} from '../../src/lib/storyVoice.js';

// 【语气基调：与 storyBgm.setForScenario 共用同一套标签分组】
test('toneForScenario：标签分组 → 语气基调（校园明快/冷感克制/治愈温柔/古韵温暖/都市默认）', () => {
  assert.strictEqual(toneForScenario({ tags: ['校园'] }), 'bright');
  assert.strictEqual(toneForScenario({ tags: ['刑警'] }), 'cool');
  assert.strictEqual(toneForScenario({ tags: ['治愈'] }), 'gentle');
  assert.strictEqual(toneForScenario({ tags: ['古代架空'] }), 'warm');
  assert.strictEqual(toneForScenario({ tags: ['都市'] }), 'warm');
  assert.strictEqual(toneForScenario({}), 'warm');
  // 优先级：校园（明快）优先于冷感
  assert.strictEqual(toneForScenario({ tags: ['刑警', '校园'] }), 'bright');
});

test('genderForScenario：优先人设 gender，缺失时回退受众分区（her=给她=男性 AI）', () => {
  assert.strictEqual(genderForScenario({ ai: { gender: '男' } }), 'male');
  assert.strictEqual(genderForScenario({ ai: { gender: '女' } }), 'female');
  assert.strictEqual(genderForScenario({ ai: { gender: 'Male' } }), 'male');
  assert.strictEqual(genderForScenario({ ai: { gender: 'Female' } }), 'female');
  assert.strictEqual(genderForScenario({ audience: 'her' }), 'male');
  assert.strictEqual(genderForScenario({ audience: 'him' }), 'female');
  assert.strictEqual(genderForScenario({ audience: 'lgbt' }), 'neutral');
  assert.strictEqual(genderForScenario({}), 'neutral');
  // 人设优先于受众分区
  assert.strictEqual(genderForScenario({ ai: { gender: '女' }, audience: 'her' }), 'female');
});

test('defaultVoicePreset：语气 × 性别双维度选中不同音色（男女不共用）', () => {
  assert.strictEqual(defaultVoicePreset({ tags: ['校园'], ai: { gender: '女' } }).id, 'bright-f');
  assert.strictEqual(defaultVoicePreset({ tags: ['校园'], ai: { gender: '男' } }).id, 'youthful-m');
  assert.strictEqual(defaultVoicePreset({ tags: ['刑警'], ai: { gender: '男' } }).id, 'deep-m');
  assert.strictEqual(defaultVoicePreset({ tags: ['刑警'], ai: { gender: '女' } }).id, 'cool-f');
  assert.strictEqual(defaultVoicePreset({ tags: ['治愈'], ai: { gender: '女' } }).id, 'gentle-f');
  assert.strictEqual(defaultVoicePreset({ tags: ['古代架空'], ai: { gender: '男' } }).id, 'steady-m');
  // 性别 unknown → 中性音色（而不是随便挑一个女声）
  assert.strictEqual(defaultVoicePreset({ tags: ['都市'] }).id, 'calm-n');
  // 显式表：每个「语气 × 性别」组合都是刻意选的，不依赖"找不到就回退"
  assert.strictEqual(defaultVoicePreset({ tags: ['治愈'], ai: { gender: '男' } }).id, 'steady-m');
  assert.strictEqual(defaultVoicePreset({ tags: ['都市'], ai: { gender: '女' } }).id, 'warm-f');
  assert.strictEqual(defaultVoicePreset({ tags: ['都市'], ai: { gender: '男' } }).id, 'steady-m');
  assert.strictEqual(defaultVoicePreset({ tags: ['古代架空'], ai: { gender: '女' } }).id, 'warm-f');
  assert.strictEqual(defaultVoicePreset({ tags: ['校园'], audience: 'her' }).id, 'youthful-m'); // 受众回退
  assert.strictEqual(defaultVoicePreset({ tags: ['刑警'], audience: 'lgbt' }).id, 'calm-n');
});

test('storyVoiceDesign：语言词只在英文界面加（中文让 VoxCPM 按文本语言读）', () => {
  const p = presetById('gentle-f')!;
  assert.strictEqual(storyVoiceDesign(p, ''), '(young adult female voice, soft and gentle tone, slow pace)');
  assert.strictEqual(storyVoiceDesign(p, 'en-US'), '(American English, young adult female voice, soft and gentle tone, slow pace)');
  assert.strictEqual(storyVoiceDesign(p, 'en-GB'), '(British English, young adult female voice, soft and gentle tone, slow pace)');
  // 未知方言值 → 当作中文（不加语言词），与 effectiveDialect 的中文口径一致
  assert.strictEqual(storyVoiceDesign(p, 'Cantonese'), '(young adult female voice, soft and gentle tone, slow pace)');
});

test('presets 自洽：id 唯一、design 非空、label 齐全', () => {
  const ids = VOICE_PRESETS.map(p => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const p of VOICE_PRESETS) {
    assert.ok(p.design.trim().length > 0, p.id + ' design 不能为空');
    assert.ok(p.label.startsWith('rpVoice'), p.id + ' label 应为 rpVoice* i18n key');
    assert.ok(/voice/.test(p.design), p.id + ' design 应含 voice');
  }
  assert.strictEqual(defaultVoiceForScenario({ tags: ['治愈'], ai: { gender: '女' } }).design.startsWith('('), true);
});

// 【朗读文本清洗：括号心理描写必须去掉（否则"看不见的内心"被念出来 = 立刻出戏）】
test('speakableRoleplayText：去掉全角括号里的心理活动/神态，保留对白与旁白', () => {
  const raw = '（他轻轻叹了口气）「我在这儿。」他抬眼看过来。';
  assert.strictEqual(speakableRoleplayText(raw), '「我在这儿。」他抬眼看过来。');
  // 嵌套括号整段去掉
  assert.strictEqual(speakableRoleplayText('（他说（低声））好'), '好');
  // 英文括号同理
  assert.strictEqual(speakableRoleplayText('(he sighs softly) "I\'m here."'), '"I\'m here."');
  // 【】/[] 也去掉
  assert.strictEqual(speakableRoleplayText('【系统】别走。'), '别走。');
});

test('speakableRoleplayText：括号不配对时整对跳过（宁可留着，也不能把后半段台词吞掉）', () => {
  const raw = '我有点累(真的，只剩一句了。后面全是台词。';
  assert.strictEqual(speakableRoleplayText(raw), raw);
  // 只闭不开同样跳过
  assert.strictEqual(speakableRoleplayText('好）继续。'), '好）继续。');
});

test('speakableRoleplayText：清 markdown、去角色名前缀、折行归一', () => {
  assert.strictEqual(speakableRoleplayText('**重点**她说。'), '重点她说。');
  assert.strictEqual(speakableRoleplayText('## 标题\n正文'), '标题 正文');
  assert.strictEqual(speakableRoleplayText('林见微：「你回来了。」', { aiName: '林见微' }), '「你回来了。」');
  assert.strictEqual(speakableRoleplayText('林见微：「你回来了。」'), '林见微：「你回来了。」'); // 未传 aiName 不动
  assert.strictEqual(speakableRoleplayText('第一行\n\n第二行'), '第一行 第二行');
  // 只清理前缀，正文里的同名不误伤
  assert.strictEqual(speakableRoleplayText('她叫林见微：这名字很好听。', { aiName: '林见微' }), '她叫林见微：这名字很好听。');
  // 空值安全
  assert.strictEqual(speakableRoleplayText(''), '');
});

test('clampForSpeech：超长按句末截断（不念半句），无标点则硬切', () => {
  const long = '第一句。' + '啊'.repeat(SPEECH_MAX_CHARS) + '。最后一句。';
  const out = clampForSpeech(long);
  assert.ok(out.length <= SPEECH_MAX_CHARS);
  assert.ok(out.endsWith('。'));
  assert.ok(!out.includes('最后一句'));
  // 无句末标点 → 硬切且不超长
  const noPunct = 'a'.repeat(SPEECH_MAX_CHARS + 50);
  assert.strictEqual(clampForSpeech(noPunct).length, SPEECH_MAX_CHARS);
  // 短文本原样
  assert.strictEqual(clampForSpeech('短句。'), '短句。');
  assert.strictEqual(clampForSpeech(''), '');
});
