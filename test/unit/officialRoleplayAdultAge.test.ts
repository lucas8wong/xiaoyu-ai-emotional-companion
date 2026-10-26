import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';
setupTempCwd();
const { listScenarios, getScenario, scenarioCast } = await import('../../api/services/roleplay.js');

test('all current official main characters are adults in both source languages', () => {
  const scenarios = listScenarios('zh');
  // The committed official set is 30 (2026-10); the old 37 was written against a local
  // tree that had extra uncommitted stories, so CI could never pass it.
  assert.ok(scenarios.length >= 30);
  for (const item of scenarios) {
    const story = getScenario(item.id)!;
    for (const lang of ['zh', 'en'] as const) {
      for (const role of ['ai', 'user'] as const) {
        const text = story[lang][role].age;
        const age = text.startsWith('两百零七岁') ? 207 : Number.parseInt(text);
        assert.ok(age >= 18, `${story.id} ${lang} ${role}: ${story[lang][role].age}`);
      }
    }
  }
});

test('the two former school scenarios now use adult university settings', () => {
  for (const id of ['luyan-sunian', 'jiangyubai-wenruanruan']) {
    const story = getScenario(id)!;
    const text = JSON.stringify(story);
    assert.doesNotMatch(text, /高中|高[一二三](?:年级|那年|毕业|橄榄)|校服|high.school|uniform|like a doll/i);
    assert.match(story.zh.background, /十八岁/);
    assert.match(story.en.background, /eighteen/);
    assert.match(story.zh.background, /大学/);
    assert.match(story.en.background, /university/);
  }
});

test('supporting characters with formerly minor or high-school settings are explicitly eighteen', () => {
  for (const [id, member] of [['linjianwei-chenyi', 'xiaoyu'], ['luci-jiajiao', 'luxing'], ['luyan-sunian', 'luwei']]) {
    const zh = scenarioCast(id, 'zh').find(c => c.id === member)!;
    const en = scenarioCast(id, 'en').find(c => c.id === member)!;
    assert.ok(zh && en);
    assert.match(zh.desc, /十八岁/);
    assert.match(en.desc, /eighteen/i);
    assert.doesNotMatch(zh.desc + en.desc, /十六岁|sixteen|high.school|高中/i);
  }
});
