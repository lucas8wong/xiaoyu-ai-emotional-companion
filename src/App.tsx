import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, useLocation } from "react-router-dom";
import PrivacyBanner from "@/components/PrivacyBanner";
import FeedbackModal from "@/components/FeedbackModal";
import PrivacyModal from "@/components/PrivacyModal";
import { SkinProvider } from "@/components/SkinProvider";
import AppSplash from "@/components/AppSplash";
import { useAppStore } from "@/store/useAppStore";
import { isLoggedIn, reportTimezone } from "@/services/api";
import { startUsageTimeTracking } from "@/services/usageTime";
import { SEO_PAGES, seoPagePath } from "@/seo";
// Home 是落地路由（/），静态 import 让它与入口同在初始包，去掉「entry → Home」的 chunk 瀑布，
// 首屏更快。其余路由（FAQ/SEO/千世书分享）仍懒加载。原注释「先加载极小主包等隐私同意」已不再成立——
// 现在首页正文始终渲染（利于爬虫），隐私只是底部非阻塞横幅。
import Home from "@/pages/Home";
// 隐私同意本地标记：游客首次点同意后写入，之后不再弹；登录用户视为已同意
const PRIVACY_AGREED_KEY = 'cure_privacy_agreed';
// FAQ 公开页（/faq）：不经过隐私同意门，利于搜索引擎/爬虫直接抓取
const FaqPage = lazy(() => import("@/components/FaqPage"));
// 千世书分享入口页（/s/:seg）：命运卡二维码/社交链接的落点，避免空路由白板
const ShareEntryPage = lazy(() => import("@/components/ShareEntryPage"));
// 公开隐私政策页（/privacy）：Google OAuth 同意屏幕要求一个可公开访问的隐私政策链接，
// 原先只有 PrivacyModal 弹窗、没有地址。文案与弹窗同源（同一批 i18n key）。
const PrivacyPage = lazy(() => import("@/pages/PrivacyPage"));
// SEO/GEO 落地内容页：路由与页面清单来自 src/seo 注册表（新增页面 = 加一条数据）
const SeoPage = lazy(() => import("@/components/SeoPage"));

// 路由切换后回到页面顶部（避免从长页面跳转后卡在中间）
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname]);
  return null;
}

export default function App() {
  const feedbackOpen = useAppStore(s => s.feedbackOpen);
  const setFeedbackOpen = useAppStore(s => s.setFeedbackOpen);
  const privacyOpen = useAppStore(s => s.privacyOpen);
  const setPrivacyOpen = useAppStore(s => s.setPrivacyOpen);
  // 隐私同意门：已登录用户或本地已同意过的游客直接进主页；仅首次访问的游客需点一次同意
  const [agreed, setAgreed] = useState(() => {
    try {
      if (isLoggedIn()) return true; // 已登录：注册时已同意过，直接进主页
      return localStorage.getItem(PRIVACY_AGREED_KEY) === '1';
    } catch { return false; }
  });
  // 登录/注册成功会 dispatch 「privacy-agreed」：作为「继续使用即视为同意」的落点，关闭底部横幅
  useEffect(() => {
    const onAgreed = () => setAgreed(true);
    window.addEventListener('privacy-agreed', onAgreed);
    return () => window.removeEventListener('privacy-agreed', onAgreed);
  }, []);

  // 用户真实使用时长埋点：应用运行时前台+聚焦才累计（模块级幂等，StrictMode 不会重复启动）
  useEffect(() => {
    startUsageTimeTracking();
  }, []);

  // 上报浏览器时区（每个会话一次）：服务端「时间锚」要用它算**用户那边的今天**——
  // 海外用户跨日时，"今天是几号"才不会算错一天（记忆的时间语义全靠这个口径）。
  // 失败静默：时区只是优化项，缺失时服务端回退默认时区。
  useEffect(() => {
    try {
      if (!isLoggedIn()) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (!tz) return;
      if (sessionStorage.getItem('cure_tz_reported') === tz) return;
      sessionStorage.setItem('cure_tz_reported', tz);
      void reportTimezone(tz);
    } catch { /* 忽略 */ }
  }, []);

  // 首访语言校准已上移到 src/main.tsx 的 boot()：首访先渲染中性加载壳，
  // 等 /api/geo/lang 返回确定最终语言后再渲染正文并持久化，避免"先英文后中文"的闪切。
  // 组件内不再发起 geo 请求，也不做整树强制重渲染。

  return (
    <SkinProvider>
      {/* 已安装 PWA 的应用内启动画面（standalone 才显示，展示 hero 完整画面后淡出） */}
      <AppSplash />
      <Router>
        {/* 整页氛围背景固定层（position:fixed，滚动顺滑/铺满视口） */}
        <div className="skin-backdrop" aria-hidden />
        <ScrollToTop />
        <Suspense fallback={<div className="min-h-screen bg-brand flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white animate-spin" /></div>}>
          <Routes>
            {/* 首页正文始终渲染（利于 Google/AI 爬虫索引）；未同意时底部显示隐私横幅 */}
            <Route path="/" element={<Home />} />
            {/* 公开页：不经过隐私同意门，利于搜索引擎/爬虫直接抓取 */}
            <Route path="/faq" element={<FaqPage />} />
            {/* 公开隐私政策页（Google OAuth 同意屏幕的 Privacy policy URL 指向这里） */}
            <Route path="/privacy" element={<PrivacyPage />} />
            {/* SEO/GEO 落地内容页（公开，利于爬虫与 AI 引擎收录）：路由由 src/seo 注册表派生，
                新增页面只需在 src/seo/*.ts 加一条数据（sitemap / 预渲染同源） */}
            {SEO_PAGES.map((p) => (
              <Route key={seoPagePath(p)} path={seoPagePath(p)} element={<SeoPage path={seoPagePath(p)} />} />
            ))}
            {/* 千世书分享入口页（公开）：/s/<题材>[-<开局>]/ */}
            <Route path="/s/:seg" element={<ShareEntryPage />} />
            <Route path="/other" element={<div className="text-center text-xl">Other Page - Coming Soon</div>} />
          </Routes>
          {!agreed && (
            <PrivacyBanner
              onAgree={() => {
                try { localStorage.setItem(PRIVACY_AGREED_KEY, '1'); } catch { /* 忽略 */ }
                setAgreed(true);
                try { window.dispatchEvent(new CustomEvent('privacy-agreed')); } catch { /* 忽略 */ }
              }}
            />
          )}
        </Suspense>
        {/* 意见反馈：全局弹窗，各功能页的 FeedbackButton 均可打开 */}
        <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
        {/* 隐私政策与免责声明：全局弹窗，首页/介绍页的入口均可打开 */}
        <PrivacyModal open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
      </Router>
    </SkinProvider>
  );
}
