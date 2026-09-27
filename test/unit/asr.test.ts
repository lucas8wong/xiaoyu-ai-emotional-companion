/**
 * asr（服务端 Whisper 语音转文字）纯函数单元测试
 * - normalizeAsrLang：语言码归一化（zh / yue / en），非法回退 zh
 * - pcm16ToFloat32：PCM16(little-endian) → Float32(-1..1)，不加载 Whisper 模型
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeAsrLang, pcm16ToFloat32 } from '../../api/services/asr.js';

test('normalizeAsrLang：合法语言码保留，非法回退 zh', () => {
  assert.strictEqual(normalizeAsrLang('zh'), 'zh');
  assert.strictEqual(normalizeAsrLang('yue'), 'yue');
  assert.strictEqual(normalizeAsrLang('en'), 'en');
  assert.strictEqual(normalizeAsrLang(undefined), 'zh');
  assert.strictEqual(normalizeAsrLang(''), 'zh');
  assert.strictEqual(normalizeAsrLang('auto'), 'zh');
});

test('pcm16ToFloat32：PCM16 → 归一化 Float32', () => {
  const int16 = new Int16Array([0, 32767, -32768, 16384]);
  const buf = Buffer.from(int16.buffer);
  const f32 = pcm16ToFloat32(buf);
  assert.strictEqual(f32.length, 4);
  assert.ok(Math.abs(f32[0] - 0) < 1e-6);
  assert.ok(Math.abs(f32[1] - 32767 / 32768) < 1e-4);
  assert.ok(Math.abs(f32[2] - (-1)) < 1e-6);
  assert.ok(Math.abs(f32[3] - 0.5) < 1e-4);
});
