import type { Scenario } from '../scenarios/schema'
import type { CastMember } from '../engine/types'
import { useModalA11y } from './useModalA11y'

// 人物卡：正文里点一下人名（或人物志里点一行）就开这张卡。
// 内容是「预设身份」——AI 在该人首次登场时登记的身份/关系/背景，一经登记只增不改（引擎侧 applyCast 保证）。
export function CastCard({
  member,
  scenario,
  onClose,
}: {
  member: CastMember
  scenario: Scenario
  onClose: () => void
}) {
  const ref = useModalA11y(onClose)
  const hasDetail = !!(member.relation || member.brief)

  return (
    <div className="cast-overlay" onClick={onClose}>
      <div
        className="cast-card"
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`人物卡 · ${member.name}`}
        tabIndex={-1}
      >
        <div className="cast-card-head">
          <span className="cast-card-name">{member.name}</span>
          <span className="cast-card-role">{member.role}</span>
          <button className="ghost cast-card-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <dl className="cast-card-fields">
          {member.relation && (
            <>
              <dt>与主角关系</dt>
              <dd>{member.relation}</dd>
            </>
          )}
          <dt>首次登场</dt>
          <dd>
            第 {member.firstTurn} {scenario.turnUnit}
            {member.firstSummary ? ` · ${member.firstSummary}` : ''}
          </dd>
          {member.brief && (
            <>
              <dt>此人背景</dt>
              <dd>{member.brief}</dd>
            </>
          )}
        </dl>
        {!hasDetail && <p className="cast-card-hint">此人的来历还没在剧情里写细，待后续回合补全。</p>}
      </div>
    </div>
  )
}
