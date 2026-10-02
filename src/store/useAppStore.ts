/**
 * 应用状态管理
 * 使用zustand管理全局状态
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// 生产环境关闭 devtools（Redux DevTools 扩展不存在时仅为无谓包装）
const storeEnhancer = (import.meta.env.DEV ? devtools : ((c: unknown) => c)) as unknown as typeof devtools;
import type {
  EmotionAnalysis,
  Question,
  DetailedAnalysis,
  HealingStory,
  ChatMessage,
  ChatSource,
  ChatSessionMeta,
  PayTerm,
} from '../services/api';
import type { BridgeSeed } from '../lib/rpBridge';

export interface AppState {
  // 会话信息
  sessionId: string | null;
  
  // 当前步骤
  currentStep: 'input' | 'analysis' | 'questions' | 'detailed' | 'story';
  
  // 数据状态
  emotionAnalysis: EmotionAnalysis | null;
  questions: Question[];
  detailedAnalysis: DetailedAnalysis | null;
  healingStory: HealingStory | null;
  
  // UI状态
  isLoading: boolean;
  error: string | null;
  payOpen: boolean;
  payPlan: 'plus' | 'pro'; // 支付弹窗当前档位（Plus/Pro）
  payTerm: PayTerm; // 购买方式：月付 / 年付 / 买断
  payDays?: number; // 续费延长天数（Pro 续费场景 30/60/90）
  feedbackOpen: boolean; // 意见反馈弹窗（全局，各功能页均可打开）
  /** 界面外观弹窗（皮肤/卡片不透明度）——提到全局，好让剧情聊天页也能直接打开它调透明度 */
  appearanceOpen: boolean;
  feedbackContext: string | null; // 反馈附带上下文（AI 回答 / 最近对话）
  feedbackType: string; // 反馈初始类型（如 issue / suggest）
  privacyOpen: boolean; // 隐私政策弹窗（全局，各功能页/介绍页均可打开）
  privacyBannerH: number; // 底部隐私横幅当前高度（px，供聊一聊等底部布局为横幅预留空间）

  // 用户输入
  emotionInput: string;
  currentQuestionIndex: number;

  // 双模式：structure 理一理（结构化）/ chat 聊一聊（对话陪伴）
  appMode: 'structure' | 'chat';
  chatSessionId: string | null;
  chatMessages: ChatMessage[];
  chatSessions: ChatSessionMeta[]; // 聊一聊多对话列表（标题/预览/更新时间）
  // 理一理当前角色：从聊一聊自定义角色触发理一理时带上（用该角色的人设/记忆来梳理）；缺省/小愈 = null
  structureCharacterId: string | null;
  /**
   * 剧情 → 聊一聊 的交接（B 方案跨模式桥）：角色扮演页写好草稿放进这里，
   * 聊一聊挂载时读一次即清空。**只走 UI 层**——绝不写进 messages / chatMessages（红线 6）。
   */
  pendingChatSeed: BridgeSeed | null;
  /**
   * 我要打开的聊一聊角色（剧情角色导入完成后「去看看」用）：
   * 剧情页导入成功 → 写角色 id → 切到聊一聊 → 聊一聊加载完角色列表后**切到该角色**并清空。
   * 与 pendingChatSeed 同样是**只走 UI 层**的交接字段（不写进任何消息集合）。
   */
  pendingChatCharId: string | null;
}

export interface AppActions {
  // 会话管理
  setSessionId: (sessionId: string | null) => void;
  resetSession: () => void;
  
  // 步骤管理
  setCurrentStep: (step: AppState['currentStep']) => void;
  nextStep: () => void;
  
  // 数据更新
  setEmotionAnalysis: (analysis: EmotionAnalysis) => void;
  setQuestions: (questions: Question[]) => void;
  updateQuestionAnswer: (questionId: string, answer: string) => void;
  setDetailedAnalysis: (analysis: DetailedAnalysis) => void;
  setHealingStory: (story: HealingStory) => void;
  
  // UI状态管理
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setPayOpen: (open: boolean) => void;
  setPayPlan: (plan: 'plus' | 'pro') => void;
  setPayTerm: (term: PayTerm) => void;
  setPayDays: (days?: number) => void;
  openPay: (plan?: 'plus' | 'pro', term?: PayTerm, days?: number) => void;
  setFeedbackOpen: (open: boolean) => void;
  /** 界面外观弹窗（全局，好让剧情聊天页也能打开它） */
  setAppearanceOpen: (open: boolean) => void;
  setFeedbackContext: (ctx: string | null) => void;
  setFeedbackType: (t: string) => void;
  openFeedback: (opts?: { context?: string; type?: string }) => void;
  setPrivacyOpen: (open: boolean) => void;
  setPrivacyBannerH: (height: number) => void;

  // 用户输入管理
  setEmotionInput: (input: string) => void;
  setCurrentQuestionIndex: (index: number) => void;

  // 双模式
  setAppMode: (mode: 'structure' | 'chat') => void;
  setChatSessionId: (id: string | null) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  updateChatMessage: (id: string, content: string) => void;
  /** 给某条回复挂上「来源」（2026-09-29）：来源属于**整轮**，所以由调用方决定挂到哪一条气泡上 */
  setChatMessageSources: (id: string, sources: ChatSource[]) => void;
  setChatSessions: (list: ChatSessionMeta[]) => void;
  resetChat: () => void;
  setStructureCharacterId: (id: string | null) => void;
  setPendingChatSeed: (seed: BridgeSeed | null) => void;
  setPendingChatCharId: (id: string | null) => void;

  
  // 辅助方法
  canProceedToNextStep: () => boolean;
  getProgress: () => number;
}

const initialState: AppState = {
  sessionId: null,
  currentStep: 'input',
  emotionAnalysis: null,
  questions: [],
  detailedAnalysis: null,
  healingStory: null,
  isLoading: false,
  error: null,
  payOpen: false,
  payPlan: 'plus',
  payTerm: 'monthly',
  payDays: undefined,
  feedbackOpen: false,
  appearanceOpen: false,
  feedbackContext: null,
  feedbackType: 'suggest',
  privacyOpen: false,
  privacyBannerH: 0,
  emotionInput: '',
  currentQuestionIndex: 0,
  appMode: 'structure',
  chatSessionId: null,
  chatMessages: [],
  chatSessions: [],
  structureCharacterId: null,
  pendingChatSeed: null,
  pendingChatCharId: null,
};

export const useAppStore = create<AppState & AppActions>()(storeEnhancer(
  (set, get) => ({
    ...initialState,
    
    // 会话管理
    setSessionId: (sessionId) => set({ sessionId }),
    
    resetSession: () => set({
      ...initialState,
      sessionId: null,
    }),
    
    // 步骤管理
    setCurrentStep: (currentStep) => set({ currentStep }),
    
    nextStep: () => {
      const { currentStep } = get();
      const stepOrder: AppState['currentStep'][] = [
        'input', 'analysis', 'questions', 'detailed', 'story'
      ];
      const currentIndex = stepOrder.indexOf(currentStep);
      if (currentIndex < stepOrder.length - 1) {
        set({ currentStep: stepOrder[currentIndex + 1] });
      }
    },
    
    // 数据更新
    setEmotionAnalysis: (emotionAnalysis) => set({ emotionAnalysis }),
    
    setQuestions: (questions) => set({ questions, currentQuestionIndex: 0 }),
    
    updateQuestionAnswer: (questionId, answer) => {
      const { questions } = get();
      const updatedQuestions = questions.map(q => 
        q.id === questionId ? { ...q, answer } : q
      );
      set({ questions: updatedQuestions });
    },
    
    setDetailedAnalysis: (detailedAnalysis) => set({ detailedAnalysis }),
    
    setHealingStory: (healingStory) => set({ healingStory }),
    
    // UI状态管理
    setLoading: (isLoading) => set({ isLoading }),
    
    setError: (error) => set({ error }),
    
    setPayOpen: (payOpen) => set({ payOpen }),
    setPayPlan: (payPlan) => set({ payPlan }),
    setPayTerm: (payTerm) => set({ payTerm }),
    setPayDays: (payDays) => set({ payDays }),
    openPay: (plan, term, days) => set({ payPlan: plan ?? 'plus', payTerm: term ?? 'monthly', payDays: days, payOpen: true }),
    
    setFeedbackOpen: (feedbackOpen) => set({ feedbackOpen }),
    setAppearanceOpen: (appearanceOpen) => set({ appearanceOpen }),
    
    setFeedbackContext: (feedbackContext) => set({ feedbackContext }),

    setFeedbackType: (feedbackType) => set({ feedbackType }),

    openFeedback: (opts) => set({ feedbackOpen: true, feedbackContext: opts?.context || null, feedbackType: opts?.type || 'suggest' }),
    
    setPrivacyOpen: (privacyOpen) => set({ privacyOpen }),

    setPrivacyBannerH: (privacyBannerH) => set({ privacyBannerH }),

    // 用户输入管理
    setEmotionInput: (emotionInput) => set({ emotionInput }),
    
    setCurrentQuestionIndex: (currentQuestionIndex) => set({ currentQuestionIndex }),
    
    setAppMode: (appMode) => set({ appMode }),

    setChatSessionId: (chatSessionId) => set({ chatSessionId }),

    setChatMessages: (chatMessages) => set({ chatMessages }),

    addChatMessage: (msg) => set((st) => ({ chatMessages: [...st.chatMessages, msg] })),

    updateChatMessage: (id, content) => set((st) => ({ chatMessages: st.chatMessages.map(x => x.id === id ? { ...x, content } : x) })),

    setChatMessageSources: (id, sources) => set((st) => ({ chatMessages: st.chatMessages.map(x => x.id === id ? { ...x, sources } : x) })),

    setChatSessions: (chatSessions) => set({ chatSessions }),

    resetChat: () => set({ chatSessionId: null, chatMessages: [], chatSessions: [] }),

    setStructureCharacterId: (structureCharacterId) => set({ structureCharacterId }),

    setPendingChatSeed: (pendingChatSeed) => set({ pendingChatSeed }),

    setPendingChatCharId: (pendingChatCharId) => set({ pendingChatCharId }),

    // 辅助方法
    canProceedToNextStep: () => {
      const { currentStep, emotionAnalysis, questions, detailedAnalysis, healingStory } = get();
      
      switch (currentStep) {
        case 'input':
          return !!emotionAnalysis;
        case 'analysis':
          return questions.length > 0;
        case 'questions':
          return questions.every(q => q.answer && q.answer.trim().length > 0);
        case 'detailed':
          return !!detailedAnalysis;
        case 'story':
          return !!healingStory;
        default:
          return false;
      }
    },
    
    getProgress: () => {
      const { currentStep } = get();
      const stepOrder: AppState['currentStep'][] = [
        'input', 'analysis', 'questions', 'detailed', 'story'
      ];
      const currentIndex = stepOrder.indexOf(currentStep);
      return ((currentIndex + 1) / stepOrder.length) * 100;
    },
  }),
  {
    name: 'cure-app-store',
  }
));