/**
 * 🩺 自愈引擎单测（2026-09-18 新增），`api/services/selfHeal.ts`。
 *
 * 覆盖口径（每条检测器都要验「发现 → 修复 → 复查 → 幂等」四件事）：
 *   ① 半截回复没打标记        → 补 `incomplete:true`，**正文一字不改**；
 *   ② 幂等                    → 再跑一次不再报同一个问题（不刷屏、不重复写盘）；
 *   ③ dry / off 模式          → 一行数据都不动 / 完全不跑；
 *   ④ 末句没人接              → 只做缓解（不改数据、不替角色编）；
 *   ⑤ 历史里的系统兜底文案    → 默认 `needs_human` 且**不动数据**；允许后清掉，且真实台词保留；
 *   ⑥ 缺时间戳 / 版本不自洽    → 按保存路径同一规则补齐（用**手写库文件**造这两类脏数据）；
 *   ⑦ 剧名快照缺失            → 从自建剧本库回填；
 *   ⑧ 测试设备                → 跳过，不留记录；
 *   ⑨ 写前备份                → temp/self-heal-backup/ 真落了一份原文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

const tmpDir = setupTempCwd();

// ⚠️ 顺序很重要：先手写一份「脏库文件」（缺时间戳 / versions 不自洽），再 import store
//    store 在 import 时按 cwd 读盘，之后用 heal()/save() 是**造不出**这两类脏数据的（两条写入路径都会补齐）。
const { writeJson, dataFile } = await import('../../api/storage/persistence.js');
writeJson(dataFile('roleplay-sessions.json'), [
  {
    userId: 'u-raw', scenarioId: 'heal-ts', updatedAt: Date.now(),
    messages: [{ role: 'user', content: '缺时间戳的一句' }, { role: 'assistant', content: '缺时间戳的一条回复。' }],
  },
  {
    userId: 'u-raw', scenarioId: 'heal-ver', updatedAt: Date.now(),
    messages: [
      { role: 'user', content: '点什么' },
      { role: 'assistant', content: '第一版正文。', versions: ['旧版A', '旧版B'], vi: 7 },
    ],
  },
]);

const { roleplaySessionStore } = await import('../../api/services/roleplaySessions.js');
const { customRoleplayStore } = await import('../../api/services/customRoleplay.js');
const { runSelfHealCycle, selfHealStore, selfHealMode } = await import('../../api/services/selfHeal.js');

const U = 'u-heal';
const FALLBACK = '网络好像开小差了，稍后再试试好吗？🌱';
/** 真实断点长相：前面的括号闭合，只有最后那个 （ 悬空 */
const HALF = '（他低笑一声，把杯子放下。）\n\n“来，张嘴。”\n\n（他并未退';

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const findRec = (run: { records: Array<{ scenarioId: string; kind: string; status: string }> }, sid: string, kind: string) =>
  run.records.find((r) => r.scenarioId === sid && r.kind === kind);

test('① 脏库数据：缺时间戳 / 版本不自洽 → 一次巡检补齐（正文一字不改）', async () => {
  setEnv({ SELF_HEAL: 'apply', SELF_HEAL_DELETE: undefined });
  // ⚠️ 这条必须**第一个跑**：后面任何一次巡检都会顺手把这两条修好（检测器扫全库）
  assert.equal(roleplaySessionStore.get('u-raw', 'heal-ts')!.some((m) => m.timestamp === undefined), true, '前置：库文件里确实缺时间戳');
  const run = await runSelfHealCycle({ apply: true });
  const tsRec = findRec(run, 'heal-ts', 'MISSING_TIMESTAMP');
  const verRec = findRec(run, 'heal-ver', 'VERSIONS_INCONSISTENT');
  assert.ok(tsRec && tsRec.status === 'fixed', '缺时间戳应被补齐');
  assert.ok(verRec && verRec.status === 'fixed', '版本不自洽应被重建');

  const tsMsgs = roleplaySessionStore.get('u-raw', 'heal-ts')!;
  assert.ok(tsMsgs.every((m) => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)));
  assert.equal(tsMsgs[0].content, '缺时间戳的一句', '正文一字不改');
  const verMsgs = roleplaySessionStore.get('u-raw', 'heal-ver')!;
  const v = verMsgs[1];
  assert.ok(Array.isArray(v.versions) && v.versions.length >= 2, '仍是多版本');
  assert.ok(v.versions!.includes(v.content), 'content 必须能在 versions 里找到（界面上点得出来）');
  assert.ok(typeof v.vi === 'number' && v.vi >= 0 && v.vi < v.versions!.length, 'vi 不越界');
  assert.equal(v.content, '第一版正文。', '正文一字不改');
});

test('② 半截回复没打标记 → 补 incomplete，正文一字不改', async () => {
  setEnv({ SELF_HEAL: 'apply', SELF_HEAL_DELETE: undefined });
  const sid = 'heal-half';
  roleplaySessionStore.save(U, sid, [{ role: 'user', content: '嗯' }, { role: 'assistant', content: HALF }]);
  const run = await runSelfHealCycle({ apply: true });
  const rec = findRec(run, sid, 'HALF_REPLY_UNMARKED');
  assert.ok(rec, '应检出「半截回复没打标记」');
  assert.equal(rec!.status, 'fixed');
  assert.equal(rec!.verified, true, '修复后复查必须通过');
  const got = roleplaySessionStore.get(U, sid)!;
  assert.equal(got.length, 2, '消息条数不变');
  assert.equal(got[1].incomplete, true, '标记已落盘');
  assert.equal(got[1].content, HALF, '正文必须一字不改');
});

test('② 幂等：再跑一次不再报同一个问题（不刷屏、不重复写）', async () => {
  const before = roleplaySessionStore.getRecord(U, 'heal-half').messages;
  const tsBefore = roleplaySessionStore.listAll().find((r) => r.scenarioId === 'heal-half')!.updatedAt;
  const run = await runSelfHealCycle({ apply: true });
  assert.equal(findRec(run, 'heal-half', 'HALF_REPLY_UNMARKED'), undefined, '条件已消失 → 不再检出');
  assert.deepStrictEqual(roleplaySessionStore.getRecord(U, 'heal-half').messages, before, '数据没被再写一次');
  assert.equal(roleplaySessionStore.listAll().find((r) => r.scenarioId === 'heal-half')!.updatedAt, tsBefore, 'updatedAt 不动（没有多余写入）');
});

test('③ dry 模式：发现问题但一行数据都不动', async () => {
  setEnv({ SELF_HEAL: 'dry' });
  const sid = 'heal-dry';
  roleplaySessionStore.save(U, sid, [{ role: 'user', content: '嗯' }, { role: 'assistant', content: HALF }]);
  const run = await runSelfHealCycle();
  assert.equal(run.mode, 'dry');
  assert.equal(run.applied, false);
  const rec = findRec(run, sid, 'HALF_REPLY_UNMARKED');
  assert.ok(rec);
  assert.equal(rec!.status, 'observed');
  assert.equal(roleplaySessionStore.get(U, sid)![1].incomplete, undefined, 'dry 模式绝不改数据');
  setEnv({ SELF_HEAL: undefined });
});

test('③b off 模式：完全不跑（不扫描、不记录）', async () => {
  setEnv({ SELF_HEAL: 'off' });
  assert.equal(selfHealMode(), 'off');
  const run = await runSelfHealCycle({ apply: true });
  assert.equal(run.scanned, 0);
  assert.equal(run.detected, 0);
  assert.equal(run.records.length, 0);
  setEnv({ SELF_HEAL: undefined });
});

test('④ 末句没人接 → 只做缓解：不改数据、不替角色编台词', async () => {
  setEnv({ SELF_HEAL: 'apply' });
  const sid = 'heal-tail';
  roleplaySessionStore.save(U, sid, [{ role: 'assistant', content: '开场白。' }, { role: 'user', content: '你快点到好不好' }]);
  // now 往后拨 1 小时 → 满足「稳定静默超过阈值」（生产默认 10 分钟）
  const run = await runSelfHealCycle({ apply: true, now: Date.now() + 3600_000 });
  const rec = findRec(run, sid, 'UNANSWERED_TAIL');
  assert.ok(rec, '应检出「末句没人接」');
  assert.equal(rec!.status, 'mitigated', '这一类改不了 → 只能缓解（用户自助续接）');
  assert.equal(rec!.verified, true);
  const got = roleplaySessionStore.get(U, sid)!;
  assert.equal(got.length, 2, '数据一条不多一条不少');
  assert.equal(got[1].role, 'user');
  assert.equal(got[1].content, '你快点到好不好', '用户消息一字不改');
});

test('⑤ 历史里的系统兜底文案：默认只报告（needs_human）且不动数据；允许后清掉且真实台词保留', async () => {
  setEnv({ SELF_HEAL: 'apply', SELF_HEAL_DELETE: undefined });
  const sid = 'heal-fb';
  // save() 会把系统文案过滤掉（红线 6 护栏）→ 用 heal() 造出「历史遗留」这份脏数据（正好也验了 heal 不过滤器）
  roleplaySessionStore.save(U, sid, [{ role: 'user', content: 'a' }, { role: 'assistant', content: '真的台词。' }]);
  roleplaySessionStore.heal(U, sid, {
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: FALLBACK }, { role: 'assistant', content: '真的台词。' }],
  });
  assert.equal(roleplaySessionStore.get(U, sid)!.length, 3, 'heal() 不做兜底文案过滤（自愈要能先看见）');

  const run = await runSelfHealCycle({ apply: true });
  const rec = findRec(run, sid, 'FALLBACK_IN_HISTORY');
  assert.ok(rec, '应检出历史里的系统兜底文案');
  assert.equal(rec!.status, 'needs_human', '内容删除类默认只报告');
  assert.equal(roleplaySessionStore.get(U, sid)!.length, 3, '默认不动数据');

  setEnv({ SELF_HEAL_DELETE: '1' });
  const run2 = await runSelfHealCycle({ apply: true });
  // 同一个问题（同一个 sig）在允许删除后由 needs_human **转成** fixed，一条记录跟着状态走，不是新增一条
  const rec2 = run2.records.find((r) => r.scenarioId === sid && r.kind === 'FALLBACK_IN_HISTORY');
  assert.ok(rec2, '同一个问题应仍被检出');
  assert.equal(rec2!.status, 'fixed');
  assert.equal(rec2!.id, rec!.id, '同一问题同一条记录（id 稳定）');
  assert.equal(selfHealStore.listAll().some((r) => r.scenarioId === sid && r.status === 'needs_human'), false, '不该再挂着待人工');
  const got = roleplaySessionStore.get(U, sid)!;
  assert.equal(got.length, 2, '系统文案被删、真实台词保留');
  assert.equal(got[1].content, '真的台词。');
  assert.equal(got[0].role, 'user', 'user 消息一律不动');
  setEnv({ SELF_HEAL_DELETE: undefined });
});

test('⑤b 人工处理掉之后：下次巡检自动收口（不在卡片上永远挂着待办）', async () => {
  setEnv({ SELF_HEAL: 'apply', SELF_HEAL_DELETE: undefined });
  const sid = 'heal-fb2';
  roleplaySessionStore.save(U, sid, [{ role: 'user', content: 'a' }, { role: 'assistant', content: '真的台词。' }]);
  roleplaySessionStore.heal(U, sid, {
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: FALLBACK }, { role: 'assistant', content: '真的台词。' }],
  });
  const run = await runSelfHealCycle({ apply: true });
  const rec = findRec(run, sid, 'FALLBACK_IN_HISTORY');
  assert.ok(rec && rec.status === 'needs_human');

  // 模拟「人工自己清掉了」
  roleplaySessionStore.heal(U, sid, { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '真的台词。' }] });
  await runSelfHealCycle({ apply: true });
  const closed = selfHealStore.listAll().find((r) => r.id === rec!.id)!;
  assert.equal(closed.status, 'mitigated');
  assert.match(closed.now, /已不存在/);
});

test('⑦ 剧名快照缺失 → 从自建剧本库回填（只补元数据）', async () => {
  setEnv({ SELF_HEAL: 'apply' });
  const sc = customRoleplayStore.create('u-cs', { title: '自愈验证用剧本' });
  roleplaySessionStore.save('u-cs', sc.id, [{ role: 'user', content: '开始吧' }, { role: 'assistant', content: '好。' }]);
  assert.equal(roleplaySessionStore.getRecord('u-cs', sc.id).userPreference !== undefined, true);
  const run = await runSelfHealCycle({ apply: true });
  const rec = findRec(run, sc.id, 'TITLE_SNAPSHOT_MISSING');
  assert.ok(rec && rec.status === 'fixed', '应回填剧名快照');
  assert.equal(roleplaySessionStore.listAll().find((r) => r.scenarioId === sc.id)!.scenarioTitle, '自愈验证用剧本');
  assert.equal(roleplaySessionStore.get('u-cs', sc.id)!.length, 2, '消息没动');
});

test('⑧ 测试设备跳过：不留记录、不改数据', async () => {
  setEnv({ SELF_HEAL: 'apply' });
  const dev = 'test-dsh-selfheal-' + Date.now();
  roleplaySessionStore.save(dev, 'heal-testdev', [{ role: 'user', content: '嗯' }, { role: 'assistant', content: HALF }]);
  const run = await runSelfHealCycle({ apply: true });
  assert.ok(run.skippedTest >= 1, '应统计到跳过的测试设备');
  assert.equal(run.records.some((r) => r.userId === dev), false, '测试设备不进修复记录');
  assert.equal(roleplaySessionStore.get(dev, 'heal-testdev')![1].incomplete, undefined, '测试设备的数据也不改');
});

test('⑨ 写前备份：temp/self-heal-backup/ 真的留了原文（可回滚）', () => {
  const dir = path.join(tmpDir, 'temp', 'self-heal-backup');
  assert.ok(fs.existsSync(dir), '备份目录应存在');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('-self-heal.json'));
  assert.ok(files.length >= 1, '至少落过一份备份');
  const dump = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf-8');
  assert.match(dump, /scenarioId/, '备份里应含会话原文');
});

test('⑪ 单次修复额度用满 → 剩下的如实标 `pending`（绝不谎报"已缓解"），下一轮接着修', async () => {
  setEnv({ SELF_HEAL: 'apply', SELF_HEAL_MAX_REPAIRS: '1' });
  const a = 'heal-cap-a';
  const b = 'heal-cap-b';
  roleplaySessionStore.save(U, a, [{ role: 'user', content: 'A' }, { role: 'assistant', content: HALF }]);
  roleplaySessionStore.save(U, b, [{ role: 'user', content: 'B' }, { role: 'assistant', content: HALF }]);
  const run = await runSelfHealCycle({ apply: true, now: Date.now() + 10800_000 });
  const ra = run.records.find((r) => r.scenarioId === a && r.kind === 'HALF_REPLY_UNMARKED')!;
  const rb = run.records.find((r) => r.scenarioId === b && r.kind === 'HALF_REPLY_UNMARKED')!;
  const statuses = [ra.status, rb.status].sort();
  assert.equal(statuses.join(','), 'fixed,pending', '额度 1 → 一条 fixed、一条 pending（绝不是两条 mitigated）');
  const pendingSid = ra.status === 'pending' ? a : b;
  assert.equal(roleplaySessionStore.get(U, pendingSid)![1].incomplete, undefined, 'pending 的那条**没被动数据**');

  // 放宽额度后再巡检 → pending 的那条被修好（自我修复会自己收敛，不需要人工）
  setEnv({ SELF_HEAL_MAX_REPAIRS: '10' });
  const run2 = await runSelfHealCycle({ apply: true, now: Date.now() + 10800_000 });
  const fixedNow = run2.records.find((r) => r.scenarioId === pendingSid && r.kind === 'HALF_REPLY_UNMARKED')!;
  assert.equal(fixedNow.status, 'fixed');
  assert.equal(roleplaySessionStore.get(U, pendingSid)![1].incomplete, true);
  setEnv({ SELF_HEAL_MAX_REPAIRS: undefined });
});

test('⑫ lastRun.durationMs 有值（卡片上不是 0）', () => {
  const s = selfHealStore.summary(7);
  assert.ok(s.lastRun && typeof s.lastRun.durationMs === 'number' && s.lastRun.durationMs >= 0);
});

test('⑩ summary 形状：卡片需要 mode / totals / records / lastRun', () => {
  const s = selfHealStore.summary(7);
  assert.ok(['off', 'dry', 'apply'].includes(s.mode));
  assert.equal(typeof s.scans, 'number');
  assert.equal(typeof s.totals.fixed, 'number');
  assert.ok(Array.isArray(s.records) && s.records.length > 0);
  assert.ok(s.records.every((r) => r.cause && r.action && r.now), '每条记录都必须有 原因/处理/现状 三件事');
  assert.ok(s.lastRun && typeof s.lastRun.scanned === 'number');
  assert.ok(!/userId|@/.test(JSON.stringify(s.records.map((r) => ({ cause: r.cause, action: r.action, now: r.now })))), '报告正文里不带邮箱/内容');
});
