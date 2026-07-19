<!--
  Feld-Beschriftung mit Pflichtfeld-Kennzeichnung.

  Grund für eine eigene Komponente neben `ui/label`: die App hat 45 Felder mit
  `required`, und KEIN einziges ist sichtbar gekennzeichnet. Der Nutzer füllt
  aus, drückt Absenden und erfährt erst dann vom Browser, dass etwas fehlt. Das
  ist keine Geschmacksfrage, sondern eine Information zum falschen Zeitpunkt.

  Der Stern ist `aria-hidden` — Screenreader bekommen die Pflicht ohnehin über
  das `required` am Feld selbst gesagt, doppelt wäre nur Lärm. Dafür trägt er
  einen `title`, damit die Bedeutung auch mit der Maus erfahrbar ist.

      <FieldLabel for="name" required>Anzeigename</FieldLabel>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Label } from '$lib/components/ui/label';
  import { m } from '$lib/paraglide/messages.js';

  let {
    required = false,
    class: className = undefined,
    children,
    ...rest
  }: {
    /** Setzt die sichtbare Kennzeichnung. Das `required` am FELD nicht vergessen. */
    required?: boolean;
    class?: string;
    children?: Snippet;
    [key: string]: unknown;
  } = $props();
</script>

<Label class={className} {...rest}>
  {@render children?.()}
  {#if required}
    <span class="text-destructive" aria-hidden="true" title={m.field_required()}>*</span>
  {/if}
</Label>
