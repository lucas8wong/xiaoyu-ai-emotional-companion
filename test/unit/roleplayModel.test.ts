/**
 * 剧情链路双分支模型路由（api/services/roleplayModel.ts）
 *
 * 锁定三件事：
 *  1. 未配置 RP_* 环境变量时**无条件回落 DeepSeek** —— 保证默认状态下线上行为零变化
 *  2. 按剧情语言选分支：zh / zh-TW（含未知值）→ RP_ZH；en → RP_EN
 *  3. 第三方 provider 的请求体里**不含** DeepSeek 专有字段
 *     （thinking / reasoning_effort / user_id / stream_options）
 *     —— 这些字段会让第三方 OpenAI 兼容托管直接 400，是本次改造最大的回归风险点
 *
 * 同时回归保护：DeepSeek 分支仍然照旧注入这些专有字段。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd(); // 必须先于 import：隔离 store，避免测试写到真实 data/

const { roleplayClientFor, roleplayRoutingSummary, roleplayAuxClientFor } = await import('../../api/services/roleplayModel.js');
const { createDeepSeekClient, DEEPSEEK_PROVIDER } = await import('../../api/services/deepseek.js');

const RP_KEYS = [
  'RP_ZH_BASE_URL', 'RP_ZH_API_KEY', 'RP_ZH_MODEL', 'RP_ZH_MAX_TOKENS', 'RP_ZH_EXTRA_BODY',
  'RP_EN_BASE_URL', 'RP_EN_API_KEY', 'RP_EN_MODEL', 'RP_EN_MAX_TOKENS', 'RP_EN_EXTRA_BODY',
  'RP_AUX_BASE_URL', 'RP_AUX_API_KEY', 'RP_AUX_MODEL', 'RP_AUX_PROVIDER',
  'RP_TIMEOUT_MS', 'RP_MAX_RETRIES', 'RP_STREAM_USAGE',
  'RP_PROVIDER', 'RP_ZH_PROVIDER', 'RP_EN_PROVIDER',
];

function clearRpEnv(): void {
  for (const k of RP_KEYS) delete process.env[k];
}

/** 把两个语言分支都配齐 */
function setBranches(): void {
  process.env.RP_ZH_BASE_URL = 'https://zh.example.com/v1';
  process.env.RP_ZH_API_KEY = 'k-zh';
  process.env.RP_ZH_MODEL = 'zh-model';
  process.env.RP_EN_BASE_URL = 'https://en.example.com/v1';
  process.env.RP_EN_API_KEY = 'k-en';
  process.env.RP_EN_MODEL = 'en-model';
}

/** 替换 globalThis.fetch 抓取上游请求体；返回捕获数组与还原函数 */
function captureFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      text: async () => '',
    } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('未配置 RP_* 时：zh 与 en 都回落 DeepSeek，路由概览显示 default', () => {
  clearRpEnv();
  assert.strictEqual(roleplayClientFor('zh').viaCompat, false);
  assert.strictEqual(roleplayClientFor('zh-TW').viaCompat, false);
  assert.strictEqual(roleplayClientFor('en').viaCompat, false);
  assert.deepStrictEqual(roleplayRoutingSummary(), {
    zh: 'deepseek(default)',
    en: 'deepseek(default)',
    aux: 'deepseek(default)',
    zhReason: 'unset',
    enReason: 'unset',
  });
});

test('一键切回 DeepSeek：RP_PROVIDER=deepseek 让两分支都走官方（无需删配置）', () => {
  clearRpEnv();
  setBranches(); // 第三方配置齐全
  try {
    assert.strictEqual(roleplayClientFor('zh').viaCompat, true, '未加开关时应走第三方');

    process.env.RP_PROVIDER = 'deepseek';
    const zh = roleplayClientFor('zh');
    const en = roleplayClientFor('en');
    assert.strictEqual(zh.viaCompat, false, 'RP_PROVIDER=deepseek 应让中文分支回落');
    assert.strictEqual(en.viaCompat, false, 'RP_PROVIDER=deepseek 应让英文分支回落');
    assert.strictEqual(zh.reason, 'forced');
    assert.strictEqual(en.reason, 'forced');

    // 分支级可反向覆盖全局：只把英文切回第三方
    process.env.RP_EN_PROVIDER = 'custom';
    assert.strictEqual(roleplayClientFor('zh').viaCompat, false, '中文仍被全局开关压住');
    assert.strictEqual(roleplayClientFor('en').viaCompat, true, 'en 的分支级 custom 应覆盖全局 deepseek');
    assert.strictEqual(roleplayClientFor('en').model, 'en-model');
  } finally { clearRpEnv(); }
});

test('按分支切回：RP_ZH_PROVIDER=deepseek 只影响中文，英文继续用第三方', () => {
  clearRpEnv();
  setBranches();
  try {
    process.env.RP_ZH_PROVIDER = 'deepseek';
    const zh = roleplayClientFor('zh');
    const en = roleplayClientFor('en');
    assert.strictEqual(zh.viaCompat, false);
    assert.strictEqual(zh.reason, 'forced');
    assert.strictEqual(en.viaCompat, true, '英文分支不受中文开关影响');
    assert.strictEqual(en.model, 'en-model');
    // zh-TW 与 zh 同分支，应一起回落
    assert.strictEqual(roleplayClientFor('zh-TW').viaCompat, false);
  } finally { clearRpEnv(); }
});

test('开关取值大小写不敏感，认不出的值不改变原行为', () => {
  clearRpEnv();
  setBranches();
  try {
    process.env.RP_PROVIDER = 'DeepSeek'; // 大写也应识别
    assert.strictEqual(roleplayClientFor('zh').viaCompat, false);

    process.env.RP_PROVIDER = 'nonsense'; // 认不出 → 忽略
    assert.strictEqual(roleplayClientFor('zh').viaCompat, true, '无法识别的取值不应误切');
  } finally { clearRpEnv(); }
});

test('三项环境变量缺一即回落 DeepSeek（安全阀）', () => {
  clearRpEnv();
  process.env.RP_ZH_BASE_URL = 'https://zh.example.com/v1';
  process.env.RP_ZH_MODEL = 'zh-model'; // 故意不给 API_KEY
  assert.strictEqual(roleplayClientFor('zh').viaCompat, false);

  process.env.RP_ZH_API_KEY = 'k-zh'; // 补齐后启用
  assert.strictEqual(roleplayClientFor('zh').viaCompat, true);
  clearRpEnv();
});

test('按语言选分支：zh/zh-TW/未知值 → 中文模型，en → 英文模型', () => {
  clearRpEnv();
  setBranches();
  try {
    assert.strictEqual(roleplayClientFor('zh').model, 'zh-model');
    assert.strictEqual(roleplayClientFor('zh-TW').model, 'zh-model');
    assert.strictEqual(roleplayClientFor('en').model, 'en-model');
    // 未知/缺省语言按中文处理（与 RPLang 归一化一致）
    assert.strictEqual(roleplayClientFor(undefined).model, 'zh-model');
    assert.strictEqual(roleplayClientFor('fr').model, 'zh-model');
  } finally { clearRpEnv(); }
});

test('第三方分支：请求体不含 DeepSeek 专有字段，且 baseUrl 结尾斜杠被规范化', async () => {
  clearRpEnv();
  setBranches();
  process.env.RP_ZH_BASE_URL = 'https://zh.example.com/v1/'; // 故意带结尾斜杠
  process.env.RP_ZH_MAX_TOKENS = '2048';

  const { calls, restore } = captureFetch();
  try {
    await roleplayClientFor('zh').client.models.generateContent({
      contents: [
        { role: 'system', parts: [{ text: 'sys' }] },
        { role: 'user', parts: [{ text: 'hi' }] },
      ],
      jsonMode: true,
      thinkingLevel: 'high', // 剧情回复链路确实会传它，必须被丢掉
    });
  } finally { restore(); clearRpEnv(); }

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://zh.example.com/v1/chat/completions');

  const body = calls[0].body;
  assert.strictEqual(body.model, 'zh-model');
  assert.strictEqual(body.max_tokens, 2048, '应使用分支配置的 maxTokens');
  assert.strictEqual(body.thinking, undefined, 'thinking 是 DeepSeek 专有，不能发给第三方');
  assert.strictEqual(body.reasoning_effort, undefined, 'reasoning_effort 是 DeepSeek 专有');
  assert.strictEqual(body.user_id, undefined, 'user_id 是 DeepSeek 专有');
  assert.strictEqual(body.stream_options, undefined, '默认不应带 stream_options');
  // 剧本生成依赖 jsonMode，换后端后这条必须仍然生效
  assert.deepStrictEqual(body.response_format, { type: 'json_object' });
});

test('req.maxTokens 可覆盖分支默认值（剧本生成 5 字段 JSON 需要更大上限）', async () => {
  clearRpEnv();
  setBranches();
  const { calls, restore } = captureFetch();
  try {
    await roleplayClientFor('zh').client.models.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      jsonMode: true,
      maxTokens: 8192,
    });
  } finally { restore(); clearRpEnv(); }
  assert.strictEqual(calls[0].body.max_tokens, 8192);
});

test('流式：默认不带 stream_options，RP_STREAM_USAGE=1 才带', async () => {
  clearRpEnv();
  setBranches();
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n')); c.close(); },
    });
    return { ok: true, status: 200, body: stream, text: async () => '' } as any;
  }) as any;

  try {
    await roleplayClientFor('zh').client.models.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      thinkingLevel: 'max',
    });
    assert.strictEqual(bodies[0].stream_options, undefined, '默认不带 stream_options（第三方可能不支持）');
    assert.strictEqual(bodies[0].thinking, undefined, '流式同样不能带 thinking');

    process.env.RP_STREAM_USAGE = '1';
    await roleplayClientFor('zh').client.models.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.deepStrictEqual(bodies[1].stream_options, { include_usage: true }, '显式开启后应带上');
  } finally { globalThis.fetch = original; clearRpEnv(); }
});

test('回归保护：DeepSeek 分支仍照旧注入 thinking / user_id', async () => {
  clearRpEnv();
  process.env.DEEPSEEK_API_KEY = 'k-ds';
  const { calls, restore } = captureFetch();
  try {
    await createDeepSeekClient().models.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      userId: 'u1',
      thinkingLevel: 'high',
    });
  } finally { restore(); delete process.env.DEEPSEEK_API_KEY; }

  const body = calls[0].body;
  assert.deepStrictEqual(body.thinking, { type: 'enabled' }, 'DeepSeek 分支必须保留 thinking');
  assert.strictEqual(body.reasoning_effort, 'high');
  assert.strictEqual(body.user_id, 'u1', 'DeepSeek 分支必须保留 user_id');
});

// —— 辅助调用单独路由（建议 / 剧本生成与改写）：不占账号并发池 ——

test('辅助调用默认走 DeepSeek，即使 zh/en 分支已配第三方', () => {
  clearRpEnv();
  setBranches();
  try {
    assert.strictEqual(roleplayClientFor('zh').viaCompat, true, '剧情回复应走第三方');
    const aux = roleplayAuxClientFor();
    assert.strictEqual(aux.viaCompat, false, '辅助调用必须回落 DeepSeek，不占并发池');
    assert.strictEqual(aux.model, DEEPSEEK_PROVIDER.model);
    // 即使把 RP_AUX_* 三项配好，没有显式 provider 开关也仍走 DeepSeek
    process.env.RP_AUX_BASE_URL = 'https://aux.example.com/v1';
    process.env.RP_AUX_API_KEY = 'k';
    process.env.RP_AUX_MODEL = 'aux-model';
    assert.strictEqual(roleplayAuxClientFor().viaCompat, false, '未显式开启时不应启用第三方');
  } finally { clearRpEnv(); }
});

test('RP_AUX_PROVIDER=custom 且三项配齐时，辅助调用改走第三方（可用 cost=1 小模型省一半）', () => {
  clearRpEnv();
  setBranches();
  try {
    process.env.RP_AUX_BASE_URL = 'https://aux.example.com/v1';
    process.env.RP_AUX_API_KEY = 'aux-key';
    process.env.RP_AUX_MODEL = 'small/aux-9b';
    process.env.RP_AUX_PROVIDER = 'custom';
    const aux = roleplayAuxClientFor();
    assert.strictEqual(aux.viaCompat, true);
    assert.strictEqual(aux.model, 'small/aux-9b');
    assert.strictEqual(aux.reason, 'configured');
  } finally { clearRpEnv(); }
});

test('RP_AUX_PROVIDER=custom 但三项缺一 → 回落 DeepSeek（半残配置不上生产）', () => {
  clearRpEnv();
  try {
    process.env.RP_AUX_PROVIDER = 'custom';
    process.env.RP_AUX_BASE_URL = 'https://aux.example.com/v1';
    // 故意不设 API_KEY / MODEL
    assert.strictEqual(roleplayAuxClientFor().viaCompat, false, '缺项必须回落');
  } finally { clearRpEnv(); }
});

test('路由概览含辅助调用一行', () => {
  clearRpEnv();
  setBranches();
  try {
    const s = roleplayRoutingSummary();
    assert.strictEqual(s.aux, 'deepseek(default)');
    assert.strictEqual(s.zh, 'zh-model');
  } finally { clearRpEnv(); }
});

// —— 成人档禁止思考模式（2026-09-25 产品决定）——————————————
//
// 背景：曾经接过一版「按用户灰度 + 用户可拨」的思考模式，随后做了预注册对照实验，
// 结论是**不可用**（真实剧情 prompt 下单轮中位 423s、约半数回合只写 22 字残句、生产超时下 3/4 被掐断、
// 主终点 p=1.000 无差异）⇒ 用户口径「移除所有成人模型思考模式」。
// 这里钉住**不变量**：无论 .env / EXTRA_BODY / 残留的旧旋钮怎么写，成人档发出去的
// chat_template_kwargs.enable_thinking 恒为 false。这条不变量是「移除」能守住的关键——
// 托管文档里 Qwen3.5 系的示例恰好是**开**思考，复制粘贴一段配置就可能把它打开，而且不会报警。

/** 抓请求体：让第三方分支真的发一次请求 */
async function captureBody(fn: () => Promise<unknown>): Promise<any[]> {
  const { calls, restore } = captureFetch();
  try { await fn(); } finally { restore(); }
  return calls.map(c => c.body);
}

test('成人档禁止思考：EXTRA_BODY 里写 enable_thinking:true 也会被强制成 false（其它字段原样保留）', async () => {
  clearRpEnv();
  setBranches();
  process.env.RP_ZH_EXTRA_BODY = JSON.stringify({
    chat_template_kwargs: { enable_thinking: true, foo: 'bar' },
    temperature: 0.7, repetition_penalty: 1.15,
  });
  try {
    const bodies = await captureBody(() => roleplayClientFor('zh').client.models.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }));
    assert.strictEqual(bodies[0].chat_template_kwargs.enable_thinking, false, '成人档不允许思考：不变量必须把 true 覆盖成 false');
    assert.strictEqual(bodies[0].chat_template_kwargs.foo, 'bar', '同层其它模板参数不能被抹掉');
    assert.strictEqual(bodies[0].temperature, 0.7, '其它采样参数原样保留');
    assert.strictEqual(bodies[0].repetition_penalty, 1.15, '采样惩罚保留（关思考那一档靠它防复读）');
    assert.strictEqual(bodies[0].thinking, undefined, '也不能给第三方发 DeepSeek 专有的 thinking');
  } finally { clearRpEnv(); }
});

test('成人档禁止思考：旧的思考旋钮已失效（就算 .env 里还留着，也开不起来）', async () => {
  clearRpEnv();
  setBranches();
  process.env.RP_ZH_EXTRA_BODY = JSON.stringify({ chat_template_kwargs: { enable_thinking: false } });
  // 模拟「配置残留 / 有人照旧文档写回去」：这些旋钮现在必须**完全没有作用**
  process.env.RP_ZH_THINKING = 'on';
  process.env.RP_EN_THINKING = 'on';
  process.env.RP_THINKING = 'on';
  process.env.RP_THINKING_ROLLOUT = '100';
  process.env.RP_THINKING_TIMEOUT_MS = '999999';
  process.env.RP_THINKING_MAX_TOKENS = '8192';
  try {
    const bodies = await captureBody(() => roleplayClientFor('zh').client.models.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }));
    assert.strictEqual(bodies[0].chat_template_kwargs.enable_thinking, false, '残留旋钮不能把思考打开');
    assert.strictEqual(bodies[0].max_tokens, 4096, '旧的 THINKING_MAX_TOKENS 不该再抬高输出预算');
    assert.strictEqual((roleplayRoutingSummary() as any).thinking, undefined, '路由概览里不该再有 thinking 字段（功能已移除）');
  } finally { clearRpEnv(); }
});

test('成人档禁止思考：EXTRA_BODY 里没有 chat_template_kwargs 时不凭空造字段', async () => {
  clearRpEnv();
  setBranches();
  process.env.RP_ZH_EXTRA_BODY = JSON.stringify({ temperature: 0.7 });
  try {
    const bodies = await captureBody(() => roleplayClientFor('zh').client.models.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }));
    assert.strictEqual(bodies[0].chat_template_kwargs, undefined, '不该为了"关思考"造出一个托管不认识的字段');
    assert.strictEqual(bodies[0].temperature, 0.7);
  } finally { clearRpEnv(); }
});

test('官方分支：reasoning_content 仍被正确取用（非流式）', async () => {
  clearRpEnv();
  process.env.DEEPSEEK_API_KEY = 'k-ds';
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '正文', reasoning_content: '思考' } }], usage: {} }),
    text: async () => '',
  })) as any;
  try {
    const r = await createDeepSeekClient().models.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    assert.strictEqual(r.candidates[0].content.parts[0].text, '正文');
    assert.strictEqual(r.reasoningContent, '思考', '官方思考内容仍要拿走（记账/带 tools 时必须回传）');
  } finally { globalThis.fetch = original; delete process.env.DEEPSEEK_API_KEY; }
});

test('官方分支：流式 reasoning_content 累积，且思考不进正文回调', async () => {
  clearRpEnv();
  process.env.DEEPSEEK_API_KEY = 'k-ds';
  const original = globalThis.fetch;
  const frames = [
    { choices: [{ delta: { reasoning_content: '想一步' } }] },
    { choices: [{ delta: { reasoning_content: '想两步' } }] },
    { choices: [{ delta: { content: '正文' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  ];
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(c) {
        for (const fr of frames) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(fr) + '\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        c.close();
      },
    });
    return { ok: true, status: 200, body: stream, text: async () => '' } as any;
  }) as any;
  const got: string[] = [];
  try {
    const r = await createDeepSeekClient().models.generateContentStream(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      (d: string) => got.push(d),
    );
    assert.deepStrictEqual(got, ['正文'], '思考内容绝不能混进 onToken（会显示成角色台词）');
    assert.strictEqual(r.reasoningContent, '想一步想两步');
  } finally { globalThis.fetch = original; delete process.env.DEEPSEEK_API_KEY; }
});
