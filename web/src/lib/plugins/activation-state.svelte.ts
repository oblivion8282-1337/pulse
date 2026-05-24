/**
 * Persistierter Plugin-Activation-State — Settings-Registry-Section
 * `'plugins'`. Hält ein `activated: string[]` mit den Plugin-Namen, die
 * der User aktiviert hat; Loader (`loader.ts`) liest es beim Boot,
 * Settings-Panel (`SettingsPlugins.svelte`) schreibt es beim Toggle.
 *
 * Eigenes Modul, um eine Boot-Zyklus-Falle zu vermeiden: `registry.ts`
 * importiert `registerSettingsSection`, `loader.ts` würde sonst über
 * `registry.ts` importieren — hier liegt der State separat und beide
 * Seiten ziehen sich nur, was sie wirklich brauchen.
 *
 * Default `activated = ['hello']` — das Demo-Plugin bleibt nach dem
 * Upgrade auf Schritt 6 aktiviert (sonst würde der Hello-Smoketest
 * bei Bestandsinstallationen ohne UI-Touch lautlos abgeschaltet).
 */
import { registerSettingsSection } from '$lib/settings-registry';

interface PluginActivationSection {
  activated: string[];
}

// `hello` ist das Loader-Smoketest-Skelett (Schritt 4) und bleibt
// default-aktiv, damit Bestandsinstallationen den Smoketest sehen.
// `tamagotchi` (Schritt 7) ist absichtlich default AUS — Reviewer/User
// aktivieren das Reference-Plugin selbst im Plugin-Manager
// (`/Einstellungen → Plugins`). Der persistierte State überschreibt
// diesen Default beim nächsten Boot.
const DEFAULT_ACTIVATED = ['hello'];

const store = registerSettingsSection<PluginActivationSection>('plugins', {
  defaults: { activated: [...DEFAULT_ACTIVATED] },
  // Plugin-Wahl ist user-spezifisch → bei Sign-Out auf den nächsten User
  // zurücksetzen. Der nächste Login durchläuft den Bootstrap-Default neu.
  onSignOut: 'reset',
  version: 1,
  parse(raw) {
    if (raw && typeof raw === 'object' && 'activated' in raw) {
      const arr = (raw as { activated: unknown }).activated;
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        return { activated: [...new Set(arr as string[])] };
      }
    }
    return { activated: [...DEFAULT_ACTIVATED] };
  }
});

/** Ist dieses Plugin laut persistiertem State aktiviert? */
export function isPluginActivated(name: string): boolean {
  return store.value.activated.includes(name);
}

/** Returnt die aktuell aktivierten Plugin-Namen (Snapshot). */
export function listActivatedPlugins(): string[] {
  return [...store.value.activated];
}

/** Markiere Plugin als aktiviert (persistiert sofort). Idempotent. */
export function markPluginActivated(name: string): void {
  if (store.value.activated.includes(name)) return;
  store.replace({ activated: [...store.value.activated, name] });
}

/** Markiere Plugin als deaktiviert (persistiert sofort). Idempotent. */
export function markPluginDeactivated(name: string): void {
  if (!store.value.activated.includes(name)) return;
  store.replace({
    activated: store.value.activated.filter((n) => n !== name)
  });
}

/** Reaktiver Read-Only-Zugriff fürs UI. */
export const pluginActivation = {
  get activated(): readonly string[] {
    return store.value.activated;
  }
};
