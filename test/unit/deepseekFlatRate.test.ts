/**
 * 订阅制上游的**记账接线**回归。
 *
 * 为什么单独一个文件：usage.ts 的单测只覆盖账本本身，覆盖不到
 * 「createCompatClient → generateContent → usageStore.record(flatRate:true)」这条线。
 * 断在这里，比等运营端发现「API 成本虚高 / 利润被低估」再回头查便宜得多。
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { setupTempCwd } from './setup.js';

setupTempCwd();
process.env.INPUT_PRICE_PER_M = '2';
process.env.OUTPUT_PRICE_PER_M = '8';
process.env.CACHE_PRICE_RATIO = '0.25';
process.env.PRICE_PEAK_ENABLED = '0';

/** 只回固定 JSON 的假 chat/completions 上游（token 数固定，便于断言金额） */
async function startStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub',
      choices: [{ message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return {
    baseUrl: 'http://127.0.0.1:' + addr.port,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

// 官方 client 的 baseUrl 在模块加载时从 env 固化 → 必须先起桩、再 import
const stub = await startStub();
process.env.DEEPSEEK_BASE_URL = stub.baseUrl;
process.env.DEEPSEEK_API_KEY = 'test-key';
const { createCompatClient, createDeepSeekClient } = await import('../../api/services/deepseek.js');
const { usageStore } = await import('../../api/services/usage.js');

after(async () => { await stub.close(); });

const REPLY = { contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }] };

test('第三方（订阅制）client：token 照记，cost 记 0，参考价另存', async () => {
  const client = createCompatClient({
    name: 'Roleplay-ZH', baseUrl: stub.baseUrl, model: 'stub',
    maxTokens: 64, timeoutMs: 5000, maxRetries: 0, apiKey: 'test-key',
  });
  await client.models.generateContent({ ...REPLY, userId: 'flat-wire', feature: 'roleplay' });

  const r = usageStore.get('flat-wire')!;
  assert.strictEqual(r.cost, 0, '订阅制上游不产生按量成本');
  assert.strictEqual(r.flatCalls, 1, '必须被标成订阅制调用');
  assert.strictEqual(r.promptTokens, 1000, 'token 照记（额度与统计还要用）');
  assert.strictEqual(r.completionTokens, 500);
  assert.ok(Math.abs((r.notionalCost || 0) - 0.006) < 1e-6, '参考价 = 1e3 prompt×2 + 5e2 completion×8（元/M）');
});

test('官方 DeepSeek client：同一账本照常按 DeepSeek 单价计成本（对照组）', async () => {
  await createDeepSeekClient().models.generateContent({ ...REPLY, userId: 'ds-wire', feature: 'chat' });

  const r = usageStore.get('ds-wire')!;
  assert.ok(Math.abs(r.cost - 0.006) < 1e-6, '官方链路成本不能被订阅制改动波及');
  assert.ok(!r.flatCalls, '官方调用不得被标成订阅制');
});
