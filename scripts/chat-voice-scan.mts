/**
 * 聊一聊「人机感 / 复读」全站扫描（**只读**）
 *
 * 为什么要有它（2026-09-19 用户口径）：
 *   「小愈经常说类似『我在呢，想说点什么的时候慢慢说。』，这也太人机了……让小愈不管在哪种陪伴模式下
 *    都更像正常 18 到 26 岁人类会说话的方式」。
 *   上一次做同类收敛（`scripts/rp-ending-scan.mts`，治「结尾老问『想跟我多说点？』」）的教训写得很清楚：
 *   **改提示词之前必须先知道真实比例与分布**，否则只能照着一个用户看到的几句话去改，那正是 overfit。
 *
 * 它给出四件事，全部来自线上真实数据：
 *   ① 基线：AI 回复的长短分布 + 「空表态短句率」（只有表态、不接具体内容的短回复占比）；
 *   ② 形态：「连续两条都是空表态短句」在多少段会话里发生过（这正是本轮加的「填空刹车」要治的）；
 *   ③ 口癖榜：**同一个短语在一段会话里被反复用了多少条回复**（判据与提示词共用 `collectShortTics`，
 *      避免「扫描说一套、提示词禁另一套」）；
 *   ④ 分布：按**陪伴方式**（hug/ally/clarify/light/objective，2026-09-23 起用户侧档位已退场，
 *      该维度只反映**历史数据**里用户当时选的档位）与**按用户**分档，用来判断
 *      「是不是某一种模式、或某一个人的毛病」，而不是普遍习惯。
 *   ⑤ 探针（`--probe=<正则>`，2026-09-23 加）：只盯用户投诉的那**一句**具体的话（如「我接住了」），
 *      给出命中数 + 样本。它是**描述性**的：命中 0 只说明那一句没了，**不能**拿来宣称"人机感改好了"。
 *   改完之后用同一命令再跑一次（基线建议带 `--until`），两份 JSON 一比就是前后对比。
 *
 * 用法：
 *   npx tsx scripts/chat-voice-scan.mts                        # 全站聊一聊（已排除测试/开发身份）
 *   npx tsx scripts/chat-voice-scan.mts --until 2026-09-19     # 只统计这一天之前的回复（改版前基线）
 *   npx tsx scripts/chat-voice-scan.mts --since 2026-09-01
 *   npx tsx scripts/chat-voice-scan.mts --user <userId>        # 单用户逐会话明细
 *   npx tsx scripts/chat-voice-scan.mts --json temp/chat-voice-baseline.json
 *   npx tsx scripts/chat-voice-scan.mts --probe "我把?你?接住了|接住你了"   # 只盯这一句（描述性）
 *   npx tsx scripts/chat-voice-scan.mts --shapes 0             # 不打印高频短句榜
 *   npx tsx scripts/chat-voice-scan.mts --include-test         # 也收测试/开发身份（仅自测）
 *
 * 数据源：`data/xiaoyu.sqlite` 的 kv 表（`sessions.json` = 聊一聊会话，`preferences.json` = 陪伴方式）。
 * **全程 readonly 打开，不写任何东西。**
 *
 * 剔除口径（如实计数、不静默丢）：
 *   · 系统/兜底文案（`src/lib/fallbackBubbles.ts` 那张表），它按红线 6 本就不该出现在业务消息里，
 *     混进统计会把「系统的毛病」说成「模型的习惯」；
 *   · 上游退化输出（整条 ≤3 字残渣，或同一个小句在正文里出现 ≥3 次的自循环复读）。
 *
 * 隐私：默认只打印聚合数字与 8 位 user 前缀。榜单打的是**短语本身**（不含任何身份、不关联到人）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { rpEndingKind, rpLastClause, type RpEndingKind } from '../src/lib/rpEnding.js';
import { collectShortTics } from '../src/lib/repeatPhrases.js';
import { isFallbackBubble } from '../src/lib/fallbackBubbles.js';
import { CHAT_REDIRECT_GUIDE } from '../api/services/prompts.js';
import { hasCjk } from '../api/services/zhConvert.js';
import { chatIsShortReply } from '../api/services/chatVoice.js';
import { isTestAccount, isDeveloperAccount } from '../api/services/accountFilters.js';

const argv = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (name: string): boolean => argv.includes('--' + name);

const since = arg('since') ? new Date(arg('since') + 'T00:00:00+08:00').getTime() : 0;
/** 只统计这条线**之前**的回复：改版后跑基线要带它，否则新数据会把基线冲淡 */
const until = arg('until') ? new Date(arg('until') + 'T00:00:00+08:00').getTime() : Infinity;
const onlyUser = arg('user');
const includeTest = has('include-test');
const shapeCount = arg('shapes') === '' ? 15 : Number(arg('shapes'));
const jsonOut = arg('json');
/**
 * `--probe=<正则>`：**描述性**字面探针（2026-09-23 加）。
 * 用途：用户投诉了某一句具体的话（如「行，我接住了」）时，量"这一句在真实回复里还在不在"。
 * 口径与 `LITERAL_TIC` 完全一致：只证明**那一句**，不能拿来宣称整体人机感改好了。
 */
const probeRaw = arg('probe');
let probeRe: RegExp | null = null;
if (probeRaw) {
  try { probeRe = new RegExp(probeRaw, 'i'); }
  catch (e) { console.error('--probe 不是合法正则：' + probeRaw + '（' + (e as Error).message + '）'); process.exit(1); }
}

const DB_PATH = path.join(process.cwd(), 'data', 'xiaoyu.sqlite');
if (!fs.existsSync(DB_PATH)) {
  console.error('找不到 ' + DB_PATH + '（本机数据在 sqlite 里；data/*.json 是旧副本，读数会假）');
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
const kv = <T>(key: string): T | null => {
  const row = db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
  try { return row ? (JSON.parse(row.value) as T) : null; } catch { return null; }
};

/** 时间戳两种形态混存（数字毫秒 / ISO 字符串），统一归一化，同 rp-ending-scan.mts 的踩坑说明 */
function tsOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}
const dayOf = (ms: number): string => (Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) : '未知日期');

/** 测试/开发身份（复用既有判据，不在这里另写一份正则） */
const isTestIdentity: (userId: string) => boolean = (() => {
  const accounts = kv<Array<{ userId?: string; username?: string | null; email: string }>>('accounts.json') || [];
  const byId = new Map<string, { username?: string | null; email: string }>();
  for (const a of accounts) if (a && typeof a.userId === 'string') byId.set(a.userId, a);
  return (userId: string): boolean => {
    if (/^test-|^dev-/i.test(userId)) return true;
    const acc = byId.get(userId);
    return !!acc && (isTestAccount(acc) || isDeveloperAccount(acc));
  };
})();

/** 陪伴方式（preferences.json 是数组；无记录的用户按默认 hug，与 preferences.ts 的归一化一致） */
const MODE_OF: (userId: string) => string = (() => {
  const prefs = kv<Array<{ userId?: string; mode?: string }>>('preferences.json') || [];
  const byId = new Map<string, string>();
  for (const p of prefs) if (p && typeof p.userId === 'string') byId.set(p.userId, String(p.mode || 'hug'));
  return (userId: string): string => byId.get(userId) || 'hug';
})();

const MODE_LABEL: Record<string, string> = {
  hug: '接住我', ally: '挺我一下', clarify: '帮我理清', light: '轻一点看', objective: '客观看看',
};

/**
 * 「我在」这一族的两个**描述性**判据（2026-09-19）。
 *
 * 为什么要单列：用户投诉的就是这个字面组合，线上实测占 23.2%（13/56），这是最直接的前后对比读数。
 * 但**决策指标不是它**：写死一个短语只能盯住一个人看到的那一句（`src/lib/rpEnding.ts` 开篇同一条教训）。
 * 所以报告里字面与家族分成两行，且明确标注为「描述性」；真正决定"改好没有"的是上一条结构指标。
 */
const LITERAL_TIC = /我在呢|慢慢说/;
const FAMILY_TIC = /我在呢|慢慢说|我在这儿|我就在这里|我一直在|我在的|在的[。，！]|不着急|别急/;

/**
 * 系统引导类文案（**不是模型生成的**）：`prompts.ts` 里那几个常量，命中即整条剔除。
 *
 * 首跑基线时没剔它，榜单上立刻冒出「聊一聊」「换个身份」「要不要」「的角色」四个"高频短句"
 * 全是从「角色扮演指令分流引导语」那几条常量里来的。它们跟小愈怎么说话毫无关系，
 * 混进去就是把**代码里的常量**说成**模型的习惯**（与 rp-ending-scan 剔除剧本开场白是同一类踩坑）。
 */
const CANNED = new Set<string>(
  Object.values(CHAT_REDIRECT_GUIDE).flatMap((m) => Object.values(m)).map((t) => String(t).trim()),
);

interface Reply {
  userId: string;
  sessionKey: string;
  day: string;
  mode: string;
  lang: 'zh' | 'en';
  chars: number;
  ending: RpEndingKind;
  /** 空表态短句：很短 + 陈述收尾（判据与提示词共用 `chatIsShortReply`，不另写一套阈值） */
  filler: boolean;
  /** 这是本段会话的第几条 AI 回复（首轮是最容易翻车的地方，单列出来） */
  turn: number;
  /** **描述性**指标：含用户投诉的字面组合（我在呢／慢慢说） */
  literalTic: boolean;
  /** **描述性**指标：「我在」这一族（含 我在这儿／我就在／我在的／在的。／不着急／别急） */
  familyTic: boolean;
  /** **描述性**指标：命中 `--probe` 给的正则（默认关）；同样是"只盯这一句"，不代表整体 */
  probeHit: boolean;
}
interface SessionAgg {
  key: string;
  userId: string;
  mode: string;
  replies: number;
  fillers: number;
  /** 连续两条 filler 出现的次数 */
  fillerPairs: number;
  chars: number;
  /** 会话内被反复使用的短句 → 它出现在几条不同回复里（门槛：≥3 条） */
  tics: Map<string, number>;
}

const allReplies: Reply[] = [];
const sessionAggs: SessionAgg[] = [];
/** `--probe` 命中的原文样本（只用于打印，最多 200 条） */
const probeSamples: { day: string; mode: string; text: string }[] = [];
const excluded = { fallback: 0, canned: 0, degenerate: 0 };
let rawAssistant = 0;

const records = kv<any[]>('sessions.json') || [];
for (const s of records) {
  const userId = String(s?.userId || '');
  if (!userId) continue;                    // 无主遗留会话不计（归因不明）
  if (onlyUser && !userId.startsWith(onlyUser)) continue;
  if (!includeTest && isTestIdentity(userId)) continue;
  const msgs = Array.isArray(s?.chatMessages) ? s.chatMessages : [];
  const fallbackTs = s.updatedAt || s.createdAt || 0;
  const sessionKey = userId + '::' + String(s.sessionId || s.id || 'chat');

  // 语言：整段会话按正文脚本判（聊一聊会跟随用户输入，逐条判会把中英夹杂的会话切碎）
  const joined = msgs.filter((m: any) => m?.role === 'assistant').map((m: any) => String(m?.content || '')).join(' ');
  const lang: 'zh' | 'en' = hasCjk(joined) ? 'zh' : 'en';

  const replies: Reply[] = [];
  const texts: string[] = [];
  for (const m of msgs) {
    if (m?.role !== 'assistant') continue;
    const content = String(m?.content || '');
    if (content.trim().length < 2) continue;
    rawAssistant += 1;
    const own = tsOf(m?.timestamp);
    const ts = Number.isFinite(own) ? own : tsOf(fallbackTs);
    if (since && Number.isFinite(ts) && ts < since) continue;
    if (Number.isFinite(ts) && ts > until) continue;
    // 剔除①：系统/兜底文案（红线 6 的同类：它不是角色说的话）
    if (isFallbackBubble(content)) { excluded.fallback += 1; continue; }
    // 剔除②：代码里的常量（分流引导语），同上，不是模型生成的
    if (CANNED.has(content.trim())) { excluded.canned += 1; continue; }
    // 剔除③：上游退化输出（整条残渣 / 自循环复读），判据与 rp-ending-scan 一致
    const tail = rpLastClause(content);
    const repeats = tail.length >= 2 ? content.split(tail).length - 1 : 0;
    if (content.trim().length <= 3 || repeats >= 3) { excluded.degenerate += 1; continue; }

    const ending = rpEndingKind(content);
    texts.push(content);
    const probeHit = probeRe ? probeRe.test(content) : false;
    if (probeHit && probeSamples.length < 200) probeSamples.push({ day: dayOf(ts), mode: MODE_OF(userId), text: content });
    replies.push({
      userId, sessionKey, day: dayOf(ts), mode: MODE_OF(userId), lang,
      // 长度一律用「去标点的内容字数」，与 `chatIsShortReply` 同一把尺子，否则阈值对不上账
      chars: content.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length,
      ending,
      filler: ending === 'statement' && chatIsShortReply(content, lang),
      turn: replies.length + 1,
      literalTic: LITERAL_TIC.test(content),
      familyTic: FAMILY_TIC.test(content),
      probeHit,
    });
  }
  if (!replies.length) continue;

  // 会话内口癖：同一短语出现在 ≥3 条不同回复里（门槛比提示词的 2 条更严，这里要的是「严重到什么程度」）
  const tics = new Map<string, number>();
  for (const t of collectShortTics(texts, lang, {
    shortMinCount: 3, shortMax: 8, shortWindow: texts.length, shortMinLen: 3, shortMaxLen: 12,
  })) {
    tics.set(t, texts.filter((x) => x.includes(t)).length);
  }
  let fillerPairs = 0;
  for (let i = 1; i < replies.length; i++) if (replies[i].filler && replies[i - 1].filler) fillerPairs += 1;

  allReplies.push(...replies);
  sessionAggs.push({
    key: sessionKey, userId, mode: replies[0].mode, replies: replies.length,
    fillers: replies.filter((r) => r.filler).length, fillerPairs,
    chars: replies.reduce((a, r) => a + r.chars, 0), tics,
  });
}
db.close();

if (!allReplies.length) {
  console.log('没有符合条件的 AI 回复（检查 --since / --until / --user 参数）');
  process.exit(0);
}

// 【聚合】
const pct = (n: number, d: number): string => (d ? (100 * n / d).toFixed(1) + '%' : '—');
const quantile = (arr: number[], p: number): number => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
const sortedChars = allReplies.map((r) => r.chars).sort((a, b) => a - b);
const totalChars = allReplies.reduce((a, r) => a + r.chars, 0);
const fillers = allReplies.filter((r) => r.filler).length;
const tiny = allReplies.filter((r) => r.chars <= 12).length;
const short = allReplies.filter((r) => r.chars <= 24).length;

interface Bucket { total: number; chars: number; filler: number; tiny: number }
const empty = (): Bucket => ({ total: 0, chars: 0, filler: 0, tiny: 0 });
function add(b: Bucket, r: Reply): void {
  b.total += 1; b.chars += r.chars;
  if (r.filler) b.filler += 1;
  if (r.chars <= 12) b.tiny += 1;
}
const byMode = new Map<string, Bucket>();
const byDay = new Map<string, Bucket>();
const byUser = new Map<string, Bucket>();
const byLang = new Map<string, Bucket>();
for (const r of allReplies) {
  for (const [map, key] of [
    [byMode, r.mode], [byDay, r.day], [byUser, r.userId.slice(0, 8)], [byLang, r.lang],
  ] as Array<[Map<string, Bucket>, string]>) {
    const b = map.get(key) || empty();
    add(b, r);
    map.set(key, b);
  }
}

/** 高频短句榜（**跨会话**）：某个短语在多少段会话里达到了「同段被复用 ≥3 条回复」的门槛 */
const ticBoard = new Map<string, { sessions: number; maxDf: number }>();
for (const s of sessionAggs) {
  for (const [t, df] of s.tics) {
    const cur = ticBoard.get(t) || { sessions: 0, maxDf: 0 };
    cur.sessions += 1;
    cur.maxDf = Math.max(cur.maxDf, df);
    ticBoard.set(t, cur);
  }
}
const ticRows = [...ticBoard.entries()]
  .filter(([, v]) => v.sessions >= 2)   // 只在单段会话里出现的属于「那一段会话的毛病」，单列在按会话榜里
  .sort((a, b) => (b[1].sessions - a[1].sessions) || (b[1].maxDf - a[1].maxDf))
  .slice(0, Math.max(0, shapeCount));

/** 按用户分布（AI 回复 ≥20 条的用户，否则比率没有意义） */
const MIN_TURNS_PER_USER = 20;
const userRates = [...byUser.values()].filter((b) => b.total >= MIN_TURNS_PER_USER)
  .map((b) => 100 * b.filler / b.total).sort((a, b) => a - b);
const perUser = {
  usersWithData: byUser.size,
  usersCounted: userRates.length,
  p50: Number(quantile(userRates, 0.5).toFixed(1)),
  p90: Number(quantile(userRates, 0.9).toFixed(1)),
  max: Number((userRates[userRates.length - 1] || 0).toFixed(1)),
};

const streakSessions = sessionAggs.filter((s) => s.fillerPairs > 0).length;
const totalFillerPairs = sessionAggs.reduce((a, s) => a + s.fillerPairs, 0);
const days = [...byDay.keys()].filter((d) => d !== '未知日期').sort();

// 【输出】
console.log('\n=== 聊一聊「人机感 / 复读」扫描（只读 ' + DB_PATH + '）===');
console.log('范围：' + (includeTest ? '含测试/开发身份' : '仅真实用户（已排除测试/开发身份）')
  + (since ? '｜自 ' + dayOf(since) : '') + (Number.isFinite(until) ? '｜至 ' + dayOf(until) : '')
  + (onlyUser ? '｜用户 ' + onlyUser : ''));
console.log('样本：原始 AI 回复 ' + rawAssistant + ' 条 → 剔除 系统/兜底文案 ' + excluded.fallback
  + ' + 代码常量（分流引导语）' + excluded.canned + ' + 上游退化 ' + excluded.degenerate
  + ' → 统计 ' + allReplies.length + ' 条｜会话 ' + sessionAggs.length + ' 段｜日期 '
  + (days[0] || '—') + ' ~ ' + (days[days.length - 1] || '—'));
console.log('口径：剔除的都不是「模型怎么说话」，兜底文案与分流引导语是系统写的（红线 6 的同类，'
  + '首跑没剔就把「代码里的常量」说成了「模型的习惯」），退化输出是上游自循环复读。');
console.log('注意：「空表态短句」是**结构代理指标**（很短 + 陈述收尾），不等于「那些条条都是空壳」，'
  + '真正的空壳要靠语义判，脚本只用**可判定**的结构做前后对比。所以它只能用来比前后，不能拿来宣称绝对值。');
console.log('阈值：很短 = 去标点后 ≤24 字（按真实分布 p10–p25 定的，见 `chatIsShortReply` 的说明；'
  + '这个产品里的「很短」是 20 字上下，不是 10 字）。');
if (allReplies.length < 200) {
  console.log('⚠️ 样本量只有 ' + allReplies.length + ' 条：够看方向，**不足以宣称降幅**。'
    + '任何「改好了 X%」的说法都要等样本积累（或看真模型 A/B 的小样本对比）。');
}

console.log('\n【总览】');
console.log('  条数                    ' + String(allReplies.length).padStart(6));
console.log('  平均字数                ' + String(Math.round(totalChars / allReplies.length)).padStart(6)
  + '   中位数 ' + (sortedChars[Math.floor(sortedChars.length / 2)] || 0));
console.log('  极短（≤12 字）           ' + String(tiny).padStart(6) + '  ' + pct(tiny, allReplies.length));
console.log('  短（≤24 字）            ' + String(short).padStart(6) + '  ' + pct(short, allReplies.length));
console.log('  空表态短句（短+陈述）   ' + String(fillers).padStart(6) + '  ' + pct(fillers, allReplies.length) + '   ← 本轮要压的指标');

/** 描述性读数：用户投诉的那个字面组合 / 同一动作家族 / 首轮 vs 之后 */
const literals = allReplies.filter((r) => r.literalTic).length;
const fams = allReplies.filter((r) => r.familyTic).length;
const probeHits = allReplies.filter((r) => r.probeHit).length;
const firstTurn = allReplies.filter((r) => r.turn === 1);
const laterTurn = allReplies.filter((r) => r.turn > 1);
console.log('  「我在呢/慢慢说」        ' + String(literals).padStart(6) + '  ' + pct(literals, allReplies.length)
  + '   ← 描述性（用户投诉的字面组合）');
console.log('  「我在」家族              ' + String(fams).padStart(6) + '  ' + pct(fams, allReplies.length)
  + '   ← 描述性（换了说法但同一动作）');
console.log('  　其中首轮              ' + String(firstTurn.filter((r) => r.familyTic).length).padStart(6)
  + '  ' + pct(firstTurn.filter((r) => r.familyTic).length, firstTurn.length)
  + '（首轮 ' + firstTurn.length + ' 条 / 之后 ' + laterTurn.length + ' 条）'
  + '   ← 首轮没有历史可抽负例，只能靠静态规则');

// `--probe` 描述性探针：只回答"用户投诉的那一句还在不在"（别拿它当整体结论）
if (probeRe) {
  console.log('  探针 /' + probeRaw + '/  ' + String(probeHits).padStart(6) + '  ' + pct(probeHits, allReplies.length)
    + '   ← 描述性（只盯这一句）');
  if (probeHits) {
    console.log('    样本（最多 5 条）：');
    for (const s of probeSamples.slice(0, 5)) console.log('      · [' + s.day + ' · ' + s.mode + '] ' + s.text.slice(0, 80));
  } else {
    console.log('    （真实回复里 0 命中；样本 ' + allReplies.length + ' 条，0 只说明这一句没出现，不等于整体改好）');
  }
}

console.log('\n【连续两条空表态短句】');
console.log('  命中会话 ' + streakSessions + ' / ' + sessionAggs.length + ' 段   出现 ' + totalFillerPairs + ' 次   ← 填空刹车要治的形态');

console.log('\n【按陪伴方式 · 历史维度】（2026-09-23 起用户侧档位已退场：该维度只反映**旧数据**里用户当时选的档位，不再影响 system；无记录按默认「接住我」）');
for (const [k, b] of [...byMode.entries()].sort((a, c) => c[1].total - a[1].total)) {
  console.log('  ' + (k + ' ' + (MODE_LABEL[k] || '')).padEnd(20) + String(b.total).padStart(6) + ' 条   空表态 '
    + pct(b.filler, b.total).padStart(6) + '   极短 ' + pct(b.tiny, b.total).padStart(6)
    + '   均字 ' + String(Math.round(b.chars / b.total)).padStart(4));
}

console.log('\n【按语言】');
for (const [k, b] of [...byLang.entries()].sort((a, c) => c[1].total - a[1].total)) {
  console.log('  ' + k.padEnd(20) + String(b.total).padStart(6) + ' 条   空表态 ' + pct(b.filler, b.total).padStart(6)
    + '   均字 ' + String(Math.round(b.chars / b.total)).padStart(4));
}

console.log('\n【按用户分布】（AI 回复 ≥' + MIN_TURNS_PER_USER + ' 条的用户，共 ' + perUser.usersCounted + '/' + perUser.usersWithData + ' 个）');
if (perUser.usersCounted === 0) {
  // ⚠️ 首跑这里打的是「p50 0% p90 0% 最高 0%」，那会被读成「空表态率是 0」，而真相是
  //    **一个用户都没达到门槛**（样本里每段会话平均不到 2 条回复）。宁可明说样本不足，也不给假读数。
  console.log('  ⚠️ 样本不足：没有任何用户达到 ≥' + MIN_TURNS_PER_USER + ' 条，**出不了用户分位**'
    + '（不是「0%」）。全站按条数加权 ' + pct(fillers, allReplies.length) + ' 条可参考，但它会被少数长会话带偏。');
  console.log('  → 用户维度的 p50/p90 要等真实数据积累后再跑同一命令；这也是「样本 56 条只能看方向」的一部分。');
} else {
  console.log('  空表态短句率 p50 ' + perUser.p50 + '%   p90 ' + perUser.p90 + '%   最高 ' + perUser.max + '%'
    + '   （对比全站按条数加权 ' + pct(fillers, allReplies.length) + '，差得越多，说明被少数用户/超长会话带偏得越厉害）');
}
const topUsers = [...byUser.entries()].filter(([, b]) => b.total >= MIN_TURNS_PER_USER)
  .sort((a, b) => b[1].filler / b[1].total - a[1].filler / a[1].total).slice(0, 8);
if (topUsers.length) {
  console.log('  最高的 8 个（user 前缀 · 条数 · 空表态率 · 均字）：');
  for (const [u, b] of topUsers) {
    console.log('    ' + u.padEnd(10) + String(b.total).padStart(5) + ' 条   ' + pct(b.filler, b.total).padStart(6)
      + '   ' + String(Math.round(b.chars / b.total)).padStart(4));
  }
}

if (shapeCount > 0) {
  console.log('\n【高频短句榜】（同一短语在一段会话里被 ≥3 条回复用到才计入；按「多少段会话都这样」排序）');
  if (!ticRows.length) console.log('  （没有跨会话复现的短句）');
  for (const [t, v] of ticRows) console.log('  ' + String(v.sessions).padStart(4) + ' 段会话 × 最多 '
    + String(v.maxDf).padStart(3) + ' 条   「' + t + '」');
}

/** 最严重的会话：按「空表态率」与「最高频短句复用条数」两个角度看 */
const worstByRate = [...sessionAggs].filter((s) => s.replies >= 5)
  .sort((a, b) => b.fillers / b.replies - a.fillers / a.replies).slice(0, 8);
console.log('\n【按会话】（≥5 轮；会话等权的空表态率 p50 '
  + quantile([...sessionAggs].filter((s) => s.replies >= 5).map((s) => 100 * s.fillers / s.replies).sort((a, b) => a - b), 0.5).toFixed(1) + '%）');
console.log('  空表态率最高的 8 段（会话 · 轮数 · 空表态率 · 最高频短句 × 条数）：');
for (const s of worstByRate) {
  const top = [...s.tics.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log('    ' + s.key.slice(s.key.indexOf('::') + 2).padEnd(34) + String(s.replies).padStart(4) + ' 轮   '
    + pct(s.fillers, s.replies).padStart(6) + '   ' + (top ? '「' + top[0] + '」×' + top[1] : '-'));
}

if (onlyUser) {
  console.log('\n【单用户逐会话明细】');
  for (const s of [...sessionAggs].sort((a, b) => b.replies - a.replies)) {
    const top = [...s.tics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => '「' + t + '」×' + n).join(' · ');
    console.log('  ' + s.key.slice(s.key.indexOf('::') + 2).padEnd(34) + String(s.replies).padStart(4) + ' 轮   空表态 '
      + pct(s.fillers, s.replies).padStart(6) + '   ' + (top || '-'));
  }
}

const recentDays = new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-21));
console.log('\n【按日期（近 21 天）】');
for (const [d, b] of recentDays) {
  console.log('  ' + d.padEnd(14) + String(b.total).padStart(6) + ' 条   空表态 ' + pct(b.filler, b.total).padStart(6)
    + '   均字 ' + String(Math.round(b.chars / b.total)).padStart(4));
}

if (jsonOut) {
  const outPath = path.resolve(process.cwd(), jsonOut);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const mapToObj = (m: Map<string, Bucket>): Record<string, Bucket> => Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: {
      since: since ? dayOf(since) : null, until: Number.isFinite(until) ? dayOf(until) : null, includeTest, onlyUser: onlyUser || null,
      rawAssistant, excluded, replies: allReplies.length, sessions: sessionAggs.length, days: [days[0] || null, days[days.length - 1] || null],
    },
    totals: {
      replies: allReplies.length, avgChars: Number((totalChars / allReplies.length).toFixed(1)),
      medianChars: sortedChars[Math.floor(sortedChars.length / 2)] || 0,
      tiny: { n: tiny, rate: Number((tiny / allReplies.length).toFixed(4)) },
      short: { n: short, rate: Number((short / allReplies.length).toFixed(4)) },
      filler: { n: fillers, rate: Number((fillers / allReplies.length).toFixed(4)) },
      literalTic: { n: literals, rate: Number((literals / allReplies.length).toFixed(4)) },
      familyTic: { n: fams, rate: Number((fams / allReplies.length).toFixed(4)) },
      ...(probeRaw ? { probe: { pattern: probeRaw, n: probeHits, rate: Number((probeHits / allReplies.length).toFixed(4)), samples: probeSamples.slice(0, 50) } } : {}),
      familyTicFirstTurn: {
        n: firstTurn.filter((r) => r.familyTic).length, base: firstTurn.length,
        rate: firstTurn.length ? Number((firstTurn.filter((r) => r.familyTic).length / firstTurn.length).toFixed(4)) : 0,
      },
      fillerPairs: { sessions: streakSessions, occurrences: totalFillerPairs },
    },
    byMode: mapToObj(byMode), byDay: mapToObj(byDay), byLang: mapToObj(byLang),
    perUser,
    ticBoard: ticRows.map(([phrase, v]) => ({ phrase, sessions: v.sessions, maxDf: v.maxDf })),
    worstSessions: worstByRate.map((s) => ({
      session: s.key.slice(s.key.indexOf('::') + 2), replies: s.replies, fillers: s.fillers, fillerPairs: s.fillerPairs,
      topTics: [...s.tics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([phrase, df]) => ({ phrase, df })),
    })),
  }, null, 2) + '\n', 'utf8');
  console.log('\n已写出聚合 JSON：' + outPath);
}
