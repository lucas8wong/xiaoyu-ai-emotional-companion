/**
 * 自动回看（原手动存档位的自动替代）容量策略单测：
 * 1) 同剧本自动回看超过上限 → 只保留最新若干条（最旧自动项被淘汰）；
 * 2) 全剧本总量超限 → 只淘汰最旧的自动项，旧手动存档永不因自动项被挤掉。
 * 纯函数测试，不触碰 localStorage / 网络。
 */
import { describe, expect, it } from 'vitest'
import { evictAutoSlots, type SaveGame, type SaveSlot } from './storage'

function game(scenarioId: string, turn: number): SaveGame {
  return {
    scenario: { id: scenarioId } as SaveGame['scenario'],
    state: { history: Array.from({ length: turn }, () => ({})) } as SaveGame['state'],
    pendingTurn: null,
  }
}

function auto(sid: string, turn: number, savedAt: number): SaveSlot {
  return { id: `a_${savedAt}`, name: '', savedAt, game: game(sid, turn), kind: 'key' }
}

function manual(savedAt: number, name = '旧存档'): SaveSlot {
  return { id: `m_${savedAt}`, name, savedAt, game: game('legacy', 1) }
}

describe('evictAutoSlots（自动回看容量控制）', () => {
  it('单剧本自动回看超过上限时只保留最新几条', () => {
    // 同一剧本 7 个自动点（savedAt 递增），上限 6
    const slots = Array.from({ length: 7 }, (_, i) => auto('s1', i + 1, 1000 + i))
    const out = evictAutoSlots(slots, 6, 50)
    expect(out.length).toBe(6)
    expect(out.some((s) => s.savedAt === 1000)).toBe(false) // 最旧被淘汰
    expect(out.every((s) => s.savedAt >= 1001)).toBe(true)
  })

  it('多个剧本各自独立保留，互不挤占', () => {
    const slots = [
      ...Array.from({ length: 7 }, (_, i) => auto('s1', i + 1, 1000 + i)),
      ...Array.from({ length: 3 }, (_, i) => auto('s2', i + 1, 2000 + i)),
    ]
    const out = evictAutoSlots(slots, 6, 50)
    const s1 = out.filter((s) => s.game.scenario.id === 's1')
    const s2 = out.filter((s) => s.game.scenario.id === 's2')
    expect(s1.length).toBe(6)
    expect(s2.length).toBe(3)
  })

  it('总量超限时只淘汰最旧自动项，旧手动存档不被挤掉', () => {
    // 3 个手动存档（全都很旧）+ 若干新自动点，总上限 8 → 自动只留 5 个，手动 3 个全保留
    const slots = [
      manual(1, '最早的手动存档'),
      manual(2, '手动存档'),
      manual(3, '手动存档'),
      ...Array.from({ length: 10 }, (_, i) => auto('s1', i + 1, 1000 + i)),
    ]
    const out = evictAutoSlots(slots, 6, 8)
    expect(out.filter((s) => !s.kind).length).toBe(3) // 手动原样保留
    expect(out.filter((s) => !!s.kind).length).toBe(5) // 自动被压到填满总量
    expect(out.length).toBe(8)
  })

  it('按 savedAt 降序返回', () => {
    const slots = [auto('s1', 1, 3000), auto('s1', 2, 1000), auto('s1', 3, 2000)]
    const out = evictAutoSlots(slots, 6, 50)
    expect(out.map((s) => s.savedAt)).toEqual([3000, 2000, 1000])
  })
})
