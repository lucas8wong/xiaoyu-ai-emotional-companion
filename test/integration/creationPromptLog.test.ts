import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据隔离（与 test/integration/app.test.ts 同款）：必须在 import app 之前 chdir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-cplog-'));
process.chdir(tmp);
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV = 'test';

const { default: app } = await import('../../api/app.js');
const { emailCodeStore } = await import('../../api/services/email.js');
const { accountStore } = await import('../../api/services/accounts.js');
const { creationPromptLog } = await import('../../api/services/creationPromptLog.js');

let server: import('node:http').Server;
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as { port: number };
  baseUrl = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function req(method: string, p: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': 'cplog-device-1',
      ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: json as any };
}

/** 注册一个测试账号并返回 token（走进程内验证码，绕开发信限流） */
async function register(username: string, email: string): Promise<string> {
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username, email, password: 'pass123', code } });
  assert.strictEqual(reg.status, 200, '注册应成功: ' + JSON.stringify(reg.json).slice(0, 200));
  assert.ok(reg.json.data.token, '注册应返回 token');
  return reg.json.data.token as string;
}

test('AI 建剧提示词：灵感被红线拦下也留痕（不调用 AI、不扣额度）', async () => {
  const email = 'cp-blocked@example.com';
  const token = await register('cpblocked', email);
  const acc = accountStore.findByEmail(email);
  assert.ok(acc, '账号应已创建');

  const r = await req('POST', '/api/roleplay/custom/draft', { token, body: { idea: '我想自杀', lang: 'zh' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'CONTENT_REJECTED');

  const list = creationPromptLog.listByUser(acc!.userId, 5);
  assert.strictEqual(list.length, 1, '被拦的灵感也应留一条');
  assert.strictEqual(list[0].kind, 'roleplay-draft');
  assert.strictEqual(list[0].outcome, 'blocked');
  assert.strictEqual(list[0].prompt, '我想自杀');
});

test('创建自建剧本时回传的提示词会落库，并出现在控制台用户详情里', async () => {
  const email = 'cp-save@example.com';
  const token = await register('cpsave', email);
  const acc = accountStore.findByEmail(email);
  assert.ok(acc, '账号应已创建');

  const created = await req('POST', '/api/roleplay/custom', { token, body: {
    title: '雨夜重逢', aiName: '阿黎', aiPersona: '温柔但嘴硬', background: '雨夜的老城区', opening: '你推开门，她正收伞。',
    creationPrompt: '写一个雨夜重逢、克制又暖的故事',
  } });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json).slice(0, 200));
  assert.strictEqual(created.json.data.creationPrompt, '写一个雨夜重逢、克制又暖的故事');

  // 控制台的「用户详情（完整记录）」接口就是这条（自建剧本 + AI 建剧提示词都在它里面）
  const admin = await req('GET', '/api/payment/admin/users/' + acc!.userId + '/chat?token=test-admin-token');
  assert.strictEqual(admin.status, 200, JSON.stringify(admin.json).slice(0, 200));
  assert.ok(Array.isArray(admin.json.data.creationPrompts), '控制台用户详情应带 creationPrompts 数组');
  assert.strictEqual(admin.json.data.customScenarios[0].creationPrompt, '写一个雨夜重逢、克制又暖的故事');
});
