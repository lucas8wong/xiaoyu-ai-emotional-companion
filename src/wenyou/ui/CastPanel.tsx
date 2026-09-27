import type { Scenario } from '../scenarios/schema'
import type { CastMember } from '../engine/types'
import { useModalA11y } from './useModalA11y'

// 人物志：本局登场过的具名人物一览（点击任一行开该人的人物卡）。
// 与正文内联可点互补——正文只标当前这一幕出现过的名字，人物志能回看所有遇见过的人。
export function CastPanel({
  cast,
  scenario,
  onClose,
  onOpenPerson,
}: {
  cast: CastMember[]
  scenario: Scenario
  onClose: () => void
  onOpenPerson: (name: string) => void
}) {
  const ref = useModalA11y(onClose)

  return (
    <div className="cast-overlay" onClick={onClose}>
      <div
        className="cast-panel"
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="人物志"
        tabIndex={-1}
      >
        <div className="cast-panel-head">
          <span className="cast-panel-title">人物志</span>
          <span className="cast-panel-count">{cast.length}</span>
          <button className="ghost cast-panel-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {cast.length === 0 ? (
          <p className="cast-panel-empty">这一局还没遇上什么有名字的人。</p>
        ) : (
          <ul className="cast-list">
            {cast.map((c) => (
              <li key={c.name}>
                <button className="cast-row" onClick={() => onOpenPerson(c.name)} title="看此人的预设身份">
                  <span className="cast-row-name">{c.name}</span>
                  <span className="cast-row-role">{c.role}</span>
                  {c.relation && <span className="cast-row-rel">{c.relation}</span>}
                  <span className="cast-row-no">
                    第 {c.firstTurn} {scenario.turnUnit}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
