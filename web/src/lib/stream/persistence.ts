/**
 * Streaming-Settings-Persistenz (T3c; Electron-Pfad seit E1c).
 *
 * Zwei-Wege-Wrapper: in der Electron-App schreibt/liest `window.pulse.store.*`
 * (im Main-Prozess: ein hand-rolled JSON-Store, `<userData>/pulse-stream.json`,
 * auf Linux chmod 700 fürs Dir / chmod 600 fürs File — siehe
 * `desktop/electron/store.ts`; das war früher die Tauri-`plugin-store`- +
 * `harden_config_dir()`-Logik). Im reinen Browser (Dev-Route `/app/dev/stream`,
 * oder die SvelteKit-App ohne Electron-Shell) fällt der Code auf `localStorage`
 * zurück (gleiche Keys, gleiche JSON-Form).
 *
 * Schreibverhalten: alle Mutations im Settings-Modul laufen über eine debouncede
 * `saveAll()` (300 ms — siehe `settings.svelte.ts`). Unter Electron wird jeder
 * Key einzeln per `store.set()` geschrieben (der Main-Store persistiert das File
 * synchron bei jedem `set`); im Browser-Fallback re-serialisieren wir den ganzen
 * Blob einmal.
 *
 * **Sicherheits-Hinweis:** Custom-Server-Stream-Keys landen hier im Klartext.
 * Auf Linux ist das durch chmod 600 (Electron-Store-File) bzw. den Browser-Origin
 * (localStorage) abgesichert; auf shared Boxen ist das *kein* Secret-Vault.
 * Wer mehr braucht: OS-Keyring — für den lokalen Dev-Stream-Pfad reicht das hier.
 * Niemals in `console.log` schreiben.
 */

import { isElectron } from '$lib/platform/runtime';
import type { PulseStoreApi } from '$lib/platform/pulse';

/** localStorage-Key für den Browser-Fallback (single blob mit derselben Form). */
const LS_KEY = 'pulse.stream';

/** The Electron-side store, or `null` in a plain browser. */
function electronStore(): PulseStoreApi | null {
  if (!isElectron()) return null;
  return (typeof window !== 'undefined' && window.pulse?.store) || null;
}

/** Read all persisted keys as a record (or `{}` when nothing persisted/usable). */
export async function loadAll(): Promise<Record<string, unknown>> {
  const store = electronStore();
  if (store) {
    try {
      const all = await store.getAll();
      return all && typeof all === 'object' ? all : {};
    } catch {
      return {};
    }
  }
  // Browser-Fallback: single JSON blob unter LS_KEY.
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Write a batch of keys. Under Electron this uses the atomic `store:setAll`
 * IPC handler (one serialised write, no parallel rename races — finding 158).
 * Falls back to individual `store.set()` calls if `setAll` is not exposed by
 * the preload (older builds). Under the browser-fallback we re-serialise the
 * whole blob once. Failures are swallowed (the UI keeps the in-memory state
 * regardless of whether persistence succeeded).
 */
/**
 * Jeden Wert in ein einfaches, klonbares Objekt überführen — **Pflicht vor der
 * Electron-IPC**.
 *
 * Ein Svelte-5-`$state`-Feld ist ein Proxy, und der structured-clone-Algorithmus
 * hinter `ipcRenderer.invoke` kann Proxys nicht kopieren („An object could not
 * be cloned"). Der Wurf landete bisher im `catch` unten, der Renderer behielt
 * seinen Stand im Speicher und wirkte richtig — bis zum nächsten Start. Am
 * 2026-08-16 hat das drei Speicher der Standplatz-Geräte gekostet (Eintragung,
 * Protokoll, Übertragungs-Profil); dass die Dauerfreigabe überlebte, lag allein
 * daran, dass sie vor dem Speichern zufällig ein einfaches Objekt baut.
 *
 * **Hier und nicht bei den Rufern**, obwohl `$state.snapshot()` dasselbe täte:
 * jeder künftige Rufer fiele sonst in dieselbe Grube, und ein vergessener
 * Aufruf sieht bis zum Neustart aus wie „funktioniert". Der JSON-Umweg ist
 * zudem ehrlich zum Ziel — die Datei ist JSON, was ihn nicht übersteht, wäre
 * ohnehin nicht persistierbar.
 */
function klonbar(values: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  } catch {
    // Zyklen oder BigInt — dann lieber das Original versuchen als gar nichts.
    return values;
  }
}

export async function saveAll(values: Record<string, unknown>): Promise<void> {
  const store = electronStore();
  if (store) {
    values = klonbar(values);
    try {
      // Prefer the atomic batch handler (eliminates parallel rename races).
      // `setAll` is declared on PulseStoreApi; the runtime check keeps older
      // preloads (that predate it) working.
      if (typeof store.setAll === 'function') {
        await store.setAll(values);
      } else {
        // Legacy fallback: sequential (not parallel) to avoid rename races.
        for (const [k, v] of Object.entries(values)) {
          await store.set(k, v);
        }
      }
    } catch (e) {
      // Tolerieren — der Stand im Speicher gilt weiter. Aber NICHT stumm: das
      // stille Schlucken hat die drei verlorenen Standplatz-Speicher oben eine
      // Fehlersuche gekostet, in der alles richtig aussah. Nur die Schlüssel
      // nennen, nie die Werte (Stream-Keys, s. Kopf dieser Datei).
      console.warn('[persistence] saveAll fehlgeschlagen für:', Object.keys(values), e);
    }
    return;
  }
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const merged = { ...existing, ...values };
    localStorage.setItem(LS_KEY, JSON.stringify(merged));
  } catch {
    // tolerate quota / parse failures
  }
}

/**
 * Account-Switch-Defensive: leert den Legacy-`custom_servers`-Eintrag (Custom-
 * RTMP-Ziele samt Klartext-Stream-Keys aus der Tauri-Ära). Der heutige
 * Channel-Mode-Stream-Pfad schreibt diesen Key nicht mehr (siehe
 * `stream/settings.svelte.ts` → `PERSIST_KEYS`), aber ein von einer alten
 * Version migrierter `pulse-stream.json` kann ihn noch tragen. Beim Wechsel des
 * Geräte-Besitzers wird er geleert, damit der nächste User am selben Rechner
 * keine Stream-Keys des Vorgängers erbt. Die gerätspezifischen Capture-
 * Präferenzen (Codec, Quelle, Audio) bleiben — sie tragen keine Secrets.
 *
 * Greift über die vorhandene `saveAll`-Maschinerie in beiden Umgebungen:
 * Electron schreibt via `store:setAll`-IPC in `pulse-stream.json`, der Browser
 * merged in den `pulse.stream`-localStorage-Blob.
 */
export async function clearLegacyStreamCredentials(): Promise<void> {
  await saveAll({ custom_servers: [] });
}

/** Simple debounce — schedule a single async call after `delayMs` of quiet. */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  delayMs: number,
): (...args: Args) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      void fn(...args);
    }, delayMs);
  };
}
