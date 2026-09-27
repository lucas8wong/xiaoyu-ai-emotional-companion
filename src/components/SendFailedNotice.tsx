/**
 * 「这一轮 AI 没接上」的提示条（失败态 + 重试）
 *
 * 🚨 2026-09-15 事故红线：失败/兜底文案**绝不能**写进消息数组（`messages` / `chatMessages`）——
 * 否则它会以「小愈/角色说过的话」显示、落盘、并回灌给模型当上下文。
 * 所以失败一律用这个**系统提示条**呈现：不是气泡、不进会话、只负责说明 + 给一个重试按钮。
 *
 * 聊一聊（ChatPage）与剧情演绎（RoleplayPage）共用，避免两套 UI 再各自漂移。
 */

interface Props {
  /** 埋点/自动化测试用的稳定标识（如 rp-send-failed / chat-send-failed） */
  testId: string;
  /** 失败原因码，渲染到 data-code 上便于排查与断言 */
  code?: string;
  /** 已本地化的提示文案（服务端可读错误优先，其次 i18n 的 sendFailedNotice） */
  text: string;
  /** 已本地化的重试按钮文案 */
  retryLabel: string;
  onRetry: () => void;
  className?: string;
}

export default function SendFailedNotice({ testId, code, text, retryLabel, onRetry, className }: Props) {
  return (
    <div
      data-testid={testId}
      data-code={code || ''}
      className={'w-full rounded-2xl border border-amber-300/70 bg-amber-50/85 backdrop-blur-sm px-3.5 py-3 shadow-sm ' + (className || '')}
    >
      <p className="text-[13px] leading-relaxed text-amber-900">{text}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-white transition-all hover:bg-primary-strong active:scale-[0.98]"
      >
        {retryLabel}
      </button>
    </div>
  );
}
