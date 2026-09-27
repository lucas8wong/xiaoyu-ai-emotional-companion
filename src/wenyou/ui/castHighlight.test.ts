import { describe, it, expect } from 'vitest'
import { splitByCast, normalizeCastNames, MAX_CAST_HITS } from './castHighlight'

const join = (segs: ReturnType<typeof splitByCast>) => segs.map((s) => s.text).join('')

describe('normalizeCastNames', () => {
  it('去空、去重、剔除单字名，并按长度降序（长名优先）', () => {
    expect(normalizeCastNames(['柳如烟', '', '   ', '柳', '柳如烟', '王掌柜'])).toEqual(['柳如烟', '王掌柜'])
  })
})

describe('splitByCast（正文人名标注）', () => {
  it('标出正文里的人名，其余原样，且拼接还原原文', () => {
    const text = '你推门进去，柳如烟正坐在窗边，抬眼看了你一眼。'
    const segs = splitByCast(text, ['柳如烟'])
    expect(segs).toEqual([
      { text: '你推门进去，' },
      { text: '柳如烟', name: '柳如烟' },
      { text: '正坐在窗边，抬眼看了你一眼。' },
    ])
    expect(join(segs)).toBe(text)
  })

  it('同一名字出现多次全部标出（点哪个都开同一张卡）', () => {
    const segs = splitByCast('王掌柜笑了。王掌柜又说了一句。', ['王掌柜'])
    expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['王掌柜', '王掌柜'])
    expect(join(segs)).toBe('王掌柜笑了。王掌柜又说了一句。')
  })

  it('长名优先且不重叠：先标「欧阳锋」，不把「欧阳」再标一遍', () => {
    const segs = splitByCast('欧阳锋站在崖上。', ['欧阳', '欧阳锋'])
    expect(segs.filter((s) => s.name)).toHaveLength(1)
    expect(segs.find((s) => s.name)?.name).toBe('欧阳锋')
  })

  it('名册外的字一律不标（不会把「师姐」「生命」这种词误标）', () => {
    const segs = splitByCast('师姐说你的生命只剩三成，青云门也保不住你。', ['柳如烟'])
    expect(segs).toEqual([{ text: '师姐说你的生命只剩三成，青云门也保不住你。' }])
  })

  it('名册为空 / 空正文：原样返回，不抛错', () => {
    expect(splitByCast('正文', [])).toEqual([{ text: '正文' }])
    expect(splitByCast('', ['柳如烟'])).toEqual([])
    expect(splitByCast('正文', ['柳', ' x '])).toEqual([{ text: '正文' }])
  })

  it('单字名不参与匹配（避免「李」「王」这种字被误标）', () => {
    const segs = splitByCast('李大人来了。', ['李'])
    expect(segs).toEqual([{ text: '李大人来了。' }])
  })

  it('命中数受上限保护', () => {
    const segs = splitByCast('柳如烟'.repeat(MAX_CAST_HITS + 20), ['柳如烟'])
    expect(segs.filter((s) => s.name)).toHaveLength(MAX_CAST_HITS)
    expect(join(segs)).toBe('柳如烟'.repeat(MAX_CAST_HITS + 20))
  })
})
