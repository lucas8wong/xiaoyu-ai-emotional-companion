/**
 * FAQ 17 问内容（三语），用于 /faq 页面渲染 + FAQPage JSON-LD
 * 红线：陪伴非治疗；危机内容引导专业求助；品牌口径 gentle healing / Every feeling deserves to be understood.
 * 文案来源：seo-faq-content.md（2026-08-26）
 */
import type { Lang } from './i18n';

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ_ITEMS: Record<Lang, FaqItem[]> = {
  en: [
    {
      q: 'What is Xiaoyu?',
      a: 'Xiaoyu is an AI emotional companion — a warm space in your browser where every feeling is welcome. She listens, remembers what matters to you, and stays with you through the low moments and the bright ones. No download needed: just open the page and start talking.',
    },
    {
      q: 'Is Xiaoyu a therapist? Can she replace therapy?',
      a: 'No — Xiaoyu is a companion, not a treatment. She offers gentle, judgement-free company for everyday feelings, but she is not a therapist, counsellor, or medical service. If you need professional support, please reach out to a qualified professional or a local helpline.',
    },
    {
      q: 'Is Xiaoyu free?',
      a: 'Yes, you can start for free — every new user gets 5 free sessions to try. Plus (US$4.99/month) unlocks unlimited reflection and more daily chats; Pro (US$9.99/month) offers even longer conversations. You can start before deciding anything.',
    },
    {
      q: 'Are my conversations private?',
      a: 'Your conversations stay yours. Xiaoyu takes privacy seriously — your shares are not sold or used to advertise to you, and you can delete your account and data at any time. Everything you tell her is for being with you, nothing else.',
    },
    {
      q: 'Do I need to download anything?',
      a: 'No. Xiaoyu runs right in your browser, on your phone or computer — nothing to install, no app store, no registration required to try. Open the page and she is there.',
    },
    {
      q: 'Which languages does Xiaoyu support?',
      a: 'Simplified Chinese, Traditional Chinese, and English. Xiaoyu answers in the language you choose, and her tone can match regional speech styles — Cantonese, Northeastern, Beijing–Tianjin, Sichuan, and more.',
    },
    {
      q: 'Can I talk to Xiaoyu without signing up?',
      a: 'Yes, you can start as a guest right away. Creating an account keeps your chats across devices and unlocks member benefits like long-term memory and roleplay sessions.',
    },
    {
      q: 'What should I do if I am feeling very distressed or in crisis?',
      a: 'Please reach out to a qualified professional or a local crisis helpline right away — you deserve real, immediate human support. Xiaoyu is a companion, not an emergency service: she is not equipped to handle crises or provide medical help.',
    },
    {
      q: 'How is Xiaoyu different from ChatGPT or other AI assistants?',
      a: 'Xiaoyu is built for one job: being present with your feelings. Instead of answering questions or getting tasks done, she listens first, holds space for your emotions, and remembers what matters to you over time. She is not a general assistant — she is company.',
    },
    {
      q: 'Does Xiaoyu remember me?',
      a: 'If you allow it, yes. Xiaoyu keeps track of what is important to you — the things you care about and the moments that matter — so each conversation can build on the last instead of starting from zero.',
    },
    {
      q: 'Can Xiaoyu help with anxiety or sadness?',
      a: 'Xiaoyu can be a gentle companion when you feel anxious, low, or overwhelmed — a non-judgemental listener who stays with you. She will not diagnose, treat, or manage conditions; for ongoing struggles, professional support is the right step.',
    },
    {
      q: 'Is there a roleplay or story mode?',
      a: 'Yes — Xiaoyu also offers roleplay scenarios and an AI text adventure, so you can explore stories and characters in a safe, guided space. Self-created scenarios pass a content-safety review before they are saved.',
    },
    {
      q: 'How do I cancel my membership?',
      a: 'You can cancel your membership at any time — check your account for the cancellation option, or contact us and we will sort it out for you. No lock-in; you are welcome to stay or go.',
    },
    {
      q: 'Who is Xiaoyu?',
      a: 'Xiaoyu (sh-yao-yu) means "gentle healing" — a name that says exactly what she does. She is a little sprout from a small town in the East, and her one belief is that every feeling, including yours, deserves to be understood.',
    },
    {
      q: 'How do I start?',
      a: 'Just open myxiaoyu.com and say what is on your mind — a rough feeling, a happy moment, something you cannot quite name. You do not need to prepare; Xiaoyu will meet you there.',
    },
    {
      q: 'What is an AI companion?',
      a: 'An AI companion is an AI partner you can talk to about everyday feelings — for company, not treatment. Xiaoyu is one: a free AI emotional companion in your browser that listens, remembers, and answers in your language and regional voice. It is never a substitute for professional care.',
    },
    {
      q: 'What is AI roleplay?',
      a: 'AI roleplay is a story you tell with an AI that stays in character. Xiaoyu offers free AI roleplay scenarios and an AI text adventure, so you can explore characters and stories in a safe, content-safety-filtered space.',
    },
  ],
  'zh-TW': [
    { q: '小愈是什麼？', a: '小愈是一款 AI 情感陪伴應用，一個在瀏覽器裡隨時歡迎你所有情緒的溫暖空間。她會聽你說、記住對你重要的事，陪你度過低落，也見證你的快樂。無需下載，打開網頁就能開始聊天。' },
    { q: '小愈是治療師嗎？能取代治療嗎？', a: '不是，小愈是陪伴，不是治療。她提供溫暖、不評價的陪伴，承接日常情緒，但她不是治療師、諮商師或醫療服務。如果你需要專業支持，請聯繫合格專業人士或當地求助熱線。' },
    { q: '小愈免費嗎？', a: '免費的，新用戶都有 5 次免費體驗。Plus（US$4.99/月）解鎖無限理一理與更多每日聊天；Pro（US$9.99/月）提供更長的對話。你可以先開始，再決定要不要升級。' },
    { q: '我的對話隱私嗎？', a: '你的對話只屬於你。小愈重視隱私，你的分享不會被出售，也不會被用來向你投放廣告；你隨時可以刪除帳號與資料。你告訴她的一切，只用來好好陪著你。' },
    { q: '需要下載 App 嗎？', a: '不用。小愈直接在瀏覽器裡運行，手機或電腦都可以：不用安裝、不用去應用商店、試用也無需註冊。打開網頁，她就在。' },
    { q: '小愈支援哪些語言？', a: '簡體中文、繁體中文與英文。小愈會用你選擇的語言回應，語氣還能貼合不同地區：粵語、東北、京津、川渝等。' },
    { q: '不註冊可以和小愈聊天嗎？', a: '可以，你馬上就能以訪客身份開始。註冊帳號後，聊天記錄可跨裝置保留，並解鎖長期記憶、劇情扮演等會員權益。' },
    { q: '情緒很糟或處於危機時該怎麼辦？', a: '請立刻聯繫合格專業人士或當地危機求助熱線，你值得即時的真人支持。小愈是陪伴，不是緊急服務：她無法處理危機，也不提供醫療幫助。' },
    { q: '小愈和 ChatGPT 或其他 AI 助手有什麼不同？', a: '小愈只專心做一件事：好好陪著你的感受。她不會急著回答問題或幫你辦事，而是先聽你說、接住你的情緒，並慢慢記住對你重要的事。她不是萬能助手，她是陪伴。' },
    { q: '小愈會記得我嗎？', a: '只要你允許，會的。小愈會記住對你重要的事：你在意的、特別的時刻，讓每次對話都能接續上一次，而不是每次都從零開始。' },
    { q: '小愈能幫助焦慮或憂鬱嗎？', a: '當你焦慮、低落或不堪重負時，小愈可以是溫柔的陪伴：一個不評價、願意陪著你的聽眾。她不會診斷、治療或管理任何狀況；如果是持續的困擾，尋求專業支持才是對的方向。' },
    { q: '有角色扮演或故事模式嗎？', a: '有：小愈還提供角色扮演劇本與 AI 文遊，讓你在安全、有引導的空間裡探索故事與角色。自建劇本會先通過內容安全審核才會保存。' },
    { q: '如何取消會員？', a: '會員可以隨時取消，在帳號裡找到取消選項，或直接聯繫我們處理。不綁定、不為難，去留都歡迎。' },
    { q: '小愈是誰？', a: '小愈（sh-yao-yu）的意思是「溫柔療癒」，這個名字就是她做的事。她是一株來自東方一座小城的小芽，唯一的信念是：每一種情緒，包括你的，都值得被理解。' },
    { q: '怎麼開始？', a: '打開 myxiaoyu.com，說說你心裡的話就好：難受的、開心的、還說不清楚的都可以。不用準備，小愈會在那裡等你。' },
    { q: '什麼是 AI 情感陪伴？', a: 'AI 情感陪伴是一個可以陪你聊聊日常情緒的 AI 夥伴，是陪伴，不是治療。小愈就是一個：在瀏覽器裡免費使用的 AI 情感陪伴，會聽你說、記住你在意的事，並用你選擇的語言與地方腔調回應。它永遠不能取代專業照護。' },
    { q: '什麼是 AI 角色扮演？', a: 'AI 角色扮演是跟一個維持角色設定的 AI 一起編故事。小愈提供免費的 AI 角色扮演劇本與 AI 文遊，讓你在安全、經過內容安全過濾的空間裡探索角色與故事。' },
  ],
  'zh-CN': [
    { q: '小愈是什么？', a: '小愈是一款 AI 情感陪伴应用，一个在浏览器里随时欢迎你所有情绪的温暖空间。她会听你说、记住对你重要的事，陪你度过低落，也见证你的快乐。无需下载，打开网页就能开始聊天。' },
    { q: '小愈是治疗师吗？能取代治疗吗？', a: '不是，小愈是陪伴，不是治疗。她提供温暖、不评判的陪伴，承接日常情绪，但她不是治疗师、咨询师或医疗服务。如果你需要专业支持，请联系合格专业人士或当地求助热线。' },
    { q: '小愈免费吗？', a: '免费的，新用户都有 5 次免费体验。Plus（US$4.99/月）解锁无限理一理与更多每日聊天；Pro（US$9.99/月）提供更长的对话。你可以先开始，再决定要不要升级。' },
    { q: '我的对话隐私吗？', a: '你的对话只属于你。小愈重视隐私，你的分享不会被出售，也不会被用来向你投放广告；你随时可以删除账号与资料。你告诉她的一切，只用来好好陪着你。' },
    { q: '需要下载 App 吗？', a: '不用。小愈直接在浏览器里运行，手机或电脑都可以：不用安装、不用去应用商店、试用也无需注册。打开网页，她就在。' },
    { q: '小愈支持哪些语言？', a: '简体中文、繁体中文与英文。小愈会用你选择的语言回应，语气还能贴合不同地区：粤语、东北、京津、川渝等。' },
    { q: '不注册可以和小愈聊天吗？', a: '可以，你马上就能以访客身份开始。注册账号后，聊天记录可跨设备保留，并解锁长期记忆、剧情扮演等会员权益。' },
    { q: '情绪很糟或处于危机时该怎么办？', a: '请立刻联系合格专业人士或当地危机求助热线，你值得即时的真人支持。小愈是陪伴，不是紧急服务：她无法处理危机，也不提供医疗帮助。' },
    { q: '小愈和 ChatGPT 或其他 AI 助手有什么不同？', a: '小愈只专心做一件事：好好陪着你的感受。她不会急着回答问题或帮你办事，而是先听你说、接住你的情绪，并慢慢记住对你重要的事。她不是万能助手，她是陪伴。' },
    { q: '小愈会记得我吗？', a: '只要你允许，会的。小愈会记住对你重要的事：你在意的、特别的时刻，让每次对话都能接续上一次，而不是每次都从零开始。' },
    { q: '小愈能帮助焦虑或抑郁吗？', a: '当你焦虑、低落或不堪重负时，小愈可以是温柔的陪伴：一个不评判、愿意陪着你的听众。她不会诊断、治疗或管理任何状况；如果是持续的困扰，寻求专业支持才是对的方向。' },
    { q: '有角色扮演或故事模式吗？', a: '有：小愈还提供角色扮演剧本与 AI 文游，让你在安全、有引导的空间里探索故事与角色。自建剧本会先通过内容安全审核才会保存。' },
    { q: '如何取消会员？', a: '会员可以随时取消，在账号里找到取消选项，或直接联系我们处理。不绑定、不为难，去留都欢迎。' },
    { q: '小愈是谁？', a: '小愈（sh-yao-yu）的意思是「温柔疗愈」，这个名字就是她做的事。她是一株来自东方一座小城的小芽，唯一的信念是：每一种情绪，包括你的，都值得被理解。' },
    { q: '怎么开始？', a: '打开 myxiaoyu.com，说说你心里的话就好：难受的、开心的、还说不清楚的都可以。不用准备，小愈会在那里等你。' },
    { q: '什么是 AI 情感陪伴？', a: 'AI 情感陪伴是一个可以陪你聊聊日常情绪的 AI 伙伴，是陪伴，不是治疗。小愈就是一个：在浏览器里免费使用的 AI 情感陪伴，会听你说、记住你在意的事，并用你选择的语言与地方腔调回应。它永远不能取代专业照护。' },
    { q: '什么是 AI 角色扮演？', a: 'AI 角色扮演是跟一个保持角色设定的 AI 一起编故事。小愈提供免费的 AI 角色扮演剧本与 AI 文游，让你在安全、经过内容安全过滤的空间里探索角色与故事。' },
  ],
};

export const FAQ_TITLE: Record<Lang, string> = {
  en: 'Xiaoyu FAQ — AI Emotional Companion Questions Answered',
  'zh-TW': '小愈 FAQ — AI 情感陪伴常見問題',
  'zh-CN': '小愈 FAQ — AI 情感陪伴常见问题',
};

export const FAQ_META_DESC: Record<Lang, string> = {
  en: 'Answers to common questions about Xiaoyu — is she a therapist, is it free, is it private, which languages, and how to start. Every feeling deserves to be understood.',
  'zh-TW': '小愈常見問題：她是治療師嗎、收費嗎、對話隱私嗎、支援哪些語言、怎麼開始？每一種情緒都值得被理解。',
  'zh-CN': '小愈常见问题：她是治疗师吗、收费吗、对话隐私吗、支持哪些语言、怎么开始？每一种情绪都值得被理解。',
};
