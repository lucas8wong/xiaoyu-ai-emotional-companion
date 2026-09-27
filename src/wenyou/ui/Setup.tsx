import { useState } from 'react'
import { wyT, isEn, FLAT_EN } from '../i18n'
import type { Scenario, Opening } from '../scenarios/schema'
import { hasLocalMode } from '../engine/local'
import { covers } from './covers'

export function Setup({
  scenario,
  onStart,
  onBack,
  initialOpening,
}: {
  scenario: Scenario
  onStart: (sc: Scenario, opening?: Opening, ambition?: string, mode?: 'ai' | 'local') => void
  onBack: () => void
  // 挑战链接预选的开局下标（?o=）；缺省取首个开局
  initialOpening?: number
}) {
  const [opening, setOpening] = useState<Opening | undefined>(
    scenario.openings?.[initialOpening ?? 0] ?? scenario.openings?.[0],
  )
  const [customId, setCustomId] = useState(false)
  const [customIdText, setCustomIdText] = useState('')
  const [ambition, setAmbition] = useState('')

  // 模式：本地（免额度）/ AI 驱动（小愈 AI，消耗聊天额度）。默认 AI
  const localAvailable = hasLocalMode(scenario)
  const [mode, setMode] = useState<'ai' | 'local'>('ai')

  // 最终身份：自定义优先，否则用选中的预设开局
  const finalOpening = (): Opening | undefined =>
    customId
      ? customIdText.trim()
        ? { name: '自设', prompt: customIdText.trim() }
        : undefined
      : opening

  // 选了「自定义身份」却没写 → 不放行（避免以「无身份」静默开局）
  const ready = !(customId && customIdText.trim() === '')

  return (
    <div className="setup">
      <button className="ghost setup-back" onClick={onBack}>← {wyT('返回文游主页')}</button>
      <div className={`setup-hero ${covers[scenario.id] ? 'has-art' : ''}`}>
        {covers[scenario.id] && (
          <div
            className="setup-hero-art"
            style={{ backgroundImage: `url(${covers[scenario.id]})` }}
            aria-hidden="true"
          />
        )}
        <div className="setup-hero-veil" aria-hidden="true" />
        <div className="setup-hero-cap">
          {scenario.genre && <span className="setup-genre">{scenario.genre}</span>}
          <h2 className="setup-name">{scenario.title}</h2>
        </div>
      </div>
      <p className="setup-intro">{scenario.intro}</p>

      {localAvailable && (
        <section className="panel">
          <h3>游玩模式</h3>
          <div className="mode-row">
            <button
              className={`mode-card ${mode === 'local' ? 'selected' : ''}`}
              onClick={() => {
                setMode('local')
                setCustomId(false)
              }}
            >
              <strong>本地试玩</strong>
              <span>引擎按内置剧情池随机演进，即点即玩、完全免费；每局不同，但剧情有限</span>
            </button>
            <button
              className={`mode-card ${mode === 'ai' ? 'selected' : ''}`}
              onClick={() => setMode('ai')}
            >
              <strong>AI 驱动</strong>
              <span>由小愈 AI 实时编织独一无二的剧情与结局，支持自定义行动；每回合消耗 1 次聊天额度</span>
            </button>
          </div>
        </section>
      )}

      {mode === 'ai' && (
      <section className="panel">
        <h3>AI 服务</h3>
        <p className="hint">AI 由小愈驱动（DeepSeek）。每次回合消耗 1 次聊天额度，与聊一聊/角色扮演共用。</p>
      </section>
      )}

      <section className="panel">
        <h3>选择开局身份</h3>
        <div className="opening-list">
          {(scenario.openings ?? []).map((o) => (
            <button
              key={o.name}
              className={`opening ${!customId && opening?.name === o.name ? 'selected' : ''}`}
              onClick={() => {
                setCustomId(false)
                setOpening(o)
              }}
            >
              <strong>{o.name}</strong>
              <span>{o.prompt}</span>
            </button>
          ))}
          {mode === 'ai' && (
            <button
              className={`opening ${customId ? 'selected' : ''}`}
              onClick={() => setCustomId(true)}
              title="AI 会据此身份演绎你的专属剧情与际遇"
            >
              <strong>✎ 自定义身份</strong>
              <span>自己写一个角色：身份、性格、秘密、处境……</span>
            </button>
          )}
          {mode === 'ai' && customId && (
            <textarea
              className="custom-input"
              value={customIdText}
              onChange={(e) => setCustomIdText(e.target.value)}
              placeholder={wyT('写下你的出身、性格与那点藏着的秘密')}
              rows={2}
              autoFocus
            />
          )}
        </div>
        {mode === 'local' && (
          <p className="hint">
            本地试玩从内置事件池取材，开局身份决定你会遇上哪些事件——三种身份走的是三条不同的线。切到「AI 驱动」还能自己写身份，由 AI 现编贴合你设定的剧情。
          </p>
        )}
      </section>

      {mode === 'ai' && (
      <section className="panel">
        <h3 title="AI 会围绕它编织机遇与阻碍、推动或阻挠剧情，并在结局点明它最终实现、落空还是变质">
          立下你的目标（可选）
        </h3>
        <p className="hint">游戏会围绕它编织机遇与阻碍，让每个选择都有方向。留空则随遇而安。</p>
        {scenario.ambitions && scenario.ambitions.length > 0 && (
          <div className="ambition-list">
            {scenario.ambitions.map((a) => {
              const chipText = isEn() ? (FLAT_EN[a] ?? a) : a;
              return (
                <button
                  key={a}
                  className={`ambition-chip ${ambition === chipText ? 'selected' : ''}`}
                  onClick={() => setAmbition(ambition === chipText ? '' : chipText)}
                >
                  {chipText}
                </button>
              );
            })}
          </div>
        )}
        {/* placeholder 原本写死三个例子（扳倒太后/集齐物资/改写原著），在仙侠、武侠这些剧本里全是串台的；
            上面的备选标签本就来自当前剧本，示例交给它们，这里只邀请你自己写 */}
        <textarea
          className="custom-input"
          value={ambition}
          onChange={(e) => setAmbition(e.target.value)}
          placeholder={wyT('或者，自己写一个')}
          rows={2}
        />
      </section>
      )}

      <button
        className="primary start-btn"
        disabled={!ready}
        onClick={() => {
          onStart(scenario, finalOpening(), mode === 'ai' ? ambition : '', mode)
        }}
      >
        开始这段人生
      </button>
    </div>
  )
}
