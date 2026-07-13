<!--
  "Oder Link teilen"-Abschnitt im Leute-einladen-Dialog (InviteDialog).
  Nur sichtbar mit CREATE_INVITES (der Parent gated). Ein Klick erzeugt einen
  Link (7 Tage gültig, unbegrenzte Nutzungen) und kopiert ihn; Feinsteuerung +
  Verwaltung bleiben im GuildInvitesEditor der Community-Einstellungen.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import LinkIcon from '@lucide/svelte/icons/link';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { chatApi } from '$lib/api/chat';
  import { inviteLink } from '$lib/guilds/inviteLink';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  const SEVEN_DAYS = 604800;

  let link = $state<string | null>(null);
  let creating = $state(false);
  let copied = $state(false);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      setTimeout(() => (copied = false), 1500);
      toast.success(m.guild_invites_copied());
    } catch {
      toast.error(m.guild_invites_copy_failed());
    }
  }

  async function createAndCopy() {
    if (creating) return;
    creating = true;
    try {
      const invite = await chatApi.createInvite(guildId, {
        expiresInSeconds: SEVEN_DAYS,
        maxUses: undefined
      });
      link = inviteLink(invite.code);
      await copy(link);
    } catch (e) {
      toast.error(m.guild_invites_create_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      creating = false;
    }
  }
</script>

<div class="border-border flex flex-col gap-2 border-t pt-4" data-testid="invite-link-share">
  <p class="text-text-bright text-sm font-semibold">{m.invite_share_heading()}</p>
  {#if link}
    <div class="bg-bg-input border-border flex items-center gap-2 rounded-xl border p-2.5">
      <code class="text-text-bright min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
      <button
        type="button"
        onclick={() => void copy(link ?? '')}
        aria-label={m.guild_invites_copy_link()}
        class="text-text-muted hover:text-text-bright shrink-0 rounded-lg p-1.5 transition-colors"
        data-testid="invite-share-copy"
      >
        {#if copied}
          <CheckIcon class="size-4 text-emerald-400" />
        {:else}
          <CopyIcon class="size-4" />
        {/if}
      </button>
    </div>
  {:else}
    <Button
      onclick={createAndCopy}
      disabled={creating}
      class="w-fit"
      data-testid="invite-share-create"
    >
      <LinkIcon class="size-4" />
      {creating ? m.invite_share_creating() : m.invite_share_create_btn()}
    </Button>
  {/if}
  <p class="text-text-muted text-xs">{m.invite_share_hint()}</p>
</div>
