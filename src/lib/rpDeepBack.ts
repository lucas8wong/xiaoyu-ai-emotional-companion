/**
 * 剧情模式「返回键」层级表（纯函数 · 无 DOM / 无请求，便于单测）
 *
 * 需求（2026-09-19 用户原话）：「剧情模式的每一层级，手机上的回退功能都应该是让它回退到上一个层级
 * 而不是全部到小愈主界面」。对齐后的口径：
 *   · **系统返回键 / 屏幕边缘侧滑**（= 浏览器历史后退），页内左上角那个 ← 本来就是逐级的，
 *     坏的是系统返回键：`Home.tsx` 的 popstate 处理器一收到返回就把整个剧情模式关掉、跳回小愈主界面；
 *   · **弹层也算一层**（用户拍板 Q2-A）：先关掉最上面的弹层，再按一次才回上一层。
 *
 * 层级（父级 = 再按一次返回要去的地方）：
 *
 *   list 剧本列表（剧情模式的落地层；父级 = 小愈主界面，由 Home 关掉本模块）
 *     ├─ intro     模块介绍（顶栏 ⓘ）
 *     ├─ tags      全部标签
 *     ├─ custom    自建 / 编辑剧本
 *     ├─ detail    剧本设定页
 *     │    └─ chat 对局聊天  ← 父级是 detail（与页内 ← / `leaveChat()` 一致，不是直接回列表）
 *     ├─ wenyou    AI 文游（子树自己还有 home/archive/setup/play/ending 更细的层级，见 src/wenyou/App.tsx）
 *     └─ werewolf  AI 狼人杀
 *
 * 为什么不需要计数器：`Home.tsx` 在进入剧情模式时压一条历史（`xiaoyuRp: 0` = 列表层），
 * 每进一层再由组件补压一条（`xiaoyuRp: rank`），「现在在哪一层」直接读 `history.state.xiaoyuRp` 即可，
 * 不需要自己记账（子组件文游自己也会压条目，记账必然漂移）。返回键的处置由 `resolveRpBack()` 按
 * 当前层级 + 弹层决定，弹层关掉后会**补压一条同层条目**，保证每一层始终有自己那条历史可退。
 */

/** RoleplayPage 的 stage 单一真源（组件那边 `useState<RpStage>` 直接用这个类型） */
export type RpStage = 'intro' | 'list' | 'detail' | 'chat' | 'custom' | 'tags' | 'wenyou' | 'werewolf';

/** 剧情模式内可能盖在页面上的弹层（只有开着的才算一层） */
export type RpOverlay =
  | 'adultGate'        // 18+ 成年确认（portal 到 body）
  | 'coach'            // 首次进入的功能引导气泡遮罩
  | 'bgm'              // 配乐面板
  | 'share'            // 长图分享
  | 'pref'             // 我的偏好抽屉
  | 'regenerate'       // 重新生成
  | 'confirmRestart'   // 重新开始确认
  | 'storyInfo'        // 剧情背景
  | 'tip'              // 进入剧情前的温馨提示（设定页）
  | 'more';            // 聊天页「⋯」菜单

/**
 * 弹层优先级：**最上面那层排最前**，按实际 z-index 从高到低排（adultGate z-95 → coach z-90 →
 * bgm z-70 → share z-60 → 一批 z-50 的弹窗 → 「⋯」菜单在顶栏的 z-30 层叠上下文里，最低）。
 * 同时开两个的机会很少，这张表是「真撞上了也不乱」的兜底。
 */
export const RP_OVERLAY_ORDER: readonly RpOverlay[] = [
  'adultGate',
  'coach',
  'bgm',
  'share',
  'pref',
  'regenerate',
  'confirmRestart',
  'storyInfo',
  'tip',
  'more',
];

/** 每一层的「上一层」（'exit' = 小愈主界面；'delegate' = 交给更深的处理器，文游子树） */
export const RP_STAGE_PARENT: Record<RpStage, RpStage | 'exit' | 'delegate'> = {
  list: 'exit',
  intro: 'list',
  tags: 'list',
  custom: 'list',
  detail: 'list',
  chat: 'detail',
  wenyou: 'delegate',
  werewolf: 'list',
};

/**
 * 层级深度（相对剧本列表）。**必须给每一层配一条自己的历史条目**：
 * 浏览器只有「上一条历史」可退，同一条历史被退掉之后，再按返回就跨文档了（会直接离开小愈）。
 * 实测教训（2026-09-19 首轮验证）：只靠 Home 那条剧情模式历史时，第 2 次返回就跳出了站点
 * 于是每进一层 push 一条带 `xiaoyuRp: rank` 的历史条目，返回键逐条消费。
 */
export const RP_STAGE_RANK: Record<RpStage, number> = {
  list: 0,     // 剧情模式的落地层 = Home 压的那条条目
  intro: 1,
  tags: 1,
  custom: 1,
  detail: 1,
  wenyou: 1,
  werewolf: 1,
  chat: 2,     // 对局永远比设定页深一层
};

export type RpBackDecision =
  /** 先关这一层弹层（页面层级不动） */
  | { kind: 'closeOverlay'; overlay: RpOverlay }
  /** 对局 → 剧本设定页：必须走 `leaveChat()`（它还要记「落幕余音」桥的账），不能只 setStage */
  | { kind: 'leaveChat' }
  /** 任一子页 → 剧本列表 */
  | { kind: 'goList' }
  /** 交给更深的返回处理器（AI 文游子树：它自己先把内部层级退完，再退回列表） */
  | { kind: 'delegate' }
  /** 列表层：不消费，交回 Home 关掉剧情模式 = 回小愈主界面 */
  | { kind: 'exit' };

/** 当前最上面的弹层（没开弹层时 null） */
export function topOverlay(open: readonly RpOverlay[]): RpOverlay | null {
  for (const k of RP_OVERLAY_ORDER) {
    if (open.indexOf(k) !== -1) return k;
  }
  return null;
}

/**
 * 决定「这次返回」该做什么。**纯函数**：不读 DOM、不碰历史栈，由调用方去落地。
 * @param stage 当前层级
 * @param open 当前开着的弹层（顺序无所谓，内部按 RP_OVERLAY_ORDER 取最上面那个）
 */
export function resolveRpBack(stage: RpStage, open: readonly RpOverlay[] = []): RpBackDecision {
  // ① 弹层优先：最上面那层弹层就是「当前最深的一层」（用户口径 Q2-A）
  const overlay = topOverlay(open);
  if (overlay) return { kind: 'closeOverlay', overlay };
  // ② 再按层级回退一层
  if (stage === 'chat') return { kind: 'leaveChat' };
  if (stage === 'wenyou') return { kind: 'delegate' };
  if (stage === 'list') return { kind: 'exit' };
  return { kind: 'goList' };
}
