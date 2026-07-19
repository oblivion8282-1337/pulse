<!--
  StreamChatOverlay — Twitch-Style: die letzten paar Live-Chat-Messages rechts
  über dem Video, jeweils nach ~8s ausgefadet. Wird vom `WhepPlayer` nur im
  Fullscreen + bei aktivem Chat-Toggle gemountet (sonst gibt's daneben das
  Side-Panel + die Inline-Input-Pille).

  `pointer-events: none` damit Klicks aufs Video (Fullscreen-Toggle) nicht
  abgefangen werden — die Eingabe übernimmt das separate `StreamChatInlineInput`.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { streamChat } from '$lib/stores/streamChat.svelte';
  import { userCache } from '$lib/stores/users.svelte';

  let { channelId, streamerId }: { channelId: string; streamerId: string } = $props();

  const FADE_AFTER_MS = 8000;
  const MAX_VISIBLE = 6;

  // Letzte N Messages aus dem Store.
  let history = $derived(streamChat.for(channelId, streamerId));

  // Pro Message-id ein Sichtbarkeits-Flag; verschwindet nach FADE_AFTER_MS.
  // Plain Set (nicht reactive) + separate version counter für Svelte-Reaktivität.
  let visibleIds = new Set<string>();
  let visibleVersion = $state(0);

  // Cleanup-Timer pro Message, damit Channel-Wechsel keine Timer leaked.
  let timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Trigger Username-Fetch für jeden frischen Autor.
  $effect(() => {
    for (const m of history) userCache.queue(m.author_id);
  });

  // Beobachte neue Messages: anzeigen + Timer setzen.
  $effect(() => {
    const ids = new Set<string>();
    for (const m of history) ids.add(m.id);

    let changed = false;

    // Neue → einblenden + Fade-Timer.
    for (const m of history) {
      if (!visibleIds.has(m.id) && !timers.has(m.id)) {
        visibleIds.add(m.id);
        changed = true;
        const t = setTimeout(() => {
          // Nach Fade aus dem visible-Set raus; den Eintrag aus dem Store
          // räumen wir bewusst nicht weg (Panel zeigt den Verlauf weiter).
          visibleIds.delete(m.id);
          timers.delete(m.id);
          visibleVersion++;
        }, FADE_AFTER_MS);
        timers.set(m.id, t);
      }
    }

    // Channel-Wechsel: Messages die nicht mehr in der History sind → Timer löschen.
    for (const [id, t] of timers) {
      if (!ids.has(id)) {
        clearTimeout(t);
        timers.delete(id);
        if (visibleIds.delete(id)) changed = true;
      }
    }

    if (changed) visibleVersion++;
  });

  let shown = $derived.by(() => {
    visibleVersion; // Depend on version counter for reactivity
    return history.filter((m) => visibleIds.has(m.id)).slice(-MAX_VISIBLE);
  });

  // Unmount cleanup: clear every pending fade-out timer so the callbacks
  // can't run after the component is gone and write into stale state.
  onDestroy(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
</script>

{#if shown.length > 0}
  <div
    class="pointer-events-none absolute right-2 top-2 bottom-28 z-10 flex w-72 max-w-[80%] flex-col items-end justify-end gap-1 overflow-hidden"
    data-testid="hq-stream-chat-overlay"
  >
    {#each shown as msg (msg.id)}
      <div
        class="max-w-full rounded-md bg-black/65 px-2.5 py-1 text-xs text-white ring-1 ring-white/15 backdrop-blur-md [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]"
      >
        <span class="font-semibold text-primary">{userCache.displayName(msg.author_id)}</span>
        <span class="ml-1.5">{msg.content}</span>
      </div>
    {/each}
  </div>
{/if}
