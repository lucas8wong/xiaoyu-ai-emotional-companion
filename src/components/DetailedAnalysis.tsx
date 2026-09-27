/**
 * 详细分析结果展示组件
 * 显示基于问答的深度情感分析
 */

import { useState } from 'react';
import { ArrowRight, Brain, Target, Lightbulb, TrendingUp, AlertTriangle, Sun, Star, Compass, MessageCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { t, localizeCategory } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import FollowUpBox from './FollowUpBox';
import CopyButton from './CopyButton';
import { generateHealingStory } from '../services/api';

export default function DetailedAnalysis({ onExitStructure }: { onExitStructure?: () => void } = {}) {
  const {
    detailedAnalysis,
    sessionId,
    setHealingStory,
    setCurrentStep,
    isLoading,
    setLoading,
    setError,
    setAppMode,
    chatSessionId,
    setChatSessionId,
  } = useAppStore();

  // 详细拆解默认折叠，减少首屏长度（hooks 必须在条件 return 之前）
  const [showDetails, setShowDetails] = useState(false);

  if (!detailedAnalysis) {
    return (
      <div className="min-h-screen bg-brand flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500 mx-auto mb-4"></div>
          <p className="text-gray-600">{t('loadingDetail')}</p>
        </div>
      </div>
    );
  }
  
  // 情绪方向：开心/积极 → 用"记住这份快乐"的板块；低落/困扰 → 用"看清自己"的板块
  const isPositive =
    detailedAnalysis.valence === 'positive' ||
    /开心|积极|快乐|喜悦|兴奋|满足/.test(detailedAnalysis.category || '') ||
    /开心|快乐|喜悦|兴奋/.test(detailedAnalysis.emotionalState || '');

  // 每个 AI 输出区块的「可复制文本」：与该区块在界面上展示的内容一致
  // （概览卡是缩略（slice 2/3 条），这里复制的是完整列表，便于用户留档/转发）
  const copyList = (arr?: string[]) => (arr || []).map(x => `- ${x}`).join('\n');
  const copyState = detailedAnalysis.emotionalState || '';
  const copyTriggers = copyList(detailedAnalysis.triggers);
  const copyCore = copyList(detailedAnalysis.coreIssues);
  const copyPositive = copyList(detailedAnalysis.positiveFactors);
  const copyAdvice = (detailedAnalysis.recommendations || []).map((r, i) => `${i + 1}. ${r}`).join('\n');
  const handleGenerateStory = async () => {
    if (!sessionId) {
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
          {t('detailedTitle')}
        </h2>
        <p className="text-gray-600">
          {isPositive ? t('detailedSubPos') : t('detailedSub')}
        </p>
      </div>

      {/* 分析概览 */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
        {/* 情绪状态 */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            <TrendingUp className="w-6 h-6 text-primary mr-2" />
            <h3 className="text-base sm:text-lg font-semibold text-gray-800">{t('detailedState')}</h3>
            <CopyButton text={copyState} showLabel className="ml-auto flex-shrink-0" />
          </div>
          <div className="space-y-3">
            {detailedAnalysis.category && (
              <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border bg-primary-lighter text-primary-text border-clay-border">
                <Compass className="w-3.5 h-3.5" /> {t('analysisDirection')}：{localizeCategory(detailedAnalysis.category)}
              </div>
            )}
            <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border bg-blue-50 text-primary border-clay-border">
              {detailedAnalysis.emotionalState || t('stateFallback')}
            </div>
            <p className="text-gray-600 mt-2 text-sm">
              {t('stateSubText')}
            </p>
          </div>
        </div>

        {/* 触发因素（开心时=什么照亮了你） */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            {isPositive
              ? <Sun className="w-6 h-6 text-amber-700 mr-2" />
              : <AlertTriangle className="w-6 h-6 text-orange-500 mr-2" />}
            <h3 className="text-base sm:text-lg font-semibold text-gray-800">{isPositive ? t('detailedTriggersPos') : t('detailedTriggers')}</h3>
            <CopyButton text={copyTriggers} showLabel className="ml-auto flex-shrink-0" />
          </div>
          <div className="space-y-2">
            {(detailedAnalysis.triggers || []).slice(0, 2).map((trigger, index) => (
              <div key={index} className="flex items-start space-x-2">
                <div className="w-2 h-2 bg-orange-400 rounded-full mt-2 flex-shrink-0" />
                <p className="text-gray-700 text-sm">{trigger}</p>
              </div>
            ))}
            {(!detailedAnalysis.triggers || detailedAnalysis.triggers.length === 0) && (
              <p className="text-ink-soft text-sm">{t('noTriggers')}</p>
            )}
          </div>
        </div>

        {/* 核心问题（开心时=想记住的瞬间） */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            {isPositive
              ? <Star className="w-6 h-6 text-amber-700 mr-2" />
              : <Target className="w-6 h-6 text-red-500 mr-2" />}
            <h3 className="text-base sm:text-lg font-semibold text-gray-800">{isPositive ? t('detailedCorePos') : t('detailedCore')}</h3>
            <CopyButton text={copyCore} showLabel className="ml-auto flex-shrink-0" />
          </div>
          <div className="space-y-2">
            {(detailedAnalysis.coreIssues || []).slice(0, 3).map((issue, index) => (
              <div key={index} className="flex items-start space-x-2">
                <div className="w-2 h-2 bg-red-400 rounded-full mt-2 flex-shrink-0" />
                <p className="text-gray-700 text-sm">{issue}</p>
              </div>
            ))}
          </div>
        </div>

        {/* 积极因素 */}
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
          <div className="flex items-center mb-4">
            <Lightbulb className="w-6 h-6 text-green-500 mr-2" />
            <h3 className="text-base sm:text-lg font-semibold text-gray-800">{t('detailedPositive')}</h3>
            <CopyButton text={copyPositive} showLabel className="ml-auto flex-shrink-0" />
          </div>
          <div className="space-y-2">
            {(detailedAnalysis.positiveFactors || []).slice(0, 3).map((factor, index) => (
              <div key={index} className="flex items-start space-x-2">
                <div className="w-2 h-2 bg-green-400 rounded-full mt-2 flex-shrink-0" />
                <p className="text-gray-700 text-sm">{factor}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 详细拆解（默认折叠，减少首屏长度） */}
      <div className="text-center mb-6">
        <button
          onClick={() => setShowDetails(v => !v)}
          className="inline-flex items-center gap-1.5 text-sm text-primary-text border border-primary/30 bg-primary-lighter px-4 py-2 rounded-full hover:bg-primary-soft transition-all"
        >
          {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          {showDetails ? t('collapseDetails') : t('expandDetails')}
        </button>
      </div>
      {showDetails && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
        {/* 触发因素详情（开心时=什么照亮了你） */}
        <div className={`bg-gradient-to-br rounded-xl p-6 border ${isPositive ? 'from-amber-50 to-yellow-50 border-amber-200' : 'from-orange-50 to-yellow-50 border-orange-100'}`}>
          <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3 sm:mb-4 flex items-center">
            {isPositive
              ? <Sun className="w-6 h-6 text-amber-700 mr-2" />
              : <AlertTriangle className="w-6 h-6 text-orange-500 mr-2" />}
            {isPositive ? t('detailedTriggersPos') : t('detailedTriggers')}
          </h3>
          <div className="space-y-4">
            {(detailedAnalysis.triggers || []).map((trigger, index) => (
              <div key={index} className="bg-white rounded-lg p-3 sm:p-4 border border-orange-100">
                <div className="flex items-start space-x-3">
                  <div className="w-6 h-6 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-orange-600 text-sm font-medium">!</span>
                  </div>
                  <p className="text-gray-700 leading-relaxed">{trigger}</p>
                </div>
              </div>
            ))}
            {(!detailedAnalysis.triggers || detailedAnalysis.triggers.length === 0) && (
              <div className="bg-white rounded-lg p-3 sm:p-4 border border-orange-100">
                <p className="text-ink-soft text-center">{t('noTriggers')}</p>
              </div>
            )}
          </div>
        </div>
        {/* 核心问题详情（开心时=想记住的瞬间） */}
        <div className={`bg-gradient-to-br rounded-xl p-6 border ${isPositive ? 'from-yellow-50 to-amber-50 border-yellow-200' : 'from-red-50 to-orange-50 border-red-100'}`}>
          <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3 sm:mb-4 flex items-center">
            {isPositive
              ? <Star className="w-6 h-6 text-amber-700 mr-2" />
              : <Target className="w-6 h-6 text-red-500 mr-2" />}
            {isPositive ? t('detailedCorePos') : t('detailedCore')}
          </h3>
          <div className="space-y-4">
            {(detailedAnalysis.coreIssues || []).map((issue, index) => (
              <div key={index} className="bg-white rounded-lg p-3 sm:p-4 border border-red-100">
                <div className="flex items-start space-x-3">
                  <div className="w-6 h-6 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-red-600 text-sm font-medium">{index + 1}</span>
                  </div>
                  <p className="text-gray-700 leading-relaxed">{issue}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 积极因素详情 */}
        <div className="bg-accent-soft rounded-xl p-6 border border-green-100">
          <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3 sm:mb-4 flex items-center">
            <Lightbulb className="w-6 h-6 text-green-500 mr-2" />
            {t('detailedPositive')}
          </h3>
          <div className="space-y-4">
            {(detailedAnalysis.positiveFactors || []).map((factor, index) => (
              <div key={index} className="bg-white rounded-lg p-3 sm:p-4 border border-green-100">
                <div className="flex items-start space-x-3">
                  <div className="w-6 h-6 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-green-600 text-sm font-medium">✓</span>
                  </div>
                  <p className="text-gray-700 leading-relaxed">{factor}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* {t('detailedAdvice')} */}
      <div className="bg-primary-lighter rounded-xl p-4 sm:p-6 mb-8 border border-clay-border">
        <div className="flex items-center mb-3 sm:mb-4">
          {isPositive
            ? <Sun className="w-6 h-6 text-amber-700 mr-2" />
            : <Brain className="w-6 h-6 text-primary mr-2" />}
          <h3 className="text-lg sm:text-xl font-semibold text-gray-800">{isPositive ? t('detailedAdvicePos') : t('detailedAdvice')}</h3>
          <CopyButton text={copyAdvice} showLabel className="ml-auto flex-shrink-0" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(detailedAnalysis.recommendations || []).map((recommendation, index) => (
            <div key={index} className="bg-white rounded-lg p-3 sm:p-4 border border-clay-border">
              <div className="flex items-start space-x-3">
                <div className="w-8 h-8 bg-primary-soft rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-primary text-sm font-medium">{index + 1}</span>
                </div>
                <div>
                  <h4 className="font-medium text-gray-800 mb-1">
                    {recommendation.split('：')[0] || recommendation.split(':')[0]}
                  </h4>
                  <p className="text-gray-600 text-sm leading-relaxed">
                    {recommendation.split('：')[1] || recommendation.split(':')[1] || recommendation}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 继续按钮 */}
      <div className="text-center">
        <button
          onClick={handleGenerateStory}
          disabled={isLoading}
          className="bg-primary-strong text-white py-3 px-8 rounded-lg font-medium hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center space-x-2 w-full sm:w-auto sm:mx-auto"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>{t('detailedGenerating')}</span>
            </>
          ) : (
            <>
              <span>{t('detailedStoryBtn')}</span>
              <ArrowRight className="w-5 h-5" />
            </>
          )}
        </button>
        
        <p className="text-ink-soft text-sm mt-3">
          {isPositive ? t('storySubPos') : t('storySub')}
        </p>

        {/* 继续聊聊：从理一理流向聊一聊 */}
        <button
          onClick={() => {
            // 聊天内「理一理」：直接关掉子视图回到聊天；独立理一理页：仍切到聊一聊模式
            if (onExitStructure) { onExitStructure(); return; }
            if (sessionId && !chatSessionId) setChatSessionId(sessionId);
            setAppMode('chat');
          }}
          className="mt-4 text-sm text-primary hover:text-primary-text underline underline-offset-4 transition-colors"
        >
          <MessageCircle className="w-4 h-4" /> {t('chatContinue')}
        </button>
      </div>

      {/* 温馨提示（靠近行动按钮，行动前可见） */}
      <div className={`mt-6 rounded-lg p-4 ${isPositive ? 'bg-amber-50/70 border border-amber-100' : 'bg-amber-50 border border-amber-200'}`}>
        <p className={`text-sm ${isPositive ? 'text-amber-800/90' : 'text-amber-800'}`}>
          {isPositive ? (
            <span>{t('disclaimerPos')}</span>
          ) : (
            <span>{t('disclaimerNeg')}</span>
          )}
        </p>
      </div>

      {/* 多轮追问 */}
      <FollowUpBox sessionId={sessionId} />
    </div>
  );
}