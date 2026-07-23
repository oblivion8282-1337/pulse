<!--
  Ein Zahlenfeld in den Community-Grenzen: Beschriftung + Eingabe + Platzhalter.

  Der Platzhalter ist der Punkt dieser Komponente. Vorher stand in jedem leeren
  Feld nur „Standard" — das beantwortet die eine Frage nicht, die man beim
  Ausfüllen hat: *welcher* Standard? Deshalb nimmt sie den tatsächlich
  wirkenden Wert entgegen und zeigt ihn an („Standard: 128"). Wo es keinen
  Zahlenwert gibt, weil leer schlicht „ohne Grenze" heißt, steht „Unbegrenzt".
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    label,
    value = $bindable(''),
    fallback,
    testid,
    min,
    max,
    step
  }: {
    label: string;
    value?: string | number;
    /** Was gilt, wenn das Feld leer bleibt: eine Zahl (der geerbte Standard,
     *  bereits in der Einheit des Feldes) oder 'unlimited'. */
    fallback: number | 'unlimited';
    testid: string;
    min?: string;
    max?: string;
    step?: string;
  } = $props();

  // Zahlen werden mit der Locale des Browsers gesetzt (1000 → „1.000"), damit
  // der Platzhalter so aussieht wie das, was der Betreiber sonst liest.
  const placeholder = $derived(
    fallback === 'unlimited'
      ? m.admin_communities_limits_placeholder_unlimited()
      : m.admin_communities_limits_placeholder_default({
          value: new Intl.NumberFormat().format(fallback)
        })
  );
</script>

<label class="flex flex-col gap-1">
  <span class="text-text-muted text-xs font-medium">{label}</span>
  <Input type="number" {min} {max} {step} {placeholder} bind:value data-testid={testid} />
</label>
