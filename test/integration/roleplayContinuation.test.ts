/**
 * B+C 端到端（**真路由 + 真 SSE + 打桩上游**，零真实 AI 调用）
 *
 * 为什么必须有这一层：单测只证明「判定与拼接」的逻辑对，证明不了**接线对**——
 * 服务端有没有真的把断点接完、done 里有没有带 incomplete/continued、续写请求有没有带续写指令与断点历史、
 * 手动续写（continueTurn）会不会被「历史必须以 user 结尾」那条校验挡下来。
 *
 * 打桩上游：第一次请求回「断在半句」的流，第二次回「接着写完」的流（脚本可按用例改）。
 * 走的是 `createDeepSeekClient` + `DEEPSEEK_BASE_URL` 这条真实解析路径
 * （`RP_ZH_PROVIDER=deepseek` 是运维止血开关，用来强制不走真实第三方模型）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/** 真实那条半截回复的骨架（括号都配对，只有最后那个 （ 悬空） */
const HALF = '（他低笑一声，把杯子放下。）\n\n「来，张嘴。daddy 帮你看着镜子……乖，慢慢刷。」\n\n（他并未退';
/** 续写：把悬空的括号收掉，并让句子完整收尾 */
const CONT = '出去半步，反手把门带上。）「先睡吧。」';
const MERGED = HALF + '出去半步，反手把门带上。）「先睡吧。」';
/**
 * 简体中文的引号归一是**链路的一部分**（dialogueQuotes：简中 “”／繁中 「」／英文 ""）——
 * 断言必须用归一后的样子，否则是在断言一个产品不会输出的字符串。
 */
const normZh = (s: string) => s.replace(/「/g, '“').replace(/」/g, '”');
/** 手动续写：客户端传来的半截原文**逐字保留**（不改写用户已经看到的历史），只有新写的增量被引号归一 */
const MERGED_MANUAL = HALF + '出去半步，反手把门带上。）“先睡吧。”';

/** 上游脚本：每个请求消费一条（只剩一条时重复使用） */
let script: Array<{ text: string; finishReason: string }> = [];
let calls: any[] = [];

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* 非 JSON 请求体 */ }
    calls.push(body);
    const step = script.length > 1 ? script.shift()! : (script[0] || { text: '（他笑了一下。）', finishReason: 'stop' });
    // 流式 / 非流式两种上游响应都要支持：手动续写那条用例走的是非流式 JSON 分支
    if (body?.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: step.text }, finish_reason: step.finishReason }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const mid = Math.ceil(step.text.length / 2);
    for (const part of [step.text.slice(0, mid), step.text.slice(mid)]) {
      if (part) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step.finishReason }], usage: { prompt_tokens: 120, completion_tokens: 40 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
after(() => upstream.close());
const upstreamPort = (upstream.address() as { port: number }).port;

// 数据隔离 + 上游指向打桩：都必须在 import app 之前（store 单例与 env 在模块加载时定型）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-rpcont-'));
process.chdir(tmp);
process.env.NODE_ENV = 'test';
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + upstreamPort;
process.env.RP_ZH_PROVIDER = 'deepseek';
process.env.RP_EN_PROVIDER = 'deepseek';
process.env.RP_CONTINUE_MAX = '1';

const { default: app } = await import('../../api/app.js');

let server: import('node:http').Server;
let base = '';
let sid = '';

before(async () => {
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const list = await fetch(base + '/api/roleplay/scenarios').then((r) => r.json()) as any;
  sid = String(list?.data?.[0]?.id || '');
  assert.ok(sid, '应能取到内置剧本 id');
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function chat(device: string, body: unknown, stream = true) {
  calls = [];
  const res = await fetch(base + '/api/roleplay/chat' + (stream ? '?stream=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** 从 SSE 文本里取出 done 事件的 data */
function doneOf(text: string): any {
  const line = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"done"'));
  assert.ok(line, 'SSE 里必须有 done 事件');
  return JSON.parse(line!.slice(5).trim()).data;
}

test('SSE：半截回复 → 服务端自动续写 → done 下发拼接后的完整回复（B+C 主线）', async () => {
  script = [{ text: HALF, finishReason: 'stop' }, { text: CONT, finishReason: 'stop' }];
  const r = await chat('rp-cont-sse-1', { scenarioId: sid, lang: 'zh-CN', userName: '晚晚', aiName: '沈辞', messages: [{ role: 'user', content: '（缩进被窝里蹭了蹭他的下巴）' }] });

  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  // ① 前端能看到「正在续写」事件（而不是新的一段莫名冒出来）
  assert.match(r.text, /"type":"continue","attempt":1/, '应下发续写事件');
  // ② done 里带 B 方案的完整信息
  const done = doneOf(r.text);
  assert.strictEqual(done.reply, normZh(MERGED), '断点处的「退」不应重复出现，且应拼接成完整回复');
  assert.strictEqual(done.incomplete, null, '续写后应判定为写完');
  assert.strictEqual(done.continued, 1, '应记录自动续写 1 次');
  assert.strictEqual(done.finishReason, 'stop');
  // ③ 上游确实被调了两次，且第二次带的是**续写指令 + 断点历史**
  assert.strictEqual(calls.length, 2, '半截 → 应触发第二次上游调用');
  const prompt = JSON.stringify(calls[1].messages);
  assert.match(prompt, /续写模式/, '第二次请求必须换成续写指令（否则模型会重新开一段 → 复读）');
  assert.ok(prompt.includes('他并未退'), '断点内容必须作为「自己已写的内容」进 prompt');
});

test('SSE：一次写完 → 不触发续写（零额外延迟/成本）', async () => {
  script = [{ text: '（他笑了一下，把杯子推到一边。）\n\n「先睡吧。」', finishReason: 'stop' }];
  const r = await chat('rp-cont-sse-2', { scenarioId: sid, lang: 'zh-CN', messages: [{ role: 'user', content: '我困了' }] });
  const done = doneOf(r.text);
  assert.strictEqual(done.incomplete, null);
  assert.strictEqual(done.continued, 0);
  assert.strictEqual(calls.length, 1, '写完了就不该再调一次上游');
  assert.doesNotMatch(r.text, /"type":"continue"/);
});

test('SSE：只是没写句末标点（mid_sentence + finish_reason=stop）→ **不再自动续写**（2026-09-19 触发闸）', async () => {
  /**
   * 起因：用户「小愈的朋友」(8f17a9ac) 的剧情回复里出现条内大段复读（4/9 条，最长 1112 字逐字重复）。
   * 诊断（temp/rp-rep-8f17a9ac/）：那条 27B 链路上 11% 的回合会被判「没写完」（个别用户 6/9），
   * 而这类「没写完」只是**结尾没句末标点**的收尾习惯——续满 2 次后仍然不完整；
   * 代价却是每次续写都把正文再喂一遍给弱模型，一旦它「重讲一遍」就被拼进正文。
   * 因此：只有真截断（length / unclosed）才自动续；这一类改为**如实标注 + 交手动续写**。
   */
  script = [{ text: '裴知嵊垂眸看着她，指腹顺着那道紧绷的弧度缓缓碾过，触到那具身体里细微的战栗与紧绷感', finishReason: 'stop' }];
  const r = await chat('rp-cont-sse-4', { scenarioId: sid, lang: 'zh-CN', messages: [{ role: 'user', content: '（凑近他耳边）你还记得吗' }] });
  const done = doneOf(r.text);
  assert.strictEqual(calls.length, 1, '只是没写句号 → 不该再调一次上游（那正是复读的入口）');
  assert.doesNotMatch(r.text, /"type":"continue"/, '不该下发续写事件');
  assert.strictEqual(done.continued, 0);
  assert.strictEqual(done.incomplete, 'mid_sentence', '仍要如实标注没写完 → 前端给「续写」入口与埋点');
  assert.strictEqual(done.finishReason, 'stop');
});

test('SSE：上游 finish_reason=length（撞 max_tokens）→ 续写；用尽上限后如实标注没写完', async () => {
  script = [{ text: '他笑了一下。', finishReason: 'length' }, { text: '，还是没写完', finishReason: 'length' }];
  const r = await chat('rp-cont-sse-3', { scenarioId: sid, lang: 'zh-CN', messages: [{ role: 'user', content: '然后呢' }] });
  const done = doneOf(r.text);
  assert.strictEqual(done.continued, 1, 'RP_CONTINUE_MAX=1 → 只续一次');
  assert.strictEqual(done.incomplete, 'length', '仍不完整时必须如实标出（前端据此给「续写」入口 + 埋点 PARTIAL_LENGTH）');
  assert.strictEqual(done.finishReason, 'length');
  assert.strictEqual(calls.length, 2, '不能无限续写');
});

test('手动续写（continueTurn，非流式分支）：历史以 assistant 结尾不再被拒，且接着断点写', async () => {
  script = [{ text: CONT, finishReason: 'stop' }];
  const r = await chat('rp-cont-manual-1', {
    scenarioId: sid, lang: 'zh-CN', continueTurn: true,
    messages: [{ role: 'user', content: '（缩进被窝里蹭了蹭他的下巴）' }, { role: 'assistant', content: HALF }],
  }, false);

  assert.strictEqual(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  assert.strictEqual(r.json.data.reply, MERGED_MANUAL, '手动续写返回的应是「半截 + 续写」的全文');
  assert.strictEqual(r.json.data.incomplete, null);
  assert.strictEqual(calls.length, 1, '手动续写：首轮就是续写，不该先跑一遍普通回合');
  assert.match(JSON.stringify(calls[0].messages), /续写模式/);
});

test('普通回合仍然要求历史以 user 结尾（手动续写的放开不能扩大化）', async () => {
  script = [{ text: '（他笑了一下。）', finishReason: 'stop' }];
  const r = await chat('rp-cont-guard-1', {
    scenarioId: sid, lang: 'zh-CN',
    messages: [{ role: 'user', content: '嗯' }, { role: 'assistant', content: '（他应了一声）' }],
  }, false);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(calls.length, 0, '非法请求不该打到上游');
});
