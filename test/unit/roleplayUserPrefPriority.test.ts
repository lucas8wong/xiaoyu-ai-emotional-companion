/**
 * 「剧情偏好 · 最高优先级」守卫测试（2026-09-17）
 *
 * 需求原话：「剧情聊天里的用户偏好应该作为最高权重和重视度让 ai 参考。」
 *
 * 背景（这次不是拍脑袋改提示词，是真有取证）：偏好块原本拼在【写作与交互要求】之后，
 * 也就是 200 条写作规则的**中段**；而 system 最末尾的【回合纪律 · 最高优先级】写着
 * 「与上文任何条款冲突时以本节为准」，偏好正好落在它的「上文」里。位置＝权重，等于被压住。
 * CHANGELOG 2026-09-17 #3 的记录：用户在偏好框里亲手写「不要再发这个气息了」，
 * 模型在随后 12:36 / 12:37 两轮**又各发一次**。
 *
 * 这组断言钉死四件最容易在后续编辑中悄悄失效的事：
 *   1. 有偏好时，偏好块**永远在 system 最末尾**（顺序＝权重）、且只注入一次；
 *   2. 纪律块知道自己不再是最末，并显式让位（两份「最高优先级」不能互相打架）；
 *   3. buildSystemPrompt 不再把偏好塞回中段（旧契约的静默回归＝偏好「配了没生效」）；
 *   4. 块内自带安全兜底（偏好可自由文本 → 它成了新的注入面，不能用来放松安全边界）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');

const scenario = rp.SCENARIOS[0];
const PREF = '我喜欢温柔又带点独占欲的 TA；剧情多一些日常互动；不要再发这个气息了。';
/** 不含禁忌信号的偏好：用来断言「块的最末尾」时，末尾正好是偏好原文本身 */
const PREF_PLAIN = '我喜欢温柔又带点独占欲的 TA；剧情多一些日常互动。';

test('偏好块：三语齐全，标题都是「最高优先级」，并显式声明冲突时以用户偏好为准', () => {
  const zh = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF });
  const tw = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh-TW', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF });
  const en = rp.composeRoleplaySystem({ sys: 'S', lang: 'en', style: 'immersive', adult: false, taskInstr: 'T', userPreference: 'I like a gentle TA.' });

  assert.ok(zh.includes('【剧情偏好 · 最高优先级】'), 'zh 缺偏好块标题');
  assert.ok(zh.includes('一律以用户偏好为准'), 'zh 缺优先级声明，压不住上文那 200 条规则');
  assert.ok(tw.includes('【劇情偏好 · 最高優先級】'), 'zh-TW 未转繁体：' + tw.slice(-200));
  assert.ok(en.includes('【Story preferences \u00b7 HIGHEST PRIORITY】') && en.includes('the player\u2019s preferences win'), 'en 缺优先级声明');
});

test('偏好块：繁简不混写（zh 无繁体残留 / zh-TW 无简体残留）', () => {
  const zh = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF });
  const tw = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh-TW', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF });
  // 繁简同形字不参与判定，只挑几组确定不同的
  for (const bad of ['劇情', '優先', '用戶', '邊界']) {
    assert.ok(!zh.includes(bad), `zh 出现繁体字「${bad}」`);
  }
  for (const bad of ['剧情', '优先', '用户', '边界']) {
    assert.ok(!tw.includes(bad), `zh-TW 出现简体字「${bad}」`);
  }
});

test('偏好块：安全兜底三语都在（偏好是自由文本 → 不得用来放松安全与内容边界）', () => {
  const zh = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh', style: 'immersive', adult: true, taskInstr: 'T', userPreference: PREF });
  const en = rp.composeRoleplaySystem({ sys: 'S', lang: 'en', style: 'immersive', adult: true, taskInstr: 'T', userPreference: 'I like a gentle TA.' });
  assert.ok(zh.includes('以安全边界为准'), 'zh 缺「与安全边界冲突时以边界为准」');
  assert.ok(zh.includes('不改变你扮演的角色身份'), 'zh 缺「不得改角色身份」');
  assert.ok(zh.includes('不是剧情内容'), 'zh 缺「不要把偏好写进正文」（否则模型会在正文里复述偏好）');
  assert.ok(en.includes('the boundaries win'), 'en 缺安全兜底');
  assert.ok(en.includes('not story content'), 'en 缺「不要把偏好写进正文」');
});

test('位置＝权重：有偏好时偏好块在 system 最末尾，且只注入一次', () => {
  const discipline = rp.buildTurnDisciplineBlock('zh', 'immersive', true);
  const composed = rp.composeRoleplaySystem({
    sys: '【人设】前缀', lang: 'zh', style: 'immersive', adult: true, taskInstr: '【任务指令】继续剧情',
    userPreference: PREF_PLAIN,
  });
  assert.ok(composed.endsWith(PREF_PLAIN), '偏好原文不在最末尾，位置错了就压不住上文，等于回到「配了没生效」');
  const header = '【剧情偏好 · 最高优先级】';
  assert.strictEqual(composed.indexOf(header), composed.lastIndexOf(header), '偏好块被重复注入');
  assert.ok(composed.indexOf('【任务指令】') < composed.indexOf(header), '偏好块必须在任务指令之后');
  assert.ok(composed.indexOf('【成人模式') < composed.indexOf(header), '偏好块必须在成人块之后，用户偏好要压得住「角色更主动」这类条款');
  assert.ok(composed.indexOf(discipline) < composed.indexOf(header), '偏好块必须在回合纪律之后');
  assert.ok(!composed.endsWith(discipline), '有偏好时纪律块不该还是最后一段');

  // 有禁忌条款时：禁忌清单排在偏好原文之后（越靠后权重越高）
  const withTaboo = rp.composeRoleplaySystem({
    sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF,
  });
  assert.ok(withTaboo.indexOf('【必须避免】') > withTaboo.indexOf('【用户偏好原文】'), '禁忌清单必须在偏好原文之后');
  assert.ok(withTaboo.endsWith('不要再发这个气息了'), '禁忌清单必须收在最末');
});

test('没写偏好时：不注入空标题，纪律块照旧是最后一段', () => {
  for (const userPreference of [undefined, '', '   ']) {
    const composed = rp.composeRoleplaySystem({
      sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference,
    });
    assert.ok(!composed.includes('【剧情偏好'), '空偏好不该注入偏好块：' + JSON.stringify(userPreference));
    assert.ok(composed.endsWith(rp.buildTurnDisciplineBlock('zh', 'immersive', false)), '无偏好时纪律块仍应是最末');
  }
});

test('回合纪律块：有偏好时显式让位（两份「最高优先级」不打架）', () => {
  for (const lang of ['zh', 'zh-TW', 'en']) {
    const withPref = rp.buildTurnDisciplineBlock(lang, 'immersive', true);
    const without = rp.buildTurnDisciplineBlock(lang, 'immersive', false);
    assert.notStrictEqual(withPref, without, `${lang}: 让位条款没生效`);
    assert.ok(without.length < withPref.length, `${lang}: 让位条款三语缺一`);
  }
  assert.ok(rp.buildTurnDisciplineBlock('zh', 'immersive', true).includes('以它为准'), 'zh 缺让位条款');
  assert.ok(rp.buildTurnDisciplineBlock('en', 'immersive', true).includes('it wins over this section'), 'en 缺让位条款');
  // 纪律块原有的优先级声明与承接/复读底线不能因为让位而丢
  const zh = rp.buildTurnDisciplineBlock('zh', 'immersive', true);
  assert.ok(zh.includes('一律以本节为准') && zh.includes('先接住用户') && zh.includes('禁止复用你最近两轮写过的整句'));
});

test('buildSystemPrompt 不再把偏好塞回中段（旧契约回归会静默变成「配了没生效」）', () => {
  const origWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args: any[]) => { warns.push(args.join(' ')); };
  try {
    const prompt = rp.buildSystemPrompt(scenario, 'zh', undefined, undefined, PREF, 'immersive', false);
    assert.ok(!prompt.includes('【剧情偏好'), '偏好块又出现在 buildSystemPrompt 里了');
    assert.ok(!prompt.includes('不要再发这个气息了'), '偏好原文又出现在中段了');
    assert.ok(warns.some((w) => w.includes('buildSystemPrompt')), '传了非空偏好却没告警，静默忽略最难排查');
  } finally {
    console.warn = origWarn;
  }
  // 不传偏好时不该有告警噪音
  const clean = rp.buildSystemPrompt(scenario, 'zh');
  assert.ok(!clean.includes('【剧情偏好'));
});

test('禁忌清单：从偏好里摘出「不要／别再」条款，放在偏好块最末', () => {
  const composed = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference: PREF });
  const avoidAt = composed.indexOf('【必须避免】');
  assert.ok(avoidAt > 0, '没摘出禁忌清单，「不要再发这个气息了」这类要求最容易漏');
  assert.ok(composed.includes('不要再发这个气息了'), '真实案例那条禁忌没进清单');
  // 注意用 lastIndexOf：这条禁忌在偏好原文里也出现一次，indexOf 会命中原文那一处
  assert.ok(composed.lastIndexOf('不要再发这个气息了') > avoidAt, '禁忌条目应在标题之后');

  const en = rp.composeRoleplaySystem({
    sys: 'S', lang: 'en', style: 'immersive', adult: false, taskInstr: 'T',
    userPreference: "I like a gentle TA. Don't reuse that 'breath' line ever again.",
  });
  assert.ok(en.includes('[MUST AVOID]'), 'en 缺禁忌清单');
  assert.ok(en.includes('breath'), 'en 禁忌条目没进清单');
});

test('禁忌清单：不误抽（「特别」「不想」以外的正向偏好不能变成假禁忌）', () => {
  const forward = rp.composeRoleplaySystem({
    sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T',
    userPreference: '特别想要多一些日常互动，越细腻越好。',
  });
  assert.ok(!forward.includes('【必须避免】'), '「特别」被误当成禁忌信号了');
  // 「不想」是合法禁忌信号，但只有它出现时才该有清单
  const negative = rp.composeRoleplaySystem({
    sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T',
    userPreference: '我不想看虐的剧情。',
  });
  assert.ok(negative.includes('【必须避免】') && negative.includes('我不想看虐的剧情'), '「不想」类禁忌应被摘出');
});

test('偏好原文过长：块内截断到 2000 字（路由已截一次，这里兜直接调用方）', () => {
  // 哨兵放在第 4500 字处：没截断就一定看得见
  const huge = '温柔一点。'.repeat(900) + '必须删掉的哨兵' + '结尾补足。'.repeat(100);
  const composed = rp.composeRoleplaySystem({ sys: 'S', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'T', userPreference: huge });
  const prefAt = composed.indexOf('【用户偏好原文】');
  assert.ok(prefAt > 0);
  assert.ok(!composed.includes('必须删掉的哨兵'), '超过 2000 字的部分没被截断，system 会被撑爆');
  assert.ok(composed.includes('温柔一点。'), '截断过头，偏好正文整个丢了');
  assert.ok(composed.slice(prefAt).length < 3000, '偏好段仍然过长：' + composed.slice(prefAt).length);
});

test('候选建议路径同源：偏好块同样钉在最末（输出格式由 jsonMode 兜底，不靠位置）', () => {
  const sys = rp.buildSuggestSystemPrompt({
    lang: 'zh', aiName: '甲', aiDesc: 'd', userName: '乙', userDesc: 'd',
    background: 'b', opening: 'o', rules: 'r', userPreference: PREF,
  });
  assert.ok(sys.includes('【剧情偏好 · 最高优先级】'), '建议路径缺偏好块');
  assert.ok(sys.endsWith('不要再发这个气息了'), '建议路径的偏好块不在最末');
  const sysEmpty = rp.buildSuggestSystemPrompt({
    lang: 'zh', aiName: '甲', aiDesc: 'd', userName: '乙', userDesc: 'd',
    background: 'b', opening: 'o', rules: 'r',
  });
  assert.ok(!sysEmpty.includes('【剧情偏好'), '没写偏好时不该注入空块');
});

test('自建剧本路径（带字体指令）也走同一顺序', () => {
  const composed = rp.composeRoleplaySystem({
    sys: '【自建人設】', lang: 'zh-TW', style: 'classic', adult: false, taskInstr: '【任務指令】',
    langHint: '【字體指令】必須用繁體中文輸出', userPreference: PREF_PLAIN,
  });
  // zh-TW 下偏好原文会同整块一起转繁体（沿用旧实现 `toZhTw(pref)` 的口径），所以末尾是繁体版
  assert.ok(composed.endsWith('劇情多一些日常互動。'), '自建剧本路径偏好块不在最末：' + composed.slice(-60));
  assert.ok(composed.indexOf('【字體指令】') < composed.indexOf('【劇情偏好 · 最高優先級】'));
});
