<!--
  RemoteRequestButton — Einstiegspunkt: „Fernsteuerung anfragen" beim Zuschauen
  eines HQ-Streams. `hostUserId` ist der Streamer/Host, `slot` sein gemeinter
  Stream (ein Host kann mehrere gleichzeitig senden).

  Gating (best-effort — der Server ist der eigentliche Gate über 4051): nicht man
  selbst, und REMOTE_CONTROL-Recht im Kanal. Während der eigenen Anfrage an genau
  diesen Host: wartender Zustand mit Abbrechen; läuft sie, wird daraus das
  Beenden.

  Eingehängt im `NativeWindowPanel` — der Kachel-Zustand, während das Bild im
  eigenen Player-Fenster läuft. Das ist kein Zufall, sondern die einzige Stelle,
  an der Fernsteuerung überhaupt gehen kann: erfasst wird IM Fenster, das
  `<video>`-Element der Kachel kann weder Zeiger fangen noch Scancodes liefern.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import Loader2Icon from '@lucide/svelte/icons/loader-circle';
  import XIcon from '@lucide/svelte/icons/x';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { darfFernsteuern } from '$lib/remote/darfSteuern';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channelId,
    hostUserId,
    slot = 0
  }: { channelId: string; hostUserId: string; slot?: number } = $props();

  // Nicht man selbst, und REMOTE_CONTROL im Kanal — dieselbe Vorprüfung, die
  // das Standplatz-Gerät vor seiner selbsttätigen Übernahme macht (`darfSteuern.ts`).
  let visible = $derived(darfFernsteuern(channelId, hostUserId));

  // Geht es gerade um genau diesen Host — meine Anfrage oder meine Sitzung?
  let meins = $derived(
    remoteSession.role === 'controller' && remoteSession.peerUserId === hostUserId
  );
  let pending = $derived(meins && remoteSession.phase === 'requesting');
  let running = $derived(meins && remoteSession.phase === 'active');
  let busyElsewhere = $derived(remoteSession.phase !== 'idle' && !pending && !running);
  let hostName = $derived(userCache.displayName(hostUserId));
</script>

{#if visible}
  {#if running}
    <Button
      size="sm"
      variant="destructive"
      onclick={() => remoteSession.end()}
      data-testid="remote-request-stop"
    >
      <XIcon class="size-4" />
      {m.remote_request_stop()}
    </Button>
  {:else if pending}
    <Button size="sm" variant="secondary" onclick={() => remoteSession.cancel()} data-testid="remote-request-cancel">
      <Loader2Icon class="size-4 animate-spin" />
      {m.remote_request_pending({ user: hostName })}
    </Button>
  {:else}
    <Button
      size="sm"
      variant="ghost"
      disabled={busyElsewhere}
      onclick={() => remoteSession.request(channelId, hostUserId, slot)}
      data-testid="remote-request"
    >
      <MousePointerIcon class="size-4" />
      {m.remote_request_button()}
    </Button>
  {/if}
{/if}
