/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // ⚠️ wolfcha 子应用由 **Tailwind v4 单独编译**成 public/wolfcha.css，
    // 不能让项目自己的 v3 再为它生成一遍工具类：同一个 class 被 v3 与 v4 各生成一次，
    // 例如 translate-x-[-50%] —— v3 产出 transform、v4 产出 translate 属性，
    // 两者叠加会把弹窗平移两次、推出屏幕（手机端实测左边缘 -172px）。
    "!./src/wolfcha/**",
  ],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        // —— 混合主题：黏土风 × 有机自然 × 活力撞色 ——
        // 全部引用 CSS 变量（RGB 三通道版），切换皮肤（<html data-skin>）即可全局重着色。
        //
        // ⚠️ 为什么必须是 `rgb(var(--color-x-rgb) / <alpha-value>)` 而不是 `var(--color-x)`（2026-09-17 定案）：
        //    Tailwind v3 的 `/透明度` 修饰符要先解析出颜色（asColor → withAlphaValue → parseColor），
        //    裸 `var()` 解析不出来 → 该 class **静默丢弃**（`border-primary/30`、`bg-primary/10` 全都不生成，
        //    构建产物里搜不到；只有真颜色如 bg-white/70 才有）。全仓曾因此有 ~117 处描边/底色凭空消失。
        //    现在 hex 变量（--color-x）与通道变量（--color-x-rgb）**成对定义**在每个皮肤块里（src/index.css），
        //    并有单测 `themeTokens.test.ts` 守着两行同步——改色时两个都要改。
        primary: {
          DEFAULT: "rgb(var(--color-primary-rgb) / <alpha-value>)",   // 草木绿（主色/CTA）
          strong: "rgb(var(--color-primary-strong-rgb) / <alpha-value>)",    // 深绿
          text: "rgb(var(--color-primary-text-rgb) / <alpha-value>)",      // 品牌色文字档（浅底上的品牌色文字用）
          soft: "rgb(var(--color-primary-soft-rgb) / <alpha-value>)",      // 薄荷
          lighter: "rgb(var(--color-primary-lighter-rgb) / <alpha-value>)",   // 淡薄荷
        },
        accent: {
          DEFAULT: "rgb(var(--color-accent-rgb) / <alpha-value>)",
          soft: "rgb(var(--color-accent-soft-rgb) / <alpha-value>)",
        },
        clay: {
          bg: "rgb(var(--color-bg-rgb) / <alpha-value>)",        // 暖奶油底
          surface: "rgb(var(--color-surface-rgb) / <alpha-value>)", // 卡片面（狼人杀复古主题下是深色面）
          border: "rgb(var(--color-border-rgb) / <alpha-value>)",    // 薄荷描边
          muted: "rgb(var(--color-muted-rgb) / <alpha-value>)",     // 暖沙面
        },
        ink: {
          DEFAULT: "rgb(var(--color-fg-rgb) / <alpha-value>)",   // 深森绿（正文）
          soft: "rgb(var(--color-muted-fg-rgb) / <alpha-value>)",      // 弱化文字
        },
        ring: "rgb(var(--color-ring-rgb) / <alpha-value>)",
      },
      fontFamily: {
        display: ['var(--skin-display-font)', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'sans-serif'],
        body: ['"Nunito Sans"', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'sans-serif'],
      },
      boxShadow: {
        // 黏土双阴影：色块 + 柔投影
        soft: "0 3px 0 -1px rgba(36, 59, 46, 0.12), 0 12px 24px -10px rgba(36, 59, 46, 0.16)",
        lift: "0 5px 0 -1px rgba(36, 59, 46, 0.14), 0 18px 34px -12px rgba(36, 59, 46, 0.22)",
        inner: "inset 0 1px 2px rgba(36, 59, 46, 0.06)",
      },
      borderRadius: {
        "2.5xl": "1.25rem",
        "3.5xl": "1.75rem",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blob: {
          "0%, 100%": { transform: "translate(0,0) scale(1)" },
          "33%": { transform: "translate(12px,-10px) scale(1.06)" },
          "66%": { transform: "translate(-8px,8px) scale(0.96)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.35s ease-out both",
        blob: "blob 14s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
