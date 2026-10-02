/**
 * 自建剧本（表单式，非技术用户友好），填字段自动生成合法剧本 JSON
 * 替代手写 JSON：标题/题材/简介/属性/开局身份/结局（触发条件自动生成）
 * 产出通过 importScenarioSchema 校验，与「导入剧本」同一入库路径（addCustomScenario）
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { ZodError } from 'zod'
import { importScenarioSchema, type Scenario } from '../scenarios/schema'
import { useModalA11y } from './useModalA11y'
import { wyT } from '../i18n'

interface AttrRow { name: string; initial: number; max: number }
interface OpeningRow { name: string; prompt: string }
interface EndingRow { name: string; kind: 'attr' | 'maxTurns'; attrIndex: number; epilogue: string }

const newAttr = (): AttrRow => ({ name: wyT('勇气'), initial: 5, max: 10 })
const newOpening = (): OpeningRow => ({
  name: wyT('平凡的一天'),
  prompt: wyT('你在一如往常的清晨醒来，故事从这里开始。'),
})
const newEnding = (kind: EndingRow['kind'], attrIndex = 0): EndingRow => ({
  name: kind === 'maxTurns' ? wyT('此生行至尽头') : wyT('勇气耗尽'),
  kind,
  attrIndex,
  epilogue: '',
})

export function ScenarioCreator({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (sc: Scenario) => void
}) {
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState('')
  const [intro, setIntro] = useState('')
  const [rounds, setRounds] = useState(20)
  const [attrs, setAttrs] = useState<AttrRow[]>([newAttr()])
  const [openings, setOpenings] = useState<OpeningRow[]>([newOpening()])
  const [endings, setEndings] = useState<EndingRow[]>([
    newEnding('attr', 0),
    newEnding('maxTurns'),
  ])
  const [error, setError] = useState('')

  const ref = useModalA11y<HTMLDivElement>(onClose, true)

  const setAttr = (i: number, patch: Partial<AttrRow>) =>
    setAttrs((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const setOpening = (i: number, patch: Partial<OpeningRow>) =>
    setOpenings((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const setEnding = (i: number, patch: Partial<EndingRow>) =>
    setEndings((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const removeAttr = (i: number) => {
    setAttrs((prev) => prev.filter((_, idx) => idx !== i))
    // 同步清理/重排指向被删属性的「耗尽」结局
    setEndings((prev) => {
      let next = prev.filter((e) => !(e.kind === 'attr' && e.attrIndex === i))
      next = next.map((e) => (e.kind === 'attr' && e.attrIndex > i ? { ...e, attrIndex: e.attrIndex - 1 } : e))
      return next
    })
  }
  const removeOpening = (i: number) => setOpenings((prev) => prev.filter((_, idx) => idx !== i))
  const removeEnding = (i: number) => setEndings((prev) => prev.filter((_, idx) => idx !== i))

  const build = (): Scenario => {
    const attrList = attrs.map((a, i) => ({
      key: `attr${i + 1}`, // 自动生成合法 ASCII key，用户不用懂
      name: a.name.trim(),
      initial: Math.max(0, Number(a.initial) || 0),
      max: Math.max(Number(a.max) || 1, Math.max(0, Number(a.initial) || 0) + 1),
    }))
    const openingList = openings.map((o) => ({ name: o.name.trim(), prompt: o.prompt.trim() }))
    const endingList = endings
      .filter((e) => e.name.trim())
      .map((e) =>
        e.kind === 'maxTurns'
          ? { condition: 'maxTurns', tone: e.name.trim(), epilogue: e.epilogue.trim() || undefined }
          : {
              condition: `${attrList[e.attrIndex]?.key ?? 'attr1'}<=0`,
              tone: e.name.trim(),
              epilogue: e.epilogue.trim() || undefined,
            },
      )
    return {
      id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.trim(),
      genre: genre.trim() || undefined,
      intro: intro.trim(),
      attributes: attrList,
      openings: openingList,
      systemPrompt: `你是文字人生模拟器「${title.trim()}」。${intro.trim()} 围绕玩家的选择展开剧情，用中文讲述，注意体现属性的变化。`,
      turnUnit: '回合',
      maxTurns: Math.min(100, Math.max(5, Number(rounds) || 20)),
      endings: endingList,
    }
  }

  const submit = () => {
    setError('')
    if (!title.trim() || !intro.trim()) { setError('请填写标题和简介'); return }
    if (attrs.length === 0 || attrs.some((a) => !a.name.trim())) { setError('至少需要一个属性，且属性名不能为空'); return }
    if (openings.length === 0 || openings.some((o) => !o.name.trim())) { setError('至少需要一个开局身份，且身份名不能为空'); return }
    if (endings.length === 0 || !endings.some((e) => e.name.trim())) { setError('至少需要一个结局'); return }
    try {
      const sc = importScenarioSchema.parse(build())
      onCreated(sc)
    } catch (e) {
      if (e instanceof ZodError) {
        const issue = e.issues[0]
        const field = issue.path.join('.') || '(根)'
        setError(`剧本创建失败：字段 ${field}：${issue.message}`)
      } else {
        setError('剧本创建失败：' + (e instanceof Error ? e.message.slice(0, 120) : String(e)))
      }
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal gen-modal creator-modal"
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="用表单创建新剧本"
        tabIndex={-1}
      >
        <h3>✎ 用表单创建剧本</h3>
        <p className="hint">不用碰代码：填好下面的内容，我们会自动生成剧本文件。</p>

        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="我的故事" />
        </label>
        <label>
          题材（可选）
          <input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="日常 / 仙侠 / 悬疑…" />
        </label>
        <label>
          简介
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} placeholder="用一两句话介绍这个故事" />
        </label>
        <label>
          总回合上限（活到最后一回合的时长）
          <input
            type="number"
            min={5}
            max={100}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          />
        </label>

        <fieldset>
          <legend>属性（勇气/好感/修为…）</legend>
          {attrs.map((a, i) => (
            <div className="creator-row" key={i}>
              <input
                value={a.name}
                onChange={(e) => setAttr(i, { name: e.target.value })}
                placeholder="属性名（如 勇气）"
              />
              <input
                type="number"
                value={a.initial}
                onChange={(e) => setAttr(i, { initial: Number(e.target.value) })}
                aria-label="初始值"
                placeholder="初始"
                className="creator-num"
              />
              <input
                type="number"
                value={a.max}
                onChange={(e) => setAttr(i, { max: Number(e.target.value) })}
                aria-label="上限"
                placeholder="上限"
                className="creator-num"
              />
              <button type="button" className="creator-del" onClick={() => removeAttr(i)} aria-label="删除属性">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button type="button" className="creator-add" onClick={() => setAttrs((p) => [...p, newAttr()])}>
            ＋ 添加属性
          </button>
        </fieldset>

        <fieldset>
          <legend>开局身份（至少 1 个）</legend>
          {openings.map((o, i) => (
            <div className="creator-row" key={i}>
              <input
                value={o.name}
                onChange={(e) => setOpening(i, { name: e.target.value })}
                placeholder="身份名（如 平凡上班族）"
              />
              <input
                value={o.prompt}
                onChange={(e) => setOpening(i, { prompt: e.target.value })}
                placeholder="开局时发生的事"
                className="creator-wide"
              />
              <button type="button" className="creator-del" onClick={() => removeOpening(i)} aria-label="删除开局">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button type="button" className="creator-add" onClick={() => setOpenings((p) => [...p, newOpening()])}>
            ＋ 添加开局
          </button>
        </fieldset>

        <fieldset>
          <legend>结局（至少 1 个）</legend>
          {endings.map((e, i) => (
            <div className="creator-row" key={i}>
              <input
                value={e.name}
                onChange={(ev) => setEnding(i, { name: ev.target.value })}
                placeholder="结局名（如 勇气耗尽）"
              />
              <select
                value={e.kind}
                onChange={(ev) => setEnding(i, { kind: ev.target.value as EndingRow['kind'] })}
                className="creator-select"
              >
                <option value="attr">某属性降到 0</option>
                <option value="maxTurns">活到最后一回合</option>
              </select>
              {e.kind === 'attr' && (
                <select
                  value={Math.min(e.attrIndex, Math.max(attrs.length - 1, 0))}
                  onChange={(ev) => setEnding(i, { attrIndex: Number(ev.target.value) })}
                  className="creator-select creator-attr"
                >
                  {attrs.map((a, ai) => (
                    <option key={ai} value={ai}>
                      {a.name.trim() || `属性 ${ai + 1}`}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={e.epilogue}
                onChange={(ev) => setEnding(i, { epilogue: ev.target.value })}
                placeholder="尾声（可选）"
                className="creator-wide"
              />
              <button type="button" className="creator-del" onClick={() => removeEnding(i)} aria-label="删除结局">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button type="button" className="creator-add" onClick={() => setEndings((p) => [...p, newEnding('attr', 0)])}>
            ＋ 添加结局
          </button>
        </fieldset>

        {error && <p className="error">{error}</p>}

        <div className="gen-actions">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={submit}>
            创建剧本
          </button>
        </div>
      </div>
    </div>
  )
}
