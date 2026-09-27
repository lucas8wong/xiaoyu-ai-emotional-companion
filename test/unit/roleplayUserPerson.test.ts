/**
 * 剧情「用户角色人称」硬规则（2026-09-20）
 *
 * 为什么需要这组断言：规则块对 **AI 角色**明确要求「严格遵循第三人称写作格式」，对**用户角色**
 * 却一个字都没规定（权限条款 10.4 只管「不许替用户行动/说话/揣测内心」，不管语法人称）。
 * 于是模型自己猜，线上真实结果是：
 *   · 官方剧本 49 段会话 / 768 个 AI 轮次里，9 轮 / 5 段出现「同一条回复里第二人称『你』
 *     与角色名指同一个人」（取证 `temp/rp-pref-audit/scan-tp2.mts`）；
 *   · 自建剧本没有用户角色名字段，模型**自行起名**（《民国背德》被写成「林清缇」，
 *     而该剧本结构里根本没有这个名字，用户也从没设过）。
 * 这组断言钉三件事：三语都在、无名时**照样注入**、且必须落在所有叙事/成人路径上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rp: any = await import('../../api/services/roleplay.js');
const pm: any = await import('../../api/services/prompts.js');

test('人称规则：三语齐备，且点名「用你指代用户角色」', () => {
  const zh = pm.buildUserPersonDirective('zh', '林晚棠');
  assert.ok(zh.includes('一律用「你」'), 'zh 缺核心要求：' + zh.slice(0, 120));
  assert.ok(zh.includes('不要用「他／她」'), 'zh 没禁第三人称');
  assert.ok(zh.includes('名能出现在**台词里**') || zh.includes('名字只能出现在'), 'zh 没说清名字只能出现在台词里');
  const tw = pm.buildUserPersonDirective('zh-TW', '林晚棠');
  assert.ok(tw.includes('一律用「你」'), 'zh-TW 未保留核心要求');
  assert.ok(!tw.includes('用户角色一律'), 'zh-TW 没转繁体（出现简体原句）');
  const en = pm.buildUserPersonDirective('en', 'Lin Wantang');
  assert.ok(en.includes('ALWAYS "you"'), 'en 缺核心要求：' + en.slice(0, 120));
  assert.ok(en.includes('never "he"/"she"'), 'en 没禁第三人称');
});

test('人称规则：给了名字就写进规则（让模型知道该名字属于用户角色）', () => {
  assert.ok(pm.buildUserPersonDirective('zh', '林晚棠').includes('林晚棠'), '有名字时没写进规则');
  assert.ok(pm.buildUserPersonDirective('en', 'Lin').includes('Lin'), 'en 有名字时没写进规则');
});

test('人名规则：没给名字时也**必须**注入，并显式禁止替用户起名（这是真实事故场景）', () => {
  const zh = pm.buildUserPersonDirective('zh', undefined);
  const zhEmpty = pm.buildUserPersonDirective('zh', '   ');
  assert.ok(zh.length > 0, '无名时整块被丢掉了（正是模型自行起名的场景）');
  assert.ok(zh.includes('绝对不许你替 TA 编一个名字'), '无名时没禁止起名：' + zh);
  assert.strictEqual(zhEmpty, zh, '空白名字应与无名同口径');
  const en = pm.buildUserPersonDirective('en', '');
  assert.ok(en.includes('do NOT invent one'), 'en 无名时没禁止起名：' + en);
});

test('人称规则：不把占位词「对方」当成用户角色名', () => {
  // pickRulesText 内部给 classic 模板填的是「对方」；真实 userName 为空时必须按「无名」处理
  const txt = rp.buildSystemPrompt(
    rp.SCENARIOS.find((s: any) => s.id === 'lutingyuan-shenyan') || rp.SCENARIOS[0],
    'zh', undefined, undefined, undefined, 'classic', false,
  );
  assert.ok(txt.includes('一律用「你」'), 'classic 规则块里没有人称条款');
  assert.ok(!/角色名是「对方」/.test(txt), '把占位词「对方」当成了用户角色名');
});

test('人称规则：所有叙事风格 × 语言 × 成人开关都注入（不能只挂一条路径）', () => {
  const scen = rp.SCENARIOS[0];
  for (const style of ['classic', 'immersive'] as const) {
    for (const lang of ['zh', 'zh-TW', 'en'] as const) {
      for (const adult of [false, true]) {
        const txt = rp.buildSystemPrompt(scen, lang, '容与', '林晚棠', undefined, style, adult);
        const mark = lang === 'en' ? 'how to refer to the user' : lang === 'zh-TW' ? '用戶角色怎麼稱呼' : '用户角色怎么称呼';
        assert.ok(txt.includes(mark), `缺失：style=${style} lang=${lang} adult=${adult}`);
      }
    }
  }
});

test('人称规则：与权限条款 10.4 分工不重复（10.4 管权限、本块管人称）', () => {
  const txt = rp.buildSystemPrompt(rp.SCENARIOS[0], 'zh', '容与', '林晚棠', undefined, 'classic', false);
  assert.ok(txt.includes('禁止替用户'), '既有权限条款 10.4 被破坏');
  assert.ok(txt.includes('一律用「你」'), '人称条款缺失');
});
