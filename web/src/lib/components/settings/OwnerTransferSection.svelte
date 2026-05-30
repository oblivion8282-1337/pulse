<!--
  OwnerTransferSection — server-ownership handoff. Only the current
  owner sees this; the backend also rejects non-owners (the form just
  hides it from non-owners as a UX nicety).

  The "type the guild name to confirm" pattern mirrors the backend's
  confirm_name gate — and matches what destructive UI flows do for
  GitHub/Stripe-style high-stakes actions.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { guildOwnershipApi } from '$lib/api/roles';
  import { userCache } from '$lib/stores/users.svelte';
  import type { Guild, Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  function displayName(m: Member): string {
    return m.nickname ?? userCache.displayName(m.user_id);
  }

  let { guild }: { guild: Guild } = $props();

  let members = $state<Member[]>([]);
  let selectedUserId = $state<string>('');
  let confirmName = $state<string>('');
  let busy = $state(false);

  $effect(() => {
    void chatApi
      .listMembers(guild.id)
      .then((rows) => {
        members = rows.filter((m) => m.user_id !== guild.owner_id);
        for (const m of members) userCache.queue(m.user_id);
      })
      .catch(() => {
        members = [];
      });
  });

  let canSubmit = $derived(
    !!selectedUserId && confirmName === guild.name && !busy
  );

  async function transfer(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    try {
      await guildOwnershipApi.transfer(guild.id, {
        new_owner_id: selectedUserId,
        confirm_name: confirmName
      });
      toast.success(m.owner_transfer_success());
      confirmName = '';
      selectedUserId = '';
    } catch (err) {
      toast.error(m.owner_transfer_failed(), {
        description: (err as Error).message
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-4" data-testid="ownership-transfer">
  <header>
    <h2 class="text-text-bright text-base font-semibold">{m.owner_transfer_heading()}</h2>
    <p class="text-text-muted text-sm">
      {m.owner_transfer_description()}
    </p>
  </header>

  <div class="space-y-2">
    <Label for="ot-target">{m.owner_transfer_label_target()}</Label>
    <select
      id="ot-target"
      class="bg-bg-input border-border w-full rounded-md border px-3 py-2 text-sm"
      bind:value={selectedUserId}
      data-testid="ot-target"
    >
      <option value="">{m.owner_transfer_select_placeholder()}</option>
      {#each members as m (m.user_id)}
        <option value={m.user_id}>{displayName(m)}</option>
      {/each}
    </select>
  </div>

  <div class="space-y-2">
    <Label for="ot-confirm">{m.owner_transfer_label_confirm()}</Label>
    <Input
      id="ot-confirm"
      placeholder={guild.name}
      bind:value={confirmName}
      data-testid="ot-confirm"
    />
    <p class="text-text-muted text-xs">
      {m.owner_transfer_confirm_hint({ name: guild.name })}
    </p>
  </div>

  <Button
    variant="destructive"
    onclick={transfer}
    disabled={!canSubmit}
    data-testid="ot-submit"
  >
    {busy ? m.owner_transfer_button_busy() : m.owner_transfer_button_idle()}
  </Button>
</section>
