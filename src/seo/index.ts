/**
 * SEO/GEO 内容页注册表，单一数据源
 *
 * 「新增一个 SEO 页 = 在这里加一条数据」：路由（`src/App.tsx`）、预渲染（`scripts/prerender.mts`）、
 * sitemap（`scripts/gen-sitemap.mts`）全部由本注册表派生，不再各自维护一份清单
 *。避免过去那种「加了页面但忘了进 sitemap / 忘了预渲染」的漂移。
 *
 * 校验（`test/unit/seoPages.test.ts`）：slug 唯一、title/description 长度、
 * sitemap ⊇ 注册表、每个页面必须带合规免责表述、内链 slug 必须存在。
 */
import type { SeoPageDef, SeoLang } from './types';
import { seoPagePath, seoPageUrl, hreflangOf, SEO_CONTENT_UPDATED } from './types';
import { EN_BASICS } from './enBasics';
import { EN_BOUNDARIES } from './enBoundaries';
import { EN_HOWTO } from './enHowTo';
import { EN_ROLEPLAY } from './enRoleplay';
import { ZH_TW_PAGES } from './zhTw';

export { SITE_ORIGIN, ZH_PREFIX, SEO_CONTENT_UPDATED, seoPagePath, seoPageUrl, hreflangOf, seoPageUpdated } from './types';
export type { SeoPageDef, SeoLang, SeoSection, SeoFaqItem } from './types';

export const SEO_PAGES: SeoPageDef[] = [
  ...EN_BASICS,
  ...EN_BOUNDARIES,
  ...EN_HOWTO,
  ...EN_ROLEPLAY,
  ...ZH_TW_PAGES,
];

/** sitemap 里除内容页之外的固定公开页（首页 / FAQ；`/s/*` 分享页有意不进 sitemap，避免薄内容稀释） */
export const STATIC_SITEMAP_PATHS = ['/', '/faq', '/privacy'];

/** 按路径查页（`/zh/<slug>` 或 `/<slug>`） */
export function findSeoPageByPath(pathname: string): SeoPageDef | undefined {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return SEO_PAGES.find((p) => seoPagePath(p) === clean);
}

/** 按 slug（可指定语言）查页 */
export function findSeoPage(slug: string, lang?: SeoLang): SeoPageDef | undefined {
  return SEO_PAGES.find((p) => p.slug === slug && (!lang || p.lang === lang));
}

/**
 * hreflang 互指：本页 + 同 slug 的另一种语言 + x-default（指向英文版）。
 * 只有一种语言版本时不输出 x-default 之外的内容（避免指向不存在的 URL）。
 */
export function seoAlternates(page: SeoPageDef): { hreflang: string; href: string }[] {
  const out: { hreflang: string; href: string }[] = [
    { hreflang: hreflangOf(page.lang), href: seoPageUrl(page) },
  ];
  const other = SEO_PAGES.find((p) => p.slug === page.slug && p.lang !== page.lang);
  if (other) out.push({ hreflang: hreflangOf(other.lang), href: seoPageUrl(other) });
  const en = page.lang === 'en' ? page : other;
  if (en) out.push({ hreflang: 'x-default', href: seoPageUrl(en) });
  return out;
}

/** 站内相关页（优先同语言），用于内链 */
export function seoRelated(page: SeoPageDef, limit = 3): SeoPageDef[] {
  const slugs = page.related || [];
  const same = slugs
    .map((s) => findSeoPage(s, page.lang))
    .filter((p): p is SeoPageDef => !!p);
  const cross = slugs
    .map((s) => findSeoPage(s))
    .filter((p): p is SeoPageDef => !!p && p.lang !== page.lang);
  return [...same, ...cross].slice(0, limit);
}

/** 所有内容页的绝对地址 + lastmod（sitemap 用，英文在前） */
export function seoPageUrls(): { loc: string; lastmod: string }[] {
  return SEO_PAGES.map((p) => ({
    loc: seoPageUrl(p),
    lastmod: p.updated || SEO_CONTENT_UPDATED,
  }));
}
