<script lang="ts">
  /**
   * Die Kanäle einer Community als eigener Bildschirm — die zweite Ebene des
   * Räume-Bereichs (Räume → Kanäle → Chat).
   *
   * **Rendert dieselbe `ChannelList` wie der Rechner**, nur mit Zurück-Pfeil.
   * Eine eigene mobile Kanalliste hätte bedeutet, dass jede künftige Änderung
   * zweimal gemacht werden muss — und die beiden liefen auseinander, sobald
   * jemand eine davon vergisst.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import ChannelList from '$lib/components/ChannelList.svelte';
  import CreateChannelDialog from '$lib/components/CreateChannelDialog.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { geraetPfad } from '$lib/devices/darstellung';
  import { viewport } from '$lib/stores/viewport.svelte';
  import TabletPlaceholder from '$lib/components/mobile/TabletPlaceholder.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { kanalAnlegen } from '$lib/channels/anlegen';
  import type { Channel } from '$lib/api/types';
  import type { Device } from '$lib/api/devices';

  let guildId = $derived(page.params.guildId ?? '');
  let guild = $derived(guilds.list.find((g) => g.id === guildId) ?? null);
  let channels = $derived<Channel[]>(guilds.channelsByGuild[guildId] ?? []);
  let creatingChannel = $state(false);

  // Kanäle nachladen, falls der Vorlade-Lauf des Layouts sie noch nicht hat
  // (Direkteinstieg über einen Link, kalter Start). Idempotent.
  onMount(() => {
    if (guildId) void guilds.ensureChannels(guildId).catch(() => undefined);
  });

  function oeffneKanal(c: Channel) {
    void goto(`/app/guilds/${guildId}/channels/${c.id}`);
  }

  function oeffneGeraet(d: Device) {
    void goto(geraetPfad(d));
  }
</script>

<div class="slide-rein flex h-full min-w-0 flex-1">
<ChannelList
  {guild}
  {channels}
  activeChannelId={null}
  onSelect={oeffneKanal}
  onCreateClick={() => (creatingChannel = true)}
  canCreate={!!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_CHANNELS)}
  onSelectDevice={oeffneGeraet}
  onBack={() => goto('/app/rooms')}
/>
</div>

{#if !viewport.isMobile}
  <TabletPlaceholder text={m.rooms_pick_channel()} />
{/if}

<CreateChannelDialog
  open={creatingChannel}
  {guildId}
  dropboxAllowed={guild?.dropbox_allowed ?? false}
  onClose={() => (creatingChannel = false)}
  onCreate={async (name, type) => {
    if (await kanalAnlegen(guildId, name, type)) creatingChannel = false;
  }}
/>
