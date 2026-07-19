<!--
  Instanzweite Member-Verwaltung (F11c). Listet die `cached_user_profiles`
  dieser Self-Host-Instanz (= die Nutzer, die sich je per Cert-Login angemeldet
  haben) und erlaubt instanzweites Bannen/Entbannen. Ein Ban verweigert dem
  Nutzer beim nächsten Cert-Login das Session-Token (403). Nur auf Self-Host
  gerendert (das +page.svelte gated mit `{:else}` zu AdminUsers).

  Inline-Deutsch wie die anderen Self-Host-Admin-Komponenten (kein paraglide).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { adminApi, type InstanceMember } from '$lib/api/admin';
  import UsersIcon from '@lucide/svelte/icons/users';
  import BanIcon from '@lucide/svelte/icons/ban';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let members = $state<InstanceMember[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Ban-Dialog
  let banTarget = $state<InstanceMember | null>(null);
  let banOpen = $state(false);
  let banReason = $state('');
  let banning = $state(false);
  let banError = $state<string | null>(null);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    loading = true;
    error = null;
    try {
      members = await adminApi.listMembers();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function replaceRow(updated: InstanceMember) {
    members = members.map((m) =>
      m.user_identifier === updated.user_identifier ? updated : m
    );
  }

  async function doBan() {
    if (!banTarget) return;
    banning = true;
    banError = null;
    try {
      const updated = await adminApi.banMember(
        banTarget.user_identifier,
        banReason.trim() || undefined
      );
      replaceRow(updated);
      toast.success(`${banTarget.username} wurde instanzweit gebannt.`);
      banOpen = false;
      banReason = '';
      banTarget = null;
    } catch (e) {
      banError = e instanceof Error ? e.message : String(e);
    } finally {
      banning = false;
    }
  }

  async function doUnban(member: InstanceMember) {
    busy[member.user_identifier] = true;
    try {
      const updated = await adminApi.unbanMember(member.user_identifier);
      replaceRow(updated);
      toast.success(`${member.username} wurde entbannt.`);
    } catch (e) {
      toast.error('Entbannen fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[member.user_identifier] = false;
    }
  }

  function initials(name: string): string {
    return (name || '?').slice(0, 2).toUpperCase();
  }
</script>

<section
  class="rounded-2xl border border-border bg-bg-input p-5"
  data-testid="admin-members"
>
  <div class="mb-4 flex items-start gap-3">
    <UsersIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">Mitglieder</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Nutzer dieser Instanz. Ein Ban verweigert dem Nutzer beim nächsten
        Cert-Login den Zugang.
      </p>
    </div>
  </div>

  {#if loading}
    <LoadingState label="Lade…" />
  {:else if error}
    <FieldError message="Fehler: {error}" />
  {:else if members.length === 0}
    <EmptyState message="Noch keine Mitglieder — Nutzer erscheinen hier nach dem ersten Cert-Login." />
  {:else}
    <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border">
      {#each members as member (member.user_identifier)}
        <li
          class="flex items-center justify-between gap-3 p-3"
          class:opacity-70={member.banned_at !== null}
          data-testid="member-row"
        >
          <div class="flex min-w-0 items-center gap-3">
            <Avatar.Root class="size-8 shrink-0">
              <Avatar.Fallback
                class="accent-gradient text-primary-foreground text-xs font-semibold"
              >
                {initials(member.display_name || member.username)}
              </Avatar.Fallback>
            </Avatar.Root>
            <div class="min-w-0">
              <p class="text-text-bright truncate text-sm font-medium">
                {member.display_name || member.username}
                {#if member.banned_at !== null}
                  <span
                    class="ml-1 rounded bg-destructive/80 px-1.5 py-0.5 text-[10px] font-semibold text-white align-middle"
                  >
                    GEBANNT
                  </span>
                {/if}
              </p>
              <p class="text-text-muted truncate text-xs">
                @{member.username}
                {#if member.banned_at !== null && member.ban_reason}
                  · {member.ban_reason}
                {/if}
              </p>
            </div>
          </div>

          {#if member.banned_at !== null}
            <Button
              variant="outline"
              size="xs"
              onclick={() => doUnban(member)}
              disabled={!!busy[member.user_identifier]}
              data-testid="member-unban"
              class="shrink-0"
            >
              Entbannen
            </Button>
          {:else}
            <Button
              variant="destructive-solid"
              size="xs"
              onclick={() => {
                banTarget = member;
                banReason = '';
                banError = null;
                banOpen = true;
              }}
              disabled={!!busy[member.user_identifier]}
              data-testid="member-ban"
              class="shrink-0"
            >
              <BanIcon class="size-3.5" />
              Bannen
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- Ban-Dialog mit optionalem Grund -->
<Dialog.Root bind:open={banOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="member-ban-dialog">
      <Dialog.Header>
        <Dialog.Title>Mitglied bannen</Dialog.Title>
        <Dialog.Description>
          {banTarget?.display_name || banTarget?.username} (@{banTarget?.username})
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="ban-reason">
          Grund (optional)
        </label>
        <textarea
          id="ban-reason"
          bind:value={banReason}
          rows="3"
          maxlength="1000"
          class="bg-bg-input border-border text-text-bright resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        <FieldError message={banError} />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="outline" onclick={() => (banOpen = false)}>
          Abbrechen
        </Button>
        <Button variant="destructive-solid" onclick={doBan} disabled={banning}>
          {banning ? 'Banne…' : 'Bannen'}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
