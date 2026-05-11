<!--
  ServerPicker — Dropdown der ServerProfile aus `gsr_list_profiles`.

  Plus ein "+ Server hinzufügen…"-Button der bewusst noch nichts tut. Der
  echte Add-Server-Dialog (mit RTMP/SRT-Settings + Token-Persistenz via
  Tauri-store) kommt in T3c — hier nur als visueller Platzhalter, damit
  die Position im Layout schon final ist.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { streamSettings } from '../settings.svelte';

  let current = $derived(
    streamSettings.available_servers.find((s) => s.name === streamSettings.server_name),
  );
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-server-picker">
  <Label for="stream-server-select">Server</Label>
  <div class="flex items-center gap-2">
    <select
      id="stream-server-select"
      class="bg-bg-input text-text-base h-9 flex-1 rounded-md px-2 text-sm outline-none"
      value={streamSettings.server_name}
      onchange={(e) => (streamSettings.server_name = (e.currentTarget as HTMLSelectElement).value)}
      disabled={streamSettings.available_servers.length === 0}
      data-testid="stream-server-select"
    >
      {#if streamSettings.available_servers.length === 0}
        <option value="">Lade Server…</option>
      {/if}
      {#each streamSettings.available_servers as s (s.name)}
        <option value={s.name}>
          {s.name} · {s.push_protocol}://{s.push_host}:{s.push_port}
        </option>
      {/each}
    </select>
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              size="icon"
              variant="ghost"
              disabled
              aria-label="Server hinzufügen"
              data-testid="stream-server-add"
            >
              <PlusIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Eigener Server (Dialog kommt in T3c)</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
  {#if current}
    <p class="text-text-muted text-xs">
      Pfad: <code class="bg-bg-input rounded px-1">{current.push_path}</code>
      {#if current.needs_auth}· Auth via Stream-Token{/if}
    </p>
  {/if}
</div>
