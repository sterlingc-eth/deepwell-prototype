import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Four pages: the marketing site at /, the app at /app/, the lite field app
// (installable PWA) at /m/, and the standalone founders' business-expense
// site at /expenses/ (not linked from the app)
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        site: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html'),
        mobile: resolve(__dirname, 'm/index.html'),
        expenses: resolve(__dirname, 'expenses/index.html'),
      },
    },
  },
})
