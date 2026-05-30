<script lang="ts">
  /**
   * "Tastatur"-Tab im Settings-Dialog. Listet alle ActionDefs aus
   * lib/shortcuts/actions.ts gruppiert nach Kategorie, mit Rebind-Knopf
   * pro Zeile (Pattern aus SettingsAudioVideo::startPttCapture).
   */
  import {
    ACTIONS,
    ACTION_BY_ID,
    CATEGORY_ORDER,
    CATEGORY_LABELS,
    type ActionDef,
    type ActionId
  } from '$lib/shortcuts/actions';
  import { effectiveBinding } from '$lib/shortcuts/persistence';
  import { conflictWith } from '$lib/shortcuts/registry';
  import { eventToCombo, displayCombo, isPureModifier } from '$lib/shortcuts/format';
  import { settings } from '$lib/stores/settings.svelte';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import { m } from '$lib/paraglide/messages.js';

  let listeningId = $state<ActionId | null>(null);
  let cleanupCapture: (() => void) | null = null;

  function endCapture(): void {
    cleanupCapture?.();
    cleanupCapture = null;
    listeningId = null;
  }

  function startCapture(id: ActionId): void {
    if (listeningId === id) {
      endCapture();
      return;
    }
    // If another capture is running, kill it first.
    endCapture();
    listeningId = id;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const key = (e.key || '').toLowerCase();
      // Pure modifier presses are mid-combo — wait for the actual key.
      if (isPureModifier(key)) return;
      // Esc = abort without saving. Backspace = explicit unbind.
      if (key === 'escape') {
        endCapture();
        return;
      }
      if (key === 'backspace') {
        settings.unbindShortcut(id);
        endCapture();
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) {
        endCapture();
        return;
      }
      const other = conflictWith(settings.shortcuts, combo, id);
      if (other) {
        const otherLabel = ACTION_BY_ID[other].label;
        const ok = window.confirm(
          m.settings_keyboard_conflict_confirm({ combo: displayCombo(combo), otherLabel })
        );
        if (!ok) {
          endCapture();
          return;
        }
        settings.unbindShortcut(other);
      }
      settings.setShortcutBinding(id, combo);
      endCapture();
    };
    cleanupCapture = () => window.removeEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onKey, true);
  }

  function resetOne(id: ActionId): void {
    settings.resetShortcut(id);
  }

  function resetAll(): void {
    if (!window.confirm(m.settings_keyboard_reset_all_confirm())) return;
    settings.resetAllShortcuts();
  }

  function itemsFor(cat: string): readonly ActionDef[] {
    return ACTIONS.filter((a) => a.category === cat);
  }
</script>

<div class="space-y-6">
  <header class="flex items-baseline justify-between gap-3">
    <div>
      <h2 class="text-text-bright text-base font-semibold">{m.settings_keyboard_title()}</h2>
      <p class="text-text-muted mt-1 text-xs">
        {m.settings_keyboard_hint_before_esc()} <kbd class="font-mono">Esc</kbd> =
        {m.settings_keyboard_hint_esc()}, <kbd class="font-mono">Backspace</kbd> = {m.settings_keyboard_hint_backspace()}.
      </p>
    </div>
    <button
      type="button"
      onclick={resetAll}
      class="text-text-muted hover:text-text-base hover:bg-bg-hover shrink-0 rounded-lg px-2 py-1.5 text-xs transition-colors md:py-1"
      data-testid="shortcuts-reset-all"
    >
      {m.settings_keyboard_reset_all()}
    </button>
  </header>

  {#each CATEGORY_ORDER as cat (cat)}
    <section>
      <h3 class="text-text-muted mb-2 text-xs font-semibold uppercase tracking-wide">
        {CATEGORY_LABELS[cat]}
      </h3>
      <div class="space-y-1">
        {#each itemsFor(cat) as a (a.id)}
          {@const eff = effectiveBinding(settings.shortcuts, a.id)}
          {@const isDefault = !(a.id in settings.shortcuts.overrides)}
          <div class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-1.5">
            <div class="min-w-0 flex-1">
              <p class="text-text-bright text-sm">{a.label}</p>
              <p class="text-text-muted text-xs">{a.description}</p>
            </div>
            <button
              type="button"
              onclick={() => startCapture(a.id)}
              class="text-text-bright bg-bg-input hover:bg-bg-hover2 min-w-fit rounded-md px-3 py-2 text-center font-mono text-xs transition-colors md:min-w-[6.5rem] md:py-1 {listeningId ===
              a.id
                ? 'ring-2 ring-primary'
                : ''}"
              data-testid="shortcut-binding-{a.id}"
            >
              {listeningId === a.id ? m.settings_keyboard_press_key() : displayCombo(eff)}
            </button>
            <button
              type="button"
              onclick={() => resetOne(a.id)}
              disabled={isDefault}
              class="text-text-muted hover:text-text-base hover:bg-bg-hover2 rounded-md p-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent md:p-1"
              aria-label={m.settings_keyboard_reset_one()}
              title={m.settings_keyboard_reset_one()}
            >
              <RotateCcwIcon class="size-3.5" />
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/each}

  <section class="border-border text-text-muted border-t pt-4 text-xs">
    <p>
      <strong class="text-text-base">{m.settings_keyboard_ptt_label()}</strong> {m.settings_keyboard_ptt_hint_before_key()}
      <span class="font-mono">{settings.voice.pttKey}</span>{m.settings_keyboard_ptt_hint_after_key()}
    </p>
  </section>
</div>
