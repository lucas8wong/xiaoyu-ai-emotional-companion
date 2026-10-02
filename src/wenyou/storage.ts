import type { AIConfig } from './ai/types'
import { keyOptional } from './ai/presets'
import type { GameState, TurnResult } from './engine/types'
import { turnResultSchema } from './ai/turn'
import { scenarioSchema, type Scenario } from './scenarios/schema'
import { builtinScenarios } from './scenarios'
import { getWenyouScenarios, saveWenyouScenarios, isLoggedIn, getWenyouProgress, saveWenyouProgress, type WenyouProgressPayload } from '../services/api'

// 内置剧本的存档快照可能是旧版本（无 bands/directive 等）；加载时用当前定义刷新，
// 让已存的内置剧本游戏立刻享受到引擎/内容更新。属性 key 不变，结算不受影响。
// maxTurns 从存档保留、不取基准：早期版本曾让玩家在开局选「人生长度」并把非基准值写进存档，
// 保留它可避免这类旧存档续玩时寿命被悄悄还原成基准值。
//（当前 Setup 已不提供长度选择，新存档此值即基准，保留为无害的向后兼容兜底。）
function refreshBuiltin(sc: Scenario): Scenario {
  const base = builtinScenarios.find((b) => b.id === sc.id)
  if (!base) return sc
  return typeof sc.maxTurns === 'number' ? { ...base, maxTurns: sc.maxTurns } : base
}

const CONFIG_KEY = 'tl.config'
// 旧版「单条当前存档」。仅在读取时用于把旧存档迁移进 tl.games，之后不再写入。
const LEGACY_SAVE_KEY = 'tl.save'
const GAMES_KEY = 'tl.games'
const CUSTOM_KEY = 'tl.customScenarios'
const SLOTS_KEY = 'tl.slots'
const ENDINGS_KEY = 'tl.endings'
const STATS_KEY = 'tl.stats'

export const SAVE_VERSION = 2

export interface SaveGame {
  v?: number
  scenario: Scenario
  state: GameState
  pendingTurn: TurnResult | null
  // 玩家已提交、等待 AI 结算的自定义行动（结算后清空）
  pendingAction?: string
}

// 回看点（原「命名存档位」）：
//  - 自动回看：kind = 'key'（命运抉择节点）/ 'end'（结局前）/ 'auto'（载入前对当前进行中的自动封存）
//  - 旧版手动存档：无 kind（用户命名，原样保留，永不被自动淘汰）
// 展示文案按 kind + 回合数在界面本地化生成，name 仅手动存档使用。
export type SlotKind = 'key' | 'end' | 'auto'

export interface SaveSlot {
  id: string
  name: string
  savedAt: number
  game: SaveGame
  kind?: SlotKind
}

// 自动回看的上限：单剧本最多保留 MAX_AUTO_PER_SCENARIO 个，全剧本合计不超过服务端 slots 上限（50）。
// 只淘汰自动项，旧手动存档位永不因自动回看被挤掉。
export const MAX_AUTO_PER_SCENARIO = 6
export const MAX_SLOTS_TOTAL = 50

// 校验并规整一个 SaveGame：剧本过 schema、history 为数组、损坏的 pendingTurn 丢弃、内置剧本刷新到最新。
// 不合法返回 null。导入/读取/存档位共用同一套校验。
export function validateSaveGame(data: unknown): SaveGame | null {
  try {
    const d = data as SaveGame
    if (!d || typeof d !== 'object') return null
    if (d.v !== SAVE_VERSION) return null
    scenarioSchema.parse(d.scenario)
    if (!d.state || typeof d.state !== 'object' || !Array.isArray(d.state.history)) return null
    // attributes 必须是普通对象（非 null / 数组），否则 Play 里 state.attributes[key] 在 null 上属性访问会抛错崩溃(白屏)。
    // 注：此处不校验键是否齐全或值为数字（缺键 / 非数值只会渲染成 NaN，不会崩溃）
    const attrs = d.state.attributes
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null
    const scenario = refreshBuiltin(d.scenario)
    const pendingTurn =
      d.pendingTurn != null && !turnResultSchema.safeParse(d.pendingTurn).success
        ? null
        : (d.pendingTurn ?? null)
    return { ...d, scenario, pendingTurn }
  } catch {
    return null
  }
}

// AI 配置按服务商预设分别存储：每个预设各记自己的 key/baseURL/model（key 跟服务商走，
// 切换服务商不会串用别家的 key），activePresetId 标记当前在用的一个。
interface AIConfigStore {
  activePresetId?: string
  presets: Record<string, AIConfig>
}

// 读并规整配置存储：兼容旧的「单个扁平 AIConfig」格式（迁移为单预设 map）。
function readAIConfigStore(): AIConfigStore {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return { presets: {} }
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return { presets: {} }
    // 新格式：{ activePresetId, presets }
    if (obj.presets && typeof obj.presets === 'object' && !Array.isArray(obj.presets)) {
      return {
        activePresetId: typeof obj.activePresetId === 'string' ? obj.activePresetId : undefined,
        presets: obj.presets as Record<string, AIConfig>,
      }
    }
    // 旧格式：扁平 AIConfig，以其 presetId/provider 为键迁移为单预设 map
    if (typeof obj.provider === 'string') {
      const c = obj as unknown as AIConfig
      const id = c.presetId || c.provider
      return { activePresetId: id, presets: { [id]: c } }
    }
    return { presets: {} }
  } catch {
    return { presets: {} }
  }
}

/**
 * 一份配置算不算「配好了」，落盘与读取共用同一条判据，两处分开写必然漂。
 *
 * ⚠ key 不是人人都要：自建网关与局域网里的本地推理（LM Studio / Ollama /
 * llama.cpp / LiteLLM）没有 key 这个概念，它们的【地址】才是凭据。判据取自目录
 * 的 keyOptional，不在这里按 id 列名单。
 *
 * 漏掉这条的后果是静默的：界面允许不填 key 就开局，配置却一次都存不下来
 * saveConfig 走 else 分支把它删掉，刷新后归零，而全程没有任何报错。
 */
export function isComplete(c: AIConfig | undefined): c is AIConfig {
  if (!c || !c.provider || !c.model) return false
  return Boolean(c.apiKey) || (keyOptional(c.presetId) && Boolean(c.baseURL))
}

// 当前活跃服务商的完整配置；未配置完整返回 null。
export function loadConfig(): AIConfig | null {
  const store = readAIConfigStore()
  const c = store.activePresetId ? store.presets[store.activePresetId] : undefined
  return isComplete(c) ? c : null
}

// 取某服务商预设已存的配置（切换服务商时恢复其专属 key/baseURL/model）；未配置过返回 undefined。
export function loadPresetConfig(presetId: string): AIConfig | undefined {
  return readAIConfigStore().presets[presetId]
}

// 保存某服务商配置并置为当前活跃（配置一经修改即调用，不必等到开局）。按 presetId（无则 provider）归档。
// 仅落盘「完整可用」的配置（判据见 isComplete）：空 / 仅默认的不存，并清掉该服务商
// 可能残留的空条目、不改动当前活跃项，避免只是切过去看一眼就留下噪声条目。
export function saveConfig(c: AIConfig): void {
  const store = readAIConfigStore()
  const id = c.presetId || c.provider
  if (isComplete(c)) {
    store.presets[id] = c
    store.activePresetId = id
  } else {
    delete store.presets[id]
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(store))
  } catch {
    // 配额满等写入失败不打断配置流程（内存态 UI 仍可用）
  }
}

// ── 进行中局（多剧本并行：每个剧本一套每回合自动保存的进度）──
// 以 scenario.id 为 key 存在 tl.games；旧版单一 tl.save 首次读取时迁移进来。
// 与 tl.slots（自动回看 + 旧手动存档）是两套独立概念：这里是活局自动保存，那里是可选「回看」点。

/** 纯读取 tl.games 并校验（不做迁移） */
function readGamesRaw(): Record<string, SaveGame> {
  try {
    const obj = JSON.parse(localStorage.getItem(GAMES_KEY) ?? '{}') as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: Record<string, SaveGame> = {}
    for (const [id, val] of Object.entries(obj)) {
      const g = validateSaveGame(val)
      if (g) out[id] = g
    }
    return out
  } catch {
    return {}
  }
}

/** 读取并校验 tl.games；首次会顺带把旧版 tl.save 迁移进来（仅一次，迁移后清掉旧 key）。 */
function readInProgressMap(): Record<string, SaveGame> {
  try {
    const raw = localStorage.getItem(LEGACY_SAVE_KEY)
    if (raw) {
      const legacy = validateSaveGame(JSON.parse(raw))
      if (legacy) {
        const map = readGamesRaw()
        if (!map[legacy.scenario.id]) map[legacy.scenario.id] = legacy
        writeInProgressMap(map)
      }
      localStorage.removeItem(LEGACY_SAVE_KEY)
    }
  } catch { /* 旧 key 损坏/不可解析：不动新 key，也无需报错 */ }
  return readGamesRaw()
}

function writeInProgressMap(map: Record<string, SaveGame>): void {
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify(map))
  } catch (e) {
    // 配额满等存储失败不应打断游戏：内存态仍在，只是刷新后无法恢复
    console.warn('进行中进度写入失败', e)
  }
}

/** 所有进行中的局（过滤已结束），按插入顺序返回 */
export function listInProgress(): SaveGame[] {
  return Object.values(readInProgressMap()).filter((g) => !g.state.ended)
}

/** 取某剧本的进行中局；无则 null */
export function getInProgress(scenarioId: string): SaveGame | null {
  return readInProgressMap()[scenarioId] ?? null
}

/** 保存/更新某剧本的进行中局（每回合自动保存）；结束的局仍写入，由调用方随后 removeInProgress 清除 */
export function upsertInProgress(game: SaveGame): void {
  const map = readInProgressMap()
  map[game.scenario.id] = { ...game, v: SAVE_VERSION }
  writeInProgressMap(map)
  void pushProgress()
}

/** 移除某剧本的进行中局（结束/放弃该局时调用），只影响该剧本，其它剧本不动 */
export function removeInProgress(scenarioId: string): void {
  const map = readInProgressMap()
  delete map[scenarioId]
  writeInProgressMap(map)
  void pushProgress()
}

// 兼容旧 API：返回「最近一条」进行中局（历史调用点可持续使用；新代码请用 listInProgress/getInProgress）。
export function loadSave(): SaveGame | null {
  const list = listInProgress()
  return list.length > 0 ? list[list.length - 1] : null
}

export function saveSave(s: SaveGame): void {
  upsertInProgress(s)
}

export function clearSave(): void {
  writeInProgressMap({})
  void pushProgress()
}

export function loadCustomScenarios(): Scenario[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown[]
    return list.flatMap((s) => {
      try {
        return [scenarioSchema.parse(s)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function addCustomScenario(sc: Scenario): void {
  // 在原始列表上替换/追加，不经 loadCustomScenarios 回写：
  // 未通过当前校验的旧剧本只是不展示，其数据不应被覆写抹除
  let raw: unknown[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as unknown
    if (Array.isArray(parsed)) raw = parsed
  } catch {
    // 整个列表损坏到无法解析时才放弃旧数据
  }
  const rest = raw.filter(
    (s) => !(typeof s === 'object' && s !== null && (s as { id?: unknown }).id === sc.id),
  )
  localStorage.setItem(CUSTOM_KEY, JSON.stringify([...rest, sc]))
}

/** 整表写回本地（同步/合并用） */
export function saveCustomScenarios(list: Scenario[]): void {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)) } catch { /* 忽略 */ }
}

/** 合并本地与服务端剧本：同 id 本地优先，服务端独有并入 */
export function mergeCustomScenarios(local: Scenario[], server: Scenario[]): Scenario[] {
  const byId = new Map<string, Scenario>()
  for (const s of server) byId.set(s.id, s)
  for (const s of local) byId.set(s.id, s)
  return [...byId.values()]
}

/** 登录用户：拉服务端 → 与本地合并 → 写回本地并上传（两端收敛）；游客/失败时返回本地 */
export async function syncCustomScenarios(): Promise<Scenario[]> {
  try {
    if (!isLoggedIn()) return loadCustomScenarios()
    const r = await getWenyouScenarios()
    if (!r.success) return loadCustomScenarios()
    const server: Scenario[] = []
    for (const s of (r.data?.scenarios ?? []) as unknown[]) {
      try { server.push(scenarioSchema.parse(s)) } catch { /* 忽略坏数据 */ }
    }
    const merged = mergeCustomScenarios(loadCustomScenarios(), server)
    saveCustomScenarios(merged)
    try { await saveWenyouScenarios(merged) } catch { /* 网络失败忽略，本地仍有 */ }
    return merged
  } catch {
    return loadCustomScenarios()
  }
}

/** 登录用户：整表上传（新增/导入剧本后调用）；游客/失败时静默 */
export async function pushCustomScenarios(): Promise<void> {
  try {
    if (!isLoggedIn()) return
    await saveWenyouScenarios(loadCustomScenarios())
  } catch { /* 网络失败忽略（本地仍有） */ }
}

// ── 进度跨设备同步（当前存档 / 命名存档位 / 结局图鉴 / 全局统计）──

export interface WenyouProgress {
  games: Record<string, SaveGame> // scenarioId → 进行中局（每回合自动保存）
  slots: SaveSlot[]
  endings: Record<string, string[]>
  stats: RunStats
}

function readLocalProgress(): WenyouProgress {
  return { games: readInProgressMap(), slots: listSlots(), endings: readEndingLog(), stats: loadStats() }
}

function writeLocalProgress(p: WenyouProgress): void {
  writeInProgressMap(p.games)
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(p.slots)) } catch { /* 忽略 */ }
  try { localStorage.setItem(ENDINGS_KEY, JSON.stringify(p.endings)) } catch { /* 忽略 */ }
  try { localStorage.setItem(STATS_KEY, JSON.stringify(p.stats)) } catch { /* 忽略 */ }
}

function unionStrings(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])] }

/** 统计合并：单调成就用 max/OR/并集（runs 取 max 避免跨设备翻倍） */
function mergeStats(a: RunStats, b: RunStats): RunStats {
  return {
    runs: Math.max(a.runs, b.runs),
    ratings: unionStrings(a.ratings, b.ratings),
    anyLocal: a.anyLocal || b.anyLocal,
    anyAi: a.anyAi || b.anyAi,
    deaths: Math.max(a.deaths, b.deaths),
    sRanks: Math.max(a.sRanks, b.sRanks),
    maxTurns: Math.max(a.maxTurns, b.maxTurns),
    maxGoal: Math.max(a.maxGoal, b.maxGoal),
    customCleared: a.customCleared || b.customCleared,
    aliveClear: a.aliveClear || b.aliveClear,
    sRankScenarios: unionStrings(a.sRankScenarios, b.sRankScenarios),
  }
}

function mergeSlots(local: SaveSlot[], server: SaveSlot[]): SaveSlot[] {
  const map = new Map<string, SaveSlot>()
  for (const s of server) map.set(s.id, s)
  for (const s of local) map.set(s.id, s) // 本地优先（同 id 以本地为准）
  return [...map.values()].sort((a, b) => b.savedAt - a.savedAt)
}

function mergeEndings(l: Record<string, string[]>, s: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const k of new Set([...Object.keys(l), ...Object.keys(s)])) out[k] = unionStrings(l[k] ?? [], s[k] ?? [])
  return out
}

/** kind 合法性过滤（旧手动存档无 kind；未知值按手动存档处理） */
function slotKind(o: { kind?: unknown }): SlotKind | undefined {
  return o.kind === 'key' || o.kind === 'end' || o.kind === 'auto' ? o.kind : undefined
}

function parseSlots(list: unknown): SaveSlot[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((s) => {
    const o = s as Partial<SaveSlot>
    const game = o?.game ? validateSaveGame(o.game) : null
    if (!game || typeof o.id !== 'string') return []
    return [{ id: o.id, name: o.name || '未命名', savedAt: o.savedAt || 0, game, kind: slotKind(o) }]
  })
}

/** 服务端 games 映射 → 本地进行中局（校验并丢弃已结束的局） */
function parseGames(list: unknown): Record<string, SaveGame> {
  const out: Record<string, SaveGame> = {}
  if (!list || typeof list !== 'object' || Array.isArray(list)) return out
  for (const [id, val] of Object.entries(list as Record<string, unknown>)) {
    const g = validateSaveGame(val)
    if (g && !g.state.ended) out[id] = g
  }
  return out
}

/** 合并本地与服务端进行中局：同 scenario 本地优先，服务端独有并入；两端已结束的局均丢弃 */
function mergeGames(
  local: Record<string, SaveGame>,
  server: Record<string, SaveGame>,
): Record<string, SaveGame> {
  const out: Record<string, SaveGame> = {}
  for (const id of new Set([...Object.keys(local), ...Object.keys(server)])) {
    const g = local[id] ?? server[id]
    if (g && !g.state.ended) out[id] = g
  }
  return out
}

/** 登录用户：拉服务端 → 与本地合并 → 写回本地并上传（两端收敛）；游客/失败保持本地 */
export async function loadServerProgress(): Promise<void> {
  try {
    if (!isLoggedIn()) return
    const r = await getWenyouProgress()
    if (!r.success) return
    const local = readLocalProgress()
    const server = (r.data ?? {}) as WenyouProgressPayload
    const merged: WenyouProgress = {
      // 进行中局：本机有则保留（本设备正在玩），否则用服务端（换设备续玩）；同剧本本地优先
      games: mergeGames(local.games, parseGames(server.games)),
      slots: mergeSlots(local.slots, parseSlots(server.slots)),
      endings: mergeEndings(local.endings, server.endings ?? {}),
      stats: mergeStats(local.stats, (server.stats as RunStats) ?? local.stats),
    }
    writeLocalProgress(merged)
    await pushProgress()
  } catch { /* 忽略 */ }
}

/** 登录用户：把当前本地进度整表上传（每次存档变动后调用）；游客/失败静默 */
export async function pushProgress(): Promise<void> {
  try {
    if (!isLoggedIn()) return
    const p = readLocalProgress()
    await saveWenyouProgress({ games: p.games, slots: p.slots, endings: p.endings, stats: p.stats })
  } catch { /* 忽略 */ }
}

// ── 回看点（自动回看 + 旧手动存档） ──

export function listSlots(): SaveSlot[] {
  try {
    const raw = localStorage.getItem(SLOTS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown[]
    if (!Array.isArray(list)) return []
    return list
      .flatMap((s) => {
        const o = s as Partial<SaveSlot>
        const game = validateSaveGame(o?.game)
        if (!game || typeof o.id !== 'string') return []
        return [{ id: o.id, name: o.name || '未命名', savedAt: o.savedAt || 0, game, kind: slotKind(o) }]
      })
      .sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

// 原始列表读取：写回时不经校验，避免把当前校验不过的旧存档位抹除
function rawSlots(): unknown[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SLOTS_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 自动回看的容量控制（纯函数，便于单测）：
 * 1) 同一剧本的自动回看超过 perScenarioMax 时，只保留最新若干条；
 * 2) 全部条目（含旧手动存档）超过 totalMax 时，继续淘汰最旧的自动回看
 *    旧手动存档永不因自动回看而被挤掉。输入乱序也安全，返回按 savedAt 降序。
 */
export function evictAutoSlots(
  slots: SaveSlot[],
  perScenarioMax: number = MAX_AUTO_PER_SCENARIO,
  totalMax: number = MAX_SLOTS_TOTAL,
): SaveSlot[] {
  const manual = slots.filter((s) => !s.kind)
  const autos = slots.filter((s) => !!s.kind).sort((a, b) => b.savedAt - a.savedAt)
  const byScenario = new Map<string, SaveSlot[]>()
  for (const a of autos) {
    const group = byScenario.get(a.game.scenario.id)
    if (group) group.push(a)
    else byScenario.set(a.game.scenario.id, [a])
  }
  let kept: SaveSlot[] = []
  for (const group of byScenario.values()) {
    // group 已按 savedAt 降序：每组只保留最新的 perScenarioMax 条
    kept = kept.concat(group.slice(0, perScenarioMax))
  }
  kept.sort((a, b) => b.savedAt - a.savedAt)
  while (manual.length + kept.length > totalMax && kept.length > 0) {
    kept.pop() // 已降序，尾部即最旧自动回看
  }
  return [...kept, ...manual].sort((a, b) => b.savedAt - a.savedAt)
}

/** 同一抉择点的判重：同剧本 + 同历史步数 + 同叙事即视为同一个点（AI 分叉产生的新叙事不算重复） */
function sameAutoPoint(a: SaveSlot, game: SaveGame): boolean {
  return (
    !!a.kind &&
    a.game.scenario.id === game.scenario.id &&
    a.game.state.history.length === game.state.history.length &&
    (a.game.pendingTurn?.narrative ?? '') === (game.pendingTurn?.narrative ?? '')
  )
}

/**
 * 自动封存一个回看点（命运抉择 'key' / 结局前 'end' / 载入前的进行中局 'auto'）。
 * 同抉择点已存在则跳过（不重复）；写入失败返回 false（不静默假报）。全自动，无需用户操作。
 */
export function saveAutoPoint(
  game: SaveGame,
  kind: SlotKind,
  now: number = Date.now(),
): boolean {
  const list = listSlots()
  const dup = list.find((s) => sameAutoPoint(s, game))
  if (dup) {
    // 该抉择点恰好也是「结局前」：把已存的命运抉择点升级为结局前标记（不新增重复条目），
    // 界面会显示为「结局前」，让玩家知道这里可以回头重选另一条结局线。
    if (dup.kind === 'key' && kind === 'end') {
      dup.kind = 'end'
      try {
        localStorage.setItem(SLOTS_KEY, JSON.stringify(evictAutoSlots(list)))
      } catch (e) {
        console.warn('自动回看写入失败', e)
        return false
      }
      void pushProgress()
    }
    return true
  }
  const slot: SaveSlot = {
    id: `auto_${now}_${Math.random().toString(36).slice(2, 9)}`,
    name: '', // 自动回看的展示名由 kind + 回合数在界面生成，不落用户命名
    savedAt: now,
    game: { ...game, v: SAVE_VERSION },
    kind,
  }
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(evictAutoSlots([...list, slot])))
  } catch (e) {
    console.warn('自动回看写入失败', e)
    return false
  }
  void pushProgress()
  return true
}

export function deleteSlot(id: string): void {
  const rest = rawSlots().filter(
    (s) => !(typeof s === 'object' && s !== null && (s as { id?: unknown }).id === id),
  )
  localStorage.setItem(SLOTS_KEY, JSON.stringify(rest))
  void pushProgress()
}

/** 删除某剧本在命书阁的全部回看点（旧手动存档 + 自动回看一并清）；结局图鉴/成就/统计不受影响 */
export function deleteSlotsByScenario(scenarioId: string): void {
  const rest = rawSlots().filter((s) => {
    const o = s as { game?: { scenario?: { id?: unknown } } }
    return !(o?.game?.scenario?.id === scenarioId)
  })
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(rest))
  } catch { /* 忽略 */ }
  void pushProgress()
}

// ── 结局图鉴：记录每个剧本见过的结局基调 ──

type EndingLog = Record<string, string[]>

function readEndingLog(): EndingLog {
  try {
    const raw = localStorage.getItem(ENDINGS_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as EndingLog
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

export function recordEnding(
  scenarioId: string,
  tone: string,
  meta?: {
    rating?: string
    local?: boolean
    isDeath?: boolean
    turns?: number
    goal?: number
    custom?: boolean
  },
): void {
  const t = tone.trim()
  if (!scenarioId || !t) return
  const log = readEndingLog()
  const seen = Array.isArray(log[scenarioId]) ? log[scenarioId] : []
  if (!seen.includes(t)) {
    log[scenarioId] = [...seen, t]
    try {
      localStorage.setItem(ENDINGS_KEY, JSON.stringify(log))
    } catch {
      // 配额满等写入失败不应抛出：此函数在 Ending 的 useEffect 内被裸调用，
      // 抛出会中断后续全局统计累积，并让结局界面的 effect 报错
    }
  }
  // 累积全局统计（成就用）：每次收束都计一局，评级去重，本地/AI 通关与死亡置位
  const s = loadStats()
  s.runs += 1
  if (meta?.rating && !s.ratings.includes(meta.rating)) s.ratings.push(meta.rating)
  if (meta?.rating === 'S') {
    s.sRanks += 1
    if (!s.sRankScenarios.includes(scenarioId)) s.sRankScenarios.push(scenarioId)
  }
  if (meta?.local) s.anyLocal = true
  else s.anyAi = true
  if (meta?.isDeath) s.deaths += 1
  else s.aliveClear = true
  if (typeof meta?.turns === 'number') s.maxTurns = Math.max(s.maxTurns, meta.turns)
  if (typeof meta?.goal === 'number') s.maxGoal = Math.max(s.maxGoal, meta.goal)
  if (meta?.custom) s.customCleared = true
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s))
  } catch {
    // 忽略写入失败（配额满等）
  }
  void pushProgress()
}

export function seenEndings(scenarioId: string): string[] {
  const log = readEndingLog()
  return Array.isArray(log[scenarioId]) ? log[scenarioId] : []
}

export interface RunStats {
  runs: number
  ratings: string[]
  anyLocal: boolean
  anyAi: boolean
  deaths: number
  // 扩充统计（成就用）：S 级次数、单局最长寿命、最高目标完成度、是否通关过自创/导入剧本、是否有过不死通关
  sRanks: number
  maxTurns: number
  maxGoal: number
  customCleared: boolean
  aliveClear: boolean
  // 取得过 S 级评价的不同剧本 id（跨题材精通成就用）
  sRankScenarios: string[]
}

export function loadStats(): RunStats {
  try {
    const o = JSON.parse(localStorage.getItem(STATS_KEY) ?? '') as Partial<RunStats>
    return {
      runs: typeof o.runs === 'number' ? o.runs : 0,
      ratings: Array.isArray(o.ratings) ? o.ratings.filter((r) => typeof r === 'string') : [],
      anyLocal: o.anyLocal === true,
      anyAi: o.anyAi === true,
      deaths: typeof o.deaths === 'number' ? o.deaths : 0,
      sRanks: typeof o.sRanks === 'number' ? o.sRanks : 0,
      maxTurns: typeof o.maxTurns === 'number' ? o.maxTurns : 0,
      maxGoal: typeof o.maxGoal === 'number' ? o.maxGoal : 0,
      customCleared: o.customCleared === true,
      aliveClear: o.aliveClear === true,
      sRankScenarios: Array.isArray(o.sRankScenarios)
        ? o.sRankScenarios.filter((x) => typeof x === 'string')
        : [],
    }
  } catch {
    return emptyStats()
  }
}

function emptyStats(): RunStats {
  return {
    runs: 0, ratings: [], anyLocal: false, anyAi: false, deaths: 0,
    sRanks: 0, maxTurns: 0, maxGoal: 0, customCleared: false, aliveClear: false,
    sRankScenarios: [],
  }
}
