<script lang="ts">
  /**
   * Read-only Übersicht aller aktuellen Tastatur-Bindings. Geöffnet via
   * `nav.cheatsheet`-Action (default Ctrl+/). Konfiguration läuft über den
   * Settings-Dialog, nicht hier.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import {
    ACTIONS,
    CATEGORY_ORDER,
    CATEGORY_LABELS,
    type ActionDef
  } from '$lib/shortcuts/actions';
  import { effectiveBinding } from '$lib/shortcuts/persistence';
  import { displayCombo } from '$lib/shortcuts/format';
  import { settings } from '$lib/stores/settings.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  function itemsFor(cat: string): readonly ActionDef[] {
    return ACTIONS.filter((a) => a.category === cat && !a.hidden);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-2xl" data-testid="shortcut-cheatsheet">
    <Dialog.Title>{m.shortcut_cheatsheet_title()}</Dialog.Title>
    <Dialog.Description class="sr-only">
      {m.shortcut_cheatsheet_description()}
    </Dialog.Description>

    <div class="max-h-[60vh] space-y-5 overflow-y-auto pr-2">
      {#each CATEGORY_ORDER as cat (cat)}
        <section>
          <h3 class="text-text-muted mb-2 text-xs font-semibold uppercase tracking-wide">
            {CATEGORY_LABELS[cat]}
          </h3>
          <dl class="space-y-0.5">
            {#each itemsFor(cat) as a (a.id)}
              {@const eff = effectiveBinding(settings.shortcuts, a.id)}
              <div class="flex items-center justify-between gap-3 rounded px-1 py-0.5">
                <dt class="text-text-base text-sm">{a.label}</dt>
                <dd
                  class="text-text-bright bg-bg-input shrink-0 rounded px-2 py-0.5 font-mono text-xs"
                >
                  {displayCombo(eff)}
                </dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}

      <section class="border-border border-t pt-4">
        <h3 class="text-text-muted mb-2 text-xs font-semibold uppercase tracking-wide">
          {m.shortcut_cheatsheet_voice_section()}
        </h3>
        <div class="flex items-center justify-between gap-3 rounded px-1 py-0.5">
          <span class="text-text-base text-sm">Push-to-Talk</span>
          <span class="text-text-bright bg-bg-input shrink-0 rounded px-2 py-0.5 font-mono text-xs">
            {settings.voice.pttKey.toUpperCase()}
          </span>
        </div>
        <p class="text-text-muted mt-2 text-xs">
          {m.shortcut_cheatsheet_voice_hint()}
        </p>
      </section>
    </div>

    <div class="mt-4 flex justify-end">
      <button
        type="button"
        onclick={() => (open = false)}
        class="text-text-bright bg-bg-input hover:bg-bg-hover2 rounded-md px-3 py-1.5 text-sm transition-colors"
      >
        {m.shortcut_cheatsheet_close()}
      </button>
    </div>
  </Dialog.Content>
</Dialog.Root>
