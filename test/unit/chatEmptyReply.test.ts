/**
 * 聊一聊「空回复」红线守卫（2026-09-20，红线 6）
 *
 * 起因：`api/services/gemini.ts` 里两个聊天入口原本都写着
 * `text.trim() || '我在的。慢慢说，我会认真听。🌱'`，模型一个字都没吐时，服务端**替小愈编了一句台词**。
 * 它有三重问题：① 是用户投诉的「我在呢/慢慢说」同款模板；② 绕过失败态被当成"小愈说过的话"
 * 落盘、并回灌给模型（2026-09-15 事故的同一形态）；③ 英文用户还会收到这句中文。
 *
 * 现在改成：**抛错**，由路由下发失败态（流式端点 `{ type: 'error' }`、非流式 500 + 额度回滚）。
 *
 * 这组断言用 **stub `globalThis.fetch`**（与 `test/unit/roleplayModel.test.ts` 同一套做法）跑真实调用链，
 * 不碰网络。第二个用例是**阳性对照**，没有它，第一个用例可能因为"stub 本身就不工作"而假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const gem: any = await import('../../api/services/gemini.js');

/** 把上游换成固定回复；返回还原函数 */
function stubUpstream(content: string) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => content,
    } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = original; }, count: () => calls };
}

test('阳性对照：模型正常吐字时，回复就是模型那句话（证明 stub 真的接住了调用）', async () => {
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
  const stub = stubUpstream('嗯，我在听。今天想聊点什么？');
  try {
    const reply = await gem.chatReply([{ role: 'user', content: '在吗' }], undefined);
    assert.equal(reply, '嗯，我在听。今天想聊点什么？', 'stub 没接住或返回值被改写：' + reply);
    assert.ok(stub.count() > 0, 'stub 一次都没被调用 → 这个测试什么都没证明');
  } finally {
    stub.restore();
  }
});

test('空回复：抛错（失败态 + 重试），绝不返回"我在的。慢慢说，我会认真听。🌱"那种伪造台词', async () => {
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
  const stub = stubUpstream('');
  try {
    await assert.rejects(
      () => gem.chatReply([{ role: 'user', content: '在吗' }], undefined),
      /EMPTY_REPLY|空回复/,
      '空回复没有抛错，说明又去伪造台词了',
    );
  } finally {
    stub.restore();
  }
});
