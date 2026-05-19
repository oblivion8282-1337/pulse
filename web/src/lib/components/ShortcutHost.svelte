<script lang="ts">
  /**
   * Mount-point für das globale Shortcut-System. Eine Instanz, im Root-
   * `+layout.svelte` platziert. Hier laufen das Window-Level-Keydown,
   * die Global-Action-Handler die nicht an eine konkrete Feature-View
   * gebunden sind (Cheatsheet, Voice, Navigation), und der Quick-Switcher.
   *
   * Feature-Views (MessageInput, Stream-Panel) holen sich `register()` aus
   * engine.svelte.ts und registrieren ihre Handler selbst.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { mountWindowListener, register } from '$lib/shortcuts/engine.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { stream } from '$lib/stream/state.svelte';
  import { gsr } from '$lib/stream/gsr';
  import { isElectron, isLinux, isWindows } from '$lib/platform/runtime';
  import ShortcutCheatsheet from './ShortcutCheatsheet.svelte';
  import QuickSwitcher from './QuickSwitcher.svelte';

  let cheatsheetOpen = $state(false);

  function gotoChannelNeighbor(delta: 1 | -1): void {
    const gid = page.params.guildId;
    if (!gid) return;
    const cid = page.params.channelId;
    const list = guilds.channelsByGuild[gid] ?? [];
    if (list.length === 0) return;
    const idx = cid ? list.findIndex((c) => c.id === cid) : -1;
    if (idx === -1) {
      void goto(`/app/guilds/${gid}/channels/${list[0].id}`);
      return;
    }
    const nextIdx = (idx + delta + list.length) % list.length;
    void goto(`/app/guilds/${gid}/channels/${list[nextIdx].id}`);
  }

  function gotoServerNeighbor(delta: 1 | -1): void {
    const all = guilds.list;
    if (all.length === 0) return;
    const gid = page.params.guildId;
    const idx = gid ? all.findIndex((g) => g.id === gid) : -1;
    if (idx === -1) {
      // Auf /@me oder unbekanntem Server — auf den ersten Server springen.
      void goto(`/app/guilds/${all[0].id}/channels/_`);
      return;
    }
    const nextIdx = (idx + delta + all.length) % all.length;
    void goto(`/app/guilds/${all[nextIdx].id}/channels/_`);
  }

  onMount(() => {
    const disposers: Array<() => void> = [
      mountWindowListener(),
      register('nav.cheatsheet', () => {
        cheatsheetOpen = !cheatsheetOpen;
      }),
      register('nav.settings', () => {
        uiOverlays.settingsOpen = true;
      }),
      register('nav.quickSwitcher', () => {
        uiOverlays.quickSwitcherOpen = !uiOverlays.quickSwitcherOpen;
      }),
      register('nav.channelUp', () => gotoChannelNeighbor(-1)),
      register('nav.channelDown', () => gotoChannelNeighbor(1)),
      register('nav.serverUp', () => gotoServerNeighbor(-1)),
      register('nav.serverDown', () => gotoServerNeighbor(1)),
      // Voice-Actions sind global (auch außerhalb der VoiceChannelView nutzbar,
      // sobald man im Voice ist — Discord-Style). Guards verhindern, dass
      // toggleMic()s Sound spielt ohne dass Connection da ist.
      register('voice.toggleMute', () => {
        if (!voice.connected) return;
        voice.toggleMic();
      }),
      register('voice.toggleDeafen', () => {
        if (!voice.connected) return;
        voice.toggleDeafen();
      }),
      register('voice.disconnect', () => {
        if (!voice.connected) return;
        void voice.disconnect({ reason: 'user' });
      }),
      register('stream.toggleHq', () => {
        if (!isElectron() || !(isLinux() || isWindows()) || !stream.gsrAvailable) {
          toast.info('HQ-Stream nur in der Desktop-App verfügbar');
          return;
        }
        if (stream.running) {
          void gsr.stop();
          return;
        }
        if (!voice.channelId) {
          toast.info('Tritt erst einem Sprach-Channel bei, um zu streamen');
          return;
        }
        uiOverlays.hqStreamDialogOpen = true;
      }),
      register('stream.toggleScreenshare', () => {
        if (!voice.connected) {
          toast.info('Tritt erst einem Sprach-Channel bei, um zu teilen');
          return;
        }
        voice.toggleScreenShare();
      }),
      register('stream.highlightClip', () => {
        // Placeholder bis der 30s-Roll-Buffer in media-svc existiert (IDEAS.md #58).
        toast.info('Highlight-Clip kommt — der 30s-Buffer im media-svc fehlt noch');
      })
    ];
    return () => disposers.forEach((d) => d());
  });
</script>

<ShortcutCheatsheet bind:open={cheatsheetOpen} />
<QuickSwitcher />
