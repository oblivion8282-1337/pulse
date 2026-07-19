<!--
  Kontrollkästchen.

  Ersetzt 31 handgebaute Kästchen in 11 Ausprägungen — darunter acht ganz OHNE
  Gestaltung, also rohe Browser-Kästchen, die auf jedem Betriebssystem anders
  aussehen.

  Bewusst ein echtes `<input type="checkbox">` mit `appearance-none` statt eines
  nachgebauten Elements mit verstecktem Input: so bleiben Tastaturbedienung,
  Screenreader-Ansage, Formular-Teilnahme und `bind:checked` das, was der Browser
  ohnehin kann. Nur das Aussehen wird ersetzt.

  Die Grösse folgt dem Bestand: auf Touch-Geräten 20px, ab `md` 16px. Das kam aus
  dem Mobile-Touch-Pass und ist Absicht, keine Uneinheitlichkeit.

      <Checkbox bind:checked={settings.foo} />
      <label class="flex items-center gap-2.5">
        <Checkbox bind:checked={x} /> Benachrichtigen
      </label>
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils.js';

  let {
    checked = $bindable(false),
    indeterminate = false,
    class: className = undefined,
    ...rest
  }: HTMLInputAttributes & {
    checked?: boolean;
    /** „teilweise ausgewählt" — für Gruppen-Kästchen über einer Liste. */
    indeterminate?: boolean;
    class?: string;
  } = $props();
</script>

<!-- `{...rest}` steht vorn: `type` und die Klasse sind das, was diese Komponente
     ausmacht, und dürfen von einem durchgereichten Attribut nicht ausgehebelt
     werden. Alles andere (role, disabled, data-testid, onchange …) fließt durch. -->
<input
  {...rest}
  type="checkbox"
  bind:checked
  {indeterminate}
  class={cn('pulse-checkbox', className)}
/>

<style>
  .pulse-checkbox {
    /* Grösse + Grundform */
    inline-size: 1.25rem;
    block-size: 1.25rem;
    flex-shrink: 0;
    appearance: none;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
    background-color: var(--input);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }
  @media (min-width: 48rem) {
    .pulse-checkbox {
      inline-size: 1rem;
      block-size: 1rem;
    }
  }

  .pulse-checkbox:checked,
  .pulse-checkbox:indeterminate {
    background-color: var(--primary);
    border-color: var(--primary);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 80%;
  }
  /* Haken bzw. Strich als Data-URI — kein Extra-Element, damit das Kästchen ein
     einzelnes echtes Formularelement bleibt. */
  .pulse-checkbox:checked {
    background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8.5l3.5 3.5L13 5'/%3E%3C/svg%3E");
  }
  .pulse-checkbox:indeterminate {
    background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M4 8h8'/%3E%3C/svg%3E");
  }

  .pulse-checkbox:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .pulse-checkbox:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
