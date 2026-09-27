import { useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import { msg } from './messages'
import { wyT } from '../i18n'
import { importScenarioSchema, type Scenario } from '../scenarios/schema'
import { builtinScenarios } from '../scenarios'
import {
  loadCustomScenarios,
  addCustomScenario,
  syncCustomScenarios,
  pushCustomScenarios,
  listInProgress,
  removeInProgress,
  deleteSlotsByScenario,
  seenEndings,
  loadStats,
  type SaveGame,
} from '../storage'
import { computeAchievements } from '../engine/achievements'
import { achievementConfig } from '../scenarios/achievementConfig'
import { reachableEndingTones } from '../engine/state'
import { covers } from './covers'
import { GenerateModal } from './GenerateModal'
import { ScenarioCreator } from './ScenarioCreator'

// 八卦：作为剧本卡角落的星盘点缀，按序轮替
const TRIGRAMS = ['☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷']

/** 示例剧本（通过 importScenarioSchema 校验，可下载给非技术用户照着改） */
const EXAMPLE_SCENARIO: Scenario = {
  id: 'my-first-story',
  title: '我的第一个故事',
  genre: '日常',
  intro: '一个关于勇气的小故事。',
  attributes: [{ key: 'courage', name: '勇气', initial: 5, max: 10 }],
  openings: [
    { name: '平凡的一天', prompt: '你是一个普通的上班族，今天早上出门时遇到了一个需要帮助的陌生人。' },
  ],
  systemPrompt: '你是一位温柔的文字人生模拟器，围绕玩家的选择展开剧情，用中文讲述，注意体现“勇气”属性的变化。',
  turnUnit: '回合',
  endings: [
    { condition: 'courage<=0', tone: '退缩', epilogue: '勇气耗尽，你选择了退缩。但这只是一个开始。' },
  ],
  localEvents: [
    {
      narrative: '你遇到了一个需要帮助的陌生人。',
      choices: [
        { text: '上前帮忙', effects: { courage: 1 }, reaction: '陌生人感激地笑了。' },
        { text: '犹豫着走开', effects: { courage: -1 }, reaction: '你低头快步走过。' },
      ],
      summary: '一次小小的选择',
    },
  ],
}

/** 剧本文件格式图示（给非技术用户看） */
const FORMAT_SAMPLE = `{
  "id": "my-first-story",       ← 唯一编号（英文小写，不能和内置剧本重复）
  "title": "剧本标题",           ← 显示在卡片上的名字
  "intro": "一句话简介",
  "attributes": [                ← 属性（勇气/好感/修为…）
    { "key": "courage", "name": "勇气", "initial": 5, "max": 10 }
  ],
  "openings": [                  ← 开局身份（至少 1 个）
    { "name": "开局身份名", "prompt": "开局时发生的事" }
  ],
  "endings": [                   ← 结局（满足条件即触发）
    { "condition": "courage<=0", "tone": "结局名" }
  ]
}`

function importErrorMessage(e: unknown): string {
  if (e instanceof SyntaxError) {
    return '文件不是有效的 JSON，请下载示例剧本对照格式修改'
  }
  if (e instanceof ZodError) {
    const issue = e.issues[0]
    if (!issue) return '剧本格式校验未通过'
    const field = issue.path.join('.') || '剧本'
    if (issue.code === 'invalid_type' && issue.path.length <= 1) {
      return `缺少必要字段：${field}（可下载示例剧本对照）`
    }
    return `字段格式不对：${field}（${issue.message}）`
  }
  return e instanceof Error ? e.message.slice(0, 200) : String(e)
}

export function Home({
  onSelect,
  onContinue,
  onOpenArchive,
}: {
  onSelect: (sc: Scenario) => void
  onContinue: (g: SaveGame) => void
  onOpenArchive: () => void
}) {
  const [custom, setCustom] = useState<Scenario[]>(loadCustomScenarios)
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [inProgress, setInProgress] = useState<SaveGame[]>(() => listInProgress())
  const [pendingDelete, setPendingDelete] = useState<SaveGame | null>(null)
  const [deleteAlsoArchive, setDeleteAlsoArchive] = useState(false)
  const [showGen, setShowGen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  // 登录用户：账号级同步（拉服务端 → 与本地合并 → 收敛，跨设备不丢）
  useEffect(() => {
    let alive = true
    syncCustomScenarios().then((list) => {
      if (alive) setCustom(list)
    })
    return () => { alive = false }
  }, [])

  // 收集进度（首页露出留存钩子）：累计解锁结局数 / 总数、已得成就数 / 总数
  const endingsTotal = builtinScenarios.reduce((s, sc) => s + reachableEndingTones(sc).length, 0)
  const endingsSeen = builtinScenarios.reduce(
    (s, sc) => s + new Set(seenEndings(sc.id)).size,
    0,
  )
  const achievements = computeAchievements({
    scenarios: builtinScenarios.map((sc) => ({
      id: sc.id,
      seen: new Set(seenEndings(sc.id)).size,
      total: reachableEndingTones(sc).length,
    })),
    stats: loadStats(),
    seenTones: Object.fromEntries(builtinScenarios.map((sc) => [sc.id, seenEndings(sc.id)])),
    achConfig: achievementConfig,
  })
  const achDone = achievements.filter((a) => a.done).length

  const onImport = async (file: File) => {
    try {
      const sc = importScenarioSchema.parse(JSON.parse(await file.text()))
      if (builtinScenarios.some((b) => b.id === sc.id)) {
        throw new Error(`剧本 id "${sc.id}" 与内置剧本重复，请换一个 id`)
      }
      addCustomScenario(sc)
      setCustom(loadCustomScenarios())
      setImportError('')
      void pushCustomScenarios()
    } catch (e) {
      setImportError(`${msg.importFailed}：${importErrorMessage(e)}`)
    }
  }

  const downloadExample = () => {
    const blob = new Blob([JSON.stringify(EXAMPLE_SCENARIO, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '示例剧本.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // 删除「继续游玩」里的一条记录：默认只清该剧本的进行中局；确认框里可勾选「连同该剧本在命书阁的回看一并清」
  const openDelete = (g: SaveGame) => {
    setDeleteAlsoArchive(false)
    setPendingDelete(g)
  }
  const confirmDelete = () => {
    const g = pendingDelete
    if (!g) return
    removeInProgress(g.scenario.id)
    if (deleteAlsoArchive) deleteSlotsByScenario(g.scenario.id)
    setInProgress(listInProgress())
    setPendingDelete(null)
    setDeleteAlsoArchive(false)
  }

  return (
    <div className="home">
      <div className="hero">
        <div className="home-banner" aria-hidden="true">
          <span className="ring"></span>
          <span className="ticks"></span>
          <span className="ticks fine"></span>
          <span className="inner"></span>
          <span className="orbit"><span className="g">命</span><span className="g o2">缘</span></span>
          <span className="orbit orbit2"><span className="g">劫</span><span className="g o2">道</span></span>
        </div>
        <div className="hero-title">
          <h1 className="logo">千世书<span className="seal" aria-hidden="true">千世</span></h1>
          <span className="hero-div" aria-hidden="true"></span>
          <p className="roman" aria-hidden="true">THOUSAND&nbsp;LIVES</p>
          <p className="tagline">一卷千世，活过千种人生</p>
          <p className="home-hook">落子无悔，步步皆命运</p>
        </div>
      </div>

      <button className="collection-strip" onClick={onOpenArchive}>
        <span className="cs-gauge">
          <span className="cs-top">📖 已历结局 <b>{endingsSeen}</b><i>/{endingsTotal}</i></span>
          <span className="cs-bar" aria-hidden="true">
            {endingsSeen > 0 && (
              <span
                className="cs-bar-fill"
                style={{ width: `${endingsTotal ? Math.round((endingsSeen / endingsTotal) * 100) : 0}%` }}
              />
            )}
          </span>
        </span>
        <span className="cs-gauge">
          <span className="cs-top">🏅 成就 <b>{achDone}</b><i>/{achievements.length}</i></span>
          <span className="cs-bar" aria-hidden="true">
            {achDone > 0 && (
              <span
                className="cs-bar-fill ach"
                style={{ width: `${achievements.length ? Math.round((achDone / achievements.length) * 100) : 0}%` }}
              />
            )}
          </span>
        </span>
        <span className="cs-go" aria-hidden="true">命书阁 →</span>
      </button>

      {inProgress.length > 0 && (
        <div className="continue-list">
          <p className="continue-list-head">{wyT('继续游玩')}</p>
          {inProgress.map((g) => (
            <div key={g.scenario.id} className="continue-item">
              <button
                className="continue-card"
                onClick={() => onContinue(g)}
              >
                ▶ {g.scenario.title} · 第 {g.state.history.length + 1}{' '}
                {g.scenario.turnUnit}
              </button>
              <button
                className="continue-del"
                aria-label={wyT('删除')}
                title={wyT('删除')}
                onClick={() => openDelete(g)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="scenario-grid">
        {[...builtinScenarios, ...custom].map((sc, i) => {
          const cover = covers[sc.id]
          const total = reachableEndingTones(sc).length
          const seen = new Set(seenEndings(sc.id)).size
          const pct = total ? Math.round((seen / total) * 100) : 0
          return (
            <button
              key={sc.id}
              className={`scenario-card ${cover ? 'has-cover' : ''}`}
              onClick={() => onSelect(sc)}
            >
              {/* 用 <img loading="lazy"> 而不是 CSS 背景图：背景图没有懒加载这回事，
                  十张封面会在首屏一次性全下（实测 1.38 MB），而首屏只看得见三张 */}
              {cover && (
                <img
                  className="card-cover"
                  src={cover}
                  loading="lazy"
                  decoding="async"
                  alt=""
                  aria-hidden="true"
                />
              )}
              <span className="card-rune" aria-hidden="true">{TRIGRAMS[i % TRIGRAMS.length]}</span>
              {sc.genre && <span className="scenario-genre">{sc.genre}</span>}
              <span className="scenario-title">{sc.title}</span>
              <span className="scenario-intro">{sc.intro}</span>
              {seen > 0 && <span className="card-seen">已历 {seen}/{total} 结局</span>}
              {seen > 0 && (
                <span className="card-meter" aria-hidden="true">
                  <span className="card-meter-fill" style={{ width: `${pct}%` }} />
                </span>
              )}
            </button>
          )
        })}
        {/* 自建剧本（表单式，非技术用户友好） */}
        <button className="scenario-card create-card" onClick={() => setCreateOpen(true)}>
          <span className="scenario-emoji">✎</span>
          <span className="scenario-title">自建剧本</span>
          <span className="scenario-intro">填表创建，不用碰代码</span>
        </button>
        {/* AI 生成剧本：小愈后端 DeepSeek 生成整份剧本（Pro 专属 + 每日限量） */}
        <button className="scenario-card gen-card" onClick={() => setShowGen(true)}>
          <span className="scenario-emoji">✨</span>
          <span className="scenario-title">AI 生成剧本</span>
          <span className="scenario-intro">输入主题，AI 为你写剧本（Pro）</span>
        </button>
        <button className="scenario-card import-card" onClick={() => fileRef.current?.click()}>
          <span className="scenario-emoji">＋</span>
          <span className="scenario-title">导入剧本</span>
          <span className="scenario-intro">选择 .json 文件导入（不会写？先下载示例剧本）</span>
        </button>
      </div>

      {importError && <p className="error">{importError}</p>}

      {/* 非技术用户引导：下载示例 + 格式图示 */}
      <div className="import-help">
        <button type="button" className="import-help-btn" onClick={downloadExample}>
          ⬇ 下载示例剧本
        </button>
        <details className="import-help-details">
          <summary>剧本文件长什么样？</summary>
          <p>导入的是一个 .json 文件，核心字段如下（下载示例剧本照着改就行）：</p>
          <pre>{FORMAT_SAMPLE}</pre>
        </details>
      </div>

      {showGen && (
        <GenerateModal
          existingIds={[...builtinScenarios, ...custom].map((s) => s.id)}
          onClose={() => setShowGen(false)}
          onCreated={(sc) => {
            addCustomScenario(sc)
            setCustom(loadCustomScenarios())
            setShowGen(false)
            void pushCustomScenarios()
          }}
        />
      )}

      {createOpen && (
        <ScenarioCreator
          onClose={() => setCreateOpen(false)}
          onCreated={(sc) => {
            addCustomScenario(sc)
            setCustom(loadCustomScenarios())
            setCreateOpen(false)
            void pushCustomScenarios()
          }}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onImport(f)
          e.target.value = ''
        }}
      />

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>{wyT('删除游玩记录')}</h3>
            <p>{wyT('删除这条游玩记录？该剧本的进行中进度将被清空，无法恢复。')}</p>
            <label className="wy-check">
              <input
                type="checkbox"
                checked={deleteAlsoArchive}
                onChange={(e) => setDeleteAlsoArchive(e.target.checked)}
              />
              <span>{wyT('同时删除该剧本在命书阁的回看')}</span>
            </label>
            <p className="wy-note">{wyT('（命书阁的结局图鉴与成就不受影响）')}</p>
            <div className="wy-modal-actions">
              <button className="ghost" onClick={() => setPendingDelete(null)}>{wyT('取消')}</button>
              <button className="primary" onClick={confirmDelete}>{wyT('删除')}</button>
            </div>
          </div>
        </div>
      )}

      <footer className="colophon">
        <span className="colophon-rule" aria-hidden="true" />
        <p className="colophon-mit">千世书 · MIT License</p>
      </footer>
    </div>
  )
}
