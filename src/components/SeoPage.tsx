/**
 * SEO/GEO 落地内容页渲染组件（公开、预渲染、进 sitemap）
 *
 * 页面**内容**来自 `src/seo/` 注册表（纯数据），本组件只负责渲染 + 注入页面级 SEO 头
 * （title / description / canonical / hreflang / og / JSON-LD）。
 *
 * 设计要点：
 *  - 页面内所有文案都按**页面自己的语言**（`def.lang`）取，不依赖全局 UI 语言
 *    这样预渲染出的静态 HTML 与 URL 一一对应，不会出现「中文 URL 里混英文界面」；
 *  - 进页时把界面语言也切到该页语言（`setLang`，只在 /zh/ 页做），让后续浏览的 App 界面跟随 URL；
 *  - JSON-LD 用 @id 挂到首页已有的 `#website` / `#organization` 实体上，不重复定义；
 *  - 每页底部固定合规免责句（红线：陪伴非治疗）。
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStoredLang, setLang } from '../i18n';
import {
  SITE_ORIGIN,
  findSeoPageByPath,
  seoAlternates,
  seoPageUrl,
  seoRelated,
  type SeoLang,
} from '../seo';

/** 页面外壳文案（按页面语言，不跟全局 UI 语言） */
const UI: Record<SeoLang, {
  back: string;
  faqTitle: string;
  related: string;
  ctaTitle: string;
  ctaSub: string;
  ctaBtn: string;
  disclaimer: string;
  brand: string;
}> = {
  en: {
    back: '← Back to Xiaoyu',
    faqTitle: 'Frequently asked questions',
    related: 'Related reading',
    ctaTitle: 'Try Xiaoyu free — no download',
    ctaSub: 'Every feeling deserves to be understood.',
    ctaBtn: 'Start chatting on Xiaoyu →',
    disclaimer:
      'Xiaoyu is an emotional companion, not a replacement for professional care. If you are in crisis, please contact your local emergency number or a crisis line.',
    brand: 'Xiaoyu',
  },
  'zh-TW': {
    back: '← 回到小愈',
    faqTitle: '常見問題',
    related: '延伸閱讀',
    ctaTitle: '免費試用小愈 — 不用下載',
    ctaSub: '每一種情緒，都值得被理解。',
    ctaBtn: '開始跟小愈聊聊 →',
    disclaimer:
      '小愈是情緒陪伴，不是治療，也不能取代專業協助。若你處於危機，請聯絡當地緊急電話或求助熱線。',
    brand: '小愈',
  },
};

/** 设置/覆盖 head 里的 meta */
function setMeta(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export default function SeoPage({ path: pagePath }: { path: string }) {
  // 按「完整路径」查页（而不是只按 slug），否则 /zh/<slug> 会命中注册表里先出现的英文页
  const def = findSeoPageByPath(pagePath);

  useEffect(() => {
    if (!def) return;
    // URL 决定语言：繁体页把界面语言也切过去（用户点进来就是要看中文）
    if (def.lang === 'zh-TW' && getStoredLang() !== 'zh-TW') setLang('zh-TW');

    const langTag = def.lang === 'zh-TW' ? 'zh-Hant' : 'en';
    const url = seoPageUrl(def);
    document.documentElement.lang = langTag;
    document.title = def.title;
    setMeta('name', 'description', def.description);
    setMeta('property', 'og:title', def.title);
    setMeta('property', 'og:description', def.description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:type', 'article');
    setMeta('property', 'og:locale', def.lang === 'zh-TW' ? 'zh_TW' : 'en_US');

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = url;

    // hreflang：先清掉上一页残留，再写本页的互指标签
    document.head.querySelectorAll('link[data-seo-hreflang]').forEach((n) => n.remove());
    for (const alt of seoAlternates(def)) {
      const l = document.createElement('link');
      l.rel = 'alternate';
      l.hreflang = alt.hreflang;
      l.href = alt.href;
      l.setAttribute('data-seo-hreflang', '1');
      document.head.appendChild(l);
    }
  }, [def]);

  if (!def) {
    return (
      <div id="seo-root" className="min-h-[100dvh] bg-brand pt-6 pb-16">
        <div className="container mx-auto px-4 max-w-3xl">
          <Link to="/" className="text-sm text-primary-text hover:opacity-80">← Xiaoyu</Link>
        </div>
      </div>
    );
  }

  const ui = UI[def.lang];
  const langTag = def.lang === 'zh-TW' ? 'zh-Hant' : 'en';
  const url = seoPageUrl(def);
  const related = seoRelated(def);
  const asPath = (slugOf: string, lang: SeoLang) => (lang === 'en' ? `/${slugOf}` : `/zh/${slugOf}`);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: def.title,
        description: def.description,
        inLanguage: langTag,
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
        about: { '@id': `${SITE_ORIGIN}/#app` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: ui.brand, item: `${SITE_ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: def.h1, item: url },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        isPartOf: { '@id': `${url}#webpage` },
        inLanguage: langTag,
        mainEntity: def.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return (
    <div id="seo-root" className="min-h-[100dvh] bg-brand pt-6 pb-16">
      <div className="container mx-auto px-4 max-w-3xl">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-primary-text hover:text-primary-text/80 mb-6">
          {ui.back}
        </Link>
        <h1 className="font-display text-2xl sm:text-4xl font-bold text-ink leading-tight mb-3">{def.h1}</h1>
        <p className="text-sm sm:text-base text-ink-soft leading-relaxed mb-8">{def.intro}</p>

        {def.sections.map((s) => (
          <section key={s.h2} className="mb-8">
            <h2 className="text-lg sm:text-xl font-bold text-ink mb-2">{s.h2}</h2>
            <p className="text-sm sm:text-base text-ink-soft leading-relaxed">{s.body}</p>
          </section>
        ))}

        <section className="mb-10">
          <h2 className="text-lg sm:text-xl font-bold text-ink mb-4">{ui.faqTitle}</h2>
          {def.faq.map((f) => (
            <div key={f.q} className="mb-4">
              <h3 className="text-sm font-semibold text-ink mb-1">{f.q}</h3>
              <p className="text-sm text-ink-soft leading-relaxed">{f.a}</p>
            </div>
          ))}
        </section>

        {related.length > 0 && (
          <section className="mb-10">
            <h2 className="text-lg sm:text-xl font-bold text-ink mb-3">{ui.related}</h2>
            <ul className="space-y-2">
              {related.map((r) => (
                <li key={`${r.lang}:${r.slug}`}>
                  <Link
                    to={asPath(r.slug, r.lang)}
                    className="text-sm text-primary-text hover:opacity-80 underline decoration-dotted underline-offset-4"
                  >
                    {r.h1}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="rounded-2xl bg-primary-lighter border border-clay-border p-6 text-center">
          <p className="text-lg font-bold text-ink mb-2">{ui.ctaTitle}</p>
          <p className="text-sm text-ink-soft mb-4">{ui.ctaSub}</p>
          <Link to="/" className="inline-block bg-primary-strong text-white px-6 py-3 rounded-full text-sm font-semibold hover:bg-primary transition-all">
            {ui.ctaBtn}
          </Link>
        </div>

        <p className="mt-6 text-xs text-ink-soft/80 leading-relaxed">{ui.disclaimer}</p>

        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      </div>
    </div>
  );
}
