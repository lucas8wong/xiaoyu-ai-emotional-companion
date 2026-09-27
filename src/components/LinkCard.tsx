/**
 * 微信/QQ 式「链接卡片」
 *   聊一聊 assistant 回复里的网页链接渲染成可点击卡片（缩略图 + 标题 + 简介 + 域名）。
 *   数据来自 /api/link-preview；失败/加载中回退为可点链接或骨架，绝不破图/报错。
 */

import { useEffect, useState } from 'react';
import { getLinkPreview, linkPreviewImageUrl, type LinkPreview } from '../services/api';
import { t } from '../i18n';

// 模块级缓存：同一链接在多个气泡/多次渲染共用一次抓取，避免重复请求
const cache = new Map<string, LinkPreview | null>();

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

export default function LinkCard({ url }: { url: string }) {
  const [meta, setMeta] = useState<LinkPreview | null>(() => cache.get(url) ?? null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'fail'>(() =>
    cache.has(url) ? (cache.get(url) ? 'ok' : 'fail') : 'loading'
  );

  useEffect(() => {
    const cached = cache.get(url);
    if (cached) { setMeta(cached); setStatus('ok'); return; }
    if (cache.has(url)) { setStatus('fail'); return; }

    let cancelled = false;
    setStatus('loading');
    setMeta(null);
    getLinkPreview(url)
      .then((r) => {
        if (cancelled) return;
        if (r.success && r.data) {
          cache.set(url, r.data);
          setMeta(r.data);
          setStatus('ok');
        } else {
          cache.set(url, null);
          setStatus('fail');
        }
      })
      .catch(() => {
        if (!cancelled) { cache.set(url, null); setStatus('fail'); }
      });
    return () => { cancelled = true; };
  }, [url]);

  if (status === 'fail') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-[240px] max-w-full my-1.5 rounded-xl border border-clay-border bg-white/70 px-3 py-2.5 shadow-sm hover:shadow-md transition-shadow"
      >
        <div className="text-[13px] font-semibold text-ink leading-snug line-clamp-1">{domainOf(url)}</div>
        <div className="text-[11px] text-ink-soft mt-0.5">{t('chatLinkPreviewFail')}</div>
      </a>
    );
  }

  if (status === 'loading' || !meta) {
    return (
      <div className="w-[240px] max-w-full my-1.5 rounded-xl border border-clay-border bg-white/60 overflow-hidden shadow-sm animate-pulse">
        <div className="h-28 bg-clay-bg/80" />
        <div className="px-3 py-2.5 space-y-1.5">
          <div className="h-3.5 bg-clay-bg/80 rounded" />
          <div className="h-3 bg-clay-bg/60 rounded w-3/4" />
        </div>
      </div>
    );
  }

  const image = meta.image ? linkPreviewImageUrl(meta.image) : '';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-[240px] max-w-full my-1.5 rounded-xl border border-clay-border bg-white/70 overflow-hidden shadow-sm hover:shadow-md transition-shadow"
    >
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
          className="w-full h-28 object-cover"
        />
      )}
      <div className="px-3 py-2">
        <div className="text-[13px] font-semibold text-ink leading-snug line-clamp-2">{meta.title || url}</div>
        {meta.description && (
          <div className="text-[11px] text-ink-soft leading-snug mt-1 line-clamp-2">{meta.description}</div>
        )}
        <div className="text-[10px] text-ink-soft mt-1 truncate">{domainOf(url)}</div>
      </div>
    </a>
  );
}
