import { useEffect, useRef, useState } from 'react'
import type { Scenario } from '../scenarios/schema'
import { importScenarioSchema } from '../scenarios/schema'
import { generateWenyouScenarioStream } from '../../services/api'
import { friendlyError } from '../ai/client'
import { useModalA11y } from './useModalA11y'
import { wyT } from '../i18n'

const SUGGESTIONS = ['大航海海盗', '赛博朋克侦探', '武侠江湖', '三国谋士', '校园青春', '星际殖民', '民国名伶']

export function GenerateModal({
  existingIds,
  onClose,
  onCreated,
}: {
  existingIds: string[]
  onClose: () => void
  onCreated: (sc: Scenario) => void
}) {
  const [theme, setTheme] = useState('')
  const [target, setTarget] = useState(40)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 服务端 SSE 进度（骨架完成 / 支线 n/total）：整份生成较久，让用户看到确实在推进
  const [progress, setProgress] = useState<{ step: 'skeleton' | 'events'; done: number; total: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const ready = theme.trim() !== '' && !busy

  // 卸载（关弹窗/离开文游）时中止上游生成，不让服务端继续白烧多段 DeepSeek
  useEffect(() => () => abortRef.current?.abort(), [])

  // 小愈后端流式生成（骨架 + 并发支线批次）。走 SSE 而非同步请求：
  // 整份生成耗时远超 100s，同步请求经 Cloudflare 会被边缘以 524 掐断（进度/心跳持续下发则不会）。
  const run = async () => {
    setBusy(true)
    setError('')
    setProgress(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const r = await generateWenyouScenarioStream(
        { theme: theme.trim(), target, existingIds },
        (p) => setProgress(p),
        controller.signal,
      )
      if (r.success && r.data) {
        onCreated(importScenarioSchema.parse(r.data.scenario) as Scenario)
      } else if (controller.signal.aborted) {
        // 用户主动中止（关弹窗）：不当作错误提示
      } else {
        setError(r.error || wyT('生成失败'))
      }
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  // 生成中（busy）禁用 Esc 关闭，与点击遮罩一致——后端单次生成不可中断，避免误触白等
  const ref = useModalA11y<HTMLDivElement>(onClose, !busy)

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal gen-modal"
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="AI 生成新剧本"
        tabIndex={-1}
      >
        <h3>{wyT('✨ AI 生成新剧本')}</h3>
        <p className="hint">{wyT('给一个主题，AI 会为你设计属性、结局与上百条支线，生成后加入剧本库。Pro 会员专属 · 每日限量。')}</p>

        <label>
          {wyT('剧本主题')}
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder={wyT('想活一段什么样的人生？')}
            disabled={busy}
            autoFocus
          />
        </label>
        <div className="suggest-row">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="ambition-chip" disabled={busy} onClick={() => setTheme(wyT(s))}>
              {wyT(s)}
            </button>
          ))}
        </div>

        <label>
          {wyT('支线数量：')}{target}
          <input
            type="range"
            min={20}
            max={100}
            step={10}
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(Number(e.target.value))}
          />
          <span className="hint">{wyT('数量越多越耐玩，但更耗时；由小愈 AI 深度生成，按聊天额度计。')}</span>
        </label>

        {busy && (
          <div className="gen-progress">
            <span className="spinner" aria-hidden="true" />
            {progress?.step === 'events' && progress.total > 0
              ? `${wyT('正在写支线剧情…')} ${progress.done}/${progress.total}`
              : wyT('正在构思世界观与支线剧情…')}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <div className="row gen-actions">
          {busy ? (
            <button className="ghost" disabled>
              {wyT('正在生成…')}
            </button>
          ) : (
            <>
              <button className="ghost" onClick={onClose}>
                {wyT('关闭')}
              </button>
              <button className="primary" disabled={!ready} onClick={run}>
                {wyT('开始生成')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
