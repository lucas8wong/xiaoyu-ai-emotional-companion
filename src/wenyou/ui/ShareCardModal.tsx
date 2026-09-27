import { useEffect, useRef, useState } from 'react'
import type { Scenario } from '../scenarios/schema'
import type { GameState } from '../engine/types'
import { drawShareCard, canvasToBlob, type CardAchievement } from './shareCard'
import { copyImage, downloadBlob } from './download'
import { useModalA11y } from './useModalA11y'

// 分享命运卡：先生成卡图给玩家预览，再让其明确选择「复制图 / 存图 / 原生分享」。
// 所见即所得，避免「点了分享不知道发生了啥」；一个弹窗同时照顾桌面(复制/下载)与手机(原生分享)。
export function ShareCardModal({
  sc,
  st,
  achievements = [],
  coverUrl,
  onClose,
}: {
  sc: Scenario
  st: GameState
  achievements?: CardAchievement[]
  coverUrl?: string
  onClose: () => void
}) {
  const ref = useModalA11y(onClose)
  const [imgUrl, setImgUrl] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [err, setErr] = useState(false)
  const [msg, setMsg] = useState('')
  const [sharing, setSharing] = useState(false)
  const [shareFallback, setShareFallback] = useState(false)
  const aliveRef = useRef(true)

  // 挂载即生成卡图（drawShareCard 内含配图加载，故异步）
  useEffect(() => {
    aliveRef.current = true
    let objUrl = ''
    ;(async () => {
      try {
        const canvas = await drawShareCard(sc, st, achievements, coverUrl)
        const b = await canvasToBlob(canvas)
        if (!b) throw new Error('blob')
        if (!aliveRef.current) return
        objUrl = URL.createObjectURL(b)
        setBlob(b)
        setImgUrl(objUrl)
      } catch {
        if (aliveRef.current) setErr(true)
      }
    })()
    return () => {
      aliveRef.current = false
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => aliveRef.current && setMsg(''), 2200)
  }

  const onCopy = async () => {
    if (!blob) return
    // 复制图片需安全上下文(HTTPS 或 localhost)；不可用时提示退而用「保存图片」
    flash((await copyImage(blob)) ? '已复制图，去聊天框粘贴 ✓' : '此环境不支持复制图，请用「保存图片」')
  }
  const onSave = () => {
    if (blob) {
      downloadBlob(blob, 'qianshi-fate-card.png')
      flash('已保存到本地 ✓')
    }
  }
  // 与聊一聊/理一理一致：一键调起系统分享面板（微信/系统相册等）。
  // 网页无法预选目标 App，桌面/设备不支持时给出一行「保存图片」兜底提示。
  const onShareSystem = async () => {
    if (!blob || sharing) return
    setSharing(true)
    try {
      const file = new File([blob], 'qianshi-fate-card.png', { type: 'image/png' })
      const nav = typeof navigator !== 'undefined' ? navigator : null
      if (nav && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: '千世书 · 命运卡' })
          return // 已交给系统分享面板 / 成功
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return // 用户取消，静默
          console.error('系统分享失败', e)
        }
      }
      setShareFallback(true) // 桌面 / 设备不支持 → 提示改用保存图片
    } finally {
      setSharing(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="分享命运卡"
      tabIndex={-1}
    >
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <h3>分享命运卡</h3>
        <div className="share-modal-body">
          <div className="share-preview">
            {err ? (
              <p className="share-err">命运卡生成失败，请重试。</p>
            ) : imgUrl ? (
              <img src={imgUrl} alt="命运卡预览" />
            ) : (
              <p className="share-loading">正在生成命运卡…</p>
            )}
          </div>
          <div className="share-side">
            <div className="share-modal-actions">
              <button className="primary" onClick={onCopy} disabled={!blob} title="复制卡图，直接粘进微信/聊天框发图">
                复制图片 ⎘
              </button>
              <button onClick={onSave} disabled={!blob} title="把命运卡保存到本地">
                保存图片 ⤓
              </button>
            </div>
            <div className="share-system-row">
              <button
                className="primary"
                onClick={onShareSystem}
                disabled={!blob || sharing}
                title="调起系统分享面板（微信 / 相册等）"
              >
                分享到…
              </button>
            </div>
            {shareFallback && (
              <p className="share-tip fallback" role="status">当前设备不支持系统分享，请先「保存图片」，再到对应 App 里上传。</p>
            )}
            {msg && <p className="share-msg" role="status">{msg}</p>}
            <button className="ghost share-close" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  )
}
