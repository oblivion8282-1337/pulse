<script lang="ts">
  /**
   * Geräte-Kopplung — der Rahmen um beide Seiten (Etappe F, E2E-DM).
   *
   * **Der Schalter sitzt HIER, nicht in den beiden Hälften.** Beide Kinder
   * rufen im `onMount`/beim ersten Klick den Server; ein Riegel in jedem von
   * ihnen wäre zweimal dieselbe Bedingung, und die vergessene dritte Stelle
   * (ein künftiger dritter Weg, etwa QR-Scan) fiele nicht auf. `{#if}` hier
   * heisst: die Kinder werden bei ausgeschaltetem Schalter gar nicht erst
   * gebaut — kein Serveraufruf, nichts sichtbar.
   *
   * QR fehlt bewusst: das Projekt hat keine QR-Bibliothek im Klienten (die
   * vorhandene `qrcode[pil]` liegt im auth-svc und erzeugt serverseitig),
   * und der Kopplungscode DARF den Server nicht erreichen — eine
   * serverseitig gerenderte Grafik schiede also ohnehin aus. Der Textweg ist
   * laut Spec §6 ohnehin der Pflichtweg; QR ist die Bequemlichkeit obendrauf.
   */
  import { GERAETE_KOPPLUNG_ENABLED } from '$lib/krypto/schalter';
  import { m } from '$lib/paraglide/messages.js';
  import KopplungEinloesen from './KopplungEinloesen.svelte';
  import KopplungZeigen from './KopplungZeigen.svelte';

  let seite = $state<'zeigen' | 'eingeben'>('zeigen');
</script>

{#if GERAETE_KOPPLUNG_ENABLED}
  <section class="space-y-4" data-testid="geraete-kopplung">
    <div>
      <h3 class="text-base font-semibold">{m.kopplung_title()}</h3>
      <p class="text-sm text-muted-foreground">{m.kopplung_description()}</p>
    </div>

    <div class="flex gap-2" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={seite === 'zeigen'}
        class="rounded-md px-3 py-2 text-sm {seite === 'zeigen' ? 'bg-muted font-medium' : ''}"
        onclick={() => (seite = 'zeigen')}
        data-testid="kopplung-tab-zeigen"
      >
        {m.kopplung_tab_zeigen()}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={seite === 'eingeben'}
        class="rounded-md px-3 py-2 text-sm {seite === 'eingeben' ? 'bg-muted font-medium' : ''}"
        onclick={() => (seite = 'eingeben')}
        data-testid="kopplung-tab-eingeben"
      >
        {m.kopplung_tab_eingeben()}
      </button>
    </div>

    {#if seite === 'zeigen'}
      <KopplungZeigen />
    {:else}
      <KopplungEinloesen />
    {/if}
  </section>
{/if}
