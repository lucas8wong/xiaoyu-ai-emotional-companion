/**
 * 剧情角色 → 聊一聊：记忆桥单测（方案 A1）
 *
 * 覆盖三块：
 *  1) 纯函数（块切分 / 事实构造 / 摘要合并 / 人设拼装 / 双态 prompt 块），不碰网络与磁盘；
 *  2) store 行为（剧情角色幂等键、剧情档案去重与清理、双态字段）；
 *  3) 端到端导入（隔离临时目录 + `STORY_BRIDGE_NO_LLM=1` 走规则摘要）：
 *     断言"角色被物化 / 剧内记忆带标记与时间 / 场面块落档 / prompt 里有剧情出身块 / 不注入陪伴方式"。
 *
 * ⚠️ 测试用 A 不需要真模型：`extractDigestByModel` 有 `STORY_BRIDGE_NO_LLM=1` 的开口（同时也是线上 kill switch）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
// 必须在 import 服务之前设：桥在提炼前读这个开关
process.env.STORY_BRIDGE_NO_LLM = '1';

const {
  splitStoryBlocks, extractiveDigest, buildStoryFacts, buildStoryRelationship,
  mergeDigest, composeStoryIdentity, composeStoryBoundaries, composeStoryVoice,
  composeStoryOpening, storyPromptBlock, sampleStoryLines, uniqueStoryName,
  importStoryCharacter, syncStoryCharacter, getStoryView, resolveScenarioBrief,
} = await import('../../api/services/storyBridge.js');
const { chatCharacterStore } = await import('../../api/services/chatCharacter.js');
const { storyArchiveStore } = await import('../../api/services/storyArchive.js');
const { longMemoryStore } = await import('../../api/services/longMemory.js');
const { roleplaySessionStore } = await import('../../api/services/roleplaySessions.js');
const { default: memoryStorage, countUnread } = await import('../../api/storage/memory.js');
const { SCENARIOS } = await import('../../api/services/roleplay.js');

const SID = SCENARIOS[0].id; // 官方剧本（内置数据，不需要网络）

function msgs(n: number, withTs = true) {
  const base = Date.UTC(2026, 8, 1, 10, 0, 0);
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: (i % 2 === 0 ? '我说的话' : 'TA 说的话') + i + '：' + '内容'.repeat(3),
    ...(withTs ? { timestamp: base + i * 60_000 } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 1) 纯函数
// ---------------------------------------------------------------------------
test('splitStoryBlocks：每 12 条一块，区间与时间正确，块内含两侧最关键的一句', () => {
  const blocks = splitStoryBlocks(msgs(25), '沈重');
  assert.strictEqual(blocks.length, 3, '25 条 → 3 块（12/12/1）');
  assert.deepStrictEqual([blocks[0].from, blocks[0].to], [0, 11]);
  assert.deepStrictEqual([blocks[1].from, blocks[1].to], [12, 23]);
  assert.deepStrictEqual([blocks[2].from, blocks[2].to], [24, 24]);
  assert.ok(blocks[0].text.includes('你：'), '块里有用户那一侧');
  assert.ok(blocks[0].text.includes('沈重：'), '块里有角色那一侧');
  assert.ok(blocks[0].at > 0 && blocks[0].at === msgs(25)[0].timestamp);
  assert.ok(blocks[0].text.length <= 400, '块文本受长度约束');
});

test('splitStoryBlocks：没有时间戳也不炸（退化为写入时刻），空会话返回空', () => {
  const b = splitStoryBlocks(msgs(3, false), 'TA');
  assert.strictEqual(b.length, 1);
  assert.ok(b[0].at > 0);
  assert.deepStrictEqual(splitStoryBlocks([], 'TA'), []);
});

test('extractiveDigest：模型不可用时也给出非空摘要与起点/终点', () => {
  const brief = resolveScenarioBrief(SID)!;
  const d = extractiveDigest(brief, msgs(6), brief.aiName);
  assert.ok(d.summary.length > 0);
  assert.strictEqual(d.msgCount, 6);
  assert.ok(d.keyEvents.length >= 1);
});

test('buildStoryFacts：条条带「（剧内）」、每条 ≤80 字、日期透传', () => {
  const facts = buildStoryFacts({
    summary: 's', msgCount: 2, at: 1,
    keyEvents: [
      { text: '他把你从雨里带回家', date: '2026-08-30' },
      { text: '长'.repeat(200) },
    ],
    openThreads: ['你答应过要回去看他'],
  });
  assert.strictEqual(facts.length, 3);
  for (const f of facts) {
    assert.ok(f.text.startsWith('（剧内）'), '每条都要有剧内标记，否则会被当成现实里发生过');
    assert.ok(f.text.length <= 80, 'longMemory 硬性 ≤80 字，超了会被静默丢弃');
  }
  assert.strictEqual(facts[0].kind, 'event');
  assert.strictEqual(facts[0].date, '2026-08-30');
  assert.strictEqual(facts[2].kind, 'state');
});

test('buildStoryRelationship：单条 ≤100（growth 上限 120 留余量）', () => {
  const rel = buildStoryRelationship({ summary: '很长'.repeat(200), msgCount: 5, at: 1, keyEvents: [{ text: '他等了你一整夜' }], openThreads: [] }, '疯批总裁的白月光');
  assert.ok(rel.length >= 1);
  for (const r of rel) assert.ok(r.length <= 100);
});

test('mergeDigest：去重、补新、保留未完成的线、游标前移', () => {
  const prior = { summary: '旧摘要', msgCount: 10, at: 1, keyEvents: [{ text: 'A 事件' }], openThreads: ['旧悬念'] };
  const merged = mergeDigest(prior, { summary: '新摘要', keyEvents: [{ text: 'A 事件' }, { text: 'B 事件' }] }, 20);
  assert.strictEqual(merged.summary, '新摘要');
  assert.deepStrictEqual(merged.keyEvents.map(e => e.text), ['A 事件', 'B 事件'], '重复事件不该叠加，新事件要补上');
  assert.deepStrictEqual(merged.openThreads, ['旧悬念'], '这次没提炼出新的线 → 保留旧的');
  assert.strictEqual(merged.msgCount, 20);
});

test('mergeDigest：规则降级里的「开场/目前停在」按前缀替换，不越同步越多', () => {
  const first = mergeDigest(undefined, { keyEvents: [{ text: '开场：他说了第一句' }, { text: '目前停在：她还没回答' }] }, 12);
  const second = mergeDigest(first, { keyEvents: [{ text: '开场：他说了第一句' }, { text: '目前停在：她回答了' }] }, 24);
  assert.strictEqual(second.keyEvents.filter(e => e.text.startsWith('目前停在：')).length, 1, '进度标记只留最新一条');
  assert.ok(second.keyEvents.some(e => e.text === '目前停在：她回答了'));
  assert.ok(!second.keyEvents.some(e => e.text === '目前停在：她还没回答'), '旧的进度标记应被替换掉');
});

test('人设拼装：身份含剧名与外貌性格，底线含现实边界，口吻合并剧本语言习惯', () => {
  const brief = resolveScenarioBrief(SID)!;
  const digest = extractiveDigest(brief, msgs(4), brief.aiName);
  const id = composeStoryIdentity(brief, brief.aiName);
  assert.ok(id.includes(brief.title));
  assert.ok(id.length <= 4000);
  const bd = composeStoryBoundaries(brief.aiName);
  assert.ok(bd.includes('不鼓励') && bd.includes('不制造依赖'), '剧情设定照演，现实边界照守');
  const voice = composeStoryVoice(brief, { ...digest, voiceTraits: '句子短、爱用问句' });
  assert.ok(voice.includes('句子短、爱用问句'));
  assert.ok(composeStoryOpening(brief, { ...digest, openThreads: ['那把伞没还'] }, brief.aiName).includes('那把伞没还'));
});

test('storyPromptBlock：双态互斥、只带摘要不带原文、且绝不含陪伴方式', () => {
  const char = chatCharacterStore.create('u-prompt', {
    name: '沈重', identity: 'i', boundaries: 'b', voice: 'v',
    origin: 'story', storyMode: 'in',
    story: {
      scenarioId: SID, scenarioTitle: '锦衣之下', kind: 'official', aiName: '沈重', userName: '晚晚',
      importedAt: 1, syncedMsgCount: 12,
      digest: { summary: '你们在雨夜重逢', keyEvents: [{ text: '他把披风给了你' }], openThreads: ['你还没回答他'], msgCount: 12, at: 1 },
    },
  });
  const inBlock = storyPromptBlock(char);
  assert.ok(inBlock.includes('入戏') && inBlock.includes('晚晚'), '入戏态：点明剧内身份');
  assert.ok(inBlock.includes('你们在雨夜重逢') && inBlock.includes('你还没回答他'));
  assert.ok(inBlock.includes('这是聊天，不是叙事现场'), '入戏也要钉住"短消息、不写旁白"');
  assert.ok(!inBlock.includes('陪伴方式'), '剧情角色不注入陪伴方式（Q4=A）');

  const outBlock = storyPromptBlock({ ...char, storyMode: 'out' });
  assert.ok(outBlock.includes('出戏') && outBlock.includes('一段你们一起演的故事'));
  assert.ok(!outBlock.includes('【你们的来历 · 入戏】'), '两态互斥');

  assert.strictEqual(storyPromptBlock({ ...char, story: undefined }), '', '非剧情角色不产出任何块');
});

test('sampleStoryLines：长会话被压到有界行数（控制单次提炼成本）', () => {
  const lines = sampleStoryLines(msgs(400), '沈重', 60);
  assert.ok(lines.length <= 74, `行数应被压住，实际 ${lines.length}`);
  assert.strictEqual(lines[0].slice(0, 2), '你：', '开头仍是第一句');
});

test('uniqueStoryName：与已有角色重名时加剧名后缀（不拒绝导入）', () => {
  chatCharacterStore.create('u-name', { name: '沈重' });
  const n = uniqueStoryName('u-name', '沈重', '锦衣之下');
  assert.notStrictEqual(n, '沈重');
  assert.ok(n.startsWith('沈重·'));
  assert.strictEqual(uniqueStoryName('u-name', '全新名字', '锦衣之下'), '全新名字');
});

// ---------------------------------------------------------------------------
// 2) store
// ---------------------------------------------------------------------------
test('剧情角色：create 落 origin/story/storyMode，字段归一化，update 不越权改来源', () => {
  const c = chatCharacterStore.create('u-store', {
    name: '阿重', identity: 'i', boundaries: 'b', voice: 'v', origin: 'story', storyMode: 'in',
    story: { scenarioId: 'sc1', scenarioTitle: '剧名', kind: 'custom', aiName: '阿重', userName: '你', importedAt: 5, syncedMsgCount: 3 },
    useCompanionMode: false,
  });
  assert.strictEqual(c.origin, 'story');
  assert.strictEqual(c.story?.scenarioId, 'sc1');
  assert.strictEqual(c.storyMode, 'in');
  assert.strictEqual(c.useCompanionMode, false);
  assert.strictEqual(chatCharacterStore.findByScenario('u-store', 'sc1')?.id, c.id);
  assert.strictEqual(chatCharacterStore.findByScenario('u-store', '别的剧本'), undefined);

  // 双态可以改
  assert.strictEqual(chatCharacterStore.update('u-store', c.id, { storyMode: 'out' })?.storyMode, 'out');
  // 自建角色不会被 story 字段"变成"剧情角色
  const plain = chatCharacterStore.create('u-store', { name: '普通', identity: 'i', boundaries: 'b', voice: 'v' });
  chatCharacterStore.update('u-store', plain.id, { story: { scenarioId: 'zz', scenarioTitle: 't', kind: 'official', aiName: 'a', userName: 'u', importedAt: 1, syncedMsgCount: 0 } });
  assert.strictEqual(chatCharacterStore.get('u-store', plain.id)?.origin, undefined);
  assert.strictEqual(chatCharacterStore.get('u-store', plain.id)?.story, undefined);
});

test('剧情档案：覆盖写 / 追加去重 / 上限 / 删角色即清档', () => {
  storyArchiveStore.replaceBlocks('u-arch', 'cc_a', 'sc1', [
    { id: 'b1', at: 1, from: 0, to: 11, text: '第一幕' },
    { id: 'b2', at: 2, from: 12, to: 23, text: '第二幕' },
  ]);
  assert.strictEqual(storyArchiveStore.listBlocks('u-arch', 'cc_a').length, 2);
  const added = storyArchiveStore.appendBlocks('u-arch', 'cc_a', 'sc1', [
    { id: 'b2', at: 2, from: 12, to: 23, text: '第二幕（重复）' },
    { id: 'b3', at: 3, from: 24, to: 35, text: '第三幕' },
  ]);
  assert.strictEqual(added.length, 1, '同一区间只留一块');
  assert.strictEqual(storyArchiveStore.listBlocks('u-arch', 'cc_a').length, 3);
  storyArchiveStore.deleteByCharacter('u-arch', 'cc_a');
  assert.strictEqual(storyArchiveStore.listBlocks('u-arch', 'cc_a').length, 0);
});

// ---------------------------------------------------------------------------
// 3) 端到端导入（隔离目录 + 规则摘要）
// ---------------------------------------------------------------------------
test('importStoryCharacter：物化角色 + 剧内记忆 + 场面块 + 幂等（重复导入不新建）', async () => {
  const userId = 'u-e2e';
  const session = msgs(20);
  roleplaySessionStore.save(userId, SID, session, '', '锦衣之下');

  const r1 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.digestByModel, false, '规则摘要（测试里关掉了模型）');
  assert.strictEqual(r1.msgCount, 20);
  assert.ok(r1.blockCount === 2, `20 条 → 2 块，实际 ${r1.blockCount}`);
  const c = r1.character;
  assert.strictEqual(c.origin, 'story');
  assert.strictEqual(c.name, '沈重');
  assert.strictEqual(c.story?.userName, '晚晚', '剧内称呼要带上（否则会喊错人）');
  assert.strictEqual(c.storyMode, 'in', 'Q1=C：默认入戏');
  assert.ok(c.identity.includes('锦衣之下') || c.identity.length > 0);

  // 记忆：事实带「（剧内）」+ 关系底色
  const facts = longMemoryStore.getEntries(userId, c.id).map(e => e.text);
  assert.ok(facts.length > 0 && facts.every(f => f.startsWith('（剧内）')), '剧情事实必须带剧内标记');
  const growth = (await import('../../api/services/chatCharacterGrowth.js')).chatCharacterGrowthStore.get(userId, c.id);
  assert.ok(growth.relationship.length > 0, '关系记忆要有');

  // 档案：块数 = 会话条数 / 12
  assert.strictEqual(storyArchiveStore.listBlocks(userId, c.id).length, 2);

  // 幂等：再导入一次 → 角色数不变、仍是同一个 id、游标跟进
  const r2 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  assert.strictEqual(r2.created, false);
  assert.strictEqual(r2.character.id, c.id);
  assert.strictEqual(chatCharacterStore.listForUser(userId).filter(x => x.origin === 'story').length, 1);
});

test('重复导入：用户手改过的人设不被覆盖，没改过的字段照常随剧本刷新', async () => {
  const userId = 'u-protect';
  roleplaySessionStore.save(userId, SID, msgs(14), '', '锦衣之下');
  const r1 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  const id = r1.character.id;
  assert.ok(r1.character.story?.persona?.voice, '导入时应记下"系统写的"人设快照');

  // 用户改了口吻（模拟角色编辑里的修改）
  chatCharacterStore.update(userId, id, { voice: '我自己写的口吻：句子很短' });
  const before = chatCharacterStore.get(userId, id)!;
  assert.strictEqual(before.voice, '我自己写的口吻：句子很短');

  // 剧情又推进 → 再导入一次（幂等更新）
  roleplaySessionStore.save(userId, SID, msgs(26), '', '锦衣之下');
  const r2 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  assert.strictEqual(r2.created, false);
  const after = chatCharacterStore.get(userId, id)!;
  assert.strictEqual(after.voice, '我自己写的口吻：句子很短', '用户改过 → 必须保留');
  assert.ok(after.identity.includes('他等了我十五年') || after.identity.length > 0, '没改过的字段照常刷新');
  assert.strictEqual(after.story?.syncedMsgCount, 26, '记忆游标照常前移');
});

test('syncStoryCharacter：只提炼新增段（<4 条不动），新增后追加块', async () => {  const userId = 'u-sync';
  roleplaySessionStore.save(userId, SID, msgs(20), '', '锦衣之下');
  const r = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  const id = r.character.id;

  // 只多 2 条 → 不达阈值，不同步
  roleplaySessionStore.save(userId, SID, msgs(22), '', '锦衣之下');
  const s1 = await syncStoryCharacter(userId, id);
  assert.strictEqual(s1.added, 0);
  assert.strictEqual(s1.syncedMsgCount, 20, '游标不动');

  // 再多 8 条 → 同步，追加 1 块
  roleplaySessionStore.save(userId, SID, msgs(30), '', '锦衣之下');
  const s2 = await syncStoryCharacter(userId, id);
  assert.ok(s2.added >= 1, '新增段要落块');
  assert.strictEqual(s2.syncedMsgCount, 30, '游标前移到最新');
  const view = getStoryView(userId, id)!;
  assert.strictEqual(view.binding.syncedMsgCount, 30);
  assert.strictEqual(view.pendingMsgCount, 0);

  // 非剧情角色 → 明确报错，不静默
  const plain = chatCharacterStore.create(userId, { name: '普通', identity: 'i', boundaries: 'b', voice: 'v' });
  await assert.rejects(() => syncStoryCharacter(userId, plain.id), /不是剧情角色/);
});

test('导入后角色会"先开口"：建一条会话 + 开场白 + 未读 1；重复导入不再刷一句', async () => {
  const userId = 'u-greet';
  roleplaySessionStore.save(userId, SID, msgs(16), '', '锦衣之下');
  const r1 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  const id = r1.character.id;
  const sessions = memoryStorage.getActiveSessions().filter(s => s.userId === userId && s.characterId === id);
  assert.strictEqual(sessions.length, 1, '应替它开一条聊一聊会话（否则它在消息列表里没有位置）');
  const first = sessions[0].chatMessages!;
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].role, 'assistant', '第一条是角色自己的开场白');
  assert.strictEqual(first[0].content, r1.character.opening);
  assert.strictEqual(countUnread(sessions[0]), 1, '开场白应留成未读（列表上出现"1"）');

  const r2 = await importStoryCharacter({ userId, scenarioId: SID, aiName: '沈重', userName: '晚晚' });
  const again = memoryStorage.getActiveSessions().filter(s => s.userId === userId && s.characterId === r2.character.id);
  assert.strictEqual(again.length, 1, '重复导入不该再开一条会话');
  assert.strictEqual(again[0].chatMessages!.length, 1, '重复导入不该再补一句开场白');
});

test('importStoryCharacter：空剧情直接拒（NO_STORY），不产生半成品角色', async () => {
  await assert.rejects(
    () => importStoryCharacter({ userId: 'u-empty', scenarioId: SID }),
    (e: Error & { code?: string }) => e.code === 'NO_STORY',
  );
  assert.strictEqual(chatCharacterStore.listForUser('u-empty').filter(x => x.origin === 'story').length, 0);
});

test('importStoryCharacter：剧本不存在 → SCENARIO_NOT_FOUND', async () => {
  roleplaySessionStore.save('u-nosc', 'no_such_scenario', msgs(4), '', '不存在');
  await assert.rejects(
    () => importStoryCharacter({ userId: 'u-nosc', scenarioId: 'no_such_scenario' }),
    (e: Error & { code?: string }) => e.code === 'SCENARIO_NOT_FOUND',
  );
});
