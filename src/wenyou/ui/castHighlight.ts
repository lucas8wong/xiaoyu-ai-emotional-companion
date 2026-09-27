/**
 * 正文人名标注（纯函数）：把剧情正文按「人物志里已登记的人名」切成片段，
 * 命中片段带 name，UI 据此渲染成可点人名 → 点开该人物的人物卡。
 *
 * 为什么只认名册：模型在正文里写的字什么都可能有，若用正则去猜「像人名的词」会大面积误伤
 * （属性名、物品名、地名、称谓都会被标成可点）。只标「AI 已登记进人物志的名字」，
 * 才算『预设身份』这一定语的严格实现：能点开的，一定有卡。
 *
 * 规则：
 *  - 名字长度 ≥ 2 才参与匹配（单字称谓误伤率高）；同名去重；
 *  - 长名优先（「欧阳锋」先于「欧阳」）、且不重叠；
 *  - 同一名字在正文里出现多次则全部标出（点哪个都开同一张卡）；
 *  - 上限 MAX_HITS 次命中，防病态文本把 DOM 撑爆；
 *  - 拼接所有片段必然还原原文（有单测守护）。
 */

export interface CastSegment {
  text: string
  /** 命中的人名（仅命中片段有值） */
  name?: string
}

/** 单条正文最多标注的人名个数 */
export const MAX_CAST_HITS = 200

/** 名册清洗：去空、去重、剔除 1 字名，按长度降序（长名优先匹配） */
export function normalizeCastNames(names: string[]): string[] {
  const uniq = new Set<string>()
  for (const raw of names) {
    const n = (raw ?? '').trim()
    if (n.length >= 2) uniq.add(n)
  }
  return [...uniq].sort((a, b) => b.length - a.length)
}

export function splitByCast(text: string, names: string[]): CastSegment[] {
  const list = normalizeCastNames(names)
  if (!text) return []
  if (list.length === 0) return [{ text }]

  const segs: CastSegment[] = []
  let plain = ''
  let hits = 0
  let i = 0
  while (i < text.length) {
    let matched: string | null = null
    if (hits < MAX_CAST_HITS) {
      for (const n of list) {
        if (n.length <= text.length - i && text.startsWith(n, i)) {
          matched = n
          break
        }
      }
    }
    if (matched) {
      if (plain) {
        segs.push({ text: plain })
        plain = ''
      }
      segs.push({ text: matched, name: matched })
      hits++
      i += matched.length
    } else {
      plain += text[i]
      i++
    }
  }
  if (plain) segs.push({ text: plain })
  return segs
}
