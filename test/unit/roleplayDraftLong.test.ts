/**
 * 「AI 帮我写剧本」输入不限字数，**整份剧本原样进 prompt**（真链路验证，不打桩内部函数）。
 *
 * 做法：把 DEEPSEEK_BASE_URL 指向本地 stub（在 import 服务前设好 env，因为 deepseek.ts 在模块加载时读 env），
 * stub 记录收到的 messages 并回一份合法 JSON 草稿 → 断言：
 *   ① 用户消息里包含**完整原文**（含结尾哨兵），即中途没有任何截断（原先在 service 里 slice(0,500)）；
 *   ② 语言/字段契约不变：解析出的草稿字段正确回填。
 * 不产生任何真实 DeepSeek 调用与费用。
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { setupTempCwd } from './setup.js';

const captured: any[] = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { captured.push(JSON.parse(raw)); } catch { captured.push({ parseError: raw.slice(0, 200) }); }
    const content = JSON.stringify({
      title: '雨夜咖啡馆的温柔医生',
      aiName: '沈清言',
      aiPersona: '他是这家咖啡馆的常客，说话轻而稳。',
      background: '雨夜相遇，你们之间有点说不清的拉扯。',
      opening: '他抬眼看你：「外面雨大，先进来躲一会儿吧。」',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
after(() => stub.close());
const port = (stub.address() as { port: number }).port;

// 必须先设 env 再 import：deepseek.ts 的 DEEPSEEK_BASE_URL 是模块级常量
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + port;
setupTempCwd();
const { roleplayDraftCustom, roleplayReviseCustom } = await import('../../api/services/roleplay.js');

/** 把 stub 收到的最近一次请求里的全部文本拼起来（system + user） */
function lastPromptText(): string {
  const last = captured[captured.length - 1];
  const msgs = Array.isArray(last?.messages) ? last.messages : [];
  return msgs.map((m: any) => String(m?.content || '')).join('\n');
}

test('AI 帮我写剧本：贴进来的整份剧本原样进 prompt（不截断），结尾哨兵在场', async () => {
  const script = '【第一幕 雨夜】她推门进来，肩上还挂着雨。\n沈清言抬头看她，把杯子往她那边推了推。\n'.repeat(60) + '【全剧终 · 哨兵-END-OF-SCRIPT】';
  assert.ok(script.length > 2000, '测试剧本应远超原 500 字上限，实际 ' + script.length);

  const draft = await roleplayDraftCustom(script, { lang: 'zh' });

  const prompt = lastPromptText();
  assert.ok(prompt.includes(script), 'prompt 应包含完整原文（含全部 ' + script.length + ' 字）');
  assert.ok(prompt.includes('【全剧终 · 哨兵-END-OF-SCRIPT】'), 'prompt 应包含结尾哨兵（证明尾部未被截断）');
  assert.ok(prompt.includes('【玩家灵感 / 剧本】'), '输入标签应标明可能是整份剧本');
  assert.ok(prompt.includes('忠实沿用'), '系统提示应要求忠实沿用玩家写定的角色与情节');
  // 字段契约不变
  assert.strictEqual(draft.title, '雨夜咖啡馆的温柔医生');
  assert.strictEqual(draft.aiName, '沈清言');
  assert.ok((draft.opening || '').includes('躲一会儿'));
});

test('AI 帮我改剧本：一大段修改要求同样原样进 prompt', async () => {
  const instruction = '请把开场改得更主动一些：'.repeat(60) + '【要求哨兵-END-OF-REQUEST】';
  assert.ok(instruction.length > 500);

  await roleplayReviseCustom({ title: '旧标题', aiName: '沈清言', aiPersona: '温柔', background: '雨夜', opening: '你好。' }, instruction, { lang: 'zh' });

  const prompt = lastPromptText();
  assert.ok(prompt.includes(instruction), 'prompt 应包含完整修改要求');
  assert.ok(prompt.includes('【要求哨兵-END-OF-REQUEST】'), 'prompt 应包含要求结尾哨兵（尾部未被截断）');
  assert.ok(prompt.includes('旧标题'), 'prompt 应带上现有剧本字段');
});
