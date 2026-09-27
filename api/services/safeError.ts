/**
 * 对外安全错误工具
 * 内部错误详情（含技术栈/配置/上游原文）只进服务器日志，不返回给用户，
 * 避免泄露：用了什么模型/供应商、.env 配置项、上游服务错误原文等内部信息。
 */

export type ErrKind = 'ai' | 'payment' | 'image' | 'server' | 'generic';

/** 对外展示的用户友好文案（不含技术细节） */
const FRIENDLY: Record<ErrKind, string> = {
  ai: '生成失败，请稍后重试',
  payment: '支付操作失败，请稍后重试',
  image: '图片处理失败，请稍后重试',
  server: '服务暂时不可用，请稍后重试',
  generic: '操作失败，请稍后重试',
};

/**
 * 记录内部错误到日志，并返回给用户的安全文案。
 * 用法：res.status(500).json({ success: false, error: safeError('ai', err) })
 */
export function safeError(kind: ErrKind, err?: unknown): string {
  if (err) {
    // 内部详情只进日志（生产环境日志由守护脚本写入 data/server.log，不外泄）
    console.error('[safeError:' + kind + ']', err instanceof Error ? err.message : String(err));
  }
  return FRIENDLY[kind] || FRIENDLY.generic;
}
