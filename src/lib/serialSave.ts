/**
 * 「最新优先」的串行保存队列（剧情会话自动保存用，2026-09-18 立）
 *
 * 为什么需要：剧情会话的自动保存是 `useEffect(..., [messages, stage, selected])`，状态一变就发一次
 * `POST /api/roleplay/session`（整份历史，服务端整份覆盖）。这套写法有两个真实问题：
 *
 *   1. **乱序落盘**：请求是并发发出的，先发的未必先到。一个**更旧**（更短）的状态晚于新状态落到服务端，
 *      就会把新内容盖回去。2026-09-18 的线上日志里抓到过实例
 *      （`[RoleplaySession] 拒写未完成回合：新写入 2 条…而库里这条消息之后还有回复（现 3 条）`）。
 *      服务端 `dropsSavedReply()` 那道护栏会挡住最危险的一类，但顺序本身也该由客户端保证。
 *   2. **无意义的重复写**：流式打字期间每次渲染都会整份重发。实测一轮回复发出 **20+ 次**一模一样的
 *      `messages` 全文（每次都要重写 700KB 的 `roleplay-sessions.json`）。
 *
 * 这里的做法：**同一时刻只有一个写请求在途**；期间的多次调用只保留**最后一次**要写的内容，
 * 等当前请求收尾后立刻补写一次。于是「服务端收到的顺序 = 状态产生的顺序」，且写次数从 N 降到 O(1~2)。
 *
 * 语义边界（写清楚，避免误用）：
 *   - 不保证每一次调用都落盘（中间态会被跳过），这正是本队列的目的；
 *   - 但保证**最后一次调用一定会落盘**（收尾还会再看一眼队列，堵住「循环判定为假的瞬间又来新值」的窗口）；
 *   - 写入抛错不打断（剧情不能被保存失败卡住），错误由调用方在 `write` 里自行处理/忽略。
 */
export interface SerialSaveQueue<T> {
  /** 请求保存这份（最新）内容；同一时刻至多一个在途请求，中间态被合并 */
  enqueue(value: T): void;
  /** 还有在途写入或排队内容吗（单测用） */
  busy(): boolean;
  /** 等所有写入落定（单测/收尾用） */
  drain(): Promise<void>;
}

export function createSerialSaveQueue<T>(write: (value: T) => Promise<unknown>): SerialSaveQueue<T> {
  /** 排队中的「最新一份」；null = 队列空 */
  let queued: { value: T } | null = null;
  /** 当前在跑的 pump（null = 没在跑） */
  let running: Promise<void> | null = null;

  const pump = async (): Promise<void> => {
    if (running) return; // 已有 pump 在跑：它会在收尾时再看一次队列
    running = (async () => {
      try {
        while (queued) {
          const next = queued.value;
          queued = null;
          try {
            await write(next);
          } catch {
            /* 保存失败不打断剧情：调用方已在自己的 write 里兜底（本地镜像 + 忽略后端错误） */
          }
        }
      } finally {
        running = null;
      }
    })();
    await running;
    // 收尾竞态：上面 while 判定为假之后、running 置空之前若又来了新值，这里补一次
    if (queued) await pump();
  };

  return {
    enqueue(value: T) {
      queued = { value };
      void pump();
    },
    busy: () => running !== null || queued !== null,
    drain: async () => {
      while (running) await running;
      if (queued) await pump();
    },
  };
}
