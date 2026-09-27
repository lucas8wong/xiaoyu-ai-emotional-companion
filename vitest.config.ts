import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// 复用 vite 的路径别名（@ → ./src）
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['src/wenyou/**/*.test.ts'],
    environment: 'node',
  },
})
