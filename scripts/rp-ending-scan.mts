/**
 * 剧情 / 聊一聊「收尾形态」全站扫描（**只读**）
 *
 * 为什么要它（2026-09-18 用户口径）：「好多条 AI 的消息在最后都会问『想跟我多说点？』之类的回答，
 * 太多余了……要考虑用户使用的叙事模式还有所有人使用情况，避免 overfit」。
 * 改提示词之前必须先知道**真实比例与分布**，否则只能照着一个用户看到的几句话去改 —— 那正是 overfit。
 * 这个脚本给出三件事，全部来自线上真实数据：
 *   ① 基线：AI 回复里「问句收尾 / 征询继续收尾」各占多少（按来源 / 叙事模式 / 模型 / 日期分档）；
 *   ② 分布：**按用户**的 p50 / p90 / 最高，用来判断这是「某一个人的口味」还是「普遍习惯」；
 *   ③ 形态榜：模型到底在写哪几句（归一化后按次数排序）—— 用实测代替我对说法的猜测。
 * 改完之后再跑一次同一命令，两份 JSON 一比就是前后对比。
 *
 * 用法：
 *   npx tsx scripts/rp-ending-scan.mts                       # 全站（已排除测试/开发身份）
 *   npx tsx scripts/rp-ending-scan.mts --kinds roleplay
 *   npx tsx scripts/rp-ending-scan.mts --since 2026-09-01
 *   npx tsx scripts/rp-ending-scan.mts --user <userId>       # 单个用户逐会话明细
 *   npx tsx scripts/rp-ending-scan.mts --json temp/rp-ending-baseline.json
 *   npx tsx scripts/rp-ending-scan.mts --shapes 0            # 不打印「高频收尾形态」榜
 *   npx tsx scripts/rp-ending-scan.mts --include-test        # 也收测试/开发身份（仅自测）
 *
 * 数据源：`data/xiaoyu.sqlite` 的 kv 表（`PERSISTENCE_PROVIDER=sqlite` 下的真实数据；
 * `data/*.json` 是 file 时代冻结的旧副本，读它会得到假读数）。**全程 readonly 打开，不写任何东西。**
 *
 * 判据：`src/lib/rpEnding.ts`（与线上提示词的「形态刹车」共用同一份实现，避免两套口径）。
 * 它分两层，可信度不同：`question`（句末标点含问号，硬判据）与 `continuation_ask`
 * （「征询继续」的元话语，启发式 —— 会把剧情里问第三人的正常台词也算进来，见该文件 JSDoc）。
 *
 * 隐私：默认**只打印聚合数字**。`--shapes` 打印的是「收尾那一句」的归一化形态榜（不含任何身份、
 * 不关联到人），仅用于看清模型的说法族；把它设成 0 即可完全关闭。JSON 里不含 userId。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { rpEndingKind, rpHasTerminalPunctuation, rpLastClause, type RpEndingKind } from '../src/lib/rpEnding.js';
import { isTestAccount, isDeveloperAccount } from '../api/services/accountFilters.js';

const argv = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (name: string): boolean => argv.includes('--' + name);

const kinds = (arg('kinds', 'roleplay,chat') || 'roleplay,chat')
  .split(',').map((s) => s.trim()).filter((s): s is 'roleplay' | 'chat' => s === 'roleplay' || s === 'chat');
const since = arg('since') ? new Date(arg('since') + 'T00:00:00+08:00').getTime() : 0;
const onlyUser = arg('user');
const includeTest = has('include-test');
const shapeCount = arg('shapes') === '' ? 12 : Number(arg('shapes'));
const jsonOut = arg('json');

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

/**
 * 「这条身份是不是测试/开发」——**复用既有判据**，不在这里另写一份正则
 *（`accountFilters.ts` 开篇写明要避免「两处各写一份、日后口径漂移」；设备级的 `test-` 前缀
 * 规则来自 `activity.ts: isTestRequest`，用动态 import 取，避免为了一个纯函数把行为 store 一起拉起来）。
 */
async function makeIsTestIdentity(): Promise<(userId: string) => boolean> {
  const accounts = kv<Array<{ userId?: string; username?: string | null; email: string }>>('accounts.json') || [];
  const byId = new Map<string, { username?: string | null; email: string }>();
  for (const a of accounts) if (a && typeof a.userId === 'string') byId.set(a.userId, a);
  let deviceRuleOk = false;
  let isTestRequest: (ip?: string, deviceId?: string) => boolean = () => false;
  try {
    const mod = await import('../api/services/activity.js');
    isTestRequest = mod.isTestRequest;
    deviceRuleOk = true;
  } catch { /* 取不到就只按账号判据（下面会在报告里标注） */ }
  if (!deviceRuleOk) console.warn('⚠️ 未能加载 activity.isTestRequest，本次只按账号判据排除测试身份');
  return (userId: string): boolean => {
    if (isTestRequest(undefined, userId)) return true;
    const acc = byId.get(userId);
    return !!acc && (isTestAccount(acc) || isDeveloperAccount(acc));
  };
}
const isTestIdentity = await makeIsTestIdentity();

/**
 * 毫秒时间戳归一化。
 *
 * 为什么不能直接当数字用（2026-09-18 实测踩到）：真实数据里时间戳**两种形态混存**——
 * 剧情消息是毫秒数（`number`），而聊一聊的历史消息是 ISO 字符串（`"2026-08-20T13:28:27.698Z"`），
 * 会话级的 `updatedAt/createdAt` 也可能一边是数字一边是字符串。直接做 `ms + 8*3600000` 会得到
 * `"2026-09-18"+82800000` 这种字符串 → `new Date()` 变 Invalid Date → 脚本当场抛错。
 */
function tsOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

/** 毫秒 → 东八区自然日；取不到时间就归到「未知日期」，绝不抛错 */
function dayOf(ms: number): string {
  if (!Number.isFinite(ms)) return '未知日期';
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

interface Turn {
  source: 'roleplay' | 'chat';
  userId: string;
  sessionKey: string;
  model: string;
  style: string;
  day: string;
  ending: RpEndingKind;
  noTerminal: boolean;
  tail: string;
  /** 剧本开场白（会话第一条 assistant）——**剧本作者写的**，不是模型行为，不能算进模型习惯 */
  opening: boolean;
  /**
   * 上游退化/重复输出（2026-09-18 首次跑真实数据时发现，必须单列）：
   *   实测两种形态——① 整条正文就是「/」这类 1~3 个字符的残渣（有一段会话 22 轮都是这样）；
   *   ② 模型自己循环复读，正文是 `放下杯子，100「我听着呢。」他放下杯子，100…` 反复（另一段 100 轮）。
   * 这类样本的「收尾」根本不是收尾，混进统计里既会抬高「无句末标点」也会把形态榜冲成一堆噪音
   * （首跑时 `#` 100 次、`/` 22 次两个桶全是它们）。**剔除并把数量报出来**，不作静默丢弃。
   */
  degenerate: boolean;
}

function classify(source: 'roleplay' | 'chat', userId: string, sessionKey: string, msg: any, fallbackTs: any, model: string, style: string, opening: boolean, out: Turn[]): void {
  const content = typeof msg?.content === 'string' ? msg.content : '';
  if (content.trim().length < 2) return;
  // 消息自带时间优先，否则退回会话级时间；两者都可能缺失/畸形 → 结果为 NaN，归入「未知日期」
  const own = tsOf(msg?.timestamp);
  const ts = Number.isFinite(own) ? own : tsOf(fallbackTs);
  if (since && Number.isFinite(ts) && ts < since) return;
  const tail = rpLastClause(content);
  // 退化判据：整条太短（残渣）或同一个小句在正文里出现 ≥3 次（自循环复读）
  const repeats = tail.length >= 2 ? content.split(tail).length - 1 : 0;
  out.push({
    source, userId, sessionKey,
    model: model || '未记录',
    style: style || '未记录',
    day: dayOf(ts),
    ending: rpEndingKind(content),
    // 判据盲区单列：整段没写句末标点 → 硬判据必然判「非问句」，报告里要把它显式标出来，避免当成改善
    noTerminal: !rpHasTerminalPunctuation(content),
    tail,
    opening,
    degenerate: content.trim().length <= 3 || repeats >= 3,
  });
}

const turns: Turn[] = [];
/** 会话内的收尾序列（算「连续两轮都以问句收尾」用） */
const sessionSeq = new Map<string, RpEndingKind[]>();

function pushSeq(key: string, ending: RpEndingKind): void {
  const arr = sessionSeq.get(key) || [];
  arr.push(ending);
  sessionSeq.set(key, arr);
}

// —— 剧情会话 ——
if (kinds.includes('roleplay')) {
  const records = kv<any[]>('roleplay-sessions.json') || [];
  for (const r of records) {
    const userId = String(r?.userId || '');
    if (!userId || !Array.isArray(r?.messages)) continue;
    if (onlyUser && !userId.startsWith(onlyUser)) continue;
    if (!includeTest && isTestIdentity(userId)) continue;
    // 会话键用**完整 userId**（前缀只用于展示）：两个用户的前 8 位撞车会把两段会话并成一段，序列指标就错了
    const key = userId + '::' + String(r.scenarioId || '');
    let seenAssistant = false;
    for (const m of r.messages) {
      if (m?.role !== 'assistant') continue;
      // 会话里第一条 assistant = 剧本开场白（作者写的），单列标记、不进统计
      const opening = !seenAssistant;
      seenAssistant = true;
      const before = turns.length;
      classify('roleplay', userId, key, m, r.updatedAt || 0, String(m.model || ''), String(m.style || ''), opening, turns);
      if (turns.length > before && !turns[turns.length - 1].opening && !turns[turns.length - 1].degenerate) pushSeq(key, turns[turns.length - 1].ending);
    }
  }
}

// —— 聊一聊会话 ——
if (kinds.includes('chat')) {
  const sessions = kv<any[]>('sessions.json') || [];
  for (const s of sessions) {
    const userId = String(s?.userId || '');
    if (!userId) continue;                       // 无主遗留会话不计（归因不明）
    if (onlyUser && !userId.startsWith(onlyUser)) continue;
    if (!includeTest && isTestIdentity(userId)) continue;
    const key = userId + '::chat';
    for (const m of (Array.isArray(s?.chatMessages) ? s.chatMessages : [])) {
      if (m?.role !== 'assistant') continue;
      const before = turns.length;
      // 聊一聊的第一条也是模型生成的（不是剧本开场白），所以 opening 一律 false
      classify('chat', userId, key, m, s.updatedAt || s.createdAt || 0, String(m.model || ''), String(m.style || ''), false, turns);
      if (turns.length > before && !turns[turns.length - 1].degenerate) pushSeq(key, turns[turns.length - 1].ending);
    }
  }
}
db.close();

if (!turns.length) {
  console.log('没有符合条件的 AI 回复（检查 --kinds / --since / --user 参数）');
  process.exit(0);
}

/**
 * 统计口径：**剔除开场白与上游退化输出**，两者都不是「模型怎么收尾」。
 * 剔除数量在下文如实报出（不静默丢样本）；原始条数也一并给出，便于复核。
 */
const kept = turns.filter((t) => !t.opening && !t.degenerate);
const excluded = {
  opening: turns.filter((t) => t.opening).length,
  degenerate: turns.filter((t) => !t.opening && t.degenerate).length,
};
if (!kept.length) {
  console.log('全部样本都被剔除（开场白 ' + excluded.opening + ' 条 / 退化 ' + excluded.degenerate + ' 条），无可统计内容');
  process.exit(0);
}

// ———————————————— 聚合 ————————————————
interface Bucket { total: number; q: number; ask: number; noTerm: number }
const empty = (): Bucket => ({ total: 0, q: 0, ask: 0, noTerm: 0 });
function add(b: Bucket, t: Turn): void {
  b.total += 1;
  if (t.ending === 'question') b.q += 1;
  if (t.ending === 'continuation_ask') b.ask += 1;
  if (t.noTerminal) b.noTerm += 1;
}
const pct = (n: number, d: number): string => (d ? (100 * n / d).toFixed(1) + '%' : '—');

const totals = empty();
const bySource = new Map<string, Bucket>();
const byStyle = new Map<string, Bucket>();
const byModel = new Map<string, Bucket>();
const byDay = new Map<string, Bucket>();
const byUser = new Map<string, Bucket>();
for (const t of kept) {
  add(totals, t);
  for (const [map, key] of [
    [bySource, t.source], [byStyle, t.style], [byModel, t.model], [byDay, t.day], [byUser, t.userId.slice(0, 8)],
  ] as Array<[Map<string, Bucket>, string]>) {
    const b = map.get(key) || empty();
    add(b, t);
    map.set(key, b);
  }
}

/** 连续问句收尾：会话内相邻 AI 回复（中间隔着用户消息也算相邻）连续非陈述收尾的最长长度 */
let streakSessions = 0;
let streakMax = 0;
const streakHist = new Map<number, number>();
for (const seq of sessionSeq.values()) {
  let cur = 0;
  let best = 0;
  for (const k of seq) {
    cur = k === 'statement' ? 0 : cur + 1;
    if (cur > best) best = cur;
  }
  if (best >= 2) { streakSessions += 1; streakHist.set(best, (streakHist.get(best) || 0) + 1); }
  if (best > streakMax) streakMax = best;
}

/** 用户分布（只统计 AI 回复 ≥20 条的用户，否则比率没有意义） */
const MIN_TURNS_PER_USER = 20;
const rates = [...byUser.values()].filter((b) => b.total >= MIN_TURNS_PER_USER)
  .map((b) => 100 * (b.q + b.ask) / b.total).sort((a, b) => a - b);
const quantile = (arr: number[], p: number): number => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
const perUser = {
  usersWithData: byUser.size,
  usersCounted: rates.length,
  p50: Number(quantile(rates, 0.5).toFixed(1)),
  p90: Number(quantile(rates, 0.9).toFixed(1)),
  max: Number((rates[rates.length - 1] || 0).toFixed(1)),
};

/** 高频收尾形态榜：归一化（去标点/数字/空白、截断 18 字）后计数 */
function shapeOf(tail: string): string {
  return tail
    .replace(/[\s\u3000]+/g, '')
    .replace(/[0-9]+/g, '#')
    .replace(/[。！？!?…，、,.]+$/g, '')
    .slice(0, 18);
}
const shapeMap = new Map<string, { n: number; ask: number }>();
for (const t of kept) {
  const s = shapeOf(t.tail);
  if (!s) continue;
  const cur = shapeMap.get(s) || { n: 0, ask: 0 };
  cur.n += 1;
  if (t.ending === 'continuation_ask') cur.ask += 1;
  shapeMap.set(s, cur);
}
const shapes = [...shapeMap.entries()]
  .filter(([, v]) => v.n >= 2)
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, Math.max(0, shapeCount))
  .map(([shape, v]) => ({ shape, count: v.n, continuationAsk: v.ask }));

// ———————————————— 输出 ————————————————
const days = [...byDay.keys()].filter((d) => d !== '未知日期').sort();
const unknownDay = byDay.get('未知日期')?.total || 0;
console.log('\n=== 剧情 / 聊一聊「收尾形态」扫描（只读 ' + DB_PATH + '）===');
console.log('范围：' + (includeTest ? '含测试/开发身份' : '仅真实用户（已排除测试/开发身份）')
  + (since ? '｜自 ' + dayOf(since) : '') + (onlyUser ? '｜用户 ' + onlyUser : '')
  + '｜原始 AI 回复 ' + turns.length + ' 条（剔除开场白 ' + excluded.opening + ' + 上游退化 ' + excluded.degenerate
  + ' → 统计 ' + totals.total + ' 条）｜日期 ' + (days[0] || '—') + ' ~ ' + (days[days.length - 1] || '—')
  + '｜会话 ' + sessionSeq.size + ' 段' + (unknownDay ? '｜无时间戳 ' + unknownDay + ' 条' : ''));
console.log('口径：剔除的**不是模型收尾**——开场白是剧本作者写的（同一剧本每段会话各一条），'
  + '退化输出是上游自循环复读（正文本身就不是一句话）。二者混进来会把形态榜冲成噪音，实测踩到过。');

console.log('\n【总览】');
console.log('  问句收尾（硬判据）      ' + String(totals.q).padStart(6) + '  ' + pct(totals.q, totals.total));
console.log('  其中「征询继续」元话语  ' + String(totals.ask).padStart(6) + '  ' + pct(totals.ask, totals.total) + '   ← 用户投诉的这一类');
console.log('  问句收尾合计            ' + String(totals.q + totals.ask).padStart(6) + '  ' + pct(totals.q + totals.ask, totals.total));
console.log('  陈述/动作收尾           ' + String(totals.total - totals.q - totals.ask).padStart(6) + '  ' + pct(totals.total - totals.q - totals.ask, totals.total));
console.log('  无句末标点（判据盲区）  ' + String(totals.noTerm).padStart(6) + '  ' + pct(totals.noTerm, totals.total));

const table = (title: string, map: Map<string, Bucket>, sortByTotal = true): void => {
  const rows = [...map.entries()].filter(([k]) => k);
  if (!rows.length) return;
  rows.sort(sortByTotal ? (a, b) => b[1].total - a[1].total : (a, b) => a[0].localeCompare(b[0]));
  console.log('\n【' + title + '】');
  for (const [key, b] of rows) {
    console.log('  ' + key.padEnd(34) + String(b.total).padStart(6) + ' 条   问句 ' + pct(b.q + b.ask, b.total).padStart(6)
      + '   征询继续 ' + pct(b.ask, b.total).padStart(6) + '   无标点 ' + pct(b.noTerm, b.total));
  }
};
table('按来源（剧情 / 聊一聊）', bySource);
table('按叙事模式（老数据一律「未记录」——模式原先只存在浏览器 localStorage）', byStyle);
table('按模型', byModel);
// 日期表只打最近 21 天，避免刷屏（全量在 JSON 里）
const recentDays = new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-21));
table('按日期（近 21 天）', recentDays, false);

console.log('\n【连续两轮以上以问句收尾】');
console.log('  命中会话 ' + streakSessions + ' / ' + sessionSeq.size + ' 段   最长连续 ' + streakMax + ' 轮'
  + (streakHist.size ? '   分布 ' + [...streakHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => k + '轮×' + v + '段').join(' · ') : ''));

console.log('\n【按用户分布】（AI 回复 ≥' + MIN_TURNS_PER_USER + ' 条的用户，共 ' + perUser.usersCounted + '/' + perUser.usersWithData + ' 个）');
console.log('  问句收尾率 p50 ' + perUser.p50 + '%   p90 ' + perUser.p90 + '%   最高 ' + perUser.max + '%');
const topUsers = [...byUser.entries()].filter(([, b]) => b.total >= MIN_TURNS_PER_USER)
  .sort((a, b) => (b[1].q + b[1].ask) / b[1].total - (a[1].q + a[1].ask) / a[1].total)
  .slice(0, 8);
console.log('  最高的 8 个（user 前缀 · 条数 · 问句率 · 征询继续率）：');
for (const [u, b] of topUsers) console.log('    ' + u.padEnd(10) + String(b.total).padStart(5) + ' 条   ' + pct(b.q + b.ask, b.total).padStart(6) + '   ' + pct(b.ask, b.total).padStart(6));

if (shapeCount > 0) {
  console.log('\n【高频收尾形态】（归一化后按次数；只打收尾那一句，不含任何身份）');
  for (const s of shapes) console.log('  ' + String(s.count).padStart(5) + ' × ' + s.shape + (s.continuationAsk ? '   ← 征询继续 ' + s.continuationAsk + ' 次' : ''));
}

/**
 * 【按会话：谁是总量的来源】
 *
 * 为什么必须有这一节：**按条数加权**的平均会被少数超长会话带偏。实测（2026-09-18 首次跑）
 * 全站「问句收尾 20.9%」，而形态榜上「玩够了没有」一个收尾就占了 100 次 —— 那是**同一个会话里
 * 反复用同一句收尾**（跨轮复读，另一类问题），不是「很多用户在问要不要继续」。
 * 不做这一节，就会把一个会话的毛病说成「所有用户的习惯」（正是用户叮嘱要避免的 overfit）。
 */
const perSessionAgg = new Map<string, { turns: number; q: number; ask: number; shape: Map<string, number> }>();
for (const t of kept) {
  const s = perSessionAgg.get(t.sessionKey) || { turns: 0, q: 0, ask: 0, shape: new Map<string, number>() };
  s.turns += 1;
  if (t.ending !== 'statement') s.q += 1;
  if (t.ending === 'continuation_ask') s.ask += 1;
  const sh = shapeOf(t.tail);
  if (sh) s.shape.set(sh, (s.shape.get(sh) || 0) + 1);
  perSessionAgg.set(t.sessionKey, s);
}
const sessionRates = [...perSessionAgg.values()].filter((s) => s.turns >= 5).map((s) => 100 * s.q / s.turns).sort((a, b) => a - b);
console.log('\n【按会话】共 ' + perSessionAgg.size + ' 段（≥5 轮的 ' + sessionRates.length + ' 段参与分位）');
console.log('  会话等权的问句收尾率：p50 ' + quantile(sessionRates, 0.5).toFixed(1) + '%   p90 ' + quantile(sessionRates, 0.9).toFixed(1) + '%'
  + '   （对比：按条数加权的全站值 ' + pct(totals.q + totals.ask, totals.total) + ' —— 两者差得越多，说明总量被少数超长会话带偏得越厉害）');
console.log('  轮数最多的 8 段（会话 · 轮数 · 问句率 · 最高频收尾形态 × 次数）：');
const topSessions = [...perSessionAgg.entries()].sort((a, b) => b[1].turns - a[1].turns).slice(0, 8);
for (const [k, s] of topSessions) {
  const label = k.includes('::') ? k.slice(k.indexOf('::') + 2) : k;
  const topShape = [...s.shape.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log('    ' + label.padEnd(38) + String(s.turns).padStart(4) + ' 轮   ' + (100 * s.q / s.turns).toFixed(0).padStart(4) + '%   '
    + (topShape ? topShape[0] + ' ×' + topShape[1] : '-'));
}

if (onlyUser) {
  console.log('\n【单用户逐会话明细】');
  const perSession = new Map<string, Bucket>();
  for (const t of kept) {
    const b = perSession.get(t.sessionKey) || empty();
    add(b, t);
    perSession.set(t.sessionKey, b);
  }
  for (const [k, b] of [...perSession.entries()].sort((a, b2) => b2[1].total - a[1].total)) {
    // 只打会话部分（--user 已经把范围收到一个人身上），避免把完整 userId 打出来
    const label = k.includes('::') ? k.slice(k.indexOf('::') + 2) : k;
    console.log('  ' + label.padEnd(46) + String(b.total).padStart(4) + ' 轮   问句 ' + pct(b.q + b.ask, b.total).padStart(6) + '   征询继续 ' + pct(b.ask, b.total).padStart(6));
  }
}

if (jsonOut) {
  const outPath = path.resolve(process.cwd(), jsonOut);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const mapToObj = (m: Map<string, Bucket>): Record<string, Bucket> => Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { kinds, since: since ? dayOf(since) : null, includeTest, users: byUser.size, sessions: sessionSeq.size, turns: totals.total, rawTurns: turns.length, excluded, unknownDay, days: [days[0] || null, days[days.length - 1] || null] },
    totals, bySource: mapToObj(bySource), byStyle: mapToObj(byStyle), byModel: mapToObj(byModel), byDay: mapToObj(byDay),
    streaks: { sessions: streakSessions, max: streakMax, histogram: Object.fromEntries([...streakHist.entries()].sort((a, b) => a[0] - b[0])) },
    perUser, shapes,
  }, null, 2) + '\n', 'utf8');
  console.log('\n已写出聚合 JSON：' + outPath);
}
