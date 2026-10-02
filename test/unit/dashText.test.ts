import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteEmDashLine, stripEmDash } from '../../src/lib/dashText.js'

test('装饰性分隔：注释整行 → 【】', () => {
  assert.equal(rewriteEmDashLine('// —— 中途死亡（死亡级）——'), '// 【中途死亡（死亡级）】')
  assert.equal(rewriteEmDashLine('  * —— 主流程 ——'), '  * 【主流程】')
  assert.equal(rewriteEmDashLine('/* —— 工具函数 —— */'), '/* 【工具函数】 */')
})

test('长横线串先收敛：装饰标题不在 【】 里留半截横线', () => {
  assert.equal(rewriteEmDashLine('// —————— 汇总 ——————'), '// 【汇总】')
  assert.equal(rewriteEmDashLine('// ——— 四个核心突破机缘事件 ———'), '// 【四个核心突破机缘事件】')
})

test('装饰性分隔：整个字符串 → · X ·', () => {
  assert.equal(rewriteEmDashLine("  orSayDirectly: '—— 或直接说 ——',"), "  orSayDirectly: '· 或直接说 ·',")
})

test('行首 / 行尾单个装饰被去掉', () => {
  assert.equal(rewriteEmDashLine('// —— 保证 sitemap 一次请求直达'), '// 保证 sitemap 一次请求直达')
  assert.equal(rewriteEmDashLine('// 这一条只做一件事 ——'), '// 这一条只做一件事')
})

test('解释 / 列举 → 冒号', () => {
  assert.equal(
    rewriteEmDashLine('小愈会用你熟悉的地区语气陪你——粤语、东北、京津、川渝等。'),
    '小愈会用你熟悉的地区语气陪你：粤语、东北、京津、川渝等。',
  )
})

test('极短独立答句 → 句号', () => {
  assert.equal(rewriteEmDashLine('不是——小愈是陪伴，不是治疗。'), '不是。小愈是陪伴，不是治疗。')
  assert.equal(rewriteEmDashLine('有——小愈还提供角色扮演剧本。'), '有。小愈还提供角色扮演剧本。')
})

test('默认 → 逗号', () => {
  assert.equal(
    rewriteEmDashLine('你要在这片崩坏的土地上活下去——并从瓦砾里亲手重建。'),
    '你要在这片崩坏的土地上活下去，并从瓦砾里亲手重建。',
  )
})

test('一行里多处：各自按功能判定', () => {
  assert.equal(
    rewriteEmDashLine("a: '小愈会记住对你重要的事——你在意的、特别的时刻——让每次对话都能接续。'"),
    "a: '小愈会记住对你重要的事：你在意的、特别的时刻，让每次对话都能接续。'",
  )
})

test('英文行收成单个 em dash', () => {
  assert.equal(rewriteEmDashLine('The key——and the only one——is trust.'), 'The key—and the only one—is trust.')
  assert.equal(stripEmDash('The key——is trust.'), 'The key—is trust.')
})

test('没有破折号的行原样返回', () => {
  assert.equal(rewriteEmDashLine('const a = 1'), 'const a = 1')
})

test('stripEmDash：中文换逗号、英文换单破折号、幂等', () => {
  assert.equal(stripEmDash('他说——别急'), '他说，别急')
  assert.equal(stripEmDash('wait——go'), 'wait—go')
  assert.equal(stripEmDash(stripEmDash('他说——别急')), '他说，别急')
  assert.equal(stripEmDash(''), '')
})
