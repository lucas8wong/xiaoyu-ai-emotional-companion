/**
 * 剧情链路「上游并发闸门」—— 第三方托管专用
 *
 * 为什么需要：
 *   Featherless 的 $25 档以「并发单元」计价，而模型的 concurrency_cost 会吃掉单元
 *   （27B 稠密 = cost 2 → 4 个单元里实际只有约 2 路并发）。并发打满时上游返回 429，
 *   而剧情回复走的是流式路径，**流式按设计不重试**（避免 token 重复下发）——
 *   结果是用户直接看到失败，而不是慢一点。
 *
 * 做法：在本地排队，保证「同时对上游的在途请求数」不超过上限；超出的请求在队列里等，
 * 而不是撞上去拿 429。等太久（默认 25s）就明确失败，不无限堆积。
 *
 * 这是**客户端侧**的保护：它不能让托管方变快，只能把「必然失败」变成「排队稍等」。
 * 真正的扩容仍需要提高托管档位（Developer 档 100 并发单元）或自托管。
 *
 * 环境变量：
 *   RP_MAX_CONCURRENT     同时在途的请求数上限，默认 2（对应 $25 档 27B 模型的实测并发）
 *   RP_QUEUE_MAX_WAIT_MS  排队最长等待，默认 25000；超时抛出可识别的错误
 */

const MAX_CONCURRENT = Math.max(1, Number(process.env.RP_MAX_CONCURRENT || 2));
const MAX_WAIT_MS = Math.max(0, Number(process.env.RP_QUEUE_MAX_WAIT_MS || 25000));

/** 队列等待超时的错误标记，便于上层识别并给出「稍后再试」而不是「网络异常」 */
export class RpQueueTimeoutError extends Error {
  readonly code = 'RP_QUEUE_TIMEOUT';
  constructor(waitedMs: number) {
    super(`角色回复排队超过 ${Math.round(waitedMs / 1000)} 秒仍未轮到（当前并发已满），请稍后重试`);
    this.name = 'RpQueueTimeoutError';
  }
}

let running = 0;
let queue: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; enqueuedAt: number }> = [];

/** 累计统计（只用于排查与运维观测） */
const stats = { total: 0, queued: 0, timedOut: 0, maxQueueDepth: 0, maxWaitMs: 0 };

function release(): void {
  running--;
  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
    running++; // 直接把名额交给队首，避免中间被插队
    next.resolve();
  }
}

/** 排队信息：告诉调用方「你要等多久、前面有几个」 */
export interface QueueWaitInfo {
  /** 我前面还有几个请求（0 = 下一个就轮到我） */
  ahead: number;
  /** 队列总长度（含我自己） */
  waiting: number;
  /** 当前正在跑的请求数 */
  running: number;
  /** 并发上限 */
  maxConcurrent: number;
}

/** 取得一个上游名额；拿不到就在队列里等，等超时抛 RpQueueTimeoutError */
function acquire(onWait?: (info: QueueWaitInfo) => void): Promise<void> {
  stats.total++;
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  stats.queued++;
  if (queue.length + 1 > stats.maxQueueDepth) stats.maxQueueDepth = queue.length + 1;
  const enqueuedAt = Date.now();
  // 入队瞬间就把排队情况报上去：前端可以立刻显示「前面还有 N 个」，而不是干等 spinner
  const ahead = queue.length;
  try {
    onWait?.({ ahead, waiting: queue.length + 1, running, maxConcurrent: MAX_CONCURRENT });
  } catch { /* 上报失败绝不能影响排队本身 */ }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = queue.findIndex((q) => q.timer === timer);
      if (i >= 0) queue.splice(i, 1);
      stats.timedOut++;
      reject(new RpQueueTimeoutError(Date.now() - enqueuedAt));
    }, MAX_WAIT_MS);
    queue.push({
      resolve: () => {
        const w = Date.now() - enqueuedAt;
        if (w > stats.maxWaitMs) stats.maxWaitMs = w;
        resolve();
      },
      reject,
      timer,
      enqueuedAt,
    });
  });
}

/**
 * 在并发闸门内执行一次上游调用。
 * 无论成功/失败都会释放名额（用 finally，避免异常导致名额泄漏把链路彻底卡死）。
 *
 * @param onWait 需要排队时回调一次，带上「前面还有几个 / 队列多长」——供前端显示排队状态
 */
export async function withUpstreamSlot<T>(fn: () => Promise<T>, onWait?: (info: QueueWaitInfo) => void): Promise<T> {
  await acquire(onWait);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 当前水位（供日志/健康检查/排查用） */
export function rpQueueStats(): {
  maxConcurrent: number;
  maxWaitMs: number;
  running: number;
  waiting: number;
  total: number;
  queued: number;
  timedOut: number;
  maxQueueDepth: number;
  maxWaitObservedMs: number;
} {
  return {
    maxConcurrent: MAX_CONCURRENT,
    maxWaitMs: MAX_WAIT_MS,
    running,
    waiting: queue.length,
    total: stats.total,
    queued: stats.queued,
    timedOut: stats.timedOut,
    maxQueueDepth: stats.maxQueueDepth,
    maxWaitObservedMs: stats.maxWaitMs,
  };
}

/** 仅测试用：重置内部状态 */
export function __resetQueueForTest(): void {
  running = 0;
  for (const q of queue) clearTimeout(q.timer);
  queue = [];
  stats.total = 0; stats.queued = 0; stats.timedOut = 0; stats.maxQueueDepth = 0; stats.maxWaitMs = 0;
}

/** 上游是否「并发已满 / 限流」——用于决定要不要重试 */
export function isUpstreamBusyError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  const status = Number((err as any)?.status || (err as any)?.statusCode || 0);
  return status === 429 || status === 503 || /\b429\b|too many requests|rate.?limit|concurren|overloaded|capacity/i.test(msg);
}

/**
 * 遇到「忙/限流」时退避重试。
 *
 * @param hasEmitted 流式专用：已经吐出过 token 就不能重试（会重复下发）。
 *                   本地闸门已经把并发压在上限内，这里只是第二道保险。
 */
export async function retryBusy<T>(
  fn: () => Promise<T>,
  hasEmitted?: () => boolean,
  attempts = Math.max(0, Number(process.env.RP_BUSY_RETRIES || 2)),
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const canRetry = isUpstreamBusyError(e) && i < attempts && !(hasEmitted && hasEmitted());
      if (!canRetry) throw e;
      const delay = 400 * Math.pow(2, i) + Math.floor(Math.random() * 200); // 抖动，避免多路同时重试再撞
      console.warn(`⚠️ [RPQueue] 上游繁忙，${delay}ms 后重试（第 ${i + 1}/${attempts} 次）`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
