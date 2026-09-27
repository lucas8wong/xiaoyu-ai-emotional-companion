import { test } from 'node:test';
import assert from 'node:assert';
import {
  AMBIENCE_CLIPS,
  AMBIENCE_MAX_VOLUME,
  ambienceForTheme,
  oneShotsForText,
  clampAmbienceVolume,
  ambienceUrl,
  clipById,
} from '../../src/lib/storyAmbience.js';
import { SCENE_THEMES } from '../../src/lib/storyScene.js';

test('ambienceForTheme：主题 → 环境音（雨用雨声、夜/危机用风、回忆用钟摆、其余室内底噪）', () => {
  assert.strictEqual(ambienceForTheme('rain').loop, 'rain-soft');
  assert.strictEqual(ambienceForTheme('night').loop, 'wind-low');
  assert.strictEqual(ambienceForTheme('crisis').loop, 'wind-low');
  assert.strictEqual(ambienceForTheme('memory').loop, 'clock-tick');
  assert.strictEqual(ambienceForTheme('intimate').loop, 'room-soft');
  assert.strictEqual(ambienceForTheme('whatever').loop, 'room-soft');
  assert.strictEqual(ambienceForTheme(null).loop, 'room-soft');
});

test('ambienceForTheme：音量一律轻（不盖朗读）且不超过上限', () => {
  for (const t of [...SCENE_THEMES.map(x => x.id), 'unknown']) {
    const s = ambienceForTheme(t);
    assert.ok(s.volume > 0 && s.volume <= AMBIENCE_MAX_VOLUME, `${t} 音量越界：${s.volume}`);
    assert.ok(s.volume <= 0.3, `${t} 环境音偏响（应 ≤0.3）：${s.volume}`);
  }
});

test('oneShotsForText：只认明确的声音事件（雷），不认情绪词', () => {
  assert.deepStrictEqual(oneShotsForText('远处传来雷声'), ['thunder-far']);
  assert.deepStrictEqual(oneShotsForText('轰隆一声'), ['thunder-far']);
  assert.deepStrictEqual(oneShotsForText('thunder rolled'), ['thunder-far']);
  assert.deepStrictEqual(oneShotsForText('外面下雨了'), []); // 雨是循环环境音，不是一次性音效
  assert.deepStrictEqual(oneShotsForText('他很难过'), []);
  assert.deepStrictEqual(oneShotsForText(''), []);
  assert.deepStrictEqual(oneShotsForText(null), []);
});

test('素材表自洽：id 唯一、循环音在表内、一次性音效不得被当循环用', () => {
  const ids = AMBIENCE_CLIPS.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const t of SCENE_THEMES.map(x => x.id)) {
    const id = ambienceForTheme(t).loop;
    if (!id) continue;
    const clip = clipById(id);
    assert.ok(clip, `${t} 引用了不存在的环境音：${id}`);
    assert.strictEqual(clip.loop, true, `${t} 把一次性音效当循环用了：${id}`);
  }
  // 雷声是一次性音效（不能 loop）
  assert.strictEqual(clipById('thunder-far')?.loop, false);
  // 每个 clip 的 label 都是 rpAmb* i18n key
  for (const c of AMBIENCE_CLIPS) assert.ok(c.label.startsWith('rpAmb'), c.id + ' label 应为 rpAmb*');
});

test('clampAmbienceVolume / ambienceUrl', () => {
  assert.strictEqual(clampAmbienceVolume(0), 0);
  assert.strictEqual(clampAmbienceVolume(-1), 0);
  assert.strictEqual(clampAmbienceVolume(Number.NaN), 0);
  assert.strictEqual(clampAmbienceVolume(0.26), 0.26);
  assert.strictEqual(clampAmbienceVolume(5), AMBIENCE_MAX_VOLUME);
  assert.strictEqual(ambienceUrl('rain-soft'), '/audio/roleplay-ambience/rain-soft.wav');
});
