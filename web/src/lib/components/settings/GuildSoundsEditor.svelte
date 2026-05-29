<!--
  Per-guild sound-override editor. MANAGE_GUILD-gated tab inside the
  Server-Settings dialog. Rows mirror the 13 sound IDs from
  ``lib/sounds/registry`` grouped by category; each row shows whether
  it's a default or a custom upload, with play/upload/delete actions.

  Upload validation mirrors the backend: client-side checks size (vs
  ``capabilities.guildSoundMaxSizeBytes``) + content-type (OGG/MP3)
  *before* the round-trip so the user gets immediate feedback. The
  server enforces the same caps for real — bypassing the UI gate via
  curl still 400s.

  Two state-syncs after a successful mutation:
   1. local ``rows`` is the source for the UI table — patched in place
      so the loaded state survives a re-render.
   2. ``guildSounds`` store gets the fresh URL via ``applyList`` so the
      engine picks up the override on the *next* play (no need to
      ``invalidateUrl`` — the per-URL pool already keys on URL, so a
      new presigned URL transparently allocates a new audio element).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import PlayIcon from '@lucide/svelte/icons/play';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import BellIcon from '@lucide/svelte/icons/bell';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';

  import { chatApi, type GuildSoundOverrideOut } from '$lib/api/chat';
  import { sounds } from '$lib/sounds/engine';
  import { SOUNDS, soundsInCategory, type SoundId } from '$lib/sounds/registry';
  import type { SoundCategoryKey } from '$lib/sounds/persistence';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { guildSounds } from '$lib/stores/guildSounds.svelte';

  let { guildId }: { guildId: string } = $props();

  let rows = $state<GuildSoundOverrideOut[]>([]);
  let loading = $state(true);
  let busyId = $state<string | null>(null);
  let inputs: Record<string, HTMLInputElement | null> = {};

  const ALLOWED_TYPES = new Set(['audio/ogg', 'audio/mpeg']);

  // Some browsers report '' for .ogg files. The .accept attribute on the
  // file picker filters by extension *or* type; we re-validate from the
  // filename suffix as a fallback so the user isn't blocked when
  // browser-inference fails.
  function inferContentType(file: File): string {
    if (file.type && ALLOWED_TYPES.has(file.type)) return file.type;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    return file.type;
  }

  const categories: { key: SoundCategoryKey; title: string; icon: typeof BellIcon }[] = [
    { key: 'notification', title: 'Benachrichtigungen', icon: BellIcon },
    { key: 'voice', title: 'Voice-Channel', icon: MicIcon },
    { key: 'ui', title: 'UI-Feedback', icon: MousePointerClickIcon }
  ];

  function rowFor(id: SoundId): GuildSoundOverrideOut | undefined {
    return rows.find((r) => r.sound_id === id);
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  onMount(async () => {
    try {
      rows = await chatApi.listGuildSounds(guildId);
      guildSounds.applyList(guildId, rows);
    } catch (e) {
      toast.error('Sounds konnten nicht geladen werden', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      loading = false;
    }
  });

  function triggerUpload(id: SoundId): void {
    inputs[id]?.click();
  }

  async function onFileChosen(id: SoundId, e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Reset value so the same file re-trigger fires onchange again.
    input.value = '';
    if (!file) return;

    const contentType = inferContentType(file);
    if (!ALLOWED_TYPES.has(contentType)) {
      toast.error('Format nicht unterstützt', {
        description: 'Erlaubt sind OGG und MP3.'
      });
      return;
    }
    const cap = capabilities.guildSoundMaxSizeBytes;
    if (file.size > cap) {
      toast.error('Datei zu groß', {
        description: `Maximal ${fmtBytes(cap)} pro Sound. Diese Datei: ${fmtBytes(file.size)}.`
      });
      return;
    }
    if (file.size === 0) {
      toast.error('Leere Datei');
      return;
    }

    // Browser .type can be ''; pin it to the inferred type so the
    // backend's content-type check passes (it whitelists OGG/MP3 only).
    const sized = contentType === file.type
      ? file
      : new File([file], file.name, { type: contentType });

    busyId = id;
    try {
      const row = await chatApi.uploadGuildSound(guildId, id, sized);
      // Splice the new row in (or replace existing).
      rows = [row, ...rows.filter((r) => r.sound_id !== id)];
      guildSounds.applyList(guildId, rows);
      toast.success(`${SOUNDS[id].label}: hochgeladen`);
    } catch (e) {
      toast.error('Upload fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busyId = null;
    }
  }

  async function revert(id: SoundId): Promise<void> {
    const existing = rowFor(id);
    if (!existing) return;
    busyId = id;
    try {
      await chatApi.deleteGuildSound(guildId, id);
      rows = rows.filter((r) => r.sound_id !== id);
      guildSounds.applyList(guildId, rows);
      toast.success(`${SOUNDS[id].label}: auf Standard zurückgesetzt`);
    } catch (e) {
      toast.error('Zurücksetzen fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busyId = null;
    }
  }

  function play(id: SoundId): void {
    sounds.test(id, { guildId });
  }
</script>

<div class="flex flex-col gap-5" data-testid="guild-sounds-editor">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Sounds</h2>
    <p class="text-text-muted text-sm">
      Eigene Sounds für diese Community. Pro Sound-ID eine Datei (OGG oder MP3,
      max. {fmtBytes(capabilities.guildSoundMaxSizeBytes)}).
      Ohne Override spielt der Standard-Sound. „Anhören" gibt dir die
      aktuelle Variante.
    </p>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">lade…</p>
  {:else}
    {#each categories as cat (cat.key)}
      <section
        class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4"
        data-testid="guild-sounds-cat-{cat.key}"
      >
        <div class="flex items-center gap-2">
          <cat.icon class="text-text-muted size-4" />
          <span class="text-text-bright text-sm font-medium">{cat.title}</span>
        </div>

        <div class="flex flex-col divide-y divide-border/40">
          {#each soundsInCategory(cat.key) as id (id)}
            {@const row = rowFor(id)}
            {@const isBusy = busyId === id}
            <div
              class="flex items-center justify-between gap-3 py-2 text-sm"
              data-testid="guild-sounds-row-{id}"
            >
              <div class="flex min-w-0 flex-col">
                <span class="text-text-base truncate">{SOUNDS[id].label}</span>
                <span class="text-text-muted truncate text-xs">
                  {#if row}
                    <span data-testid="guild-sounds-status-{id}">
                      Custom · {row.original_filename} · {fmtBytes(row.file_size)}
                    </span>
                  {:else}
                    <span class="opacity-60" data-testid="guild-sounds-status-{id}">Standard</span>
                  {/if}
                </span>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onclick={() => play(id)}
                  title="Anhören"
                  aria-label="{SOUNDS[id].label} anhören"
                  class="hover:bg-bg-hover text-text-muted hover:text-text-bright rounded-md p-1.5 transition-colors"
                  data-testid="guild-sounds-play-{id}"
                >
                  <PlayIcon class="size-4" />
                </button>

                <button
                  type="button"
                  onclick={() => triggerUpload(id)}
                  disabled={isBusy}
                  title="Hochladen"
                  aria-label="{SOUNDS[id].label} hochladen"
                  class="hover:bg-bg-hover text-text-muted hover:text-text-bright rounded-md p-1.5 transition-colors disabled:cursor-wait disabled:opacity-50"
                  data-testid="guild-sounds-upload-{id}"
                >
                  <UploadIcon class="size-4" />
                </button>
                <input
                  bind:this={inputs[id]}
                  type="file"
                  accept=".ogg,.mp3,audio/ogg,audio/mpeg"
                  class="hidden"
                  onchange={(e) => onFileChosen(id, e)}
                  data-testid="guild-sounds-file-{id}"
                />

                {#if row}
                  <button
                    type="button"
                    onclick={() => revert(id)}
                    disabled={isBusy}
                    title="Auf Standard zurücksetzen"
                    aria-label="{SOUNDS[id].label} auf Standard zurücksetzen"
                    class="hover:bg-bg-hover text-text-muted hover:text-red-400 rounded-md p-1.5 transition-colors disabled:cursor-wait disabled:opacity-50"
                    data-testid="guild-sounds-revert-{id}"
                  >
                    <RotateCcwIcon class="size-4" />
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>
