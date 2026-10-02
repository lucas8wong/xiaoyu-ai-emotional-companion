/**
 * 主题 token 成对不变量（2026-09-17 立）。
 *
 * 背景：Tailwind v3 的 `/透明度` 修饰符只认「能解析出颜色」的值。主题色写成裸 `var(--color-x)` 时，
 * `border-primary/30`、`bg-primary-lighter/60` 这类类会被**静默丢弃**（构建产物里根本不存在），
 * 全仓曾因此有 ~117 处描边/底色凭空消失（用户反馈的「引用块看不清」就是这个坑）。
 * 改用 `rgb(var(--color-x-rgb) / <alpha-value>)` 后，hex 变量与 RGB 通道**必须成对同改**，
 * 否则换皮肤时会出现「底色还是旧皮肤」的错配，而且不会有任何报错。
 *
 * 本测试守三条不变量：
 *  ① 每个 `--color-x: #hex` 在**同一个块里**有一条数值一致的 `--color-x-rgb: R G B`；
 *  ② 没有孤立的 `-rgb`（有通道没 hex）；
 *  ③ tailwind.config.js 里不再有裸 `var(--color-...)` 颜色；皮肤静态化脚本走 tokenPair（hex+通道一起出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hexToChannels = (hex: string): string => {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)].join(' ');
};

interface Block { selector: string; body: string[] }

/** 按大括号深度切块（这些变量块里没有嵌套规则，逐行扫描足够且不误伤 @media 等） */
function splitBlocks(css: string): Block[] {
  const out: Block[] = [];
  let depth = 0;
  let cur: Block | null = null;
  for (const line of css.split('\n')) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (depth === 0 && opens > 0) cur = { selector: line.replace('{', '').trim(), body: [] };
    if (depth >= 1 && cur) cur.body.push(line);
    depth += opens - closes;
    if (depth === 0 && cur) {
      if (cur.body.some((l) => l.trim().startsWith('--color-'))) out.push(cur);
      cur = null;
    }
  }
  return out;
}

for (const [file, minPairs] of [['src/index.css', 60], ['src/werewolf/theme.css', 13]] as const) {
  test(`${file}：--color-x 与 --color-x-rgb 成对且数值一致`, () => {
    const blocks = splitBlocks(fs.readFileSync(file, 'utf8'));
    assert.ok(blocks.length > 0, `${file} 应至少有一个含 --color-* 的变量块`);
    let pairs = 0;
    for (const block of blocks) {
      const hexes = new Map<string, string>();
      const rgbs = new Map<string, string>();
      for (const line of block.body) {
        const h = line.match(/^\s*--color-([a-z-]+):\s*(#[0-9A-Fa-f]{6})\s*;/);
        if (h && !h[1].endsWith('-rgb')) hexes.set(h[1], h[2]);
        const r = line.match(/^\s*--color-([a-z-]+)-rgb:\s*([0-9]{1,3} [0-9]{1,3} [0-9]{1,3})\s*;/);
        if (r) rgbs.set(r[1], r[2]);
      }
      for (const [name, hex] of hexes) {
        const got = rgbs.get(name);
        assert.ok(got, `${file} 的块「${block.selector}」里 --color-${name} 缺少配套的 --color-${name}-rgb（换皮肤会错配，且没有任何报错）`);
        assert.equal(got, hexToChannels(hex), `${file} 的块「${block.selector}」里 --color-${name}-rgb 与 hex 不一致：${hex} → 应为 ${hexToChannels(hex)}，实际 ${got}`);
        pairs++;
      }
      for (const name of rgbs.keys()) {
        assert.ok(hexes.has(name), `${file} 的块「${block.selector}」里有孤立的 --color-${name}-rgb（没有对应的 hex 变量）`);
      }
    }
    // 下限只是防「整块被删空」；真正的判据是上面逐对的一致性（index.css 5 个块共 66 对；
    // werewolf 主题 13 对，它有意不覆盖 --color-primary-text，沿用 :root 的那对）
    assert.ok(pairs >= minPairs, `${file} 至少应有 ${minPairs} 对颜色 token，实际 ${pairs}`);
  });
}

test('tailwind.config.js：颜色一律走 rgb(var(--color-x-rgb) / <alpha-value>)，不留裸 var()', () => {
  const cfg = fs.readFileSync('tailwind.config.js', 'utf8');
  const good = cfg.match(/rgb\(var\(--color-[a-z-]+-rgb\) \/ <alpha-value>\)/g) || [];
  assert.ok(good.length >= 14, `应有 ≥14 条 rgb(var(...) / <alpha-value>) 颜色，实际 ${good.length}`);
  // 裸 var(--color-x) 作颜色值 = /透明度 静默失效（这正是本次要根治的坑）
  const bad = cfg.match(/:\s*"var\(--color-[a-z-]+\)"/g) || [];
  assert.equal(bad.length, 0, `tailwind.config.js 里仍有裸 var() 颜色：${bad.join(', ')}`);
});

test('皮肤静态化：动态皮肤必须成对产出 hex + 通道', () => {
  const src = fs.readFileSync('api/services/skinStaticize.ts', 'utf8');
  assert.ok(src.includes('tokenPair('), 'skinStaticize 应使用 tokenPair 成对产出');
  assert.ok(!src.includes('--color-primary: ${primary}'), 'skinStaticize 不应再直接写裸 hex 变量（会缺 RGB 通道）');
});
