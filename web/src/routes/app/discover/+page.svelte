<script lang="ts">
  /**
   * Entdecken — das Verzeichnis öffentlicher Communities.
   *
   * **Gerüst.** Der Beitritt über eine bekannte Adresse funktioniert bereits
   * (`GET /c/{handle}` gibt es seit Stufe 4); das durchsuchbare Verzeichnis
   * mit Kategorien kommt mit dem Server-Endpunkt `GET /c` in Phase 8 dieses
   * Umbaus.
   */
  import { goto } from '$app/navigation';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import { m } from '$lib/paraglide/messages.js';
</script>

<div
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="discover-page"
>
  <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
    <button
      class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
      onclick={() => goto('/app/rooms')}
      data-testid="discover-back"
      aria-label={m.channel_list_back()}
    >
      <ChevronLeftIcon class="size-6" />
    </button>
    <span class="truncate text-base font-bold tracking-tight">{m.rooms_discover_cta()}</span>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-6">
    <p class="text-text-muted text-sm">{m.discover_coming_soon()}</p>
  </div>
</div>
