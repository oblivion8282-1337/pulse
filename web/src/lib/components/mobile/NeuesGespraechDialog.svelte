<script lang="ts">
  /**
   * „Neues Gespräch" — die Freunde als Liste, ein Tipp öffnet den Chat, ohne
   * den Umweg über den Freunde-Bereich.
   *
   * Gezeigt werden nur Freunde OHNE bestehendes Gespräch: mit wem schon ein
   * Chat offen ist, steht in der Liste dahinter.
   */
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { goto } from '$app/navigation';
  import { friends } from '$lib/stores/friends.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { chatApi } from '$lib/api/chat';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    open = $bindable(false),
    onSelect
  }: {
    open?: boolean;
    onSelect: (dm: DMChannel) => void;
  } = $props();

  let freundeOhneChat = $derived.by(() => {
    const mitChat = new Set(directMessages.list.map((dm) => dm.other_user_id));
    return friends.list.filter((f) => !mitChat.has(f.user_id));
  });

  $effect(() => {
    if (open) for (const f of freundeOhneChat) userCache.queue(f.user_id);
  });

  async function starteDM(userId: string) {
    try {
      const dm = await chatApi.createOrGetDMChannel(userId);
      directMessages.upsert(dm);
      open = false;
      onSelect(dm);
      await goto(`/app/@me/${dm.id}`);
    } catch (e) {
      toast.error(m.friend_list_dm_open_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  function initialen(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-sm" data-testid="chats-new-chat-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.chats_compose()}</Dialog.Title>
      <Dialog.Description>{m.chats_new_chat_hint()}</Dialog.Description>
    </Dialog.Header>
    <div class="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
      {#if freundeOhneChat.length === 0}
        <p class="text-text-muted px-2 py-6 text-center text-xs">
          {m.chats_new_chat_no_friends()}
        </p>
      {/if}
      {#each freundeOhneChat as f (f.user_id)}
        {@const name = userCache.displayName(f.user_id)}
        {@const bild = safeAvatarUrl(userCache.get(f.user_id)?.avatar_url ?? null)}
        <button
          type="button"
          class="hover:bg-bg-hover flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors"
          onclick={() => starteDM(f.user_id)}
          data-testid={`new-chat-friend-${f.user_id}`}
        >
          <span class="relative size-10 shrink-0">
            {#if bild}
              <img src={bild} alt="" class="size-full rounded-full object-cover" />
            {:else}
              <span
                class="flex size-full items-center justify-center rounded-full text-sm font-bold text-white"
                style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
                >{initialen(name)}</span
              >
            {/if}
            <StatusDot
              status={presence.displayStatusForFriend(f.user_id)}
              class="ring-bg-panel absolute -right-px -bottom-px size-3.5 ring-[3px]"
            />
          </span>
          <span class="truncate text-sm font-semibold" style={nameStyle(f.user_id)}>{name}</span>
          <MessageCircleIcon class="text-text-muted ml-auto size-5 shrink-0" />
        </button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
