/**
 * 「这一轮是怎么收尾的」判据，问句 / 征询继续的元话语 / 陈述
 *
 * 起因（2026-09-18 用户口径）：剧情记录里「好多条 AI 的消息在最后都会问『想跟我多说点？』之类的回答，
 * 太多余了」。用户同时提了两条约束：**要考虑用户使用的叙事模式**（经典 / 沉浸），
 * **要考虑所有人使用情况、避免 overfit**。
 *
 * 因此这个模块刻意只做**结构判定**，不认任何具体句子：
 *   不写「想跟我多说点」这类黑名单，那种写法只修得住一个人恰好看到的那一句，
 *   换个说法（「还想聊点啥吗」「要不要继续说」）立刻漏，而且会把结论绑死在一个用户身上。
 *   判据是「结尾在不在做一件事：把话头交回去、问对方要不要继续」。
 *
 * 为什么抽成零依赖纯模块（而不是写在 roleplay.ts 里）：
 *   同一份判据有三个使用方，各写一份必然漂移（项目里已有同类教训，见 `rpWriteGuard.ts` 开篇）：
 *     ① 全站只读扫描 `scripts/rp-ending-scan.mts`（量化「所有人使用情况」+ 前后对比）
 *     ② 剧情提示词 `api/services/roleplay.ts`（把「上一轮就是问句收尾」变成本轮的形态刹车 + 负例）
 *     ③ 单元测试（判据本身要有测试，否则度量工具自己就是没校准的秤）
 *
 * ⚠️ 两层判据的可信度**不一样**，报告里必须分开统计（`rpEndingKind` 的返回值里已区分）：
 *   · `question`（硬判据）：整条回复的句末标点里含 ？/ ?。不会误判，可直接当 KPI。
 *   · `continuation_ask`（启发式）：结尾在「征询对方要不要继续 / 邀请对方多说」。
 *     判据 = 最后一个小句里同时命中「继续说类动词」与（「征询标记」或 是问句）。
 *     它**会**把一些正常台词也算进来（例：「想跟我说说他吗？」问的是剧情里的第三个人；
 *     「你再说一遍？」是命令式重复请求），所以只用于「比例参考」与「负例刹车」，
 *     **不能**用于硬断言、也绝不能用来自动裁剪正文。
 *
 * 刻意的保守取舍（宁可少算，不可多算，这份数字要用来宣称「改善了」）：
 *   · 整段不写句末标点的问句 → 硬判据判为「非问句」（盲区，报告里单列计数，不当成改善）。
 *   · 「你想说什么？」这类**不带征询动词**的追问 → 只算 `question`，不算 `continuation_ask`。
 *   · 征询跨了逗号、收尾小句本身是陈述的（「想跟我多说点吗，我听着。」）→ 漏计（`rpLastClause` 只取最后一个小句）。
 *   · 反向的「要不要我继续讲 / 还想听吗」（它要给，不是问用户要）→ 不在判据内；
 *     实际形态与数量交给扫描脚本的「高频收尾形态」榜去实测，不由这里预先假设。
 *
 * 两个概念（2026-09-18 实测踩坑后拆开，别合并）：
 *   · **句末标点**（`RP_TERMINATORS`）→ 只用于「是不是问句」这个判决。
 *   · **小句**（`RP_BREAKS`，比句末标点多包含逗号/顿号/分号/冒号/换行）→ 用于取「他最后说的那一句」。
 *   为什么要拆：剧情正文常见形态是「旁白动作 + 逗号 + 台词」，若按「标点分句」取最后一句，
 *   会连前一句旁白一起吃进来（实测：`他顿了顿，“想跟我多说点儿不？”` 会取成整串），
 *   于是扫描脚本的「高频收尾形态」榜全是各不相同的长串、一条都聚不到一起，那个榜就白做了。
 *   而判决必须按标点走：`真的吗？！` 的句末是感叹号但它是问句，这类混排标点只有看标点才判得对。
 */

/** 收尾形态 */
export type RpEndingKind = 'question' | 'continuation_ask' | 'statement';

/** 句末标点（中英）。含 ASCII `.`：英文句子用它收尾，漏掉会让「最后一句」退化成整段正文。 */
const RP_TERMINATORS = '。！？!?….';
/** 小句切分点 = 句末标点 + 逗号/顿号/分号/冒号/换行 */
const RP_BREAKS = RP_TERMINATORS + '，,、；;：:\n';
const RP_TRAILING_TERMINATORS = new RegExp('([' + RP_TERMINATORS + ']+)$');
/** 尾部的装饰（空白、引号、书名号、括号）。判据只看正文与句末标点 */
const RP_TAIL_DECORATION = /(?:[\s\u3000]|[」』”"’）)】\]]+)+$/;
/** 头部的装饰（空白、开引号、书名号、括号） */
const RP_HEAD_DECORATION = /^[\s\u3000「『“‘"（(【[]+/;

/** 去掉尾巴上的装饰与空白 */
function stripTailDecoration(s: string): string {
  return String(s || '').replace(RP_TAIL_DECORATION, '').replace(/[\s\u3000]+$/, '');
}

/**
 * 取**最后一个小句**（含它自己的句末标点）。用于「高频收尾形态」统计、人的复核，以及启发式判据。
 *
 * 匹配不到时退化成整段尾部，不抛错。扫描脚本要对脏数据免疫。
 */
export function rpLastClause(text: string): string {
  const t = stripTailDecoration(text);
  if (!t) return '';
  // 先把结尾的句末标点摘下来（可能是 `？！` 这种混排），最后再接回去；
  // 否则「以句号收尾」的正文会被切出一个空串（切分点正好在末尾）。
  const m = t.match(RP_TRAILING_TERMINATORS);
  const closers = m ? m[1] : '';
  const body = closers ? t.slice(0, t.length - closers.length) : t;
  let cut = -1;
  for (let i = body.length - 1; i >= 0; i--) if (RP_BREAKS.includes(body[i])) { cut = i; break; }
  const clause = (cut >= 0 ? body.slice(cut + 1) : body).replace(RP_HEAD_DECORATION, '').trim();
  return (clause + closers).slice(-80);
}

/**
 * 硬判据：整条回复的**句末标点**里含问号。
 *
 * 用「含」而不是「以…结尾」：`真的吗？！` 的句末是感叹号，但它是问句
 * 这类混排标点在对话里很常见，按「含问号」判定更贴近人读到的结论。
 * 注意这里必须看**标点**而不是 `rpLastClause`：小句切分会把逗号也算切分点，
 * 而判决只关心「这段文字结束时是不是一个问号」。
 */
export function rpEndsWithQuestion(text: string): boolean {
  const t = stripTailDecoration(text);
  if (!t) return false;
  const m = t.match(RP_TRAILING_TERMINATORS);
  return !!m && /[？?]/.test(m[1]);
}

/**
 * 最后有没有句末标点。
 *
 * 为什么要单列：硬判据只看句末标点，整段不写标点时**必然**判成「非问句」。
 * 扫描脚本用它把这类样本单独计数（判据盲区），免得把盲区算成「模型变好了」。
 */
export function rpHasTerminalPunctuation(text: string): boolean {
  return !!stripTailDecoration(text).match(RP_TRAILING_TERMINATORS);
}

/**
 * 「征询标记」：把决定权交回对方的话头。
 * 简繁同列（`[还還]`/`[说說]`/`[什甚][么麼]`…）是必须的：本判据要同时服务 zh / zh-TW / en，
 * 而 zh-TW 的正文是繁体（`toZhTw` 在提示词与回复两侧都会转）。
 */
const ASK_MARK = /(?:要不要|想不想|[愿願]不[愿願]意|[还還]想|有没有|有沒有|要不|用不用|想跟我|想和我|要跟我|对我[说說]|[有冇][什甚][么麼]|想[说說][什甚][么麼]|要[说說][什甚][么麼]|想[说說]的|想[聊講讲]的|want to|would you like|do you want|anything else|is there (?:any|something))/;

/**
 * 「继续说」类动词组。
 * 用反向引用 `([说說讲講谈談聊])\1` 一次覆盖 说说/說說/讲讲/講講/谈谈/談談/聊聊（含繁简），
 * 再补上「多说 / 再说 / 多说点 / 聊下去 / 聊一聊 / 继续 / 接着说」这些常见组合。
 * 刻意**不收单字**「说 / 聊」：那会让「他说了什么？」这种普通问句大面积误判。
 */
const MORE_MARK = /(?:([说說讲講谈談聊])\1|多[说說聊講讲]|再[说說聊講讲]|继[续續][说說聊講讲]?|接着[说說聊講讲]?|[说說聊講讲]下去|[说說聊講讲][点點些]|[说說聊講讲]的|陪我说|陪我聊|tell me more|say more|talk more|talk about|keep (?:talking|going)|continue|carry on|share more|share (?:it )?with me)/;

/** 命令式「重复一遍」不是征询继续（「你再说一遍？」是要求复述，不是问你还要不要说） */
const REPEAT_REQUEST = /(再说一遍|再說一遍|再说一次|再說一次|重复一遍|重複一遍|重说一遍)/;

/**
 * 启发式判据：结尾是在**征询对方是否继续 / 邀请对方多说**（把话头交回用户）。
 * 命中条件 = 最后一个小句里命中「继续说类动词」**且**（命中「征询标记」或是问句）
 * 单靠任一边都会大面积误判。
 */
export function rpIsContinuationAsk(text: string): boolean {
  const s = rpLastClause(text);
  if (!s) return false;
  if (REPEAT_REQUEST.test(s)) return false;
  if (!MORE_MARK.test(s)) return false;
  return ASK_MARK.test(s) || /[？?]/.test(s);
}

/** 收尾形态（`continuation_ask` 优先于 `question`：它更有信息量，也包含问句那一类） */
export function rpEndingKind(text: string): RpEndingKind {
  if (rpIsContinuationAsk(text)) return 'continuation_ask';
  if (rpEndsWithQuestion(text)) return 'question';
  return 'statement';
}

/**
 * 最近 n 条 AI 回复的收尾形态（新的在后）。
 * 给「形态刹车」用：上一轮已经是问句 / 征询继续时，本轮不该再落同一类。
 * 传进来的历史可以是任意 `{role, content}` 序列（前后端两处形状不同，这里不挑形状）。
 */
export function rpRecentEndingKinds(
  messages: Array<{ role?: string; content?: string | null }> | null | undefined,
  n = 2,
): RpEndingKind[] {
  const ai = (messages || [])
    .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .slice(-Math.max(1, n));
  return ai.map((m) => rpEndingKind(String(m.content)));
}
