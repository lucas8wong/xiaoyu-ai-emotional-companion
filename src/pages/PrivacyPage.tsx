/**
 * 公开隐私政策页 /privacy
 *
 * 为什么需要独立 URL（2026-10）：Google 的 OAuth 同意屏幕要求填一个**可公开访问**的隐私政策链接，
 * 而站内原有的 PrivacyModal 只是个弹窗、没有地址。文案与弹窗**同源**（同一批 i18n key），
 * 避免两处口径漂移——改政策只改 i18n 一处。
 *
 * 边界：本页是**只读展示**。弹窗里那两个开关（「允许用于改进服务」/「小愈知道我最近做了什么」）
 * 是登录后的账号偏好，不属于公开政策内容，这里不出现。
 */

import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { t } from '../i18n';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-brand px-4 py-10">
      <article className="max-w-2xl mx-auto bg-white rounded-2xl border border-clay-border p-6 sm:p-8">
        <header className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 bg-primary-soft rounded-full flex items-center justify-center shrink-0">
            <ShieldCheck className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-lg sm:text-xl font-bold text-gray-800">{t('privacyTitle')}</h1>
        </header>

        <div className="space-y-4 text-sm text-gray-600 leading-relaxed">
          <section>
            <h2 className="font-semibold text-gray-800 mb-1">{t('pvS1Title')}</h2>
            <p>{t('pvS1P1')}</p>
            <p>{t('pvS1P2')}</p>
            <p>{t('pvS1P3')}</p>
            <p>{t('pvS1P4')}</p>
            <p>{t('pvS1P5')}</p>
            <p>{t('pvS1P6')}</p>
            <p>{t('pvS1P7')}</p>
            <p>{t('pvS1P8')}</p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-800 mb-1">{t('pvS2Title')}</h2>
            <p>{t('pvS2P1')}</p>
            <p>{t('pvS2P2')}</p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-800 mb-1">{t('pvS3Title')}</h2>
            <p>{t('pvS3P1')}</p>
            <p>{t('pvS3P2')}</p>
            <p>{t('pvS3P3')}</p>
          </section>
        </div>

        <footer className="mt-8 pt-5 border-t border-clay-border">
          <Link to="/" className="text-sm text-primary-text underline">{t('privacyBack')}</Link>
        </footer>
      </article>
    </main>
  );
}
