<!--
  Rollenverwaltung einer Community.

  Links eine Rangleiter, rechts das Detail in drei Reitern. Der
  Backend-Riegel ist MANAGE_ROLES; das Elternteil prueft ihn, bevor es
  diese Maske einhaengt. Diese Datei ist nur noch der Dirigent — Leiter,
  Detail, Anlegen und Loeschen liegen daneben in `roles/`.

  Zwei Dinge, die hier NICHT verlorengehen duerfen (beide teuer erkauft):
    * Umsortieren schickt nur den bewegten Bereich (`roles/reihenfolge.ts`)
      — die ganze Liste durchzunummerieren warf jeden Pfeilklick fuer
      alle ausser Besitzer/Instanz-Admin auf 403.
    * Nach dem Loeschen wird KEINE Rolle ersatzweise ausgewaehlt. Sonst
      rueckt die Auswahl still nach und der Loeschbefehl ist an derselben
      Stelle sofort wieder scharf — zweimal Loeschen traefe zwei Rollen.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role, type RoleCreatePayload } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import RollenLeiter from './roles/RollenLeiter.svelte';
  import RolleAnlegenMenu from './roles/RolleAnlegenMenu.svelte';
  import RolleDetail, { type Reiter } from './roles/RolleDetail.svelte';
  import { Rollenentwurf } from './roles/entwurf.svelte';
  import { Traegerliste } from './roles/traeger.svelte';
  import { bewegterAusschnitt } from './roles/reihenfolge';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';

  let {
    guildId,
    editorPermissions,
    discardSignal = 0,
    dirty = $bindable(false)
  }: {
    guildId: string;
    editorPermissions: string;
    /** Zaehler, den das Elternteil hochsetzt, um den Entwurf zu verwerfen
     * (Reiterwechsel / Schliessen-Rueckfrage). Ein blosses Zuruecksetzen von
     * `dirty` genuegte nicht: unser Effekt leitete es im naechsten Takt aus
     * Entwurf ≠ gespeicherter Rolle wieder her. */
    discardSignal?: number;
    /** Ob der Entwurf von der gespeicherten Rolle abweicht. Das Elternteil
     * (Einstellungsdialog) haengt seine Schliessen-Rueckfrage daran. */
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
  /** Beim ersten Anzeigen darf die oberste Rolle ersatzweise einspringen,
   * damit die Maske nicht leer aufgeht. Danach nicht mehr — siehe die
   * Loesch-Begruendung im Kopf dieser Datei. */
  let autoErste = $state(true);
  let selectedRole = $derived(
    alle.find((r) => r.id === selectedId) ?? (autoErste ? (hoechsteZuerst[0] ?? everyone) : undefined)
  );

  let reiter = $state<Reiter>('rechte');

  let speichert = $state(false);
  let aenderungen = $derived(entwurf.aenderungen(selectedRole));

  // Traegerzahlen einmal je Community holen. `untrack`, damit der Effekt
  // nicht an den Zustandsfeldern der Liste haengt, die das Laden selbst
  // schreibt (sonst laeuft er waehrend seines eigenen Ladevorgangs neu).
  let geladenFuer = '';
  $effect(() => {
    const gid = guildId;
    if (!gid || gid === geladenFuer) return;
    geladenFuer = gid;
    untrack(() => void liste.laden(gid));
  });

  /** Einzige Stelle, an der die Auswahl gesetzt wird — damit der Ersatz
   * oben nie versehentlich wieder greift. `null` = Leerzustand. */
  function waehlen(id: string | null): void {
    selectedId = id;
    autoErste = false;
  }

  // Uebernahme in den Entwurf passiert ausdruecklich beim Wechsel, nicht
  // laufend: ein Effekt, der die Rolle staendig spiegelt, wuerfe die
  // Eingabe des Nutzers weg, sobald ein `role_updated` hereinkommt.
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

  let wechselZiel = $state<string | null>(null);
  let wechselRueckfrage = $state(false);

  function versuchenZuWechseln(id: string): void {
    // Bereits gezeigt: nur festnageln, keine Rueckfrage (es wechselt ja
    // nichts). Ohne das Festnageln stuende die Auswahl beim Ersatz oben
    // weiter auf `null` und wanderte beim naechsten Umsortieren still mit.
    if (id === selectedRole?.id) return waehlen(id);
    if (dirty) {
      wechselZiel = id;
      wechselRueckfrage = true;
      return;
    }
    waehlen(id);
  }

  function wechselBestaetigen(): void {
    if (wechselZiel) {
      waehlen(wechselZiel);
      wechselZiel = null;
    }
    wechselRueckfrage = false;
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
      // Entwurf sofort setzen und `zuletztGeladen` festnageln, damit der
      // Auswahl-Effekt nicht im naechsten Takt eine bereits getippte
      // Eingabe ueberschreibt (Name antippen direkt nach dem Anlegen).
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
      // Neu uebernehmen, damit `dirty` zurueckfaellt — sonst raece der
      // frische Rollenstand aus `upsertRole` mit dem Entwurf.
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
</script>

<div class="flex h-full min-h-0 flex-col gap-4 md:flex-row" data-testid="roles-editor">
  <aside class="w-full shrink-0 md:w-72">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-text-bright text-base font-semibold">{m.roles_editor_roles_heading()}</h2>
      <RolleAnlegenMenu {editorPermissions} auswahl={selectedRole} oncreate={anlegen} />
    </div>
    <RollenLeiter
      rollen={hoechsteZuerst}
      {everyone}
      selectedId={selectedRole?.id}
      anzahl={(r) => liste.anzahl(r.id, r.is_everyone)}
      onselect={versuchenZuWechseln}
      onreorder={umsortieren}
    />
  </aside>

  <section class="flex min-w-0 flex-1 flex-col">
    {#if selectedRole}
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

<AlertDialog.Root bind:open={wechselRueckfrage}>
  <AlertDialog.Content data-testid="role-switch-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.roles_editor_switch_confirm_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.roles_editor_switch_confirm_desc({
          roleName: selectedRole?.name ?? m.roles_editor_this_role()
        })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.roles_editor_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={wechselBestaetigen}>
        {m.roles_editor_discard_btn()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
