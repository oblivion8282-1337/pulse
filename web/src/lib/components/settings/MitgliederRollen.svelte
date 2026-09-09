<!--
  Mitglieder & Rollen — EINE Fläche statt zweier Reiter (Richtung 2,
  Remote-UI-Runde 2026-09-09).

  Links: die Rangleiter (Verwaltung: Reihenfolge, Anlegen) und darunter
  die Mitglieder, gruppiert unter ihrer höchsten Rolle. Rechts: je
  Auswahl das Detail — eine Rolle zeigt `RolleDetail` (Rechte,
  Mitglieder, Darstellung), ein Mitglied zeigt die Rollen-Zuweisung.

  Die Maschinerie (Entwurf, Traegerliste, Speichern, Dirty-Führung) ist
  wörtlich aus `RolesEditor` übernommen — dieser Conductor existierte
  schon und wurde nicht neu erfunden. Die Rollen-Zuweisung je Mitglied
  spiegelt `MemberRoleAssignment` (Toggle + Optimistic-Update +
  Anti-Eskalation via `sperreFuer`); wer die beiden irgendwann
  zusammenführt, zieht diese Kopie dorthin.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
  import { rolesApi, type Role, type RoleCreatePayload } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import RollenLeiter from './roles/RollenLeiter.svelte';
  import RolleAnlegenMenu from './roles/RolleAnlegenMenu.svelte';
  import RolleDetail, { type Reiter } from './roles/RolleDetail.svelte';
  import { Rollenentwurf } from './roles/entwurf.svelte';
  import { Traegerliste, passtZurSuche } from './roles/traeger.svelte';
  import { bewegterAusschnitt } from './roles/reihenfolge';
  import { sperreFuer } from './roles/zuweisung';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { toast } from 'svelte-sonner';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import type { Member } from '$lib/api/types';

  let {
    guildId,
    editorPermissions,
    discardSignal = 0,
    dirty = $bindable(false)
  }: {
    guildId: string;
    editorPermissions: string;
    discardSignal?: number;
    dirty?: boolean;
  } = $props();

  const entwurf = new Rollenentwurf();
  const liste = new Traegerliste();

  let alle = $derived(rolesStore.byGuild[guildId] ?? []);
  let hoechsteZuerst = $derived(
    alle.filter((r) => !r.is_everyone).sort((a, b) => b.position - a.position)
  );
  let everyone = $derived(alle.find((r) => r.is_everyone));

  let selectedId = $state<string | null>(null);
  let autoErste = $state(true);
  let selectedRole = $derived(
    alle.find((r) => r.id === selectedId) ?? (autoErste ? (hoechsteZuerst[0] ?? everyone) : undefined)
  );

  let reiter = $state<Reiter>('rechte');
  let speichert = $state(false);
  let aenderungen = $derived(entwurf.aenderungen(selectedRole));

  let geladenFuer = '';
  $effect(() => {
    const gid = guildId;
    if (!gid || gid === geladenFuer) return;
    geladenFuer = gid;
    untrack(() => void liste.laden(gid));
  });

  function waehlen(id: string | null): void {
    selectedId = id;
    autoErste = false;
    // Eine Rollenauswahl schliesst die Mitglieder-Ansicht — sonst bliebe die
    // Zuweisung des einmal angeklickten Mitglieds für immer stehen und die
    // Rechte wären nie wieder editierbar (Befund 2026-09-09).
    ausgewaehltesMitglied = null;
  }

  let zuletztGeladen = $state<string | null>(null);
  $effect(() => {
    if (selectedRole && selectedRole.id !== zuletztGeladen) {
      entwurf.uebernehmen(selectedRole);
      zuletztGeladen = selectedRole.id;
    }
  });

  $effect(() => {
    dirty = aenderungen > 0;
  });

  let letztesSignal = $state(0);
  $effect(() => {
    const sig = discardSignal;
    if (sig !== letztesSignal) {
      letztesSignal = sig;
      entwurf.uebernehmen(selectedRole);
    }
  });

  async function versuchenZuWechseln(id: string): Promise<void> {
    // Wie in `RolesEditor`: bei ungespeicherten Änderungen nachfragen,
    // statt den Entwurf still wegzuwerfen.
    if (id === selectedRole?.id) return waehlen(id);
    if (!dirty) return waehlen(id);
    const ok = await confirmDialog({
      title: m.roles_editor_switch_confirm_title(),
      description: m.roles_editor_switch_confirm_desc({
        roleName: selectedRole?.name ?? m.roles_editor_this_role()
      }),
      confirmLabel: m.roles_editor_discard_btn(),
      cancelLabel: m.roles_editor_cancel()
    });
    if (ok) waehlen(id);
  }

  async function umsortieren(neu: Role[]): Promise<void> {
    const zug = bewegterAusschnitt(hoechsteZuerst, neu);
    if (zug.art === 'unveraendert') return;
    if (zug.art === 'nicht_darstellbar') {
      toast.error(m.roles_editor_reorder_failed());
      return;
    }
    try {
      const zeilen = await rolesApi.setPositions(guildId, zug.eintraege);
      for (const r of zeilen) rolesStore.upsertRole(r);
    } catch (err) {
      toast.error(m.roles_editor_reorder_failed(), { description: (err as Error).message });
    }
  }

  async function anlegen(payload: RoleCreatePayload): Promise<void> {
    try {
      const r = await rolesApi.create(guildId, payload);
      rolesStore.upsertRole(r);
      waehlen(r.id);
      entwurf.uebernehmen(r);
      zuletztGeladen = r.id;
      reiter = 'rechte';
      toast.success(m.roles_editor_role_created());
    } catch (err) {
      toast.error(m.roles_editor_role_create_failed(), { description: (err as Error).message });
    }
  }

  async function speichern(): Promise<void> {
    if (!selectedRole) return;
    speichert = true;
    try {
      const r = await rolesApi.patch(guildId, selectedRole.id, entwurf.alsAenderung(selectedRole));
      rolesStore.upsertRole(r);
      entwurf.uebernehmen(r);
      toast.success(m.roles_editor_role_saved());
    } catch (err) {
      toast.error(m.roles_editor_save_failed(), { description: (err as Error).message });
    } finally {
      speichert = false;
    }
  }

  function geloescht(roleId: string): void {
    liste.rolleVergessen(roleId);
    waehlen(null);
  }

  // ── Mitgliederseite ────────────────────────────────────────────────────

  let mitgliedFilter = $state('');
  /** Was die linke Spalte zeigt — Rollenleiter oder Mitgliedergruppen. */
  let linkeAnsicht = $state<'rollen' | 'mitglieder'>('rollen');
  let ausgewaehltesMitglied = $state<string | null>(null);
  /** user_id → Rollen-IDs für die Zuweisungs-Checkboxen (ohne @everyone). */
  let mitgliedRollen = $state<Record<string, Set<string>>>({});
  let busy = $state<Set<string>>(new Set());

  let assignableRoles = $derived(
    (rolesStore.byGuild[guildId] ?? [])
      .filter((r) => !r.is_everyone)
      .sort((a, b) => b.position - a.position)
  );

  function displayName(mbr: Member): string {
    return mbr.nickname ?? userCache.displayName(mbr.user_id);
  }

  async function mitgliedWaehlen(userId: string): Promise<void> {
    ausgewaehltesMitglied = userId;
    if (mitgliedRollen[userId]) return;
    try {
      const rows = await rolesApi.listMemberRoles(guildId, userId);
      mitgliedRollen = {
        ...mitgliedRollen,
        [userId]: new Set(rows.filter((r) => !r.is_everyone).map((r) => r.id))
      };
    } catch (err) {
      toast.error(m.member_role_assignment_load_member_roles_failed(), {
        description: (err as Error).message
      });
    }
  }

  async function toggle(userId: string, role: Role, on: boolean): Promise<void> {
    // Spiegel von `MemberRoleAssignment::toggle` — gleicher Optimistic-
    // Update- und Rollback-Tanz; siehe den Kommentar dort.
    const key = `${userId}:${role.id}`;
    if (busy.has(key)) return;
    busy = new Set([...busy, key]);
    const existing = mitgliedRollen[userId] ?? new Set<string>();
    const next = new Set(existing);
    if (on) next.add(role.id);
    else next.delete(role.id);
    mitgliedRollen = { ...mitgliedRollen, [userId]: next };
    try {
      if (on) await rolesApi.assign(guildId, userId, role.id);
      else await rolesApi.unassign(guildId, userId, role.id);
    } catch (err) {
      const rollback = new Set(mitgliedRollen[userId] ?? existing);
      if (on) rollback.delete(role.id);
      else rollback.add(role.id);
      mitgliedRollen = { ...mitgliedRollen, [userId]: rollback };
      toast.error(m.member_role_assignment_toggle_failed(), { description: (err as Error).message });
    } finally {
      const nextBusy = new Set(busy);
      nextBusy.delete(key);
      busy = nextBusy;
    }
  }

  /** Mitglieder unter ihrer höchsten Rolle gruppiert; die Suche filtert
   *  die Zeilen, leere Gruppen fallen weg. `@everyone` fängt auf, wer
   *  keine zugewiesene Rolle trägt. */
  const gruppen = $derived.by(() => {
    const needle = mitgliedFilter.trim().toLowerCase();
    const sichtbar = liste.geladen
      ? liste.mitglieder.filter((mbr) => !needle || passtZurSuche(mbr, needle))
      : [];
    const gruppen: { rolle: Role; mitglieder: Member[] }[] = hoechsteZuerst.map((r) => ({
      rolle: r,
      mitglieder: []
    }));
    const index = new Map(gruppen.map((g, i) => [g.rolle.id, i]));
    const rest: { rolle: Role; mitglieder: Member[] }[] = everyone
      ? [{ rolle: everyone, mitglieder: [] }]
      : [];
    for (const mbr of sichtbar) {
      const ids = liste.rollen[mbr.user_id] ?? [];
      const hoechste = ids
        .map((id) => alle.find((r) => r.id === id))
        .filter((r): r is Role => !!r)
        .sort((a, b) => b.position - a.position)[0];
      const ziel = hoechste && index.has(hoechste.id) ? index.get(hoechste.id)! : -1;
      if (ziel >= 0) gruppen[ziel].mitglieder.push(mbr);
      else if (rest[0]) rest[0].mitglieder.push(mbr);
      else gruppen[gruppen.length - 1]?.mitglieder.push(mbr);
    }
    return [...gruppen, ...rest].filter((g) => g.mitglieder.length > 0);
  });
</script>

<div class="flex h-full min-h-0 flex-col gap-4 md:flex-row" data-testid="mitglieder-rollen">
  <aside class="flex w-full shrink-0 flex-col gap-4 md:w-80">
    <div class="flex items-center justify-between">
      <!-- Zwei Reiter anstelle zweier Reiter im Dialog-Rahmen: Rollen und
           Mitglieder teilen sich die linke Spalte (Richtung 2). -->
      <div class="border-border flex gap-1 border-b" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={linkeAnsicht === 'rollen'}
          class="-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors"
          class:border-primary={linkeAnsicht === 'rollen'}
          class:text-text-bright={linkeAnsicht === 'rollen'}
          class:border-transparent={linkeAnsicht !== 'rollen'}
          class:text-text-muted={linkeAnsicht !== 'rollen'}
          onclick={() => (linkeAnsicht = 'rollen')}
          data-testid="mitglieder-rollen-tab-rollen"
        >
          {m.roles_editor_roles_heading()}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={linkeAnsicht === 'mitglieder'}
          class="-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors"
          class:border-primary={linkeAnsicht === 'mitglieder'}
          class:text-text-bright={linkeAnsicht === 'mitglieder'}
          class:border-transparent={linkeAnsicht !== 'mitglieder'}
          class:text-text-muted={linkeAnsicht !== 'mitglieder'}
          onclick={() => (linkeAnsicht = 'mitglieder')}
          data-testid="mitglieder-rollen-tab-mitglieder"
        >
          {m.guild_settings_dialog_tab_members()}
        </button>
      </div>
      {#if linkeAnsicht === 'rollen'}
        <RolleAnlegenMenu {editorPermissions} auswahl={selectedRole} oncreate={anlegen} />
      {/if}
    </div>

    {#if linkeAnsicht === 'rollen'}
      <RollenLeiter
        rollen={hoechsteZuerst}
        {everyone}
        selectedId={selectedRole?.id}
        anzahl={(r) => liste.anzahl(r.id, r.is_everyone)}
        onselect={versuchenZuWechseln}
        onreorder={umsortieren}
        nameEntwurf={entwurf.name}
        onName={(wert) => (entwurf.name = wert)}
      />
    {:else}
      <div class="min-h-0">
        <div class="mb-2 flex items-center gap-2">
          <SearchIcon class="text-text-muted size-4" />
          <Input
            bind:value={mitgliedFilter}
            placeholder={m.member_role_assignment_search_placeholder()}
            class="h-8 text-sm"
            data-testid="member-filter"
          />
        </div>
        <div class="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
          {#each gruppen as gruppe (gruppe.rolle.id)}
            <div>
              <button
                type="button"
                class="text-text-muted hover:text-text-bright flex w-full items-center gap-1.5 px-1 py-0.5 text-left text-xs font-semibold tracking-wide uppercase transition-colors"
                onclick={() => versuchenZuWechseln(gruppe.rolle.id)}
                data-testid={`mitglieder-gruppe-${gruppe.rolle.id}`}
              >
                <span
                  class="size-2 shrink-0 rounded-full"
                  style={gruppe.rolle.color ? `background: #${gruppe.rolle.color.toString(16).padStart(6, '0')}` : ''}
                ></span>
                {gruppe.rolle.name}
                <span class="text-text-faint ml-auto">{gruppe.mitglieder.length}</span>
              </button>
              <ul class="mt-0.5 space-y-0.5">
                {#each gruppe.mitglieder as mbr (mbr.user_id)}
                  <li>
                    <button
                      type="button"
                      class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
                      class:bg-bg-hover={ausgewaehltesMitglied === mbr.user_id}
                      onclick={() => mitgliedWaehlen(mbr.user_id)}
                      data-testid={`member-row-${mbr.user_id}`}
                    >
                      <span class="text-text-bright truncate font-medium">{displayName(mbr)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
          {#if gruppen.length === 0}
            <EmptyState message={m.member_role_assignment_no_results()} />
          {/if}
        </div>
      </div>
    {/if}
  </aside>

  <section class="flex min-w-0 flex-1 flex-col overflow-y-auto">
    {#if ausgewaehltesMitglied}
      {@const selMember = liste.mitglieder.find((mbr) => mbr.user_id === ausgewaehltesMitglied)}
      <header class="mb-3">
        <h3 class="text-text-bright text-sm font-semibold">
          {m.member_role_assignment_roles_for({ name: selMember ? displayName(selMember) : (ausgewaehltesMitglied ?? '') })}
        </h3>
        <p class="text-text-muted text-xs">{m.member_role_assignment_position_hint()}</p>
      </header>
      {#if !mitgliedRollen[ausgewaehltesMitglied]}
        <p class="text-text-muted text-xs">{m.member_role_assignment_loading_roles()}</p>
      {:else if assignableRoles.length === 0}
        <EmptyState message={m.member_role_assignment_no_assignable_roles()} />
      {:else}
        <ul class="divide-border divide-y">
          {#each assignableRoles as r (r.id)}
            {@const lock = sperreFuer(r, editorPermissions)}
            {@const checked = mitgliedRollen[ausgewaehltesMitglied]!.has(r.id)}
            {@const key = `${ausgewaehltesMitglied}:${r.id}`}
            <li class="flex items-center justify-between py-2">
              <div class="min-w-0">
                <div
                  class="text-text-bright text-sm font-medium"
                  style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}
                >
                  {r.name}
                </div>
                <div class="text-text-muted text-xs">
                  {m.member_role_assignment_position({ position: r.position })}
                </div>
                {#if lock.gesperrt}
                  <div class="text-xs text-warning">{lock.grund}</div>
                {/if}
              </div>
              <Checkbox
                {checked}
                disabled={lock.gesperrt || busy.has(key)}
                onchange={(ev) =>
                  toggle(ausgewaehltesMitglied!, r, (ev.currentTarget as HTMLInputElement).checked)}
                data-testid={`assign-${ausgewaehltesMitglied}-${r.id}`}
              />
            </li>
          {/each}
        </ul>
      {/if}
    {:else if selectedRole}
      <RolleDetail
        {guildId}
        {editorPermissions}
        role={selectedRole}
        {entwurf}
        {liste}
        {speichert}
        {dirty}
        {aenderungen}
        bind:reiter
        onsave={speichern}
        ondiscard={() => entwurf.uebernehmen(selectedRole)}
        ondeleted={geloescht}
      />
    {:else}
      <EmptyState message={m.roles_editor_empty_hint()} />
    {/if}
  </section>
</div>
