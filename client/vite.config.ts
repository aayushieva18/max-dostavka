import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Render Static Site отдаёт сайт с корня (https://dostavka-app.onrender.com/),
  // в отличие от GitHub Pages — там путь был со вложенной папкой.
  base: '/',
})
