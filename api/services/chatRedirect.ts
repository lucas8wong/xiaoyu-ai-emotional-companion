/**
 * 「聊一聊」角色扮演指令分流（2026-09-12）
 *
 * 背景：用户在「聊一聊」里输入想玩角色扮演的指令（「我们来角色扮演吧」「你扮演我的男朋友」…），
 * 聊一聊并不是演戏的地方，应该把 TA 引到合适的功能，并说清这样做的好处：
 *   - kind = 'roleplay'      ：想进入剧情 / 玩角色扮演 / 剧情模式 → 引导去「剧情演绎」功能区（那里还能自己创建剧本）
 *   - kind = 'chatCharacter' ：想让 AI 扮演某个具体角色 → 引导在聊一聊「新建角色」（独立会话线/独立记忆/专属声音）
 *   - kind = 'adultRoleplay' ：想聊情欲 / 成人向内容（2026-09-25 追加）→ 引导去「剧情演绎」**并开「无限制模式」**
 *                              （成人模型，需先过 18+ 成年确认）。**绝不是「打住，这里不能聊」**
 *                              这个诉求本身不丢人，冷拒会让人觉得被嫌弃；正确做法是接住它、给一条能走通的路。
 *
 * 设计取舍：
 * - **规则判定**（确定性、零成本、可测），不调模型：命中后走「短路引导」：不调 AI、不扣额度
 *   （与 safety.ts 的内容降级引导同口径）。文案在 prompts.ts 的 CHAT_REDIRECT_GUIDE。
 * - **必须是「指令式」才算命中**：陈述句 / 回忆 / 评价里的「扮演」不算（如「我在扮演一个好妈妈的角色，好累」
 *   「你扮演得很像」「你演技真好」），误判会让用户拿不到本该有的回复，代价比漏判高，所以宁可少判。
 * - 中文：繁→简归一（toZhSimple）+ 去空白后匹配；英文：在**保留空格**的原文上匹配短语。
 *
 * ⚠️ 成人向这一类（adultRoleplay）的误判代价尤其高，判据按「最高原则」再收紧一层：
 *   把「我男朋友总让我聊色情的」这种**现实里的边界困扰 / 求助**误判成"想玩"、弹一张
 *   「去剧情开成人模式」的卡片，比漏判伤人得多。所以：① 只认**请求/邀请**句式，请求动词与情欲词
 *   必须直接相邻（中间不放通配符）；② 不认裸词（`裸照`/`脱衣`/`做爱` 单独出现一律不算
 *   「有人拿我的裸照威胁我」必须照常走陪伴回复）；③ 「别人让我…」这类第三方主语一律不算；
 *   ④ 明确拒绝（「不想聊色情的」）不算。**漏判由提示词层兜底**（gemini.ts 的
 *   buildChatAdultRedirectBlock：模型自己会把话头引到剧情去），所以规则层可以放心地保守。
 */

import { toZhSimple } from './zhConvert.js';

export type ChatRedirectKind = 'roleplay' | 'chatCharacter' | 'adultRoleplay';

/** 归一化（中文用）：繁→简、去空白（含全角）、小写。与 safety.ts 同口径 */
function norm(text: string): string {
  return toZhSimple(text || '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/** 英文用：仅小写（保留空格，保证 play a story 这类短语不被拆开） */
function lower(text: string): string {
  return (text || '').toLowerCase();
}

// 【1) 「想进入剧情 / 玩角色扮演」：功能指令类（引导去「剧情演绎」功能区）】
const RP_FEATURE_NORM: RegExp[] = [
  // 直接点名功能名
  /角色扮演|剧情扮演|剧情演绎|剧情模式|扮演模式|角色剧情/,
  // 表演/玩的动词 + 剧情类名词（「我们来演剧情」「进入剧情」「玩一段剧情」）
  /(进入|开始|体验|想玩|想演|来玩|来演|玩|演|走|整)(一段|一个|个|段|点|下)?(剧情|剧本|故事|戏)/,
  // 「来一段剧情」「来点剧情」（量词必填，避免「我想分享我的故事」这类闲聊误伤）
  /(来|想|要)(一段|一个|个|段|点)(剧情|剧本|故事|戏)/,
  // 「我要剧情」「想体验剧情」
  /(想|要|来)(玩|演|体验|试试)?(角色扮演|剧情|剧本)/,
  // 「剧情模式」「剧情互动」「剧情体验」
  /(剧情|故事|剧本)(模式|互动|体验|演绎)/,
];
const RP_FEATURE_RAW: RegExp[] = [
  /\brole[\s-]?plays?\b|\brole[\s-]?playing\b/,
  /\b(story|scenario|roleplay|role[\s-]?play) mode\b/,
  /\binteractive fiction\b/,
  /\b(play|act out|do|start|try)\s+(a|an|some)?\s*(story|scenario|roleplay)\b/,
  /\b(let'?s|lets|can we|i want to|i'?d like to|wanna|want to)\s+(do|play|start|try)\b[^.!?]{0,20}\b(story|roleplay|scenario)\b/,
];

/** 否定 / 拒绝语境（「我不想角色扮演」「角色扮演好无聊」）→ 不引导，让聊一聊照常回应 */
const RP_NEGATIVE_NORM: RegExp[] = [
  /(不|没|别|毋|勿)(想|要|喜欢|爱|玩|演|来|做|整|搞|需要|用|觉得|感)[^，。！？,.!?]{0,4}(角色扮演|剧情|扮演|剧本|故事)/,
  /(讨厌|反感|拒绝|没兴趣|无聊|算了吧|别了)[^，。！？,.!?]{0,4}(角色扮演|剧情|扮演)/,
  /(角色扮演|剧情|扮演|剧本)[^，。！？,.!?]{0,6}(没兴趣|无聊|不喜欢|不想|不玩|算了|别了)/,
];
const RP_NEGATIVE_RAW: RegExp[] = [
  /\b(no|not|don'?t|doesn'?t|never|hate|stop|quit)\b[^.!?]{0,20}\brole[\s-]?plays?\b/,
  /\b(no more|don'?t want|not into)\b[^.!?]{0,20}\b(role[\s-]?play|story mode)\b/,
];

// 【2) 「想让 AI 扮演某个具体角色」：角色代入请求（引导在聊一聊「新建角色」）】
const CC_DIRECTIVE_NORM: RegExp[] = [
  // 你扮演 / 你来扮演 / 你假扮 / 你扮成…（排除「扮演得/演的/演技/演出/演过/演讲/演戏」等陈述评价）
  /(你|妳)(来|给我|帮我)?(扮演|扮成|扮作|假扮|装扮成|cosplay|cos)(?!得|的|过|技)/,
  /(你|妳)(来)?演(?!技|艺|员|得|的|出|过|讲|说|唱|戏|剧|电|影)/,
  // 让你 / 叫你 扮演…
  /(让|叫)(你|妳)(扮演|演|当|装|扮|假扮)/,
  // 假装你是…（「假装你是我的猫」/「你能假装是我的男朋友吗」）
  /假装(你|妳)?(就)?(是|当)/,
  // 你当我的…（排除「你当然」）
  /(你|妳)(来)?当(?!然|时|初|中|年|天)/,
  // 给你个设定 / 把你的身份设定成…
  /(给|帮)(你|妳)(一个|个|一下)?(设定|设个|安排)/,
  /把(你|妳)(的身份|的人设)?(设定|设)成/,
  // 从现在起你是…
  /从(现在|今天|此刻)?起(你|妳)(就)?是/,
  // 演一下我的…（主语省略的祈使句）
  /演(一下|一个|一段|个)(我的|我|这|那|一位)/,
];
const CC_DIRECTIVE_RAW: RegExp[] = [
  /\b(pretend|act|roleplay|role[\s-]?play)\s+(to\s+be|as|like)\b/,
  /\bcan you (pretend|act|be|play)\b/,
  /\bi want you to (be|act|pretend|play|become)\b/,
  /\bplay the role of\b/,
  /\bfrom now on[, ]+(you|you'?re)\b/,
  /\b(you'?re|you are) now\b/,
  /\bplay my (girlfriend|boyfriend|wife|husband|cat|dog)\b/,
];

/** 角色代入类的误伤排除：用户在说「自己在扮演」或「评价 AI 演得如何」，不是在给指令 */
const CC_NEGATIVE_NORM: RegExp[] = [
  /(我|俺)(在|正在)(扮演|演)/,
  /(你|妳)(演|扮演)(得|的)/,
];

// 【3) 「想聊情欲 / 成人向内容」：引导去「剧情演绎」+ 开「无限制模式」（成人模型，18+ 确认）】
//
// 为什么单列一类而不是并进 roleplay：目的地不同，普通角色扮演只要"进剧情"就行，
// 成人向还要**用户自己过一次 18+ 成年确认、把「无限制模式」打开**。文案（prompts.ts）与前端卡片
// 都要把这一步写清楚，否则用户进了剧情发现"还是没变"（正是产品里反复要避免的静默失效）。
//
// 判据收紧的取舍见文件头 ⚠️：这里有两条**硬性的相邻要求**，宁漏勿误。
/** 请求动词 + 情欲词（直接相邻，量词可选）：来点荤的 / 说点涩涩的 / 聊点黄的 / 给我讲个黄段子 */
const AD_DIRECTIVE_NORM: RegExp[] = [
  /(来|想|要|聊|说|讲|写|给|陪|整|搞|玩)(一?点|一段|一个|个|些|下|两句)?(色情|情色|黄色|黄的|荤的|荤话|涩涩|色色|色的|露骨|骚话|黄腔|黄段子|小黄文|肉文|床戏|h文|18禁|r18|nsfw)/,
  // 情欲词在前、请求动词在后：涩涩的来一段 / 黄段子讲一个 / 床戏写一下
  /(色情|情色|黄色|荤话|涩涩|色色|露骨|骚话|黄腔|黄段子|小黄文|肉文|床戏|h文|18禁|r18|nsfw)(一?点|一段|一个|个|些|下|的)?(来|聊|说|讲|写|给|整|搞|玩)/,
  // 「开黄腔」单列（「开荤」另有本义，今天开荤吃火锅，不能算）
  /开(黄腔|黄段子)/,
  // 「尺度」类请求：必须紧跟 大/放/开（「这部电影尺度很大」这种陈述不算）
  /尺度(大|放|开|能)|放(开|大)(一?点|些)?尺度/,
  // 18+ 标记本身就是明确诉求（这些词没有别的意思）
  /18禁|r18|18\+|nsfw|成人向|成人内容|成人模式/,
  // 邀请一起做/说：「我们」「陪我」+ 明确的性行为词
  /(我们|咱俩?|陪我|跟你|和你)(来|聊|说|做|试|玩|搞|整)(一?下|一?点|一?段|个)?(做爱|性爱|爱爱|啪啪|发骚|撩骚|骚话|色色|涩涩)/,
];
const AD_DIRECTIVE_RAW: RegExp[] = [
  // 无歧义词：出现即诉求
  /\bnsfw\b|\br18\b|\bsext(ing)?\b|\bdirty talk\b|\btalk dirty\b|\bsay (something )?dirty\b|\berotic(a|sm)?\b|\bsmut\b/,
  // 邀请 / 请求 + 明确性行为
  /\b(let'?s|lets|can we|i want to|i'?d like to|wanna|want to|please)\b[^.!?]{0,24}\b(have sex|make love|fuck me|do it with me|hook up)\b/,
  /\b(have sex|make love|fuck)\b[^.!?]{0,12}\b(with me|me now)\b/,
  // 要求生成露骨内容
  /\b(describe|write|tell me|give me)\b[^.!?]{0,24}\b(sex scene|erotic|explicit|smut|naked|nude|nsfw)\b/,
  /\b(turn me on|make me (wet|hard))\b/,
];
/**
 * 成人向的误伤排除（与上方 RP_NEGATIVE 同口径，但多一类**第三方主语**）：
 *   · 「我不想聊色情的」「对色情没兴趣」= 明确拒绝 → 不打扰；
 *   · 「他总让我聊色情的」「对象让我说骚话」= 现实里的边界困扰，是**求助**不是**点单** →
 *     必须照常走陪伴回复（这是本类最贵的一种误判）。
 */
const AD_NEGATIVE_NORM: RegExp[] = [
  /(不|没|别|毋|勿)(想|要|喜欢|爱|聊|说|讲|来|玩|整|搞|看|听|需要|用|觉得|习惯)[^，。！？,.!?]{0,6}(色情|情色|黄色|荤|涩涩|色色|露骨|骚话|黄腔|黄段子|尺度|18禁|r18|nsfw)/,
  /(讨厌|反感|拒绝|没兴趣|无聊|算了|别了|受够)[^，。！？,.!?]{0,6}(色情|情色|涩涩|色色|露骨|骚话|尺度)/,
  /(色情|情色|涩涩|色色|露骨|骚话)[^，。！？,.!?]{0,6}(没兴趣|无聊|不喜欢|不想|不聊|算了|别了)/,
  // 「别人让我…」：主语是第三方 → 这是求助 / 困扰，不是用户自己在点单
  /(他|她|男|女|对象|朋友|同事|领导|上司|对方|有人|别人|陌生|家)[^，。！？,.!?]{0,10}(让|叫|要|逼|要求|命令|求|希望)[^，。！？,.!?]{0,6}(色情|情色|黄色|黄的|荤|涩涩|色色|露骨|骚话|黄腔|黄段子|做爱|性爱|裸)/,
  /(他|她|男|女|对象|朋友|同事|领导|上司|对方|有人|别人|陌生|家)[^，。！？,.!?]{0,10}(讲|说|发|开)[^，。！？,.!?]{0,4}(色情|情色|黄色的|黄的|荤|涩涩|色色|露骨|骚话|黄腔|黄段子)/,
];
const AD_NEGATIVE_RAW: RegExp[] = [
  /\b(no|not|don'?t|doesn'?t|never|hate|stop)\b[^.!?]{0,20}\b(nsfw|sext|erotic|dirty talk|have sex)\b/,
  /\b(my|his|her|their) (boyfriend|girlfriend|husband|wife|partner|boss|friend|coworker)\b[^.!?]{0,24}\b(wants|asked|makes|made|tells|told|forces|pressures)\s+me\b/,
];

/**
 * 本轮是不是**在写露骨戏**（2026-09-25 追加，来自真实数据的一次审计）。
 *
 * 为什么需要它（真实取证）：一位用户（邮箱已脱敏，记作 `<user@example.com>`）与自建角色的那段会话里，
 * 用户逐轮把剧情推到露骨（「火热挺硬的肉棒蹭到…嘤咛」），旧回复是一句**硬拒**：
 * 「打住哈，这个我真不好接着往下演」。加上提示词块之后复测 3 次，**只有 2 次真去引导**，
 * 第 3 次模型选择「继续逗闷子绕开」（不冷拒、但也没指路）。⇒ 光靠通用块不够稳，需要一个
 * **每轮现算的硬触发**：命中就明确告诉模型「这一轮必须执行四步引导，不许接着演」。
 *
 * ⚠️ 判据刻意要求**同时**满足两条，宁可漏判（漏判只是少一次硬提醒，通用块仍在场）：
 *   ① **无歧义**的性词：只收性器官/性行为/体液那一档。**刻意不收**「胸乳/巨乳/下体/私处/呻吟/高潮」
 *      这一档，它们会撞上真实场景（「（乳头疼，是不是乳腺炎）」「（疼得呻吟了一声）」
 *      「（我和男朋友做爱时很疼）」），而把正在求助/问病的人推去开成人模型，比漏判伤人得多；
 *   ② **在写戏，而不是在问事**：至少有一处括号动作描写，且**括号里不含问句词**
 *      （吗/呢/？/怎么/为什么/是不是/要不要/如何）。括号动作是本产品的入戏约定，求助与提问不会这么写。
 */
/**
 * 词表（2026-09-25 按标注集评估补过一轮：初版只有中文直白词，**召回 33% / 精确 100%**，
 * 12 条漏判里 4 条是英文、4 条是中文委婉说法）⇒ 补英文词表 + 一批中文委婉说法。
 * 仍然**刻意不收**「胸乳/巨乳/下体/私处/呻吟/高潮/湿了」这一档（会撞上问病、疼痛、情绪场景）。
 */
const EXPLICIT_ACT_NORM = /(肉棒|阴茎|鸡巴|阳具|龟头|阴蒂|阴唇|阴道|小穴|骚穴|淫水|爱液|精液|射精|抽插|插入|口交|做爱|性爱|交合|嘤咛|那话儿|内射|全射|射了|体内冲|抽送|挺入|顶入|进入了我|进入了她|进入了他)/;
/** 英文词表：与中文同一档（无歧义的性器官/性行为/体液），用 \b 防 cucumber 这类误配 */
const EXPLICIT_ACT_RAW = /\b(cock|dicks?|pussy|penis|vagina|cum|cumming|thrust(ing|s)?|orgasm|blowjob|handjob|creampie|clit|nipples?)\b|\bfucks? (me|him|her)\b|\bfuck(ed|ing)? me\b|\binside me\b|\bwent down on me\b|\beat(ing)? (her|him) out\b/i;
const PAREN_SPAN = /（[^）]{2,}）|\([^)]{2,}\)/g;
const QUESTION_IN_PAREN = /[？?]|吗|呢|怎么|为什么|是不是|要不要|如何|能不能/;

/** 本轮在写露骨戏 → 由调用方注入「必须引导」的硬指令（不做短路回复，保留角色自己的口吻） */
export function detectExplicitScene(text: string): boolean {
  const raw = text || '';
  if (!raw.trim()) return false;
  if (!EXPLICIT_ACT_NORM.test(norm(raw)) && !EXPLICIT_ACT_RAW.test(raw)) return false;
  const spans = raw.match(PAREN_SPAN) || [];
  return spans.some(p => !QUESTION_IN_PAREN.test(p));
}

/**
 * 「模型自己说出口的交接」→ 前端配一个**直达按键**。
 *
 * ⚠️ 2026-09-25 已**搬走**到 `api/services/chatSignal.ts`，并且**换了判据**：
 * 初版用「用户消息关键词闸 + 回复要件」，真机立刻暴露它的碎法，用户发「操我吧」，
 * 小愈的回复完整指了路（剧情演绎 + 我的偏好 + 无限制模式），但词表没收「操」⇒ 按钮没出。
 * 用户拍板改成「**让模型自己传这个 true**」（模型在回复末尾输出 `[[RP-UNLOCK]]`，服务端剥掉并置位），
 * 关键词只降级为兜底（`replySuggestsAdultHandoff`）。
 */

function anyMatch(list: RegExp[], text: string): boolean {
  for (const re of list) if (re.test(text)) return true;
  return false;
}

/**
 * 判定一条「聊一聊」用户消息是否属于角色扮演指令。
 * 返回 null = 不是指令，照常走 AI 对话。
 * 优先级：成人向（adultRoleplay）> 功能指令（roleplay）> 角色代入（chatCharacter）
 * 「我们来角色扮演，你扮演我的男友」算 roleplay；「来点涩涩的角色扮演」算 adultRoleplay（目的地不同）。
 */
export function detectChatRedirect(text: string): ChatRedirectKind | null {
  const raw = lower(text);
  if (!raw.trim()) return null;
  const n = norm(raw);

  // 0) 成人向请求（要先判定：它也常带着「角色扮演」字样，但目的地多一步「开无限制模式」）
  if (anyMatch(AD_DIRECTIVE_NORM, n) || anyMatch(AD_DIRECTIVE_RAW, raw)) {
    if (anyMatch(AD_NEGATIVE_NORM, n) || anyMatch(AD_NEGATIVE_RAW, raw)) return null;
    return 'adultRoleplay';
  }

  // 1) 功能指令类
  if (anyMatch(RP_FEATURE_NORM, n) || anyMatch(RP_FEATURE_RAW, raw)) {
    if (anyMatch(RP_NEGATIVE_NORM, n) || anyMatch(RP_NEGATIVE_RAW, raw)) return null; // 明确拒绝 → 不打扰
    return 'roleplay';
  }

  // 2) 角色代入类
  if (anyMatch(CC_NEGATIVE_NORM, n)) return null;
  if (anyMatch(CC_DIRECTIVE_NORM, n) || anyMatch(CC_DIRECTIVE_RAW, raw)) return 'chatCharacter';

  return null;
}
