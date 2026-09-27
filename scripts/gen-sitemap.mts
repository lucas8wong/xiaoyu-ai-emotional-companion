/**
 * 生成 public/sitemap.xml —— 由 `src/seo` 注册表派生，**不再手工维护**
 *
 * 背景：过去 sitemap 是手写的，新增内容页容易忘记加进去（收录发现慢半拍）。
 * 现在 sitemap 由注册表 + 固定公开页生成，`test/unit/seoPages.test.ts` 会断言
 * 「sitemap 覆盖注册表里的每一个页面」，从机制上消除漂移。
 *
 * 用法：
 *   tsx scripts/gen-sitemap.mts      # 写入 public/sitemap.xml（vite build 会拷进 dist）
 * 已接入：`npm run build:prod` / `npm run build:seo`（在 vite build 之前跑）
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEO_PAGES,
  SITE_ORIGIN,
  STATIC_SITEMAP_PATHS,
  seoPagePath,
  seoPageUpdated,
} from '../src/seo/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'public', 'sitemap.xml');

/** 固定公开页的 lastmod 与权重（内容页由注册表给日期） */
const STATIC_META: Record<string, { lastmod: string; changefreq: string; priority: string }> = {
  '/': { lastmod: '2026-08-30', changefreq: 'weekly', priority: '1.0' },
  '/faq': { lastmod: '2026-08-30', changefreq: 'monthly', priority: '0.8' },
};

interface Entry {
  loc: string;
  lastmod: string;
  changefreq: string;
  priority: string;
}

const entries: Entry[] = [];

for (const p of STATIC_SITEMAP_PATHS) {
  const meta = STATIC_META[p];
  if (!meta) continue; // 未登记 lastmod 的固定页跳过（避免写入不可信的日期）
  entries.push({
    loc: `${SITE_ORIGIN}${p}`,
    lastmod: meta.lastmod,
    changefreq: meta.changefreq,
    priority: meta.priority,
  });
}

for (const page of SEO_PAGES) {
  entries.push({
    loc: `${SITE_ORIGIN}${seoPagePath(page)}`,
    lastmod: seoPageUpdated(page),
    changefreq: 'monthly',
    // 英文版略高于繁中版（主站），但仍低于首页与 FAQ
    priority: page.lang === 'en' ? '0.7' : '0.6',
  });
}

const body = entries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 scripts/gen-sitemap.mts 自动生成（请勿手工编辑；数据源：src/seo 注册表） -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

writeFileSync(outFile, xml, 'utf8');
console.log(
  `[sitemap] 已写入 ${path.relative(root, outFile)}：${entries.length} 条 URL（固定页 ${STATIC_SITEMAP_PATHS.length} + 内容页 ${SEO_PAGES.length}）`
);
