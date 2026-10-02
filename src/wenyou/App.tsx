import { useEffect, useRef, useState } from 'react'
import { pushDeepBackHandler } from '../lib/deepBack'
import type { Lang } from '../i18n'
import type { Scenario, Opening } from './scenarios/schema'
import type { BridgeSeed } from '../lib/rpBridge'
import { initState } from './engine/state'
import { getInProgress, upsertInProgress, removeInProgress, saveAutoPoint, loadCustomScenarios, loadServerProgress, type SaveGame } from './storage'
import { builtinScenarios } from './scenarios'
import { parseChallenge } from './ui/challengeLink'
import { Home } from './ui/Home'
import { Archive } from './ui/Archive'
import { Setup } from './ui/Setup'
import { Play } from './ui/Play'
import { EndingScreen } from './ui/Ending'
import { WyLangSync, wyT } from './i18n'

type Screen = 'home' | 'archive' | 'setup' | 'play' | 'ending'
export type Session = SaveGame

export default function App({ onBack, lang, initialResumeId, onGoChat }: { onBack?: () => void; lang?: Lang; initialResumeId?: string; onGoChat?: (seed: BridgeSeed) => void }) {
  const [screen, setScreen] = useState<Screen>('home')
  const [setupScenario, setSetupScenario] = useState<Scenario | null>(null)
  const [setupOpening, setSetupOpening] = useState<number | undefined>(undefined)
  const [session, setSession] = useState<Session | null>(null)

  // ── 让文游内「逐级返回」：向深页协调器注册返回处理器，并在历史栈压一条同 URL 哨兵 ──
  // 关键点：用 history.pushState（不触发 popstate）而非 location.hash（片段跳转会触发 popstate，
  // 被 Home 的返回键处理器当成「回退」从而把角色扮演整个关掉、跳回主界面）。
  const onBackRef = useRef(onBack)
  useEffect(() => { onBackRef.current = onBack }, [onBack])
  const screenRef = useRef<Screen>(screen)
  useEffect(() => { screenRef.current = screen }, [screen])
  const sentinelActiveRef = useRef(false) // 当前是否已在历史栈顶压了「次级页」哨兵
  // 从文游首页进入次级页（设剧/对局/结局/命书阁）时压一条哨兵；回首页时由返回键把它消费掉
  useEffect(() => {
    if (screen !== 'home' && !sentinelActiveRef.current) {
      try {
        // 保留当前 history.state（含 react-router 的 idx），避免手工 pushState 破坏路由索引导致返回键乱跳/退出浏览器
        window.history.pushState({ ...(window.history.state || {}), wy: true }, '', window.location.pathname + window.location.search)
        sentinelActiveRef.current = true
      } catch { /* ignore */ }
    }
  }, [screen])
  // 返回处理器：Home 的 popstate 先问它，能否消费这一次返回（文游内逐级回退/退出）
  useEffect(() => {
    return pushDeepBackHandler(() => {
      if (screenRef.current !== 'home') {
        // 文游内次级页：先回文游首页。返回键此时已把哨兵弹出历史，置为失效，不再补压，
        // 这样从文游首页再按返回时，顶部就是「剧情演绎」入口，能退到剧情主页而不是退出浏览器
        setScreen('home')
        sentinelActiveRef.current = false
        return true
      }
      // 文游首页：退出文游回剧情演绎列表（上一层），而非直接跳回主界面
      onBackRef.current?.()
      return true
    })
  }, [])

  // 登录用户：进入千世书时从服务端拉取进度并与本地合并（跨设备跟随）
  useEffect(() => {
    void loadServerProgress()
  }, [])

  // 挑战链接（?s=&o=）：进入即直达对应题材+开局的设置页（仍由玩家确认模式/Key 再开局）
  useEffect(() => {
    if (typeof location === 'undefined') return
    const ch = parseChallenge(location.search)
    if (!ch) return
    const sc = builtinScenarios.find((b) => b.id === ch.scenarioId)
    if (!sc) return
    setSetupScenario(sc)
    setSetupOpening(ch.opening)
    setScreen('setup')
    // 清掉 query，避免刷新/返回重复触发
    try {
      history.replaceState(null, '', location.origin + location.pathname)
    } catch {
      // 某些环境禁用 history API，忽略即可
    }
  }, [])

  const startSetup = (sc: Scenario) => {
    setSetupScenario(sc)
    setSetupOpening(undefined)
    setScreen('setup')
  }

  // 开启新剧本：若该剧本已有进行中局 → 续玩（不覆盖、不新增）；否则新建为一条进行中局（每回合自动保存）。
  const startGame = (
    sc: Scenario,
    opening?: Opening,
    ambition?: string,
    mode: 'ai' | 'local' = 'ai',
  ) => {
    const existing = getInProgress(sc.id)
    if (existing && !existing.state.ended) {
      setSession(existing)
      setScreen('play')
      return
    }
    const s: Session = {
      scenario: sc,
      state: initState(sc, opening, ambition, mode),
      pendingTurn: null,
    }
    setSession(s)
    upsertInProgress(s)
    setScreen('play')
  }

  // 恢复一个进行中局（Home「继续游玩」/命书阁「进行中」）：直接接上上次回合，不覆盖其它剧本。
  const continueGame = (g: SaveGame) => {
    upsertInProgress(g)
    setSession(g)
    setScreen(g.state.ended ? 'ending' : 'play')
  }

  // 召回深链（initialResumeId）：进入即自动续玩该剧本的进行中局
  useEffect(() => {
    if (!initialResumeId) return
    const g = getInProgress(initialResumeId)
    if (g) continueGame(g)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 载入一个回看点 / 进行中局：仅当会替换同一剧本「未结束」的进行中局时才需确认；
  // 确认前先把当前进行中这一局自动封存为回看点（回到旧点后两边都不丢）。
  const loadGame = (g: SaveGame) => {
    const existing = getInProgress(g.scenario.id)
    if (existing && !existing.state.ended) {
      const samePoint =
        existing.state.history.length === g.state.history.length &&
        (existing.pendingTurn?.narrative ?? '') === (g.pendingTurn?.narrative ?? '')
      if (!samePoint) {
        // 载入的是更早（或分叉）的回看：先把此刻的进行中局封存下来
        void saveAutoPoint(
          { scenario: existing.scenario, state: existing.state, pendingTurn: existing.pendingTurn },
          'auto',
        )
        if (!window.confirm(wyT('将回到所选回看点继续；当前进行中进度已自动封存为回看点，不会丢失。确定？'))) {
          return
        }
      }
    }
    upsertInProgress(g)
    setSession(g)
    setScreen(g.state.ended ? 'ending' : 'play')
  }

  // 退出本局：只清除当前剧本的进行中局，其它剧本进度不动。
  const restart = () => {
    const cur = session
    if (cur) removeInProgress(cur.scenario.id)
    setSession(null)
    setScreen('home')
  }

  // 重玩同一剧本：清掉该剧本的进行中局，回到其设置页。
  // 按 id 取回剧本的「原始定义」重开，而非沿用 session.scenario（后者可能带旧存档遗留的非基准 maxTurns），
  // 保证每次重玩都从该剧本的基准设定起步。
  const replay = (sc: Scenario) => {
    removeInProgress(sc.id)
    setSession(null)
    const base =
      builtinScenarios.find((b) => b.id === sc.id) ??
      loadCustomScenarios().find((c) => c.id === sc.id) ??
      sc
    startSetup(base)
  }

  const updateSession = (s: Session) => {
    setSession(s)
    if (s.state.ended) {
      // 结局已并入命书阁（endings/stats），从「进行中」移除该局，避免继续列表出现已结束的局。
      removeInProgress(s.scenario.id)
      setScreen('ending')
    } else {
      upsertInProgress(s)
    }
  }

  return (
    <div className="app">
      <WyLangSync lang={lang} />
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      {onBack && (
        <button
          className="ghost wy-back"
          onClick={() => window.history.back()}
          aria-label={wyT('返回')}
          title={wyT('返回')}
        >
          <span aria-hidden="true" className="wy-back-arrow">←</span>
        </button>
      )}
      {/* key=lang：语言切换只重挂载「渲染层」，screen/session 留在顶层组件
          切语言不再整棵 App 重挂载、不再把玩家踢回首页 */}
      <main id="main-content" key={lang} tabIndex={-1}>
        {screen === 'home' && (
          <Home
            onSelect={startSetup}
            onContinue={continueGame}
            onOpenArchive={() => setScreen('archive')}
          />
        )}
        {screen === 'archive' && (
          <Archive onBack={() => setScreen('home')} onLoadGame={loadGame} />
        )}
        {screen === 'setup' && setupScenario && (
          <Setup
            key={setupScenario.id}
            scenario={setupScenario}
            onStart={startGame}
            onBack={() => setScreen('home')}
            initialOpening={setupOpening}
          />
        )}
        {screen === 'play' && session && (
          <Play session={session} onUpdate={updateSession} onQuit={restart} />
        )}
        {screen === 'ending' && session && (
          <EndingScreen session={session} onRestart={restart} onReplay={replay} onGoChat={onGoChat} />
        )}
      </main>
    </div>
  )
}
