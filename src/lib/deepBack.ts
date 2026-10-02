/**
 * 深页「返回键」协调器：最深的已挂载组件（如千世书 WenyouApp、剧情模式 RoleplayPage）向这里注册返回处理器。
 * Home 的 popstate 回调先问它们能否消费这次返回（逐级回退）；只有都没接管时，
 * Home 才按原逻辑（关角色扮演 / 关关于 / 退出理一理）处理。
 *
 * 2026-09-19 改为**栈式**（原来是单例 set/get）：
 *   · 单例有个隐患，子组件卸载时 `setDeepBackHandler(null)` 会把**父组件**刚注册的处理器一起抹掉
 *     （父注册在子之后，被子顶掉；子一卸载就全没了）。剧情模式现在自己也要注册，父子叠加是常态，所以必须能共存。
 *   · `runDeepBack()` 从**最后注册（最深）**的往前问，任一个返回 true 即算消费。
 *     顺序上「父后注册」没关系：父组件遇到自己不该管的层（如剧情模式遇到 stage='wenyou'）返回 false 让位即可。
 */
type DeepBackHandler = () => boolean

const handlers: DeepBackHandler[] = []

/**
 * 注册一个返回处理器，返回**注销函数**（请在 effect 里 `return` 它）。
 * @param h 返回 true = 这次返回已被消费（不再往上层问）
 */
export function pushDeepBackHandler(h: DeepBackHandler): () => void {
  handlers.push(h)
  return () => {
    const i = handlers.indexOf(h)
    if (i >= 0) handlers.splice(i, 1)
  }
}

/** 从最深（最后注册）往前问一遍；返回 true = 有人消费了这次返回 */
export function runDeepBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    try {
      if (handlers[i]()) return true
    } catch {
      // 某个处理器抛错不该阻断返回链（下一个还有机会接管）
    }
  }
  return false
}

/** 仅用于调试/自检：当前注册了几个处理器 */
export function deepBackHandlerCount(): number {
  return handlers.length
}
