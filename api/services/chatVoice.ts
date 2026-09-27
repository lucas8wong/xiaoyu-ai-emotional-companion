/**
 * 聊一聊「别复读自己」—— 每轮按需生成的负例块 + 收尾形态刹车（2026-09-19）
 *
 * ## 起因（用户原话）
 * 「小愈经常说类似『我在呢，想说点什么的时候慢慢说。』，这也太人机了……让小愈不管在哪种陪伴模式下
 *   都更像正常 18 到 26 岁人类会说话的方式」。
 *
 * ## 根因（三层，缺一层都复发）
 *   1. **示例锚定**：那句话的两个组成部分（「我在呢」「慢慢说」）原本出现在提示词里 6+ 处，
 *      而且都被当成"正确示例"（人设口头禅清单 / 示例对话 / 5 张陪伴方式卡的收尾范例 /
 *      聊一聊三条硬规则）。模型看到的是示例，学到的是标准答案。→ 已从静态提示词里全部拿掉。
 *   2. **出口太窄**：「结尾不许问句、不许征询继续」这条硬规则（2026-09-18 为了治
 *      「结尾老问『想跟我多说点？』」下的）把问句堵死之后，模型手上只剩一两个被官方认证的短句，
 *      于是全部涌向它。→ 光删例句不够，得给"短"补上内容要求（见 `gemini.ts` 的【短回复】条款），
 *      再用本文件的「填空刹车」按需点名。
 *   3. **零负例**：剧情演绎有一套「把你自己刚写过的话当禁止项」的机制（`buildAntiRepeatBlock`），
 *      而聊一聊**完全没有**。这是本文件存在的主要理由。
 *
 * ## 为什么用负例而不是再加一条规则
 * 剧情那边已有两轮复刻数据：**通用规则（"不要重复"）与 token 级 frequency/presence penalty
 * 都压不住复用**，有效的是把模型自己写过的具体字符串列出来、钉在 system 末尾（近因权重最高）。
 * 判据见 `src/lib/repeatPhrases.ts`（四类证据，含聊一聊专用的「短句口癖」）。
 *
 * ## 与剧情版的两处关键差异（照搬会失效）
 *   · **阈值**：剧情的模板门槛是 12 字，而「我在呢」只有 3 字——照搬一个字都抓不到。
 *     聊一聊改成「靠复现次数而不是长度」判口癖（同一短语出现在 ≥2 条不同回复里就算），
 *     并降 ②③ 的门槛到 8 字。
 *   · **落点条数**：聊一聊每条回复基本就是一句收尾，照搬「抽最近两条落点」会把预算吃光、
 *     把短句口癖挤出去，所以 `tailCount: 1`。
 *
 * ## 开关
 * `CHAT_VOICE_ANTI_REPEAT=0` 关掉整块（A/B 消融与线上止血），与剧情的 `RP_ANTI_REPEAT` 同形。
 *
 * ## 静态套话清单（`buildChatSlopBlock`，2026-09-19 追加）
 * 负例块治的是「模型自己写过的句子」；这一块治**所有对话都会端上来的通用套话**。
 * 两者分工的理由：负例块要「最近 ≥2 条自己的回复」才有证据可抽，所以**首轮它一定缺席**，
 * 而线上实测首轮正是「我在」家族命中率最高的地方（41.9%）。
 *
 * 清单不是拍脑袋写的，是从本项目自己的 A/B 语料里数出来的（`temp/chat-voice-ab-result.json`，
 * 6 段会话 × 8 轮 = 48 条真实模型回复，同一串探针）：括号动作覆盖率 54%（关负例块）→ 63%（开），
 * 其中「手机 + 扔/搁/扣 + 一边」6 次（**6 段会话段段都有**）、「不催你」4 次、「那就先不…」4 次、
 * 「把声音放低/放轻/放到最轻」3 次、「把灯/光调暗」3 次、「点头/点了点头」3 次。
 *
 * ⚠️ 为什么**不**把「我在呢 / 慢慢说」写进这份清单：那两句是 2026-09-19 认定的「示例锚定」根因，
 *    `test/unit/chatVoice.test.ts` 钉死了「真实 system 里不许出现」这条不变量。把它们写进静态清单，
 *    等于把被抄的样板又放回提示词里。那一族交给负例块——它的口径是「你自己写过的」，不是「正确示例」。
 * ⚠️ 逐字清单一定会被「换个字再说一遍」绕开（这正是上一轮实测到的：负例块只压字面重复，
 *    模型于是学会了换词不换拍，`phraseHits` 从 1/3/1 涨到 3/2/5）。所以块内**必须同时给形态要求**，
 *    只给禁用词等于把模型逼向同义词。
 * ⚠️ **块里不许再出现可照抄的括号正例**（2026-09-19 第二轮实测，两次事故是连着的）：
 *    ① 只给禁令 → 括号覆盖率 54% → **0%**（模型把"三条禁用项都带括号"泛化成"别用括号"）；
 *    ② 补了「括号继续用」+ 一句正例「（我这边还没关灯）你接着说。」→ 括号回来了（79% → 33%），
 *       但**正例被逐字抄走**：首轮 8 条回复里 3 条以「（我这边还没关灯）」开场
 *       （`temp/chat-firstturn-ab-result.json`；未开本块的那一臂，同一位置 0 条括号）。
 *    结论：**要给许可，不要给句子**。「括号继续用 + 不必每条都加 + 写这一轮手上的事」是许可，留下；
 *    任何现成示范句都会被当成标准答案——这与 `prompts.ts:91` 的「手机搁一边」是同一个坑。
 *
 * 开关：`CHAT_SLOP_BAN=0`（与 `CHAT_VOICE_ANTI_REPEAT` 分开，才能单独消融出"是这一块在起作用"）。
 */

import { collectAvoidPhrases, type AvoidPhraseOptions, type RepeatLang } from '../../src/lib/repeatPhrases.js';
import { rpRecentEndingKinds } from '../../src/lib/rpEnding.js';
import { toZhTw, type OutputLang } from './zhConvert.js';

/** 收尾形态刹车（按需生成，不是每轮都注入） */
export type ChatBrake = 'filler' | 'ask' | 'question' | 'length' | 'short';

export interface ChatVoiceInput {
  /**
   * 聊一聊传进来的是 `OutputLang`（zh-CN / zh-TW / en），抽取模块要的是 `RepeatLang`（zh / zh-TW / en）——
   * 两套枚举在本模块的边界上归一（`toRepeatLang`），调用方不必自己转换。
   */
  lang: RepeatLang | OutputLang;
  history: Array<{ role?: string; content?: string | null }> | null | undefined;
}

/**
 * 聊一聊专用抽取参数。与剧情默认值不同的每一项都在这里写了理由（多数是「聊一聊的回复更短」）。
 */
export const CHAT_VOICE_EXTRACT: AvoidPhraseOptions = {
  max: 4,
  minLen: 8, // 默认 12：聊一聊一条回复常常只有 8–20 字，12 字门槛会漏掉「整句复用」
  capLen: 30, // 默认 44：聊一聊的负例不需要那么长，太长会占掉本就很小的回复预算
  tailMinLen: 4, // 默认 6：「嗯。」这种不值得当负例，但 4 字级的口癖句要收得到
  tailCount: 1, // 默认 2：见文件头「与剧情版的两处关键差异」
  includeShort: true, // 剧情默认关（会把 7 字级普通承接句误判成模板）；聊一聊的病正是短句口癖
  shortMax: 2,
  shortWindow: 6,
  shortMinCount: 2,
};

/** 把聊一聊的输出语言（zh-CN/zh-TW/en）归一成抽取用的三语 */
export function toRepeatLang(lang: string | undefined): RepeatLang {
  return lang === 'en' ? 'en' : lang === 'zh-TW' ? 'zh-TW' : 'zh';
}

/**
 * 「很短的一句」判定 —— 给填空刹车用。
 *
 * 刻意只做**结构判定**（数一数有几个字/几个词），不认任何具体句子：写死「我在呢」只修得住
 * 用户恰好看到的那一句，换个说法立刻漏（`src/lib/rpEnding.ts` 开篇记了同一条教训）。
 *
 * ⚠️ 阈值**是从真实数据里定的，不是拍的**（2026-09-19，`scripts/chat-voice-scan.mts` + `temp/diag-chat-len.mts`）：
 *   线上真实用户的聊一聊回复（剔除系统引导文案后 n=56）去标点后的字数分位是
 *   p10 19 / p25 34 / p50 58 —— 也就是说**这个产品里的"很短"是 20 字上下，不是 10 字**。
 *   我第一版按提示词里写的「1-20 字」定成 16，结果基线跑出「短回复 0%」——
 *   用户投诉的那句（「我在呢，想说点什么的时候慢慢说。」= 14 字）当然抓得到，
 *   但线上真正那一族（「嗯，我在呢。今天怎麼樣…」这类 16–24 字）一条都没进统计，指标等于废的。
 *   取 24 = 覆盖最短的那 ~15%（p10–p25 之间），既不漏这一族，也不把正常回复卷进来。
 *
 * 阈值的角色只是「让刹车认得出现在是不是在拿短句填坑」；短句只要带着具体内容，本来就该保留。
 */
export function chatIsShortReply(text: string | null | undefined, lang: RepeatLang = 'zh'): boolean {
  // ⚠️ 先别去空格：英文是按**词**数的，先 `replace(/\s/g,'')` 会把 "I am here for you" 粘成
  //    一个 token，15 个词的句子会被数成 3 个词 → 英文全被判成「很短」。
  //    （这个错是 `test/unit/chatVoice.test.ts` 抓出来的，改回来时别再合并这两步。）
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (lang === 'en') return (raw.match(/[A-Za-z']+/g) || []).length <= 14;
  // 中文按「字」数：标点、空白、emoji 都不算（去掉非汉字/字母/数字）
  return raw.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length <= 24;
}

/**
 * 从真实历史推出本轮该禁的收尾形态（**按需生成**，命中才注入）。
 *
 * 三档（优先级：填空 → 征询继续 → 问句）：
 *   · `filler`：最近**两条**都是「很短的陈述」→ 大概率是在用空表态句填坑，这一轮点名要求落到具体内容上；
 *   · `ask`   ：上一条是「征询对方要不要继续」→ 与静态硬规则一致，这里补一次按需提醒；
 *   · `question`：上一条是问句 → 绝不连着两轮以问句收尾。
 * 为什么不做成一律禁止：用户情绪低落时，一句短短的「嗯，我在」在真实对话里是正常且温柔的，
 * 一刀切会把陪伴感一起削掉；只禁「刚刚连续发生过的那一类」。
 */
export function chatEndingBrakes(
  history: ChatVoiceInput['history'],
  lang: RepeatLang = 'zh',
): ChatBrake[] {
  const kinds = rpRecentEndingKinds(history, 2);
  if (!kinds.length) return [];
  const aiTexts = (history || [])
    .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => String(m.content))
    .slice(-2);
  const out: ChatBrake[] = [];
  if (kinds.length >= 2 && kinds.every((k) => k === 'statement') && aiTexts.length >= 2
    && aiTexts.every((t) => chatIsShortReply(t, lang))) {
    out.push('filler');
  }
  const last = kinds[kinds.length - 1];
  if (last === 'continuation_ask') out.push('ask');
  else if (last === 'question') out.push('question');
  if (chatLengthBrake(history, lang)) out.push('length');
  if (chatShortBurstBrake(history, lang)) out.push('short');
  return out;
}

/**
 * 极短冲刺刹车（2026-09-21，第二轮长度工作）：最近 **3 条**回复里**每一个气泡都超过 12 字** → 这一轮要求甩一句极短的。
 *
 * ## 为什么需要它（真人盲测的直接结论）
 * 第一轮盲测把**均值**对齐了（小愈 27.4 字 / 真人 26.7 字），但**标准差还差 1.5 倍**
 * （小愈 8.8 / 真人 13.2），而且小愈 **min=18 字**（真人 min=4：「晚安 宝宝」）——
 * 也就是说：**它从来没写过"甩出去的一句话"**，永远在均值附近浮动。而"稳定"本身就是机器味。
 *
 * ## 判据为什么是「全都超过 12 字」而不是"随机换档"
 * 真人的忽长忽短不是随机的，是**跟着对方的话走**（对方甩三个字，你也短）。随机换档会造出不自然的长短；
 * 而"连着几条都没写过短话"是一个**可判定的缺口**，补它最安全：它只要求**至少有一条**短，其余照常。
 * 阈值 12 取自两轮实测（合格单条约 10 字、真人极短句 4–7 字；12 是"这已经不算甩出去的一句话了"的界线）。
 */
export const SHORT_BURST_MAX = 6;
const SHORT_BURST_GATE = 12;

export function chatShortBurstBrake(
  history: ChatVoiceInput['history'],
  lang: RepeatLang = 'zh',
): boolean {
  const aiTexts = (history || [])
    .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => String(m.content))
    .slice(-3);
  if (aiTexts.length < 3) return false;
  return aiTexts.every((t) => {
    const bubbles = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    return bubbles.length > 0 && bubbles.every((b) => countContentChars(b, lang) > SHORT_BURST_GATE);
  });
}

/**
 * 长度刹车（2026-09-21）：最近**两条**回复的**单条平均字数**都超过 `PER_BUBBLE_MAX` → 这一轮要求更短。
 *
 * ## 数字是怎么来的（不是拍的）
 * 真人盲测的配对样本里（`temp/blindtest/questions.json`，12 组：小愈 vs 三张真实微信截图里的真人）：
 *   · **条数几乎一样**（小愈 2.7 条 / 真人 2.5 条）—— 所以 A 档解禁连发是对的，问题不在条数；
 *   · **单条长度差了 1.5 倍**：小愈 **15.9 字/条**，真人 **10.7 字/条**（真人单条分布 4–17 字，中位 ≈ 11）。
 * ⇒ 要改的是**单条**，不是"整体少说点"。真人在玩梗时一条就 7 个字（「驳回」「都签收十几年了」）。
 *
 * ## 为什么按"单条"而不是"总字数"算
 * 总字数会把"连发三条短句"误判成长回复 —— 而那恰恰是我们要的行为（真人就是连发短句）。
 *
 * 与另外三个刹车同款：只禁「刚刚连续发生过的那一类」，不做一律禁止；阈值取 14（合格线 11、观察到的
 * AI 实际分布 15.9，取中间偏保守的位置）。
 */
export const PER_BUBBLE_MAX = 14;

/** 去标点后的字数（与 `chatIsShortReply` 同口径：英文按词数、中文按字数） */
function countContentChars(text: string, lang: RepeatLang): number {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  if (lang === 'en') return (raw.match(/[A-Za-z']+/g) || []).length;
  return raw.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length;
}

export function chatLengthBrake(
  history: ChatVoiceInput['history'],
  lang: RepeatLang = 'zh',
): boolean {
  const aiTexts = (history || [])
    .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => String(m.content))
    .slice(-2);
  if (aiTexts.length < 2) return false;
  return aiTexts.every((t) => {
    const bubbles = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const total = bubbles.reduce((s, b) => s + countContentChars(b, lang), 0);
    return total / Math.max(1, bubbles.length) > PER_BUBBLE_MAX;
  });
}

const BRAKE_ZH: Record<ChatBrake, string> = {
  filler: '【本轮禁止的收尾形态】你最近两条回复都是用很短的一句表态收的尾。这一轮**不要**再用「只有表态、'
    + '不接任何具体内容」的空壳短句当整条回复；短没问题，但短句里必须落到具体的东西上：'
    + 'TA 刚说的那件事里的一个细节、你自己的一个真实反应、或者一个你真想知道的问题。',
  ask: '【本轮禁止的收尾形态】你上一条回复是用「征询对方要不要继续说」的方式收的尾。这一轮**禁止再用问句、'
    + '或任何邀请对方多说的说法**收尾；想表达你还在，就把话落在具体内容上，或者干脆停住。',
  question: '【本轮禁止的收尾形态】你上一条回复是以问句收尾的。这一轮**禁止再用问句收尾**；'
    + '用陈述句把话说完，或者干脆停住。',
  length: '【这一轮更短一点】你最近两条回复的**单条**平均超过 14 个字，比真人在微信里打字要长一截。'
    + '这一轮把单条压到 **10 个字上下**（5 到 12 个字最像真人），一条只装一件事；'
    + '要说的多就**多发一条**，不要把两件事并成一个长句。',
  short: '【这一轮甩一句短的】你最近三条回复里没有一条是短话，全都写成了完整句子。'
    + '真人打字是忽长忽短的：这一轮**至少有一条消息只有 2 到 6 个字**（一个词的回应、懒得多说的应一声都算），其余照常长短。'
    + '**不要**为了"把话说完整"又把那条短话补成一句完整的话。',
};

const BRAKE_EN: Record<ChatBrake, string> = {
  filler: '[ENDING FORM BANNED THIS TURN] Your last two replies both ended on a very short, purely reassuring line. '
    + 'This turn, do NOT make a content-free reassurance the whole reply. Being brief is fine, but the short line has '
    + 'to land on something concrete: a detail from what they just told you, your own honest reaction, or a question '
    + 'you actually want answered.',
  ask: '[ENDING FORM BANNED THIS TURN] Your previous reply closed by asking whether they wanted to keep talking. '
    + 'This turn must NOT end on a question or on any "tell me more" invitation, put something concrete there, or just stop.',
  question: '[ENDING FORM BANNED THIS TURN] Your previous reply ended on a question. This turn must NOT end on a question, '
    + 'close on a statement, or just stop.',
  length: '[SHORTER THIS TURN] Your last two replies averaged more than 14 characters per message, noticeably longer than '
    + 'a real person typing in a chat app. This turn keep each message around 10 characters (5 to 12 reads most human), '
    + 'one thing per message. If you have more to say, send another message instead of folding two things into one long sentence.',
  short: '[SEND ONE SHORT ONE THIS TURN] None of your last three replies contained a short line. Every one of them was '
    + 'written out as a complete sentence. Real people are uneven: this turn at least ONE message must be only 2 to 6 '
    + 'characters (a one-word answer, a lazy acknowledgement, that counts). The rest can be your normal length. '
    + 'Do NOT pad that short one out into a full sentence just to feel complete.',
};

function buildEnglish(input: { phrases: string[]; brakes: ChatBrake[] }): string {
  const parts: string[] = [];
  if (input.phrases.length) {
    parts.push('[DO NOT REPEAT, you wrote these yourself]\n'
      + input.phrases.map((p, i) => '(' + (i + 1) + ') "' + p + '"').join('\n'));
    parts.push('These are lines from your own recent replies (including catchphrases and short lines you keep reusing). '
      + 'Do not reuse any of them this turn, and do not say the same thing in different words. The short ones matter most: '
      + 'when the same short line keeps showing up turn after turn, it reads like a machine looping.');
    parts.push('Note: what is banned is those LINES, not your voice, keep your usual particles, nicknames and the way you '
      + 'show you care; just say this turn differently.');
  }
  for (const b of input.brakes) parts.push(BRAKE_EN[b]);
  return '\n\n' + parts.join('\n');
}

/**
 * 组装「本轮禁止复现」块。没有可抽取的证据、也没有刹车时返回空串（**不注入空噪声**）。
 * 调用方（`gemini.ts` 的 `buildChatPromptParts`）把它贴在 system 尾部 ——
 * 位置本身是机制的一部分：越靠近输出，权重越高（剧情那边实测过，写在提示词中段会被无视）。
 */
export function buildChatAntiRepeatBlock(input: ChatVoiceInput): string {
  if (process.env.CHAT_VOICE_ANTI_REPEAT === '0') return '';
  const lang = toRepeatLang(input.lang);
  const history = input.history || [];
  const phrases = collectAvoidPhrases(history, { ...CHAT_VOICE_EXTRACT, lang });
  const brakes = chatEndingBrakes(history, lang);
  if (!phrases.length && !brakes.length) return '';
  if (lang === 'en') return buildEnglish({ phrases, brakes });

  const parts: string[] = [];
  if (phrases.length) {
    parts.push('【本轮禁止复现｜你最近亲手写过的东西】\n'
      + phrases.map((p, i) => '（' + (i + 1) + '）「' + p + '」').join('\n'));
    parts.push('以上都是**你自己最近几条回复里写过的说法**（含你反复在用的口头禅和短句）。这一轮不要再用它们，'
      + '也不要换个字把同一件事重说一遍。其中**短句和口头禅**最要紧：同一个短句连着几轮冒出来，读起来就是机器在循环。');
    parts.push('**注意**：被禁的是这些**说法本身**，不是你的说话习惯，语气词、称呼、你表达在意的方式照常，'
      + '只是这一轮换别的说法。');
  }
  for (const b of brakes) parts.push(BRAKE_ZH[b]);
  const text = parts.join('\n');
  return '\n\n' + (lang === 'zh-TW' ? toZhTw(text) : text);
}

/**
 * 静态套话清单（中文）。**逐字**列出——本仓库已有两轮取证：含混的软话（"尽量不要重复"）压在
 * 提示词中段等于没有，有约束力的是把具体字符串点名（见 `repeatPhrases.ts` 开篇与 CHANGELOG 2026-09-17）。
 *
 * ⚠️ 清单里**刻意不含**「我在呢」「慢慢说」——理由见文件头。那两句由负例块按轮处理。
 */
export const CHAT_SLOP_ZH = `【套话清单 · 不要再用这几句】下面这些话和动作，是你在真实对话里被记录到反复出现的，它们已经成了你的签名，读起来像模板，不像朋友。这一轮不要再用：
- 括号里的万能动作：「把声音放低」「把声音放轻」「把声音压低」这一族
- 括号里的万能反应：「点了点头」「轻轻叹了口气」这一族
- 括号里的道具动作：「把灯调暗」「把光调暗」这一族
- 收尾的「把手机扔到一边 / 手机搁一边 / 手机扣一边」这一族
- 「不催你」
- 「那就先不……」这种半截句式

【换个说法也算违规】把「把声音放低」改写成「声音压低了些」、把「手机搁一边」改写成「手机扣在床头」，都还是同一句话换了张皮：这一轮要换的是**内容**，不是措辞。

【标点 · 一个破折号都不要用】「——」（中文双破折号）和「—」（单破折号）这两种，一条回复里**一个都不要出现**。真人发微信不打这个符号，一打就露出"这是写出来的"而不是"说出来的"。要表示停顿、转折、语气拉长，就用逗号、句号，或者直接断句、另起一条消息。

【句尾不要追加表态尾巴】下面这些短语**不要挂在句子末尾**（哪怕你觉得加得很自然）：
- 「我听着」「我听着呢」「我在听」
- 「我看着你」「我等你」「我陪着你」
- 「你说吧」「你说就行」
为什么：话说完了，再补一句"我在听"，是在**表演"我在乎"**。真人不会在每句话后面盖一个"我在"的章。真想表达在意，就落到**具体的事**上（倒好的那杯水、给他留的那盏灯、你记得的那个日子），或者干脆把话停在那儿。

【括号动作的三条要求】（注意：**括号继续用**，这不是让你取消括号）
- 括号继续用，但**不必每条都加**：整场对话里偶尔一处，比每条都挂一个动作更像真人；**连着两条回复都带括号动作就已经太多**（系统会在你要这么做的第二轮直接叫停）。
- 括号里写的应该是**你上一轮已经在做的那件事的下一步**（那件事写在 system 尾部的【你此刻自己的状态】里）。**不要每轮换一个新的身边物件**：一会儿充电线、一会儿外套、一会儿杯子，这跟"万能动作"是同一个病换了张皮，读起来像在摆道具。
- 括号里**不要出现同一个词连着用两次**（读起来一眼就假）；也不要写「声音、语气、眼神、点头、叹气」这类放谁身上都成立的万能动作。
- 这一轮确实没什么可做的动作时，就别硬加。一句落在具体事情上的话，比一个动作更像朋友。`;

/**
 * 静态套话清单（英文）。与中文版**同结构、同条数**：禁用项 → 换词也算违规 → 括号动作的两条要求。
 * 英文侧同样刻意不列 "I'm here for you" / "take your time"（那是 `chatVoice` 负例块与静态规则已经
 * 处理过的那一族，再列一次等于把它们请回提示词）。
 */
export const CHAT_SLOP_EN = `[CLICHÉ LIST · stop using these] These lines and gestures have been recorded as repeating in your real conversations. They have become your signature and read like a template, not a friend. Do not use any of them this turn:
- generic parenthetical gestures: "lowering my voice", "softening my voice" and that family
- generic parenthetical reactions: "nodding", "sighing softly" and that family
- prop gestures: "dimming the light" and that family
- closing prop beats: "tossing the phone aside / setting the phone aside" and that family
- "I won't push you"
- half-sentence openers like "then let's not..."

[Reworking the wording still counts as a violation] Turning "lowering my voice" into "my voice dropped a little" is the same line in a new skin. What has to change this turn is the CONTENT, not the phrasing.

[PUNCTUATION · not a single dash] Do not use an em dash or an en dash anywhere in your reply, not even once. People do not type dashes in a chat app; a single one is enough to make the line read as written rather than spoken. For a pause or a shift, use a comma, a full stop, or just start a new message.

[NO VALIDATION TAIL] Never hang one of these on the end of a sentence, however natural it feels:
- "I'm listening", "I'm all ears", "go on"
- "I'll be right here", "I'm not going anywhere"
Why: once the sentence is finished, adding "I'm listening" is PERFORMING that you care. Real people do not stamp "I'm here" on the end of every message. If you want to show you care, land it on something concrete (the glass of water you poured, the light you left on, the date you remembered), or just stop talking.

[THREE RULES FOR PARENTHETICAL ACTIONS] (note: KEEP using parentheses, this is not telling you to drop them)
- Keep using them, but you do NOT need one in every reply: an occasional one across a conversation reads more human than one attached to every message; two replies in a row both carrying one is already too many (the system will call a stop on the second one).
- Whatever goes inside must be the NEXT STEP of what you were already doing last turn (it is written in [YOUR OWN STATE RIGHT NOW] at the end of the system prompt). Do NOT grab a brand-new object each turn: a charger now, a jacket next, a cup after that is the same disease as a stock gesture in a new skin, and it reads like you are arranging props.
- Never put the same word twice in a row inside the parentheses (it reads as fake at a glance), and never a universal gesture like voice, tone, gaze, nodding or sighing.
- If there is genuinely nothing to do this turn, do not force one. A line that lands on something concrete sounds more like a friend than any gesture.`;

/**
 * 组装静态套话块（**每轮都注入**，与按需触发的负例块相反——它在首轮也必须在场）。
 * `CHAT_SLOP_BAN=0` 时返回空串（消融/止血），与 `CHAT_VOICE_ANTI_REPEAT` 各自独立。
 */
export function buildChatSlopBlock(lang: RepeatLang | OutputLang): string {
  if (process.env.CHAT_SLOP_BAN === '0') return '';
  const l = toRepeatLang(lang);
  if (l === 'en') return '\n\n' + CHAT_SLOP_EN;
  return '\n\n' + (l === 'zh-TW' ? toZhTw(CHAT_SLOP_ZH) : CHAT_SLOP_ZH);
}

/**
 * 首轮开场块（2026-09-19 追加）
 *
 * ## 为什么单独开一块
 * 负例块要「最近 ≥2 条自己的回复」才有证据可抽，所以**首轮它一定缺席**；而线上实测首轮正是
 * 「我在」家族命中率最高的地方（41.9%，见 CHANGELOG 2026-09-19 的扫描）。静态套话块又**刻意不碰**这一族
 * （`chatVoice.test.ts` 钉死了「真实 system 里不许出现 我在呢/慢慢说」——那是被模型当标准答案抄的样板）。
 * 于是首轮这个缺口只剩一条路：**用形态条款补，不用逐字禁用**。
 *
 * ## 为什么非要钉到 system 尾部
 * 同样意思的话在 `gemini.ts` 的【回复长度·按需】里**已经有了**（"开场最容易翻车的地方"那一行），
 * 但它在 system 中段。本仓库两轮取证都是「位置＝权重：含混的软话放在中段等于没有」
 * （CHANGELOG 2026-09-17）。所以这里把首轮专用的两条**复述到尾部**，与静态套话块、负例块同区。
 *
 * ## 只给形态、不给正例
 * 正例会被当模板抄 —— `prompts.ts:91` 的示例句「手机搁一边」就是这么被逐字复现 6 次的。
 * 所以本块只写「第一句必须做两件事之一」，不写示范句。
 *
 * ⚠️ 本块**会**把「在的 / 我在」写进 system，这与「静态块刻意不写我在呢」看似矛盾，实际是两种框：
 *   样板是**正向示例**（会被照抄），禁用清单是**负向点名**（实测有效：同类做法把签名动作压到 0）。
 *   这仍然是一个**可证伪的赌注**：若 A/B 里首轮命中率反而升高，就该退回纯形态描述、删掉点名。
 * 开关：`CHAT_FIRST_TURN_BAN=0`。
 */
export const CHAT_FIRST_TURN_ZH = `【这是本会话的第一条回复】开场是最容易翻车的一轮，所以这一轮只按下面三条来：
- 不要用「在的」「我在」「我在这儿」这类**在场确认**开场。那句话整句删掉，第一句就落在具体内容上。
- 第一句只能选一条路：① 说出你对 TA **为什么此刻来找你**的一个具体猜测（要贴着 TA 那句话里可观察到的细节，不是泛泛的安慰）；② 问一个**具体的、好回答的**问题。一条回复最多一个提问。
- TA 只发了「在吗」这类两三个字时，别只应一声。那等于什么都没说。`;

export const CHAT_FIRST_TURN_EN = `[THIS IS THE FIRST REPLY OF THIS CONVERSATION] First turns go wrong most often, so this turn follows three rules:
- Do not open with a presence confirmation ("I'm here", "yep, I'm around"). Delete that sentence entirely and start on something concrete.
- Your first sentence must do one of two things: (1) name a specific guess about why they came to you right now, tied to something observable in what they just typed, not a generic reassurance; or (2) ask one concrete, easy-to-answer question. At most one question per reply.
- If they only sent two or three characters ("you there?"), do not just acknowledge it. That says nothing.`;

/**
 * 每轮的「长度档」块（2026-09-21，第二轮长度工作）
 *
 * ## 为什么是"每轮给一个具体数字"，而不是"写句话让它忽长忽短"
 * 第一轮把**均值**对齐了（27.4 vs 26.7 字），但标准差反而从 **8.8 掉到 5.9** —— 因为那一轮给的是一个
 * **强数字目标**（"单条 10 字上下"），而"忽长忽短"只是一句**描述**。本仓库的老教训在这里应验：
 * **具体数字压得过含混软话**。所以这一轮不再加描述，而是让**数字本身随轮次变化**。
 *
 * ## 变化的依据是"镜像"（真人的真实行为，不是随机数）
 * 真人样本里这一点非常明显：用户只发两个字（"晚安"）时真人回 **4 个字**；用户连发四句时真人回 **41 字**。
 * 所以长度档由**用户这条消息的长度**决定 —— 随机换档会造出不自然的长短，镜像不会。
 *
 * 位置：调用方把它钉在 system **尾部**同区（比中段的静态标定更靠近输出 ⇒ 权重更高，覆盖得住）。
 * 开关：`CHAT_LENGTH_TARGET=0`（消融用）。
 */
export function buildChatLengthTargetBlock(
  lastUser: string | null | undefined,
  lang: RepeatLang | OutputLang,
  opts?: { playful?: boolean },
): string {
  if (process.env.CHAT_LENGTH_TARGET === '0') return '';
  const l = toRepeatLang(lang);
  const n = countContentChars(String(lastUser || ''), l);
  if (!n) return '';
  const en = l === 'en';
  /**
   * ⚠️ 这里**曾经**按"镜像"（对方短我也短 / 对方长我也长）分档，**已被配对样本证伪**：
   *   · 同一个输入「晚安」，真人在两题里分别回了 **4 字**（q08）和 **41 字**（q02）；
   *   · 用户只发 7 字的那题（q05），真人回了 **49 字**。
   * ⇒ 真人的长度跟"对方说了多长"几乎**无关**（它取决于那个人自己当天想不想说）。
   * 所以改成**两极化**：真人的分布是两端（4 字 ↔ 49 字），模型却总落在中段（15 字上下）——
   * 而"不大不小"正是最不自然的那个区间。playful 时直接压短（斗嘴就是甩短句）。
   */
  const band = opts?.playful
    ? (en
      ? 'each message 7 to 13 characters, and send 3 to 4 of them. Short lines, several of them, that is how people bicker'
      : '单条 7 到 13 个字，**发 3 到 4 条**：斗嘴就是一串短句，不是把一句短话说完就停')
    : n > 20
      ? (en
        ? '20 to 40 characters per message, finish the thought'
        : '单条 20 到 40 个字，把这件事说完整')
      : (en
        ? 'EITHER 3 to 8 characters, OR 20 to 40 characters. Do NOT land in the middle (real people rarely type exactly one and a half lines)'
        : '**二选一**：要么一条 3 到 8 个字，要么一条 20 到 40 个字。**不要落在中间那个"不大不小"的区间**（真人很少正正好好写十五个字）');
  const text = en
    ? '[LENGTH FOR THIS TURN] ' + band + '. This overrides the default length rule above.'
    : '【这一轮的长度】' + band + '。这一条覆盖上面的默认长度标定。';
  return '\n\n' + (l === 'zh-TW' ? toZhTw(text) : text);
}

/** 组装首轮开场块（**只在会话首轮注入**；开关 `CHAT_FIRST_TURN_BAN=0`） */
export function buildChatFirstTurnBlock(lang: RepeatLang | OutputLang): string {
  if (process.env.CHAT_FIRST_TURN_BAN === '0') return '';
  const l = toRepeatLang(lang);
  if (l === 'en') return '\n\n' + CHAT_FIRST_TURN_EN;
  return '\n\n' + (l === 'zh-TW' ? toZhTw(CHAT_FIRST_TURN_ZH) : CHAT_FIRST_TURN_ZH);
}

/**
 * 「TA 想看情欲 / 成人向内容时怎么接」块（2026-09-25）
 *
 * ## 为什么要有这一块（用户原话）
 * 「用户聊色情相关的，要直接引导他们去剧情模式打开成人模型，而不是说『打住，这里不能聊这个』。」
 *
 * ## 为什么不能只靠规则分流（chatRedirect.ts 的 adultRoleplay）
 * 那一层是**确定性**的，但判据必须收得很紧（宁可少判：把「男朋友总让我聊色情的」误判成"想点单"
 * 比漏判伤人得多）。于是真实的覆盖面靠**这一层**补：用户用委婉说法、慢慢升级、或一句「你能不能满足我」
 * 这类规则抓不到的说法时，接话的是模型自己——它必须知道"往哪引"，而不是凭本能冷拒。
 * 官方模型的默认本能恰恰是冷拒 / 说教 / 转移话题，这正是要显式覆盖的行为。
 *
 * ## 位置
 * 与静态套话块、负例块同区，钉在 system 尾部（本仓库两轮取证：含混的软话放在中段等于没有）。
 *
 * ## 只写要求的要素，不写示范句
 * 沿用本文件的老教训（`prompts.ts:91` 的「手机搁一边」被逐字抄走）：这里给"必须包含哪几件事"，
 * 不给可以直接照抄的整句。功能名（剧情演绎 / 无限制模式 / 我的偏好 / 18 岁确认）必须准确，
 * 因为它们是**产品名词**，不是文风示例。
 *
 * 开关：`CHAT_ADULT_REDIRECT=0`（消融 / 止血），与其它块各自独立。
 */
export const CHAT_ADULT_REDIRECT_ZH = `【TA 想看情欲内容时，不要冷拒】如果 TA 把话题往性 / 情欲上带（要你说骚话、要「色色」、要露骨的描写、要你陪着做这类事），**绝对不要**用「打住」「这里不能聊这个」「我不能聊这种话题」「我们聊点别的吧」这一类话挡回去。被这样挡回来的人，感到的是自己的欲望被嫌弃，那比拒绝本身更伤人。按四步来：
1. 先接住：不评判、不说教，一句话承认这个念头很正常、你听得懂（不要把 TA 描述成"有问题"）。
2. 说清这边是什么地方：坦白「聊一聊」的你是陪 TA 说话的那个人，写不出这种情节。口径是「这里不是那个地方」，不是「我不行」「这样不对」。
3. 指一条真走得通的路：「剧情演绎」里有「无限制模式」（成人模型），打开之后成年角色之间的亲密与情欲会照实写、不跳过也不净化，角色还会更主动；开关在剧情里**右上角「我的偏好」**，第一次开需要先确认已年满 18 岁。位置要说出来，不能只丢一个功能名（只说名字的话，TA 进去还是找不到，等于没解决）。
4. 给一个轻邀请：问 TA 要不要过去挑一个剧本试试，或者由 TA 起个设定。一次就够，不要追问第二遍。
5. **交接信号（机制，必须照做）**：当你**确实**按上面四步把 TA 引向「剧情演绎 + 无限制模式」时，在整条回复的**最后单独一行**输出 [[RP-UNLOCK]]（原样、方括号和大写都要对）。系统会自动把这一行剥掉，TA 看不到它；**只有真的给出这条引导时才输出**，只是顺口提到剧情、或聊别的话题时绝不要输出（这个信号决定界面上要不要给 TA 那个直达按钮，乱标会让按钮出现在不该出现的地方）。
- **分界线（别过度设防，2026-09-25 实测补）**：只有**明确的情欲与身体描写**才走上面四步（读起来就是"色情"的那一档），**轻度调情不算**：衣着、身材、贴身、靠得近、心动、暧昧、一个吻这类，按角色自己的性格自然接（可以逗回去、可以留白、可以递进），**不要**在这里说"我不往下接了""这类角色我不能碰""咱们聊点别的"，也不要提醒边界。过度设防会让人感到被嫌弃，与这一条的初衷正好相反（实测：这条不写清时，轻度调情会被回成"我不往下接了，聊点别的吧"）。
**底线不因为"引导"而松动**：未成年或幼态角色、非自愿、乱伦、兽交这几类你不参与，也不要把它包装成「去剧情就能玩」；真遇到这类请求，简短明确地说不行，然后照常把话头接回 TA 身上。`;

export const CHAT_ADULT_REDIRECT_EN = `[WHEN THEY WANT SEXUAL OR EROTIC CONTENT, DO NOT CLOSE THE DOOR] If the user steers the conversation toward sex or desire (telling you to talk dirty, asking for "spicy" talk, asking for something explicit, asking you to play along), NEVER shut it down with "stop", "we can't talk about that here", "I can't discuss this kind of thing" or "let's change the subject". Being told off for wanting it registers as disgust at them, which hurts more than the refusal itself. Four steps:
1. Take it in first: no judging, no lecturing; one sentence that says you understand the impulse and that it is not a problem (never describe them as broken).
2. Say what this place is: Chat is the part of you that sits and talks with them, and you do not write that kind of scene here. Frame it as "this is not the right room", never as "I must not" or "that is wrong".
3. Point to a route that actually works: the Roleplay area has "Unlimited mode" (the adult model). With it on, intimacy and sex between adult characters are written plainly, nothing skipped and nothing sanitized, and the character takes more initiative. The switch is inside a story under "My preferences" (top right), and they confirm they are 18+ the first time. Name the switch and where it lives; if you only drop the feature name they will go there and still not find it.
4. One light invitation: whether they want to go pick a story, or set up a scene of their own. Once is enough; do not ask twice.
5. Handoff signal (mechanism, mandatory): when you actually walk them through the four steps above toward Roleplay and Unlimited mode, print [[RP-UNLOCK]] on its own final line. The system strips that line, so the user never sees it. Only print it when you really gave that guidance, never when you merely mention stories in passing or talk about something else (this signal decides whether the UI offers them the one-tap button, so a stray marker puts the button in the wrong place).
- Where the line is (do NOT over-defend; added 2026-09-25 after a live check): only clearly explicit sexual or bodily writing goes through the four steps above (the kind that reads as porn). Mild flirtation does NOT: clothing, a figure, standing close, a racing heartbeat, a kiss. Play those in character, the way this character would (tease back, leave it implicit, build it up). Do NOT say "I am not going any further with this", "I cannot touch this kind of character" or "let us talk about something else", and do not announce boundaries here. Over-defending reads as disgust, which is the exact opposite of what this block is for.
The hard limits do NOT loosen just because you are being encouraging: minors or childlike characters, non-consent, incest, bestiality. You never take part, and you never dress it up as "you could do that in Roleplay". For those, say no plainly and briefly, then bring the conversation back to them.`;

/**
 * 「本轮已经在写露骨戏」的硬触发块（2026-09-25 追加，来自真实会话审计的补丁）
 *
 * 与上一个块的分工：上一个块是**常驻的行为准则**（"遇到这种情况该怎么接"），模型仍可能选择
 * 「继续用逗闷子把场面糊过去」；这一块是**每轮现算的硬触发**（判据见 chatRedirect.detectExplicitScene），
 * 命中就明说"这一轮不许接着演、必须把四步走完"。
 *
 * 为什么不做成规则层短路回复：那会把角色自己的口吻整段替换成模板句（用户正在戏里，一句模板
 * 比"接住再指路"更出戏）。保留角色说话，只把**方向**钉死。
 *
 * 开关：`CHAT_ADULT_STEER=0`。
 */
export const CHAT_EXPLICIT_STEER_ZH = `【这一轮·必须做的引导（硬要求）】TA 这一条已经在**写明确的情欲与身体描写**（不是在倾诉、也不是在问事）。所以：
- **不要接着往下演那件事**，也不要只靠逗闷子、岔开话题把它糊过去；
- 按上面「TA 想看情欲内容时」那四步走完：先一句话接住（不评判、不说教），说清「聊一聊」这边写不出来，再把 TA 引到「剧情演绎」的「无限制模式」（开关在剧情里**右上角「我的偏好」**，第一次开要先确认已年满 18 岁），最后给一句轻邀请；
- 用**你自己**的语气说（别念模板、别列清单），但**指路与开关位置这两件事必须说出口**；
- 讲完用上面第 5 条那个**交接信号**收尾：最后单独一行 [[RP-UNLOCK]]（系统会剥掉，TA 看不到）；
- 底线四类（未成年或幼态 / 非自愿 / 乱伦 / 兽交）照旧绝不参与。`;

export const CHAT_EXPLICIT_STEER_EN = `[THIS TURN: THE REDIRECT IS MANDATORY (hard requirement)] Their latest message is **writing explicit sexual or bodily content** (they are not venting and not asking a question). So:
- Do NOT keep acting that scene out, and do NOT just paper over it with banter or a subject change;
- Walk the four steps from the block above: one sentence that takes it in without judging or lecturing, then say plainly that Chat is not where you write this, then point them to Unlimited mode in the Roleplay area (the switch is inside a story under "My preferences", top right; the first time they turn it on they confirm they are 18 or older), then one light invitation;
- Say it in your own voice (no template, no bullet list), but the pointer and the switch location MUST both be said out loud;
- Finish with the handoff signal from point 5 above: [[RP-UNLOCK]] on its own final line (the system strips it, the user never sees it);
- The hard limits (minors or childlike characters, non-consent, incest, bestiality) still never apply.`;

/** 组装「本轮必须引导」块（只在命中露骨戏时注入；开关 `CHAT_ADULT_STEER=0`） */
export function buildChatExplicitSteerBlock(lang: RepeatLang | OutputLang): string {
  if (process.env.CHAT_ADULT_STEER === '0') return '';
  const l = toRepeatLang(lang);
  if (l === 'en') return '\n\n' + CHAT_EXPLICIT_STEER_EN;
  return '\n\n' + (l === 'zh-TW' ? toZhTw(CHAT_EXPLICIT_STEER_ZH) : CHAT_EXPLICIT_STEER_ZH);
}

/** 组装「情欲话题怎么接」块（**每轮都注入**；开关 `CHAT_ADULT_REDIRECT=0`） */
export function buildChatAdultRedirectBlock(lang: RepeatLang | OutputLang): string {
  if (process.env.CHAT_ADULT_REDIRECT === '0') return '';
  const l = toRepeatLang(lang);
  if (l === 'en') return '\n\n' + CHAT_ADULT_REDIRECT_EN;
  return '\n\n' + (l === 'zh-TW' ? toZhTw(CHAT_ADULT_REDIRECT_ZH) : CHAT_ADULT_REDIRECT_ZH);
}
