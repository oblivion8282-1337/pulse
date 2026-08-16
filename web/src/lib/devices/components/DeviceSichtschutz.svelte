<!--
  DeviceSichtschutz — was der Steuernde eines Geräts NICHT sehen soll.

  ## Das Leck

  Ein Standplatz-Gerät läuft mit dem Konto seines Besitzers. Wer es übernimmt,
  bekommt Maus und Tastatur — und damit dessen Direktnachrichten,
  Nachrichtenverlauf und Freundesliste. Bei einem Menschen, der zehn Minuten
  bewusst hergibt, ist das seine Entscheidung; bei einem Dauergerät wäre es ein
  Dauerleck (Entwurf §4).

  ## Warum der Riegel hier sitzt und nicht im Server

  Der Entwurf (§6) hat ihn zunächst im Server verortet: die Sitzung weiss, über
  welchen Ausweis sie zustande kam, also könne der Server dieser Verbindung
  Chat, Verlauf und Direktnachrichten verweigern. Beim Bauen zeigte sich, dass
  das die Lücke **nicht schliesst** und zugleich zu viel nimmt:

  * **Zu wenig:** der Nachrichtenverlauf kommt über REST, und eine
    REST-Anfrage trägt keine Verbindung — der Server kann ihr nicht ansehen,
    dass sie von einem gerade ferngesteuerten Rechner kommt. Der Riegel
    verfehlte also genau den Weg, über den ein Steuernder lesen würde.
  * **Zu viel:** ein Riegel, der immer gilt, nähme dem Besitzer den Chat auf
    seinem eigenen Rechner, auch wenn niemand ihn steuert.

  Der Riegel gilt deshalb **genau, solange jemand steuert**, und er sitzt dort,
  wo der Inhalt entsteht: auf dem Schirm. Das ist zugleich die richtige Ebene,
  denn die Gefahr ist eine des Sehens — der Steuernde sieht Pixel, keine
  API-Antworten.

  ## Was er nicht kann

  Er hält niemanden auf, der auf diesem Rechner ohnehin alles darf (den
  Besitzer). Er hält den Steuernden auf, und nur um den geht es: Pulse ist auf
  einem Standplatz-Gerät die einzige offene Tür zu diesem Konto — die Anmeldung
  liegt im Geräte-Speicher, nicht im Browser.

  ## Warum es nicht bei einem Div bleibt

  Ein `fixed inset-0` verdeckt nur, was unter ihm liegt. Drei Wege lagen
  daneben, alle beim Bughunt 2026-08-16 gefunden: Toasts (z-index 999999999),
  portalierte Dialoge (z-[60]) und die Betriebssystem-Meldungen, die gar nicht
  erst im Dokument stehen. Der Riegel dazu steht in
  `$lib/remote/sichtschutz.ts`: `inert` auf allem ausser diesem Schirm, und ein
  Merker, den die Melde-Wege abfragen, bevor sie etwas zeigen oder hinausgeben.
-->
<script lang="ts">
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { restlicheAppSperren, sichtschutzMelden } from '$lib/remote/sichtschutz';
  import { m } from '$lib/paraglide/messages.js';

  // Nur auf einem eingetragenen Gerät, und nur während einer Übernahme. Beides
  // ist nötig: ein gewöhnlicher Rechner, der zehn Minuten hergegeben wird,
  // bleibt die bewusste Entscheidung seines Besitzers — dort wäre ein
  // Sichtschutz Bevormundung.
  //
  // **Irgendeine Eintragung, nicht die des gerade offenen Servers** (Bughunt
  // 2026-08-16): der Schirm hing an `activeServer`, und ein Server-Wechsel
  // mitten in der Sitzung nahm ihn weg — auslösbar vom Steuernden selbst, denn
  // die Tastenkürzel kennen die laufende Sitzung nicht. Was der Riegel
  // verdeckt, entscheidet die SITZUNG; die Eintragung sagt nur, dass dieser
  // Rechner überhaupt ein Standplatz ist.
  let geraet = $derived(geraeteAnmeldung.eintragungen.length > 0);
  let show = $derived(geraet && remoteSession.phase === 'active' && remoteSession.role === 'host');

  let wurzel = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!show || !wurzel) return;
    sichtschutzMelden(true);
    // Den Fokus herüberholen, bevor der Rest stillgelegt wird: lag er in einem
    // Eingabefeld, säße der Steuernde sonst mit blinkendem Cursor in einem
    // Feld, dessen Inhalt er nicht sieht — aber weiterschreiben könnte.
    wurzel.focus();
    const auf = restlicheAppSperren(wurzel);
    // Der Toaster wird zusätzlich ausgeblendet, nicht nur stillgelegt: `inert`
    // nimmt die Bedienbarkeit, nicht die Lesbarkeit, und es gibt Toasts aus
    // Ecken der App, die den Merker nicht abfragen (Moderations- und
    // Gildenmeldungen). Ein Riegel, der nur die bekannten Absender kennt, ist
    // hier der falsche.
    document.documentElement.dataset.sichtschutz = '';
    return () => {
      sichtschutzMelden(false);
      delete document.documentElement.dataset.sichtschutz;
      auf();
    };
  });
</script>

{#if show}
  <!-- Unter dem Fernsteuer-Banner (z-60), über allem anderen. Der Host soll
       jederzeit sehen und beenden können, was gerade läuft — der Sichtschutz
       darf die Notbremse nicht verdecken. -->
  <div
    bind:this={wurzel}
    tabindex="-1"
    class="bg-bg-base/95 fixed inset-0 z-[50] flex flex-col items-center justify-center gap-4
      p-8 text-center backdrop-blur-xl outline-none"
    role="status"
    data-testid="device-sichtschutz"
  >
    <span class="text-text-muted grid size-14 place-items-center rounded-xl border border-current/30">
      <EyeOffIcon class="size-7" />
    </span>
    <h2 class="text-text-bright text-lg font-semibold">{m.device_sichtschutz_title()}</h2>
    <p class="text-text-muted max-w-md text-sm">{m.device_sichtschutz_body()}</p>
  </div>
{/if}

<style>
  /* svelte-sonner rendert mit `z-index: 999999999` — kein Sichtschutz der Welt
     liegt darüber. Weggeblendet statt überdeckt, solange der Schirm steht. */
  :global(html[data-sichtschutz] [data-sonner-toaster]) {
    display: none !important;
  }
</style>
