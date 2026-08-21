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
  import Select from '$lib/components/form/Select.svelte';
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

  // Der Leerwert ist eine WAHL, kein Platzhalter: „erbt die Vorgabe des
  // Betreibers" heißt, die Grenze auf dem Server zu lassen — und die Options-
  // Beschriftung nennt den Wert, der dann tatsächlich gilt. Sie darf deshalb
  // nicht ins placeholder-Prop wandern (dort wäre sie nicht anwählbar).
  const resAuswahl = $derived([
    { value: '', label: placeholder },
    ...resolutionOptions.map((r) => ({
      value: r,
      label: r === 'Native' ? m.guild_limits_res_native() : r,
    })),
  ]);
</script>

<label class="flex flex-col gap-1">
  <span class="text-text-muted text-xs font-medium">{label}</span>
  {#if kind === 'resolution'}
    <Select
      value={value}
      options={resAuswahl}
      onchange={(v) => (value = v)}
      data-testid={testid}
    />
  {:else}
    <Input type="number" min="0" step="any" {placeholder} bind:value data-testid={testid} />
  {/if}
</label>
