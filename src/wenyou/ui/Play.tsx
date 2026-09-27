import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyChoice, resolveCustomAction, effectiveCeiling, applyCast } from '../engine/state'
import { bandOf } from '../engine/bands'
import { isKeyMoment } from '../engine/keymoment'
import { friendlyError, isAbortError } from '../ai/client'
import { localSource, aiSource } from '../ai/turnSource'
import { getQuota, quotaChatRemain, quotaIsUnlimited } from '../../services/api'
import { useAppStore } from '../../store/useAppStore'
import type { AIConfig } from '../ai/types'
import { saveAutoPoint, type SaveGame } from '../storage'
import { msg } from './messages'
import { isEn, wyT } from '../i18n'
import { t as appT } from '../../i18n'
import { nodeImage, themeImageUrls } from './nodeArt'
import { covers } from './covers'
import { ShareCardModal } from './ShareCardModal'
import { FontScaleControl } from './FontScaleControl'
import { Memoir } from './Memoir'
import { CastCard } from './CastCard'
import { CastPanel } from './CastPanel'
import { splitByCast } from './castHighlight'
import { Lightbox } from './Lightbox'
import { Typewriter } from './Typewriter'
import { goalStage } from './goalStage'
import { useVisualViewport } from '../../hooks/useVisualViewport'
import { useIosKeyboardLock } from '../../hooks/useIosKeyboardLock'

// 自定义行动字数上限：防止超长输入撑爆 AI 上下文 / 浪费 token
const CUSTOM_ACTION_MAX = 200

// AI 托管「单次连续回合」软上限：默认连续托管满 N 回合后暂停（需确认再续）；「挂机到底」模式跳过此限制
const AUTO_CONTINUOUS_LIMIT = 15

// 贴底判定：距滚动容器底部 <40px 视为贴底（用于流式剧情智能跟随；越小则「上翻阅读时」的漂移越少）
const nearBottom = (el: HTMLDivElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 40

// iPhone Safari 不实现元素全屏（只有 <video> 有 webkitEnterFullscreen），那里干脆不挂这个
// 开关，免得点了没反应；iPhone 走「添加到主屏幕」即可（manifest 已是 display: standalone）
const CAN_FULLSCREEN = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen

export function Play({
  session,
  onUpdate,
  onQuit,
}: {
  session: SaveGame
  onUpdate: (s: SaveGame) => void
  onQuit: () => void
}) {
  const { scenario, state, pendingTurn, pendingAction } = session
  // 真机 iOS 键盘：对局页是「全屏 + 底部自定义行动输入」——聚焦会被键盘盖住，需锁滚动并随可视视口收缩。
  const { height: vvHeight } = useVisualViewport()
  useIosKeyboardLock(true)
  // 回合来源：本地事件池或 AI 在线生成。Play 只依赖来源的能力声明（流式 / 自由行动 / 随机），
  // 不再到处判断 mode === 'local'。换一种来源只需实现新的 TurnSource。
  const source = useMemo(
    () =>
      state.mode === 'local'
        ? localSource()
        : aiSource((): AIConfig => {
            // 小愈集成：AI 由后端驱动，无需玩家配置（保留 getConfig 签名以兼容 TurnSource 契约）
            return { provider: 'xiaoyu', apiKey: '', model: '', baseURL: '' }
          }),
    [state.mode],
  )
  const [loading, setLoading] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const [auto, setAuto] = useState(false)
  const [isPro, setIsPro] = useState(false) // 是否 Pro/Lifetime：决定能否真正开启「AI 托管」，显示与否已改为对所有用户展示
  const [showProUpsell, setShowProUpsell] = useState(false) // 非 Pro 点「交由 AI 托管」→ 弹 Pro 专属升级提示
  const [autoStreak, setAutoStreak] = useState(0) // 本次连续托管已自动落子的回合数
  const [autoToEnd, setAutoToEnd] = useState(false) // 「挂机到底」：跳过 15 回合软上限，跑到今日上限/结局
  const [showAutoContinue, setShowAutoContinue] = useState(false) // 连续托管满 15 回合 → 暂停并弹「继续/挂机到底」
  const [quota, setQuota] = useState<any>(null) // 额度信息（剩余聊天额度，文游回合共用聊天额度池）
  const autoRef = useRef(false)
  // 托管回合标记：供 runTurn 读取（仅 Pro/Lifetime 能开启，后端另做双重门控）
  useEffect(() => { autoRef.current = auto }, [auto])
  useEffect(() => {
    let m = true
    getQuota().then(r => { if (m && r.success && r.data) { setIsPro(r.data.plan === 'pro' || !!r.data.lifetime); setQuota(r.data) } })
    return () => { m = false }
  }, [])
  const [showMemoir, setShowMemoir] = useState(false)
  // 人物志：列出本局登场过的人；castFocus = 正在看哪个人的人物卡（正文点人名 / 人物志点人也走这里）
  const [castPanelOpen, setCastPanelOpen] = useState(false)
  const [castFocus, setCastFocus] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // 沉浸：地址栏 + 底部导航栏在手机上吃掉近 1/5 的屏，而对局页是定高布局（不滚动），
  // 那两条栏永远不会自动收起。做成显式开关而非自动进入——阅读类页面强行全屏会夺走
  // 返回/地址栏，读者点选项点得又频繁，误触代价太大。
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  // 看全图：轻触隐去卷文、看清整张场景画；再触恢复
  const [peek, setPeek] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  // 正文是否已落定：决定「画卷书页」节奏中选项何时淡入（打字机写完 / 流式收尾后才现）
  const [proseDone, setProseDone] = useState(false)
  const busyRef = useRef(false)
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 玩家退出后组件卸载，迟到的 AI 响应不能再写回 session，否则会复活已清除的存档
  const aliveRef = useRef(true)
  // 卸载时真正中断在途请求，停止消耗额度（而非仅丢弃响应）
  const abortRef = useRef<AbortController | null>(null)
  // 本回合正文是否已通过流式过程展示过：是则不再走打字机动画（仅存档恢复时用打字机）
  const streamedRef = useRef(false)
  // 已经「露过面」的那一回合正文：与 streamedRef 的区别是**不随结算复位**——
  // 玩家填完自定义行动确认发送后，pendingTurn 仍是那一幕场景，若此时重新挂打字机，
  // 上一幕故事会被从头再打一遍（观感＝故事被重新加载）。按对象身份比对，切换回合自然失效。
  const revealedTurnRef = useRef<unknown>(null)
  // 按 attributes 对象身份追踪上一回合的增减，浮标在整个回合内保持可见
  const attrTrack = useRef({ attrs: state.attributes, deltas: {} as Record<string, number> })
  const logRef = useRef<HTMLDivElement>(null)
  // 智能跟随：贴底（距底<80px）才自动滚到最新；上翻阅读时不打扰，仅亮「下方有新内容」按钮
  const [atBottom, setAtBottom] = useState(true)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
      // 复位 busy，使（StrictMode 的）重挂载或退出后重进能重新发起请求，不被上一次的在途标志卡死
      busyRef.current = false
    }
  }, [])

  if (attrTrack.current.attrs !== state.attributes) {
    const deltas: Record<string, number> = {}
    for (const a of scenario.attributes) {
      const d = state.attributes[a.key] - (attrTrack.current.attrs[a.key] ?? state.attributes[a.key])
      if (d !== 0) deltas[a.key] = d
    }
    attrTrack.current = { attrs: state.attributes, deltas }
  }
  const deltas = attrTrack.current.deltas
  // 数值只在落子之后揭晓：选项不明牌 effect（掷骰 / 命运无常 / 极端命运本就会改写它，
  // 明牌等于虚标），改由承接段落报出这一步真正引起的增减
  const deltaList = scenario.attributes
    .filter((a) => deltas[a.key])
    .map((a) => ({ key: a.key, name: a.name, v: deltas[a.key] }))
  const flags = state.flags ?? []

  // —— 人物志（AI 登记的具名人物）：正文内联可点 + 人物志面板，两条入口共用同一张人物卡 ——
  // 展示用名册 = 已入册的 + 本回合 pendingTurn 刚登记的：新名字必须在玩家还没落子时就能点，
  // 否则「突然出现的人名」要等玩家先选一个选项才能看身份（与需求不符）。
  // 落盘仍由引擎单点写入（applyChoice / resolveCustomAction），这里只是同一套合并规则（applyCast）的只读投影。
  const viewCast = useMemo(
    () => applyCast(state.cast, pendingTurn?.cast, state.history.length + 1, pendingTurn?.summary),
    [state.cast, state.history.length, pendingTurn],
  )
  const castNames = useMemo(() => viewCast.map((c) => c.name), [viewCast])
  const focusMember = castFocus ? viewCast.find((c) => c.name === castFocus) : undefined
  // 本回合正文是否已经露过面：流式已推 / 打字机已写完 / 之前已展示过且这一回合没换。
  // 用它决定「直接显示」还是「走打字机」——结算在途期间必须仍是 true，否则上一幕会被重打一遍。
  const proseRevealed =
    streamedRef.current || proseDone || (!!pendingTurn && revealedTurnRef.current === pendingTurn)
  // 把正文按人名切成片段：命中的渲染成可点人名（只认名册，避免把属性名/称谓误标）
  const renderNarrative = useCallback(
    (text: string) => {
      if (castNames.length === 0) return text
      return splitByCast(text, castNames).map((seg, i) =>
        seg.name ? (
          <button
            key={i}
            type="button"
            className="cast-name"
            title="看此人的预设身份"
            onClick={(e) => {
              e.stopPropagation()
              setCastFocus(seg.name!)
            }}
          >
            {seg.text}
          </button>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )
    },
    [castNames],
  )

  // 生成下一回合；resolving=自定义行动结算（此时 pendingTurn 仍是行动发生的场景）。
  // 两种来源都进入同一套在途/中断/落盘逻辑：
  //   · 流式（真 SSE）→ 显示「命运正在落笔…」+ 逐字正文，可中断
  //   · 非流式（小愈后端 / 本地）→ 至少给出加载态，避免点完选项后画面空白干等
  const runTurn = async () => {
    if (busyRef.current) return
    busyRef.current = true
    const ac = new AbortController()
    abortRef.current = ac
    const resolvingAction = pendingAction
    const scene = pendingTurn
    setLoading(true)
    setError('')
    if (source.streaming) setStreamText('')
    try {
      const turn = await source.generate({
        scenario,
        state,
        resolvingAction,
        sceneNarrative: scene?.narrative,
        auto: autoRef.current,
        onStream: source.streaming
          ? (v) => {
              if (aliveRef.current) setStreamText(v)
            }
          : undefined,
        signal: ac.signal,
      })
      // 仅当本请求仍是当前请求时才落盘（被中断/被新请求取代的旧请求不写入）
      if (abortRef.current !== ac) return
      // 流式来源已实时展示过正文 → 落盘后跳过打字机；非流式则让打字机动画呈现
      streamedRef.current = source.streaming
      // 记下「这段正文已经给玩家看过了」：回合结算/自定义行动在途期间，绝不能因为
      // streamedRef 被复位而重新挂一个打字机，把上一幕故事从头再打一遍（用户报的「重新加载一遍」）。
      if (source.streaming) revealedTurnRef.current = turn
      if (resolvingAction && scene) {
        const next = resolveCustomAction(scenario, state, scene, resolvingAction, turn)
        // 自定义行动导致收束：把行动发生那一刻（原回合与选项）封存为结局前回看点
        if (next.ended) void saveAutoPoint({ scenario, state, pendingTurn: scene }, 'end')
        onUpdate({ scenario, state: next, pendingTurn: turn, pendingAction: undefined })
      } else {
        onUpdate({ ...session, pendingTurn: turn })
      }
    } catch (e) {
      // 主动中断（退出/卸载）不是错误，不提示
      if (aliveRef.current && abortRef.current === ac && !isAbortError(e)) {
        const em = e instanceof Error ? e.message : String(e)
        // 「AI 托管」被门控（Pro 专属 / 每日上限）：关闭托管并展示后端提示
        if (em.includes('[AUTO]')) {
          setAuto(false)
          setAutoStreak(0)
          setAutoToEnd(false)
          setError(em.replace('[AUTO]', '').trim())
        } else {
          setError(friendlyError(e))
        }
      }
    } finally {
      // 只有"当前请求"管理共享标志，避免被取代的旧请求误清正在进行的新请求状态
      if (abortRef.current === ac) {
        busyRef.current = false
        if (aliveRef.current) {
          setLoading(false)
          if (source.streaming) setStreamText('')
        }
      }
    }
  }

  useEffect(() => {
    // 自定义行动结算（仅支持自由行动的来源会产生 pendingAction），或缺回合时，生成下一回合
    if (pendingAction || (!pendingTurn && !state.ended)) void runTurn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTurn, pendingAction, state.history.length])

  // 首幕呈现后预热本剧本整套主题图（延迟避开首屏带宽争抢）：
  // 本地引擎下一节点为运行时随机、无法按选项预测，但换幕大概率落在主题图，预热即命中缓存
  useEffect(() => {
    const t = setTimeout(() => {
      for (const u of themeImageUrls(scenario.id)) {
        const im = new Image()
        im.src = u
      }
    }, 2500)
    return () => clearTimeout(t)
  }, [scenario.id])

  // 滚动日志到底部；打字机/流式逐字增高时持续跟随。
  // 贴底才自动滚到最新；用户上翻阅读时绝不硬拽回底部，只亮「下方有新内容」按钮。
  const updateScrollState = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const nb = nearBottom(el)
    stickToBottomRef.current = nb
    setAtBottom(nb)
  }, [])
  // 每次正文增长都重新判定跟随状态，而不是只靠 onScroll 记录的旧状态：
  //  - 内容已经溢出且用户在看顶部（没往下滚）→ 明确不跟随（不漂移，只亮「下方有新内容」）
  //  - 贴底 → 跟随
  //  - 其余情况（已在中间阅读）保持原状，避免流式一增长就把人从中间拽走
  const scrollLogBottom = useCallback((smooth = false) => {
    const el = logRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const overflows = el.scrollHeight > el.clientHeight + 4
    const atBottomNow = dist < 40
    if (overflows && el.scrollTop < 40) {
      stickToBottomRef.current = false // 用户在看开头几句 → 不跳
    } else if (atBottomNow) {
      stickToBottomRef.current = true
    }
    if (stickToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      setAtBottom(true)
    } else {
      setAtBottom(false)
    }
  }, [])
  // 点「下方有新内容」：回到底部并重新贴底跟随
  const scrollToLatest = () => {
    const el = logRef.current
    stickToBottomRef.current = true
    setAtBottom(true)
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // 仅在正文增长（新回合 / 流式逐字 / 加载态切换）时跟随到底部；
  // 不加依赖会在开菜单、看全图、存档提示等无关重渲染时把已上滚回看的读者硬拽回底部
  useEffect(() => {
    scrollLogBottom(true)
  }, [streamText, pendingTurn, state.history.length, loading, error, proseDone, scrollLogBottom])

  // 新回合开始即收起选项；正文（流式/打字机）落定后再让它们淡入，营造「写完→你接话」的呼吸
  useEffect(() => {
    setProseDone(false)
  }, [pendingTurn])

  // AI 托管：本回合呈现后，隔一会自动替角色做选择（用 AI 推荐，否则随机），形成自动演进
  useEffect(() => {
    if (autoTimer.current) {
      clearTimeout(autoTimer.current)
      autoTimer.current = null
    }
    // 托管自动落子；任一浮层（留影/看图）打开时暂停，避免回合在玩家阅读时被悄然推进
    if (!auto || !pendingTurn || loading || pendingAction || state.ended || showMemoir || lightbox) return
    // 单次连续托管软上限：非「挂机到底」模式连续托管满 N 回合 → 暂停并提示（防挂机一整晚刷满今日额度）
    if (!autoToEnd && autoStreak >= AUTO_CONTINUOUS_LIMIT) {
      setAuto(false)
      setShowAutoContinue(true)
      return
    }
    const n = pendingTurn.choices.length
    const rec = pendingTurn.recommend
    const idx = typeof rec === 'number' && rec >= 0 && rec < n ? rec : Math.floor(Math.random() * n)
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null
      setAutoStreak((s) => s + 1)
      pick(idx)
    }, 2600)
    return () => {
      if (autoTimer.current) {
        clearTimeout(autoTimer.current)
        autoTimer.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, autoStreak, autoToEnd, pendingTurn, loading, pendingAction, state.ended, showMemoir, lightbox])

  // ✦命运抉择 回合到达即自动封存「回看」点：之后可从命书阁回到这个抉择时刻重选。
  // 同一抉择点不重复写入（storage 判重兜底）；结局若发生在非关键回合，由落子处的结局前封存补上。
  useEffect(() => {
    if (!pendingTurn || state.ended || loading || pendingAction) return
    const turnNo = state.history.length + 1
    if (!isKeyMoment(turnNo, scenario.maxTurns)) return
    void saveAutoPoint({ scenario, state, pendingTurn }, 'key')
    // 只在「新回合到达」时判定一次；同一点由 storage 判重兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTurn])

  const pick = (idx: number) => {
    if (!pendingTurn || loading || pendingAction) return
    streamedRef.current = false
    // 来源决定随机源:本地注入「命运无常」偶然性(同一选择可能走向不同);AI 由模型自带变数
    const next = applyChoice(scenario, state, pendingTurn, idx, source.choiceRng)
    // 结局前自动封存：这一步将收束人生，把抉择时刻（含全部选项）存为回看点，
    // 已在该关键回合封存过则自动跳过，不会重复。
    if (next.ended) void saveAutoPoint({ scenario, state, pendingTurn }, 'end')
    onUpdate({ scenario, state: next, pendingTurn: null })
  }

  // AI 托管软上限的三个动作：继续 15 回合 / 挂机到底 / 停止托管
  const continueAuto15 = () => {
    setShowAutoContinue(false)
    setAutoStreak(0)
    setAutoToEnd(false)
    setAuto(true)
  }
  const autoRunToEnd = () => {
    setShowAutoContinue(false)
    setAutoStreak(0)
    setAutoToEnd(true)
    setAuto(true)
  }
  const stopAuto = () => {
    setShowAutoContinue(false)
    setAuto(false)
    setAutoStreak(0)
    setAutoToEnd(false)
  }

  const submitCustom = () => {
    const act = customText.trim()
    if (!act || !pendingTurn || loading || pendingAction) return
    streamedRef.current = false
    setCustomOpen(false)
    setCustomText('')
    // 保留 pendingTurn 作为行动发生的场景，标记待结算（effect 会触发结算请求）
    onUpdate({ ...session, pendingAction: act })
  }

  const turnNo = state.history.length + 1
  const keyMoment = isKeyMoment(turnNo, scenario.maxTurns)
  // 命途长卷 VN：整屏场景画始终解析出一张图（专属→主题→封面），随当前节点流转作世界背景
  const sceneArt = nodeImage(scenario.id, pendingTurn?.summary)
  // 上一回合：把你刚才的抉择与他人即时反馈作为新场景的承接引子（VN 里不再有竖向历史可回看）
  const lastTurn = state.history[state.history.length - 1]
  // 氛围底图：该剧本封面，压暗+模糊作远景视差层（自定义剧本无封面则不铺）
  const ambientBg = covers[scenario.id]
  // 分享当下：打开预览弹窗，所见即所得地复制/保存/分享此刻的命运卡
  const [showShare, setShowShare] = useState(false)

  return (
    <div className={`play vn ${peek ? 'peek' : ''}`} style={{ height: vvHeight ? Math.max(0, vvHeight - 24) + 'px' : undefined }}>
      {ambientBg && (
        <div
          className="play-ambient"
          style={{ backgroundImage: `url(${ambientBg})` }}
          aria-hidden="true"
        />
      )}
      <div className="vn-stage" onClick={() => peek && setPeek(false)}>
      {sceneArt && (
        // 场景画用 <img> + object-fit:cover 居中裁切，而非 background-image：
        // 部分手机 WebView（含微信 X5）对 background-position:center+cover 有大图渲染偏移 bug（偶发只显示原图左缘）
        <img
          className="vn-scene"
          key={sceneArt}
          src={sceneArt}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <div className="vn-scrim" aria-hidden="true" />
      </div>

      {/* HUD 必须是 vn-stage 的兄弟而非子节点：stage 带 z-index 自成层叠上下文，
          HUD 放在里面时，展开的菜单再高的 z-index 也压不过卷文层（vn-panel），
          会被正文盖住半截。移出来后 HUD(20) > 卷文(6)，菜单才真正浮在最上面 */}
      <header className="vn-hud">
        <div className="vn-hud-row">
          <span className="vn-title">{scenario.title}</span>
          {auto && <span className="play-auto-flag" title="托管中：AI 正替你的角色演进">托管中</span>}
          <button
            className="vn-eye"
            onClick={() => setPeek((v) => !v)}
            title={peek ? '显示卷文' : '看全图（轻触画面恢复）'}
            aria-label={peek ? '显示卷文' : '看全图'}
          >
            {peek ? (isEn() ? 'Text' : '文') : (isEn() ? 'Art' : '图')}
          </button>
          <div className="play-menu">
          <button
            className={`play-menu-btn ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-label="菜单"
            title="菜单"
          >
            ☰
          </button>
          {menuOpen && (
            <>
              <div className="play-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="play-menu-panel" role="menu">
                <button
                  className={`play-menu-item ${auto ? 'on' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    if (!isPro) { setShowProUpsell(true); setMenuOpen(false); return }
                    setAutoStreak(0)
                    setAutoToEnd(false)
                    setAuto((v) => !v)
                  }}
                  title={isPro ? wyT('开启后由 AI 替你的角色自动抉择、自动演进') : wyT('AI 托管是 Pro 会员专属功能，升级 Pro 后即可使用')}
                >
                  <span>{auto ? wyT('停止托管') : wyT('交由 AI 托管')}</span>
                  {!isPro && <span className="play-menu-glyph pro-tag">{wyT('Pro 专属')}</span>}
                  <span className="play-menu-glyph">{auto ? '⏸' : '▶'}</span>
                </button>
                <button className="play-menu-item" role="menuitem" onClick={() => { setShowMemoir(true); setMenuOpen(false) }}>
                  <span>命途留影</span><span className="play-menu-glyph">☰</span>
                </button>
                <button
                  className="play-menu-item"
                  role="menuitem"
                  onClick={() => { setCastPanelOpen(true); setMenuOpen(false) }}
                  title="本局登场过的人与他们的预设身份"
                >
                  <span>人物志</span>
                  <span className="play-menu-glyph">{viewCast.length > 0 ? viewCast.length : '☷'}</span>
                </button>
                <button className="play-menu-item" role="menuitem" onClick={() => { setShowShare(true); setMenuOpen(false) }}>
                  <span>分享此刻</span><span className="play-menu-glyph">⤴</span>
                </button>
                <div className="play-menu-sep" />
                <div className="play-menu-fontrow">
                  <span className="play-menu-fontlabel">字号</span>
                  <FontScaleControl compact />
                </div>
                {CAN_FULLSCREEN && (
                  <button
                    className={`play-menu-item ${fullscreen ? 'on' : ''}`}
                    role="menuitem"
                    onClick={() => {
                      // 必须在这一下点击的同步栈里发起，异步之后调会被浏览器拒
                      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
                      else void document.documentElement.requestFullscreen().catch(() => {})
                      setMenuOpen(false)
                    }}
                    title="隐去地址栏与导航栏，整屏读卷"
                  >
                    <span>{fullscreen ? '退出全屏' : '全屏读卷'}</span>
                    <span className="play-menu-glyph">{fullscreen ? '⤡' : '⤢'}</span>
                  </button>
                )}
                <div className="play-menu-sep" />
                <button
                  className="play-menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    if (window.confirm('退出本局会放弃当前这局（自动保存的进行中进度随之清空，命书阁里的回看点不受影响），确定退出？')) onQuit()
                  }}
                  title="退出当前这局并清空其自动进度（命书阁回看点不受影响）"
                >
                  <span>退出本局</span><span className="play-menu-glyph">↩</span>
                </button>
              </div>
            </>
          )}
          </div>
        </div>
        {quota && (
          <div className="vn-hud-quota">
            {appT('wenyouQuota', {
              remain: quotaIsUnlimited(quota) ? appT('memUnlimited') : quotaChatRemain(quota),
              turn: 1,
            })}
          </div>
        )}
      </header>

      <section className="vn-panel">
        {/* 命数（属性栏）从悬浮 HUD 移入卷文面板顶部：与正文同一容器、随后续文本随面板一起布局，
            不再作为叠加层浮在画面/面板之上，从根上消除「属性栏被面板上沿盖住」的重叠 */}
        <div className="vn-vitals">
          {scenario.attributes.map((a) => {
            const value = state.attributes[a.key]
            const delta = deltas[a.key] ?? 0
            const band = bandOf(a, value)
            // 已达当前上限、且上限低于该属性的绝对 max（说明有更高上限被印记锁着）→ 封顶，需晋阶方可再涨
            const cap = effectiveCeiling(a, flags)
            const atCap = value >= cap && cap < a.max
            const capHint = `已达${scenario.tierLabel ?? ''}上限，需晋阶突破方可提升`
            return (
              <span
                key={a.key}
                className="vn-vital"
                title={atCap ? `${a.name} ${value}/${cap}（${capHint}）` : `${a.name} ${value}/${a.max} · ${band.label}`}
              >
                <span className="vn-vital-name">{a.name}</span>
                <span className={`vn-vital-band sev-${band.severity}`}>{band.label}</span>
                {/* 增减不再在此浮标：属性行会换行，绝对定位的浮标会压到上一行的命数上；
                    数值变化改由卷文承接段的 recap-fx 一处呈现（就在玩家正在读的地方） */}
                <span className={`vn-vital-val ${delta !== 0 ? (delta > 0 ? 'bump-up' : 'bump-down') : ''}`}>
                  {value}
                  {atCap && <span className="vn-vital-cap" title={capHint}>{isEn() ? 'max' : '满'}</span>}
                </span>
              </span>
            )
          })}
        </div>
        {scenario.maxTurns ? (
          <div className="vn-path" aria-hidden="true">
            <span className="vn-path-track">
              <span
                className="vn-path-fill"
                style={{ width: `${Math.min(100, (turnNo / scenario.maxTurns) * 100)}%` }}
              />
            </span>
            <span className="vn-path-label">{isEn() ? 'Fate ' : '命途 '}{turnNo} / {scenario.maxTurns} {wyT(scenario.turnUnit)}</span>
          </div>
        ) : null}
        <div className="vn-panel-head">
          <span className="vn-label-col">
            {keyMoment && <span className="vn-keymark">✦ 命运抉择</span>}
            <span className="vn-scene-label">
              {isEn() ? 'Turn ' : '第 '}{turnNo} {wyT(scenario.turnUnit)}
              {pendingTurn?.summary ? ` · ${pendingTurn.summary}` : ''}
            </span>
          </span>
          {sceneArt && (
            <button
              className="vn-zoom"
              onClick={() => setLightbox(sceneArt)}
              title={msg.clickToEnlarge}
              aria-label={msg.viewNodeArt}
            >
              ⛶
            </button>
          )}
        </div>

        {state.ambition && (
          <div className="ambition-bar vn-ambition">
            <span className="ambition-label">目标</span>
            <span className="ambition-text">{state.ambition}</span>
            {typeof state.goalProgress === 'number' &&
              (() => {
                // 去掉乱跳的百分比，改粗粒度定性阶段（配合 nextProgress 棘轮平滑，稳步不闪退）
                const { label, step } = goalStage(state.goalProgress)
                return (
                  <span className="goal-progress" title={`目标进度 · ${label}`}>
                    <span className="goal-progress-track">
                      <span className="goal-progress-fill" style={{ width: `${(step / 4) * 100}%` }} />
                    </span>
                    <span className="goal-progress-stage">{label}</span>
                  </span>
                )
              })()}
          </div>
        )}

        <div className="vn-body" ref={logRef} onScroll={updateScrollState}>
          {lastTurn && (lastTurn.reaction || lastTurn.twist || deltaList.length > 0) && (
            <div className="vn-recap">
              {lastTurn.choiceText && <p className="picked">{lastTurn.choiceText}</p>}
              {deltaList.length > 0 && (
                <p className="recap-fx">
                  {deltaList.map((f) => (
                    <span
                      key={f.key}
                      className={`fx ${f.v > 0 ? 'up' : 'down'}`}
                      aria-label={`${f.name}${f.v > 0 ? '提升' : '降低'}${Math.abs(f.v)}`}
                    >
                      {f.name} {f.v > 0 ? `+${f.v}` : f.v}
                    </span>
                  ))}
                </p>
              )}
              {lastTurn.reaction && <p className="reaction">{lastTurn.reaction}</p>}
              {lastTurn.twist && <p className="twist">{lastTurn.twist}</p>}
            </div>
          )}
          <div className="vn-prose">
            {state.history.length === 0 && !pendingTurn && !streamText && !loading && (
              <p className="intro">{scenario.intro}</p>
            )}
            {/* 卷文正文：流式段与落定段**共用同一个 <p>**。此前它们是两个不同的 JSX 分支，
                回合落定时 React 会卸载旧段、重建新段（并把所有人名的样式重刷一遍）——
                观感就是「每出一段新故事又刷新一次」。共用之后只改内容、不换节点。 */}
            {loading && streamText ? (
              <p className="narrative">
                {renderNarrative(streamText)}
                <span className="caret">▍</span>
              </p>
            ) : pendingTurn ? (
              proseRevealed ? (
                <p className="narrative">{renderNarrative(pendingTurn.narrative)}</p>
              ) : (
                <Typewriter
                  key={state.history.length}
                  text={pendingTurn.narrative}
                  onType={scrollLogBottom}
                  onDone={() => {
                    revealedTurnRef.current = pendingTurn
                    setProseDone(true)
                  }}
                  render={renderNarrative}
                />
              )
            ) : streamText ? (
              <p className="narrative">
                {renderNarrative(streamText)}
                <span className="caret">▍</span>
              </p>
            ) : null}
            {loading && !streamText && <p className="loading">{wyT('命运正在落笔…')}</p>}
            {error && (
              <div className="error-box">
                <p>{error}</p>
                <button onClick={runTurn}>重试本回合</button>
              </div>
            )}
          </div>

      {pendingTurn && !loading && !pendingAction && proseRevealed && (
        <div className={`choices ${keyMoment ? 'key-moment' : ''}`}>
          {auto && <p className="auto-hint">托管中 · AI 正替你的角色做出抉择，点任意选项或「托管 ⏸」可随时接管</p>}
          {pendingTurn.choices.map((c, i) => {
            const isRec = auto && pendingTurn.recommend === i
            return (
              <button key={i} className={`choice ${isRec ? 'recommended' : ''}`} onClick={() => pick(i)}>
                <span className="choice-text">{isRec ? '➤ ' : ''}{c.text}</span>
              </button>
            )
          })}

          {source.supportsCustomAction &&
            (customOpen ? (
              <div className="custom-action">
                <textarea
                  className="custom-input"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value.slice(0, CUSTOM_ACTION_MAX))}
                  onKeyDown={(e) => {
                    // 手机没有实体 Ctrl/Cmd：Enter 直接提交，Shift+Enter 换行
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submitCustom()
                    }
                  }}
                  placeholder={wyT('写下你想做的事，由 AI 裁定结果（Enter 提交，Shift+Enter 换行）')}
                  rows={2}
                  maxLength={CUSTOM_ACTION_MAX}
                  autoFocus
                />
                <div className="custom-row">
                  <button className="ghost" onClick={() => { setCustomOpen(false); setCustomText('') }}>
                    取消
                  </button>
                  <span className="custom-count">{customText.length}/{CUSTOM_ACTION_MAX}</span>
                  <button className="primary" disabled={!customText.trim()} onClick={submitCustom}>
                    照此行事
                  </button>
                </div>
              </div>
            ) : (
              <button className="choice custom-trigger" onClick={() => setCustomOpen(true)}>
                <span className="choice-text">✎ 自己写一个行动…</span>
              </button>
            ))}
        </div>
      )}
          {!atBottom && (
            <button className="vn-new-content" onClick={scrollToLatest} aria-label="回到最新" title="回到最新">
              {isEn() ? '↓ New' : '↓ 有新内容'}
            </button>
          )}
        </div>
        {((state.inventory ?? []).length > 0 || (state.memory ?? []).length > 0) && (
          <div className="vn-meta">
            {(state.inventory ?? []).length > 0 && (
              <div className="inventory">
                <span className="inventory-label">行囊</span>
                {(state.inventory ?? []).map((it) => (
                  <span key={it} className="item-chip">{it}</span>
                ))}
              </div>
            )}
            {(state.memory ?? []).length > 0 && (
              <details className="memory">
                <summary>
                  <span className="memory-label">记忆</span>
                  <span className="memory-count">{(state.memory ?? []).length}</span>
                </summary>
                <ul className="memory-list">
                  {(state.memory ?? []).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {showMemoir && (
        <Memoir
          scenario={scenario}
          state={state}
          onClose={() => setShowMemoir(false)}
          onViewArt={setLightbox}
        />
      )}
      {castPanelOpen && (
        <CastPanel
          cast={viewCast}
          scenario={scenario}
          onClose={() => setCastPanelOpen(false)}
          onOpenPerson={(name) => setCastFocus(name)}
        />
      )}
      {focusMember && (
        <CastCard member={focusMember} scenario={scenario} onClose={() => setCastFocus(null)} />
      )}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {showShare && (
        <ShareCardModal
          sc={scenario}
          st={state}
          coverUrl={nodeImage(scenario.id, pendingTurn?.summary)}
          onClose={() => setShowShare(false)}
        />
      )}
      {showProUpsell && (
        <div className="modal-backdrop" onClick={() => setShowProUpsell(false)}>
          <div className="modal play-upsell" onClick={(e) => e.stopPropagation()}>
            <h3>{wyT('Pro 会员专属')}</h3>
            <p className="play-upsell-desc">
              {wyT('「AI 托管」是 Pro 会员专属功能——开启后 AI 会替你的角色自动抉择、自动演进，无需手动操作。升级 Pro 即可使用。')}
            </p>
            <div className="play-upsell-actions">
              <button
                className="play-upsell-primary"
                onClick={() => { setShowProUpsell(false); useAppStore.getState().openPay('pro') }}
              >
                {wyT('去升级 Pro')}
              </button>
              <button className="play-upsell-ghost" onClick={() => setShowProUpsell(false)}>
                {wyT('继续手动游玩')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showAutoContinue && (
        <div className="modal-backdrop" onClick={stopAuto}>
          <div className="modal play-upsell" onClick={(e) => e.stopPropagation()}>
            <h3>{wyT('连续托管已暂停')}</h3>
            <p className="play-upsell-desc">
              {wyT('已连续托管 15 回合。你可以再托管 15 回合，或挂机到底跑到今日额度用完。')}
            </p>
            <div className="play-upsell-actions">
              <button className="play-upsell-primary" onClick={continueAuto15}>
                {wyT('再托管 15 回合')}
              </button>
              <button className="play-upsell-ghost" onClick={autoRunToEnd}>
                {wyT('挂机到底')}
              </button>
              <button className="play-upsell-ghost" onClick={stopAuto}>
                {wyT('停止托管')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
