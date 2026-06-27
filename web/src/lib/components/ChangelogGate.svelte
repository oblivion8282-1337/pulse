<!--
  ChangelogGate: entscheidet beim App-Start, ob das „Was ist neu?"-Changelog
  gezeigt wird, und zeigt es als NICHT-blockierenden Toast (unten rechts, via
  sonner) — KEIN modaler Dialog mehr. So kann der User nebenher weiterarbeiten
  (z.B. in einen Voice-Channel joinen), während der Toast steht, und ihn
  wegklicken.

  Mechanik:
   - lädt /changelog.json (no-cache; nginx serviert sie ohne Cache, s.
     web-nginx.conf, analog zu /_app/version.json)
   - vergleicht die neueste Eintrags-id mit localStorage 'pulse.changelog.lastSeen'
   - lastSeen ≠ neueste id (inkl. Erstbesuch): die seither neuen Einträge zeigen.
   - Der Toast erscheint erst, wenn der User EINGELOGGT ist (auth.user gesetzt) —
     nie auf dem Login-Screen, sondern im App-Kontext. „Gesehen" wird beim
     Anzeigen markiert → erscheint genau EINMAL pro Update, kein Re-Show beim
     nächsten Reload.
  Changelog ist nice-to-have: jeder Fehler (fetch/parse/localStorage) wird
  geschluckt, der App-Start darf nie daran hängen. Parse-Fehler landen
  aber in der Konsole — sonst sieht man den kaputten Toast erst, wenn ein
  User „Was ist neu?" vermisst.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import ChangelogToast from './ChangelogToast.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { isChangelogEntry, type ChangelogEntry } from '$lib/changelog/types';
  import { isMobile, isCapacitorAndroid } from '$lib/platform/runtime';

  const LAST_SEEN_KEY = 'pulse.changelog.lastSeen';

  let entries = $state<ChangelogEntry[]>([]);
  // Nicht-reaktiver Einmal-Guard: der Toast darf pro Mount nur einmal feuern.
  let fired = false;

  function readLastSeen(): string | null {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  }
  function writeLastSeen(id: string): void {
    try {
      localStorage.setItem(LAST_SEEN_KEY, id);
    } catch {
      /* private mode / quota — Changelog ist nicht kritisch */
    }
  }

  onMount(() => {
    // Kein „Was ist neu?"-Toast auf Mobile-Browsern oder im Android-APK
    // (Capacitor-Wrapper): dort ist er unerwünscht und überlagert u.a. die
    // Eingabeleiste. Früh raus, bevor überhaupt /changelog.json geladen wird.
    // ``lastSeen`` wird bewusst NICHT gesetzt, damit derselbe User den Eintrag
    // auf dem Desktop weiterhin sieht.
    if (isMobile() || isCapacitorAndroid()) return;
    void (async () => {
      let all: ChangelogEntry[];
      try {
        const res = await fetch('/changelog.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const data: unknown = await res.json();
        const raw = (data as { entries?: unknown })?.entries;
        if (!Array.isArray(raw)) return;
        all = raw.filter(isChangelogEntry);
      } catch (e) {
        // bewusst stillschweigend schlucken (App-Start darf nicht hängen),
        // aber laut sein — sonst fliegt der kaputte Toast wochenlang
        // unentdeckt durch.
        console.warn('[changelog] /changelog.json laden/parsieren fehlgeschlagen:', e);
        return;
      }
      if (all.length === 0) return;

      const latestId = all[0].id;
      const lastSeen = readLastSeen();

      if (lastSeen === latestId) return; // schon gesehen, nichts Neues

      // Etwas Neues zeigen. Bekannte ältere id → alle seither neuen Einträge
      // (mehrere verpasste Deploys nachholen). Erstbesuch (lastSeen === null)
      // oder unbekannte/geprunte id → nur den NEUESTEN zeigen, nicht die ganze
      // Historie aufdrängen.
      const idx = lastSeen === null ? -1 : all.findIndex((e) => e.id === lastSeen);
      entries = idx === -1 ? all.slice(0, 1) : all.slice(0, idx);
    })();
  });

  // Toast erst feuern, wenn etwas Neues da ist UND der User eingeloggt ist.
  // ``auth.user`` ist reaktiv ($state) → der Effect läuft erneut, sobald die
  // Hydration/der Login ihn setzt. ``fired`` stellt einmaliges Feuern sicher.
  $effect(() => {
    if (fired || entries.length === 0 || !auth.user) return;
    fired = true;
    const seenId = entries[0].id;
    toast.custom(ChangelogToast, {
      componentProps: { entries },
      duration: Number.POSITIVE_INFINITY, // bleibt bis zum Wegklicken
      dismissible: true,
    });
    // Einmal gezeigt → als gesehen markieren (kein Re-Show beim nächsten Reload).
    writeLastSeen(seenId);
  });
</script>
