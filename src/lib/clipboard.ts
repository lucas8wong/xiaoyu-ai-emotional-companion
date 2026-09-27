/**
 * 主 App 统一的「复制到剪贴板」实现（聊天 / 剧情 / 理一理 共用）。
 *
 * 为什么需要它：各组件此前各自内联 `navigator.clipboard.writeText(...)`，
 * 在非 HTTPS（如局域网 http 调试）、旧浏览器、或权限被拒时会**静默失败**
 * （Promise reject 且没人 catch，用户点了「复制」却什么都没复制到）。
 * 这里统一为「异步 Clipboard API 优先 + execCommand 兜底」，并返回是否成功。
 *
 * ★ 务必在用户手势的「同步起点」调用：任何 await 之后再调用 writeText，
 *   用户激活（user activation）已过期，浏览器会拒绝而静默失败。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到 execCommand 兜底
  }
  return legacyCopy(text);
}

/** execCommand 兜底：临时 textarea + 选中 + copy（不支持 Clipboard API 时用） */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
