/**
 * A 方案端到端（**真路由 + 真 SSE + 打桩上游**，零真实 AI 调用），2026-09-24
 *
 * 为什么单测不够：单测证明了「判据与采纳策略」对，证明不了**接线对**
 * 服务端有没有真的下发 {type:'rewrite'}、重写请求有没有带上点名禁项、
 * 最终 done.reply 到底是原版还是重写版、默认范围（adult）会不会误开。
 *
 * 打桩上游：第一次回「复读了历史的版本」，第二次回「干净版本」（脚本可按用例改）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/** 34 字：够 circulating 阈值（20），远不到 severe（80） */
const F = '他把手掌贴在腰侧，随着呼吸的节奏轻轻起伏，掌心的热度透过衣料传过来';
/** 历史里的两条 AI 回复都含 F → 新回复再复用它就是 circulating=2 */
const M1 = F + '，他没有说话。';
const M2 = F + '，屋里很安静。';
/** 第一次上游：复读版（≥80 字，与历史共享 F） */
const REP = F + '，他垂下眼帘，把被角拉好，动作沉稳而连贯，呼吸绵长而平稳，像是怕惊动什么。窗外的风把灯影吹得晃了晃，又慢慢静下来。';
/** 第二次上游：干净版（与历史无 ≥20 字共享，且字数不缩水） */
const CLEAN = '（他侧过身，把灯芯挑亮，火苗稳住了。）他低声说了一句什么，声音很轻，随即把被子往你那边推了推，自己只留了一角。桌上的水还温着，他没有再碰那只碗。灯花爆了一下，屋里更暗了些。';
/** 第二次上游：干净但**缩水**，必须被拒（GLM-4-32B 那次的教训） */
const SHORT = '（他点了点头。）';

let script: Array<{ text: string; finishReason: string }> = [];
let calls: any[] = [];

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* 非 JSON */ }
    calls.push(body);
    const step = script.length > 1 ? script.shift()! : (script[0] || { text: '（他笑了一下。）', finishReason: 'stop' });
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-rpgate-'));
process.chdir(tmp);
process.env.NODE_ENV = 'test';
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + upstreamPort;
process.env.RP_ZH_PROVIDER = 'deepseek';
process.env.RP_EN_PROVIDER = 'deepseek';
process.env.RP_CONTINUE_MAX = '0';
process.env.RP_REPEAT_GATE_SCOPE = 'all';

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

async function chat(device: string, body: unknown) {
  calls = [];
  const res = await fetch(base + '/api/roleplay/chat?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}
function doneOf(text: string): any {
  const line = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"done"'));
  assert.ok(line, 'SSE 里必须有 done 事件');
  return JSON.parse(line!.slice(5).trim()).data;
}
const history = () => [
  { role: 'assistant', content: M1 },
  { role: 'assistant', content: M2 },
  { role: 'user', content: '（我把脸埋进被子里）' },
];

test('SSE：命中复读 → 下发 rewrite 事件 → 重写被采纳 → done.reply 是重写版', async () => {
  script = [{ text: REP, finishReason: 'stop' }, { text: CLEAN, finishReason: 'stop' }];
  const r = await chat('rp-gate-1', { scenarioId: sid, lang: 'zh-CN', messages: history() });

  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  // ① 前端拿到「正在重写」事件（否则用户会以为刚流出的那段莫名消失）
  assert.match(r.text, /"type":"rewrite"/, '应下发 rewrite 事件');
  // ② 重写请求确实带上了点名禁项与「本次是重写」指令
  assert.strictEqual(calls.length, 2, '命中后应恰好再调一次上游');
  const prompt = JSON.stringify(calls[1].messages);
  assert.ok(prompt.includes('本次是重写'), '重写请求必须带重写专区');
  assert.ok(prompt.includes('掌心的热度透过衣料传过来'), '重写请求必须点名那句被复用的片段');
  // ③ 最终下发给前端的是重写版
  const done = doneOf(r.text);
  assert.strictEqual(done.reply, CLEAN, 'done.reply 必须是采纳后的重写版');
});

test('SSE：重写版缩水 → **不采纳**，done.reply 仍是原版（宁可复读，也不接受少写）', async () => {
  script = [{ text: REP, finishReason: 'stop' }, { text: SHORT, finishReason: 'stop' }];
  const r = await chat('rp-gate-2', { scenarioId: sid, lang: 'zh-CN', messages: history() });
  assert.match(r.text, /"type":"rewrite"/, '仍然会尝试重写');
  assert.strictEqual(calls.length, 2);
  const done = doneOf(r.text);
  assert.strictEqual(done.reply, REP, '缩水版必须被拒，保留原文');
});

test('SSE：没有复读 → 一次调用、零额外延迟（不能把正常轮也拖成两倍）', async () => {
  script = [{ text: CLEAN, finishReason: 'stop' }];
  const r = await chat('rp-gate-3', { scenarioId: sid, lang: 'zh-CN', messages: history() });
  assert.doesNotMatch(r.text, /"type":"rewrite"/, '没命中就不该下发 rewrite');
  assert.strictEqual(calls.length, 1, '没命中就不该多调一次上游');
  assert.strictEqual(doneOf(r.text).reply, CLEAN);
});

test('默认范围 adult：官方链路回合不判（连 rewrite 事件都不该有）', async () => {
  const saved = process.env.RP_REPEAT_GATE_SCOPE;
  process.env.RP_REPEAT_GATE_SCOPE = 'adult';
  try {
    script = [{ text: REP, finishReason: 'stop' }, { text: CLEAN, finishReason: 'stop' }];
    const r = await chat('rp-gate-4', { scenarioId: sid, lang: 'zh-CN', messages: history() });
    assert.doesNotMatch(r.text, /"type":"rewrite"/);
    assert.strictEqual(calls.length, 1, '默认范围下，非成人回合不该额外调用');
    assert.strictEqual(doneOf(r.text).reply, REP);
  } finally {
    if (saved === undefined) delete process.env.RP_REPEAT_GATE_SCOPE; else process.env.RP_REPEAT_GATE_SCOPE = saved;
  }
});

test('SSE：一拍计划行被剥掉，流式增量与 done.reply 都不含标记（B 方案）', async () => {
  const saved = process.env.RP_BEAT_PLAN_SCOPE;
  process.env.RP_BEAT_PLAN_SCOPE = 'all';
  try {
    const PLAN_LINE = '【本拍】他把灯挪到窗边，决定今晚不再提林同学的事。';
    script = [{ text: PLAN_LINE + '\n\n' + CLEAN, finishReason: 'stop' }];
    const r = await chat('rp-gate-5', { scenarioId: sid, lang: 'zh-CN', messages: history() });

    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    // ① 提示词里必须带「一拍计划」要求（否则模型根本不会写那一行）
    assert.ok(JSON.stringify(calls[0].messages).includes('【本拍】'), 'system 提示词缺少一拍计划指令');
    // ② 流式任何一帧都不许泄漏计划行（玩家会看见它一闪而过）
    assert.doesNotMatch(r.text, /本拍/, 'SSE 泄漏了计划行');
    // ③ 定稿文本必须逐字等于正文
    assert.strictEqual(doneOf(r.text).reply, CLEAN, 'done.reply 含计划行或与正文不一致');
    // ④ 只调了一次上游（计划行在同一次生成里，不是多调一次模型）
    assert.strictEqual(calls.length, 1, '一拍计划不该产生额外调用');
  } finally {
    if (saved === undefined) delete process.env.RP_BEAT_PLAN_SCOPE; else process.env.RP_BEAT_PLAN_SCOPE = saved;
  }
});

