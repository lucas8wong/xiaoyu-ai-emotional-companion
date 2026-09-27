/**
 * SEO 内容页 · 英文 · 边界/信任组（4 页）
 *
 * 这一组把「合规风险内容反转为机会」（`seo-research.md` §4）：AI 能不能当治疗师、
 * 跟 AI 说心里话行不行、AI 陪伴安不安全、AI 陪伴和真人朋友有什么不同。
 * 这几问正是 ChatGPT / Perplexity / Google AI Overviews 会去检索并引用的问题，
 * 而我们的红线条文（陪伴非治疗、不诊断、危机引导专业求助）本身就是最好的可引用答案。
 */
import type { SeoPageDef } from './types';

export const EN_BOUNDARIES: SeoPageDef[] = [
  {
    slug: 'can-ai-be-a-therapist',
    lang: 'en',
    title: 'Can AI Be a Therapist? What AI Can and Can’t Do',
    description:
      'No — an AI cannot be a therapist. A clear look at what AI companions can genuinely help with, where the line sits, and when to see a licensed professional.',
    h1: 'Can AI be a therapist? No — here is where the line sits',
    intro:
      'An AI cannot be a therapist. It is not licensed, it cannot diagnose, it cannot treat a mental-health condition, and it cannot take responsibility for your safety. What an AI companion can do is different and much smaller: keep you company, listen without judgment, and help you put a feeling into words between the moments when real support is available.',
    sections: [
      {
        h2: 'Why an AI is not a therapist',
        body: 'Therapy is a regulated professional relationship: a licensed clinician assesses, diagnoses where appropriate, chooses an evidence-based approach, holds accountability for your care, and escalates when you are at risk. An AI has no licence, no clinical judgment, no duty of care, and no way to see you. Saying “an AI therapist” as if it were equivalent to a therapist is misleading, and it can delay the help someone actually needs.',
      },
      {
        h2: 'What AI companions are genuinely good at',
        body: 'The smaller job is still worth something: being available at 2am when no one else is awake; letting you say the messy version out loud without fear of judgment or of burdening someone; helping you name what you feel; keeping a record of your moods over weeks so patterns become visible; and being a low-pressure first step for people who find it hard to talk to anyone at all.',
      },
      {
        h2: 'Where the line is, in practice',
        body: 'Talk to an AI about how your day went, a worry you are circling, or a feeling you cannot name — that is companionship, and it is fine. Do not rely on an AI to decide whether you have a condition, to manage medication, to handle a crisis, or to replace treatment you have been offered. If your low mood lasts, if it affects sleep, work or relationships, or if someone who cares about you is worried, that is a conversation to have with a professional.',
      },
      {
        h2: 'How Xiaoyu handles this',
        body: 'Xiaoyu is deliberately built as gentle healing — a companion, not treatment. It does not diagnose, does not promise outcomes, and is never presented as medical advice. If you mention self-harm or crisis, it will respond with care and point you towards professional help and local crisis lines rather than trying to handle it alone. That boundary is not a limitation of the product; it is the honest description of what it is.',
      },
    ],
    faq: [
      {
        q: 'Can AI replace therapy?',
        a: 'No. AI cannot diagnose or treat mental-health conditions, and it carries no clinical responsibility. It can keep you company between sessions, but it does not replace professional care.',
      },
      {
        q: 'Is it safe to use an AI for emotional support?',
        a: 'Talking to an AI about your feelings is generally harmless and can help you feel heard. It becomes unsafe when it is used to avoid professional help for something that needs it, or in a crisis.',
      },
      {
        q: 'When should I see a professional instead?',
        a: 'If distress is persistent or worsening, if it affects sleep, work or relationships, or if you have thoughts of harming yourself — please contact a licensed professional, your doctor, or a local crisis line.',
      },
      {
        q: 'Does Xiaoyu claim to be a therapist?',
        a: 'No. Xiaoyu is an emotional companion. It does not treat, diagnose or cure, and it will say so on every page.',
      },
    ],
    keywords: [
      'can ai be a therapist',
      'ai therapy vs human therapy',
      'chatgpt as therapist risks',
      'is ai therapy safe',
    ],
    related: ['ai-emotional-support', 'is-it-ok-to-talk-to-an-ai-about-your-feelings', 'what-is-ai-companion'],
  },

  {
    slug: 'is-it-ok-to-talk-to-an-ai-about-your-feelings',
    lang: 'en',
    title: 'Is It Okay to Talk to an AI About Your Feelings?',
    description:
      'Yes — and it is more common than you might expect. What makes it helpful, what to watch out for, and how to keep it a healthy habit rather than a replacement for people.',
    h1: 'Is it okay to talk to an AI about your feelings?',
    intro:
      'Yes. Talking to an AI about your feelings is a normal, low-risk thing to do, and for many people it is easier than talking to a person — there is no fear of judgment, no sense of being a burden, and no need to wait for a convenient moment. Like any tool, it works best when you are clear about what it is for.',
    sections: [
      {
        h2: 'Why it helps at all',
        body: 'Putting a feeling into words changes how it sits with you. Usually that requires a listener, and listeners are not always available or easy to be honest with. An AI companion removes most of the friction: it is always there, it does not get tired of you, it does not bring its own history into the room, and it will not think less of you for what you say.',
      },
      {
        h2: 'What to watch out for',
        body: 'Three things are worth being deliberate about. First, an AI should not become the only place you are honest — keep real relationships in the picture. Second, it is not a clinician: it cannot assess risk or diagnose, however supportive it sounds. Third, comfort is not the same as progress; if the same problem returns every week, a companion can hold space for it, but a professional can help you change it.',
      },
      {
        h2: 'How to get more out of it',
        body: 'Say the feeling, not the summary. Tell it what you want from the moment — to be heard, to have someone on your side, to untangle it, or to see it more lightly. Come back to the same companion so it builds a memory of your context. And use check-ins to notice patterns over weeks, not just to vent in the moment.',
      },
      {
        h2: 'If what you need is more than companionship',
        body: 'Persistent low mood, anxiety that interferes with daily life, sleep that has fallen apart, or any thought of harming yourself are signals to involve a professional. An AI companion can be part of the picture — it is simply not the whole of it. Xiaoyu is companionship, not therapy, and it will tell you the same thing.',
      },
    ],
    faq: [
      {
        q: 'Is it weird to talk to an AI about my feelings?',
        a: 'It is common, and it is not weird. Many people find it easier to be honest with something that does not judge them or need anything back.',
      },
      {
        q: 'Should I tell my therapist I use an AI companion?',
        a: 'If you use it regularly, yes — it is useful context for them, and they can tell you whether it is helping or getting in the way.',
      },
      {
        q: 'Can talking to an AI make things worse?',
        a: 'It is unlikely to harm you directly. The risk is indirect: using it to avoid professional help, or letting it replace human contact over time.',
      },
    ],
    keywords: [
      'is it ok to talk to an ai about your feelings',
      'talking to ai about feelings',
      'ai emotional support safe',
    ],
    related: ['can-ai-be-a-therapist', 'ai-emotional-support', 'ai-companion-vs-human-friend'],
  },

  {
    slug: 'is-an-ai-companion-safe',
    lang: 'en',
    title: 'Is an AI Companion Safe? Privacy, Safety, Honesty',
    description:
      'What a safe AI companion should do: keep your words yours, filter harmful content, avoid medical claims, and hand crisis situations to real professionals.',
    h1: 'Is an AI companion safe? What you should expect',
    intro:
      'A safe AI companion is not one that promises never to upset you — it is one that is honest about what it is, careful with what you tell it, and quick to hand you to a human when a human is what you need. Here is what to look for, and what Xiaoyu does.',
    sections: [
      {
        h2: 'Privacy: your words stay yours',
        body: 'Emotional conversations are sensitive by definition, so the baseline is simple: what you share is used to support you, not sold, not published, and not used to embarrass you. On Xiaoyu your records live under your account, you can delete your conversations, and you can delete the account entirely. No real name is required to start.',
      },
      {
        h2: 'Content safety: limits are a feature',
        body: 'A companion that will say anything is not being kind — it is being unaccountable. Xiaoyu filters content that encourages self-harm, violence, sexual content involving minors, drug use and instructions for wrongdoing, including inside the AI roleplay and any story a user writes themselves. Refusing those things is part of the product, not an afterthought.',
      },
      {
        h2: 'Honesty: no medical claims, ever',
        body: 'Be wary of any companion that implies it can treat, cure or diagnose. Xiaoyu states the opposite on every page: it is companionship, not treatment, and not a substitute for professional care. When a conversation turns towards crisis, Xiaoyu responds with care and points towards professional help and local crisis lines instead of trying to handle it.',
      },
      {
        h2: 'The honest limits',
        body: 'An AI can be wrong, can misread tone, and cannot see or hear you. It cannot notice what you do not say, and it cannot act on your behalf in an emergency. That is exactly why safety here means being clear about the boundary rather than hiding it: a companion you can talk to freely, and a professional you go to when it matters.',
      },
    ],
    faq: [
      {
        q: 'Is talking to an AI companion private?',
        a: 'On Xiaoyu, conversations belong to your account and are used to support you — not sold or posted. You can delete your records or your account at any time.',
      },
      {
        q: 'Can an AI companion be harmful?',
        a: 'It can mislead if it pretends to be more than it is. Look for a companion that makes no medical claims, filters harmful content, and redirects crisis situations to professionals.',
      },
      {
        q: 'Does Xiaoyu moderate what users write in roleplay?',
        a: 'Yes. Self-written characters and stories pass through the same content-safety filter, and content that crosses the line is rejected rather than softened.',
      },
    ],
    keywords: ['is ai companion safe', 'ai companion privacy', 'ai companion safety', 'is ai roleplay safe'],
    related: ['is-ai-roleplay-safe', 'what-is-ai-companion', 'can-ai-be-a-therapist'],
  },

  {
    slug: 'ai-companion-vs-human-friend',
    lang: 'en',
    title: 'AI Companion vs Human Friend: An Honest Comparison',
    description:
      'An AI companion is not a friend, and a friend is not always available. Where AI genuinely helps, where it cannot, and how to use both without losing either.',
    h1: 'AI companion vs human friend: what each one gives you',
    intro:
      'An AI companion is not a friend. It does not know you, it will not show up when you move house, and it cannot be hurt by you. What it can do is be present at the exact moment you need to say something — which is not a small thing, and does not pretend to be friendship.',
    sections: [
      {
        h2: 'What a friend gives you that an AI cannot',
        body: 'Being known over time by someone who chose you; reciprocity; the discomfort that makes honesty mean something; someone who notices when you go quiet; practical help in the real world. None of that can be simulated, and a companion that implies otherwise is doing you a disservice.',
      },
      {
        h2: 'What an AI gives you that a friend may not',
        body: 'Availability at 3am without waking anyone; total absence of judgment; no fear of wearing someone out with the same problem; patience with a feeling you have not finished having; and a private place to rehearse what you actually want to say to the people in your life.',
      },
      {
        h2: 'The risk worth naming',
        body: 'The failure mode is substitution: using a companion to avoid the harder, more rewarding work of being known. If your only honest conversations are with an AI, that is worth noticing. A good companion experience should send you back out into your life a little steadier — not absorb the part of your life that needs people.',
      },
      {
        h2: 'How to use both well',
        body: 'Talk to a companion for the raw, unfinished version, then take the finished version to someone who can respond. Use it to prepare for a hard conversation, to get through a night, or to keep a record of how you have been. And keep investing in the relationships that can actually hold you long term.',
      },
    ],
    faq: [
      {
        q: 'Can an AI companion replace friends?',
        a: 'No, and it should not try. It can be available when friends cannot be, but being known by people over time is something only people can do.',
      },
      {
        q: 'Is it unhealthy to prefer talking to an AI?',
        a: 'It is understandable — an AI is available and never judges. It becomes a problem when it replaces every human conversation rather than supporting them.',
      },
      {
        q: 'How is Xiaoyu positioned here?',
        a: 'As a companion: company for the moment, not a substitute for the people in your life. It is not therapy either — just a presence when you need one.',
      },
    ],
    keywords: ['ai companion vs human friend', 'can ai replace friends', 'ai friend vs real friend'],
    related: ['is-it-ok-to-talk-to-an-ai-about-your-feelings', 'ai-companion-vs-chatgpt', 'ai-emotional-support'],
  },
];
