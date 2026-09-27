/* next/navigation → 浏览器 History/Location 等价物 */
export function useRouter() {
  return {
    push: (u: string) => { window.location.href = u; },
    replace: (u: string) => { window.location.replace(u); },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => {},
    prefetch: () => {},
  };
}
export function usePathname() { return typeof window === 'undefined' ? '/' : window.location.pathname; }
export function useSearchParams() { return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search); }
export function useParams() { return {} as Record<string, string>; }
export function redirect(u: string): never { if (typeof window !== 'undefined') window.location.href = u; throw new Error('redirect'); }
export function notFound(): never { throw new Error('NEXT_NOT_FOUND'); }
