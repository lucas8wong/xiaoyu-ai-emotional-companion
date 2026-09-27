export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Outcome {
  weight?: number
  effects?: Record<string, number>
  reaction?: string
  narrative?: string
  flagsSet?: string[]
  flagsClear?: string[]
  itemsGained?: string[]
  itemsLost?: string[]
  // 命中即强制结局，无视数值
  endTone?: string
}

export interface Choice {
  text: string
  effects: Record<string, number>
  // 选择后他人的即时反馈（本地事件可选）
  reaction?: string
  // 加权分支：存在则引擎掷骰取一（跳过命运无常），否则走 effects
  outcomes?: Outcome[]
  flagsSet?: string[]
  flagsClear?: string[]
  endTone?: string
}

export interface TurnResult {
  narrative: string
  choices: Choice[]
  summary: string
  // 本回合获得/失去的物品（AI 生成，可选）
  itemsGained?: string[]
  itemsLost?: string[]
  // 玩家自定义行动的属性结算（仅自定义行动的解析回合返回）
  actionEffects?: Record<string, number>
  // AI 托管推荐选项下标（该角色最可能的选择）
  recommend?: number
  // 本回合产生的、需长期记住的关键事实（结识的人物、立下的誓、背叛、世界设定等），注入后续每回合保持长篇一致
  memoryAdd?: string[]
  // AI 对「玩家离既定目标有多近」的估计（0~100）；仅在玩家设了目标时返回
  goalProgress?: number
  // 本回合首次登场（或需补充设定）的具名人物 —— 由 state.applyCast 并入 GameState.cast
  cast?: CastDraft[]
}

/** AI 在本回合登记的人物条目（`cast` 数组元素）：都是「预设身份」，一经登记只增不改 */
export interface CastDraft {
  /** 人名：必须与正文里的写法完全一致（正文内联可点依赖它做匹配） */
  name: string
  /** 身份（如「青云门师姐」「七十六号小头目」） */
  role: string
  /** 与主角的关系（如「亦师亦友」「暗中窥伺」） */
  relation?: string
  /** 一句话背景（出身/来历/处境） */
  brief?: string
}

/** 已入册的人物：AI 登记的内容 + 引擎补的「首次登场」坐标 */
export interface CastMember extends CastDraft {
  /** 首次登场回合（1 基）；后续同名条目只补空字段、不改它 */
  firstTurn: number
  /** 首次登场那回合的事件摘要（让玩家想起「就是那回遇上的」） */
  firstSummary?: string
}

export interface TurnRecord {
  narrative: string
  choiceText: string
  summary: string
  // 该回合所选行动引发的他人即时反馈（本地事件可选）
  reaction?: string
  // 「命运无常」偶发转折：同一选择有时结果好于/坏于预期（仅本地模式触发）
  twist?: string
}

export interface Ending {
  tone: string
  reason: string
}

export interface GameState {
  scenarioId: string
  attributes: Record<string, number>
  history: TurnRecord[]
  inventory: string[]
  opening?: string
  // 玩家设定的野心/目标，贯穿全程注入剧情走向
  ambition?: string
  // 'local' = 无需 AI 的本地事件模式；缺省视为 'ai'（向后兼容旧存档）
  mode?: 'ai' | 'local'
  // 记忆栏：贯穿全程的关键事实（AI 模式由模型逐回合补充），注入每回合提示以维持长篇一致
  memory?: string[]
  // 人物志：本局登场过的具名人物（含预设身份），点击正文人名即可查看；AI 登记 + 引擎补首次登场坐标
  cast?: CastMember[]
  // 目标进度（0~100）：AI 模式下由模型逐回合评估玩家离 ambition 有多近，供 UI 展示
  goalProgress?: number
  // 印记：隐藏的具名状态（身份/机缘/因果种子），门控事件、结局、属性封顶
  flags?: string[]
  // 本局首个极端命运瞬间（windfall/disaster）——一旦发生即定格、不被后续极端事件覆盖，供命运卡分享引用
  fateHighlight?: { text: string; kind: 'windfall' | 'disaster'; turn: number }
  ended?: Ending
}
