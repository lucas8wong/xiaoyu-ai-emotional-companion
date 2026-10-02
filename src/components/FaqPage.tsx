/**
 * FAQ 公开页（/faq），SEO 内容页
 * - 路由在隐私同意门之外（公开可访问，利于搜索引擎抓取）
 * - 三语渲染（跟随界面语言），语言切换即时刷新
 * - 注入 FAQPage JSON-LD（按当前语言全量 17 条），title/meta description 随语言更新
 * 红线：陪伴非治疗；危机内容引导专业求助；品牌口径 gentle healing
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import LangSwitch from './LangSwitch';
import BrandHeart from './BrandHeart';
import { getLang, type Lang } from '../i18n';
import { FAQ_ITEMS, FAQ_TITLE, FAQ_META_DESC } from '../faqContent';

/** 更新/新增 head 里的 meta 标签（name 或 property） */
function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export default function FaqPage() {
  const [lang, setLangState] = useState<Lang>(getLang());

  useEffect(() => {
    const cur = getLang();
    const items = FAQ_ITEMS[cur];
    // 页面标题 + meta description（SEO）
    document.title = FAQ_TITLE[cur];
    setMeta('name', 'description', FAQ_META_DESC[cur]);
    setMeta('property', 'og:description', FAQ_META_DESC[cur]);
    setMeta('property', 'og:title', FAQ_TITLE[cur]);
    // FAQPage JSON-LD（全量 17 条；替换式注入，避免语言切换后重复堆积）
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map((it) => ({
        '@type': 'Question',
        name: it.q,
        acceptedAnswer: { '@type': 'Answer', text: it.a },
      })),
    };
    const old = document.getElementById('faq-jsonld');
    if (old) old.remove();
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'faq-jsonld';
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
    return () => {
      document.getElementById('faq-jsonld')?.remove();
    };
  }, [lang]);

  const items = FAQ_ITEMS[getLang()];
  const backLabel = lang === 'en' ? 'Back to home' : lang === 'zh-TW' ? '回到首頁' : '回到首页';
  const intro =
    lang === 'en'
      ? 'Everything you might want to know before you start talking with Xiaoyu.'
      : lang === 'zh-TW'
        ? '開始和小愈聊天前，你可能想知道的都在這裡。'
        : '开始和小愈聊天前，你可能想知道的都在这里。';
  const footNote =
    lang === 'en'
      ? 'Xiaoyu is a companion, not a treatment. If you are in crisis, please contact a qualified professional or a local helpline.'
      : lang === 'zh-TW'
        ? '小愈是陪伴，不是治療。若你處於危機中，請聯繫合格專業人士或當地求助熱線。'
        : '小愈是陪伴，不是治疗。若你处于危机中，请联系合格专业人士或当地求助热线。';

  return (
    <div className="min-h-screen bg-brand text-ink">
      {/* 顶栏 */}
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur border-b border-gray-100">
        <div className="container mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-primary-text hover:text-primary transition-colors"
            aria-label={backLabel}
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{backLabel}</span>
          </Link>
          <LangSwitch onChange={() => setLangState(getLang())} />
        </div>
      </header>

      {/* 正文 */}
      <main className="container mx-auto px-4 py-8 sm:py-12 max-w-3xl">
        <div className="text-center mb-8 sm:mb-10">
          <BrandHeart boxClass="w-12 h-12 sm:w-14 sm:h-14 mx-auto mb-4" iconClass="w-6 h-6 sm:w-7 sm:h-7 text-white" />
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink mb-2">{FAQ_TITLE[getLang()]}</h1>
          <p className="text-sm sm:text-base text-primary-text font-medium">{intro}</p>
        </div>

        <div className="space-y-3 sm:space-y-4">
          {items.map((it, i) => (
            <section
              key={i}
              className="bg-white rounded-2xl border border-clay-border shadow-sm px-4 sm:px-6 py-4 sm:py-5"
            >
              <h2 className="text-base sm:text-lg font-semibold text-ink mb-1.5 sm:mb-2 leading-snug">{it.q}</h2>
              <p className="text-sm sm:text-[15px] text-gray-600 leading-relaxed">{it.a}</p>
            </section>
          ))}
        </div>

        {/* 合规脚注 */}
        <p className="mt-8 text-center text-xs sm:text-sm text-ink-soft leading-relaxed">{footNote}</p>
      </main>
    </div>
  );
}
