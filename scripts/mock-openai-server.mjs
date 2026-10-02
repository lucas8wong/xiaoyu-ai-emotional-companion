/**
 * 本地 mock 的 OpenAI 兼容服务，用于零成本验证接入管道
 *
 * 用途：
 *  1. 验证 scripts/rp-eval.mts 的整条链路（路由 → prompt 组装 → 判分 → 落盘）无需真实 API
 *  2. 验证「第三方 provider 不注入 DeepSeek 专有字段」，它会把收到的请求体原样落盘
 *  3. 验证 self-host vLLM / 任意 OpenAI 兼容后端的接入配置是否写对
 *
 * 用法：
 *   node scripts/mock-openai-server.mjs            # 默认 :8099
 *   set MOCK_PORT=8099 && node scripts/mock-openai-server.mjs
 *
 * 然后把评测台指过来：
 *   set EVAL_BASE_URL=http://127.0.0.1:8099/v1
 *   set EVAL_API_KEY=mock
 *   set EVAL_MODELS=mock/model-a
 *   npx tsx scripts/rp-eval.mts
 *
 * 落盘：temp/mock-openai-requests.jsonl（每个请求一行，含完整请求体）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 8099);
const LOG = path.join('temp', 'mock-openai-requests.jsonl');
fs.mkdirSync('temp', { recursive: true });

/** 一段"像样"的假回复：够长能过 300 字检查，且不带任何违规句式/拒答/净化标记 */
const FAKE_ZH =
  '他把伞接过去靠在门边，指尖在伞柄上停了一瞬才松开，像是刚想起自己原本要说什么。' +
  '屋里只开了一盏落地灯，光从侧面切过来，把他半张脸留在暗处。他往旁边让了半步，' +
  '给出一条能走进来的路，却没有先开口。你站得近了，他身上的气息混着雨水和一点旧木头的味道，' +
  '很淡，但在这个安静的房间里格外清楚。他垂下眼，看着你搭在门框上的手，喉结动了一下，' +
  '终究只是低声说：“进来吧，外面凉。”声音比平时低，尾音散在空气里，像是不打算让你听清。' +
  '他没有再退，也没有往前，只是站在那里等，等你决定这半步要不要迈进来。窗外的雨敲在玻璃上，' +
  '一下一下，把两个人之间那点沉默撑得很满。他终于抬眼看了你一下，很快又移开，' +
  '耳根那点不明显的红被灯光压住了大半。';

const FAKE_EN =
  'He takes the umbrella and leans it against the doorframe, his fingers lingering on the handle a beat longer ' +
  'than the gesture requires, as though he has just remembered something he meant to say. Only the floor lamp ' +
  'is on, and the light cuts across him from the side, leaving half his face in shadow. He steps aside — half ' +
  'a step, no more — opening a narrow path into the room without speaking first. You are close enough now to ' +
  'catch the rain and old wood on him, faint but unmistakable in a room this quiet. He looks down at your hand ' +
  'on the frame, his throat moves, and all he says is, "Come in. It is cold out there." His voice sits lower ' +
  'than usual, the end of it fraying into the air, as if he does not quite intend for you to hear it clearly. ' +
  'He does not step back and does not step forward. He simply stands there and waits — for you to decide ' +
  'whether that half step closes. Rain ticks against the glass, one beat at a time, holding the silence full.';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 保持空 */ }
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        url: req.url,
        auth: (req.headers.authorization || '').replace(/Bearer\s+(.{0,6}).*/, 'Bearer $1…'),
        model: parsed.model,
        // 这四项应为 undefined（第三方分支不得注入 DeepSeek 专有字段）
        hasThinking: parsed.thinking !== undefined,
        hasReasoningEffort: parsed.reasoning_effort !== undefined,
        hasUserId: parsed.user_id !== undefined,
        hasStreamOptions: parsed.stream_options !== undefined,
        maxTokens: parsed.max_tokens,
        responseFormat: parsed.response_format,
        messagesCount: (parsed.messages || []).length,
        systemChars: String(parsed.messages?.[0]?.content || '').length,
        // 无限制模式提示词块是否注入（验证「放开尺度」的条款真的进了 system prompt）
        hasUnlimitedBlock: /成人模式 · 独立提示词|Adult mode · standalone prompt/.test(JSON.stringify(parsed.messages || [])),
        hasTaskInstr: /遵循以上所有要求|follow all the rules above/.test(JSON.stringify(parsed.messages || [])),
      }) + '\n',
      'utf8',
    );

    const hasZh = JSON.stringify(parsed.messages || []).match(/[\u4e00-\u9fff]/);
    const content = hasZh ? FAKE_ZH : FAKE_EN;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion',
      model: parsed.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1800, completion_tokens: 420, total_tokens: 2220 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}/v1  (log -> ${LOG})`);
});
