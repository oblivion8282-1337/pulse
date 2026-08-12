<!--
  RemoteConsentDialog — der Host bestätigt (oder lehnt ab), wenn jemand die
  Fernsteuerung anfragt. Global gemountet (im app/+layout). Sichtbar, solange
  `remoteSession.phase === 'incoming'`. Schließen ohne Wahl = ablehnen (sichere
  Vorgabe: keine Zustimmung). „Erlauben" ist ein normaler Button, kein
  Default-Fokus — Zustimmung soll eine bewusste Handlung sein.

  Der Dialog nennt Anzeigenamen UND Nutzernamen und dazu den Ort (Community und
  Kanal). Begründung in `$lib/remote/gegenstelle.ts`; ohne das stand hier für
  jeden nicht zufällig zwischengespeicherten Anfragenden wörtlich „…".
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import MapPinIcon from '@lucide/svelte/icons/map-pin';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { gegenstelle, ort } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let open = $derived(remoteSession.phase === 'incoming');
  let peer = $derived(gegenstelle(remoteSession.peerUserId));
  let herkunft = $derived(ort(remoteSession.channelId));

  // Nutzerdaten anfordern, falls sie nicht schon durch den WS-Handler kamen
  // (z.B. nach einem Server-Wechsel, der den Zwischenspeicher leert). Entprellt
  // und für bekannte IDs folgenlos.
  $effect(() => {
    const id = remoteSession.peerUserId;
    if (id) userCache.queue(id);
  });

  // Für WELCHE Sitzung wurde schon geklickt? Nach „Erlauben" bleibt die Phase
  // kurz `incoming` (bis das Echo kommt) — ohne diesen Merker würde ein Escape
  // in dem Fenster ein zusätzliches `deny()` feuern (Host sendet accept UND
  // deny). An der Sitzungskennung statt an `open`: kippt der Zustand innerhalb
  // eines Durchlaufs von `incoming` über `idle` zurück nach `incoming`, sieht
  // ein Effect den Wechsel nicht — der neue Dialog kam dann mit zwei toten
  // Knöpfen, aus dem auch Escape nicht half (`open` ist abgeleitet).
  let quittiert = $state<string | null>(null);
  let acted = $derived(quittiert !== null && quittiert === remoteSession.sessionId);

  function accept(): void {
    quittiert = remoteSession.sessionId;
    remoteSession.accept();
  }
  function deny(): void {
    quittiert = remoteSession.sessionId;
    remoteSession.deny();
  }

  function onOpenChange(next: boolean): void {
    // Über Escape/Backdrop geschlossen, ohne zu entscheiden → ablehnen.
    if (!next && !acted && remoteSession.phase === 'incoming') remoteSession.deny();
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="max-w-md" data-testid="remote-consent-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.remote_consent_title()}</Dialog.Title>
      <Dialog.Description>{m.remote_consent_body({ user: peer.anzeige })}</Dialog.Description>
    </Dialog.Header>

    <div class="border-border bg-bg-chat flex items-center gap-3 rounded-lg border p-3">
      <Avatar.Root class="size-10 shrink-0">
        {#if peer.avatar}
          <Avatar.Image src={peer.avatar} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
          {peer.initiale}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0">
        <p class="text-text-bright truncate text-sm font-semibold" data-testid="remote-consent-peer">
          {peer.anzeige}
        </p>
        <p class="text-text-muted truncate text-xs" data-testid="remote-consent-peer-handle">
          {peer.benutzername ? `@${peer.benutzername}` : m.remote_peer_unknown_hint()}
        </p>
      </div>
    </div>

    <div class="text-text-base flex items-start gap-2 text-xs" data-testid="remote-consent-place">
      <MapPinIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
      <span>
        {herkunft
          ? m.remote_consent_place({ community: herkunft.community, channel: herkunft.kanal })
          : m.remote_consent_place_unknown()}
      </span>
    </div>

    <div class="border-border bg-bg-chat flex flex-col gap-2 rounded-lg border p-3">
      <div class="text-text-base flex items-center gap-2.5 text-sm">
        <MousePointerIcon class="text-primary size-4 shrink-0" />
        <KeyboardIcon class="text-primary size-4 shrink-0" />
        <span>{m.remote_consent_scope()}</span>
      </div>
    </div>

    <div class="text-text-muted flex items-start gap-2 text-xs">
      <ShieldCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-500" />
      <span>{m.remote_consent_safety()}</span>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={deny} disabled={acted} data-testid="remote-consent-deny">
        {m.remote_consent_deny()}
      </Button>
      <Button onclick={accept} disabled={acted} data-testid="remote-consent-allow">
        {m.remote_consent_allow()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
