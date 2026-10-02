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

/**
 * SSRF 回归守卫（2026-09-28 审查 B3）：旧实现是字符串黑名单，下面这些写法**全都漏过**
 * 而它们都能解析到本机/内网（本机 3001 就是线上 Express，环回即可读到管理面）。
 * 注意 Node 的 URL 会把 `::ffff:127.0.0.1` **规范化成 `::ffff:7f00:1`**，
 * 所以必须按字节判 IPv4-mapped，不能只匹配点分写法（这条是实测踩出来的）。
 */
test('isSafeHttpUrl：尾部点 / IPv4-mapped IPv6 / ULA / 链路本地 / CGNAT 一律拒绝（B3 回归守卫）', () => {
  for (const bad of [
    'http://localhost./',
    'http://localhost.:3001/admin',
    'http://[::ffff:127.0.0.1]/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.1.1/',
    'http://2130706433/',
    'http://0x7f000001/',
  ]) {
    assert.equal(news.isSafeHttpUrl(bad), false, '应拒绝: ' + bad);
  }
  for (const good of ['https://example.com/', 'https://myxiaoyu.com/blog']) {
    assert.equal(news.isSafeHttpUrl(good), true, '应放行: ' + good);
  }
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
/* ───────── 结构化来源（2026-09-29）：给模型文本 + 给界面链接，一次抓取两路产出 ───────── */

test('searchWebDetailed：sources 与 text 同步产出，且 text 与 searchWeb 逐字一致', async () => {
  delete process.env.TAVILY_API_KEY;
  const routes = (url: string) => {
    if (url.includes('zh.wikipedia.org')) {
      return JSON.stringify({ query: { search: [{ title: '芒市', snippet: '<span>芒市是云南省德宏傣族景颇族自治州的一个县级市。</span>' }] } });
    }
    if (url.includes('news.google.com/rss/search')) {
      return '<rss><channel><item><title>芒市美食 - 云南网</title><link>https://dehong.yunnan.cn/news</link></item></channel></rss>';
    }
    if (url.includes('duckduckgo.com')) return DDG_HTML;
    return null;
  };
  mockFetch(routes);
  const detailed = await news.searchWebDetailed('芒市 美食');
  mockFetch(routes);
  const text = await news.searchWeb('芒市 美食');
  assert.equal(detailed.text, text, 'searchWeb 只是 searchWebDetailed 的一层薄壳，文本必须逐字一致');
  // 界面要的是「可点的出处」：维基 + 新闻 + 网页三路都该在，且顺序 = 命中顺序
  assert.deepEqual(detailed.sources.map((s) => s.url), [
    'https://zh.wikipedia.org/wiki/%E8%8A%92%E5%B8%82',
    'https://dehong.yunnan.cn/news',
    'https://example.com/mangshi-food',
    'https://other.com/foo', // DDG 那段 HTML 里有两条结果
  ]);
  assert.ok(detailed.sources.every((s) => s.title && s.url), '每条来源都要有标题和链接');
});

test('pickSources：同一 URL 只留第一条、过滤非公网/无标题、按上限截断', () => {
  const groups = [
    {
      label: '维基百科',
      results: [
        { title: '芒市', snippet: '', url: 'https://example.com/a' },
        { title: '', snippet: '', url: 'https://example.com/no-title' },        // 无标题 → 丢
        { title: '内网', snippet: '', url: 'http://127.0.0.1/secret' },          // 非公网 → 丢
        { title: '伪协议', snippet: '', url: 'javascript:alert(1)' },            // 非 http(s) → 丢
      ],
    },
    {
      label: '新闻',
      results: [
        { title: '重复', snippet: '', url: 'https://example.com/a' },            // 与第一条同 URL → 丢
        { title: '第二条', snippet: '', url: 'https://example.com/b' },
        { title: '第三条', snippet: '', url: 'https://example.com/c' },
      ],
    },
  ];
  assert.deepEqual(news.pickSources(groups).map((s) => s.url), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ]);
  assert.equal(news.pickSources(groups, 2).length, 2, '上限应生效');
  assert.equal(news.pickSources([], 5).length, 0);
});
test('pickSources：认出发布方时按发布方去重（一排 news.google.com 收敛成几家）', () => {
  const groups = [{
    label: '新闻',
    results: [
      { title: 'A', snippet: '', url: 'https://news.google.com/rss/articles/1', host: 'finance.sina.com.cn' },
      { title: 'B', snippet: '', url: 'https://news.google.com/rss/articles/2', host: 'finance.sina.com.cn' }, // 同一家 → 收敛
      { title: 'C', snippet: '', url: 'https://news.google.com/rss/articles/3', host: 'thepaper.cn' },
    ],
  }];
  const out = news.pickSources(groups);
  assert.deepEqual(out.map((s) => s.host), ['finance.sina.com.cn', 'thepaper.cn']);
  assert.equal(out[0].url, 'https://news.google.com/rss/articles/1', '点开仍走原文链接（发布方只用于展示）');
});

test('RSS 发布方域名：Google News 的跳转链接也能显示「哪家说的」', async () => {
  delete process.env.TAVILY_API_KEY;
  mockFetch((url) => {
    if (url.includes('news.google.com/rss/search')) {
      return '<rss><channel>'
        + '<item><title>Tiffany寄错月饼 - finance.sina.com.cn</title><link>https://news.google.com/rss/articles/AAA</link></item>'
        + '<item><title>店长道歉 - www.thepaper.cn</title><link>https://news.google.com/rss/articles/BBB</link></item>'
        + '<item><title>没有发布方的标题</title><link>https://news.google.com/rss/articles/CCC</link></item>'
        + '</channel></rss>';
    }
    return null;
  });
  const o = await news.searchWebDetailed('月饼');
  assert.deepEqual(o.sources.map((s) => s.host), ['finance.sina.com.cn', 'thepaper.cn', undefined]);
  assert.equal(o.sources[0].url, 'https://news.google.com/rss/articles/AAA', '链接仍是原文跳转地址');
  assert.equal(o.sources[0].title, 'Tiffany寄错月饼', '标题里的发布方后缀仍被剥掉（展示交给 host）');
});
/* ───────── 快照来源匹配（2026-09-29）：只认回复**真正引用**到的那几条 ───────── */

test('matchSnapshotSources：引用了标题就给出该条来源，无关回复一条都不给', () => {
  const items = [
    { title: '英语才是普通人的终极杠杆', url: 'https://s.weibo.com/weibo?q=%23x%23' },
    { title: '冷空气要来了', url: 'https://s.weibo.com/weibo?q=%23y%23' },
    // 快照里的标题已经剥掉了「 - 来源」后缀（发布方另存 host），这里照真实形状写
    { title: 'Tiffany月饼礼盒寄错', url: 'https://news.google.com/rss/articles/AAA', host: 'finance.sina.com.cn' },
  ];
  // ① 原样引用」→ 命中（截图里那条「热搜第一是…」就是这个形态）
  const quoted = news.matchSnapshotSources('热搜第一是「英语才是普通人的终极杠杆」，这届网友是真敢说', items);
  assert.deepEqual(quoted.map((s) => s.title), ['英语才是普通人的终极杠杆']);
  // ② 短标题要求整串：只说「冷空气」不算引用
  assert.deepEqual(news.matchSnapshotSources('冷空气好像要来了吧', items), []);
  assert.deepEqual(news.matchSnapshotSources('天气预报说冷空气要来了', items).map((s) => s.title), ['冷空气要来了']);
  // ③ 长标题的部分命中不算（宁可少给，也不挂错出处）
  assert.deepEqual(news.matchSnapshotSources('看到一条月饼的新闻', items), []);
  // ④ 跟新闻毫无关系的回复：一条都不能挂
  assert.deepEqual(news.matchSnapshotSources('我今天有点累，什么都不想做。', items), []);
  // ⑤ 命中时连发布方域名一起带上；上限生效
  const long = news.matchSnapshotSources('英语才是普通人的终极杠杆，冷空气要来了，Tiffany月饼礼盒寄错', items, 1);
  assert.equal(long.length, 1);
  const all = news.matchSnapshotSources('英语才是普通人的终极杠杆，冷空气要来了，Tiffany月饼礼盒寄错', items);
  assert.deepEqual(all.map((s) => s.host), [undefined, undefined, 'finance.sina.com.cn']);
});

test('matchSnapshotSourcesBySegment：按段落各挂各的（段下标＝气泡下标）', () => {
  const items = [
    { title: 'Tiffany月饼', url: 'https://m.weibo.cn/search?containerid=x' },
    { title: '冷空气要来了', url: 'https://m.weibo.cn/search?containerid=y' },
  ];
  const reply = '看了一圈热搜，笑出声\n\nTiffany月饼，又上榜了\n\n对了，冷空气要来了';
  const segs = news.matchSnapshotSourcesBySegment(reply, items);
  assert.equal(segs.length, 3, '段数必须与气泡数一致');
  assert.equal(segs[0], null);
  assert.deepEqual(segs[1].map((s) => s.title), ['Tiffany月饼']);
  assert.deepEqual(segs[2].map((s) => s.title), ['冷空气要来了']);
  // 没引用的段落一律 null（渲染时就不会出现空来源行）
  assert.deepEqual(news.matchSnapshotSourcesBySegment('我今天有点累\n\n什么都不想做', items), [null, null]);
});

/* ───────── 搜索来源也按段落归位（2026-09-29 第三轮） ───────── */

test('attributeSourcesBySegment：三条搜索来源各自归到提到它的那段', () => {
  const sources = [
    { title: 'Tiffany月饼寄错事件', snippet: '', url: 'https://news.sina.com.cn/a.html', host: 'finance.sina.com.cn' },
    { title: '京港高铁雄商段开通', snippet: '', url: 'https://news.mydrivers.com/b.html' },
    { title: '第三家的报道', snippet: '', url: 'https://www.example.com/c.html' },
  ];
  const reply = [
    'Tiffany月饼那件事又反转了。',
    '中间讲点别的。',
    '另外京港高铁雄商段昨天开通，最快2小时27分。',
  ].join('\n\n');
  const segs = news.attributeSourcesBySegment(reply, sources);
  assert.equal(segs.length, 3, '段数必须与气泡数一致');
  assert.deepEqual(segs[0].map((s) => s.url), ['https://news.sina.com.cn/a.html'], '第 1 段只挂自己那条');
  assert.equal(segs[1], null, '没提到的段落不该有来源');
  assert.deepEqual(segs[2].map((s) => s.url), ['https://news.mydrivers.com/b.html']);
  // 没被任何一段提到的来源不进结果（否则又会变成「最后一条挤一排」）
  assert.ok(!JSON.stringify(segs).includes('example.com/c.html'));
});

test('attributeSourcesBySegment：域名/URL 出现也算归位；一条都归不上返回 null（调用方退回整轮）', () => {
  const sources = [{ title: '某条新闻', snippet: '', url: 'https://news.mydrivers.com/x.html' }];
  const byHost = news.attributeSourcesBySegment('这条是 news.mydrivers.com 报的。\n\n另一段。', sources);
  assert.deepEqual(byHost[0].map((s) => s.url), ['https://news.mydrivers.com/x.html']);
  const byUrl = news.attributeSourcesBySegment('链接在这 https://news.mydrivers.com/x.html\n\n另一段。', sources);
  assert.deepEqual(byUrl[0].map((s) => s.url), ['https://news.mydrivers.com/x.html']);
  // 一条都归不上 → null（**不是**空数组）：调用方据此退回「整轮挂最后一条」，不丢信息
  assert.equal(news.attributeSourcesBySegment('今天天气不错，出去走了走。', sources), null);
  // 非公网链接直接不算来源
  assert.equal(news.attributeSourcesBySegment('内网 http://127.0.0.1/x', [{ title: 'x', snippet: '', url: 'http://127.0.0.1/x' }]), null);
});

test('mergeSegmentSources：段下标对齐、同段按 URL 去重、长度取长者且保留 null 占位', () => {
  const a = [[{ title: 'A', snippet: '', url: 'https://a.com/1' }], null];
  const b = [null, [{ title: 'B', snippet: '', url: 'https://b.com/2' }], [{ title: 'C', snippet: '', url: 'https://c.com/3' }]];
  const m = news.mergeSegmentSources(a, b);
  assert.equal(m.length, 3, '段数取长者，且 null 占位不能压缩（压缩会把来源挪到错误气泡）');
  assert.deepEqual(m[0].map((s) => s.url), ['https://a.com/1']);
  assert.deepEqual(m[1].map((s) => s.url), ['https://b.com/2']);
  assert.deepEqual(m[2].map((s) => s.url), ['https://c.com/3']);
  const dup = news.mergeSegmentSources(
    [[{ title: 'A', snippet: '', url: 'https://a.com/1' }]],
    [[{ title: 'A 的另一家转载', snippet: '', url: 'https://a.com/1' }]],
  );
  assert.equal(dup[0].length, 1, '同一条（同 URL）只留一份');
  assert.equal(news.mergeSegmentSources(null, null), null);
});


test('mapCitesToSegments：标记按偏移落到对应的段落（＝气泡）', () => {
  const clean = '第一段 。\n\n第二段。\n\n第三段 。';
  const cites = [{ n: 1, at: 4 }, { n: 3, at: clean.length - 1 }];
  const map = news.mapCitesToSegments(clean, cites);
  assert.deepEqual([...map.keys()].sort(), [0, 2], '第 2 段没有标记，不该出现在表里');
  assert.deepEqual(map.get(0), [1]);
  assert.deepEqual(map.get(2), [3]);
  // 空段不占气泡号：连续空行与前端分段器同一口径
  const map2 = news.mapCitesToSegments('A\n\n\n\nB [[2]]', [{ n: 2, at: 6 }]);
  assert.deepEqual(map2.get(1), [2], 'B 是第 2 条气泡');
  assert.equal(news.mapCitesToSegments(clean, []).size, 0);
});

test('matchSnapshotSources：没有链接/非公网链接的条目不算来源', () => {
  const items = [
    { title: '只有标题没有链接', url: '' },
    { title: '内网条目', url: 'http://127.0.0.1/secret' },
  ];
  assert.deepEqual(news.matchSnapshotSources('只有标题没有链接，内网条目', items), []);
  assert.deepEqual(news.matchSnapshotSources('', items), []);
});
