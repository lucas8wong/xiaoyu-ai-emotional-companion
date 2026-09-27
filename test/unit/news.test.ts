import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// 让 news.ts 以真实路径加载，但全局 mock fetch：模块加载时会触发一次 refresh()（微博+Google News），
// 统一在 fetch 里按 URL 返回，保证测试确定性、不触网。
const ORIGINAL_FETCH = globalThis.fetch;
function mockFetch(routes: (url: string) => string | null) {
  (globalThis as any).fetch = async (url: string) => {
    const content = routes(String(url));
    if (content === null || content === undefined) {
      return { ok: false, text: async () => '', json: async () => ({}) };
    }
    return { ok: true, text: async () => content, json: async () => JSON.parse(content) };
  };
}

// 模块 import 时会触发一次 refresh()（微博 + Google News），先 mock 干净再导入，避免测试触网。
mockFetch(() => null);

let news: typeof import('../../api/services/news.js');

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/mangshi-food')}&rut=1">云南芒市美食攻略</a>
  <a class="result__snippet" href="https://example.com/mangshi-food">芒市是云南德宏的一个小城，傣味美食很有名。</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://other.com/foo">芒市 酸角鸡火锅</a>
  <a class="result__snippet" href="https://other.com/foo">酸角鸡是芒市招牌菜。</a>
</div>
`;

before(async () => {
  news = await import('../../api/services/news.js');
});
after(() => {
  (globalThis as any).fetch = ORIGINAL_FETCH;
});

test('parseDdgResults 解析标题/摘要/链接（含 uddg 还原 + 数量限制）', () => {
  const results = news.parseDdgResults(DDG_HTML, 3);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '云南芒市美食攻略');
  assert.equal(results[0].url, 'https://example.com/mangshi-food'); // uddg 应还原为真实链接
  assert.match(results[0].snippet, /傣味/);
  assert.equal(results[1].title, '芒市 酸角鸡火锅');
  assert.match(results[1].snippet, /酸角鸡/);
  assert.equal(news.parseDdgResults(DDG_HTML, 1).length, 1);
});

test('searchWeb 空查询返回空串', async () => {
  assert.equal(await news.searchWeb('   '), '');
});

test('searchWeb 把 wiki/新闻/网页结果格式化为「标题+摘要+链接」', async () => {
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('zh.wikipedia.org')) {
      return JSON.stringify({
        query: { search: [{ title: '芒市', snippet: '<span>芒市是云南省德宏傣族景颇族自治州的一个县级市。</span>' }] },
      });
    }
    if (url.includes('news.google.com/rss/search')) {
      return '<rss><channel><item><title>芒市美食 - 云南网</title><link>https://dehong.yunnan.cn/news</link></item></channel></rss>';
    }
    if (url.includes('duckduckgo.com')) return DDG_HTML;
    return null; // refresh / 其余一律失败
  });
  const out = await news.searchWeb('芒市 美食');
  assert.match(out, /维基百科/);
  assert.match(out, /芒市/);
  assert.match(out, /新闻/);
  assert.match(out, /dehong\.yunnan\.cn/); // Google News RSS 标题会去掉「- 来源」，改校验链接
  assert.match(out, /网页搜索/);
  assert.match(out, /云南芒市美食攻略/);
  assert.match(out, /傣味/);
  assert.match(out, /https:\/\/example\.com\/mangshi-food/);
  assert.ok(urls.some((u) => u.includes('html.duckduckgo.com')), '应请求 DuckDuckGo');
});

test('searchWeb 传入 site 会在 DuckDuckGo 查询里追加 site: 域名', async () => {
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('duckduckgo.com')) return DDG_HTML;
    return null;
  });
  await news.searchWeb('花胶鸡', { site: 'xiaohongshu.com' });
  const ddgUrl = urls.find((u) => u.includes('duckduckgo.com'));
  assert.ok(ddgUrl, '应请求 DuckDuckGo');
  assert.match(ddgUrl!, /site%3Axiaohongshu\.com|site:xiaohongshu\.com/);
});

test('searchWeb 全部来源失败返回空串（聊天走友好提示）', async () => {
  mockFetch(() => null);
  assert.equal(await news.searchWeb('不存在的话题abcdef'), '');
});

// ===== Tavily + read_url =====

test('searchWeb 配了 Tavily key → 优先用 Tavily 结果且不回落 DuckDuckGo', async () => {
  delete process.env.TAVILY_API_KEY;
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('api.tavily.com/search')) {
      return JSON.stringify({ results: [{ title: '芒市美食', url: 'https://example.com/mangshi', content: '芒市傣味很有名，酸角鸡是招牌。' }] });
    }
    return null;
  });
  process.env.TAVILY_API_KEY = 'test-key';
  try {
    const out = await news.searchWeb('芒市 美食');
    assert.match(out, /芒市美食/);
    assert.match(out, /酸角鸡/);
    assert.match(out, /https:\/\/example\.com\/mangshi/);
    assert.ok(urls.some((u) => u.includes('api.tavily.com/search')), '应请求 Tavily');
    assert.ok(!urls.some((u) => u.includes('duckduckgo.com')), '配 Tavily 后不应回落 DuckDuckGo');
  } finally {
    delete process.env.TAVILY_API_KEY;
  }
});

test('searchWeb 无 Tavily key 时不请求 Tavily（回落免费源）', async () => {
  delete process.env.TAVILY_API_KEY;
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('duckduckgo.com')) return DDG_HTML;
    return null;
  });
  const out = await news.searchWeb('芒市 美食');
  assert.match(out, /网页搜索/);
  assert.ok(!urls.some((u) => u.includes('api.tavily.com')), '无 key 不应请求 Tavily');
});

test('fetchUrlText 读网页正文：去 HTML/script/style 并保留正文', async () => {
  mockFetch((url) => {
    if (url.includes('example.com')) {
      return '<html><style>.x{color:red}</style><script>alert(1)</script><body><h1>芒市美食</h1><p>酸角鸡火锅是<strong>招牌</strong>。</p></body></html>';
    }
    return null;
  });
  const out = await news.fetchUrlText('https://example.com/mangshi');
  assert.match(out, /【链接内容】/);
  assert.match(out, /https:\/\/example\.com\/mangshi/);
  assert.match(out, /芒市美食/);
  assert.match(out, /酸角鸡火锅是\s*招牌/); // 标签换空格，允许空白
  assert.ok(!out.includes('alert(1)'), '应去掉 script 内容');
  assert.ok(!out.includes('color:red'), '应去掉 style 内容');
});

test('fetchUrlText 空链接/非 http 链接拒绝', async () => {
  assert.match(await news.fetchUrlText(''), /请提供/);
  assert.match(await news.fetchUrlText('ftp://example.com'), /不方便读取/);
});

test('isSafeHttpUrl：拒绝本地/内网/非 http，放行公开 https', () => {
  assert.equal(news.isSafeHttpUrl('http://localhost:3000'), false);
  assert.equal(news.isSafeHttpUrl('http://127.0.0.1/x'), false);
  assert.equal(news.isSafeHttpUrl('http://192.168.1.1'), false);
  assert.equal(news.isSafeHttpUrl('http://10.0.0.5'), false);
  assert.equal(news.isSafeHttpUrl('ftp://example.com'), false);
  assert.equal(news.isSafeHttpUrl('https://example.com/a'), true);
  assert.equal(news.isSafeHttpUrl('https://www.xiaohongshu.com/explore'), true);
});

test('pageToText：去除 script/style/标签并解实体压空白', () => {
  assert.equal(news.pageToText('<div>a&amp;b</div><script>1</script>'), 'a&b');
});

test('fetchUrlText 会把中文 URL 路径百分号编码后再请求', async () => {
  delete process.env.TAVILY_API_KEY;
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('wikipedia.org') || url.includes('example.com')) return '<html><body>正文内容</body></html>';
    return null;
  });
  const out = await news.fetchUrlText('https://zh.wikipedia.org/wiki/芒市');
  assert.match(out, /正文内容/);
  assert.ok(urls.some((u) => u.includes('%E8%8A%92%E5%B8%82')), '应使用百分号编码后的 URL，实际: ' + urls.join(', '));
});
