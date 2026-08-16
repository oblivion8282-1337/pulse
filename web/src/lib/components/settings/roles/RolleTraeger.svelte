<!--
  Reiter „Mitglieder" — wer traegt diese Rolle.

  „Wer hat das eigentlich" ist die Frage, die vor jeder Rechteaenderung
  kommt, und sie war bisher nur ueber eine zweite, mitgliederzentrierte
  Maske zu beantworten (`MemberRoleAssignment`): dort waehlt man einen
  Menschen und sieht seine Rollen. Beide Richtungen haben ihren Platz —
  diese hier steht neben den Rechten, die man gerade aendert.

  Geteilt wird die Anti-Eskalations-Regel (`roles/zuweisung.ts`) und die
  Traegerliste (`roles/traeger.svelte.ts`), nicht der Aufbau.
-->
<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import XIcon from '@lucide/svelte/icons/x';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { toast } from 'svelte-sonner';
  import type { Role } from '$lib/api/roles';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { sperreFuer } from './zuweisung';
  import { passtZurSuche, type Traegerliste } from './traeger.svelte';

  let {
    guildId,
    role,
    editorPermissions,
    liste
  }: {
    guildId: string;
    role: Role;
    editorPermissions: string;
    liste: Traegerliste;
  } = $props();

  let suche = $state('');
  let inArbeit = $state<Set<string>>(new Set());

  let sperre = $derived(sperreFuer(role, editorPermissions));
  let traeger = $derived(liste.traeger(role.id));
  let treffer = $derived.by(() => {
    const nadel = suche.trim().toLowerCase();
    const offen = liste.ohneRolle(role.id);
    const passend = nadel ? offen.filter((mbr) => passtZurSuche(mbr, nadel)) : offen;
    // Gedeckelt, weil die Auswahl unter einem Eingabefeld sitzt und nicht
    // die halbe Maske einnehmen darf. Wer mehr Treffer hat, tippt weiter.
    return passend.slice(0, 8);
  });

  function name(userId: string): string {
    const mbr = liste.mitglieder.find((x) => x.user_id === userId);
    return mbr?.nickname ?? userCache.displayName(userId);
  }

  async function setzen(userId: string, an: boolean): Promise<void> {
    if (sperre.gesperrt || inArbeit.has(userId)) return;
    inArbeit = new Set([...inArbeit, userId]);
    try {
      await liste.setzen(guildId, role.id, userId, an);
      if (an) suche = '';
    } catch (err) {
      toast.error(m.member_role_assignment_toggle_failed(), {
        description: (err as Error).message
      });
    } finally {
      const naechste = new Set(inArbeit);
      naechste.delete(userId);
      inArbeit = naechste;
    }
  }
</script>

{#if role.is_everyone}
  <!-- @everyone wird nicht vergeben, sie gilt. Ein Hinzufuegen-Feld hier
       waere ein Angebot, das nichts tut. -->
  <p class="text-text-muted text-sm">{m.rollen_traeger_everyone()}</p>
{:else if !liste.geladen}
  <LoadingState label={m.member_role_assignment_loading()} />
{:else}
  <div class="space-y-4" data-testid="rollen-traeger">
    {#if sperre.gesperrt}
      <p class="text-warning text-xs">{sperre.grund}</p>
    {/if}

    {#if traeger.length === 0}
      <EmptyState message={m.rollen_traeger_niemand()} />
    {:else}
      <ul class="flex flex-wrap gap-2">
        {#each traeger as uid (uid)}
          {@const u = userCache.get(uid)}
          <li
            class="bg-bg-hover/60 flex items-center gap-2 rounded-full py-1 pr-1 pl-1.5"
            data-testid={`role-traeger-chip-${uid}`}
          >
            <Avatar.Root class="size-6 shrink-0">
              {#if u?.avatar_url}
                <Avatar.Image src={u.avatar_url} alt="" />
              {/if}
              <Avatar.Fallback class="accent-gradient text-primary-foreground text-[0.6rem] font-semibold">
                {name(uid).slice(0, 1).toUpperCase()}
              </Avatar.Fallback>
            </Avatar.Root>
            <span class="max-w-40 truncate text-sm">{name(uid)}</span>
            <button
              type="button"
              class="hover:bg-destructive/15 hover:text-destructive text-text-muted rounded-full p-1 disabled:opacity-40"
              disabled={sperre.gesperrt || inArbeit.has(uid)}
              onclick={() => setzen(uid, false)}
              aria-label={m.rollen_traeger_entfernen({ name: name(uid) })}
              data-testid={`role-traeger-remove-${uid}`}
            >
              <XIcon class="size-3" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if !sperre.gesperrt}
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <SearchIcon class="text-text-muted size-4 shrink-0" />
          <Input
            bind:value={suche}
            placeholder={m.rollen_traeger_hinzufuegen_platzhalter()}
            class="h-8 text-sm"
            data-testid="role-traeger-suche"
          />
        </div>
        {#if treffer.length === 0}
          <EmptyState message={m.rollen_traeger_alle_drin()} />
        {:else}
          <ul class="border-border max-h-56 divide-y divide-border overflow-y-auto rounded-lg border">
            {#each treffer as mbr (mbr.user_id)}
              <li>
                <button
                  type="button"
                  class="hover:bg-bg-hover flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm disabled:opacity-40"
                  disabled={inArbeit.has(mbr.user_id)}
                  onclick={() => setzen(mbr.user_id, true)}
                  data-testid={`role-traeger-add-${mbr.user_id}`}
                >
                  <PlusIcon class="text-text-muted size-3.5 shrink-0" />
                  <span class="truncate">{name(mbr.user_id)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
{/if}
