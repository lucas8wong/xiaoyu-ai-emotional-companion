/**
 * 「最新优先」串行保存队列的单测（2026-09-18）
 *
 * 钉死两条**必须成立**的性质（剧情自动保存靠它们避免乱序覆盖与无意义重写）：
 *   ① 同一时刻只有一个写请求在途，服务端收到的顺序 = 状态产生的顺序；
 *   ② 最后一次 enqueue 的内容一定落盘（中间态可以合并，最新态不能丢）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createSerialSaveQueue } from '../../src/lib/serialSave.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('串行：同一时刻只有一个写在途，顺序与调用顺序一致', async () => {
  const order: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const q = createSerialSaveQueue<number>(async (v) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(10);
    order.push(v);
    inFlight -= 1;
  });
  q.enqueue(1);
  q.enqueue(2);
  q.enqueue(3);
  await q.drain();
  assert.strictEqual(maxInFlight, 1, '不能有并发写入（否则旧状态可能晚于新状态落盘）');
  assert.deepStrictEqual(order, [1, 3], '中间态 2 被合并掉（只保留最新的排队内容）');
  assert.strictEqual(order[order.length - 1], 3, '最后一次调用必须落盘');
});

test('最新态一定落盘：写入很慢时连续 enqueue，最后一次之后 drain 仍写到最新值', async () => {
  const written: string[] = [];
  const q = createSerialSaveQueue<string>(async (v) => {
    await sleep(5);
    written.push(v);
  });
  for (const v of ['a', 'b', 'c', 'd', 'e']) q.enqueue(v);
  await q.drain();
  assert.strictEqual(written[0], 'a');
  assert.strictEqual(written[written.length - 1], 'e', '收尾竞态不能把最后一次调用丢掉');
  assert.ok(written.length <= 3, `写次数应被合并（实际 ${written.length}）`);
});

test('写入抛错不卡住队列（剧情不能被保存失败拖死）', async () => {
  const written: number[] = [];
  const q = createSerialSaveQueue<number>(async (v) => {
    if (v === 1) throw new Error('boom');
    written.push(v);
  });
  q.enqueue(1);
  q.enqueue(2);
  await q.drain();
  assert.deepStrictEqual(written, [2]);
  assert.strictEqual(q.busy(), false);
});

test('busy()：空闲 / 在途 / 排队 三种状态', async () => {
  const q = createSerialSaveQueue<number>(async () => { await sleep(15); });
  assert.strictEqual(q.busy(), false);
  q.enqueue(1);
  assert.strictEqual(q.busy(), true);
  await q.drain();
  assert.strictEqual(q.busy(), false);
});
