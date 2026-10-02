/**
 * 情绪输入组件
 * 用户输入当前情绪状态的界面
 */

import { useEffect, useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { analyzeEmotion, getQuota, isLoggedIn, quotaChatRemain, type QuotaInfo } from '../services/api';
import { guestQuotaLineText } from '../lib/quotaTiers';
import BrandHeart from './BrandHeart';
import { t } from '../i18n';

export default function EmotionInput() {
  const {
    emotionInput,
    setEmotionInput,
    sessionId,
    setSessionId,
    setEmotionAnalysis,
    setCurrentStep,
    isLoading,
    setLoading,
    setError,
    setPayOpen,
    structureCharacterId,
  } = useAppStore();

  const [localInput, setLocalInput] = useState(emotionInput);
  const [remainFree, setRemainFree] = useState<number | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  /** 整份配额（游客条的分档数字从它取：guestDailyCredit / freeDailyCredit ÷ unitCredit） */
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  // 进入页面时查询配额，展示剩余次数
  useEffect(() => {
    getQuota().then((r) => {
      if (r.success && r.data) {
        setRemainFree(r.data.remainFree);
        setUnlocked(r.data.unlocked);
        setQuota(r.data);
      }
    });
  }, []);

  // 快捷入口直发：点 chip 或点提交都走这里
  const doAnalyze = async (text: string) => {
    if (!text.trim()) {
      setError(t('inputLabel'));
      return;
    }

    // 配额检查：剩余免费次数为0且未解锁
    const q = await getQuota();
    if (q.success && q.data && !q.data.canUse) {
      // 统一门控：游客 → 先弹注册（注册送次数）；已注册 → 「获取更多额度」（分享/反馈）；Plus 每日用完 → 会员
      try { window.dispatchEvent(new CustomEvent('xiaoyu:quota-exhausted')); } catch { setPayOpen(true); }
      return;
    }

    setLoading(true);
    setError(null);
    setEmotionInput(text);
    setLocalInput(text);

    try {
      const response = await analyzeEmotion(text, sessionId || undefined, structureCharacterId || undefined);
      
      if (response.success && response.data) {
        setSessionId(response.data.sessionId);
        setEmotionAnalysis(response.data.analysis);
        setCurrentStep('analysis' as const);
        // 更新剩余次数
        const q2 = await getQuota();
        if (q2.success && q2.data) {
          setRemainFree(q2.data.remainFree);
          setUnlocked(q2.data.unlocked);
          setQuota(q2.data);
        }
      } else if (response.error && (response.error.includes('免费次数') || response.error.includes('free chats') || /quota/i.test(response.error))) {
        // 服务端判定超限：统一门控（游客注册优先；已注册「获取更多额度」）
        try { window.dispatchEvent(new CustomEvent('xiaoyu:quota-exhausted')); } catch { /* 忽略 */ }
        setPayOpen(false);
      } else {
        setError(response.error || t('errFailed'));
      }
    } catch {
      setError(t('errNetwork'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await doAnalyze(localInput);
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      {/* 标题区域 */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <BrandHeart boxClass="w-14 h-14 sm:w-16 sm:h-16" iconClass="w-7 h-7 sm:w-8 sm:h-8 text-white" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
          {t('inputTitle')}
        </h1>
        <p className="text-gray-600 text-base sm:text-lg">
          {t('inputSub')}
        </p>
      </div>

      {/* 快捷情绪入口：低落 / 快乐 / 日常 */}
      <div className="mb-6">
        <p className="text-sm font-medium text-gray-700 mb-1 text-center">{t('entriesTitle')}</p>
        <p className="text-xs text-ink-soft mb-3 text-center">{t('entryClickHint')}</p>
        <div className="space-y-3">
          {[
            { group: t('groupLow'), items: [t('entryLow1'), t('entryLow2'), t('entryLow3'), t('entryLow4'), t('entryLow5')] },
            { group: t('groupJoy'), items: [t('entryJoy1'), t('entryJoy2'), t('entryJoy3'), t('entryJoy4'), t('entryJoy5')] },
            { group: t('groupDaily'), items: [t('entryDaily1'), t('entryDaily2'), t('entryDaily3'), t('entryDaily4'), t('entryDaily5')] },
          ].map(g => (
            <div key={g.group}>
              <p className="text-xs text-ink-soft mb-1.5">{g.group}</p>
              <div className="flex flex-wrap gap-2">
                {g.items.map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => { void doAnalyze(item); }}
                    className="text-xs sm:text-sm px-3 py-2 rounded-full border border-clay-border bg-white text-primary hover:bg-primary-lighter hover:border-primary transition-all active:scale-95"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-soft text-center mt-3">{t('orSayDirectly')}</p>
      </div>

      {/* 输入表单 */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label 
            htmlFor="emotion-input" 
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            {t('inputLabel2')}
          </label>
          <textarea
            id="emotion-input"
            value={localInput}
            onChange={(e) => setLocalInput(e.target.value.slice(0, 1000))}
            placeholder={t('inputPlaceholder')}
            maxLength={1000}
            className="w-full h-32 px-4 py-3 border border-clay-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-all duration-200"
            disabled={isLoading}
          />
          <div className="flex justify-end mt-1">
            <span className={`text-xs ${localInput.length > 900 ? 'text-amber-600 font-medium' : 'text-ink-soft'}`}>
              {localInput.length}/1000
            </span>
          </div>
        </div>

        {/* 提示文字 */}
        <div className="bg-primary-lighter border border-clay-border rounded-lg p-4">
          <p className="text-sm text-primary-text">
            🌱 {t('inputTip')}
          </p>
        </div>

        {/* 免费次数提示 */}
        {remainFree !== null && (
          <div className="text-center">
            {unlocked ? (
              <span className="inline-block bg-primary-lighter border border-clay-border text-primary-text text-xs px-3 py-1 rounded-full">
                {t('unlocked')}
              </span>
            ) : (
              <span className="inline-block bg-primary-lighter border border-clay-border text-primary-text text-xs px-3 py-1 rounded-full">
                {!isLoggedIn()
                  // 2026-09-27 分档：游客条必须给出「游客 N 条 / 注册后 M 条」（与首页、聊一聊逐字一致）；
                  // ⚠️ 原来这里写死 `b: 3`（旧理一理口径），既不真实也与后端奖励数字不符，已改用后端下发数字
                  ? (guestQuotaLineText(t, quota, null, quotaChatRemain(quota)) ?? t('remaining', { n: remainFree }))
                  : t('remaining', { n: remainFree })}
              </span>
            )}
          </div>
        )}

        {/* 提交按钮 */}
        <button
          type="submit"
          disabled={isLoading || !localInput.trim()}
          className="btn-primary w-full !rounded-xl py-3" style={{ borderRadius: 14 }}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>{t('analyzing')}</span>
            </>
          ) : (
            <>
              <Send className="w-5 h-5" />
              <span>{t('startAnalysis')}</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}