<!--
  RemoteConsentDialog — der Host bestätigt (oder lehnt ab), wenn jemand die
  Fernsteuerung anfragt. Global gemountet (im app/+layout). Sichtbar, solange
  `remoteSession.phase === 'incoming'`. Schließen ohne Wahl = ablehnen (sichere
  Vorgabe: keine Zustimmung). „Erlauben" ist ein normaler Button, kein
  Default-Fokus — Zustimmung soll eine bewusste Handlung sein.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let open = $derived(remoteSession.phase === 'incoming');
  let peerName = $derived(userCache.displayName(remoteSession.peerUserId ?? ''));

  // Wurde in DIESER Anfrage schon geklickt? Nach „Erlauben" bleibt die Phase
  // kurz `incoming` (bis das Echo kommt) — ohne dieses Flag würde ein Escape in
  // dem Fenster ein zusätzliches `deny()` feuern (Host sendet dann accept UND
  // deny). Beim Öffnen einer neuen Anfrage zurückgesetzt.
  let acted = $state(false);
  $effect(() => {
    if (open) acted = false;
  });

  function accept(): void {
    acted = true;
    remoteSession.accept();
  }
  function deny(): void {
    acted = true;
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
      <Dialog.Description>{m.remote_consent_body({ user: peerName })}</Dialog.Description>
    </Dialog.Header>

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
