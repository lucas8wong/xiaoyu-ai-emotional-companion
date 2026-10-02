/**
 * 暖心故事展示组件
 * 显示AI生成的情感陪伴故事
 */

import { useState, useRef, useEffect } from 'react';
import { BookOpen, Check, Volume2, VolumeX, Share2, Copy } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import StoryShareModal from './StoryShareModal';
import AiFeedbackMark from './AiFeedbackMark';
import { t, getLang, localizeEmotion } from '../i18n';

function emotionEmoji(emotion?: string | null): string {
  const e = emotion || '';
  if (/焦虑|anxiety/i.test(e)) return '😟';
  if (/悲伤|孤独|sad|lonel/i.test(e)) return '🌙';
  if (/愤怒|anger/i.test(e)) return '😠';
  if (/快乐|joy|happy/i.test(e)) return '😊';
  if (/平静|calm/i.test(e)) return '😌';
  return '💛';
}

export default function HealingStory({ onExitStructure }: { onExitStructure?: () => void } = {}) {
  const {
    healingStory,
    emotionAnalysis,
    resetSession,
    setError,
    sessionId,
    setAppMode,
    chatSessionId,
    setChatSessionId,
  } = useAppStore();

  const [isReading, setIsReading] = useState(false);
  const [currentParagraph, setCurrentParagraph] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [storyCopied, setStoryCopied] = useState(false);

  // 【朗读：云端 Edge TTS（神经音色）优先，浏览器 Web Speech 兜底】
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const engineRef = useRef<'cloud' | 'web' | null>(null);
  const idxRef = useRef(0);
  const langRef = useRef<'zh-CN' | 'zh-TW' | 'en'>('zh-CN');
  const stopRef = useRef(false);
  const cloudUrlRef = useRef<string | null>(null);

  // 卸载时清理（必须在任何条件 return 之前声明，保证 hooks 顺序稳定）
  useEffect(() => () => {
    stopRef.current = true;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    if (cloudUrlRef.current) { try { URL.revokeObjectURL(cloudUrlRef.current); } catch { /* ignore */ } }
  }, []);

  const handleCopyStory = async () => {
    if (!healingStory) return;
    const text = `${healingStory.title}\n\n${healingStory.content}\n\n— ${t('shareCardFrom')}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setStoryCopied(true);
    setTimeout(() => setStoryCopied(false), 2000);
  };

  if (!healingStory) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="text-center text-ink-soft">
          {t('noStory')}
        </div>
      </div>
    );
  }

  /** 按界面语言选择系统最自然的音色（Web Speech 兜底用） */
  const pickVoice = (lang: string): SpeechSynthesisVoice | null => {
    try {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return null;
      const prefs: Record<string, string[]> = {
        'zh-CN': ['Ting-Ting', 'Yating', 'Huihui', 'Xiaoxiao', 'XiaoXiao', 'Yunxi', 'Yunyang', 'Yaoyao'],
        'zh-TW': ['HsiaoChen', 'Mei-Jia', 'YunJhe', 'HanHan'],
        en: ['Natural', 'Neural', 'Google US English', 'Microsoft Aria', 'Microsoft Guy', 'Microsoft Jenny', 'Samantha', 'Daniel', 'Karen', 'Moira', 'Siri'],
      };
      const wants = prefs[lang] || prefs.en;
      for (const name of wants) {
        const hit = voices.find(v => v.lang.toLowerCase().startsWith(lang.toLowerCase()) && v.name.toLowerCase().includes(name.toLowerCase()));
        if (hit) return hit;
      }
      return voices.find(v => v.lang.toLowerCase().startsWith(lang.toLowerCase())) || null;
    } catch { return null; }
  };

  /** 请求后端 Edge TTS（Azure 神经音色），返回 object URL；失败返回 null */
  const fetchCloudTTS = async (text: string, lang: string): Promise<string | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch((import.meta.env.VITE_API_BASE_URL || '') + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob || blob.size < 1000) return null;
      return URL.createObjectURL(blob);
    } catch { return null; }
  };

  /** 停止朗读：清空所有状态 */
  const stopReading = () => {
    stopRef.current = true;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    if (cloudUrlRef.current) {
      try { URL.revokeObjectURL(cloudUrlRef.current); } catch { /* ignore */ }
      cloudUrlRef.current = null;
    }
    engineRef.current = null;
    idxRef.current = 0;
    setIsReading(false);
    setCurrentParagraph(0);
  };

  /** Web Speech 兜底：逐段朗读并高亮 */
  const speakWebPara = (i: number, lang: string) => {
    if (stopRef.current) return;
    engineRef.current = 'web';
    if (i >= paragraphs.length) { stopReading(); return; }
    idxRef.current = i;
    setCurrentParagraph(i);
    const u = new SpeechSynthesisUtterance(paragraphs[i]);
    u.lang = lang;
    u.rate = 0.95;
    u.pitch = 1;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.onend = () => { if (!stopRef.current && engineRef.current === 'web') speakWebPara(i + 1, lang); };
    u.onerror = () => { if (!stopRef.current) { stopReading(); setError(t('errSpeech')); } };
    window.speechSynthesis.speak(u);
  };

  /** 云端 TTS：逐段合成播放；失败自动回退 Web Speech */
  const playCloudPara = async (i: number, lang: string) => {
    if (stopRef.current) return;
    engineRef.current = 'cloud';
    if (i >= paragraphs.length) { stopReading(); return; }
    idxRef.current = i;
    setCurrentParagraph(i);
    const url = await fetchCloudTTS(paragraphs[i], lang);
    if (stopRef.current) { if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } } return; }
    if (!url || !audioRef.current) { speakWebPara(i, lang); return; }
    if (cloudUrlRef.current) { try { URL.revokeObjectURL(cloudUrlRef.current); } catch { /* ignore */ } }
    cloudUrlRef.current = url;
    const el = audioRef.current;
    el.src = url;
    try { await el.play(); } catch { speakWebPara(i, lang); }
  };

  const handleReadAloud = () => {
    if (isReading) { stopReading(); return; }
    stopRef.current = false;
    setIsReading(true);
    const lang = getLang();
    langRef.current = lang;
    playCloudPara(0, lang);
  };

  const paragraphs = healingStory.content.split('\n\n').filter(p => p.trim());
  const storyContext = healingStory.title + '\n\n' + healingStory.content;

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* 标题 */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center">
            <BookOpen className="w-8 h-8 text-white" />
          </div>
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
          {t('storyTitle')}
        </h2>
        <p className="text-gray-600">
          {t('storySub')}
        </p>
      </div>

      {/* 故事信息卡片（主题 / 阅读时长；标题在正文卡片里，不重复展示） */}
      <div className="bg-primary-lighter rounded-xl px-3 py-2.5 mb-5 border border-clay-border">
        <div className="grid grid-cols-2 gap-2 items-center">
          <div className="flex items-center justify-center gap-1.5 min-w-0">
            <span className="w-7 h-7 rounded-full bg-primary-soft flex items-center justify-center flex-shrink-0">
              <span className="text-sm">{healingStory.theme === 'growth' ? '🌱' :
                                        healingStory.theme === 'healing' ? '💝' :
                                        healingStory.theme === 'hope' ? '🌟' :
                                        healingStory.theme === 'strength' ? '💪' : '✨'}</span>
            </span>
            <div className="min-w-0 text-center">
              <h3 className="font-semibold text-gray-800 text-[13px] leading-tight truncate">
                {healingStory.theme === 'growth' ? t('themeGrowth') :
                 healingStory.theme === 'healing' ? t('themeWarm2') :
                 healingStory.theme === 'hope' ? t('themeHope') :
                 healingStory.theme === 'strength' ? t('themeStrength') : t('themeOther')}
              </h3>
              <p className="text-[10px] text-ink-soft">{t('storyTheme')}</p>
            </div>
          </div>

          <div className="flex items-center justify-center gap-1.5 min-w-0">
            <span className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <BookOpen className="w-4 h-4 text-primary" />
            </span>
            <div className="min-w-0 text-center">
              <h3 className="font-semibold text-gray-800 text-[13px] leading-tight">
                {t('storyMinutes', { n: Math.ceil(healingStory.content.length / 300) })}
              </h3>
              <p className="text-[10px] text-ink-soft">{t('storyReadTime')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 故事内容 */}
      <div className="bg-white rounded-xl shadow-lg p-8 mb-8 border border-gray-100">
        {/* 控制按钮 */}
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-semibold text-gray-800">
            {healingStory.title}
          </h3>
          
          <button
            onClick={handleReadAloud}
            className="flex items-center space-x-2 px-4 py-2 bg-primary-soft text-primary rounded-lg hover:bg-primary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-all duration-200"
          >
            {isReading ? (
              <>
                <VolumeX className="w-5 h-5" />
                <span>{t('stopReading')}</span>
              </>
            ) : (
              <>
                <Volume2 className="w-5 h-5" />
                <span>{t('startReading')}</span>
              </>
            )}
          </button>
        </div>

        {/* 故事正文 */}
        <div className="prose prose-lg max-w-none">
          {paragraphs.map((paragraph, index) => (
            <p 
              key={index}
              className={`mb-6 leading-relaxed text-gray-700 transition-all duration-300 ${
                isReading && index === currentParagraph 
                  ? 'bg-yellow-50 border-l-4 border-yellow-400 pl-4 py-2 rounded-r' 
                  : ''
              }`}
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* {t('storyMoral')} */}
        {healingStory.moral && (
          <div className="mt-8 bg-primary-lighter rounded-lg p-6 border border-clay-border">
            <h4 className="font-semibold text-gray-800 mb-3 flex items-center">
              <span className="w-2 h-2 bg-primary rounded-full mr-3"></span>
              {t('storyMoral')}
            </h4>
            <p className="text-gray-700 leading-relaxed italic">
              {healingStory.moral}
            </p>
          </div>
        )}
      </div>

      {/* 故事反馈小标 */}
      <div className="flex justify-end -mt-4 mb-6">
        <AiFeedbackMark context={storyContext} />
      </div>

      {/* 互动反馈 */}
      <div className="bg-accent-soft rounded-xl p-6 mb-8 border border-green-100">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">
          {t('storyReflect')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-lg p-4 border border-green-100">
            <h4 className="font-medium text-gray-800 mb-2">{t('storyInspire')}</h4>
            <p className="text-sm text-gray-600">
              {t('storyInspireDesc')}
            </p>
          </div>
          
          <div className="bg-white rounded-lg p-4 border border-blue-100">
            <h4 className="font-medium text-gray-800 mb-2">{t('storyAction')}</h4>
            <p className="text-sm text-gray-600">
              {t('storyActionDesc')}
            </p>
          </div>
        </div>
      </div>

      {/* 完成按钮：完成=主操作全宽置顶；复制/分享=次级操作 */}
      <div className="text-center">
        <button
          onClick={() => resetSession()}
          className="bg-primary-strong text-white py-3.5 px-8 rounded-xl font-semibold hover:bg-primary transition-all duration-200 flex items-center justify-center space-x-2 w-full sm:max-w-sm sm:mx-auto"
        >
          <Check className="w-5 h-5" />
          <span>{t('storyDone')}</span>
        </button>
        <div className="flex flex-col sm:flex-row items-stretch justify-center gap-3 mt-3">
          <button
            onClick={handleCopyStory}
            className="bg-white border-2 border-primary text-primary py-2.5 px-6 rounded-lg font-medium hover:bg-primary-lighter transition-all duration-200 flex items-center justify-center space-x-2 w-full sm:w-auto"
          >
            {storyCopied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
            <span>{storyCopied ? t('storyCopied') : t('storyCopy')}</span>
          </button>
          <button
            onClick={() => setShareOpen(true)}
            className="bg-white border-2 border-primary text-primary py-2.5 px-6 rounded-lg font-medium hover:bg-primary-lighter transition-all duration-200 flex items-center justify-center space-x-2 w-full sm:w-auto"
          >
            <Share2 className="w-5 h-5" />
            <span>{t('storyShare')}</span>
          </button>
        </div>
        <div className="mt-4">
          <button
            onClick={() => {
              // 聊天内「理一理」：直接关掉子视图回到聊天；独立理一理页：仍切到聊一聊模式
              if (onExitStructure) { onExitStructure(); return; }
              if (sessionId && !chatSessionId) setChatSessionId(sessionId);
              setAppMode('chat');
            }}
            className="text-sm text-primary hover:text-primary-text underline underline-offset-4 transition-colors"
          >
            {t('chatContinue')}
          </button>
        </div>
        
        <p className="text-ink-soft text-sm mt-3">
          {t('storySaved')}
        </p>
      </div>

      {/* 朗读音频（云端 TTS 播放，隐藏） */}
      <audio
        ref={audioRef}
        className="hidden"
        onEnded={() => { if (!stopRef.current && engineRef.current === 'cloud') playCloudPara(idxRef.current + 1, langRef.current); }}
        onError={() => { if (!stopRef.current && engineRef.current === 'cloud') speakWebPara(idxRef.current, langRef.current); }}
      />

      <StoryShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t('storyShareTitle')}
        subtitle={(localizeEmotion(emotionAnalysis?.emotion) || t('shareEmotionFallback')) + ' · ' + t('shareIntensity', { intensity: emotionAnalysis?.intensity ?? '-' })}
        headerEmoji={emotionEmoji(emotionAnalysis?.emotion)}
        bubbles={[{ side: 'them' as const, name: t('appName'), content: healingStory.title + '\n\n' + healingStory.content }]}
      />
    </div>
  );
}