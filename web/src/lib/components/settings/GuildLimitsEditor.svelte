<!--
  Per-guild attachment limits (MANAGE_GUILD). Edits the two columns on the
  Guild row via PATCH /guilds/{id}; enforcement lives in the backend
  (attachments.py). Size is shown in MB; stored as bytes.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let { guildId }: { guildId: string } = $props();

  const MB = 1024 * 1024;
  const DEFAULT_SIZE_BYTES = 26214400; // 25 MiB — matches the server default
  const DEFAULT_COUNT = 10;

  const guild = $derived(guilds.byId[guildId]);
  // Buffers, seeded from the guild and re-seeded if it changes underneath us.
  let sizeMb = $state(25);
  let count = $state(10);
  let busy = $state(false);
  let seededFor = $state<string | null>(null);

  $effect(() => {
    const g = guild;
    if (!g || seededFor === g.id) return;
    seededFor = g.id;
    sizeMb = Math.round((g.attachment_max_size_bytes ?? DEFAULT_SIZE_BYTES) / MB);
    count = g.attachment_max_count_per_message ?? DEFAULT_COUNT;
  });

  const dirty = $derived(
    !!guild &&
      (sizeMb * MB !== (guild.attachment_max_size_bytes ?? DEFAULT_SIZE_BYTES) ||
        count !== (guild.attachment_max_count_per_message ?? DEFAULT_COUNT))
  );

  async function save() {
    if (!guild || busy || !dirty) return;
    busy = true;
    try {
      const updated = await chatApi.patchGuild(guildId, {
        attachment_max_size_bytes: Math.round(sizeMb * MB),
        attachment_max_count_per_message: count
      });
      guilds.updateGuild(updated);
      toast.success(m.guild_limits_saved());
    } catch (e) {
      toast.error(m.guild_limits_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex flex-col gap-5" data-testid="guild-limits-editor">
  <div>
    <h2 class="text-text-bright text-lg font-semibold">{m.guild_limits_title()}</h2>
    <p class="text-text-muted text-sm">{m.guild_limits_subtitle()}</p>
  </div>

  {#if !guild}
    <LoadingState label={m.guild_limits_loading()} />
  {:else}
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="guild-limit-size">{m.guild_limits_max_size()}</Label>
        <div class="flex items-center gap-2">
          <Input
            id="guild-limit-size"
            type="number"
            min={1}
            max={1024}
            bind:value={sizeMb}
            disabled={busy}
            class="w-32"
            data-testid="guild-limit-size"
          />
          <span class="text-text-muted text-sm">MB</span>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="guild-limit-count">{m.guild_limits_max_count()}</Label>
        <Input
          id="guild-limit-count"
          type="number"
          min={1}
          max={50}
          bind:value={count}
          disabled={busy}
          class="w-32"
          data-testid="guild-limit-count"
        />
      </div>

      <div class="flex justify-end">
        <Button onclick={save} disabled={busy || !dirty} data-testid="guild-limits-save">
          {busy ? m.guild_limits_saving() : m.guild_limits_save()}
        </Button>
      </div>
    </div>
  {/if}
</section>
