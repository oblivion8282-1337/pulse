import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api/auth': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/auth/, '')
      },
      '/api/chat': {
        target: 'http://127.0.0.1:8002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/chat/, '')
      },
      '/api/ws': {
        target: 'ws://127.0.0.1:8002',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ws/, '')
      }
    }
  }
});
