import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';
setupTempCwd();
const { getScenario, getScenarioInfo, buildSystemPrompt } = await import('../../api/services/roleplay.js');
const story = getScenario('xiaoyan-qianqian')!;

test('Qianqian is eighteen in every story language and Xiao Yan is five years older', () => {
  assert.equal(story.zh.user.age, '18岁');
  assert.equal(story.en.user.age, '18');
  assert.equal(story.zh.ai.age, '23岁');
  assert.equal(story.en.ai.age, '23');
  for (const lang of ['zh', 'zh-TW', 'en'] as const) {
    const info = getScenarioInfo(story.id, lang)! as any;
    assert.match(info.user.age, /18/);
    assert.match(info.ai.age, /23/);
  }
});

test('the romantic timeline starts in adulthood and memories stay non-romantic', () => {
  assert.match(story.zh.background, /已满十八岁/);
  assert.match(story.en.background, /now eighteen/);
  assert.match(story.zh.ai.personality, /童年时他只把你当作需要照顾的玩伴/);
  assert.match(story.en.ai.personality, /In childhood he cared for you only as a young playmate/);
  assert.doesNotMatch(story.zh.ai.personality + story.zh.background, /及笄|他十六岁/);
  assert.match(story.zh.openingScene, /十八岁这一年的九月/);
  assert.match(story.en.openingScene, /the year you turn eighteen/);
  for (const lang of ['zh', 'zh-TW', 'en'] as const) {
    const prompt = buildSystemPrompt(story, lang, undefined, undefined, undefined, 'immersive', true);
    assert.doesNotMatch(prompt, /16岁|Female, 16|twenty-two/);
    assert.match(prompt, /18|十八/);
    assert.match(prompt, /双方自愿|雙方自願|mutual consent/);
  }
});
