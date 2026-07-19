<!--
  "Per Nutzername einladen" im Leute-einladen-Dialog — NUR Cloud-Communities
  (Gate im Parent): Einladungen an Nicht-Freunde fahren auf den Schienen der
  Freundschaftsanfragen (der Empfänger sieht eine Annehmen/Ablehnen-Karte im
  Pending-Tab), DMs bleiben strikt friends-only. Braucht CREATE_INVITES
  (Parent gated; das Backend prüft server-seitig erneut).
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { communityInvitesApi } from '$lib/api/communityInvites';
  import { ApiError } from '$lib/api/client';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  let username = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);

  function mapError(e: unknown): string {
    if (e instanceof ApiError) {
      const detail = typeof e.body === 'object' ? (e.body as { detail?: string })?.detail : null;
      if (detail === 'user_not_found') return m.member_invite_error_not_found();
      if (detail === 'already_member') return m.member_invite_error_already_member();
      if (detail === 'invite_already_pending') return m.member_invite_error_pending();
      if (detail === 'block_in_place') return m.member_invite_error_blocked();
      if (detail === 'cannot_invite_yourself') return m.member_invite_error_self();
      if (e.status === 429) return m.member_invite_error_rate_limited();
    }
    return e instanceof Error ? e.message : m.member_invite_error_generic();
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name || sending) return;
    sending = true;
    error = null;
    try {
      await communityInvitesApi.send(guildId, name);
      toast.success(m.member_invite_sent_toast({ username: name }));
      username = '';
    } catch (err) {
      error = mapError(err);
    } finally {
      sending = false;
    }
  }
</script>

<form class="border-border flex flex-col gap-2 border-t pt-4" onsubmit={send}
      data-testid="invite-by-username">
  <p class="text-text-bright text-sm font-semibold">{m.member_invite_heading()}</p>
  <p class="text-text-muted text-xs">{m.member_invite_hint()}</p>
  <div class="flex gap-2">
    <Input
      type="text"
      bind:value={username}
      autocomplete="off"
      maxlength={50}
      placeholder={m.member_invite_placeholder()}
      data-testid="invite-by-username-input"
    />
    <Button
      type="submit"
      disabled={sending || !username.trim()}
      data-testid="invite-by-username-send"
    >
      <UserPlusIcon class="size-4" />
      {sending ? m.member_invite_sending() : m.member_invite_send_btn()}
    </Button>
  </div>
  {#if error}
    <p class="text-destructive text-xs" data-testid="invite-by-username-error">{error}</p>
  {/if}
</form>
