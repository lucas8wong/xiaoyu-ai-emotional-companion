import { describe, expect, it } from 'vitest';
import { replacePhrases } from './i18n';

/**
 * 文游 zh→en 词典替换的回归守卫（2026-09-29 审查 A6-P2-2）。
 *
 * 背景：词典里有「小/大/中/年/月/级」这类**单字键**，而替换曾对每个文本节点做**子串替换**，
 * 于是本地模式的中文正文被改坏：
 *   「我心中一横，大步走出，年幼的…」→「我心Medium一横，Large步走出，year幼的…」
 * 修复后：整节点命中→翻译；成句中文（有句读或较长）→原样保留。
 */
describe('replacePhrases（en 词典）', () => {
  it('成句的中文正文一律原样保留（不许出现 Medium/Large/year 这类替换）', () => {
    for (const prose of [
      '我心中一横，大步走出，年幼的我竟不知前路如何。',
      '他年轻时也曾想过离开这座小城，只是后来年岁渐长，便不再提了。',
      '月光下，那年冬天的大雪压垮了屋檐。',
    ]) {
      expect(replacePhrases(prose)).toBe(prose);
    }
  });

  it('整节点命中的 UI 标签仍然翻译', () => {
    expect(replacePhrases('小')).not.toBe('小');
    expect(replacePhrases('年')).not.toBe('年');
  });

  it('不含中文的文本原样返回（不做任何处理）', () => {
    expect(replacePhrases('Chapter 3')).toBe('Chapter 3');
    expect(replacePhrases('')).toBe('');
  });
});
