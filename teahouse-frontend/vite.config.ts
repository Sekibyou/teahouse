import path from "path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND_TARGET = process.env.VITE_PROXY_TARGET || "http://127.0.0.1:8000"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 暴露到局域网,手机等设备可通过 http://<局域网IP>:5173 访问
    port: 5173,
    proxy: {
      // 把后端接口同源转发,手机/电脑访问 5173 时浏览器无需跨域、无需知道后端地址
      "/api": { target: BACKEND_TARGET, changeOrigin: true },
      "/v1": { target: BACKEND_TARGET, changeOrigin: true },
      "/events": { target: BACKEND_TARGET, changeOrigin: true, ws: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
