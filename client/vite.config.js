import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // 相对路径：部署在 /cangshu-web 这类子路径下也能正确加载资源
  base: './',
  plugins: [
    vue(),
    // 仅开发模式注入连通性自检脚本，不进生产包
    {
      name: 'inject-selfcheck',
      transformIndexHtml: {
        order: 'pre',
        handler(html, ctx) {
          if (!ctx.server) return html
          return html.replace(
            '</head>',
            `<script type="module" src="/selfcheck.js"></script></head>`
          )
        },
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // CloudBase 静态托管单文件上限 50MB，远高于此；设 1MB 提前发现异常
    chunkSizeWarningLimit: 1024,
  },
})
