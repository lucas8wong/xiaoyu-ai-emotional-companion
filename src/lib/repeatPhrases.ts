/**
 * 「本轮禁止复现」的句级证据抽取：纯模块、零依赖、前后端共用。
 *
 * ## 为什么要抽成独立模块（2026-09-19）
 * 这套判据原本长在 `api/services/roleplay.ts` 里（剧情演绎专用，2026-09-17 上线，已验证有效）。
 * 现在「聊一聊」也要用，而且它的病和剧情**不是同一种**：
 *   · 剧情：**长模板复用**（同一套描写骨架反复回填，跨轮最长公共子串 30–60 字）；
 *   · 聊一聊：**短句/口头禅复用**（「我在呢，想说点什么的时候慢慢说。」这类 3–12 字的空表态句
 *     连着几轮出现），剧情那套阈值（中文 12 字起）**根本抓不到**它。
 * 判据写两份必然漂移（项目已有同类教训，见 `rpWriteGuard.ts` 开篇），所以把三类通用证据抽到这里，
 * 由调用方用参数表达自己的病：剧情走默认值（行为与 2026-09-17 版**逐字一致**），
 * 聊一聊开 `includeShort` + 降阈值（见 `api/services/chatVoice.ts`）。
 *
 * ## 四类证据（全部可判定，不依赖模型自省）
 *   ① 落点：最近 `tailCount` 条的**收尾句**，跨轮复读最常发生的地方；
 *   ② 原句：窗口内**逐字重复**的整句（出现在 ≥2 条不同回复里）；
 *   ③ 模板：相邻两条之间的**最长公共子串**（≥ 阈值才算），抓「换个词把同一句骨架再说一遍」；
 *   ④ 短句口癖（`includeShort`，聊一聊专用）：窗口内**反复出现的短语**（出现在 ≥2 条不同回复里）。
 *
 * ## 为什么负例必须是**逐字原文**（2026-09-17 回退教训，别再改回去）
 * 我曾把清单里的称呼剥掉，结果「daddy 陪着你」被剥成「陪着你」、模型认不出那是自己写过的一句，
 * 负例的约束力反而更弱。**抽取只做切分与去重，绝不改写、绝不剥称呼。**
 *
 * ## 为什么有条数上限与长度上限
 * 负例块自己也是提示词：条目太多、单条太长就会变成新的噪声源，反把模型带偏。
 * 所以「被更长的条目包含」的直接丢掉，条数 ≤ `max`、单条 ≤ `capLen`。
 */

/** 语言（与剧情 RPLang 同形：zh=简体、zh-TW=繁体、en=英文） */
export type RepeatLang = 'zh' | 'zh-TW' | 'en';

export interface AvoidPhraseOptions {
  lang?: RepeatLang;
  /** 清单条数上限（默认 3） */
  max?: number;
  /** ②③ 的片段门槛（中文 12 字 / 英文 25 字符），聊一聊降到 8 / 18 */
  minLen?: number;
  /** 单条截断长度（中文 44 字 / 英文 80 字符） */
  capLen?: number;
  /** ① 落点句的最低长度（中文 6 字 / 英文 12 字符）：太短的一句（「嗯。」）当负例没有约束力 */
  tailMinLen?: number;
  /** ① 取最近几条的落点（默认 2；聊一聊 = 1，因为它的每条回复几乎就是一句收尾） */
  tailCount?: number;
  /** ④ 是否启用「短句口癖」这一路（默认 false：剧情用它会把 7 字级普通承接句误判成模板） */
  includeShort?: boolean;
  /** ④ 最多抽几条短句（默认 2） */
  shortMax?: number;
  /** ④ 短语最短长度（中文按字，默认 3；英文按词，默认 2） */
  shortMinLen?: number;
  /** ④ 短语最长长度（中文按字，默认 12；英文按词，默认 4） */
  shortMaxLen?: number;
  /** ④ 看最近几条回复（默认 6） */
  shortWindow?: number;
  /** ④ 至少出现在几条**不同**回复里才算口癖（默认 2） */
  shortMinCount?: number;
  /**
   * ①②③ 的证据窗口：只看最近几条 AI 回复（默认 3，与 2026-09-17 版逐字一致）。
   *
   * 为什么剧情要把它调大（2026-09-20 审阅取证）：窗口 3 会让**跨轮复读的第二段**逃掉
   * 句式模板的复发距离远超 3 条（真实会话里 turn 64 还在复用 turn 12 的骨架），
   * 于是「同一套骨架换个词回填」刚好落在窗口外，清单里永远只有最近 3 条的那一小撮。
   * 聊一聊维持 3（它的病是短句口癖，④ 另有 `shortWindow`，与这里无关）。
   */
  window?: number;
}

/** 切句：句末标点与换行都算边界（与剧情版一致） */
export function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/[。！？!?…\n]+/)
    // ⚠️ 只收拾两端的括号与空白，**不动句内的空格**：英文负例被压成 "Come,press…" 就没法认了
    .map((s) => trimResidue(s.replace(/\s+/g, ' ')))
    .filter(Boolean);
}

/** 去掉片段两端的括号/标点残渣（只动标点与两端空白，词句保持原样） */
export function trimResidue(s: string): string {
  return String(s || '')
    .replace(/^[\s。）)」』”"'（(「『【[]+/, '')
    .replace(/[\s（(「『【[」』】\]）)】”"']+$/, '')
    .trim();
}

/**
 * 最长公共子串（只用于找「模板复用」的证据，字符串长度都在几百以内，直接 DP）。
 * 比较时忽略空白，但**返回原文片段（保留原有空格）**，英文如果把空格一起吃掉，
 * 负例会变成 "Come,presstheir…" 这种读不出来的串，模型认不出那是自己写过的一句。
 */
export function longestCommonSpan(a: string, b: string): string {
  const sa = String(a);
  const A = sa.replace(/\s+/g, ''), B = String(b).replace(/\s+/g, '');
  if (!A || !B) return '';
  // 归一化下标 → 原文下标，用于把结果还原成原文
  const map: number[] = [];
  for (let i = 0; i < sa.length; i++) if (!/\s/.test(sa[i])) map.push(i);
  let best = 0, end = 0;
  const prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) { best = cur[j]; end = i; } }
    }
    for (let j = 0; j <= B.length; j++) prev[j] = cur[j];
  }
  if (!best) return '';
  const rawStart = map[end - best], rawEnd = map[end - 1];
  return (rawStart === undefined || rawEnd === undefined)
    ? A.slice(end - best, end)
    : sa.slice(rawStart, rawEnd + 1);
}

/**
 * ④ 短句口癖的候选：把一段文字切成「可滑窗的 token 序列」。
 * 统一返回 `string[][]`，每个内层数组是一段**可滑窗的 token 列表**：
 * 中文是单字、英文是单词。上层的滑窗逻辑因此只有一份（中文 char 滑窗 / 英文 n-gram 滑窗）。
 * 标点与 emoji 天然成为边界（「我在呢，陪着你」→ 两段：「我在呢」「陪着你」），
 * 所以跨标点拼出来的假短语（「呢陪」）不会进候选。
 */
function shortSegments(text: string, en: boolean): string[][] {
  if (en) {
    const words = String(text || '').match(/[A-Za-z']+/g) || [];
    return words.length ? [words] : [];
  }
  const segs = String(text || '').match(/[\u4e00-\u9fffA-Za-z0-9]+/g) || [];
  return segs.map((s) => Array.from(s));
}

/**
 * ④ 短句口癖：窗口内**反复出现**的短语。
 *
 * 为什么需要它：剧情那套阈值抓的是「12 字以上的模板」，而聊一聊的病是 3–12 字的短句
 * （「我在呢」5 字，阈值怎么调都漏）。这里改判据不靠长度，靠**复现次数**
 * 同一个短语出现在 ≥2 条不同回复里，就是口癖，跟它多长没关系。
 *
 * 取「最长优先」而不是「全部」：把「我在呢」和它的碎片一起列出来会让清单自己变噪声，
 * 而且极短碎片（「我在」）没有约束力。所以先按长度降序，只保留不被更长条目包含的那些。
 *
 * 导出给全站扫描脚本 `scripts/chat-voice-scan.mts` 用（它要按会话统计「同一个短语被复用了几次」，
 * 用的必须是同一份判据，否则扫描说一套、提示词禁另一套，两边对不上账）。
 */
export function collectShortTics(texts: string[], lang: RepeatLang, opts: AvoidPhraseOptions = {}): string[] {
  const en = lang === 'en';
  const minLen = opts.shortMinLen ?? (en ? 2 : 3);
  const maxLen = opts.shortMaxLen ?? (en ? 4 : 12);
  const minCount = opts.shortMinCount ?? 2;
  const shortMax = opts.shortMax ?? 2;
  if (texts.length < Math.max(2, minCount)) return [];

  // 每条回复各自出候选（同一句里出现两次不算口癖：那是同一条回复内部的重复，由 ② 管）
  const perMsg: Set<string>[] = texts.map(() => new Set<string>());
  const df = new Map<string, number>();
  const push = (msgIdx: number, cand: string) => {
    if (perMsg[msgIdx].has(cand)) return;
    perMsg[msgIdx].add(cand);
    df.set(cand, (df.get(cand) || 0) + 1);
  };

  texts.forEach((text, i) => {
    for (const tokens of shortSegments(text, en)) {
      for (let s = 0; s + minLen <= tokens.length; s++) {
        for (let len = minLen; len <= maxLen && s + len <= tokens.length; len++) {
          const slice = tokens.slice(s, s + len);
          const cand = (en ? slice.join(' ') : slice.join('')).trim();
          if (cand.length >= minLen) push(i, cand);
        }
      }
    }
  });

  const ranked = [...df.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => (b[0].length - a[0].length) || (b[1] - a[1]));
  const kept: string[] = [];
  for (const [cand] of ranked) {
    if (kept.some((k) => k.includes(cand))) continue;
    kept.push(cand);
    if (kept.length >= shortMax) break;
  }
  return kept;
}

/**
 * 抽取「本轮禁止复现」的句子清单（优先级：落点 → 逐字重复 → 模板片段 → 短句口癖）。
 * 没有可抽取的证据时返回空数组（**不要**注入空噪声）。
 */
export function collectAvoidPhrases(
  history: Array<{ role?: string; content?: string | null }> | null | undefined,
  opts: AvoidPhraseOptions = {},
): string[] {
  const lang: RepeatLang = opts.lang === 'en' ? 'en' : 'zh';
  const en = lang === 'en';
  const max = opts.max ?? 3;
  const minLen = opts.minLen ?? (en ? 25 : 12);
  const capLen = opts.capLen ?? (en ? 80 : 44);
  const tailMinLen = opts.tailMinLen ?? (en ? 12 : 6);
  const tailCount = Math.max(1, opts.tailCount ?? 2);
  const window = Math.max(2, opts.window ?? 3);

  const aiTexts = (history || [])
    .filter((m): m is { role: string; content: string } => !!m && m.role === 'assistant' && typeof m.content === 'string' && !!m.content.trim())
    .map((m) => m.content);
  const recent = aiTexts.slice(-window);
  if (!recent.length) return [];

  /**
   * ① 落点（保底，先占位），**不参与下面的强度排序**。
   * 为什么单独留槽位：落点是**结构性**证据（跨轮复读最常发生在收尾处），它常常很短
   * （「别急，莺莺。」），一旦和「长句/重复句」放在一起按长度排序就会被挤掉；
   * 而 `tailCount` 这条口径被回归测试与三语文案依赖，不能随窗口/条数一起漂移。
   */
  const picked: string[] = [];
  const tails: string[] = [];
  for (const t of recent.slice(-tailCount)) {
    const sents = splitSentences(t);
    const tail = sents[sents.length - 1];
    if (tail && tail.length >= tailMinLen) { picked.push(tail); tails.push(tail); }
  }

  /**
   * ② 窗口内逐字重复的整句，**按「复现次数 × 长度」排序**（2026-09-20 审阅取证后新增排序）。
   *
   * 为什么必须排序、不能按插入顺序（这次的实测结论，别改回去）：
   *   旧实现把 ①②③ 按顺序拼进同一个数组，再由末尾 `slice(0, max)` 截断
   *   于是**永远**是「2 条落点 + 1 条最长片段」，重复句一条都进不去。
   *   真实线上数据量到的后果（`data/xiaoyu.sqlite` 近 7 天，1264 个 AI 轮次；
   *   对跑脚本 `temp/rp-pref-audit/verify-shipped.mts`，新旧口径跑同一份数据）：
   *     有逐字重复的轮次里，只有 **41.8%** 被清单点到名；重复句命中率 **14.9%**；
   *     单轮最多有 17 句逐字重复（cf8077d3 的「民国背德」），清单却只点名其中 **1** 句。
   *   换成「复现次数优先」排序并放大条数与窗口（剧情侧 max=12 / window=12）后：
   *     覆盖 41.8%→**61.2%**、命中率 14.9%→**40.7%**（清单 42→77 字/轮）。
   *   排序键用 `n * (len + 8)`：次数是主因（出现 3 次的一定比 2 次的更该点名），
   *   长度是次因（长句被「换个字重说一遍」时携带的重复内容更多，拦它的收益更大）。
   */
  const counts = new Map<string, number>();
  for (const t of recent) {
    for (const s of new Set(splitSentences(t))) {
      if (s.length >= minLen) counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  const dupes = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([s, n]) => ({ s, score: n * (s.length + 8) }))
    .sort((a, b) => b.score - a.score || b.s.length - a.s.length)
    .map((x) => x.s);
  picked.push(...dupes);

  // ③ 相邻两条之间的最长公共子串（模板复用），长的优先
  const spans: string[] = [];
  for (let i = 1; i < recent.length; i++) {
    const span = longestCommonSpan(recent[i - 1], recent[i]);
    if (span.length >= minLen) spans.push(span);
  }
  spans.sort((a, b) => b.length - a.length);
  picked.push(...spans);

  // ④ 短句口癖（聊一聊专用，默认关），**单独一路**，见下面的去重说明
  const shortTics = opts.includeShort
    ? collectShortTics(aiTexts.slice(-(opts.shortWindow ?? 6)), lang, opts).map(trimResidue).filter(Boolean)
    : [];

  /**
   * 去重与排序（2026-09-19 实测后改过一次，别改回去）：
   *   · 句子类证据（①②③）维持原口径，被更长条目包含的直接丢掉，避免清单自己变成噪声源；
   *   · 但**短句口癖豁免包含规则**，而且排在前面。
   * 为什么：真机请求体里实测到「我在呢，你别急」把「我在呢」吃掉了（前者包含后者），
   * 于是清单里只剩一句「别复述那句话」，而真正要治的「同一个口头禅又端上来了」反而没被点名。
   * 这是两件事：长句负例管**别复述那句话**，短句负例管**别把同一个口头禅再用一次**。
   * （剧情不开 `includeShort` 时 `shortTics` 为空 → `out` 与老实现逐字相同，行为不变。）
   *
   * ⚠️ 2026-09-20 追加：**落点句豁免「被更长条目吃掉」，但同样受上限约束**。
   * 上面的包含规则对落点会反噬：当最近一条的收尾句整段落在某条更长的重复句里时，
   * 落点被吸收 → 唯一的收尾形态证据消失。落点现在直接进清单，长条目另占一个名额。
   * 但**必须先截断到 `capLen`**：否则一条长落点会绕过单条上限（回归测试
   * `roleplayAntiRepeat.test.ts` 的「单条 ≤44 字」当场抓到过，别把截断只留在最后的 map 里，
   * 那时它已经被下面的包含判断当成「长条目」用过了）。
   */
  /**
   * 去重（含入规则）：以**强度**（复现次数 × 长度）裁决，而不是以「谁更长」裁决。
   *
   * 为什么不能用长度裁决（2026-09-20，被新加的「不得互相包含」断言当场抓到）：
   *   落点句是「短而固定」的（如「等你一下就好」），而相邻两条之间的公共片段可能很长且**恰好包含**它。
   *   若按长度裁决，长片段会把落点**吸收**进自己，结果两条清单项互相包含（`a.includes(b)` 与
   *   `b.includes(a)` 同时成立），既违反清单不变量，也和「落点是保底槽位」的设计自相矛盾。
   *   改成强度足够高才允许吸收，落点这种短句就不会被「顺手吞掉」；
   *   而未排序、同长度的老用例（`daddy 陪着你` / `daddy 会一直这样抱着你…`）仍按原口径
   *   由后一条吸收前一条，这正是回归测试 `负例用逐字原文` 依赖的行为。
   */
  const clip = (s: string) => (s.length > capLen ? s.slice(0, capLen) : s);
  const tailSet = new Set(tails.map(trimResidue).filter(Boolean).map(clip));
  const strength = (s: string) => (counts.get(s) || 1) * (s.length + 8);
  /**
   * 落点是**保底槽位**：任何把落点整句包进去的更長条目都丢掉，而不是让落点被吸收。
   * 理由与槽位设计同一个：落点短、固定、按轮生成，一旦被长条目吞掉，「收尾形态」这类结构证据就消失了；
   * 而包含它的那条长片段**已经**把落点内容覆盖在内，模型照样看得到（只是不再单列）。
   */
  const candidates = picked.map(trimResidue).filter(Boolean).map(clip)
    .filter((p) => !tailSet.has(p) && ![...tailSet].some((t) => p.includes(t)));
  const sentenceUniq: string[] = [...tailSet];
  for (const p of candidates) {
    // 已有条目包含本条：强度更高者留（同强度时保留原有条目，与旧口径一致）
    const owner = sentenceUniq.find((u) => u.includes(p));
    if (owner) { if (strength(p) > strength(owner)) sentenceUniq[sentenceUniq.indexOf(owner)] = p; continue; }
    // 本条包含某个已有条目：只有强度更高时才吸收，否则两条并存（会造成互相包含）
    const idx = sentenceUniq.findIndex((u) => p.includes(u));
    if (idx >= 0) {
      if (strength(p) > strength(sentenceUniq[idx])) sentenceUniq[idx] = p;
      else if (!sentenceUniq.some((u) => u.includes(p))) sentenceUniq.push(p);
      continue;
    }
    sentenceUniq.push(p);
  }
  const out: string[] = [];
  for (const t of shortTics) if (!out.includes(t)) out.push(t);
  for (const p of sentenceUniq) if (!out.includes(p)) out.push(p);
  return out.slice(0, max).map((s) => (s.length > capLen ? s.slice(0, capLen) : s));
}
