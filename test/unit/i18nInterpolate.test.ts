/**
 * i18n 插值回归测试（2026-09-21 真机走查发现）
 *
 * 背景：`t()` 原先用 `s.replace('{n}', v)`，**只替换第一处**。于是「朋友注册得 {n} 次；
 * 他开始聊天后你得 {n} 次。」这种同值出现两次的文案会把第二个 `{n}` 原样显示给用户
 * （「我的」面板实测到过）。全库 4 个键 × 3 语受影响。下面把「每一处都要替换」钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang, t, type Lang } from '../../src/i18n/index';

// node 环境没有 localStorage：给 setLang/getLang 一个最小可用替身（模块本身 try/catch 兜底）
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};

const LOCALES: Lang[] = ['zh-CN', 'zh-TW', 'en'];

test('t() 替换同一占位符的每一处（不再漏出 {n}）', () => {
  for (const lang of LOCALES) {
    setLang(lang);
    const s = t('profileInviteDesc', { n: 50 });
    assert.ok(!s.includes('{'), `${lang} 仍漏出占位符：${s}`);
    assert.equal((s.match(/50/g) || []).length, 2, `${lang} 应出现两次 50：${s}`);
  }
});

test('t() 多个不同占位符各自都替换（quotaShareDesc 的 n 与 m）', () => {
  for (const lang of LOCALES) {
    setLang(lang);
    const s = t('quotaShareDesc', { n: 50, m: 20 });
    assert.ok(!s.includes('{'), `${lang} 仍漏出占位符：${s}`);
    assert.ok(s.includes('50'), `${lang} 缺 n 的值：${s}`);
    assert.ok(s.includes('20'), `${lang} 缺 m 的值：${s}`);
  }
});

test('未提供的占位符保持原样（便于发现漏传，而不是静默吞掉）', () => {
  setLang('zh-CN');
  const s = t('profileInviteDesc', {});
  assert.ok(s.includes('{n}'), `未传变量时应保留占位符：${s}`);
});

test('含重复占位符的 4 个键在传参后都不残留花括号', () => {
  const keys = ['profileInviteDesc', 'inviteEarnHint', 'inviteRecordsTooNew', 'quotaShareDesc'] as const;
  for (const lang of LOCALES) {
    setLang(lang);
    for (const k of keys) {
      const s = t(k, { n: 50, m: 20 });
      assert.ok(!s.includes('{'), `${lang}/${k} 仍漏出占位符：${s}`);
    }
  }
});
