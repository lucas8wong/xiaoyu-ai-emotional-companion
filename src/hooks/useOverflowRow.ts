/**
 * useOverflowRow —— 检测一行内容是否溢出容器（会换行/折断），用于「功能字换行 → 收进…」的响应式折叠。
 *
 * 思路：
 *  - containerRef 挂到真正显示的容器；
 *  - canaryRef 挂到一个「绝对定位/不可见」的同内容行（whitespace-nowrap），用于量取自然宽度；
 *  - 当 canary 自然宽度 > 容器可用宽度 → overflowing=true（该行内容会被折行），
 *    调用方据此把带文字的功能项收进「…」下拉。
 *
 * 用 callback ref + 节点状态，确保「稍后才挂载」的栏（如理一理步骤栏）在节点出现时也能建立观察；
 * ResizeObserver 监听容器与 canary（内容变化/视图变化都会触发），避免「收起后就量不出」的死循环。
 */
import { useCallback, useEffect, useState } from 'react';

export function useOverflowRow() {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const [canaryNode, setCanaryNode] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const containerRef = useCallback((el: HTMLDivElement | null) => setContainerNode(el), []);
  const canaryRef = useCallback((el: HTMLDivElement | null) => setCanaryNode(el), []);

  useEffect(() => {
    if (!containerNode || !canaryNode) return;
    const check = () => setOverflowing(canaryNode.scrollWidth > containerNode.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(containerNode);
    ro.observe(canaryNode);
    window.addEventListener('resize', check);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [containerNode, canaryNode]);

  return { containerRef, canaryRef, overflowing };
}
