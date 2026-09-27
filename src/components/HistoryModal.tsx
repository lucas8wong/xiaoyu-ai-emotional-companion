/**
 * 我的陪伴记录弹窗（= 「理一理」的记录）
 * 数据源 GET /api/analysis/history：全是理一理会话（情绪/强度/分析/深入问题/疗愈故事）。
 * 归属理一理：入口只在理一理顶栏 🕘「我的记录」（桌面另有带文字的「我的记录」）与理一理 ⋯ 菜单；
 * 主页（Home ⋯ 菜单）自 2026-09-16 起不再提供该入口。
 */

import { useEffect, useState } from 'react';
import { X, History, Loader2, Heart, BookOpen, ChevronLeft } from 'lucide-react';
import { getHistory, type HistoryRecord } from '../services/api';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface HistoryModalProps {
  open: boolean;
  onClose: () => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

export default function HistoryModal({ open, onClose }: HistoryModalProps) {
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  const [selected, setSelected] = useState<HistoryRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    setSelected(null);
    getHistory().then((r) => {
      setLoading(false);
      if (r.success && r.data) {
        setRecords(r.data);
      } else {
        setError(r.error || t('errLoad'));
      }
    });
  }, [open]);

  if (!open) return null;

  // 情绪趋势数据（时间正序，仅含有强度值的记录）
  const trendData = (records || []).filter(r => typeof r.intensity === 'number').reverse();

  // 渲染主体（先处理 loading / error / 数据未就绪，避免 records 为 null 时崩溃）
  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  } else if (error) {
    body = <p className="text-center text-red-500 py-10">{error}</p>;
  } else if (selected) {
    body = (
      /* ---- 详情视图 ---- */
      <div className="space-y-4">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center text-sm text-primary hover:underline"
        >
          <ChevronLeft className="w-4 h-4" /> {t('historyBackList')}
        </button>

        <div className="bg-primary-lighter border border-clay-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-ink-soft">{formatTime(selected.createdAt)}</span>
            {selected.intensity != null && (
              <span className="text-xs bg-white px-2 py-0.5 rounded-full border border-clay-border text-primary-text">
                {t('shareIntensity', { intensity: selected.intensity })}
              </span>
            )}
          </div>
          {selected.emotion && (
            <p className="text-lg font-semibold text-gray-800">{t('historyEmotionLabel', { emotion: selected.emotion })}</p>
          )}
        </div>

        {selected.analysis && (
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <h3 className="font-medium text-gray-800 mb-2 flex items-center gap-2">
              <Heart className="w-4 h-4 text-primary" /> {t('historyType')}
            </h3>
            <p className="text-sm text-gray-600 leading-relaxed">{selected.analysis}</p>
            {selected.suggestions && selected.suggestions.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {selected.suggestions.map((s, i) => (
                  <li key={i} className="text-sm text-gray-600 leading-relaxed">• {s}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {selected.detailedState && (
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <h3 className="font-medium text-gray-800 mb-2">{t('historyDeep')}</h3>
            <p className="text-sm text-gray-600 leading-relaxed">{selected.detailedState}</p>
          </div>
        )}

        {selected.storyTitle && (
          <div className="bg-primary-lighter border border-clay-border rounded-xl p-4">
            <h3 className="font-medium text-gray-800 mb-2 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" /> {t('historyStory', { title: selected.storyTitle })}
            </h3>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{selected.storyContent}</p>
          </div>
        )}
      </div>
    );
  } else if (!records) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  } else if (records.length === 0) {
    body = (
      <div className="text-center py-12 text-ink-soft">
        <div className="w-16 h-16 bg-primary-lighter rounded-full flex items-center justify-center mx-auto mb-4">
          <Heart className="w-8 h-8 text-primary-soft" />
        </div>
        <p className="text-gray-600 font-medium">{t('historyEmpty')}</p>
        <p className="text-sm mt-1">{t('historyEmptySub')}</p>
        <p className="text-xs mt-3 text-ink-soft">
          {t('historyDeviceTip')}
        </p>
        <button
          onClick={onClose}
          className="mt-6 bg-primary-strong text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-primary"
        >
          {t('historyGoTry')}
        </button>
      </div>
    );
  } else {
    body = (
      /* ---- 列表视图 ---- */
      <div className="space-y-3">
        {/* 情绪趋势 */}
        {trendData.length >= 2 && (
          <div className="bg-white border border-gray-100 rounded-xl p-4 mb-1">
            <h3 className="font-medium text-gray-800 mb-1 text-sm">{t('historyTrend')}</h3>
            <svg viewBox="0 0 300 80" className="w-full h-auto">
              {(() => {
                const n = trendData.length;
                const pts = trendData.map((r, i) => {
                  const x = 24 + (n === 1 ? 0 : i * (252 / (n - 1)));
                  const y = 68 - Math.min(10, Math.max(0, r.intensity || 0)) * 5.2;
                  return { x, y, r };
                });
                const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                const area = `${line} L${pts[pts.length - 1].x},68 L${pts[0].x},68 Z`;
                return (
                  <>
                    <defs>
                      <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a855f7" stopOpacity="0.35" />
                        <stop offset="100%" stopColor="#a855f7" stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <path d={area} fill="url(#trendGrad)" />
                    <path d={line} fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    {pts.map((p, i) => (
                      <g key={i}>
                        <circle cx={p.x} cy={p.y} r="3" fill="#fff" stroke="#a855f7" strokeWidth="1.5" />
                        <text x={p.x} y={p.y - 8} textAnchor="middle" fontSize="8" fill="#6b7280">
                          {p.r.intensity}
                        </text>
                      </g>
                    ))}
                    <text x={pts[0].x} y="78" textAnchor="middle" fontSize="7" fill="#9ca3af">{pts[0].r.createdAt.slice(5, 10)}</text>
                    {pts.length > 1 && (
                      <text x={pts[pts.length - 1].x} y="78" textAnchor="middle" fontSize="7" fill="#9ca3af">{pts[pts.length - 1].r.createdAt.slice(5, 10)}</text>
                    )}
                  </>
                );
              })()}
            </svg>
          </div>
        )}
        {records.map((r) => (
          <button
            key={r.sessionId}
            onClick={() => setSelected(r)}
            className="w-full text-left bg-white border border-gray-100 hover:border-primary rounded-xl p-4 transition-colors"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-ink-soft">{formatTime(r.createdAt)}</span>
              {r.intensity != null && (
                <span className="text-xs bg-primary-lighter px-2 py-0.5 rounded-full text-primary border border-clay-border">
                  {t('shareIntensity', { intensity: r.intensity })}
                </span>
              )}
            </div>
            <p className="font-medium text-gray-800">
              {r.emotion || t('historyIncomplete')}
              {r.answeredCount > 0 && <span className="text-xs text-ink-soft ml-2">{t('historyAnswered', { n: r.answeredCount })}</span>}
            </p>
            <p className="text-xs text-ink-soft mt-1">
              {r.storyTitle ? t('historyStory', { title: r.storyTitle }) : r.detailedState ? t('historyDetail') : t('historyOnlyMood')}
            </p>
          </button>
        ))}
      </div>
    );
  }

  return (
    <Modal open={open} onClose={onClose} width="max-w-2xl" maxHeight="max-h-[92vh]" overflow="" layout="flex">
        <div className="text-center mb-5">
          <div className="w-14 h-14 bg-primary rounded-full flex items-center justify-center mx-auto mb-3">
            <History className="w-7 h-7 text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-800">{t('historyTitle')}</h2>
          <p className="text-sm text-ink-soft mt-1">
            {selected ? t('historyDetailTitle') : t('historyCount', { n: records?.length ?? 0 })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {body}
        </div>

        {/* 底部返回按钮 */}
        <div className="pt-4">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t('historyBack')}
          </button>
        </div>
    </Modal>
  );
}