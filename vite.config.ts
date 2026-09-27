import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import path from 'node:path'

// wolfcha 子应用的别名根（Vite 从项目根启动，用 cwd 拼绝对路径最稳）
const wolfcha = path.resolve(process.cwd(), 'src/wolfcha')

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    // 显式配死，不依赖 vite-tsconfig-paths 对 `~` 的解析（它没解析出来，导致 Rollup 找不到模块）
    alias: [
      // 上游原本用 `@/`，已批量改写成 `~/`，避免与我们自己的 `@/*`（→ src/*）冲突
      { find: /^~\//, replacement: wolfcha + '/' },
      // Next.js 专有 API → 本地 shim
      { find: /^next\/link$/, replacement: path.join(wolfcha, 'shims/next/link.tsx') },
      { find: /^next\/image$/, replacement: path.join(wolfcha, 'shims/next/image.tsx') },
      { find: /^next\/navigation$/, replacement: path.join(wolfcha, 'shims/next/navigation.ts') },
      { find: /^next\/script$/, replacement: path.join(wolfcha, 'shims/next/script.tsx') },
      { find: /^next\/dynamic$/, replacement: path.join(wolfcha, 'shims/next/dynamic.tsx') },
      { find: /^next\/font/, replacement: path.join(wolfcha, 'shims/next/font.ts') },
      { find: /^next\/server$/, replacement: path.join(wolfcha, 'shims/next/server.ts') },
      { find: /^next\/headers$/, replacement: path.join(wolfcha, 'shims/next/server.ts') },
      // 按用户要求：密钥与登录用小愈自己的 → 上游这些一律打桩
      { find: /^@vercel\/analytics$/, replacement: path.join(wolfcha, 'shims/stubs/vercel-analytics.ts') },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    tsconfigPaths(),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      }
    }
  }
})
