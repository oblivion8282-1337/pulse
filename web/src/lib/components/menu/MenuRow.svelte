<!--
  Anklickbare Zeile in einem Menü, Popover oder einer Reiterleiste: Symbol links,
  Text daneben, linksbündig, volle Breite.

  Warum keine Button-Variante: die Button-Komponente erzwingt in ihrer Grundlage
  `justify-center` und `whitespace-nowrap`. Das ist kein Detail, sondern der Kern
  dessen, was ein Button ist — eine Menüzeile ist das Gegenteil davon.

  Ersetzt 16 gewachsene Ausprägungen desselben Musters (vier Symbolabstände, vier
  Innenabstände, drei Radien, drei Schriftgrössen). Keine davon war Absicht.

  NICHT hierfür gedacht sind REICHE Listeneinträge — eine Direktnachricht mit
  Avatar, Name und Nachrichtenvorschau, oder ein Mitglied mit Statuspunkt und
  Rollenfarbe. Die haben eigene innere Struktur und mehrere Textebenen; sie
  hier durchzuzwängen würde dasselbe wiederholen, was wir gerade auflösen.

      <MenuRow onclick={…}><UsersIcon class="size-4 shrink-0" /> Mitglieder</MenuRow>
      <MenuRow active variant="danger" onclick={…}>…</MenuRow>
-->
<script lang="ts" module>
  import { tv, type VariantProps } from 'tailwind-variants';

  export const menuRowVariants = tv({
    base:
      'flex w-full items-center gap-2.5 rounded-md text-left transition-colors ' +
      'outline-none select-none disabled:pointer-events-none disabled:opacity-50 ' +
      'focus-visible:ring-ring/50 focus-visible:ring-2 [&_svg]:shrink-0',
    variants: {
      variant: {
        default: 'text-text-base hover:bg-bg-hover',
        danger: 'text-destructive hover:bg-destructive/10',
        // Melden/eskalieren: ernst, aber nicht zerstörend.
        warning: 'text-warning hover:bg-warning/10'
      },
      density: {
        // Menüs und Reiterleisten.
        default: 'px-3 py-2 text-sm',
        // Touch-Flächen (mobiles Aktionsblatt) — dort sind höhere Zeilen keine
        // Uneinheitlichkeit, sondern Bedienbarkeit.
        comfortable: 'min-h-12 px-4 py-3 text-base'
      },
      active: {
        true: '',
        false: ''
      }
    },
    compoundVariants: [
      { variant: 'default', active: true, class: 'bg-bg-hover text-text-bright' },
      { variant: 'danger', active: true, class: 'bg-destructive/10' },
      { variant: 'warning', active: true, class: 'bg-warning/10' }
    ],
    defaultVariants: { variant: 'default', density: 'default', active: false }
  });

  export type MenuRowVariant = VariantProps<typeof menuRowVariants>['variant'];
  export type MenuRowDensity = VariantProps<typeof menuRowVariants>['density'];
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils.js';

  let {
    variant = 'default',
    density = 'default',
    active = false,
    href = undefined,
    type = 'button',
    disabled = undefined,
    class: className = undefined,
    children,
    ...rest
  }: HTMLButtonAttributes &
    HTMLAnchorAttributes & {
      variant?: MenuRowVariant;
      density?: MenuRowDensity;
      /** Ausgewählt/geöffnet — hebt die Zeile dauerhaft hervor. */
      active?: boolean;
      children?: Snippet;
    } = $props();

  const cls = $derived(cn(menuRowVariants({ variant, density, active }), className));
</script>

{#if href}
  <!-- Ein Anker kennt kein `disabled` — deaktiviert heisst hier: kein Ziel, nicht
       fokussierbar, für Screenreader als deaktiviert ausgewiesen. Gleiche
       Behandlung wie in `ui/button/button.svelte`. -->
  <a
    href={disabled ? undefined : href}
    class={cls}
    data-active={active}
    aria-disabled={disabled}
    role={disabled ? 'link' : undefined}
    tabindex={disabled ? -1 : undefined}
    {...rest}
  >
    {@render children?.()}
  </a>
{:else}
  <button {type} {disabled} class={cls} data-active={active} {...rest}>
    {@render children?.()}
  </button>
{/if}
