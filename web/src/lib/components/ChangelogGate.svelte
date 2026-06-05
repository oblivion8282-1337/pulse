<!--
  ChangelogGate: entscheidet beim App-Start, ob das Changelog-Dialog gezeigt
  wird. Mechanik:
   - lädt /changelog.json (no-cache; nginx serviert sie ohne Cache, s.
     web-nginx.conf, analog zu /_app/version.json)
   - vergleicht die neueste Eintrags-id mit localStorage 'pulse.changelog.lastSeen'
   - lastSeen ≠ neueste id (inkl. Erstbesuch ohne Wert): die neuen Einträge
     anzeigen, beim Schließen lastSeen hochsetzen → erscheint genau EINMAL nach
     dem Update-Reload bzw. beim nächsten App-Start. Auch Erstnutzer sehen das
     aktuelle Changelog (bewusst keine Neuling-Sonderbehandlung).
  Changelog ist nice-to-have: jeder Fehler (fetch/parse/localStorage) wird
  geschluckt, der App-Start darf nie daran hängen.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ChangelogDialog from './ChangelogDialog.svelte';
  import { isChangelogEntry, type ChangelogEntry } from '$lib/changelog/types';

  const LAST_SEEN_KEY = 'pulse.changelog.lastSeen';

  let entries = $state<ChangelogEntry[]>([]);
  let open = $state(false);

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
    void (async () => {
      let all: ChangelogEntry[];
      try {
        const res = await fetch('/changelog.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const data: unknown = await res.json();
        const raw = (data as { entries?: unknown })?.entries;
        if (!Array.isArray(raw)) return;
        all = raw.filter(isChangelogEntry);
      } catch {
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
      if (entries.length > 0) open = true;
    })();
  });

  function handleClose(): void {
    open = false;
    if (entries.length > 0) writeLastSeen(entries[0].id);
  }
</script>

<ChangelogDialog {entries} {open} onClose={handleClose} />
