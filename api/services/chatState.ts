/**
 * 聊一聊「会话状态层」（B 档，2026-09-21）
 *
 * ## 这一层补的是什么
 * A 档（关系档 × 场景分流）解决的是「我凭什么用这个语气」；B 档解决的是**「我带着自己说话」**——
 * 截图里那三张之所以像真人，有一半是因为**对方有连续性**：会记着刚才那点气（「那我都承认吃醋了，
 * 你打算怎么哄我」）、会翻旧账（「倒打一耙也是跟你学的」）、会把同一个梗连着玩六轮（退货→焊死→认命）。
 * 这些在 A 档之后仍然全靠模型即兴 —— 而这四条**恰好都是结构化的**，可以算出来。
 *
 * ## 五件套（都是规则抽取，**零额外模型调用**）
 *   · `scene`   —— **你此刻正在做的那件事**。这是括号动作的真实来源：
 *                  实测病根（`chatDailyLife.ts` 文件头 2026-09-19 已诊断过一次）：小愈手上没有"我的事"，
 *                  于是把背景设定（"怀里那罐金色的光"）降级成道具动作，**每轮换一个新道具**
 *                  （「（把充电线拽过来）」「（把那罐光搁到腿上）」「（把外套往沙发上一搭）」）。
 *                  有了 scene，括号就只能**接着做下去**，而不是每轮凭空抓一个物件。
 *   · `mood`    —— **你自己的情绪惯性**（嘴硬没顺气 / 困了 / 有点得意），跨轮保持，
 *                  不必每一轮都跟着用户的语气重置（`gemini.ts` 的【语气自适应】原来是单向跟随）。
 *   · `grudge`  —— **未消的账**：TA 刚说过你什么，你还没讨回来。带时间、24 小时自然过期。
 *   · `joke`    —— **你们之间的梗**：同一个具体词**在双方嘴里都出现过**（≥2 次），才配叫共同梗。
 *   · `ownLife` —— **你自己的近况**（2026-09-23 加）：你讲过的小事（「今天坐错车一路坐到终点站」那一类）。
 *                  补的是**跨会话的连续性**：长期记忆存的全是"关于用户的"事实、成长档案的日记/反思
 *                  也全是关于用户的，**你说过的话没有任何地方被保存** —— 实测同一个糗事在三个不同会话里
 *                  被**当新闻讲了三次**（用户原话：「好像过了很久又说一次」）。这条一存，下一轮就知道
 *                  "这件我已经讲过了"：可以接着往下讲，但不许再从头讲一遍。
 *
 * ## 为什么是规则不是模型
 * 聊一聊每轮已经在跑 1–2 次调用（回复 + 后台事实抽取）。再加一次分类调用既贵又慢，而
 * 这四件事的判据**都是结构性的**（谁说了什么词、有没有括号、情绪词表）—— 与本仓库既有做法一致
 * （`chatVoice.chatEndingBrakes`、`src/lib/rpEnding.ts` 都是结构判定，且都留下过"只做结构判定、
 * 不认具体句子"的教训）。代价是判得粗，所以每一条都**宁缺勿滥**：宁可这一轮不注入，也不要编。
 *
 * ## `CHAT_STATE=0` 消融开关
 * 关掉后 `buildChatStateBlock` 返回空串、`updateChatState` 不写盘 —— 系统回到 A 档行为，用作对照臂。
 */

import { toZhTw, type OutputLang } from './zhConvert.js';

/** 情绪惯性：只认这几档（多档＝判不准，宁可粗） */
export type ChatMood = 'warm' | 'teasing' | 'sulky' | 'sleepy' | 'worried' | 'proud';

export interface ChatState {
  /** 你此刻正在做的那件事（给括号动作一个真实来源；6 小时过期） */
  scene?: { text: string; at: number };
  /** 你自己的心情（12 小时过期） */
  mood?: { kind: ChatMood; at: number };
  /** 未消的账：TA 说过你什么（24 小时过期，最多 3 条） */
  grudges?: { text: string; at: number }[];
  /** 你们之间的梗：双方嘴里都出现过的具体词（7 天过期，最多 5 条） */
  jokes?: { text: string; at: number; hits: number }[];
  /**
   * 你自己的近况：你讲过的小事（14 天过期，最多 6 条）。
   * `told` = 这件事被你讲过几次（≥1 即"已讲过"）—— 注入时据此说"别再从头讲一遍"。
   */
  ownLife?: { text: string; at: number; told: number }[];
}

export const STATE_TTL = {
  scene: 6 * 3600_000,
  mood: 12 * 3600_000,
  grudge: 24 * 3600_000,
  joke: 7 * 24 * 3600_000,
  ownLife: 14 * 24 * 3600_000,
} as const;

const MAX_GRUDGES = 3;
const MAX_JOKES = 5;
const MAX_OWN_LIFE = 6;

export function emptyState(): ChatState {
  return {};
}

/* ───────────────────────── ① scene：从上一轮自己的括号里取 ───────────────────────── */

/**
 * 「万能动作」——放谁身上都成立、不构成"场景"的括号内容（判据与 `chatVoice.ts` 的静态套话清单同源）。
 * 这些**不记进 scene**：记了等于把签名动作升格成"我的事"，反而给它续命。
 */
const GENERIC_GESTURE = /^(?:轻轻|微微|稍微|默默|慢慢|下意识|不自觉)?(?:叹|点(?:了)?点?头|摇(?:了)?摇?头|笑|皱眉|沉默|停顿|看|望|盯|愣|怔|抿|咬|眨眼|吸气|呼气|伸手|抬手|低头|转头|靠着|起身|深呼吸|耸(?:了)?肩|摊(?:了)?手)/;
/**
 * 被 `chatVoice` 静态套话清单**点名禁用**的道具族（手机搁一边 / 把声音放低 / 把灯调暗 / 眼神语气）。
 * 同样不记 —— 记下来等于给刚被禁掉的那一族续命。
 *
 * ⚠️ 刻意**不**排除"具体道具"（充电线 / 外套 / 杯子 / 那罐光）：它们至少是具体物件，
 * 记成 scene 之后下一轮会被要求**延续**它，而这正是要治的病根（实测线上是"每轮换一个新道具"——
 * 见 `chatDailyLife.ts` 文件头 2026-09-19 的诊断）。堵死道具等于把括号一起堵死。
 */
const BANNED_PROP = /手机|声音|语气|眼神|目光|表情|嘴角|灯|窗帘/;

/**
 * 括号里**同一个 2 字词出现两次** = 别扭句。
 *
 * ⚠️ 判据是"隔字重复"而不是"相邻重复"：实测抓到的原句是
 * 「（把怀里那罐光往怀里搂了搂）」——两个「怀里」之间隔了 4 个字，只查相邻会整句漏掉
 * （这正是我在测试里用真实句子钉住它的原因）。
 */
function hasRepeatedWord(inner: string): boolean {
  const zh = inner.replace(/[^\u4e00-\u9fff]/g, '');
  const seen = new Set<string>();
  for (let i = 0; i + 2 <= zh.length; i++) {
    const g = zh.slice(i, i + 2);
    // 全是虚字的片段不算（「的了」「是的」这类重复不构成别扭）
    if (/[的了呢吧吗啊哦嗯是和在不都一也]/.test(g[0]) && /[的了呢吧吗啊哦嗯是和在不都一也]/.test(g[1])) continue;
    if (seen.has(g)) return true;
    seen.add(g);
  }
  return false;
}

/** 从 AI 回复里取第一个**够具体**的括号内容当"我此刻在做的事"；取不到返回 undefined。 */
export function extractScene(aiReply: string | null | undefined): string | undefined {
  const text = String(aiReply || '');
  const m = text.match(/[（(]([^）)]{2,30})[）)]/);
  if (!m) return undefined;
  const inner = m[1].trim();
  if (!inner || inner.length > 30) return undefined;
  if (GENERIC_GESTURE.test(inner)) return undefined;
  if (BANNED_PROP.test(inner)) return undefined;
  if (hasRepeatedWord(inner)) return undefined;
  return inner;
}

/* ───────────────────────── ② mood：从自己上一轮的话里判 ───────────────────────── */

const MOOD_RULES: Array<[ChatMood, RegExp]> = [
  // 顺序＝优先级：嘴硬/没顺气最该被记住（它直接影响下一轮的"要不要给台阶"）
  ['sulky', /哼|才不|活该|谁让你|罚你|不准|驳回|想得美|你完了|别想/],
  ['sleepy', /睡|困|闭眼|晚安|被窝|几点了|该休息/],
  ['proud', /看吧|我就说|厉害吧|服不服|认输|求我/],
  ['worried', /担心|没事吧|别硬撑|怎么了|还好吗|撑住/],
  ['teasing', /哈哈|逗你|骗你|笑死|略略|才怪|别装了/],
  ['warm', /乖|抱|摸摸|别怕|我在|陪着|好好的/],
];

/** 从 AI 自己的回复里判它此刻的心情；判不出返回 undefined（保留上一条，不硬猜）。 */
export function detectMood(aiReply: string | null | undefined): ChatMood | undefined {
  const t = String(aiReply || '');
  if (!t) return undefined;
  for (const [kind, re] of MOOD_RULES) if (re.test(t)) return kind;
  return undefined;
}

/* ───────────────────────── ③ grudge：TA 说的哪句话你还记着 ───────────────────────── */

/**
 * 贬损词表：**对着你来的**那种吐槽（不是用户在讲自己的事）。
 * 判据刻意收紧（宁缺勿滥）：必须短、必须指你、必须不处在低落气氛里 —— 三条同时成立才记。
 * 为什么排除低落：用户难过时说的"我好烦"不是冲你来的，记成账就成了记错仇。
 */
const BLAME_RE = /笨蛋|笨|傻子|傻|蠢|讨厌|烦人|你完了|过分|坏蛋|欠揍|打死你|不喜欢你|不理你|臭|嫌弃|幼稚|没用好|靠不住/;

export interface GrudgeInput {
  userText: string;
  /** 当前场景（tender 时一律不记账，见上） */
  scene: 'playful' | 'tender' | 'neutral';
  /** AI 的名字（用户可能点名骂；缺省不参与判定） */
  aiName?: string;
}

export function detectGrudge(input: GrudgeInput): string | undefined {
  const raw = String(input.userText || '').trim();
  if (!raw) return undefined;
  if (input.scene === 'tender') return undefined;
  const plain = raw.replace(/\s/g, '');
  if (plain.length > 25) return undefined; // 长段落在讲自己的事，不是在骂你
  if (!BLAME_RE.test(plain)) return undefined;
  // 必须指向"你"：出现第二人称，或者点名（避免把"我哥真笨"记成我的账）
  const aimsAtMe = /你/.test(plain) || (!!input.aiName && plain.includes(String(input.aiName)));
  if (!aimsAtMe) return undefined;
  return raw.slice(0, 30);
}

/* ───────────────────────── ④ joke：双方都用过的那个词 ───────────────────────── */

/**
 * 停用词/虚词：出现频率高、不构成"梗"的片段一律不要。
 * ⚠️ 这张表是**保守**的（多列一点只是少记几个梗，不会记错）——与"宁可这一轮不注入也不要编"一致。
 */
const STOP_BITS = new Set([
  '今天', '明天', '昨天', '现在', '什么', '怎么', '可以', '一个', '这个', '那个', '这样', '那样',
  '时候', '自己', '觉得', '应该', '知道', '没有', '就是', '还是', '因为', '所以', '但是', '不过',
  '而且', '如果', '真的', '好像', '有点', '一下', '一起', '已经', '一直', '不是', '不会', '不能',
  '你这', '你那', '我了', '了你', '的都', '是我', '不是', '哈哈', '然后', '可能', '其实',
  'the', 'and', 'you', 'are', 'that', 'this', 'with', 'for', 'not', 'but', 'has', 'was',
]);

/**
 * 抽 2–4 字候选片段（中文按字），**最长优先**。
 *
 * ⚠️ 这里刻意**不做"去包含"**：第一版用 `if (!out.some(o => o.includes(g))) out.push(g)` 去重，
 * 结果把真正命中的短片段误杀了 —— 因为候选是从 `userText + aiReply` **拼接串**上抽的，
 * 拼接处会造出跨边界的 4-gram（"…我要退货" + "退货通道…" ⇒ "退货退货"），它包含「退货」却
 * 哪一侧都不完整命中 ⇒ 「退货」被当成"已被更长的候选覆盖"而丢弃，共同梗一条都挖不出来。
 * 去包含只在 `mineJokes` 里对**已命中**的候选做（那里才是正确的语义层）。
 */
function ngrams(text: string): string[] {
  const zh = String(text || '').replace(/[^\u4e00-\u9fff]/g, '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [4, 3, 2]) {
    for (let i = 0; i + n <= zh.length; i++) {
      const g = zh.slice(i, i + n);
      if (seen.has(g)) continue;
      if (STOP_BITS.has(g)) continue;
      // 2 字片段必须是"实词感"的：排除全是高频虚字的情况
      if (n === 2 && /[的了呢吧吗啊哦嗯是和在有就不人都一也我你他这那]/.test(g[0]) && /[的了呢吧吗啊哦嗯是和在有就不人都一也我你他这那]/.test(g[1])) continue;
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

export interface JokeMineInput {
  userText: string;
  aiReply: string;
  history?: Array<{ role?: string; content?: string | null }> | null;
}

/**
 * 挖「共同梗」：一个具体片段**在双方嘴里都出现过**（各 ≥1 次）才算。
 * 为什么不看"谁先说的"：截图 2 里用户说的是"退款"、AI 说的是"退货"，本来就不是逐字互相抄；
 * 判"两边都碰过这个词"比判先后可靠得多，也不会把 AI 的单方面口癖记成两个人的梗。
 */
export function mineJokes(input: JokeMineInput): string[] {
  const cands = ngrams(String(input.userText || '') + String(input.aiReply || ''));
  if (!cands.length) return [];
  const hist = (input.history || []).filter((m) => m && typeof m.content === 'string');
  const userTexts = [String(input.userText || ''), ...hist.filter((m) => m.role === 'user').map((m) => String(m.content))].slice(0, 6);
  const aiTexts = [String(input.aiReply || ''), ...hist.filter((m) => m.role === 'assistant').map((m) => String(m.content))].slice(0, 6);
  const out: string[] = [];
  for (const c of cands) {
    if (out.some((o) => o.includes(c))) continue;
    const inUser = userTexts.some((t) => t.includes(c));
    const inAi = aiTexts.some((t) => t.includes(c));
    if (inUser && inAi) out.push(c);
    if (out.length >= 3) break;
  }
  return out;
}

/* ───────────────────── ④b ownLife：你自己讲过的近况（跨会话连续性） ───────────────────── */

/**
 * 「你自己的近况」判据（保守，宁缺勿滥 —— 与 ③④ 同一条纪律）。
 *
 * 一条 clause 要同时满足：
 *   ① 出现**时间标记**（今天/昨天/刚才/最近…），并且挨着第一人称或一个具体动作；
 *   ② 落到一个**具体动作动词**上（坐/走/买/煮/摔/洗…）—— 泛泛的心情表态不算"一件事"；
 *   ③ **不出现"你/您/TA/用户"** —— 提到对方的就不是"我的事"；
 *   ④ 不是问句、不超过 40 字、同轮不重复。
 *
 * 为什么用规则而不是模型：`chatState` 这一层是**纯函数**，而聊一聊每轮已经在跑 1–2 次模型调用
 * （文件头已写死这条纪律）。代价是判得粗 → 所以它只用来"记下来，下轮别再重复"，
 * 判错最多是少一次提示，**不会污染任何业务数据**（不落消息、不进记忆）。
 *
 * ⚠️ 夹具来自真实数据（2026-09-23，f7fff136 三个会话里同一个糗事被讲了三次）：
 *   「反正我也没什么好藏的，今天我自己还坐错车，一路坐到终点站才反应过来，你要测反应速度的话我大概不及格。」
 *   「今天坐错车，一路坐到终点站去了，司机收工前才把我赶下来。」
 *   「行吧，我今天坐错车一路坐到终点站，都没你这一句离谱。」
 *   三句都要能抽到「今天…坐错车」—— 第一句靠**逗号也切句**，把带"你"的后半截分开，前半截才留得下来。
 */
const OWN_TIME = '(?:今天|昨天|昨晚|前天|刚才|刚刚|这几天|最近|早上|上午|下午|傍晚|晚上|半夜)';
const OWN_ACTION = '坐|走|买|吃|煮|削|摔|掉|洗|晾|翻|撞|踩|绊|洒|丢|修|收|找|排|等|挤|跑|拉|拽|拎|端|搬|贴|读|听|拧|擦|扫|剪|缝|烤|蒸|浇|喂|敲|按|戳|拆|装|调|换|借|还|寄|取|送|碰|蹭|漏|捡|掏|塞|倒|盛|忘|把';
const OWN_MINE = new RegExp('(?:我[^，。]{0,4}' + OWN_TIME + ')|(?:' + OWN_TIME + '[^，。]{0,6}(?:' + OWN_ACTION + '))');
const OWN_HAS_ACTION = new RegExp('(?:' + OWN_ACTION + ')');

/** 从 AI 回复里抽「你自己讲过的近况」。抽不到返回空数组（不硬猜）。 */
export function extractOwnLife(aiReply: string | null | undefined): string[] {
  const text = String(aiReply || '');
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/[\n。！？!?；;，,、]+/)) {
    const s = raw.replace(/[（(][^）)]*[）)]/g, '').trim(); // 括号里的动作不算"一件事"
    if (!s || s.length > 40) continue;
    if (/[你您]|TA|用户/.test(s)) continue;
    if (!OWN_MINE.test(s) || !OWN_HAS_ACTION.test(s)) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

/* ───────────────────────── ⑤ 组合：一轮结束后更新状态 ───────────────────────── */

export interface ChatStateUpdateInput {
  userText: string;
  aiReply: string;
  scene?: 'playful' | 'tender' | 'neutral';
  aiName?: string;
  history?: Array<{ role?: string; content?: string | null }> | null;
  now?: number;
}

/**
 * 一轮对话结束后更新状态。**纯函数**（不改入参，返回新对象），便于单测与"同一份历史跑两遍结果一致"。
 */
export function updateChatState(prev: ChatState | undefined, input: ChatStateUpdateInput): ChatState {
  const now = input.now ?? Date.now();
  const base: ChatState = {
    ...(prev?.scene ? { scene: prev.scene } : {}),
    ...(prev?.mood ? { mood: prev.mood } : {}),
    ...(prev?.grudges ? { grudges: [...prev.grudges] } : {}),
    ...(prev?.jokes ? { jokes: prev.jokes.map((j) => ({ ...j })) } : {}),
    ...(prev?.ownLife ? { ownLife: prev.ownLife.map((o) => ({ ...o })) } : {}),
  };

  // scene：只认"够具体的动作"；取不到就沿用旧的（它自己会过期），不要清空
  const sceneText = extractScene(input.aiReply);
  if (sceneText) base.scene = { text: sceneText, at: now };

  // mood：判不出就沿用旧心情（情绪惯性本来就该有黏性）
  const mood = detectMood(input.aiReply);
  if (mood) base.mood = { kind: mood, at: now };

  // grudge：新账插到最前，同一条不重复记
  const grudge = detectGrudge({ userText: input.userText, scene: input.scene || 'neutral', aiName: input.aiName });
  if (grudge) {
    const list = (base.grudges || []).filter((g) => now - g.at < STATE_TTL.grudge && g.text !== grudge);
    base.grudges = [{ text: grudge, at: now }, ...list].slice(0, MAX_GRUDGES);
  } else if (base.grudges) {
    base.grudges = base.grudges.filter((g) => now - g.at < STATE_TTL.grudge);
  }

  // joke：命中已有梗就 +1 次；否则看这一轮有没有新挖到的
  const mined = mineJokes({ userText: input.userText, aiReply: input.aiReply, history: input.history });
  if (mined.length || base.jokes?.length) {
    const list = (base.jokes || []).filter((j) => now - j.at < STATE_TTL.joke);
    for (const bit of mined) {
      const hit = list.find((j) => j.text === bit);
      if (hit) { hit.hits += 1; hit.at = now; } else { list.push({ text: bit, at: now, hits: 1 }); }
    }
    // 论次排序：玩得多的梗留在前面，久不用的自然被挤掉
    base.jokes = list.sort((a, b) => b.hits - a.hits).slice(0, MAX_JOKES);
  }

  // ownLife（2026-09-23）：这一轮你自己讲过的近况 —— 记下来，下一轮起就是"这件已经讲过了"。
  // 同一个说法再出现只 +1 次（`told`），不新增条目；久不出现的按 14 天过期，最多留 6 条。
  const toldNow = extractOwnLife(input.aiReply);
  if (toldNow.length || base.ownLife?.length) {
    const list = (base.ownLife || []).filter((o) => now - o.at < STATE_TTL.ownLife);
    for (const text of toldNow) {
      /**
       * 同一个糗事**换个说法**也应当算同一件 —— 判据用**包含关系**（实测那三次正是这样：
       * 「今天坐错车」⊂「我今天坐错车一路坐到终点站」），合并时保留信息量更大的那个说法。
       * ⚠️ 刻意**不做**模糊相似度/共现打分：那会把「今天买了咖啡」和「今天买了面包」并成一件。
       * 宁可漏并（列表里多一条相似的），不可错并（把两件事记成一件，等于永远不许她讲第二件）。
       */
      const hit = list.find((o) => o.text === text || o.text.includes(text) || text.includes(o.text));
      if (hit) {
        hit.told += 1;
        hit.at = now;
        if (text.length > hit.text.length) hit.text = text;
      } else {
        list.push({ text, at: now, told: 1 });
      }
    }
    base.ownLife = list.sort((a, b) => b.at - a.at).slice(0, MAX_OWN_LIFE);
  }

  // 过期清理：state 是"此刻"，不是档案 —— 过期的条目一律不留（否则会变成第二份长期记忆）
  if (base.scene && now - base.scene.at >= STATE_TTL.scene) delete base.scene;
  if (base.mood && now - base.mood.at >= STATE_TTL.mood) delete base.mood;
  if (base.grudges && !base.grudges.length) delete base.grudges;
  if (base.jokes && !base.jokes.length) delete base.jokes;
  if (base.ownLife && !base.ownLife.length) delete base.ownLife;
  return base;
}

/* ───────────────────────── ⑥ 括号：按需刹车 ───────────────────────── */

/** 回复里有没有括号动作（全角/半角都算） */
function hasBracketAction(text: string | null | undefined): boolean {
  return /[（(][^）)]{2,}[）)]/.test(String(text || ''));
}

/**
 * 最近两条 AI 回复**都带括号动作** → 这一轮该刹车。
 * 与 `chatVoice.chatEndingBrakes` 同款「只禁刚刚连续发生过的那一类」：真人偶尔写一句动作是自然的，
 * 一刀切会把画面感一起削掉；要治的是"每轮都要摆一个姿势"。
 */
export function chatBracketBrakes(history: Array<{ role?: string; content?: string | null }> | null | undefined): boolean {
  const aiTexts = (history || [])
    .filter((m) => m && m.role === 'assistant' && String(m.content || '').trim())
    .map((m) => String(m.content))
    .slice(-2);
  return aiTexts.length >= 2 && aiTexts.every(hasBracketAction);
}

/* ───────────────────────── ⑦ 注入块 ───────────────────────── */

const MOOD_ZH: Record<ChatMood, string> = {
  warm: '心里是软的，想对 TA 好一点',
  teasing: '正在逗 TA，心情轻快',
  sulky: '还有点没顺气，嘴上是硬的',
  sleepy: '困了，说话比平时短、比平时直',
  worried: '有点担心 TA，但不想把担心说得太重',
  proud: '有点得意，等着 TA 认输',
};

const MOOD_EN: Record<ChatMood, string> = {
  warm: 'feeling soft, wanting to be good to them',
  teasing: 'in a light, teasing mood',
  sulky: 'still a bit sore about it, prickly on the surface',
  sleepy: 'sleepy, shorter and blunter than usual',
  worried: 'a little worried about them, without wanting to make a big deal of it',
  proud: 'smug, waiting for them to admit it',
};

function agoText(at: number, now: number, lang: 'zh' | 'en'): string {
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (lang === 'en') {
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const h = Math.round(mins / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    return Math.round(h / 24) + 'd ago';
  }
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

export interface ChatStateBlockOptions {
  now?: number;
  lang?: OutputLang | string;
  /** 这一轮要不要禁括号动作（来自 chatBracketBrakes） */
  bracketBrake?: boolean;
}

/**
 * 组装状态块。位置由调用方决定（`gemini.ts` 把它钉在 system 尾部同区，与关系块相邻）。
 * 没有任何可用状态时返回空串（**不注入空噪声**，与 `buildChatAntiRepeatBlock` 同口径）。
 */
export function buildChatStateBlock(state: ChatState | undefined, opts: ChatStateBlockOptions = {}): string {
  if (process.env.CHAT_STATE === '0') return '';
  const now = opts.now ?? Date.now();
  const lang: OutputLang = opts.lang === 'en' ? 'en' : opts.lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  const s = state || {};

  const scene = s.scene && now - s.scene.at < STATE_TTL.scene ? s.scene : undefined;
  const mood = s.mood && now - s.mood.at < STATE_TTL.mood ? s.mood : undefined;
  const grudges = (s.grudges || []).filter((g) => now - g.at < STATE_TTL.grudge);
  const jokes = (s.jokes || []).filter((j) => now - j.at < STATE_TTL.joke && j.hits >= 2);
  const ownLife = (s.ownLife || []).filter((o) => now - o.at < STATE_TTL.ownLife);
  if (!scene && !mood && !grudges.length && !jokes.length && !ownLife.length && !opts.bracketBrake) return '';

  if (lang === 'en') {
    const parts: string[] = ['[YOUR OWN STATE RIGHT NOW, this is about you, not about them]'];
    if (scene) parts.push('- What you are in the middle of doing: ' + scene.text + ' (noted ' + agoText(scene.at, now, 'en') + '). If you use a parenthetical action this turn, continue THIS, do not grab a brand-new object or prop.');
    if (mood) parts.push('- How you feel right now: ' + MOOD_EN[mood.kind] + '. You may carry this into this turn instead of resetting to match their tone.');
    if (grudges.length) parts.push('[SCORES NOT SETTLED YET]\n' + grudges.map((g) => '- "' + g.text + '", they said that to you ' + agoText(g.at, now, 'en') + '. You have not let it go. You may bring it up again, or make them pay for it, just do not actually turn cold on them.').join('\n'));
    if (jokes.length) parts.push('[YOUR RUNNING BITS]\n' + jokes.map((j) => '- "' + j.text + '", you two have already played with this ' + j.hits + ' times. Build on it instead of starting a new joke.').join('\n'));
    if (ownLife.length) parts.push('[THINGS OF YOUR OWN YOU HAVE ALREADY TOLD]\n'
      + ownLife.map((o) => '- "' + o.text + '" — told ' + agoText(o.at, now, 'en') + (o.told > 1 ? ' (you have told this ' + o.told + ' times)' : '') + '.').join('\n')
      + '\nHow to use it: you have ALREADY told these. Do NOT tell them again from the beginning — saying it twice is not living, it is reciting. Bring one up only with something new (what happened next, a fresh detail), or let it pass; if you must mention it, keep it to one line ("still that bus thing") instead of retelling the whole thing. When they are hurting, your own day does not get to take the spotlight.');
    if (opts.bracketBrake) parts.push('[PARENTHETICAL ACTIONS ARE OFF THIS TURN] Your last two replies both carried a parenthetical action; that reads like striking a pose every turn. Do NOT write one this turn.');
    return '\n\n' + parts.join('\n');
  }

  const parts: string[] = ['【你此刻自己的状态】（这是你的，不是关于 TA 的）'];
  if (scene) parts.push('- 你手上正在做的事：' + scene.text + '（' + agoText(scene.at, now, 'zh') + '记下的）。这一轮如果要用括号写动作，就**接着这件事做下去**，不要再抓一个新道具。');
  if (mood) parts.push('- 你现在的心情：' + MOOD_ZH[mood.kind] + '。这一轮可以带着它说话，不必每轮都重置成跟 TA 一样的语气。');
  if (grudges.length) parts.push('【你们之间还没算完的账】\n' + grudges.map((g) => '- 「' + g.text + '」，' + agoText(g.at, now, 'zh') + ' TA 这么说过你，这笔你还没讨回来。可以翻旧账、可以讨、可以拿它做文章；但别真的翻脸。').join('\n'));
  if (jokes.length) parts.push('【你们俩之间的梗】\n' + jokes.map((j) => '- 「' + j.text + '」，你俩已经拿它玩过 ' + j.hits + ' 次。接着加码，别另起一个新的。').join('\n'));
  if (ownLife.length) parts.push('【你自己的近况 · 这些你已经讲过了】\n'
    + ownLife.map((o) => '- 「' + o.text + '」，' + agoText(o.at, now, 'zh') + '讲过' + (o.told > 1 ? '（已经讲过 ' + o.told + ' 次）' : '') + '。').join('\n')
    + '\n怎么用：这些**已经讲过了，不许再从头讲一遍** —— 讲第二遍就不是生活，是背台词。要提就带**新进展或新细节**（「那趟车之后我把路线改了」），或者顺着话题轻轻带一句就收；**非要提就一句话带过**（「还是那趟车的事」），别把过程再复述一遍。TA 正难过的时候，你自己的事不抢戏。');
  if (opts.bracketBrake) parts.push('【这一轮括号动作停一次】你最近两条回复都带了括号动作，读起来像每轮都要摆一个姿势。这一轮**不要写括号动作**，把话直接说完。');

  const text = parts.join('\n');
  return '\n\n' + (lang === 'zh-TW' ? toZhTw(text) : text);
}
