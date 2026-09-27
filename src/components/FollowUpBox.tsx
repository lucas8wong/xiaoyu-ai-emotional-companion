/**
 * AI 多轮追问组件
 * 对分析结果/建议继续提问
 */

import { useState } from 'react';
import { Send, Loader2, MessageCircle } from 'lucide-react';
import { followUp } from '../services/api';
import CopyButton from './CopyButton';
import { t } from '../i18n';

interface FollowUpBoxProps {
  sessionId: string | null;
}

interface QAPair {
  q: string;
  a: string;
}

export default function FollowUpBox({ sessionId }: FollowUpBoxProps) {
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<QAPair[]>([]);
  const [loading, setLoading] = useState(false);

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || !sessionId || loading) return;
    setLoading(true);
    setQuestion('');
    const r = await followUp(sessionId, q);
    setLoading(false);
    setHistory(prev => [...prev, { q, a: r.success && r.data ? r.data.answer : (r.error || t('errFailed')) }]);
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-100 mt-8">
      <div className="flex items-center mb-4">
        <MessageCircle className="w-5 h-5 text-primary mr-2" />
        <h3 className="text-lg font-semibold text-gray-800">{t('followupTitle')}</h3>
      </div>

      {history.length > 0 && (
        <div className="space-y-4 mb-4 max-h-72 overflow-y-auto">
          {history.map((item, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="bg-primary-lighter border border-clay-border rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-gray-700 max-w-[85%]">
                  {item.q}
                </div>
              </div>
              <div className="flex justify-start items-end gap-1.5">
                <div className="bg-gray-50 border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-gray-600 leading-relaxed max-w-[88%]">
                  {item.a}
                </div>
                {/* 常显复制：每条 AI 回答都能单独复制，不用长按/悬停 */}
                <CopyButton text={item.a} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAsk(); }}
          placeholder={t('detailedFollowupPh')}
          className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent"
          disabled={loading}
        />
        <button
          onClick={handleAsk}
          disabled={loading || !question.trim()}
          className="bg-primary-strong text-white px-4 py-2.5 rounded-lg font-medium hover:bg-primary disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {t('detailedFollowupSend')}
        </button>
      </div>
      <p className="text-xs text-ink-soft mt-2">{t('followupTip')}</p>
    </div>
  );
}