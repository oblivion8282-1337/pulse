<!--
  Eine Zeile der Rechteliste: Name mit einem Satz, der Dreizustand, das
  Ergebnis.

  Drei Teile, weil die Frage drei Teile hat: worum geht es, was stelle ich hier
  ein, was kommt am Ende dabei heraus. Die dritte Spalte ist der eigentliche
  Grund für den Umbau — vorher setzte man Häkchen und wusste hinterher nicht,
  was gilt.

  Das Wort „Übernehmen" ist hier bewusst NICHT benutzt: in Pulse heisst das,
  einen fremden Rechner fernzusteuern.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import type { Zustand } from '../entwurf.svelte';
  import type { Rechtsstand } from '../herkunft';
  import type { Kanalrecht } from '../kanalrechte';
  import { ergebnisFarbe, ergebnisText } from '../texte';

  let {
    recht,
    zustand,
    stand,
    zielName,
    gesperrt = false,
    gedaempft = false,
    testKey,
    onsetze
  }: {
    recht: Kanalrecht;
    zustand: Zustand;
    stand: Rechtsstand;
    /** Steht im aria-label, damit ein Screenreader nicht sechzehnmal
     *  dasselbe „deny/neutral/allow" vorliest. */
    zielName: string;
    /** Bit, das der Bearbeiter selbst nicht hält — er darf es nicht vergeben. */
    gesperrt?: boolean;
    /** „Kanal ansehen" ist nein: alles Übrige fällt weg. */
    gedaempft?: boolean;
    testKey: string;
    onsetze: (zu: Zustand) => void;
  } = $props();

  const knoepfe: { wert: Zustand; text: () => string; aus: string; an: string }[] = [
    {
      wert: 'deny',
      text: () => m.kanalrechte_zustand_verbieten(),
      aus: 'text-text-muted hover:bg-red-500/10 hover:text-red-400',
      an: 'bg-red-500/20 text-red-300'
    },
    {
      wert: 'neutral',
      text: () => m.kanalrechte_zustand_erben(),
      aus: 'text-text-muted hover:bg-bg-hover',
      an: 'bg-bg-hover text-text-bright'
    },
    {
      wert: 'allow',
      text: () => m.kanalrechte_zustand_erlauben(),
      aus: 'text-text-muted hover:bg-green-500/10 hover:text-green-400',
      an: 'bg-green-500/20 text-green-300'
    }
  ];

  let ergebnis = $derived(ergebnisText(stand));
  let farbe = $derived(ergebnisFarbe(stand));
</script>

<li
  class="grid grid-cols-1 gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4 lg:grid-cols-[minmax(0,1fr)_auto_11rem]"
  data-testid={`perm-row-${testKey}-${recht.perm}`}
>
  <div class="min-w-0" class:opacity-50={gedaempft}>
    <p class="text-text-bright truncate text-sm font-medium">{recht.name}</p>
    <p class="text-text-muted truncate text-xs">{recht.satz}</p>
  </div>

  <div
    class="border-border bg-bg-input/40 flex shrink-0 rounded-lg border p-0.5"
    role="group"
    aria-label={recht.name}
  >
    {#each knoepfe as k (k.wert)}
      <button
        type="button"
        class={`rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${zustand === k.wert ? k.an : k.aus}`}
        onclick={() => onsetze(k.wert)}
        disabled={gesperrt}
        aria-pressed={zustand === k.wert}
        aria-label={m.kanalrechte_zustand_aria({
          recht: recht.name,
          ziel: zielName,
          zustand: k.text()
        })}
        title={gesperrt ? m.kanalrechte_gesperrt_hinweis() : undefined}
        data-testid={`override-toggle-${testKey}-${recht.perm}-${k.wert}`}
      >{k.text()}</button>
    {/each}
  </div>

  <p
    class={`text-xs sm:col-span-2 lg:col-span-1 lg:text-right ${farbe}`}
    class:opacity-70={gedaempft}
    data-testid={`perm-result-${testKey}-${recht.perm}`}
  >
    {ergebnis}
  </p>
</li>
