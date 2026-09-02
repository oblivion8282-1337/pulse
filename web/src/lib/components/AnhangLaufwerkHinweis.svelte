<!--
  Warum die Büroklammer fehlt (Design §11.2).

  Ein verschlüsselter Anhang landet im Cloud-Ordner JEDES Beteiligten; wer
  keinen verbunden hat, kann ihn nicht empfangen. §11.2 verlangt ausdrücklich,
  dass die Oberfläche das BENENNT: „In einer Gruppe blockiert ein Mitglied ohne
  Laufwerk die Anhänge für alle. Die Oberfläche muss das benennen, sonst wirkt
  es unerklärlich."

  Deshalb zwei getrennte Sätze statt eines allgemeinen. Fehlt es einem selbst,
  gibt es einen Handgriff (Laufwerk verbinden) und dafür einen Link. Fehlt es
  einem anderen, gibt es keinen — dann bleibt nur, es zu wissen; ein Link, der
  nichts ändert, wäre schlimmer als keiner.

  Textnachrichten bleiben davon unberührt (§11.2) — der Hinweis sagt das mit,
  weil ein fehlender Anhang-Knopf sonst leicht als „hier geht gar nichts mehr"
  gelesen wird.

  **Rechnet selbst, statt Fertiges entgegenzunehmen.** Die Zuordnung
  Konto-Kennung → Anzeigename samt Nachladen gehört zu diesem einen Hinweis
  und sonst nirgendwohin; in `ChatView.svelte` wäre sie vier weitere Zeilen in
  einer Datei, die die Größen-Policy ohnehin reisst.
-->
<script lang="ts">
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import { anhangBereitschaft } from '$lib/attachments/anhangBereitschaft.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { userCache, UNRESOLVED_DISPLAY_NAME } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { kanalId }: { kanalId: string } = $props();

  // Auslieferungsschritt 1 (2026-09-02, Eigentümer): Laufwerk-Hinweise sind
  // ausgeblendet — ohne Laufwerke gibt es ohnehin keine Anhänge (§11.2
  // versteckt den Knopf selbst). Reaktivierung: diese Rückgabe entfernen.
  return null;

  const ohneLaufwerk = $derived(anhangBereitschaft.ohneLaufwerk(kanalId));

  // Das Nachladen der Namen gehört in einen Effekt, nicht in ein `$derived`:
  // `userCache.queue` stösst einen Sammelabruf mit Zeitgeber an, und ein
  // Ableitungsausdruck darf nichts anstossen.
  $effect(() => {
    ohneLaufwerk.forEach((id) => userCache.queue(id));
  });

  // Das eigene Konto beim Namen zu nennen wäre unnatürlich („Michael hat kein
  // Laufwerk") — die beiden Fälle bleiben deshalb getrennt.
  const eigen = $derived(currentServerUserId());
  const selbstBetroffen = $derived(eigen !== null && ohneLaufwerk.includes(eigen));
  // `displayName()` liefert `UNRESOLVED_DISPLAY_NAME`, solange der Name noch
  // nicht im Zwischenspeicher liegt (der obige Effekt hat ihn gerade erst
  // nachgefragt) — oder, seltener, wenn er sich gar nicht auflösen lässt
  // (Konto gelöscht, Server kennt es nicht). Beides sieht für die Anzeige
  // gleich aus: statt eines stehenbleibenden „…" ein Satzstück, das auch ohne
  // Namen etwas sagt. Löst der Nachschlag doch noch auf, ersetzt die nächste
  // Reaktivitätsrunde den Platzhalter automatisch durch den echten Namen.
  const andere = $derived(
    (() => {
      const namen: string[] = [];
      let unaufgeloest = false;
      for (const id of ohneLaufwerk) {
        if (id === eigen) continue;
        const name = userCache.displayName(id);
        if (name === UNRESOLVED_DISPLAY_NAME) {
          unaufgeloest = true;
        } else {
          namen.push(name);
        }
      }
      if (unaufgeloest) namen.push(m.anhang_hinweis_andere_unbekannt());
      return namen;
    })()
  );
</script>

<div
  class="text-text-muted mb-1 flex items-start gap-2 rounded-t-xl border border-b-0 border-border bg-bg-input/60 px-3 py-2 text-xs"
  data-testid="anhang-laufwerk-hinweis"
>
  <PaperclipIcon class="mt-0.5 size-3.5 shrink-0" />
  <div class="min-w-0">
    {#if selbstBetroffen}
      <p>{m.anhang_hinweis_selbst()}</p>
      <!-- `storage` ist die Kennung des Speicher-Reiters (`settingsTabs.ts`);
           dieselbe Komponente liegt hinter dem Dialog und hinter dieser
           Adresse. Ein erfundener Pfad wäre hier ein toter Link — also genau
           der stille Fehlschlag, gegen den der Hinweis überhaupt steht. -->
      <a class="text-primary hover:underline" href="/app/me/storage"
        >{m.anhang_hinweis_verbinden()}</a
      >
    {/if}
    {#if andere.length > 0}
      <p>{m.anhang_hinweis_andere({ namen: andere.join(', ') })}</p>
    {/if}
    <p class="opacity-80">{m.anhang_hinweis_text_geht_weiter()}</p>
  </div>
</div>
