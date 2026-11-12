import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // better-sqlite3 is a native module and must stay external.
      externalizeDeps: true,
      // Vite cannot tell out/ is inside the project when the drive letter's case differs (Windows).
      emptyOutDir: true
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      emptyOutDir: true
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()]
  }
})
