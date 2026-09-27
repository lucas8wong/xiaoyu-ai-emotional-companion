/**
 * 剧情链路并发闸门测试
 *
 * 重点验证四件事（都是会在生产上出事的点）：
 *  1. 并发上限真的被压住（不让上游看到超额并发 → 不撞 429）
 *  2. 排队的请求在名额释放后能接上（不是丢弃）
 *  3. 排太久会明确失败（可识别的 RpQueueTimeoutError），不是无限堆积
 *  4. **抛异常也要释放名额**（否则一次报错就把整条链路卡死）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 必须在 import 之前设置：模块在导入时读取这两个值
process.env.RP_MAX_CONCURRENT = '2';
process.env.RP_QUEUE_MAX_WAIT_MS = '400';
process.env.RP_BUSY_RETRIES = '2';

const { withUpstreamSlot, rpQueueStats, retryBusy, isUpstreamBusyError, RpQueueTimeoutError, __resetQueueForTest } =
  await import('../../api/services/rpQueue.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('并发上限被压住：同时最多只有 N 个任务在跑', async () => {
  __resetQueueForTest();
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, () =>
    withUpstreamSlot(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(30);
      inFlight--;
      return 'ok';
    }),
  );
  const res = await Promise.all(tasks);
  assert.deepStrictEqual(res, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(peak <= 2, `同时在途数应 ≤2，实际峰值 ${peak}`);
  assert.strictEqual(rpQueueStats().running, 0, '跑完后不应有残留占用');
  assert.strictEqual(rpQueueStats().waiting, 0, '跑完后队列应为空');
});

test('排队的请求最终能执行（不是被丢弃）', async () => {
  __resetQueueForTest();
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3, 4].map((n) =>
      withUpstreamSlot(async () => {
        order.push(n);
        await sleep(20);
      }),
    ),
  );
  assert.strictEqual(order.length, 4, '四个任务都必须执行');
  assert.deepStrictEqual([...order].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('等太久会抛出可识别的 RpQueueTimeoutError，而不是无限堆积', async () => {
  __resetQueueForTest();
  const blocker = withUpstreamSlot(() => sleep(2000)); // 占满两个名额很久
  const blocker2 = withUpstreamSlot(() => sleep(2000));
  await sleep(20); // 让它们真的占上名额
  await assert.rejects(
    () => withUpstreamSlot(async () => 'never'),
    (e: any) => e instanceof RpQueueTimeoutError && e.code === 'RP_QUEUE_TIMEOUT',
  );
  assert.ok(rpQueueStats().timedOut >= 1, '应记录超时次数');
  await blocker.catch(() => {});
  await blocker2.catch(() => {});
});

test('抛异常也释放名额（不会因为一次报错把链路卡死）', async () => {
  __resetQueueForTest();
  await assert.rejects(() => withUpstreamSlot(async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(rpQueueStats().running, 0, '异常后名额必须已释放');
  // 名额释放后还能正常跑
  const v = await withUpstreamSlot(async () => 'after-error');
  assert.strictEqual(v, 'after-error');
});

test('isUpstreamBusyError：认得 429/503 与常见限流文案，普通错误不算', () => {
  assert.strictEqual(isUpstreamBusyError({ status: 429 }), true);
  assert.strictEqual(isUpstreamBusyError({ statusCode: 503 }), true);
  assert.strictEqual(isUpstreamBusyError(new Error('429 Too Many Requests')), true);
  assert.strictEqual(isUpstreamBusyError(new Error('concurrency limit reached')), true);
  assert.strictEqual(isUpstreamBusyError(new Error('model overloaded')), true);
  assert.strictEqual(isUpstreamBusyError(new Error('invalid api key')), false);
  assert.strictEqual(isUpstreamBusyError(new Error('roleplay timeout')), false);
});

test('retryBusy：繁忙错误会重试并最终成功', async () => {
  let n = 0;
  const v = await retryBusy(async () => {
    n++;
    if (n < 3) throw Object.assign(new Error('429 rate limit'), { status: 429 });
    return 'ok';
  });
  assert.strictEqual(v, 'ok');
  assert.strictEqual(n, 3, '应在第 3 次成功');
});

test('retryBusy：非繁忙错误不重试（避免放大故障）', async () => {
  let n = 0;
  await assert.rejects(
    () => retryBusy(async () => { n++; throw new Error('invalid api key'); }),
    /invalid api key/,
  );
  assert.strictEqual(n, 1, '不该重试');
});

test('retryBusy：流式已吐过 token 时绝不重试（否则重复下发）', async () => {
  let n = 0;
  let emitted = false;
  await assert.rejects(
    () =>
      retryBusy(async () => {
        n++;
        emitted = true; // 模拟已经吐出 token
        throw Object.assign(new Error('429 mid-stream'), { status: 429 });
      }, () => emitted),
    /429/,
  );
  assert.strictEqual(n, 1, '已吐 token 就不能重试');
});
