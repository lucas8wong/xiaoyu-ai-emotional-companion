import { test } from 'node:test';
import assert from 'node:assert';
import {
  atmosphereFor,
  clampParticles,
  shouldAnimateFx,
  fxNoise,
  FX_BUDGET,
} from '../../src/lib/storyFx.js';
import { SCENE_THEMES } from '../../src/lib/storyScene.js';

test('atmosphereFor：主题 → 氛围（雨用雨丝、夜用光斑、回忆用浮尘、亲密用烛光）', () => {
  assert.strictEqual(atmosphereFor('rain').kind, 'rain');
  assert.strictEqual(atmosphereFor('night').kind, 'bokeh');
  assert.strictEqual(atmosphereFor('memory').kind, 'dust');
  assert.strictEqual(atmosphereFor('intimate').kind, 'flicker');
  assert.strictEqual(atmosphereFor('promise').kind, 'flicker');
  assert.strictEqual(atmosphereFor('crisis').kind, 'bloom');
  // 未知识别 → 暖光兜底（不报错、不留空）
  assert.strictEqual(atmosphereFor('whatever').kind, 'bloom');
  assert.strictEqual(atmosphereFor(null).kind, 'bloom');
});

test('atmosphereFor：强度克制（叠加色极淡、暗角 ≤ 0.3），不能影响气泡可读性', () => {
  for (const t of [...SCENE_THEMES.map(x => x.id), 'unknown']) {
    const s = atmosphereFor(t);
    const m = s.tint.match(/rgba\(([^)]+)\)/);
    assert.ok(m, 'tint 必须是 rgba：' + s.tint);
    const alpha = Number(m[1].split(',')[3]);
    assert.ok(alpha > 0 && alpha <= 0.1, `${t} 的叠加色太浓：${s.tint}`);
    assert.ok(s.vignette >= 0 && s.vignette <= 0.3, `${t} 的暗角太重：${s.vignette}`);
    assert.ok(s.count <= FX_BUDGET.maxParticles, `${t} 粒子超预算：${s.count}`);
  }
});

test('clampParticles：粒子数收敛到预算内（防止改大导致低端机卡顿）', () => {
  assert.strictEqual(clampParticles(0), 0);
  assert.strictEqual(clampParticles(3), 0); // 太少不值得渲染
  assert.strictEqual(clampParticles(18), 18);
  assert.strictEqual(clampParticles(999), FX_BUDGET.maxParticles);
  assert.strictEqual(clampParticles(Number.NaN), 0);
  assert.strictEqual(clampParticles(-5), 0);
});

test('shouldAnimateFx：reduced-motion / 极低端机 / 显式关闭 → 都不动', () => {
  assert.strictEqual(shouldAnimateFx({}), true);
  assert.strictEqual(shouldAnimateFx({ reducedMotion: true }), false);
  assert.strictEqual(shouldAnimateFx({ cores: 2 }), false);
  assert.strictEqual(shouldAnimateFx({ cores: 4 }), true);
  assert.strictEqual(shouldAnimateFx({ cores: 0 }), true); // 拿不到核数时按"能用"处理
  assert.strictEqual(shouldAnimateFx({ disabled: true }), false);
  assert.strictEqual(shouldAnimateFx({ disabled: true, reducedMotion: false, cores: 8 }), false);
});

test('fxNoise：0..1 且同 index 恒定（渲染稳定、测试可预期）', () => {
  for (let i = 0; i < 30; i++) {
    const v = fxNoise(i);
    assert.ok(v >= 0 && v < 1, `越界：${v}`);
    assert.strictEqual(fxNoise(i), v, '同 index 必须恒定');
  }
  // 不同 salt 应产生不同分布（避免所有粒子同相位）
  assert.notStrictEqual(fxNoise(3, 1), fxNoise(3, 2));
});
