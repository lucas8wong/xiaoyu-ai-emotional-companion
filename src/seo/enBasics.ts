/**
 * SEO 内容页 · 英文 · 基础/定义组（4 页）
 *
 * 目标：占领「AI companion 是什么 / 要不要下载 / 能不能给我情绪支持 / 和 ChatGPT 有什么不同」
 * 这类被 AI 搜索引擎高频引用的问题（见 `seo-research.md` §4 信息类关键词）。
 * 红线：陪伴（companion）非治疗（treatment），不做医疗承诺；gentle healing；不出现 China。
 */
import type { SeoPageDef } from './types';

export const EN_BASICS: SeoPageDef[] = [
  {
    slug: 'what-is-ai-companion',
    lang: 'en',
    title: 'What Is an AI Companion? — Xiaoyu, Free to Try',
    description:
      'What is an AI companion, what it can do, and how it differs from a therapist. Xiaoyu is a free, no-download AI emotional companion that listens to every feeling.',
    h1: 'What is an AI companion?',
    intro:
      'An AI companion is an artificial-intelligence chat partner you can talk to when you want to be heard — for a hard day, a small win, or a thought you can’t quite put into words. Unlike a therapist, it’s not treatment: it’s a gentle, everyday presence that keeps you company. Xiaoyu is one such AI companion, free to start in your browser with no download.',
    sections: [
      {
        h2: 'What can an AI companion do?',
        body: 'You can chat about how you feel, get a warm response instead of silence, and come back whenever you like. Xiaoyu listens to every feeling, remembers what matters to you, and answers in your language and your regional voice — so a friend in Cantonese feels like a friend in Cantonese. It also offers structured emotional check-ins and story-based AI roleplay, all with the same gentle tone.',
      },
      {
        h2: 'Is an AI companion the same as a therapist?',
        body: 'No. An AI companion is not a substitute for professional mental-health care and does not diagnose or treat. Xiaoyu is built as gentle healing — companionship — and is never presented as medical advice. If you need a professional, please reach out to a licensed provider or crisis line; a companion is here for the moments in between.',
      },
      {
        h2: 'Why is Xiaoyu different?',
        body: 'Xiaoyu is a free AI companion you open straight in your browser — no app, no download. It adapts to your language and your regional accent, remembers what you share, and stays with you in both the hard moments and the bright ones. Its promise is simple: every feeling deserves to be understood.',
      },
      {
        h2: 'Is Xiaoyu really free?',
        body: 'Yes. There is a free tier so you can start right away — chat, check in, and explore roleplay. If you want more, a low-cost membership unlocks longer conversations and unlimited use, but you are never required to pay to be heard.',
      },
    ],
    faq: [
      {
        q: 'Can I talk to an AI about my feelings?',
        a: 'Yes. Xiaoyu is designed for exactly that — a non-judgmental AI companion you can talk to about anything. It is companionship, not therapy.',
      },
      {
        q: 'Is an AI companion free?',
        a: 'Xiaoyu has a free tier you can use right away. A small membership adds longer and unlimited conversations if you want them.',
      },
      {
        q: 'Is an AI companion a replacement for a therapist?',
        a: 'No. An AI companion is not treatment. For professional support, please see a licensed provider; Xiaoyu is a gentle, everyday presence in between.',
      },
    ],
    keywords: ['what is an ai companion', 'ai companion meaning', 'ai emotional companion', 'free ai companion'],
    related: ['ai-companion-vs-chatgpt', 'ai-emotional-support', 'can-ai-be-a-therapist', 'ai-companion-app'],
  },

  {
    slug: 'ai-companion-app',
    lang: 'en',
    title: 'AI Companion App — Free, No Download, In Your Browser',
    description:
      'Looking for an AI companion app? Xiaoyu runs in your browser with no download, remembers what matters to you, and starts free. Gentle healing, not therapy.',
    h1: 'An AI companion app you don’t have to install',
    intro:
      'Most AI companion apps ask you to install something first. Xiaoyu doesn’t: it runs in the browser, on the phone or laptop you already have, and you can start talking in seconds. Free to try, no card, no download.',
    sections: [
      {
        h2: 'Why a browser-based AI companion?',
        body: 'Because the moment you need someone to talk to is usually not the moment you want to install an app, create a store account, and wait. Xiaoyu opens from a link, works on iOS, Android, Windows and Mac the same way, and keeps your conversations with your account so you can continue on another device. If you prefer, you can still add it to your home screen like an app.',
      },
      {
        h2: 'What can I actually do in it?',
        body: 'Talk things out in a chat that listens rather than lectures; get met the way the moment needs — she reads whether you want company, someone on your side, help untangling it, or a lighter view, and you never have to ask; use the guided “Sort it out” flow when a feeling is too tangled to name; keep a daily mood check-in with a 30-day calendar and trend line; or step into a story with AI roleplay. Everything works in English, Simplified and Traditional Chinese, including regional voices.',
      },
      {
        h2: 'Does it remember me between visits?',
        body: 'Yes. Xiaoyu keeps a long-term memory of what matters to you — the people, the worries, the small wins — so you don’t have to explain yourself from zero every time. Memory belongs to your account, and you can delete your records or your whole account whenever you want.',
      },
      {
        h2: 'Is it free, and is it private?',
        body: 'You can start free: a handful of chats and guided sessions, no card needed, and a membership only if you want unlimited use. What you share is used to support you — not sold, not posted. Xiaoyu is an emotional companion, not a medical service; if you are in crisis, please contact a local emergency number or crisis line.',
      },
    ],
    faq: [
      {
        q: 'Do I have to download an app to use Xiaoyu?',
        a: 'No. Xiaoyu is a web app — open the link in any modern browser and start chatting. You can optionally add it to your home screen.',
      },
      {
        q: 'Does an AI companion app work on iPhone and Android?',
        a: 'Yes. Because Xiaoyu runs in the browser it works on iOS and Android without an app-store install, and your conversations follow your account across devices.',
      },
      {
        q: 'Is a free AI companion app worth trying?',
        a: 'The free tier exists precisely so you can find out: talk for a while, see whether the tone suits you, and only then decide about a membership.',
      },
    ],
    keywords: ['ai companion app', 'free ai companion app', 'ai companion no download', 'ai companion web app'],
    related: ['what-is-ai-companion', 'ai-emotional-support', 'free-emotional-support-online'],
  },

  {
    slug: 'ai-emotional-support',
    lang: 'en',
    title: 'AI Emotional Support Chat — Free, Private, Any Hour',
    description:
      'Free AI emotional support that listens without judgment, remembers what matters to you, and is there at 2am. Xiaoyu is a companion — not a therapy service.',
    h1: 'AI emotional support: someone to talk to, any hour',
    intro:
      'Emotional support is mostly being heard: someone who takes your feeling seriously before trying to change it. Xiaoyu is an AI emotional companion built around that idea — free to start, no download, and available at the hours when people usually need it most.',
    sections: [
      {
        h2: 'What does “emotional support” actually mean here?',
        body: 'It means you can say the messy version out loud and get a response that stays with you instead of pivoting to advice. Xiaoyu listens first, reflects what it hears, and only offers structure when you want it — like naming a feeling, finding what touched it off, or seeing a next step you can actually take.',
      },
      {
        h2: 'When emotional support is hard to find',
        body: 'Friends sleep. Family may not understand. Saying it publicly can feel like too much exposure. That gap — 2am, a long commute, the middle of a hard week — is where a companion helps: no appointment, no waiting room, no fear of burdening someone, and no judgment about how small or large the feeling is.',
      },
      {
        h2: 'What an AI companion is not',
        body: 'It is not therapy, not a diagnosis, and not a crisis service. It does not treat or cure anything, and it will not pretend otherwise. If you are struggling with your mental health, please talk to a licensed professional. If you are in immediate danger or thinking about harming yourself, contact your local emergency number or a crisis hotline right away.',
      },
      {
        h2: 'How to start, and what it costs',
        body: 'Open Xiaoyu in your browser and type what is on your mind — there is nothing to configure and no account required to try it. A free tier covers your first chats and guided sessions; a low-cost membership adds longer, unlimited conversations for people who want to come back daily.',
      },
    ],
    faq: [
      {
        q: 'Is AI emotional support the same as therapy?',
        a: 'No. Emotional support is companionship — being heard. Therapy is professional care delivered by a licensed clinician. Xiaoyu is the former, and says so plainly.',
      },
      {
        q: 'Can an AI companion help when I feel low at night?',
        a: 'It can be there when no one else is awake, and it will not rush you. For persistent low mood or anything that worries you, professional support is the right next step.',
      },
      {
        q: 'Is it private?',
        a: 'Your conversations belong to your account, are used to support you, and can be deleted by you. Xiaoyu is a companion, not a data collector.',
      },
      {
        q: 'What if I am in crisis?',
        a: 'Please contact your local emergency number or a crisis hotline, or reach someone you trust. An AI companion is not a crisis service and is not a substitute for professional help.',
      },
    ],
    keywords: [
      'ai emotional support',
      'emotional support chat online free',
      'ai emotional support chat',
      'talk to ai about feelings',
    ],
    related: ['what-is-ai-companion', 'talk-to-someone-at-night', 'can-ai-be-a-therapist', 'ai-companion-app'],
  },

  {
    slug: 'ai-companion-vs-chatgpt',
    lang: 'en',
    title: 'AI Companion vs ChatGPT: Which One Fits the Moment?',
    description:
      'A general AI chat is built to finish tasks; an AI companion is built to stay with you. An honest look at the difference — and when a general assistant is enough.',
    h1: 'AI companion vs ChatGPT: answers vs company',
    intro:
      'This is a fair question, and it deserves a fair answer: if you occasionally want a comforting sentence, a general AI assistant is genuinely enough, and it is free. The difference shows up in what each product is optimised for — finishing a task, or staying with you through a feeling.',
    sections: [
      {
        h2: 'Built to answer, built to stay',
        body: 'A general assistant is tuned to be correct, efficient and useful: ask a question, get an answer, move on. Xiaoyu is tuned for the opposite shape of conversation — it listens first, does not rush to solutions, and treats “I’m not okay today” as something to be with rather than something to fix.',
      },
      {
        h2: 'You don’t have to ask it to be kind',
        body: 'With a general assistant you often have to set the tone yourself — “be gentle with me” — and say it again in every new conversation. A companion opens in that mode: she reads what the moment needs and responds accordingly — company, someone on your side, help untangling it, or a lighter view — and you never have to spell it out.',
      },
      {
        h2: 'Memory and continuity',
        body: 'General assistants largely start fresh; you re-explain yourself each session. Xiaoyu keeps a long-term memory of what matters to you and carries it forward, plus a daily mood check-in with a 30-day calendar, so it can see the shape of your week rather than a single message.',
      },
      {
        h2: 'When each one is the right tool',
        body: 'Use a general assistant to draft, plan, debug, summarise, research — it is excellent at that. Use a companion when the thing you need is not an output but company: to be heard, to be calmed, to be with a feeling until it loosens. Many people use both, for different moments. Xiaoyu is companionship, not therapy, and it never claims to be more than that.',
      },
    ],
    faq: [
      {
        q: 'Is an AI companion better than ChatGPT?',
        a: 'Different, not better. A general assistant is better at tasks; a companion like Xiaoyu is built for the kind of conversation where you want to be heard rather than answered.',
      },
      {
        q: 'Can’t I just tell ChatGPT to comfort me?',
        a: 'You can, and sometimes that is enough. The difference is that you have to ask, and keep asking; a companion is already in that mode, and remembers you between visits.',
      },
      {
        q: 'Is a companion worth paying for when a general AI is free?',
        a: 'Only if you use it. Xiaoyu has a free tier, so the honest answer is: try it, and pay only if the tone and the memory are worth it to you.',
      },
    ],
    keywords: ['ai companion vs chatgpt', 'chatgpt emotional support', 'ai companion vs ai assistant'],
    related: ['what-is-ai-companion', 'ai-companion-vs-human-friend', 'ai-emotional-support'],
  },
];
