<!--
  Schalter — „an/aus" für eine Einstellung, die sofort greift.

  Ersetzt sechs handgebaute Schalter in fünf Dateien. Die sahen bisher alle gleich
  aus, aber nur solange niemand eine der Kopien angefasst hat.

  Wann Schalter, wann Kontrollkästchen: Ein Schalter wirkt SOFORT (Einstellung
  umlegen), ein Kästchen ist eine Auswahl, die erst mit dem Absenden gilt. Wer
  das vertauscht, verwirrt — deshalb sind es zwei Komponenten und nicht eine mit
  Ausprägung.

      <Switch bind:checked={enabled} aria-label="Ablage aktivieren" />
-->
<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils.js';

  let {
    checked = $bindable(false),
    disabled = false,
    class: className = undefined,
    onCheckedChange = undefined,
    ...rest
  }: HTMLButtonAttributes & {
    checked?: boolean;
    disabled?: boolean;
    class?: string;
    /** Wird nach dem Umlegen mit dem neuen Wert gerufen. */
    onCheckedChange?: (checked: boolean) => void;
  } = $props();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onCheckedChange?.(checked);
  }
</script>

<!-- `{...rest}` steht vorn, damit ein durchgereichtes `onclick`/`role` das
     Umlegen nicht stillschweigend aushebelt. -->
<button
  {...rest}
  type="button"
  role="switch"
  aria-checked={checked}
  {disabled}
  onclick={toggle}
  class={cn(
    'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full',
    'transition-colors outline-none',
    'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:cursor-not-allowed disabled:opacity-50',
    checked ? 'bg-primary' : 'bg-bg-hover',
    className
  )}
>
  <span
    class={cn(
      'block size-4 rounded-full bg-white shadow-sm transition-transform',
      checked ? 'translate-x-6' : 'translate-x-1'
    )}
  ></span>
</button>
