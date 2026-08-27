import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vite';

// Proxy-Ziele des Dev-Servers. Vorgabe sind die Ports des Dev-Stacks
// (`scripts/dev-up.fish`); die E2E-Suite startet ihren EIGENEN Vite mit
// gesetzten Variablen, damit sie auf ihre eigenen Dienste zeigt statt auf den
// laufenden Dev-Stack — sonst testete sie gegen die Dev-Datenbank statt gegen
// `dcc_test`. Die Portgruppe steht in `web/tests/e2e/_ports.ts`.
const AUTH_PORT = process.env.PULSE_API_AUTH_PORT || '8001';
const CHAT_PORT = process.env.PULSE_API_CHAT_PORT || '8002';
const VOICE_PORT = process.env.PULSE_API_VOICE_PORT || '8003';
const WEB_PORT = Number(process.env.PULSE_WEB_PORT) || 5173;

// `PULSE_API_ORIGIN=https://howispulse.com` — die Oberfläche dieses Zweigs
// gegen ein FERTIGES Backend fahren statt gegen lokale Dienste.
//
// **Wozu.** Ein Client lässt sich sonst nur prüfen, wenn der ganze Stack
// daneben läuft: Docker, Postgres, Redis, fünf Dienste, uv. Auf einer Maschine,
// die nur Node hat (etwa dem Windows-Rechner, auf dem der HQ-Sidecar gebaut
// wird), war die Oberfläche damit gar nicht auszuprobieren — und die
// verpackte App hilft nicht, die lädt die AUSGELIEFERTE Oberfläche aus der
// Cloud, nie die des Zweigs.
//
// **Warum der Präfix hier bleiben MUSS.** Im Dev-Stack zeigt jeder Eintrag auf
// einen Dienst direkt, deshalb schneidet `rewrite` das `/api/<dienst>` ab. Ein
// fertiges Backend steht dagegen hinter nginx, und das erwartet genau diesen
// Präfix und entfernt ihn selbst (`infra/prod/web-nginx.conf`). Mit dem
// Abschneiden käme `/login` statt `/api/auth/login` an — 404 für alles, und der
// Fehler sähe nach einem kaputten Backend aus statt nach einer falschen
// Weiterleitung.
//
// **Das ist ein Prüfwerkzeug, kein Betriebsweg.** Wer es setzt, meldet sich mit
// echten Zugangsdaten an einem echten Server an und wirkt auf echte Daten. Die
// Vorgabe bleibt unverändert der lokale Stack.
const API_ORIGIN = process.env.PULSE_API_ORIGIN;

/** Weiterleitung für einen `/api/<dienst>`-Zweig. */
function apiProxy(port: string, opts: { ws?: boolean } = {}) {
  if (API_ORIGIN) {
    // Kein `rewrite`: der Präfix gehört zum Ziel (s.o.). `ws://` bzw. `wss://`
    // leitet Vite für aufgerüstete Verbindungen selbst ab.
    return { target: API_ORIGIN, changeOrigin: true, secure: true, ...opts };
  }
  const schema = opts.ws ? 'ws' : 'http';
  return { target: `${schema}://127.0.0.1:${port}`, changeOrigin: true, ...opts };
}

// Die Dateien des manuellen Self-Host-Pfads im Dev bedienen. In Produktion
// kopiert sie `web/Dockerfile` ins nginx-Wurzelverzeichnis und
// `web-nginx.conf` liefert sie unter `/self-host/` aus — Vite kennt nur
// `web/`, dort liefen die Download-Knöpfe im Einrichtungs-Dialog also gegen
// 404, und das sähe nach einem kaputten Knopf aus statt nach einer fehlenden
// Dev-Weiche. Die Zuordnung spiegelt den Dockerfile-COPY; wer dort eine Datei
// ergänzt, ergänzt sie hier mit (sonst ist sie nur in Produktion prüfbar).
const SELF_HOST_DATEIEN: Record<string, string> = {
  'docker-compose.yml': '../infra/self-host/docker-compose.yml',
  'docker-compose.behind-proxy.yml': '../infra/self-host/docker-compose.behind-proxy.yml',
  'env.example': '../infra/self-host/.env.example',
  guide: '../docs/SELF_HOST.md'
};

/** Dev-Weiche für `/self-host/*` — in Produktion macht das nginx. */
function selfHostDateien() {
  return {
    name: 'pulse-self-host-dateien',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(
        (req: { url?: string }, res: Record<string, never>, next: () => void) => {
          const name = req.url?.match(/^\/self-host\/([^?]+)/)?.[1];
          const quelle = name ? SELF_HOST_DATEIEN[name] : undefined;
          if (!quelle) return next();
          const antwort = res as unknown as {
            setHeader: (k: string, v: string) => void;
            end: (body: string) => void;
          };
          antwort.setHeader('Content-Type', 'text/plain; charset=utf-8');
          antwort.end(readFileSync(new URL(quelle, import.meta.url), 'utf-8'));
        }
      );
    }
  };
}

export default defineConfig({
  plugins: [
    selfHostDateien(),
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
    port: WEB_PORT,
    host: '127.0.0.1',
    // NIE still auf den nächsten freien Port ausweichen. Der Port wird von
    // außen fest adressiert — Playwright über `baseURL`, die Electron-Dev-App
    // über `PULSE_DEV_URL`, `dev-up.fish` über seine Bereitschaftsprüfung.
    // Weicht Vite auf 5174 aus, lädt keiner von ihnen mehr etwas, und der
    // Fehler steht nirgends. Belegt ist der Port lieber laut als heimlich.
    strictPort: true,
    watch: {
      // `pnpm build` schreibt nach `web/build/` — im Watcher löste jeder
      // Produktions-Build dort Datei-Ereignisse und damit ein volles
      // Neuladen der laufenden Dev-Sitzung aus (`page reload build/index.html`).
      // Build-Ausgaben gehören nie in den Dev-Watcher.
      ignored: ['**/build/**', '**/.svelte-kit/output/**']
    },
    proxy: {
      '/api/auth': {
        ...apiProxy(AUTH_PORT),
        ...(API_ORIGIN ? {} : { rewrite: (p: string) => p.replace(/^\/api\/auth/, '') })
      },
      '/api/chat': {
        ...apiProxy(CHAT_PORT),
        ...(API_ORIGIN ? {} : { rewrite: (p: string) => p.replace(/^\/api\/chat/, '') })
      },
      '/api/voice': {
        ...apiProxy(VOICE_PORT),
        ...(API_ORIGIN ? {} : { rewrite: (p: string) => p.replace(/^\/api\/voice/, '') })
      },
      '/api/ws': {
        ...apiProxy(CHAT_PORT, { ws: true }),
        ...(API_ORIGIN ? {} : { rewrite: (p: string) => p.replace(/^\/api\/ws/, '') })
      }
    }
  }
});
