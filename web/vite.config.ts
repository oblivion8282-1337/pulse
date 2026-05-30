import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    // i18n (Paraglide). baseLocale=de (Quelle), Ziel=en. Kompiliert die
    // messages/*.json nach src/lib/paraglide (auto-gitignored). Strategie:
    // manuelle Wahl (localStorage) → Browser-Sprache → Fallback. Die genaue
    // „de sonst en"-Logik macht zusätzlich $lib/i18n.ts beim Start.
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale']
    })
  ],
  build: {
    // `AudioWorklet.addModule()` braucht eine echte URL. Vite inlined per
    // Default kleine Assets als `data:`-base64-URL (Limit 4 KB) — Chromium
    // lehnt das fürs Worklet-Loading ab („Unable to load a worklet's
    // module"). `@sapphi-red/web-noise-suppressor`'s noiseGate-Worklet ist
    // klein genug für diesen Pfad und kippte die Rauschunterdrückung im
    // Prod-Build (Dev funktionierte, weil Vite dort jede Datei separat
    // ausliefert). Erzwinge eine separate Datei für alle Worklet-Prozessoren.
    assetsInlineLimit(filePath) {
      if (filePath.endsWith('workletProcessor.js')) return false;
      return undefined;
    },
  },
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
      '/api/voice': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/voice/, '')
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
