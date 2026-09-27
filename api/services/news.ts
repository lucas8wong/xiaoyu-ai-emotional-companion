/**
 * 实时热点与新闻服务（轻量版）
 * 为「聊一聊」注入实时资讯背景，让 AI 能聊国内外大小事 / 热点 / 新闻
 * 数据源（免费、无需 API key）：微博热搜 + Google News 中文头条 + Google News 英文头条
 * 缓存 15 分钟；任一源失败静默降级，不影响聊天主流程
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface Snapshot { text: string; at: number; }

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

/** 解析 RSS 的 item 标题（只在 <item> 块内取，避免 channel/其他元素的标题泄漏） */
function rssTitles(xml: string, limit: number): string[] {
  const out: string[] = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    if (out.length >= limit) break;
    const m = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item);
    if (m && m[1]) {
      const t = stripSource(stripTags(m[1]));
      if (t) out.push(t);
    }
  }
  return out;
}

/** 去掉 Google News 标题尾部的「 - 来源」，让注入给 AI 的数据更干净 */
function stripSource(title: string): string {
  return title.replace(/\s[-–—]\s[^-–—]+$/, '').trim();
}

async function fetchWeibo(): Promise<string[]> {
  const json = await httpText('https://weibo.com/ajax/side/hotSearch', { Referer: 'https://weibo.com' });
  if (!json) return [];
  try {
    const o = JSON.parse(json);
    const list: any[] = o?.data?.realtime || [];
    return list.slice(0, 10).map((d) => String(d?.word || '').replace(/#/g, '')).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchNews(): Promise<string[]> {
  const feeds = [
    'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans', // 中文头条（国内 + 国际）
    'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',      // 英文头条（国际）
  ];
  // 并行拉取两个 feed：serverless 每次冷启动无缓存，串行等待会明显拖慢聊天
  const results = await Promise.all(feeds.map((f) => httpText(f)));
  const all: string[] = [];
  for (const xml of results) all.push(...rssTitles(xml, 8));
  return all;
}

async function buildSnapshot(): Promise<string> {
  const [weibo, news] = await Promise.all([fetchWeibo(), fetchNews()]);
  const lines: string[] = [];
  const d = new Date();
  lines.push('（更新于 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '）');
  if (weibo.length) lines.push('微博热搜：' + weibo.join('、'));
  if (news.length) lines.push('新闻头条（中英）：' + news.join('；'));
  return lines.join('\n');
}

async function refresh(): Promise<void> {
  try {
    const text = await buildSnapshot();
    if (text) cache = { text, at: Date.now() };
    else console.warn('⚠️ [News] 实时资讯拉取结果为空（微博 / Google News 均失败？）');
  } catch (e) {
    console.warn('⚠️ [News] 实时资讯拉取失败:', (e as Error)?.message || e);
  }
}

/** 获取实时资讯快照（优先缓存；过期/无缓存时刷新，失败返回空串） */
export async function getNewsSnapshot(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL) return cache.text;
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  // 新闻只是背景知识：最多等 2.5s，拉取慢/卡住也绝不让聊天挂住（返回已有缓存或空串）
  await Promise.race([inflight, new Promise((r) => setTimeout(r, 2500))]);
  return cache?.text || '';
}

// 服务启动时预热一次，确保聊一聊第一时间就有资讯可用
void refresh();

// ================= 按需搜索（针对用户具体问题，如「奥德赛票房多少」「云南芒市有什么美食」「小红书 攻略」） =================

/** 归一化的网页搜索结果（标题 + 摘要 + 链接），供 AI 汇总转述并标注来源。 */
export interface WebResult { title: string; snippet: string; url: string; }

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

/** 解析 RSS 的 item，取「标题 + 链接」。 */
function parseRssItems(xml: string, limit: number): WebResult[] {
  const out: WebResult[] = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    if (out.length >= limit) break;
    const titleM = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item);
    const linkM = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(item);
    if (!titleM) continue;
    const title = stripSource(stripTags(titleM[1]));
    if (!title) continue;
    out.push({ title, snippet: '', url: linkM ? stripTags(linkM[1]) : '' });
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

/** 只允许 http/https，并拦下本地/内网/回环/链路本地等潜在 SSRF 目标。 */
export function isSafeHttpUrl(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]' || host.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split('.').map(Number);
    const a = p[0], b = p[1];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
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

/** 针对用户问题做实时搜索，返回「标题 + 摘要 + 链接」的格式化文本（任一源失败自动跳过；全部失败返回空串）。 */
export async function searchWeb(query: string, opts: WebSearchOptions = {}): Promise<string> {
  const q = (query || '').trim().slice(0, 100);
  if (!q) return '';
  const site = (opts?.site || '').trim();
  const limit = Math.max(1, Math.min(8, opts?.limit || 5));
  // 配了 Tavily → 优先用它（结果更全、含正文）；无 key / 失败再回落免费源
  if (tavilyKey()) {
    const tav = await searchTavily(q, site, limit);
    if (tav.length) return formatResults(tav, '网页搜索');
  }
  const [wiki, gnews, ddg] = await Promise.all([searchWikipedia(q, limit), searchGoogleNews(q, limit), searchDuckDuckGo(q, site, limit)]);
  const lines: string[] = [];
  if (wiki.length) lines.push(formatResults(wiki, '维基百科'));
  if (gnews.length) lines.push(formatResults(gnews, '新闻'));
  if (ddg.length) lines.push(formatResults(ddg, '网页搜索'));
  return lines.join('\n\n');
}
