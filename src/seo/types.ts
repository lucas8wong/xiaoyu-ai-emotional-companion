/**
 * SEO/GEO 落地内容页，类型与纯函数工具（**纯数据模块，不含 React**）
 *
 * 为什么要单独拆出这一层：
 *  - `scripts/prerender.mts` 需要在 Node 侧 import 页面清单来生成预渲染路由，
 *    如果清单写在 `.tsx` 组件里就会连带拉起 React 运行时；
 *  - `scripts/gen-sitemap.mts` 同样需要它来生成 sitemap.xml；
 *  - 单测（`test/unit/seoPages.test.ts`）用它做「sitemap ⊇ 注册表 / 长度 / 违禁词」校验。
 *  所以：**页面数据与渲染分离**，「新增一个 SEO 页 = 加一条数据」。
 */
import type { Lang } from '../i18n';

/** 站点根（canonical / sitemap / hreflang 一律用它拼绝对地址） */
export const SITE_ORIGIN = 'https://myxiaoyu.com';

/** 内容页语言：目前英文主站 + 繁体中文（港澳/台湾）两套 */
export type SeoLang = Extract<Lang, 'en' | 'zh-TW'>;

/** 繁体中文内容页的 URL 前缀（英文页保持扁平 /<slug>，不加 /en） */
export const ZH_PREFIX = '/zh';

export interface SeoSection {
  h2: string;
  body: string;
}

export interface SeoFaqItem {
  q: string;
  a: string;
}

export interface SeoPageDef {
  /** URL 路径片段（ASCII、短横线分隔），中英同主题共用同一 slug 以便互指 hreflang */
  slug: string;
  lang: SeoLang;
  /** <title>，建议 ≤ 60 字符 */
  title: string;
  /** meta description，建议 120–160 字符 */
  description: string;
  h1: string;
  /** 首段：一句话直接回答（AEO/GEO 最吃这个结构） */
  intro: string;
  sections: SeoSection[];
  faq: SeoFaqItem[];
  /** 该页瞄准的查询词（内部用，帮助后续复盘，不输出到页面） */
  keywords: string[];
  /** 站内相关页 slug（内链；必须存在于注册表中） */
  related?: string[];
  /** lastmod；缺省用 SEO_CONTENT_UPDATED */
  updated?: string;
}

/** 本批内容的统一更新日期（sitemap lastmod 用） */
export const SEO_CONTENT_UPDATED = '2026-09-15';

/** 页面路径：英文 → /<slug>；繁体 → /zh/<slug> */
export function seoPagePath(page: SeoPageDef): string {
  return page.lang === 'en' ? `/${page.slug}` : `${ZH_PREFIX}/${page.slug}`;
}

/** 页面绝对地址（canonical / sitemap） */
export function seoPageUrl(page: SeoPageDef): string {
  return `${SITE_ORIGIN}${seoPagePath(page)}`;
}

/** hreflang 值为标准语言标签：en / zh-Hant / x-default */
export function hreflangOf(lang: SeoLang): string {
  return lang === 'en' ? 'en' : 'zh-Hant';
}

/** 页面日期（lastmod） */
export function seoPageUpdated(page: SeoPageDef): string {
  return page.updated || SEO_CONTENT_UPDATED;
}
