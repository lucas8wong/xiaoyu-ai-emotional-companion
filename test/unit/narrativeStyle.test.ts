/**
 * 「叙事模式」单一来源（B 方案，2026-09-25）的**不变量**测试
 *
 * 背景：经典/沉浸的差异原先散在 5 处各写一遍，实测出两个坏结果（`temp/_style-conflict2.mts` 取证）：
 *   ① **互串 + 字数打架**：成人块的「推进节（亲密）」没分档 ⇒ 经典档同时收到
 *      「正文 400–700 字，亲密同样受此区间约束」与「亲密场景正文 250–450 字」，
 *      还被要求「以身体动作与感官描写为主体」（那是沉浸档的语体）；
 *   ② **悬空引用**：非成人档的沉浸档写着「按成人模式的亲密档写足（250–450 字）」，
 *      而成人块**不在**那个 prompt 里；同时经典档在非成人档**一条篇幅指令都没有**。
 * 抽成 `api/services/narrativeStyle.ts` 之后，这些不变量必须一直被钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');
const ns: any = await import('../../api/services/narrativeStyle.js');

const scenario = rp.getScenario((rp.listScenarios('zh') as any[])[0].id);

/** 按真实组装顺序拼出「模型真正收到的那份 prompt」 */
function prompt(lang: 'zh' | 'zh-TW' | 'en', style: 'classic' | 'immersive', adult: boolean): string {
  const sys = rp.buildSystemPrompt(scenario, lang, undefined, undefined, undefined, style, adult);
  const taskInstr = rp.roleplayTaskInstr(style, scenario.zh.ai.name, lang, { beatPlan: adult });
  return rp.composeRoleplaySystem({
    sys, lang, style, adult, taskInstr,
    innerMonologueEnabled: true, userPreference: '', avoidBlock: '',
  }) as string;
}

test('档案本身：两个模式的档位齐全且互相不同（篇幅 / 语体 / 收尾 / 亲密档 / 续写带）', () => {
  const c = ns.narrativeProfile('classic');
  const i = ns.narrativeProfile('immersive');
  assert.strictEqual(c.register, 'literary');
  assert.strictEqual(i.register, 'colloquial');
  assert.strictEqual(c.ending, 'hook');
  assert.strictEqual(i.ending, 'follow');
  assert.notStrictEqual(c.followPlayerLength, i.followPlayerLength);
  assert.notStrictEqual(c.relaxLengthCaps, i.relaxLengthCaps, '只有对话笔法需要物理摘掉篇幅压制条款');
  assert.notDeepStrictEqual(c.dailyZh, i.dailyZh);
  assert.notDeepStrictEqual(c.intimateZh, i.intimateZh);
  assert.notDeepStrictEqual(c.continuationZh, i.continuationZh);
  // 未知值一律按 immersive（与改造前的归一化口径一致，避免静默改变线上行为）
  assert.deepStrictEqual(ns.narrativeProfile(undefined), i);
  assert.deepStrictEqual(ns.narrativeProfile('nonsense'), i);
});

test('单一来源：续写篇幅带直接取自档案（这里写死的数字 = 档案里的数字）', () => {
  for (const style of ['classic', 'immersive'] as const) {
    const p = ns.narrativeProfile(style);
    assert.deepStrictEqual(rp.roleplayTurnLengthBand('zh', style), p.continuationZh, style + ' zh 续写带与档案不一致');
    assert.deepStrictEqual(rp.roleplayTurnLengthBand('en', style), p.continuationEnChars, style + ' en 续写带与档案不一致');
  }
  assert.strictEqual(rp.roleplayTurnLengthBand('zh', 'classic').maxTotal, 700);
  assert.strictEqual(rp.roleplayTurnLengthBand('zh', 'immersive').maxTotal, 450);
});

test('两种模式在**非成人档**都拿到了明确篇幅（经典以前一条都没有）', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const style of ['classic', 'immersive'] as const) {
      const t = prompt(lang, style, false);
      assert.ok(/【篇幅 · 硬要求】|\[Length · hard rule\]/.test(t), `${lang}/${style} 缺篇幅硬要求段`);
      const daily = ns.lengthPhrase(lang, style, 'daily');
      const intimate = ns.lengthPhrase(lang, style, 'intimate');
      assert.ok(t.includes(daily), `${lang}/${style} 缺日常档篇幅（${daily}）`);
      assert.ok(t.includes(intimate), `${lang}/${style} 缺亲密档篇幅（${intimate}）`);
    }
  }
});

test('没有悬空引用：非成人档不得引用「成人模式 / adult-mode block」的档位', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const style of ['classic', 'immersive'] as const) {
      const t = prompt(lang, style, false);
      assert.ok(!/成人模式的亲密档/.test(t), `${lang}/${style} 仍引用不存在的成人档（zh）`);
      assert.ok(!/adult-mode block/.test(t), `${lang}/${style} 仍引用不存在的成人档（en）`);
    }
  }
});

test('不互串：成人档里「以身体动作为主体」只属于沉浸档，经典档保持书面长句', () => {
  const clZh = prompt('zh', 'classic', true);
  const imZh = prompt('zh', 'immersive', true);
  assert.ok(imZh.includes('以身体动作与感官描写为主体'), '沉浸档缺亲密语体反转');
  assert.ok(!clZh.includes('以身体动作与感官描写为主体'), '经典档被塞进了沉浸档语体（互串复发）');
  assert.ok(clZh.includes('保持书面化的长句铺陈与镜头感'), '经典档的亲密节应保持书面笔法');

  const clEn = prompt('en', 'classic', true);
  const imEn = prompt('en', 'immersive', true);
  assert.ok(imEn.includes('body action and sensory detail carry the'), 'immersive EN 缺语体反转');
  assert.ok(!clEn.includes('body action and sensory detail carry the'), 'classic EN 被塞进 immersive 语体（互串复发）');
  assert.ok(clEn.includes('cinematic eye'), 'classic EN 亲密节应保持电影运镜笔法');
});

test('不打架：同一份 prompt 里亲密档只有一个区间（经典 400–700，沉浸 250–450）', () => {
  const clZh = prompt('zh', 'classic', true);
  // 经典档允许出现 400–700（两处：第一节 + 亲密节），但**不允许**出现沉浸档的 250–450
  assert.ok(clZh.includes('400–700 字'), '经典档缺 400–700 字档位');
  assert.ok(!clZh.includes('250–450 字'), '经典档里混进了沉浸档的亲密区间（字数打架复发）');
  const imZh = prompt('zh', 'immersive', true);
  assert.ok(imZh.includes('250–450 字'), '沉浸档缺亲密档位');
  assert.ok(!imZh.includes('400–700 字'), '沉浸档里混进了经典档区间');
});

test('收尾方式按档案走：经典要求钩子、沉浸要求先接住用户（任务指令与纪律块一致）', () => {
  const clTask = rp.roleplayTaskInstr('classic', '小愈', 'zh');
  const imTask = rp.roleplayTaskInstr('immersive', '小愈', 'zh');
  assert.ok(clTask.includes('每轮结尾必须留一个互动钩子'), '经典档任务指令缺钩子要求');
  assert.ok(!imTask.includes('每轮结尾必须留一个互动钩子'), '沉浸档不该要求每轮留钩子');
  const clDis = rp.buildTurnDisciplineBlock('zh', 'classic');
  const imDis = rp.buildTurnDisciplineBlock('zh', 'immersive');
  assert.ok(!clDis.includes('长度跟人走') && imDis.includes('长度跟人走'), '纪律块的分档反了');
  assert.ok(clDis.includes('不要换场') && imDis.includes('不要另起新话题'), '纪律块第 2 条分档反了');
});

/**
 * 标点硬要求（2026-09-25）：治「一大段没有标点」。
 *
 * 根因是 `frequency_penalty`（中文标点是最频繁 token，被按次数惩罚 ⇒ 模型绕开标点，实测最长 265 字），
 * 已把剂量从 0.6 降到 0.1；这里钉的是**第二道保险**——即便有人把惩罚调回去、或换了托管模型，
 * prompt 里也必须一直有这条明文要求。为什么不能只靠提示词：实测单独加它只把 265 压到 81，
 * 两道一起才到 29（`temp/_punct-verify.mts`）。
 */
test('标点硬要求：三语言 × 两模式 × 成人/官方 都必须注入（含缺过一次的 zh-TW）', () => {
  for (const lang of ['zh', 'zh-TW', 'en'] as const) {
    for (const style of ['classic', 'immersive'] as const) {
      for (const adult of [false, true]) {
        const t = prompt(lang, style, adult);
        assert.ok(
          /【标点 · 硬要求】|【標點 · 硬要求】|\[Punctuation · hard rule\]/.test(t),
          `${lang}/${style}/${adult ? '成人' : '官方'} 缺标点硬要求段`,
        );
      }
    }
  }
  // 繁体走的是「先写简体、再 toZhTw」这条路，最容易整段漏掉（本用例就是因为它漏过一次才加的）
  const tw = prompt('zh-TW', 'classic', true);
  assert.ok(tw.includes('標點 · 硬要求'), 'zh-TW 的标点段没跟着转繁体 ⇒ 该段很可能是拼接顺序漏了');
  assert.ok(!tw.includes('【标点'), 'zh-TW 里混进了简体标点段');
});

test('标点硬要求：要求「叙述」也断句，别只覆盖对话引号；指令自身不能是没标点的长串', () => {
  const zh = rp.buildPunctuationDirective('zh');
  assert.ok(zh.includes('绝不把超过两个小句连成一长串不打断的文字'), 'zh 缺「不许长串」的明文');
  assert.ok(zh.includes('叙述'), 'zh 没点明叙述部分同样要断句（引号规范只管台词，这是既有缺口）');
  const en = rp.buildPunctuationDirective('en');
  assert.ok(/narration as much as to dialogue/.test(en), 'en 没说清覆盖叙述');
  // 指令自己不能自相矛盾：要求别人断句的文字本身不能是长串
  const PUNCT = /[。！？；：，、…—～·「」『』“”‘’（）《》〈〉【】〔〕\s.,!?;:'"()[\]{}<>~\-_/\\|]/;
  for (const t of [zh, en]) {
    let best = 0, cur = 0;
    for (const ch of t) { if (PUNCT.test(ch)) { cur = 0; continue; } cur += 1; if (cur > best) best = cur; }
    assert.ok(best <= 26, `标点指令自身含 ${best} 字无标点长串（自相矛盾）`);
  }
});
