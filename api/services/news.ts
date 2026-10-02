/**
 * 实时热点与新闻服务（轻量版）
 * 为「聊一聊」注入实时资讯背景，让 AI 能聊国内外大小事 / 热点 / 新闻
 * 数据源（免费、无需 API key）：微博热搜 + Google News 中文头条 + Google News 英文头条
 * 缓存 15 分钟；任一源失败静默降级，不影响聊天主流程
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * 快照里的一条资讯：标题 + 它自己的链接（+ 展示域名）。
 * 为什么快照必须带链接（2026-09-29）：以前这里只有标题，于是「今天有什么新闻？」这种
 * 直接从快照回答的回合**一条来源都给不出**（那几个回合根本没调 web_search），用户只能看到一个
 * 光秃秃的结论。链接在抓取时本来就有（Google News 的 <item><link> / 微博热搜的搜索页），丢掉了而已。
 */
export interface SnapshotItem { title: string; url: string; host?: string; }

interface Snapshot { text: string; items: SnapshotItem[]; at: number; }

let cache: Snapshot | null = null;
let inflight: Promise<void> | null = null;
const TTL = 15 * 60 * 1000; // 15 分钟
const TIMEOUT = 6000;       // 单源超时（并行拉取，总耗时≈最慢一个源）

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
}

async function httpText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

/**
 * 解析 RSS 的 item（只在 <item> 块内取，避免 channel/其他元素的标题泄漏）：标题 + 链接 + 发布方域名。
 * 链接是必须留的（见 SnapshotItem）：以前这里只返回标题，等于把每条新闻的出处当场丢掉。
 */
function rssItems(xml: string, limit: number): SnapshotItem[] {
  const out: SnapshotItem[] = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    if (out.length >= limit) break;
    const m = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item);
    if (!m || !m[1]) continue;
    const rawTitle = stripTags(m[1]);
    const title = stripSource(rawTitle);
    if (!title) continue;
    const linkM = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(item);
    const url = linkM ? stripTags(linkM[1]) : '';
    const host = rssPublisherHost(item, rawTitle);
    out.push({ title, url, ...(host ? { host } : {}) });
  }
  return out;
}

/** 去掉 Google News 标题尾部的「 - 来源」，让注入给 AI 的数据更干净 */
function stripSource(title: string): string {
  return title.replace(/\s[-–—]\s[^-–—]+$/, '').trim();
}

async function fetchWeibo(): Promise<SnapshotItem[]> {
  const json = await httpText('https://weibo.com/ajax/side/hotSearch', { Referer: 'https://weibo.com' });
  if (!json) return [];
  try {
    const o = JSON.parse(json);
    const list: any[] = o?.data?.realtime || [];
    return list.slice(0, 10)
      .map((d) => String(d?.word || '').replace(/#/g, '').trim())
      .filter(Boolean)
      // 每条热搜的落点＝它的微博搜索页（话题格式 %23词%23）。这是**真实可打开的**链接，
      // 不是编的：拿不到就不放来源（界面回落到没有来源行），绝不猜一个网址出来。
      // 落点用**手机版搜索页**（m.weibo.cn）：2026-09-29 用没登录过的干净浏览器实测
      // s.weibo.com 的搜索页对未登录用户**只有登录墙**（整页 77 字、连关键词都不出现），
      // 而 m.weibo.cn 的搜索结果不登录就能看到该话题的真实帖子（2708 字、关键词命中）。
      // 「要登录才看得到的来源」等于没有来源。这个地址是实测出来的，不是照文档猜的。
      // 也刻意**不写 host**：几条热搜属于不同的搜索页，写 host 会被「按发布方去重」收敛成一条。
      .map((word) => ({ title: word, url: 'https://m.weibo.cn/search?containerid=' + encodeURIComponent('100103type=1&q=' + word) }));
  } catch {
    return [];
  }
}

async function fetchNews(): Promise<SnapshotItem[]> {
  const feeds = [
    'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans', // 中文头条（国内 + 国际）
    'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',      // 英文头条（国际）
  ];
  // 并行拉取两个 feed：serverless 每次冷启动无缓存，串行等待会明显拖慢聊天
  const results = await Promise.all(feeds.map((f) => httpText(f)));
  const all: SnapshotItem[] = [];
  for (const xml of results) all.push(...rssItems(xml, 8));
  return all;
}

async function buildSnapshot(): Promise<{ text: string; items: SnapshotItem[] }> {
  const [weibo, news] = await Promise.all([fetchWeibo(), fetchNews()]);
  const lines: string[] = [];
  const d = new Date();
  lines.push('（更新于 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '）');
  // ⚠️ 注入给模型的文本**只有标题、不含网址**（加网址既会撑长 prompt，又可能让模型把一长串跳转地址写进聊天）。
  // 但每条前面要带**编号**：模型转述某一条时用 `[[n]]` 声明引用谁，服务端据此把出处挂到那条气泡下。
  // 这是 2026-09-29 第三轮定下的做法，归属必须由模型显式声明，不能靠文字匹配（意译就全落空）。
  const items = [...weibo, ...news];
  if (weibo.length) {
    lines.push('微博热搜：');
    weibo.forEach((it, i) => lines.push('[' + (i + 1) + '] ' + it.title));
  }
  if (news.length) {
    lines.push('新闻头条（中英）：');
    news.forEach((it, i) => lines.push('[' + (weibo.length + i + 1) + '] ' + it.title));
  }
  return { text: lines.join('\n'), items };
}

async function refresh(): Promise<void> {
  try {
    const built = await buildSnapshot();
    if (built.text) cache = { text: built.text, items: built.items, at: Date.now() };
    else console.warn('⚠️ [News] 实时资讯拉取结果为空（微博 / Google News 均失败？）');
  } catch (e) {
    console.warn('⚠️ [News] 实时资讯拉取失败:', (e as Error)?.message || e);
  }
}

/** 获取实时资讯快照（优先缓存；过期/无缓存时刷新，失败返回空串），只要文本的旧调用口。 */
export async function getNewsSnapshot(): Promise<string> {
  return (await getNewsSnapshotDetailed()).text;
}

/**
 * 获取实时资讯快照的**文本 + 结构化条目**（2026-09-29）：
 * 文本照旧注入 system（给模型看），条目交给调用方在回复生成后**按实际引用**挑出出处（给界面看）。
 */
export async function getNewsSnapshotDetailed(): Promise<{ text: string; items: SnapshotItem[] }> {
  if (cache && Date.now() - cache.at < TTL) return { text: cache.text, items: cache.items };
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  // 新闻只是背景知识：最多等 2.5s，拉取慢/卡住也绝不让聊天挂住（返回已有缓存或空串）
  await Promise.race([inflight, new Promise((r) => setTimeout(r, 2500))]);
  return cache ? { text: cache.text, items: cache.items } : { text: '', items: [] };
}

/** 匹配前的归一化：只留字母/数字/汉字，去掉空白与标点（全角半角、空格差异不该影响判断）。 */
function normalizeForMatch(s: string): string {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 回复的**段落拆分口径**（2026-09-29）：段＝气泡。
 * ⚠️ 这是**三边共用**的规则：服务端（来源按段归属）、前端分段发送器（ChatPage runReveal）、
 * 前端历史还原（src/lib/chatServerMessages.ts）。改任何一边都必须同时改另外两边，
 * 否则来源会挂到错误的气泡上（或整条来源行错位一条）。
 */
export function splitReplySegments(reply: string): string[] {
  return String(reply || '').split('\n\n').map((p) => p.trim()).filter(Boolean);
}

/**
 * 标题是否出现在这段文字里（归一化后比较）：短标题（<8 字）要求整串，长标题按 4 字滑窗（命中 ≥2 且覆盖 ≥50%）。
 * 判据刻意保守，宁可少给，也不把出处挂到错误的那条气泡上。
 */
function titleMatchesSegment(normSeg: string, title: string): boolean {
  const t = normalizeForMatch(title);
  if (!t || !normSeg) return false;
  if (t.length < 8) return normSeg.includes(t);
  let wins = 0;
  let found = 0;
  for (let i = 0; i + 4 <= t.length; i++) {
    wins++;
    if (normSeg.includes(t.slice(i, i + 4))) found++;
  }
  return wins > 0 && found >= 2 && found * 2 >= wins;
}

/**
 * 从回复里**认出它真正引用了快照里的哪几条**（2026-09-29）。
 *
 * 为什么不能整份快照都当来源：newsBlock 是**每一轮**都注入的固定背景，若「有快照就挂来源」，
 * 那么「我今天很难过」这种跟新闻毫无关系的回复下面也会挂一排新闻链接，挂错出处比不挂更伤。
 * 只认 http(s) 公网链接（与 pickSources 同一把尺子）。
 */
export function matchSnapshotSources(reply: string, items: SnapshotItem[], max = 3): WebResult[] {
  const text = normalizeForMatch(reply);
  if (!text) return [];
  const out: WebResult[] = [];
  for (const it of items || []) {
    if (!it?.title || !it?.url || !isSafeHttpUrl(it.url)) continue;
    if (!titleMatchesSegment(text, it.title)) continue;
    out.push({ title: it.title, snippet: '', url: it.url, ...(it.host ? { host: it.host } : {}) });
    if (out.length >= max) return out;
  }
  return out;
}

/**
 * 快照引用**按段落**归属（2026-09-29）：每段就是一条气泡，数组与段落一一对应，没命中的为 null。
 * 为什么必须按段落：用户要的是「讲这条新闻的那条气泡下面挂这条新闻的来源」，
 * 而不是把整轮命中的来源都堆在最后一条气泡上。
 */
export function matchSnapshotSourcesBySegment(reply: string, items: SnapshotItem[]): (WebResult[] | null)[] {
  return splitReplySegments(reply).map((seg) => {
    const hit = matchSnapshotSources(seg, items);
    return hit.length ? hit : null;
  });
}

/**
 * 把模型声明的引用标记**映射到段落**（＝气泡）：返回 段下标 → 编号列表。
 *
 * `at` 是标记在**剥掉标记后的正文**里的字符偏移（见 chatSignal.extractCitations）；
 * 这里按 splitReplySegments 的同一套拆分口径算每段的字符区间，把偏移落进哪一段就归哪一段。
 * 空段不占气泡号（与前端分段发送器一致），落进空段的标记归到前一条气泡。
 */
export function mapCitesToSegments(text: string, cites: { n: number; at: number }[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!cites?.length) return out;
  const parts = String(text || '').split('\n\n');
  const spans: { start: number; end: number; bubble: number }[] = [];
  let cursor = 0;
  let bubble = -1;
  for (const p of parts) {
    const start = cursor;
    const end = cursor + p.length;
    if (p.trim()) bubble++;
    spans.push({ start, end, bubble });
    cursor = end + 2;
  }
  for (const c of cites) {
    let hit = -1;
    for (const sp of spans) {
      if (sp.bubble >= 0 && c.at >= sp.start && c.at <= sp.end) { hit = sp.bubble; break; }
      if (c.at < sp.start) break;
    }
    if (hit < 0) continue;
    const cur = out.get(hit) || [];
    if (!cur.includes(c.n)) cur.push(c.n);
    out.set(hit, cur);
  }
  return out;
}

/**
 * 把**一组来源**（web_search 的命中）按段落归位（2026-09-29 第三轮）：
 * 一条来源只挂到**提到它的那条气泡**上。
 *
 * 为什么需要：搜索命中原先整组挂在最后一条气泡上，模型常常在前面几条气泡里分别讲了不同的新闻，
 * 结果最后一条下面挤着一排和它无关的出处（用户实测反馈）。
 *
 * 归属证据（从硬到软）：
 *   ① 这一段正文里出现了这个 URL（模型自己写出来的，最硬）；
 *   ② 这一段出现了该来源的展示域名/主机名（如 sina.com.cn）；
 *   ③ 标题判据（与 matchSnapshotSources 完全同一套）。
 * 一条都归不上 → 返回 **null**（≠ 空数组）：调用方据此**退回整轮挂最后一条**，
 * 绝不因为归不上就把来源整批丢掉。
 */
export function attributeSourcesBySegment(reply: string, sources: WebResult[], maxPerSegment = 3): (WebResult[] | null)[] | null {
  const segs = splitReplySegments(reply);
  if (!segs.length || !sources?.length) return null;
  const norms = segs.map(normalizeForMatch);
  const loose = segs.map((s) => s.toLowerCase().replace(/\s+/g, ''));
  const out: (WebResult[] | null)[] = segs.map(() => null);
  let placed = 0;
  for (const src of sources) {
    if (!src?.url || !isSafeHttpUrl(src.url)) continue;
    const urlLoose = src.url.toLowerCase().replace(/\s+/g, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    const host = (src.host || hostOf(src.url) || '').toLowerCase();
    let hit = -1;
    for (let j = 0; j < segs.length; j++) {
      const byUrl = !!urlLoose && loose[j].includes(urlLoose);
      const byHost = !!host && loose[j].includes(host);
      if (byUrl || byHost || titleMatchesSegment(norms[j], src.title)) { hit = j; break; }
    }
    if (hit < 0) continue;
    const cur = out[hit] || (out[hit] = []);
    if (cur.length >= maxPerSegment || cur.some((x) => x.url === src.url)) continue;
    cur.push({ title: src.title, snippet: src.snippet || '', url: src.url, ...(src.host ? { host: src.host } : {}) });
    placed++;
  }
  return placed > 0 ? out : null;
}

/**
 * 合并两条「按段来源」通道（搜索命中 / 快照引用）：段下标对齐、同一段按 URL 去重。
 * ⚠️ 长度取两者较长者并保留 null 占位，位置就是气泡序号，压缩会把来源挂错气泡。
 */
export function mergeSegmentSources(a: (WebResult[] | null)[] | null, b: (WebResult[] | null)[] | null): (WebResult[] | null)[] | null {
  if (!a && !b) return null;
  const len = Math.max(a?.length || 0, b?.length || 0);
  const out: (WebResult[] | null)[] = [];
  for (let i = 0; i < len; i++) {
    const cur: WebResult[] = [];
    for (const s of [...(a?.[i] || []), ...(b?.[i] || [])]) {
      if (!s?.url || cur.some((x) => x.url === s.url)) continue;
      cur.push(s);
    }
    out.push(cur.length ? cur : null);
  }
  return out;
}

// 服务启动时预热一次，确保聊一聊第一时间就有资讯可用
void refresh();

// ================= 按需搜索（针对用户具体问题，如「奥德赛票房多少」「云南芒市有什么美食」「小红书 攻略」） =================

/** 归一化的网页搜索结果（标题 + 摘要 + 链接），供 AI 汇总转述并标注来源。 */
export interface WebResult {
  title: string;
  snippet: string;
  url: string;
  /**
   * **展示用**域名（发布方），与 `url` 的域名可能不同，见 rssPublisherHost。
   * 为什么需要：Google News 的 `<link>` 是 news.google.com 的跳转地址（点开仍会到原文，但域名不是发布方），
   * 直接拿 url 的域名做「来源」会渲染成一排 news.google.com，看着像坏了。缺省 = 认不出发布方，界面回落到 url 的域名。
   */
  host?: string;
}

function htmlToText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 把 DuckDuckGo 的跳转地址还原成真实链接（href 走 uddg 参数时）。 */
function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* 保留原始 href */ }
  }
  return href;
}

/** 解析 DuckDuckGo HTML：取「标题 + 摘要 + 链接」，稳健且带量限制。 */
export function parseDdgResults(html: string, limit = 5): WebResult[] {
  const out: WebResult[] = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) && out.length < limit) {
    const title = htmlToText(m[1]);
    if (!title) continue;
    const hrefM = /href="([^"]*)"/.exec(m[0]);
    const url = hrefM ? decodeDdgHref(hrefM[1]) : '';
    const after = html.slice(m.index + m[0].length);
    const sn = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(after);
    const snippet = sn ? htmlToText(sn[1]).slice(0, 160) : '';
    out.push({ title, snippet, url });
  }
  return out;
}

/** 取 URL 的展示域名（去 www.、小写）；解析不了返回空串（**不猜**）。 */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

/**
 * RSS 条目的**发布方域名**（展示用）。Google News 的 `<link>` 是 news.google.com 的跳转地址，
 * 拿它当来源域名等于没给信息，所以另找发布方：
 *   ① 标准 RSS 的 `<source url="https://www.sina.com.cn">新浪新闻</source>`；
 *   ② Google News **搜索源**的写法：发布方域名直接挂在标题末尾（`… - finance.sina.com.cn`）。
 *   两者都拿不到 → undefined（界面回落到链接自身域名，绝不猜一个出来）。
 */
function rssPublisherHost(item: string, rawTitle: string): string | undefined {
  const srcM = /<source[^>]*\burl="([^"]+)"/i.exec(item);
  const fromSource = srcM ? hostOf(srcM[1]) : '';
  if (fromSource) return fromSource;
  const suffix = /\s[-–—]\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s*$/i.exec(rawTitle);
  return suffix ? suffix[1].replace(/^www\./i, '').toLowerCase() : undefined;
}

/** 解析 RSS 的 item，取「标题 + 链接 (+ 发布方域名)」。 */
function parseRssItems(xml: string, limit: number): WebResult[] {
  const out: WebResult[] = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    if (out.length >= limit) break;
    const titleM = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item);
    const linkM = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(item);
    if (!titleM) continue;
    const rawTitle = stripTags(titleM[1]);
    const title = stripSource(rawTitle);
    if (!title) continue;
    const host = rssPublisherHost(item, rawTitle);
    out.push({ title, snippet: '', url: linkM ? stripTags(linkM[1]) : '', ...(host ? { host } : {}) });
  }
  return out;
}

function formatResults(list: WebResult[], tag: string): string {
  const lines = list.map((r) => {
    const body = r.snippet ? '，' + r.snippet : '';
    const src = r.url ? '（' + r.url + '）' : '';
    return '- ' + r.title + body + src;
  });
  return tag + '：\n' + lines.join('\n');
}

async function searchWikipedia(query: string, limit: number): Promise<WebResult[]> {
  const json = await httpText(
    'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&srlimit=' + limit,
    { 'Accept': 'application/json' }
  );
  if (!json) return [];
  try {
    const o = JSON.parse(json);
    return (o?.query?.search || []).map((r: any) => ({
      title: htmlToText(String(r?.title || '')),
      snippet: htmlToText(String(r?.snippet || '')).slice(0, 120),
      url: r?.title ? 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(String(r.title)) : '',
    })).filter((r: any) => r.title);
  } catch {
    return [];
  }
}

async function searchGoogleNews(query: string, limit: number): Promise<WebResult[]> {
  const xml = await httpText('https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans');
  return parseRssItems(xml, limit);
}

async function searchDuckDuckGo(query: string, site: string, limit: number): Promise<WebResult[]> {
  const siteQ = site ? ' site:' + site : '';
  const html = await httpText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query + siteQ));
  if (!html) return [];
  return parseDdgResults(html, limit);
}

/** 带超时的 POST JSON 封装，返回解析后的 JSON；失败/超时/非 2xx 返回 null。 */
async function postJson(url: string, body: any): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 读取 Tavily API key（动态读 env，便于测试/运行切换）。 */
function tavilyKey(): string {
  return (process.env.TAVILY_API_KEY || '').trim();
}

/** 用 Tavily 搜索（需 TAVILY_API_KEY），返回「标题+摘要+链接」。 */
async function searchTavily(query: string, site: string, limit: number): Promise<WebResult[]> {
  const key = tavilyKey();
  if (!key) return [];
  const q = site ? query + ' site:' + site : query;
  const json = await postJson('https://api.tavily.com/search', {
    api_key: key, query: q, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false,
  });
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.slice(0, limit).map((r: any) => ({
    title: htmlToText(String(r?.title || '')),
    snippet: htmlToText(String(r?.content || '')).slice(0, 300),
    url: String(r?.url || ''),
  })).filter((r: any) => r.title);
}

/** 用 Tavily 提取若干 URL 的正文（需 key）。返回 raw_content 列表。 */
async function tavilyExtract(urls: string[]): Promise<string[]> {
  const key = tavilyKey();
  if (!key || !urls.length) return [];
  const json = await postJson('https://api.tavily.com/extract', {
    api_key: key, urls: urls.slice(0, 5), include_images: false,
  });
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.map((r: any) => String(r?.raw_content || '')).filter(Boolean);
}

/**
 * SSRF 防护：只允许 http/https 的**公网**目标。
 *
 * 2026-09-28 审查 B3 重写。旧实现是字符串黑名单，实测被绕过：
 *   http://localhost./          尾部点（FQDN 写法，DNS 仍解析到 127.0.0.1，但 host 不等于 'localhost'）
 *   http://[::ffff:127.0.0.1]/  IPv4-mapped IPv6
 *   http://[fd00::1]/           ULA（唯一本地地址）
 * 现在按**解析后的地址**判定：IPv4 逐段判私网/回环/链路本地/CGNAT/保留段；IPv6 字面量先拆括号、
 * 去 zone，再判 ::1 / fc00::/7 / fe80::/10，并把 ::ffff:a.b.c.d 里的 IPv4 解出来再判一次。
 *
 * ⚠️ 仍未覆盖 DNS 重绑定（域名解析到公网、连接时切到内网）：彻底解决要在 check 与 connect 之间
 * 固定解析结果（pinned dispatcher）。当前先堵住「字面量 + 尾部点」这类确定性绕过。
 */
export function publicHttpUrlReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'bad_url'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad_scheme';
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // 尾部点规范化后再判（否则 localhost. 直接漏过）
  if (!host) return 'bad_host';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'local_host';
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIpv6(host.slice(1, -1)) ? 'private_ipv6' : null;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host) ? 'private_ipv4' : null;
  return null;
}

/** IPv4 私网/回环/链路本地/CGNAT/保留段（输入为点分四段）。 */
function isPrivateIpv4(host: string): boolean {
  const p = host.split('.').map(Number);
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 形状可疑 → 拒绝
  const a = p[0], b = p[1];
  if (a === 0 || a === 10 || a === 127) return true;        // 本网络 / 私网 / 回环
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;                  // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;         // 私网
  if (a === 192 && b === 168) return true;                  // 私网
  if (a === 192 && (b === 0 || b === 2)) return true;       // 192.0.0/24 + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;     // 198.18/15 基准测试
  if (a === 198 && b === 51) return true;                   // TEST-NET-2
  if (a === 203 && b === 0) return true;                    // TEST-NET-3
  if (a >= 224) return true;                                // 组播 + 保留
  return false;
}

/** 把 IPv6 字面量解析成 16 个字节；解析不出来返回 null（调用方按「拒绝」处理）。 */
function ipv6ToBytes(host: string): number[] | null {
  const h = host.split('%')[0].toLowerCase(); // 去 zone id
  if (h.includes('.')) {
    // 含点分 IPv4 的写法（如 ::ffff:127.0.0.1）→ 先把末段折成两个 16 位组再递归
    const i = h.lastIndexOf(':');
    const p = h.slice(i + 1).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const head = h.slice(0, i + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    return ipv6ToBytes(head);
  }
  const parts = h.split('::');
  if (parts.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 255, n & 255);
    }
    return out;
  };
  const head = parse(parts[0]);
  if (head === null) return null;
  if (parts.length === 1) return head.length === 16 ? head : null;
  const tail = parse(parts[1]);
  if (tail === null || head.length + tail.length > 14) return null;
  return [...head, ...new Array(16 - head.length - tail.length).fill(0), ...tail];
}

/**
 * IPv6 是否属于「本机/内网」（输入为已去方括号的字面量）。
 * 关键：Node 的 URL 会把 `::ffff:127.0.0.1` **规范化成 `::ffff:7f00:1`**，
 * 所以不能只匹配点分写法，必须按字节判 IPv4-mapped / IPv4-compatible（2026-09-28 审查 B3 实测）。
 */
function isPrivateIpv6(host: string): boolean {
  const b = ipv6ToBytes(host);
  if (!b) return true;                                    // 解析不出来 → 保守拒绝
  if (b.every((x) => x === 0)) return true;               // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  const mapped = b[10] === 0xff && b[11] === 0xff;        // ::ffff:a.b.c.d
  const compat = b[10] === 0 && b[11] === 0;              // ::a.b.c.d（已废弃写法，同样指向 IPv4）
  if (first10Zero && (mapped || compat) && b.slice(12).some((x) => x !== 0)) {
    if (isPrivateIpv4(b.slice(12).join('.'))) return true;
  }
  if ((b[0] & 0xfe) === 0xfc) return true;                // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  return false;
}

/** 只允许 http/https，并拦下本地/内网/回环/链路本地等潜在 SSRF 目标。 */
export function isSafeHttpUrl(rawUrl: string): boolean {
  return publicHttpUrlReason(rawUrl) === null;
}

/**
 * 跟重定向抓取，但**每一跳都重新校验**目标（2026-09-28 审查 B3）。
 *
 * 为什么必须自己跟：`redirect: 'follow'` 只在**首次** URL 上做过校验，一个公网短链 302 到
 * http://127.0.0.1:3001/... 就能把内网内容读回给调用方。这里改成 `redirect: 'manual'`，
 * 逐跳校验 Location 后再继续，最多 maxHops 跳。
 */
export async function fetchPublicUrl(rawUrl: string, init?: RequestInit, maxHops = 3): Promise<Response> {
  let current = new URL(rawUrl).href;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const reason = publicHttpUrlReason(current);
    if (reason) throw new Error('unsafe_url:' + reason);
    const res = await fetch(current, { ...(init || {}), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).href;
      try { void res.body?.cancel(); } catch { /* 忽略 */ }
      continue;
    }
    return res;
  }
  throw new Error('too_many_redirects');
}
/** 把 HTML 转成可读纯文本：先去 script/style，再去标签、解实体、压空白。 */
export function pageToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** 读取一个网页正文（优先 Tavily extract，退回直连抓取 + HTML 解析）。返回纯文本摘要（含截断提示）。 */
export async function fetchUrlText(rawUrl: string, maxChars = 4000): Promise<string> {
  const raw = (rawUrl || '').trim();
  if (!raw) return '请提供要读取的链接。';
  if (!isSafeHttpUrl(raw)) return '这个链接我不方便读取（仅支持 http/https 的公开网页）。';
  const url = new URL(raw).href; // 规范化 + 百分号编码非 ASCII 路径（否则 fetch/Tavily 对中文 URL 会失败）
  if (tavilyKey()) {
    const extracted = await tavilyExtract([url]);
    if (extracted[0]) {
      const text = pageToText(extracted[0]).slice(0, maxChars);
      return '【链接内容】' + url + '\n\n' + text + (pageToText(extracted[0]).length > maxChars ? '\n\n（内容较长，已截断）' : '');
    }
  }
  const html = await httpText(url, { Referer: url });
  if (!html) return '暂时读不到这个链接的内容，可能是需要登录或页面无法访问。';
  const text = pageToText(html).slice(0, maxChars);
  if (!text) return '这个页面没有可读正文，可能是需要登录或纯图片/视频页。';
  return '【链接内容】' + url + '\n\n' + text + (pageToText(html).length > maxChars ? '\n\n（内容较长，已截断）' : '');
}

export interface WebSearchOptions { site?: string; limit?: number; }

/** 一路搜索的结果分组（组名就是给模型看的标签，如「维基百科」「新闻」「网页搜索」）。 */
export interface WebSearchGroup { label: string; results: WebResult[]; }

/**
 * 搜索的**结构化**结果（2026-09-29 抽出）。
 *
 * 为什么要把「给模型的文本」和「给界面的来源」一起返回：聊一聊的 `web_search` 一直只把格式化文本喂给模型，
 * 前端只收到一个布尔 `search` 事件，于是「链接」能不能出现，全看模型愿不愿意在正文里写 URL，
 * 用户不问就常常没有。这里把**命中的原始结果**一并交出来：调用方照旧喂模型文本，同时可把来源结构化下发前端
 * （气泡下的「来源」行），不必再从格式化文本里反解 URL。
 *
 * 纯抽取：`text` 与抽出前 `searchWeb` 的返回值**逐字一致**（searchWeb 现在只是这个函数的一层薄壳），
 * 因此不存在「同一句话搜两次」的额外抓取。
 */
export async function searchWebDetailed(query: string, opts: WebSearchOptions = {}): Promise<{ text: string; sources: WebResult[]; groups: WebSearchGroup[] }> {
  const q = (query || '').trim().slice(0, 100);
  if (!q) return { text: '', sources: [], groups: [] };
  const site = (opts?.site || '').trim();
  const limit = Math.max(1, Math.min(8, opts?.limit || 5));
  const groups: WebSearchGroup[] = [];
  // 配了 Tavily → 优先用它（结果更全、含正文）；无 key / 失败再回落免费源（与改造前分支完全一致）
  if (tavilyKey()) {
    const tav = await searchTavily(q, site, limit);
    if (tav.length) groups.push({ label: '网页搜索', results: tav });
  }
  if (!groups.length) {
    const [wiki, gnews, ddg] = await Promise.all([searchWikipedia(q, limit), searchGoogleNews(q, limit), searchDuckDuckGo(q, site, limit)]);
    if (wiki.length) groups.push({ label: '维基百科', results: wiki });
    if (gnews.length) groups.push({ label: '新闻', results: gnews });
    if (ddg.length) groups.push({ label: '网页搜索', results: ddg });
  }
  return {
    text: groups.map((g) => formatResults(g.results, g.label)).join('\n\n'),
    sources: pickSources(groups),
    groups,
  };
}

/**
 * 从分组里挑出**可点、可去重**的来源（给界面用）：
 * 只要 http/https 公网链接 + 有标题，按命中顺序（=相关性顺序）保留，最多 `max` 条。
 * 用 `isSafeHttpUrl` 同一把尺子：界面上点开的链接不该出现 `javascript:`/内网这类东西。
 * 去重口径见函数内注释（认得出发布方就按发布方去重）。
 */
export function pickSources(groups: WebSearchGroup[], max = 5): WebResult[] {
  const out: WebResult[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const r of g.results || []) {
      const title = (r?.title || '').trim();
      const raw = (r?.url || '').trim();
      if (!title || !raw || !isSafeHttpUrl(raw)) continue;
      let key = '';
      try { key = new URL(raw).href; } catch { continue; }
      /**
       * 去重口径（2026-09-29）：**认得出发布方就按发布方去重**，否则按链接去重。
       *   · 认得出（RSS 的 `<source>` / Google News 标题后缀）→ 同一家只留最相关的那一条：
       *     来源行要回答「哪几家说了」，而不是「哪几篇」；
       *   · 认不出（普通网页搜索 / 维基）→ 退回按 URL 去重，免得把同一站点的不同页面全砍成一条。
       */
      const host = (r.host || '').toLowerCase();
      const dedupeKey = host ? 'h:' + host : 'u:' + key;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ title, snippet: r.snippet || '', url: key, ...(host ? { host } : {}) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 针对用户问题做实时搜索，返回「标题 + 摘要 + 链接」的格式化文本（任一源失败自动跳过；全部失败返回空串）。 */
export async function searchWeb(query: string, opts: WebSearchOptions = {}): Promise<string> {
  return (await searchWebDetailed(query, opts)).text;
}
