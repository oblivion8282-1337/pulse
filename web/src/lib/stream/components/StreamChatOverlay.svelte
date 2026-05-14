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
  let visibleIds = $state<Set<string>>(new Set());

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

    // Neue → einblenden + Fade-Timer.
    const next = new Set(visibleIds);
    let changed = false;
    for (const m of history) {
      if (!next.has(m.id) && !timers.has(m.id)) {
        next.add(m.id);
        changed = true;
        const t = setTimeout(() => {
          // Nach Fade aus dem visible-Set raus; den Eintrag aus dem Store
          // räumen wir bewusst nicht weg (Panel zeigt den Verlauf weiter).
          visibleIds = new Set([...visibleIds].filter((x) => x !== m.id));
          timers.delete(m.id);
        }, FADE_AFTER_MS);
        timers.set(m.id, t);
      }
    }

    // Channel-Wechsel: Messages die nicht mehr in der History sind → Timer löschen.
    for (const [id, t] of timers) {
      if (!ids.has(id)) {
        clearTimeout(t);
        timers.delete(id);
        if (next.delete(id)) changed = true;
      }
    }

    if (changed) visibleIds = next;
  });

  let shown = $derived(history.filter((m) => visibleIds.has(m.id)).slice(-MAX_VISIBLE));

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
        class="max-w-full rounded-lg bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
      >
        <span class="font-semibold text-primary">{userCache.displayName(msg.author_id)}</span>
        <span class="ml-1.5">{msg.content}</span>
      </div>
    {/each}
  </div>
{/if}
