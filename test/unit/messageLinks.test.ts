/**
 * 聊一聊正文链接识别（src/lib/messageLinks.ts）—— 2026-10-03
 *
 * 起因（用户实测「点开显示网页不存在」）：百度百科的中文路径
 * /item/心动的信号第九季/66939408 被旧 URL_RE（排除 \u4e00-\u9fff）截成
 * https://baike.baidu.com/item/ → 浏览器 404「抱歉，您所访问的页面不存在」。
 * 这里把判据钉死，防止回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMessageLinks } from '../../src/lib/messageLinks.js';

test('中文路径整段保留（修复：不再截成 /item/）', () => {
  const text = '（链接：https://baike.baidu.com/item/心动的信号第九季/66939408）';
  const links = findMessageLinks(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://baike.baidu.com/item/心动的信号第九季/66939408');
  // 全角右括号是正文：留在链接外
  assert.equal(text.slice(links[0].index + links[0].raw.length), '）');
});

test('中文维基路径同样整段保留', () => {
  assert.deepEqual(
    findMessageLinks('见 https://zh.wikipedia.org/wiki/心动的信号 谢谢').map((m) => m.href),
    ['https://zh.wikipedia.org/wiki/心动的信号'],
  );
});

test('百分号编码的 URL 原样保留（不双重转义、不截断）', () => {
  const u = 'https://baike.baidu.com/item/%E5%BF%83%E5%8A%A8%E7%9A%84%E4%BF%A1%E5%8F%B7/66939408';
  assert.deepEqual(findMessageLinks(u).map((m) => m.href), [u]);
});

test('尾随英文标点/括号剥离后补回正文', () => {
  const links = findMessageLinks('看这个 https://baike.baidu.com/item/心动/123).');
  assert.equal(links[0].href, 'https://baike.baidu.com/item/心动/123');
  assert.equal(links[0].tail, ').');
});

test('中文句读处断开，不吞后续正文', () => {
  const src = 'https://x.com/a，然后我们继续。';
  const links = findMessageLinks(src);
  assert.equal(links[0].href, 'https://x.com/a');
  assert.equal(links[0].tail, '');
  assert.equal(src.slice(links[0].index + links[0].raw.length), '，然后我们继续。');
});

test('裸域名带路径自动补 https://；纯域名 / 邮箱不算链接', () => {
  assert.deepEqual(findMessageLinks('news.qq.com/rain/a/20251226A03V7S00').map((m) => m.href),
    ['https://news.qq.com/rain/a/20251226A03V7S00']);
  assert.deepEqual(findMessageLinks('www.example.com').map((m) => m.href), ['https://www.example.com']);
  assert.deepEqual(findMessageLinks('example.com').map((m) => m.href), ['']);   // 无路径/无 www → 文本
  assert.deepEqual(findMessageLinks('mail me at user@example.com').map((m) => m.href), []); // 邮箱域名整个跳过
});

test('一行多条链接都能识别', () => {
  const links = findMessageLinks('news.qq.com/rain/a/20251226A03V7S00 和 https://m.huxiu.com/article/4820644.html');
  assert.deepEqual(links.map((m) => m.href), [
    'https://news.qq.com/rain/a/20251226A03V7S00',
    'https://m.huxiu.com/article/4820644.html',
  ]);
});

test('拼接后不丢字：卡片以外的正文原样保留', () => {
  const cases = [
    '（链接：https://baike.baidu.com/item/心动的信号第九季/66939408）往下看',
    '看这个 https://baike.baidu.com/item/心动/123). 还有 news.qq.com/a/b 呢',
    '没有链接的一句话。但 example.com 纯域名不算卡片',
  ];
  for (const text of cases) {
    let last = 0; let rebuilt = '';
    for (const l of findMessageLinks(text)) {
      rebuilt += text.slice(last, l.index);
      rebuilt += l.raw;               // 卡片位置 = 用原文那段代表“被卡片替换掉的内容”
      last = l.index + l.raw.length;
    }
    rebuilt += text.slice(last);
    assert.equal(rebuilt, text, '正文丢字：' + text);
  }
});
