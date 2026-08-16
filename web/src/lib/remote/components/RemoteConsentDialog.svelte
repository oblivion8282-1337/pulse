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
  import { standplatz } from '$lib/remote/standplatz.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  // Nicht bei selbsttätiger Zustimmung: die Dauerfreigabe des Standplatz-Geräts
  // hat die Frage schon beantwortet (`$lib/remote/standplatz.svelte.ts`). Die
  // Phase bleibt bis zum Server-Echo auf 'incoming' — ohne diese Bedingung
  // stünde der Dialog einen Umlauf lang da und verschwände von selbst wieder,
  // was aussieht wie ein Fehler und zum Klicken einlädt.
  let open = $derived(remoteSession.phase === 'incoming' && !remoteSession.selbsttaetig);
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

  // „Künftig ohne Rückfrage" — der Weg, auf dem die Freigabeliste des Geräts
  // wächst (`$lib/remote/standplatz.svelte.ts`). Bewusst HIER und nicht nur in
  // den Einstellungen: dort müsste man Kennungen von Hand eintragen, hier steht
  // der Betreffende samt Namen und Herkunft vor einem, und die Entscheidung
  // fällt in dem Moment, in dem man sie ohnehin trifft.
  //
  // Nur in der Desktop-App sichtbar: nur dort kann dieser Rechner überhaupt
  // ferngesteuert werden, und nur dort gibt es den Geräte-Speicher.
  const desktop = isElectron();
  let merken = $state(false);

  // Beim Wechsel der Anfrage zurücksetzen: das Kreuz gehört der Anfrage, vor
  // der es gesetzt wurde, nicht der nächsten.
  $effect(() => {
    remoteSession.sessionId;
    merken = false;
  });

  function accept(): void {
    quittiert = remoteSession.sessionId;
    // ERST merken, DANN zustimmen: `accept()` kann über `#reset` aufräumen
    // (Senden fehlgeschlagen), und danach ist die Kennung des Anfragenden weg.
    // Eine frische Freigabe gilt acht Stunden — dieselbe Spanne wie der
    // absolute Sitzungsdeckel des Gateways, und lang genug für einen
    // Arbeitstag; eine schon geltende bleibt, wie sie ist.
    //
    // Server und Kanal kommen aus der SITZUNG, nicht aus dem Dispatch-Global
    // (`remoteSession.serverId` — Begründung dort): hier wird Sekunden nach dem
    // Eintreffen der Anfrage geklickt, und bis dahin hat längst ein fremder
    // Rahmen den Zeiger umgesetzt.
    const server = remoteSession.serverId;
    const kanal = remoteSession.channelId;
    if (merken && desktop && remoteSession.peerUserId && server && kanal) {
      // Über `nutzerErgaenzen`, NICHT über `freigeben`: das schaltet scharf und
      // reichte dabei `jeder` mit — ein Haken für EINE Person öffnete das Gerät
      // wieder für alle (`standplatz.svelte.ts::nutzerErgaenzen`).
      void standplatz.nutzerErgaenzen({
        serverId: server,
        channelId: kanal,
        userId: remoteSession.peerUserId,
      });
    }
    remoteSession.accept();
  }
  function deny(): void {
    quittiert = remoteSession.sessionId;
    remoteSession.deny();
  }

  function onOpenChange(next: boolean): void {
    // Über Escape/Backdrop geschlossen, ohne zu entscheiden → ablehnen.
    // `selbsttaetig` ausgenommen: dort schliesst der Dialog, WEIL schon
    // zugestimmt wurde — ein `deny()` hinterher schösse die eigene Zustimmung ab.
    if (remoteSession.selbsttaetig) return;
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

    {#if desktop}
      <label class="border-border flex items-start gap-3 rounded-lg border border-dashed p-3">
        <Checkbox
          class="mt-0.5 shrink-0"
          bind:checked={merken}
          disabled={acted}
          data-testid="remote-consent-remember"
        />
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-text-bright text-sm font-medium">
            {m.standplatz_consent_remember()}
          </span>
          <span class="text-text-muted text-xs">{m.standplatz_consent_remember_hint()}</span>
        </span>
      </label>
    {/if}

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
