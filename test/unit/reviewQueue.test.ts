/**
 * 审阅队列构建器单测。
 *
 * 本模块零 I/O，所以这里**全部是编造的假数据**，不读 data/（AGENTS.md 红线 3）。
 * 重点不在「功能对不对」，而在**产出物里绝对没有身份**——这是这次改动的全部意义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewQueue,
  findIdentityLeaks,
  assertDeidentified,
  summarizeItem,
  SAMPLE_KEY_VERSION,
} from '../../api/services/reviewQueue';

const USER = 'u_abc12345';        // 编造的 userId（≥8 字符才会被泄露检查盯上，见 findIdentityLeaks 阈值说明）
const USER_EMAIL = 'xiaoming@example.com';
const OTHER = 'u_def67890';

/** 固定代号，便于断言；生产用随机 */
function seqIds() {
  let n = 0;
  return () => `rv_test${++n}`;
}

const chatSession = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess_11112222',
  userId: USER,
  chatTitle: '最近有点累',
  chatUpdatedAt: new Date('2026-01-10T09:00:00Z'),
  chatMessages: [
    { role: 'user', content: '你好', timestamp: new Date('2026-01-10T08:00:00Z') },
    { role: 'assistant', content: '我在呀', timestamp: new Date('2026-01-10T08:00:05Z') },
    { role: 'user', content: '我电话 13812345678，想聊聊', timestamp: new Date('2026-01-10T08:01:00Z') },
    { role: 'assistant', content: '嗯，慢慢说', timestamp: new Date('2026-01-10T08:01:04Z') },
  ],
  ...over,
});

const roleplayRecord = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  scenarioId: 'custom_secret_999',
  scenarioTitle: '雨夜书店',
  userPreference: '希望角色更主动一点',
  updatedAt: new Date('2026-01-11T20:00:00Z'),
  messages: [
    { role: 'user', content: '我们进店里避雨吧', timestamp: new Date('2026-01-11T19:00:00Z') },
    { role: 'assistant', content: '他推开门，铃铛响了一声。', timestamp: new Date('2026-01-11T19:00:06Z'), viaUnlimited: true, model: 'deepseek-unrestricted' },
    { role: 'user', content: '他靠得更近一点', timestamp: new Date('2026-01-11T19:01:00Z') },
    { role: 'assistant', content: '他停住了，没有动。', timestamp: new Date('2026-01-11T19:01:05Z'), viaUnlimited: true, model: 'deepseek-unrestricted' },
  ],
  ...over,
});

test('基本构建：聊一聊与剧情都产出，代号是 rv_ 前缀', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession()],
    roleplayRecords: [roleplayRecord()],
    idFactory: seqIds(),
  });
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.kind).sort(), ['chat', 'roleplay']);
  for (const it of r.items) assert.match(it.reviewId, /^rv_/);
  // 用户轮数 2 / assistant 轮数 2
  assert.equal(r.items[0].userTurns, 2);
  assert.equal(r.items[0].turnCount, 2);
});

test('★ 硬约束：产出物里没有任何身份键，也不含已知身份值', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession()],
    roleplayRecords: [roleplayRecord()],
    idFactory: seqIds(),
  });
  const problems = findIdentityLeaks(r.items, [USER, OTHER, USER_EMAIL]);
  assert.deepEqual(problems, [], `不应有泄露，实际：${problems.join('; ')}`);

  // 显式点名：这几个键是三条回溯路径（能反查到用户/作者）
  const dumped = JSON.stringify(r.items);
  for (const k of ['userId', 'sessionId', 'scenarioId', 'email', 'phone', 'username', 'characterId']) {
    assert.equal(dumped.includes(`"${k}"`), false, `产出物不应出现键 ${k}`);
  }
  // 原始值也不能出现
  assert.equal(dumped.includes(USER), false);
  assert.equal(dumped.includes('custom_secret_999'), false);
  assert.equal(dumped.includes('sess_11112222'), false);
});

test('★ 绝对时间只到分钟（不含秒/毫秒），ISO 时刻与秒级锚点都不进产出物', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession()],
    roleplayRecords: [roleplayRecord()],
    idFactory: seqIds(),
  });
  const dumped = JSON.stringify(r.items);
  // 秒级绝对时刻才是能唯一定位到某一次请求的重识别锚点（口径见 reviewQueue 文件头），
  // 所以产出物里既不能有 ISO 字符串，2 个时间字段也必须是整分钟。
  assert.equal(/T\d{2}:\d{2}:\d{2}/.test(dumped), false, '产出物不应含 ISO 时刻');
  assert.equal(dumped.includes('2026-01-10T'), false);

  const chat = r.items.find((i) => i.kind === 'chat')!;
  assert.equal(chat.date, '2026-01-10');
  // 首条 08:00:00Z、末条 08:01:04Z → 都截断到分钟
  assert.equal(chat.startedAt, Date.parse('2026-01-10T08:00:00Z'));
  assert.equal(chat.lastAt, Date.parse('2026-01-10T08:01:00Z'));
  assert.equal(chat.startedAt % 60_000, 0, 'startedAt 必须是整分钟');
  assert.equal(chat.lastAt % 60_000, 0, 'lastAt 必须是整分钟');

  // 对话**内部**的节奏仍精确：首条为 0，后续是真实间隔（审阅「AI 回了多久」靠它）
  assert.equal(chat.messages[0].offsetMs, 0);
  assert.equal(chat.messages[2].offsetMs, 60_000); // 08:00:00 → 08:01:00
  assert.equal(chat.meta.spanMs, 64_000);
});

test('★ 基础设置快照：白名单外的一律进不来（含以剧本 id 为 key 的表）', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession()],
    roleplayRecords: [roleplayRecord()],
    idFactory: seqIds(),
    // 故意多塞：userId / 剧本表 / 自由文本 / 超长值 / 错类型 —— 一个都不该出现在产出物里
    getUserSettings: () => ({
      mode: 'hug',
      thinkingLevel: 'max',
      region: 'yuegang',
      chatInnerMonologue: false,
      roleplayUnlimited: true,
      userId: USER,
      roleplayUnlimitedByScenario: { custom_secret_999: true },
      timezone: 'Asia/Hong_Kong',
      note: '自由文本不该从这条路进来',
      storyStyle: 'x'.repeat(200),
      intensity: 123 as unknown as string,
    }),
  });
  const chat = r.items.find((i) => i.kind === 'chat')!;
  assert.deepEqual(chat.settings, {
    mode: 'hug',
    thinkingLevel: 'max',
    region: 'yuegang',
    chatInnerMonologue: false,
    roleplayUnlimited: true,
  });
  const dumped = JSON.stringify(r.items);
  assert.equal(dumped.includes(USER), false);
  assert.equal(dumped.includes('custom_secret_999'), false, '剧本 id 绝不能顺着设置进来');
  assert.equal(dumped.includes('Asia/Hong_Kong'), false);
  assert.equal(dumped.includes('自由文本不该'), false);
  assert.deepEqual(findIdentityLeaks(r.items, [USER]), []);
});

test('没提供 getter 时 settings 为 null（老队列口径），不抛异常', () => {
  const r = buildReviewQueue({ chatSessions: [chatSession()], idFactory: seqIds() });
  assert.equal(r.items[0].settings, null);
});

test('★ sampleKey（v3）：跨重建稳定、**续写不换键**（已读才掉不了），换开头才换键', () => {
  const a = buildReviewQueue({ chatSessions: [chatSession()], idFactory: seqIds() });
  const b = buildReviewQueue({ chatSessions: [chatSession()], idFactory: seqIds() });
  assert.match(a.items[0].sampleKey, /^sk_[0-9a-f]{16}$/);
  assert.equal(a.items[0].keyVersion, SAMPLE_KEY_VERSION, 'v3 口径：指纹锚「类型 + 首条时刻 + 前两条用户发言」');
  assert.equal(a.items[0].sampleKey, b.items[0].sampleKey, '重建后同一段对话要保持同一个键');
  // 代号必须每次随机（随机 = 不可反推），而指纹必须稳定——两者的区别正是已读追踪能成立的原因
  const d1 = buildReviewQueue({ chatSessions: [chatSession()] });
  const d2 = buildReviewQueue({ chatSessions: [chatSession()] });
  assert.notEqual(d1.items[0].reviewId, d2.items[0].reviewId, '代号每次随机才是去标识化的前提');
  assert.equal(d1.items[0].sampleKey, d2.items[0].sampleKey, '指纹必须跨随机代号稳定');

  /**
   * v2 的关键修复：同一段对话**续写**（尾部多了消息）之后身份不变。
   * 老口径（v1 把尾条也算进指纹）下这里会换新键 —— 于是用户又聊两句之后，
   * 他之前标的「已读」会莫名其妙回到未读，增量档案也会把同一段对话记成两条。
   */
  const grown = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        ...chatSession().chatMessages,
        { role: 'user', content: '今天好一点了', timestamp: new Date('2026-01-10T08:02:00Z') },
        { role: 'assistant', content: '那就好', timestamp: new Date('2026-01-10T08:02:04Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  assert.equal(grown.items[0].sampleKey, a.items[0].sampleKey, '续写不该换身份键（换了已读就掉）');
  // 但内容确实变多了：指纹不带尾条，正文照样刷新
  assert.equal(grown.items[0].messages.length, 6);

  // 换的是**开头**（另一段对话）→ 必须换键
  const changed = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        { role: 'user', content: '换了一句话', timestamp: new Date('2026-01-10T08:00:00Z') },
        { role: 'assistant', content: '嗯', timestamp: new Date('2026-01-10T08:00:05Z') },
        { role: 'user', content: '再说一句', timestamp: new Date('2026-01-10T08:01:00Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  assert.notEqual(changed.items[0].sampleKey, a.items[0].sampleKey);
  // 指纹里不能带身份：拿 userId 当输入的话这里就会露
  assert.equal(a.items[0].sampleKey.includes(USER), false);
});

test('★ v3 锚「前两条用户发言」：首句相同、第二句不同的两段对话不再撞键（v2 只锚首句会撞）', () => {
  const twoTurns = (second: string) => chatSession({
    chatMessages: [
      { role: 'user', content: '你好，我想聊聊最近的事', timestamp: new Date('2026-01-10T08:00:00Z') },
      { role: 'assistant', content: '我在，你说', timestamp: new Date('2026-01-10T08:00:05Z') },
      { role: 'user', content: second, timestamp: new Date('2026-01-10T08:01:00Z') },
      { role: 'assistant', content: '嗯，我听着', timestamp: new Date('2026-01-10T08:01:04Z') },
    ],
  });
  const a = buildReviewQueue({ chatSessions: [twoTurns('工作上被否定了几次有点撑不住')], idFactory: seqIds() });
  const b = buildReviewQueue({ chatSessions: [twoTurns('其实是家里的事情让我睡不好')], idFactory: seqIds() });
  // 起始分钟与第一句话都相同 → v2 口径下这两条会撞成一个键（等于丢一条）
  assert.notEqual(a.items[0].sampleKey, b.items[0].sampleKey, '第二句不同就是两段对话，不能撞键');
  // 而「续写」不改前两条 → 仍是同一条
  const again = buildReviewQueue({ chatSessions: [twoTurns('工作上被否定了几次有点撑不住')], idFactory: seqIds() });
  assert.equal(again.items[0].sampleKey, a.items[0].sampleKey);
});

test('逐条带上审阅维度：叙事模式 / 无限制标记 / 半截 / 模型（仅 assistant）', () => {
  const r = buildReviewQueue({
    chatSessions: [],
    roleplayRecords: [roleplayRecord({
      messages: [
        { role: 'user', content: '我们进店里避雨吧', timestamp: new Date('2026-01-11T19:00:00Z') },
        { role: 'assistant', content: '他推开门。', timestamp: new Date('2026-01-11T19:00:06Z'), viaUnlimited: true, model: 'deepseek-unrestricted', style: 'immersive' },
        { role: 'user', content: '他靠得更近一点', timestamp: new Date('2026-01-11T19:01:00Z') },
        { role: 'assistant', content: '他停住了', timestamp: new Date('2026-01-11T19:01:05Z'), viaUnlimited: false, style: 'immersive', incomplete: true },
      ],
    })],
    idFactory: seqIds(),
  });
  const it = r.items[0];
  assert.equal(it.messages[0].style, undefined, '用户消息不该带叙事模式');
  assert.equal(it.messages[1].style, 'immersive');
  assert.equal(it.messages[1].viaUnlimited, true);
  assert.equal(it.messages[1].model, 'deepseek-unrestricted');
  assert.equal(it.messages[3].incomplete, true);
  // 条目级聚合：扫列表时不点开也能看到「这段是沉浸档」
  assert.deepEqual(it.meta.styleCounts, { immersive: 2 });
  // 半截回复的判据（收尾必须完整）在真实数据里出现过，标记必须原样带出来
  assert.equal(JSON.stringify(r.items).includes('deepseek-unrestricted'), true);
});

test('★ dataEnhance 关闭的用户不进队列（这个开关第一次真正生效）', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession(), chatSession({ userId: OTHER })],
    roleplayRecords: [roleplayRecord()],
    // 模拟 preferenceStore.get(id).dataEnhance !== false
    shouldInclude: (id: string) => id !== USER,
    idFactory: seqIds(),
  });
  assert.equal(r.stats.skippedByDataEnhance, 2); // 该用户的 chat + roleplay 各一条
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].reviewId, 'rv_test1');
  assert.equal(JSON.stringify(r.items).includes(USER), false);
});

test('★ 测试/开发身份默认整条排除，且与 dataEnhance 分开计数', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession(), chatSession({ userId: 'test-device-01' })],
    roleplayRecords: [roleplayRecord({ userId: 'u_test2222' })],
    isTestUser: (id: string) => id.startsWith('test-') || id === 'u_test2222',
    idFactory: seqIds(),
  });
  assert.equal(r.stats.skippedTest, 2);
  // 关键：两档不能混在一起数，否则「跳过的都是为什么」说不清
  assert.equal(r.stats.skippedByDataEnhance, 0);
  assert.equal(r.items.length, 1);
  const dumped = JSON.stringify(r.items);
  assert.equal(dumped.includes('test-device-01'), false);
  assert.equal(dumped.includes('u_test2222'), false);
  // 默认不出现 test 字段（整类都没收，没必要标）
  assert.equal('test' in r.items[0], false);
});

test('includeTest: true 才收测试身份，条目带 test:true；但仍计数且仍无身份值', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession(), chatSession({ userId: 'test-device-01' })],
    isTestUser: (id: string) => id.startsWith('test-'),
    includeTest: true,
    idFactory: seqIds(),
  });
  assert.equal(r.items.length, 2);
  assert.equal(r.stats.skippedTest, 1); // 仍如实告诉你「其中 1 条是自测的」
  assert.equal(r.items.filter((i) => i.test === true).length, 1);
  // 标记归标记：身份值照旧一个都不能出现（test 字段不是放行身份的口子）
  assert.equal(JSON.stringify(r.items).includes('test-device-01'), false);
  assert.deepEqual(findIdentityLeaks(r.items, ['test-device-01']), []);
});

test('两档叠加只计测试档：同一条不会既算测试又算 dataEnhance', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession({ userId: 'test-x' })],
    isTestUser: (id: string) => id.startsWith('test-x'),
    shouldInclude: () => false,
    idFactory: seqIds(),
  });
  assert.equal(r.stats.skippedTest, 1);
  assert.equal(r.stats.skippedByDataEnhance, 0);
  assert.equal(r.items.length, 0);
});

test('正文里的自报身份被洗掉，并记录洗了什么', () => {
  const r = buildReviewQueue({ chatSessions: [chatSession()], idFactory: seqIds() });
  const dumped = JSON.stringify(r.items);
  assert.equal(dumped.includes('13812345678'), false);
  assert.ok(r.items[0].scrubbed.includes('手机号×1'), `实际：${r.items[0].scrubbed.join(',')}`);
  assert.equal(r.stats.scrubHits['手机号'], 1);
});

test('标题与用户反馈也要脱敏（用户自起的名里可能带身份）', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession({ chatTitle: '我是 13812345678 的主人' })],
    idFactory: seqIds(),
  });
  assert.equal(JSON.stringify(r.items).includes('13812345678'), false);
  assert.equal(r.items[0].meta.title, '我是 [手机号] 的主人');
});

test('viaUnlimited 元数据：true / false / 老数据 null 三态正确', () => {
  const unlimited = buildReviewQueue({ roleplayRecords: [roleplayRecord()], idFactory: seqIds() });
  assert.equal(unlimited.items[0].meta.viaUnlimited, true);
  assert.equal(unlimited.items[0].meta.unlimitedTurns, 2);
  assert.equal(unlimited.items[0].meta.markedTurns, 2);
  assert.equal(unlimited.items[0].meta.model, 'deepseek-unrestricted');

  const conservative = buildReviewQueue({
    roleplayRecords: [
      roleplayRecord({
        messages: [
          { role: 'user', content: 'a', timestamp: new Date('2026-01-11T19:00:00Z') },
          { role: 'assistant', content: 'b', timestamp: new Date('2026-01-11T19:00:01Z'), viaUnlimited: false },
          { role: 'user', content: 'c', timestamp: new Date('2026-01-11T19:00:02Z') },
          { role: 'assistant', content: 'd', timestamp: new Date('2026-01-11T19:00:03Z'), viaUnlimited: false },
        ],
      }),
    ],
    idFactory: seqIds(),
  });
  assert.equal(conservative.items[0].meta.viaUnlimited, false);
  assert.equal(conservative.items[0].meta.unlimitedTurns, 0);

  // 老数据没打标记 → null（不是 false！false 会被误读成「确实走了保守模型」）
  const legacy = buildReviewQueue({
    roleplayRecords: [
      roleplayRecord({
        messages: [
          { role: 'user', content: 'a', timestamp: new Date('2026-01-11T19:00:00Z') },
          { role: 'assistant', content: 'b', timestamp: new Date('2026-01-11T19:00:01Z') },
          { role: 'user', content: 'c', timestamp: new Date('2026-01-11T19:00:02Z') },
          { role: 'assistant', content: 'd', timestamp: new Date('2026-01-11T19:00:03Z') },
        ],
      }),
    ],
    idFactory: seqIds(),
  });
  assert.equal(legacy.items[0].meta.viaUnlimited, null);
  assert.equal(legacy.items[0].meta.markedTurns, 0);
});

test('过滤与截取：minUserTurns 滤掉无信息量样本，limit 按最近优先截取', () => {
  const thin = chatSession({
    userId: OTHER,
    chatMessages: [
      { role: 'user', content: '在吗', timestamp: new Date('2026-01-09T08:00:00Z') },
      { role: 'assistant', content: '在的', timestamp: new Date('2026-01-09T08:00:01Z') },
    ],
  });
  const r = buildReviewQueue({ chatSessions: [chatSession(), thin], idFactory: seqIds() });
  assert.equal(r.items.length, 1); // 只有 1 轮用户发言的被滤掉
  assert.equal(r.stats.skippedByFilter, 1);

  // 排序按**末条消息时间**（比 chatUpdatedAt 更贴近对话真实结束时刻），
  // 所以 fixture 要把新会话的消息时间也调新，否则两条时间相同、顺序无意义。
  const limited = buildReviewQueue({
    chatSessions: [
      chatSession({
        userId: OTHER,
        chatUpdatedAt: new Date('2026-01-12T09:00:00Z'),
        chatMessages: [
          { role: 'user', content: 'a', timestamp: new Date('2026-01-12T08:00:00Z') },
          { role: 'assistant', content: 'b', timestamp: new Date('2026-01-12T08:00:01Z') },
          { role: 'user', content: 'c', timestamp: new Date('2026-01-12T08:01:00Z') },
          { role: 'assistant', content: 'd', timestamp: new Date('2026-01-12T08:01:01Z') },
        ],
      }),
      chatSession(),
    ],
    limit: 1,
    idFactory: seqIds(),
  });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.items[0].date, '2026-01-12'); // 最近的那条
});

test('附件只记数量：图片/语音的 base64 绝不进队列', () => {
  const r = buildReviewQueue({
    chatSessions: [
      chatSession({
        chatMessages: [
          { role: 'user', content: '看看这个', timestamp: new Date('2026-01-10T08:00:00Z'), image: 'data:image/png;base64,AAAB' },
          { role: 'assistant', content: '看到了', timestamp: new Date('2026-01-10T08:00:01Z') },
          { role: 'user', content: '还有这个', timestamp: new Date('2026-01-10T08:00:02Z'), audio: 'data:audio/webm;base64,BBBC' },
          { role: 'assistant', content: '嗯', timestamp: new Date('2026-01-10T08:00:03Z') },
        ],
      }),
    ],
    idFactory: seqIds(),
  });
  assert.equal(r.items[0].droppedAttachments, 2);
  assert.equal(JSON.stringify(r.items).includes('base64'), false);
});

test('空输入 / 脏输入不抛异常', () => {
  const r = buildReviewQueue({});
  assert.deepEqual(r.items, []);
  assert.equal(r.stats.chatScanned, 0);

  const dirty = buildReviewQueue({
    chatSessions: [null as never, { userId: 123 } as never, { userId: USER, chatMessages: 'nope' } as never],
    roleplayRecords: [undefined as never],
    idFactory: seqIds(),
  });
  assert.deepEqual(dirty.items, []);
});

test('★ 护栏本身有效：故意塞进身份键/身份值，findIdentityLeaks 必须报出来', () => {
  const leaked = [{ reviewId: 'rv_x', userId: USER, messages: [{ content: `联系我 ${USER_EMAIL}` }] }];
  const problems = findIdentityLeaks(leaked, [USER, USER_EMAIL]);
  assert.ok(problems.length >= 3, `护栏应报出结构键 + 两处取值，实际 ${problems.length} 处`);
  assert.ok(problems.some((p) => p.includes('userId')), '应报出禁用键 userId');
  assert.ok(problems.some((p) => p.includes('取值')), '应报出取值泄露');

  // 断言版必须直接抛（构建脚本 fail-closed 的依据）
  assert.throws(() => assertDeidentified(leaked, [USER]), /去标识化断言失败/);
  // 干净的产出物不抛
  assert.doesNotThrow(() => assertDeidentified({ reviewId: 'rv_x', messages: [] }, [USER]));
});

/* ───────── 2026-09-25：列表不再带正文 → 线索 / 预览 / 摘要改在构建期算 ───────── */

test('★ signals：构建期算好随条目下发（列表没正文后前端算不出来），阈值只此一份', () => {
  const r = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        { role: 'user', content: '在吗', timestamp: new Date('2026-01-10T08:00:00Z') },
        // 问句收尾 + 超短 + 半截
        { role: 'assistant', content: '你今天想聊点什么？', timestamp: new Date('2026-01-10T08:00:01Z'), incomplete: true },
        { role: 'user', content: '嗯', timestamp: new Date('2026-01-10T08:00:30Z') },
        // 距上一条 26s → 偏慢；第 2 次问句收尾、第 2 次超短
        { role: 'assistant', content: '还好吗？', timestamp: new Date('2026-01-10T08:00:56Z') },
        { role: 'user', content: '还行', timestamp: new Date('2026-01-10T08:01:10Z') },
        { role: 'assistant', content: '那就好，我一直都在这里陪着你，想说什么都可以慢慢讲', timestamp: new Date('2026-01-10T08:01:12Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  const byKey = Object.fromEntries(r.items[0].signals.map((s) => [s.k, s.t]));
  assert.equal(byKey.half, '半截回复 ×1');
  assert.equal(byKey.ask, 'AI 用问句收尾 ×2');
  assert.equal(byKey.slow, '回复偏慢(>20s) ×1');
  assert.equal(byKey.tiny, '超短回复(<20字) ×2');
  assert.equal(r.items[0].signals.find((s) => s.k === 'half')!.cls, 'hot');

  // 阈值：只有 1 次问句收尾 / 1 次超短时不报（规则是为了提示，不是把整页标红）
  const quiet = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        { role: 'user', content: '今天有点累', timestamp: new Date('2026-01-10T08:00:00Z') },
        { role: 'assistant', content: '要不要说说？', timestamp: new Date('2026-01-10T08:00:05Z') },
        { role: 'user', content: '嗯', timestamp: new Date('2026-01-10T08:01:00Z') },
        { role: 'assistant', content: '我在听，你慢慢讲就好，不用着急，我今晚都会在这里', timestamp: new Date('2026-01-10T08:01:04Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  assert.deepEqual(quiet.items[0].signals, []);
});

test('preview：取首条非空用户发言（脱敏后），最长 80 字；没有用户发言就是空串', () => {
  const long = '这是一句很长的开场白'.repeat(20);
  const r = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        { role: 'user', content: long, timestamp: new Date('2026-01-10T08:00:00Z') },
        { role: 'assistant', content: '嗯', timestamp: new Date('2026-01-10T08:00:05Z') },
        { role: 'user', content: '第二句', timestamp: new Date('2026-01-10T08:01:00Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  assert.equal(r.items[0].preview.length, 80);

  const phone = buildReviewQueue({
    chatSessions: [chatSession({
      chatMessages: [
        { role: 'user', content: '我的电话 13812345678 你记一下', timestamp: new Date('2026-01-10T08:00:00Z') },
        { role: 'assistant', content: '好', timestamp: new Date('2026-01-10T08:00:05Z') },
        { role: 'user', content: '嗯', timestamp: new Date('2026-01-10T08:01:00Z') },
      ],
    })],
    idFactory: seqIds(),
  });
  assert.equal(phone.items[0].preview.includes('13812345678'), false, '预览也必须是脱敏后的，别从这条路漏回去');
});

test('summarizeItem：去掉正文但保留列表要用的字段（messageCount 顶替 messages）', () => {
  const r = buildReviewQueue({ chatSessions: [chatSession()], idFactory: seqIds() });
  const s = summarizeItem(r.items[0]);
  assert.equal('messages' in s, false);
  assert.equal(s.messageCount, 4);
  assert.equal(s.sampleKey, r.items[0].sampleKey);
  assert.equal(s.preview, r.items[0].preview);
  assert.deepEqual(s.signals, r.items[0].signals);
  assert.equal(s.userTurns, 2);
});
