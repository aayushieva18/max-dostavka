import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages отдаёт сайт по адресу вида
  // https://<логин>.github.io/max-dostavka/ — без этой настройки ссылки на
  // файлы (JS/CSS) внутри собранной страницы будут неправильными.
  base: '/max-dostavka/',
})
