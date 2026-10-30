import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from '../unit/setup.js';
setupTempCwd();
Object.assign(process.env, { NODE_ENV: 'test', PERSISTENCE_PROVIDER: 'file', ARCHIVE_SEMANTIC: '0',
  DEEPSEEK_API_KEY: 'synthetic-recall-dispatch', NANOGPT_API_KEY: 'synthetic-recall-dispatch',
  RP_ZH_PROVIDER: 'custom', RP_ZH_BASE_URL: 'https://recall-dispatch.invalid/v1', RP_ZH_API_KEY: 'synthetic-recall-dispatch',
  RP_ZH_MODEL: 'grok-cache-test', RP_ZH_FLAT_RATE: '0', ARCHIVE_GROUNDING: '0' });
const { conversationArchive } = await import('../../api/storage/conversationArchive.js');
const { hybridArchiveRecallBlock } = await import('../../api/services/archiveRecall.js');
const { quotaStore } = await import('../../api/services/quota.js');
const { preferenceStore } = await import('../../api/services/preferences.js');
const { storyContextLimits } = await import('../../api/services/roleplayContextPolicy.js');
const { withRoleplayProvider } = await import('../../api/services/roleplayProviderContext.js');
const { roleplayReplyCustom } = await import('../../api/services/roleplay.js');
const { NANO_STORY_MODELS } = await import('../../src/lib/roleplayTrialModels.js');
const { chatClientFor } = await import('../../api/services/chatModel.js');
const { chatReply, chatReplyStream } = await import('../../api/services/gemini.js');
const owner = 'recall-dispatch-owner'; quotaStore.setOpsMode(owner, true, 'max');
const query = '林澄借款的条件是什么，铜钥匙交给谁？';
conversationArchive.ensure('dispatch-owned-source', () => [
  { role: 'user', content: '林澄借款条件：先交押金，必须周六归还。CONDITION_SOURCE_742。' },
  { role: 'assistant', content: '条件没有被取消，也未交付借款。' },
  { role: 'user', content: '铜钥匙交给何夏保管。HOLDER_SOURCE_983。' },
  { role: 'assistant', content: '何夏已经接过钥匙，放入青岚柜。' },
]);
const evidence = await hybridArchiveRecallBlock('dispatch-owned-source', query, 4, { story: true, plan: 'max', evidenceTokens: 4096 });
const original = globalThis.fetch, requests: Array<{ messages: Array<{ role: string; content: unknown }>; max_tokens?: number }> = [];
globalThis.fetch = async (_url, init) => {
  if (!init?.body) return Response.json({});
  const body = JSON.parse(String(init.body)); if (!body.messages) return Response.json({}); requests.push(body);
  const content = '林澄借款需要先交押金、周六归还，铜钥匙现在由何夏保管。';
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  return body.stream ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n')
    : Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage });
};
after(() => { globalThis.fetch = original; });
const history = [{ role: 'user' as const, content: query }];
const custom = { id: 'recall-dispatch-story', userId: owner, title: '书店', aiName: '阿宁', aiPersona: '温柔的成年朋友。', background: '成年朋友在书店见面。', opening: '我等你。', createdAt: 1 };

test('real Story builders retain complete v2 evidence under every route, preset and JSON/stream wire', async () => {
  let cases = 0;
  for (const provider of ['deepseek', 'grok', ...NANO_STORY_MODELS.map(m => 'nano:' + m.id)])
    for (const preset of ['full', 'short', 'none', 'custom', 'append'] as const) for (const stream of [false, true]) {
      preferenceStore.set(owner, { roleplaySharedPromptPreset: preset });
      const start = requests.length;
      await withRoleplayProvider(provider, () => roleplayReplyCustom(custom, history, { userId: owner, lang: 'zh', unlimited: provider !== 'deepseek',
        thinkingLevel: 'off', contextLimits: storyContextLimits('max'), retrievalBlock: evidence,
        ...(stream ? { onToken: () => {} } : {}) }));
      const sent = JSON.stringify(requests.slice(start));
      assert.match(sent, /CONDITION_SOURCE_742/); assert.match(sent, /先交押金/); assert.match(sent, /周六归还/); assert.match(sent, /HOLDER_SOURCE_983/);
      for (const body of requests.slice(start)) assert.equal(body.max_tokens, undefined);
      cases++;
    }
  assert.equal(cases, 120);
});

test('real Chat builders retain v2 evidence as authoritative SYSTEM in JSON and streaming', async () => {
  for (const provider of ['deepseek', 'grok', 'nano:deepseek/deepseek-v3.2', 'nano:google/gemini-3.1-flash-lite']) for (const stream of [false, true]) {
    const start = requests.length, options = { userId: owner, modelChoice: chatClientFor(provider), thinkingLevel: 'off' as const, archiveEvidence: evidence };
    if (stream) await chatReplyStream(history, { ...options, onToken: () => {} }); else await chatReply(history, options);
    assert.equal(requests.length - start, 1);
    const systems = requests[start].messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    assert.match(systems, /CONDITION_SOURCE_742/); assert.match(systems, /周六归还/); assert.match(systems, /HOLDER_SOURCE_983/);
  }
});
