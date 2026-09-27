/**
 * 「回合纪律」块 + system prompt 组装顺序的守卫测试（2026-09-17）
 *
 * 背景（用户反馈）：剧情模式里 AI 连续四轮收尾几乎逐字相同
 *   「来，替朕揉揉这胸口。力道要匀，莫要拘谨。朕想让你仔细感受，这气息的流转，是否比方才更顺遂些？」
 * 根因是三条正向力在逼模型「每轮自己开路」：
 *   ① V2 规则末条「由你先引出话题」；② 沉浸叙事收尾指令「每轮由你主动引出话题」；
 *   ③ 成人块第三节「角色要更主动…不必每次都等用户先开口」。
 * 用户只回「陛下…」时，模型没有新素材，只能把上一轮收尾重放。
 *
 * 修法 = 改这三处 + 新增优先级最高、位置最末的「回合纪律」块。
 * 这组断言钉死两件最容易在后续编辑中悄悄失效的事：
 *   1. 纪律块真的存在、三语齐全、按叙事风格分档；
 *   2. 它**永远在 system 的最后一段**（顺序＝权重，位置错了等于白写）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');

const scenario = rp.SCENARIOS[0];

test('回合纪律块：三语齐全，且显式声明「冲突时以本节为准」', () => {
  const zh = rp.buildTurnDisciplineBlock('zh', 'immersive');
  const tw = rp.buildTurnDisciplineBlock('zh-TW', 'immersive');
  const en = rp.buildTurnDisciplineBlock('en', 'immersive');

  assert.ok(zh.includes('【回合纪律 · 最高优先级】'), 'zh 缺标题');
  assert.ok(zh.includes('一律以本节为准'), 'zh 缺优先级声明 —— 压不住上文那三条正向力');
  assert.ok(en.includes('HIGHEST PRIORITY') && en.includes('this section wins'), 'en 缺优先级声明');
  assert.ok(tw.includes('【回合紀律 · 最高優先級】'), 'zh-TW 未转繁体：' + tw.slice(0, 40));

  // 承接用户 = 本轮改动的核心语义，三语都要在
  assert.ok(zh.includes('先接住用户'));
  assert.ok(tw.includes('先接住用戶'));
  assert.ok(en.includes('React to the player first'));

  // 不复读 = 老问题（软话埋在规则中段）的硬版本
  assert.ok(zh.includes('禁止复用你最近两轮写过的整句'), 'zh 缺硬化的反复读条款');
  assert.ok(en.includes('never reuse a whole sentence'), 'en 缺硬化的反复读条款');
});

test('回合纪律块：繁简不混写（zh 无繁体残留 / zh-TW 无简体残留）', () => {
  const zh = rp.buildTurnDisciplineBlock('zh', 'immersive');
  const tw = rp.buildTurnDisciplineBlock('zh-TW', 'immersive');
  // 繁简同形字不参与判定，只挑几组确定不同的
  assert.ok(!zh.includes('紀律') && !zh.includes('優先'), 'zh 出现繁体字');
  assert.ok(!tw.includes('纪律') && !tw.includes('优先'), 'zh-TW 出现简体字');
});

test('回合纪律块：按叙事风格分档（沉浸有「长度跟人走」，经典没有）', () => {
  const im = rp.buildTurnDisciplineBlock('zh', 'immersive');
  const cl = rp.buildTurnDisciplineBlock('zh', 'classic');
  assert.ok(im.includes('长度跟人走'), '沉浸档缺长度跟随条款');
  assert.ok(!cl.includes('长度跟人走'), '经典档有 400–700 字要求，不该被长度跟随条款压掉');
  assert.ok(cl.includes('不要换场'), '经典档的「用户没推进」条款应落在换场/事件线上');
  assert.notStrictEqual(im, cl);
});

test('回合纪律块：亲密场景的两处豁免（否则它会反过来压死 18+ 推进）', () => {
  const im = rp.buildTurnDisciplineBlock('zh', 'immersive');
  assert.ok(im.includes('亲密场景除外'), '缺「用户没推进」条目的亲密豁免');
  assert.ok(im.includes('但亲密推进场景除外') && im.includes('250–450 字'), '缺「长度跟人走」的亲密豁免');
  const en = rp.buildTurnDisciplineBlock('en', 'immersive');
  // 2026-09-25：文案由「按成人模式的亲密档（adult-mode block）」改为**引用本模式的亲密档**——
  // 那句在非成人档是悬空引用（成人块不在 prompt 里）。所以断言改成认「本模式的亲密档 + 数字」，
  // 不再绑死旧句子；数字口径来自 narrativeStyle 档案（120–250 words，连字符/短横线都算）。
  assert.ok(/Exception — /.test(en) && /120[–-]250 words/.test(en), 'en 缺亲密豁免（本模式亲密档）');
  assert.ok(!/adult-mode block/.test(en), 'en 不该再引用成人档（那是非成人档下的悬空引用）');
});

test('roleplayTaskInstr：沉浸收尾不再要求「由你主动引出下一个话题」', () => {
  const zhIm = rp.roleplayTaskInstr('immersive', '小愈', 'zh');
  const enIm = rp.roleplayTaskInstr('immersive', 'Xiaoyu', 'en');
  const zhCl = rp.roleplayTaskInstr('classic', '小愈', 'zh');

  assert.ok(!zhIm.includes('每轮由你主动引出话题'), '旧的正向力条款应已删除');
  assert.ok(zhIm.includes('先接住用户这一轮写的东西'), '应改为先承接用户');
  assert.ok(!enIm.includes('introduce the next beat yourself'), 'en 旧条款应已删除');
  assert.ok(enIm.includes('First react to what the player just wrote'), 'en 应改为先承接用户');
  // 经典叙事的「每轮留钩子」是刻意保留的设计，只加了「先承接」
  assert.ok(zhCl.includes('互动钩子') && zhCl.includes('先接住用户'));

  // 语言归一化不能丢（zh-TW 版必须仍是繁体，且原有断言口径不变）
  const tw = rp.roleplayTaskInstr('immersive', '顧聿深', 'zh-TW');
  assert.ok(tw.includes('繼續劇情') && !tw.includes('继续剧情'));
});

test('V2 规则末条：从「由你先引出话题」改为「用户先、你后」', () => {
  const zh = rp.buildSystemPrompt(scenario, 'zh');
  const en = rp.buildSystemPrompt(scenario, 'en');
  assert.ok(!zh.includes('由你先引出话题'), 'zh 旧条款仍在 —— 会继续把模型推向「自己开路」');
  assert.ok(zh.includes('用户先、你后'), 'zh 新条款缺失');
  assert.ok(!en.includes('You introduce the topic first'), 'en 旧条款仍在');
  assert.ok(en.includes('The player first, you second'), 'en 新条款缺失');
});

test('成人块：新增「主动不等于每轮下指令」的刹车条款', () => {
  const zh = rp.buildUnlimitedModeBlock('zh', 'immersive');
  const en = rp.buildUnlimitedModeBlock('en', 'immersive');
  assert.ok(zh.includes('11b.'), 'zh 缺 11b 刹车条款');
  assert.ok(zh.includes('「主动」不等于每轮都得下指令'));
  assert.ok(en.includes('4d.') && en.includes('does not mean issuing an order every turn'));
});

test('成人模式仍物理移除篇幅压制条款（改了 V2 规则末条后不能失效）', () => {
  const capZh = '每次回复里的场景转换不超过三次。完整的回复不超过四句。';
  // 官方剧本走 pickRulesText：immersive + adult=true 时该条必须被删干净
  const adult = rp.buildSystemPrompt(scenario, 'zh', undefined, undefined, undefined, 'immersive', true);
  const normal = rp.buildSystemPrompt(scenario, 'zh', undefined, undefined, undefined, 'immersive', false);
  assert.ok(!adult.includes(capZh), '成人模式下压制条款没被移除 —— relaxLengthCaps 的短语匹配被改坏了');
  assert.ok(normal.includes(capZh), '非成人模式下不该误删');
  // 新加的「用户先、你后」条款不能被误当成压制条款删掉
  assert.ok(adult.includes('用户先、你后'), '新条款被 relaxLengthCaps 误删');
});

test('回合纪律块 4b「钩子 ≠ 问句」：三语齐全、两种叙事模式都生效（2026-09-18）', () => {
  const im = rp.buildTurnDisciplineBlock('zh', 'immersive');
  const cl = rp.buildTurnDisciplineBlock('zh', 'classic');
  const tw = rp.buildTurnDisciplineBlock('zh-TW', 'immersive');
  const en = rp.buildTurnDisciplineBlock('en', 'immersive');
  const enCl = rp.buildTurnDisciplineBlock('en', 'classic');

  // 4b 是**两种模式共用**的（经典/沉浸只有第 2/5/6 条分档）——这正是「要考虑用户使用的叙事模式」的落点
  for (const [name, text] of [['immersive', im], ['classic', cl]] as const) {
    assert.ok(text.includes('4b. **钩子 ≠ 问句**'), name + ' 档缺 4b 条款');
    assert.ok(text.includes('禁止用征询用户要不要继续的元话语收尾'), name + ' 档缺「元话语」禁令');
    assert.ok(text.includes('绝不连续两轮都以问句收尾'), name + ' 档缺「不连续两轮」要求');
    assert.ok(text.includes('动作、悬念、一句没说完的话'), name + ' 档缺钩子的形态定义');
  }
  assert.ok(tw.includes('鉤子 ≠ 問句') && tw.includes('絕不連續兩輪'), 'zh-TW 未转繁体或 4b 缺失');
  assert.ok(en.includes('4b. **A hook is not a question**'), 'en 缺 4b 条款');
  assert.ok(en.includes('never end two turns in a row on a question'), 'en 缺「不连续两轮」要求');
  assert.ok(enCl.includes('4b. **A hook is not a question**'), 'en 经典档缺 4b');

  // 旧的第 4 条（不许复读）必须仍在，且 4b 排在它之后（顺序＝权重，别被后来的编辑挤到前面）
  assert.ok(im.indexOf('4. 不许复读') < im.indexOf('4b. **钩子 ≠ 问句**'), '4b 应在第 4 条之后');
});

test('经典档任务指令：钩子形态改掉了「一句等你回答的话」，并显式禁掉征询继续（2026-09-18）', () => {
  const zh = rp.roleplayTaskInstr('classic', '小愈', 'zh');
  const zhTw = rp.roleplayTaskInstr('classic', '小愈', 'zh-TW');
  const en = rp.roleplayTaskInstr('classic', 'Xiaoyu', 'en');
  const im = rp.roleplayTaskInstr('immersive', '小愈', 'zh');

  // 改掉的那半句：原文把「一句等你回答的话」列为钩子形态之一，模型于是每轮问一句
  assert.ok(!zh.includes('一句等你回答的话'), '经典档仍在把「问一句」当钩子形态');
  assert.ok(zh.includes('一个等你回应的动作、一处悬念、或一句没说完的话'), '经典档钩子形态未替换');
  assert.ok(zh.includes('钩子不等于提问'), '经典档缺「钩子≠提问」说明');
  assert.ok(zh.includes('不要连续两轮都以问句收尾'), '经典档缺「不连续两轮」要求');
  assert.ok(!en.includes('a line awaiting your answer'), 'en 经典档仍在把问句当钩子形态');
  assert.ok(en.includes('A hook is not a question'), 'en 经典档缺说明');
  assert.ok(zhTw.includes('鉤子不等於提問'), 'zh-TW 未转繁体');

  // 「不完成式收尾」这个产品意图必须保留（2026-08-22 的功能，不能顺手改掉）
  assert.ok(zh.includes('不要把场景写成"结束/无下文"的完成态'), '经典档丢了「不完成式收尾」');
  assert.ok(en.includes('never close the scene into a finished state'), 'en 经典档丢了「不完成式收尾」');

  // 沉浸档本来就不要求留钩子，不该被这次改动牵连
  assert.ok(!im.includes('钩子不等于提问'), '沉浸档不该多出经典档的钩子条款');
});

test('消融开关 RP_ENDING_FORM=0：三处必须一起关（只关一半的消融测的是另一件事）', () => {
  const before = process.env.RP_ENDING_FORM;
  try {
    process.env.RP_ENDING_FORM = '0';
    const zh = rp.buildTurnDisciplineBlock('zh', 'classic');
    assert.ok(!zh.includes('钩子 ≠ 问句'), '4b 条款未被开关关掉');
    assert.ok(zh.includes('不许复读'), '开关不该动到别的条款');
    const zhIm = rp.buildTurnDisciplineBlock('zh', 'immersive');
    assert.ok(!zhIm.includes('钩子 ≠ 问句'), '沉浸档 4b 未被关掉');
    const task = rp.roleplayTaskInstr('classic', '小愈', 'zh');
    assert.ok(task.includes('一句等你回答的话'), '经典档钩子措辞没回到旧版');
    assert.ok(!task.includes('钩子不等于提问'), '经典档仍带新措辞');
    const enTask = rp.roleplayTaskInstr('classic', 'Xiaoyu', 'en');
    assert.ok(enTask.includes('a line awaiting your answer'), 'en 经典档没回到旧版');
    const avoid = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: '（他停下来。）「想跟我多说点吗？」' }]);
    assert.ok(!avoid.includes('【本轮禁止的收尾形态】'), '形态刹车未被关掉');
  } finally {
    if (before === undefined) delete process.env.RP_ENDING_FORM; else process.env.RP_ENDING_FORM = before;
  }
});

test('composeRoleplaySystem：纪律块在写作规则之后；写了偏好时偏好块才是最后一段（顺序＝权重）', () => {
  const sys = '【人设】\n测试用 system 前缀';
  const composed = rp.composeRoleplaySystem({
    sys, lang: 'zh', style: 'immersive', adult: true, taskInstr: '【任务指令】继续剧情',
  });
  const discipline = rp.buildTurnDisciplineBlock('zh', 'immersive');
  /**
   * 2026-09-27：成人档的纪律块有了**自己的分支**（成人模式下不再收窄主动性，见
   * `roleplayAdultInitiative.test.ts`）。所以这里按 adult 取对应变体比对 ——
   * 不变量本身没变（纪律块仍是最后一段），变的是「哪一份纪律块」。
   */
  const disciplineAdult = rp.buildTurnDisciplineBlock('zh', 'immersive', false, true);
  assert.ok(composed.endsWith(disciplineAdult), '回合纪律块不在最末尾 —— 位置错了就压不住上文');
  assert.strictEqual(composed.indexOf(disciplineAdult), composed.lastIndexOf(disciplineAdult), '纪律块重复注入');
  // 顺序：成人块 → 任务指令 → 纪律
  assert.ok(composed.indexOf('【任务指令】') < composed.indexOf(disciplineAdult));
  assert.ok(composed.indexOf('【成人模式') < composed.indexOf('【任务指令】'));
  assert.ok(composed.startsWith(sys), '人设前缀必须仍在最前');

  // 非成人模式：不注入成人块，纪律仍要在最后
  const off = rp.composeRoleplaySystem({
    sys, lang: 'zh', style: 'immersive', adult: false, taskInstr: '【任务指令】继续剧情',
  });
  assert.ok(!off.includes('【成人模式'), '非成人模式不该注入成人块');
  assert.ok(off.endsWith(discipline));

  // 自建剧本路径：字体指令排在纪律块之前，纪律块仍是最后一段
  const custom = rp.composeRoleplaySystem({
    sys, lang: 'zh-TW', style: 'classic', adult: false, taskInstr: '【任務指令】', langHint: '【字體指令】必須用繁體中文輸出',
  });
  const twDiscipline = rp.buildTurnDisciplineBlock('zh-TW', 'classic');
  assert.ok(custom.endsWith(twDiscipline), '自建剧本路径下纪律块不在最后');
  assert.ok(custom.indexOf('【字體指令】') < custom.indexOf(twDiscipline));

  // 英文：纪律块同样在最后（adult=true → 成人分支，见上）
  const en = rp.composeRoleplaySystem({
    sys: 'sys', lang: 'en', style: 'immersive', adult: true, taskInstr: 'task',
  });
  assert.ok(en.endsWith(rp.buildTurnDisciplineBlock('en', 'immersive', false, true)));

  // 2026-09-17：写了「我的偏好」时，偏好块是**新的最后一段**（用户口径：偏好＝最高权重）。
  // 完整不变量见 test/unit/roleplayUserPrefPriority.test.ts。
  const withPref = rp.composeRoleplaySystem({
    sys, lang: 'zh', style: 'immersive', adult: false, taskInstr: '【任务指令】', userPreference: '想要温柔一点',
  });
  assert.ok(withPref.endsWith('想要温柔一点'), '偏好块不在最末 —— 会被纪律块与规则压住');
  assert.ok(withPref.indexOf(rp.buildTurnDisciplineBlock('zh', 'immersive', true)) < withPref.indexOf('想要温柔一点'));
});
