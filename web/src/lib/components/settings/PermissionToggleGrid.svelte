<!--
  Die Rechteliste einer Rolle — ein Schalter je Recht, nach Bereich
  gruppiert, mit Suchfeld darueber.

  Das Suchfeld ist kein Zierrat: die Liste hat 27 Eintraege in sieben
  Bereichen, und wer sie oeffnet, weiss meist schon, welches Recht er
  sucht („bannen", „streamen"). Ohne Suche scrollt man an ihm vorbei.

  Zwei Marken heben hervor, was weit traegt — und nur zwei, damit sie
  etwas bedeuten: `Vollmacht` fuer ADMINISTRATOR (hebt jede andere
  Pruefung auf) und `weitreichend` fuer alles, was AUF ANDERE MENSCHEN
  wirkt. Die Zuordnung steht in `roles/rechtekatalog.ts`, nicht hier.

  Anti-Eskalation ist gespiegelt: ein Bit, das der Bearbeiter selbst nicht
  haelt, bleibt gesperrt. Verbindlich entscheidet das der Server — die
  Sperre hier haelt nur die Bedienung ehrlich.
-->
<script lang="ts">
  import SearchIcon from '@lucide/svelte/icons/search';
  import { has, toBitfield, type Permission } from '$lib/permissions/bitfield';
  import { m } from '$lib/paraglide/messages.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import { rechtekatalog, type Tragweite } from './roles/rechtekatalog';

  let {
    value = $bindable('0'),
    editorPermissions,
    disabled = false
  }: {
    /** Bitfeld als Wire-String (BigInt-sicher). */
    value: string;
    /** Das aufgeloeste Bitfeld des Bearbeiters. Bits, die er nicht haelt,
     * bleiben gesperrt — er kann nicht vergeben, was er nicht hat. */
    editorPermissions: string;
    disabled?: boolean;
  } = $props();

  let suche = $state('');
  let katalog = $derived(rechtekatalog());
  let gesetzte = $derived(toBitfield(value));
  let erlaubte = $derived(toBitfield(editorPermissions));

  let gefiltert = $derived.by(() => {
    const nadel = suche.trim().toLowerCase();
    if (!nadel) return katalog;
    return katalog
      .map((b) => ({
        ...b,
        zeilen: b.zeilen.filter(
          (z) => z.label.toLowerCase().includes(nadel) || z.kurz.toLowerCase().includes(nadel)
        )
      }))
      .filter((b) => b.zeilen.length > 0);
  });

  function umlegen(perm: Permission, an: boolean): void {
    if (disabled || !has(erlaubte, perm)) return;
    value = (an ? gesetzte | perm : gesetzte & ~perm).toString();
  }

  function markenKlasse(t: Tragweite): string {
    return t === 'vollmacht'
      ? 'bg-destructive/15 text-destructive'
      : 'bg-warning/15 text-warning';
  }

  function markenText(t: Tragweite): string {
    return t === 'vollmacht' ? m.rechte_marke_vollmacht() : m.rechte_marke_weitreichend();
  }
</script>

<div class="space-y-4">
  <div class="flex items-center gap-2">
    <SearchIcon class="text-text-muted size-4 shrink-0" />
    <Input
      bind:value={suche}
      placeholder={m.rechte_suche_platzhalter()}
      class="h-8 text-sm"
      data-testid="perm-search"
    />
  </div>

  <!-- Die Legende steht EINMAL oben, nicht als Erklaerung an jeder Marke:
       zwei Begriffe lernt man einmal, und an 27 Zeilen wiederholt waeren
       sie Rauschen. -->
  <p class="text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
    <span class="inline-flex items-center gap-1.5">
      <span class="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase {markenKlasse('vollmacht')}">
        {m.rechte_marke_vollmacht()}
      </span>
      {m.rechte_legende_vollmacht()}
    </span>
    <span class="inline-flex items-center gap-1.5">
      <span class="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase {markenKlasse('weitreichend')}">
        {m.rechte_marke_weitreichend()}
      </span>
      {m.rechte_legende_weitreichend()}
    </span>
  </p>

  {#each gefiltert as bereich (bereich.titel)}
    <section>
      <h3 class="text-text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
        {bereich.titel}
      </h3>
      <div class="space-y-1">
        {#each bereich.zeilen as z (z.perm)}
          {@const gesetzt = has(gesetzte, z.perm)}
          {@const erlaubt = has(erlaubte, z.perm)}
          <label
            class="bg-bg-hover/40 hover:bg-bg-hover flex cursor-pointer items-start justify-between gap-4 rounded-md px-3 py-2"
            class:cursor-not-allowed={!erlaubt || disabled}
            class:opacity-50={!erlaubt || disabled}
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-text-bright text-sm font-medium">{z.label}</span>
                {#if z.tragweite}
                  <span
                    class="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase {markenKlasse(z.tragweite)}"
                  >
                    {markenText(z.tragweite)}
                  </span>
                {/if}
              </div>
              <div class="text-text-muted text-xs">{z.kurz}</div>
              {#if !erlaubt}
                <div class="text-warning mt-0.5 text-xs">{m.rechte_gesperrt_hinweis()}</div>
              {/if}
            </div>
            <Checkbox
              class="mt-1"
              checked={gesetzt}
              disabled={!erlaubt || disabled}
              onchange={(ev) => umlegen(z.perm, (ev.currentTarget as HTMLInputElement).checked)}
              data-testid={`perm-toggle-${z.perm.toString()}`}
            />
          </label>
        {/each}
      </div>
    </section>
  {/each}

  {#if gefiltert.length === 0}
    <EmptyState message={m.rechte_suche_leer()} testId="perm-search-empty" />
  {/if}
</div>
