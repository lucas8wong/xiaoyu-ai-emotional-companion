/**
 * 聊一聊「来源」行（2026-09-29）
 *
 * 为什么要有它：在这之前，小愈转述了一条新闻/热点，出处**只有在模型自己把 URL 写进正文时**才看得见
 * （正文里的 URL 由 LinkCard 渲染成卡片），用户不问「有链接吗」就往往没有；前端连来源数据都拿不到
 * （SSE 只有一个布尔 search 事件）。现在服务端把本轮 web_search 的命中结构化下发并随消息落盘，这里**常显**。
 *
 * 设计克制（陪伴产品，不是新闻聚合）：
 *  · 默认只露 **3 条域名**，多出来的折进「看全部 N 个来源」；服务端最多给 5 条，不做任何抓取/展开卡片
 *    （那是 LinkCard 的活，正文里模型自己写的 URL 仍然走 LinkCard，这里只补「出处」）。
 *  · 只显示**域名**：域名回答「这是哪家说的」，比截断的标题信息量大，也不会把一行撑爆；完整标题走 title。
 *    优先用服务端给的 `host`（发布方），Google News 的链接域名是 news.google.com，拿它当来源等于没信息，
 *    服务端已经在 RSS 里认出了真正的发布方（见 api/services/news.ts 的 rssPublisherHost）。
 *  · 点开一律新窗口 + rel="noopener noreferrer"（与 LinkCard 同一口径）。
 */
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../i18n';
import type { ChatSource } from '../services/api';

/** 取域名（去掉 www.）；解析失败就原样显示，绝不渲染成空白 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
}

export default function ChatSources({ sources }: { sources?: ChatSource[] }) {
  const [open, setOpen] = useState(false);
  if (!sources || sources.length === 0) return null;
  const shown = open ? sources : sources.slice(0, 3);
  const rest = sources.length - shown.length;
  return (
    <div className="mt-1.5 ml-9 max-w-[78%]" data-testid="chat-sources">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-ink-soft flex-shrink-0">{t('chatSources')}</span>
        {shown.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            aria-label={s.title}
            className="inline-flex items-center gap-1 max-w-full text-[11px] text-ink bg-white/80 border border-clay-border rounded-full px-2 py-0.5 hover:border-primary hover:text-primary-text transition-colors"
          >
            <span className="truncate">{s.host || domainOf(s.url)}</span>
            <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-70" aria-hidden="true" />
          </a>
        ))}
        {rest > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-[11px] text-primary-text underline underline-offset-2 flex-shrink-0"
          >
            {t('chatSourcesAll', { n: sources.length })}
          </button>
        )}
      </div>
    </div>
  );
}
