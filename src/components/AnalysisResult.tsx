/**
 * 情感分析结果展示组件
 * 显示AI分析的情绪状态和建议
 */

import { useState } from 'react';
import { ArrowRight, Brain, Heart, TrendingUp, Share2 } from 'lucide-react';
import StoryShareModal from './StoryShareModal';
import CopyButton from './CopyButton';
import { t, localizeCategory, localizeEmotion } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import { generateQuestions, generateHealingStory } from '../services/api';

export default function AnalysisResult() {
  const {
    emotionAnalysis,
    sessionId,
    questions,
    setQuestions,
    setCurrentStep,
    isLoading,
    setLoading,
    setError,
    setHealingStory,
  } = useAppStore();

  const [shareOpen, setShareOpen] = useState(false);

  if (!emotionAnalysis) {
    return (
      <div className="max-w-4xl mx-auto p-4 sm:p-6">
        <div className="text-center text-ink-soft">
          {t('noResult')}
        </div>
      </div>
    );
  }

  // 正向情绪：强度改叫「快乐的浓度」、用暖色（不套负面分析框架）
  const isPositive =
    (emotionAnalysis.category || '').includes('开心') ||
    (emotionAnalysis.category || '').includes('积极') ||
    /开心|快乐|喜悦|兴奋|满足|happy|joy|excited|delight/i.test(emotionAnalysis.emotion || '');
  const intensityText = isPositive
    ? emotionAnalysis.intensity >= 8 ? t('intensityPosHigh')
      : emotionAnalysis.intensity >= 6 ? t('intensityPosMidHigh')
      : emotionAnalysis.intensity >= 4 ? t('intensityPosMid')
      : t('intensityPosLow')
    : emotionAnalysis.intensity >= 8 ? t('intensityHigh')
      : emotionAnalysis.intensity >= 6 ? t('intensityMidHigh')
      : emotionAnalysis.intensity >= 4 ? t('intensityMid')
      : t('intensityLow');

  const handleGenerateQuestions = async () => {
    // 回看：问题已生成过就直接进入，不重复调用 AI
    if (questions.length > 0) {
      setCurrentStep('questions' as const);
      return;
    }
    if (!sessionId || !emotionAnalysis) {
      setError(t('errSessionLost'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await generateQuestions(sessionId);
      
      if (response.success && response.data) {
        setQuestions(response.data.questions);
        setCurrentStep('questions' as const);
      } else {
        setError(response.error || t('errFailed'));
      }
    } catch {
      setError(t('errNetwork'));
    } finally {
      setLoading(false);
    }
  };

  // 直接跳转到故事生成（跳过问答与详细分析）
  const handleDirectStory = async () => {
    if (!sessionId || !emotionAnalysis) {
      setError(t('errSessionLost'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await generateHealingStory(sessionId);
      if (response.success && response.data) {
        setHealingStory(response.data.story);
        setCurrentStep('story' as const);
      } else {
        setError(response.error || t('errFailed'));
      }
    } catch {
      setError(t('errNetwork'));
    } finally {
      setLoading(false);
    }
  };

  const getEmotionColor = (emotion: string) => {
    const colors: Record<string, string> = {
      '快乐': 'text-yellow-600 bg-yellow-100',
      '悲伤': 'text-blue-600 bg-blue-100',
      '愤怒': 'text-red-600 bg-red-100',
      '焦虑': 'text-orange-600 bg-orange-100',
      '恐惧': 'text-primary bg-primary-soft',
      '平静': 'text-green-600 bg-green-100',
      '兴奋': 'text-primary bg-primary-soft',
      '困惑': 'text-gray-600 bg-gray-100',
    };
    return colors[emotion] || 'text-gray-600 bg-gray-100';
  };

  const getIntensityColor = (intensity: number) => {
    if (intensity >= 8) return 'text-red-600 bg-red-100';
    if (intensity >= 6) return 'text-orange-600 bg-orange-100';
    if (intensity >= 4) return 'text-yellow-600 bg-yellow-100';
    return 'text-green-600 bg-green-100';
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      {/* 标题 */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center">
            <Brain className="w-8 h-8 text-white" />
          </div>
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
          {t('analysisTitle')}
        </h2>
        <p className="text-gray-600">
          {t('analysisSub')}
        </p>
      </div>

      {/* 分析结果卡片 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* 主要情绪 */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            <Heart className="w-6 h-6 text-primary mr-2" />
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800">{t('analysisEmotion')}</h3>
            <CopyButton text={emotionAnalysis.analysis} showLabel className="ml-auto" />
          </div>
          <div className="space-y-3">
            <div className={`inline-flex items-center px-4 py-2 rounded-full text-lg font-semibold ${getEmotionColor(emotionAnalysis.emotion)}`}>
              {localizeEmotion(emotionAnalysis.emotion)}
            </div>
            {emotionAnalysis.category && (
              <div className="mt-3 inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-lighter text-primary-text border border-clay-border">
                {t('analysisDirection')}：{localizeCategory(emotionAnalysis.category)}
              </div>
            )}
            <p className="text-gray-600 mt-2">
              {emotionAnalysis.analysis}
            </p>
          </div>
        </div>

        {/* 情绪强度 */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            <TrendingUp className="w-6 h-6 text-primary mr-2" />
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800">{isPositive ? t('intensityPosLabel') : t('analysisIntensity')}</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${isPositive ? 'bg-amber-100 text-amber-700' : getIntensityColor(emotionAnalysis.intensity)}`}>
                {emotionAnalysis.intensity}/10
              </div>
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div 
                  className={`${isPositive ? 'bg-amber-400' : 'bg-primary'} h-2 rounded-full transition-all duration-500`}
                  style={{ width: `${emotionAnalysis.intensity * 10}%` }}
                />
              </div>
            </div>
            <p className="text-gray-600 text-sm">{intensityText}</p>
          </div>
        </div>
      </div>

      {/* 初步建议 */}
      <div className="bg-primary-lighter rounded-xl p-6 mb-8 border border-clay-border">
        <div className="flex items-center mb-4">
          <span className="w-2 h-2 bg-primary rounded-full mr-3"></span>
          <h3 className="text-lg sm:text-xl font-semibold text-gray-800">{t('directionsTitle')}</h3>
          <CopyButton
            text={emotionAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
            showLabel
            className="ml-auto flex-shrink-0"
          />
        </div>
        <div className="space-y-3">
          {emotionAnalysis.suggestions.map((suggestion, index) => (
            <div key={index} className="flex items-start space-x-3">
              <div className="w-6 h-6 bg-primary-soft rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-primary text-sm font-medium">{index + 1}</span>
              </div>
              <p className="text-gray-700 leading-relaxed">{suggestion}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 继续按钮 */}
      <div className="text-center">
        <button
          onClick={handleGenerateQuestions}
          disabled={isLoading}
          className="bg-primary-strong text-white py-3 px-8 rounded-lg font-medium w-full sm:w-auto hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center space-x-2 mx-auto"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>{t('analyzing')}</span>
            </>
          ) : (
            <>
              <span>{t('analysisNext')}</span>
              <ArrowRight className="w-5 h-5" />
            </>
          )}
        </button>
        
        <p className="text-ink-soft text-sm mt-3">
          {t('analysisNextSub')}
        </p>

        <button
          onClick={handleDirectStory}
          disabled={isLoading}
          className="mt-5 text-sm text-primary-text hover:text-primary-text underline underline-offset-4 transition-colors"
        >
          {t('storyDirectHint')}
        </button>

        <button
          onClick={() => setShareOpen(true)}
          className="mt-3 text-sm text-ink-soft hover:text-primary-text underline underline-offset-4 transition-colors inline-flex items-center gap-1"
        >
          <Share2 className="w-3.5 h-3.5" />
          {t('shareAnalysisBtn')}
        </button>
      </div>

      <StoryShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t('shareAnalysisTitle')}
        bubbles={[
          { side: 'them', name: t('appName'), content: `${localizeEmotion(emotionAnalysis.emotion)}（${emotionAnalysis.intensity}/10）\n\n${emotionAnalysis.analysis}` },
          ...(emotionAnalysis.suggestions.length > 0
            ? [{ side: 'them' as const, name: t('appName'), content: `${t('shareAnalysisSuggest')}\n${emotionAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}` }]
            : []),
        ]}
      />
    </div>
  );
}