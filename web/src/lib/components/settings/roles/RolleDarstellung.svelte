<!--
  Reiter „Darstellung" — Farbe, getrennt anzeigen, erwaehnbar.

  Drei Eigenschaften, die nichts erlauben und nichts verbieten. Sie standen
  bisher zwischen Namen und Rechteliste und liessen die Maske nach
  Einstellungen aussehen, wo sie nach Macht aussehen sollte; hier stoeren
  sie niemanden und sind trotzdem in einem Klick da.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { Rollenentwurf } from './entwurf.svelte';

  let { entwurf, disabled = false }: { entwurf: Rollenentwurf; disabled?: boolean } = $props();
</script>

<div class="space-y-6">
  <div class="space-y-2">
    <Label>{m.roles_editor_color_label()}</Label>
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={entwurf.farbeAn} {disabled} data-testid="role-color-enabled" />
        {m.roles_editor_color_use()}
      </label>
      <input
        type="color"
        bind:value={entwurf.farbe}
        disabled={!entwurf.farbeAn || disabled}
        class="border-border h-8 w-16 cursor-pointer rounded border bg-transparent disabled:opacity-40"
        data-testid="role-color-input"
        aria-label={m.roles_editor_color_pick()}
      />
      <span class="text-sm font-medium" style={entwurf.farbeAn ? `color: ${entwurf.farbe}` : ''}>
        {entwurf.name || m.roles_editor_role_name_placeholder()}
      </span>
    </div>
    <p class="text-text-muted text-xs">{m.roles_editor_color_hint()}</p>
  </div>

  <div class="space-y-3">
    <label class="flex items-start gap-2 text-sm">
      <Checkbox class="mt-0.5" bind:checked={entwurf.hervorheben} {disabled} data-testid="role-hoist" />
      <span>
        {m.roles_editor_hoist_label()}
        <span class="text-text-muted block text-xs">{m.rollen_darstellung_hoist_kurz()}</span>
      </span>
    </label>
    <label class="flex items-start gap-2 text-sm">
      <Checkbox
        class="mt-0.5"
        bind:checked={entwurf.erwaehnbar}
        {disabled}
        data-testid="role-mentionable"
      />
      <span>
        {m.roles_editor_mentionable_label()}
        <span class="text-text-muted block text-xs">{m.rollen_darstellung_erwaehnbar_kurz()}</span>
      </span>
    </label>
  </div>
</div>
