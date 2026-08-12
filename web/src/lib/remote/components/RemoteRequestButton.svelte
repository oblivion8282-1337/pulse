<!--
  RemoteRequestButton — Einstiegspunkt: „Fernsteuerung anfragen" beim Zuschauen
  eines HQ-Streams. `hostUserId` ist der Streamer/Host.

  Gating (best-effort — der Server ist der eigentliche Gate über 4051): nicht man
  selbst, und REMOTE_CONTROL-Recht im Kanal. Während der eigenen Anfrage an genau
  diesen Host: wartender Zustand mit Abbrechen.

  Noch nicht gemountet: der ursprüngliche Einhängepunkt (WhepPlayer.svelte)
  gehört zum P2P-Zweig und liegt außerhalb dieser Portierung — s. Bericht.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import Loader2Icon from '@lucide/svelte/icons/loader-circle';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { channelId, hostUserId }: { channelId: string; hostUserId: string } = $props();

  let isSelf = $derived(auth.user?.id === hostUserId);

  // Recht best-effort: Kanal im Store finden → REMOTE_CONTROL prüfen. Ohne
  // auflösbaren Kanal (z.B. DM) nicht gaten — der Server lehnt sonst ohnehin ab.
  let canControl = $derived.by(() => {
    const channel = Object.values(guilds.channelsByGuild)
      .flat()
      .find((c) => c.id === channelId);
    if (!channel) return true;
    return channelPermissions.hasChannelPermission(channel.guild_id, channel.id, Perm.REMOTE_CONTROL);
  });

  let visible = $derived(!isSelf && canControl);

  // Wartet meine Anfrage gerade auf genau diesen Host?
  let pending = $derived(
    remoteSession.phase === 'requesting' &&
      remoteSession.role === 'controller' &&
      remoteSession.peerUserId === hostUserId,
  );
  let busyElsewhere = $derived(remoteSession.phase !== 'idle' && !pending);
  let hostName = $derived(userCache.displayName(hostUserId));
</script>

{#if visible}
  {#if pending}
    <Button size="sm" variant="secondary" onclick={() => remoteSession.cancel()} data-testid="remote-request-cancel">
      <Loader2Icon class="size-4 animate-spin" />
      {m.remote_request_pending({ user: hostName })}
    </Button>
  {:else}
    <Button
      size="sm"
      variant="ghost"
      disabled={busyElsewhere}
      onclick={() => remoteSession.request(channelId, hostUserId)}
      data-testid="remote-request"
    >
      <MousePointerIcon class="size-4" />
      {m.remote_request_button()}
    </Button>
  {/if}
{/if}
