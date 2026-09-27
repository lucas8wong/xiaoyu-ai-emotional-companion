/**
 * speech（语音输入前端封装：MediaRecorder + 服务端 Whisper）单元测试
 * - Node 环境（无 window/MediaRecorder）：能力检测为 false、pickMediaMime 返回 ''
 * - resolveSpeechLang：把识别语言映射成 Whisper 语言码（zh / yue / en）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { isMediaRecorderSupported, resolveSpeechLang, pickMediaMime, computeRms } from '../../src/services/speech.js';

test('Node 环境（无 window/MediaRecorder）：检测不支持，pickMediaMime 返回空串', () => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).MediaRecorder;
  assert.strictEqual(isMediaRecorderSupported(), false);
  assert.strictEqual(pickMediaMime(), '');
});

test('resolveSpeechLang：显式普通话/粤语/英语映射为 Whisper 语言码', () => {
  assert.strictEqual(resolveSpeechLang('zh-CN', 'en'), 'zh');
  assert.strictEqual(resolveSpeechLang('zh-HK', 'en'), 'yue');
  assert.strictEqual(resolveSpeechLang('en-US', 'zh-CN'), 'en');
});

test('resolveSpeechLang：auto 跟随界面语言（en→en，其余→zh）', () => {
  assert.strictEqual(resolveSpeechLang('auto', 'en'), 'en');
  assert.strictEqual(resolveSpeechLang('auto', 'zh-TW'), 'zh');
  assert.strictEqual(resolveSpeechLang('auto', 'zh-CN'), 'zh');
});

test('computeRms：静音（全 128）≈0，语音（偏离中心）>0', () => {
  assert.strictEqual(computeRms(new Uint8Array([128, 128, 128, 128])), 0);
  const speech = new Uint8Array([128, 160, 96, 160, 96, 128]);
  assert.ok(computeRms(speech) > 0);
});

test('浏览器支持 MediaRecorder：检测为 true，pickMediaMime 返回首选类型', () => {
  const FakeRecorder = class {
    static isTypeSupported(m: string) { return m.startsWith('audio/webm'); }
  };
  (globalThis as Record<string, unknown>).window = { MediaRecorder: FakeRecorder };
  (globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
  try {
    assert.strictEqual(isMediaRecorderSupported(), true);
    assert.strictEqual(pickMediaMime(), 'audio/webm;codecs=opus');
  } finally {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).MediaRecorder;
  }
});
