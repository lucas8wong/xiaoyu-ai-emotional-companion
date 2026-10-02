import { useMemo } from 'react';
import { parseRoleplayText, type RpSegment } from '../lib/roleplayText';

/**
 * 剧情文本「内容类型」渲染器（2026-09）
 *
 * 把 `parseRoleplayText` 切出的三类片段上成三档视觉：
 * - **对白** = 唯一带容器的一档（"说出来的话"）：**独占一行 → 台词卡**
 *   （墨色 12% 浅底 + 品牌色 60% 左竖线 + 圆角）；**夹在句中 → 只保留引号着色 + 500 字重**
 *   （不铺底：把一句话切成色块反而更难读）；
 * - **旁白/动作/环境** = 基准层：不加任何装饰，用气泡自身的字色与字号；
 * - **心声/神态**（括号） = 安静的注解：只有 `0.94em` + 括号符淡色，不铺底、不加竖线
 *   （独占一行仍是块级，但只是为了保持行结构，不带来任何容器）。
 *
 * 2026-09-17 用户口径：「高亮的应该是对白而不是心声」，此前容器给的是心声（视觉上"被框起来的"
 * 是心里话），本轮把容器**搬给对白**，两档互换而非叠加。
 *
 * 为什么**不**给对白整段上品牌色文字（也评估过）：① 颜色会变成唯一强通道
 * （WCAG G182 / Section 508「感官特征」要求陪第二条通道）；② zen 皮肤的
 * `--color-primary-text`(#2F463B) 与 `--color-fg`(#2E2B25) 几乎同色 → 该案在 zen 下是**静默 no-op**
 * （`temp/rp-highlight-options/options-zen.png` 目视确认）→ 容器方案逐皮肤一致，更稳。
 *
 * 为什么底色用**墨色 12%** 而不是品牌色：上一轮像素实测已证明品牌色底在 zen（暖米纸）发冷发脏、
 * 在 candy（粉紫底）与背景同色系而"融掉"；本轮第一版 A 案用品牌色 7%，candy 下果然糊掉
 * （`options-candy.png` 前后对比可见）。三档**同墨色**（最差 5.47:1 ≥ AA），区分全部落在
 * 字重 / 字阶 / 底色 / 竖线 / 引号着色这些**不牺牲可读性**的通道上。
 *
 * 三条设计红线（详见 `src/index.css` 的 `.rp-*` 段与 `CHANGELOG.md` 2026-09-16 / 09-17）：
 * 1. **不靠颜色单独承载信息**：每类至少两个通道（颜色 + 字重 / 字阶 / 底色 / 竖线）；
 * 2. **中文不上斜体**：本项目 `index.css` 设了 `font-synthesis: none`，`italic` 对中文
 *    是个**静默 no-op**，所以斜体只作为**英文界面**的附加通道（`ITALIC_LANGS`）；
 * 3. **只用皮肤 token 派生**（`healing / zen / star / candy` 四套皮肤）：颜色一律走
 *    `var(--color-*)` + `color-mix()`，禁止硬编码灰/绿，否则四套皮肤里必有一套翻车。
 *
 * ⚠️ 这是**纯展示层**：不改 `m.content`，复制 / 落盘 / 长图分享 / TTS 一律仍取原文。
 */
const ITALIC_LANGS = new Set(['en']);

export interface RoleplayRichTextProps {
  text: string;
  /** 界面语言（'zh' | 'zh-TW' | 'en'），只用来决定要不要上斜体 */
  lang?: string;
}

function renderSegment(seg: RpSegment, key: number, italic: boolean) {
  if (seg.type === 'narration') {
    // 基准层：直接出文本，不加 span（既省 DOM，也保证与旧渲染逐字符一致）
    return <span key={key} data-rp="narration">{seg.text}</span>;
  }

  if (seg.type === 'dialogue') {
    return (
      <span
        key={key}
        data-rp="dialogue"
        data-rp-block={seg.block ? '1' : undefined}
        className={'rp-dialogue ' + (seg.block ? 'rp-dialogue-block' : 'rp-dialogue-inline')}
      >
        {seg.open ? <span className="rp-quote-mark">{seg.open}</span> : null}
        {seg.inner ?? seg.text}
        {seg.close ? <span className="rp-quote-mark">{seg.close}</span> : null}
      </span>
    );
  }

  const cls = 'rp-thought ' + (seg.block ? 'rp-thought-block' : 'rp-thought-inline') + (italic ? ' rp-thought-italic' : '');
  return (
    <span key={key} data-rp="thought" data-rp-block={seg.block ? '1' : undefined} className={cls}>
      {seg.open ? <span className="rp-thought-mark">{seg.open}</span> : null}
      {seg.inner ?? seg.text}
      {seg.close ? <span className="rp-thought-mark">{seg.close}</span> : null}
    </span>
  );
}

export default function RoleplayRichText({ text, lang }: RoleplayRichTextProps) {
  const segs = useMemo(() => parseRoleplayText(text), [text]);
  const italic = !!lang && ITALIC_LANGS.has(lang);
  return <>{segs.map((seg, i) => renderSegment(seg, i, italic))}</>;
}
