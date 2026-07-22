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
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
      // Eine Datei pro Sprache statt einer pro Nachricht. Der Default
      // ('message-modules') erzeugte 2630 Einzelmodule; da `messages.js` sie
      // per `export *` sammelt und praktisch jede Komponente daraus
      // importiert, holte der Browser im DEV-Modus alle 2630 einzeln — der
      // Grund, warum das Electron-Dev-Fenster ewig zum Laden brauchte (der
      // Prod-Build bündelt sie, war deshalb nie betroffen). Paraglide
      // empfiehlt diese Struktur selbst für große Projekte im Dev.
      // MUSS mit dem `--output-structure`-Flag in `package.json`
      // (`paraglide:compile`) übereinstimmen — das läuft in `predev`/`check`
      // und würde sonst wieder Einzelmodule schreiben.
      outputStructure: 'locale-modules'
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
    rollupOptions: {
      // PLUGIN_TIMINGS-Diagnose von rolldown (Vite 8) abschalten: der
      // Zeitfresser ist `vite-plugin-sveltekit-guard` (SvelteKit-intern,
      // nicht von uns beeinflussbar) — die Warnung ist rein informativ und
      // rauscht sonst bei jedem Build. Siehe rolldown.rs/options/checks.
      checks: { pluginTimings: false }
    }
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    watch: {
      // `pnpm build` schreibt nach `web/build/` — im Watcher löste jeder
      // Produktions-Build dort Datei-Ereignisse und damit ein volles
      // Neuladen der laufenden Dev-Sitzung aus (`page reload build/index.html`).
      // Build-Ausgaben gehören nie in den Dev-Watcher.
      ignored: ['**/build/**', '**/.svelte-kit/output/**']
    },
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
