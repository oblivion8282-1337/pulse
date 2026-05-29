<!--
  DM-attachment limits. Two numeric inputs + Speichern. Bytes are
  displayed/edited as MB for sanity. Patches the chat-gateway singleton;
  next attachment-upload-url request reads the new value live.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { adminApi, type ChatSettings } from '$lib/api/admin';
  import SaveIcon from '@lucide/svelte/icons/save';

  let current = $state<ChatSettings | null>(null);
  let sizeMB = $state(0);
  let count = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const cs = await adminApi.getDmLimits();
      current = cs;
      sizeMB = Math.round(cs.dm_attachment_max_size_bytes / 1024 / 1024);
      count = cs.dm_attachment_max_count_per_message;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  const dirty = $derived(
    current !== null &&
      (sizeMB !== Math.round(current.dm_attachment_max_size_bytes / 1024 / 1024) ||
        count !== current.dm_attachment_max_count_per_message)
  );

  async function save() {
    if (!dirty || busy) return;
    busy = true;
    try {
      const next = await adminApi.patchDmLimits({
        dm_attachment_max_size_bytes: Math.max(1024, sizeMB * 1024 * 1024),
        dm_attachment_max_count_per_message: count
      });
      current = next;
      toast.success('DM-Limits aktualisiert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-attachments">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">Datei-Anhänge in DMs</h2>
    <p class="text-text-muted text-xs mt-0.5">
      Globale Limits. Guild-Channels haben eigene Limits, die pro Community eingestellt werden.
    </p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
  {:else if current}
    <div class="grid gap-4 sm:grid-cols-2">
      <label class="flex flex-col gap-1.5">
        <span class="text-text-base text-sm">Max. Dateigröße (MB)</span>
        <input
          type="number"
          min="1"
          max="4096"
          step="1"
          bind:value={sizeMB}
          class="bg-bg-hover text-text-bright rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"
          data-testid="dm-max-size-input"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-text-base text-sm">Max. Anzahl pro Nachricht</span>
        <input
          type="number"
          min="0"
          max="64"
          step="1"
          bind:value={count}
          class="bg-bg-hover text-text-bright rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"
          data-testid="dm-max-count-input"
        />
      </label>
    </div>

    <div class="mt-4 flex items-center justify-end">
      <Button onclick={save} disabled={!dirty || busy} data-testid="dm-limits-save">
        <SaveIcon class="size-4" />
        {busy ? 'Speichere…' : 'Speichern'}
      </Button>
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
