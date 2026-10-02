/**
 * SEO/GEO 内容页注册表校验（机制性护栏）
 *
 * 这些断言把「内容页必须满足的规矩」固化下来，避免以后新增页面时悄悄破坏：
 *  - 唯一性：slug+语言唯一、URL 唯一
 *  - 长度：title / description / h1 在可收录区间（过长会被搜索结果截断）
 *  - 内容厚度：≥3 个 h2 段 + ≥3 条 FAQ + 有 intro 与 keywords
 *  - 内链：related 指向的 slug 必须真实存在
 *  - 合规红线：不得出现 China / little healing / 医疗承诺类表述（can cure、clinically proven…）
 *  - **每页必须带「陪伴非治疗」类免责表述**（品牌红线②）
 *  - sitemap 必须覆盖注册表里的每一个 URL（先跑 `npm run sitemap`）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEO_PAGES,
  SITE_ORIGIN,
  STATIC_SITEMAP_PATHS,
  findSeoPage,
  seoAlternates,
  seoPagePath,
  seoPageUrl,
  seoRelated,
} from '../../src/seo/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** 把一页的全部可见文案拼成一个字符串（合规扫描用） */
function pageText(p: (typeof SEO_PAGES)[number]): string {
  return [
    p.title,
    p.description,
    p.h1,
    p.intro,
    ...p.sections.flatMap((s) => [s.h2, s.body]),
    ...p.faq.flatMap((f) => [f.q, f.a]),
  ].join('\n');
}

/** 合规红线：阳性医疗承诺 / 品牌禁用词（否定式表述如 "does not cure" 不算命中） */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /China/, why: '品牌红线：对外不提 China（用 from a small city in the East）' },
  { re: /little healing/i, why: '品牌口径：对外统一 gentle healing' },
  { re: /clinically proven/i, why: '不得做医疗承诺' },
  { re: /FDA[-\s]?approved/i, why: '不得做监管背书类承诺' },
  { re: /(can|could|will|really|able to)\s+cure\b/i, why: '不得宣称能治愈' },
  { re: /\bcures?\s+(your|anxiety|depression|trauma|insomnia)/i, why: '不得宣称治愈具体状况' },
  { re: /(?<!不能)(?<!不可)(?<!無法)(?<!无法)(替代|代替|取代)(心理)?(治療|治疗|諮商|咨询|医生|醫師)/, why: '不得宣称可替代专业服务' },
  { re: /(治療|治疗)(焦慮|抑鬱|抑郁|症)/, why: '不得出现治疗病症的表述' },
  { re: /(診斷|诊断)(出|為|为)?(抑鬱|抑郁|焦慮|焦虑|症)/, why: '不得宣称可诊断' },
];

/** 每页必须出现的「陪伴非治疗」类免责表述（任一命中即可） */
const DISCLAIMER_RE =
  /(not a substitute|not therapy|not treatment|not a medical service|not a crisis service|not a real relationship|不是治療|不是治疗|不能取代|不是醫療|不是医疗|不是危機|不是危机|而非治療|而非治疗)/;

/** 长度区间（英文按字符数；中文按字符数但自然更短） */
const LEN = {
  en: { title: [20, 65], desc: [100, 175] },
  'zh-TW': { title: [8, 45], desc: [30, 125] },
} as const;

test('注册表：slug+语言唯一、URL 唯一、语言合法', () => {
  const seenSlug = new Set<string>();
  const seenPath = new Set<string>();
  for (const p of SEO_PAGES) {
    assert.ok(p.lang === 'en' || p.lang === 'zh-TW', `${p.slug}: 非法语言 ${p.lang}`);
    const key = `${p.lang}:${p.slug}`;
    assert.ok(!seenSlug.has(key), `重复的 slug+语言：${key}`);
    seenSlug.add(key);
    const url = seoPagePath(p);
    assert.ok(!seenPath.has(url), `重复的 URL：${url}`);
    seenPath.add(url);
    assert.ok(url.startsWith('/'), `路径必须以 / 开头：${url}`);
  }
  assert.ok(SEO_PAGES.length >= 12, `内容页数量偏少（当前 ${SEO_PAGES.length}），SEO 面太窄`);
});

test('注册表：title / description / h1 长度在可收录区间', () => {
  for (const p of SEO_PAGES) {
    const [tMin, tMax] = LEN[p.lang].title;
    const [dMin, dMax] = LEN[p.lang].desc;
    assert.ok(
      p.title.length >= tMin && p.title.length <= tMax,
      `${p.slug}(${p.lang}) title 长度 ${p.title.length} 不在 ${tMin}-${tMax}：${p.title}`
    );
    assert.ok(
      p.description.length >= dMin && p.description.length <= dMax,
      `${p.slug}(${p.lang}) description 长度 ${p.description.length} 不在 ${dMin}-${dMax}`
    );
    assert.ok(p.h1.length > 0 && p.h1.length <= 80, `${p.slug}: h1 过长或为空`);
    // 中文以字计，天然更短，故下限按语言区分
    const introMin = p.lang === 'en' ? 100 : 70;
    assert.ok(p.intro.length >= introMin, `${p.slug}: intro 太短（首段需要给出可直接引用的答案）`);
    assert.ok(p.keywords.length >= 2, `${p.slug}: 需要至少 2 个目标查询词`);
  }
});

test('注册表：内容厚度（≥3 段 + ≥3 条 FAQ）与内链有效性', () => {
  for (const p of SEO_PAGES) {
    assert.ok(p.sections.length >= 3, `${p.slug}: 只有 ${p.sections.length} 个 h2 段，太薄`);
    for (const s of p.sections) {
      const min = p.lang === 'en' ? 80 : 60;
      assert.ok(s.h2.trim().length > 0 && s.body.trim().length >= min, `${p.slug}: 段落「${s.h2}」内容过短`);
    }
    assert.ok(p.faq.length >= 3, `${p.slug}: 只有 ${p.faq.length} 条 FAQ`);
    for (const f of p.faq) {
      const min = p.lang === 'en' ? 30 : 25;
      assert.ok(f.q.trim().length > 0 && f.a.trim().length >= min, `${p.slug}: FAQ「${f.q}」答案过短`);
    }
    for (const slug of p.related || []) {
      assert.ok(findSeoPage(slug), `${p.slug}: related 指向不存在的 slug「${slug}」`);
    }
    // 内链必须真的渲染得出来（同语言优先、跨语言兜底）
    if ((p.related || []).length > 0) {
      assert.ok(seoRelated(p).length > 0, `${p.slug}: related 声明了却解析不出可渲染的内链`);
    }
  }
});

test('合规红线：无 China / little healing / 医疗承诺类表述', () => {
  for (const p of SEO_PAGES) {
    const text = pageText(p);
    for (const { re, why } of FORBIDDEN) {
      const m = text.match(re);
      assert.ok(!m, `${p.slug} 命中违禁表述「${m?.[0]}」——${why}`);
    }
  }
});

test('合规红线：每页都带「陪伴非治疗」免责表述', () => {
  for (const p of SEO_PAGES) {
    assert.ok(
      DISCLAIMER_RE.test(pageText(p)),
      `${p.slug}: 缺少「陪伴非治疗 / 不能取代专业协助」类免责表述（品牌红线②）`
    );
  }
});

test('hreflang：中英同 slug 互指 + x-default 指向英文版', () => {
  for (const p of SEO_PAGES) {
    const alts = seoAlternates(p);
    const self = alts.find((a) => a.hreflang === (p.lang === 'en' ? 'en' : 'zh-Hant'));
    assert.ok(self, `${p.slug}: 缺少自身语言的 hreflang`);
    assert.strictEqual(self!.href, seoPageUrl(p));

    const other = SEO_PAGES.find((q) => q.slug === p.slug && q.lang !== p.lang);
    if (other) {
      const pair = alts.find((a) => a.hreflang === (other.lang === 'en' ? 'en' : 'zh-Hant'));
      assert.ok(pair, `${p.slug}: 同 slug 的另一语言版本存在，却没有互指 hreflang`);
      assert.strictEqual(pair!.href, seoPageUrl(other));
    }
    const xDefault = alts.find((a) => a.hreflang === 'x-default');
    assert.ok(xDefault, `${p.slug}: 缺少 x-default`);
    assert.ok(xDefault!.href.startsWith(SITE_ORIGIN), 'hreflang 必须用绝对地址');
  }
});

test('sitemap：覆盖注册表每一个 URL（先跑 npm run sitemap）', () => {
  const file = path.join(repoRoot, 'public', 'sitemap.xml');
  let xml = '';
  try {
    xml = readFileSync(file, 'utf8');
  } catch {
    assert.fail('public/sitemap.xml 不存在——请先运行 `npm run sitemap`');
  }
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0, 'sitemap 里没有任何 <loc>');
  for (const p of SEO_PAGES) {
    const url = seoPageUrl(p);
    assert.ok(locs.includes(url), `sitemap 缺少内容页：${url}（请运行 npm run sitemap）`);
  }
  // 反向：sitemap 里的内容页 URL 必须都还在注册表里（防止删页后残留死链）
  const known = new Set(SEO_PAGES.map((p) => seoPageUrl(p)));
  for (const loc of locs) {
    if (!loc.startsWith(SITE_ORIGIN)) continue;
    const rel = loc.slice(SITE_ORIGIN.length);
    // 固定公开页（首页 / FAQ / 隐私政策…）以 STATIC_SITEMAP_PATHS 为准 —— 与生成器同一份真源。
    // 原先这里硬编码 '/ 与 /faq'，于是新增固定页要记得改两处，这次加 /privacy 就漏了一处。
    if (STATIC_SITEMAP_PATHS.includes(rel)) continue;
    if (rel.startsWith('/s/')) continue; // 千世书分享页有意不进 sitemap
    assert.ok(known.has(loc), `sitemap 里的 ${rel} 已不在注册表中（死链，请运行 npm run sitemap）`);
  }
});
