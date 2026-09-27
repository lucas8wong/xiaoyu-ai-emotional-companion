import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { getScenario, listScenarios, listTagGroups, getDisplayLikes, SCENARIOS, normalizeRplangText, injectionBoundaryFor, historyBlockFor, userMessageLabel, roleplayTaskInstr, buildSystemPrompt, parseDraftObject, extractDraftFields, isCompleteCustomDraft, roleplayReplyWithEmptyRetry, normalizeCustomIdea } = await import('../../api/services/roleplay.js');

test('getScenario：已知 id 返回剧本，未知 undefined', () => {
  const first = SCENARIOS[0];
  assert.ok(first);
  assert.strictEqual(getScenario(first.id)?.id, first.id);
  assert.strictEqual(getScenario('no-such-id'), undefined);
});

test('listScenarios：返回平铺字段 + 点赞数，按语言本地化', () => {
  const list = listScenarios('zh');
  assert.ok(list.length > 0, '应有剧本');
  const s = list[0];
  assert.ok(s.id);
  assert.strictEqual(typeof s.title, 'string');
  assert.strictEqual(typeof s.ai, 'object');
  assert.ok('likes' in s, '应有 likes 字段');
  assert.strictEqual(typeof s.likedByMe, 'boolean');
  assert.ok(s.avatar, '应有头像');

  // 英文模式：title 应为英文；zh-TW 应转繁体
  const en = listScenarios('en');
  assert.ok(en[0].title);
  const tw = listScenarios('zh-TW');
  assert.ok(tw[0]);
});

test('listTagGroups：默认中文有 featured + groups（题材/人设/关系/氛围/其他）', () => {
  const g = listTagGroups('zh');
  assert.ok(Array.isArray(g.featured) && g.featured.length > 0, '应有热门标签');
  const keys = g.groups.map((gr) => gr.key);
  for (const k of ['setting', 'character', 'dynamic', 'vibe']) {
    assert.ok(keys.includes(k), '应包含 ' + k);
  }
  for (const gr of g.groups) {
    assert.ok(gr.label, '每组应有 label');
    assert.ok(Array.isArray(gr.tags) && gr.tags.length > 0, '每组应有标签');
  }
});

test('listTagGroups：英文 label 本地化', () => {
  const g = listTagGroups('en');
  const setting = g.groups.find((x) => x.key === 'setting');
  assert.strictEqual(setting!.label, 'Setting');
  // 繁体分组的 label 应变繁体
  const tw = listTagGroups('zh-TW');
  const twSetting = tw.groups.find((x) => x.key === 'setting');
  assert.notStrictEqual(twSetting!.label, '题材·背景');
});

test('getDisplayLikes：初始为 0（无真实点赞）', () => {
  assert.strictEqual(getDisplayLikes('any-id'), 0);
  assert.strictEqual(getDisplayLikes(SCENARIOS[0].id), 0);
});

test('normalizeRplangText：按语言归一到目标字体（生成结果兜底）', () => {
  // zh-TW：简体 → 繁体（用已验证的「软件/简体」映射）
  assert.strictEqual(normalizeRplangText('我使用简体软件', 'zh-TW'), '我使用簡體軟件');
  // zh：繁体 → 简体
  assert.strictEqual(normalizeRplangText('我使用簡體軟件', 'zh'), '我使用简体软件');
  // en：英文原样
  assert.strictEqual(normalizeRplangText('Hello world', 'en'), 'Hello world');
  // 空值原样
  assert.strictEqual(normalizeRplangText('', 'zh-TW'), '');
});

test('prompt 侧随语言切换，消除 zh-TW/zh 简体泄漏', () => {
  // 安全边界句按语言切换
  assert.ok(injectionBoundaryFor('zh-TW').includes('內容'));
  assert.ok(!injectionBoundaryFor('zh-TW').includes('内容'));
  assert.ok(injectionBoundaryFor('en').includes('Safety boundary'));
  // 历史块标签按语言切换
  assert.ok(historyBlockFor('zh-TW', '').includes('【對話歷史】'));
  assert.ok(!historyBlockFor('zh-TW', '').includes('【对话历史】'));
  assert.ok(historyBlockFor('en', '').includes('[Conversation history]'));
  // 用户消息包裹标签
  assert.strictEqual(userMessageLabel('zh-TW').open, '【用戶訊息】');
  assert.strictEqual(userMessageLabel('zh').open, '【用户消息】');
  assert.strictEqual(userMessageLabel('en').open, '[User message]');
  // 任务指令按语言切换（zh-TW 不再含简体「继续剧情」）
  const taskTw = roleplayTaskInstr('immersive', '顧聿深', 'zh-TW');
  assert.ok(taskTw.includes('繼續劇情'));
  assert.ok(!taskTw.includes('继续剧情'));
});

test('buildSystemPrompt：zh-TW 官方剧本 system prompt 无简体泄漏', () => {
  const prompt = buildSystemPrompt(SCENARIOS[0], 'zh-TW');
  assert.ok(prompt.includes('繁體'), '应含繁体输出要求');
  assert.ok(prompt.includes('推進劇情'), '尾部应已转繁体');
  assert.ok(!prompt.includes('推进剧情'), '不应残留简体「推进剧情」');
});

test('流式逐 delta 归一化：分片简体拼接后全为繁体（SSE delta 不混简体）', () => {
  // 模拟模型流式吐出的分片（可能是简体），逐片过 normalizeRplangText（zh-TW）再拼接
  const deltas = ['这里', '有个', '简体', '的', '说', '法'];
  const streamed = deltas.map((d) => normalizeRplangText(d, 'zh-TW')).join('');
  assert.strictEqual(streamed, '這裡有個簡體的說法');
  assert.ok(!/[这]/.test(streamed), '不应残留简体「这」');
  assert.ok(!/[个]/.test(streamed), '不应残留简体「个」');

  // zh（简体）：逐片繁体 → 简体
  const twDeltas = ['這裡', '有個', '繁體', '說', '法'];
  const streamedZh = twDeltas.map((d) => normalizeRplangText(d, 'zh')).join('');
  assert.strictEqual(streamedZh, '这里有个繁体说法');
  assert.ok(!/[裡]/.test(streamedZh), '不应残留繁体「裡」');
  assert.ok(!/[個]/.test(streamedZh), '不应残留繁体「個」');
});


test('parseDraftObject：剥离 markdown 围栏/前后缀后解析 JSON 草稿', () => {
  const raw = '好的，这是你想要的剧本：\n```json\n{"title":"雨天咖啡馆","aiName":"沈清言","aiPersona":"温柔克制的医生","background":"雨夜相遇","opening":"你推门进来"} \n```';
  const obj = parseDraftObject(raw);
  assert.ok(obj);
  assert.strictEqual(obj!.title, '雨天咖啡馆');
  assert.strictEqual(obj!.aiName, '沈清言');
});

test('parseDraftObject：纯 JSON / 空输入', () => {
  const obj = parseDraftObject('{"title":"A","aiPersona":"B"}');
  assert.strictEqual(obj!.title, 'A');
  assert.strictEqual(parseDraftObject(''), null);
  assert.strictEqual(parseDraftObject('no json here'), null);
});

test('extractDraftFields：裁剪长度并用回退值补齐空字段', () => {
  const longTitle = 'x'.repeat(80);
  const d = extractDraftFields({ title: longTitle, aiName: 'TA', aiPersona: 'p', background: '', opening: 'o' }, { background: 'fallback bg' });
  assert.strictEqual(d.title, 'x'.repeat(60));
  assert.strictEqual(d.aiName, 'TA');
  assert.strictEqual(d.background, 'fallback bg');
  assert.strictEqual(d.opening, 'o');
});

test('isCompleteCustomDraft：人设/背景/开场齐全才算完整', () => {
  assert.strictEqual(isCompleteCustomDraft({ title: '', aiName: '', aiPersona: 'p', background: 'b', opening: 'o' }), true);
  assert.strictEqual(isCompleteCustomDraft({ aiPersona: 'p', background: 'b' }), false);
  assert.strictEqual(isCompleteCustomDraft(null), false);
  assert.strictEqual(isCompleteCustomDraft(undefined), false);
});

test('roleplayReplyWithEmptyRetry：首轮非空直接返回，不重复调用', async () => {
  let calls = 0;
  const out = await roleplayReplyWithEmptyRetry(async () => { calls++; return '（他抬眼看向你。）「来了。」'; }, 'zh');
  assert.strictEqual(out, '（他抬眼看向你。）「来了。」');
  assert.strictEqual(calls, 1, '首轮非空应只调用一次');
});

test('roleplayReplyWithEmptyRetry：首轮为空则重试一次，第二轮非空即返回', async () => {
  let calls = 0;
  const out = await roleplayReplyWithEmptyRetry(async () => {
    calls++;
    return calls === 1 ? '' : '「我等你好久了。」';
  }, 'zh');
  assert.strictEqual(out, '「我等你好久了。」');
  assert.strictEqual(calls, 2, '首轮为空应触发一次重试');
});

test('roleplayReplyWithEmptyRetry：连续两次为空则回退到兜底句（按语言）', async () => {
  // zh
  const zh = await roleplayReplyWithEmptyRetry(async () => '', 'zh');
  assert.ok(zh.includes('我在听'), 'zh 应回退到中文兜底句');
  // zh-TW
  const tw = await roleplayReplyWithEmptyRetry(async () => '', 'zh-TW');
  assert.ok(tw.includes('我在聽'), 'zh-TW 应回退到繁体兜底句');
  // en
  const en = await roleplayReplyWithEmptyRetry(async () => '', 'en');
  assert.ok(en.includes("I’m listening"), 'en 应回退到英文兜底句');
});


test('normalizeCustomIdea：「AI 帮我写剧本」输入不限字数（移除 500 字上限的回归守卫）', () => {
  // 整份剧本（远超原先的 500 字上限）必须原样保留——用户会直接把剧本全部贴进来
  const long = '第一幕：雨夜的咖啡馆，她推门进来。'.repeat(200) + '【末尾标记】';
  assert.ok(long.length > 500, '测试文本应超过 500 字');
  const out = normalizeCustomIdea(long);
  assert.strictEqual(out.length, long.length, '不应截断');
  assert.ok(out.endsWith('【末尾标记】'), '结尾内容必须保留');
  assert.strictEqual(out, long, '内容应逐字一致（仅 trim 掉首尾空白）');
  // 常规清洗：首尾空白 trim
  assert.strictEqual(normalizeCustomIdea('  一句话灵感  '), '一句话灵感');
  // 非字符串/空值安全
  assert.strictEqual(normalizeCustomIdea(''), '');
  assert.strictEqual(normalizeCustomIdea(null), '');
  assert.strictEqual(normalizeCustomIdea(undefined), '');
  assert.strictEqual(normalizeCustomIdea(12345), '12345');
});

/* ───────── 剧情输出格式：纯文本硬规则（2026-09-20） ───────── */

/**
 * 为什么加：真实线上数据的「高频收尾形态」榜里，**代码块围栏（三个反引号）出现 3 次**——
 * 模型把 Markdown 漏进了剧情正文。聊一聊一直有【格式·纯文本】硬规则，剧情这边一条都没有。
 * 这里钉死：三语都进得了 system、且明确点名"代码块围栏"（不写反引号本身，避免给出可照抄的样例）。
 */
test('纯文本格式约束：三语齐全，且点名代码块围栏', async () => {
  const { buildPlainTextDirective } = await import('../../api/services/prompts.js');
  const zh = buildPlainTextDirective('zh');
  assert.ok(zh.includes('纯文本'), 'zh 缺纯文本标题：' + zh.slice(0, 60));
  assert.ok(zh.includes('代码块围栏'), 'zh 没点名代码块围栏（真实数据里就是它漏进来的）');
  assert.ok(!zh.includes('```'), '文案里不该出现可照抄的反引号样例');
  const tw = buildPlainTextDirective('zh-TW');
  assert.ok(tw.includes('純文本') && !tw.includes('纯文本'), 'zh-TW 未转繁体：' + tw.slice(0, 60));
  const en = buildPlainTextDirective('en');
  assert.ok(en.includes('plain text') && en.includes('code fences'), 'en 不完整：' + en.slice(0, 60));
});

test('纯文本格式约束进得了剧情 system（官方剧本与自建剧本都走同一条规则拼接）', async () => {
  const rp: any = await import('../../api/services/roleplay.js');
  const scenario = rp.getScenario('guyushen-songzhi');
  assert.ok(scenario, '取不到官方剧本');
  const sys = rp.buildSystemPrompt(scenario, 'zh');
  assert.ok(sys.includes('【格式 · 纯文本（硬要求）】'), '官方剧本 system 缺纯文本约束');
  // 引号字形规范也仍在（两条钉在一起，别只加一处）
  assert.ok(sys.includes('引号'), '引号规范丢了');
});
