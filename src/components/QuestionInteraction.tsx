/**
 * 问题交互组件
 * 用户回答AI生成的深入问题
 */

import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle, MessageCircle, Brain, Zap, ShieldCheck, Handshake, Target } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { submitAnswers, generateDetailedAnalysis } from '../services/api';
import { t } from '../i18n';

export default function QuestionInteraction() {
  const {
    questions,
    currentQuestionIndex,
    setCurrentQuestionIndex,
    updateQuestionAnswer,
    sessionId,
    setDetailedAnalysis,
    setCurrentStep,
    isLoading,
    setLoading,
    setError,
    detailedAnalysis,
  } = useAppStore();

  const [localAnswer, setLocalAnswer] = useState('');
  const answerRef = useRef<HTMLTextAreaElement>(null);

  if (!questions.length) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-6">
        <div className="text-center text-ink-soft">
          {t('noQuestions')}
        </div>
      </div>
    );
  }

  const currentQuestion = questions[currentQuestionIndex];
  const isLastQuestion = currentQuestionIndex === questions.length - 1;
  // 已答题数（含当前输入）：未答完也能继续（不强求全答，情绪低落时不应被逼着答完）
  const answeredCount = questions.filter(q => q.answer && q.answer.trim().length > 0).length + (localAnswer.trim() ? 1 : 0);

  // 初始化当前问题的答案
  if (localAnswer === '' && currentQuestion.answer) {
    setLocalAnswer(currentQuestion.answer);
  }

  const handleSaveAnswer = () => {
    if (!localAnswer.trim()) {
      setError(t('errEmptyAnswer'));
      return;
    }
    
    updateQuestionAnswer(currentQuestion.id, localAnswer);
    setError(null);
  };

  const handleNext = () => {
    handleSaveAnswer();
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setLocalAnswer(questions[currentQuestionIndex + 1].answer || '');
    }
  };

  const handlePrevious = () => {
    handleSaveAnswer();
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
      setLocalAnswer(questions[currentQuestionIndex - 1].answer || '');
    }
  };

  // 跳过此题：保存已填内容（若有）后进入下一题；最后一题则直接提交
  const handleSkip = () => {
    handleSaveAnswer();
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setLocalAnswer(questions[currentQuestionIndex + 1].answer || '');
    } else {
      handleSubmitAll();
    }
  };

  // 输入时自动增高（答长问题不用滚动）
  const onAnswerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalAnswer(e.target.value);
    const el = answerRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 220) + 'px';
    }
  };

  const handleSubmitAll = async () => {
    // 回看：情绪笔记已生成过就直接进入，不重复调用 AI
    if (detailedAnalysis) {
      setCurrentStep('detailed' as const);
      return;
    }
    if (!sessionId) {
      setError(t('errSessionLost'));
      return;
    }

    // 至少回答一个问题即可继续（未答的题跳过，不强求全答）
    if (answeredCount === 0) {
      setError(t('errNeedAnswer'));
      return;
    }

    // 保存当前问题的答案
    handleSaveAnswer();

    setLoading(true);
    setError(null);

    try {
      // 第一步：提交所有答案
      const answers = questions.map(q => ({ questionId: q.id, answer: q.answer || '' }));
      const response = await submitAnswers(sessionId, answers);
      if (!response.success || !response.data) {
        setError(response.error || t('errFailed'));
        return;
      }

      // 第二步：生成详细分析
      const analysisResponse = await generateDetailedAnalysis(sessionId);
      if (!analysisResponse.success || !analysisResponse.data) {
        setError(analysisResponse.error || t('errFailed'));
        return;
      }

      // 第三步：保存分析结果并跳转
      setDetailedAnalysis(analysisResponse.data.analysis);
      setCurrentStep('detailed' as const);
    } catch {
      setError(t('errNetwork'));
    } finally {
      setLoading(false);
    }
  };

  const getQuestionTypeIcon = (type: string) => {
    const icons: Record<string, JSX.Element> = {
      'reflection': <Brain className="w-6 h-6 text-primary" />,
      'trigger': <Zap className="w-6 h-6 text-primary" />,
      'coping': <ShieldCheck className="w-6 h-6 text-primary" />,
      'support': <Handshake className="w-6 h-6 text-primary" />,
      'goal': <Target className="w-6 h-6 text-primary" />,
    };
    return icons[type] || <MessageCircle className="w-6 h-6 text-primary" />;
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      {/* 标题和进度 */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-accent rounded-full flex items-center justify-center">
            <MessageCircle className="w-8 h-8 text-white" />
          </div>
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
          {t('questionsTitle')}
        </h2>
        <p className="text-gray-600 mb-4">
          {t('questionsSub')}
        </p>
        
        {/* 进度条 */}
        <div className="max-w-md mx-auto">
          <div className="flex justify-between text-sm text-ink-soft mb-2">
            <span>{t('questionXofY', { n: currentQuestionIndex + 1, total: questions.length })}</span>
            
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-accent h-2 rounded-full transition-all duration-300"
              style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
            />
          </div>
          <p className="text-[11px] text-ink-soft mt-1.5">{t('questionProgress', { n: currentQuestionIndex + 1, total: questions.length, done: answeredCount })}</p>
        </div>
      </div>

      {/* 问题卡片 */}
      <div className="bg-white rounded-xl shadow-lg p-8 mb-6 border border-gray-100">
        <div className="flex items-start space-x-4 mb-6">
          <div className="w-12 h-12 bg-primary-soft rounded-full flex items-center justify-center flex-shrink-0">
            {getQuestionTypeIcon(currentQuestion.type)}
          </div>
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-2">
              <span className="text-sm font-medium text-primary bg-primary-soft px-2 py-1 rounded">
                {currentQuestion.type === 'reflection' ? t('qTypeReflection') :
                 currentQuestion.type === 'trigger' ? t('qTypeTrigger') :
                 currentQuestion.type === 'coping' ? t('qTypeCoping') :
                 currentQuestion.type === 'support' ? t('qTypeSupport') :
                 currentQuestion.type === 'goal' ? t('qTypeGoal') : t('qTypeOther')}
              </span>
            </div>
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3">
              {currentQuestion.question}
            </h3>
            <p className="text-gray-600 text-sm">
              {currentQuestion.purpose}
            </p>
          </div>
        </div>

        {/* 回答输入 */}
        <div className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">
            {t('yourAnswer')}
          </label>
          <textarea
            ref={answerRef}
            value={localAnswer}
            onChange={onAnswerChange}
            placeholder={t('thinkAsYouGo')}
            rows={3}
            className="w-full min-h-[96px] px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-all duration-200"
            disabled={isLoading}
          />
          
          {/* 保存提示 */}
          {currentQuestion.answer && currentQuestion.answer !== localAnswer && (
            <p className="text-sm text-amber-600 flex items-center space-x-1">
              <span>⚠️</span>
              <span>{t('answerAutosave')}</span>
            </p>
          )}
        </div>
      </div>

      {/* 导航按钮 */}
      <div className="flex flex-wrap justify-between items-center gap-2 sm:gap-0">
        <button
          onClick={handlePrevious}
          disabled={currentQuestionIndex === 0 || isLoading}
          className="flex items-center space-x-2 px-6 py-3 border border-gray-300 rounded-lg text-gray-700 w-full sm:w-auto hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>{t('prevQ')}</span>
        </button>

        <div className="flex items-center space-x-4">
          {/* 问题完成状态 */}
          <div className="hidden sm:flex space-x-2">
            {questions.map((_, index) => (
              <div
                key={index}
                className={`w-3 h-3 rounded-full transition-all duration-200 ${
                  index === currentQuestionIndex
                    ? 'bg-primary scale-125'
                    : questions[index].answer
                    ? 'bg-accent'
                    : 'bg-gray-300'
                }`}
              />
            ))}
          </div>
        </div>

        {isLastQuestion ? (
          <button
            onClick={handleSubmitAll}
            disabled={answeredCount === 0 || isLoading}
            className="flex items-center justify-center space-x-2 bg-primary-strong text-white px-6 py-3 rounded-lg font-medium w-full sm:w-auto hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            {isLoading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>{t('analyzingQ')}</span>
              </>
            ) : (
              <>
                <CheckCircle className="w-5 h-5" />
                <span>{t('submitQ')}</span>
              </>
            )}
          </button>
        ) : (
          <button
            onClick={handleNext}
            disabled={isLoading}
            className="flex items-center justify-center space-x-2 bg-primary-strong text-white px-6 py-3 rounded-lg font-medium w-full sm:w-auto hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            <span>{t('nextQ')}</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* 跳过本题 */}
      <div className="mt-4 text-center">
        <button
          onClick={handleSkip}
          disabled={isLoading}
          className="text-xs text-ink-soft hover:text-primary-text underline underline-offset-2 transition-colors"
        >
          {t('questionSkip')}
        </button>
      </div>

      {/* 提示信息 */}
      <div className="mt-6 bg-primary-lighter border border-clay-border rounded-lg p-4">
        <p className="text-sm text-primary-text">
          {t('tipAnswer')}
        </p>
      </div>
    </div>
  );
}