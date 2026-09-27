/**
 * 千世书「AI 生成剧本」服务端生成管线单元测试
 * - 两阶段生成（骨架 + 分批事件池），产出可进 importScenarioSchema 的结构
 * - 非法 effect 键清洗、全非法事件丢弃
 * - id 避开已占用 id
 * 通过 deps.generateContent 注入假 LLM，不调用真实 DeepSeek。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { generateScenario, importScenarioSchema } from '../../api/services/scenarioGenerator.js';

const SKELETON = JSON.stringify({
  title: '测试人生',
  intro: '一段用于测试的人生。',
  attributes: [
    { key: 'hp', name: '生命', initial: 80, max: 100, deathBelow: 0, bands: [
      { upTo: 20, label: '濒死', severity: 'critical' },
      { upTo: 100, label: '康健', severity: 'normal' },
    ] },
    { key: 'gold', name: '财富', initial: 10, max: 100, bands: [
      { upTo: 50, label: '清贫', severity: 'low' },
      { upTo: 100, label: '富足', severity: 'high' },
    ] },
  ],
  openings: [{ name: '平民', prompt: '普通出身' }],
  ambitions: ['发财致富'],
  turnUnit: '年',
  maxTurns: 20,
  systemPrompt: '测试主持规则：hp 归零即死，gold 越高越富。',
  endings: [
    { condition: 'hp<=0', tone: '英年早逝' },
    { condition: 'maxTurns & gold>=80', tone: '富甲一方' },
    { condition: 'maxTurns', tone: '平凡一生' },
  ],
});

function makeMockGen() {
  let call = 0;
  return async (req: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) {
      return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    }
    const c = call++;
    const base = c * 5;
    const events = Array.from({ length: 5 }, (_, i) => ({
      narrative: `第 ${base + i} 个测试情境，颇有张力。`,
      choices: [
        { text: '稳妥应对', effects: { hp: -3, gold: 5 } },
        { text: '冒险一搏', effects: { hp: -8, gold: 12 } },
      ],
      summary: `事件${base + i}`,
    }));
    if (c === 0) {
      events.push({ narrative: '全是非法属性键，应被丢弃。', choices: [{ text: 'A', effects: { bogus: 5 } }, { text: 'B', effects: { junk: 1 } }], summary: '应丢弃' });
      events.push({ narrative: '混入非法键，应被清洗后保留。', choices: [{ text: 'A', effects: { bogus: 5, hp: -2 } }, { text: 'B', effects: { gold: 4 } }], summary: '部分非法' });
    }
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ events }) }] } }] };
  };
}

test('两阶段生成并通过 importScenarioSchema 校验', async () => {
  const sc = await generateScenario({ theme: '武侠江湖', target: 12, batchSize: 5 }, { generateContent: makeMockGen() });
  assert.doesNotThrow(() => importScenarioSchema.parse(sc));
  assert.ok(sc.id.startsWith('gen-'));
  assert.strictEqual(sc.title, '测试人生');
  assert.strictEqual((sc.localEvents ?? []).length, 12);
  const sums = (sc.localEvents ?? []).map((e) => e.summary);
  assert.strictEqual(new Set(sums).size, sums.length);
  assert.ok(!sums.includes('应丢弃'));
});

test('清洗非法 effects 键，保留合法键', async () => {
  const sc = await generateScenario({ theme: 't', target: 12, batchSize: 5 }, { generateContent: makeMockGen() });
  const partial = (sc.localEvents ?? []).find((e) => e.summary === '部分非法');
  assert.ok(partial);
  assert.deepStrictEqual(partial!.choices[0].effects, { hp: -2 });
});

test('id 避开已占用 id', async () => {
  const sc = await generateScenario(
    { theme: 'wuxia', target: 5, batchSize: 5, existingIds: ['gen-wuxia'] },
    { generateContent: makeMockGen() },
  );
  assert.strictEqual(sc.id, 'gen-wuxia-2');
});

test('所有批次都产不出有效事件时抛错（不静默提交 0 支线）', async () => {
  const gen = async (req: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [] }) }] } }] };
  };
  await assert.rejects(generateScenario({ theme: 't', target: 12, batchSize: 5 }, { generateContent: gen }));
});

/* ---------------- 并发波次 / 进度 / 降档重试（524 修复相关） ---------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type AnyGenReq = { contents: Array<{ parts: Array<{ text?: string }> }>; thinkingLevel?: string; signal?: AbortSignal };

function eventBatchText(base: number, n = 10) {
  return JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      narrative: `情境 ${base + i}`,
      choices: [
        { text: '稳妥应对', effects: { hp: -3, gold: 5 } },
        { text: '冒险一搏', effects: { hp: -8, gold: 12 } },
      ],
      summary: `事件${base + i}`,
    })),
  });
}

test('支线批次并发跑：单波多批同时到达，并按「骨架 → 支线 n/total」推进度', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const startsBeforeFirstEnd: string[] = [];
  let ended = 0;
  let eventCalls = 0;
  const gen = async (req: AnyGenReq) => {
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    eventCalls += 1;
    const me = eventCalls;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (ended === 0) startsBeforeFirstEnd.push('call' + me);
    await sleep(30);
    inFlight -= 1;
    ended += 1;
    return { candidates: [{ content: { parts: [{ text: eventBatchText((me - 1) * 10) }] } }] };
  };
  const progress: Array<{ step: string; done: number; total: number }> = [];
  const sc = await generateScenario(
    { theme: 't', target: 40, batchSize: 10, onProgress: (p) => progress.push(p) },
    { generateContent: gen },
  );
  assert.strictEqual((sc.localEvents ?? []).length, 40);
  // 4 批支线应同时在飞（旧的串行实现 maxInFlight 恒为 1）
  assert.strictEqual(maxInFlight, 4, '并发波次应同时发起 4 批支线');
  assert.deepStrictEqual(startsBeforeFirstEnd, ['call1', 'call2', 'call3', 'call4'], '首批 4 个调用应全部先到达');
  assert.deepStrictEqual(progress[0], { step: 'skeleton', done: 0, total: 40 });
  assert.deepStrictEqual(progress[progress.length - 1], { step: 'events', done: 40, total: 40 });
  assert.ok(progress.every((p) => p.step === 'skeleton' || p.step === 'events'));
});

test('并发批次撞名（摘要重复）时自动补一波凑够 target，且补波带着已用事件名', async () => {
  let eventCalls = 0;
  const prompts: string[] = [];
  const gen = async (req: AnyGenReq) => {
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    eventCalls += 1;
    prompts.push(sys);
    // 第一波的两批互相撞名（都产 事件0..9）→ 去重后只有 10 条，必须靠补波补齐
    const text = eventCalls <= 2 ? eventBatchText(0) : eventBatchText(10);
    return { candidates: [{ content: { parts: [{ text }] } }] };
  };
  const sc = await generateScenario({ theme: 't', target: 20, batchSize: 10 }, { generateContent: gen });
  const evs = sc.localEvents ?? [];
  assert.strictEqual(evs.length, 20);
  assert.strictEqual(new Set(evs.map((e) => e.summary)).size, 20);
  assert.strictEqual(eventCalls, 3, '两批（撞名）+ 一波补量');
  assert.ok(prompts[2].includes('事件5'), '补波提示词应带上已用事件名（避免再撞）');
});

test('批次输出为空 / finish_reason=length 时，对同一批降档 low 重试一次（不白丢一轮）', async () => {
  const levels: Array<string | undefined> = [];
  let eventCalls = 0;
  const gen = async (req: AnyGenReq) => {
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    eventCalls += 1;
    levels.push(req.thinkingLevel);
    // 首次：高思考把输出预算全烧在 reasoning 上 → 正文为空 + finish_reason=length
    if (eventCalls === 1) return { candidates: [{ content: { parts: [{ text: '' }] } }], finishReason: 'length' };
    return { candidates: [{ content: { parts: [{ text: eventBatchText(0) }] } }], finishReason: 'stop' };
  };
  const sc = await generateScenario({ theme: 't', target: 10, batchSize: 10 }, { generateContent: gen });
  assert.deepStrictEqual(levels, ['high', 'low'], '同批应先 high、被截断后降档 low 重试');
  assert.strictEqual((sc.localEvents ?? []).length, 10);
});

test('外部中断信号（客户端断开）透传到每次 LLM 调用', async () => {
  const ac = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  const gen = async (req: AnyGenReq) => {
    seen.push(req.signal);
    const sys = req.contents?.[0]?.parts?.[0]?.text ?? '';
    if (sys.includes('剧本「骨架」')) return { candidates: [{ content: { parts: [{ text: SKELETON }] } }] };
    return { candidates: [{ content: { parts: [{ text: eventBatchText(0, 5) }] } }] };
  };
  await generateScenario({ theme: 't', target: 5, batchSize: 5, signal: ac.signal }, { generateContent: gen });
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((s) => s === ac.signal), '骨架与支线调用都应带上同一个 signal');
});
