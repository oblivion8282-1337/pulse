<!--
  Die rechte Haelfte der Rollenverwaltung: Name, drei Reiter, Leiste unten.

  Der Name steht UEBER den Reitern und nicht in einem davon — er ist die
  Identitaet der Rolle, nicht eine ihrer Eigenschaften; wer ihn sucht,
  soll ihn nicht erst finden muessen.

  Die Reiter trennen drei verschiedene Fragen: was die Rolle DARF
  (Rechte), wer sie HAT (Mitglieder), und wie sie AUSSIEHT (Darstellung).
  Vorher standen alle drei untereinander, und die dritte, harmloseste
  stand ganz oben.
-->
<script lang="ts" module>
  /** Die drei Fragen an eine Rolle. Steht im Modul-Block, weil das
   * Elternteil den ausgewaehlten Reiter haelt (Anlegen setzt ihn zurueck)
   * und dafuer den Typ braucht. */
  export type Reiter = 'rechte' | 'mitglieder' | 'darstellung';
</script>

<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Role } from '$lib/api/roles';
  import { m } from '$lib/paraglide/messages.js';
  import PermissionToggleGrid from '../PermissionToggleGrid.svelte';
  import RolleTraeger from './RolleTraeger.svelte';
  import RolleDarstellung from './RolleDarstellung.svelte';
  import RolleLoeschen from './RolleLoeschen.svelte';
  import type { Rollenentwurf } from './entwurf.svelte';
  import type { Traegerliste } from './traeger.svelte';

  let {
    guildId,
    editorPermissions,
    role,
    entwurf,
    liste,
    speichert = false,
    dirty = false,
    aenderungen = 0,
    reiter = $bindable<Reiter>('rechte'),
    onsave,
    ondiscard,
    ondeleted
  }: {
    guildId: string;
    editorPermissions: string;
    role: Role;
    entwurf: Rollenentwurf;
    liste: Traegerliste;
    speichert?: boolean;
    dirty?: boolean;
    /** Zahl fuer die Leiste unten. */
    aenderungen?: number;
    reiter?: Reiter;
    onsave: () => void;
    ondiscard: () => void;
    ondeleted: (roleId: string) => void;
  } = $props();

  let traegerzahl = $derived(liste.anzahl(role.id, role.is_everyone));
  let reiterListe = $derived<[Reiter, string][]>([
    ['rechte', m.rollen_reiter_rechte()],
    ['mitglieder', m.rollen_reiter_mitglieder()],
    ['darstellung', m.rollen_reiter_darstellung()]
  ]);
</script>

<div class="mb-4 flex items-end gap-2">
  <div class="min-w-0 flex-1 space-y-2">
    <Label for="role-name">{m.roles_editor_name_label()}</Label>
    <Input
      id="role-name"
      bind:value={entwurf.name}
      disabled={role.is_everyone}
      data-testid="role-name-input"
    />
    {#if role.is_everyone}
      <p class="text-text-muted text-xs">{m.roles_editor_everyone_no_rename()}</p>
    {/if}
  </div>
  <RolleLoeschen {guildId} {role} mitgliederZahl={traegerzahl} {ondeleted} />
</div>

<div class="border-border mb-4 flex gap-1 border-b" role="tablist">
  {#each reiterListe as [id, titel] (id)}
    <button
      type="button"
      role="tab"
      aria-selected={reiter === id}
      class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors"
      class:border-primary={reiter === id}
      class:text-text-bright={reiter === id}
      class:border-transparent={reiter !== id}
      class:text-text-muted={reiter !== id}
      onclick={() => (reiter = id)}
      data-testid={`role-tab-${id}`}
    >
      {titel}{id === 'mitglieder' && traegerzahl !== null ? ` · ${traegerzahl}` : ''}
    </button>
  {/each}
</div>

<!-- `tabindex` gehoert an eine blaetterbare Flaeche: ohne ihn kaeme man mit
     der Tastatur nicht an den Inhalt, den man gerade aufgeschlagen hat. -->
<div class="min-h-0 flex-1 overflow-y-auto pr-1" role="tabpanel" tabindex="0">
  {#if reiter === 'rechte'}
    <PermissionToggleGrid bind:value={entwurf.rechte} {editorPermissions} disabled={speichert} />
  {:else if reiter === 'mitglieder'}
    <RolleTraeger {guildId} {role} {editorPermissions} {liste} />
  {:else}
    <RolleDarstellung {entwurf} disabled={speichert} />
  {/if}
</div>

<div
  class="border-border bg-bg-input/60 mt-4 flex items-center justify-between gap-2 rounded-xl border px-3 py-2"
>
  <span class="text-text-muted text-xs" data-testid="role-change-count">
    {aenderungen > 0
      ? m.rollen_leiste_aenderungen({ count: aenderungen })
      : m.roles_editor_no_changes()}
  </span>
  <div class="flex gap-2">
    <Button
      variant="ghost"
      size="sm"
      onclick={ondiscard}
      disabled={!dirty || speichert}
      data-testid="role-discard"
    >
      {m.roles_editor_discard_btn()}
    </Button>
    <Button onclick={onsave} disabled={!dirty || speichert} data-testid="role-save">
      {speichert ? m.roles_editor_saving() : m.roles_editor_save_btn()}
    </Button>
  </div>
</div>
