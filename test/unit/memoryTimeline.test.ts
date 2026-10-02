/**
 * 记忆时间轴（2026-09-17）单元测试
 *
 * 覆盖本次改造的四个面：
 *  1. **存储迁移**：旧的裸字符串记忆（facts: string[]）→ 带时间轴的 entries，
 *     正文一字不改、条目一条不删、迁移幂等，且时间缺失明确标「时间不详」（不编造时间）；
 *  2. **过期语义**：计划那天过去 / 状态超期 / 时间不详的旧状态 → 不再进"最近窗口"（不主动提），
 *     但**仍然存在**（可被语义召回、用户仍能看见），对应「降权 + 不主动提」的取舍；
 *  3. **取代关系**：新信息推翻旧记忆时旧条目标「已被更新」，不再当作现在，但保留可回溯；
 *  4. **时间标签渲染**：注入 prompt 的每条记忆都带自己的时间（含绝对日期），
 *     并把「现在」作为时间锚一起给模型，这是「不再把几个月前当成今天」的机制本身。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

const dir = setupTempCwd();

// 先落一份「旧格式」数据，再 import store，验证加载时的迁移（真实线上就是这个路径）
const legacyUpdatedAt = Date.now() - 20 * 86400000; // 20 天前最后写入
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data', 'long-memory.json'), JSON.stringify([
  {
    userId: 'legacy-user',
    facts: [
      '用户叫小林',
      '用户在云南腾冲旅游',
    ],
    updatedAt: legacyUpdatedAt,
  },
]), 'utf-8');

const { longMemoryStore, isMemoryStale, normalizeDateKey, dateKeyToTs } = await import('../../api/services/longMemory.js');
const { todayKeyIn, ageLabel, dayDiff, memoryLine, nowParts, normalizeTimezone, periodOf, timeTag, stampIn } = await import('../../api/services/timeAnchor.js');

const DAY = 86400000;

// ---------------------------------------------------------------------------
// 1. 旧数据迁移
// ---------------------------------------------------------------------------

test('旧数据迁移：正文一字不改、条目不丢、时间标为「时间不详」', () => {
  const facts = longMemoryStore.getFacts('legacy-user');
  assert.deepStrictEqual(facts, ['用户叫小林', '用户在云南腾冲旅游'], '正文与顺序原样保留');
  const entries = longMemoryStore.getEntries('legacy-user');
  assert.strictEqual(entries.length, 2, '没有条目被删除');
  assert.ok(entries.every(e => e.atApprox === true), '时间信息丢失 → 明确标"推断值"，不假装知道是哪天');
  assert.ok(entries.every(e => e.source === 'legacy'));
  assert.strictEqual(entries[0].at, legacyUpdatedAt, '时间锚取旧记录的 updatedAt（"不晚于此刻"，不是准确时间）');
});

test('旧数据迁移：状态类与长期类被分开（旅游=会过期的状态，名字=长期）', () => {
  const entries = longMemoryStore.getEntries('legacy-user');
  const travel = entries.find(e => e.text.includes('腾冲'))!;
  const name = entries.find(e => e.text.includes('小林'))!;
  assert.strictEqual(travel.kind, 'state', '「在云南旅游」是状态（会过期），不是长期事实');
  assert.strictEqual(name.kind, 'durable', '「用户叫小林」是长期事实');
});

test('迁移幂等：再次加载不会重复条目、不会改正文', () => {
  const before = JSON.stringify(longMemoryStore.getEntries('legacy-user').map(e => e.text));
  // 迁移结果已写回磁盘 → 直接读盘确认格式已升级
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'long-memory.json'), 'utf-8'));
  const rec = onDisk.find((r: any) => r.userId === 'legacy-user');
  assert.ok(Array.isArray(rec.entries) && rec.entries.length === 2, '磁盘上已是 entries 结构');
  assert.deepStrictEqual(rec.facts, ['用户叫小林', '用户在云南腾冲旅游'], '旧字段仍与有效条目同步（向后兼容）');
  const after = JSON.stringify(rec.entries.map((e: any) => e.text));
  assert.strictEqual(after, before, '正文未变');
});

// ---------------------------------------------------------------------------
// 2. 过期语义：不主动提，但不丢
// ---------------------------------------------------------------------------

test('「时间不详」的旧状态不进最近窗口（不主动提），但仍存在（可被召回/能看见）', () => {
  const today = todayKeyIn('Asia/Shanghai');
  const window = longMemoryStore.getPromptEntries('legacy-user', 'xiaoyu', today, 16);
  assert.ok(!window.some(e => e.text.includes('腾冲')), '时间不详的旧状态不该被主动提起');
  assert.ok(window.some(e => e.text.includes('小林')), '长期事实仍照常注入');
  assert.strictEqual(longMemoryStore.getFacts('legacy-user').length, 2, '不主动提 ≠ 删除：两条都还在');
});

test('新写入的状态：记下当天就在窗口里，过了窗口期才退出', () => {
  const uid = 'state-fresh';
  longMemoryStore.addFacts(uid, [{ text: '用户最近在焦虑换工作', kind: 'state' }], 60);
  const today = todayKeyIn('Asia/Shanghai');
  const window = longMemoryStore.getPromptEntries(uid, 'xiaoyu', today, 16);
  assert.strictEqual(window.length, 1, '刚记下的状态应能参与对话');
  assert.strictEqual(window[0].atApprox, undefined, 'state 的"此刻"是准确时间（不是推断值）');
  const e = window[0];
  assert.strictEqual(isMemoryStale(e, today), false);
  // 把时间挪到 40 天前（超过 STATE_STALE_DAYS=30）→ 视为过期
  assert.strictEqual(isMemoryStale({ ...e, at: Date.now() - 40 * DAY }, today), true, '状态超过有效窗口即过期');
});

test('计划类：那天过去即失效；当天/未来仍算有效', () => {
  const uid = 'plan-user';
  const today = todayKeyIn('Asia/Shanghai');
  const yesterday = new Date(Date.now() - DAY);
  const yk = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  longMemoryStore.addFacts(uid, [
    { text: '用户要去芒市', kind: 'plan', date: yk },
    { text: '用户明天有面试', kind: 'plan', date: todayKeyIn('Asia/Shanghai', Date.now() + DAY) },
  ], 60);
  const entries = longMemoryStore.getEntries(uid);
  const gone = entries.find(e => e.text.includes('芒市'))!;
  const upcoming = entries.find(e => e.text.includes('面试'))!;
  assert.strictEqual(isMemoryStale(gone, today), true, '原定日期已过去 → 不能再当"要去"说');
  assert.strictEqual(isMemoryStale(upcoming, today), false, '明天的计划仍然有效');
  const window = longMemoryStore.getPromptEntries(uid, 'xiaoyu', today, 16);
  assert.ok(!window.some(e => e.text.includes('芒市')), '过期计划不进主动窗口');
  assert.ok(window.some(e => e.text.includes('面试')), '有效计划照常注入');
});

// ---------------------------------------------------------------------------
// 3. 取代关系
// ---------------------------------------------------------------------------

test('新信息推翻旧记忆：旧条目「已被更新」（不再注入），但保留可回溯、不被删除', () => {
  const uid = 'supersede-user';
  longMemoryStore.addFacts(uid, [{ text: '用户正在云南腾冲旅游', kind: 'state' }], 60);
  longMemoryStore.addFacts(uid, [{ text: '用户已经离开云南回到家了', kind: 'state', replaces: ['用户正在云南腾冲旅游'] }], 60);
  assert.deepStrictEqual(longMemoryStore.getFacts(uid), ['用户已经离开云南回到家了'], '有效记忆只剩新的那条');
  const all = longMemoryStore.getEntries(uid, 'xiaoyu', true);
  assert.strictEqual(all.length, 2, '旧条目仍在（不删除）');
  const old = all.find(e => e.text.includes('腾冲'))!;
  assert.strictEqual(old.status, 'superseded');
  assert.ok(old.supersededBy, '记下"被哪条取代"，可回溯');
  const window = longMemoryStore.getPromptEntries(uid, 'xiaoyu', todayKeyIn('Asia/Shanghai'), 16);
  assert.ok(!window.some(e => e.text.includes('腾冲')), '被取代的记忆不能再进 prompt');
});

// ---------------------------------------------------------------------------
// 4. 时间标签与「现在」
// ---------------------------------------------------------------------------

test('时间标签：状态/长期/计划/时间不详各有各的说法，且带绝对日期', () => {
  const now = Date.now();
  const today = todayKeyIn('Asia/Shanghai', now);
  const stateLine = memoryLine({ text: '用户在考试', at: now - 3 * DAY, kind: 'state' }, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'zh' });
  assert.match(stateLine, /^- \[状态·3 天前（\d{4}-\d{2}-\d{2}）\] 用户在考试$/, '相对时间 + 具体日期都在');
  const unknown = memoryLine({ text: '用户养过一只猫', at: now - 300 * DAY, atApprox: true, kind: 'durable' }, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'zh' });
  assert.match(unknown, /\[长期·时间不详\]/, '时间不详就说不知道，不编日期');
  const planStale = memoryLine({ text: '用户要去芒市', at: dateKeyToTs('2026-01-05'), dateKey: '2026-01-05', kind: 'plan', stale: true }, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'zh' });
  assert.match(planStale, /\[计划·原定 2026-01-05（\d+ 天前，已过去）·可能已经变了\]/, '过期计划明说已过去');
  // 「原定」只给计划；已经发生的事必须说「发生在」，否则读起来像"这事还没办"
  const eventLine = memoryLine({ text: '用户去看了演唱会', at: dateKeyToTs('2026-08-20'), dateKey: '2026-08-20', kind: 'event' }, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'zh' });
  assert.match(eventLine, /\[事件·发生在 2026-08-20（\d+ 天前）\]/, '已发生的事不能写成"原定"');
  assert.ok(!eventLine.includes('原定'), '事件不得出现"原定"字样');
  const en = memoryLine({ text: 'user has an exam', at: now - 3 * DAY, kind: 'state' }, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'en' });
  assert.match(en, /^- \[state·3 d ago（\d{4}-\d{2}-\d{2}）\]/, '英文用户同样带时间（不留中文标签）');
});

test('时间锚工具：今天口径、相对时间、天数差、时段', () => {
  assert.strictEqual(normalizeTimezone('Asia/Hong_Kong'), 'Asia/Hong_Kong');
  assert.strictEqual(normalizeTimezone('Not/AZone'), undefined, '非法时区被拒（不塞坏值进 Intl）');
  assert.strictEqual(typeof todayKeyIn('Asia/Shanghai'), 'string');
  assert.match(todayKeyIn('Asia/Shanghai'), /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(dayDiff('2026-09-17', '2026-09-14'), 3);
  assert.strictEqual(dayDiff('2026-09-14', '2026-09-17'), -3);
  const now = Date.now();
  assert.strictEqual(ageLabel(now - 30 * 1000, now, 'zh'), '刚刚');
  assert.strictEqual(ageLabel(now - 3 * DAY, now, 'zh'), '3 天前');
  assert.strictEqual(ageLabel(now - 100 * DAY, now, 'zh'), '3 个月前');
  assert.strictEqual(periodOf(23, 'zh'), '晚上');
  assert.strictEqual(periodOf(3, 'zh'), '凌晨');
  const np = nowParts('Asia/Shanghai');
  assert.match(np.dateKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(np.clock, /^\d{2}:\d{2}$/);
});

test('无日期输入不会被编成日期（normalizeDateKey 拒绝非法值）', () => {
  assert.strictEqual(normalizeDateKey('2026-09-17'), '2026-09-17');
  assert.strictEqual(normalizeDateKey('2026/9/7'), '2026-09-07', '宽松接受分隔符与个位月日');
  assert.strictEqual(normalizeDateKey('明天'), undefined);
  assert.strictEqual(normalizeDateKey('2026-13-40'), undefined);
  assert.strictEqual(normalizeDateKey(undefined), undefined);
});

// ---------------------------------------------------------------------------
// 4b. 时区：时间戳跟着用户走（美/英/中三地同一时刻必须是三个不同的"今天/时刻"）
// ---------------------------------------------------------------------------

test('时间戳随时区：同一 UTC 时刻在纽约/伦敦/上海渲染出各自的日期、星期、分钟、时段', () => {
  // 2026-09-19T02:30:00Z → 上海 10:30 上午 / 伦敦 03:30 凌晨 / 纽约(EDT) 22:30 晚上（前一天 09-18）
  const t = Date.UTC(2026, 8, 19, 2, 30, 0);
  const sh = nowParts('Asia/Shanghai', t);
  const ld = nowParts('Europe/London', t);
  const ny = nowParts('America/New_York', t);
  assert.strictEqual(sh.dateKey, '2026-09-19');
  assert.strictEqual(sh.clock, '10:30', '分钟级：上海 10:30');
  assert.strictEqual(sh.period, '上午');
  assert.strictEqual(ld.dateKey, '2026-09-19');
  assert.strictEqual(ld.clock, '03:30', '分钟级：伦敦 03:30');
  assert.strictEqual(ld.period, '凌晨');
  assert.strictEqual(ny.dateKey, '2026-09-18', '纽约此时还是前一天');
  assert.strictEqual(ny.clock, '22:30', '分钟级：纽约 22:30');
  assert.strictEqual(ny.period, '晚上');
  assert.notStrictEqual(sh.dateKey + sh.clock, ny.dateKey + ny.clock, '三地不能算出同一个时间点');
});

test('记忆时间戳随时区：当天带分钟、更早只到天；跨时区算出各自的"今天"', () => {
  const t = Date.UTC(2026, 8, 19, 2, 30, 0);
  // 纽约此刻是 09-18 22:30 → 对纽约用户来说这条"刚刚"的记忆落在 09-18，且带分钟
  const nyToday = todayKeyIn('America/New_York', t);
  assert.strictEqual(stampIn('America/New_York', t, nyToday), '2026-09-18 22:30');
  const shToday = todayKeyIn('Asia/Shanghai', t);
  assert.strictEqual(stampIn('Asia/Shanghai', t, shToday), '2026-09-19 10:30');
  // 更早的记忆只到天（分钟对几个月前的事是噪音）
  const old = t - 200 * DAY;
  assert.match(stampIn('Asia/Shanghai', old, shToday), /^\d{4}-\d{2}-\d{2}$/);
  // 记忆行的相对时间 + 本地时间点，都要按该用户时区算
  const line = memoryLine({ text: '用户刚说完今天的事', at: t, kind: 'state' }, { now: t, todayKey: nyToday, tz: 'America/New_York', lang: 'zh' });
  assert.match(line, /\[状态·刚刚（2026-09-18 22:30）\]/, '注入 prompt 的记忆行按用户时区');
});

test('请求头 X-Timezone 立刻生效：不依赖偏好里存过时区（存量用户/游客/出国换时区）', async () => {
  const { buildChatPromptParts } = await import('../../api/services/gemini.js');
  const { preferenceStore } = await import('../../api/services/preferences.js');
  const uid = 'header-tz-user';
  // 故意**不**给偏好写 timezone（模拟"存量用户/从没上报过"）
  preferenceStore.set(uid, { language: 'zh-CN' });
  assert.strictEqual(preferenceStore.get(uid).timezone, undefined, '前提：偏好里没有时区');
  const { system } = await buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid, timezone: 'America/New_York' }, true);
  assert.match(system, /America\/New_York/, '时间锚必须用请求头带来的时区');
  assert.ok(!system.includes('Asia/Shanghai'), '不能回退到默认时区（同一时刻两地日期可能都不同）');
  // 未给 timezone 时才回退偏好/默认
  const { system: sys2 } = await buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid }, true);
  assert.ok(!sys2.includes('America/New_York'), '没有请求头时不臆造时区');
});

test('resolveUserTimezone：请求头优先、非法值忽略、并把时区回写偏好（后台链路也用对的那份）', async () => {
  const { resolveUserTimezone } = await import('../../api/services/requestTimezone.js');
  const { preferenceStore } = await import('../../api/services/preferences.js');
  const uid = 'resolve-tz-user';
  const fakeReq = (tz?: string) => ({ headers: tz ? { 'x-timezone': tz } : {} } as any);
  assert.strictEqual(resolveUserTimezone(fakeReq('Europe/London'), uid), 'Europe/London');
  assert.strictEqual(preferenceStore.get(uid).timezone, 'Europe/London', '回写偏好（供记忆提取/推送等后台链路使用）');
  assert.strictEqual(resolveUserTimezone(fakeReq('Not/AZone'), uid), 'Europe/London', '非法时区忽略，回退已存值');
  assert.strictEqual(resolveUserTimezone(fakeReq(), uid), 'Europe/London', '无请求头时用存过的');
  assert.strictEqual(resolveUserTimezone(fakeReq('Asia/Tokyo'), 'nobody'), 'Asia/Tokyo', '未登录也要能用（游客）');
});

test('深夜判断按用户时区（不再是服务器本地时间）', () => {
  const t = Date.UTC(2026, 8, 19, 2, 30, 0); // 上海 10:30（白天）/ 纽约 22:30（深夜）
  assert.strictEqual(nowParts('Asia/Shanghai', t).hour, 10);
  assert.strictEqual(nowParts('America/New_York', t).hour, 22);
  const isNight = (tz: string) => { const h = nowParts(tz, t).hour; return h >= 22 || h < 6; };
  assert.strictEqual(isNight('Asia/Shanghai'), false, '上海上午不是深夜');
  assert.strictEqual(isNight('America/New_York'), true, '纽约同一时刻是深夜');
  assert.strictEqual(isNight('Europe/London'), true, '伦敦 03:30 也是深夜');
});

test('注入 prompt 的记忆条目必须带时间标签（防回归：注入时不能只剩纯文本）', () => {
  const uid = 'tag-user';
  longMemoryStore.addFacts(uid, [{ text: '用户叫小林', kind: 'durable' }], 60);
  const now = Date.now();
  const today = todayKeyIn('Asia/Shanghai');
  const lines = longMemoryStore.getPromptEntries(uid, 'xiaoyu', today, 16)
    .map(e => memoryLine(e, { now, todayKey: today, tz: 'Asia/Shanghai', lang: 'zh' }));
  assert.ok(lines.length > 0);
  assert.ok(lines.every(l => /^- \[[^\]]+\] .+/.test(l)), '每行都是「- [时间标签] 正文」');
  assert.match(timeTag({ text: '', at: now, kind: 'durable' } as any, { now, todayKey: today, tz: 'Asia/Shanghai' }), /^\[/);
});

// ---------------------------------------------------------------------------
// 5. 端到端：真正拼出来的聊一聊 prompt（读侧「现在」+ 写侧「时间」同时在场）
// ---------------------------------------------------------------------------

test('聊一聊 prompt：既有时间锚（现在），也有每条记忆自己的时间；过期计划不出现', async () => {
  const { preferenceStore } = await import('../../api/services/preferences.js');
  const { buildChatPromptParts } = await import('../../api/services/gemini.js');
  const uid = 'prompt-time-user';
  preferenceStore.set(uid, { timezone: 'Asia/Hong_Kong', language: 'zh-CN' });
  longMemoryStore.addFacts(uid, [
    { text: '用户正在云南腾冲旅游', kind: 'state' },
    { text: '用户要去芒市', kind: 'plan', date: '2020-01-05' }, // 早就过去了
  ], 60);

  const { system } = await buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid }, true);

  assert.match(system, /【现在】/, 'prompt 必须告诉模型"现在"是哪天');
  assert.match(system, /Asia\/Hong_Kong/, '按用户上报的时区算"今天"');
  assert.match(system, /【现在】[\s\S]*\d{4}-\d{2}-\d{2}/, '时间锚含日期');
  assert.match(system, /\[状态·刚刚（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）\] 用户正在云南腾冲旅游/, '记忆带自己的时间标签（当天带分钟）');
  assert.match(system, /时间规则/, '同时给出"旧记忆怎么用"的硬规则');
  assert.ok(!system.includes('用户要去芒市'), '已过期的计划不主动提（不在 prompt 里）');
});
