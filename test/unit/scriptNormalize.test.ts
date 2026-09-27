import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeScriptText, detectScriptText, normalizeScriptDeep, hasCjk, toOutputLang } from '../../api/services/zhConvert.js';

test('normalizeScriptText：简/繁/英 归一化（硬保证）', () => {
  // 简体→简体原样；繁体→强制简体
  assert.strictEqual(normalizeScriptText('我愛你, 軟件', 'zh-CN'), '我爱你, 软件');
  // 简体→强制繁体
  assert.strictEqual(normalizeScriptText('我爱你, 软件', 'zh-TW'), '我愛你, 軟件');
  // 英文原样（opencc 不处理英文）
  assert.strictEqual(normalizeScriptText('Hello 世界', 'en'), 'Hello 世界');
  assert.strictEqual(normalizeScriptText('', 'zh-CN'), '');
  assert.strictEqual(normalizeScriptText(null as unknown as string, 'zh-TW'), null as unknown as string);
});

test('detectScriptText：识别简/繁/英（聊一聊跟随输入用）', () => {
  assert.strictEqual(detectScriptText('我愛你'), 'zh-TW'); // 含繁体 → 转简体会变
  assert.strictEqual(detectScriptText('我爱你'), 'zh-CN'); // 含简体 → 转繁体会变
  assert.strictEqual(detectScriptText('hello world'), 'en'); // 无中文
  assert.strictEqual(detectScriptText(''), ''); // 空
  assert.strictEqual(detectScriptText('你好世界'), ''); // 简繁同形，无法判定 → 交由调用方回退界面语言
});

test('hasCjk：是否含中文', () => {
  assert.strictEqual(hasCjk('hello world'), false);
  assert.strictEqual(hasCjk('今天心情不错'), true);
  assert.strictEqual(hasCjk(''), false);
});

test('toOutputLang：任意值归一化到三态（跨层统一 langKey / opts.lang）', () => {
  assert.strictEqual(toOutputLang('en'), 'en');
  assert.strictEqual(toOutputLang('zh-TW'), 'zh-TW');
  assert.strictEqual(toOutputLang('zh-CN'), 'zh-CN');
  assert.strictEqual(toOutputLang('zh'), 'zh-CN'); // 别名 → 简体
  assert.strictEqual(toOutputLang('zh-HK'), 'zh-CN');
  assert.strictEqual(toOutputLang('fr'), 'zh-CN'); // 未知 → 缺省 zh-CN
  assert.strictEqual(toOutputLang('', 'en'), 'en'); // 自定义回退
});

test('normalizeScriptDeep：递归对象/数组（结构化分析结果硬保证）', () => {
  const out = normalizeScriptDeep({ a: '软件', b: ['网络', '内存'], c: 1, d: null, e: { f: '女儿' } }, 'zh-TW');
  assert.strictEqual(out.a, '軟件');
  assert.deepStrictEqual(out.b, ['網絡', '內存']);
  assert.strictEqual(out.c, 1);
  assert.strictEqual(out.d, null);
  assert.strictEqual(out.e.f, '女兒');
});
