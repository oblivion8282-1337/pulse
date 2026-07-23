<!--
  Eine Zeile im Community-Grenzen-Editor: Beschriftung + Eingabe, dazu die
  Vorgabe des Betreibers als Platzhalter/Auswahl-Grenze.

  Zahlenfelder tragen die Vorgabe als Platzhalter („Vorgabe des Betreibers:
  128"). Beim Auflösungs-Dropdown blenden wir alles oberhalb der Vorgabe aus —
  auswählen kann man nur, was auch erlaubt ist.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { toDisplay, RESOLUTION_LADDER, type LimitKind } from './guildLimitUnits';

  let {
    label,
    kind,
    ceiling,
    value = $bindable(''),
    testid
  }: {
    label: string;
    kind: LimitKind;
    /** Vorgabe des Betreibers als Wire-Wert (null = unbegrenzt). */
    ceiling: number | string | null;
    value?: string;
    testid: string;
  } = $props();

  // Vorgabe in der Anzeige-Einheit, für den Platzhalter.
  const ceilingDisplay = $derived(toDisplay(ceiling, kind));
  const placeholder = $derived(
    ceiling === null
      ? m.guild_limits_ceiling_unlimited()
      : m.guild_limits_ceiling_hint({ value: ceilingDisplay })
  );

  // Auflösungsleiter, gekappt auf die Vorgabe: alles oberhalb rausnehmen.
  // 'Native' als Vorgabe = keine Kappung.
  const resolutionOptions = $derived.by(() => {
    if (kind !== 'resolution') return [];
    const cap = ceiling ? String(ceiling) : 'Native';
    const from = cap === 'Native' ? 0 : RESOLUTION_LADDER.indexOf(cap);
    return RESOLUTION_LADDER.slice(Math.max(from, 0));
  });
</script>

<label class="flex flex-col gap-1">
  <span class="text-text-muted text-xs font-medium">{label}</span>
  {#if kind === 'resolution'}
    <select
      bind:value
      class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
      data-testid={testid}
    >
      <option value="">{placeholder}</option>
      {#each resolutionOptions as r (r)}
        <option value={r}>{r === 'Native' ? m.guild_limits_res_native() : r}</option>
      {/each}
    </select>
  {:else}
    <Input type="number" min="0" step="any" {placeholder} bind:value data-testid={testid} />
  {/if}
</label>
