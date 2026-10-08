<!--
  Sichtbarer Verbindungs-Hinweis (iOS-Liste Punkt 37).

  **Bewusst KEIN blockierendes Deckblatt**, obwohl die Liste „Offline-
  Deckblatt" sagt. Ein Deckel über einer Chat-App nimmt dem Nutzer, was auch
  ohne Netz funktioniert: den Verlauf lesen, eine Antwort tippen, in einen
  anderen Kanal wechseln. Ein Streifen sagt dasselbe, ohne etwas wegzunehmen —
  und er sagt es DEUTLICH, was der eigentliche Mangel war: bis hierher gab es
  nur einen farbigen Punkt in der `GuildRail`, und die ist Desktop-only. Auf
  Handy und Tablet blieb weiss einfach weiss.

  Wann er erscheint, entscheidet `ws/offlinehinweis.ts` (geprüft) —
  insbesondere erscheint er NICHT bei Zuständen, die ihre eigene Anzeige mit
  einem Handgriff haben (Server zu alt, gesperrt, Zweitfaktor fehlt): dort wäre
  „keine Verbindung" die falsche Diagnose und schickt den Nutzer zum Router
  statt zur Ursache.

  Gelesen wird aus `serverState` — der EINEN reaktiven Spiegelung des
  Verbindungszustands. Eine zweite daneben war der erste Versuch und ist
  wieder weg (Begründung im Kopf von `server-state.svelte.ts`).

  Kein Gedächtnis darüber, ob schon etwas steht: `stand.seit` misst die ganze
  Abriss-Strecke, nicht den letzten Zustandswechsel — deshalb bleibt der
  Streifen beim Wechsel von „offline" auf „verbindet" stehen, statt kurz zu
  verschwinden. Der erste Versuch löste das hier mit einem Merker und erzeugte
  damit einen Lese-Schreib-Zyklus zwischen Effekt und abgeleitetem Wert; die
  Wurzel lag in der Uhr (s. `server-state.svelte.ts`).

  **Der Taktgeber unten ist nicht Beiwerk.** Die Regel hat eine Geduld: ein
  Abriss zeigt erst nach `GEDULD_MS` etwas. Ohne einen Anstoss nach Ablauf der
  Frist käme der Hinweis NIE — bis dahin passiert nichts mehr, der Zustand hat
  sich ja gerade nicht geändert. Das ist die unangenehme Sorte Fehler: der Wert
  ist richtig gerechnet und wird nur nie neu gerechnet.

  Keine Geräteklassen-Abfrage: der Streifen gilt überall gleich, die Oberkante
  folgt der Aussparung über `--safe-area-inset-top` (die Hülle füllt die
  Variable, s. `AppDelegate.injectSafeAreaInsets`).
-->
<script lang="ts">
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
  import { m } from '$lib/paraglide/messages.js';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { GEDULD_MS, offlineHinweis } from '$lib/ws/offlinehinweis';
  import { serverState } from '$lib/ws/server-state.svelte';

  let netzOnline = $state(true);
  /** Steigt, wenn die Geduld abgelaufen ist — erzwingt die Neurechnung. */
  let anstoss = $state(0);

  $effect(() => {
    netzOnline = navigator.onLine !== false;
    const merken = () => {
      // `!== false` statt `=== true`: fehlt die Eigenschaft (ältere WebViews,
      // Testumgebungen), gilt „online" — ein Hinweis auf Verdacht wäre
      // schlimmer als keiner.
      netzOnline = navigator.onLine !== false;
    };
    window.addEventListener('online', merken);
    window.addEventListener('offline', merken);
    return () => {
      window.removeEventListener('online', merken);
      window.removeEventListener('offline', merken);
    };
  });

  const stand = $derived(serverState.get(activeServer.serverId));

  const hinweis = $derived.by(() => {
    void anstoss;
    return offlineHinweis({
      gewuenscht: stand.gewollt,
      zustand: stand.state,
      netzOnline,
      seitMs: Date.now() - stand.seit
    });
  });

  // Taktgeber für die Geduld, s. Kopfkommentar. Läuft nur, solange etwas
  // ansteht — ein Dauerticker neben einer gesunden Verbindung wäre Unsinn.
  $effect(() => {
    if (stand.state === 'open' || !stand.gewollt) return;
    const t = setTimeout(() => (anstoss += 1), GEDULD_MS + 100);
    return () => clearTimeout(t);
  });

  const farbe = $derived(hinweis === 'verbindet' ? 'bg-warning' : 'bg-destructive');
</script>

{#if hinweis !== 'keiner'}
  <div
    class="fixed top-0 right-0 left-0 z-50 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white shadow-lg {farbe}"
    style="padding-top: calc(0.5rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))"
    role="status"
    aria-live="polite"
    data-testid="verbindungs-hinweis"
    data-zustand={hinweis}
  >
    {#if hinweis === 'verbindet'}
      <LoaderIcon class="size-4 animate-spin" />
      {m.verbindung_hinweis_verbindet()}
    {:else}
      <WifiOffIcon class="size-4" />
      {m.verbindung_hinweis_offline()}
    {/if}
  </div>
{/if}
