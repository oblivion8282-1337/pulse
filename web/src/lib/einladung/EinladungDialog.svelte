<!--
  Einladung INNERHALB der App, über der aktuellen Ansicht. Zwei Quellen:
  - die Adresse (`?einladung=<code>[&einladung_host=<fqdn>]`) — so öffnen
    Chat-Links (linkKlick.ts) und der Deep-Link (deepLink.ts) den Dialog;
  - die gemerkte Einladung (gemerkt.ts) — der Rückweg von /invite über
    Anmelden, Registrieren und E-Mail-Bestätigung. Erst gelesen, wenn der
    Nutzer angemeldet UND bestätigt ist; vorher sperrt der Server ohnehin.
  Schließen verwirft die gemerkte Einladung; das ist die Entscheidung „nein“.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import EinladungKarte, {
    type EinladungCommunity,
    type EinladungZustand
  } from './EinladungKarte.svelte';
  import { einladungAusParametern, ohneEinladung, type Einladung } from './einladungsLink';
  import {
    EREIGNIS_GEMERKT,
    browserSpeicher,
    gemerkteEinladung,
    gemerkteEinladungVerwerfen
  } from './gemerkt';
  import { einladungAnnehmen, fehlerMeldung, ladeEinladung } from './laden';
  import { m } from '$lib/paraglide/messages.js';

  const ausUrl = $derived(einladungAusParametern(page.url.searchParams, CLOUD_HOSTNAME));
  let ausSpeicher = $state<Einladung | null>(null);

  function ausSpeicherLesen() {
    if (!auth.user || auth.user.email_verification_pending) return;
    const g = gemerkteEinladung(browserSpeicher(), Date.now());
    // Nur bei echter Änderung zuweisen: jede neue Objekt-Identität lüde neu.
    if (g?.code !== ausSpeicher?.code || g?.host !== ausSpeicher?.host) ausSpeicher = g;
  }

  $effect(ausSpeicherLesen);

  // Deep-Link auf genau /app (deepLink.ts): dort wird gemerkt, nicht über die
  // Adresse geöffnet — dieses Ereignis sagt dem Dialog, dass er nachsehen soll.
  $effect(() => {
    window.addEventListener(EREIGNIS_GEMERKT, ausSpeicherLesen);
    return () => window.removeEventListener(EREIGNIS_GEMERKT, ausSpeicherLesen);
  });

  const offen = $derived(ausUrl !== null || ausSpeicher !== null);
  const aktiv = $derived<Einladung | null>(ausUrl === 'kaputt' ? null : (ausUrl ?? ausSpeicher));

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  let lauf = 0;

  async function laden(e: Einladung | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    hinweis = null;
    if (!e) {
      zustand = 'ungueltig';
      return;
    }
    const r = await ladeEinladung(e);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, e.host) : null;
  }

  // Stabiler Schlüssel statt Objekt: `aktiv` ist bei jeder URL-Änderung und
  // jeder Neuzuweisung von auth.user ein neues Objekt, die Einladung dieselbe.
  const schluessel = $derived(
    aktiv ? `${aktiv.code}|${aktiv.host ?? ''}` : ausUrl === 'kaputt' ? 'kaputt' : null
  );

  $effect(() => {
    if (!offen || schluessel === null) return;
    untrack(() => void laden(aktiv));
  });

  function erledigt() {
    gemerkteEinladungVerwerfen(browserSpeicher());
    ausSpeicher = null;
  }

  function schliessen() {
    erledigt();
    if (ausUrl !== null) {
      void goto(ohneEinladung(page.url.pathname + page.url.search), {
        replaceState: true,
        noScroll: true,
        keepFocus: true
      });
    }
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !aktiv) return;
    busy = true;
    hinweis = null;
    const ziel = aktiv;
    const r = await einladungAnnehmen(ziel, bestaetigt);
    busy = false;
    if (r.art === 'ok') erledigt();
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, ziel.host);
  }

  function oeffnen() {
    if (!guildId) return;
    erledigt();
    void goto(`/app/guilds/${guildId}/channels/_`);
  }
</script>

<Dialog.Root open={offen} onOpenChange={(v) => { if (!v) schliessen(); }}>
  <Dialog.Content class="nicht-handy:max-w-sm" data-testid="einladung-dialog">
    <Dialog.Title class="sr-only">{m.einladung_dialog_titel()}</Dialog.Title>
    <div class="pt-2">
      <EinladungKarte
        {zustand}
        {community}
        host={aktiv?.host ?? null}
        {hinweis}
        {busy}
        rahmen="dialog"
        onBeitreten={() => beitreten()}
        onOeffnen={oeffnen}
        onErneut={() => laden(aktiv)}
        onZuPulse={schliessen}
        onEmail={() => goto('/verify-email-required')}
      />
    </div>
  </Dialog.Content>
</Dialog.Root>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={aktiv?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
