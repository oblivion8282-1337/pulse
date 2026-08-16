<!--
  Das ⋯-Menue am Kopf der Rollenmaske und die Loeschrueckfrage.

  Loeschen sitzt bewusst NICHT als Knopf neben dem Namensfeld: es ist die
  einzige Handlung hier, die nichts zurueckgibt, und ein Knopf, der immer
  neben dem Cursor steht, wird irgendwann getroffen.

  Die Rueckfrage sagt, was das Loeschen kostet: wie viele Mitglieder die
  Rolle verlieren und wie viele Kanaele ihre Abweichung fuer sie verlieren.
  Was sich nicht sicher ermitteln laesst, wird WEGGELASSEN statt geraten —
  eine zu niedrige Zahl liest sich wie eine Entwarnung.
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { kanaeleMitAbweichung } from './kanalabweichungen';

  let {
    guildId,
    role,
    mitgliederZahl,
    ondeleted
  }: {
    guildId: string;
    /** Die gerade gewaehlte Rolle. `@everyone` blendet das Menue aus. */
    role: Role;
    /** Traeger der Rolle, oder `null` wenn nicht verlaesslich bekannt. */
    mitgliederZahl: number | null;
    ondeleted: (roleId: string) => void;
  } = $props();

  let rueckfrage = $state(false);
  /** Ziel beim Oeffnen festhalten: die Auswahl ist abgeleitet und kann
   * sich waehrend der Rueckfrage verschieben (WS-Ereignis, Neusortierung)
   * — so nennt der Text die Rolle, die auch wirklich faellt. Wird beim
   * naechsten Oeffnen ueberschrieben statt beim Schliessen geleert, sonst
   * flackert der Text waehrend des Zuklappens leer. */
  let ziel = $state<Role | undefined>(undefined);
  let zielMitglieder = $state<number | null>(null);
  /** `null` = noch nicht ermittelt ODER nicht ermittelbar. Beides fuehrt zur
   * selben Anzeige, naemlich gar keiner — siehe Kopf dieser Datei. */
  let zielKanaele = $state<number | null>(null);
  let loescht = $state(false);

  async function fragen(): Promise<void> {
    if (role.is_everyone) return;
    ziel = role;
    zielMitglieder = mitgliederZahl;
    zielKanaele = null;
    rueckfrage = true;
    const id = role.id;
    const n = await kanaeleMitAbweichung(guildId, id);
    // Waehrend des Ladens kann die Rueckfrage laengst wieder zu sein oder
    // auf einer anderen Rolle stehen — dann gehoert die Zahl nicht hierher.
    if (ziel?.id !== id) return;
    zielKanaele = n;
  }

  async function loeschen(): Promise<void> {
    const t = ziel;
    // `loescht` sperrt den Knopf zusaetzlich: bits-ui schliesst den Dialog
    // beim Bestaetigen nicht selbst (die Vendor-Action ueberschreibt den
    // Schliess-Handler), ein zweiter Klick im Flug schickte sonst dasselbe
    // DELETE erneut → 404-Toast fuer eine laengst geloeschte Rolle.
    if (!t || t.is_everyone || loescht) return;
    loescht = true;
    try {
      await rolesApi.delete(guildId, t.id);
      rolesStore.removeRole(guildId, t.id);
      ondeleted(t.id);
      toast.success(m.roles_editor_role_deleted());
    } catch (err) {
      toast.error(m.roles_editor_delete_failed(), { description: (err as Error).message });
    } finally {
      loescht = false;
      // Auch im Fehlerfall zu — sonst steht der Dialog offen da, ohne dass
      // man sieht warum; der Grund steht im Toast.
      rueckfrage = false;
    }
  }
</script>

{#if !role.is_everyone}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          size="icon-sm"
          variant="ghost"
          aria-label={m.rollen_menue_knopf()}
          data-testid="role-more-menu"
        >
          <MoreHorizontalIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item variant="destructive" onSelect={fragen} data-testid="role-delete-btn">
        <TrashIcon class="size-4" />
        {m.roles_editor_delete_btn()}
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<AlertDialog.Root bind:open={rueckfrage}>
  <AlertDialog.Content data-testid="role-delete-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.roles_editor_delete_confirm_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.roles_editor_delete_confirm_desc({
          roleName: ziel?.name ?? m.roles_editor_this_role()
        })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <ul class="text-text-muted space-y-1 text-sm" data-testid="role-delete-folgen">
      {#if zielMitglieder !== null}
        <li>{m.rollen_loeschen_folge_mitglieder({ count: zielMitglieder })}</li>
      {/if}
      {#if zielKanaele !== null}
        <li>{m.rollen_loeschen_folge_kanaele({ count: zielKanaele })}</li>
      {/if}
    </ul>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={loescht}>{m.roles_editor_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={loeschen} disabled={loescht} data-testid="role-delete-confirm-btn">
        {m.roles_editor_delete_btn()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
