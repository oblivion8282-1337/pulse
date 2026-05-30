<!--
  ServerIconButton — ein Server-Icon in der ServerSidebar.

  Aus ServerSidebar extrahiert (Cloud + Self-Host teilen sich Tooltip/
  ContextMenu/Active-Pill/State-Dot-Logik). Cloud rendert mit CloudIcon
  ohne Self-Host-Badge + ohne Remove-Item; Self-Host rendert mit
  Initialen-Avatar + Akzent-Badge + Entfernen-Item.
-->
<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import InfoIcon from '@lucide/svelte/icons/info';
  import BellIcon from '@lucide/svelte/icons/bell';
  import BellOffIcon from '@lucide/svelte/icons/bell-off';
  import BellRingIcon from '@lucide/svelte/icons/bell-ring';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { m } from '$lib/paraglide/messages.js';
  import type { ServerEntry } from '$lib/api/servers.svelte';
  import type { ConnectionState } from '$lib/ws/gateway-connection';

  let {
    server,
    active,
    state,
    onPick,
    onInfo,
    onNotif,
    onRemove,
  }: {
    server: ServerEntry;
    active: boolean;
    state: ConnectionState;
    onPick: () => void;
    onInfo: () => void;
    onNotif: (mode: ServerEntry['notification_mode']) => void;
    /** Nur Self-Host bietet das an. */
    onRemove?: () => void;
  } = $props();

  function initials(label: string): string {
    return label
      .replace(/^https?:\/\//, '')
      .split(/[.\s-]+/)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('');
  }

  function dotClass(s: ConnectionState): string {
    if (s === 'open') return 'bg-emerald-500';
    if (s === 'connecting' || s === 'starting' || s === 'updating') return 'bg-amber-500';
    if (s === 'incompatible' || s === 'cors-blocked' || s === 'mfa-required') return 'bg-red-500';
    return 'bg-gray-500';
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props: tipProps })}
            <div class="relative shrink-0">
              {#if active}
                <span
                  class="absolute -left-2 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                  aria-hidden="true"
                ></span>
              {/if}
              {#if server.isCloud}
                <button
                  {...props}
                  {...tipProps}
                  type="button"
                  class="relative flex size-10 items-center justify-center overflow-hidden rounded-2xl bg-primary/15 text-primary transition-all hover:rounded-xl data-[active=true]:rounded-xl data-[active=true]:bg-primary/25"
                  data-active={active}
                  data-testid={`server-${server.id}`}
                  onclick={onPick}
                  aria-label={server.label}
                >
                  <CloudIcon class="size-5" />
                </button>
              {:else}
                <button
                  {...props}
                  {...tipProps}
                  type="button"
                  class="relative flex size-10 items-center justify-center overflow-hidden rounded-2xl text-xs font-bold text-white transition-all hover:rounded-xl data-[active=true]:rounded-xl"
                  style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
                  data-active={active}
                  data-testid={`server-${server.id}`}
                  onclick={onPick}
                  aria-label={server.label}
                >
                  {initials(server.label)}
                </button>
                <span
                  class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-bg-panel"
                  title="Self-Host"
                  aria-hidden="true"
                ></span>
              {/if}
              <span
                class="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-bg-panel {dotClass(state)}"
                data-testid="server-state-dot"
                aria-label={m.server_icon_button_status({ state })}
              ></span>
            </div>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">{server.label}</Tooltip.Content>
      </Tooltip.Root>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content>
    <ContextMenu.Item onSelect={onInfo}>
      <InfoIcon /> {m.server_icon_button_server_info()}
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => onNotif('all')}>
      <BellRingIcon /> {m.server_icon_button_notif_all()}
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => onNotif('mentions')}>
      <BellIcon /> {m.server_icon_button_notif_mentions()}
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => onNotif('none')}>
      <BellOffIcon /> {m.server_icon_button_notif_mute()}
    </ContextMenu.Item>
    {#if onRemove}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={onRemove} data-testid="server-remove">
        <Trash2Icon /> {m.server_icon_button_remove_server()}
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
