import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: 'index.html',
      strict: false
    }),
    alias: {
      $lib: './src/lib'
    },
    // Pulse deployt das Web-Bundle häufig (push → CI → pulse_web, sofort live).
    // pollInterval > 0 lässt SvelteKit `_app/version.json` im Hintergrund
    // pollen; weicht die deployte Version von der laufenden ab, wird der
    // `updated`-Store true → +layout.svelte zeigt einen „Neu laden"-Toast.
    // Greift in Browser UND Electron (beide laden dieselbe Remote-App).
    version: {
      pollInterval: 60_000
    }
  }
};

export default config;
