<script lang="ts">
  /**
   * Die Kopfzeile der Kanalliste: Community-Name, Einladen, Kanal anlegen.
   *
   * Aus `ChannelList.svelte` herausgelöst, damit die Vollbild-Kanalliste des
   * Handys (`/app/rooms/[guildId]`) und die Tablet-Spalte denselben Kopf
   * benutzen wie der Rechner. Der Einladen-Dialog wohnt hier, weil er sonst
   * an drei Stellen aufgesetzt werden müsste — er gehört zum Knopf, nicht zur
   * Liste darunter.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
  import InviteDialog from '../InviteDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import CommunityDateiablage from '../ablage/CommunityDateiablage.svelte';
  import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import type { Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guild,
    canInvite = false,
    canCreate = false,
    onCreateClick,
    onBack
  }: {
    guild: Guild | null;
    canInvite?: boolean;
    canCreate?: boolean;
    onCreateClick: () => void;
    /** Nur auf dem Handy gesetzt: fuehrt zurueck zur Community-Uebersicht.
     *  Ohne Rueckruf erscheint kein Pfeil — am Rechner gibt es keine Ebene
     *  darueber, die Leiste steht ja daneben. */
    onBack?: () => void;
  } = $props();

  let inviteOpen = $state(false);
  // Das Community-Laufwerk (Etappe E8/E9) — sichtbar für JEDES Mitglied, das
  // diese Kanalliste ueberhaupt sieht (keine eigene Rechtepruefung: wer die
  // Community sieht, darf auch ihr Laufwerk sehen). `CommunityDateiablage`
  // selbst entscheidet je nach Besitzer-Status, ob eine Verbinden-Aufforderung
  // oder die Dateiliste erscheint.
  let laufwerkOpen = $state(false);
  let istBesitzer = $derived(!!guild && currentServerUserId() === guild.owner_id);
</script>

<header class="flex h-12 items-center justify-between px-4 pt-3 text-text-bright">
  <div class="flex min-w-0 items-center gap-1">
    {#if onBack}
      <button
        class="-ml-2 flex min-h-12 min-w-12 items-center justify-center text-text-muted hover:text-primary"
        onclick={onBack}
        data-testid="channel-list-back"
        aria-label={m.channel_list_back()}
      >
        <ChevronLeftIcon class="size-6" />
      </button>
    {/if}
    <span class="truncate text-base font-bold tracking-tight">{guild?.name ?? '—'}</span>
  </div>
  <div class="flex items-center gap-0.5">
    {#if guild && canInvite}
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-9 md:size-8 text-text-muted hover:text-primary"
        onclick={() => (inviteOpen = true)}
        data-testid="invite-open-btn"
        aria-label={m.channel_list_invite_people()}
      >
        <UserPlusIcon />
      </Button>
    {/if}
    {#if canCreate}
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-9 md:size-8 text-text-muted hover:text-primary"
        onclick={onCreateClick}
        data-testid="channel-create"
        aria-label={m.channel_list_create_channel()}
      >
        <PlusIcon />
      </Button>
    {/if}
    {#if guild && ABLAGE_KANAL_ENABLED}
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-9 md:size-8 text-text-muted hover:text-primary"
        onclick={() => (laufwerkOpen = true)}
        data-testid="guild-laufwerk-open-btn"
        aria-label={m.channel_list_open_laufwerk()}
      >
        <HardDriveIcon />
      </Button>
    {/if}
  </div>
</header>

{#if guild}
  <InviteDialog open={inviteOpen} guildId={guild.id} onClose={() => (inviteOpen = false)} />
{/if}

{#if guild && ABLAGE_KANAL_ENABLED}
  <Dialog.Root bind:open={laufwerkOpen}>
    <Dialog.Content data-testid="guild-laufwerk-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.channel_list_laufwerk_dialog_title()}</Dialog.Title>
      </Dialog.Header>
      <CommunityDateiablage guildId={guild.id} {istBesitzer} />
    </Dialog.Content>
  </Dialog.Root>
{/if}
