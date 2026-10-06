<!--
  Fehlerseite — was zu sehen ist, wenn eine Route nicht aufgeht.

  **Bis 2026-08-18 gab es im ganzen Projekt KEINE.** Ohne sie rendert SvelteKit
  bei einem Routen-Fehler nichts, und in einer SPA ohne Server-Rendering heisst
  das: weisses Fenster, kein Text, kein Weg zurueck. Betroffen ist jede Adresse,
  die nicht aufgeht — ein Lesezeichen auf einen geloeschten Kanal, ein
  abgelaufener Einladungslink, ein Tippfehler.

  Aufgefallen an einem Sonderfall: nach einem Neuladen stand
  `/app/guilds//channels/<id>` in der Leiste — die Kennung der Community fehlte,
  zwischen den Schraegstrichen klaffte ein Loch. SvelteKit ordnet so etwas
  keiner Route zu (ein leeres Segment erfuellt einen Pflicht-Parameter nicht),
  also 404, also nichts. Das Fenster sah aus, als sei die App abgestuertzt.

  **Wo diese Adresse herkommt, ist offen.** Statisch nicht zu finden gewesen:
  Aktivitaetskopf und Mitgliederliste scheiden aus (beide durchlaufen die
  Kanaele der Community und zeigen bei leerer Kennung ueberhaupt nichts),
  Tastenkuerzel und Service-Worker pruefen ausdruecklich, Electron und der
  Deep-Link bauen solche Adressen nicht. Deshalb schreibt diese Seite die
  fehlgeschlagene Adresse in die Konsole — beim naechsten Auftreten steht sie
  im Log, statt nur als weisses Fenster in Erinnerung zu bleiben.

  Die Flaeche folgt den Vollflaechen-Meldungen der Kanalseite (`glass-panel`,
  zentriert), damit sie nicht wie ein Fremdkoerper wirkt.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';

  // Einmal beim Anzeigen, nicht in einem Effekt mit Abhaengigkeiten: die Seite
  // wird je Fehler neu aufgebaut, und genau einmal je Fehler soll es im Log
  // stehen. Die Adresse ist das Wertvolle daran — der Status allein sagt nichts
  // darueber, WELCHER Link ins Leere fuehrte.
  console.warn(
    `[route] ${page.status} — keine Seite fuer ${page.url.pathname}${page.url.search}`,
    page.error,
  );
</script>

<div
  class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 text-center md:rounded-2xl"
  data-testid="route-error"
>
  <h1 class="text-text-bright text-lg font-semibold">{m.error_page_title()}</h1>
  <p class="text-text-muted max-w-sm text-sm">{m.error_page_body()}</p>
  <!-- Bewusst ein echter Link und kein `goto`: von einer kaputten Route aus ist
       ein harter Wechsel der verlaesslichere Weg — er baut die App neu auf,
       statt auf einem Router aufzusetzen, der gerade nicht weiterwusste. -->
  <Button href="/app" data-testid="route-error-back">{m.error_page_back()}</Button>
</div>
