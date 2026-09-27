/**
 * 千世书分享入口页（/s/<id>[-<opening>]/）
 * 命运卡/社交分享的二维码与链接指向这里：扫码/点开直接看到题材信息 + 「开始这段人生」，
 * 不再落到 SPA 空路由白板。按原设计：入口页 → 携带 ?s=&o= 回到主应用 → 进入文游后自动直达该题材+开局设置页。
 * 仅内置剧本有入口页（自定义局 buildShareUrl 已回退首页）。
 */
import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getLang } from '../i18n'
import { builtinScenarios } from '../wenyou/scenarios'
import { covers } from '../wenyou/ui/covers'
// 分享入口页复用文游的暗色主题（--ink-9 / --cinnabar 等变量），否则页面落在主 App 浅色底上、
// 「开始这段人生」按钮因变量未定义而几乎不可见。
import '../wenyou/styles.css'

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

export default function ShareEntryPage() {
  const { seg = '' } = useParams()
  const lang = getLang()

  // 解析 /s/<id>[-<opening>]（内置 id 为小写单词，如 xian / xian-1）
  let scenarioId = seg
  let opening = -1
  const m = seg.match(/^([a-z][a-z0-9]*)-(\d+)$/)
  if (m) {
    scenarioId = m[1]
    opening = Number(m[2])
  }
  const sc = builtinScenarios.find((b) => b.id === scenarioId)
  const open = sc && opening >= 0 && opening < (sc.openings?.length ?? 0) ? sc.openings![opening] : undefined

  const backLabel = lang === 'en' ? 'Back to home' : lang === 'zh-TW' ? '回到首頁' : '回到首页'
  const ctaLabel = lang === 'en' ? 'Begin this life' : lang === 'zh-TW' ? '開始這段人生' : '开始这段人生'
  const notFound = lang === 'en' ? 'Scenario not found' : lang === 'zh-TW' ? '未找到這個劇本' : '未找到这个剧本'
  const hint =
    lang === 'en'
      ? 'Opens Xiaoyu — go to Roleplay → AI Text Adventure and the story continues from this opening.'
      : lang === 'zh-TW'
        ? '打開小愈後，進入「角色扮演 → AI 文遊」，劇情會從這個開局繼續。'
        : '打开小愈后，进入「角色扮演 → AI 文游」，剧情会从这个开局继续。'

  useEffect(() => {
    if (!sc) return
    document.title = `${sc.title} · 千世书`
    const desc = open ? `${sc.intro}（开局：${open.name}）` : sc.intro
    setMeta('name', 'description', desc)
    setMeta('property', 'og:title', `${sc.title} · 千世书`)
    setMeta('property', 'og:description', desc)
    const cover = covers[sc.id]
    if (cover) {
      const abs = cover.startsWith('http') ? cover : (typeof location !== 'undefined' ? location.origin : '') + cover
      setMeta('property', 'og:image', abs)
    }
  }, [sc, open])

  if (!sc) {
    return (
      <div className="wy-root" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--paper-dim)' }}>{notFound}</p>
          <Link to="/" style={{ display: 'inline-block', marginTop: 16, color: 'var(--gold)' }}>{backLabel}</Link>
        </div>
      </div>
    )
  }

  const playUrl = `/?s=${sc.id}${open ? `&o=${opening}` : ''}`
  const cover = covers[sc.id]

  return (
    <div className="wy-root" style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px 48px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Link to="/" style={{ color: 'var(--paper-dim)', fontSize: '0.84rem', textDecoration: 'none' }}>← {backLabel}</Link>
          <span style={{ fontFamily: 'var(--font-roman)', letterSpacing: '0.2em', color: 'var(--gold)', fontSize: '0.8rem' }}>THOUSAND&nbsp;LIVES</span>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--paper)', letterSpacing: '0.06em' }}>千世书</div>
          <div style={{ marginTop: 4, color: 'var(--paper-dim)', fontSize: '0.9rem' }}>一卷千世，活过千种人生</div>
        </div>

        <div style={{ background: 'rgba(8,11,24,0.5)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {cover && (
            <img src={cover} alt={sc.title} style={{ width: '100%', maxHeight: 280, objectFit: 'cover', display: 'block' }} loading="eager" />
          )}
          <div style={{ padding: '18px 20px' }}>
            {sc.genre && <div style={{ color: 'var(--jade)', fontSize: '0.78rem', letterSpacing: '0.12em', marginBottom: 6 }}>{sc.genre}</div>}
            <h1 style={{ margin: 0, color: 'var(--paper)', fontSize: '1.3rem', fontWeight: 700 }}>{sc.title}</h1>
            <p style={{ margin: '10px 0 0', color: 'var(--paper-dim)', fontSize: '0.9rem', lineHeight: 1.7 }}>{sc.intro}</p>
            {open && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)', fontSize: '0.88rem' }}>
                <div style={{ color: 'var(--gold)', letterSpacing: '0.06em', marginBottom: 6 }}>
                  {lang === 'en' ? 'Starting identity' : lang === 'zh-TW' ? '開局身份' : '开局身份'}：{open.name}
                </div>
                <div style={{ color: 'var(--paper-dim)', lineHeight: 1.7 }}>{open.prompt}</div>
              </div>
            )}
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Link
            to={playUrl}
            style={{
              display: 'inline-block',
              padding: '12px 34px',
              borderRadius: 999,
              background: 'linear-gradient(135deg, var(--cinnabar), var(--cinnabar-bright))',
              color: '#fff',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textDecoration: 'none',
              fontSize: '1rem',
            }}
          >
            {ctaLabel}
          </Link>
          <p style={{ marginTop: 14, color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.7 }}>{hint}</p>
        </div>

        <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--muted)', fontSize: '0.72rem', letterSpacing: '0.1em' }}>千世书 · MIT License</div>
      </div>
    </div>
  )
}
