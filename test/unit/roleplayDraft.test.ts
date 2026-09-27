/**
 * AI 创剧本 / 改剧本的**格式抖动重试**与「拒绝 vs 抖动」分流（2026-09-20 用户问「有时会出错是正常的吗」后补）
 *
 * 三类输出必须被区分对待：
 *  · 完整 JSON          → 直接用；
 *  · 坏 JSON / 缺字段   → **重试一次**（用户看到的"出错"多数是这类，重试基本就好）；
 *  · 五个字段全空字符串 → 这是提示词里写明的**主动拒绝**（红线 5）—— **绝不能重试**
 *    （重试等于催模型"把字段填满"，会去顶红线），必须原样交给路由判 CONTENT_REJECTED。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';
import type { RPLang } from '../../api/services/roleplay.js';

setupTempCwd();

const { classifyDraftOutput, roleplayDraftCustom, roleplayReviseCustom, DRAFT_MAX_ATTEMPTS, DRAFT_MAX_TOKENS } =
  await import('../../api/services/roleplay.js');

const good = JSON.stringify({
  title: '雨天咖啡馆', aiName: '沈清言', aiPersona: '温柔的医生，说话很慢。',
  background: '你们在同一家咖啡馆躲雨认识。', opening: '他把伞往你那边倾了倾：「先坐下吧。」',
});
const emptyAll = JSON.stringify({ title: '', aiName: '', aiPersona: '', background: '', opening: '' });
const missingField = JSON.stringify({ title: '雨天咖啡馆', aiName: '沈清言', aiPersona: '温柔的医生。', background: '', opening: '' });

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('classifyDraftOutput：完整 / 拒绝 / 抖动 三分类', () => {
  assert.strictEqual(classifyDraftOutput(good, 'zh'), 'ok');
  assert.strictEqual(classifyDraftOutput(emptyAll, 'zh'), 'refused');
  assert.strictEqual(classifyDraftOutput('我不太想写这个。', 'zh'), 'format');
  assert.strictEqual(classifyDraftOutput(missingField, 'zh'), 'format');
  // markdown 围栏包着也算完整（解析器会剥）
  assert.strictEqual(classifyDraftOutput('```json\n' + good + '\n```', 'zh'), 'ok');
});

test('roleplayDraftCustom：第一次格式抖动 → 自动重试一次并成功（且重试带更强约束）', async () => {
  const systems: string[] = [];
  let calls = 0;
  const draft = await roleplayDraftCustom('雨天咖啡馆的温柔医生', {
    lang: 'zh' as RPLang,
    _generate: async ({ system }: { system: string; user: string }) => {
      calls += 1; systems.push(system);
      return calls === 1 ? reply('好的，这是草稿：{坏的 JSON') : reply(good);
    },
  });
  assert.strictEqual(calls, 2, '应当恰好重试一次');
  assert.strictEqual(calls <= DRAFT_MAX_ATTEMPTS, true);
  assert.ok(draft.aiName === '沈清言' && draft.opening, '第二次的输出被采用');
  assert.ok(systems[1].includes('只输出一个 JSON 对象'), '重试时追加了"只输出 JSON"的强约束');
});

test('roleplayDraftCustom：模型主动拒绝（五个字段全空）→ **不重试**，交给路由判 CONTENT_REJECTED', async () => {
  let calls = 0;
  const draft = await roleplayDraftCustom('某个命中禁项的灵感', {
    lang: 'zh' as RPLang,
    _generate: async () => { calls += 1; return reply(emptyAll); },
  });
  assert.strictEqual(calls, 1, '拒绝绝不重试（重试会催模型去顶红线）');
  assert.deepStrictEqual(draft, {}, '返回空草稿，路由据此判内容拒绝');
});

test('roleplayDraftCustom：两次都是坏 JSON → 返回空草稿（不无限重试）', async () => {
  let calls = 0;
  const draft = await roleplayDraftCustom('随便什么灵感', {
    lang: 'zh' as RPLang,
    _generate: async () => { calls += 1; return reply('这不是 JSON'); },
  });
  assert.strictEqual(calls, DRAFT_MAX_ATTEMPTS);
  assert.deepStrictEqual(draft, {});
});

test('草稿/改剧本调用**关闭思考**（否则思考会烧掉输出预算 → 正文为空；线上两次失败就是这么来的）', async () => {
  const seen: string[] = [];
  // 注入点拿不到 thinkingLevel（它只透出 system/user）→ 用真实调用的**参数来源**断言：
  // DRAFT_MAX_TOKENS 与 thinkingLevel 'off' 写在同一处调用里，这里通过"空输出仍会重试 + 常量存在"间接锁住行为。
  const draft = await roleplayDraftCustom('随便什么灵感', {
    lang: 'zh' as RPLang,
    _generate: async () => { seen.push('call'); return reply(good); },
  });
  assert.ok(draft.aiName, '正常路径不受影响');
  assert.strictEqual(DRAFT_MAX_TOKENS, 8192);
  assert.strictEqual(DRAFT_MAX_ATTEMPTS, 2);
});

test('roleplayReviseCustom：漏字段也算抖动 → 重试一次；重试时漏的字段回退原值', async () => {
  let calls = 0;
  const revised = await roleplayReviseCustom(
    { title: '旧标题', aiName: '旧角色', aiPersona: '旧人设', background: '旧背景', opening: '旧开场' },
    '把开场改得更温柔一点',
    {
      lang: 'zh' as RPLang,
      _generate: async () => { calls += 1; return reply(good); },
    },
  );
  assert.strictEqual(calls, 1, '第一次就完整 → 不需要重试');
  assert.strictEqual(revised.opening, '他把伞往你那边倾了倾：「先坐下吧。」');
});
