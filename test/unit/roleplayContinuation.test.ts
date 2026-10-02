/**
 * C 方案（自动续写）的循环逻辑单测，`roleplayReplyWithContinuation`。
 *
 * 不打桩模型，直接注入 `generate`：这样才能精确控制"第一轮半截、第二轮补完、第三轮原样重抄"
 * 这类真实模型很难稳定复现的行为。真实链路（SSE + 路由 + 上游）的验证在
 * `test/integration/roleplayContinuation.test.ts`。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { roleplayReplyWithContinuation } = await import('../../api/services/roleplay.js');

// ⚠️ 夹具要写成"标记都配对、只有最后那个 （ 悬空"的样子，这才是真实断点的长相：
//    真实那条（用户 98e677f1 的第 139 条）里，前面的 （他低笑一声…） 是闭合的，只有最后「（他并未退」悬空。
//    第一版夹具我把开头的 （ 漏了闭合 → 判定永远 unclosed，续写也补不回来（错在夹具，不在判据）。
const HALF = '（他低笑一声，把杯子放下。）\n\n「来，张嘴。daddy 帮你看着镜子……乖，慢慢刷。」\n\n（他并未退';
const DONE = '出去半步，反手把门带上。）「先睡吧。」';
const FULL = '（他笑了一下，把杯子推到一边。）\n\n「先睡吧。」';

test('一次写完 → 不续写（只调用一次生成）', async () => {
  const calls: Array<{ partial?: string }> = [];
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls.push({ partial: cont?.partial });
    return { text: FULL, finishReason: 'stop' };
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].partial, undefined);
  assert.strictEqual(out.reply, FULL);
  assert.strictEqual(out.continued, 0);
  assert.strictEqual(out.incomplete, null);
});

test('半截 → 自动续写一次并去重叠拼接（断点处的「退」只出现一次）', async () => {
  const seen: Array<string | undefined> = [];
  const out = await roleplayReplyWithContinuation(async (cont) => {
    seen.push(cont?.partial);
    return cont ? { text: DONE, finishReason: 'stop' } : { text: HALF, finishReason: 'stop' };
  });
  assert.deepStrictEqual(seen, [undefined, HALF], '第二轮必须把半截当断点传下去');
  assert.strictEqual(out.reply, HALF + '出去半步，反手把门带上。）「先睡吧。」');
  assert.ok(!out.reply.includes('退退'), '断点处的「退」只能出现一次（去重叠生效）');
  assert.strictEqual(out.continued, 1);
  assert.strictEqual(out.incomplete, null, '拼接后应判定为写完');
});

test('finish_reason=length（撞 max_tokens）也算半截 → 触发续写', async () => {
  const out = await roleplayReplyWithContinuation(async (cont) =>
    cont ? { text: '接着写完了。', finishReason: 'stop' } : { text: '他笑了一下。', finishReason: 'length' });
  assert.strictEqual(out.continued, 1);
  assert.strictEqual(out.reply, '他笑了一下。接着写完了。');
  assert.strictEqual(out.incomplete, null);
});

test('上限：max=0 不续写；续写后仍半截则如实标出（不谎报写完）', async () => {
  const noCont = await roleplayReplyWithContinuation(async () => ({ text: HALF, finishReason: 'stop' }), { max: 0 });
  assert.strictEqual(noCont.continued, 0);
  assert.strictEqual(noCont.incomplete, 'unclosed');

  const stillHalf = await roleplayReplyWithContinuation(
    async (cont) => (cont ? { text: '，还是停在这里（没有收尾', finishReason: 'stop' } : { text: HALF, finishReason: 'stop' }),
    { max: 1 },
  );
  assert.strictEqual(stillHalf.continued, 1);
  assert.strictEqual(stillHalf.incomplete, 'unclosed');
});

test('续写没有产出新内容（原样重抄）→ 立刻停，不原地打转', async () => {
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls += 1;
    return cont ? { text: cont.partial, finishReason: 'stop' } : { text: HALF, finishReason: 'stop' };
  }, { max: 3 });
  assert.strictEqual(calls, 2, '重抄一次就停（不能把 max 用满）');
  assert.strictEqual(out.reply, HALF);
  assert.strictEqual(out.continued, 0, '没有新内容不算续写成功');
  assert.strictEqual(out.incomplete, 'unclosed');
});

test('续写调用失败 → 保留已写正文（绝不吞掉半截）并交给前端提示', async () => {
  const out = await roleplayReplyWithContinuation(async (cont) => {
    if (cont) throw new Error('upstream 502');
    return { text: HALF, finishReason: 'stop' };
  });
  assert.strictEqual(out.reply, HALF, '续写失败不能把用户已经看到的正文丢了');
  assert.strictEqual(out.continued, 0);
  assert.strictEqual(out.incomplete, 'unclosed');
});

test('首轮失败照旧上抛（额度回滚/失败提示的既有行为不变）', async () => {
  await assert.rejects(
    () => roleplayReplyWithContinuation(async () => { throw new Error('upstream down'); }),
    /upstream down/,
  );
});

test('「发现断了就马上续写」：首轮再慢也不拦**第一次**续写（用户口径）', async () => {
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls += 1;
    // 首轮故意很慢（模拟 27B 排队/长生成）：旧口径（从首轮前起算的总预算）会因为预算耗尽而**不续**，
    // 与"发现断了就续"的直觉相反 → 现在的口径是按续写自身耗时计、且不拦第一次。
    if (!cont) await new Promise((r) => setTimeout(r, 30));
    return cont ? { text: '出去半步，反手把门带上。）「先睡吧。」', finishReason: 'stop' } : { text: HALF, finishReason: 'stop' };
  }, { budgetMs: 0, max: 1 });
  assert.strictEqual(calls, 2, '首轮结束、判定没写完 → 立刻发起续写（预算为 0 也不该拦下第一次）');
  assert.strictEqual(out.continued, 1);
  assert.strictEqual(out.incomplete, null);
});

test('续写是「判定即发起」：onContinue 事件排在第二次生成之前（没有等待窗口）', async () => {
  const events: string[] = [];
  await roleplayReplyWithContinuation(async (cont) => {
    events.push(cont ? 'generate:continuation' : 'generate:first');
    return cont ? { text: '。', finishReason: 'stop' } : { text: HALF, finishReason: 'stop' };
  }, { max: 1, onContinue: () => events.push('event:continue') });
  assert.deepStrictEqual(events, ['generate:first', 'event:continue', 'generate:continuation']);
});

test('默认上限＝2（2026-09-18 用户拍板 C：续一次仍半截时再自动补一次）', async () => {
  const { roleplayContinueMax } = await import('../../api/services/roleplay.js');
  const saved = process.env.RP_CONTINUE_MAX;
  try {
    delete process.env.RP_CONTINUE_MAX;
    assert.strictEqual(roleplayContinueMax(), 2, '默认必须是 2，当天 5 次 PARTIAL_UNCLOSED 就是"只补一次"兜不住');
    process.env.RP_CONTINUE_MAX = '1';
    assert.strictEqual(roleplayContinueMax(), 1, 'env 仍可覆盖（回滚到旧行为只要一行）');
    process.env.RP_CONTINUE_MAX = '0';
    assert.strictEqual(roleplayContinueMax(), 0, '0 = 一键关掉自动续写');
    process.env.RP_CONTINUE_MAX = '9';
    assert.strictEqual(roleplayContinueMax(), 3, '硬上限 3 不变（防失控）');
    delete process.env.RP_CONTINUE_MAX;

    // 默认口径下真的会补第二次：首轮半截 → 续写仍半截 → 再续一次 → 第三次仍半截才停手
    let calls = 0;
    const out = await roleplayReplyWithContinuation(async (cont) => {
      calls += 1;
      if (!cont) return { text: HALF, finishReason: 'stop' };
      return calls === 2
        ? { text: '，还是停在这里（没有收尾', finishReason: 'stop' }
        : { text: '（又开了一个括号没收', finishReason: 'stop' };
    });
    assert.strictEqual(calls, 3, '1 次首轮 + 2 次自动续写');
    assert.strictEqual(out.continued, 2, '默认上限 2 → 续写两次');
    assert.ok(out.reply.startsWith(HALF), '已写正文一律保留，绝不吞掉');
    assert.strictEqual(out.incomplete, 'unclosed', '两次都没收尾 → 如实标出（不谎报写完）');
  } finally {
    if (saved === undefined) delete process.env.RP_CONTINUE_MAX; else process.env.RP_CONTINUE_MAX = saved;
  }
});

test('续写预算只拦「第 2 次及以后」：防连环续写把用户拖住', async () => {
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls += 1;
    return cont ? { text: '，还是停在这里（没有收尾', finishReason: 'stop' } : { text: HALF, finishReason: 'stop' };
  }, { max: 3, budgetMs: 0 });
  assert.strictEqual(calls, 2, '第一次续写照常发生；第二次被预算拦下');
  assert.strictEqual(out.continued, 1);
  assert.strictEqual(out.incomplete, 'unclosed');
});

test('空回复不触发续写（空回复走既有的空回复重试，不归这里管）', async () => {
  const out = await roleplayReplyWithContinuation(async () => ({ text: '', finishReason: '' }));
  assert.strictEqual(out.reply, '');
  assert.strictEqual(out.incomplete, null);
  assert.strictEqual(out.continued, 0);
});

/**
 * 重讲闸（2026-09-19）：用户 cf8077d3（林清缇）真实落盘的"同一拍讲两遍"就是这条路径出来的
 *。续写回来的那一段从更早的地方重铺一遍，接缝处措辞微变（overlapTrim 剪不掉），
 * 拼接后正文里出现两块同一拍的内容（实测逐字重复 98–141 字）。取证 `temp/rp-rep-cf8077d3/`。
 */
test('续写在重讲同一拍（整块重抄已写正文）→ 丢弃该段并停手，正文保持原样', async () => {
  const block = '他忽然收紧了揽在你腰间的手臂，将你更紧密地揽入怀中。他的一只手顺着你的大腿内侧缓缓上移，指尖带着不容置疑的力度，轻轻拨开层层叠叠的衣料边缘。';
  const half = '“这双手若是不安……”\n\n' + block + '（他并未退';
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls += 1;
    // 续写：接缝处新写一句（不构成逐字重叠），紧接着把已写过的整块内容再讲一遍
    return cont
      ? { text: '他并未退却半分，只是把呼吸放得更缓。' + block + '他低语着，声音里带着几分笃定。', finishReason: 'stop' }
      : { text: half, finishReason: 'stop' };
  }, { max: 3 });
  assert.strictEqual(calls, 2, '重讲一次就停手（不把 max 用满）');
  assert.strictEqual(out.reply, half, '已写正文一字不动，重复段绝不拼进来');
  assert.strictEqual(out.continued, 0, '被丢弃的续写不算成功');
  assert.strictEqual(out.incomplete, 'unclosed', '如实标出仍不完整（不谎报写完）');
});

test('触发闸：中段落单的开启符（模型拿开引号当闭引号）→ 不自动续写', async () => {
  let calls = 0;
  // 真实形态：引号"两开"在正文中段，末尾是完整句子 → 旧口径会被判 unclosed 并续满 2 次
  const body = '他低声道：“这双手若是不安……“' + '他继续说着别的事情，语气很平静。'.repeat(20) + '他终于停了下来。';
  const out = await roleplayReplyWithContinuation(async () => {
    calls += 1;
    return { text: body, finishReason: 'stop' };
  }, { max: 2 });
  assert.strictEqual(calls, 1, '一次都不该续写');
  assert.strictEqual(out.reply, body);
  assert.strictEqual(out.continued, 0);
});

/**
 * 手动「继续生成」必须**一次点到底**（2026-09-19 用户实测反馈）：
 * 「第一次被截断我点了继续生成，但又被截断了，第二次继续生成才完整」
 * 自动路径的触发闸对 `mid_sentence + stop` 不续写（治整段复读的成果），结果把「点一次接到底」这个既有承诺打断了。
 * 语义边界：只有用户自己点的那一次放宽这一档；自动续写仍从严。
 */
test('手动续写（manualContinue）：停在半句时点一次就接到底，不再半路停手', async () => {
  // ⚠️ 夹具里**不能留落单的 （**：那会判成 unclosed（真截断通道，会照旧自动续写），
  //    而本条要测的是 mid_sentence。所以末段写成没有括号的普通叙述、停在半句。
  const HALF_NO_PUNCT = '（他低笑一声，把杯子放下。）\n\n「来，张嘴。daddy 帮你看着镜子……乖，慢慢刷。」\n\n他并未退却，只是';
  const calls: Array<string | undefined> = [];
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls.push(cont?.partial);
    if (!cont) return { text: HALF_NO_PUNCT, finishReason: 'stop' };
    // 第一次续写仍停在半句（该链路的收尾习惯），第二次才收尾，点在用户的那一次应当自动补第二次
    return calls.length === 2
      ? { text: '把呼吸放得更缓，指尖停在她的发梢上', finishReason: 'stop' }
      : { text: '，垂着眼没有再看她。', finishReason: 'stop' };
  }, { manualContinue: true });
  assert.strictEqual(calls.length, 3, '1 次续写 + 1 次自动补 = 用户点一次，服务端接到底');
  assert.strictEqual(out.continued, 2);
  assert.strictEqual(out.incomplete, null, '接到底后应判定为写完');
  assert.ok(out.reply.endsWith('，垂着眼没有再看她。'));
});

test('同一段半句，**自动**路径（非手动）仍然不续写（闸门不被这次改动放宽）', async () => {
  const HALF_NO_PUNCT = '（他低笑一声，把杯子放下。）\n\n他并未退却，只是';
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async () => {
    calls += 1;
    return { text: HALF_NO_PUNCT, finishReason: 'stop' };
  }, { max: 2 });
  assert.strictEqual(calls, 1, '自动路径一次都不该续写（mid_sentence + stop）');
  assert.strictEqual(out.continued, 0);
  assert.strictEqual(out.incomplete, 'mid_sentence');
});

/**
 * 篇幅预算（2026-09-19 用户口径「续写应该只是满足一次的字数量，而不是每次都生成类似初始回复的量」）。
 * 反例就是 dev 账号实测那轮：首轮 799 字（经典档目标 400–700，已经超额）→ 又续 551 → 再续 618 = 1968 字。
 */
test('篇幅预算：mid_sentence 且已达本轮目标篇幅 → 不再续写（不再往上加一整条）', async () => {
  const long = '他'.repeat(720) + '还没写完';   // 722 字 ≥ maxTotal 700 且结尾无句末标点 → mid_sentence
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async () => {
    calls += 1;
    return { text: long, finishReason: 'stop' };
  }, { max: 2, band: { maxTotal: 700, topUp: 300 } });
  assert.strictEqual(calls, 1, '已达目标篇幅 → 一次都不续');
  assert.strictEqual(out.continued, 0);
  assert.strictEqual(out.reply, long);
});

test('篇幅预算：续写只补差额（预算传给生成），超预算按句界裁断', async () => {
  // 用变化的句子拼装正文（不能用单字重复：那会先撞上重讲闸，测不到预算）
  const SENT = (i: number) => `他把第${i}件事记在心里，没有再提。`;
  const first = Array.from({ length: 30 }, (_, i) => SENT(i)).join('') + '他还没';
  const addition = Array.from({ length: 12 }, (_, i) => `他又想起了第${i}件旧事，那件事早就过去了。`).join('');
  const seen: Array<number | undefined> = [];
  const out = await roleplayReplyWithContinuation(async (cont) => {
    seen.push(cont?.budgetChars as number | undefined);
    if (!cont) return { text: first, finishReason: 'stop' };
    return { text: addition, finishReason: 'stop' };
  }, { max: 2, manualContinue: true, band: { maxTotal: 700, topUp: 300 } });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], undefined, '首轮不带预算');
  assert.strictEqual(seen[1], 700 - first.length, '第二次调用必须带上“还剩多少字”');
  assert.strictEqual(out.continued, 1);
  assert.ok(out.reply.startsWith(first), '已写正文一字不动');
  assert.ok(out.reply.length < first.length + addition.length, '超预算的那段应被裁');
  assert.ok(out.reply.length <= 700, '拼接后不超过本轮目标篇幅');
  assert.ok(out.reply.endsWith('。'), '裁在句界上，不能砍出半句');
  assert.strictEqual(out.incomplete, null, '裁到句界后是完整句 → 判定写完');
});

test('篇幅预算：真截断（unclosed / length）即使超额也允许续，但同样只补 topUp', async () => {
  const longTruncated = '他'.repeat(800) + '（他并未退';   // 超 700，但断在没闭合的括号里 = 真截断
  const seen: Array<number | undefined> = [];
  const out = await roleplayReplyWithContinuation(async (cont) => {
    seen.push(cont?.budgetChars as number | undefined);
    if (!cont) return { text: longTruncated, finishReason: 'stop' };
    return { text: '出去半步，反手把门带上。）', finishReason: 'stop' };
  }, { max: 1, band: { maxTotal: 700, topUp: 300 } });
  assert.strictEqual(out.continued, 1, '真截断要接着补（否则那句真话永远接不上）');
  assert.strictEqual(seen[1], 120, '超额时只给"够收尾"的最小额度（120），不再补到目标');
  assert.strictEqual(out.incomplete, null);
});

test('篇幅预算：手动「续写」不受"已达目标"限制（用户明确要求补齐），但仍只补 topUp', async () => {
  const long = '他'.repeat(720) + '还没写完';
  let calls = 0;
  const out = await roleplayReplyWithContinuation(async (cont) => {
    calls += 1;
    if (!cont) return { text: long, finishReason: 'stop' };
    return { text: '，他忽然停住了。', finishReason: 'stop' };
  }, { max: 2, manualContinue: true, band: { maxTotal: 700, topUp: 300 } });
  assert.strictEqual(calls, 2, '手动点的那次照旧续写');
  assert.strictEqual(out.incomplete, null);
});

test('本轮目标篇幅按叙事模式分档（与提示词里的档位同源）', async () => {
  const { roleplayTurnLengthBand, roleplayContinueInstr } = await import('../../api/services/roleplay.js');
  assert.deepStrictEqual(roleplayTurnLengthBand('zh', 'classic'), { maxTotal: 700, topUp: 300 });
  assert.deepStrictEqual(roleplayTurnLengthBand('zh', 'immersive'), { maxTotal: 450, topUp: 200 });
  assert.deepStrictEqual(roleplayTurnLengthBand('zh-TW', 'classic'), { maxTotal: 700, topUp: 300 });
  assert.ok(roleplayTurnLengthBand('en', 'classic').maxTotal > 2000, '英文按词折算成字符口径');
  // 预算写进续写指令；没有预算时不多出那一段
  const withBudget = roleplayContinueInstr('zh', { budgetChars: 198, writtenChars: 502 });
  assert.ok(withBudget.includes('最多再补约 198 字'), '续写指令要写明这一轮还能补多少');
  assert.ok(withBudget.includes('已经写了约 502 字'));
  assert.ok(!roleplayContinueInstr('zh').includes('【续写篇幅预算】'), '不给预算时不加这一段');
  const en = roleplayContinueInstr('en', { budgetChars: 200, writtenChars: 500 });
  assert.ok(en.includes('Length budget'));
});
