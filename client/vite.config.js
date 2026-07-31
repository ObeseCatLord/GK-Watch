import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './vitest.setup.js',
    globals: true
  },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    strictPort: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        secure: false
      }
    }
  }
})
