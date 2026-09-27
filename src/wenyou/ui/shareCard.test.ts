import { describe, it, expect } from 'vitest'
import type { Scenario } from '../scenarios/schema'
import type { GameState } from '../engine/types'
import { builtinScenarios } from '../scenarios'
import { drawShareCard } from './shareCard'

/**
 * 分享卡二维码回归测试：
 * - 内置剧本：只画 1 个「同款开局」挑战码，不再画 myxiaoyu.com 官网码。
 * - 自定义/生成剧本（无 /s/<id>[/<i>] 分享入口页）：不画任何二维码（避免出现「官网主页链接」）。
 * 通过捕获 canvas fillText 的文案（'扫码 · 同款开局' / 'myxiaoyu.com'）来断言二维码数量。
 */

let textLog: string[] = []

function makeCtx() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fillText') return (text: string) => { textLog.push(String(text)) }
        if (prop === 'measureText') return (text: string) => ({ width: (String(text)?.length ?? 0) * 8 })
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} })
        }
        // 其余都当 no-op 方法
        return () => {}
      },
      set(_t, prop, val) {
        Object.defineProperty(_t, prop, { value: val, writable: true })
        return true
      },
    },
  )
}

function installDom() {
  textLog = []
  const win = { devicePixelRatio: 1 }
  const doc = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => makeCtx() }
      }
      return {}
    },
  }
  ;(globalThis as any).window = win
  ;(globalThis as any).document = doc
}

function makeState(sc: Scenario): GameState {
  return {
    scenarioId: sc.id,
    attributes: Object.fromEntries(sc.attributes.map((a) => [a.key, a.initial])),
    history: [],
    inventory: [],
  }
}

function customClone(sc: Scenario): Scenario {
  return { ...sc, id: 'customXY', title: 'Custom Scenario' }
}

describe('drawShareCard 二维码', () => {
  it('内置剧本：只画「同款开局」挑战码，不再画官网码', async () => {
    installDom()
    const sc = builtinScenarios.find((b) => b.id === 'xian') ?? builtinScenarios[0]
    await drawShareCard(sc, makeState(sc))
    expect(textLog.filter((t) => t === '扫码 · 同款开局')).toHaveLength(1)
    expect(textLog.includes('myxiaoyu.com')).toBe(false)
  })

  it('自定义/生成剧本：不画任何二维码（不出现官网码）', async () => {
    installDom()
    const sc = builtinScenarios.find((b) => b.id === 'xian') ?? builtinScenarios[0]
    await drawShareCard(customClone(sc), makeState(sc))
    expect(textLog.includes('扫码 · 同款开局')).toBe(false)
    expect(textLog.includes('myxiaoyu.com')).toBe(false)
  })
})
